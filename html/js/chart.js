/**
 * FORGE – Shared chart utilities
 * Wiederverwendbar für alle FORGE-Bot-Dashboards.
 *
 * Exports:
 *   filterOutliers(values, factor)   – IQR-basierte Ausreißer-Erkennung
 *   attachHoverOverlay(svg, geo)     – Fadenkreuz (X + Y) mit Achsen-Labels
 *   attachBarTooltip(svg, wrap, sel, fmt) – Hover-Tooltip für Balkendiagramme
 */

const MONTHS_DE = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

/**
 * Filtert lokale Spikes (einzelne Ausreißer-Punkte) aus einem Zahlenarray.
 * Ein Punkt gilt als Spike wenn er um mehr als `threshold` (relativ) vom
 * Durchschnitt seiner beiden Nachbarn abweicht.
 *
 * Geeignet für Zeitreihen wie Portfolio-Verläufe, wo echte Trends langsam
 * sind, aber Datenfehler als scharfe Einzelspikes auftreten.
 *
 * Randbedingungen: erster/letzter Punkt wird nie gefiltert.
 * Aufeinanderfolgende Spikes werden beide gefiltert (jeder gegen seine Nachbarn).
 *
 * @param {(number|null)[]} values
 * @param {number}          [threshold=0.20]  Maximale relative Abweichung (0.20 = 20 %)
 * @returns {(number|null)[]}
 */
export function filterSpikes(values, threshold = 0.20) {
    if (values.length < 3) return [...values];
    return values.map((v, i) => {
        if (i === 0 || i === values.length - 1) return v;
        if (v === null || v === undefined || !isFinite(v)) return v;
        const prev = values[i - 1];
        const next = values[i + 1];
        if (prev === null || !isFinite(prev) || next === null || !isFinite(next)) return v;
        const mid = (prev + next) / 2;
        if (Math.abs(mid) < 1e-9) return v;
        return (Math.abs(v - mid) / Math.abs(mid)) > threshold ? null : v;
    });
}

/**
 * Filtert kurzzeitige Ausreißer aus einem Zahlenarray via IQR-Methode.
 * Gibt ein Array gleicher Länge zurück; Ausreißer werden als `null` markiert.
 *
 * Algorithmus: IQR × factor als Schwellwert.
 *   Untere Grenze = Q1 - factor × IQR
 *   Obere Grenze  = Q3 + factor × IQR
 *
 * @param {(number|null)[]} values
 * @param {number}          [factor=3]  Höher = konservativer (weniger Filterung)
 * @returns {(number|null)[]}
 */
export function filterOutliers(values, factor = 3) {
    const valid = values.filter(v => v !== null && v !== undefined && isFinite(v));
    if (valid.length < 4) return [...values];

    const sorted = [...valid].sort((a, b) => a - b);
    const n   = sorted.length;
    const q1  = sorted[Math.floor(n * 0.25)];
    const q3  = sorted[Math.floor(n * 0.75)];
    const iqr = q3 - q1;

    // IQR ≈ 0 → alle Werte sehr eng beieinander, keine sinnvolle Filterung
    if (iqr < 1e-9) return [...values];

    const lo = q1 - factor * iqr;
    const hi = q3 + factor * iqr;

    return values.map(v =>
        (v === null || v === undefined || !isFinite(v) || v < lo || v > hi) ? null : v
    );
}

/**
 * Hängt ein interaktives Hover-Fadenkreuz an ein SVG-Chart.
 *
 * Zeichnet bei Mausbewegung:
 *   – senkrechte gestrichelte Linie + Datum/Uhrzeit-Label auf der X-Achse
 *   – waagerechte gestrichelte Linie + formatierter Wert auf der Y-Achse
 *
 * Existierende SVG-Events (Trade-Dots, Range-Hover-Tooltips) bleiben erhalten,
 * da die Overlay-Gruppe `pointer-events="none"` gesetzt hat.
 *
 * @param {SVGElement} svg
 * @param {object}     geo
 * @param {number}     geo.tMin      Startzeit (ms)
 * @param {number}     geo.tMax      Endzeit (ms)
 * @param {number}     geo.spanMs    tMax - tMin
 * @param {number}     geo.PAD_L     Linkes Padding (Pixel)
 * @param {number}     geo.PAD_T     Oberes Padding (Pixel)
 * @param {number}     geo.cW        Nutzbare Chart-Breite (Pixel)
 * @param {number}     geo.cH        Nutzbare Chart-Höhe (Pixel)
 * @param {number}     [geo.yMin]    Y-Achse Minimum (für Wert-Label; optional)
 * @param {number}     [geo.yMax]    Y-Achse Maximum (für Wert-Label; optional)
 * @param {Function}   [geo.formatY] Formatter für Y-Wert (default: 2 Dezimalstellen)
 */
export function attachHoverOverlay(svg, {
    tMin, tMax, PAD_L, cW, PAD_T, cH, spanMs,
    yMin = null, yMax = null, formatY = null,
}) {
    const ns = 'http://www.w3.org/2000/svg';
    const g  = document.createElementNS(ns, 'g');
    g.setAttribute('pointer-events', 'none');

    /** Erstellt eine gestrichelte SVG-Linie (initial unsichtbar) */
    const mkLine = () => {
        const el = document.createElementNS(ns, 'line');
        el.setAttribute('stroke', 'rgba(255,255,255,0.35)');
        el.setAttribute('stroke-width', '1');
        el.setAttribute('stroke-dasharray', '3,3');
        el.style.display = 'none';
        return el;
    };

    /** Erstellt ein blaues Achsen-Label mit dunklem Halo (initial unsichtbar) */
    const mkLabel = () => {
        const el = document.createElementNS(ns, 'text');
        el.style.fill           = 'var(--primary)';
        el.style.stroke         = 'var(--bg-dark, #0f172a)';
        el.style.strokeWidth    = '4px';
        el.style.paintOrder     = 'stroke fill';
        el.style.strokeLinejoin = 'round';
        el.style.fontWeight     = '600';
        el.style.display        = 'none';
        return el;
    };

    // ── Vertikale Linie (X-Fadenkreuz) ────────────────────────────────────
    const vline = mkLine();
    vline.setAttribute('y1', PAD_T);
    vline.setAttribute('y2', PAD_T + cH);

    // ── Horizontale Linie (Y-Fadenkreuz) ──────────────────────────────────
    const hline = mkLine();
    hline.setAttribute('x1', PAD_L);
    hline.setAttribute('x2', PAD_L + cW);

    // ── X-Label: Datum/Uhrzeit unter dem Chart ─────────────────────────────
    const xLabel = mkLabel();
    xLabel.setAttribute('y', PAD_T + cH + 16);
    xLabel.setAttribute('text-anchor', 'middle');
    xLabel.setAttribute('class', 'chart-label chart-label-x');

    // ── Y-Label: Wert links am Chart ───────────────────────────────────────
    const yLabel = mkLabel();
    yLabel.setAttribute('x', PAD_L - 6);
    yLabel.setAttribute('text-anchor', 'end');
    yLabel.setAttribute('dominant-baseline', 'middle');
    yLabel.setAttribute('class', 'chart-label chart-label-y');

    const showY = yMin !== null && yMax !== null;
    const fmt   = formatY ?? (v => v.toFixed(2));

    const all = [vline, hline, xLabel, yLabel];
    for (const el of all) g.appendChild(el);
    svg.appendChild(g);

    // ── Maus-Events ────────────────────────────────────────────────────────
    svg.addEventListener('mousemove', e => {
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const sp = pt.matrixTransform(svg.getScreenCTM().inverse());

        // Außerhalb des Chart-Bereichs → alles ausblenden
        if (sp.x < PAD_L || sp.x > PAD_L + cW || sp.y < PAD_T || sp.y > PAD_T + cH) {
            for (const el of all) el.style.display = 'none';
            return;
        }

        // X: Mausposition → Zeitstempel → formatiertes Label
        const t   = tMin + (sp.x - PAD_L) / cW * spanMs;
        const d   = new Date(t);
        const hh  = String(d.getHours()).padStart(2, '0');
        const mm  = String(d.getMinutes()).padStart(2, '0');
        const str = spanMs < 48 * 3_600_000
            ? `${hh}:${mm}`
            : `${d.getDate()}. ${MONTHS_DE[d.getMonth()]} ${hh}:${mm}`;

        vline.setAttribute('x1', sp.x);
        vline.setAttribute('x2', sp.x);
        vline.style.display = '';
        xLabel.setAttribute('x', sp.x);
        xLabel.textContent  = str;
        xLabel.style.display = '';

        // Y: Mausposition → Wert → Label + horizontale Linie
        if (showY) {
            const v = yMax - (sp.y - PAD_T) / cH * (yMax - yMin);
            hline.setAttribute('y1', sp.y);
            hline.setAttribute('y2', sp.y);
            hline.style.display = '';
            yLabel.setAttribute('y', sp.y);
            yLabel.textContent  = fmt(v);
            yLabel.style.display = '';
        }
    });

    svg.addEventListener('mouseleave', () => {
        for (const el of all) el.style.display = 'none';
    });
}

/**
 * Hängt einen Hover-Tooltip an ein SVG-Balkendiagramm (Event-Delegation).
 * Listener wird nur einmalig pro SVG angehängt – safe bei svg.innerHTML-Ersatz.
 *
 * @param {SVGElement} svg         SVG-Element mit den Balken
 * @param {Element}    wrapperEl   Positionierungs-Container (position:relative)
 * @param {string}     barSelector CSS-Selektor für Balken (z.B. '.vol-bar', '.fee-bar')
 * @param {Function}   formatFn    formatFn(barEl) → string  –  Tooltip-Text
 */
export function attachBarTooltip(svg, wrapperEl, barSelector, formatFn) {
    // Tooltip-Div einmalig anlegen oder vorhandenes wiederverwenden
    let tip = wrapperEl.querySelector('.chart-tooltip-box');
    if (!tip) {
        tip = document.createElement('div');
        tip.className = 'chart-tooltip-box';
        tip.style.display = 'none';
        wrapperEl.appendChild(tip);
    }

    // Listener einmalig pro SVG + Selektor anhängen
    if (svg._barTooltipSelector === barSelector) return;
    svg._barTooltipSelector = barSelector;

    svg.addEventListener('mousemove', e => {
        const bar = e.target.closest(barSelector);
        if (!bar) { tip.style.display = 'none'; return; }
        tip.textContent = formatFn(bar);
        const wRect = wrapperEl.getBoundingClientRect();
        let tx = e.clientX - wRect.left + 12;
        let ty = e.clientY - wRect.top  - 36;
        const tipW = tip.offsetWidth || 160;
        if (tx + tipW > wRect.width - 4) tx = e.clientX - wRect.left - tipW - 8;
        tip.style.left    = `${tx}px`;
        tip.style.top     = `${Math.max(4, ty)}px`;
        tip.style.display = 'block';
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}
