/**
 * FORGE – Forge-Tooltip (gemeinsames Modul, identisch zu SGB)
 *
 * Hover-Tooltip für [data-tooltip-title]/[data-tooltip-content]-Elemente
 * (Klasse .info-tip-label, siehe bot-liquidity.js/bot-lending.js) – der
 * projektweite Standard für Info-Icons, nicht das CSS-only .info-tip.
 *
 * Braucht das Markup #forgeTooltip/#forgeTooltipTitle/#forgeTooltipBody
 * (siehe settings.css .forge-tooltip) auf der aufrufenden Seite.
 */
export function initForgeTooltip() {
    const tip = document.getElementById('forgeTooltip');
    if (!tip) return;
    const title = document.getElementById('forgeTooltipTitle');
    const body  = document.getElementById('forgeTooltipBody');

    function position(e) {
        const m = 14;
        let x = e.clientX + m;
        let y = e.clientY - tip.offsetHeight - m;
        if (y < 0)                                         y = e.clientY + m;
        if (y + tip.offsetHeight > window.innerHeight)     y = window.innerHeight - tip.offsetHeight - m;
        if (x + tip.offsetWidth  > window.innerWidth)      x = e.clientX - tip.offsetWidth - m;
        tip.style.left = `${x}px`;
        tip.style.top  = `${y}px`;
    }

    document.addEventListener('mouseover', e => {
        const el = e.target.closest('[data-tooltip-title]');
        if (!el) return;
        title.textContent = el.dataset.tooltipTitle ?? '';
        body.innerHTML    = (el.dataset.tooltipContent ?? '').replace(/\||\\n|\n/g, '<br>');
        tip.style.display = 'block';
        position(e);
    });
    document.addEventListener('mousemove', e => {
        if (tip.style.display === 'none') return;
        if (!e.target.closest('[data-tooltip-title]')) { tip.style.display = 'none'; return; }
        position(e);
    });
    document.addEventListener('mouseout', e => {
        if (!e.relatedTarget?.closest('[data-tooltip-title]')) tip.style.display = 'none';
    });
}
