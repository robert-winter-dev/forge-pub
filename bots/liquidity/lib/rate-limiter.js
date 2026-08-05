/**
 * FORGE Liquidity – Rate Limiter
 *
 * Sliding-Window Token-Bucket: wartet automatisch BEVOR das API-Limit erreicht wird.
 * Muss VOR jedem externen API-Call aufgerufen werden.
 *
 * Regel: immer min. 20% unter dem dokumentierten Limit bleiben.
 *
 * Vordefinierte Limiter für alle externen APIs:
 *   orcaLimiter    – Orca Whirlpools API  (80% von 100 req/10s = 80 req/10s)
 *   rpcLimiter     – Solana RPC Proxy      (80% von 10 req/s   = 8 req/s)
 *   telegramLimiter– Telegram Bot API      (80% von 30 msg/s   = 24 req/s)
 *   geckoLimiter   – GeckoTerminal via Proxy (kein dok. Limit → konservativ 24 req/min)
 *
 * Nutzung:
 *   import { orcaLimiter } from './rate-limiter.js';
 *   await orcaLimiter.wait();
 *   const data = await fetch(...);
 */

export class RateLimiter {
    /**
     * @param {number} maxRequests  Max. Requests im Zeitfenster (bereits mit 20%-Puffer)
     * @param {number} windowMs     Zeitfenster in Millisekunden
     * @param {string} name         Name für Log-Ausgaben
     */
    constructor(maxRequests, windowMs, name = 'unknown') {
        this.maxRequests = maxRequests;
        this.windowMs    = windowMs;
        this.name        = name;
        this.timestamps  = [];  // FIFO: älteste Requests vorne
    }

    /**
     * Wartet falls nötig, damit das Kontingent nicht überschritten wird.
     * Muss VOR jedem API-Call aufgerufen werden.
     */
    async wait() {
        const now = Date.now();

        // Requests außerhalb des Fensters entfernen
        this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

        // Limit erreicht → warten bis ältester Request aus dem Fenster fällt
        if (this.timestamps.length >= this.maxRequests) {
            const oldest = this.timestamps[0];
            const waitMs = this.windowMs - (now - oldest) + 50; // +50ms Puffer
            if (waitMs > 0) {
                console.warn(
                    `[RateLimit:${this.name}] Limit (${this.maxRequests}/${this.windowMs}ms) erreicht,` +
                    ` warte ${waitMs}ms...`
                );
                await new Promise(r => setTimeout(r, waitMs));
            }
        }

        this.timestamps.push(Date.now());
    }

    /** Zeigt aktuelle Auslastung (für Debugging). */
    getLoad() {
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
        return {
            active:      this.timestamps.length,
            max:         this.maxRequests,
            utilization: `${((this.timestamps.length / this.maxRequests) * 100).toFixed(1)}%`,
        };
    }
}

// ─── Vordefinierte Limiter ────────────────────────────────────────────────────

// Orca Whirlpools API: 100 req/10s dokumentiert → 80% = 80 req/10s
export const orcaLimiter = new RateLimiter(80, 10_000, 'orca');

// Solana RPC (via FORGE Proxy localhost:3100): 10 req/s → 80% = 8 req/s
export const rpcLimiter = new RateLimiter(8, 1_000, 'rpc');

// Telegram Bot API: 30 msg/s → 80% = 24 msg/s
export const telegramLimiter = new RateLimiter(24, 1_000, 'telegram');

// GeckoTerminal (via FORGE Proxy localhost:3100): kein dok. Limit → 24 req/min (konservativ)
export const geckoLimiter = new RateLimiter(24, 60_000, 'gecko');
