/**
 * FORGE Liquidity – Trailing-Stop-Schnellprüfung zwischen zwei Bot-Zyklen.
 *
 * Warum es das gibt: Der reguläre Zyklus misst alle ~5 Minuten. Fartcoin/SOL verlor am
 * 2026-08-22 zwischen 20:03:53 und 20:09:04 rund 9 % gegen SOL — Referenz, Stufe 2 und
 * Auslöseschwelle (+3,2 % über Einstieg) stimmten alle, aber der gesamte Absturz lag in
 * einem einzigen Abtastintervall. Der Stop feuerte bei der ersten Gelegenheit, 8,7 % unter
 * dem Hoch statt 0,75 %. 🔒 Eine Zusage, die feiner ist als die Abtastung, ist keine
 * Zusage (KB Core/wirkungsnachweis.md) — also muss öfter abgetastet werden.
 *
 * Was eine Runde tut (je aktivem Pool mit offener Position und aktivem Trailing Stop):
 *   1. Pool-Preis live lesen — ein einzelner Account-Read (`adapter.getPoolPrice`).
 *   2. Positionswert aus gespeicherter Liquidität + Range + diesem Preis rechnen — mit
 *      **derselben Formel wie jeder Snapshot** (`computeLpValueFromState`), kein zweites Modell.
 *   3. `evaluateTsTrigger()` — die unveränderte Auslöse-Entscheidung des Trailing Stops.
 *   4. Urteil in `ts_fast_checks` protokollieren (feine Wertreihe; Wirkungsnachweis).
 *   5. Nur bei Auslösung: **bestätigende Vollmessung** wie ein Bot-Tick (`getPositionState`
 *      → `writePositionSnapshotFromState` → `updateHwm`) und erst dann der reguläre Exit-Pfad
 *      über den Aufrufer (`onConfirmedTrigger` → `shouldTriggerTs`/`executeTs`).
 *
 * Was sie bewusst NICHT tut:
 *   - Den Höchststand aus dem Schnellwert fortschreiben. Die Schnellprüfung nutzt die
 *     Liquidität aus der DB (jeder Tick synchronisiert sie, aber zwischen Deposit und Tick
 *     kann sie abweichen); ein daraus gerechneter Wert ist ein Filter, keine Messung. Der
 *     Höchststand kommt weiter nur aus vollständigen On-Chain-Messungen — „nur gemessene
 *     Werte" (KB rm-exits-wechselwirkungen.md) gilt unverändert.
 *   - Ohne Bestätigung aussteigen. Ist die DB-Liquidität veraltet, irrt der Schnellwert in
 *     beide Richtungen: zu hoch → kein Trigger, der Tick fängt es (wie bisher); zu niedrig →
 *     Trigger, die Vollmessung korrigiert. Beide Richtungen sind sicher.
 *   - Parallel zum Zyklus laufen. Der Aufrufer ruft sie ausschließlich in der Wartephase
 *     zwischen zwei Zyklen auf — keine zweite Schreibstelle neben processPool.
 *
 * Last: je Pool ein RPC-Read pro Runde, über `rpcLimiter`. Bei 3 Positionen und 30 s Takt
 * sind das 6 Reads/Minute — gegen ~1700 Upstream-Calls/Stunde heute vernachlässigbar.
 */

import { getOpenPosition, getIncompleteTsExecutions, insertTsFastCheck } from './db.js';
import { loadTsConfig, evaluateTsTrigger, updateHwm } from './trailing-stop.js';
import { computeLpValueFromState, writePositionSnapshotFromState } from './refresh-state.js';
import { refreshReferencePrices } from './reference-prices.js';

/**
 * Eine Schnellprüfungs-Runde über alle übergebenen Pools.
 *
 * @param {Object}   db
 * @param {Array}    pools                 aktive Pools (freshPools.active)
 * @param {Object}   deps
 * @param {Function} deps.getAdapter       pool → Adapter (getPoolPrice, getPositionState)
 * @param {Function} deps.onConfirmedTrigger  async (pool) → führt den regulären Exit-Pfad aus
 *                                            (im Bot: _trailingStopCheck(pool, { source: 'fast' }))
 * @param {Function} [deps.refreshPrices]  async (db) → Quote-Preise auffrischen (Default: Pyth)
 * @param {Function} [deps.loadConfig]     poolId → Trailing-Stop-Konfiguration (Default: settings.db;
 *                                         injizierbar für den Test bin/test-fast-stop-check.js)
 * @param {Function} [deps.log]
 * @returns {Promise<{ checked: number, triggered: number, confirmed: number, errors: number }>}
 */
export async function runFastStopRound(db, pools, { getAdapter, onConfirmedTrigger, refreshPrices = refreshReferencePrices, loadConfig = loadTsConfig, log = console.log } = {}) {
    const summary = { checked: 0, triggered: 0, confirmed: 0, errors: 0 };
    if (!Array.isArray(pools) || pools.length === 0) return summary;

    // Pools, deren Exit gerade läuft oder hängt, nicht erneut anfassen.
    let busy = new Set();
    try {
        busy = new Set(getIncompleteTsExecutions(db).map(e => e.pool_id));
    } catch { /* ohne Liste lieber weiterprüfen als blind bleiben */ }

    // Referenzpreis (SOL/USD, BTC/USD) mit auffrischen. Das Modul drosselt selbst auf einen
    // echten Abruf pro Minute — nötig, seit die Quelle Jupiter ist (kein Nexus-Cache wie
    // früher bei Pyth), denn diese Runde läuft rund 1,7-mal pro Minute.
    // Ein Fehlschlag ist unkritisch: Bewertet wird über den Pool-Preis, der Referenzpreis
    // dient nur als Gegenprobe und Rückfallebene.
    try { await refreshPrices(db); } catch { /* bewusst still */ }

    for (const pool of pools) {
        try {
            if (busy.has(pool.id)) continue;
            const position = getOpenPosition(db, pool.id);
            if (!position) continue;
            if (!(Number(position.liquidity) > 0)) continue;
            if (!(position.hwm_usd > 0)) continue;            // Referenz noch nicht etabliert

            const cfg = loadConfig(pool.id);
            if (!cfg?.enabled) continue;

            const adapter = getAdapter(pool);
            const price   = await adapter.getPoolPrice(pool);
            if (!(price > 0)) continue;

            const { lpValueUsd } = computeLpValueFromState(db, pool, {
                liquidity: position.liquidity,
                tickLower: position.tick_lower,
                tickUpper: position.tick_upper,
            }, price);
            if (!(lpValueUsd > 0)) continue;

            const verdict = evaluateTsTrigger(cfg, position, lpValueUsd);
            summary.checked++;

            let confirmed = null;
            if (verdict.trigger) {
                summary.triggered++;
                log(`[fast-stop:${pool.id}] Schnellprüfung: ${lpValueUsd.toFixed(2)} USDC liegt ${verdict.drawdownPct.toFixed(2)} % unter dem Höchststand ${position.hwm_usd.toFixed(2)} (Schwelle ${verdict.thresholdPct} %, Stufe ${verdict.stage}) – bestätigende Messung`);
                confirmed = await _confirmAndExit(db, pool, position, cfg, adapter, onConfirmedTrigger, log) ? 1 : 0;
                if (confirmed) summary.confirmed++;
            }

            insertTsFastCheck(db, {
                poolId:       pool.id,
                positionId:   position.id,
                price,
                lpValueUsd,
                hwmUsd:       position.hwm_usd,
                drawdownPct:  verdict.drawdownPct,
                thresholdPct: verdict.thresholdPct,
                stage:        verdict.stage,
                triggered:    verdict.trigger ? 1 : 0,
                confirmed,
            });
        } catch (err) {
            summary.errors++;
            console.warn(`[fast-stop:${pool.id}] Schnellprüfung übersprungen: ${err.message}`);
        }
    }
    return summary;
}

/**
 * Bestätigende Vollmessung + Exit. Identisch zum Tick-Pfad: On-Chain-State lesen, als
 * Snapshot schreiben, Höchststand nachziehen, dann die reguläre Auslösung über den
 * Aufrufer (der liest den gerade geschriebenen Snapshot). Liefert true, wenn der Exit lief.
 */
async function _confirmAndExit(db, pool, position, cfg, adapter, onConfirmedTrigger, log) {
    const state = await adapter.getPositionState(pool, position.nft_mint);
    if (!state || !(Number(state.liquidity) > 0) || !(state.currentPrice > 0)) {
        log(`[fast-stop:${pool.id}] Bestätigung ohne verwertbaren On-Chain-Zustand – kein Exit, nächster Zyklus misst regulär`);
        return false;
    }
    const written = writePositionSnapshotFromState(db, pool, position, state, state.currentPrice);
    if (!written) {
        log(`[fast-stop:${pool.id}] Bestätigungs-Snapshot verworfen (Stale-Guard) – kein Exit`);
        return false;
    }
    const snap = db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).get(pool.id);
    const lpUsd = snap?.lp_value_usd ?? 0;
    if (!(lpUsd > 0)) return false;

    updateHwm(db, pool, position, lpUsd);

    const fresh   = getOpenPosition(db, pool.id);
    const verdict = evaluateTsTrigger(cfg, fresh, lpUsd);
    if (!verdict.trigger) {
        log(`[fast-stop:${pool.id}] Bestätigende Messung ${lpUsd.toFixed(2)} USDC (${verdict.drawdownPct.toFixed(2)} % unter Höchststand ${(fresh?.hwm_usd ?? 0).toFixed(2)}) liegt über der Schwelle – kein Exit`);
        return false;
    }
    log(`[fast-stop:${pool.id}] Bestätigt: ${lpUsd.toFixed(2)} USDC, ${verdict.drawdownPct.toFixed(2)} % Drawdown – Exit wird ausgeführt`);
    const ran = await onConfirmedTrigger(pool);
    return ran !== false;
}
