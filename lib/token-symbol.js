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
 * Warum zentral: Die Logik hängt an `lib/scam-classify.js` und damit an allen
 * Stellen, die einstufen — den drei close-scam-Skripten, dem wallet-monitor und der
 * Settings-Oberfläche. Mehrere Kopien driften auseinander — genau so entstand der Zustand, den LIQ#0299 aufdeckte:
 * ein exakter `toLowerCase()`-Vergleich, den schon ein angehängtes Leerzeichen
 * aushebelte. Neue Verschleierungstechniken gehören ausschließlich hier hinein.
 *
 * Beobachtete Tricks (alle real in den FORGE-Wallets aufgetreten):
 *   "Fartcoin " – angehängtes Leerzeichen
 *   "‮PMUP"    – RTL-Override, erscheint in der Anzeige als "PUMP"
 *   "S​OL"     – Zero-Width-Space zwischen den Buchstaben
 *   Symbol "mɔ" + Name "‮nioctraF" – die Täuschung steckt AUSSCHLIESSLICH im
 *                 Namen (rendert als "Fartcoin"), das Symbol ist Tarnrauschen.
 *                 Deshalb prüft `findImpersonatedLabel()` beide Felder.
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

/**
 * Wie `findImpersonatedSymbol()`, aber über MEHRERE Beschriftungsfelder eines
 * Tokens (Symbol und Name).
 *
 * Warum beide Felder: Am 2026-08-21 kam ein Airdrop mit dem Symbol "mɔ" — das
 * kollidiert mit nichts — und dem Namen "‮nioctraF", der durch den vorangestellten
 * RTL-Override als "Fartcoin" gerendert wird. Der Nutzer sieht in jeder Wallet-
 * Oberfläche den Namen eines Pool-Tokens, unsere Prüfung sah nur das harmlose
 * Symbol. Ein Angreifer wählt schlicht das Feld, das nicht geprüft wird.
 *
 * 🔒 Verglichen wird ausschließlich die VOLLSTÄNDIGE normalisierte Zeichenkette,
 * niemals als Teilstring. Sonst wäre jeder legitime Name, der ein bekanntes Symbol
 * enthält ("Wrapped SOL Bridged", "Loopscale USDC Vault"), sofort ein Falschtreffer —
 * und ein Falschtreffer schaltet hier einen irreversiblen Burn frei.
 *
 * @param   {{ symbol?: string|null, name?: string|null }} labels
 * @param   {Iterable<string>} knownSymbols
 * @returns {string|null} das imitierte bekannte Symbol in Originalschreibweise
 */
export function findImpersonatedLabel(labels, knownSymbols) {
    // Einmal materialisieren: `knownSymbols` kommt von manchen Aufrufern als
    // Iterator (Map.values()). Der wäre nach dem ersten Feld erschöpft, das zweite
    // liefe gegen eine leere Liste — ein lautloser Fehlschlag.
    const known = [...knownSymbols];
    for (const field of [labels?.symbol, labels?.name]) {
        const hit = findImpersonatedSymbol(field, known);
        if (hit) return hit;
    }
    return null;
}

/**
 * Die Zeichenkette, die ein Mensch von einem Token-Label tatsächlich SIEHT —
 * ohne unsichtbare Steuerzeichen, getrimmt.
 *
 * Gebraucht für die Abtipp-Hürde vor einem Burn: niemand kann ein Zero-Width-Space
 * oder einen RTL-Override abtippen. Client und Server müssen dieselbe Regel
 * anwenden, sonst ist die Hürde entweder wirkungslos oder unerfüllbar.
 *
 * @param   {string|null|undefined} label
 * @returns {string|null} sichtbarer Text, oder null wenn nichts übrig bleibt
 */
export function visibleLabel(label) {
    if (!label) return null;
    const out = String(label).replace(INVISIBLE_RE, '').trim();
    return out.length > 0 ? out : null;
}
