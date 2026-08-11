/**
 * FORGE Liquidity – Opportunity-Score-Limit-Ausführung
 *
 * Überwacht den Opportunity Score eines Pools (aus html/…/data.json).
 * Unterschreitet er die konfigurierte Schwelle, wird das Kapital
 * komplett aus dem Pool abgezogen (optional USDC-Swap + Transfer).
 *
 * State-Machine pro Pool (persistiert in score_limit_executions):
 *   preparing → withdrawn → swapped → transferred → complete
 *
 * Score-Check (shouldTriggerScoreLimit):
 *   Nutzt investScore.exitValue aus data.json — bewusst NICHT denselben Wert wie im
 *   Dashboard/Cleanup-Min-Score-Feld (dort: investScore.value, inkl. Volumen-Malus).
 *   Der Malus soll nie einen Exit auslösen, siehe invest-score-compute.js.
 *   Kein API-Call, kein Rate-Limit-Risiko.
 *   Null-Score (Daten fehlen) → kein Trigger.
 */

import Database         from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath }   from 'url';

import { setPoolActive, config } from './config.js';
import { acquireSlLock, releaseSlLock, waitForCleanupToFinish } from './cleanup-lock.js';
import { getKeypair, getConnection, getSolBalanceFresh } from './wallet.js';
import { ensureWalletSol, SOL_TOPUP_TARGET } from './sol-topup.js';
import { getAdapter } from './pool-adapter/index.js';
import {
    insertCapitalFlow,
    createScoreLimitExecution,
    updateScoreLimitExecution,
    getIncompleteScoreLimitExecutions,
    getOpenPosition,
    closePosition as markPositionClosedInDb,
} from './db.js';
import * as notify from './notify.js';
import { executeSwapStep, executeTransferStep, prepareExitAndClaimFees, finalizeClosePosition } from './exit-finalizer.js';
import { PATHS } from '../../../config/paths.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB = PATHS.settingsDb;
const DATA_PATH   = resolve(__dirname, '../../../html/liquidity/data/data.json');

function triggerPoolTypeAdvisorAsync() { /* Fork: Pool-Type-Advisor (#0219) ist Master-only, bin/pool-type-advisor.js nicht im Scope – bewusst no-op, Aufrufer unveraendert. */ }

// ─── Settings lesen ───────────────────────────────────────────────────────────

export function loadConfig(poolId) {
    try {
        const sdb = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        sdb.close();
        if (!row) return null;
        const s = JSON.parse(row.settings);
        return s?.scoreLimit ?? null;
    } catch {
        return null;
    }
}

// ─── Opportunity Score aus data.json ─────────────────────────────────────────

function loadOpportunityScore(poolId) {
    try {
        const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
        const pool = (data.pools ?? []).find(p => p.id === poolId);
        // exitValue: bei exitIgnorePnl-Pools der PnL-freie Score (verhindert kursgetriebene
        // Fehl-Exits), bei allen anderen identisch zu value. Fallback auf value für
        // Abwärtskompatibilität (ältere data.json ohne exitValue).
        return pool?.investScore?.exitValue ?? pool?.investScore?.value ?? null;
    } catch {
        return null;
    }
}

/**
 * Liest die InvestScore-Sub-Scores (APR + PnL 6h/12h/24h) aus data.json zum
 * Zeitpunkt des Trigger-Checks — dieselben Werte, die _computeInvestScore in
 * bin/export.js gerade berechnet hat. Wird im Score-Limit-Trigger dauerhaft
 * mitgeschrieben (score_limit_executions), damit der Pool-Type-Advisor (#0219)
 * spätere Fehlsignal-Analysen nicht aus position_snapshots rekonstruieren muss
 * (die nach jedem Reopen via clearPositionSnapshots() gelöscht werden).
 */
function loadInvestScoreSubScores(poolId) {
    try {
        const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
        const pool = (data.pools ?? []).find(p => p.id === poolId);
        const metrics = pool?.investScore?.metrics ?? [];
        const byLabel = (label) => metrics.find(m => m.label === label)?.score ?? null;
        return {
            aprScore:     byLabel('Fee-APR 24h'),
            pnl6hScore:   byLabel('PnL 6h'),
            pnl12hScore:  byLabel('PnL 12h'),
            pnl24hScore:  byLabel('PnL 24h'),
        };
    } catch {
        return null;
    }
}

// ─── Consecutive-Below-Threshold-Counter ─────────────────────────────────────
// Default minConsecutive=1 (Entscheidung 2026-07-29): Trigger feuert sofort im
// ersten Zyklus mit Score < Schwelle. Der Zähler/die Map bleiben trotzdem bestehen,
// weil `minConsecutive` weiterhin pro Pool auf einen höheren Wert gesetzt werden kann
// (nur derzeit ohne UI-Feld dafür) — dann greift wieder der Schutz gegen
// Einzelzyklus-Fehlauslösungen (z.B. kurze Preisdellen).

const _consecutiveBelow = new Map(); // poolId → count
const _slWarnSentAt     = new Map(); // poolId → timestamp letzte Warnung
const WARN_COOLDOWN_MS  = 10 * 60 * 1000;

// ─── SOL-Nachsicherung nach der Liquidierung ─────────────────────────────────
// Die VORsicherung liegt in stepWithdraw() (prepareExitAndClaimFees, exit-finalizer.js)
// — dort greift sie auch im Resume-Pfad. Hier bleibt nur das Auffüllen NACH dem Exit,
// damit ein folgender Pool im Crash-Fall wieder mit vollem Polster startet.
// Boden + Ziel jetzt einheitlich aus config.solReserve/lib/sol-topup.js abgeleitet
// (2026-07-29, Ziel-Konstante zentralisiert 2026-07-30) statt eigener fester Zahlen
// — dieselbe Quelle wie cleanup.js/bot.js, siehe SOL_TOPUP_TARGET dort.
const SL_POST_MIN_SOL = config.solReserve; // Nach Liquidierung anstreben: mind. so viel SOL
const SL_TARGET_SOL   = SOL_TOPUP_TARGET;  // Ziel-SOL beim Auffüllen

// "Zu wenig SOL"-Meldung: pro Pool max. 1× pro Stunde (im Crash-Fall bewusst
// viele Meldungen — eine je betroffenem Pool, danach Cooldown).
const _solBlockedSentAt      = new Map(); // poolId → timestamp
const SOL_BLOCKED_COOLDOWN_MS = 60 * 60 * 1000;

async function _maybeNotifySolBlocked(pool, phase, solAfter) {
    const last = _solBlockedSentAt.get(pool.id) ?? 0;
    if (Date.now() - last < SOL_BLOCKED_COOLDOWN_MS) return;
    _solBlockedSentAt.set(pool.id, Date.now());
    await notify.solTopupFailed(pool, phase, solAfter).catch(() => {});
}

// ─── Öffentlich: Score-Check ──────────────────────────────────────────────────

/**
 * Vorwarnung: feuert beim ersten Zyklus mit Score < minScore (count = 1).
 * Muss im Bot-Loop NACH shouldTriggerScoreLimit aufgerufen werden, damit der
 * _consecutiveBelow-Counter für diesen Zyklus bereits aktuell ist.
 * Cooldown 10 Min verhindert Spam.
 */
export async function checkScoreLimitWarning(pool, db, isInRange = true) {
    if (!isInRange) return;
    const cfg = loadConfig(pool.id);
    if (!cfg?.enabled) return;

    const count = _consecutiveBelow.get(pool.id) ?? 0;
    if (count < 1) return;

    const lastWarn = _slWarnSentAt.get(pool.id) ?? 0;
    if (Date.now() - lastWarn < WARN_COOLDOWN_MS) return;

    const score    = loadOpportunityScore(pool.id) ?? '?';
    const minScore = Number.isFinite(cfg.minScore) ? cfg.minScore : 30;
    const snap     = db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).get(pool.id);
    const lpUsd = snap?.lp_value_usd ?? 0;

    _slWarnSentAt.set(pool.id, Date.now());
    const label = { k: 'notify.liq.rm_label_score', p: { score, min: minScore } };
    console.log(`[scoreLimit:${pool.id}] Vorwarnung: Score-Limit (Score ${score} < ${minScore}), LP ${lpUsd.toFixed(2)} USDC`);
    await notify.rmWarning(pool, label, lpUsd).catch(() => {});
}

/**
 * Gibt true zurück wenn der Score-Limit für diesen Pool feuern soll.
 * Null-Score (Daten fehlen) → kein Trigger (sicherer Default).
 * Score unter Schwelle → sofortiger Trigger (Default minConsecutive=1, Entscheidung
 * 2026-07-29 — vorher 3 aufeinanderfolgende Zyklen als Schutz gegen Einzelzyklus-
 * Ausreißer; bewusst aufgegeben zugunsten schnellerer Reaktion). `minConsecutive`
 * bleibt pro Pool überschreibbar (Settings-JSON), nur ohne UI-Feld dafür.
 *
 * @param {boolean} isInRange  false wenn Position aktuell OOR ist.
 *   Im OOR-Zustand wird der Consecutive-Counter zurückgesetzt und kein Trigger ausgelöst –
 *   der Score ist OOR-bedingt deprimiert und kein verlässliches Ausstiegssignal.
 */
export function shouldTriggerScoreLimit(pool, db, isInRange = true) {
    const cfg = loadConfig(pool.id);
    if (!cfg?.enabled) return false;

    // OOR: Counter zurücksetzen, kein Trigger – Score im OOR-Zustand nicht verwertbar
    if (!isInRange) {
        const prev = _consecutiveBelow.get(pool.id) ?? 0;
        if (prev > 0) {
            console.log(`[scoreLimit:${pool.id}] Position OOR – Counter zurückgesetzt (war ${prev})`);
            _consecutiveBelow.delete(pool.id);
        }
        return false;
    }

    const score = loadOpportunityScore(pool.id);
    if (score === null) {
        _consecutiveBelow.delete(pool.id);
        return false;
    }

    const minScore       = Number.isFinite(cfg.minScore)       ? cfg.minScore       : 30;
    const minConsecutive = Number.isFinite(cfg.minConsecutive) ? cfg.minConsecutive :  1;

    if (score >= minScore) {
        _consecutiveBelow.delete(pool.id);
        return false;
    }

    const prev  = _consecutiveBelow.get(pool.id) ?? 0;
    const count = prev + 1;
    _consecutiveBelow.set(pool.id, count);

    if (count < minConsecutive) {
        console.warn(`[scoreLimit:${pool.id}] Score ${score} ≤ ${minScore} (${count}/${minConsecutive} Zyklen) – noch kein Trigger`);
        return false;
    }

    return true;
}

// ─── State-Machine ────────────────────────────────────────────────────────────

async function stepWithdraw(pool, db, execId, cfg) {
    const adapter  = getAdapter(pool);
    const position = getOpenPosition(db, pool.id);

    let feesA = 0, feesB = 0;

    if (position) {
        // SOL-Vorsicherung + Fee-Claim (letzterer entfällt bei knappem SOL).
        // Blockiert den Ausstieg nie — siehe prepareExitAndClaimFees(). Greift
        // damit auch im Resume-Pfad, der genau hier vorbeikommt.
        const fees = await prepareExitAndClaimFees(adapter, pool, position, db, {
            logPrefix: `[scoreLimit:${pool.id}]`,
        });
        feesA = fees.amountA;
        feesB = fees.amountB;
        if (!fees.skipped) {
            console.log(`[scoreLimit:${pool.id}] Fees geclaimed: ${feesA.toFixed(6)} A + ${feesB.toFixed(6)} B`);
        }

        const { closed, coinsA, coinsB } = await finalizeClosePosition(adapter, pool, position, db, {
            feesA, feesB,
            note:      'score-limit',
            logPrefix: `[scoreLimit:${pool.id}]`,
        });

        markPositionClosedInDb(db, position.id, closed.txHash);

        updateScoreLimitExecution(db, execId, {
            step:    'withdrawn',
            coins_a: coinsA,
            coins_b: coinsB,
        });
        return { coinsA, coinsB };
    } else {
        console.log(`[scoreLimit:${pool.id}] Keine offene Position mehr – überspringe Withdraw`);
        updateScoreLimitExecution(db, execId, { step: 'withdrawn', coins_a: 0, coins_b: 0 });
        return { coinsA: 0, coinsB: 0 };
    }
}

async function stepSwap(pool, db, execId, cfg, coinsA, coinsB) {
    return executeSwapStep(pool, {
        coinsA,
        coinsB,
        sendTo:      cfg.sendTo,
        logPrefix:   `[scoreLimit:${pool.id}]`,
        slippageBps: config.rm.swapSlippageBps,
        onSwapped:   (swappedUsdc) => {
            updateScoreLimitExecution(db, execId, { step: 'swapped', swapped_usdc: swappedUsdc });
            insertCapitalFlow(db, { poolId: pool.id, usdcAmount: -swappedUsdc, note: 'score-limit-exit', isExternal: 1 });
            console.log(`[scoreLimit:${pool.id}] Kapitalabfluss erfasst: -${swappedUsdc.toFixed(2)} USDC`);
        },
    });
}

async function stepTransfer(pool, db, execId, cfg, coinsA, coinsB, swappedUsdc) {
    return executeTransferStep(pool, {
        coinsA,
        coinsB,
        swappedUsdc,
        sendTo:        cfg.sendTo,
        swapToUsdc:    cfg.swapToUsdc,
        logPrefix:     `[scoreLimit:${pool.id}]`,
        onTransferred: () => updateScoreLimitExecution(db, execId, { step: 'transferred' }),
    });
}

// ─── Haupt-Ausführung ─────────────────────────────────────────────────────────

export async function executeScoreLimit(pool, db) {
    const cfg = loadConfig(pool.id);
    if (!cfg?.enabled) return;

    const score    = loadOpportunityScore(pool.id);
    const minScore = Number.isFinite(cfg.minScore) ? cfg.minScore : 30;
    console.log(`[scoreLimit:${pool.id}] Score Limit ausgelöst: Opportunity Score ${score} < ${minScore}`);

    await waitForCleanupToFinish();
    acquireSlLock();

    let execId = null;
    try {
        const keypair    = getKeypair();
        const connection = getConnection();

        // Die SOL-Vorabsicherung sitzt jetzt in stepWithdraw() (via
        // prepareExitAndClaimFees) statt hier — bewusst, denn nur dort wird sie
        // auch im Resume-Pfad durchlaufen. Der frühere Vorcheck an dieser Stelle
        // hatte zusätzlich eine Lücke: sein Boden (0,05 SOL) lag UNTER dem Guard
        // in orca.closePosition (0,1 SOL). Bei 0,0975 SOL wurde deshalb gar kein
        // Topup versucht, und die Liquidierung starb erst in der Ausführung
        // (2026-07-29, siehe doc/CHANGELOG/2026-07-29.md).

        // Ab hier wird tatsächlich liquidiert → Consecutive-Counter zurücksetzen.
        _consecutiveBelow.delete(pool.id);

        execId = createScoreLimitExecution(db, {
            poolId:         pool.id,
            triggerScore:   score,
            configSnapshot: cfg,
            subScores:      loadInvestScoreSubScores(pool.id),
        });

        try {
            setPoolActive(pool.id, false);
            console.log(`[scoreLimit:${pool.id}] Pool auf active=false gesetzt`);
        } catch (err) {
            console.error(`[scoreLimit:${pool.id}] setPoolActive fehlgeschlagen: ${err.message}`);
        }

        const { coinsA, coinsB } = await stepWithdraw(pool, db, execId, cfg);

        let swappedUsdc = null;
        if (cfg.swapToUsdc) {
            swappedUsdc = await stepSwap(pool, db, execId, cfg, coinsA, coinsB);
        }

        if (cfg.sendTo) {
            await stepTransfer(pool, db, execId, cfg, coinsA, coinsB, swappedUsdc);
        }

        updateScoreLimitExecution(db, execId, { step: 'complete', completed_at: Date.now() });
        console.log(`[scoreLimit:${pool.id}] Score Limit vollständig abgeschlossen.`);
        const snap = db.prepare(`SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`).get(pool.id);
        await notify.rmExecuted(pool, { k: 'notify.liq.rm_label_score', p: { score, min: minScore } }, snap?.lp_value_usd ?? 0).catch(() => {});
        triggerPoolTypeAdvisorAsync(pool.id);

        // ── SOL-Nachsicherung ────────────────────────────────────────────────
        // Nach erfolgreicher Liquidierung SOL für Folge-Operationen sichern (im
        // Crash-Fall müssen ggf. weitere Pools liquidiert werden). Best-effort aus
        // verbleibendem Wallet-Guthaben; gelingt das Auffüllen nicht, Meldung.
        // Hinweis: hat cfg.sendTo das Kapital komplett abgezogen, ist u.U. nichts
        // mehr zum Swappen da — dann ist die Meldung korrekt.
        const solAfterExit = await getSolBalanceFresh(keypair.publicKey);
        if (solAfterExit < SL_POST_MIN_SOL) {
            console.warn(`[scoreLimit:${pool.id}] SOL nach Liquidierung ${solAfterExit.toFixed(4)} < ${SL_POST_MIN_SOL} – Nachfüll-Versuch (Ziel ${SL_TARGET_SOL} SOL)`);
            const heal = await ensureWalletSol(db, keypair, connection, {
                minSol: SL_POST_MIN_SOL, targetSol: SL_TARGET_SOL,
                log: msg => console.log(`[scoreLimit:${pool.id}] ${msg}`),
            });
            if (!heal.reachedTarget) {
                await _maybeNotifySolBlocked(pool, 'post', heal.solAfter);
            }
        }

    } catch (err) {
        console.error(`[scoreLimit:${pool.id}] FEHLER: ${err.message}`);
        if (execId) updateScoreLimitExecution(db, execId, { error_msg: err.message });
        await notify.scoreLimitError(pool, 'execution', err).catch(() => {});
        throw err;
    } finally {
        releaseSlLock();
    }
}

// ─── Startup: unvollständige Ausführungen fortsetzen ─────────────────────────

export async function resumePendingScoreLimitExecutions(db) {
    const pending = getIncompleteScoreLimitExecutions(db);
    if (!pending.length) return;

    console.log(`[scoreLimit] ${pending.length} unvollständige Score-Limit-Ausführung(en) gefunden – setze fort…`);

    for (const exec of pending) {
        const pool = config.pools.all.find(p => p.id === exec.pool_id);
        if (!pool) {
            console.warn(`[scoreLimit] Pool ${exec.pool_id} nicht in config – Ausführung übersprungen`);
            continue;
        }

        const cfg = exec.config_snapshot ? JSON.parse(exec.config_snapshot) : loadConfig(exec.pool_id);
        if (!cfg) {
            console.warn(`[scoreLimit] Keine Score-Limit-Config für ${exec.pool_id} – Ausführung übersprungen`);
            continue;
        }

        console.log(`[scoreLimit:${exec.pool_id}] Fortsetze ab Step '${exec.step}'`);
        acquireSlLock();

        try {
            let coinsA      = exec.coins_a ?? 0;
            let coinsB      = exec.coins_b ?? 0;
            let swappedUsdc = exec.swapped_usdc ?? null;

            if (exec.step === 'preparing') {
                const result = await stepWithdraw(pool, db, exec.id, cfg);
                coinsA = result.coinsA;
                coinsB = result.coinsB;
            }

            if ((exec.step === 'preparing' || exec.step === 'withdrawn') && cfg.swapToUsdc) {
                swappedUsdc = await stepSwap(pool, db, exec.id, cfg, coinsA, coinsB);
            }

            if (['preparing', 'withdrawn', 'swapped'].includes(exec.step) && cfg.sendTo) {
                await stepTransfer(pool, db, exec.id, cfg, coinsA, coinsB, swappedUsdc);
            }

            updateScoreLimitExecution(db, exec.id, { step: 'complete', completed_at: Date.now() });
            console.log(`[scoreLimit:${exec.pool_id}] Fortgesetzt und abgeschlossen.`);
            triggerPoolTypeAdvisorAsync(exec.pool_id);

        } catch (err) {
            console.error(`[scoreLimit:${exec.pool_id}] Fehler beim Fortsetzen: ${err.message}`);
            updateScoreLimitExecution(db, exec.id, { error_msg: err.message });
        } finally {
            releaseSlLock();
        }
    }
}
