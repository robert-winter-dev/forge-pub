/**
 * FORGE – Preisformatierung mit signifikanten Stellen (geteilt Backend ⇄ Frontend)
 *
 * Warum dieses Modul existiert
 * ────────────────────────────
 * Poolpreise sind tokenB-pro-tokenA und überstreichen dadurch viele Größenordnungen:
 * cbBTC/USDC steht bei ~71 800, PUMP/SOL bei ~25 700, cbBTC/SOL bei ~0,0012. Eine feste
 * Nachkommastellenzahl kann das nicht abbilden. Vor dem 20.08.2026 rundete der Bot mit
 * `toFixed(2)` und das Dashboard mit einem eigenen `fmtPrice(v, 2)` — beide zeigten für
 * cbBTC/SOL „0.00 – 0.00", während die Datenbank 0.00119386 bzw. 0.00126870 hielt.
 *
 * 🔒 Deshalb liegt die Regel an EINER Stelle. Backend (Meldungstexte) und Frontend
 * (Range-Chart) haben denselben Fehler unabhängig voneinander gemacht — genau das
 * Auseinanderlaufen, das eine geteilte Datei verhindert.
 *
 * Warum unter html/js/ und nicht unter lib/
 * ─────────────────────────────────────────
 * Es ist das einzige Verzeichnis, das beide Welten erreicht: Node importiert es über den
 * Dateipfad, der Browser bekommt es über den ausgelieferten html/-Baum (bin/sync.sh
 * überträgt ausschließlich html/). Ein Modul unter lib/ wäre im Dashboard nicht ladbar,
 * ohne es zusätzlich dorthin zu kopieren — Mechanik, die stillschweigend auseinanderlaufen
 * kann. Das Modul ist bewusst frei von Node- und Browser-APIs, damit es in beiden läuft.
 *
 * Zwei getrennte Aufgaben — nicht verwechseln
 * ───────────────────────────────────────────
 *   roundPrice()  – TRANSPORT: wie viel Präzision landet im Dashboard-JSON?
 *   formatPrice() – ANZEIGE:   wie viele Stellen sieht der Mensch?
 *
 * Der Transport braucht mehr Stellen als die Anzeige. Wird dort zu früh gerundet, kann die
 * beste Anzeigeregel nichts mehr retten: `round4` machte aus der cbBTC/SOL-Range
 * 0.00119386–0.00126870 die Werte 0.0012–0.0013, und `priceNow` fiel exakt auf
 * `priceLower` — im Chart sah es aus, als läge der Preis genau auf der unteren Grenze.
 * Auch die Kurve selbst war betroffen: alle Punkte zwischen 0,00115 und 0,00125 wurden auf
 * denselben Wert gerundet, die Preisbewegung wurde zur flachen Treppe.
 */

/** Zehnerexponent einer Zahl (0 für Werte, die keinen sinnvollen Exponenten haben). */
function exponentOf(value) {
    const abs = Math.abs(value);
    if (!Number.isFinite(abs) || abs === 0) return 0;
    return Math.floor(Math.log10(abs));
}

/**
 * Nachkommastellen für die ANZEIGE, so dass `sig` signifikante Ziffern sichtbar sind.
 *
 * 0.00119386 → 6 Stellen (0,001194) · 1.1797 → 3 (1,180) · 25734.63 → min (25 734,63)
 *
 * @param {number|null|undefined} value
 * @param {{sig?: number, min?: number, max?: number}} [opts]
 *        sig – angestrebte signifikante Ziffern (Default 4)
 *        min – Untergrenze, damit Beträge nicht ganzzahlig wirken (Default 2)
 *        max – Obergrenze gegen unlesbare Ziffernketten (Default 10)
 * @returns {number}
 */
export function priceDecimals(value, { sig = 4, min = 2, max = 10 } = {}) {
    if (value == null || !Number.isFinite(value) || value === 0) return min;
    const decimals = sig - 1 - exponentOf(value);
    return Math.min(max, Math.max(min, decimals));
}

/**
 * Formatiert einen Preis für die ANZEIGE.
 *
 * Überflüssige Nullen am Ende fallen weg, aber nie unter `min` Stellen: 1.1797 wird
 * „1,18" und nicht „1,180". Mit `locale` wird landesüblich getrennt (Dashboard), ohne
 * `locale` bleibt der Punkt als Dezimaltrenner (Meldungstexte, die als Rohtext auch nach
 * Telegram gehen).
 *
 * @param {number|null|undefined} value
 * @param {{locale?: string|null, unit?: string|null, sig?: number, min?: number,
 *          max?: number, empty?: string}} [opts]
 *        unit  – Einheit, die angehängt wird (z.B. das Quote-Symbol des Pools)
 *        empty – Rückgabe für null/NaN (Default '—')
 * @returns {string}
 */
export function formatPrice(value, opts = {}) {
    const { locale = null, unit = null, sig = 4, min = 2, max = 10, empty = '—' } = opts;
    if (value == null || !Number.isFinite(value)) return empty;

    const decimals = priceDecimals(value, { sig, min, max });
    let text;

    if (locale) {
        text = Number(value).toLocaleString(locale, {
            minimumFractionDigits: min,
            maximumFractionDigits: decimals,
        });
    } else {
        // toFixed() füllt immer bis `decimals` auf — überzählige Nullen selbst abschneiden,
        // aber nie unter `min` Stellen (toLocaleString erledigt das oben von allein).
        text = Number(value).toFixed(decimals);
        if (decimals > min && text.includes('.')) {
            text = text.replace(new RegExp(`(\\.\\d{${min}}\\d*?)0+$`), '$1');
        }
    }

    return unit ? `${text} ${unit}` : text;
}

/**
 * Rundet einen Preis für den TRANSPORT ins Dashboard-JSON.
 *
 * Behält `sig` signifikante Ziffern, aber nie weniger Nachkommastellen als bisher
 * (`minDecimals`, entspricht dem alten round4). Dadurch gewinnen kleine Werte an
 * Präzision, ohne dass große Werte welche verlieren:
 *
 *   0.00119386031840491 → 0.00119386   (vorher 0.0012)
 *   71833.7588…         → 71833.7588   (unverändert)
 *
 * @param {number|null|undefined} value
 * @param {{sig?: number, minDecimals?: number, maxDecimals?: number}} [opts]
 * @returns {number|null}
 */
export function roundPrice(value, { sig = 6, minDecimals = 4, maxDecimals = 12 } = {}) {
    if (value == null || !Number.isFinite(value)) return null;
    if (value === 0) return 0;

    const decimals = Math.min(maxDecimals, Math.max(minDecimals, sig - 1 - exponentOf(value)));
    const factor   = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}

/**
 * Einheit eines Poolpreises = das Quote-Token, also das echte tokenB.
 *
 * Der Poolpreis ist tokenB pro tokenA. Meist entspricht das der Reihenfolge im `pair`
 * („SOL/cbBTC" → cbBTC, „cbBTC/USDC" → USDC, „SOL/PUMP" → PUMP).
 *
 * 🔒 ABER: `pair` ist laut interner Doku (Pool-Checkliste, Schritt 6) ein
 * **Anzeige-/Label-Feld** und keine verlässliche Kodierung der
 * tokenA/tokenB-Zuordnung. `liq-eurc-usdc` trägt `pair: "EURC/USDC"`, hat aber
 * `usdcIsTokenA: true` — dort ist die Reihenfolge invertiert. Belegt am echten Kurs:
 * der Pool notiert 0,854, also 1/1,17 = EURC pro USDC. Der Preis folgt damit der
 * ECHTEN Token-Reihenfolge, nicht dem Label. Ein naives `pair.split('/')[1]` hätte
 * dort „USDC" statt „EURC" geliefert.
 *
 * Deshalb nimmt diese Funktion das POOL-OBJEKT, nicht den pair-String.
 *
 * 🔒 Auch nicht `displayPair` verwenden — das ist die Orca-Schreibweise und bei
 * SOL-Pools genau andersherum („cbBTC/SOL").
 *
 * @param {{pair?: string, usdcIsTokenA?: boolean}|null|undefined} pool
 * @returns {string|null}
 */
export function quoteSymbol(pool) {
    const pair = pool?.pair;
    if (typeof pair !== 'string') return null;
    const parts = pair.split('/');
    if (parts.length !== 2) return null;

    // usdcIsTokenA: USDC steht im Label rechts, ist aber tokenA — dann ist das
    // Quote-Token (tokenB) die linke Hälfte.
    const quote = pool.usdcIsTokenA ? parts[0] : parts[1];
    return quote ? quote.trim() : null;
}
