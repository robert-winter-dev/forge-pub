/**
 * FORGE.pub Premium – Exit nach Rückstufung eines übernommenen Pools
 *
 * Produktentscheidung 2026-07-29 (pool-offers.md): stuft der Master einen per
 * Premium-Offer übernommenen Pool zurück — oder fällt er aus einer nachweislich
 * vollständigen Angebotsliste heraus — wird das Guthaben aus dem Pool gezogen,
 * automatisch in USDC getauscht und der Nutzer per System-Message informiert.
 *
 * OB überhaupt ausgelöst wird, entscheidet ausschließlich lib/pool-offer-sync.js
 * (Herkunft, Frische, Vollständigkeit, Bestätigungsfenster — dort ausführlich
 * begründet). Diese Datei führt nur aus, und zwar nach demselben Muster wie die
 * übrigen Exit-Mechanismen (lib/ranking-exit.js, lib/tvl-protection.js):
 *
 *   State-Machine (persistiert in retire_executions):
 *     preparing → withdrawn → swapped → complete
 *   Bei Bot-Restart wird jede unvollständige Ausführung fortgesetzt
 *   (resumePendingRetireExecutions).
 *
 * ─── Zwei bewusste Abweichungen von den anderen Exit-Modulen ─────────────────
 *
 * 1. KEIN Transfer-Step. Die anderen Module können den Erlös an eine konfigurierte
 *    `sendTo`-Adresse senden. Hier nicht: dieser Exit wird durch GELIEFERTE DATEN
 *    ausgelöst. Ein Auszahlungsziel, das aus derselben Richtung beeinflussbar wäre,
 *    würde aus einem harmlosen Fehlauslöser („Kapital sicher in USDC") einen
 *    Vermögensabfluss machen. Der Erlös bleibt immer in der Wallet des Nutzers.
 *
 * 2. `forceCoins: true` beim Swap. Getauscht wird ausschließlich, was aus DIESEM
 *    Pool kam — nie der übrige Wallet-Bestand desselben Tokens (den würde
 *    executeSwapStep ohne `sendTo` sonst mitnehmen, siehe exit-finalizer.js).
 *    Eine Rückstufung betrifft einen Pool, nicht das Depot.
 *
 * Vor dem Withdraw wird der Pool zusätzlich unabhängig on-chain gelesen: ist der
 * Whirlpool-Account gerade nicht lesbar, wird NICHT gehandelt, sondern der nächste
 * Zyklus abgewartet. Kapital wird nie blind bewegt.
 */

import { setPoolActive, setPoolEnabled, config } from './config.js';
import { acquireSlLock, releaseSlLock, waitForCleanupToFinish } from './cleanup-lock.js';
import { getTxFee } from './wallet.js';
import { getAdapter } from './pool-adapter/index.js';
import { fetchOnChainPool } from './pool-offers-validator.js';
import {
    insertTransaction, getOpenPosition,
    closePosition as markPositionClosedInDb,
    createRetireExecution, updateRetireExecution, getIncompleteRetireExecutions,
    hasCompletedRetireExecution, getPoolOfferState,
    recordRetirementSighting, clearRetirementSighting,
} from './db.js';
import { loadPoolOffers } from './premium-offers-store.js';
import { detectRetirementSignals, resolveRetirementAction, CONFIRM_MS } from './pool-offer-sync.js';
import * as notify from './notify.js';
import { executeSwapStep, prepareExitAndClaimFees } from './exit-finalizer.js';

const LOG = poolId => `[pool-retirement:${poolId}]`;

/** Letzter selbst gemessener Pool-TVL — Beleg der eigenen Datenlage, kein Trigger. */
function observedTvl(db, poolId) {
    const row = db.prepare(
        `SELECT tvl_usd FROM pool_stats WHERE pool_id = ? AND tvl_usd > 0
         ORDER BY recorded_at DESC LIMIT 1`
    ).get(poolId);
    return row?.tvl_usd ?? null;
}

function observedLpValue(db, poolId) {
    const row = db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).get(poolId);
    return row?.lp_value_usd ?? null;
}

/**
 * Unabhängige Chain-Lesung vor dem Kapital-Exit. Prüft nicht die Rückstufung selbst
 * (die ist ein Urteil des Masters, nicht on-chain nachvollziehbar), sondern dass der
 * Pool, den wir gleich verlassen, wirklich der Pool aus unserer Konfiguration ist.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyPoolOnChain(pool) {
    let onChain;
    try {
        onChain = await fetchOnChainPool(pool.address);
    } catch (err) {
        return { ok: false, reason: `Whirlpool-Account nicht lesbar (${err.message})` };
    }
    const mismatches = [];
    if (onChain.tokenMintA !== pool.tokenA) mismatches.push(`tokenA ${pool.tokenA} ≠ ${onChain.tokenMintA}`);
    if (onChain.tokenMintB !== pool.tokenB) mismatches.push(`tokenB ${pool.tokenB} ≠ ${onChain.tokenMintB}`);
    if (mismatches.length > 0) {
        return { ok: false, reason: `On-Chain-Abweichung: ${mismatches.join(', ')}` };
    }
    return { ok: true };
}

// ─── State-Machine-Steps ─────────────────────────────────────────────────────

async function stepWithdraw(pool, db, execId) {
    const adapter = getAdapter(pool);
    const position = getOpenPosition(db, pool.id);

    if (!position) {
        console.log(`${LOG(pool.id)} Keine offene Position – nichts abzuziehen`);
        updateRetireExecution(db, execId, { step: 'withdrawn', coins_a: 0, coins_b: 0 });
        return { coinsA: 0, coinsB: 0 };
    }

    // SOL-Vorsicherung + Fee-Claim (letzterer entfällt bei knappem SOL).
    // Blockiert den Ausstieg nie — siehe prepareExitAndClaimFees().
    const fees = await prepareExitAndClaimFees(adapter, pool, position, db, {
        logPrefix: LOG(pool.id),
    });
    const feesA = fees.amountA;
    const feesB = fees.amountB;
    if (!fees.skipped) {
        console.log(`${LOG(pool.id)} Fees geclaimed: ${feesA.toFixed(6)} A + ${feesB.toFixed(6)} B`);
    }

    const closed = await adapter.closePosition(pool, position.nft_mint);
    const coinsA = feesA + (closed.amountA ?? 0);
    const coinsB = feesB + (closed.amountB ?? 0);
    console.log(`${LOG(pool.id)} Position geschlossen: ${coinsA.toFixed(6)} A + ${coinsB.toFixed(6)} B  TX: ${closed.txHash}`);

    const closeFee = await getTxFee(closed.txHash).catch(() => null);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'close_position',
        amountA:  closed.amountA ?? 0,
        amountB:  closed.amountB ?? 0,
        usdValue: null,
        txHash:   closed.txHash,
        txFeeSol: closeFee,
        note:     'premium-retirement',
    });
    markPositionClosedInDb(db, position.id, closed.txHash);

    updateRetireExecution(db, execId, { step: 'withdrawn', coins_a: coinsA, coins_b: coinsB });
    return { coinsA, coinsB };
}

async function stepSwap(pool, db, execId, coinsA, coinsB) {
    return executeSwapStep(pool, {
        coinsA, coinsB,
        sendTo:     null,      // nie an eine Adresse senden, siehe Dateikopf
        forceCoins: true,      // nur die Coins aus DIESEM Pool, siehe Dateikopf
        logPrefix:  LOG(pool.id),
        slippageBps: config.rm.swapSlippageBps,
        onSwapped:  (swappedUsdc) => {
            updateRetireExecution(db, execId, { step: 'swapped', swapped_usdc: swappedUsdc });
            console.log(`${LOG(pool.id)} In USDC getauscht: ${swappedUsdc.toFixed(2)}`);
        },
    });
}

// ─── Haupt-Ausführung ────────────────────────────────────────────────────────

/**
 * Führt den Exit aus. Darf nur aufgerufen werden, wenn pool-offer-sync.js
 * `action === 'exit'` ergeben hat.
 *
 * @param {object} pool
 * @param {import('better-sqlite3').Database} db
 * @param {{kind: string, reason: string}} signal
 * @returns {Promise<{executed: boolean, reason?: string, swappedUsdc?: number}>}
 */
export async function executeRetirementExit(pool, db, signal) {
    // Erst lesen, dann handeln: bei blindem RPC lieber gar nichts tun.
    const verified = await verifyPoolOnChain(pool);
    if (!verified.ok) {
        console.warn(`${LOG(pool.id)} Exit verschoben – ${verified.reason}`);
        return { executed: false, reason: verified.reason };
    }

    const tvlUsd = observedTvl(db, pool.id);
    const lpUsd  = observedLpValue(db, pool.id);

    console.log(`${LOG(pool.id)} Rückstufung bestätigt (${signal.kind}) – Exit startet. `
        + `Eigene Messung: TVL ${tvlUsd ?? 'no data'}, LP ${lpUsd ?? 'no data'}`);

    await waitForCleanupToFinish();
    acquireSlLock();

    const execId = createRetireExecution(db, {
        poolId: pool.id,
        triggerKind: signal.kind,
        triggerReason: signal.reason,
        observedTvlUsd: tvlUsd,
        observedLpUsd: lpUsd,
        configSnapshot: { kind: signal.kind, reason: signal.reason },
    });

    try {
        // Beide Sperren zuerst: verhindert, dass der Ranking-Cleanup im selben oder
        // nächsten Zyklus wieder Kapital hineinlegt, während der Exit läuft.
        for (const [fn, label] of [[setPoolActive, 'active'], [setPoolEnabled, 'enabled']]) {
            try {
                fn(pool.id, false);
            } catch (err) {
                console.error(`${LOG(pool.id)} set${label} fehlgeschlagen: ${err.message}`);
            }
        }

        const { coinsA, coinsB } = await stepWithdraw(pool, db, execId);
        const swappedUsdc = await stepSwap(pool, db, execId, coinsA, coinsB);

        // BEWUSST KEIN capital_flows-Eintrag (anders als ranking-exit/tvl-protection,
        // die den Erlös an eine sendTo-Adresse schicken können): hier verlässt kein
        // Kapital das System, der USDC-Erlös liegt weiter in derselben Wallet. Ein
        // negativer „Abfluss" wäre ein Phantom-Wert, der später in Auswertungen
        // auftaucht, ohne dass je Geld geflossen ist. Für den PnL zählt ohnehin die
        // Session-Grenze aus der close_position-Transaction (siehe FORGE/lib/pnl.js:
        // der lmb3-Adapter liest capital_flows gar nicht).
        updateRetireExecution(db, execId, { step: 'complete', completed_at: Date.now() });
        console.log(`${LOG(pool.id)} Exit abgeschlossen (${swappedUsdc.toFixed(2)} USDC).`);
        await notify.premiumPoolExitDone(pool, {
            reason: signal.reason, swappedUsdc, observedTvlUsd: tvlUsd,
        }).catch(() => {});

        return { executed: true, swappedUsdc };
    } catch (err) {
        console.error(`${LOG(pool.id)} FEHLER: ${err.message}`);
        updateRetireExecution(db, execId, { error_msg: err.message });
        await notify.premiumPoolExitError(pool, err).catch(() => {});
        throw err;
    } finally {
        releaseSlLock();
    }
}

// ─── Zyklus-Einstieg ─────────────────────────────────────────────────────────

/**
 * Einmal pro Bot-Zyklus aufzurufen. Prüft alle übernommenen Pools gegen die
 * aktuelle Lieferung und meldet / wartet / führt aus.
 *
 * Läuft bewusst über `config.pools.all`, NICHT nur über die aktiven Pools: ein
 * zurückgestufter Pool ohne offene Position ist `active:false` und käme in der
 * Aktiv-Schleife des Bots nie vorbei — gesperrt und gemeldet werden muss er trotzdem.
 *
 * Reine Datei-/DB-Lesungen, solange kein Exit fällig ist (kein RPC, kein API-Call) —
 * damit ist der Aufruf im Zyklus so billig wie die anderen Trigger-Checks.
 *
 * @returns {Promise<{notified: string[], waiting: string[], exited: string[], deferred: string[]}>}
 */
export async function processPoolRetirements(db) {
    const result = { notified: [], waiting: [], exited: [], deferred: [] };

    const { offers, meta } = loadPoolOffers();
    const pools = config.pools.all;
    const signals = detectRetirementSignals(pools, offers, meta);
    const signalById = new Map(signals.map(s => [s.poolId, s]));

    // Zurückgenommene Rückstufung: Fenster verwerfen, damit ein späteres erneutes
    // Signal wieder vollständig von vorn bestätigt werden muss.
    for (const pool of pools) {
        if (!pool.premiumOffer?.offerId || signalById.has(pool.id)) continue;
        const state = getPoolOfferState(db, pool.id);
        if (state?.retired_first_seen_at) {
            clearRetirementSighting(db, pool.id);
            console.log(`${LOG(pool.id)} Rückstufung zurückgenommen – Bestätigungsfenster verworfen`);
            await notify.premiumPoolReinstated(pool).catch(() => {});
        }
    }

    for (const signal of signals) {
        const pool = pools.find(p => p.id === signal.poolId);
        if (!pool) continue;

        // Einmal verlassen heißt endgültig verlassen — nie ein zweites Mal schließen
        // (und nie erneut melden, solange die Rückstufung bestehen bleibt).
        if (hasCompletedRetireExecution(db, pool.id)) continue;

        const state = getPoolOfferState(db, pool.id);
        const decision = resolveRetirementAction(state, signal, meta?.sequence);

        recordRetirementSighting(db, pool.id, {
            firstSeenAt: decision.firstSeenAt,
            sequence: meta?.sequence,
            notifiedAt: decision.action === 'notify' ? Date.now() : null,
        });

        if (decision.action === 'notify') {
            console.log(`${LOG(pool.id)} Rückstufung erkannt (${signal.kind}) – Meldung, Bestätigungsfenster läuft`);
            await notify.premiumPoolRetired(pool, {
                reason: signal.reason,
                kind: signal.kind,
                confirmHours: Math.round(CONFIRM_MS / 3_600_000),
            }).catch(() => {});
            result.notified.push(pool.id);
            continue;
        }

        if (decision.action === 'wait') {
            result.waiting.push(pool.id);
            continue;
        }

        try {
            const r = await executeRetirementExit(pool, db, signal);
            (r.executed ? result.exited : result.deferred).push(pool.id);
        } catch (err) {
            console.error(`${LOG(pool.id)} Exit fehlgeschlagen: ${err.message}`);
            result.deferred.push(pool.id);
        }
    }

    return result;
}

// ─── Startup: unvollständige Ausführungen fortsetzen ─────────────────────────

export async function resumePendingRetireExecutions(db) {
    const pending = getIncompleteRetireExecutions(db);
    if (!pending.length) return;

    console.log(`[pool-retirement] ${pending.length} unvollständige Ausführung(en) – setze fort…`);

    for (const exec of pending) {
        const pool = config.pools.all.find(p => p.id === exec.pool_id);
        if (!pool) {
            console.warn(`[pool-retirement] Pool ${exec.pool_id} nicht in config – übersprungen`);
            continue;
        }
        console.log(`${LOG(exec.pool_id)} Fortsetze ab Step '${exec.step}'`);
        acquireSlLock();
        try {
            let coinsA = exec.coins_a ?? 0;
            let coinsB = exec.coins_b ?? 0;
            let swappedUsdc = exec.swapped_usdc ?? 0;

            if (exec.step === 'preparing') {
                const r = await stepWithdraw(pool, db, exec.id);
                coinsA = r.coinsA;
                coinsB = r.coinsB;
            }
            if (exec.step === 'preparing' || exec.step === 'withdrawn') {
                swappedUsdc = await stepSwap(pool, db, exec.id, coinsA, coinsB);
            }

            updateRetireExecution(db, exec.id, { step: 'complete', completed_at: Date.now() });
            console.log(`${LOG(exec.pool_id)} Fortgesetzt und abgeschlossen.`);
        } catch (err) {
            console.error(`${LOG(exec.pool_id)} Fehler beim Fortsetzen: ${err.message}`);
            updateRetireExecution(db, exec.id, { error_msg: err.message });
        } finally {
            releaseSlLock();
        }
    }
}
