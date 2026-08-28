/**
 * FORGE Liquidity – gemeinsamer PnL-Anker für "Anteil"/PnL-seit-Einstieg.
 *
 * Beide Anzeigen ("Anteil"-Tooltip in export.js, PnL-Zeile einer Exit-Nachricht in
 * exit-finalizer.js) beantworten dieselbe Frage — "seit wann läuft die PnL-Uhr für diese
 * Position?" — und müssen deshalb denselben Zeitpunkt verwenden. Diese Funktion ist die
 * einzige Stelle, die daraus einen `fromMs` für `pnlForPeriod()` macht.
 *
 * Drei Kandidaten, der späteste gewinnt:
 *   1. der letzte ECHTE externe Kapitalfluss (capital_flows, is_external=1, usdc_amount>0)
 *      seit Eröffnung der aktuellen Position — eine tatsächliche Ein-/Auszahlung
 *   2. ein manueller "Höchststand zurücksetzen"-Klick (positions.pnl_anchor_reset_at)
 *   3. Eröffnungszeitpunkt der Position (Fallback, wenn nichts davon existiert)
 *
 * 🔒 Ein Cleanup-Reinvest (is_external=0) verschiebt den Anker nie — sonst würde jede
 * automatische Reinvestition eigenen Kapitals fälschlich wie ein Neustart der PnL-Kurve
 * aussehen. Dieselbe Regel gilt für jede andere interne HWM-Fortschreibung: nur der
 * bewusste, protokollierte Klick zählt.
 */

/**
 * @param {number|null|undefined} lastExternalDepositMs  letzter externer Kapitalfluss
 *   (aus capital_flows, usdc_amount>0 AND is_external=1, seit opened_at) oder null
 * @param {number|null|undefined} pnlAnchorResetAtMs      positions.pnl_anchor_reset_at
 * @param {number} openedAtMs                             positions.opened_at (Fallback)
 * @returns {number} fromMs für pnlForPeriod()
 */
export function resolvePnlAnchorMs(lastExternalDepositMs, pnlAnchorResetAtMs, openedAtMs) {
    const candidates = [lastExternalDepositMs, pnlAnchorResetAtMs].filter(t => t > 0);
    return candidates.length ? Math.max(...candidates) : openedAtMs;
}

/**
 * Welcher der drei Kandidaten aus `resolvePnlAnchorMs()` den Anker tatsächlich gesetzt hat —
 * für die Anzeige. Bis 2026-08-22 beschriftete das UI den Anker immer als „letzte Einzahlung",
 * auch wenn er von einem Reset ohne jeden Kapitalfluss stammte (Fund forge-pub1, SOL/cbBTC
 * Position 78: `pnl_anchor_reset_at` 10:44:34 ohne begleitenden Eintrag in `capital_flows`,
 * das Dashboard suggerierte trotzdem eine Einzahlung/Neueröffnung zu diesem Zeitpunkt).
 *
 * @returns {'deposit'|'reset'|'opened'}
 */
export function resolvePnlAnchorSource(lastExternalDepositMs, pnlAnchorResetAtMs, openedAtMs) {
    const dep = lastExternalDepositMs > 0 ? lastExternalDepositMs : -Infinity;
    const rst = pnlAnchorResetAtMs > 0   ? pnlAnchorResetAtMs   : -Infinity;
    if (dep === -Infinity && rst === -Infinity) return 'opened';
    return rst > dep ? 'reset' : 'deposit';
}
