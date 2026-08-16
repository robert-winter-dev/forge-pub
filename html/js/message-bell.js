/**
 * FORGE – Message-Bell (Brief-Icon → Message Center)
 *
 * Löst das frühere Notification-Panel ab. Verhalten:
 *   - Nur im LAN sichtbar (private IP). Öffentlich (außerhalb des LAN): Brief + Panel werden
 *     entfernt und es findet KEIN Fetch statt → es werden keinerlei
 *     Nachrichtendaten geladen oder zum Webserver exportiert.
 *   - Klick auf Icon ODER Zahl (Badge liegt als Kind-Element mit pointer-events:none
 *     im Button, siehe .notif-badge in settings.css → Klick bubbelt zum Button hoch)
 *     → Message Center, und zwar direkt in die Rubrik (system/support/premium) mit
 *     der ältesten ungelesenen Nachricht (Default: /message.html#<rubrik>; per
 *     onClick überschreibbar, siehe message.js). Ohne ungelesene Nachricht einfach
 *     /message.html ohne Hash. getOldestUnreadCategory() exportiert diese Rubrik
 *     auch für Aufrufer, die den Klick selbst behandeln (z.B. message.js, das beim
 *     Klick nur den Tab wechseln statt neu zu laden muss).
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

import { setNavBadge } from './nav.js';

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
// Rubrik mit der ältesten ungelesenen Nachricht (über alle drei Kategorien
// hinweg) – wird bei jedem refreshUnread() neu bestimmt und von der Default-
// Navigation sowie den aufrufenden Seiten (message.js) genutzt, damit ein Klick
// auf Icon ODER Zahl immer zur Rubrik springt, in der am längsten etwas
// ungelesen liegt, statt fest auf eine Rubrik (z.B. "Support") zu verlinken.
let _oldestUnreadCategory = null;

/** Rubrik ('system'|'support'|'premium') mit der ältesten ungelesenen Nachricht, oder
 *  null, wenn nichts ungelesen ist. Erst nach dem ersten refreshUnread() aussagekräftig. */
export function getOldestUnreadCategory() {
    return _oldestUnreadCategory;
}

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
    // Default-Ziel: die Rubrik mit der ältesten ungelesenen Nachricht (siehe
    // refreshUnread() unten); ohne ungelesene Nachricht einfach das Message Center
    // ohne Hash. .notif-badge sitzt als Kind-Element im Button mit pointer-events:none
    // (settings.css), ein Klick auf die Zahl landet also über Bubbling ebenfalls hier
    // – Icon und Zahl führen beide zum selben Ziel.
    bell.addEventListener('click', onClick ?? (() => {
        const cat = _oldestUnreadCategory;
        window.location.href = cat ? `/message.html#${cat}` : '/message.html';
    }));

    const badge = document.getElementById('notifBadge');
    async function refreshUnread() {
        await loadNotifySettings();
        let supportUnread = 0, supportOldest = null;
        let systemNew = 0, systemOldest = null;
        let premiumUnread = 0, premiumOldest = null;

        if (isNotifyEnabled('support')) {
            try {
                const r = await fetch('/api/messages/support/unread-count');
                if (r.ok) ({ unread: supportUnread, oldestUnread: supportOldest } = await r.json());
            } catch { /* API nicht erreichbar → Zähler bleibt 0 */ }
        }

        if (isNotifyEnabled('system')) {
            try {
                // unreadCount/oldestUnread sind server-seitig aus dem read-Flag berechnet
                // (nexus.db), unpaginiert über die volle Fenstergröße (max. 300, siehe
                // routes/messages.js).
                const r = await fetch('/api/messages/system');
                if (r.ok) ({ unreadCount: systemNew, oldestUnread: systemOldest } = await r.json());
            } catch { /* API nicht erreichbar → Zähler bleibt 0 */ }
        }

        if (isNotifyEnabled('premium')) {
            try {
                const r = await fetch('/api/messages/premium/unread-count');
                if (r.ok) ({ unread: premiumUnread, oldestUnread: premiumOldest } = await r.json());
            } catch { /* API nicht erreichbar → Zähler bleibt 0 */ }
        }

        // Älteste ungelesene Nachricht über alle Rubriken hinweg bestimmen (kleinster
        // Zeitstempel gewinnt) – nur Rubriken mit tatsächlich ungelesenen Nachrichten
        // zählen mit.
        const candidates = [
            { key: 'system',  unread: systemNew,      oldest: systemOldest },
            { key: 'support', unread: supportUnread,   oldest: supportOldest },
            { key: 'premium', unread: premiumUnread,   oldest: premiumOldest },
        ].filter(c => c.unread > 0 && c.oldest != null);
        _oldestUnreadCategory = candidates.length
            ? candidates.reduce((a, b) => (a.oldest <= b.oldest ? a : b)).key
            : null;

        const total = supportUnread + systemNew + premiumUnread;
        // Nav-Badge im Hamburger-Menü (Message Center → Nachrichten) mit demselben
        // Fetch aktuell halten – sonst zeigt nur das Brief-Icon im Header den
        // korrekten Stand, während der Menü-Zähler auf Seiten ohne message.js
        // (z.B. index.html) beim ersten Laden leer/versteckt bleibt, bis der Nutzer
        // einmal ins Message Center klickt (Bug 2026-08-09). Seit 2026-08-16 EIN
        // Eintrag mit der Summe statt drei je Rubrik – aufgeschlüsselt wird an den
        // Reitern im Message Center selbst (siehe message.js setUnread()).
        setNavBadge('message-inbox', total);

        if (!badge) return;
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
