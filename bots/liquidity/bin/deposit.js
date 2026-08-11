/**
 * FORGE Liquidity – Manuelles Einzahlen in einen Pool
 *
 * Fügt einer bestehenden Position via increaseLiquidity Kapital hinzu,
 * oder eröffnet (mit --new) eine neue Position.
 *
 * Verwendung:
 *   node bin/deposit.js --pool "SOL/USDC"    --usdc 500
 *   node bin/deposit.js --pool "cbBTC/USDC"  --usdc 200 --new
 *   node bin/deposit.js --pool "EURC/USDC"   --tokenb 85
 *   node bin/deposit.js --pool "EURC/USDC"   --usdc 100 --dry-run
 *   node bin/deposit.js --pool "SOL/USDC"    --token SOL --amount 0.5     (Modus B)
 *   node bin/deposit.js --pool "cbBTC/WBTC"  --token cbBTC --amount 0.001 (Modus B)
 *
 * Optionen:
 *   --pool <pair>     Pool-Paar, z.B. "SOL/USDC" oder "EURC/USDC"  (Pflicht)
 *   --usdc <betrag>   Modus A: USDC-Budget (Pre-Swap zu Pool-Tokens)
 *   --tokenb <betrag> Direkt tokenB-Betrag einzahlen (Legacy)
 *   --token <symbol>  Modus B: Anker-Token, gegen-Menge folgt via Pool-Ratio
 *   --amount <betrag> Menge des Anker-Tokens (zusammen mit --token)
 *   Genau eines von --usdc / --tokenb / (--token + --amount) ist Pflicht.
 *   --new             Neue Position erlauben wenn keine existiert
 *   --dry-run         Simulation: alle Checks + Berechnungen, keine On-Chain-TX
 *   --json            Maschinenlesbarer Output (für UI-Integration)
 *
 * Mindestbeträge (Modus A):
 *   - bestehende Position, Standard:     5 USDC
 *   - bestehende Position, volatilePair: 10 USDC (2 Swaps nötig)
 *   - neue Position (--new):            20 USDC (zzgl. Account-Rent)
 *   - Modus B: keine Mindestbeträge (kein Swap)
 *
 * Abbruchbedingungen:
 *   - Pool nicht gefunden
 *   - Keine offene Position und --new nicht gesetzt
 *   - Position außerhalb der Range (nur bei increaseLiquidity)
 *   - USDC-/Token-Guthaben zu niedrig
 *   - Slippage > 0,5% → klare Fehlermeldung im Log + Telegram
 *   - Cleanup oder SL läuft → Abbruch mit Hinweis (Retry in 30s)
 */

import { parseArgs }   from 'node:util';
import { config, setPoolActive, isPoolEnabled } from '../lib/config.js';
import { ensureScoreLimitEnabled, ensureTvlProtectionDefaults, ensureTrailingStopMinimumReset } from '../lib/settings-auto.js';
import {
    openDatabase, syncPools, getOpenPosition,
    insertPosition, insertTransaction, updatePositionCapital, updatePositionHodl, insertCapitalFlow,
    insertPositionSnapshot, insertPoolStats, clearPositionSnapshots,
} from '../lib/db.js';
// Performance-Segments seit v0.3.47 nicht mehr geschrieben — Baseline = netDeposited.
import { getAdapter }        from '../lib/pool-adapter/index.js';
import { calculateRange }    from '../lib/range.js';
import {
    getKeypair, getUsdcBalance, getUsableSolBalance, getTokenBalance,
    getTokenBalanceFresh, getUsableSolBalanceFresh, getSolBalanceFresh, getConnection, getTxFee, USDC_MINT,
} from '../lib/wallet.js';
import { swapTokens } from '../lib/swap.js';
import * as notify           from '../lib/notify.js';
import { getSplTokensUsd } from '../lib/wallet-monitor-client.js';
import { refreshAfterAction } from '../lib/refresh-state.js';
import { logActionError } from '../lib/error-log.js';
import { matchErrorCode, describeError } from '../../../lib/error-messages.js';
import { t } from '../../../lib/i18n.js';
import { PoolUtil, PriceMath } from '@orca-so/whirlpools-sdk';
import { PublicKey }           from '@solana/web3.js';
import {
    clmmTokenAForDeposit, calcDepositedUsdc, getTokenUsdPrice,
    DEPOSIT_SLIPPAGE, SLIPPAGE_FACTOR,
} from '../lib/deposit-lib.js';
import {
    acquireManualLock, releaseManualLock,
    isCleanupRunning, isSlLocked, isRebalanceLocked,
    waitForBotToFinish,
} from '../lib/cleanup-lock.js';
import Decimal                 from 'decimal.js';
import BN                      from 'bn.js';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const SLIPPAGE_PCT_STR = '0,5 %';

// Native SOL / WSOL Mint (für tokenA-Balance-Check)
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Mindestbeträge in USDC (Modus A) – schützen vor unwirtschaftlichen Mikro-Deposits.
// Niedrig gewählt: Solana-TX-Fees + 0,5 % Slippage sind bei 1 USDC noch tragbar.
const MIN_USDC_DEPOSIT_STANDARD = 1.00;
const MIN_USDC_DEPOSIT_BTCPAIR  = 2.00;
const MIN_USDC_DEPOSIT_NEW      = 5.00;

// ─── CLI-Args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        pool:      { type: 'string' },
        usdc:      { type: 'string' },
        tokenb:    { type: 'string' },
        token:     { type: 'string' },
        amount:    { type: 'string' },
        'max-a':   { type: 'string' },   // Modus C: beide Seiten als Obergrenze (Engpass-Logik)
        'max-b':   { type: 'string' },
        new:       { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        json:      { type: 'boolean', default: false },
        help:      { type: 'boolean', default: false, short: 'h' },
    },
    strict: true,
});

// Muss vor jedem Seiteneffekt (openDatabase() weiter unten) geprüft werden.
if (args.help) {
    console.log(t('cli.ld.help'));
    process.exit(0);
}

const jsonMode = args.json;

// ─── JSON-Output-Sammler ──────────────────────────────────────────────────────
// Im JSON-Modus wird alle Log-Ausgabe gesammelt und am Ende als ein JSON-Objekt
// auf stdout geschrieben. Damit kann ein Express-Handler den Output zuverlässig
// parsen (statt zeilenweise Logs zu scrapen).

const jsonLog    = [];
const jsonResult = {};
const _origLog   = console.log.bind(console);
const _origErr   = console.error.bind(console);
const _origWarn  = console.warn.bind(console);

if (jsonMode) {
    console.log   = (...a) => jsonLog.push({ level: 'info', msg: a.join(' ') });
    console.warn  = (...a) => jsonLog.push({ level: 'warn', msg: a.join(' ') });
    console.error = (...a) => jsonLog.push({ level: 'error', msg: a.join(' ') });
}

/**
 * @param {string|null} errorCode  Stabiler Fehlerschlüssel für Aufrufer, die auf einen
 *   bestimmten Fehlertyp reagieren müssen (Settings-UI: 30s-Retry statt Abbruch).
 *
 * 🔒 Warum ein Code und nicht der Text: die Settings-UI hat bis 2026-08-11 den
 * MELDUNGSTEXT verglichen ("beginnt mit 'Wallet-Balance konnte nicht gelesen
 * werden'"). Mit der Mehrsprachigkeit übersetzt das Frontend seine Vergleichs-
 * texte — der Abgleich gegen die (deutsche) Skriptmeldung ging damit auf einer
 * englischen Installation still ins Leere und der Retry-Ablauf entfiel.
 * Ein Vergleich auf Prosa ist auch ohne Übersetzung fragil: eine umformulierte
 * Meldung hätte dasselbe bewirkt.
 */
function emitJson(ok, errorMsg = null, errorCode = null) {
    const payload = { ok, error: errorMsg, errorCode, log: jsonLog, result: jsonResult };
    _origLog(JSON.stringify(payload));
}

// ─── Argumentvalidierung ──────────────────────────────────────────────────────

const hasUsdc    = args.usdc    != null;
const hasTokenB  = args.tokenb  != null;
const hasModeB   = args.token   != null && args.amount != null;
const hasMaxPair = args['max-a'] != null && args['max-b'] != null;

// Genau einer der vier Modi muss aktiv sein
const modeCount = [hasUsdc, hasTokenB, hasModeB, hasMaxPair].filter(Boolean).length;
if (!args.pool || modeCount !== 1) {
    const errMsg = 'Verwendung: --pool <pair> + (--usdc <n> | --tokenb <n> | --token <sym> --amount <n> | --max-a <n> --max-b <n>) [--new] [--dry-run] [--json]';
    if (jsonMode) { emitJson(false, errMsg); process.exit(1); }
    console.error(errMsg);
    process.exit(1);
}

const useTokenB     = hasTokenB;
const useModeB      = hasModeB;
const useMaxPair    = hasMaxPair;
const useModeBOrC   = useModeB || useMaxPair;  // gemeinsamer Branch: Modus B + Modus C
const dryRun        = args['dry-run'];
const modeBToken    = useModeB ? args.token : null;
const modeBAmount   = useModeB ? parseFloat(args.amount) : NaN;
const maxAArg       = useMaxPair ? parseFloat(args['max-a']) : NaN;
const maxBArg       = useMaxPair ? parseFloat(args['max-b']) : NaN;
let   depositAmount = hasUsdc ? parseFloat(args.usdc) : (hasTokenB ? parseFloat(args.tokenb) : (useModeB ? modeBAmount : Math.max(maxAArg, maxBArg)));

if (useMaxPair && (isNaN(maxAArg) || maxAArg <= 0 || isNaN(maxBArg) || maxBArg <= 0)) {
    const msg = t('cli.ld.invalid_pair_amounts', { maxA: args['max-a'], maxB: args['max-b'] });
    if (jsonMode) { emitJson(false, msg); process.exit(1); }
    console.error(`[deposit] ${msg}`);
    process.exit(1);
}
if (!useMaxPair && (isNaN(depositAmount) || depositAmount <= 0)) {
    const raw = args.usdc ?? args.tokenb ?? args.amount;
    const msg = t('cli.ld.invalid_amount', { value: raw });
    if (jsonMode) { emitJson(false, msg); process.exit(1); }
    console.error(`[deposit] ${msg}`);
    process.exit(1);
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** Gibt TokenA-Balance zurück: native SOL (nutzbar) oder beliebiges SPL-Token */
async function getTokenABalance(keypair, pool) {
    if (pool.tokenA === WSOL_MINT || pool.pair.toUpperCase().startsWith('SOL/')) {
        return getUsableSolBalance(keypair.publicKey);
    }
    return getTokenBalance(keypair.publicKey, new PublicKey(pool.tokenA), pool.decimalsA);
}

/** Gibt TokenB-Balance zurück (SOL-aware: nutzt native Balance wenn tokenB = WSOL_MINT) */
async function getTokenBBalance(keypair, pool) {
    if (pool.tokenB === WSOL_MINT) {
        return getUsableSolBalance(keypair.publicKey);
    }
    return getTokenBalance(keypair.publicKey, new PublicKey(pool.tokenB), pool.decimalsB);
}


/** Erkennt Slippage-Fehler aus Orca-Fehlermeldungen */
function isSlippageError(err) {
    return matchErrorCode(err) === 'SLIPPAGE';
}

/** Erkennt Routing-Fehler (ungültige Route durch Preisbewegung) */
function isRoutingError(err) {
    return matchErrorCode(err) === 'ROUTING';
}

/** Erkennt "insufficient funds" (SPL-Token-Program 0x1) – Wallet hat weniger als angefordert. */
function isInsufficientFundsError(err) {
    return matchErrorCode(err) === 'INSUFFICIENT_FUNDS';
}

/**
 * Baut eine konkrete "nicht genug Guthaben"-Meldung: liest die aktuellen Wallet-Stände
 * frisch (können sich seit dem angeforderten amountA/amountB verändert haben, z.B. durch
 * einen zwischenzeitlichen Cleanup-Lauf) und vergleicht sie mit dem, was die Transaktion
 * wollte. Meldet SOL separat, falls das die Ursache sein könnte (TX-Fee/Rent).
 */
async function _describeInsufficientFunds(pool, amountA, amountB, tokenALabel, tokenBLabel) {
    const kp = getKeypair();
    const [freshA, freshB, freshSol] = await Promise.all([
        getTokenBalanceFresh(kp.publicKey, new PublicKey(pool.tokenA), pool.decimalsA).catch(() => null),
        getTokenBalanceFresh(kp.publicKey, new PublicKey(pool.tokenB), pool.decimalsB).catch(() => null),
        getSolBalanceFresh(kp.publicKey).catch(() => null),
    ]);
    const lines = [t('cli.ld.insufficient_hdr')];
    if (freshA != null) {
        lines.push(`         ${t('cli.ld.insufficient_token', { token: tokenALabel, requested: amountA.toFixed(6), wallet: freshA.toFixed(6) })}`);
    }
    if (freshB != null) {
        lines.push(`         ${t('cli.ld.insufficient_token', { token: tokenBLabel, requested: amountB.toFixed(6), wallet: freshB.toFixed(6) })}`);
    }
    if (freshSol != null) {
        lines.push(freshSol < 0.05
            ? `         ${t('cli.ld.insufficient_sol_low', { sol: freshSol.toFixed(4) })}`
            : `         ${t('cli.ld.insufficient_sol_ok', { sol: freshSol.toFixed(4) })}`);
    }
    lines.push(`         ${t('cli.ld.insufficient_footer')}`);
    return lines.join('\n');
}

/**
 * Selbstheilung SOL-Engpass: tauscht USDC → SOL, bis mindestens minNeeded erreicht ist.
 * Wiederverwendet vom Upfront-Check (vor allen TXs) UND vom Retry nach einem
 * assertSufficientSol()-Fehlschlag mitten in increaseLiquidity/openPosition — letzteres
 * kann passieren, wenn SOL zwischen Upfront-Check und der eigentlichen TX-Ausführung durch
 * einen Pre-Swap/andere Fees unter die Reserve fällt.
 * @returns {number} tatsächlicher SOL-Stand nach dem Versuch (unverändert falls kein Top-Up möglich/nötig)
 */
async function _autoTopUpSol(currentBalance, minNeeded) {
    if (currentBalance >= minNeeded) return currentBalance;
    const solPriceRow = db.prepare(
        `SELECT price FROM pool_stats WHERE pool_id = 'liq-sol-usdc' ORDER BY recorded_at DESC LIMIT 1`
    ).get();
    const solPrice = solPriceRow?.price ?? 0;
    if (solPrice <= 0) {
        console.warn(`[deposit] ${t('cli.liq.topup_no_price')}`);
        return currentBalance;
    }
    const target      = minNeeded + 0.01; // kleiner Extra-Puffer
    const neededSol    = target - currentBalance;
    const neededUsdc   = neededSol * solPrice * 1.02; // +2% Slippage-Puffer
    const usdcBal      = await getTokenBalanceFresh(getKeypair().publicKey, USDC_MINT, 6);
    if (usdcBal < neededUsdc) {
        console.warn(`[deposit] ${t('cli.liq.topup_no_usdc', { have: usdcBal.toFixed(2), need: neededUsdc.toFixed(2) })}`);
        return currentBalance;
    }
    console.log(`[deposit] ${t('cli.liq.topup_swapping', { sol: currentBalance.toFixed(4), min: minNeeded.toFixed(4), usdc: neededUsdc.toFixed(2) })}`);
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
        console.log(`[deposit] ${t('cli.liq.topup_ok', { sol: newBalance.toFixed(4) })}`);
        return newBalance;
    } catch (err) {
        console.warn(`[deposit] ${t('cli.liq.topup_failed', { error: err.message })}`);
        return currentBalance;
    }
}

const SWAP_ROUTING_ERROR  = t('cli.ld.swap_routing_error');
const MARKET_DATA_ERROR   = t('cli.ld.market_data_error');
const WALLET_BALANCE_ERROR = t('cli.ld.wallet_balance_error');

// Stabile Schlüssel für genau die Fehler, bei denen die Settings-UI einen Retry
// anbietet statt abzubrechen (siehe emitJson()). Wer hier etwas ergänzt, muss
// _isRetryableError() in bots/settings/html/js/bot-liquidity.js mitziehen.
const RETRYABLE = { swap: 'SWAP_ROUTING', market: 'MARKET_DATA', wallet: 'WALLET_BALANCE' };

function abort(msg, errorCode = null) {
    if (jsonMode) {
        // Im JSON-Modus FEHLER in error-Feld, nicht in log
        try { releaseManualLock(); } catch { /* */ }
        emitJson(false, msg, errorCode);
        process.exit(1);
    }
    console.error(`[deposit] ${t('cli.liq.error_word')}: ${msg}`);
    try { releaseManualLock(); } catch { /* */ }
    process.exit(1);
}

function successExit() {
    if (jsonMode) emitJson(true);
    try { releaseManualLock(); } catch { /* */ }
    process.exit(0);
}

// ─── Manual-Lock acquire ──────────────────────────────────────────────────────
// Vor jedem produktiven Lauf prüfen ob Cleanup/SL läuft (Konflikt-Vermeidung).
// Im dry-run-Modus wird der Lock NICHT gehalten – Dry-Run ist read-only.

// Unerwartete Fehler immer abfangen, damit im JSON-Modus ein valider Response gesendet wird.
function _fatalHandler(err) {
    try { releaseManualLock(); } catch {}
    const msg = err?.message ?? String(err);
    _origErr('[deposit] Fatal:', msg);
    if (jsonMode) { emitJson(false, t('cli.common.unexpected', { error: msg })); }
    process.exit(1);
}
process.on('uncaughtException',  _fatalHandler);
process.on('unhandledRejection', _fatalHandler);

if (!dryRun) {
    if (isCleanupRunning()) {
        abort(t('cli.liq.lock_cleanup'));
    }
    if (isSlLocked()) {
        abort(t('cli.liq.lock_sl'));
    }
    // Bot hat Vorrang: warten bis Claim/Reinvest/Rebalancing fertig sind, statt
    // gleichzeitig dieselbe Position zu mutieren (sonst stale Snapshot/Race).
    if (!(await waitForBotToFinish())) {
        abort(t('cli.liq.lock_bot_active'));
    }
    acquireManualLock({ action: 'deposit', pool: args.pool });
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => { try { releaseManualLock(); } catch {} process.exit(1); });
    }
    // TOCTOU: falls der Bot zwischen Wait und Lock noch eine Operation gestartet hat,
    // erneut warten (Bot-Vorrang) — danach mutiert garantiert nur diese Aktion.
    if (!(await waitForBotToFinish())) {
        abort(t('cli.liq.lock_bot_busy'));
    }
}

// ─── Initialisierung ──────────────────────────────────────────────────────────

const db      = openDatabase();
const keypair = getKeypair();

syncPools(db, config.pools.all);

// Pool anhand des Pairs suchen
const pool = config.pools.all.find(p => p.pair === args.pool);
if (!pool) {
    const available = config.pools.all.map(p => p.pair).join(', ');
    abort(t('cli.liq.pool_not_found_list', { pool: args.pool, list: available }));
}

// Benutzer-Sperre: in gesperrte Pools (enabled=false) kann nicht eingezahlt werden.
// Der Pool muss erst in ForgeSettings wieder freigegeben („aktiviert") werden.
// Ausnahme --dry-run: eine Simulation bewegt kein Kapital und ist genau der Weg, mit
// dem ein noch gesperrter (z.B. gerade übernommener Pool-Offer) Pool vorab geprüft
// wird, bevor die Freigabe überhaupt möglich ist (siehe pool-offers-dryrun.js).
if (!dryRun && !isPoolEnabled(pool)) {
    abort(t('cli.ld.pool_disabled', { pool: pool.pair }));
}

console.log(`[deposit] Pool:    ${pool.pair} (${pool.id})`);
const _tbLabel = pool.usdcIsTokenA ? pool.pair.split('/')[0] : pool.pair.split('/')[1];
if (useMaxPair) {
    console.log(`[deposit] ${t('cli.ld.head_mode_maxpair', { maxA: maxAArg, maxB: maxBArg })}`);
} else {
    const _labelForArg = useModeB ? modeBToken : (useTokenB ? _tbLabel : 'USDC');
    console.log(`[deposit] ${t('cli.liq.head_amount', { v: `${depositAmount.toFixed(6)} ${_labelForArg}` })}`);
}
console.log(`[deposit] --new:   ${args.new ? t('cli.liq.yes') : t('cli.liq.no')}`);
if (dryRun) console.log(`[deposit] ── ${t('cli.ld.dry_run_hdr')} ────────────`);

// ─── Mindestbetrag-Check (Modus A) ───────────────────────────────────────────
// Modus B (User-spezifizierte Token-Menge) hat kein Mindestbetrag, weil dort
// kein Swap nötig ist und der User bewusst eine Menge wählt.
if (!useModeBOrC) {
    let minUsdc;
    let label;
    if (args.new)                    { minUsdc = MIN_USDC_DEPOSIT_NEW;      label = t('cli.ld.min_new'); }
    else if (pool.volatilePair)      { minUsdc = MIN_USDC_DEPOSIT_BTCPAIR;  label = t('cli.ld.min_volatile'); }
    else                             { minUsdc = MIN_USDC_DEPOSIT_STANDARD; label = t('cli.ld.min_standard'); }

    // Bei --tokenb: kein USDC-Mindest (User gibt tokenB direkt), nur Plausibilität > 0
    if (hasUsdc && depositAmount < minUsdc) {
        abort(t('cli.ld.below_minimum', { label, min: minUsdc, given: depositAmount.toFixed(2) }));
    }
}

// ─── Position prüfen ─────────────────────────────────────────────────────────

const position = getOpenPosition(db, pool.id);

if (!position && !args.new) {
    abort(t('cli.ld.no_position_hint', { pool: pool.pair }));
}

if (position) {
    console.log(`[deposit] Position: ${position.nft_mint}`);
} else {
    console.log(`[deposit] ${t('cli.ld.new_position_note')}`);
}

// ─── Aktuellen Preis abrufen ──────────────────────────────────────────────────

const adapter = getAdapter(pool);

let stats;
try {
    stats = await adapter.getPoolStats(pool);
} catch (err) {
    abort(MARKET_DATA_ERROR, RETRYABLE.market);
}

if (stats.tvlUsd != null) {
    insertPoolStats(db, {
        poolId:       pool.id,
        price:        stats.price,
        tvlUsd:       stats.tvlUsd,
        volume24hUsd: stats.volume24hUsd,
        apr24h:       stats.apr24h,
    });
}

const currentPrice = stats.price;
const tokenALabel  = pool.usdcIsTokenA ? pool.pair.split('/')[1] : pool.pair.split('/')[0];
const tokenBLabel  = pool.usdcIsTokenA ? pool.pair.split('/')[0] : pool.pair.split('/')[1];
console.log(`[deposit] ${t('cli.liq.head_price', { v: `${currentPrice.toFixed(4)} ${tokenBLabel}/${tokenALabel}` })}`);
console.log(`[deposit] Modus:   ${useTokenB ? `--tokenb (${tokenBLabel})` : '--usdc (USDC)'}`);

// Quote-Preis und USD-Anker für volatilePair (z.B. HYPE/SOL → SOL/USDC liefert solUsd)
let quotePrice    = 0;
let usdPerTokenA  = 0;
let usdPerTokenB  = 0;
if (pool.volatilePair) {
    quotePrice = getTokenUsdPrice(pool.quoteTokenMint, db);
    if (quotePrice <= 0) abort(t('cli.liq.quote_price_missing', { mint: pool.quoteTokenMint }));
    const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
    usdPerTokenA = quoteIsTokenA ? quotePrice : quotePrice * currentPrice;
    usdPerTokenB = quoteIsTokenA ? quotePrice / currentPrice : quotePrice;
    console.log(`[deposit] Quote: ${quotePrice.toFixed(2)} USDC/${quoteIsTokenA ? tokenALabel : tokenBLabel}`);
    console.log(`[deposit] USD/${tokenALabel}: ${usdPerTokenA.toFixed(4)} | USD/${tokenBLabel}: ${usdPerTokenB.toFixed(4)}`);
}

// ─── IL-Check: Pool-Preis vs. Jupiter-Marktpreis ─────────────────────────────
// Nur für Standard X/USDC-Pools: Weicht der On-Chain-Preis stark vom Marktpreis ab,
// würden Arbitrageure sofort IL erzeugen. Ab 15% Abweichung wird die Einzahlung geblockt.
if (!pool.volatilePair && !pool.usdcIsTokenA && pool.tokenA) {
    try {
        const jupRes = await fetch(`http://127.0.0.1:3100/jup/price/v3?ids=${pool.tokenA}`);
        const jupData = await jupRes.json();
        const marketPrice = jupData?.[pool.tokenA]?.usdPrice;
        if (marketPrice && marketPrice > 0 && currentPrice > 0) {
            const ilPct = Math.abs(1 - currentPrice / marketPrice) * 100;
            if (ilPct >= 15) {
                abort(t('cli.ld.il_too_high', { poolPrice: currentPrice.toFixed(4), marketPrice: marketPrice.toFixed(4), token: tokenALabel, il: ilPct.toFixed(0) }));
            }
            console.log(`[deposit] ${t('cli.ld.il_check_ok', { pool: currentPrice.toFixed(4), market: marketPrice.toFixed(4), il: ilPct.toFixed(1) })}`);
        }
    } catch {
        // Jupiter nicht erreichbar – IL-Check überspringen, Einzahlung weiter erlauben
        console.warn(`[deposit] ${t('cli.ld.il_check_skipped')}`);
    }
}

// ─── Modus B / Modus C: User-spezifizierte Token-Mengen ohne Swap ────────────
// Modus B (--token+--amount): ein Anker, Gegen-Seite via Pool-Ratio.
// Modus C (--max-a+--max-b):  beide als Obergrenze, Engpass-Logik nimmt das limitierende
//   Paar nach **aktuellem** Pool-Ratio (robust gegen Preisbewegung zwischen UI-Eingabe
//   und produktivem Aufruf — kein "Reject wegen 5min Wartezeit").
// In beiden Fällen: keine Pre-Swaps, keine USDC-Umwandlung.

let manualAmountA = 0;
let manualAmountB = 0;
let modeBAnchorIsA = false;
if (useModeBOrC) {
    // Range für Ratio-Berechnung: bei bestehender Position deren Range, sonst undefined
    const prLower = position?.price_lower;
    const prUpper = position?.price_upper;

    if (useModeB) {
        const symbolUp = modeBToken.toUpperCase();
        const symAUp   = tokenALabel.toUpperCase();
        const symBUp   = tokenBLabel.toUpperCase();
        if (symbolUp === symAUp)      modeBAnchorIsA = true;
        else if (symbolUp === symBUp) modeBAnchorIsA = false;
        else abort(t('cli.liq.mode_b_wrong_token', { token: modeBToken, tokenA: tokenALabel, tokenB: tokenBLabel }));

        if (modeBAnchorIsA) {
            const aPerB = clmmTokenAForDeposit(1, currentPrice, prLower, prUpper);
            const bPerA = aPerB > 0 ? 1 / aPerB : 0;
            manualAmountA = modeBAmount;
            manualAmountB = modeBAmount * bPerA;
        } else {
            manualAmountB = modeBAmount;
            manualAmountA = clmmTokenAForDeposit(modeBAmount, currentPrice, prLower, prUpper);
        }
        console.log(`[deposit] ${t('cli.ld.mode_b_anchor', { amount: modeBAmount.toFixed(6), token: modeBAnchorIsA ? tokenALabel : tokenBLabel })}`);
        console.log(`[deposit] ${t('cli.ld.mode_b_counter', { amount: (modeBAnchorIsA ? manualAmountB : manualAmountA).toFixed(6), token: modeBAnchorIsA ? tokenBLabel : tokenALabel })}`);
    } else {
        // Modus C: Engpass-Logik
        {
            const aPerB = clmmTokenAForDeposit(1, currentPrice, prLower, prUpper);  // tokenA-Bedarf pro 1 tokenB
            // Welche Seite ist limitierend?
            const bForMaxA = aPerB > 0 ? maxAArg / aPerB : 0;   // wie viel tokenB würde maxAArg bei aktuellem Ratio paaren
            const aForMaxB = aPerB * maxBArg;                    // wie viel tokenA braucht maxBArg
            if (bForMaxA <= maxBArg) {
                // tokenA-Schranke limitiert
                manualAmountA = maxAArg;
                manualAmountB = bForMaxA;
            } else {
                // tokenB-Schranke limitiert
                manualAmountA = aForMaxB;
                manualAmountB = maxBArg;
            }
            console.log(`[deposit] ${t('cli.ld.mode_c', { a: manualAmountA.toFixed(6), tokenA: tokenALabel, b: manualAmountB.toFixed(6), tokenB: tokenBLabel, maxA: maxAArg, maxB: maxBArg, ratio: aPerB.toFixed(6) })}`);
        }
    }
}

// useModeBOrC ist oben bei den anderen Mode-Flags deklariert (Reihenfolge wichtig:
// Mindestbetrag-Check verwendet ihn schon).

// ─── Wallet-Guthaben prüfen ───────────────────────────────────────────────────

let walletUsdc, walletTokenA, walletTokenB;
try {
    walletUsdc   = await getUsdcBalance(keypair.publicKey);
    walletTokenA = await getTokenABalance(keypair, pool);
    // Für usdcIsTokenA-Pools (z.B. EURC/USDC) brauchen wir tokenB-Balance auch im --usdc-Modus
    // (Pre-Swap-Logik unten überprüft & swapped fehlende tokenB-Menge aus tokenA = USDC).
    walletTokenB = (useTokenB || pool.usdcIsTokenA || pool.volatilePair || useModeBOrC)
        ? await getTokenBBalance(keypair, pool)
        : null;
} catch {
    abort(WALLET_BALANCE_ERROR, RETRYABLE.wallet);
}

// ─── Upfront SOL-Check + Auto-Top-Up vor allen Transaktionen ─────────────────
// Sicherstellen, dass nach geschätzten TX-Fees noch config.solReserve übrig bleibt.
// Wird vor Pre-Swaps geprüft, damit SOL nicht sinnlos verbraucht wird.
// Falls SOL zu niedrig: automatisch USDC → SOL swappen (analog zu cleanup.js).
//
// Schätzung: volatile pair = 3 TXs (2 Auto-Swaps + Position),
//            Modus B/C     = 1 TX  (kein Swap),
//            Standard      = 2 TXs (1 Pre-Swap + Position).
if (!dryRun) {
    const _solFeePerTx  = 0.01;  // Konservativ: Jupiter-Swaps kosten 0.005–0.015 SOL
    const _txCount      = useModeBOrC ? 1 : pool.volatilePair ? 3 : 2;
    const _solMinNeeded = config.solReserve + _txCount * _solFeePerTx;
    let   _solBalance   = await getUsableSolBalanceFresh(keypair.publicKey);

    if (_solBalance < _solMinNeeded) {
        _solBalance = await _autoTopUpSol(_solBalance, _solMinNeeded);

        // Nach Top-Up-Versuch nochmal prüfen; erst jetzt ggf. abbrechen
        if (_solBalance < _solMinNeeded) {
            // _solBalance ist "usable" (Gesamtbalance minus Reserve) — für die Fehlermeldung
            // die tatsächliche Wallet-Balance zeigen, sonst wirkt es so als fehle die Reserve
            // zusätzlich zum bereits angezeigten Betrag.
            const _solTotal = await getSolBalanceFresh(keypair.publicKey);
            abort(t('cli.ld.low_sol_txs', { total: _solTotal.toFixed(4), reserve: config.solReserve, usable: _solBalance.toFixed(4), needed: (_txCount * _solFeePerTx).toFixed(4), txs: _txCount, perTx: _solFeePerTx }));
        }
    } else {
        console.log(`[deposit] ${t('cli.ld.sol_check_ok', { sol: _solBalance.toFixed(4), min: _solMinNeeded.toFixed(4) })}`);
    }
}

// ─── Früher OOR-Check vor Auto-Swaps (volatilePair) ─────────────────────────
// Bei bestehenden Positionen: Position vor jedem Swap auf in-Range prüfen.
// Ohne diesen Check werden USDC bereits geswappt, bevor festgestellt wird dass
// die Position OOR ist — der Deposit schlägt dann ab, die Tokens liegen lose im Wallet.
if (position && pool.volatilePair && hasUsdc && !useModeBOrC) {
    let preState;
    try {
        preState = await adapter.getPositionState(pool, position.nft_mint);
    } catch (err) {
        abort(MARKET_DATA_ERROR, RETRYABLE.market);
    }
    if (!preState.inRange) {
        abort(t('cli.ld.oor_early', { lower: preState.priceLower.toFixed(4), upper: preState.priceUpper.toFixed(4), price: preState.currentPrice.toFixed(4) }));
    }
    console.log(`[deposit] ${t('cli.ld.oor_precheck_ok', { price: preState.currentPrice.toFixed(4) })}`);
}

// ─── volatilePair Auto-Swap (USDC → tokenA + USDC → tokenB) ─────────────────
// Wenn --usdc auf einem volatilePair-Pool → zwei Swaps machen, damit
// der User auch dann einzahlen kann, wenn er nur USDC im Wallet hat.
// Modus B + --tokenb: kein Auto-Swap (User wählt explizit andere Pfade).
let swappedVolatileB = false; // Merker: Swap B lief durch (für OOR-Recovery unten)
if (pool.volatilePair && hasUsdc && !useModeBOrC) {
    let halfUsd = depositAmount / 2;
    let tokenANeeded = usdPerTokenA > 0 ? halfUsd / usdPerTokenA : 0;
    let tokenBNeeded = usdPerTokenB > 0 ? halfUsd / usdPerTokenB : 0;

    // Frische USDC-Balance lesen (alte Reads können stale sein)
    walletUsdc = await getTokenBalanceFresh(keypair.publicKey, USDC_MINT, 6);
    console.log(`[deposit] ${t('cli.ld.volatile_wallet', { a: walletTokenA.toFixed(8), tokenA: tokenALabel, b: walletTokenB.toFixed(8), tokenB: tokenBLabel, usdc: walletUsdc.toFixed(2) })}`);

    // Defizit pro Seite ermitteln, jeweils mit +1.5% Puffer für Slippage
    const usdValueA = usdPerTokenA;
    const usdValueB = usdPerTokenB;
    let deficitA = Math.max(0, tokenANeeded - walletTokenA);
    let deficitB = Math.max(0, tokenBNeeded - walletTokenB);
    let usdcForA  = deficitA > 0 ? (deficitA * usdValueA) * 1.015 : 0;
    let usdcForB  = deficitB > 0 ? (deficitB * usdValueB) * 1.015 : 0;
    let totalUsdcNeeded = usdcForA + usdcForB;

    // Reicht das USDC für beide Pool-Swaps nicht mehr — typisch wenn der vorgelagerte
    // SOL-Top-Up (USDC→SOL) bei niedrigem SOL-Stand USDC verbraucht hat, was die
    // Frontend-„Max"-Berechnung nicht einplant —, wird der Deposit-Betrag auf das real
    // verfügbare USDC heruntergezogen statt abzubrechen. Bestehende tokenA/B-Bestände
    // bleiben fix; das Herunterskalieren reduziert nur den per Swap zu deckenden Bedarf,
    // sodass totalUsdcNeeded nach der Neuberechnung sicher ≤ walletUsdc liegt.
    if (totalUsdcNeeded > walletUsdc && totalUsdcNeeded > 0) {
        const scale = (walletUsdc * 0.997) / totalUsdcNeeded;
        const prev  = depositAmount;
        depositAmount   = depositAmount * scale;
        halfUsd         = depositAmount / 2;
        tokenANeeded    = usdPerTokenA > 0 ? halfUsd / usdPerTokenA : 0;
        tokenBNeeded    = usdPerTokenB > 0 ? halfUsd / usdPerTokenB : 0;
        deficitA        = Math.max(0, tokenANeeded - walletTokenA);
        deficitB        = Math.max(0, tokenBNeeded - walletTokenB);
        usdcForA        = deficitA > 0 ? (deficitA * usdValueA) * 1.015 : 0;
        usdcForB        = deficitB > 0 ? (deficitB * usdValueB) * 1.015 : 0;
        totalUsdcNeeded = usdcForA + usdcForB;
        console.log(`[deposit] ${t('cli.ld.volatile_capped', { old: prev.toFixed(2), new: depositAmount.toFixed(2), available: walletUsdc.toFixed(2), factor: scale.toFixed(4) })}`);
    }

    if (usdcForA >= 1.0) {
        console.log(`[deposit] Auto-Swap A: ${usdcForA.toFixed(2)} USDC → ${tokenALabel}`);
        if (dryRun) {
            const estOut = (usdcForA / usdValueA) * 0.99;
            console.log(`[deposit] Auto-Swap A (simuliert): ~${estOut.toFixed(8)} ${tokenALabel} erwartet`);
            walletTokenA += estOut;
            walletUsdc   -= usdcForA;
        } else {
            try {
                const { amountOut, txSignature } = await swapTokens({
                    inputMint:      USDC_MINT,
                    outputMint:     pool.tokenA,
                    inputDecimals:  6,
                    outputDecimals: pool.decimalsA,
                    amount:         usdcForA,
                    wallet:         keypair,
                    connection:     getConnection(),
                });
                console.log(`[deposit] Auto-Swap A OK: ${usdcForA.toFixed(2)} USDC → ${amountOut.toFixed(8)} ${tokenALabel} TX=${txSignature}`);
                // SOL als nativen Bestand lesen, sonst via SPL-Token-Account
                walletTokenA = pool.tokenA === WSOL_MINT
                    ? await getUsableSolBalanceFresh(keypair.publicKey)
                    : await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenA), pool.decimalsA);
                walletUsdc   = await getTokenBalanceFresh(keypair.publicKey, USDC_MINT, 6);
            } catch (err) {
                abort(isRoutingError(err) ? SWAP_ROUTING_ERROR : `Auto-Swap USDC → ${tokenALabel} fehlgeschlagen: ${err.message}`,
                      isRoutingError(err) ? RETRYABLE.swap : null);
            }
        }
    }

    if (usdcForB >= 1.0) {
        console.log(`[deposit] Auto-Swap B: ${usdcForB.toFixed(2)} USDC → ${tokenBLabel}`);
        if (dryRun) {
            const estOut = (usdcForB / usdValueB) * 0.99;
            console.log(`[deposit] Auto-Swap B (simuliert): ~${estOut.toFixed(8)} ${tokenBLabel} erwartet`);
            walletTokenB += estOut;
            walletUsdc   -= usdcForB;
        } else {
            try {
                const { amountOut, txSignature } = await swapTokens({
                    inputMint:      USDC_MINT,
                    outputMint:     pool.tokenB,
                    inputDecimals:  6,
                    outputDecimals: pool.decimalsB,
                    amount:         usdcForB,
                    wallet:         keypair,
                    connection:     getConnection(),
                });
                console.log(`[deposit] Auto-Swap B OK: ${usdcForB.toFixed(2)} USDC → ${amountOut.toFixed(8)} ${tokenBLabel} TX=${txSignature}`);
                swappedVolatileB = true;
                walletTokenB = pool.tokenB === WSOL_MINT
                    ? await getUsableSolBalanceFresh(keypair.publicKey)
                    : await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenB), pool.decimalsB);
                walletUsdc   = await getTokenBalanceFresh(keypair.publicKey, USDC_MINT, 6);
            } catch (err) {
                abort(isRoutingError(err) ? SWAP_ROUTING_ERROR : `Auto-Swap USDC → ${tokenBLabel} fehlgeschlagen: ${err.message}`,
                      isRoutingError(err) ? RETRYABLE.swap : null);
            }
        }
    }
}

if (useModeBOrC) {
    // Modus B / C: maxA/maxB aus der UI sind Obergrenzen, keine exakten Zielmengen.
    // Falls das Wallet weniger hat (z.B. durch inzwischen gelaufene Deposits), beide
    // Seiten proportional auf das tatsächlich Vorhandene kappen und trotzdem einzahlen.
    // Nur abbrechen wenn die verfügbare Menge extrem gering ist (< 1% des Bedarfs).
    console.log(`[deposit] Wallet:  ${walletTokenA.toFixed(6)} ${tokenALabel} + ${walletTokenB.toFixed(6)} ${tokenBLabel}`);
    console.log(`[deposit] Bedarf:  ${manualAmountA.toFixed(6)} ${tokenALabel} + ${manualAmountB.toFixed(6)} ${tokenBLabel}`);
    if (walletTokenA < manualAmountA * 0.01 && manualAmountA > 0) {
        abort(t('cli.ld.not_enough_wallet', { token: tokenALabel, have: walletTokenA.toFixed(6), need: manualAmountA.toFixed(6) }));
    }
    if (walletTokenB < manualAmountB * 0.01 && manualAmountB > 0) {
        abort(t('cli.ld.not_enough_wallet', { token: tokenBLabel, have: walletTokenB.toFixed(6), need: manualAmountB.toFixed(6) }));
    }
    // Auf tatsächlich Vorhandenes kappen — Orca-Ratio-Engpass-Logik nochmals anwenden
    if (manualAmountA > walletTokenA || manualAmountB > walletTokenB) {
        const scaleA = manualAmountA > 0 ? Math.min(1, walletTokenA / manualAmountA) : 1;
        const scaleB = manualAmountB > 0 ? Math.min(1, walletTokenB / manualAmountB) : 1;
        const scale  = Math.min(scaleA, scaleB);
        const prevA  = manualAmountA;
        const prevB  = manualAmountB;
        manualAmountA = manualAmountA * scale;
        manualAmountB = manualAmountB * scale;
        console.log(`[deposit] ${t('cli.ld.wallet_capped', { factor: scale.toFixed(4), oldA: prevA.toFixed(6), newA: manualAmountA.toFixed(6), tokenA: tokenALabel, oldB: prevB.toFixed(6), newB: manualAmountB.toFixed(6), tokenB: tokenBLabel })}`);
    }
} else if (pool.volatilePair) {
    // volatilePair: USD-Bedarf je Seite (halbiertes Kapital), nach Auto-Swap sollten beide Seiten passen
    const halfUsd = depositAmount / 2;
    const aNeed   = usdPerTokenA > 0 ? halfUsd / usdPerTokenA : 0;
    const bNeed   = usdPerTokenB > 0 ? halfUsd / usdPerTokenB : 0;
    console.log(`[deposit] Wallet:  ${walletTokenA.toFixed(6)} ${tokenALabel} + ${walletTokenB.toFixed(6)} ${tokenBLabel}`);
    console.log(`[deposit] Bedarf:  ~${aNeed.toFixed(6)} ${tokenALabel} + ~${bNeed.toFixed(6)} ${tokenBLabel} (≈ ${depositAmount.toFixed(2)} USDC)`);
    if (walletTokenA < aNeed * 0.5)
        abort(t('cli.ld.not_enough_est', { token: tokenALabel, need: aNeed.toFixed(6), have: walletTokenA.toFixed(6) }));
    if (walletTokenB < bNeed * 0.5)
        abort(t('cli.ld.not_enough_est', { token: tokenBLabel, need: bNeed.toFixed(6), have: walletTokenB.toFixed(6) }));
} else if (useTokenB) {
    console.log(`[deposit] Wallet:  ${walletTokenA.toFixed(6)} ${tokenALabel} + ${walletTokenB.toFixed(6)} ${tokenBLabel}`);
    if (walletTokenB < depositAmount) {
        const fehlend = (depositAmount - walletTokenB).toFixed(6);
        abort(t('cli.ld.not_enough_full', { token: tokenBLabel, need: depositAmount.toFixed(6), have: walletTokenB.toFixed(6), missing: fehlend }));
    }
} else if (pool.usdcIsTokenA) {
    // tokenA = USDC, tokenB = z.B. EURC. --usdc X = X USDC Wallet-Budget.
    console.log(`[deposit] Wallet:  ${walletTokenA.toFixed(2)} USDC + ${walletTokenB.toFixed(6)} ${tokenBLabel}`);
    if (walletTokenA < depositAmount) {
        const fehlend = (depositAmount - walletTokenA).toFixed(2);
        abort(t('cli.ld.not_enough_usdc_budget', { need: depositAmount.toFixed(2), have: walletTokenA.toFixed(2), missing: fehlend }));
    }
} else {
    console.log(`[deposit] Wallet:  ${walletTokenA.toFixed(6)} ${tokenALabel} (nutzbar) + ${walletUsdc.toFixed(2)} USDC`);
    if (walletUsdc < depositAmount) {
        const fehlend = (depositAmount - walletUsdc).toFixed(2);
        abort(t('cli.ld.not_enough_full', { token: 'USDC', need: depositAmount.toFixed(2), have: walletUsdc.toFixed(2), missing: fehlend }));
    }
}

// ─── Budget-Split (Standard-Pools, --usdc): Gesamtbudget CLMM-korrekt aufteilen ──
// --usdc X bedeutet: X USDC Gesamtkapital einsetzen, nicht X USDC als tokenB-Seite.
// Berechne den CLMM-korrekten tokenB-Anteil (usdcBudgetB) sodass gilt:
//   usdcBudgetB + clmmTokenAForDeposit(usdcBudgetB) * price ≈ depositAmount
let usdcBudgetB = depositAmount; // Fallback für alle anderen Modi (tokenB, volatilePair, etc.)
if (!pool.usdcIsTokenA && !pool.volatilePair && !useTokenB && !useModeBOrC) {
    const tokenAPerUnitB = clmmTokenAForDeposit(1, currentPrice, position?.price_lower, position?.price_upper);
    const totalUsdcPerUnitB = tokenAPerUnitB * currentPrice + 1; // USDC-Wert pro 1 USDC tokenB
    usdcBudgetB = depositAmount / totalUsdcPerUnitB;
}

// ─── Pre-Swap: Token-Mix ausgleichen (nur Standard-Pools, nur --usdc) ─────────

if (!pool.usdcIsTokenA && !pool.volatilePair && !useTokenB && !useModeBOrC) {
    // Frische Reads – gecachte Werte können nach einem vorherigen (fehlgeschlagenen)
    // Swap-Versuch falsch sein und einen zweiten unnötigen Swap auslösen.
    // FIX: Für native SOL (WSOL_MINT als tokenA) getUsableSolBalanceFresh verwenden —
    //      getTokenBalanceFresh liest nur SPL-WSOL-Konten, findet natives SOL nicht und
    //      gibt 0 zurück, was fälschlicherweise einen Pre-Swap auslöst.
    const isSolPool = pool.tokenA === WSOL_MINT || pool.pair.toUpperCase().startsWith('SOL/');
    walletTokenA = isSolPool
        ? await getUsableSolBalanceFresh(keypair.publicKey)
        : await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenA), pool.decimalsA);
    walletUsdc   = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenB), pool.decimalsB);

    // CLMM-korrekte Schätzung: tokenA-Bedarf aus Range-Ratio, nicht 50/50-Annahme
    const targetA      = clmmTokenAForDeposit(usdcBudgetB, currentPrice, position?.price_lower, position?.price_upper);
    const [symA, symB] = pool.pair.split('/');

    if (walletTokenA < targetA) {
        // Zu wenig tokenA → USDC → tokenA tauschen
        // +1,5 % Puffer: deckt 0,5 % Swap-Slippage + minimale Preisbewegung zwischen
        // Swap und Deposit ab, damit der Abort-Check danach sicher passt.
        const deficitUsdc = (targetA - walletTokenA) * currentPrice * 1.015;
        const swapAmount  = Math.min(deficitUsdc, walletUsdc * 0.99);

        if (swapAmount >= 1.0) {
            console.log(`[deposit] Pre-Swap: ${swapAmount.toFixed(2)} ${symB} → ${symA}`);
            if (dryRun) {
                // Simuliere Swap-Ergebnis für die nachfolgende Deposit-Schätzung
                const estOut = swapAmount / currentPrice * 0.995; // 0,5% Slippage-Abzug
                console.log(`[deposit] Pre-Swap (simuliert): ~${estOut.toFixed(6)} ${symA} erwartet`);
                walletTokenA = walletTokenA + estOut;
                walletUsdc   = walletUsdc - swapAmount;
            } else {
                try {
                    const { amountOut, txSignature } = await swapTokens({
                        inputMint:      pool.tokenB,
                        outputMint:     pool.tokenA,
                        inputDecimals:  pool.decimalsB,
                        outputDecimals: pool.decimalsA,
                        amount:         swapAmount,
                        wallet:         keypair,
                        connection:     getConnection(),
                    });
                    console.log(`[deposit] Pre-Swap OK: ${swapAmount.toFixed(2)} ${symB} → ${amountOut.toFixed(6)} ${symA} TX=${txSignature}`);
                    // Balances nach Swap frisch lesen (kein Cache)
                    walletTokenA = isSolPool
                        ? await getUsableSolBalanceFresh(keypair.publicKey)
                        : await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenA), pool.decimalsA);
                    walletUsdc   = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenB), pool.decimalsB);
                } catch (err) {
                    console.error(`[deposit] ${t('cli.ld.preswap_failed', { error: err.message })}`);
                }
            }
        } else {
            console.log(`[deposit] ${t('cli.ld.preswap_too_small', { usdc: deficitUsdc.toFixed(2) })}`);
        }
    }
}

// ─── Pre-Swap (usdcIsTokenA): USDC-Budget → CLMM-Split + Swap auf tokenB-Seite ─
//
// Für Pools mit USDC = tokenA (z.B. EURC/USDC) bedeutet `--usdc X` analog zu
// SOL/USDC: X USDC vom Wallet-Budget einsetzen, davon den CLMM-korrekten Anteil
// in tokenB (z.B. EURC) swappen, dann beide Seiten einzahlen → LP-Wert ≈ X USDC.
//
// Spiegelbild des Blocks oben (der für tokenA-Swaps zuständig ist).

if (pool.usdcIsTokenA && !useTokenB && !useModeBOrC) {
    const budget = depositAmount; // USDC
    const usdcPerB      = clmmTokenAForDeposit(1, currentPrice, position?.price_lower, position?.price_upper);
    const usdcValuePerB = usdcPerB + 1 / currentPrice;
    const targetB       = budget / usdcValuePerB;
    const targetA       = targetB * usdcPerB;

    console.log(`[deposit] Budget:  ${budget.toFixed(2)} USDC → ~${targetA.toFixed(2)} ${tokenALabel} + ~${targetB.toFixed(6)} ${tokenBLabel}`);

    // Frische Reads (gecachte Werte können nach vorherigen Swaps stale sein)
    walletTokenA = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenA), pool.decimalsA);
    walletTokenB = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenB), pool.decimalsB);

    if (walletTokenB < targetB) {
        // tokenA → tokenB swappen, um Defizit auszugleichen
        // swapAmount in USDC: deficitB / price (USDC-Wert von deficitB) × 1.015 Slippage-Puffer
        const deficitB        = targetB - walletTokenB;
        const swapAmountUsdc  = (deficitB / currentPrice) * 1.015;
        const maxSwapBudget   = budget - targetA;          // USDC die für Swap übrig bleiben (≈ USDC-Wert von targetB)
        const swapAmountFinal = Math.min(swapAmountUsdc, maxSwapBudget * 1.015, walletTokenA * 0.99);

        if (swapAmountFinal >= 1.0) {
            console.log(`[deposit] Pre-Swap: ${swapAmountFinal.toFixed(2)} ${tokenALabel} → ${tokenBLabel}`);
            if (dryRun) {
                const estOut = swapAmountFinal * currentPrice * 0.995;
                console.log(`[deposit] Pre-Swap (simuliert): ~${estOut.toFixed(6)} ${tokenBLabel} erwartet`);
                walletTokenA = walletTokenA - swapAmountFinal;
                walletTokenB = walletTokenB + estOut;
            } else {
                try {
                    const { amountOut, txSignature } = await swapTokens({
                        inputMint:      pool.tokenA,
                        outputMint:     pool.tokenB,
                        inputDecimals:  pool.decimalsA,
                        outputDecimals: pool.decimalsB,
                        amount:         swapAmountFinal,
                        wallet:         keypair,
                        connection:     getConnection(),
                    });
                    console.log(`[deposit] Pre-Swap OK: ${swapAmountFinal.toFixed(2)} ${tokenALabel} → ${amountOut.toFixed(6)} ${tokenBLabel} TX=${txSignature}`);
                    walletTokenA = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenA), pool.decimalsA);
                    walletTokenB = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(pool.tokenB), pool.decimalsB);
                } catch (err) {
                    abort(isRoutingError(err) ? SWAP_ROUTING_ERROR : MARKET_DATA_ERROR,
                          isRoutingError(err) ? RETRYABLE.swap : RETRYABLE.market);
                }
            }
        } else {
            console.log(`[deposit] ${t('cli.ld.preswap_deficit_small', { usdc: swapAmountFinal.toFixed(4) })}`);
        }
    }

    // Override: depositAmount ist ab hier tokenB-Menge (Fall A/B benutzen das als amountB)
    depositAmount = targetB;
}

// ─── FALL A: Bestehende Position aufstocken (increaseLiquidity) ───────────────

if (position) {

    // In-Range prüfen (Chain-Abfrage)
    let state;
    try {
        state = await adapter.getPositionState(pool, position.nft_mint);
    } catch (err) {
        abort(MARKET_DATA_ERROR, RETRYABLE.market);
    }

    if (!state.inRange) {
        // Rescue-Swap: Wenn Swap B bereits ausgeführt wurde, sind noch USDC im Wallet,
        // die für tokenA (SOL) vorgesehen waren. Diese jetzt in tokenA tauschen, damit
        // der nächste Deposit-Versuch (über Settings > Einzahlen) direkt mit beiden
        // Pool-Tokens starten kann — ohne manuellen USDC→SOL-Zwischenschritt.
        if (swappedVolatileB && !dryRun && walletUsdc >= 1.0) {
            const rescueUsdc = walletUsdc * 0.99;
            console.warn(`[deposit] ${t('cli.ld.rescue_swap', { usdc: rescueUsdc.toFixed(2), token: tokenALabel })}`);
            try {
                const { amountOut, txSignature } = await swapTokens({
                    inputMint:      USDC_MINT,
                    outputMint:     pool.tokenA,
                    inputDecimals:  6,
                    outputDecimals: pool.decimalsA,
                    amount:         rescueUsdc,
                    wallet:         keypair,
                    connection:     getConnection(),
                });
                console.log(`[deposit] Rescue-Swap OK: ${rescueUsdc.toFixed(2)} USDC → ${amountOut.toFixed(6)} ${tokenALabel} TX=${txSignature}`);
            } catch (err) {
                console.warn(`[deposit] ${t('cli.ld.rescue_failed', { error: err.message })}`);
            }
        }
        abort(t('cli.ld.oor_abort', {
            lower: state.priceLower.toFixed(4), upper: state.priceUpper.toFixed(4),
            price: state.currentPrice.toFixed(4),
            // Mitten-im-Text-Optional: Leerstring statt undefined (i18n.md §3e Merksatz)
            swapNote: swappedVolatileB ? t('cli.ld.oor_swap_note', { token: tokenALabel }) + '\n' : '',
        }));
    }

    console.log(`[deposit] ${t('cli.liq.head_range_ok', { lower: state.priceLower.toFixed(4), upper: state.priceUpper.toFixed(4) })}`);

    // TokenA-Bedarf schätzen (CLMM-korrekt):
    //   volatilePair: depositAmount / 2 / usdPerTokenA (je Hälfte des USD-Betrags in tokenA)
    //   Standard:     CLMM-Ratio aus aktueller Preis-Position in der Range
    //   Modus B:      User-Anker (manualAmountA), kein Check gegen estTokenANeeded
    const estTokenANeeded = useModeBOrC
        ? manualAmountA
        : pool.volatilePair
            ? (usdPerTokenA > 0 ? (depositAmount / 2) / usdPerTokenA : 0)
            : clmmTokenAForDeposit(usdcBudgetB, currentPrice, state.priceLower, state.priceUpper);
    // Modus B/C: bereits oben im Wallet-Check geprüft; sonst Abort nur bei deutlichem Mangel
    if (!useModeBOrC && walletTokenA < estTokenANeeded * 0.98) {
        const fehlend = (estTokenANeeded - walletTokenA).toFixed(6);
        abort(t('cli.ld.not_enough_deposit', { token: tokenALabel, need: estTokenANeeded.toFixed(6), have: walletTokenA.toFixed(6), missing: fehlend }));
    }

    // amountA/B: Orca berechnet tokenMaxA/B = amount * (1 + slippage) → auf walletBalance / SLIPPAGE_FACTOR
    // deckeln, damit tokenMax nie die Wallet-Balance übersteigt (verhindert "insufficient funds").
    // Zusätzlich * WALLET_SAFETY (0,999): tokenMax bleibt strikt UNTER der Balance, nie exakt 100 %.
    // Sonst schlägt der On-Chain-TransferChecked bei jeder Mini-Differenz fehl (Token-2022-Rundung,
    // winzige Balance-Änderung zwischen On-Chain-Read und Submit, stale Formularwerte die auf den
    // vollen Bestand herunterskaliert wurden). Identisch zur Automatik in lib/deposit-lib.js.
    // Modus B/C: manualAmountA + manualAmountB direkt (User wählt Mengen, kein Swap)
    const WALLET_SAFETY = 0.999;
    const walletTokenBBal = pool.volatilePair
        ? walletTokenB
        : (useTokenB || pool.usdcIsTokenA || useModeBOrC) ? walletTokenB : walletUsdc;
    const depositAmountB = useModeBOrC
        ? manualAmountB
        : pool.volatilePair
            ? (usdPerTokenB > 0 ? (depositAmount / 2) / usdPerTokenB : 0)
            : usdcBudgetB;
    // amountA: Modus B/C nimmt User-Wahl, sonst kompletter Wallet-Balance (Orca deckelt intern).
    const amountA = useModeBOrC
        ? Math.min(manualAmountA, walletTokenA / SLIPPAGE_FACTOR * WALLET_SAFETY)
        : walletTokenA / SLIPPAGE_FACTOR * WALLET_SAFETY;
    const amountB = useModeBOrC
        ? Math.min(manualAmountB, walletTokenBBal / SLIPPAGE_FACTOR * WALLET_SAFETY)
        : Math.min(depositAmountB, walletTokenBBal / SLIPPAGE_FACTOR * WALLET_SAFETY);

    console.log(`[deposit] ${t('cli.ld.handover', { a: amountA.toFixed(6), tokenA: tokenALabel, b: amountB.toFixed(6), tokenB: tokenBLabel })}`);
    console.log(`[deposit] Slippage: ${SLIPPAGE_PCT_STR}`);

    if (dryRun) {
        const estDepA = clmmTokenAForDeposit(amountB, currentPrice, state.priceLower, state.priceUpper);
        const estDepUsdc = calcDepositedUsdc(estDepA, amountB, currentPrice, pool, 0, quotePrice);
        console.log(`[deposit] ${t('cli.ld.expected_deposit', { a: estDepA.toFixed(6), tokenA: tokenALabel, b: amountB.toFixed(6), tokenB: tokenBLabel })}`);
        console.log(`[deposit] ${t('cli.ld.expected_lp', { usdc: estDepUsdc.toFixed(2) })}`);
        console.log(`[deposit] ── ${t('cli.ld.dry_run_end')} ────────`);
        Object.assign(jsonResult, {
            mode: 'increaseLiquidity', dryRun: true,
            estimatedTokenA: estDepA, estimatedTokenB: amountB,
            estimatedUsdc:   estDepUsdc,
            tokenALabel, tokenBLabel,
        });
        db.close();
        successExit();
    }

    let result;
    try {
        result = await adapter.increaseLiquidity(pool, position.nft_mint, amountA, amountB, DEPOSIT_SLIPPAGE);
    } catch (err) {
        if (err.solBalance !== undefined) {
            // Selbstheilung: SOL ist zwischen Upfront-Check und dieser TX unter die Reserve
            // gefallen (z.B. durch einen Pre-Swap) — erst automatisch USDC→SOL nachtanken,
            // dann EINMAL retryen, bevor abgebrochen wird.
            console.warn(`[deposit] ${t('cli.liq.low_sol_selfheal', { step: 'increaseLiquidity', sol: err.solBalance.toFixed(4) })}`);
            const healedSol = await _autoTopUpSol(err.solBalance, config.solReserve + 0.01);
            if (healedSol >= config.solReserve) {
                console.log(`[deposit] ${t('cli.liq.selfheal_ok', { sol: healedSol.toFixed(4), step: 'increaseLiquidity' })}`);
                try {
                    result = await adapter.increaseLiquidity(pool, position.nft_mint, amountA, amountB, DEPOSIT_SLIPPAGE);
                } catch (err2) {
                    await notify.solLow(err2.solBalance ?? healedSol);
                    db.close();
                    abort(err2.message);
                }
            } else {
                await notify.solLow(err.solBalance);
                db.close();
                abort(err.message);
            }
        } else {
            // Orca common-sdk wirft manchmal new Error(confirmTxErr.toString()) — confirmTxErr ist
            // ein Solana Plain-Object, toString() liefert "[object Object]". Solche Fehler und
            // Blockhash-Timeouts sind transient: kein Telegram-Alarm, nur DB-Eintrag (info).
            const rawMsg = typeof err?.message === 'string' ? err.message : String(err ?? '');
            const isTransient =
                err?.name === 'TransactionExpiredBlockheightExceededError' ||
                rawMsg.includes('Blockhash not found') ||
                rawMsg.includes('BlockheightExceeded') ||
                rawMsg === '[object Object]';
            let msg;
            if (isSlippageError(err)) {
                msg = t('cli.liq.slippage_error', { slip: SLIPPAGE_PCT_STR });
            } else if (isInsufficientFundsError(err)) {
                msg = await _describeInsufficientFunds(pool, amountA, amountB, tokenALabel, tokenBLabel);
            } else {
                logActionError(`deposit increaseLiquidity ${pool.pair}`, err);
                const { reasonKey, reasonParams, detail } = describeError(err);
                msg = t('cli.liq.step_failed', { step: 'increaseLiquidity', reason: t(reasonKey, reasonParams), detail });
            }
            if (isTransient) {
                await notify.info(`deposit ${pool.pair}`, msg);
            } else {
                await notify.errorRaw(`deposit ${pool.pair}`, msg);
            }
            db.close();
            abort(msg);
        }
    }

    const depositedUsdc = calcDepositedUsdc(result.tokenEstA, result.tokenEstB, currentPrice, pool, 0, quotePrice);

    // Kapital dieser Position um den deponierten Betrag erhöhen (für myApr-Berechnung)
    const oldCapital = position.capital_usdc ?? 0;
    const newCapital = oldCapital + depositedUsdc;
    updatePositionCapital(db, position.id, newCapital);
    updatePositionHodl(db, position.id, result.tokenEstA, result.tokenEstB);

    // Sofort-Snapshot: Dashboard zeigt neuen LP-Wert sofort, ohne auf den nächsten Bot-Tick zu warten.
    // Strategie: letzten Snapshot als Basis + deponierte Token-Delta addieren.
    // Fees werden aus prev übernommen — `increaseLiquidity` setzt on-chain `feesOwed` nicht zurück,
    // nur `update_fees_and_rewards` wird intern aufgerufen. Der nächste Bot-Tick korrigiert
    // IL und Fees präzise via On-Chain-Read.
    {
        const prevSnap  = db.prepare(
            `SELECT amount_a, amount_b, fees_pending_a, fees_pending_b, fees_pending_usd
             FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`,
        ).get(pool.id);
        const snapAmtA  = (prevSnap?.amount_a ?? 0) + result.tokenEstA;
        const snapAmtB  = (prevSnap?.amount_b ?? 0) + result.tokenEstB;
        const lpVal     = calcDepositedUsdc(snapAmtA, snapAmtB, currentPrice, pool, 0, quotePrice);
        insertPositionSnapshot(db, {
            poolId:         pool.id,
            lpValueUsd:     lpVal,
            feesPendingUsd: prevSnap?.fees_pending_usd ?? 0,
            feesPendingA:   prevSnap?.fees_pending_a   ?? 0,
            feesPendingB:   prevSnap?.fees_pending_b   ?? 0,
            ilUsd:          0,
            ilPct:          0,
            amountA:        snapAmtA,
            amountB:        snapAmtB,
            price:          currentPrice,
        });
        console.log(`[deposit] Sofort-Snapshot: ${lpVal.toFixed(2)} USDC`);
    }

    // Echter Kapital-Zufluss → capital_flows-Eintrag (Quelle für netDeposited).
    // balance_snapshot bleibt für Audit, wird aber nicht mehr als Baseline gelesen.
    insertCapitalFlow(db, {
        poolId:          pool.id,
        usdcAmount:      depositedUsdc,
        balanceSnapshot: null,
        txHash:          result.txHash,
        note:            'Manueller Deposit (increaseLiquidity)',
    });

    const depositFee = await getTxFee(result.txHash);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'deposit',
        amountA:  result.tokenEstA,
        amountB:  result.tokenEstB,
        usdValue: depositedUsdc,
        txHash:   result.txHash,
        txFeeSol: depositFee,
        note:     'Manueller Deposit (increaseLiquidity)',
    });

    // HWM zurücksetzen: Kapital hat sich verändert, neuer Referenzwert wird im nächsten Snapshot etabliert
    db.prepare('UPDATE positions SET hwm_usd = NULL, hwm_at = NULL, hwm_base_adjustment = NULL WHERE pool_id = ? AND closed_at IS NULL').run(pool.id);

    console.log(`[deposit] ✓ ${t('cli.ld.success')}`);
    console.log(`[deposit] TX:       ${result.txHash}`);
    console.log(`[deposit] ${t('cli.liq.head_capital_change', { old: oldCapital.toFixed(2), new: newCapital.toFixed(2) })}`);
    console.log(`[deposit] ${t('cli.liq.hwm_reset')}`);

    // Auto-Activate: Pool als aktiv markieren (DB ist Single Source of Truth)
    if (setPoolActive(pool.id, true)) {
        console.log(`[deposit] ${t('cli.liq.pool_activated', { pool: pool.pair })}`);
    }
    ensureScoreLimitEnabled(pool.id);
    {
        const t = db.prepare(`SELECT tvl_usd FROM pool_stats WHERE pool_id=? AND tvl_usd>0 ORDER BY recorded_at DESC LIMIT 1`).get(pool.id)?.tvl_usd ?? 0;
        ensureTvlProtectionDefaults(pool.id, t, { warn: pool.tvlWarnThreshold, exit: pool.tvlExitThreshold });
    }
    ensureTrailingStopMinimumReset(pool.id);

    await notify.depositAdded(pool, depositedUsdc, result.tokenEstA, result.tokenEstB, result.txHash, false);

    // Portfolio + frischer Wallet-Snapshot + Sync via Orchestrator.
    // Pos-Snapshot wurde oben bereits geschrieben (Sofort-Snapshot via Delta-Arithmetik).
    await refreshAfterAction(db);
    db.close();
    Object.assign(jsonResult, {
        mode: 'increaseLiquidity',
        txHash: result.txHash,
        depositedTokenA: result.tokenEstA,
        depositedTokenB: result.tokenEstB,
        depositedUsdc, tokenALabel, tokenBLabel,
        capitalUsdc: newCapital,
    });
    successExit();
}

// ─── FALL B: Neue Position eröffnen (--new) ───────────────────────────────────

// rangeOverride beachten (z.B. fixedPct: 0.5 für cbBTC/WBTC)
const effectiveRangeB = pool.rangeOverride ? { ...config.range, ...pool.rangeOverride } : config.range;
const range = calculateRange(pool, currentPrice, effectiveRangeB, db);
console.log(`[deposit] Range:   ${range.priceLower.toFixed(4)} – ${range.priceUpper.toFixed(4)} USDC`);

// Modus B/C: manualAmountA/B direkt, kein Wallet-Cap nötig (oben schon geprüft).
const amountBNew = useModeBOrC
    ? Math.min(manualAmountB, (walletTokenB ?? 0) / SLIPPAGE_FACTOR)
    : pool.volatilePair
        ? Math.min(usdPerTokenB > 0 ? (depositAmount / 2) / usdPerTokenB : 0, (walletTokenB ?? 0) / SLIPPAGE_FACTOR)
        : pool.usdcIsTokenA
            ? Math.min(depositAmount, (walletTokenB ?? 0) / SLIPPAGE_FACTOR)
            : Math.min(usdcBudgetB, walletUsdc / SLIPPAGE_FACTOR);
const estTokenANeededB = useModeBOrC
    ? manualAmountA
    : pool.volatilePair
        ? (usdPerTokenA > 0 ? (depositAmount / 2) / usdPerTokenA : 0)
        : clmmTokenAForDeposit(usdcBudgetB, currentPrice, range.priceLower, range.priceUpper);
const amountANew = useModeBOrC
    ? Math.min(manualAmountA, walletTokenA / SLIPPAGE_FACTOR)
    : Math.min(estTokenANeededB * 1.1, walletTokenA / SLIPPAGE_FACTOR);

if (!useModeBOrC && walletTokenA < estTokenANeededB * 0.9) {
    const fehlend = (estTokenANeededB - walletTokenA).toFixed(6);
    abort(t('cli.ld.not_enough_new', { token: tokenALabel, need: estTokenANeededB.toFixed(6), have: walletTokenA.toFixed(6), missing: fehlend }));
}

console.log(`[deposit] ${t('cli.ld.head_capital_pair', { a: amountANew.toFixed(6), tokenA: tokenALabel, b: amountBNew.toFixed(6), tokenB: tokenBLabel })}`);
console.log(`[deposit] Slippage: ${SLIPPAGE_PCT_STR}`);

if (dryRun) {
    // Orca nutzt die passende Token-Seite – mit echter CLMM-Ratio rückrechnen
    const estDepA   = clmmTokenAForDeposit(amountBNew, currentPrice, range.priceLower, range.priceUpper);
    const estCapital = calcDepositedUsdc(estDepA, amountBNew, currentPrice, pool, 0, quotePrice);
    console.log(`[deposit] ${t('cli.ld.expected_deposit', { a: estDepA.toFixed(6), tokenA: tokenALabel, b: amountBNew.toFixed(6), tokenB: tokenBLabel })}`);
    console.log(`[deposit] ${t('cli.ld.expected_lp', { usdc: estCapital.toFixed(2) })}`);
    console.log(`[deposit] ── ${t('cli.ld.dry_run_end')} ────────`);
    Object.assign(jsonResult, {
        mode: 'openPosition', dryRun: true,
        estimatedTokenA: estDepA, estimatedTokenB: amountBNew,
        estimatedUsdc:   estCapital,
        priceLower: range.priceLower, priceUpper: range.priceUpper,
        tokenALabel, tokenBLabel,
    });
    db.close();
    successExit();
}

let resultNew;
try {
    resultNew = await adapter.openPosition(
        pool, range.tickLower, range.tickUpper, amountANew, amountBNew, DEPOSIT_SLIPPAGE
    );
} catch (err) {
    if (err.solBalance !== undefined) {
        // Selbstheilung wie bei increaseLiquidity: erst USDC→SOL nachtanken, dann 1× retryen.
        console.warn(`[deposit] ${t('cli.liq.low_sol_selfheal', { step: 'openPosition', sol: err.solBalance.toFixed(4) })}`);
        const healedSol = await _autoTopUpSol(err.solBalance, config.solReserve + 0.01);
        if (healedSol >= config.solReserve) {
            console.log(`[deposit] ${t('cli.liq.selfheal_ok', { sol: healedSol.toFixed(4), step: 'openPosition' })}`);
            try {
                resultNew = await adapter.openPosition(
                    pool, range.tickLower, range.tickUpper, amountANew, amountBNew, DEPOSIT_SLIPPAGE
                );
            } catch (err2) {
                await notify.solLow(err2.solBalance ?? healedSol);
                db.close();
                abort(err2.message);
            }
        } else {
            await notify.solLow(err.solBalance);
            db.close();
            abort(err.message);
        }
    } else {
        const rawMsgNew = typeof err?.message === 'string' ? err.message : String(err ?? '');
        const isTransientNew =
            err?.name === 'TransactionExpiredBlockheightExceededError' ||
            rawMsgNew.includes('Blockhash not found') ||
            rawMsgNew.includes('BlockheightExceeded') ||
            rawMsgNew === '[object Object]';
        let msg;
        if (isSlippageError(err)) {
            msg = t('cli.liq.slippage_error_short', { slip: SLIPPAGE_PCT_STR });
        } else if (isInsufficientFundsError(err)) {
            msg = await _describeInsufficientFunds(pool, amountANew, amountBNew, tokenALabel, tokenBLabel);
        } else {
            logActionError(`deposit openPosition ${pool.pair}`, err);
            const { reasonKey, reasonParams, detail } = describeError(err);
            msg = t('cli.liq.step_failed', { step: 'openPosition', reason: t(reasonKey, reasonParams), detail });
        }
        if (isTransientNew) {
            await notify.info(`deposit --new ${pool.pair}`, msg);
        } else {
            await notify.errorRaw(`deposit --new ${pool.pair}`, msg);
        }
        db.close();
        abort(msg);
    }
}

// Tatsächlich deponierte Token-Mengen aus Liquidität zurückrechnen
const liquidityBN = new BN(resultNew.liquidity);
const sqrtPrice   = PriceMath.priceToSqrtPriceX64(new Decimal(currentPrice), pool.decimalsA, pool.decimalsB);
const sqrtLower   = PriceMath.tickIndexToSqrtPriceX64(range.tickLower);
const sqrtUpper   = PriceMath.tickIndexToSqrtPriceX64(range.tickUpper);
const realAmounts = PoolUtil.getTokenAmountsFromLiquidity(liquidityBN, sqrtPrice, sqrtLower, sqrtUpper, false);
const realTokenA  = new Decimal(realAmounts.tokenA.toString()).div(new Decimal(10).pow(pool.decimalsA)).toNumber();
const realTokenB  = new Decimal(realAmounts.tokenB.toString()).div(new Decimal(10).pow(pool.decimalsB)).toNumber();
const realCapital = calcDepositedUsdc(realTokenA, realTokenB, currentPrice, pool, 0, quotePrice);

// Neue Position: nur den tatsächlich eingezahlten LP-Wert als Baseline verwenden.
// Die Portfolio-weite Baseline (LP + Wallet) funktioniert nur bei einer einzigen
// Position — bei mehreren Pools würden sich die Werte in SUM(capital_usdc) addieren
// und die Baseline wäre doppelt so hoch wie das tatsächliche Portfolio.
const capitalUsdc  = realCapital;

// In DB speichern (PnL-History zurücksetzen: neues Investment, neuer Start)
clearPositionSnapshots(db, pool.id);
insertPosition(db, {
    poolId:       pool.id,
    nftMint:      resultNew.nftMint,
    tickLower:    range.tickLower,
    tickUpper:    range.tickUpper,
    priceLower:   range.priceLower,
    priceUpper:   range.priceUpper,
    liquidity:    resultNew.liquidity,
    capitalUsdc:  capitalUsdc,
    hodlTokenA:   realTokenA,
    hodlTokenB:   realTokenB,
    hodlPriceUsd: currentPrice,
    openTx:       resultNew.txHash,
    openedAt:     Date.now(),
});

const openNewFee = await getTxFee(resultNew.txHash);
insertTransaction(db, {
    poolId:   pool.id,
    type:     'open_position',
    amountA:  realTokenA,
    amountB:  realTokenB,
    usdValue: realCapital,
    txHash:   resultNew.txHash,
    txFeeSol: openNewFee,
    note:     `Manueller Deposit --new (Tick ${range.tickLower} – ${range.tickUpper})`,
});

// Sofort-Snapshot: Dashboard zeigt neue Position sofort, ohne auf den nächsten Bot-Tick zu warten.
// Bei --new gibt es keinen vorherigen Snapshot — wir nehmen die deponierten Mengen direkt.
// Der nächste Bot-Tick korrigiert IL und Fees präzise via On-Chain-Read.
insertPositionSnapshot(db, {
    poolId:         pool.id,
    lpValueUsd:     realCapital,
    feesPendingUsd: 0,
    feesPendingA:   0,
    feesPendingB:   0,
    ilUsd:          0,
    ilPct:          0,
    amountA:        realTokenA,
    amountB:        realTokenB,
    price:          currentPrice,
});
console.log(`[deposit] Sofort-Snapshot: ${realCapital.toFixed(2)} USDC`);

// Echter Kapital-Zufluss → capital_flows-Eintrag (Quelle für netDeposited).
insertCapitalFlow(db, {
    poolId:          pool.id,
    usdcAmount:      realCapital,
    balanceSnapshot: null,
    txHash:          resultNew.txHash,
    note:            'Manueller Deposit --new',
});

console.log(`[deposit] ✓ ${t('cli.ld.new_position_success')}`);
console.log(`[deposit] NFT:     ${resultNew.nftMint}`);
console.log(`[deposit] TX:      ${resultNew.txHash}`);
const _fmtB = pool.decimalsB >= 8 ? realTokenB.toFixed(6) : realTokenB.toFixed(2);
console.log(`[deposit] ${t('cli.ld.head_capital_real', { a: realTokenA.toFixed(6), tokenA: tokenALabel, b: _fmtB, tokenB: tokenBLabel, usdc: realCapital.toFixed(2) })}`);

// Auto-Activate: Pool als aktiv markieren (DB ist Single Source of Truth)
if (setPoolActive(pool.id, true)) {
    console.log(`[deposit] ${t('cli.liq.pool_activated', { pool: pool.pair })}`);
}
ensureScoreLimitEnabled(pool.id);
{
    const t = db.prepare(`SELECT tvl_usd FROM pool_stats WHERE pool_id=? AND tvl_usd>0 ORDER BY recorded_at DESC LIMIT 1`).get(pool.id)?.tvl_usd ?? 0;
    ensureTvlProtectionDefaults(pool.id, t, { warn: pool.tvlWarnThreshold, exit: pool.tvlExitThreshold });
}
ensureTrailingStopMinimumReset(pool.id);

await notify.depositAdded(pool, realCapital, realTokenA, realTokenB, resultNew.txHash, true);
await notify.positionOpened(pool, {
    priceLower: range.priceLower,
    priceUpper: range.priceUpper,
    nftMint:    resultNew.nftMint,
    txHash:     resultNew.txHash,
});

// Portfolio + frischer Wallet-Snapshot + Sync via Orchestrator.
// Pos-Snapshot wurde oben bereits geschrieben (Sofort-Snapshot für neue Position).
await refreshAfterAction(db);
db.close();
Object.assign(jsonResult, {
    mode: 'openPosition',
    txHash: resultNew.txHash,
    nftMint: resultNew.nftMint,
    depositedTokenA: realTokenA,
    depositedTokenB: realTokenB,
    depositedUsdc:   realCapital,
    priceLower: range.priceLower,
    priceUpper: range.priceUpper,
    tokenALabel, tokenBLabel,
});
successExit();
