/**
 * FORGE Nexus – Limit der Hintergrund-Spur (LIQ#001114)
 *
 * Reine Rechnung, damit testbar. Die Hintergrund-Spur bekommt einen Anteil des Gesamtlimits einer
 * API. Damit die Anzahl ganzzahlig bleibt, wird das Zeitfenster bei Bedarf vervielfacht
 * (Orca v2: 30 je 10 s × 15 % = 4,5 je 10 s → 9 je 20 s, gleiche Rate).
 *
 * Warum 15 %: Der Sweep der Pools ohne Kapital braucht eine Anfrage je Pool und soll nach der
 * Hälfte des 10-Min-Takts fertig sein. Bei 0,45 Anfragen/s sind das 73 Pools in 2,7 Min, 150 Pools in
 * 5,6 Min. Unter 10 % wird der Sweep bei wachsendem Katalog (der Scanner hat keine Obergrenze)
 * schnell zu langsam, ab 20 % nimmt die Spur dem Handel mehr weg, als sie braucht.
 */

export const BACKGROUND_SHARE = 0.15;

/**
 * @param {{ maxRequests: number, windowMs: number }} limit  Gesamtlimit der API
 * @param {number} [share]  Anteil der Hintergrund-Spur (0 < share < 1)
 * @returns {{ maxRequests: number, windowMs: number }}
 */
export function backgroundLimit(limit, share = BACKGROUND_SHARE) {
    for (let k = 1; k <= 10; k++) {
        const n = limit.maxRequests * share * k;
        if (n >= 1 && Math.abs(n - Math.round(n)) < 1e-9) {
            return { maxRequests: Math.round(n), windowMs: limit.windowMs * k };
        }
    }
    return { maxRequests: Math.max(1, Math.floor(limit.maxRequests * share)), windowMs: limit.windowMs };
}
