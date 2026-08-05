/**
 * FORGE – Zentrales Notification-Rendering
 *
 * Einheitliches Format für alle Notification-Panels:
 *   HH:MM Uhr · BotLabel
 *   Nachricht
 *
 * Verwendung:
 *   import { renderNotifItem } from '../../js/notifications.js';
 *   body.innerHTML = notifs.map(n => renderNotifItem(n)).join('');
 *
 *   // Mit Dismiss-Button (SpotGridBot):
 *   body.innerHTML = notifs.map(n => renderNotifItem(n, { dismissible: true })).join('');
 */

const pad2 = n => String(n).padStart(2, '0');

function fmtTime(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}\u202fUhr`;
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rendert eine einzelne Notification als HTML-String.
 *
 * @param {Object}  n
 * @param {number}  [n.timestamp|n.ts]           Zeitstempel in ms
 * @param {string}  [n.level='info']             'info' | 'warn' | 'error'
 * @param {string}   n.message                   Nachrichtentext
 * @param {string}  [n.pair|n.botLabel|n.bot]    Quell-Label (z.B. 'SOL/USDC', 'LendingBot')
 * @param {*}       [n.id]                       Für data-id Attribut (Dismiss-Logik)
 * @param {Object}  [opts]
 * @param {boolean} [opts.dismissible=false]      Dismiss-Button anzeigen
 * @returns {string} HTML
 */
export function renderNotifItem(n, { dismissible = false } = {}) {
    const ts      = n.timestamp ?? n.ts ?? 0;
    const time    = ts ? fmtTime(ts) : '';
    const bot     = n.bot ?? n.botLabel ?? n.pair ?? '';
    const level   = n.level ?? 'info';
    const idAttr  = n.id != null ? ` data-id="${n.id}"` : '';
    const msg     = escHtml(n.message ?? '');
    const meta    = [time, escHtml(bot)].filter(Boolean).join(': ');
    const dismiss = dismissible
        ? '<button class="notif-item-dismiss" title="Gelesen">✕</button>'
        : '';

    return `<div class="notif-item level-${level}"${idAttr}>
        <div class="notif-item-top">
            <span class="notif-item-meta">${meta}</span>
            ${dismiss}
        </div>
        <div class="notif-item-msg">${msg}</div>
    </div>`;
}
