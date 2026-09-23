/**
 * ════════════════════════════════════════════════════════════════════════════
 *  FEE-/LVR-QUOTIENT Q je Pool · LIQ#000871 (KB Liquidity Bot/preis-leg-im-score.md, Ansatz B)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Frage: Decken die Gebühren eines Pools sein Kursrisiko — unabhängig von der eigenen Range
 *  und auch ohne eigene Position?
 *
 *      Q = Fee je Full-Range-Liquiditätseinheit und Tag  /  (κ · σ_Tag² / 8)
 *
 *  Q > 1: LP schlägt Halten im Erwartungswert, Q < 1: verliert gegen Halten. Fee und Verlust
 *  (LVR, Milionis et al. 2022) skalieren beide mit der Konzentration der Position, deshalb ist
 *  das Verhältnis eine Pool-Eigenschaft. Herleitung und Probe: KB (s.o.), nicht hier.
 *
 *  ZÄHLER — Fee je Einheit: je Stunde volume_hourly.volume_usd × fee_tier geteilt durch den
 *  USD-Wert der aktiven Liquidität am Tick als Full-Range-Position, summiert über feeWindowH
 *  und auf 24 h skaliert. Full-Range-Wert einer Liquidität L beim Preis P (Token A in Token B):
 *      x = L/√P, y = L·√P  ⇒  Wert in Token B = 2·L·√P
 *  L aus pool_stats.liquidity_in_range ist roh (On-Chain), human L = L_raw / 10^((decA+decB)/2)
 *  — dieselbe Skala wie clmmLiquidityFromCapital() in lib/clmm-lp.js. Token B → USD über
 *  tokenUsdPrices() aus lib/pnl.js (keine eigene Kursquelle). Stündlich statt fees_24h_usd /
 *  L am Messzeitpunkt: L schwankt, wenn große LPs ihre Range verschieben; so trifft jede
 *  Stunde Gebühr auf die Liquidität, die sie verdient hat (wie der validierte Fee-Leg des
 *  Fee-/Preis-Rechners). Die Einzelpunkt-Variante steht als feePerUnitDaySnapshot daneben.
 *  Dieses Maß ersetzt den Pool-APR: Fees/TVL ist in Pools mit eng konzentrierten LPs
 *  aufgebläht.
 *
 *  NENNER — σ: stündliche log-Renditen des Paar-Verhältnisses (pool_stats.price, letzter Wert
 *  je Uhrstunde), nur zwischen aufeinanderfolgenden Stunden (Lücke > 1 h bricht die Rendite),
 *  ohne Mittelwertabzug (quadratische Variation, wie LVR sie braucht). σ_Tag = σ_h · √24.
 *  κ = empirischer Sprungfaktor (Startwert 1,7, Kalibrierung in bin/fee-lvr-backtest.js).
 *
 *  🔒 Ausschließlich Daten ≤ atMs (kein Blick in die Zukunft). Fehlen Daten: q = null mit
 *  Grund, nie schätzen. Rein lesend.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { tokenUsdPrices } from '../../../lib/pnl.js';

const HOUR_MS = 3_600_000;
export const KAPPA_START = 1.7;
const MIN_RETURNS    = 48;     // wie MIN_PRICE_POINTS im Range Advisor
const MIN_FEE_HOURS  = 12;     // von 24: darunter ist die Fee-Rate Zufall
const SNAP_MAX_AGE_MS = 90 * 60_000;   // wie _PRICE_MAX_AGE_MS in lib/pnl.js

const _stmtCache = new WeakMap();
function _stmts(db) {
    if (!_stmtCache.has(db)) {
        _stmtCache.set(db, {
            pool:   db.prepare(`SELECT id, pair, pool_type, decimals_a, decimals_b, fee_tier FROM pools WHERE id = ?`),
            prices: db.prepare(`SELECT price, liquidity_in_range, fees_24h_usd, recorded_at FROM pool_stats
                                 WHERE pool_id = ? AND recorded_at > ? AND recorded_at <= ? ORDER BY recorded_at`),
            vols:   db.prepare(`SELECT ts, volume_usd FROM volume_hourly
                                 WHERE pool_id = ? AND ts >= ? AND ts + ${HOUR_MS} <= ? ORDER BY ts`),
        });
    }
    return _stmtCache.get(db);
}

const _usdCache = new WeakMap();
/** USD-Kurs-Funktion je Pool (lib/pnl.js), je DB-Handle zwischengespeichert. */
export function usdPricesFor(db, poolId) {
    if (!_usdCache.has(db)) _usdCache.set(db, new Map());
    const m = _usdCache.get(db);
    if (!m.has(poolId)) m.set(poolId, tokenUsdPrices(db, { flavor: 'liquidity', scope: poolId }));
    return m.get(poolId);
}

/** USD-Wert der Liquidität L_raw als Full-Range-Position beim Preis P (Token A in Token B). */
export function fullRangeUsd(lRaw, price, usdB, decimalsA, decimalsB) {
    if (!(lRaw > 0) || !(price > 0) || !(usdB > 0)) return null;
    const lHuman = lRaw / Math.pow(10, (decimalsA + decimalsB) / 2);
    return 2 * lHuman * Math.sqrt(price) * usdB;
}

/**
 * σ je Stunde aus stündlichen log-Renditen (letzter Preis je Uhrstunde, Lücken brechen).
 * @param {Array<{price:number, recorded_at:number}>} rows aufsteigend
 */
export function hourlySigma(rows) {
    const byHour = new Map();
    for (const r of rows) if (r.price > 0) byHour.set(Math.floor(r.recorded_at / HOUR_MS), r.price);
    const hours = [...byHour.keys()].sort((a, b) => a - b);
    let sumSq = 0, n = 0, breaks = 0;
    for (let i = 1; i < hours.length; i++) {
        if (hours[i] - hours[i - 1] !== 1) { breaks++; continue; }
        const lr = Math.log(byHour.get(hours[i]) / byHour.get(hours[i - 1]));
        sumSq += lr * lr; n++;
    }
    return { sigmaHour: n > 0 ? Math.sqrt(sumSq / n) : null, n, breaks };
}

/**
 * Fee-/LVR-Quotient eines Pools zum Zeitpunkt atMs.
 *
 * @returns {{ q:number|null, feePerUnitDay:number|null, feePerUnitDaySnapshot:number|null,
 *             sigmaDay:number|null, lvrDay:number|null, kappa:number, n:number,
 *             feeHours:number, dataGaps:{noLiquidity:number, noUsd:number, noSnapshot:number,
 *             returnBreaks:number}, reason:string|null }}
 *   feePerUnitDay/lvrDay als Anteil (0,01 = 1 %/Tag), n = Zahl der Stundenrenditen.
 */
export function feeLvrQuotient(db, poolId, { atMs, sigmaWindowH = 168, feeWindowH = 24, kappa = KAPPA_START } = {}) {
    const s = _stmts(db);
    const dataGaps = { noLiquidity: 0, noUsd: 0, noSnapshot: 0, returnBreaks: 0 };
    const out = { q: null, feePerUnitDay: null, feePerUnitDaySnapshot: null, sigmaDay: null, lvrDay: null,
                  kappa, n: 0, feeHours: 0, dataGaps, reason: null };
    const fail = reason => ({ ...out, reason });

    const pool = s.pool.get(poolId);
    if (!pool) return fail('Pool unbekannt');
    if (!Number.isFinite(atMs)) return fail('atMs fehlt');
    const usdAt = usdPricesFor(db, poolId);
    if (!usdAt) return fail('kein USD-Bezug für Token B');

    // ── σ ────────────────────────────────────────────────────────────────────
    const lookback = Math.max(sigmaWindowH, feeWindowH) * HOUR_MS + SNAP_MAX_AGE_MS;
    const rows = s.prices.all(poolId, atMs - lookback, atMs);
    const sigRows = rows.filter(r => r.recorded_at > atMs - sigmaWindowH * HOUR_MS);
    const sig = hourlySigma(sigRows);
    out.n = sig.n; dataGaps.returnBreaks = sig.breaks;
    if (sig.n < MIN_RETURNS) return fail(`zu wenig Stundenrenditen (${sig.n} < ${MIN_RETURNS})`);
    out.sigmaDay = sig.sigmaHour * Math.sqrt(24);
    out.lvrDay   = kappa * out.sigmaDay ** 2 / 8;

    // ── Fee je Full-Range-Einheit ────────────────────────────────────────────
    // Je Volumen-Stunde: jüngster Snapshot ≤ Stundenende (und ≤ atMs), höchstens 90 min alt.
    const vols = s.vols.all(poolId, atMs - feeWindowH * HOUR_MS, atMs);
    let j = -1, sumRate = 0;
    for (const v of vols) {
        const tEnd = v.ts + HOUR_MS;
        while (j + 1 < rows.length && rows[j + 1].recorded_at <= tEnd) j++;
        const snap = j >= 0 ? rows[j] : null;
        if (!snap || tEnd - snap.recorded_at > SNAP_MAX_AGE_MS) { dataGaps.noSnapshot++; continue; }
        if (snap.liquidity_in_range == null || !(Number(snap.liquidity_in_range) > 0)) { dataGaps.noLiquidity++; continue; }
        const p = usdAt(snap.recorded_at);
        if (!p) { dataGaps.noUsd++; continue; }
        const frv = fullRangeUsd(Number(snap.liquidity_in_range), snap.price, p.b, pool.decimals_a, pool.decimals_b);
        if (!frv) { dataGaps.noLiquidity++; continue; }
        out.feeHours++;
        sumRate += (v.volume_usd > 0 ? v.volume_usd : 0) * (pool.fee_tier / 100) / frv;
    }
    // Stunden ohne Volumen-Zeile fehlen in volume_hourly ganz — nur echte Datenlücken zählen
    // gegen die Mindestabdeckung, die Rate wird auf die gedeckten Stunden bezogen.
    if (out.feeHours < MIN_FEE_HOURS) {
        return fail(dataGaps.noLiquidity > 0 && out.feeHours === 0 ? 'keine liquidity_in_range'
                  : dataGaps.noUsd > 0 && out.feeHours === 0 ? 'kein USD-Kurs'
                  : `zu wenig Fee-Stunden (${out.feeHours} < ${MIN_FEE_HOURS})`);
    }
    out.feePerUnitDay = sumRate / out.feeHours * 24;

    // Vergleich: fees_24h_usd / Full-Range-Wert am letzten Snapshot ≤ atMs
    const last = rows.length ? rows[rows.length - 1] : null;
    if (last && last.fees_24h_usd != null && atMs - last.recorded_at <= SNAP_MAX_AGE_MS) {
        const p = usdAt(last.recorded_at);
        const frv = p ? fullRangeUsd(Number(last.liquidity_in_range), last.price, p.b, pool.decimals_a, pool.decimals_b) : null;
        if (frv) out.feePerUnitDaySnapshot = last.fees_24h_usd / frv;
    }

    out.q = out.lvrDay > 0 ? out.feePerUnitDay / out.lvrDay : null;
    if (out.q == null) return fail('σ = 0');
    return out;
}

/**
 * Konzentrationsfaktor c einer symmetrischen Range (Halbbreite rangePct) gegenüber Full Range,
 * bezogen auf den Positionswert in der Range-Mitte: Fee-Anteil und LVR einer Position je
 * eingesetztem USD sind c-mal so groß wie je Full-Range-USD. Aus derselben Algebra wie
 * clmmLiquidityFromCapital(): Wert = L·√P·denom, Full Range = 2·L·√P ⇒ c = 2/denom.
 */
export function concentrationFactor(rangePct) {
    const r = rangePct / 100;
    if (!(r > 0) || r >= 1) return null;
    const denom = (1 - 1 / Math.sqrt(1 + r)) + (1 - Math.sqrt(1 - r));
    return denom > 0 ? 2 / denom : null;
}
