/**
 * FORGE Liquidity – Strategie-Versatz für die automatischen/manuellen Invest-Pfade
 * außerhalb von bin/bot.js (LIQ#0377).
 *
 * bin/bot.js wendet applyRangeStepOffset() auf die rohe Advisor-Empfehlung an
 * (_applyStrategyRangeOffset(), LIQ#0371) — dort gibt es bei jedem Öffnen/Rebalancing
 * einen frischen Advisor-Aufruf, dessen `rangePct` als Bezugspunkt dient.
 *
 * cleanup.js (Erstinvest über das Ranking), deposit-lib.js (openVolatilePairPosition)
 * und deposit.js (--new) konsultieren den Advisor dagegen NICHT — sie rufen
 * calculateRange() direkt mit `rangeOverride.fixedPct` bzw. dem globalen ATR-Modus auf.
 * Ein Advisor-Aufruf in diesen Pfaden würde die Range schon bei aktiver Strategie
 * "Standard" ändern (der Advisor liefert i.d.R. eine andere Zahl als die zuletzt per
 * Hysterese synchronisierte fixedPct) — das verletzt die geforderte Byte-Identität bei
 * "Standard" und hängt dem automatischen Haupt-Invest-Pfad eine neue Fehlerquelle
 * (Advisor-Timeout) an. Siehe KB Strategien/strategie-auswahl.md, Abschnitt
 * "Wie eine Strategie die Range ausdrückt".
 *
 * Der Versatz wirkt hier deshalb auf den Rohwert, den diese Pfade ohnehin schon
 * berechnen (`calculateRange()`s neues Feld `rangePct`) — kein zweiter, abweichender
 * Bezugspunkt, keine zusätzliche ATR-Berechnung (die bleibt einzig in range.js).
 */

import { getStrategy, rangeStepOffsetForPool } from '../../../lib/strategies.js';
import { applyRangeStepOffset } from './range-advisor.js';
import { calculateRange } from './range.js';

/**
 * @param {string|null} strategyId      aktive Strategie-ID oder null ("Standard")
 * @param {Object} pool                 Pool-Konfiguration (poolType, rangeOverride, volatilePair)
 * @param {number} currentPrice
 * @param {Database} db
 * @param {{rangePct:number}} computedRange  bereits berechnetes calculateRange()-Ergebnis
 *   (derselbe Aufruf, den der jeweilige Pfad heute schon macht)
 * @returns {Object|null} neues calculateRange()-Ergebnis mit verschobener Range, oder
 *   `null` wenn nichts zu tun ist (kein Versatz, Pool außerhalb des Geltungsbereichs,
 *   oder `rangeOverride.locked` — dann fällt der Aufrufer auf `computedRange` zurück,
 *   exakt wie `_getAdvisedRange()` in bot.js es für den Advisor-Pfad tut).
 */
export function applyStrategyOffsetToComputedRange(strategyId, pool, currentPrice, db, computedRange) {
    // Gleicher Skip wie in bot.js._getAdvisedRange(): eine manuell fest konfigurierte
    // Range darf der Versatz ebenso wenig anfassen wie der Advisor selbst.
    if (pool.rangeOverride?.locked === true) return null;
    if (strategyId == null) return null; // "Standard" — keine Wirkung

    const strategy = getStrategy(strategyId);
    const offset   = rangeStepOffsetForPool(strategy, pool);
    if (!offset) return null; // Pool außerhalb des Geltungsbereichs oder Versatz 0

    const rawPct = computedRange?.rangePct;
    if (!Number.isFinite(rawPct)) return null; // defensiv, sollte calculateRange() nie liefern

    const shiftedPct = applyRangeStepOffset(pool, rawPct, offset);
    if (shiftedPct === rawPct) return null; // an der Pool-Typ-Grenze bereits geclampt

    return calculateRange(pool, currentPrice, { mode: 'fixed', fixedPct: shiftedPct }, db);
}
