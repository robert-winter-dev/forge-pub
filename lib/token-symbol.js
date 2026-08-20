/**
 * token-symbol.js
 *
 * Zentrale Symbol-Normalisierung für die Erkennung von Token-Imitaten
 * ("Impersonation"): Scam-Airdrops, die das Symbol eines echten Pool-Tokens
 * tragen, aber unter einem fremden Mint laufen.
 *
 * 🔒 Grundregel: Ein fremder Mint mit dem Symbol eines bekannten Tokens ist per
 * Definition ein Imitat — der echte Mint steht in der Whitelist und erreicht
 * diese Prüfung nie.
 *
 * Warum zentral: Die Logik wird an drei Stellen gebraucht (bin/forge-check.js
 * für die Meldung, bots/liquidity/bin/close-scam-tokens.js und
 * bots/lending/bin/close-scam-tokens.js für die Bereinigung). Drei Kopien
 * driften auseinander — genau so entstand der Zustand, den LIQ#0299 aufdeckte:
 * ein exakter `toLowerCase()`-Vergleich, den schon ein angehängtes Leerzeichen
 * aushebelte. Neue Verschleierungstechniken gehören ausschließlich hier hinein.
 *
 * Beobachtete Tricks (alle real in den FORGE-Wallets aufgetreten):
 *   "Fartcoin " – angehängtes Leerzeichen
 *   "‮PMUP"    – RTL-Override, erscheint in der Anzeige als "PUMP"
 *   "S​OL"     – Zero-Width-Space zwischen den Buchstaben
 */

// Unsichtbare Zeichen, die ein Symbol optisch unverändert lassen:
// Zero-Width (200B–200D), Bidi-Marks (200E–200F), Bidi-Embedding/Overrides
// (202A–202E), Bidi-Isolates (2066–2069), BOM (FEFF).
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// Steuerzeichen, die die Anzeigerichtung umkehren: RLE, RLO, RLI.
const BIDI_REVERSAL_RE = /[\u202B\u202E\u2067]/;

/**
 * Normalisiert ein Token-Symbol für den Kollisionsvergleich.
 *
 * NFKC faltet Unicode-Varianten normaler Buchstaben zusammen, danach fallen
 * unsichtbare Steuerzeichen und sämtlicher Whitespace weg.
 *
 * @param   {string|null|undefined} symbol
 * @returns {string|null} normalisiertes Symbol, oder null wenn nach der
 *          Bereinigung nichts übrig bleibt — ein leerer String darf nie als
 *          Treffer gelten.
 */
export function normalizeSymbol(symbol) {
    if (!symbol) return null;
    const cleaned = String(symbol)
        .normalize('NFKC')
        .replace(INVISIBLE_RE, '')
        .replace(/\s+/g, '')
        .toLowerCase();
    return cleaned.length > 0 ? cleaned : null;
}

/**
 * Liefert alle normalisierten Schreibweisen, unter denen ein Symbol dem Auge
 * des Nutzers erscheinen kann.
 *
 * Der Sonderfall ist die Richtungsumkehr: "‮PMUP" wird als "PUMP" gerendert.
 * Nach dem Strippen des Steuerzeichens bleibt "pmup" übrig — die Kollision mit
 * "PUMP" fiele also auf, obwohl der Token optisch exakt wie das Original
 * aussieht. Deshalb zusätzlich die umgekehrte Zeichenfolge prüfen, aber nur wenn
 * im Original tatsächlich ein Reversal-Zeichen stand: pauschales Umdrehen würde
 * harmlose Paare wie "ABC"/"CBA" fälschlich als Imitat melden.
 *
 * @param   {string|null|undefined} symbol
 * @returns {string[]} normalisierte Kandidaten (leer wenn kein Symbol)
 */
export function symbolCandidates(symbol) {
    const base = normalizeSymbol(symbol);
    if (!base) return [];
    const candidates = [base];
    if (BIDI_REVERSAL_RE.test(String(symbol))) {
        const reversed = [...base].reverse().join('');
        if (reversed !== base) candidates.push(reversed);
    }
    return candidates;
}

/**
 * Prüft, ob ein Symbol ein bekanntes Token imitiert.
 *
 * @param   {string|null|undefined} symbol       Symbol des unbekannten Tokens
 * @param   {Iterable<string>}      knownSymbols Symbole der bekannten Token
 * @returns {string|null} das imitierte bekannte Symbol in Originalschreibweise,
 *          sonst null
 */
export function findImpersonatedSymbol(symbol, knownSymbols) {
    const candidates = symbolCandidates(symbol);
    if (candidates.length === 0) return null;
    for (const known of knownSymbols) {
        const normalized = normalizeSymbol(known);
        if (normalized != null && candidates.includes(normalized)) return known;
    }
    return null;
}
