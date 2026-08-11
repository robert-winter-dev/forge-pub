/**
 * FORGE Health Monitor – Client-seitige Logik
 *
 * Features:
 *   - Service-Cards im 2-Spalten-Raster mit Bot-Tags
 *   - 7-Tage-History-Balken (168 Stundenblöcke)
 *   - JS-Tooltip auf Dienstname (clipping-sicher, viewport-positioniert)
 *   - Klick auf Status-Badge → Detail-Modal
 *     (forge-nexus: zusätzlich Nexus-Statistiken)
 */

import { initNav, initFooter, setLastUpdate } from './nav.js?v=20260811b';
import { initMessageBell } from './message-bell.js?v=20260809a';

const DATA_URL      = 'data/health-status.json';
const REFRESH_MS    = 60_000;
const HISTORY_HOURS = 7 * 24;

const BOT_LABELS = {
    lend: 'Lending Bot',
    liq: 'Liquidity Bot',
};

initNav({ current: 'health' });
initFooter();

// ── Globaler Datensatz (für Modal-Zugriff) ────────────────────────────────────
let currentData = null;

// ── Daten laden & rendern ──────────────────────────────────────────────────────

async function loadAndRender() {
    try {
        const res  = await fetch(`${DATA_URL}?_t=${Date.now()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        currentData = await res.json();
        render(currentData);
        setLastUpdate(currentData.generated_at);
    } catch (e) {
        console.error('[health] Laden fehlgeschlagen:', e.message);
        setLastUpdate(null);
    }
}

function render(data) {
    for (const chain of data.chains) {
        if (chain.placeholder) continue;
        const el = document.getElementById(`services-${chain.id}`);
        if (!el) continue;
        el.innerHTML = chain.services.length
            ? chain.services.map(svc => renderServiceCard(svc, chain.id)).join('')
            : '<p style="color:var(--text-muted);font-size:.85rem;grid-column:1/-1">Keine Dienste konfiguriert.</p>';
    }
    restoreErrorsOnly();
}

// ── Service-Card ───────────────────────────────────────────────────────────────

function renderServiceCard(svc, chainId) {
    const cls    = sanitizeStatus(svc.status);
    const lat    = svc.latency_ms != null ? `${svc.latency_ms} ms` : '';
    const uptime = calcUptimePct(svc.history ?? []);

    return `
<div class="service-card" data-chain="${escAttr(chainId)}" data-svc="${escAttr(svc.id)}">
    <div class="svc-header">
        <span class="status-dot ${cls}"></span>
        <span class="svc-name"
              data-tip="${escAttr(svc.description ?? '')}">${escHtml(svc.name)}</span>
        <span class="svc-meta">
            <span class="svc-latency">${escHtml(lat)}</span>
            <span class="svc-status-label ${cls}"
                  data-chain="${escAttr(chainId)}"
                  data-svc="${escAttr(svc.id)}">${statusLabel(svc.status)}</span>
        </span>
    </div>
    ${renderHistoryBar(svc.history ?? [])}
    <div class="svc-uptime-row">
        ${uptime !== null
            ? (uptime < 100
                ? `<button class="uptime-err-toggle" title="Nur Fehler anzeigen">&#9888;</button>${uptime.toFixed(2)}\u202f% uptime (7\u202fTage)`
                : `${uptime.toFixed(2)}\u202f% uptime (7\u202fTage)`)
            : ''}
    </div>
    ${svc.bots?.length ? renderBotTags(svc.bots) : ''}
</div>`;
}

// ── Bot-Tags ───────────────────────────────────────────────────────────────────

function renderBotTags(bots) {
    const tags = bots.map(b =>
        `<span class="bot-tag ${escAttr(b)}">${escHtml(BOT_LABELS[b] ?? b)}</span>`
    ).join('');
    return `<div class="svc-bots">${tags}</div>`;
}

// ── History-Balken ─────────────────────────────────────────────────────────────

function renderHistoryBar(history) {
    const now  = Date.now();
    const from = Math.floor((now - HISTORY_HOURS * 3_600_000) / 3_600_000) * 3_600_000;
    const map  = new Map(history.map(h => [h.ts, h.s]));

    const blocks = [];
    for (let i = 0; i < HISTORY_HOURS; i++) {
        const ts     = from + i * 3_600_000;
        const s      = map.get(ts) ?? 'nodata';
        const entry  = history.find(h => h.ts === ts);
        const pctStr = entry ? ` – ${((entry.ok / entry.total) * 100).toFixed(0)}% ok (${entry.ok}/${entry.total})` : '';
        blocks.push(`<span class="hist-block ${s}" data-htip="${escAttr(fmtHour(ts) + pctStr)}"></span>`);
    }

    return `
<div class="history-bar-wrap">
    <div class="history-bar">${blocks.join('')}</div>
    <div class="history-labels"><span>Vor 7 Tagen</span><span>Heute</span></div>
</div>`;
}

function fmtHour(ts) {
    const d  = new Date(ts);
    const dd = d.getDate().toString().padStart(2, '0');
    const mm = (d.getMonth() + 1).toString().padStart(2, '0');
    const hh = d.getHours().toString().padStart(2, '0');
    return `${dd}.${mm}. ${hh}:00`;
}

function calcUptimePct(history) {
    if (!history.length) return null;
    const total = history.reduce((s, h) => s + h.total, 0);
    const ok    = history.reduce((s, h) => s + h.ok,    0);
    return total > 0 ? (ok / total) * 100 : null;
}

// ── JS-Tooltip ─────────────────────────────────────────────────────────────────
// Positioniert sich relativ zum Viewport → kein Clipping durch Parent-Overflow

const tooltip = document.getElementById('svcJsTooltip');

// Zuletzt gehoverter hist-block (für hovered-Klasse)
let _lastHistBlock = null;

function showTooltip(text, clientX, clientY) {
    tooltip.textContent = text;
    tooltip.classList.remove('hidden');
    const GAP = 12;
    const tw  = tooltip.offsetWidth  || 220;
    const th  = tooltip.offsetHeight || 40;
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;
    let left  = clientX + GAP;
    let top   = clientY - th - GAP;
    if (left + tw > vw - GAP) left = clientX - tw - GAP;
    if (top < GAP) top = clientY + GAP;
    tooltip.style.left = `${left}px`;
    tooltip.style.top  = `${top}px`;
}

document.addEventListener('mousemove', e => {
    // Dienstname-Tooltip
    const nameEl = e.target.closest('.svc-name[data-tip]');
    if (nameEl?.dataset.tip) {
        showTooltip(nameEl.dataset.tip, e.clientX, e.clientY);
        return;
    }

    // History-Bar-Tooltip: gesamte Bar als Trefferfläche nutzen
    const bar = e.target.closest('.history-bar');
    if (bar) {
        const rect     = bar.getBoundingClientRect();
        const ratio    = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const idx      = Math.min(Math.floor(ratio * bar.children.length), bar.children.length - 1);
        const block    = bar.children[idx];
        const errsOnly = bar.closest('.service-card')?.classList.contains('errors-only');

        // Im errors-only-Modus: gedimmte Blöcke überspringen
        if (errsOnly && block && (block.classList.contains('ok') || block.classList.contains('nodata'))) {
            if (_lastHistBlock) { _lastHistBlock.classList.remove('hovered'); _lastHistBlock = null; }
            tooltip.classList.add('hidden');
            return;
        }

        // hovered-Klasse umsetzen
        if (_lastHistBlock && _lastHistBlock !== block) _lastHistBlock.classList.remove('hovered');
        if (block) { block.classList.add('hovered'); _lastHistBlock = block; }

        const tip = block?.dataset.htip;
        if (tip) { showTooltip(tip, e.clientX, e.clientY); return; }
    } else if (_lastHistBlock) {
        _lastHistBlock.classList.remove('hovered');
        _lastHistBlock = null;
    }

    tooltip.classList.add('hidden');
});

document.addEventListener('mouseleave', () => {
    tooltip.classList.add('hidden');
    if (_lastHistBlock) { _lastHistBlock.classList.remove('hovered'); _lastHistBlock = null; }
}, true);

// ── Detail-Modal ───────────────────────────────────────────────────────────────

const backdrop   = document.getElementById('svcModalBackdrop');
const modalDot   = document.getElementById('svcModalDot');
const modalTitle = document.getElementById('svcModalTitle');
const modalBody  = document.getElementById('svcModalBody');

function openModal(chainId, svcId) {
    if (!currentData) return;
    const chain = currentData.chains.find(c => c.id === chainId);
    const svc   = chain?.services.find(s => s.id === svcId);
    if (!svc) return;

    const cls = sanitizeStatus(svc.status);
    modalDot.className   = `svc-modal-dot ${cls}`;
    modalTitle.textContent = svc.name;
    modalBody.innerHTML    = renderModalBody(svc, currentData.nexus);
    backdrop.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    backdrop.classList.add('hidden');
    document.body.style.overflow = '';
}

function renderModalBody(svc, nexus) {
    const cls    = sanitizeStatus(svc.status);
    const uptime = calcUptimePct(svc.history ?? []);
    const parts  = [];

    // ── Beschreibung ────────────────────────────────────────────────────────────
    if (svc.description) {
        parts.push(`<div class="modal-description">${escHtml(svc.description)}</div>`);
    }

    // ── Basis-Stats ─────────────────────────────────────────────────────────────
    parts.push(`
<div>
    <div class="modal-section-title">Status</div>
    <div class="modal-stats-grid">
        <div class="modal-stat">
            <span class="modal-stat-label">Aktuell</span>
            <span class="modal-stat-val ${cls}">${statusLabel(svc.status)}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">Antwortzeit</span>
            <span class="modal-stat-val">${svc.latency_ms != null ? svc.latency_ms + ' ms' : '–'}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">Detail</span>
            <span class="modal-stat-val">${escHtml(svc.detail ?? '–')}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">Uptime (7 Tage)</span>
            <span class="modal-stat-val ${uptime !== null && uptime < 90 ? 'warn' : ''}">${uptime !== null ? uptime.toFixed(2) + '\u202f%' : '–'}</span>
        </div>
    </div>
</div>`);

    // ── Nexus-Stats (nur forge-nexus, wenn Daten vorhanden) ─────────────────────
    if (svc.id === 'forge-nexus' && nexus) {
        const hitRate    = nexus.rpc_hit_rate_pct    != null ? `${nexus.rpc_hit_rate_pct.toFixed(1)}\u202f%`       : '–';
        const proj       = nexus.rpc_projected_monthly != null ? nexus.rpc_projected_monthly.toLocaleString('de-DE') + ' Credits' : '–';
        const budgetCls  = nexus.rpc_over_budget ? 'danger' : nexus.rpc_near_budget ? 'warn' : '';
        const budgetHint = nexus.rpc_over_budget ? ' ⛔' : nexus.rpc_near_budget ? ' ⚠' : '';
        const upSec      = nexus.uptime_sec != null ? fmtUptime(nexus.uptime_sec) : '–';
        const circuit    = nexus.jupiter_circuit?.state ?? '–';
        const circuitCls = { closed: '', 'half-open': 'warn', open: 'error' }[circuit] ?? '';
        const txPending  = nexus.tx_queue?.pending ?? 0;
        const txTotal    = nexus.tx_queue?.total   ?? 0;

        let rateSummary = '–';
        if (nexus.rate_limits) {
            const vals = Object.values(nexus.rate_limits)
                .map(l => (l.current ?? 0) / Math.max(l.max ?? 1, 1) * 100)
                .filter(v => !isNaN(v));
            if (vals.length) rateSummary = `${Math.max(...vals).toFixed(0)}\u202f% max`;
        }

        parts.push(`
<div>
    <div class="modal-section-title">Nexus-Statistiken</div>
    <div class="modal-stats-grid">
        <div class="modal-stat">
            <span class="modal-stat-label">Uptime</span>
            <span class="modal-stat-val">${upSec}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">RPC Cache-Hit-Rate</span>
            <span class="modal-stat-val ${budgetCls}">${hitRate}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">Hochrechnung / Monat</span>
            <span class="modal-stat-val ${budgetCls}" title="Free-Tier-Limit: 1.000.000 Credits">${proj}${budgetHint}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">RPC Cache-Einträge</span>
            <span class="modal-stat-val">${nexus.rpc_entries ?? '–'}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">Jupiter Circuit</span>
            <span class="modal-stat-val ${circuitCls}">${circuit}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">TX Queue (offen / gesamt)</span>
            <span class="modal-stat-val">${txPending} / ${txTotal}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">Rate-Limit-Auslastung</span>
            <span class="modal-stat-val">${rateSummary}</span>
        </div>
    </div>
</div>`);
    }

    return parts.join('');
}

function fmtUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// ── Fehler-Filter: localStorage-Persistenz ────────────────────────────────────

const LS_ERR_PREFIX = 'health_erronly_';

function errOnlyKey(chainId, svcId) {
    return `${LS_ERR_PREFIX}${chainId}_${svcId}`;
}

function restoreErrorsOnly() {
    document.querySelectorAll('.service-card[data-chain][data-svc]').forEach(card => {
        if (localStorage.getItem(errOnlyKey(card.dataset.chain, card.dataset.svc)) === '1') {
            card.classList.add('errors-only');
            const btn = card.querySelector('.uptime-err-toggle');
            if (btn) { btn.classList.add('active'); btn.title = 'Alle anzeigen'; }
        }
    });
}

// ── Modal öffnen via Klick auf Status-Badge (Event-Delegation) ────────────────
// + Fehler-Filter-Toggle via Klick auf .uptime-err-toggle
document.addEventListener('click', e => {
    const toggle = e.target.closest('.uptime-err-toggle');
    if (toggle) {
        const card   = toggle.closest('.service-card');
        const active = card.classList.toggle('errors-only');
        toggle.classList.toggle('active', active);
        toggle.title = active ? 'Alle anzeigen' : 'Nur Fehler anzeigen';
        const key = errOnlyKey(card.dataset.chain, card.dataset.svc);
        active ? localStorage.setItem(key, '1') : localStorage.removeItem(key);
        return;
    }
    const badge = e.target.closest('.svc-status-label[data-svc]');
    if (badge) {
        openModal(badge.dataset.chain, badge.dataset.svc);
        return;
    }
    // Außerhalb des Modals → schließen
    if (e.target === backdrop) closeModal();
});

document.getElementById('svcModalClose').addEventListener('click', closeModal);

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) closeModal();
});

// ── Tab-Switching ──────────────────────────────────────────────────────────────

document.querySelectorAll('.htab:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.htab').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.htab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        const panel = document.getElementById(`tab-${btn.dataset.tab}`);
        if (panel) panel.classList.add('active');
    });
});

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function sanitizeStatus(s) {
    return ['ok', 'warn', 'error', 'unknown'].includes(s) ? s : 'unknown';
}
function statusLabel(s) {
    return { ok: 'Online', warn: 'Degraded', error: 'Offline', unknown: 'Unbekannt' }[s] ?? 'Unbekannt';
}
function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Brief-Icon → Message Center (nur LAN) ─────────────────────────────────────
// Ersetzt das frühere NotifHub-Panel. Verdrahtung zentral in js/message-bell.js.
initMessageBell();

// ── Legende-Modal ─────────────────────────────────────────────────────────────

(function initLegend() {
    const btn     = document.getElementById('healthLegendBtn');
    const overlay = document.getElementById('healthLegendOverlay');
    const closeBtn = document.getElementById('healthLegendClose');
    if (!btn || !overlay) return;

    btn.addEventListener('click', () => overlay.classList.remove('hidden'));
    closeBtn?.addEventListener('click', () => overlay.classList.add('hidden'));
    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.classList.add('hidden');
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !overlay.classList.contains('hidden'))
            overlay.classList.add('hidden');
    });
})();

// ── Start + Auto-Refresh ───────────────────────────────────────────────────────

loadAndRender();
setInterval(loadAndRender, REFRESH_MS);
