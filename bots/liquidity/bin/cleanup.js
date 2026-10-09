/**
 * FORGE Liquidity – Cleanup-Job (bin/cleanup.js)
 *
 * Räumt das Wallet auf und stockt auf Wunsch (Reinvest, Premium) bestehende Positionen auf.
 * Neue Positionen eröffnet der Cleanup nie. Ablauf pro Lauf:
 *  0. Kapital-Abgleich (reconcileCapitalFlows) und SOL-Topup.
 *  1. Dust-Sweep (sweepDust, per Settings → Cleanup → Dust an/abschaltbar):
 *     verbleibende bekannte Pool-Token-Reste zwischen CLEANUP_DUST_MIN_USDC und
 *     CLEANUP_DUST_MAX_USDC (Default 0,01–25) → komplett zu USDC. Darunter
 *     vernachlässigbar (liegen lassen), darüber bleibt liegen bis zur Notbremse
 *     nach CLEANUP_STUCK_HOURS.
 *
 *  2. Reinvest (LIQ#000988, CLEANUP_REINVEST_MODE, Default aus): freies USDC in die BESTEHENDE
 *     Position des Pools mit dem besten PnL/Edge, via bin/deposit.js. Siehe lib/cleanup-reinvest.js.
 *
 * Einen Invest-Modus im früheren Sinn gibt es seit LIQ#000937 nicht mehr: „Bester Pool" (ranking) entfiel
 * mit LIQ#000929, der feste Zielpool (pool:<id>, Settings → Cleanup → Manuell) mit
 * LIQ#000937. Ein noch gesetztes CLEANUP_MODE wird nur noch erkannt, einmal gemeldet und
 * aus der .env entfernt (lib/cleanup-mode.js). Neues Kapital kommt nur über „Einzahlen“,
 * der Bot eröffnet nur noch wieder (Rebalance, bin/bot.js).
 *
 * Cron: stündlich :05 via FORGE/bin/run-cleanup.sh
 * Probelauf ohne On-Chain-Aktion und ohne Schreibzugriff: --dry-run
 */

import { config, removeKeysFromEnv, isPoolEnabled } from '../lib/config.js';
import { resolveCleanupMode } from '../lib/cleanup-mode.js';
import { t } from '../../../lib/i18n.js';
import { openDatabase, syncPools, insertTransaction, noteSwapFail, resetSwapFail } from '../lib/db.js';
import { getAdapter }  from '../lib/pool-adapter/index.js';
import { swapTokens, isWhirlpoolMintOrderError }  from '../lib/swap.js';
import {
    getKeypair, getConnection, USDC_MINT,
    getSolBalance, getSolBalanceFresh,
    getTokenBalanceFresh, getAllTokenBalances, getTxFee,
    getUsableUsdcBalanceFresh,
} from '../lib/wallet.js';
import * as notify     from '../lib/notify.js';
import { recordFailure, recordSuccess } from '../lib/fail-streak.js';
import { refreshAfterAction } from '../lib/refresh-state.js';
import { acquireLock, releaseLock, isSlLocked, isManualLocked, isRebalanceLocked, isRebalancePending } from '../lib/cleanup-lock.js';
import { getExitReservations, describeReservation, assertReservationsReadable } from '../lib/exit-reservation.js';
import { getTokenUsdPrice } from '../lib/deposit-lib.js';
import { reconcileCapitalFlows } from '../lib/capital-reconcile.js';
import { ensureWalletSol, INVEST_SOL_COMFORT, SOL_TOPUP_TARGET } from '../lib/sol-topup.js';
import { checkInvestEligibility, remainingInvestCapacity } from '../lib/invest-eligibility.js';
import { planReinvest, executeReinvest, runDepositScript, exitBlockFor } from '../lib/cleanup-reinvest.js';
import { parseReinvestConfig, readEdgeSnapshot } from '../../../lib/reinvest-rules.js';
import { sharePnl24hPct } from '../lib/pnl-anchor.js';
import {
    getOpenPosition, getDustWatch, startDustWatch, clearDustWatch,
} from '../lib/db.js';

// ─── --help ────────────────────────────────────────────────────────────────
// Muss vor jedem Modul-Level-Seiteneffekt (DB/Wallet/Connection weiter unten)
// geprüft werden, damit `--help` garantiert keinen echten Cleanup-Lauf auslöst.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
FORGE Liquidity – Cleanup-Job (bin/cleanup.js)

Räumt das Wallet auf (SOL ausgenommen), investiert aber nicht. Läuft normalerweise
stündlich per Cron (FORGE/bin/run-cleanup.sh). Ohne --dry-run führt jeder Aufruf
echte On-Chain-Swaps aus (SOL-Topup, Dust).

Ablauf pro Lauf:
  0. Kapital-Abgleich und SOL-Topup.
  1. Dust-Sweep (CLEANUP_DUST_ENABLED, Default an): bekannte Pool-Token-Reste
     zwischen CLEANUP_DUST_MIN_USDC und CLEANUP_DUST_MAX_USDC werden zu USDC
     geswappt. Reste ab der Obergrenze nach CLEANUP_STUCK_HOURS (Default 24 h)
     ebenfalls (Notbremse).

  2. Reinvest (CLEANUP_REINVEST_MODE=off|pnl|edge, Premium, Default off): freies USDC
     (zwischen CLEANUP_REINVEST_MIN_USDC und CLEANUP_REINVEST_MAX_USDC) wird in die
     BESTEHENDE Position des Pools mit dem besten PnL bzw. Edge eingezahlt. Eröffnet nie
     eine Position. Probelauf: --dry-run zeigt Rangfolge und Entscheidung.

Einen Invest-Modus im früheren Sinn gibt es nicht mehr: 'ranking' und 'pool:<id>' sind
entfallen, ein noch gesetztes CLEANUP_MODE wird einmal gemeldet und aus der .env entfernt.

Relevante Env-Vars: CLEANUP_REINVEST_MODE, CLEANUP_REINVEST_MIN_USDC,
CLEANUP_REINVEST_MAX_USDC, CLEANUP_DUST_ENABLED, CLEANUP_DUST_MIN_USDC,
CLEANUP_DUST_MAX_USDC, CLEANUP_STUCK_HOURS.

Aufruf: node bin/cleanup.js
        node bin/cleanup.js --dry-run (Probelauf: nur Entscheidungen loggen – keine
                                       Swaps, keine DB-/.env-Schreibzugriffe,
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

// ─── Veralteter Invest-Modus ──────────────────────────────────────────────────
// CLEANUP_MODE ('ranking', 'pool:<id>') steuert nichts mehr — Auflösung und Einordnung
// in lib/cleanup-mode.js. 🔒 Der Lauf endet dadurch nie vorzeitig: Abgleich, SOL-Topup
// und Dust laufen immer (LIQ#000929, business 09.–23.09.2026 ohne Abgleich).
const CLEANUP_MODE_RESOLVED = resolveCleanupMode(process.env.CLEANUP_MODE);

// ─── Konstanten ───────────────────────────────────────────────────────────────

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
})(); // ... bis unter diesen Gegenwert (drüber: bleibt liegen bis zur Notbremse)
// Notbremse für Reste >= DUST_SWAP_MAX_USDC: ohne Zeitlimit könnten größere Beträge
// beliebig lange als volatiles Asset im Wallet hängen bleiben. Nach CLEANUP_STUCK_HOURS
// wird trotzdem zu USDC geswappt — einen Cleanup-Invest, der den Rest vorher aufnimmt,
// gibt es seit LIQ#000937 nicht mehr.
const CLEANUP_STUCK_HOURS = (() => {
    const v = parseFloat(process.env.CLEANUP_STUCK_HOURS ?? '24');
    return v > 0 ? v : 24;
})();
const CLEANUP_SLIPPAGE_BPS = 150; // Höherer Slippage für Cleanup-Swaps (cbBTC illiquid bei Mitternacht)

const WSOL_MINT     = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS  = 9;
const USDC_DECIMALS = 6;
const SOL_TOKEN     = { mint: WSOL_MINT, decimals: SOL_DECIMALS, symbol: 'SOL' };
// Kleinster SOL-Überschuss (USDC-Wert), der einen Swap lohnt (Fees + Slippage).
const SOL_SURPLUS_MIN_USDC = 1.0;

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

/**
 * SOL-Überschuss → USDC (LIQ#000937 Nachtrag). Verkauft alles über SOL_TOPUP_TARGET.
 *
 * Der frühere Surplus-Block hing am Invest-Pfad und fiel mit ihm weg; seitdem blieb
 * SOL über dem Sollstand dauerhaft liegen (pub1: 0,65 SOL). Abbau exakt AUF
 * SOL_TOPUP_TARGET — dieselbe Zahl wie das Auffüllen, sonst pendelt das Wallet
 * (Rundlauf-Lehre 30.07.2026, lib/sol-topup.js). Bewusst kein Teil von sweepDust:
 * dessen Deckel (DUST_SWAP_MAX_USDC) und Notbremse passen nicht auf SOL.
 *
 * Nicht verkauft wird, wenn SOL gebraucht werden könnte: ein aktiver Pool mit
 * SOL-Token ohne offene Position (Kapitalaufbau für die Wiedereröffnung), ein
 * laufender Exit mit SOL oder ein nicht lesbarer Exit-Zustand.
 */
async function sweepSolSurplus(db, keypair, connection, { dryRun = false } = {}) {
    const rawSol   = await getSolBalanceFresh(keypair.publicKey);
    const surplus  = rawSol - SOL_TOPUP_TARGET;
    if (surplus <= 0) {
        console.log(`[cleanup:sol] ${rawSol.toFixed(4)} SOL ≤ Sollstand ${SOL_TOPUP_TARGET.toFixed(4)} – kein Überschuss.`);
        return;
    }
    const solPrice = getTokenUsdPrice(WSOL_MINT, db) || 0;
    if (!(solPrice > 0)) {
        console.warn('[cleanup:sol] kein SOL-Preis verfügbar – Überschuss nicht angefasst.');
        return;
    }
    const surplusUsd = surplus * solPrice;
    if (surplusUsd < SOL_SURPLUS_MIN_USDC) {
        console.log(`[cleanup:sol] Überschuss ${surplus.toFixed(4)} SOL (~${surplusUsd.toFixed(2)} USDC) < ${SOL_SURPLUS_MIN_USDC} USDC – liegen lassen.`);
        return;
    }

    const solPool = config.pools.all.find(p =>
        p.active && (p.tokenA === WSOL_MINT || p.tokenB === WSOL_MINT) && !getOpenPosition(db, p.id));
    if (solPool) {
        console.log(`[cleanup:sol] Pool ${solPool.id} (SOL-Paar) baut Kapital für die Wiedereröffnung auf – Überschuss nicht angefasst.`);
        return;
    }
    const reserved = loadReservedMints(db, '[cleanup:sol]');
    if (reserved === null) {
        console.warn('[cleanup:sol] Exit-Zustand unbekannt – Überschuss nicht angefasst.');
        return;
    }
    if (reserved.has(WSOL_MINT)) {
        console.log(`[cleanup:sol] SOL gehört zu einem laufenden Exit (${describeReservation(reserved.get(WSOL_MINT))}) – nicht angefasst.`);
        return;
    }

    console.log(`[cleanup:sol] ${dryRun ? DRY : ''}Überschuss ${surplus.toFixed(4)} SOL (~${surplusUsd.toFixed(2)} USDC) über Sollstand ${SOL_TOPUP_TARGET.toFixed(4)} → USDC`);
    if (dryRun) return;
    await swapTo(SOL_TOKEN, surplus, USDC_MINT, USDC_DECIMALS, 'USDC', keypair, connection, null, 'sol-surplus');
}

// ─── Dust-Sweep ────────────────────────────────────────────────────────────────
//
// Räumt kleine Pool-Token-Reste („Dust") aus dem Wallet, die sonst ungenutzt
// liegen bleiben. Läuft in jedem Cleanup-Lauf (abschaltbar über CLEANUP_DUST_ENABLED).
//
// Nur bekannte Pool-Tokens (config.pools.all, nicht SOL/USDC):
//   < DUST_SWAP_MIN_USDC (0,01)  → vernachlässigbar, liegen lassen
//   0,01 – < 25 USDC             → komplett zu USDC swappen
//   >= DUST_SWAP_MAX_USDC (25)   → liegen lassen, bis die Beobachtung (dust_watch)
//                                  CLEANUP_STUCK_HOURS (Default 24h) alt ist, dann
//                                  Notbremse: trotzdem zu USDC swappen (noteLabel
//                                  'stuck-dust', Dashboard zeigt "Dust Swap 24h").
//
// Kein SOL-Swap: SOL-Bedarf deckt die Selbstheilung (lib/sol-topup.js) ab.
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
    // da der SOL-Topup davor Balances verändert haben kann (Cache stale).
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
// Idempotent: der Reinvest gibt den Lock VOR bin/deposit.js frei (deposit.js bricht ab, solange
// ein Cleanup läuft). Das finally-Ende darf danach nicht noch einmal löschen, sonst entfernte es
// den Lock eines inzwischen gestarteten anderen Laufs.
let lockReleased = false;
const releaseOwnLock = () => { if (!DRY_RUN && !lockReleased) { lockReleased = true; releaseLock(); } };

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
 * Hinweis auf einen entfallenen Invest-Modus — genau einmal je Installation.
 *   „Bester Pool" (ranking, LIQ#000929) und „Manuell" (pool:<id>, LIQ#000937).
 * Auslöser:
 *   - Migration 0012 bzw. 0014 hat die .env umgestellt und CLEANUP_NOTICE_RANKING_REMOVED=1
 *     bzw. CLEANUP_NOTICE_POOL_REMOVED=<poolId> gesetzt. Sie läuft beim Update VOR dem
 *     Dienststart, Nexus ist dann nicht erreichbar — deshalb meldet erst dieser Lauf.
 *   - CLEANUP_MODE steht (ohne Migration, z.B. von Hand gesetzt) noch in der .env: Er
 *     steuert nichts mehr und wird entfernt, damit die Meldung nicht stündlich wiederkommt.
 *     'disabled' und Tippfehler werden still entfernt, nur ein früherer Invest-Modus ist
 *     einen Hinweis wert.
 */
async function noticeInvestModeRemoved() {
    const { legacy, raw, poolId: legacyPoolId } = CLEANUP_MODE_RESOLVED;
    const pendingRanking = process.env.CLEANUP_NOTICE_RANKING_REMOVED === '1';
    const pendingPoolId  = (process.env.CLEANUP_NOTICE_POOL_REMOVED ?? '').trim() || null;

    if (legacy === 'ranking' || legacy === 'pool') console.log(`[cleanup] ${t('cli.cl.legacy_mode', { mode: raw })}`);
    else if (legacy === 'unknown') console.log(`[cleanup] ${t('cli.cl.unknown_mode', { mode: raw })}`);
    if (!legacy && !pendingRanking && !pendingPoolId) return;

    const noticeRanking = legacy === 'ranking' || pendingRanking;
    const noticePoolId  = legacy === 'pool' ? legacyPoolId : pendingPoolId;
    const flagKeys = [
        ...(pendingRanking ? ['CLEANUP_NOTICE_RANKING_REMOVED'] : []),
        ...(pendingPoolId  ? ['CLEANUP_NOTICE_POOL_REMOVED']    : []),
    ];

    if (DRY_RUN) {
        const parts = [];
        if (noticeRanking) parts.push('Hinweis „Bester Pool entfällt" würde gesendet');
        if (noticePoolId)  parts.push(`Hinweis „Invest in ${noticePoolId} endet" würde gesendet`);
        if (legacy)        parts.push(`CLEANUP_MODE=${raw} würde aus der .env entfernt`);
        if (flagKeys.length) parts.push(`${flagKeys.join(', ')} würde entfernt`);
        console.log(`[cleanup] ${DRY}${parts.join(', ')}.`);
        return;
    }
    if (noticeRanking) await notify.info('cleanup', t('cli.cl.ranking_removed_notice'));
    if (noticePoolId) {
        const p = config.pools.all.find(pp => pp.id === noticePoolId);
        await notify.info('cleanup', t('cli.cl.pool_mode_removed_notice', { pool: p ? (p.displayPair ?? p.pair) : noticePoolId }));
    }
    try {
        removeKeysFromEnv([...(legacy ? ['CLEANUP_MODE'] : []), ...flagKeys]);
    } catch (err) {
        console.warn(`[cleanup] .env-Korrektur nach Hinweis fehlgeschlagen: ${err.message}`);
    }
}

/**
 * Reinvest (LIQ#000988): freies Wallet-USDC in eine BESTEHENDE Position des Pools mit dem besten
 * PnL/Edge einzahlen. Premium-Funktion, Default deaktiviert. 🔒 Eröffnet nie eine Position —
 * Details und Absicherungen in lib/cleanup-reinvest.js. Läuft als letzter Kapitalschritt, weil
 * der Cleanup-Lock dafür freigegeben wird (bin/deposit.js bricht bei laufendem Cleanup ab).
 */
async function runReinvestStep() {
    const cfg = parseReinvestConfig(process.env);
    const log = msg => console.log(`[cleanup:reinvest] ${DRY_RUN ? DRY : ''}${msg}`);


    const plan = await planReinvest({
        pools:             config.pools.all,
        isPoolEnabled,
        getOpenPosition:   poolId => getOpenPosition(db, poolId),
        exitBlock:         exitBlockFor(db),
        checkEligibility:  pool => checkInvestEligibility(pool, db),
        // PnL 24h in %: derselbe Wert wie die Spalte „PnL 24H“ in Operative Metriken (sharePnl24hPct),
        // sonst kann der Nutzer die Wahl nicht nachvollziehen.
        pnl24h:            pos => sharePnl24hPct(db, pos, config.botId),
        readEdge:          () => readEdgeSnapshot(),
        getPositionState:  (pool, pos) => getAdapter(pool).getPositionState(pool, pos.nft_mint),
        getWalletUsdc:     () => getUsableUsdcBalanceFresh(keypair.publicKey),
        remainingCapacity: pool => remainingInvestCapacity(pool, db),
        pendingReopens: () => config.pools.all
            .filter(p => (p.active && !getOpenPosition(db, p.id)) || isRebalancePending(p.id))
            .map(p => p.displayPair ?? p.pair),
        log,
    }, cfg);

    if (plan.action !== 'invest') return;
    if (DRY_RUN) {
        log(`würde ${plan.usdc.toFixed(2)} USDC per bin/deposit.js in die bestehende Position von ${plan.pool.displayPair ?? plan.pool.pair} einzahlen (Note „${plan.note}“).`);
        return;
    }

    const res = await executeReinvest(plan, {
        getOpenPosition: poolId => getOpenPosition(db, poolId),
        releaseLock:     releaseOwnLock,
        runDeposit:      runDepositScript,
        log,
    });
    // Position verschwunden = der Versuch, in einen Pool ohne Position einzuzahlen, wurde
    // abgefangen. Selten, aber sichtbar (Message Center), damit es nicht still verpufft.
    if (res.status === 'no_position' || /erwartete offene Position/.test(res.error ?? '')) {
        await notify.warn('cleanup:reinvest', new Error(
            `Reinvest in ${plan.pool.displayPair ?? plan.pool.pair} abgebrochen: die Position ist nicht mehr offen. `
            + 'Es wurde nichts investiert und keine Position eröffnet.'));
    }
}

try {
    console.log(`[cleanup] Start${DRY_RUN ? ' (Probelauf, --dry-run)' : ''}:`, new Date().toISOString());
    await noticeInvestModeRemoved();

    // Kapitalflüsse gegen die Chain abgleichen, BEVOR irgendetwas entschieden oder
    // bewegt wird: eine nicht gebuchte Einzahlung verfälscht capital_usdc und damit
    // PnL und die Kapital-Guards des Bots beim nächsten Öffnen.
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
    // bin/bot.js hat zusätzlich einen eigenen SOL-Self-Heal je Zyklus — beide nutzen
    // dieselbe Schwelle und dasselbe Ziel.
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

    // Dust-Sweep: kleine bekannte Pool-Token-Reste → USDC, damit Reste nicht dauerhaft
    // im Wallet liegen bleiben. Über Settings abschaltbar.
    if (CLEANUP_DUST_ENABLED) {
        await sweepDust(db, keypair, connection, { dryRun: DRY_RUN });
        // SOL über dem Sollstand → USDC (hängt am selben Schalter wie der Dust-Sweep).
        await sweepSolSurplus(db, keypair, connection, { dryRun: DRY_RUN });
    } else {
        console.log(`[cleanup:dust] ${t('cli.cl.dust_disabled')}`);
    }

    // Reinvest (Premium, Default aus). Ein Fehler hier darf den Lauf nicht kippen: Abgleich, Topup
    // und Dust sind dann längst erledigt.
    try {
        await runReinvestStep();
    } catch (err) {
        console.warn(`[cleanup:reinvest] übersprungen – ${err.message}`);
    }

    if (DRY_RUN) {
        console.log('[cleanup] Probelauf fertig – nichts ausgeführt, nichts geschrieben.');
        console.log(JSON.stringify({ ok: true, dryRun: true, result: {}, log: [] }));
        process.exit(0);
    }

    // Portfolio + frischer Wallet-Snapshot + Sync via Orchestrator.
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
