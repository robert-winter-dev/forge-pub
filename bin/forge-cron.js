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
import { openSync, closeSync, mkdirSync, existsSync, readFileSync, writeFileSync,
         appendFileSync, renameSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
import { listJobs, cronMatches } from '../lib/cron-registry.js';
import { PATHS } from '../config/paths.js';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA      = join(ROOT, 'data');
const LOCK_DIR  = join(DATA, 'cron-locks');
const STATE_F   = join(DATA, 'cron-state.json');
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

        const child = spawn(job.command, {
            cwd,
            shell: true,
            stdio: ['ignore', fd, fd],
        });

        const finish = (exitCode, errMsg) => {
            try { closeSync(fd); } catch { /* egal */ }
            const durationMs = Date.now() - started;
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
