/**
 * Kurzlebiger Cache für die allgemeine Loopscale-Vault-Liste (LEN#001352).
 *
 * Jeder Vault (Public, Gen) blätterte die Liste bisher einzeln durch — im selben Tick
 * also doppelt. Hier teilen sich alle Instanzen eine Seite für `ttlMs`; gleichzeitige
 * Abfragen derselben Seite laufen auf denselben Request. Fehler werden nicht gemerkt.
 *
 * Bewusst nur für die Listenseiten, nicht für Filter-Abfragen einzelner Vaults.
 */
export function createPageCache({ ttlMs = 15_000, now = Date.now } = {}) {
    const entries = new Map(); // key → { promise, ts }

    return {
        /** @param {string|number} key  @param {() => Promise<any>} loader */
        get(key, loader) {
            const hit = entries.get(key);
            if (hit && now() - hit.ts < ttlMs) return hit.promise;

            const promise = Promise.resolve().then(loader);
            const entry   = { promise, ts: now() };
            entries.set(key, entry);
            promise.catch(() => {
                if (entries.get(key) === entry) entries.delete(key);
            });
            return promise;
        },
        clear() { entries.clear(); },
    };
}
