/**
 * FORGE Message Center – Menü (schmal) + genau ein Vollbreite-Panel
 *
 * Menüpunkte: System (read-only Spiegel der Notifications aus nexus.db), Premium
 * (humanisierte Premium-Protokoll-Nachrichten, kein JSON-Rohtext), Support
 * (Nostr-DM-Inbox), Einstellungen (Sound/Popups + Nostr-Identität).
 *
 * System/Premium/Support teilen sich seit 2026-07-30 dieselbe Darstellung:
 * Filter/Info-Zeile oben, feste Boxen im Grid darunter (überlange Nachrichten
 * werden abgeschnitten, Volltext per Klick im Modal), Pagination + "alle
 * gelesen"-Haken unten. Einstellungen ist die einzige verbleibende Nutzerin
 * der alten Detail-Spalte (#mcDetail) – die frühere Kurzform-Liste (#mcList)
 * wurde komplett entfernt, seitdem keine der vier Ansichten sie mehr braucht.
 */

import { initNav, initFooter } from '/forge/js/nav.js?v=20260731c';
import { showToast } from '/forge/js/toast.js?v=20260722b';
import { showModal, closeModal } from '/forge/js/modal.js?v=20260731a';
import {
    initMessageBell, isNotifyEnabled, loadNotifySettings, setNotifyEnabled,
} from '/forge/js/message-bell.js?v=20260803b';

initNav({ current: 'message' });
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
function firstWords(text, maxChars = 90) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/**
 * Anzeigename ist reiner Freitext im Nostr-Profil (kind 0) – keine eindeutige
 * Kennung. Deshalb immer den (gekürzten) Pubkey mit anzeigen, nie nur den Namen
 * (siehe Support-Chat vom 2026-07-23: mehrere Accounts nennen sich "FORGE").
 */
function peerLabel(peerPubkeyHex, peerName) {
    return peerName
        ? `${esc(peerName)} <span class="msg-peer-pubkey">(${esc(shortPeer(peerPubkeyHex))})</span>`
        : esc(shortPeer(peerPubkeyHex));
}

// ── Zustand ──────────────────────────────────────────────────────────────────
let activeMenu   = null;   // 'system' | 'support' | 'premium' | 'einstellungen'
let activePeer   = null;   // Support: Gegenstelle des gerade offenen Thread-Modals
let systemCache  = [];     // aktuelle Seite (max. 15 Einträge)
let systemPage    = 1;
let systemSearchQuery = '';
let systemTotalPages  = 1;
let premiumCache = [];

/** Verzögert fn um delay ms nach dem letzten Aufruf – für Live-Suche beim Tippen. */
function debounce(fn, delay = 250) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

const elMenu       = document.getElementById('mcMenu');
const elDetailBody = document.getElementById('mcDetailBody');

// ── Ungelesen-Zähler je Menüpunkt (Badge neben "System"/"Support"/"Premium") ──
// System-Lesestatus liegt seit 2026-08-03 server-seitig im read-Flag (nexus.db,
// siehe notify-db.js) statt im localStorage – unreadCount kommt fertig aus
// /api/messages/system, "gelesen markieren" geht über POST .../system/mark-read.
// Damit sind Brief-Icon (message-bell.js) und Menü-Zähler hier automatisch
// synchron, auch über mehrere Geräte hinweg (vorher lief das pro Browser auseinander).

function setBadge(elId, n) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', !n);
}

// Ein deaktiviertes Notification-Toggle (Einstellungen) unterdrückt NUR den
// Zähler – die Nachrichten bleiben beim Öffnen des jeweiligen Menüpunkts normal
// sichtbar, siehe renderSystemPanel()/renderPremiumPanel()/renderSupportPanel().
function updateSystemBadge(unreadCount) {
    setBadge('mcBadgeSystem', isNotifyEnabled('system') ? unreadCount : 0);
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
    } catch { setBadge('mcBadgeSystem', 0); }
}

async function refreshBadges() {
    await loadNotifySettings();
    await refreshSystemBadgeOnly();
    try {
        const r = await fetch('/api/messages/support/unread-count');
        const { unread } = await r.json();
        setBadge('mcBadgeSupport', isNotifyEnabled('support') ? unread : 0);
    } catch { setBadge('mcBadgeSupport', 0); }
    try {
        const r = await fetch('/api/messages/premium/unread-count');
        const { unread } = await r.json();
        setBadge('mcBadgePremium', isNotifyEnabled('premium') ? unread : 0);
    } catch { setBadge('mcBadgePremium', 0); }
    // Brief-Icon im Header nutzt sonst seinen eigenen 30s-Poll – ohne diesen
    // Aufruf bliebe die Zahl dort nach "alle als gelesen" bis zu 30s zu hoch.
    await refreshBellBadge();
}

// ── Menü-Umschaltung ─────────────────────────────────────────────────────────
function selectMenu(name) {
    activeMenu = name;
    activePeer = null;
    elMenu.querySelectorAll('.mc-menu-item').forEach(b => b.classList.toggle('active', b.dataset.menu === name));
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
elMenu.querySelectorAll('.mc-menu-item').forEach(btn => btn.addEventListener('click', () => selectMenu(btn.dataset.menu)));

// Brief-Icon (immer LAN auf Port 3200): Klick springt in den Support-Menüpunkt.
// Rückgabewert = Badge-Refresh-Funktion, wird von refreshBadges() genutzt, damit
// das Brief-Icon sofort mitzieht statt auf seinen eigenen 30s-Poll zu warten.
const refreshBellBadge = initMessageBell({ requireLan: false, onClick: () => selectMenu('support') });

// ── Menü: System (Vollbreite-Panel, siehe #mcSystemPanel) ───────────────────
async function fetchSystemMessages(page, q) {
    try {
        const params = new URLSearchParams({ page: String(page) });
        if (q) params.set('q', q);
        const r = await fetch(`/api/messages/system?${params}`);
        return await r.json();
    } catch {
        return { notifications: [], page: 1, perPage: 15, totalCount: 0, totalPages: 1, allIds: [], unreadCount: 0 };
    }
}

async function renderSystemPanel() {
    await loadNotifySettings();
    const data = await fetchSystemMessages(systemPage, systemSearchQuery);
    systemCache      = data.notifications ?? [];
    systemTotalPages = Math.min(20, data.totalPages ?? 1);
    if (systemPage > systemTotalPages) systemPage = systemTotalPages;

    updateSystemBadge(data.unreadCount ?? 0);

    const grid = document.getElementById('mcsGrid');
    if (!systemCache.length) {
        grid.innerHTML = '<div class="msg-empty">Keine System-Benachrichtigungen.</div>';
    } else {
        grid.innerHTML = systemCache.map(n => systemBoxHtml(n)).join('');
        grid.querySelectorAll('.mcs-box').forEach(box => {
            box.addEventListener('click', () => openSystemMessageModal(Number(box.dataset.id)));
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

function systemBoxHtml(n) {
    const unread = !n.read;
    const preview = stripEmoji(stripNotifyHeader(n.message));
    // "Status" (lifecycle) in der Kopfzeile weggelassen (2026-08-01):
    // die Zeile wurde mit Bot-Name + Art + Uhrzeit zu voll/unleserlich. Fehler/Warnung/Info
    // bleiben stehen (Farbschwäche-Anforderung), da lifecycle-Meldungen weder Fehler
    // noch Warnung sind, ist die Auszeichnung dort auch am wenigsten wichtig.
    const levelLabel = n.level === 'lifecycle' ? '' : (LEVEL_LABEL[n.level] ?? n.level);
    return `
        <div class="mcs-box${unread ? ' unread' : ''}" data-id="${esc(n.id)}">
            <div class="mcs-box-head">
                <span class="mcs-box-sender">${esc(n.botName || n.botId)}</span>
                ${levelLabel ? `<span class="mcs-box-level">${esc(levelLabel)}</span>` : ''}
                <span class="mcs-box-time">${fmtDateTime(n.timestamp)}</span>
            </div>
            <div class="mcs-box-text">${esc(firstWords(preview, 140))}</div>
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
function messageDetailBody({ level, botName, botId, timestamp, message }) {
    return `
        <div class="mc-detail-card level-${esc(level)}">
            <div class="mc-detail-sender">
                <span class="mc-detail-bot">${esc(botName || botId || 'System')}</span>
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
        markSystemRead([id]).then(refreshSystemBadgeOnly);
        document.querySelector(`.mcs-box[data-id="${id}"]`)?.classList.remove('unread');
    }
    showModal({
        id:    'msg-system-detail',
        title: esc(LEVEL_LABEL[n.level] ?? n.level),
        body:  messageDetailBody(n),
        actions: [{ label: 'Schließen', onClick: () => closeModal('msg-system-detail') }],
    });
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
    premiumTotalPages = Math.max(1, Math.ceil(filtered.length / 15));
    if (premiumPage > premiumTotalPages) premiumPage = premiumTotalPages;
    const pageItems = filtered.slice((premiumPage - 1) * 15, premiumPage * 15);

    const premiumUnread = premiumCache.filter(m => m.direction === 'in' && !m.read).length;
    setBadge('mcBadgePremium', isNotifyEnabled('premium') ? premiumUnread : 0);

    const grid = document.getElementById('mcpGrid');
    if (!pageItems.length) {
        grid.innerHTML = '<div class="msg-empty">Noch keine Premium-Nachrichten.</div>';
    } else {
        grid.innerHTML = pageItems.map(m => premiumBoxHtml(m)).join('');
        grid.querySelectorAll('.mcs-box').forEach(box => {
            box.addEventListener('click', () => openPremiumMessageModal(Number(box.dataset.id)));
        });
    }

    renderPremiumPagination();
}

// Lokale Ereignisse ohne Gegenstelle (z.B. eine ausgeführte Zahlung, siehe
// premium-pay.js recordPremiumMessage()) haben peerPubkey=null – "FORGE Master"
// wäre hier irreführend (es kam keine DM vom Master), "Diese Instanz" passt zum
// bestehenden Label für abgehende Nachrichten im Detail-Modal.
function premiumBoxHtml(m) {
    const unread = m.direction === 'in' && !m.read;
    const sender = m.peerName
        ? esc(m.peerName)
        : (m.peerPubkey ? esc(shortPeer(m.peerPubkey)) : (m.direction === 'out' ? 'Diese Instanz' : 'FORGE Master'));
    return `
        <div class="mcs-box${unread ? ' unread' : ''}" data-id="${esc(m.id)}">
            <div class="mcs-box-head">
                <span class="mcs-box-sender">${sender}</span>
                <span class="mcs-box-time">${fmtDateTime(m.timestamp)}</span>
            </div>
            <div class="mcs-box-text">${esc(firstWords(stripEmoji(m.summary), 140))}</div>
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
        document.querySelector(`.mcs-box[data-id="${id}"]`)?.classList.remove('unread');
        const premiumUnread = premiumCache.filter(x => x.direction === 'in' && !x.read).length;
        setBadge('mcBadgePremium', isNotifyEnabled('premium') ? premiumUnread : 0);
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
    supportTotalPages = Math.max(1, Math.ceil(filtered.length / 15));
    if (supportPage > supportTotalPages) supportPage = supportTotalPages;
    const pageItems = filtered.slice((supportPage - 1) * 15, supportPage * 15);

    const grid = document.getElementById('mcSupGrid');
    if (!pageItems.length) {
        grid.innerHTML = '<div class="msg-empty">Noch keine Konversationen. Über das ✎-Icon eine neue starten.</div>';
    } else {
        grid.innerHTML = pageItems.map(t => supportBoxHtml(t)).join('');
        grid.querySelectorAll('.mcs-box').forEach(box => {
            const { peerPubkey, threadId } = decodeThreadKey(box.dataset.id);
            box.addEventListener('click', () => openSupportThreadModal(peerPubkey, threadId));
        });
    }
    renderSupportPagination();
}

function supportBoxHtml(t) {
    return `
        <div class="mcs-box${t.unreadCount > 0 ? ' unread' : ''}" data-id="${esc(encodeThreadKey(t.peerPubkey, t.threadId))}">
            <div class="mcs-box-head">
                <span class="mcs-box-sender">${peerLabel(t.peerPubkey, t.peerName)}</span>
                <span class="mcs-box-time">${fmtDateTime(t.lastTimestamp)}</span>
            </div>
            <div class="mcs-box-text">${esc(firstWords(stripEmoji(t.lastText), 140))}</div>
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
    const meLabel = currentAlias
        ? `${esc(currentAlias)} <span class="msg-peer-pubkey">(${esc(shortPeer(currentNpub))})</span>`
        : (currentNpub ? esc(shortPeer(currentNpub)) : 'Lade…');

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
                    <span id="msgThreadPeer">${shortPeer(peerPubkeyHex)}</span>
                </div>
            </div>
            <div class="msg-thread" id="msgThread"><div class="msg-empty">Lade…</div></div>
            <form class="msg-compose" id="msgComposeForm">
                <textarea id="msgComposeInput" rows="3" placeholder="Antworten…" maxlength="1000"></textarea>
                <button type="submit">Senden</button>
            </form>
            <div class="msg-status" id="msgStatus"></div>`,
        actions: [
            { label: 'Konversation löschen', onClick: () => deleteSupportThread(mid, peerPubkeyHex, threadId) },
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
async function deleteSupportThread(mid, peerPubkeyHex, threadId) {
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
                        closeModal(mid);
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
        const { messages, peerName } = await r.json();
        const peerEl = document.getElementById('msgThreadPeer');
        if (peerEl) peerEl.innerHTML = peerLabel(activePeer, peerName);
        if (!messages.length) {
            thread.innerHTML = '<div class="msg-empty">Noch keine Nachrichten.</div>';
            return;
        }
        thread.innerHTML = messages.map(m => `
            <div class="msg-item msg-${m.direction}">
                <div class="msg-item-text">${esc(stripEmoji(m.text))}</div>
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
document.getElementById('msgNewBtn').addEventListener('click', async () => {
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
            <div class="msg-modal-field">
                <label for="msgNewText">Nachricht</label>
                <textarea id="msgNewText" rows="3" maxlength="1000" placeholder="Nachricht…"></textarea>
            </div>
            <div class="msg-status" id="msgNewStatus"></div>`,
        actions: [
            { label: 'Senden', onClick: () => sendNewMessage(master) },
            { label: 'Abbrechen', onClick: () => closeModal('msg-new') },
        ],
    });
});

async function sendNewMessage(master) {
    const textInput = document.getElementById('msgNewText');
    const status    = document.getElementById('msgNewStatus');
    const text      = textInput.value.trim();

    if (!master) { status.textContent = 'FORGE-Master-Kontakt nicht verfügbar.'; return; }
    if (!text) { status.textContent = 'Bitte eine Nachricht eingeben.'; return; }

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
selectMenu('system');
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

document.getElementById('lastUpdate').textContent = 'Letztes Update: ' + fmtTime(Date.now());
