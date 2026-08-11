/**
 * FORGE – Restart-Task-Queue (settings.db `tasks`)
 *
 * Reiht einen Service-Neustart ein, den forge-settings-daemon asynchron abarbeitet
 * (bot-control-daemon.js). Der aufrufende HTTP-Request muss dadurch nicht auf den
 * Neustart warten – auch nicht, wenn forge-settings selbst der Zielservice ist.
 */

import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';

const DB_PATH = PATHS.settingsDb;

export function enqueueRestart(service) {
    try {
        const db = new Database(DB_PATH);
        db.prepare(`
            INSERT INTO tasks (created_at, status, action, target)
            VALUES (?, 'pending', 'restart', ?)
        `).run(Date.now(), service);
        db.close();
    } catch { /* DB noch nicht bereit – ignorieren */ }
}
