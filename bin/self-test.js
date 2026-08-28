#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// FORGE public – Minimaler Selbsttest nach einem Update
// ══════════════════════════════════════════════════════════════════════════════
// Prüft ausschließlich, was jeder Nutzer unprivilegiert selbst auch per
// 'systemctl status' sehen könnte — bewusst KEINE Root-Rechte nötig, deshalb
// direkt von bots/settings (läuft als INSTALL_USER) aufrufbar, ohne den
// sudo-Umweg über bot-control-daemon.js.
//
// Ein Dienst gilt nur dann als Problem, wenn er AKTIVIERT ('systemctl
// is-enabled') aber NICHT aktiv ist — ein bewusst deaktivierter Bot (z.B.
// LendingBot ohne hinterlegtes Wallet) ist kein Fehler (gleiches Muster wie
// config/health-config.js isBotEnabled()).
//
// Aufruf: node bin/self-test.js [--json]
// Exit-Code: 0 = ok, 1 = Problem gefunden
//
// Bewusst KEIN Vergleich gegen einen "Vorher"-Zustand (anders als das
// Health-Gate in bin/update-check.js direkt nach einem Apply) — dieses Skript
// ist für einen jederzeit manuell auslösbaren Stand-alone-Check gedacht.
//
// Seit 2026-08-22 zusätzlich ein DATENQUALITÄTS-Check auf der Positions-Wertreihe.
// Grund: Läuft ein Dienst nicht, sieht der Nutzer das. Steht im Dashboard dagegen eine
// Zahl, die auf einem fehlerhaften Messwert beruht (TRUMP/SOL, 22.08.: +114 % PnL aus
// Phantom-Fees), hat er auf einer FORGE-public-Installation bis dahin KEINE Möglichkeit
// gehabt, das zu prüfen — health-check.js prüft nur Infrastruktur. Genau diese Lücke
// schließt der Check: er beantwortet die Frage "kann ich der Zahl trauen?" ohne
// Chain-Zugriff und ohne fremde Hilfe. Lesend, unprivilegiert, ohne Netzwerk.
// ══════════════════════════════════════════════════════════════════════════════

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { t } from '../lib/i18n.js';
import { PATHS } from '../config/paths.js';
import { checkFeeJump } from '../lib/fee-plausibility.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');

const SERVICES = ['forge-nexus', 'forge-premium', 'forge-settings', 'forge-settings-daemon', 'forge-liquiditybot', 'forge-lendingbot'];

function isEnabled(service) {
    const r = spawnSync('systemctl', ['is-enabled', service], { encoding: 'utf8' });
    return r.stdout.trim() === 'enabled';
}

function isActive(service) {
    const r = spawnSync('systemctl', ['is-active', service], { encoding: 'utf8' });
    return r.stdout.trim() === 'active';
}

function installedVersion() {
    const versionPath = path.join(APP_DIR, 'VERSION');
    if (!existsSync(versionPath)) return null;
    const match = readFileSync(versionPath, 'utf8').match(/^Version:\s*(\S+)/m);
    return match ? match[1] : null;
}

/**
 * Datenqualität der Positions-Wertreihe: Gibt es Snapshots, deren Pending-Fee-Wert
 * unplausibel ist? `lib/pnl.js` bildet die Wertreihe als `lp_value_usd + fees_pending_usd`
 * — ein solcher Ausreißer verzerrt damit jede PnL-Angabe, die ihn im Fenster hat.
 *
 * Dieselbe Regel wie der Live-Guard und die Migration `0005-phantom-fee-snapshots`
 * (`lib/fee-plausibility.js`). Findet der Check etwas, ist die Migration die Reparatur.
 *
 * Fehlt die Datenbank (Installation ohne Liquidity-Bot), ist das kein Problem, sondern
 * schlicht nichts zu prüfen.
 */
function checkSnapshotQuality() {
    let db;
    try {
        db = new Database(PATHS.liquidityDb, { readonly: true, fileMustExist: true });
    } catch {
        return { available: false, badCount: 0, pools: [] };
    }
    try {
        const rows = db.prepare(`
            SELECT pool_id, recorded_at, lp_value_usd, fees_pending_usd
              FROM position_snapshots
             ORDER BY pool_id, recorded_at
        `).all();

        const pools = new Set();
        let badCount = 0;
        let currentPool = null;
        let prev = null;

        for (const row of rows) {
            if (row.pool_id !== currentPool) { currentPool = row.pool_id; prev = null; }
            if (!prev) { prev = row; continue; }
            const verdict = checkFeeJump({
                feesUsd:     row.fees_pending_usd,
                prevFeesUsd: prev.fees_pending_usd,
                lpValueUsd:  row.lp_value_usd,
                elapsedMs:   row.recorded_at - prev.recorded_at,
            });
            // Vorgänger bleibt der letzte GÜLTIGE Wert – sonst bliebe ein zweiter
            // Ausreißer direkt hinter dem ersten unentdeckt (kein auffälliges Delta mehr).
            if (verdict.implausible) { badCount++; pools.add(row.pool_id); continue; }
            prev = row;
        }
        return { available: true, badCount, pools: [...pools] };
    } catch {
        return { available: false, badCount: 0, pools: [] };
    } finally {
        try { db.close(); } catch { /* egal */ }
    }
}

function runSelfTest() {
    const checked = [];
    const problems = [];

    for (const service of SERVICES) {
        const enabled = isEnabled(service);
        const active = enabled ? isActive(service) : null;
        checked.push({ service, enabled, active });
        if (enabled && !active) {
            problems.push(t('cli.selftest.problem', { service }));
        }
    }

    const snapshots = checkSnapshotQuality();
    if (snapshots.badCount > 0) {
        problems.push(t('cli.selftest.snapshot_problem', {
            count: snapshots.badCount,
            pools: snapshots.pools.join(', '),
        }));
    }

    return {
        ok: problems.length === 0,
        version: installedVersion(),
        checked,
        snapshots,
        problems,
    };
}

const result = runSelfTest();

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result));
} else {
    console.log(`[self-test] Version: ${result.version ?? t('cli.selftest.unknown')}`);
    for (const c of result.checked) {
        console.log(`[self-test] ${c.service}: ${c.enabled ? (c.active ? t('cli.selftest.active') : `🔴 ${t('cli.selftest.not_active')}`) : t('cli.selftest.disabled_skipped')}`);
    }
    if (result.snapshots.available) {
        console.log(`[self-test] ${t('cli.selftest.snapshot_label')}: ${result.snapshots.badCount === 0
            ? t('cli.selftest.snapshot_clean')
            : `🔴 ${t('cli.selftest.snapshot_found', { count: result.snapshots.badCount })}`}`);
    }
    if (result.ok) {
        console.log(`[self-test] ✓ ${t('cli.selftest.all_ok')}`);
    } else {
        console.log(`[self-test] 🔴 ${t('cli.selftest.problem_count', { count: result.problems.length })}`);
        for (const p of result.problems) console.log(`[self-test]   - ${p}`);
    }
}

process.exitCode = result.ok ? 0 : 1;
