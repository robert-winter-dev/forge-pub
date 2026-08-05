/**
 * FORGE LendingBot – Pool-Qualifikation & Auto-Exit
 *
 * Qualifikation:  Pool aktiviert (isPoolEnabled) UND 72h-Durchschnitts-APY ≥ APY_THRESHOLD_PERCENT
 * Deposit-Cap:    Pools mit TVL < 1M: max. 2.500 USDC gesamt (Sicherheitsnetz, unverändert)
 * Auto-Exit:      TVL < protokoll-eigene TVL-Schutz-Schwelle → sofortiger Withdraw + Deaktivierung
 *                 (siehe lib/tvl-guard.js, bin/bot.js checkAndAutoExit)
 *
 * Der frühere hartcodierte TVL-Mindestwert (1M) für die Qualifikation wurde durch
 * die nutzergesteuerte Pool-Freigabe (isPoolEnabled) ersetzt: der Nutzer aktiviert/
 * deaktiviert Pools selbst, und der TVL-Schutz deaktiviert automatisch bei
 * Unterschreitung der individuell eingestellten Schwelle.
 */

import { getDb } from './db.js';
import { config } from './config.js';
import { isPoolEnabled } from './tvl-guard.js';

// ── Konfiguration ─────────────────────────────────────────────────────────────

export const REBALANCER_CONFIG = {
    tvlCapThreshold:  1_000_000,  // TVL ab dem kein Deposit-Cap gilt
    depositCapUsdc:       2_500,  // Max-Gesamtdeposit für Pools mit TVL < tvlCapThreshold
    avgApyHours:             72,  // Zeitfenster für APY-Durchschnitt
};

// ── 72h-Pool-Statistiken ──────────────────────────────────────────────────────

/**
 * Liest 72h-Durchschnitts-APY und neuestes TVL aller Protokolle aus der DB.
 * @returns {Map<string, {avgApy: number, tvl: number|null, dataPoints: number}>}
 */
export function get72hPoolStats() {
    const db    = getDb();
    const since = Date.now() - REBALANCER_CONFIG.avgApyHours * 3600 * 1000;

    const apyRows = db.prepare(`
        SELECT protocol, AVG(apy) AS avg_apy, COUNT(*) AS cnt
        FROM protocol_stats
        WHERE bot_id = ? AND recorded_at > ?
        GROUP BY protocol
    `).all(config.botId, since);

    // Neuestes TVL pro Protokoll (separater Query wegen SQLite-Kompatibilität)
    const tvlRows = db.prepare(`
        SELECT p1.protocol, p1.tvl
        FROM protocol_stats p1
        WHERE p1.bot_id = ?
          AND p1.tvl IS NOT NULL
          AND p1.recorded_at = (
              SELECT MAX(p2.recorded_at)
              FROM protocol_stats p2
              WHERE p2.bot_id = p1.bot_id
                AND p2.protocol = p1.protocol
                AND p2.tvl IS NOT NULL
          )
        GROUP BY p1.protocol
    `).all(config.botId);

    const tvlMap = new Map(tvlRows.map(r => [r.protocol, r.tvl]));
    const result = new Map();
    for (const row of apyRows) {
        result.set(row.protocol, {
            avgApy:     row.avg_apy,
            tvl:        tvlMap.get(row.protocol) ?? null,
            dataPoints: row.cnt,
        });
    }
    return result;
}

// ── Pool-Qualifikation ────────────────────────────────────────────────────────

/**
 * Gibt qualifizierte Pools zurück: Pool aktiviert (isPoolEnabled) UND 72h-avg
 * APY ≥ Schwelle. Sortiert nach avgApy absteigend.
 *
 * Jeder Pool enthält zusätzlich `maxDepositUsdc` (unverändertes Sicherheitsnetz):
 *   - TVL < 1M:  2.500 USDC (Deposit-Cap)
 *   - TVL ≥ 1M:  Infinity (kein Cap)
 *
 * @param {Map<string, {avgApy, tvl}>} poolStats72h
 * @returns {Array<{protocol, avgApy, tvl, maxDepositUsdc}>}
 */
export function getQualifiedPools(poolStats72h) {
    const { tvlCapThreshold, depositCapUsdc } = REBALANCER_CONFIG;
    const minApyPct = config.apyThresholdPercent;
    const result = [];
    for (const [protocol, stats] of poolStats72h) {
        const tvl = stats.tvl ?? 0;
        if (stats.avgApy >= minApyPct && isPoolEnabled(protocol)) {
            const maxDepositUsdc = tvl >= tvlCapThreshold ? Infinity : depositCapUsdc;
            result.push({ protocol, avgApy: stats.avgApy, tvl: stats.tvl, maxDepositUsdc });
        }
    }
    return result.sort((a, b) => b.avgApy - a.avgApy);
}

// ── Diagnose ──────────────────────────────────────────────────────────────────

export function diagnose() {
    const stats72h  = get72hPoolStats();
    const qualified = getQualifiedPools(stats72h);
    const { tvlCapThreshold, depositCapUsdc } = REBALANCER_CONFIG;
    const minApyPct = config.apyThresholdPercent;

    const fmtTvl = tvl => tvl == null ? '—' :
        tvl >= 1e6 ? `$${(tvl / 1e6).toFixed(1)}M` : `$${(tvl / 1e3).toFixed(0)}K`;

    const lines = [
        'Pool-Diagnose',
        `  Schwellwerte : APY ≥ ${minApyPct}%  |  Pool muss aktiviert sein (Settings-UI) + TVL-Schutz (pro Pool, siehe Settings)`,
        `  Deposit-Cap  : max. ${depositCapUsdc.toLocaleString('de-DE')} USDC bei TVL < ${fmtTvl(tvlCapThreshold)}`,
        '',
        '  Alle bekannten Pools (72h-Daten):',
    ];

    for (const [protocol, stats] of stats72h) {
        const tvl      = stats.tvl ?? 0;
        const apyOk    = stats.avgApy >= minApyPct ? '✅' : '❌';
        const enabled  = isPoolEnabled(protocol);
        const enabledOk = enabled ? '✅' : '❌';
        const capNote = (tvl < tvlCapThreshold)
            ? ` [Cap: ${depositCapUsdc.toLocaleString('de-DE')} USDC]` : '';
        lines.push(
            `    ${protocol.padEnd(22)} APY: ${stats.avgApy.toFixed(2).padStart(5)}% ${apyOk}  ` +
            `TVL: ${fmtTvl(stats.tvl).padStart(7)}  Aktiviert: ${enabledOk}${capNote}  ` +
            `(${stats.dataPoints} Messpunkte)`
        );
    }

    lines.push('', `  Qualifiziert: ${qualified.length} von ${stats72h.size} Pools`);
    qualified.forEach((p, i) =>
        lines.push(`    ${i + 1}. ${p.protocol}  ${p.avgApy.toFixed(2)}% APY  TVL ${fmtTvl(p.tvl)}`)
    );

    return lines.join('\n');
}
