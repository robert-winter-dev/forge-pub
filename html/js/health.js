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

import { initNav, initFooter, setLastUpdate } from './nav.js?v=20260816a';
import { initMessageBell } from './message-bell.js?v=20260816a';
// Sprache: t() nimmt den deutschen Text als Fallback UND Vorlage, applyDom()
// übersetzt das statische Markup. Dynamisch erzeugte Karten gehen durch t().
import { t, applyDom, NUM_LOCALE } from './i18n.js?v=20260813a';
// Alias, weil diese Datei ein eigenes closeModal() für das Dienst-Detailfenster hat.
import { showModal, closeModal as closeForgeModal } from './modal.js?v=20260731a';
import { showToast } from './toast.js?v=20260722b';

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
            : `<p style="color:var(--text-muted);font-size:.85rem;grid-column:1/-1">${t('health.no_services', 'Keine Dienste konfiguriert.')}</p>`;
    }
    applyDom();
    restoreErrorsOnly();
}

// ── Service-Card ───────────────────────────────────────────────────────────────

function renderServiceCard(svc, chainId) {
    const cls    = sanitizeStatus(svc.status);
    // Die Host-Prüfungen liefern einen Messwert statt einer Antwortzeit – beides
    // teilt sich denselben Platz in der Kopfzeile, angezeigt wird was vorliegt.
    const lat    = svc.metric ?? (svc.latency_ms != null ? `${svc.latency_ms} ms` : '');
    const uptime = calcUptimePct(svc.history ?? []);
    // "99,8 % uptime" ergibt für eine Festplatte keinen Sinn – dort ist die Frage
    // nicht, ob sie lief, sondern ob sie im grünen Bereich war.
    const sevenDays = t('health.seven_days', '7 Tage').replace(' ', '\u202f');
    const uptimeLabel = chainId === 'host' ? t('health.unremarkable_low', 'unauffällig') : t('health.uptime_low', 'uptime');

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
                  data-svc="${escAttr(svc.id)}"
                  data-tip="${escAttr(statusTooltip(svc, chainId))}">${statusLabel(svc.status, chainId)}</span>
        </span>
    </div>
    ${renderHistoryBar(svc.history ?? [])}
    <div class="svc-uptime-row">
        ${uptime !== null
            ? (uptime < 100
                ? `<button class="uptime-err-toggle" title="${escAttr(t('health.errors_only', 'Nur Fehler anzeigen'))}">&#9888;</button>${uptime.toFixed(2)}\u202f% ${uptimeLabel} (${sevenDays})`
                : `${uptime.toFixed(2)}\u202f% ${uptimeLabel} (${sevenDays})`)
            : cls === 'disabled'
                // Ein durchgehend abgeschalteter Dienst hat keine Uptime \u2013 "no data"
                // kl\u00e4nge hier nach einer Messl\u00fccke, dabei ist die Ursache bekannt.
                ? t('health.disabled_7d', 'deaktiviert – keine Messung in 7 Tagen')
                : t('health.no_measurement_7d', 'no data – keine gültige Messung in 7 Tagen')}
    </div>
    ${svc.process ? renderProcessRow(svc.process) : ''}
    ${svc.bots?.length ? renderBotTags(svc.bots) : ''}
</div>`;
}

// ── Prozess-Zeile (nur systemd-Dienste) ───────────────────────────────────────
// Kompakt direkt auf der Karte (Festlegung 2026-08-13, Systemdaten-Freigabe): nützt dem
// lokalen Nutzer unabhängig davon, ob er später Daten mit dem Master teilt – Speicher pro
// Prozess zeigt Lecks, die der Host-RAM-Wert (Rubrik "Host") in den Schwankungen der
// übrigen Dienste verschwinden lässt.
function renderProcessRow(process) {
    const parts = [fmtMemBytes(process.memBytes)];
    if (process.uptimeSec != null) parts.push(t('health.running_since', 'läuft seit {d}', { d: fmtUptime(process.uptimeSec) }));
    if (process.restarts  != null) parts.push(process.restarts === 1
        ? t('health.restarts_one', '{n} Neustart', { n: process.restarts })
        : t('health.restarts_many', '{n} Neustarts', { n: process.restarts }));
    return `<div class="svc-process-row">${parts.join(' · ')}</div>`;
}

function fmtMemBytes(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return `${Math.round(bytes / 1024 ** 2)} MB`;
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
        // entry.total zählt nur gültige Messungen (bin/health-check.js). Eine Stunde,
        // in der ausschließlich ungültige Messungen anfielen, hat total = 0 – ohne
        // diesen Zweig stünde im Tooltip "NaN% ok (0/0)".
        const pctStr = !entry
            ? ''
            : entry.total > 0
                ? ` – ${((entry.ok / entry.total) * 100).toFixed(0)}% ok (${entry.ok}/${entry.total})`
                : ` – ${t('health.hist_no_valid', 'keine gültige Messung')}`;
        blocks.push(`<span class="hist-block ${s}" data-htip="${escAttr(fmtHour(ts) + pctStr)}"></span>`);
    }

    return `
<div class="history-bar-wrap">
    <div class="history-bar">${blocks.join('')}</div>
    <div class="history-labels"><span>${t('health.hist_7d_ago', 'Vor 7 Tagen')}</span><span>${t('health.hist_today', 'Heute')}</span></div>
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
    // Tooltip auf Dienstname (Beschreibung) und Status-Schaltfläche (Erklärung des
    // aktuellen Zustands) – beide über dasselbe data-tip, deshalb ein Selektor.
    const tipEl = e.target.closest('[data-tip]');
    if (tipEl?.dataset.tip) {
        showTooltip(tipEl.dataset.tip, e.clientX, e.clientY);
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
    modalBody.innerHTML    = renderModalBody(svc, currentData.nexus, chainId);
    backdrop.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    backdrop.classList.add('hidden');
    document.body.style.overflow = '';
}

function renderModalBody(svc, nexus, chainId) {
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
    <div class="modal-section-title">${t('health.modal_status', 'Status')}</div>
    <div class="modal-stats-grid">
        <div class="modal-stat">
            <span class="modal-stat-label">${t('health.modal_current', 'Aktuell')}</span>
            <span class="modal-stat-val ${cls}">${statusLabel(svc.status, chainId)}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">${svc.metric ? t('health.modal_metric', 'Messwert') : t('health.modal_latency', 'Antwortzeit')}</span>
            <span class="modal-stat-val">${svc.metric ? escHtml(svc.metric) : (svc.latency_ms != null ? svc.latency_ms + ' ms' : t('health.no_data', 'no data'))}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">${t('health.modal_detail', 'Detail')}</span>
            <span class="modal-stat-val">${escHtml(svc.detail ?? t('health.no_data', 'no data'))}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">${svc.metric ? t('health.modal_unremarkable', 'Unauffällig') : t('health.modal_uptime', 'Uptime')} (${t('health.seven_days', '7 Tage')})</span>
            <span class="modal-stat-val ${uptime !== null && uptime < 90 ? 'warn' : ''}">${uptime !== null ? uptime.toFixed(2) + '\u202f%' : t('health.no_data', 'no data')}</span>
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
    <div class="modal-section-title">${t('health.nexus_stats', 'Nexus-Statistiken')}</div>
    <div class="modal-stats-grid">
        <div class="modal-stat">
            <span class="modal-stat-label">${t('health.nexus_uptime', 'Uptime')}</span>
            <span class="modal-stat-val">${upSec}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">${t('health.nexus_hitrate', 'RPC Cache-Hit-Rate')}</span>
            <span class="modal-stat-val ${budgetCls}">${hitRate}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">${t('health.nexus_projection', 'Hochrechnung / Monat')}</span>
            <span class="modal-stat-val ${budgetCls}" title="Free-Tier-Limit: 1.000.000 Credits">${proj}${budgetHint}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">${t('health.nexus_entries', 'RPC Cache-Einträge')}</span>
            <span class="modal-stat-val">${nexus.rpc_entries ?? '–'}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">${t('health.nexus_circuit', 'Jupiter Circuit')}</span>
            <span class="modal-stat-val ${circuitCls}">${circuit}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">${t('health.nexus_txqueue', 'TX Queue (offen / gesamt)')}</span>
            <span class="modal-stat-val">${txPending} / ${txTotal}</span>
        </div>
        <div class="modal-stat">
            <span class="modal-stat-label">${t('health.nexus_ratelimit', 'Rate-Limit-Auslastung')}</span>
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
            if (btn) { btn.classList.add('active'); btn.title = t('health.show_all', 'Alle anzeigen'); }
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
        toggle.title = active ? t('health.show_all', 'Alle anzeigen') : t('health.errors_only', 'Nur Fehler anzeigen');
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
    return ['ok', 'warn', 'error', 'unknown', 'disabled'].includes(s) ? s : 'unknown';
}
// Online/Degraded/Offline beschreibt die Erreichbarkeit eines Dienstes – auf einen
// Messwert des Servers angewendet wäre es schlicht falsch ("Festplatte: Offline" bei
// einer vollen Platte). Die Host-Rubrik bekommt deshalb eigene Bezeichnungen für
// dieselben vier Zustände. Das ist keine Kosmetik: dieser Text ist der Träger der
// Bedeutung, die Farbe ist nur die Verstärkung.
// 'disabled' ist bewusst kein Unterfall von "Degraded": ein abgeschalteter Dienst ist
// nicht eingeschränkt, er soll gar nicht laufen. Die Host-Rubrik kennt den Zustand
// nicht (Messwerte lassen sich nicht abschalten), erbt den Eintrag aber der
// Vollständigkeit halber – statusLabel() würde sonst auf "Unbekannt" zurückfallen.
const STATUS_LABELS = {
    dienst: { ok: t('health.st_online', 'Online'), warn: t('health.st_degraded', 'Degraded'), error: t('health.st_offline', 'Offline'), unknown: t('health.st_unknown', 'Unbekannt'), disabled: t('health.st_disabled', 'Deaktiviert') },
    host:   { ok: t('health.st_normal', 'Normal'), warn: t('health.st_tight', 'Knapp'),    error: t('health.st_critical', 'Kritisch'), unknown: t('health.st_unknown', 'Unbekannt'), disabled: t('health.st_disabled', 'Deaktiviert') },
};

function statusLabel(s, chainId) {
    const set = chainId === 'host' ? STATUS_LABELS.host : STATUS_LABELS.dienst;
    return set[s] ?? t('health.st_unknown', 'Unbekannt');
}

// Ein einzelnes Wort wie "Kritisch" sagt, DASS etwas nicht stimmt, aber nicht WAS –
// und genau in dem Moment braucht der Betreiber die Antwort sofort, nicht erst nach
// einem Klick ins Modal. Der Tooltip beantwortet deshalb beides: was der Zustand
// bedeutet (allgemein) und was hier konkret gemessen wurde (svc.detail).
const STATUS_EXPLAIN = {
    dienst: {
        ok:      t('health.ex_svc_ok', 'Der Dienst antwortet normal.'),
        warn:    t('health.ex_svc_warn', 'Der Dienst antwortet, aber eingeschränkt – langsam, mit Fehlern oder bewusst angehalten.'),
        error:   t('health.ex_svc_error', 'Der Dienst ist nicht erreichbar.'),
        unknown: t('health.ex_svc_unknown', 'Der Zustand ließ sich nicht bestimmen – die Messung war ungültig.'),
        // Bewusst ohne systemd-Bezug ("startet beim Systemstart nicht"): denselben Status
        // trägt auch die Premium-Auslieferung, die gar kein Dienst auf diesem Server ist.
        // Was genau abgeschaltet ist, steht darunter im Detailtext.
        disabled: t('health.ex_svc_disabled', 'Dieser Dienst ist abgeschaltet – es gibt nichts zu überwachen, bis er eingeschaltet wird. Kein Fehler, sondern der gewollte Zustand.'),
    },
    host: {
        ok:      t('health.ex_host_ok', 'Der Messwert liegt im unbedenklichen Bereich.'),
        warn:    t('health.ex_host_warn', 'Der Messwert wird eng. Noch kein Problem, aber die Reserve schwindet.'),
        error:   t('health.ex_host_error', 'Der Messwert ist kritisch – hier ist Handeln nötig.'),
        unknown: t('health.ex_host_unknown', 'Der Messwert ließ sich nicht bestimmen.'),
        disabled: t('health.ex_host_disabled', 'Diese Prüfung ist abgeschaltet.'),
    },
};

function statusTooltip(svc, chainId) {
    const set     = chainId === 'host' ? STATUS_EXPLAIN.host : STATUS_EXPLAIN.dienst;
    const explain = set[sanitizeStatus(svc.status)];
    // Der detail-Text der System-Prüfungen nennt Messwert UND Handlungsempfehlung und
    // ist damit die eigentliche Antwort; bei den Diensten steht dort oft nur ein
    // technisches Kürzel ("active", "HTTP 200"), das die Erklärung sinnvoll ergänzt.
    return svc.detail ? `${explain}\n\n${svc.detail}` : explain;
}
function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
    // & muss zuerst ersetzt werden, sonst würden die eigenen Ersetzungen unten
    // nachträglich mit-escaped. Ergänzt 2026-08-13, weil data-tip jetzt auch
    // svc.detail transportiert – dort landen u.a. Fehlertexte externer APIs, in
    // denen bereits eine Entity wie &quot; stehen kann; ohne &-Escaping würde die
    // beim Parsen zu einem echten Anführungszeichen und bräche das Attribut auf.
    // Zeilenumbrüche als &#10;, damit mehrzeilige Tooltips das Markup nicht zerlegen.
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '&#10;');
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

// ── Systemdaten-Freigabe (nur auf einer FORGE-public-Installation) ────────────
// Der Health Monitor wird an ZWEI Orten ausgeliefert: lokal von forge-settings
// (same-origin zu /api/…) und als statische Kopie auf dem Webserver, wo es gar kein
// Backend gibt. Der Abschnitt bleibt deshalb verborgen, bis die API tatsächlich
// antwortet — er darf nirgends als toter Schalter erscheinen.

const SHARE_API = '/api/health-share/opt-in';

/**
 * Zustandszeile neben dem Haken. „Daten teilen" ist gewöhnliche Opt-in-Telemetrie —
 * der Nutzer will genau eine Sache wissen: Werden meine Daten gesendet oder nicht?
 */
const SHARE_STATE_TEXT = {
    off:              () => '',
    // Ohne zugestellte Aktivierung kennt der Master den Absender nicht und verwirft
    // dessen Reports — deshalb ist das kein kosmetischer Zustand, sondern einer mit
    // Handlungsaufforderung.
    enabling:         () => t('health.share_enabling', 'Aktivierung noch nicht übermittelt – bitte erneut versuchen'),
    applied:          () => t('health.share_on', 'Freigabe aktiv – die Daten werden stündlich gesendet'),
    approved_waiting: () => t('health.share_approved', 'Freigabe aktiv – der Premium-Zugang wird zur nächsten vollen Stunde aktiv'),
    active:           () => t('health.share_on', 'Freigabe aktiv – die Daten werden stündlich gesendet'),
    active_degraded:  () => t('health.share_degraded', 'Freigabe aktiv, letzter Report fehlgeschlagen'),
    revoked:          () => t('health.share_revoked', 'Freigabe widerrufen – bei Fragen bitte den Support-Chat nutzen'),
};

// Letzter bekannter Zustand — die Abschalt-Rückfrage muss wissen, ob dieser Nutzer
// überhaupt einen Premium-Zugang zu verlieren hat (siehe unten).
let lastShareState = null;

function renderShare(state) {
    lastShareState = state;
    const box   = document.getElementById('healthShare');
    const check = document.getElementById('hshareCheck');
    const label = document.getElementById('hshareState');
    if (!box || !check) return;

    // Reiter UND Sektion: der Button trägt dieselbe hidden-Klasse, sonst stünde er auf
    // dem Master und auf statischen Kopien leer in der Leiste (Fund 2026-08-13).
    document.getElementById('shareOptInTab')?.classList.remove('hidden');
    box.classList.remove('hidden');
    check.checked = !!state.enabled;

    let text = SHARE_STATE_TEXT[state.phase]?.() ?? '';
    if (state.phase === 'active_degraded' && state.lastReportAt) {
        text += ` (${t('health.share_last_ok', 'zuletzt erfolgreich {ts}', { ts: new Date(state.lastReportAt).toLocaleString(NUM_LOCALE) })})`;
    }
    label.textContent = text;
    // Zustand steht als Wort da; die Klasse verstärkt nur.
    label.className = `hshare-state ${state.phase === 'active' ? 'ok' : state.phase === 'off' ? '' : 'warn'}`;

    // Verlauf nur sichtbar, solange der Haken gesetzt ist — ausgeschaltet gibt es
    // nichts Aktuelles nachzuvollziehen, alte Einträge blieben sonst irreführend stehen.
    document.getElementById('hshareHistory')?.classList.toggle('hidden', !state.enabled);

    // Ein Widerruf ist die einzige Lage, in der der Nutzer aktiv etwas erfahren muss,
    // ohne dass er selbst etwas getan hat — deshalb zusätzlich als Meldung, nicht nur
    // als Statuszeile am Rand.
    if (state.phase === 'revoked') {
        showShareError(t('health.share_revoked_note', 'Die Freigabe wurde vom FORGE Master widerrufen. Es werden keine Daten mehr gesendet, der Premium-Zugang endet binnen 60 Minuten.'));
    }
}

function showShareError(msg) {
    const el = document.getElementById('hshareError');
    if (!el) return;
    el.textContent = msg ?? '';
    el.classList.toggle('hidden', !msg);
}

async function loadShare() {
    try {
        const res = await fetch(SHARE_API);
        if (!res.ok) return;                 // 404 = Master oder statische Kopie
        renderShare(await res.json());
    } catch {
        // Kein Backend erreichbar (statische Kopie) – Abschnitt bleibt verborgen.
    }
}

/**
 * 🔒 Keine nativen Browser-Dialoge (alert/confirm) – im ganzen Projekt nicht.
 * Rückfragen laufen über das Modal-System (js/modal.js).
 */
document.getElementById('hshareCheck')?.addEventListener('change', (e) => {
    const box = e.currentTarget;
    if (!box.checked) {
        // Erst nach der Bestätigung wirklich ausschalten – bis dahin bleibt der Haken
        // stehen, damit ein Abbruch den vorherigen Zustand nicht verändert.
        box.checked = true;
        const id = 'hshare-off-confirm';
        // Der Premium-Hinweis erscheint NUR, wenn dieser Nutzer tatsächlich einen
        // Zugang über die Freigabe hat — für alle anderen wäre er die Ankündigung
        // eines Verlusts, den es nicht gibt.
        const hatPremium = ['approved_waiting', 'active', 'active_degraded']
            .includes(lastShareState?.phase);
        showModal({
            id,
            title: t('health.share_confirm_title', 'Freigabe beenden?'),
            body:  '<p style="margin:0;font-size:.88rem;line-height:1.55">'
                 + t('health.share_confirm_off', 'Daten teilen beenden? Es werden dann keine Daten mehr an den FORGE Master gesendet.')
                 + (hatPremium ? ' ' + t('health.share_confirm_off_premium', 'Der Premium-Zugang läuft damit binnen 60 Minuten aus.') : '')
                 + '</p>',
            actions: [
                { label: t('health.share_end', 'Freigabe beenden'),
                  onClick: () => { closeForgeModal(id); box.checked = false; applyShare(false, box); } },
                { label: t('common.cancel', 'Abbrechen'), onClick: () => closeForgeModal(id) },
            ],
        });
        return;
    }
    applyShare(true, box);
});

async function applyShare(on, box) {
    box.disabled = true;
    showShareError(null);
    try {
        const res  = await fetch(`${SHARE_API}/${on ? 'enable' : 'disable'}`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (data.error) showShareError(data.error);
        if (data.phase) renderShare(data);
        else await loadShare();
    } catch (err) {
        showShareError(t('health.not_possible', 'Nicht möglich: {error}', { error: err.message }));
        await loadShare();
    } finally {
        box.disabled = false;
    }
}

/**
 * Verlauf der eigenen gesendeten Reports – lädt erst beim Öffnen, nicht im
 * Hintergrund-Poll (Kurswechsel 2026-08-14): ein stündlicher Report ist kein
 * Ereignis, das laufend abgefragt werden muss, und die Liste ändert sich ohnehin nur
 * einmal pro Stunde.
 */
// Zuletzt geladene Reports – die Liste zeigt nur die Kopfzeile (Zeitpunkt), der
// Volltext kommt erst im Modal nach einem Klick. Hier zwischengespeichert, damit der
// Klick-Handler nicht erneut fetchen muss.
let lastSentReports = [];

/**
 * Zeitpunkt eines Reports – mit Wochentag, weil die Liste bis zu 7 Tage umfasst und
 * "12:03 Uhr" allein über mehrere Tage hinweg nicht mehr unterscheidbar ist. "Uhr"
 * ist sprachabhängig, dasselbe Muster wie bei formatHourRange() in
 * core/premium/server.js (Englisch bekommt kein Suffix).
 */
function formatReportWhen(ms) {
    const d = new Date(ms);
    const weekday = d.toLocaleDateString(NUM_LOCALE, { weekday: 'long' });
    const date    = d.toLocaleDateString(NUM_LOCALE);
    const time    = d.toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' });
    return t('health.share_history_when', '{weekday}, {date}, {time} Uhr', { weekday, date, time });
}

/**
 * Version aus dem Report-Text lesen ("Version: 0.9.8+40 · OS: …", zweite Kopfzeile
 * von formatHealthReportText() in lib/health-report.js). Bewusst aus dem Text statt
 * über ein eigenes Feld in der Antwort — der Verlauf speichert nur den fertigen Text,
 * kein strukturiertes Objekt, siehe recordSentReport(). Liefert `null`, wenn die Zeile
 * fehlt oder das Format sich ändert – die Anzeige lässt das Feld dann einfach weg,
 * statt "Version: undefined" auszugeben.
 */
function extractReportVersion(text) {
    return /^Version:\s*(\S+)/m.exec(text ?? '')?.[1] ?? null;
}

/**
 * Kurzer Titel für die Listenzeile: nur Zeitpunkt, keine Version (2026-08-14,
 * Nachbesserung – mit Master-Detail-Layout ist die Zeile schmaler als vorher die
 * volle Breite, die Version passte dort nicht mehr ohne Umbruch/Kürzung).
 */
function formatReportListLabel(report) {
    return t('health.share_history_row_label_no_version', 'Systemreport · {when}', { when: formatReportWhen(report.sentAt) });
}

/** Voller Titel mit Version für die Kopfzeile im Detailbereich — dort ist genug
 *  Breite, und die Version ist gerade dort die nützliche Zusatzinfo. */
function formatReportDetailLabel(report) {
    const when    = formatReportWhen(report.sentAt);
    const version = extractReportVersion(report.text);
    return version != null
        ? t('health.share_history_row_label', 'Systemreport · {when}, FORGE public Version: {version}', { when, version })
        : t('health.share_history_row_label_no_version', 'Systemreport · {when}', { when });
}

/** Setzt den Detailbereich rechts zurück auf den Platzhalter-Hinweis. */
function resetShareHistoryDetail() {
    const detail = document.getElementById('hshareHistoryDetail');
    if (!detail) return;
    detail.innerHTML = `<p class="hshare-history-detail-placeholder">${escHtml(t('health.share_history_detail_placeholder', 'Für mehr Details klicke eine Nachricht an.'))}</p>`;
}

document.getElementById('hshareHistory')?.addEventListener('toggle', async (e) => {
    // Erklär-Boxen weg, sobald der Verlauf offen ist – auf Notebooks muss man sonst
    // erst an ihnen vorbeischrollen, bis die Liste sichtbar wird. Läuft für BEIDE
    // Richtungen (auch beim Zuklappen), deshalb vor dem early return unten.
    document.getElementById('hshareBoxesWrap')?.classList.toggle('collapsed', e.currentTarget.open);

    if (!e.currentTarget.open) return;
    const list = document.getElementById('hshareHistoryList');
    if (!list) return;
    resetShareHistoryDetail();
    list.innerHTML = `<li class="hshare-history-empty">${escHtml(t('health.share_history_loading', 'Lade…'))}</li>`;
    try {
        const res  = await fetch(`${SHARE_API}/reports`);
        const data = await res.json().catch(() => ({}));
        lastSentReports = Array.isArray(data.reports) ? data.reports : [];
        if (!lastSentReports.length) {
            list.innerHTML = `<li class="hshare-history-empty">${escHtml(t('health.share_history_empty', 'Noch keine Reports gesendet.'))}</li>`;
            return;
        }
        list.innerHTML = lastSentReports.map((r, i) => `
            <li>
                <button type="button" class="hshare-history-entry" data-idx="${i}">
                    <span class="hshare-history-label">${escHtml(formatReportListLabel(r))}</span>
                    <span class="hshare-history-arrow" aria-hidden="true">›</span>
                </button>
            </li>
        `).join('');
    } catch (err) {
        list.innerHTML = `<li class="hshare-history-empty">${escHtml(t('health.not_possible', 'Nicht möglich: {error}', { error: err.message }))}</li>`;
    }
});

/**
 * Master-Detail statt Modal (2026-08-14, zweite Nachbesserung): Klick füllt die
 * Detailbox rechts, statt einen Dialog zu öffnen — der Nutzer kann so durch mehrere
 * Reports blättern, ohne jedes Mal ein Fenster schließen zu müssen.
 */
document.getElementById('hshareHistoryList')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.hshare-history-entry');
    if (!btn) return;
    const report = lastSentReports[Number(btn.dataset.idx)];
    if (!report) return;

    e.currentTarget.querySelectorAll('.hshare-history-entry.selected')
        .forEach(el => el.classList.remove('selected'));
    btn.classList.add('selected');

    const detail = document.getElementById('hshareHistoryDetail');
    if (!detail) return;
    detail.innerHTML = `
        <div class="hshare-history-detail-head">${escHtml(formatReportDetailLabel(report))}</div>
        <pre class="hshare-history-text">${escHtml(report.text)}</pre>
    `;
});

// ── Share-Tab (nur auf dem FORGE Master) ────────────────────────────────────────
// Verwaltung der Teilnehmer, die "Daten teilen" aktiviert haben (Tab "Health Monitor >
// Share"). Bleibt wie die Freigabe-Sektion verborgen, bis die master-only API antwortet
// — auf jeder anderen Installation (Fork oder Kopie ohne Backend) liefert sie 404/Fehler.

const SHARE_ADMIN_API = '/api/health-share/manage';

// Suche + Sortierung laufen rein im Frontend – für einen "groben Überblick" über eine
// überschaubare Teilnehmerzahl braucht es keine Server-seitigen Query-Parameter, und
// ein Tastenanschlag muss nicht erst einen Roundtrip abwarten. `lastParticipants` hält
// die zuletzt vom Server gelieferte Rohliste, aus der bei jeder Sortierung/Suche neu
// gefiltert wird, statt erneut zu fetchen.
let lastParticipants = [];
let shareSearchText  = '';
let shareSortKey     = null;   // 'name' | 'first' | 'last' | null (= Server-Reihenfolge)
let shareSortDir     = 'asc';
let sharePage        = 1;      // 1-indexiert
const SHARE_PAGE_SIZE = 15;

async function loadShareAdmin() {
    let data;
    try {
        const res = await fetch(SHARE_ADMIN_API);
        if (!res.ok) return; // 404 = nicht der Master
        data = await res.json();
    } catch {
        return; // kein Backend erreichbar (statische Kopie)
    }

    document.getElementById('shareAdminTab')?.classList.remove('hidden');
    lastParticipants = data.participants ?? [];
    renderShareAdmin();
}

function shareSortValue(p, key) {
    if (key === 'name') return p.displayName ? p.displayName.toLowerCase() : null;
    if (key === 'first') return p.firstReportAt;
    if (key === 'last')  return p.lastReportAt;
    return null;
}

/** Angewandte Suche + Sortierung auf `lastParticipants` – reine Funktion, kein Fetch. */
function visibleParticipants() {
    let list = lastParticipants;

    const q = shareSearchText.trim().toLowerCase();
    if (q) list = list.filter(p => (p.displayName ?? '').toLowerCase().includes(q));

    if (shareSortKey) {
        list = [...list].sort((a, b) => {
            const av = shareSortValue(a, shareSortKey);
            const bv = shareSortValue(b, shareSortKey);
            // Fehlende Werte (kein Name, noch kein Report) immer ans Ende – unabhängig
            // von der Richtung, sonst "gewinnt" ein leerer Wert bei "absteigend".
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return shareSortDir === 'asc' ? cmp : -cmp;
        });
    }
    return list;
}

function shareStatusRowHtml(p) {
    const name = p.displayName
        ? escHtml(p.displayName)
        : `<span class="share-noname">${t('health.share_admin_no_name', 'unbenannt')}</span>`;
    const fmt = ms => ms != null ? new Date(ms).toLocaleString(NUM_LOCALE) : t('health.share_admin_no_data', 'noch keine');
    const isApproved = p.status === 'approved' || p.status === 'lapsed';
    const lapsedHint = p.status === 'lapsed'
        ? `<span class="share-status-lapsed">${t('health.share_admin_lapsed', 'ruht – keine aktuellen Reports')}</span>`
        : '';

    return `
        <tr data-pubkey="${escAttr(p.pubkeyHex)}">
            <td>
                <div class="share-user">
                    <span class="share-user-name${p.displayName ? '' : ' share-noname'}">${name}</span>
                    <button class="share-mail-btn" data-pubkey="${escAttr(p.pubkeyHex)}"
                        title="${escAttr(t('health.share_admin_message', 'Nachricht schreiben'))}">&#9993;</button>
                </div>
                ${lapsedHint}
            </td>
            <td>${fmt(p.firstReportAt)}</td>
            <td>${fmt(p.lastReportAt)}</td>
            <td>${t('health.share_admin_records', '{n} Datensätze', { n: p.reportsLast7Days ?? 0 })}</td>
            <td>
                <select data-pubkey="${escAttr(p.pubkeyHex)}">
                    <option value="none"${!isApproved ? ' selected' : ''}>${t('health.share_admin_status_none', 'Kein Status')}</option>
                    <option value="approved"${isApproved ? ' selected' : ''}>${t('health.share_admin_status_approved', 'Premium User')}</option>
                    <option value="delete">${t('health.share_admin_status_delete', 'Löschen')}</option>
                </select>
            </td>
        </tr>`;
}

function renderShareAdmin() {
    // Sortier-Pfeile an der Kopfzeile nachziehen – die <th> selbst werden nicht neu
    // gerendert (statisches Markup), nur ihre Klasse.
    document.querySelectorAll('#shareTable th.share-sortable').forEach(th => {
        th.classList.toggle('sort-asc',  th.dataset.sort === shareSortKey && shareSortDir === 'asc');
        th.classList.toggle('sort-desc', th.dataset.sort === shareSortKey && shareSortDir === 'desc');
    });

    const body = document.getElementById('shareTableBody');
    if (!body) return;

    if (!lastParticipants.length) {
        renderSharePagination(0);
        body.innerHTML = `<tr><td colspan="5" class="share-empty">${t('health.share_admin_empty', 'Noch niemand hat die Datenfreigabe aktiviert.')}</td></tr>`;
        return;
    }
    const filtered = visibleParticipants();
    if (!filtered.length) {
        body.innerHTML = `<tr><td colspan="5" class="share-empty">${t('health.share_admin_no_match', 'Keine Treffer für diese Suche.')}</td></tr>`;
        renderSharePagination(0);
        return;
    }

    // 15 pro Seite – Seite klemmen, falls Suche/Sortierung die
    // Trefferzahl unter die aktuelle Seite gedrückt hat (sonst leere Seite ohne
    // erkennbaren Ausweg).
    const pageCount = Math.max(1, Math.ceil(filtered.length / SHARE_PAGE_SIZE));
    sharePage = Math.min(sharePage, pageCount);
    const start = (sharePage - 1) * SHARE_PAGE_SIZE;
    const rows  = filtered.slice(start, start + SHARE_PAGE_SIZE);

    body.innerHTML = rows.map(shareStatusRowHtml).join('');
    renderSharePagination(filtered.length, pageCount);

    body.querySelectorAll('.share-mail-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            // Root-relativer Pfad: message.html liegt unter / (bots/settings/html/),
            // health.html unter /forge/ – ein relativer Link ("message.html") hätte
            // auf /forge/message.html gezeigt und wäre 404 gelaufen (Fund 2026-08-14).
            window.location.href = `/message.html?peer=${encodeURIComponent(btn.dataset.pubkey)}#support`;
        });
    });
    body.querySelectorAll('select').forEach(sel => {
        const previousValue = sel.value;
        sel.addEventListener('change', async () => {
            if (sel.value === 'delete') {
                const pubkey = sel.dataset.pubkey;
                const name   = sel.closest('tr')?.querySelector('.share-user-name')?.textContent ?? pubkey;
                const id     = 'share-delete-confirm';
                showModal({
                    id,
                    title: t('health.share_admin_delete_title', 'Nutzer löschen?'),
                    body:  '<p style="margin:0;font-size:.88rem;line-height:1.55">'
                         + t('health.share_admin_delete_body', '„{name}“ wird aus der Liste entfernt. Bereits empfangene Daten bleiben bestehen, ein bestehender Premium-Status entfällt mit.', { name: escHtml(name) })
                         + '</p>',
                    actions: [
                        { label: t('health.share_admin_delete_confirm', 'Löschen'), onClick: async () => {
                            closeForgeModal(id);
                            sel.disabled = true;
                            try {
                                const res  = await fetch(`${SHARE_ADMIN_API}/${pubkey}`, { method: 'DELETE' });
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
                                showToast(t('health.share_admin_deleted', '{name} wurde gelöscht.', { name }), 'success');
                            } catch (err) {
                                showToast(t('health.not_possible', 'Nicht möglich: {error}', { error: err.message }), 'error');
                            } finally {
                                await loadShareAdmin();
                            }
                        } },
                        { label: t('common.cancel', 'Abbrechen'), onClick: () => { closeForgeModal(id); sel.value = previousValue; } },
                    ],
                    onClose: () => { if (sel.value === 'delete') sel.value = previousValue; },
                });
                return;
            }

            const name = sel.closest('tr')?.querySelector('.share-user-name')?.textContent ?? sel.dataset.pubkey;
            sel.disabled = true;
            try {
                const res = await fetch(`${SHARE_ADMIN_API}/${sel.dataset.pubkey}/status`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ status: sel.value }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
                // Sichtbare Bestätigung nach jeder Statusänderung, nicht
                // nur bei Fehlern. `unchanged` (z.B. bereits approved erneut gewählt)
                // bekommt bewusst keinen Toast – es ist nichts passiert.
                if (!data.unchanged) {
                    const label = data.status === 'approved'
                        ? t('health.share_admin_status_approved', 'Premium User')
                        : t('health.share_admin_status_none', 'Kein Status');
                    showToast(t('health.share_admin_status_changed', 'Status geändert: {name} → {label}', { name, label }), 'success');
                }
            } catch (err) {
                showToast(t('health.not_possible', 'Nicht möglich: {error}', { error: err.message }), 'error');
            } finally {
                await loadShareAdmin();
            }
        });
    });
}

/** "‹ Seite X von Y ›" unter der Tabelle – nur sichtbar, wenn mehr als eine Seite. */
function renderSharePagination(totalRows, pageCount = 1) {
    const el = document.getElementById('sharePagination');
    if (!el) return;
    if (totalRows <= SHARE_PAGE_SIZE) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
    }
    el.classList.remove('hidden');
    el.innerHTML = `
        <button type="button" id="sharePagePrev" ${sharePage <= 1 ? 'disabled' : ''}>‹</button>
        <span>${t('health.share_admin_page', 'Seite {page} von {count}', { page: sharePage, count: pageCount })}</span>
        <button type="button" id="sharePageNext" ${sharePage >= pageCount ? 'disabled' : ''}>›</button>
    `;
    document.getElementById('sharePagePrev')?.addEventListener('click', () => { sharePage--; renderShareAdmin(); });
    document.getElementById('sharePageNext')?.addEventListener('click', () => { sharePage++; renderShareAdmin(); });
}

document.getElementById('shareSearch')?.addEventListener('input', (e) => {
    shareSearchText = e.target.value;
    sharePage = 1; // sonst bliebe man ggf. auf einer durch die Suche leer gewordenen Seite
    renderShareAdmin();
});

document.querySelectorAll('#shareTable th.share-sortable').forEach(th => {
    th.addEventListener('click', () => {
        if (shareSortKey === th.dataset.sort) {
            shareSortDir = shareSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            shareSortKey = th.dataset.sort;
            shareSortDir = 'asc';
        }
        sharePage = 1;
        renderShareAdmin();
    });
});

// ── Start + Auto-Refresh ───────────────────────────────────────────────────────

// Einmal sofort für das statische Markup (Reiter, Legende, Freigabe-Abschnitt):
// das applyDom() in render() läuft erst, wenn Daten da sind — scheitert der Abruf,
// bliebe die Seite sonst auch bei englischer Spracheinstellung deutsch.
applyDom();

loadAndRender();
loadShare();
loadShareAdmin();
setInterval(loadAndRender, REFRESH_MS);
setInterval(loadShare, REFRESH_MS);
setInterval(loadShareAdmin, REFRESH_MS);
