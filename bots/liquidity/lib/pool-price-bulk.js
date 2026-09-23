/**
 * FORGE Liquidity – gebündelte Preis-Lesung (LIQ#000854)
 *
 * Liest die Whirlpool-Konten vieler Pools in Blöcken zu 100 über EINE
 * getMultipleAccounts-Abfrage statt je Pool über einen SDK-getPool()-Aufruf
 * (der neben dem Whirlpool weitere Konten nachlädt: gemessen ~4,8 Credits je Pool).
 *
 * Reine Ablauflogik ohne SDK-/RPC-Import, damit sie ohne Netz testbar ist
 * (lib/pool-price-bulk.test.js). Der Orca-Adapter reicht Abruf, Parser und
 * Preisformel hinein.
 *
 * 🔒 Ein Pool, dessen Konto fehlt oder nicht dekodierbar ist, fehlt in der
 * Ergebnis-Map. Kein geschätzter, kein geerbter Wert.
 */

/** Maximale Kontenzahl je getMultipleAccounts-Aufruf. */
export const ACCOUNTS_PER_CALL = 100;

/**
 * @param {Array<{address: string}>} pools
 * @param {Object}   deps
 * @param {(addresses: string[]) => Promise<Array<any|null>>} deps.fetchAccounts
 *        Kontodaten in derselben Reihenfolge wie die Adressen (null = Konto fehlt)
 * @param {(address: string, info: any) => (Object|null)} deps.decode
 *        Whirlpool-Parser; null bei nicht dekodierbarem Konto
 * @param {(data: Object, pool: Object) => {price: number, tickCurrentIndex: number}} deps.toPrice
 * @param {() => Promise<void>} [deps.wait]   Rate-Limiter, vor jedem Aufruf
 * @param {(msg: string) => void} [deps.warn]
 * @returns {Promise<Map<string, {price: number, tickCurrentIndex: number}>>}
 */
export async function readPricesBulk(pools, { fetchAccounts, decode, toPrice, wait, warn = () => {} }) {
    const result = new Map();

    // Je Adresse ein Pool (doppelte Einträge würden nur Konten doppelt lesen)
    const byAddress = new Map();
    for (const pool of pools) if (!byAddress.has(pool.address)) byAddress.set(pool.address, pool);
    const addresses = [...byAddress.keys()];

    for (let off = 0; off < addresses.length; off += ACCOUNTS_PER_CALL) {
        const chunk = addresses.slice(off, off + ACCOUNTS_PER_CALL);
        let infos;
        try {
            if (wait) await wait();
            infos = await fetchAccounts(chunk);
        } catch (err) {
            // Block-Ausfall betrifft nur seine Pools; sie fehlen in der Map und werden übersprungen.
            warn(`[orca:price-bulk] Block ${off / ACCOUNTS_PER_CALL + 1} fehlgeschlagen (${chunk.length} Pools): ${err.message}`);
            continue;
        }
        for (let i = 0; i < chunk.length; i++) {
            const address = chunk[i];
            let value = null;
            try {
                const data = infos?.[i] ? decode(address, infos[i]) : null;
                if (data) value = toPrice(data, byAddress.get(address));
            } catch (err) {
                warn(`[orca:price-bulk] ${address.slice(0, 8)}... nicht dekodierbar: ${err.message}`);
            }
            if (value && Number.isFinite(value.price)) result.set(address, value);
        }
    }
    return result;
}
