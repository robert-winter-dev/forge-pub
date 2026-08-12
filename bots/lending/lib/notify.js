/**
 * FORGE Lending – Notifications
 *
 * Sendet alle Notifications an FORGE Nexus (POST /notify).
 *
 * ── Mehrsprachigkeit (Schritt 5, Core/forge-pub/i18n.md E4) ─────
 *
 * 🔒 Hier steht KEIN Meldungstext mehr, und die Aufrufer formulieren auch keinen:
 * jede Meldung ist eine benannte Funktion, die einen Katalogschlüssel
 * (`notify.len.*` in lib/i18n/<lang>.json) plus Daten schickt. Der Satz entsteht
 * erst beim Anzeigen (lib/notify-render.js).
 *
 * Das ist zugleich der zweite Grund für den Umbau: vorher schickten ~20 Stellen in
 * bin/bot.js ihren Text selbst, und Level, Kategorie sowie Handlungsaufforderung
 * wurden aus diesem Text ZURÜCKGERATEN (Emoji-Präfix, Regex-Tabelle). Das war
 * schon ohne Übersetzung fragil — eine Umformulierung konnte still die Einstufung
 * ändern. Jetzt legt jede Funktion Level und Kategorie ausdrücklich fest.
 *
 * Regeln für neue Meldungen: siehe Kopfkommentar von bots/liquidity/lib/notify.js
 * (gleiches Modell, gleiche Konventionen).
 */

import { existsSync }   from 'fs';
import path             from 'path';
import { config }       from './config.js';
import { getBotConfig } from '../../../lib/bot-registry.js';
import { PATHS }        from '../../../config/paths.js';
import { renderNotification } from '../../../lib/notify-render.js';
import { getLang }      from '../../../lib/i18n.js';

const NEXUS_URL       = 'http://127.0.0.1:3100';
const { displayName: BOT_DISPLAY_NAME } = getBotConfig('lending');
const NEXUS_BOT_ID    = config.botId ?? 'lending';
const UPDATE_SUPPRESS_FLAG = path.join(PATHS.data, 'update-notify-suppress');

/**
 * Während eines FORGE-public-Updates gesetzt (bin/setup-lib/common.sh
 * update_notify_suppress_on) – do_update() sendet am Ende EINE Zusammenfassung
 * statt der Einzel-"gestartet"/"gestoppt"-Meldungen jedes neu gestarteten Bots
 * (Fund 2026-08-09). Ein Crash-Restart außerhalb eines Updates hat den Marker
 * nicht gesetzt und meldet sich weiterhin wie bisher.
 */
export function isUpdateInProgress() {
    return existsSync(UPDATE_SUPPRESS_FLAG);
}

function log(msg) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${ts}] ${msg}`);
}

// ─── Handlungsaufforderungen ──────────────────────────────────────────────────
//
// 🔒 Regel (Betreiber-Vorgabe 2026-07-30): jede Meldung endet mit einem Satz, der
// sagt was zu tun ist — auch wenn die Antwort "nichts" ist. Adressat ist kein
// IT-Fachmann; ein reiner Befund lässt ihn ratlos zurück.
//
// Bis Schritt 5 wurde die passende Aufforderung aus dem Meldungstext ERRATEN
// (ACTION_RULES-Regex-Tabelle). Jetzt wählt jede Funktion sie ausdrücklich —
// eine neue Meldung kann die Aufforderung nicht mehr stillschweigend verlieren.
const ACTION = {
    fyi:        'notify.act.fyi',
    retrying:   'notify.act.retrying',
    inWallet:   'notify.len.act.in_wallet',
    topUp:      'notify.len.act.top_up',
    topUpRetry: 'notify.len.act.top_up_retry',
    selfHealed: 'notify.len.act.self_healed',
    observePool:'notify.len.act.observe_pool',
    checkPool:  'notify.len.act.check_pool',
    waitPool:   'notify.len.act.wait_pool',
    enablePool: 'notify.len.act.enable_pool',
    restartHint:'notify.len.act.restart_hint',
    autoRestart:'notify.len.act.auto_restart',
    support:    'notify.len.act.support',
    check:      'notify.len.act.check_dashboard',
};

// ─── Interner Sender ──────────────────────────────────────────────────────────

async function send(level, category, msgKey, params = {}) {
    const message = renderNotification(
        { msgKey, params, displayName: BOT_DISPLAY_NAME, timestamp: Date.now() },
        getLang(),
    );
    try {
        const res = await fetch(`${NEXUS_URL}/notify`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                botId: NEXUS_BOT_ID, displayName: BOT_DISPLAY_NAME,
                level, category, message, msgKey, params,
            }),
        });
        if (!res.ok) {
            const err = await res.text();
            log(`[notify] Nexus-Fehler: HTTP ${res.status} – ${err}`);
        }
    } catch (err) {
        log(`[notify] Nexus nicht erreichbar: ${err.message} | ${level} | ${category} | ${msgKey}`);
    }
}

// ─── Lebenszyklus ─────────────────────────────────────────────────────────────

/** @param {string} pools Kommagetrennte Pool-Labels (kanonische Bezeichner, E11) */
export async function startup(pools) {
    if (isUpdateInProgress()) return;
    await send('lifecycle', 'system', 'notify.len.startup', { bot: config.botDisplayName, pools, _action: ACTION.fyi });
}

export async function shutdown(signal) {
    if (isUpdateInProgress()) return;
    await send('lifecycle', 'system', 'notify.len.shutdown', { bot: config.botDisplayName, signal, _action: ACTION.autoRestart });
}

export async function unhandledRejection(message) {
    await send('error', 'system', 'notify.len.unhandled_rejection', { message, _action: ACTION.restartHint });
}

/**
 * Wiederholt fehlgeschlagene Hintergrundaufgabe (APY-Abruf, Balance, Position).
 * @param {{k: string, p?: object}|string} label  Bezeichnung der Aufgabe
 */
export async function taskFailed(label, fails, message) {
    await send('warn', 'system', 'notify.len.task_failed', {
        label, fails, message, _action: ACTION.retrying,
    });
}

// ─── TVL-Schutz ───────────────────────────────────────────────────────────────

export async function tvlAbove(pool, threshold, tvl) {
    await send('warn', 'system', 'notify.len.tvl_above', { pool, threshold, tvl, _action: ACTION.observePool });
}

export async function tvlBelow(pool, threshold, tvl) {
    await send('warn', 'system', 'notify.len.tvl_below', { pool, threshold, tvl, _action: ACTION.observePool });
}

/** Auto-Exit ausgeführt – Kapital wurde aus dem Protokoll gezogen. */
export async function autoExitExecuted(pool, { tvl, threshold, amount, tx, sentTo, sentAmount, sentTx, leftoverLp, leftoverUsdc }) {
    await send('error', 'system', 'notify.len.auto_exit_done', {
        pool, tvl, threshold, amount, tx,
        sendLine: sentTo
            ? { k: 'notify.len.auto_exit_sent', p: { amount: sentAmount, addr: sentTo.slice(0, 8), tx: sentTx } }
            : undefined,
        leftoverLine: leftoverLp
            ? { k: 'notify.len.leftover_lp', p: { lp: leftoverLp, usdc: leftoverUsdc ?? '' } }
            : undefined,
        _action: sentTo ? ACTION.fyi : ACTION.inWallet,
    });
}

export async function autoExitSendFailed(pool, message) {
    await send('warn', 'system', 'notify.len.auto_exit_send_failed', { pool, message, _action: ACTION.inWallet });
}

export async function autoExitFailed(pool, tvl, message) {
    await send('warn', 'system', 'notify.len.auto_exit_failed', { pool, tvl, message, _action: ACTION.checkPool });
}

// ─── Auto-Deploy ──────────────────────────────────────────────────────────────

export async function autoDeploySkippedUnavailable(pool) {
    await send('warn', 'trade', 'notify.len.deploy_skipped_unavailable', { pool, _action: ACTION.waitPool });
}

export async function autoDeploySkippedDisabled(pool) {
    await send('warn', 'trade', 'notify.len.deploy_skipped_disabled', { pool, _action: ACTION.enablePool });
}

export async function autoDeploySkippedNoPools(funds) {
    await send('warn', 'trade', 'notify.len.deploy_skipped_no_pools', { funds, _action: ACTION.waitPool });
}

/**
 * @param {boolean} allOk       false = einzelne Schritte sind fehlgeschlagen
 * @param {string}  results     Fertige Ergebniszeilen (Pool-IDs + Beträge, keine Prosa)
 * @param {string|undefined} capped  optionaler Deckelungshinweis
 */
export async function autoDeployDone(allOk, { detected, invested, capped, results }) {
    await send(allOk ? 'info' : 'warn', 'trade',
        allOk ? 'notify.len.deploy_done' : 'notify.len.deploy_partial', {
            detected, invested, results,
            // Leerstring statt undefined: der Hinweis steht MITTEN in der Zeile —
            // ein fehlender Parameter würde die ganze Zeile verschlucken
            // (Konvention 1 in notify-render.js gilt zeilenweise).
            cappedNote: capped ? { k: 'notify.len.deploy_capped', p: { rest: capped } } : '',
            _action:    allOk ? ACTION.fyi : ACTION.retrying,
        });
}

// ─── SOL-Reserve ──────────────────────────────────────────────────────────────

export async function solReserveCritical(sol, usdc) {
    await send('warn', 'system', 'notify.len.sol_critical', { sol, usdc, _action: ACTION.topUp });
}

export async function solTopupDone(usdc, sol, before) {
    await send('info', 'system', 'notify.len.sol_topup_done', { usdc, sol, before, _action: ACTION.selfHealed });
}

export async function solTopupFailed(message, sol) {
    await send('error', 'system', 'notify.len.sol_topup_failed', { message, sol, _action: ACTION.topUpRetry });
}

// ─── Withdraw / Move ──────────────────────────────────────────────────────────

/** LP-Reste nach einem Withdraw – Restake nötig, Support kontaktieren. */
export async function lpRemainder(pool, message) {
    await send('warn', 'system', 'notify.len.lp_remainder', { pool, message, _action: ACTION.support });
}

export { ACTION };
