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
import { writeFileSync, readFileSync, mkdirSync, statfsSync } from 'fs';
import { dirname, join }           from 'path';
import { fileURLToPath }           from 'url';
import Database                    from 'better-sqlite3';
import { PATHS, envFile }          from '../config/paths.js';
import { listJobs }                from '../lib/cron-registry.js';
import { t, getLang, numLocale }   from '../lib/i18n.js';
import { renderNotification }      from '../lib/notify-render.js';

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

    -- Wenige, langlebige Einzelwerte, die ein Lauf dem nächsten hinterlässt (derzeit
    -- nur der zuletzt gesehene OOM-Zähler, siehe checkHostOom). Bewusst kein Eintrag
    -- in health_checks: das ist eine Messreihe mit 7-Tage-Retention, ein Ausgangswert
    -- darf davon nicht mit weggeräumt werden.
    CREATE TABLE IF NOT EXISTS host_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
`);

// mem_bytes / restarts / uptime_sec (2026-08-13, Systemdaten-Freigabe):
// Pro-Prozess-Speicher ist die Messgrundlage für
// das Refactoring vor 1.0. Nur checkSystemd() füllt diese drei Spalten, alle übrigen
// Check-Typen lassen sie NULL. Zusätzliche Spalten statt neuer Tabelle: bleibt in
// derselben Zeile wie status/detail, kein JOIN nötig für den späteren Aggregator.
const healthCols = db.prepare('PRAGMA table_info(health_checks)').all().map(c => c.name);
if (!healthCols.includes('mem_bytes'))  db.exec('ALTER TABLE health_checks ADD COLUMN mem_bytes  INTEGER');
if (!healthCols.includes('restarts'))   db.exec('ALTER TABLE health_checks ADD COLUMN restarts   INTEGER');
if (!healthCols.includes('uptime_sec')) db.exec('ALTER TABLE health_checks ADD COLUMN uptime_sec INTEGER');
// detail_code (Mehrsprachigkeit): `detail` ist jetzt übersetzter Anzeigetext, kann
// also nicht mehr per Regex auf feste deutsche Formulierungen klassifiziert werden
// (siehe classifyDetailCode() in lib/health-report.js — das war bis hierhin ein
// stiller Vertrag auf exakten deutschen Text). Jede Check-Funktion liefert den Code
// deshalb jetzt selbst mit, an der Quelle statt nachträglich aus Text geraten.
// Altbestand (Zeilen ohne diese Spalte/ohne Wert) fällt in buildHealthReport() auf
// classifyDetailCode() zurück – die dortigen Regexes bleiben als Fallback bestehen,
// weil ältere Zeilen ausschließlich deutschen Text enthalten.
if (!healthCols.includes('detail_code')) db.exec('ALTER TABLE health_checks ADD COLUMN detail_code TEXT');

const INSERT = db.prepare(
    `INSERT INTO health_checks (service_id, timestamp_ms, status, latency_ms, detail, mem_bytes, restarts, uptime_sec, detail_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
//
// Dritter Wert aus demselben Aufruf: UnitFileState trennt "gerade angehalten" von
// "dauerhaft abgeschaltet". Ein Stopp über die Oberfläche macht nur `systemctl stop`
// (bots/settings/bin/bot-control-daemon.js), die Unit bleibt dabei 'enabled' und
// startet beim nächsten Systemstart wieder — das ist der "angehalten"-Fall. Ist die
// Unit dagegen 'disabled'/'masked', wurde sie bewusst stillgelegt; sie kommt auch
// nach einem Neustart nicht von selbst wieder. Beides als "angehalten" (warn) zu
// melden erzeugte auf einem Host mit dauerhaft abgeschaltetem Bot eine Dauerwarnung
// für einen Zustand, der genau so gewollt ist (belegt 2026-08-13 auf forge-pub2).
// systemd meldet "nicht getrackt" als UINT64_MAX statt als leerem Wert oder 0 – ein Prozess
// ohne Memory-Accounting (MemoryAccounting=no) liefert exakt diese Zahl. Unbemerkt hätte sie
// als 17 Exabyte in jeder Speicher-Auswertung dominiert.
const MEMORY_NOT_SET = '18446744073709551615';

// LIQ#0531: `MemoryCurrent` (cgroup memory.current) zählt den reklamierbaren
// Datei-Cache mit (Seiten, die der Kernel beim Lesen/Schreiben der SQLite-DB im
// RAM hält, aber unter Speicherdruck jederzeit verwirft) – bei einer wachsenden
// DB-Datei sieht das wie ein stetiges Speicherleck aus, ist aber keins. Der
// Liquidity Bot zeigte am 09./10.09.2026 genau dieses Muster: MemoryCurrent
// 113→379 MB, tatsächliche Prozess-RSS (`ps`) aber konstant ~150 MB; laut
// `memory.stat` desselben Cgroups lag der Zuwachs zu ~90 % in `file`, nicht in
// `anon` (belegt per `cat /sys/fs/cgroup<ControlGroup>/memory.stat`). `anon` ist
// der Anteil, den der Kernel NICHT freiwillig zurückgibt (Heap, Stacks, Buffers)
// und damit das richtige Signal für ein echtes Leck. Cgroup v2 vorausgesetzt
// (auf allen vier FORGE-Hosts der Fall); ohne verfügbares `memory.stat` (Cgroup
// v1, fehlende Rechte) fällt die Funktion auf `MemoryCurrent` zurück, damit die
// Messung nicht ganz ausfällt.
function readCgroupAnonBytes(controlGroup) {
    if (!controlGroup) return null;
    try {
        const raw = readFileSync(`/sys/fs/cgroup${controlGroup}/memory.stat`, 'utf8');
        const m = raw.match(/^anon (\d+)$/m);
        return m ? Number(m[1]) : null;
    } catch {
        return null;
    }
}

function parseSystemdProcessMetrics(raw) {
    let memBytes = null, restarts = null, activeEnterMs = null, controlGroup = null;
    for (const line of raw.trim().split('\n')) {
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key   = line.slice(0, idx);
        const value = line.slice(idx + 1);
        if (key === 'ControlGroup') controlGroup = value || null;
        if (key === 'MemoryCurrent' && value && value !== '[not set]' && value !== MEMORY_NOT_SET) {
            const n = Number(value);
            if (Number.isFinite(n)) memBytes = n;
        }
        if (key === 'NRestarts') {
            const n = Number(value);
            if (Number.isFinite(n)) restarts = n;
        }
        // "n/a" (nie aktiv gewesen) oder leer → kein gültiger Zeitstempel, uptime bleibt null.
        // Format ist "Wed 2026-08-12 13:03:22 CEST" – Date.parse() versteht die
        // Zeitzonenkürzel (CEST/CET) NICHT und liefert "Invalid Date" (verifiziert
        // 2026-08-13). Wochentag + Kürzel abschneiden und als lokale Zeit parsen: der
        // Node-Prozess läuft laut OS-Zeitzone ohnehin in Europe/Berlin (verifiziert per
        // `timedatectl`), also derselben Zone wie systemd – lokal geparst matcht daher 1:1.
        if (key === 'ActiveEnterTimestamp' && value && value !== 'n/a') {
            const m = value.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
            const ms = m ? new Date(`${m[1]}T${m[2]}`).getTime() : NaN;
            if (!Number.isNaN(ms)) activeEnterMs = ms;
        }
    }
    const uptimeSec = activeEnterMs != null ? Math.max(0, Math.round((Date.now() - activeEnterMs) / 1000)) : null;
    const anonBytes = readCgroupAnonBytes(controlGroup);
    if (anonBytes != null) memBytes = anonBytes;
    return { memBytes, restarts, uptimeSec };
}

function checkSystemd(serviceId) {
    let activeState = 'unknown';
    let loadState   = 'unknown';
    let unitFileState = 'unknown';
    let processMetrics = { memBytes: null, restarts: null, uptimeSec: null };
    try {
        // Bewusst OHNE --value: `systemctl show` gibt Properties in seiner eigenen
        // internen Reihenfolge aus, nicht in der der -p-Flags (verifiziert 2026-08-09,
        // LoadState kam vor ActiveState obwohl in umgekehrter Reihenfolge angefragt) –
        // eine positionale Zuordnung wäre also stillschweigend falsch gewesen. Die
        // KEY=value-Form macht die Zuordnung robust gegen die Ausgabereihenfolge.
        //
        // MemoryCurrent/NRestarts/ActiveEnterTimestamp (2026-08-13, Systemdaten-Freigabe):
        // an denselben Aufruf angehängt statt einen zweiten `systemctl show` zu starten –
        // kein zusätzlicher Prozess-Spawn. Verifiziert 2026-08-13 auf `business`: alle drei
        // Werte ohne sudo lesbar.
        const raw = execSync(
            `systemctl show ${serviceId} -p ActiveState -p LoadState -p UnitFileState `
            + `-p MemoryCurrent -p ControlGroup -p NRestarts -p ActiveEnterTimestamp`,
            { timeout: 5000, encoding: 'utf8' },
        );
        for (const line of raw.trim().split('\n')) {
            const [key, value] = line.split('=');
            if (key === 'ActiveState')   activeState   = value;
            if (key === 'LoadState')     loadState     = value;
            if (key === 'UnitFileState') unitFileState = value;
        }
        processMetrics = parseSystemdProcessMetrics(raw);
    } catch (e) {
        activeState = (e.stdout ?? '').trim() || (e.stderr ?? '').trim() || 'unknown';
    }
    if (loadState === 'not-found') {
        return { status: 'error', latency_ms: null, detail: t('health_check.systemd_not_found', { serviceId }) };
    }
    // Klartext statt der rohen systemd-Zustände (2026-08-13): dieser Text steht jetzt
    // als Erklärung im Status-Tooltip der Karte — "active" beantwortet dort niemandem
    // die Frage, was gerade los ist.
    if (activeState === 'active')       return { status: 'ok', latency_ms: null, detail: t('health_check.systemd_running'), ...processMetrics };
    if (activeState === 'activating')   return { status: 'ok', latency_ms: null, detail: t('health_check.systemd_starting'), ...processMetrics };
    if (activeState === 'deactivating') return { status: 'ok', latency_ms: null, detail: t('health_check.systemd_stopping'), ...processMetrics };
    if (activeState === 'inactive') {
        if (unitFileState === 'disabled' || unitFileState === 'masked') {
            return { status: 'disabled', latency_ms: null, detail: t('health_check.systemd_disabled'), ...processMetrics };
        }
        return { status: 'warn', latency_ms: null, detail: t('health_check.systemd_stopped'), ...processMetrics };
    }
    // 'failed' und alles Unerwartete ('unknown', leer, Fehlertext): echter Befund.
    // Der rohe activeState-Fallback (kein bekannter systemd-Zustand) bleibt technischer
    // Rohtext – kein Katalogeintrag für jeden denkbaren Zustandsstring.
    return { status: 'error', latency_ms: null, detail: activeState === 'failed' ? t('health_check.systemd_failed') : activeState, ...processMetrics };
}

// Ein `AbortSignal.timeout(n)` feuert normalerweise wenige Millisekunden nach Ablauf
// von n. Kommt der Abbruch stattdessen erst deutlich später, kann das nicht am
// entfernten Dienst liegen — der Timer läuft lokal und unabhängig von ihm. Die
// einzige Erklärung ist, dass unser eigener Prozess in dieser Zeit nicht zum Zug kam:
// blockierter Event-Loop, Speicherdruck, Swap-Thrashing.
//
// Beleg 2026-08-13 auf `business`: zwischen 08:40 und 09:02 lief der Host durch einen
// OOM-Vorfall (Swap restlos voll, OOM-Killer aktiv) minutenweise fest. Der Health-Check
// maß daraufhin 22.888 ms / 104.514 ms gegen ein 12-s-Timeout (Jupiter) und 70.923 ms /
// 99.652 ms gegen ein 7-s-Timeout (Telegram, Helius) — drei voneinander unabhängige
// Anbieter „gleichzeitig ausgefallen". Das löste den Telegram-Alarm „Jupiter API seit
// ~10 Min. nicht erreichbar … den betroffenen Dienst neu starten" aus, obwohl Jupiter
// durchgehend erreichbar war und ein Neustart nichts geändert hätte.
//
// Solche Läufe dürfen deshalb nicht als Dienstausfall gewertet werden: Ergebnis ist
// 'unknown' (Messung ungültig) statt 'error'. 'unknown' fließt nicht in die
// Persistenz-Alerts ein (isSecondConsecutiveError verlangt 'error') und erscheint im
// Dashboard als eigener Zustand — der Ausfall wird also nicht unterdrückt, sondern
// korrekt als „nicht messbar" statt als „Anbieter down" ausgewiesen.
//
// Schwelle absolut statt als Faktor: ein Timer, der 2 s zu spät feuert, ist bereits
// pathologisch, während ein Faktor bei kurzen Timeouts zu grob greift (der reale
// Helius-Fall lag bei 9.937 ms gegen 7 s = Faktor 1,4 und wäre durchgerutscht).
// Echte Anbieter-Ausfälle bleiben unberührt: der Helius-Ausfall vom 2026-08-12
// (05:50–06:15) brach sauber bei 7.001–7.003 ms ab und wird weiterhin als 'error'
// gemeldet.
const STALL_TOLERANCE_MS = 2000;

function classifyTimeout(latencyMs, timeoutMs, message) {
    if (latencyMs > timeoutMs + STALL_TOLERANCE_MS) {
        return {
            status:     'unknown',
            latency_ms: latencyMs,
            detail:     t('health_check.timeout_invalid', {
                            latencyS: (latencyMs / 1000).toFixed(1),
                            timeoutS: timeoutMs / 1000,
                        }),
        };
    }
    return { status: 'error', latency_ms: latencyMs, detail: message };
}

const HTTP_TIMEOUT_MS = 12000;

async function checkHttp(url, method = 'GET') {
    const t0 = Date.now();
    try {
        const res = await fetch(url, {
            method,
            signal:   AbortSignal.timeout(HTTP_TIMEOUT_MS),
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
        return classifyTimeout(lat, HTTP_TIMEOUT_MS, msg);
    }
}

// Gemeinsames Timeout für die beiden Nicht-HTTP-Prüfungen (Helius-RPC, Telegram) –
// als Konstante, damit classifyTimeout dieselbe Zahl sieht, gegen die abgebrochen wurde.
const RPC_TIMEOUT_MS = 7000;

async function checkHeliusRpc() {
    if (!HELIUS_API_KEY) {
        return { status: 'warn', latency_ms: null, detail: t('health_check.helius_key_missing') };
    }
    const t0 = Date.now();
    try {
        const res  = await fetch(HELIUS_RPC_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
            signal:  AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
        const data = await res.json();
        const lat  = Date.now() - t0;
        const ok   = data?.result === 'ok';
        return { status: ok ? 'ok' : 'warn', latency_ms: lat, detail: data?.result ?? `HTTP ${res.status}` };
    } catch (e) {
        return classifyTimeout(Date.now() - t0, RPC_TIMEOUT_MS, e.message?.slice(0, 80) ?? 'timeout');
    }
}

async function checkTelegram() {
    if (!TELEGRAM_TOKEN) {
        return { status: 'warn', latency_ms: null, detail: t('health_check.telegram_token_missing') };
    }
    const t0 = Date.now();
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`, {
            signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
        const lat = Date.now() - t0;
        return { status: res.ok ? 'ok' : 'warn', latency_ms: lat, detail: `HTTP ${res.status}` };
    } catch (e) {
        return classifyTimeout(Date.now() - t0, RPC_TIMEOUT_MS, e.message?.slice(0, 80) ?? 'timeout');
    }
}

// ── Grundfunktionen des Servers ───────────────────────────────────────────────
// Schwellen (Festlegung 2026-08-13). Die Platte hat bewusst ZWEI Kriterien:
// eine reine Prozentschwelle ist auf kleinen Installationen wertlos — 5 % Rest sind
// auf den 15-GB-Pub-VMs nur ~750 MB und damit zu wenig, um noch in Ruhe zu reagieren.
// Es greift, was zuerst zutrifft.
const DISK_WARN_PCT   = 85;
const DISK_ERROR_PCT  = 95;
const DISK_ERROR_FREE = 1024 * 1024 * 1024;  // 1 GB
const MEM_WARN_PCT    = 15;   // verfügbarer Anteil, ab hier wird es eng
const MEM_ERROR_PCT   = 8;
const SWAP_FULL_PCT   = 90;   // Auslagerung praktisch erschöpft → Verschärfung, siehe unten

function fmtBytes(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.round(bytes / 1024)} kB`;
}

function checkHostDisk(path = '/') {
    try {
        const st    = statfsSync(path);
        const total = st.blocks * st.bsize;
        // bavail (für Unprivilegierte verfügbar), nicht bfree: ext4 reserviert 5 % für
        // root, die ein Bot-Prozess nie nutzen kann. bfree würde den Engpass beschönigen.
        const free  = st.bavail * st.bsize;
        const usedPct = total > 0 ? ((total - free) / total) * 100 : 0;
        const metric  = t('health_check.disk_metric', { pct: usedPct.toFixed(0), free: fmtBytes(free) });

        // detailCode explizit (statt später aus dem Text geraten, siehe classifyDetailCode
        // in lib/health-report.js) — Klassifizierung darf nicht von der Anzeigesprache
        // abhängen.
        if (usedPct >= DISK_ERROR_PCT || free < DISK_ERROR_FREE) {
            return { status: 'error', latency_ms: null, metric, detailCode: 'disk_low',
                detail: t('health_check.disk_error', { path, pct: usedPct.toFixed(1), free: fmtBytes(free) }) };
        }
        if (usedPct >= DISK_WARN_PCT) {
            return { status: 'warn', latency_ms: null, metric, detailCode: 'disk_low',
                detail: t('health_check.disk_warn', { path, pct: usedPct.toFixed(1), free: fmtBytes(free) }) };
        }
        return { status: 'ok', latency_ms: null, metric,
                 detail: t('health_check.disk_ok', { path, free: fmtBytes(free), total: fmtBytes(total), pct: usedPct.toFixed(1) }) };
    } catch (e) {
        return { status: 'unknown', latency_ms: null, detail: t('health_check.disk_unreadable', { path, msg: e.message?.slice(0, 60) }) };
    }
}

// MemAvailable statt MemFree: der Kernel gibt Zwischenspeicher (Page Cache) bei Bedarf
// sofort wieder her, MemFree stünde deshalb dauerhaft alarmierend niedrig und wäre als
// Schwellwert unbrauchbar. MemAvailable ist genau die Schätzung des Kernels, wie viel
// ein neuer Prozess tatsächlich noch bekommen kann.
function readMeminfo() {
    const info = {};
    for (const line of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+) kB$/);
        if (m) info[m[1]] = Number(m[2]) * 1024;
    }
    return info;
}

function checkHostMemory() {
    try {
        const info  = readMeminfo();
        const total = info.MemTotal;
        const avail = info.MemAvailable;
        if (!total || avail == null) {
            return { status: 'unknown', latency_ms: null, detail: t('health_check.mem_missing') };
        }
        const availPct = (avail / total) * 100;

        // Die Auslagerungsdatei bekommt bewusst keine eigene Karte: hohe Auslagerung
        // allein ist unauffällig (Linux lagert im Normalbetrieb aus), eine solche Karte
        // stünde dauerhaft auf Gelb ohne Aussage. Kritisch ist erst die Kombination —
        // wenig verfügbarer Speicher UND erschöpfte Auslagerung. Genau dieser Zustand
        // lag am 2026-08-13 um 09:02 vor (Free swap = 8 kB) und ging dem OOM voraus.
        const swapTotal = info.SwapTotal ?? 0;
        const swapUsed  = swapTotal > 0 ? swapTotal - (info.SwapFree ?? 0) : 0;
        const swapPct   = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;
        const swapFull  = swapTotal > 0 && swapPct >= SWAP_FULL_PCT;

        const metric = t('health_check.mem_metric', { pct: availPct.toFixed(0), avail: fmtBytes(avail) })
                     + (swapTotal > 0 ? t('health_check.mem_metric_swap_suffix', { swapPct: swapPct.toFixed(0) }) : '');
        const swapNote = swapFull ? t('health_check.mem_swap_note', { swapPct: swapPct.toFixed(0) }) : '';

        // detailCode explizit (statt später aus dem Text geraten, siehe classifyDetailCode
        // in lib/health-report.js) — Klassifizierung darf nicht von der Anzeigesprache
        // abhängen.
        if (availPct < MEM_ERROR_PCT || (swapFull && availPct < MEM_WARN_PCT)) {
            return { status: 'error', latency_ms: null, metric, detailCode: 'mem_low',
                detail: t('health_check.mem_error', { pct: availPct.toFixed(1), avail: fmtBytes(avail), total: fmtBytes(total), swapNote }) };
        }
        if (availPct < MEM_WARN_PCT) {
            return { status: 'warn', latency_ms: null, metric, detailCode: 'mem_low',
                detail: t('health_check.mem_warn', { pct: availPct.toFixed(1), avail: fmtBytes(avail), total: fmtBytes(total), swapNote }) };
        }
        return { status: 'ok', latency_ms: null, metric,
                 detail: t('health_check.mem_ok', { avail: fmtBytes(avail), total: fmtBytes(total), pct: availPct.toFixed(1) })
                       + (swapTotal > 0 ? t('health_check.mem_ok_swap_suffix', { swapPct: swapPct.toFixed(0) }) : '') };
    } catch (e) {
        return { status: 'unknown', latency_ms: null, detail: t('health_check.mem_unreadable', { msg: e.message?.slice(0, 60) }) };
    }
}

// Der OOM-Zähler ist der einzige Wert hier, der KEINE Momentaufnahme ist – und genau
// darum der wertvollste. Ein Engpass zwischen zwei Prüfungen (alle 5 Min) hinterlässt
// in Speicher- und Plattenwerten keine Spur: danach ist der Speicher ja wieder frei.
// `oom_kill` in /proc/vmstat zählt dagegen kumulativ seit dem Systemstart, ein Vorfall
// geht also nicht verloren. Deshalb wird der zuletzt gesehene Stand persistiert und die
// Differenz gemeldet.
//
// Bewusst /proc/vmstat statt `journalctl -k | grep "Out of memory"`: für jeden Benutzer
// lesbar (der `forge`-Benutzer auf den Pub-Hosts ist nicht in Gruppe 'adm' und sähe vom
// Kernel-Journal nichts), sprachunabhängig und ohne Prozessstart. Gegengeprüft am
// 2026-08-13 auf `business`: Zähler 8, Journal 8 Treffer.
function readHostState(key) {
    try {
        return db.prepare(`SELECT value FROM host_state WHERE key = ?`).get(key)?.value ?? null;
    } catch { return null; }
}

function writeHostState(key, value) {
    db.prepare(`INSERT INTO host_state (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function checkHostOom() {
    let count;
    try {
        const m = readFileSync('/proc/vmstat', 'utf8').match(/^oom_kill (\d+)$/m);
        if (!m) {
            // Vor Kernel 4.13 gibt es das Feld nicht – kein Befund, aber auch keine
            // Zusicherung. 'unknown' sagt das ehrlich, statt Ruhe vorzutäuschen.
            return { status: 'unknown', latency_ms: null, detail: t('health_check.oom_no_counter') };
        }
        count = Number(m[1]);
    } catch (e) {
        return { status: 'unknown', latency_ms: null, detail: t('health_check.oom_unreadable', { msg: e.message?.slice(0, 60) }) };
    }

    const prev  = readHostState('oom_kill_count');
    const prevN = prev === null ? null : Number(prev);
    writeHostState('oom_kill_count', count);

    // Erster Lauf: nur Ausgangswert merken. Ein bereits vor Einführung dieser Prüfung
    // hochgezählter Stand ist keine Neuigkeit und darf nicht rückwirkend alarmieren.
    if (prevN === null) {
        return { status: 'ok', latency_ms: null, metric: t('health_check.oom_metric_total', { count }),
                 detail: t('health_check.oom_baseline', { count }) };
    }

    // Der Zähler wird beim Systemstart zurückgesetzt; ein kleinerer Wert als zuvor
    // bedeutet Neustart, nicht "negative Vorkommnisse".
    if (count < prevN) {
        return { status: 'ok', latency_ms: null, metric: t('health_check.oom_metric_total', { count }),
                 detail: t('health_check.oom_reset', { count }) };
    }

    const delta = count - prevN;
    if (delta > 0) {
        return { status: 'error', latency_ms: null, metric: t('health_check.oom_metric_delta', { delta, count }),
                 detail: t('health_check.oom_delta', { delta, count }) };
    }
    return { status: 'ok', latency_ms: null, metric: t('health_check.oom_metric_total', { count }),
             detail: t('health_check.oom_none', { count }) };
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
        return { status: 'unknown', latency_ms: null, detail: t('health_check.nostr_no_data') };
    }
    // detailCode nur im getrennt-Fall (siehe classifyDetailCode in lib/health-report.js)
    // — Klassifizierung darf nicht von der Anzeigesprache abhängen.
    return {
        status:     s.currentlyConnected ? 'ok' : 'error',
        latency_ms: null,
        detailCode: s.currentlyConnected ? undefined : 'relay_disconnected',
        detail:     s.currentlyConnected
            ? t('health_check.nostr_connected', { uptimePct: s.uptimePct ?? '–' })
            : t('health_check.nostr_disconnected', { count: s.disconnectCount }),
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
            return { status: 'unknown', latency_ms: null, detail: t('health_check.host_status_none') };
        }
        const ageMin = Math.round((Date.now() - row.checked_at) / 60000);
        if (Date.now() - row.checked_at > HOST_STATUS_STALE_MS) {
            return { status: 'unknown', latency_ms: null, detail: t('health_check.host_status_stale', { ageMin }) };
        }
        // row.detail (Fehlschlag-Fall) kommt aus lib/blob-storage.js/publish-blob.js —
        // eigene Quelle außerhalb dieser Datei, hier nicht mit übersetzt.
        return {
            status: row.ok ? 'ok' : 'error',
            latency_ms: null,
            detail: row.ok ? t('health_check.host_status_ok', { ageMin }) : (row.detail ?? t('health_check.host_status_failed')),
        };
    } catch (e) {
        return { status: 'unknown', latency_ms: null, detail: t('health_check.premium_db_unreadable', { msg: e.message?.slice(0, 60) }) };
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

// Zeitschwelle, ab der ein ausbleibender Ingest NICHT mehr als harmloses 'warn'
// durchgeht, sondern als 'error' eskaliert und damit den Telegram-Alert auslöst
// (siehe isSecondConsecutiveError/sendPersistenceAlert unten).
//
// Fund 2026-08-12: Die unten differenzierte warn/error-Trennung ist für die ersten
// Minuten genau richtig, verdeckte aber einen 6,5h-Ausfall auf forge-pub1 fast
// vollständig. Ablauf: ein Helius-Ausfall (05:49–06:16) ließ die stündliche Zahlung
// scheitern; ohne Zahlung liefert der Master bestimmungsgemäß nichts, der Check
// meldete also 2h45 lang nur 'warn' ("für diese Stunde liegt keine Zahlung vor") und
// alarmierte nie. Erst als um 08:35 wieder eine Zahlung durchkam und trotzdem nichts
// ankam, sprang er auf 'error'. Für den Betreiber ist "seit Stunden keine Daten"
// aber unabhängig vom Grund ein meldepflichtiger Zustand — der Grund gehört in den
// Text, nicht in die Entscheidung, ob überhaupt gemeldet wird (Festlegung 2026-08-12).
//
// Bewusst NUR für den Fall "Zahlung eingeschaltet, kommt aber nicht durch": ein
// leeres Guthaben oder ein bewusst ausgeschalteter Schalter meldet dauerhaft
// 'disabled' (siehe autoPayEnabled === false unten; bis 2026-08-13 'warn'). Beides
// ist beim Endnutzer der Normalfall und war 2026-08-09 ausdrücklich als "darf NIE
// als Dienstausfall gemeldet werden" festgelegt — daran ändert diese Eskalation nichts.
const INGEST_ESCALATE_MS = 60 * 60 * 1000; // 1h

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
    const state = { paidThisHour: false, autoPayEnabled: null, outagePaused: false, payFailure: false, sharedCoverage: false };
    let everPaid = false;
    try {
        const db = new Database(PATHS.premiumDb, { readonly: true, fileMustExist: true });
        try {
            state.paidThisHour = !!db.prepare(`SELECT 1 FROM premium_pay_log WHERE hour_id = ?`).get(hourId);
            everPaid           = !!db.prepare(`SELECT 1 FROM premium_pay_log LIMIT 1`).get();
        } catch { /* Tabelle existiert erst nach der ersten Zahlung */ }
        db.close();
    } catch { /* premium.db (noch) nicht vorhanden – wie "nie bezahlt" behandeln */ }

    // Systemdaten-Freigabe (2026-08-13): Daten kommen an, obwohl NIE bezahlt wurde.
    // Der Master liefert nur an Zahler der Stunde oder an freigeschaltete npubs
    // (core/premium/deliver-blob.js) — der Zustand ist damit selbst-belegend. Ohne
    // diese Unterscheidung riete der Monitor einem Freigabe-Teilnehmer, die Zahlung
    // einzuschalten, obwohl sein Zugang gar nicht daran hängt.
    if (!everPaid) {
        try {
            const db = new Database(PATHS.liquidityDb, { readonly: true, fileMustExist: true });
            try {
                state.sharedCoverage = db.prepare(
                    `SELECT last_covered_hour_id AS h FROM premium_ingest_state WHERE id = 1`
                ).get()?.h != null;
            } catch { /* Tabelle/Spalte erst nach der ersten Lieferung vorhanden */ }
            db.close();
        } catch { /* liquiditybot.db nicht lesbar – wie "keine Freigabe" behandeln */ }
    }
    try {
        const db = new Database(PATHS.settingsDb, { readonly: true, fileMustExist: true });
        try {
            // pay_failure_notified unterscheidet die beiden Wege, auf denen `enabled`
            // auf 0 stehen kann: vom Nutzer ausgeschaltet (Flag 0) oder von
            // premium-pay.js selbst abgeschaltet, weil das USDC-Guthaben nicht mehr
            // reichte (Flag 1, siehe core/premium/premium-pay.js). Ohne die
            // Unterscheidung riet der Health-Monitor zum Wiedereinschalten, obwohl das
            // ohne Nachfüllen sofort wieder scheitert (belegt 2026-08-13 auf forge-pub1).
            const row = db.prepare(`SELECT enabled, outage_paused FROM premium_settings WHERE id = 1`).get();
            state.autoPayEnabled = row?.enabled === 1;
            state.outagePaused   = row?.outage_paused === 1;
            // Bewusst als EIGENE Abfrage: die Spalte kommt per Migration dazu
            // (lib/premium-auto-pay-store.js) und fehlt auf einem noch nicht
            // migrierten Host. In derselben Abfrage würde ihr Fehlen auch die beiden
            // Werte darüber verschlucken – die Zahlungslage wäre dann grundlos unbekannt.
            try {
                state.payFailure = db.prepare(`SELECT pay_failure_notified FROM premium_settings WHERE id = 1`).get()?.pay_failure_notified === 1;
            } catch { /* Spalte noch nicht migriert – wie "kein Fehlschlag" behandeln */ }
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
            // "Noch kein Premium-Blob integriert" allein liest sich wie ein hängender
            // Empfang. Ist Premium schlicht nie eingeschaltet worden (Normalfall auf
            // einer frischen Installation), gehört genau das in den Text – sonst sucht
            // der Nutzer einen Fehler, den es nicht gibt.
            const { autoPayEnabled } = readPaymentState(Math.floor(Date.now() / 3_600_000));
            if (autoPayEnabled === false) {
                return { status: 'disabled', latency_ms: null, detail: t('health_check.premium_never_enabled') };
            }
            return { status: 'unknown', latency_ms: null, detail: t('health_check.premium_never_ingested') };
        }
        const ageMs  = Date.now() - row.last_ingested_at;
        const ageMin = Math.round(ageMs / 60000);
        if (ageMs <= INGEST_STALE_MS) {
            return { status: 'ok', latency_ms: null, detail: t('health_check.premium_ingest_ok', { ageMin }) };
        }

        // Ab hier: Daten sind veraltet – die Ursache entscheidet über den Status.
        // 'warn' statt 'error' überall dort, wo kein Defekt vorliegt: nur 'error'
        // löst den Persistenz-Alert aus (siehe isSecondConsecutiveError unten).
        const { paidThisHour, autoPayEnabled, outagePaused, payFailure, sharedCoverage } = readPaymentState(Math.floor(Date.now() / 3_600_000));

        // Vor allen Zahlungs-Zweigen: Wer über die Systemdaten-Freigabe versorgt wird,
        // hat Auto-Pay dauerhaft aus — jeder Text unten ("einschalten", "USDC nachfüllen")
        // wäre für ihn schlicht falsch und schickte ihn in den Zahlungspfad statt zu
        // seinen Reports. Der Zustand selbst (Daten veraltet) bleibt unverändert gemeldet.
        if (sharedCoverage) {
            const escalate = ageMs > INGEST_ESCALATE_MS;
            return {
                status: escalate ? 'error' : 'warn', latency_ms: null,
                detail: t('health_check.premium_shared_coverage', { ageMin }),
            };
        }

        if (outagePaused) {
            return { status: 'error', latency_ms: null, detail: t('health_check.premium_outage_paused', { ageMin }) };
        }
        if (autoPayEnabled === false) {
            // Ausgeschaltetes Premium ist kein eingeschränkt antwortender Dienst, sondern
            // ein abgeschalteter (Festlegung 2026-08-13, nach Rückfrage aus dem Betrieb):
            // ohne Zahlung liefert der Anbieter bestimmungsgemäß nichts, es gibt also gar
            // nichts zu überwachen. 'warn' behauptete an dieser Stelle eine Störung und
            // erklärte im Tooltip sogar "der Dienst antwortet eingeschränkt" — beides
            // falsch. Deshalb 'disabled', mit unveränderter Ursachenangabe im Text.
            //
            // Zwei grundverschiedene Lagen hinter demselben `enabled = 0`: bloßes
            // Einschalten hilft nur im ersten Fall. Im zweiten hat premium-pay.js selbst
            // abgeschaltet, weil das USDC-Guthaben nicht mehr für eine Stunde reichte –
            // ohne Nachfüllen scheitert die nächste Zahlung sofort wieder.
            if (payFailure) {
                return { status: 'disabled', latency_ms: null, detail: t('health_check.premium_disabled_pay_failure', { ageMin }) };
            }
            return { status: 'disabled', latency_ms: null, detail: t('health_check.premium_disabled', { ageMin }) };
        }
        if (!paidThisHour) {
            // Auto-Pay ist eingeschaltet (sonst hätte der Zweig darüber gegriffen), die
            // Zahlung kommt aber trotzdem nicht durch. Kurzfristig harmlos (ein einzelner
            // verpasster Slot holt sich in derselben Stunde selbst wieder ein), ab
            // INGEST_ESCALATE_MS aber ein echter Störungszustand – siehe Konstante oben.
            if (autoPayEnabled === true && ageMs > INGEST_ESCALATE_MS) {
                return { status: 'error', latency_ms: null, detail: t('health_check.premium_pay_not_through', { ageMin, escalateMin: Math.round(INGEST_ESCALATE_MS / 60000) }) };
            }
            return { status: 'warn', latency_ms: null, detail: t('health_check.premium_not_paid_this_hour', { ageMin }) };
        }
        return { status: 'error', latency_ms: null, detail: t('health_check.premium_delivery_broken', { ageMin }) };
    } catch (e) {
        return { status: 'unknown', latency_ms: null, detail: t('health_check.liquiditybot_db_unreadable', { msg: e.message?.slice(0, 60) }) };
    }
}

// ── GitHub-Update-Status (Fork-Seite) ────────────────────────────────────────────
// GitHub wird für die automatischen Updates gebraucht (bin/update-check.js, läuft
// täglich per Cron im Fork). Kein eigener Request an GitHub: der bestehende
// Rate-Limit-Vorfall vom 2026-08-05 (60 Requests/h unauthentifiziert, PRO
// QUELL-IP – forge-pub1/pub2 teilen sich eine öffentliche IP) verbietet einen
// zusätzlichen periodischen Ping. Stattdessen reines Auslesen der beiden Dateien,
// die update-check.js bei jedem Lauf ohnehin schreibt: release-list-cache.json
// (Zeitpunkt des letzten ERFOLGREICHEN Abrufs) und update-fetch-failures.json
// (Fehlschlag-Zähler, siehe FETCH_FAILURE_NOTIFY_THRESHOLD dort). Bildet damit
// exakt den echten Pfad ab, der für Auto-Updates zählt – gleicher Token, gleiches
// Rate-Limit-Budget – statt eine zweite, unabhängige Prüfung zu erfinden.
//
// Schwelle bewusst identisch zu update-check.js gehalten (dort löst sie den
// einmaligen Alarm aus): ein einzelner Fehlschlag ist erwartbar (Netzwerk-
// Ausrutscher, kurzzeitig ausgeschöpftes Limit) und bleibt 'warn', kein Alarm.
const GITHUB_FETCH_FAILURE_ALERT_THRESHOLD = 3; // siehe FETCH_FAILURE_NOTIFY_THRESHOLD in bin/update-check.js

function checkGithubUpdateStatus() {
    let failures = null;
    let cache = null;
    try { failures = JSON.parse(readFileSync(join(PATHS.data, 'update-fetch-failures.json'), 'utf8')); } catch { /* kein Fehlschlag protokolliert – Normalfall */ }
    try { cache = JSON.parse(readFileSync(join(PATHS.data, 'release-list-cache.json'), 'utf8')); } catch { /* noch kein erfolgreicher Abruf */ }

    if (!failures && !cache) {
        return { status: 'unknown', latency_ms: null, detail: t('health_check.github_never_checked') };
    }

    const ageMin = cache ? Math.round((Date.now() - cache.fetchedAt) / 60000) : null;
    const count  = failures?.count ?? 0;
    // "Nie erfolgreich" nur möglich, wenn schon der allererste Abruf nach der
    // Installation scheitert (kein cache, aber ein Fehlschlag-Zähler) – daher
    // eigener Textbaustein statt "vor null Min" in die Übersetzung zu reichen.
    const lastOk = ageMin != null ? t('health_check.github_last_ok_suffix', { ageMin }) : t('health_check.github_never_ok_suffix');

    if (count === 0) {
        return { status: 'ok', latency_ms: null, detail: t('health_check.github_ok', { lastOk }) };
    }
    if (count < GITHUB_FETCH_FAILURE_ALERT_THRESHOLD) {
        return { status: 'warn', latency_ms: null, detail: t('health_check.github_warn', { count, threshold: GITHUB_FETCH_FAILURE_ALERT_THRESHOLD, lastOk }) };
    }
    return { status: 'error', latency_ms: null, detail: t('health_check.github_error', { count, lastOk }) };
}

async function checkService(svc) {
    switch (svc.type) {
        case 'systemd':    return checkSystemd(svc.id);
        case 'http':       return checkHttp(svc.url, svc.method ?? 'GET');
        case 'helius_rpc': return checkHeliusRpc();
        case 'telegram':   return checkTelegram();
        case 'nostr_relay': return checkNostrRelay(svc.relayUrl);
        case 'host_disk':   return checkHostDisk(svc.path ?? '/');
        case 'host_memory': return checkHostMemory();
        case 'host_oom':    return checkHostOom();
        case 'premium_host_status': return checkPremiumHostStatus(svc.hostKey);
        case 'premium_ingest_status': return checkPremiumIngestStatus();
        case 'github_update_status': return checkGithubUpdateStatus();
        default:
            return { status: 'unknown', latency_ms: null, detail: t('health_check.unknown_type', { type: svc.type }) };
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
// msgKey statt fertigem Text (Schritt 5 der Mehrsprachigkeit) — lief bisher
// unabhängig von der Installationssprache immer auf Deutsch, siehe
// lib/notify-render.js.
const ALERT_MSG_KEY = {
    cron:     'notify.health.cron_failed',
    host:     'notify.health.host_exceeded',
    external: 'notify.health.external_unreachable',
    service:  'notify.health.service_unreachable',
};
const ALERT_DEFAULT_DETAIL = {
    cron: () => t('health_check.no_reason_logged'),
    host: () => t('health_check.no_metric_logged'),
    external: () => 'Timeout',
    service:  () => 'Timeout',
};

async function sendPersistenceAlert(svcName, detail, { kind = 'service' } = {}) {
    try {
        // 'external' getrennt von 'service' (2026-08-13): "den betroffenen Dienst neu
        // starten" ist die richtige Anweisung für einen lokalen systemd-Dienst, aber
        // sinnlos für Jupiter, Helius, Telegram oder Orca — die laufen nicht auf diesem
        // Server und es gibt dort nichts zum Neustarten. Genau dieser Text schickte am
        // 2026-08-13 die Fehlersuche in die falsche Richtung (siehe classifyTimeout oben).
        const msgKey = ALERT_MSG_KEY[kind] ?? ALERT_MSG_KEY.service;
        const params = { svcName, detail: detail ?? ALERT_DEFAULT_DETAIL[kind]?.() ?? ALERT_DEFAULT_DETAIL.service() };
        const msg = renderNotification(
            { msgKey, params, displayName: 'Monitoring', timestamp: Date.now() },
            getLang(),
        );
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
                message:     msg, msgKey, params,
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
    // selben Fix in bin/forge-cron.js): auf dem FORGE-public-Fork ist FORGE_ROOT der
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
        const svcId = `cron:${jobId}`;

        // 🔒 Nur werten, wenn seit der letzten Aufzeichnung TATSÄCHLICH ein neuer
        // Job-Lauf stattfand (Ticket [Core#0308], Fund 2026-08-20 auf forge-pub1).
        //
        // cron-state.json hält `lastExitCode` bis zum nächsten Lauf des Jobs — bei
        // `lmb3-cleanup` (stündlich) also eine volle Stunde. Dieser Check läuft aber
        // alle 5 Minuten und schrieb denselben eingefrorenen Zustand jedes Mal als
        // neue Messung in `health_checks`. isSecondConsecutiveError() sah dadurch
        // nach 10 Minuten "zwei Fehlschläge in Folge", obwohl der Job real genau
        // EINMAL gelaufen war — aus einem einzelnen transienten RPC-Aussetzer wurde
        // ein Alarm. Konkret unterlief das den bewussten Schutz in cleanup.js, das
        // per fail-streak.js erst beim 3. Fehlschlag meldet und im selben Lauf noch
        // "Alert unterdrückt (Streak 1/3) – vermutlich transienter Fehler" ins Log
        // schrieb. Dieser Satz stand dann wörtlich in der Alarm-Meldung.
        //
        // Vergleich gegen den Zeitpunkt der letzten eigenen Aufzeichnung: liegt der
        // Job-Lauf davor, haben wir ihn bereits verbucht. Bewusst ohne Schema-
        // Änderung — `timestamp_ms` der letzten Zeile genügt als Wasserstandsmarke.
        // `isNewRun` trennt AUFZEICHNEN von ANZEIGEN — beides darf hier nicht
        // zusammenfallen: der Status wird immer zurückgegeben (sonst stünde ein
        // gesunder stündlicher Job im Dashboard als 'unknown', weil er zwischen
        // zwei Läufen 11 Mal nicht "neu" ist, siehe Export weiter unten), aber nur
        // ein echter neuer Lauf wird als Messpunkt in `health_checks` geschrieben.
        // Genau diese Messpunkte zählt isSecondConsecutiveError().
        const lastRunMs = s.lastRun ? Date.parse(s.lastRun) : NaN;
        let isNewRun = true;
        if (Number.isFinite(lastRunMs)) {
            const prev = db.prepare(
                'SELECT MAX(timestamp_ms) AS t FROM health_checks WHERE service_id = ?'
            ).get(svcId);
            // Liegt der Job-Lauf vor unserer letzten Aufzeichnung, haben wir ihn
            // bereits verbucht. Ein anhaltender Fehler wird beim NÄCHSTEN echten
            // Lauf erneut als error geschrieben und löst dann korrekt aus.
            if (prev?.t != null && lastRunMs <= prev.t) isNewRun = false;
        }

        results[svcId] = s.lastExitCode === 0
            ? { status: 'ok', latency_ms: s.lastDurationMs ?? null, detail: null, jobId, isNewRun }
            : { status: 'error', latency_ms: s.lastDurationMs ?? null,
                detail: s.lastError ?? `Exit ${s.lastExitCode}`, jobId, isNewRun };
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
        INSERT.run(svc.id, now, result.status, result.latency_ms ?? null, result.detail ?? null,
                   result.memBytes ?? null, result.restarts ?? null, result.uptimeSec ?? null,
                   result.detailCode ?? null);
        latest[svc.id] = result;

        const latStr = result.latency_ms != null ? `${result.latency_ms}ms` : '    –';
        console.log(`[health] ${svc.id.padEnd(26)} ${result.status.padEnd(7)} ${latStr}`);
    }
}

for (const [svcId, result] of Object.entries(checkCronJobs())) {
    // Nur echte neue Job-Läufe werden zu Messpunkten (siehe checkCronJobs).
    // `latest` bekommt den Zustand IMMER, sonst fiele ein gesunder Job im
    // Dashboard-Export auf 'unknown' zurück, solange er nicht neu gelaufen ist.
    if (result.isNewRun) {
        INSERT.run(svcId, now, result.status, result.latency_ms ?? null, result.detail ?? null, null, null, null, null);
    }
    latest[svcId] = result;
    const latStr = result.latency_ms != null ? `${result.latency_ms}ms` : '    –';
    console.log(`[health] ${svcId.padEnd(26)} ${result.status.padEnd(7)} ${latStr}${result.isNewRun ? '' : '  (unverändert)'}`);
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
                'Alle konfigurierten Relays gleichzeitig nicht verbunden – Message Center und Premium-Auslieferung sind funktionsunfähig.',
                { kind: 'external' },
            );
        }
        continue;
    }

    for (const svc of chain.services) {
        if (latest[svc.id]?.status !== 'error') continue;

        // Sonderfall OOM: Die "2 Fehlschläge in Folge"-Regel würde hier NIE greifen und
        // die Prüfung damit vollständig wirkungslos machen. Ein Speicher-Engpass ist ein
        // Ereignis, kein Zustand — beim nächsten Lauf ist die Differenz wieder 0 und der
        // Status zurück auf 'ok'. Deshalb sofort melden.
        //
        // Dämpfung stattdessen über die Zeit: höchstens eine Meldung pro Stunde, dafür
        // mit der Gesamtzahl aller seither aufgelaufenen Vorkommnisse. Ein Server, der
        // im Minutentakt Prozesse abschießt, soll nicht im Minutentakt Meldungen senden
        // — dasselbe Alert-Spam-Muster, gegen das lib/fail-streak.js bereits entstand.
        // Es geht dabei nichts verloren: der Zähler läuft weiter, die nächste Meldung
        // nennt die volle Zahl.
        if (svc.type === 'host_oom') {
            const lastAlert = Number(readHostState('oom_last_alert_ms') ?? 0);
            if (now - lastAlert >= 60 * 60 * 1000) {
                writeHostState('oom_last_alert_ms', now);
                await sendPersistenceAlert(svc.name, latest[svc.id].detail, { kind: 'host' });
            } else {
                console.log(`[health] OOM-Alert unterdrückt (letzte Meldung vor ${Math.round((now - lastAlert) / 60000)} Min)`);
            }
            continue;
        }

        if (isSecondConsecutiveError(svc.id)) {
            // Nur ein 'systemd'-Dienst läuft auf diesem Server und lässt sich neu starten;
            // alle übrigen Prüfarten (http, helius_rpc, telegram, nostr_relay, premium_*)
            // beschreiben Zustände, die ein lokaler Neustart nicht berührt. Die
            // host_*-Prüfungen messen den Server selbst und bekommen ihre eigene Art.
            const kind = svc.type === 'systemd'          ? 'service'
                       : svc.type?.startsWith('host_')   ? 'host'
                       :                                   'external';
            await sendPersistenceAlert(svc.name, latest[svc.id].detail, { kind });
        }
    }
}

// "2 Fehlschläge in Folge" = zwei tatsächliche Job-Läufe, nicht zwei Durchläufe
// dieses Checks (siehe die lastRun-Wasserstandsmarke in checkCronJobs).
//
// 🔒 Die frühere Annahme hier — "Cron-Jobs laufen typischerweise alle 5-10 Min,
// also ~10-20 Min bis zum Alarm" — war schlicht falsch: von 31 aktiven Jobs läuft
// nur `health-check` selbst im 5-Minuten-Takt, alle übrigen stündlich bis monatlich.
// Aus ihr folgte der Fehlalarm aus [Core#0308].
//
// Die Vorwarnzeit hängt damit am Job-Intervall: stündlich → ~2 h, täglich → ~2 Tage.
// Das ist beabsichtigt und die einzige ehrliche Aussage — ein täglicher Job KANN
// nicht schneller zweimal scheitern. Wer früher alarmieren will, braucht eine
// job-eigene Schwelle (Muster: fail-streak.js in cleanup.js), nicht eine kürzere
// Frist hier.
//
// description statt roher jobId im Alertext (Fund 2026-08-09): "cron:pool-offers-sync"
// sagt einem Endnutzer nichts, config/cron-jobs.json hat für jeden Job längst einen
// verständlichen description-Text. kind:'cron' sorgt für den passenden Meldungstext
// (kein "Dienst neu starten" für einen Job, der beim nächsten Intervall ohnehin
// wieder anläuft, siehe sendPersistenceAlert oben).
const cronDescriptions = Object.fromEntries(listJobs().map(j => [j.id, j.description ?? j.id]));
for (const [svcId, result] of Object.entries(latest)) {
    if (!svcId.startsWith('cron:') || result.status !== 'error') continue;
    // 🔒 Nur bei einem neuen Lauf auswerten. Ohne diese Zeile bliebe das
    // Auswertungsfenster von isSecondConsecutiveError() zwischen zwei Job-Läufen
    // unverändert stehen (es werden ja keine Messpunkte mehr nachgeschoben) — der
    // Alarm wäre damit bei jedem 5-Minuten-Durchlauf erneut wahr und würde bis zum
    // nächsten Job-Lauf im Takt wiederholt. Vorher verschob sich das Fenster durch
    // die pausenlos geschriebenen Zeilen von selbst; diese Nebenwirkung entfällt.
    if (!result.isNewRun) continue;
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
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)          AS error_count,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END)       AS disabled_count
    FROM health_checks
    WHERE timestamp_ms >= ?
    GROUP BY service_id, hour_bucket
    ORDER BY service_id, hour_bucket ASC
`).all(historyFrom);

// Nach service_id gruppieren und Stunden-Status berechnen
const historyByService = {};
for (const row of historyRows) {
    if (!historyByService[row.service_id]) historyByService[row.service_id] = [];

    // Der Stundenstatus wurde bis 2026-08-13 allein aus dem ok-Anteil abgeleitet
    // (`ok/total`), obwohl warn_count und error_count bereits selektiert wurden —
    // beide blieben ungenutzt. Folge: jeder Nicht-ok-Zustand landete gleichermaßen
    // bei 0 % und färbte den Balken rot, also "ausgefallen". Belegt am 2026-08-13 auf
    // forge-pub2: der Liquidity Bot war seit dem 11.08. bewusst angehalten (leeres
    // Wallet, Einzelstatus 'warn' = "angehalten – läuft erst nach einem Start wieder"),
    // die 7-Tage-Leiste zeigte trotzdem durchgehend Rot. Das Anhalten eines Bots ist
    // beim Endnutzer ein normaler Vorgang und darf nicht wie ein Ausfall aussehen —
    // dieselbe Festlegung, die checkSystemd() für den Einzelstatus bereits umsetzt.
    //
    // 'unknown' zählt weder als Erfolg noch als Ausfall: der Check hat keine gültige
    // Messung geliefert (z.B. eine durch lokalen Speicherdruck verfälschte Latenz,
    // siehe classifyTimeout oben). Solche Läufe fließen deshalb weder in die Farbe
    // noch in die Uptime ein — sonst hätte der Stall-Schutz oben die Fehlalarme nur
    // von der Meldung in die Statistik verschoben. Enthält eine Stunde ausschließlich
    // ungültige Messungen, ist sie als Ganzes 'unknown' (Balken blau, nicht rot).
    // 'disabled' ist wie 'unknown' keine Aussage über die Güte des Dienstes, sondern
    // über die Frage, ob er überhaupt laufen soll — deshalb ebenfalls außerhalb von
    // `measured` (weder Erfolg noch Ausfall, keine Uptime-Wirkung). Anders als bei
    // 'unknown' ist die Ursache aber bekannt, also bekommt eine Stunde ohne jede
    // gültige Messung, in der der Dienst deaktiviert war, einen eigenen Balken statt
    // des blauen "Status unklar" – sonst sähe eine bewusste Abschaltung in der
    // Historie wie eine Messstörung aus.
    const measured = row.ok_count + row.warn_count + row.error_count;

    let hourStatus;
    if (measured === 0) {
        hourStatus = row.disabled_count > 0 ? 'disabled' : 'unknown';
    } else if (row.ok_count / measured >= 0.8) {
        hourStatus = 'ok';
    } else if (row.error_count / measured >= 0.2) {
        hourStatus = 'error';
    } else {
        hourStatus = 'warn';
    }

    historyByService[row.service_id].push({
        ts:    row.hour_bucket,
        s:     hourStatus,   // 's' spart ~1 KB im JSON bei 168 × n Services
        total: measured,     // Bezugsgröße für Tooltip und Uptime – ohne ungültige Messungen
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
            // Nur die Host-Prüfungen setzen `metric` (z.B. "70 % belegt · 4,2 GB frei").
            // Sie haben keine Antwortzeit, die man anzeigen könnte – ihr Messwert IST
            // die Aussage. Das Frontend zeigt an derselben Stelle entweder das eine
            // oder das andere.
            metric:      latest[svc.id]?.metric     ?? null,
            detail:      latest[svc.id]?.detail     ?? null,
            history:     historyByService[svc.id]   ?? [],
            // Nur systemd-Dienste liefern Prozess-Metriken (checkSystemd), alle anderen
            // Check-Typen lassen memBytes/restarts/uptimeSec auf null – process bleibt dann
            // ebenfalls null statt eines Objekts voller null-Werte (2026-08-13,
            // Systemdaten-Freigabe: der lokale Nutzen dieser Anzeige ist unabhängig von der
            // Freigabe an den Master).
            process:     latest[svc.id]?.memBytes != null ? {
                memBytes:  latest[svc.id].memBytes,
                restarts:  latest[svc.id].restarts  ?? null,
                uptimeSec: latest[svc.id].uptimeSec ?? null,
            } : null,
        })),
    })),
    nexus: nexusStats,
};

const outPath = join(FORGE_ROOT, 'html', 'data', 'health-status.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload));
console.log(`[health] JSON exportiert → html/data/health-status.json`);
