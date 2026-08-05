/**
 * FORGE Liquidity – Manuelles Entnehmen aus einem Pool
 *
 * Entnimmt einen Teil der Liquidität einer bestehenden Position via decreaseLiquidity.
 * Die Position bleibt offen — nur der angegebene Betrag wird herausgenommen.
 *
 * Verwendung:
 *   node bin/withdraw.js --pool "SOL/USDC"   --usdc 100
 *   node bin/withdraw.js --pool "cbBTC/USDC" --usdc 200
 *   node bin/withdraw.js --pool "cbBTC/WBTC" --usdc 100 --dry-run
 *   node bin/withdraw.js --pool "SOL/USDC"   --token SOL --amount 0.5    (Modus B)
 *
 * Optionen:
 *   --pool <pair>     Pool-Paar (Pflicht)
 *   --usdc <betrag>   Modus A: zu entnehmender USDC-Wert
 *   --token <symbol>  Modus B: Anker-Token (TokenA oder TokenB des Pools)
 *   --amount <betrag> Modus B: Menge des Anker-Tokens
 *   Genau eines von --usdc oder (--token + --amount) ist Pflicht.
 *   --dry-run         Simulation: Checks + Berechnung, keine On-Chain-TX
 *   --json            Maschinenlesbarer Output (für UI-Integration)
 *   --swap-to-usdc    Entnommene Coins nach der Auszahlung automatisch in USDC tauschen
 *   --send-to <addr>  Entnommene Coins (bzw. bei --swap-to-usdc: USDC) an diese Adresse senden;
 *                      ohne diese Option verbleiben die Coins im Wallet.
 *
 * Abbruchbedingungen:
 *   - Pool nicht gefunden
 *   - Keine offene Position
 *   - Betrag übersteigt Positionswert
 *   - Slippage > 0,5 % → klare Fehlermeldung im Log + Telegram
 *   - Cleanup oder SL läuft → Abbruch mit Hinweis (Retry in 30s)
 *
 * Hinweis: Funktioniert auch out-of-range — man erhält dann nur den
 * verbliebenen Token zurück (der andere ist bereits vollständig konvertiert).
 * Modus B mit Anker = Token, der gerade 0 in der Position hat (out-of-range),
 * ist nicht möglich.
 */

import { parseArgs }   from 'node:util';
import { config, setPoolActive } from '../lib/config.js';
import {
    openDatabase, syncPools, getOpenPosition,
    insertTransaction, updatePositionCapital, updatePositionHodl, insertCapitalFlow,
    closePosition,
} from '../lib/db.js';
// Performance-Segments seit v0.3.47 nicht mehr geschrieben — Baseline = netDeposited.
import { getAdapter }        from '../lib/pool-adapter/index.js';
import {
    getKeypair, getUsdcBalance, getUsableSolBalance, getTokenBalance, getTxFee, getSolBalanceFresh,
    getUsableSolBalanceFresh, getTokenBalanceFresh, getConnection, USDC_MINT,
} from '../lib/wallet.js';
import { swapTokens } from '../lib/swap.js';
import { matchErrorCode, describeError } from '../../../lib/error-messages.js';
import * as notify           from '../lib/notify.js';
import { getTokenUsdPrice }  from '../lib/deposit-lib.js';
import { getSplTokensUsd }   from '../lib/wallet-monitor-client.js';
import { refreshAfterAction, writePositionSnapshotFromDelta } from '../lib/refresh-state.js';
import {
    acquireManualLock, releaseManualLock,
    isCleanupRunning, isSlLocked, isRebalanceLocked,
    waitForBotToFinish,
} from '../lib/cleanup-lock.js';
import { clearMinimumValue } from '../lib/trailing-stop.js';
import { executeSwapStep, executeTransferStep } from '../lib/exit-finalizer.js';
import { logActionError } from '../lib/error-log.js';
import { Percentage }        from '@orca-so/common-sdk';
import { PublicKey }         from '@solana/web3.js';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const WITHDRAW_SLIPPAGE = Percentage.fromFraction(1, 200);  // 0,5 %
const SLIPPAGE_PCT_STR  = '0,5 %';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ─── CLI-Args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        pool:      { type: 'string' },
        usdc:      { type: 'string' },
        token:     { type: 'string' },
        amount:    { type: 'string' },
        full:      { type: 'boolean', default: false },
        'dry-run': { type: 'boolean' },
        json:      { type: 'boolean', default: false },
        'swap-to-usdc': { type: 'boolean', default: false },
        'send-to':      { type: 'string' },
        help:      { type: 'boolean', default: false, short: 'h' },
    },
    strict: true,
});

// Muss vor jedem Seiteneffekt (openDatabase() weiter unten) geprüft werden.
if (args.help) {
    console.log(`
FORGE Liquidity – Manuelles Entnehmen aus einem Pool (bin/withdraw.js)

Entnimmt einen Teil der Liquidität einer bestehenden Position via
decreaseLiquidity. Die Position bleibt offen — nur der angegebene Betrag
wird herausgenommen. KEIN Dry-Run per Default – jeder Aufruf ohne
--dry-run führt echte On-Chain-Transaktionen aus.

Verwendung:
  node bin/withdraw.js --pool "SOL/USDC"   --usdc 100
  node bin/withdraw.js --pool "cbBTC/USDC" --usdc 200
  node bin/withdraw.js --pool "cbBTC/WBTC" --usdc 100 --dry-run
  node bin/withdraw.js --pool "SOL/USDC"   --token SOL --amount 0.5    (Modus B)

Optionen:
  --pool <pair>     Pool-Paar (Pflicht)
  --usdc <betrag>   Modus A: zu entnehmender USDC-Wert
  --token <symbol>  Modus B: Anker-Token (TokenA oder TokenB des Pools)
  --amount <betrag> Modus B: Menge des Anker-Tokens
  Genau eines von --usdc oder (--token + --amount) ist Pflicht.
  --dry-run         Simulation: Checks + Berechnung, keine On-Chain-TX
  --json            Maschinenlesbarer Output (für UI-Integration)
  --swap-to-usdc    Entnommene Coins nach der Auszahlung automatisch in USDC tauschen
  --send-to <addr>  Entnommene Coins (bzw. bei --swap-to-usdc: USDC) an diese Adresse
                     senden; ohne diese Option verbleiben die Coins im Wallet.
  --help, -h        Dieser Text, kein Withdraw-Lauf

Hinweis: Funktioniert auch out-of-range — man erhält dann nur den
verbliebenen Token zurück (der andere ist bereits vollständig konvertiert).
`);
    process.exit(0);
}

const jsonMode = args.json;

// ─── JSON-Output-Sammler ──────────────────────────────────────────────────────

const jsonLog    = [];
const jsonResult = {};
const _origLog   = console.log.bind(console);
const _origErr   = console.error.bind(console);
if (jsonMode) {
    console.log   = (...a) => jsonLog.push({ level: 'info',  msg: a.join(' ') });
    console.warn  = (...a) => jsonLog.push({ level: 'warn',  msg: a.join(' ') });
    console.error = (...a) => jsonLog.push({ level: 'error', msg: a.join(' ') });
}
function emitJson(ok, errorMsg = null) {
    _origLog(JSON.stringify({ ok, error: errorMsg, log: jsonLog, result: jsonResult }));
}

// ─── Argumentvalidierung ──────────────────────────────────────────────────────

const hasUsdc  = args.usdc != null;
const hasModeB = args.token != null && args.amount != null;
const useFull  = args.full === true;
if (!args.pool || (!useFull && hasUsdc === hasModeB)) {
    const errMsg = 'Verwendung: --pool <pair> + (--usdc <n> | --token <sym> --amount <n> | --full) [--dry-run] [--json]';
    if (jsonMode) { emitJson(false, errMsg); process.exit(1); }
    console.error(errMsg);
    process.exit(1);
}

const dryRun       = args['dry-run'] ?? false;
const useModeB     = hasModeB;
const modeBToken   = useModeB ? args.token : null;
const modeBAmount  = useModeB ? parseFloat(args.amount) : NaN;
let   withdrawUsdc = hasUsdc ? parseFloat(args.usdc) : 0;  // wird bei Modus B/--full aus Position berechnet

if (hasUsdc && (isNaN(withdrawUsdc) || withdrawUsdc <= 0)) {
    const msg = `Ungültiger USDC-Betrag: "${args.usdc}"`;
    if (jsonMode) { emitJson(false, msg); process.exit(1); }
    console.error(`[withdraw] ${msg}`);
    process.exit(1);
}
if (useModeB && (isNaN(modeBAmount) || modeBAmount <= 0)) {
    const msg = `Ungültige Token-Menge: "${args.amount}"`;
    if (jsonMode) { emitJson(false, msg); process.exit(1); }
    console.error(`[withdraw] ${msg}`);
    process.exit(1);
}

const swapToUsdcFlag = args['swap-to-usdc'] === true;
const sendToAddr     = args['send-to'] ?? '';
if (sendToAddr) {
    try {
        new PublicKey(sendToAddr);
    } catch {
        const msg = `Ungültige Empfänger-Adresse: "${sendToAddr}"`;
        if (jsonMode) { emitJson(false, msg); process.exit(1); }
        console.error(`[withdraw] ${msg}`);
        process.exit(1);
    }
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** Erkennt Slippage-Fehler aus Orca-Fehlermeldungen */
function isSlippageError(err) {
    return matchErrorCode(err) === 'SLIPPAGE';
}

/** Erkennt "insufficient funds" (SPL-Token-Program 0x1). */
function isInsufficientFundsError(err) {
    return matchErrorCode(err) === 'INSUFFICIENT_FUNDS';
}

/**
 * decreaseLiquidity zieht Token aus der Position, nicht aus der Wallet — "insufficient
 * funds" hier ist daher meist SOL für TX-Fees/Rent, nicht der abgehobene Token selbst.
 */
async function _describeInsufficientFundsWithdraw(kp) {
    const freshSol = await getSolBalanceFresh(kp.publicKey).catch(() => null);
    if (freshSol == null) {
        return `Nicht genug Guthaben für die Auszahlung (SOL-Stand konnte nicht geprüft werden). Bitte erneut versuchen.`;
    }
    return freshSol < 0.05
        ? `Nicht genug SOL für die Transaktion: nur noch ${freshSol.toFixed(4)} SOL im Wallet (TX-Fees/Rent). Bitte Wallet mit SOL auffüllen und erneut versuchen.`
        : `Nicht genug Guthaben für die Auszahlung. SOL-Stand (${freshSol.toFixed(4)}) ist ausreichend, vermutlich hat sich der Wallet-/Positionsstand seit Beginn der Auszahlung geändert (z.B. durch einen zwischenzeitlichen Cleanup-Lauf). Bitte erneut versuchen.`;
}

/**
 * Selbstheilung SOL-Engpass: tauscht USDC → SOL, bis mindestens minNeeded erreicht ist.
 * Analog zu bin/deposit.js `_autoTopUpSol()` — dort existierte die Selbstheilung bereits,
 * hier bislang nicht (Befund 2026-07-03: withdraw.js brach bei zu wenig SOL direkt
 * ab statt erst automatisch nachzutanken).
 * @returns {number} tatsächlicher SOL-Stand nach dem Versuch
 */
async function _autoTopUpSol(currentBalance, minNeeded) {
    if (currentBalance >= minNeeded) return currentBalance;
    const solPriceRow = db.prepare(
        `SELECT price FROM pool_stats WHERE pool_id = 'liq-sol-usdc' ORDER BY recorded_at DESC LIMIT 1`
    ).get();
    const solPrice = solPriceRow?.price ?? 0;
    if (solPrice <= 0) {
        console.warn(`[withdraw] SOL-Top-Up: SOL-Preis nicht verfügbar – Top-Up übersprungen`);
        return currentBalance;
    }
    const target     = minNeeded + 0.01; // kleiner Extra-Puffer
    const neededSol  = target - currentBalance;
    const neededUsdc = neededSol * solPrice * 1.02; // +2% Slippage-Puffer
    const usdcBal    = await getTokenBalanceFresh(getKeypair().publicKey, USDC_MINT, 6);
    if (usdcBal < neededUsdc) {
        console.warn(`[withdraw] SOL-Top-Up: nicht genug USDC (${usdcBal.toFixed(2)} < ${neededUsdc.toFixed(2)} USDC) – kein Auto-Swap möglich`);
        return currentBalance;
    }
    console.log(`[withdraw] SOL-Top-Up: ${currentBalance.toFixed(4)} SOL < ${minNeeded.toFixed(4)} – tausche ~${neededUsdc.toFixed(2)} USDC → SOL`);
    try {
        await swapTokens({
            inputMint:      USDC_MINT,
            outputMint:     WSOL_MINT,
            inputDecimals:  6,
            outputDecimals: 9,
            amount:         neededUsdc,
            wallet:         getKeypair(),
            connection:     getConnection(),
        });
        const newBalance = await getUsableSolBalanceFresh(getKeypair().publicKey);
        console.log(`[withdraw] SOL-Top-Up OK: jetzt ${newBalance.toFixed(4)} SOL`);
        return newBalance;
    } catch (err) {
        console.warn(`[withdraw] SOL-Top-Up fehlgeschlagen: ${err.message}`);
        return currentBalance;
    }
}

function abort(msg) {
    if (jsonMode) {
        try { releaseManualLock(); } catch {}
        emitJson(false, msg);
        process.exit(1);
    }
    console.error(`[withdraw] FEHLER: ${msg}`);
    try { releaseManualLock(); } catch {}
    process.exit(1);
}

function successExit() {
    if (jsonMode) emitJson(true);
    try { releaseManualLock(); } catch {}
    process.exit(0);
}

// Unerwartete Fehler immer abfangen, damit im JSON-Modus ein valider Response gesendet wird.
function _fatalHandler(err) {
    try { releaseManualLock(); } catch {}
    const msg = err?.message ?? String(err);
    _origErr('[withdraw] Fatal:', msg);
    if (jsonMode) { emitJson(false, `Unerwarteter Fehler: ${msg}`); }
    process.exit(1);
}
process.on('uncaughtException',  _fatalHandler);
process.on('unhandledRejection', _fatalHandler);

// ─── Manual-Lock acquire (im dry-run nicht nötig) ─────────────────────────────

if (!dryRun) {
    if (isCleanupRunning()) abort('Cleanup läuft – bitte ~30 s warten und erneut versuchen.');
    if (isSlLocked())         abort('Stop-Loss/Take-Profit-Flow läuft – bitte warten.');
    // Bot hat Vorrang: warten bis Claim/Reinvest/Rebalancing fertig sind.
    if (!(await waitForBotToFinish())) {
        abort('Bot ist gerade aktiv (Claim/Reinvest/Rebalance) – bitte in ~1 Min erneut versuchen.');
    }
    acquireManualLock({ action: 'withdraw', pool: args.pool });
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => { try { releaseManualLock(); } catch {} process.exit(1); });
    }
    // TOCTOU: Bot könnte zwischen Wait und Lock gestartet haben → erneut warten.
    if (!(await waitForBotToFinish())) {
        abort('Bot-Aktion dauert an – bitte erneut versuchen.');
    }
}

// ─── Initialisierung ──────────────────────────────────────────────────────────

const db      = openDatabase();
const keypair = getKeypair();

syncPools(db, config.pools.all);

const pool = config.pools.all.find(p => p.pair === args.pool);
if (!pool) {
    const available = config.pools.all.map(p => p.pair).join(', ');
    abort(`Pool "${args.pool}" nicht gefunden. Verfügbare Pools: ${available}`);
}

console.log(`[withdraw] Pool:    ${pool.pair} (${pool.id})`);
if (useModeB) {
    console.log(`[withdraw] Anker:   ${modeBAmount} ${modeBToken} (Modus B)`);
} else if (useFull) {
    console.log(`[withdraw] Modus:   --full (Vollentnahme)`);
} else {
    console.log(`[withdraw] Betrag:  ${withdrawUsdc.toFixed(2)} USDC`);
}

// ─── Position prüfen ─────────────────────────────────────────────────────────

const position = getOpenPosition(db, pool.id);
if (!position) {
    abort(`Keine offene Position für "${pool.pair}".`);
}

console.log(`[withdraw] Position: ${position.nft_mint}`);

// ─── Aktuellen Preis + Positionsstatus abrufen ────────────────────────────────

const adapter = getAdapter(pool);

let stats;
try {
    stats = await adapter.getPoolStats(pool);
} catch (err) {
    abort(`Pool-Preis nicht abrufbar: ${err.message}`);
}

const currentPrice = stats.price;
const tokenALabel  = pool.usdcIsTokenA ? pool.pair.split('/')[1] : pool.pair.split('/')[0];
const tokenBLabel  = pool.usdcIsTokenA ? pool.pair.split('/')[0] : pool.pair.split('/')[1];
console.log(`[withdraw] Preis:   ${currentPrice.toFixed(4)} USDC/${tokenALabel}`);

// Quote-Preis für volatilePair-Pools (z.B. cbBTC/WBTC) aus pool_stats laden
let refPriceUsdWd = 0;
if (pool.volatilePair) {
    refPriceUsdWd = getTokenUsdPrice(pool.quoteTokenMint, db);
    if (refPriceUsdWd <= 0) abort(`Quote-Preis nicht verfügbar für ${pool.quoteTokenMint}. Bitte zuerst den Bot starten (pool_stats werden benötigt).`);
    const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
    const refLabel = quoteIsTokenA ? tokenALabel : tokenBLabel;
    console.log(`[withdraw] Quote: ${refPriceUsdWd.toFixed(2)} USDC/${refLabel}`);
}

let state;
try {
    state = await adapter.getPositionState(pool, position.nft_mint);
} catch (err) {
    abort(`Position-State nicht abrufbar: ${err.message}`);
}

if (!state.inRange) {
    console.warn(
        `[withdraw] ⚠ Position ist außerhalb der Range ` +
        `(${state.priceLower.toFixed(4)} – ${state.priceUpper.toFixed(4)} USDC). ` +
        `Entnahme trotzdem möglich – es wird nur der verfügbare Token zurückgegeben.`
    );
} else {
    console.log(`[withdraw] Range:   ${state.priceLower.toFixed(4)} – ${state.priceUpper.toFixed(4)} USDC  ✓ in Range`);
}

// ─── Betrag gegen Positionswert prüfen ───────────────────────────────────────

// Positionswert aus letztem Snapshot schätzen (für Plausibilitätsprüfung + Dry-Run)
const snapPos = db.prepare(
    'SELECT lp_value_usd, amount_a, amount_b FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1'
).get(pool.id);
const posValueEstimate = snapPos?.lp_value_usd ?? position.capital_usdc ?? 0;

// ─── Modus B: User-Token-Menge → USDC-Wert für decreaseLiquidity ─────────────
// Anker-Token-Menge gegen Position-Mix prüfen; daraus fraction und equivalenten USDC-Wert
// ermitteln. decreaseLiquidity arbeitet intern proportional → User erhält auch entsprechend
// vom anderen Token aus der Position.
if (useModeB) {
    const symAUp = tokenALabel.toUpperCase();
    const symBUp = tokenBLabel.toUpperCase();
    const symUp  = modeBToken.toUpperCase();

    const posA = snapPos?.amount_a ?? 0;
    const posB = snapPos?.amount_b ?? 0;
    let fraction;
    if (symUp === symAUp) {
        if (posA <= 0) abort(`Modus B: Position enthält aktuell 0 ${tokenALabel} (out-of-range). Bitte ${tokenBLabel} als Anker oder Modus A nutzen.`);
        fraction = modeBAmount / posA;
    } else if (symUp === symBUp) {
        if (posB <= 0) abort(`Modus B: Position enthält aktuell 0 ${tokenBLabel} (out-of-range). Bitte ${tokenALabel} als Anker oder Modus A nutzen.`);
        fraction = modeBAmount / posB;
    } else {
        abort(`Modus B: --token "${modeBToken}" ist keiner der Pool-Tokens (${tokenALabel} / ${tokenBLabel}).`);
    }
    if (fraction > 1.0001) {
        abort(`Modus B: ${modeBAmount} ${modeBToken} übersteigt Position-Anteil (${(symUp === symAUp ? posA : posB).toFixed(6)} verfügbar).`);
    }
    withdrawUsdc = fraction * posValueEstimate;
    console.log(`[withdraw] Modus B: ~${(fraction * 100).toFixed(2)}% der Position → ${withdrawUsdc.toFixed(2)} USDC-Äquivalent`);
}

// --full: Snapshot-Betrag ist nur eine Schätzung; On-Chain-Wert ist maßgeblich.
// Wir übergeben einen sehr großen Betrag → orca.js cappt fraction auf 1.0.
if (useFull) {
    withdrawUsdc = (posValueEstimate > 0 ? posValueEstimate : 1) * 1000;
    console.log(`[withdraw] --full: Vollentnahme (posValueEstimate ≈ ${posValueEstimate.toFixed(2)} USDC)`);
} else if (withdrawUsdc > posValueEstimate * 1.1) {
    abort(
        `Betrag (${withdrawUsdc.toFixed(2)} USDC) übersteigt den geschätzten Positionswert ` +
        `(${posValueEstimate.toFixed(2)} USDC).\n` +
        `         Zum vollständigen Schließen bitte --full verwenden.`
    );
}

// ─── Dry-Run: Schätzung ausgeben, keine TX ────────────────────────────────────

if (dryRun) {
    const fraction = posValueEstimate > 0 ? Math.min(withdrawUsdc / posValueEstimate, 1) : 0;
    const estA     = (snapPos?.amount_a ?? 0) * fraction;
    const estB     = (snapPos?.amount_b ?? 0) * fraction;
    let estUsdc;
    if (pool.volatilePair && refPriceUsdWd > 0) {
        const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
        if (quoteIsTokenA) estUsdc = (estA + (currentPrice > 0 ? estB / currentPrice : 0)) * refPriceUsdWd;
        else estUsdc = (estA * currentPrice + estB) * refPriceUsdWd;
    } else if (pool.usdcIsTokenA) {
        estUsdc = estA + (currentPrice > 0 ? estB / currentPrice : 0);
    } else {
        estUsdc = estA * currentPrice + estB;
    }

    console.log(`[withdraw] ── DRY-RUN ─────────────────────────────────────────`);
    console.log(`[withdraw] Positionswert: ~${posValueEstimate.toFixed(2)} USDC (letzter Snapshot)`);
    console.log(`[withdraw] Anteil:        ${(fraction * 100).toFixed(2)}%`);
    console.log(`[withdraw] Erwartet:      ~${estA.toFixed(6)} ${tokenALabel} + ~${estB.toFixed(6)} ${tokenBLabel}`);
    console.log(`[withdraw] USD-Wert:      ~${estUsdc.toFixed(2)} USDC`);
    console.log(`[withdraw] ── Keine Transaktion ausgeführt (--dry-run) ─────────`);
    Object.assign(jsonResult, {
        mode: 'decreaseLiquidity', dryRun: true,
        fraction, posValueEstimate,
        estimatedTokenA: estA, estimatedTokenB: estB, estimatedUsdc: estUsdc,
        tokenALabel, tokenBLabel,
    });
    db.close();
    successExit();
}

// ─── Wallet-Info ausgeben ─────────────────────────────────────────────────────

const walletUsdc = await getUsdcBalance(keypair.publicKey);
const walletSol  = await getUsableSolBalance(keypair.publicKey);
console.log(`[withdraw] Wallet:  ${walletSol.toFixed(6)} SOL (nutzbar) + ${walletUsdc.toFixed(2)} USDC`);
console.log(`[withdraw] Slippage: ${SLIPPAGE_PCT_STR}`);

// ─── decreaseLiquidity ausführen ──────────────────────────────────────────────

let result;
try {
    result = await adapter.decreaseLiquidity(pool, position.nft_mint, withdrawUsdc, WITHDRAW_SLIPPAGE, refPriceUsdWd);
} catch (err) {
    if (err.solBalance !== undefined) {
        // Selbstheilung wie bei deposit.js: erst USDC→SOL nachtanken, dann retryen.
        console.warn(`[withdraw] decreaseLiquidity: zu wenig SOL (${err.solBalance.toFixed(4)}) – versuche Selbstheilung...`);
        const healedSol = await _autoTopUpSol(err.solBalance, config.solReserve + 0.01);
        // Retry auch dann, wenn das Topup die Reserve NICHT erreicht hat: ein
        // Withdraw gibt Kapital frei und darf nie an der Reserve scheitern —
        // die existiert genau dafür (2026-07-29, siehe assertSufficientSolForExit()
        // in lib/wallet.js). Der Adapter hat jetzt seinen eigenen, physikalischen
        // Boden; landet die TX wirklich nicht, scheitert sie dort mit klarer Meldung.
        if (healedSol < config.solReserve) {
            console.warn(`[withdraw] Topup hat die Reserve nicht erreicht (${healedSol.toFixed(4)} SOL) – Retry trotzdem, Ausstieg hat Vorrang`);
            await notify.solLow(healedSol).catch(() => {});
        } else {
            console.log(`[withdraw] SOL-Selbstheilung OK (${healedSol.toFixed(4)} SOL) – Retry decreaseLiquidity...`);
        }
        try {
            result = await adapter.decreaseLiquidity(pool, position.nft_mint, withdrawUsdc, WITHDRAW_SLIPPAGE, refPriceUsdWd);
        } catch (err2) {
            await notify.solLow(err2.solBalance ?? healedSol).catch(() => {});
            db.close();
            abort(err2.message);
        }
    } else {
        let msg;
        if (isSlippageError(err)) {
            msg =
                `SLIPPAGE-FEHLER (>${SLIPPAGE_PCT_STR}): Preis hat sich während der Transaktion ` +
                `zu stark bewegt. Erneut versuchen oder --usdc-Betrag anpassen.`;
        } else if (isInsufficientFundsError(err)) {
            msg = await _describeInsufficientFundsWithdraw(keypair);
        } else {
            logActionError(`withdraw decreaseLiquidity ${pool.pair}`, err);
            const { reason, detail } = describeError(err);
            msg = `decreaseLiquidity fehlgeschlagen – ${reason}\n${detail}`;
        }
        await notify.errorRaw(`withdraw ${pool.pair}`, msg);
        db.close();
        abort(msg);
    }
}

// ─── DB-Buchführung ───────────────────────────────────────────────────────────

let withdrawnUsdc;
if (pool.volatilePair && refPriceUsdWd > 0) {
    const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
    if (quoteIsTokenA) withdrawnUsdc = (result.tokenEstA + (currentPrice > 0 ? result.tokenEstB / currentPrice : 0)) * refPriceUsdWd;
    else withdrawnUsdc = (result.tokenEstA * currentPrice + result.tokenEstB) * refPriceUsdWd;
} else if (pool.usdcIsTokenA) {
    withdrawnUsdc = result.tokenEstA + (currentPrice > 0 ? result.tokenEstB / currentPrice : 0);
} else {
    withdrawnUsdc = result.tokenEstA * currentPrice + result.tokenEstB;
}

const oldCapital = position.capital_usdc ?? 0;
const newCapital = Math.max(0, oldCapital - withdrawnUsdc);
updatePositionCapital(db, position.id, newCapital);
updatePositionHodl(db, position.id, -result.tokenEstA, -result.tokenEstB);

// Sofort-Snapshot: Dashboard zeigt neuen LP-Wert sofort, ohne auf den nächsten Bot-Tick zu warten.
// Nur bei Teilentnahme — bei vollständiger Entnahme (isFull) ist die Position geschlossen.
// writePositionSnapshotFromDelta nutzt die zentrale makeToUsd-Logik (inkl. volatilePair-Zweig
// mit Quote-Token-USD-Konversion), damit Pools wie ORCA/SOL oder HYPE/SOL korrekt in USD
// gerechnet werden statt in SOL-Einheiten.
if (result.fraction < 0.999) {
    writePositionSnapshotFromDelta(db, pool, -result.tokenEstA, -result.tokenEstB, currentPrice);
}

// Echter Kapital-Abfluss → capital_flows-Eintrag (Quelle für netDeposited).
// balance_snapshot bleibt für Audit auf null — wird nicht mehr als Baseline gelesen.
insertCapitalFlow(db, {
    poolId:          pool.id,
    usdcAmount:      -withdrawnUsdc,   // negativ = Entnahme
    balanceSnapshot: null,
    txHash:          result.txHash,
    note:            'Manueller Withdraw (decreaseLiquidity)',
});

const isFull = result.fraction >= 0.999;
const withdrawFee = await getTxFee(result.txHash);
insertTransaction(db, {
    poolId:   pool.id,
    type:     isFull ? 'withdraw_full' : 'withdraw',
    amountA:  result.tokenEstA,
    amountB:  result.tokenEstB,
    usdValue: withdrawnUsdc,
    txHash:   result.txHash,
    txFeeSol: withdrawFee,
    note:     'Manueller Withdraw (decreaseLiquidity)',
});

// Position als geschlossen markieren wenn 100% entnommen
if (isFull) {
    closePosition(db, position.id, result.txHash);
    console.log(`[withdraw] Position als geschlossen markiert (closed_at gesetzt).`);
    if (setPoolActive(pool.id, false)) {
        console.log(`[withdraw] Pool ${pool.id} auf active=false gesetzt (DB).`);
    }
}

// HWM zurücksetzen bei Teilentnahme: Kapital hat sich verändert, neuer Referenzwert
// wird im nächsten Bot-Snapshot etabliert. Bei Vollentnahme entfällt dies (Position closed).
if (!isFull) {
    db.prepare('UPDATE positions SET hwm_usd = NULL, hwm_at = NULL, hwm_base_adjustment = NULL WHERE pool_id = ? AND closed_at IS NULL').run(pool.id);
    console.log(`[withdraw] HWM zurückgesetzt – wird beim nächsten Snapshot neu etabliert`);
}

// Pool Mindestwert deaktivieren: Nach einer Auszahlung ist der konfigurierte Wert
// nicht mehr sinnvoll (Kapital hat sich verändert). User muss neu konfigurieren.
const clearedMinValue = clearMinimumValue(pool.id);
if (clearedMinValue != null) {
    console.log(`[withdraw] Pool Mindestwert (${Math.round(clearedMinValue)} USDC) deaktiviert – Auszahlung hat Kapital verändert`);
}

// ─── Swap → USDC / Senden an (optional) ───────────────────────────────────────
// Best-effort: Die Auszahlung selbst ist bereits abgeschlossen (Coins sind im Wallet).
// Ein Fehler hier darf den Withdraw nicht als fehlgeschlagen melden — er wird separat
// geloggt/notified, die Coins bleiben in diesem Fall unverändert im Wallet.
let swappedUsdc  = null;
let followUpTxHash = null;
let followUpError  = null;
if (swapToUsdcFlag || sendToAddr) {
    try {
        if (swapToUsdcFlag) {
            console.log(`[withdraw] Swap → USDC gestartet…`);
            swappedUsdc = await executeSwapStep(pool, {
                coinsA: result.tokenEstA,
                coinsB: result.tokenEstB,
                sendTo: sendToAddr,
                logPrefix: '[withdraw]',
                forceCoins: true,
            });
        }
        if (sendToAddr) {
            followUpTxHash = await executeTransferStep(pool, {
                coinsA: result.tokenEstA,
                coinsB: result.tokenEstB,
                swappedUsdc,
                sendTo: sendToAddr,
                swapToUsdc: swapToUsdcFlag,
                logPrefix: '[withdraw]',
            });
        }
    } catch (err) {
        followUpError = err.message ?? String(err);
        console.error(`[withdraw] Swap/Transfer fehlgeschlagen: ${followUpError} – Coins verbleiben im Wallet.`);
        await notify.error(`withdraw ${pool.pair} (Swap/Transfer)`, err);
    }
}

// ─── Ergebnis ─────────────────────────────────────────────────────────────────

console.log(`[withdraw] ✓ Entnahme erfolgreich`);
console.log(`[withdraw] TX:       ${result.txHash}`);
console.log(`[withdraw] Erhalten: ${result.tokenEstA.toFixed(6)} ${tokenALabel} + ${result.tokenEstB.toFixed(6)} ${tokenBLabel}`);
console.log(`[withdraw] Wert:     ~${withdrawnUsdc.toFixed(2)} USDC (${(result.fraction * 100).toFixed(2)}% der Position)`);
console.log(`[withdraw] Kapital:  ${oldCapital.toFixed(2)} → ${newCapital.toFixed(2)} USDC`);

await notify.withdrawCompleted(pool, withdrawUsdc, result.tokenEstA, result.tokenEstB, result.fraction, result.txHash);
if (clearedMinValue != null) {
    await notify.minimumValueCleared(pool, clearedMinValue);
}

// Portfolio + Wallet-Snapshot + Sync in einem orchestrierten Schritt
// (lib/refresh-state.js — Pos-Snapshot wurde oben bereits geschrieben).
await refreshAfterAction(db);
db.close();
Object.assign(jsonResult, {
    mode: 'decreaseLiquidity',
    txHash: result.txHash,
    receivedTokenA: result.tokenEstA,
    receivedTokenB: result.tokenEstB,
    withdrawnUsdc, fraction: result.fraction,
    capitalUsdc: newCapital,
    isFull,
    tokenALabel, tokenBLabel,
    swapToUsdc: swapToUsdcFlag,
    sendTo: sendToAddr || null,
    swappedUsdc,
    followUpTxHash,
    followUpError,
});
successExit();
