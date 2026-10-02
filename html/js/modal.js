/**
 * FORGE – Gemeinsames Modal-Modul
 *
 * Einfaches, wiederverwendbares Modal für alle FORGE-Bots und ForgeSettings.
 *
 * Verwendung:
 *   import { showModal, closeModal } from '/forge/js/modal.js';
 *
 *   showModal({
 *     id: 'myModal',
 *     title: 'Titel',
 *     body: '<p>Inhalt als HTML-String</p>',
 *     maximizable: true,  // optional, Maximieren-Schalter im Header (für Listen/Tabellen)
 *     footerNote: '<span id="myModalNote">Hinweistext</span>',  // optional, linksbündig im Footer
 *     actions: [
 *       { label: 'Speichern', primary: true, onClick: () => { ... } },
 *       { label: 'Abbrechen', onClick: () => closeModal('myModal') },
 *     ],
 *   });
 *
 * Voraussetzungen im CSS:
 *   .forge-modal-backdrop, .forge-modal, .forge-modal-header,
 *   .forge-modal-title, .forge-modal-close, .forge-modal-body,
 *   .forge-modal-footer  (Styles liegen in der jeweiligen Bot-CSS)
 */

const _registry = new Map(); // id → { backdrop, onKey }

/**
 * Öffnet ein Modal. Existiert bereits eines mit gleicher ID, wird es zuerst geschlossen.
 * @returns {HTMLElement} Das Backdrop-Element (enthält das eigentliche Modal).
 */
export function showModal({ id, title, body, actions = [], footerNote = '', onClose, maximizable = false }) {
    closeModal(id);

    const backdrop = document.createElement('div');
    backdrop.className = 'forge-modal-backdrop';
    backdrop.id = `forge-modal-${id}`;

    // Einheitliche Button-Farbe für alle Modal-Aktionen.
    // Aus Gründen der Barrierefreiheit werden keine farblich kodierten Modal-Buttons verwendet.
    // aus den Übersichts-Tabellen (btn-secondary).
    const footerHtml = (actions.length || footerNote)
        ? `<div class="forge-modal-footer">${
            footerNote ? `<span class="forge-modal-footer-note">${footerNote}</span>` : ''
          }${
            actions.map((a, i) =>
                `<button class="btn btn-secondary" data-mi="${i}">${a.label}</button>`
            ).join('')
          }</div>`
        : '';

    backdrop.innerHTML = `
        <div class="forge-modal" role="dialog" aria-modal="true" aria-labelledby="forge-modal-title-${id}">
            <div class="forge-modal-header">
                <span class="forge-modal-title" id="forge-modal-title-${id}">${title}</span>
                <button class="forge-modal-close" aria-label="Schließen">✕</button>
            </div>
            <div class="forge-modal-body">${body}</div>
            ${footerHtml}
        </div>`;

    // Schließen: Backdrop-Klick
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(id); });

    // Schließen: X-Button
    backdrop.querySelector('.forge-modal-close').addEventListener('click', () => closeModal(id));

    // Aktion-Buttons verdrahten
    backdrop.querySelectorAll('[data-mi]').forEach(btn => {
        const idx = Number(btn.dataset.mi);
        btn.addEventListener('click', () => actions[idx].onClick?.());
    });

    // ESC-Taste
    const onKey = e => { if (e.key === 'Escape') closeModal(id); };
    document.addEventListener('keydown', onKey);

    _registry.set(id, { backdrop, onKey, onClose });
    document.body.appendChild(backdrop);

    if (maximizable) makeMaximizable(backdrop.querySelector('.forge-modal'));

    // Erstes Eingabefeld fokussieren
    setTimeout(() => backdrop.querySelector('input, textarea, [autofocus]')?.focus(), 50);

    return backdrop;
}

/** Schließt ein Modal anhand seiner ID. */
export function closeModal(id) {
    const entry = _registry.get(id);
    if (!entry) return;
    document.removeEventListener('keydown', entry.onKey);
    entry.backdrop.remove();
    _registry.delete(id);
    entry.onClose?.();
}

/** Gibt das Backdrop-Element eines offenen Modals zurück (oder undefined). */
export function getModal(id) {
    return _registry.get(id)?.backdrop;
}

// ── Maximieren (für alle Modal-Familien) ─────────────────────────────────────
// Eine Funktion für drei Dialog-Bauarten: .forge-modal (showModal), .modal-box und
// .chart-modal-dialog (handgeschriebenes HTML in liquidity/lending). Die Lib fügt den
// Schalter in den Header ein, setzt .forge-maximized (CSS: shared.css) und meldet jede
// Größenänderung per Callback, damit Charts mit der neuen Fläche neu zeichnen.

const MAX_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" '
    + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg>';
const HEADER_SEL = '.modal-header, .chart-modal-header, .forge-modal-header, .ov-modal-header';
const CLOSE_SEL  = '.modal-close, .chart-modal-close, .forge-modal-close, .ov-modal-close';

/**
 * Macht einen Dialog maximierbar. Idempotent.
 * @param {HTMLElement} box  Dialog-Box (.modal-box / .chart-modal-dialog / .forge-modal)
 * @param {{onResize?: (maximized:boolean)=>void}} [opts]
 *        onResize läuft nach jedem Umschalten und bei Fenstergrößenänderung im maximierten Zustand.
 */
export function makeMaximizable(box, { onResize } = {}) {
    if (!box || box.dataset.maxReady) return;
    const header = box.querySelector(HEADER_SEL);
    if (!header) return;
    box.dataset.maxReady = '1';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'forge-modal-max';
    btn.innerHTML = MAX_ICON;   // bewusst dasselbe Icon in beiden Zuständen (wie pool-chart-modal)
    const label = on => { const t = on ? 'Wiederherstellen' : 'Maximieren'; btn.title = t; btn.setAttribute('aria-label', t); };
    label(false);
    header.insertBefore(btn, header.querySelector(CLOSE_SEL));

    const notify = () => requestAnimationFrame(() => requestAnimationFrame(() => {
        onResize?.(box.classList.contains('forge-maximized'));
    }));
    const set = on => {
        if (on === box.classList.contains('forge-maximized')) return;
        box.classList.toggle('forge-maximized', on);
        label(on);
        notify();
    };
    btn.addEventListener('click', () => set(!box.classList.contains('forge-maximized')));

    let t = 0;
    window.addEventListener('resize', () => {
        if (!box.classList.contains('forge-maximized')) return;
        clearTimeout(t); t = setTimeout(notify, 120);
    });

    // Beim Schließen (Overlay wird hidden bzw. display:none) zurücksetzen: jeder Dialog
    // öffnet wieder in Normalgröße, ohne dass die einzelnen open/close-Funktionen etwas tun müssen.
    const overlay = box.parentElement;
    if (overlay) new MutationObserver(() => {
        const hidden = overlay.classList.contains('hidden') || overlay.style.display === 'none';
        if (hidden) { box.classList.remove('forge-maximized'); label(false); }
    }).observe(overlay, { attributes: true, attributeFilter: ['class', 'style'] });
}

/**
 * Zeichenhöhe für SVG-Charts in Dialogen: im maximierten Zustand die Höhe, die nach Abzug
 * aller übrigen Dialog-Inhalte (Header, Tabs, Range-Buttons, Ränder) für das SVG bleibt,
 * sonst `fallback`. Ersetzt feste Höhen wie `const H = 200;`.
 */
export function fitHeight(svg, fallback) {
    const box = svg?.closest('.forge-maximized');
    if (!box) return fallback;
    const px = v => parseFloat(v) || 0;
    let used = 0, el = svg;
    while (el && el !== box) {
        const cs = getComputedStyle(el);
        used += px(cs.marginTop) + px(cs.marginBottom);
        const p = el.parentElement;
        for (const s of p.children) {
            if (s === el) continue;
            const sc = getComputedStyle(s);
            if (sc.display === 'none' || sc.position === 'absolute' || sc.position === 'fixed') continue;
            used += s.offsetHeight + px(sc.marginTop) + px(sc.marginBottom);
        }
        const ps = getComputedStyle(p);
        if (p !== box) used += px(ps.paddingTop) + px(ps.paddingBottom) + px(ps.borderTopWidth) + px(ps.borderBottomWidth);
        el = p;
    }
    const bs = getComputedStyle(box);
    used += px(bs.paddingTop) + px(bs.paddingBottom) + px(bs.borderTopWidth) + px(bs.borderBottomWidth);
    return Math.max(fallback, Math.floor(box.clientHeight + px(bs.borderTopWidth) + px(bs.borderBottomWidth) - used - 8));
}

/**
 * Verdrahtet mehrere handgeschriebene Dialoge auf einmal: { overlayId: onResize | null }.
 * Die Box wird im Overlay gesucht (.modal-box, .chart-modal-dialog, .wallet-modal-dialog oder .ov-modal-dialog).
 */
export function wireMaximize(map) {
    for (const [id, onResize] of Object.entries(map)) {
        const box = document.getElementById(id)
            ?.querySelector('.modal-box, .chart-modal-dialog, .wallet-modal-dialog, .ov-modal-dialog');
        makeMaximizable(box, { onResize: onResize ?? undefined });
    }
}
