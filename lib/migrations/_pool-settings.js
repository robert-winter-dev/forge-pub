/**
 * FORGE – gemeinsame Helfer für Migrationen, die Pool-Einstellungen anfassen.
 *
 * Der Dateiname beginnt bewusst nicht mit einer Nummer: Der Runner lädt nur `NNNN-*.js`,
 * dieses Modul ist reine Infrastruktur und keine Migration.
 */

/** Alle Liquidity-Pool-Einstellungen als geparste Objekte, unlesbare werden übersprungen. */
export function readPoolSettings(settingsDb) {
    let rows;
    try {
        rows = settingsDb.prepare(
            `SELECT pool_id, settings FROM pool_settings WHERE bot_id = 'liquidity'`
        ).all();
    } catch {
        return [];   // Tabelle existiert noch nicht → nichts zu migrieren
    }

    const out = [];
    for (const row of rows) {
        try {
            out.push({ poolId: row.pool_id, settings: JSON.parse(row.settings) });
        } catch {
            // Unlesbarer Eintrag: überspringen statt die ganze Migration scheitern zu lassen.
        }
    }
    return out;
}

/**
 * Schreibt die Einstellungen eines Pools — als UPSERT, nicht als reines UPDATE.
 *
 * Ein reines UPDATE liefe bei genau dem Fall ins Leere, der die häufigste Ursache ist:
 * ein Pool, der noch gar keinen Eintrag hat. Am 2026-08-22 war das der Zustand des Pools,
 * dessen fehlende Drawdown-Schwelle den Trailing Stop wirkungslos gemacht hatte.
 */
export function writePoolSettings(settingsDb, poolId, settings) {
    settingsDb.prepare(`
        INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('liquidity', ?, ?)
        ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
    `).run(poolId, JSON.stringify(settings));
}

/** Pools mit offener Position — Grundlage jeder Wirkungsabschätzung. */
export function openPositionPools(liquidityDb) {
    if (!liquidityDb) return new Map();
    try {
        const rows = liquidityDb.prepare(
            `SELECT pool_id, id, hwm_usd FROM positions WHERE closed_at IS NULL`
        ).all();
        return new Map(rows.map(r => [r.pool_id, r]));
    } catch {
        return new Map();
    }
}

/** Zuletzt gemessener Positionswert eines Pools. */
export function lastLpValue(liquidityDb, poolId) {
    if (!liquidityDb) return 0;
    try {
        return liquidityDb.prepare(
            `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ?
             ORDER BY recorded_at DESC LIMIT 1`
        ).get(poolId)?.lp_value_usd ?? 0;
    } catch {
        return 0;
    }
}

/** Jüngster TVL-Wert eines Pools. */
export function latestTvl(liquidityDb, poolId) {
    if (!liquidityDb) return 0;
    try {
        return liquidityDb.prepare(
            `SELECT tvl_usd FROM pool_stats WHERE pool_id = ? AND tvl_usd > 0
             ORDER BY recorded_at DESC LIMIT 1`
        ).get(poolId)?.tvl_usd ?? 0;
    } catch {
        return 0;
    }
}
