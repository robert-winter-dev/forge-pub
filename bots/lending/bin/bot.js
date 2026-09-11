#!/usr/bin/env node
/**
 * FORGE LendingBot – Hauptschleife
 *
 * Verantwortlichkeiten:
 *   - APY-Monitoring aller konfigurierten Protokolle (stündlich)
 *   - Telegram-Alert bei TVL-Crossing (900K / 1M)
 *   - Portfolio-Snapshots in DB (stündlich)
 *   - Dashboard-Export + Sync (alle 5 Minuten)
 *   - Graceful Shutdown (SIGTERM / SIGINT)
 *   - PID-Lock (verhindert doppeltes Starten)
 *
 * Starten:
 *   node bin/bot.js
 *   sudo systemctl start forge-lendingbot.service
 *
 * Stoppen:
 *   sudo systemctl stop forge-lendingbot.service
 *   (SIGTERM → graceful shutdown, kein kill -9)
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { execFile }   from 'child_process';
import { promisify }  from 'util';
import { dirname, resolve, join } from 'path';
import { fileURLToPath }    from 'url';

import { config, loadAutoDeployConfig } from '../lib/config.js';
import * as notify from '../lib/notify.js';
import { isUpdateInProgress } from '../lib/notify.js';
import { t } from '../../../lib/i18n.js';
import { KaminoProtocol, /* DriftProtocol (DEAKTIVIERT 2026-04-02), */ LoopscaleProtocol, JupiterLendProtocol,
         createProtocolByName } from '../lib/lending-protocols.js';
import { getSolBalance, getUsdcBalance, loadKeypair, signAndSend, sendUsdc, fetchFeeSol } from '../lib/wallet.js';
import {
    getDb,
    recordProtocolStat,
    getPreviousProtocolStat,
    getProtocolStatNear24h,
    upsertWalletSnapshot,
    getWalletSnapshot,
    recordPortfolioSnapshot,
    prunePortfolioHistory,
    addNotification,
    getActivePositions,
    updatePosition,
    closePosition,
    addPosition,
    addToPosition,
    recordTransaction,
    getTotalDepositsWithdraws,
    getTransactionsByProtocol,
    kvGet, kvSet,
    hasDailySnapshot,
    recordDailySnapshot,
} from '../lib/db.js';
import {
    get72hPoolStats,
    getQualifiedPools,
    checkDataBasis,
    REBALANCER_CONFIG,
} from '../lib/rebalancer.js';
import { loadTvlGuard, loadLiqGuard, isPoolEnabled, disablePool, checkInvestGuards } from '../lib/tvl-guard.js';
import { syncDashboard } from '../lib/sync.js';
import { FORGE_TZ, todayTz } from '../../../core/config.js';
import { PATHS, botPidPath } from '../../../config/paths.js';

const execFileAsync = promisify(execFile);
const __dirname     = dirname(fileURLToPath(import.meta.url));
const EXPORT_SCRIPT = resolve(__dirname, 'export.js');

// ─── Konstanten ───────────────────────────────────────────────────────────────

/** Interval zwischen APY-Checks (aus config, default: 1h) */
const APY_INTERVAL_MS  = config.apyUpdateIntervalMs;

/** Maximaler Jitter vor jedem APY-Tick – verhindert dass alle Calls stets auf dieselbe Sekunde fallen */
const APY_JITTER_MS    = 5 * 60 * 1000;  // bis zu 5 Minuten

/** Dashboard Export + Sync alle 5 Minuten */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** PID-Lock Datei */
const PID_FILE  = botPidPath('lending');

/** Move-Lock: gesetzt während bin/move.js läuft → Auto-Deploy pausieren */
const MOVE_LOCK = join(PATHS.lendingData, 'move.lock');

// ─── SOL-Topup Konstanten ─────────────────────────────────────────────────────
const SOL_MINT          = 'So11111111111111111111111111111111111111112';
const USDC_MINT         = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_TOPUP_TRIGGER = 0.10;  // Unter diesem Wert: USDC → SOL tauschen
const SOL_TOPUP_TARGET  = 0.20;  // Ziel-Guthaben nach dem Swap
const SOL_WARN_TRIGGER  = 0.07;  // Unter diesem Wert: Telegram-Warnung wenn kein USDC vorhanden
const SOL_DECIMALS      = 9;
const USDC_DECIMALS     = 6;
const TOPUP_SLIPPAGE    = 100;   // 1 % Slippage-Toleranz

let lastPruneDay = '';

// ─── PID-Lock ─────────────────────────────────────────────────────────────────

(function acquirePidLock() {
    if (existsSync(PID_FILE)) {
        const existingPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
        if (!isNaN(existingPid)) {
            try {
                process.kill(existingPid, 0); // wirft wenn Prozess nicht existiert
                console.error(`[PID-Lock] Bot ${config.botId} läuft bereits (PID ${existingPid}). Abbruch.`);
                process.exit(1);
            } catch {
                // Veraltete Lock-Datei → überschreiben
            }
        }
    }
    writeFileSync(PID_FILE, String(process.pid), 'utf-8');
    process.on('exit', () => { try { unlinkSync(PID_FILE); } catch { /* ignore */ } });
})();

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${ts}] ${msg}`);
}

function logErr(msg) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.error(`[${ts}] ❌ ${msg}`);
}

// ─── Fehler-Zähler für selbstheilende Fehler ─────────────────────────────────
//
// Für zyklische Abfragen (Balance, APY, Position), die üblicherweise an einem
// kurzen Upstream-/RPC-Hiccup scheitern und sich beim nächsten Tick von selbst
// lösen: ein einzelner Fehlschlag bleibt lokales console.warn, erst ab dem
// 2. Mal in Folge wird eskaliert (console.error + Telegram). Erfolg setzt den
// Zähler zurück. Analog zum etablierten Muster in
// bots/liquidity/bin/bot.js (_openPositionFailCount etc.).
//
// NICHT verwenden für DB-Schreibfehler oder finanzkritische Aktionen (Auto-Exit,
// SOL-Topup, Auto-Deploy) — die müssen weiterhin sofort sichtbar sein.
const _failCounts = new Map();

// ─── Debounce für 0-Balance-Reads (Position schließen) ───────────────────────
//
// Loopscale liefert nach einem frisch bestätigten Deposit gelegentlich noch für
// einen Poll-Zyklus den Pre-Deposit-Stand (0 USDC) zurück (Indexer-Lag). Ohne
// Debounce schließt der Dust-Fallback unten die gerade erst angelegte DB-Position
// fälschlich, obwohl das Geld on-chain angekommen ist (Vorfall 2026-08-02, Ticket
// Loopscale Public 250 USDC). Analog zum Fail-Streak-Muster oben: erst nach
// ZERO_BALANCE_CONFIRM_TICKS aufeinanderfolgenden 0-Reads wirklich schließen.
const _zeroBalanceStreak = new Map();
const ZERO_BALANCE_CONFIRM_TICKS = 2;

// ─── Debounce für Reconciliation (Position wieder anlegen, LEN#0329) ─────────
//
// Spiegelbild des obigen Falls: Nach einem Withdraw kann dieselbe Stale-API
// kurzzeitig noch den PRE-Withdrawal-Stand melden (dokumentiert weiter unten bei
// "isUpwardStale"). Ohne Debounce würde ein ganz normaler, gerade erst
// abgeschlossener Withdraw sofort wieder als "Position wieder aufgetaucht"
// fehlinterpretiert und neu angelegt — mit dem falschen (alten) Betrag als
// Kostenbasis. Gleiches Muster wie oben: erst nach REAPPEAR_CONFIRM_TICKS
// aufeinanderfolgenden Reads mit Guthaben wirklich neu anlegen.
const _reappearStreak = new Map();
const REAPPEAR_CONFIRM_TICKS = ZERO_BALANCE_CONFIRM_TICKS;

function noteFail(key, label, err, { escalateAt = 2 } = {}) {
    const fails = (_failCounts.get(key) ?? 0) + 1;
    _failCounts.set(key, fails);
    // `label` ist ein Katalog-Verweis { k, p } — fürs Log wird er deutsch
    // aufgelöst (Logs sind Betriebsdaten und bleiben einsprachig), für die
    // Meldung geht er unaufgelöst weiter und wird beim Anzeigen übersetzt.
    const labelDe = typeof label === 'string' ? label : t(label.k, label.p, { lang: 'de' });
    if (fails >= escalateAt) {
        logErr(`${labelDe} (${fails}× in Folge): ${err.message}`);
        notify.taskFailed(label, fails, err.message).catch(() => {});
    } else {
        log(`⚠ ${labelDe} transient (${fails}/${escalateAt} – warte auf Bestätigung im nächsten Zyklus): ${err.message}`);
    }
}

function resetFail(key) {
    _failCounts.delete(key);
}

const NEXUS_URL = 'http://127.0.0.1:3100'; // FORGE API Proxy (Jupiter-Quotes für SOL-Topup)

// ─── Protokolle ───────────────────────────────────────────────────────────────

/** Erstellt eine Protokoll-Instanz für einen konfigurierten Pool-Namen. */
function instantiateProtocol(name) {
    // if (name === 'drift')   return new DriftProtocol();  // DEAKTIVIERT 2026-04-02
    if (name === 'jupiter') return new JupiterLendProtocol();
    const kaminoMarket = config.kamino.markets[name];
    if (kaminoMarket) return new KaminoProtocol({
        name,
        label:       kaminoMarket.label,
        market:      kaminoMarket.market,
        usdcReserve: kaminoMarket.reserve,
    });
    const loopscaleVault = config.loopscale.vaults[name];
    if (loopscaleVault) return new LoopscaleProtocol({
        name,
        label:        loopscaleVault.label,
        vaultAddress: loopscaleVault.address,
    });
    return null;
}

/**
 * Erstellt Protokoll-Instanzen für ALLE konfigurierten Pools
 * (LENDING_PROTOCOLS + MONITOR_PROTOCOLS, dedupliziert).
 *
 * Die Qualifikationskriterien (TVL/APY) entscheiden automatisch,
 * welche Pools tatsächlich Kapital erhalten – keine manuelle Trennung nötig.
 */
function buildAllProtocols() {
    const seen   = new Set();
    const protos = [];
    for (const name of [...config.protocols, ...config.monitorProtocols]) {
        if (seen.has(name)) continue;
        seen.add(name);
        const proto = instantiateProtocol(name);
        if (proto) protos.push(proto);
        else logErr(`Unbekanntes Protokoll: ${name} (wird übersprungen)`);
    }
    return protos;
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function fmt(n, decimals = 2) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('de-DE', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

// ─── Alert-Logik ──────────────────────────────────────────────────────────────

const TVL_THRESHOLDS     = [900_000, 1_000_000];
const DUST_THRESHOLD_USDC  = 1.0;  // Positionen unter diesem Betrag gelten als leer (Dust nach Withdraw)
// Schutz gegen veraltete API-Werte nach Withdrawals
// (z.B. Loopscale gibt nach Withdrawal kurzzeitig noch den Pre-Withdrawal-Wert zurück).
// Schwelle ist zeitbasiert: erlaubt akkumulierte Zinsen seit letztem DB-Update (max 20% APY als Puffer),
// mindestens aber MIN_PLAUSIBLE_JUMP pro Tick. Post-Withdrawal-Spikes (250+ USDC) werden weiterhin erkannt.
const MIN_PLAUSIBLE_JUMP   = 1.0;   // absolutes Minimum pro Tick in USDC
const MAX_STALE_APY        = 1.00;  // 100% APY als obere Schranke – unrealistisch für Lending, fängt aber Post-Withdrawal-Spikes (250+ USDC) sicher ab

/**
 * Prüft nach jedem DB-Schreiben:
 *  - Hat die TVL eine der Schwellen (900K / 1M) überschritten oder unterschritten?
 *
 * Muss NACH recordProtocolStat() aufgerufen werden.
 */
async function checkAlerts(proto, currentApy, currentTvl) {
    // Nur Pools mit aktiver Position alarmieren – Monitor-Pools ohne Investment
    // sind für den Betreiber nicht relevant (Ticket 2026-08-18).
    const activeProtocols = new Set(getActivePositions().map(p => p.protocol));
    if (!activeProtocols.has(proto.name)) return;

    // ── TVL-Schwellwert-Crossing ─────────────────────────────────────────────
    if (currentTvl != null) {
        const prev = getPreviousProtocolStat(proto.name);
        if (prev?.tvl != null) {
            for (const threshold of TVL_THRESHOLDS) {
                const tLabel = threshold >= 1_000_000
                    ? `$${(threshold / 1_000_000).toFixed(0)}M`
                    : `$${(threshold / 1_000).toFixed(0)}K`;
                const tvlFmt = currentTvl >= 1e6
                    ? `$${(currentTvl / 1e6).toFixed(2)}M`
                    : `$${(currentTvl / 1e3).toFixed(0)}K`;
                if (prev.tvl < threshold && currentTvl >= threshold) {
                    await notify.tvlAbove(proto.label, tLabel, tvlFmt);
                    addNotification({ level: 'warn', msgKey: 'notify.len.tvl_above_short',
                        params: { pool: proto.label, threshold: tLabel, tvl: tvlFmt } });
                } else if (prev.tvl >= threshold && currentTvl < threshold) {
                    await notify.tvlBelow(proto.label, tLabel, tvlFmt);
                    addNotification({ level: 'warn', msgKey: 'notify.len.tvl_below_short',
                        params: { pool: proto.label, threshold: tLabel, tvl: tvlFmt } });
                }
            }
        }
    }
}

// ─── APY-Check ────────────────────────────────────────────────────────────────

/**
 * Ruft APYs aller Protokolle ab und schreibt sie in die DB.
 */
async function checkApys(protocols) {
    const apyMap = new Map();

    for (const proto of protocols) {
        let apy, tvl = null, liquidity = null;
        try {
            // getPoolStats() liefert APY + TVL + Liquidität in einem Call (falls implementiert)
            if (typeof proto.getPoolStats === 'function') {
                const stats = await proto.getPoolStats();
                apy = stats.apy;
                tvl = stats.tvl ?? null;
                liquidity = stats.liquidity ?? null;
            } else {
                apy = await proto.getSupplyAPY();
            }
            const tvlStr = tvl != null
                ? ` | TVL: $${tvl >= 1e6 ? (tvl / 1e6).toFixed(1) + 'M' : tvl >= 1e3 ? (tvl / 1e3).toFixed(0) + 'K' : tvl.toFixed(0)}`
                : '';
            const liqStr = liquidity != null
                ? ` | frei: ${liquidity >= 1e6 ? (liquidity / 1e6).toFixed(1) + 'M' : liquidity >= 1e3 ? (liquidity / 1e3).toFixed(0) + 'K' : liquidity.toFixed(2)} USDC`
                : '';
            log(`APY ${proto.label}: ${fmt(apy, 2)} %${tvlStr}${liqStr}`);
            apyMap.set(proto.name, apy);
            resetFail(`apy:${proto.name}`);
        } catch (err) {
            noteFail(`apy:${proto.name}`, { k: 'notify.len.task_apy', p: { pool: proto.label } }, err);
            continue;
        }

        // In DB speichern (inkl. TVL + sofort abhebbarer Liquidität)
        try {
            recordProtocolStat({
                protocol: proto.name,
                poolType: proto.poolType ?? proto.name,
                apy,
                tvl,
                liquidity,
            });
        } catch (err) {
            logErr(`DB recordProtocolStat (${proto.name}): ${err.message}`);
        }

        // Alerts: TVL-Crossing + APY-Änderung ≥ 0,5%
        try {
            await checkAlerts(proto, apy, tvl);
        } catch (err) {
            logErr(`Alert-Check (${proto.name}): ${err.message}`);
        }

    }
    return apyMap;
}

// ─── Auto-Exit (TVL- / Liquiditäts-Schutz) ────────────────────────────────────

/**
 * Prüft alle aktiven Positionen auf Unterschreitung einer der beiden
 * Schutzschwellen: Markt-TVL (tvlGuard) oder sofort abhebbare Liquidität
 * (liqGuard). Greift eine davon, wird sofort zu 100 % abgezogen — unabhängig
 * vom Rebalancing-Cooldown.
 *
 * Das freigewordene Kapital kehrt ins Wallet zurück. Beim TVL-Schutz wird der
 * Pool zusätzlich deaktiviert (poolEnabled=false) — er nimmt danach an KEINEM
 * Deposit-Weg mehr teil (weder manuell noch Auto-Deploy), bis der Nutzer ihn im
 * Settings-UI bewusst wieder aktiviert.
 *
 * Beim Liquiditäts-Schutz bewusst NICHT: Liquidität schwankt mit jeder
 * Kreditrückzahlung und kommt von selbst zurück. Solange sie unter der Schwelle
 * liegt, ist der Pool ohnehin von "Bester Pool" ausgeschlossen
 * (lib/rebalancer.js getQualifiedPools) — eine dauerhafte Deaktivierung mit
 * manueller Reaktivierung wäre hier reine Handarbeit ohne Zusatznutzen.
 *
 * Pools OHNE offene Position, deren TVL unter der Schwelle liegt, werden aus
 * demselben Grund deaktiviert (kein Withdraw nötig, nichts investiert). Auch das
 * gilt nur für den TVL-Schutz.
 */
async function checkAndAutoExit(allProtocols, walletAddress) {
    if (existsSync(MOVE_LOCK)) {
        log('Auto-Exit pausiert (move.lock aktiv)');
        return;
    }

    const stats72h         = get72hPoolStats();
    const activePositions  = getActivePositions();
    const activeProtocols  = new Set(activePositions.map(p => p.protocol));

    // Protokolle mit aktiver Position UND unterschrittener Schutzschwelle ermitteln.
    // Schwellen + Versand-Adressen kommen pro Protokoll aus settings.db (ForgeSettings).
    //
    // 🔒 null heißt "nicht gemessen", nicht "0": ein fehlender Messwert (API liefert
    // die Kennzahl (noch) nicht) darf niemals einen Abzug auslösen.
    //
    // Reihenfolge: TVL-Schutz vor Liquiditäts-Schutz. Greifen beide, gewinnt der
    // TVL-Schutz — er ist der schärfere Fall (Pool wird zusätzlich deaktiviert).
    const exitInfo = new Map(); // protocol → { metric, threshold, value, sendTo }
    for (const pos of activePositions) {
        const stats = stats72h.get(pos.protocol);
        const tvl   = stats?.tvl       ?? null;
        const liq   = stats?.liquidity ?? null;

        const tvlGuard = loadTvlGuard(pos.protocol);
        if (tvl !== null && tvlGuard.enabled && tvlGuard.thresholdUsd > 0 && tvl < tvlGuard.thresholdUsd) {
            exitInfo.set(pos.protocol, {
                metric: 'tvl', threshold: tvlGuard.thresholdUsd, value: tvl, sendTo: tvlGuard.sendTo,
            });
            continue;
        }

        const liqGuard = loadLiqGuard(pos.protocol);
        if (liq !== null && liqGuard.enabled && liqGuard.thresholdUsd > 0 && liq < liqGuard.thresholdUsd) {
            exitInfo.set(pos.protocol, {
                metric: 'liquidity', threshold: liqGuard.thresholdUsd, value: liq, sendTo: liqGuard.sendTo,
            });
        }
    }

    // Protokolle OHNE Position, aber ebenfalls unter der Schwelle und noch
    // aktiviert → nur deaktivieren, kein Withdraw nötig (nichts investiert).
    for (const proto of allProtocols) {
        if (activeProtocols.has(proto.name)) continue; // oben bereits behandelt
        const stats = stats72h.get(proto.name);
        const tvl   = stats?.tvl ?? null;
        if (tvl === null) continue;
        const guard = loadTvlGuard(proto.name);
        if (!guard.enabled || !(guard.thresholdUsd > 0) || tvl >= guard.thresholdUsd) continue;
        if (!isPoolEnabled(proto.name)) continue; // bereits deaktiviert
        disablePool(proto.name);
        log(`Pool automatisch deaktiviert (kein Investment, TVL unter Schwelle): ${proto.name}`);
    }

    if (exitInfo.size === 0) return;

    const keypair = loadKeypair();

    for (const [protocolName, guard] of exitInfo) {
        const exitThreshold = guard.threshold;
        const isLiq         = guard.metric === 'liquidity';
        const metricLabel   = isLiq ? 'Liquidität' : 'TVL';
        // Für die Meldung: der Messwert, der den Exit ausgelöst hat (TVL oder Liquidität)
        const tvlFmt = guard.value != null
            ? (guard.value >= 1e6 ? `$${(guard.value / 1e6).toFixed(2)}M` : `$${(guard.value / 1e3).toFixed(0)}K`)
            : '—';
        log(`⚠️ Auto-Exit: ${protocolName} ${metricLabel} ${tvlFmt} < $${(exitThreshold / 1_000).toFixed(0)}K → Withdraw`);

        try {
            const proto  = createProtocolByName(protocolName);
            const result = await proto.buildWithdrawTx(walletAddress, 'all');
            const txSig  = await signAndSend(
                result.transaction, keypair,
                { preserveBlockhash: result.preserveBlockhash ?? false }
            );

            // Aktive DB-Positionen schließen
            const toClose   = activePositions.filter(p => p.protocol === protocolName);
            const exitAmount = toClose.reduce((s, p) => s + (p.amount ?? 0), 0);
            toClose.forEach(p => closePosition(p.id));

            // Pool deaktivieren – ab jetzt keine Deposits mehr (manuell + Auto-Deploy),
            // bis der Nutzer im Settings-UI bewusst wieder aktiviert. Nur beim
            // TVL-Schutz: der Liquiditäts-Schutz sperrt nur solange die Liquidität
            // tatsächlich zu dünn ist (siehe Kopfkommentar).
            if (!isLiq) disablePool(protocolName);

            const fee = await fetchFeeSol(txSig);
            recordTransaction({
                type:     'withdraw',
                protocol: protocolName,
                poolType: 'lending',
                amount:   exitAmount,
                txHash:   txSig,
                feeSol:   fee,
                note:     `Auto-Exit: ${metricLabel} ${tvlFmt} unter $${(exitThreshold / 1_000).toFixed(0)}K`,
            });

            log(`Auto-Exit ✅ ${protocolName}: ${fmt(exitAmount)} USDC → TX ${txSig}`);

            // Ungestakte LP-Reste erkennen (nur Loopscale) – siehe
            // LoopscaleProtocol.checkLeftoverLp() in lib/lending-protocols.js für Hintergrund.
            // Auto-Exit withdrawt zwar immer 'all', ob eine Vollauszahlung genauso betroffen
            // sein kann wie die beobachteten Teilauszahlungen ist ungeklärt – daher auch hier
            // sicherheitshalber geprüft.
            let leftoverLpAmount = null;
            let leftoverLpUsdc   = null;
            if (proto instanceof LoopscaleProtocol) {
                const leftoverLp = await proto.checkLeftoverLp(walletAddress);
                if (leftoverLp) {
                    const usdcStr = leftoverLp.estimatedUsdc != null ? ` (~${fmt(leftoverLp.estimatedUsdc)} USDC)` : '';
                    leftoverLpAmount = leftoverLp.lpAmount.toFixed(6);
                    leftoverLpUsdc   = usdcStr;   // " (~12,34 USDC)" oder "" – sprachneutral
                    logErr(`Auto-Exit ${protocolName}: LP-Reste zurückgeblieben – ${leftoverLp.lpAmount.toFixed(6)}${usdcStr}`);
                }
            }

            // Optionaler Versand an externe Adresse (echter Ausstieg statt Wallet/Reinvest).
            // Adresse pro Protokoll aus settings.db. Betrag auf tatsächliche Wallet-Balance
            // begrenzt (Yield/Slippage-Abweichung → kein InsufficientFunds).
            let sentToAddr    = null;
            let sentAmountFmt = null;
            let sentTxSig     = null;
            const sendTo = guard.sendTo;
            if (sendTo) {
                try {
                    const walletUsdc     = await getUsdcBalance(walletAddress);
                    const transferAmount = Math.min(exitAmount, walletUsdc);
                    if (transferAmount > 0) {
                        const sendSig = await sendUsdc(keypair, sendTo, transferAmount);
                        sentToAddr    = sendTo;
                        sentAmountFmt = fmt(transferAmount);
                        sentTxSig     = sendSig;
                        log(`Auto-Exit Versand ✅ ${fmt(transferAmount)} USDC → ${sendTo} (TX ${sendSig})`);
                    } else {
                        log(`Auto-Exit Versand übersprungen: Wallet-USDC = ${fmt(walletUsdc)}`);
                    }
                } catch (sendErr) {
                    logErr(`Auto-Exit Versand fehlgeschlagen (${protocolName}): ${sendErr.message}`);
                    await notify.autoExitSendFailed(protocolName, sendErr.message);
                    addNotification({ level: 'warn', msgKey: 'notify.len.auto_exit_send_failed_short',
                        params: { pool: protocolName, message: sendErr.message } });
                }
            }

            await notify.autoExitExecuted(protocolName, {
                metric:    isLiq ? { k: 'notify.len.metric_liquidity' } : { k: 'notify.len.metric_tvl' },
                tvl:       tvlFmt,
                threshold: `$${(exitThreshold / 1_000).toFixed(0)}K`,
                amount:    fmt(exitAmount),
                tx:        txSig,
                sentTo:    sentToAddr,
                sentAmount: sentAmountFmt,
                sentTx:    sentTxSig,
                leftoverLp:   leftoverLpAmount,
                leftoverUsdc: leftoverLpUsdc,
            });
            addNotification({ level: 'error', msgKey: 'notify.len.auto_exit_short',
                params: { pool: protocolName, amount: fmt(exitAmount), tvl: tvlFmt,
                          metric: isLiq ? { k: 'notify.len.metric_liquidity' } : { k: 'notify.len.metric_tvl' } } });
        } catch (err) {
            // Betriebs-Kanäle (Log/Telegram) bekommen bewusst die technischen Rohdaten
            // (falls vorhanden) statt der nutzerfreundlichen Meldung aus wallet.js
            // simulate() – hier braucht es die Diagnose, nicht die Beruhigung.
            const detail = err.technicalDetail ?? err.message;
            logErr(`Auto-Exit fehlgeschlagen (${protocolName}): ${detail}`);
            await notify.autoExitFailed(protocolName, tvlFmt, detail,
                isLiq ? { k: 'notify.len.metric_liquidity' } : { k: 'notify.len.metric_tvl' });
            addNotification({ level: 'warn', msgKey: 'notify.len.auto_exit_failed_short',
                params: { pool: protocolName, message: detail } });
        }
    }
}

// ─── Tagesanfangs-Snapshot (für statistics.today) ────────────────────────────

/**
 * Schreibt einmalig pro Kalendertag (Berlin-Zeit) die aktuellen positions.amount-
 * Werte in daily_position_snapshots. positions.amount steigt monoton (on-chain
 * akkumuliert, kein API-Rauschen) → Delta current − snapshot ergibt den Tages-Yield
 * ohne portfolio_history-Rauschen (Ticket #5).
 *
 * Idempotent: hasDailySnapshot prüft vor dem Schreiben. Kein doppelter Eintrag möglich.
 */
function maybeRecordDailyPositionSnapshot() {
    const today     = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ }).format(new Date());
    if (hasDailySnapshot(today)) return;

    const positions = getActivePositions();
    if (positions.length === 0) return;  // Bot noch nicht deployed

    // Duplikat-Protokolle zusammenführen (analog zu export.js) – max(amount)
    const merged = new Map();
    for (const p of positions) {
        if (!merged.has(p.protocol) || p.amount > merged.get(p.protocol).amount) {
            merged.set(p.protocol, p);
        }
    }

    recordDailySnapshot(today, [...merged.values()]);
    log(`Tages-Snapshot: ${merged.size} Protokoll(e) für ${today} gespeichert`);
}

// ─── Portfolio-Snapshot ───────────────────────────────────────────────────────

/**
 * Aktuelle Positionen + SOL-Balance abfragen und als Snapshot in DB schreiben.
 */
async function takePortfolioSnapshot(protocols, walletAddress, apyMap = new Map()) {
    let totalValue = 0;
    let solBalance = 0;
    let usdcBalance = 0;

    // SOL- und USDC-Balance direkt aus Wallet
    try {
        solBalance = await getSolBalance(walletAddress);
        resetFail('sol-balance');
    } catch (err) {
        noteFail('sol-balance', { k: 'notify.len.task_sol_balance' }, err);
    }
    try {
        usdcBalance = await getUsdcBalance(walletAddress);
        resetFail('usdc-balance');
    } catch (err) {
        noteFail('usdc-balance', { k: 'notify.len.task_usdc_balance' }, err);
    }

    // Positionen aus API abfragen und summieren
    let totalYield = 0;
    for (const proto of protocols) {
        // Ein deaktivierter Pool (Nutzer-Freigabe entzogen oder TVL-Schutz ausgelöst)
        // steuert NICHTS mehr zum Positionswert bei — auch kein Restguthaben, das die
        // Protokoll-API noch meldet. Grund: Deaktivieren ist nur möglich, wenn der Pool
        // kein Kapital mehr hält (UI: hasProtocolCapital() blockiert es, Auto-Exit:
        // disablePool() läuft erst nach erfolgreichem Withdraw). Was danach noch auftaucht,
        // ist kein abrufbares Guthaben, sondern ein Rest — z.B. ungestakte LP-Token oder
        // eine Fehlanzeige des Protokoll-Indexers. Zählte er mit, erschiene er als Gewinn
        // im PnL, ohne dass eine Position dazu existiert, die ihn in den Metriken erklärt.
        // Umkehrbar: Pool wieder freigeben → der Wert zählt ab dem nächsten Tick wieder mit.
        const poolEnabled = isPoolEnabled(proto.name);
        try {
            const pos = await proto.getPosition(walletAddress);
            resetFail(`position:${proto.name}`);

            // Defensiver Fallback: wenn On-Chain-Balance = 0, null oder Dust (<1 USDC) →
            // alle aktiven DB-Positionen schließen (verhindert fake Yield nach Withdrawal).
            // Debounce: erst schließen, wenn der 0-Wert ZERO_BALANCE_CONFIRM_TICKS mal in
            // Folge bestätigt wurde (fängt API-Lag direkt nach einem Deposit ab).
            if (!pos || pos.amount < DUST_THRESHOLD_USDC) {
                const stale = getActivePositions().filter(p => p.protocol === proto.name);
                if (stale.length > 0) {
                    const streakKey = `zero:${proto.name}`;
                    const streak = (_zeroBalanceStreak.get(streakKey) ?? 0) + 1;
                    _zeroBalanceStreak.set(streakKey, streak);
                    const dustInfo = pos?.amount > 0 ? ` (${fmt(pos.amount)} USDC Dust ignoriert)` : '';

                    if (streak < ZERO_BALANCE_CONFIRM_TICKS) {
                        if (poolEnabled) totalValue += stale.reduce((sum, p) => sum + p.amount, 0);
                        log(`⚠ Position ${proto.label}: 0 USDC${dustInfo} – ${streak}/${ZERO_BALANCE_CONFIRM_TICKS}, evtl. staler API-Response (z.B. nach Deposit), DB-Position vorerst behalten`);
                    } else {
                        // Buchwert VOR dem Schließen festhalten: verschwindet hier echtes
                        // Kapital (kein Withdraw, das Protokoll meldet die Position schlicht
                        // nicht mehr), muss das gemeldet werden. Am 09.08.2026 fielen so
                        // 70,61 USDC lautlos aus der Bilanz – nur diese eine Log-Zeile, keine
                        // Benachrichtigung; der Betrag tauchte erst Wochen später beim
                        // Nachrechnen als PnL-Ausreißer auf.
                        const lostUsdc = stale.reduce((sum, p) => sum + (p.amount ?? 0), 0);
                        stale.forEach(p => closePosition(p.id));
                        _zeroBalanceStreak.delete(streakKey);
                        log(`Position ${proto.label}: 0 USDC${dustInfo} (${stale.length} DB-Position(en) geschlossen)`);

                        // Schwelle = DUST_THRESHOLD_USDC: darunter ist das Schließen der
                        // Normalfall nach einem vollständigen Withdraw (Rundungsreste), keine
                        // Meldung wert.
                        if (lostUsdc >= DUST_THRESHOLD_USDC) {
                            log(`🚨 ${proto.label}: ${fmt(lostUsdc)} USDC Buchwert ohne Withdraw verschwunden`);
                            await notify.positionVanished(proto.label, fmt(lostUsdc));
                            addNotification({
                                level: 'error', msgKey: 'notify.len.position_vanished_short',
                                params: { pool: proto.label, amount: fmt(lostUsdc) },
                            });
                        }
                    }
                }
            } else {
                _zeroBalanceStreak.delete(`zero:${proto.name}`);
            }

            if (pos && pos.amount >= DUST_THRESHOLD_USDC) {
                if (poolEnabled) {
                    totalValue += pos.amount;
                    log(`Position ${proto.label}: ${fmt(pos.amount)} USDC`);
                } else {
                    log(`Position ${proto.label}: ${fmt(pos.amount)} USDC – Pool deaktiviert, zählt nicht zum Positionswert`);
                }

                // DB-Position aktualisieren: aktueller Betrag (für Yield-Berechnung) + APY
                const currentApy = apyMap.get(proto.name) ?? null;
                const dbPositions = getActivePositions().filter(p => p.protocol === proto.name);

                // Reconciliation (LEN#0329): Protokoll meldet Kapital, DB kennt aber keine
                // aktive Position (z.B. weil ein manueller Re-Stake nach einem stillen
                // Schließen den normalen Deposit-Pfad nicht durchlaufen hat, siehe
                // Loopscale-Fall forge-pub1 09.–18.08.2026). Ohne diesen Zweig bliebe die
                // Position dauerhaft unsichtbar in DB/Dashboard, obwohl sie in `totalValue`
                // oben bereits mitgezählt wird. Kostenbasis = aktueller Wert (kein
                // rückwirkender Fake-Gewinn/-Verlust) — die reale Historie davor ist nicht
                // rekonstruierbar, siehe Rückfrage/Entscheidung 2026-09-02.
                if (dbPositions.length === 0) {
                    const streakKey = `reappear:${proto.name}`;
                    const streak = (_reappearStreak.get(streakKey) ?? 0) + 1;
                    _reappearStreak.set(streakKey, streak);

                    if (streak < REAPPEAR_CONFIRM_TICKS) {
                        log(`⚠ Position ${proto.label}: ${fmt(pos.amount)} USDC on-chain ohne aktive DB-Position – ${streak}/${REAPPEAR_CONFIRM_TICKS}, evtl. staler API-Response nach Withdraw, warte ab`);
                    } else {
                        // addPosition (= openPosition) kennt kein entryValue — die Kostenbasis
                        // muss per updatePosition() auf die neu angelegte Zeile nachgezogen werden.
                        const inserted = addPosition({
                            protocol: proto.name,
                            poolType: proto.poolType ?? 'lending',
                            asset:    'USDC',
                            amount:   pos.amount,
                        });
                        updatePosition(inserted.lastInsertRowid, { amount: pos.amount, currentApy, entryValue: pos.amount });
                        _reappearStreak.delete(streakKey);
                        log(`♻️  Position ${proto.label}: ${fmt(pos.amount)} USDC on-chain, aber keine aktive DB-Position – automatisch neu angelegt (Kostenbasis = aktueller Wert)`);
                        await notify.positionReconciled(proto.label, fmt(pos.amount));
                        addNotification({
                            level: 'info', msgKey: 'notify.len.position_reconciled_short',
                            params: { pool: proto.label, amount: fmt(pos.amount) },
                        });
                    }
                } else {
                    _reappearStreak.delete(`reappear:${proto.name}`);
                }

                for (const dbPos of dbPositions) {
                    try {
                        // Stale-API-Schutz in beide Richtungen:
                        //
                        // ↑ Zu hoher Wert: z.B. Loopscale gibt nach Withdrawal kurzzeitig Pre-Withdrawal-
                        //   Wert zurück. Schwelle = zeitbasierter Zinspuffer + Deposits der letzten 24h
                        //   (damit echte Deposit-Anstiege nicht als stale eingestuft werden).
                        //
                        // ↓ Zu niedriger Wert: API liefert kurzzeitig Pre-Deposit-Wert zurück, nachdem
                        //   ein Deposit on-chain bestätigt wurde. Ohne diesen Schutz würde der korrekte
                        //   DB-Wert (nach addToPosition) mit dem stalen niedrigen API-Wert überschrieben,
                        //   was anschließend den ↑-Schutz dauerhaft triggert.
                        const prevAmount = dbPos.amount ?? 0;
                        const elapsedDays = (Date.now() - (dbPos.last_updated_at ?? Date.now())) / 86_400_000;

                        // Alle Deposits der letzten 24h in die Schwelle einrechnen –
                        // echte Balance-Anstiege durch Einzahlungen werden so nicht blockiert.
                        const DEPOSIT_LOOKBACK_MS = 24 * 3_600_000;
                        const recentDepositSum = getTransactionsByProtocol(proto.name, Date.now() - DEPOSIT_LOOKBACK_MS)
                            .filter(tx => tx.type === 'deposit')
                            .reduce((sum, tx) => sum + tx.amount, 0);

                        const maxPlausibleJump = Math.max(MIN_PLAUSIBLE_JUMP, elapsedDays * MAX_STALE_APY / 365 * prevAmount)
                            + recentDepositSum;

                        const isUpwardStale   = pos.amount > prevAmount + maxPlausibleJump;
                        const isDownwardStale = pos.amount < prevAmount - MIN_PLAUSIBLE_JUMP;

                        if (isUpwardStale || isDownwardStale) {
                            const dir = isUpwardStale ? `> DB ${fmt(prevAmount)} + ${fmt(maxPlausibleJump, 2)}` : `< DB ${fmt(prevAmount)} - ${fmt(MIN_PLAUSIBLE_JUMP, 2)}`;
                            log(`⚠ ${proto.label}: API-Wert ${fmt(pos.amount)} USDC ${dir} – staler API-Response vermutet, DB-Wert beibehalten`);
                            totalValue -= pos.amount;   // wurde oben schon addiert – korrigieren
                            totalValue += prevAmount;
                        } else {
                            // ── Einstiegs-Anker fortschreiben ────────────────────────
                            // Protokolle bewerten frisch eingezahltes Kapital sofort über
                            // pari (Loopscale: +0,103 % binnen Minuten, ohne Zeitablauf).
                            // Dieser Aufschlag ist kein Ertrag — er wird beim Ausstieg nicht
                            // realisiert. Deshalb zählt als Kostenbasis nicht der nominale
                            // Einzahlbetrag, sondern der danach tatsächlich GEMESSENE Wert.
                            //
                            // `prevAmount` enthält bereits den Nominalbetrag (openPosition /
                            // addToPosition schreiben ihn sofort). Der Positionswert vor dem
                            // Cashflow ist also prevAmount − netFlow; der reale Zuwachs ist
                            // die Differenz des ersten danach gemessenen API-Werts dazu:
                            //
                            //   entry_value += pos.amount − prevAmount + netFlow
                            //
                            // Beispiel forge-pub1, 2. Deposit über 5 USDC:
                            //   prev 25,020636 | API 25,025917 | netFlow +5
                            //   → Basis += 25,025917 − 25,020636 + 5 = 5,005281 (statt 5,00)
                            let entryValue = null;
                            const anchoredAt = dbPos.entry_valued_at;

                            // Beim allerersten Anker zählt der eröffnende Deposit mit (`>=`),
                            // danach nur noch echte Zuflüsse NACH der letzten Bewertung (`>`).
                            // Wichtig: openPosition() und der transactions-Eintrag entstehen
                            // im selben Vorgang, ihre Zeitstempel liegen wenige Millisekunden
                            // auseinander (gemessen: 63 ms) — ein reines `>` gegen started_at
                            // würde den eröffnenden Deposit verschlucken und die Position
                            // dauerhaft ohne Anker lassen.
                            const since = anchoredAt ?? dbPos.started_at;
                            const netFlow = getTransactionsByProtocol(proto.name, since)
                                .filter(tx => (tx.type === 'deposit' || tx.type === 'withdraw')
                                           && (anchoredAt == null ? tx.created_at >= since
                                                                  : tx.created_at >  since))
                                .reduce((s, tx) => s + (tx.type === 'deposit' ? tx.amount : -tx.amount), 0);

                            if (netFlow !== 0) {
                                // Bisherige Basis: der gepflegte Anker. Fehlt er (Position
                                // älter als die Migration, ohne brauchbaren Snapshot), ist
                                // die nominale Einzahlungssumme ohne den aktuellen Cashflow
                                // der beste verfügbare Schätzer — die alte Methode also,
                                // aber ab jetzt sauber fortgeschrieben.
                                const priorBasis = dbPos.entry_value ?? (
                                    getTransactionsByProtocol(proto.name, dbPos.started_at)
                                        .filter(tx => tx.type === 'deposit' || tx.type === 'withdraw')
                                        .reduce((s, tx) => s + (tx.type === 'deposit' ? tx.amount : -tx.amount), 0)
                                    - netFlow
                                );
                                entryValue = priorBasis + (pos.amount - prevAmount + netFlow);
                                log(`  ${proto.label}: Einstiegs-Anker ${fmt(entryValue)} USDC `
                                  + `(Cashflow ${netFlow >= 0 ? '+' : ''}${fmt(netFlow)} nominal, `
                                  + `Bewertungsaufschlag ${fmt(pos.amount - prevAmount, 6)})`);
                            }

                            updatePosition(dbPos.id, { amount: pos.amount, currentApy, entryValue });
                        }
                    } catch (err) {
                        logErr(`DB updatePosition (${proto.name}): ${err.message}`);
                    }
                }
            }
        } catch (err) {
            // Fallback: aktive Positionen aus DB
            const dbPositions = getActivePositions().filter(p => p.protocol === proto.name);
            if (poolEnabled && dbPositions.length > 0) {
                totalValue += Math.max(...dbPositions.map(p => p.amount ?? 0));
            }
            noteFail(`position:${proto.name}`, { k: 'notify.len.task_position', p: { pool: proto.label } }, err);
        }
    }

    // Gesamtguthaben = Wallet-USDC + Pool-Positionen
    const totalGuthaben = usdcBalance + totalValue;
    try {
        // totalValue (ohne Wallet) ist die Wertreihe für die PnL-Berechnung —
        // siehe Migration positions_value in lib/db.js.
        recordPortfolioSnapshot(totalGuthaben, null, totalValue);
        log(`Guthaben-Snapshot: ${fmt(usdcBalance)} USDC (Wallet) + ${fmt(totalValue)} USDC (Pools) = ${fmt(totalGuthaben)} USDC`);
    } catch (err) {
        logErr(`DB recordPortfolioSnapshot: ${err.message}`);
    }

    // Tagesanfangs-Snapshot: einmal pro Kalendertag (Berlin), rauschfreie Basis für statistics.today
    try {
        maybeRecordDailyPositionSnapshot();
    } catch (err) {
        logErr(`DB maybeRecordDailyPositionSnapshot: ${err.message}`);
    }

    // DB-Bereinigung: einmal täglich
    const todayStr = todayTz();                             // FORGE_TZ-basiert statt UTC
    if (todayStr !== lastPruneDay) {
        try { prunePortfolioHistory(90); } catch (err) { logErr(`prunePortfolioHistory: ${err.message}`); }
        lastPruneDay = todayStr;
    }

    // Wallet-Snapshot speichern (auch beim ersten Start)
    try {
        const snap = getWalletSnapshot();

        // Gesamtyield = aktueller Poolwert minus netto-investiertes Kapital aus allen Transaktionen.
        const txTotals     = getTotalDepositsWithdraws();
        const netInvested  = (txTotals?.total_deposits ?? 0) - (txTotals?.total_withdraws ?? 0);
        const computedYield = Math.max(0, totalValue - netInvested);

        upsertWalletSnapshot({
            currentValue: totalValue || snap?.current_value || 0,
            totalYield:   computedYield,
            avgApy:       snap?.avg_apy ?? 0,
            walletUsdc:   usdcBalance,
            walletSol:    solBalance,
        });
        log(`Wallet: ${fmt(solBalance, 4)} SOL | ${fmt(usdcBalance)} USDC`);
    } catch (err) {
        logErr(`DB upsertWalletSnapshot: ${err.message}`);
    }

    return usdcBalance;
}

// ─── Dashboard Export ─────────────────────────────────────────────────────────

async function runExport() {
    try {
        await execFileAsync(process.execPath, [EXPORT_SCRIPT], {
            env:     process.env,
            timeout: 30_000,
        });
        log('Dashboard: data.json exportiert');
    } catch (err) {
        logErr(`Dashboard Export fehlgeschlagen: ${err.stderr ?? err.message}`);
    }
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

async function runSync() {
    if (!config.syncTarget?.trim()) return;
    try {
        await syncDashboard(config.syncTarget, config.syncSshPort, log);
        log(`Dashboard: → ${config.syncTarget}`);
    } catch (err) {
        logErr(`Dashboard Sync fehlgeschlagen: ${err.message}`);
    }
}

// ─── Auto-Deploy neuer Wallet-Mittel ──────────────────────────────────────────

const KV_AUTO_DEPLOY_LAST_WALLET = 'auto_deploy_last_wallet';
const MIN_DEPLOY_USDC            = 1.0; // Mindestbetrag, ab dem auto-deployed wird

/**
 * Erkennt neues USDC im Wallet und deployed es automatisch per computeDepositPlan.
 *
 * Beim ersten Start nach Bot-Neustart wird nur der letzte Wallet-Stand gesetzt – kein Deploy,
 * damit bereits liegendes USDC nicht unerwartet investiert wird.
 */
async function checkAndDeployNewFunds(walletUsdc, walletAddress) {
    // 🔴 bot_paused wurde bisher NUR von emergency-withdraw.js gesetzt, aber nirgends
    // gelesen (gefunden 2026-08-04) — ein Emergency-Exit hätte das frisch abgezogene
    // Kapital beim nächsten Sync-Intervall (5 Min) klaglos wieder deployt, sobald der
    // Service danach neu gestartet wurde. Analog zum bereits bestehenden
    // move.lock-Guard direkt darüber.
    if (kvGet('bot_paused') === 'true') {
        log(`Auto-Deploy pausiert (bot_paused: ${kvGet('bot_paused_reason') ?? 'unbekannt'})`);
        return;
    }
    if (existsSync(MOVE_LOCK)) { log('Auto-Deploy pausiert (move.lock aktiv)'); return; }

    // Frisch aus .env lesen – wirkt sofort ohne Bot-Neustart
    const adCfg = loadAutoDeployConfig();
    const mode  = adCfg.autoDeployMode;
    if (mode === 'disabled') {
        log('Auto-Deploy deaktiviert (Modus: disabled)');
        return;
    }

    log(`Auto-Deploy aktiv (Modus: ${mode}) – prüfe auf neue Mittel …`);
    const lastStr = kvGet(KV_AUTO_DEPLOY_LAST_WALLET);

    // Erster Start: letzten Wallet-Stand merken, kein Deploy
    if (lastStr === null) {
        kvSet(KV_AUTO_DEPLOY_LAST_WALLET, String(walletUsdc));
        log(`Auto-Deploy: letzter Wallet-Stand gesetzt (${fmt(walletUsdc)} USDC)`);
        return;
    }

    const lastKnown = parseFloat(lastStr);
    // Floor auf 2 Dezimalstellen → verhindert Gleitkomma-Überhang bei Deposits
    const newFunds  = Math.floor((walletUsdc - lastKnown) * 100) / 100;

    if (newFunds < MIN_DEPLOY_USDC) {
        if (walletUsdc < lastKnown) {
            // Wallet ist kleiner als zuletzt bekannt → manuelle Aktion außerhalb des Bots.
            // Auf 0 zurücksetzen, damit der aktuelle Wallet-Betrag beim nächsten Tick
            // als neue Mittel erkannt und deployed wird.
            kvSet(KV_AUTO_DEPLOY_LAST_WALLET, '0');
            log(`Auto-Deploy: Wallet ${fmt(walletUsdc)} USDC < letzter Stand ${fmt(lastKnown)} USDC – auf 0 zurückgesetzt`);
        } else {
            kvSet(KV_AUTO_DEPLOY_LAST_WALLET, String(walletUsdc));
            log(`Auto-Deploy: keine neuen Mittel (Wallet ${fmt(walletUsdc)} USDC, letzter Stand ${fmt(lastKnown)} USDC)`);
        }
        return;
    }

    // Minimale Einzahlung – modus-abhängig; Baseline NICHT verschieben damit USDC akkumuliert
    const minDeposit = mode.startsWith('protocol:')
        ? adCfg.fixedAutoDeployMinDeposit
        : adCfg.autoDeployMinDeposit;
    if (minDeposit > 0 && newFunds < minDeposit) {
        log(`Auto-Deploy: ${fmt(newFunds)} USDC < Minimum ${fmt(minDeposit)} USDC – akkumuliere (Baseline bleibt bei ${fmt(lastKnown)} USDC)`);
        return;
    }

    // Maximale Einzahlung/Lauf – modus-abhängig, wie schon bei der Minimalen
    const maxDeposit  = mode.startsWith('protocol:')
        ? adCfg.fixedAutoDeployMaxDeposit
        : adCfg.autoDeployMaxDeposit;
    const deployFunds = maxDeposit > 0 ? Math.min(newFunds, maxDeposit) : newFunds;

    if (deployFunds < newFunds) {
        log(`💰 Neue Mittel erkannt: +${fmt(newFunds)} USDC, gedeckelt auf ${fmt(deployFunds)} USDC (Maximale Einzahlung ${fmt(maxDeposit)} USDC) → Auto-Deposit wird ausgeführt`);
    } else {
        log(`💰 Neue Mittel erkannt: +${fmt(deployFunds)} USDC → Auto-Deposit wird ausgeführt`);
    }

    // Baseline nur um den tatsächlich deployten Betrag vorwärts bewegen,
    // damit ggf. verbleibende Mittel (nicht deployt oder durch das Limit gedeckelt)
    // beim nächsten Tick erneut erkannt werden
    kvSet(KV_AUTO_DEPLOY_LAST_WALLET, String(lastKnown + deployFunds));

    // ── Deposit-Plan je nach Modus ────────────────────────────────────────────
    let plan;

    if (mode.startsWith('protocol:')) {
        const protocolId = mode.slice('protocol:'.length);
        try {
            createProtocolByName(protocolId); // Verfügbarkeits-Check
        } catch {
            log(`⚠️  Auto-Deploy: Protokoll "${protocolId}" nicht verfügbar – übersprungen`);
            await notify.autoDeploySkippedUnavailable(protocolId);
            return;
        }
        // Pool-Freigabe prüfen – vom Nutzer deaktiviert oder durch TVL-Schutz
        // automatisch deaktiviert (siehe checkAndAutoExit/disablePool)
        if (!isPoolEnabled(protocolId)) {
            log(`Auto-Deploy übersprungen: ${protocolId} ist deaktiviert (Pool-Freigabe)`);
            await notify.autoDeploySkippedDisabled(protocolId);
            return;
        }
        const fixedStats = get72hPoolStats().get(protocolId) ?? null;

        // Schutzschwellen live prüfen — dieselbe Funktion, die getQualifiedPools() im
        // Ranking-Modus nutzt. Dieser Zweig hatte sie bis 2026-08-20 nicht: der TVL-Schutz
        // fing das noch halbwegs auf (disablePool() nach dem Exit entzieht die Freigabe),
        // der Liquiditäts-Schutz aber gar nicht — der deaktiviert bewusst NIE und verlässt
        // sich ausdrücklich auf genau diese Live-Sperre. Ein illiquider Pool bekam hier
        // also bei jedem Tick neues Kapital, das der Exit anschließend nicht herausholen
        // kann. Bewusst kein Ausweichen auf ein anderes Protokoll: bei einem fest
        // gewählten Ziel ist Nichtstun die einzig richtige Antwort.
        const invest = checkInvestGuards(protocolId, fixedStats ?? {});
        if (!invest.ok) {
            log(`Auto-Deploy übersprungen: ${protocolId} – ${invest.reason}`);
            await notify.autoDeploySkippedGuard(protocolId, invest.rule, invest.detail);
            return;
        }

        // Mindest-Datenbasis: der avgApy eines frisch aufgenommenen Protokolls ist kein
        // geglätteter Wert. Im Ranking ist er dadurch nicht vergleichbar; hier misst er
        // gegen eine feste Schwelle, taugt dafür aus demselben Grund aber ebenso wenig.
        const basis = checkDataBasis(fixedStats ?? {});
        if (!basis.ok) {
            log(`Auto-Deploy übersprungen: ${protocolId} – Datenbasis: ${basis.reason}`);
            await notify.autoDeploySkippedGuard(protocolId, 'data_basis', {
                points:    fixedStats?.dataPoints    ?? 0,
                minPoints: REBALANCER_CONFIG.minDataPoints,
                hours:     fixedStats?.coverageHours ?? 0,
                minHours:  REBALANCER_CONFIG.minCoverageHours,
            });
            return;
        }

        // APY-Schwelle für festes Protokoll prüfen
        const fixedMinApy = adCfg.fixedApyThresholdPercent;
        if (fixedMinApy > 0) {
            const curApy = fixedStats?.avgApy ?? 0;
            if (curApy < fixedMinApy) {
                log(`Auto-Deploy übersprungen: ${protocolId} APY ${curApy.toFixed(2)}% < Minimum ${fixedMinApy}%`);
                return;
            }
        }
        plan = [{ protocol: protocolId, amount: deployFunds, reason: `Invest in ${protocolId} (Modus)` }];
    } else {
        // Modus: ranking (Bester Pool) → alles in den qualifizierten Pool mit höchstem APY
        const qualified = getQualifiedPools(get72hPoolStats());
        const best      = qualified[0] ?? null;
        plan = best
            ? [{ protocol: best.protocol, amount: deployFunds, reason: `Bester Pool (${best.avgApy.toFixed(2)}% ⌀72h)` }]
            : [];
    }

    if (plan.length === 0) {
        log('⚠️  Auto-Deploy: kein Deposit-Plan – keine qualifizierten Pools?');
        await notify.autoDeploySkippedNoPools(fmt(deployFunds));
        return;
    }

    const keypair = loadKeypair();
    const results = [];
    let   allOk   = true;

    for (const step of plan) {
        try {
            const proto  = createProtocolByName(step.protocol);
            const txData = await proto.buildDepositTx(walletAddress, step.amount);
            const base64            = typeof txData === 'string' ? txData : (txData.transaction ?? txData);
            const preserveBlockhash = typeof txData === 'object' ? (txData.preserveBlockhash ?? true) : true;
            const txSig = await signAndSend(base64, keypair, { preserveBlockhash });

            log(`Auto-Deploy ✅ ${fmt(step.amount)} USDC → ${step.protocol} | TX: ${txSig}`);

            const existingPos = getActivePositions().filter(p => p.protocol === step.protocol);
            if (existingPos.length > 0) {
                addToPosition(existingPos[0].id, step.amount);
            } else {
                addPosition({
                    protocol: step.protocol,
                    poolType: proto.poolType ?? 'lending',
                    asset:    'USDC',
                    amount:   step.amount,
                    txHash:   txSig,
                });
            }
            const feeDeploy = await fetchFeeSol(txSig);
            recordTransaction({
                type:     'deposit',
                protocol: step.protocol,
                poolType: proto.poolType ?? 'lending',
                amount:   step.amount,
                txHash:   txSig,
                feeSol:   feeDeploy,
                note:     `Auto-Deploy (${step.reason})`,
            });
            results.push(`  ✅ ${step.protocol}: +${fmt(step.amount)} USDC`);
        } catch (err) {
            const detail = err.technicalDetail ?? err.message;
            logErr(`Auto-Deploy fehlgeschlagen (${step.protocol}): ${detail}`);
            results.push(`  ❌ ${step.protocol}: ${detail}`);
            allOk = false;
        }
    }

    // Telegram-Alert
    const total     = plan.reduce((s, p) => s + p.amount, 0);
    await notify.autoDeployDone(allOk, {
        detected: fmt(newFunds),
        invested: fmt(total),
        capped:   deployFunds < newFunds ? fmt(newFunds) : null,
        results:  results.join('\n'),
    });

    // Wallet-Snapshot sofort anpassen: deployFunds wurden vom Wallet abgezogen.
    // takePortfolioSnapshot lief VOR dem Deposit → wallet_snapshot.wallet_usdc ist veraltet.
    // Korrektur hier verhindert, dass Export und Dashboard bis zum nächsten Snapshot-Tick
    // einen falschen (zu hohen) Wallet-Stand und einen falschen (zu niedrigen) Gesamtwert zeigen.
    try {
        const snap = getWalletSnapshot();
        if (snap) {
            upsertWalletSnapshot({
                currentValue: snap.current_value,
                totalYield:   snap.total_yield,
                avgApy:       snap.avg_apy,
                walletUsdc:   Math.max(0, (snap.wallet_usdc ?? 0) - deployFunds),
                walletSol:    snap.wallet_sol,
            });
        }
    } catch (err) {
        logErr(`wallet_snapshot post-deploy Korrektur: ${err.message}`);
    }

    // Sofortiger Export + Sync: alle Dashboard-Felder (Operative Metriken, Wallet,
    // Transaktionen, Gesamtwert) werden simultan aktualisiert – kein Verzug bis zum
    // nächsten regulären 5-Minuten-Sync.
    await runExport();
    await runSync();
}

// ─── Haupt-Tick ───────────────────────────────────────────────────────────────

async function tick(allProtocols, walletAddress) {
    log('── Tick ──────────────────────────────────────');
    try {
        const apyMap     = await checkApys(allProtocols);
        const walletUsdc = await takePortfolioSnapshot(allProtocols, walletAddress, apyMap);
        await checkAndAutoExit(allProtocols, walletAddress);
        await checkAndTopupSol(walletAddress);          // SOL-Reserve vor Deploy prüfen
        await checkAndDeployNewFunds(walletUsdc, walletAddress);
    } catch (err) {
        logErr(`Tick-Fehler: ${err.message}`);
    }
}

// ─── SOL-Topup: USDC → SOL wenn Reserve zu gering ────────────────────────────

async function checkAndTopupSol(walletAddress) {
    const solBalance = await getSolBalance(walletAddress);
    if (solBalance >= SOL_TOPUP_TRIGGER) return; // Alles OK

    log(`⚠️  SOL-Reserve: ${solBalance.toFixed(4)} SOL < ${SOL_TOPUP_TRIGGER} SOL – starte USDC→SOL Topup`);

    const usdcBalance = await getUsdcBalance(walletAddress);
    if (usdcBalance < 0.5) {
        log(`⚠️  SOL-Topup: zu wenig USDC im Wallet (${usdcBalance.toFixed(2)} USDC) – warte auf Akkumulation`);
        if (solBalance < SOL_WARN_TRIGGER) {
            await notify.solReserveCritical(solBalance.toFixed(4), usdcBalance.toFixed(2));
        }
        return;
    }

    // SOL-Preis über Nexus ermitteln
    let solPrice = null;
    try {
        const url = `${NEXUS_URL}/jup/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=1000000&slippageBps=0`;
        const res  = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
            const q = await res.json();
            solPrice = q?.outAmount ? 1_000_000 / (parseFloat(q.outAmount) / 1e9) : null;
        }
    } catch { /* SOL-Preis nicht abrufbar */ }

    if (!solPrice) {
        log(`⚠️  SOL-Topup: SOL-Preis nicht abrufbar – übersprungen`);
        return;
    }

    const neededSol  = SOL_TOPUP_TARGET - solBalance;
    const neededUsdc = Math.min(usdcBalance, Math.ceil(neededSol * solPrice * 1.02 * 100) / 100); // +2 % Puffer

    log(`SOL-Topup: brauche ${neededSol.toFixed(4)} SOL → swap ${neededUsdc.toFixed(2)} USDC (Preis: ${solPrice.toFixed(2)} USDC/SOL)`);

    try {
        // 1. Quote
        const inAmount = Math.round(neededUsdc * 10 ** USDC_DECIMALS);
        const qParams  = new URLSearchParams({
            inputMint:   USDC_MINT,
            outputMint:  SOL_MINT,
            amount:      String(inAmount),
            slippageBps: String(TOPUP_SLIPPAGE),
        });
        const qRes   = await fetch(`${NEXUS_URL}/jup/swap/v1/quote?${qParams}`, { signal: AbortSignal.timeout(10_000) });
        if (!qRes.ok) throw new Error(`Quote HTTP ${qRes.status}`);
        const quote  = await qRes.json();
        if (!quote?.outAmount) throw new Error('kein outAmount in Quote');

        // 2. Swap-TX bauen
        const keypair  = loadKeypair();
        const swapRes  = await fetch(`${NEXUS_URL}/jup/swap/v1/swap`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                quoteResponse:             quote,
                userPublicKey:             keypair.publicKey.toBase58(),
                wrapAndUnwrapSol:          true,
                dynamicComputeUnitLimit:   true,
                prioritizationFeeLamports: 'auto',
            }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!swapRes.ok) throw new Error(`Swap-TX HTTP ${swapRes.status}`);
        const swapData = await swapRes.json();
        if (!swapData?.swapTransaction) throw new Error('kein swapTransaction in Antwort');

        // 3. Signieren + senden
        const txSig = await signAndSend(swapData.swapTransaction, keypair, { preserveBlockhash: false });
        const solReceived = parseFloat(quote.outAmount) / 10 ** SOL_DECIMALS;

        log(`SOL-Topup ✅ ${neededUsdc.toFixed(2)} USDC → ${solReceived.toFixed(4)} SOL | TX: ${txSig}`);
        await notify.solTopupDone(neededUsdc.toFixed(2), solReceived.toFixed(4), solBalance.toFixed(4));
        addNotification({ level: 'info', msgKey: 'notify.len.sol_topup_short',
            params: { usdc: neededUsdc.toFixed(2), sol: solReceived.toFixed(4) } });
    } catch (err) {
        const detail = err.technicalDetail ?? err.message;
        logErr(`SOL-Topup fehlgeschlagen: ${detail}`);
        await notify.solTopupFailed(detail, solBalance.toFixed(4));
    }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
    // Wallet-Adresse aus Keypair ableiten
    const walletAddress = loadKeypair().publicKey.toBase58();

    log(`════════════════════════════════════════════`);
    log(`  ${config.botDisplayName} gestartet`);
    log(`  PID       : ${process.pid}`);
    log(`  Wallet    : ${walletAddress}`);
    log(`  Protokolle: ${[...config.protocols, ...config.monitorProtocols].join(', ')}`);
    log(`  Interval  : ${(APY_INTERVAL_MS / 60_000).toFixed(0)} min`);
    log(`  Sync      : ${config.syncTarget || '(deaktiviert)'}`);
    log(`════════════════════════════════════════════`);

    // DB initialisieren
    getDb();
    kvSet('bot_state', 'running');

    // Alle Protokoll-Instanzen (LENDING + MONITOR, dedupliziert)
    const allProtocols = buildAllProtocols();
    if (allProtocols.length === 0) {
        logErr('Keine Protokolle konfiguriert (LENDING_PROTOCOLS / MONITOR_PROTOCOLS). Bot beendet sich.');
        process.exit(1);
    }
    log(`  Pools bekannt: ${allProtocols.map(p => p.label).join(', ')}`);

    // Telegram: Startup-Nachricht (nicht während eines Updates – dort sendet
    // do_update() stattdessen eine Zusammenfassung, s. lib/notify.js)
    if (!isUpdateInProgress()) {
        await notify.startup(allProtocols.map(p => p.label).join(', '));
    }

    // Graceful Shutdown
    let shuttingDown = false;
    async function gracefulShutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`[Signal] ${signal} empfangen – fahre herunter …`);
        kvSet('bot_state', 'offline');
        if (!isUpdateInProgress()) {
            await notify.shutdown(signal);
        }

        // Letzter Export vor dem Stopp
        try {
            await runExport();
            await runSync();
        } catch { /* ignorieren */ }

        process.exit(0);
    }
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', async (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        log(`[bot] Unbehandelte Promise-Rejection (kein Crash): ${msg}`);
        await notify.unhandledRejection(msg).catch(() => {});
    });

    // ── Erster Tick sofort ────────────────────────────────────────────────────
    await tick(allProtocols, walletAddress);
    await runExport();
    await runSync();

    // ── APY-Interval (stündlich, mit Jitter) ─────────────────────────────────
    setInterval(async () => {
        if (shuttingDown) return;
        await new Promise(r => setTimeout(r, Math.random() * APY_JITTER_MS));
        if (shuttingDown) return;
        await tick(allProtocols, walletAddress);
    }, APY_INTERVAL_MS);

    // ── Sync-Interval (alle 5 Minuten) ────────────────────────────────────────
    setInterval(async () => {
        if (shuttingDown) return;
        const walletUsdc = await takePortfolioSnapshot(allProtocols, walletAddress);
        await checkAndDeployNewFunds(walletUsdc, walletAddress);
        await runExport();
        await runSync();
    }, SYNC_INTERVAL_MS);

    log('Bot läuft. Warte auf nächsten Tick …');
}

// ─── Einstiegspunkt ───────────────────────────────────────────────────────────

start().catch(err => {
    logErr(`Kritischer Fehler beim Start: ${err.message}`);
    console.error(err);
    process.exit(1);
});
