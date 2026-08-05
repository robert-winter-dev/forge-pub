/**
 * FORGE LendingBot – API Rate Limiter
 *
 * ⚠️ ABSOLUTE REGEL: Jeder API-Call MUSS durch diese Routine gehen.
 * Keine Ausnahmen. Rate-Limit-Verletzungen führen zu Account-Bans.
 *
 * Aufruf:
 *   const limiter = new RateLimiter('kamino', 100); // 100 requests pro Minute
 *   await limiter.wait();  // Wartet bei Bedarf
 *   // Jetzt API-Call machen
 */

class RateLimiter {
    /**
     * @param {string} name - Protokoll-Name (z.B. 'kamino', 'jupiter')
     * @param {number} requestsPerMinute - Max requests pro Minute
     * @param {number} bufferPercent - Safety buffer unter Limit (Standard: 20% = 0.8)
     */
    constructor(name, requestsPerMinute, bufferPercent = 0.8) {
        this.name = name;
        this.maxRequests = Math.floor(requestsPerMinute * bufferPercent);
        this.windowMs = 60_000; // 1 Minute
        this.requests = [];
        this.lastWaitTime = 0;

        if (this.maxRequests < 1) {
            throw new Error(`RateLimiter(${name}): maxRequests muss >= 1 sein`);
        }
    }

    /**
     * Wartet, bis der nächste Request erlaubt ist.
     * MUSS vor jedem API-Call aufgerufen werden.
     */
    async wait() {
        const now = Date.now();

        // Alte Requests (älter als 1 Minute) entfernen
        this.requests = this.requests.filter(ts => now - ts < this.windowMs);

        // Wenn wir noch unter dem Limit sind: sofort durchlassen
        if (this.requests.length < this.maxRequests) {
            this.requests.push(now);
            return;
        }

        // Wir haben das Limit erreicht → warten bis ältester Request 1 Min alt ist
        const oldestRequest = this.requests[0];
        const waitMs = this.windowMs - (now - oldestRequest) + 10; // +10ms Puffer

        if (waitMs > 0) {
            // Log nur wenn Wartezeit > 100ms (sonst noise)
            if (waitMs > 100) {
                const waitSec = (waitMs / 1000).toFixed(2);
                console.log(`[RateLimiter] ${this.name}: Rate limit erreicht. Warte ${waitSec}s...`);
            }

            await new Promise(resolve => setTimeout(resolve, waitMs));
        }

        // Nach Warten: cleanup + request eintragen
        const nowAfterWait = Date.now();
        this.requests = this.requests.filter(ts => nowAfterWait - ts < this.windowMs);
        this.requests.push(nowAfterWait);
    }

    /**
     * Gibt aktuelle Zustand aus (für Debugging)
     */
    getStats() {
        const now = Date.now();
        this.requests = this.requests.filter(ts => now - ts < this.windowMs);
        const oldestRequest = this.requests.length > 0 ? this.requests[0] : null;
        const secSinceOldest = oldestRequest ? (now - oldestRequest) / 1000 : null;

        return {
            protocol: this.name,
            maxRequestsPerMin: this.maxRequests,
            currentRequestsInWindow: this.requests.length,
            oldestRequestAgeSec: secSinceOldest,
            isRateLimited: this.requests.length >= this.maxRequests,
        };
    }
}

export { RateLimiter };
