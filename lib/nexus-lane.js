/**
 * FORGE – Hintergrund-Spur für Nexus-Anfragen (LIQ#001114)
 *
 * Daten, die nicht handelsrelevant sind (Stats-Sweep der Pools ohne Kapital, Premium-Daten,
 * Pool-Scanner), fragen die Orca-v2-Schnittstelle über eine eigene, kleinere Spur ab: Der Nexus
 * begrenzt sie auf BACKGROUND_SHARE des Orca-Limits (core/nexus/lane-limit.js), zusätzlich zählen
 * ihre Anfragen gegen das Gesamtlimit. So kann ein langer Sweep den Handel nie aufhalten; dass er
 * dadurch länger braucht, ist unkritisch.
 *
 * Der Aufrufer kennzeichnet sich mit dem Header `x-forge-lane: background`. Ohne Header gilt die
 * normale Spur. Der Header kommt nur von localhost und steuert nur die Drosselung, keine Rechte.
 *
 * ⚠️ Aufrufer der Hintergrund-Spur brauchen ein großzügiges Timeout (BACKGROUND_TIMEOUT_MS):
 * Die Wartezeit im Limiter zählt zur Antwortzeit.
 */

export const LANE_HEADER = 'x-forge-lane';
export const BACKGROUND_LANE = 'background';
export const BACKGROUND_LANE_HEADERS = Object.freeze({ [LANE_HEADER]: BACKGROUND_LANE });
export const BACKGROUND_TIMEOUT_MS = 60_000;

/** @param {unknown} headerValue */
export function isBackgroundLane(headerValue) {
    return headerValue === BACKGROUND_LANE;
}
