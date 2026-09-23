import { PublicKey }  from '@solana/web3.js';
import { Percentage } from '@orca-so/common-sdk';
import {
    getUsableSolBalance, getUsableSolBalanceFresh, getTokenBalance, getTokenBalanceFresh,
    getUsableUsdcBalanceFresh, getTxFee, getConnection, USDC_MINT,
} from './wallet.js';
import { swapTokens, isWhirlpoolMintOrderError } from './swap.js';
import {
    getOpenPosition,
    updatePositionCapital, updatePositionHodl, insertTransaction,
    insertPosition, insertPositionSnapshot, insertCapitalFlow, clearPositionSnapshots,
    addPositionEntryCost,
} from './db.js';
import { establishPositionBaseline, settleCapitalFlow, getQuotePriceUsd } from './refresh-state.js';
import { isRebalancePending } from './cleanup-lock.js';
import { config, setPoolActive } from './config.js';
import { ensureTvlProtectionDefaults, ensureTrailingStopMinimumReset,
         ensureTrailingStopDefaults } from './settings-auto.js';
import { calculateRange } from './range.js';
import { PoolUtil, PriceMath } from '@orca-so/whirlpools-sdk';
import Decimal from 'decimal.js';
import BN     from 'bn.js';
import * as notify from './notify.js';
import { t }       from '../../../lib/i18n.js';
import { foreignExitBlock } from './exit-reservation.js';

// ─── Konstanten ───────────────────────────────────────────────────────────────

export const DEPOSIT_SLIPPAGE = Percentage.fromFraction(1, 200); // 0.5 %
export const SLIPPAGE_FACTOR  = 1.005;                           // muss mit DEPOSIT_SLIPPAGE übereinstimmen

const WSOL_MINT            = 'So11111111111111111111111111111111111111112';
const CBTC_MINT            = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
const SOL_TX_FEE_BUFFER    = 0.005;
const MIN_USDC_AMOUNT      = 1.0;
export const PRESWAP_SLIPPAGE_BPS = 150; // höherer Slippage für Cleanup-Swaps (cbBTC/EURC illiquid)

// ─── Gemeinsame Hilfsfunktionen ───────────────────────────────────────────────

/**
 * Zuletzt gemessener Positionswert eines Pools (letzter position_snapshots-Eintrag) — nur noch
 * der **Fallback** für `settleCapitalFlow()`, wenn die Ist-Werte einer Einzahlung nicht aus der
 * Transaktion lesbar sind. Im Normalfall zieht der Liquiditätsfaktor die Referenz nach.
 */
function _lastMeasuredLpValue(db, poolId) {
    return db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).get(poolId)?.lp_value_usd ?? 0;
}

/**
 * CLMM sqrt-Preis-Arithmetik: schätzt tokenA-Bedarf für depositB tokenB in der Range.
 * Spiegelbild der Uniswap-V3-Formel (Orca Whirlpools).
 */
export function clmmTokenAForDeposit(depositB, currentPrice, priceLower, priceUpper) {
    if (priceLower == null || priceUpper == null) return depositB / currentPrice;
    if (currentPrice <= priceLower) return depositB / currentPrice;
    if (currentPrice >= priceUpper) return 0;
    const sqrtP  = Math.sqrt(currentPrice);
    const sqrtPa = Math.sqrt(priceLower);
    const sqrtPb = Math.sqrt(priceUpper);
    const ratioUsdcPerA = (sqrtP - sqrtPa) * sqrtP * sqrtPb / (sqrtPb - sqrtP);
    return depositB / ratioUsdcPerA;
}

/**
 * Zielkapital (USD) für einen Reopen — die Zahl, auf die sich Pre-Swap UND openPosition
 * beziehen müssen.
 *
 * 🔒 LIQ#0344: Rechnen die beiden Schritte auf verschiedene Zielbeträge, kauft der
 * Pre-Swap Token für Kapital, das die Position anschließend nicht annimmt; der
 * Überschuss bleibt als volatiler Rest im Wallet liegen und wird 24 h später von der
 * Dust-Notbremse wieder verkauft. Am 29.08.2026 bei ZEC/USDC: Pre-Swap 272,12 USDC → ZEC
 * (50/50 von 544 USDC Vorposition), die Position nahm nach der Kappung auf
 * CLEANUP_MAX_DEPOSIT = 200 USDC aber nur ~97 USDC ZEC — ~175 USDC blieben liegen.
 * Deshalb ist die Reihenfolge hier EINMAL festgelegt und wird von beiden Aufrufern
 * benutzt, statt an zwei Stellen gepflegt zu werden.
 *
 * Reihenfolge der Deckel:
 *   1. freigesetztes Kapital (Rebalance) hat Vorrang vor der Historie
 *   2. Kleinstpositions-Netz: war die Vorposition < minReopenCapitalUsd und die
 *      Quote-Seite hat mehr, gilt die Quote-Seite (LIQ#0341)
 *   3. nie mehr als real im Wallet verfügbar ist
 *   4. nie mehr als die Max-Einzahlung pro Aktion (Ausnahme: Reopen kurz nach einem
 *      Close stellt bestehendes Kapital wieder her, kein frischer Zufluss)
 *
 * @returns {number} Zielkapital in USD (0 = nichts zu tun)
 */
export function reopenTargetCapitalUsd({
    targetCapitalUsd       = null,
    lastPositionCapitalUsd = null,
    quoteSideUsd           = 0,
    walletTotalUsd         = 0,
    maxDepositUsd          = 0,
    isPreservationReopen   = false,
    minReopenCapitalUsd    = 5.0,
}) {
    let capital;
    if (targetCapitalUsd != null && targetCapitalUsd > 0) {
        capital = targetCapitalUsd;
    } else {
        const hist = lastPositionCapitalUsd ?? quoteSideUsd;
        capital = (hist < minReopenCapitalUsd && quoteSideUsd > hist)
            ? quoteSideUsd
            : Math.min(hist, walletTotalUsd);
    }
    if (maxDepositUsd > 0 && !isPreservationReopen) capital = Math.min(capital, maxDepositUsd);
    return Math.max(0, capital);
}

/**
 * Ausgleichsplan für ein volatilePair-Wallet: welche Seite muss wie viel abgeben, damit
 * beide Token gleich viel USD wert sind? Ein 50/50-Mix ist die Voraussetzung dafür, dass
 * `openPosition` überhaupt beide Seiten befüllen kann.
 *
 * 🔒 LIQ#0393: Der Soll-Mix bemisst sich am **deploybaren** Kapital
 * (`min(Zielkapital, Wallet-Gesamtwert)`), nicht am vollen Zielkapital. Liegt weniger im
 * Wallet als das Ziel (Teilbefüllung, Score-Limit-Rückfluss, Kursverfall seit dem Close),
 * öffnen beide Aufrufer in `bin/bot.js` ohnehin eine proportional kleinere Position — sie
 * deckeln `amountA`/`amountB` auf den realen Wallet-Bestand. Gegen das VOLLE Ziel gerechnet
 * lagen dann aber beide Seiten unter 100 %, und `max(0, bal - targetToken)` kappte den
 * Überschuss auf 0, obwohl die reichere Seite sehr wohl etwas abzugeben hatte. Der Aufrufer
 * las das als Fehlschlag und deaktivierte den Pool nach 3 Versuchen (ZEC/SOL, 04.09.2026:
 * beide Seiten bei 39–40 % des Ziels, zueinander also praktisch perfekt balanciert).
 *
 * Ist das Wallet größer als das Ziel, bleibt `targetUsdc` die Bemessungsgrundlage —
 * Überschusskapital soll nicht zusätzlich in diesen Pool fließen.
 *
 * @returns {{action:'balanced'|'swap'|'dust', inSide:('A'|'B'|null), inAmount:number,
 *            ratioA:number, ratioB:number, deployableUsd:number}}
 *          `balanced` = nichts zu tun · `swap` = `inAmount` von `inSide` tauschen ·
 *          `dust` = Ausgleich nötig, aber unterhalb der kleinsten sinnvollen Swap-Größe.
 */
export function pairBalanceSwapPlan({
    tokenABal, tokenBBal,
    usdPerA, usdPerB,
    targetUsdc,
    decimalsA, decimalsB,
    tokenAIsSol = false,
    tokenBIsSol = false,
    solReserve  = 0.15,
    imbalanceThreshold = 0.5,
}) {
    const totalWalletUsd = tokenABal * usdPerA + tokenBBal * usdPerB;
    // targetUsdc = 0 heißt „kein Ziel bekannt" (echter Erststart): dann ist das ganze
    // Wallet die Bemessungsgrundlage. Ohne diesen Zweig wären beide Ziel-Token 0, die
    // Ratios würden auf 1 normalisiert und ein einseitiges Wallet bliebe unausgeglichen.
    const deployableUsd = targetUsdc > 0 ? Math.min(targetUsdc, totalWalletUsd) : totalWalletUsd;
    const halfTarget    = deployableUsd / 2;
    const targetAToken  = usdPerA > 0 ? halfTarget / usdPerA : 0;
    const targetBToken  = usdPerB > 0 ? halfTarget / usdPerB : 0;

    const ratioA = targetAToken > 0 ? tokenABal / targetAToken : 1;
    const ratioB = targetBToken > 0 ? tokenBBal / targetBToken : 1;
    const base   = { ratioA, ratioB, deployableUsd };

    if (ratioA >= imbalanceThreshold && ratioB >= imbalanceThreshold) {
        return { action: 'balanced', inSide: null, inAmount: 0, ...base };
    }

    // Die reichere Seite gibt ab. 99 % des Überschusses als Slippage-Puffer; bei SOL
    // zusätzlich die Gebühren-Reserve stehen lassen.
    const richerIsA = ratioA > ratioB;
    const bal       = richerIsA ? tokenABal : tokenBBal;
    const targetTok = richerIsA ? targetAToken : targetBToken;
    const isSol     = richerIsA ? tokenAIsSol : tokenBIsSol;
    const inDec     = richerIsA ? decimalsA : decimalsB;
    const cap       = isSol ? Math.max(0, bal - solReserve) : bal * 0.99;
    const inAmount  = Math.min(Math.max(0, bal - targetTok) * 0.99, cap);

    if (inAmount < 100 / Math.pow(10, inDec)) {
        return { action: 'dust', inSide: richerIsA ? 'A' : 'B', inAmount, ...base };
    }
    return { action: 'swap', inSide: richerIsA ? 'A' : 'B', inAmount, ...base };
}

/**
 * Prüft ob das CLMM-Ratio für automatische Deposits günstig genug ist.
 * Bei Ratio > 80/20 würde ein 50/50-Pre-Swap einen großen Teil des Kapitals
 * undeployed lassen, weil Orca nur den tatsächlich benötigten Anteil nimmt.
 * Gibt { ok, pctA, pctB } zurück.
 */
export const CLMM_RATIO_MAX_PCT = 80;

export function checkClmmRatio(currentPrice, priceLower, priceUpper) {
    const tokenAPerUnitB = clmmTokenAForDeposit(1, currentPrice, priceLower, priceUpper);
    const valueA         = tokenAPerUnitB * currentPrice;
    const pctA           = Math.round(valueA / (valueA + 1) * 100);
    const pctB           = 100 - pctA;
    return { ok: pctA <= CLMM_RATIO_MAX_PCT && pctB <= CLMM_RATIO_MAX_PCT, pctA, pctB };
}

/**
 * Berechnet den USDC-Wert der deponierten Token-Mengen.
 *   usdcIsTokenA: tokenEstA + tokenEstB / price  (z.B. USDC + EURC / (EURC/USDC))
 *   volatilePair: (a + b/price) * quotePrice  (Quote=tokenA)
 *                 (a*price + b) * quotePrice  (Quote=tokenB)
 *   Standard:     tokenEstA * price + tokenEstB  (z.B. SOL * USDC/SOL + USDC)
 */
export function calcDepositedUsdc(tokenEstA, tokenEstB, price, pool, btcPrice = 0, quotePrice = 0) {
    if (pool.usdcIsTokenA)   return tokenEstA + tokenEstB / price;
    if (pool.volatilePair) {
        const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
        if (quoteIsTokenA) return (tokenEstA + (price > 0 ? tokenEstB / price : 0)) * quotePrice;
        return (tokenEstA * price + tokenEstB) * quotePrice;
    }
    return tokenEstA * price + tokenEstB;
}

/**
 * USD-Preis eines Token-Mints aus pool_stats.
 * Priorität: 1. direkter USDC-Pool  2. inverser USDC-Pool  3. BTC-Peg-Fallback (WBTC)
 */
export function getTokenUsdPrice(mint, db) {
    const direct = db.prepare(`
        SELECT ps.price FROM pool_stats ps
        JOIN pools p ON ps.pool_id = p.id
        WHERE p.token_a = ? AND p.token_b = ?
        ORDER BY ps.recorded_at DESC LIMIT 1
    `).get(mint, USDC_MINT);
    if (direct) return direct.price;

    const inverse = db.prepare(`
        SELECT ps.price FROM pool_stats ps
        JOIN pools p ON ps.pool_id = p.id
        WHERE p.token_a = ? AND p.token_b = ?
        ORDER BY ps.recorded_at DESC LIMIT 1
    `).get(USDC_MINT, mint);
    if (inverse?.price > 0) return 1 / inverse.price;

    const btcUsd = db.prepare(
        `SELECT price FROM pool_stats WHERE pool_id = 'liq-btc-usdc' ORDER BY recorded_at DESC LIMIT 1`
    ).get();
    const ratio = db.prepare(`
        SELECT ps.price FROM pool_stats ps
        JOIN pools p ON ps.pool_id = p.id
        WHERE p.token_a = ? AND p.token_b = ?
        ORDER BY ps.recorded_at DESC LIMIT 1
    `).get(CBTC_MINT, mint);
    if (btcUsd?.price > 0 && ratio?.price > 0) return btcUsd.price / ratio.price;

    // 4. SOL-Bridge: Token paired mit SOL (z.B. HYPE/SOL → HYPE_USD = SOL_USD / poolPrice)
    const solUsd = db.prepare(
        `SELECT price FROM pool_stats WHERE pool_id = 'liq-sol-usdc' ORDER BY recorded_at DESC LIMIT 1`
    ).get();
    if (solUsd?.price > 0) {
        // tokenA=SOL, tokenB=target: 1 SOL = price target → 1 target = SOL_USD / price
        const viaSolA = db.prepare(`
            SELECT ps.price FROM pool_stats ps
            JOIN pools p ON ps.pool_id = p.id
            WHERE p.token_a = ? AND p.token_b = ?
            ORDER BY ps.recorded_at DESC LIMIT 1
        `).get(WSOL_MINT, mint);
        if (viaSolA?.price > 0) return solUsd.price / viaSolA.price;

        // tokenA=target, tokenB=SOL: 1 target = price SOL → 1 target = price × SOL_USD
        const viaSolB = db.prepare(`
            SELECT ps.price FROM pool_stats ps
            JOIN pools p ON ps.pool_id = p.id
            WHERE p.token_a = ? AND p.token_b = ?
            ORDER BY ps.recorded_at DESC LIMIT 1
        `).get(mint, WSOL_MINT);
        if (viaSolB?.price > 0) return viaSolB.price * solUsd.price;
    }

    return 0;
}


// ─── Rest-Einzahlung („Residual-Sweep") ───────────────────────────────────────
//
// Nach jedem Deposit bleibt etwas im Wallet liegen: Orca nimmt nur die bindende Seite
// (min(quoteA, quoteB)), die Slippage-Puffer laufen konservativ und zwischen Pre-Swap und
// Einzahlung bewegt sich der Preis. Bei volatilen Tokens sind das Prozente, nicht Promille
// (ZEC/USDC am 22.08.2026: ~33 von 250 USDC blieben liegen). Liegenbleiben ist doppelt teuer,
// weil der Dust-Sweep in bin/cleanup.js Reste unter CLEANUP_DUST_MAX_USDC wieder zurück nach
// USDC tauscht — der Token wurde also gekauft und direkt wieder verkauft.
//
// Deshalb nachfassen: Reste frisch lesen, auf das noch offene Budget kappen, einen
// einseitigen Rest per kleinem Swap nach dem CLMM-Ratio der echten Range ausgleichen, dann
// ein weiteres increaseLiquidity — und das wiederholen, bis wirklich nichts Nennenswertes
// mehr übrig ist (siehe RESIDUAL_SWEEP_MAX_ROUNDS unten). Ein einzelner Durchlauf lässt
// zuverlässig einen Rest zweiter Ordnung übrig, weil der Ausgleichs-Swap selbst wieder
// Slippage hat. Genutzt vom manuellen Pfad (bin/deposit.js) und von allen automatischen
// Pfaden hier — eine Implementierung, damit beide nicht auseinanderlaufen.

const RESIDUAL_MIN_USDC      = 1.00;   // darunter lohnt die zusätzliche TX nicht
const RESIDUAL_SWAP_MIN_USDC = 1.00;   // darunter lohnt der Ausgleichs-Swap nicht
const RESIDUAL_SOL_BUFFER    = 0.005;  // SOL-Puffer über solReserve hinaus (TX-Fee)

/** USD-Wert je 1 Token der beiden Pool-Seiten — Spiegel von calcDepositedUsdc(). */
function _usdPerSide(pool, currentPrice, quotePrice) {
    if (pool.volatilePair) {
        const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
        return quoteIsTokenA
            ? { a: quotePrice, b: currentPrice > 0 ? quotePrice / currentPrice : 0 }
            : { a: quotePrice * currentPrice, b: quotePrice };
    }
    if (pool.usdcIsTokenA) return { a: 1, b: currentPrice > 0 ? 1 / currentPrice : 0 };
    return { a: currentPrice, b: 1 };
}

/** Frische Wallet-Bestände beider Pool-Seiten (SOL- und Premium-Reserve bereits abgezogen). */
async function _freshSideBalances(pool, keypair) {
    const read = async (mint, decimals) => {
        if (mint === WSOL_MINT) {
            return Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey) - RESIDUAL_SOL_BUFFER);
        }
        if (mint === USDC_MINT) return getUsableUsdcBalanceFresh(keypair.publicKey);
        return getTokenBalanceFresh(keypair.publicKey, new PublicKey(mint), decimals);
    };
    return {
        a: await read(pool.tokenA, pool.decimalsA),
        b: await read(pool.tokenB, pool.decimalsB),
    };
}

// Ein einzelner Ausgleichs-Swap + increaseLiquidity gleicht die eigene Ausführung nicht
// wieder aus (der Swap selbst hat wieder Slippage, die Ziel-Range-Rechnung nutzt den
// zu Rundenbeginn gemessenen Preis) — ein Einzelversuch lässt deshalb regelmäßig einen
// Rest zweiter Ordnung übrig (PUMP/SOL, 23.08.2026: 34,80 von ~46 USDC Rest nachgezahlt,
// 13,86 USDC blieben als Dust liegen). `sweepResidualIntoPosition` wiederholt den Vorgang
// deshalb, bis der verbleibende Rest unter RESIDUAL_MIN_USDC fällt oder keine Runde mehr
// Fortschritt bringt — Ziel ist ein Rest von faktisch null, nicht nur „meistens klein".
const RESIDUAL_SWEEP_MAX_ROUNDS = 4;

/**
 * Plant eine Sweep-Runde: Wie viel von jeder Seite soll eingezahlt werden, und welcher
 * Ausgleichs-Swap ist dafür nötig? Rein rechnend, ohne Chain-Zugriff — damit genau diese
 * Aufteilung testbar ist (`bin/test-residual-sweep.js`).
 *
 * Die Zielaufteilung kommt aus dem CLMM-Ratio der echten Range: ohne sie könnte nur so
 * viel eingezahlt werden, wie die knappere Seite hergibt.
 *
 * 🔒 LIQ#0343 — die Zielmengen sind ABSOLUT aus dem Budget gerechnet, nie als Anteil des
 * Wallets. Früher wurde das ganze Wallet mit `budget / walletUsd` skaliert. Der
 * Ausgleichs-Swap tauscht aber physisch im ganzen Wallet, und die erneute anteilige
 * Kappung danach ließ nur diesen Bruchteil des frisch gekauften Tokens in die Position
 * wandern. Liegt viel Fremdkapital im Wallet, ist der Bruchteil winzig: NATIX/USDC am
 * 29.08.2026 (Budget 250 USDC, Wallet ~1.700 USDC) kaufte über vier Runden NATIX für
 * ~388 USDC, zahlte 198,65 USDC ein und ließ 297,76 USDC als volatilen Token liegen —
 * gekauft, um ihn 24 h später über die Dust-Notbremse wieder zu verkaufen.
 *
 * Höchstens eine Seite kann fehlen: die Zielwerte summieren sich auf `budgetUsdc`, und
 * `budgetUsdc <= walletUsd`. Der Überschuss der anderen Seite deckt das Defizit deshalb
 * immer ab. Bewusst ohne Slippage-Puffer: fällt der Swap minimal zu knapp aus, bleibt der
 * Rest auf der Seite liegen, aus der getauscht wurde (im Regelfall die USDC-nahe) statt
 * als volatiler Token — und die nächste Runde zahlt ihn ohnehin nach.
 *
 * @param {{a:number,b:number}} bal        Wallet-Bestand je Seite (Token-Einheiten)
 * @param {{a:number,b:number}} usd        USD-Wert je 1 Token der Seite
 * @param {number} budgetUsdc              Was in dieser Runde eingesetzt werden soll
 * @param {number} aPerB                   tokenA je 1 tokenB laut CLMM-Ratio der Range
 * @returns {{needAUsd, needBUsd, weightA, swap: {fromA, valueUsd, amountIn}|null}}
 */
export function planResidualSweep({ bal, usd, budgetUsdc, aPerB }) {
    const weightA  = (aPerB * usd.a) / (aPerB * usd.a + usd.b);
    const needAUsd = budgetUsdc * weightA;
    const needBUsd = budgetUsdc - needAUsd;

    const gapAUsd = needAUsd - bal.a * usd.a;   // > 0: tokenA fehlt
    const gapBUsd = needBUsd - bal.b * usd.b;   // > 0: tokenB fehlt
    const valueUsd = Math.max(gapAUsd, gapBUsd);
    if (valueUsd < RESIDUAL_SWAP_MIN_USDC) return { needAUsd, needBUsd, weightA, swap: null };

    const fromA    = gapBUsd > gapAUsd;         // tokenB fehlt → aus tokenA nachkaufen
    const amountIn = fromA
        ? Math.min(valueUsd / usd.a, bal.a * 0.99)
        : Math.min(valueUsd / usd.b, bal.b * 0.99);
    return { needAUsd, needBUsd, weightA, swap: { fromA, valueUsd, amountIn } };
}

/** Summe zweier Liquiditäts-Strings (u128 als Dezimalstring); bei Unlesbarem der jüngere Wert. */
export function sumLiquidityAdded(a, b) {
    try {
        if (a == null || b == null) return b ?? a;
        return (BigInt(String(a)) + BigInt(String(b))).toString();
    } catch {
        return b;
    }
}

/**
 * Zahlt den nach einem Deposit im Wallet verbliebenen Rest in dieselbe Position nach.
 * Wirft nie — die Haupteinzahlung ist beim Aufruf bereits erfolgt; scheitert der Sweep,
 * bleibt der Rest schlicht liegen und der nächste Cleanup-Lauf verwertet ihn.
 *
 * @param {object} pool
 * @param {string} nftMint                 Position, in die nachgezahlt wird
 * @param {number} opts.currentPrice       Pool-Preis (tokenB je tokenA)
 * @param {number} opts.priceLower/Upper   Range-Grenzen der Position
 * @param {number} opts.budgetLeftUsdc     Noch offener Teil des vorgesehenen Budgets
 *                                         (Infinity = alles, was im Wallet liegt)
 * @param {number} opts.quotePrice         USD-Preis des Quote-Tokens (nur volatilePair)
 * @param {number} opts.swapSlippageBps    Slippage für den Ausgleichs-Swap (null = Default)
 * @returns {Promise<{txHash, tokenEstA, tokenEstB, usdc, addedLiquidity}|null>}
 */
export async function sweepResidualIntoPosition(pool, nftMint, opts) {
    let budgetLeft = opts.budgetLeftUsdc ?? Infinity;
    let combined   = null;
    for (let round = 1; round <= RESIDUAL_SWEEP_MAX_ROUNDS; round++) {
        const res = await _sweepResidualOnce(pool, nftMint, { ...opts, budgetLeftUsdc: budgetLeft, round });
        if (!res) break;
        combined = combined
            ? {
                ...res,
                tokenEstA: combined.tokenEstA + res.tokenEstA,
                tokenEstB: combined.tokenEstB + res.tokenEstB,
                usdc:      combined.usdc + res.usdc,
                // Über ALLE Runden summieren (LIQ#000841): settleCapitalFlow() skaliert die
                // Trailing-Stop-Referenz mit der zugefügten Liquidität. Nur die der letzten
                // Runde zu liefern, ließ die Referenz bei mehrrundigem Sweep zu niedrig.
                liquidityAdded: sumLiquidityAdded(combined.liquidityAdded, res.liquidityAdded),
              }
            : res;
        if (Number.isFinite(budgetLeft)) budgetLeft = Math.max(0, budgetLeft - res.usdc);
        // res.usdc < RESIDUAL_MIN_USDC bedeutet: die Runde hat kaum noch etwas bewegt
        // (letzter Krümel oder kein Fortschritt mehr) — weitere Runden würden nur TX-Fees
        // ohne nennenswerten Nutzen kosten.
        if (res.usdc < RESIDUAL_MIN_USDC) break;
    }
    return combined;
}

async function _sweepResidualOnce(pool, nftMint, {
    keypair, db, adapter, currentPrice, priceLower, priceUpper,
    budgetLeftUsdc = Infinity, quotePrice = 0, swapSlippageBps = null,
    logPrefix = '[deposit-lib]', round = 1,
} = {}) {
    const log = (msg) => console.log(`${logPrefix} ${pool.pair}: [Sweep ${round}/${RESIDUAL_SWEEP_MAX_ROUNDS}] ${msg}`);
    try {
        // 🔒 LIQ#0316: gehört tokenA/tokenB gerade zu einem Exit auf einem ANDEREN
        // Pool (geteilter Mint), kein Sweep — sonst würde fremdes Exit-Kapital
        // nachinvestiert.
        const sweepBlock = foreignExitBlock(db, pool, logPrefix);
        if (sweepBlock.blocked) {
            log(`Sweep übersprungen: ${sweepBlock.reason}`);
            return null;
        }

        if (!(budgetLeftUsdc >= RESIDUAL_MIN_USDC)) return null;
        if (!(currentPrice > 0)) return null;

        const usd = _usdPerSide(pool, currentPrice, quotePrice);
        if (!(usd.a > 0) || !(usd.b > 0)) return null;

        const [symA, symB] = pool.usdcIsTokenA
            ? [pool.pair.split('/')[1], pool.pair.split('/')[0]]
            : pool.pair.split('/');

        let bal   = await _freshSideBalances(pool, keypair);
        const walletUsd = bal.a * usd.a + bal.b * usd.b;
        if (walletUsd < RESIDUAL_MIN_USDC) {
            log(t('cli.ld.sweep_skip_small', { usdc: walletUsd.toFixed(2) }));
            return null;
        }

        // Nie mehr nachzahlen als vom vorgesehenen Budget übrig ist — im Wallet kann
        // Kapital liegen, das gar nicht für diese Einzahlung gedacht war.
        const total = Math.min(walletUsd, budgetLeftUsdc);
        if (walletUsd > budgetLeftUsdc) {
            log(t('cli.ld.sweep_budget_capped', { usdc: budgetLeftUsdc.toFixed(2) }));
        }

        // Position muss in Range liegen — sonst nimmt increaseLiquidity nur eine Seite an
        // und der Rest bliebe trotz Extra-TX liegen.
        try {
            const st = await adapter.getPositionState(pool, nftMint);
            if (!st.inRange) {
                log(t('cli.ld.sweep_oor'));
                return null;
            }
        } catch {
            return null;   // Zustand nicht lesbar → lieber nichts tun
        }

        // Einseitigen Rest ausgleichen (Zielaufteilung + Ausgleichs-Swap): siehe
        // planResidualSweep().
        const aPerB = clmmTokenAForDeposit(1, currentPrice, priceLower, priceUpper);
        const plan  = planResidualSweep({ bal, usd, budgetUsdc: total, aPerB });
        const { needAUsd, needBUsd, swap } = plan;

        if (swap) {
            const { fromA, valueUsd: valueIn, amountIn } = swap;
            log(t('cli.ld.sweep_swap', {
                amount: amountIn.toFixed(6), from: fromA ? symA : symB,
                to: fromA ? symB : symA, usdc: valueIn.toFixed(2),
            }));
            try {
                await swapTokens({
                    inputMint:      fromA ? pool.tokenA    : pool.tokenB,
                    outputMint:     fromA ? pool.tokenB    : pool.tokenA,
                    inputDecimals:  fromA ? pool.decimalsA : pool.decimalsB,
                    outputDecimals: fromA ? pool.decimalsB : pool.decimalsA,
                    amount:         amountIn,
                    wallet:         keypair,
                    connection:     getConnection(),
                    ...(swapSlippageBps ? { slippageBps: swapSlippageBps } : {}),
                });
                bal = await _freshSideBalances(pool, keypair);
            } catch (err) {
                console.warn(`${logPrefix} ${pool.pair}: ${t('cli.ld.sweep_swap_failed', { error: err.message })}`);
            }
        }

        // Einsatz je Seite: der Budget-Bedarf, gedeckelt auf das real Vorhandene.
        const useA = Math.min(bal.a, usd.a > 0 ? needAUsd / usd.a : 0);
        const useB = Math.min(bal.b, usd.b > 0 ? needBUsd / usd.b : 0);

        // Deckelung wie im Hauptpfad: tokenMax = amount × (1 + Slippage) muss unter der
        // Wallet-Balance bleiben, sonst schlägt der On-Chain-TransferChecked fehl.
        const WALLET_SAFETY = 0.999;
        const amountA = useA / SLIPPAGE_FACTOR * WALLET_SAFETY;
        const amountB = useB / SLIPPAGE_FACTOR * WALLET_SAFETY;
        if (amountA <= 0 && amountB <= 0) return null;

        log(t('cli.ld.sweep_start', {
            a: amountA.toFixed(6), tokenA: symA,
            b: amountB.toFixed(6), tokenB: symB,
            usdc: (amountA * usd.a + amountB * usd.b).toFixed(2),
        }));

        const res = await adapter.increaseLiquidity(pool, nftMint, amountA, amountB, DEPOSIT_SLIPPAGE);
        if (!res?.txHash) return null;   // Quote 0 → keine TX, nichts zu buchen

        // res.tokenEstA/B sind seit 2026-08-22 die on-chain bewegten Ist-Mengen (Vault-Deltas
        // der bestätigten TX), bewertet zum Ausführungspreis — nicht mehr die Quote.
        const usdcAdded = calcDepositedUsdc(res.tokenEstA, res.tokenEstB, res.priceExec ?? currentPrice, pool, 0, quotePrice);
        log(t('cli.ld.sweep_ok', { usdc: usdcAdded.toFixed(2), tx: res.txHash }));
        return {
            ...res,                       // liquidityAdded, priceExec, measured, tickLower/Upper …
            usdc:           usdcAdded,
        };
    } catch (err) {
        console.warn(`${logPrefix} ${pool.pair}: ${t('cli.ld.sweep_failed', { error: err?.message ?? String(err) })}`);
        return null;
    }
}

// ─── Deposit-Kernpfade ────────────────────────────────────────────────────────

/**
 * Standard-Deposit (USDC-getrieben): tokenA + USDC in Pool einzahlen.
 * Funktioniert für SOL/USDC, cbBTC/USDC und alle Standard-Pools.
 * Gibt eingezahlten USDC-Betrag zurück (0 bei Skip/Fehler).
 *
 * @param {object} opts.note  – TX-Notiz für transactions-Tabelle (Standard: 'deposit')
 */
export async function depositStandard(pool, depositUsdc, keypair, db, adapter, { note = 'deposit' } = {}) {
    const position = getOpenPosition(db, pool.id);
    if (!position) {
        console.log(`[deposit-lib] ${pool.pair}: keine offene Position – skip.`);
        return 0;
    }

    let state;
    try {
        state = await adapter.getPositionState(pool, position.nft_mint);
    } catch (err) {
        console.warn(`[deposit-lib] ${pool.pair}: Position-State nicht abrufbar – skip. (${err.message})`);
        return 0;
    }
    if (!state.inRange) {
        console.log(`[deposit-lib] ${pool.pair}: Position out-of-range – skip.`);
        return 0;
    }

    const stats        = await adapter.getPoolStats(pool);
    const currentPrice = stats.price;

    const walletTokenA = pool.tokenA === WSOL_MINT
        ? await getUsableSolBalanceFresh(keypair.publicKey)
        : await getTokenBalance(keypair.publicKey, new PublicKey(pool.tokenA), pool.decimalsA);

    if (walletTokenA <= 0) {
        console.log(`[deposit-lib] ${pool.pair}: kein tokenA im Wallet – skip.`);
        return 0;
    }

    // tokenMaxA = amountA × (1 + slippage) → auf walletBalance / SLIPPAGE_FACTOR deckeln.
    // SOL: zusätzlicher TX-Fee-Buffer (getUsableSolBalance schützt solReserve, aber die
    // Deposit-TX selbst kostet danach noch Fees).
    // Achtung: / SLIPPAGE_FACTOR nötig, weil Orca tokenMaxA = amountA × 1.005 setzt —
    // ohne Division würde tokenMaxA die Wallet-Balance überschreiten.
    const safeTokenA = pool.tokenA === WSOL_MINT
        ? Math.max(0, walletTokenA - SOL_TX_FEE_BUFFER) / SLIPPAGE_FACTOR
        : walletTokenA / SLIPPAGE_FACTOR * 0.999;

    const estTokenAFull = depositUsdc / currentPrice;
    const amountA       = Math.min(estTokenAFull * 1.1, safeTokenA);
    const effectiveUsdc = Math.min(depositUsdc, safeTokenA * currentPrice);

    if (effectiveUsdc < MIN_USDC_AMOUNT) {
        console.log(`[deposit-lib] ${pool.pair}: effektiver Betrag zu gering (${effectiveUsdc.toFixed(4)} USDC) – skip.`);
        return 0;
    }

    const amountB = effectiveUsdc / SLIPPAGE_FACTOR;
    console.log(`[deposit-lib] ${pool.pair}: deposit ~${amountA.toFixed(6)} tokenA + ${effectiveUsdc.toFixed(2)} USDC`);

    // Trailing-Stop-Referenz: gemessenen Positionswert VOR dem Kapitalfluss sichern.
    const lpBefore = _lastMeasuredLpValue(db, pool.id);

    let result;
    try {
        result = await adapter.increaseLiquidity(pool, position.nft_mint, amountA, amountB, DEPOSIT_SLIPPAGE);
    } catch (err) {
        console.error(`[deposit-lib] ${pool.pair}: increaseLiquidity fehlgeschlagen – ${err.message}`);
        await notify.error(`deposit ${pool.pair}`, err);
        return 0;
    }

    // Ist-Mengen (Vault-Deltas der TX) zum Ausführungspreis — siehe orca.js increaseLiquidity.
    const depositedMain = calcDepositedUsdc(result.tokenEstA, result.tokenEstB, result.priceExec ?? currentPrice, pool);

    // Rest-Einzahlung. Budget = exakt das, was auch die Haupteinzahlung oben höchstens
    // einsetzen durfte: das USDC-Budget (ggf. schon auf CLEANUP_MAX_DEPOSIT gedeckelt)
    // plus die tokenA-Seite, gedeckelt wie amountA auf estTokenAFull × 1,1. Ein größeres
    // Budget würde den Cleanup-Cap über die Hintertür aushebeln.
    const sweepBudget = depositUsdc + Math.min(walletTokenA, estTokenAFull * 1.1) * currentPrice;
    const sweep = await sweepResidualIntoPosition(pool, position.nft_mint, {
        keypair, db, adapter, currentPrice,
        priceLower: state.priceLower, priceUpper: state.priceUpper,
        budgetLeftUsdc:  Math.max(0, sweepBudget - depositedMain),
        swapSlippageBps: PRESWAP_SLIPPAGE_BPS,
    });
    const depositedUsdc = depositedMain + (sweep?.usdc ?? 0);
    const addedTokenA   = result.tokenEstA + (sweep?.tokenEstA ?? 0);
    const addedTokenB   = result.tokenEstB + (sweep?.tokenEstB ?? 0);

    updatePositionCapital(db, position.id, (position.capital_usdc ?? 0) + depositedUsdc);
    updatePositionHodl(db, position.id, addedTokenA, addedTokenB);
    // Trailing-Stop-Referenz mit dem Liquiditätsfaktor nachziehen + ersten Messwert schreiben.
    settleCapitalFlow(db, pool, position, {
        liquidityBefore: state.liquidity, legs: [result, sweep],
        fallback: { lpBefore, deltaA: addedTokenA, deltaB: addedTokenB, price: currentPrice },
        logPrefix: '[deposit-lib]',
    });
    const txFee = result.txFeeSol ?? await getTxFee(result.txHash);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'deposit',
        amountA:  result.tokenEstA,
        amountB:  result.tokenEstB,
        usdValue: depositedMain,
        txHash:   result.txHash,
        txFeeSol: txFee,
        note,
    });

    // Rest-Einzahlung als eigene Transaktion buchen (eigener TX-Hash, eigene Fee).
    if (sweep) {
        insertTransaction(db, {
            poolId:   pool.id,
            type:     'deposit',
            amountA:  sweep.tokenEstA,
            amountB:  sweep.tokenEstB,
            usdValue: sweep.usdc,
            txHash:   sweep.txHash,
            txFeeSol: await getTxFee(sweep.txHash),
            note:     `${note} rest`,
        });
    }

    console.log(`[deposit-lib] ${pool.pair}: ✓ +${depositedUsdc.toFixed(2)} USDC   TX: ${result.txHash}`);
    return depositedUsdc;
}

/**
 * Einstiegskosten einer Befüllung buchen: was zwischen Wallet und Position verloren
 * ging — Swap-Slippage, Protokoll-Gebühren, TX-Fees und der Rest, der auf der
 * nicht-bindenden Seite liegen blieb.
 *
 * `grossInvestUsd` MUSS der Wert der Mittel VOR dem Umtausch sein und darf nur von
 * einem Aufrufer kommen, bei dem feststeht, dass diese Mittel VOLLSTÄNDIG in die
 * Position wandern sollten (Cleanup-volatilePair: „gesamter Wallet-Bestand beider
 * Pool-Tokens"). Bei einem Pfad mit Budget-Deckel wäre die Differenz überwiegend
 * nicht eingesetztes Kapital statt Kosten — dort bleibt der Wert bewusst undefiniert
 * und die Meldung zeigt die Zeile gar nicht, statt eine zu hohe Zahl zu behaupten.
 *
 * Rein informativ: der PnL setzt laut lib/pnl.js am eingezahlten Kapital an, diese
 * Kosten fallen davor an und sind deshalb NICHT Teil des PnL.
 */
function recordEntryCost(db, positionId, grossInvestUsd, depositedUsdc, logPrefix = '[deposit-lib]') {
    if (!Number.isFinite(grossInvestUsd) || grossInvestUsd <= 0) return;
    const cost = grossInvestUsd - depositedUsdc;
    if (!(cost > 0)) return;
    addPositionEntryCost(db, positionId, cost);
    console.log(`${logPrefix} Einstiegskosten: ${cost.toFixed(2)} USDC (Einsatz ${grossInvestUsd.toFixed(2)} → eingezahlt ${depositedUsdc.toFixed(2)})`);
}

/**
 * usdcIsTokenA-Deposit (z.B. EURC/USDC): USDC-Budget → CLMM-Split → Pre-Swap USDC→tokenB → deposit.
 * Gibt eingezahlten USDC-Betrag zurück (0 bei Skip/Fehler).
 */
export async function depositUsdcIsTokenA(pool, depositUsdc, keypair, db, adapter, { note = 'deposit' } = {}) {
    const tokenBSymbol = pool.pair.split('/')[0]; // 'EURC' für EURC/USDC (tokenA=USDC, tokenB=EURC)

    // 🔒 LIQ#0316: gehört tokenB gerade zu einem Exit auf einem ANDEREN Pool
    // (geteilter Mint), kein Deposit — sonst würde fremdes Exit-Kapital investiert.
    const depositBlock = foreignExitBlock(db, pool, '[deposit-lib]');
    if (depositBlock.blocked) {
        console.log(`[deposit-lib] ${pool.pair}: Deposit übersprungen: ${depositBlock.reason}`);
        return 0;
    }

    if (depositUsdc < MIN_USDC_AMOUNT) {
        console.log(`[deposit-lib] ${pool.pair}: Budget ${depositUsdc.toFixed(4)} USDC zu gering – skip.`);
        return 0;
    }

    const position = getOpenPosition(db, pool.id);
    if (!position) {
        console.log(`[deposit-lib] ${pool.pair}: keine offene Position – skip.`);
        return 0;
    }

    let state;
    try {
        state = await adapter.getPositionState(pool, position.nft_mint);
    } catch (err) {
        console.warn(`[deposit-lib] ${pool.pair}: Position-State nicht abrufbar – skip. (${err.message})`);
        return 0;
    }
    if (!state.inRange) {
        console.log(`[deposit-lib] ${pool.pair}: Position out-of-range – skip.`);
        return 0;
    }

    const stats        = await adapter.getPoolStats(pool);
    const currentPrice = stats.price;

    const usdcPerB      = clmmTokenAForDeposit(1, currentPrice, state.priceLower, state.priceUpper);
    const usdcValuePerB = usdcPerB + 1 / currentPrice;
    const targetB       = depositUsdc / usdcValuePerB;

    let walletTokenB = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenB), pool.decimalsB);
    if (walletTokenB < targetB) {
        const deficitB        = targetB - walletTokenB;
        // Puffer = die hier konfigurierte Swap-Slippage (PRESWAP_SLIPPAGE_BPS = 150 bps),
        // nicht mehr. Im manuellen Pfad (bin/deposit.js) sind es aus demselben Grund nur
        // 1,005 — dort läuft der Swap mit dem Default von 50 bps. Alles über der Slippage
        // wäre Überschuss, der als Token-Rest im Wallet liegen bliebe.
        const swapAmountUsdc  = (deficitB / currentPrice) * 1.015;
        const swapAmountFinal = Math.min(swapAmountUsdc, depositUsdc * 0.99);
        if (swapAmountFinal >= 0.01) {
            console.log(`[deposit-lib] ${pool.pair}: Pre-Swap ${swapAmountFinal.toFixed(2)} USDC → ${tokenBSymbol}`);
            let preSwap;
            try {
                preSwap = await swapTokens({
                    inputMint:      USDC_MINT,
                    outputMint:     pool.tokenB,
                    inputDecimals:  6,
                    outputDecimals: pool.decimalsB,
                    amount:         swapAmountFinal,
                    wallet:         keypair,
                    connection:     getConnection(),
                    apiKey:         null,
                    slippageBps:    PRESWAP_SLIPPAGE_BPS,
                });
            } catch (err) {
                // Jupiter-Builder-Bug bei reinen-Orca-Token (xStocks): Orca-Error 6024
                // InvalidTokenMintOrder (0x1788). Der Pre-Swap läuft innerhalb des Zielpools
                // (tokenA=USDC, tokenB=Token), daher direkter Orca-swapV2 auf genau diesem Pool.
                if (isWhirlpoolMintOrderError(err)) {
                    try {
                        console.warn(`[deposit-lib] ${pool.pair}: Pre-Swap Mint-Order-Fehler (0x1788) – Fallback auf direkten Orca-Swap`);
                        preSwap = await adapter.swapExactIn({
                            poolAddress:    pool.address,
                            inputMint:      USDC_MINT,
                            inputDecimals:  6,
                            outputMint:     pool.tokenB,
                            outputDecimals: pool.decimalsB,
                            amount:         swapAmountFinal,
                            slippageBps:    PRESWAP_SLIPPAGE_BPS,
                        });
                    } catch (orcaErr) {
                        console.warn(`[deposit-lib] ${pool.pair}: direkter Orca-Pre-Swap fehlgeschlagen – skip. (${orcaErr.message})`);
                        return 0;
                    }
                } else {
                    console.warn(`[deposit-lib] ${pool.pair}: Pre-Swap fehlgeschlagen – skip. (${err.message})`);
                    return 0;
                }
            }
            console.log(`[deposit-lib] ${pool.pair}: Pre-Swap ✓ → ${preSwap.amountOut.toFixed(6)} ${tokenBSymbol}   TX: ${preSwap.txSignature}`);
            const swapFee = await getTxFee(preSwap.txSignature);
            insertTransaction(db, {
                poolId:   pool.id,
                type:     'swap',
                amountA:  swapAmountFinal,
                amountB:  preSwap.amountOut,
                usdValue: swapAmountFinal,
                // usd_value_in/out (LIQ#0376 Teil 2): USDC exakt (Eingang), tokenB über
                // denselben currentPrice, der oben bereits swapAmountUsdc bestimmt hat.
                usdValueIn:  swapAmountFinal,
                usdValueOut: preSwap.amountOut / currentPrice,
                txHash:   preSwap.txSignature,
                txFeeSol: swapFee,
                note:     `pre-swap USDC→${tokenBSymbol}`,
            });
            walletTokenB = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenB), pool.decimalsB);
        }
    }

    const walletTokenA = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenA), pool.decimalsA);
    if (walletTokenA <= 0 || walletTokenB <= 0) {
        console.log(`[deposit-lib] ${pool.pair}: Token-Balance nach Pre-Swap zu gering – skip.`);
        return 0;
    }

    // maxSafeAmountB: EURC-Menge, bei der tokenMaxA = amountB * usdcPerB * slippage ≤ walletTokenA.
    // Verhindert "insufficient funds" wenn der Pre-Swap leicht überschießt.
    const maxSafeAmountB = walletTokenA / (usdcPerB * SLIPPAGE_FACTOR);
    const amountB        = Math.min(walletTokenB, targetB, maxSafeAmountB) / SLIPPAGE_FACTOR;
    console.log(`[deposit-lib] ${pool.pair}: deposit ~${walletTokenA.toFixed(2)} USDC + ${amountB.toFixed(6)} ${tokenBSymbol}`);

    // Trailing-Stop-Referenz: gemessenen Positionswert VOR dem Kapitalfluss sichern.
    const lpBefore = _lastMeasuredLpValue(db, pool.id);

    let result;
    try {
        result = await adapter.increaseLiquidity(pool, position.nft_mint, walletTokenA, amountB, DEPOSIT_SLIPPAGE);
    } catch (err) {
        console.error(`[deposit-lib] ${pool.pair}: increaseLiquidity fehlgeschlagen – ${err.message}`);
        await notify.error(`deposit ${pool.pair}`, err);
        return 0;
    }

    const depositedMain = calcDepositedUsdc(result.tokenEstA, result.tokenEstB, result.priceExec ?? currentPrice, pool);

    // Rest-Einzahlung: Budget ist hier das USDC-Budget selbst (tokenA IST USDC).
    const sweep = await sweepResidualIntoPosition(pool, position.nft_mint, {
        keypair, db, adapter, currentPrice,
        priceLower: state.priceLower, priceUpper: state.priceUpper,
        budgetLeftUsdc:  Math.max(0, depositUsdc - depositedMain),
        swapSlippageBps: PRESWAP_SLIPPAGE_BPS,
    });
    const depositedUsdc = depositedMain + (sweep?.usdc ?? 0);
    const addedTokenA   = result.tokenEstA + (sweep?.tokenEstA ?? 0);
    const addedTokenB   = result.tokenEstB + (sweep?.tokenEstB ?? 0);

    updatePositionCapital(db, position.id, (position.capital_usdc ?? 0) + depositedUsdc);
    updatePositionHodl(db, position.id, addedTokenA, addedTokenB);
    // Trailing-Stop-Referenz mit dem Liquiditätsfaktor nachziehen + ersten Messwert schreiben.
    settleCapitalFlow(db, pool, position, {
        liquidityBefore: state.liquidity, legs: [result, sweep],
        fallback: { lpBefore, deltaA: addedTokenA, deltaB: addedTokenB, price: currentPrice },
        logPrefix: '[deposit-lib]',
    });
    const txFee = result.txFeeSol ?? await getTxFee(result.txHash);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'deposit',
        amountA:  result.tokenEstA,
        amountB:  result.tokenEstB,
        usdValue: depositedMain,
        txHash:   result.txHash,
        txFeeSol: txFee,
        note,
    });

    // Rest-Einzahlung als eigene Transaktion buchen (eigener TX-Hash, eigene Fee).
    if (sweep) {
        insertTransaction(db, {
            poolId:   pool.id,
            type:     'deposit',
            amountA:  sweep.tokenEstA,
            amountB:  sweep.tokenEstB,
            usdValue: sweep.usdc,
            txHash:   sweep.txHash,
            txFeeSol: await getTxFee(sweep.txHash),
            note:     `${note} rest`,
        });
    }

    console.log(`[deposit-lib] ${pool.pair}: ✓ +${depositedUsdc.toFixed(2)} USDC   TX: ${result.txHash}`);
    return depositedUsdc;
}

/**
 * volatilePair-Deposit: beide Pool-Tokens direkt einzahlen,
 * USD-Bewertung über Quote-Token-Preis aus pool.quotePricePoolId.
 *
 * Bedingung: beide Tokens müssen bereits im Wallet liegen (vom Top-Level-Deposit-Script
 * via Pre-Swaps befüllt). Hat einer der Tokens SOL als Mint, wird die Gas-Reserve geschützt.
 *
 * @param {number} opts.quotePrice – USD-Preis des Quote-Tokens; falls 0, wird er aus pool_stats gelesen
 * @param {string} opts.note       – TX-Notiz
 */
/**
 * Öffnet eine neue Position für einen Volatile-Pair-Pool aus dem Wallet-Bestand.
 * Wird aufgerufen wenn kein offenes NFT existiert (Erstbefüllung oder nach Close).
 * Identischer Ablauf wie bin/deposit.js --new für volatilePair.
 */
async function openVolatilePairPosition(pool, keypair, db, adapter, { note = 'cleanup', quotePrice = 0, grossInvestUsd = null } = {}) {
    // 🔒 LIQ#0316: gehört tokenA/tokenB gerade zu einem Exit auf einem ANDEREN Pool
    // (geteilter Mint), keine neue Position öffnen — sonst würde fremdes
    // Exit-Kapital investiert.
    const openBlock = foreignExitBlock(db, pool, '[deposit-lib]');
    if (openBlock.blocked) {
        console.log(`[deposit-lib] ${pool.pair}: Öffnen übersprungen: ${openBlock.reason}`);
        return 0;
    }

    // ─── 1. Frische Preise ────────────────────────────────────────────────────
    let poolStats, resolvedQuotePrice;
    try {
        poolStats = await adapter.getPoolStats(pool);
        if (quotePrice > 0) {
            resolvedQuotePrice = quotePrice;
        } else {
            // Gleiche Quelle wie jeder Snapshot (Pyth, max. 5 Min alt; pool_stats nur Fallback).
            // Mit dem stündlichen pool_stats-Preis lag der Einstand von SOL/cbBTC am 2026-08-22
            // 5,8 % über dem ersten Messwert — reine Bewertungsdifferenz, kein Verlust.
            resolvedQuotePrice = getQuotePriceUsd(db, pool);
            if (resolvedQuotePrice <= 0) throw new Error(`Kein USD-Preis für quoteToken ${pool.quoteTokenMint} – bitte Bot starten`);
        }
    } catch (err) {
        console.error(`[deposit-lib:open] ${pool.pair}: Preise nicht lesbar – ${err.message}`);
        await notify.warn(`openVolatilePairPosition ${pool.pair}`, err);
        return 0;
    }
    const currentPrice = poolStats.price;
    if (currentPrice <= 0 || resolvedQuotePrice <= 0) {
        console.error(`[deposit-lib:open] ${pool.pair}: ungültige Preise (pool=${currentPrice}, quote=${resolvedQuotePrice})`);
        return 0;
    }

    // ─── 2. Range berechnen ───────────────────────────────────────────────────
    const effectiveRange = pool.rangeOverride
        ? { ...config.range, ...pool.rangeOverride }
        : config.range;
    const range = calculateRange(pool, currentPrice, effectiveRange, db);
    console.log(`[deposit-lib:open] ${pool.pair}: Range ${range.priceLower.toFixed(4)} – ${range.priceUpper.toFixed(4)}`);

    // ─── 3. Wallet-Bestände lesen ─────────────────────────────────────────────
    const walletA = pool.tokenA === WSOL_MINT
        ? Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey) - SOL_TX_FEE_BUFFER)
        : await getTokenBalanceFresh(keypair.publicKey, pool.tokenA, pool.decimalsA);
    const walletB = pool.tokenB === WSOL_MINT
        ? Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey) - SOL_TX_FEE_BUFFER)
        : await getTokenBalanceFresh(keypair.publicKey, pool.tokenB, pool.decimalsB);

    if (walletA <= 0 && walletB <= 0) {
        console.log(`[deposit-lib:open] ${pool.pair}: keine Token im Wallet – skip.`);
        return 0;
    }

    const amountA = walletA / SLIPPAGE_FACTOR;
    const amountB = walletB / SLIPPAGE_FACTOR;
    console.log(`[deposit-lib:open] ${pool.pair}: Kapital ~${amountA.toFixed(6)} tokenA + ${amountB.toFixed(6)} tokenB`);

    // ─── 4. Position öffnen ───────────────────────────────────────────────────
    let result;
    try {
        result = await adapter.openPosition(pool, range.tickLower, range.tickUpper, amountA, amountB, DEPOSIT_SLIPPAGE);
    } catch (err) {
        console.error(`[deposit-lib:open] ${pool.pair}: openPosition fehlgeschlagen – ${err.message}`);
        await notify.error(`openVolatilePairPosition ${pool.pair}`, err);
        return 0;
    }

    // ─── 5. Tatsächlich deponierte Mengen aus Liquidität zurückrechnen ─────────
    const liquidityBN = new BN(result.liquidity);
    const sqrtPrice   = PriceMath.priceToSqrtPriceX64(new Decimal(currentPrice), pool.decimalsA, pool.decimalsB);
    const sqrtLower   = PriceMath.tickIndexToSqrtPriceX64(range.tickLower);
    const sqrtUpper   = PriceMath.tickIndexToSqrtPriceX64(range.tickUpper);
    const realAmounts = PoolUtil.getTokenAmountsFromLiquidity(liquidityBN, sqrtPrice, sqrtLower, sqrtUpper, false);
    const realTokenA  = new Decimal(realAmounts.tokenA.toString()).div(new Decimal(10).pow(pool.decimalsA)).toNumber();
    const realTokenB  = new Decimal(realAmounts.tokenB.toString()).div(new Decimal(10).pow(pool.decimalsB)).toNumber();
    const openedCapital = calcDepositedUsdc(realTokenA, realTokenB, currentPrice, pool, 0, resolvedQuotePrice);

    // ─── 5b. Rest-Einzahlung direkt in die frische Position ───────────────────
    // Kein Budget-Deckel (siehe depositVolatilePair): dieser Pfad setzt bewusst den
    // gesamten Wallet-Bestand ein, der Rest ist der Überschuss der nicht-bindenden Seite.
    const sweep = await sweepResidualIntoPosition(pool, result.nftMint, {
        keypair, db, adapter, currentPrice,
        priceLower: range.priceLower, priceUpper: range.priceUpper,
        budgetLeftUsdc:  Infinity,
        quotePrice:      resolvedQuotePrice,
        swapSlippageBps: PRESWAP_SLIPPAGE_BPS,
        logPrefix:       '[deposit-lib:open]',
    });
    const totalTokenA = realTokenA + (sweep?.tokenEstA ?? 0);
    const totalTokenB = realTokenB + (sweep?.tokenEstB ?? 0);
    const capitalUsdc = openedCapital + (sweep?.usdc ?? 0);

    // ─── 6. DB-Einträge ───────────────────────────────────────────────────────
    clearPositionSnapshots(db, pool.id);
    const positionId = insertPosition(db, {
        poolId:       pool.id,
        nftMint:      result.nftMint,
        tickLower:    range.tickLower,
        tickUpper:    range.tickUpper,
        priceLower:   range.priceLower,
        priceUpper:   range.priceUpper,
        liquidity:    sweep?.addedLiquidity ?? result.liquidity,
        capitalUsdc,
        hodlTokenA:   totalTokenA,
        hodlTokenB:   totalTokenB,
        hodlPriceUsd: currentPrice,
        openTx:       result.txHash,
        openedAt:     Date.now(),
    });
    recordEntryCost(db, positionId, grossInvestUsd, capitalUsdc, '[deposit-lib:open]');
    const openFee = await getTxFee(result.txHash);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'open_position',
        amountA:  realTokenA,
        amountB:  realTokenB,
        usdValue: openedCapital,
        txHash:   result.txHash,
        txFeeSol: openFee,
        note:     `${note} (Tick ${range.tickLower} – ${range.tickUpper})`,
    });
    if (sweep) {
        insertTransaction(db, {
            poolId:   pool.id,
            type:     'deposit',
            amountA:  sweep.tokenEstA,
            amountB:  sweep.tokenEstB,
            usdValue: sweep.usdc > 0 ? sweep.usdc : null,
            txHash:   sweep.txHash,
            txFeeSol: await getTxFee(sweep.txHash),
            note:     `${note} rest`,
        });
    }
    // Referenz des Trailing Stops sofort aus einem gemessenen On-Chain-Read setzen, statt
    // sie dem nächsten Bot-Tick zu überlassen — sonst beginnt seine Wertreihe erst bis zu
    // fünf Minuten nach dem Einstieg (siehe establishPositionBaseline). Nur wenn die Messung
    // fehlschlägt, bleibt es beim bisherigen Quote-Snapshot.
    const baselineOk = await establishPositionBaseline(
        db, pool, adapter, result.nftMint, currentPrice, { logPrefix: '[deposit-lib:open]' },
    );
    if (!baselineOk) {
        insertPositionSnapshot(db, {
            poolId:         pool.id,
            lpValueUsd:     capitalUsdc,
            feesPendingUsd: 0,
            feesPendingA:   0,
            feesPendingB:   0,
            ilUsd:          0,
            ilPct:          0,
            amountA:        totalTokenA,
            amountB:        totalTokenB,
            price:          currentPrice,
        });
    }
    insertCapitalFlow(db, {
        poolId:          pool.id,
        usdcAmount:      openedCapital,
        balanceSnapshot: null,
        txHash:          result.txHash,
        note:            `${note} openPosition`,
        isExternal:      0,  // cleanup-intern, kein externer Kapitalfluss
    });
    if (sweep) {
        insertCapitalFlow(db, {
            poolId:          pool.id,
            usdcAmount:      sweep.usdc,
            balanceSnapshot: null,
            txHash:          sweep.txHash,
            note:            `${note} rest`,
            isExternal:      0,
        });
    }

    // ─── 7. Pool aktivieren (DB ist Single Source of Truth) ───────────────────
    if (setPoolActive(pool.id, true)) {
        console.log(`[deposit-lib:open] Pool ${pool.pair} auf active=true gesetzt`);
    }
    ensureTrailingStopDefaults(pool.id, pool.poolType);
    {
        const tvlNow = db.prepare(`SELECT tvl_usd FROM pool_stats WHERE pool_id=? AND tvl_usd>0 ORDER BY recorded_at DESC LIMIT 1`).get(pool.id)?.tvl_usd ?? 0;
        ensureTvlProtectionDefaults(pool.id, tvlNow, { warn: pool.tvlWarnThreshold, exit: pool.tvlExitThreshold });
    }
    ensureTrailingStopMinimumReset(pool.id);

    // ─── 8. Notifications ────────────────────────────────────────────────────
    await notify.depositAdded(pool, capitalUsdc, totalTokenA, totalTokenB, result.txHash, true);
    await notify.positionOpened(pool, {
        priceLower: range.priceLower,
        priceUpper: range.priceUpper,
        nftMint:    result.nftMint,
        txHash:     result.txHash,
    });

    console.log(`[deposit-lib:open] ${pool.pair}: ✓ Neue Position  NFT: ${result.nftMint}  ~${capitalUsdc.toFixed(2)} USDC`);
    return capitalUsdc;
}

export async function depositVolatilePair(pool, keypair, db, adapter, { note = 'volatilePair', quotePrice = 0, grossInvestUsd = null } = {}) {
    const position = getOpenPosition(db, pool.id);
    if (!position) {
        // Keine existierende Position → neue eröffnen (z.B. Erstbefüllung via Cleanup)
        return openVolatilePairPosition(pool, keypair, db, adapter, { note, quotePrice, grossInvestUsd });
    }

    let state;
    try {
        state = await adapter.getPositionState(pool, position.nft_mint);
    } catch (err) {
        console.warn(`[deposit-lib] ${pool.pair}: Position-State nicht abrufbar – skip. (${err.message})`);
        return 0;
    }
    if (!state.inRange) {
        console.log(`[deposit-lib] ${pool.pair}: out-of-range – skip.`);
        return 0;
    }

    const walletTokenA = pool.tokenA === WSOL_MINT
        ? await getUsableSolBalanceFresh(keypair.publicKey)
        : await getTokenBalance(keypair.publicKey, new PublicKey(pool.tokenA), pool.decimalsA);
    const walletTokenB = pool.tokenB === WSOL_MINT
        ? await getUsableSolBalanceFresh(keypair.publicKey)
        : await getTokenBalance(keypair.publicKey, new PublicKey(pool.tokenB), pool.decimalsB);

    if (walletTokenA <= 0 && walletTokenB <= 0) {
        console.log(`[deposit-lib] ${pool.pair}: keine Token im Wallet – skip.`);
        return 0;
    }

    // Wenn SOL ein Pool-Token ist, zusätzlichen TX-Fee-Buffer abziehen.
    // / SLIPPAGE_FACTOR nötig: Orca setzt tokenMaxA = amountA × 1.005, ohne Division
    // würde tokenMaxA die Wallet-Balance bei hohem SOL-Guthaben überschreiten.
    const safeA = pool.tokenA === WSOL_MINT
        ? Math.max(0, walletTokenA - SOL_TX_FEE_BUFFER) / SLIPPAGE_FACTOR
        : walletTokenA / SLIPPAGE_FACTOR * 0.999;
    const safeB = pool.tokenB === WSOL_MINT
        ? Math.max(0, walletTokenB - SOL_TX_FEE_BUFFER) / SLIPPAGE_FACTOR
        : walletTokenB / SLIPPAGE_FACTOR * 0.999;

    console.log(`[deposit-lib] ${pool.pair}: volatilePair deposit ${safeA.toFixed(6)} tokenA + ${safeB.toFixed(6)} tokenB`);

    // Trailing-Stop-Referenz: gemessenen Positionswert VOR dem Kapitalfluss sichern.
    const lpBefore = _lastMeasuredLpValue(db, pool.id);

    let result;
    try {
        result = await adapter.increaseLiquidity(pool, position.nft_mint, safeA, safeB, DEPOSIT_SLIPPAGE);
    } catch (err) {
        console.warn(`[deposit-lib] ${pool.pair}: volatilePair deposit übersprungen – ${err.message}`);
        return 0;
    }

    const resolvedQuotePrice = quotePrice > 0
        ? quotePrice
        : getQuotePriceUsd(db, pool);                 // Pyth wie die Snapshots, pool_stats nur Fallback
    const currentPrice  = state.currentPrice ?? 0;
    const depositedMain = calcDepositedUsdc(result.tokenEstA, result.tokenEstB, result.priceExec ?? currentPrice, pool, 0, resolvedQuotePrice);

    // Rest-Einzahlung: dieser Pfad zahlt bewusst den kompletten Wallet-Bestand beider
    // Pool-Tokens ein, deshalb kein Budget-Deckel — was übrig bleibt, ist per Definition
    // der von Orca nicht genutzte Überschuss der nicht-bindenden Seite.
    const sweep = await sweepResidualIntoPosition(pool, position.nft_mint, {
        keypair, db, adapter, currentPrice,
        priceLower: state.priceLower, priceUpper: state.priceUpper,
        budgetLeftUsdc:  Infinity,
        quotePrice:      resolvedQuotePrice,
        swapSlippageBps: PRESWAP_SLIPPAGE_BPS,
    });
    const depositedUsdc = depositedMain + (sweep?.usdc ?? 0);
    const addedTokenA   = result.tokenEstA + (sweep?.tokenEstA ?? 0);
    const addedTokenB   = result.tokenEstB + (sweep?.tokenEstB ?? 0);

    updatePositionCapital(db, position.id, (position.capital_usdc ?? 0) + depositedUsdc);
    recordEntryCost(db, position.id, grossInvestUsd, depositedUsdc);
    updatePositionHodl(db, position.id, addedTokenA, addedTokenB);
    settleCapitalFlow(db, pool, position, {
        liquidityBefore: state.liquidity, legs: [result, sweep],
        fallback: { lpBefore, deltaA: addedTokenA, deltaB: addedTokenB, price: currentPrice },
        logPrefix: '[deposit-lib]',
    });
    const txFee = result.txFeeSol ?? await getTxFee(result.txHash);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'deposit',
        amountA:  result.tokenEstA,
        amountB:  result.tokenEstB,
        usdValue: depositedMain > 0 ? depositedMain : null,
        txHash:   result.txHash,
        txFeeSol: txFee,
        note,
    });

    // Rest-Einzahlung als eigene Transaktion buchen (eigener TX-Hash, eigene Fee).
    if (sweep) {
        insertTransaction(db, {
            poolId:   pool.id,
            type:     'deposit',
            amountA:  sweep.tokenEstA,
            amountB:  sweep.tokenEstB,
            usdValue: sweep.usdc > 0 ? sweep.usdc : null,
            txHash:   sweep.txHash,
            txFeeSol: await getTxFee(sweep.txHash),
            note:     `${note} rest`,
        });
    }

    console.log(`[deposit-lib] ${pool.pair}: ✓ +${depositedUsdc.toFixed(2)} USDC   TX: ${result.txHash}`);
    return depositedUsdc;
}

/**
 * Router: leitet an den korrekten Deposit-Pfad weiter.
 */
export async function deposit(pool, depositUsdc, keypair, db, adapter, opts = {}) {
    // Phantom-Kapital-Schutz (pool-typ-übergreifend): Läuft für diesen Pool ein unsauber
    // abgebrochenes Rebalancing (decreaseLiquidity OK, closePosition fehlgeschlagen → Tokens
    // im Wallet), darf der automatische Cleanup diese Tokens NICHT als Neukapital einzahlen.
    // Nur den Cleanup-Pfad blocken (note enthält 'cleanup'), manuelle Deposits laufen durch.
    // Siehe PUMP/SOL-Vorfall 2026-06-28.
    if (typeof opts.note === 'string' && opts.note.includes('cleanup') && isRebalancePending(pool.id)) {
        console.log(`[deposit-lib] ${pool.pair}: Rebalancing-Pending aktiv – Cleanup-Deposit übersprungen (verhindert Phantom-Kapital)`);
        return 0;
    }
    if (pool.usdcIsTokenA)   return depositUsdcIsTokenA(pool, depositUsdc, keypair, db, adapter, opts);
    if (pool.volatilePair)   return depositVolatilePair(pool, keypair, db, adapter, opts);
    return depositStandard(pool, depositUsdc, keypair, db, adapter, opts);
}
