/**
 * ════════════════════════════════════════════════════════════════════════════
 *  FEE-MODELL · eine Fee-Schätzung für Rechner, Anzeige und Range Advisor (LIQ#000884)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Formel (validiert in bin/fee-price-calculator.js --validate, LIQ#0361/LIQ#000883):
 *      feeUsd(Stunde) = volume_usd × feeTier × LP-Anteil × myL_raw / L_in_range_raw
 *  nur in Stunden, in denen der Preis innerhalb der Range liegt (In-Range-Gate). myL_raw aus
 *  clmmLiquidityFromCapital() (lib/clmm-lp.js), dieselbe Einheit wie pool_stats.liquidity_in_range.
 *  Referenzpreis/-liquidität je Stunde: nächstliegender pool_stats-Snapshot zur Bucket-Mitte.
 *
 *  Zwei Verwendungen, EIN Rechenkern (feeLegUsd):
 *    - Rückblick auf eine gehaltene Position (Rechner, Validierung): L_in_range enthält die eigene
 *      Liquidität bereits → ownInDenominator: false.
 *    - Ex-ante-Schätzung (estimateFeeApr: npWindows, Range Advisor): „Was hätte eine Position mit
 *      diesem Kapital und dieser Range im letzten Fenster verdient?" Die Position gab es nicht, ihr
 *      L kommt zum Pool-L hinzu → ownInDenominator: true (sonst überschätzt die Schätzung kleine
 *      Pools, genau der Fall, den LIQ#000884 behebt).
 *
 *  Warum diese Formel und nicht die alten Schätzer (_npFeeAprPct: 24h-Fees zum Stand jetzt, kein
 *  In-Range-Gate, kein LP-Anteil → Σ 1,7–2,5× zu hoch; scoreRange: TVL gleichmäßig über ±10 %,
 *  × 0,85 → Σ 0,5–0,8× zu tief): KB Strategien/fee-preis-rechner.md.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { clmmLiquidityFromCapital } from './clmm-lp.js';
import { usdPricesFor } from './fee-lvr.js';

const HOUR_MS = 3_600_000;
const DAY_MS  = 24 * HOUR_MS;

// ── LP-Anteil am Swap-Fee ────────────────────────────────────────────────────
// Orca behält `protocolFeeRate` vom Swap-Fee ein (@orca-so/whirlpools-sdk, swap-manager.js
// calculateProtocolFee), die LPs bekommen den Rest. On-chain gelesen am 22.09.2026 für alle 64
// Pools: protocolFeeRate = 1300 (Basis 10.000) → 13 % Orca, 87 % LPs (LIQ#000883).
// Konstante statt Datei/DB-Spalte, damit sie in jeder Installation ohne Migration gilt. Dass sie
// stimmt, prüft `node bin/read-protocol-fee-rates.js --check` wöchentlich gegen die Kette
// (config/cron-jobs.json, Meldung im Message Center bei Abweichung) — nicht nur behauptet.
export const ORCA_PROTOCOL_FEE_RATE = 1300;                      // Basis 10.000
export const ORCA_LP_SHARE          = 1 - ORCA_PROTOCOL_FEE_RATE / 10_000;   // 0,87

// ── Schalter für die Umstellung (LIQ#000884), getrennt nach Wirkung ────────
// Umschalten erst nach Freigabe der Vorher/Nachher-Tabelle (bin/fee-model-compare.js).
//   FEE_MODEL_V2          Anzeige: npWindows (kursive PnL-Schätzung), NP-Range, NP-Qualitätslog und
//                         darüber der InvestScore-NP-Fallback (bin/export.js).
//   FEE_MODEL_V2_ADVISOR  Range Advisor: analyzePool() → Range, die der Bot beim Öffnen/Rebalance
//                         AUTOMATISCH anwendet, dazu pool-scores.json (Settings, Premium-Tabelle).
// false = Rechnung wie vor LIQ#000884. Env FORGE_FEE_MODEL_V2 / FORGE_FEE_MODEL_V2_ADVISOR = 1|0
// übersteuert (Tests/Vergleich).
// Freigabe 22.09.2026: Anzeige an. Advisor AUS — bin/range-choice-backtest.js: die neue
// Range-Wahl verdient danach weniger (72 h, 0,12 %/Rebalance: Σ −2.847 USDC über 363 Stichtage,
// beide Hälften negativ, Treffer 42 %). Nicht ohne neuen In-Range-Term + denselben Backtest
// einschalten — KB Strategien/fee-preis-rechner.md, „Backtest Range-Wahl".
const envFlag = (name, def) => process.env[name] != null ? process.env[name] === '1' : def;
export const FEE_MODEL_V2         = envFlag('FORGE_FEE_MODEL_V2', true);
export const FEE_MODEL_V2_ADVISOR = envFlag('FORGE_FEE_MODEL_V2_ADVISOR', false);

export const DEFAULT_WINDOW_MS = DAY_MS;

// ── Pool-Metadaten und Zeitreihen (DB ist autoritativ) ──────────────────────
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export function loadPool(db, poolId) {
    return db.prepare(`
        SELECT id, decimals_a, decimals_b, fee_tier, pair, pool_type, token_a, token_b
        FROM pools WHERE id = ?
    `).get(poolId);
}

// volatilePair = keine Seite ist USDC. Bis LIQ#000884 über den Namen erkannt (kein "/USDC"-Suffix);
// das hielt EURC/USDC, SPX/USDC, NATIX/USDC und HIMS/USDC für Pools mit USDC als Token B — dort ist
// USDC aber Token A, Token B der andere Token. Jetzt über die Mints.
export function isVolatilePair(pool) {
    return !!pool && pool.token_a !== USDC_MINT && pool.token_b !== USDC_MINT;
}

/**
 * USD-Kurs von Token B zu einem Zeitpunkt → (t) => number | null.
 *   Token B = USDC: 1.
 *   Token A = USDC: 1 / Preis (Preis = Token B je Token A), nächstliegender Snapshot aus `stats`.
 *   sonst:          tokenUsdPrices() aus lib/pnl.js (über usdPricesFor, kein Nachbau).
 * Vor LIQ#000884 rechneten Token-A-USDC-Pools mit 1 — das Kapital landete um den Faktor Preis
 * daneben (NATIX/USDC: Fee ≈ 0).
 */
export function usdOfTokenB(db, pool, stats) {
    if (pool.token_b === USDC_MINT) return () => 1;
    if (pool.token_a === USDC_MINT) {
        return (t) => {
            const i = nearestIndex(stats, t);
            const p = i >= 0 ? stats[i].price : null;
            return p > 0 ? 1 / p : null;
        };
    }
    const usdAt = usdPricesFor(db, pool.id);
    return (t) => { const b = usdAt ? usdAt(t)?.b : null; return b > 0 ? b : null; };
}

export function loadPoolStats(db, poolId, fromMs, toMs) {
    return db.prepare(`
        SELECT price, liquidity_in_range, recorded_at
        FROM pool_stats
        WHERE pool_id = ? AND recorded_at >= ? AND recorded_at <= ?
        ORDER BY recorded_at ASC
    `).all(poolId, fromMs, toMs);
}

export function loadVolumeHourly(db, poolId, fromMs, toMs) {
    return db.prepare(`
        SELECT ts, volume_usd
        FROM volume_hourly
        WHERE pool_id = ? AND ts >= ? AND ts < ?
        ORDER BY ts ASC
    `).all(poolId, fromMs, toMs);
}

// Index des nächstliegenden pool_stats-Snapshots zu einem Zeitpunkt (aus der sortierten Liste).
// `from` = Startindex der Suche, für aufsteigende ts-Folgen.
export function nearestIndex(stats, ts, from = 0) {
    if (!stats.length) return -1;
    let best = from, bestDiff = Math.abs(stats[from].recorded_at - ts);
    for (let i = from + 1; i < stats.length; i++) {
        const diff = Math.abs(stats[i].recorded_at - ts);
        if (diff < bestDiff) { best = i; bestDiff = diff; }
        if (stats[i].recorded_at > ts && diff > bestDiff) break; // sortiert, ab hier nur schlimmer
    }
    return best;
}

/**
 * Rechenkern: Fee-Leg über stündliche Volumen-Buckets.
 *
 * @param {object}   a
 * @param {Array}    a.stats      pool_stats (price, liquidity_in_range, recorded_at), aufsteigend
 * @param {Array}    a.volumes    volume_hourly (ts, volume_usd), aufsteigend
 * @param {Array}    a.segments   [{ startIdx, ref, myL }] Range-Abschnitte (ohne Rebalance: einer)
 * @param {number}   a.feeTierPct Fee-Satz des Pools in %
 * @param {number}   a.rangePct   Range-Halbbreite in %
 * @param {boolean} [a.rebalance] Abschnitte folgen dem Rebalance-Pfad
 * @param {Function}[a.capitalFactorAt] (t) → Kapitalfaktor (Nachzahlungen), Vorgabe 1
 * @param {boolean} [a.ownInDenominator] eigenes L zu L_in_range addieren (Ex-ante, siehe Kopf)
 * @param {number}  [a.lpShare]   Vorgabe ORCA_LP_SHARE
 * @returns {{ feeUsd:number, hoursWithVolume:number, hoursInRange:number }}
 */
export function feeLegUsd({ stats, volumes, segments, feeTierPct, rangePct, rebalance = false,
                            capitalFactorAt = null, ownInDenominator = false, lpShare = ORCA_LP_SHARE }) {
    const r = rangePct / 100;
    const lpFeeFrac = feeTierPct * lpShare / 100;   // Anteil der LPs am Volumen
    let feeUsd = 0, hoursWithVolume = 0, hoursInRange = 0, idx = 0, seg = 0;
    for (const bucket of volumes) {
        if (!(bucket.volume_usd > 0)) continue;
        hoursWithVolume++;
        idx = nearestIndex(stats, bucket.ts + HOUR_MS / 2, rebalance ? idx : 0); // Bucket-Mitte
        const snap = idx >= 0 ? stats[idx] : null;
        if (!snap || !(snap.price > 0) || snap.liquidity_in_range == null) continue;
        if (rebalance) {
            seg = 0;
            while (seg + 1 < segments.length && segments[seg + 1].startIdx <= idx) seg++;
        }
        const g = segments[seg];
        if (snap.price < g.ref * (1 - r) || snap.price > g.ref * (1 + r)) continue; // out-of-range
        const lInRange = Number(snap.liquidity_in_range);
        if (!(lInRange > 0)) continue;
        hoursInRange++;
        const myL = g.myL * (capitalFactorAt ? capitalFactorAt(bucket.ts + HOUR_MS / 2) : 1);
        feeUsd += bucket.volume_usd * lpFeeFrac * (myL / (ownInDenominator ? lInRange + myL : lInRange));
    }
    return { feeUsd, hoursWithVolume, hoursInRange };
}

/**
 * Lädt die Eingaben für estimateFeeApr einmal je Pool und Fenster — für den Kandidaten-Scan über
 * viele Ranges (Range Advisor, export.js) ohne Query je Range. Nur Daten ≤ asOfMs.
 * @returns {object} { pool, volatilePair, stats, volumes, usdB0, fromMs, toMs } oder { skipped }
 */
export function loadFeeInputs(db, poolId, { asOfMs = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
    const pool = loadPool(db, poolId);
    if (!pool) return { skipped: 'Pool unbekannt' };
    const toMs = asOfMs, fromMs = asOfMs - windowMs;
    const stats = loadPoolStats(db, poolId, fromMs, toMs);
    if (stats.length < 2) return { skipped: 'zu wenig pool_stats im Fenster' };
    if (!(stats[0].price > 0)) return { skipped: 'kein gültiger Einstiegspreis' };
    if (!stats.some(s => s.liquidity_in_range != null)) return { skipped: 'keine liquidity_in_range-Daten im Fenster' };
    const volumes = loadVolumeHourly(db, poolId, fromMs, toMs);
    if (!volumes.some(v => v.volume_usd > 0)) return { skipped: 'kein Volumen im Fenster' };

    // Kapital USD → Token B zum Kurs bei Fensterbeginn, wie im Rechner.
    const volatilePair = isVolatilePair(pool);
    const usdB0 = usdOfTokenB(db, pool, stats)(stats[0].recorded_at);
    if (!(usdB0 > 0)) return { skipped: 'kein USD-Kurs' };
    return { pool, volatilePair, stats, volumes, usdB0, fromMs, toMs };
}

/**
 * Brutto-Fee-APR einer hypothetischen Position aus vorgeladenen Eingaben (loadFeeInputs).
 * Position eröffnet bei Fensterbeginn zum damaligen Preis, symmetrische Range ±rangePct, ohne
 * Rebalance — In-Range-Anteil des Fensters ist damit eingerechnet.
 * @returns {{ grossAprPct:number|null, feeUsd?, hoursInRange?, hoursWithVolume?, reason? }}
 */
export function feeAprFromInputs(inputs, rangePct, capitalUsdc) {
    if (!inputs || inputs.skipped) return { grossAprPct: null, reason: inputs?.skipped ?? 'keine Eingaben' };
    if (!(rangePct > 0) || !(capitalUsdc > 0)) return { grossAprPct: null, reason: 'Range/Kapital ungültig' };
    const { pool, stats, volumes, usdB0, fromMs, toMs } = inputs;
    const P0 = stats[0].price;
    const myL = clmmLiquidityFromCapital(P0, capitalUsdc / usdB0, rangePct, pool.decimals_a, pool.decimals_b);
    if (!(myL > 0)) return { grossAprPct: null, reason: 'myL nicht berechenbar' };
    const leg = feeLegUsd({ stats, volumes, segments: [{ startIdx: 0, ref: P0, myL }],
                            feeTierPct: pool.fee_tier, rangePct, ownInDenominator: true });
    const days = (toMs - fromMs) / DAY_MS;
    const grossAprPct = leg.feeUsd / capitalUsdc / days * 365 * 100;
    if (!Number.isFinite(grossAprPct) || grossAprPct < 0) return { grossAprPct: null, reason: 'Ergebnis ungültig' };
    return { grossAprPct, ...leg };
}

/**
 * Brutto-Fee-APR für Pool/Range/Kapital aus dem Fenster [asOfMs − windowMs, asOfMs].
 * @param {Database} db
 * @param {{ poolId:string, rangePct:number, capitalUsdc?:number, asOfMs?:number, windowMs?:number }} a
 */
export function estimateFeeApr(db, { poolId, rangePct, capitalUsdc = 1000, asOfMs = Date.now(), windowMs = DEFAULT_WINDOW_MS }) {
    return feeAprFromInputs(loadFeeInputs(db, poolId, { asOfMs, windowMs }), rangePct, capitalUsdc);
}

/**
 * Für scoreRange(): (rangePct) → grossAprPct | null, Eingaben einmal geladen.
 * @returns {Function}
 */
export function feeAprScanner(db, poolId, { capitalUsdc = 1000, asOfMs = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
    const inputs = loadFeeInputs(db, poolId, { asOfMs, windowMs });
    const cache = new Map();
    return (rangePct) => {
        if (!cache.has(rangePct)) cache.set(rangePct, feeAprFromInputs(inputs, rangePct, capitalUsdc).grossAprPct);
        return cache.get(rangePct);
    };
}
