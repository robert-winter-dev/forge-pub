// chance-modal.js (LIQ#001953, Tabs/Umbenennung LIQ#001960, Tab Verlauf LIQ#001967)
// Detail-Dialog zum Stimmung-Wert (intern weiter „chance“) einer Pool-Zeile, drei Tabs Edge, Trend und Verlauf:
// je Signal eine Zeile mit Zeitfenster, Wert, Punkten (Teilpunkt 0–1 als %, LIQ#001964) und Status (Symbol + Text, nie nur Farbe). Der Browser rechnet nichts: alle Werte kommen
// fertig aus data.json (pools[].chance, Master-Berechnung bzw. Premium-Lieferung, LIQ#000938).
// Lazy-geladen aus app.js wie token-info-modal.js.

import { t as tr, NUM_LOCALE } from '../../js/i18n.js?v=20260811a';
import { createRangeBar, historyStartOf } from '../../js/chart-range.js?v=20260923a';

let _modal = null;

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function ensureModal() {
    if (_modal) return;
    _modal = document.createElement('div');
    _modal.id = 'chanceModal';
    _modal.className = 'modal-overlay hidden';
    _modal.setAttribute('role', 'dialog');
    _modal.setAttribute('aria-modal', 'true');
    _modal.innerHTML = `
<div class="modal-box modal-box-narrow">
  <div class="modal-header">
    <h3 id="chanceModalTitle" style="margin:0;font-size:1rem"></h3>
    <button class="modal-close" id="chanceModalClose" aria-label="${esc(tr('liq.chance.close', 'Schließen'))}">&#x2715;</button>
  </div>
  <div id="chanceModalBody"></div>
</div>`;
    document.body.appendChild(_modal);
    document.getElementById('chanceModalClose').addEventListener('click', closeChanceModal);
    _modal.addEventListener('click', e => { if (e.target === _modal) closeChanceModal(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !_modal.classList.contains('hidden')) closeChanceModal();
    });
}

const TF_LABEL = { '1h': '1 h', '4h': '4 h', '6h': '6 h', '12h': '12 h', '24h': '24 h', '1d': '1 d', '1w': '1 w', '7d': '7 d' };

const STATUS = {
    full:   { sym: '✓', key: 'liq.chance.status_full',   de: 'voll' },
    part:   { sym: '◐', key: 'liq.chance.status_part',   de: 'teilweise' },
    none:   { sym: '✗', key: 'liq.chance.status_none',   de: 'keine' },
    nodata: { sym: '–', key: 'liq.chance.status_nodata', de: 'keine Daten' },
    // Lieferung eines Masters ohne Teilpunkte (vor LIQ#001964): nur erfüllt / nicht erfüllt
    met:    { sym: '✓', key: 'liq.chance.status_met',    de: 'erfüllt' },
    unmet:  { sym: '✗', key: 'liq.chance.status_unmet',  de: 'nicht erfüllt' },
};

function statusOf(s) {
    if (s.status === 'nodata') return STATUS.nodata;
    if (!Number.isFinite(s.score)) return STATUS[s.status] ?? STATUS.nodata;
    return s.score >= 1 ? STATUS.full : s.score > 0 ? STATUS.part : STATUS.none;
}

function pct(x) {
    return Math.round(x * 100).toLocaleString(NUM_LOCALE) + ' %';
}

function valueText(s) {
    if (s.raw == null) return '–';
    if (s.src === 'edge') {
        const pct = s.raw / 10; // npWindows: Basis 1.000 USDC → % des Kapitals
        return (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct).toLocaleString(NUM_LOCALE,
            { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' %';
    }
    return (s.raw > 0 ? '+' : s.raw < 0 ? '−' : '') + Math.abs(s.raw).toLocaleString(NUM_LOCALE,
        { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Wortstufen der technischen Bewertung (-1 … +1). Grenzen: ab +0,1 „kaufen“ (= Schwelle
// TV_BUY_THRESHOLD in chance-score.js), über +0,5 „stark kaufen“; spiegelbildlich bei den Minuswerten.
export function tvLevel(raw) {
    if (!Number.isFinite(raw)) return null;
    if (raw > 0.5) return { key: 'liq.chance.lvl_strong_buy', de: 'stark kaufen' };
    if (raw >= 0.1) return { key: 'liq.chance.lvl_buy', de: 'kaufen' };
    if (raw > -0.1) return { key: 'liq.chance.lvl_neutral', de: 'neutral' };
    if (raw >= -0.5) return { key: 'liq.chance.lvl_sell', de: 'verkaufen' };
    return { key: 'liq.chance.lvl_strong_sell', de: 'stark verkaufen' };
}

function row(s) {
    const st = statusOf(s);
    const warn = s.unreliable
        ? ` <span class="has-tooltip" data-tooltip-title="${esc(tr('liq.unreliable_short', ' (unzuverlässig)').trim().replace(/^\(|\)$/g, ''))}" data-tooltip-content="${esc(tr('liq.chance.unreliable', 'Für volatile Pools auf kurzen Zeitfenstern unzuverlässig (Richtungstreffer unter 50 %).'))}" data-tooltip-type="text" style="color:#f59e0b;cursor:default">⚠</span>`
        : '';
    let wert = valueText(s);
    if (s.src === 'tv') {
        const lvl = tvLevel(s.raw);
        if (lvl) wert += ` · ${tr(lvl.key, lvl.de)}`;
    }
    const punkte = s.status === 'nodata' || !Number.isFinite(s.score) ? '–' : pct(s.score);
    // Edge: ab welchem Wert dieses Fensters der volle Punkt gilt (90. Perzentil der positiven Werte aller Pools)
    const refTip = s.src === 'edge' && Number.isFinite(s.ref)
        ? ` class="has-tooltip" data-tooltip-title="${esc(tr('liq.chance.col_points', 'Punkte'))}" data-tooltip-content="${esc(tr('liq.chance.ref_tip', 'Voller Punkt ab {ref} (beste 10 % aller Pools in diesem Fenster).', { ref: valueText({ src: 'edge', raw: s.ref }) }))}" data-tooltip-type="text"`
        : '';
    return `<tr data-signal="${esc(s.src)}-${esc(s.tf)}" data-score="${Number.isFinite(s.score) ? s.score : ''}">
        <td>${esc(TF_LABEL[s.tf] ?? s.tf)}</td>
        <td style="text-align:right">${esc(wert)}${warn}</td>
        <td style="text-align:right"><span${refTip}>${esc(punkte)}</span></td>
        <td style="padding-left:1.25rem"><span aria-hidden="true">${st.sym}</span> ${esc(tr(st.key, st.de))}</td></tr>`;
}

function table(signals) {
    // Trend hat 4 Zeilen, Edge 5: eine unsichtbare Fußzeile gleicht aus, damit der Erklärtext in beiden Tabs auf gleicher Höhe steht (LIQ#001967)
    const pad = signals.length < 5
        ? `<tfoot aria-hidden="true" style="visibility:hidden">${'<tr><td colspan="4">&nbsp;</td></tr>'.repeat(5 - signals.length)}</tfoot>`
        : '';
    // Gleiche Spaltenbreiten in beiden Tabs (table-layout: fixed + colgroup), damit beim Umschalten nichts wandert
    return `<table class="chance-table" style="width:100%;table-layout:fixed;font-size:0.82rem;border-collapse:collapse">
          <colgroup><col style="width:16%"><col style="width:36%"><col style="width:15%"><col style="width:33%"></colgroup>
          <thead><tr style="text-align:left;color:var(--text-muted)">
            <th>${esc(tr('liq.chance.col_window', 'Fenster'))}</th>
            <th style="text-align:right">${esc(tr('liq.chance.col_value', 'Wert'))}</th>
            <th style="text-align:right">${esc(tr('liq.chance.col_points', 'Punkte'))}</th>
            <th style="padding-left:1.25rem">${esc(tr('liq.chance.col_status', 'Status'))}</th>
          </tr></thead>
          <tbody>${signals.map(row).join('')}</tbody>
          ${pad}
        </table>`;
}

const NOTE = 'class="text-muted" style="margin:1rem 0 0;font-size:0.8rem;line-height:1.45"';

// Teilzählung für die Tabbeschriftung: positive Signale / Signale mit Daten
function counts(signals) {
    const withData = signals.filter(s => s.status !== 'nodata');
    return `${withData.filter(s => s.status === 'met').length}/${withData.length}`;
}

function edgePanel(signals) {
    return table(signals)
        + `<p ${NOTE}>${esc(tr('liq.chance.edge_expl1', 'Edge: geschätzter Ertrag einer Position in diesem Pool im Zeitfenster, in % des eingesetzten Kapitals (Gebühren und Wertentwicklung der Position).'))}<br>`
        + `${esc(tr('liq.chance.edge_expl2', 'Voller Punkt, wenn der Edge zu den besten 10 % aller Pools in diesem Fenster gehört (Wert bei Punkten), anteilig darunter, kein Punkt bei 0 oder weniger.'))}</p>`;
}

function trendPanel(c) {
    const tv = c.tv ?? {};
    if (c.edgeOnly) {
        return `<p ${NOTE}>${esc(tr('liq.chance.tv_na', 'Trend: nicht anwendbar für diesen Pool, es zählen nur die Edge-Signale.'))}</p>`;
    }
    const sigs = c.signals.filter(s => s.src === 'tv');
    if (!tv.symbol) {
        return table(sigs) + `<p ${NOTE}>${esc(tr('liq.chance.tv_none', 'Trend: keine belastbare Zuordnung für diesen Token, die Signale zählen als keine Daten.'))}</p>`;
    }
    // LIQ#001963: keine Zeile mehr mit Symbol/Quelle/Abrufzeit; nur der Hinweis „veraltet“ bleibt, weil er erklärt, warum Signale fehlen
    const stale = tv.status === 'stale' ? `<br>${esc(tr('liq.chance.tv_stale_note', 'Die Daten sind veraltet und zählen als keine Daten.'))}` : '';
    return table(sigs)
        + `<p ${NOTE}>${esc(tr('liq.chance.trend_expl1', 'Technische Bewertung für {symbol} aus gleitenden Durchschnitten und Oszillatoren, von −1 (stark verkaufen) bis +1 (stark kaufen).', { symbol: tv.symbol }))}<br>`
        + `${esc(tr('liq.chance.trend_expl2', 'Voller Punkt ab +0,5 (stark kaufen), anteilig darunter, kein Punkt bei 0 oder weniger. Bewertet wird der Token, nicht der Pool.'))}${stale}</p>`;
}

// Tab Verlauf (LIQ#001967): Chart zeichnet app.js (_drawMetricChart, per Parameter übergeben, nicht kopiert),
// Zeitraum-Leiste kommt aus chart-range.js. Punkte: pool.metricHistory[fenster].chance, stündlich, nur ab Formelwechsel.
let _rangeBar = null;

function historyPanel() {
    return `<div id="chanceHistoryRange" class="chart-range-btns"></div>
        <svg id="chanceHistorySvg" class="metric-chart-svg" width="100%" style="display:block;overflow:visible"></svg>
        <p id="chanceHistoryNote" ${NOTE}></p>`;
}

function setupHistory(pool, ext) {
    _rangeBar?.destroy();
    _rangeBar = null;
    const { drawChart, meta, ranges } = ext ?? {};
    const svg = document.getElementById('chanceHistorySvg');
    const note = document.getElementById('chanceHistoryNote');
    if (!drawChart || !svg) return;
    const pts = r => pool.metricHistory?.[r.key.toLowerCase()]?.chance ?? [];
    let range = null;
    const draw = () => {
        const points = pts({ key: range });
        drawChart(svg, points, meta);
        note.textContent = points.length < 2
            ? tr('liq.chance.hist_few', 'Noch zu wenig Verlauf, es kommt jede Stunde ein Punkt dazu.')
            : tr('liq.chance.hist_note', 'Stündlich gespeichert. Werte vor dem 13.11.2026, 19 Uhr, wurden anders gerechnet und fehlen hier.');
    };
    const starts = ranges.map(r => historyStartOf(pts(r), p => p.ts)).filter(ms => ms != null);
    _rangeBar = createRangeBar(document.getElementById('chanceHistoryRange'), {
        ranges, active: '1D', historyStart: starts.length ? Math.min(...starts) : null,
        onChange: key => { range = key.toLowerCase(); draw(); },
    });
    range = _rangeBar.active.toLowerCase();
    _modal._drawHistory = draw;
    draw();   // sofort zeichnen: die Panels liegen übereinander, die Dialoghöhe (größtes Panel) steht damit von Anfang an fest
}

function selectTab(name) {
    _modal.querySelectorAll('.chance-tab-btn').forEach(b => {
        const on = b.dataset.tab === name;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
    });
    _modal.querySelectorAll('.chance-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === name));
    if (name === 'history') _modal._drawHistory?.();
}

export function openChanceModal(pool, ext) {
    const c = pool?.chance;
    if (!c) return;
    ensureModal();
    document.getElementById('chanceModalTitle').textContent =
        `${tr('liq.chance.title', 'Stimmung')} · ${pool.displayLabel ?? pool.displayPair ?? pool.pair ?? '--'}`;

    const edge = c.signals.filter(s => s.src === 'edge');
    const trend = c.signals.filter(s => s.src === 'tv');
    const edgeLabel = `${tr('liq.chance.tab_edge', 'Edge')} ${counts(edge)}`;
    const trendLabel = c.edgeOnly ? tr('liq.chance.tab_trend', 'Trend') : `${tr('liq.chance.tab_trend', 'Trend')} ${counts(trend)}`;

    // Beide Panels werden vorab gerendert und nur umgeschaltet; sie liegen in einer Grid-Zelle
    // übereinander, damit der Dialog beim Wechsel nicht springt (CSS #chanceModal .modal-tab-stack).
    document.getElementById('chanceModalBody').innerHTML = `
        <p style="margin:0 0 0.9rem;font-size:0.95rem"><strong>${esc(c.value)} %</strong>
           – ${esc(tr('liq.chance.met_of', '{met} von {applicable} Signalen positiv', { met: c.met, applicable: c.applicable }))}
           ${c.edgeOnly ? `<span class="text-muted" style="font-size:0.8em">(${esc(tr('liq.chance.edge_only', 'nur Edge'))})</span>` : ''}</p>
        <div class="modal-tabs" role="tablist">
          <button type="button" class="modal-tab-btn chance-tab-btn active" role="tab" id="chanceTabEdge" data-tab="edge" aria-selected="true" aria-controls="chancePanelEdge">${esc(edgeLabel)}</button>
          <button type="button" class="modal-tab-btn chance-tab-btn" role="tab" id="chanceTabTrend" data-tab="trend" aria-selected="false" tabindex="-1" aria-controls="chancePanelTrend">${esc(trendLabel)}</button>
          <button type="button" class="modal-tab-btn chance-tab-btn" role="tab" id="chanceTabHistory" data-tab="history" aria-selected="false" tabindex="-1" aria-controls="chancePanelHistory">${esc(tr('liq.chance.tab_history', 'Verlauf'))}</button>
        </div>
        <div class="modal-tab-stack">
          <div class="modal-tab-panel chance-tab-panel active" role="tabpanel" id="chancePanelEdge" data-tab="edge" aria-labelledby="chanceTabEdge">${edgePanel(edge)}</div>
          <div class="modal-tab-panel chance-tab-panel" role="tabpanel" id="chancePanelTrend" data-tab="trend" aria-labelledby="chanceTabTrend">${trendPanel(c)}</div>
          <div class="modal-tab-panel chance-tab-panel" role="tabpanel" id="chancePanelHistory" data-tab="history" aria-labelledby="chanceTabHistory">${historyPanel()}</div>
        </div>`;
    _modal._drawHistory = null;
    _modal.classList.remove('hidden');   // sichtbar, bevor die Leiste/der Chart ihre Breite messen
    setupHistory(pool, ext);
    const tabs = [...document.querySelectorAll('#chanceModal .chance-tab-btn')];
    tabs.forEach((b, i) => {
        b.addEventListener('click', () => selectTab(b.dataset.tab));
        b.addEventListener('keydown', e => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            selectTab(n.dataset.tab);
            n.focus();
        });
    });
    _modal.classList.remove('hidden');
}

export function closeChanceModal() {
    _modal?.classList.add('hidden');
}
