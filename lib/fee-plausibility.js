/**
 * FORGE – Plausibilitätsregel für Pending Fees (eine Quelle für alle Prüfer)
 *
 * Pending Fees können nur durch Handel wachsen. Ein Sprung, der auf's Jahr gerechnet eine
 * absurde Fee-APR ergibt, ist kein Ertrag, sondern ein Lesefehler.
 *
 * ── Woher der Lesefehler kommt ───────────────────────────────────────────────
 * `collectFeesQuote()` (Orca) rechnet `feeGrowthInside` aus drei Accounts: `feeGrowthGlobal`
 * (Whirlpool), `feeGrowthCheckpoint` (Position) und `feeGrowthOutside` (die beiden
 * Tick-Arrays). `feeGrowthOutside` eines Ticks kippt, sobald der Preis diesen Tick kreuzt.
 * Stammen die Accounts aus verschiedenen Slots und liegt ein Cross dazwischen, liefert der
 * Quote Phantom-Fees in der Größenordnung des Positionswerts.
 *
 * Vorfall TRUMP/SOL, 2026-08-22 19:29:06: 283,57 USDC „Pending Fees" auf 254,46 USDC
 * Positionswert, on-chain tatsächlich 0,000026 SOL. Weil `lib/pnl.js` die Wertreihe als
 * `lp_value_usd + fees_pending_usd` bildet, zeigte das Dashboard +114 % PnL.
 *
 * Der slot-konsistente Read in `bots/liquidity/lib/pool-adapter/orca.js` ist die
 * Wurzelursachen-Korrektur. Diese Regel ist das Netz darunter.
 *
 * 🔒 **Eine Regel, ein Ort.** Die Regel wird an zwei Stellen gebraucht — beim Schreiben
 * (`writePositionSnapshotFromState`) und rückwirkend (Migration
 * `0005-phantom-fee-snapshots`). Zwei Kopien würden auseinanderlaufen, und dann korrigiert
 * die Migration Werte, die der Guard durchgelassen hätte, oder umgekehrt. Selbe Begründung
 * wie bei `lib/pnl.js`.
 */

/**
 * Obergrenze der implizierten Fee-APR. Weit über allem, was real vorkommt (der schnellste
 * beobachtete Pool stand bei 823 % APR, Faktor ~60 Luft) und weit unter dem Vorfall
 * (11,4 Mio. % p.a., Faktor ~230).
 */
export const MAX_FEE_APR_PCT = 50_000;

/**
 * Kleinere Sprünge werden nie beanstandet — sonst schlägt Mess-Rauschen bei eng
 * aufeinanderfolgenden Snapshots an (Claim + Reinvest schreiben binnen Sekunden).
 */
export const MIN_FEE_JUMP_USD = 1;

/**
 * Untergrenze für die Annualisierung: zwei Snapshots Sekunden auseinander würden jeden
 * Delta-Wert sonst ins Absurde hochrechnen.
 */
export const MIN_FEE_ELAPSED_MS = 5 * 60 * 1000;

/**
 * Prüft einen Pending-Fee-Wert gegen seinen Vorgänger.
 *
 * Rückgänge (Claim, Neueröffnung) sind nie ein Plausibilitätsproblem — geprüft wird
 * ausschließlich der Sprung nach oben.
 *
 * @param {Object} p
 * @param {number} p.feesUsd      neuer Pending-Fee-Wert in USDC
 * @param {number} p.prevFeesUsd  Pending-Fee-Wert des Vorgänger-Snapshots
 * @param {number} p.lpValueUsd   Positionswert des neuen Snapshots (Bezugsgröße der APR)
 * @param {number} p.elapsedMs    Abstand zum Vorgänger-Snapshot
 * @returns {{ implausible: boolean, impliedAprPct: number|null, deltaUsd: number }}
 */
export function checkFeeJump({ feesUsd, prevFeesUsd, lpValueUsd, elapsedMs }) {
    const delta = (feesUsd ?? 0) - (prevFeesUsd ?? 0);
    if (!(lpValueUsd > 0) || delta <= 0 || delta < MIN_FEE_JUMP_USD) {
        return { implausible: false, impliedAprPct: null, deltaUsd: delta };
    }
    const ms            = Math.max(MIN_FEE_ELAPSED_MS, elapsedMs ?? 0);
    const impliedAprPct = (delta / lpValueUsd) * (365 * 86_400_000 / ms) * 100;
    return { implausible: impliedAprPct > MAX_FEE_APR_PCT, impliedAprPct, deltaUsd: delta };
}
