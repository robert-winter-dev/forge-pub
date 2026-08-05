/**
 * FORGE – Message-Bell (Brief-Icon → Message Center)
 *
 * Löst das frühere Notification-Panel ab. Verhalten:
 *   - Nur im LAN sichtbar (private IP). Öffentlich (außerhalb des LAN): Brief + Panel werden
 *     entfernt und es findet KEIN Fetch statt → es werden keinerlei
 *     Nachrichtendaten geladen oder zum Webserver exportiert.
 *   - Klick → Message Center (Default: /message.html; per onClick überschreibbar).
 *   - Badge = Summe aus ungelesenen Support-, Premium- und neuen System-Nachrichten
 *     (Nexus-Notifications aus /api/messages/system, z.B. SOL-Limit-Alert oder
 *     Bot-Lifecycle-Meldungen bei Start/Stop – ersetzt seit 2026-07-28 die
 *     permanenten Inline-Banner auf den Bot-Dashboards, siehe html/liquidity/js/app.js).
 *     "Ungelesen" bei System-Nachrichten kommt seit 2026-08-03 server-seitig aus
 *     dem read-Flag in nexus.db (unreadCount in der /api/messages/system-Antwort,
 *     geschrieben über POST /api/messages/system/mark-read → Nexus → notify-db.js).
 *     Vorher lief der Status rein client-seitig per ID-Set in localStorage – das
 *     bedeutete: auf einem zweiten Gerät (z.B. Laptop vs. PC) blieb das Badge trotz
 *     "alle als gelesen" auf dem anderen Gerät hängen, weil jeder Browser sein
 *     eigenes localStorage hatte. Menü-Zähler im Message Center (message.js) und
 *     dieses Modul lesen jetzt denselben Server-Wert, können also nie mehr auseinanderlaufen.
 *   - Jede der drei Kategorien lässt sich unter Einstellungen → Benachrichtigungen
 *     einzeln abschalten (isNotifyEnabled()): dann trägt sie weder zu diesem
 *     Badge noch zum jeweiligen Menü-Zähler im Message Center bei – die
 *     Nachrichten selbst bleiben dort trotzdem normal sichtbar, nur ohne Zähler.
 *     Auch diese drei Toggles kommen seit 2026-08-03 server-seitig (Nexus
 *     GET/POST /notifications/settings, hier via loadNotifySettings()/
 *     setNotifyEnabled() gecacht) statt aus localStorage – sonst zeigte ein Gerät
 *     ein abgeschaltetes Premium-Badge, ein anderes (nie umgestelltes) Gerät
 *     denselben Zähler weiterhin an, obwohl es dieselbe FORGE-Installation ist.
 *
 * Die Umsatz-/Bot-Event-Toasts laufen unabhängig weiter (EarningsToast/ToastManager
 * pollen selbst) – dieses Modul steuert ausschließlich das Brief-Icon.
 */

/** true, wenn die Seite über eine private IP (LAN) aufgerufen wird. */
export function isLanAccess() {
    const h = window.location.hostname;
    return /^192\.168\./.test(h)
        || /^10\./.test(h)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
        || h === 'localhost';
}

// ── Benachrichtigungen pro Kategorie an/aus (Einstellungen im Message Center) ──
// Default AN, server-seitig in nexus.db (Tabelle settings, siehe notify-db.js).
// Betrifft ausschließlich Zähler/Badges, niemals die Sichtbarkeit der Nachrichten
// selbst im Message Center. isNotifyEnabled() bleibt bewusst synchron (wird an
// vielen Stellen inline in Badge-Berechnungen aufgerufen) – dafür wird der Stand
// per loadNotifySettings() einmalig gecacht, mit "alle an" als Default bis die
// erste Server-Antwort da ist (gleiches Verhalten wie der alte localStorage-Default).
let _notifySettings = { system: true, support: true, premium: true };
let _notifySettingsPromise = null;

/** Lädt die Toggles vom Server (einmalig, danach aus dem Cache) – vor der ersten
 *  Badge-Berechnung abwarten (siehe refreshUnread() unten, message.js). */
export function loadNotifySettings() {
    if (!_notifySettingsPromise) {
        _notifySettingsPromise = fetch('/api/messages/notify-settings')
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data) _notifySettings = { ..._notifySettings, ...data }; })
            .catch(() => { /* Server nicht erreichbar → Defaults (alle an) bleiben aktiv */ });
    }
    return _notifySettingsPromise;
}

export function isNotifyEnabled(type) {
    return _notifySettings[type] !== false;
}

/** Toggle setzen – aktualisiert den Cache sofort (optimistic) und persistiert am Server. */
export async function setNotifyEnabled(type, enabled) {
    _notifySettings = { ..._notifySettings, [type]: enabled };
    try {
        await fetch('/api/messages/notify-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, enabled }),
        });
    } catch { /* Server nicht erreichbar – Toggle bleibt bis Reload lokal wirksam */ }
}

/**
 * Initialisiert das Brief-Icon.
 * @param {object}   [opts]
 * @param {boolean}  [opts.requireLan=true]  Wenn true und kein LAN-Zugriff: Bell entfernen.
 *                                           Settings-Seiten (immer LAN, Port 3200) → false.
 * @param {Function} [opts.onClick]          Eigener Klick-Handler (Default: → /message.html).
 * @returns {Function} refreshUnread – manuell aufrufbar, um das Badge sofort neu zu
 *                      zählen (z.B. direkt nach "alle als gelesen" im Message Center,
 *                      statt auf den nächsten 30s-Poll zu warten).
 */
export function initMessageBell({ requireLan = true, onClick = null } = {}) {
    const bell  = document.getElementById('notifBell');
    const panel = document.getElementById('notifPanel');
    if (panel) panel.remove();            // altes Panel entfällt (→ Message Center)
    if (!bell) return async () => {};

    if (requireLan && !isLanAccess()) {
        bell.remove();                    // öffentlich: kein Brief, kein Fetch, kein Export
        return async () => {};
    }

    bell.title = 'Message Center';
    bell.addEventListener('click', onClick ?? (() => { window.location.href = '/message.html'; }));

    const badge = document.getElementById('notifBadge');
    async function refreshUnread() {
        await loadNotifySettings();
        let supportUnread = 0;
        let systemNew = 0;
        let premiumUnread = 0;

        if (isNotifyEnabled('support')) {
            try {
                const r = await fetch('/api/messages/support/unread-count');
                if (r.ok) ({ unread: supportUnread } = await r.json());
            } catch { /* API nicht erreichbar → Zähler bleibt 0 */ }
        }

        if (isNotifyEnabled('system')) {
            try {
                // unreadCount ist server-seitig aus dem read-Flag berechnet (nexus.db),
                // unpaginiert über die volle Fenstergröße (max. 300, siehe routes/messages.js).
                const r = await fetch('/api/messages/system');
                if (r.ok) ({ unreadCount: systemNew } = await r.json());
            } catch { /* API nicht erreichbar → Zähler bleibt 0 */ }
        }

        if (isNotifyEnabled('premium')) {
            try {
                const r = await fetch('/api/messages/premium/unread-count');
                if (r.ok) ({ unread: premiumUnread } = await r.json());
            } catch { /* API nicht erreichbar → Zähler bleibt 0 */ }
        }

        if (!badge) return;
        const total = supportUnread + systemNew + premiumUnread;
        badge.textContent = total > 99 ? '99+' : String(total);
        badge.classList.toggle('hidden', !total);
    }

    // Bewusst reines Polling (kein SSE): Ein Ungelesen-Badge braucht kein
    // Millisekunden-Update, und eine dauerhafte SSE-Verbindung würde jeden
    // Dashboard-Tab in einen offenen-Verbindungs-Zustand versetzen. 30s-Poll
    // plus Sofort-Refresh beim Zurückkehren auf den Tab genügen völlig.
    refreshUnread();
    setInterval(refreshUnread, 30_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshUnread(); });

    return refreshUnread;
}
