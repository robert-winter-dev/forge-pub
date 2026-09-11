/**
 * FORGE Liquidity – Welche Seite eines Pools ist welche?
 *
 * 🔒 `pool.pair` ist NICHT verlässlich in der Reihenfolge tokenA/tokenB.
 *
 * Bei `usdcIsTokenA`-Pools (NATIX/USDC, EURC/USDC, SPX/USDC) ist **tokenA das USDC**,
 * der Paarname nennt aber den volatilen Token zuerst. Wer `pool.pair.split('/')` nimmt
 * und das Ergebnis auf tokenA/tokenB legt, vertauscht beide Seiten — ohne dass es
 * auffällt, solange nur Symbole in einen Text geschrieben werden.
 *
 * Sichtbar wurde es am 30.08.2026 bei NATIX/USDC: `executeSwapStep()` verkaufte im
 * Standard-Zweig fest `pool.tokenA`, in der Annahme, das sei der volatile Token. Bei
 * diesem Pool ist tokenA das USDC — Jupiter lehnte den Tausch USDC→USDC ab
 * (`CIRCULAR_ARBITRAGE_IS_DISABLED`), das Kapital blieb im Wallet liegen. Es war der
 * erste Trailing-Stop-Exit, den diese Pool-Klasse überhaupt hatte.
 *
 * Deshalb steht die Zuordnung ab jetzt an EINER Stelle und wird über den **Mint**
 * entschieden, nicht über den Paarnamen und nicht über das Config-Flag: der Mint ist
 * die einzige Angabe, die nicht danebenliegen kann.
 */

import { USDC_MINT } from './wallet.js';

/**
 * Seiten eines Pools in der Reihenfolge tokenA/tokenB, mit korrekt zugeordneten Symbolen.
 *
 * @param   {object} pool  braucht pair, tokenA, tokenB, decimalsA, decimalsB
 * @returns {{a: Side, b: Side}}  Side = { mint, decimals, symbol, isUsdc }
 */
export function poolSides(pool) {
    const [sym0, sym1] = String(pool.pair ?? '').split('/');
    const aIsUsdc = pool.tokenA === USDC_MINT;
    const bIsUsdc = pool.tokenB === USDC_MINT;

    // Steht USDC auf einer Seite, ist sein Symbol bekannt — die andere Seite bekommt den
    // Teil des Paarnamens, der nicht "USDC" ist. Bei Paaren ohne USDC (STONK/SOL,
    // cbBTC/WBTC) stimmt die Reihenfolge des Paarnamens mit tokenA/tokenB überein.
    const other = sym0 === 'USDC' ? sym1 : sym0;
    return {
        a: { mint: pool.tokenA, decimals: pool.decimalsA, isUsdc: aIsUsdc,
             symbol: aIsUsdc ? 'USDC' : (sym0 === 'USDC' ? other : sym0) },
        b: { mint: pool.tokenB, decimals: pool.decimalsB, isUsdc: bIsUsdc,
             symbol: bIsUsdc ? 'USDC' : (sym1 === 'USDC' ? other : sym1) },
    };
}

/**
 * Die zu verkaufende Seite eines Standard-Pools (genau ein Token ist USDC) und die
 * Seite, die bereits USDC ist.
 *
 * Liefert `null` für `usdcSide`, wenn keine Seite USDC ist — dann ist es ein
 * volatilePair und der Aufrufer muss beide Seiten verkaufen.
 *
 * @param   {object} pool
 * @returns {{sell: Side, usdcSide: Side|null, sellIsA: boolean}}
 */
export function sellSideOf(pool) {
    const { a, b } = poolSides(pool);
    if (a.isUsdc) return { sell: b, usdcSide: a, sellIsA: false };
    return { sell: a, usdcSide: b.isUsdc ? b : null, sellIsA: true };
}
