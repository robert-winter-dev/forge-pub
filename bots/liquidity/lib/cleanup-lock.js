/**
 * FORGE Liquidity – Cleanup-Lock + SL-Lock + Manual-Lock + Rebalance-Lock
 *
 * Vier Lock-Dateien koordinieren Cleanup, Stop-Loss, manuelle Aktionen und Rebalancing:
 *
 * data/cleanup.lock   – wird von cleanup.js gehalten; bot.js prüft via isCleanupRunning()
 * data/sl.lock        – wird vom SL/TP-Flow (bot.js) gehalten; cleanup.js prüft via isSlLocked()
 * data/manual.lock    – wird von deposit.js / withdraw.js gehalten (manuelle UI-Aktionen);
 *                       cleanup.js prüft via isManualLocked()
 * data/rebalance.lock – wird von bot.js während _doRebalance() gehalten;
 *                       deposit.js / withdraw.js / cleanup.js prüfen via isRebalanceLocked()
 *
 * Force-Rebalance-Signal:
 * data/force-rebalance-<poolId>.flag – wird von ForgeSettings via API gesetzt;
 *   bot.js liest + löscht die Datei beim nächsten Tick und ruft _doRebalance() auf.
 *
 * Stale-Erkennung (je zwei Ebenen):
 *   1. PID-Check: process.kill(pid, 0) – ESRCH = Prozess tot → Lock verwaist
 *   2. Timeout:   Lock älter als STALE_MS → verwaist (Sicherheitsnetz)
 *
 * Verhalten bei Konflikt:
 *   - Cleanup startet, SL-, Manual- oder Rebalance-Lock gesetzt → Cleanup überspringt diesen Lauf
 *   - SL startet, Cleanup-Lock gesetzt → SL wartet (waitForCleanupToFinish), dann weiter
 *   - Manuelle Aktion (deposit/withdraw) startet, Cleanup/SL/Rebalance läuft → harter Abbruch
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PATHS } from '../../../config/paths.js';

const __dirname           = dirname(fileURLToPath(import.meta.url));
const DATA_DIR            = PATHS.liquidityData;
const LOCK_FILE           = join(DATA_DIR, 'cleanup.lock');
const SL_LOCK_FILE        = join(DATA_DIR, 'sl.lock');
const MANUAL_LOCK_FILE    = join(DATA_DIR, 'manual.lock');
const REBALANCE_LOCK_FILE = join(DATA_DIR, 'rebalance.lock');
const STALE_MS            = 20 * 60 * 1000; // 20 Minuten (Cleanup)
const SL_STALE_MS         = 30 * 60 * 1000; // 30 Minuten (SL-Flow)
const MANUAL_STALE_MS     = 10 * 60 * 1000; // 10 Minuten (Manual-Aktion sollte schnell sein)
const REBALANCE_STALE_MS  = 15 * 60 * 1000; // 15 Minuten (Rebalancing)

// ── Hilfsfunktion ─────────────────────────────────────────────────────────────

function checkLock(file, staleMs, releaseFn) {
    if (!existsSync(file)) return false;
    let lock;
    try {
        lock = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return false;
    }
    if (Date.now() - lock.startedAt > staleMs) {
        releaseFn();
        return false;
    }
    try {
        process.kill(lock.pid, 0);
    } catch (err) {
        if (err.code === 'ESRCH') { releaseFn(); return false; }
    }
    return true;
}

// ── Cleanup-Lock (unveränderte API) ───────────────────────────────────────────

export function acquireLock() {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
}

export function releaseLock() {
    try { unlinkSync(LOCK_FILE); } catch { /* bereits weg */ }
}

export function isCleanupRunning() {
    return checkLock(LOCK_FILE, STALE_MS, releaseLock);
}

// ── SL-Lock (neu) ─────────────────────────────────────────────────────────────

export function acquireSlLock() {
    writeFileSync(SL_LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
}

export function releaseSlLock() {
    try { unlinkSync(SL_LOCK_FILE); } catch { /* bereits weg */ }
}

export function isSlLocked() {
    return checkLock(SL_LOCK_FILE, SL_STALE_MS, releaseSlLock);
}

// ── Manual-Lock (deposit/withdraw via UI) ─────────────────────────────────────

export function acquireManualLock(meta = {}) {
    writeFileSync(MANUAL_LOCK_FILE, JSON.stringify({
        pid: process.pid, startedAt: Date.now(), ...meta,
    }), 'utf8');
}

export function releaseManualLock() {
    try { unlinkSync(MANUAL_LOCK_FILE); } catch { /* bereits weg */ }
}

export function isManualLocked() {
    return checkLock(MANUAL_LOCK_FILE, MANUAL_STALE_MS, releaseManualLock);
}

// ── Rebalance-Lock (bot.js während _doRebalance) ──────────────────────────────

export function acquireRebalanceLock() {
    writeFileSync(REBALANCE_LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
}

export function releaseRebalanceLock() {
    try { unlinkSync(REBALANCE_LOCK_FILE); } catch { /* bereits weg */ }
}

export function isRebalanceLocked() {
    return checkLock(REBALANCE_LOCK_FILE, REBALANCE_STALE_MS, releaseRebalanceLock);
}

// ── Bot-Op-Lock (bot.js während Claim/Reinvest/Snapshot) ──────────────────────
//
// Kurzlebiger Lock, den die Bot-Loop um ihre mutierenden Pro-Pool-Operationen
// (Claim → Reinvest → Snapshot) hält. Damit erkennen manuelle Aktionen
// (deposit/withdraw/close-and-reopen) „Bot ist gerade aktiv" und warten, statt
// gleichzeitig dieselbe Position on-chain zu mutieren (Race → stale Snapshot).
// Stale-Timeout bewusst knapp: ein Claim/Reinvest dauert Sekunden, mit RPC-Retries
// selten über 1–2 Min.
const BOTOP_LOCK_FILE = join(DATA_DIR, 'botop.lock');
const BOTOP_STALE_MS  = 3 * 60 * 1000; // 3 Minuten

export function acquireBotOpLock(meta = {}) {
    writeFileSync(BOTOP_LOCK_FILE, JSON.stringify({
        pid: process.pid, startedAt: Date.now(), ...meta,
    }), 'utf8');
}

export function releaseBotOpLock() {
    try { unlinkSync(BOTOP_LOCK_FILE); } catch { /* bereits weg */ }
}

export function isBotOpRunning() {
    return checkLock(BOTOP_LOCK_FILE, BOTOP_STALE_MS, releaseBotOpLock);
}

/**
 * Wartet bis der Bot weder eine Claim/Reinvest/Snapshot-Operation (botop.lock)
 * noch ein Rebalancing (rebalance.lock) ausführt. Für manuelle Aktionen
 * (deposit/withdraw/close-and-reopen): Bot hat Vorrang → der User wartet.
 * @param {number} timeoutMs – max. Wartezeit (default 90 s; Bot-Ops sind kurz)
 * @returns {Promise<boolean>} true = Bot frei; false = Timeout überschritten
 */
export async function waitForBotToFinish(timeoutMs = 90_000) {
    const busy = () => isBotOpRunning() || isRebalanceLocked();
    if (!busy()) return true;

    const deadline = Date.now() + timeoutMs;
    const POLL_MS  = 1_500;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_MS));
        if (!busy()) return true;
    }
    return false;
}

// ── Force-Rebalance-Flag (Signal von ForgeSettings → bot.js) ─────────────────

export function setForceRebalanceFlag(poolId) {
    writeFileSync(join(DATA_DIR, `force-rebalance-${poolId}.flag`), '', 'utf8');
}

export function checkAndClearForceRebalanceFlag(poolId) {
    const file = join(DATA_DIR, `force-rebalance-${poolId}.flag`);
    if (!existsSync(file)) return false;
    try { unlinkSync(file); } catch {}
    return true;
}

// ── Rebalance-Pending-Flag (decreaseLiquidity OK, closePosition fehlgeschlagen) ──
// Wird von bot.js im Close-Fehler-Pfad gesetzt: Die Position-Liquidität wurde on-chain
// bereits reduziert (Tokens liegen im Wallet), aber das Rebalancing ist nicht sauber
// abgeschlossen. In diesem Zustand DARF der Cleanup die freigesetzten Tokens NICHT als
// Neukapital wieder einzahlen — sonst entsteht Phantom-Kapital (PUMP/SOL-Vorfall
// 2026-06-28: capital_usdc verdoppelt, PnL -148). Das nächste erfolgreiche Rebalancing
// (Close+Reopen) deployt die Tokens kapital-neutral und löscht das Flag. Auto-Verfall
// nach 90 Min als Sicherheitsnetz, falls das Rebalancing nie erneut greift (z.B. Preis
// kehrt in die Range zurück).
const REBALANCE_PENDING_STALE_MS = 90 * 60 * 1000;

export function setRebalancePendingFlag(poolId) {
    writeFileSync(join(DATA_DIR, `rebalance-pending-${poolId}.flag`), String(Date.now()), 'utf8');
}

export function clearRebalancePendingFlag(poolId) {
    const file = join(DATA_DIR, `rebalance-pending-${poolId}.flag`);
    if (existsSync(file)) { try { unlinkSync(file); } catch {} }
}

export function isRebalancePending(poolId) {
    const file = join(DATA_DIR, `rebalance-pending-${poolId}.flag`);
    if (!existsSync(file)) return false;
    let ts = 0;
    try { ts = Number(readFileSync(file, 'utf8')) || 0; } catch { return false; }
    if (Date.now() - ts > REBALANCE_PENDING_STALE_MS) {
        try { unlinkSync(file); } catch {}
        return false;
    }
    return true;
}

/**
 * Wartet bis der Cleanup-Lock freigegeben wurde (für SL-Flow).
 * Wenn Cleanup nicht innerhalb von timeoutMs fertig wird, fährt SL-Flow trotzdem fort.
 * @param {number} timeoutMs – max. Wartezeit (default: 15 Min)
 * @returns {boolean} true = Cleanup fertig; false = Timeout überschritten
 */
export async function waitForCleanupToFinish(timeoutMs = 15 * 60 * 1000) {
    if (!isCleanupRunning()) return true;

    const deadline = Date.now() + timeoutMs;
    const POLL_MS  = 10_000;
    console.log('[sl-lock] Cleanup läuft – warte auf Freigabe…');

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_MS));
        if (!isCleanupRunning()) {
            console.log('[sl-lock] Cleanup freigegeben – SL-Flow startet.');
            return true;
        }
    }

    console.warn(`[sl-lock] Timeout nach ${Math.round(timeoutMs / 60000)} Min – SL-Flow startet trotzdem.`);
    return false;
}
