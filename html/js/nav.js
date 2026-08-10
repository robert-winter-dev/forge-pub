/**
 * FORGE – Zentrale Navigation (Hamburger-Menü)
 *
 * Gemeinsam genutzt von allen Dashboards.
 *
 * Verwendung:
 *   import { initNav } from '../../js/nav.js';
 *   initNav({ current: 'liquidity-dashboard' });
 *
 * Struktur (flache Top-Level-Liste, seit 2026-08-08 — löst das ursprüngliche
 * Problem, dass Bot-Dashboard und Bot-Settings an ganz unterschiedlichen
 * Stellen im Menü standen):
 *   Overview        > (eigener Link, keine Gruppe)
 *   Liquidity Bot   > Dashboard, Settings
 *   Lending Bot     > Dashboard, Settings
 *   Message Center  > System, Support, Premium, Settings
 *   System          > Health Monitor, SSL-Zertifikat, Settings
 * IDs siehe buildNavTree(). Von den vier Gruppen (Liquidity Bot/Lending Bot/
 * Message Center/System) ist per Default nur eine aufgeklappt (Accordion,
 * siehe initNav()) – Öffnen einer anderen schließt die bisher offene.
 *
 * LAN-Erkennung: Wird die Seite über eine private IP aufgerufen
 * (192.168.x.x / 10.x.x.x / 172.16-31.x.x), erscheinen zusätzlich die
 * Bot-Settings-Links, die komplette Message-Center-Gruppe sowie
 * SSL-Zertifikat/Settings unter System.
 */

/** Gibt true zurück wenn der Aufruf aus dem lokalen Netz kommt. */
function isLanAccess() {
    const h = window.location.hostname;
    return /^192\.168\./.test(h)
        || /^10\./.test(h)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/** Baut den Nav-Baum. LAN-only-Zweige/-Items werden nur im lokalen Netz erzeugt. */
function buildNavTree() {
    const lan = isLanAccess();
    const ip  = window.location.hostname;

    const overview = { id: 'overview', label: 'Overview', href: '/forge/' };

    const liquidity = {
        id: 'liquidity', label: 'Liquidity Bot', group: true, items: [
            { id: 'liquidity-dashboard', label: 'Dashboard', href: '/forge/liquidity/' },
            ...(lan ? [{ id: 'settings-liquidity', label: 'Settings', href: `https://${ip}:3200/#liquidity` }] : []),
        ],
    };
    const lending = {
        id: 'lending', label: 'Lending Bot', group: true, items: [
            { id: 'lending-dashboard', label: 'Dashboard', href: '/forge/lending/' },
            ...(lan ? [{ id: 'settings-lending', label: 'Settings', href: `https://${ip}:3200/#lending` }] : []),
        ],
    };

    // Message Center ist komplett LAN-only (läuft auf bots/settings, Port 3200).
    // System/Support/Premium reservieren einen Badge-Slot (hasBadge) für die
    // Ungelesen-Zähler, die früher im jetzt entfallenen Spalten-Menü von
    // message.html standen – message.js aktualisiert sie live per setNavBadge().
    const messageCenter = lan ? {
        id: 'message', label: 'Message Center', group: true, items: [
            { id: 'message-system',       label: 'System',   href: `https://${ip}:3200/message.html#system`,   hasBadge: true },
            { id: 'message-support',      label: 'Support',  href: `https://${ip}:3200/message.html#support`,  hasBadge: true },
            { id: 'message-premium',      label: 'Premium',  href: `https://${ip}:3200/message.html#premium`,  hasBadge: true },
            { id: 'message-einstellungen', label: 'Settings', href: `https://${ip}:3200/message.html#einstellungen` },
        ],
    } : null;

    const system = {
        id: 'system', label: 'System', group: true, items: [
            { id: 'health', label: 'Health Monitor', href: '/forge/health.html' },
            // Port 3201 ist bewusst reines HTTP (kein TLS-Zertifikat gebunden, siehe
            // bots/settings/server.js) – https:// hier würde am TLS-Handshake scheitern.
            ...(lan ? [{ id: 'ssl-cert', label: 'SSL-Zertifikat', href: `http://${ip}:3201/` }] : []),
            // Noch keine eigene Seite (Stand 2026-08-08) — Platzhalter, bis die System-Settings-Seite existiert.
            ...(lan ? [{ id: 'system-settings', label: 'Settings', href: null }] : []),
            // forkOnly: nur auf einem FORGE.pub-Fork sinnvoll (nur er bezieht Releases
            // von GitHub) – bleibt bis zum Fork-Nachweis per /forge/version.json
            // versteckt (siehe renderLeaf() + die bestehende version.json-Abfrage
            // weiter unten, die ohnehin schon genau diesen Fork-Nachweis liefert).
            ...(lan ? [{ id: 'updates', label: 'Updates', href: `https://${ip}:3200/updates.html`, forkOnly: true }] : []),
        ],
    };

    return [overview, liquidity, lending, messageCenter, system].filter(Boolean);
}

const CSS = `
/* ── Nav Hamburger ──────────────────────────────────────────────── */
.nav-hamburger {
    background: none;
    border: none;
    color: var(--text-muted, #94a3b8);
    font-size: 1.3rem;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s;
}
.nav-hamburger:hover {
    background: rgba(255,255,255,0.08);
    color: var(--text, #f1f5f9);
}

/* ── Nav Overlay ────────────────────────────────────────────────── */
.nav-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 999;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
}
.nav-overlay.open {
    opacity: 1;
    pointer-events: auto;
}

/* ── Nav Panel ──────────────────────────────────────────────────── */
.nav-panel {
    position: fixed;
    top: 0;
    left: 0;
    width: 280px;
    max-width: 85vw;
    height: 100vh;
    height: 100dvh;
    background: var(--surface, #1e293b);
    border-right: 1px solid var(--border, #475569);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    box-shadow: 4px 0 24px rgba(0,0,0,0.4);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
}
.nav-panel.open {
    transform: translateX(0);
}

.nav-panel-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px;
    border-bottom: 1px solid var(--border, #475569);
}
.nav-panel-title-group {
    flex: 1;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
}
.nav-panel-title {
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--text, #f1f5f9);
}
.nav-panel-version {
    font-size: 0.7rem;
    color: var(--text-muted, #94a3b8);
}
.nav-panel-version-pulse {
    animation: nav-version-pulse 2.2s ease-in-out infinite;
}
@keyframes nav-version-pulse {
    0%, 100% { color: var(--text-muted, #94a3b8); }
    50%      { color: var(--accent, #00d4ff); }
}
.nav-panel-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted, #94a3b8);
    font-size: 1rem;
    padding: 4px;
    border-radius: 4px;
    line-height: 1;
}
.nav-panel-close:hover { color: var(--text, #f1f5f9); }

.nav-panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
}

/* ── Nav Items ──────────────────────────────────────────────────── */
.nav-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    color: var(--text, #f1f5f9);
    text-decoration: none;
    font-size: 0.88rem;
    font-weight: 500;
    transition: background 0.15s;
    cursor: pointer;
    border-left: 3px solid transparent;
}
.nav-item:hover {
    background: rgba(255,255,255,0.05);
}
a.nav-item:hover { color: var(--text, #f1f5f9); }

.nav-item.nav-current {
    background: rgba(0, 212, 255, 0.08);
    color: var(--accent, #00d4ff);
    border-left-color: var(--accent, #00d4ff);
    cursor: default;
}

.nav-item.nav-disabled {
    opacity: 0.4;
    cursor: default;
}

.nav-item.nav-sub {
    padding-left: 32px;
}
.nav-item.nav-subsub {
    padding-left: 44px;
    font-size: 0.84rem;
}
.nav-item.nav-disabled:hover {
    background: transparent;
}

.nav-label { flex: 1; }

.nav-badge {
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0.03em;
    color: var(--bg, #0f172a);
    background: var(--accent, #00d4ff);
    border-radius: 999px;
    padding: 2px 7px;
    white-space: nowrap;
    flex-shrink: 0;
}
.nav-badge.hidden { display: none; }

.nav-separator {
    height: 1px;
    background: var(--border, #475569);
    margin: 8px 20px;
}

/* ── Nav Accordion Groups ───────────────────────────────────────── */
.nav-group-header {
    display: flex;
    align-items: stretch;
    position: relative;
}
.nav-group-header > .nav-item {
    flex: 1;
    padding-right: 40px;
}
.nav-group-toggle {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 40px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted, #94a3b8);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.15s;
}
.nav-group-toggle:hover { color: var(--text, #f1f5f9); }
.nav-chevron {
    display: inline-block;
    font-style: normal;
    font-size: 0.7rem;
    transition: transform 0.2s ease;
    transform: rotate(0deg);
}
.nav-group.open .nav-chevron {
    transform: rotate(90deg);
}
.nav-group-body {
    overflow: hidden;
    max-height: 0;
    transition: max-height 0.22s ease;
}
.nav-group.open > .nav-group-body {
    max-height: 700px;
}

/* ── Logo: im Header verstecken (lebt jetzt im Nav-Panel) */
.header-logo > img,
.header-logo > a { display: none; }

/* ── H1 im Header klickbar ─────────────────────────────────────── */
.header-logo h1 { cursor: pointer; }

.nav-panel-logo {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    flex-shrink: 0;
}

/* ── Last-Update Label ──────────────────────────────────────────── */
.last-update.online  { color: var(--success,    #4ade80); }
.last-update.warning { color: var(--warn,       #f59e0b); }
.last-update.offline { color: var(--text-muted, #94a3b8); }

/* ── Footer Legal-Links ─────────────────────────────────────────── */
.footer-legal { margin-top: 4px; }
.footer-legal-sep {
    opacity: 0.35;
    user-select: none;
}
.footer-legal a {
    color: var(--text-muted, #94a3b8);
    text-decoration: none;
    transition: color 0.15s;
}
.footer-legal a:hover {
    color: var(--accent, #00d4ff);
    text-decoration: underline;
    text-underline-offset: 3px;
}

/* ── Nav Panel Footer (Logout) ──────────────────────────────────── */
.nav-panel-footer {
    padding: 10px 12px;
    border-top: 1px solid var(--border, #475569);
    flex-shrink: 0;
}
.nav-logout {
    display: block;
    padding: 10px 20px;
    color: var(--text-muted, #94a3b8);
    text-decoration: none;
    font-size: 0.88rem;
    font-weight: 500;
    border-radius: 6px;
    transition: background 0.15s, color 0.15s;
}
.nav-logout:hover {
    background: rgba(255,255,255,0.05);
    color: var(--text, #f1f5f9);
}
`;

/**
 * Aktualisiert den Badge-Slot eines Nav-Items (muss beim Bau des Baums mit
 * hasBadge:true angelegt worden sein, siehe renderLeaf()). Kein Fehler, wenn
 * initNav() noch nicht lief oder das Panel gerade geschlossen ist – der Slot
 * existiert dann einfach noch nicht im DOM, der Aufrufer muss das nicht prüfen.
 *
 * @param {string} id  Item-ID ohne "nav-badge-"-Präfix, z.B. 'message-system'.
 * @param {number} n   Ungelesen-Anzahl; 0/falsy versteckt den Badge wieder.
 */
export function setNavBadge(id, n) {
    const el = document.getElementById(`nav-badge-${id}`);
    if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', !n);
}

/**
 * Verschiebt die "Du bist hier"-Markierung auf ein anderes Item, ohne das
 * Panel neu zu bauen – für Seiten mit In-Page-Navigation ohne Reload (z.B.
 * message.html, das per hashchange zwischen System/Support/Premium/
 * Einstellungen wechselt, aber initNav() nur einmal beim Laden aufruft).
 * Kein Fehler, wenn das Panel gerade nicht existiert/geschlossen ist.
 *
 * @param {string} id  Item- oder Gruppen-ID, z.B. 'message-support'.
 */
export function setNavCurrent(id) {
    document.querySelectorAll('.nav-panel [data-nav-id]').forEach(el => {
        el.classList.toggle('nav-current', el.dataset.navId === id);
    });
}

export function initNav({ current = '', logout = '' } = {}) {
    // CSS einmalig injizieren
    if (!document.getElementById('forge-nav-css')) {
        const style = document.createElement('style');
        style.id = 'forge-nav-css';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    // Hamburger-Button erstellen
    const btn = document.createElement('button');
    btn.className = 'nav-hamburger';
    btn.innerHTML = '&#9776;';  // ☰
    btn.title = 'Navigation';
    btn.setAttribute('aria-label', 'Navigation');

    // In .header-logo als erstes Element einfügen
    const headerLogo = document.querySelector('.header-logo');
    if (headerLogo) {
        headerLogo.insertBefore(btn, headerLogo.firstChild);
    }

    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'nav-overlay';
    document.body.appendChild(overlay);

    // Nav-Panel
    const panel = document.createElement('div');
    panel.className = 'nav-panel';

    const tree = buildNavTree();

    /** Rendert ein einzelnes Blatt-Item (level 0 = Top, 1 = eingerückt, 2 = doppelt eingerückt). */
    function renderLeaf(item, level) {
        const isCurrent  = item.id === current;
        const isDisabled = !item.href;
        const cls = ['nav-item',
            level === 1 && 'nav-sub',
            level === 2 && 'nav-subsub',
            isCurrent  && 'nav-current',
            isDisabled && 'nav-disabled',
            item.forkOnly && 'nav-fork-only',
        ].filter(Boolean).join(' ');
        // forkOnly-Items starten unsichtbar (Inline-Style statt CSS-Klasse, damit
        // kein Stylesheet-Import nötig ist) — werden erst sichtbar, wenn die
        // version.json-Abfrage weiter unten einen Fork nachweist.
        const forkOnlyStyle = item.forkOnly ? ' style="display:none"' : '';
        // item.hasBadge reserviert einen leeren, versteckten Badge-Slot (fester DOM-Id
        // "nav-badge-<id>"), den der Aufrufer später per setNavBadge() live befüllt
        // (Zähler stehen erst nach einem async Fetch fest, initNav() rendert synchron).
        const badge = item.hasBadge
            ? `<span class="nav-badge hidden" id="nav-badge-${item.id}"></span>`
            : (item.badge ? `<span class="nav-badge">${item.badge}</span>` : '');
        // Auch als aktuell markierte Items bleiben ein echtes <a> (nicht mehr wie bis
        // 2026-08-08 auf <div> umgeschaltet) – nötig, damit setNavCurrent() die
        // Markierung später per Klassenwechsel verschieben kann, ohne den DOM-Knoten
        // neu zu bauen (Seiten mit In-Page-Hash-Navigation wie message.html rufen
        // initNav() nur einmal auf, current ändert sich danach aber mehrfach).
        if (item.href) {
            return `<a href="${item.href}" class="${cls}" data-nav-id="${item.id}"${forkOnlyStyle}><span class="nav-label">${item.label}</span>${badge}</a>`;
        }
        return `<div class="${cls}" data-nav-id="${item.id}"${forkOnlyStyle}><span class="nav-label">${item.label}</span>${badge}</div>`;
    }

    /** Prüft rekursiv, ob current irgendwo unterhalb dieses Knotens liegt. */
    function containsCurrent(node) {
        if (node.id === current) return true;
        return node.group ? node.items.some(containsCurrent) : false;
    }

    // Von den vier Top-Level-Gruppen (Liquidity Bot/Lending Bot/Message Center/System)
    // ist per Default nur eine offen: die, die die aktuelle Seite enthält – sonst die
    // erste Gruppe. "Overview" ist bewusst kein Gruppen-Header mehr, sondern ein
    // normaler Link auf gleicher Ebene (2026-08-08, eine Hierarchiestufe weniger).
    const topGroups = tree.filter(n => n.group);
    const defaultOpenId = (topGroups.find(containsCurrent) ?? topGroups[0])?.id;

    /** Rendert eine Accordion-Gruppe (rekursiv, für verschachtelte Untergruppen). */
    function renderGroup(group, level) {
        const isOpen = level === 0 ? group.id === defaultOpenId : true;
        const headerCls = ['nav-item',
            level === 1 && 'nav-sub',
            group.id === current && 'nav-current',
        ].filter(Boolean).join(' ');
        const bodyHtml = group.items
            .map(it => it.group ? renderGroup(it, level + 1) : renderLeaf(it, level + 1))
            .join('');
        return `<div class="nav-group${isOpen ? ' open' : ''}" data-group="${group.id}">
            <div class="nav-group-header">
                <div class="${headerCls}" data-nav-id="${group.id}"><span class="nav-label">${group.label}</span></div>
                <button class="nav-group-toggle" aria-label="Erweitern/Einklappen">
                    <i class="nav-chevron">›</i>
                </button>
            </div>
            <div class="nav-group-body">${bodyHtml}</div>
        </div>`;
    }

    function buildNavHtml(nodes) {
        return nodes.map(node => node.group ? renderGroup(node, 0) : renderLeaf(node, 0)).join('');
    }

    const itemsHtml = buildNavHtml(tree);

    // Logo-Bild aus dem Header lesen
    const logoImg = headerLogo?.querySelector('img');
    const logoSrc = logoImg?.getAttribute('src') || '';
    const logoHtml = logoSrc
        ? `<img class="nav-panel-logo" src="${logoSrc}" alt="FORGE Logo">`
        : '';

    const logoutHtml = logout
        ? `<div class="nav-panel-footer">
               <a href="${logout}" class="nav-logout">Logout</a>
           </div>`
        : '';

    panel.innerHTML = `
        <div class="nav-panel-header">
            ${logoHtml}
            <span class="nav-panel-title-group">
                <span class="nav-panel-title">FORGE public</span><span class="nav-panel-version" id="navPanelVersion"></span>
            </span>
            <button class="nav-panel-close">&#10005;</button>
        </div>
        <nav class="nav-panel-body">${itemsHtml}</nav>
        ${logoutHtml}`;

    document.body.appendChild(panel);

    // Installierte FORGE.pub-Artefakt-Version anzeigen (nur auf einer per setup.sh
    // installierten Fork-Instanz vorhanden, siehe tools/pub-export/build-artifact.js →
    // html/version.json; auf dem Master gibt es kein Artefakt, fetch bleibt dann still
    // erfolglos und das Feld bleibt leer statt einen Fehler zu zeigen).
    fetch('/forge/version.json', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(v => {
            if (v?.version) {
                const el = document.getElementById('navPanelVersion');
                if (el) el.textContent = `v${v.version}`;
                // /forge/version.json existiert NUR auf einer per setup.sh installierten
                // Fork-Instanz (siehe Kommentar oben) — ihr erfolgreiches Laden ist damit
                // derselbe Fork-Nachweis, der forkOnly-Items (z.B. "Updates") einblendet.
                panel.querySelectorAll('.nav-fork-only').forEach(el => { el.style.display = ''; });
            }
        })
        .catch(() => {});

    // Sanftes Pulsieren der Versionsnummer, wenn bin/update-check.js ein geprüftes,
    // noch nicht eingespieltes Update gefunden hat — bewusst nur sichtbar, wenn das
    // Nav-Panel ohnehin geöffnet ist, kein aufdringlicher globaler Hinweis. Relative
    // API-Route, existiert nur wo bots/settings läuft
    // (Fork: dieselbe Origin wie /forge/, Master: andere Origin → 404, still
    // ignoriert, kein Fehler sichtbar — dort läuft update-check.js ohnehin nie).
    fetch('/api/update/status', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(s => {
            if (s?.available) {
                document.getElementById('navPanelVersion')?.classList.add('nav-panel-version-pulse');
            }
        })
        .catch(() => {});

    // Top-Level-Gruppen (direkte Kinder von .nav-panel-body) sind ein echtes Accordion:
    // nur eine gleichzeitig offen. Verschachtelte Untergruppen bleiben unabhängig
    // voneinander umschaltbar, ohne Geschwister zu schließen.
    //
    // Klick-Ziel ist die ganze .nav-group-header-Zeile, nicht nur der 40px breite
    // Chevron-Button (Bug 2026-08-08: Label sah per CSS-cursor klickbar aus, reagierte
    // aber nicht – nur der schmale Pfeil hatte einen Listener).
    const navPanelBody = panel.querySelector('.nav-panel-body');
    panel.querySelectorAll('.nav-group-header').forEach(header => {
        header.addEventListener('click', e => {
            e.stopPropagation();
            e.preventDefault();
            const group = header.closest('.nav-group');
            const isTopLevel = group.parentElement === navPanelBody;
            const willOpen = !group.classList.contains('open');
            if (isTopLevel && willOpen) {
                navPanelBody.querySelectorAll(':scope > .nav-group.open').forEach(g => {
                    if (g !== group) g.classList.remove('open');
                });
            }
            group.classList.toggle('open');
        });
    });

    // Open / Close
    function open()  { panel.classList.add('open'); overlay.classList.add('open'); }
    function close() { panel.classList.remove('open'); overlay.classList.remove('open'); }

    btn.addEventListener('click', () => panel.classList.contains('open') ? close() : open());
    panel.querySelector('.nav-panel-close').addEventListener('click', close);
    overlay.addEventListener('click', close);

    // Klick auf einen echten Nav-Link schließt das Panel sofort (Bug 2026-08-08:
    // blieb offen, bis man daneben klickte). Betrifft nur <a>-Items, nicht die
    // reinen Gruppen-Header (deren eigener Klick-Handler oben stoppt die
    // Propagation ohnehin schon, damit Auf-/Zuklappen das Panel nicht schließt).
    // Klick auf das bereits aktuelle Item navigiert nicht neu (kein Sinn, würde
    // nur einen unnötigen vollen Reload auslösen), schließt das Panel aber trotzdem.
    panel.addEventListener('click', e => {
        const link = e.target.closest('a.nav-item');
        if (!link) return;
        if (link.classList.contains('nav-current')) e.preventDefault();
        close();
    });

    // Escape schließt das Menü
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && panel.classList.contains('open')) close();
    });

    // H1 im Header: Klick scrollt nach oben
    const h1 = headerLogo?.querySelector('h1');
    if (h1) {
        h1.addEventListener('click', (e) => {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }
}

/**
 * Setzt "Letztes Update: HH:MM Uhr" im Header – einheitliches Format auf allen Seiten.
 * Findet automatisch #lastUpdate (Sub-Dashboards) oder #last-update (Übersichtsseite).
 *
 * @param {number|string|null} ts  Unix-Timestamp (ms), ISO-String oder null → "Kein Signal"
 * @param {{disabled?: boolean}} [opts]  disabled:true → "Bots deaktiviert" statt Zeitstempel
 *   (bewusst gestoppte Bots, z.B. forge-pub2-Testbetrieb — kein Fehlerzustand, daher eigene Farbe)
 */
/**
 * Initialisiert den Footer mit einheitlichem Zweizeiler.
 * Zeile 1 (immer):  FORGE-Icon + "FORGE – Automated DEX Trading"
 * Zeile 2 (optional): "<botName>: <Version>"  – wird per id="footerVersion" nachgefüllt
 *
 * @param {{ botName?: string }} opts
 */
export function initFooter({ botName } = {}) {
    const footer = document.querySelector('footer');
    if (!footer) return;

    const logoSrc = document.querySelector('.header-logo img')?.getAttribute('src')
                 ?? 'img/forge-logo.png';

    const line2 = '';

    footer.innerHTML =
        `<div class="footer-forge"><img src="${logoSrc}" alt="FORGE" style="height:18px;vertical-align:middle;margin-right:4px;border-radius:3px;"> FORGE public – Automated DEX Trading</div>
        ${line2}
        <div class="footer-legal">
            Aus dem Roman: <a href="https://uag.de/buch/der-exploit/" target="_blank" rel="noopener">Der EXPLOIT</a>
        </div>`;
}

export function setLastUpdate(ts, { disabled = false } = {}) {
    const el = document.getElementById('lastUpdate')
            ?? document.getElementById('last-update');
    if (!el) return;

    if (disabled) {
        el.textContent = 'Bots deaktiviert';
        el.className   = 'last-update disabled';
        return;
    }

    const tsMs = ts
        ? (typeof ts === 'number' ? ts : new Date(ts).getTime())
        : null;

    if (!tsMs || isNaN(tsMs)) {
        el.textContent = 'Kein Signal';
        el.className   = 'last-update offline';
        return;
    }

    const d      = new Date(tsMs);
    const h      = d.getHours().toString().padStart(2, '0');
    const m      = d.getMinutes().toString().padStart(2, '0');
    const ageSec = (Date.now() - tsMs) / 1000;
    const cls    = ageSec < 600 ? 'online' : ageSec < 1800 ? 'warning' : 'offline';

    el.textContent = `Letztes Update: ${h}:${m} Uhr`;
    el.className   = `last-update ${cls}`;
}
