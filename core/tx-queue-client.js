/**
 * FORGE Transaction Queue – Client-Bibliothek für Bots.
 *
 * Statt direkt `connection.sendRawTransaction()` + `connection.confirmTransaction()`
 * aufzurufen (was @solana/web3.js mit internen Retries nutzt und 429s verursacht),
 * reicht der Bot die signierte Transaktion über den API-Proxy ein.
 *
 * Die Queue im Proxy verarbeitet alle Transaktionen sequenziell (FIFO) und nutzt
 * ausschließlich raw JSON-RPC Calls mit dem zentralen heliusLimiter.
 *
 * Usage:
 *   import { submitAndConfirm } from '../../core/tx-queue-client.js';
 *
 *   // Statt:
 *   //   const sig = await connection.sendRawTransaction(tx.serialize(), opts);
 *   //   await connection.confirmTransaction(sig, 'confirmed');
 *
 *   // Jetzt:
 *   const sig = await submitAndConfirm(tx.serialize());
 *
 * Ablauf:
 *   1. POST /tx/submit → { ticketId }
 *   2. Poll GET /tx/status/:ticketId alle 1.5s
 *   3. Return Signatur wenn confirmed, throw bei Fehler/Timeout
 *
 * Konfiguration über Umgebungsvariablen:
 *   TX_QUEUE_URL  – Base-URL des Proxy (default: http://127.0.0.1:3100)
 */

const PROXY_BASE    = process.env.TX_QUEUE_URL ?? 'http://127.0.0.1:3100';
const POLL_MS       = 1_500;     // Poll-Intervall
const CLIENT_TIMEOUT_MS = 90_000; // Client-seitiger Timeout (> Queue-Timeout von 60s)

/**
 * Reicht eine signierte Transaktion über die zentrale FIFO-Queue ein
 * und wartet auf Confirmation.
 *
 * @param {Buffer|Uint8Array} serializedTx  Serialisierte, signierte Transaktion
 * @param {{ skipPreflight?: boolean }} options
 * @returns {Promise<string>}  Transaktionssignatur
 * @throws {Error} bei Fehler oder Timeout
 */
export async function submitAndConfirm(serializedTx, { skipPreflight = false } = {}) {
    // Buffer/Uint8Array → Base64
    const base64Tx = Buffer.from(serializedTx).toString('base64');

    // ── Schritt 1: Tx einreihen ──────────────────────────────────────────────
    const submitRes = await fetch(`${PROXY_BASE}/tx/submit`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ serializedTx: base64Tx, skipPreflight }),
    });

    if (!submitRes.ok) {
        const text = await submitRes.text();
        throw new Error(`tx-queue submit failed: HTTP ${submitRes.status} – ${text}`);
    }

    const { ticketId } = await submitRes.json();

    // ── Schritt 2: Status pollen ─────────────────────────────────────────────
    const deadline = Date.now() + CLIENT_TIMEOUT_MS;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_MS));

        const statusRes = await fetch(`${PROXY_BASE}/tx/status/${ticketId}`);

        if (!statusRes.ok) {
            // 404 = Ticket abgelaufen → Fehler
            if (statusRes.status === 404) {
                throw new Error(`tx-queue: Ticket ${ticketId} nicht gefunden (abgelaufen)`);
            }
            // Anderer Fehler → weiter pollen
            continue;
        }

        const result = await statusRes.json();

        switch (result.status) {
            case 'confirmed':
            case 'finalized':
                return result.signature;

            case 'failed':
                throw new Error(`tx-queue: Transaction failed – ${result.error ?? 'unknown error'}`);

            case 'queued':
            case 'sending':
            case 'confirming':
                // Noch nicht fertig → weiter pollen
                break;

            default:
                // Unbekannter Status → weiter pollen
                break;
        }
    }

    throw new Error(`tx-queue: Client timeout after ${CLIENT_TIMEOUT_MS}ms for ticket ${ticketId}`);
}
