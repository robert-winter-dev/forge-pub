/**
 * FORGE Liquidity – Cleanup-Job (bin/cleanup.js)
 *
 * Verwertet Wallet-Reste automatisch (SOL ausgenommen). Zwei Schritte pro Lauf:
 *  1. Invest-Logik je CLEANUP_MODE:
 *       'ranking' → komplett in den höchstbewerteten Pool (Score >= CLEANUP_MIN_SCORE)
 *       'pool:X'  → fest in den gewählten Pool X
 *     Konsolidiert dabei Fremd-Token-Reste ab MIN_SWAP_USDC zu USDC und zahlt ein.
 *  2. Dust-Sweep (sweepDust, per Settings → Cleanup → Dust an/abschaltbar):
 *     verbleibende bekannte Pool-Token-Reste zwischen CLEANUP_DUST_MIN_USDC und
 *     CLEANUP_DUST_MAX_USDC (Default 0,01–25) → komplett zu USDC. Darunter
 *     vernachlässigbar (liegen lassen), darüber bleibt liegen (regulärer Invest folgt).
 *
 * Cron: stündlich :05 via FORGE/bin/run-cleanup.sh
 */

import { PublicKey }  from '@solana/web3.js';
import Database       from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';

const __dirnameCleanup = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB    = PATHS.settingsDb;
const LIQUIDITY_DATA_PATH = resolve(__dirnameCleanup, '../../../html/liquidity/data/data.json');

import { config, setPoolActive, isPoolEnabled } from '../lib/config.js';
import { t } from '../../../lib/i18n.js';
import { ensureScoreLimitEnabled, ensureTvlProtectionDefaults, ensureTrailingStopMinimumReset } from '../lib/settings-auto.js';
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
import { deposit, getTokenUsdPrice, checkClmmRatio } from '../lib/deposit-lib.js';
import { reconcileCapitalFlows } from '../lib/capital-reconcile.js';
import { ensureWalletSol, INVEST_SOL_COMFORT, SOL_TOPUP_TARGET } from '../lib/sol-topup.js';
import {
    getOpenPosition, getDustWatch, startDustWatch, clearDustWatch,
    getLastTsExecutionAt, getLastTvlExecutionAt, getLastScoreLimitExecutionAt,
} from '../lib/db.js';
import { loadTsConfig } from '../lib/trailing-stop.js';
import { loadTvlConfig } from '../lib/tvl-protection.js';
import { loadConfig as loadScoreLimitConfig } from '../lib/score-limit.js';
import { calculateRange } from '../lib/range.js';
import { PATHS } from '../../../config/paths.js';

// ─── --help ────────────────────────────────────────────────────────────────
// Muss vor jedem Modul-Level-Seiteneffekt (DB/Wallet/Connection weiter unten)
// geprüft werden, damit `--help` garantiert keinen echten Cleanup-Lauf auslöst.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
FORGE Liquidity – Cleanup-Job (bin/cleanup.js)

Verwertet Wallet-Reste automatisch (SOL ausgenommen). Läuft normalerweise
stündlich per Cron (FORGE/bin/run-cleanup.sh) – KEIN Dry-Run-Modus, jeder
Aufruf führt echte On-Chain-Swaps/Deposits aus, sobald genug Guthaben da ist.

Zwei Schritte pro Lauf:
  1. Invest-Logik je CLEANUP_MODE (Env-Var, Default 'ranking'):
       ranking  → komplett in den aktuell höchstbewerteten Pool
                  (Opportunity Score >= CLEANUP_MIN_SCORE, Default 65)
       pool:X   → fest in den gewählten Pool X
     Konsolidiert dabei Fremd-Token-Reste ab MIN_SWAP_USDC zu USDC und zahlt sie ein.
  2. Dust-Sweep (sweepDust, läuft immer): verbleibende bekannte Pool-Token-Reste
     mit Gegenwert 0,5–5 USDC werden komplett zu USDC geswappt. Unter 0,5 USDC
     bleibt liegen (vernachlässigbar), ab 5 USDC bleibt liegen (regulärer
     Invest-Schritt oben übernimmt das im nächsten Lauf).

Relevante Env-Vars: CLEANUP_MODE, CLEANUP_MIN_SCORE, CLEANUP_MAX_DEPOSIT,
CLEANUP_MIN_DEPOSIT.

Aufruf: node bin/cleanup.js
        node bin/cleanup.js --help   (dieser Text, kein Cleanup-Lauf)
`);
    process.exit(0);
}

// ─── Opportunity-Score-Mindestscore (nur für Modus 'ranking') ────────────────
// Vergleicht den Opportunity Score aus data.json (identisch zur Tabelle im Dashboard).
// Cleanup wird übersprungen wenn der beste Pool < CLEANUP_MIN_SCORE ist.
const CLEANUP_MIN_SCORE = Math.max(0, parseInt(process.env.CLEANUP_MIN_SCORE ?? '65', 10));

// ─── Maximale Einzahlung pro Cleanup-Lauf ─────────────────────────────────────
// 0 = kein Limit (Standard). Werte < 10 werden ignoriert.
// Gilt nur für den 'ranking'-Modus. Im direkten 'pool:X'-Modus (manuell) kein Cap.
const CLEANUP_MAX_DEPOSIT = (() => {
    const v = parseFloat(process.env.CLEANUP_MAX_DEPOSIT ?? '0');
    return v >= 10 ? v : 0;
})();

// ─── Minimale Einzahlung pro Cleanup-Lauf ─────────────────────────────────────
// 0 = kein Minimum (Standard). Werte < 1 werden ignoriert.
// Gilt nur für den 'ranking'-Modus (wie CLEANUP_MAX_DEPOSIT). Ist der investierbare
// Wallet-Wert darunter, passiert nichts (kein Deposit) – verhindert wirtschaftlich
// unsinnige Mini-Einzahlungen (TX-Fees fressen den Betrag sonst auf).
const CLEANUP_MIN_DEPOSIT = (() => {
    const v = parseFloat(process.env.CLEANUP_MIN_DEPOSIT ?? '0');
    return v >= 1 ? v : 0;
})();

function _loadAllOpportunityScores() {
    const data = JSON.parse(readFileSync(LIQUIDITY_DATA_PATH, 'utf8'));
    const map = new Map();
    for (const p of (data.pools ?? [])) {
        if (p.investScore?.value != null) map.set(p.id, p.investScore);
    }
    return map;
}

// ─── Mode-Check ───────────────────────────────────────────────────────────────
// CLEANUP_MODE: 'disabled' | 'ranking' | 'pool:<pool_id>'
//   'ranking' → Investiert komplett in den höchstbewerteten Pool aus pool-scores.json
//               (nur 🟢 strong / 🟡 ok – bei nur rot/orange passiert nichts)
//   'pool:X'  → Investiert in den fest gewählten Pool X
// Rückwärtskompatibel: fehlt CLEANUP_MODE, wird CLEANUP_ENABLED ausgewertet.
const CLEANUP_MODE = process.env.CLEANUP_MODE
    ?? (process.env.CLEANUP_ENABLED === 'false' ? 'disabled' : 'ranking');

if (CLEANUP_MODE === 'disabled') {
    console.log(`[cleanup] ${t('cli.cl.mode_disabled')}`);
    process.exit(0);
}

// ─── Konstanten ───────────────────────────────────────────────────────────────

const MIN_USDC_AMOUNT  = 1.0;   // Mindest-USDC-Äquivalent für Deposits
const MIN_SWAP_USDC    = 2.0;   // Mindest-USDC-Äquivalent für Swaps (Bestpool-Reinvest) – Dust darunter wird übersprungen

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
// Notbremse für Reste >= DUST_SWAP_MAX_USDC: Analyse 2026-07-24 zeigte Score-<65-Phasen
// von bis zu 72h (Median ~22h) – ohne Zeitlimit könnten größere Beträge entsprechend
// lange als volatiles Asset im Wallet hängen bleiben. Nach CLEANUP_STUCK_HOURS ohne
// investierbaren Pool (Score >= CLEANUP_MIN_SCORE) wird trotzdem zu USDC geswappt.
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
        insertTransaction(db, {
            poolId, type: 'swap',
            amountA: amount, amountB: amountOut,
            usdValue, txHash: txSignature,
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
// liegen bleiben. Läuft in JEDEM Cleanup-Lauf (außer 'disabled'), unabhängig
// davon ob überhaupt in einen Pool investiert wurde — sonst bliebe der Dust in
// Stunden ohne investierbaren Pool (bester Score < CLEANUP_MIN_SCORE) liegen.
//
// Nur bekannte Pool-Tokens (config.pools.all, nicht SOL/USDC):
//   < DUST_SWAP_MIN_USDC (0,01)  → vernachlässigbar, liegen lassen
//   0,01 – < 25 USDC             → komplett zu USDC swappen
//   >= DUST_SWAP_MAX_USDC (25)   → liegen lassen; wird vom regulären Ranking-
//                                  Cleanup ins Bestpool investiert – außer die
//                                  Beobachtung (dust_watch) läuft schon seit
//                                  CLEANUP_STUCK_HOURS (Default 24h) ohne Erfolg,
//                                  dann Notbremse: trotzdem zu USDC swappen (noteLabel
//                                  'stuck-dust', Dashboard zeigt "Dust Swap 24h")
//
// Kein SOL-Swap: SOL-Bedarf deckt die Selbstheilung (lib/sol-topup.js) ab.
// Läuft NACH der Invest-Logik: der Ranking-/Pool-Invest hat bereits die
// Fremd-Token-Reste ab MIN_SWAP_USDC konsolidiert; hier bleiben nur die kleinen
// Reste darunter — genau die, die sonst dauerhaft im Wallet liegen bleiben.
async function sweepDust(db, keypair, connection) {
    const relevantTokens = getRelevantTokens(config.pools.all);
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
            clearDustWatch(db, token.mint);
            continue;
        }

        const balance = await getTokenBalanceFresh(keypair.publicKey, token.mint, token.decimals);
        if (balance <= 0) {
            clearDustWatch(db, token.mint);
            continue;
        }

        const price = getTokenUsdPrice(token.mint, db) || 0;
        if (price <= 0) continue; // Gegenwert unbekannt → nicht als Dust behandeln, Watch-Status unverändert lassen
        const usdcValue = balance * price;

        if (usdcValue < DUST_SWAP_MIN_USDC) {
            clearDustWatch(db, token.mint);
            console.log(`[cleanup:dust] ${t('cli.cl.dust_negligible', { token: token.symbol, usdc: usdcValue.toFixed(4), min: DUST_SWAP_MIN_USDC })}`);
            continue;
        }
        if (usdcValue >= DUST_SWAP_MAX_USDC) {
            const watch = getDustWatch(db, token.mint);
            const now = Date.now();
            if (!watch) {
                startDustWatch(db, token.mint, usdcValue);
                console.log(`[cleanup:dust] ${t('cli.cl.dust_not_dust', { token: token.symbol, usdc: usdcValue.toFixed(2), max: DUST_SWAP_MAX_USDC })}`);
                continue;
            }
            const elapsedHours = (now - watch.first_seen_at) / 3_600_000;
            if (elapsedHours < CLEANUP_STUCK_HOURS) {
                console.log(`[cleanup:dust] ${token.symbol} ~${usdcValue.toFixed(2)} USDC – wartet seit ${elapsedHours.toFixed(1)}h auf Score >= ${CLEANUP_MIN_SCORE} (Limit ${CLEANUP_STUCK_HOURS}h).`);
                continue;
            }
            console.log(`[cleanup:dust] ${token.symbol} ~${usdcValue.toFixed(2)} USDC – seit ${elapsedHours.toFixed(1)}h ohne investierbaren Pool, Notbremse: swap.`);
            await notify.info('cleanup', `${token.symbol} (~${usdcValue.toFixed(2)} USDC) seit ${elapsedHours.toFixed(1)}h ohne Pool mit Score >= ${CLEANUP_MIN_SCORE} – zwangsweise geswappt.`);
            await swapDustPortion(token, balance, usdcValue, 'stuck-dust');
            clearDustWatch(db, token.mint);
            continue;
        }

        clearDustWatch(db, token.mint);
        console.log(`[cleanup:dust] ${token.symbol} Dust ~${usdcValue.toFixed(2)} USDC – swap komplett.`);
        await swapDustPortion(token, balance, usdcValue, 'dust');
    }
}

// ─── Settings-Helfer ─────────────────────────────────────────────────────────

/**
 * Liest pool_settings aus settings.db und liefert ein Set der Pool-IDs,
 * bei denen `cleanup.rankingEligible === false` gesetzt ist.
 * Wird vom Ranking-Cleanup verwendet, um vom User ausgeschlossene Pools zu überspringen.
 */
function _loadRankingIneligiblePools() {
    const ineligible = new Set();
    try {
        const sdb = new Database(SETTINGS_DB, { readonly: true });
        const rows = sdb.prepare(
            `SELECT pool_id, settings FROM pool_settings WHERE bot_id = ?`
        ).all(config.botId);
        sdb.close();
        for (const row of rows) {
            try {
                const s = JSON.parse(row.settings);
                if (s?.cleanup?.rankingEligible === false) ineligible.add(row.pool_id);
            } catch { /* korrupte JSON ignorieren */ }
        }
    } catch (err) {
        console.warn(`[cleanup:ranking] ${t('cli.cl.eligibility_unreadable', { error: err.message })}`);
    }
    return ineligible;
}

/**
 * Pools, die sich gerade in der Cooldown-Phase eines der drei Risk-Management-Exits
 * (Trailing Stop, TVL-Schutz, Score-Limit) befinden, werden vom Ranking-Cleanup
 * übersprungen — sonst würde frisch befreites Kapital sofort wieder in denselben
 * (oder einen anderen, aber ebenso gerade erst verlassenen) Pool investiert, noch
 * bevor der Nutzer eingreifen konnte. Vorher waren alle drei `cooldownHours`-Felder
 * reine UI-Werte ohne jede Wirkung im Bot (Befund 2026-08-08, zuerst bei Trailing
 * Stop gefunden, TVL/Score-Limit hatten dieselbe Lücke).
 *
 * Liefert eine Map poolId → { until, reason } für den jeweils spätesten aktiven
 * Cooldown (falls mehrere Exit-Typen für denselben Pool gleichzeitig im Cooldown
 * stehen sollten).
 */
function _loadCleanupCooldownBlockedPools(db, { quiet = false } = {}) {
    const blocked = new Map();
    for (const poolId of config.pools.all.map(p => p.id)) {
        const candidates = [
            { reason: 'Trailing Stop', lastAt: getLastTsExecutionAt(db, poolId),         cooldownHours: Number(loadTsConfig(poolId)?.cooldownHours) },
            { reason: 'TVL-Schutz',    lastAt: getLastTvlExecutionAt(db, poolId),        cooldownHours: Number(loadTvlConfig(poolId)?.cooldownHours) },
            { reason: 'Score-Limit',   lastAt: getLastScoreLimitExecutionAt(db, poolId), cooldownHours: Number(loadScoreLimitConfig(poolId)?.cooldownHours) },
        ];
        for (const c of candidates) {
            if (!c.lastAt) continue;
            const cooldownHours = Number.isFinite(c.cooldownHours) && c.cooldownHours > 0 ? c.cooldownHours : 1;
            const until = c.lastAt + cooldownHours * 3_600_000;
            if (Date.now() >= until) continue;
            const existing = blocked.get(poolId);
            if (!existing || until > existing.until) blocked.set(poolId, { until, reason: c.reason });
        }
    }
    if (!quiet) {
        for (const [poolId, { until, reason }] of blocked) {
            const remainingMin = Math.ceil((until - Date.now()) / 60_000);
            console.log(`[cleanup:ranking] ${t('cli.cl.cooldown_excluded', { pool: poolId, reason, min: remainingMin })}`);
        }
    }
    return blocked;
}

// ─── Invest-in-Pool Logik ─────────────────────────────────────────────────────

const USDC_TOKEN = { mint: USDC_MINT, decimals: USDC_DECIMALS, symbol: 'USDC' };
const SOL_TOKEN  = { mint: WSOL_MINT, decimals: SOL_DECIMALS,  symbol: 'SOL'  };

/**
 * Invest-in-Pool: alle Wallet-Reste (außer SOL-Reserve) in einen bestimmten Pool einzahlen.
 * Ersetzt die 3-2-1-Regel vollständig.
 */
async function runCleanupInvestPool(targetPoolId, db, keypair, connection, { skipCap = false } = {}) {
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

    // Risk-Management-Cooldown: gilt in JEDEM Invest-Pfad, nicht nur im Ranking-Modus.
    // runCleanupByRanking() filtert Cooldown-Pools bereits vorab aus (dort ist diese
    // Prüfung dann wirkungslos), der Modus CLEANUP_MODE='pool:<id>' läuft aber direkt
    // hier herein und umging den Cooldown bislang vollständig — frisch per Trailing
    // Stop / TVL-Schutz / Score-Limit befreites Kapital konnte sofort zurück in
    // denselben Pool fließen. Der konfigurierte Cooldown ist bewusst eine harte
    // Sperre und keine Empfehlung.
    // quiet: die vollständige Cooldown-Liste hat der Ranking-Pfad ggf. schon geloggt.
    const cooldown = _loadCleanupCooldownBlockedPools(db, { quiet: true }).get(targetPoolId);
    if (cooldown) {
        const remainingMin = Math.ceil((cooldown.until - Date.now()) / 60_000);
        console.log(`[cleanup:invest] ${targetPool.pair}: ${cooldown.reason}-Cooldown aktiv (noch ${remainingMin} Min) – kein Invest.`);
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
    console.log(`[cleanup:invest] ${t('cli.cl.target_pool', { pool: targetPool.pair })}${wasInactive ? ` (${t('cli.cl.inactive_reactivate')})` : ''}${skipCap ? ` (${t('cli.cl.no_cap')})` : ''}`);

    if (targetPool.volatilePair) {
        await _investVolatilePair(targetPool, db, keypair, connection, { skipCap });
    } else {
        await _investStandard(targetPool, db, keypair, connection, { skipCap });
    }

    // Pool reaktivieren wenn er vorher inaktiv war
    if (wasInactive) {
        try {
            if (getOpenPosition(db, targetPoolId)) {
                // Bestehende Position vorhanden → sofort aktivieren (Normalfall)
                setPoolActive(targetPoolId, true);
                console.log(`[cleanup:invest] ${t('cli.liq.pool_activated', { pool: targetPool.pair })}`);
                ensureScoreLimitEnabled(targetPoolId);
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
                const reactTargetUsdc  = lastPosForReact?.capital_usdc ?? targetPool.capitalUSDC ?? 1000;
                // Schwelle: relative 30-%-Schranke UND – falls konfiguriert – der absolute
                // CLEANUP_MIN_DEPOSIT-Floor. Der Floor schützt davor, dass ein korruptes/zu
                // kleines capital_usdc der Vorposition (z.B. nach fehlerhafter Withdraw-Buchung)
                // die relative Schranke auf Cent-Niveau drückt und so eine Mini-Reaktivierung
                // durchwinkt. Beide müssen erfüllt sein → größeres Limit gewinnt.
                const minReactivateUsd = Math.max(MIN_USDC_AMOUNT, reactTargetUsdc * 0.30, CLEANUP_MIN_DEPOSIT);
                const walletUsdc = await getUsableUsdcBalanceFresh(keypair.publicKey);
                if (walletUsdc >= minReactivateUsd) {
                    setPoolActive(targetPoolId, true);
                    console.log(`[cleanup:invest] ${t('cli.cl.reactivated_ready', { pool: targetPool.pair, usdc: walletUsdc.toFixed(2) })}`);
                    ensureScoreLimitEnabled(targetPoolId);
                    // Nicht `t` nennen — siehe Kommentar im if-Zweig oben (i18n-Shadowing).
                    const tvlNow = db.prepare(`SELECT tvl_usd FROM pool_stats WHERE pool_id=? AND tvl_usd>0 ORDER BY recorded_at DESC LIMIT 1`).get(targetPoolId)?.tvl_usd ?? 0;
                    ensureTvlProtectionDefaults(targetPoolId, tvlNow, { warn: targetPool.tvlWarnThreshold, exit: targetPool.tvlExitThreshold });
                    ensureTrailingStopMinimumReset(targetPoolId);
                } else {
                    const floorNote = CLEANUP_MIN_DEPOSIT > 0 ? `, Min-Floor ${CLEANUP_MIN_DEPOSIT}` : '';
                    console.log(`[cleanup:invest] ${t('cli.cl.not_reactivated', { pool: targetPool.pair, have: walletUsdc.toFixed(2), min: minReactivateUsd.toFixed(2), target: reactTargetUsdc.toFixed(2), floorNote })}`);
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
 * Bester-Pool-Invest: liest Opportunity Scores aus data.json
 * (identisch mit der Opportunity-Tabelle im Dashboard) und investiert
 * in den Pool mit dem höchsten Score über CLEANUP_MIN_SCORE.
 */
async function runCleanupByRanking(db, keypair, connection) {
    const configuredIds = new Set(config.pools.all.map(p => p.id));
    const ineligible    = _loadRankingIneligiblePools();
    const cooldownBlocked = _loadCleanupCooldownBlockedPools(db);

    if (ineligible.size > 0) {
        console.log(`[cleanup:ranking] ${ineligible.size} Pool(s) per Settings ausgeschlossen: ${[...ineligible].join(', ')}`);
    }

    // Opportunity Scores aus data.json laden (dieselbe Quelle wie Dashboard-Tabelle)
    let scoreByPool;
    try {
        scoreByPool = _loadAllOpportunityScores();
    } catch {
        console.log(`[cleanup:ranking] ${t('cli.cl.data_json_unreadable')}`);
        await notify.warn('cleanup:ranking', new Error('data.json nicht lesbar'));
        return;
    }

    const scored = [];
    const poolById = new Map(config.pools.all.map(p => [p.id, p]));
    for (const poolId of configuredIds) {
        if (ineligible.has(poolId)) continue;
        if (cooldownBlocked.has(poolId)) continue;
        // Benutzer-Sperre (enabled=false): Pool ist vom Investieren ausgeschlossen
        // (z.B. nach TVL-Voll-Exit oder manueller Deaktivierung). Niemals reaktivieren.
        if (!isPoolEnabled(poolById.get(poolId))) continue;
        const sc = scoreByPool.get(poolId);
        if (!sc) continue;
        scored.push({ id: poolId, score: sc.value, hopiumVeto: sc.hopiumVeto ?? false });
    }

    if (scored.length === 0) {
        console.log(`[cleanup:ranking] ${t('cli.cl.no_score_data')}`);
        await notify.info?.('cleanup:ranking', 'Keine Opportunity-Score-Daten – Cleanup übersprungen.');
        return;
    }

    scored.sort((a, b) => b.score - a.score);
    const best       = scored[0];
    const runnerUp   = scored[1] ?? null;
    const targetPool = config.pools.all.find(p => p.id === best.id);

    // Entscheidung loggen (auch wenn min_score nicht erreicht)
    try {
        db.prepare(`
            INSERT INTO cleanup_decisions
                (decided_at, winner_pool, winner_score, runner_up, runner_up_score, candidates, skipped)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            Date.now(),
            best.id,
            best.score,
            runnerUp?.id   ?? null,
            runnerUp?.score ?? null,
            JSON.stringify(scored),
            best.score < CLEANUP_MIN_SCORE ? 1 : 0,
        );
    } catch (err) {
        console.warn(`[cleanup:ranking] Decision-Log fehlgeschlagen: ${err.message}`);
    }
    const wasInactive = !targetPool?.active;

    console.log(`[cleanup:ranking] ${t('cli.cl.best_pool', { pool: best.id, score: best.score })}${best.hopiumVeto ? ' ⚠️ Hopium-Veto' : ''}${wasInactive ? ` (${t('cli.cl.inactive_reactivate_short')})` : ''}`);

    if (best.score < CLEANUP_MIN_SCORE) {
        console.log(`[cleanup:ranking] Opportunity Score ${best.score} < Mindestscore ${CLEANUP_MIN_SCORE} – Kapital bleibt liquide.`);
        await notify.info?.('cleanup:ranking',
            t('cli.cl.best_below_min', { pool: targetPool?.pair ?? best.id, score: best.score, min: CLEANUP_MIN_SCORE })
        );
        return;
    }

    console.log(`[cleanup:ranking] Opportunity Score ${best.score} >= ${CLEANUP_MIN_SCORE} ✓ – starte Invest.`);

    await runCleanupInvestPool(best.id, db, keypair, connection);
}

/**
 * Standard-Pool (SOL/USDC, cbBTC/USDC, EURC/USDC): alle Fremd-Tokens → USDC, dann depositStandard.
 */
async function _investStandard(targetPool, db, keypair, connection, { skipCap = false } = {}) {
    const allPools = config.pools.all;

    // Fremd-Tokens (nicht USDC, nicht tokenA, nicht tokenB des Ziel-Pools) → USDC swappen.
    // tokenB explizit ausschließen: bei usdcIsTokenA-Pools (EURC/USDC) ist tokenB (EURC)
    // kein Fremd-Token – es wird für den Deposit benötigt.
    const foreignTokens = getRelevantTokens(allPools).filter(t =>
        t.mint !== USDC_MINT && t.mint !== targetPool.tokenA && t.mint !== targetPool.tokenB
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
                        // Auf CLEANUP_MAX_DEPOSIT gedeckelt: sonst swappt dieser Ratio-Pre-Swap
                        // das komplette Wallet-USDC in SOL, obwohl Schritt 5 (depositStandard)
                        // den tatsächlichen Deposit ohnehin auf den Cap begrenzt — der Rest
                        // bliebe unnötig als Fremdwährung (Kursrisiko) im Wallet liegen.
                        const swapCap    = (!skipCap && CLEANUP_MAX_DEPOSIT > 0) ? CLEANUP_MAX_DEPOSIT : Infinity;
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
                        // Auf CLEANUP_MAX_DEPOSIT gedeckelt (analog zum SOL/USDC-Block oben) —
                        // sonst swappt dieser Ratio-Pre-Swap mehr USDC in tokenA, als Schritt 5
                        // (depositStandard) später überhaupt einzahlen darf, und der Überschuss
                        // bleibt als ungedeckte Token-Position (Kursrisiko) im Wallet liegen.
                        const swapCap    = (!skipCap && CLEANUP_MAX_DEPOSIT > 0) ? CLEANUP_MAX_DEPOSIT : Infinity;
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
    if (!skipCap && CLEANUP_MIN_DEPOSIT > 0 && walletUsdc < CLEANUP_MIN_DEPOSIT) {
        return;
    }
    const depositUsdc = (!skipCap && CLEANUP_MAX_DEPOSIT > 0) ? Math.min(walletUsdc, CLEANUP_MAX_DEPOSIT) : walletUsdc;
    if (depositUsdc < walletUsdc) {
        console.log(`[cleanup:invest] Max-Einzahlung aktiv: ${depositUsdc.toFixed(2)} USDC von ${walletUsdc.toFixed(2)} USDC (Cap: ${CLEANUP_MAX_DEPOSIT} USDC)`);
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
async function _investVolatilePair(targetPool, db, keypair, connection, { skipCap = false } = {}) {
    const allPools     = config.pools.all;
    const tokenASymbol = targetPool.pair.split('/')[0];
    const tokenBSymbol = targetPool.pair.split('/')[1];
    const tokenADef    = { mint: targetPool.tokenA, decimals: targetPool.decimalsA, symbol: tokenASymbol };
    const tokenBDef    = { mint: targetPool.tokenB, decimals: targetPool.decimalsB, symbol: tokenBSymbol };
    const solIsPoolToken = targetPool.tokenA === WSOL_MINT || targetPool.tokenB === WSOL_MINT;

    // ─── 1. Fremd-Tokens → USDC ────────────────────────────────────────────
    const foreignTokens = getRelevantTokens(allPools).filter(t =>
        t.mint !== targetPool.tokenA && t.mint !== targetPool.tokenB
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
    if (!skipCap && CLEANUP_MIN_DEPOSIT > 0 && totalUsd < CLEANUP_MIN_DEPOSIT) {
        return;
    }

    // ─── 5. CLMM-Ratio-Ziel, Defizite, USDC proportional verteilen ────────
    const targetAUsd      = totalUsd * clmmPctA / 100;
    const targetBUsd      = totalUsd * clmmPctB / 100;
    const deficitAUsd     = Math.max(0, targetAUsd - walletAUsd);
    const deficitBUsd     = Math.max(0, targetBUsd - walletBUsd);
    const totalDeficitUsd = deficitAUsd + deficitBUsd;

    if (walletUsdc >= MIN_USDC_AMOUNT && totalDeficitUsd > 0) {
        const cappedUsdc = (!skipCap && CLEANUP_MAX_DEPOSIT > 0) ? Math.min(walletUsdc, CLEANUP_MAX_DEPOSIT) : walletUsdc;
        if (cappedUsdc < walletUsdc) {
            console.log(`[cleanup:invest] ${targetPool.pair}: Max-Einzahlung aktiv: USDC-Budget ${cappedUsdc.toFixed(2)} von ${walletUsdc.toFixed(2)} USDC (Cap: ${CLEANUP_MAX_DEPOSIT} USDC)`);
        }
        const useUsdc  = Math.min(cappedUsdc, totalDeficitUsd);
        const usdcForA = useUsdc * (deficitAUsd / totalDeficitUsd);
        const usdcForB = useUsdc * (deficitBUsd / totalDeficitUsd);

        if (usdcForA >= MIN_USDC_AMOUNT) {
            console.log(`[cleanup:invest] ${usdcForA.toFixed(2)} USDC → ${tokenASymbol}`);
            await swapTo(USDC_TOKEN, usdcForA, targetPool.tokenA, targetPool.decimalsA, tokenASymbol, keypair, connection, targetPool.id);
        }
        if (usdcForB >= MIN_USDC_AMOUNT) {
            console.log(`[cleanup:invest] ${usdcForB.toFixed(2)} USDC → ${tokenBSymbol}`);
            await swapTo(USDC_TOKEN, usdcForB, targetPool.tokenB, targetPool.decimalsB, tokenBSymbol, keypair, connection, targetPool.id);
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
    await deposit(targetPool, null, keypair, db, getAdapter(targetPool), { note: 'cleanup volatilePair', quotePrice });
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

const db         = openDatabase();
syncPools(db, config.pools.all);
const keypair    = getKeypair();
const connection = getConnection();

const SOL_MIN_FLOOR     = 0.01; // Absolutes Minimum – unter diesem Wert auch Cleanup nicht sicher
// Auslöseschwelle für das Auffüllen — seit 2026-07-30 der zentrale Invest-Puffer
// (Reserve + 0,05) statt der festen 0,11. Die Konstante schützt hier doppelt: sie
// löst das Topup am Laufanfang aus UND begrenzt weiter unten die Cross-Swaps
// (maxSwappable), damit ein Swap das Wallet nicht unter den Puffer drückt.
// Ziel-Wert kommt zentral aus lib/sol-topup.js (eine Quelle für alle Topup-Pfade).
const SOL_TOPUP_TRIGGER = INVEST_SOL_COMFORT;

// Lock sicherstellen: auch bei SIGTERM und ungefangenen Exceptions
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { releaseLock(); process.exit(0); });
// Ein ungefangener Fehler kann den Lauf MITTEN in einer Kapitalbewegung beenden —
// die Transaktion ist dann on-chain, die Buchung fehlt (Vorfall 2026-08-15, 131,65 USDC
// Phantomgewinn). Das darf nicht stumm passieren. Der Abgleich beim nächsten Lauf
// (lib/capital-reconcile.js) repariert die Buchung; diese Meldung sagt, dass es nötig war.
// Der Exit-Code MUSS 1 bleiben — der Cron-Wrapper wertet ihn aus. Deshalb sofort
// process.exitCode setzen und erst danach die Meldung rausschicken: der offene
// fetch hält den Event-Loop am Leben, bis er durch ist, der Timer ist nur die
// Notbremse, falls Nexus hängt.
process.on('uncaughtException', (err) => {
    releaseLock();
    console.error('[cleanup] uncaughtException:', err.message);
    process.exitCode = 1;
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

acquireLock();

try {
    console.log('[cleanup] Start:', new Date().toISOString());

    // Kapitalflüsse gegen die Chain abgleichen, BEVOR irgendetwas entschieden oder
    // bewegt wird: eine nicht gebuchte Einzahlung verfälscht capital_usdc und damit
    // die Kapital-Guards, die weiter unten über Investitionen entscheiden.
    // Ein Fehler hier darf den Cleanup nicht aufhalten — der Abgleich ist eine
    // Korrektur, kein Tor.
    try {
        const res = await reconcileCapitalFlows(db, {
            poolsById:  new Map(config.pools.all.map(p => [p.id, p])),
            connection,
            log:        msg => console.log(msg),
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
    await ensureWalletSol(db, keypair, connection, {
        minSol:    SOL_TOPUP_TRIGGER,
        targetSol: SOL_TOPUP_TARGET,
        log:       msg => console.log('[cleanup] ' + msg),
    });

    if (CLEANUP_MODE === 'ranking') {
        await runCleanupByRanking(db, keypair, connection);
    } else if (CLEANUP_MODE.startsWith('pool:')) {
        const targetPoolId = CLEANUP_MODE.slice(5);
        await runCleanupInvestPool(targetPoolId, db, keypair, connection, { skipCap: true });
    } else {
        console.log(`[cleanup] ${t('cli.cl.unknown_mode', { mode: CLEANUP_MODE })}`);
    }

    // Dust-Sweep: kleine bekannte Pool-Token-Reste → USDC. Läuft unabhängig von
    // der Invest-Entscheidung, damit Reste auch in Stunden ohne investierbaren
    // Pool nicht dauerhaft im Wallet liegen bleiben. Über Settings abschaltbar.
    if (CLEANUP_DUST_ENABLED) {
        await sweepDust(db, keypair, connection);
    } else {
        console.log(`[cleanup:dust] ${t('cli.cl.dust_disabled')}`);
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
    const streak = recordFailure('cleanup');
    const FAIL_THRESHOLD = 3;
    if (streak >= FAIL_THRESHOLD) {
        await notify.error('cleanup', err);
    } else {
        console.warn(`[cleanup] ${t('cli.cl.alert_suppressed', { streak, max: FAIL_THRESHOLD })}`);
    }
    process.exit(1);
} finally {
    releaseLock();
    db.close();
}
