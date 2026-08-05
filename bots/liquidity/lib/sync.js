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

const execFileAsync = promisify(execFile);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_SCRIPT = path.join(__dirname, '..', 'bin', 'export.js');
const SYNC_SCRIPT   = path.join(__dirname, '..', '..', '..', 'bin', 'sync.sh');

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
            env:     process.env,
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
