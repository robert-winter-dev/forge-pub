/**
 * FORGE API Proxy – RPC Response Cache
 *
 * In-Memory-Cache für idempotente Helius RPC-Antworten.
 * Nur Lesemethoden aus der Whitelist werden gecacht.
 * Mutations (sendTransaction) und Settlement-Polling
 * (getSignatureStatuses) werden niemals gecacht.
 *
 * Cache-Key : method + stabiles JSON der params-Array
 * TTL       : pro Methode konfigurierbar (METHOD_TTL)
 * Stats     : Hits, Upstream-Calls, Hit-Rate, monatliche Hochrechnung
 */

// ─── TTL-Konfiguration (in ms) ────────────────────────────────────────────────

const METHOD_TTL = {
    // Wallet-Balances: Hauptkostenblock – 60 s passend zu 30 s Tick-Interval (MISS/HIT-Muster)
    getBalance:                    60_000,
    getParsedTokenAccountsByOwner: 60_000,
    getTokenAccountsByOwner:       60_000,
    getTokenAccountBalance:        60_000,

    // Account-Daten: 10s – Settlement-Polling alle 5s → jeder 2. Poll aus Cache
    getAccountInfo:                10_000,
    getParsedAccountInfo:          10_000,
    getMultipleAccounts:           10_000,

    // External-Transfer-Check: läuft 1×/Tick (20s) → mit 20s TTL fast immer Cache-Hit
    getSignaturesForAddress:       20_000,

    // Chain-Metadaten: selten relevant für Trading
    getEpochInfo:                  60_000,
    getSlot:                        5_000,
    getBlockHeight:                 5_000,
};

// Methoden die NIEMALS gecacht werden dürfen
const NEVER_CACHE = new Set([
    'sendTransaction',
    'sendRawTransaction',
    'getSignatureStatuses',
    'getSignatureStatus',
    'getTransaction',
    'getConfirmedTransaction',
    'simulateTransaction',
    'requestAirdrop',
]);

// ─── RpcCache ────────────────────────────────────────────────────────────────

export class RpcCache {
    constructor() {
        this._cache = new Map();   // key → { data: string, expiresAt: number }
        this._stats = {
            hits:      0,          // Antworten aus dem Cache (kein Helius-Credit)
            upstream:  0,          // Tatsächliche Helius-Calls (Credit verbraucht)
            startedAt: Date.now(),
        };
    }

    // ── Private ────────────────────────────────────────────────────────────

    _key(method, params) {
        return `${method}::${JSON.stringify(params ?? [])}`;
    }

    // ── Public API ─────────────────────────────────────────────────────────

    /**
     * Gibt TTL für eine Methode zurück, oder null wenn nicht cachebar.
     * @param {string} method
     * @returns {number|null}
     */
    ttlFor(method) {
        if (NEVER_CACHE.has(method)) return null;
        return METHOD_TTL[method] ?? null;
    }

    /**
     * Cached Antwort holen. Gibt null zurück bei Miss oder abgelaufenem Eintrag.
     * Zählt bei Treffer stats.hits hoch.
     *
     * @param   {string}      method
     * @param   {Array|null}  params
     * @returns {string|null} Gecachte rohe JSON-Antwort
     */
    get(method, params) {
        const ttl = this.ttlFor(method);
        if (ttl === null) return null;   // Methode nicht cachebar

        const key   = this._key(method, params);
        const entry = this._cache.get(key);

        if (!entry || Date.now() > entry.expiresAt) {
            this._cache.delete(key);
            return null;
        }

        this._stats.hits++;
        return entry.data;
    }

    /**
     * Antwort in den Cache schreiben.
     * Wird nur für erfolgreiche, fehlerfreie JSON-RPC-Antworten aufgerufen.
     *
     * @param {string}     method
     * @param {Array|null} params
     * @param {string}     data    Rohe JSON-Antwort
     */
    set(method, params, data) {
        const ttl = this.ttlFor(method);
        if (ttl === null) return;

        const key = this._key(method, params);
        this._cache.set(key, { data, expiresAt: Date.now() + ttl });
    }

    /**
     * Zählt einen tatsächlichen Helius-Upstream-Call (= 1 verbrauchter Credit).
     * Muss vor jedem echten fetch() aufgerufen werden.
     */
    recordUpstream() {
        this._stats.upstream++;
    }

    /**
     * Abgelaufene Einträge aus dem Cache entfernen.
     * Sollte periodisch (~1× pro Minute) aufgerufen werden.
     */
    evict() {
        const now = Date.now();
        for (const [key, entry] of this._cache) {
            if (now > entry.expiresAt) this._cache.delete(key);
        }
    }

    /**
     * Statistiken für /cache-stats und /health.
     *
     * projectedMonthly: Hochrechnung auf 30 Tage basierend auf bisheriger Uptime.
     * Erst verlässlich nach einigen Minuten – vorher null.
     *
     * @returns {object}
     */
    getStats() {
        const { hits, upstream, startedAt } = this._stats;
        const total      = hits + upstream;
        const hitRatePct = total > 0 ? +(hits / total * 100).toFixed(1) : 0;

        const uptimeMs = Date.now() - startedAt;
        const monthMs  = 30 * 24 * 60 * 60 * 1000;

        // Hochrechnung erst nach 60 s Uptime sinnvoll
        const projectedMonthly = uptimeMs >= 60_000
            ? Math.round(upstream * (monthMs / uptimeMs))
            : null;

        const FREE_TIER_LIMIT    = 1_000_000;
        const WARNING_THRESHOLD  =   800_000;   // 80 % – 20 % Puffer

        return {
            entries:          this._cache.size,
            hits,
            upstream,
            total,
            hitRatePct,
            projectedMonthly,
            freeTierLimit:    FREE_TIER_LIMIT,
            warningThreshold: WARNING_THRESHOLD,
            overBudget:       projectedMonthly != null && projectedMonthly > FREE_TIER_LIMIT,
            nearBudget:       projectedMonthly != null && projectedMonthly > WARNING_THRESHOLD,
            uptimeSec:        Math.floor(uptimeMs / 1000),
        };
    }
}
