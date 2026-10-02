/**
 * FORGE Liquidity – Einordnung eines noch gesetzten CLEANUP_MODE (LIQ#000929, LIQ#000937)
 *
 * Der Cleanup hat keinen Invest-Modus mehr:
 *   'ranking'    („Bester Pool", Invest in den Pool mit dem höchsten Score) entfiel mit
 *                LIQ#000929,
 *   'pool:<id>'  (fester Zielpool, Settings → Cleanup → Manuell) entfiel mit LIQ#000937.
 * Kapital-Abgleich, SOL-Topup und Dust-Sweep laufen weiter (bin/cleanup.js). Neues Kapital
 * kommt nur über „Einzahlen“, der Bot eröffnet nur noch wieder (Rebalance).
 *
 * CLEANUP_MODE steuert deshalb nichts mehr. Diese Funktion sagt nur, was in der .env
 * steht, damit bin/cleanup.js einen Altwert einmal meldet und entfernt — nie ein Absturz,
 * nie ein Rückfall auf einen Invest-Pfad. Migration 0014 räumt den Schlüssel beim Update
 * bereits weg; das hier ist das Netz für Installationen, die ihn danach von Hand setzen.
 */

/**
 * @param {string|null|undefined} raw  Wert von CLEANUP_MODE (process.env oder .env)
 * @returns {{ legacy: null|'disabled'|'ranking'|'pool'|'unknown', raw: string, poolId: string|null }}
 *   `legacy` ist null, wenn nichts gesetzt ist. 'disabled' ist ein harmloser Altwert
 *   (ohne Hinweis zu entfernen), die übrigen waren einmal ein Invest-Modus oder ein
 *   Tippfehler.
 */
export function resolveCleanupMode(raw) {
    const v = String(raw ?? '').trim();
    if (v === '') return { legacy: null, raw: v, poolId: null };
    if (v === 'disabled') return { legacy: 'disabled', raw: v, poolId: null };
    if (v === 'ranking') return { legacy: 'ranking', raw: v, poolId: null };
    if (v.startsWith('pool:') && v.length > 'pool:'.length) {
        return { legacy: 'pool', raw: v, poolId: v.slice('pool:'.length) };
    }
    return { legacy: 'unknown', raw: v, poolId: null };
}
