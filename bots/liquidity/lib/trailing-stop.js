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
 *   preparing → [drained] → withdrawn → swapped → transferred → complete
 * `drained` ist ein Teilfehlschlag-Zustand (LIQ#0312): die Liquidität ist entnommen und
 * liegt im Wallet, der Position-Close ist aber gescheitert. Er hält die tatsächlich
 * entnommenen Mengen fest, damit der Wiederanlauf sie nicht aus der dann leeren Position
 * neu schätzt (und den Erlös als ~0 verbucht).
 *
 * 🔒 Ein gescheiterter Position-Close hält den Exit NICHT auf (seit 23.08.2026): Nur die
 * Entnahme bewegt Geld, der NFT-Burn holt ~0,002 SOL Rent zurück. Der Verkauf läuft
 * deshalb sofort weiter, die Position wird in der DB geschlossen und das leere NFT dem
 * täglichen Zombie-Cron überlassen. Vorher hing der schützende Verkauf am Burn und das
 * Kapital lag bis zu 15 Minuten (`RESUME_RETRY_INTERVAL_MS`) mit vollem Kursrisiko im
 * Wallet — genau das, was der Trailing Stop verhindern soll.
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
    getOpenPosition, closePosition as markPositionClosedInDb,
    updatePositionHwm,
    createTsExecution, updateTsExecution, getIncompleteTsExecutions,
} from './db.js';
import * as notify from './notify.js';
import { executeSwapStep, executeTransferStep, prepareExitAndClaimFees, closePositionOrRescue, computeExitPnl, recordExitProceeds } from './exit-finalizer.js';
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
export function armSecondStageIfReached(db, poolId, positionId, cfg) {
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
    // pnl_anchor_reset_at mit auf denselben Zeitpunkt setzen: Der Klick sagt "miss ab hier
    // neu" — dieselbe Aussage muss für "Anteil"/PnL-seit-Einstieg gelten, sonst zeigt das
    // Dashboard nach einem Reset weiterhin den Verlust seit dem echten Einstieg, während
    // der Trailing Stop schon wieder bei 0 % steht (siehe resolvePnlAnchorMs()).
    const resetAt = Date.now();
    db.prepare(
        `UPDATE positions SET hwm_usd = ?, hwm_at = ?, entry_usd = ?, entry_flow_ratio = NULL, d2_armed_at = NULL, pnl_anchor_reset_at = ? WHERE id = ?`
    ).run(targetUsd, resetAt, targetUsd, resetAt, position.id);
    console.log(`[trailing-stop:${pool.id}] Referenzwert manuell auf ${targetUsd.toFixed(2)} USDC zurückgesetzt (Request ${new Date(requestedAt).toISOString()}, target=${cfg.resetTargetUsd?.toFixed(2) ?? 'n/a'}, lp=${lpValueUsd.toFixed(2)}); Einstiegsreferenz mit zurückgesetzt, Stufe 2 wieder entschärft, PnL-Anker auf jetzt gesetzt.`);

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
 * Die eigentliche Auslöse-Entscheidung — bewusst **frei von DB und Settings-Zugriff**,
 * damit sie ohne Bot-Umgebung durchgespielt werden kann.
 *
 * `bin/test-trailing-stop-sim.js` fährt genau diese Funktion gegen ganze Kursverläufe
 * (Kapitalflüsse, Rebalancings, Exit + Wiedereinstieg, Kurslücken zwischen Snapshots).
 * Bliebe die Logik in `shouldTriggerTs()` eingebettet, prüfte der Simulator eine
 * Nachbildung statt des Originals — genau die Art Test, die einen Fehler nicht findet.
 *
 * @param {Object} cfg          Trailing-Stop-Konfiguration des Pools
 * @param {Object} position     offene Position (braucht `hwm_usd`, `d2_armed_at`)
 * @param {number} lpValueUsd   aktueller (gemessener) Positionswert
 * @returns {{ trigger: boolean, reason: 'drawdown'|'minimum'|null, drawdownPct: number,
 *             thresholdPct: number, stage: 1|2, triggerAt: number }}
 */
export function evaluateTsTrigger(cfg, position, lpValueUsd) {
    const none = { trigger: false, reason: null, drawdownPct: 0, thresholdPct: 0, stage: 1, triggerAt: 0 };
    if (!cfg?.enabled || !position) return none;

    const { pct: thresholdPct, stage } = resolveActiveThreshold(cfg, position);

    const hwmUsd = position.hwm_usd ?? 0;
    if (!(hwmUsd > 0)) return none;          // HWM noch nicht etabliert
    if (!(lpValueUsd > 0)) return none;      // kein verwertbarer Messwert

    const triggerAt   = hwmUsd * (1 - thresholdPct / 100);
    const drawdownPct = ((hwmUsd - lpValueUsd) / hwmUsd) * 100;
    const base        = { drawdownPct, thresholdPct, stage, triggerAt };

    if (lpValueUsd < triggerAt) return { ...base, trigger: true, reason: 'drawdown' };

    // Pool-Mindestwert: absoluter USDC-Boden, unabhängig vom Drawdown.
    // Guard: nur prüfen wenn der HWM jemals >= Minimum war — verhindert sofortigen
    // Exit bei Positionen, die von Anfang an unter dem Mindestwert eröffnet wurden.
    const minValueUsd = Number(cfg.minimumValueUsd) || 0;
    if (minValueUsd > 0 && hwmUsd >= minValueUsd && lpValueUsd < minValueUsd) {
        return { ...base, trigger: true, reason: 'minimum' };
    }

    return { ...base, trigger: false, reason: null };
}

/**
 * Gibt true zurück wenn der Trailing Stop für diesen Pool feuern soll.
 * Kein API-Call – nur DB-Lookups; die Entscheidung selbst trifft evaluateTsTrigger().
 */
export function shouldTriggerTs(pool, db) {
    const cfg = loadTsConfig(pool.id);
    if (!cfg?.enabled) return false;

    const position = getOpenPosition(db, pool.id);
    if (!position) return false;

    // Sofort-Trigger: keine Mehrfach-Bestätigung mehr — der neueste Snapshot
    // entscheidet direkt. Bewusst so gewünscht (kein verzögerter Stop-Loss).
    const row = db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ?
         ORDER BY recorded_at DESC LIMIT 1`
    ).get(pool.id);

    return evaluateTsTrigger(cfg, position, row?.lp_value_usd ?? 0).trigger;
}

// ─── State-Machine: Withdraw-Step ────────────────────────────────────────────

/**
 * Holt das Kapital aus der Position und gibt die entnommenen Mengen zurück.
 *
 * 🔒 Ein Teilfehlschlag bricht den Exit NICHT mehr ab (Entkopplung 23.08.2026).
 * Der Ausstieg besteht aus zwei on-chain-Legs: `decreaseLiquidity` holt das Kapital
 * heraus, `closePositionIx` verbrennt danach das leere NFT. Nur das erste bewegt Geld —
 * das zweite holt ~0,002 SOL Rent zurück. Bis 23.08. hing der schützende Verkauf am
 * Gelingen des zweiten: scheiterte der Burn, brach der ganze Exit ab und das Kapital lag
 * bis zum nächsten Wiederanlauf (bis zu 15 Min, `RESUME_RETRY_INTERVAL_MS`) ungetauscht
 * im Wallet — mit vollem Kursrisiko, obwohl der Trailing Stop genau das verhindern soll.
 *
 * Jetzt gilt: Kapital zuerst. Ist die Entnahme gelandet, wird der Exit fortgesetzt, die
 * Position in der DB geschlossen und das leere NFT dem täglichen Zombie-Cron überlassen
 * (`bin/run-zombie-check.sh`). Der Fehlschlag bleibt in `close_error` protokolliert.
 *
 * @param {Object|null} exec  Die ts_executions-Zeile, wenn dieser Aufruf eine ANGEFANGENE
 *        Ausführung fortsetzt. Steht sie auf 'drained', ist die Liquidität bereits
 *        entnommen; dann werden Fee-Claim und Entnahme übersprungen und die Mengen
 *        stammen aus der DB statt aus einer Quote auf die leere Position.
 * @returns {Promise<{tsCoinsA: number, tsCoinsB: number, closePending: Object|null}>}
 *        `closePending` beschreibt ein liegengebliebenes NFT (sonst null).
 */
async function stepWithdraw(pool, db, execId, exec = null) {
    const position = getOpenPosition(db, pool.id);
    const logPfx   = `[trailing-stop:${pool.id}]`;

    const drained = exec?.step === 'drained';
    const knownA  = drained ? (exec.ts_coins_a ?? 0) : 0;
    const knownB  = drained ? (exec.ts_coins_b ?? 0) : 0;

    if (drained) {
        // Fortsetzung: die Entnahme ist gelandet, ein zweiter Burn-Versuch würde den
        // Verkauf nur erneut aufhalten. Die close_position-Zeile steht bereits aus dem
        // ersten Lauf — hier NICHT noch einmal buchen (sonst doppelter Anker).
        console.log(
            `${logPfx} Fortsetzung aus 'drained' (Entnahme-TX ${exec.decrease_tx_hash}): `
            + `${knownA.toFixed(6)} A + ${knownB.toFixed(6)} B liegen im Wallet – `
            + `überspringe Fee-Claim, Entnahme und Burn.`
        );
        if (position) markPositionClosedInDb(db, position.id, exec.decrease_tx_hash ?? null);
        updateTsExecution(db, execId, { step: 'withdrawn' });
        return { tsCoinsA: knownA, tsCoinsB: knownB, closePending: null };
    }

    if (!position) {
        console.log(`${logPfx} Keine offene Position mehr – überspringe Withdraw`);
        updateTsExecution(db, execId, { step: 'withdrawn', ts_coins_a: 0, ts_coins_b: 0 });
        return { tsCoinsA: 0, tsCoinsB: 0, closePending: null };
    }

    // SOL-Vorsicherung + Fee-Claim (letzterer entfällt bei knappem SOL).
    // Blockiert den Ausstieg nie — siehe prepareExitAndClaimFees().
    const adapter = getAdapter(pool);
    const fees    = await prepareExitAndClaimFees(adapter, pool, position, db, { logPrefix: logPfx });
    const feesA = fees.amountA;
    const feesB = fees.amountB;
    if (!fees.skipped) {
        console.log(`${logPfx} Fees geclaimed: ${feesA.toFixed(6)} A + ${feesB.toFixed(6)} B`);
    }

    // Wirft nur, wenn die Entnahme NICHT stattgefunden hat — dann steht das Kapital
    // unverändert in der Position und der nächste Lauf versucht es erneut.
    const { coinsA, coinsB, closeTxHash, closePending } = await closePositionOrRescue(
        adapter, pool, position, db, { feesA, feesB, note: 'trailing-stop', logPrefix: logPfx },
    );

    if (closePending) {
        // Zwischenstand festhalten, BEVOR die Position geschlossen wird: stirbt der Prozess
        // dazwischen, weiß der Wiederanlauf sonst nichts von den entnommenen Mengen.
        updateTsExecution(db, execId, {
            step:             'drained',
            ts_coins_a:       coinsA,
            ts_coins_b:       coinsB,
            decrease_tx_hash: closePending.decreaseTxHash,
            close_error:      closePending.reason,
        });
    }

    markPositionClosedInDb(db, position.id, closeTxHash);
    updateTsExecution(db, execId, { step: 'withdrawn', ts_coins_a: coinsA, ts_coins_b: coinsB });
    // Mengen mitgeben: scheitert weiter unten der Verkauf, muss die Meldung beziffern
    // können, wie viel ungeschützt im Wallet liegt.
    return {
        tsCoinsA: coinsA, tsCoinsB: coinsB,
        closePending: closePending && { ...closePending, coinsA, coinsB },
    };
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
            recordExitProceeds(db, { poolId: pool.id, swappedUsdc, note: 'trailing-stop-exit' });
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

/**
 * @param {{ source?: 'tick'|'fast' }} [opts]  Herkunft des Auslösers — 'tick' = regulärer
 *        5-Min-Zyklus, 'fast' = Schnellprüfung zwischen zwei Zyklen (lib/fast-stop-check.js).
 *        Landet in ts_executions.trigger_source, damit die Wirkung der Schnellprüfung
 *        messbar bleibt.
 */
export async function executeTs(pool, db, { source = 'tick' } = {}) {
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
    console.log(`[trailing-stop:${pool.id}] Trailing Stop ausgelöst (${source === 'fast' ? 'Schnellprüfung' : 'Zyklus'}): HWM ${hwmUsd.toFixed(2)} → ${currentUsd.toFixed(2)} USDC, Grund: ${triggerReason}`);

    await waitForCleanupToFinish();
    acquireSlLock();

    const execId = createTsExecution(db, {
        poolId:         pool.id,
        hwmUsd,
        currentUsd,
        drawdownPct,
        configSnapshot: cfg,
        triggerSource:  source,
    });

    // Beschreibt Kapital, das die Position bereits verlassen hat. Ab dem Moment ist ein
    // Fehler weiter unten ein Fehler MIT Geld im Wallet — das entscheidet über die Meldung.
    let partial = null;

    try {
        // Pool sofort inaktiv → verhindert Re-Open im nächsten Tick (Idempotenz)
        try {
            setPoolActive(pool.id, false);
            console.log(`[trailing-stop:${pool.id}] Pool auf active=false gesetzt`);
        } catch (err) {
            console.error(`[trailing-stop:${pool.id}] setPoolActive fehlgeschlagen: ${err.message}`);
        }

        // Phase 2: Withdraw. Ein liegengebliebenes NFT (closePending) hält den Exit nicht
        // mehr auf — der Verkauf unten schützt das Kapital, das NFT ist nur noch Rent.
        const { tsCoinsA, tsCoinsB, closePending } = await stepWithdraw(pool, db, execId);
        partial = closePending;

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
        // Best-effort: eine fehlschlagende PnL-Berechnung darf den bereits
        // abgeschlossenen Exit nicht nachträglich als Fehler melden.
        let pnlUsdc = null;
        try {
            if (position) pnlUsdc = computeExitPnl(db, pool, position);
        } catch (err) {
            console.warn(`[trailing-stop:${pool.id}] PnL-Berechnung fehlgeschlagen (nicht kritisch): ${err.message}`);
        }
        await notify.rmExecuted(pool, execLabel, {
            lpValueUsd: currentUsd, coinsA: tsCoinsA, coinsB: tsCoinsB, swappedUsdc, pnlUsdc,
            entryUsd: position?.entry_usd ?? null, hwmUsd, openedAtMs: position?.opened_at ?? null,
        }).catch(() => {});

        // Mindestwert nach Mindestwert-Exit nullen, damit eine Wiedereröffnung nicht
        // sofort wieder triggert (neues Kapital liegt i.d.R. unterhalb des alten Grenzwerts).
        if (triggeredByMin) clearMinimumValue(pool.id);

        if (partial) {
            console.warn(
                `[trailing-stop:${pool.id}] Trailing Stop abgeschlossen, Kapital gesichert — `
                + `ein leeres Position-NFT ist offen geblieben (Entnahme-TX ${partial.decreaseTxHash}). `
                + `Der tägliche Zombie-Cron holt die Rent zurück; für den Nutzer ist nichts zu tun.`
            );
        } else {
            console.log(`[trailing-stop:${pool.id}] Trailing Stop vollständig abgeschlossen.`);
        }

    } catch (err) {
        console.error(`[trailing-stop:${pool.id}] FEHLER: ${err.message}`);
        updateTsExecution(db, execId, { error_msg: err.message });
        await notifyExitFailure(pool, err, partial);
        throw err;
    } finally {
        releaseSlLock();
    }
}

/**
 * Meldet einen gescheiterten Exit — und unterscheidet dabei die beiden Fälle, die sich
 * bis 2026-08-22 einen msgKey teilten (LIQ#0312):
 *
 *   - Abbruch OHNE Kettenwirkung (z.B. Slippage): nichts wurde bewegt, der nächste Lauf
 *     versucht es erneut. Bleibt LOG_ONLY, sonst meldet der Bot Normalbetrieb.
 *   - Teilfehlschlag: die Liquidität ist bereits entnommen, das Kapital liegt
 *     ungeschützt im Wallet und der Pool ist inaktiv. Das MUSS sichtbar sein.
 *
 * Ein Fehler beim Melden darf den Exit-Fehler nicht überschreiben — aber auch nicht
 * lautlos verschwinden (das war die zweite Ursache, aus der nie eine Meldung ankam).
 */
async function notifyExitFailure(pool, err, known = null) {
    // 🔒 Der Marker am Fehler beschreibt nur den Aufruf, der ihn geworfen hat. Scheitert
    // erst der Verkauf NACH einer geretteten Entnahme, trägt der Fehler keinen
    // partialExit — das Kapital liegt aber sehr wohl im Wallet. Deshalb zählt auch der
    // vom Aufrufer durchgereichte Zustand, sonst verschwindet genau der Fall, in dem
    // wirklich Geld ungeschützt liegt, wieder in LOG_ONLY.
    const partial = err.partialExit ?? known;
    const send = partial
        ? notify.trailingStopPartial(pool, err, partial)
        : notify.trailingStopError(pool, 'execution', err);
    await send.catch(e =>
        console.error(`[trailing-stop:${pool.id}] Meldung konnte nicht abgesetzt werden: ${e.message}`));
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

        // Vor dem Withdraw lesen (wie in executeTs()) — danach ist die Position
        // geschlossen und resolveActiveThreshold()/computeExitPnl() bräuchten sie
        // für die Erfolgsmeldung unten sonst vergeblich.
        const position = getOpenPosition(db, exec.pool_id);
        const hwmUsd   = position?.hwm_usd ?? 0;

        // Kapital, das die Position schon verlassen hat — aus diesem Lauf oder, bei
        // 'drained', aus einem früheren. Entscheidet unten über die Meldung.
        let partial = exec.step === 'drained'
            ? { coinsA: exec.ts_coins_a ?? 0, coinsB: exec.ts_coins_b ?? 0, decreaseTxHash: exec.decrease_tx_hash }
            : null;

        try {
            let tsCoinsA    = exec.ts_coins_a ?? 0;
            let tsCoinsB    = exec.ts_coins_b ?? 0;
            let swappedUsdc = exec.swapped_usdc ?? null;

            // 'drained' verhält sich hier wie 'preparing' — nur überspringt stepWithdraw()
            // dann Fee-Claim, Entnahme und Burn und rechnet mit den persistierten Mengen.
            if (exec.step === 'preparing' || exec.step === 'drained') {
                const result = await stepWithdraw(pool, db, exec.id, exec);
                tsCoinsA = result.tsCoinsA;
                tsCoinsB = result.tsCoinsB;
                partial  = result.closePending;
            }

            if (['preparing', 'drained', 'withdrawn'].includes(exec.step) && cfg.autoSwapToUSDC) {
                swappedUsdc = await stepSwap(pool, db, exec.id, cfg, tsCoinsA, tsCoinsB);
            }

            if (['preparing', 'drained', 'withdrawn', 'swapped'].includes(exec.step) && cfg.sendTo) {
                await stepTransfer(pool, db, exec.id, cfg, tsCoinsA, tsCoinsB, swappedUsdc);
            }

            // 🔒 error_msg MIT löschen: bis LIQ#0312 blieb die Fehlermeldung des ersten
            // Versuchs stehen, während step auf 'complete' sprang — die Zeile behauptete
            // gleichzeitig „vollständig" und trug einen Fehler. Wer sie las, konnte einen
            // echten Teilfehlschlag nicht von einem geheilten Abbruch unterscheiden.
            updateTsExecution(db, exec.id, { step: 'complete', completed_at: Date.now(), error_msg: null });
            console.log(`[trailing-stop:${exec.pool_id}] Fortgesetzt und abgeschlossen.`);

            // 🔒 LIQ-Fix 2026-08-23: Dieser Erfolgspfad meldete den Exit nie — nur
            // executeTs() tat das. Scheiterte der erste Versuch (LOG_ONLY-Fehler) und
            // schloss erst der Resume die Position, kam beim Nutzer gar keine Meldung
            // an (weder Fehler noch Erfolg). Ab hier: identische Meldung wie in executeTs().
            const minValueUsd    = Number(cfg.minimumValueUsd) || 0;
            const triggeredByMin = minValueUsd > 0 && exec.current_usd < minValueUsd;
            const { pct: thresholdPct, stage } = resolveActiveThreshold(cfg, position);
            const execLabel = triggeredByMin
                ? { k: 'notify.liq.rm_label_min_value', p: { usdc: minValueUsd.toFixed(0) } }
                : (stage === 2
                    ? { k: 'notify.liq.rm_label_trailing_s2', p: { pct: thresholdPct } }
                    : { k: 'notify.liq.rm_label_trailing',    p: { pct: thresholdPct } });
            let pnlUsdc = null;
            try {
                if (position) pnlUsdc = computeExitPnl(db, pool, position);
            } catch (err) {
                console.warn(`[trailing-stop:${exec.pool_id}] PnL-Berechnung fehlgeschlagen (nicht kritisch): ${err.message}`);
            }
            await notify.rmExecuted(pool, execLabel, {
                lpValueUsd: exec.current_usd, coinsA: tsCoinsA, coinsB: tsCoinsB, swappedUsdc, pnlUsdc,
                entryUsd: position?.entry_usd ?? null, hwmUsd, openedAtMs: position?.opened_at ?? null,
            }).catch(() => {});
            if (triggeredByMin) clearMinimumValue(exec.pool_id);

        } catch (err) {
            console.error(`[trailing-stop:${exec.pool_id}] Fehler beim Fortsetzen: ${err.message}`);
            updateTsExecution(db, exec.id, { error_msg: err.message });
            // Auch der gescheiterte Wiederanlauf gehört gemeldet: sonst erfährt der Nutzer
            // von einem Kapital-im-Wallet-Zustand nur beim allerersten Versuch etwas.
            await notifyExitFailure(pool, err, partial);
        } finally {
            releaseSlLock();
        }
    }
}
