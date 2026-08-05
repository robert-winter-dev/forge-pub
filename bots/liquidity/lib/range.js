/**
 * FORGE Liquidity – Range-Berechnung
 *
 * Berechnet den Tick-Bereich (tickLower, tickUpper) für eine neue CLMM-Position.
 *
 * Modi:
 *   fixed  → Range = aktueller Preis ± RANGE_FIXED_PCT%
 *   atr    → Range = aktueller Preis ± (ATR(N) × RANGE_ATR_MULTIPLIER)
 *            ATR wird aus pool_stats Zeitreihe berechnet.
 *            Fallback auf fixed (20%) wenn nicht genug Datenpunkte vorhanden.
 *
 * Wichtig:
 *   - tickLower muss Vielfaches von tickSpacing sein (nach unten runden)
 *   - tickUpper muss Vielfaches von tickSpacing sein (nach oben runden)
 *   - Ticks müssen innerhalb [MIN_TICK_INDEX, MAX_TICK_INDEX] liegen
 */

import {
    PriceMath,
    MIN_TICK_INDEX,
    MAX_TICK_INDEX,
} from '@orca-so/whirlpools-sdk';
import Decimal from 'decimal.js';

// ─── Öffentliche API ──────────────────────────────────────────────────────────

/**
 * Berechnet tickLower/tickUpper zentriert auf den aktuellen Preis.
 *
 * @param {Object}   pool          Pool-Konfiguration aus pools.json
 * @param {number}   currentPrice  Aktueller Preis Token A in USDC
 * @param {Object}   rangeConfig   config.range ({ mode, fixedPct, atrPeriod, atrMultiplier })
 * @param {Database} db            SQLite-Datenbankinstanz (für ATR-Modus)
 * @returns {{ tickLower, tickUpper, priceLower, priceUpper }}
 */
export function calculateRange(pool, currentPrice, rangeConfig, db) {
    let halfWidth;

    if (rangeConfig.mode === 'atr') {
        const atr = _calculateATR(db, pool.id, rangeConfig.atrPeriod);
        if (atr !== null) {
            halfWidth = atr * rangeConfig.atrMultiplier;
            const pct = (halfWidth / currentPrice * 100).toFixed(2);
            console.log(`[range] ATR (${rangeConfig.atrPeriod}d × ${rangeConfig.atrMultiplier}): ${atr.toFixed(4)} → ±${pct}%`);
        } else {
            const fallbackPct = rangeConfig.fixedPct ?? 20;
            console.warn(`[range] ATR: nicht genug Tages-Daten für ${pool.id}, Fallback auf ±${fallbackPct}%`);
            halfWidth = currentPrice * (fallbackPct / 100);
        }
        // Mindest- und Höchstgrenze anwenden
        const minHalf = currentPrice * (rangeConfig.minRangePct / 100);
        const maxHalf = currentPrice * (rangeConfig.maxRangePct / 100);
        if (halfWidth < minHalf) {
            console.warn(`[range] ATR-Range zu eng (±${(halfWidth/currentPrice*100).toFixed(2)}%), clamp auf MIN_RANGE_PCT ±${rangeConfig.minRangePct}%`);
            halfWidth = minHalf;
        } else if (halfWidth > maxHalf) {
            console.warn(`[range] ATR-Range zu weit (±${(halfWidth/currentPrice*100).toFixed(2)}%), clamp auf MAX_RANGE_PCT ±${rangeConfig.maxRangePct}%`);
            halfWidth = maxHalf;
        }
    } else {
        // fixed-Modus: RANGE_FIXED_PCT % der aktuellen Mitte
        halfWidth = currentPrice * (rangeConfig.fixedPct / 100);
    }

    const rawLower = currentPrice - halfWidth;
    const rawUpper = currentPrice + halfWidth;

    // Sicherheitscheck: Preise müssen > 0 sein
    const priceLower = Math.max(rawLower, 1e-9);
    const priceUpper = rawUpper;

    // Preis → Tick (direkt auf tickSpacing-Vielfaches)
    const tickLower = _priceToAlignedTick(priceLower, pool, 'floor');
    const tickUpper = _priceToAlignedTick(priceUpper, pool, 'ceil');

    // Aus Sicherheitsgründen clamp auf Orca-Grenzen
    const clampedLower = Math.max(tickLower, MIN_TICK_INDEX);
    const clampedUpper = Math.min(tickUpper, MAX_TICK_INDEX);

    if (clampedLower >= clampedUpper) {
        throw new Error(
            `Ungültige Range berechnet: tickLower (${clampedLower}) >= tickUpper (${clampedUpper}). ` +
            `Preis: ${currentPrice}, halfWidth: ${halfWidth.toFixed(4)}`
        );
    }

    // Ticks → reale Preise zurückrechnen
    const actualPriceLower = PriceMath.tickIndexToPrice(clampedLower, pool.decimalsA, pool.decimalsB).toNumber();
    const actualPriceUpper = PriceMath.tickIndexToPrice(clampedUpper, pool.decimalsA, pool.decimalsB).toNumber();

    return {
        tickLower:  clampedLower,
        tickUpper:  clampedUpper,
        priceLower: actualPriceLower,
        priceUpper: actualPriceUpper,
    };
}

/**
 * Prüft ob ein gegebener Preis innerhalb eines Tick-Bereichs liegt,
 * unter Berücksichtigung des Rebalancing-Puffers.
 *
 * @param {number} currentPrice
 * @param {number} priceLower
 * @param {number} priceUpper
 * @param {number} thresholdPct    Puffer in % (z.B. 2 = 2% vor der Grenze)
 * @returns {boolean}
 */
export function isInRangeWithBuffer(currentPrice, priceLower, priceUpper, thresholdPct) {
    const buffer = (priceUpper - priceLower) * (thresholdPct / 100);
    return currentPrice >= (priceLower + buffer) && currentPrice <= (priceUpper - buffer);
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

/**
 * Konvertiert einen Preis in einen tick-Spacing-ausgerichteten Tick-Index.
 * direction 'floor' → für tickLower (nach unten runden)
 * direction 'ceil'  → für tickUpper (nach oben runden)
 */
function _priceToAlignedTick(price, pool, direction) {
    const rawTick = PriceMath.priceToTickIndex(
        new Decimal(price),
        pool.decimalsA,
        pool.decimalsB,
    );

    const spacing = pool.tickSpacing;

    if (direction === 'floor') {
        return Math.floor(rawTick / spacing) * spacing;
    } else {
        return Math.ceil(rawTick / spacing) * spacing;
    }
}

/**
 * Berechnet ATR (Average True Range) aus Tages-Candles.
 *
 * Aggregiert die stündlichen pool_stats-Einträge zu Tages-Candles (High/Low).
 * True Range = High − Low des Tages (24/7 Krypto: kein Overnight-Gap).
 * ATR = Durchschnitt der letzten `period` Tages-True-Ranges.
 *
 * Mindestanforderung: MIN_COMPLETE_DAYS vollständige Tage (≥18 Stunden Daten).
 * Fallback auf fixed wenn nicht genug Daten vorhanden.
 *
 * @param {Database} db
 * @param {string}   poolId
 * @param {number}   period    ATR-Periode in Tagen (z.B. 14)
 * @returns {number|null}      ATR in USD, oder null wenn nicht genug Tages-Daten
 */
function _calculateATR(db, poolId, period) {
    const MIN_COMPLETE_DAYS  = 7;   // mind. 7 vollständige Tage für ATR
    const MIN_POINTS_PER_DAY = 18;  // mind. 18 Stunden-Snapshots = "vollständiger" Tag

    const rows = db.prepare(`
        SELECT
            date(recorded_at / 1000, 'unixepoch') AS day,
            min(price) AS low,
            max(price) AS high,
            count(*)   AS n
        FROM pool_stats
        WHERE pool_id = ?
        GROUP BY day
        ORDER BY day ASC
    `).all(poolId);

    const candles = rows.filter(r => r.n >= MIN_POINTS_PER_DAY);

    if (candles.length < MIN_COMPLETE_DAYS) {
        return null;
    }

    // True Range pro Tag = High − Low (ausreichend für 24/7-Märkte ohne Gaps)
    const trs = candles.map(c => c.high - c.low);

    // Letzte `period` Werte (oder alle verfügbaren, wenn < period Tage)
    const use = trs.slice(-period);
    return use.reduce((a, b) => a + b, 0) / use.length;
}
