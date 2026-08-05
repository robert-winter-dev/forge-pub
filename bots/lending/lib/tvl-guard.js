/**
 * FORGE LendingBot – TVL-Schutz pro Protokoll (Config aus settings.db)
 *
 * Pro Lending-Protokoll konfigurierbar über das ForgeSettings-UI
 * (settings.db → pool_settings, bot_id='lending'). Fällt der Markt-TVL einer
 * Position unter `thresholdUsd`, wird sie zu 100 % abgezogen (siehe
 * bin/bot.js checkAndAutoExit), optional an `sendTo` versendet — und der Pool
 * wird zusätzlich deaktiviert (poolEnabled=false), damit ab diesem Moment
 * weder manuelle Deposits noch Auto-Deploy dort erneut investieren.
 *
 * Default je Protokoll: aktiv, Schwelle 100K, kein Versand.
 *
 * `poolEnabled` ist bewusst ein eigenes Feld (nicht `tvlGuard.enabled`!):
 * `tvlGuard.enabled` schaltet den TVL-Schutz-Mechanismus selbst an/aus,
 * `poolEnabled` ist die Nutzer-Freigabe, ob überhaupt in den Pool investiert
 * werden darf (User-Toggle in der Pool-Zeile, analog Liquidity Bots
 * pools.enabled/active-Trennung).
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';
import { PATHS } from '../../../config/paths.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB = PATHS.settingsDb;

export const DEFAULT_TVL_GUARD = {
    enabled:      true,
    thresholdUsd: 100_000,
    sendTo:       '',
};

function _ensureTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS pool_settings (
            bot_id   TEXT NOT NULL,
            pool_id  TEXT NOT NULL,
            settings TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (bot_id, pool_id)
        )
    `);
}

/**
 * Lädt die TVL-Schutz-Settings eines Protokolls aus settings.db.
 * Fällt auf DEFAULT_TVL_GUARD zurück, wenn kein Eintrag existiert oder die
 * settings.db nicht lesbar ist (Bot bleibt funktionsfähig).
 *
 * @param {string} protocolId
 * @returns {{enabled: boolean, thresholdUsd: number, sendTo: string}}
 */
export function loadTvlGuard(protocolId) {
    try {
        const db  = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = db.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
        ).get(protocolId);
        db.close();
        if (!row) return { ...DEFAULT_TVL_GUARD };
        const tg = JSON.parse(row.settings)?.tvlGuard;
        return { ...DEFAULT_TVL_GUARD, ...(tg ?? {}) };
    } catch {
        return { ...DEFAULT_TVL_GUARD };
    }
}

/**
 * Ob ein Protokoll für Deposits (manuell + Auto-Deploy) freigegeben ist.
 * Default true (kein Eintrag = aktiviert), analog Liquidity Bots
 * isPoolEnabled() (pools.enabled !== false).
 *
 * @param {string} protocolId
 * @returns {boolean}
 */
export function isPoolEnabled(protocolId) {
    try {
        const db  = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = db.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
        ).get(protocolId);
        db.close();
        if (!row) return true;
        const parsed = JSON.parse(row.settings);
        return parsed.poolEnabled !== false;
    } catch {
        return true;
    }
}

/**
 * Deaktiviert einen Pool (Nutzer-Freigabe entziehen) — vom Bot selbst
 * aufgerufen, wenn der TVL-Schutz auslöst (siehe bin/bot.js checkAndAutoExit).
 * Manuelles Re-Aktivieren läuft ausschließlich über das Settings-UI
 * (PUT /api/lending/pool-enabled/:id, inkl. 50%-Schwellenkorrektur).
 *
 * @param {string} protocolId
 */
export function disablePool(protocolId) {
    try {
        const db = new Database(SETTINGS_DB, { fileMustExist: true });
        _ensureTable(db);
        const row = db.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
        ).get(protocolId);
        let current = {};
        if (row) { try { current = JSON.parse(row.settings); } catch { current = {}; } }
        current.poolEnabled = false;
        db.prepare(`
            INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('lending', ?, ?)
            ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
        `).run(protocolId, JSON.stringify(current));
        db.close();
    } catch {
        // Bot bleibt funktionsfähig — nächster Tick versucht es erneut
    }
}
