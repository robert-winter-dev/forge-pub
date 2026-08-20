#!/usr/bin/env node
/**
 * FORGE bin/emergency-exit.js – Zentrales Emergency-Exit-Script
 *
 * Zieht Kapital aus einem oder mehreren Bots heraus.
 * Jede Ausführung im Live-Modus stoppt die betroffenen Systemd-Services
 * und verhindert Neustart durch bot_paused-Flag in der DB (wo unterstützt).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VERWENDUNG
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Ziel-Selektion (mind. einer der folgenden):
 *     --all                  Alle Bots, alle Chains (= --chain:all)
 *     --chain:all            Alle Bots, alle Chains
 *     --chain:solana         Alle Bots der Chain „solana"
 *     --bot:liquiditybot             Nur diesen Bot (alle Chains)
 *     --bot:lendingbot       Nur LendingBot (alle Chains)
 *
 *   Kombination erlaubt:
 *     --bot:liquiditybot --chain:solana    → Liquidity auf Solana
 *     --bot:liquiditybot --chain:base      → Fehler (existiert nicht)
 *
 *   Simulation (optional, Standard: Live-Modus):
 *     --dry-run              Level B: liest Positionen, zeigt was ausgezahlt würde
 *     --dry-run=A            Level A: nur Konnektivitätscheck
 *     --dry-run=C            Level C: baut TX + simulateTransaction (kein Versand)
 *
 *   Swap/Versand (🔒 seit 2026-08-04: --swapto:USDC ist der DEFAULT, kein Opt-in
 *   mehr — Entscheidung: ein Emergency-Exit soll Kapital standardmäßig sichern,
 *   nicht Tokens behalten):
 *     --swapto:USDC          (Default) Nach Auszahlung alle Tokens in USDC tauschen
 *     --swapto:SOL           Stattdessen nach SOL tauschen
 *     --no-swap               Eilfall: KEIN Swap, rohe Tokens im Wallet behalten
 *                             (schneller, kein zusätzliches TX-/Slippage-Risiko —
 *                             sinnvoll wenn wirklich nur Zeit zählt)
 *     --sendto:<addr>        Nach Auszahlung an diese Adresse senden
 *                            (SOL-Reserve für Fees bleibt automatisch im Wallet)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BEISPIELE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   # Täglicher Selbsttest (Cron):
 *   node bin/emergency-exit.js --all --dry-run
 *
 *   # Vollständige TX-Simulation (manuell):
 *   node bin/emergency-exit.js --all --dry-run=C
 *
 *   # Nur Liquidity auf Solana auszahlen (live, swapt automatisch → USDC):
 *   node bin/emergency-exit.js --bot:liquiditybot --chain:solana
 *
 *   # Eilig raus, kein Swap:
 *   node bin/emergency-exit.js --bot:liquiditybot --no-swap
 *
 *   # Alles auszahlen (live) – IRREVERSIBEL:
 *   node bin/emergency-exit.js --all
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn }         from 'child_process';
import { execSync }      from 'child_process';
import { fileURLToPath } from 'url';
import path              from 'path';
import { PATHS }         from '../config/paths.js';
import fs                from 'fs';
import { renderNotification } from '../lib/notify-render.js';
import { getLang }       from '../lib/i18n.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.join(__dirname, '..');
const LOG_DIR    = PATHS.logs;
const NEXUS_URL  = 'http://127.0.0.1:3100';

// ─── Imports ──────────────────────────────────────────────────────────────────

const { BOTS, CHAINS } = await import('../config/emergency-config.js');

// ─── Argument-Parsing ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

// Trockenlauf-Modus ermitteln
let dryRunLevel = null; // null = live
const dryRunArg = argv.find(a => a === '--dry-run' || a.startsWith('--dry-run='));
if (dryRunArg) {
    const level = dryRunArg.includes('=') ? dryRunArg.split('=')[1].toUpperCase() : 'B';
    dryRunLevel = ['A', 'B', 'C'].includes(level) ? level : 'B';
}
const isDryRun = dryRunLevel !== null;

// Optionale Post-Processing-Parameter
// 🔒 Default seit 2026-08-04: ohne ausdrückliche Angabe wird
// IMMER nach USDC geswappt — ein Emergency-Exit soll standardmäßig Kapital sichern,
// nicht Tokens behalten. --no-swap ist der bewusste Eilfall ("ich will nur schnell
// raus, Swap kostet Zeit/Slippage/eine zusätzliche TX"). Ein explizites --swapto:X
// hat immer Vorrang vor dem Default.
const explicitSwapToArg = argv.find(a => a.startsWith('--swapto:'));
const noSwap            = argv.includes('--no-swap');
const swapToArg = explicitSwapToArg ?? (noSwap ? null : '--swapto:USDC');
const sendToArg = argv.find(a => a.startsWith('--sendto:'));

// Ziel-Selektion
const targetAll    = argv.includes('--all') || argv.includes('--chain:all');
const targetChains = argv
    .filter(a => a.startsWith('--chain:') && a !== '--chain:all')
    .map(a => a.slice('--chain:'.length).toLowerCase());
const targetBots   = argv
    .filter(a => a.startsWith('--bot:'))
    .map(a => a.slice('--bot:'.length).toLowerCase());

// Mindestens ein Ziel-Parameter muss angegeben sein
if (!targetAll && targetChains.length === 0 && targetBots.length === 0) {
    abort('Kein Ziel angegeben. Beispiel: --all | --chain:solana | --bot:liquiditybot');
}

// ─── Ziel-Bots auflösen ────────────────────────────────────────────────────────

/**
 * Gibt Array von { chain, botId, botCfg } zurück.
 */
function resolveTargets() {
    const targets = [];

    const chainKeys = targetAll ? CHAINS : (targetChains.length > 0 ? targetChains : CHAINS);

    for (const chain of chainKeys) {
        if (!BOTS[chain]) {
            abort(`Unbekannte Chain: "${chain}". Bekannte Chains: ${CHAINS.join(', ')}`);
        }

        const botsOnChain = BOTS[chain];
        const botKeys     = targetBots.length > 0 ? targetBots : Object.keys(botsOnChain);

        for (const botId of botKeys) {
            if (!botsOnChain[botId]) {
                // Kombination aus --bot:X --chain:Y existiert nicht → Fehler
                if (targetBots.length > 0 && targetChains.length > 0) {
                    abort(`Bot "${botId}" existiert nicht auf Chain "${chain}".`);
                }
                // Bot nicht auf dieser Chain → überspringen (kein Fehler)
                continue;
            }

            targets.push({ chain, botId, botCfg: botsOnChain[botId] });
        }
    }

    // Falls --bot:X angegeben aber auf keiner Chain gefunden
    for (const botId of targetBots) {
        const found = CHAINS.some(c => BOTS[c]?.[botId]);
        if (!found) abort(`Bot "${botId}" ist in keiner Chain konfiguriert.`);
    }

    return targets;
}

// ─── Subprocess-Ausführung ────────────────────────────────────────────────────

function runBotModule(modulePath, moduleDir, modeArg) {
    // Optionale Parameter an Subprocess durchreichen
    const extraArgs = [];
    if (swapToArg) extraArgs.push(swapToArg);
    if (sendToArg) extraArgs.push(sendToArg);

    return new Promise((resolve) => {
        const proc  = spawn('node', [modulePath, '--mode', modeArg, ...extraArgs], {
            cwd:   moduleDir,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => {
            stderr += d;
            process.stderr.write(d); // Live-Ausgabe
        });

        proc.on('close', code => {
            let result;
            try {
                result = JSON.parse(stdout.trim());
            } catch {
                result = {
                    bot:     path.basename(modulePath),
                    success: false,
                    errors:  [{ error: `Kein gültiges JSON in stdout: ${stdout.slice(0, 200)}` }],
                };
            }
            resolve(result);
        });

        proc.on('error', err => {
            resolve({
                bot:     path.basename(modulePath),
                success: false,
                errors:  [{ error: `Subprocess-Start fehlgeschlagen: ${err.message}` }],
            });
        });
    });
}

// ─── Systemd-Service stoppen ──────────────────────────────────────────────────

function stopService(serviceName) {
    try {
        execSync(`sudo systemctl stop ${serviceName}`, { stdio: 'pipe', timeout: 15_000 });
        info(`Service "${serviceName}" gestoppt`);
        return true;
    } catch (err) {
        warn(`Service "${serviceName}" konnte nicht gestoppt werden: ${err.message.trim()}`);
        return false;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── Nexus-Notification ───────────────────────────────────────────────────────

// msgKey statt fertigem Text (Schritt 5 der Mehrsprachigkeit) — sonst kommt
// diese Meldung auf einer EN-Installation trotzdem deutsch an, siehe
// lib/notify-render.js.
async function sendNotification(level, msgKey, params = {}, context = null) {
    const message = renderNotification(
        { msgKey, params, displayName: 'Emergency Exit', timestamp: Date.now() },
        getLang(),
    );
    try {
        await fetch(`${NEXUS_URL}/notify`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                botId:       'emergency-exit',
                displayName: 'Emergency Exit',
                level,
                category:    'emergency_exit',
                message, msgKey, params,
                context,
            }),
            signal: AbortSignal.timeout(5000),
        });
    } catch (err) {
        warn(`Telegram-Notification fehlgeschlagen: ${err.message}`);
    }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

const startTime = new Date();
const logLines  = [];

function info(msg)  { const l = `[${ts()}] INFO  ${msg}`;  logLines.push(l); console.log(l); }
function warn(msg)  { const l = `[${ts()}] WARN  ${msg}`;  logLines.push(l); console.warn(l); }
function error(msg) { const l = `[${ts()}] ERROR ${msg}`;  logLines.push(l); console.error(l); }
function abort(msg) { error(`Abbruch: ${msg}`); process.exit(1); }
function ts()       { return new Date().toISOString().slice(11, 19); }

function writeLog(isDryRun) {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const logFile = path.join(LOG_DIR, isDryRun ? 'emergency-test.log' : 'emergency-exit.log');
        fs.appendFileSync(logFile, logLines.join('\n') + '\n\n');
    } catch { /* Log-Schreiben ist nicht kritisch */ }
}

// ─── Bericht formatieren ──────────────────────────────────────────────────────

function formatReport(results, targets, isDryRun, dryRunLevel) {
    const mode     = isDryRun ? `DRY-RUN (Level ${dryRunLevel})` : '🚨 LIVE';
    const ok       = results.filter(r => r.success).length;
    const fail     = results.filter(r => !r.success).length;
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    const lines = [
        ``,
        `━━━ Emergency Exit Report ━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `  Modus:     ${mode}`,
        `  Bots:      ${targets.map(t => t.botCfg.name).join(', ')}`,
        `  Ergebnis:  ${ok}/${results.length} OK${fail > 0 ? `, ${fail} FEHLER` : ''}`,
        `  Dauer:     ${duration}s`,
        `  Zeit:      ${startTime.toISOString()}`,
        ``,
    ];

    for (const r of results) {
        lines.push(`  ── ${r.name} (${r.chain ?? '?'}) ──`);
        if (!r.success) {
            lines.push(`     ❌ FEHLER: ${r.errors?.map(e => e.error).join(', ')}`);
        } else {
            lines.push(`     ✅ Erfolgreich`);
            // Bot-spezifische Zusammenfassung
            if (r.positions) {
                // Liquidity / LendingBot
                if (r.openPositions !== undefined)
                    lines.push(`     Positionen: ${r.openPositions}`);
                if (r.totalUsdc !== undefined)
                    lines.push(`     Gesamt: ~${r.totalUsdc.toFixed(2)} USDC`);
                if (r.closed !== undefined)
                    lines.push(`     Geschlossen: ${r.closed}, Fehler: ${r.failed ?? 0}`);
                if (r.withdrawn !== undefined)
                    lines.push(`     Abgezogen: ${r.withdrawn}, Fehler: ${r.failed ?? 0}`);
            }
        }
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const modeArg = isDryRun ? dryRunLevel : 'live';
    const targets = resolveTargets();

    if (targets.length === 0) {
        abort('Keine passenden Bots für die gewählte Kombination gefunden.');
    }

    // ── Header ────────────────────────────────────────────────────────────────
    info(`${'═'.repeat(52)}`);
    if (isDryRun) {
        info(`FORGE Emergency Exit – DRY-RUN Level ${dryRunLevel}`);
    } else {
        info(`FORGE Emergency Exit – ⚠ LIVE-MODUS ⚠`);
    }
    info(`Bots: ${targets.map(t => `${t.botCfg.name} (${t.chain})`).join(', ')}`);
    if (swapToArg) info(`Swap: ${swapToArg}`);
    if (sendToArg) info(`Send: ${sendToArg}`);
    info(`${'═'.repeat(52)}`);

    // ── Live: Telegram-Alert sofort senden ────────────────────────────────────
    if (!isDryRun) {
        const botNames = targets.map(t => t.botCfg.name).join(', ');
        await sendNotification(
            'lifecycle',
            'notify.emg.started',
            { bots: botNames },
            { botNames, chain: targets.map(t => t.chain) }
        );
    }

    // ── Live: Services stoppen (vor Withdrawal, verhindert Neuinvestition) ────
    if (!isDryRun) {
        info('Services werden gestoppt...');
        for (const { botCfg } of targets) {
            stopService(botCfg.service);
        }
        info('Warte 3s auf sauberes Herunterfahren...');
        await sleep(3_000);
    }

    // ── Bot-Module ausführen (parallel) ───────────────────────────────────────
    info(`Führe Bot-Module aus (Mode: ${modeArg})...`);
    const resultsPromises = targets.map(({ botCfg }) =>
        runBotModule(botCfg.module, botCfg.moduleDir, modeArg)
    );
    const rawResults = await Promise.all(resultsPromises);
    // Subprocess-Ergebnis mit dem auslösenden Ziel verknüpfen: bei fehlgeschlagenem
    // JSON-Parsing/Spawn fällt r.bot sonst auf den Dateinamen des Moduls zurück –
    // und mehrere Bots teilen sich denselben Dateinamen (emergency-withdraw.js),
    // was die Fehlermeldung unbrauchbar macht (2026-07-30).
    const results = rawResults.map((r, i) => ({ ...r, name: targets[i].botCfg.name, chain: r.chain ?? targets[i].chain }));

    // ── Bericht ───────────────────────────────────────────────────────────────
    const report     = formatReport(results, targets, isDryRun, dryRunLevel);
    const overallOk  = results.every(r => r.success);
    const hasErrors  = results.some(r => !r.success);

    console.log(report);
    logLines.push(report);

    // ── Telegram-Notifications ────────────────────────────────────────────────
    if (isDryRun) {
        // Dry-Run: nur bei Fehlern benachrichtigen
        if (hasErrors) {
            const failedDetail = results
                .filter(r => !r.success)
                .map(r => `${r.name}: ${r.errors?.map(e => e.error).join('; ') ?? '?'}`)
                .join(' | ');
            await sendNotification(
                'error',
                'notify.emg.dryrun_failed',
                { detail: failedDetail },
                { dryRunLevel, results: results.map(r => ({ bot: r.name, success: r.success, errors: r.errors })) }
            );
            error(`Selbsttest FEHLGESCHLAGEN (Level ${dryRunLevel})`);
        } else {
            info(`Selbsttest OK (Level ${dryRunLevel}) – alle ${results.length} Bot(s) bestanden`);
        }
    } else {
        // Live: immer abschließende Meldung senden
        const botNames = targets.map(t => t.botCfg.name).join(', ');
        await sendNotification(
            overallOk ? 'lifecycle' : 'error',
            'notify.emg.finished',
            { bots: botNames, status: { k: overallOk ? 'notify.emg.status_ok' : 'notify.emg.status_errors' } },
            { results: results.map(r => ({ bot: r.name, success: r.success })) }
        );
    }

    writeLog(isDryRun);
    process.exit(overallOk ? 0 : 1);
}

main().catch(err => {
    error(`Fatal: ${err.stack ?? err.message}`);
    writeLog(isDryRun);
    process.exit(1);
});
