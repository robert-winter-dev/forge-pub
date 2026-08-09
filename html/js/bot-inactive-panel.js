/**
 * Bot-inaktiv-Platzhalter (2026-08-07)
 *
 * Ersetzt eine ganze Dashboard-Box, wenn der zugehörige Bot keine aktive
 * Position hält (frisch nach der Installation, oder nach vollständigem
 * Ausstieg ohne Wiedereinstieg) — sonst zeigen die Tabellen nur unerklärte
 * leere Zellen ("nur Striche"). Von Liquidity- UND Lending-Dashboard genutzt,
 * deshalb hier im geteilten js/-Verzeichnis statt in einem der beiden app.js.
 *
 * CSS: .bot-inactive-panel (html/css/shared.css) — gleiche Form wie das
 * bereits bestehende .premium-locked-panel (liquidity-only, Opportunity-Box),
 * bewusst eine eigene, einfachere Klasse (nur Text, kein Icon/Link).
 *
 * Nutzung via textContent statt innerHTML — label/note kommen aus fest
 * kodierten Konstanten im jeweiligen app.js, kein Escaping nötig, aber
 * textContent ist ohnehin die robustere Wahl.
 */

export function renderBotInactivePanel(container, label, note = '') {
    if (!container) return;
    let panel = container.querySelector('.bot-inactive-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'bot-inactive-panel';
        const main = document.createElement('div');
        main.className = 'bot-inactive-panel-main';
        const noteEl = document.createElement('div');
        noteEl.className = 'bot-inactive-panel-note';
        panel.appendChild(main);
        panel.appendChild(noteEl);
        container.appendChild(panel);
    }
    panel.querySelector('.bot-inactive-panel-main').textContent = label;
    const noteEl = panel.querySelector('.bot-inactive-panel-note');
    noteEl.textContent    = note;
    noteEl.style.display  = note ? '' : 'none';
}

export function removeBotInactivePanel(container) {
    if (!container) return;
    container.querySelectorAll('.bot-inactive-panel').forEach(el => el.remove());
}
