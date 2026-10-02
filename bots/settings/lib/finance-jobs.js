/**
 * FORGE – Finanzaktionen als losgelöste Jobs (CORE#000993)
 *
 * Einzahlung, Entnahme und Burn aus der Settings-Oberfläche laufen als eigener
 * Prozess, der einen Neustart von forge-settings überlebt:
 *   - `detached: true` + stdout/stderr in Dateien statt Pipes. Mit Pipes stürbe das
 *     Kind beim ersten Schreiben (EPIPE), sobald server.js weg ist.
 *   - Die Unit hat `KillMode=process` (bots/settings/forge-settings.service), systemd
 *     beendet beim Stop also nur server.js, nicht die cgroup.
 *   - Kein Timeout beendet das Kind. Die Route wartet eine Weile auf das Ergebnis und
 *     antwortet danach mit `pending` + Job-ID; die Oberfläche fragt den Status ab.
 *   - Nach einem Neustart hängt `resumeJobs()` die Überwachung wieder an und führt die
 *     Nacharbeit (Export, Lock lösen, Log) aus, sobald der Prozess fertig ist.
 *
 * Ablage: <DATA_ROOT>/finance-jobs/<id>.json (Metadaten + Ergebnis), <id>.out, <id>.err.
 * Begründung: KB `Core/settings-finanz-jobs.md`, CORE#000993.
 */

import fs     from 'node:fs';
import path   from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { PATHS } from '../../../config/paths.js';

const WATCH_MS   = 1_000;
const MAX_AGE_MS = 7 * 86_400_000;   // Aufräumen: fertige Jobs älter als 7 Tage

let JOBS_DIR = path.join(PATHS.data, 'finance-jobs');

/** Nur für Tests: Ablageort umbiegen. */
export function _setJobsDir(dir) { JOBS_DIR = dir; }

/** kind → { onDone(result, job) → result } — Nacharbeit nach Prozessende, auch nach Neustart. */
const kinds    = new Map();
/** id → Promise<job>, aufgelöst beim Abschluss (nur im laufenden server.js-Prozess). */
const watchers = new Map();

export function registerKind(kind, { onDone } = {}) {
    kinds.set(kind, { onDone: onDone ?? (r => r) });
}

const metaPath = id => path.join(JOBS_DIR, `${id}.json`);
const outPath  = id => path.join(JOBS_DIR, `${id}.out`);
const errPath  = id => path.join(JOBS_DIR, `${id}.err`);

function readJob(id) {
    if (!/^[a-z0-9-]+$/.test(String(id))) return null;
    try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch { return null; }
}

function writeJob(job) {
    const tmp = `${metaPath(job.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
    fs.renameSync(tmp, metaPath(job.id));
}

function listJobs() {
    let files = [];
    try { files = fs.readdirSync(JOBS_DIR).filter(f => f.endsWith('.json')); } catch { return []; }
    return files.map(f => readJob(f.slice(0, -5))).filter(Boolean);
}

/** Läuft der Prozess noch — und ist es noch derselbe (PID-Wiederverwendung)? */
function isAlive(job) {
    try { process.kill(job.pid, 0); } catch { return false; }
    try {
        const stat = fs.readFileSync(`/proc/${job.pid}/stat`, 'utf8');
        if (/^\d+ \(.*\) Z /.test(stat)) return false;               // Zombie = beendet
        return fs.readFileSync(`/proc/${job.pid}/cmdline`, 'utf8').includes(job.script);
    } catch {
        return true;   // ohne /proc (kein Linux) bleibt nur der kill-0-Befund
    }
}

/** Letzte JSON-Zeile aus stdout — dasselbe Protokoll wie die bisherigen runCli()-Helfer. */
export function parseCliResult(stdout, stderr = '') {
    const line = stdout.split('\n').map(l => l.trim()).filter(Boolean)
        .reverse().find(l => l.startsWith('{') && l.endsWith('}'));
    if (!line) return { ok: false, error: 'no_json_output', stderr: stderr.slice(-500) };
    try { return JSON.parse(line); }
    catch (err) { return { ok: false, error: `json_parse_failed: ${err.message}` }; }
}

/** Prozess ist beendet → Ergebnis lesen, Nacharbeit genau einmal, Meta festschreiben. */
async function finalize(id) {
    const job = readJob(id);
    if (!job || job.status !== 'running') return job;
    // Status zuerst festschreiben: ein zweiter finalize()-Aufruf (Watcher + Status-Abfrage
    // gleichzeitig) darf die Nacharbeit nicht doppelt auslösen.
    writeJob({ ...job, status: 'finalizing' });
    let stdout = '', stderr = '';
    try { stdout = fs.readFileSync(outPath(id), 'utf8'); } catch { /* leer */ }
    try { stderr = fs.readFileSync(errPath(id), 'utf8'); } catch { /* leer */ }
    let result = parseCliResult(stdout, stderr);
    try {
        const handler = kinds.get(job.kind);
        if (handler) result = (await handler.onDone(result, job)) ?? result;
    } catch (err) {
        console.error(`[finance-jobs] Nacharbeit ${job.kind} ${id} fehlgeschlagen: ${err.message}`);
    }
    const done = { ...job, status: 'done', finishedAt: Date.now(), result };
    writeJob(done);
    return done;
}

function watch(id) {
    if (watchers.has(id)) return watchers.get(id);
    const p = new Promise(resolve => {
        const tick = async () => {
            const job = readJob(id);
            if (!job) return resolve(null);
            if (job.status === 'done') return resolve(job);
            if (job.status === 'running' && !isAlive(job)) return resolve(await finalize(id));
            setTimeout(tick, WATCH_MS);
        };
        setTimeout(tick, WATCH_MS);
    });
    watchers.set(id, p);
    p.finally(() => watchers.delete(id));
    return p;
}

/** Laufender Job zu einem Schlüssel (z.B. `liq:liq-gmex-usdc`), sonst null. */
export function runningJobFor(key) {
    return listJobs().find(j => j.key === key && j.status !== 'done'
        && (j.status !== 'running' || isAlive(j))) ?? null;
}

/**
 * Startet ein Skript als losgelösten Job.
 * @returns {{ job?: object, conflict?: object }}  conflict = bereits laufender Job zum Schlüssel
 */
export function startJob({ kind, key, ref = null, script, args = [], cwd, meta = {} }) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    const conflict = runningJobFor(key);
    if (conflict) return { conflict };

    const id  = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const out = fs.openSync(outPath(id), 'w');
    const err = fs.openSync(errPath(id), 'w');
    let proc;
    try {
        proc = spawn(process.execPath, [script, ...args], { cwd, detached: true, stdio: ['ignore', out, err] });
    } finally {
        fs.closeSync(out);
        fs.closeSync(err);
    }
    // Ohne Handler würde ein spawn-Fehler (ENOENT, z.B. fehlendes Bot-Verzeichnis im Fork)
    // server.js über ein unbehandeltes 'error'-Event abstürzen lassen.
    proc.on('error', e => {
        try { fs.appendFileSync(errPath(id), `\n[finance-jobs] spawn-Fehler: ${e.message}\n`); } catch { /* egal */ }
    });
    const job = { id, kind, key, ref: sanitizeRef(ref), script, args, cwd, meta, pid: proc.pid ?? -1, status: 'running', startedAt: Date.now() };
    writeJob(job);
    proc.unref();
    watch(id);
    return { job };
}

/**
 * Wartet bis zu `waitMs` auf das Ergebnis. Beendet den Prozess nie.
 * @returns {Promise<object>} fertiger Job (`status: 'done'`) oder der noch laufende Job
 */
export async function waitForJob(id, waitMs) {
    let timer;
    const timeout = new Promise(r => { timer = setTimeout(() => r(null), waitMs); });
    const job = await Promise.race([watch(id), timeout]);
    clearTimeout(timer);
    return job ?? readJob(id);
}

/** Status für die Oberfläche; stößt bei beendetem Prozess die Nacharbeit an. */
export async function getJob(id) {
    const job = readJob(id);
    if (!job) return null;
    if (job.status === 'running' && !isAlive(job)) return finalize(id);
    return job;
}

/** Kennung, die die Oberfläche beim Start mitschickt (Wiederanschluss nach Verbindungsabbruch). */
function sanitizeRef(ref) {
    return typeof ref === 'string' && /^[\w-]{8,64}$/.test(ref) ? ref : null;
}

/**
 * Job zu Schlüssel + Kennung der Oberfläche. Bewusst über die Kennung und nicht über eine
 * Startzeit: Browser- und Serveruhr können abweichen, ein Zeitfenster träfe dann einen
 * älteren Job desselben Pools und zeigte dessen Ergebnis.
 */
export async function jobByRef(key, ref) {
    const r = sanitizeRef(ref);
    if (!r) return null;
    const hit = listJobs().find(j => j.key === key && j.ref === r);
    return hit ? getJob(hit.id) : null;
}

/** Beim Start von server.js: laufende Jobs wieder überwachen, alte aufräumen. */
export function resumeJobs() {
    const now = Date.now();
    for (const job of listJobs()) {
        if (job.status === 'done') {
            if (now - (job.finishedAt ?? job.startedAt) > MAX_AGE_MS) {
                for (const p of [metaPath(job.id), outPath(job.id), errPath(job.id)]) {
                    try { fs.unlinkSync(p); } catch { /* schon weg */ }
                }
            }
            continue;
        }
        // 'finalizing' ohne Abschluss = Neustart mitten in der Nacharbeit → neu anstoßen.
        if (job.status === 'finalizing') writeJob({ ...job, status: 'running' });
        console.log(`[finance-jobs] überwache weiter: ${job.kind} ${job.id} (PID ${job.pid})`);
        watch(job.id);
    }
}

/** Antwortform für die Routen: fertiges Ergebnis oder „läuft noch“ (HTTP 202). */
export function jobResponse(job, stillRunningMsg) {
    if (job?.status === 'done') return { status: job.result?.ok ? 200 : 409, body: { ...job.result, jobId: job.id } };
    return { status: 202, body: { ok: false, pending: true, jobId: job?.id, error: stillRunningMsg } };
}

/** Öffentliche Sicht auf einen Job (ohne Pfade/Argumente). */
export function publicJob(job) {
    if (!job) return null;
    return { id: job.id, kind: job.kind, key: job.key, status: job.status === 'done' ? 'done' : 'running',
             startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, result: job.result ?? null };
}
