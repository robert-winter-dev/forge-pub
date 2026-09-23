/**
 * scam-classify.js
 *
 * Zentrale Einstufung unbekannter Wallet-Token und die dazugehörige
 * Jupiter-Abfrage.
 *
 * 🔒 Grundregel: Ein fremder Mint, der sich als bekannter Token ausgibt, ist per
 * Definition ein Imitat — der echte Mint steht in der Whitelist und erreicht diese
 * Prüfung nie. Geprüft werden Symbol UND Name, denn ein Angreifer wählt sonst
 * einfach das ungeprüfte Feld. Die Normalisierung liegt in `lib/token-symbol.js`,
 * neue Verschleierungstechniken gehören dorthin.
 *
 * Zweites, unabhängiges Netz: das Scam-Urteil von Jupiter selbst
 * (`jupiterScamVerdict()`). Es greift auch dann, wenn ein Airdrop sich keinen
 * bekannten Namen borgt — der Fall, in dem die Kollisionsprüfung nichts sieht.
 *
 * Warum zentral: Die Einstufung wird inzwischen an fünf Stellen gebraucht —
 * `bots/liquidity/bin/close-scam-tokens.js`, `bots/lending/bin/close-scam-tokens.js`,
 * `core/premium/bin/close-scam-tokens.js`, `core/wallet-monitor/monitor.js` für die
 * Meldung und die Settings-Oberfläche, die dem Nutzer anzeigen muss, was der Burn
 * anschließend tatsächlich tut. Zwei Kopien
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
import { findImpersonatedLabel } from './token-symbol.js';

/** Ab diesem USDC-Gegenwert gilt ein Token als „nennenswert wertvoll". */
export const DEFAULT_VALUE_THRESHOLD = 5;

/**
 * Einstufungen, absteigend nach Handlungsdruck.
 *
 *   BURN   – Kollision mit einem bekannten Token (Symbol ODER Name) oder ein
 *            Scam-Urteil von Jupiter — und kein nennenswerter Wert. Stärkstes
 *            Signal, der Regelfall einer Airdrop-Welle.
 *   REVIEW – Dasselbe Signal, aber Wert ≥ Schwelle. Oder: kein Preis UND keinerlei
 *            Metadaten (Symbol und Name beide leer) — echte Positions-/Receipt-
 *            Token tragen immer wenigstens einen Namen. Wird nie automatisch
 *            verbrannt (`burn` ist irreversibel), aber deutlich ausgewiesen.
 *   WARN   – Kein Urteil möglich: kein Marktpreis und keine Kollision, oder ein
 *            Preis unterhalb der Schwelle. Manuell prüfen.
 *   VERIFIED – Von Jupiter verifiziert, Preis bekannt, Wert unter der Schwelle (Staub),
 *            keine Kollision, kein Verdacht. Ein echter Token, der nur zufällig im
 *            Wallet liegt (z.B. ONyc-Staub, 2026-09-21). Wird angezeigt, aber nicht
 *            als auffällig gezählt und NIE verbrannt — weder in der Oberfläche noch
 *            von den close-scam-Skripten (die brennen nur BURN/WARN/REVIEW).
 *   SKIP   – Preis bekannt, Wert ≥ Schwelle, keine Kollision → unberührt lassen.
 */
export const TIERS = ['BURN', 'REVIEW', 'WARN', 'VERIFIED', 'SKIP'];

/**
 * Bekannte Symbole robust in ein Iterable über Strings überführen.
 *
 * Die Aufrufer halten sie unterschiedlich: `buildKnownTokens()` liefert ein `Set`
 * von Symbolen, die close-scam-Skripte bauen eine `Map` mint→symbol. Eine `Map` direkt
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
 * Bewertet die Jupiter-Metadaten eines Mints auf ein eigenständiges Scam-Urteil.
 *
 * Warum überhaupt: Die Kollisionsprüfung erkennt nur Imitate BEKANNTER Token. Ein
 * Airdrop, der sich keinen bekannten Namen borgt, bleibt ohne dieses Signal auf
 * WARN — und WARN bekommt in der Oberfläche bewusst keinen Mülleimer. Jupiter
 * liefert in derselben Antwort, aus der wir ohnehin den Preis lesen, ein direktes
 * Urteil (`audit.isSus`) und die Organic-Score-Einstufung; beides ist belastbarer,
 * als wir es aus Alter und Liquidität selbst herleiten könnten.
 *
 * 🔒 `isVerified` hebelt das Urteil IMMER aus. Ein von Jupiter verifizierter Token
 * wird über diesen Weg nie brennbar, egal was die übrigen Felder sagen — die
 * Verifikation ist die stärkere Aussage, und ein Fehlurteil kostet hier echtes Geld.
 *
 * 🔒 Bewusst NICHT verwendet: `audit.topHoldersPercentage`. Der Wert sieht wie ein
 * perfektes Kriterium aus (96 % beim Scam-Token vom 2026-08-21), trennt aber nicht:
 * das völlig legitime syrupUSDC liegt bei 93,8 %. Er hätte uns nur Selbstvertrauen
 * vorgetäuscht.
 *
 * Ebenfalls NICHT verwendet: `holderCount`. Die Zahl ist für den Menschen die
 * überzeugendste Information (26 Holder gegen 168.748 bei echtem Fartcoin) und wird
 * deshalb angezeigt — als Automatik-Kriterium taugt sie nicht. Sie ist eine
 * Momentaufnahme, die der Angreifer kostenlos nach oben treibt, indem er weiter
 * verteilt (derselbe Token: +2.500 % Holder in 24 h). Und in der Gegenrichtung hat
 * jeder junge, legitime Token ebenfalls wenige Holder.
 *
 * @param   {object|null|undefined} signals  Eintrag aus fetchTokenSignals()
 * @returns {string|null} Kurzbegründung für die Anzeige, oder null
 */
export function jupiterScamVerdict(signals) {
    if (!signals) return null;                 // nicht bei Jupiter gelistet → kein Urteil
    if (signals.isVerified === true) return null;
    if (signals.isSus === true) return 'jupiter_sus';
    if (signals.organicScoreLabel === 'low') return 'organic_low';
    return null;
}

/**
 * Kurze Begründung einer Einstufung für CLI-Ausgaben und Reports.
 *
 * Zentral, weil es seit dem Jupiter-Urteil zwei mögliche Gründe gibt: die drei
 * close-scam-Skripte schrieben zuvor pauschal `imitiert "${dupSymbol}"` — bei einem
 * Fund ohne Kollision stünde dort `imitiert "null"`.
 *
 * Nicht für die Oberfläche: die übersetzt über i18n-Schlüssel.
 *
 * @param   {{ dupSymbol: string|null, susReason: string|null }} cl
 * @returns {string|null}
 */
export function verdictReason(cl) {
    if (cl?.dupSymbol) return `imitiert "${cl.dupSymbol}"`;
    if (cl?.susReason === 'jupiter_sus')  return 'von Jupiter als verdächtig markiert';
    if (cl?.susReason === 'organic_low')  return 'kein organischer Handel, nicht verifiziert';
    return null;
}

/**
 * Stuft einen unbekannten Token ein.
 *
 * @param {{ uiAmount: number, meta?: { symbol?: string|null, name?: string|null } }} token
 * @param {object|null|undefined} priceData  Eintrag aus fetchTokenSignals()
 * @param {Iterable<string>|Map<string,string>|Set<string>} knownSymbols
 * @param {{ valueThreshold?: number }} [opts]
 * @returns {{ tier: string, value: number|null, dupSymbol: string|null, susReason: string|null }}
 */
export function classify(token, priceData, knownSymbols, opts = {}) {
    const threshold = opts.valueThreshold ?? DEFAULT_VALUE_THRESHOLD;
    const price     = priceData?.price ?? null;
    const value     = price != null ? price * token.uiAmount : null;

    // Symbol UND Name — ein Angreifer wählt sonst schlicht das ungeprüfte Feld
    // (Vorfall 2026-08-21, Details in lib/token-symbol.js).
    const dupSymbol = findImpersonatedLabel(token.meta ?? {}, toSymbolIterable(knownSymbols));
    const susReason = jupiterScamVerdict(priceData);
    const flagged   = dupSymbol != null || susReason != null;

    // Preis bekannt + Wert ≥ Schwelle → normalerweise nicht anfassen.
    // Ausnahme Verdacht: ein auffälliger Token mit nennenswertem Wert wird NICHT
    // automatisch verbrannt, sondern als REVIEW ausgewiesen — sichtbar, aber nur nach
    // bewusster Einzelentscheidung zu schließen. Diese Wertschwelle steht bewusst VOR
    // allen Verdachtsregeln: sie ist der Schutz, der auch bei einem Fehlurteil hält.
    if (value != null && value >= threshold) {
        return { tier: flagged ? 'REVIEW' : 'SKIP', value, dupSymbol, susReason };
    }

    // Verdacht → stärkstes Scam-Signal, unabhängig von Balance und Alter.
    if (flagged) {
        return { tier: 'BURN', value, dupSymbol, susReason };
    }

    // Weder Preis noch IRGENDEIN Metadaten-Feld (Symbol UND Name leer) — das
    // unterscheidet diesen Fall von den echten Positions-/Receipt-Token unten:
    // ein Orca-Positions-NFT oder ein Loopscale-LP-Token trägt immer wenigstens
    // einen Namen, auch ohne Marktpreis. Fehlt beides, ist "manuell prüfen" (WARN,
    // nicht löschbar) zu schwach — REVIEW macht den Löschen-Button mit getippter
    // Bestätigung nutzbar, verbrennt aber weiterhin nichts automatisch.
    if (price == null && !token.meta?.symbol && !token.meta?.name) {
        return { tier: 'REVIEW', value: null, dupSymbol, susReason };
    }

    // Kein Preis, kein Verdacht, aber hohe Balance → wahrscheinlich ein echter
    // Token ohne Jupiter-Listing (Bridge-Token o.ä.), manuell prüfen.
    if (price == null && token.uiAmount > 100) {
        return { tier: 'WARN', value: null, dupSymbol, susReason };
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
    // genommen. Die Verdachtsfälle oben bleiben automatisch — sie stützen sich auf
    // ein POSITIVES Signal, nicht auf eine fehlende Information.
    if (price == null) {
        return { tier: 'WARN', value: null, dupSymbol, susReason };
    }

    // Preis bekannt, Wert unter der Schwelle, aber von Jupiter verifiziert: ein echter
    // Token in Staubmenge. Bis 2026-09-21 landete er hier auf WARN („Unklar") und wäre
    // von close-scam-tokens.js --execute verbrannt worden. Die Verifikation ist die
    // stärkere Aussage (siehe jupiterScamVerdict); Kollision/Verdacht sind oben schon
    // abgefangen, dieser Zweig wird nur ohne beides erreicht.
    if (priceData?.isVerified === true) {
        return { tier: 'VERIFIED', value, dupSymbol, susReason };
    }

    // Preis bekannt, aber Wert unter der Schwelle.
    return { tier: 'WARN', value, dupSymbol, susReason };
}

/**
 * Jupiter-Token-Daten als Batch über den Nexus-Proxy.
 *
 * Quelle ist `tokens/v2/search`, NICHT mehr `price/v3`. Beide liefern Preis,
 * Liquidität und Erstellungsdatum — search legt aber die Felder obendrauf, mit
 * denen sich ein Airdrop überhaupt erst beurteilen lässt (`audit.isSus`,
 * `organicScore`, `isVerified`, `holderCount`). Der Wechsel kostet also nichts:
 * es ist derselbe eine Call mit reicherer Antwort.
 *
 * ⚠️ Zwei Unterschiede zum alten Endpunkt, beide leicht zu übersehen:
 *   1. search antwortet als ARRAY von Token-Objekten, price/v3 als flache Map
 *      mint→Objekt. Der Mint steht hier im Feld `id`.
 *   2. search nimmt maximal 100 Mints je Anfrage (price/v3 hatte keine Grenze).
 *      Deshalb wird gechunkt. In der Praxis bleibt es bei einem Call — so viele
 *      unbekannte Mints hat kein FORGE-Wallet.
 *
 * Umgerechnet wird hier, an der einen Außengrenze — `classify()` und die Aufrufer
 * arbeiten weiter mit `price`, ein künftiger Feldwechsel bei Jupiter trifft genau
 * diese Funktion.
 *
 * Einträge OHNE Preis werden mitgenommen (price: null). Bei Scam-Token ist der fehlende
 * Preis der Normalfall, ihre übrigen Felder sind aber gerade dann die interessante
 * Information. Ein Mint, den search GAR NICHT kennt, fehlt im Ergebnis — das ist der
 * Normalfall für Positions-NFTs und Receipt-Token und darf nie als Urteil gelten.
 *
 * @param {string} searchUrl  z.B. 'http://127.0.0.1:3100/jup/tokens/v2/search'
 * @param {string[]} mints
 * @returns {Promise<Record<string, {
 *   price: number|null, createdAt: string|null, liquidity: number|null,
 *   holderCount: number|null, organicScoreLabel: string|null,
 *   isVerified: boolean, isSus: boolean }>>}
 */
export async function fetchTokenSignals(searchUrl, mints) {
    if (!mints || mints.length === 0) return {};

    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const out = {};

    for (let i = 0; i < mints.length; i += 100) {
        const chunk = mints.slice(i, i + 100);
        try {
            const res = await fetch(`${searchUrl}?query=${chunk.join(',')}`);
            if (!res.ok) continue;
            const json = await res.json();
            // Defensiv: sollte Jupiter je auf ein { data: [...] }-Schema wechseln,
            // fällt das hier auf und nicht als lautloses "alles unbekannt".
            const list = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);

            for (const entry of list) {
                if (!entry || typeof entry !== 'object' || !entry.id) continue;
                out[entry.id] = {
                    price:     num(entry.usdPrice),
                    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
                    liquidity: num(entry.liquidity),
                    // Nur Anzeige, nie Entscheidung — Begründung an jupiterScamVerdict().
                    holderCount:       num(entry.holderCount),
                    organicScoreLabel: typeof entry.organicScoreLabel === 'string' ? entry.organicScoreLabel : null,
                    isVerified:        entry.isVerified === true,
                    isSus:             entry.audit?.isSus === true,
                };
            }
        } catch { /* Netzfehler → dieser Chunk bleibt unbekannt, kein Urteil */ }
    }
    return out;
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
