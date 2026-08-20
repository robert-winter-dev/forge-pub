/**
 * FORGE Message Center – Postfach mit Rubriken-Reitern und Zwei-Spalten-Ansicht
 *
 * Rubriken (Zuschnitt seit 2026-08-18):
 *   System  – Updates und Kern-Meldungen aus nexus.db, Absender "System".
 *   Bots    – alles, was einen der beiden Bots betrifft (inkl. der SOL-Guthaben-
 *             Alerts des Wallet-Monitors), Absender "Liquidity Bot"/"Lending Bot".
 *             Start-/Stop-Meldungen sind hier bewusst ausgenommen.
 *   Support – Nostr-DM-Verkehr mit dem FORGE Master, einzige Rubrik in der man
 *             selbst schreiben kann.
 *   Premium – Ereignisse rund um den Premium-Service, Absender "FORGE Master".
 * Dazu Einstellungen (Sound/Popups + Nostr-Identität) als eigenes Vollbreite-Panel.
 *
 * System und Bots teilen sich dieselbe Datenquelle (Notifications in nexus.db) und
 * denselben Code-Pfad – getrennt wird serverseitig, siehe routes/messages.js.
 *
 * Umbau 2026-08-16 – drei Änderungen gegenüber der Vorversion:
 *   1. Zwischen System/Support/Premium wird über Reiter direkt unter dem Header
 *      umgeschaltet (Vorbild: Health Monitor), nicht mehr über das Hamburger-Menü.
 *      Die Deep-Links message.html#system|#support|#premium bleiben gültig – sie
 *      wählen jetzt den passenden Reiter (message-bell.js und der Brief-Link im
 *      Health Monitor hängen daran).
 *   2. Nachrichten werden NICHT mehr in einem Modal gelesen: links die scrollbare
 *      Liste, rechts die Detailansicht (siehe .mc-split in message.css). Dasselbe
 *      gilt fürs Schreiben – Antwort und neue Nachricht stehen ebenfalls rechts.
 *      Modals bleiben nur für Rückfragen (Löschen, Weiterleiten, Account-Reset, QR).
 *   3. Keine Seitenzahlen mehr: die Liste lädt beim Herunterscrollen nach
 *      (loadMore(), Fenstergröße PAGE_SIZE). System holt die Fenster serverseitig
 *      (?limit=&offset=, siehe routes/messages.js), Premium/Support bekommen ohnehin
 *      die vollständige Liste (max. 100 je Rubrik) und blenden clientseitig nach.
 *
 * Einstellungen ist bewusst kein Reiter – dort gibt es keine Nachrichtenliste, für
 * die eine Zwei-Spalten-Ansicht Sinn ergäbe. Die Rubrik hängt als eigener Eintrag
 * im Hamburger-Menü (nav.js) und schaltet die Seite auf ein Vollbreite-Panel.
 */

import { initNav, initFooter, setNavBadge, setNavCurrent } from '/forge/js/nav.js?v=20260816a';
import { t as tr, NUM_LOCALE } from '/forge/js/i18n.js?v=20260811a';
import { showToast } from '/forge/js/toast.js?v=20260722b';
import { showModal, closeModal } from '/forge/js/modal.js?v=20260731a';
import {
    initMessageBell, isNotifyEnabled, loadNotifySettings, setNotifyEnabled, getOldestUnreadCategory,
} from '/forge/js/message-bell.js?v=20260818a';

// Rubriken mit Nachrichtenliste (= Reiter) und die reine Einstellungen-Ansicht.
// Reihenfolge = Reihenfolge der Reiter in message.html.
const TABS        = ['system', 'bots', 'support', 'premium'];
// Rubriken, die aus den Nexus-Notifications gespeist werden (dieselbe Tabelle,
// serverseitig in zwei disjunkte Mengen getrennt – siehe routes/messages.js).
const NOTIF_TABS  = ['system', 'bots'];
const VALID_MENUS = [...TABS, 'einstellungen'];
const hashMenu    = location.hash.slice(1);
const initialMenu = VALID_MENUS.includes(hashMenu) ? hashMenu : 'system';

// Wie viele Einträge ein Nachlade-Schritt umfasst. Mehr als eine Bildschirmhöhe,
// damit beim Scrollen nicht ständig nachgeladen wird; deutlich unter dem
// 100er-Deckel, den notify-db.js/messages-db.js je Rubrik ohnehin durchsetzen.
const PAGE_SIZE = 25;

// Deep-Link mit vorausgewähltem Gesprächspartner (z.B. Brief-Icon im Tab
// "Health Monitor > Daten teilen" auf message.html?peer=<pubkeyHex>#support) – öffnet
// den Verlauf direkt, statt den Nutzer erst in der Liste suchen zu lassen. Nur ein
// 64-stelliger Hex-Pubkey wird akzeptiert, alles andere wird stillschweigend
// ignoriert (kein Fehlerpfad nötig für einen internen, selbst erzeugten Link).
const peerParam   = new URLSearchParams(location.search).get('peer');
const initialPeer = peerParam && /^[0-9a-f]{64}$/.test(peerParam) ? peerParam : null;

initNav({ current: initialMenu === 'einstellungen' ? 'message-einstellungen' : 'message-inbox' });
// Bewusst ohne botName: die zweite Footer-Zeile ist für "<Name>: <Version>" gedacht
// und wird per id="footerVersion" nachgefüllt (siehe initFooter() in nav.js). Das
// Message Center hat keine eigene Version zu zeigen – übrig blieb ein nacktes
// "Message Center:" ohne Wert dahinter (2026-08-16).
initFooter();

// ── Helfer ───────────────────────────────────────────────────────────────────
function fmtDateTime(ts) {
    const text = new Date(ts).toLocaleString(NUM_LOCALE, {
        day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    return tr('time.hour_label', '{time} Uhr', { time: text });
}
// Lange Form für die Kopfzeilen der Detailansicht: vierstelliges Jahr, kein Komma
// ("30.07.2026 13:10 Uhr", Vorgabe 2026-07-30). Bewusst NICHT in der Liste – dort ist
// die Spalte schmal und die Kurzform genügt, weil der Kontext daneben steht.
function fmtDateTimeLong(ts) {
    const d = new Date(ts);
    const text = d.toLocaleDateString(NUM_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' })
        + ' ' + d.toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' });
    return tr('time.hour_label', '{time} Uhr', { time: text });
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
// denen sie stehen (z.B. Premium-Zahlungs-Detail "An"/"TX") – kürzen auf ungefähr
// dieselbe Anzeigelänge, statt wie shortPeer() auf die kürzere Pubkey-Konvention.
function truncateToAddressLength(s, keepEachSide = 20) {
    return s && s.length > keepEachSide * 2 + 1 ? `${s.slice(0, keepEachSide)}…${s.slice(-keepEachSide)}` : (s ?? '');
}
/** Kopiert eine volle npub in die Zwischenablage – Klick-Ziel ist .msg-npub-copy. */
async function copyNpub(npub) {
    if (!npub) return;
    try {
        await navigator.clipboard.writeText(npub);
        showToast(tr('msg.npub_copied', 'npub in die Zwischenablage kopiert'), 'success');
    } catch {
        showToast(tr('msg.copy_failed', 'Kopieren fehlgeschlagen'), 'error');
    }
}

/** Verzögert fn um delay ms nach dem letzten Aufruf – für Live-Suche beim Tippen. */
function debounce(fn, delay = 250) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

// ── Absender / Empfänger ─────────────────────────────────────────────────────
/**
 * Beteiligte einer Nachricht – FORGE-weit nach EINER Regel (Vorgabe 2026-08-16):
 *
 *   Nostr-Nachricht  → auf beiden Seiten der Nick (Anzeigename), nie eine npub.
 *                      Eingehend: Nick der Gegenstelle → eigener Nick.
 *                      Ausgehend: eigener Nick → Nick der Gegenstelle.
 *   Interne Meldung  → Absender immer "FORGE Public" (diese Instanz hat sie
 *                      erzeugt), Empfänger immer der Nick des Nutzers.
 *   Ausnahme System/Bots → Absender ist NICHT "FORGE Public", sondern der Name des
 *                      Urhebers (`n.botName`: "Liquidity Bot"/"Lending Bot" in der
 *                      Rubrik Bots, "System" in der Rubrik System) — siehe
 *                      openSystemMessage(). Grund: hier ist der Urheber die
 *                      relevante Information, nicht die Instanz-Identität.
 *   Ausnahme Premium → Absender ist "FORGE Master" (Vorgabe 2026-08-18), auch bei
 *                      lokal protokollierten Ereignissen wie einer ausgeführten
 *                      Zahlung. Die Rubrik bildet die Premium-Beziehung zum Master
 *                      ab; "FORGE Public" hätte den Nutzer auf sich selbst verwiesen.
 *
 * Die npub steht nur noch gekürzt in der geöffneten Nachricht (peerLabelWithNpub),
 * nie in der Liste – für den Nutzer ist sie dort keine brauchbare Information,
 * er erkennt seine Gegenstelle am Namen.
 */
function myNick()   { return currentAlias || tr('msg.forge_public_user', 'FORGE Public User'); }
function peerNick(name) { return name || tr('msg.forge_master', 'FORGE Master'); }

/**
 * "Von"/"An"-Zeilen der Detailansicht. Bei Nostr-Nachrichten steht die gekürzte
 * npub der Gegenstelle in Klammern hinter dem Nick, klickbar zum Kopieren – hier
 * kommuniziert der Nutzer tatsächlich mit ihr und muss sie verifizieren können.
 */
function peerLabelWithNpub(npub, peerName) {
    const short = npub
        ? `<span class="msg-peer-pubkey msg-npub-copy" data-npub="${esc(npub)}" title="${tr('msg.copy_npub', 'npub kopieren')}">(${esc(shortPeer(npub))})</span>`
        : '';
    return peerName ? `${esc(peerName)} ${short}` : (short || tr('msg.loading', 'Lade…'));
}

/** Baut den Von/An-Block der Detailansicht. Werte sind bereits fertiges HTML. */
function metaHtml(rows) {
    return `<div class="mc-meta">${rows.map(([label, value]) => `
        <div class="mc-meta-row"><span class="mc-meta-label">${esc(label)}</span><span>${value}</span></div>`).join('')}</div>`;
}

// ── Zustand ──────────────────────────────────────────────────────────────────
let activeMenu   = null;   // 'system' | 'bots' | 'support' | 'premium' | 'einstellungen'
let activeKey    = null;   // Schlüssel des rechts geöffneten Eintrags (siehe listItems())
let activePeer   = null;   // Support: Gegenstelle des offenen Verlaufs
let activeThreadId = null; // Support: Anliegen (thread_id) des offenen Verlaufs, null = alter Sammel-Thread
let composeOpen  = false;  // rechts steht das Verfassen-Formular statt einer Nachricht
let currentNpub  = null;
let currentAlias = null;
// true nur auf dem FORGE Master (Identität "FORGE.Master", siehe /identity). Steuert
// allein, ob beim Verfassen eine freie npub-Eingabe erscheint – siehe openCompose().
let isMasterIdentity = false;

// System/Bots: serverseitiges Fenster, wird beim Scrollen verlängert. Beide
// Rubriken lesen dieselbe Tabelle (nexus.db), der Server liefert je Rubrik die
// passende Teilmenge – Fenster, Suche und Ungelesen-Zähler laufen deshalb getrennt.
const notifScopes = {
    system: { endpoint: '/api/messages/system', items: [], hasMore: false, search: '' },
    bots:   { endpoint: '/api/messages/bots',   items: [], hasMore: false, search: '' },
};
/** true für die beiden Notification-Rubriken (System/Bots). */
function isNotifTab(name) { return NOTIF_TABS.includes(name); }
/** Zustand der aktiven Notification-Rubrik. */
function notif() { return notifScopes[activeMenu]; }
// Premium/Support: vollständige Liste im Cache (max. 100), clientseitig eingeblendet.
let premiumCache = [];
let premiumShown = PAGE_SIZE;
let premiumSearchQuery = '';
let supportThreads = [];
let supportShown = PAGE_SIZE;
let supportSearchQuery = '';

const elList     = document.getElementById('mcList');
const elPane     = document.getElementById('mcPane');
const elMail     = document.getElementById('mcMail');
const elSettings = document.getElementById('mcSettingsPanel');
const elDetailBody = document.getElementById('mcDetailBody');
const elSearch   = document.getElementById('mcSearchInput');

// ── Ungelesen-Zähler ─────────────────────────────────────────────────────────
// System-Lesestatus liegt seit 2026-08-03 server-seitig im read-Flag (nexus.db,
// siehe notify-db.js) statt im localStorage – unreadCount kommt fertig aus
// /api/messages/system. Damit sind Brief-Icon, Reiter-Zähler und Nav-Badge
// automatisch synchron, auch über mehrere Geräte hinweg.
const unreadCounts = { system: 0, bots: 0, support: 0, premium: 0 };

const TAB_COUNT_EL = {
    system:  document.getElementById('mcTabCountSystem'),
    bots:    document.getElementById('mcTabCountBots'),
    support: document.getElementById('mcTabCountSupport'),
    premium: document.getElementById('mcTabCountPremium'),
};

/**
 * Zähler am Reiter setzen und die Summe an den Hamburger-Eintrag "Nachrichten"
 * durchreichen (dort steht seit 2026-08-16 nur noch EIN Eintrag statt drei).
 * Ein abgeschaltetes Benachrichtigungs-Toggle unterdrückt NUR den Zähler – die
 * Nachrichten selbst bleiben in ihrer Rubrik normal sichtbar.
 */
function setUnread(key, n) {
    unreadCounts[key] = isNotifyEnabled(key) ? (n ?? 0) : 0;
    const el = TAB_COUNT_EL[key];
    if (el) {
        el.textContent = String(unreadCounts[key]);
        el.hidden = unreadCounts[key] === 0;
    }
    setNavBadge('message-inbox', TABS.reduce((sum, k) => sum + unreadCounts[k], 0));
}

async function markSystemRead(ids) {
    if (!ids.length) return;
    try {
        await fetch('/api/messages/system/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
    } catch { /* Nexus nicht erreichbar – Zähler stimmt beim nächsten Refresh wieder */ }
}

async function refreshBadges() {
    await loadNotifySettings();
    for (const scope of NOTIF_TABS) {
        try {
            // limit=1: es geht hier nur um unreadCount, nicht um die Zeilen selbst.
            const r = await fetch(`${notifScopes[scope].endpoint}?limit=1`);
            const { unreadCount } = await r.json();
            setUnread(scope, unreadCount ?? 0);
        } catch { setUnread(scope, 0); }
    }
    try {
        const r = await fetch('/api/messages/support/unread-count');
        const { unread } = await r.json();
        setUnread('support', unread ?? 0);
    } catch { setUnread('support', 0); }
    try {
        const r = await fetch('/api/messages/premium/unread-count');
        const { unread } = await r.json();
        setUnread('premium', unread ?? 0);
    } catch { setUnread('premium', 0); }
    // Brief-Icon im Header nutzt sonst seinen eigenen 30s-Poll – ohne diesen
    // Aufruf bliebe die Zahl dort nach "alle als gelesen" bis zu 30s zu hoch.
    await refreshBellBadge();
}

// ── Rubriken-Umschaltung ─────────────────────────────────────────────────────
function selectMenu(name, { keepSelection = false } = {}) {
    const changed = activeMenu !== name;
    activeMenu = name;
    if (!keepSelection && changed) {
        activeKey = null; activePeer = null; activeThreadId = null; composeOpen = false;
    }
    history.replaceState(null, '', `#${name}`);
    setNavCurrent(name === 'einstellungen' ? 'message-einstellungen' : 'message-inbox');

    const isSettings = name === 'einstellungen';
    elMail.hidden     = isSettings;
    elSettings.hidden = !isSettings;

    document.querySelectorAll('.mctab').forEach(btn => {
        const on = btn.dataset.tab === name;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', String(on));
    });

    if (isSettings) { renderSettingsPanel(); return; }

    document.getElementById('msgNewBtn').hidden = name !== 'support';
    if (changed) {
        // Suche ist bewusst je Rubrik eigenständig – ein Suchbegriff aus der
        // Systemliste ergibt im Support-Postfach selten Sinn.
        elSearch.value = (isNotifTab(name) ? notifScopes[name].search
            : { support: supportSearchQuery, premium: premiumSearchQuery }[name]) ?? '';
        elList.scrollTop = 0;
        renderPanePlaceholder();
    }
    reloadActiveList({ reset: changed });
}

document.querySelectorAll('.mctab').forEach(btn => {
    btn.addEventListener('click', () => selectMenu(btn.dataset.tab));
});

// Deep-Links aus dem Hamburger-Menü / message-bell.js navigieren innerhalb
// desselben Dokuments und feuern "hashchange" statt neu zu laden – genau das
// fängt dieser Listener ab. selectMenu() selbst nutzt replaceState, das löst kein
// hashchange aus, also keine Doppel-Ausführung beim internen State-Sync.
window.addEventListener('hashchange', () => {
    const name = location.hash.slice(1);
    if (VALID_MENUS.includes(name) && name !== activeMenu) selectMenu(name);
});

// Brief-Icon: Klick springt in die Rubrik mit der ältesten ungelesenen Nachricht
// (siehe message-bell.js); ohne ungelesene Nachricht bleibt die aktuelle stehen.
// Rückgabewert = Badge-Refresh-Funktion, genutzt von refreshBadges().
const refreshBellBadge = initMessageBell({
    requireLan: false,
    onClick: () => selectMenu(getOldestUnreadCategory() ?? (activeMenu === 'einstellungen' ? 'system' : activeMenu) ?? 'system'),
});

// ── Liste (linke Spalte) ─────────────────────────────────────────────────────
/**
 * Baut die Listeneinträge der aktiven Rubrik. Ein Eintrag ist zweizeilig
 * (Absender + Zeitpunkt oben, Betreff darunter) – die vierspaltige Tabelle von
 * früher passt nicht in eine 420px-Spalte. Der Empfänger steht deshalb nicht mehr
 * in der Liste, sondern in der Detailansicht rechts, wo Platz dafür ist.
 */
function listItems() {
    if (isNotifTab(activeMenu)) {
        return notif().items.map(n => ({
            key:     `s${n.id}`,
            unread:  !n.read,
            from:    n.botName || n.botId || tr('nav.message.system', 'System'),
            time:    n.timestamp,
            // Auch "lifecycle" bekommt sein Label (seit 2026-08-18 "Info"): sonst
            // stünde die Meldungsart hier allein in der Abwesenheit des Badges —
            // eine Kodierung, die niemand liest. Solange das Label "Status" hieß
            // und nichts aussagte, war das Weglassen vertretbar.
            level:   LEVEL_LABEL[n.level] ?? n.level,
            // Pool-Bezug steht seit 2026-08-08 im Betreff statt beim Absender. Bei
            // Pool-Meldungen ersetzt "Pool <Pair>:" das Level – welcher Pool betroffen
            // ist, wiegt hier schwerer als die Art der Meldung.
            subject: n.pool ? `Pool ${n.pool}: ${stripEmoji(stripNotifyHeader(n.message))}`
                            : stripEmoji(stripNotifyHeader(n.message)),
            poolPrefix: !!n.pool,
        }));
    }
    if (activeMenu === 'premium') {
        return filteredPremium().slice(0, premiumShown).map(m => ({
            key:     `p${m.id}`,
            unread:  m.direction === 'in' && !m.read,
            // Eingehende DMs kommen per Nostr → Nick der Gegenstelle. Alles andere
            // hat diese Instanz selbst erzeugt (ausgehende DM: eigener Nick;
            // lokales Ereignis ohne Gegenstelle, z.B. eine ausgeführte Zahlung:
            // "FORGE Public").
            from:    m.peerPubkey ? (m.direction === 'in' ? peerNick(m.peerName) : myNick()) : peerNick(null),
            time:    m.timestamp,
            level:   '',
            subject: stripEmoji(m.summary),
        }));
    }
    return filteredSupport().slice(0, supportShown).map(t => ({
        key:     `t${encodeThreadKey(t.peerPubkey, t.threadId)}`,
        unread:  t.unreadCount > 0,
        from:    peerNick(t.peerName),
        time:    t.lastTimestamp,
        level:   '',
        subject: stripEmoji(stripQuoteMarkers(t.lastText)),
    }));
}

function hasMore() {
    if (isNotifTab(activeMenu))   return notif().hasMore;
    if (activeMenu === 'premium') return premiumShown < filteredPremium().length;
    return supportShown < filteredSupport().length;
}

const EMPTY_TEXT = {
    system:  () => tr('msg.no_system_notifications', 'Keine System-Benachrichtigungen.'),
    bots:    () => tr('msg.no_bot_notifications', 'Keine Bot-Meldungen.'),
    premium: () => tr('msg.no_premium_messages', 'Noch keine Premium-Nachrichten.'),
    support: () => tr('msg.no_conversations', 'Noch keine Konversationen. Über "Neue Nachricht" eine starten.'),
};

function renderList() {
    const items = listItems();
    const scrollTop = elList.scrollTop;

    if (!items.length) {
        elList.innerHTML = `<div class="msg-empty">${esc(EMPTY_TEXT[activeMenu]())}</div>`;
        return;
    }

    elList.innerHTML = items.map(it => `
        <button type="button" class="mcli${it.unread ? ' unread' : ''}${it.key === activeKey ? ' selected' : ''}" data-key="${esc(it.key)}">
            <span class="mcli-top">
                <span class="mcli-from">${esc(it.from)}</span>
                <span class="mcli-time">${fmtDateTime(it.time)}</span>
            </span>
            <span class="mcli-subject">${it.level ? `<span class="mct-level">${esc(it.level)}</span>` : ''}${esc(it.subject)}</span>
        </button>`).join('')
        // Ohne diese Fußzeile wäre nach dem Wegfall der Seitenzahlen nicht
        // erkennbar, ob die Liste zu Ende ist oder noch etwas nachkommt.
        + `<div class="mc-list-foot">${hasMore()
            ? esc(tr('msg.scroll_for_more', 'Weiter scrollen für ältere Nachrichten…'))
            : esc(tr('msg.end_of_list', 'Ende der Liste'))}</div>`;

    elList.querySelectorAll('.mcli').forEach(btn => {
        btn.addEventListener('click', () => openKey(btn.dataset.key));
    });
    elList.scrollTop = scrollTop;
    // Ist die Liste kürzer als ihr Container, feuert nie ein scroll-Event – dann
    // muss der nächste Block sofort nachgeladen werden, sonst bliebe die Liste
    // trotz vorhandener Nachrichten kurz.
    if (hasMore() && elList.scrollHeight <= elList.clientHeight + 4) loadMore();
}

let loadingMore = false;
async function loadMore() {
    if (loadingMore || !hasMore()) return;
    loadingMore = true;
    try {
        if (isNotifTab(activeMenu)) {
            const st   = notif();
            const data = await fetchNotifications({ offset: st.items.length, limit: PAGE_SIZE });
            st.items   = st.items.concat(data.notifications ?? []);
            st.hasMore = !!data.hasMore;
        } else if (activeMenu === 'premium') {
            premiumShown += PAGE_SIZE;
        } else {
            supportShown += PAGE_SIZE;
        }
        renderList();
    } finally {
        loadingMore = false;
    }
}

elList.addEventListener('scroll', () => {
    if (elList.scrollTop + elList.clientHeight >= elList.scrollHeight - 120) loadMore();
});

/**
 * Lädt die aktive Rubrik neu. reset=true beginnt wieder beim ersten Fenster
 * (Rubrikwechsel, neue Suche); ohne reset bleibt die bereits nachgeladene Menge
 * erhalten – sonst würde der 30-Sekunden-Refresh die Liste jedes Mal auf das
 * erste Fenster zurückwerfen, während der Nutzer weiter unten liest.
 */
async function reloadActiveList({ reset = false } = {}) {
    await loadNotifySettings();
    if (isNotifTab(activeMenu)) {
        const st = notif();
        if (reset) st.items = [];
        const limit = Math.max(PAGE_SIZE, st.items.length);
        const data  = await fetchNotifications({ offset: 0, limit });
        st.items   = data.notifications ?? [];
        st.hasMore = !!data.hasMore;
        // Bei aktiver Suche zählt der Server nur die Treffer – als Rubrik-Zähler wäre
        // das falsch (er soll alle ungelesenen zeigen, nicht die im Filter). Dann
        // übernimmt refreshBadges() den ungefilterten Wert.
        if (!st.search) setUnread(activeMenu, data.unreadCount ?? 0);
    } else if (activeMenu === 'premium') {
        if (reset) premiumShown = PAGE_SIZE;
        premiumCache = await fetchPremium();
        setUnread('premium', premiumCache.filter(m => m.direction === 'in' && !m.read).length);
    } else if (activeMenu === 'support') {
        if (reset) supportShown = PAGE_SIZE;
        supportThreads = await fetchThreads();
    }
    renderList();
}

elSearch.addEventListener('input', debounce((e) => {
    const q = e.target.value.trim();
    if (isNotifTab(activeMenu))        { notif().search = q; }
    else if (activeMenu === 'premium') { premiumSearchQuery = q; }
    else                               { supportSearchQuery = q; }
    elList.scrollTop = 0;
    reloadActiveList({ reset: true });
}));

// ── Datenquellen ─────────────────────────────────────────────────────────────
async function fetchNotifications({ offset = 0, limit = PAGE_SIZE, scope = activeMenu } = {}) {
    try {
        const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
        if (notifScopes[scope].search) params.set('q', notifScopes[scope].search);
        const r = await fetch(`${notifScopes[scope].endpoint}?${params}`);
        return await r.json();
    } catch {
        return { notifications: [], hasMore: false, allIds: [], unreadCount: 0 };
    }
}

/** Vollständige, ungefilterte ID-Liste der Rubrik – Grundlage für "alle als gelesen". */
async function fetchAllNotificationIds(scope = activeMenu) {
    try {
        const r = await fetch(`${notifScopes[scope].endpoint}?limit=1`);
        const { allIds } = await r.json();
        return allIds ?? [];
    } catch { return []; }
}

async function fetchPremium() {
    try {
        const r = await fetch('/api/messages/premium');
        const { messages } = await r.json();
        return messages ?? [];
    } catch { return []; }
}

async function fetchThreads() {
    try {
        const r = await fetch('/api/messages/support/threads');
        const { threads } = await r.json();
        return threads ?? [];
    } catch { return []; }
}

// Kein Such-Parameter auf /api/messages/premium bzw. /support/threads (beide
// liefern ohnehin nur eine überschaubare Menge) – Suche läuft clientseitig auf
// der vollständig geladenen Liste.
function filteredPremium() {
    if (!premiumSearchQuery) return premiumCache;
    const q = premiumSearchQuery.toLowerCase();
    return premiumCache.filter(m =>
        (m.summary ?? '').toLowerCase().includes(q) ||
        (m.detail ?? '').toLowerCase().includes(q) ||
        (m.peerName ?? '').toLowerCase().includes(q)
    );
}
function filteredSupport() {
    if (!supportSearchQuery) return supportThreads;
    const q = supportSearchQuery.toLowerCase();
    return supportThreads.filter(t =>
        (t.peerName ?? '').toLowerCase().includes(q) ||
        (t.lastText ?? '').toLowerCase().includes(q)
    );
}

// Ein Support-Anliegen wird über peerPubkey + threadId identifiziert (nicht nur
// peerPubkey – ein Nutzer kann mehrere getrennte Anliegen mit demselben FORGE
// Master haben, siehe thread_id-Migration im Premium-Dienst).
function encodeThreadKey(peerPubkey, threadId) { return `${peerPubkey}::${threadId ?? ''}`; }
function decodeThreadKey(key) {
    const i = key.indexOf('::');
    return { peerPubkey: key.slice(0, i), threadId: key.slice(i + 2) || null };
}

// ── Textaufbereitung ─────────────────────────────────────────────────────────
// Der Nachrichtentext trägt seit dem notify.js-Zentralfix (2026-07-30) eine eigene
// "📅 Datum · Bot"-Kopfzeile (wichtig für Telegram/Roh-Log) – hier aber redundant,
// weil Datum und Bot bereits als eigene UI-Felder dastehen. Nur für die Anzeige
// entfernt, der gespeicherte Text bleibt unverändert.
function stripNotifyHeader(text) {
    return String(text ?? '').replace(/^📅[^\n]*\n/, '');
}

// Emoji/Icons aus der Telegram-Formatierung (🔴⚠️💰🚨 usw.) sind im Message Center
// nur Bildrauschen ohne Zusatzinfo (die Art steht separat als Text-Badge) – nur
// für die Anzeige entfernt, gilt für System/Premium/Support gleichermaßen.
function stripEmoji(text) {
    return String(text ?? '')
        .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}]/gu, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/ {2,}/g, ' ')
        .trim();
}

// "lifecycle" ist eine Zustellklasse des Nexus (immer Telegram, kein Dedup —
// siehe core/nexus/server.js), keine eigene Meldungsart für den Leser: eine
// eingespielte Aktualisierung oder ein Bot-Start ist für ihn schlicht eine
// Information. Es trägt deshalb dasselbe Label wie "info"; das frühere "Status"
// sagte nicht, was gemeint war (Betreiber-Vorgabe 2026-08-18).
const LEVEL_LABEL = {
    info:      tr('msg.level_info',  'Info'),
    warn:      tr('msg.level_warn',  'Warnung'),
    error:     tr('msg.level_error', 'Fehler'),
    lifecycle: tr('msg.level_info',  'Info'),
};

// ── Detailansicht (rechte Spalte) ────────────────────────────────────────────
function renderPanePlaceholder() {
    activeKey = null;
    elPane.innerHTML = `<p class="mc-pane-placeholder">${esc(tr('msg.select_message', 'Wähle links eine Nachricht aus, um sie zu lesen.'))}</p>`;
}

/** Markiert den geöffneten Eintrag in der Liste, ohne sie neu zu bauen. */
function markSelected(key) {
    activeKey = key;
    elList.querySelectorAll('.mcli').forEach(el => el.classList.toggle('selected', el.dataset.key === key));
}

function openKey(key) {
    composeOpen = false;
    markSelected(key);
    if (key.startsWith('s')) return openSystemMessage(Number(key.slice(1)));
    if (key.startsWith('p')) return openPremiumMessage(Number(key.slice(1)));
    const { peerPubkey, threadId } = decodeThreadKey(key.slice(1));
    // Klick in der Liste ist eine der beiden Aktionen, die "gelesen" auslösen dürfen
    // (die andere ist der Haken) – deshalb hier markRead, aber in keinem der
    // Hintergrund-Pfade, die denselben Verlauf nachladen.
    return openSupportThread(peerPubkey, threadId, { markRead: true });
}

/**
 * Einheitliches Meldungs-Layout (Vorgabe 2026-07-30, gilt für alle Kanäle):
 * Titelzeile = Art der Meldung ("Fehler"/"Warnung"/"Info"/"Status"), darunter
 * Von/An sowie Datum + Uhrzeit, dann der Text.
 *
 * "Von" ist seit 2026-08-16 (Betreiber-Vorgabe) NICHT mehr pauschal "FORGE Public"
 * wie bei den anderen beiden Rubriken, sondern der Name des betroffenen Bots
 * ("Liquidity Bot"/"Lending Bot"/"FORGE" für alles Kern-Nahe) — der Nutzer soll auf
 * den ersten Blick sehen, wer die Meldung erzeugt hat, nicht nur dass sie von dieser
 * Instanz kommt. `botName` kommt dafür fertig aufgelöst vom Server (routes/messages.js
 * resolveBotName()), vorher war der Absender die rohe botId ("wallet-monitor") –
 * für einen Nicht-Techniker weder Art noch Urheber der Meldung erkennbar.
 */
function openSystemMessage(id) {
    const n = notif().items.find(x => x.id === id);
    if (!n) return;
    if (!n.read) {
        n.read = true;
        elList.querySelector(`.mcli[data-key="s${id}"]`)?.classList.remove('unread');
        // refreshBadges() statt nur des System-Zählers – sonst zieht beim Öffnen
        // einer einzelnen Nachricht zwar der Reiter mit, die Zahl am Brief-Icon
        // rechts oben bliebe aber bis zum nächsten 30s-Poll zu hoch.
        markSystemRead([id]).then(refreshBadges);
    }
    const bot = n.botName || n.botId || 'System';
    elPane.innerHTML = `
        <div class="mc-pane-head">
            <h2 class="mc-pane-title">${esc(LEVEL_LABEL[n.level] ?? n.level)}${n.pool ? ` · ${esc(n.pool)}` : ''}</h2>
            <div class="mc-pane-actions">
                <button type="button" class="msg-icon-btn msg-icon-btn-accent" id="msgForwardBtn"
                    title="${tr('msg.forward_to_support', 'Diese Nachricht an den FORGE Support weiterleiten')}" aria-label="${tr('msg.forward', 'Weiterleiten')}">↪</button>
                <button type="button" class="msg-icon-btn" id="msgDeleteBtn"
                    title="${tr('msg.delete', 'Löschen')}" aria-label="${tr('msg.delete', 'Löschen')}">🗑</button>
            </div>
        </div>
        <div class="mc-pane-body">
            ${metaHtml([
                [tr('msg.from', 'Von'), esc(bot)],
                [tr('msg.to',   'An'),  esc(myNick())],
                [tr('msg.date', 'Datum'), esc(fmtDateTimeLong(n.timestamp))],
            ])}
            ${n.riskExit ? riskExitHtml(n.riskExit) : `<div class="mc-detail-text">${esc(stripEmoji(stripNotifyHeader(n.message)))}</div>`}
        </div>`;

    elPane.querySelector('#msgForwardBtn').addEventListener('click', () => confirmForwardSystemMessage(n));
    elPane.querySelector('#msgDeleteBtn').addEventListener('click', () => confirmDeleteMessage({
        url: `/api/messages/system/${encodeURIComponent(id)}`,
        afterDelete: () => reloadActiveList({ reset: true }),
    }));
}

/**
 * Eigene Darstellung für Risk-Management-Exits (n.riskExit gesetzt, siehe
 * routes/messages.js extractRiskExit() aus msg_params von notify.js rmExecuted()):
 * strukturierte Zeilen statt Fließtext, damit der PnL auf einen Blick als
 * Gewinn/Verlust erkennbar ist (Vorzeichen im Text, Farbe nur als Zusatz – siehe
 * feedback_color_blindness).
 *
 * Bewusst KEIN Label/Wert-Raster mit fester Spaltenbreite (anders als
 * premiumPaymentHtml()) – die Labels hier sind teils lang ("Pool-Wert bei
 * Schließung") und würden in einer schmalen Spalte hässlich umbrechen. Jede
 * Zeile fließt stattdessen als ein Satz ("Label: Wert"), genau wie im
 * ursprünglichen Fließtext.
 */
function riskExitHtml(r) {
    const pnlClass = r.pnlUsdc == null ? '' : (r.pnlUsdc.trim().startsWith('-') ? 'msg-pnl-negative' : 'msg-pnl-positive');
    const rows = [
        r.lpValue     != null && [tr('msg.risk_exit_pool_value', 'Pool-Wert bei Schließung'), `${esc(r.lpValue)} USDC`],
        (r.coinsA != null && r.coinsB != null) &&
            [tr('msg.risk_exit_withdrawn', 'Entnommen'), `${esc(r.coinsA)} ${esc(r.symA)} + ${esc(r.coinsB)} ${esc(r.symB)}`],
        r.swappedUsdc != null && [tr('msg.risk_exit_swapped', 'Getauscht'), `${esc(r.swappedUsdc)} USDC`],
        r.exitCost    != null && [tr('msg.risk_exit_cost', 'Exit-Kosten'), `${esc(r.exitCost)} USDC`],
        r.pnlUsdc     != null && [tr('msg.risk_exit_pnl', 'PnL'),
            `<span class="${pnlClass}">${esc(r.pnlUsdc)} USDC${r.pnlPct != null ? ` / ${esc(r.pnlPct)}` : ''}</span>`],
    ].filter(Boolean);

    return `
        ${r.scenario ? `<p class="mc-detail-text">${esc(r.scenario)}</p>` : ''}
        <ul class="mc-risk-list">
            ${rows.map(([label, value]) => `<li><span class="mc-risk-label">${esc(label)}:</span> ${value}</li>`).join('')}
        </ul>
        ${r.actionText ? `<p class="mc-detail-text">${esc(r.actionText)}</p>` : ''}`;
}

function premiumPaymentHtml(p) {
    return `
        <div class="msg-pay-row"><span class="msg-pay-label">${tr('msg.amount', 'Betrag')}</span><span>${esc(p.amountUsdc)} USDC</span></div>
        <div class="msg-pay-row"><span class="msg-pay-label">${tr('msg.period', 'Zeitraum')}</span><span>${esc(p.hourRange)}</span></div>
        <div class="msg-pay-row"><span class="msg-pay-label">${tr('msg.to', 'An')}</span><span class="msg-peer-pubkey">${esc(p.toWallet)}</span></div>
        <div class="msg-pay-row"><span class="msg-pay-label">${tr('msg.tx', 'TX')}</span><span><a href="https://solscan.io/tx/${esc(p.signature)}" target="_blank" rel="noopener" style="color:inherit;">${esc(truncateToAddressLength(p.signature))} ↗</a></span></div>`;
}

async function openPremiumMessage(id) {
    const m = premiumCache.find(x => x.id === id);
    if (!m) return;
    // Nostr-DM → Nick auf beiden Seiten; lokales Ereignis ohne Gegenstelle → es
    // kam und ging keine DM, Absender ist diese Instanz selbst.
    const [from, to] = m.peerPubkey
        ? (m.direction === 'in' ? [peerNick(m.peerName), myNick()] : [myNick(), peerNick(m.peerName)])
        : [peerNick(null), myNick()];
    // npub nur bei echten DMs anzeigen – und nur die der Gegenstelle, die eigene
    // steht unter Einstellungen.
    const fromHtml = m.peerPubkey && m.direction === 'in' ? peerLabelWithNpub(m.peerNpub, from) : esc(from);
    const toHtml   = m.peerPubkey && m.direction === 'out' ? peerLabelWithNpub(m.peerNpub, to) : esc(to);

    elPane.innerHTML = `
        <div class="mc-pane-head">
            <h2 class="mc-pane-title">${esc(m.payment
                ? tr('msg.auto_premium_pay', 'Automatische Premium Zahlung')
                : (m.direction === 'in' ? tr('msg.message_de', 'Nachricht') : tr('msg.event', 'Ereignis')))}</h2>
            <div class="mc-pane-actions">
                <button type="button" class="msg-icon-btn" id="msgDeleteBtn"
                    title="${tr('msg.delete', 'Löschen')}" aria-label="${tr('msg.delete', 'Löschen')}">🗑</button>
            </div>
        </div>
        <div class="mc-pane-body">
            ${metaHtml([
                [tr('msg.from', 'Von'), fromHtml],
                [tr('msg.to',   'An'),  toHtml],
                [tr('msg.date', 'Datum'), esc(fmtDateTimeLong(m.timestamp))],
            ])}
            ${m.payment ? premiumPaymentHtml(m.payment) : `<div class="mc-detail-text">${esc(stripEmoji(m.detail))}</div>`}
        </div>`;

    elPane.querySelector('#msgDeleteBtn').addEventListener('click', () => confirmDeleteMessage({
        url: `/api/messages/premium/${encodeURIComponent(id)}`,
        afterDelete: () => reloadActiveList({ reset: true }),
    }));

    if (m.direction === 'in' && !m.read) {
        m.read = true;
        elList.querySelector(`.mcli[data-key="p${id}"]`)?.classList.remove('unread');
        setUnread('premium', premiumCache.filter(x => x.direction === 'in' && !x.read).length);
        try {
            await fetch(`/api/messages/premium/${id}/read`, { method: 'POST' });
        } catch { /* Netzwerkfehler – Zähler korrigiert sich beim nächsten Poll */ }
    }
}

/**
 * Support-Verlauf rechts: Kopf mit der eigenen Identität ("Von", unter der
 * geantwortet wird) und der Gegenstelle ("An") wie bei einer E-Mail, darunter der
 * Verlauf und das Antwortfeld. Löschen betrifft beim Support bewusst die ganze
 * Konversation, nicht einzelne Nachrichten (Vorgabe 2026-08-14).
 *
 * markRead nur bei einer echten Nutzeraktion setzen (Klick auf die Konversation) –
 * nicht beim Öffnen nach dem Senden und in keinem Hintergrund-Refresh.
 */
async function openSupportThread(peerPubkeyHex, threadId, { markRead = false } = {}) {
    activePeer     = peerPubkeyHex;
    activeThreadId = threadId;
    elPane.innerHTML = `
        <div class="mc-pane-head">
            <h2 class="mc-pane-title">${esc(tr('msg.conversation', 'Konversation'))}</h2>
            <div class="mc-pane-actions">
                <button type="button" class="msg-icon-btn" id="msgDeleteThreadBtn"
                    title="${tr('msg.delete_conv', 'Konversation löschen')}" aria-label="${tr('msg.delete_conv', 'Konversation löschen')}">🗑</button>
            </div>
        </div>
        <div class="mc-pane-body">
            ${metaHtml([
                [tr('msg.from', 'Von'), peerLabelWithNpub(currentNpub, currentAlias)],
                // "An" statt des früheren "Mit" (2026-08-16): im Verlauf gehen zwar
                // Nachrichten in beide Richtungen, die Zeile beschreibt aber das Ziel
                // der nächsten Antwort – und genau die tippt man direkt darunter.
                // Gleiche Beschriftung wie bei System/Premium, statt zweier Begriffe
                // für dieselbe Sache.
                [tr('msg.to', 'An'), `<span id="msgThreadPeer">${tr('msg.loading', 'Lade…')}</span>`],
            ])}
            <div class="msg-thread" id="msgThread"><div class="msg-empty">${tr('msg.loading', 'Lade…')}</div></div>
            <form class="msg-compose" id="msgComposeForm">
                <textarea id="msgComposeInput" rows="3" placeholder="${tr('msg.reply_ph', 'Antworten…')}" maxlength="1000"></textarea>
                <div class="msg-compose-actions"><button type="submit">${tr('msg.send', 'Senden')}</button></div>
            </form>
            <div class="msg-status" id="msgStatus"></div>
        </div>`;

    elPane.querySelector('#msgDeleteThreadBtn').addEventListener('click', () => deleteSupportThread(peerPubkeyHex, threadId));
    elPane.querySelector('#msgComposeForm').addEventListener('submit', onComposeSubmit);
    if (markRead) await markSupportThreadRead(peerPubkeyHex, threadId);
    await loadThreadMessages();
}

/** Quittiert ein Anliegen serverseitig als gelesen (siehe POST .../read). */
async function markSupportThreadRead(peerPubkeyHex, threadId) {
    try {
        const qs = threadId ? `?threadId=${encodeURIComponent(threadId)}` : '';
        await fetch(`/api/messages/support/thread/${peerPubkeyHex}/read${qs}`, { method: 'POST' });
    } catch { /* Netzwerkfehler – bleibt ungelesen, der Zähler stimmt beim nächsten Poll wieder */ }
}

async function loadThreadMessages() {
    if (!activePeer) return;
    const thread = document.getElementById('msgThread');
    if (!thread) return;
    try {
        const r = await fetch(supportThreadUrl(activePeer, activeThreadId));
        const { messages, peerName, peerNpub } = await r.json();
        const peerEl = document.getElementById('msgThreadPeer');
        if (peerEl) peerEl.innerHTML = peerLabelWithNpub(peerNpub, peerNick(peerName));
        if (!messages.length) {
            thread.innerHTML = `<div class="msg-empty">${tr('msg.no_messages', 'Noch keine Nachrichten.')}</div>`;
            return;
        }
        thread.innerHTML = messages.map(m => `
            <div class="msg-item msg-${m.direction}">
                <div class="msg-item-text">${renderMessageBody(m.text)}</div>
                <div class="msg-item-meta">${fmtDateTime(m.timestamp)}</div>
            </div>
        `).join('');
        thread.scrollTop = thread.scrollHeight;
        // Liste nachziehen (letzte Nachricht/Zeitpunkt je Konversation). Der Abruf
        // oben quittiert seit 2026-08-16 NICHTS mehr – kommt hier also eine neue
        // Nachricht in den offenen Verlauf, bleibt sie ungelesen und der Zähler an
        // der Rubrik zeigt sie weiter an, bis der Nutzer sie anklickt oder den Haken
        // drückt.
        await reloadActiveList();
        refreshBadges();
    } catch {
        thread.innerHTML = `<div class="msg-empty">${tr('msg.history_load_failed', '⚠️ Verlauf konnte nicht geladen werden.')}</div>`;
    }
}

function supportThreadUrl(peerPubkey, threadId) {
    const qs = threadId ? `?threadId=${encodeURIComponent(threadId)}` : '';
    return `/api/messages/support/thread/${peerPubkey}${qs}`;
}

async function onComposeSubmit(e) {
    e.preventDefault();
    if (!activePeer) return;
    const input  = document.getElementById('msgComposeInput');
    const status = document.getElementById('msgStatus');
    const text   = input.value.trim();
    if (!text) return;

    status.textContent = tr('msg.sending', 'Sende…');
    try {
        const r = await fetch('/api/messages/support/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, peerPubkey: activePeer, threadId: activeThreadId }),
        });
        const data = await r.json();
        if (!r.ok) {
            status.textContent = `⚠️ ${data.error ?? tr('msg.send_failed', 'Senden fehlgeschlagen')}`;
            return;
        }
        input.value = '';
        status.textContent = '';
        await loadThreadMessages();
    } catch {
        status.textContent = `⚠️ ${tr('msg.send_failed_net', 'Senden fehlgeschlagen (Netzwerk)')}`;
    }
}

// ── Neue Nachricht verfassen (ebenfalls rechts, kein Modal) ──────────────────
async function fetchContacts() {
    try {
        const r = await fetch('/api/messages/contacts');
        if (!r.ok) return [];
        const data = await r.json();
        return Array.isArray(data.contacts) ? data.contacts : [];
    } catch { return []; }
}

// Auf einer FORGE-public-Installation ist der Empfänger fest der FORGE Master (die
// Rubrik heißt "Support") – keine freie npub-Eingabe, damit niemand versehentlich
// (oder durch Social Engineering über eine gefälschte npub) mit der falschen
// Gegenstelle statt dem echten Support kommuniziert. Auf dem FORGE Master gilt das
// Gegenteil: er beantwortet Anfragen beliebiger Nutzer und muss deren npub eintragen
// können (Vorgabe 2026-08-16) – deshalb dort ein Eingabefeld statt des festen
// Kontakts. Jede neue Nachricht startet in beiden Fällen ein frisches Anliegen
// (newThread:true), statt in einem wachsenden Sammel-Verlauf zu landen.
document.getElementById('msgNewBtn').addEventListener('click', () => openCompose());

/**
 * quoteText: Zitat einer weiterzuleitenden System-Meldung (siehe
 * forwardSystemMessage) – steht als eigener, NICHT editierbarer Block über der
 * Textarea, nicht mit ihr vermischt (Feedback 2026-08-09: vorher lagen Zitat und
 * Kommentar in einem gemeinsamen, frei bearbeitbaren Feld ohne erkennbare
 * Trennung). null/leer beim normalen "Neue Nachricht"-Button.
 */
async function openCompose(quoteText = null) {
    composeOpen = true;
    activeKey = null;
    elList.querySelectorAll('.mcli').forEach(el => el.classList.remove('selected'));

    const contacts = await fetchContacts();
    const master   = contacts.find(c => c.id === 'forge-master');
    // Master: freies Eingabefeld. Sonst die feste Gegenstelle mit Nick, npub nur
    // gekürzt daneben (Vorgabe 2026-08-16).
    const toHtml = isMasterIdentity
        ? `<input type="text" id="msgNewPeer" class="mcs-search" style="min-width:min(100%,26rem)"
               placeholder="${tr('msg.recipient_npub_ph', 'npub1… oder 64-stelliger Hex-Pubkey')}" autocomplete="off" spellcheck="false">`
        : (master
            ? peerLabelWithNpub(master.npub, peerNick(master.label))
            : esc(tr('msg.master_contact_unavailable_warn', '⚠️ FORGE-Master-Kontakt nicht verfügbar')));

    elPane.innerHTML = `
        <div class="mc-pane-head">
            <h2 class="mc-pane-title">${esc(tr('msg.new_message', 'Neue Nachricht'))}</h2>
        </div>
        <div class="mc-pane-body">
            ${metaHtml([
                [tr('msg.from', 'Von'), peerLabelWithNpub(currentNpub, currentAlias)],
                [tr('msg.to',   'An'),  toHtml],
            ])}
            ${quoteText ? `
            <div class="msg-modal-field">
                <label>${tr('msg.forwarded_readonly', 'Weitergeleitete Meldung (nicht bearbeitbar)')}</label>
                <div class="msg-quote-block msg-quote-block-compose">${esc(quoteText).replace(/\n/g, '<br>')}</div>
            </div>` : ''}
            <form class="msg-compose" id="msgNewForm">
                <label for="msgNewText" style="font-size:0.78rem;color:var(--text-muted)">${quoteText
                    ? tr('msg.your_question', 'Deine Frage/Anmerkung dazu')
                    : tr('msg.message_de', 'Nachricht')}</label>
                <textarea id="msgNewText" rows="8" maxlength="1000" placeholder="${quoteText
                    ? tr('msg.what_to_know', 'Was möchtest Du dazu wissen…')
                    : tr('msg.message_ph', 'Nachricht…')}"></textarea>
                <div class="msg-compose-actions">
                    <button type="button" class="msg-btn-secondary" id="msgNewCancel">${tr('common.cancel', 'Abbrechen')}</button>
                    <button type="submit">${tr('msg.send', 'Senden')}</button>
                </div>
            </form>
            <div class="msg-status" id="msgNewStatus"></div>
        </div>`;

    elPane.querySelector('#msgNewCancel').addEventListener('click', () => { composeOpen = false; renderPanePlaceholder(); });
    elPane.querySelector('#msgNewForm').addEventListener('submit', (e) => { e.preventDefault(); sendNewMessage(master, quoteText); });
    // Auf dem Master zuerst in die Empfängerzeile, sonst direkt in den Text – dort
    // steht der Empfänger ohnehin fest.
    elPane.querySelector(isMasterIdentity ? '#msgNewPeer' : '#msgNewText').focus();
}

/** npub1…/Hex vorab prüfen, damit eine Zahlendreher-Eingabe nicht erst am Relay auffällt. */
const PUBKEY_RE = /^(npub1[02-9ac-hj-np-z]{58}|[0-9a-fA-F]{64})$/;

async function sendNewMessage(master, quoteText = null) {
    const textInput = document.getElementById('msgNewText');
    const status    = document.getElementById('msgNewStatus');
    const comment   = textInput.value.trim();

    // Auf dem Master kommt der Empfänger aus der Eingabe, sonst aus dem Adressbuch.
    const peerInput = document.getElementById('msgNewPeer');
    const peer      = isMasterIdentity ? (peerInput?.value.trim() ?? '') : master?.npub;
    if (isMasterIdentity) {
        if (!peer) { status.textContent = tr('msg.enter_recipient', 'Bitte einen Empfänger (npub) eingeben.'); peerInput?.focus(); return; }
        if (!PUBKEY_RE.test(peer)) { status.textContent = tr('msg.invalid_recipient', 'Kein gültiger Nostr-Schlüssel – erwartet wird npub1… oder ein 64-stelliger Hex-Pubkey.'); peerInput?.focus(); return; }
    } else if (!master) {
        status.textContent = tr('msg.master_contact_unavailable', 'FORGE-Master-Kontakt nicht verfügbar.');
        return;
    }
    if (!comment) {
        status.textContent = quoteText
            ? tr('msg.enter_question', 'Bitte eine Frage/Anmerkung zur weitergeleiteten Meldung eingeben.')
            : tr('msg.enter_message', 'Bitte eine Nachricht eingeben.');
        return;
    }
    const text = quoteText ? `${QUOTE_OPEN}\n${quoteText}\n${QUOTE_CLOSE}\n\n${comment}` : comment;

    status.textContent = tr('msg.sending', 'Sende…');
    try {
        const r = await fetch('/api/messages/support/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, peerPubkey: peer, newThread: true }),
        });
        const data = await r.json();
        if (!r.ok) {
            status.textContent = `⚠️ ${data.error ?? tr('msg.send_failed', 'Senden fehlgeschlagen')}`;
            return;
        }
        composeOpen = false;
        showToast(tr('msg.sent', 'Nachricht gesendet'), 'success');
        await reloadActiveList({ reset: true });
        // Hex-Pubkey kommt vom Server zurück – bei freier Eingabe kann `peer` eine
        // npub sein, der Verlauf wird aber über die Hex-Form adressiert.
        const peerHex = data.peerPubkey ?? master?.pubkeyHex;
        markSelected(`t${encodeThreadKey(peerHex, data.threadId ?? null)}`);
        openSupportThread(peerHex, data.threadId ?? null);
    } catch {
        status.textContent = `⚠️ ${tr('msg.send_failed_net', 'Senden fehlgeschlagen (Netzwerk)')}`;
    }
}

// ── Weiterleiten an den Support ──────────────────────────────────────────────
// Zwischenschritt vor dem Weiterleiten (Feedback 2026-08-09): ein Klick auf das
// Icon soll nicht überraschend direkt in eine neue Support-Nachricht springen –
// erst eine bewusste Rückfrage, dann (nur nach "Weiter") der eigentliche Wechsel.
function confirmForwardSystemMessage(n) {
    const cid = 'msg-forward-confirm';
    showModal({
        id:    cid,
        title: tr('msg.forward_q', 'Nachricht weiterleiten?'),
        body:  '<p style="margin:0;font-size:0.88rem;line-height:1.5">' + tr('msg.forward_question', 'Hast Du eine Frage zu dieser Meldung und möchtest sie an den Support weiterleiten?') + '</p>',
        actions: [
            { label: tr('common.next', 'Weiter'), onClick: () => { closeModal(cid); forwardSystemMessage(n); } },
            { label: tr('common.cancel', 'Abbrechen'), onClick: () => closeModal(cid) },
        ],
    });
}

// Statt die Meldung mühsam per Copy&Paste in eine neue Support-Nachricht zu
// übertragen, übernimmt dies den kompletten Inhalt (Art/Bot/Zeitpunkt/Text) als
// Zitat. Zitat und Kommentar werden erst beim Senden mit den QUOTE-Markern
// zusammengefügt. Versand bleibt bewusst manuell (kein Auto-Send).
function forwardSystemMessage(n) {
    const bot = n.botName || n.botId || 'System';
    const quoteText = [
        `${tr('msg.subject', 'Betreff')}: ${LEVEL_LABEL[n.level] ?? n.level}${n.pool ? ` · ${n.pool}` : ''}`,
        `${tr('msg.from', 'Von')}: ${bot}`,
        `${tr('msg.timestamp', 'Zeitpunkt')}: ${fmtDateTimeLong(n.timestamp)}`,
        '',
        stripEmoji(stripNotifyHeader(n.message)),
    ].join('\n');
    selectMenu('support');
    openCompose(quoteText);
}

// Weitergeleitetes Zitat wird im tatsächlich versendeten Text mit diesen Markern
// umschlossen (Feedback 2026-08-09: eine reine Text-Trennlinie zwischen Zitat und
// Kommentar reichte der Empfängerseite nicht – beides wirkte im Verlauf trotzdem
// wie ein einziger, schwer lesbarer Block). renderMessageBody() erkennt sie beim
// Rendern auf BEIDEN Seiten und stellt den Inhalt dazwischen als eigenen,
// hervorgehobenen Block dar. Bewusst einfache Text-Marker statt echtem HTML:
// bleiben auch für einen fremden Nostr-Client der Gegenstelle als Klartext lesbar.
const QUOTE_OPEN  = '<quote>';
const QUOTE_CLOSE = '</quote>';

// Für Vorschau-Texte in der Liste – dort wird nur ein einzeiliger Ausschnitt
// gezeigt, kein eigener Zitat-Block wie im Verlauf. Die Marker sind reine
// Render-Hilfe und sollen dort nicht als Rohtext auftauchen.
function stripQuoteMarkers(text) {
    return String(text ?? '')
        .replace(new RegExp(`${QUOTE_OPEN}\\n?`, 'g'), '')
        .replace(new RegExp(`\\n?${QUOTE_CLOSE}`, 'g'), '');
}

// Zerlegt eine Nachricht in einen optionalen Zitat-Block + den Rest und baut
// daraus sicheres HTML (escaped) – zentral genutzt von loadThreadMessages(),
// damit Absender- und Empfängeransicht identisch aussehen.
function renderMessageBody(rawText) {
    const m = new RegExp(`^${QUOTE_OPEN}\\n([\\s\\S]*?)\\n${QUOTE_CLOSE}\\n*([\\s\\S]*)$`).exec(rawText ?? '');
    if (!m) return `<div class="msg-own-comment">${esc(stripEmoji(rawText))}</div>`;
    const quoteHtml   = esc(stripEmoji(m[1])).replace(/\n/g, '<br>');
    const commentHtml = esc(stripEmoji(m[2]));
    return `
        <div class="msg-quote-label">${tr('msg.forwarded_marker', '↪ Weitergeleitete Meldung')}</div>
        <div class="msg-quote-block">${quoteHtml}</div>
        ${commentHtml ? `<div class="msg-own-comment">${commentHtml}</div>` : ''}`;
}

// ── Löschen ──────────────────────────────────────────────────────────────────
/**
 * Löschen einer einzelnen Nachricht mit Rückfrage (System/Premium). Bestätigung
 * über ein eigenes Modal statt window.confirm() (keine nativen Browser-Dialoge).
 *
 * Serverseitig unterscheiden sich die Kanäle deutlich (System → Nexus, der als
 * einziger Prozess auf nexus.db schreibt; Premium → Premium-Dienst inkl. Tombstone
 * gegen wiederauftauchende Relay-Kopien), deshalb bekommt diese Funktion nur die
 * fertige URL statt selbst zu unterscheiden.
 */
function confirmDeleteMessage({ url, afterDelete }) {
    const confirmMid = 'msg-delete-confirm';
    showModal({
        id:    confirmMid,
        title: tr('msg.delete_msg_q', 'Nachricht löschen?'),
        body:  '<p style="margin:0;font-size:0.88rem;line-height:1.5">' + tr('msg.delete_msg_note', 'Diese Nachricht wird unwiderruflich gelöscht.') + '</p>',
        actions: [
            {
                label: tr('msg.delete', 'Löschen'), onClick: async () => {
                    try {
                        const r = await fetch(url, { method: 'DELETE' });
                        const data = await r.json().catch(() => ({}));
                        if (!r.ok) { showToast(data.error ?? tr('msg.delete_failed', 'Löschen fehlgeschlagen'), 'error'); return; }
                        closeModal(confirmMid);
                        showToast(tr('msg.msg_deleted', 'Nachricht gelöscht'), 'success');
                        renderPanePlaceholder();
                        await afterDelete();
                        refreshBadges();
                    } catch {
                        showToast(tr('msg.delete_failed_net', 'Löschen fehlgeschlagen (Netzwerk)'), 'error');
                    }
                },
            },
            { label: tr('common.cancel', 'Abbrechen'), onClick: () => closeModal(confirmMid) },
        ],
    });
}

// Löscht nur die lokale Kopie (eigene DB) – auf Nostr-Relays bereits verbreitete
// Events bleiben dort bestehen, das lässt sich clientseitig nicht zurückholen.
async function deleteSupportThread(peerPubkeyHex, threadId) {
    const confirmMid = 'msg-support-delete-confirm';
    showModal({
        id:    confirmMid,
        title: tr('msg.delete_conv_q', 'Konversation löschen?'),
        body:  '<p style="margin:0;font-size:0.88rem;line-height:1.5">' + tr('msg.delete_conv_note', 'Diese Konversation wird unwiderruflich gelöscht.') + '</p>',
        actions: [
            {
                label: tr('msg.delete', 'Löschen'), onClick: async () => {
                    try {
                        const r = await fetch(supportThreadUrl(peerPubkeyHex, threadId), { method: 'DELETE' });
                        const data = await r.json().catch(() => ({}));
                        if (!r.ok) { showToast(data.error ?? tr('msg.delete_failed', 'Löschen fehlgeschlagen'), 'error'); return; }
                        closeModal(confirmMid);
                        showToast(tr('msg.conv_deleted', 'Konversation gelöscht'), 'success');
                        activePeer = null; activeThreadId = null;
                        renderPanePlaceholder();
                        await reloadActiveList({ reset: true });
                        refreshBadges();
                    } catch {
                        showToast(tr('msg.delete_failed_net', 'Löschen fehlgeschlagen (Netzwerk)'), 'error');
                    }
                },
            },
            { label: tr('common.cancel', 'Abbrechen'), onClick: () => closeModal(confirmMid) },
        ],
    });
}

// ── "Alle als gelesen" ───────────────────────────────────────────────────────
document.getElementById('mcMarkAllBtn').addEventListener('click', async () => {
    if (isNotifTab(activeMenu)) {
        // fetchAllNotificationIds() fragt bewusst OHNE Suchbegriff ab – sonst markiert
        // "alle als gelesen" bei aktiver Suche nur die paar Treffer (Bug 2026-07-30).
        // Betrifft nur die aktive Rubrik: System und Bots werden getrennt quittiert.
        await markSystemRead(await fetchAllNotificationIds());
    } else if (activeMenu === 'premium') {
        for (const m of premiumCache.filter(x => x.direction === 'in' && !x.read)) {
            m.read = true;
            try { await fetch(`/api/messages/premium/${m.id}/read`, { method: 'POST' }); } catch { /* Zähler korrigiert sich beim nächsten Poll */ }
        }
    } else {
        // Kein Bulk-Endpoint – jedes offene Anliegen einzeln quittieren.
        for (const t of supportThreads.filter(x => x.unreadCount > 0)) {
            await markSupportThreadRead(t.peerPubkey, t.threadId);
        }
    }
    await reloadActiveList();
    refreshBadges();
});

// ── Einstellungen (Vollbreite-Panel, kein Reiter) ────────────────────────────
async function renderSettingsPanel() {
    elDetailBody.innerHTML = `
        <div class="msg-settings">
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">${tr('msg.chaching_sound', 'Kasching-Sound')}</span>
                    <span class="msg-setting-hint">${tr('msg.sound_on_revenue', 'Ton bei neuen Umsätzen (Fee-Claims / Yield)')}</span>
                </span>
                <input type="checkbox" id="setSound">
            </label>
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">${tr('msg.revenue_popups', 'Umsatz-Popups')}</span>
                    <span class="msg-setting-hint">${tr('msg.toast_on_revenue', 'Toast-Einblendungen bei neuen Umsätzen')}</span>
                </span>
                <input type="checkbox" id="setPopups">
            </label>
            <p class="msg-settings-note">
                Gilt für alle lokalen Dashboards (gleiche Origin).
            </p>

            <h3 class="msg-settings-heading">${tr('msg.notifications', 'Benachrichtigungen')}</h3>
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">${tr('msg.system_messages', 'System-Nachrichten')}</span>
                    <span class="msg-setting-hint">Zähler oben (Reiter + Brief-Icon) bei neuen System-Meldungen. Ausgeschaltet: keine Zähler/Hinweise, die Nachrichten bleiben in der Rubrik System trotzdem sichtbar.</span>
                </span>
                <input type="checkbox" id="setNotifySystem">
            </label>
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">${tr('msg.bot_messages', 'Bot-Nachrichten')}</span>
                    <span class="msg-setting-hint">Zähler oben (Reiter + Brief-Icon) bei neuen Meldungen von Liquidity Bot und Lending Bot. Ausgeschaltet: keine Zähler/Hinweise, die Nachrichten bleiben in der Rubrik Bots trotzdem sichtbar.</span>
                </span>
                <input type="checkbox" id="setNotifyBots">
            </label>
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">${tr('msg.support_messages', 'Support-Nachrichten')}</span>
                    <span class="msg-setting-hint">Zähler oben (Reiter + Brief-Icon) bei neuen Antworten. Ausgeschaltet: keine Zähler/Hinweise, die Konversationen bleiben in der Rubrik Support trotzdem sichtbar.</span>
                </span>
                <input type="checkbox" id="setNotifySupport">
            </label>
            <label class="msg-setting-row">
                <span>
                    <span class="msg-setting-label">${tr('msg.premium_messages', 'Premium-Nachrichten')}</span>
                    <span class="msg-setting-hint">Zähler oben (Reiter + Brief-Icon) bei neuen Premium-Meldungen. Ausgeschaltet: keine Zähler/Hinweise, die Nachrichten bleiben in der Rubrik Premium trotzdem sichtbar.</span>
                </span>
                <input type="checkbox" id="setNotifyPremium">
            </label>

            <h3 class="msg-settings-heading">${tr('msg.nostr_account', 'Nostr-Account')}</h3>
            <div class="msg-account-row">
                <span class="msg-setting-label">${tr('msg.identity_npub', 'Identität (npub)')}</span>
                <div class="mc-identity" id="msgIdentity">
                    <span class="msg-identity-text" id="msgIdentityText">${tr('msg.loading_identity', 'Lade Identität…')}</span>
                    <button type="button" class="msg-icon-btn" id="msgCopyBtn" title="${tr('msg.copy_npub', 'npub kopieren')}" aria-label="${tr('msg.copy_npub', 'npub kopieren')}" hidden>⧉</button>
                    <button type="button" class="msg-icon-btn" id="msgQrBtn" title="${tr('msg.show_qr', 'QR-Code anzeigen')}" aria-label="${tr('msg.show_qr', 'QR-Code anzeigen')}" hidden>▦</button>
                </div>
            </div>
            <div class="msg-account-row">
                <span class="msg-setting-label">${tr('msg.display_name', 'Anzeigename')}</span>
                <div class="msg-account-controls">
                    <input type="text" id="setAlias" maxlength="60" placeholder="${tr('msg.forge_public_user', 'FORGE Public User')}">
                    <button type="button" id="setAliasBtn" class="msg-account-btn">${tr('msg.save', 'Speichern')}</button>
                </div>
            </div>
            <div class="msg-account-row">
                <span class="msg-setting-label">${tr('msg.account_reset', 'Account zurücksetzen')}</span>
                <span class="msg-setting-hint" id="msgResetHint">
                    Erzeugt einen neuen Nostr-Account. Der bisherige Account und
                    <strong>${tr('msg.all_previous_messages', 'alle bisherigen Nachrichten')}</strong> werden dabei
                    unwiderruflich gelöscht.
                </span>
                <div class="msg-account-controls">
                    <button type="button" id="setRegenBtn" class="msg-account-btn">${tr('msg.resetting', 'Zurücksetzen…')}</button>
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

    // Betrifft ausschließlich Zähler/Badges (Reiter + Brief-Icon) – die Nachrichten
    // selbst bleiben immer sichtbar, siehe isNotifyEnabled() in message-bell.js.
    const NOTIFY_CHECKBOX_IDS = { system: 'setNotifySystem', bots: 'setNotifyBots', support: 'setNotifySupport', premium: 'setNotifyPremium' };
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
            if (idTextEl) idTextEl.textContent = `⚠️ ${err.error ?? tr('msg.identity_unavailable', 'Identität nicht verfügbar')}`;
            return;
        }
        const id = await r.json();
        currentNpub  = id.npub;
        currentAlias = id.alias || id.name;
        isMasterIdentity = id.isMaster === true;
        if (aliasInput && id.alias) aliasInput.value = id.alias;
        if (idTextEl) {
            idTextEl.innerHTML = `<b>${esc(currentAlias)}</b> · npub: <code>${shortPeer(id.npub)}</code>`;
            document.getElementById('msgCopyBtn').hidden = false;
            document.getElementById('msgQrBtn').hidden = false;
        }
        // FORGE Master: npub muss stabil bleiben, damit ihn Gegenstellen (u.a.
        // FORGE-public-Forks) weiterhin finden – Reset serverseitig gesperrt, hier
        // zusätzlich in der UI sichtbar machen statt nur den Klick scheitern zu lassen.
        if (id.resetLocked) {
            regenBtn.disabled = true;
            // Zwei grundverschiedene Sperrgründe: der eine ist dauerhaft und betrifft nur
            // den Betreiber, der andere ist vom Nutzer selbst auflösbar. Ein gemeinsamer
            // Text müsste beides gleichzeitig behaupten – und würde einem Fork-Nutzer
            // erklären, er sei "der FORGE Master".
            if (id.resetLockReason === 'health-share') {
                regenBtn.title = tr('msg.blocked_share', 'Gesperrt, solange ein Premium-Zugang über die Datenfreigabe besteht');
                regenHint.textContent = tr('msg.blocked_share_note',
                    'Gesperrt, solange über die Datenfreigabe ein Premium-Zugang besteht: Die Zusage hängt an genau diesem Nostr-Zugang und ginge bei einem Wechsel verloren. Der Anzeigename kann jederzeit geändert werden.');
            } else {
                regenBtn.title = tr('msg.blocked_master', 'Auf dem FORGE Master gesperrt');
                regenHint.textContent =
                    tr('msg.blocked_master_note', 'Auf dem FORGE Master gesperrt: andere Nostr-Clients (u.a. FORGE-public-Forks) ') +
                    tr('msg.would_need_npub', 'müssten die neue npub erst wieder finden. Der Anzeigename kann trotzdem ') +
                    tr('msg.can_be_changed', 'geändert werden.');
            }
        }
    } catch {
        if (idTextEl) idTextEl.textContent = '⚠️ Nostr-Service nicht erreichbar';
        // Identität sonst nicht verfügbar – Panel bleibt trotzdem bedienbar.
    }

    document.getElementById('msgCopyBtn')?.addEventListener('click', () => copyNpub(currentNpub));

    document.getElementById('msgQrBtn')?.addEventListener('click', () => {
        if (!currentNpub) return;
        showModal({
            id: 'msg-qr',
            title: tr('msg.scan_contact', 'Nostr-Kontakt scannen'),
            body: `
                <div class="qr-wrapper" style="margin: 0 auto;">
                    <img class="qr-img" alt="Nostr-QR-Code" src="/api/messages/identity/qr">
                </div>
                <div class="msg-qr-hint" style="text-align:center;margin-top:0.75rem;">
                    In Amethyst per „QR scannen" als Kontakt hinzufügen.
                </div>`,
            actions: [{ label: tr('common.close', 'Schließen'), onClick: () => closeModal('msg-qr') }],
        });
    });
}

async function onSaveAlias() {
    const input = document.getElementById('setAlias');
    const status = document.getElementById('msgAccountStatus');
    const alias = input.value.trim();
    status.textContent = tr('msg.saving', 'Speichere…');
    try {
        const r = await fetch('/api/messages/identity/alias', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias }),
        });
        const data = await r.json();
        if (!r.ok) {
            status.textContent = `⚠️ ${data.error ?? tr('msg.save_failed', 'Speichern fehlgeschlagen')}`;
            return;
        }
        input.value = data.alias;
        status.textContent = '';
        // currentAlias mitziehen – er steht als Empfänger in jeder geöffneten
        // Nachricht; ohne das zeigte die Ansicht bis zum nächsten Poll den alten Nick.
        currentAlias = data.alias;
        showToast(`${tr('msg.display_name_set', 'Anzeigename gesetzt')}: ${data.alias}`, 'success');
    } catch {
        status.textContent = `⚠️ ${tr('msg.save_failed_net', 'Speichern fehlgeschlagen (Netzwerk)')}`;
    }
}

// Account zurücksetzen: unwiderruflich (neuer Key + alle Nachrichten weg).
// Deshalb ZWEI Hürden – erst dieser Dialog, dann verlangt der Server zusätzlich
// confirm=true. Die Folgen stehen im Klartext im Dialog, nicht nur als Farbe/Icon.
function onRegenerateClick() {
    showModal({
        id: 'msg-regen',
        title: tr('msg.nostr_account_reset_q', 'Nostr-Account zurücksetzen?'),
        body: `
            <p style="margin:0 0 0.75rem;font-size:0.88rem;line-height:1.5">
                Es wird ein <b>${tr('msg.new_short', 'neuer')}</b> Nostr-Account erzeugt. Dabei gehen unwiderruflich verloren:
            </p>
            <ul style="margin:0 0 0.75rem 1.1rem;font-size:0.85rem;line-height:1.6">
                <li>${tr('msg.previous_account', 'der bisherige Account (deine bisherige npub wird ungültig)')}</li>
                <li><b>${tr('msg.all_previous_messages', 'alle bisherigen Nachrichten')}</b>${tr('msg.also_running_conv', ', auch laufende Konversationen')}</li>
            </ul>
            <p style="margin:0 0 0.75rem;font-size:0.85rem;line-height:1.5">
                Gegenstellen können dich danach nur noch über die neue npub erreichen.
            </p>
            <div class="msg-modal-field">
                <label for="msgRegenAlias">${tr('msg.display_name_new', 'Anzeigename für den neuen Account (optional)')}</label>
                <input type="text" id="msgRegenAlias" maxlength="60" placeholder="${tr('msg.forge_public_user', 'FORGE Public User')}">
            </div>
            <div class="msg-status" id="msgRegenStatus"></div>`,
        actions: [
            { label: tr('msg.yes_reset', 'Ja, zurücksetzen'), onClick: regenerateAccount },
            { label: tr('common.cancel', 'Abbrechen'), onClick: () => closeModal('msg-regen') },
        ],
    });
}

async function regenerateAccount() {
    const status = document.getElementById('msgRegenStatus');
    const alias = document.getElementById('msgRegenAlias').value.trim();
    status.textContent = tr('msg.creating_account', 'Erzeuge neuen Account…');
    try {
        const r = await fetch('/api/messages/identity/regenerate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: true, alias }),
        });
        const data = await r.json();
        if (!r.ok) {
            status.textContent = `⚠️ ${data.error ?? tr('msg.reset_failed', 'Zurücksetzen fehlgeschlagen')}`;
            return;
        }
        closeModal('msg-regen');
        showToast(`${tr('msg.new_account_active', 'Neuer Nostr-Account aktiv.')} ${data.deletedMessages} ${tr('msg.messages_deleted', 'Nachricht(en) gelöscht.')}`, 'success');
        loadSettingsIdentity();
    } catch {
        status.textContent = tr('msg.reset_failed_net', '⚠️ Zurücksetzen fehlgeschlagen (Netzwerk)');
    }
}

// ── Live-Push (Server-Sent Events) ──────────────────────────────────────────
// Der Server bekommt neue Nachrichten bereits live über die Nostr-Subscription –
// per SSE landen sie ohne Neuladen/Polling direkt in der offenen Liste bzw. im
// offenen Verlauf. EventSource verbindet sich bei Abbruch automatisch neu.
function connectMessageStream() {
    const es = new EventSource('/api/messages/support/stream');
    es.addEventListener('support-message', (ev) => {
        refreshBadges();
        if (activeMenu !== 'support') return;
        const payload = JSON.parse(ev.data);
        if (activePeer && activePeer === payload.peerPubkey) loadThreadMessages();
        else reloadActiveList();
    });
    es.addEventListener('premium-message', () => {
        refreshBadges();
        if (activeMenu === 'premium') reloadActiveList();
    });
}

// ── Init + Fallback-Polling ──────────────────────────────────────────────────
// currentAlias/currentNpub/isMasterIdentity VOR dem ersten Render laden
// (localhost-Call, siehe routes/messages.js): der Nick steht als Empfänger in jeder
// geöffneten Nachricht und als Absender im Support-Verlauf, isMasterIdentity
// entscheidet über die npub-Eingabe beim Verfassen. Fehlschlag ist kein
// Abbruchgrund – myNick() fällt dann auf den Default zurück und das Verfassen
// bleibt auf den festen Support-Kontakt beschränkt, also auf die engere Variante.
await fetch('/api/messages/identity').then(r => r.ok ? r.json() : null).then(id => {
    if (!id) return;
    currentNpub  = id.npub;
    currentAlias = id.alias || id.name;
    isMasterIdentity = id.isMaster === true;
}).catch(() => {});

selectMenu(initialMenu);
if (initialMenu === 'support' && initialPeer) {
    markSelected(`t${encodeThreadKey(initialPeer, null)}`);
    // Deep-Link (Brief-Icon im Health Monitor) zählt als bewusstes Öffnen genau
    // dieser Konversation – gleiche Wirkung wie ein Klick in der Liste.
    openSupportThread(initialPeer, null, { markRead: true });
}
connectMessageStream();
refreshBadges();

/**
 * Liste, offenen Verlauf und die Zähler an den Reitern auffrischen. Auswahl und
 * Scrollposition bleiben erhalten (siehe renderList()), das Verfassen-Formular wird
 * nicht angetastet – sonst wäre ein halb getippter Text weg.
 */
function refreshActiveView() {
    if (activeMenu === 'einstellungen') return;
    if (activeMenu === 'support' && activePeer && !composeOpen) loadThreadMessages();
    else reloadActiveList();
    refreshBadges();
}

// Grobes Sicherheitsnetz, falls die SSE-Verbindung mal steht (z.B. Netzwerk-Hänger).
// Trägt außerdem die System-Meldungen nach: die kommen aus der Nexus-DB und haben
// bewusst keinen Push-Kanal (SSE liefert nur Support/Premium aus dem Premium-Dienst,
// Begründung siehe message-bell.js – eine Dauerverbindung je Dashboard-Tab wäre für
// ein Ungelesen-Badge unverhältnismäßig).
setInterval(refreshActiveView, 30_000);

// Sofort auffrischen, sobald der Tab wieder sichtbar wird – genau der Moment, in dem
// der Nutzer hinschaut. Ohne das hinkten die Reiter-Zähler beim Zurückwechseln bis zu
// 30s hinterher, während das Briefsymbol daneben schon aktuell war: message-bell.js
// hat diesen Handler seit jeher, message.js fehlte er (Fund 2026-08-16).
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshActiveView(); });

// Delegierter Klick-Handler für alle .msg-npub-copy-Spans – delegiert statt
// einzeln verdrahtet, weil die Detailansicht bei jedem Öffnen neu gebaut wird.
document.addEventListener('click', (e) => {
    const el = e.target.closest('.msg-npub-copy');
    if (el?.dataset.npub) copyNpub(el.dataset.npub);
});

document.getElementById('lastUpdate').textContent = tr('msg.last_update_prefix', 'Letztes Update: ') + fmtTime(Date.now());
