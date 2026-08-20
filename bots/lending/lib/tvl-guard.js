/**
 * FORGE LendingBot – TVL-Schutz + Liquiditäts-Schutz pro Protokoll (Config aus settings.db)
 *
 * Pro Lending-Protokoll konfigurierbar über das ForgeSettings-UI
 * (settings.db → pool_settings, bot_id='lending'). Fällt der Markt-TVL einer
 * Position unter `thresholdUsd`, wird sie zu 100 % abgezogen (siehe
 * bin/bot.js checkAndAutoExit), optional an `sendTo` versendet — und der Pool
 * wird zusätzlich deaktiviert (poolEnabled=false), damit ab diesem Moment
 * weder manuelle Deposits noch Auto-Deploy dort erneut investieren.
 *
 * Analog dazu der Liquiditäts-Schutz (`liqGuard`) auf die sofort abhebbare
 * Liquidität — ohne die dauerhafte Deaktivierung, siehe DEFAULT_LIQ_GUARD.
 *
 * Solange eine der beiden Schwellen unterschritten ist, ist der Pool zusätzlich
 * von Investments über "Bester Pool" ausgeschlossen (lib/rebalancer.js
 * getQualifiedPools) — auch wenn er noch freigegeben ist.
 *
 * Default je Protokoll und Schutz: aktiv, Schwelle 100K, kein Versand.
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

/**
 * Liquiditäts-Schutz — gleiche Mechanik, andere Kennzahl.
 *
 * TVL != sofort abhebbare Liquidität: der TVL enthält verliehenes und extern
 * geparktes Kapital. Ein Pool kann 1 Mio. USDC TVL und 0 USDC abhebbare
 * Liquidität haben (Loopscale "USDC Frontier", August 2026) — der TVL-Schutz
 * greift dort nie, obwohl eine Auszahlung faktisch unmöglich ist.
 *
 * Unterschied zum TVL-Schutz: der Pool wird beim Auslösen NICHT dauerhaft
 * deaktiviert. Liquidität schwankt mit jeder Kreditrückzahlung — eine dauerhafte
 * Deaktivierung mit manueller Reaktivierung wäre hier Dauerarbeit. Stattdessen
 * wird der Pool live aus der "Bester Pool"-Qualifikation genommen, solange die
 * Liquidität unter der Schwelle liegt (siehe lib/rebalancer.js getQualifiedPools),
 * und kommt von selbst zurück, sobald sie sich erholt.
 */
export const DEFAULT_LIQ_GUARD = {
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
 * Lädt einen Schutz-Block (`tvlGuard` / `liqGuard`) eines Protokolls aus
 * settings.db. Fällt auf die Defaults zurück, wenn kein Eintrag existiert oder
 * die settings.db nicht lesbar ist (Bot bleibt funktionsfähig).
 */
function _loadGuard(protocolId, field, defaults) {
    try {
        const db  = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = db.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
        ).get(protocolId);
        db.close();
        if (!row) return { ...defaults };
        const g = JSON.parse(row.settings)?.[field];
        return { ...defaults, ...(g ?? {}) };
    } catch {
        return { ...defaults };
    }
}

/**
 * Lädt die TVL-Schutz-Settings eines Protokolls.
 * @param {string} protocolId
 * @returns {{enabled: boolean, thresholdUsd: number, sendTo: string}}
 */
export function loadTvlGuard(protocolId) {
    return _loadGuard(protocolId, 'tvlGuard', DEFAULT_TVL_GUARD);
}

/**
 * Lädt die Liquiditäts-Schutz-Settings eines Protokolls aus settings.db.
 * @param {string} protocolId
 * @returns {{enabled: boolean, thresholdUsd: number, sendTo: string}}
 */
export function loadLiqGuard(protocolId) {
    return _loadGuard(protocolId, 'liqGuard', DEFAULT_LIQ_GUARD);
}

/**
 * Prüft beide Schutzschwellen eines Protokolls gegen aktuelle Messwerte.
 *
 * 🔒 `null` heißt "nicht gemessen", nicht "0": Für mehrere Protokolle liefert die
 * API (noch) keine Liquidität. Ein fehlender Wert darf niemals einen Abzug oder
 * eine Sperre auslösen — sonst würde ein API-Ausfall das Kapital bewegen.
 *
 * @param {string} protocolId
 * @param {{tvl?: number|null, liquidity?: number|null}} metrics
 * @returns {{tvlBelow: boolean, liqBelow: boolean, tvlGuard: Object, liqGuard: Object}}
 */
export function checkGuards(protocolId, { tvl = null, liquidity = null } = {}) {
    const tvlGuard = loadTvlGuard(protocolId);
    const liqGuard = loadLiqGuard(protocolId);
    return {
        tvlGuard,
        liqGuard,
        tvlBelow: !!tvlGuard.enabled && tvlGuard.thresholdUsd > 0
                  && tvl != null && tvl < tvlGuard.thresholdUsd,
        liqBelow: !!liqGuard.enabled && liqGuard.thresholdUsd > 0
                  && liquidity != null && liquidity < liqGuard.thresholdUsd,
    };
}

/**
 * Invest-Guard: darf in dieses Protokoll überhaupt Kapital hinein?
 *
 * checkGuards() beantwortet die Austritts-Frage („muss Kapital jetzt heraus?").
 * Beim EINTRITT ist die sichere Richtung eine andere — es wird nichts bewegt, kein
 * Kapital ist in Gefahr, und im Ranking rückt der nächstbeste Pool ohne Verlust nach.
 *
 * 🔒 Ein fehlender Messwert sperrt — sofern die Kennzahl für dieses Protokoll
 * überhaupt erhoben wird:
 *   - **TVL fehlt → immer Sperre.** Den TVL liefert jedes Protokoll; sein Fehlen ist ein
 *     echtes Signal (Poll ausgefallen, Protokoll nicht mehr erfasst), kein Normalfall.
 *   - **Liquidität fehlt → Sperre, wenn das Protokoll sie schon einmal geliefert hat**
 *     (`liquidityEverSeen`, aus get72hPoolStats). Dann ist das Fehlen ebenfalls ein
 *     Ausfall. Hat es sie **nie** geliefert, ist es eine Erfassungslücke — dort würde
 *     eine Sperre funktionierende Pools stilllegen, statt vor etwas zu schützen.
 *
 * Die Unterscheidung ist bewusst datengetrieben und nicht als Schalter gebaut: sobald die
 * Erfassung für ein Protokoll existiert und der erste Wert in der DB steht, gilt die
 * Sperre dort automatisch mit. Stand 20.08.2026 liefern alle gepollten Protokolle außer
 * `drift` die Kennzahl.
 *
 * Die Mindest-Datenbasis prüft der Aufrufer separat (checkDataBasis in
 * lib/rebalancer.js) — sie lebt dort, wo auch das 72h-Fenster berechnet wird.
 *
 * `reason` ist deutscher Klartext für Log und diagnose(); Benachrichtigungen und
 * Oberfläche formulieren aus `rule` + `detail` selbst (sie sind zweisprachig).
 *
 * @param {string} protocolId
 * @param {{tvl?: number|null, liquidity?: number|null, liquidityEverSeen?: boolean}} metrics
 * @returns {{ok: boolean, rule: string|null, reason: string|null, detail: object}}
 */
export function checkInvestGuards(protocolId, { tvl = null, liquidity = null, liquidityEverSeen = false } = {}) {
    const { tvlGuard, liqGuard, tvlBelow, liqBelow } = checkGuards(protocolId, { tvl, liquidity });
    const fmt = v => Math.round(v).toLocaleString('de-DE');

    if (tvlBelow) {
        return { ok: false, rule: 'tvl',
                 reason: `TVL ${fmt(tvl)} USDC unter TVL-Schutz-Schwelle ${fmt(tvlGuard.thresholdUsd)} USDC`,
                 detail: { tvl, threshold: tvlGuard.thresholdUsd } };
    }
    if (liqBelow) {
        return { ok: false, rule: 'liquidity',
                 reason: `Liquidität ${fmt(liquidity)} USDC unter Liquiditäts-Schutz-Schwelle ${fmt(liqGuard.thresholdUsd)} USDC`,
                 detail: { liquidity, threshold: liqGuard.thresholdUsd } };
    }
    if (tvl == null && !!tvlGuard.enabled && tvlGuard.thresholdUsd > 0) {
        return { ok: false, rule: 'tvl_unknown', reason: 'kein aktueller TVL-Messwert vorhanden', detail: {} };
    }
    if (liquidity == null && liquidityEverSeen && !!liqGuard.enabled && liqGuard.thresholdUsd > 0) {
        return { ok: false, rule: 'liq_unknown',
                 reason: 'kein aktueller Liquiditäts-Messwert vorhanden (Protokoll liefert die Kennzahl sonst)',
                 detail: {} };
    }
    return { ok: true, rule: null, reason: null, detail: {} };
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
