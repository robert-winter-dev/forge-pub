/**
 * FORGE Liquidity – Trailing Stop
 *
 * Zieht den Stop-Wert über die Pool-Lebenszeit nach (monoton steigende
 * High-Water-Mark). Fällt der aktuelle lp_value_usd unter `hwm_usd * (1 -
 * thresholdPct/100)`, wird die Position sofort geschlossen (kein Bestätigungs-
 * fenster über mehrere Snapshots — bewusst so, seit 2026-07-24) und das
 * Kapital optional in USDC getauscht. Reine Absicherung — kein Wiedereinstieg,
 * kein Cooldown.
 *
 * HWM lebt pro Position:
 *   - wird nach jedem Per-Pool-Snapshot via updateHwm() nachgezogen
 *   - wird beim Öffnen einer neuen Position implizit zurückgesetzt (positions.hwm_usd
 *     ist nach insertPosition NULL → erster Snapshot setzt sie neu)
 *
 * State-Machine (persistiert in ts_executions):
 *   preparing → withdrawn → swapped → transferred → complete
 * Jeder Schritt wird vor Ausführung in die DB geschrieben.
 * Bei Bot-Restart wird jede unvollständige Ausführung fortgesetzt
 * (resumePendingTsExecutions).
 *
 * Zwei Drawdown-Stufen (seit 2026-08-15):
 *   Stufe 1 (`thresholdPct`)  – gilt ab Eröffnung, bewusst weit: direkt nach dem Einstieg
 *                               soll normale Schwankung nicht sofort zum Exit führen.
 *   Stufe 2 (`thresholdPct2`) – optional, enger. Schaltet scharf, sobald die HWM die
 *                               Einstiegsreferenz um Stufe 1 übertroffen hat, und sichert
 *                               ab da den erreichten Gewinn deutlich enger ab.
 * Beide messen denselben Abstand zur HWM, nur mit unterschiedlicher Weite. Beispiel
 * (Stufe 1 = 2 %, Stufe 2 = 1 %): Ein Anstieg auf +3 % schaltet Stufe 2 scharf (die +2 %
 * wurden überschritten); der Exit liegt danach bei HWM − 1 %, also bei +2 % Gewinn.
 *
 * Die Scharfschaltung ist ein Ratchet — `positions.d2_armed_at` bleibt für die Lebensdauer
 * der Position stehen. Ein Zurückfallen auf Stufe 1 würde bei Werten, die um die Schwelle
 * pendeln, zu Flapping führen. Rebalancing trägt den Zustand auf die neue Position weiter
 * (bot.js → carryEntryToRebalancedPosition).
 *
 * Settings: pool.settings.trailingStop = { enabled, thresholdPct, thresholdPct2,
 *           autoSwapToUSDC, sendTo }
 *           (settings.db → pool_settings, geliefert vom ForgeSettings-„Risk-Management"-
 *           Modal Tab Trailing Stop).
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';

import { setPoolActive, config } from './config.js';
import { acquireSlLock, releaseSlLock, waitForCleanupToFinish } from './cleanup-lock.js';
import { getAdapter } from './pool-adapter/index.js';
import {
    insertCapitalFlow, getOpenPosition, closePosition as markPositionClosedInDb,
    updatePositionHwm,
    createTsExecution, updateTsExecution, getIncompleteTsExecutions,
} from './db.js';
import * as notify from './notify.js';
import { executeSwapStep, executeTransferStep, prepareExitAndClaimFees, finalizeClosePosition } from './exit-finalizer.js';
import { PATHS } from '../../../config/paths.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB = PATHS.settingsDb;

const DEFAULT_THRESHOLD_PCT = 10;
// 0,5 % ist die untere Grenze, nicht 1 %: bei schwach volatilen Paaren (besonders am
// Wochenende) ist ein enger zweiter Drawdown sinnvoll. Tiefer geht bewusst nicht — die
// Messgrößen selbst schwanken um rund einen Prozentpunkt (Orca-Quote vs. gemessener
// Positionswert, siehe rebaseHwmForCapitalFlow), darunter würde Rauschen den Exit auslösen
// statt der Markt.
const MIN_THRESHOLD_PCT     = 0.5;
const MAX_THRESHOLD_PCT     = 90;

/**
 * Fallback wenn in settings.db keine `trailingStop`-Sektion für den Pool liegt.
 * Muss mit DEFAULT_SETTINGS.trailingStop in bots/settings/routes/pools.js
 * übereinstimmen: ForgeSettings zeigt bei fehlender Sektion genau diese Werte an,
 * also muss der Bot auch danach handeln.
 *
 * Vorher lieferte loadTsConfig() hier `null` → der Trailing Stop war für den Pool
 * still komplett aus, während das UI „aktiv, 10 %" anzeigte. Live beobachtet
 * 2026-08-01 bei PUMP/SOL (forge-pub1): Pool lief nach Reaktivierung ohne Stop.
 * Ein fehlender Eintrag darf nie „keine Absicherung" bedeuten.
 */
const DEFAULT_COOLDOWN_HOURS = 1;

const FALLBACK_TS_CONFIG = {
    enabled:         true,
    thresholdPct:    DEFAULT_THRESHOLD_PCT,
    // Zweite Stufe im Fallback bewusst aus: Ohne ausdrückliche Konfiguration darf der
    // Schutz nicht enger sein, als der Nutzer erwartet.
    thresholdPct2:   null,
    minimumValueUsd: null,
    autoSwapToUSDC:  true,
    sendTo:          '',
    cooldownHours:   DEFAULT_COOLDOWN_HOURS,
};

// Nur einmal pro Pool und Prozesslaufzeit loggen – der Check läuft in jedem Zyklus.
const _fallbackLogged = new Set();

// ─── Settings-DB lesen ────────────────────────────────────────────────────────

export function loadTsConfig(poolId) {
    try {
        const sdb = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        sdb.close();

        const ts = row ? (JSON.parse(row.settings)?.trailingStop ?? null) : null;
        // cooldownHours kam erst nachträglich dazu (2026-08-08) – Alt-Einträge ohne
        // dieses Feld sollen trotzdem den Default-Cooldown bekommen, nicht 0/ungeschützt.
        if (ts) return { ...ts, cooldownHours: Number.isFinite(Number(ts.cooldownHours)) ? Number(ts.cooldownHours) : DEFAULT_COOLDOWN_HOURS };

        if (!_fallbackLogged.has(poolId)) {
            _fallbackLogged.add(poolId);
            console.warn(`[trailing-stop:${poolId}] Keine trailingStop-Konfiguration in settings.db – Fallback auf Default (aktiv, ${DEFAULT_THRESHOLD_PCT}% Drawdown). In ForgeSettings prüfen und pool-spezifisch setzen.`);
        }
        return { ...FALLBACK_TS_CONFIG };
    } catch (err) {
        // settings.db nicht lesbar → keine Konfiguration ableitbar. Hier bewusst
        // KEIN Fallback: ein DB-Fehler darf keinen Exit auf Basis geratener
        // Schwellen auslösen.
        console.warn(`[trailing-stop:${poolId}] settings.db nicht lesbar (${err.message}) – Trailing-Stop-Check übersprungen.`);
        return null;
    }
}

function normalizeThreshold(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_THRESHOLD_PCT;
    return Math.min(MAX_THRESHOLD_PCT, Math.max(MIN_THRESHOLD_PCT, n));
}

/**
 * Stufe 2, sofern sie gültig konfiguriert ist — sonst null.
 *
 * Die Bedingung „enger als Stufe 1" wird hier erneut geprüft, obwohl das Settings-UI und
 * die API sie bereits erzwingen: Eine Stufe 2, die weiter wäre als Stufe 1, würde den
 * Schutz nach dem Scharfschalten *lockern* statt ihn zu verschärfen — also genau das
 * Gegenteil der Absicht. Ein Altbestand oder ein von Hand editierter Settings-Eintrag darf
 * das nicht auslösen können.
 */
function resolveSecondThreshold(cfg, firstPct) {
    const raw = cfg?.thresholdPct2;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;

    const pct = Math.min(MAX_THRESHOLD_PCT, Math.max(MIN_THRESHOLD_PCT, n));
    return pct < firstPct ? pct : null;
}

/**
 * Ermittelt die aktuell geltende Drawdown-Schwelle für eine Position.
 * @returns {{ pct: number, stage: 1|2, firstPct: number, secondPct: number|null }}
 */
function resolveActiveThreshold(cfg, position) {
    const firstPct  = normalizeThreshold(cfg.thresholdPct);
    const secondPct = resolveSecondThreshold(cfg, firstPct);

    if (secondPct != null && position?.d2_armed_at) {
        return { pct: secondPct, stage: 2, firstPct, secondPct };
    }
    return { pct: firstPct, stage: 1, firstPct, secondPct };
}

/**
 * Schaltet Stufe 2 scharf, sobald die HWM die Einstiegsreferenz um Stufe 1 übertroffen hat.
 *
 * Läuft im Snapshot-Pfad direkt nach dem HWM-Update und liest die Position bewusst frisch —
 * das übergebene Objekt stammt vom Zyklusbeginn und kennt die gerade geschriebene HWM nicht.
 *
 * Einmal gesetzt, bleibt `d2_armed_at` stehen (Ratchet, siehe Modulkopf).
 */
function armSecondStageIfReached(db, poolId, positionId, cfg) {
    const firstPct  = normalizeThreshold(cfg.thresholdPct);
    const secondPct = resolveSecondThreshold(cfg, firstPct);
    if (secondPct == null) return;   // keine zweite Stufe konfiguriert

    const row = db.prepare(
        `SELECT hwm_usd, entry_usd, d2_armed_at FROM positions WHERE id = ?`
    ).get(positionId);
    if (!row || row.d2_armed_at) return;                       // schon scharf
    if (!(row.hwm_usd > 0) || !(row.entry_usd > 0)) return;     // Referenzen noch nicht etabliert

    const armAt = row.entry_usd * (1 + firstPct / 100);
    if (row.hwm_usd < armAt) return;

    const now = Date.now();
    db.prepare(`UPDATE positions SET d2_armed_at = ? WHERE id = ?`).run(now, positionId);

    const gainPct = ((row.hwm_usd - row.entry_usd) / row.entry_usd) * 100;
    console.log(`[trailing-stop:${poolId}] Stufe 2 scharf: Höchststand ${row.hwm_usd.toFixed(2)} USDC liegt ${gainPct.toFixed(2)}% über dem Einstieg (${row.entry_usd.toFixed(2)} USDC, Schwelle ${firstPct}%). Drawdown-Schwelle ab jetzt ${secondPct}% statt ${firstPct}%.`);
}

// ─── HWM-Update (wird nach jedem Per-Pool-Snapshot aufgerufen) ────────────────

/**
 * Zieht die High-Water-Mark der offenen Position nach.
 * Wird vom Bot-Loop direkt nach writePositionSnapshotFromState gerufen.
 */
export function updateHwm(db, pool, position, lpValueUsd) {
    if (!position || !(lpValueUsd > 0)) return;
    updatePositionHwm(db, position.id, lpValueUsd);

    // Direkt danach prüfen, ob die zweite Stufe scharf wird. Reine DB-Arbeit, kein API-Call.
    // Ein Settings-Fehler darf den Snapshot-Pfad nicht abbrechen — im Zweifel bleibt Stufe 1
    // aktiv, das ist die sichere Richtung.
    try {
        const cfg = loadTsConfig(pool.id);
        if (cfg?.enabled) armSecondStageIfReached(db, pool.id, position.id, cfg);
    } catch (err) {
        console.warn(`[trailing-stop:${pool.id}] Stufe-2-Prüfung übersprungen: ${err.message}`);
    }
}

// ─── HWM-Reset auf manuelle Anforderung aus ForgeSettings ─────────────────────

/**
 * Verarbeitet einen manuellen Reset-Request aus dem Risk-Management-UI.
 * Der UI-Endpoint POST /api/pools/liquidity/:poolId/trailing-stop/reset setzt
 * `trailingStop.resetRequestedAt = <ms>` in settings.db. Wir lesen das Flag,
 * setzen positions.hwm_usd hart auf den aktuellen lp_value_usd und löschen das
 * Flag wieder. Aufruf parallel zu updateHwm im Snapshot-Pfad.
 *
 * Keine Aktion wenn:
 *   - kein Flag gesetzt
 *   - keine offene Position
 *   - kein gültiger lp_value_usd verfügbar
 *   - Flag älter als hwm_at (Reset bereits berücksichtigt)
 */
export function processHwmResetIfRequested(db, pool, position, lpValueUsd) {
    if (!position) return false;

    let cfg;
    try {
        const sdb = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, pool.id);
        sdb.close();
        if (!row) return false;
        cfg = JSON.parse(row.settings)?.trailingStop;
    } catch {
        return false;
    }

    const requestedAt = Number(cfg?.resetRequestedAt) || 0;
    if (!requestedAt) return false;

    // Bereits konsumiert? hwm_at >= requestedAt → Flag entfernen und Schluss.
    const hwmAt = position.hwm_at ?? 0;
    if (hwmAt >= requestedAt) {
        clearResetFlag(pool.id);
        return false;
    }

    if (!(lpValueUsd > 0)) return false;

    // targetUsd: vom UI mitgeschickter Zielwert (Wert zum Klick-Zeitpunkt).
    // Fallback auf lpValueUsd wenn kein Zielwert gespeichert (ältere Requests).
    // Wir nehmen den kleineren der beiden, damit ein Preisanstieg zwischen Klick
    // und Verarbeitung den Reset nicht wirkungslos macht.
    const targetUsd = (cfg.resetTargetUsd > 0) ? Math.min(cfg.resetTargetUsd, lpValueUsd) : lpValueUsd;

    // Hard-Reset: hwm_usd auf Zielwert setzen.
    //
    // Einstiegsreferenz und Stufe-2-Scharfschaltung werden mit zurückgesetzt. Der Reset
    // bedeutet ausdrücklich „Referenz neu ansetzen"; bliebe eine scharfe Stufe 2 stehen,
    // liefe der Pool danach mit dem engen Drawdown weiter, gemessen an einem gerade erst
    // gesenkten Höchststand — also mit einem viel schärferen Stop, als der Nutzer beim
    // Klick auf „Höchststand zurücksetzen" erwartet. Nach dem Reset muss Stufe 2 erneut
    // verdient werden. Das ist die sichere Richtung: zu weit schadet weniger als zu eng.
    db.prepare(
        `UPDATE positions SET hwm_usd = ?, hwm_at = ?, entry_usd = ?, entry_flow_ratio = NULL, d2_armed_at = NULL WHERE id = ?`
    ).run(targetUsd, Date.now(), targetUsd, position.id);
    console.log(`[trailing-stop:${pool.id}] Referenzwert manuell auf ${targetUsd.toFixed(2)} USDC zurückgesetzt (Request ${new Date(requestedAt).toISOString()}, target=${cfg.resetTargetUsd?.toFixed(2) ?? 'n/a'}, lp=${lpValueUsd.toFixed(2)}); Einstiegsreferenz mit zurückgesetzt, Stufe 2 wieder entschärft.`);

    clearResetFlag(pool.id);
    return true;
}

// Liest minimumValueUsd ohne es zu löschen (null wenn nicht gesetzt oder 0).
export function readMinimumValue(poolId) {
    try {
        const sdb = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        sdb.close();
        if (!row) return null;
        const val = JSON.parse(row.settings)?.trailingStop?.minimumValueUsd;
        return (val != null && Number(val) > 0) ? Number(val) : null;
    } catch {
        return null;
    }
}

// Gibt den alten minimumValueUsd zurück (oder null wenn nicht gesetzt).
export function clearMinimumValue(poolId) {
    try {
        const sdb = new Database(SETTINGS_DB);
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        let oldValue = null;
        if (row) {
            const s = JSON.parse(row.settings);
            if (s?.trailingStop && s.trailingStop.minimumValueUsd != null) {
                oldValue = s.trailingStop.minimumValueUsd;
                s.trailingStop.minimumValueUsd = null;
                sdb.prepare(
                    `UPDATE pool_settings SET settings = ? WHERE bot_id = ? AND pool_id = ?`
                ).run(JSON.stringify(s), config.botId, poolId);
                console.log(`[trailing-stop:${poolId}] minimumValueUsd nach Mindestwert-Exit auf null zurückgesetzt`);
            }
        }
        sdb.close();
        return oldValue;
    } catch (err) {
        console.warn(`[trailing-stop:${poolId}] minimumValueUsd clearen fehlgeschlagen: ${err.message}`);
        return null;
    }
}

function clearResetFlag(poolId) {
    try {
        const sdb = new Database(SETTINGS_DB);
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        if (row) {
            const s = JSON.parse(row.settings);
            if (s?.trailingStop?.resetRequestedAt !== undefined) {
                delete s.trailingStop.resetRequestedAt;
                sdb.prepare(
                    `UPDATE pool_settings SET settings = ? WHERE bot_id = ? AND pool_id = ?`
                ).run(JSON.stringify(s), config.botId, poolId);
            }
        }
        sdb.close();
    } catch (err) {
        console.warn(`[trailing-stop:${poolId}] Reset-Flag clearen fehlgeschlagen: ${err.message}`);
    }
}

// ─── Trigger-Check ────────────────────────────────────────────────────────────

/**
 * Gibt true zurück wenn der Trailing Stop für diesen Pool feuern soll.
 * Kein API-Call – nur DB-Lookups.
 */
export function shouldTriggerTs(pool, db) {
    const cfg = loadTsConfig(pool.id);
    if (!cfg?.enabled) return false;

    const position = getOpenPosition(db, pool.id);
    if (!position) return false;

    const { pct: thresholdPct } = resolveActiveThreshold(cfg, position);

    const hwmUsd = position.hwm_usd ?? 0;
    if (!(hwmUsd > 0)) return false; // HWM noch nicht etabliert

    // Sofort-Trigger: keine Mehrfach-Bestätigung mehr — der neueste Snapshot
    // entscheidet direkt. Bewusst so gewünscht (kein verzögerter Stop-Loss).
    const row = db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ?
         ORDER BY recorded_at DESC LIMIT 1`
    ).get(pool.id);
    if (!row || !((row.lp_value_usd ?? 0) > 0)) return false;

    const triggerAt = hwmUsd * (1 - thresholdPct / 100);
    if (row.lp_value_usd < triggerAt) return true;

    // Pool-Mindestwert: absoluter USDC-Boden, unabhängig vom Drawdown.
    // Guard: nur prüfen wenn der HWM jemals >= Minimum war — verhindert sofortigen
    // Exit bei Positionen, die von Anfang an unter dem Mindestwert eröffnet wurden.
    const minValueUsd = Number(cfg.minimumValueUsd) || 0;
    if (minValueUsd > 0 && hwmUsd >= minValueUsd && row.lp_value_usd < minValueUsd) return true;

    return false;
}

// ─── State-Machine: Withdraw-Step ────────────────────────────────────────────

async function stepWithdraw(pool, db, execId) {
    const adapter  = getAdapter(pool);
    const position = getOpenPosition(db, pool.id);

    let feesA = 0, feesB = 0;

    if (position) {
        // SOL-Vorsicherung + Fee-Claim (letzterer entfällt bei knappem SOL).
        // Blockiert den Ausstieg nie — siehe prepareExitAndClaimFees().
        const fees = await prepareExitAndClaimFees(adapter, pool, position, db, {
            logPrefix: `[trailing-stop:${pool.id}]`,
        });
        feesA = fees.amountA;
        feesB = fees.amountB;
        if (!fees.skipped) {
            console.log(`[trailing-stop:${pool.id}] Fees geclaimed: ${feesA.toFixed(6)} A + ${feesB.toFixed(6)} B`);
        }

        const { closed, coinsA: tsCoinsA, coinsB: tsCoinsB } = await finalizeClosePosition(adapter, pool, position, db, {
            feesA, feesB,
            note:      'trailing-stop',
            logPrefix: `[trailing-stop:${pool.id}]`,
        });

        markPositionClosedInDb(db, position.id, closed.txHash);

        updateTsExecution(db, execId, {
            step:       'withdrawn',
            ts_coins_a: tsCoinsA,
            ts_coins_b: tsCoinsB,
        });
        return { tsCoinsA, tsCoinsB };
    } else {
        console.log(`[trailing-stop:${pool.id}] Keine offene Position mehr – überspringe Withdraw`);
        updateTsExecution(db, execId, { step: 'withdrawn', ts_coins_a: 0, ts_coins_b: 0 });
        return { tsCoinsA: 0, tsCoinsB: 0 };
    }
}

async function stepSwap(pool, db, execId, cfg, tsCoinsA, tsCoinsB) {
    return executeSwapStep(pool, {
        coinsA:      tsCoinsA,
        coinsB:      tsCoinsB,
        sendTo:      cfg.sendTo,
        logPrefix:   `[trailing-stop:${pool.id}]`,
        slippageBps: config.rm.swapSlippageBps,
        onSwapped:   (swappedUsdc) => {
            updateTsExecution(db, execId, { step: 'swapped', swapped_usdc: swappedUsdc });
            insertCapitalFlow(db, { poolId: pool.id, usdcAmount: -swappedUsdc, note: 'trailing-stop-exit', isExternal: 1 });
            console.log(`[trailing-stop:${pool.id}] Kapitalabfluss erfasst: -${swappedUsdc.toFixed(2)} USDC`);
        },
    });
}

async function stepTransfer(pool, db, execId, cfg, tsCoinsA, tsCoinsB, swappedUsdc) {
    return executeTransferStep(pool, {
        coinsA:        tsCoinsA,
        coinsB:        tsCoinsB,
        swappedUsdc,
        sendTo:        cfg.sendTo,
        swapToUsdc:    cfg.autoSwapToUSDC,
        logPrefix:     `[trailing-stop:${pool.id}]`,
        onTransferred: () => updateTsExecution(db, execId, { step: 'transferred' }),
    });
}

// ─── Haupt-Ausführung ────────────────────────────────────────────────────────

export async function executeTs(pool, db) {
    const cfg = loadTsConfig(pool.id);
    if (!cfg?.enabled) return;

    const position     = getOpenPosition(db, pool.id);
    const hwmUsd       = position?.hwm_usd ?? 0;

    const { pct: thresholdPct, stage } = resolveActiveThreshold(cfg, position);

    const row = db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ?
         ORDER BY recorded_at DESC LIMIT 1`
    ).get(pool.id);
    const currentUsd = row?.lp_value_usd ?? 0;
    const drawdownPct = hwmUsd > 0 ? ((hwmUsd - currentUsd) / hwmUsd) * 100 : 0;

    const minValueUsd      = Number(cfg.minimumValueUsd) || 0;
    const triggeredByMin   = minValueUsd > 0 && currentUsd < minValueUsd;
    const stageLabel       = stage === 2 ? 'Stufe 2, Gewinnsicherung' : 'Stufe 1';
    const triggerReason    = triggeredByMin
        ? `Mindestwert-Unterschreitung (${currentUsd.toFixed(2)} < ${minValueUsd.toFixed(2)} USDC)`
        : `Drawdown ${drawdownPct.toFixed(1)}% (Schwelle ${thresholdPct}% — ${stageLabel})`;
    console.log(`[trailing-stop:${pool.id}] Trailing Stop ausgelöst: HWM ${hwmUsd.toFixed(2)} → ${currentUsd.toFixed(2)} USDC, Grund: ${triggerReason}`);

    await waitForCleanupToFinish();
    acquireSlLock();

    const execId = createTsExecution(db, {
        poolId:         pool.id,
        hwmUsd,
        currentUsd,
        drawdownPct,
        configSnapshot: cfg,
    });

    try {
        // Pool sofort inaktiv → verhindert Re-Open im nächsten Tick (Idempotenz)
        try {
            setPoolActive(pool.id, false);
            console.log(`[trailing-stop:${pool.id}] Pool auf active=false gesetzt`);
        } catch (err) {
            console.error(`[trailing-stop:${pool.id}] setPoolActive fehlgeschlagen: ${err.message}`);
        }

        // Phase 2: Withdraw
        const { tsCoinsA, tsCoinsB } = await stepWithdraw(pool, db, execId);

        // Phase 3: Swap (optional)
        let swappedUsdc = null;
        if (cfg.autoSwapToUSDC) {
            swappedUsdc = await stepSwap(pool, db, execId, cfg, tsCoinsA, tsCoinsB);
        }

        // Phase 4: Transfer (optional)
        if (cfg.sendTo) {
            await stepTransfer(pool, db, execId, cfg, tsCoinsA, tsCoinsB, swappedUsdc);
        }

        // Phase 5: Abschluss
        updateTsExecution(db, execId, { step: 'complete', completed_at: Date.now() });
        const execLabel = triggeredByMin
            ? { k: 'notify.liq.rm_label_min_value', p: { usdc: minValueUsd.toFixed(0) } }
            // Bei zweistufiger Konfiguration die Stufe mitschicken: sonst steht in der
            // Meldung ein Prozentwert, den der Nutzer im Modal so nicht wiederfindet.
            : (stage === 2
                ? { k: 'notify.liq.rm_label_trailing_s2', p: { pct: thresholdPct } }
                : { k: 'notify.liq.rm_label_trailing',    p: { pct: thresholdPct } });
        await notify.rmExecuted(pool, execLabel, {
            lpValueUsd: currentUsd, coinsA: tsCoinsA, coinsB: tsCoinsB, swappedUsdc,
        }).catch(() => {});

        // Mindestwert nach Mindestwert-Exit nullen, damit eine Wiedereröffnung nicht
        // sofort wieder triggert (neues Kapital liegt i.d.R. unterhalb des alten Grenzwerts).
        if (triggeredByMin) clearMinimumValue(pool.id);

        console.log(`[trailing-stop:${pool.id}] Trailing Stop vollständig abgeschlossen.`);

    } catch (err) {
        console.error(`[trailing-stop:${pool.id}] FEHLER: ${err.message}`);
        updateTsExecution(db, execId, { error_msg: err.message });
        await notify.trailingStopError(pool, 'execution', err).catch(() => {});
        throw err;
    } finally {
        releaseSlLock();
    }
}

// ─── Startup: unvollständige Ausführungen fortsetzen ─────────────────────────

export async function resumePendingTsExecutions(db) {
    const pending = getIncompleteTsExecutions(db);
    if (!pending.length) return;

    console.log(`[trailing-stop] ${pending.length} unvollständige Trailing-Stop-Ausführung(en) gefunden – setze fort…`);

    for (const exec of pending) {
        const pool = config.pools.all.find(p => p.id === exec.pool_id);
        if (!pool) {
            console.warn(`[trailing-stop] Pool ${exec.pool_id} nicht in config – Ausführung übersprungen`);
            continue;
        }

        const cfg = exec.config_snapshot ? JSON.parse(exec.config_snapshot) : loadTsConfig(exec.pool_id);
        if (!cfg) {
            console.warn(`[trailing-stop] Keine TS-Config für ${exec.pool_id} – Ausführung übersprungen`);
            continue;
        }

        console.log(`[trailing-stop:${exec.pool_id}] Fortsetze ab Step '${exec.step}'`);
        acquireSlLock();

        try {
            let tsCoinsA    = exec.ts_coins_a ?? 0;
            let tsCoinsB    = exec.ts_coins_b ?? 0;
            let swappedUsdc = exec.swapped_usdc ?? null;

            if (exec.step === 'preparing') {
                const result = await stepWithdraw(pool, db, exec.id);
                tsCoinsA = result.tsCoinsA;
                tsCoinsB = result.tsCoinsB;
            }

            if ((exec.step === 'preparing' || exec.step === 'withdrawn') && cfg.autoSwapToUSDC) {
                swappedUsdc = await stepSwap(pool, db, exec.id, cfg, tsCoinsA, tsCoinsB);
            }

            if (['preparing', 'withdrawn', 'swapped'].includes(exec.step) && cfg.sendTo) {
                await stepTransfer(pool, db, exec.id, cfg, tsCoinsA, tsCoinsB, swappedUsdc);
            }

            updateTsExecution(db, exec.id, { step: 'complete', completed_at: Date.now() });
            console.log(`[trailing-stop:${exec.pool_id}] Fortgesetzt und abgeschlossen.`);

        } catch (err) {
            console.error(`[trailing-stop:${exec.pool_id}] Fehler beim Fortsetzen: ${err.message}`);
            updateTsExecution(db, exec.id, { error_msg: err.message });
        } finally {
            releaseSlLock();
        }
    }
}
