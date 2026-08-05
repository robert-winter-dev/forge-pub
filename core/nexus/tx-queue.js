/**
 * FORGE Transaction Queue – FIFO-Verarbeitung für Solana-Transaktionen.
 *
 * Alle Bots reichen signierte Transaktionen über den API-Proxy ein.
 * Die Queue verarbeitet sie strikt sequenziell (FIFO), damit:
 *   1. Nie mehr als ein sendTransaction + confirmTransaction gleichzeitig läuft
 *   2. Jeder RPC-Call einzeln durch den heliusLimiter geht
 *   3. @solana/web3.js mit seinen internen Retries NICHT benutzt wird
 *
 * Architektur (Variante A – Raw Transaction):
 *   - Bot signiert die Tx lokal
 *   - Bot sendet serialisierte Tx (base64) an POST /tx/submit
 *   - Queue macht sendTransaction + getSignatureStatuses via raw JSON-RPC
 *   - Bot pollt GET /tx/status/:ticketId
 *
 * Erweiterbar auf Variante B (Order-Level) durch Änderung des Job-Interfaces,
 * ohne dass die Queue-Mechanik selbst angepasst werden muss.
 *
 * WICHTIG: Kein import von @solana/web3.js – alle RPC-Calls sind raw fetch()
 * über den heliusLimiter, um die internen Retries von web3.js zu umgehen.
 */

// ─── Konfiguration ───────────────────────────────────────────────────────────

const TX_CONFIRM_TIMEOUT_MS  = 60_000;   // Max. Wartezeit auf Confirmation
const TX_CONFIRM_POLL_MS     = 2_000;    // Poll-Intervall für getSignatureStatuses
const RESULT_TTL_MS          = 5 * 60_000; // Ergebnisse 5 Min vorhalten, dann aufräumen
const CLEANUP_INTERVAL_MS    = 60_000;    // Aufräum-Intervall

// ─── TxQueue Klasse ──────────────────────────────────────────────────────────

export class TxQueue {
    /**
     * @param {string}     heliusRpcUrl   Vollständige Helius-RPC-URL (mit API-Key)
     * @param {import('./rate-limiter.js').RateLimiter} rateLimiter  heliusLimiter-Instanz
     */
    constructor(heliusRpcUrl, rateLimiter) {
        this.heliusRpcUrl = heliusRpcUrl;
        this.rateLimiter  = rateLimiter;

        /** @type {Map<string, { status: string, signature?: string, error?: string, submittedAt: number, completedAt?: number }>} */
        this.results = new Map();

        /** @type {Array<{ ticketId: string, serializedTx: string, skipPreflight: boolean }>} */
        this.queue = [];

        this.processing = false;
        this.ticketCounter = 0;

        // Periodisches Aufräumen abgelaufener Ergebnisse
        this.cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
    }

    /**
     * Neue Transaktion einreihen.
     *
     * @param {string}  serializedTx   Base64-kodierte, signierte Transaktion
     * @param {boolean} skipPreflight  Preflight überspringen (default: false)
     * @returns {string} ticketId      Eindeutige Ticket-ID zum Abfragen des Status
     */
    submit(serializedTx, skipPreflight = false) {
        const ticketId = `tx-${Date.now()}-${++this.ticketCounter}`;

        this.results.set(ticketId, {
            status:      'queued',
            submittedAt: Date.now(),
            position:    this.queue.length,
        });

        this.queue.push({ ticketId, serializedTx, skipPreflight });

        console.log(`[tx-queue] QUEUED    – ticket=${ticketId} | queue=${this.queue.length}`);

        // Verarbeitung anstoßen (idempotent – läuft nur einmal gleichzeitig)
        this._processNext();

        return ticketId;
    }

    /**
     * Status eines Tickets abfragen.
     *
     * @param {string} ticketId
     * @returns {{ status: string, signature?: string, error?: string, submittedAt: number, completedAt?: number } | null}
     */
    getStatus(ticketId) {
        return this.results.get(ticketId) ?? null;
    }

    /**
     * Queue-Statistiken für /health.
     */
    getStats() {
        return {
            queueLength:    this.queue.length,
            processing:     this.processing,
            totalTracked:   this.results.size,
        };
    }

    // ─── Interne Verarbeitung ─────────────────────────────────────────────────

    async _processNext() {
        if (this.processing) return;   // Bereits aktiv → nichts tun
        if (this.queue.length === 0) return;

        this.processing = true;

        while (this.queue.length > 0) {
            const job = this.queue.shift();
            await this._executeJob(job);
        }

        this.processing = false;
    }

    async _executeJob({ ticketId, serializedTx, skipPreflight }) {
        const result = this.results.get(ticketId);
        if (!result) return;

        result.status = 'sending';

        try {
            // ── Schritt 1: sendTransaction (raw JSON-RPC) ────────────────────
            const signature = await this._sendTransaction(serializedTx, skipPreflight);
            result.signature = signature;
            result.status    = 'confirming';

            console.log(`[tx-queue] SENT     – ticket=${ticketId} | sig=${signature.slice(0, 12)}...`);

            // ── Schritt 2: confirmTransaction (poll getSignatureStatuses) ─────
            await this._confirmTransaction(signature);

            result.status      = 'confirmed';
            result.completedAt = Date.now();
            const durationMs   = result.completedAt - result.submittedAt;

            console.log(`[tx-queue] CONFIRMED – ticket=${ticketId} | sig=${signature.slice(0, 12)}... | ${durationMs}ms`);

        } catch (err) {
            result.status      = 'failed';
            result.error       = err.message;
            result.completedAt = Date.now();

            console.error(`[tx-queue] FAILED   – ticket=${ticketId} | ${err.message}`);
        }
    }

    /**
     * Sendet eine signierte Transaktion via raw JSON-RPC sendTransaction.
     * Jeder Call geht durch den heliusLimiter.
     *
     * @param {string}  serializedTx  Base64-kodierte Transaktion
     * @param {boolean} skipPreflight
     * @returns {Promise<string>}     Transaktionssignatur
     */
    async _sendTransaction(serializedTx, skipPreflight) {
        await this.rateLimiter.wait();

        const body = {
            jsonrpc: '2.0',
            id:      1,
            method:  'sendTransaction',
            params:  [
                serializedTx,
                {
                    encoding:            'base64',
                    skipPreflight:       skipPreflight,
                    preflightCommitment: 'confirmed',
                },
            ],
        };

        const res = await fetch(this.heliusRpcUrl, {
            method:  'POST',
            headers: { 'content-type': 'application/json' },
            body:    JSON.stringify(body),
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`sendTransaction HTTP ${res.status}: ${text.slice(0, 200)}`);
        }

        const data = await res.json();

        if (data.error) {
            const msg = data.error.message ?? JSON.stringify(data.error);
            throw new Error(`sendTransaction RPC error: ${msg}`);
        }

        return data.result; // Signatur
    }

    /**
     * Wartet auf Confirmation via Polling von getSignatureStatuses.
     * Jeder Poll-Call geht durch den heliusLimiter.
     *
     * @param {string} signature
     * @returns {Promise<void>}
     * @throws {Error} bei Timeout oder Transaction-Fehler
     */
    async _confirmTransaction(signature) {
        const deadline = Date.now() + TX_CONFIRM_TIMEOUT_MS;

        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, TX_CONFIRM_POLL_MS));

            await this.rateLimiter.wait();

            const body = {
                jsonrpc: '2.0',
                id:      1,
                method:  'getSignatureStatuses',
                params:  [[signature], { searchTransactionHistory: false }],
            };

            const res = await fetch(this.heliusRpcUrl, {
                method:  'POST',
                headers: { 'content-type': 'application/json' },
                body:    JSON.stringify(body),
            });

            if (!res.ok) {
                // RPC vorübergehend nicht erreichbar → weiter pollen
                console.warn(`[tx-queue] getSignatureStatuses HTTP ${res.status} – retry...`);
                continue;
            }

            const data = await res.json();

            if (data.error) {
                console.warn(`[tx-queue] getSignatureStatuses RPC error: ${data.error.message ?? 'unknown'} – retry...`);
                continue;
            }

            const status = data.result?.value?.[0];

            if (!status) continue; // Noch nicht bekannt → weiter pollen

            if (status.err) {
                throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
            }

            // confirmationStatus: 'processed' | 'confirmed' | 'finalized'
            if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                return; // Erfolgreich bestätigt
            }

            // 'processed' → noch nicht confirmed, weiter pollen
        }

        throw new Error(`Transaction confirmation timeout after ${TX_CONFIRM_TIMEOUT_MS}ms`);
    }

    /**
     * Räumt abgelaufene Ergebnisse auf.
     */
    _cleanup() {
        const now = Date.now();
        let removed = 0;

        for (const [ticketId, result] of this.results) {
            // Nur abgeschlossene (confirmed/failed) Ergebnisse aufräumen
            if (result.completedAt && (now - result.completedAt) > RESULT_TTL_MS) {
                this.results.delete(ticketId);
                removed++;
            }
        }

        if (removed > 0) {
            console.log(`[tx-queue] CLEANUP  – ${removed} abgelaufene Ergebnisse entfernt | verbleibend: ${this.results.size}`);
        }
    }

    /**
     * Queue herunterfahren (für graceful shutdown).
     */
    destroy() {
        clearInterval(this.cleanupTimer);
    }
}
