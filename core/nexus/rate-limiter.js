/**
 * FORGE API Proxy – Zentraler Rate Limiter
 *
 * Sliding-Window-Implementierung. Wartet automatisch wenn das Kontingent
 * erschöpft ist, statt Requests abzulehnen.
 *
 * Da dieser Prozess alle API-Anfragen aller Bots serialisiert,
 * funktioniert das Sliding Window korrekt auch bei gleichzeitigen Requests
 * (Node.js ist single-threaded – Awaits serialisieren automatisch).
 */

export class RateLimiter {
    /**
     * @param {string} name         API-Name (für Logs)
     * @param {number} maxRequests  Maximale Requests pro Zeitfenster
     * @param {number} windowMs     Zeitfenster in ms (default: 60000 = 1 Minute)
     */
    constructor(name, maxRequests, windowMs = 60_000) {
        this.name        = name;
        this.maxRequests = maxRequests;
        this.windowMs    = windowMs;
        this.timestamps  = [];
    }

    /**
     * Wartet bis ein Slot frei ist, registriert dann den Request.
     * Muss VOR jedem proxied API-Call aufgerufen werden.
     *
     * @returns {number} Tatsächlich gewartet in ms (0 = kein Throttling)
     */
    async wait(accumulatedMs = 0) {
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

        if (this.timestamps.length >= this.maxRequests) {
            const waitMs = this.windowMs - (now - this.timestamps[0]) + 10;
            if (waitMs > 0) {
                await new Promise(r => setTimeout(r, waitMs));
                return this.wait(accumulatedMs + waitMs); // nach Warten erneut prüfen
            }
        }

        this.timestamps.push(Date.now());
        return accumulatedMs;
    }

    /**
     * Füllt den Timestamp-Buffer künstlich, sodass nachfolgende Requests
     * für ca. durationMs gebremst werden (z.B. nach einem 429 vom Upstream).
     * @param {number} durationMs  Wie lange blockieren (in ms)
     */
    penalize(durationMs) {
        const until = Date.now() + durationMs;
        this.timestamps = Array(this.maxRequests).fill(until);
    }

    /** Aktuellen Zustand für /health-Endpoint */
    getStats() {
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
        return {
            api:              this.name,
            requestsInWindow: this.timestamps.length,
            maxInWindow:      this.maxRequests,
            windowSec:        this.windowMs / 1000,
            limited:          this.timestamps.length >= this.maxRequests,
        };
    }
}
