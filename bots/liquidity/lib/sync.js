/**
 * FORGE Liquidity – Dashboard-Sync
 *
 * 1. Führt bin/export.js aus → schreibt data.json nach FORGE/html/liquidity/data/.
 * 2. Ruft FORGE/bin/sync.sh auf → rsync zum Webserver (sofern SYNC_TARGET gesetzt).
 *
 * Aufruf aus bot.js alle EXPORT_INTERVAL_MS.
 */

import { execFile }      from 'child_process';
import { promisify }     from 'util';
import path              from 'path';
import { fileURLToPath } from 'url';
import { readFileSync }  from 'fs';
import { envFile }       from '../../../config/paths.js';

const execFileAsync = promisify(execFile);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_SCRIPT = path.join(__dirname, '..', 'bin', 'export.js');
const SYNC_SCRIPT   = path.join(__dirname, '..', '..', '..', 'bin', 'sync.sh');

// Keys, die laut bots/settings/routes/config.js (NO_RESTART_KEYS) ohne Bot-Neustart
// wirken sollen, weil sie "pro Zyklus frisch gelesen" werden. Das gilt für cleanup.js
// (eigener Prozess, liest .env bei jedem Start neu), aber export.js läuft als Kindprozess
// von bot.js und erbte bisher dessen process.env — das ist der Stand von bot.js' eigenem
// Start und ändert sich nie zur Laufzeit. Die damalige "Bester Pool jetzt"-Vorschau im
// Dashboard (seit LIQ#000929 entfallen) zeigte dadurch trotz geänderter .env weiter den
// alten Schwellwert (Meldung 2026-08-31). Fix: diese Keys hier vor jedem Export frisch
// aus der .env lesen.
const NO_RESTART_KEYS = [
    'CLEANUP_MODE', 'CLEANUP_MAX_DEPOSIT', 'CLEANUP_MIN_DEPOSIT',
    'CLEANUP_ENABLED', 'CLEANUP_DUST_ENABLED', 'CLEANUP_DUST_MIN_USDC',
    'CLEANUP_DUST_MAX_USDC', 'CLEANUP_TREND_GATE',
];

/** Liest die aktuellen Werte der NO_RESTART_KEYS frisch von der Platte statt aus process.env. */
function freshEnv() {
    const merged = { ...process.env };
    let raw;
    try {
        raw = readFileSync(envFile('liquidity'), 'utf8');
    } catch {
        return merged;
    }
    for (const key of NO_RESTART_KEYS) {
        const m = raw.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
        if (m) merged[key] = m[1].trim();
    }
    return merged;
}

/**
 * Triggert den Dashboard-Export und anschließend den rsync zum Webserver.
 * Fehler werden geloggt aber nicht weitergeworfen — ein fehlgeschlagener Sync
 * darf den Bot nicht stoppen.
 *
 * @param {Function} log  Logging-Funktion (default: console.log)
 */
export async function syncDashboard(log = console.log) {
    // 1. Export: data.json lokal schreiben
    try {
        await execFileAsync(process.execPath, [EXPORT_SCRIPT], {
            env:     freshEnv(),
            timeout: 30_000,
        });
        log('[sync] data.json exportiert');
    } catch (err) {
        console.error(`[sync] Export fehlgeschlagen: ${err.stderr?.trim() ?? err.message}`);
        return;
    }

    // 2. rsync zum Webserver (nur wenn SYNC_TARGET gesetzt)
    if (!process.env.SYNC_TARGET?.trim()) return;

    try {
        await execFileAsync('bash', [SYNC_SCRIPT], {
            env:     process.env,
            timeout: 30_000,
        });
        log('[sync] rsync OK');
    } catch (err) {
        console.error(`[sync] rsync fehlgeschlagen: ${err.stderr?.trim() ?? err.message}`);
    }
}
