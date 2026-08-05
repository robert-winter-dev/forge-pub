/**
 * FORGE Nexus – HTTP Response Cache
 *
 * In-Memory-Cache für idempotente HTTP-GET-Antworten (z.B. GeckoTerminal).
 * TTL wird per Pfad-Pattern bestimmt (siehe pathTtl()).
 *
 * Key   : METHOD + path + sortierter Query-String
 * Value : { status, body, contentType, expiresAt }
 *
 * Stats : hits, misses, hitRatePct, entries, uptimeSec
 */

export class HttpCache {
    /**
     * @param {string}                                 name   Label für Logs / Stats
     * @param {(path: string) => number|null}          ttlFn  Liefert TTL in ms oder null (nicht cachen)
     */
    constructor(name, ttlFn) {
        this.name   = name;
        this._ttlFn = ttlFn;
        this._cache = new Map();
        this._stats = {
            hits:      0,
            misses:    0,
            startedAt: Date.now(),
        };
    }

    _key(method, path, query) {
        const qs = query ? new URLSearchParams(query) : null;
        if (qs) qs.sort();
        return `${method}::${path}${qs ? '?' + qs.toString() : ''}`;
    }

    /**
     * Cache-Lookup. Gibt null bei Miss (auch wenn nicht-cachebar).
     * @param   {string} method
     * @param   {string} path
     * @param   {object} query
     * @returns {{ status: number, body: string, contentType: string }|null}
     */
    get(method, path, query) {
        if (method !== 'GET') return null;
        const ttl = this._ttlFn(path);
        if (ttl === null) return null;

        const key   = this._key(method, path, query);
        const entry = this._cache.get(key);

        if (!entry || Date.now() > entry.expiresAt) {
            if (entry) this._cache.delete(key);
            this._stats.misses++;
            return null;
        }

        this._stats.hits++;
        return { status: entry.status, body: entry.body, contentType: entry.contentType };
    }

    /**
     * Antwort in Cache schreiben. Nur erfolgreiche (2xx) Responses werden gecached.
     * @param {string} method
     * @param {string} path
     * @param {object} query
     * @param {number} status
     * @param {string} body
     * @param {string} contentType
     */
    set(method, path, query, status, body, contentType) {
        if (method !== 'GET')      return;
        if (status < 200 || status >= 300) return;
        const ttl = this._ttlFn(path);
        if (ttl === null) return;

        const key = this._key(method, path, query);
        this._cache.set(key, { status, body, contentType, expiresAt: Date.now() + ttl });
    }

    /**
     * Stale-Lookup: liefert auch abgelaufene Einträge (ohne TTL-Check).
     * Für Stale-While-Error: bei 429/5xx vom Upstream wird der letzte erfolgreiche
     * Wert servierbar – besser als ein harter Fehler an den Caller weiterzureichen.
     * @returns {{ status: number, body: string, contentType: string, ageMs: number }|null}
     */
    getStale(method, path, query) {
        if (method !== 'GET') return null;
        const key   = this._key(method, path, query);
        const entry = this._cache.get(key);
        if (!entry) return null;
        return {
            status:      entry.status,
            body:        entry.body,
            contentType: entry.contentType,
            ageMs:       Date.now() - (entry.expiresAt - this._ttlFn(path)),
        };
    }

    /**
     * Cache-Miss zählen (für Stats; wird auch von get() bei nicht-cachebar nicht gezählt).
     */
    recordMiss() {
        this._stats.misses++;
    }

    evict() {
        const now = Date.now();
        for (const [key, entry] of this._cache) {
            if (now > entry.expiresAt) this._cache.delete(key);
        }
    }

    getStats() {
        const { hits, misses, startedAt } = this._stats;
        const total      = hits + misses;
        const hitRatePct = total > 0 ? +(hits / total * 100).toFixed(1) : 0;
        return {
            name:       this.name,
            entries:    this._cache.size,
            hits,
            misses,
            total,
            hitRatePct,
            uptimeSec:  Math.floor((Date.now() - startedAt) / 1000),
        };
    }
}
