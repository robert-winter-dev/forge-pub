/**
 * Kontingent-Zustand Helius (CORE#000808 lokale Messung, CORE#000810 Health-Share).
 *
 * Eine Quelle für zwei Verbraucher: die Advisor-Regel L8 (bin/health-advisor.js) und
 * der Report-Aggregator (lib/health-report.js, virtueller Dienst `quota-helius`).
 * Rechenlogik selbst: lib/quota-forecast.js (rein). Hier nur I/O: rpc-stats.db (readonly)
 * und Konfiguration (Prozess-Env, ersatzweise core/nexus/.env).
 *
 * 🔒 Der Report trägt NUR den Zustandscode, nie Verbrauchs- oder Limitzahlen
 * (Feld-Allowlist der Systemdaten-Freigabe).
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { PATHS } from '../config/paths.js';
import { FORGE_TZ } from '../core/config.js';
import { cycleBounds, assessQuota, parseResetDay, pickPerDay, QUOTA_RECENT_HOURS } from './quota-forecast.js';

export const QUOTA_SERVICE_ID = 'quota-helius';
export const QUOTA_DEFAULT_LIMIT = 1_000_000;   // Free Tier; überschreibbar via HELIUS_QUOTA_LIMIT
export const QUOTA_AVG_DAYS = 7;                // Basis: Mittel der letzten 7 vollen Tage (Auswahl: pickPerDay)
export const QUOTA_SUSPECT_MIN = 5;             // Verdacht (429 nach Retries ohne „max usage") erst ab so vielen im Fenster

const DAY_MS = 86_400_000;

// Beobachtete Erschöpfung: Der Nexus zählt jedes Kontingent-429 in den Stundenzählern
// quota_denied/quota_suspect (core/nexus/rpc-stats.js). Das ist ein harter Beleg, braucht
// keinen Reset-Tag und geht jeder Hochrechnung vor. Nach dem Reset
// kommen keine neuen 429 mehr; das Fenster lässt den Zustand dann von selbst auslaufen.
export const QUOTA_DENIED_WINDOW_MIN = 60;      // Fenster für beobachtete 429 (CORE#000811; vorher 2 h)
export const QUOTA_OBSERVED_WINDOW_MS = QUOTA_DENIED_WINDOW_MIN * 60_000;

/** Konfigurationswert: Prozess-Env, ersatzweise core/nexus/.env (Cron lädt sie nicht). */
export function quotaEnv(name) {
    if (process.env[name] != null && process.env[name] !== '') return process.env[name];
    try {
        const envPath = new URL('../core/nexus/.env', import.meta.url);
        for (const line of readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
            if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
        }
    } catch { /* keine .env – Default greift */ }
    return undefined;
}

/**
 * Zustandscode aus der Bewertung (rein).
 *   exhausted: Kontingent des Zyklus aufgebraucht (used >= limit)
 *   near:      reicht laut Hochrechnung nicht oder nur knapp bis zum Reset
 *   ok:        reicht
 */
export function quotaCode({ limit, used, severity }) {
    if (used >= limit) return 'quota_exhausted';
    return severity ? 'quota_near' : 'quota_ok';
}

/** Zustandscode → Statuszähler-Spalte (ok/warn/crit/unknown). */
export const QUOTA_CODE_STATUS = {
    quota_ok: 'ok', quota_near: 'warn', quota_exhausted: 'crit', quota_unknown: 'unknown',
};

/** Spalten quota_denied/quota_suspect fehlen in DBs, die der Nexus noch nicht migriert hat. */
function hasQuotaColumns(rdb) {
    const cols = new Set(rdb.prepare(`PRAGMA table_info(rpc_stats)`).all().map(c => c.name));
    return cols.has('quota_denied') && cols.has('quota_suspect');
}

/**
 * Beobachtete Kontingent-429 im Fenster aus den Stundenzählern (rein lesend). Fehlende Spalten
 * (Nexus noch nicht migriert) → 0, nie werfen. `lastMs` = letzter Flush, der eine Zeile mit
 * Treffern berührt hat – grobe, aber konservative Näherung an „im Fenster beobachtet".
 */
function readObserved(rdb, nowMs) {
    if (!hasQuotaColumns(rdb)) return { denied: 0, suspect: 0, lastMs: null };
    const winRaw = Number(quotaEnv('QUOTA_DENIED_WINDOW_MIN'));
    const windowMs = Number.isFinite(winRaw) && winRaw > 0 ? winRaw * 60_000 : QUOTA_OBSERVED_WINDOW_MS;
    const row = rdb.prepare(
        `SELECT COALESCE(SUM(quota_denied), 0) AS denied, COALESCE(SUM(quota_suspect), 0) AS suspect,
                MAX(flushed_at) AS lastMs
           FROM rpc_stats WHERE flushed_at >= ? AND (quota_denied > 0 OR quota_suspect > 0)`,
    ).get(nowMs - windowMs);
    return { denied: row.denied, suspect: row.suspect, lastMs: row.lastMs };
}

/**
 * Credits der letzten QUOTA_RECENT_HOURS VOLLEN Stunden (FORGE_TZ, älteste zuerst) oder null,
 * wenn die DB nicht so weit zurückreicht (Neuinstallation: dann gilt der Tagesschnitt).
 */
function readRecentHours(rdb, nowMs) {
    const fmtD = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ });
    const fmtH = new Intl.DateTimeFormat('en-US', { timeZone: FORGE_TZ, hour12: false, hour: '2-digit' });
    const slots = [];
    for (let k = QUOTA_RECENT_HOURS; k >= 1; k--) {
        const d = new Date(nowMs - k * 3_600_000);
        slots.push({ date: fmtD.format(d), hour: Number(fmtH.format(d)) % 24 });
    }
    const key = (date, hour) => `${date} ${String(hour).padStart(2, '0')}`;
    const oldest = key(slots[0].date, slots[0].hour);
    const first = rdb.prepare(`SELECT MIN(date || ' ' || printf('%02d', hour)) AS k FROM rpc_stats`).get().k;
    if (first == null || first > oldest) return null;
    const get = rdb.prepare(`SELECT COALESCE(SUM(misses + fresh), 0) AS n FROM rpc_stats WHERE date = ? AND hour = ?`);
    return slots.map(s => get.get(s.date, s.hour).n);
}

/**
 * Liest den aktuellen Zustand. Nie werfen: jede Unklarheit ist `unknown`, nie `ok`.
 * Vorrang (CORE#000811):
 *   1. Kontingent-429 im Fenster BEOBACHTET (Zähler) → quota_exhausted, ohne Reset-Tag und Hochrechnung
 *   2. sonst Reset-Tag + Hochrechnung → quota_near / quota_ok
 *   3. weder noch → quota_unknown
 * @param {Date|number} now
 * @param {{ dbPath?: string }} [opts]  dbPath nur für Tests
 * @returns {{ code: string, observed?: boolean, lastExhaustedMs?: number, severity?: 'crit'|'warn'|null, resetDay: number|null,
 *             denied?: number, suspect?: number, perDaySource?: 'baseline'|'recent',
 *             limit?: number, used?: number, perDay?: number, remainingDays?: number|null,
 *             last?: string, next?: string, daysUntilNext?: number, today: string }}
 */
export function readQuotaState(now = new Date(), { dbPath = PATHS.rpcStatsDb } = {}) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);   // der Advisor übergibt Millisekunden
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ }).format(nowMs);   // YYYY-MM-DD wie rpc_stats.date
    const resetDay = parseResetDay(quotaEnv('HELIUS_QUOTA_RESET_DAY'));
    const unknown = { code: 'quota_unknown', resetDay, today };
    if (!existsSync(dbPath)) return unknown;

    let rdb;
    try {
        rdb = new Database(dbPath, { readonly: true, fileMustExist: true });   // fremde DB: nur lesen

        // 1. Beobachtung schlägt Hochrechnung: Stundenzähler quota_denied (Body „max usage
        //    reached") und quota_suspect (CORE#000811, CORE#000813). Der Verdacht (429 nach Retries ohne den Text) fängt einen
        //    geänderten Wortlaut ab, braucht aber mehrere Treffer: er könnte auch ein echtes
        //    Rate-Limit sein.
        const { denied, suspect, lastMs } = readObserved(rdb, nowMs);
        if (denied > 0 || suspect >= QUOTA_SUSPECT_MIN) {
            const lastExhaustedMs = lastMs ?? 0;
            return { ...unknown, code: 'quota_exhausted', observed: true, severity: 'crit',
                     lastExhaustedMs, denied, suspect };
        }

        if (resetDay == null) return unknown;
        const limitRaw = Number(quotaEnv('HELIUS_QUOTA_LIMIT'));
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : QUOTA_DEFAULT_LIMIT;

        const { last, next, daysUntilNext } = cycleBounds(today, resetDay);
        const used = rdb.prepare(
            `SELECT COALESCE(SUM(misses + fresh), 0) AS n FROM rpc_stats WHERE date >= ?`,
        ).get(last).n;

        // Letzte 7 VOLLE Tage (heute ist unvollständig und würde den Schnitt drücken).
        const from = new Date(Date.parse(`${today}T00:00:00Z`) - QUOTA_AVG_DAYS * DAY_MS).toISOString().slice(0, 10);
        const perDayRows = rdb.prepare(
            `SELECT date, SUM(misses + fresh) AS n FROM rpc_stats WHERE date >= ? AND date < ? GROUP BY date`,
        ).all(from, today);
        const baseline = perDayRows.length === 0 ? null : perDayRows.reduce((a, r) => a + r.n, 0) / perDayRows.length;

        // Schnitt oder aktueller Verbrauch der letzten Stunden – je nachdem, welcher gilt.
        const { perDay, source: perDaySource } = pickPerDay(baseline, readRecentHours(rdb, nowMs));
        // Keine Grundlage für eine Hochrechnung: nur ein bereits erschöpftes Limit ist sicher.
        if (perDay == null) {
            return used >= limit
                ? { ...unknown, code: 'quota_exhausted', severity: 'crit', limit, used, last, next, daysUntilNext }
                : unknown;
        }

        const { severity, remainingDays } = assessQuota({ limit, usedInCycle: used, perDay, daysUntilReset: daysUntilNext });
        return { code: quotaCode({ limit, used, severity }), severity, resetDay, limit, used, perDay,
                 perDaySource, remainingDays, last, next, daysUntilNext, today };
    } catch (err) {
        console.warn(`[quota-state] rpc-stats.db nicht lesbar (${err.message}) – Zustand unbekannt`);
        return unknown;
    } finally {
        rdb?.close();
    }
}
