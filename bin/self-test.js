#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// FORGE.pub – Minimaler Selbsttest nach einem Update
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
// ══════════════════════════════════════════════════════════════════════════════

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function runSelfTest() {
    const checked = [];
    const problems = [];

    for (const service of SERVICES) {
        const enabled = isEnabled(service);
        const active = enabled ? isActive(service) : null;
        checked.push({ service, enabled, active });
        if (enabled && !active) {
            problems.push(`${service}: aktiviert, läuft aber nicht – prüfen mit "journalctl -u ${service} -n 50"`);
        }
    }

    return {
        ok: problems.length === 0,
        version: installedVersion(),
        checked,
        problems,
    };
}

const result = runSelfTest();

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result));
} else {
    console.log(`[self-test] Version: ${result.version ?? 'unbekannt'}`);
    for (const c of result.checked) {
        console.log(`[self-test] ${c.service}: ${c.enabled ? (c.active ? 'aktiv' : '🔴 NICHT aktiv') : 'deaktiviert (übersprungen)'}`);
    }
    if (result.ok) {
        console.log('[self-test] ✓ Keine Auffälligkeiten.');
    } else {
        console.log(`[self-test] 🔴 ${result.problems.length} Problem(e):`);
        for (const p of result.problems) console.log(`[self-test]   - ${p}`);
    }
}

process.exitCode = result.ok ? 0 : 1;
