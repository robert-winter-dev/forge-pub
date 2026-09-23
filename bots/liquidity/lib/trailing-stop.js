/**
 * FORGE Liquidity – Trailing Stop
 *
 * Zieht den Stop-Wert über die Pool-Lebenszeit nach (monoton steigende
 * High-Water-Mark). Fällt der aktuelle Positionswert unter `hwm_usd * (1 -
 * thresholdPct/100)`, wird die Position sofort geschlossen (kein Bestätigungs-
 * fenster über mehrere Snapshots — bewusst so, seit 2026-07-24) und das
 * Kapital optional in USDC getauscht. Reine Absicherung — kein Wiedereinstieg,
 * kein Cooldown.
 *
 * 🔒 Der Positionswert ist seit 2026-08-30 `lp_value_usd + fees_pending_usd` (beides aus
 * demselben Snapshot, siehe latestStopValueUsd() in lib/db.js): Der Exit claimt offene Fees
 * immer mit, sie sind realisierbarer Wert. Ohne sie maß der Stop systematisch ~0,1–0,3 pp
 * weniger als das Dashboard (lib/pnl.js rechnet mit Fees) — am 2026-08-30 verfehlte die
 * Stufe-2-Scharfschaltung bei PUMP/SOL dadurch ihre Schwelle um 0,09 pp, während die Anzeige
 * „+2,15 %" zeigte. „Nur gemessene Werte" gilt unverändert: feesOwed ist ein On-Chain-Read.
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
 *
 * Die Scharfschaltung kennt seit 2026-08-30 zwei Wege (ODER-verknüpft, siehe
 * evaluateSecondStageArming): den gemessenen (HWM ≥ Einstieg × (1 + Stufe 1)) und den
 * angezeigten (PnL-Höchststand seit Anker ≥ Einstieg × Stufe 1, via pnlPeakForPeriod aus
 * lib/pnl.js, Auswahl `by:'usd'` — bis LIQ#000572 exakt die Zahl des Dashboards; seitdem
 * wählt die Anzeige den Höchststand nach Rendite, dieser Pfad bewusst weiter nach USD,
 * damit die Scharfschaltschwelle unverändert bleibt). Grund: Messwelt
 * und Anzeige trennen systematisch ~0,2–0,3 pp (Einstands-Anker-Differenz); peakt ein Pool
 * genau dazwischen, sah der Nutzer „+2 % überschritten", der Stop schaltete aber nie scharf
 * (PUMP/SOL 2026-08-30: Anzeige +2,15 %, Messwelt +1,91 %, Exit wäre bei ±0 statt +1,5 %
 * gelaufen). Eine Scharfschaltung kann den Schutz nur ENGER machen, nie lockern — der
 * Anzeige-Weg irrt deshalb in die sichere Richtung; die Drawdown-Messung selbst bleibt
 * unverändert „nur gemessene Werte".
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
    getOpenPosition, getPositionForExit, closePosition as markPositionClosedInDb,
    updatePositionHwm, latestStopValueUsd, countReinvestEvents, sumTransactionUsdValue,
    createTsExecution, updateTsExecution, getIncompleteTsExecutions,
} from './db.js';
import { pnlPeakForPeriod } from '../../../lib/pnl.js';
import { resolvePnlAnchorMs } from './pnl-anchor.js';
import { loadTsAdvice } from './ts-advice-provider.js';
import * as notify from './notify.js';
import { executeSwapStep, executeTransferStep, prepareExitAndClaimFees, closePositionOrRescue, computeExitPnl, recordExitProceeds } from './exit-finalizer.js';
import { PATHS } from '../../../config/paths.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB = PATHS.settingsDb;

// 1,75 % / 0,75 % seit 2026-08-30 abends (LIQ#0351): aus der Zitter-Messung — das größte
// erholte Zittern der acht gemessenen Pools liegt bei 1,04–1,78 %, das 95-%-Zittern bei
// sechs von acht unter 0,72 %. Der Vorwert 0,8/0,6 stammte aus dem verworfenen Backtest
// und lag mitten im Rauschen. Muss mit POOL_SETTINGS_DEFAULTS.trailingStop in
// lib/pool-settings-defaults.js übereinstimmen — siehe FALLBACK_TS_CONFIG unten.
const DEFAULT_THRESHOLD_PCT = 1.75;
const DEFAULT_THRESHOLD_PCT2 = 0.75;
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
// 6 h seit 2026-09-03 (LIQ#0359, vorher 1 h) — muss POOL_SETTINGS_DEFAULTS.trailingStop
// .cooldownHours in lib/pool-settings-defaults.js entsprechen; Begründung dort.
const DEFAULT_COOLDOWN_HOURS = 6;

const FALLBACK_TS_CONFIG = {
    enabled:         true,
    thresholdPct:    DEFAULT_THRESHOLD_PCT,
    // Zweite Stufe war hier bis zum 2026-08-30 bewusst aus, damit der Schutz ohne
    // ausdrückliche Konfiguration nicht enger ist als erwartet. Mit dem neuen Fallback
    // greift diese Begründung nicht mehr: 0,8 % / 0,6 % ist als Paar gemessen worden, die
    // erste Stufe allein war in keiner der Auswertungen die bessere Wahl.
    thresholdPct2:   DEFAULT_THRESHOLD_PCT2,
    minimumValueUsd: null,
    autoSwapToUSDC:  true,
    sendTo:          '',
    cooldownHours:   DEFAULT_COOLDOWN_HOURS,
};

// Nur einmal pro Pool und Prozesslaufzeit loggen – der Check läuft in jedem Zyklus.
const _fallbackLogged = new Set();

// ─── Settings-DB lesen ────────────────────────────────────────────────────────

/**
 * Wendet die Advisor-Empfehlung an, wenn der Pool auf „Auto" steht.
 *
 * Vorrang (Entscheidung 2026-08-30, Ticket LIQ#0351):
 *   1. Auto ist an UND es liegt eine belastbare, frische Empfehlung vor → deren Werte.
 *   2. Sonst: die vom Nutzer gesetzten Werte.
 *   3. Sind auch die leer: TS_AUTO_FALLBACK (1,75 % / 0,75 %).
 *
 * 🔒 Punkt 3 ist bewusst eng. Ein Nutzer, der „Auto" einschaltet und nie eigene Werte
 * gesetzt hat, darf nicht ungeschützt dastehen, wenn der Advisor nichts liefert — und der
 * Rückfall muss STRENGER sein als der alte 10-%-Default, nicht lockerer. Genau dieser
 * lockere Rückfall kostete am 2026-08-22 rund 69 USDC: Ein Pool ohne konfigurierte
 * Schwelle fiel auf 10 % zurück und lief damit praktisch ohne wirksamen Stop.
 * Ein Schutzmechanismus darf im Zweifel nur strenger werden, nie lockerer.
 *
 * ── Warum 1,75 % / 0,75 % (2026-08-30 abends, LIQ#0351) ──────────────────────
 * Aus der Zitter-Messung des Advisors (erholte Rücksetzer, 14 Tage, 30-s-Takt): Stufe 1
 * deckt das größte gemessene Zittern von sieben der acht Pools ab (1,04–1,78 %), Stufe 2
 * liegt knapp über dem 95-%-Zittern von sechs der acht (unter 0,72 %). Der Wert davor
 * (0,8 / 0,6, vormittags gesetzt) stammte aus dem verworfenen Backtest und lag mitten im
 * Rauschen; die Historie dazu steht im Changelog vom 2026-08-30.
 *
 * ⚠️ Diese Konstante greift NUR, wenn „Auto" an ist und weder Advisor noch Nutzer Werte
 * liefern. Pools mit eigener Konfiguration bleiben unberührt.
 */
export const TS_AUTO_FALLBACK = { thresholdPct: DEFAULT_THRESHOLD_PCT, thresholdPct2: DEFAULT_THRESHOLD_PCT2 };

function applyAutoAdvice(ts, poolId, ctx) {
    if (!ts?.auto) return ts;

    // Empfehlung erst hier holen — für Pools ohne „Auto" fällt der Lookup ganz weg.
    let advice = null;
    if (ctx?.db) {
        try { advice = loadTsAdvice(ctx.db, poolId, ctx.poolType ?? null)?.advice ?? null; }
        catch { advice = null; }   // ein Advisor-Fehler darf den Stop nie ausfallen lassen
    }

    if (advice && Number.isFinite(Number(advice.thresholdPct))) {
        return {
            ...ts,
            thresholdPct:  Number(advice.thresholdPct),
            thresholdPct2: advice.thresholdPct2 == null ? null : Number(advice.thresholdPct2),
            autoApplied:   true,
            autoScope:     advice.scope,
        };
    }

    // Auto an, aber nichts Belastbares geliefert → eigene Werte, sonst enger Rückfall.
    const hasOwn = Number.isFinite(Number(ts.thresholdPct)) && Number(ts.thresholdPct) > 0;
    if (hasOwn) return { ...ts, autoApplied: false, autoScope: null };

    if (!_autoFallbackLogged.has(poolId)) {
        _autoFallbackLogged.add(poolId);
        console.warn(`[trailing-stop:${poolId}] „Auto" aktiv, aber keine belastbare Advisor-Empfehlung und keine eigenen Werte – Rückfall auf ${TS_AUTO_FALLBACK.thresholdPct} % / ${TS_AUTO_FALLBACK.thresholdPct2} %.`);
    }
    return { ...ts, ...TS_AUTO_FALLBACK, autoApplied: false, autoScope: null };
}

const _autoFallbackLogged = new Set();

/**
 * Nur für bin/test-trailing-stop-advisor.js: prüft die Auflösungsreihenfolge ohne
 * settings.db. Die Reihenfolge ist eine Sicherheitszusage — sie muss gegen das Original
 * geprüft werden, nicht gegen eine Nachbildung.
 */
export function applyAutoAdviceForTest(ts, poolId, ctx) {
    return applyAutoAdvice(ts, poolId, ctx);
}

/**
 * Baut den Kontext für loadTsConfig() aus dem, was an jeder Aufrufstelle ohnehin vorliegt.
 * Der Pool-Typ heißt je nach Herkunft `pool_type` (DB-Zeile) oder `poolType` (pools.json).
 */
function tsCtx(db, pool) {
    return { db, poolType: pool?.pool_type ?? pool?.poolType ?? null };
}

/**
 * @param {Object}   [ctx]           optionaler Kontext für den „Auto"-Modus
 * @param {Database} [ctx.db]        Bot-DB — ohne sie wird keine Empfehlung gesucht
 * @param {string}   [ctx.poolType]  Pool-Typ, für den Rückfall auf die Typ-Empfehlung
 */
export function loadTsConfig(poolId, ctx = null) {
    try {
        const sdb = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        sdb.close();

        const ts = row ? (JSON.parse(row.settings)?.trailingStop ?? null) : null;
        // cooldownHours kam erst nachträglich dazu (2026-08-08) – Alt-Einträge ohne
        // dieses Feld sollen trotzdem den Default-Cooldown bekommen, nicht 0/ungeschützt.
        if (ts) return applyAutoAdvice({
            ...ts,
            cooldownHours: Number.isFinite(Number(ts.cooldownHours)) ? Number(ts.cooldownHours) : DEFAULT_COOLDOWN_HOURS,
        }, poolId, ctx);

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
 * Die reine Scharfschalt-Entscheidung für Stufe 2 — wie evaluateTsTrigger() bewusst frei
 * von DB- und Settings-Zugriff, damit `bin/test-trailing-stop-sim.js` das Original prüft.
 *
 * Zwei Wege, ODER-verknüpft (Begründung im Modulkopf):
 *   'hwm' — die gemessene Welt: HWM ≥ Einstieg × (1 + Stufe 1).
 *   'pnl' — die angezeigte Welt: PnL-Höchststand seit Anker ≥ Einstieg × Stufe 1.
 *           Greift auch, wenn die Messwelt die Schwelle knapp verfehlt (systematische
 *           ~0,2–0,3-pp-Differenz der Anker). Ein fälschliches Scharfschalten verschärft
 *           nur — die sichere Richtung.
 *
 * @param {number}      firstPct           Stufe-1-Schwelle in %
 * @param {number|null} secondPct          Stufe-2-Schwelle in % (null = keine Stufe 2)
 * @param {number}      hwmUsd             gemessener Höchststand (LP + Fees)
 * @param {number}      entryUsd           gemessene Einstiegsreferenz
 * @param {number|null} displayPeakPnlUsd  PnL-Höchststand seit Anker (lib/pnl.js) oder null,
 *                                         wenn nicht berechenbar — dann zählt nur der hwm-Weg
 * @returns {{ arm: boolean, via: 'hwm'|'pnl'|null }}
 */
export function evaluateSecondStageArming({ firstPct, secondPct, hwmUsd, entryUsd, displayPeakPnlUsd = null }) {
    if (secondPct == null) return { arm: false, via: null };
    if (!(entryUsd > 0))   return { arm: false, via: null };   // Referenz noch nicht etabliert

    if (hwmUsd > 0 && hwmUsd >= entryUsd * (1 + firstPct / 100)) return { arm: true, via: 'hwm' };
    if (displayPeakPnlUsd != null && displayPeakPnlUsd >= entryUsd * (firstPct / 100)) {
        return { arm: true, via: 'pnl' };
    }
    return { arm: false, via: null };
}

// PnL-Ausfälle nur einmal pro Pool und Prozesslaufzeit loggen — die Prüfung läuft jeden Zyklus.
const _peakPnlWarnLogged = new Set();

/**
 * PnL-Höchststand seit Anker — exakt die Zahl des „Hoch"-Tooltips im Dashboard: derselbe
 * Anker (resolvePnlAnchorMs: letzte externe Einzahlung / manueller Reset / Eröffnung, wie
 * bin/export.js) und dieselbe Kurve (pnlPeakForPeriod, lib/pnl.js — hier ist KEINE eigene
 * PnL-Mathematik, nur der Aufruf der zentralen Bibliothek).
 *
 * null bei jedem Fehler: Die Scharfschaltung darf am PnL-Pfad nie scheitern, der
 * hwm-Weg in evaluateSecondStageArming() bleibt dann allein maßgeblich.
 */
function _displayPeakPnlUsd(db, poolId, position) {
    try {
        const dep = db.prepare(
            `SELECT MAX(created_at) AS t FROM capital_flows
              WHERE pool_id = ? AND usdc_amount > 0 AND is_external = 1 AND created_at >= ?`
        ).get(poolId, position.opened_at ?? 0);
        const fromMs = resolvePnlAnchorMs(dep?.t, position.pnl_anchor_reset_at, position.opened_at);
        // by:'usd' — hier wird der Höchststand gegen eine USD-Schwelle (Einstiegswert ×
        // Stufe 1) gestellt, nicht angezeigt. Die Anzeige wählt seit LIQ#000572 nach
        // Rendite aus; das hier auf pct umzustellen würde die Scharfschaltschwelle
        // verschieben — eine Finanzentscheidung, die nicht Teil dieses Tickets ist.
        const peak   = pnlPeakForPeriod(db, { flavor: config.botId, scope: poolId, fromMs, by: 'usd' });
        return Number.isFinite(peak?.pnlUsd) ? peak.pnlUsd : null;
    } catch (err) {
        if (!_peakPnlWarnLogged.has(poolId)) {
            _peakPnlWarnLogged.add(poolId);
            console.warn(`[trailing-stop:${poolId}] PnL-Höchststand nicht berechenbar (${err.message}) – Stufe-2-Scharfschaltung nutzt nur den gemessenen Weg.`);
        }
        return null;
    }
}

/**
 * Schaltet Stufe 2 scharf, sobald einer der beiden Wege aus evaluateSecondStageArming()
 * erreicht ist.
 *
 * Läuft im Snapshot-Pfad direkt nach dem HWM-Update und liest die Position bewusst frisch —
 * das übergebene Objekt stammt vom Zyklusbeginn und kennt die gerade geschriebene HWM nicht.
 *
 * Einmal gesetzt, bleibt `d2_armed_at` stehen (Ratchet, siehe Modulkopf).
 *
 * @param {Object} [opts]
 * @param {number|null} [opts.displayPeakPnlUsd]  PnL-Höchststand injizieren (Simulator);
 *        ohne Angabe wird er über lib/pnl.js berechnet.
 */
export function armSecondStageIfReached(db, poolId, positionId, cfg, opts = {}) {
    const firstPct  = normalizeThreshold(cfg.thresholdPct);
    const secondPct = resolveSecondThreshold(cfg, firstPct);
    if (secondPct == null) return;   // keine zweite Stufe konfiguriert

    const row = db.prepare(
        `SELECT hwm_usd, entry_usd, d2_armed_at, opened_at, pnl_anchor_reset_at FROM positions WHERE id = ?`
    ).get(positionId);
    if (!row || row.d2_armed_at) return;                       // schon scharf
    if (!(row.entry_usd > 0)) return;                          // Referenz noch nicht etabliert

    // Den (teureren) PnL-Weg nur rechnen, wenn der gemessene Weg allein nicht reicht.
    let verdict = evaluateSecondStageArming({
        firstPct, secondPct, hwmUsd: row.hwm_usd ?? 0, entryUsd: row.entry_usd,
    });
    if (!verdict.arm) {
        const peakPnlUsd = 'displayPeakPnlUsd' in opts
            ? opts.displayPeakPnlUsd
            : _displayPeakPnlUsd(db, poolId, row);
        verdict = evaluateSecondStageArming({
            firstPct, secondPct, hwmUsd: row.hwm_usd ?? 0, entryUsd: row.entry_usd,
            displayPeakPnlUsd: peakPnlUsd,
        });
        if (verdict.arm) {
            console.log(`[trailing-stop:${poolId}] Stufe 2 scharf (Anzeige-Weg): PnL-Höchststand ${peakPnlUsd.toFixed(2)} USDC erreicht ${firstPct}% des Einstiegs (${row.entry_usd.toFixed(2)} USDC); Messwelt-Höchststand ${(row.hwm_usd ?? 0).toFixed(2)} lag knapp darunter. Drawdown-Schwelle ab jetzt ${secondPct}% statt ${firstPct}%.`);
        }
    } else {
        const gainPct = ((row.hwm_usd - row.entry_usd) / row.entry_usd) * 100;
        console.log(`[trailing-stop:${poolId}] Stufe 2 scharf: Höchststand ${row.hwm_usd.toFixed(2)} USDC liegt ${gainPct.toFixed(2)}% über dem Einstieg (${row.entry_usd.toFixed(2)} USDC, Schwelle ${firstPct}%). Drawdown-Schwelle ab jetzt ${secondPct}% statt ${firstPct}%.`);
    }
    if (!verdict.arm) return;

    db.prepare(`UPDATE positions SET d2_armed_at = ? WHERE id = ?`).run(Date.now(), positionId);
}

// ─── HWM-Update (wird nach jedem Per-Pool-Snapshot aufgerufen) ────────────────

/**
 * Zieht die High-Water-Mark der offenen Position nach.
 * Wird vom Bot-Loop direkt nach writePositionSnapshotFromState gerufen.
 *
 * @param {number} valueUsd  gemessener Positionswert — LP-Wert plus offene Fees
 *                           (latestStopValueUsd), siehe Modulkopf
 */
export function updateHwm(db, pool, position, valueUsd) {
    if (!position || !(valueUsd > 0)) return;
    updatePositionHwm(db, position.id, valueUsd);

    // Direkt danach prüfen, ob die zweite Stufe scharf wird. Reine DB-Arbeit, kein API-Call.
    // Ein Settings-Fehler darf den Snapshot-Pfad nicht abbrechen — im Zweifel bleibt Stufe 1
    // aktiv, das ist die sichere Richtung.
    try {
        const cfg = loadTsConfig(pool.id, tsCtx(db, pool));
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
 *   - kein gültiger Positionswert verfügbar
 *   - Flag älter als hwm_at (Reset bereits berücksichtigt)
 *
 * `valueUsd` ist der Stop-Wert (LP + offene Fees, latestStopValueUsd) — derselbe Maßstab,
 * auf dem HWM und Trigger rechnen.
 */
export function processHwmResetIfRequested(db, pool, position, valueUsd) {
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

    if (!(valueUsd > 0)) return false;

    // targetUsd: vom UI mitgeschickter Zielwert (Wert zum Klick-Zeitpunkt).
    // Fallback auf valueUsd wenn kein Zielwert gespeichert (ältere Requests).
    // Wir nehmen den kleineren der beiden, damit ein Preisanstieg zwischen Klick
    // und Verarbeitung den Reset nicht wirkungslos macht.
    const targetUsd = (cfg.resetTargetUsd > 0) ? Math.min(cfg.resetTargetUsd, valueUsd) : valueUsd;

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
    console.log(`[trailing-stop:${pool.id}] Referenzwert manuell auf ${targetUsd.toFixed(2)} USDC zurückgesetzt (Request ${new Date(requestedAt).toISOString()}, target=${cfg.resetTargetUsd?.toFixed(2) ?? 'n/a'}, wert=${valueUsd.toFixed(2)}); Einstiegsreferenz mit zurückgesetzt, Stufe 2 wieder entschärft, PnL-Anker auf jetzt gesetzt.`);

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
 * @param {number} valueUsd     aktueller (gemessener) Positionswert — LP-Wert plus offene
 *                              Fees, siehe latestStopValueUsd() und Modulkopf
 * @returns {{ trigger: boolean, reason: 'drawdown'|'minimum'|null, drawdownPct: number,
 *             thresholdPct: number, stage: 1|2, triggerAt: number }}
 */
export function evaluateTsTrigger(cfg, position, valueUsd) {
    const none = { trigger: false, reason: null, drawdownPct: 0, thresholdPct: 0, stage: 1, triggerAt: 0 };
    if (!cfg?.enabled || !position) return none;

    const { pct: thresholdPct, stage } = resolveActiveThreshold(cfg, position);

    const hwmUsd = position.hwm_usd ?? 0;
    if (!(hwmUsd > 0)) return none;          // HWM noch nicht etabliert
    if (!(valueUsd > 0)) return none;        // kein verwertbarer Messwert

    const triggerAt   = hwmUsd * (1 - thresholdPct / 100);
    const drawdownPct = ((hwmUsd - valueUsd) / hwmUsd) * 100;
    const base        = { drawdownPct, thresholdPct, stage, triggerAt };

    if (valueUsd < triggerAt) return { ...base, trigger: true, reason: 'drawdown' };

    // Pool-Mindestwert: absoluter USDC-Boden, unabhängig vom Drawdown.
    // Guard: nur prüfen wenn der HWM jemals >= Minimum war — verhindert sofortigen
    // Exit bei Positionen, die von Anfang an unter dem Mindestwert eröffnet wurden.
    const minValueUsd = Number(cfg.minimumValueUsd) || 0;
    if (minValueUsd > 0 && hwmUsd >= minValueUsd && valueUsd < minValueUsd) {
        return { ...base, trigger: true, reason: 'minimum' };
    }

    return { ...base, trigger: false, reason: null };
}

/**
 * Gibt true zurück wenn der Trailing Stop für diesen Pool feuern soll.
 * Kein API-Call – nur DB-Lookups; die Entscheidung selbst trifft evaluateTsTrigger().
 */
export function shouldTriggerTs(pool, db) {
    const cfg = loadTsConfig(pool.id, tsCtx(db, pool));
    if (!cfg?.enabled) return false;

    const position = getOpenPosition(db, pool.id);
    if (!position) return false;

    // Sofort-Trigger: keine Mehrfach-Bestätigung mehr — der neueste Snapshot
    // entscheidet direkt. Bewusst so gewünscht (kein verzögerter Stop-Loss).
    const snap = latestStopValueUsd(db, pool.id);
    return evaluateTsTrigger(cfg, position, snap?.valueUsd ?? 0).trigger;
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
        return { tsCoinsA: knownA, tsCoinsB: knownB, closePending: null, closeTx: exec.decrease_tx_hash ?? null };
    }

    if (!position) {
        console.log(`${logPfx} Keine offene Position mehr – überspringe Withdraw`);
        updateTsExecution(db, execId, { step: 'withdrawn', ts_coins_a: 0, ts_coins_b: 0 });
        return { tsCoinsA: 0, tsCoinsB: 0, closePending: null, closeTx: null };
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
        closeTx: closeTxHash,
    };
}

async function stepSwap(pool, db, execId, cfg, tsCoinsA, tsCoinsB) {
    return executeSwapStep(pool, {
        coinsA:      tsCoinsA,
        coinsB:      tsCoinsB,
        sendTo:      cfg.sendTo,
        logPrefix:   `[trailing-stop:${pool.id}]`,
        slippageBps: config.rm.swapSlippageBps,
        db,
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
    const cfg = loadTsConfig(pool.id, tsCtx(db, pool));
    if (!cfg?.enabled) return;

    const position     = getOpenPosition(db, pool.id);
    const hwmUsd       = position?.hwm_usd ?? 0;

    const { pct: thresholdPct, stage } = resolveActiveThreshold(cfg, position);

    // Derselbe Wert wie in shouldTriggerTs(): LP-Wert + offene Fees des neuesten Snapshots.
    const currentUsd = latestStopValueUsd(db, pool.id)?.valueUsd ?? 0;
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

    // Beginn des Ausstiegs — dieselbe Zeit, die als ts_executions.triggered_at landet.
    // Die Meldung braucht sie getrennt vom Abschlusszeitpunkt: zwischen Auslösung und
    // letztem Swap liegen Entnahme, Verkauf und ggf. Transfer.
    const exitStartedAt = Date.now();
    const execId = createTsExecution(db, {
        poolId:         pool.id,
        hwmUsd,
        currentUsd,
        drawdownPct,
        configSnapshot: cfg,
        triggerSource:  source,
    });

    // `partial` beschreibt ausschließlich ein liegengebliebenes Position-NFT (closePending)
    // und steuert die Erfolgsmeldung ganz unten.
    let partial = null;
    // `capitalOut` beschreibt Kapital, das die Position verlassen hat. Ab diesem Moment ist
    // JEDER Fehler weiter unten ein Fehler MIT Geld im Wallet — das entscheidet über die
    // Sichtbarkeit der Fehlermeldung.
    //
    // 🔒 Bis 30.08.2026 taten beide Aufgaben dieselbe Variable, und sie wurde nur gesetzt,
    // wenn das SCHLIESSEN scheiterte. Gelang das Schließen und scheiterte erst der Verkauf,
    // blieb sie null — der Fehlschlag lief über notify.liq.trailing_stop_error, und der
    // steht auf LOG_ONLY mit der Begründung „es wurde nichts bewegt". Bewegt worden war
    // aber alles: bei NATIX/USDC lagen 125 277 NATIX ungeschützt im Wallet, während fünf
    // Fehlversuche spurlos im Nexus-Journal verschwanden. Dieselbe Fehlerklasse wie
    // LIQ#0312, eine Station weiter — deshalb jetzt zwei getrennte Variablen.
    let capitalOut = null;

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
        const { tsCoinsA, tsCoinsB, closePending, closeTx } = await stepWithdraw(pool, db, execId);
        partial = closePending;
        // Ab hier ist das Kapital draußen — unabhängig davon, ob das NFT sauber geschlossen
        // wurde. Der decreaseTxHash steht nur im closePending-Fall zur Verfügung.
        if (tsCoinsA > 0 || tsCoinsB > 0) {
            capitalOut = closePending ?? { coinsA: tsCoinsA, coinsB: tsCoinsB, decreaseTxHash: null };
        }

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
            hwmUsd, openedAtMs: position?.opened_at ?? null,
            capitalUsdc:   position?.capital_usdc ?? null,
            entryCostUsdc: position?.entry_cost_usdc ?? null,
            hwmAtMs:       position?.hwm_at ?? null,
            exitStartedAtMs: exitStartedAt,
            openTx:  position?.open_tx ?? null,
            closeTx: closeTx ?? null,
            nftMint: position?.nft_mint ?? null,
            reinvestCount: position
                ? countReinvestEvents(db, pool.id, position.opened_at, exitStartedAt)
                : null,
            reinvestUsdc: position
                ? sumTransactionUsdValue(db, pool.id, position.opened_at, exitStartedAt, { types: ['reinvest'] })
                : null,
            bestPoolUsdc: position
                ? sumTransactionUsdValue(db, pool.id, position.opened_at, exitStartedAt, { types: ['deposit', 'open_position'], notePrefix: 'cleanup' })
                : null,
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
        await notifyExitFailure(pool, err, capitalOut);
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
        //
        // 🔒 Beim Resume ab 'withdrawn' ist sie das bereits: dieser Lauf schließt nichts
        // mehr, das hat der vorherige getan. getOpenPosition() allein lieferte hier null
        // und die Abschlussmeldung kam ohne Kapital, Höchststand und PnL heraus.
        const position = getPositionForExit(db, exec.pool_id, exec.triggered_at);
        const hwmUsd   = position?.hwm_usd ?? 0;

        // Kapital, das die Position schon verlassen hat — aus diesem Lauf oder aus einem
        // früheren. Entscheidet unten über die Sichtbarkeit der Fehlermeldung.
        //
        // 🔒 Ab 'withdrawn' entnimmt dieser Lauf gar nichts mehr (der Block unten wird
        // übersprungen), die Entnahme ist aber längst passiert. Bis 30.08.2026 stand hier
        // nur 'drained', weshalb ein Resume, der am Verkauf scheitert, ohne jede sichtbare
        // Meldung endete — genau der NATIX/USDC-Fall: fünf Wiederanläufe, fünfmal
        // LOG_ONLY, 125 277 NATIX ungeschützt im Wallet. Deshalb JEDER Schritt ab
        // 'drained', nicht nur der eine.
        const CAPITAL_OUT_STEPS = ['drained', 'withdrawn', 'swapped', 'transferred'];
        let partial = CAPITAL_OUT_STEPS.includes(exec.step)
            ? { coinsA: exec.ts_coins_a ?? 0, coinsB: exec.ts_coins_b ?? 0, decreaseTxHash: exec.decrease_tx_hash }
            : null;

        try {
            let tsCoinsA    = exec.ts_coins_a ?? 0;
            let tsCoinsB    = exec.ts_coins_b ?? 0;
            let swappedUsdc = exec.swapped_usdc ?? null;
            // Bereits gesetzt, falls ein früherer Lauf das Schließen schon erledigt hat
            // (dann steht close_tx längst in der DB-Zeile, die getPositionForExit oben
            // gelesen hat) — stepWithdraw() unten überschreibt das nur, wenn dieser Lauf
            // selbst noch schließt.
            let closeTx = position?.close_tx ?? null;

            // 'drained' verhält sich hier wie 'preparing' — nur überspringt stepWithdraw()
            // dann Fee-Claim, Entnahme und Burn und rechnet mit den persistierten Mengen.
            if (exec.step === 'preparing' || exec.step === 'drained') {
                const result = await stepWithdraw(pool, db, exec.id, exec);
                tsCoinsA = result.tsCoinsA;
                tsCoinsB = result.tsCoinsB;
                closeTx  = result.closeTx ?? closeTx;
                // Nicht `= result.closePending`: gelingt das Schließen, ist das Kapital
                // trotzdem draußen (siehe capitalOut in executeTs).
                partial  = (tsCoinsA > 0 || tsCoinsB > 0)
                    ? (result.closePending ?? { coinsA: tsCoinsA, coinsB: tsCoinsB, decreaseTxHash: null })
                    : result.closePending;
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
                hwmUsd, openedAtMs: position?.opened_at ?? null,
                capitalUsdc:   position?.capital_usdc ?? null,
                entryCostUsdc: position?.entry_cost_usdc ?? null,
                hwmAtMs:       position?.hwm_at ?? null,
                exitStartedAtMs: exec.triggered_at ?? null,
                openTx:  position?.open_tx ?? null,
                closeTx: closeTx ?? null,
                nftMint: position?.nft_mint ?? null,
                reinvestCount: position
                    ? countReinvestEvents(db, exec.pool_id, position.opened_at, exec.triggered_at ?? Date.now())
                    : null,
                reinvestUsdc: position
                    ? sumTransactionUsdValue(db, exec.pool_id, position.opened_at, exec.triggered_at ?? Date.now(), { types: ['reinvest'] })
                    : null,
                bestPoolUsdc: position
                    ? sumTransactionUsdValue(db, exec.pool_id, position.opened_at, exec.triggered_at ?? Date.now(), { types: ['deposit', 'open_position'], notePrefix: 'cleanup' })
                    : null,
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
