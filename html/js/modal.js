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
export function showModal({ id, title, body, actions = [], footerNote = '', onClose }) {
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
