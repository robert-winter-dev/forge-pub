/**
 * scam-classify.js
 *
 * Zentrale Einstufung unbekannter Wallet-Token und die dazugehörige
 * Jupiter-Preisabfrage.
 *
 * 🔒 Grundregel: Ein fremder Mint mit dem Symbol eines bekannten Tokens ist per
 * Definition ein Imitat — der echte Mint steht in der Whitelist und erreicht
 * diese Prüfung nie. Die Normalisierung des Symbolvergleichs liegt in
 * `lib/token-symbol.js`, neue Verschleierungstechniken gehören dorthin.
 *
 * Warum zentral: Die Einstufung wird inzwischen an vier Stellen gebraucht —
 * `bots/liquidity/bin/close-scam-tokens.js`, `bots/lending/bin/close-scam-tokens.js`,
 * `core/premium/bin/close-scam-tokens.js` und die Settings-Oberfläche, die dem
 * Nutzer anzeigen muss, was der Burn anschließend tatsächlich tut. Zwei Kopien
 * sind bereits nachweislich auseinandergelaufen (`LIQ#0299`: exakter
 * `toLowerCase()`-Vergleich, den ein angehängtes Leerzeichen aushebelte; zuletzt
 * trugen die beiden `classify()`-Fassungen sogar unterschiedliche Fix-Daten im
 * Kommentar). Eine dritte Kopie für Premium hätte das Muster fortgeschrieben.
 *
 * Noch wichtiger als die Drift: Oberfläche und Burn müssen dieselbe Stufe sehen.
 * Zwei Implementierungen heißen früher oder später, dass die UI „unbedenklich"
 * anzeigt und das Skript trotzdem verbrennt.
 *
 * Rollenverteilung bei der **Whitelist**:
 *   - `buildKnownTokens()` (unten) ist die gemeinsame Basis für LESENDE Aufrufer,
 *     die nur einordnen wollen — vor allem die Settings-Route.
 *   - Die close-scam-Skripte behalten ihren eigenen, reicheren Aufbau. Sie sind
 *     beim Burn die Autorität und dürfen sich nicht auf eine Sicht verlassen, die
 *     für die Anzeige gebaut wurde. Die Anzeige darf irren, der Burn nicht.
 */

import { join } from 'node:path';
import { findImpersonatedSymbol } from './token-symbol.js';

/** Ab diesem USDC-Gegenwert gilt ein Token als „nennenswert wertvoll". */
export const DEFAULT_VALUE_THRESHOLD = 5;

/**
 * Einstufungen, absteigend nach Handlungsdruck.
 *
 *   BURN   – Symbol-Kollision mit einem bekannten Token und kein nennenswerter
 *            Wert. Stärkstes Scam-Signal, der Regelfall einer Airdrop-Welle.
 *   REVIEW – Symbol-Kollision UND Wert ≥ Schwelle. Wird nie automatisch
 *            verbrannt (`burn` ist irreversibel), aber deutlich ausgewiesen.
 *   WARN   – Kein Urteil möglich: kein Marktpreis und keine Kollision, oder ein
 *            Preis unterhalb der Schwelle. Manuell prüfen.
 *   SKIP   – Preis bekannt, Wert ≥ Schwelle, keine Kollision → unberührt lassen.
 */
export const TIERS = ['BURN', 'REVIEW', 'WARN', 'SKIP'];

/**
 * Bekannte Symbole robust in ein Iterable über Strings überführen.
 *
 * Die Aufrufer halten sie unterschiedlich: `bin/forge-check.js` als `Set` von
 * Symbolen, die close-scam-Skripte als `Map` mint→symbol. Eine `Map` direkt
 * durchzuiterieren liefert `[key, value]`-Paare und damit **nie** einen Treffer —
 * ein lautloser Fehlschlag genau in der Prüfung, die den Scam erkennen soll.
 * Deshalb wird die Form hier vereinheitlicht statt auf Disziplin zu hoffen.
 */
function toSymbolIterable(knownSymbols) {
    if (!knownSymbols) return [];
    if (knownSymbols instanceof Map) return knownSymbols.values();
    return knownSymbols;
}

/**
 * Stuft einen unbekannten Token ein.
 *
 * @param {{ uiAmount: number, meta?: { symbol?: string|null } }} token
 * @param {{ price: number|null }|null|undefined} priceData  Ergebnis aus fetchJupiterPrices()
 * @param {Iterable<string>|Map<string,string>|Set<string>} knownSymbols
 * @param {{ valueThreshold?: number }} [opts]
 * @returns {{ tier: string, value: number|null, dupSymbol: string|null }}
 */
export function classify(token, priceData, knownSymbols, opts = {}) {
    const threshold = opts.valueThreshold ?? DEFAULT_VALUE_THRESHOLD;
    const price     = priceData?.price ?? null;
    const value     = price != null ? price * token.uiAmount : null;

    const dupSymbol = findImpersonatedSymbol(token.meta?.symbol, toSymbolIterable(knownSymbols));

    // Preis bekannt + Wert ≥ Schwelle → normalerweise nicht anfassen.
    // Ausnahme Kollision: ein Imitat mit nennenswertem Wert wird NICHT automatisch
    // verbrannt, sondern als REVIEW ausgewiesen — sichtbar, aber nur nach bewusster
    // Einzelentscheidung zu schließen.
    if (value != null && value >= threshold) {
        return { tier: dupSymbol ? 'REVIEW' : 'SKIP', value, dupSymbol };
    }

    // Kein Preis, keine Kollision, aber hohe Balance → wahrscheinlich ein echter
    // Token ohne Jupiter-Listing (Bridge-Token o.ä.), manuell prüfen.
    if (price == null && !dupSymbol && token.uiAmount > 100) {
        return { tier: 'WARN', value: null, dupSymbol };
    }

    // Kollision → stärkstes Scam-Signal, unabhängig von Balance und Alter.
    if (dupSymbol) {
        return { tier: 'BURN', value, dupSymbol };
    }

    // 🔴 Kein Burn allein wegen fehlendem Preis.
    //
    // „Kein Jupiter-Preis" ist keine Feststellung von Wertlosigkeit, sondern nur
    // eine fehlende Information: Positions-NFTs und Receipt-/LP-Token (Loopscale-LP,
    // jlUSDC, …) haben systematisch keinen Marktpreis, obwohl sie den vollen
    // Positionswert repräsentieren. Genau diese Regel hat am 2026-08-12 beim
    // LendingBot LP-Token im Wert von ~70 USDC irreversibel verbrannt.
    //
    // Die Whitelist ist die erste Verteidigungslinie, das hier die zweite für den
    // Fall, dass sie lückenhaft ist. Der Verlust an Automatik (etwas Dust-Rent
    // bleibt liegen) ist gegen einen irreversiblen Kapitalverlust bewusst in Kauf
    // genommen. Der Scam-Kernfall (Kollision, oben) bleibt automatisch.
    if (price == null) {
        return { tier: 'WARN', value: null, dupSymbol };
    }

    // Preis bekannt, aber Wert unter der Schwelle.
    return { tier: 'WARN', value, dupSymbol };
}

/**
 * Jupiter-Preise als Batch über den Nexus-Proxy.
 *
 * price/v3 antwortet als FLACHE Map `{ <mint>: { usdPrice, … } }` — ohne
 * data-Wrapper und mit `usdPrice` statt `price`. Beide close-scam-Skripte werteten
 * bis 2026-08-19 noch das am 2026-05-30 abgeschaltete v2-Schema aus und lieferten
 * deshalb IMMER `{}`: `price` war für jeden Token `null`, die wertbasierten Stufen
 * SKIP und REVIEW damit unerreichbar.
 *
 * Umgerechnet wird hier, an der einen Außengrenze — `classify()` und die Aufrufer
 * arbeiten weiter mit `price`, ein künftiger Feldwechsel bei Jupiter trifft genau
 * diese Funktion.
 *
 * Ein Call deckt beliebig viele IDs ab; die Anzahl der Mints ist kein
 * Rate-Limit-Faktor.
 *
 * Neben dem Preis liefert die Antwort zwei Felder mit, die für die Beurteilung eines
 * unbekannten Tokens wertvoller sind als der Preis selbst — und nichts extra kosten:
 *
 *   createdAt – wann der Mint erzeugt wurde. Ein Mint, der wenige Stunden alt ist und
 *               schon im Wallet liegt, ist das deutlichste Airdrop-Signal überhaupt.
 *   liquidity – handelbare Liquidität in USDC, **mint-genau**. Bewusst statt der
 *               GeckoTerminal-TVL, die auf das SYMBOL matcht und bei einem Imitat
 *               deshalb die Zahlen des Originals zeigen kann — genau falsch herum.
 *
 * Einträge OHNE Preis werden mitgenommen (price: null). Bei Scam-Token ist der fehlende
 * Preis der Normalfall, ihre createdAt/liquidity sind aber gerade dann die interessante
 * Information.
 *
 * @param {string} priceUrl  z.B. 'http://127.0.0.1:3100/jup/price/v3'
 * @param {string[]} mints
 * @returns {Promise<Record<string, { price: number|null, createdAt: string|null, liquidity: number|null }>>}
 */
export async function fetchJupiterPrices(priceUrl, mints) {
    if (!mints || mints.length === 0) return {};
    try {
        const res = await fetch(`${priceUrl}?ids=${mints.join(',')}`);
        if (!res.ok) return {};
        const json = await res.json();

        const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

        const out = {};
        for (const [mint, entry] of Object.entries(json ?? {})) {
            if (!entry || typeof entry !== 'object') continue;
            out[mint] = {
                price:     num(entry.usdPrice),
                createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
                liquidity: num(entry.liquidity),
            };
        }
        return out;
    } catch { return {}; }
}

// ─── Bekannte Token (Basis-Whitelist) ────────────────────────────────────────

/**
 * Baut die Basis-Whitelist aus den Dateien, die auf JEDER Installation vorliegen:
 * `core/wallet-monitor/config.json` (überwachte Token) und
 * `bots/liquidity/config/pools.json` (Pool-Token, Symbole aus dem `pair`-Feld).
 * Optional kommen die Positions-NFT-Mints aus der Liquidity-DB dazu.
 *
 * Gedacht für **lesende** Aufrufer, die nur einordnen wollen (Settings-Route,
 * Anzeige). Die close-scam-Skripte behalten bewusst ihren eigenen, reicheren
 * Aufbau: sie sind beim Burn die Autorität und dürfen sich nicht auf eine Sicht
 * verlassen, die für die Anzeige gebaut wurde.
 *
 * 🔒 Positions-NFTs: ein Orca-CLMM-Positions-NFT hat Balance 1 und keinen
 * Jupiter-Preis. Fehlte es in der Whitelist, stünde es als unbekannter Token in
 * der Liste — bei einer offenen Position ist das NFT der Eigentumsnachweis.
 * Deshalb ALLE nft_mints, auch die geschlossener Positionen (Vorfall 2026-08-12).
 *
 * @param {object}  opts
 * @param {string}  opts.forgeRoot      Wurzel des Checkouts (PATHS/FORGE_ROOT)
 * @param {string} [opts.positionsDb]   Pfad zur Liquidity-DB; fehlt sie, wird sie ausgelassen
 * @param {object} [opts.deps]          { readFileSync, existsSync, Database } — Injection für Tests
 * @returns {{ mints: Set<string>, symbols: Set<string> }}
 */
export function buildKnownTokens({ forgeRoot, positionsDb = null, deps }) {
    const { readFileSync, existsSync, Database } = deps;

    const mints   = new Set([
        'So11111111111111111111111111111111111111112', // SOL (wrapped)
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    ]);
    // SOL/USDC stehen oben nur als Mint — ihre Symbole sind die häufigsten
    // Imitationsziele und werden deshalb hier ausdrücklich gepflegt.
    const symbols = new Set(['SOL', 'USDC']);

    try {
        const wm = JSON.parse(readFileSync(join(forgeRoot, 'core/wallet-monitor/config.json'), 'utf8'));
        for (const t of wm.tokens ?? []) {
            if (t.mint)   mints.add(t.mint);
            if (t.symbol) symbols.add(t.symbol);
        }
    } catch { /* optional – ohne Datei bleibt die Basis stehen */ }

    try {
        const raw  = JSON.parse(readFileSync(join(forgeRoot, 'bots/liquidity/config/pools.json'), 'utf8'));
        const list = Array.isArray(raw) ? raw : (raw.pools ?? []);
        for (const p of list) {
            if (p.tokenA) mints.add(p.tokenA);
            if (p.tokenB) mints.add(p.tokenB);
            // Deaktivierte Pools zählen bewusst mit: ihr Symbol bleibt ein
            // attraktives Imitationsziel (Fartcoin/USDC war bereits eines).
            if (p.pair) for (const sym of String(p.pair).split('/')) {
                if (sym.trim()) symbols.add(sym.trim());
            }
        }
    } catch { /* Fork ohne Liquidity Bot – kein Fehler */ }

    if (positionsDb && existsSync(positionsDb) && Database) {
        try {
            const db = new Database(positionsDb, { readonly: true });
            for (const { nft_mint } of db.prepare(
                'SELECT nft_mint FROM positions WHERE nft_mint IS NOT NULL'
            ).all()) {
                if (nft_mint) mints.add(nft_mint);
            }
            db.close();
        } catch { /* DB fehlt oder Schema abweichend – Whitelist bleibt ohne NFTs */ }
    }

    return { mints, symbols };
}
