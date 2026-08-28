/**
 * FORGE Liquidity – Referenzpreise (Jupiter)
 *
 * Holt SOL/USD und BTC/USD über den Nexus-Proxy und schreibt sie nach `oracle_prices`.
 * Diese Werte sind seit 2026-08-27 **nicht mehr die Bewertungsgrundlage**, sondern erfüllen
 * genau zwei Aufgaben:
 *
 *  1. **Gegenprobe** — `lib/price-sanity.js` vergleicht sie gegen den Pool-Preis und meldet,
 *     wenn die beiden Quellen auseinanderlaufen. Eine unabhängige zweite Meinung ist der
 *     einzige Weg, eine abdriftende Quelle überhaupt zu bemerken.
 *  2. **Rückfallebene** — `getQuotePriceUsd()` greift darauf zurück, wenn der Pool-Preis
 *     fehlt oder älter als 30 Minuten ist (z.B. nachdem der Bot längere Zeit stand).
 *
 * ── Warum Jupiter und nicht mehr Pyth ────────────────────────────────────────────────
 *
 * Ersetzt `lib/pyth-prices.js` (entfernt am 2026-08-27, CORE#0334). Pyth/Hermes verlangt
 * seit dem 26.08. einen API-Key und lieferte davor über acht Stunden lang HTTP 401, ohne
 * dass es auffiel: Der Nexus-Proxy gab bei jedem Fehlschlag den letzten gecachten Preis als
 * *normale* Antwort zurück, dieses Modul schrieb ihn mit frischem Zeitstempel, und die
 * Frischeprüfung in `getQuotePriceUsd()` hatte nichts mehr, woran sie den Ausfall erkennen
 * konnte. Alle X/SOL-Pools wurden in dieser Zeit rund 6 % zu niedrig bewertet.
 *
 * Jupiter hat drei Eigenschaften, die genau diese Fehlerklasse ausschließen:
 *
 *  - **Kein API-Key.** Damit bleibt FORGE.pub ohne Zusatzkonfiguration lauffähig; ein
 *    key-pflichtiger Dienst hätte jede Fork-Installation zur Schlüsselverwaltung gezwungen.
 *  - **Kein Stale-Fallback im Proxy.** `proxyToJupiter()` antwortet bei Störung mit 503
 *    (Circuit Breaker) statt mit einem alten Wert — ein Ausfall bleibt sichtbar.
 *  - **Bereits im Haus.** Route und Rate-Limiter (5/s, 55/min) existieren, der
 *    Wallet-Monitor nutzt denselben Endpunkt. Keine neue externe Abhängigkeit.
 *
 * Genauigkeit war nie das Unterscheidungsmerkmal: Über 6.237 Vergleichspaare lag Pyth im
 * Median 0,003 % neben dem Pool-Preis, Jupiter beim Stichtest 0,05 %. Beide sind gut genug;
 * verlassen tut sich FORGE ohnehin auf den Pool-Preis.
 */

const NEXUS = 'http://localhost:3100';

/**
 * quotePricePoolId → Mint des zu bepreisenden Tokens.
 * Bewusst hier und nicht aus pools.json abgeleitet: Es sind genau die beiden Anker-Token,
 * gegen die volatilePair-Pools bewertet werden, und die Liste soll sich nicht still ändern,
 * wenn jemand einen Pool umkonfiguriert.
 */
const POOL_TO_MINT = {
    'liq-sol-usdc': 'So11111111111111111111111111111111111111112',
    'liq-btc-usdc': 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
};

/**
 * Mindestabstand zwischen zwei echten Abrufen.
 *
 * 🔒 Nötig, weil `runFastStopRound()` diese Funktion bei **jeder** Schnellprüfung aufruft —
 * gemessen rund 1,7 Runden pro Minute. Für Pyth war das folgenlos (der Nexus cachte 30 s),
 * für Jupiter gibt es keinen solchen Cache, jeder Aufruf ginge upstream. 60 Sekunden halten
 * die Werte frisch genug für Gegenprobe und Rückfallebene und begrenzen die Last auf
 * höchstens einen Call pro Minute und Host.
 *
 * ⚠️ Zur Einordnung: Die drei FORGE-Hosts teilen sich eine externe IP, ihre Rate-Limiter
 * kennen einander aber nicht. Was hier gespart wird, zählt dreifach.
 */
const MIN_REFRESH_INTERVAL_MS = 60_000;

let _lastAttempt = 0;

/**
 * Holt die Referenzpreise und schreibt sie nach `oracle_prices`.
 * Wirft nie — ein Fehlschlag wird geloggt, der Bot läuft weiter (die Bewertung hängt
 * ohnehin am Pool-Preis).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{force?: boolean}} [opts]  `force` umgeht die Drosselung (für Tests/Diagnose).
 */
export async function refreshReferencePrices(db, { force = false } = {}) {
    const now = Date.now();
    if (!force && now - _lastAttempt < MIN_REFRESH_INTERVAL_MS) return;
    // Auch bei Fehlschlag hochsetzen: sonst löst jede Schnellprüfungsrunde einen neuen
    // Versuch aus und ein anhaltender Upstream-Fehler wird zum Dauerfeuer.
    _lastAttempt = now;

    const mints = [...new Set(Object.values(POOL_TO_MINT))];
    let data;
    try {
        const res = await fetch(`${NEXUS}/jup/price/v3?ids=${mints.join(',')}`, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
    } catch (err) {
        console.warn(`[refprice] Referenzpreis-Abruf fehlgeschlagen: ${err.message}`);
        return;
    }

    const upsert = db.prepare(`
        INSERT INTO oracle_prices (quote_pool_id, price, source, updated_at)
        VALUES (?, ?, 'jupiter', ?)
        ON CONFLICT(quote_pool_id) DO UPDATE SET
            price      = excluded.price,
            source     = excluded.source,
            updated_at = excluded.updated_at
    `);

    let written = 0;
    for (const [poolId, mint] of Object.entries(POOL_TO_MINT)) {
        const price = data?.[mint]?.usdPrice;
        // 🔒 Nur schreiben, was tatsächlich als Zahl ankam. Ein fehlendes Feld darf niemals
        // dazu führen, dass der vorherige Wert mit neuem Zeitstempel stehen bleibt — genau
        // diese Verwechslung von „frisch geschrieben" und „frisch gemessen" war die Ursache
        // des Pyth-Vorfalls.
        if (typeof price === 'number' && price > 0) {
            upsert.run(poolId, price, now);
            written++;
        }
    }
    if (written === 0) {
        console.warn('[refprice] Antwort enthielt keinen verwertbaren Preis – oracle_prices unverändert gelassen.');
    }
}

/** Nur für Tests: setzt die Drosselung zurück. */
export function _resetRefreshThrottle() {
    _lastAttempt = 0;
}
