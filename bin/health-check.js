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

const INSERT = db.prepare(
    `INSERT INTO health_checks (service_id, timestamp_ms, status, latency_ms, detail, mem_bytes, restarts, uptime_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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

function parseSystemdProcessMetrics(raw) {
    let memBytes = null, restarts = null, activeEnterMs = null;
    for (const line of raw.trim().split('\n')) {
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key   = line.slice(0, idx);
        const value = line.slice(idx + 1);
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
            + `-p MemoryCurrent -p NRestarts -p ActiveEnterTimestamp`,
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
        return { status: 'error', latency_ms: null, detail: `Unit "${serviceId}" existiert nicht – Konfigurationsfehler in health-config.js prüfen` };
    }
    // Klartext statt der rohen systemd-Zustände (2026-08-13): dieser Text steht jetzt
    // als Erklärung im Status-Tooltip der Karte — "active" beantwortet dort niemandem
    // die Frage, was gerade los ist.
    if (activeState === 'active')       return { status: 'ok', latency_ms: null, detail: 'läuft', ...processMetrics };
    if (activeState === 'activating')   return { status: 'ok', latency_ms: null, detail: 'startet gerade', ...processMetrics };
    if (activeState === 'deactivating') return { status: 'ok', latency_ms: null, detail: 'fährt gerade herunter', ...processMetrics };
    if (activeState === 'inactive') {
        if (unitFileState === 'disabled' || unitFileState === 'masked') {
            return { status: 'disabled', latency_ms: null, detail: 'deaktiviert – dieser Dienst ist bewusst abgeschaltet und startet auch beim Systemstart nicht', ...processMetrics };
        }
        return { status: 'warn', latency_ms: null, detail: 'angehalten – läuft erst nach einem Start wieder', ...processMetrics };
    }
    // 'failed' und alles Unerwartete ('unknown', leer, Fehlertext): echter Befund.
    return { status: 'error', latency_ms: null, detail: activeState === 'failed' ? 'abgestürzt/gescheitert' : activeState, ...processMetrics };
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
            detail:     `Messung ungültig – Abbruch erst nach ${(latencyMs / 1000).toFixed(1)} s statt nach ${timeoutMs / 1000} s. `
                      + `Der Timer läuft lokal, die Verzögerung entstand also auf diesem Server (blockierter Prozess, `
                      + `Speicherdruck), nicht beim Anbieter. Kein Hinweis auf einen Ausfall des Dienstes.`,
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
        return { status: 'warn', latency_ms: null, detail: 'HELIUS_API_KEY nicht konfiguriert' };
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
        return { status: 'warn', latency_ms: null, detail: 'TELEGRAM_BOT_TOKEN nicht konfiguriert' };
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
        const metric  = `${usedPct.toFixed(0)} % belegt · ${fmtBytes(free)} frei`;

        if (usedPct >= DISK_ERROR_PCT || free < DISK_ERROR_FREE) {
            return { status: 'error', latency_ms: null, metric,
                detail: `${path} ist zu ${usedPct.toFixed(1)} % belegt, nur noch ${fmtBytes(free)} frei. `
                      + `Läuft das Dateisystem voll, können die Bots ihre Datenbanken nicht mehr schreiben. `
                      + `Platz schaffen: alte Protokolle unter logs/ und nicht mehr benötigte Backups löschen.` };
        }
        if (usedPct >= DISK_WARN_PCT) {
            return { status: 'warn', latency_ms: null, metric,
                detail: `${path} ist zu ${usedPct.toFixed(1)} % belegt, noch ${fmtBytes(free)} frei. `
                      + `Noch unkritisch, aber der Trend sollte im Blick bleiben – bei anhaltendem Wachstum `
                      + `alte Protokolle und Backups aufräumen.` };
        }
        return { status: 'ok', latency_ms: null, metric,
                 detail: `${path}: ${fmtBytes(free)} von ${fmtBytes(total)} frei (${usedPct.toFixed(1)} % belegt)` };
    } catch (e) {
        return { status: 'unknown', latency_ms: null, detail: `Dateisystem ${path} nicht lesbar: ${e.message?.slice(0, 60)}` };
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
            return { status: 'unknown', latency_ms: null, detail: '/proc/meminfo liefert MemTotal/MemAvailable nicht' };
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

        const metric = `${availPct.toFixed(0)} % verfügbar · ${fmtBytes(avail)}`
                     + (swapTotal > 0 ? ` · Auslagerung ${swapPct.toFixed(0)} %` : '');
        const swapNote = swapFull
            ? ` Die Auslagerungsdatei ist zu ${swapPct.toFixed(0)} % belegt und steht als Reserve praktisch nicht mehr zur Verfügung.`
            : '';

        if (availPct < MEM_ERROR_PCT || (swapFull && availPct < MEM_WARN_PCT)) {
            return { status: 'error', latency_ms: null, metric,
                detail: `Nur noch ${availPct.toFixed(1)} % Arbeitsspeicher verfügbar (${fmtBytes(avail)} von ${fmtBytes(total)}).${swapNote} `
                      + `In diesem Zustand beendet das Betriebssystem Prozesse, um Speicher freizugeben. `
                      + `Nicht benötigte Programme auf diesem Server beenden; hält es an, reicht der Arbeitsspeicher für den Betrieb nicht aus.` };
        }
        if (availPct < MEM_WARN_PCT) {
            return { status: 'warn', latency_ms: null, metric,
                detail: `Noch ${availPct.toFixed(1)} % Arbeitsspeicher verfügbar (${fmtBytes(avail)} von ${fmtBytes(total)}).${swapNote} `
                      + `Noch kein Engpass, aber wenig Reserve – laufende Programme auf diesem Server im Blick behalten.` };
        }
        return { status: 'ok', latency_ms: null, metric,
                 detail: `${fmtBytes(avail)} von ${fmtBytes(total)} verfügbar (${availPct.toFixed(1)} %)`
                       + (swapTotal > 0 ? `, Auslagerung zu ${swapPct.toFixed(0)} % belegt` : '') };
    } catch (e) {
        return { status: 'unknown', latency_ms: null, detail: `/proc/meminfo nicht lesbar: ${e.message?.slice(0, 60)}` };
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
            return { status: 'unknown', latency_ms: null, detail: 'Dieser Kernel führt keinen OOM-Zähler (/proc/vmstat: oom_kill fehlt)' };
        }
        count = Number(m[1]);
    } catch (e) {
        return { status: 'unknown', latency_ms: null, detail: `/proc/vmstat nicht lesbar: ${e.message?.slice(0, 60)}` };
    }

    const prev  = readHostState('oom_kill_count');
    const prevN = prev === null ? null : Number(prev);
    writeHostState('oom_kill_count', count);

    // Erster Lauf: nur Ausgangswert merken. Ein bereits vor Einführung dieser Prüfung
    // hochgezählter Stand ist keine Neuigkeit und darf nicht rückwirkend alarmieren.
    if (prevN === null) {
        return { status: 'ok', latency_ms: null, metric: `${count} seit Systemstart`,
                 detail: `Ausgangswert erfasst: ${count} Vorkommnisse seit dem Systemstart. Ab jetzt wird jedes weitere gemeldet.` };
    }

    // Der Zähler wird beim Systemstart zurückgesetzt; ein kleinerer Wert als zuvor
    // bedeutet Neustart, nicht "negative Vorkommnisse".
    if (count < prevN) {
        return { status: 'ok', latency_ms: null, metric: `${count} seit Systemstart`,
                 detail: `Der Server wurde neu gestartet (Zähler zurückgesetzt). Seither ${count} Vorkommnisse.` };
    }

    const delta = count - prevN;
    if (delta > 0) {
        return { status: 'error', latency_ms: null, metric: `${delta} neu · ${count} seit Systemstart`,
                 detail: `Das Betriebssystem hat in den letzten 5 Minuten ${delta} Prozess(e) wegen Speichermangels beendet `
                       + `(insgesamt ${count} seit dem Systemstart). Getroffen wird dabei nicht zwingend der Verursacher. `
                       + `Speicherverbrauch auf diesem Server prüfen und nicht benötigte Programme beenden; `
                       + `wiederholt sich das, reicht der Arbeitsspeicher für den Betrieb nicht aus.` };
    }
    return { status: 'ok', latency_ms: null, metric: `${count} seit Systemstart`,
             detail: `Keine neuen Vorkommnisse. Insgesamt ${count} seit dem Systemstart.` };
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
                return { status: 'disabled', latency_ms: null, detail: 'Premium ist nicht eingeschaltet – es wurden noch nie Daten empfangen. Einschalten unter Liquidity → Premium → Verwalten.' };
            }
            return { status: 'unknown', latency_ms: null, detail: 'Noch kein Premium-Blob integriert' };
        }
        const ageMs  = Date.now() - row.last_ingested_at;
        const ageMin = Math.round(ageMs / 60000);
        if (ageMs <= INGEST_STALE_MS) {
            return { status: 'ok', latency_ms: null, detail: `Letzter Ingest erfolgreich (vor ${ageMin} Min)` };
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
                detail: `Letzter Empfang vor ${ageMin} Min – dieser Zugang läuft über die Systemdaten-Freigabe, `
                      + `nicht über eine Zahlung. Jeder gesendete Report verlängert ihn um eine Stunde; `
                      + `bleiben Reports aus, endet er von selbst. Prüfen, ob die Freigabe im Health Monitor `
                      + `noch aktiv ist und Reports den Master erreichen.`,
            };
        }

        if (outagePaused) {
            return { status: 'error', latency_ms: null, detail: `Letzter Ingest vor ${ageMin} Min – der Premium-Dienst des Anbieters gilt seit über 2h als nicht erreichbar, die Zahlung wurde automatisch pausiert. Nichts zu tun: sie läuft von selbst wieder an, sobald Daten ankommen.` };
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
                return { status: 'disabled', latency_ms: null, detail: `Premium ist abgeschaltet, letzter Empfang vor ${ageMin} Min – die letzte Zahlung scheiterte am zu geringen USDC-Guthaben, daraufhin hat sich die automatische Zahlung abgeschaltet. USDC nachfüllen und unter Liquidity → Premium → Verwalten wieder einschalten.` };
            }
            return { status: 'disabled', latency_ms: null, detail: `Premium ist abgeschaltet, letzter Empfang vor ${ageMin} Min – ohne die automatische Zahlung liefert der Anbieter keine Premium-Daten. Einschalten unter Liquidity → Premium → Verwalten.` };
        }
        if (!paidThisHour) {
            // Auto-Pay ist eingeschaltet (sonst hätte der Zweig darüber gegriffen), die
            // Zahlung kommt aber trotzdem nicht durch. Kurzfristig harmlos (ein einzelner
            // verpasster Slot holt sich in derselben Stunde selbst wieder ein), ab
            // INGEST_ESCALATE_MS aber ein echter Störungszustand – siehe Konstante oben.
            if (autoPayEnabled === true && ageMs > INGEST_ESCALATE_MS) {
                return { status: 'error', latency_ms: null, detail: `Letzter Ingest vor ${ageMin} Min – die automatische Zahlung ist eingeschaltet, kommt seit über ${Math.round(INGEST_ESCALATE_MS / 60000)} Min aber nicht durch, deshalb liefert der Anbieter keine Daten. Wallet-Guthaben (SOL für Gebühren, USDC für die Stundenzahlung) und das Protokoll von premium-pay prüfen.` };
            }
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
        case 'host_disk':   return checkHostDisk(svc.path ?? '/');
        case 'host_memory': return checkHostMemory();
        case 'host_oom':    return checkHostOom();
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
        // 'external' getrennt von 'service' (2026-08-13): "den betroffenen Dienst neu
        // starten" ist die richtige Anweisung für einen lokalen systemd-Dienst, aber
        // sinnlos für Jupiter, Helius, Telegram oder Orca — die laufen nicht auf diesem
        // Server und es gibt dort nichts zum Neustarten. Genau dieser Text schickte am
        // 2026-08-13 die Fehlersuche in die falsche Richtung (siehe classifyTimeout oben).
        const msg = kind === 'cron'
            ? `🚨 *Wartungsjob „${svcName}" schlägt seit ~10 Min. fehl*\n`
              + `Detail: ${detail ?? 'kein Grund protokolliert'}\n`
              + `Der Job versucht es im nächsten Intervall automatisch erneut. Hält der Fehler an, `
              + `im Dashboard unter Health das Protokoll des Jobs prüfen.`
            // 'host' ist kein Dienst und kein Anbieter, sondern ein Zustand dieses
            // Servers. Die konkrete Handlungsanweisung steckt bereits im detail-Text
            // der jeweiligen Prüfung (Platz schaffen / Programme beenden), deshalb hier
            // kein zweiter, allgemeinerer Rat, der dem widersprechen könnte.
            : kind === 'host'
            ? `🚨 *${svcName}: Grenzwert überschritten*\n`
              + `Detail: ${detail ?? 'kein Messwert protokolliert'}\n`
              + `Betroffen ist der Server selbst, auf dem FORGE läuft – nicht ein einzelner Bot. `
              + `Der Verlauf steht im Dashboard unter Health → System.`
            : kind === 'external'
            ? `🚨 *${svcName} seit ~10 Min. nicht erreichbar*\n`
              + `Detail: ${detail ?? 'Timeout'}\n`
              + `Der Dienst läuft nicht auf diesem Server – ein Neustart hilft hier nicht. FORGE prüft `
              + `alle 5 Min. weiter. Hält es an, im Dashboard unter Health den Verlauf ansehen und die `
              + `Statusseite des Anbieters prüfen.`
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
        INSERT.run(svc.id, now, result.status, result.latency_ms ?? null, result.detail ?? null,
                   result.memBytes ?? null, result.restarts ?? null, result.uptimeSec ?? null);
        latest[svc.id] = result;

        const latStr = result.latency_ms != null ? `${result.latency_ms}ms` : '    –';
        console.log(`[health] ${svc.id.padEnd(26)} ${result.status.padEnd(7)} ${latStr}`);
    }
}

for (const [svcId, result] of Object.entries(checkCronJobs())) {
    INSERT.run(svcId, now, result.status, result.latency_ms ?? null, result.detail ?? null, null, null, null);
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
