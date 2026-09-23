/**
 * Kontingent-Vorhersage (CORE#000808) – reine Funktionen, keine DB, keine Uhr, kein Env.
 *
 * Frage, die beantwortet wird: Reicht das Monatskontingent bis zum nächsten Reset?
 * Quelle der Zahlen ist die eigene Zählung (data/rpc-stats.db) – eine Hochrechnung,
 * kein Kontostand. Methodik: Core/helius-credit-budget.md, Core/alarmierung-eskalation.md.
 *
 * Alle Daten sind Kalendertage als 'YYYY-MM-DD' in FORGE_TZ (wie rpc_stats.date);
 * gerechnet wird mit UTC-Mitternachtsdaten, damit keine Zeitzonen/DST-Effekte entstehen.
 */

export const WARN_BUFFER_FACTOR = 1.3;   // Reichweite < 130 % der Tage bis Reset → warn

export const QUOTA_RECENT_HOURS   = 6;     // Fenster für den aktuellen Verbrauch (volle Stunden)
export const QUOTA_RECENT_DEVIATE = 0.3;   // ab 30 % Abweichung (beide Richtungen) gilt `recent`

const DAY_MS = 86_400_000;

function parseYmd(s) {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

function fmtYmd(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function daysInMonth(year, month0) {
    return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Reset-Tag (1–31) am Monatsende auf den letzten Tag des Monats klemmen. */
function resetInMonth(year, month0, resetDay) {
    return Date.UTC(year, month0, Math.min(resetDay, daysInMonth(year, month0)));
}

/** Gültigen Reset-Tag (ganze Zahl 1–31) liefern, sonst null (leer/ungültig → unbekannt). */
export function parseResetDay(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
}

/**
 * Letzter und nächster Reset relativ zu `today` (YYYY-MM-DD).
 * Ist heute der Reset-Tag, beginnt der Zyklus heute (last = today), next = im Folgemonat.
 * @returns {{ last: string, next: string, daysUntilNext: number }}
 */
export function cycleBounds(today, resetDay) {
    const t = parseYmd(today);
    const y = new Date(t).getUTCFullYear();
    const m = new Date(t).getUTCMonth();

    const thisMonth = resetInMonth(y, m, resetDay);
    let last, next;
    if (thisMonth <= t) {
        last = thisMonth;
        next = resetInMonth(m === 11 ? y + 1 : y, (m + 1) % 12, resetDay);
    } else {
        next = thisMonth;
        last = resetInMonth(m === 0 ? y - 1 : y, (m + 11) % 12, resetDay);
    }
    return { last: fmtYmd(last), next: fmtYmd(next), daysUntilNext: Math.round((next - t) / DAY_MS) };
}

/**
 * @param {object} p
 * @param {number} p.limit              Monatskontingent
 * @param {number} p.usedInCycle        verbrauchte Credits seit letztem Reset
 * @param {number} p.perDay             Verbrauch pro Tag (siehe pickPerDay)
 * @param {number} p.daysUntilReset     Tage bis zum nächsten Reset
 * @returns {{ severity: 'crit'|'warn'|null, remainingDays: number|null }}
 *   perDay <= 0 → kein Befund (nichts zu prognostizieren, keine Division durch Null).
 */
export function assessQuota({ limit, usedInCycle, perDay, daysUntilReset }) {
    if (!(perDay > 0)) return { severity: null, remainingDays: null };
    const remainingDays = Math.max(0, (limit - usedInCycle) / perDay);
    let severity = null;
    if (remainingDays < daysUntilReset) severity = 'crit';
    else if (remainingDays < daysUntilReset * WARN_BUFFER_FACTOR) severity = 'warn';
    return { severity, remainingDays };
}

/**
 * Verbrauch pro Tag wählen (CORE#000811): Der 7-Tage-Schnitt altert nach einer Gegenmaßnahme
 * eine Woche lang zu langsam und meldet ein behobenes Problem als crit. Deshalb zusätzlich der
 * Verbrauch der letzten QUOTA_RECENT_HOURS vollen Stunden, hochgerechnet auf 24 h. Weicht er um
 * mehr als 30 % vom Schnitt ab – nach oben wie unten –, gilt er; sechs Stunden Abweichung sind
 * keine Schwankung, sondern eine Verhaltensänderung.
 *
 * @param {number|null} baseline     Mittel der letzten vollen Tage (null = keine Vortage)
 * @param {number[]|null} recentHours Credits je voller Stunde, älteste zuerst; null/kürzer als
 *                                   QUOTA_RECENT_HOURS = nicht genug Daten
 * @returns {{ perDay: number|null, source: 'baseline'|'recent'|null }}
 */
export function pickPerDay(baseline, recentHours) {
    const hasBase   = baseline != null && baseline > 0;
    const hasRecent = Array.isArray(recentHours) && recentHours.length >= QUOTA_RECENT_HOURS;
    if (!hasRecent) return { perDay: baseline ?? null, source: baseline == null ? null : 'baseline' };
    const last   = recentHours.slice(-QUOTA_RECENT_HOURS);
    const recent = last.reduce((a, n) => a + n, 0) / QUOTA_RECENT_HOURS * 24;
    if (!hasBase) return { perDay: recent, source: 'recent' };
    return Math.abs(recent - baseline) / baseline > QUOTA_RECENT_DEVIATE
        ? { perDay: recent, source: 'recent' }
        : { perDay: baseline, source: 'baseline' };
}
