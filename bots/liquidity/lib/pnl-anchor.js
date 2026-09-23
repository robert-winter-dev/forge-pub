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
 * Vorgänger einer Position, deren Rebalance nach dem Close nicht sofort neu öffnen konnte
 * (LIQ#000803). Scheitert der Pre-Swap oder das Open, bleibt die alte Position geschlossen
 * (Close-TX mit note='rebalance'), und ein späterer Bot-Tick eröffnet regulär neu — ohne
 * `rebalance_history`-Zeile, weil die erst am Ende eines erfolgreichen Rebalancings entsteht.
 * Ohne diese Brücke riss die Kette dort ab und "In/Out" zeigte nur noch die Zeit seit der
 * Neueröffnung (USELESS/SOL, 18.09.2026 21:16 Close → 21:21 Open).
 *
 * Bedingungen (alle zugleich): direkte Vorgängerposition im selben Pool, deren Close-TX
 * ein 'rebalance' war, und nach diesem Close keine zweite Position vor der aktuellen.
 * Ein echter Ausstieg (Withdraw, Trailing Stop) hat eine andere Close-Notiz und trennt weiter.
 *
 * @returns {number|null} positions.id des Vorgängers oder null
 */
function _abortedRebalancePredecessorId(db, positionId, openedAtMs) {
    const cur = db.prepare(`SELECT pool_id FROM positions WHERE id = ?`).get(positionId);
    if (!cur?.pool_id) return null;
    const prev = db.prepare(`
        SELECT id, closed_at FROM positions
         WHERE pool_id = ? AND id != ? AND opened_at < ? AND closed_at IS NOT NULL
         ORDER BY opened_at DESC LIMIT 1
    `).get(cur.pool_id, positionId, openedAtMs);
    if (!prev || !(prev.closed_at > 0) || prev.closed_at > openedAtMs) return null;
    const closeTx = db.prepare(`
        SELECT 1 FROM transactions
         WHERE pool_id = ? AND type = 'close_position' AND note = 'rebalance'
           AND created_at BETWEEN ? AND ?
         LIMIT 1
    `).get(cur.pool_id, prev.closed_at - 120000, prev.closed_at + 120000);
    return closeTx ? prev.id : null;
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
        const prevId = rb?.old_position_id ?? _abortedRebalancePredecessorId(db, curId, curOpenedAt);
        if (!prevId) break;
        const prev = db.prepare(`SELECT id, opened_at FROM positions WHERE id = ?`).get(prevId);
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

/**
 * Anker für die PnL-Extrempunkte — Maximum/Minimum/Aktuell im Reiter „PnL-Details" des
 * Anteil-Modals (LIQ#000612).
 *
 * Bewusst NICHT `resolvePnlAnchorMs()`: Dort gewinnt die letzte externe Einzahlung, und
 * genau das macht Höchst-/Tiefstand direkt nach einem Nachschuss wertlos — das Fenster
 * enthält dann nur noch den aktuellen Punkt, alle drei Spalten zeigen dieselbe Zahl
 * (Befund 13.09.2026, USELESS/SOL nach 200-USDC-Einzahlung: dreimal 17:19 Uhr, dreimal
 * +0,00 %). Ein Nachschuss ist kein Neustart der Kurve; die Kapitalbasis je Kurvenpunkt
 * in `pnlPeakForPeriod()` (lib/pnl.js, seit LIQ#000572) fängt ihn bereits korrekt ab.
 *
 * Zwei Kandidaten, der spätere gewinnt:
 *   1. Beginn der aktuellen Rebalance-Kette (`chainStartOpenedAt()`) — „Eröffnung des Pools"
 *   2. ein manueller „Höchststand zurücksetzen"-Klick (positions.pnl_anchor_reset_at) —
 *      der einzige Vorgang, der die Extrempunkte bewusst neu starten soll
 *
 * @param {number} chainStartMs                          opened_at der ältesten Position der Kette
 * @param {number|null|undefined} pnlAnchorResetAtMs    positions.pnl_anchor_reset_at
 * @returns {number} fromMs für pnlPeakForPeriod() / pnlForPeriod()
 */
export function resolvePnlExtremaAnchorMs(chainStartMs, pnlAnchorResetAtMs) {
    return pnlAnchorResetAtMs > chainStartMs ? pnlAnchorResetAtMs : chainStartMs;
}
