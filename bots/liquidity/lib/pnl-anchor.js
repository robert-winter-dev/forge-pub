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
 * Eröffnung der Position, mit der die aktuelle Kette wirtschaftlich begonnen hat —
 * geht über `rebalance_history` (old_position_id/new_position_id) so weit zurück, wie
 * die Kette reicht, und stoppt an der ersten Position, die nicht selbst aus einem
 * Rebalancing entstanden ist (echter Neu-Einstieg oder externe Einzahlung).
 *
 * Grund: Ein Rebalancing schließt die Position technisch, ist aber ein Umzug in eine
 * neue Range, kein Ausstieg (siehe bin/daily-report.js, Abschnitt "Segmentierung des
 * Berichtstags", Befund 30./31.08.2026 — ZEC/USDC verlor dort 17,5 Std. Vorlauf aus dem
 * Bericht, weil an jedem Rebalancing geschnitten wurde). `computeExitPnl()` hatte
 * denselben Fehler in der Exit-Nachricht selbst: sie maß nur seit `position.opened_at`,
 * also seit dem letzten Rebalancing, und verlor damit den Gewinn/Verlust der Kette davor
 * (Befund 01.09.2026, USELESS/SOL: Nachricht −5,31 USDC, Tagesbericht fürs selbe
 * Ereignis +2,44 USDC — beide Zahlen für sich richtig, aber mit unterschiedlichem
 * "seit wann").
 *
 * @param {object} db
 * @param {number} positionId    positions.id der soeben geschlossenen Position
 * @param {number} openedAtMs    positions.opened_at derselben Position (Fallback/Startwert)
 * @returns {number} opened_at der ältesten Position in der Rebalancing-Kette
 */
export function chainStartOpenedAt(db, positionId, openedAtMs) {
    let curId = positionId;
    let curOpenedAt = openedAtMs;
    const seen = new Set();
    for (;;) {
        if (curId == null || seen.has(curId)) break;
        seen.add(curId);
        const rb = db.prepare(
            `SELECT old_position_id FROM rebalance_history WHERE new_position_id = ? LIMIT 1`
        ).get(curId);
        if (!rb?.old_position_id) break;
        const prev = db.prepare(`SELECT id, opened_at FROM positions WHERE id = ?`).get(rb.old_position_id);
        if (!prev) break;
        curId = prev.id;
        curOpenedAt = prev.opened_at;
    }
    return curOpenedAt;
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
