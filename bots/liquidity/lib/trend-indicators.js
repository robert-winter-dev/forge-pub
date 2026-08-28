/**
 * FORGE Liquidity – Trend-Indikatoren auf Kerzen (lib/trend-indicators.js)
 *
 * ═══ Warum es dieses Modul gibt ═══════════════════════════════════════════════
 * `opportunity_scores.price_slope_pct` misst die **Steigung über ein Zeitfenster** —
 * beim Timeframe '1h' also im Kern die Differenz zweier Kurse. Das ist nicht der
 * „1h-Chart" eines Traders, sondern dessen letzte Kerze allein, und als Signal
 * wertlos: über 60 Tage lag die Trefferquote „nächste Stunde positiv" bei 50,1 %
 * gegen 50,5 % — ein Münzwurf. Genau deshalb steht `kPrice`/`kTrend` für 1h/6h/12h
 * in lib/opportunity-score/config.js auf 0.
 *
 * Ein EMA-Vergleich auf denselben 1h-Kerzen trägt dagegen 9 bis 21 Stunden
 * geglättete Information und trennt messbar. An den 721 echten Cleanup-Investments
 * der letzten 60 Tage (Ø USD-Korb-Rendite 6 h / 12 h nach dem Invest):
 *
 *   alle Investments (Status quo)      +0,290 %  /  +0,574 %
 *   1h-Rohsteigung > 0                 +0,233 %  /  +0,574 %   ← unbrauchbar
 *   EMA9 > EMA21 auf 1h-Kerzen         +0,434 %  /  +0,817 %
 *   4h-EMA-Trend aufwärts              +0,534 %  /  +0,909 %
 *   1D-EMA-Trend aufwärts              +0,723 %  /  +1,274 %
 *   4h + 1D aufwärts                   +0,757 %  /  +1,268 %
 *   4h + 1D aufwärts + 1h-EMA-Cross    +0,766 %  /  +1,302 %   ← beste Kombination
 *
 * 🔒 Die hier implementierten Definitionen sind **exakt die gemessenen**. Wer sie
 *    ändert (anderer EMA, anderes Kriterium), macht die Zahlen oben ungültig und
 *    muss neu messen.
 *
 * Zwei Konsumenten, eine Quelle: bin/cleanup.js filtert damit die „Bester Pool"-
 * Rangliste, bin/export.js schreibt denselben Zustand als `pool.trendGate` ins
 * Dashboard. Zwei Kopien dieser Berechnung wären zwangsläufig auseinandergelaufen
 * (dieselbe Lehre wie bei lib/invest-cooldown.js).
 *
 * ⚠️ Kursreihe: Bei volatilePair-Pools ist `pool_stats.price` die Token/Token-Ratio
 * und **kein** USD-Trend. Dieses Modul rechnet dort denselben USD-Korb-Mittelwert
 * wie bin/export.js (`usdAvg`) — der dokumentierte Fallstrick
 * priceSlopePct vs. usdTrendSlopePct gilt hier genauso.
 *
 * Reine DB-Lookups auf pool_stats, kein API-Call, kein Rate-Limit-Risiko.
 */

const HOUR_MS = 3_600_000;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Die drei anbietbaren Zeitebenen.
 *
 * `bucketHours`  Kerzenlänge (Close = letzter pool_stats-Wert im Bucket)
 * `rule`         'cross'  → EMA(fast) > EMA(slow)                  (1h)
 *                'rising' → EMA steigt UND Close liegt darüber      (4h, 1D)
 * `minCandles`   Untergrenze an Kerzen; darunter gilt der Zustand als unbekannt
 *                (und der Gate sperrt — ein junger Pool ist kein bestätigter Trend).
 */
export const TREND_SPECS = {
    '1h': { id: '1h', bucketHours: 1,  rule: 'cross',  fast: 9, slow: 21, minCandles: 24 },
    '4h': { id: '4h', bucketHours: 4,  rule: 'rising', period: 9,         minCandles: 11 },
    '1d': { id: '1d', bucketHours: 24, rule: 'rising', period: 5,         minCandles: 7  },
};

/** Reihenfolge für Anzeige und Log: kurz → lang. */
export const TREND_TIMEFRAMES = ['1h', '4h', '1d'];

/**
 * Wieviel Historie geladen werden muss. Bemessen nach dem längsten Bedarf: RSI14 auf
 * Tageskerzen braucht 15 Tage, dazu Puffer für Datenlöcher. Kostet ~30 ms für alle
 * Pools (eine pool_stats-Abfrage), deshalb keine knappere Bemessung je Zeitebene.
 */
export const TREND_LOOKBACK_DAYS = 20;

/** Höchstalter der jüngsten Kerze in Bucket-Längen — darüber gilt die Reihe als veraltet. */
const MAX_STALE_BUCKETS = 2;

// ─── Indikatoren ──────────────────────────────────────────────────────────────

/**
 * Exponentieller gleitender Durchschnitt.
 * Erste `period-1` Werte sind null (nicht genug Historie), danach klassisch
 * rekursiv mit k = 2/(period+1). Seed ist der erste Wert der Reihe.
 *
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]} gleiche Länge wie `values`
 */
export function ema(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = null;
    values.forEach((v, i) => {
        prev = prev == null ? v : v * k + prev * (1 - k);
        out.push(i >= period - 1 ? prev : null);
    });
    return out;
}

/**
 * Relative Strength Index (Wilder-Glättung).
 * Wird vom Gate nicht ausgewertet, aber fürs Dashboard/Tooltip mitgeliefert —
 * in der Messung lag „RSI14 > 50" mit +0,405 % / +0,747 % zwischen EMA-Cross und
 * Rohsteigung, ist also ein sinnvoller Kontextwert für den Betreiber.
 *
 * @param {number[]} values
 * @param {number} [period=14]
 * @returns {(number|null)[]}
 */
export function rsi(values, period = 14) {
    const out = new Array(values.length).fill(null);
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i < values.length; i++) {
        const diff = values[i] - values[i - 1];
        const gain = Math.max(diff, 0);
        const loss = Math.max(-diff, 0);
        if (i <= period) {
            avgGain += gain / period;
            avgLoss += loss / period;
            if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        } else {
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
    }
    return out;
}

// ─── Kursreihe → Kerzen ───────────────────────────────────────────────────────

/**
 * Verdichtet Rohpunkte zu Kerzen-Closes: je Zeitbucket der letzte Wert.
 * Fehlende Buckets werden **nicht** aufgefüllt — eine erfundene Kerze wäre ein
 * erfundener Trend. Stattdessen greift weiter unten die `minCandles`-Untergrenze.
 *
 * @param {{t:number, v:number}[]} points aufsteigend nach t
 * @param {number} bucketHours
 * @returns {{t:number, c:number}[]}
 */
export function toCandles(points, bucketHours) {
    const size = bucketHours * HOUR_MS;
    const byBucket = new Map();
    for (const p of points) byBucket.set(Math.floor(p.t / size) * size, p.v);
    return [...byBucket.keys()].sort((a, b) => a - b).map(t => ({ t, c: byBucket.get(t) }));
}

/**
 * Trendzustand einer einzelnen Zeitebene.
 *
 * @param {{t:number, v:number}[]} points
 * @param {object} spec Eintrag aus TREND_SPECS
 * @param {number} now
 * @returns {{up:boolean|null, reason:string, candles:number, close:number|null,
 *            fast:number|null, slow:number|null, rsi:number|null}}
 */
export function timeframeTrend(points, spec, now = Date.now()) {
    const unknown = (reason, candles = 0) =>
        ({ up: null, reason, candles, close: null, fast: null, slow: null, rsi: null });

    const candles = toCandles(points, spec.bucketHours);
    if (candles.length < spec.minCandles) return unknown('insufficient_data', candles.length);

    const last = candles[candles.length - 1];
    if (now - last.t > spec.bucketHours * MAX_STALE_BUCKETS * HOUR_MS)
        return unknown('stale_data', candles.length);

    const closes = candles.map(c => c.c);
    const rsiSeries = rsi(closes, 14);
    const rsiNow = rsiSeries[rsiSeries.length - 1] ?? null;
    const i = closes.length - 1;

    if (spec.rule === 'cross') {
        const fast = ema(closes, spec.fast)[i];
        const slow = ema(closes, spec.slow)[i];
        if (fast == null || slow == null) return unknown('insufficient_data', candles.length);
        return { up: fast > slow, reason: 'ok', candles: candles.length, close: last.c, fast, slow, rsi: rsiNow };
    }

    // 'rising': der EMA selbst muss steigen UND der Kurs darüber liegen. Beides
    // zusammen, weil ein steigender EMA nach einem Abverkauf noch nachläuft.
    const line = ema(closes, spec.period);
    const cur = line[i];
    const prev = line[i - 1];
    if (cur == null || prev == null) return unknown('insufficient_data', candles.length);
    return {
        up: cur > prev && last.c > cur,
        reason: 'ok', candles: candles.length, close: last.c,
        fast: cur, slow: prev, rsi: rsiNow,
    };
}

// ─── Kursreihen aus pool_stats ────────────────────────────────────────────────

/**
 * Rohpunkte je Pool: USD-Korb-Mittelwert bei volatilePair-Pools, sonst der
 * Pool-Preis. Identische Herleitung wie die `usdAvg`-Augmentierung in
 * bin/export.js (Quote-Pool mit direktem USDC-Bezug, max. 90 Minuten Lücke).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} pools  config.pools.all (Roh-Einträge aus pools.json)
 * @param {object} [opts]
 * @returns {Map<string, {t:number, v:number}[]>}
 */
export function loadPriceSeries(db, pools, { now = Date.now(), lookbackDays = TREND_LOOKBACK_DAYS } = {}) {
    const fromMs = now - lookbackDays * 24 * HOUR_MS;
    const rows = db.prepare(
        `SELECT pool_id, recorded_at, price FROM pool_stats
         WHERE recorded_at >= ? AND price > 0 ORDER BY recorded_at ASC`
    ).all(fromMs);

    const raw = new Map();
    for (const r of rows) {
        if (!raw.has(r.pool_id)) raw.set(r.pool_id, []);
        raw.get(r.pool_id).push({ t: r.recorded_at, p: r.price });
    }

    const byId = new Map(pools.map(p => [p.id, p]));
    const quoteAt = (quotePoolId, ts) => {
        const arr = raw.get(quotePoolId);
        if (!arr?.length) return null;
        let lo = 0, hi = arr.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t <= ts) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        if (idx < 0 || ts - arr[idx].t > 90 * 60_000) return null;
        return arr[idx].p;
    };

    const series = new Map();
    for (const pool of pools) {
        const rowsForPool = raw.get(pool.id);
        if (!rowsForPool?.length) continue;

        if (!pool.volatilePair) {
            series.set(pool.id, rowsForPool.map(r => ({ t: r.t, v: r.p })));
            continue;
        }

        // volatilePair: ohne auflösbaren Quote-Pool gibt es keinen USD-Trend. Die
        // Ratio hier ersatzweise zu nehmen wäre schlimmer als nichts — sie kann
        // fallen, während beide Token in USD steigen.
        const quoteCfg = byId.get(pool.quotePricePoolId);
        if (!pool.quotePricePoolId || !pool.quoteTokenMint || !quoteCfg
            || quoteCfg.derivedQuote || quoteCfg.usdcIsTokenA || quoteCfg.tokenB !== USDC_MINT) continue;

        const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
        const out = [];
        for (const r of rowsForPool) {
            const quoteUsd = quoteAt(pool.quotePricePoolId, r.t);
            if (!quoteUsd || quoteUsd <= 0) continue;
            const usdA = quoteIsTokenA ? quoteUsd : r.p * quoteUsd;
            const usdB = quoteIsTokenA ? quoteUsd / r.p : quoteUsd;
            if (usdA > 0 && usdB > 0) out.push({ t: r.t, v: 0.5 * (usdA + usdB) });
        }
        if (out.length) series.set(pool.id, out);
    }
    return series;
}

/**
 * Trendzustand aller Pools über alle drei Zeitebenen.
 *
 * @returns {Map<string, Record<string, object>>} poolId → { '1h': {...}, '4h': {...}, '1d': {...} }
 */
export function loadTrendStates(db, pools, { now = Date.now(), lookbackDays = TREND_LOOKBACK_DAYS } = {}) {
    const series = loadPriceSeries(db, pools, { now, lookbackDays });
    const states = new Map();
    for (const pool of pools) {
        const points = series.get(pool.id) ?? [];
        const state = {};
        for (const tf of TREND_TIMEFRAMES) state[tf] = timeframeTrend(points, TREND_SPECS[tf], now);
        states.set(pool.id, state);
    }
    return states;
}

// ─── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Parst die Konfiguration (.env `CLEANUP_TREND_GATE`, Komma-Liste).
 * Unbekannte Einträge werden verworfen, Reihenfolge ist immer kurz → lang.
 *
 * @param {string|null|undefined} raw z.B. '4h,1d'
 * @returns {string[]} leer = Gate aus
 */
export function parseTrendGate(raw) {
    if (!raw) return [];
    const wanted = new Set(
        String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
            .map(s => (s === '24h' || s === '1D' ? '1d' : s)),
    );
    return TREND_TIMEFRAMES.filter(tf => wanted.has(tf));
}

/**
 * Prüft einen Trendzustand gegen die geforderten Zeitebenen.
 *
 * 🔒 Ein **unbekannter** Trend sperrt (wie ein fehlender TVL-Messwert im
 *    Invest-Guard): Beim Eintritt ist Nichtstun die sichere Richtung, es ist kein
 *    Kapital in Gefahr und der nächstbeste Pool rückt ohne Verlust nach.
 *
 * @param {Record<string, object>|null} state Ergebnis aus loadTrendStates()
 * @param {string[]} required
 * @returns {{ok:boolean, failing:string[], unknown:string[], reason:string|null}}
 */
export function checkTrendGate(state, required) {
    if (!required?.length) return { ok: true, failing: [], unknown: [], reason: null };

    const failing = [];
    const unknown = [];
    for (const tf of required) {
        const s = state?.[tf];
        if (!s || s.up == null) { unknown.push(tf); continue; }
        if (s.up !== true) failing.push(tf);
    }
    if (!failing.length && !unknown.length) return { ok: true, failing: [], unknown: [], reason: null };

    const parts = [];
    if (failing.length) parts.push(`Trend ${failing.join('/')} nicht aufwärts`);
    if (unknown.length) parts.push(`Trend ${unknown.join('/')} nicht bestimmbar`);
    return { ok: false, failing, unknown, reason: parts.join(', ') };
}
