/**
 * FORGE Liquidity – Pyth Oracle Preis-Refresh
 *
 * Holt SOL/USD- und BTC/USD-Preise vom Pyth/Hermes-Feed via Nexus-Proxy
 * und schreibt sie in die oracle_prices-Tabelle.
 *
 * Wird einmal pro Bot-Zyklus in mainLoop() aufgerufen.
 * getQuotePriceUsd() liest oracle_prices bevorzugt (Fallback: pool_stats).
 *
 * quotePricePoolId → Pyth-Symbol-Mapping:
 *   liq-sol-usdc → sol   (SOL/USD)
 *   liq-btc-usdc → btc   (BTC/USD)
 */

const NEXUS = 'http://localhost:3100';

// Maps quotePricePoolId → Pyth-Symbol für den /pyth/price-Endpoint
const POOL_TO_SYMBOL = {
    'liq-sol-usdc': 'sol',
    'liq-btc-usdc': 'btc',
};

/**
 * Holt aktuelle Pyth-Preise und schreibt sie in oracle_prices.
 * Wirft keine Exception — Fehler werden geloggt, Bot läuft weiter.
 *
 * @param {import('better-sqlite3').Database} db
 */
export async function refreshPythPrices(db) {
    const symbols = [...new Set(Object.values(POOL_TO_SYMBOL))].join(',');
    let prices;
    try {
        const res = await fetch(`${NEXUS}/pyth/price?ids=${symbols}`, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        prices = await res.json();
    } catch (err) {
        console.warn(`[pyth] Preis-Refresh fehlgeschlagen: ${err.message}`);
        return;
    }

    const upsert = db.prepare(`
        INSERT INTO oracle_prices (quote_pool_id, price, source, updated_at)
        VALUES (?, ?, 'pyth', ?)
        ON CONFLICT(quote_pool_id) DO UPDATE SET
            price      = excluded.price,
            source     = excluded.source,
            updated_at = excluded.updated_at
    `);

    const now = Date.now();
    for (const [poolId, sym] of Object.entries(POOL_TO_SYMBOL)) {
        const price = prices[sym];
        if (typeof price === 'number' && price > 0) {
            upsert.run(poolId, price, now);
        }
    }
}
