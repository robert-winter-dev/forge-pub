/**
 * FORGE Liquidity – Ranking-Exit (Phase B2)
 *
 * Schließt eine Position, sobald der Pool laut pool_score_history für mind.
 * `badDurationHours` durchgehend im Tier "withdraw" bewertet wurde. Optional
 * werden die entnommenen Coins in USDC getauscht und/oder an eine Adresse
 * gesendet (analog SL/TP, nutzt lib/exit-finalizer.js).
 *
 * Migration 2026-05-18: vorher verdict='bad' (Range-Advisor-Logik), jetzt
 * tier='withdraw' (Economic-Scorer mit Total Return inkl. Token-Wert).
 *
 * State-Machine (persistiert in rk_executions):
 *   preparing → withdrawn → swapped → transferred → complete
 * Jeder Schritt wird vor Ausführung in die DB geschrieben.
 * Bei Bot-Restart wird jede unvollständige Ausführung fortgesetzt
 * (resumePendingRkExecutions).
 *
 * Settings: pool.settings.ranking = { enabled, badDurationHours, swapToUsdc, sendTo }
 *           (gespeichert in settings.db → pool_settings, geliefert vom
 *           ForgeSettings-„Risk-Management"-Modal Tab Ranking).
 *
 * Safeguards:
 *   - Snapshot älter als 60 Min (data/pool-scores.json mtime) → Skip + Log
 *   - Weniger als MIN_SCORE_SAMPLES Einträge → Skip
 *   - Vor jeder destruktiven Aktion: notify.rankingExitTriggered (Telegram)
 *   - Idempotenz: setPoolActive(false) verhindert Re-Open im selben Tick
 */

import Database            from 'better-sqlite3';
import { statSync }        from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';

import { setPoolActive, config } from './config.js';
import { acquireSlLock, releaseSlLock, waitForCleanupToFinish } from './cleanup-lock.js';
import { getAdapter }      from './pool-adapter/index.js';
import {
    insertCapitalFlow, getOpenPosition, closePosition as markPositionClosedInDb,
    getPoolScoreHistory, getBadStreakMs,
    createRkExecution, updateRkExecution, getIncompleteRkExecutions,
} from './db.js';
import { getActiveProfile } from './economic-scorer/config.js';
import * as notify         from './notify.js';
import { executeSwapStep, executeTransferStep, prepareExitAndClaimFees, finalizeClosePosition } from './exit-finalizer.js';
import { PATHS } from '../../../config/paths.js';

const __dirname        = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB      = PATHS.settingsDb;
const SCORES_JSON      = PATHS.liquidityScores;
const SNAPSHOT_MAX_AGE = 60 * 60 * 1000;   // 60 Min
const LOOKBACK_HOURS   = 96;
const MIN_SCORE_SAMPLES = 24;              // Datenbasis-Mindestmenge

// Throttle für „Snapshot stale"-Log: 1× pro Stunde pro Pool
const lastStaleLog = new Map();

// 2-Zyklen-Guard: Ranking-Exit feuert erst beim zweiten aufeinanderfolgenden Trigger
const _rkConsecutive = new Map();  // poolId → count

// Vorwarnung-Cooldown
const _rkWarnSentAt  = new Map();  // poolId → timestamp letzte Warnung
const WARN_COOLDOWN_MS = 10 * 60 * 1000;

function loadRankingConfig(poolId) {
    try {
        const sdb = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        sdb.close();
        if (!row) return null;
        const s = JSON.parse(row.settings);
        return s?.ranking ?? null;
    } catch {
        return null;
    }
}

function isSnapshotFresh(poolId) {
    try {
        const ageMs = Date.now() - statSync(SCORES_JSON).mtimeMs;
        if (ageMs <= SNAPSHOT_MAX_AGE) return true;
        const last = lastStaleLog.get(poolId) ?? 0;
        if (Date.now() - last > 60 * 60 * 1000) {
            console.warn(`[ranking-exit:${poolId}] Snapshot pool-scores.json ist ${Math.round(ageMs / 60000)} Min alt (>60) – Exit übersprungen`);
            lastStaleLog.set(poolId, Date.now());
        }
        return false;
    } catch {
        return false; // Datei fehlt → kein Exit
    }
}

/**
 * Gibt true zurück wenn der Ranking-Exit für diesen Pool feuern soll.
 * Kein API-Call – nur DB- und Filesystem-Lookups.
 */
export function shouldTriggerRankingExit(pool, db) {
    const cfg = loadRankingConfig(pool.id);
    if (!cfg?.enabled) return false;

    const badDurationHours = Number(cfg.badDurationHours);
    if (!badDurationHours || badDurationHours <= 0) return false;

    // Keine offene Position → nichts zu schließen
    if (!getOpenPosition(db, pool.id)) return false;

    if (!isSnapshotFresh(pool.id)) return false;

    const history = getPoolScoreHistory(db, pool.id, MIN_SCORE_SAMPLES);
    if (history.length < MIN_SCORE_SAMPLES) {
        // Zu wenig Daten – still überspringen
        return false;
    }

    // Phase 2: profil-spezifische Tier-Spalte abfragen.
    // PROFILE=short → short_term_tier wird ausgewertet, sonst tier (Mittelfrist).
    const profile  = getActiveProfile();
    const streakMs = getBadStreakMs(db, pool.id, LOOKBACK_HOURS, profile);
    if (streakMs == null) return false;

    const triggered = streakMs >= badDurationHours * 60 * 60 * 1000;
    if (!triggered) {
        _rkConsecutive.delete(pool.id);
        return false;
    }

    // 2-Zyklen-Guard: konsistent mit Trailing Stop und Score-Limit
    const prev  = _rkConsecutive.get(pool.id) ?? 0;
    const count = prev + 1;
    _rkConsecutive.set(pool.id, count);

    if (count < 3) {
        console.log(`[ranking-exit:${pool.id}] Trigger-Bedingung erfüllt (${count}/3 Zyklen) – noch kein Exit`);
        return false;
    }
    return true;
}

/**
 * Gibt den aktuellen Consecutive-Count des Ranking-Exit-Triggers zurück.
 * Wird von checkRankingExitWarning gelesen (nach shouldTriggerRankingExit aufrufen).
 */
export function getRankingExitConsecutive(poolId) {
    return _rkConsecutive.get(poolId) ?? 0;
}

/**
 * Vorwarnung: feuert beim ersten Zyklus mit erfüllter Ranking-Exit-Bedingung (count = 1).
 * Muss im Bot-Loop NACH shouldTriggerRankingExit aufgerufen werden.
 */
export async function checkRankingExitWarning(pool, db) {
    if (getRankingExitConsecutive(pool.id) !== 1) return;

    const lastWarn = _rkWarnSentAt.get(pool.id) ?? 0;
    if (Date.now() - lastWarn < WARN_COOLDOWN_MS) return;

    const cfg = loadRankingConfig(pool.id);
    const badDurationHours = Number(cfg?.badDurationHours ?? 0);

    const profile  = getActiveProfile();
    const streakMs = getBadStreakMs(db, pool.id, LOOKBACK_HOURS, profile);
    const streakHours = streakMs != null ? (streakMs / 3_600_000).toFixed(1) : '?';

    const snap  = db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).get(pool.id);
    const lpUsd = snap?.lp_value_usd ?? 0;

    _rkWarnSentAt.set(pool.id, Date.now());
    const label = { k: 'notify.liq.rm_label_ranking', p: { streak: streakHours, bad: badDurationHours } };
    console.log(`[ranking-exit:${pool.id}] Vorwarnung: Ranking-Exit (${streakHours}h / ${badDurationHours}h), LP ${lpUsd.toFixed(2)} USDC`);
    await notify.rmWarning(pool, label, lpUsd).catch(() => {});
}

// ─── State-Machine: Withdraw-Step ────────────────────────────────────────────

async function stepWithdraw(pool, db, execId) {
    const adapter   = getAdapter(pool);
    const position  = getOpenPosition(db, pool.id);

    let feesA = 0, feesB = 0;

    if (position) {
        // SOL-Vorsicherung + Fee-Claim (letzterer entfällt bei knappem SOL).
        // Blockiert den Ausstieg nie — siehe prepareExitAndClaimFees().
        const fees = await prepareExitAndClaimFees(adapter, pool, position, db, {
            logPrefix: `[ranking-exit:${pool.id}]`,
        });
        feesA = fees.amountA;
        feesB = fees.amountB;
        if (!fees.skipped) {
            console.log(`[ranking-exit:${pool.id}] Fees geclaimed: ${feesA.toFixed(6)} A + ${feesB.toFixed(6)} B`);
        }

        const { closed, coinsA: rkCoinsA, coinsB: rkCoinsB } = await finalizeClosePosition(adapter, pool, position, db, {
            feesA, feesB,
            note:      'ranking-exit',
            logPrefix: `[ranking-exit:${pool.id}]`,
        });

        markPositionClosedInDb(db, position.id, closed.txHash);

        updateRkExecution(db, execId, {
            step:      'withdrawn',
            rk_coins_a: rkCoinsA,
            rk_coins_b: rkCoinsB,
        });
        return { rkCoinsA, rkCoinsB };
    } else {
        console.log(`[ranking-exit:${pool.id}] Keine offene Position mehr – überspringe Withdraw`);
        updateRkExecution(db, execId, { step: 'withdrawn', rk_coins_a: 0, rk_coins_b: 0 });
        return { rkCoinsA: 0, rkCoinsB: 0 };
    }
}

async function stepSwap(pool, db, execId, cfg, rkCoinsA, rkCoinsB) {
    return executeSwapStep(pool, {
        coinsA:    rkCoinsA,
        coinsB:    rkCoinsB,
        sendTo:    cfg.sendTo,
        logPrefix: `[ranking-exit:${pool.id}]`,
        onSwapped: (swappedUsdc) => {
            updateRkExecution(db, execId, { step: 'swapped', swapped_usdc: swappedUsdc });
            insertCapitalFlow(db, { poolId: pool.id, usdcAmount: -swappedUsdc, note: 'ranking-exit', isExternal: 1 });
            console.log(`[ranking-exit:${pool.id}] Kapitalabfluss erfasst: -${swappedUsdc.toFixed(2)} USDC`);
        },
    });
}

async function stepTransfer(pool, db, execId, cfg, rkCoinsA, rkCoinsB, swappedUsdc) {
    return executeTransferStep(pool, {
        coinsA:        rkCoinsA,
        coinsB:        rkCoinsB,
        swappedUsdc,
        sendTo:        cfg.sendTo,
        swapToUsdc:    cfg.swapToUsdc,
        logPrefix:     `[ranking-exit:${pool.id}]`,
        onTransferred: () => updateRkExecution(db, execId, { step: 'transferred' }),
    });
}

// ─── Haupt-Ausführung ────────────────────────────────────────────────────────

/**
 * Führt den Ranking-Exit für einen Pool aus.
 * Darf nur aufgerufen werden wenn shouldTriggerRankingExit() true zurückgegeben hat.
 */
export async function executeRankingExit(pool, db) {
    const cfg = loadRankingConfig(pool.id);
    if (!cfg?.enabled) return;

    const profile     = getActiveProfile();
    const streakMs    = getBadStreakMs(db, pool.id, LOOKBACK_HOURS, profile) ?? 0;
    const streakHours = streakMs / 3600000;
    const badDurationHours = Number(cfg.badDurationHours);

    console.log(`[ranking-exit:${pool.id}] Ranking-Exit ausgelöst: rot seit ${streakHours.toFixed(1)}h (Schwelle ${badDurationHours}h)`);

    await waitForCleanupToFinish();
    acquireSlLock();

    const execId = createRkExecution(db, {
        poolId:         pool.id,
        streakHours,
        configSnapshot: cfg,
    });

    try {
        // Pool sofort inaktiv → verhindert Re-Open im nächsten Tick (Idempotenz)
        try {
            setPoolActive(pool.id, false);
            console.log(`[ranking-exit:${pool.id}] Pool auf active=false gesetzt`);
        } catch (err) {
            console.error(`[ranking-exit:${pool.id}] setPoolActive fehlgeschlagen: ${err.message}`);
        }

        // Phase 2: Withdraw
        const { rkCoinsA, rkCoinsB } = await stepWithdraw(pool, db, execId);

        // Phase 3: Swap (optional)
        let swappedUsdc = null;
        if (cfg.swapToUsdc) {
            swappedUsdc = await stepSwap(pool, db, execId, cfg, rkCoinsA, rkCoinsB);
        }

        // Phase 4: Transfer (optional)
        if (cfg.sendTo) {
            await stepTransfer(pool, db, execId, cfg, rkCoinsA, rkCoinsB, swappedUsdc);
        }

        // Phase 5: Abschluss
        updateRkExecution(db, execId, { step: 'complete', completed_at: Date.now() });
        console.log(`[ranking-exit:${pool.id}] Ranking-Exit vollständig abgeschlossen.`);
        const snap = db.prepare(`SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`).get(pool.id);
        await notify.rmExecuted(pool, { k: 'notify.liq.rm_label_ranking', p: { streak: streakHours.toFixed(1), bad: badDurationHours } }, snap?.lp_value_usd ?? 0).catch(() => {});

    } catch (err) {
        console.error(`[ranking-exit:${pool.id}] FEHLER: ${err.message}`);
        updateRkExecution(db, execId, { error_msg: err.message });
        await notify.rankingExitError(pool, 'execution', err).catch(() => {});
        throw err;
    } finally {
        releaseSlLock();
    }
}

// ─── Startup: unvollständige Ausführungen fortsetzen ─────────────────────────

/**
 * Wird beim Bot-Start aufgerufen.
 * Setzt jede rk_execution fort, die beim letzten Crash unterbrochen wurde.
 */
export async function resumePendingRkExecutions(db) {
    const pending = getIncompleteRkExecutions(db);
    if (!pending.length) return;

    console.log(`[ranking-exit] ${pending.length} unvollständige Exit-Ausführung(en) gefunden – setze fort…`);

    for (const exec of pending) {
        const pool = config.pools.all.find(p => p.id === exec.pool_id);
        if (!pool) {
            console.warn(`[ranking-exit] Pool ${exec.pool_id} nicht in config – Ausführung übersprungen`);
            continue;
        }

        const cfg = exec.config_snapshot ? JSON.parse(exec.config_snapshot) : loadRankingConfig(exec.pool_id);
        if (!cfg) {
            console.warn(`[ranking-exit] Keine Ranking-Config für ${exec.pool_id} – Ausführung übersprungen`);
            continue;
        }

        console.log(`[ranking-exit:${exec.pool_id}] Fortsetze ab Step '${exec.step}'`);
        acquireSlLock();

        try {
            let rkCoinsA    = exec.rk_coins_a ?? 0;
            let rkCoinsB    = exec.rk_coins_b ?? 0;
            let swappedUsdc = exec.swapped_usdc ?? null;

            if (exec.step === 'preparing') {
                const result = await stepWithdraw(pool, db, exec.id);
                rkCoinsA = result.rkCoinsA;
                rkCoinsB = result.rkCoinsB;
            }

            if ((exec.step === 'preparing' || exec.step === 'withdrawn') && cfg.swapToUsdc) {
                swappedUsdc = await stepSwap(pool, db, exec.id, cfg, rkCoinsA, rkCoinsB);
            }

            if (['preparing', 'withdrawn', 'swapped'].includes(exec.step) && cfg.sendTo) {
                await stepTransfer(pool, db, exec.id, cfg, rkCoinsA, rkCoinsB, swappedUsdc);
            }

            updateRkExecution(db, exec.id, { step: 'complete', completed_at: Date.now() });
            console.log(`[ranking-exit:${exec.pool_id}] Fortgesetzt und abgeschlossen.`);

        } catch (err) {
            console.error(`[ranking-exit:${exec.pool_id}] Fehler beim Fortsetzen: ${err.message}`);
            updateRkExecution(db, exec.id, { error_msg: err.message });
        } finally {
            releaseSlLock();
        }
    }
}
