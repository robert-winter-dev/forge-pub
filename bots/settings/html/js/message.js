/**
 * FORGE Message Center – genau ein Vollbreite-Panel, keine eigene Navigation mehr
 *
 * Menüpunkte: System (read-only Spiegel der Notifications aus nexus.db), Premium
 * (humanisierte Premium-Protokoll-Nachrichten, kein JSON-Rohtext), Support
 * (Nostr-DM-Inbox), Einstellungen (Sound/Popups + Nostr-Identität).
 *
 * Die Umschaltung zwischen den vier Rubriken lief bis 2026-08-08 über ein
 * eigenes Spalten-Menü links; das ist entfallen – Navigation läuft seitdem
 * nur noch über das Hamburger-Menü (Gruppe "Message Center" in nav.js), das
 * per #system/#support/#premium/#einstellungen auf message.html verlinkt. Ein
 * hashchange-Listener (unten) fängt Klicks ab, während die Seite schon offen
 * ist – ohne den würde nur die URL sich ändern, aber nichts sichtbar passieren.
 *
 * System/Premium/Support teilen sich seit 2026-07-30 dieselbe Grundstruktur:
 * Titel links / Suche rechts in der Toprow (Support zusätzlich mit "Neue
 * Nachricht" ganz rechts), darunter eine Tabelle mit identischer Spaltenbreite
 * in allen drei Rubriken (Thema/Absender/Datum – seit 2026-08-08 statt der
 * vorherigen festen Boxen, siehe mctTableHtml()), Pagination + "alle
 * gelesen"-Haken unten. Löschen (nur Support) läuft über "Konversation
 * löschen" im Thread-Modal, keine eigene Tabellenspalte (siehe supportRowHtml()
 * -Kommentar). Einstellungen ist die einzige verbleibende Nutzerin der alten
 * Detail-Spalte (#mcDetail) – die frühere Kurzform-Liste (#mcList) wurde
 * komplett entfernt, seitdem keine der vier Ansichten sie mehr braucht.
 */

import { initNav, initFooter, setNavBadge, setNavCurrent } from '/forge/js/nav.js?v=20260808h';
import { showToast } from '/forge/js/toast.js?v=20260722b';
import { showModal, closeModal } from '/forge/js/modal.js?v=20260731a';
import {
    initMessageBell, isNotifyEnabled, loadNotifySettings, setNotifyEnabled, getOldestUnreadCategory,
} from '/forge/js/message-bell.js?v=20260809a';

// Deep-Link aus dem Hamburger-Menü: #system | #support | #premium | #einstellungen
const VALID_MENUS = ['system', 'support', 'premium', 'einstellungen'];
const hashMenu = location.hash.slice(1);
const initialMenu = VALID_MENUS.includes(hashMenu) ? hashMenu : 'system';

initNav({ current: `message-${initialMenu}` });
initFooter({ botName: 'Message Center' });

// ── Helfer ───────────────────────────────────────────────────────────────────
function fmtDateTime(ts) {
    return new Date(ts).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    }) + ' Uhr';
}
// Lange Form für die Absender-Zeile in der Detailansicht: vierstelliges Jahr, kein
// Komma ("30.07.2026 13:10 Uhr", Vorgabe 2026-07-30). Bewusst NICHT in den
// Listen-/Box-Köpfen verwendet – dort ist die Spalte schmal (white-space: nowrap)
// und die Kurzform genügt, weil der Kontext daneben steht.
function fmtDateTimeLong(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
        + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}
function fmtTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())} Uhr`;
}
function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function shortPeer(npub) {
    return npub && npub.length > 20 ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : (npub ?? '');
}
// TX-Signaturen (~88 Zeichen) sind deutlich länger als die Solana-Adressen (~44), neben
// denen sie stehen (z.B. Premium-Zahlungs-Detail "An"/"TX") - kürzen auf ungefähr
// dieselbe Anzeigelänge, statt wie shortPeer() auf die kürzere Pubkey-Konvention.
function truncateToAddressLength(s, keepEachSide = 20) {
    return s && s.length > keepEachSide * 2 + 1 ? `${s.slice(0, keepEachSide)}…${s.slice(-keepEachSide)}` : (s ?? '');
}
/**
 * Nur der Nick, ohne Pubkey (Support-Übersichtsliste, Vorgabe vom 2026-08-08).
 * Der Anzeigename ist reiner Freitext im Nostr-Profil (kind 0) – keine eindeutige
 * Kennung, zwei Accounts könnten sich identisch nennen (siehe Support-Chat vom
 * 2026-07-23: "FORGE" als Beispiel). Das ist hier bewusst in Kauf genommen –
 * die eindeutige npub bleibt im Thread-Modal (peerLabelWithNpub() unten)
 * weiterhin sichtbar, dort wo tatsächlich mit der Gegenstelle interagiert wird.
 */
function nickOrNone(peerName) {
    return peerName ? esc(peerName) : 'no nick';
}

/** Kopiert eine volle npub in die Zwischenablage – Klick-Ziel ist .msg-npub-copy
 *  (siehe peerLabelWithNpub() und der globale Klick-Handler am Dateiende). */
async function copyNpub(npub) {
    if (!npub) return;
    try {
        await navigator.clipboard.writeText(npub);
        showToast('npub in die Zwischenablage kopiert', 'success');
    } catch {
        showToast('Kopieren fehlgeschlagen', 'error');
    }
}

/**
 * Absender-/Empfänger-Anzeige im Support-Thread-Modal ("Von"/"Mit"): Nick (falls
 * vorhanden) + gekürzte npub in Klammern, klickbar – kopiert beim Klick die volle
 * npub (siehe copyNpub()). Anders als nickOrNone() (Listenansicht) bleibt die npub
 * hier sichtbar, weil man an dieser Stelle tatsächlich mit der Gegenstelle
 * kommuniziert und sie eindeutig verifizieren können muss.
 */
function peerLabelWithNpub(npub, peerName) {
    const short = npub
        ? `<span class="msg-peer-pubkey msg-npub-copy" data-npub="${esc(npub)}" title="npub kopieren">(${esc(shortPeer(npub))})</span>`
        : '';
    return peerName ? `${esc(peerName)} ${short}` : (short || 'Lade…');
}

// ── Zustand ──────────────────────────────────────────────────────────────────
let activeMenu   = null;   // 'system' | 'support' | 'premium' | 'einstellungen'
let activePeer   = null;   // Support: Gegenstelle des gerade offenen Thread-Modals
let systemCache  = [];     // aktuelle Seite (max. 10 Einträge)
let systemPage    = 1;
let systemSearchQuery = '';
let systemTotalPages  = 1;
let premiumCache = [];

/** Verzögert fn um delay ms nach dem letzten Aufruf – für Live-Suche beim Tippen. */
function debounce(fn, delay = 250) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

const elDetailBody = document.getElementById('mcDetailBody');

// ── Ungelesen-Zähler je Rubrik (Badge an "System"/"Support"/"Premium" im
// Hamburger-Menü, seit 2026-08-08 – vorher am jetzt entfallenen Spalten-Menü). ──
// System-Lesestatus liegt seit 2026-08-03 server-seitig im read-Flag (nexus.db,
// siehe notify-db.js) statt im localStorage – unreadCount kommt fertig aus
// /api/messages/system, "gelesen markieren" geht über POST .../system/mark-read.
// Damit sind Brief-Icon (message-bell.js) und Nav-Badge hier automatisch
// synchron, auch über mehrere Geräte hinweg (vorher lief das pro Browser auseinander).

/** key: 'system' | 'support' | 'premium' – entspricht dem Nav-Item-ID-Suffix "message-<key>". */
function setBadge(key, n) {
    setNavBadge(`message-${key}`, n);
}

// Ein deaktiviertes Notification-Toggle (Einstellungen) unterdrückt NUR den
// Zähler – die Nachrichten bleiben beim Öffnen des jeweiligen Menüpunkts normal
// sichtbar, siehe renderSystemPanel()/renderPremiumPanel()/renderSupportPanel().
function updateSystemBadge(unreadCount) {
    setBadge('system', isNotifyEnabled('system') ? unreadCount : 0);
}

/** Vollständige, ungefilterte ID-Liste (unabhängig von einer evtl. aktiven Suche
 *  im System-Tab) – Grundlage für "alle als gelesen". */
async function fetchAllSystemIds() {
    const data = await fetchSystemMessages(1, '');
    return data.allIds ?? [];
}

async function markSystemRead(ids) {
    if (!ids.length) return;
    try {
        await fetch('/api/messages/system/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
    } catch { /* Nexus nicht erreichbar – Badge bleibt beim nächsten Refresh korrekt */ }
}

/** Badge unabhängig vom aktiven Tab aktuell halten (ungefiltert). */
async function refreshSystemBadgeOnly() {
    try {
        const data = await fetchSystemMessages(1, '');
        updateSystemBadge(data.unreadCount ?? 0);
    } catch { setBadge('system', 0); }
}

async function refreshBadges() {
    await loadNotifySettings();
    await refreshSystemBadgeOnly();
    try {
        const r = await fetch('/api/messages/support/unread-count');
        const { unread } = await r.json();
        setBadge('support', isNotifyEnabled('support') ? unread : 0);
    } catch { setBadge('support', 0); }
    try {
        const r = await fetch('/api/messages/premium/unread-count');
        const { unread } = await r.json();
        setBadge('premium', isNotifyEnabled('premium') ? unread : 0);
    } catch { setBadge('premium', 0); }
    // Brief-Icon im Header nutzt sonst seinen eigenen 30s-Poll – ohne diesen
    // Aufruf bliebe die Zahl dort nach "alle als gelesen" bis zu 30s zu hoch.
    await refreshBellBadge();
}

// ── Menü-Umschaltung ─────────────────────────────────────────────────────────
function selectMenu(name) {
    activeMenu = name;
    activePeer = null;
    history.replaceState(null, '', `#${name}`);
    // Panel wird bei message.html nur einmal beim Laden gebaut (initNav()), current
    // ändert sich danach aber bei jedem Tab-Wechsel – ohne das bliebe im Hamburger-
    // Menü immer die Rubrik markiert, die beim Öffnen der Seite aktiv war (Bug 2026-08-08).
    setNavCurrent(`message-${name}`);
    document.getElementById('msgNewBtn').hidden = name !== 'support';

    const isSystem  = name === 'system';
    const isPremium = name === 'premium';
    const isSupport = name === 'support';
    document.getElementById('mcDetail').classList.toggle('mc-hidden-by-panel', isSystem || isPremium || isSupport);
    document.getElementById('mcSystemPanel').hidden  = !isSystem;
    document.getElementById('mcPremiumPanel').hidden = !isPremium;
    document.getElementById('mcSupportPanel').hidden = !isSupport;

    if (isSystem)       { renderSystemPanel(); }
    else if (isPremium) { renderPremiumPanel(); }
    else if (isSupport) { renderSupportPanel(); }
    else if (name === 'einstellungen') { renderSettingsPanel(); }
}

// Rubriken-Umschaltung läuft seit 2026-08-08 nur noch über das Hamburger-Menü
// (Gruppe "Message Center" in nav.js, Links auf message.html#<rubrik>). Ist die
// Seite schon offen, navigiert der Browser innerhalb desselben Dokuments und
// feuert "hashchange" statt neu zu laden - genau das fängt dieser Listener ab
// (selectMenu() selbst nutzt replaceState, das löst kein hashchange aus, also
// keine Doppel-Ausführung beim internen State-Sync).
window.addEventListener('hashchange', () => {
    const name = location.hash.slice(1);
    if (VALID_MENUS.includes(name) && name !== activeMenu) selectMenu(name);
});

// Brief-Icon (immer LAN auf Port 3200): Klick springt in die Rubrik mit der
// ältesten ungelesenen Nachricht (system/support/premium – siehe message-bell.js);
// ohne ungelesene Nachricht bleibt der aktuell offene Menüpunkt einfach stehen.
// Rückgabewert = Badge-Refresh-Funktion, wird von refreshBadges() genutzt, damit
// das Brief-Icon sofort mitzieht statt auf seinen eigenen 30s-Poll zu warten.
const refreshBellBadge = initMessageBell({
    requireLan: false,
    onClick: () => selectMenu(getOldestUnreadCategory() ?? activeMenu ?? 'system'),
});

// ── Menü: System (Vollbreite-Panel, siehe #mcSystemPanel) ───────────────────
async function fetchSystemMessages(page, q) {
    try {
        const params = new URLSearchParams({ page: String(page) });
        if (q) params.set('q', q);
        const r = await fetch(`/api/messages/system?${params}`);
        return await r.json();
    } catch {
        return { notifications: [], page: 1, perPage: 10, totalCount: 0, totalPages: 1, allIds: [], unreadCount: 0 };
    }
}

async function renderSystemPanel() {
    await loadNotifySettings();
    const data = await fetchSystemMessages(systemPage, systemSearchQuery);
    systemCache      = data.notifications ?? [];
    systemTotalPages = Math.min(10, data.totalPages ?? 1);
    if (systemPage > systemTotalPages) systemPage = systemTotalPages;

    updateSystemBadge(data.unreadCount ?? 0);

    const grid = document.getElementById('mcsGrid');
    if (!systemCache.length) {
        grid.innerHTML = '<div class="msg-empty">Keine System-Benachrichtigungen.</div>';
    } else {
        grid.innerHTML = mctTableHtml(systemCache.map(n => systemRowHtml(n)).join(''));
        grid.querySelectorAll('.mct-row').forEach(row => {
            row.addEventListener('click', () => openSystemMessageModal(Number(row.dataset.id)));
        });
    }

    renderSystemPagination();
}

// Der Nachrichtentext selbst trägt seit dem notify.js-Zentralfix (2026-07-30)
// eine eigene "📅 Datum · Bot"-Kopfzeile (wichtig für Telegram/Roh-Log) – hier in
// der Box-Übersicht UND im Detail-Modal aber redundant, weil Datum/Bot bereits
// über eigene UI-Felder (Box-Kopf bzw. Meta-Zeile) angezeigt werden. Nur für
// die Anzeige entfernt, der gespeicherte/rohe Text bleibt unverändert.
function stripNotifyHeader(text) {
    return String(text ?? '').replace(/^📅[^\n]*\n/, '');
}

// Emoji/Icons aus Telegram-Formatierung (🔴⚠️💰🚨 usw.) sind im Message Center nur
// Bildrauschen ohne Zusatzinfo (Level steht separat als Text-Badge/Meta-Zeile) –
// nur für die Anzeige entfernt, gilt für System/Premium/Support gleichermaßen.
function stripEmoji(text) {
    return String(text ?? '')
        .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}]/gu, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/ {2,}/g, ' ')
        .trim();
}

const LEVEL_LABEL = { info: 'Info', warn: 'Warnung', error: 'Fehler', lifecycle: 'Status' };

/**
 * Kopfzeile + Zeilen-HTML zu einer Tabelle zusammensetzen (System/Premium/
 * Support, seit 2026-08-08 – ersetzt die vorherigen festen Boxen, siehe
 * .mct-table-Kommentar in message.css). Eine einzige Spaltenaufteilung für
 * alle drei Rubriken (Pflicht laut Feedback: Thema/Absender/Datum müssen
 * überall exakt gleich breit sein).
 */
function mctTableHtml(rowsHtml) {
    return `<div class="mct-table">
        <div class="mct-header"><span>Thema</span><span>Absender</span><span>Datum</span></div>
        ${rowsHtml}
    </div>`;
}

function systemRowHtml(n) {
    const unread = !n.read;
    const preview = stripEmoji(stripNotifyHeader(n.message));
    // "Status" (lifecycle) im Betreff weggelassen (2026-08-01): Fehler/Warnung/Info
    // bleiben stehen (Farbschwäche-Anforderung), da lifecycle-Meldungen weder Fehler
    // noch Warnung sind, ist die Auszeichnung dort auch am wenigsten wichtig.
    const levelLabel = n.level === 'lifecycle' ? '' : (LEVEL_LABEL[n.level] ?? n.level);
    // Pool-Bezug steht seit 2026-08-08 im Thema statt im Absender (Feedback: "BotName
    // · Pool" im Absender sah unruhig aus). Bei Pool-Meldungen ersetzt "Pool <Pair>:"
    // den Level-Badge – welcher Pool betroffen ist, wiegt hier schwerer als die Art.
    const subject = n.pool
        ? `Pool ${esc(n.pool)}: ${esc(preview)}`
        : `${levelLabel ? `<span class="mct-level">${esc(levelLabel)}</span>` : ''}${esc(preview)}`;
    return `
        <div class="mct-row${unread ? ' unread' : ''}" data-id="${esc(n.id)}">
            <span class="mct-subject">${subject}</span>
            <span class="mct-sender">${esc(n.botName || n.botId)}</span>
            <span class="mct-time">${fmtDateTime(n.timestamp)}</span>
        </div>`;
}

/**
 * Einheitliches Meldungs-Layout (Vorgabe 2026-07-30, Kachel-Kopfzeile kompaktiert
 * 2026-08-01, gilt für alle Kanäle):
 *   Detail-Modal: Titelzeile = Art der Meldung ("Fehler" / "Warnung" / "Info" / "Status"),
 *                 Zeile 2 = Name des betroffenen Bots · Datum + Uhrzeit, darunter der Text.
 *   Übersichtskachel: Bot, Art und Uhrzeit stehen in EINER Kopfzeile (statt Art in
 *                 eigener Zeile), spart eine Zeile Höhe pro Kachel bei gleicher Info.
 *
 * Vorher stand alles drei in einer gemischten Meta-Zeile und der Absender war die
 * rohe botId ("wallet-monitor") — für einen Nicht-Techniker weder Art noch Urheber
 * der Meldung erkennbar. `botName` kommt fertig aufgelöst vom Server (siehe
 * routes/messages.js resolveBotName), inkl. Fallback für Alt-Zeilen ohne
 * gespeicherten Anzeigenamen.
 */
function messageDetailBody({ level, botName, botId, pool, timestamp, message }) {
    const bot = botName || botId || 'System';
    return `
        <div class="mc-detail-card level-${esc(level)}">
            <div class="mc-detail-sender">
                <span class="mc-detail-bot">${esc(bot)}${pool ? ` <span class="mc-detail-pool">· ${esc(pool)}</span>` : ''}</span>
                <span class="mc-detail-when">${fmtDateTimeLong(timestamp)}</span>
            </div>
            <div class="mc-detail-text">${esc(stripEmoji(stripNotifyHeader(message)))}</div>
        </div>`;
}

function openSystemMessageModal(id) {
    const n = systemCache.find(x => x.id === id);
    if (!n) return;
    if (!n.read) {
        n.read = true;
        // refreshBadges() statt nur refreshSystemBadgeOnly() – sonst zieht beim Öffnen
        // einer einzelnen System-Nachricht zwar der Menü-Zähler mit, aber die Zahl am
        // Brief-Icon rechts oben bleibt bis zum nächsten 30s-Poll auf dem alten Stand
        // stehen (Bug, gemeldet 2026-08-08: "alle als gelesen" zog schon immer beide
        // nach, einzelne Nachrichten nur den Menü-Zähler).
        markSystemRead([id]).then(refreshBadges);
        document.querySelector(`.mct-row[data-id="${id}"]`)?.classList.remove('unread');
    }
    const detailModal = showModal({
        id:    'msg-system-detail',
        title: esc(LEVEL_LABEL[n.level] ?? n.level),
        body:  messageDetailBody(n),
        // Weiterleiten bewusst NICHT als gleichrangiger Footer-Button, sondern als
        // eigenständiges Icon links im Footer (footerNote-Slot, siehe modal.js) – soll
        // sich von "Schließen" abheben ("etwas Besonderes"), da hier später ggf. eine
        // Premium-Freischaltung ansetzt. Tooltip per natives title-Attribut (gleiche
        // Konvention wie #msgCopyBtn/#msgQrBtn weiter unten in dieser Datei).
        footerNote: `<button type="button" class="msg-icon-btn msg-icon-btn-accent" id="msgForwardBtn"
            title="Diese Nachricht an den FORGE Support weiterleiten" aria-label="Weiterleiten">↪</button>`,
        actions: [{ label: 'Schließen', onClick: () => closeModal('msg-system-detail') }],
    });
    detailModal.querySelector('#msgForwardBtn').addEventListener('click', () => {
        closeModal('msg-system-detail');
        confirmForwardSystemMessage(n);
    });
}

// Zwischenschritt vor dem Weiterleiten (Feedback 2026-08-09): ein Klick auf das
// Icon soll nicht überraschend direkt in eine neue Support-Nachricht springen –
// erst eine bewusste Rückfrage, dann (nur nach "Weiter") der eigentliche Wechsel.
function confirmForwardSystemMessage(n) {
    const cid = 'msg-forward-confirm';
    showModal({
        id:    cid,
        title: 'Nachricht weiterleiten?',
        body:  '<p style="margin:0;font-size:0.88rem;line-height:1.5">Hast Du eine Frage zu dieser Meldung und möchtest sie an den Support weiterleiten?</p>',
        actions: [
            { label: 'Weiter', onClick: () => { closeModal(cid); forwardSystemMessage(n); } },
            { label: 'Abbrechen', onClick: () => closeModal(cid) },
        ],
    });
}

// Weiterleiten an FORGE Master (Feature 2026-08-09): Statt die Meldung mühsam
// per Copy&Paste in eine neue Support-Nachricht zu übertragen, übernimmt dies
// den kompletten Meldungsinhalt (Art/Bot/Zeitpunkt/Text) als Zitat. Das Zitat
// steht als eigener, nicht editierbarer Block im Compose-Modal (siehe
// openNewMessageModal) – der Nutzer tippt nur seinen Kommentar dazu, Zitat und
// Kommentar werden erst beim Senden mit FORWARD_DIVIDER zusammengefügt (Feedback
// 2026-08-09: vorher lag alles in einer gemeinsamen Textarea, weder klar
// getrennt noch vor versehentlichem Verändern des Zitats geschützt).
// Versand bleibt bewusst manuell (kein Auto-Send).
function forwardSystemMessage(n) {
    const bot = n.botName || n.botId || 'System';
    const quoteText = [
        `Betreff: ${LEVEL_LABEL[n.level] ?? n.level}${n.pool ? ` · ${n.pool}` : ''}`,
        `Von: ${bot}`,
        `Zeitpunkt: ${fmtDateTimeLong(n.timestamp)}`,
        '',
        stripEmoji(stripNotifyHeader(n.message)),
    ].join('\n');
    selectMenu('support');
    openNewMessageModal(quoteText);
}

function renderSystemPagination() {
    const wrap = document.getElementById('mcsPagination');
    if (!wrap) return;
    if (systemTotalPages <= 1) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = Array.from({ length: systemTotalPages }, (_, i) => i + 1)
        .map(p => `<button class="mcs-page-btn${p === systemPage ? ' active' : ''}" data-page="${p}">${p}</button>`)
        .join('');
    wrap.querySelectorAll('.mcs-page-btn').forEach(btn => {
        btn.addEventListener('click', () => { systemPage = Number(btn.dataset.page); renderSystemPanel(); });
    });
}

document.getElementById('mcsMarkAllBtn')?.addEventListener('click', async () => {
    // Immer die VOLLSTÄNDIGE, ungefilterte ID-Liste holen – nicht die (bei aktiver
    // Suche auf die Treffer beschränkte) aktuelle Seiten-Response. Sonst markiert
    // "alle als gelesen" bei aktiver Suche nur die paar Treffer (Bug 2026-07-30).
    const ids = await fetchAllSystemIds();
    await markSystemRead(ids);
    renderSystemPanel();
    refreshBadges();
});
document.getElementById('mcsSearchInput')?.addEventListener('input', debounce((e) => {
    systemSearchQuery = e.target.value.trim();
    systemPage = 1;
    renderSystemPanel();
}));

// ── Menü: Premium (Vollbreite-Panel, gleiche Darstellung wie System) ────────
let premiumPage        = 1;
let premiumSearchQuery = '';
let premiumTotalPages  = 1;

async function fetchPremiumMessages() {
    try {
        const r = await fetch('/api/messages/premium');
        const { messages } = await r.json();
        return messages ?? [];
    } catch {
        return [];
    }
}

function filteredPremiumCache() {
    if (!premiumSearchQuery) return premiumCache;
    const q = premiumSearchQuery.toLowerCase();
    return premiumCache.filter(m =>
        (m.summary ?? '').toLowerCase().includes(q) ||
        (m.detail ?? '').toLowerCase().includes(q) ||
        (m.peerName ?? '').toLowerCase().includes(q)
    );
}

// Kein Pagination-/Such-Parameter auf /api/messages/premium (Premium-Dienst
// liefert ohnehin nur eine überschaubare Menge) – Blättern/Suchen läuft
// deshalb rein clientseitig auf der vollständig geladenen Liste.
async function renderPremiumPanel() {
    premiumCache = await fetchPremiumMessages();
    const filtered = filteredPremiumCache();
    premiumTotalPages = Math.min(10, Math.max(1, Math.ceil(filtered.length / 10)));
    if (premiumPage > premiumTotalPages) premiumPage = premiumTotalPages;
    const pageItems = filtered.slice((premiumPage - 1) * 10, premiumPage * 10);

    const premiumUnread = premiumCache.filter(m => m.direction === 'in' && !m.read).length;
    setBadge('premium', isNotifyEnabled('premium') ? premiumUnread : 0);

    const grid = document.getElementById('mcpGrid');
    if (!pageItems.length) {
        grid.innerHTML = '<div class="msg-empty">Noch keine Premium-Nachrichten.</div>';
    } else {
        grid.innerHTML = mctTableHtml(pageItems.map(m => premiumRowHtml(m)).join(''));
        grid.querySelectorAll('.mct-row').forEach(row => {
            row.addEventListener('click', () => openPremiumMessageModal(Number(row.dataset.id)));
        });
    }

    renderPremiumPagination();
}

// Lokale Ereignisse ohne Gegenstelle (z.B. eine ausgeführte Zahlung, siehe
// premium-pay.js recordPremiumMessage()) haben peerPubkey=null – "FORGE Master"
// wäre hier irreführend (es kam keine DM vom Master), "Diese Instanz" passt zum
// bestehenden Label für abgehende Nachrichten im Detail-Modal.
function premiumRowHtml(m) {
    const unread = m.direction === 'in' && !m.read;
    const sender = m.peerName
        ? esc(m.peerName)
        : (m.peerPubkey ? esc(shortPeer(m.peerPubkey)) : (m.direction === 'out' ? 'Diese Instanz' : 'FORGE Master'));
    return `
        <div class="mct-row${unread ? ' unread' : ''}" data-id="${esc(m.id)}">
            <span class="mct-subject">${esc(stripEmoji(m.summary))}</span>
            <span class="mct-sender">${sender}</span>
            <span class="mct-time">${fmtDateTime(m.timestamp)}</span>
        </div>`;
}

// Eigene Detail-Ansicht für automatische Zahlungen (m.payment gesetzt, siehe
// core/premium/server.js humanizePremiumMessage() Fall 'premium-payment'):
// strukturierte Zeilen statt Fließtext, damit die TX als klickbarer Block-
// Explorer-Link dargestellt werden kann. Empfängeradresse bewusst ungekürzt
// (passt ohne Umbruch), die deutlich längere TX-Signatur wird auf etwa
// Adresslänge gekürzt statt als 88-stellige Roh-Signatur ausgeschrieben.
function premiumPaymentDetailBody(m, sender) {
    const p = m.payment;
    return `
        <div class="mc-detail-card level-info">
            <div class="mc-detail-sender">
                <span class="mc-detail-bot">${esc(sender)}</span>
                <span class="mc-detail-when">${fmtDateTimeLong(m.timestamp)}</span>
            </div>
            <div class="msg-thread-modal-header" style="margin-top:0.6rem;">
                <div class="msg-thread-modal-row">
                    <span class="msg-thread-modal-label msg-thread-modal-label--wide">Betrag</span>
                    <span>${esc(p.amountUsdc)} USDC</span>
                </div>
                <div class="msg-thread-modal-row">
                    <span class="msg-thread-modal-label msg-thread-modal-label--wide">Zeitraum</span>
                    <span>${esc(p.hourRange)}</span>
                </div>
                <div class="msg-thread-modal-row">
                    <span class="msg-thread-modal-label msg-thread-modal-label--wide">An</span>
                    <span class="msg-peer-pubkey">${esc(p.toWallet)}</span>
                </div>
                <div class="msg-thread-modal-row">
                    <span class="msg-thread-modal-label msg-thread-modal-label--wide">TX</span>
                    <span><a href="https://solscan.io/tx/${esc(p.signature)}" target="_blank" rel="noopener" style="color:inherit;">${esc(truncateToAddressLength(p.signature))} ↗</a></span>
                </div>
            </div>
        </div>`;
}

async function openPremiumMessageModal(id) {
    const m = premiumCache.find(x => x.id === id);
    if (!m) return;
    // Gleiches Layout wie System-Meldungen (Titel = Art, Zeile 2 = Absender · Zeit).
    // "Art" ist hier die Richtung: eine eingehende DM vom Datendienst vs. ein
    // lokal protokolliertes Ereignis dieser Instanz — ein Level gibt es nicht.
    // Lokale Ereignisse ohne Gegenstelle (z.B. eine ausgeführte Zahlung) bekommen
    // bewusst kein "von/an X", es kam/ging keine DM.
    const sender = m.peerPubkey
        ? (m.direction === 'in'
            ? (m.peerName ? `${m.peerName} (${shortPeer(m.peerPubkey)})` : shortPeer(m.peerPubkey))
            : 'Diese Instanz')
        : 'Diese Instanz';
    showModal({
        id:    'msg-premium-detail',
        title: m.payment ? 'Automatische Premium Zahlung' : (m.direction === 'in' ? 'Nachricht' : 'Ereignis'),
        body:  m.payment
            ? premiumPaymentDetailBody(m, sender)
            : messageDetailBody({
                level:     'info',
                botName:   sender,
                timestamp: m.timestamp,
                message:   m.detail,
            }),
        actions: [{ label: 'Schließen', onClick: () => closeModal('msg-premium-detail') }],
    });

    if (m.direction === 'in' && !m.read) {
        m.read = true;
        document.querySelector(`.mct-row[data-id="${id}"]`)?.classList.remove('unread');
        const premiumUnread = premiumCache.filter(x => x.direction === 'in' && !x.read).length;
        setBadge('premium', isNotifyEnabled('premium') ? premiumUnread : 0);
        try {
            await fetch(`/api/messages/premium/${id}/read`, { method: 'POST' });
        } catch { /* Netzwerkfehler – Badge korrigiert sich beim nächsten Poll */ }
    }
}

function renderPremiumPagination() {
    const wrap = document.getElementById('mcpPagination');
    if (!wrap) return;
    if (premiumTotalPages <= 1) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = Array.from({ length: premiumTotalPages }, (_, i) => i + 1)
        .map(p => `<button class="mcs-page-btn${p === premiumPage ? ' active' : ''}" data-page="${p}">${p}</button>`)
        .join('');
    wrap.querySelectorAll('.mcs-page-btn').forEach(btn => {
        btn.addEventListener('click', () => { premiumPage = Number(btn.dataset.page); renderPremiumPanel(); });
    });
}

document.getElementById('mcpMarkAllBtn')?.addEventListener('click', async () => {
    const unreadIds = premiumCache.filter(m => m.direction === 'in' && !m.read).map(m => m.id);
    for (const id of unreadIds) {
        const m = premiumCache.find(x => x.id === id);
        if (m) m.read = true;
        try { await fetch(`/api/messages/premium/${id}/read`, { method: 'POST' }); } catch { /* Badge korrigiert sich beim nächsten Poll */ }
    }
    renderPremiumPanel();
    refreshBadges();
});
document.getElementById('mcpSearchInput')?.addEventListener('input', debounce((e) => {
    premiumSearchQuery = e.target.value.trim();
    premiumPage = 1;
    renderPremiumPanel();
}));

// ── Menü: Support (Vollbreite-Panel, gleiche Darstellung wie System/Premium) ─
// Eine Box pro Konversation; Klick öffnet den Verlauf + Antwortfeld im (größeren)
// Modal, Kopfzeile darin zeigt die eigene FORGE-Nostr-Identität wie das
// "Von"-Feld einer E-Mail (Antworten laufen unter dieser Identität).
let supportThreads     = [];
let supportPage        = 1;
let supportSearchQuery = '';
let supportTotalPages  = 1;
let activeThreadId     = null;  // Support: Anliegen (thread_id) des offenen Modals, null = alter Sammel-Thread

// Boxen/Modal identifizieren ein Anliegen über peerPubkey + threadId (nicht nur
// peerPubkey – ein Nutzer kann mehrere getrennte Anliegen mit demselben FORGE
// Master haben, siehe thread_id-Migration im Premium-Dienst). Kodiert als
// "<peerPubkey>::<threadId>" für data-id-Attribute.
function encodeThreadKey(peerPubkey, threadId) { return `${peerPubkey}::${threadId ?? ''}`; }
function decodeThreadKey(key) {
    const i = key.indexOf('::');
    return { peerPubkey: key.slice(0, i), threadId: key.slice(i + 2) || null };
}

async function fetchThreads() {
    try {
        const r = await fetch('/api/messages/support/threads');
        const { threads } = await r.json();
        return threads ?? [];
    } catch {
        return [];
    }
}

function filteredSupportThreads() {
    if (!supportSearchQuery) return supportThreads;
    const q = supportSearchQuery.toLowerCase();
    return supportThreads.filter(t =>
        (t.peerName ?? '').toLowerCase().includes(q) ||
        (t.lastText ?? '').toLowerCase().includes(q)
    );
}

async function renderSupportPanel() {
    supportThreads = await fetchThreads();
    const filtered = filteredSupportThreads();
    supportTotalPages = Math.min(10, Math.max(1, Math.ceil(filtered.length / 10)));
    if (supportPage > supportTotalPages) supportPage = supportTotalPages;
    const pageItems = filtered.slice((supportPage - 1) * 10, supportPage * 10);

    const grid = document.getElementById('mcSupGrid');
    if (!pageItems.length) {
        grid.innerHTML = '<div class="msg-empty">Noch keine Konversationen. Über "Neue Nachricht" eine starten.</div>';
    } else {
        grid.innerHTML = mctTableHtml(pageItems.map(t => supportRowHtml(t)).join(''));
        grid.querySelectorAll('.mct-row').forEach(row => {
            const { peerPubkey, threadId } = decodeThreadKey(row.dataset.id);
            row.addEventListener('click', () => openSupportThreadModal(peerPubkey, threadId));
        });
    }
    renderSupportPagination();
}

// Kein Papierkorb in der Zeile (erstmal entfernt, 2026-08-08): sonst keine
// gleiche Spaltenbreite über alle drei Rubriken hinweg möglich. Löschen läuft
// weiterhin über "Konversation löschen" im Thread-Modal (deleteSupportThread()).
function supportRowHtml(t) {
    const key = esc(encodeThreadKey(t.peerPubkey, t.threadId));
    return `
        <div class="mct-row${t.unreadCount > 0 ? ' unread' : ''}" data-id="${key}">
            <span class="mct-subject">${esc(stripEmoji(stripQuoteMarkers(t.lastText)))}</span>
            <span class="mct-sender">${nickOrNone(t.peerName)}</span>
            <span class="mct-time">${fmtDateTime(t.lastTimestamp)}</span>
        </div>`;
}

function renderSupportPagination() {
    const wrap = document.getElementById('mcSupPagination');
    if (!wrap) return;
    if (supportTotalPages <= 1) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = Array.from({ length: supportTotalPages }, (_, i) => i + 1)
        .map(p => `<button class="mcs-page-btn${p === supportPage ? ' active' : ''}" data-page="${p}">${p}</button>`)
        .join('');
    wrap.querySelectorAll('.mcs-page-btn').forEach(btn => {
        btn.addEventListener('click', () => { supportPage = Number(btn.dataset.page); renderSupportPanel(); });
    });
}

function supportThreadUrl(peerPubkey, threadId) {
    const qs = threadId ? `?threadId=${encodeURIComponent(threadId)}` : '';
    return `/api/messages/support/thread/${peerPubkey}${qs}`;
}

document.getElementById('mcSupMarkAllBtn')?.addEventListener('click', async () => {
    // Kein Bulk-Endpoint – ein Anliegen gilt serverseitig als gelesen, sobald sein
    // Verlauf geladen wird (gleiches Prinzip wie ein Klick auf die Box). Beschränkt
    // auf die aktuelle Suche, wie in der UI sichtbar (gleiche Logik wie bei System).
    const unread = filteredSupportThreads().filter(t => t.unreadCount > 0);
    for (const t of unread) {
        try { await fetch(supportThreadUrl(t.peerPubkey, t.threadId)); } catch { /* Badge korrigiert sich beim nächsten Poll */ }
    }
    await renderSupportPanel();
    refreshBadges();
});
document.getElementById('mcSupSearchInput')?.addEventListener('input', debounce((e) => {
    supportSearchQuery = e.target.value.trim();
    supportPage = 1;
    renderSupportPanel();
}));

async function openSupportThreadModal(peerPubkeyHex, threadId) {
    activePeer     = peerPubkeyHex;
    activeThreadId = threadId;
    const mid = 'msg-support-thread';
    const meLabel = peerLabelWithNpub(currentNpub, currentAlias);

    showModal({
        id:    mid,
        title: '',
        body: `
            <div class="msg-thread-modal-header">
                <div class="msg-thread-modal-row">
                    <span class="msg-thread-modal-label">Von</span>
                    <span>${meLabel}</span>
                </div>
                <div class="msg-thread-modal-row">
                    <span class="msg-thread-modal-label">Mit</span>
                    <span id="msgThreadPeer">Lade…</span>
                </div>
            </div>
            <div class="msg-thread" id="msgThread"><div class="msg-empty">Lade…</div></div>
            <form class="msg-compose" id="msgComposeForm">
                <textarea id="msgComposeInput" rows="3" placeholder="Antworten…" maxlength="1000"></textarea>
                <button type="submit">Senden</button>
            </form>
            <div class="msg-status" id="msgStatus"></div>`,
        actions: [
            { label: 'Konversation löschen', onClick: () => deleteSupportThread(peerPubkeyHex, threadId, mid) },
            { label: 'Schließen', onClick: () => closeModal(mid) },
        ],
        onClose: () => { activePeer = null; activeThreadId = null; },
    });

    document.getElementById('msgComposeForm').addEventListener('submit', onComposeSubmit);
    await loadThreadMessages();
}

// Löscht nur die lokale Kopie (eigene DB) – auf Nostr-Relays bereits verbreitete
// Events bleiben dort bestehen, das lässt sich clientseitig nicht zurückholen.
// Bestätigung über ein eigenes Modal statt window.confirm() (bewusst keine
// nativen Browser-Dialoge) – stapelt sich einfach über das offene Thread-Modal.
// closeThreadModalId ist optional: aus dem Thread-Modal heraus wird dessen ID
// mitgegeben (muss beim Löschen mitschließen), vom Papierkorb-Icon in der
// Tabellenzeile (seit 2026-08-08) direkt ohne offenes Modal aufgerufen –
// closeModal(undefined) ist dann ein sicheres No-op (siehe modal.js).
async function deleteSupportThread(peerPubkeyHex, threadId, closeThreadModalId = null) {
    const confirmMid = 'msg-support-delete-confirm';
    showModal({
        id:    confirmMid,
        title: 'Konversation löschen?',
        body:  '<p style="margin:0;font-size:0.88rem;line-height:1.5">Diese Konversation wird unwiderruflich gelöscht.</p>',
        actions: [
            {
                label: 'Löschen', onClick: async () => {
                    try {
                        const r = await fetch(supportThreadUrl(peerPubkeyHex, threadId), { method: 'DELETE' });
                        const data = await r.json().catch(() => ({}));
                        if (!r.ok) { showToast(data.error ?? 'Löschen fehlgeschlagen', 'error'); return; }
                        closeModal(confirmMid);
                        closeModal(closeThreadModalId);
                        showToast('Konversation gelöscht', 'success');
                        await renderSupportPanel();
                        refreshBadges();
                    } catch {
                        showToast('Löschen fehlgeschlagen (Netzwerk)', 'error');
                    }
                },
            },
            { label: 'Abbrechen', onClick: () => closeModal(confirmMid) },
        ],
    });
}

async function loadThreadMessages() {
    if (!activePeer) return;
    const thread = document.getElementById('msgThread');
    if (!thread) return;
    try {
        const r = await fetch(supportThreadUrl(activePeer, activeThreadId));
        const { messages, peerName, peerNpub } = await r.json();
        const peerEl = document.getElementById('msgThreadPeer');
        if (peerEl) peerEl.innerHTML = peerLabelWithNpub(peerNpub, peerName);
        if (!messages.length) {
            thread.innerHTML = '<div class="msg-empty">Noch keine Nachrichten.</div>';
            return;
        }
        thread.innerHTML = messages.map(m => `
            <div class="msg-item msg-${m.direction}">
                <div class="msg-item-text">${renderMessageBody(m.text)}</div>
                <div class="msg-item-meta">${fmtDateTime(m.timestamp)}</div>
            </div>
        `).join('');
        thread.scrollTop = thread.scrollHeight;
        renderSupportPanel(); // Badge/Preview nach "gelesen" aktualisieren
        refreshBadges();      // Menü-Badge korrekt nachziehen (nur dieses Anliegen wurde gelesen)
    } catch {
        thread.innerHTML = '<div class="msg-empty">⚠️ Verlauf konnte nicht geladen werden.</div>';
    }
}

async function onComposeSubmit(e) {
    e.preventDefault();
    if (!activePeer) return;
    const input = document.getElementById('msgComposeInput');
    const status = document.getElementById('msgStatus');
    const text = input.value.trim();
    if (!text) return;

    status.textContent = 'Sende…';
    try {
        const r = await fetch('/api/messages/support/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, peerPubkey: activePeer, threadId: activeThreadId }),
        });
        const data = await r.json();
        if (!r.ok) {
            status.textContent = `⚠️ ${data.error ?? 'Senden fehlgeschlagen'}`;
            return;
        }
        input.value = '';
        status.textContent = '';
        await loadThreadMessages();
    } catch {
        status.textContent = '⚠️ Senden fehlgeschlagen (Netzwerk)';
    }
}

// ── Identität ────────────────────────────────────────────────────────────────
// Alias/npub/Copy/QR werden nur noch unter "Einstellungen" angezeigt (siehe
// renderSettingsPanel/loadSettingsIdentity) – currentAlias/currentNpub bleiben
// modulweiter Zustand, weil das Support-Thread-Modal sie für die "Von"-Zeile
// braucht (eigene FORGE-Nostr-Identität, unter der geantwortet wird).
let currentNpub  = null;
let currentAlias = null;

// ── Neue Nachricht (Compose-Modal) ───────────────────────────────────────────
async function fetchContacts() {
    try {
        const r = await fetch('/api/messages/contacts');
        if (!r.ok) return [];
        const data = await r.json();
        return Array.isArray(data.contacts) ? data.contacts : [];
    } catch {
        return [];
    }
}

// Empfänger ist fest auf den FORGE Master beschränkt (Menüpunkt heißt "Support")
// – keine freie npub-Eingabe mehr, damit niemand versehentlich (oder durch
// Social Engineering über eine gefälschte npub) mit der falschen Gegenstelle
// statt dem echten Support kommuniziert. Jede neue Nachricht startet außerdem
// ein frisches Anliegen (newThread:true), statt in einen wachsenden Sammel-
// Verlauf zu landen – siehe thread_id-Konzept oben.
document.getElementById('msgNewBtn').addEventListener('click', () => openNewMessageModal());

// Weitergeleitetes Zitat wird im tatsächlich versendeten Text mit diesen Markern
// umschlossen (Feedback 2026-08-09: eine reine Text-Trennlinie zwischen Zitat und
// Kommentar reichte der Empfängerseite nicht – beides wirkte im Thread trotzdem
// wie ein einziger, schwer lesbarer Block). renderMessageBody() weiter unten
// erkennt diese Marker beim Rendern (auf BEIDEN Seiten – Absender-Vorschau direkt
// nach dem Senden UND FORGE Master, die dasselbe loadThreadMessages() nutzen) und
// stellt den Inhalt dazwischen als eigenen, optisch hervorgehobenen Block dar
// (gleiche Optik wie der nicht editierbare Zitat-Block im Compose-Modal). Bewusst
// einfache Text-Marker statt echtem HTML: bleiben auch für einen fremden
// Nostr-Client der Gegenstelle als Klartext lesbar, falls der doch mal ohne
// unser Rendering auskommt.
const QUOTE_OPEN  = '<quote>';
const QUOTE_CLOSE = '</quote>';

// Für Vorschau-Texte (Support-Übersichtstabelle, siehe supportRowHtml) – dort
// wird nur ein einzeiliger Ausschnitt gezeigt, kein eigener Zitat-Block wie im
// Thread. Die Marker selbst sind reine Render-Hilfe und sollen dort nicht als
// Rohtext auftauchen (Fund 2026-08-09, Screenshot: "<quote> Betreff: …").
function stripQuoteMarkers(text) {
    return String(text ?? '')
        .replace(new RegExp(`${QUOTE_OPEN}\\n?`, 'g'), '')
        .replace(new RegExp(`\\n?${QUOTE_CLOSE}`, 'g'), '');
}

// Zerlegt eine Thread-Nachricht in einen optionalen Zitat-Block + den Rest und
// baut daraus sicheres HTML (escaped) – zentral genutzt von loadThreadMessages(),
// damit Absender- und Empfänger-Ansicht identisch aussehen.
function renderMessageBody(rawText) {
    const m = new RegExp(`^${QUOTE_OPEN}\\n([\\s\\S]*?)\\n${QUOTE_CLOSE}\\n*([\\s\\S]*)$`).exec(rawText ?? '');
    if (!m) return `<div class="msg-own-comment">${esc(stripEmoji(rawText))}</div>`;
    const quoteHtml   = esc(stripEmoji(m[1])).replace(/\n/g, '<br>');
    const commentHtml = esc(stripEmoji(m[2]));
    return `
        <div class="msg-quote-label">↪ Weitergeleitete Meldung</div>
        <div class="msg-quote-block">${quoteHtml}</div>
        ${commentHtml ? `<div class="msg-own-comment">${commentHtml}</div>` : ''}`;
}

// quoteText: Zitat einer weiterzuleitenden System-Meldung (siehe
// forwardSystemMessage) – wird als eigener, NICHT editierbarer Block über der
// Textarea angezeigt, nicht mehr mit ihr vermischt (Feedback 2026-08-09: vorher
// lagen Zitat und Kommentar in einem gemeinsamen, frei bearbeitbaren Feld ohne
// erkennbare Trennung). null/leer beim normalen "Neue Nachricht"-Button.
async function openNewMessageModal(quoteText = null) {
    const contacts = await fetchContacts();
    const master = contacts.find(c => c.id === 'forge-master');

    showModal({
        id: 'msg-new',
        title: 'Neue Nachricht',
        body: `
            <div class="msg-modal-field">
                <label>An</label>
                <div class="mcs-infotext">${master
                    ? `${esc(master.label)} <span class="msg-peer-pubkey">(${esc(shortPeer(master.npub))})</span>`
                    : '⚠️ FORGE-Master-Kontakt nicht verfügbar'}</div>
            </div>
            ${quoteText ? `
            <div class="msg-modal-field">
                <label>Weitergeleitete Meldung (nicht bearbeitbar)</label>
                <div class="msg-quote-block msg-quote-block-compose">${esc(quoteText).replace(/\n/g, '<br>')}</div>
            </div>` : ''}
            <div class="msg-modal-field">
                <label for="msgNewText">${quoteText ? 'Deine Frage/Anmerkung dazu' : 'Nachricht'}</label>
                <textarea id="msgNewText" rows="6" maxlength="1000" placeholder="${quoteText ? 'Was möchtest Du dazu wissen…' : 'Nachricht…'}"></textarea>
            </div>
            <div class="msg-status" id="msgNewStatus"></div>`,
        actions: [
            { label: 'Senden', onClick: () => sendNewMessage(master, quoteText) },
            { label: 'Abbrechen', onClick: () => closeModal('msg-new') },
        ],
    });
}

async function sendNewMessage(master, quoteText = null) {
    const textInput = document.getElementById('msgNewText');
    const status    = document.getElementById('msgNewStatus');
    const comment   = textInput.value.trim();

    if (!master) { status.textContent = 'FORGE-Master-Kontakt nicht verfügbar.'; return; }
    if (!comment) {
        status.textContent = quoteText
            ? 'Bitte eine Frage/Anmerkung zur weitergeleiteten Meldung eingeben.'
            : 'Bitte eine Nachricht eingeben.';
        return;
    }
    const text = quoteText ? `${QUOTE_OPEN}\n${quoteText}\n${QUOTE_CLOSE}\n\n${comment}` : comment;

    status.textContent = 'Sende…';
    try {
        const r = await fetch('/api/messages/support/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, peerPubkey: master.npub, newThread: true }),
        });
        const data = await r.json();
        if (!r.ok) {
            status.textContent = `⚠️ ${data.error ?? 'Senden fehlgeschlagen'}`;
            return;
        }
        closeModal('msg-new');
        showToast('Nachricht gesendet', 'success');
        openSupportThreadModal(master.pubkeyHex, data.threadId ?? null);
    } catch {
        status.textContent = '⚠️ Senden fehlgeschlagen (Netzwerk)';
    }
}

// ── Menü: Einstellungen (eigenes Verhalten: sofort volles Panel, kein Zwischenschritt) ──
async function renderSettingsPanel() {
    elDetailBody.innerHTML = `
        <div class="msg-settings">
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">Kasching-Sound</span>
                    <span class="msg-setting-hint">Ton bei neuen Umsätzen (Fee-Claims / Yield)</span>
                </span>
                <input type="checkbox" id="setSound">
            </label>
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">Umsatz-Popups</span>
                    <span class="msg-setting-hint">Toast-Einblendungen bei neuen Umsätzen</span>
                </span>
                <input type="checkbox" id="setPopups">
            </label>
            <p class="msg-settings-note">
                Gilt für alle lokalen Dashboards (gleiche Origin).
            </p>

            <h3 class="msg-settings-heading">Benachrichtigungen</h3>
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">System-Nachrichten</span>
                    <span class="msg-setting-hint">Zähler oben (Menü + Brief-Icon) bei neuen System-Meldungen. Ausgeschaltet: keine Zähler/Hinweise, die Nachrichten bleiben im System-Tab trotzdem sichtbar.</span>
                </span>
                <input type="checkbox" id="setNotifySystem">
            </label>
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">Support-Nachrichten</span>
                    <span class="msg-setting-hint">Zähler oben (Menü + Brief-Icon) bei neuen Antworten. Ausgeschaltet: keine Zähler/Hinweise, die Konversationen bleiben im Support-Tab trotzdem sichtbar.</span>
                </span>
                <input type="checkbox" id="setNotifySupport">
            </label>
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">Premium-Nachrichten</span>
                    <span class="msg-setting-hint">Zähler oben (Menü + Brief-Icon) bei neuen Premium-Meldungen. Ausgeschaltet: keine Zähler/Hinweise, die Nachrichten bleiben im Premium-Tab trotzdem sichtbar.</span>
                </span>
                <input type="checkbox" id="setNotifyPremium">
            </label>

            <h3 class="msg-settings-heading">Nostr-Account</h3>
            <div class="msg-account-row">
                <span class="msg-setting-label">Identität (npub)</span>
                <div class="mc-identity" id="msgIdentity">
                    <span class="msg-identity-text" id="msgIdentityText">Lade Identität…</span>
                    <button type="button" class="msg-icon-btn" id="msgCopyBtn" title="npub kopieren" aria-label="npub kopieren" hidden>⧉</button>
                    <button type="button" class="msg-icon-btn" id="msgQrBtn" title="QR-Code anzeigen" aria-label="QR-Code anzeigen" hidden>▦</button>
                </div>
            </div>
            <div class="msg-account-row">
                <span class="msg-setting-label">Anzeigename</span>
                <div class="msg-account-controls">
                    <input type="text" id="setAlias" maxlength="60" placeholder="FORGE Public User">
                    <button type="button" id="setAliasBtn" class="msg-account-btn">Speichern</button>
                </div>
            </div>
            <div class="msg-account-row">
                <span class="msg-setting-label">Account zurücksetzen</span>
                <span class="msg-setting-hint" id="msgResetHint">
                    Erzeugt einen neuen Nostr-Account. Der bisherige Account und
                    <strong>alle bisherigen Nachrichten</strong> werden dabei
                    unwiderruflich gelöscht.
                </span>
                <div class="msg-account-controls">
                    <button type="button" id="setRegenBtn" class="msg-account-btn">Zurücksetzen…</button>
                </div>
            </div>
            <div class="msg-status" id="msgAccountStatus"></div>
        </div>`;

    const SOUND_KEY = 'forge_earningsSoundEnabled';   // 'false' = aus
    const MUTE_KEY  = 'forge_hub_muted';              // 'true'  = Popups aus
    const setSound  = document.getElementById('setSound');
    const setPopups = document.getElementById('setPopups');
    setSound.checked = localStorage.getItem(SOUND_KEY) !== 'false';
    setSound.addEventListener('change', () => localStorage.setItem(SOUND_KEY, String(setSound.checked)));
    setPopups.checked = localStorage.getItem(MUTE_KEY) !== 'true';
    setPopups.addEventListener('change', () => localStorage.setItem(MUTE_KEY, String(!setPopups.checked)));

    // Betrifft ausschließlich Zähler/Badges (Menü + Brief-Icon) – die Nachrichten
    // selbst bleiben immer sichtbar, siehe isNotifyEnabled() in message-bell.js.
    const NOTIFY_CHECKBOX_IDS = { system: 'setNotifySystem', support: 'setNotifySupport', premium: 'setNotifyPremium' };
    await loadNotifySettings();
    for (const [type, elId] of Object.entries(NOTIFY_CHECKBOX_IDS)) {
        const cb = document.getElementById(elId);
        if (!cb) continue;
        cb.checked = isNotifyEnabled(type);
        cb.addEventListener('change', () => {
            setNotifyEnabled(type, cb.checked).then(refreshBadges);
        });
    }

    document.getElementById('setAliasBtn').addEventListener('click', onSaveAlias);
    document.getElementById('setRegenBtn').addEventListener('click', onRegenerateClick);

    loadSettingsIdentity();
}

async function loadSettingsIdentity() {
    const aliasInput = document.getElementById('setAlias');
    const regenBtn   = document.getElementById('setRegenBtn');
    const regenHint  = document.getElementById('msgResetHint');
    const idTextEl   = document.getElementById('msgIdentityText');
    try {
        const r = await fetch('/api/messages/identity');
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            if (idTextEl) idTextEl.textContent = `⚠️ ${err.error ?? 'Identität nicht verfügbar'}`;
            return;
        }
        const id = await r.json();
        currentNpub  = id.npub;
        currentAlias = id.alias || id.name;
        if (aliasInput && id.alias) aliasInput.value = id.alias;
        if (idTextEl) {
            idTextEl.innerHTML = `<b>${esc(currentAlias)}</b> · npub: <code>${shortPeer(id.npub)}</code>`;
            document.getElementById('msgCopyBtn').hidden = false;
            document.getElementById('msgQrBtn').hidden = false;
        }
        // FORGE Master: npub muss stabil bleiben, damit ihn Gegenstellen (u.a. FORGE.pub-
        // Forks) weiterhin finden – Reset serverseitig gesperrt (siehe /identity/regenerate),
        // hier zusätzlich in der UI sichtbar machen statt nur den Klick scheitern zu lassen.
        if (id.resetLocked) {
            regenBtn.disabled = true;
            regenBtn.title = 'Auf dem FORGE Master gesperrt';
            regenHint.textContent =
                'Auf dem FORGE Master gesperrt: andere Nostr-Clients (u.a. FORGE.pub-Forks) ' +
                'müssten die neue npub erst wieder finden. Der Anzeigename kann trotzdem ' +
                'geändert werden.';
        }
    } catch {
        if (idTextEl) idTextEl.textContent = '⚠️ Nostr-Service nicht erreichbar';
        // Identität sonst nicht verfügbar – Panel bleibt trotzdem bedienbar (nur ohne Vorbefüllung).
    }

    document.getElementById('msgCopyBtn')?.addEventListener('click', async () => {
        if (!currentNpub) return;
        try {
            await navigator.clipboard.writeText(currentNpub);
            showToast('npub kopiert', 'success');
        } catch {
            showToast('Kopieren fehlgeschlagen', 'error');
        }
    });

    document.getElementById('msgQrBtn')?.addEventListener('click', () => {
        if (!currentNpub) return;
        showModal({
            id: 'msg-qr',
            title: 'Nostr-Kontakt scannen',
            body: `
                <div class="qr-wrapper" style="margin: 0 auto;">
                    <img class="qr-img" alt="Nostr-QR-Code" src="/api/messages/identity/qr">
                </div>
                <div class="msg-qr-hint" style="text-align:center;margin-top:0.75rem;">
                    In Amethyst per „QR scannen" als Kontakt hinzufügen.
                </div>`,
            actions: [{ label: 'Schließen', onClick: () => closeModal('msg-qr') }],
        });
    });
}

async function onSaveAlias() {
    const input = document.getElementById('setAlias');
    const status = document.getElementById('msgAccountStatus');
    const alias = input.value.trim();
    status.textContent = 'Speichere…';
    try {
        const r = await fetch('/api/messages/identity/alias', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias }),
        });
        const data = await r.json();
        if (!r.ok) {
            status.textContent = `⚠️ ${data.error ?? 'Speichern fehlgeschlagen'}`;
            return;
        }
        input.value = data.alias;
        status.textContent = '';
        showToast(`Anzeigename gesetzt: ${data.alias}`, 'success');
    } catch {
        status.textContent = '⚠️ Speichern fehlgeschlagen (Netzwerk)';
    }
}

// Account zurücksetzen: unwiderruflich (neuer Key + alle Nachrichten weg).
// Deshalb ZWEI Hürden – erst dieser Dialog, dann verlangt der Server zusätzlich
// confirm=true. Die Folgen stehen im Klartext im Dialog, nicht nur als Farbe/Icon.
function onRegenerateClick() {
    showModal({
        id: 'msg-regen',
        title: 'Nostr-Account zurücksetzen?',
        body: `
            <p style="margin:0 0 0.75rem;font-size:0.88rem;line-height:1.5">
                Es wird ein <b>neuer</b> Nostr-Account erzeugt. Dabei gehen unwiderruflich verloren:
            </p>
            <ul style="margin:0 0 0.75rem 1.1rem;font-size:0.85rem;line-height:1.6">
                <li>der bisherige Account (deine bisherige npub wird ungültig)</li>
                <li><b>alle bisherigen Nachrichten</b>, auch laufende Konversationen</li>
            </ul>
            <p style="margin:0 0 0.75rem;font-size:0.85rem;line-height:1.5">
                Gegenstellen können dich danach nur noch über die neue npub erreichen.
            </p>
            <div class="msg-modal-field">
                <label for="msgRegenAlias">Anzeigename für den neuen Account (optional)</label>
                <input type="text" id="msgRegenAlias" maxlength="60" placeholder="FORGE Public User">
            </div>
            <div class="msg-status" id="msgRegenStatus"></div>`,
        actions: [
            { label: 'Ja, zurücksetzen', onClick: regenerateAccount },
            { label: 'Abbrechen', onClick: () => closeModal('msg-regen') },
        ],
    });
}

async function regenerateAccount() {
    const status = document.getElementById('msgRegenStatus');
    const alias = document.getElementById('msgRegenAlias').value.trim();
    status.textContent = 'Erzeuge neuen Account…';
    try {
        const r = await fetch('/api/messages/identity/regenerate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: true, alias }),
        });
        const data = await r.json();
        if (!r.ok) {
            status.textContent = `⚠️ ${data.error ?? 'Zurücksetzen fehlgeschlagen'}`;
            return;
        }
        closeModal('msg-regen');
        showToast(`Neuer Nostr-Account aktiv. ${data.deletedMessages} Nachricht(en) gelöscht.`, 'success');
        loadSettingsIdentity();
    } catch {
        status.textContent = '⚠️ Zurücksetzen fehlgeschlagen (Netzwerk)';
    }
}

// ── Live-Push (Server-Sent Events) ──────────────────────────────────────────
// Der Server bekommt neue Nachrichten bereits live über die Nostr-Subscription –
// per SSE landen sie ohne Neuladen/Polling direkt in der offenen Liste bzw. im
// offenen Thread. EventSource verbindet sich bei Abbruch automatisch neu.
function connectMessageStream() {
    const es = new EventSource('/api/messages/support/stream');
    es.addEventListener('support-message', (ev) => {
        refreshBadges();
        if (activeMenu !== 'support') return;
        const payload = JSON.parse(ev.data);
        if (activePeer && activePeer === payload.peerPubkey) loadThreadMessages();
        else renderSupportPanel();
    });
    es.addEventListener('premium-message', () => {
        refreshBadges();
        if (activeMenu === 'premium') renderPremiumPanel();
    });
}

// ── Init + Fallback-Polling ──────────────────────────────────────────────────
// Grobes Sicherheitsnetz, falls die SSE-Verbindung mal steht (z.B. Netzwerk-Hänger).
selectMenu(initialMenu);
connectMessageStream();
refreshBadges();

// currentAlias/currentNpub früh laden – das Support-Thread-Modal zeigt sie in
// der "Von"-Zeile, auch wenn "Einstellungen" in dieser Session noch nie
// geöffnet wurde (dort werden sie sonst erst bei renderSettingsPanel() gesetzt).
fetch('/api/messages/identity').then(r => r.ok ? r.json() : null).then(id => {
    if (!id) return;
    currentNpub  = id.npub;
    currentAlias = id.alias || id.name;
}).catch(() => {});

setInterval(() => {
    if (activeMenu === 'support') { if (activePeer) loadThreadMessages(); else renderSupportPanel(); }
    else if (activeMenu === 'system')  renderSystemPanel();
    else if (activeMenu === 'premium') renderPremiumPanel();
    refreshBadges();
}, 30_000);

// Delegierter Klick-Handler für alle .msg-npub-copy-Spans (siehe peerLabelWithNpub()) –
// delegiert statt einzeln pro Modal-Render verdrahtet, weil showModal() das Markup bei
// jedem Öffnen/Reload (z.B. loadThreadMessages()) komplett neu baut.
document.addEventListener('click', (e) => {
    const el = e.target.closest('.msg-npub-copy');
    if (el?.dataset.npub) copyNpub(el.dataset.npub);
});

document.getElementById('lastUpdate').textContent = 'Letztes Update: ' + fmtTime(Date.now());
