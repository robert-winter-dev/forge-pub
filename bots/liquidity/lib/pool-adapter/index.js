/**
 * FORGE Liquidity – Pool-Adapter Interface + Factory
 *
 * Der Bot-Core kennt kein Protokoll direkt — er ruft ausschließlich dieses
 * Interface auf. Orca und Raydium sind austauschbare Implementierungen.
 *
 * Interface (alle Methoden müssen implementiert werden):
 *
 *   getPoolStats(pool)
 *     → { price, tvlUsd, volume24hUsd, apr24h }
 *     Ruft aktuelle Pool-Statistiken ab (Preis, TVL, Volumen, APR).
 *
 *   getPositionState(pool, positionNftMint)
 *     → { inRange, tickLower, tickUpper, priceLower, priceUpper,
 *          liquidity, feesOwedA, feesOwedB }
 *     Liest den aktuellen On-Chain-Zustand einer offenen Position.
 *
 *   openPosition(pool, tickLower, tickUpper, amountA, amountB)
 *     → { nftMint, liquidity, txHash }
 *     Öffnet eine neue LP-Position im angegebenen Tick-Bereich.
 *
 *   closePosition(pool, positionNftMint)
 *     → { amountA, amountB, feesA, feesB, txHash }
 *     Schließt eine Position und holt alle Liquidität + Fees zurück.
 *
 *   collectFees(pool, positionNftMint)
 *     → { amountA, amountB, txHash }
 *     Claimt aufgelaufene Fees ohne die Position zu schließen.
 *
 *   increaseLiquidity(pool, positionNftMint, amountA, amountB)
 *     → { liquidity, txHash }
 *     Fügt bestehender Position zusätzliche Liquidität hinzu (für Reinvest).
 *
 *   decreaseLiquidity(pool, positionNftMint, usdcAmount, slippage)
 *     → { tokenEstA, tokenEstB, fraction, txHash }
 *     Entnimmt einen Teil der Liquidität (usdcAmount-Äquivalent), Position bleibt offen.
 */

import { OrcaAdapter } from './orca.js';

/**
 * Gibt den passenden Adapter für ein Pool-Konfigurationsobjekt zurück.
 *
 * @param {Object} pool   Pool-Objekt aus config/pools.json
 * @returns {OrcaAdapter} (oder in Zukunft RaydiumAdapter)
 */
export function getAdapter(pool) {
    switch (pool.protocol) {
        case 'orca':
            return new OrcaAdapter();
        default:
            throw new Error(`Unbekanntes Protokoll: "${pool.protocol}" (Pool: ${pool.id})`);
    }
}
