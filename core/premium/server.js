/**
 * forge-premium – Nostr-Identität (Message Center + künftige FORGE-public-Premium-Auslieferung)
 *
 * Hält die Master-Nostr-Identität "FORGE.Master" und die Relay-Subscription für
 * eingehende DMs — vorher in bots/settings/server.js (startNostrService()).
 * Umgezogen 2026-07-27 (FORGE public Master-Architektur, Weiche 1): die Auslieferung
 * bezahlter Premium-Keys darf nicht am Neustart der Admin-UI (forge-settings) hängen,
 * und eine Nostr-Identität kann nur einem Prozess gehören (sonst doppelter DM-Empfang).
 *
 * localhost-only (127.0.0.1), kein Inbound von außen – forge-settings/routes/messages.js
 * proxied hierhin.
 *
 * Routen (alle unterhalb dieses Servers, forge-settings mountet sie unter /api/messages):
 *   GET  /identity              → npub/pubkey/Alias der eigenen Identität
 *   GET  /identity/qr           → QR-Code (SVG) der eigenen npub
 *   POST /identity/alias        → Anzeigenamen ändern (kind 0 neu publizieren)
 *   POST /identity/regenerate   → 🔴 Account NEU anlegen (löscht Key + alle Nachrichten)
 *   GET  /contacts              → mitgeliefertes Adressbuch (fester Kontakt "FORGE Master")
 *   GET  /support/threads       → Inbox: eine Zeile pro Gegenstelle
 *   GET  /support/unread-count  → { unread: N }
 *   GET  /support/thread/:peer  → Alle Nachrichten mit einer Gegenstelle (markiert gelesen)
 *   POST /support/send          → Text-Nachricht per Nostr-DM versenden
 *   GET  /premium                → Flache Liste aller Premium-Protokoll-Nachrichten,
 *                                   humanisiert (summary/detail statt Roh-JSON)
 *   GET  /premium/unread-count   → { unread: N }
 *   POST /premium/:id/read       → markiert eine einzelne Premium-Nachricht gelesen
 *   GET  /support/stream        → Server-Sent Events: Live-Push neuer Nachrichten
 *                                  (Events: support-message, premium-message)
 *
 * 'category' (support/premium) trennt seit 2026-07-28 strukturierte Premium-Kommandos
 * (JSON mit cmd-Feld: premium-activate/-token/-blob) vom normalen Support-Chat-Freitext
 * — beide liegen weiterhin in derselben Tabelle, siehe classifyPremiumCommand().
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import express from 'express';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import { EventEmitter } from 'events';
import { nip19 } from 'nostr-tools';
import { PATHS, envFile } from '../../config/paths.js';
import { t, getLang } from '../../lib/i18n.js';
import { issueActivationToken, getLastIssuedAt } from './activation.js';
import { loadPricingConfig, signPricing } from '../../lib/premium-pricing.js';
import { loadMinVersionConfig, signMinVersion, isValidVersion, isVersionSupported } from '../../lib/premium-min-version.js';
import { startConnectionMonitor, getConnectionStats } from '../../lib/nostr-stats.js';
import { openMessagesDb, markEventsDeleted, isEventDeleted, markBlobEventProcessed, markActivationEventProcessed, pruneMessagesToLimit } from './messages-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: envFile('premium') });
import {
    loadIdentity, identityExists, loadRelays, loadContacts, fetchProfileNames, createPool,
    createIdentity, setIdentityAlias,
    sendDirectMessage, subscribeDirectMessages, publishDmRelayList, publishProfile,
} from '../../lib/nostr-client.js';

const PORT = parseInt(process.env.PORT || '3110');

// Name der eigenen Identität (Dateiname im secrets-Verzeichnis).
//   Master:          FORGE.Master        (Default – die zentrale Support-Identität)
//   FORGE-public-Fork:  forge-pub-nostr     (per NOSTR_IDENTITY in der .env gesetzt)
// Der Fork kann FORGE.Master gar nicht besitzen: dessen Private Key liegt nur auf dem
// Master und wird nie exportiert. Ohne diese Konfigurierbarkeit suchte jede Fork-
// Installation nach einer Datei, die dort niemals existieren kann → "Nostr-Service nicht
// bereit" (so 2026-07-27 auf der Staging-Instanz beobachtet).
const IDENTITY_NAME = process.env.NOSTR_IDENTITY?.trim() || 'FORGE.Master';

// Ob dieser Prozess die zentrale Master-Identität hält (statt eines FORGE-public-Forks).
const IS_MASTER_IDENTITY = IDENTITY_NAME === 'FORGE.Master';

// ── Blob-Ingest-Concurrency-Guard ────────────────────────────────────────────
// Vorfall 2026-08-03 (forge-pub1): ein Backlog-Replay von 310 DMs hat ebenso viele
// parallele premium-fetch.js-Kindprozesse gespawnt → OOM-Kill → Neustart → derselbe
// Backlog erneut → Crash-Loop (siehe Kommentar bei subscribeDirectMessages unten).
// Der Event-Dedup + 1h-Alters-Filter dort verhindert Wiederholung, deckelt aber
// nicht die Anzahl GLEICHZEITIGER frischer DMs in einem einzelnen Burst. Diese
// Guard erzwingt zusätzlich: nie mehr als ein laufender Ingest-Kindprozess. Trifft
// während eines laufenden Ingests eine weitere DM ein, wird nur die NEUESTE
// gemerkt (ältere sind durch den sequence-Gate in premium-ingest.js ohnehin
// wertlos) und nach einer kurzen Pause nachgeholt, statt sofort parallel zu starten.
let ingestChildRunning = false;
let pendingIngestPayload = null; // { url, backupUrl?, key, hourId } – nur die neueste
const INGEST_RETRY_PAUSE_MS = 5_000;

// Default-Anzeigename, wenn der Nutzer bei der Installation keinen Alias vergibt.
const DEFAULT_ALIAS = 'FORGE Public User';

// Obergrenze für den Anzeigenamen (kind-0-"name") – deckungsgleich mit dem
// maxlength des Frontend-Inputs (message.html), hier zusätzlich serverseitig
// erzwungen, da /identity/alias und /identity/regenerate auch direkt (ohne UI)
// aufgerufen werden können.
const MAX_ALIAS_LENGTH = 60;

/**
 * Bereinigt einen vom Nutzer eingegebenen Alias: Steuerzeichen/Zeilenumbrüche raus,
 * auf MAX_ALIAS_LENGTH gekürzt. Nostr selbst schreibt für kind-0 "name" kein Format
 * vor (beliebiger UTF-8-String) – die Grenze ist eine bewusste FORGE-Vorgabe, damit
 * die 60-Zeichen-Anzeige im Frontend nicht nur kosmetisch ist.
 */
function sanitizeAlias(raw) {
    return raw
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim()
        .slice(0, MAX_ALIAS_LENGTH);
}

const messageEvents = new EventEmitter();

// ── DB ──────────────────────────────────────────────────────────────────────
// openMessagesDb() liegt in messages-db.js (gemeinsam mit premium-pay.js, das
// dort recordPremiumMessage() nutzt, um Zahlungen OHNE Nostr-Versand im
// Premium-Tab sichtbar zu machen). category/thread_id-Migrationen laufen dort
// weiterhin idempotent mit, der einmalige Content-Backfill beim ursprünglichen
// Einführen der 'category'-Spalte (2026-07-28) ist auf allen laufenden
// Instanzen längst erledigt und deshalb hier nicht mehr nötig.

// ── Support-Thread-Markierung ────────────────────────────────────────────────
// Nostr-DMs kennen von Haus aus kein "mehrere getrennte Unterhaltungen mit
// derselben Gegenstelle" – dafür wird dem Nachrichtentext eine unsichtbare
// Markierung vorangestellt (U+2063 INVISIBLE SEPARATOR, kein Klartext-Tag, damit
// es auch in einem fremden Nostr-Client wie Amethyst nicht als Zeichenkette
// auffällt). Fork UND Master laufen auf derselben Codebasis, daher können beide
// Seiten dieselbe Markierung schreiben/lesen – eine Antwort vom Master landet so
// automatisch im richtigen (Anliegen-)Thread des Nutzers.
const THREAD_TAG_RE = /^⁣T:([A-Za-z0-9]{6,20})⁣/;

function generateThreadId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Zerlegt eingehenden Text in { threadId, cleanText } – threadId ist null, wenn keine Markierung gefunden wurde. */
function extractThreadTag(text) {
    const raw = text ?? '';
    const m = THREAD_TAG_RE.exec(raw);
    if (!m) return { threadId: null, cleanText: raw };
    return { threadId: m[1], cleanText: raw.slice(m[0].length) };
}

/** Hängt die Markierung vor den zu sendenden Text – no-op ohne threadId. */
function embedThreadTag(threadId, text) {
    return threadId ? `⁣T:${threadId}⁣${text}` : text;
}

/**
 * Erkennt, ob ein DM-Text ein strukturiertes Premium-Kommando ist (JSON mit bekanntem
 * `cmd`-Feld) statt normalem Support-Chat-Freitext. Zentral hier statt an jeder
 * Insert-Stelle dupliziert, da sowohl die Migration oben als auch alle drei
 * Schreibpfade (eingehende DM, Aktivierungs-Antwort, künftige Kommandos) dieselbe
 * Erkennung brauchen.
 * @returns {object|null} das geparste Kommando, oder null wenn es normaler Chat-Text ist.
 */
function classifyPremiumCommand(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    const KNOWN_COMMANDS = new Set([
        'premium-activate', 'premium-token', 'premium-blob', 'premium-blob-sealed', 'premium-payment',
        // Zustandswechsel-Nachrichten (2026-08-03) – lösen die bisherige "eine Nachricht
        // pro 10-Min-Zustellung"-Spam-Quelle ab, siehe Kommentar bei premium-blob-sealed
        // weiter unten (subscribeDirectMessages) und core/premium/blob-health-check.js.
        'premium-autopay-enabled', 'premium-autopay-disabled', 'premium-pay-failed', 'premium-outage',
        // Versions-Gate (2026-08-06): Fork meldet bei jedem premium-pay.js-Lauf seine
        // Softwareversion, Master antwortet nur, wenn sie unter der Mindestversion liegt.
        'premium-version-check', 'premium-version-too-old',
    ]);
    if (parsed && typeof parsed === 'object' && KNOWN_COMMANDS.has(parsed.cmd)) return parsed;
    return null;
}

/**
 * `hourId` (Math.floor(unix_ms / 3.600.000), siehe lib/premium-memo.js) ist die
 * Abrechnungseinheit von FORGE public Premium, aber als reine Zahl für Menschen
 * bedeutungslos ("Stunde 495973"). Übersetzt sie in die tatsächliche Uhrzeit-Spanne
 * (Europe/Berlin, wie der Rest von FORGE — siehe config/config.js FORGE_TZ).
 * Stundengrenzen sind in UTC exakt, CEST/CET-Offset ist ganzzahlig → keine
 * Rundungsprobleme bei der Anzeige.
 */
function formatHourRange(hourId) {
    const startMs = hourId * 3_600_000;
    const endMs = startMs + 3_600_000;
    const locale = numLocale();
    const fmt = ms => new Date(ms).toLocaleTimeString(locale, {
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
    });
    // "Uhr" hängt an der Sprache, nicht am Zeitformat (englisch: kein Suffix).
    return t('msg.premium.hour_range', { from: fmt(startMs), to: fmt(endMs) });
}

/** Locale für Zahlen/Uhrzeiten — folgt der Sprache, wie im Frontend (E10). */
function numLocale() {
    return getLang() === 'en' ? 'en-US' : 'de-DE';
}

/** Zahlnotation für USDC-Beträge in der aktiven Sprache (deutsch: Komma). */
function formatUsdcDe(amount) {
    return Number(amount).toLocaleString(numLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Wandelt ein Premium-Kommando in für Menschen lesbaren Text (Kurzform + Detail) statt
 * der rohen JSON-Nutzlast — siehe Message-Center-Redesign 2026-07-28 ("weniger json-Code,
 * eher: Update Liste der Pools"). `direction` unterscheidet, weil derselbe `cmd`-Wert auf
 * Master- und Fork-Seite unterschiedlich bedeutet (z.B. 'premium-token' out = "verschickt",
 * in = "erhalten").
 */
function humanizePremiumMessage(direction, cmd) {
    // Kurzform: `sd(key)` liefert { summary, detail } aus zwei Katalog-Keys, die sich
    // nur im Suffix unterscheiden. Gerendert wird bei JEDEM Abruf — anders als bei den
    // Bot-Meldungen (Schritt 5) muss hier nichts gespeichert werden, weil die rohe
    // Kommando-Nutzlast in der DB liegt und die Übersetzung erst beim Lesen entsteht.
    const sd = (key, params = null) => ({
        summary: t(`msg.premium.${key}.summary`, params),
        detail:  t(`msg.premium.${key}.detail`,  params),
    });

    switch (cmd.cmd) {
        case 'premium-activate':
            return sd(direction === 'in' ? 'activate_in' : 'activate_out');
        case 'premium-token':
            return sd(direction === 'in' ? 'token_in' : 'token_out');
        case 'premium-blob': {
            // Klammerzusatz nur wenn die Stunde bekannt ist — sonst bliebe "()" stehen.
            const range = cmd.hourId ? ` (${formatHourRange(cmd.hourId)})` : '';
            return sd('blob', { range });
        }
        case 'premium-blob-sealed':
            // hourId steckt im verschlüsselten Anteil (an die zahlende Wallet gebunden,
            // siehe lib/premium-payer-binding.js) — für die Anzeige hier nicht entschlüsselt,
            // das würde den Zahler-Key außerhalb des eigentlichen Ingest-Pfads laden.
            return direction === 'in' ? sd('blob', { range: '' }) : sd('blob_sealed_out');
        case 'premium-payment': {
            // Reines lokales Ereignis (siehe premium-pay.js/recordPremiumMessage) — kein
            // "erhalten"/"gesendet"-Unterschied nötig, es gibt keine Gegenstelle.
            const range  = formatHourRange(cmd.hourId);
            const amount = formatUsdcDe(cmd.amountUsdc);
            return {
                ...sd('payment', { amount, range }),
                // Strukturierte Felder zusätzlich zu summary/detail, damit das Frontend
                // Empfänger/TX selbst formatieren kann (TX als Explorer-Link gekürzt, die
                // Empfangsadresse bewusst ungekürzt) statt die volle 88-stellige Signatur im
                // Fließtext auszuschreiben.
                payment: { amountUsdc: amount, hourRange: range, toWallet: cmd.toWallet, signature: cmd.signature },
            };
        }
        case 'premium-autopay-enabled':
            return sd('autopay_on');
        case 'premium-autopay-disabled':
            return sd(cmd.reason === 'liquiditybot-stopped' ? 'autopay_off_bot' : 'autopay_off');
        case 'premium-pay-failed':
            return cmd.reason === 'insufficient-balance'
                ? sd('pay_failed_balance', {
                    needed: formatUsdcDe(cmd.priceUsdc ?? 0),
                    have:   formatUsdcDe(cmd.usdcBalance ?? 0),
                  })
                : sd('pay_failed', { detail: cmd.detail ?? t('msg.premium.unknown_error') });
        case 'premium-outage':
            return sd(cmd.state === 'recovered' ? 'outage_over' : 'outage');
        case 'premium-version-check':
            return direction === 'in'
                ? sd('version_in', { version: cmd.version ?? '?' })
                : sd('version_out');
        case 'premium-version-too-old': {
            // Seit Fund 2026-08-11 signierter Umschlag statt Klartext-Feld – die
            // Mindestversion steckt in minVersion.params.minRequiredVersion (siehe
            // handleVersionCheck/handleVersionTooOld), alte Nachrichten aus der DB
            // (vor dem Umbau) hatten sie noch als cmd.minRequiredVersion.
            const minReq = cmd.minVersion?.params?.minRequiredVersion ?? cmd.minRequiredVersion ?? '?';
            return direction === 'in'
                ? sd('version_old_in', { yourVersion: cmd.yourVersion ?? '?', minVersion: minReq })
                : sd('version_old_out', { minVersion: minReq });
        }
        default:
            return {
                summary: t('msg.premium.unknown_cmd', { cmd: cmd.cmd ?? '?' }),
                detail:  JSON.stringify(cmd),
            };
    }
}

/**
 * Einmalige Übernahme bestehender Nachrichten aus settings.db (dort lag die Tabelle
 * bis zum Umzug 2026-07-27). Idempotent: INSERT OR IGNORE über event_id/Inhalt,
 * läuft bei jedem Start, ist aber nach der ersten erfolgreichen Übernahme ein No-Op
 * (settings.db-Tabelle bleibt dort unangetastet stehen, wird nicht gelöscht).
 */
function migrateFromSettingsDbIfPresent() {
    let src;
    try {
        src = new Database(PATHS.settingsDb, { readonly: true, fileMustExist: true });
        const hasTable = src.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='nostr_support_messages'`
        ).get();
        if (!hasTable) return;
        const rows = src.prepare(`SELECT direction, timestamp, text, peer_pubkey, read, event_id FROM nostr_support_messages`).all();
        if (rows.length === 0) return;

        const dst = openMessagesDb();
        try {
            const insert = dst.prepare(`
                INSERT OR IGNORE INTO nostr_support_messages (direction, timestamp, text, peer_pubkey, read, event_id)
                VALUES (@direction, @timestamp, @text, @peer_pubkey, @read, @event_id)
            `);
            const txn = dst.transaction((items) => { for (const r of items) insert.run(r); });
            txn(rows);
            pruneMessagesToLimit(dst, 'support');
            console.log(`[premium] Migration aus settings.db: ${rows.length} Nachrichten geprüft/übernommen.`);
        } finally {
            dst.close();
        }
    } catch (err) {
        // settings.db existiert nicht/noch keine Tabelle – kein Fehler, nur nichts zu tun.
        console.log(`[premium] Keine Altdaten aus settings.db übernommen (${err.message}).`);
    } finally {
        src?.close();
    }
}

migrateFromSettingsDbIfPresent();

// ── Profil-Namen-Cache (kind 0-Lookups) ──────────────────────────────────────

const profilePool = createPool();
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;
const profileCache = new Map(); // pubkeyHex → { name, fetchedAt }

async function resolveProfileNames(pubkeyHexList) {
    const now = Date.now();
    const stale = [...new Set(pubkeyHexList)].filter(pk => {
        const cached = profileCache.get(pk);
        return !cached || (now - cached.fetchedAt) > PROFILE_CACHE_TTL_MS;
    });
    if (stale.length) {
        let fetched = {};
        try {
            fetched = await fetchProfileNames(profilePool, loadRelays(), stale);
        } catch {
            // Relays nicht erreichbar – Anzeige fällt einfach auf den Pubkey zurück.
        }
        for (const pk of stale) profileCache.set(pk, { name: fetched[pk] ?? null, fetchedAt: now });
    }
    const result = {};
    for (const pk of pubkeyHexList) result[pk] = profileCache.get(pk)?.name ?? null;
    return result;
}

/** Akzeptiert npub1… oder 64-stelligen hex-Pubkey, gibt immer hex zurück (oder null). */
function resolvePubkeyHex(input) {
    const val = (input ?? '').trim();
    if (/^[0-9a-f]{64}$/i.test(val)) return val.toLowerCase();
    if (val.startsWith('npub1')) {
        try {
            const { type, data } = nip19.decode(val);
            if (type === 'npub') return data;
        } catch {
            return null;
        }
    }
    return null;
}

// ── Nostr-Service (Identität, Subscribe, Send) ───────────────────────────────

function startNostrService() {
    if (!identityExists(IDENTITY_NAME)) {
        console.warn(`⚠️  Nostr-Identität "${IDENTITY_NAME}" fehlt – Message-Center-Support-Tab bleibt ohne Live-Empfang.`);
        console.warn('    Anlegen mit: node bin/nostr-setup.js');
        return null;
    }

    const identity = loadIdentity(IDENTITY_NAME);
    const relays = loadRelays();
    const pool = createPool();
    startConnectionMonitor(pool, relays);

    // DM-Relay-Liste (kind 10050) bei jedem Start neu veröffentlichen – ohne dieses
    // Event finden Sender-Apps (Amethyst etc.) keine "DM-Inbox Relays" und können
    // keine private DM zustellen. Replaceable Event, daher unkritisch bei jedem Boot.
    Promise.allSettled(publishDmRelayList(pool, relays, identity))
        .then(results => {
            const okCount = results.filter(r => r.status === 'fulfilled').length;
            console.log(`📡  DM-Relay-Liste (kind 10050) veröffentlicht: ${okCount}/${relays.length} Relays bestätigt`);
        });

    // Profil (kind 0) bei jedem Start neu veröffentlichen, damit andere Clients einen
    // Namen statt eines leeren/npub-Profils anzeigen. Anzeigename kommt aus der Identität
    // selbst (Fork: vom Nutzer bei der Installation vergeben oder DEFAULT_ALIAS);
    // Fallback auf den Identitätsnamen deckt die Master-Identität ab, die kein alias-Feld
    // hat (angelegt vor Einführung des Feldes).
    const displayName = identity.alias || identity.name;
    Promise.allSettled(publishProfile(pool, relays, identity, { name: displayName }))
        .then(results => {
            const okCount = results.filter(r => r.status === 'fulfilled').length;
            console.log(`👤  Profil (kind 0, "${displayName}") veröffentlicht: ${okCount}/${relays.length} Relays bestätigt`);
        });

    subscribeDirectMessages(pool, relays, identity, (rumor) => {
        const rawContent = rumor.content ?? '';
        const cmd = classifyPremiumCommand(rawContent);

        // Routine Blob-Zustellungen (alle 10 Min, solange die laufende Stunde bezahlt
        // ist) NICHT als Nachricht speichern – nur echte Zustandswechsel (Aktivierung,
        // Zahlungs-Fehlschlag, Master-Erreichbarkeit, siehe humanizePremiumMessage()
        // oben) sollen im Premium-Tab auftauchen. Vorher landete hier bei JEDER
        // Zustellung eine identische Zeile ("Update: Premium-Daten aktualisiert") –
        // auf forge-pub1/pub2 bis zu 6x/Stunde beobachtet (2026-08-03).
        //
        // 🔴 Vorfall 2026-08-03 (forge-pub1): der bisherige Dedup gegen Relay-Backlog-
        // Replay lief über INSERT OR IGNORE + event_id auf nostr_support_messages –
        // da diese Zeile hier jetzt übersprungen wird, griff er nicht mehr. Ein
        // Reconnect/Neustart lieferte den KOMPLETTEN Backlog erneut aus, JEDE davon
        // spawnte einen neuen premium-fetch.js-Kindprozess (handleBlobDelivery) ohne
        // Begrenzung → 310 gleichzeitige Prozesse → OOM-Kill → Neustart → derselbe
        // Backlog erneut → Crash-Loop. markBlobEventProcessed() (eigene, schlanke
        // Dedup-Tabelle, siehe messages-db.js) ersetzt den verlorenen Schutz, ohne
        // wieder eine sichtbare Nachricht zu erzeugen.
        if (cmd?.cmd === 'premium-blob-sealed' && !IS_MASTER_IDENTITY) {
            const dedupDb = openMessagesDb();
            let isNew;
            try {
                isNew = markBlobEventProcessed(dedupDb, rumor.id ?? null);
            } finally {
                dedupDb.close();
            }
            if (!isNew) return; // bereits verarbeitet (Backlog-Replay) – nichts zu tun

            // Zusätzliche Bremse zum Dedup oben: die Dedup-Tabelle ist bei JEDEM neuen
            // Fork-Install bzw. direkt nach diesem Fix (2026-08-03) leer – ein einzelner
            // großer Backlog-Replay würde also trotz Dedup noch immer ALLE Alt-Events auf
            // einmal als "neu" verarbeiten und ebenso viele Kindprozesse gleichzeitig
            // starten (derselbe OOM-Mechanismus wie im Vorfall, nur einmalig statt
            // wiederholt). Ein Blob ist ohnehin spätestens 3h nach Upload von der Ablage
            // geräumt (lib/blob-storage.js DEFAULT_MAX_AGE_MS) und würde nur noch 404en –
            // ein Download-Versuch für eine länger als 1h alte DM ist also so gut wie nie
            // erfolgreich und lohnt den Prozess-Start nicht.
            const BLOB_DM_MAX_AGE_S = 60 * 60; // 1h
            const ageS = Math.floor(Date.now() / 1000) - (rumor.created_at ?? 0);
            if (ageS > BLOB_DM_MAX_AGE_S) {
                console.warn(`[premium] Blob-Zustellungs-DM ist ${Math.round(ageS / 60)} Min alt (Backlog-Replay) – übersprungen, kein Ingest-Versuch.`);
                return;
            }

            handleBlobDelivery(rumor).catch(err => {
                console.error(`[premium] Blob-Zustellung fehlgeschlagen: ${err.message}`);
            });
            handlePricingDelivery(rumor).catch(err => {
                console.error(`[premium] Preislisten-Verarbeitung fehlgeschlagen: ${err.message}`);
            });
            return;
        }

        const db = openMessagesDb();
        try {
            const timestamp = (rumor.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
            const category = cmd ? 'premium' : 'support';

            // FORGE-public-Fork-Seite: Der Support-Posteingang ist ausschließlich für den
            // Dialog mit dem FORGE Master gedacht (Menüpunkt heißt "Support") – fremde
            // Absender werden gar nicht erst gespeichert, sonst könnte das Postfach mit
            // Spam vollaufen. Der Master selbst empfängt hier bewusst von JEDER
            // Gegenstelle (das IST sein Support-Posteingang), Filter gilt daher nur
            // auf der Fork-Seite.
            if (category === 'support' && !IS_MASTER_IDENTITY) {
                const masterContact = loadContacts().find(c => c.id === 'forge-master');
                if (!masterContact || rumor.pubkey !== masterContact.pubkeyHex) {
                    console.warn(`[premium] Support-DM von unbekanntem Absender verworfen (${rumor.pubkey}).`);
                    return;
                }
            }

            // Vom Nutzer bereits gelöschte Anliegen dürfen der Relay-Backlog-Replay
            // (Reconnect-Gap-Fill oder Server-Neustart) nicht wieder auferstehen lassen –
            // siehe nostr_deleted_events in messages-db.js.
            if (isEventDeleted(db, rumor.id ?? null)) return;

            const { threadId, cleanText } = category === 'support'
                ? extractThreadTag(rawContent)
                : { threadId: null, cleanText: rawContent };

            // INSERT OR IGNORE + event_id: subscribeMany liefert bei jedem Server-Start
            // das Relay-Backlog erneut aus – ohne Dedup würden dieselben Nachrichten bei
            // jedem Neustart erneut gespeichert werden.
            const info = db.prepare(`
                INSERT OR IGNORE INTO nostr_support_messages (direction, timestamp, text, peer_pubkey, event_id, category, thread_id)
                VALUES ('in', ?, ?, ?, ?, ?, ?)
            `).run(timestamp, cleanText, rumor.pubkey ?? null, rumor.id ?? null, category, threadId);

            if (info.changes === 1) {
                pruneMessagesToLimit(db, category);
                messageEvents.emit(category === 'premium' ? 'premium-message' : 'support-message', {
                    direction: 'in',
                    timestamp,
                    text: cleanText,
                    peerPubkey: rumor.pubkey ?? null,
                });

                // Aktivierungs-Token-Austausch (nur Master, siehe activation.js + [[payment]]
                // "Identitäts-/Memo-Modell"). `info.changes === 1` ist Pflicht hier: ohne diese
                // Bedingung würde jeder Neustart das komplette Relay-Backlog erneut auswerten
                // und bei jeder alten "premium-activate"-DM einen weiteren Token ausstellen.
                if (IS_MASTER_IDENTITY) {
                    handlePremiumCommand(rumor).catch(err => {
                        console.error(`[premium] Aktivierungs-Befehl fehlgeschlagen (${rumor.pubkey}): ${err.message}`);
                    });
                    handleVersionCheck(rumor).catch(err => {
                        console.error(`[premium] Versions-Meldung fehlgeschlagen (${rumor.pubkey}): ${err.message}`);
                    });
                } else {
                    // FORGE-public-Fork-Seite: premium-blob-sealed wird bereits weiter oben
                    // (vor dem DB-Insert) an handleBlobDelivery() durchgereicht – hier nur
                    // noch die signierte Preisliste, mitgeschickt in der premium-token-
                    // Antwort (Bootstrap vor der ersten Zahlung, s. handlePricingDelivery),
                    // und ein evtl. "Version zu alt"-Hinweis vom Master.
                    handlePricingDelivery(rumor).catch(err => {
                        console.error(`[premium] Preislisten-Verarbeitung fehlgeschlagen: ${err.message}`);
                    });
                    handleVersionTooOld(rumor).catch(err => {
                        console.error(`[premium] Versions-Hinweis-Verarbeitung fehlgeschlagen: ${err.message}`);
                    });
                }
            }
        } finally {
            db.close();
        }
    });

    /**
     * Erkennt/beantwortet strukturierte Premium-Kommandos innerhalb eingehender DMs.
     * Wire-Format bewusst simpel gehalten (JSON-String im DM-Text) — kein neues Protokoll,
     * dieselbe Gift-Wrap-DM-Infrastruktur wie der normale Support-Chat.
     * Aktuell nur "premium-activate" (Punkt 2 der Premium-Anbindung); der Zahlungs-Watcher
     * (Punkt 3, noch ungebaut) liest lookupActivationToken() beim Memo-Abgleich.
     */
    async function handlePremiumCommand(rumor) {
        let cmd;
        try {
            cmd = JSON.parse(rumor.content ?? '');
        } catch {
            return; // normaler Support-Chat-Text, kein Kommando – kein Fehler
        }
        if (cmd?.cmd !== 'premium-activate' || typeof rumor.pubkey !== 'string') return;

        // Backlog-Replay-Schutz (Fund 2026-08-08, analog zum premium-blob-sealed-Dedup vom
        // 2026-08-03 weiter oben): rumor.id ist die deterministische ID des inneren,
        // unsignierten Rumors (stabil über jeden Replay derselben DM) – anders als das
        // `created_at` des äußeren Gift-Wraps, das NIP-17 absichtlich randomisiert und
        // daher als `since`-Cursor ungeeignet ist (siehe lib/nostr-client.js). Eigene,
        // nie geprunte Tabelle statt des event_id-UNIQUE-Index auf nostr_support_messages,
        // weil genau der durch das Rubriken-Cap-Pruning wirkungslos wurde.
        const dedupDb = openMessagesDb();
        let isNew;
        try {
            isNew = markActivationEventProcessed(dedupDb, rumor.id ?? null);
        } finally {
            dedupDb.close();
        }
        if (!isNew) return; // bereits verarbeitet (Backlog-Replay) – kein erneuter Reissue

        // Rate-Limit pro Kunden-Pubkey (Fund 2026-08-08): jede Ausstellung widerruft sofort
        // den vorherigen Token (siehe activation.js) – ohne Bremse kann eine schnelle Folge
        // echter Anfragen (hektisch klickender Client, oder absichtlicher Spam von einer
        // beliebigen Nostr-Identität, Aktivierung ist unauthentifiziert) eine laufende
        // Zahlung mitten im Abgleich ins Leere laufen lassen und erzeugt sinnlosen DB-/
        // Relay-Traffic. Aktivierung selbst ist bewusst kostenlos/offen (jeder soll Kunde
        // werden können) – die eigentliche Sicherheitsgrenze ist der on-chain-Zahlungsabgleich
        // in payment-watcher.js, dieses Limit ist reine Anti-Chatter-Bremse, keine Zugangskontrolle.
        const ACTIVATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 Min
        const lastIssuedAt = getLastIssuedAt(rumor.pubkey);
        if (lastIssuedAt != null && Date.now() - lastIssuedAt < ACTIVATION_COOLDOWN_MS) {
            const waitS = Math.round((ACTIVATION_COOLDOWN_MS - (Date.now() - lastIssuedAt)) / 1000);
            console.warn(`[premium] Aktivierungsanfrage von ${rumor.pubkey.slice(0, 12)}… ignoriert (Rate-Limit, letzte Ausstellung vor ${Math.round((Date.now() - lastIssuedAt) / 1000)}s, noch ${waitS}s Cooldown).`);
            return;
        }

        // Jede Aktivierungsanfrage stellt einen frischen Token aus und widerruft einen
        // evtl. vorhandenen alten – deckt sowohl Erstaktivierung als auch "neuen Token
        // anfordern" (z.B. nach Neuinstallation) mit derselben Logik ab, siehe [[payment]].
        const token = issueActivationToken(rumor.pubkey);

        // Signierte Preisliste direkt in dieselbe Antwort — löst das Henne-Ei-Problem:
        // der Fork muss Preis + Empfangsadresse kennen, BEVOR er je bezahlt hat, kann sie
        // also nicht erst über den (zahlungsgebundenen) Premium-Blob bekommen. Signiert
        // mit demselben Nostr-Key wie die DM selbst (secp256k1/Schnorr, siehe
        // lib/premium-pricing.js) – kein zusätzlicher Vertrauensanker. Best-effort: eine
        // fehlerhafte premium-pricing.json darf die Token-Ausstellung nicht verhindern,
        // der Fork bekommt die Preisliste dann beim nächsten Update nachgereicht.
        let pricing = null;
        try {
            const params = loadPricingConfig();
            pricing = signPricing(params, identity.privkeyHex);
        } catch (err) {
            console.warn(`[premium] Preisliste konnte der Aktivierungsantwort nicht beigelegt werden: ${err.message}`);
        }

        const replyText = JSON.stringify({ cmd: 'premium-token', token, pricing });

        await Promise.any(sendDirectMessage(pool, relays, identity, rumor.pubkey, replyText));

        const timestamp = Date.now();
        const db = openMessagesDb();
        try {
            db.prepare(`
                INSERT INTO nostr_support_messages (direction, timestamp, text, peer_pubkey, category)
                VALUES ('out', ?, ?, ?, 'premium')
            `).run(timestamp, replyText, rumor.pubkey);
            pruneMessagesToLimit(db, 'premium');
        } finally {
            db.close();
        }
        messageEvents.emit('premium-message', { direction: 'out', timestamp, text: replyText, peerPubkey: rumor.pubkey });

        console.log(`🔑  Aktivierungs-Token ausgestellt an ${rumor.pubkey.slice(0, 12)}…`);
    }

    /**
     * MASTER-SEITE: verarbeitet {cmd:'premium-version-check', version}, das der Fork bei
     * jedem premium-pay.js-Lauf (stündlich) unaufgefordert schickt. Fork-Version wird
     * ungeprüft übernommen (siehe lib/premium-min-version.js – Schummeln würde dem Nutzer
     * nichts bringen). Antwort NUR, wenn die Version unter der Mindestversion liegt
     * (config/premium-min-version.json) – fire-and-forget bei "ok", spart Round-Trips.
     */
    async function handleVersionCheck(rumor) {
        let cmd;
        try {
            cmd = JSON.parse(rumor.content ?? '');
        } catch {
            return;
        }
        if (cmd?.cmd !== 'premium-version-check' || typeof rumor.pubkey !== 'string') return;

        if (!isValidVersion(cmd.version)) {
            console.warn(`[premium] premium-version-check mit ungültiger Version verworfen (${rumor.pubkey.slice(0, 12)}…): "${cmd.version}"`);
            return;
        }

        let params;
        try {
            params = loadMinVersionConfig();
        } catch (err) {
            console.warn(`[premium] Mindestversions-Konfiguration konnte nicht gelesen werden: ${err.message}`);
            return;
        }
        const { minRequiredVersion } = params;
        if (!isValidVersion(minRequiredVersion) || isVersionSupported(cmd.version, minRequiredVersion)) return;

        // Signiert statt Klartext (Fund 2026-08-11): der Fork verifiziert die Nachricht
        // jetzt über verifyMinVersion() inkl. Downgrade-/Replay-Schutz (lastSeenVersion,
        // siehe handleVersionTooOld unten) – ein vom Relay erneut ausgelieferter Backlog-
        // Eintrag aus einem alten Test kann den Autopay-Kill-Switch damit nicht mehr
        // beliebig oft erneut auslösen.
        const minVersion = signMinVersion(params, identity.privkeyHex);
        const replyText = JSON.stringify({ cmd: 'premium-version-too-old', minVersion, yourVersion: cmd.version });
        await Promise.any(sendDirectMessage(pool, relays, identity, rumor.pubkey, replyText));

        const timestamp = Date.now();
        const db = openMessagesDb();
        try {
            db.prepare(`
                INSERT INTO nostr_support_messages (direction, timestamp, text, peer_pubkey, category)
                VALUES ('out', ?, ?, ?, 'premium')
            `).run(timestamp, replyText, rumor.pubkey);
            pruneMessagesToLimit(db, 'premium');
        } finally {
            db.close();
        }
        messageEvents.emit('premium-message', { direction: 'out', timestamp, text: replyText, peerPubkey: rumor.pubkey });

        console.log(`⏳  Fork meldete veraltete Version (${cmd.version} < ${minRequiredVersion}) – premium-version-too-old gesendet an ${rumor.pubkey.slice(0, 12)}…`);
    }

    /**
     * FORGE-public-Fork-Seite: empfängt {cmd:'premium-blob-sealed', sealed} vom Master
     * (core/premium/deliver-blob.js ist das Master-seitige Gegenstück, seit 2026-07-29
     * an die zahlende Wallet gebunden, siehe lib/premium-payer-binding.js). Entschlüsselt
     * mit dem privaten Key des PREMIUM-Wallets (das ist die zahlende Wallet — derselbe
     * Key, mit dem core/premium/premium-pay.js signiert) und stößt danach den Ingest an.
     *
     * Zwei unabhängige Schutzschichten, beide müssen greifen:
     *   1. Absender-Authentizität: rumor.pubkey MUSS dem fest hinterlegten "FORGE Master"-
     *      Kontakt entsprechen (config/nostr-contacts.json) — Gift-Wrap entschlüsselt zwar
     *      nur, was an uns adressiert ist, verhindert aber nicht, dass irgendein Nostr-
     *      Account uns eine bösartige DM schickt.
     *   2. Entschlüsselung: `openAsPayer()` schlägt fehl, wenn der Envelope nicht für
     *      GENAU dieses Premium-Wallet versiegelt wurde (falscher/fremder Zahler-Key).
     */
    async function handleBlobDelivery(rumor) {
        let cmd;
        try {
            cmd = JSON.parse(rumor.content ?? '');
        } catch {
            return; // normaler Support-Chat-Text, kein Kommando – kein Fehler
        }
        if (cmd?.cmd !== 'premium-blob-sealed' || !cmd.sealed) return;

        const masterContact = loadContacts().find(c => c.id === 'forge-master');
        if (!masterContact || rumor.pubkey !== masterContact.pubkeyHex) {
            console.warn(`[premium] premium-blob-sealed-DM von unbekanntem Absender verworfen (${rumor.pubkey}).`);
            return;
        }

        const { loadPremiumKeypair } = await import('../../lib/premium-wallet.js');
        const keypair = loadPremiumKeypair();
        if (!keypair) {
            console.warn('[premium] Blob-Zustellung erhalten, aber kein Premium-Wallet konfiguriert – kann nicht entschlüsselt werden.');
            return;
        }

        const { openAsPayer } = await import('../../lib/premium-payer-binding.js');
        let payload;
        try {
            payload = openAsPayer(cmd.sealed, keypair.secretKey);
        } catch (err) {
            // Häufigste legitime Ursache: der Master hat für eine ANDERE Zahlung dieser
            // Stunde versiegelt (z.B. ein zweiter Kunde) – kein Alarmzustand, aber auch
            // kein Ingest möglich.
            console.warn(`[premium] Blob-Zustellung konnte nicht entschlüsselt werden: ${err.message}`);
            return;
        }
        if (typeof payload.url !== 'string' || typeof payload.key !== 'string' || !/^[0-9a-f]{64}$/i.test(payload.key)) {
            console.warn('[premium] entschlüsselte Blob-Zustellung hat ungültige url/key-Nutzlast.');
            return;
        }

        queueIngest(payload);
    }

    /**
     * Reiht einen Ingest ein. Läuft bereits ein Kindprozess, wird NICHT parallel
     * gestartet, sondern nur die neueste payload gemerkt (siehe Guard-Kommentar oben)
     * — verhindert, dass ein Backlog-Burst N gleichzeitige Prozesse erzeugt.
     */
    function queueIngest(payload) {
        if (ingestChildRunning) {
            pendingIngestPayload = payload;
            console.log(`🔽  Blob-Zustellung (Stunde ${payload.hourId}) wartet – Ingest bereits aktiv, wird ggf. nachgeholt.`);
            return;
        }
        spawnIngestChild(payload);
    }

    async function spawnIngestChild(payload) {
        ingestChildRunning = true;
        console.log(`🔽  Blob-Zustellung empfangen (Stunde ${payload.hourId}) – starte Ingest…`);
        const { spawn } = await import('child_process');
        const args = ['bin/premium-fetch.js', '--url', payload.url, '--key', payload.key];
        // Primärer Host → Backup-Host (seit 2026-07-31, s. lib/blob-storage.js). Fehlt
        // backupUrl (z.B. Master ohne konfigurierten Backup-Host), bleibt es beim
        // bisherigen Single-URL-Verhalten.
        if (typeof payload.backupUrl === 'string' && payload.backupUrl) {
            args.push('--backup-url', payload.backupUrl);
        }
        const child = spawn(process.execPath, args, {
            cwd: PATHS.liquidity,
            stdio: 'inherit',
        });
        child.on('error', err => {
            console.error(`[premium] Ingest-Kindprozess konnte nicht gestartet werden: ${err.message}`);
            onIngestChildDone();
        });
        child.on('exit', code => {
            console.log(`[premium] Ingest-Kindprozess beendet (exit ${code}).`);
            onIngestChildDone();
        });
    }

    /**
     * Nach jedem Kindprozess-Ende: Falls währenddessen eine neuere DM eintraf, diese
     * erst nach INGEST_RETRY_PAUSE_MS nachholen — die Pause lässt RAM und den
     * blob-fetch-Rate-Limiter (Nexus) sich beruhigen, statt sofort zurückzuschlagen.
     */
    function onIngestChildDone() {
        ingestChildRunning = false;
        if (!pendingIngestPayload) return;
        const next = pendingIngestPayload;
        pendingIngestPayload = null;
        setTimeout(() => spawnIngestChild(next), INGEST_RETRY_PAUSE_MS);
    }

    /**
     * FORK-SEITE: verarbeitet die signierte Preisliste, die der Master der
     * `premium-token`-Antwort beilegt (siehe handlePremiumCommand oben). Löst das
     * Henne-Ei-Problem: Preis + Empfangsadresse müssen bekannt sein, BEVOR je bezahlt
     * wurde — der (zahlungsgebundene) Premium-Blob kommt dafür zu spät.
     *
     * Absender-Prüfung wie bei handleBlobDelivery (rumor.pubkey gegen den fest
     * hinterlegten "FORGE Master"-Kontakt) — zusätzlich zur Signaturprüfung IN der
     * Preisliste selbst (verifyPricing prüft den SIGNIERENDEN Key, nicht den DM-
     * Absender; beide müssen zusammenpassen, sonst könnte ein fremder, aber gültig
     * signierter Envelope über einen kompromittierten Relay untergeschoben werden).
     */
    async function handlePricingDelivery(rumor) {
        let cmd;
        try {
            cmd = JSON.parse(rumor.content ?? '');
        } catch {
            return;
        }
        if (cmd?.cmd !== 'premium-token' || !cmd.pricing) return;

        const masterContact = loadContacts().find(c => c.id === 'forge-master');
        if (!masterContact || rumor.pubkey !== masterContact.pubkeyHex) {
            console.warn(`[premium] Preisliste von unbekanntem Absender verworfen (${rumor.pubkey}).`);
            return;
        }

        const { verifyPricing } = await import('../../lib/premium-pricing.js');
        const { getLastSeenPricingVersion, storePricing } = await import('../../lib/premium-pricing-store.js');

        const lastSeen = getLastSeenPricingVersion();
        const result = verifyPricing(cmd.pricing, masterContact.pubkeyHex, lastSeen);
        if (!result.valid) {
            console.warn(`[premium] Preisliste verworfen: ${result.reason}`);
            return;
        }
        storePricing(result.params);
        console.log(`💰  Preisliste aktualisiert (Version ${result.params.version}, ${result.params.priceUsdcPerHour} USDC/h).`);
    }

    /**
     * FORK-SEITE: empfängt {cmd:'premium-version-too-old', minVersion, yourVersion} vom
     * Master (Gegenstück zu handleVersionCheck oben). Schaltet den Premium-Service über
     * denselben Kill-Switch ab, der auch bei unzureichendem Guthaben greift
     * (setAutoPayEnabled(false), siehe premium-pay.js) – der bereits vorhandene
     * Autopay-Check dort verhindert danach jede weitere automatische Zahlung, bis der
     * Nutzer nach einem Update manuell reaktiviert. Kein eigener DB-Insert nötig: die
     * eingehende DM wurde bereits vom generischen Insert-Pfad oben gespeichert (category
     * 'premium') und erscheint über humanizePremiumMessage() im Message-Center.
     *
     * 🔴 Fund 2026-08-11: bis hierher wurde `minRequiredVersion` ungeprüft im Klartext
     * übernommen, ohne Signatur- oder Replay-Schutz (verifyMinVersion()/der zugehörige
     * Store existierten zwar schon, waren aber nie verdrahtet). Ein einzelner Live-Test
     * des Feature-Rollouts (06.08.2026, testweise minRequiredVersion=9.9.9 gegen
     * forge-pub1 gesendet) blieb dadurch als Nostr-Relay-Backlog-Eintrag liegen und hat
     * den Kill-Switch bei jedem Watchdog-Resubscribe (alle ~15-20 Min, siehe Vorfall
     * 2026-08-01) erneut ausgelöst – Reaktivieren half nur bis zum nächsten Resubscribe.
     * Jetzt wie premium-pricing.js: signierter Umschlag + monotoner `version`-Zähler
     * gegen genau diesen Fall (verifyMinVersion() lehnt unsignierte/alte alte Nachrichten
     * ab, storeMinVersion() merkt sich die zuletzt akzeptierte Version dauerhaft).
     */
    async function handleVersionTooOld(rumor) {
        let cmd;
        try {
            cmd = JSON.parse(rumor.content ?? '');
        } catch {
            return;
        }
        if (cmd?.cmd !== 'premium-version-too-old') return;

        const masterContact = loadContacts().find(c => c.id === 'forge-master');
        if (!masterContact || rumor.pubkey !== masterContact.pubkeyHex) {
            console.warn(`[premium] premium-version-too-old-DM von unbekanntem Absender verworfen (${rumor.pubkey}).`);
            return;
        }

        const { verifyMinVersion } = await import('../../lib/premium-min-version.js');
        const { getLastSeenMinVersion, storeMinVersion } = await import('../../lib/premium-min-version-store.js');

        const lastSeen = getLastSeenMinVersion();
        const result = verifyMinVersion(cmd.minVersion, masterContact.pubkeyHex, lastSeen);
        if (!result.valid) {
            console.warn(`[premium] premium-version-too-old verworfen: ${result.reason}`);
            return;
        }
        storeMinVersion(result.params);

        const { setAutoPayEnabled } = await import('../../lib/premium-auto-pay-store.js');
        setAutoPayEnabled(false);

        console.warn(`[premium] Premium-Service deaktiviert – installierte Version (${cmd.yourVersion}) ist älter als die Mindestversion ${result.params.minRequiredVersion}.`);
    }

    console.log(`✅  Nostr-Service aktiv (${identity.npub}) – Relays: ${relays.join(', ')}`);

    return {
        identity,
        pool,      // für Profil-Republish bei Alias-Änderung (POST /identity/alias)
        relays,
        // threadId: welchem Anliegen diese Nachricht zugeordnet wird (null = alter
        // Sammel-Thread vor der thread_id-Migration). Wird dem gesendeten Nostr-Text
        // unsichtbar vorangestellt (embedThreadTag) – die Gegenstelle (Fork oder
        // Master, beide dieselbe Codebasis) erkennt daran, in welchen Thread ihre
        // eigene Antwort gehört. In der eigenen DB bleibt der Text sauber (ohne Tag).
        async sendSupportMessage(peerPubkeyHex, text, threadId = null) {
            // Strukturierte Premium-Kommandos (z.B. {"cmd":"premium-activate"}) laufen
            // über denselben generischen Sendepfad wie normaler Support-Chat-Freitext
            // (es gibt noch keinen eigenen Endpunkt dafür, siehe onboarding.md „Aktivierungs-
            // dialog bauen … Bau offen"). Ohne diese Erkennung landeten sie mit
            // category='support' (Spalten-Default) in der falschen Rubrik und wurden dort
            // roh als JSON angezeigt statt humanisiert (Fund 2026-07-31).
            const isCommand = classifyPremiumCommand(text) != null;
            // Premium-Kommandos kennen kein Thread-Konzept (siehe GET /premium: flache
            // Liste ohne threadId) und dürfen NIE mit eingebettetem Thread-Tag verschickt
            // werden – der Tag bricht der Gegenstelle das JSON.parse() in
            // classifyPremiumCommand(), sie klassifiziert dann still als 'support' und die
            // Aktivierungsantwort bleibt aus (Vorfall 2026-07-31, siehe installer-fragilitaet.md).
            const effectiveThreadId = isCommand ? null : threadId;
            const wireText = embedThreadTag(effectiveThreadId, text);
            const pubs = sendDirectMessage(pool, relays, identity, peerPubkeyHex, wireText);
            await Promise.any(pubs);
            const timestamp = Date.now();
            const category = isCommand ? 'premium' : 'support';
            const db = openMessagesDb();
            try {
                db.prepare(`
                    INSERT INTO nostr_support_messages (direction, timestamp, text, peer_pubkey, thread_id, category)
                    VALUES ('out', ?, ?, ?, ?, ?)
                `).run(timestamp, text, peerPubkeyHex, effectiveThreadId, category);
                pruneMessagesToLimit(db, category);
            } finally {
                db.close();
            }
            // Push auch für andere offene Message-Center-Tabs (Multi-Tab-Sync).
            messageEvents.emit(isCommand ? 'premium-message' : 'support-message', { direction: 'out', timestamp, text, peerPubkey: peerPubkeyHex });
        },
    };
}

const nostrService = startNostrService();

// ── HTTP API ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/identity', (_req, res) => {
    if (!identityExists(IDENTITY_NAME)) {
        return res.status(404).json({ error: t('msg.support.identity_missing_setup', { name: IDENTITY_NAME }) });
    }
    const id = loadIdentity(IDENTITY_NAME);
    res.json({
        name: id.name,
        alias: id.alias ?? null,
        npub: id.npub,
        pubkeyHex: id.pubkeyHex,
        resetLocked: IS_MASTER_IDENTITY,
    });
});

// Mitgeliefertes Adressbuch (öffentliche Pubkeys, u.a. der feste Support-Kontakt
// "FORGE Master") – damit ein Nutzer ohne Abtippen Kontakt aufnehmen kann.
app.get('/contacts', (_req, res) => {
    res.json({ contacts: loadContacts() });
});

// Relay-Verbindungsstatistik (Fund 2026-07-28: stiller Verbindungsverlust ohne
// Reconnect/Ping, siehe lib/nostr-stats.js) — Uptime/Downtime/Reconnect-Zahlen je Relay.
app.get('/nostr/stats', (_req, res) => {
    res.json({ relays: getConnectionStats() });
});

// Anzeigename (Nostr-Profil, kind 0) ändern. Leerer/fehlender Wert setzt den Default.
// kind 0 ist "replaceable" – erneutes Publizieren ersetzt das vorherige Profil beim Relay,
// deshalb ist das ein unkritischer Vorgang ohne Aufräumbedarf.
app.post('/identity/alias', async (req, res) => {
    if (!identityExists(IDENTITY_NAME)) {
        return res.status(404).json({ error: t('msg.support.identity_missing', { name: IDENTITY_NAME }) });
    }
    const alias = sanitizeAlias(req.body?.alias ?? '') || DEFAULT_ALIAS;
    try {
        const id = setIdentityAlias(IDENTITY_NAME, alias);
        // Profil sofort neu publizieren, sonst zeigen Gegenstellen weiter den alten Namen.
        if (nostrService) {
            await Promise.allSettled(
                publishProfile(nostrService.pool, nostrService.relays, id, { name: alias })
            );
        }
        res.json({ ok: true, alias });
    } catch (err) {
        res.status(500).json({ error: t('msg.support.alias_failed', { error: err.message }) });
    }
});

/**
 * Nostr-Account NEU anlegen (FORGE public: „Account zurücksetzen").
 *
 * 🔴 Unwiederbringlich: der alte Private Key wird überschrieben, die alte Identität ist
 * für alle Gegenstellen tot. Laufende Threads verwaisen — deshalb werden per
 * ausdrücklicher Festlegung (2026-07-27) ALLE bisherigen Nachrichten mitgelöscht: sie gehören
 * zur weggeworfenen Identität und wären dem neuen Key ohnehin nicht mehr zuzuordnen.
 *
 * Der Aufrufer (UI) MUSS vorher explizit rückfragen. Zur Absicherung gegen versehentliche
 * Aufrufe verlangt dieser Endpunkt zusätzlich `confirm: true` im Body.
 *
 * Die Relay-Subscription hört erst auf den neuen Pubkey, nachdem der Prozess neu gestartet
 * wurde – deshalb beendet sich der Dienst nach der Antwort selbst (`process.exit(0)`) und
 * verlässt sich auf `Restart=always` in der systemd-Unit (forge-premium.service), den Neustart
 * automatisch zu übernehmen (RestartSec=5).
 *
 * 🔒 Die Master-Identität ("FORGE.Master") darf NIE zurückgesetzt werden: ihre npub ist
 * überall bekannt (Fork-Installationen, Support-Kontakte, ggf. veröffentlicht) — nach
 * einem Reset müsste sich der neue Schlüssel erst wieder herumsprechen, bis dahin
 * erreicht niemand den Master mehr. Der Alias bleibt trotzdem änderbar (kein Schlüssel-
 * wechsel, kein Erreichbarkeitsproblem).
 */
app.post('/identity/regenerate', (req, res) => {
    if (IS_MASTER_IDENTITY) {
        return res.status(403).json({
            error: t('msg.support.master_no_reset'),
        });
    }
    if (req.body?.confirm !== true) {
        return res.status(400).json({
            error: t('msg.support.reset_confirm_missing'),
        });
    }
    const alias = sanitizeAlias(req.body?.alias ?? '') || DEFAULT_ALIAS;
    try {
        const id = createIdentity(IDENTITY_NAME, { overwrite: true, alias });
        // Alte Nachrichten gehören zur weggeworfenen Identität → mitlöschen.
        const db = openMessagesDb();
        let deleted = 0;
        try {
            deleted = db.prepare(`DELETE FROM nostr_support_messages`).run().changes;
        } finally {
            db.close();
        }
        console.log(`[premium] Nostr-Account neu angelegt (${id.npub}), ${deleted} alte Nachrichten gelöscht. Dienst startet neu (systemd Restart=always).`);
        res.json({
            ok: true,
            npub: id.npub,
            pubkeyHex: id.pubkeyHex,
            alias,
            deletedMessages: deleted,
        });
        res.on('finish', () => setTimeout(() => process.exit(0), 200));
    } catch (err) {
        res.status(500).json({ error: t('msg.support.account_failed', { error: err.message }) });
    }
});

app.get('/identity/qr', async (_req, res) => {
    if (!identityExists(IDENTITY_NAME)) {
        return res.status(404).json({ error: t('msg.support.identity_missing', { name: IDENTITY_NAME }) });
    }
    const id = loadIdentity(IDENTITY_NAME);
    try {
        // "nostr:"-URI (NIP-21) statt reinem npub, damit Scanner-Apps (z.B. Amethyst)
        // den Code direkt als Profil-Link erkennen statt als beliebigen Text.
        const svg = await QRCode.toString(`nostr:${id.npub}`, {
            type:   'svg',
            margin: 1,
            width:  220,
            color:  { dark: '#f1f5f9', light: '#1e293b' },
        });
        res.set('Content-Type', 'image/svg+xml');
        res.send(svg);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Gruppiert nach (peer_pubkey, thread_id) statt nur peer_pubkey – "ein Anliegen
// = ein Thread" (2026-07-30), siehe thread_id-Migration in openMessagesDb().
// COALESCE(thread_id,'') fasst alle Nachrichten OHNE Markierung (Bestand vor der
// Migration, oder DMs von Drittclients ohne Tag) in einem gemeinsamen "alten"
// Sammel-Thread zusammen, statt sie zu verlieren.
app.get('/support/threads', async (_req, res) => {
    const db = openMessagesDb();
    let rows;
    try {
        rows = db.prepare(`
            SELECT
                peer_pubkey AS peerPubkey,
                thread_id   AS threadId,
                MAX(timestamp) AS lastTimestamp,
                (SELECT text FROM nostr_support_messages m2
                 WHERE m2.peer_pubkey = m1.peer_pubkey
                   AND COALESCE(m2.thread_id,'') = COALESCE(m1.thread_id,'')
                   AND m2.category = 'support'
                 ORDER BY timestamp DESC LIMIT 1) AS lastText,
                SUM(CASE WHEN direction = 'in' AND read = 0 THEN 1 ELSE 0 END) AS unreadCount
            FROM nostr_support_messages m1
            WHERE peer_pubkey IS NOT NULL AND category = 'support'
            GROUP BY peer_pubkey, COALESCE(thread_id,'')
            ORDER BY lastTimestamp DESC
        `).all();
    } finally {
        db.close();
    }
    const names = await resolveProfileNames(rows.map(r => r.peerPubkey));
    res.json({ threads: rows.map(r => ({ ...r, peerName: names[r.peerPubkey] ?? null })) });
});

app.get('/support/unread-count', (_req, res) => {
    const db = openMessagesDb();
    try {
        const row = db.prepare(
            `SELECT COUNT(*) AS n, MIN(timestamp) AS oldest FROM nostr_support_messages
             WHERE direction = 'in' AND read = 0 AND category = 'support'`
        ).get();
        res.json({ unread: row.n, oldestUnread: row.oldest ?? null });
    } finally {
        db.close();
    }
});

// ?threadId= wählt das Anliegen aus; fehlt der Parameter (oder ist leer), gilt
// das der "alte" Sammel-Thread ohne Markierung (thread_id IS NULL).
app.get('/support/thread/:peer', async (req, res) => {
    const peerPubkeyHex = resolvePubkeyHex(req.params.peer);
    if (!peerPubkeyHex) return res.status(400).json({ error: t('msg.support.invalid_pubkey') });
    const threadId = typeof req.query.threadId === 'string' && req.query.threadId ? req.query.threadId : null;

    const db = openMessagesDb();
    let rows;
    try {
        rows = db.prepare(`
            SELECT id, direction, timestamp, text, peer_pubkey AS peerPubkey, thread_id AS threadId
            FROM nostr_support_messages
            WHERE peer_pubkey = ? AND COALESCE(thread_id,'') = COALESCE(?,'') AND category = 'support'
            ORDER BY timestamp ASC
            LIMIT 500
        `).all(peerPubkeyHex, threadId);
        db.prepare(`
            UPDATE nostr_support_messages SET read = 1
            WHERE peer_pubkey = ? AND COALESCE(thread_id,'') = COALESCE(?,'') AND direction = 'in' AND read = 0 AND category = 'support'
        `).run(peerPubkeyHex, threadId);
    } finally {
        db.close();
    }
    const names = await resolveProfileNames([peerPubkeyHex]);
    res.json({
        messages: rows,
        peerPubkey: peerPubkeyHex,
        peerNpub: nip19.npubEncode(peerPubkeyHex),
        peerName: names[peerPubkeyHex] ?? null,
        threadId,
    });
});

// Löscht ein einzelnes Anliegen (nicht alle Konversationen mit dieser
// Gegenstelle). Lokal only – löscht nichts auf Nostr-Relays, nur die eigene
// Kopie, gleiches Prinzip wie /identity/regenerate (dort: alle Threads).
//
// Vor dem eigentlichen DELETE werden die event_ids der betroffenen Zeilen in
// nostr_deleted_events festgehalten (siehe messages-db.js) – sonst liefert ein
// späterer Relay-Reconnect (since-Gap-Fill, lib/nostr-client.js) oder ein
// Server-Neustart (Backlog-Replay) dieselbe DM erneut aus, und der bisherige
// Dedup (UNIQUE event_id) greift nicht mehr, weil die Zeile ja weg ist – genau
// das Symptom "gelöschte Nachricht taucht Stunden später wieder auf" (2026-07-30).
app.delete('/support/thread/:peer', (req, res) => {
    const peerPubkeyHex = resolvePubkeyHex(req.params.peer);
    if (!peerPubkeyHex) return res.status(400).json({ error: t('msg.support.invalid_pubkey') });
    const threadId = typeof req.query.threadId === 'string' && req.query.threadId ? req.query.threadId : null;

    const db = openMessagesDb();
    let changes;
    try {
        const eventIds = db.prepare(
            `SELECT event_id FROM nostr_support_messages
             WHERE peer_pubkey = ? AND COALESCE(thread_id,'') = COALESCE(?,'') AND category = 'support' AND event_id IS NOT NULL`
        ).all(peerPubkeyHex, threadId).map(r => r.event_id);
        markEventsDeleted(db, eventIds);

        changes = db.prepare(
            `DELETE FROM nostr_support_messages WHERE peer_pubkey = ? AND COALESCE(thread_id,'') = COALESCE(?,'') AND category = 'support'`
        ).run(peerPubkeyHex, threadId).changes;
    } finally {
        db.close();
    }
    res.json({ ok: true, deletedMessages: changes });
});

/**
 * Flache Liste aller Premium-Protokoll-Nachrichten (kein Thread-Konzept nötig – es
 * gibt praktisch nur eine relevante Gegenstelle, den FORGE Master, siehe
 * Message-Center-Redesign 2026-07-28). Text wird bereits hier serverseitig
 * humanisiert (summary/detail statt Roh-JSON) ausgeliefert, damit das Frontend das
 * Wire-Protokoll nicht kennen muss. Markiert eingehende Nachrichten wie
 * /support/thread/:peer beim Abruf als gelesen.
 */
app.get('/premium', async (_req, res) => {
    const db = openMessagesDb();
    let rows;
    try {
        rows = db.prepare(`
            SELECT id, direction, timestamp, text, peer_pubkey AS peerPubkey, read
            FROM nostr_support_messages
            WHERE category = 'premium'
            ORDER BY timestamp DESC
            LIMIT 100
        `).all();
    } finally {
        db.close();
    }
    const names = await resolveProfileNames(rows.map(r => r.peerPubkey).filter(Boolean));
    const messages = rows.map(r => {
        const cmd = classifyPremiumCommand(r.text);
        const { summary, detail, payment = null } = cmd
            ? humanizePremiumMessage(r.direction, cmd)
            : { summary: r.text.slice(0, 140), detail: r.text };
        return {
            id: r.id,
            direction: r.direction,
            timestamp: r.timestamp,
            peerPubkey: r.peerPubkey,
            peerName: r.peerPubkey ? (names[r.peerPubkey] ?? null) : null,
            read: !!r.read,
            payment,
            summary,
            detail,
        };
    });
    res.json({ messages });
});

app.get('/premium/unread-count', (_req, res) => {
    const db = openMessagesDb();
    try {
        const row = db.prepare(
            `SELECT COUNT(*) AS n, MIN(timestamp) AS oldest FROM nostr_support_messages
             WHERE category = 'premium' AND direction = 'in' AND read = 0`
        ).get();
        res.json({ unread: row.n, oldestUnread: row.oldest ?? null });
    } finally {
        db.close();
    }
});

// Markiert eine einzelne Premium-Nachricht als gelesen – per-Nachricht statt der
// Thread-weiten Markierung wie bei /support/thread/:peer, da die Kurzform-Liste im
// Premium-Menü jede Nachricht einzeln (nicht gruppiert nach Gegenstelle) zeigt.
app.post('/premium/:id/read', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: t('msg.support.invalid_id') });
    const db = openMessagesDb();
    try {
        const info = db.prepare(
            `UPDATE nostr_support_messages SET read = 1 WHERE id = ? AND category = 'premium'`
        ).run(id);
        res.json({ ok: true, changed: info.changes });
    } finally {
        db.close();
    }
});

app.get('/support/stream', (req, res) => {
    res.set({
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache, no-transform',
        Connection:          'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const onSupportMessage = (payload) => {
        res.write(`event: support-message\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const onPremiumMessage = (payload) => {
        res.write(`event: premium-message\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    messageEvents.on('support-message', onSupportMessage);
    messageEvents.on('premium-message', onPremiumMessage);

    // Keepalive-Kommentar gegen Idle-Timeouts von Proxies/Browsern.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);

    req.on('close', () => {
        clearInterval(keepAlive);
        messageEvents.off('support-message', onSupportMessage);
        messageEvents.off('premium-message', onPremiumMessage);
    });
});

// Body: { text, peerPubkey, threadId? } (Antwort in einem bestehenden Anliegen)
// ODER { text, peerPubkey, newThread:true } (neues Anliegen – Server generiert
// die threadId, damit sie garantiert kollisionsfrei ist und das Frontend sie
// nicht selbst erfinden muss).
app.post('/support/send', async (req, res) => {
    const text = (req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: t('msg.support.text_missing') });

    const peerPubkeyHex = resolvePubkeyHex(req.body?.peerPubkey);
    if (!peerPubkeyHex) {
        return res.status(400).json({ error: t('msg.support.invalid_peer') });
    }

    if (!nostrService) {
        return res.status(503).json({ error: t('msg.support.nostr_not_ready') });
    }

    const threadId = req.body?.newThread === true
        ? generateThreadId()
        : (typeof req.body?.threadId === 'string' && req.body.threadId ? req.body.threadId : null);

    try {
        await nostrService.sendSupportMessage(peerPubkeyHex, text, threadId);
        res.json({ ok: true, threadId });
    } catch (err) {
        res.status(502).json({ error: `Senden fehlgeschlagen: ${err.message}` });
    }
});

// Ausschließlich localhost – kein LAN-Zugriff, forge-settings proxied.
app.listen(PORT, '127.0.0.1', () => {
    console.log(`✅  forge-premium läuft auf 127.0.0.1:${PORT}`);
});
