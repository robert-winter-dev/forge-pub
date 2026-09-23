/**
 * FORGE Liquidity – Auflösung von CLEANUP_MODE (LIQ#000929)
 *
 * Gültige Modi seit LIQ#000929:
 *   'disabled'    → kein Invest. Kapital-Abgleich, SOL-Topup und Dust-Sweep laufen
 *                   trotzdem (bin/cleanup.js) — „disabled" heißt nur „kein Invest".
 *   'pool:<id>'   → fester Zielpool (Settings → Cleanup → Manuell)
 *
 * Der frühere Modus 'ranking' („Bester Pool", Invest in den Pool mit dem höchsten
 * InvestScore) ist entfallen. Er war bis dahin der Default, wenn CLEANUP_MODE fehlte.
 * Ein noch gesetztes 'ranking' und jeder unbekannte Wert werden deshalb wie 'disabled'
 * behandelt — nie ein Absturz, nie ein stiller Rückfall auf einen Invest-Pfad.
 * Der neue Default ohne CLEANUP_MODE ist 'disabled'.
 *
 * Eine Quelle für cleanup.js und export.js: zwei Kopien dieser Regel liefen sonst
 * auseinander.
 */

export const CLEANUP_MODE_DEFAULT = 'disabled';

/**
 * @param {string|null|undefined} raw  Wert von CLEANUP_MODE (process.env oder .env)
 * @returns {{ mode: string, legacy: null|'ranking'|'unknown', raw: string }}
 *   `mode` ist immer 'disabled' oder 'pool:<id>'. `legacy` sagt, ob ein veralteter
 *   bzw. unbekannter Wert auf 'disabled' umgedeutet wurde.
 */
export function resolveCleanupMode(raw) {
    const v = String(raw ?? '').trim();
    if (v === '' || v === 'disabled') return { mode: CLEANUP_MODE_DEFAULT, legacy: null, raw: v };
    if (v.startsWith('pool:') && v.length > 'pool:'.length) return { mode: v, legacy: null, raw: v };
    if (v === 'ranking') return { mode: CLEANUP_MODE_DEFAULT, legacy: 'ranking', raw: v };
    return { mode: CLEANUP_MODE_DEFAULT, legacy: 'unknown', raw: v };
}
