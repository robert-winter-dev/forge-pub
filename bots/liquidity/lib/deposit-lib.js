import { PublicKey }  from '@solana/web3.js';
import { Percentage } from '@orca-so/common-sdk';
import {
    getUsableSolBalance, getUsableSolBalanceFresh, getTokenBalance, getTokenBalanceFresh,
    getTxFee, getConnection, USDC_MINT,
} from './wallet.js';
import { swapTokens, isWhirlpoolMintOrderError } from './swap.js';
import {
    getOpenPosition,
    updatePositionCapital, updatePositionHodl, insertTransaction,
    insertPosition, insertPositionSnapshot, insertCapitalFlow, clearPositionSnapshots,
    rebaseHwmForCapitalFlow,
} from './db.js';
import { writePositionSnapshotFromDelta } from './refresh-state.js';
import { isRebalancePending } from './cleanup-lock.js';
import { config, setPoolActive } from './config.js';
import { ensureScoreLimitEnabled, ensureTvlProtectionDefaults, ensureTrailingStopMinimumReset } from './settings-auto.js';
import { calculateRange } from './range.js';
import { PoolUtil, PriceMath } from '@orca-so/whirlpools-sdk';
import Decimal from 'decimal.js';
import BN     from 'bn.js';
import * as notify from './notify.js';

// ─── Konstanten ───────────────────────────────────────────────────────────────

export const DEPOSIT_SLIPPAGE = Percentage.fromFraction(1, 200); // 0.5 %
export const SLIPPAGE_FACTOR  = 1.005;                           // muss mit DEPOSIT_SLIPPAGE übereinstimmen

const WSOL_MINT            = 'So11111111111111111111111111111111111111112';
const CBTC_MINT            = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
const SOL_TX_FEE_BUFFER    = 0.005;
const MIN_USDC_AMOUNT      = 1.0;
const PRESWAP_SLIPPAGE_BPS = 150; // höherer Slippage für Cleanup-Swaps (cbBTC/EURC illiquid)

// ─── Gemeinsame Hilfsfunktionen ───────────────────────────────────────────────

/**
 * Zuletzt GEMESSENER Positionswert eines Pools (letzter position_snapshots-Eintrag).
 * Muss vor jedem Kapitalfluss gelesen werden — writePositionSnapshotFromDelta überschreibt
 * ihn danach mit einem schätzungsbasierten Wert.
 */
function _lastMeasuredLpValue(db, poolId) {
    return db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).get(poolId)?.lp_value_usd ?? 0;
}

/**
 * Schreibt den Kapitalfluss in der Trailing-Stop-Referenz nach (Details: rebaseHwmForCapitalFlow
 * in lib/db.js). Ohne diesen Aufruf übernimmt die monoton steigende HWM beim nächsten Snapshot
 * einfach den erhöhten Positionswert — der bis dahin aufgelaufene Drawdown-Abstand geht verloren
 * und der Trailing Stop startet bei jeder Cleanup-Einzahlung faktisch neu.
 */
function _rebaseHwmAfterDeposit(db, pool, positionId, lpBefore) {
    const { drawdownPct, applied } = rebaseHwmForCapitalFlow(db, positionId, lpBefore);
    if (applied) {
        console.log(`[deposit-lib] ${pool.pair}: Trailing-Stop-Referenz übertragen (Abstand zum Höchststand: ${drawdownPct.toFixed(2)} %)`);
    }
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

    const depositedUsdc = calcDepositedUsdc(result.tokenEstA, result.tokenEstB, currentPrice, pool);
    updatePositionCapital(db, position.id, (position.capital_usdc ?? 0) + depositedUsdc);
    updatePositionHodl(db, position.id, result.tokenEstA, result.tokenEstB);
    _rebaseHwmAfterDeposit(db, pool, position.id, lpBefore);
    const txFee = await getTxFee(result.txHash);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'deposit',
        amountA:  result.tokenEstA,
        amountB:  result.tokenEstB,
        usdValue: depositedUsdc,
        txHash:   result.txHash,
        txFeeSol: txFee,
        note,
    });

    // Position-Snapshot via Delta → "Mein Anteil" sofort aktuell (kein Warten auf Bot-Tick).
    writePositionSnapshotFromDelta(db, pool, result.tokenEstA, result.tokenEstB, currentPrice);

    console.log(`[deposit-lib] ${pool.pair}: ✓ +${depositedUsdc.toFixed(2)} USDC   TX: ${result.txHash}`);
    return depositedUsdc;
}

/**
 * usdcIsTokenA-Deposit (z.B. EURC/USDC): USDC-Budget → CLMM-Split → Pre-Swap USDC→tokenB → deposit.
 * Gibt eingezahlten USDC-Betrag zurück (0 bei Skip/Fehler).
 */
export async function depositUsdcIsTokenA(pool, depositUsdc, keypair, db, adapter, { note = 'deposit' } = {}) {
    const tokenBSymbol = pool.pair.split('/')[0]; // 'EURC' für EURC/USDC (tokenA=USDC, tokenB=EURC)

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

    const depositedUsdc = calcDepositedUsdc(result.tokenEstA, result.tokenEstB, currentPrice, pool);
    updatePositionCapital(db, position.id, (position.capital_usdc ?? 0) + depositedUsdc);
    updatePositionHodl(db, position.id, result.tokenEstA, result.tokenEstB);
    _rebaseHwmAfterDeposit(db, pool, position.id, lpBefore);
    const txFee = await getTxFee(result.txHash);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'deposit',
        amountA:  result.tokenEstA,
        amountB:  result.tokenEstB,
        usdValue: depositedUsdc,
        txHash:   result.txHash,
        txFeeSol: txFee,
        note,
    });

    // Position-Snapshot via Delta → "Mein Anteil" sofort aktuell.
    writePositionSnapshotFromDelta(db, pool, result.tokenEstA, result.tokenEstB, currentPrice);

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
async function openVolatilePairPosition(pool, keypair, db, adapter, { note = 'cleanup', quotePrice = 0 } = {}) {
    // ─── 1. Frische Preise ────────────────────────────────────────────────────
    let poolStats, resolvedQuotePrice;
    try {
        poolStats = await adapter.getPoolStats(pool);
        if (quotePrice > 0) {
            resolvedQuotePrice = quotePrice;
        } else {
            resolvedQuotePrice = getTokenUsdPrice(pool.quoteTokenMint, db);
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
    const capitalUsdc = calcDepositedUsdc(realTokenA, realTokenB, currentPrice, pool, 0, resolvedQuotePrice);

    // ─── 6. DB-Einträge ───────────────────────────────────────────────────────
    clearPositionSnapshots(db, pool.id);
    insertPosition(db, {
        poolId:       pool.id,
        nftMint:      result.nftMint,
        tickLower:    range.tickLower,
        tickUpper:    range.tickUpper,
        priceLower:   range.priceLower,
        priceUpper:   range.priceUpper,
        liquidity:    result.liquidity,
        capitalUsdc,
        hodlTokenA:   realTokenA,
        hodlTokenB:   realTokenB,
        hodlPriceUsd: currentPrice,
        openTx:       result.txHash,
        openedAt:     Date.now(),
    });
    const openFee = await getTxFee(result.txHash);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'open_position',
        amountA:  realTokenA,
        amountB:  realTokenB,
        usdValue: capitalUsdc,
        txHash:   result.txHash,
        txFeeSol: openFee,
        note:     `${note} (Tick ${range.tickLower} – ${range.tickUpper})`,
    });
    insertPositionSnapshot(db, {
        poolId:         pool.id,
        lpValueUsd:     capitalUsdc,
        feesPendingUsd: 0,
        feesPendingA:   0,
        feesPendingB:   0,
        ilUsd:          0,
        ilPct:          0,
        amountA:        realTokenA,
        amountB:        realTokenB,
        price:          currentPrice,
    });
    insertCapitalFlow(db, {
        poolId:          pool.id,
        usdcAmount:      capitalUsdc,
        balanceSnapshot: null,
        txHash:          result.txHash,
        note:            `${note} openPosition`,
        isExternal:      0,  // cleanup-intern, kein externer Kapitalfluss
    });

    // ─── 7. Pool aktivieren (DB ist Single Source of Truth) ───────────────────
    if (setPoolActive(pool.id, true)) {
        console.log(`[deposit-lib:open] Pool ${pool.pair} auf active=true gesetzt`);
    }
    ensureScoreLimitEnabled(pool.id);
    {
        const tvlNow = db.prepare(`SELECT tvl_usd FROM pool_stats WHERE pool_id=? AND tvl_usd>0 ORDER BY recorded_at DESC LIMIT 1`).get(pool.id)?.tvl_usd ?? 0;
        ensureTvlProtectionDefaults(pool.id, tvlNow, { warn: pool.tvlWarnThreshold, exit: pool.tvlExitThreshold });
    }
    ensureTrailingStopMinimumReset(pool.id);

    // ─── 8. Notifications ────────────────────────────────────────────────────
    await notify.depositAdded(pool, capitalUsdc, realTokenA, realTokenB, result.txHash, true);
    await notify.positionOpened(pool, {
        priceLower: range.priceLower,
        priceUpper: range.priceUpper,
        nftMint:    result.nftMint,
        txHash:     result.txHash,
    });

    console.log(`[deposit-lib:open] ${pool.pair}: ✓ Neue Position  NFT: ${result.nftMint}  ~${capitalUsdc.toFixed(2)} USDC`);
    return capitalUsdc;
}

export async function depositVolatilePair(pool, keypair, db, adapter, { note = 'volatilePair', quotePrice = 0 } = {}) {
    const position = getOpenPosition(db, pool.id);
    if (!position) {
        // Keine existierende Position → neue eröffnen (z.B. Erstbefüllung via Cleanup)
        return openVolatilePairPosition(pool, keypair, db, adapter, { note, quotePrice });
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
        : getTokenUsdPrice(pool.quoteTokenMint, db);
    const currentPrice  = state.currentPrice ?? 0;
    const depositedUsdc = calcDepositedUsdc(result.tokenEstA, result.tokenEstB, currentPrice, pool, 0, resolvedQuotePrice);
    updatePositionCapital(db, position.id, (position.capital_usdc ?? 0) + depositedUsdc);
    updatePositionHodl(db, position.id, result.tokenEstA, result.tokenEstB);
    _rebaseHwmAfterDeposit(db, pool, position.id, lpBefore);
    const txFee = await getTxFee(result.txHash);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'deposit',
        amountA:  result.tokenEstA,
        amountB:  result.tokenEstB,
        usdValue: depositedUsdc > 0 ? depositedUsdc : null,
        txHash:   result.txHash,
        txFeeSol: txFee,
        note,
    });

    writePositionSnapshotFromDelta(db, pool, result.tokenEstA, result.tokenEstB, currentPrice);

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
