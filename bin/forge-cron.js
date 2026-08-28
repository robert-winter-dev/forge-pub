#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// FORGE – Zentraler Cron-Runner
// ══════════════════════════════════════════════════════════════════════════════
// Ersetzt ~16 einzelne crontab-Zeilen durch EINEN Eintrag:
//
//   * * * * * cd /opt/forge/app && node bin/forge-cron.js >> /tmp/forge-cron-wrapper.log 2>&1
//
// Der Runner wird jede Minute aufgerufen, liest config/cron-jobs.json (via
// lib/cron-registry.js) und startet alle Jobs, die zu dieser Minute fällig sind.
//
// Eigenschaften:
//   • Jobs laufen PARALLEL (wie einzelne crontab-Zeilen), nicht sequenziell.
//   • Overlap-Schutz per Lock-Datei je Job (data/cron-locks/<id>.lock, PID-basiert).
//   • Job-Output → logs/cron/<id>.log (ersetzt die alten /tmp-Redirects einheitlich).
//   • Runner-Übersicht (Start/Ende/Skip) → logs/cron/forge-cron.log.
//   • Letzter Lauf je Job (Exit-Code, Dauer, Fehler) → data/cron-state.json,
//     lesbar für forge-check.js / Morgenroutine.
//
// Usage:
//   node bin/forge-cron.js                       – fällige Jobs jetzt ausführen
//   node bin/forge-cron.js --dry-run             – nur zeigen, was jetzt fällig wäre
//   node bin/forge-cron.js --now "<ISO>"         – Zeitpunkt überschreiben (Tests)
//   node bin/forge-cron.js --list                – alle Jobs + letzter Status
// ══════════════════════════════════════════════════════════════════════════════

import { spawn } from 'child_process';
import { openSync, closeSync, writeSync, mkdirSync, existsSync, readFileSync, writeFileSync,
         appendFileSync, renameSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
import { listJobs, cronMatches } from '../lib/cron-registry.js';
import { PATHS } from '../config/paths.js';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '..');
// PATHS.data statt join(ROOT, 'data') (Fund 2026-08-09): ROOT ist auf dem
// FORGE-public-Fork der APP_DIR-Checkout, der bei jedem Update komplett neu
// geschrieben wird (rm -rf + rsync, siehe bin/setup-lib/deploy.sh do_deploy()).
// Lag cron-state.json/cron-locks dort, verlor der Runner bei jedem Update
// seine gesamte Job-Historie (Fehldiagnose "Job lief noch nie", obwohl er nur
// den Zustand verloren hatte). PATHS.data zeigt auf dem Fork auf
// <base>/local/data (überlebt Updates), auf dem Master unverändert auf
// <FORGE>/data (bit-identisch zum alten join(ROOT,'data')).
const DATA        = PATHS.data;
const LOCK_DIR     = join(DATA, 'cron-locks');
const STATE_F      = join(DATA, 'cron-state.json');
// Vom Installer während do_deploy()/do_npm() gesetzt (bin/setup-lib/common.sh
// deploy_lock_acquire/-release). Existiert die Datei, ist app/ gerade
// gelöscht/neu ausgerollt und node_modules evtl. unvollständig — Jobs, die
// genau jetzt anspringen, würden mit irreführenden Fehlern crashen (Fund
// 2026-08-09: pool-offers-sync crashte mit "Cannot find package 'dotenv'",
// weil der Cron-Tick mitten in ein laufendes npm install fiel). Statt das als
// Job-Fehler zu werten, wird der Tick komplett übersprungen — die verpassten
// Jobs werden in PENDING_F vorgemerkt und im ersten Tick nach dem Deploy
// nachgeholt (siehe unten).
const DEPLOY_LOCK  = join(DATA, 'deploy.lock');
// Während eines Deploys übersprungene Jobs. Ohne diese Merkliste fiel ein Job
// mit nur EINEM Slot pro Stunde ersatzlos aus — "beim nächsten fälligen
// Zeitpunkt" ist dann eine Stunde später (Vorfall forge-pub1 2026-08-09:
// premium-pay verpasste seinen 5-Minuten-Slot, die Stunde blieb unbezahlt, der
// Anbieter lieferte deshalb eine Stunde lang keine Premium-Daten). Häufige Jobs
// verlieren dadurch nichts, seltene alles — deshalb wird nachgeholt statt
// verworfen.
const PENDING_F    = join(DATA, 'cron-pending.json');
// Ein nachgeholter Lauf ist nur so lange sinnvoll, wie sein Ergebnis noch aktuell
// ist. Nach einem sehr langen Deploy ist ein 3h alter forge-check wertlos; 60 Min
// deckt den relevanten Fall (stündliche Jobs) vollständig ab.
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;
const LOG_DIR   = join(PATHS.logs, 'cron');
const RUN_LOG   = join(LOG_DIR, 'forge-cron.log');

// ─── CLI-Argumente ─────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIST    = args.includes('--list');
const nowIdx  = args.indexOf('--now');
let NOW;
if (nowIdx !== -1) {
    const raw = args[nowIdx + 1];
    NOW = new Date(raw);
    if (isNaN(NOW.getTime())) {
        console.error(`✗ Ungültiges --now-Datum: "${raw}"`);
        process.exit(1);
    }
} else {
    NOW = new Date();
}

mkdirSync(LOCK_DIR, { recursive: true });
mkdirSync(LOG_DIR,  { recursive: true });

// ─── Logging (zentrale Runner-Übersicht) ───────────────────────────────────────
function ts() {
    return NOW.toLocaleString('sv'); // YYYY-MM-DD HH:MM:SS (Host-TZ)
}
// Wie ts(), aber fuer einen beliebigen Zeitpunkt – die Runner-Uebersicht friert NOW
// zum Minutenbeginn ein, ein Job-Log braucht dagegen die echte Start-/Endzeit.
function stamp(d) {
    return d.toLocaleString('sv'); // YYYY-MM-DD HH:MM:SS (Host-TZ)
}
function log(line) {
    const msg = `[${ts()}] ${line}`;
    console.log(msg);
    try { appendFileSync(RUN_LOG, msg + '\n'); } catch { /* Log darf nie den Lauf killen */ }
}

// ─── Job-State (data/cron-state.json) ───────────────────────────────────────────
function readState() {
    try {
        return JSON.parse(readFileSync(STATE_F, 'utf8'));
    } catch {
        return {};
    }
}
// Atomar (Temp + rename), Read-Modify-Write frisch von Platte – toleriert parallele
// Runner-Prozesse (jeder Job schreibt nur seinen eigenen Key).
function updateState(id, patch) {
    const state = readState();
    state[id] = { ...(state[id] || {}), ...patch };
    const tmp = `${STATE_F}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, STATE_F);
}

// ─── Nachhol-Liste (data/cron-pending.json) ─────────────────────────────────────
// Format: { "<jobId>": "<ISO-Zeit des ERSTEN verpassten Slots>" }. Bewusst der
// erste und nicht der letzte: die TTL soll ab dem Zeitpunkt laufen, an dem der Job
// eigentlich hätte laufen sollen.
function readPending() {
    try {
        const p = JSON.parse(readFileSync(PENDING_F, 'utf8'));
        return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
    } catch {
        return {};
    }
}
function writePending(pending) {
    try {
        if (Object.keys(pending).length === 0) {
            try { unlinkSync(PENDING_F); } catch { /* war schon weg */ }
            return;
        }
        const tmp = `${PENDING_F}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(pending, null, 2) + '\n');
        renameSync(tmp, PENDING_F);
    } catch (e) {
        // Eine nicht schreibbare Merkliste darf den Runner nie stoppen – im
        // schlimmsten Fall verhält er sich wie vor der Nachhol-Logik.
        log(`⚠ Nachhol-Liste nicht schreibbar (${e.message}) – verpasste Jobs gehen verloren`);
    }
}
/** Merkt die während eines Deploys übersprungenen Jobs vor (ältesten Zeitpunkt behalten). */
function rememberPending(jobsToRemember) {
    const pending = readPending();
    for (const job of jobsToRemember) {
        if (!pending[job.id]) pending[job.id] = NOW.toISOString();
    }
    writePending(pending);
}
/**
 * Gibt die nachzuholenden Jobs zurück und leert die Merkliste. Übersprungen werden
 * Einträge, die zu alt sind, deren Job es nicht mehr gibt bzw. der abgeschaltet
 * wurde, und solche, die ohnehin in diesem Tick fällig sind (kein Doppelstart).
 */
function takePending(dueNow, allJobs) {
    const pending = readPending();
    if (Object.keys(pending).length === 0) return [];

    const dueIds  = new Set(dueNow.map(j => j.id));
    const byId    = new Map(allJobs.map(j => [j.id, j]));
    const carried = [];
    for (const [id, missedAt] of Object.entries(pending)) {
        // Ein Zeitstempel in der Zukunft (Uhr-Sprung, manuell editierte Datei, Lauf
        // mit --now) ist kein gültiger verpasster Slot – sonst würde ein einziger
        // Zeitsprung Jobs beliebig lange nachschleppen.
        const ageMs = NOW.getTime() - new Date(missedAt).getTime();
        if (!Number.isFinite(ageMs) || ageMs < 0) {
            log(`↩ ${id}: Nachholung verworfen – Zeitstempel ${missedAt} liegt nicht in der Vergangenheit`);
            continue;
        }
        if (ageMs > PENDING_MAX_AGE_MS) {
            log(`↩ ${id}: Nachholung verworfen – verpasster Lauf von ${missedAt} ist zu alt`);
            continue;
        }
        if (dueIds.has(id)) continue;              // läuft in diesem Tick sowieso
        const job = byId.get(id);
        if (!job || job.enabled === false) continue; // inzwischen entfernt/abgeschaltet
        carried.push(job);
    }
    writePending({}); // in jedem Fall leeren – ein zweiter Nachholversuch bringt nichts
    return carried;
}

// ─── Locking ────────────────────────────────────────────────────────────────────
function lockPath(id) {
    return join(LOCK_DIR, `${id}.lock`);
}
/** true, wenn PID aktuell läuft. */
function pidAlive(pid) {
    try {
        process.kill(pid, 0); // Signal 0 tötet nicht, prüft nur Existenz/Rechte
        return true;
    } catch (e) {
        return e.code === 'EPERM'; // existiert, aber fremder User → als "lebt" werten
    }
}
/**
 * Versucht das Lock zu erwerben. Rückgabe:
 *   { acquired:true }                          – Lock gesetzt, Job darf laufen
 *   { acquired:false, since, pid }             – anderer Lauf aktiv, überspringen
 */
function acquireLock(id) {
    const p = lockPath(id);
    if (existsSync(p)) {
        let info = {};
        try { info = JSON.parse(readFileSync(p, 'utf8')); } catch { /* korrupt → als tot behandeln */ }
        if (info.pid && pidAlive(info.pid)) {
            return { acquired: false, since: info.startedAt, pid: info.pid };
        }
        // Stale Lock (Prozess tot / Datei korrupt) → entfernen und neu erwerben
        try { unlinkSync(p); } catch { /* egal */ }
    }
    writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: NOW.toISOString() }) + '\n');
    return { acquired: true };
}
function releaseLock(id) {
    try { unlinkSync(lockPath(id)); } catch { /* schon weg → ok */ }
}

// ─── Auflösung von cwd/command ──────────────────────────────────────────────────
function resolveCwd(job) {
    if (!job.cwd) return ROOT;
    return isAbsolute(job.cwd) ? job.cwd : join(ROOT, job.cwd);
}

// ─── Eine Zeile ins Job-Log schreiben (darf den Lauf nie killen) ────────────
function writeLine(fd, line) {
    try { writeSync(fd, line + '\n'); } catch { /* Log darf nie den Lauf killen */ }
}

// ─── Einen Job ausführen (Promise, resolved bei Prozess-Ende) ───────────────────
function runJob(job) {
    return new Promise((resolve) => {
        const cwd = resolveCwd(job);
        const jobLog = join(LOG_DIR, `${job.id}.log`);
        let fd;
        try {
            fd = openSync(jobLog, 'a');
        } catch (e) {
            log(`✗ ${job.id}: Log-Datei ${jobLog} nicht öffenbar (${e.message}) – überspringe`);
            releaseLock(job.id);
            resolve();
            return;
        }

        const started = Date.now();
        log(`▶ ${job.id} · ${job.command}${job.cwd ? ` (cwd ${job.cwd})` : ''}`);

        // Lauf-Kopfzeile ins Job-Log. Das Log wird bewusst angehaengt (kein Datenverlust),
        // ohne Trenner stehen die Ausgaben aller Laeufe aber ununterscheidbar hintereinander:
        // Am 27.08.2026 wurde der DB-Pfad-Fehler des Laufs vom 26.08. fuer einen aktuellen
        // Fehler gehalten, obwohl der Lauf darunter sauber war (CORE#0335).
        writeLine(fd, `── ${stamp(new Date(started))} · ${job.id} · ${job.command} ──`);

        const child = spawn(job.command, {
            cwd,
            shell: true,
            stdio: ['ignore', fd, 'pipe'],
        });

        // stderr weiterhin ins Job-Log schreiben (wie bisher gemeinsam mit stdout),
        // zusätzlich die letzten Zeilen puffern – damit ein Absturz mit Exit-Code
        // sich direkt aus cron-state.json diagnostizieren lässt, ohne das Log
        // manuell durchsuchen zu müssen (siehe forge-pub#0301).
        let stderrTail = '';
        const STDERR_TAIL_MAX = 500;
        child.stderr.on('data', (chunk) => {
            try { writeSync(fd, chunk); } catch { /* Log darf nie den Lauf killen */ }
            stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX);
        });

        const finish = (exitCode, errMsg) => {
            const durationMs = Date.now() - started;
            // errMsg ist der stderr-Auszug und kann mehrzeilig sein – fuer die Fusszeile
            // auf eine Zeile zusammenziehen, sonst zerfaellt der Trenner.
            const reason = errMsg ? errMsg.replace(/\s+/g, ' ').trim().slice(0, 120) : null;
            const outcome = exitCode === null ? `abgebrochen · ${reason}`
                          : reason ? `Exit ${exitCode} · ${reason}`
                          : `Exit ${exitCode}`;
            writeLine(fd, `── ${stamp(new Date())} · ${job.id} · ${outcome} · `
                        + `${(durationMs / 1000).toFixed(1)}s ──\n`);
            try { closeSync(fd); } catch { /* egal */ }
            const patch = {
                lastRun: new Date().toISOString(),
                lastExitCode: exitCode,
                lastDurationMs: durationMs,
            };
            if (errMsg) patch.lastError = errMsg; else patch.lastError = null;
            try { updateState(job.id, patch); } catch (e) { log(`⚠ ${job.id}: State-Update fehlgeschlagen (${e.message})`); }
            releaseLock(job.id);
            const secs = (durationMs / 1000).toFixed(1);
            if (errMsg) {
                log(`✗ ${job.id}: ${errMsg} (${secs}s)`);
            } else if (exitCode === 0) {
                log(`✓ ${job.id} · Exit 0 · ${secs}s`);
            } else {
                log(`✗ ${job.id} · Exit ${exitCode} · ${secs}s`);
            }
            resolve();
        };

        child.on('error', (err) => finish(null, `Startfehler: ${err.message}`));
        child.on('close', (code, signal) => {
            if (signal) finish(null, `beendet durch Signal ${signal}`);
            else if (code !== 0 && stderrTail.trim()) finish(code, stderrTail.trim().slice(-300));
            else finish(code, null);
        });
    });
}

// ─── Modus: --list ──────────────────────────────────────────────────────────────
if (LIST) {
    const jobs  = listJobs();
    const state = readState();
    console.log(`FORGE Cron – ${jobs.length} Jobs (Stand ${ts()})\n`);
    for (const job of jobs) {
        const s   = state[job.id] || {};
        const en  = job.enabled === false ? 'AUS' : 'an';
        const due = (() => { try { return cronMatches(job.schedule, NOW) ? 'JETZT fällig' : ''; } catch { return 'SCHEDULE-FEHLER'; } })();
        const last = s.lastRun ? `zuletzt ${s.lastRun} (Exit ${s.lastExitCode}${s.lastError ? `, ${s.lastError}` : ''})` : 'noch nie gelaufen';
        console.log(`  [${en}] ${job.id.padEnd(24)} ${job.schedule.padEnd(14)} ${due.padEnd(14)} ${last}`);
    }
    process.exit(0);
}

// ─── Modus: fällige Jobs bestimmen ──────────────────────────────────────────────
const jobs = listJobs();
const due  = [];
for (const job of jobs) {
    if (job.enabled === false) continue;
    let match;
    try {
        match = cronMatches(job.schedule, NOW);
    } catch (e) {
        log(`✗ ${job.id}: ungültiger Schedule "${job.schedule}" – ${e.message}`);
        continue;
    }
    if (match) due.push(job);
}

if (DRY_RUN) {
    log(`DRY-RUN @ ${NOW.toISOString()} – ${due.length} Job(s) fällig:`);
    for (const job of due) log(`  · ${job.id} (${job.schedule}) → ${job.command}`);
    process.exit(0);
}

if (existsSync(DEPLOY_LOCK)) {
    // Bewusst KEIN Job-State-Update hier (weder ok noch error) – die Jobs sind
    // schlicht nicht gestartet, das ist kein Lauf-Ergebnis. health-check.js
    // sieht dadurch weiterhin nur den letzten ECHTEN Lauf, nie einen
    // Deploy-bedingten Fehlschlag.
    if (due.length > 0) {
        rememberPending(due);
        log(`⏸ Deploy läuft (${DEPLOY_LOCK}) – ${due.length} fällige(r) Job(s) für die Nachholung vorgemerkt: `
            + due.map(j => j.id).join(', '));
    }
    process.exit(0);
}

// Nach dem Deploy: verpasste Jobs einsammeln. Muss VOR dem Leerlauf-Ausstieg
// stehen – sonst würde ein nachzuholender Job nur dann starten, wenn zufällig im
// selben Tick etwas anderes fällig ist.
const carried = takePending(due, jobs);
if (carried.length > 0) {
    log(`↩ Nachholung nach Deploy: ${carried.map(j => j.id).join(', ')}`);
    due.push(...carried);
}

if (due.length === 0) {
    // Kein Log-Spam bei Leerlauf (jede Minute!) – still beenden.
    process.exit(0);
}

// ─── Fällige Jobs parallel starten ──────────────────────────────────────────────
const promises = [];
for (const job of due) {
    const lock = acquireLock(job.id);
    if (!lock.acquired) {
        const sinceSecs = lock.since ? ((Date.now() - new Date(lock.since).getTime()) / 1000).toFixed(0) : '?';
        log(`⏭ ${job.id}: übersprungen – läuft noch (PID ${lock.pid}, seit ${sinceSecs}s)`);
        continue;
    }
    promises.push(runJob(job));
}

// Runner bleibt am Leben, bis alle gestarteten Jobs fertig sind (State + Lock-Cleanup).
await Promise.all(promises);
process.exit(0);
