/**
 * FORGE – Zentrale SOL-Bestand-Sicherung
 *
 * `ensureSolBalance()` swappt bei Bedarf vorhandenes Wallet-Guthaben in SOL,
 * bis ein gewünschter Ziel-Bestand erreicht ist. Die Funktion ist
 * flavor-übergreifend (Liquidity, LendingBot, künftige Bots): Preis-Lookup,
 * Token-Kandidaten, Balance-Abfragen und der eigentliche Swap werden per
 * Parameter (Closures) injiziert — die Funktion ist dadurch NICHT an eine
 * Bot-DB, ein RPC-Setup oder ein Swap-Modul gebunden.
 *
 * 🔒 Bewusste Nicht-Zuständigkeiten (Separation of Concerns):
 *   - Sendet KEINE Notifications. Der Aufrufer entscheidet anhand des
 *     Ergebnisses über Telegram/Dashboard-Meldung + Cooldown.
 *   - Greift KEINE Locks. Der Aufrufer hält den Lock-Kontext (z.B. SL-Lock,
 *     Cleanup-Lock), damit nicht zwei Prozesse gleichzeitig swappen.
 *   - Macht KEINEN eigenen RateLimiter/Proxy auf. Der injizierte `swap`-Callback
 *     läuft über den bestehenden, rate-limitierten Swap-Pfad des Bots.
 *
 * Algorithmus (identisch zur erprobten Cleanup-Topup-Logik):
 *   1. Ist bereits >= minSol vorhanden → nichts tun.
 *   2. Sonst: Kandidaten der Reihe nach (USDC zuerst, dann Pool-Token)
 *      so weit in SOL swappen, bis targetSol erreicht ist.
 *      - Nur der minimal nötige Delta-Bedarf wird getauscht (+Slippage-Puffer).
 *      - Swaps unter `minSwapUsd` (Dust) werden übersprungen.
 *      - Nach jedem Swap wird der SOL-Bestand frisch nachgelesen.
 */

/**
 * @param {object}   opts
 * @param {number}   opts.minSol           Unter diesem Bestand wird aufgefüllt.
 * @param {number}   opts.targetSol        Ziel-SOL-Bestand nach dem Auffüllen.
 * @param {() => Promise<number>}              opts.getSolBalance   Frischer SOL-Bestand.
 * @param {(mint:string, decimals:number) => Promise<number>} opts.getTokenBalance Frischer Token-Bestand.
 * @param {() => Promise<Map<string,number>>} [opts.getTokenBalances] Alle Bestände auf
 *        einmal (mint → Betrag). Wenn gesetzt, wird EINMAL vor der Schleife abgerufen
 *        statt je Kandidat `getTokenBalance` — siehe Hinweis unten.
 * @param {() => number}                       opts.getSolPrice     SOL-Preis in USD (0/null = unbekannt).
 * @param {(mint:string) => number}            opts.getTokenPrice   Token-Preis in USD (0/null = unbekannt).
 * @param {Array<{mint:string,decimals:number,symbol:string}>} opts.candidates  Swap-Kandidaten in Priorität.
 * @param {({token, amount}) => Promise<void>} opts.swap            Führt token→SOL-Swap aus (inkl. Bot-Bookkeeping).
 * @param {number}   [opts.slippageBufferPct=0.01]  Aufschlag auf den USD-Bedarf (Slippage-Puffer).
 * @param {number}   [opts.minSwapUsd=0.5]          Dust-Schwelle: kleinere Swaps überspringen.
 * @param {number}   [opts.criticalSol=null]        Unter diesem SOL-Stand ist der Bot handlungsunfähig
 *                                                  (= harte Reserve). Darunter gilt minSwapUsdCritical.
 * @param {number}   [opts.minSwapUsdCritical=0.05] Dust-Schwelle im kritischen Zustand.
 * @param {(msg:string) => void} [opts.log]         Logger-Callback.
 *
 * @returns {Promise<{
 *   topupNeeded: boolean,    // war ein Auffüllen überhaupt nötig?
 *   reachedTarget: boolean,  // wurde targetSol erreicht?
 *   solBefore: number,
 *   solAfter: number,
 *   swaps: Array<{symbol:string, amount:number}>,
 *   error?: string,          // 'no-sol-price' wenn SOL-Preis fehlte
 * }>}
 */
export async function ensureSolBalance({
    minSol,
    targetSol,
    getSolBalance,
    getTokenBalance,
    getTokenBalances = null,
    getSolPrice,
    getTokenPrice,
    candidates,
    swap,
    slippageBufferPct = 0.01,
    minSwapUsd = 0.5,
    criticalSol = null,
    minSwapUsdCritical = 0.05,
    log = () => {},
}) {
    const solBefore = await getSolBalance();
    const swaps = [];

    // 1. Genug SOL vorhanden → nichts zu tun.
    if (solBefore >= minSol) {
        return { topupNeeded: false, reachedTarget: true, solBefore, solAfter: solBefore, swaps };
    }

    const solPrice = getSolPrice();
    if (!(solPrice > 0)) {
        log(`SOL-Preis nicht verfügbar – Topup übersprungen`);
        return { topupNeeded: true, reachedTarget: false, solBefore, solAfter: solBefore, swaps, error: 'no-sol-price' };
    }

    // Kritischer Zustand: unter der harten Reserve kann der Bot gar nicht mehr handeln.
    // Dort ist "lohnt sich der Swap?" die falsche Frage — die Alternative ist Stillstand.
    // Ein Restguthaben, das die normale 0,5-USDC-Schwelle nicht erreicht, bleibt sonst
    // dauerhaft liegen: der Bedarf wächst nie unter die Schwelle, das Guthaben nie darüber
    // (Befund forge-pub1 2026-07-30: 0,46 USDC neben 0,1063 SOL, beides seit Tagen unverändert).
    const critical = criticalSol != null && solBefore < criticalSol;
    const effMinSwapUsd = critical ? minSwapUsdCritical : minSwapUsd;

    log(`SOL-Topup: ${solBefore.toFixed(4)} SOL < ${minSol} – ziele auf ${targetSol} SOL`
        + (critical ? ` (kritisch: unter ${criticalSol} SOL, Mindest-Swap ${effMinSwapUsd} statt ${minSwapUsd} USDC)` : ''));

    // 2. Kandidaten der Reihe nach in SOL swappen, bis targetSol erreicht.
    //
    // 🔒 Bestände EINMAL als Momentaufnahme, nicht je Kandidat einzeln (LIQ#000843).
    // Eine Einzelabfrage je Kandidat kostet einen RPC-Call pro Token — bei 54 Kandidaten
    // und einem Topup, der bei leerem Wallet in jedem Bot-Zyklus erneut scheitert, war
    // das der größte einzelne Posten im Helius-Verbrauch von forge-pub1.
    //
    // Die Momentaufnahme ist semantisch gleichwertig, nicht bloß billiger: Ein Swap von
    // Token A verändert den Bestand von Token B nicht, und ein bereits getauschter Token
    // wird in derselben Runde nie erneut gelesen. Der SOL-Bestand wird nach jedem Swap
    // weiterhin frisch nachgelesen — nur dort kann sich innerhalb der Schleife etwas
    // ändern, das die nächste Entscheidung trägt.
    //
    // Nebennutzen: alle Bestände stammen aus einem Slot. Einzelabfragen konnten aus so
    // vielen verschiedenen Slots kommen, wie es Kandidaten gab.
    const balances = getTokenBalances ? await getTokenBalances() : null;
    const readBalance = async (token) => balances
        ? (balances.get(token.mint) ?? 0)
        : getTokenBalance(token.mint, token.decimals);

    let solNow = solBefore;
    for (const token of candidates) {
        if (solNow >= targetSol) break;

        const bal = await readBalance(token);
        if (!(bal > 0)) continue;

        const price = getTokenPrice(token.mint);
        if (!(price > 0)) {
            log(`SOL-Topup: ${token.symbol} übersprungen – kein Preis verfügbar`);
            continue;
        }

        const stillNeededSol    = targetSol - solNow;
        const tokenAmountNeeded  = (stillNeededSol * solPrice * (1 + slippageBufferPct)) / price;
        const swapAmount         = Math.min(tokenAmountNeeded, bal * 0.99);
        if (swapAmount * price < effMinSwapUsd) {
            // Bewusst geloggt (war bis 2026-07-30 ein stiller `continue`): genau hier
            // versandet der Topup, und ohne Ausgabe sah es im Log so aus, als wäre er
            // nie gelaufen — das hat die Ursachensuche unnötig lang gemacht.
            log(`SOL-Topup: ${token.symbol} ${swapAmount.toFixed(6)} (~${(swapAmount * price).toFixed(4)} USDC) `
              + `unter Mindest-Swap ${effMinSwapUsd} USDC – übersprungen`);
            continue;
        }

        try {
            await swap({ token, amount: swapAmount });
            solNow = await getSolBalance();
            swaps.push({ symbol: token.symbol, amount: swapAmount });
            log(`SOL-Topup: nach ${token.symbol}→SOL jetzt ${solNow.toFixed(4)} SOL`);
        } catch (err) {
            log(`SOL-Topup: ${token.symbol}→SOL fehlgeschlagen: ${err.message}`);
        }
    }

    const reachedTarget = solNow >= targetSol;
    if (!reachedTarget) {
        log(`SOL-Topup: Ziel ${targetSol} SOL nicht erreicht (${solNow.toFixed(4)} SOL) – kein ausreichendes Token-Guthaben`);
    }

    return { topupNeeded: true, reachedTarget, solBefore, solAfter: solNow, swaps };
}
