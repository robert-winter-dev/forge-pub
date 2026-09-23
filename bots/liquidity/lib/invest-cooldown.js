/**
 * FORGE Liquidity – Invest-Cooldowns (lib/invest-cooldown.js)
 *
 * Nach jeder kapitalfreigebenden Auslösung (Trailing Stop, TVL-Schutz)
 * ist ein Pool für `cooldownHours` vom Invest ausgeschlossen: in einen Pool, den ein
 * Schutzmechanismus gerade geräumt hat, soll „Bester Pool" nicht im selben Atemzug
 * wieder einzahlen.
 *
 * Diese Datei ist die EINZIGE Quelle dieser Berechnung. bin/cleanup.js filtert damit
 * seine Rangliste, bin/export.js schreibt daraus `pool.investCooldowns` ins Dashboard.
 * Beides muss dasselbe sagen — sonst zeigt die Oberfläche einen Pool als investierbar,
 * den der Cleanup still überspringt (genau der Fall vom 2026-08-23: ZBCN/SOL gewann mit
 * 74 Punkten, obwohl Fartcoin/SOL und TRUMP/SOL mit 81/80 gelistet waren — beide lagen
 * im Trailing-Stop-Cooldown, sichtbar war das nirgends).
 *
 * Cooldown-Ausschlüsse landen bewusst NICHT in `cleanup_decisions.excluded`: dort stehen
 * die vom Invest-Guard verworfenen Kandidaten (TVL-/Max-Investment-Regel), der Cooldown greift
 * eine Stufe davor.
 */

import {
    getLastTsExecutionAt, getLastTvlExecutionAt,
} from './db.js';
import { loadTsConfig }                    from './trailing-stop.js';
import { loadTvlConfig }                   from './tvl-protection.js';

/** Fällt ein Pool ohne (gültige) cooldownHours-Angabe an, gilt diese Untergrenze.
 *  6 h seit 2026-09-03 (LIQ#0359) — gleicher Wert wie der Trailing-Stop-Default in
 *  lib/pool-settings-defaults.js; der TVL-Schutz (12 h) trägt seinen
 *  Wert in jeder Pool-Zeile explizit, dieser Fallback greift nur bei fehlendem Feld. */
const DEFAULT_COOLDOWN_HOURS = 6;

/**
 * `key` ist maschinenlesbar und geht ins Dashboard (die Oberfläche ist zweisprachig und
 * formuliert den Satz selbst), `reason` ist der deutsche Text für die Cleanup-Logs.
 */
const SOURCES = [
    { key: 'trailingStop',  reason: 'Trailing Stop', settingsKey: 'trailingStop',  lastAt: getLastTsExecutionAt,          loadCfg: loadTsConfig },
    { key: 'tvlProtection', reason: 'TVL-Schutz',    settingsKey: 'tvlProtection', lastAt: getLastTvlExecutionAt,         loadCfg: loadTvlConfig },
];

/**
 * Alle aktiven Cooldowns eines Pools, längster zuerst.
 *
 * @param {import('better-sqlite3').Database} db  Bot-DB (lesend)
 * @param {string} poolId
 * @param {object} [opts]
 * @param {object|null} [opts.settings]  bereits geladener pool_settings-Eintrag; ohne
 *        Angabe wird je Quelle einzeln aus settings.db gelesen. export.js hat die
 *        Settings ohnehin schon im Speicher — das spart zwei DB-Öffnungen je Pool.
 * @param {number} [opts.now]
 * @returns {Array<{key:string, reason:string, untilMs:number}>}
 */
export function poolInvestCooldowns(db, poolId, { settings = null, now = Date.now() } = {}) {
    const active = [];
    for (const src of SOURCES) {
        const lastAt = src.lastAt(db, poolId);
        if (!lastAt) continue;
        const cfg   = settings ? (settings[src.settingsKey] ?? null) : src.loadCfg(poolId);
        const hours = Number(cfg?.cooldownHours);
        const cooldownHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_COOLDOWN_HOURS;
        const untilMs = lastAt + cooldownHours * 3_600_000;
        if (now >= untilMs) continue;
        active.push({ key: src.key, reason: src.reason, untilMs });
    }
    return active.sort((a, b) => b.untilMs - a.untilMs);
}

/**
 * Cooldown-gesperrte Pools als Map poolId → { until, reason } (der jeweils längste
 * Cooldown, so wie bin/cleanup.js ihn zum Filtern und Loggen braucht).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} poolIds
 * @param {object} [opts]  wie bei poolInvestCooldowns(); `settingsById` optional als Map.
 * @returns {Map<string, {until:number, reason:string}>}
 */
export function investCooldownBlockedPools(db, poolIds, { settingsById = null, now = Date.now() } = {}) {
    const blocked = new Map();
    for (const poolId of poolIds) {
        const [longest] = poolInvestCooldowns(db, poolId, { settings: settingsById?.[poolId] ?? null, now });
        if (longest) blocked.set(poolId, { until: longest.untilMs, reason: longest.reason });
    }
    return blocked;
}
