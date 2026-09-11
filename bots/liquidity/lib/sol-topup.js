/**
 * FORGE Liquidity – SOL-Topup-Adapter
 *
 * Dünner Adapter, der die zentrale `ensureSolBalance()`-Funktion
 * (FORGE/lib/sol-balance.js) mit dem Liquidity-Bot-Wallet, Preis-Lookup und Swap-Pfad
 * verdrahtet. Dadurch bleibt die Topup-Mechanik an genau einer Stelle
 * (FORGE/lib) und kann von mehreren Stellen identisch genutzt werden
 * (Score-Limit-Exit; später auch der Cleanup-Job, der heute noch eine
 * eigene Kopie der Logik enthält).
 *
 * Token-Quelle: Kandidatenliste (USDC zuerst, dann die Token aller in
 * config.pools.all konfigurierten Pools). Bewusst KEINE On-Chain-Enumeration
 * aller Holdings — das würde Scam/Dust-Mints einschließen und kollidiert mit
 * dem Token-Whitelist-Spam-Schutz.
 */

import { PublicKey } from '@solana/web3.js';

import { ensureSolBalance } from '../../../lib/sol-balance.js';
import { config }          from './config.js';
import { swapTokens }      from './swap.js';
import {
    USDC_MINT,
    SOL_EXIT_FLOOR,
    getSolBalanceFresh,
    getTokenBalanceFresh,
    getTxFee,
} from './wallet.js';
import { getTokenUsdPrice } from './deposit-lib.js';
import { insertTransaction } from './db.js';

const WSOL_MINT      = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS   = 9;
const USDC_DECIMALS  = 6;
const TOPUP_SLIPPAGE_BPS = 150; // wie Cleanup: erhöhter Slippage für ggf. illiquide Token

/**
 * Gibt alle relevanten nicht-SOL, nicht-USDC Tokens aus den konfigurierten
 * Pools zurück (dedupliziert nach Mint). Gleiche Logik wie cleanup.js.
 */
function getRelevantTokens(pools) {
    const tokens = new Map();
    for (const pool of pools) {
        if (pool.tokenA && pool.tokenA !== WSOL_MINT && pool.tokenA !== USDC_MINT) {
            tokens.set(pool.tokenA, { mint: pool.tokenA, decimals: pool.decimalsA, symbol: pool.pair.split('/')[0] });
        }
        if (pool.tokenB && pool.tokenB !== WSOL_MINT && pool.tokenB !== USDC_MINT) {
            tokens.set(pool.tokenB, {
                mint:     pool.tokenB,
                decimals: pool.decimalsB,
                symbol:   pool.usdcIsTokenA ? pool.pair.split('/')[0] : pool.pair.split('/')[1],
            });
        }
    }
    return [...tokens.values()];
}

/** Aktueller SOL-Preis in USD aus dem jüngsten SOL/USDC-Pool-Stat. */
function loadSolPrice(db) {
    const row = db.prepare(
        `SELECT price FROM pool_stats WHERE pool_id = 'liq-sol-usdc' ORDER BY recorded_at DESC LIMIT 1`
    ).get();
    return row?.price ?? 0;
}

/**
 * Stellt sicher, dass mindestens `targetSol` SOL im Wallet liegen, indem bei
 * Bedarf Wallet-Token in SOL geswappt werden. Wird nur aktiv wenn der aktuelle
 * Bestand < `minSol` ist.
 *
 * Voraussetzung: Der Aufrufer hält den passenden Lock (z.B. SL-Lock), damit
 * nicht gleichzeitig ein anderer Prozess (Cleanup) swappt.
 *
 * @returns siehe ensureSolBalance() — { topupNeeded, reachedTarget, solBefore, solAfter, swaps, error? }
 */
export async function ensureWalletSol(db, keypair, connection, { minSol, targetSol, log = () => {} }) {
    const candidates = [
        { mint: USDC_MINT, decimals: USDC_DECIMALS, symbol: 'USDC' },
        ...getRelevantTokens(config.pools.all),
    ];

    const getTokenPrice = (mint) => (mint === USDC_MINT ? 1 : (getTokenUsdPrice(mint, db) || 0));

    return ensureSolBalance({
        minSol,
        targetSol,
        candidates,
        // 🔒 Der Logger MUSS durchgereicht werden: ensureSolBalance() erklärt genau hier,
        // warum ein Topup nichts bewirkt hat ("kein Preis verfügbar", "unter Mindest-Swap
        // … übersprungen", "Ziel nicht erreicht"). Fehlt er, greift dort der Default-No-Op
        // und im Journal ist nur noch der Erfolgsfall sichtbar — dann sieht ein
        // ausbleibender Topup exakt so aus wie eine tote Selbstheilung (Vorfall
        // forge-pub1 2026-08-13: 15 h scheinbar wirkungslos, tatsächlich schlicht 0 USDC
        // im Wallet; die Diagnosezeile dazu wurde verschluckt).
        log,
        getSolBalance: () => getSolBalanceFresh(keypair.publicKey),
        getTokenBalance: (mint, decimals) =>
            getTokenBalanceFresh(keypair.publicKey, new PublicKey(mint), decimals),
        getSolPrice: () => loadSolPrice(db),
        getTokenPrice,
        slippageBufferPct: TOPUP_SLIPPAGE_BPS / 10000,
        // Unter der harten Reserve greift eine niedrigere Mindest-Swap-Schwelle:
        // dort ist der Bot ohnehin handlungsunfähig, ein kleiner Restbetrag in SOL
        // ist mehr wert als derselbe Betrag als unantastbares USDC (siehe
        // ensureSolBalance()). Über der Reserve bleibt es bei den 0,5 USDC.
        criticalSol: config.solReserve,
        swap: async ({ token, amount }) => {
            const { amountOut, txSignature } = await swapTokens({
                inputMint:     token.mint,
                outputMint:    WSOL_MINT,
                inputDecimals: token.decimals,
                outputDecimals: SOL_DECIMALS,
                amount,
                wallet:        keypair,
                connection,
                apiKey:        null,
                slippageBps:   TOPUP_SLIPPAGE_BPS,
            });
            const swapFee  = await getTxFee(txSignature).catch(() => null);
            const price    = getTokenPrice(token.mint);
            const usdValue = price > 0 ? amount * price : null;
            // usd_value_in/out (LIQ#0376 Teil 2): dieselben Preis-Reads, die usdValue
            // (Eingang) schon nutzt, plus SOL-Preis aus derselben Snapshot-Quelle für die
            // Ausgabeseite — kein Vor-/Nach-Swap-Vergleich.
            const solPrice    = loadSolPrice(db);
            const usdValueOut = solPrice > 0 ? amountOut * solPrice : null;
            insertTransaction(db, {
                poolId:   null,
                type:     'swap',
                amountA:  amount,
                amountB:  amountOut,
                usdValue,
                usdValueIn:  usdValue,
                usdValueOut: usdValueOut,
                txHash:   txSignature,
                txFeeSol: swapFee,
                note:     `sol-topup ${token.symbol}→SOL`,
            });
        },
    });
}

// ─── Ausstiegs-Vorsicherung ──────────────────────────────────────────────────

/**
 * Wunschstand vor einem Ausstieg — darunter wird nachgetankt (aber nie blockiert).
 * Bewusst aus config.solReserve abgeleitet statt fest verdrahtet: die Reserve ist
 * pro Instanz über .env SOL_RESERVE konfigurierbar (Master steht z.B. auf 0,11,
 * nicht auf dem Default 0,10). Ein fester Wert würde bei jeder Abweichung wieder
 * auseinanderlaufen — genau die Sorte Lücke, die diesen Bug verursacht hat.
 */
export const EXIT_SOL_COMFORT = config.solReserve;

/**
 * Ziel-Puffer OBERHALB der Reserve, den jedes Auffüllen anstrebt — an einer
 * Stelle definiert und von allen vier Topup-Aufrufern importiert (hier,
 * bin/cleanup.js, lib/score-limit.js, bin/bot.js), statt vier leicht
 * unterschiedliche Kopien zu pflegen (Zustand vor 2026-07-29: 0,05/0,10/0,15 je
 * nach Stelle — genau die Art Streuung, die zu Inkonsistenzen führt).
 *
 * Erhöht von 0,05 auf 0,15 (Entscheidung 2026-07-29, Befund: reale Ausschläge
 * bei SOL-Pair-Pools liegen bei einem einzelnen Rebalancing/Open/Close oft schon
 * bei 0,05–0,11 SOL — ein Ziel von Reserve+0,05 war nach einem einzigen solchen
 * Vorgang bereits wieder unter der Reserve. Reserve+0,15 verkraftet ~2 typische
 * Ausschläge, bevor erneut aufgefüllt werden muss.
 *
 * Auf 0,09 zurückgenommen (2026-07-30): Der Wert von 0,15 war nur die halbe
 * Wahrheit. Der Überschuss-Verkauf in cleanup.js baute SOL bis auf
 * `solReserve + SOL_TX_FEE_BUFFER` (~0,115) ab, während das Topup auf 0,26 zielte.
 * Beide Richtungen zielten also auf verschiedene Werte. Folge bei JEDEM SOL-Zufluss
 * (Schließen einer SOL-Pair-Position, Withdraw): erst Abbau auf ~0,115, im nächsten
 * Lauf Rückkauf auf 0,26 — ein vollständiger Rundlauf mit Fees und Slippage, der
 * nichts bewirkt. In wallet-monitor.db über Tage sichtbar (24.07. 0,110→0,273,
 * 26.07. 0,131→0,283, 28.07. 0,110→0,250). Zusätzlich lag das Tal bei ~0,115 unter
 * der 0,12-Warnschwelle des wallet-monitor und löste jedes Mal einen
 * „SOL-Reserve niedrig"-Alert aus.
 *
 * Seit 2026-07-30 ist SOL_TOPUP_TARGET die EINE Zahl, die beide Richtungen bestimmt
 * (auffüllen BIS, abbauen AUF) — siehe cleanup.js. Reserve+0,09 = 0,20 hält damit
 * Abstand zur Warnschwelle, ohne unnötig Kapital zu binden.
 */
export const SOL_TOPUP_BUFFER = 0.09;

/**
 * Der SOL-Sollstand des Wallets — die eine Zahl, die BEIDE Richtungen bestimmt:
 * das Auffüllen zielt darauf (Exit, Invest, Cleanup, Zyklus-Self-Heal) UND der
 * Überschuss-Verkauf in cleanup.js baut nur bis hierher ab, nicht tiefer.
 *
 * 🔒 Genau diese Symmetrie ist der Punkt: Solange „auffüllen bis X" und
 * „abbauen auf Y" verschiedene Zahlen waren (X=0,26 / Y≈0,115), pendelte das
 * Wallet zwischen beiden und kaufte/verkaufte dasselbe SOL im Kreis. Wer eine
 * der beiden Richtungen ändert, muss die andere mitziehen — deshalb dieselbe
 * Konstante statt zweier „passender" Werte.
 */
export const SOL_TOPUP_TARGET = config.solReserve + SOL_TOPUP_BUFFER;

/** Exit-seitiger Name für dasselbe Ziel (Aufrufer in den Ausstiegspfaden). */
export const EXIT_SOL_TARGET  = SOL_TOPUP_TARGET;

/**
 * Stellt vor einem Ausstieg so viel SOL wie möglich bereit — **ohne den Ausstieg
 * jemals zu blockieren**.
 *
 * 🔒 Kernregel (Entscheidung 2026-07-29, siehe assertSufficientSolForExit() in
 * wallet.js): Ein Ausstieg darf nicht daran scheitern, dass zu wenig SOL da ist.
 * Genau dafür existiert die 0,1-SOL-Reserve. Ein fehlgeschlagenes Topup ist deshalb
 * KEIN Abbruchgrund — es senkt nur den Komfort, nicht die Machbarkeit. Abgebrochen
 * wird einzig unterhalb von SOL_EXIT_FLOOR, wo die Transaktion physisch nicht landet.
 *
 * Rückgabe:
 *   ok    – false nur unter SOL_EXIT_FLOOR (Ausstieg wirklich unmöglich)
 *   tight – true wenn EXIT_SOL_COMFORT nicht erreicht wurde. Der Aufrufer sollte dann
 *           optionale, SOL-kostende Nebenschritte weglassen (v.a. den Fee-Claim) und
 *           direkt schließen.
 *
 * Voraussetzung: Aufrufer hält den SL-Lock (wie ensureWalletSol).
 *
 * @returns {Promise<{ok: boolean, tight: boolean, sol: number, toppedUp: boolean}>}
 */
export async function ensureExitCapableSol(db, keypair, connection, { log = () => {} } = {}) {
    const solBefore = await getSolBalanceFresh(keypair.publicKey);
    if (solBefore >= EXIT_SOL_COMFORT) {
        return { ok: true, tight: false, sol: solBefore, toppedUp: false };
    }

    log(`SOL ${solBefore.toFixed(4)} < ${EXIT_SOL_COMFORT} – Self-Heal-Topup (Ziel ${EXIT_SOL_TARGET} SOL)`);

    let solAfter = solBefore;
    try {
        const heal = await ensureWalletSol(db, keypair, connection, {
            minSol: EXIT_SOL_COMFORT, targetSol: EXIT_SOL_TARGET, log,
        });
        solAfter = Number.isFinite(heal?.solAfter) ? heal.solAfter : solBefore;
    } catch (err) {
        // Topup-Fehler (kein Swap-Partner, Jupiter down, Slippage): nicht fatal.
        log(`Topup fehlgeschlagen (${err.message}) – Ausstieg läuft trotzdem weiter`);
        solAfter = await getSolBalanceFresh(keypair.publicKey).catch(() => solBefore);
    }

    if (solAfter >= EXIT_SOL_COMFORT) {
        log(`SOL nach Topup: ${solAfter.toFixed(4)} SOL`);
        return { ok: true, tight: false, sol: solAfter, toppedUp: solAfter > solBefore };
    }

    const ok = solAfter >= SOL_EXIT_FLOOR;
    log(ok
        ? `SOL knapp (${solAfter.toFixed(4)}) – Ausstieg wird trotzdem durchgeführt, Nebenschritte entfallen`
        : `SOL ${solAfter.toFixed(5)} unter dem physikalischen Boden ${SOL_EXIT_FLOOR} – Ausstieg nicht möglich`);
    return { ok, tight: true, sol: solAfter, toppedUp: solAfter > solBefore };
}

// ─── Invest-Vorsicherung ─────────────────────────────────────────────────────

/**
 * „Unsichtbarer" Puffer OBERHALB der Reserve, ab dem VOR einer kapitalbindenden
 * Aktion (Öffnen, Reinvest, Cross-Swap, Cleanup-Invest) nachgetankt wird.
 *
 * Hintergrund (Entscheidung 2026-07-30): Die harte Grenze bleibt config.solReserve —
 * blockiert wird weiterhin erst darunter. Das Problem war nie die Höhe der Grenze,
 * sondern der Zeitpunkt der Prüfung: Eine Öffnung ist eine mehrstufige Sequenz
 * (Pre-Swap → ggf. ATA-Rent → openPosition). Der Vorab-Check konnte bei 0,105 SOL
 * sauber durchgehen, danach fraßen Pre-Swap und Fees den Rest, und mitten in der
 * Sequenz schlug assertSufficientSol() zu — das wirft (Fehler-Notification, nach
 * 3 Fehlschlägen Pool-Deaktivierung durch openPositionGaveUp()), statt sauber zu
 * überspringen. Genau diese Race dokumentiert auch bin/deposit.js (_autoTopUpSol):
 * „SOL zwischen Upfront-Check und der eigentlichen TX-Ausführung … unter die Reserve".
 *
 * Mit dem Puffer startet die Sequenz nie so knapp, dass sie sich selbst unter die
 * Reserve fressen kann. Kosten: ~0,05 SOL zusätzlich gebundenes Kapital (≈ 3,70 USDC)
 * — gegen den Opportunitätsverlust eines automatisch deaktivierten Pools.
 */
export const INVEST_SOL_BUFFER  = 0.05;

/** Schwelle, ab der vor dem Investieren nachgetankt wird (NICHT die Blockier-Grenze). */
export const INVEST_SOL_COMFORT = config.solReserve + INVEST_SOL_BUFFER;

/**
 * Stellt vor einer kapitalbindenden Aktion so viel SOL wie möglich bereit.
 *
 * 🔒 Kernregel: Der Puffer ist eine TOPUP-Schwelle, keine Blockier-Schwelle.
 * `ok` misst gegen config.solReserve (die harte Grenze), NICHT gegen
 * INVEST_SOL_COMFORT. Ein gescheitertes Topup verhindert das Investieren also
 * nur dann, wenn die Reserve wirklich unterschritten ist. Andernfalls würde ein
 * Wallet mit 0,11 SOL und mehreren tausend USDC stillstehen, obwohl der Engpass
 * mit einem Swap über wenige USDC behoben wäre.
 *
 * Voraussetzung: Aufrufer koordiniert die Locks (wie ensureWalletSol).
 *
 * @returns {Promise<{ok: boolean, sol: number, toppedUp: boolean}>}
 */
export async function ensureInvestCapableSol(db, keypair, connection, { log = () => {} } = {}) {
    const solBefore = await getSolBalanceFresh(keypair.publicKey);
    if (solBefore >= INVEST_SOL_COMFORT) {
        return { ok: true, sol: solBefore, toppedUp: false };
    }

    log(`SOL ${solBefore.toFixed(4)} < ${INVEST_SOL_COMFORT.toFixed(4)} (Invest-Puffer) – Topup-Versuch (Ziel ${SOL_TOPUP_TARGET.toFixed(4)} SOL)`);

    let solAfter = solBefore;
    try {
        const heal = await ensureWalletSol(db, keypair, connection, {
            minSol: INVEST_SOL_COMFORT, targetSol: SOL_TOPUP_TARGET, log,
        });
        solAfter = Number.isFinite(heal?.solAfter) ? heal.solAfter : solBefore;
    } catch (err) {
        // Topup-Fehler (kein Swap-Partner, Jupiter down, Slippage): nicht fatal —
        // unterhalb der harten Reserve bricht der Aufrufer ohnehin sauber ab.
        log(`Topup fehlgeschlagen (${err.message}) – harte Reserve entscheidet`);
        solAfter = await getSolBalanceFresh(keypair.publicKey).catch(() => solBefore);
    }

    return { ok: solAfter >= config.solReserve, sol: solAfter, toppedUp: solAfter > solBefore };
}
