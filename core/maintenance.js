/**
 * FORGE – Maintenance-Flag Utility
 *
 * Liest data/maintenance.json und prüft ob Wartungsmodus aktiv ist.
 * Löscht abgelaufene Flag-Dateien automatisch (TTL-basiert).
 * Speichert abgeschlossene Wartungsfenster in data/maintenance-history.json,
 * damit export.js lifecycle-Notifications auch nach --off herausfiltern kann.
 *
 * Wird von Bot-Exports genutzt um lifecycle-Notifications zu unterdrücken.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname }                                     from 'path';
import { fileURLToPath }                                        from 'url';

const FORGE_ROOT     = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { PATHS } from '../config/paths.js';
export const FLAG_FILE    = resolve(PATHS.data, 'maintenance.json');
export const HISTORY_FILE = resolve(PATHS.data, 'maintenance-history.json');

const MAX_HISTORY = 20; // Fenster behalten

/** Hängt ein abgeschlossenes Fenster an die History an. */
export function recordMaintenanceWindow(reason, startedAt, endedAt) {
    let history = [];
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8')); } catch { /* neu anlegen */ }
    history.push({ reason, startedAt, endedAt });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * Gibt { reason, createdAt, ttlMinutes, expiresAt } zurück wenn aktiv, sonst null.
 * Löscht abgelaufene Dateien automatisch und schreibt das Fenster in die History.
 */
export function readMaintenanceFlag() {
    if (!existsSync(FLAG_FILE)) return null;
    try {
        const d = JSON.parse(readFileSync(FLAG_FILE, 'utf-8'));
        const expiresAt = d.createdAt + d.ttlMinutes * 60_000;
        if (Date.now() > expiresAt) {
            try { recordMaintenanceWindow(d.reason, d.createdAt, expiresAt); } catch { /* ignore */ }
            try { unlinkSync(FLAG_FILE); } catch { /* ignore */ }
            return null;
        }
        return { ...d, expiresAt };
    } catch {
        return null;
    }
}

/**
 * Gibt die letzten Wartungsfenster zurück (abgeschlossen + ggf. laufendes).
 * Format: [{ reason, startedAt, endedAt }]
 * Ein laufendes Fenster hat endedAt = expiresAt (pessimistisch).
 */
export function getMaintenanceWindows() {
    let history = [];
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8')); } catch { /* keine History */ }
    // Aktives Fenster einbeziehen (endedAt = expiresAt als obere Schranke)
    const active = readMaintenanceFlag();
    if (active) {
        history = [...history, { reason: active.reason, startedAt: active.createdAt, endedAt: active.expiresAt }];
    }
    return history;
}
