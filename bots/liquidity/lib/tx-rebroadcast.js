/**
 * Senden mit Rebroadcast — dieselbe signierte Transaktion wird wiederholt ausgestrahlt,
 * bis sie bestätigt ist oder ihr Blockhash abläuft.
 *
 * Orcas `TransactionBuilder.buildAndExecute()` sendet genau einmal; verwirft ein Leader die
 * TX, läuft sie als "block height exceeded" ab. Begründung und Messwerte (warum nicht die
 * Priority Fee): KB `Core/orca-tx-rebroadcast.md`, LIQ#000987.
 *
 * Sicher: Rebroadcast sendet exakt dieselben Bytes, also dieselbe Signatur. Eine Signatur
 * kann höchstens einmal landen — Doppelausführung ist ausgeschlossen.
 */

/** Abstand zwischen zwei Rebroadcasts. ~30 Sendungen je Blockhash-Lebensdauer, über rpcLimiter. */
export const REBROADCAST_INTERVAL_MS = 2_000;

/**
 * Sendet eine signierte Transaktion und strahlt sie bis zur Bestätigung erneut aus.
 *
 * Fehlerverhalten wie `buildAndExecute()`: Preflight-Fehler der ersten Sendung werden
 * geworfen, ein On-Chain-Fehler wird als `new Error(JSON.stringify(err))` geworfen, ein
 * abgelaufener Blockhash als `TransactionExpiredBlockheightExceededError` von web3.js.
 *
 * @param {object}   p
 * @param {import('@solana/web3.js').Connection} p.connection
 * @param {Uint8Array|Buffer} p.rawTx             serialisierte, signierte Transaktion
 * @param {{blockhash: string, lastValidBlockHeight: number}} p.blockhash
 * @param {object}   [p.sendOptions]              Optionen der ersten Sendung (Preflight)
 * @param {string}   [p.commitment='confirmed']
 * @param {number}   [p.intervalMs]
 * @param {() => Promise<void>} [p.beforeResend]  Rate-Limiter-Hook vor jeder Wiederholung
 * @returns {Promise<{signature: string, resends: number}>}
 */
export async function sendWithRebroadcast({
    connection, rawTx, blockhash, sendOptions = {}, commitment = 'confirmed',
    intervalMs = REBROADCAST_INTERVAL_MS, beforeResend = async () => {},
}) {
    // maxRetries: 0 — das Wiederholen übernehmen wir, der RPC soll nicht parallel dazu.
    const signature = await connection.sendRawTransaction(rawTx, { ...sendOptions, maxRetries: 0 });

    let done    = false;
    let resends = 0;
    const loop = (async () => {
        while (!done) {
            await new Promise(r => setTimeout(r, intervalMs));
            if (done) break;
            try {
                await beforeResend();
                if (done) break;
                await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
                resends++;
            } catch {
                // Ein gescheiterter Rebroadcast (429, "already processed") ist kein Fehler
                // der Transaktion — über ihren Ausgang entscheidet allein die Bestätigung.
            }
        }
    })();

    try {
        const result = await connection.confirmTransaction({ signature, ...blockhash }, commitment);
        const err = result?.value?.err;
        if (err) {
            let detail;
            try { detail = JSON.stringify(err); } catch { detail = String(err); }
            throw new Error(detail);
        }
        return { signature, resends };
    } finally {
        done = true;
        await loop;
    }
}
