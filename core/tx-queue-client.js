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
 * ─── Unbestätigter Ausgang (err.unconfirmed) ─────────────────────────────────
 *
 * Bleibt die Bestätigung aus, wirft diese Funktion weiterhin – ABER der geworfene
 * Fehler trägt dann `err.unconfirmed === true` und `err.signature` (die tatsächlich
 * gesendete Transaktion). Das ist ausdrücklich KEIN "fehlgeschlagen": die Transaktion
 * kann Sekunden später noch bestätigt werden, solange ihr Blockhash gültig ist.
 *
 * Aufrufer, die daraufhin eine ERSATZ-Transaktion bauen würden (Zahlungen, Swaps,
 * alles was Kapital bewegt), MÜSSEN diesen Fall abfangen und erst den Status der
 * vorhandenen Signatur prüfen – sonst wird dieselbe Aktion doppelt ausgeführt.
 * Vorfall forge-pub1 2026-08-12: bis zu sechs echte Zahlungen für dieselbe Stunde,
 * weil jeder Timeout blind als "fehlgeschlagen, neu versuchen" gewertet wurde
 * (siehe core/nexus/tx-queue.js _executeJob und core/premium/premium-pay.js).
 *
 * Aufrufer ohne diese Behandlung verhalten sich unverändert wie bisher – die
 * Zusatzfelder am Fehlerobjekt stören einen reinen `catch (err)` nicht.
 *
 * @param {Buffer|Uint8Array} serializedTx  Serialisierte, signierte Transaktion
 * @param {{ skipPreflight?: boolean }} options
 * @returns {Promise<string>}  Transaktionssignatur
 * @throws {Error} bei Fehler oder Timeout; bei unklarem Ausgang zusätzlich mit
 *                 `unconfirmed: true` und `signature`
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

    // Sobald die Queue die Transaktion abgeschickt hat, liefert sie die Signatur schon
    // im Status 'confirming' mit. Festhalten, damit auch ein Abbruch OHNE sauberes
    // Endergebnis (Ticket abgelaufen, Client-Timeout) dem Aufrufer noch sagen kann,
    // WELCHE Transaktion draußen ist – ohne das bliebe ihm nur ein Blindflug.
    let lastKnownSignature = null;

    /** Fehler mit unklarem – ausdrücklich nicht negativem – Ausgang. */
    const unconfirmedError = (msg, signature) => {
        const err = new Error(msg);
        err.unconfirmed = true;
        err.signature   = signature;
        return err;
    };

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_MS));

        const statusRes = await fetch(`${PROXY_BASE}/tx/status/${ticketId}`);

        if (!statusRes.ok) {
            // 404 = Ticket abgelaufen. Kennen wir bereits eine Signatur, ist der Ausgang
            // offen (die Tx ist draußen), nicht negativ – sonst ein echter Fehler.
            if (statusRes.status === 404) {
                if (lastKnownSignature) {
                    throw unconfirmedError(
                        `tx-queue: Ticket ${ticketId} abgelaufen, bevor der Ausgang feststand – Transaktion ist gesendet, Status offen`,
                        lastKnownSignature,
                    );
                }
                throw new Error(`tx-queue: Ticket ${ticketId} nicht gefunden (abgelaufen)`);
            }
            // Anderer Fehler → weiter pollen
            continue;
        }

        const result = await statusRes.json();
        if (result.signature) lastKnownSignature = result.signature;

        switch (result.status) {
            case 'confirmed':
            case 'finalized':
                return result.signature;

            case 'timeout':
                // Gesendet, aber nicht rechtzeitig bestätigt – kann noch landen.
                throw unconfirmedError(
                    `tx-queue: Transaktion gesendet, aber nicht bestätigt – ${result.error ?? 'Ausgang unbekannt'}`,
                    result.signature ?? lastKnownSignature,
                );

            case 'failed': {
                // Signatur bewusst mitgeben, auch bei einem endgültigen On-Chain-Fehlschlag:
                // ohne sie lässt sich ein unbekannter Custom-Error (z.B. eines Jupiter-Routing-
                // Hops durch ein DEX-Programm, das lib/error-messages.js nicht kennt) im
                // Nachhinein nicht mehr per Solscan/getTransaction aufklären — der Fehlercode
                // allein ist mehrdeutig, weil er je nach durchlaufenem Programm etwas anderes
                // bedeutet (Fund 2026-08-23: PUMP/SOL Auto-Swap, Custom:14 blieb unklärbar,
                // weil keine Signatur im Fehlertext stand).
                const sig = result.signature ?? lastKnownSignature;
                const err = new Error(`tx-queue: Transaction failed – ${result.error ?? 'unknown error'}${sig ? ` (Signatur: ${sig})` : ''}`);
                if (sig) err.signature = sig;
                throw err;
            }

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

    if (lastKnownSignature) {
        throw unconfirmedError(
            `tx-queue: Client timeout after ${CLIENT_TIMEOUT_MS}ms for ticket ${ticketId} – Transaktion ist gesendet, Status offen`,
            lastKnownSignature,
        );
    }
    throw new Error(`tx-queue: Client timeout after ${CLIENT_TIMEOUT_MS}ms for ticket ${ticketId}`);
}
