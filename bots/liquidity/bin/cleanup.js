/**
 * FORGE Liquidity – Cleanup-Job (bin/cleanup.js)
 *
 * Verwertet Wallet-Reste automatisch (SOL ausgenommen). Ablauf pro Lauf:
 *  0. Kapital-Abgleich (reconcileCapitalFlows) und SOL-Topup — laufen in JEDEM Modus,
 *     auch bei CLEANUP_MODE=disabled (LIQ#000929: „disabled" heißt nur „kein Invest").
 *  1. Invest-Logik je CLEANUP_MODE (lib/cleanup-mode.js):
 *       'disabled' → kein Invest (Default)
 *       'pool:X'   → fest in den gewählten Pool X
 *     Der frühere Modus 'ranking' („Bester Pool") ist seit LIQ#000929 entfallen und wird
 *     wie 'disabled' behandelt. Optionales Trend-Gate (CLEANUP_TREND_GATE, z.B. '4h,1d')
 *     gilt für den festen Pool. Konsolidiert dabei Fremd-Token-Reste ab MIN_SWAP_USDC zu
 *     USDC und zahlt ein.
 *  2. Dust-Sweep (sweepDust, per Settings → Cleanup → Dust an/abschaltbar):
 *     verbleibende bekannte Pool-Token-Reste zwischen CLEANUP_DUST_MIN_USDC und
 *     CLEANUP_DUST_MAX_USDC (Default 0,01–25) → komplett zu USDC. Darunter
 *     vernachlässigbar (liegen lassen), darüber bleibt liegen (regulärer Invest folgt).
 *
 * Cron: stündlich :05 via FORGE/bin/run-cleanup.sh
 * Probelauf ohne On-Chain-Aktion und ohne Schreibzugriff: --dry-run
 */

import { PublicKey }  from '@solana/web3.js';
import {
    config, setPoolActive, isPoolEnabled, getCleanupTrendGateFromEnv,
    setCleanupModeInEnv, removeKeysFromEnv,
} from '../lib/config.js';
import { resolveCleanupMode } from '../lib/cleanup-mode.js';
import { t } from '../../../lib/i18n.js';
import { ensureTvlProtectionDefaults, ensureTrailingStopMinimumReset } from '../lib/settings-auto.js';
import {
    openDatabase, syncPools, insertTransaction, noteSwapFail, resetSwapFail,
} from '../lib/db.js';
import { getAdapter }  from '../lib/pool-adapter/index.js';
import { swapTokens, isWhirlpoolMintOrderError }  from '../lib/swap.js';
import {
    getKeypair, getConnection, USDC_MINT,
    getSolBalance, getSolBalanceFresh, getUsableSolBalance, getUsableSolBalanceFresh,
    getUsableUsdcBalanceFresh,
    getTokenBalanceFresh, getAllTokenBalances, getTxFee,
} from '../lib/wallet.js';
import * as notify     from '../lib/notify.js';
import { recordFailure, recordSuccess } from '../lib/fail-streak.js';
import { refreshAfterAction } from '../lib/refresh-state.js';
import { acquireLock, releaseLock, isSlLocked, isManualLocked, isRebalanceLocked } from '../lib/cleanup-lock.js';
import { getExitReservations, describeReservation, assertReservationsReadable } from '../lib/exit-reservation.js';
import { deposit, getTokenUsdPrice, checkClmmRatio } from '../lib/deposit-lib.js';
import { reconcileCapitalFlows } from '../lib/capital-reconcile.js';
import { ensureWalletSol, INVEST_SOL_COMFORT, SOL_TOPUP_TARGET } from '../lib/sol-topup.js';
import {
    getOpenPosition, getDustWatch, startDustWatch, clearDustWatch,
} from '../lib/db.js';
import { checkInvestEligibility, remainingInvestCapacity } from '../lib/invest-eligibility.js';
import { investCooldownBlockedPools } from '../lib/invest-cooldown.js';
import { parseTrendGate, loadTrendStates, checkTrendGate } from '../lib/trend-indicators.js';
import { calculateRange } from '../lib/range.js';

// ─── --help ────────────────────────────────────────────────────────────────
// Muss vor jedem Modul-Level-Seiteneffekt (DB/Wallet/Connection weiter unten)
// geprüft werden, damit `--help` garantiert keinen echten Cleanup-Lauf auslöst.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
FORGE Liquidity – Cleanup-Job (bin/cleanup.js)

Verwertet Wallet-Reste automatisch (SOL ausgenommen). Läuft normalerweise
stündlich per Cron (FORGE/bin/run-cleanup.sh). Ohne --dry-run führt jeder
Aufruf echte On-Chain-Swaps/Deposits aus, sobald genug Guthaben da ist.

Ablauf pro Lauf:
  0. Kapital-Abgleich und SOL-Topup – in jedem Modus, auch bei 'disabled'.
  1. Invest-Logik je CLEANUP_MODE (Env-Var, Default 'disabled'):
       disabled → kein Invest
       pool:X   → fest in den gewählten Pool X
     Der frühere Modus 'ranking' ist entfallen und wird wie 'disabled' behandelt.
     Konsolidiert dabei Fremd-Token-Reste ab MIN_SWAP_USDC zu USDC und zahlt sie ein.
  2. Dust-Sweep (CLEANUP_DUST_ENABLED, Default an – in jedem Modus): bekannte
     Pool-Token-Reste zwischen CLEANUP_DUST_MIN_USDC und CLEANUP_DUST_MAX_USDC
     werden zu USDC geswappt. Reste ab der Obergrenze nach CLEANUP_STUCK_HOURS
     (Default 24 h) ebenfalls (Notbremse).

Relevante Env-Vars: CLEANUP_MODE, CLEANUP_MIN_DEPOSIT, CLEANUP_TREND_GATE,
CLEANUP_DUST_ENABLED, CLEANUP_DUST_MIN_USDC, CLEANUP_DUST_MAX_USDC, CLEANUP_STUCK_HOURS.

CLEANUP_TREND_GATE=<Liste>  Trend-Gate, Komma-Liste aus 1h, 4h, 1d (leer = aus).
                            Investiert nur in Pools, deren EMA-Trend auf JEDER
                            genannten Zeitebene aufwärts zeigt (lib/trend-indicators.js).

Aufruf: node bin/cleanup.js
        node bin/cleanup.js --dry-run (Probelauf: nur Entscheidungen loggen – keine
                                       Swaps, kein Deposit, keine DB-/.env-Schreibzugriffe,
                                       keine Benachrichtigung)
        node bin/cleanup.js --help    (dieser Text, kein Cleanup-Lauf)
`);
    process.exit(0);
}

// ─── Probelauf ────────────────────────────────────────────────────────────────
// --dry-run: alle Entscheidungen werden geloggt, aber nichts ausgeführt — keine Swaps,
// kein Deposit, keine Pool-Reaktivierung, keine Schreibzugriffe auf DB und .env,
// keine Benachrichtigung, kein Cleanup-Lock. Bis LIQ#000929 gab es keinen Probelauf:
// jeder Aufruf bewegte Kapital, sobald Guthaben da war.
const DRY_RUN = process.argv.includes('--dry-run');
const DRY = '[DRY-RUN] ';

// ─── Trend-Gate (nur für den festen Pool 'pool:<id>') ────────────────────────
// Komma-Liste geforderter Zeitebenen, z.B. 'CLEANUP_TREND_GATE=4h,1d'. Leer = aus
// (unverändertes Verhalten). Ein Pool darf nur Ziel eines Invests sein, wenn auf
// JEDER geforderten Zeitebene der EMA-Trend aufwärts zeigt — Definition und
// Messgrundlage stehen in lib/trend-indicators.js.
//
// Frisch aus der .env gelesen (nicht process.env): dieselbe Quelle, aus der
// bin/export.js den Gate-Zustand fürs Dashboard schreibt. Zwei Wahrheiten über
// dieselbe Einstellung wären genau der Fall, den lib/invest-cooldown.js
// vermeiden sollte.
const CLEANUP_TREND_GATE = parseTrendGate(getCleanupTrendGateFromEnv());

// ─── Minimale Einzahlung ──────────────────────────────────────────────────────
// 0 = kein Minimum (Standard). Werte < 1 werden ignoriert. Wirkt hier als absoluter
// Floor beim Reaktivieren eines Pools und als Mindestbetrag für den USDC-Invest.
// Dieselbe Einstellung nutzt bin/bot.js beim Öffnen einer Position
// (getCleanupMinDepositFromEnv) — sie gilt also nicht nur für den Cleanup.
// CLEANUP_MAX_DEPOSIT wirkt seit LIQ#000929 nur noch in bin/bot.js: der Deckel galt im
// Cleanup ausschließlich für den entfallenen Modus 'ranking', der feste Pool lief schon
// immer ohne Cap.
const CLEANUP_MIN_DEPOSIT = (() => {
    const v = parseFloat(process.env.CLEANUP_MIN_DEPOSIT ?? '0');
    return v >= 1 ? v : 0;
})();

// ─── Mode-Check ───────────────────────────────────────────────────────────────
// CLEANUP_MODE: 'disabled' | 'pool:<pool_id>' — Auflösung in lib/cleanup-mode.js.
// 🔒 'disabled' beendet den Lauf NICHT mehr vorzeitig (LIQ#000929). Bis dahin stand hier
// ein process.exit(0), der auch Kapital-Abgleich, SOL-Topup und Dust-Sweep abschaltete —
// auf business 14 Tage unbemerkt (09.–23.09.2026). „disabled" heißt nur „kein Invest".
const CLEANUP_MODE_RESOLVED = resolveCleanupMode(process.env.CLEANUP_MODE);
const CLEANUP_MODE          = CLEANUP_MODE_RESOLVED.mode;

// ─── Konstanten ───────────────────────────────────────────────────────────────

const MIN_USDC_AMOUNT  = 1.0;   // Mindest-USDC-Äquivalent für Deposits
const MIN_SWAP_USDC    = 2.0;   // Mindest-USDC-Äquivalent für Swaps (Pool-Invest) – Dust darunter wird übersprungen

// ─── Dust-Sweep – konfigurierbar über Settings (Cleanup → Dust) ──────────────
// Default true (bisheriges Verhalten unverändert), Grenzwerte wie zuvor als
// Default (0,01 / 25 USDC). Fehlt der Key (ältere .env), gilt der alte Default.
const CLEANUP_DUST_ENABLED = process.env.CLEANUP_DUST_ENABLED !== 'false';
const DUST_SWAP_MIN_USDC = (() => {
    const v = parseFloat(process.env.CLEANUP_DUST_MIN_USDC ?? '0.01');
    return v >= 0 ? v : 0.01;
})(); // Pool-Token-Reste ab diesem Gegenwert → komplett zu USDC geswappt
const DUST_SWAP_MAX_USDC = (() => {
    const v = parseFloat(process.env.CLEANUP_DUST_MAX_USDC ?? '25');
    return v > 0 ? v : 25;
})(); // ... bis unter diesen Gegenwert (drüber: bleibt liegen, regulärer Deposit folgt)
// Notbremse für Reste >= DUST_SWAP_MAX_USDC: ohne Zeitlimit könnten größere Beträge
// beliebig lange als volatiles Asset im Wallet hängen bleiben. Nach CLEANUP_STUCK_HOURS,
// in denen kein Cleanup-Invest (Modus 'pool:X') den Rest aufgenommen hat, wird trotzdem
// zu USDC geswappt. Seit LIQ#000929 gilt das in jedem Modus: bei 'disabled' gibt es
// keinen Invest, der Rest wandert also nach CLEANUP_STUCK_HOURS zu USDC.
const CLEANUP_STUCK_HOURS = (() => {
    const v = parseFloat(process.env.CLEANUP_STUCK_HOURS ?? '24');
    return v > 0 ? v : 24;
})();
const CLEANUP_SLIPPAGE_BPS = 150; // Höherer Slippage für Cleanup-Swaps (cbBTC illiquid bei Mitternacht)
const SOL_TX_FEE_BUFFER = 0.005; // Extra-Puffer über solReserve hinaus für TX-Fees bei SOL-Deposits
const MIN_CROSS_SWAP_USDC = 0.30; // Cross-Swap (cbBTC↔WBTC) ab Surplus ≥ 0.30 USDC – verhindert 0-Deposits

const WSOL_MINT     = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS  = 9;
const USDC_DECIMALS = 6;

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

/**
 * Gibt alle relevanten nicht-SOL, nicht-USDC Tokens aus aktiven Pools zurück.
 * Dedupliziert nach Mint.
 */
function getRelevantTokens(pools) {
    const tokens = new Map();
    for (const pool of pools) {
        if (pool.tokenA !== WSOL_MINT && pool.tokenA !== USDC_MINT) {
            tokens.set(pool.tokenA, {
                mint:     pool.tokenA,
                decimals: pool.decimalsA,
                symbol:   pool.pair.split('/')[0],
            });
        }
        if (pool.tokenB !== WSOL_MINT && pool.tokenB !== USDC_MINT) {
            tokens.set(pool.tokenB, {
                mint:     pool.tokenB,
                decimals: pool.decimalsB,
                symbol:   pool.usdcIsTokenA ? pool.pair.split('/')[0] : pool.pair.split('/')[1],
            });
        }
    }
    return [...tokens.values()];
}

/**
 * Mints, die gerade zu einem laufenden Exit gehören (Ticket LIQ#0310).
 *
 * Bewusst bei JEDER Prüfstelle frisch gelesen und nicht einmal pro Lauf: ein
 * Cleanup-Durchgang dauert wegen der On-Chain-Swaps Minuten, in denen ein Exit erst
 * beginnen kann. Ein Snapshot vom Laufbeginn würde genau dieses Fenster offenlassen.
 * Die Abfrage kostet sechs indizierte Reads auf kleine Tabellen.
 *
 * @returns {Map|null} Map der reservierten Mints, oder `null` wenn der Zustand nicht
 *   verlässlich gelesen werden konnte — dann muss der Aufrufer so handeln, als liefe
 *   ein Exit (nicht investieren ist folgenlos, falsch investieren nicht).
 */
function loadReservedMints(db, logPrefix) {
    const reservations = getExitReservations(db);
    if (!assertReservationsReadable(reservations, logPrefix)) return null;

    for (const s of reservations.stale) {
        // Nur ins Journal, keine Benachrichtigung: der Cleanup läuft stündlich, eine
        // notify.warn hier würde bei einem hängenden Exit 24-mal am Tag feuern. Das
        // Erkennen dauerhafter Zustände gehört in bin/forge-check.js.
        console.warn(
            `${logPrefix} ⚠ Exit hängt: ${describeReservation(s)} – Reservierung bleibt bestehen, `
            + `Kapital liegt so lange ungenutzt. Bitte nachsehen.`,
        );
    }
    return reservations.mints;
}

/**
 * Filtert Token, die zu einem laufenden Exit gehören, aus einer Kandidatenliste und
 * protokolliert jede Auslassung.
 *
 * @param {Array} tokens        Kandidaten aus getRelevantTokens()
 * @param {Map|null} reserved   Ergebnis von loadReservedMints()
 * @returns {Array} die unbedenklichen Token (leer, wenn `reserved` null ist)
 */
function withoutReservedTokens(tokens, reserved, logPrefix) {
    if (reserved === null) {
        console.warn(`${logPrefix} Exit-Zustand unbekannt – kein Token wird angefasst.`);
        return [];
    }
    if (reserved.size === 0) return tokens;

    const free = [];
    for (const token of tokens) {
        const entry = reserved.get(token.mint);
        if (entry) {
            console.log(
                `${logPrefix} ${token.symbol} gehört zu einem laufenden Exit `
                + `(${describeReservation(entry)}) – nicht angefasst.`,
            );
            continue;
        }
        free.push(token);
    }
    return free;
}

/**
 * Mints, deren eigener Pool aktiv ist, aber gerade keine offene Position hat (LIQ#0355).
 *
 * Genau der Zustand zwischen einem Close und der nächsten erfolgreichen Wiedereröffnung:
 * der Bot baut das Kapital dafür oft schrittweise über mehrere Zyklen per Pre-Swap auf
 * (siehe _openNewPosition in bot.js), bevor die 30-%-Mindestschwelle erreicht ist. Der
 * Dust-Sweep kannte diesen Zustand bisher nicht und hat den frisch pre-geswappten Rest
 * beim nächsten Lauf sofort wieder zu USDC zurückgetauscht — dadurch kam das Kapital nie
 * über die Schwelle (ZEC/USDC auf pub1, 29./30.08.2026: der Bot retryte seit dem Vorabend
 * ergebnislos, weil jeder stündliche Cleanup-Lauf den Pre-Swap rückgängig machte und das
 * so freigewordene Geld einem anderen Pool zuwies statt es für ZEC/USDC liegen zu lassen).
 */
function loadAccumulatingPoolMints(db) {
    const mints = new Map();
    for (const pool of config.pools.all) {
        if (!pool.active || getOpenPosition(db, pool.id)) continue;
        if (pool.tokenA !== WSOL_MINT && pool.tokenA !== USDC_MINT) mints.set(pool.tokenA, pool.id);
        if (pool.tokenB !== WSOL_MINT && pool.tokenB !== USDC_MINT) mints.set(pool.tokenB, pool.id);
    }
    return mints;
}

/**
 * Findet einen Orca-Pool in der Config, dessen beide Token exakt {inputMint, outputMint}
 * sind — unabhängig von `active`. Dient dem direkten-Orca-Swap-Fallback in swapTo:
 * reine-Orca-Token (xStocks) haben nur in ihrem eigenen Whirlpool Liquidität.
 */
function findDirectOrcaPool(inputMint, outputMint) {
    return config.pools.all.find(p =>
        p.protocol === 'orca' &&
        ((p.tokenA === inputMint  && p.tokenB === outputMint) ||
         (p.tokenA === outputMint && p.tokenB === inputMint))
    ) ?? null;
}

/**
 * Tauscht `amount` Token gegen einen Ziel-Token (SOL oder USDC) via Jupiter.
 *
 * Fallback: Scheitert der Jupiter-Swap mit Orca-Error 6024 (InvalidTokenMintOrder /
 * 0x1788) — typisch für reine-Orca-Token wie xStocks SPYx/TSLAx/SPCX, bei denen
 * Jupiters Tx-Builder die Mint-Reihenfolge falsch zusammensetzt — und existiert ein
 * passender Orca-Direktpool, wird der Swap kanonisch über das Orca-SDK ausgeführt.
 */
async function swapTo(token, amount, outputMint, outputDecimals, outputSymbol, keypair, connection, poolId = null, noteLabel = 'cleanup') {
    const label = `${token.symbol}→${outputSymbol}`;
    const RETRY_DELAY_MS = 90_000;
    const MAX_ATTEMPTS   = 2;
    // Fehlschläge (2/2 intra-Run-Versuche) sind oft selbstheilend – Schritt 6
    // (Cross-Swap) gleicht die Balance im selben oder einem der nächsten Läufe
    // häufig automatisch aus. Erst der 3. Fehlschlag in Folge (über Cron-Läufe
    // hinweg, DB-persistiert) eskaliert zu einer echten Telegram-Warnung.
    const ESCALATE_AT = 3;
    const swapKey = `${poolId ?? 'none'}:${label}`;

    // Erfasst einen erfolgreichen Swap in der DB (gemeinsam für Jupiter- und Orca-Pfad).
    const recordSwap = async (amountOut, txSignature) => {
        const swapFee = await getTxFee(txSignature);
        // usdValue: USDC-Seite wenn vorhanden, sonst über Preis-Lookup (z.B. cbBTC→WBTC)
        let usdValue = outputMint === USDC_MINT ? amountOut
            : token.mint   === USDC_MINT ? amount
            : null;
        if (usdValue == null) {
            const inputPrice = getTokenUsdPrice(token.mint, db);
            if (inputPrice > 0) usdValue = amount * inputPrice;
        }
        // usd_value_in/out (LIQ#0376 Teil 2): unabhängig von usdValue (das oben die
        // USDC-Seite meint, mal Eingang mal Ausgang) — immer Eingang bzw. Ausgang, jeweils
        // exakt bei USDC, sonst über getTokenUsdPrice (derselbe Preis-Helfer, ein Read je
        // Seite, keine Zeit dazwischen).
        const priceOf = (mint) => mint === USDC_MINT ? 1 : (getTokenUsdPrice(mint, db) || null);
        const pIn  = priceOf(token.mint);
        const pOut = priceOf(outputMint);
        insertTransaction(db, {
            poolId, type: 'swap',
            amountA: amount, amountB: amountOut,
            usdValue, txHash: txSignature,
            usdValueIn:  pIn  != null ? amount    * pIn  : null,
            usdValueOut: pOut != null ? amountOut * pOut : null,
            txFeeSol: swapFee, note: `${noteLabel} swap ${label}`,
        });
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(`[cleanup] swap ${amount.toFixed(6)} ${label}${attempt > 1 ? ` (Versuch ${attempt})` : ''}`);
        try {
            const { amountOut, txSignature } = await swapTokens({
                inputMint:     token.mint,
                outputMint,
                inputDecimals: token.decimals,
                outputDecimals,
                amount,
                wallet:        keypair,
                connection,
                apiKey:        null,
                slippageBps:   CLEANUP_SLIPPAGE_BPS,
            });
            console.log(`[cleanup] swap ✓ → ${amountOut.toFixed(6)} ${outputSymbol}   TX: ${txSignature}`);
            await recordSwap(amountOut, txSignature);
            resetSwapFail(db, swapKey);
            return true;
        } catch (err) {
            // Jupiter-Builder-Bug bei reinen-Orca-Token: direkter Orca-swapV2 umgeht ihn.
            if (isWhirlpoolMintOrderError(err)) {
                const directPool = findDirectOrcaPool(token.mint, outputMint);
                if (directPool) {
                    try {
                        console.warn(`[cleanup] ${label}: ${t('cli.cl.mint_order_fallback', { pool: directPool.pair })}`);
                        const { amountOut, txSignature } = await getAdapter(directPool).swapExactIn({
                            poolAddress:   directPool.address,
                            inputMint:     token.mint,
                            inputDecimals: token.decimals,
                            outputMint,
                            outputDecimals,
                            amount,
                            slippageBps:   CLEANUP_SLIPPAGE_BPS,
                        });
                        console.log(`[cleanup] swap ✓ (Orca direkt) → ${amountOut.toFixed(6)} ${outputSymbol}   TX: ${txSignature}`);
                        await recordSwap(amountOut, txSignature);
                        resetSwapFail(db, swapKey);
                        return true;
                    } catch (orcaErr) {
                        console.warn(`[cleanup] ${label}: direkter Orca-Swap fehlgeschlagen: ${orcaErr.message}`);
                        // weiter in den normalen Retry-/Notify-Pfad
                    }
                } else {
                    console.warn(`[cleanup] ${label}: ${t('cli.cl.mint_order_no_pool')}`);
                }
            }
            console.warn(`[cleanup] swap ${label} fehlgeschlagen (Versuch ${attempt}): ${err.message}`);
            if (attempt < MAX_ATTEMPTS) {
                console.log(`[cleanup] Warte ${RETRY_DELAY_MS / 1000}s vor erneutem Versuch…`);
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            } else {
                const fails = noteSwapFail(db, swapKey, err.message);
                if (fails < ESCALATE_AT) {
                    console.warn(`[cleanup] swap ${label} ${t('cli.cl.swap_transient', { fails, max: ESCALATE_AT })}`);
                } else {
                    await notify.warn(`cleanup swap ${label} ${fails}× in Folge fehlgeschlagen`, err);
                }
            }
        }
    }
    return false;
}

// ─── Dust-Sweep ────────────────────────────────────────────────────────────────
//
// Räumt kleine Pool-Token-Reste („Dust") aus dem Wallet, die sonst ungenutzt
// liegen bleiben. Läuft in JEDEM Cleanup-Lauf, auch bei CLEANUP_MODE='disabled'
// (LIQ#000929), unabhängig davon ob überhaupt in einen Pool investiert wurde.
//
// Nur bekannte Pool-Tokens (config.pools.all, nicht SOL/USDC):
//   < DUST_SWAP_MIN_USDC (0,01)  → vernachlässigbar, liegen lassen
//   0,01 – < 25 USDC             → komplett zu USDC swappen
//   >= DUST_SWAP_MAX_USDC (25)   → liegen lassen; im Modus 'pool:X' nimmt der
//                                  Invest ihn im nächsten Lauf auf – außer die
//                                  Beobachtung (dust_watch) läuft schon seit
//                                  CLEANUP_STUCK_HOURS (Default 24h) ohne Erfolg,
//                                  dann Notbremse: trotzdem zu USDC swappen (noteLabel
//                                  'stuck-dust', Dashboard zeigt "Dust Swap 24h").
//                                  Bei 'disabled' gibt es keinen Invest – dort greift
//                                  die Notbremse regulär nach CLEANUP_STUCK_HOURS.
//
// Kein SOL-Swap: SOL-Bedarf deckt die Selbstheilung (lib/sol-topup.js) ab.
// Läuft NACH der Invest-Logik: der Pool-Invest hat bereits die
// Fremd-Token-Reste ab MIN_SWAP_USDC konsolidiert; hier bleiben nur die kleinen
// Reste darunter — genau die, die sonst dauerhaft im Wallet liegen bleiben.
async function sweepDust(db, keypair, connection, { dryRun = false } = {}) {
    // Probelauf: dust_watch weder anlegen noch löschen — sonst verschöbe ein
    // --dry-run die 24-h-Frist der Notbremse.
    const startWatch = (mint, usd) => { if (!dryRun) startDustWatch(db, mint, usd); };
    const clearWatch = (mint)      => { if (!dryRun) clearDustWatch(db, mint); };

    // 🔒 LIQ#0310: auch der Dust-Sweep greift mint-basiert zu und muss Token eines
    // laufenden Exits auslassen. Er ist zwar auf CLEANUP_DUST_MAX_USDC gedeckelt und
    // hätte Position 336 nicht anfassen können — aber die „Notbremse" nach
    // CLEANUP_STUCK_HOURS swappt auch Beträge oberhalb des Deckels, und ein Exit auf
    // einer kleinen Position liegt ohnehin im Dust-Fenster.
    const accumulatingMints = loadAccumulatingPoolMints(db);
    const candidateTokens = getRelevantTokens(config.pools.all).filter(token => {
        const ownerPoolId = accumulatingMints.get(token.mint);
        if (!ownerPoolId) return true;
        console.log(`[cleanup:dust] ${token.symbol} gehört zum aktiven Pool ${ownerPoolId}, der `
            + `gerade Kapital für eine Wiedereröffnung aufbaut – nicht angefasst.`);
        return false;
    });
    const relevantTokens = withoutReservedTokens(
        candidateTokens,
        loadReservedMints(db, '[cleanup:dust]'),
        '[cleanup:dust]',
    );
    // Grobfilter über den (evtl. gecachten) Gesamt-Read; die tatsächliche
    // Swap-Menge + Dust-Einstufung nutzt danach einen Fresh-Read pro Kandidat,
    // da der vorherige Invest-Schritt Balances verändert haben kann (Cache stale).
    const coarse = await getAllTokenBalances(keypair.publicKey);

    // ── Dust-Ziel: USDC oder SOL? (2026-07-30) ───────────────────────────────
    // Liegt SOL unter dem Invest-Puffer, geht Dust nach SOL statt nach USDC.
    // Begründung: der Swap findet ohnehin statt, nur das Ziel-Mint ändert sich —
    // die Umleitung kostet also nichts. Bei SOL-Paar-Pools (PUMP/SOL, ORE/SOL …)
    // ist sie sogar billiger, weil TOKEN→SOL ein Hop ist und TOKEN→USDC über SOL
    // routet. Vor allem aber schließt sie eine Lücke: der Dust-Sweep erzeugte
    // bisher genau die USDC-Kleinbeträge, die der Topup wegen seiner
    // 0,5-USDC-Schwelle nie anfassen durfte — eine Automatik füllte einen Topf,
    // den die andere nicht leeren konnte.
    //
    // 🔒 Gedeckelt auf den tatsächlichen Fehlbetrag. Ohne Deckel würde ein großer
    // Dust-Posten (bis DUST_SWAP_MAX_USDC = 25 USDC) weit über SOL_TOPUP_TARGET
    // hinausschießen — und cleanup.js verkauft Überschuss über dem Sollstand im
    // nächsten Lauf wieder zurück. Das wäre exakt der Sollstand-Rundlauf, der am
    // 30.07.2026 behoben wurde (Commit da3c1247), nur über einen anderen Pfad.
    const solNowForDust = await getSolBalanceFresh(keypair.publicKey);
    const solPriceForDust = getTokenUsdPrice(WSOL_MINT, db) || 0;
    let solDeficitUsd = 0;
    if (solNowForDust < SOL_TOPUP_TRIGGER && solPriceForDust > 0) {
        solDeficitUsd = Math.max(0, (SOL_TOPUP_TARGET - solNowForDust) * solPriceForDust);
        console.log(`[cleanup:dust] SOL ${solNowForDust.toFixed(4)} < ${SOL_TOPUP_TRIGGER.toFixed(2)} – `
            + `Dust geht nach SOL, gedeckelt auf ${solDeficitUsd.toFixed(2)} USDC (Fehlbetrag bis ${SOL_TOPUP_TARGET} SOL).`);
    }

    /**
     * Entscheidet Ziel-Mint und Menge für einen Dust-Posten und führt den/die Swaps aus.
     * Drei Fälle, bewusst in dieser Reihenfolge:
     *   1. kein Fehlbetrag            → alles nach USDC (bisheriges Verhalten)
     *   2. Posten <= Fehlbetrag       → alles nach SOL, ein einziger Swap
     *   3. Posten > Fehlbetrag        → aufteilen: Fehlbetrag nach SOL, Rest nach USDC
     * In Fall 3 wird nur dann geteilt, wenn beide Teile die Dust-Untergrenze
     * erreichen — sonst entstünde ein Krümel, den der nächste Lauf erneut anfassen muss.
     */
    async function swapDustPortion(token, balance, usdcValue, note) {
        if (dryRun) {
            const target = solDeficitUsd > 0 ? 'SOL/USDC' : 'USDC';
            console.log(`[cleanup:dust] ${DRY}${token.symbol} ~${usdcValue.toFixed(2)} USDC würde → ${target} getauscht (${note}).`);
            solDeficitUsd = Math.max(0, solDeficitUsd - usdcValue);
            return;
        }
        if (solDeficitUsd <= 0) {
            await swapTo(token, balance, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, null, note);
            return;
        }
        if (usdcValue <= solDeficitUsd) {
            console.log(`[cleanup:dust] ${token.symbol} → SOL (deckt ${usdcValue.toFixed(2)} von ${solDeficitUsd.toFixed(2)} USDC Fehlbetrag).`);
            await swapTo(token, balance, WSOL_MINT, SOL_DECIMALS, 'SOL', keypair, connection, null, note);
            solDeficitUsd -= usdcValue;
            return;
        }
        const solPart  = balance * (solDeficitUsd / usdcValue);
        const restPart = balance - solPart;
        const restUsd  = usdcValue - solDeficitUsd;
        if (restUsd < DUST_SWAP_MIN_USDC) {
            console.log(`[cleanup:dust] ${t('cli.cl.dust_full_swap', { token: token.symbol, rest: restUsd.toFixed(4) })}`);
            await swapTo(token, balance, WSOL_MINT, SOL_DECIMALS, 'SOL', keypair, connection, null, note);
            solDeficitUsd = 0;
            return;
        }
        console.log(`[cleanup:dust] ${token.symbol} aufgeteilt: ${solDeficitUsd.toFixed(2)} USDC → SOL, ${restUsd.toFixed(2)} USDC → USDC.`);
        await swapTo(token, solPart, WSOL_MINT, SOL_DECIMALS, 'SOL', keypair, connection, null, note);
        solDeficitUsd = 0;
        await swapTo(token, restPart, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, null, note);
    }

    for (const token of relevantTokens) {
        if ((coarse.get(token.mint) ?? 0) <= 0) {
            clearWatch(token.mint);
            continue;
        }

        const balance = await getTokenBalanceFresh(keypair.publicKey, token.mint, token.decimals);
        if (balance <= 0) {
            clearWatch(token.mint);
            continue;
        }

        const price = getTokenUsdPrice(token.mint, db) || 0;
        if (price <= 0) continue; // Gegenwert unbekannt → nicht als Dust behandeln, Watch-Status unverändert lassen
        const usdcValue = balance * price;

        if (usdcValue < DUST_SWAP_MIN_USDC) {
            clearWatch(token.mint);
            console.log(`[cleanup:dust] ${t('cli.cl.dust_negligible', { token: token.symbol, usdc: usdcValue.toFixed(4), min: DUST_SWAP_MIN_USDC })}`);
            continue;
        }
        if (usdcValue >= DUST_SWAP_MAX_USDC) {
            const watch = getDustWatch(db, token.mint);
            const now = Date.now();
            if (!watch) {
                startWatch(token.mint, usdcValue);
                console.log(`[cleanup:dust] ${t('cli.cl.dust_not_dust', { token: token.symbol, usdc: usdcValue.toFixed(2), max: DUST_SWAP_MAX_USDC })}`);
                continue;
            }
            const elapsedHours = (now - watch.first_seen_at) / 3_600_000;
            if (elapsedHours < CLEANUP_STUCK_HOURS) {
                console.log(`[cleanup:dust] ${t('cli.cl.dust_stuck_wait', { token: token.symbol, usdc: usdcValue.toFixed(2), hours: elapsedHours.toFixed(1), limit: CLEANUP_STUCK_HOURS })}`);
                continue;
            }
            console.log(`[cleanup:dust] ${t('cli.cl.dust_stuck_swap', { token: token.symbol, usdc: usdcValue.toFixed(2), hours: elapsedHours.toFixed(1) })}`);
            if (!dryRun) {
                await notify.info('cleanup', t('cli.cl.dust_stuck_notice', { token: token.symbol, usdc: usdcValue.toFixed(2), hours: elapsedHours.toFixed(1) }));
            }
            await swapDustPortion(token, balance, usdcValue, 'stuck-dust');
            clearWatch(token.mint);
            continue;
        }

        clearWatch(token.mint);
        console.log(`[cleanup:dust] ${token.symbol} Dust ~${usdcValue.toFixed(2)} USDC – swap komplett.`);
        await swapDustPortion(token, balance, usdcValue, 'dust');
    }
}

// ─── Settings-Helfer ─────────────────────────────────────────────────────────

/**
 * Pools, die sich gerade in der Cooldown-Phase eines der drei Risk-Management-Exits
 * (Trailing Stop, TVL-Schutz, Score-Limit) befinden, bekommen keinen Cleanup-Invest —
 * sonst würde frisch befreites Kapital sofort wieder in denselben Pool investiert,
 * noch bevor der Nutzer eingreifen konnte. Vorher waren alle drei `cooldownHours`-Felder
 * reine UI-Werte ohne jede Wirkung im Bot (Befund 2026-08-08, zuerst bei Trailing
 * Stop gefunden, TVL/Score-Limit hatten dieselbe Lücke).
 *
 * Liefert eine Map poolId → { until, reason } für den jeweils spätesten aktiven
 * Cooldown (falls mehrere Exit-Typen für denselben Pool gleichzeitig im Cooldown
 * stehen sollten).
 */
function _loadCleanupCooldownBlockedPools(db) {
    // Berechnung selbst liegt in lib/invest-cooldown.js — dieselbe Quelle, aus der
    // bin/export.js `pool.investCooldowns` fürs Dashboard schreibt. Zwei Kopien dieser
    // Frist hätten zwangsläufig auseinanderlaufen können.
    return investCooldownBlockedPools(db, config.pools.all.map(p => p.id));
}

// ─── Invest-in-Pool Logik ─────────────────────────────────────────────────────

const USDC_TOKEN = { mint: USDC_MINT, decimals: USDC_DECIMALS, symbol: 'USDC' };
const SOL_TOKEN  = { mint: WSOL_MINT, decimals: SOL_DECIMALS,  symbol: 'SOL'  };

/**
 * Invest-in-Pool: alle Wallet-Reste (außer SOL-Reserve) in einen bestimmten Pool einzahlen.
 * Ersetzt die 3-2-1-Regel vollständig.
 */
async function runCleanupInvestPool(targetPoolId, db, keypair, connection) {
    const allPools   = config.pools.all;
    const targetPool = allPools.find(p => p.id === targetPoolId);

    if (!targetPool) {
        console.log(`[cleanup:invest] ${t('cli.cl.pool_not_found_skip', { pool: targetPoolId })}`);
        await notify.warn('cleanup:invest', new Error(`Ziel-Pool '${targetPoolId}' nicht konfiguriert`));
        return;
    }

    // Benutzer-Sperre: in gesperrte Pools (enabled=false) wird niemals investiert/reaktiviert.
    if (!isPoolEnabled(targetPool)) {
        console.log(`[cleanup:invest] ${t('cli.cl.pool_locked_skip', { pool: targetPool.pair })}`);
        return;
    }

    // 🔒 LIQ#0310: Läuft auf dem Ziel-Pool selbst gerade ein Exit, wird hier nicht
    // investiert. Die Exit-Module setzen den Pool zu Beginn auf active=false — ohne
    // diese Prüfung sähe der Block am Ende dieser Funktion `wasInactive === true` und
    // würde den Pool nach dem Invest reaktivieren, während er noch geräumt wird.
    // Der Cooldown weiter unten deckt das nicht ab: er greift erst nach einem
    // ABGESCHLOSSENEN Exit, nicht währenddessen.
    const reservationsForTarget = getExitReservations(db);
    if (!assertReservationsReadable(reservationsForTarget, '[cleanup:invest]')) {
        console.warn(`[cleanup:invest] ${targetPool.pair}: Exit-Zustand unbekannt – kein Invest.`);
        return;
    }
    const runningExit = reservationsForTarget.pools.get(targetPoolId);
    if (runningExit) {
        console.log(
            `[cleanup:invest] ${targetPool.pair}: Exit läuft `
            + `(${describeReservation(runningExit)}) – kein Invest.`,
        );
        return;
    }

    // 🔒 LIQ#0310, zweiter Teil: Gehört eines der beiden POOL-Token des Ziels zu einem
    // Exit auf einem ANDEREN Pool, wird ebenfalls nicht investiert — dann ist der ganze
    // Pool tabu, nicht nur ein Swap.
    //
    // Der Fremd-Token-Filter unten greift hier nämlich nicht: ein Pool-Token des Ziels
    // ist per Definition kein Fremd-Token und läuft gar nicht durch jene Schleife. Der
    // Deposit und der CLMM-Ratio-Pre-Swap fassen den Wallet-Bestand dieses Mints aber
    // sehr wohl an. Betroffen sind die sieben Mints, die in mehr als einem Pool liegen
    // (cbBTC in dreien; ZEC, HYPE, WBTC, JitoSOL, JLP, Fartcoin in je zweien): Läuft
    // etwa auf liq-zec-usdc ein Exit, während der Cleanup in liq-sol-zec investiert,
    // sind es physisch dieselben ZEC im Wallet.
    for (const mint of [targetPool.tokenA, targetPool.tokenB]) {
        const reserved = reservationsForTarget.mints.get(mint);
        if (!reserved) continue;
        console.log(
            `[cleanup:invest] ${targetPool.pair}: Pool-Token gehört zu einem laufenden Exit `
            + `(${describeReservation(reserved)}) – kein Invest.`,
        );
        return;
    }

    // Risk-Management-Cooldown: Der Modus CLEANUP_MODE='pool:<id>' umging ihn bis
    // 2026-08-08 vollständig — frisch per Trailing Stop / TVL-Schutz / Score-Limit
    // befreites Kapital konnte sofort zurück in denselben Pool fließen. Der
    // konfigurierte Cooldown ist bewusst eine harte Sperre und keine Empfehlung.
    const cooldown = _loadCleanupCooldownBlockedPools(db).get(targetPoolId);
    if (cooldown) {
        const remainingMin = Math.ceil((cooldown.until - Date.now()) / 60_000);
        console.log(`[cleanup:invest] ${targetPool.pair}: ${cooldown.reason}-Cooldown aktiv (noch ${remainingMin} Min) – kein Invest.`);
        return;
    }

    // Trend-Gate: Bewusst kein Ausweichen auf einen anderen Pool — bei einem fest
    // gewählten Ziel ist Nichtstun die einzig richtige Antwort (gleiche Entscheidung
    // wie beim Guard).
    if (CLEANUP_TREND_GATE.length) {
        // config.pools.all statt nur des Ziel-Pools: bei volatilePair-Pools braucht die
        // USD-Korb-Herleitung die Kursreihe des Quote-Pools (liq-sol-usdc & Co.).
        const gate = checkTrendGate(
            loadTrendStates(db, config.pools.all).get(targetPoolId), CLEANUP_TREND_GATE);
        if (!gate.ok) {
            console.log(`[cleanup:invest] ${t('cli.cl.guard_blocked', { pool: targetPool.pair, reason: gate.reason })}`);
            return;
        }
    }

    // Invest-Guard: der TVL-Schutz würde den Pool sofort wieder räumen.
    // Bewusst kein Ausweichen auf einen anderen Pool: bei einem fest gewählten Ziel ist
    // Nichtstun die einzig richtige Antwort.
    const elig = checkInvestEligibility(targetPool, db);
    if (!elig.ok) {
        console.log(`[cleanup:invest] ${t('cli.cl.guard_blocked', { pool: targetPool.pair, reason: elig.reason })}`);
        return;
    }

    // Range-Guard VOR den Swaps. Die Deposit-Pfade in lib/deposit-lib.js prüfen state.inRange
    // selbst, aber erst am Anfang der Einzahlung — also nachdem _invest*() das USDC bereits in
    // beide Pool-Tokens getauscht hat. Der Cleanup kaufte dann Tokens, konnte sie nicht
    // einzahlen, und die Dust-Phase tauschte sie direkt wieder zurück: ein Hin-und-Rück-Tausch,
    // der zweimal Spread plus TX-Gebühren kostet und nie etwas bringen kann.
    // Belegt am 2026-08-13 auf forge-pub1 (SOL/PUMP, 18:05): 14,60 USDC → 5.038 PUMP →
    // "out-of-range – skip" → 5.040 PUMP → 14,61 USDC.
    // Eine out-of-range-Position rebalanciert der Bot ohnehin binnen Minuten selbst; der nächste
    // stündliche Cleanup findet sie dann in Range vor. Warten kostet nichts.
    const openPosForRange = getOpenPosition(db, targetPoolId);
    if (openPosForRange) {
        try {
            const rangeState = await getAdapter(targetPool).getPositionState(targetPool, openPosForRange.nft_mint);
            if (!rangeState.inRange) {
                console.log(`[cleanup:invest] ${targetPool.pair}: Position out-of-range – kein Invest (Swaps übersprungen, nächster Lauf versucht es erneut).`);
                return;
            }
        } catch (err) {
            // Ohne verlässlichen State würde die Einzahlung unten ohnehin abbrechen — dann aber
            // erst nach den Swaps. Hier abbrechen ist die günstigere Variante.
            console.warn(`[cleanup:invest] ${targetPool.pair}: Position-State nicht abrufbar (${err.message}) – kein Invest.`);
            return;
        }
    }

    const wasInactive = !targetPool.active;
    console.log(`[cleanup:invest] ${t('cli.cl.target_pool', { pool: targetPool.pair })}${wasInactive ? ` (${t('cli.cl.inactive_reactivate')})` : ''} (${t('cli.cl.no_cap')})`);

    if (targetPool.volatilePair) {
        await _investVolatilePair(targetPool, db, keypair, connection);
    } else {
        await _investStandard(targetPool, db, keypair, connection);
    }

    // Pool reaktivieren wenn er vorher inaktiv war
    if (wasInactive) {
        try {
            if (getOpenPosition(db, targetPoolId)) {
                // Bestehende Position vorhanden → sofort aktivieren (Normalfall)
                setPoolActive(targetPoolId, true);
                console.log(`[cleanup:invest] ${t('cli.liq.pool_activated', { pool: targetPool.pair })}`);
                // NICHT `t` nennen — das würde die importierte i18n-Funktion t() im selben Block
                // beschatten und den console.log oben in einen TDZ-Fehler laufen lassen
                // ("Cannot access 't' before initialization"). Genau das ist am 2026-08-13 bei
                // SOL/ZEC passiert: der catch unten meldete irreführend "setPoolActive
                // fehlgeschlagen", übersprungen wurden in Wahrheit die drei Zeilen hier drunter.
                const tvlNow = db.prepare(`SELECT tvl_usd FROM pool_stats WHERE pool_id=? AND tvl_usd>0 ORDER BY recorded_at DESC LIMIT 1`).get(targetPoolId)?.tvl_usd ?? 0;
                ensureTvlProtectionDefaults(targetPoolId, tvlNow, { warn: targetPool.tvlWarnThreshold, exit: targetPool.tvlExitThreshold });
                ensureTrailingStopMinimumReset(targetPoolId);
            } else {
                // Keine offene Position, aber USDC im Wallet → Pool aktivieren damit Bot öffnet.
                // depositStandard/-lib setzt nur increaseLiquidity, kann keine neue Position öffnen.
                // Der Bot-Loop erkennt active=true + keine Position und öffnet sie im nächsten Zyklus.
                //
                // Schwelle: gleiche 30%-Kapital-Schwelle wie bot.js _preFlightOpenGuard – verhindert
                // dass ein Pool mit Wallet-Dust reaktiviert wird, dessen letzte Position ein Vielfaches
                // davon groß war (sonst greift der Bot-Guard zwar VOR dem Open, aber active bleibt
                // bereits true und der Bot versucht jeden Zyklus erneut, vergeblich, zu öffnen).
                const lastPosForReact = db.prepare(
                    `SELECT capital_usdc FROM positions WHERE pool_id = ? ORDER BY opened_at DESC LIMIT 1`
                ).get(targetPoolId);
                // Ziel-Kapital gibt es nur, wenn der Pool schon einmal eine Position hatte
                // (capital_usdc) oder explizit ein capitalUSDC in pools.json konfiguriert ist.
                // Kein Fallback auf einen erfundenen Wert mehr (früher: `?? 1000`) – das erzeugte
                // bei nie zuvor bespielten Pools (z.B. frisch nach Neuinstallation) eine
                // künstliche 30-%-Schranke gegen ein Phantom-Ziel, die reales Wallet-Guthaben
                // blockierte, obwohl genug USDC vorhanden war (pub1, 2026-08-25: cbBTC/USDC und
                // SOL/USDC hatten nie eine Position, Fallback verlangte 300 USDC statt der
                // eigentlich konfigurierten CLEANUP_MIN_DEPOSIT-Schwelle).
                const configuredTarget = targetPool.capitalUSDC > 0 ? targetPool.capitalUSDC : null;
                const reactTargetUsdc  = lastPosForReact?.capital_usdc ?? configuredTarget;
                // Schwelle: relative 30-%-Schranke UND – falls konfiguriert – der absolute
                // CLEANUP_MIN_DEPOSIT-Floor. Der Floor schützt davor, dass ein korruptes/zu
                // kleines capital_usdc der Vorposition (z.B. nach fehlerhafter Withdraw-Buchung)
                // die relative Schranke auf Cent-Niveau drückt und so eine Mini-Reaktivierung
                // durchwinkt. Beide müssen erfüllt sein → größeres Limit gewinnt. Ohne Ziel
                // (reactTargetUsdc === null, siehe oben) gilt nur noch der reale Floor.
                const minReactivateUsd = reactTargetUsdc != null
                    ? Math.max(MIN_USDC_AMOUNT, reactTargetUsdc * 0.30, CLEANUP_MIN_DEPOSIT)
                    : Math.max(MIN_USDC_AMOUNT, CLEANUP_MIN_DEPOSIT);
                const walletUsdc = await getUsableUsdcBalanceFresh(keypair.publicKey);
                if (walletUsdc >= minReactivateUsd) {
                    setPoolActive(targetPoolId, true);
                    console.log(`[cleanup:invest] ${t('cli.cl.reactivated_ready', { pool: targetPool.pair, usdc: walletUsdc.toFixed(2) })}`);
                    // Nicht `t` nennen — siehe Kommentar im if-Zweig oben (i18n-Shadowing).
                    const tvlNow = db.prepare(`SELECT tvl_usd FROM pool_stats WHERE pool_id=? AND tvl_usd>0 ORDER BY recorded_at DESC LIMIT 1`).get(targetPoolId)?.tvl_usd ?? 0;
                    ensureTvlProtectionDefaults(targetPoolId, tvlNow, { warn: targetPool.tvlWarnThreshold, exit: targetPool.tvlExitThreshold });
                    ensureTrailingStopMinimumReset(targetPoolId);
                } else {
                    const floorNote = CLEANUP_MIN_DEPOSIT > 0 ? `, Min-Floor ${CLEANUP_MIN_DEPOSIT}` : '';
                    if (reactTargetUsdc != null) {
                        console.log(`[cleanup:invest] ${t('cli.cl.not_reactivated', { pool: targetPool.pair, have: walletUsdc.toFixed(2), min: minReactivateUsd.toFixed(2), target: reactTargetUsdc.toFixed(2), floorNote })}`);
                    } else {
                        console.log(`[cleanup:invest] ${t('cli.cl.not_reactivated_no_target', { pool: targetPool.pair, have: walletUsdc.toFixed(2), min: minReactivateUsd.toFixed(2), floorNote })}`);
                    }
                }
            }
        } catch (err) {
            // Der Block umfasst Reaktivierung UND das Nachziehen der Risk-Management-Defaults.
            // Die Meldung darf deshalb nicht auf setPoolActive zeigen — sie hat am 2026-08-13
            // die eigentliche Ursache (i18n-Shadowing) über Stunden verdeckt.
            console.error(`[cleanup:invest] Reaktivierung/Risk-Defaults für ${targetPoolId} fehlgeschlagen: ${err.message}`);
        }
    }
}

/**
 * Standard-Pool (SOL/USDC, cbBTC/USDC, EURC/USDC): alle Fremd-Tokens → USDC, dann depositStandard.
 */
async function _investStandard(targetPool, db, keypair, connection) {
    const allPools = config.pools.all;
    // Max-Investment-Restkapazität (Nutzer-Risikogrenze) — deckelt jeden Pre-Swap UND
    // den finalen Deposit, sonst blieben pre-geswappte Pool-Token als Rest im Wallet
    // liegen (gleiche Fallklasse wie das ORCA-Vorkommnis oben, LIQ#0310).
    const remainingCapacity = remainingInvestCapacity(targetPool, db);

    // Fremd-Tokens (nicht USDC, nicht tokenA, nicht tokenB des Ziel-Pools) → USDC swappen.
    // tokenB explizit ausschließen: bei usdcIsTokenA-Pools (EURC/USDC) ist tokenB (EURC)
    // kein Fremd-Token – es wird für den Deposit benötigt.
    //
    // 🔒 LIQ#0310: Token eines laufenden Exits sind hier ausgenommen. Genau an dieser
    // Stelle ging Position 336 verloren — die 811,68 ORCA eines Exits mit gescheitertem
    // closePosition wurden als beliebiger Wallet-Rest zu USDC geswappt und dem Ziel-Pool
    // zugerechnet. Die bestehende Sperre in deposit-lib.js greift dagegen nicht: sie
    // prüft den Ziel-Pool (hier liq-pump-sol), nicht den Pool mit den gestrandeten Token
    // (liq-orca-sol) — und sie greift erst im Deposit, also nach diesem Swap.
    // LIQ#0355: Token eines anderen aktiven Pools, der gerade selbst Kapital für eine
    // Wiedereröffnung aufbaut, sind hier ebenfalls kein "Fremd-Token" — sonst nimmt
    // dieser Invest-Pfad genau das Pre-Swap-Kapital weg, das der eigene Bot des Tokens
    // im nächsten Zyklus braucht (siehe Begründung an loadAccumulatingPoolMints()).
    const accumulatingMintsStd = loadAccumulatingPoolMints(db);
    const foreignTokens = withoutReservedTokens(
        getRelevantTokens(allPools).filter(t =>
            t.mint !== USDC_MINT && t.mint !== targetPool.tokenA && t.mint !== targetPool.tokenB
            && !accumulatingMintsStd.has(t.mint)
        ),
        loadReservedMints(db, '[cleanup:invest]'),
        '[cleanup:invest]',
    );
    const allBalancesStd = await getAllTokenBalances(keypair.publicKey);
    for (const token of foreignTokens) {
        const bal = allBalancesStd.get(token.mint) ?? 0;
        if (bal <= 0) continue;
        const tokenPrice = getTokenUsdPrice(token.mint, db) || 0;
        const usdEst     = bal * tokenPrice;
        if (tokenPrice === 0) {
            // Kein DB-Preispfad vorhanden (z.B. Token nur in nicht-USDC-Pool wie JTO/JitoSOL).
            // Jupiter wird den echten Preis bestimmen – Dust-Check überspringen.
            console.log(`[cleanup:invest] ${t('cli.cl.price_unknown_swap', { token: token.symbol, balance: bal.toFixed(6) })}`);
            await swapTo(token, bal, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, targetPool.id);
            continue;
        }
        if (usdEst < MIN_SWAP_USDC) {
            console.log(`[cleanup:invest] ${token.symbol} ${bal.toFixed(6)} (~${usdEst.toFixed(4)} USDC) – Dust (< ${MIN_SWAP_USDC} USDC), skip.`);
            continue;
        }
        await swapTo(token, bal, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, targetPool.id);
    }

    // SOL-Surplus → USDC (nur wenn Ziel-Pool gar kein SOL als Pool-Token hat).
    // SOL-Surplus-Logik: Überschuss-SOL über dem Sollstand (SOL_TOPUP_TARGET)
    // wird in USDC umgewandelt damit der Cleanup das Kapital tatsächlich investieren
    // kann. Ohne diesen Block bleibt SOL im Wallet liegen (z.B. nach Withdraw aus
    // einem SOL-Pool).
    //
    // Abbau exakt AUF SOL_TOPUP_TARGET (2026-07-30): vorher wurde bis auf
    // solReserve+SOL_TX_FEE_BUFFER (~0,115) abgebaut, während das Topup auf 0,26
    // zielte — beide Richtungen arbeiteten gegeneinander, das Wallet pendelte und
    // löste in jedem Tal einen „SOL-Reserve niedrig"-Alert aus. Siehe
    // SOL_TOPUP_TARGET in lib/sol-topup.js.
    if (targetPool.tokenA !== WSOL_MINT && targetPool.tokenB !== WSOL_MINT) {
        const rawSol = await getSolBalanceFresh(keypair.publicKey);
        if (rawSol > SOL_TOPUP_TARGET) {
            const solSurplus    = Math.max(0, rawSol - SOL_TOPUP_TARGET);
            const solPriceFresh = getTokenUsdPrice(WSOL_MINT, db) || 0;
            const solSurplusUsd = solSurplus * solPriceFresh;
            if (solSurplusUsd >= MIN_USDC_AMOUNT) {
                console.log(`[cleanup:invest] SOL-Surplus ${solSurplus.toFixed(4)} (~${solSurplusUsd.toFixed(2)} USDC) → USDC`);
                await swapTo(SOL_TOKEN, solSurplus, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, targetPool.id);
            } else if (solSurplus > 0) {
                console.log(`[cleanup:invest] ${t('cli.cl.sol_surplus_small', { usdc: solSurplusUsd.toFixed(2), min: MIN_USDC_AMOUNT })}`);
            }
        }
    }

    // SOL/USDC-Pool: Token-Verhältnis vor Deposit anpassen (bidirektional, nur wenn in Range).
    // Orca braucht beide Token direkt im Wallet – kein interner Pre-Swap.
    // Fall A (SOL-Surplus): SOL → USDC
    // Fall B (USDC-Surplus, SOL-Engpass): USDC → SOL  ← war bisher nicht implementiert
    if (targetPool.tokenA === WSOL_MINT) {
        const solPrice = getTokenUsdPrice(WSOL_MINT, db) || 0;
        if (solPrice > 0) {
            const usableSol  = Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey) - SOL_TX_FEE_BUFFER);
            const walletUsdc = await getUsableUsdcBalanceFresh(keypair.publicKey);
            const totalUsdc  = usableSol * solPrice + walletUsdc;

            if (totalUsdc >= MIN_USDC_AMOUNT * 2) {
                const position = getOpenPosition(db, targetPool.id);
                // Nur wenn Position in Range – bei OOR keinen unnötigen Swap auslösen
                if (position?.price_lower && position?.price_upper
                        && solPrice >= position.price_lower && solPrice <= position.price_upper) {
                    const ratio         = checkClmmRatio(solPrice, position.price_lower, position.price_upper);
                    const targetSolUsdc = totalUsdc * (ratio.pctA / 100);
                    const delta         = targetSolUsdc - usableSol * solPrice; // positiv = SOL fehlt

                    if (delta > MIN_USDC_AMOUNT) {
                        // Fall B: USDC→SOL (SOL-Seite auffüllen)
                        // Auf die Max-Investment-Restkapazität gedeckelt: sonst swappt dieser
                        // Ratio-Pre-Swap mehr USDC in SOL, als Schritt 5 (depositStandard)
                        // einzahlen darf — der Rest bliebe als Fremdwährung (Kursrisiko) im
                        // Wallet liegen. (Der frühere CLEANUP_MAX_DEPOSIT-Deckel galt nur für
                        // den entfallenen Modus 'ranking', LIQ#000929.)
                        const swapCap    = remainingCapacity;
                        const usdcToSwap = Math.min(delta * 1.01, walletUsdc * 0.995, swapCap);
                        console.log(`[cleanup:invest] ${targetPool.pair}: ${usdcToSwap.toFixed(2)} USDC → SOL (CLMM-Ratio ${ratio.pctA}/${ratio.pctB})`);
                        await swapTo(USDC_TOKEN, usdcToSwap, WSOL_MINT, SOL_DECIMALS, 'SOL', keypair, connection, targetPool.id);
                    } else if (-delta > MIN_USDC_AMOUNT) {
                        // Fall A: SOL→USDC (USDC-Seite auffüllen)
                        const solToSwap = (-delta) / solPrice;
                        console.log(`[cleanup:invest] ${targetPool.pair}: ${solToSwap.toFixed(4)} SOL → USDC (CLMM-Ratio ${ratio.pctA}/${ratio.pctB})`);
                        await swapTo(SOL_TOKEN, solToSwap, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, targetPool.id);
                    }
                }
            }
        }
    }

    // Token X/USDC-Pools (X != SOL, X != USDC): Token-Verhältnis vor Deposit anpassen.
    // Symmetrisch zum SOL/USDC-Block: ohne diesen Pre-Swap bekommt depositStandard
    // zwar USDC, aber kein tokenA – und das increaseLiquidity läuft auf Krümel-Mengen.
    if (targetPool.tokenA !== WSOL_MINT && !targetPool.usdcIsTokenA) {
        try {
            const stats         = await getAdapter(targetPool).getPoolStats(targetPool);
            const tokenAPrice   = stats.price;   // USDC pro 1 tokenA
            const tokenASym     = targetPool.pair.split('/')[0];
            const tokenADef     = { mint: targetPool.tokenA, decimals: targetPool.decimalsA, symbol: tokenASym };
            const walletAFresh  = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(targetPool.tokenA), targetPool.decimalsA);
            const walletUsdcCur = await getUsableUsdcBalanceFresh(keypair.publicKey);
            const walletAUsd    = walletAFresh * tokenAPrice;
            const totalUsdc     = walletAUsd + walletUsdcCur;

            if (tokenAPrice > 0 && totalUsdc >= MIN_USDC_AMOUNT * 2) {
                const position = getOpenPosition(db, targetPool.id);
                if (position?.price_lower && position?.price_upper
                        && tokenAPrice >= position.price_lower && tokenAPrice <= position.price_upper) {
                    const ratio       = checkClmmRatio(tokenAPrice, position.price_lower, position.price_upper);
                    const targetAUsdc = totalUsdc * (ratio.pctA / 100);
                    const delta       = targetAUsdc - walletAUsd; // positiv = tokenA fehlt

                    if (delta > MIN_USDC_AMOUNT) {
                        // USDC → tokenA (tokenA-Seite auffüllen)
                        // Auf die Max-Investment-Restkapazität gedeckelt (analog zum SOL/USDC-
                        // Block oben) — sonst swappt dieser Ratio-Pre-Swap mehr USDC in tokenA,
                        // als Schritt 5 (depositStandard) später überhaupt einzahlen darf.
                        const swapCap    = remainingCapacity;
                        const usdcToSwap = Math.min(delta * 1.01, walletUsdcCur * 0.995, swapCap);
                        console.log(`[cleanup:invest] ${targetPool.pair}: ${usdcToSwap.toFixed(2)} USDC → ${tokenASym} (CLMM-Ratio ${ratio.pctA}/${ratio.pctB})`);
                        await swapTo(USDC_TOKEN, usdcToSwap, targetPool.tokenA, targetPool.decimalsA, tokenASym, keypair, connection, targetPool.id);
                    } else if (-delta > MIN_USDC_AMOUNT) {
                        // tokenA → USDC (USDC-Seite auffüllen)
                        const tokenAToSwap = (-delta) / tokenAPrice;
                        console.log(`[cleanup:invest] ${targetPool.pair}: ${tokenAToSwap.toFixed(6)} ${tokenASym} → USDC (CLMM-Ratio ${ratio.pctA}/${ratio.pctB})`);
                        await swapTo(tokenADef, tokenAToSwap, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, targetPool.id);
                    }
                }
            }
        } catch (err) {
            console.warn(`[cleanup:invest] ${targetPool.pair}: Token-Pre-Swap fehlgeschlagen: ${err.message}`);
        }
    }

    let walletUsdc = await getUsableUsdcBalanceFresh(keypair.publicKey);

    // Zu wenig USDC für einen sinnvollen Deposit, aber Pool-Token im Wallet: Teil des
    // Tokens → USDC swappen, damit Deposit möglich ist. Gilt für nicht-SOL, nicht-BTC
    // Pools (z.B. ZEC/USDC, EURC/USDC).
    //
    // Schwelle bewusst Math.max(MIN_USDC_AMOUNT, CLEANUP_MIN_DEPOSIT) statt nur
    // MIN_USDC_AMOUNT (1 USDC): Vorher griff der Pre-Swap nur bei praktisch null
    // freiem USDC. Lag bereits ein kleiner Rest (z.B. 3,69 USDC) im Wallet – unter
    // CLEANUP_MIN_DEPOSIT (10), aber über MIN_USDC_AMOUNT –, wurde der Pre-Swap
    // komplett übersprungen UND der eigentliche Deposit weiter unten (Zeile ~895)
    // wegen des Minimums verworfen. Ergebnis: Deadlock, der Pool-Token blieb dauerhaft
    // ungeswappt im Wallet liegen, obwohl sein Gegenwert für einen Deposit gereicht
    // hätte (Vorfall 2026-08-08, Pool liq-spcx-usdc, ~95 USDC in SPCX gestrandet).
    const usdcInvestFloor = Math.max(MIN_USDC_AMOUNT, CLEANUP_MIN_DEPOSIT);
    if (walletUsdc < usdcInvestFloor && targetPool.tokenA !== WSOL_MINT) {
        const nonUsdcMint = targetPool.usdcIsTokenA ? targetPool.tokenB : targetPool.tokenA;
        const nonUsdcDec  = targetPool.usdcIsTokenA ? targetPool.decimalsB : targetPool.decimalsA;
        const nonUsdcSym  = targetPool.pair.split('/')[targetPool.usdcIsTokenA ? 1 : 0];
        const nonUsdcBal  = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(nonUsdcMint), nonUsdcDec);

        if (nonUsdcBal > 0) {
            try {
                const stats    = await getAdapter(targetPool).getPoolStats(targetPool);
                const tokenPrice = stats.price; // USDC-Wert pro 1 Token
                const totalUsdc  = nonUsdcBal * tokenPrice;

                if (totalUsdc >= MIN_USDC_AMOUNT * 2) {
                    // CLMM-Ratio bestimmen (USDC-Anteil) – mit Position wenn vorhanden, sonst 50 %
                    const position = getOpenPosition(db, targetPool.id);
                    let usdcPct = 50;
                    if (position?.price_lower && position?.price_upper) {
                        const ratio = checkClmmRatio(tokenPrice, position.price_lower, position.price_upper);
                        usdcPct = targetPool.usdcIsTokenA ? ratio.pctA : ratio.pctB;
                    }
                    const usdcNeeded  = totalUsdc * (usdcPct / 100);
                    const swapAmount  = usdcNeeded / tokenPrice;
                    console.log(`[cleanup:invest] ${targetPool.pair}: ${t('cli.cl.no_usdc_swap', { amount: swapAmount.toFixed(6), token: nonUsdcSym, usdc: usdcNeeded.toFixed(2) })}`);
                    await swapTo(
                        { mint: nonUsdcMint, decimals: nonUsdcDec, symbol: nonUsdcSym },
                        swapAmount, USDC_MINT, USDC_DECIMALS, 'USDC',
                        keypair, connection, targetPool.id,
                    );
                    walletUsdc = await getUsableUsdcBalanceFresh(keypair.publicKey);
                } else {
                    console.log(`[cleanup:invest] ${targetPool.pair}: ${t('cli.cl.token_rest_small', { usdc: totalUsdc.toFixed(4) })}`);
                }
            } catch (err) {
                console.warn(`[cleanup:invest] ${targetPool.pair}: Pre-Swap fehlgeschlagen: ${err.message}`);
            }
        }
    }

    if (walletUsdc < MIN_USDC_AMOUNT) {
        console.log(`[cleanup:invest] ${targetPool.pair}: USDC zu gering (${walletUsdc.toFixed(4)}) – skip.`);
        return;
    }
    const depositUsdc = Math.min(walletUsdc, remainingCapacity);
    if (depositUsdc < walletUsdc) {
        const reason = `Max Investment, Rest ${remainingCapacity.toFixed(2)} USDC`;
        console.log(`[cleanup:invest] Max-Einzahlung aktiv: ${depositUsdc.toFixed(2)} USDC von ${walletUsdc.toFixed(2)} USDC (${reason})`);
    }
    await deposit(targetPool, depositUsdc, keypair, db, getAdapter(targetPool), { note: 'cleanup' });
}

/**
 * volatilePair-Pool (z.B. HYPE/SOL): zwei volatile Tokens ohne USDC-Seite.
 * Quote-Token (z.B. SOL) liefert via quotePricePoolId den USD-Anker.
 *
 * Flow:
 *  1. Fremd-Tokens → USDC (Pool-Tokens und Quote-Token sind ausgeschlossen)
 *  2. Pool-Preis + Quote-Preis lesen
 *  3. SOL-Surplus → USDC NUR wenn SOL kein Pool-Token ist
 *  4. Wallet-USD-Werte berechnen mit usdPerToken{A,B} (quote-aware)
 *  5. Defizite (50/50-Ziel) berechnen, USDC proportional verteilen
 *  6. Cross-Swap zwischen Pool-Tokens als letzte Korrektur
 *  7. depositVolatilePair
 */
async function _investVolatilePair(targetPool, db, keypair, connection) {
    const allPools     = config.pools.all;
    // Siehe Begründung in _investStandard().
    const remainingCapacity = remainingInvestCapacity(targetPool, db);
    const tokenASymbol = targetPool.pair.split('/')[0];
    const tokenBSymbol = targetPool.pair.split('/')[1];
    const tokenADef    = { mint: targetPool.tokenA, decimals: targetPool.decimalsA, symbol: tokenASymbol };
    const tokenBDef    = { mint: targetPool.tokenB, decimals: targetPool.decimalsB, symbol: tokenBSymbol };
    const solIsPoolToken = targetPool.tokenA === WSOL_MINT || targetPool.tokenB === WSOL_MINT;

    // ─── 1. Fremd-Tokens → USDC ────────────────────────────────────────────
    // 🔒 LIQ#0310: Token eines laufenden Exits bleiben unangetastet (siehe
    // ausführliche Begründung im gleichen Schritt in _investStandard()).
    // LIQ#0355: siehe Begründung in _investStandard() – Token eines anderen aktiv
    // akkumulierenden Pools zählen hier nicht als Fremd-Token.
    const accumulatingMintsVol = loadAccumulatingPoolMints(db);
    const foreignTokens = withoutReservedTokens(
        getRelevantTokens(allPools).filter(t =>
            t.mint !== targetPool.tokenA && t.mint !== targetPool.tokenB
            && !accumulatingMintsVol.has(t.mint)
        ),
        loadReservedMints(db, '[cleanup:invest]'),
        '[cleanup:invest]',
    );
    const allBalancesVol = await getAllTokenBalances(keypair.publicKey);
    for (const token of foreignTokens) {
        const bal = allBalancesVol.get(token.mint) ?? 0;
        if (bal <= 0) continue;
        const tokenPrice = getTokenUsdPrice(token.mint, db) || 0;
        const usdEst     = bal * tokenPrice;
        if (tokenPrice === 0) {
            console.log(`[cleanup:invest] ${t('cli.cl.price_unknown_swap', { token: token.symbol, balance: bal.toFixed(6) })}`);
            await swapTo(token, bal, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, targetPool.id);
            continue;
        }
        if (usdEst < MIN_SWAP_USDC) {
            console.log(`[cleanup:invest] ${token.symbol} ${bal.toFixed(6)} (~${usdEst.toFixed(4)} USDC) – Dust (< ${MIN_SWAP_USDC} USDC), skip.`);
            continue;
        }
        await swapTo(token, bal, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, targetPool.id);
    }

    // ─── 2. Frische Preise (Pool-Preis + Quote-USD) ────────────────────────
    let poolPrice = 0, quotePrice = 0;
    try {
        const poolStats = await getAdapter(targetPool).getPoolStats(targetPool);
        poolPrice = poolStats.price;
        quotePrice = getTokenUsdPrice(targetPool.quoteTokenMint, db);
        if (quotePrice <= 0) {
            console.error(`[cleanup:invest] ${t('cli.cl.no_quote_price', { mint: targetPool.quoteTokenMint })}`);
            return;
        }
    } catch (err) {
        console.error(`[cleanup:invest] ${t('cli.cl.fresh_prices_unreadable', { error: err.message })}`);
        await notify.warn('cleanup:invest prices', err);
        return;
    }
    if (poolPrice <= 0 || quotePrice <= 0) {
        console.error(`[cleanup:invest] ${t('cli.cl.prices_invalid', { pool: poolPrice, quote: quotePrice })}`);
        return;
    }

    const quoteIsTokenA = targetPool.quoteTokenMint === targetPool.tokenA;
    const usdPerTokenA  = quoteIsTokenA ? quotePrice : quotePrice * poolPrice;
    const usdPerTokenB  = quoteIsTokenA ? quotePrice / poolPrice : quotePrice;

    // ─── 2b. CLMM-Ratio bestimmen (aus offener Position oder berechnet) ───
    let clmmPctA = 50, clmmPctB = 50;
    try {
        const openPos = getOpenPosition(db, targetPool.id);
        let priceLower, priceUpper;
        if (openPos?.price_lower && openPos?.price_upper) {
            priceLower = openPos.price_lower;
            priceUpper = openPos.price_upper;
        } else {
            const effectiveRange = targetPool.rangeOverride
                ? { ...config.range, ...targetPool.rangeOverride }
                : config.range;
            const range = calculateRange(targetPool, poolPrice, effectiveRange, db);
            priceLower = range.priceLower;
            priceUpper = range.priceUpper;
        }
        const ratio = checkClmmRatio(poolPrice, priceLower, priceUpper);
        clmmPctA = ratio.pctA;
        clmmPctB = ratio.pctB;
        console.log(`[cleanup:invest] ${targetPool.pair}: CLMM-Ratio ${clmmPctA}%/${clmmPctB}% (${tokenASymbol}/${tokenBSymbol})`);
    } catch (err) {
        console.warn(`[cleanup:invest] ${targetPool.pair}: ${t('cli.cl.clmm_ratio_fallback', { error: err.message })}`);
    }

    // ─── 3. SOL-Surplus → USDC (nur wenn SOL kein Pool-Token ist) ─────────
    // Abbau exakt AUF SOL_TOPUP_TARGET — siehe Begründung im gleichartigen Block oben.
    if (!solIsPoolToken) {
        const rawSol = await getSolBalanceFresh(keypair.publicKey);
        if (rawSol > SOL_TOPUP_TARGET) {
            const solSurplus    = Math.max(0, rawSol - SOL_TOPUP_TARGET);
            const solSurplusUsd = solSurplus * quotePrice;  // Annahme: quote=SOL
            if (solSurplusUsd >= MIN_USDC_AMOUNT) {
                console.log(`[cleanup:invest] SOL-Surplus ${solSurplus.toFixed(4)} (~${solSurplusUsd.toFixed(2)} USDC) → USDC`);
                await swapTo(SOL_TOKEN, solSurplus, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, targetPool.id);
            }
        }
    }

    // ─── 4. Wallet-Stand & Gesamtwert ──────────────────────────────────────
    const walletUsdc = await getUsableUsdcBalanceFresh(keypair.publicKey);
    const walletA    = targetPool.tokenA === WSOL_MINT
        ? Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey) - SOL_TX_FEE_BUFFER)
        : await getTokenBalanceFresh(keypair.publicKey, targetPool.tokenA, targetPool.decimalsA);
    const walletB    = targetPool.tokenB === WSOL_MINT
        ? Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey) - SOL_TX_FEE_BUFFER)
        : await getTokenBalanceFresh(keypair.publicKey, targetPool.tokenB, targetPool.decimalsB);

    const walletAUsd = walletA * usdPerTokenA;
    const walletBUsd = walletB * usdPerTokenB;
    const totalUsd   = walletUsdc + walletAUsd + walletBUsd;

    console.log(`[cleanup:invest] ${tokenASymbol}: ${walletA.toFixed(6)} (~${walletAUsd.toFixed(2)} USDC) | ` +
                `${tokenBSymbol}: ${walletB.toFixed(6)} (~${walletBUsd.toFixed(2)} USDC) | ` +
                `USDC: ${walletUsdc.toFixed(2)} | total: ${totalUsd.toFixed(2)} USDC`);

    if (totalUsd < 2 * MIN_USDC_AMOUNT) {
        console.log(`[cleanup:invest] Gesamtwert ${totalUsd.toFixed(2)} USDC zu gering – skip.`);
        return;
    }

    // ─── 5. CLMM-Ratio-Ziel, Defizite, USDC proportional verteilen ────────
    const targetAUsd      = totalUsd * clmmPctA / 100;
    const targetBUsd      = totalUsd * clmmPctB / 100;
    const deficitAUsd     = Math.max(0, targetAUsd - walletAUsd);
    const deficitBUsd     = Math.max(0, targetBUsd - walletBUsd);
    const totalDeficitUsd = deficitAUsd + deficitBUsd;

    // Bruttoeinsatz dieser Befüllung: Pool-Token, die schon im Wallet liegen, plus das
    // USDC, das gleich in Pool-Token getauscht wird — alles bewertet VOR dem Umtausch.
    // Die Differenz zum später tatsächlich eingezahlten Kapital sind die Einstiegskosten
    // (Swap-Slippage, Gebühren, TX-Fees, liegen gebliebener Rest); siehe
    // recordEntryCost() in lib/deposit-lib.js. Nur ERFOLGREICHE Swaps zählen: bei einem
    // fehlgeschlagenen Swap bleibt das USDC im Wallet und ist kein Einsatz.
    let grossInvestUsd = walletAUsd + walletBUsd;

    if (walletUsdc >= MIN_USDC_AMOUNT && totalDeficitUsd > 0) {
        const cappedUsdc = Math.min(walletUsdc, remainingCapacity);
        if (cappedUsdc < walletUsdc) {
            const reason = `Max Investment, Rest ${remainingCapacity.toFixed(2)} USDC`;
            console.log(`[cleanup:invest] ${targetPool.pair}: Max-Einzahlung aktiv: USDC-Budget ${cappedUsdc.toFixed(2)} von ${walletUsdc.toFixed(2)} USDC (${reason})`);
        }
        const useUsdc  = Math.min(cappedUsdc, totalDeficitUsd);
        const usdcForA = useUsdc * (deficitAUsd / totalDeficitUsd);
        const usdcForB = useUsdc * (deficitBUsd / totalDeficitUsd);

        if (usdcForA >= MIN_USDC_AMOUNT) {
            console.log(`[cleanup:invest] ${usdcForA.toFixed(2)} USDC → ${tokenASymbol}`);
            if (await swapTo(USDC_TOKEN, usdcForA, targetPool.tokenA, targetPool.decimalsA, tokenASymbol, keypair, connection, targetPool.id)) {
                grossInvestUsd += usdcForA;
            }
        }
        if (usdcForB >= MIN_USDC_AMOUNT) {
            console.log(`[cleanup:invest] ${usdcForB.toFixed(2)} USDC → ${tokenBSymbol}`);
            if (await swapTo(USDC_TOKEN, usdcForB, targetPool.tokenB, targetPool.decimalsB, tokenBSymbol, keypair, connection, targetPool.id)) {
                grossInvestUsd += usdcForB;
            }
        }
    }

    // ─── 6. Cross-Swap zwischen Pool-Tokens (letzte Korrektur) ─────────────
    const walletAFinal = targetPool.tokenA === WSOL_MINT
        ? Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey) - SOL_TX_FEE_BUFFER)
        : await getTokenBalanceFresh(keypair.publicKey, targetPool.tokenA, targetPool.decimalsA);
    const walletBFinal = targetPool.tokenB === WSOL_MINT
        ? Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey) - SOL_TX_FEE_BUFFER)
        : await getTokenBalanceFresh(keypair.publicKey, targetPool.tokenB, targetPool.decimalsB);
    const walletAFinalUsd = walletAFinal * usdPerTokenA;
    const walletBFinalUsd = walletBFinal * usdPerTokenB;
    const totalFinalUsd   = walletAFinalUsd + walletBFinalUsd;
    const finalTargetAUsd = totalFinalUsd * clmmPctA / 100;
    const finalTargetBUsd = totalFinalUsd * clmmPctB / 100;
    const surplusAUsd     = walletAFinalUsd - finalTargetAUsd;
    const surplusBUsd     = walletBFinalUsd - finalTargetBUsd;

    if (surplusAUsd >= MIN_CROSS_SWAP_USDC && walletBFinalUsd < finalTargetBUsd) {
        let swapAmount = surplusAUsd / usdPerTokenA;
        if (targetPool.tokenA === WSOL_MINT) {
            // walletAFinal = raw SOL - (solReserve + SOL_TX_FEE_BUFFER) → rawSol rekonstruieren.
            // maxSwappable lässt (SOL_TOPUP_TRIGGER + SOL_TX_FEE_BUFFER) übrig: der Buffer
            // deckt die TX-Fee des Swaps selbst (priority fees können 0.002–0.005 SOL kosten).
            // Ohne diesen Abzug landet rawSol nach dem Swap unter der Reserve.
            const rawSol       = walletAFinal + config.solReserve + SOL_TX_FEE_BUFFER;
            const maxSwappable = Math.max(0, rawSol - SOL_TOPUP_TRIGGER - SOL_TX_FEE_BUFFER);
            swapAmount = Math.min(swapAmount, maxSwappable);
        }
        if (swapAmount * usdPerTokenA >= MIN_CROSS_SWAP_USDC) {
            console.log(`[cleanup:invest] Cross-swap ${swapAmount.toFixed(6)} ${tokenASymbol} → ${tokenBSymbol}`);
            await swapTo(tokenADef, swapAmount, targetPool.tokenB, targetPool.decimalsB, tokenBSymbol, keypair, connection, targetPool.id);
        } else {
            const rawSolDisp = walletAFinal + config.solReserve + SOL_TX_FEE_BUFFER;
            console.log(`[cleanup:invest] ${t('cli.cl.cross_swap_skipped', { from: tokenASymbol, to: tokenBSymbol, sol: rawSolDisp.toFixed(4), min: SOL_TOPUP_TRIGGER })}`);
        }
    } else if (surplusBUsd >= MIN_CROSS_SWAP_USDC && walletAFinalUsd < finalTargetAUsd) {
        let swapAmount = surplusBUsd / usdPerTokenB;
        if (targetPool.tokenB === WSOL_MINT) {
            const rawSol       = walletBFinal + config.solReserve + SOL_TX_FEE_BUFFER;
            const maxSwappable = Math.max(0, rawSol - SOL_TOPUP_TRIGGER - SOL_TX_FEE_BUFFER);
            swapAmount = Math.min(swapAmount, maxSwappable);
        }
        if (swapAmount * usdPerTokenB >= MIN_CROSS_SWAP_USDC) {
            console.log(`[cleanup:invest] Cross-swap ${swapAmount.toFixed(6)} ${tokenBSymbol} → ${tokenASymbol}`);
            await swapTo(tokenBDef, swapAmount, targetPool.tokenA, targetPool.decimalsA, tokenASymbol, keypair, connection, targetPool.id);
        }
    }

    // ─── 7. Deposit ────────────────────────────────────────────────────────
    const finalA = targetPool.tokenA === WSOL_MINT
        ? Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey) - SOL_TX_FEE_BUFFER)
        : await getTokenBalanceFresh(keypair.publicKey, targetPool.tokenA, targetPool.decimalsA);
    const finalB = targetPool.tokenB === WSOL_MINT
        ? Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey) - SOL_TX_FEE_BUFFER)
        : await getTokenBalanceFresh(keypair.publicKey, targetPool.tokenB, targetPool.decimalsB);
    const finalAUsd = finalA * usdPerTokenA;
    const finalBUsd = finalB * usdPerTokenB;
    if (finalAUsd < MIN_CROSS_SWAP_USDC || finalBUsd < MIN_CROSS_SWAP_USDC) {
        console.log(
            `[cleanup:invest] Token-Imbalance: ${tokenASymbol}=${finalAUsd.toFixed(2)} USDC, ` +
            `${tokenBSymbol}=${finalBUsd.toFixed(2)} USDC (Mindestwert pro Seite: ` +
            `${MIN_CROSS_SWAP_USDC} USDC) – Deposit übersprungen, Tokens verbleiben im Wallet.`
        );
        return;
    }
    await deposit(targetPool, null, keypair, db, getAdapter(targetPool), { note: 'cleanup volatilePair', quotePrice, grossInvestUsd });
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

const db         = openDatabase();
// Probelauf: kein syncPools — das schreibt die pools-Tabelle. openDatabase() selbst legt
// nur fehlendes Schema an (idempotent, macht der Bot bei jedem Start ebenso).
if (!DRY_RUN) syncPools(db, config.pools.all);
const keypair    = getKeypair();
const connection = getConnection();

const SOL_MIN_FLOOR     = 0.01; // Absolutes Minimum – unter diesem Wert auch Cleanup nicht sicher
// Auslöseschwelle für das Auffüllen — seit 2026-07-30 der zentrale Invest-Puffer
// (Reserve + 0,05) statt der festen 0,11. Die Konstante schützt hier doppelt: sie
// löst das Topup am Laufanfang aus UND begrenzt weiter unten die Cross-Swaps
// (maxSwappable), damit ein Swap das Wallet nicht unter den Puffer drückt.
// Ziel-Wert kommt zentral aus lib/sol-topup.js (eine Quelle für alle Topup-Pfade).
const SOL_TOPUP_TRIGGER = INVEST_SOL_COMFORT;

// 🔒 releaseLock() löscht die Lock-Datei ohne Besitzprüfung. Der Probelauf nimmt keinen
// Lock und darf deshalb auch keinen fremden (Cron-Lauf, manueller Deposit) entfernen.
const releaseOwnLock = () => { if (!DRY_RUN) releaseLock(); };

// Lock sicherstellen: auch bei SIGTERM und ungefangenen Exceptions
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { releaseOwnLock(); process.exit(0); });
// Ein ungefangener Fehler kann den Lauf MITTEN in einer Kapitalbewegung beenden —
// die Transaktion ist dann on-chain, die Buchung fehlt (Vorfall 2026-08-15, 131,65 USDC
// Phantomgewinn). Das darf nicht stumm passieren. Der Abgleich beim nächsten Lauf
// (lib/capital-reconcile.js) repariert die Buchung; diese Meldung sagt, dass es nötig war.
// Der Exit-Code MUSS 1 bleiben — der Cron-Wrapper wertet ihn aus. Deshalb sofort
// process.exitCode setzen und erst danach die Meldung rausschicken: der offene
// fetch hält den Event-Loop am Leben, bis er durch ist, der Timer ist nur die
// Notbremse, falls Nexus hängt.
process.on('uncaughtException', (err) => {
    releaseOwnLock();
    console.error('[cleanup] uncaughtException:', err.message);
    process.exitCode = 1;
    if (DRY_RUN) { process.exit(1); return; }
    const done = () => process.exit(1);
    notify.errorRaw(
        'Cleanup abgebrochen',
        `Der Cleanup-Lauf ist unerwartet gestorben: ${err.message}\n` +
        `Falls dabei gerade Kapital bewegt wurde, trägt der Abgleich beim nächsten Lauf die ` +
        `fehlende Buchung nach und meldet das gesondert.`,
    ).then(done, done);
    setTimeout(done, 5000).unref();
});

// SL-Flow hat Vorrang: wenn Stop-Loss gerade ausgeführt wird, diesen Lauf überspringen
if (isSlLocked()) {
    console.log(`[cleanup] ${t('cli.cl.sl_running')}`);
    console.log(JSON.stringify({ ok: false, error: t('cli.cl.sl_running_short'), log: [], result: {} }));
    process.exit(0);
}

// Manuelle Aktion (deposit/withdraw via UI) hat Vorrang
if (isManualLocked()) {
    console.log(`[cleanup] ${t('cli.cl.manual_running')}`);
    console.log(JSON.stringify({ ok: false, error: t('cli.cl.manual_running_short'), log: [], result: {} }));
    process.exit(0);
}

// Rebalancing hat Vorrang
if (isRebalanceLocked()) {
    console.log(`[cleanup] ${t('cli.cl.rebalance_running')}`);
    console.log(JSON.stringify({ ok: false, error: t('cli.cl.rebalance_running_short'), log: [], result: {} }));
    process.exit(0);
}

// Probelauf ohne Lock: er bewegt nichts, ein gehaltener Lock würde aber einen echten
// Lauf (Cron, manueller Deposit) blockieren.
if (!DRY_RUN) acquireLock();

/**
 * Hinweis auf den entfallenen Modus „Bester Pool" (LIQ#000929) — genau einmal je
 * Installation. Zwei Auslöser:
 *   - Migration 0012 hat CLEANUP_MODE umgestellt und CLEANUP_NOTICE_RANKING_REMOVED=1
 *     gesetzt. Sie läuft beim Update VOR dem Dienststart, Nexus ist dann nicht
 *     erreichbar — deshalb meldet erst dieser Lauf.
 *   - CLEANUP_MODE steht (ohne Migration, z.B. von Hand gesetzt) noch auf 'ranking' oder
 *     einem unbekannten Wert: wie 'disabled' behandeln und die .env gleich auf 'disabled'
 *     korrigieren, damit die Meldung nicht stündlich wiederkommt.
 */
async function noticeRankingRemoved() {
    const legacy = CLEANUP_MODE_RESOLVED.legacy;
    const pendingNotice = process.env.CLEANUP_NOTICE_RANKING_REMOVED === '1';
    if (legacy) {
        const mode = CLEANUP_MODE_RESOLVED.raw;
        console.log(`[cleanup] ${legacy === 'ranking' ? t('cli.cl.legacy_mode', { mode }) : t('cli.cl.unknown_mode', { mode })}`);
    }
    if (!legacy && !pendingNotice) return;
    // Nur melden, wenn es einen Ranking-Bezug gibt — ein Tippfehler im Modus ist kein
    // Anlass für den Hinweis auf „Bester Pool", wird aber genauso auf disabled gesetzt.
    const sendNotice = legacy === 'ranking' || pendingNotice;
    if (DRY_RUN) {
        const parts = [];
        if (sendNotice) parts.push('Hinweis „Bester Pool entfällt" würde gesendet');
        if (legacy) parts.push('CLEANUP_MODE würde in der .env auf disabled gesetzt');
        if (pendingNotice) parts.push('CLEANUP_NOTICE_RANKING_REMOVED würde entfernt');
        console.log(`[cleanup] ${DRY}${parts.join(', ')}.`);
        return;
    }
    if (sendNotice) {
        await notify.info('cleanup', t('cli.cl.ranking_removed_notice'));
    }
    try {
        if (legacy) setCleanupModeInEnv('disabled');
        if (pendingNotice) removeKeysFromEnv(['CLEANUP_NOTICE_RANKING_REMOVED']);
    } catch (err) {
        console.warn(`[cleanup] .env-Korrektur nach Hinweis fehlgeschlagen: ${err.message}`);
    }
}

try {
    console.log(`[cleanup] Start${DRY_RUN ? ' (Probelauf, --dry-run)' : ''}:`, new Date().toISOString());
    console.log(`[cleanup] ${t('cli.cl.mode_active', { mode: CLEANUP_MODE })}`);
    await noticeRankingRemoved();

    // Kapitalflüsse gegen die Chain abgleichen, BEVOR irgendetwas entschieden oder
    // bewegt wird: eine nicht gebuchte Einzahlung verfälscht capital_usdc und damit
    // die Kapital-Guards, die weiter unten über Investitionen entscheiden.
    // Ein Fehler hier darf den Cleanup nicht aufhalten — der Abgleich ist eine
    // Korrektur, kein Tor.
    try {
        const res = await reconcileCapitalFlows(db, {
            poolsById:  new Map(config.pools.all.map(p => [p.id, p])),
            connection,
            dryRun:     DRY_RUN,
            log:        msg => console.log(DRY_RUN ? DRY + msg : msg),
        });
        if (res.booked.length === 0 && res.flagged.length === 0) {
            console.log(`[reconcile] ${res.checked} Position(en) geprüft – keine Lücke.`);
        }
    } catch (err) {
        console.warn(`[reconcile] Abgleich übersprungen – ${err.message}`);
    }

    const solBalance = await getSolBalance(keypair.publicKey);
    if (solBalance < SOL_MIN_FLOOR) {
        console.log(`[cleanup] SOL-Balance (${solBalance.toFixed(4)}) unter absolutem Minimum (${SOL_MIN_FLOOR} SOL) – Cleanup abgebrochen.`);
        console.log(JSON.stringify({ ok: false, error: `SOL-Balance zu gering (${solBalance.toFixed(4)} SOL) – Cleanup abgebrochen.`, log: [], result: {} }));
        db.close();
        process.exit(0);
    }

    // ── SOL-Top-Up: wenn < 0.11 SOL → tausche Wallet-Token bis 0.15 SOL erreicht ─
    // Zentrale, geteilte Logik (FORGE/lib/sol-balance.js via lib/sol-topup.js).
    // Cleanup hält bereits den Cleanup-Lock (acquireLock); die zentrale Funktion
    // greift bewusst keine Locks.
    // In jedem Modus, auch bei 'disabled' (LIQ#000929). bin/bot.js hat zusätzlich einen
    // eigenen SOL-Self-Heal je Zyklus — beide nutzen dieselbe Schwelle und dasselbe Ziel.
    if (DRY_RUN) {
        const solNow = await getSolBalanceFresh(keypair.publicKey);
        console.log(`[cleanup] ${DRY}SOL-Topup: ${solNow.toFixed(4)} SOL, Auslöser < ${SOL_TOPUP_TRIGGER.toFixed(2)} → `
            + (solNow < SOL_TOPUP_TRIGGER ? `würde auf ${SOL_TOPUP_TARGET} SOL auffüllen.` : 'kein Topup nötig.'));
    } else {
        await ensureWalletSol(db, keypair, connection, {
            minSol:    SOL_TOPUP_TRIGGER,
            targetSol: SOL_TOPUP_TARGET,
            log:       msg => console.log('[cleanup] ' + msg),
        });
    }

    if (CLEANUP_MODE.startsWith('pool:')) {
        const targetPoolId = CLEANUP_MODE.slice(5);
        if (DRY_RUN) {
            // runCleanupInvestPool() prüft und tauscht verschränkt — ein Probelauf darin
            // wäre ein zweiter Codepfad durch die Kapitallogik. Hier nur die Entscheidung.
            console.log(`[cleanup:invest] ${DRY}Invest in ${targetPoolId} würde geprüft/ausgeführt – übersprungen.`);
        } else {
            await runCleanupInvestPool(targetPoolId, db, keypair, connection);
        }
    } else {
        console.log(`[cleanup] ${t('cli.cl.mode_disabled')}`);
    }

    // Dust-Sweep: kleine bekannte Pool-Token-Reste → USDC. Läuft unabhängig von
    // der Invest-Entscheidung und in jedem Modus, damit Reste nicht dauerhaft im
    // Wallet liegen bleiben. Über Settings abschaltbar.
    if (CLEANUP_DUST_ENABLED) {
        await sweepDust(db, keypair, connection, { dryRun: DRY_RUN });
    } else {
        console.log(`[cleanup:dust] ${t('cli.cl.dust_disabled')}`);
    }

    if (DRY_RUN) {
        console.log('[cleanup] Probelauf fertig – nichts ausgeführt, nichts geschrieben.');
        console.log(JSON.stringify({ ok: true, dryRun: true, result: {}, log: [] }));
        process.exit(0);
    }

    // Portfolio + frischer Wallet-Snapshot + Sync via Orchestrator. Pro-Pool-Snapshots
    // wurden bereits von deposit-lib in jeder Invest-Iteration geschrieben.
    await refreshAfterAction(db);
    recordSuccess('cleanup');
    console.log('[cleanup] Fertig.');
    console.log(JSON.stringify({ ok: true, result: {}, log: [{ level: 'info', msg: t('cli.cl.success') }] }));
} catch (err) {
    console.error('[cleanup] FEHLER:', err.message);
    console.log(JSON.stringify({ ok: false, error: err.message, log: [], result: {} }));
    if (DRY_RUN) process.exit(1);
    const streak = recordFailure('cleanup');
    const FAIL_THRESHOLD = 3;
    if (streak >= FAIL_THRESHOLD) {
        await notify.error('cleanup', err);
    } else {
        console.warn(`[cleanup] ${t('cli.cl.alert_suppressed', { streak, max: FAIL_THRESHOLD })}`);
    }
    process.exit(1);
} finally {
    releaseOwnLock();
    db.close();
}
