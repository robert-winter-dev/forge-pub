/**
 * FORGE Liquidity – Haupt-Loop
 *
 * Ablauf pro Iteration (CHECK_INTERVAL_MS):
 *   Für jeden aktiven Pool:
 *     1. Pool-Stats abrufen (stündlich)
 *     2. Offene Position prüfen / neue öffnen
 *     3. Range-Status prüfen
 *     4. Bei Out-of-Range: Rebalancing (wenn aktiviert + Limit nicht erreicht)
 *     5. Fees claimen (wenn Intervall abgelaufen)
 *     6. Portfolio-Snapshot
 *     7. APR/TVL-Alerts prüfen
 *   Dashboard exportieren (EXPORT_INTERVAL_MS)
 *
 * Stopp: SIGTERM → graceful shutdown (laufende TX abwarten, dann beenden)
 *
 * Wichtig:
 *   - Jeder Pool-Fehler wird isoliert — der Bot läuft bei Einzelfehlern weiter
 *   - NIEMALS kill -9, stopp ausschließlich via systemctl oder SIGTERM
 *   - Zielkapital wird aus der letzten DB-Position gelesen (capital_usdc); Fallback: Wallet-Balance
 */

import { config, loadPools, updatePoolRangeOverride, getCleanupMaxDepositFromEnv, getCleanupMinDepositFromEnv, isPoolEnabled, setPoolActive, setPoolEnabled, resetPoolSettingsPreservingRisk } from '../lib/config.js';
import { openDatabase, syncPools, getOpenPosition, insertPosition, closePosition,
         insertPoolStats, getPoolStats, insertFeeHistory, insertRebalanceHistory,
         getMinutesSinceLastRebalance,
         insertTransaction, insertNotification, insertVolumeCandles,
         prunePortfolioHistory, prunePositionSnapshots, pruneRebalanceHistory,
         updatePositionCapital, updatePositionHodl, setPositionHwmBaseAdjustment,
         insertCapitalFlow, clearPositionSnapshots,
         insertAdvisorDecision, pruneAdvisorDecisions, kvGet, kvSet } from '../lib/db.js';
import { getAdapter }      from '../lib/pool-adapter/index.js';
import { calculateRange }  from '../lib/range.js';
import { analyzePool, estimateRebalanceCost, CANDIDATE_RANGES, getPoolTypeConfig } from '../lib/range-advisor.js';
import { getKeypair, getSolBalance, getSolBalanceFresh, getUsdcBalance, getUsdcBalanceFresh, assertSufficientSol, getUsableSolBalance, getTokenBalance, getTokenBalanceFresh, getUsableSolBalanceFresh, getConnection, getTxFee } from '../lib/wallet.js';
import { swapTokens } from '../lib/swap.js';
import * as notify         from '../lib/notify.js';
import { isCleanupRunning, isManualLocked, acquireRebalanceLock, releaseRebalanceLock, checkAndClearForceRebalanceFlag, acquireBotOpLock, releaseBotOpLock, setRebalancePendingFlag, clearRebalancePendingFlag, waitForCleanupToFinish, acquireSlLock, releaseSlLock } from '../lib/cleanup-lock.js';
import { ensureWalletSol, ensureInvestCapableSol, INVEST_SOL_COMFORT, SOL_TOPUP_TARGET } from '../lib/sol-topup.js';
import { shouldTriggerScoreLimit, checkScoreLimitWarning, executeScoreLimit, resumePendingScoreLimitExecutions } from '../lib/score-limit.js';
import { executeSwapStep, executeTransferStep } from '../lib/exit-finalizer.js';
import { shouldTriggerRankingExit, checkRankingExitWarning, executeRankingExit, resumePendingRkExecutions } from '../lib/ranking-exit.js';
import { shouldTriggerTs, executeTs, resumePendingTsExecutions, updateHwm, processHwmResetIfRequested, readMinimumValue, clearMinimumValue } from '../lib/trailing-stop.js';
import { shouldTriggerTvlProtection, executeTvlProtection, resumePendingTvlExecutions } from '../lib/tvl-protection.js';
import { processPoolRetirements, resumePendingRetireExecutions } from '../lib/pool-retirement.js';
import { checkClmmRatio, CLMM_RATIO_MAX_PCT, getTokenUsdPrice } from '../lib/deposit-lib.js';
import { assertTypeInvariants } from '../lib/invariants.js';
import { getLatestWalletBalance } from '../lib/wallet-monitor-client.js';
import { syncDashboard }   from '../lib/sync.js';
import {
    writePositionSnapshotFromState, writePortfolioSnapshot, writeFreshWalletSnapshot,
    refreshAfterAction,
} from '../lib/refresh-state.js';
import { todayTz, midnightTzMs, FORGE_TZ } from '../../../core/config.js';
// PnL ausschließlich über die zentrale FORGE-Lib (Single Source of Truth).
import { lpValueAt, pnlForPeriod } from '../../../lib/pnl.js';
import {
    PoolUtil,
    PriceMath,
    PDAUtil,
    ORCA_WHIRLPOOL_PROGRAM_ID,
} from '@orca-so/whirlpools-sdk';
import { PublicKey }       from '@solana/web3.js';
import BN                  from 'bn.js';
import Decimal             from 'decimal.js';
import Database            from 'better-sqlite3';
import { resolve, dirname, join } from 'path';
import { fileURLToPath }   from 'url';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
import { refreshPythPrices } from '../lib/pyth-prices.js';
import { PATHS, botPidPath } from '../../../config/paths.js';
import { reasonPayload } from '../../../lib/pool-reason.js';

const __bot_dirname = dirname(fileURLToPath(import.meta.url));

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT  = 'So11111111111111111111111111111111111111112';

// ─── Pool-Settings (ForgeSettings DB) ────────────────────────────────────────

const SETTINGS_DB_PATH = PATHS.settingsDb;

// ─── PID-Lockfile – verhindert mehrere gleichzeitige Instanzen ───────────────

const BOT_PID_FILE = botPidPath('liquidity');

(function enforceSingleInstance() {
    if (existsSync(BOT_PID_FILE)) {
        try {
            const existingPid = parseInt(readFileSync(BOT_PID_FILE, 'utf8').trim(), 10);
            if (Number.isFinite(existingPid) && existingPid !== process.pid) {
                try {
                    process.kill(existingPid, 0); // wirft ESRCH wenn Prozess tot
                    console.error(
                        `[bot] ⛔  Bereits eine Instanz aktiv (PID ${existingPid}).` +
                        ` Starte nicht – stoppe zuerst via: kill ${existingPid}`
                    );
                    process.exit(1);
                } catch (e) {
                    if (e.code !== 'ESRCH') throw e;
                    console.warn(`[bot] Veraltete PID-Datei (PID ${existingPid} nicht mehr aktiv) – wird überschrieben.`);
                }
            }
        } catch (e) {
            if (e.code !== 'ENOENT') console.warn(`[bot] PID-Datei-Check fehlgeschlagen: ${e.message}`);
        }
    }
    writeFileSync(BOT_PID_FILE, String(process.pid), 'utf8');
    process.on('exit', () => { try { unlinkSync(BOT_PID_FILE); } catch {} });
})();

function _getFeeClaimSettings(poolId) {
    try {
        const sdb = new Database(SETTINGS_DB_PATH, { readonly: true, fileMustExist: true });
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        sdb.close();
        if (!row) return null;
        return JSON.parse(row.settings).autoCompound ?? null;
    } catch {
        return null;
    }
}

function isAutoCompoundEnabled(poolId) {
    return _getFeeClaimSettings(poolId)?.enabled !== false;
}

/**
 * Prüft und führt den Trailing Stop für einen Pool aus.
 * Wird pro Zyklus zweimal aufgerufen (vor und nach processPool) — der zweite
 * Aufruf arbeitet auf dem gerade geschriebenen Snapshot und spart damit den
 * Zyklus Verzug, den der Check vorher systematisch hatte.
 *
 * @returns {Promise<boolean>} true wenn der Exit lief oder der Pool übersprungen
 *          werden soll (Fehlerfall) — der Aufrufer bricht die Pool-Iteration dann ab.
 */
async function _trailingStopCheck(pool) {
    try {
        if (!shouldTriggerTs(pool, db)) return false;
        console.log(`[bot:${pool.id}] Trailing-Stop-Trigger erkannt – starte Exit`);
        await executeTs(pool, db);
        // Pool wurde deaktiviert – Dashboard sofort aktualisieren.
        await refreshAfterAction(db, { log: msg => console.log(`[bot:${pool.id}] ${msg}`) });
        lastExport.ts = Date.now();
        return true;
    } catch (err) {
        console.error(`[bot:${pool.id}] Trailing-Stop fehlgeschlagen: ${err.message}`);
        return true;
    }
}

// Setzt Pool-Settings beim Öffnen einer neuen Position zurück (nach Pool-Close).
// tvlProtection und trailingStop bleiben erhalten, alles andere fällt auf
// ForgeSettings-Defaults zurück – siehe resetPoolSettingsPreservingRisk() in lib/config.js.
function _resetPoolSettings(poolId) {
    resetPoolSettingsPreservingRisk(poolId, `[bot:${poolId}]`);
}

// Stellt sicher dass beim Rebalancing Auto-Compounding auf 100 % gesetzt ist.
// (Rebalancing = Pool bleibt aktiv, Settings bleiben erhalten – nur autoCompound wird erzwungen.)
function _ensureAutoCompoundEnabled(poolId) {
    try {
        const sdb = new Database(SETTINGS_DB_PATH, { fileMustExist: false });
        sdb.exec(`CREATE TABLE IF NOT EXISTS pool_settings (
            bot_id  TEXT NOT NULL,
            pool_id TEXT NOT NULL,
            settings TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (bot_id, pool_id)
        )`);
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        const current = row ? (JSON.parse(row.settings) ?? {}) : {};
        current.autoCompound = { ...(current.autoCompound ?? {}), enabled: true, fraction: 100 };
        sdb.prepare(`
            INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES (?, ?, ?)
            ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
        `).run(config.botId, poolId, JSON.stringify(current));
        sdb.close();
        console.log(`[bot:${poolId}] Auto-Compound auf 100 % gesetzt (settings.db).`);
    } catch (err) {
        console.warn(`[bot:${poolId}] _ensureAutoCompoundEnabled fehlgeschlagen: ${err.message}`);
    }
}

// ─── Zustand ──────────────────────────────────────────────────────────────────

let running = true;
const db    = openDatabase();
kvSet(db, 'bot_state', 'running');

// ── Zentrale Preisdatenbank ──────────────────────────────────────────────────
const PRICE_PAIR_MAP = { 'cbBTC/USDC': 'BTC/USDC' };
let _pricesDb = null;
function writeCentralPrice(pool, price, ts) {
    try {
        if (!_pricesDb) {
            const p = PATHS.pricesDb;
            _pricesDb = new Database(p);
            _pricesDb.pragma('journal_mode = WAL');
        }
        _pricesDb.prepare(
            'INSERT OR IGNORE INTO price_history (pair, price, source, recorded_at) VALUES (?, ?, ?, ?)'
        ).run(PRICE_PAIR_MAP[pool.pair] ?? pool.pair, price, config.botId, ts);
    } catch (e) {
        console.warn(`[bot] Zentrale prices.db nicht beschreibbar: ${e.message}`);
    }
}

/** In-Memory-Timestamps für Intervall-Checks (pro Pool-ID) */
const lastStatsFetch    = new Map();   // pool_id → timestamp
const lastFeeClaim      = new Map();   // pool_id → timestamp
const lastSnapshot      = new Map();   // pool_id → timestamp
const lastAprAlert      = new Map();   // pool_id → timestamp
const lastExport        = { ts: 0 };
const outOfRangeSince   = new Map();   // pool_id → timestamp (oder null)
const wasOutOfRange     = new Map();   // pool_id → boolean (für backInRange-Alert)

// Stündliches Pool-Stats-Intervall
const STATS_INTERVAL_MS = 60 * 60 * 1000;

// ─── Startup-Reconciliation ───────────────────────────────────────────────────

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/**
 * Gleicht DB und Chain ab: prüft für jeden aktiven Pool ohne offene DB-Position,
 * ob das Wallet ein Whirlpool-Position-NFT für diesen Pool hält.
 * Falls ja: Position wird automatisch in die DB eingetragen.
 *
 * Schützt vor dem Fall, dass deposit.js den TX erfolgreich abschickt,
 * aber vor dem DB-Insert mit einem Fehler abbricht.
 */
async function reconcilePositions(keypair, activePools) {
    const missingPools = activePools.filter(p => !getOpenPosition(db, p.id));
    if (missingPools.length === 0) return;

    const connection = getConnection();

    // Alle Standard-SPL-NFT-Accounts laden (amount=1, decimals=0)
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        keypair.publicKey, { programId: TOKEN_PROGRAM_ID }
    );
    const nftMints = tokenAccounts.value
        .filter(a => {
            const amt = a.account.data.parsed.info.tokenAmount;
            return amt.uiAmount === 1 && amt.decimals === 0;
        })
        .map(a => new PublicKey(a.account.data.parsed.info.mint));

    if (nftMints.length === 0) return;

    // Position-PDAs ableiten und alle auf einmal holen
    const posPdas    = nftMints.map(m => PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, m).publicKey);
    const posInfos   = await connection.getMultipleAccountsInfo(posPdas);

    for (let i = 0; i < posInfos.length; i++) {
        const info = posInfos[i];
        if (!info || info.data.length < 100) continue;

        const d            = info.data;
        const whirlpoolStr = new PublicKey(d.slice(8, 40)).toBase58();
        const pool         = missingPools.find(p => p.address === whirlpoolStr);
        if (!pool) continue;

        // Position-Daten aus Raw-Bytes
        const tickLower  = d.readInt32LE(88);
        const tickUpper  = d.readInt32LE(92);
        const liqLow     = d.readBigUInt64LE(72);
        const liqHigh    = d.readBigUInt64LE(80);
        const liquidity  = (liqHigh === 0n ? liqLow : liqHigh * (2n ** 64n) + liqLow).toString();
        const nftMint    = nftMints[i].toBase58();
        const priceLower = Math.pow(1.0001, tickLower);
        const priceUpper = Math.pow(1.0001, tickUpper);

        // Best-effort HODL-Baseline. Primär aus dem lokalen pool_stats-Cache; ist der
        // leer, wird der Preis LIVE on-chain geholt (gleiche Quelle wie beim regulären
        // Öffnen). Der Cache ist bei einer frisch installierten Instanz beim ersten
        // Reconcile-Lauf noch leer — der erste Stats-Fetch läuft erst Sekunden später.
        //
        // Warum das kritisch ist: bleibt capital_usdc NULL (oder 0), setzt lib/pnl.js
        // den Kapital-Anker auf 0 und meldet den KOMPLETTEN Positionswert als Gewinn.
        // Befund forge-pub1 2026-07-27: Neuinstallation mit wiederverwendetem Wallet →
        // 2 Positionen aus der Chain adoptiert → Phantom-PnL von +90 USDC im Dashboard.
        let capitalUsdc = null, hodlTokenA = null, hodlTokenB = null, hodlPriceUsd = null;
        const stats      = getPoolStats(db, pool.id, 1);
        let priceForCalc = stats[0]?.price > 0 ? stats[0].price : 0;

        if (priceForCalc === 0) {
            try {
                const live = await getAdapter(pool).getPoolStats(pool);
                if (live?.price > 0) priceForCalc = live.price;
            } catch (err) {
                console.warn(`[bot:${pool.id}] Reconciliation: Live-Preis nicht abrufbar – ${err.message}`);
            }
        }

        if (priceForCalc > 0) {
            const liquidityBN = new BN(liquidity);
            const sqrtP   = PriceMath.priceToSqrtPriceX64(new Decimal(priceForCalc), pool.decimalsA, pool.decimalsB);
            const sqrtL   = PriceMath.tickIndexToSqrtPriceX64(tickLower);
            const sqrtU   = PriceMath.tickIndexToSqrtPriceX64(tickUpper);
            const amounts = PoolUtil.getTokenAmountsFromLiquidity(liquidityBN, sqrtP, sqrtL, sqrtU, false);
            hodlTokenA   = new Decimal(amounts.tokenA.toString()).div(Math.pow(10, pool.decimalsA)).toNumber();
            hodlTokenB   = new Decimal(amounts.tokenB.toString()).div(Math.pow(10, pool.decimalsB)).toNumber();
            hodlPriceUsd = priceForCalc;
            capitalUsdc  = _calcUsdValue(pool, db, priceForCalc, hodlTokenA, hodlTokenB);
        }

        // Zweite Verteidigungslinie: NIEMALS einen unbrauchbaren Einstand schreiben.
        // _calcUsdValue liefert bei volatilePair-Pools 0, wenn der Quote-Preis fehlt
        // (_getQuotePrice greift ebenfalls auf den noch leeren Cache zu) — eine 0 wäre
        // schlimmer als NULL, weil sie wie ein echter Einstand aussieht. Explizit auf
        // null normalisieren; lib/pnl.js ankert solche Sessions am ersten beobachteten
        // Wert statt den ganzen Positionswert als Gewinn auszuweisen.
        if (!Number.isFinite(capitalUsdc) || capitalUsdc <= 0) capitalUsdc = null;

        insertPosition(db, {
            poolId:      pool.id,
            nftMint,
            tickLower,
            tickUpper,
            priceLower,
            priceUpper,
            liquidity,
            capitalUsdc,
            hodlTokenA,
            hodlTokenB,
            hodlPriceUsd,
            openTx:      null,
            openedAt:    Date.now(),
        });

        // Eine real aus der Chain wiederhergestellte Position beweist committetes Kapital –
        // eine verbleibende Sperre (enabled=false, z.B. vom Fork-Export bei einem Reinstall
        // mit wiederverwendetem Wallet erzwungen, siehe tools/pub-export/sanitize-pools-
        // config.js) würde nur den irreführenden Zustand "aktiv + gesperrt" erzeugen, ohne
        // noch etwas zu verhindern (das Kapital steckt schon drin). Befund forge-pub1 2026-07-27.
        if (!isPoolEnabled(pool)) {
            try {
                setPoolEnabled(pool.id, true, reasonPayload('reason.reconciliation'));
                console.log(`[bot] Reconciliation: Pool ${pool.id} war gesperrt (enabled=false) – automatisch freigegeben (echte Position vorhanden).`);
            } catch (err) {
                console.error(`[bot] Reconciliation: setPoolEnabled fehlgeschlagen für ${pool.id}: ${err.message}`);
            }
        }

        const capNote = capitalUsdc == null
            ? ' Einstandskapital NICHT ermittelbar (kein Preis verfügbar) – PnL dieses Pools zählt ab jetzt, nicht ab dem echten Einstieg.'
            : ` Einstandskapital rekonstruiert: ${capitalUsdc.toFixed(2)} USDC.`;
        console.log(`[bot] ⚠ Reconciliation: Position ${pool.id} war nicht in DB – aus Chain wiederhergestellt (NFT=${nftMint}).${capNote}`);
        await notify.error(
            pool.displayPair ?? pool.pair,
            new Error(`Reconciliation: Position nicht in DB gefunden – automatisch aus Chain rekonstruiert. NFT=${nftMint}.${capNote} Bitte prüfen.`)
        );
    }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

/**
 * Wiederholt `fn` bei Fehlschlag mit fester Pause, bevor endgültig aufgegeben wird.
 * Nur für den einmaligen Startup-Balance-Check gedacht (kein "nächster Zyklus" wie
 * im Hauptloop, der transiente RPC-Hänger sonst von selbst nachholen würde) — reitet
 * kurze Helius-Ausfälle (503/504/520) aus, statt den ganzen Bot-Start abzubrechen.
 *
 * Fenster: 20 Versuche × 30 s ≈ 10 Min Überbrückung. Bewusst so großzügig, weil ein
 * typischer Helius-5xx-Ausfall Minuten dauert (23.07.2026: ~9 Min); ein 15-s-Fenster
 * (alter Default 3×5 s) war wirkungslos und ließ den Bot in ein Crash-Restart-Loop mit
 * Telegram-Fehlalarm laufen, obwohl kein SOL-Problem vorlag. 1 getBalance-Call/30 s ist
 * rate-limit-unkritisch. Bei einem echten, dauerhaften Wallet/RPC-Problem bricht der Start
 * nach ~10 Min immer noch sauber ab. Siehe Memory `project_helius_outage_handling`.
 */
async function retryStartupCall(fn, label, attempts = 20, delayMs = 30_000) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (i < attempts) {
                console.warn(`[bot] ${label} fehlgeschlagen (Versuch ${i}/${attempts}): ${err.message} – retry in ${delayMs / 1000}s`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    throw lastErr;
}

// Marktdaten (TVL/Volumen/APR) für inaktive Pools – unabhängig vom Wallet-Guthaben,
// deshalb aus der mainLoop-Iteration herausgezogen und auch aus der Einzahlungs-
// Warteschleife in startup() aufrufbar (Fund forge-pub2 2026-08-11: ohne offene
// Position lief dieser Code nie, Pool Metriken zeigten dauerhaft "No data").
async function fetchInactivePoolStats(pools) {
    for (const pool of pools) {
        if (!running) break;
        const now = Date.now();
        if (now - (lastStatsFetch.get(pool.id) ?? 0) >= STATS_INTERVAL_MS) {
            try {
                const adapter = getAdapter(pool);
                const stats   = await adapter.getPoolStats(pool);
                const geckoNull = stats.tvlUsd == null || stats.volume24hUsd == null || stats.apr24h == null;
                const lastKnown = geckoNull
                    ? db.prepare(`SELECT tvl_usd, volume_24h_usd, apr_24h FROM pool_stats
                                   WHERE pool_id = ? AND tvl_usd > 0
                                   ORDER BY recorded_at DESC LIMIT 1`).get(pool.id) ?? null
                    : null;
                if (geckoNull) console.warn(`[gecko:${pool.id}] Fallback auf letzten bekannten Wert (gecko nicht verfügbar)`);
                insertPoolStats(db, {
                    poolId:           pool.id,
                    price:            stats.price,
                    tvlUsd:           stats.tvlUsd           ?? lastKnown?.tvl_usd        ?? 0,
                    volume24hUsd:     stats.volume24hUsd     ?? lastKnown?.volume_24h_usd ?? 0,
                    apr24h:           stats.apr24h           ?? lastKnown?.apr_24h        ?? 0,
                    liquidityInRange: stats.liquidityInRange ?? null,
                    fees24hUsd:       stats.fees24hUsd       ?? null,
                });
                insertVolumeCandles(db, pool.id, stats.volumeCandles ?? []);
                lastStatsFetch.set(pool.id, now);
                console.log(`[bot:${pool.id}] Stats (inaktiv): Preis ${stats.price?.toFixed(2)}, APR ${stats.apr24h?.toFixed(2)}%`);
            } catch (err) {
                console.warn(`[bot:${pool.id}] Stats-Abfrage (inaktiv) fehlgeschlagen: ${err.message}`);
            }
        }
    }
}

async function startup() {
    console.log('[bot] Liquidity startet...');

    // Aktives Profil (Phase 2 Profil-Refactor, ab Phase-3-Hot-Reload aus .env)
    const { getActiveProfile } = await import('../lib/economic-scorer/config.js');
    console.log(`[bot] Aktives Profil: ${getActiveProfile()} (live aus .env, hot-reloadable)`);

    // DB-Schema vorbereitet, Pools eintragen
    syncPools(db, config.pools.all);

    const keypair = getKeypair();

    // Startup-Check: Wallet-Balance (mit Retry gegen transiente Helius-5xx)
    let solBalance  = await retryStartupCall(() => getSolBalance(keypair.publicKey), 'SOL-Balance');
    let usdcBalance = await retryStartupCall(() => getUsdcBalance(keypair.publicKey), 'USDC-Balance');
    console.log(`[bot] Wallet: ${keypair.publicKey.toBase58()}`);
    console.log(`[bot] Balance: ${solBalance.toFixed(4)} SOL | ${usdcBalance.toFixed(2)} USDC`);

    const SOL_MIN_FLOOR = 0.01; // Absolutes Minimum – unter diesem Wert ist auch Claimen unsicher

    // Frisches (noch nie befülltes) Wallet ist ein Normalfall, kein Fehler – z.B. direkt
    // nach der Installation, bevor der Nutzer SOL/USDC überwiesen hat. Statt zu crashen
    // (systemd hätte das als on-failure gewertet und den Bot alle ~45s neu gestartet,
    // im Dashboard sichtbar als endlos "Activating") wartet der Bot hier und startet
    // automatisch durch, sobald genug SOL eingegangen ist.
    if (solBalance < SOL_MIN_FLOOR) {
        console.log(
            `[bot] SOL-Balance (${solBalance.toFixed(4)}) unter absolutem Minimum (${SOL_MIN_FLOOR} SOL) – ` +
            `Wallet noch nicht befüllt. Bot wartet auf Einzahlung.`
        );
        await notify.info(
            'Bot-Start',
            `Wallet ${keypair.publicKey.toBase58()} hat noch kein SOL (mind. ${SOL_MIN_FLOOR} SOL nötig). ` +
            `Der Bot wartet und startet automatisch, sobald Guthaben eingeht.`
        ).catch(() => {});

        // Dashboard-Export + Marktdaten hängen nicht vom Wallet-Guthaben ab. Ohne
        // dies hier blieb der Export beim Warten auf die erste Einzahlung auf dem
        // letzten Shutdown-Stand stehen ('offline') und die Pool-Metriken-Tabelle
        // zeigte dauerhaft "No data", obwohl der Bot normal lief (forge-pub2,
        // 2026-08-11). Export zuerst (schnell, macht "Bot deaktiviert" sofort
        // richtig), Stats-Fetch danach (ratenlimitiert, kann bei vielen Pools
        // mehrere Minuten dauern) – dann bei jedem Poll erneut, analog zum
        // Zwischen-Export der regulären Zykluspause weiter unten ("In kurzen
        // Schritten warten").
        try {
            await syncDashboard(msg => console.log(`[bot] ${msg}`));
            lastExport.ts = Date.now();
        } catch (err) {
            console.error(`[bot] Export während Wartezeit fehlgeschlagen: ${err.message}`);
        }
        await fetchInactivePoolStats(config.pools.all.filter(p => !p.active));

        const WAIT_POLL_MS = 5 * 60 * 1000; // 5 Min – Einzahlung muss nicht sekundengenau erkannt werden
        while (solBalance < SOL_MIN_FLOOR) {
            await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS));
            try {
                solBalance = await getSolBalance(keypair.publicKey);
            } catch (err) {
                console.warn(`[bot] SOL-Balance-Check fehlgeschlagen (warte weiter): ${err.message}`);
            }
            try {
                await syncDashboard();
                lastExport.ts = Date.now();
            } catch (err) {
                console.warn(`[bot] Export während Wartezeit fehlgeschlagen: ${err.message}`);
            }
            await fetchInactivePoolStats(config.pools.all.filter(p => !p.active));
        }
        usdcBalance = await getUsdcBalance(keypair.publicKey).catch(() => usdcBalance);
        console.log(`[bot] Einzahlung erkannt: ${solBalance.toFixed(4)} SOL | ${usdcBalance.toFixed(2)} USDC – Bot startet durch.`);
    }

    if (solBalance < config.solReserve) {
        console.log(
            `[bot] WARNUNG: SOL-Balance (${solBalance.toFixed(4)}) unter Reserve (${config.solReserve} SOL). ` +
            `Claimen erlaubt, Reinvest + Rebalancing gesperrt.`
        );
    }

    // Timestamps aus DB initialisieren (damit Intervalle korrekt sind nach Neustart)
    // Nur non-zero Einträge berücksichtigen, sonst halten vergiftete 0-Werte
    // (z.B. nach Gecko-429) den Bot davon ab, neue Stats zu holen.
    for (const pool of config.pools.all) {
        const row = db.prepare(
            `SELECT recorded_at FROM pool_stats WHERE pool_id = ? AND tvl_usd > 0 ORDER BY recorded_at DESC LIMIT 1`
        ).get(pool.id);
        lastStatsFetch.set(pool.id, row?.recorded_at ?? 0);

        const lastClaim = db.prepare(
            `SELECT MAX(claimed_at) as ts FROM fee_history WHERE pool_id = ?`
        ).get(pool.id);
        lastFeeClaim.set(pool.id, lastClaim?.ts ?? 0);

        const snap = db.prepare(
            `SELECT MAX(recorded_at) as ts FROM portfolio_history`
        ).get();
        lastSnapshot.set(pool.id, snap?.ts ?? 0);
    }

    // Reconciliation: offene On-Chain-Positionen die nicht in DB stehen aufspüren und eintragen
    try {
        await reconcilePositions(keypair, config.pools.active);
    } catch (err) {
        console.error(`[bot] Reconciliation fehlgeschlagen (nicht kritisch): ${err.message}`);
    }

    // Unvollständige Score-Limit-Ausführungen aus letztem Crash fortsetzen
    try {
        await resumePendingScoreLimitExecutions(db);
    } catch (err) {
        console.error(`[bot] Score-Limit-Resume fehlgeschlagen (nicht kritisch): ${err.message}`);
    }

    // Unvollständige Ranking-Exit-Ausführungen aus letztem Crash fortsetzen
    try {
        await resumePendingRkExecutions(db);
    } catch (err) {
        console.error(`[bot] Ranking-Exit-Resume fehlgeschlagen (nicht kritisch): ${err.message}`);
    }

    // Unvollständige Trailing-Stop-Ausführungen aus letztem Crash fortsetzen
    try {
        await resumePendingTsExecutions(db);
    } catch (err) {
        console.error(`[bot] Trailing-Stop-Resume fehlgeschlagen (nicht kritisch): ${err.message}`);
    }

    // Unvollständige TVL-Schutz-Ausführungen aus letztem Crash fortsetzen
    try {
        await resumePendingTvlExecutions(db);
    } catch (err) {
        console.error(`[bot] TVL-Schutz-Resume fehlgeschlagen (nicht kritisch): ${err.message}`);
    }

    // Unvollständige Retirement-Exits (Premium-Rückstufung) fortsetzen
    try {
        await resumePendingRetireExecutions(db);
    } catch (err) {
        console.error(`[bot] Retirement-Exit-Resume fehlgeschlagen (nicht kritisch): ${err.message}`);
    }

    const openPools = db.prepare(
        `SELECT DISTINCT p.id, p.pair
         FROM positions pos
         JOIN pools p ON p.id = pos.pool_id
         WHERE pos.closed_at IS NULL`
    ).all();
    await notify.startup();
    console.log('[bot] Startup abgeschlossen.');

    // Sofortiger Dashboard-Export direkt nach dem Start, statt auf das Ende des
    // ersten Hauptschleifen-Durchlaufs zu warten. Der reguläre Export (unten in
    // mainLoop) läuft erst NACH einem vollständigen Durchlauf über alle Pools
    // (aktive + inaktive Stats, ratenlimitiert ~20s/Pool) — bei vielen Pools kann
    // das erste Mal mehrere Minuten dauern. Befund forge-pub1 2026-07-27: eine
    // frische Installation zeigte in dieser Zeitspanne "kein Guthaben, keine
    // offenen Pools" im Dashboard, obwohl Wallet und Positionen längst korrekt in
    // der DB standen — reiner Anzeige-Rückstand, kein Datenverlust. Auf dem Master
    // unauffällig (data.json existiert dort ohnehin schon aus dem letzten Lauf).
    try {
        await syncDashboard(msg => console.log(`[bot] ${msg}`));
    } catch (err) {
        console.error(`[bot] Initialer Dashboard-Export fehlgeschlagen (nicht kritisch): ${err.message}`);
    }
    lastExport.ts = Date.now();
}

// ─── Pool-Verarbeitung ────────────────────────────────────────────────────────

// ─── Bot weicht laufender manueller Aktion aus ────────────────────────────────
//
// Prioritätsmodell: Der Bot hat normalerweise Vorrang (manuelle Aktionen warten
// via waitForBotToFinish auf ihn). Läuft jedoch BEREITS eine manuelle Aktion
// (manual.lock von deposit/withdraw/close-and-reopen), weicht der Bot kurz aus —
// max. 3 Versuche à 2 s — und überspringt die Operation dann (nächster Tick holt
// sie nach). So mutiert nie Bot UND User gleichzeitig dieselbe Position.
//
// @returns {Promise<boolean>} true = frei, Operation darf laufen; false = manuelle
//                             Aktion hält an → Operation überspringen.
async function _yieldToManualAction(poolId, label) {
    if (!isManualLocked()) return true;
    for (let i = 1; i <= 3; i++) {
        await new Promise(r => setTimeout(r, 2_000));
        if (!isManualLocked()) return true;
        console.log(`[bot:${poolId}] Manuelle Aktion läuft – warte (${i}/3) vor ${label}…`);
    }
    console.log(`[bot:${poolId}] Manuelle Aktion hält an – ${label} übersprungen (nächster Tick).`);
    return false;
}

async function processPool(pool, adapter, preloadedState = null) {
    const now = Date.now();

    // ── 1. Pool-Stats (stündlich) ────────────────────────────────────────────
    if (now - (lastStatsFetch.get(pool.id) ?? 0) >= STATS_INTERVAL_MS) {
        try {
            const stats = await adapter.getPoolStats(pool);
            const geckoNull = stats.tvlUsd == null || stats.volume24hUsd == null || stats.apr24h == null;
            const lastKnown = geckoNull
                ? db.prepare(`SELECT tvl_usd, volume_24h_usd, apr_24h FROM pool_stats
                               WHERE pool_id = ? AND tvl_usd > 0
                               ORDER BY recorded_at DESC LIMIT 1`).get(pool.id) ?? null
                : null;
            if (geckoNull) console.warn(`[gecko:${pool.id}] Fallback auf letzten bekannten Wert (gecko nicht verfügbar)`);
            insertPoolStats(db, {
                poolId:           pool.id,
                price:            stats.price,
                tvlUsd:           stats.tvlUsd           ?? lastKnown?.tvl_usd        ?? 0,
                volume24hUsd:     stats.volume24hUsd     ?? lastKnown?.volume_24h_usd ?? 0,
                apr24h:           stats.apr24h           ?? lastKnown?.apr_24h        ?? 0,
                liquidityInRange: stats.liquidityInRange ?? null,
                fees24hUsd:       stats.fees24hUsd       ?? null,
            });
            insertVolumeCandles(db, pool.id, stats.volumeCandles ?? []);
            writeCentralPrice(pool, stats.price, now);
            lastStatsFetch.set(pool.id, now);

            // APR-Alert: seit 2026-07-29 Opt-in statt Opt-out (`aprAlertEnabled: true`
            // nötig). Vorher war er per Default an und musste pro Pool einzeln über
            // `aprAlertDisabled: true` abgeschaltet werden — inzwischen hatte jeder
            // einzelne bestehende Pool dieses Flag manuell gesetzt, ein klares Zeichen,
            // dass der Alert grundsätzlich nicht gebraucht wird (Nutzer-Feedback).
            // Cooldown via APR_ALERT_COOLDOWN_H, default 168h.
            // Nur EIN Kanal: notify.aprAlert() (→ Nexus, inkl. Pool-Name). Der frühere
            // zusätzliche insertNotification()-Eintrag (lokale DB) landete über export.js
            // ALS ZWEITER, redundanter Eintrag (ohne Pool-Name) in derselben Dashboard-
            // Glocke wie der Nexus-Eintrag — Diese Doppelung + der fehlende
            // Pool-Bezug mehrfach gemeldet (2026-06-28). Entfernt.
            if (pool.aprAlertEnabled && stats.apr24h !== null && stats.apr24h < config.alerts.aprThreshold) {
                const cooldownOk = now - (lastAprAlert.get(pool.id) ?? 0) >= config.alerts.aprAlertCooldownMs;
                if (cooldownOk) {
                    await notify.aprAlert(pool, stats.apr24h, config.alerts.aprThreshold);
                    lastAprAlert.set(pool.id, now);
                }
            }

            // TVL-Schwellwert-Aktion läuft jetzt über lib/tvl-protection.js
            // (zweistufiger Schutz mit Teil-/Voll-Abzug, Config aus settings.db).
            // Wird im Haupt-Loop vor dem Pool-Processing geprüft (höchste Priorität).
        } catch (err) {
            console.error(`[bot:${pool.id}] Pool-Stats Fehler: ${err.message}`);
        }
    }

    // ── 2. Position prüfen / öffnen ──────────────────────────────────────────
    let position = getOpenPosition(db, pool.id);

    if (!position) {
        // Benutzer-Sperre: gesperrte Pools (enabled=false) niemals neu eröffnen.
        // Defense-in-depth — eine offene Position kann nicht gesperrt werden, daher
        // greift dies nur falls active=true & enabled=false je inkonsistent auftreten.
        if (!isPoolEnabled(pool)) return;
        position = await _openNewPosition(pool, adapter);
        if (!position) return;
        // syncDashboard erfolgt bereits in _openNewPosition → refreshAfterAction
    }

    // ── 3. Position-State (aus Bulk-Fetch oder Einzelabruf als Fallback) ────────
    let state;
    if (preloadedState) {
        state = preloadedState;
    } else {
        try {
            state = await adapter.getPositionState(pool, position.nft_mint, {
                tickLowerIndex: position.tick_lower,
                tickUpperIndex: position.tick_upper,
            });
            _positionStateFailCount.delete(pool.id);
        } catch (err) {
            const fails = (_positionStateFailCount.get(pool.id) ?? 0) + 1;
            _positionStateFailCount.set(pool.id, fails);
            if (fails >= 2) {
                console.error(`[bot:${pool.id}] getPositionState Fehler (${fails}× in Folge): ${err.message}`);
                await notify.error(pool.displayPair ?? pool.pair, err);
            } else {
                console.warn(`[bot:${pool.id}] getPositionState Fehler (1/2 – warte auf Bestätigung im nächsten Zyklus): ${err.message}`);
            }
            return;
        }
    }

    // ── 3b. Force-Rebalance (manuell via ForgeSettings-UI) ──────────────────
    if (checkAndClearForceRebalanceFlag(pool.id)) {
        console.log(`[bot:${pool.id}] Manuelles Rebalancing via UI-Trigger.`);
        await _doRebalance(pool, position, state, adapter, 'manual');
        outOfRangeSince.delete(pool.id);
        wasOutOfRange.set(pool.id, false);
        position = getOpenPosition(db, pool.id);
        if (!position) return;
        // syncDashboard erfolgt bereits in _doRebalance → refreshAfterAction
        return;
    }

    // ── 4. Range-Status + Alerts ─────────────────────────────────────────────
    if (!state.inRange) {
        if (!outOfRangeSince.has(pool.id)) {
            outOfRangeSince.set(pool.id, now);
        }

        const minutesOOR = (now - outOfRangeSince.get(pool.id)) / 60_000;

        if (!wasOutOfRange.get(pool.id)) {
            wasOutOfRange.set(pool.id, true);
            await notify.outOfRange(pool, state.currentPrice, state.priceLower, state.priceUpper);
            // Nur eintragen wenn keine OOR-Notification für diesen Pool in den letzten 60 Min
            // (verhindert Duplikate nach Bot-Restart bei dauerhaft OOR-Position –
            //  wasOutOfRange ist in-memory, nach Restart immer false)
            const recentOOR = db.prepare(
                `SELECT id FROM notifications WHERE pool_id = ? AND message LIKE 'Position out of range%' AND (read = 0 OR created_at > ?) LIMIT 1`
            ).get(pool.id, Date.now() - 3_600_000);
            if (!recentOOR) {
                insertNotification(db, { poolId: pool.id, level: 'info', message: `Position out of Range – ${pool.pair}` });
            }
        }

        if (minutesOOR >= config.alerts.outOfRangeMinutes && config.rebalance.enabled && !pool.rebalanceDisabled) {
            await _doRebalance(pool, position, state, adapter);
            outOfRangeSince.delete(pool.id);
            wasOutOfRange.set(pool.id, false);
            position = getOpenPosition(db, pool.id); // neue Position nach Rebalancing
            if (!position) return;
            // syncDashboard + Snapshot erfolgen bereits in _doRebalance → refreshAfterAction.
            // Return: state stammt noch von der alten Position → kein Snapshot mit stale state.
            return;
        }
    } else {
        if (wasOutOfRange.get(pool.id)) {
            wasOutOfRange.set(pool.id, false);
            outOfRangeSince.delete(pool.id);
            // OOR-Episode beendet: ungelesene OOR-Notifications schließen damit das
            // Badge sofort verschwindet und die 60-Min-Sperre zurückgesetzt wird
            db.prepare(
                `UPDATE notifications SET read = 1 WHERE pool_id = ? AND message LIKE 'Position out of range%' AND read = 0`
            ).run(pool.id);
            const stats = getPoolStats(db, pool.id, 1);
            await notify.backInRange(pool, stats[0]?.price ?? 0);
        }

        // ── Proaktiver Drift-Trigger ─────────────────────────────────────────
        // Wenn pool.proactiveTrigger gesetzt ist (z.B. 0.75), wird Rebalancing
        // ausgelöst sobald der Preis 75% des Weges vom Mid zur Range-Grenze
        // zurückgelegt hat – bevor die Position OOR geht und 0 Fees sammelt.
        const proactivePct = pool.proactiveTrigger;
        if (proactivePct && config.rebalance.enabled && !pool.rebalanceDisabled) {
            const mid       = (state.priceLower + state.priceUpper) / 2;
            const halfWidth = state.priceUpper - mid;
            const drift     = Math.abs(state.currentPrice - mid) / halfWidth;
            if (drift >= proactivePct) {
                console.log(
                    `[bot:${pool.id}] Proaktiver Trigger: Drift ${(drift * 100).toFixed(1)}% ≥ ` +
                    `${(proactivePct * 100).toFixed(0)}% – Rebalancing wird gestartet`
                );
                await _doRebalance(pool, position, state, adapter, 'proactive');
                position = getOpenPosition(db, pool.id);
                if (!position) return;
                // syncDashboard + Snapshot erfolgen bereits in _doRebalance → refreshAfterAction.
                // Return: state stammt noch von der alten Position → kein Snapshot mit stale state.
                return;
            } else if (drift >= proactivePct * 0.85) {
                // Frühwarnung ab 85% des Triggers (z.B. ab ~64% Drift bei Trigger 0.75)
                console.log(
                    `[bot:${pool.id}] Drift-Warnung: ${(drift * 100).toFixed(1)}% ` +
                    `(Trigger bei ${(proactivePct * 100).toFixed(0)}%)`
                );
            }
        }
    }

    // ── 5./6. Fee-Claim/Reinvest + Portfolio-Snapshot ─────────────────────────
    // Beide mutieren on-chain bzw. schreiben Snapshots. Sie laufen unter dem
    // Bot-Op-Lock, damit manuelle Aktionen (deposit/withdraw/close-and-reopen)
    // währenddessen warten (waitForBotToFinish) statt gleichzeitig dieselbe Position
    // zu mutieren — genau die Race, die einen stale Snapshot direkt nach einem
    // Deposit erzeugt hat. Läuft umgekehrt schon eine manuelle Aktion, weicht der
    // Bot aus (_yieldToManualAction: 3× warten, dann überspringen).
    const sinceLastClaim = now - (lastFeeClaim.get(pool.id) ?? 0);
    const claimDue    = !isCleanupRunning() && sinceLastClaim >= config.feeClaimIntervalMs && state.inRange;
    const snapshotDue = now - (lastSnapshot.get(pool.id) ?? 0) >= config.portfolioSnapshotIntervalMs;

    if (claimDue || snapshotDue) {
        if (await _yieldToManualAction(pool.id, 'Claim/Reinvest/Snapshot')) {
            acquireBotOpLock({ pool: pool.id, op: 'claim-snapshot' });
            try {
                let claimed = false;

                // ── 5. Fee-Claim ──
                if (claimDue) {
                    // Fees nur claimen wenn in Range (sonst beim nächsten Rebalancing geclaimed)
                    // und wenn Mindest-Schwellwert erreicht ist (per-Pool-Einstellung überschreibt globalen Default)
                    const feeClaimSettings = _getFeeClaimSettings(pool.id);
                    const minClaimUsdc     = feeClaimSettings?.minClaimUsdc ?? config.feeClaimMinUsdc;
                    const latestPrice      = getPoolStats(db, pool.id, 1)[0]?.price ?? 0;
                    const feesPendingUsd   = _calcUsdValue(pool, db, latestPrice, state.feesOwedA, state.feesOwedB);
                    if (feesPendingUsd >= minClaimUsdc) {
                        claimed = await _claimFees(pool, position, state, adapter, latestPrice);
                        if (claimed) {
                            lastFeeClaim.set(pool.id, now);
                            state.feesOwedA = 0;
                            state.feesOwedB = 0;
                            lastSnapshot.set(pool.id, 0); // Snapshot sofort erzwingen (Schritt 6)
                        }
                    } else if (feesPendingUsd > 0) {
                        console.log(`[bot:${pool.id}] Fees zu niedrig zum Claimen (${feesPendingUsd.toFixed(4)} USDC < ${minClaimUsdc} USDC)`);
                    }
                }

                // ── 6. Portfolio-Snapshot ──
                if (now - (lastSnapshot.get(pool.id) ?? 0) >= config.portfolioSnapshotIntervalMs) {
                    await _takeSnapshot(pool, position, state, adapter);
                    lastSnapshot.set(pool.id, now);

                    // Nach Claim: Dashboard erst jetzt synchronisieren, wenn position_snapshots
                    // (fees_pending=0) und Wallet bereits aktualisiert sind → konsistentes Bild.
                    if (claimed) {
                        try {
                            await syncDashboard(msg => console.log(`[bot:${pool.id}] ${msg}`));
                            lastExport.ts = Date.now();
                        } catch { /* ignorieren */ }
                    }
                }
            } finally {
                releaseBotOpLock();
            }
        }
    }
}

// ─── Pre-Swap vor Position öffnen ─────────────────────────────────────────────

/**
 * Gleicht den Token-Mix im Wallet aus, bevor eine neue Position eröffnet wird.
 *
 * Problem: Nach einem Out-of-Range-Close kann das Wallet stark unausgewogen sein
 * (z.B. 100% USDC, 0% cbBTC wenn der Preis über die obere Range-Grenze gelaufen ist).
 * Das führt zu 0x1 (InsufficientFunds) beim nächsten openPosition.
 *
 * Lösung: Wenn ein Token unter 50% des 50/50-Ziels liegt, wird der Überschuss
 * des anderen Tokens via Jupiter getauscht. Fix 2 (dynamischer Anker in orca.js)
 * dient als Sicherheitsnetz falls der Swap scheitert.
 *
 * Nur für Standard-Pools (tokenB = USDC). Überspringt usdcIsTokenA und volatilePair.
 *
 * @param {Object} pool          Pool-Konfiguration aus pools.json
 * @param {number} currentPrice  Aktueller Preis (tokenA in tokenB, z.B. BTC-Kurs in USDC)
 */
async function _preSwapIfNeeded(pool, currentPrice, targetCapital = null, baseA = 0, baseB = 0) {
    if (pool.usdcIsTokenA || pool.volatilePair) return;

    const SOL_MINT    = 'So11111111111111111111111111111111111111112';
    // SOL-Reserve die beim Pre-Swap SOL→USDC im Wallet verbleibt.
    // Stellt sicher dass nach dem Rebalancing genug SOL für TX-Fees und Deposits übrig ist.
    const SOL_REBALANCE_RESERVE = 0.15;
    const [symA, symB] = pool.pair.split('/');
    const keypair     = getKeypair();

    // Frische Balances lesen (wichtig: nach eventuell vorherigem Position-Close)
    const [tokenABal, tokenBBal] = await Promise.all([
        pool.tokenA === SOL_MINT
            ? getUsableSolBalanceFresh(keypair.publicKey)
            : getTokenBalanceFresh(keypair.publicKey, pool.tokenA, pool.decimalsA),
        getTokenBalanceFresh(keypair.publicKey, pool.tokenB, pool.decimalsB),
    ]);

    // Topf-A-Erhalt: nur Wallet-Bestand ÜBER der Baseline darf umgeschichtet werden.
    // Andernfalls würde der Pre-Swap den stehenden Altbestand (z.B. SPCX) in USDC
    // wandeln und so über die Gegenseite doch ins Deployment ziehen. Die Baseline
    // ist in Token-Einheiten nicht swap-invariant → hier hart kappen.
    const availA = Math.max(0, tokenABal - baseA);
    const availB = Math.max(0, tokenBBal - baseB);

    // Zielkapital: bevorzugt das durch den Rebalance freigesetzte Kapital
    // (targetCapital). Fallback auf letzte DB-Position (inkl. bereits geschlossener).
    // Sicherheitsnetz: war die letzte Position winzig (< 5 USDC) und das verfügbare
    // Wallet hat deutlich mehr, wird das Wallet genutzt.
    let halfCapital;
    if (targetCapital != null && targetCapital > 0) {
        halfCapital = targetCapital / 2;
    } else {
        const lastPos = db.prepare(
            `SELECT capital_usdc FROM positions WHERE pool_id = ? ORDER BY opened_at DESC LIMIT 1`
        ).get(pool.id);
        const MIN_REOPEN_CAPITAL = 5.0;
        const _histCapPre  = lastPos?.capital_usdc ?? availB;
        halfCapital = ((_histCapPre < MIN_REOPEN_CAPITAL && availB > _histCapPre)
            ? availB : _histCapPre) / 2;
    }
    if (!halfCapital) return;

    // 50/50-Soll berechnen
    const targetA = halfCapital / currentPrice;  // z.B. 0.00687 cbBTC
    const targetB = halfCapital;                 // z.B. 490 USDC

    // Imbalance prüfen — Schwellwert: < 50% des Ziels → Swap nötig.
    // Vergleich auf verfügbarem (baseline-bereinigtem) Bestand.
    const THRESHOLD = 0.5;
    const ratioA = targetA > 0 ? availA / targetA : 1;
    const ratioB = targetB > 0 ? availB / targetB : 1;

    if (ratioA >= THRESHOLD && ratioB >= THRESHOLD) return;  // kein Handlungsbedarf

    if (ratioA < THRESHOLD) {
        // Zu wenig tokenA (z.B. cbBTC) → USDC → tokenA tauschen (nur verfügbares USDC)
        const deficitA  = targetA - availA;
        const usdcNeeded = deficitA * currentPrice;
        const swapAmount = Math.min(usdcNeeded, availB * 0.99);

        if (swapAmount < 1.0) {
            console.log(`[bot:${pool.id}] Pre-Swap: USDC-Betrag zu klein (${usdcNeeded.toFixed(2)} USDC) – überspringe`);
            return;
        }
        console.log(`[bot:${pool.id}] Pre-Swap: ${swapAmount.toFixed(2)} ${symB} → ${symA} (Imbalance: ${(ratioA * 100).toFixed(1)}% von Ziel)`);
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
            console.log(`[bot:${pool.id}] Pre-Swap OK: ${swapAmount.toFixed(2)} ${symB} → ${amountOut.toFixed(8)} ${symA} TX=${txSignature}`);
            const preSwapFee = await getTxFee(txSignature);
            insertTransaction(db, {
                poolId: pool.id, type: 'swap',
                amountA: swapAmount, amountB: amountOut,
                usdValue: swapAmount,   // tokenB = USDC → Eingabe ist der USD-Wert
                txHash: txSignature,
                txFeeSol: preSwapFee, note: `pre-swap ${symB}→${symA}`,
            });
        } catch (err) {
            console.error(`[bot:${pool.id}] Pre-Swap fehlgeschlagen: ${err.message} — öffne trotzdem (Fix 2 als Fallback)`);
        }
    } else {
        // Zu wenig tokenB (USDC) → tokenA → USDC tauschen (nur verfügbares tokenA)
        const deficitB    = targetB - availB;
        const tokenANeeded = deficitB / currentPrice;
        // Bei SOL als tokenA: Reserve einbehalten damit nach dem Swap noch genug SOL
        // für TX-Fees und nachfolgende Operationen (Deposit, Reinvest) vorhanden ist.
        const tokenASwappable = pool.tokenA === SOL_MINT
            ? Math.max(0, availA - SOL_REBALANCE_RESERVE)
            : availA * 0.99;
        const swapAmount  = Math.min(tokenANeeded, tokenASwappable);

        const minSwapA = 1 / Math.pow(10, pool.decimalsA);  // 1 kleinste Einheit
        if (swapAmount < minSwapA * 100) {
            console.log(`[bot:${pool.id}] Pre-Swap: ${symA}-Betrag zu klein (${tokenANeeded.toFixed(8)}) – überspringe`);
            return;
        }
        if (pool.tokenA === SOL_MINT && tokenANeeded > tokenASwappable) {
            console.log(`[bot:${pool.id}] Pre-Swap: SOL-Reserve (${SOL_REBALANCE_RESERVE} SOL) einbehalten – Swap ${tokenANeeded.toFixed(8)} → ${swapAmount.toFixed(8)} SOL reduziert`);
        }
        console.log(`[bot:${pool.id}] Pre-Swap: ${swapAmount.toFixed(8)} ${symA} → ${symB} (Imbalance: ${(ratioB * 100).toFixed(1)}% von Ziel)`);
        try {
            const { amountOut, txSignature } = await swapTokens({
                inputMint:      pool.tokenA,
                outputMint:     pool.tokenB,
                inputDecimals:  pool.decimalsA,
                outputDecimals: pool.decimalsB,
                amount:         swapAmount,
                wallet:         keypair,
                connection:     getConnection(),
            });
            const preSwapFee = await getTxFee(txSignature);
            insertTransaction(db, {
                poolId: pool.id, type: 'swap',
                amountA: swapAmount, amountB: amountOut,
                usdValue: amountOut,    // tokenB = USDC → Ausgabe ist der USD-Wert
                txHash: txSignature,
                txFeeSol: preSwapFee, note: `pre-swap ${symA}→${symB}`,
            });
            console.log(`[bot:${pool.id}] Pre-Swap OK: ${swapAmount.toFixed(8)} ${symA} → ${amountOut.toFixed(2)} ${symB} TX=${txSignature}`);
        } catch (err) {
            console.error(`[bot:${pool.id}] Pre-Swap fehlgeschlagen: ${err.message} — öffne trotzdem (Fix 2 als Fallback)`);
        }
    }
}

// ─── Reconciler: Idle-Kapital nach Rebalance-Open in Position nachzahlen ────
//
// Iterativer Reconciler. Läuft nach jedem Rebalance-Open. Stellt sicher dass
// jegliches Restkapital im Wallet (USDC, tokenA, tokenB) in die Position
// gewandert ist — auch für volatilePair (HYPE/SOL, cbBTC/WBTC),
// bei denen der frühere Top-Up komplett abgebrochen hat.
//
// Pro Iteration (max. MAX_ITERATIONS):
//   1. Wallet-Stand frisch lesen (A, B, ggf. idle USDC).
//   2. Idle-USDC bei nicht-USDC-Pools → Quote-Token swappen.
//   3. A/B-Imbalance gegen 50/50-Ziel — überschüssige Seite halb in deficit-Seite tauschen.
//   4. increaseLiquidity mit aktuellem (gekapptem) Wallet-Stand.
//   5. Iteration abbrechen wenn idleValue < MIN_IDLE_USDC oder kein Fortschritt mehr.
//
// Safeguards:
//   - Slippage-Stop: einzelner Swap-Fehler bricht den Loop ab (kein Repeat in volatilen Pools).
//   - Max-Iterations: hartes Limit gegen Endlos-Loops.
//   - SOL-Reserve: behält 0.15 SOL für TX-Fees im Wallet.
//
// Rückgabe: total in USDC eingezahltes Kapital (für Pre-Flight-Guard im Caller).

async function _reconcileWalletIntoPosition(pool, adapter, newPosition, currentPrice, opts = {}) {
    const MAX_ITERATIONS    = opts.maxIterations ?? 3;
    const MIN_IDLE_USDC     = opts.minIdle ?? 5;
    const SLIPPAGE_FACTOR   = 1 + 1.5 / 100;   // Orca-interner 1% Slippage + 0.5% Puffer
    const SOL_RESERVE       = 0.15;
    // Obergrenze für das insgesamt nachgezahlte Kapital (USDC). Default Infinity =
    // bisheriges Verhalten (sweept alles idle). Wird vom manuellen close-and-reopen-
    // Top-up gesetzt, um nur die Differenz (V_before − deployed) zu reaktivieren und
    // NICHT fremdes Wallet-USDC (Cleanup-Pending) anderer Pools mitzunehmen.
    const MAX_RECONCILE     = opts.maxReconcileUsdc ?? Infinity;
    // Wie viel USDC lag vor dem Rebalance bereits im Wallet (nicht aus diesem Pool).
    // Nur USDC *darüber* hinaus darf in Pool-Tokens gewechselt werden.
    const PRE_EXISTING_USDC = opts.preExistingUsdc ?? 0;
    // Topf-A-Baseline pro Pool-Token: der vor dem Rebalance stehende Wallet-Bestand
    // an tokenA/tokenB bleibt unangetastet. Nur Bestand *über* der Baseline wird
    // (rück-)deployed. Default 0 = bisheriges Verhalten (sweept alles Verfügbare).
    const PRE_EXISTING_A = opts.preExistingA ?? 0;
    const PRE_EXISTING_B = opts.preExistingB ?? 0;

    const keypair = getKeypair();
    const pub     = keypair.publicKey;

    const poolHasUsdc = pool.tokenA === USDC_MINT || pool.tokenB === USDC_MINT;

    const readBal = (mint, dec) => mint === SOL_MINT
        ? getUsableSolBalanceFresh(pub)
        : getTokenBalanceFresh(pub, mint, dec);

    const minUnit = (dec) => 100 / Math.pow(10, dec);

    async function doSwap(inMint, outMint, inDec, outDec, amount, label) {
        try {
            const { amountOut, txSignature } = await swapTokens({
                inputMint: inMint, outputMint: outMint,
                inputDecimals: inDec, outputDecimals: outDec,
                amount, wallet: keypair, connection: getConnection(),
            });
            const fee = await getTxFee(txSignature);
            // USD-Wert des Swap-Inputs. USDC-Input wird _calcUsdValue als tokenB
            // missverstehen (Pool kennt kein USDC) und mit quotePrice multiplizieren →
            // 100x-Fehler. Daher Sonderbehandlung: USDC direkt als USD nehmen.
            const USDC_FALLBACK_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
            const swapUsd = inMint === USDC_FALLBACK_MINT
                ? amount
                : inMint === pool.tokenA
                    ? _calcUsdValue(pool, db, currentPrice, amount, 0)
                    : _calcUsdValue(pool, db, currentPrice, 0, amount);
            insertTransaction(db, {
                poolId: pool.id, type: 'swap',
                amountA: amount, amountB: amountOut, usdValue: swapUsd,
                txHash: txSignature, txFeeSol: fee, note: `reconcile-${label}`,
            });
            console.log(`[bot:${pool.id}] Reconcile-Swap (${label}): ${amount.toFixed(6)} → ${amountOut.toFixed(6)} TX=${txSignature}`);
            return amountOut;
        } catch (err) {
            console.error(`[bot:${pool.id}] Reconcile-Swap (${label}) fehlgeschlagen: ${err.message} — Loop wird abgebrochen`);
            return null;
        }
    }

    let depositedTotal   = 0;
    let lastIdleValue    = Infinity;

    for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        const walletA   = await readBal(pool.tokenA, pool.decimalsA);
        const walletB   = await readBal(pool.tokenB, pool.decimalsB);
        const rawUsdc   = poolHasUsdc ? 0 : await getTokenBalanceFresh(pub, USDC_MINT, 6);
        // Nur USDC das durch den Rebalance neu entstanden ist (Delta gegenüber Wallet-Stand vor close_position)
        const idleUsdc  = Math.max(0, rawUsdc - PRE_EXISTING_USDC);
        // Topf A schützen: nur Bestand ÜBER der Baseline ist redeploybar.
        const availA    = Math.max(0, walletA - PRE_EXISTING_A);
        const availB    = Math.max(0, walletB - PRE_EXISTING_B);

        const idleValueInPool = _calcUsdValue(pool, db, currentPrice, availA, availB);
        const idleValue       = idleValueInPool + idleUsdc;

        console.log(`[bot:${pool.id}] Reconcile Iter ${iter}/${MAX_ITERATIONS}: idle=${idleValue.toFixed(2)} USDC (availA=${availA.toFixed(6)}, availB=${availB.toFixed(6)}, USDC=${idleUsdc.toFixed(2)} raw=${rawUsdc.toFixed(2)} preU=${PRE_EXISTING_USDC.toFixed(2)} baseA=${PRE_EXISTING_A.toFixed(6)} baseB=${PRE_EXISTING_B.toFixed(6)})`);

        if (idleValue < MIN_IDLE_USDC) {
            console.log(`[bot:${pool.id}] Reconcile: idle < ${MIN_IDLE_USDC} USDC — fertig.`);
            break;
        }
        // Fortschritts-Stop: keine Verbesserung seit letzter Runde → abbrechen
        if (iter > 1 && idleValue >= lastIdleValue * 0.95) {
            console.warn(`[bot:${pool.id}] Reconcile: kein Fortschritt (${lastIdleValue.toFixed(2)} → ${idleValue.toFixed(2)} USDC) — abgebrochen.`);
            break;
        }
        lastIdleValue = idleValue;

        // Budget-Cap: nur bis zur erlaubten Gesamtsumme nachzahlen (Default Infinity).
        const budget = MAX_RECONCILE - depositedTotal;
        if (budget < MIN_IDLE_USDC) {
            console.log(`[bot:${pool.id}] Reconcile: Budget (${MAX_RECONCILE.toFixed(2)} USDC) erreicht — fertig.`);
            break;
        }

        // 1. Idle-USDC bei nicht-USDC-Pools in Quote-Token tauschen
        if (idleUsdc >= MIN_IDLE_USDC && !poolHasUsdc) {
            const targetMint = pool.volatilePair
                ? pool.quoteTokenMint
                : pool.tokenA;
            const targetDec = targetMint === pool.tokenA ? pool.decimalsA : pool.decimalsB;
            const swapAmt   = Math.min(idleUsdc, budget) * 0.99;
            const out = await doSwap(USDC_MINT, targetMint, 6, targetDec, swapAmt, 'usdc-to-base');
            if (out == null) break;
            continue;  // Iteration neu starten mit frischen Balances
        }

        // 2. A/B-Balance prüfen (50/50-USD-Ziel innerhalb des Pools, gekappt auf Budget)
        const halfUsd = Math.min(idleValueInPool, budget) / 2;
        let targetA = 0, targetB = 0;
        if (pool.volatilePair) {
            const qP   = _getQuotePrice(pool, db);
            const qIsA = pool.quoteTokenMint === pool.tokenA;
            const usdA = qIsA ? qP : qP * currentPrice;
            const usdB = qIsA ? (currentPrice > 0 ? qP / currentPrice : 0) : qP;
            targetA = usdA > 0 ? halfUsd / usdA : 0;
            targetB = usdB > 0 ? halfUsd / usdB : 0;
        } else if (pool.usdcIsTokenA) {
            targetA = halfUsd;
            targetB = currentPrice > 0 ? halfUsd * currentPrice : 0;
        } else {
            targetA = currentPrice > 0 ? halfUsd / currentPrice : 0;
            targetB = halfUsd;
        }

        let didSwap = false;
        if (availA > targetA * 1.05 && availB < targetB) {
            let swapAmt = (availA - targetA) / 2;
            if (pool.tokenA === SOL_MINT) {
                swapAmt = Math.min(swapAmt, Math.max(0, walletA - SOL_RESERVE));
            }
            if (swapAmt > minUnit(pool.decimalsA) * 10) {
                const out = await doSwap(pool.tokenA, pool.tokenB, pool.decimalsA, pool.decimalsB, swapAmt, 'balance-A-to-B');
                if (out == null) break;
                didSwap = true;
            }
        } else if (availB > targetB * 1.05 && availA < targetA) {
            let swapAmt = (availB - targetB) / 2;
            if (pool.tokenB === SOL_MINT) {
                swapAmt = Math.min(swapAmt, Math.max(0, walletB - SOL_RESERVE));
            }
            if (swapAmt > minUnit(pool.decimalsB) * 10) {
                const out = await doSwap(pool.tokenB, pool.tokenA, pool.decimalsB, pool.decimalsA, swapAmt, 'balance-B-to-A');
                if (out == null) break;
                didSwap = true;
            }
        }

        // 3. increaseLiquidity mit aktuellem (gekapptem) Wallet-Stand.
        //    Topf-A-Baseline wird hier physisch abgezogen → die Einzahlung kann den
        //    stehenden Altbestand niemals antasten, auch wenn das Budget es zuließe.
        const wA = await readBal(pool.tokenA, pool.decimalsA);
        const wB = await readBal(pool.tokenB, pool.decimalsB);
        const usableA0 = pool.tokenA === SOL_MINT ? Math.max(0, wA - SOL_RESERVE) : wA;
        const usableB0 = pool.tokenB === SOL_MINT ? Math.max(0, wB - SOL_RESERVE) : wB;
        const usableA  = Math.max(0, usableA0 - PRE_EXISTING_A);
        const usableB  = Math.max(0, usableB0 - PRE_EXISTING_B);
        let amountA = usableA / SLIPPAGE_FACTOR;
        let amountB = usableB / SLIPPAGE_FACTOR;

        // Deposit auf verbleibendes Budget kappen — verhindert Über-Deployment bei USDC-Pools,
        // wo idle-USDC (tokenB) nicht über PRE_EXISTING_USDC begrenzt ist. Default-Budget = ∞ → no-op.
        const plannedDepUsd = _calcUsdValue(pool, db, currentPrice, amountA, amountB);
        if (plannedDepUsd > budget && plannedDepUsd > 0) {
            const sc = budget / plannedDepUsd;
            amountA *= sc;
            amountB *= sc;
        }

        if (amountA < minUnit(pool.decimalsA) || amountB < minUnit(pool.decimalsB)) {
            console.log(`[bot:${pool.id}] Reconcile: zu wenig Balance für increaseLiquidity (A=${amountA}, B=${amountB})`);
            if (!didSwap) break;
            continue;
        }

        try {
            const result = await adapter.increaseLiquidity(pool, newPosition.nftMint, amountA, amountB);
            if (!result.txHash) {
                console.log(`[bot:${pool.id}] Reconcile: increaseLiquidity ergab 0 Liquidität — Abbruch`);
                break;
            }
            const dep = _calcUsdValue(pool, db, currentPrice, result.tokenEstA, result.tokenEstB);
            depositedTotal += dep;
            updatePositionHodl(db, newPosition.id, result.tokenEstA, result.tokenEstB);
            const fee = await getTxFee(result.txHash);
            insertTransaction(db, {
                poolId: pool.id, type: 'deposit',
                amountA: result.tokenEstA, amountB: result.tokenEstB,
                usdValue: dep, txHash: result.txHash, txFeeSol: fee,
                note: `Reconcile iter ${iter}`,
            });
            insertCapitalFlow(db, {
                poolId:     pool.id,
                usdcAmount: dep,
                txHash:     result.txHash,
                note:       `Reconcile iter ${iter}`,
                isExternal: 0,  // Kapital aus geschlossener Position wird re-deployed → kein externer Zufluss
            });
            console.log(`[bot:${pool.id}] Reconcile Iter ${iter}: +${dep.toFixed(2)} USDC eingezahlt TX=${result.txHash}`);
        } catch (err) {
            console.error(`[bot:${pool.id}] Reconcile increaseLiquidity fehlgeschlagen: ${err.message} — Loop wird abgebrochen`);
            break;
        }
    }

    if (depositedTotal > 0) {
        const oldCap = newPosition.capitalUsdc ?? 0;
        updatePositionCapital(db, newPosition.id, oldCap + depositedTotal);
    }
    return depositedTotal;
}

// ─── Range Advisor ────────────────────────────────────────────────────────────

/**
 * Ermittelt die optimale Range via Range Advisor und gibt ein calculateRange()-Ergebnis zurück.
 * Bei Fehler oder rangeOverride wird null zurückgegeben → Aufrufer fällt auf calculateRange() zurück.
 *
 * @param {Object} pool         Pool-Konfiguration
 * @param {number} currentPrice Aktueller Pool-Preis
 * @param {number} capitalUsdc  Investiertes Kapital für Wirtschaftlichkeitsberechnung
 * @returns {Object|null}       calculateRange()-Ergebnis oder null bei Fehler
 */
async function _getAdvisedRange(pool, currentPrice, capitalUsdc) {
    // rangeOverride.locked: manuell fest konfigurierte Range — Advisor wird übersprungen.
    // Der Aufrufer fällt dann auf calculateRange(effectiveRange) mit der fixen fixedPct zurück.
    // Ohne dieses Skip würde die Advisor-Empfehlung die fixe Range beim Öffnen/Rebalance
    // überstimmen (Fallback-Mechanik). Siehe Liquidity CLAUDE.md → rangeOverride.locked.
    if (pool.rangeOverride?.locked === true) return null;
    try {
        const advice = await analyzePool(pool, db, { capitalUsdc });
        if (!advice) return null;
        const rec  = advice.recommendation.rangePct;
        const net  = advice.rationale.optimalScore.netAprPct;
        const conf = advice.recommendation.confidence;
        const trend = advice.rationale.trend.direction;
        console.log(
            `[advisor:${pool.id}] ±${rec}% | N-APR: ${net}% | Trend: ${trend} | Konfidenz: ${conf}`
        );
        return calculateRange(pool, currentPrice, { mode: 'fixed', fixedPct: rec }, db);
    } catch (err) {
        console.log(`[advisor:${pool.id}] Advisor nicht verfügbar: ${err.message} — Fallback auf Config-Range`);
        return null;
    }
}

/**
 * Findet den Index der nächstliegenden CANDIDATE_RANGES-Stufe zu einem ±%-Wert.
 * @param {number} pct
 * @returns {number} Index in CANDIDATE_RANGES
 */
function _nearestCandidateIndex(pct) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < CANDIDATE_RANGES.length; i++) {
        const d = Math.abs(CANDIDATE_RANGES[i] - pct);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
}

/**
 * Konsultiert den Advisor beim Rebalancing und entscheidet per Hysterese, ob die
 * konfigurierte Range geändert wird. Schreibt das Ergebnis in advisor_decisions.
 *
 * Hysterese: Änderung nur wenn Konfidenz medium/high, Empfehlung ≥2 Stufen von der
 * aktuellen fixedPct entfernt liegt und der Pool nicht gelockt ist (rangeOverride.locked).
 *
 * Robustheit: Advisor-Aufruf kann fehlschlagen (Netz/Timeout) → kein Throw, Rückgabe null.
 *
 * @returns {Promise<number|null>} neue fixedPct wenn geändert, sonst null
 */
async function _advisorRebalanceCheck(pool, capitalUsdc) {
    const currentPct = pool.rangeOverride?.fixedPct ?? null;
    if (currentPct == null) return null; // ohne rangeOverride keine Advisor-Steuerung

    let advice;
    try {
        advice = await analyzePool(pool, db, { capitalUsdc });
    } catch (err) {
        console.log(`[advisor:${pool.id}] Advisor-Check fehlgeschlagen: ${err.message} — behalte Range ±${currentPct}%`);
        return null;
    }
    if (!advice) return null;

    const recPct      = advice.recommendation.rangePct;
    const confidence  = advice.recommendation.confidence;
    const netRec      = advice.rationale.optimalScore?.netAprPct ?? null;
    const netCur      = advice.rationale.currentScore?.netAprPct ?? null;
    const emp         = advice.rationale.empiricalRebalCost;
    const drift       = advice.rationale.modelDrift;
    const attrition   = advice.rationale.optimalScore?.attritionPctPerMonth ?? null;

    const curIdx  = _nearestCandidateIndex(currentPct);
    const recIdx  = _nearestCandidateIndex(recPct);
    const stepGap = Math.abs(recIdx - curIdx);
    const locked  = pool.rangeOverride?.locked === true;

    let actionTaken, rejectionReason = null, newPct = null;
    if (locked) {
        actionTaken = 'rejected_hysteresis';
        rejectionReason = 'rangeOverride.locked = true';
    } else if (confidence === 'low') {
        actionTaken = 'rejected_low_confidence';
        rejectionReason = `Konfidenz ${confidence}`;
    } else if (stepGap < 2) {
        actionTaken = stepGap === 0 ? 'rejected_no_change' : 'rejected_hysteresis';
        rejectionReason = `Empfehlung ±${recPct}% nur ${stepGap} Stufe(n) von aktuell ±${currentPct}% entfernt (Hysterese: ≥2)`;
    } else {
        // Range übernehmen
        newPct = recPct;
        actionTaken = 'range_changed';
        try {
            const changed = updatePoolRangeOverride(pool.id, newPct);
            if (changed) {
                pool.rangeOverride.fixedPct = newPct; // In-Memory sofort konsistent
            } else {
                actionTaken = 'rejected_no_change';
                rejectionReason = 'fixedPct bereits auf Zielwert';
                newPct = null;
            }
        } catch (err) {
            console.error(`[advisor:${pool.id}] pools.json-Schreiben fehlgeschlagen: ${err.message} — behalte Range ±${currentPct}%`);
            actionTaken = 'rejected_hysteresis';
            rejectionReason = `pools.json-Schreiben fehlgeschlagen: ${err.message}`;
            newPct = null;
        }
    }

    console.log(
        `[advisor:${pool.id}] Rebalance-Check: aktuell ±${currentPct}% → Empfehlung ±${recPct}% ` +
        `(Konfidenz ${confidence}, Δ${stepGap} Stufen) → ${actionTaken}` +
        (rejectionReason ? ` (${rejectionReason})` : '') +
        ` | N-APR ${netCur ?? '?'}%→${netRec ?? '?'}% | SwapCost ${emp?.isFallback ? 'fallback' : emp?.avgCostUsdc + ' USDC'} | Drift ${drift?.driftFactor ?? 'n/a'}`
    );

    try {
        insertAdvisorDecision(db, {
            poolId:              pool.id,
            triggeredBy:         'rebalance',
            currentRangePct:     currentPct,
            recommendedRangePct: recPct,
            confidence,
            actionTaken,
            rejectionReason,
            netAprCurrent:       netCur,
            netAprRecommended:   netRec,
            swapCostEmpirical:   emp?.isFallback ? null : emp?.avgCostUsdc ?? null,
            modelDrift:          drift?.driftFactor ?? null,
            attritionPctPerMonth: attrition,
            capitalUsdc,
        });
    } catch (err) {
        console.error(`[advisor:${pool.id}] insertAdvisorDecision fehlgeschlagen: ${err.message}`);
    }

    return newPct;
}

/**
 * Attrition-Regelkreis: prüft nach jedem Rebalancing, ob die monatliche Kapital-
 * Attrition (aus empirischen Swap-Kosten × Rebalancing-Rate) eine Schwelle übersteigt.
 * Falls ja: Range eine Stufe weiter aufmachen (bis maxRange der Pool-Klasse).
 *
 * @param {Object} pool
 * @param {number} capitalUsdc
 * @param {number} rebalsPerDayActual  tatsächliche Rebalancing-Rate (aus DB, /Tag)
 */
async function _attritionCheck(pool, capitalUsdc, rebalsPerDayActual) {
    const currentPct = pool.rangeOverride?.fixedPct ?? null;
    if (currentPct == null) return;
    // locked: manuell fixe Range nicht automatisch weiten (konsistent zu _advisorRebalanceCheck
    // und _getAdvisedRange). Vol-Spike-Risiko wird per Monitoring/Rollback gehandhabt, nicht still.
    if (pool.rangeOverride?.locked === true) return;

    const threshold = (typeof pool.attritionThresholdPct === 'number')
        ? pool.attritionThresholdPct
        : (Number.isFinite(parseFloat(process.env.ATTRITION_THRESHOLD_PCT))
            ? parseFloat(process.env.ATTRITION_THRESHOLD_PCT) : 3.0);

    let emp;
    try {
        emp = estimateRebalanceCost(db, pool, capitalUsdc);
    } catch (err) {
        console.error(`[advisor:${pool.id}] Attrition-Check: estimateRebalanceCost fehlgeschlagen: ${err.message}`);
        return;
    }

    const attritionPctPerMonth = capitalUsdc > 0
        ? (emp.avgCostUsdc / capitalUsdc) * rebalsPerDayActual * 30 * 100
        : 0;

    if (attritionPctPerMonth <= threshold || emp.sampleSize < 5) {
        console.log(
            `[advisor:${pool.id}] Attrition ${attritionPctPerMonth.toFixed(2)}%/Monat ` +
            `(Schwelle ${threshold}%, ${emp.sampleSize} Messpunkte) — keine Aktion`
        );
        return;
    }

    // Nächste breitere Stufe finden, maxRange des Pool-Typs respektieren
    const classCfg = getPoolTypeConfig(pool);
    const curIdx   = _nearestCandidateIndex(currentPct);
    let nextIdx = curIdx;
    for (let i = curIdx + 1; i < CANDIDATE_RANGES.length; i++) {
        if (CANDIDATE_RANGES[i] > currentPct && CANDIDATE_RANGES[i] <= classCfg.max) { nextIdx = i; break; }
    }
    const newPct = CANDIDATE_RANGES[nextIdx];

    if (nextIdx === curIdx || newPct <= currentPct) {
        console.log(
            `[advisor:${pool.id}] Attrition ${attritionPctPerMonth.toFixed(2)}%/Monat über Schwelle, ` +
            `aber keine breitere Stufe ≤ maxRange ±${classCfg.max}% verfügbar — keine Aktion`
        );
        insertAdvisorDecision(db, {
            poolId: pool.id, triggeredBy: 'attrition_check',
            currentRangePct: currentPct, recommendedRangePct: currentPct,
            confidence: 'high', actionTaken: 'rejected_no_change',
            rejectionReason: `maxRange ±${classCfg.max}% erreicht`,
            swapCostEmpirical: emp.avgCostUsdc,
            attritionPctPerMonth, capitalUsdc,
        });
        return;
    }

    let changed = false;
    try {
        changed = updatePoolRangeOverride(pool.id, newPct);
        if (changed) pool.rangeOverride.fixedPct = newPct;
    } catch (err) {
        console.error(`[advisor:${pool.id}] Attrition: pools.json-Schreiben fehlgeschlagen: ${err.message}`);
        return;
    }

    console.log(
        `[advisor:${pool.id}] Attrition ${attritionPctPerMonth.toFixed(2)}%/Monat > ${threshold}% ` +
        `→ Range ±${currentPct}% → ±${newPct}% geweitet`
    );

    try {
        insertAdvisorDecision(db, {
            poolId: pool.id, triggeredBy: 'attrition_check',
            currentRangePct: currentPct, recommendedRangePct: newPct,
            confidence: 'high', actionTaken: 'attrition_widened',
            swapCostEmpirical: emp.avgCostUsdc,
            attritionPctPerMonth, capitalUsdc,
        });
    } catch (err) {
        console.error(`[advisor:${pool.id}] insertAdvisorDecision (attrition) fehlgeschlagen: ${err.message}`);
    }

    try {
        await notify.info(
            `Range Advisor – ${pool.displayPair ?? pool.pair}`,
            `Range automatisch auf ±${newPct}% geweitet (Attrition: ${attritionPctPerMonth.toFixed(1)}%/Monat)`
        );
    } catch { /* notify-Fehler nicht propagieren */ }
}

/**
 * Täglicher Advisor-Scan über alle aktiven Pools. Meldet (ohne Auto-Apply) stabile
 * Range-Empfehlungen, die ≥2 Stufen von der aktuell konfigurierten Range abweichen.
 *
 * Stabilität: heutige Empfehlung == gestrige Empfehlung (aus advisor_decisions des
 * Vortags). Konfidenz muss medium/high sein. Max. 1 Notification pro Pool pro Tag
 * (heute bereits ein daily_scan-Eintrag → kein erneuter Versand).
 *
 * @param {Array} activePools
 */
async function _dailyAdvisorScan(activePools) {
    const dayMs       = 24 * 3_600_000;
    const todayStartMs = midnightTzMs(todayTz());

    for (const pool of activePools) {
        const currentPct = pool.rangeOverride?.fixedPct ?? null;
        if (currentPct == null) continue;

        // Bereits heute gescannt? → Spam vermeiden
        const todayScan = db.prepare(
            `SELECT id FROM advisor_decisions WHERE pool_id = ? AND triggered_by = 'daily_scan' AND created_at >= ? LIMIT 1`
        ).get(pool.id, todayStartMs);
        if (todayScan) continue;

        let advice;
        try {
            advice = await analyzePool(pool, db);
        } catch (err) {
            console.log(`[advisor:${pool.id}] Daily-Scan: Advisor nicht verfügbar: ${err.message}`);
            continue;
        }
        if (!advice) continue;

        const recPct     = advice.recommendation.rangePct;
        const confidence = advice.recommendation.confidence;
        if (confidence === 'low') continue;

        const curIdx  = _nearestCandidateIndex(currentPct);
        const recIdx  = _nearestCandidateIndex(recPct);
        if (Math.abs(recIdx - curIdx) < 2) continue;

        // Stabilität: gestrige Empfehlung (letzter Eintrag im Vortagsfenster).
        // Die Empfehlung gilt nur dann als stabil, wenn sie GLEICH ist UND bei
        // DERSELBEN Ist-Range berechnet wurde. Andernfalls wäre „gestern == heute"
        // durch die Oszillation selbst erfüllbar: der driftFactor koppelt die
        // Empfehlung an die Ist-Range (#0198), d.h. nach einem Range-Wechsel kippt
        // die Empfehlung mit — ein Vergleich über eine Range-Änderung hinweg ist
        // wertlos und würde Flattern als „stabil" durchwinken.
        const prevRow = db.prepare(
            `SELECT recommended_range_pct, current_range_pct FROM advisor_decisions
             WHERE pool_id = ? AND created_at >= ? AND created_at < ?
             ORDER BY created_at DESC LIMIT 1`
        ).get(pool.id, todayStartMs - dayMs, todayStartMs);
        const stable = prevRow != null
            && prevRow.recommended_range_pct === recPct
            && prevRow.current_range_pct != null
            && _nearestCandidateIndex(prevRow.current_range_pct) === curIdx;
        if (!stable) {
            // Noch nicht stabil: heutigen Wert protokollieren (als daily_scan, ohne Notify),
            // damit morgen die Stabilität geprüft werden kann.
            try {
                insertAdvisorDecision(db, {
                    poolId: pool.id, triggeredBy: 'daily_scan',
                    currentRangePct: currentPct, recommendedRangePct: recPct,
                    confidence, actionTaken: 'rejected_no_change',
                    rejectionReason: 'Empfehlung noch nicht stabil (≥2 Tage)',
                    netAprCurrent:     advice.rationale.currentScore?.netAprPct ?? null,
                    netAprRecommended: advice.rationale.optimalScore?.netAprPct ?? null,
                    attritionPctPerMonth: advice.rationale.optimalScore?.attritionPctPerMonth ?? null,
                    capitalUsdc: advice.rationale.breakEven?.currentCapitalUsdc ?? null,
                });
            } catch (err) {
                console.error(`[advisor:${pool.id}] insertAdvisorDecision (daily_scan) fehlgeschlagen: ${err.message}`);
            }
            continue;
        }

        const netCur = advice.rationale.currentScore?.netAprPct ?? null;
        const netRec = advice.rationale.optimalScore?.netAprPct ?? null;
        const attr   = advice.rationale.optimalScore?.attritionPctPerMonth ?? null;
        const pair   = pool.displayPair ?? pool.pair;

        console.log(
            `[advisor:${pool.id}] Daily-Scan: stabile Empfehlung ±${currentPct}% → ±${recPct}% ` +
            `(Konfidenz ${confidence}) → ${confidence === 'high' ? 'Notification' : 'nur UI-Hinweis'}`
        );

        try {
            insertAdvisorDecision(db, {
                poolId: pool.id, triggeredBy: 'daily_scan',
                currentRangePct: currentPct, recommendedRangePct: recPct,
                confidence, actionTaken: 'notified',
                netAprCurrent: netCur, netAprRecommended: netRec,
                attritionPctPerMonth: attr,
                capitalUsdc: advice.rationale.breakEven?.currentCapitalUsdc ?? null,
            });
        } catch (err) {
            console.error(`[advisor:${pool.id}] insertAdvisorDecision (daily_scan notify) fehlgeschlagen: ${err.message}`);
        }

        // Telegram nur bei Konfidenz "high" — deckt sich mit dem confidence==='high'-Gate
        // für die Verwalten-Button-Hervorhebung in ForgeSettings (routes/pools.js). Bei
        // "medium" bleibt es beim reinen DB-Eintrag (Tagesreport + UI), da der Daily-Scan
        // (anders als der Range-Hinweis-Scan) keine Payback-/Profitabilitätsprüfung macht.
        if (confidence === 'high') {
            const fmtPct = v => v != null ? `${v.toFixed(1).replace('.', ',')}%` : '?';
            try {
                await notify.rangeHint(
                    `Range-Empfehlung – ${pair}`,
                    `Konfigurierte Range ±${currentPct}% weicht deutlich von der Empfehlung ab.\n` +
                    `Empfehlung: ±${recPct}% (Konfidenz ${confidence}, seit 2 Tagen stabil).\n` +
                    `Netto-APR: ${fmtPct(netCur)} → ${fmtPct(netRec)}.\n` +
                    `→ Rebalance bei Bedarf manuell über ForgeSettings auslösen.`
                );
            } catch { /* notify-Fehler nicht propagieren */ }
        }
    }
}

// ─── Range-Hinweis: vorgezogenes Rebalance bei nicht mehr optimaler Range ─────
// Modul-State: Stabilitäts-Tracker je Pool (überlebt Loop-Iterationen, resettet bei Neustart).
const _rangeHintState = new Map(); // poolId → { recPct, count }

/**
 * Prüft alle aktiven Pools, ob ein vorgezogenes Rebalance sich lohnen würde, und meldet
 * das als Hinweis (KEIN Auto-Apply — der Rebalance wird manuell über ForgeSettings
 * ausgelöst). Quelle ist der Range Advisor (analyzePool). Gilt für aktive Pools mit
 * offener Position und ohne rangeOverride.locked — bei gelockten Pools würde der
 * ForgeSettings-Tooltip die Empfehlung ohnehin nicht anzeigen (pools.js: Filter auf
 * `locked !== true`), die Notification hätte also keinen Mehrwert (#0198 Fix #2).
 * Die aktuelle Range kommt aus dem Override-fixedPct oder, falls keiner gesetzt ist,
 * aus den Ticks der offenen Position.
 *
 * Schutz gegen Spam (Vorgabe „nicht zu oft"):
 *  1. Stabilität: dieselbe Empfehlung in ≥2 aufeinanderfolgenden Läufen (in-memory).
 *  2. Profitabilität: nur wenn der Reopen sich rechnet — Payback < PAYBACK_MAX_D Tage.
 *  3. Backoff: pro Pool max. 1 Hinweis / 12h; ist die Empfehlung seit dem letzten Hinweis
 *     unverändert (= ignoriert), steigt der Abstand auf 48h.
 *
 * @param {Array} activePools
 */
async function _advisorRangeHintScan(activePools) {
    const STEP_MIN               = 2;              // ≥2 Candidate-Stufen Abweichung
    const STABILITY_RUNS         = 2;              // gleiche Empfehlung in N Läufen
    const PAYBACK_MAX_H          = 12;             // Hinweis nur wenn Payback ≤ 12h
    const REBALANCE_COOLDOWN_MS  = 6 * 3_600_000; // kein Hinweis wenn Rebalance in letzten 6h
    const COOLDOWN_NEW_MS        = 12 * 3_600_000; // neue/geänderte Empfehlung
    const COOLDOWN_SAME_MS       = 48 * 3_600_000; // unveränderte (ignorierte) Empfehlung
    const REOPEN_COST_FALLBACK_USDC = 1.5;         // konservativ, falls keine Empirie

    for (const pool of activePools) {
        if (pool.rangeOverride?.locked === true) { _rangeHintState.delete(pool.id); continue; }

        // Aktuelle Range bestimmen: Override-fixedPct, sonst reale Position-Ticks.
        let currentPct = pool.rangeOverride?.fixedPct ?? null;
        const pos = getOpenPosition(db, pool.id);
        if (!pos) { _rangeHintState.delete(pool.id); continue; } // kein Rebalance ohne Position
        if (currentPct == null) {
            if (!Number.isFinite(pos.tick_lower) || !Number.isFinite(pos.tick_upper)
                    || pos.tick_upper <= pos.tick_lower) {
                _rangeHintState.delete(pool.id);
                continue; // keine ableitbare Range
            }
            currentPct = (Math.pow(1.0001, (pos.tick_upper - pos.tick_lower) / 2) - 1) * 100;
        }

        let advice;
        try {
            advice = await analyzePool(pool, db);
        } catch (err) {
            console.log(`[advisor:${pool.id}] Range-Hinweis: Advisor nicht verfügbar: ${err.message}`);
            continue;
        }
        if (!advice) continue;

        const recPct     = advice.recommendation.rangePct;
        const confidence = advice.recommendation.confidence;
        if (confidence === 'low') { _rangeHintState.delete(pool.id); continue; }

        // ── Stabilität (in-memory): gleiche Empfehlung über mehrere Läufe ──
        // Der Zähler wird zurückgesetzt, sobald sich die Empfehlung ODER die Ist-Range
        // ändert. Letzteres ist wichtig: der driftFactor koppelt die Empfehlung an die
        // Ist-Range (#0198) — würde man Läufe über einen Range-Wechsel hinweg zählen,
        // gälte eine durch den Wechsel selbst kippende Empfehlung fälschlich als stabil.
        const curIdx = _nearestCandidateIndex(currentPct);
        const recIdx = _nearestCandidateIndex(recPct);
        const prev = _rangeHintState.get(pool.id);
        if (prev && prev.recPct === recPct && prev.curIdx === curIdx) prev.count += 1;
        else _rangeHintState.set(pool.id, { recPct, curIdx, count: 1 });
        const stableCount = _rangeHintState.get(pool.id).count;

        // ── Gate 1: Abweichung ≥2 Candidate-Stufen ──
        if (Math.abs(recIdx - curIdx) < STEP_MIN) continue;

        // ── Gate 2: Profitabilität — lohnt sich der Reopen? ──
        // netCur: konfigurierte Range (currentScore) bzw. nächstliegender Candidate;
        // netRec: Optimum. Payback = Reopen-Kosten / täglicher Mehr-Ertrag.
        const curCand = (advice.candidates ?? []).reduce((best, c) =>
            (best == null || Math.abs(c.rangePct - currentPct) < Math.abs(best.rangePct - currentPct))
                ? c : best, null);
        const netCur  = advice.rationale.currentScore?.netAprPct ?? curCand?.netAprPct ?? null;
        const netRec  = advice.rationale.optimalScore?.netAprPct ?? null;
        const capital = advice.rationale.breakEven?.currentCapitalUsdc ?? null;
        if (netCur == null || netRec == null || !(capital > 0)) continue;

        const aprDeltaPct = netRec - netCur;
        if (aprDeltaPct <= 0) continue; // aktuelle Range schon ≥ optimal → kein Gewinn

        const dailyGainUsdc = aprDeltaPct / 100 / 365 * capital;
        if (!(dailyGainUsdc > 0)) continue;
        const emp = advice.rationale.empiricalRebalCost;
        const reopenCostUsdc = (emp && !emp.isFallback && emp.avgCostUsdc > 0)
            ? emp.avgCostUsdc : REOPEN_COST_FALLBACK_USDC;
        const paybackDays  = reopenCostUsdc / dailyGainUsdc;
        const paybackHours = paybackDays * 24;
        if (paybackHours > PAYBACK_MAX_H) continue;

        // ── Gate 3: Stabilität erreicht? ──
        if (stableCount < STABILITY_RUNS) continue;

        // ── Gate 4: Kein Rebalance (egal ob manuell oder Out-of-Range) in letzten 6h ──
        const recentRebalance = db.prepare(
            `SELECT id FROM rebalance_history WHERE pool_id = ? AND rebalanced_at >= ? LIMIT 1`
        ).get(pool.id, Date.now() - REBALANCE_COOLDOWN_MS);
        if (recentRebalance) continue;

        // ── Gate 5: Backoff seit letztem Hinweis (12h neu / 48h unverändert) ──
        const lastNotify = db.prepare(
            `SELECT recommended_range_pct, created_at FROM advisor_decisions
             WHERE pool_id = ? AND triggered_by = 'range_hint' AND action_taken = 'notified'
             ORDER BY created_at DESC LIMIT 1`
        ).get(pool.id);
        if (lastNotify) {
            const cooldown = lastNotify.recommended_range_pct === recPct
                ? COOLDOWN_SAME_MS : COOLDOWN_NEW_MS;
            if (Date.now() - lastNotify.created_at < cooldown) continue;
        }

        // ── Hinweis senden + protokollieren ──
        const pair = pool.displayPair ?? pool.pair;
        const attr = advice.rationale.optimalScore?.attritionPctPerMonth ?? null;
        console.log(
            `[advisor:${pool.id}] Range-Hinweis: ±${currentPct.toFixed(1)}% → ±${recPct}% ` +
            `(Payback ${paybackHours.toFixed(1)}h, +${aprDeltaPct.toFixed(1)}% APR) → Notification`
        );
        try {
            insertAdvisorDecision(db, {
                poolId: pool.id, triggeredBy: 'range_hint',
                currentRangePct: +currentPct.toFixed(2), recommendedRangePct: recPct,
                confidence, actionTaken: 'notified',
                netAprCurrent: netCur, netAprRecommended: netRec,
                attritionPctPerMonth: attr, capitalUsdc: capital,
                paybackHours: +paybackHours.toFixed(1),
            });
        } catch (err) {
            console.error(`[advisor:${pool.id}] insertAdvisorDecision (range_hint) fehlgeschlagen: ${err.message}`);
        }

        const fmtPct = v => v != null ? `${v.toFixed(1).replace('.', ',')}%` : '?';
        try {
            await notify.rangeHint(
                `Range-Hinweis – ${pair}`,
                `Aktuelle Range ±${currentPct.toFixed(1).replace('.', ',')}% ist nicht mehr optimal.\n` +
                `Empfehlung: ±${recPct}% (Konfidenz ${confidence}).\n` +
                `Netto-APR: ${fmtPct(netCur)} → ${fmtPct(netRec)} (Δ +${fmtPct(aprDeltaPct)}), ` +
                `Reopen amortisiert in ~${paybackDays < 2 ? `${Math.round(paybackDays * 24)} Stunden` : `${paybackDays.toFixed(1).replace('.', ',')} Tagen`}.\n` +
                `→ Rebalance bei Bedarf manuell über ForgeSettings auslösen.`
            );
        } catch { /* notify-Fehler nicht propagieren */ }
    }
}

// ─── Täglicher Advisor-Markdown-Bericht ──────────────────────────────────────

function _writeAdvisorDayReport(dateStr) {
    const dayStartMs = midnightTzMs(dateStr);
    const dayEndMs   = dayStartMs + 86_400_000;

    const rows = db.prepare(
        `SELECT pool_id, triggered_by, current_range_pct, recommended_range_pct,
                action_taken, rejection_reason, net_apr_current, net_apr_recommended,
                model_drift, attrition_pct_per_month, capital_usdc, confidence,
                created_at
         FROM advisor_decisions
         WHERE created_at >= ? AND created_at < ?
         ORDER BY pool_id, created_at ASC`
    ).all(dayStartMs, dayEndMs);

    const generatedAt = new Intl.DateTimeFormat('de-DE', {
        timeZone: FORGE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    }).format(new Date());

    const fmtTime = ms => new Intl.DateTimeFormat('de-DE', {
        timeZone: FORGE_TZ, hour: '2-digit', minute: '2-digit',
    }).format(new Date(ms));

    let md = `# Range Advisor – Tagesbericht ${dateStr}\n\n`;
    md += `Generiert: ${generatedAt} ${FORGE_TZ} | Zeitraum: ${dateStr} 00:00 – 23:59\n\n`;
    md += `---\n\n`;

    if (rows.length === 0) {
        md += `## Kein Handlungsbedarf\n\n`;
        md += `Keine Advisor-Entscheidungen am ${dateStr}. Alle Pools liefen ohne Rebalancing oder auffällige Advisor-Aktivität.\n`;
    } else {
        const poolIds = [...new Set(rows.map(r => r.pool_id))];
        const actionCounts = {};
        for (const r of rows) actionCounts[r.action_taken] = (actionCounts[r.action_taken] ?? 0) + 1;

        md += `## Zusammenfassung\n\n`;
        md += `${rows.length} Advisor-Entscheidung${rows.length !== 1 ? 'en' : ''} für ${poolIds.length} Pool${poolIds.length !== 1 ? 's' : ''}.\n\n`;
        for (const [action, count] of Object.entries(actionCounts)) md += `- ${count}× \`${action}\`\n`;
        md += `\n---\n\n`;

        md += `## Entscheidungen nach Pool\n\n`;

        const anomalies = [];

        for (const poolId of poolIds) {
            const poolRows = rows.filter(r => r.pool_id === poolId);
            md += `### ${poolId}\n\n`;
            md += `| Zeit  | Auslöser    | Ist-Range | Empfehlung | Aktion               | APR-Δ  | Drift | Attrition    |\n`;
            md += `|-------|-------------|-----------|------------|----------------------|--------|-------|--------------|\n`;

            for (const r of poolRows) {
                const von       = `±${r.current_range_pct}%`;
                const nach      = r.recommended_range_pct != null ? `±${r.recommended_range_pct}%` : '—';
                const delta     = (r.net_apr_current != null && r.net_apr_recommended != null)
                    ? `${r.net_apr_recommended - r.net_apr_current >= 0 ? '+' : ''}${(r.net_apr_recommended - r.net_apr_current).toFixed(1)}%`
                    : '—';
                const drift     = r.model_drift != null ? r.model_drift.toFixed(2) : '—';
                const attrition = r.attrition_pct_per_month != null ? `${r.attrition_pct_per_month.toFixed(1)}%/Mon` : '—';
                md += `| ${fmtTime(r.created_at)} | ${r.triggered_by.padEnd(11)} | ${von.padEnd(9)} | ${nach.padEnd(10)} | ${r.action_taken.padEnd(20)} | ${delta.padEnd(6)} | ${drift.padEnd(5)} | ${attrition} |\n`;
            }
            md += '\n';

            const changed  = poolRows.filter(r => r.action_taken === 'range_changed' || r.action_taken === 'attrition_widened');
            const notified = poolRows.filter(r => r.action_taken === 'notified');

            const comments = [];
            for (const r of changed) {
                const verb    = r.action_taken === 'attrition_widened' ? 'Attrition-Weitung' : 'Range-Änderung';
                const aprNote = (r.net_apr_current != null && r.net_apr_recommended != null)
                    ? ` APR-Verbesserung: ${r.net_apr_recommended - r.net_apr_current >= 0 ? '+' : ''}${(r.net_apr_recommended - r.net_apr_current).toFixed(1)}%.`
                    : '';
                comments.push(`**${verb}** ±${r.current_range_pct}% → ±${r.recommended_range_pct}% automatisch übernommen.${aprNote}`);
                if (r.model_drift != null && r.model_drift > 2.0) {
                    anomalies.push(`⚠️ **${poolId} – Model-Drift ${r.model_drift.toFixed(2)}**: Rebalancing-Häufigkeit ${r.model_drift.toFixed(1)}× höher als theoretisch — empirische Korrektur wurde angewendet.`);
                }
                if (r.attrition_pct_per_month != null && r.attrition_pct_per_month > 3) {
                    anomalies.push(`⚠️ **${poolId} – Attrition ${r.attrition_pct_per_month.toFixed(1)}%/Monat**: Kapitalverlust durch Slippage überschreitet 3%-Schwelle trotz Anpassung.`);
                }
            }
            for (const r of notified) {
                const aprNote = (r.net_apr_current != null && r.net_apr_recommended != null)
                    ? ` Netto-APR: ${r.net_apr_current.toFixed(1)}% → ${r.net_apr_recommended.toFixed(1)}%.`
                    : '';
                comments.push(`**Empfehlung versandt:** ±${r.current_range_pct}% → ±${r.recommended_range_pct}% (Konfidenz: ${r.confidence ?? '?'}).${aprNote} Noch nicht automatisch übernommen.`);
                if (r.attrition_pct_per_month != null && r.attrition_pct_per_month > 3) {
                    anomalies.push(`⚠️ **${poolId} – Attrition ${r.attrition_pct_per_month.toFixed(1)}%/Monat**: Kapitalverlust durch Slippage überschreitet 3%-Schwelle — Handlungsbedarf.`);
                }
                if (r.model_drift != null && r.model_drift > 2.0) {
                    anomalies.push(`⚠️ **${poolId} – Model-Drift ${r.model_drift.toFixed(2)}**: Rebalancing-Häufigkeit ${r.model_drift.toFixed(1)}× höher als theoretisch.`);
                }
            }

            if (comments.length > 0) {
                md += `**Auswertung:** ` + comments.join(' ') + '\n\n';
            } else {
                md += `*(Keine automatischen Aktionen — nur Beobachtung protokolliert.)*\n\n`;
            }
        }

        const uniqueAnomalies = [...new Set(anomalies)];
        if (uniqueAnomalies.length > 0) {
            md += `---\n\n## Auffälligkeiten\n\n`;
            for (const a of uniqueAnomalies) md += `- ${a}\n`;
            md += '\n';
        }

        md += `---\n\n## Gesamtbewertung\n\n`;
        const changedCount  = rows.filter(r => r.action_taken === 'range_changed' || r.action_taken === 'attrition_widened').length;
        const notifCount    = rows.filter(r => r.action_taken === 'notified').length;
        const parts = [];
        if (changedCount > 0)            parts.push(`${changedCount} Range${changedCount !== 1 ? 's' : ''} wurde${changedCount !== 1 ? 'n' : ''} automatisch angepasst.`);
        if (notifCount  > 0)             parts.push(`${notifCount} unbehandelte Empfehlung${notifCount !== 1 ? 'en' : ''} — bei nächster Gelegenheit prüfen.`);
        if (uniqueAnomalies.length > 0)  parts.push(`${uniqueAnomalies.length} Auffälligkeit${uniqueAnomalies.length !== 1 ? 'en' : ''} — Details oben.`);
        if (parts.length === 0)          parts.push('Alle Advisor-Aktivitäten lagen im erwarteten Rahmen.');
        md += parts.join(' ') + '\n';
    }

    const logDir = join(PATHS.liquidityLogs, 'advisor');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(resolve(logDir, `${dateStr}.md`), md, 'utf8');
    console.log(`[bot] Advisor-Tagesbericht geschrieben: logs/advisor/${dateStr}.md`);

    // Dateien älter als 30 Tage löschen
    const cutoffStr = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ })
        .format(new Date(dayStartMs - 29 * 86_400_000));
    for (const f of readdirSync(logDir).filter(n => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))) {
        if (f.replace('.md', '') < cutoffStr) {
            try { unlinkSync(resolve(logDir, f)); } catch { /* ignore */ }
        }
    }
}

// ─── SOL-Vorsicherung für kapitalbindende Pfade ──────────────────────────────

/**
 * Gemeinsame SOL-Vorsicherung für _openNewPosition() und _reinvest().
 *
 * Zweistufig (2026-07-30): Unterhalb des Invest-Puffers (Reserve + 0,05) wird ZUERST
 * nachgetankt, statt wie bisher erst beim nächsten Zyklus-Self-Heal. Übersprungen
 * wird weiterhin nur unter der harten Reserve — Begründung siehe
 * INVEST_SOL_COMFORT in lib/sol-topup.js.
 *
 * Lock: ensureWalletSol() swappt und erwartet Koordination durch den Aufrufer.
 * Läuft gerade ein Cleanup, wird bewusst NICHT gewartet: cleanup.js tankt am
 * Laufanfang ohnehin selbst auf, und ein Warten (waitForCleanupToFinish, bis 15 Min)
 * würde im Reinvest-Pfad den botop.lock überdauern (Stale nach 3 Min) und damit
 * manuelle Aktionen fälschlich freigeben.
 *
 * @returns {Promise<number|null>} SOL-Stand, oder null wenn der Aufrufer sauber
 *   abbrechen soll (kein Fehler, keine Notification).
 */
async function _ensureSolForInvest(poolId, context) {
    const keypair = getKeypair();
    // Bewusst der frische Read (nicht der Proxy-Cache): Dieser Guard existiert genau
    // wegen kurzfristiger Wallet-Änderungen — ein gecachter, zu hoher Wert würde den
    // Topup überspringen und die Race wieder öffnen, die er schließen soll. Die Pfade
    // hierher sind selten (Öffnen nur ohne offene Position, Reinvest nur nach echtem
    // Fee-Claim), der zusätzliche Call fällt gegenüber dem Bulk-State-Fetch nicht ins Gewicht.
    let sol = await getSolBalanceFresh(keypair.publicKey);

    if (sol < INVEST_SOL_COMFORT && !isCleanupRunning()) {
        acquireSlLock();
        try {
            const res = await ensureInvestCapableSol(db, keypair, getConnection(), {
                log: msg => console.log(`[bot:${poolId}] ${msg}`),
            });
            sol = res.sol;
        } catch (err) {
            console.warn(`[bot:${poolId}] SOL-Vorsicherung fehlgeschlagen: ${err.message}`);
        } finally {
            releaseSlLock();
        }
    }

    if (sol < config.solReserve) {
        console.log(`[bot:${poolId}] ${context} übersprungen: SOL-Balance (${sol.toFixed(4)}) unter Reserve (${config.solReserve} SOL)`);
        return null;
    }
    return sol;
}

// ─── Position öffnen ──────────────────────────────────────────────────────────

async function _openNewPosition(pool, adapter) {
    console.log(`[bot:${pool.id}] Öffne neue Position...`);

    // Pre-Flight: SOL-Reserve prüfen (symmetrisch zu _reinvest)
    // Verhindert "insufficient funds (0x1)"-Simulation-Fail bei zu wenig SOL für Fees.
    if (await _ensureSolForInvest(pool.id, 'Öffnen') == null) return null;

    let stats;
    try {
        stats = await adapter.getPoolStats(pool);
    } catch (err) {
        console.error(`[bot:${pool.id}] Preis nicht abrufbar: ${err.message}`);
        return null;
    }

    const currentPrice = stats.price;
    const SOL_MINT     = 'So11111111111111111111111111111111111111112';

    // Kapital-Check VOR jedem Pre-Swap (alle Pool-Typen, nicht nur volatilePair):
    // verhindert einen sinnlosen Swap, wenn das Wallet (z.B. nach Score-Limit-Exit und
    // Kapital-Umverteilung an andere Pools) schlicht nicht genug für eine sinnvolle
    // Position hat. Gleiche 30%-Schwelle wie _preFlightOpenGuard weiter unten — nur
    // eben bevor überhaupt etwas getauscht wird, nicht erst danach.
    const lastPosForCheck = db.prepare(
        `SELECT capital_usdc FROM positions WHERE pool_id = ? ORDER BY opened_at DESC LIMIT 1`
    ).get(pool.id);
    const checkTargetUsdc = lastPosForCheck?.capital_usdc ?? pool.capitalUSDC ?? 1000;
    const [preCheckABal, preCheckBBal] = await Promise.all([
        pool.tokenA === SOL_MINT
            ? getUsableSolBalanceFresh(getKeypair().publicKey)
            : getTokenBalanceFresh(getKeypair().publicKey, pool.tokenA, pool.decimalsA),
        getTokenBalanceFresh(getKeypair().publicKey, pool.tokenB, pool.decimalsB),
    ]);
    const walletUsdValue  = _calcUsdValue(pool, db, currentPrice, preCheckABal, preCheckBBal);
    // Schwelle: relative 30-%-Schranke UND – falls konfiguriert – der absolute
    // CLEANUP_MIN_DEPOSIT-Floor (frisch aus .env, da ForgeSettings ihn zur Laufzeit ändert).
    // Der Floor verhindert, dass ein zu kleines/korruptes capital_usdc der Vorposition die
    // relative Schranke unterläuft und so eine wirtschaftlich unsinnige Mini-Position öffnet
    // (TX-Fees > Ertrag). Spiegelt exakt den Reaktivierungs-Guard in cleanup.js.
    const minDepositFloor  = getCleanupMinDepositFromEnv();
    const minAcceptableUsd = Math.max(checkTargetUsdc * 0.30, minDepositFloor);
    if (walletUsdValue < minAcceptableUsd) {
        const floorNote = minDepositFloor > 0 ? `, Min-Floor ${minDepositFloor.toFixed(2)}` : '';
        const reason = `Wallet-Kapital ${walletUsdValue.toFixed(2)} USDC < ${minAcceptableUsd.toFixed(2)} USDC ` +
            `(30 % von Ziel ${checkTargetUsdc.toFixed(2)}${floorNote}) – kein Pre-Swap, Kapital reicht nicht für sinnvolle Position.`;
        console.error(`[bot:${pool.id}] _openNewPosition abgebrochen: ${reason}`);
        await notify.error(pool.displayPair ?? pool.pair, new Error(`Position öffnen: ${reason}`));
        return null;
    }

    // Token-Mix vor dem Öffnen ausgleichen (Fix 3: Pre-Swap bei Imbalance)
    await _preSwapIfNeeded(pool, currentPrice);

    // Kapital 50/50 aufteilen (nach USDC-Äquivalent)
    // Zielkapital aus letzter DB-Position; Fallback auf Wallet-Balance (z.B. erster Start).
    // Fresh-Reads: Balances nach eventuell vorherigem Pre-Swap von Chain lesen.
    const MIN_REOPEN_CAPITAL = 5.0; // USDC – Kleinstpositionen aus DB blockieren keine neuen Deposits
    const lastPos  = lastPosForCheck;

    const effectiveRange = pool.rangeOverride ? { ...config.range, ...pool.rangeOverride } : config.range;
    const range = (await _getAdvisedRange(pool, currentPrice, lastPos?.capital_usdc ?? pool.capitalUSDC ?? 1000))
               ?? calculateRange(pool, currentPrice, effectiveRange, db);
    let amountA, amountB;

    // Wallet-Cap: Orca-DEFAULT_SLIPPAGE = 1% → tokenMax wird mit (1+slippage) berechnet.
    // Wenn amountX = walletX, fordert die TX walletX × 1.01 → InsufficientFunds (0x1).
    // 0.985 deckt 1% Slippage + 0.5% Sicherheitspuffer.
    const WALLET_CAP = 0.985;

    if (pool.volatilePair) {
        // volatilePair: beide Tokens müssen vor openPosition befüllt sein.
        // _balanceWalletForPair bringt den Wallet-Mix mit Retry auf 50/50-USD; bei
        // Fehler bricht _openNewPosition ab (kein Tiny-Position-Lock-in).
        const targetUsdc = lastPos?.capital_usdc ?? pool.capitalUSDC ?? 1000;
        const balanceRes = await _balanceWalletForPair(pool, currentPrice, targetUsdc);
        if (!balanceRes.success) {
            console.error(`[bot:${pool.id}] _openNewPosition abgebrochen: Wallet-Balance fehlgeschlagen — ${balanceRes.reason}`);
            await notify.error(pool.displayPair ?? pool.pair,
                new Error(`Position öffnen: Pre-Swap fehlgeschlagen: ${balanceRes.reason}. ` +
                          `Kapital im Wallet, nächster Bot-Tick versucht erneut.`));
            return null;
        }
        // Cap auf targetUsdc – verhindert dass überschüssiges Wallet-Kapital
        // (z.B. freigesetztes Kapital aus Score Limit) beim Rebalancing versehentlich
        // vollständig in diesen Pool fließt. Nur wenn capitalUSDC=0 UND keine Vorposition
        // vorhanden (echter Erststart), wird das gesamte Wallet genutzt.
        if (targetUsdc > 0) {
            const qPrice = _getQuotePrice(pool, db);
            const qIsA   = pool.quoteTokenMint === pool.tokenA;
            const usdPerA = qIsA ? qPrice : qPrice * currentPrice;
            const usdPerB = qIsA ? (currentPrice > 0 ? qPrice / currentPrice : 0) : qPrice;
            const halfCap = targetUsdc / 2;
            amountA = Math.min(balanceRes.tokenABal * WALLET_CAP, usdPerA > 0 ? halfCap / usdPerA : balanceRes.tokenABal * WALLET_CAP);
            amountB = Math.min(balanceRes.tokenBBal * WALLET_CAP, usdPerB > 0 ? halfCap / usdPerB : balanceRes.tokenBBal * WALLET_CAP);
        } else {
            amountA = balanceRes.tokenABal * WALLET_CAP;
            amountB = balanceRes.tokenBBal * WALLET_CAP;
        }
    } else if (pool.usdcIsTokenA) {
        // tokenA = USDC, tokenB = volatiles Asset (z.B. EURC)
        const tokenABal   = await getTokenBalanceFresh(getKeypair().publicKey, pool.tokenA, pool.decimalsA);
        const tokenBBal   = await getTokenBalanceFresh(getKeypair().publicKey, pool.tokenB, pool.decimalsB);
        const _histCapA   = lastPos?.capital_usdc ?? tokenABal;
        const halfCapital = ((_histCapA < MIN_REOPEN_CAPITAL && tokenABal > _histCapA)
            ? tokenABal : _histCapA) / 2;
        amountA = Math.min(halfCapital, tokenABal * WALLET_CAP);
        amountB = Math.min(halfCapital * currentPrice, tokenBBal * WALLET_CAP);
    } else {
        // tokenB = USDC, tokenA = volatiles Asset (SOL, BTC, ...)
        const tokenABal   = pool.tokenA === SOL_MINT
            ? await getUsableSolBalanceFresh(getKeypair().publicKey)
            : await getTokenBalanceFresh(getKeypair().publicKey, pool.tokenA, pool.decimalsA);
        const tokenBBal   = await getTokenBalanceFresh(getKeypair().publicKey, pool.tokenB, pool.decimalsB);
        const _histCapB   = lastPos?.capital_usdc ?? tokenBBal;
        const halfCapital = ((_histCapB < MIN_REOPEN_CAPITAL && tokenBBal > _histCapB)
            ? tokenBBal : _histCapB) / 2;
        amountA = Math.min(halfCapital / currentPrice, tokenABal * WALLET_CAP);
        amountB = Math.min(halfCapital, tokenBBal * WALLET_CAP);
    }

    // ── Max-Einzahlung pro Aktion (ForgeSettings → CLEANUP_MAX_DEPOSIT) ──────────
    // Greift auch hier, nicht nur im Cleanup-Deposit: Wird ein Pool durch Cleanup
    // reaktiviert (kein Vorposition), eröffnet der Bot die Position — ohne diesen
    // Cap würde das gesamte Wallet-USDC auf einen Schlag in den Pool fließen.
    // Skaliert beide Token-Mengen proportional (50/50-Ratio bleibt erhalten).
    // Ausnahme: JEDER Reopen nach einem Close derselben Position (egal ob manueller
    // close-and-reopen note='manual-deposit' oder automatischer Bot-Rebalance/-Exit
    // wie 'rebalance', 'stop-loss', 'take-profit', 'score-limit', 'trailing-stop',
    // 'tvl-protection-l2') stellt bestehendes Kapital wieder her — kein frischer
    // Zufluss, nicht kappen. Bug-Historie: vor diesem Fix wurde nur 'manual-deposit'
    // ausgenommen, wodurch automatische Rebalances fälschlich wie Cleanup-Erstdeposits
    // gekappt wurden und Bestandskapital schrumpfte (TSLAx/USDC 693→100 USDC, 2026-07-08).
    const maxDepositUsdc = getCleanupMaxDepositFromEnv();
    let depositCapApplied = 0;   // > 0 wenn gekappt → senkt auch die Tiny-Position-Guard-Referenz
    if (maxDepositUsdc > 0) {
        const isPreservationReopen = !!db.prepare(
            `SELECT 1 FROM transactions
              WHERE pool_id = ? AND type = 'close_position'
                AND created_at > ? LIMIT 1`
        ).get(pool.id, Date.now() - 30 * 60_000);
        if (!isPreservationReopen) {
            const committedUsd = _calcUsdValue(pool, db, currentPrice, amountA, amountB);
            if (committedUsd > maxDepositUsdc) {
                const scale = maxDepositUsdc / committedUsd;
                amountA *= scale;
                amountB *= scale;
                depositCapApplied = maxDepositUsdc;
                console.log(
                    `[bot:${pool.id}] Max-Einzahlung aktiv: Deposit auf ${maxDepositUsdc.toFixed(2)} USDC ` +
                    `gekappt (von ${committedUsd.toFixed(2)} USDC) – Rest bleibt liquide für nächsten Cleanup-Zyklus`
                );
            }
        }
    }

    const [symA, symB] = pool.pair.split('/');
    console.log(
        `[bot:${pool.id}] Range: ${range.priceLower.toFixed(4)} – ${range.priceUpper.toFixed(4)}` +
        ` | Kapital: ${amountA.toFixed(4)} ${symA} + ${amountB.toFixed(4)} ${symB}`
    );

    // Pre-Flight Guard: verhindert Tiny-Positions (siehe Doku am Helper).
    // Bei aktivem Deposit-Cap ist die kleinere, gewollt gekappte Menge die korrekte
    // Referenz — sonst würde der Guard eine absichtlich gekappte Position fälschlich
    // als „zu winzig" (< 30 % vom konfigurierten capitalUSDC) ablehnen.
    const guardTargetUsdc = depositCapApplied > 0
        ? depositCapApplied
        : (lastPos?.capital_usdc ?? pool.capitalUSDC ?? 1000);
    const guardOpen = _preFlightOpenGuard(pool, currentPrice, amountA, amountB, guardTargetUsdc);
    if (!guardOpen.ok) {
        console.error(`[bot:${pool.id}] _openNewPosition abgebrochen: ${guardOpen.reason}`);
        await notify.error(pool.displayPair ?? pool.pair, new Error(`Position öffnen: ${guardOpen.reason}`));
        return null;
    }

    try {
        await assertSufficientSol(getKeypair().publicKey);
        const result = await adapter.openPosition(
            pool,
            range.tickLower,
            range.tickUpper,
            amountA,
            amountB,
        );
        _openPositionFailCount.delete(pool.id); // Erfolg → Zähler zurücksetzen

        // Tatsächlich deponierte Token-Mengen aus Liquidität berechnen
        // (Orca CLMM legt den exakten Mix fest, nicht die angeforderten amountA/amountB)
        const liquidityBN = new BN(result.liquidity);
        const sqrtPrice   = PriceMath.priceToSqrtPriceX64(
            new Decimal(currentPrice), pool.decimalsA, pool.decimalsB
        );
        const sqrtLower   = PriceMath.tickIndexToSqrtPriceX64(range.tickLower);
        const sqrtUpper   = PriceMath.tickIndexToSqrtPriceX64(range.tickUpper);
        const realAmounts = PoolUtil.getTokenAmountsFromLiquidity(
            liquidityBN, sqrtPrice, sqrtLower, sqrtUpper, false
        );
        const realTokenA = new Decimal(realAmounts.tokenA.toString())
            .div(new Decimal(10).pow(pool.decimalsA)).toNumber();
        const realTokenB = new Decimal(realAmounts.tokenB.toString())
            .div(new Decimal(10).pow(pool.decimalsB)).toNumber();

        console.log(
            `[bot:${pool.id}] Tatsächlich deponiert: ${realTokenA.toFixed(6)} TokenA + ` +
            `${realTokenB.toFixed(2)} TokenB (angefordert: ${amountA.toFixed(6)} / ${amountB.toFixed(2)})`
        );

        const realCapitalUsdc = _calcUsdValue(pool, db, currentPrice, realTokenA, realTokenB);

        // Echte neue Position (kein Rebalancing) → PnL-History zurücksetzen
        clearPositionSnapshots(db, pool.id);
        const posId = insertPosition(db, {
            poolId:       pool.id,
            nftMint:      result.nftMint,
            tickLower:    range.tickLower,
            tickUpper:    range.tickUpper,
            priceLower:   range.priceLower,
            priceUpper:   range.priceUpper,
            liquidity:    result.liquidity,
            capitalUsdc:  realCapitalUsdc,
            hodlTokenA:   realTokenA,
            hodlTokenB:   realTokenB,
            hodlPriceUsd: currentPrice,
            openTx:       result.txHash,
            openedAt:     Date.now(),
        });

        const openPosFee = await getTxFee(result.txHash);
        insertTransaction(db, {
            poolId:   pool.id,
            type:     'open_position',
            amountA:  realTokenA,
            amountB:  realTokenB,
            usdValue: realCapitalUsdc,
            txHash:   result.txHash,
            txFeeSol: openPosFee,
            note:     `Tick ${range.tickLower} – ${range.tickUpper}`,
        });

        // Seit v0.3.47: bot-internes Öffnen einer Position ist KEIN Kapital-Flow.
        // Wallet-USDC wandert in LP — Portfolio-Total bleibt gleich, nichts wird
        // ein- oder ausgezahlt. Kein capital_flows-Eintrag hier (cleanup-Reinvest,
        // wird über fees_to_wallet in calcPnl korrekt erfasst).

        _resetPoolSettings(pool.id);

        await notify.positionOpened(pool, {
            priceLower: range.priceLower,
            priceUpper: range.priceUpper,
            nftMint:    result.nftMint,
            txHash:     result.txHash,
        });

        console.log(`[bot:${pool.id}] Position geöffnet (DB-ID: ${posId})`);

        // ── Kapitalerhalt nach manuellem close-and-reopen ──────────────────────────
        // close-and-reopen.js schließt nur; der Bot eröffnet hier neu. Ohne Top-up
        // schrumpft der Pool (deployed < Wert vor dem Rebalance), Restkapital bleibt idle.
        // Greift NUR wenn dieser Pool kürzlich via close-and-reopen.js geschlossen wurde
        // (close_position note='manual-deposit') — NICHT bei Cleanup-Erstdeposits oder
        // RM-Exits. Zahlt gekappt genau die Differenz (V_before − deployed) nach.
        try {
            const recentClose = db.prepare(
                `SELECT amount_a, amount_b FROM transactions
                  WHERE pool_id = ? AND type = 'close_position' AND note = 'manual-deposit'
                    AND created_at > ? AND amount_a IS NOT NULL
                  ORDER BY created_at DESC LIMIT 1`
            ).get(pool.id, Date.now() - 30 * 60_000);

            if (recentClose) {
                // V_before korrekt in USD berechnen: close-and-reopen.js nutzte die naive
                // Formel (amountA*price+amountB) ohne quotePrice-Faktor → falscher Wert für
                // volatilePairs (z.B. SOL/ORCA, SOL/HYPE). _calcUsdValue gibt echten USDC-Wert.
                const closeStatsPrice = getPoolStats(db, pool.id, 1)[0]?.price ?? currentPrice;
                const vBefore = _calcUsdValue(pool, db, closeStatsPrice, recentClose.amount_a, recentClose.amount_b);

                if (vBefore > realCapitalUsdc * 1.03) {
                    const shortfall = vBefore - realCapitalUsdc;
                    console.log(`[bot:${pool.id}] Kapitalerhalt: V_before=${vBefore.toFixed(2)} > deployed=${realCapitalUsdc.toFixed(2)} USDC → Top-up bis ${shortfall.toFixed(2)} USDC (gekappt).`);
                    const toppedUp = await _reconcileWalletIntoPosition(pool, adapter, {
                        id:          posId,
                        nftMint:     result.nftMint,
                        capitalUsdc: realCapitalUsdc,
                        priceLower:  range.priceLower,
                        priceUpper:  range.priceUpper,
                    }, currentPrice, { maxReconcileUsdc: shortfall });

                    const totalAfter = realCapitalUsdc + toppedUp;
                    const ratio      = vBefore > 0 ? totalAfter / vBefore : 1;
                    if (ratio < 0.90) {
                        const msg = `Kapitalerhalt nach Reopen unvollständig: ${totalAfter.toFixed(2)} / ${vBefore.toFixed(2)} USDC (${(ratio * 100).toFixed(1)}%) — Rest bleibt idle.`;
                        console.warn(`[bot:${pool.id}] ${msg}`);
                        try { await notify.info(`Reopen-Topup ${pool.displayPair ?? pool.pair}`, msg); } catch { /* notify-Fehler nicht propagieren */ }
                    } else {
                        console.log(`[bot:${pool.id}] Kapitalerhalt OK: ${(ratio * 100).toFixed(1)}% (${totalAfter.toFixed(2)} / ${vBefore.toFixed(2)} USDC restauriert)`);
                    }
                }
            }
        } catch (err) {
            console.error(`[bot:${pool.id}] Kapitalerhalt-Topup fehlgeschlagen (ignoriert): ${err.message}`);
        }

        // Pflicht-Refresh: erste Position / Re-Open verändert LP und Wallet grundlegend.
        // lastSnapshot=0 erzwingt Step 6 im nächsten Tick → frischer position_snapshot
        // mit on-chain state der gerade eröffneten Position.
        try {
            await refreshAfterAction(db, { log: msg => console.log(`[bot:${pool.id}] ${msg}`) });
            lastSnapshot.set(pool.id, 0);
            lastExport.ts = Date.now();
        } catch (err) {
            console.error(`[bot:${pool.id}] refreshAfterAction nach Open fehlgeschlagen: ${err.message}`);
        }

        return getOpenPosition(db, pool.id);

    } catch (err) {
        const msg = typeof err.message === 'string' ? err.message : '';
        const isTransient =
            err.name === 'TransactionExpiredBlockheightExceededError' ||
            msg.includes('Blockhash not found');
        console.error(`[bot:${pool.id}] openPosition Fehler: ${err.message}`);
        if (err.solBalance !== undefined) {
            await notify.solLow(err.solBalance);
        } else if (isTransient) {
            console.warn(`[bot:${pool.id}] openPosition transient – wird im nächsten Zyklus wiederholt`);
        } else {
            const fails = (_openPositionFailCount.get(pool.id) ?? 0) + 1;
            _openPositionFailCount.set(pool.id, fails);
            if (fails >= MAX_OPEN_POSITION_FAILS) {
                _openPositionFailCount.delete(pool.id);
                setPoolActive(pool.id, false);
                await notify.openPositionGaveUp(pool, err, 'beim Öffnen', fails);
                console.error(`[bot:${pool.id}] openPosition ${fails}× fehlgeschlagen – Pool automatisch deaktiviert.`);
            } else if (fails >= 2) {
                await notify.openPositionError(pool, err, 'beim Öffnen');
            } else {
                console.warn(`[bot:${pool.id}] openPosition Fehler (${fails}/${MAX_OPEN_POSITION_FAILS} – warte auf Bestätigung im nächsten Zyklus): ${msg.split('\n')[0]}`);
            }
        }
        return null;
    }
}

// ─── Rebalancing ──────────────────────────────────────────────────────────────

async function _doRebalance(pool, position, state, adapter, reason = 'out_of_range') {
    // Cooldown prüfen (manuelle Trigger ignorieren den Cooldown)
    const cooldownMin = config.rebalance.cooldownMinutes;
    const minutesSince = getMinutesSinceLastRebalance(db, pool.id);
    if (reason !== 'manual' && minutesSince < cooldownMin) {
        const waitMin = Math.ceil(cooldownMin - minutesSince);
        console.warn(
            `[bot:${pool.id}] Cooldown aktiv (letztes Rebalance vor ${minutesSince.toFixed(0)} Min, ` +
            `min. ${cooldownMin} Min). Überspringe – erneut möglich in ${waitMin} Min.`
        );
        return;
    }

    // Läuft eine manuelle Aktion (deposit/withdraw/close-and-reopen), weicht der Bot
    // aus (3× warten, dann überspringen) — kein gleichzeitiges Mutieren derselben
    // Position. Beim nächsten Tick wird erneut geprüft.
    if (!(await _yieldToManualAction(pool.id, `Rebalance (${reason})`))) return;

    console.log(`[bot:${pool.id}] Rebalancing startet (reason=${reason})...`);

    acquireRebalanceLock();
    try {

    const oldRange = {
        priceLower: position.price_lower,
        priceUpper: position.price_upper,
    };

    // Topf-A-Erhalt (nur Nicht-volatilePair-Pools, d.h. alle USDC-/RWA-Pools):
    // Der Wallet-Bestand, der BEREITS vor dem Rebalance herumliegt (über mehrere
    // Rebalances akkumulierter Dust, Reserven anderer Pools, manuelle Transfers),
    // bleibt unangetastet. Nur Kapital, das DURCH diesen Rebalance ins Wallet kommt
    // — geclaimte Reinvest-Fees + die aus der geschlossenen Position freigesetzten
    // Token — wird zu 100 % wieder deployed. Dadurch wird die neue Position nicht
    // mehr auf den alten Buchwert getrimmt (das erzeugte bisher bei jedem Rebalance
    // frischen Dust), sondern kommt so nah wie möglich an ihren Vorwert.
    // WICHTIG: Messung VOR dem Fee-Claim, damit die im Rebalance geclaimten
    // Reinvest-Fees als „neu hereingekommen" zählen und mit-redeployed werden.
    const _preserveBaseline = !pool.volatilePair;
    let baseWalletA = 0, baseWalletB = 0;
    if (_preserveBaseline) {
        const _kpPub = getKeypair().publicKey;
        baseWalletA = pool.tokenA === SOL_MINT
            ? await getUsableSolBalanceFresh(_kpPub)
            : await getTokenBalanceFresh(_kpPub, pool.tokenA, pool.decimalsA);
        baseWalletB = pool.tokenB === SOL_MINT
            ? await getUsableSolBalanceFresh(_kpPub)
            : await getTokenBalanceFresh(_kpPub, pool.tokenB, pool.decimalsB);
        console.log(`[bot:${pool.id}] Topf-A-Baseline (bleibt unangetastet): A=${baseWalletA.toFixed(6)}, B=${baseWalletB.toFixed(6)}`);
    }

    // 1. Fees zuerst claimen (sind sonst verloren)
    let claimedA = 0, claimedB = 0;
    if (state.feesOwedA > 0 || state.feesOwedB > 0) {
        try {
            const feeResult = await adapter.collectFees(pool, position.nft_mint, {
                expectedA: state.feesOwedA, expectedB: state.feesOwedB,
            });
            claimedA = feeResult.amountA;
            claimedB = feeResult.amountB;
            const rebPrice = getPoolStats(db, pool.id, 1)[0]?.price ?? null;
            const rebUsdValue = rebPrice != null ? _calcUsdValue(pool, db, rebPrice, claimedA, claimedB) : null;
            insertFeeHistory(db, {
                poolId:     pool.id,
                positionId: position.id,
                amountA:    claimedA,
                amountB:    claimedB,
                usdValue:   rebUsdValue,
                action:     'rebalance',
                txHash:     feeResult.txHash,
            });
            insertTransaction(db, {
                poolId: pool.id, type: 'claim',
                amountA: claimedA, amountB: claimedB,
                usdValue: rebUsdValue, txHash: feeResult.txHash,
                txFeeSol: feeResult.txFeeSol ?? null, note: 'vor-rebalance',
            });

            // sendTo-Portion vor dem Position-Schließen transferieren.
            // _reinvest entfällt hier – der Reinvest-Anteil der Fees geht beim
            // Reopen automatisch über die Wallet-Balance in die neue Position ein.
            lastFeeClaim.set(pool.id, Date.now()); // verhindert Doppel-Claim im nächsten Zyklus
            const rebAc       = _getFeeClaimSettings(pool.id);
            const rebFraction = Number.isFinite(Number(rebAc?.fraction))
                ? Math.min(100, Math.max(10, Number(rebAc.fraction))) : 100;
            const rebSendTo   = (typeof rebAc?.sendTo === 'string' && rebAc.sendTo.trim())
                ? rebAc.sendTo.trim() : null;
            const rebSwapUsdc = rebAc?.swapToUsdc === true;
            const rebAcEnabled = rebAc?.enabled !== false;

            if (rebSendTo) {
                let sendA, sendB;
                if (!rebAcEnabled) {
                    // AC deaktiviert → alle Fees weiterleiten
                    sendA = claimedA; sendB = claimedB;
                } else if (rebFraction < 100) {
                    // Reinvest-Anteil verbleibt in Wallet, Rest weiterleiten
                    const f = rebFraction / 100;
                    sendA = claimedA * (1 - f); sendB = claimedB * (1 - f);
                }
                if (sendA > 0 || sendB > 0) {
                    await _claimFeeSendRemainder(pool, sendA, sendB, rebSendTo, rebSwapUsdc);
                }
            }
        } catch (err) {
            console.error(`[bot:${pool.id}] Fee-Claim vor Rebalancing fehlgeschlagen: ${err.message}`);
        }
    }

    // 2. Position schließen
    // Wallet-USDC-Stand vor dem Schließen merken: Für nicht-USDC-Pools produziert
    // close_position kein USDC. Vorher liegendes USDC (z.B. aus anderen Pools oder
    // manuellen Transfers) soll der Reconciler nicht in Pool-Tokens umtauschen.
    const _poolHasUsdc = pool.tokenA === USDC_MINT || pool.tokenB === USDC_MINT;
    const preExistingUsdc = _poolHasUsdc
        ? 0
        : await getTokenBalanceFresh(getKeypair().publicKey, USDC_MINT, 6);

    // HWM-Delta-Tracking: Werte vor dem Schließen sichern
    const preHwm   = position.hwm_usd ?? null;
    const preSnap  = db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).get(pool.id);
    const preValue = preSnap?.lp_value_usd ?? null;

    let closeTxHash;
    let closeAmountA, closeAmountB;
    let closeFee = 0;
    try {
        const closeResult = await adapter.closePosition(pool, position.nft_mint);
        closeTxHash  = closeResult.txHash;
        closeAmountA = closeResult.amountA;
        closeAmountB = closeResult.amountB;
        closePosition(db, position.id, closeTxHash);

        // Wert der abgezogenen Liquidität berechnen — _calcUsdValue deckt alle Pool-Typen
        // ab (volatilePair, usdcIsTokenA, Standard). Naive Formel `a*price+b`
        // ergibt für volatilePair einen Wert in Quote-Token-Einheiten statt USD.
        const closePrice = getPoolStats(db, pool.id, 1)[0]?.price ?? null;
        const closeUsdValue = closePrice != null
            ? _calcUsdValue(pool, db, closePrice, closeAmountA, closeAmountB)
            : null;

        closeFee = await getTxFee(closeTxHash);
        insertTransaction(db, {
            poolId: pool.id, type: 'close_position',
            amountA: closeAmountA, amountB: closeAmountB, usdValue: closeUsdValue,
            txHash: closeTxHash, txFeeSol: closeFee, note: 'rebalance',
        });
        _closePositionFailCount.delete(pool.id); // Erfolg → Zähler zurücksetzen
        clearRebalancePendingFlag(pool.id);      // Close sauber → Cleanup-Sperre aufheben

        // Sofortiger Portfolio-Refresh direkt nach dem Close, NOCH VOR dem Reopen:
        // closePosition() hat closed_at bereits gesetzt → die Position fällt im nächsten
        // writePortfolioSnapshot()-Aggregat raus (Join auf closed_at IS NULL), das Kapital
        // ist gleichzeitig frisch im Wallet sichtbar. Ohne diesen Refresh blieb
        // portfolio_history bis zum (ggf. minutenlangen, bei Retries noch längeren) Reopen
        // stale – das Dashboard zeigte den alten LP-Wert UND das neue Wallet-Guthaben
        // gleichzeitig, also das Rebalance-Kapital doppelt. Das Reopen unten greift
        // ausschließlich auf frische On-Chain-Reads zurück, ist von diesem Zwischen-Refresh
        // also unabhängig.
        try {
            await refreshAfterAction(db, { log: msg => console.log(`[bot:${pool.id}] ${msg}`) });
        } catch (err) {
            console.warn(`[bot:${pool.id}] Portfolio-Refresh nach Close fehlgeschlagen (ignoriert): ${err.message}`);
        }
    } catch (err) {
        // Transiente Orca-Fehler: lösen sich im nächsten Zyklus selbst, kein Telegram-Alarm nötig.
        // 0x177f = LiquidityUnderflow (stale RPC-Daten)
        // 0x1782 = LiquidityTooHigh   (Preis-Tick-Grenze, selbstlösend)
        // [object Object]: Orca common-sdk wraps Plain-Object TX-Errors via new Error(obj.toString())
        //                  → immer transient (Slippage/Blockhash), selbstlösend.
        const msg = typeof err.message === 'string' ? err.message : '';
        const isTransient =
            err.name === 'TransactionExpiredBlockheightExceededError' ||
            msg.includes('Blockhash not found') ||
            msg.includes('custom program error: 0x177f') ||
            msg.includes('custom program error: 0x1782') ||
            msg === '[object Object]';
        if (isTransient) {
            console.warn(`[bot:${pool.id}] closePosition transient (wird im nächsten Zyklus wiederholt): ${msg.split('\n')[0] || '(Details nicht lesbar)'}`);
        } else {
            const fails = (_closePositionFailCount.get(pool.id) ?? 0) + 1;
            _closePositionFailCount.set(pool.id, fails);
            if (fails >= 2) {
                console.error(`[bot:${pool.id}] closePosition Fehler (${fails}× in Folge): ${msg || String(err)}`);
                await notify.error(pool.displayPair ?? pool.pair, err);
            } else {
                console.warn(`[bot:${pool.id}] closePosition Fehler (1/2 – warte auf Bestätigung im nächsten Zyklus): ${msg.split('\n')[0] || String(err)}`);
            }
        }

        // Reconcile nach fehlgeschlagenem Close: Der vorangehende decreaseLiquidity kann
        // bereits erfolgreich gewesen sein (Tokens sind ins Wallet geflossen), während der
        // NFT-Burn scheiterte. Dann steht die Position on-chain mit REDUZIERTER Liquidität,
        // die DB/der Snapshot zeigen aber noch den alten vollen Wert → Doppel-Count
        // (Position-Altwert + freigesetzte Wallet-Tokens gleichzeitig). Genau das hat am
        // 2026-06-28 den 6.999-Spike + Phantom-PnL ausgelöst, weil der stündliche Cleanup
        // die freigesetzten Tokens später als Neukapital wieder einzahlte.
        // Fix: sofort frischen On-Chain-Snapshot schreiben, damit die reduzierte Liquidität
        // (und positions.liquidity) der Wahrheit entspricht. Fehler hier dürfen den Bot-Tick
        // nicht abbrechen.
        try {
            const reconState = await adapter.getPositionState(pool, position.nft_mint, {
                tickLowerIndex: position.tick_lower,
                tickUpperIndex: position.tick_upper,
            });
            writePositionSnapshotFromState(db, pool, position, reconState, reconState.currentPrice);
            await refreshAfterAction(db, { log: m => console.log(`[bot:${pool.id}] ${m}`) });
            console.log(`[bot:${pool.id}] Reconcile nach Close-Fehler: On-Chain-Liquidität ${reconState.liquidity} übernommen`);
        } catch (reconErr) {
            console.warn(`[bot:${pool.id}] Reconcile nach Close-Fehler fehlgeschlagen (ignoriert): ${reconErr.message}`);
        }

        // Cleanup sperren: decreaseLiquidity kann bereits Tokens ins Wallet freigesetzt haben.
        // Solange das Rebalancing nicht sauber abgeschlossen ist, darf der Cleanup diese
        // Tokens NICHT als Neukapital einzahlen (sonst Phantom-Kapital). Wird beim nächsten
        // erfolgreichen Close gelöscht; Auto-Verfall nach 90 Min.
        setRebalancePendingFlag(pool.id);
        return;
    }

    // 3. Neuen Preis abrufen + neue Range berechnen
    let newStats;
    try {
        newStats = await adapter.getPoolStats(pool);
    } catch (err) {
        console.error(`[bot:${pool.id}] Preis nach Close nicht verfügbar: ${err.message}`);
        return;
    }

    // 4. Neue Position öffnen
    // Kapital: Wert der gerade geschlossenen Position (kapital-neutral). Das Wallet
    // kann mehr enthalten (z.B. freigegebenes Kapital aus Score-Limit anderer Pools) –
    // das wird beim Rebalancing NICHT eingezogen.
    const SOL_MINT_REB = 'So11111111111111111111111111111111111111112';
    const keypairPub   = getKeypair().publicKey;

    const walletARaw = pool.tokenA === SOL_MINT_REB
        ? await getUsableSolBalanceFresh(keypairPub)
        : await getTokenBalanceFresh(keypairPub, pool.tokenA, pool.decimalsA);
    const walletBRaw = await getTokenBalanceFresh(keypairPub, pool.tokenB, pool.decimalsB);

    const walletCapital = _calcUsdValue(pool, db, newStats.price, walletARaw, walletBRaw);
    let newCapital;
    if (_preserveBaseline) {
        // Nur das durch den Rebalance freigesetzte Kapital (Wallet ÜBER der Topf-A-
        // Baseline) wird redeployed — der Altbestand (baseWalletA/B) bleibt liegen.
        // Kein Trimmen auf den alten Buchwert mehr: der Pool kommt so nah wie möglich
        // an seinen Vorwert (modulo Kursschwankung/Slippage).
        const freedA = Math.max(0, walletARaw - baseWalletA);
        const freedB = Math.max(0, walletBRaw - baseWalletB);
        newCapital = _calcUsdValue(pool, db, newStats.price, freedA, freedB);
    } else {
        // volatilePair: unverändertes Verhalten. position.capital_usdc = Wert beim
        // Öffnen; nimm das Minimum (Wallet kann durch IL weniger enthalten als beim
        // Öffnen investiert wurde).
        newCapital = position.capital_usdc > 0
            ? Math.min(position.capital_usdc, walletCapital)
            : walletCapital;
    }

    console.log(`[bot:${pool.id}] Rebalance-Kapital aus Wallet: ${newCapital.toFixed(2)} USDC`);

    // Advisor-Check: ggf. konfigurierte Range anpassen, bevor die neue Position
    // dimensioniert wird. Fehler dürfen das Rebalancing nicht abbrechen.
    try {
        await _advisorRebalanceCheck(pool, newCapital);
    } catch (err) {
        console.error(`[bot:${pool.id}] Advisor-Check fehlgeschlagen (ignoriert): ${err.message}`);
    }

    const effectiveRangeReb = pool.rangeOverride ? { ...config.range, ...pool.rangeOverride } : config.range;
    let newRange = (await _getAdvisedRange(pool, newStats.price, newCapital))
                ?? calculateRange(pool, newStats.price, effectiveRangeReb, db);

    // Token-Mix ausgleichen (Fix 3: Pre-Swap bei Imbalance) mit echtem Wallet-Kapital.
    // Topf A (baseWalletA/B) bleibt dabei unangetastet — nur freigesetztes Kapital
    // (Zielgröße newCapital) wird umgeschichtet.
    await _preSwapIfNeeded(pool, newStats.price, newCapital, baseWalletA, baseWalletB);

    const halfReb = newCapital / 2;
    let amountA, amountB;

    // Wallet-Cap: identisch zu _openNewPosition (siehe Kommentar dort).
    // Wichtig: Balances NACH Pre-Swap frisch lesen (USDC-Bestand hat sich geändert).
    const WALLET_CAP_REB = 0.985;

    if (pool.volatilePair) {
        // volatilePair: USD-Wert je Token bestimmt sich aus Pool-Preis × Quote-Preis.
        const quotePrice    = _getQuotePrice(pool, db);
        const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
        const usdPerTokenA  = quoteIsTokenA ? quotePrice : quotePrice * newStats.price;
        const usdPerTokenB  = quoteIsTokenA ? (newStats.price > 0 ? quotePrice / newStats.price : 0) : quotePrice;
        const amountADesired = usdPerTokenA > 0 ? halfReb / usdPerTokenA : 0;
        const amountBDesired = usdPerTokenB > 0 ? halfReb / usdPerTokenB : 0;

        // Wallet auf 50/50-USD-Mix bringen (mit Retry in swapTokens). Bei Fehlschlag:
        // Rebalance abbrechen — Kapital bleibt sicher im Wallet, nächster Bot-Tick
        // versucht es erneut. Verhindert die Tiny-Position-Falle bei Pre-Swap-Failure.
        const balanceRes = await _balanceWalletForPair(pool, newStats.price, newCapital);
        if (!balanceRes.success) {
            console.error(`[bot:${pool.id}] Rebalance abgebrochen: Wallet-Balance fehlgeschlagen — ${balanceRes.reason}`);
            await notify.error(`Rebalance ${pool.displayPair ?? pool.pair}`,
                new Error(`Pre-Swap fehlgeschlagen: ${balanceRes.reason}. ` +
                          `Position bleibt geschlossen, Kapital im Wallet. Nächster Bot-Tick versucht erneut.`));
            return;
        }

        amountA = Math.min(amountADesired, balanceRes.tokenABal * WALLET_CAP_REB);
        amountB = Math.min(amountBDesired, balanceRes.tokenBBal * WALLET_CAP_REB);
    } else if (pool.usdcIsTokenA) {
        const tokenABalReb = await getTokenBalanceFresh(keypairPub, pool.tokenA, pool.decimalsA);
        const amountBDesired = halfReb * newStats.price;
        const tokenBBalReb = await getTokenBalanceFresh(keypairPub, pool.tokenB, pool.decimalsB);
        // Topf A schützen: nur Wallet-Bestand über der Baseline ist deploybar.
        const availABalReb = _preserveBaseline ? Math.max(0, tokenABalReb - baseWalletA) : tokenABalReb;
        const availBBalReb = _preserveBaseline ? Math.max(0, tokenBBalReb - baseWalletB) : tokenBBalReb;
        amountA = Math.min(halfReb, availABalReb * WALLET_CAP_REB);
        amountB = Math.min(amountBDesired, availBBalReb * WALLET_CAP_REB);
    } else {
        const halfAReb = halfReb / newStats.price;
        const tokenABalReb = pool.tokenA === SOL_MINT_REB
            ? await getUsableSolBalanceFresh(keypairPub)
            : await getTokenBalanceFresh(keypairPub, pool.tokenA, pool.decimalsA);
        const tokenBBalReb = await getTokenBalanceFresh(keypairPub, pool.tokenB, pool.decimalsB);
        // Topf A schützen: nur Wallet-Bestand über der Baseline ist deploybar.
        const availABalReb = _preserveBaseline ? Math.max(0, tokenABalReb - baseWalletA) : tokenABalReb;
        const availBBalReb = _preserveBaseline ? Math.max(0, tokenBBalReb - baseWalletB) : tokenBBalReb;
        amountA = Math.min(halfAReb, availABalReb * WALLET_CAP_REB);
        amountB = Math.min(halfReb, availBBalReb * WALLET_CAP_REB);
    }

    // Post-Swap Preis-Check: Der Swap in _balanceWalletForPair kann den Pool-Preis
    // verschieben (besonders wenn eine Seite nach OOR-Close komplett leer ist).
    // Liegt der neue Marktpreis außerhalb der geplanten Range → Range neu berechnen,
    // damit openPosition nicht sofort OOR landet und nur Staub deployt.
    if (pool.volatilePair) {
        try {
            const postSwapStats = await adapter.getPoolStats(pool);
            if (postSwapStats.price < newRange.priceLower || postSwapStats.price > newRange.priceUpper) {
                console.warn(
                    `[bot:${pool.id}] Post-Swap-Preis ${postSwapStats.price.toFixed(4)} ` +
                    `außerhalb geplanter Range ${newRange.priceLower.toFixed(4)}–${newRange.priceUpper.toFixed(4)} ` +
                    `— Range wird neu berechnet`
                );
                newRange = (await _getAdvisedRange(pool, postSwapStats.price, newCapital))
                        ?? calculateRange(pool, postSwapStats.price, effectiveRangeReb, db);
                console.log(`[bot:${pool.id}] Neue Range: ${newRange.priceLower.toFixed(4)}–${newRange.priceUpper.toFixed(4)}`);
            }
        } catch (err) {
            console.warn(`[bot:${pool.id}] Post-Swap Preis-Check fehlgeschlagen: ${err.message} — öffne mit geplanter Range`);
        }
    }

    // Pre-Flight Guard: verhindert Tiny-Positions bei unvollständigem Wallet-Mix.
    // Greift insbesondere für volatilePair wenn Pre-Swap nicht alle Mittel
    // umverteilen konnte (z.B. SOL-Reserve hat Restschluck blockiert).
    const guardReb = _preFlightOpenGuard(pool, newStats.price, amountA, amountB, newCapital);
    if (!guardReb.ok) {
        console.error(`[bot:${pool.id}] Rebalance-Open abgebrochen: ${guardReb.reason}`);
        await notify.error(pool.displayPair ?? pool.pair, new Error(`Rebalancing: Position öffnen: ${guardReb.reason}`));
        return;
    }

    let openResult;
    try {
        openResult = await adapter.openPosition(pool, newRange.tickLower, newRange.tickUpper, amountA, amountB);
        _openPositionFailCount.delete(pool.id); // Erfolg → Zähler zurücksetzen
    } catch (err) {
        const msg = typeof err.message === 'string' ? err.message : '';
        const isTransient =
            err.name === 'TransactionExpiredBlockheightExceededError' ||
            msg.includes('Blockhash not found');
        console.error(`[bot:${pool.id}] openPosition nach Rebalancing fehlgeschlagen: ${err.message}`);
        if (isTransient) {
            console.warn(`[bot:${pool.id}] openPosition transient – wird im nächsten Zyklus wiederholt`);
        } else {
            const fails = (_openPositionFailCount.get(pool.id) ?? 0) + 1;
            _openPositionFailCount.set(pool.id, fails);
            if (fails >= MAX_OPEN_POSITION_FAILS) {
                _openPositionFailCount.delete(pool.id);
                setPoolActive(pool.id, false);
                await notify.openPositionGaveUp(pool, err, 'nach Rebalancing', fails);
                console.error(`[bot:${pool.id}] openPosition ${fails}× fehlgeschlagen – Pool automatisch deaktiviert.`);
            } else if (fails >= 2) {
                await notify.openPositionError(pool, err, 'nach Rebalancing');
            } else {
                console.warn(`[bot:${pool.id}] openPosition Fehler (${fails}/${MAX_OPEN_POSITION_FAILS} – warte auf Bestätigung im nächsten Zyklus): ${msg.split('\n')[0]}`);
            }
        }
        return;
    }

    // Tatsächlich deponierte Token-Mengen aus Liquidität berechnen
    const rebLiqBN   = new BN(openResult.liquidity);
    const rebSqrtP   = PriceMath.priceToSqrtPriceX64(
        new Decimal(newStats.price), pool.decimalsA, pool.decimalsB
    );
    const rebSqrtL   = PriceMath.tickIndexToSqrtPriceX64(newRange.tickLower);
    const rebSqrtU   = PriceMath.tickIndexToSqrtPriceX64(newRange.tickUpper);
    const rebAmounts  = PoolUtil.getTokenAmountsFromLiquidity(
        rebLiqBN, rebSqrtP, rebSqrtL, rebSqrtU, false
    );
    const rebTokenA = new Decimal(rebAmounts.tokenA.toString())
        .div(new Decimal(10).pow(pool.decimalsA)).toNumber();
    const rebTokenB = new Decimal(rebAmounts.tokenB.toString())
        .div(new Decimal(10).pow(pool.decimalsB)).toNumber();

    const rebCapitalUsdc = _calcUsdValue(pool, db, newStats.price, rebTokenA, rebTokenB);

    const newPosId = insertPosition(db, {
        poolId:       pool.id,
        nftMint:      openResult.nftMint,
        tickLower:    newRange.tickLower,
        tickUpper:    newRange.tickUpper,
        priceLower:   newRange.priceLower,
        priceUpper:   newRange.priceUpper,
        liquidity:    openResult.liquidity,
        capitalUsdc:  rebCapitalUsdc,
        hodlTokenA:   rebTokenA,
        hodlTokenB:   rebTokenB,
        hodlPriceUsd: newStats.price,
        openTx:       openResult.txHash,
        openedAt:     Date.now(),
    });

    const openRebFee = await getTxFee(openResult.txHash);
    insertTransaction(db, {
        poolId: pool.id, type: 'rebalance',
        amountA: rebTokenA, amountB: rebTokenB, usdValue: rebCapitalUsdc,
        txHash: openResult.txHash, txFeeSol: openRebFee,
        note: `${newRange.priceLower.toFixed(2)} – ${newRange.priceUpper.toFixed(2)}`,
    });

    _ensureAutoCompoundEnabled(pool.id);

    // Pool Mindestwert prüfen: löschen wenn neues Kapital < Mindestwert + 3% Puffer.
    // Ohne Puffer könnte der Trailing Stop nach dem Rebalance sofort feuern.
    const minValueUsd = readMinimumValue(pool.id);
    if (minValueUsd != null && rebCapitalUsdc < minValueUsd * 1.03) {
        clearMinimumValue(pool.id);
        console.log(`[bot:${pool.id}] Pool Mindestwert (${Math.round(minValueUsd)} USDC) nach Rebalance deaktiviert – neues Kapital ${rebCapitalUsdc.toFixed(2)} USDC liegt innerhalb des 3%-Puffers`);
        notify.minimumValueCleared(pool, minValueUsd, 'rebalance').catch(() => {});
    }

    // 5. Reconciler: iterativ Wallet-Reste (inkl. idle USDC bei nicht-USDC-Pools)
    //    swappen und via increaseLiquidity in die frische Position nachzahlen.
    //    Funktioniert für alle Pool-Typen (USDC / volatilePair).
    // Doppelter Schutz gegen Sweepen von Fremd-/Altkapital:
    //   1. Budget-Cap (maxReconcileUsdc): nur die Differenz zwischen freigesetztem
    //      Kapital (newCapital) und dem beim Open bereits deployten Betrag wird
    //      nachgezahlt.
    //   2. Topf-A-Baseline (preExistingA/B, nur Nicht-volatilePair): der vor dem
    //      Rebalance stehende Wallet-Bestand bleibt physisch unangetastet, selbst
    //      wenn das Budget mehr zuließe. newCapital ist hier bereits = freigesetztes
    //      Kapital (Wallet über Baseline), nicht der alte Buchwert — der Pool wird
    //      also nicht mehr getrimmt.
    const reconcileBudget = Math.max(0, newCapital - rebCapitalUsdc);
    const reconciledUsdc = await _reconcileWalletIntoPosition(pool, adapter, {
        id:          newPosId,
        nftMint:     openResult.nftMint,
        capitalUsdc: rebCapitalUsdc,
        priceLower:  newRange.priceLower,
        priceUpper:  newRange.priceUpper,
    }, newStats.price, {
        preExistingUsdc, maxReconcileUsdc: reconcileBudget,
        preExistingA: _preserveBaseline ? baseWalletA : 0,
        preExistingB: _preserveBaseline ? baseWalletB : 0,
    });

    // 6. Pre-Flight-Guard: wenn weniger als 90% des Soll-Kapitals deployed wurden,
    //    laut Alarm schlagen — sonst bleibt das Kapital unbemerkt im Wallet liegen.
    const totalDeployed   = rebCapitalUsdc + reconciledUsdc;
    const deploymentRatio = newCapital > 0 ? totalDeployed / newCapital : 1;
    if (deploymentRatio < 0.90) {
        const msg = `Rebalance-Underdeployment: ${totalDeployed.toFixed(2)} / ${newCapital.toFixed(2)} USDC deployed (${(deploymentRatio * 100).toFixed(1)}%). Kapital liegt idle im Wallet.`;
        console.warn(`[bot:${pool.id}] ${msg}`);
        try { await notify.info(`Rebalance ${pool.displayPair ?? pool.pair}`, msg); } catch { /* notify-Fehler nicht propagieren */ }
    } else {
        console.log(`[bot:${pool.id}] Deployment-Ratio OK: ${(deploymentRatio * 100).toFixed(1)}% (${totalDeployed.toFixed(2)} / ${newCapital.toFixed(2)} USDC)`);
    }

    // 7b. HWM-Adjustment speichern: (preHwm − preValue) − residual.
    //     residual = Kapital, das nach dem Rebalance nicht in die neue Position geflossen ist
    //     (Wallet-Rest nach Reconcile). Ohne diesen Abzug wäre der erste adjustedHwm zu hoch:
    //     die neue Position kann den alten HWM nicht erreichen, wenn weniger Kapital deployed ist.
    //     Formel: adjustedHwm = max(snapshot, snapshot + adj) beim ersten _takeSnapshot.
    const residualUsdc  = Math.max(0, (preValue ?? 0) - totalDeployed);
    const hwmBaseAdj    = (preHwm != null && preValue != null && preValue > 0)
        ? preHwm - preValue - residualUsdc
        : -residualUsdc;
    setPositionHwmBaseAdjustment(db, newPosId, hwmBaseAdj);
    console.log(`[bot:${pool.id}] HWM-Adjustment gespeichert: preHwm=${(preHwm ?? 0).toFixed(2)}, preValue=${(preValue ?? 0).toFixed(2)}, totalDeployed=${totalDeployed.toFixed(2)}, residual=${residualUsdc.toFixed(2)}, adj=${hwmBaseAdj >= 0 ? '+' : ''}${hwmBaseAdj.toFixed(2)} USDC → wird beim ersten Snapshot angewendet`);

    // 7. Rebalancing-Ereignis dokumentieren (nach Reconcile, damit lp_value_after bekannt ist).
    insertRebalanceHistory(db, {
        poolId:        pool.id,
        reason,
        oldPositionId: position.id,
        newPositionId: newPosId,
        oldTickLower:  position.tick_lower,
        oldTickUpper:  position.tick_upper,
        newTickLower:  newRange.tickLower,
        newTickUpper:  newRange.tickUpper,
        priceAtEvent:  newStats.price,
        costSol:       closeFee + openRebFee,
        feesClaimedA:  claimedA,
        feesClaimedB:  claimedB,
        lpValueBefore: preValue,
        lpValueAfter:  totalDeployed,
    });

    console.log(`[bot:${pool.id}] Rebalancing abgeschlossen → neue Range ${newRange.priceLower.toFixed(2)} – ${newRange.priceUpper.toFixed(2)} (Grund: ${reason})`);

    // 7c. Attrition-Regelkreis: prüft ob Rebalancing-Kosten das Kapital zu schnell
    //     aufzehren und weitet die Range ggf. eine Stufe. Fehler nicht propagieren.
    try {
        const reb30d = db.prepare(
            `SELECT COUNT(*) AS n FROM rebalance_history WHERE pool_id = ? AND rebalanced_at >= ?`
        ).get(pool.id, Date.now() - 30 * 24 * 3_600_000).n;
        const rebalsPerDayActual = reb30d / 30;
        await _attritionCheck(pool, totalDeployed, rebalsPerDayActual);
    } catch (err) {
        console.error(`[bot:${pool.id}] Attrition-Check fehlgeschlagen (ignoriert): ${err.message}`);
    }

    // 8. Pflicht-Refresh: portfolio_history (mit frischen Wallet-Balances) +
    //    wallet-monitor.db + Dashboard-Sync. Per-Pool position_snapshots werden im
    //    nächsten Bot-Tick via _takeSnapshot mit fresh on-chain-state geschrieben
    //    (deshalb lastSnapshot=0 → Step 6 zwingt den Snapshot beim nächsten Durchlauf).
    //
    //    Ohne diesen Aufruf zeigt das Dashboard bis zum nächsten regulären Snapshot
    //    stale Wallet-Werte (Stand vor Rebalance) — wiederkehrende Drift-Quelle.
    try {
        await refreshAfterAction(db, { log: msg => console.log(`[bot:${pool.id}] ${msg}`) });
        lastSnapshot.set(pool.id, 0);
        lastExport.ts = Date.now();
    } catch (err) {
        console.error(`[bot:${pool.id}] refreshAfterAction nach Rebalance fehlgeschlagen: ${err.message}`);
    }
    } finally {
        releaseRebalanceLock();
    }
}

// ─── Fee-Claim ────────────────────────────────────────────────────────────────

async function _claimFees(pool, position, state, adapter, price = null) {
    console.log(`[bot:${pool.id}] Fees claimen (${state.feesOwedA.toFixed(6)} TokenA, ${state.feesOwedB.toFixed(2)} TokenB)...`);

    try {
        const result = await adapter.collectFees(pool, position.nft_mint, {
            expectedA: state.feesOwedA, expectedB: state.feesOwedB,
        });
        const claimUsdValue = price != null
            ? _calcUsdValue(pool, db, price, result.amountA, result.amountB)
            : null;

        insertFeeHistory(db, {
            poolId:     pool.id,
            positionId: position.id,
            amountA:    result.amountA,
            amountB:    result.amountB,
            usdValue:   claimUsdValue,
            action:     config.reward.action,
            txHash:     result.txHash,
        });

        insertTransaction(db, {
            poolId: pool.id, type: 'claim',
            amountA: result.amountA, amountB: result.amountB,
            usdValue: claimUsdValue, txHash: result.txHash,
            txFeeSol: result.txFeeSol ?? null, note: null,
        });

        await notify.feesClaimed(pool, result.amountA, result.amountB, config.reward.action, result.txHash, claimUsdValue);

        // Reinvestieren / Weiterleiten gemäß per-Pool Fee-Claim-Einstellungen.
        // Reihenfolge wichtig: Reinvest VOR dem Wallet-Snapshot, sonst zeigt das Dashboard
        // den Post-Claim-Wallet-Stand (mit allen Fees), nicht den Post-Reinvest-Stand.
        if (config.reward.action === 'reinvest') {
            await _handleFeeClaimReward(pool, position, result.amountA, result.amountB, adapter, price, state);
        }

        // Wallet-Monitor-Snapshot frisch (SOL/USDC + ALLE SPL-Whitelist-Tokens). Position- und
        // Portfolio-Aggregat-Snapshots folgen in processPool Schritt 6 (_takeSnapshot mit
        // post-reinvest state.liquidity + state.feesOwed=0). lastSnapshot=0 erzwingt das.
        try { await writeFreshWalletSnapshot(db); } catch { /* ignorieren */ }

        _collectFeesFailCount.delete(pool.id); // Erfolg → Zähler zurücksetzen
        return true;

    } catch (err) {
        // Transiente Solana-RPC-Fehler (Congestion, stale Blockhash) – die TX wird beim
        // nächsten Zyklus automatisch neu versucht, kein Telegram-Alarm nötig.
        // [object Object]: Orca common-sdk wraps Plain-Object TX-Errors → immer transient.
        const msg = typeof err.message === 'string' ? err.message : '';
        const isTransient =
            err.name === 'TransactionExpiredBlockheightExceededError' ||
            msg.includes('Blockhash not found') ||
            msg === '[object Object]';
        const errDesc = msg || String(err);
        console.error(`[bot:${pool.id}] collectFees Fehler: ${errDesc.split('\n')[0]}`);
        if (isTransient) {
            console.warn(`[bot:${pool.id}] collectFees transient (wird im nächsten Zyklus wiederholt)`);
        } else {
            const fails = (_collectFeesFailCount.get(pool.id) ?? 0) + 1;
            _collectFeesFailCount.set(pool.id, fails);
            if (fails >= 2) {
                console.error(`[bot:${pool.id}] collectFees Fehler (${fails}× in Folge)`);
                await notify.error(pool.displayPair ?? pool.pair, err);
            } else {
                console.warn(`[bot:${pool.id}] collectFees Fehler (1/2 – warte auf Bestätigung im nächsten Zyklus): ${errDesc.split('\n')[0]}`);
            }
        }
        return false;
    }
}

// Zählt aufeinanderfolgende Reinvest-Fehler pro Pool.
// ─── Fee-Claim-Reward-Handler ─────────────────────────────────────────────────

/**
 * Behält vor dem Reinvest den Teil der geclaimten Fees zurück, der nötig ist, um die
 * SOL-Reserve wieder auf SOL_TOPUP_TARGET zu bringen. Gibt die gekürzten Beträge zurück.
 *
 * Warum überhaupt (Entscheidung 2026-07-30): Der bisherige Schutz war alles-oder-nichts —
 * unter der harten Reserve wurde gar nicht reinvestiert, darüber zu 100 %. Zwischen
 * Reserve und Invest-Puffer (0,10–0,15) flossen die Fees also vollständig zurück in die
 * Position, obwohl genau sie den Engpass hätten beheben können. Fees sind dabei die
 * einzige *kontinuierliche* SOL-Quelle: Dust entsteht nur bei Positionswechseln,
 * Fees laufen permanent auf.
 *
 * 🔒 Kein zusätzlicher Swap. Der Einbehalt kürzt nur die Reinvest-Menge; die Token
 * bleiben im Wallet und werden von den bestehenden Topup-Pfaden aufgesammelt
 * (vor jedem Öffnen/Reinvest sowie stündlich im Cleanup). Bei SOL-Paar-Pools ist
 * die zurückbehaltene SOL-Seite sogar sofort nutzbar, ganz ohne Tausch — dort
 * kostet der Einbehalt exakt nichts.
 *
 * Anteilig auf BEIDE Seiten angewendet, damit das Einzahlungsverhältnis der Position
 * erhalten bleibt: increaseLiquidity limitiert ohnehin auf die knappere Seite, ein
 * einseitiger Abzug würde nur unbrauchbaren Rest im Wallet erzeugen.
 */
async function _holdBackFeesForSol(pool, amountA, amountB, price) {
    if (amountA <= 0 && amountB <= 0) return { amountA, amountB };
    let sol;
    try {
        sol = await getSolBalanceFresh(getKeypair().publicKey);
    } catch {
        return { amountA, amountB }; // Balance nicht lesbar → lieber normal reinvestieren
    }
    if (sol >= INVEST_SOL_COMFORT) return { amountA, amountB };

    const solPrice = getTokenUsdPrice(SOL_MINT, db) || 0;
    if (!(solPrice > 0)) return { amountA, amountB };

    const feeUsd = price != null ? _calcUsdValue(pool, db, price, amountA, amountB) : 0;
    if (!(feeUsd > 0)) return { amountA, amountB };

    const neededUsd = Math.max(0, (SOL_TOPUP_TARGET - sol) * solPrice);
    if (neededUsd <= 0) return { amountA, amountB };

    const holdFraction = Math.min(1, neededUsd / feeUsd);
    const keptUsd      = feeUsd * holdFraction;
    console.log(`[bot:${pool.id}] SOL ${sol.toFixed(4)} < ${INVEST_SOL_COMFORT.toFixed(2)} – `
        + `${(holdFraction * 100).toFixed(0)}% der Fees (~${keptUsd.toFixed(2)} USDC) für die SOL-Reserve einbehalten, `
        + `Rest wird reinvestiert.`);

    return {
        amountA: amountA * (1 - holdFraction),
        amountB: amountB * (1 - holdFraction),
    };
}

async function _handleFeeClaimReward(pool, position, amountA, amountB, adapter, price, state) {
    const ac        = _getFeeClaimSettings(pool.id);
    const acEnabled = ac?.enabled !== false;
    const fraction  = Number.isFinite(Number(ac?.fraction)) ? Math.min(100, Math.max(10, Number(ac.fraction))) : 100;
    const sendTo    = (typeof ac?.sendTo === 'string' && ac.sendTo.trim()) ? ac.sendTo.trim() : null;
    const swapUsdc  = ac?.swapToUsdc === true;

    if (acEnabled) {
        const f        = fraction / 100;
        // SOL-Einbehalt VOR der sendTo-Aufteilung und nur auf dem Reinvest-Anteil:
        // Was der Nutzer sich auszahlen lässt (fraction < 100 + sendTo), bleibt
        // unangetastet — die Reserve wird aus dem Anteil bedient, der ohnehin im
        // System bleiben sollte, nicht aus einer Auszahlung.
        const held     = await _holdBackFeesForSol(pool, amountA * f, amountB * f, price);
        await _reinvest(pool, position, held.amountA, held.amountB, adapter, price, state);

        if (fraction < 100 && sendTo) {
            const remA = amountA * (1 - f);
            const remB = amountB * (1 - f);
            await _claimFeeSendRemainder(pool, remA, remB, sendTo, swapUsdc);
        }
    } else {
        // AC deaktiviert
        if (sendTo) {
            await _claimFeeSendRemainder(pool, amountA, amountB, sendTo, swapUsdc);
        } else {
            console.log(`[bot:${pool.id}] Auto Compounding deaktiviert – Fees verbleiben im Wallet`);
        }
    }
}

async function _claimFeeSendRemainder(pool, amountA, amountB, sendTo, swapToUsdc) {
    const logPrefix = `[bot:${pool.id}]`;
    try {
        let swappedUsdc = null;
        if (swapToUsdc) {
            swappedUsdc = await executeSwapStep(pool, {
                coinsA:      amountA,
                coinsB:      amountB,
                sendTo,
                logPrefix,
                slippageBps: config.rm.swapSlippageBps,
            });
        }
        const transferTxHash = await executeTransferStep(pool, {
            coinsA:      amountA,
            coinsB:      amountB,
            swappedUsdc,
            sendTo,
            swapToUsdc,
            logPrefix,
        });

        // In Transaktions-Historie schreiben (erscheint in "Letzte 25 Transaktionen")
        const usdValue = swapToUsdc && swappedUsdc != null ? swappedUsdc : null;
        insertTransaction(db, {
            poolId:    pool.id,
            type:      'fee-transfer',
            amountA:   swapToUsdc ? null : amountA,
            amountB:   swapToUsdc ? null : amountB,
            usdValue:  usdValue,
            txHash:    transferTxHash ?? null,
            txFeeSol:  null,
            note:      `→ ${sendTo.slice(0, 8)}…${swapToUsdc ? ' (USDC)' : ''}`,
        });
    } catch (err) {
        // Nur loggen – kein User-Alert. Beträge verbleiben sicher im Wallet
        // und werden beim nächsten Claim-Zyklus erneut versucht.
        console.error(`${logPrefix} Fee-Transfer Fehler (kein Alert): ${err.message}`);
    }
}

// Benachrichtigung erst beim 2. Fehler in Folge – einzelne Simulationsfehler
// sind oft falsche Alarme (Simulation konservativ, echter TX klappt).
const _reinvestFailCount     = new Map();
// openPosition: transiente Fehler (Blockhash) werden nicht gezählt und lösen keinen Alarm aus.
// Erst beim 2. nicht-transienten Fehler in Folge → Telegram. Ab MAX_OPEN_POSITION_FAILS
// gibt der Bot auf und deaktiviert den Pool automatisch (active=false), statt unbegrenzt
// weiterzuretryen — verhindert eine dauerhaft hängende "Position wird eröffnet …"-Zeile
// im Dashboard (Lehre aus dem SPCX-Vorfall 2026-06-23, manuell gefixt).
const _openPositionFailCount = new Map();
const MAX_OPEN_POSITION_FAILS = 3;
// closePosition (Rebalancing): gleiche Logik – 1. Fehler → warn, ab 2. → error.
const _closePositionFailCount = new Map();
// collectFees: gleiche Logik – transiente TX-Fehler werden nicht gezählt.
const _collectFeesFailCount   = new Map();
// getPositionState (RPC-Read pro Zyklus): gleiche Logik – kurze RPC-/Proxy-Hiccups
// (z.B. Helius 502) heilen sich meist beim nächsten Zyklus selbst (LB#0257/Core#0256).
const _positionStateFailCount = new Map();

async function _reinvest(pool, position, amountA, amountB, adapter, price = null, state = null) {
    if (amountA <= 0 && amountB <= 0) return;

    // Reinvest nur wenn SOL-Reserve erfüllt ist – bei niedrigem SOL wird geclaimed aber nicht reinvestiert
    // (zweistufig mit Topup-Versuch seit 2026-07-30, siehe _ensureSolForInvest)
    if (await _ensureSolForInvest(pool.id, 'Reinvest') == null) return;

    // Tatsächliche Wallet-Balance lesen und auf geclaimte Menge cappen.
    // Verhindert "insufficient funds" wenn die Ratio des Pools von der Claim-Ratio abweicht.
    // Fresh-Calls: Fees wurden gerade geclaimed → Cache umgehen, On-Chain-Echtzeit brauchen.
    //
    // SLIPPAGE_SAFETY: Orca addiert 1% Slippage-Buffer (DEFAULT_SLIPPAGE) auf die übergebenen
    // Beträge → tokenMaxA/B kann leicht über der Wallet-Balance liegen.
    // Faktor 0.985 (≈ 1/1.015) stellt sicher dass tokenMaxA/B immer innerhalb der Balance bleibt.
    const SLIPPAGE_SAFETY = 0.985;
    const SOL_MINT  = 'So11111111111111111111111111111111111111112';
    const keypair   = getKeypair();
    const walletA   = pool.tokenA === SOL_MINT
        ? await getUsableSolBalanceFresh(keypair.publicKey)
        : await getTokenBalanceFresh(keypair.publicKey, pool.tokenA, pool.decimalsA);
    const walletB   = await getTokenBalanceFresh(keypair.publicKey, pool.tokenB, pool.decimalsB);
    const useA      = Math.min(amountA, walletA * SLIPPAGE_SAFETY);
    const useB      = Math.min(amountB, walletB * SLIPPAGE_SAFETY);

    if (useA <= 0 || useB <= 0) {
        console.log(`[bot:${pool.id}] Reinvest abgebrochen: Token(s) nicht verfügbar (useA=${useA.toFixed(6)} useB=${useB.toFixed(4)})`);
        return;
    }

    console.log(`[bot:${pool.id}] Reinvest: ${useA.toFixed(6)} TokenA + ${useB.toFixed(2)} TokenB` +
        (useA < amountA || useB < amountB ? ` (geclaimed: ${amountA.toFixed(6)}/${amountB.toFixed(2)}, gecapped durch Wallet-Balance)` : ''));

    try {
        const result = await adapter.increaseLiquidity(pool, position.nft_mint, useA, useB);

        // txHash === null: Quote war 0 (Staub) – orca.js hat übersprungen, kein DB-Eintrag nötig
        if (!result.txHash) {
            console.log(`[bot:${pool.id}] Reinvest übersprungen: Betrag zu gering (Staub bleibt im Wallet)`);
            return;
        }

        const reinvestFee = await getTxFee(result.txHash);
        insertTransaction(db, {
            poolId: pool.id, type: 'reinvest',
            amountA: useA, amountB: useB,
            usdValue: price != null
                ? _calcUsdValue(pool, db, price, useA, useB)
                : null,
            txHash: result.txHash, txFeeSol: reinvestFee, note: null,
        });

        // Liquidität im State sofort aktualisieren, damit der folgende Snapshot
        // (erzwungen durch lastSnapshot.set(pool.id, 0)) den korrekten lp_value_usd berechnet
        // und "Mein Anteil" im Dashboard sofort den Post-Reinvest-Wert zeigt.
        if (state && result.addedLiquidity) {
            state.liquidity = result.addedLiquidity;
        }

        console.log(`[bot:${pool.id}] Reinvest TX: ${result.txHash}`);
        _reinvestFailCount.delete(pool.id); // Erfolg → Zähler zurücksetzen
    } catch (err) {
        // 0x17b5 = PriceSlippageOutOfBounds: Preis bewegt sich zwischen Quote und TX-Ausführung.
        // Selbstlösend beim nächsten Reinvest-Zyklus — kein Telegram-Alarm nötig.
        //
        // Sonderfall: Orca common-sdk wirft `new Error(confirmTxErr.toString())` — wenn
        // confirmTxErr ein Plain-Object ist (Solana TransactionError), liefert toString()
        // "[object Object]". Der eigentliche Fehlercode ist dann unbekannt, aber das Muster
        // deutet auf einen transienten TX-Fehler hin (Slippage/Blockhash). Reinvest wird
        // beim nächsten Claim-Zyklus automatisch wiederholt.
        const msg = typeof err.message === 'string' ? err.message : '';
        const isTransient =
            err.name === 'TransactionExpiredBlockheightExceededError' ||
            msg.includes('Blockhash not found') ||
            msg.includes('custom program error: 0x17b5') ||
            msg.includes('Zu wenig SOL für Fees') ||   // assertSufficientSol nach knappem Fee-Claim-TX — nächster Zyklus greift den SOL-Guard sauber
            msg === '[object Object]';
        const errDesc = msg || JSON.stringify(err);
        if (isTransient) {
            console.warn(`[bot:${pool.id}] increaseLiquidity transient (wird im nächsten Zyklus wiederholt): ${errDesc.split('\n')[0]}`);
            _reinvestFailCount.delete(pool.id); // transient zählt nicht als bestätigter Fehler
        } else {
            const fails = (_reinvestFailCount.get(pool.id) ?? 0) + 1;
            _reinvestFailCount.set(pool.id, fails);
            if (fails >= 2) {
                console.error(`[bot:${pool.id}] increaseLiquidity Fehler (${fails}× in Folge): ${errDesc}`);
                await notify.reinvestError(pool, err);
            } else {
                console.warn(`[bot:${pool.id}] increaseLiquidity Fehler (1/2 – warte auf Bestätigung im nächsten Zyklus): ${errDesc.split('\n')[0]}`);
            }
        }
    }
}

// ─── Portfolio-Snapshot ───────────────────────────────────────────────────────

async function _takeSnapshot(pool, position, state, adapter) {
    try {
        // Live-Preis aus state (bereits in diesem Zyklus on-chain abgefragt, wie beim
        // Rebalancing-Check) statt aus pool_stats — die wird nur stündlich aktualisiert
        // und bewertete die Position damit bis zu 1h nach jedem Rebalancing/Preissprung
        // falsch (Fund 2026-08-07, SPCX/USDC: PnL-Sprung -59 statt korrekt +30 USDC,
        // bis der stündliche pool_stats-Refresh nachzog). Fallback auf pool_stats nur
        // falls state.currentPrice ausnahmsweise fehlt.
        const stats = getPoolStats(db, pool.id, 1);
        const price = state?.currentPrice ?? stats[0]?.price ?? 0;

        // 1. Per-Pool-Snapshot (für "Mein Anteil", APR, IL je Pool im Dashboard)
        //    fees_pending_a/b in Token-Einheiten gespeichert → preisunabhängige APR-Berechnung
        //    Stale-Read-Guard ist im Helper enthalten.
        const written = writePositionSnapshotFromState(db, pool, position, state, price);
        if (!written) return; // Guard ausgelöst: keinen Aggregat-Snapshot schreiben

        // 1b. Trailing-Stop: Reset-Request aus UI verarbeiten, dann HWM nachziehen.
        //     Reset zuerst (sonst würde updateHwm einen Reset auf einen niedrigeren
        //     Wert nicht zulassen, da HWM monoton steigt).
        try {
            const snapRow = db.prepare(
                `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ?
                 ORDER BY recorded_at DESC LIMIT 1`
            ).get(pool.id);
            const lpUsd = snapRow?.lp_value_usd ?? 0;
            if (lpUsd > 0) {
                const resetApplied = processHwmResetIfRequested(db, pool, position, lpUsd);
                if (!resetApplied) updateHwm(db, pool, position, lpUsd);
            }
        } catch (err) {
            console.warn(`[bot:${pool.id}] HWM-Update fehlgeschlagen (nicht kritisch): ${err.message}`);
        }

        // 2. Aggregat-Snapshot: Summe aller aktiven Pools → portfolio_history
        await writePortfolioSnapshot(db);
    } catch (err) {
        console.error(`[bot:${pool.id}] Snapshot Fehler: ${err.message}`);
    }
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

/**
 * Liest den USD-Preis des Quote-Tokens.
 * Quelle 1: oracle_prices (Pyth, max. 5 Min alt) — unabhängig von Pool-Liquidität.
 * Quelle 2: pool_stats des Referenz-Pools (Fallback).
 */
function _getQuotePrice(pool, db) {
    if (!pool.quoteTokenMint) return 0;
    if (pool.quotePricePoolId) {
        const fresh = Date.now() - 5 * 60 * 1000;
        const oracle = db.prepare(
            `SELECT price FROM oracle_prices WHERE quote_pool_id = ? AND updated_at > ?`
        ).get(pool.quotePricePoolId, fresh);
        if (oracle) return oracle.price;
    }
    return getTokenUsdPrice(pool.quoteTokenMint, db);
}

/**
 * USD-Wert eines (tokenA, tokenB)-Paars im Pool — zentrales Routing für alle Modi.
 *  - usdcIsTokenA: a + b/price
 *  - volatilePair: Quote=tokenA → (a + b/price) * quotePrice
 *                  Quote=tokenB → (a*price + b) * quotePrice
 *  - Standard:     a*price + b
 */
/**
 * Balanciert den Wallet-Mix für volatilePair-Pools auf 50/50-USD-Anteil
 * BEVOR openPosition gerufen wird. Nutzt swapTokens mit Retry (lib/swap.js).
 *
 * Hintergrund: Diese Pool-Typen haben keinen USDC-Anker. Wenn nach Close oder
 * Wallet-Setup ein Token komplett fehlt, würde openPosition mit der Orca-SDK
 * eine winzige Liquidität ableiten (min(L_A, L_B) → 0 wenn einer = 0). Das
 * Kapital landet dann nutzlos im Wallet. Diese Funktion stellt sicher dass
 * beide Seiten vor openPosition ausreichend befüllt sind.
 *
 * @param {Object} pool          Pool-Config (volatilePair)
 * @param {number} currentPrice  Pool-Preis (tokenB per tokenA)
 * @param {number} targetUsdc    Soll-USD-Wert der Position (für 50/50-Berechnung)
 * @returns {Promise<{success: boolean, tokenABal: number, tokenBBal: number, reason?: string}>}
 */
async function _balanceWalletForPair(pool, currentPrice, targetUsdc) {
    const SOL_MINT       = 'So11111111111111111111111111111111111111112';
    const SOL_RESERVE    = 0.15;
    const IMBALANCE_THRESHOLD = 0.5;  // unter 50% des Ziel-Anteils → swappen
    const keypair        = getKeypair();
    const pub            = keypair.publicKey;

    const readBal = async (mint, dec) => mint === SOL_MINT
        ? getUsableSolBalanceFresh(pub)
        : getTokenBalanceFresh(pub, mint, dec);

    let tokenABal = await readBal(pool.tokenA, pool.decimalsA);
    let tokenBBal = await readBal(pool.tokenB, pool.decimalsB);

    // USD-pro-Token bestimmen (gleiche Formeln wie _calcUsdValue)
    let usdPerA, usdPerB;
    if (pool.volatilePair) {
        const qP     = _getQuotePrice(pool, db);
        const qIsA   = pool.quoteTokenMint === pool.tokenA;
        usdPerA = qIsA ? qP : qP * currentPrice;
        usdPerB = qIsA ? (currentPrice > 0 ? qP / currentPrice : 0) : qP;
    } else {
        return { success: true, tokenABal, tokenBBal };  // nicht zuständig
    }

    if (usdPerA <= 0 || usdPerB <= 0) {
        return { success: false, tokenABal, tokenBBal, reason: 'Preis-Daten unvollständig' };
    }

    // Kapital-Check VOR dem Pre-Swap: gleiche 30%-Schwelle wie _preFlightOpenGuard.
    // Verhindert einen sinnlosen Swap, wenn das Wallet (z.B. nach Score-Limit-Exit und
    // Kapital-Umverteilung an andere Pools) schlicht nicht genug für eine sinnvolle
    // Position hat — der Guard danach hätte ohnehin abgebrochen, aber erst nach dem Swap.
    const totalWalletUsd = tokenABal * usdPerA + tokenBBal * usdPerB;
    const minAcceptableUsd = targetUsdc * 0.30;
    if (totalWalletUsd < minAcceptableUsd) {
        return {
            success: false, tokenABal, tokenBBal,
            reason: `Wallet-Kapital ${totalWalletUsd.toFixed(2)} USDC < ${minAcceptableUsd.toFixed(2)} USDC ` +
                    `(30 % von Ziel ${targetUsdc.toFixed(2)}) – kein Pre-Swap, Kapital reicht nicht für sinnvolle Position.`,
        };
    }

    const halfTarget   = targetUsdc / 2;
    const targetAToken = halfTarget / usdPerA;
    const targetBToken = halfTarget / usdPerB;

    const [symA, symB] = pool.pair.split('/');
    const ratioA = targetAToken > 0 ? tokenABal / targetAToken : 1;
    const ratioB = targetBToken > 0 ? tokenBBal / targetBToken : 1;

    if (ratioA >= IMBALANCE_THRESHOLD && ratioB >= IMBALANCE_THRESHOLD) {
        return { success: true, tokenABal, tokenBBal };  // schon balanced
    }

    // Welche Seite hat Überschuss? Tausch in die deficit-Seite.
    let inMint, outMint, inDec, outDec, inAmount;
    if (ratioA > ratioB) {
        // tokenA-Überschuss → tokenA → tokenB
        const surplusA = Math.max(0, tokenABal - targetAToken);
        const capA = pool.tokenA === SOL_MINT
            ? Math.max(0, tokenABal - SOL_RESERVE)
            : tokenABal * 0.99;
        inAmount = Math.min(surplusA * 0.99, capA);  // 99% des Überschusses (Slippage-Puffer)
        inMint = pool.tokenA;   outMint = pool.tokenB;
        inDec  = pool.decimalsA; outDec = pool.decimalsB;
    } else {
        const surplusB = Math.max(0, tokenBBal - targetBToken);
        const capB = pool.tokenB === SOL_MINT
            ? Math.max(0, tokenBBal - SOL_RESERVE)
            : tokenBBal * 0.99;
        inAmount = Math.min(surplusB * 0.99, capB);
        inMint = pool.tokenB;   outMint = pool.tokenA;
        inDec  = pool.decimalsB; outDec = pool.decimalsA;
    }

    if (inAmount < 1 / Math.pow(10, inDec) * 100) {
        return { success: false, tokenABal, tokenBBal, reason: 'Swap-Betrag zu klein' };
    }

    console.log(`[bot:${pool.id}] Balance-Wallet: tausche ${inAmount.toFixed(6)} ` +
        `(${inMint === pool.tokenA ? symA : symB} → ${inMint === pool.tokenA ? symB : symA}) ` +
        `— Ziel-USD: ${targetUsdc.toFixed(2)}, Ratios A=${(ratioA*100).toFixed(0)}% B=${(ratioB*100).toFixed(0)}%`);

    try {
        await swapTokens({
            inputMint: inMint, outputMint: outMint,
            inputDecimals: inDec, outputDecimals: outDec,
            amount: inAmount, wallet: keypair, connection: getConnection(),
        });
    } catch (err) {
        return { success: false, tokenABal, tokenBBal, reason: `Swap fehlgeschlagen: ${err.message}` };
    }

    // Frische Reads nach Swap
    tokenABal = await readBal(pool.tokenA, pool.decimalsA);
    tokenBBal = await readBal(pool.tokenB, pool.decimalsB);
    console.log(`[bot:${pool.id}] Balance-Wallet OK: ${symA}=${tokenABal.toFixed(6)}, ${symB}=${tokenBBal.toFixed(6)}`);
    return { success: true, tokenABal, tokenBBal };
}

/**
 * Pre-Flight Guard: prüft ob amountA + amountB einen ausreichenden Anteil des
 * Ziel-Kapitals abdecken. Verhindert Tiny-Positions wenn Pre-Swap unvollständig war.
 *
 * Schwelle: 30% — bewusst weit, weil Slippage / Range-Edge-Cases legitime Abweichung
 * von 50/50-Ideal verursachen. Unter 30% ist immer ein Datenproblem.
 */
function _preFlightOpenGuard(pool, currentPrice, amountA, amountB, targetUsdc) {
    const actualUsdc = _calcUsdValue(pool, db, currentPrice, amountA, amountB);
    const minAcceptable = targetUsdc * 0.30;
    if (actualUsdc < minAcceptable) {
        return {
            ok: false,
            actualUsdc,
            targetUsdc,
            reason: `Geplantes Deposit ${actualUsdc.toFixed(2)} USDC < ${minAcceptable.toFixed(2)} USDC (30 % von Ziel ${targetUsdc.toFixed(2)}). ` +
                    `Vermutlich fehlgeschlagener Pre-Swap → Position würde winzig werden.`,
        };
    }
    return { ok: true, actualUsdc };
}

function _calcUsdValue(pool, db, price, amountA, amountB) {
    if (pool.usdcIsTokenA) {
        return amountA + (price > 0 ? amountB / price : 0);
    }
    if (pool.volatilePair) {
        const quotePrice    = _getQuotePrice(pool, db);
        const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
        if (quoteIsTokenA) {
            return (amountA + (price > 0 ? amountB / price : 0)) * quotePrice;
        }
        return (amountA * price + amountB) * quotePrice;
    }
    return amountA * price + amountB;
}

// ─── Hauptschleife ────────────────────────────────────────────────────────────

async function mainLoop() {
    let lastPruneDay      = '';
    let lastRangeHint     = 0;
    let lastResumeRetry   = 0;
    const RANGE_HINT_INTERVAL_MS = 60 * 60 * 1000;  // stündlich prüfen; Spam-Schutz über Backoff/Stabilität intern
    const RESUME_RETRY_INTERVAL_MS = 15 * 60 * 1000;
    while (running) {
        const cycleStart = Date.now();

        // ── Self-Heal: Konsistenz-Check portfolio_history vs transactions ────────
        // Invariante: nach jeder State-ändernden TX (close/open/rebalance/cleanup/...)
        // MUSS ein portfolio_history-Snapshot geschrieben werden. Wenn der jüngste
        // TX-Zeitstempel > 60 s älter ist als der jüngste portfolio_history-Eintrag,
        // wurde ein refreshAfterAction-Aufruf vergessen oder fehlgeschlagen.
        // Self-Heal: Refresh nachholen + Warn-Notification.
        try {
            const lastTx = db.prepare(
                `SELECT MAX(created_at) AS ts FROM transactions
                 WHERE type IN ('open_position','close_position','rebalance','cleanup','claim','reinvest','deposit','withdraw')`
            ).get();
            const lastPh = db.prepare(`SELECT MAX(recorded_at) AS ts FROM portfolio_history`).get();
            const txTs = lastTx?.ts ?? 0;
            const phTs = lastPh?.ts ?? 0;
            const driftMs = txTs - phTs;
            // 60 s Karenz für laufende Aktionen (Schreibreihenfolge TX → Snapshot)
            if (driftMs > 60_000) {
                console.warn(`[bot:self-heal] portfolio_history ${(driftMs/1000).toFixed(0)}s älter als jüngste TX – Refresh nachholen`);
                await refreshAfterAction(db, { log: msg => console.log(`[bot:self-heal] ${msg}`) });
                lastExport.ts = Date.now();
            }
        } catch (err) {
            console.warn(`[bot:self-heal] Konsistenz-Check fehlgeschlagen: ${err.message}`);
        }

        // pools.json bei jedem Zyklus neu einlesen (Hot-Reload ohne Neustart)
        let freshPools;
        try {
            freshPools = loadPools();
            syncPools(db, freshPools.all);
        } catch (err) {
            console.error(`[bot] pools.json Ladefehler: ${err.message} – nutze letzte bekannte Config`);
            freshPools = config.pools;
        }

        // Pyth-Preise für Quote-Tokens einmal pro Zyklus aktualisieren
        await refreshPythPrices(db);

        // Periodischer Retry unvollständiger Exit-Ausführungen (Score-Limit/Ranking/
        // Trailing-Stop). Diese Resume-Funktionen liefen bisher NUR beim Bot-Start –
        // ein Pool, der mitten in einer Exit-Ausführung (z.B. transienter Blockhash-
        // Fehler) auf active=false gesetzt wurde, fiel danach komplett aus dem
        // Hauptloop (siehe "Stats für inaktive Pools" unten) und hing bis zum
        // nächsten Bot-Restart fest (#0251). Deshalb hier zusätzlich alle
        // RESUME_RETRY_INTERVAL_MS erneut versuchen, unabhängig vom pool.active-Status.
        if (Date.now() - lastResumeRetry >= RESUME_RETRY_INTERVAL_MS) {
            lastResumeRetry = Date.now();
            try {
                await resumePendingScoreLimitExecutions(db);
            } catch (err) {
                console.error(`[bot] Score-Limit-Resume (periodisch) fehlgeschlagen: ${err.message}`);
            }
            try {
                await resumePendingRkExecutions(db);
            } catch (err) {
                console.error(`[bot] Ranking-Exit-Resume (periodisch) fehlgeschlagen: ${err.message}`);
            }
            try {
                await resumePendingTsExecutions(db);
            } catch (err) {
                console.error(`[bot] Trailing-Stop-Resume (periodisch) fehlgeschlagen: ${err.message}`);
            }
            try {
                await resumePendingRetireExecutions(db);
            } catch (err) {
                console.error(`[bot] Retirement-Exit-Resume (periodisch) fehlgeschlagen: ${err.message}`);
            }
        }

        // FORGE public Premium: übernommene Pools gegen die Angebotsliste abgleichen.
        // Bewusst hier und nicht in der Aktiv-Schleife unten — ein zurückgestufter Pool
        // ohne offene Position ist active=false und käme dort nie vorbei, muss aber
        // trotzdem gesperrt und gemeldet werden. Ohne übernommene Offer-Pools (Master,
        // Free-Fork) ist der Aufruf ein reiner No-Op.
        try {
            const retire = await processPoolRetirements(db);
            if (retire.exited.length > 0) {
                await refreshAfterAction(db, { log: msg => console.log(`[bot] ${msg}`) });
                lastExport.ts = Date.now();
            }
        } catch (err) {
            console.error(`[bot] Premium-Rückstufungs-Abgleich fehlgeschlagen: ${err.message}`);
        }

        // Timing-Maps für neu auftauchende Pools initialisieren
        for (const pool of freshPools.all) {
            if (!lastStatsFetch.has(pool.id)) {
                const row = db.prepare(
                    `SELECT recorded_at FROM pool_stats WHERE pool_id = ? AND tvl_usd > 0 ORDER BY recorded_at DESC LIMIT 1`
                ).get(pool.id);
                lastStatsFetch.set(pool.id, row?.recorded_at ?? 0);
            }
            if (!lastFeeClaim.has(pool.id)) {
                const lastClaim = db.prepare(
                    `SELECT MAX(claimed_at) as ts FROM fee_history WHERE pool_id = ?`
                ).get(pool.id);
                lastFeeClaim.set(pool.id, lastClaim?.ts ?? 0);
            }
            if (!lastSnapshot.has(pool.id)) {
                const snap = db.prepare(`SELECT MAX(recorded_at) as ts FROM portfolio_history`).get();
                lastSnapshot.set(pool.id, snap?.ts ?? 0);
            }
        }

        // Proaktives SOL-Self-Heal (2026-07-29, Befund): Auffüllen aus Wallet-
        // Guthaben lief bisher nur stündlich über cleanup.js oder reaktiv in den
        // Exit-Pfaden (heutiger SOL-Reserve-Fix). Beim Öffnen/Erhöhen einer Position
        // gab es das nicht — ein Wallet knapp unter der Reserve scheiterte jeden
        // Zyklus erneut am selben Guard, obwohl oft genug USDC/Token im Wallet lag.
        // Billiger Balance-Check zuerst, kein Lock/Wait im Normalfall (SOL reicht in
        // fast jedem Zyklus). Die Dust-Schwelle in ensureSolBalance() (0,5 USD)
        // verhindert von selbst sinnlose Mini-Swaps, wenn das Guthaben dafür nicht
        // reicht — kein zusätzlicher Cooldown hier nötig.
        //
        // Auslöseschwelle seit 2026-07-30 INVEST_SOL_COMFORT (Reserve + 0,05) statt
        // der Reserve selbst: erst dadurch startet der Zyklus mit genug Polster, dass
        // die Pool-Schleife danach nicht in _ensureSolForInvest nachtanken muss.
        try {
            const healKeypair = getKeypair();
            const solNowForHeal = await getSolBalanceFresh(healKeypair.publicKey);
            if (solNowForHeal < INVEST_SOL_COMFORT) {
                await waitForCleanupToFinish();
                acquireSlLock();
                try {
                    const heal = await ensureWalletSol(db, healKeypair, getConnection(), {
                        minSol: INVEST_SOL_COMFORT, targetSol: SOL_TOPUP_TARGET,
                        log: msg => console.log(`[bot] ${msg}`),
                    });
                    if (heal.swaps.length > 0) {
                        console.log(`[bot] SOL-Self-Heal: ${heal.solBefore.toFixed(4)} → ${heal.solAfter.toFixed(4)} SOL`);
                    }
                } finally {
                    releaseSlLock();
                }
            }
        } catch (err) {
            console.warn(`[bot] SOL-Self-Heal fehlgeschlagen: ${err.message}`);
        }

        // Bulk-Fetch: alle Position-States in 3 RPC-Calls statt N×4
        // Nur Pools mit offener Position; bei Fehler leer lassen → Fallback in processPool
        let bulkStates = new Map();
        try {
            const bulkItems = freshPools.active
                .map(p => { const pos = getOpenPosition(db, p.id); return pos ? { pool: p, nftMint: pos.nft_mint } : null; })
                .filter(Boolean);
            if (bulkItems.length > 0) {
                const bulkAdapter = getAdapter(bulkItems[0].pool);
                bulkStates = await bulkAdapter.getPositionStatesBulk(bulkItems);
            }
        } catch (err) {
            console.warn(`[bot] Bulk-State-Fetch fehlgeschlagen, Fallback auf Einzelabrufe: ${err.message}`);
        }

        for (const pool of freshPools.active) {
            if (!running) break;

            // TVL-Schutz-Check: höchste Priorität (TVL-Einbruch ist das gravierendste
            // Signal). Läuft vor Score-Limit / Ranking-Exit / Trailing-Stop.
            // Bei L2 (Voll-Exit) wird der Pool deaktiviert → continue.
            // Bei L1 (Teil-Abzug) bleibt der Pool aktiv → KEIN continue, normales
            // Processing läuft weiter (Position besteht noch).
            try {
                if (shouldTriggerTvlProtection(pool, db)) {
                    console.log(`[bot:${pool.id}] TVL-Schutz-Trigger erkannt – starte Ausführung`);
                    await executeTvlProtection(pool, db);
                    if (!getOpenPosition(db, pool.id)) {
                        // Voll-Exit (L2): Position weg → Dashboard sofort aktualisieren.
                        // L1 (Teil-Abzug): Position bleibt, processPool unten übernimmt Snapshot+Sync.
                        await refreshAfterAction(db, { log: msg => console.log(`[bot:${pool.id}] ${msg}`) });
                        lastExport.ts = Date.now();
                        continue;
                    }
                }
            } catch (err) {
                console.error(`[bot:${pool.id}] TVL-Schutz-Ausführung fehlgeschlagen: ${err.message}`);
                continue;
            }

            // Score-Limit-Check: vor normalem Pool-Processing.
            // isInRange = false wenn Pool bereits in einem laufenden OOR-Zustand ist
            // (outOfRangeSince gesetzt vom vorherigen Tick) → Counter einfrieren.
            const poolIsOor = outOfRangeSince.has(pool.id);
            try {
                if (shouldTriggerScoreLimit(pool, db, !poolIsOor)) {
                    console.log(`[bot:${pool.id}] Score-Limit-Trigger erkannt – starte Score-Limit-Ausführung`);
                    await executeScoreLimit(pool, db);
                    // Pool wurde deaktiviert – Dashboard sofort aktualisieren, dann überspringen.
                    await refreshAfterAction(db, { log: msg => console.log(`[bot:${pool.id}] ${msg}`) });
                    lastExport.ts = Date.now();
                    continue;
                }
                // Counter ist jetzt aktuell → Vorwarnung prüfen (feuert bei count = 1)
                await checkScoreLimitWarning(pool, db, !poolIsOor).catch(() => {});
            } catch (err) {
                console.error(`[bot:${pool.id}] Score-Limit-Ausführung fehlgeschlagen: ${err.message}`);
                continue;
            }

            // Ranking-Exit-Check: nach Score-Limit-Check, vor normalem Pool-Processing
            try {
                if (shouldTriggerRankingExit(pool, db)) {
                    console.log(`[bot:${pool.id}] Ranking-Exit-Trigger erkannt – starte Exit`);
                    await executeRankingExit(pool, db);
                    // Pool wurde deaktiviert – Dashboard sofort aktualisieren, dann überspringen.
                    await refreshAfterAction(db, { log: msg => console.log(`[bot:${pool.id}] ${msg}`) });
                    lastExport.ts = Date.now();
                    continue;
                }
                // Counter ist jetzt aktuell → Vorwarnung prüfen (feuert bei count = 1)
                await checkRankingExitWarning(pool, db).catch(() => {});
            } catch (err) {
                console.error(`[bot:${pool.id}] Ranking-Exit fehlgeschlagen: ${err.message}`);
                continue;
            }

            // Trailing-Stop-Check (1/2): nach Ranking-Exit, vor normalem Pool-Processing.
            // Bewertet den Snapshot des vorigen Zyklus — fängt einen Trigger ab, bevor
            // Kosten für Claim/Rebalance in einen Pool fließen, der ohnehin verlassen wird.
            if (await _trailingStopCheck(pool)) continue;

            const adapter = getAdapter(pool);
            try {
                await processPool(pool, adapter, bulkStates.get(pool.id) ?? null);
            } catch (err) {
                console.error(`[bot:${pool.id}] Unbehandelter Fehler: ${err.message}`);
                await notify.error(pool.displayPair ?? pool.pair, err).catch(() => {});
            }

            // Trailing-Stop-Check (2/2): direkt nach processPool, das gerade einen
            // frischen position_snapshot geschrieben hat. Ohne diesen zweiten Check
            // liegt zwischen dem auslösenden Kursstand und dem Exit systematisch ein
            // ganzer Zyklus (~5 Min) — bei volatilen Pools der Unterschied zwischen
            // „2 % Drawdown" und „4 % realisiert". Beobachtet 2026-08-01 bei PUMP/SOL.
            // Kein continue nötig: Schleifenende. Feuert nur, wenn Check 1/2 es nicht tat.
            await _trailingStopCheck(pool);
        }

        // Stats für inaktive Pools (nur Marktdaten, kein Positionsmanagement)
        await fetchInactivePoolStats(freshPools.all.filter(p => !p.active));

        // SOL-Low-Alert (Cooldown 1×/h lebt jetzt zentral in notify.solLow() selbst,
        // 2026-07-29 — greift dadurch auch für alle anderen solLow()-Aufrufer, siehe dort)
        {
            const wallet = getLatestWalletBalance(config.botId);
            const solNow = wallet?.sol ?? null;
            if (solNow !== null) await notify.solLow(solNow).catch(() => {});
        }

        // Dashboard exportieren (innerhalb des Loops, aber eigenes Intervall)
        if (Date.now() - lastExport.ts >= config.exportIntervalMs) {
            await syncDashboard();
            lastExport.ts = Date.now();
        }

        // Range-Hinweis: vorgezogenes Rebalance bei nicht mehr optimaler Range (kein Auto-Apply).
        // Stündlich; der eigentliche Spam-Schutz (Stabilität + 12h/48h-Backoff) sitzt in der Funktion.
        if (Date.now() - lastRangeHint >= RANGE_HINT_INTERVAL_MS) {
            try {
                await _advisorRangeHintScan(freshPools.active);
            } catch (err) {
                console.error(`[bot] Range-Hinweis-Scan fehlgeschlagen: ${err.message}`);
            }
            lastRangeHint = Date.now();
        }

        // DB-Bereinigung + pnl_daily-Tagesabschluss: einmal täglich
        const todayStr = todayTz();                             // FORGE_TZ-basiert statt UTC
        if (todayStr !== lastPruneDay) {
            prunePortfolioHistory(db, 90);    // Portfolio-Verlauf: 90 Tage
            prunePositionSnapshots(db, 90);   // Per-Pool-Snapshots: 90 Tage
            pruneRebalanceHistory(db, 730);   // Rebalancing-Events: 2 Jahre
            pruneAdvisorDecisions(db, 730);   // Advisor-Entscheidungen: 2 Jahre

            // Vergangene Tagesabschlüsse in pnl_daily nachführen (bis zu 3 Tage zurück,
            // damit Bot-Downtime über Nacht keine Lücken hinterlässt).
            const todayStart = midnightTzMs(todayStr);
            for (let daysBack = 1; daysBack <= 3; daysBack++) {
                const dayEndMs   = todayStart - (daysBack - 1) * 86_400_000;
                const dayStartMs = dayEndMs - 86_400_000;
                const dayStr     = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ }).format(new Date(dayEndMs - 1));
                if (db.prepare(`SELECT id FROM pnl_daily WHERE date = ?`).get(dayStr)) continue;

                const lpClose = lpValueAt(db, { flavor: config.botId, ts: dayEndMs - 1 });
                if (lpClose == null) continue;

                // Kalendertag-PnL über die zentrale Lib (Portfolio, Kurven-Methodik).
                const pnlValue = pnlForPeriod(db, { flavor: config.botId, fromMs: dayStartMs, toMs: dayEndMs });
                db.prepare(`INSERT OR IGNORE INTO pnl_daily (date, lp_close, pnl_value, created_at) VALUES (?, ?, ?, ?)`)
                  .run(dayStr, lpClose, pnlValue, Date.now());
                console.log(`[bot] pnl_daily: ${dayStr} nachgeführt (lp_close=${lpClose.toFixed(2)}, pnl=${pnlValue?.toFixed(2)} USDC)`);
            }
            // Einträge älter als 90 Tage löschen
            db.prepare(`DELETE FROM pnl_daily WHERE date < date('now', '-90 days')`).run();

            // Täglicher Advisor-Scan: stabile Range-Empfehlungen melden (kein Auto-Apply)
            try {
                await _dailyAdvisorScan(freshPools.active);
            } catch (err) {
                console.error(`[bot] Täglicher Advisor-Scan fehlgeschlagen: ${err.message}`);
            }

            // Advisor-Tagesbericht für den abgelaufenen Tag schreiben
            if (lastPruneDay) {
                try {
                    _writeAdvisorDayReport(lastPruneDay);
                } catch (err) {
                    console.error(`[bot] Advisor-Tagesbericht fehlgeschlagen: ${err.message}`);
                }
            }

            lastPruneDay = todayStr;
        }

        if (!running) break;

        // In kurzen Schritten warten, damit der Export zwischendurch laufen kann
        const elapsed = Date.now() - cycleStart;
        const totalWait = Math.max(0, config.checkIntervalMs - elapsed);
        const waited = { ms: 0 };
        while (waited.ms < totalWait && running) {
            const step = Math.min(totalWait - waited.ms, config.exportIntervalMs);
            await new Promise(r => setTimeout(r, step));
            waited.ms += step;

            // Export zwischendurch prüfen
            if (Date.now() - lastExport.ts >= config.exportIntervalMs) {
                await syncDashboard();
                lastExport.ts = Date.now();
            }
        }
    }
}

// ─── Globale Fehler-Handler ───────────────────────────────────────────────────
// Verhindert Crash bei unbehandelten Promise-Rejections (z.B. Helius-500).
// Solche Fehler entstehen wenn @solana/web3.js intern Promises wirft die keinen
// await-Aufrufer mehr haben — der Bot soll weiterlaufen, nicht crashen.
//
// Streak-Schutz: transiente RPC-Ausfälle (503/502) heilen sich oft von selbst.
// Erst ab der 3. Rejection innerhalb von 15 Min wird tatsächlich alarmiert;
// liegt die letzte Rejection länger zurück, gilt der Streak als abgerissen.
let unhandledRejectionStreak = { count: 0, lastAt: 0 };
const UNHANDLED_REJECTION_THRESHOLD  = 3;
const UNHANDLED_REJECTION_WINDOW_MS  = 15 * 60 * 1000;

process.on('unhandledRejection', async (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('[bot] Unbehandelte Promise-Rejection (kein Crash):', msg);

    const now = Date.now();
    if (now - unhandledRejectionStreak.lastAt > UNHANDLED_REJECTION_WINDOW_MS) {
        unhandledRejectionStreak.count = 0;
    }
    unhandledRejectionStreak.count++;
    unhandledRejectionStreak.lastAt = now;

    if (unhandledRejectionStreak.count >= UNHANDLED_REJECTION_THRESHOLD) {
        await notify.error('UnhandledRejection', reason instanceof Error ? reason : new Error(msg)).catch(() => {});
    } else {
        console.warn(`[bot] UnhandledRejection-Streak ${unhandledRejectionStreak.count}/${UNHANDLED_REJECTION_THRESHOLD} – Alert unterdrückt.`);
    }
});

// ─── SIGTERM-Handler ──────────────────────────────────────────────────────────

// Letzter Export beim Herunterfahren (Fund 2026-08-07): syncDashboard() läuft
// sonst NUR innerhalb der laufenden Haupt-Loop (alle EXPORT_INTERVAL_MS) — ein
// gestoppter Bot exportiert dadurch nie wieder, das Dashboard zeigt beliebig
// lange den letzten Stand VOR dem Stop (u.a. das neue botActive-Feld bliebe
// veraltet). Bewusst NUR dieser einmalige Aufruf beim Shutdown, KEIN periodischer
// Cron-Export nebenher — genau das verursachte früher eine Race-Condition auf
// derselben data.json.tmp (siehe Kommentar in bin/run-hourly.sh). Ein einzelner
// Aufruf exakt beim Beenden überschneidet sich mit nichts.
process.on('SIGTERM', async () => {
    console.log('[bot] SIGTERM empfangen – fahre sauber herunter...');
    running = false;
    kvSet(db, 'bot_state', 'offline');
    await notify.shutdown('SIGTERM').catch(() => {});
    await syncDashboard(msg => console.log(`[bot] ${msg}`)).catch(() => {});
    db.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('[bot] SIGINT empfangen – fahre sauber herunter...');
    running = false;
    kvSet(db, 'bot_state', 'offline');
    await notify.shutdown('SIGINT').catch(() => {});
    await syncDashboard(msg => console.log(`[bot] ${msg}`)).catch(() => {});
    db.close();
    process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────────────

try {
    // Fail-fast: Code-Invarianten vor allem anderen prüfen.
    // Bricht der Bot hier ab, hat ein Refactor stumme Annahmen verletzt — der Bot
    // startet nicht, statt Stunden später in einem Edge-Case zu crashen.
    assertTypeInvariants();

    await startup();

    await mainLoop();
} catch (err) {
    console.error('[bot] Fataler Fehler beim Start:', err.message);
    await notify.error('Bot-Start', err).catch(() => {});
    db.close();
    process.exit(1);
}
