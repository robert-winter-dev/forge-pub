/**
 * LendingBot – Dashboard-Sync
 *
 * Delegiert an FORGE/bin/sync.sh (direkter rsync des gesamten html/-Baums).
 * Export (data.json) übernimmt bot.js separat — hier nur der Rsync.
 *
 * Hintergrund: core/sync.mjs wurde in FORGE v0.3.1 (2026-03-25) durch das
 * schlankere bin/sync.sh ersetzt. Dieses Modul ruft das Shell-Script auf.
 *
 * SYNC_TARGET Format (in .env):
 *   user@host:/absoluter/pfad/zu/forge
 *   Beispiel: user@example.com:/var/www/forge
 *
 * SYNC_SSH_PORT (optional, default: 22)
 */

import path              from 'path';
import { fileURLToPath } from 'url';
import { execFile }      from 'child_process';
import { promisify }     from 'util';

const execFileAsync = promisify(execFile);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const SYNC_SCRIPT   = path.resolve(__dirname, '../../../bin/sync.sh');

/**
 * Dashboard-Sync via FORGE/bin/sync.sh.
 * bot.js ruft export.js separat auf, bevor dieser Aufruf erfolgt.
 *
 * @param {string|null} syncTarget  null/leer → kein Rsync
 * @param {number}      sshPort     SSH-Port (default: 22)
 * @param {Function}    log         Logging-Funktion
 */
export async function syncDashboard(syncTarget = null, sshPort = 22, log = console.log) {
    if (!syncTarget?.trim()) return;

    log(`Sync: Staging → ${syncTarget}`);
    await execFileAsync('bash', [SYNC_SCRIPT], {
        env: {
            ...process.env,
            SYNC_TARGET:   syncTarget,
            SYNC_SSH_PORT: String(sshPort),
        },
    });
}
