/**
 * Gemeinsamer Zustand der Update-Task-Queue (System > Updates)
 *
 * Genutzt von bots/settings/bin/bot-control-daemon.js (startet die Aufgaben)
 * UND bots/settings/routes/update.js (liest den Fortschritt fürs Webinterface).
 * Bewusst EIN Modul statt zweier Kopien: die Frage "läuft der Vorgang noch und
 * wie ist er ausgegangen?" muss auf beiden Seiten identisch beantwortet werden.
 *
 * 🔒 Architektur-Grund (Vorfall 2026-08-10, zwei aufeinanderfolgende Bugs):
 * Ein Update stoppt ALLE sechs Dienste — darunter forge-settings-daemon selbst
 * (siehe SERVICES in bin/setup.sh). Der Vorgang killt damit den Prozess, der ihn
 * gestartet hat. Erste Auswirkung: systemd riss per Default-KillMode auch den
 * Update-Prozess selbst mit (behoben durch KillMode=process in der Unit).
 * Zweite Auswirkung: der Daemon stirbt trotzdem, und mit ihm sein
 * child.on('close')-Handler — der Task wäre für immer auf 'running' hängen
 * geblieben. Deshalb gilt hier:
 *
 *   1. Der Update-Prozess läuft DETACHED in eigener Prozessgruppe und schreibt
 *      seine Ausgabe SELBST in eine Logdatei — kein Elternprozess muss dafür
 *      am Leben bleiben.
 *   2. Die Logdatei liegt unter PATHS.logs (außerhalb von app/) — ein Update
 *      ersetzt app/ komplett und würde ein Log darin mitten im Schreiben löschen.
 *   3. Der Endzustand wird NACHTRÄGLICH aus PID-Lebendigkeit + Loginhalt
 *      abgeleitet (finalizeIfFinished), nicht aus einem Exit-Code, den nur ein
 *      überlebender Elternprozess sähe.
 */

import { openSync, closeSync, readSync, readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';

export const UPDATE_LOG_DIR = path.join(PATHS.logs, 'update');

export function logPathFor(taskId) {
    return path.join(UPDATE_LOG_DIR, `task-${taskId}.log`);
}

/** Öffnet die Logdatei zum Anhängen und legt das Verzeichnis bei Bedarf an. */
export function openLogFd(taskId) {
    mkdirSync(UPDATE_LOG_DIR, { recursive: true });
    return openSync(logPathFor(taskId), 'a');
}

/**
 * Liest das Log – bewusst nur die letzten MAX_TAIL_BYTES.
 *
 * Das Webinterface pollt alle 2s; ein npm-install-Lauf kann mehrere MB Ausgabe
 * erzeugen. Ohne Deckel ginge das komplette Log bei JEDEM Poll erneut über die
 * Leitung. Angezeigt werden ohnehin nur die Phasenzeilen am Ende.
 */
const MAX_TAIL_BYTES = 64 * 1024;

export function readLog(taskId) {
    const p = logPathFor(taskId);
    if (!existsSync(p)) return '';
    try {
        const { size } = statSync(p);
        if (size <= MAX_TAIL_BYTES) return readFileSync(p, 'utf8');
        const fd = openSync(p, 'r');
        try {
            const buf = Buffer.alloc(MAX_TAIL_BYTES);
            readSync(fd, buf, 0, MAX_TAIL_BYTES, size - MAX_TAIL_BYTES);
            // Erste (womöglich mitten im Zeichen abgeschnittene) Zeile verwerfen.
            return buf.toString('utf8').split('\n').slice(1).join('\n');
        } finally {
            closeSync(fd);
        }
    } catch {
        return '';
    }
}

/**
 * Läuft der Prozess noch?
 *
 * Signal 0 prüft nur die Existenz. Wichtig: der Update-Prozess läuft als root,
 * der fragende Dienst als unprivilegierter Nutzer — dann meldet der Kernel
 * EPERM ("existiert, aber du darfst nicht signalisieren"), NICHT ESRCH. EPERM
 * ist also ebenfalls ein Beweis für "lebt", nur ESRCH heißt "weg".
 */
export function isProcessAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

/** Legt Tabelle + nachgerüstete Spalten auf einem BESTEHENDEN Handle an. */
export function ensureUpdateSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS update_tasks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at  INTEGER NOT NULL,
            started_at  INTEGER,
            finished_at INTEGER,
            status      TEXT    NOT NULL DEFAULT 'pending',
            action      TEXT    NOT NULL,
            output      TEXT,
            error       TEXT
        )
    `);
    // Nachrüsten für Installationen, deren Tabelle vor der Detached-Umstellung
    // angelegt wurde (kein ORM/Migrationssystem im Projekt, siehe CLAUDE.md).
    const cols = new Set(db.prepare(`PRAGMA table_info(update_tasks)`).all().map(c => c.name));
    if (!cols.has('pid'))      db.exec(`ALTER TABLE update_tasks ADD COLUMN pid INTEGER`);
    if (!cols.has('log_path')) db.exec(`ALTER TABLE update_tasks ADD COLUMN log_path TEXT`);
    return db;
}

export function openUpdateDb() {
    return ensureUpdateSchema(new Database(PATHS.settingsDb));
}

/**
 * Schließt einen Task ab, dessen Prozess nicht mehr lebt.
 *
 * Ohne überlebenden Elternprozess gibt es keinen Exit-Code — der Ausgang wird
 * deshalb aus dem Log abgeleitet: bin/update-check.js markiert jeden Fehlerfall
 * mit 🔴 (siehe die notify()-Aufrufe dort), ein sauberer Lauf enthält keins.
 * Für die Rollback-Freigabe ist ohnehin nicht dieser Status maßgeblich, sondern
 * local/data/last-update-result.json, das update-check.js selbst schreibt.
 *
 * @returns {object} die (ggf. aktualisierte) Task-Zeile
 */
export function finalizeIfFinished(db, task) {
    if (!task || (task.status !== 'running' && task.status !== 'pending')) return task;
    // Noch kein PID vergeben = der Daemon hat den Prozess noch nicht gestartet.
    if (!task.pid) return task;
    if (isProcessAlive(task.pid)) return task;

    const log = readLog(task.id);
    const failed = log.includes('🔴');
    const status = failed ? 'failed' : 'done';
    const error = failed
        ? (log.split('\n').filter(l => l.includes('🔴')).pop() ?? 'Fehler – siehe Protokoll')
        : null;
    db.prepare(`UPDATE update_tasks SET status=?, finished_at=?, error=? WHERE id=? AND status IN ('running','pending')`)
      .run(status, Date.now(), error, task.id);
    return { ...task, status, finished_at: Date.now(), error };
}
