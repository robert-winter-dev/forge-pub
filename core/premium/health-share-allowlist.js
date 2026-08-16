/**
 * FORGE public Premium – Allowlist der Systemdaten-Freigabe. MASTER-ONLY.
 *
 * Verwaltet, welche npubs für einen manuell gewährten Premium-Zugang freigeschaltet
 * sind. Freischaltung ist ausschließlich ein bewusster, menschlicher Schritt auf dem
 * Master — diese Liste ist die einzige Quelle der Wahrheit dafür.
 *
 * ─── Was dieses Modul NICHT tut ──────────────────────────────────────────────
 * Es hängt sich NIRGENDS in die Zustellung ein. `deliver-blob.js` und
 * `getPaidCustomersForHour()` bleiben unverändert. Die Verknüpfung ist ein eigener,
 * separat zu verifizierender Bauschritt — genau deshalb liegt die riskante Logik hier
 * als eine einzelne, isoliert getestete Funktion (`isEligibleForHour`) und nicht
 * verstreut im Auslieferungspfad. Ein Fehler dort verschenkt Premium an alle.
 *
 * ─── Zwei Invarianten, die jede Änderung hier einhalten muss ─────────────────
 *  1. 🔒 **Fail-closed.** Jeder Pfad in `isEligibleForHour()`, der nicht positiv
 *     beweisen kann „dieser npub ist freigeschaltet UND hat für genau diese Stunde
 *     geliefert", liefert `false`. Kein `catch`, das zu `true` führt; kein Default,
 *     der bei fehlendem Datensatz durchlässt.
 *  2. 🔒 **Der npub kommt IMMER aus dem signierten Event-Absender**, nie aus dem
 *     Nachrichtentext (Confused Deputy). Dieses Modul kann das nicht selbst prüfen —
 *     der Aufrufer ist dafür verantwortlich und muss `rumor.pubkey` durchreichen.
 */

import Database from 'better-sqlite3';
import { PATHS } from '../../config/paths.js';
// Bewusst hourIdOf() aus lib/premium-memo.js und NICHT getHourId() aus ./blob-keys.js:
// beide rechnen identisch (floor(ms / 3_600_000)), aber premium-memo.js ist ohnehin
// zwischen Master und Fork geteilt, während blob-keys.js gezielt master-only bleibt.
// Der Import von dort hätte die Schlüsselerzeugung des Masters über die Import-Closure
// (tools/pub-export/allowlist.js) in den Fork-Build gezogen — für eine Einzeiler-
// Rechenfunktion ein völlig unnötiger Scope-Zuwachs beim Kunden.
import { hourIdOf } from '../../lib/premium-memo.js';

export const STATUS = { PENDING: 'pending', APPROVED: 'approved', REVOKED: 'revoked', LAPSED: 'lapsed' };

/**
 * Nach dieser Stille ohne Report wird ein freigeschalteter Teilnehmer deaktiviert
 * (Festlegung 2026-08-14, vorher 65 Min seit 2026-08-13): 60 Minuten Takt + 30 Minuten
 * Nachfrist. Er bleibt in der Liste SICHTBAR — nur sein Zugang ruht. Analog dazu, dass
 * premium-pay.js sich bei ausbleibender Zahlung selbst abschaltet.
 *
 * Grund der Anhebung von 65 auf 90 Min: Vorfall 2026-08-14 01:08 Uhr — Nostr-DM-Watchdog
 * (siehe DM_WATCHDOG_STALE_MS in lib/nostr-client.js) brauchte bis zu 20 Min, um eine
 * lautlos verstummte Subscription zu erkennen, wodurch ein einzelner verspäteter Report
 * knapp die 65-Min-Schwelle riss. 90 Min gibt dem Watchdog-Selbstheilungspfad mehr Puffer,
 * bevor der Kunde eine (unnötige) Lapse-Nachricht bekommt.
 *
 * 🔒 `lapsed` ist AUSDRÜCKLICH KEINE Strafe und NICHT dasselbe wie `revoked`:
 * Der Fork kann einen eigenen Ausfall nicht von einem Relay-Abbruch unterscheiden
 * (empirisch 26–69 Abbrüche), eine Bestrafung träfe deshalb regelmäßig Unbeteiligte.
 * Deshalb kehrt ein `lapsed`-Teilnehmer beim nächsten eintreffenden Report VON SELBST
 * zurück — ohne erneuten menschlichen Klick. Der Klick war die Zulassung dieses npubs,
 * und die gilt fort. Nur `revoked` ist klebrig, weil dahinter eine bewusste Entscheidung
 * steht.
 */
export const LAPSE_AFTER_MS = 90 * 60 * 1000;

// Nostr-Pubkey: 32 Byte als Kleinbuchstaben-Hex. Bewusst streng — ein leerer String,
// `null`, `undefined` oder ein Platzhalter wie '*' darf NIE ein Teilnehmer sein.
const PUBKEY_RE = /^[0-9a-f]{64}$/;
// Solana-Pubkey in base58 (ohne 0, O, I, l). Die Zustellung versiegelt gegen genau
// diesen Schlüssel (lib/premium-payer-binding.js) und validiert dort erneut.
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function openDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS health_share_participants (
            pubkey_hex   TEXT PRIMARY KEY,
            payer_wallet TEXT,
            status       TEXT NOT NULL,
            applied_at   INTEGER NOT NULL,
            decided_at   INTEGER,
            note         TEXT
        );

        -- Ein Report deckt genau eine Stunde ab. Schlüssel ist die Event-ID, NIE ein
        -- Zeitstempel: NIP-17-Gift-Wraps
        -- tragen absichtlich randomisierte created_at-Werte, ein zeitstempelbasierter
        -- Dedup verschluckt dadurch legitime Nachrichten dauerhaft (Vorfall
        -- 2026-08-08, ~90 Min Totalausfall der Blob-Auslieferung — siehe
        -- Entscheidungs-Log zur Bezahlung).
        CREATE TABLE IF NOT EXISTS health_share_reports (
            event_id    TEXT PRIMARY KEY,
            pubkey_hex  TEXT    NOT NULL,
            received_at INTEGER NOT NULL,
            hour_id     INTEGER NOT NULL,
            window_from INTEGER,
            window_to   INTEGER,
            version     TEXT,
            bytes       INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_hsr_pubkey_hour ON health_share_reports(pubkey_hex, hour_id);
        CREATE INDEX IF NOT EXISTS idx_hsr_received    ON health_share_reports(received_at);

        -- Inhalt der Reports, normalisiert (Konzept 2026-08-15, Ticket CORE#0298-Folge).
        -- report_event_id verweist lose auf health_share_reports.event_id — BEWUSST ohne
        -- FOREIGN KEY/CASCADE: health_share_reports wird nach 30 Tagen geprunt (dient nur
        -- Zustellung/Eligibility), diese beiden Tabellen bewusst NICHT — sie sind die
        -- eigentliche Analyse-Historie und sollen unbegrenzt erhalten bleiben (Speicher-
        -- volumen bei realistischer Teilnehmerzahl x Dienstanzahl x Jahre unkritisch).
        CREATE TABLE IF NOT EXISTS health_share_service_facts (
            report_event_id   TEXT    NOT NULL,
            pubkey_hex        TEXT    NOT NULL,
            hour_id           INTEGER NOT NULL,
            service_id        TEXT    NOT NULL,
            status_ok         INTEGER NOT NULL,
            status_warn       INTEGER NOT NULL,
            status_crit       INTEGER NOT NULL,
            status_unknown    INTEGER NOT NULL,
            latency_median_ms REAL,
            latency_max_ms    REAL,
            detail_code       TEXT,
            PRIMARY KEY (report_event_id, service_id)
        );
        CREATE INDEX IF NOT EXISTS idx_hssf_service_hour ON health_share_service_facts(service_id, hour_id);
        CREATE INDEX IF NOT EXISTS idx_hssf_pubkey        ON health_share_service_facts(pubkey_hex, service_id, hour_id);

        CREATE TABLE IF NOT EXISTS health_share_process_facts (
            report_event_id  TEXT    NOT NULL,
            pubkey_hex       TEXT    NOT NULL,
            hour_id          INTEGER NOT NULL,
            service_id       TEXT    NOT NULL,
            mem_median_bytes INTEGER,
            mem_max_bytes    INTEGER,
            uptime_sec       INTEGER,
            restarts         INTEGER,
            PRIMARY KEY (report_event_id, service_id)
        );
        CREATE INDEX IF NOT EXISTS idx_hspf_service_hour ON health_share_process_facts(service_id, hour_id);
        CREATE INDEX IF NOT EXISTS idx_hspf_pubkey        ON health_share_process_facts(pubkey_hex, service_id, hour_id);
    `);
    const cols = db.prepare(`PRAGMA table_info(health_share_participants)`).all().map(c => c.name);
    // lapse_notified_at: Kante für die "Zugang ruht"-Nachricht — verhindert, dass ein
    // dauerhaft stiller Teilnehmer bei jedem Prüflauf erneut angeschrieben wird. Wird bei
    // der Reaktivierung zurückgesetzt, damit ein SPÄTERES erneutes Aussetzen wieder meldet.
    // Gleiches Muster wie pay_failure_notified in lib/premium-auto-pay-store.js.
    if (!cols.includes('lapse_notified_at')) {
        db.exec(`ALTER TABLE health_share_participants ADD COLUMN lapse_notified_at INTEGER`);
    }
    // display_name (2026-08-13, Redesign): Anzeigename ("Nick") aus dem Nostr-Profil des
    // Teilnehmers, für die Übersicht im Tab "Health Monitor > Share" – ohne ihn wäre dort
    // nur der rohe Pubkey lesbar. Kommt mit der Aktivierungsnachricht (recordActivation()),
    // Alt-Teilnehmer aus der Zeit vor diesem Feld bleiben NULL (Anzeige fällt auf den
    // gekürzten Pubkey zurück, siehe listParticipants()).
    if (!cols.includes('display_name')) {
        db.exec(`ALTER TABLE health_share_participants ADD COLUMN display_name TEXT`);
    }
    // version_code/os (2026-08-15, Konzept Report-Inhalte): Kopfdaten des Reports, gehören
    // fachlich zu health_share_reports (eine Zeile pro Report) statt in eine eigene Tabelle.
    const reportCols = db.prepare(`PRAGMA table_info(health_share_reports)`).all().map(c => c.name);
    if (!reportCols.includes('version_code')) {
        db.exec(`ALTER TABLE health_share_reports ADD COLUMN version_code INTEGER`);
    }
    if (!reportCols.includes('os')) {
        db.exec(`ALTER TABLE health_share_reports ADD COLUMN os TEXT`);
    }
    return db;
}

// ─── Aktivierung ─────────────────────────────────────────────────────────────

/**
 * Hält eine eingegangene Aktivierung ("Health Monitor: Daten teilen aktiviert.") fest.
 * Schaltet NIE selbst frei — das ist ausschließlich ein menschlicher Klick
 * (`approveParticipant`).
 *
 * Die Aktivierungsnachricht ist reine Identifikation (Pubkey, Zustell-Wallet,
 * Anzeigename), kein Nachweis über gesendete Daten — der kommt über `recordReport()`,
 * sobald tatsächlich Reports eintreffen.
 *
 * @param {{pubkeyHex: string, payerWallet: string, displayName?: string|null}} params
 *        pubkeyHex MUSS aus dem signierten Event stammen (siehe Kopf-Invariante 2).
 */
export function recordActivation({ pubkeyHex, payerWallet, displayName = null }, { dbPath = PATHS.premiumDb, now = Date.now() } = {}) {
    if (!PUBKEY_RE.test(pubkeyHex ?? '')) return { ok: false, reason: 'ungültiger Nostr-Pubkey' };
    if (!WALLET_RE.test(payerWallet ?? '')) return { ok: false, reason: 'ungültige Premium-Wallet-Adresse' };

    const name = typeof displayName === 'string' && displayName ? displayName.slice(0, 80) : null;

    const db = openDb(dbPath);
    try {
        const existing = db.prepare(`SELECT status FROM health_share_participants WHERE pubkey_hex = ?`).get(pubkeyHex);

        if (!existing) {
            db.prepare(`
                INSERT INTO health_share_participants (pubkey_hex, payer_wallet, status, applied_at, display_name)
                VALUES (?, ?, ?, ?, ?)
            `).run(pubkeyHex, payerWallet, STATUS.PENDING, now, name);
            return { ok: true, status: STATUS.PENDING, created: true };
        }

        // 🔒 Eine bereits freigeschaltete Bindung wird durch eine erneute Aktivierung
        // NICHT verändert. Sonst genügte die Kontrolle über den npub, um die
        // Zustell-Wallet auf eine eigene umzubiegen — und damit die Bindung
        // auszuhebeln, die gerade verhindern soll, dass ein weitergereichter
        // Nostr-Account Premium mitliest. Wallet-Wechsel = widerrufen und neu
        // freischalten, also wieder ein bewusster menschlicher Schritt. Der
        // Anzeigename ist unkritisch und darf trotzdem nachziehen (reines Label).
        if (existing.status === STATUS.APPROVED || existing.status === STATUS.LAPSED) {
            if (name) db.prepare(`UPDATE health_share_participants SET display_name = ? WHERE pubkey_hex = ?`).run(name, pubkeyHex);
            return { ok: true, status: existing.status, unchanged: true, reason: 'bereits freigeschaltet – Bindung unverändert' };
        }

        // Ein Widerruf ist klebrig. Wer entzogen wurde, landet nicht durch erneute
        // Aktivierung wieder auf der Prüfliste — sonst wäre der Widerruf per Skript
        // umgehbar. Zurückholen geht nur über reopenParticipant().
        if (existing.status === STATUS.REVOKED) {
            return { ok: false, status: STATUS.REVOKED, reason: 'widerrufen – Wiederaufnahme nur manuell' };
        }

        // pending: korrigierte Angaben dürfen die alten überschreiben.
        db.prepare(`
            UPDATE health_share_participants
               SET payer_wallet = ?, applied_at = ?, display_name = COALESCE(?, display_name)
             WHERE pubkey_hex = ?
        `).run(payerWallet, now, name, pubkeyHex);
        return { ok: true, status: STATUS.PENDING, updated: true };
    } finally {
        db.close();
    }
}

/**
 * Setzt freigeschaltete Teilnehmer ohne frischen Report auf `lapsed`. Bewusst LAZY bei
 * jedem Lesezugriff statt per Cron: so ist der Zustand an genau den Stellen korrekt, an
 * denen er zählt (Übersicht, Zustellung) — ein vergessener oder ausgefallener Cron-Job
 * könnte hier keine stille Abweichung erzeugen.
 *
 * Stichzeit ist der SPÄTERE von letztem Report und Freischaltzeitpunkt: Wer gerade erst
 * freigeschaltet wurde, hat die volle Frist für seinen ersten Report.
 *
 * 🔒 Bewusst MAX(...) statt COALESCE(...): Seit dem Kurswechsel 2026-08-14 senden auch
 * noch nicht freigeschaltete Teilnehmer, ein Eintrag kann also bereits ALTE Reports
 * mitbringen. Mit COALESCE hätte der alte Report den frischen Freischaltzeitpunkt
 * überstimmt und der Zugang wäre in derselben Sekunde wieder ruhend gewesen, in der er
 * gewährt wurde — inklusive einer "Premium ruht"-Nachricht direkt nach der Zusage.
 */
function expireStale(db, now) {
    db.prepare(`
        UPDATE health_share_participants
           SET status = ?
         WHERE status = ?
           AND MAX(
                 COALESCE(
                   (SELECT MAX(received_at) FROM health_share_reports r WHERE r.pubkey_hex = health_share_participants.pubkey_hex),
                   0
                 ),
                 COALESCE(decided_at, 0)
               ) < ?
    `).run(STATUS.LAPSED, STATUS.APPROVED, now - LAPSE_AFTER_MS);
}

/**
 * Automatische Listenpflege gegen Karteileichen (2026-08-14, Auftrag): Wer
 * länger als 7 Tage keine Daten geliefert hat UND kein Premium User ist (`pending`,
 * `revoked` oder `lapsed` — `approved` kann per `expireStale()` oben gar nicht 7 Tage
 * still bleiben, das kippt schon nach 90 Minuten auf `lapsed`), wird gelöscht.
 *
 * Bewusst LAZY bei jedem Lesezugriff statt per Cron — gleiches Muster wie
 * `expireStale()`: ein ausgefallener Cron-Job könnte hier keine stille Abweichung
 * erzeugen, und die Liste ist beim nächsten Hinschauen garantiert aktuell.
 *
 * Stichzeit ist der letzte Report, ersatzweise der Aktivierungszeitpunkt (für einen
 * Teilnehmer, der noch nie gesendet hat) — wie bei `expireStale()`, nur andersherum
 * benannt (`applied_at` statt `decided_at`, weil ein gelöschter Nie-Sender oft noch
 * gar nicht entschieden wurde).
 *
 * Löscht NUR den Teilnehmer-Eintrag, `health_share_reports` bleibt unangetastet — wie
 * bei `deleteParticipant()` (Vorgabe: „seine Daten bleiben bestehen, es geht nur darum,
 * die Liste nicht überquellen zu lassen").
 */
const INACTIVE_DELETE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function pruneInactiveNonPremium(db, now) {
    db.prepare(`
        DELETE FROM health_share_participants
         WHERE status != ?
           AND COALESCE(
                 (SELECT MAX(received_at) FROM health_share_reports r WHERE r.pubkey_hex = health_share_participants.pubkey_hex),
                 applied_at
               ) < ?
    `).run(STATUS.APPROVED, now - INACTIVE_DELETE_AFTER_MS);
}

/**
 * Retention der Master-Zählerliste `health_share_reports` (Ticket CORE#0298). Die Zeilen
 * sind reine Metadaten (keine Erreichbarkeits-/Inhaltsdaten, siehe Modul-Kopf von
 * server.js: der Report-Text selbst wird nie persistiert) und dienen nur zwei Zwecken:
 * `isEligibleForHour()` (braucht nur die aktuelle Stunde) und der Admin-Übersicht
 * (`reportsLast7Days`, `firstReportAt`/`lastReportAt`). 30 Tage sind für beides weit
 * ausreichend — das ursprünglich dokumentierte Aggregat-Konzept ("30 Tage roh, danach
 * Tagesaggregate") entfällt damit, es gibt keine Analytics-Nutzung, die eine unbegrenzte
 * Historie bräuchte.
 *
 * Nebenwirkung: `firstReportAt` in `listParticipants()` zeigt nach 30 Tagen nicht mehr den
 * allerersten Report eines langjährigen Teilnehmers, sondern den ältesten noch
 * vorhandenen — bewusst in Kauf genommen, siehe Ticket.
 */
const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function pruneOldReports(db, now) {
    db.prepare(`DELETE FROM health_share_reports WHERE received_at < ?`).run(now - REPORT_RETENTION_MS);
}

// ─── Entscheidung (der eigentliche Schutz: ein Mensch klickt) ────────────────

export function countApproved({ dbPath = PATHS.premiumDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        expireStale(db, now);
        return db.prepare(`SELECT COUNT(*) AS n FROM health_share_participants WHERE status = ?`).get(STATUS.APPROVED).n;
    } finally {
        db.close();
    }
}

export function approveParticipant(pubkeyHex, { note = null, dbPath = PATHS.premiumDb, now = Date.now() } = {}) {
    if (!PUBKEY_RE.test(pubkeyHex ?? '')) return { ok: false, reason: 'ungültiger Nostr-Pubkey' };

    const db = openDb(dbPath);
    try {
        const run = db.transaction(() => {
            expireStale(db, now);
            const p = db.prepare(`SELECT status, payer_wallet FROM health_share_participants WHERE pubkey_hex = ?`).get(pubkeyHex);
            if (!p) return { ok: false, reason: 'unbekannter Teilnehmer – noch keine Aktivierungsnachricht eingegangen' };
            if (p.status === STATUS.APPROVED) return { ok: true, status: STATUS.APPROVED, unchanged: true };
            if (p.status === STATUS.REVOKED) return { ok: false, reason: 'widerrufen – zuerst wieder zur Prüfung zulassen' };

            // Ohne Wallet könnte die Zustellung nie versiegelt werden (deliver-blob.js
            // überspringt Empfänger ohne Wallet ersatzlos). Eine Freischaltung wäre
            // dann eine stille Null-Freischaltung: der Nutzer bekäme nie etwas und
            // bliebe auf Fehlersuche.
            if (!WALLET_RE.test(p.payer_wallet ?? '')) {
                return { ok: false, reason: 'keine gültige Premium-Wallet hinterlegt – Zustellung wäre nicht versiegelbar' };
            }

            db.prepare(`
                UPDATE health_share_participants SET status = ?, decided_at = ?, note = ? WHERE pubkey_hex = ?
            `).run(STATUS.APPROVED, now, note, pubkeyHex);
            return { ok: true, status: STATUS.APPROVED };
        });
        return run();
    } finally {
        db.close();
    }
}

/**
 * Ein-Klick-Widerruf. Bewusst ohne jede Vorbedingung außer „existiert": Auffälligkeiten
 * zeigen sich am Sendeverhalten über Zeit, und in dem Moment muss der Entzug sofort
 * greifen — Widerruf ist wichtiger als Prüfung.
 */
export function revokeParticipant(pubkeyHex, { note = null, dbPath = PATHS.premiumDb, now = Date.now() } = {}) {
    if (!PUBKEY_RE.test(pubkeyHex ?? '')) return { ok: false, reason: 'ungültiger Nostr-Pubkey' };
    const db = openDb(dbPath);
    try {
        const info = db.prepare(`
            UPDATE health_share_participants SET status = ?, decided_at = ?, note = COALESCE(?, note)
             WHERE pubkey_hex = ?
        `).run(STATUS.REVOKED, now, note, pubkeyHex);
        if (info.changes === 0) return { ok: false, reason: 'unbekannter Teilnehmer' };
        return { ok: true, status: STATUS.REVOKED };
    } finally {
        db.close();
    }
}

/** Holt einen Widerrufenen zurück auf die Prüfliste (bleibt `pending`, nicht freigeschaltet). */
export function reopenParticipant(pubkeyHex, { dbPath = PATHS.premiumDb, now = Date.now() } = {}) {
    if (!PUBKEY_RE.test(pubkeyHex ?? '')) return { ok: false, reason: 'ungültiger Nostr-Pubkey' };
    const db = openDb(dbPath);
    try {
        const info = db.prepare(`
            UPDATE health_share_participants SET status = ?, decided_at = ? WHERE pubkey_hex = ? AND status = ?
        `).run(STATUS.PENDING, now, pubkeyHex, STATUS.REVOKED);
        if (info.changes === 0) return { ok: false, reason: 'kein widerrufener Teilnehmer mit diesem Pubkey' };
        return { ok: true, status: STATUS.PENDING };
    } finally {
        db.close();
    }
}

/**
 * Entfernt einen Teilnehmer komplett aus der Liste (2026-08-14, Auftrag) —
 * reine Listenpflege gegen Karteileichen, kein Widerruf-Ersatz. Bewusste
 * Unterschiede zu `revokeParticipant()`:
 *   - Der Eintrag verschwindet ganz, statt sichtbar auf `revoked` zu stehen.
 *   - `health_share_reports` bleibt UNANGETASTET — die Datensätze bleiben bestehen,
 *     nur ohne sichtbaren Teilnehmer-Eintrag davor (Vorgabe: "seine Daten bleiben
 *     bestehen, es geht nur darum, die Liste nicht überquellen zu lassen").
 *   - Keine Nachricht an den Fork (bewusste Entscheidung: kein Versand). Der Fork
 *     merkt den Entzug indirekt und fail-closed: `isEligibleForHour()`/
 *     `recordReport()` finden keinen Eintrag mehr und lehnen ab wie bei einem
 *     nie aktivierten Absender.
 *   - Eine erneute Aktivierung desselben npubs beginnt danach bei `pending` wie ein
 *     neuer Teilnehmer (`recordActivation()`s `!existing`-Zweig) — Löschen ist damit
 *     NICHT klebrig, anders als ein Widerruf.
 */
export function deleteParticipant(pubkeyHex, { dbPath = PATHS.premiumDb } = {}) {
    if (!PUBKEY_RE.test(pubkeyHex ?? '')) return { ok: false, reason: 'ungültiger Nostr-Pubkey' };
    const db = openDb(dbPath);
    try {
        const info = db.prepare(`DELETE FROM health_share_participants WHERE pubkey_hex = ?`).run(pubkeyHex);
        if (info.changes === 0) return { ok: false, reason: 'unbekannter Teilnehmer' };
        return { ok: true };
    } finally {
        db.close();
    }
}

// ─── Reports ─────────────────────────────────────────────────────────────────

/**
 * Hält einen empfangenen Stundenreport fest.
 *
 * Angenommen wird von JEDEM bekannten Absender, der nicht widerrufen ist — auch von
 * `pending`. Die Zustimmung ist der Haken beim Nutzer, nicht die Freischaltung.
 *
 * 🔒 `revoked` bleibt ausgeschlossen. Der Widerruf ist die Notbremse des Betreibers:
 * Wer entzogen wurde, ist auffällig geworden — dann will man auch seine Daten nicht.
 * Fail-closed bleibt damit erhalten, nur die Grenze verläuft woanders.
 *
 * 🔒 Unbekannte Absender (gar keine Aktivierungsnachricht) werden weiterhin abgelehnt.
 * Ohne Eintrag gibt es keinen Beleg, dass dort jemand bewusst einen Haken gesetzt hat.
 *
 * @returns {{recorded: boolean, duplicate?: boolean, reason?: string}}
 */
// Fremdschlüssel-Feldlänge willkürlich, aber großzügig begrenzt — dieselbe Vorsicht wie
// bei display_name/version oben: ein npub darf über den Report-Inhalt keine beliebig
// langen Strings in die DB drücken (der Inhalt kommt aus dem signierten Event, aber
// dessen Format hält kein Absender-fremder Code fest).
function insertServiceFacts(db, eventId, pubkeyHex, hourId, services) {
    if (!Array.isArray(services) || !services.length) return;
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO health_share_service_facts
            (report_event_id, pubkey_hex, hour_id, service_id, status_ok, status_warn, status_crit, status_unknown, latency_median_ms, latency_max_ms, detail_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of services) {
        if (!s || typeof s.serviceId !== 'string') continue;
        const c = s.statusCounts ?? {};
        stmt.run(
            eventId, pubkeyHex, hourId, s.serviceId.slice(0, 120),
            Number.isFinite(c.ok) ? c.ok : 0,
            Number.isFinite(c.warn) ? c.warn : 0,
            Number.isFinite(c.crit) ? c.crit : 0,
            Number.isFinite(c.unknown) ? c.unknown : 0,
            Number.isFinite(s.latencyMedian) ? s.latencyMedian : null,
            Number.isFinite(s.latencyMax) ? s.latencyMax : null,
            typeof s.detailCode === 'string' ? s.detailCode.slice(0, 32) : null,
        );
    }
}

function insertProcessFacts(db, eventId, pubkeyHex, hourId, processes) {
    if (!Array.isArray(processes) || !processes.length) return;
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO health_share_process_facts
            (report_event_id, pubkey_hex, hour_id, service_id, mem_median_bytes, mem_max_bytes, uptime_sec, restarts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of processes) {
        if (!p || typeof p.serviceId !== 'string') continue;
        stmt.run(
            eventId, pubkeyHex, hourId, p.serviceId.slice(0, 120),
            Number.isFinite(p.memMedian) ? Math.round(p.memMedian) : null,
            Number.isFinite(p.memMax) ? Math.round(p.memMax) : null,
            Number.isFinite(p.uptimeSec) ? Math.round(p.uptimeSec) : null,
            Number.isFinite(p.restarts) ? Math.round(p.restarts) : null,
        );
    }
}

export function recordReport({ eventId, pubkeyHex, receivedAt = Date.now(), windowFrom = null, windowTo = null,
                                version = null, versionCode = null, os = null, bytes = null,
                                services = [], processes = [] },
                             { dbPath = PATHS.premiumDb } = {}) {
    if (!eventId || typeof eventId !== 'string') return { recorded: false, reason: 'fehlende Event-ID' };
    if (!PUBKEY_RE.test(pubkeyHex ?? '')) return { recorded: false, reason: 'ungültiger Nostr-Pubkey' };

    const db = openDb(dbPath);
    try {
        const p = db.prepare(`SELECT status FROM health_share_participants WHERE pubkey_hex = ?`).get(pubkeyHex);
        if (!p) return { recorded: false, reason: 'unbekannter Absender – keine Aktivierung eingegangen' };
        if (p.status === STATUS.REVOKED) return { recorded: false, reason: 'widerrufen' };

        return db.transaction(() => {
            // 🔒 Reaktivierung: Ein ruhender Zugang kommt VON SELBST zurück, sobald wieder
            // korrekte Daten eintreffen — der menschliche Klick galt diesem npub und gilt
            // fort. `revoked` kehrt NIE automatisch zurück, dahinter steht eine bewusste
            // Entscheidung.
            let reactivated = false;
            if (p.status === STATUS.LAPSED) {
                db.prepare(`UPDATE health_share_participants SET status = ?, lapse_notified_at = NULL WHERE pubkey_hex = ?`)
                    .run(STATUS.APPROVED, pubkeyHex);
                reactivated = true;
            }
            const hourId = hourIdOf(receivedAt);
            const info = db.prepare(`
                INSERT OR IGNORE INTO health_share_reports
                    (event_id, pubkey_hex, received_at, hour_id, window_from, window_to, version, version_code, os, bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(eventId, pubkeyHex, receivedAt, hourId, windowFrom, windowTo, version, versionCode, os, bytes);
            if (info.changes === 0) return { recorded: false, duplicate: true };

            // Nur bei einem NEUEN Report Fakten einfügen — ein Duplikat (siehe oben) bricht
            // schon vorher ab, die INSERT OR IGNORE hier greifen also nie doppelt.
            insertServiceFacts(db, eventId, pubkeyHex, hourId, services);
            insertProcessFacts(db, eventId, pubkeyHex, hourId, processes);

            return { recorded: true, reactivated };
        })();
    } finally {
        db.close();
    }
}

/**
 * Liefert die npubs, deren Zugang gerade ruhend geworden ist und die noch keine Nachricht
 * dazu bekommen haben — und markiert sie in derselben Transaktion als benachrichtigt.
 *
 * Bewusst getrennt vom Markieren des Status (`expireStale`, läuft bei jedem Lesezugriff):
 * Ein Lesezugriff darf keine Nachrichten verschicken. Der Aufrufer hat den Nostr-Zugang,
 * dieses Modul nicht. Atomar, damit zwei parallele Läufe nicht doppelt anschreiben.
 */
export function takePendingLapseNotifications({ dbPath = PATHS.premiumDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        return db.transaction(() => {
            expireStale(db, now);
            const rows = db.prepare(
                `SELECT pubkey_hex AS pubkeyHex FROM health_share_participants
                  WHERE status = ? AND lapse_notified_at IS NULL`
            ).all(STATUS.LAPSED);
            const stmt = db.prepare(`UPDATE health_share_participants SET lapse_notified_at = ? WHERE pubkey_hex = ?`);
            for (const r of rows) stmt.run(now, r.pubkeyHex);
            return rows.map(r => r.pubkeyHex);
        })();
    } finally {
        db.close();
    }
}

// ─── 🔴 Die eine sicherheitskritische Funktion ───────────────────────────────

/**
 * Darf dieser npub für GENAU DIESE Stunde Premium ohne Bezahlung bekommen?
 *
 * 🔒 Bewusst so eng: ein Report erkauft genau eine Stunde — identisch zur Zahlung,
 * weil `K_H` ohnehin stündlich rotiert. Kein Report für Stunde H → kein Zugang für
 * Stunde H, ohne jede Straflogik und ohne neuen Zustand. Bleibt der Report aus (auch
 * wegen eines Relay-Abbruchs, empirisch 26–69 Vorkommnisse), läuft Premium nach 60
 * Minuten von selbst aus, statt jemanden zu bestrafen.
 *
 * Jeder Rückgabepfad außer dem letzten ist `false`. Wer diese Funktion ändert, prüft
 * zuerst `selfTest()` unten — dort steht jede dieser Bedingungen als eigener Fall.
 */
export function isEligibleForHour(pubkeyHex, hourId, { dbPath = PATHS.premiumDb } = {}) {
    if (!PUBKEY_RE.test(pubkeyHex ?? '')) return false;
    if (!Number.isInteger(hourId)) return false;

    const db = openDb(dbPath);
    try {
        expireStale(db, Date.now());
        const p = db.prepare(`SELECT status, payer_wallet FROM health_share_participants WHERE pubkey_hex = ?`).get(pubkeyHex);
        if (!p) return false;
        if (p.status !== STATUS.APPROVED) return false;
        if (!WALLET_RE.test(p.payer_wallet ?? '')) return false;

        const r = db.prepare(`
            SELECT 1 FROM health_share_reports WHERE pubkey_hex = ? AND hour_id = ? LIMIT 1
        `).get(pubkeyHex, hourId);
        return !!r;
    } finally {
        db.close();
    }
}

/**
 * Alle für diese Stunde bezugsberechtigten Teilnehmer — bewusst in derselben Form wie
 * `getPaidCustomersForHour()` (payment-watcher.js), damit der spätere Bauschritt die
 * beiden Listen nur noch zusammenführen muss, ohne hier Feldnamen umzubiegen.
 *
 * ⚠️ NOCH NICHT VERDRAHTET. `deliver-blob.js` ruft das absichtlich nicht auf.
 */
export function getEligibleParticipantsForHour(hourId, { dbPath = PATHS.premiumDb } = {}) {
    if (!Number.isInteger(hourId)) return [];
    const db = openDb(dbPath);
    try {
        expireStale(db, Date.now());
        return db.prepare(`
            SELECT p.pubkey_hex AS customerPubkeyHex, p.payer_wallet AS payerWallet
              FROM health_share_participants p
             WHERE p.status = ?
               AND EXISTS (SELECT 1 FROM health_share_reports r
                            WHERE r.pubkey_hex = p.pubkey_hex AND r.hour_id = ?)
        `).all(STATUS.APPROVED, hourId).filter(r => WALLET_RE.test(r.payerWallet ?? ''));
    } finally {
        db.close();
    }
}

// ─── Übersicht für die Bedien-Oberfläche ─────────────────────────────────────

/**
 * Alle Teilnehmer samt Sendevolumen. Das Volumen ist kein Beiwerk: Auffälligkeiten
 * zeigen sich am Sendeverhalten über Zeit, nicht am npub im Moment der Aktivierung.
 */
/**
 * Für die Admin-Übersicht (Health Monitor > Daten teilen). `reportsLast7Days` zählt
 * bewusst nur ein 7-Tage-Fenster, nicht alle jemals empfangenen Reports (2026-08-14,
 * Auftrag) — sonst wächst die Zahl unbegrenzt und alte Datensätze verlieren an
 * Aussagekraft für den Zweck der Spalte ("wie aktiv ist der Teilnehmer gerade"). Die
 * zugrundeliegende Tabelle `health_share_reports` wird davon nicht durch diesen Filter
 * geprunt, sondern separat und unabhängig von diesem 7-Tage-Fenster durch
 * `pruneOldReports()` (30 Tage, Ticket CORE#0298).
 * `firstReportAt`/`lastReportAt` laufen über die komplette (nach 30 Tagen geprunte)
 * Historie, nicht nur die letzten 7 Tage — sonst zeigte "Erster Report" bei einem
 * langjährigen Teilnehmer irreführend ein Datum aus dieser Woche.
 */
export function listParticipants({ dbPath = PATHS.premiumDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        expireStale(db, now);
        pruneInactiveNonPremium(db, now);
        pruneOldReports(db, now);
        const since7d = now - 7 * 24 * 60 * 60 * 1000;
        return db.prepare(`
            SELECT p.pubkey_hex AS pubkeyHex,
                   p.payer_wallet AS payerWallet,
                   p.display_name AS displayName,
                   p.status,
                   p.applied_at AS appliedAt,
                   p.decided_at AS decidedAt,
                   p.note,
                   (SELECT COUNT(*) FROM health_share_reports r
                     WHERE r.pubkey_hex = p.pubkey_hex AND r.received_at >= @since7d)                       AS reportsLast7Days,
                   (SELECT MIN(received_at) FROM health_share_reports r WHERE r.pubkey_hex = p.pubkey_hex) AS firstReportAt,
                   (SELECT MAX(received_at) FROM health_share_reports r WHERE r.pubkey_hex = p.pubkey_hex) AS lastReportAt
              FROM health_share_participants p
             ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                      p.applied_at DESC
        `).all({ since7d });
    } finally {
        db.close();
    }
}

// ─── Selbsttest (temporäre DB, keine echten Teilnehmer) ──────────────────────

export async function selfTest() {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { randomBytes } = await import('crypto');
    const fs = await import('fs');

    const dbPath = join(tmpdir(), `health-share-selftest-${randomBytes(4).toString('hex')}.db`);
    const failures = [];
    const check = (cond, msg) => { if (!cond) failures.push(msg); };
    const o = { dbPath };

    const pk = a => a.repeat(64).slice(0, 64);
    const ALICE = pk('a1'), BOB = pk('b2'), MALLORY = pk('c3');
    const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    const H = hourIdOf();

    try {
        // ── Aktivierung schaltet NIE selbst frei ──────────────────────────────
        check(recordActivation({ pubkeyHex: ALICE, payerWallet: WALLET, displayName: 'Alice' }, { dbPath }).status === STATUS.PENDING,
            'Aktivierung sollte pending sein');
        check(isEligibleForHour(ALICE, H, { dbPath }) === false,
            '🔴 pending-Teilnehmer wurde als bezugsberechtigt gewertet');
        check(listParticipants({ dbPath }).find(p => p.pubkeyHex === ALICE)?.displayName === 'Alice',
            'Anzeigename wurde nicht übernommen');

        // ── Müll-Eingaben dürfen niemals Teilnehmer werden ────────────────────
        for (const bad of [null, undefined, '', '*', 'A'.repeat(64), pk('a1').slice(0, 63)]) {
            check(recordActivation({ pubkeyHex: bad, payerWallet: WALLET }, { dbPath }).ok === false,
                `🔴 ungültiger Pubkey akzeptiert: ${String(bad)}`);
            check(isEligibleForHour(bad, H, { dbPath }) === false,
                `🔴 ungültiger Pubkey als bezugsberechtigt gewertet: ${String(bad)}`);
        }
        check(recordActivation({ pubkeyHex: BOB, payerWallet: 'keine-wallet' }, { dbPath }).ok === false,
            'ungültige Wallet akzeptiert');

        // ── Report OHNE Freischaltung wird gezählt, berechtigt aber zu nichts ──
        // Kurswechsel 2026-08-14: "Daten teilen" ist Opt-in-Telemetrie, die Zustimmung
        // ist der Haken. Premium hängt weiterhin allein an der Freischaltung.
        const VOR_FREIGABE = Date.now() - 10 * 60 * 60 * 1000;   // 10 h alt: liegt vor Stunde H
        check(recordReport({ eventId: 'e-pending', pubkeyHex: ALICE, receivedAt: VOR_FREIGABE }, { dbPath }).recorded === true,
            '🔴 Report eines noch nicht freigeschalteten Teilnehmers wurde verworfen');
        check(isEligibleForHour(ALICE, hourIdOf(VOR_FREIGABE), { dbPath }) === false,
            '🔴 ein Report allein hat Premium verschafft – ohne Freischaltung');

        // ── Freischalten + Report = bezugsberechtigt ──────────────────────────
        check(approveParticipant(ALICE, { dbPath }).ok === true, 'Freischaltung fehlgeschlagen');
        check(isEligibleForHour(ALICE, H, { dbPath }) === false,
            '🔴 freigeschaltet, aber OHNE Report als bezugsberechtigt gewertet');
        // 🔒 Der alte Report aus der pending-Zeit darf die frische Freischaltung nicht
        // sofort wieder ruhend machen (siehe expireStale()).
        check(listParticipants({ dbPath }).find(p => p.pubkeyHex === ALICE)?.status === STATUS.APPROVED,
            '🔴 frisch Freigeschalteter ruhte sofort wegen eines alten pending-Reports');
        check(recordReport({ eventId: 'e1', pubkeyHex: ALICE, receivedAt: Date.now() }, { dbPath }).recorded === true,
            'Report wurde nicht erfasst');
        check(isEligibleForHour(ALICE, H, { dbPath }) === true,
            'freigeschaltet + frischer Report sollte bezugsberechtigt sein');

        // ── Ein Report erkauft GENAU EINE Stunde ──────────────────────────────
        check(isEligibleForHour(ALICE, H + 1, { dbPath }) === false,
            '🔴 Report für Stunde H berechtigte auch für H+1');
        check(isEligibleForHour(ALICE, H - 1, { dbPath }) === false,
            '🔴 Report für Stunde H berechtigte auch für H-1');

        // ── Dedup über die Event-ID ───────────────────────────────────────────
        check(recordReport({ eventId: 'e1', pubkeyHex: ALICE }, { dbPath }).duplicate === true,
            'doppelte Event-ID wurde nicht als Duplikat erkannt');

        // ── Ruhen nach Stille + automatische Rückkehr ─────────────────────────
        const FRISCH = Date.now();
        const ALT    = FRISCH - (LAPSE_AFTER_MS + 60_000);
        const RUHE   = pk('d4');
        recordActivation({ pubkeyHex: RUHE, payerWallet: WALLET }, o);
        // Freischaltung ebenfalls in die Vergangenheit: Stichzeit ist der SPÄTERE von
        // Report und Freischaltung (siehe expireStale) — mit einer frischen
        // Freischaltung könnte hier gar nichts ruhen, und der Test prüfte nichts.
        approveParticipant(RUHE, { ...o, now: ALT });
        recordReport({ eventId: 'r-alt', pubkeyHex: RUHE, receivedAt: ALT }, o);
        // Solange der Report frisch genug ist, bleibt alles beim Alten.
        check(listParticipants({ ...o, now: ALT + 1000 }).find(p => p.pubkeyHex === RUHE)?.status === STATUS.APPROVED,
            'frischer Report sollte den Zugang aktiv lassen');
        // Nach der Frist ruht der Zugang – aber er bleibt SICHTBAR in der Liste.
        const nachFrist = listParticipants(o).find(p => p.pubkeyHex === RUHE);
        check(nachFrist != null, '🔴 ruhender Teilnehmer verschwand aus der Liste – er soll sichtbar bleiben');
        check(nachFrist?.status === STATUS.LAPSED, 'nach der Frist sollte der Zugang ruhen');
        check(isEligibleForHour(RUHE, hourIdOf(FRISCH), o) === false,
            '🔴 ruhender Zugang bekam weiter Premium-Daten');
        check(!getEligibleParticipantsForHour(hourIdOf(FRISCH), o).some(r => r.customerPubkeyHex === RUHE),
            'ruhender Zugang tauchte in der Zustellliste auf');

        // Benachrichtigung genau EINMAL.
        check(takePendingLapseNotifications(o).includes(RUHE), 'ruhender Zugang wurde nicht zur Meldung vorgemerkt');
        check(!takePendingLapseNotifications(o).includes(RUHE), '🔴 dieselbe Meldung wurde zweimal vorgemerkt');

        // Neue korrekte Daten holen ihn von selbst zurück – ohne erneuten Klick.
        const wieder = recordReport({ eventId: 'r-neu', pubkeyHex: RUHE, receivedAt: FRISCH }, o);
        check(wieder.recorded === true && wieder.reactivated === true,
            '🔴 neuer Report reaktivierte den ruhenden Zugang nicht');
        check(listParticipants(o).find(p => p.pubkeyHex === RUHE)?.status === STATUS.APPROVED,
            'nach der Reaktivierung sollte der Zugang wieder aktiv sein');
        check(isEligibleForHour(RUHE, hourIdOf(FRISCH), o) === true,
            'reaktivierter Zugang sollte wieder Premium-Daten bekommen');
        // Ein erneutes Aussetzen muss wieder melden dürfen.
        check(takePendingLapseNotifications({ ...o, now: FRISCH + LAPSE_AFTER_MS + 60_000 }).includes(RUHE),
            '🔴 nach Reaktivierung wurde ein erneutes Aussetzen nicht mehr gemeldet');
        revokeParticipant(RUHE, o);

        // ── Widerruf greift sofort, trotz frischem Report ─────────────────────
        check(revokeParticipant(ALICE, { dbPath }).ok === true, 'Widerruf fehlgeschlagen');
        check(isEligibleForHour(ALICE, H, { dbPath }) === false,
            '🔴 widerrufener Teilnehmer war trotz frischem Report weiter bezugsberechtigt');
        check(recordActivation({ pubkeyHex: ALICE, payerWallet: WALLET }, { dbPath }).ok === false,
            '🔴 Widerruf war durch erneute Aktivierung umgehbar');
        check(approveParticipant(ALICE, { dbPath }).ok === false,
            '🔴 widerrufener Teilnehmer ließ sich direkt wieder freischalten');

        // ── Unbekannter npub bekommt nie etwas ────────────────────────────────
        check(isEligibleForHour(MALLORY, H, { dbPath }) === false,
            '🔴 unbekannter npub wurde als bezugsberechtigt gewertet');
        check(approveParticipant(MALLORY, { dbPath }).ok === false,
            '🔴 npub ohne Aktivierung ließ sich freischalten');

        // ── Keine Obergrenze mehr (Festlegung 2026-08-13) ─────────────────────
        reopenParticipant(ALICE, { dbPath });
        approveParticipant(ALICE, { dbPath });
        const filler = [];
        for (let i = 0; i < 15; i++) {
            const unique = (i.toString(16).padStart(4, '0') + 'f'.repeat(60)).slice(0, 64);
            filler.push(unique);
            recordActivation({ pubkeyHex: unique, payerWallet: WALLET }, { dbPath });
            check(approveParticipant(unique, { dbPath }).ok === true,
                `🔴 Freischaltung Nr. ${i + 1} sollte ohne Obergrenze möglich sein`);
        }
        check(countApproved({ dbPath }) === 16, // filler (15) + ALICE
            `🔴 nicht alle Freischaltungen wurden gezählt: ${countApproved({ dbPath })}`);

        // Widerruf funktioniert unverändert, unabhängig von jeder Zählung.
        revokeParticipant(filler[0], { dbPath });
        check(countApproved({ dbPath }) === 15, 'Widerruf hat die Zählung nicht verringert');

        // ── Bindung ist durch erneute Aktivierung nicht umbiegbar ─────────────
        const OTHER_WALLET = 'So11111111111111111111111111111111111111112';
        recordActivation({ pubkeyHex: ALICE, payerWallet: OTHER_WALLET }, { dbPath });
        const aliceRow = listParticipants({ dbPath }).find(p => p.pubkeyHex === ALICE);
        check(aliceRow?.payerWallet === WALLET,
            '🔴 Zustell-Wallet eines freigeschalteten Teilnehmers war per Aktivierung überschreibbar');

        // ── getEligibleParticipantsForHour bleibt konsistent zu isEligibleForHour
        const list = getEligibleParticipantsForHour(H, { dbPath });
        check(list.every(r => isEligibleForHour(r.customerPubkeyHex, H, { dbPath })),
            '🔴 Liste enthielt einen Teilnehmer, den die Einzelprüfung ablehnt');
        check(!Number.isInteger('x') && getEligibleParticipantsForHour('x', { dbPath }).length === 0,
            'ungültige hourId lieferte Teilnehmer');

        // ── reportsLast7Days zeigt nur ein 7-Tage-Fenster, nicht die volle Historie ──
        const jetzt7d    = Date.now();
        const vor8Tagen  = jetzt7d - 8 * 24 * 60 * 60 * 1000;
        const SIEBEN_TAGE = pk('e5');
        recordActivation({ pubkeyHex: SIEBEN_TAGE, payerWallet: WALLET }, { dbPath, now: vor8Tagen });
        approveParticipant(SIEBEN_TAGE, { dbPath, now: vor8Tagen });
        recordReport({ eventId: 'e-alt', pubkeyHex: SIEBEN_TAGE, receivedAt: vor8Tagen }, { dbPath });
        recordReport({ eventId: 'e-neu', pubkeyHex: SIEBEN_TAGE, receivedAt: jetzt7d }, { dbPath });
        const siebenTageRow = listParticipants({ dbPath, now: jetzt7d }).find(p => p.pubkeyHex === SIEBEN_TAGE);
        check(siebenTageRow?.reportsLast7Days === 1,
            `🔴 reportsLast7Days sollte nur den frischen Report zählen (1), zeigt aber ${siebenTageRow?.reportsLast7Days}`);
        check(siebenTageRow?.firstReportAt === vor8Tagen,
            '🔴 firstReportAt sollte die VOLLE Historie zeigen, nicht nur die letzten 7 Tage');

        // ── deleteParticipant(): Listenpflege, Daten bleiben bestehen ─────────
        const ZU_LOESCHEN = pk('f6');
        recordActivation({ pubkeyHex: ZU_LOESCHEN, payerWallet: WALLET }, { dbPath });
        approveParticipant(ZU_LOESCHEN, { dbPath });
        recordReport({ eventId: 'e-bleibt', pubkeyHex: ZU_LOESCHEN, receivedAt: Date.now() }, { dbPath });
        check(deleteParticipant('ungültig', { dbPath }).ok === false, 'ungültiger Pubkey wurde akzeptiert');
        check(deleteParticipant(pk('99'), { dbPath }).ok === false,
            '🔴 Löschen eines unbekannten Teilnehmers meldete Erfolg');
        check(deleteParticipant(ZU_LOESCHEN, { dbPath }).ok === true, 'Löschen ist fehlgeschlagen');
        check(!listParticipants({ dbPath }).some(p => p.pubkeyHex === ZU_LOESCHEN),
            '🔴 gelöschter Teilnehmer stand weiter in der Liste');
        const rawDb = new Database(dbPath);
        const reportsBleibenErhalten = rawDb.prepare(
            `SELECT COUNT(*) AS n FROM health_share_reports WHERE pubkey_hex = ?`
        ).get(ZU_LOESCHEN).n;
        rawDb.close();
        check(reportsBleibenErhalten === 1,
            '🔴 Löschen des Teilnehmers hat auch seine Report-Historie entfernt – sollte bestehen bleiben');
        // Erneute Aktivierung nach dem Löschen ist NICHT klebrig (anders als Widerruf) –
        // beginnt wie ein neuer Teilnehmer bei pending.
        check(recordActivation({ pubkeyHex: ZU_LOESCHEN, payerWallet: WALLET }, { dbPath }).status === STATUS.PENDING,
            '🔴 erneute Aktivierung nach dem Löschen sollte wieder bei "pending" beginnen');

        // ── Automatische Listenpflege: 7 Tage inaktiv + kein Premium → gelöscht ──
        const jetztPrune = Date.now();
        const vor8TagenPrune = jetztPrune - (INACTIVE_DELETE_AFTER_MS + 24 * 60 * 60 * 1000);

        // Fall A: pending, nie gesendet, Aktivierung vor 8 Tagen → wird gelöscht.
        const NIE_GESENDET = pk('a7');
        recordActivation({ pubkeyHex: NIE_GESENDET, payerWallet: WALLET }, { dbPath, now: vor8TagenPrune });

        // Fall B: revoked vor 8 Tagen, seither still → wird gelöscht.
        const ALT_WIDERRUFEN = pk('b8');
        recordActivation({ pubkeyHex: ALT_WIDERRUFEN, payerWallet: WALLET }, { dbPath, now: vor8TagenPrune });
        revokeParticipant(ALT_WIDERRUFEN, { dbPath, now: vor8TagenPrune });

        // Fall C: approved, sendet seit 8 Tagen nicht mehr → erst expireStale() auf
        // lapsed, DANACH greift dieselbe 7-Tage-Regel wie bei B.
        const ALT_LAPSED = pk('c9');
        recordActivation({ pubkeyHex: ALT_LAPSED, payerWallet: WALLET }, { dbPath, now: vor8TagenPrune });
        approveParticipant(ALT_LAPSED, { dbPath, now: vor8TagenPrune });
        recordReport({ eventId: 'e-alt-lapsed', pubkeyHex: ALT_LAPSED, receivedAt: vor8TagenPrune }, { dbPath });

        // Gegenprobe: approved, aktueller Report vor 8 Tagen wäre zwar 7-Tage-alt,
        // aber approved kann laut Kopf-Kommentar gar nicht so lange still bleiben –
        // hier stattdessen ein Report von HEUTE, muss unangetastet bleiben.
        const AKTIV = pk('d0');
        recordActivation({ pubkeyHex: AKTIV, payerWallet: WALLET }, { dbPath, now: vor8TagenPrune });
        approveParticipant(AKTIV, { dbPath, now: vor8TagenPrune });
        recordReport({ eventId: 'e-aktiv', pubkeyHex: AKTIV, receivedAt: jetztPrune }, { dbPath });

        const nachPrune = listParticipants({ dbPath, now: jetztPrune }).map(p => p.pubkeyHex);
        check(!nachPrune.includes(NIE_GESENDET), '🔴 nie gesendet + 8 Tage alt wurde nicht automatisch gelöscht');
        check(!nachPrune.includes(ALT_WIDERRUFEN), '🔴 8 Tage alter Widerruf wurde nicht automatisch gelöscht');
        check(!nachPrune.includes(ALT_LAPSED), '🔴 8 Tage inaktiver, ruhender Premium-User wurde nicht automatisch gelöscht');
        check(nachPrune.includes(AKTIV), '🔴 ein aktiver Premium-User wurde fälschlich automatisch gelöscht');

        // ── Retention der Report-Zeilen: älter als 30 Tage wird geprunt (CORE#0298) ──
        const vor31Tagen = jetztPrune - 31 * 24 * 60 * 60 * 1000;
        recordReport({ eventId: 'e-uralt', pubkeyHex: AKTIV, receivedAt: vor31Tagen }, { dbPath });
        listParticipants({ dbPath, now: jetztPrune }); // löst pruneOldReports() aus
        const rawDb2 = new Database(dbPath);
        const uraltNochDa = rawDb2.prepare(`SELECT COUNT(*) AS n FROM health_share_reports WHERE event_id = ?`).get('e-uralt').n;
        const frischNochDa = rawDb2.prepare(`SELECT COUNT(*) AS n FROM health_share_reports WHERE event_id = ?`).get('e-aktiv').n;
        rawDb2.close();
        check(uraltNochDa === 0, '🔴 31 Tage alte Report-Zeile wurde nicht geprunt');
        check(frischNochDa === 1, '🔴 aktuelle Report-Zeile wurde fälschlich mitgeprunt');

        // ── Report-Inhalt landet normalisiert in den Fact-Tabellen (Konzept 2026-08-15) ──
        const FACTS = pk('e1');
        recordActivation({ pubkeyHex: FACTS, payerWallet: WALLET }, { dbPath });
        approveParticipant(FACTS, { dbPath });
        const factsReport = recordReport({
            eventId: 'e-facts', pubkeyHex: FACTS,
            version: '0.9.8', versionCode: 69, os: 'linux 6.8.0',
            services: [
                { serviceId: 'forge-nexus', statusCounts: { ok: 55, warn: 2, crit: 1, unknown: 2 },
                  latencyMedian: 12.5, latencyMax: 340, detailCode: 'http_5xx' },
                { serviceId: 'ohne-counts' }, // fehlende statusCounts → muss trotzdem als 0en landen
            ],
            processes: [
                { serviceId: 'forge-nexus', memMedian: 123456789, memMax: 234567890, uptimeSec: 86400, restarts: 1 },
            ],
        }, { dbPath });
        check(factsReport.recorded === true, 'Report mit Inhalt wurde nicht angenommen');

        const rawDb3 = new Database(dbPath);
        const svcRow = rawDb3.prepare(`SELECT * FROM health_share_service_facts WHERE report_event_id = ? AND service_id = ?`)
            .get('e-facts', 'forge-nexus');
        check(svcRow?.status_ok === 55 && svcRow?.status_crit === 1 && svcRow?.detail_code === 'http_5xx',
            '🔴 Service-Fakten wurden nicht korrekt gespeichert');
        check(svcRow?.latency_median_ms === 12.5, '🔴 Latenz-Median falsch gespeichert');
        const svcCount = rawDb3.prepare(`SELECT COUNT(*) AS n FROM health_share_service_facts WHERE report_event_id = ?`)
            .get('e-facts').n;
        check(svcCount === 2, `🔴 erwartet 2 Service-Fakten-Zeilen (auch ohne statusCounts), gefunden ${svcCount}`);
        const procRow = rawDb3.prepare(`SELECT * FROM health_share_process_facts WHERE report_event_id = ? AND service_id = ?`)
            .get('e-facts', 'forge-nexus');
        check(procRow?.mem_median_bytes === 123456789 && procRow?.restarts === 1,
            '🔴 Prozess-Fakten wurden nicht korrekt gespeichert');
        const reportRow = rawDb3.prepare(`SELECT version_code, os FROM health_share_reports WHERE event_id = ?`).get('e-facts');
        check(reportRow?.version_code === 69 && reportRow?.os === 'linux 6.8.0',
            '🔴 version_code/os wurden nicht auf health_share_reports gespeichert');
        rawDb3.close();

        // Dedup: derselbe Event greift auch für die Fakten – ein erneut zugestellter
        // Report (der Fork sendet bei ausbleibender Bestätigung bis zu 3×) darf keine
        // zweiten Fact-Zeilen erzeugen.
        const dup = recordReport({
            eventId: 'e-facts', pubkeyHex: FACTS,
            services: [{ serviceId: 'forge-nexus', statusCounts: { ok: 1, warn: 0, crit: 0, unknown: 0 } }],
        }, { dbPath });
        check(dup.duplicate === true, 'Duplikat wurde nicht erkannt');
        const rawDb4 = new Database(dbPath);
        const svcCountAfterDup = rawDb4.prepare(`SELECT COUNT(*) AS n FROM health_share_service_facts WHERE report_event_id = ?`)
            .get('e-facts').n;
        rawDb4.close();
        check(svcCountAfterDup === 2, '🔴 Duplikat-Report hat zusätzliche Fact-Zeilen erzeugt');

        // Fact-Zeilen überleben das Prunen der Metadaten-Zeile: die 30-Tage-Regel gilt
        // NUR für health_share_reports, die Fakten-Tabellen bleiben bewusst unbegrenzt
        // erhalten (Konzept-Entscheidung 2026-08-15).
        const vor31TagenFacts = Date.now() - 31 * 24 * 60 * 60 * 1000;
        recordReport({
            eventId: 'e-facts-uralt', pubkeyHex: FACTS, receivedAt: vor31TagenFacts,
            services: [{ serviceId: 'forge-nexus', statusCounts: { ok: 1, warn: 0, crit: 0, unknown: 0 } }],
        }, { dbPath });
        listParticipants({ dbPath }); // löst pruneOldReports() aus (Metadaten, nicht Fakten)
        const rawDb5 = new Database(dbPath);
        const metaWeg = rawDb5.prepare(`SELECT COUNT(*) AS n FROM health_share_reports WHERE event_id = ?`).get('e-facts-uralt').n;
        const factsBleiben = rawDb5.prepare(`SELECT COUNT(*) AS n FROM health_share_service_facts WHERE report_event_id = ?`)
            .get('e-facts-uralt').n;
        rawDb5.close();
        check(metaWeg === 0, '🔴 31 Tage alte Metadaten-Zeile wurde nicht geprunt');
        check(factsBleiben === 1, '🔴 Fact-Zeile wurde fälschlich mitgeprunt (soll unbegrenzt erhalten bleiben)');
    } finally {
        fs.rmSync(dbPath, { force: true });
    }

    return { ok: failures.length === 0, failures };
}
