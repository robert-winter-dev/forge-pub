/**
 * FORGE – the one definition of the look-back windows (shared backend ⇄ frontend)
 *
 * Every windowed value of the Liquidity Bot (edge forecast `npWindows`, pool slopes, window PnL,
 * NP quality log, strategy profile, Premium blob order, dashboard labels) uses these three windows:
 * 4 hours, 1 day, 1 week (LIQ#002040). Before that, edge, slopes, export, scorer and Premium each
 * kept their own list (1h/6h/12h/24h/7d) and drifted apart.
 *
 * Ids stay '4h' / '24h' / '7d' (display 4H / 1D / 1W): these ids are already in the Premium blob,
 * in stored history and in the opportunity filter; renaming them would change the blob schema without
 * changing a single value. Not to be confused with the chart ranges in chart-range.js (1D/1W/1M):
 * those are display ranges, not calculation windows.
 *
 * Lives under html/js/ for the same reason as format-price.js: the only tree both Node and the
 * browser can import. Free of Node and browser APIs.
 *
 * Rationale and transition plan: KB "Liquidity Bot/time-windows.md".
 */

const HOUR_MS = 3_600_000;

/** The three windows, shortest first. */
export const TIME_WINDOWS = Object.freeze([
    Object.freeze({ id: '4h',  hours:   4, label: '4H' }),
    Object.freeze({ id: '24h', hours:  24, label: '1D' }),
    Object.freeze({ id: '7d',  hours: 168, label: '1W' }),
]);

export const TIME_WINDOW_IDS = Object.freeze(TIME_WINDOWS.map(w => w.id));

/**
 * Windows still delivered to forks in the Premium blob (edge, slopes) during the transition.
 * Released forks up to 1.0.1 still offer 1h/6h/12h in their opportunity filter. Set
 * DELIVER_LEGACY_WINDOWS to false in the same step as raising config/premium-min-version.json
 * to the first release with this file (KB time-windows.md, "Übergang für Forks").
 */
export const LEGACY_WINDOWS = Object.freeze([
    Object.freeze({ id: '1h',  hours:  1, label: '1H' }),
    Object.freeze({ id: '6h',  hours:  6, label: '6H' }),
    Object.freeze({ id: '12h', hours: 12, label: '12H' }),
]);
export const DELIVER_LEGACY_WINDOWS = true;

/** Windows the master computes for edge and slopes: the three, plus legacy delivery while active. */
export function computedWindows() {
    const list = DELIVER_LEGACY_WINDOWS ? [...TIME_WINDOWS, ...LEGACY_WINDOWS] : [...TIME_WINDOWS];
    return list.sort((a, b) => a.hours - b.hours);
}

export function isTimeWindowId(id) {
    return TIME_WINDOW_IDS.includes(id);
}

/** Window by id (current or legacy), or null. */
export function windowById(id) {
    return TIME_WINDOWS.find(w => w.id === id) ?? LEGACY_WINDOWS.find(w => w.id === id) ?? null;
}

export function windowMs(id) {
    const w = windowById(id);
    return w ? w.hours * HOUR_MS : null;
}

/** Display label; also covers legacy ids and the '1d'/'1w' spelling found in old history rows. */
export function windowLabel(id) {
    if (id === '1d') return '1D';
    if (id === '1w') return '1W';
    return windowById(id)?.label ?? String(id);
}
