/**
 * FORGE Liquidity – Pool-Typ-Drift-Check (öffentlich, keine Score-Gewichte)
 *
 * Reine Vola-Klassifizierung: hat sich die gemessene Tagesvola eines Pools so
 * verschoben, dass er in einen anderen Pool-Typ gehört? Enthält KEINE PnL-/APR-
 * Gewichtsfrage (die bleibt Master-only, lib/pool-type-advisor.js) — nur die Frage
 * "sitzt der Pool noch im richtigen Vola-Bucket?". `rwa` hat keine Vola-Grenze
 * (VOLA_TYPE_BOUNDARIES.rwa = null) und wird darum strukturell übersprungen
 * (nicht über Vola klassifizierbar, siehe Pool-Type-Advisor-Dokumentation).
 *
 * Lift aus lib/pool-type-advisor.js (LIQ#0332, Festlegung): computeVolaDrift()
 * war dort bereits eine reine Funktion ohne PnL-/DB-Abhängigkeit — nur ausgelagert,
 * damit bot.js (Fork-Entry-Point) sie importieren kann, ohne die Master-only-Datei
 * (lib/pnl.js-Abhängigkeit, PnL-Counterfactual) mitzuziehen.
 */

import {
    VOLA_TYPE_ORDER,
    VOLA_TYPE_BOUNDARIES,
    VOLA_BOUNDARY_HYSTERESIS_PP,
    VOLA_BOUNDARY_DRIFT_DAYS,
} from './pool-type-boundaries.js';

const DAY_MS = 86_400_000;

function nextTypeUp(type) {
    const i = VOLA_TYPE_ORDER.indexOf(type);
    return i >= 0 && i < VOLA_TYPE_ORDER.length - 1 ? VOLA_TYPE_ORDER[i + 1] : null;
}
function nextTypeDown(type) {
    const i = VOLA_TYPE_ORDER.indexOf(type);
    return i > 0 ? VOLA_TYPE_ORDER[i - 1] : null;
}

/**
 * Prüft, ob die Tagesvola eines Pools (aus `stats`, z.B. pool_stats-Zeilen mit
 * `recorded_at`/`price`) dauerhaft über/unter der Typ-Grenze liegt.
 *
 * @param {Array<{recorded_at:number, price:number}>} stats
 * @param {{id:string, poolType:string}} pool
 * @param {number} windowDays  Beobachtungsfenster (Default: VOLA_BOUNDARY_DRIFT_DAYS)
 * @returns {object} u.a. { applicable, reassignmentCandidate, suggestedType, medianVola }
 */
export function computeVolaDrift(stats, pool, windowDays = VOLA_BOUNDARY_DRIFT_DAYS) {
    const boundaries = VOLA_TYPE_BOUNDARIES[pool.poolType];
    if (!boundaries) {
        return { poolId: pool.id, currentType: pool.poolType, applicable: false };
    }

    const cutoff = Date.now() - windowDays * DAY_MS;
    const byDay = new Map();
    for (const s of stats) {
        if (s.recorded_at < cutoff || !s.price || s.price <= 0) continue;
        const dayKey = Math.floor(s.recorded_at / DAY_MS);
        const d = byDay.get(dayKey);
        if (!d) byDay.set(dayKey, { min: s.price, max: s.price });
        else { d.min = Math.min(d.min, s.price); d.max = Math.max(d.max, s.price); }
    }
    const dailyVola = [...byDay.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([day, d]) => ({ day, volaPct: d.min > 0 ? (d.max - d.min) / d.min * 100 : null }))
        .filter(d => d.volaPct != null);

    if (dailyVola.length === 0) {
        return { poolId: pool.id, currentType: pool.poolType, applicable: true, medianVola: null, sampleDays: 0, reassignmentCandidate: false };
    }

    const sortedVola = dailyVola.map(d => d.volaPct).sort((a, b) => a - b);
    const medianVola = sortedVola[Math.floor(sortedVola.length / 2)];

    const trailingStreak = (predicate) => {
        let n = 0;
        for (let i = dailyVola.length - 1; i >= 0; i--) {
            if (predicate(dailyVola[i].volaPct)) n++;
            else break;
        }
        return n;
    };
    const daysBeyondUpper = boundaries.upper != null
        ? trailingStreak(v => v > boundaries.upper + VOLA_BOUNDARY_HYSTERESIS_PP) : 0;
    const daysBeyondLower = boundaries.lower != null
        ? trailingStreak(v => v < boundaries.lower - VOLA_BOUNDARY_HYSTERESIS_PP) : 0;

    const reassignmentCandidate = daysBeyondUpper >= VOLA_BOUNDARY_DRIFT_DAYS
        || daysBeyondLower >= VOLA_BOUNDARY_DRIFT_DAYS;
    const suggestedType = daysBeyondUpper >= VOLA_BOUNDARY_DRIFT_DAYS ? nextTypeUp(pool.poolType)
        : daysBeyondLower >= VOLA_BOUNDARY_DRIFT_DAYS ? nextTypeDown(pool.poolType) : null;

    return {
        poolId: pool.id, currentType: pool.poolType, applicable: true,
        medianVola, sampleDays: dailyVola.length,
        daysBeyondUpper, daysBeyondLower, reassignmentCandidate, suggestedType,
    };
}
