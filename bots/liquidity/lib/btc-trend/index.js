/**
 * BTC-Trend-Erfassung (LMB BTC-Korrelation, Phase 0).
 *
 * Reine Ableitung aus der stündlichen BTC-Preis-Historie (pool_stats, liq-btc-usdc) —
 * KEIN eigener API-Call. Berechnet ein Multi-Timeframe-Trendmeter:
 *
 *   Für jede Kombination aus Timeframe {1h, 4h, 12h, 24h} und EMA-Span {20, 30, 50}:
 *     BTC-Preis > EMA  →  1 Punkt, sonst 0.
 *   Max. 12 Punkte = klar bullisch (Preis über allen EMAs auf allen Timeframes).
 *   0 Punkte = klar bärisch (Preis unter allen EMAs).
 *
 * Das Meter ist ein Regime-Übergangs-Indikator, KEINE Wahrscheinlichkeit: Beim
 * Trendwechsel reclaimt der Preis erst die schnellen EMAs (1h/EMA20), dann die
 * langsamen — der Score steigt graduell. Die 12 Bits sind bewusst intern korreliert.
 *
 * Phase 0 erfasst nur. Die Verwendung im InvestScore (gewichtet je Pool-Typ, gekoppelt
 * an die token-spezifische BTC-Korrelation) folgt erst nach Backtest-Validierung.
 *
 */

// Quelle der BTC-Preisreihe (Pool mit USDC-Gegenseite → Preis ≈ BTC/USD).
export const BTC_POOL_ID = 'liq-btc-usdc';

// Timeframes (Candle-Länge in Stunden). Als Konstante gehalten, damit ein Wechsel
// (z.B. 4h → 6h) ein Einzeiler bleibt. Reihenfolge = Spaltenreihenfolge in der DB.
export const TIMEFRAMES = [
    { id: '1h',  hours: 1  },
    { id: '4h',  hours: 4  },
    { id: '12h', hours: 12 },
    { id: '24h', hours: 24 },
];

export const EMA_SPANS = [20, 30, 50];

const HOUR_MS = 3600_000;

/**
 * Stündliche Preispunkte zu Candles eines Timeframes resampeln.
 * Bucket nach floor(ts / candleMs); Candle-Close = letzter Preis im Bucket.
 *
 * @param {Array<{ts:number,price:number}>} points  chronologisch aufsteigend
 * @param {number} hours  Candle-Länge in Stunden
 * @returns {Array<{ts:number,close:number}>}  aufsteigend, ein Eintrag je Bucket
 */
export function resampleCandles(points, hours) {
    const candleMs = hours * HOUR_MS;
    const byBucket = new Map();           // bucketIndex → {ts, close}
    for (const p of points) {
        if (!Number.isFinite(p.price)) continue;
        const bucket = Math.floor(p.ts / candleMs);
        // Map bewahrt Einfügereihenfolge; bei aufsteigenden points ist der
        // zuletzt gesetzte Wert je Bucket automatisch der Close.
        byBucket.set(bucket, { ts: (bucket + 1) * candleMs, close: p.price });
    }
    return [...byBucket.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * Exponential Moving Average. Seed = SMA der ersten `span` Werte; davor null.
 *
 * @param {number[]} closes  aufsteigend
 * @param {number} span
 * @returns {Array<number|null>}  gleiche Länge wie closes
 */
export function ema(closes, span) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < span) return out;

    const mult = 2 / (span + 1);
    let sum = 0;
    for (let i = 0; i < span; i++) sum += closes[i];
    let prev = sum / span;                 // SMA-Seed
    out[span - 1] = prev;
    for (let i = span; i < closes.length; i++) {
        prev = (closes[i] - prev) * mult + prev;
        out[i] = prev;
    }
    return out;
}

/**
 * Letzten (aktuellsten) EMA-Wert für eine Close-Reihe holen.
 * @returns {number|null}  null wenn Warmup (< span Candles) nicht erfüllt.
 */
function latestEma(closes, span) {
    const series = ema(closes, span);
    return series.length ? series[series.length - 1] : null;
}

/**
 * BTC-Trendmeter aus stündlichen Preispunkten berechnen.
 * Der letzte Punkt gilt als "jetzt" (Vergleichspreis gegen alle EMAs).
 *
 * @param {Array<{ts:number,price:number}>} hourlyPoints  aufsteigend
 * @returns {{
 *   recorded_at:number, btc_price:number,
 *   emas: Object<string, number|null>,   // key 'ema_<tf>_<span>'
 *   bits: Object<string, 0|1>,           // key '<tf>_<span>'  (nur wo EMA vorhanden)
 *   trend_points:number,                 // Anzahl Preis>EMA (0..12)
 *   ema_available:number,                // Anzahl nicht-null EMAs (0..12)
 *   trend_pct:number|null                // trend_points / ema_available * 100
 * } | null}  null bei leerer Eingabe.
 */
export function computeBtcTrend(hourlyPoints) {
    if (!hourlyPoints?.length) return null;
    const sorted = [...hourlyPoints].sort((a, b) => a.ts - b.ts);
    const last   = sorted[sorted.length - 1];
    const price  = last.price;

    const emas = {};
    const bits = {};
    let points = 0;
    let available = 0;

    for (const tf of TIMEFRAMES) {
        const candles = resampleCandles(sorted, tf.hours);
        const closes  = candles.map(c => c.close);
        for (const span of EMA_SPANS) {
            const key  = `${tf.id}_${span}`;
            const eVal = latestEma(closes, span);
            emas[`ema_${key}`] = eVal;
            if (eVal == null) { bits[key] = 0; continue; }
            available += 1;
            const above = price > eVal ? 1 : 0;
            bits[key] = above;
            points   += above;
        }
    }

    return {
        recorded_at:   last.ts,
        btc_price:     price,
        emas,
        bits,
        trend_points:  points,
        ema_available: available,
        trend_pct:     available > 0 ? (points / available) * 100 : null,
    };
}
