/**
 * FORGE Settings – Haupt-Controller
 *
 * Bot-Auswahl über URL-Hash: #liquidity | #lending | #nexus
 * Navigation erfolgt über das Hamburger-Menü (nav.js).
 */

import { initNav, initFooter } from '/forge/js/nav.js?v=20260808h';
import { showToast }           from '/forge/js/toast.js?v=20260722b';
import { initMessageBell }     from '/forge/js/message-bell.js?v=20260809a';
import * as liquidity          from './bot-liquidity.js?v=20260808b';
import * as lending            from './bot-lending.js?v=20260807a';

// ── Hash → Service-ID ─────────────────────────────────────────────────────────
const HASH_TO_SVC = {
    liquidity: 'forge-liquiditybot',
    lending:  'forge-lendingbot',
    nexus:    'forge-nexus',
};

// ── Service-ID → Nav-Item-ID (für initNav) ────────────────────────────────────
const SVC_TO_NAV_ID = {
    'forge-liquiditybot': 'settings-liquidity',
    'forge-lendingbot':  'settings-lending',
    'forge-nexus':       'settings',
};

// ── Bot-Module: welche Bots haben ein erweitertes Panel ───────────────────────
const RICH_BOTS = {
    'forge-liquiditybot': liquidity,
    'forge-lendingbot': lending,
};

// ── Bot-Namen (kurz für Header, lang für Footer) ──────────────────────────────
const SHORT_NAME = {
    'forge-liquiditybot': 'Liquidity',
    'forge-lendingbot':  'Lending',
    'forge-nexus':       'Nexus',
};
const FULL_NAME = {
    'forge-liquiditybot': 'Liquidity Bot',
    'forge-lendingbot':  'LendingBot',
    'forge-nexus':       'Nexus',
};

// Aktiven Bot aus URL-Hash bestimmen (Standard: Liquidity Bot)
const hash      = location.hash.slice(1);
const activeSvc = HASH_TO_SVC[hash] || 'forge-liquiditybot';

initNav({ current: SVC_TO_NAV_ID[activeSvc] || 'settings' });

// Header-Titel: "Settings: Liquidity" (Kurzform)
const _h1 = document.querySelector('.header-logo h1');
if (_h1) _h1.textContent = `Settings: ${SHORT_NAME[activeSvc] ?? activeSvc}`;

// Footer: "Settings: Liquidity Bot" (Langform) + Version
initFooter({ botName: `Settings: ${FULL_NAME[activeSvc] ?? activeSvc}` });

// Brief-Icon → Message Center. Settings ist immer LAN-only (Port 3200) → requireLan:false.
initMessageBell({ requireLan: false });

let botStatuses  = {};
let botCapital   = {};
let activeModule = null;

// ── Letztes Update ────────────────────────────────────────────────────────────
// Farbe folgt dem Service-Status des aktiven Tabs (botStatuses, siehe loadBots())
// – dieselbe Bedeutung wie im Dashboard (grün = läuft), nur dass Settings den
// systemd-Status statt der Datenfrische aus data.json als Signal nimmt (Settings
// hat kein bot-eigenes data.json zur Hand, der Status-Endpoint aber schon).
function updateTimestamp() {
    const el = document.getElementById('lastUpdate');
    if (!el) return;
    const now = new Date();
    const hh  = String(now.getHours()).padStart(2, '0');
    const mm  = String(now.getMinutes()).padStart(2, '0');
    el.textContent = `Letztes Update: ${hh}:${mm} Uhr`;

    const status = botStatuses[activeSvc];
    const cls = status === 'active' ? 'online' : status ? 'offline' : '';
    el.className = `last-update${cls ? ' ' + cls : ''}`;
}

// ── Kontext-Objekt für Bot-Module ─────────────────────────────────────────────
function makeContext(svcId) {
    return {
        getStatus:     (id) => botStatuses[id ?? svcId],
        getHasCapital: (id) => botCapital[id ?? svcId] ?? false,
        showToast,
        refreshStatus: () => loadBots(),
    };
}

// ── Bot-Panel mounten ─────────────────────────────────────────────────────────
function mountBot(svcId) {
    const panel = document.getElementById('botTabPanel');
    panel.innerHTML = '';

    const mod = RICH_BOTS[svcId];
    if (mod) {
        mod.mount(panel, makeContext(svcId));
        activeModule = mod;
    } else {
        renderSimplePanel(panel, svcId);
    }
}

// ── Standard-Panel (für einfache Bots: Nexus, LendingBot) ────────
function renderSimplePanel(panel, svcId) {
    const status = botStatuses[svcId] || 'loading';
    panel.innerHTML = `
        <div class="settings-card">
            <div class="settings-row">
                <span class="settings-label">Status</span>
                <span class="status-badge ${_badgeClass(status)}" id="simple-badge-${svcId}">${status}</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Service</span>
                <div class="bot-actions">
                    <button class="btn btn-start"   data-action="start">▶ Start</button>
                    <button class="btn btn-stop"    data-action="stop">■ Stop</button>
                    <button class="btn btn-restart" data-action="restart">↺ Restart</button>
                </div>
            </div>
            <div class="task-status" id="simple-task-${svcId}"></div>
        </div>`;

    panel.querySelectorAll('.btn[data-action]').forEach(btn => {
        btn.addEventListener('click', () => triggerSimpleAction(svcId, btn.dataset.action, panel));
    });
}

function _badgeClass(s) {
    return s === 'active' ? 'active' : s === 'inactive' ? 'inactive' : s === 'loading' ? 'loading' : 'unknown';
}

// ── Einfache Aktion (für Standard-Panel) ─────────────────────────────────────
async function triggerSimpleAction(svc, action, panel) {
    const taskEl  = panel.querySelector(`#simple-task-${svc}`);
    const buttons = panel.querySelectorAll('.btn[data-action]');

    buttons.forEach(b => b.disabled = true);
    if (taskEl) { taskEl.textContent = `${action}…`; taskEl.className = 'task-status running'; }

    try {
        const res = await fetch(`/api/bots/${svc}/${action}`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const { taskId } = await res.json();
        await pollTask(taskId, svc, action, taskEl);
    } catch (err) {
        if (taskEl) { taskEl.textContent = `Fehler: ${err.message}`; taskEl.className = 'task-status failed'; }
        showToast(`${svc}: ${err.message}`, 'error');
    } finally {
        buttons.forEach(b => b.disabled = false);
        setTimeout(loadBots, 1500);
    }
}

// ── Task-Polling ──────────────────────────────────────────────────────────────
async function pollTask(taskId, svc, action, taskEl) {
    for (let i = 0; i < 30; i++) {
        await sleep(1000);
        try {
            const res = await fetch(`/api/bots/tasks/${taskId}`);
            if (!res.ok) continue;
            const task = await res.json();
            if (task.status === 'done') {
                if (taskEl) { taskEl.textContent = `✅ ${action} erfolgreich`; taskEl.className = 'task-status done'; }
                showToast(`${svc}: ${action} OK`, 'success');
                return;
            }
            if (task.status === 'failed') {
                const msg = task.error ?? 'Unbekannter Fehler';
                if (taskEl) { taskEl.textContent = `❌ ${msg}`; taskEl.className = 'task-status failed'; }
                showToast(`${svc}: ${msg}`, 'error');
                return;
            }
            if (taskEl) { taskEl.textContent = `${task.status}…`; }
        } catch { /* ignorieren */ }
    }
    if (taskEl) { taskEl.textContent = 'Timeout – kein Ergebnis'; taskEl.className = 'task-status failed'; }
}

// ── Bot-Status laden (alle 30s) ───────────────────────────────────────────────
async function loadBots() {
    try {
        const res = await fetch('/api/bots');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bots = await res.json();
        for (const bot of bots) {
            botStatuses[bot.id] = bot.status;
            botCapital[bot.id]  = bot.hasCapital ?? false;
        }
        updateTimestamp();
    } catch { /* Statuses unverändert lassen */ }

    const status = botStatuses[activeSvc];

    if (activeModule?.updateStatus) {
        activeModule.updateStatus(status);
    } else {
        const badge = document.getElementById(`simple-badge-${activeSvc}`);
        if (badge) {
            badge.textContent = status ?? 'unknown';
            badge.className   = 'status-badge ' + _badgeClass(status ?? 'unknown');
        }
    }
}

// ── Helper ────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Forge Tooltip (identisch zu SGB) ─────────────────────────────────────────
function initForgeTooltip() {
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

// ── Init ──────────────────────────────────────────────────────────────────────
mountBot(activeSvc);
loadBots();
setInterval(loadBots, 30_000);
initForgeTooltip();

// Hash-Wechsel (z.B. #liquidity → #lending) erfordert Seiten-Reload,
// da activeSvc beim Modul-Load einmalig bestimmt wird.
window.addEventListener('hashchange', () => location.reload());
