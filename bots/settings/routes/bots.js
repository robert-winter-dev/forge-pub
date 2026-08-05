/**
 * /api/bots – Bot-Status und Task-Queue
 *
 * GET  /api/bots               → Alle Services mit aktuellem systemd-Status
 * POST /api/bots/:svc/:action  → Task in Queue einreihen (start/stop/restart)
 * GET  /api/bots/tasks/:id     → Task-Status abfragen (für Polling)
 */

import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';
import { listBots } from '../../../lib/bot-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const DB_PATH = PATHS.settingsDb;

// Aus config/bots.json (siehe lib/bot-registry.js). "settings-daemon" bleibt
// bewusst außen vor – der Daemon steuert die anderen Services und soll sich
// nicht selbst per Dashboard-Klick neu starten können.
const SERVICES = listBots()
    .filter(([botId]) => botId !== 'settings-daemon')
    .map(([, bot]) => ({ id: bot.service, label: bot.displayName }));

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

function openDb() {
    const db = new Database(DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at  INTEGER NOT NULL,
            started_at  INTEGER,
            finished_at INTEGER,
            status      TEXT    NOT NULL DEFAULT 'pending',
            action      TEXT    NOT NULL,
            target      TEXT    NOT NULL,
            output      TEXT,
            error       TEXT
        )
    `);
    return db;
}

const router = Router();

// ── GET /api/bots ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    const results = await Promise.all(SERVICES.map(async (svc) => {
        try {
            const { stdout } = await execFileAsync('/usr/bin/systemctl', ['is-active', svc.id]);
            return { ...svc, status: stdout.trim() };
        } catch (err) {
            // systemctl is-active gibt exit 3 zurück wenn inactive – kein echter Fehler
            return { ...svc, status: err.stdout?.trim() || 'unknown' };
        }
    }));
    res.json(results);
});

// ── POST /api/bots/:svc/:action ───────────────────────────────────────────────
router.post('/:svc/:action', (req, res) => {
    const { svc, action } = req.params;

    const known = SERVICES.find(s => s.id === svc);
    if (!known) {
        return res.status(400).json({ error: `Unbekannter Service: ${svc}` });
    }
    if (!ALLOWED_ACTIONS.has(action)) {
        return res.status(400).json({ error: `Unerlaubte Aktion: ${action}` });
    }

    const db = openDb();
    const result = db.prepare(
        `INSERT INTO tasks (created_at, status, action, target) VALUES (?, 'pending', ?, ?)`
    ).run(Date.now(), action, svc);
    db.close();

    res.json({ taskId: result.lastInsertRowid });
});

// ── GET /api/bots/tasks/:id ───────────────────────────────────────────────────
// WICHTIG: Diese Route muss vor /:svc/:action stehen (sonst matcht "tasks" als :svc)
router.get('/tasks/:id', (req, res) => {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
    db.close();

    if (!task) return res.status(404).json({ error: 'Task nicht gefunden' });
    res.json(task);
});

export default router;
