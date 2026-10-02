/**
 * Range-Hinweis fuer den Kurs-Chart (LIQ#001115): die Range, die der Range Advisor des Bots fuer
 * einen Pool empfiehlt (± % um den Kurs), bezogen auf ein Referenzkapital.
 *
 * Gilt identisch auf Master und Fork: dieselbe Funktion (range-advisor.js, der Bot setzt seine
 * Range damit), dieselbe Datenquelle (letzter pool_stats-Eintrag, kein Orca-Abruf). Es wird nichts
 * ueber Premium geliefert, und die Edge-Rechnung (Master-only) ist nicht beteiligt.
 *
 * Feste Range (rangeOverride.locked) ueberstimmt den Advisor, wie beim Oeffnen einer Position
 * (bin/bot.js, _getAdvisedRange).
 */

import { analyzePool } from './range-advisor.js';

/** Referenzkapital der Empfehlung: die Range haengt ueber die Rebalance-Kosten vom Einsatz ab. */
export const RANGE_HINT_CAPITAL_USDC = 1000;

/**
 * @param {object} deps
 * @param {object} deps.db              SQLite-Handle (nur Lesezugriffe)
 * @param {object[]} deps.poolIds       Pool-IDs, fuer die ein Hinweis berechnet werden soll
 * @param {object[]} deps.poolsConfig   Pool-Konfigurationen (pools.json inkl. poolType)
 * @param {object} deps.statsByPool     { [poolId]: [pool_stats-Zeilen, aufsteigend] }
 * @param {Function} [deps.analyze]     analyzePool (fuer Tests austauschbar)
 * @returns {Promise<Record<string, number>>}  poolId → Range in ± %
 */
export async function computeRangeHints({ db, poolIds, poolsConfig, statsByPool, analyze = analyzePool }) {
    const out = {};
    for (const id of poolIds) {
        const cfg = poolsConfig.find(p => p.id === id);
        if (!cfg) continue;
        if (cfg.rangeOverride?.locked === true && cfg.rangeOverride.fixedPct > 0) {
            out[id] = cfg.rangeOverride.fixedPct;
            continue;
        }
        const stats  = statsByPool[id] ?? [];
        const latest = stats[stats.length - 1];
        if (!latest?.price || !(latest.tvl_usd > 0) || !(latest.volume_24h_usd > 0)) continue;
        try {
            const advice = await analyze(cfg, db, {
                capitalUsdc: RANGE_HINT_CAPITAL_USDC,
                marketData: {
                    tvlUsdc: latest.tvl_usd, vol24h: latest.volume_24h_usd, currentPrice: latest.price,
                    change24hPct: 0, fees24h: latest.fees_24h_usd ?? null,
                },
            });
            const pct = advice?.recommendation?.rangePct;
            if (Number.isFinite(pct) && pct > 0) out[id] = pct;
        } catch (err) {
            // Ein Pool ohne poolType/Historie darf den Export nicht stoppen: kein Hinweis.
            console.warn(`range-hint: ${id} uebersprungen (${err.message})`);
        }
    }
    return out;
}
