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
import { t } from '../../../lib/i18n.js';
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
    console.log(t('cli.lw.help'));
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
    const errMsg = t('cli.lw.usage');
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
    const msg = t('cli.liq.invalid_usdc', { value: args.usdc });
    if (jsonMode) { emitJson(false, msg); process.exit(1); }
    console.error(`[withdraw] ${msg}`);
    process.exit(1);
}
if (useModeB && (isNaN(modeBAmount) || modeBAmount <= 0)) {
    const msg = t('cli.liq.invalid_token_amount', { value: args.amount });
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
        const msg = t('cli.liq.invalid_recipient', { value: sendToAddr });
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
        return t('cli.lw.insufficient_unknown_sol');
    }
    return freshSol < 0.05
        ? t('cli.lw.insufficient_low_sol', { sol: freshSol.toFixed(4) })
        : t('cli.lw.insufficient_sol_ok', { sol: freshSol.toFixed(4) });
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
        console.warn(`[withdraw] ${t('cli.liq.topup_no_price')}`);
        return currentBalance;
    }
    const target     = minNeeded + 0.01; // kleiner Extra-Puffer
    const neededSol  = target - currentBalance;
    const neededUsdc = neededSol * solPrice * 1.02; // +2% Slippage-Puffer
    const usdcBal    = await getTokenBalanceFresh(getKeypair().publicKey, USDC_MINT, 6);
    if (usdcBal < neededUsdc) {
        console.warn(`[withdraw] ${t('cli.liq.topup_no_usdc', { have: usdcBal.toFixed(2), need: neededUsdc.toFixed(2) })}`);
        return currentBalance;
    }
    console.log(`[withdraw] ${t('cli.liq.topup_swapping', { sol: currentBalance.toFixed(4), min: minNeeded.toFixed(4), usdc: neededUsdc.toFixed(2) })}`);
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
        console.log(`[withdraw] ${t('cli.liq.topup_ok', { sol: newBalance.toFixed(4) })}`);
        return newBalance;
    } catch (err) {
        console.warn(`[withdraw] ${t('cli.liq.topup_failed', { error: err.message })}`);
        return currentBalance;
    }
}

function abort(msg) {
    if (jsonMode) {
        try { releaseManualLock(); } catch {}
        emitJson(false, msg);
        process.exit(1);
    }
    console.error(`[withdraw] ${t('cli.liq.error_word')}: ${msg}`);
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
    if (jsonMode) { emitJson(false, t('cli.common.unexpected', { error: msg })); }
    process.exit(1);
}
process.on('uncaughtException',  _fatalHandler);
process.on('unhandledRejection', _fatalHandler);

// ─── Manual-Lock acquire (im dry-run nicht nötig) ─────────────────────────────

if (!dryRun) {
    if (isCleanupRunning()) abort(t('cli.liq.lock_cleanup'));
    if (isSlLocked())         abort(t('cli.liq.lock_sl'));
    // Bot hat Vorrang: warten bis Claim/Reinvest/Rebalancing fertig sind.
    if (!(await waitForBotToFinish())) {
        abort(t('cli.liq.lock_bot_active'));
    }
    acquireManualLock({ action: 'withdraw', pool: args.pool });
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => { try { releaseManualLock(); } catch {} process.exit(1); });
    }
    // TOCTOU: Bot könnte zwischen Wait und Lock gestartet haben → erneut warten.
    if (!(await waitForBotToFinish())) {
        abort(t('cli.liq.lock_bot_busy'));
    }
}

// ─── Initialisierung ──────────────────────────────────────────────────────────

const db      = openDatabase();
const keypair = getKeypair();

syncPools(db, config.pools.all);

const pool = config.pools.all.find(p => p.pair === args.pool);
if (!pool) {
    const available = config.pools.all.map(p => p.pair).join(', ');
    abort(t('cli.liq.pool_not_found_list', { pool: args.pool, list: available }));
}

console.log(`[withdraw] Pool:    ${pool.pair} (${pool.id})`);
if (useModeB) {
    console.log(`[withdraw] ${t('cli.lw.head_anchor', { amount: modeBAmount, token: modeBToken })}`);
} else if (useFull) {
    console.log(`[withdraw] ${t('cli.lw.head_full')}`);
} else {
    console.log(`[withdraw] ${t('cli.liq.head_amount', { v: `${withdrawUsdc.toFixed(2)} USDC` })}`);
}

// ─── Position prüfen ─────────────────────────────────────────────────────────

const position = getOpenPosition(db, pool.id);
if (!position) {
    abort(t('cli.lw.no_position', { pool: pool.pair }));
}

console.log(`[withdraw] Position: ${position.nft_mint}`);

// ─── Aktuellen Preis + Positionsstatus abrufen ────────────────────────────────

const adapter = getAdapter(pool);

let stats;
try {
    stats = await adapter.getPoolStats(pool);
} catch (err) {
    abort(t('cli.liq.price_unavailable', { error: err.message }));
}

const currentPrice = stats.price;
const tokenALabel  = pool.usdcIsTokenA ? pool.pair.split('/')[1] : pool.pair.split('/')[0];
const tokenBLabel  = pool.usdcIsTokenA ? pool.pair.split('/')[0] : pool.pair.split('/')[1];
console.log(`[withdraw] ${t('cli.liq.head_price', { v: `${currentPrice.toFixed(4)} USDC/${tokenALabel}` })}`);

// Quote-Preis für volatilePair-Pools (z.B. cbBTC/WBTC) aus pool_stats laden
let refPriceUsdWd = 0;
if (pool.volatilePair) {
    refPriceUsdWd = getTokenUsdPrice(pool.quoteTokenMint, db);
    if (refPriceUsdWd <= 0) abort(t('cli.liq.quote_price_missing', { mint: pool.quoteTokenMint }));
    const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
    const refLabel = quoteIsTokenA ? tokenALabel : tokenBLabel;
    console.log(`[withdraw] Quote: ${refPriceUsdWd.toFixed(2)} USDC/${refLabel}`);
}

let state;
try {
    state = await adapter.getPositionState(pool, position.nft_mint);
} catch (err) {
    abort(t('cli.liq.state_unavailable', { error: err.message }));
}

if (!state.inRange) {
    console.warn(`[withdraw] ⚠ ${t('cli.lw.oor_warning', { lower: state.priceLower.toFixed(4), upper: state.priceUpper.toFixed(4) })}`);
} else {
    console.log(`[withdraw] ${t('cli.liq.head_range_ok', { lower: state.priceLower.toFixed(4), upper: state.priceUpper.toFixed(4) })}`);
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
        if (posA <= 0) abort(t('cli.lw.mode_b_zero', { zero: tokenALabel, other: tokenBLabel }));
        fraction = modeBAmount / posA;
    } else if (symUp === symBUp) {
        if (posB <= 0) abort(t('cli.lw.mode_b_zero', { zero: tokenBLabel, other: tokenALabel }));
        fraction = modeBAmount / posB;
    } else {
        abort(t('cli.liq.mode_b_wrong_token', { token: modeBToken, tokenA: tokenALabel, tokenB: tokenBLabel }));
    }
    if (fraction > 1.0001) {
        abort(t('cli.lw.mode_b_exceeds', { amount: modeBAmount, token: modeBToken, available: (symUp === symAUp ? posA : posB).toFixed(6) }));
    }
    withdrawUsdc = fraction * posValueEstimate;
    console.log(`[withdraw] ${t('cli.lw.mode_b_fraction', { pct: (fraction * 100).toFixed(2), usdc: withdrawUsdc.toFixed(2) })}`);
}

// --full: Snapshot-Betrag ist nur eine Schätzung; On-Chain-Wert ist maßgeblich.
// Wir übergeben einen sehr großen Betrag → orca.js cappt fraction auf 1.0.
if (useFull) {
    withdrawUsdc = (posValueEstimate > 0 ? posValueEstimate : 1) * 1000;
    console.log(`[withdraw] ${t('cli.lw.full_estimate', { usdc: posValueEstimate.toFixed(2) })}`);
} else if (withdrawUsdc > posValueEstimate * 1.1) {
    abort(t('cli.lw.exceeds_position', { amount: withdrawUsdc.toFixed(2), value: posValueEstimate.toFixed(2) }));
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
    console.log(`[withdraw] ${t('cli.lw.dry_pos_value', { usdc: posValueEstimate.toFixed(2) })}`);
    console.log(`[withdraw] ${t('cli.lw.dry_fraction', { pct: (fraction * 100).toFixed(2) })}`);
    console.log(`[withdraw] ${t('cli.lw.dry_expected', { a: estA.toFixed(6), tokenA: tokenALabel, b: estB.toFixed(6), tokenB: tokenBLabel })}`);
    console.log(`[withdraw] ${t('cli.lw.dry_usd_value', { usdc: estUsdc.toFixed(2) })}`);
    console.log(`[withdraw] ── ${t('cli.liq.dry_no_tx')} ─────────`);
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
console.log(`[withdraw] ${t('cli.lw.head_wallet', { sol: walletSol.toFixed(6), usdc: walletUsdc.toFixed(2) })}`);
console.log(`[withdraw] Slippage: ${SLIPPAGE_PCT_STR}`);

// ─── decreaseLiquidity ausführen ──────────────────────────────────────────────

let result;
try {
    result = await adapter.decreaseLiquidity(pool, position.nft_mint, withdrawUsdc, WITHDRAW_SLIPPAGE, refPriceUsdWd);
} catch (err) {
    if (err.solBalance !== undefined) {
        // Selbstheilung wie bei deposit.js: erst USDC→SOL nachtanken, dann retryen.
        console.warn(`[withdraw] ${t('cli.liq.low_sol_selfheal', { step: 'decreaseLiquidity', sol: err.solBalance.toFixed(4) })}`);
        const healedSol = await _autoTopUpSol(err.solBalance, config.solReserve + 0.01);
        // Retry auch dann, wenn das Topup die Reserve NICHT erreicht hat: ein
        // Withdraw gibt Kapital frei und darf nie an der Reserve scheitern —
        // die existiert genau dafür (2026-07-29, siehe assertSufficientSolForExit()
        // in lib/wallet.js). Der Adapter hat jetzt seinen eigenen, physikalischen
        // Boden; landet die TX wirklich nicht, scheitert sie dort mit klarer Meldung.
        if (healedSol < config.solReserve) {
            console.warn(`[withdraw] ${t('cli.lw.topup_below_reserve', { sol: healedSol.toFixed(4) })}`);
            await notify.solLow(healedSol).catch(() => {});
        } else {
            console.log(`[withdraw] ${t('cli.liq.selfheal_ok', { sol: healedSol.toFixed(4), step: 'decreaseLiquidity' })}`);
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
            msg = t('cli.liq.slippage_error', { slip: SLIPPAGE_PCT_STR });
        } else if (isInsufficientFundsError(err)) {
            msg = await _describeInsufficientFundsWithdraw(keypair);
        } else {
            logActionError(`withdraw decreaseLiquidity ${pool.pair}`, err);
            const { reasonKey, reasonParams, detail } = describeError(err);
            msg = t('cli.liq.step_failed', { step: 'decreaseLiquidity', reason: t(reasonKey, reasonParams), detail });
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
    console.log(`[withdraw] ${t('cli.lw.position_closed')}`);
    if (setPoolActive(pool.id, false)) {
        console.log(`[withdraw] ${t('cli.liq.pool_deactivated', { pool: pool.id })}`);
    }
}

// HWM zurücksetzen bei Teilentnahme: Kapital hat sich verändert, neuer Referenzwert
// wird im nächsten Bot-Snapshot etabliert. Bei Vollentnahme entfällt dies (Position closed).
if (!isFull) {
    db.prepare('UPDATE positions SET hwm_usd = NULL, hwm_at = NULL, hwm_base_adjustment = NULL WHERE pool_id = ? AND closed_at IS NULL').run(pool.id);
    console.log(`[withdraw] ${t('cli.liq.hwm_reset')}`);
}

// Pool Mindestwert deaktivieren: Nach einer Auszahlung ist der konfigurierte Wert
// nicht mehr sinnvoll (Kapital hat sich verändert). User muss neu konfigurieren.
const clearedMinValue = clearMinimumValue(pool.id);
if (clearedMinValue != null) {
    console.log(`[withdraw] ${t('cli.lw.min_value_cleared', { usdc: Math.round(clearedMinValue) })}`);
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
            console.log(`[withdraw] ${t('cli.lw.swap_started')}`);
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
        console.error(`[withdraw] ${t('cli.lw.followup_failed', { error: followUpError })}`);
        await notify.error(`withdraw ${pool.pair} (Swap/Transfer)`, err);
    }
}

// ─── Ergebnis ─────────────────────────────────────────────────────────────────

console.log(`[withdraw] ✓ ${t('cli.lw.success')}`);
console.log(`[withdraw] TX:       ${result.txHash}`);
console.log(`[withdraw] ${t('cli.lw.received', { a: result.tokenEstA.toFixed(6), tokenA: tokenALabel, b: result.tokenEstB.toFixed(6), tokenB: tokenBLabel })}`);
console.log(`[withdraw] ${t('cli.lw.value', { usdc: withdrawnUsdc.toFixed(2), pct: (result.fraction * 100).toFixed(2) })}`);
console.log(`[withdraw] ${t('cli.liq.head_capital_change', { old: oldCapital.toFixed(2), new: newCapital.toFixed(2) })}`);

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
