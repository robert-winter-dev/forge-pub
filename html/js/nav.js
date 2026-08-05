/**
 * FORGE – Zentrale Navigation (Hamburger-Menü)
 *
 * Gemeinsam genutzt von allen Dashboards.
 *
 * Verwendung:
 *   import { initNav } from '../../js/nav.js';
 *   initNav({ current: 'liquidity' });
 *
 * IDs: 'overview' | 'lending' | 'liquidity'
 *
 * LAN-Erkennung: Wird die Seite über eine private IP aufgerufen
 * (192.168.x.x / 10.x.x.x / 172.16-31.x.x), erscheinen zusätzlich
 * die Links „Settings" und „SSL-Zertifikat" unter dem Health Monitor.
 */

const NAV_ITEMS = [
    { id: 'overview', label: 'Dashboard',           href: '/forge/' },
    { id: 'liquidity', label: 'Liquidity Bot',  href: '/forge/liquidity/',  sub: true },
    { id: 'lending',  label: 'Lending Bot',          href: '/forge/lending/',            sub: true },
    { sep: true },
    { id: 'health',   label: 'Health Monitor',      href: '/forge/health.html' },
];

/** Gibt true zurück wenn der Aufruf aus dem lokalen Netz kommt. */
function isLanAccess() {
    const h = window.location.hostname;
    return /^192\.168\./.test(h)
        || /^10\./.test(h)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/** Baut die LAN-spezifischen Nav-Items dynamisch (IP aus aktuellem Hostname). */
function lanItems() {
    const ip = window.location.hostname;
    return [
        { id: 'message',          label: 'Message Center',  href: `https://${ip}:3200/message.html` },
        { sep: true },
        { id: 'settings',          label: 'Settings',       href: `https://${ip}:3200/` },
        { id: 'settings-liquidity', label: 'Liquidity Bot', href: `https://${ip}:3200/#liquidity`, sub: true },
        { id: 'settings-lending',  label: 'Lending Bot',     href: `https://${ip}:3200/#lending`,  sub: true },
        { id: 'ssl-cert',          label: 'SSL-Zertifikat',  href: `http://${ip}:3201/` },
    ];
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
.nav-panel-title {
    flex: 1;
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--text, #f1f5f9);
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
.nav-item.nav-disabled:hover {
    background: transparent;
}

.nav-label { flex: 1; }

.nav-badge {
    font-size: 0.62rem;
    letter-spacing: 0.03em;
    color: var(--text-muted, #94a3b8);
    background: rgba(255,255,255,0.06);
    border: 1px solid var(--border, #475569);
    border-radius: 4px;
    padding: 1px 6px;
    white-space: nowrap;
}

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
.nav-group.open .nav-group-body {
    max-height: 300px;
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

    const items = isLanAccess() ? [...NAV_ITEMS, ...lanItems()] : NAV_ITEMS;

    /** Rendert ein einzelnes Nav-Item als HTML-String. */
    function renderItem(item) {
        const isCurrent  = item.id === current;
        const isDisabled = !item.href;
        const cls = ['nav-item',
            item.sub   && 'nav-sub',
            isCurrent  && 'nav-current',
            isDisabled && 'nav-disabled',
        ].filter(Boolean).join(' ');
        const badge = item.badge
            ? `<span class="nav-badge">${item.badge}</span>`
            : '';
        if (item.href && !isCurrent) {
            return `<a href="${item.href}" class="${cls}"><span class="nav-label">${item.label}</span>${badge}</a>`;
        }
        return `<div class="${cls}"><span class="nav-label">${item.label}</span>${badge}</div>`;
    }

    /**
     * Baut die Nav-HTML mit Accordion-Gruppen.
     * Ein Nicht-Sub-Item gefolgt von Sub-Items wird zu einer Gruppe zusammengefasst.
     * Nur eine Gruppe ist gleichzeitig offen (Accordion).
     * Initial offen: die Gruppe, die das aktuelle Item enthält; sonst die erste Gruppe.
     */
    function buildNavHtml(items) {
        // Items in Gruppen und Einzelitems aufteilen
        const segments = [];
        let i = 0;
        while (i < items.length) {
            const item = items[i];
            if (item.sep) { segments.push({ type: 'sep' }); i++; continue; }
            if (!item.sub) {
                const subs = [];
                let j = i + 1;
                while (j < items.length && !items[j].sep && items[j].sub) {
                    subs.push(items[j]);
                    j++;
                }
                if (subs.length > 0) {
                    segments.push({ type: 'group', header: item, subs });
                    i = j;
                } else {
                    segments.push({ type: 'item', item });
                    i++;
                }
            } else {
                segments.push({ type: 'item', item });
                i++;
            }
        }

        // Alle Gruppen immer offen
        const groups = segments.filter(s => s.type === 'group');
        const openGroupIds = new Set(groups.map(g => g.header.id));

        return segments.map(seg => {
            if (seg.type === 'sep')  return '<div class="nav-separator"></div>';
            if (seg.type === 'item') return renderItem(seg.item);
            // Gruppe
            const { header, subs } = seg;
            const isOpen = openGroupIds.has(header.id);
            return `<div class="nav-group${isOpen ? ' open' : ''}" data-group="${header.id}">
                <div class="nav-group-header">
                    ${renderItem(header)}
                    <button class="nav-group-toggle" aria-label="Erweitern/Einklappen">
                        <i class="nav-chevron">›</i>
                    </button>
                </div>
                <div class="nav-group-body">
                    ${subs.map(s => renderItem(s)).join('')}
                </div>
            </div>`;
        }).join('');
    }

    const itemsHtml = buildNavHtml(items);

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
            ${logoHtml}<span class="nav-panel-title">FORGE</span>
            <button class="nav-panel-close">&#10005;</button>
        </div>
        <nav class="nav-panel-body">${itemsHtml}</nav>
        ${logoutHtml}`;

    document.body.appendChild(panel);

    // Gruppen unabhängig ein-/ausklappen (kein Accordion)
    panel.querySelectorAll('.nav-group-toggle').forEach(toggleBtn => {
        toggleBtn.addEventListener('click', e => {
            e.stopPropagation();
            e.preventDefault();
            toggleBtn.closest('.nav-group').classList.toggle('open');
        });
    });

    // Open / Close
    function open()  { panel.classList.add('open'); overlay.classList.add('open'); }
    function close() { panel.classList.remove('open'); overlay.classList.remove('open'); }

    btn.addEventListener('click', () => panel.classList.contains('open') ? close() : open());
    panel.querySelector('.nav-panel-close').addEventListener('click', close);
    overlay.addEventListener('click', close);

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

export function setLastUpdate(ts) {
    const el = document.getElementById('lastUpdate')
            ?? document.getElementById('last-update');
    if (!el) return;

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
