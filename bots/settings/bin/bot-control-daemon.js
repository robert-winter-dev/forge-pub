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

import { execFile, spawn } from 'child_process';
import { closeSync } from 'fs';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';
import { listBots } from '../../../lib/bot-registry.js';
import { ensureUpdateSchema, openLogFd, logPathFor, finalizeIfFinished } from '../lib/update-tasks.js';

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

// ── System > Updates (Webinterface) ──────────────────────────────────────────
// Feste, vollständige Kommandozeilen — exakt dieselben drei, die do_user()
// (bin/setup-lib/packages.sh) als Cmnd_Alias FORGE_UPDATE_CHECK/APPLY/ROLLBACK
// in die sudoers-Regel schreibt. KEINE Argument-Interpolation aus der DB:
// die Aktion ('check'/'apply'/'rollback') wählt nur, welches der drei fest
// verdrahteten argv-Arrays ausgeführt wird, nie deren Inhalt.
const APP_DIR = PATHS.root;
const NODE    = '/usr/bin/node';
const BASH    = '/bin/bash';
const UPDATE_COMMANDS = {
    check:    [NODE, path.join(APP_DIR, 'bin/update-check.js')],
    apply:    [NODE, path.join(APP_DIR, 'bin/update-check.js'), '--confirm'],
    rollback: [BASH, path.join(APP_DIR, 'bin/setup.sh'), 'rollback-code', '--non-interactive', '--yes'],
};

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
    // Getrennt von 'tasks' (kurze systemctl-Calls, 2s-Polling): Update-Aktionen
    // laufen mehrere Minuten (npm install, Deploy, Health-Gate-Wartezeit) und
    // sollen sich nicht mit Bot-Start/Stop-Tasks vermischen.
    ensureUpdateSchema(db);
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

// ── Update-Task ausführen ─────────────────────────────────────────────────────
// Nur EINE laufen lassen: ein zweiter Apply/Rollback mitten in einem laufenden
// Deploy wäre zerstörerisch (gleichzeitiges rm -rf/tar auf APP_DIR). Die
// POST-Routen in bots/settings/routes/update.js reihen ohnehin nur ein, wenn
// kein anderer update_task gerade 'running' ist (dort geprüft) — dieser
// Poll-Loop wählt hier zusätzlich defensiv nur den jeweils ältesten aus.
// 🔒 DETACHED, bewusst OHNE auf das Ende zu warten (Architekturfix 2026-08-10):
// Ein Update stoppt alle sechs Dienste — darunter diesen Daemon selbst. Ein hier
// gehaltener Puffer, ein setInterval-Flush oder ein child.on('close')-Handler
// wären damit genau dann weg, wenn sie gebraucht würden: der Task bliebe für
// immer auf 'running' stehen. Deshalb schreibt der Update-Prozess seine Ausgabe
// SELBST in eine Logdatei (stdio direkt auf den File-Descriptor) und läuft in
// einer eigenen Prozessgruppe weiter, auch wenn dieser Daemon stirbt. Der
// Endzustand wird später aus PID + Log abgeleitet (finalizeIfFinished).
// Siehe ausführliche Begründung im Kopf von ../lib/update-tasks.js.
function runUpdateTask(db, task) {
    const { id, action } = task;
    const argv = UPDATE_COMMANDS[action];

    if (!argv) {
        db.prepare(`UPDATE update_tasks SET status='failed', finished_at=?, error=? WHERE id=?`)
          .run(Date.now(), `Unbekannte Update-Aktion: ${action}`, id);
        console.warn(`[daemon] Update-Task abgelehnt: ${action}`);
        return;
    }

    let fd;
    try {
        fd = openLogFd(id);
        const [cmd, ...args] = argv;
        const child = spawn(SUDO, ['-n', cmd, ...args], {
            detached: true,               // eigene Prozessgruppe – überlebt das Stoppen des Daemons
            stdio: ['ignore', fd, fd],    // Ausgabe geht direkt in die Datei, kein Elternprozess nötig
        });
        child.unref();                    // Daemon darf sich beenden, ohne auf das Kind zu warten

        db.prepare(`UPDATE update_tasks SET status='running', started_at=?, pid=?, log_path=? WHERE id=?`)
          .run(Date.now(), child.pid, logPathFor(id), id);
        console.log(`[daemon] Update-Aktion gestartet: ${action} (PID ${child.pid}, Log ${logPathFor(id)})`);

        // Bonus, KEINE Voraussetzung: überlebt der Daemon den Lauf (z.B. bei
        // 'check', das keine Dienste stoppt), tragen wir den echten Exit-Code
        // nach – genauer als die Log-Heuristik in finalizeIfFinished(). Stirbt
        // der Daemon (apply/rollback), greift eben jene Heuristik. Das WHERE
        // verhindert, dass ein bereits abgeschlossener Task überschrieben wird.
        child.on('close', (code) => {
            try {
                const db2 = openDb();
                try {
                    db2.prepare(`UPDATE update_tasks SET status=?, finished_at=?, error=? WHERE id=? AND status='running'`)
                       .run(code === 0 ? 'done' : 'failed', Date.now(), code === 0 ? null : `Exit-Code ${code}`, id);
                } finally { db2.close(); }
                console.log(`[daemon] Update-Aktion beendet: ${action} (Exit-Code ${code})`);
            } catch (e) {
                console.error(`[daemon] Konnte Endstatus nicht schreiben: ${e.message}`);
            }
        });
    } catch (err) {
        db.prepare(`UPDATE update_tasks SET status='failed', finished_at=?, error=? WHERE id=?`)
          .run(Date.now(), err.message, id);
        console.error(`[daemon] Update-Aktion konnte nicht gestartet werden: ${action} – ${err.message}`);
    } finally {
        // Der Kindprozess hat den Descriptor geerbt; der Daemon braucht ihn nicht mehr.
        if (fd !== undefined) { try { closeSync(fd); } catch { /* egal */ } }
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

        // Abgeschlossene Detached-Läufe nachtragen: der Update-Prozess läuft
        // bewusst ohne wartenden Elternprozess (siehe runUpdateTask), niemand
        // meldet sein Ende. Dieser Abgleich läuft hier UND in der Route — hier
        // ist er der wichtigere Weg, weil er auch greift, wenn niemand das
        // Webinterface offen hat (sonst bliebe der Task ewig 'running' und
        // würde jede weitere Update-Aktion blockieren).
        const runningUpdate = db.prepare(`SELECT * FROM update_tasks WHERE status='running' LIMIT 1`).get();
        const stillRunning = runningUpdate && finalizeIfFinished(db, runningUpdate).status === 'running';

        // Höchstens einen Update-Task gleichzeitig ausführen (ein zweiter
        // Apply/Rollback mitten in einem laufenden Deploy wäre zerstörerisch:
        // gleichzeitiges rm -rf/tar auf APP_DIR).
        if (!stillRunning) {
            const nextUpdate = db.prepare(
                `SELECT * FROM update_tasks WHERE status='pending' ORDER BY created_at ASC LIMIT 1`
            ).get();
            if (nextUpdate) runUpdateTask(db, nextUpdate);
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
