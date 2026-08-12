#!/usr/bin/env node
/**
 * FORGE public – Zusammenfassende System-Message nach einem Update.
 *
 * Ersetzt die sonst üblichen Einzel-"gestartet"-Meldungen jedes neu gestarteten
 * Bots (die während eines Updates unterdrückt werden, siehe
 * bin/setup-lib/common.sh update_notify_suppress_on/-off und
 * bots/liquidity/lib/notify.js bzw. bots/lending/lib/notify.js) durch EINE
 * Nachricht mit Version, Laufzeit und – falls vorhanden – aufgefallenen
 * Problemen samt Handlungsempfehlung. Wird ausschließlich von do_update()
 * (bin/setup-lib/lifecycle.sh) aufgerufen, nach dem letzten Service-Restart.
 *
 * Usage:
 *   node bin/send-update-summary.js --version <str> --started-at <ISO-Zeitstempel>
 *       --duration-sec <n>
 *       [--service "Liquidity Bot"] [--service "LendingBot"] …
 *       [--problem "Liquidity Bot (forge-liquiditybot): läuft nicht – journalctl -u forge-liquiditybot -n 50 prüfen"] …
 */

import { FORGE_TZ } from '../core/config.js';

const NEXUS_URL = 'http://127.0.0.1:3100';

function parseArgs(argv) {
    const out = { services: [], problems: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--version')        out.version = argv[++i];
        else if (arg === '--started-at') out.startedAt = argv[++i];
        else if (arg === '--duration-sec') out.durationSec = Number(argv[++i]);
        else if (arg === '--service')    out.services.push(argv[++i]);
        else if (arg === '--problem')    out.problems.push(argv[++i]);
    }
    return out;
}

function fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return 'unbekannt';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m === 0) return `${s} Sek.`;
    return `${m} Min. ${s} Sek.`;
}

function fmtTimestamp(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso ?? 'unbekannt';
    return new Intl.DateTimeFormat('de-DE', {
        timeZone: FORGE_TZ, day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    }).format(d);
}

function buildMessage({ version, startedAt, durationSec, services, problems }) {
    const lines = [];
    lines.push(`Das FORGE Update Version ${version ?? 'unbekannt'} wurde eingespielt.`);
    lines.push('');
    lines.push(`Beginn: ${fmtTimestamp(startedAt)} Uhr`);
    lines.push(`Dauer: ${fmtDuration(durationSec)}`);
    lines.push('');
    if (services.length > 0) {
        lines.push('Folgende Dienste wurden neu gestartet:');
        lines.push('');
        for (const s of services) lines.push(`* ${s}`);
    } else {
        lines.push('Es waren keine Bot-Dienste aktiv, daher wurde keiner neu gestartet.');
    }
    lines.push('');
    if (problems.length === 0) {
        lines.push('Vom Monitoring wurden keine Auffälligkeiten gemeldet.');
    } else {
        lines.push('⚠️ Es wurden Auffälligkeiten festgestellt:');
        for (const p of problems) lines.push(`* ${p}`);
    }
    return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
const message = buildMessage(args);
const level = args.problems.length > 0 ? 'error' : 'lifecycle';

try {
    const res = await fetch(`${NEXUS_URL}/notify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            botId:       'forge-update',
            displayName: 'FORGE Update',
            level,
            category:    'system',
            message,
        }),
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
        console.error(`[send-update-summary] Nexus-Fehler: HTTP ${res.status} – ${await res.text()}`);
        process.exit(1);
    }
    console.log('[send-update-summary] Zusammenfassung gesendet.');
} catch (err) {
    console.error(`[send-update-summary] Nexus nicht erreichbar: ${err.message}`);
    process.exit(1);
}
