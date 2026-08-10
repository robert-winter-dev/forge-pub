/**
 * /api/update – System > Updates (nur FORGE.pub-Fork)
 *
 * GET  /status            → Ergebnis von bin/update-check.js (bereitliegendes, noch
 *                            nicht eingespieltes Update). Siehe html/js/nav.js.
 * GET  /result             → Ausgang des letzten Apply-Versuchs (last-update-result.json)
 * GET  /policy             → { autoApplyPatch }
 * POST /policy             → { autoApplyPatch } setzen
 * POST /check               → Task 'check' einreihen (Update-Prüfung jetzt anstoßen)
 * POST /apply               → Task 'apply' einreihen (Update jetzt einspielen, übergeht Policy)
 * POST /rollback            → Task 'rollback' einreihen – NUR erlaubt, wenn der letzte
 *                             Apply-Versuch mit 'rollback-failed' endete (siehe unten)
 * POST /selftest            → bin/self-test.js synchron ausführen (kein Queue-Umweg, Sekunden)
 * GET  /tasks/:id            → Update-Task-Status (Polling)
 *
 * check/apply/rollback laufen alle über bot-control-daemon.js (sudo -n, feste
 * Kommandozeilen ohne Argument-Interpolation, siehe dort UPDATE_COMMANDS) – dieser
 * Router selbst führt nie ein privilegiertes Kommando aus.
 */

import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';
import { ensureUpdateSchema, readLog, finalizeIfFinished } from '../lib/update-tasks.js';

const execFileAsync = promisify(execFile);

const UPDATE_STATUS_PATH = path.join(PATHS.data, 'update-status.json');
const LAST_RESULT_PATH   = path.join(PATHS.data, 'last-update-result.json');
// local/update-policy.json liegt eine Ebene ÜBER local/data/ (siehe
// bin/update-check.js readPolicy() – dieselbe Herleitung, PATHS.data ist dort LOCAL_DIR/data).
const POLICY_PATH = path.join(PATHS.data, '..', 'update-policy.json');
const SELF_TEST_PATH = path.join(PATHS.root, 'bin', 'self-test.js');

const DB_PATH = PATHS.settingsDb;
const ALLOWED_UPDATE_ACTIONS = new Set(['check', 'apply', 'rollback']);

// Schema/Migration liegt in ../lib/update-tasks.js – dieselbe Definition wie im
// Daemon, damit die Reihenfolge des Prozessstarts egal ist.
function openDb() {
    return ensureUpdateSchema(new Database(DB_PATH));
}

const router = Router();

// "Erzeugt: <ISO8601>"-Zeile aus der VERSION-Datei (siehe tools/pub-export/
// build-artifact.js) – das Datum, an dem DIESE Version gebaut/veröffentlicht
// wurde, identisch auf jeder Installation. Bewusst NICHT die mtime der Datei
// (das wäre der lokale Installationszeitpunkt auf diesem Host und würde von
// Host zu Host unterschiedlich sein, obwohl es dieselbe Version ist).
function releasedAt() {
    try {
        const content = readFileSync(path.join(PATHS.root, 'VERSION'), 'utf8');
        const match = content.match(/^Erzeugt:\s*(\S+)/m);
        return match ? new Date(match[1]).getTime() : null;
    } catch {
        return null;
    }
}

// ── GET /status ────────────────────────────────────────────────────────────────
router.get('/status', (_req, res) => {
    const base = { releasedAt: releasedAt() };
    if (!existsSync(UPDATE_STATUS_PATH)) {
        return res.json({ ...base, available: false });
    }
    try {
        const status = JSON.parse(readFileSync(UPDATE_STATUS_PATH, 'utf8'));
        res.json({ ...base, available: true, ...status });
    } catch (err) {
        res.status(500).json({ ...base, available: false, error: err.message });
    }
});

// ── GET /result ────────────────────────────────────────────────────────────────
router.get('/result', (_req, res) => {
    if (!existsSync(LAST_RESULT_PATH)) {
        return res.json({ present: false });
    }
    try {
        const result = JSON.parse(readFileSync(LAST_RESULT_PATH, 'utf8'));
        res.json({ present: true, ...result });
    } catch (err) {
        res.status(500).json({ present: false, error: err.message });
    }
});

// ── GET/POST /policy ─────────────────────────────────────────────────────────────
router.get('/policy', (_req, res) => {
    if (!existsSync(POLICY_PATH)) {
        return res.json({ autoApplyPatch: false });
    }
    try {
        res.json(JSON.parse(readFileSync(POLICY_PATH, 'utf8')));
    } catch {
        res.json({ autoApplyPatch: false });
    }
});

router.post('/policy', (req, res) => {
    const { autoApplyPatch } = req.body ?? {};
    if (typeof autoApplyPatch !== 'boolean') {
        return res.status(400).json({ error: 'autoApplyPatch muss ein Boolean sein' });
    }
    try {
        mkdirSync(path.dirname(POLICY_PATH), { recursive: true });
        writeFileSync(POLICY_PATH, JSON.stringify({ autoApplyPatch }, null, 2) + '\n');
        res.json({ autoApplyPatch });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Task einreihen (check/apply/rollback) ─────────────────────────────────────
function enqueueUpdateTask(action, res) {
    const db = openDb();
    try {
        // Erst abgeschlossene Detached-Läufe nachtragen – sonst würde ein Task,
        // dessen Prozess längst fertig ist, jede weitere Aktion dauerhaft mit
        // 409 blockieren (der Daemon tut dasselbe in seinem Poll-Loop).
        let active = db.prepare(
            `SELECT * FROM update_tasks WHERE status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1`
        ).get();
        if (active) active = finalizeIfFinished(db, active);
        if (active && (active.status === 'pending' || active.status === 'running')) {
            return res.status(409).json({ error: `Es läuft bereits eine Update-Aktion (${active.action}) – bitte abwarten.`, taskId: active.id });
        }
        const result = db.prepare(
            `INSERT INTO update_tasks (created_at, status, action) VALUES (?, 'pending', ?)`
        ).run(Date.now(), action);
        res.json({ taskId: result.lastInsertRowid });
    } finally {
        db.close();
    }
}

// ── POST /check ────────────────────────────────────────────────────────────────
router.post('/check', (_req, res) => enqueueUpdateTask('check', res));

// ── POST /apply ────────────────────────────────────────────────────────────────
router.post('/apply', (_req, res) => enqueueUpdateTask('apply', res));

// ── POST /rollback ───────────────────────────────────────────────────────────────
// 🔒 Sicherheitsgrenze (bewusste Entscheidung): NUR anbieten, wenn der letzte
// automatische Rollback-Versuch selbst fehlgeschlagen ist. Bei 'stopped-migration'
// (Datenbank bereits migriert) wäre ein Rollback gefährlicher als der aktuelle
// Zustand – dieselbe Grenze wie in bin/update-check.js (hasMigrations-Zweig).
router.post('/rollback', (_req, res) => {
    if (!existsSync(LAST_RESULT_PATH)) {
        return res.status(409).json({ error: 'Kein Update-Ergebnis vorhanden – Rollback nicht möglich.' });
    }
    let lastResult;
    try {
        lastResult = JSON.parse(readFileSync(LAST_RESULT_PATH, 'utf8'));
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    if (lastResult.status !== 'rollback-failed') {
        return res.status(409).json({
            error: 'Rollback ist nur verfügbar, wenn der letzte automatische Rückroll-Versuch fehlgeschlagen ist.',
            status: lastResult.status,
        });
    }
    enqueueUpdateTask('rollback', res);
});

// ── POST /selftest ────────────────────────────────────────────────────────────────
// Läuft synchron und unprivilegiert (nur systemctl is-active/is-enabled) – kein
// Queue-Umweg nötig, dauert wenige Sekunden.
router.post('/selftest', async (_req, res) => {
    try {
        const { stdout } = await execFileAsync('/usr/bin/node', [SELF_TEST_PATH, '--json']);
        res.json(JSON.parse(stdout));
    } catch (err) {
        // self-test.js setzt exitCode=1 bei gefundenen Problemen – trotzdem gültiges JSON auf stdout.
        if (err.stdout) {
            try { return res.json(JSON.parse(err.stdout)); } catch { /* fällt durch zum Fehlerpfad */ }
        }
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── GET /tasks/:id ───────────────────────────────────────────────────────────────
// 'output' kommt aus der LOGDATEI, die der Update-Prozess selbst schreibt – nicht
// aus einer DB-Spalte, die ein Elternprozess füllen müsste (der wird vom Update
// mitgestoppt, siehe ../lib/update-tasks.js). Dadurch bleibt der Live-Fortschritt
// auch dann sichtbar, wenn Daemon und dieser Server zwischendurch neu starten.
router.get('/tasks/:id', (req, res) => {
    const db = openDb();
    try {
        let task = db.prepare('SELECT * FROM update_tasks WHERE id = ?').get(Number(req.params.id));
        if (!task) return res.status(404).json({ error: 'Task nicht gefunden' });
        task = finalizeIfFinished(db, task);
        res.json({ ...task, output: readLog(task.id) || task.output || '' });
    } finally {
        db.close();
    }
});

export default router;
