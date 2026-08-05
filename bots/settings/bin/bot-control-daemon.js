/**
 * forge-settings-daemon – Privileged Bot-Control Task Runner
 *
 * Läuft mit demselben eingeschränkten User wie die anderen FORGE-Services
 * (nicht root). Pollt alle 2s data/settings.db auf ausstehende Tasks und
 * führt whitelistete systemctl-Befehle über 'sudo' aus – eine enggeschnittene
 * sudoers-NOPASSWD-Regel erlaubt genau diese Kommandos (siehe bin/install.sh
 * bzw. für den Master die entsprechende manuelle Einrichtung).
 *
 * 'sudo -n' ist ein No-Op, falls der Prozess ausnahmsweise doch als root läuft
 * (root braucht kein sudo, sudo führt den Befehl dann direkt aus) – bricht
 * also nicht rückwärtskompatibel.
 *
 * Sicherheit:
 *   - Nur fest definierte Services (ALLOWED_SERVICES) erlaubt
 *   - Nur start / stop / restart erlaubt
 *   - Kein Shell-Aufruf – execFile() mit explizitem Pfad
 *   - sudoers-Regel ist die zweite, unabhängige Schicht: selbst bei einem Bug
 *     hier könnte höchstens einer der exakt gelisteten Befehle ausgeführt werden
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';
import { listBots } from '../../../lib/bot-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const DB_PATH      = PATHS.settingsDb;
const POLL_INTERVAL = 2000; // ms

// Whitelist kommt aus config/bots.json (siehe lib/bot-registry.js) – einzige
// Quelle der Wahrheit für gültige Service-Namen (Sicherheitsrelevant: steuert
// privilegierte systemctl-Aufrufe).
const ALLOWED_SERVICES = new Set(listBots().map(([, bot]) => bot.service));

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

const SUDO      = '/usr/bin/sudo';
const SYSTEMCTL = '/usr/bin/systemctl';

// ── DB-Init ───────────────────────────────────────────────────────────────────
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

// ── Task ausführen ────────────────────────────────────────────────────────────
async function runTask(db, task) {
    const { id, action, target } = task;

    if (!ALLOWED_SERVICES.has(target) || !ALLOWED_ACTIONS.has(action)) {
        db.prepare(`UPDATE tasks SET status='failed', finished_at=?, error=? WHERE id=?`)
          .run(Date.now(), `Nicht erlaubt: ${action} ${target}`, id);
        console.warn(`[daemon] Abgelehnt: ${action} ${target}`);
        return;
    }

    db.prepare(`UPDATE tasks SET status='running', started_at=? WHERE id=?`)
      .run(Date.now(), id);

    console.log(`[daemon] Führe aus: systemctl ${action} ${target}`);

    try {
        const { stdout, stderr } = await execFileAsync(SUDO, ['-n', SYSTEMCTL, action, target]);
        const output = (stdout + stderr).trim();
        db.prepare(`UPDATE tasks SET status='done', finished_at=?, output=? WHERE id=?`)
          .run(Date.now(), output || '(ok)', id);
        console.log(`[daemon] OK: ${action} ${target}`);
    } catch (err) {
        const errMsg = (err.stderr || err.message || '').trim();
        db.prepare(`UPDATE tasks SET status='failed', finished_at=?, error=? WHERE id=?`)
          .run(Date.now(), errMsg, id);
        console.error(`[daemon] Fehler: ${action} ${target} – ${errMsg}`);
    }
}

// ── Poll-Loop ─────────────────────────────────────────────────────────────────
async function poll() {
    let db;
    try {
        db = openDb();
        const pending = db.prepare(
            `SELECT * FROM tasks WHERE status='pending' ORDER BY created_at ASC LIMIT 5`
        ).all();

        for (const task of pending) {
            await runTask(db, task);
        }
    } catch (err) {
        console.error('[daemon] Poll-Fehler:', err.message);
    } finally {
        db?.close();
    }
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log(`[daemon] forge-settings-daemon gestartet (DB: ${DB_PATH})`);
console.log(`[daemon] Erlaubte Services: ${[...ALLOWED_SERVICES].join(', ')}`);

setInterval(poll, POLL_INTERVAL);
poll(); // Sofort beim Start
