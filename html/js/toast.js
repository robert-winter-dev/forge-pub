/**
 * FORGE – Zentrales Toast-Modul
 *
 * Gemeinsam genutzt von allen Bot-Dashboards, dem Hub und Settings.
 *
 * Zwei Verwendungsarten:
 *
 * 1) Einzelner Toast (z.B. Bestätigung nach Speichern/Aktion):
 *      import { showToast } from '/forge/js/toast.js';
 *      showToast('Cleanup gespeichert', 'success');
 *
 * 2) Notification-Feed mit Dedup/Mute (Bot-Dashboards):
 *      import { ToastManager } from '../../js/toast.js';
 *      const toast = new ToastManager();
 *      toast.update(data.notifications);   // in jedem Render-Zyklus aufrufen
 *
 * Voraussetzungen im HTML:
 *   <div class="toast-container" id="toastContainer"></div>
 *   CSS: css/toast.css einbinden (Levels: info/success/warn/error/earnings).
 *
 * Notification-Objekte (ToastManager):
 *   { timestamp?, ts?, level, message, pair? }
 *   Akzeptiert sowohl „timestamp" (SpotGridBot) als auch „ts" (LendingBot).
 */

/**
 * Zeigt einen einzelnen Toast an und entfernt ihn nach einer vom Level
 * abhängigen Zeit selbst wieder (oder sofort bei Klick).
 *
 * @param {string} message
 * @param {'info'|'success'|'warn'|'error'|'earnings'} [level='info']
 * @param {object} [opts]
 * @param {string} [opts.pair]  Optionale zweite Zeile (z.B. Pool-/Pair-Name).
 */
export function showToast(message, level = 'info', opts = {}) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast level-${level}`;
    el.innerHTML = opts.pair
        ? `<div>${message}</div><div class="toast-pair">${opts.pair}</div>`
        : `<div>${message}</div>`;

    const remove = () => {
        el.classList.add('removing');
        setTimeout(() => el.remove(), 300);
    };
    el.addEventListener('click', remove);
    container.appendChild(el);

    const ms = level === 'error' ? 8_000 : level === 'warn' ? 6_000 : 4_000;
    setTimeout(remove, ms);
}

export class ToastManager {
    /**
     * @param {object} opts
     * @param {string} opts.storageKey  localStorage-Key für letzten gesehenen Timestamp
     * @param {string} opts.muteKey     localStorage-Key für Mute-Flag
     * @param {string} opts.panelId     Element-ID des Notification-Panels (für Open-Erkennung)
     */
    constructor({
        storageKey = 'forge_lastToastTs',
        muteKey    = 'forge_toastsMuted',
        panelId    = 'notifPanel',
    } = {}) {
        this._storageKey = storageKey;
        this._muteKey    = muteKey;
        this._panelId    = panelId;
        this._lastSeenTs = Number(localStorage.getItem(storageKey)) || 0;
        this._muted      = localStorage.getItem(muteKey) === 'true';
    }

    get muted() { return this._muted; }

    /** Mute-Status umschalten. Gibt neuen Zustand zurück. */
    toggleMute() {
        this._muted = !this._muted;
        localStorage.setItem(this._muteKey, String(this._muted));
        return this._muted;
    }

    /**
     * Prüft Notifications auf neue Einträge und zeigt Toasts an.
     *
     * @param {Array}         notifications  Absteigend sortiert (neueste zuerst).
     * @param {boolean|undefined} panelOpen  Optional: Panel-Zustand manuell setzen.
     *                                       Wenn weggelassen, wird panelId-Element geprüft.
     */
    update(notifications, panelOpen) {
        if (!notifications?.length) return;

        // Normalisierung: SpotGridBot nutzt „timestamp", LendingBot „ts"
        const getTs = n => n.timestamp ?? n.ts ?? 0;

        // Bootstrap: kein gültiger Timestamp gespeichert →
        // neuesten als Startpunkt setzen, ohne Toasts anzuzeigen.
        if (!this._lastSeenTs) {
            this._lastSeenTs = getTs(notifications[0]);
            localStorage.setItem(this._storageKey, String(this._lastSeenTs));
            return;
        }

        const newItems = notifications.filter(n => getTs(n) > this._lastSeenTs);
        if (!newItems.length) return;

        // Marker sofort auf neuestes Item setzen (index 0 = höchster Timestamp)
        this._lastSeenTs = getTs(newItems[0]);
        localStorage.setItem(this._storageKey, String(this._lastSeenTs));

        // Nur Ereignisse anzeigen, die gerade eben passiert sind. "Neu" heißt
        // hier nur "neuer als lastSeenTs" – das kann beim ersten Aufruf nach
        // längerer Abwesenheit auch Stunden zurückliegende Events umfassen.
        // Ohne diese Altersgrenze poppen beim Seitenwechsel alte Meldungen auf.
        const now        = Date.now();
        const freshItems = newItems.filter(n => now - getTs(n) < 10_000);
        if (!freshItems.length) return;

        // Panel-Zustand ermitteln wenn nicht explizit übergeben
        if (panelOpen === undefined) {
            const panel = document.getElementById(this._panelId);
            panelOpen = panel ? !panel.classList.contains('hidden') : false;
        }

        if (!panelOpen && !this._muted) {
            freshItems.slice(0, 3).forEach(n => this._show(n));
        }
    }

    _show(n) {
        showToast(n.message, n.level ?? 'info', { pair: n.pair });
    }
}
