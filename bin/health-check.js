#!/usr/bin/env node
/**
 * FORGE Health Check
 *
 * Prüft alle konfigurierten Dienste (intern + extern) und schreibt:
 *   - FORGE/data/health.db                 (SQLite, 7-Tage-Retention)
 *   - FORGE/html/data/health-status.json   (Dashboard-Export, jede Minute gesynct)
 *
 * Cron: *\/5 * * * * node /opt/forge/app/bin/health-check.js
 */

import { execSync }              from 'child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join }           from 'path';
import { fileURLToPath }           from 'url';
import Database                    from 'better-sqlite3';
import { PATHS, envFile }          from '../config/paths.js';
import { listJobs }                from '../lib/cron-registry.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = join(__dirname, '..');

// Minimaler .env-Parser (kein dotenv nötig)
function loadEnv(envPath) {
    try {
        for (const line of readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
            if (m && !process.env[m[1]]) {
                process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
            }
        }
    } catch { /* .env nicht vorhanden – ignorieren */ }
}
loadEnv(envFile('nexus'));

const HELIUS_API_KEY  = process.env.HELIUS_API_KEY    ?? '';
const HELIUS_RPC_URL  = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN ?? '';

// ── Konfiguration laden ────────────────────────────────────────────────────────
const { chains, RETENTION_DAYS } = await import('../config/health-config.js');

// ── DB Setup ──────────────────────────────────────────────────────────────────
const db = new Database(PATHS.healthDb);
db.exec(`
    CREATE TABLE IF NOT EXISTS health_checks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id   TEXT    NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        status       TEXT    NOT NULL,
        latency_ms   INTEGER,
        detail       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_st ON health_checks(service_id, timestamp_ms);
`);

const INSERT = db.prepare(
    `INSERT INTO health_checks (service_id, timestamp_ms, status, latency_ms, detail)
     VALUES (?, ?, ?, ?, ?)`
);

// ── Check-Funktionen ──────────────────────────────────────────────────────────

// Ein gestoppter Dienst ist nicht automatisch ein kaputter Dienst. `systemctl
// is-active` beendet sich bei allem außer 'active' mit Exit ≠ 0, landet also im
// catch — dadurch wurde JEDER angehaltene Bot als 'error' gewertet und löste den
// Alarm "… nicht erreichbar. Bitte den betroffenen Dienst neu starten" aus, auch
// wenn der Nutzer ihn selbst angehalten hatte (belegt 2026-08-07 auf einem Testhost:
// zweimal für einen bewusst gestoppten Liquidity Bot). Beim Endnutzer ist das
// Anhalten eines Bots ein völlig normaler Vorgang (Pause, kein Kapital im Einsatz).
//
// systemd trennt die Fälle selbst sauber: 'failed' = der Dienst ist gescheitert
// (Crash, Startfehler, Restart-Limit erreicht) → alarmwürdig. 'inactive' = sauber
// beendet → Hinweis, kein Alarm. Die Übergangszustände 'activating'/'deactivating'
// sind Momentaufnahmen eines laufenden Starts/Stopps und nie ein Befund.
//
// Ein Tippfehler in svc.id (health-config.js) liefert über ActiveState EBENFALLS
// 'inactive' – von "bewusst gestoppt" allein damit nicht unterscheidbar (verifiziert
// 2026-08-09). LoadState trennt das zuverlässig: 'not-found' = die Unit existiert
// nicht (Konfigurationsfehler, sofort alarmwürdig), 'loaded' = sie existiert und ist
// nur gerade nicht aktiv. Ein zweiter Wert aus demselben `systemctl show`-Aufruf,
// kein zusätzlicher Prozessstart nötig.
function checkSystemd(serviceId) {
    let activeState = 'unknown';
    let loadState   = 'unknown';
    try {
        // Bewusst OHNE --value: `systemctl show` gibt Properties in seiner eigenen
        // internen Reihenfolge aus, nicht in der der -p-Flags (verifiziert 2026-08-09,
        // LoadState kam vor ActiveState obwohl in umgekehrter Reihenfolge angefragt) –
        // eine positionale Zuordnung wäre also stillschweigend falsch gewesen. Die
        // KEY=value-Form macht die Zuordnung robust gegen die Ausgabereihenfolge.
        const raw = execSync(
            `systemctl show ${serviceId} -p ActiveState -p LoadState`,
            { timeout: 5000, encoding: 'utf8' },
        );
        for (const line of raw.trim().split('\n')) {
            const [key, value] = line.split('=');
            if (key === 'ActiveState') activeState = value;
            if (key === 'LoadState')   loadState   = value;
        }
    } catch (e) {
        activeState = (e.stdout ?? '').trim() || (e.stderr ?? '').trim() || 'unknown';
    }
    if (loadState === 'not-found') {
        return { status: 'error', latency_ms: null, detail: `Unit "${serviceId}" existiert nicht – Konfigurationsfehler in health-config.js prüfen` };
    }
    if (activeState === 'active')                                  return { status: 'ok',   latency_ms: null, detail: activeState };
    if (activeState === 'activating' || activeState === 'deactivating') return { status: 'ok', latency_ms: null, detail: activeState };
    if (activeState === 'inactive') {
        return { status: 'warn', latency_ms: null, detail: 'angehalten – läuft erst nach einem Start wieder' };
    }
    // 'failed' und alles Unerwartete ('unknown', leer, Fehlertext): echter Befund.
    return { status: 'error', latency_ms: null, detail: activeState === 'failed' ? 'abgestürzt/gescheitert' : activeState };
}

async function checkHttp(url, method = 'GET') {
    const t0 = Date.now();
    try {
        const res = await fetch(url, {
            method,
            signal:   AbortSignal.timeout(12000),
            redirect: 'follow',
            headers:  { 'User-Agent': 'FORGE-HealthCheck/1.0' },
        });
        const lat = Date.now() - t0;
        // 2xx/3xx/4xx = Dienst erreichbar; 5xx = Dienst hat Probleme
        const status = res.status < 500 ? 'ok' : 'warn';
        return { status, latency_ms: lat, detail: `HTTP ${res.status}` };
    } catch (e) {
        const lat = Date.now() - t0;
        const msg = e.message?.slice(0, 80) ?? 'timeout';
        return { status: 'error', latency_ms: lat, detail: msg };
    }
}

async function checkHeliusRpc() {
    if (!HELIUS_API_KEY) {
        return { status: 'warn', latency_ms: null, detail: 'HELIUS_API_KEY nicht konfiguriert' };
    }
    const t0 = Date.now();
    try {
        const res  = await fetch(HELIUS_RPC_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
            signal:  AbortSignal.timeout(7000),
        });
        const data = await res.json();
        const lat  = Date.now() - t0;
        const ok   = data?.result === 'ok';
        return { status: ok ? 'ok' : 'warn', latency_ms: lat, detail: data?.result ?? `HTTP ${res.status}` };
    } catch (e) {
        return { status: 'error', latency_ms: Date.now() - t0, detail: e.message?.slice(0, 80) ?? 'timeout' };
    }
}

async function checkTelegram() {
    if (!TELEGRAM_TOKEN) {
        return { status: 'warn', latency_ms: null, detail: 'TELEGRAM_BOT_TOKEN nicht konfiguriert' };
    }
    const t0 = Date.now();
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`, {
            signal: AbortSignal.timeout(7000),
        });
        const lat = Date.now() - t0;
        return { status: res.ok ? 'ok' : 'warn', latency_ms: lat, detail: `HTTP ${res.status}` };
    } catch (e) {
        return { status: 'error', latency_ms: Date.now() - t0, detail: e.message?.slice(0, 80) ?? 'timeout' };
    }
}

// ── Nostr-Relay-Status ────────────────────────────────────────────────────────
// Kein eigener WS-Connect: core/premium (forge-premium) hält die Relay-Verbindung
// für das Message Center ohnehin dauerhaft offen und protokolliert ihren Zustand
// bereits (lib/nostr-stats.js). Ein einziger lokaler HTTP-Call pro Lauf reicht,
// um den Status aller Relays abzufragen – Ergebnis wird für den Lauf gecacht,
// damit nicht pro Relay erneut abgefragt wird.
let _nostrStatsCache;
async function fetchNostrRelayStats() {
    if (_nostrStatsCache !== undefined) return _nostrStatsCache;
    try {
        const res = await fetch('http://127.0.0.1:3110/nostr/stats', { signal: AbortSignal.timeout(3000) });
        _nostrStatsCache = res.ok ? (await res.json()).relays ?? {} : {};
    } catch {
        _nostrStatsCache = {};
    }
    return _nostrStatsCache;
}

async function checkNostrRelay(relayUrl) {
    const stats = await fetchNostrRelayStats();
    const s = stats[relayUrl.replace(/\/+$/, '')];
    if (!s) {
        return { status: 'unknown', latency_ms: null, detail: 'Keine Daten von forge-premium (Dienst down oder gerade erst gestartet)' };
    }
    return {
        status:     s.currentlyConnected ? 'ok' : 'error',
        latency_ms: null,
        detail:     s.currentlyConnected
            ? `Verbunden (Uptime 7 Tage: ${s.uptimePct ?? '–'}%)`
            : `Getrennt (${s.disconnectCount} Abbrüche seit Beobachtungsbeginn)`,
    };
}

// ── Premium-Host-Status (z.B. Filebase) ──────────────────────────────────────────
// Kein eigener Check-Request: lib/blob-storage.js protokolliert bei jedem ohnehin
// stattfindenden Upload-Versuch (publish-blob.js, alle 10 Min) Erfolg/Fehlschlag in
// premium.db – hier wird nur gelesen, 0 zusätzliche Requests gegen den Host selbst.
const HOST_STATUS_STALE_MS = 25 * 60 * 1000; // > 2 verpasste Publish-Läufe = Publish-Loop steht vermutlich

function checkPremiumHostStatus(hostKey) {
    try {
        const pdb = new Database(PATHS.premiumDb, { readonly: true, fileMustExist: true });
        const row = pdb.prepare(`SELECT ok, checked_at, detail FROM premium_host_status WHERE host = ?`).get(hostKey);
        pdb.close();
        if (!row) {
            return { status: 'unknown', latency_ms: null, detail: 'Noch kein Upload-Versuch protokolliert' };
        }
        const ageMin = Math.round((Date.now() - row.checked_at) / 60000);
        if (Date.now() - row.checked_at > HOST_STATUS_STALE_MS) {
            return { status: 'unknown', latency_ms: null, detail: `Letzter Versuch vor ${ageMin} Min – Publish-Loop läuft vermutlich nicht` };
        }
        return {
            status: row.ok ? 'ok' : 'error',
            latency_ms: null,
            detail: row.ok ? `Letzter Upload erfolgreich (vor ${ageMin} Min)` : (row.detail ?? 'Upload fehlgeschlagen'),
        };
    } catch (e) {
        return { status: 'unknown', latency_ms: null, detail: `premium.db nicht lesbar: ${e.message?.slice(0, 60)}` };
    }
}

// ── Premium-Ingest-Status (Fork-Seite) ───────────────────────────────────────────
// Gegenstück zu checkPremiumHostStatus: dort protokolliert der Master den Upload,
// hier liest der Fork den Erfolg des eigenen Empfangs. Quelle ist
// premium_ingest_state.last_ingested_at (bots/liquidity/lib/premium-ingest.js),
// von ingestBlob() bei jeder erfolgreichen Integration aktualisiert – kein
// zusätzlicher Request, reines Auslesen. Vorfall 2026-08-01: `forge-premium` verlor
// auf forge-pub1 lautlos den Empfang (WebSocket blieb verbunden, Relay lieferte
// nur nichts mehr) – weder der systemd-Status noch der bestehende nostr_relay-Check
// (reiner Verbindungsstatus, siehe lib/nostr-stats.js) hätten das erkannt. Dieser
// Check bildet stattdessen die tatsächliche Nutzdaten-Frische ab, die auch den
// "Score-Daten veraltet"-Banner im Liquidity-Bot-Dashboard steuert.
const INGEST_STALE_MS = 25 * 60 * 1000; // > 2 verpasste 10-Min-Publish-Läufe

// Ausbleibende Daten haben zwei grundverschiedene Ursachen, die vor dem 2026-08-09
// beide denselben "Dienst antwortet nicht mehr, bitte neu starten"-Alarm auslösten:
//
//   (a) Es wurde für die laufende Stunde nicht bezahlt. Dann liefert der Master
//       bestimmungsgemäß nichts (core/premium/deliver-blob.js beliefert nur Zahler
//       der Stunde). Nichts ist kaputt, ein Neustart ändert daran nichts — der
//       Nutzer muss zahlen/aufladen/einschalten. Vorfall forge-pub1 2026-08-09: der
//       Deploy-Lock verwarf den premium-pay-Cronslot, eine Stunde blieb unbezahlt,
//       und der Alarm schickte die Fehlersuche in den Nostr-Stack statt in den
//       Zahlungspfad. Für einen echten Kunden ist das der Normalfall (leeres
//       Guthaben) und dürfte NIE als Dienstausfall gemeldet werden.
//   (b) Es wurde bezahlt und trotzdem kam nichts an. Erst das ist ein echter
//       Zustellungsfehler (Nostr-Subscription, Relay, Master) und alarmwürdig.
//
// Die Zahlungslage kommt aus denselben Quellen wie beim Zahl-Skript selbst:
// premium_pay_log (core/premium/premium-pay.js, hour_id = laufende Abrechnungsstunde)
// und die beiden unabhängigen Schalter aus lib/premium-auto-pay-store.js. Beide
// werden hier bewusst READONLY gelesen — ein Health-Check darf niemals ein Schema
// anlegen oder ändern, deshalb keine Store-Importe (openDb() dort schreibt).
function readPaymentState(hourId) {
    const state = { paidThisHour: false, autoPayEnabled: null, outagePaused: false };
    try {
        const db = new Database(PATHS.premiumDb, { readonly: true, fileMustExist: true });
        try {
            state.paidThisHour = !!db.prepare(`SELECT 1 FROM premium_pay_log WHERE hour_id = ?`).get(hourId);
        } catch { /* Tabelle existiert erst nach der ersten Zahlung */ }
        db.close();
    } catch { /* premium.db (noch) nicht vorhanden – wie "nie bezahlt" behandeln */ }
    try {
        const db = new Database(PATHS.settingsDb, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare(`SELECT enabled, outage_paused FROM premium_settings WHERE id = 1`).get();
            state.autoPayEnabled = row?.enabled === 1;
            state.outagePaused   = row?.outage_paused === 1;
        } catch { /* Tabelle/Spalte erst nach der ersten Aktivierung vorhanden */ }
        db.close();
    } catch { /* settings.db nicht lesbar – Zahlungslage bleibt unbekannt */ }
    return state;
}

function checkPremiumIngestStatus() {
    try {
        const db = new Database(PATHS.liquidityDb, { readonly: true, fileMustExist: true });
        let row;
        try {
            row = db.prepare(`SELECT last_ingested_at FROM premium_ingest_state WHERE id = 1`).get();
        } catch {
            row = undefined; // Tabelle existiert erst nach dem ersten Ingest-Lauf
        }
        db.close();
        if (!row?.last_ingested_at) {
            return { status: 'unknown', latency_ms: null, detail: 'Noch kein Premium-Blob integriert' };
        }
        const ageMin = Math.round((Date.now() - row.last_ingested_at) / 60000);
        if (Date.now() - row.last_ingested_at <= INGEST_STALE_MS) {
            return { status: 'ok', latency_ms: null, detail: `Letzter Ingest erfolgreich (vor ${ageMin} Min)` };
        }

        // Ab hier: Daten sind veraltet – die Ursache entscheidet über den Status.
        // 'warn' statt 'error' überall dort, wo kein Defekt vorliegt: nur 'error'
        // löst den Persistenz-Alert aus (siehe isSecondConsecutiveError unten).
        const { paidThisHour, autoPayEnabled, outagePaused } = readPaymentState(Math.floor(Date.now() / 3_600_000));

        if (outagePaused) {
            return { status: 'error', latency_ms: null, detail: `Letzter Ingest vor ${ageMin} Min – der Premium-Dienst des Anbieters gilt seit über 2h als nicht erreichbar, die Zahlung wurde automatisch pausiert. Nichts zu tun: sie läuft von selbst wieder an, sobald Daten ankommen.` };
        }
        if (autoPayEnabled === false) {
            return { status: 'warn', latency_ms: null, detail: `Letzter Ingest vor ${ageMin} Min – die automatische Zahlung ist ausgeschaltet, ohne sie liefert der Anbieter keine Premium-Daten. Einschalten unter Liquidity → Premium → Verwalten.` };
        }
        if (!paidThisHour) {
            return { status: 'warn', latency_ms: null, detail: `Letzter Ingest vor ${ageMin} Min – für die laufende Stunde liegt keine Zahlung vor, deshalb liefert der Anbieter keine Daten. Premium-Guthaben prüfen und ggf. USDC nachfüllen (Liquidity → Premium → Verwalten).` };
        }
        return { status: 'error', latency_ms: null, detail: `Letzter Ingest vor ${ageMin} Min, obwohl die laufende Stunde bezahlt ist – der Zustellweg ist gestört. Log von forge-premium prüfen (Nostr-Empfang).` };
    } catch (e) {
        return { status: 'unknown', latency_ms: null, detail: `liquiditybot.db nicht lesbar: ${e.message?.slice(0, 60)}` };
    }
}

async function checkService(svc) {
    switch (svc.type) {
        case 'systemd':    return checkSystemd(svc.id);
        case 'http':       return checkHttp(svc.url, svc.method ?? 'GET');
        case 'helius_rpc': return checkHeliusRpc();
        case 'telegram':   return checkTelegram();
        case 'nostr_relay': return checkNostrRelay(svc.relayUrl);
        case 'premium_host_status': return checkPremiumHostStatus(svc.hostKey);
        case 'premium_ingest_status': return checkPremiumIngestStatus();
        default:
            return { status: 'unknown', latency_ms: null, detail: `Unbekannter Typ: ${svc.type}` };
    }
}

// ── Nexus-Statistiken abrufen ─────────────────────────────────────────────────
// Läuft auf dem lokalen Server → Nexus direkt per localhost erreichbar
async function fetchNexusStats() {
    try {
        const res = await fetch('http://127.0.0.1:3100/health', { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const d = await res.json();
        return {
            uptime_sec:            d.uptime                       ?? null,
            rpc_hit_rate_pct:      d.rpcCache?.hitRatePct         ?? null,
            rpc_projected_monthly: d.rpcCache?.projectedMonthly   ?? null,
            rpc_entries:           d.rpcCache?.entries            ?? null,
            rpc_near_budget:       d.rpcCache?.nearBudget         ?? false,
            rpc_over_budget:       d.rpcCache?.overBudget         ?? false,
            jupiter_circuit:       d.jupiterCircuit               ?? null,
            tx_queue:              d.txQueue                      ?? null,
            rate_limits:           d.limits                       ?? null,
        };
    } catch {
        return null;
    }
}

// ── Alert bei persistentem Ausfall ────────────────────────────────────────────
// Sendet eine Nachricht an Nexus (→ Telegram) wenn ein Dienst 2 Checks in Folge
// nicht erreichbar ist (≈ 10 Minuten). Alert wird nur einmal pro Ausfall gesendet
// (Übergang: Check[n-1]=ok → Check[n]=error → Check[n+1]=error).
// `kind` trennt zwei Meldungsarten, die bis 2026-08-09 denselben Text bekamen:
// ein Wartungsjob ist kein Dienst, "nicht erreichbar … neu starten" ist dort
// schlicht falsch (es gibt nichts zum Neustarten, der Job läuft beim nächsten
// Intervall ohnehin wieder). Zusätzlich stand statt eines Namens die rohe ID
// im Titel ("cron:pool-offers-sync") – für den Adressaten unbrauchbar.
async function sendPersistenceAlert(svcName, detail, { kind = 'service' } = {}) {
    try {
        const msg = kind === 'cron'
            ? `🚨 *Wartungsjob „${svcName}" schlägt seit ~10 Min. fehl*\n`
              + `Detail: ${detail ?? 'kein Grund protokolliert'}\n`
              + `Der Job versucht es im nächsten Intervall automatisch erneut. Hält der Fehler an, `
              + `im Dashboard unter Health das Protokoll des Jobs prüfen.`
            : `🚨 *${svcName} seit ~10 Min. nicht erreichbar*\n`
              + `Detail: ${detail ?? 'Timeout'}\n`
              + `Der Dienst antwortet nicht mehr. Bitte im Dashboard unter Health prüfen und `
              + `den betroffenen Dienst neu starten.`;
        const res = await fetch('http://127.0.0.1:3100/notify', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            // botId ist Pflichtfeld in Nexus (POST /notify antwortet sonst mit HTTP 400).
            // Es fehlte hier — die Health-Alerts sind also seit Einführung nie
            // angekommen, der fehlende Response-Check hat das verdeckt (2026-07-30).
            body:    JSON.stringify({
                botId:       'health-check',
                displayName: 'Monitoring',
                level:       'error',
                category:    'system',
                message:     msg,
            }),
            signal:  AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            console.warn(`[health] Alert abgelehnt (${svcName}): HTTP ${res.status} – ${await res.text()}`);
            return;
        }
        console.log(`[health] Alert gesendet: ${svcName}`);
    } catch (e) {
        console.warn(`[health] Alert nicht gesendet (${svcName}): ${e.message}`);
    }
}

// ── Cron-Jobs: data/cron-state.json (von bin/forge-cron.js geschrieben) ────────
// forge-cron.js protokolliert pro Job den letzten Exit-Code, aber bislang wertete
// das niemand aus – ein dauerhaft mit Exit 1 fehlschlagender Job (z.B. wegen einer
// falschen Datei-Ownership) blieb dadurch unbemerkt (Fund 2026-08-06, forge-pub2:
// wallet-monitor lief 2 Tage lang alle 10 Min erfolglos, bevor die Wallet-Balance-
// Anzeige im Dashboard das erste sichtbare Symptom war). Dynamisch über alle Jobs
// statt hartcodierter Liste – ein neuer Cron-Job in config/cron-jobs.json wird so
// automatisch mitüberwacht.
function checkCronJobs() {
    // PATHS.data statt join(FORGE_ROOT,'data') (Fund 2026-08-09, Nachzügler zum
    // selben Fix in bin/forge-cron.js): auf dem FORGE.pub-Fork ist FORGE_ROOT der
    // APP_DIR-Checkout, der bei jedem Update komplett neu geschrieben wird und dort
    // NIE ein data/-Verzeichnis besitzt – forge-cron.js schreibt cron-state.json
    // längst unter PATHS.data (<base>/local/data). Der alte Pfad lieferte auf dem
    // Fork also immer ENOENT → catch → {} → "kein Befund". Damit war die gesamte
    // Cron-Überwachung dort seit dem 09.08. lautlos wirkungslos, inklusive des
    // wallet-monitor-Dauerfehlers vom 2026-08-06, der diesen Mechanismus erst
    // motiviert hat. Auf dem Master identisch zum alten Pfad, kein Verhaltensunterschied.
    const stateFile = join(PATHS.data, 'cron-state.json');
    let state;
    try {
        state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
        return {}; // Runner noch nie gelaufen o.ä. – kein Befund, keine Fehlalarme
    }
    const results = {};
    for (const [jobId, s] of Object.entries(state)) {
        if (!s || typeof s.lastExitCode !== 'number') continue;
        results[`cron:${jobId}`] = s.lastExitCode === 0
            ? { status: 'ok', latency_ms: s.lastDurationMs ?? null, detail: null, jobId }
            : { status: 'error', latency_ms: s.lastDurationMs ?? null,
                detail: s.lastError ?? `Exit ${s.lastExitCode}`, jobId };
    }
    return results;
}

// ── Hauptlauf ─────────────────────────────────────────────────────────────────
const now    = Date.now();
const latest = {};

for (const chain of chains) {
    if (chain.placeholder) continue;
    for (const svc of chain.services) {
        const result = await checkService(svc);
        INSERT.run(svc.id, now, result.status, result.latency_ms ?? null, result.detail ?? null);
        latest[svc.id] = result;

        const latStr = result.latency_ms != null ? `${result.latency_ms}ms` : '    –';
        console.log(`[health] ${svc.id.padEnd(26)} ${result.status.padEnd(7)} ${latStr}`);
    }
}

for (const [svcId, result] of Object.entries(checkCronJobs())) {
    INSERT.run(svcId, now, result.status, result.latency_ms ?? null, result.detail ?? null);
    latest[svcId] = result;
    const latStr = result.latency_ms != null ? `${result.latency_ms}ms` : '    –';
    console.log(`[health] ${svcId.padEnd(26)} ${result.status.padEnd(7)} ${latStr}`);
}

// ── Persistenz-Alerts prüfen ──────────────────────────────────────────────────
// Für jeden Dienst der gerade 'error' hat: letzte 3 DB-Einträge prüfen.
// Alert wenn: Check[0]=error, Check[1]=error, Check[2]≠error (genau 2. Fehler in Folge).
function isSecondConsecutiveError(svcId) {
    const last3 = db.prepare(`
        SELECT status FROM health_checks
        WHERE service_id = ?
        ORDER BY timestamp_ms DESC LIMIT 3
    `).all(svcId);
    return last3.length >= 2 &&
        last3[0].status === 'error' &&
        last3[1].status === 'error' &&
        (last3[2]?.status !== 'error');
}

for (const chain of chains) {
    if (chain.placeholder) continue;

    // Sonderfall Nostr: eine Relay-Liste ist per Design redundant – ein einzelner
    // ausgefallener Relay ist normal und kein Alarmgrund. Nur wenn ALLE Relays
    // gleichzeitig anhaltend getrennt sind, ist Nostr für FORGE tatsächlich
    // funktionsunfähig (Message Center/Premium-Auslieferung) und damit alarmwürdig.
    if (chain.id === 'nostr') {
        if (!chain.services.length) continue;
        const allDown = chain.services.every(svc => latest[svc.id]?.status === 'error');
        if (allDown && chain.services.every(svc => isSecondConsecutiveError(svc.id))) {
            await sendPersistenceAlert(
                'Nostr (alle Relays)',
                'Alle konfigurierten Relays gleichzeitig nicht verbunden – Message Center und Premium-Auslieferung sind funktionsunfähig.'
            );
        }
        continue;
    }

    for (const svc of chain.services) {
        if (latest[svc.id]?.status !== 'error') continue;
        if (isSecondConsecutiveError(svc.id)) {
            await sendPersistenceAlert(svc.name, latest[svc.id].detail);
        }
    }
}

// Cron-Jobs laufen typischerweise alle 5-10 Min – "2 Fehlschläge in Folge" fällt
// hier je nach Job-Intervall zusammen mit denselben ~10-20 Min wie bei den
// regulären Diensten oben.
//
// description statt roher jobId im Alertext (Fund 2026-08-09): "cron:pool-offers-sync"
// sagt einem Endnutzer nichts, config/cron-jobs.json hat für jeden Job längst einen
// verständlichen description-Text. kind:'cron' sorgt für den passenden Meldungstext
// (kein "Dienst neu starten" für einen Job, der beim nächsten Intervall ohnehin
// wieder anläuft, siehe sendPersistenceAlert oben).
const cronDescriptions = Object.fromEntries(listJobs().map(j => [j.id, j.description ?? j.id]));
for (const [svcId, result] of Object.entries(latest)) {
    if (!svcId.startsWith('cron:') || result.status !== 'error') continue;
    if (isSecondConsecutiveError(svcId)) {
        const jobId = result.jobId ?? svcId.slice('cron:'.length);
        await sendPersistenceAlert(cronDescriptions[jobId] ?? jobId, result.detail, { kind: 'cron' });
    }
}

// Alte Einträge löschen (> RETENTION_DAYS)
const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const pruned = db.prepare('DELETE FROM health_checks WHERE timestamp_ms < ?').run(now - retentionMs);
if (pruned.changes > 0) {
    console.log(`[health] ${pruned.changes} alte Einträge gelöscht (> ${RETENTION_DAYS} Tage)`);
}

// ── History aggregieren (letzte 7 Tage, stündlich) ───────────────────────────
const HISTORY_HOURS = RETENTION_DAYS * 24;
const historyFrom   = now - HISTORY_HOURS * 60 * 60 * 1000;

const historyRows = db.prepare(`
    SELECT
        service_id,
        (timestamp_ms / 3600000) * 3600000                        AS hour_bucket,
        COUNT(*)                                                    AS total,
        SUM(CASE WHEN status = 'ok'    THEN 1 ELSE 0 END)          AS ok_count,
        SUM(CASE WHEN status = 'warn'  THEN 1 ELSE 0 END)          AS warn_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)          AS error_count
    FROM health_checks
    WHERE timestamp_ms >= ?
    GROUP BY service_id, hour_bucket
    ORDER BY service_id, hour_bucket ASC
`).all(historyFrom);

// Nach service_id gruppieren und Stunden-Status berechnen
const historyByService = {};
for (const row of historyRows) {
    if (!historyByService[row.service_id]) historyByService[row.service_id] = [];

    // Stunden-Status: >= 80% ok → grün, 20–79% → gelb, < 20% → rot
    const pct        = row.ok_count / row.total;
    const hourStatus = pct >= 0.8 ? 'ok' : pct >= 0.2 ? 'warn' : 'error';

    historyByService[row.service_id].push({
        ts:    row.hour_bucket,
        s:     hourStatus,   // 's' spart ~1 KB im JSON bei 168 × n Services
        total: row.total,
        ok:    row.ok_count,
    });
}

// ── Nexus-Stats abrufen ────────────────────────────────────────────────────────
const nexusStats = await fetchNexusStats();

// ── JSON Export ───────────────────────────────────────────────────────────────
const payload = {
    generated_at: now,
    chains: chains.map(chain => ({
        id:          chain.id,
        label:       chain.label,
        placeholder: chain.placeholder ?? false,
        services:    chain.services.map(svc => ({
            id:          svc.id,
            name:        svc.name,
            description: svc.description ?? null,
            bots:        svc.bots        ?? [],
            status:      latest[svc.id]?.status     ?? 'unknown',
            latency_ms:  latest[svc.id]?.latency_ms ?? null,
            detail:      latest[svc.id]?.detail     ?? null,
            history:     historyByService[svc.id]   ?? [],
        })),
    })),
    nexus: nexusStats,
};

const outPath = join(FORGE_ROOT, 'html', 'data', 'health-status.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload));
console.log(`[health] JSON exportiert → html/data/health-status.json`);
