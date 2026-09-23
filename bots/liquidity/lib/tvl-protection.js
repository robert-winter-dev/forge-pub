/**
 * FORGE Liquidity – TVL-Schutz (Pool-Exit bei TVL-Einbruch)
 *
 * Fällt der Pool-TVL unter eine konfigurierte Schwelle, wird Kapital aus dem
 * Pool gezogen — optional in USDC getauscht und an eine Adresse gesendet.
 *
 * Eine Stufe (Config aus settings.db → pool_settings.tvlProtection, gepflegt im
 * ForgeSettings-„Risk-Management"-Modal, Tab TVL): zieht withdrawPct % der Position
 * per decreaseLiquidity. Position bleibt offen, Pool bleibt aktiv — außer bei
 * withdrawPct = 100, dann ist es ein Voll-Exit (`isFull`, s.u. — closePosition,
 * Pool wird deaktiviert). Default seit 2026-08-15: 100 % raus.
 *
 * Die Stufe feuert pro Position maximal einmal (tvl_executions.position_id+level) —
 * das ist der einzige Schutz gegen Mehrfach-Auslösung. Der konfigurierte
 * `cooldownHours` wirkt bewusst NICHT hier, sondern ausschließlich im Cleanup
 * (bin/cleanup.js): er verhindert das sofortige Wiederbefüllen eines gerade
 * verlassenen Pools, darf aber nie den Kapitalschutz selbst aussperren.
 *
 * TVL-Quelle: letzter pool_stats.tvl_usd (stündlich aktualisiert) — kein API-Call
 * im Trigger-Check. Schwelle === null → Fallback auf pools.json (tvlWarn/Exit).
 *
 * State-Machine (persistiert in tvl_executions):
 *   preparing → withdrawn → swapped → transferred → complete
 * Bei Bot-Restart wird jede unvollständige Ausführung fortgesetzt
 * (resumePendingTvlExecutions).
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';

import { setPoolActive, setPoolEnabled, config } from './config.js';
import { acquireSlLock, releaseSlLock, waitForCleanupToFinish } from './cleanup-lock.js';
import { getTxFee, getKeypair, getConnection } from './wallet.js';
import { ensureExitCapableSol } from './sol-topup.js';
import { getTokenUsdPrice } from './deposit-lib.js';
import { writePositionSnapshotFromDelta } from './refresh-state.js';
import { getAdapter } from './pool-adapter/index.js';
import {
    insertTransaction, getOpenPosition,
    closePosition as markPositionClosedInDb,
    updatePositionCapital, updatePositionHodl,
    createTvlExecution, updateTvlExecution, getIncompleteTvlExecutions,
    isTvlLevelExecutedForPosition, getLastTvlLevelExecutionAt,
    rebaseHwmForCapitalFlow,
} from './db.js';
import * as notify from './notify.js';
import { executeSwapStep, executeTransferStep, prepareExitAndClaimFees, closePositionOrRescue, computeExitPnl, recordExitProceeds } from './exit-finalizer.js';
import { Percentage } from '@orca-so/common-sdk';
import { PATHS } from '../../../config/paths.js';
import { reasonPayload } from '../../../lib/pool-reason.js';
import { resolveTvlThresholds } from './tvl-thresholds.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB = PATHS.settingsDb;

const PARTIAL_SLIPPAGE = Percentage.fromFraction(1, 200); // 0,5 % für decreaseLiquidity

/**
 * Melde-Cooldown der Stufe-1-Warnung: höchstens EINE Warnung pro Pool und Tag.
 *
 * Bewusst getrennt vom Ausführungs-Cooldown (`cooldownHours`, Default 12 h): ein
 * anhaltend niedriger TVL ist ein Dauerzustand, den der Nutzer aussitzen können soll,
 * ohne mehrfach täglich dieselbe Meldung zu bekommen. Die Aktion selbst (Teil-Abzug)
 * läuft unabhängig davon weiter — gedrosselt wird nur die Benachrichtigung.
 *
 * Gilt ausdrücklich NICHT für einen Abzug von 100 %: das ist ein Voll-Exit und wird
 * immer gemeldet.
 */
const WARN_NOTIFY_COOLDOWN_MS = 24 * 3_600_000;

// ─── Settings-DB lesen ────────────────────────────────────────────────────────

export function loadTvlConfig(poolId) {
    try {
        const sdb = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        sdb.close();
        if (!row) return null;
        return JSON.parse(row.settings)?.tvlProtection ?? null;
    } catch {
        return null;
    }
}

/** Letzter bekannter Pool-TVL aus pool_stats. */
function latestTvl(db, poolId) {
    const row = db.prepare(
        `SELECT tvl_usd FROM pool_stats WHERE pool_id = ? AND tvl_usd > 0
         ORDER BY recorded_at DESC LIMIT 1`
    ).get(poolId);
    return row?.tvl_usd ?? 0;
}

/**
 * Ermittelt, welche Stufe (falls überhaupt) für diesen Pool jetzt feuern soll.
 * Gibt { level, levelCfg, threshold, tvl } zurück oder null.
 * Reine DB-Lookups, kein API-Call.
 */
function resolveTrigger(pool, db) {
    const cfg = loadTvlConfig(pool.id);
    if (!cfg) return null;

    const l1 = cfg.level1 ?? {};
    if (!l1.enabled) return null;

    const position = getOpenPosition(db, pool.id);
    if (!position) return null;

    const tvl = latestTvl(db, pool.id);
    if (!(tvl > 0)) return null; // kein verlässlicher TVL → nichts tun

    // Kein Cooldown-Check an dieser Stelle — bewusst.
    //
    // `cooldownHours` ist der *Cleanup*-Cooldown: er hält den Ranking-/Invest-Cleanup
    // davon ab, einen gerade verlassenen Pool sofort wieder zu befüllen (bin/cleanup.js,
    // _loadCleanupCooldownBlockedPools). Der Schutz selbst muss davon unberührt bleiben,
    // sonst wäre bis zu `cooldownHours` lang kein Notfall-Exit möglich, obwohl der TVL
    // weiter fällt — der Cooldown würde also ausgerechnet den Kapitalschutz aussperren,
    // den er nie gemeint hat (Klarstellung 2026-08-13).
    //
    // Gegen Mehrfach-Auslösung schützt stattdessen isTvlLevelExecutedForPosition():
    // jede Stufe feuert pro Position genau einmal. Die Drosselung der *Meldung* sitzt
    // getrennt davon in executeTvlProtection() (WARN_NOTIFY_COOLDOWN_MS).

    // Schwelle zentral auflösen (lib/tvl-thresholds.js) — dieselbe Auflösung nutzt
    // der Invest-Guard, damit „darf hinein" und „muss heraus" nie auseinanderlaufen
    // können.
    const th = resolveTvlThresholds(pool, cfg);

    // Stufe-1-Schwelle: konfiguriert, sonst pools.json (Fallback-Wahl siehe
    // lib/tvl-thresholds.js). Greift nur als Netz — ensureTvlProtectionDefaults setzt
    // die Schwelle bei jeder Aktivierung explizit, also bevor eine Position existiert.
    const t1 = th.l1.threshold;
    if (l1.enabled && t1 && tvl < t1 && !isTvlLevelExecutedForPosition(db, position.id, 1)) {
        return { level: 1, levelCfg: l1, threshold: t1, tvl, cfg, position };
    }

    return null;
}

// ─── Trigger-Check (vom Bot-Loop aufgerufen) ─────────────────────────────────

export function shouldTriggerTvlProtection(pool, db) {
    return resolveTrigger(pool, db) !== null;
}

// ─── Withdraw-Steps ──────────────────────────────────────────────────────────

/** Vollständiges Schließen (Voll-Exit): Fees claimen + closePosition. */
async function stepWithdrawFull(pool, db, execId) {
    const adapter  = getAdapter(pool);
    const position = getOpenPosition(db, pool.id);

    if (!position) {
        console.log(`[tvl-protection:${pool.id}] Keine offene Position mehr – überspringe Withdraw`);
        updateTvlExecution(db, execId, { step: 'withdrawn', coins_a: 0, coins_b: 0 });
        return { coinsA: 0, coinsB: 0 };
    }

    // SOL-Vorsicherung + Fee-Claim (letzterer entfällt bei knappem SOL).
    // Blockiert den Ausstieg nie — siehe prepareExitAndClaimFees().
    const fees = await prepareExitAndClaimFees(adapter, pool, position, db, {
        logPrefix: `[tvl-protection:${pool.id}]`,
    });
    const feesA = fees.amountA;
    const feesB = fees.amountB;
    if (!fees.skipped) {
        console.log(`[tvl-protection:${pool.id}] Fees geclaimed: ${feesA.toFixed(6)} A + ${feesB.toFixed(6)} B`);
    }

    // Gemeinsamer Ausstiegspfad (LIQ#0312). Zwei Änderungen gegenüber dem früheren
    // Eigenbau hier:
    //   • Ein gescheiterter NFT-Burn hält den schützenden Verkauf nicht mehr auf — geworfen
    //     wird nur, wenn die Entnahme selbst nicht stattgefunden hat.
    //   • Die close_position-Zeile bucht jetzt Fees + Close-Betrag. Der Fee-Claim bekommt
    //     bewusst KEINE eigene Zeile (siehe prepareExitAndClaimFees); hier stand bisher nur
    //     closed.amountA/B, wodurch der im selben Schritt geclaimte Anteil aus der
    //     Transaktionshistorie verschwand.
    const { coinsA, coinsB, closeTxHash, closePending } = await closePositionOrRescue(
        adapter, pool, position, db, {
            feesA, feesB, note: 'tvl-protection-l2', logPrefix: `[tvl-protection:${pool.id}]`,
        },
    );

    markPositionClosedInDb(db, position.id, closeTxHash);

    updateTvlExecution(db, execId, {
        step: 'withdrawn', coins_a: coinsA, coins_b: coinsB,
        ...(closePending && { close_error: closePending.reason }),
    });
    return { coinsA, coinsB };
}

/** Teil-Abzug (L1): decreaseLiquidity um withdrawPct % des Positionswerts.
 *  Position bleibt offen, Pool bleibt aktiv. */
async function stepWithdrawPartial(pool, db, execId, withdrawPct) {
    const adapter  = getAdapter(pool);
    const position = getOpenPosition(db, pool.id);

    if (!position) {
        console.log(`[tvl-protection:${pool.id}] Keine offene Position mehr – überspringe Teil-Abzug`);
        updateTvlExecution(db, execId, { step: 'withdrawn', coins_a: 0, coins_b: 0 });
        return { coinsA: 0, coinsB: 0 };
    }

    // Positionswert aus letztem Snapshot
    const snap = db.prepare(
        'SELECT lp_value_usd, amount_a, amount_b FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1'
    ).get(pool.id);
    const posValue = snap?.lp_value_usd ?? position.capital_usdc ?? 0;
    if (!(posValue > 0)) {
        throw new Error('Positionswert ist 0 – Teil-Abzug nicht möglich.');
    }
    const withdrawUsdc = posValue * (withdrawPct / 100);

    // Quote-Preis für volatilePair-Pools
    let refPriceUsd = 0;
    if (pool.volatilePair) {
        refPriceUsd = getTokenUsdPrice(pool.quoteTokenMint, db);
        if (!(refPriceUsd > 0)) throw new Error(`Quote-Preis nicht verfügbar für ${pool.quoteTokenMint}.`);
    }

    // SOL-Vorsicherung. L1 hat keinen Fee-Claim und läuft deshalb nicht über
    // prepareExitAndClaimFees() — die Selbstheilung wird hier direkt aufgerufen.
    // Ergebnis wird bewusst nicht ausgewertet: auch ein Teil-Abzug gibt Kapital
    // frei und darf nie an der SOL-Reserve scheitern; den physikalischen Boden
    // prüft decreaseLiquidity selbst (assertSufficientSolForExit).
    const solState = await ensureExitCapableSol(db, getKeypair(), getConnection(), {
        log: msg => console.log(`[tvl-protection:${pool.id}] ${msg}`),
    });
    if (solState.tight) {
        console.warn(`[tvl-protection:${pool.id}] SOL knapp (${solState.sol.toFixed(4)}) – Teil-Abzug läuft trotzdem`);
    }

    console.log(`[tvl-protection:${pool.id}] Teil-Abzug ${withdrawPct}% → ~${withdrawUsdc.toFixed(2)} USDC (Positionswert ~${posValue.toFixed(2)})`);
    const result = await adapter.decreaseLiquidity(pool, position.nft_mint, withdrawUsdc, PARTIAL_SLIPPAGE, refPriceUsd);

    const coinsA = result.tokenEstA ?? 0;
    const coinsB = result.tokenEstB ?? 0;
    const withdrawnUsdc = (result.fraction ?? (withdrawPct / 100)) * posValue;

    // DB-Buchführung (analog bin/withdraw.js)
    const oldCapital = position.capital_usdc ?? 0;
    updatePositionCapital(db, position.id, Math.max(0, oldCapital - withdrawnUsdc));
    updatePositionHodl(db, position.id, -coinsA, -coinsB);

    // HWM nachziehen — zwingend, sonst löst der eigene Teil-Abzug den Trailing Stop aus.
    // Der Trailing Stop vergleicht lp_value_usd gegen hwm_usd. Ein L1-Abzug von z.B. 50 %
    // halbiert lp_value_usd, während hwm_usd auf dem Wert VOR dem Eingriff stehen bleibt —
    // der resultierende „Drawdown" von ~50 % reißt jede übliche Schwelle (Default 2 %) und
    // schließt die Position komplett. Damit war L1 faktisch wirkungslos: statt „Position
    // bleibt offen, Pool bleibt aktiv" (siehe Kopf dieser Datei) folgte binnen Sekunden ein
    // Voll-Exit. Belegt 2026-08-13 auf Master und forge-pub1, je zweimal in Folge
    // (HWM 21,46 → lp 10,71 = 50,1 % Drawdown, Trailing Stop 29 s später).
    // bin/withdraw.js macht dasselbe bei jeder manuellen Teilentnahme — hier fehlte es.
    // Kein harter Reset: rebaseHwmForCapitalFlow() rettet den bereits aufgelaufenen Abstand zum
    // Höchststand über den Eingriff hinweg (posValue = gemessener Wert VOR dem Abzug), den neuen
    // absoluten Referenzwert etabliert der nächste Bot-Snapshot.
    const hwmRebase = rebaseHwmForCapitalFlow(db, position.id, posValue);
    console.log(`[tvl-protection:${pool.id}] Trailing-Stop-Referenz übertragen (Teil-Abzug ${withdrawPct}%, Abstand zum Höchststand ${hwmRebase.drawdownPct.toFixed(2)} %)`);

    if ((result.fraction ?? 1) < 0.999) {
        // Sofort-Snapshot für Dashboard; currentPrice aus letztem pool_stats
        const priceRow = db.prepare(
            'SELECT price FROM pool_stats WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1'
        ).get(pool.id);
        writePositionSnapshotFromDelta(db, pool, -coinsA, -coinsB, priceRow?.price ?? 0);
    }

    const wdFee = await getTxFee(result.txHash).catch(() => null);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'withdraw',
        amountA:  coinsA,
        amountB:  coinsB,
        // Betrag IMMER positiv — die Richtung steckt im `type`. Ein negatives
        // usd_value dreht in lib/pnl.js (CASE ... ELSE -usd_value) das Vorzeichen
        // ein zweites Mal: die Entnahme wird dort zur Einzahlung, der Kapital-Anker
        // wächst statt zu schrumpfen und es entsteht ein Phantomverlust in Höhe des
        // DOPPELTEN Abzugs. Belegt 2026-08-13 auf forge-pub1: Abzug 28,23 USDC →
        // PnL −56,41 USDC bei real unverändertem Guthaben.
        usdValue: withdrawnUsdc,
        txHash:   result.txHash,
        txFeeSol: wdFee,
        note:     'tvl-protection-l1',
    });

    updateTvlExecution(db, execId, { step: 'withdrawn', coins_a: coinsA, coins_b: coinsB });
    return { coinsA, coinsB };
}

// ─── Swap- / Transfer-Steps (gemeinsam) ──────────────────────────────────────

async function stepSwap(pool, db, execId, levelCfg, coinsA, coinsB, isFullClose = false) {
    return executeSwapStep(pool, {
        coinsA, coinsB,
        sendTo:      levelCfg.sendTo,
        logPrefix:   `[tvl-protection:${pool.id}]`,
        slippageBps: config.rm.swapSlippageBps,
        db,
        onSwapped:   (swappedUsdc) => {
            updateTvlExecution(db, execId, { step: 'swapped', swapped_usdc: swappedUsdc });
            // isFullClose: nur der Voll-Close hat eine close_position-Zeile, die den
            // realen Erlös aufnehmen kann. Der Teil-Abzug bucht seinen Betrag selbst
            // in die withdraw-Zeile (stepWithdrawPartial).
            recordExitProceeds(db, { poolId: pool.id, swappedUsdc, note: 'tvl-protection-exit', isFullClose });
            console.log(`[tvl-protection:${pool.id}] Kapitalabfluss erfasst: -${swappedUsdc.toFixed(2)} USDC`);
        },
    });
}

async function stepTransfer(pool, db, execId, levelCfg, coinsA, coinsB, swappedUsdc) {
    return executeTransferStep(pool, {
        coinsA, coinsB,
        swappedUsdc,
        sendTo:        levelCfg.sendTo,
        swapToUsdc:    levelCfg.swapToUsdc,
        logPrefix:     `[tvl-protection:${pool.id}]`,
        onTransferred: () => updateTvlExecution(db, execId, { step: 'transferred' }),
    });
}

// ─── Haupt-Ausführung ────────────────────────────────────────────────────────

export async function executeTvlProtection(pool, db) {
    const trigger = resolveTrigger(pool, db);
    if (!trigger) return;

    const { level, levelCfg, threshold, tvl, position, cfg } = trigger;
    const withdrawPct = Number(levelCfg.withdrawPct);
    const isFull = level === 2 || withdrawPct >= 100;

    // Pool-Wert vor dem Withdraw festhalten (für die Abschlussmeldung) – gleiche
    // Quelle wie trailing-stop.js: letzter position_snapshots-Eintrag, kein API-Call.
    const lpValueRow = db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ?
         ORDER BY recorded_at DESC LIMIT 1`
    ).get(pool.id);
    const lpValueUsd = lpValueRow?.lp_value_usd ?? null;

    // swapToUsdc/sendTo gelten global für beide Stufen. Im Snapshot mitspeichern,
    // damit der Resume-Pfad nach einem Crash selbst-enthaltend ist.
    const actionCfg = { ...levelCfg, swapToUsdc: cfg.swapToUsdc, sendTo: cfg.sendTo };

    console.log(`[tvl-protection:${pool.id}] Stufe ${level} ausgelöst: TVL ${(tvl/1e6).toFixed(2)}M < Schwelle ${(threshold/1e6).toFixed(2)}M → ${isFull ? 'Voll-Exit' : withdrawPct + '% Teil-Abzug'}`);

    // Melde-Cooldown der L1-Warnung: VOR createTvlExecution lesen, sonst zählt die
    // gerade angelegte Ausführung als „letzte" und die Sperre greift nie.
    const lastWarnAt   = (!isFull && level === 1) ? getLastTvlLevelExecutionAt(db, pool.id, 1) : 0;
    const suppressWarn = lastWarnAt > 0 && (Date.now() - lastWarnAt) < WARN_NOTIFY_COOLDOWN_MS;

    await waitForCleanupToFinish();
    acquireSlLock();

    const execId = createTvlExecution(db, {
        poolId:         pool.id,
        positionId:     position.id,
        level,
        tvlUsd:         tvl,
        thresholdUsd:   threshold,
        withdrawPct,
        configSnapshot: actionCfg,
    });

    try {
        // Nur EIN Kanal: notify.tvlWarnAlert/tvlExitAlert (→ Nexus, inkl. Pool-Name).
        // Der frühere zusätzliche insertNotification()-Eintrag (lokale DB, ohne Pool-Name)
        // landete über export.js als redundanter zweiter Eintrag in derselben Dashboard-
        // Glocke (gleiches Muster wie der APR-Alert-Fix, siehe bot.js). Entfernt.
        if (suppressWarn) {
            const hoursAgo = ((Date.now() - lastWarnAt) / 3_600_000).toFixed(1);
            console.log(`[tvl-protection:${pool.id}] TVL-Warnung unterdrückt – letzte Warnung vor ${hoursAgo} h (Melde-Cooldown 24 h). Teil-Abzug läuft trotzdem.`);
        } else {
            await (isFull
                ? notify.tvlExitAlert(pool, tvl, threshold)
                : notify.tvlWarnAlert(pool, tvl, threshold)).catch(() => {});
        }

        // Bei Voll-Exit: Pool sofort inaktiv → verhindert Re-Open im nächsten Tick.
        // Zusätzlich Benutzer-Freigabe entziehen (enabled=false): nach einem
        // TVL-Voll-Exit muss der Pool erst manuell wieder freigegeben werden, sonst
        // würde der Ranking-Cleanup ihn bei erholtem Score blind reaktivieren.
        if (isFull) {
            try {
                setPoolActive(pool.id, false);
                console.log(`[tvl-protection:${pool.id}] Pool auf active=false gesetzt`);
            } catch (err) {
                console.error(`[tvl-protection:${pool.id}] setPoolActive fehlgeschlagen: ${err.message}`);
            }
            try {
                setPoolEnabled(pool.id, false, reasonPayload('reason.tvl_full_exit', {
                    tvl: (tvl / 1e6).toFixed(2), threshold: (threshold / 1e6).toFixed(2),
                }));
                console.log(`[tvl-protection:${pool.id}] Pool gesperrt (enabled=false) – manuelle Freigabe nötig`);
            } catch (err) {
                console.error(`[tvl-protection:${pool.id}] setPoolEnabled fehlgeschlagen: ${err.message}`);
            }
        }

        // Phase 2: Withdraw
        const { coinsA, coinsB } = isFull
            ? await stepWithdrawFull(pool, db, execId)
            : await stepWithdrawPartial(pool, db, execId, withdrawPct);

        // Phase 3: Swap (optional)
        let swappedUsdc = null;
        if (actionCfg.swapToUsdc) {
            swappedUsdc = await stepSwap(pool, db, execId, actionCfg, coinsA, coinsB, isFull);
        }

        // Phase 4: Transfer (optional)
        if (actionCfg.sendTo) {
            await stepTransfer(pool, db, execId, actionCfg, coinsA, coinsB, swappedUsdc);
        }

        // Phase 5: Abschluss
        updateTvlExecution(db, execId, { step: 'complete', completed_at: Date.now() });
        if (isFull) {
            // Best-effort: eine fehlschlagende PnL-Berechnung darf den bereits
            // abgeschlossenen Exit nicht nachträglich als Fehler melden.
            let pnlUsdc = null;
            try {
                if (position) pnlUsdc = computeExitPnl(db, pool, position);
            } catch (err) {
                console.warn(`[tvl-protection:${pool.id}] PnL-Berechnung fehlgeschlagen (nicht kritisch): ${err.message}`);
            }
            await notify.tvlExitCompleted(pool, tvl, threshold, {
                lpValueUsd, coinsA, coinsB, swappedUsdc, pnlUsdc,
            }).catch(() => {});
        }
        console.log(`[tvl-protection:${pool.id}] Stufe ${level} vollständig abgeschlossen.`);

    } catch (err) {
        console.error(`[tvl-protection:${pool.id}] FEHLER: ${err.message}`);
        updateTvlExecution(db, execId, { error_msg: err.message });
        await notify.error(pool.displayPair ?? pool.pair, err).catch(() => {});
        throw err;
    } finally {
        releaseSlLock();
    }
}

// ─── Startup: unvollständige Ausführungen fortsetzen ─────────────────────────

export async function resumePendingTvlExecutions(db) {
    const pending = getIncompleteTvlExecutions(db);
    if (!pending.length) return;

    console.log(`[tvl-protection] ${pending.length} unvollständige TVL-Schutz-Ausführung(en) gefunden – setze fort…`);

    for (const exec of pending) {
        const pool = config.pools.all.find(p => p.id === exec.pool_id);
        if (!pool) {
            console.warn(`[tvl-protection] Pool ${exec.pool_id} nicht in config – übersprungen`);
            continue;
        }
        const levelCfg = exec.config_snapshot ? JSON.parse(exec.config_snapshot) : null;
        if (!levelCfg) {
            console.warn(`[tvl-protection] Keine Config für ${exec.pool_id} – übersprungen`);
            continue;
        }
        const isFull = exec.level === 2 || Number(exec.withdraw_pct) >= 100;

        console.log(`[tvl-protection:${exec.pool_id}] Fortsetze Stufe ${exec.level} ab Step '${exec.step}'`);
        acquireSlLock();
        try {
            let coinsA      = exec.coins_a ?? 0;
            let coinsB      = exec.coins_b ?? 0;
            let swappedUsdc = exec.swapped_usdc ?? null;

            if (exec.step === 'preparing') {
                const r = isFull
                    ? await stepWithdrawFull(pool, db, exec.id)
                    : await stepWithdrawPartial(pool, db, exec.id, Number(exec.withdraw_pct));
                coinsA = r.coinsA;
                coinsB = r.coinsB;
            }
            if ((exec.step === 'preparing' || exec.step === 'withdrawn') && levelCfg.swapToUsdc) {
                swappedUsdc = await stepSwap(pool, db, exec.id, levelCfg, coinsA, coinsB, isFull);
            }
            if (['preparing', 'withdrawn', 'swapped'].includes(exec.step) && levelCfg.sendTo) {
                await stepTransfer(pool, db, exec.id, levelCfg, coinsA, coinsB, swappedUsdc);
            }

            // error_msg mit löschen: 'complete' und eine stehende Fehlermeldung schließen
            // sich aus. Ein liegengebliebenes NFT steht getrennt davon in close_error.
            updateTvlExecution(db, exec.id, { step: 'complete', completed_at: Date.now(), error_msg: null });
            console.log(`[tvl-protection:${exec.pool_id}] Fortgesetzt und abgeschlossen.`);
        } catch (err) {
            console.error(`[tvl-protection:${exec.pool_id}] Fehler beim Fortsetzen: ${err.message}`);
            updateTvlExecution(db, exec.id, { error_msg: err.message });
        } finally {
            releaseSlLock();
        }
    }
}
