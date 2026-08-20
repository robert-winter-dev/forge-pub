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
import { t, getLang, numLocale } from '../lib/i18n.js';
import { renderNotification } from '../lib/notify-render.js';

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

// msgKey statt fertigem Text (Schritt 5 der Mehrsprachigkeit, siehe
// lib/notify-render.js): dieses Script schickte bisher rohen deutschen
// Fließtext an /notify — auf einer EN-Installation blieb die Zusammenfassung
// nach JEDEM Update trotzdem deutsch, da der zentrale Notify-Endpoint msgKey
// nicht zur Pflicht macht und ohne ihn `message` unverändert durchreicht.
function fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return t('cli.upd.unknown_word');
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m === 0) return t('notify.upd.summary_dur_sec', { s });
    return t('notify.upd.summary_dur_min_sec', { m, s });
}

function fmtTimestamp(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso ?? t('cli.upd.unknown_word');
    return new Intl.DateTimeFormat(numLocale(), {
        timeZone: FORGE_TZ, day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    }).format(d);
}

function buildParams({ version, startedAt, durationSec, services, problems }) {
    const servicesBlock = services.length > 0
        ? t('notify.upd.summary_services_list', { list: services.map(s => `* ${s}`).join('\n') })
        : t('notify.upd.summary_no_services');
    const problemsBlock = problems.length === 0
        ? t('notify.upd.summary_no_problems')
        : t('notify.upd.summary_problems_list', { list: problems.map(p => `* ${p}`).join('\n') });
    return {
        version:  version ?? t('cli.upd.unknown_word'),
        started:  fmtTimestamp(startedAt),
        duration: fmtDuration(durationSec),
        services: servicesBlock,
        problems: problemsBlock,
    };
}

const args     = parseArgs(process.argv.slice(2));
const msgKey   = 'notify.upd.summary';
const params   = buildParams(args);
const level    = args.problems.length > 0 ? 'error' : 'lifecycle';
const message  = renderNotification(
    { msgKey, params, displayName: 'FORGE Update', timestamp: Date.now() },
    getLang(),
);

try {
    const res = await fetch(`${NEXUS_URL}/notify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            botId:       'forge-update',
            displayName: 'FORGE Update',
            level,
            category:    'system',
            message, msgKey, params,
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
