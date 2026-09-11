/**
 * ForgeSettings – LMBot (LiquidityMiningBot3) Panel
 *
 * Wird von settings.js gemountet wenn der "LMBot"-Tab aktiv ist.
 *
 * API:
 *   mount(container, ctx)  – rendert L2-Tabs + Inhalt
 *   unmount()              – räumt auf (Intervalle, Event-Listener)
 *   updateStatus(status)   – aktualisiert den Status-Badge (von settings.js-Refresh aufgerufen)
 */

import { showModal, closeModal, getModal } from '/forge/js/modal.js?v=20260731a';
import { buildWalletDetailHtml } from '/forge/js/wallet-detail-modal.js?v=20260807a';
import { fetchScamTokens, buildScamTabHtml, wireScamTab, scamInfoIconHtml, scamManageBadgeHtml } from '/forge/js/scam-tab.js?v=20260823d';

// 🔒 Keine nativen Browser-Dialoge (alert/confirm/prompt) – im ganzen Projekt nicht.
// Meldungen laufen über das Modal-System (html/js/modal.js). `pre-line` erhält die
// Zeilenumbrüche mehrzeiliger Meldungen (z.B. die Liste der Verwendungsstellen).
function infoModal(message) {
    const id = 'ab-info';
    showModal({
        id,
        title: tr('common.note', 'Hinweis'),
        body: `<p style="margin:0;font-size:.88rem;line-height:1.55;white-space:pre-line">${
            String(message ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        }</p>`,
        actions: [{ label: tr('common.close', 'Schließen'), onClick: () => closeModal(id) }],
    });
}

// `t` ist in diesem Modul mehrfach ein lokaler Variablenname (Token/Timestamp) —
// der Helfer wird deshalb als `tr` importiert (bin/i18n-check.js kennt beide).
import { t as tr, NUM_LOCALE } from '/forge/js/i18n.js?v=20260811a';

// ── Konstanten ─────────────────────────────────────────────────────────────────
const SVC_ID = 'forge-liquiditybot';

// Dieselben Schwellen wie core/wallet-monitor/monitor.js (SOL_LOW_THRESHOLD /
// PREMIUM_SOL_LOW_THRESHOLD) — hier nur für die Ampel-Farbe in der Wallet-Box,
// nicht für den Alert selbst. Bei Änderung dort auch hier nachziehen.
const SOL_LOW_THRESHOLD_LIQUIDITY = 0.1;
const SOL_LOW_THRESHOLD_PREMIUM   = 0.001;

// ── Modul-State ────────────────────────────────────────────────────────────────
let _container        = null;
let _ctx              = {};
let _selectedSendAddr = null;  // { id, name, address } | null
let _visibilityHandler = null;
let _lastKnownStatus  = null;  // letzter Bot-Status, für Pools-Karte-Re-Render nur bei Wechsel
let _presetPoolId     = null;  // Deep-Link-Pool aus dem URL-Hash (LIQ#000533), nur beim ersten Laden wirksam

// ── Öffentliche API ────────────────────────────────────────────────────────────

export function mount(container, ctx = {}) {
    _container    = container;
    _ctx          = ctx;
    _presetPoolId = ctx.presetPoolId ? decodeURIComponent(ctx.presetPoolId) : null;
    _render();

    // Pool-Liste beim Zurückwechseln in den Tab automatisch aktualisieren
    _visibilityHandler = () => {
        if (document.visibilityState !== 'visible' || !_container) return;
        const poolsEl = _container.querySelector('.liquiditybot-grid-pools');
        if (poolsEl) _renderPools(poolsEl);
    };
    document.addEventListener('visibilitychange', _visibilityHandler);

    // Footer-Version befüllen
    fetch('/api/version')
        .then(r => r.json())
        .then(({ version }) => {
            const el = document.getElementById('footerVersion');
            if (el) el.textContent = `v${version}`;
        })
        .catch(() => {});
}

export function unmount() {
    if (_visibilityHandler) {
        document.removeEventListener('visibilitychange', _visibilityHandler);
        _visibilityHandler = null;
    }
    _container = null;
    _ctx       = {};
}

/** Wird von settings.js aufgerufen, wenn der 30s-Auto-Refresh neue Daten hat. */
export function updateStatus(status) {
    _applyStatus(status);
}

// ── Internes Rendering ─────────────────────────────────────────────────────────

function _render() {
    if (!_container) return;
    _container.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'liquiditybot-panel-grid';
    _container.appendChild(grid);

    const serviceEl = document.createElement('div');
    serviceEl.className = 'liquiditybot-grid-service';
    grid.appendChild(serviceEl);

    const walletEl = document.createElement('div');
    walletEl.className = 'liquiditybot-grid-wallet';
    grid.appendChild(walletEl);

    const poolsEl = document.createElement('div');
    poolsEl.className = 'liquiditybot-grid-pools';
    grid.appendChild(poolsEl);

    _renderService(serviceEl);
    _renderWallet(walletEl);
    _renderPools(poolsEl);
}

// ── Premium-Service (Status/Guthaben laden, Verwalten-Modal aus der Liquidity-
// Bot-Karte heraus) ───────────────────────────────────────────────────────────

async function _fetchPremiumStatus() {
    const res = await fetch('/api/premium/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function _premiumBalanceWarning(status) {
    const { remainingHours, lowBalanceWarnHours, lowBalanceCriticalHours } = status;
    if (remainingHours == null) return null;
    if (remainingHours <= (lowBalanceCriticalHours ?? 0)) {
        return { level: 'critical', icon: '🔴', text: tr('sliq.balance_critical', 'Kritisch: Guthaben reicht noch ~{hours}h – bitte zeitnah aufladen.', { hours: remainingHours.toFixed(1) }) };
    }
    if (remainingHours <= (lowBalanceWarnHours ?? 0)) {
        return { level: 'warn', icon: '🟡', text: tr('sliq.balance_low', 'Guthaben wird knapp: reicht noch ~{hours}h.', { hours: remainingHours.toFixed(1) }) };
    }
    return null;
}

function _formatPremiumEndDate(remainingHours) {
    if (remainingHours == null) return 'no data';
    const end = new Date(Date.now() + remainingHours * 3600 * 1000);
    const date = end.toLocaleDateString(NUM_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = end.toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' });
    return tr('sliq.premium_until_fmt', '{date} / {time} Uhr', { date, time });
}

function _premiumTabPanelHtml(status) {
    if (!status.walletConfigured) {
        return `
            <p class="modal-hint" style="margin:0;">
                ${tr('sliq.no_premium_wallet', 'Kein Premium-Wallet konfiguriert. Wird bei der Installation automatisch angelegt (bin/install.sh) — bei einer bestehenden Installation ggf. neu installieren.')}
            </p>`;
    }

    const warning = _premiumBalanceWarning(status);
    const untilText = _formatPremiumEndDate(status.remainingHours);
    const priceText = status.priceUsdcPerHour != null ? `${status.priceUsdcPerHour} USDC/h` : 'no data';
    const disableBtns = !status.activated || !status.pricingKnown;
    const disableReason = !status.activated ? tr('sliq.no_token', 'Kein Aktivierungs-Token vorhanden.') : tr('sliq.no_pricing', 'Preisliste noch nicht bekannt.');

    return `
        <div style="display:grid;grid-template-columns:auto 1fr;gap:0.3rem 1rem;font-size:0.85rem;margin-bottom:0.8rem">
            <span style="color:var(--text-muted)">${tr('sliq.current_status', 'Aktueller Status')}</span>
            <span>${status.enabled ? tr('sliq.premium_on', 'Premium Service aktiviert') : tr('sliq.premium_off', 'Premium Service deaktiviert')}</span>
            <span style="color:var(--text-muted)">${tr('sliq.sol_balance', 'SOL Guthaben')}</span>
            <span>${status.solBalance != null ? status.solBalance.toFixed(4) : 'no data'} SOL</span>
            <span style="color:var(--text-muted)">${tr('sliq.usdc_balance', 'USDC Guthaben')}</span>
            <span>${status.usdcBalance != null ? status.usdcBalance.toFixed(2) : 'no data'} USDC</span>
            <span style="color:var(--text-muted)">${tr('sliq.cost_per_hour', 'Kosten pro Stunde')}</span>
            <span>${_esc(priceText)}</span>
            <span style="color:var(--text-muted)">${tr('sliq.lasts_until', 'Reicht bis zum')}</span>
            <span>${_esc(untilText)}</span>
        </div>
        ${warning ? `
            <div style="margin-bottom:0.8rem;padding:0.4rem 0.6rem;border-radius:6px;font-size:0.82rem;
                        background:${warning.level === 'critical' ? 'rgba(239,68,68,0.1)' : 'rgba(234,179,8,0.1)'}">
                ${warning.icon} ${_esc(warning.text)}
            </div>` : ''}
        <div class="bot-actions">
            <button class="btn btn-secondary btn-uniform" id="premium-btn-enable"
                ${disableBtns || status.enabled ? 'disabled' : ''}
                ${disableBtns ? `data-tooltip-title="${tr('sliq.not_possible_yet', 'Noch nicht möglich')}" data-tooltip-content="${_esc(disableReason)}"` : ''}>
                ${tr('sb.activate', 'Aktivieren')}
            </button>
            <button class="btn btn-secondary btn-uniform" id="premium-btn-disable"
                ${disableBtns || !status.enabled ? 'disabled' : ''}
                ${disableBtns ? `data-tooltip-title="${tr('sliq.not_possible_yet', 'Noch nicht möglich')}" data-tooltip-content="${_esc(disableReason)}"` : ''}>
                ${tr('sb.deactivate', 'Deaktivieren')}
            </button>
        </div>
        <p style="margin:0.5rem 0 0;font-size:0.78rem;color:var(--text-muted);">
            ${tr('sliq.premium_requirements', 'Voraussetzung: die aktuelle Version von FORGE public. Bei einer veralteten Version wird der Premium Service automatisch deaktiviert. Wird der Liquidity Bot manuell gestoppt, wird die automatische Zahlung mit deaktiviert (Premium liefert Daten speziell für diesen Bot).')}
        </p>
        <div class="modal-feedback" id="premium-modal-feedback"></div>`;
}

function _premiumExplainerHtml() {
    return `
        <p style="margin:0 0 0.6rem;">
            ${tr('sliq.premium_explain_1', 'Der Premium-Service verbindet diesen Bot mit dem FORGE-public-Datendienst: automatisch geprüfte neue Pool-Angebote (Adresse, Token, Fee-Tier gegen die Chain verifiziert), laufendes Marktscoring/Scanner-Daten für die Poolbewertung sowie priorisierter Support-Kontakt.')}
        </p>
        <p style="margin:0 0 0.6rem;color:var(--text-muted);">
            ${tr('sliq.premium_explain_2', 'Die Kosten werden stündlich automatisch aus dem hier hinterlegten Premium-Wallet beglichen (getrennt vom Bot-Kapital) — solange Guthaben reicht und der Service unten aktiviert ist.')}
        </p>
        <p style="margin:0;color:var(--text-muted);">
            ${tr('sliq.premium_explain_3', 'Dieser Premium-Service ist speziell auf den Liquidity Bot zugeschnitten und wird unabhängig von anderen Bots verwaltet und bezahlt.')}
        </p>`;
}

async function _openPremiumModal() {
    const mid = 'liquiditybot-premium-modal';
    let status;
    try {
        status = await _fetchPremiumStatus();
    } catch (err) {
        _ctx.showToast?.(tr('sliq.premium_status_failed', 'Premium-Status nicht ladbar: {error}', { error: err.message }), 'error');
        return;
    }
    if (!status.available) return; // Master, oder Fork ohne Premium-Wallet

    showModal({
        id: mid,
        title: tr('sliq.manage_premium', 'Premium Service verwalten'),
        body: `
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-wm="settings">${tr('sliq.settings_tab', 'Einstellungen')}</button>
                <button class="wm-tab" data-wm="explain">${tr('sliq.explain_tab', 'Erklärung')}</button>
            </div>
            <div id="premium-tab-settings" style="min-height:220px;">${_premiumTabPanelHtml(status)}</div>
            <div id="premium-tab-explain" style="min-height:220px;font-size:0.85rem;" hidden>${_premiumExplainerHtml()}</div>`,
        actions: [
            { label: tr('common.close', 'Schließen'), onClick: () => closeModal(mid) },
        ],
    });

    const backdrop = getModal(mid);
    if (!backdrop) return;

    backdrop.querySelectorAll('.wm-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            backdrop.querySelectorAll('.wm-tab').forEach(b => b.classList.toggle('active', b === btn));
            backdrop.querySelector('#premium-tab-settings').hidden = btn.dataset.wm !== 'settings';
            backdrop.querySelector('#premium-tab-explain').hidden  = btn.dataset.wm !== 'explain';
        });
    });

    const wireToggle = (btnId, endpoint) => {
        backdrop.querySelector(`#${btnId}`)?.addEventListener('click', async () => {
            const btn = backdrop.querySelector(`#${btnId}`);
            const fb  = backdrop.querySelector('#premium-modal-feedback');
            btn.disabled = true;
            if (fb) { fb.textContent = tr('sliq.please_wait', 'Bitte warten…'); fb.className = 'modal-feedback'; }
            try {
                const res  = await fetch(endpoint, { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
                if (data.enabled && data.immediatePayment) {
                    // /enable stößt die erste Zahlung sofort an, statt bis zur nächsten
                    // vollen Stunde zu warten (siehe bots/settings/routes/premium.js) —
                    // ok:false ist hier meist harmlos (Stunde bereits per Cron bezahlt),
                    // deshalb 'info' statt 'error'.
                    _ctx.showToast?.(
                        data.immediatePayment.ok
                            ? tr('sliq.premium_on_first_payment', 'Premium Service aktiviert – erste Zahlung gesendet, Daten sind in Kürze aktuell')
                            : tr('sliq.premium_on_note', 'Premium Service aktiviert. Hinweis zur ersten Zahlung: {error}', { error: data.immediatePayment.error }),
                        data.immediatePayment.ok ? 'success' : 'info'
                    );
                } else {
                    _ctx.showToast?.(data.enabled ? tr('sliq.premium_on', 'Premium Service aktiviert') : tr('sliq.premium_off', 'Premium Service deaktiviert'), 'success');
                }
                await _refreshPremiumBadge();
                await _openPremiumModal(); // Modal mit frischem Status neu aufbauen
            } catch (err) {
                if (fb) { fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb.className = 'modal-feedback error'; }
                btn.disabled = false;
            }
        });
    };
    wireToggle('premium-btn-enable',  '/api/premium/enable');
    wireToggle('premium-btn-disable', '/api/premium/disable');
}

async function _refreshPremiumBadge() {
    const text = _container?.querySelector('#liquiditybot-premium-text');
    if (!text) return;
    try {
        const status = await _fetchPremiumStatus();
        if (!status.available) { text.closest('tr')?.style.setProperty('display', 'none'); return; }
        text.innerHTML   = status.enabled ? tr('sliq.badge_active', '&#10003; Aktiv') : tr('sliq.badge_inactive', '&#9888; Inaktiv');
        text.className   = 'key-status ' + (status.enabled ? 'set' : 'unset');
    } catch { /* Text bleibt wie zuletzt bekannt */ }
}

// Die frühere Karte „Neue Pool-Angebote" stand hier (entfernt 2026-08-21).
// Angebote des Premium-Datendienstes werden nicht mehr zur Ansicht gestellt und per
// Klick übernommen, sondern automatisch importiert — bots/liquidity/bin/pool-offers-sync.js,
// Begründung im Kopf von bots/liquidity/lib/pool-offer-adopt.js. Der Nutzer erfährt
// davon über das Message Center; neue Pools erscheinen direkt in der Pool-Liste oben.

// ── Service-Karte (inkl. Cleanup) ─────────────────────────────────────────────

async function _renderService(el) {
    const card = document.createElement('div');
    card.className = 'settings-card';
    card.innerHTML = `
        <div class="settings-card-header">
            <span class="sch-title">${tr('nav.liquidity', 'Liquidity Bot')}</span>
        </div>
        <table class="wallet-action-table">
            <tbody>
                <tr>
                    <td class="wat-label">${tr('set.status', 'Status')}</td>
                    <td class="wat-info">
                        <span class="key-status" id="liquiditybot-status-text">${tr('sb.loading_short', 'laden…')}</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="liquiditybot-btn-status-manage">${tr('sb.manage', 'Verwalten')}</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label">${tr('sliq.premium_badge', 'Premium &#128296;')}</td>
                    <td class="wat-info">
                        <span class="key-status" id="liquiditybot-premium-text">${tr('sb.loading_short', 'laden…')}</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="liquiditybot-btn-premium">${tr('sb.manage', 'Verwalten')}</button>
                    </td>
                </tr>
            </tbody>
        </table>
        <div id="liquiditybot-strategy-wrap"></div>
        <div id="liquiditybot-cleanup-wrap"></div>`;
    el.appendChild(card);

    const cachedStatus = _ctx.getStatus?.(SVC_ID);
    if (cachedStatus) _applyStatus(cachedStatus);
    _refreshPremiumBadge();

    card.querySelector('#liquiditybot-btn-status-manage')?.addEventListener('click', () => _openBotControlModal());
    card.querySelector('#liquiditybot-btn-premium')?.addEventListener('click', () => _openPremiumModal());

    // Strategie (LIQ#0372): globale Einstellung (strategy_state hat CHECK (id = 1)) — gehört
    // hier zu Status/Cleanup, nicht in die Pool-Box, die nur pool-individuelle Zeilen zeigt.
    // Reihenfolge Status → Strategie → Cleanup (LIQ#0379, Punkt 1).
    const strategyWrap = card.querySelector('#liquiditybot-strategy-wrap');
    try {
        if (strategyWrap) await _loadAndRenderStrategyRow(strategyWrap);
    } catch { /* Strategie-Backend nicht verfügbar */ }

    const cleanupWrap = card.querySelector('#liquiditybot-cleanup-wrap');
    try {
        if (cleanupWrap) await _loadAndRenderCleanupRow(cleanupWrap);
    } catch { /* Config nicht verfügbar */ }
}

function _openBotControlModal() {
    const mid = 'liquiditybot-control-modal';
    showModal({
        id: mid,
        title: tr('sliq.manage_bot', 'Liquidity Bot verwalten'),
        body: `
            <div class="bcm-row">
                <button class="btn btn-secondary btn-uniform" id="liquiditybot-btn-start">${tr('sb.start_btn', '&#9654; Start')}</button>
                <span class="bcm-hint">${tr('sb.start_hint', 'Startet den Bot, falls er aktuell gestoppt ist.')}</span>
            </div>
            <div class="bcm-row">
                <button class="btn btn-secondary btn-uniform" id="liquiditybot-btn-stop">${tr('sb.stop_btn', '&#9632; Stop')}</button>
                <span class="bcm-hint">${tr('sb.stop_hint', 'Stoppt den Bot vollständig. Bei investiertem Kapital (offener Position) gesperrt — erst auszahlen.')}</span>
            </div>
            <div class="bcm-row">
                <button class="btn btn-secondary btn-uniform" id="liquiditybot-btn-restart">${tr('sb.restart_btn', '&#8635; Restart')}</button>
                <span class="bcm-hint">${tr('sb.restart_hint', 'Stoppt und startet den Bot neu, z.&nbsp;B. nach einer Konfigurationsänderung.')}</span>
            </div>
            <div class="task-status" id="liquiditybot-task-status"></div>`,
        actions: [
            { label: tr('common.close', 'Schließen'), onClick: () => closeModal(mid) },
        ],
    });

    const cachedStatus = _ctx.getStatus?.(SVC_ID);
    if (cachedStatus) _applyButtonStates(cachedStatus);

    document.getElementById('liquiditybot-btn-start')  ?.addEventListener('click', () => _doAction('start'));
    document.getElementById('liquiditybot-btn-stop')   ?.addEventListener('click', () => _doAction('stop'));
    document.getElementById('liquiditybot-btn-restart')?.addEventListener('click', () => _doAction('restart'));
}

// ── Cleanup-Abschnitt ────────────────────────────────────────────────────────

function _parseCleanupMode(cfg) {
    if (cfg.CLEANUP_MODE) return cfg.CLEANUP_MODE;
    return cfg.CLEANUP_ENABLED === 'false' ? 'disabled' : 'ranking';
}

/**
 * Trend-Gate: Komma-Liste geforderter Zeitebenen (CLEANUP_TREND_GATE), leer = aus.
 * Spiegelt parseTrendGate() aus bots/liquidity/lib/trend-indicators.js — dort steht
 * die Bedeutung, hier nur die Anzeige. Reihenfolge immer kurz → lang.
 */
const TREND_TIMEFRAMES = ['1h', '4h', '1d'];
function _parseTrendGate(raw) {
    const wanted = new Set(String(raw ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
    return TREND_TIMEFRAMES.filter(tf => wanted.has(tf));
}

function _parseCleanupCfg(cfg) {
    const mode       = _parseCleanupMode(cfg);
    const trendGate  = _parseTrendGate(cfg.CLEANUP_TREND_GATE);
    const minScore   = Math.max(0, Math.min(100, parseInt(cfg.CLEANUP_MIN_SCORE ?? '65', 10) || 65));
    const maxDeposit = (() => {
        const v = parseFloat(cfg.CLEANUP_MAX_DEPOSIT ?? '0');
        return v >= 10 ? v : 0;
    })();
    const minDeposit = (() => {
        const v = parseFloat(cfg.CLEANUP_MIN_DEPOSIT ?? '0');
        return v >= 1 ? v : 0;
    })();
    const dustEnabled = cfg.CLEANUP_DUST_ENABLED !== 'false';
    const dustMin = (() => {
        const v = parseFloat(cfg.CLEANUP_DUST_MIN_USDC ?? '0.01');
        return v >= 0 ? v : 0.01;
    })();
    const dustMax = (() => {
        const v = parseFloat(cfg.CLEANUP_DUST_MAX_USDC ?? '25');
        return v > 0 ? v : 25;
    })();
    return { mode, minScore, maxDeposit, minDeposit, dustEnabled, dustMin, dustMax, trendGate };
}

async function _loadAndRenderCleanupRow(wrap) {
    const [cfgRes, poolsRes] = await Promise.all([
        fetch('/api/config/liquiditybot'),
        fetch(`/api/pools/liquidity?t=${Date.now()}`),
    ]);
    if (!cfgRes.ok) throw new Error(tr('sliq.config_unavailable', 'Config nicht verfügbar'));
    const cfg   = await cfgRes.json();
    const pools = poolsRes.ok ? await poolsRes.json() : [];
    const parsed = _parseCleanupCfg(cfg);
    // scoreSource ist pro Pool identisch (globaler Feed-Status) – 'none' = Premium
    // nicht gebucht, InvestScore/Ranking-Modus nicht verfügbar (siehe Dashboard-
    // Opportunity-Tabelle, gleiches Signal).
    const premiumLocked = pools.length > 0 && pools[0].scoreSource === 'none';

    // Gleiches Tabellen-Layout wie Status/Premium darüber (wallet-action-table) –
    // Kurzbeschreibung des aktuellen Modus statt der früheren drei Buttons, Verwalten
    // rechtsbündig über .wat-action.
    // LIQ#0379, Punkt 4 (revidiert): kein Geltungsbereichs-Text mehr — unverständlich ohne
    // Kontext. Stattdessen wat-muted: ausgegraut als Signal "läuft unverändert weiter,
    // Zusammenspiel mit Strategie ist noch nicht fertig gebaut", nicht als "deaktiviert".
    const botInactive = _ctx.getStatus?.(SVC_ID) !== 'active';
    wrap.innerHTML = `
        <table class="wallet-action-table">
            <tbody>
                <tr>
                    <td class="wat-label">${tr('sliq.cleanup', 'Cleanup')}</td>
                    <td class="wat-info wat-muted">${_esc(_cleanupModeSummary(parsed, pools))}</td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="sys-cleanup-manage-btn" ${botInactive ? 'disabled' : ''}>${tr('sb.manage', 'Verwalten')}</button>
                    </td>
                </tr>
            </tbody>
        </table>`;

    // Frische Pools nachladen (Score/active kann sich seit dem letzten Render geändert
    // haben), bevor das Modal aufgeht – Fallback auf den bereits geladenen Stand.
    wrap.querySelector('#sys-cleanup-manage-btn')?.addEventListener('click', async () => {
        try {
            const res = await fetch(`/api/pools/liquidity?t=${Date.now()}`);
            const freshPools  = res.ok ? await res.json() : pools;
            const freshLocked = freshPools.length > 0 && freshPools[0].scoreSource === 'none';
            _openCleanupModal(wrap, parsed, freshPools, freshLocked);
        } catch {
            _openCleanupModal(wrap, parsed, pools, premiumLocked);
        }
    });
}

// Kurzfassung des aktuellen Cleanup-Modus für die Zeilen-Vorschau (statt der
// früheren drei Buttons Manuell/Bester Pool/Dust).
function _cleanupModeSummary(parsed, pools) {
    const { mode, minScore, dustEnabled, trendGate } = parsed;
    let base;
    if (mode === 'ranking') {
        base = tr('sliq.cleanup_best_summary', 'Bester Pool · Score ≥ {score}', { score: minScore });
    } else if (mode === 'disabled') {
        base = tr('sb.disabled', 'Deaktiviert');
    } else if (mode?.startsWith('pool:')) {
        const id = mode.slice('pool:'.length);
        const p  = pools.find(pp => String(pp.id) === id);
        base = tr('sliq.cleanup_manual_summary', 'Manuell: {pool}', { pool: p ? (p.displayPair ?? p.pair) : tr('sliq.selected_pool', 'gewählter Pool') });
    } else {
        base = tr('sb.status_unknown', 'Unbekannt');
    }
    const trendPart = (mode === 'ranking' && trendGate?.length)
        ? ` · ${tr('sliq.trend_gate_short', 'Trend')} ${trendGate.map(_trendTfLabel).join('+')}`
        : '';
    return `${base}${trendPart} · ${tr('sliq.dust', 'Dust')} ${dustEnabled ? tr('sliq.dust_on', 'aktiv') : tr('sliq.dust_off', 'aus')}`;
}

// Kurzbeschreibung je Tab: sichtbares Kurzlabel + Icon mit ausführlichem
// Text im Tooltip (Platz sparen, siehe Feature-Anforderung 2026-07-27).
function _cuDescHtml(shortLabel, tooltipTitle, tooltipContent) {
    return `<div class="cu-panel-desc">
        <span class="info-tip-label" data-tooltip-title="${_esc(tooltipTitle)}" data-tooltip-content="${_esc(tooltipContent)}">&#9432;</span>
        ${_esc(shortLabel)}
    </div>`;
}

// ── Cleanup-Modal: drei Reiter (Manuell / Bester Pool / Dust) ────────────────
function _openCleanupModal(wrap, cfgParsed, pools, premiumLocked) {
    const mid = 'liquiditybot-cleanup-modal';

    showModal({
        id:    mid,
        // Der Countdown steht im Titel statt dreimal in den Reitern: das Modal war auf
        // einem Notebook sonst nicht mehr ohne Scrollen darstellbar (23.08.2026).
        title: `${tr('sliq.manage_cleanup', 'Cleanup verwalten')}${_cleanupTitleSuffix(cfgParsed.mode)}`,
        body:  `
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-wm="manuell">${tr('sliq.manual', 'Manuell')}</button>
                <button class="wm-tab" data-wm="bester">${tr('sb.best_pool', 'Bester Pool')}</button>
                <button class="wm-tab" data-wm="dust">${tr('sliq.dust', 'Dust')}</button>
            </div>
            <div id="cu-tab-manuell">${_manuellTabHtml(cfgParsed, pools)}</div>
            <div id="cu-tab-bester" hidden>${_besterPoolTabHtml(cfgParsed, pools, premiumLocked)}</div>
            <div id="cu-tab-dust" hidden>${_dustTabHtml(cfgParsed)}</div>`,
        // Rückmeldung („✓ Cleanup gespeichert.") steht links im Modal-Fuß statt als
        // eigene Zeile in jedem Reiter — .forge-modal-footer-note schiebt sie per
        // margin-right:auto nach links, die Knöpfe bleiben rechts.
        footerNote: '<span class="modal-feedback" id="cu-modal-feedback" style="margin-top:0"></span>',
        actions: [
            // „Speichern" liegt im Modal-Fuß vor „Schließen", statt in jedem Reiter
            // eigenständig — spart je Reiter eine Button-Zeile. Es gilt immer dem
            // sichtbaren Reiter; im Reiter „Manuell" gibt es nichts zu speichern
            // (dort ist „Jetzt starten" die Aktion), deshalb wird es dort ausgeblendet.
            { label: tr('msg.save', 'Speichern'), onClick: () => _saveActiveCleanupTab(modalTabId(), mid, wrap) },
            { label: tr('common.close', 'Schließen'), onClick: () => closeModal(mid) },
        ],
    });

    const modalEl = getModal(mid);
    if (!modalEl) return;

    // Trend-Gate ist in diesem Modal nicht mehr editierbar (Opportunity 2.0,
    // s.o.) — der geladene Wert wird hier geparkt, damit _saveBesterPool() ihn beim
    // Speichern unverändert zurückschreibt statt ihn (mangels Checkboxen) auf "aus"
    // zu setzen.
    modalEl.dataset.trendGate = cfgParsed.trendGate?.join(',') ?? '';

    const modalTabId = () => modalEl.querySelector('.wm-tab.active')?.dataset.wm ?? 'manuell';
    const saveBtn    = modalEl.querySelector('.forge-modal-footer .btn');
    if (saveBtn) saveBtn.id = 'cu-modal-save-btn';

    // Sichtbarkeit + Gültigkeitsprüfung des Speichern-Knopfes an den aktiven Reiter
    // binden. Ohne das bliebe eine Sperre aus einem anderen Reiter stehen (z.B. Dust
    // mit Unter- >= Obergrenze), obwohl der sichtbare Reiter gültig ist.
    // Die gemeinsame Rückmeldung wird beim Wechsel geleert: ein „✓ gespeichert" aus
    // dem Dust-Reiter darf nicht über dem Reiter „Bester Pool" stehen bleiben.
    const _syncSaveBtn = () => {
        const fb = modalEl.querySelector('#cu-modal-feedback');
        if (fb) { fb.textContent = ''; fb.className = 'modal-feedback'; }
        if (!saveBtn) return;
        const tab = modalTabId();
        saveBtn.style.display = tab === 'manuell' ? 'none' : '';
        saveBtn.disabled = false;
        modalEl._cuValidate?.[tab]?.();
    };

    // Alle drei Reiter auf die Höhe des höchsten bringen. Ohne das springt das Modal
    // beim Reiterwechsel in der Höhe — die Reiter sind unterschiedlich lang, und seit
    // die Rückmeldungs- und Knopfzeilen aus den Reitern in den Fuß gewandert sind,
    // fällt der Unterschied stärker auf.
    //
    // Gemessen wird, indem alle drei kurz sichtbar geschaltet werden: das läuft
    // synchron in einem Rutsch, der Browser zeichnet zwischendurch nicht.
    const _equalizeTabHeights = () => {
        const tabs = ['#cu-tab-manuell', '#cu-tab-bester', '#cu-tab-dust']
            .map(sel => modalEl.querySelector(sel)).filter(Boolean);
        if (tabs.length < 2) return;
        const wasHidden = tabs.map(t => t.hidden);
        let max = 0;
        tabs.forEach(t => { t.style.minHeight = ''; t.hidden = false; });
        tabs.forEach(t => { max = Math.max(max, t.offsetHeight); });
        tabs.forEach((t, i) => { t.hidden = wasHidden[i]; t.style.minHeight = `${max}px`; });
    };
    // Für _wireBesterPoolTab(): eine eingeblendete Hinweiszeile ändert die Höhe des
    // Reiters, danach müssen die anderen beiden nachziehen.
    modalEl._cuEqualize = _equalizeTabHeights;

    modalEl.querySelectorAll('.wm-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            modalEl.querySelectorAll('.wm-tab').forEach(b => b.classList.toggle('active', b === btn));
            modalEl.querySelector('#cu-tab-manuell').hidden = btn.dataset.wm !== 'manuell';
            modalEl.querySelector('#cu-tab-bester').hidden  = btn.dataset.wm !== 'bester';
            modalEl.querySelector('#cu-tab-dust').hidden    = btn.dataset.wm !== 'dust';
            _syncSaveBtn();
        });
    });

    _wireManuellTab(modalEl, mid, wrap);
    _wireBesterPoolTab(modalEl, mid, wrap, pools);
    _wireDustTab(modalEl, mid, wrap);
    _syncSaveBtn();
    _equalizeTabHeights();
}

/** Speichert den gerade sichtbaren Cleanup-Reiter. */
function _saveActiveCleanupTab(tab, mid, wrap) {
    if (tab === 'bester') return _saveBesterPool(mid, wrap);
    if (tab === 'dust')   return _saveDust(mid, wrap);
}

/**
 * Cleanup-Countdown als Titel-Zusatz (früher `_cleanupHint()` in jedem Reiter).
 * Farbe wie zuvor ab < 10 Minuten warnend — die Aussage steht im Text, nie allein
 * in der Farbe.
 */
function _cleanupTitleSuffix(cleanupMode = 'ranking') {
    if (cleanupMode === 'disabled') return '';
    const min = (65 - new Date().getMinutes()) % 60;
    const text = min === 0
        ? tr('sliq.cleanup_running_now', '⚠ Cleanup läuft gerade.')
        : min === 1
            ? tr('sliq.next_cleanup_one', 'Nächster Cleanup in 1 Minute.')
            : tr('sliq.next_cleanup', 'Nächster Cleanup in {min} Minuten.', { min });
    const style = min < 10 ? 'color:var(--danger);' : 'color:var(--text-muted);';
    return ` <span style="font-weight:400;font-size:0.8rem;${style}">· ${_esc(text)}</span>`;
}

// ── Tab "Manuell": sofort in einen gewählten Pool investieren ───────────────
function _manuellTabHtml(cfgParsed, pools) {
    const { mode } = cfgParsed;
    const sortedPools = pools
        .slice()
        .sort((a, b) => (a.displayPair ?? a.pair).localeCompare(b.displayPair ?? b.pair));

    return `
        ${_cuDescHtml(
            tr('sliq.manual_desc', 'Investiert das Wallet-Guthaben gezielt in einen von dir gewählten Pool.'),
            tr('sliq.manual', 'Manuell'),
            tr('sliq.manual_tip', 'Investiert das gesamte investierbare Wallet-Guthaben einmalig in den hier gewählten Pool – unabhängig vom Opportunity Score. Dieser Pool wird damit zum neuen Cleanup-Ziel, bis du hier oder im Reiter „Bester Pool“ etwas anderes wählst.')
        )}
        <div style="display:flex;gap:0.4rem;margin-bottom:0.4rem;">
            <input type="text" id="cu-manuell-search" placeholder="${tr('liq.search_pool', 'Pool suchen…')}"
                   style="flex:1;min-width:0;box-sizing:border-box;padding:0.3rem 0.5rem;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:5px;font-size:0.875rem">
            <select id="cu-manuell-active-filter"
                    style="flex-shrink:0;box-sizing:border-box;padding:0.3rem 0.5rem;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:5px;font-size:0.875rem">
                <option value="all">${tr('sliq.filter_all', 'Alle')}</option>
                <option value="active">${tr('sliq.filter_active', 'Aktiv')}</option>
                <option value="inactive">${tr('sliq.filter_inactive', 'Inaktiv')}</option>
            </select>
        </div>
        <div id="cu-manuell-list" class="cu-panel-body" style="max-height:14rem;overflow-y:auto;display:flex;flex-direction:column;gap:0.2rem;padding-bottom:0.25rem;">
            ${sortedPools.map(p => `
            <label class="cleanup-radio-option" data-cu-pool="${_esc(p.displayPair ?? p.pair).toLowerCase()}" data-cu-active="${p.active ? '1' : '0'}">
                <input type="radio" name="cleanup-mode-pool" value="pool:${p.id}" ${mode === 'pool:' + p.id ? 'checked' : ''}>
                <span${p.active ? '' : ' style="opacity:0.55;font-style:italic;"'}>Invest in ${_esc(p.displayPair ?? p.pair)}${p.active ? '' : tr('sb.suffix_inactive', ' (inaktiv)')}</span>
            </label>`).join('')}
        </div>
        <div class="bot-actions" style="margin-top:0.6rem;">
            <button class="btn btn-secondary btn-uniform" id="cu-manuell-start-btn">${tr('sliq.start_now', 'Jetzt starten')}</button>
        </div>`;
}

function _wireManuellTab(modalEl, mid, wrap) {
    const searchInput  = modalEl.querySelector('#cu-manuell-search');
    const activeFilter = modalEl.querySelector('#cu-manuell-active-filter');
    const _applyPoolFilter = () => {
        const q      = searchInput?.value.trim().toLowerCase() ?? '';
        const filter = activeFilter?.value ?? 'all';
        modalEl.querySelectorAll('#cu-manuell-list label[data-cu-pool]').forEach(lbl => {
            const matchesQ      = !q || lbl.dataset.cuPool.includes(q);
            const matchesActive = filter === 'all' || (filter === 'active') === (lbl.dataset.cuActive === '1');
            lbl.style.display = (matchesQ && matchesActive) ? '' : 'none';
        });
    };
    searchInput?.addEventListener('input', _applyPoolFilter);
    activeFilter?.addEventListener('change', _applyPoolFilter);

    requestAnimationFrame(() => {
        const checked = modalEl.querySelector('input[name="cleanup-mode-pool"]:checked');
        checked?.closest('label')?.scrollIntoView({ block: 'nearest' });
    });

    modalEl.querySelector('#cu-manuell-start-btn')?.addEventListener('click', () => _runCleanupManuell(mid, wrap));
}

// ── Tab "Bester Pool": Ranking-Modus (oder Deaktiviert) konfigurieren ────────

/**
 * Pools, die gerade im Cleanup-Cooldown eines Risk-Management-Exits (Trailing Stop,
 * TVL-Schutz oder Score-Limit) stecken (siehe bots/liquidity/bin/cleanup.js
 * `_loadCleanupCooldownBlockedPools`), dürfen hier nicht als "aktuell bester Pool"
 * auftauchen — sonst zeigt das Modal einen Kandidaten, den der Bot beim nächsten
 * Lauf tatsächlich überspringt (Befund 2026-08-08: Kapital kurz zuvor per
 * Trailing Stop aus genau diesem Pool abgezogen).
 */
function _cleanupEligiblePools(pools) {
    return pools.filter(p => !p.cleanupCooldownUntil);
}

/**
 * Spiegelt checkTrendGate() aus bots/liquidity/lib/trend-indicators.js: erfüllt ist
 * nur, wer auf JEDER geforderten Zeitebene `up === true` hat. `null` (zu wenig
 * Kursverlauf, veraltete Reihe) zählt wie „nicht erfüllt" — dort sperrt das Gate
 * ebenfalls, weil beim Einzahlen Nichtstun die sichere Richtung ist.
 *
 * Bewusst gegen die gerade angehakten Zeitebenen gerechnet, nicht gegen die
 * gespeicherte Konfiguration: der Betreiber soll beim Setzen eines Hakens sofort
 * sehen, welcher Pool dann gewinnt.
 */
function _trendGatePasses(pool, required) {
    if (!required?.length) return true;
    return required.every(tf => pool?.trendState?.[tf]?.up === true);
}

function _fmtCooldownUntil(ts) {
    return new Date(ts).toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' });
}

function _bestPoolHtml(bestPool, bestScore, bestName, threshold, cooldownSkipped, trendSkipped = null) {
    const trendHint = trendSkipped
        ? `<br><span style="color:var(--text-muted);font-size:0.78rem">${
            trendSkipped.down.length
                ? tr('sliq.trend_skipped', '{pool} hätte Score {score}, hat aber keinen Aufwärtstrend auf {timeframes} und wird übersprungen.',
                     { pool: _esc(trendSkipped.name), score: trendSkipped.score, timeframes: trendSkipped.down.map(_trendTfLabel).join(', ') })
                : tr('sliq.trend_skipped_unknown', '{pool} hätte Score {score}, hat aber noch zu wenig Kursverlauf für {timeframes} und wird übersprungen.',
                     { pool: _esc(trendSkipped.name), score: trendSkipped.score, timeframes: trendSkipped.unknown.map(_trendTfLabel).join(', ') })
          }</span>`
        : '';
    const cooldownHint = cooldownSkipped
        ? `<br><span style="color:var(--text-muted);font-size:0.78rem">${tr('sliq.cooldown_skipped', '{pool} hätte Score {score}, ist aber bis {time} im {reason}-Cooldown und wird übersprungen.', { pool: _esc(cooldownSkipped.name), score: cooldownSkipped.score, time: _fmtCooldownUntil(cooldownSkipped.until), reason: _esc(cooldownSkipped.reason) })}</span>`
        : '';
    if (!bestPool || bestScore == null) {
        // Zwei verschiedene Sachverhalte, zwei verschiedene Sätze: „keine Score-Daten"
        // (Feed/Premium) heißt etwas anderes als „alle Kandidaten sind gefiltert".
        const msg = (trendSkipped || cooldownSkipped)
            ? tr('sliq.no_pool_passes', 'Kein Pool erfüllt die Bedingungen')
            : tr('liq.no_score_data', '— Keine Score-Daten verfügbar');
        return `<span style="color:var(--text-muted)">${msg}</span>${trendHint}${cooldownHint}`;
    }
    const ok    = bestScore >= threshold;
    const color = ok ? 'var(--success)' : 'var(--danger)';
    const icon  = ok ? '✓' : '✗';
    const hint  = ok ? '' : `<br><span style="color:var(--text-muted);font-size:0.78rem">${tr('sliq.min_not_reached', 'Minimum {min} nicht erreicht → kein Investment', { min: threshold })}</span>`;
    return `<span style="color:var(--text)">${bestName}</span> — Score <strong style="color:${color}">${bestScore}</strong> <span style="color:${color}">${icon}</span>${hint}${trendHint}${cooldownHint}`;
}

/**
 * Bester Pool + Info über die evtl. wegen Cooldown oder Trend-Filter übersprungenen
 * Spitzenreiter. `required` sind die gerade angehakten Trend-Zeitebenen.
 */
function _computeBestPool(pools, required = []) {
    const eligible = _cleanupEligiblePools(pools).filter(p => _trendGatePasses(p, required));
    const bestPool  = eligible.slice().sort((a, b) => (b.investScore?.value ?? -Infinity) - (a.investScore?.value ?? -Infinity))[0] ?? null;
    const bestScore = bestPool?.investScore?.value ?? null;
    const bestName  = bestPool ? _esc(bestPool.displayPair ?? bestPool.pair) : null;

    const cooldownTop = pools
        .filter(p => p.cleanupCooldownUntil)
        .slice()
        .sort((a, b) => (b.investScore?.value ?? -Infinity) - (a.investScore?.value ?? -Infinity))[0] ?? null;
    const cooldownSkipped = (cooldownTop && (bestScore == null || (cooldownTop.investScore?.value ?? -Infinity) > bestScore))
        ? { name: cooldownTop.displayPair ?? cooldownTop.pair, score: cooldownTop.investScore?.value ?? '?', until: cooldownTop.cleanupCooldownUntil, reason: cooldownTop.cleanupCooldownReason ?? tr('sliq.risk_management', 'Risk-Management') }
        : null;

    // Höchstbewerteter Pool, den allein der Trend-Filter aussortiert (Cooldown-Pools
    // meldet bereits cooldownSkipped). Ohne diesen Hinweis wäre nicht erkennbar, dass
    // ein Haken gerade den Spitzenreiter kostet — und warum.
    const trendTop = _cleanupEligiblePools(pools)
        .filter(p => !_trendGatePasses(p, required))
        .slice()
        .sort((a, b) => (b.investScore?.value ?? -Infinity) - (a.investScore?.value ?? -Infinity))[0] ?? null;
    const trendSkipped = (trendTop && (bestScore == null || (trendTop.investScore?.value ?? -Infinity) > bestScore))
        ? {
            name:  trendTop.displayPair ?? trendTop.pair,
            score: trendTop.investScore?.value ?? '?',
            // Zeitebenen trennen: „kein Aufwärtstrend" ist ein Urteil, „nicht
            // bestimmbar" (junger Pool) ausdrücklich keines.
            down:    required.filter(tf => trendTop.trendState?.[tf]?.up === false),
            unknown: required.filter(tf => trendTop.trendState?.[tf]?.up == null),
        }
        : null;

    return { bestPool, bestScore, bestName, cooldownSkipped, trendSkipped };
}

/** Kurzlabel einer Trend-Zeitebene für Oberfläche und Zusammenfassung. */
function _trendTfLabel(tf) {
    return { '1h': '1h', '4h': '4h', '1d': '1D' }[tf] ?? tf;
}

// Die editierbaren 1h/4h/1D-Haken ("Positiver Trend") sind seit Opportunity 2.0
// (2026-08-25, KB Liquidity Bot/opportunity-2.0.md) aus diesem Dialog entfernt: der
// EMA-Trend fließt jetzt direkt (typ-dosiert) in den InvestScore ein, sichtbar im
// Score-Modal statt als separater, für Einsteiger verwirrender Filter-Haken hier.
// Der server-seitige Gate (CLEANUP_TREND_GATE/.env) bleibt unverändert aktiv — nur
// nicht mehr über dieses Modal einstellbar. Der aktuell gespeicherte Wert wird beim
// Öffnen in modalEl.dataset.trendGate geparkt und beim Speichern unverändert
// zurückgeschrieben (_saveBesterPool), damit ein Speichern in diesem Reiter den Gate
// nicht versehentlich auf "aus" zurücksetzt.

function _besterPoolTabHtml(cfgParsed, pools, premiumLocked) {
    const desc = _cuDescHtml(
        tr('sliq.best_pool_desc', 'Invest in den Pool mit dem höchsten Opportunity Score.'),
        tr('sb.best_pool', 'Bester Pool'),
        tr('sliq.best_pool_tip', 'Läuft zu jeder vollen Stunde: investiert das Wallet-Guthaben automatisch in den Pool mit dem höchsten Opportunity Score – sofern dieser die Minimum-Score-Schwelle erreicht. Steht nur mit aktiviertem Premium-Service zur Verfügung (Opportunity Score wird zentral berechnet).')
    );

    if (premiumLocked) {
        return `${desc}
            <p class="modal-hint" style="margin:0;">
                ${tr('sliq.premium_only', 'Nur mit aktiviertem Premium-Service verfügbar (Opportunity Score wird zentral berechnet).')}
            </p>`;
    }

    const { mode, minScore, maxDeposit, minDeposit } = cfgParsed;
    // Erstanzeige gegen die gespeicherten Haken; _wireBesterPoolTab() rechnet danach
    // bei jedem Klick neu.
    const trendGate = cfgParsed.trendGate ?? [];
    const { bestPool, bestScore, bestName, cooldownSkipped, trendSkipped } = _computeBestPool(pools, trendGate);

    return `
        ${desc}
        <div class="cu-panel-body" style="display:flex;flex-direction:column;gap:0.6rem">
            <label class="cleanup-radio-option">
                <input type="radio" name="cleanup-mode-ranking" value="ranking" ${mode === 'ranking' ? 'checked' : ''}>
                <span>${tr('sb.best_pool', 'Bester Pool')} <small style="opacity:0.7;">${tr('sliq.best_pool_hint', '— investiert in den Pool mit dem höchsten InvestScore')}</small></span>
            </label>
            <label class="cleanup-radio-option">
                <input type="radio" name="cleanup-mode-ranking" value="disabled" ${mode === 'disabled' ? 'checked' : ''}>
                <span>${tr('sb.disabled', 'Deaktiviert')}</span>
            </label>
            <div style="border-top:1px solid var(--border);padding-top:0.6rem">
                <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;color:var(--text-muted)">${tr('sliq.min_score', 'Minimum-Score (0–100)')}</label>
                <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap">
                    <input type="number" id="cu-bester-min-score" min="0" max="100" value="${minScore}"
                           style="width:80px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                    <span style="font-size:0.76rem;color:var(--text-muted)">${tr('sliq.score_scale_short', '70 = empfohlen')}</span>
                </div>
            </div>
            <div style="border-top:1px solid var(--border);padding-top:0.6rem;display:flex;gap:1rem;">
                <div style="flex:1">
                    <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;color:var(--text-muted)">
                        ${tr('sliq.min_deposit_run', 'Min. Einzahlung/Lauf')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sb.min_deposit', 'Minimale Einzahlung')}"
                            data-tooltip-content="${tr('sliq.min_deposit_tip', 'Cleanup investiert nur wenn mindestens dieser Betrag an investierbarem USDC-Gegenwert im Wallet liegt.||Beispiel: Minimum 10 USDC, im Wallet liegen nur 9 USDC Gegenwert → es passiert nichts.||Leer lassen oder 0 = kein Minimum.')}">&#9432;</span>
                    </label>
                    <div style="display:flex;align-items:center;gap:0.4rem;">
                        <input type="number" id="cu-bester-min-deposit" min="1" max="10000" step="1"
                               value="${minDeposit > 0 ? minDeposit : ''}" placeholder="${tr('sb.no_minimum', 'kein Minimum')}"
                               style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                        <span style="font-size:0.8rem;color:var(--text-muted)">USDC</span>
                    </div>
                </div>
                <div style="flex:1">
                    <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;color:var(--text-muted)">
                        ${tr('sliq.max_deposit_run', 'Max. Einzahlung/Lauf')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sb.max_deposit', 'Maximale Einzahlung')}"
                            data-tooltip-content="${tr('sliq.max_deposit_tip', 'Begrenzt wie viel USDC pro Cleanup-Lauf in den besten Pool investiert werden darf.||Beispiel: 2.350 USDC im Wallet, Limit 500 USDC → pro Lauf werden max. 500 USDC eingezahlt; der Rest bleibt liquide.||Leer lassen oder 0 = kein Limit.')}">&#9432;</span>
                    </label>
                    <div style="display:flex;align-items:center;gap:0.4rem;">
                        <input type="number" id="cu-bester-max-deposit" min="10" max="10000" step="10"
                               value="${maxDeposit > 0 ? maxDeposit : ''}" placeholder="${tr('sb.no_limit', 'kein Limit')}"
                               style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                        <span style="font-size:0.8rem;color:var(--text-muted)">USDC</span>
                    </div>
                </div>
            </div>
            <p style="margin:-0.3rem 0 0;font-size:0.74rem;color:var(--text-muted)">${tr('sliq.deposit_range_hint', '10–10.000 bzw. 1–10.000 USDC &nbsp;·&nbsp; leer = kein Limit/Minimum')}</p>
            <div style="border-top:1px solid var(--border);padding-top:0.6rem">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:0.4rem">${tr('sliq.current_best_pool', 'Aktuell bester Pool')}</div>
                <div id="cu-bester-best-pool-row">${_bestPoolHtml(bestPool, bestScore, bestName, minScore, cooldownSkipped, trendSkipped)}</div>
            </div>
        </div>`;
}

function _wireBesterPoolTab(modalEl, mid, wrap, pools) {
    const minScoreInput = modalEl.querySelector('#cu-bester-min-score');
    const bestRow       = modalEl.querySelector('#cu-bester-best-pool-row');

    // „Aktuell bester Pool" hängt von der Score-Schwelle UND dem (hier nicht mehr
    // editierbaren, aber weiter aktiven) Trend-Gate ab — der gespeicherte Wert kommt
    // aus modalEl.dataset.trendGate (s. _openCleanupModal), nicht mehr aus Haken.
    const _refreshBestRow = () => {
        if (!bestRow) return;
        const required = (modalEl.dataset.trendGate ?? '').split(',').filter(Boolean);
        const threshold = Math.max(0, Math.min(100, parseInt(minScoreInput?.value ?? '', 10) || 0));
        const { bestPool, bestScore, bestName, cooldownSkipped, trendSkipped } = _computeBestPool(pools, required);
        bestRow.innerHTML = _bestPoolHtml(bestPool, bestScore, bestName, threshold, cooldownSkipped, trendSkipped);
        modalEl._cuEqualize?.();
    };
    minScoreInput?.addEventListener('input', _refreshBestRow);
    _refreshBestRow();

    // Validierung: Minimale Einzahlung darf die Maximale nicht überschreiten –
    // sonst Speichern sperren, statt eine widersprüchliche Config zuzulassen.
    const minDepositInput = modalEl.querySelector('#cu-bester-min-deposit');
    const maxDepositInput = modalEl.querySelector('#cu-bester-max-deposit');
    const fb              = modalEl.querySelector('#cu-modal-feedback');
    // Der Speichern-Knopf liegt im Modal-Fuß und gehört allen Reitern gemeinsam.
    const saveBtn         = modalEl.querySelector('#cu-modal-save-btn');
    const _validateDepositRange = () => {
        const minVal    = parseFloat(minDepositInput?.value ?? '');
        const maxVal    = parseFloat(maxDepositInput?.value ?? '');
        const conflict  = Number.isFinite(minVal) && minVal > 0 && Number.isFinite(maxVal) && maxVal > 0 && minVal > maxVal;
        if (saveBtn) saveBtn.disabled = conflict;
        if (fb) {
            if (conflict) { fb.textContent = tr('sb.min_gt_max', 'Minimale Einzahlung darf nicht größer als die Maximale sein.'); fb.className = 'modal-feedback error'; }
            else if (fb.classList.contains('error')) { fb.textContent = ''; fb.className = 'modal-feedback'; }
        }
    };
    minDepositInput?.addEventListener('input', _validateDepositRange);
    maxDepositInput?.addEventListener('input', _validateDepositRange);
    // Beim Reiterwechsel erneut prüfen: sonst bliebe eine Sperre aus einem anderen
    // Reiter am gemeinsamen Knopf stehen.
    modalEl._cuValidate = { ...(modalEl._cuValidate ?? {}), bester: _validateDepositRange };
    _validateDepositRange();
}

// ── Tab "Dust": Dust-Sweep an/aus + Grenzwerte konfigurieren ─────────────────
function _dustTabHtml(cfgParsed) {
    const { dustEnabled, dustMin, dustMax } = cfgParsed;
    return `
        ${_cuDescHtml(
            tr('sliq.dust_desc', 'Tauscht kleine Token-Reste am Ende jedes Cleanup-Laufs automatisch zu USDC.'),
            tr('sliq.dust', 'Dust'),
            tr('sliq.dust_tip', 'Nach jedem Cleanup-Lauf bleiben oft kleine Reste bekannter Pool-Token im Wallet zurück (z. B. nach einem Swap nicht exakt aufgehende Beträge). Der Dust-Sweep tauscht diese Reste automatisch zu USDC, damit sie nicht ungenutzt liegen bleiben. Unter- und Obergrenze bestimmen, welcher Gegenwert als „Dust“ zählt.')
        )}
        <div class="cu-panel-body" style="display:flex;flex-direction:column;gap:0.6rem">
            <label class="cleanup-radio-option">
                <input type="radio" name="cleanup-dust-mode" value="on" ${dustEnabled ? 'checked' : ''}>
                <span>${tr('sb.activate', 'Aktivieren')}</span>
            </label>
            <label class="cleanup-radio-option">
                <input type="radio" name="cleanup-dust-mode" value="off" ${!dustEnabled ? 'checked' : ''}>
                <span>${tr('sb.deactivate', 'Deaktivieren')}</span>
            </label>
            <div style="border-top:1px solid var(--border);padding-top:0.6rem;display:flex;gap:1rem;">
                <div style="flex:1">
                    <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;color:var(--text-muted)">${tr('sliq.lower_bound', 'Untergrenze')}</label>
                    <div style="display:flex;align-items:center;gap:0.4rem;">
                        <input type="number" id="cu-dust-min" min="0" step="0.01" value="${dustMin}"
                               style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                        <span style="font-size:0.8rem;color:var(--text-muted)">USDC</span>
                    </div>
                </div>
                <div style="flex:1">
                    <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;color:var(--text-muted)">${tr('sliq.upper_bound', 'Obergrenze')}</label>
                    <div style="display:flex;align-items:center;gap:0.4rem;">
                        <input type="number" id="cu-dust-max" min="0" step="0.5" value="${dustMax}"
                               style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                        <span style="font-size:0.8rem;color:var(--text-muted)">USDC</span>
                    </div>
                </div>
            </div>
            <p style="margin:-0.3rem 0 0;font-size:0.76rem;color:var(--text-muted)">
                ${tr('sliq.dust_range_hint', 'Reste in diesem Bereich werden nach jedem Cleanup automatisch zu USDC getauscht. Darunter: vernachlässigbar, bleibt liegen. Darüber: bleibt liegen, regulärer Invest folgt.')}
            </p>
        </div>`;
}

function _wireDustTab(modalEl, mid, wrap) {
    const dustMinInput = modalEl.querySelector('#cu-dust-min');
    const dustMaxInput = modalEl.querySelector('#cu-dust-max');
    const fb           = modalEl.querySelector('#cu-modal-feedback');
    const saveBtn      = modalEl.querySelector('#cu-modal-save-btn');
    const _validateDustRange = () => {
        const minVal   = parseFloat(dustMinInput?.value ?? '');
        const maxVal   = parseFloat(dustMaxInput?.value ?? '');
        const conflict = Number.isFinite(minVal) && Number.isFinite(maxVal) && minVal >= maxVal;
        if (saveBtn) saveBtn.disabled = conflict;
        if (fb) {
            if (conflict) { fb.textContent = tr('sliq.dust_min_lt_max', 'Untergrenze muss kleiner als die Obergrenze sein.'); fb.className = 'modal-feedback error'; }
            else if (fb.classList.contains('error')) { fb.textContent = ''; fb.className = 'modal-feedback'; }
        }
    };
    dustMinInput?.addEventListener('input', _validateDustRange);
    dustMaxInput?.addEventListener('input', _validateDustRange);
    modalEl._cuValidate = { ...(modalEl._cuValidate ?? {}), dust: _validateDustRange };
    _validateDustRange();
}

// ── "Manuell": sofort in den gewählten Pool investieren ──────────────────────
async function _runCleanupManuell(mid, wrap) {
    const fb       = document.getElementById('cu-modal-feedback');
    const selected = document.querySelector('input[name="cleanup-mode-pool"]:checked');
    if (!selected) {
        if (fb) { fb.textContent = tr('sliq.choose_pool', 'Bitte einen Pool wählen.'); fb.className = 'modal-feedback error'; }
        return;
    }

    if (fb) { fb.textContent = tr('sliq.saving_mode', 'Speichere Modus…'); fb.className = 'modal-feedback'; }
    const modalEl = getModal(mid);
    const btns = modalEl
        ? [...modalEl.querySelectorAll('.forge-modal-footer button'), modalEl.querySelector('#cu-manuell-start-btn')].filter(Boolean)
        : [];
    btns.forEach(b => { b.disabled = true; });

    try {
        const saveRes = await fetch('/api/config/liquiditybot', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ CLEANUP_MODE: selected.value }),
        });
        if (!saveRes.ok) { const d = await saveRes.json(); throw new Error(d.error ?? `HTTP ${saveRes.status}`); }
        await _loadAndRenderCleanupRow(wrap);

        if (fb) { fb.textContent = tr('sliq.cleanup_running', 'Cleanup läuft… (kann bis zu 5 min dauern)'); fb.className = 'modal-feedback'; }
        const runRes = await fetch('/api/pools/liquidity/cleanup/run', { method: 'POST' });
        const data   = await runRes.json().catch(() => ({}));

        if (runRes.ok && data.ok) {
            if (fb) { fb.textContent = tr('sliq.cleanup_done', '✓ Cleanup erfolgreich abgeschlossen.'); fb.className = 'modal-feedback success'; }
            _ctx.showToast?.(tr('sliq.cleanup_ok', 'Cleanup erfolgreich'), 'success');
            const walletEl = _container?.querySelector('.liquiditybot-grid-wallet');
            const poolsEl  = _container?.querySelector('.liquiditybot-grid-pools');
            if (walletEl) _renderWallet(walletEl);
            if (poolsEl)  _renderPools(poolsEl);
        } else {
            const msg = data.error ?? data.log?.find(l => l.level === 'error')?.msg ?? `HTTP ${runRes.status}`;
            throw new Error(msg);
        }
    } catch (err) {
        if (fb) { fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb.className = 'modal-feedback error'; }
        _ctx.showToast?.(`Cleanup: ${err.message}`, 'error');
    } finally {
        btns.forEach(b => { b.disabled = false; });
    }
}

// ── "Bester Pool": Ranking-Modus (oder Deaktiviert) speichern ────────────────
async function _saveBesterPool(mid, wrap) {
    const fb       = document.getElementById('cu-modal-feedback');
    const selected = document.querySelector('input[name="cleanup-mode-ranking"]:checked');
    if (!selected) {
        if (fb) { fb.textContent = tr('sb.choose_option', 'Bitte eine Option wählen.'); fb.className = 'modal-feedback error'; }
        return;
    }
    const minScoreEl    = document.getElementById('cu-bester-min-score');
    const minScoreVal   = Math.max(0, Math.min(100, parseInt(minScoreEl?.value ?? '65', 10) || 65));
    const maxDepositEl  = document.getElementById('cu-bester-max-deposit');
    const maxDepositRaw = parseFloat(maxDepositEl?.value ?? '0');
    const maxDepositVal = maxDepositRaw >= 10 ? maxDepositRaw : 0;
    const minDepositEl  = document.getElementById('cu-bester-min-deposit');
    const minDepositRaw = parseFloat(minDepositEl?.value ?? '0');
    const minDepositVal = minDepositRaw >= 1 ? minDepositRaw : 0;
    // Trend-Gate ist in diesem Reiter nicht mehr editierbar (Opportunity 2.0,
    // s. _besterPoolTabHtml) — der beim Öffnen geladene Wert wird unverändert
    // zurückgeschrieben, damit ein Speichern hier den .env-Gate nicht auf "aus" setzt.
    // getModal() liefert das Backdrop (DOM-id "forge-modal-<mid>"), NICHT ein Element
    // mit id===mid — deshalb hier, nicht document.getElementById(mid).
    const trendGateVal = getModal(mid)?.dataset.trendGate ?? '';

    if (minDepositVal > 0 && maxDepositVal > 0 && minDepositVal > maxDepositVal) {
        if (fb) { fb.textContent = tr('sb.min_gt_max', 'Minimale Einzahlung darf nicht größer als die Maximale sein.'); fb.className = 'modal-feedback error'; }
        return;
    }

    if (fb) { fb.textContent = tr('sb.saving', 'Speichere…'); fb.className = 'modal-feedback'; }
    try {
        const res = await fetch('/api/config/liquiditybot', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                CLEANUP_MODE:        selected.value,
                CLEANUP_MIN_SCORE:   String(minScoreVal),
                CLEANUP_MAX_DEPOSIT: String(maxDepositVal),
                CLEANUP_MIN_DEPOSIT: String(minDepositVal),
                CLEANUP_TREND_GATE:  trendGateVal,
            }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        if (fb) { fb.textContent = tr('sliq.cleanup_saved_dot', '✓ Cleanup gespeichert.'); fb.className = 'modal-feedback success'; }
        _ctx.showToast?.(tr('sliq.cleanup_saved', 'Cleanup gespeichert'), 'success');
        await _loadAndRenderCleanupRow(wrap);
    } catch (err) {
        if (fb) { fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb.className = 'modal-feedback error'; }
    }
}

// ── "Dust": Dust-Sweep an/aus + Grenzwerte speichern ─────────────────────────
async function _saveDust(mid, wrap) {
    const fb       = document.getElementById('cu-modal-feedback');
    const selected = document.querySelector('input[name="cleanup-dust-mode"]:checked');
    if (!selected) return;
    const minEl  = document.getElementById('cu-dust-min');
    const maxEl  = document.getElementById('cu-dust-max');
    const minVal = parseFloat(minEl?.value ?? '0.01');
    const maxVal = parseFloat(maxEl?.value ?? '25');

    if (!Number.isFinite(minVal) || minVal < 0 || !Number.isFinite(maxVal) || maxVal <= 0 || minVal >= maxVal) {
        if (fb) { fb.textContent = tr('sliq.dust_min_lt_max_zero', 'Untergrenze muss kleiner als die Obergrenze sein (beide ≥ 0).'); fb.className = 'modal-feedback error'; }
        return;
    }

    if (fb) { fb.textContent = tr('sb.saving', 'Speichere…'); fb.className = 'modal-feedback'; }
    try {
        const res = await fetch('/api/config/liquiditybot', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                CLEANUP_DUST_ENABLED:  selected.value === 'on' ? 'true' : 'false',
                CLEANUP_DUST_MIN_USDC: String(minVal),
                CLEANUP_DUST_MAX_USDC: String(maxVal),
            }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        if (fb) { fb.textContent = tr('sliq.dust_saved_dot', '✓ Dust-Einstellungen gespeichert.'); fb.className = 'modal-feedback success'; }
        _ctx.showToast?.(tr('sliq.dust_saved', 'Dust-Einstellungen gespeichert'), 'success');
    } catch (err) {
        if (fb) { fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb.className = 'modal-feedback error'; }
    }
}

function _applyStatus(status) {
    const text = _container?.querySelector('#liquiditybot-status-text');
    if (text) {
        const icon = status === 'active' ? '&#10003;' : '&#9888;';
        text.innerHTML   = `${icon} ${_esc(_statusLabel(status))}`;
        text.className   = 'key-status ' + (status === 'active' ? 'set' : 'unset');
    }
    _applyButtonStates(status);

    // Pools-Karte hängt vom Bot-Status ab (Platzhalter + gesperrte Buttons,
    // solange der Bot nicht läuft) – nur bei einem echten Wechsel neu rendern,
    // sonst würde der 30s-Status-Poll jede offene Auswahl/jedes Dropdown
    // unterbrechen.
    if (status !== _lastKnownStatus) {
        _lastKnownStatus = status;
        const poolsEl = _container?.querySelector('.liquiditybot-grid-pools');
        if (poolsEl) _renderPools(poolsEl);

        // Cleanup-Zeile (Service-Karte) hat einen eigenen "Verwalten"-Button,
        // der ebenfalls nur bei laufendem Bot bedienbar sein soll.
        const cleanupWrap = _container?.querySelector('#liquiditybot-cleanup-wrap');
        if (cleanupWrap) _loadAndRenderCleanupRow(cleanupWrap).catch(() => {});
    }
}

function _applyButtonStates(status) {
    // Start/Stop/Restart leben jetzt im "Verwalten"-Modal (Status-Zeile), nicht mehr
    // fest in der Karte — document-weite Suche, no-op wenn das Modal gerade zu ist.
    const btnStart   = document.getElementById('liquiditybot-btn-start');
    const btnStop    = document.getElementById('liquiditybot-btn-stop');
    const btnRestart = document.getElementById('liquiditybot-btn-restart');
    if (!btnStart) return;

    // active   → nur Stop + Restart
    // inactive → nur Start
    // failed   → alle (Stop zum Aufräumen, Start + Restart zum Neustarten)
    // unknown  → alle gesperrt (Status unklar)
    const canStart   = status === 'inactive' || status === 'failed';
    let   canStop    = status === 'active'   || status === 'failed';
    const canRestart = status === 'active'   || status === 'failed';

    // Kapital-Sperre: Stop bleibt gesperrt, solange ein Pool eine offene Position
    // hält — server-seitig ohnehin erzwungen (bots.js), hier nur die UI-Vorschau
    // (kein unnötiger 409-Roundtrip). Restart bewusst NICHT gesperrt (transient,
    // selbstheilend), siehe Kommentar in bots.js.
    const hasCapital = _ctx.getHasCapital?.(SVC_ID) ?? false;
    if (hasCapital) canStop = false;
    btnStop.title = hasCapital
        ? tr('sb.stop_blocked_capital', 'Kann nicht gestoppt werden – es ist noch Kapital investiert (offene Position). Erst auszahlen, dann stoppen.')
        : '';

    btnStart.disabled   = !canStart;
    btnStop.disabled    = !canStop;
    btnRestart.disabled = !canRestart;
}

async function _doAction(action) {
    const taskEl  = document.getElementById('liquiditybot-task-status');
    const buttons = document.querySelectorAll('#liquiditybot-btn-start, #liquiditybot-btn-stop, #liquiditybot-btn-restart');

    buttons.forEach(b => b.disabled = true);
    if (taskEl) { taskEl.textContent = `${action}…`; taskEl.className = 'task-status running'; }

    try {
        const res = await fetch(`/api/bots/${SVC_ID}/${action}`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const { taskId } = await res.json();
        await _pollTask(taskId, action, taskEl);
    } catch (err) {
        if (taskEl) { taskEl.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); taskEl.className = 'task-status failed'; }
        _ctx.showToast?.(`${action} fehlgeschlagen: ${err.message}`, 'error');
    } finally {
        buttons.forEach(b => b.disabled = false);
        // Status nach Aktion neu laden
        setTimeout(() => _ctx.refreshStatus?.(), 1500);
    }
}

async function _pollTask(taskId, action, taskEl) {
    // forge-liquiditybot.service hat ExecStartPre=/bin/sleep 30 (wartet auf
    // Nexus) – ein 30s-Timeout hier würde also fast immer GENAU dann aufgeben,
    // wenn der Start gerade erst beginnt. 75s lässt Puffer für Sleep + echten
    // Bot-Boot (Wallet-/Pool-Checks).
    for (let i = 0; i < 75; i++) {
        await _sleep(1000);
        try {
            const res = await fetch(`/api/bots/tasks/${taskId}`);
            if (!res.ok) continue;
            const task = await res.json();

            if (task.status === 'done') {
                if (taskEl) { taskEl.textContent = `✅ ${action} erfolgreich`; taskEl.className = 'task-status done'; }
                _ctx.showToast?.(`LMBot: ${action} OK`, 'success');
                return;
            }
            if (task.status === 'failed') {
                const msg = task.error ?? tr('set.unknown_error', 'Unbekannter Fehler');
                if (taskEl) { taskEl.textContent = `❌ ${msg}`; taskEl.className = 'task-status failed'; }
                _ctx.showToast?.(`LMBot: ${msg}`, 'error');
                return;
            }
            if (taskEl) { taskEl.textContent = `${task.status}…`; }
        } catch { /* ignorieren, weiter warten */ }
    }
    if (taskEl) { taskEl.textContent = tr('set.timeout_no_result', 'Timeout – kein Ergebnis'); taskEl.className = 'task-status failed'; }
}

// ── Wallet-Tab ─────────────────────────────────────────────────────────────────

// Datum/Uhrzeit + Minuten seit dem letzten Wallet-Monitor-Check (beide Wallets
// werden gemeinsam per monitor.js aktualisiert, siehe _refreshWalletMonitor).
function _formatLastCheck(ms) {
    if (!ms) return tr('sb.no_check_yet', 'noch kein Check');
    const d      = new Date(ms);
    const date   = d.toLocaleDateString(NUM_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time   = d.toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' });
    const ageMin = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return tr('sb.last_check_fmt', '{date} {time} Uhr (vor {age} Min.)', { date, time, age: ageMin });
}

async function _refreshWalletMonitor(card, el) {
    const btn = card.querySelector('#wallet-btn-refresh-all');
    if (!btn || btn.disabled) return;
    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = tr('sb.refreshing', 'Aktualisiere…');
    try {
        const r = await fetch('/api/wallet/refresh-monitor', { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        _ctx.showToast?.(tr('sb.wallet_refreshed', 'Wallet aktualisiert'), 'success');
        await _renderWallet(el);
    } catch (err) {
        btn.disabled = false;
        btn.textContent = origLabel;
        _ctx.showToast?.(tr('sb.wallet_update_failed', 'Wallet-Update fehlgeschlagen: {error}', { error: err.message }), 'error');
    }
}

/**
 * status: { ok: boolean, tooltip: string } | null
 *   ok === true  → grüner Haken (genug SOL)
 *   ok === false → roter Kreuz + Tooltip (zu wenig SOL)
 *   null         → kein Haken/Kreuz, normale Textfarbe (z.B. Premium deaktiviert
 *                   oder noch keine SOL-Daten vorhanden)
 */
function _walletRowHtml(label, balance, status = null, scam = null) {
    const amountText = balance?.recorded_at
        ? `${(balance.total_usd ?? 0).toFixed(2)} USDC`
        : '<span class="wat-muted">' + tr('sb.no_data_click_refresh', 'noch keine Daten – auf Aktualisieren klicken') + '</span>';

    const infoHtml = (balance?.recorded_at && status)
        ? `<span class="key-status ${status.ok ? 'set' : 'crit'}"
                ${!status.ok ? `data-tooltip-title="${tr('sb.sol_low_title', 'Zu wenig SOL')}" data-tooltip-content="${_esc(status.tooltip)}"` : ''}>
                ${status.ok ? '&#10003;' : '&#10007;'} ${amountText}
           </span>`
        : amountText;

    return `
        <tr>
            <td class="wat-label">${_esc(label)}${scamInfoIconHtml(scam?.tokens)}</td>
            <td class="wat-info">${infoHtml}</td>
            <td class="wat-action">
                ${scamManageBadgeHtml(scam?.tokens)}<button class="btn btn-secondary btn-sm" data-wallet-manage-btn>${tr('sb.manage', 'Verwalten')}</button>
            </td>
        </tr>`;
}

async function _renderWallet(el) {
    el.innerHTML = '<div class="wallet-loading">' + tr('msg.loading', 'Lade…') + '</div>';
    try {
        const [infoRes, balRes, addrRes, premiumInfoRes] = await Promise.all([
            fetch('/api/wallet/liquidity/info'),
            fetch('/api/wallet/liquidity/balance'),
            fetch('/api/addresses'),
            fetch('/api/wallet/premium/info'),
        ]);
        // Auffällige Token: die Route rechnet nur aus der wallet-monitor-DB,
        // kein RPC- und kein Jupiter-Call beim Öffnen der Seite.
        const scamLiquidity = await fetchScamTokens('liquidity');
        if (!infoRes.ok) throw new Error(tr('sb.wallet_info_failed', 'Wallet-Info konnte nicht geladen werden (HTTP {status})', { status: infoRes.status }));
        if (!balRes.ok) throw new Error(tr('sb.wallet_balance_failed', 'Wallet-Bestand konnte nicht geladen werden (HTTP {status})', { status: balRes.status }));
        if (!addrRes.ok) throw new Error(tr('sb.addrbook_failed', 'Adressbuch konnte nicht geladen werden (HTTP {status})', { status: addrRes.status }));
        const info        = await infoRes.json();
        const balance      = await balRes.json();
        const addrs        = await addrRes.json();
        const premiumInfo  = premiumInfoRes.ok ? await premiumInfoRes.json() : { available: false };

        // Premium-Zeile nur wenn dieser Fork überhaupt ein Premium-Wallet hat
        // (Master oder Fork ohne Wallet → premiumInfo.available === false).
        let premiumBalance = null;
        let premiumEnabled = false;
        let scamPremium    = null;
        if (premiumInfo.available) {
            scamPremium = await fetchScamTokens('premium');
            try {
                const [balR, statR] = await Promise.all([
                    fetch('/api/wallet/premium/balance'),
                    fetch('/api/premium/status'),
                ]);
                if (balR.ok) premiumBalance = await balR.json();
                if (statR.ok) premiumEnabled = !!(await statR.json()).enabled;
            } catch { /* Zeile bleibt mit "keine Daten" stehen */ }
        }

        const liquidityStatus = balance?.sol != null
            ? { ok: balance.sol > SOL_LOW_THRESHOLD_LIQUIDITY, tooltip: tr('sb.sol_low_tip', 'Zu wenig SOL im Wallet für den Betrieb des Bots.') }
            : null;
        // Kein Haken/Kreuz solange Premium deaktiviert ist — der Zustand ist dann
        // ohnehin irrelevant (siehe Wunsch: neutrale, weiße Darstellung).
        const premiumStatus = premiumEnabled && premiumBalance?.sol != null
            ? { ok: premiumBalance.sol > SOL_LOW_THRESHOLD_PREMIUM, tooltip: tr('sliq.sol_low_premium', 'Zu wenig SOL im Premium-Wallet für die stündliche Zahlung.') }
            : null;

        el.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'settings-card';
        const lastCheckMs = Math.max(balance?.recorded_at ?? 0, premiumBalance?.recorded_at ?? 0) || null;
        card.innerHTML = `
            <div class="settings-card-header">
                <span class="sch-title">${tr('liq.wallet', 'Wallet')}</span>
            </div>
            <table class="wallet-action-table">
                <tbody>
                    ${_walletRowHtml(tr('nav.liquidity', 'Liquidity Bot'), balance, liquidityStatus, scamLiquidity)}
                    ${premiumInfo.available ? _walletRowHtml(tr('sliq.premium_service', 'Premium Service'), premiumBalance, premiumStatus, scamPremium) : ''}
                    <tr>
                        <td class="wat-label">${tr('sb.last_check', 'Letzter Check')}</td>
                        <td class="wat-info">${_esc(_formatLastCheck(lastCheckMs))}</td>
                        <td class="wat-action">
                            <button class="btn btn-secondary btn-sm" id="wallet-btn-refresh-all">${tr('sb.refresh', 'Aktualisieren')}</button>
                        </td>
                    </tr>
                </tbody>
            </table>`;
        el.appendChild(card);

        card.querySelector('#wallet-btn-refresh-all')
            ?.addEventListener('click', () => _refreshWalletMonitor(card, el));

        const rows = card.querySelectorAll('tbody tr');
        rows[0]?.querySelector('[data-wallet-manage-btn]')?.addEventListener('click', async () => {
            let freshInfo = info, freshBalance = balance, freshAddrs = addrs;
            try {
                const [infoR, balR, addrR] = await Promise.all([
                    fetch('/api/wallet/liquidity/info'),
                    fetch('/api/wallet/liquidity/balance'),
                    fetch('/api/addresses'),
                ]);
                if (infoR.ok) freshInfo    = await infoR.json();
                if (balR.ok)  freshBalance = await balR.json();
                if (addrR.ok) freshAddrs   = await addrR.json();
            } catch { /* Fallback auf zuletzt geladenen Stand */ }
            await _openWalletManageModal('liquidity', el, freshInfo, freshBalance, freshAddrs);
        });

        if (premiumInfo.available) {
            rows[1]?.querySelector('[data-wallet-manage-btn]')?.addEventListener('click', async () => {
                let freshInfo = premiumInfo, freshBalance = premiumBalance, freshAddrs = addrs;
                try {
                    const [infoR, balR, addrR] = await Promise.all([
                        fetch('/api/wallet/premium/info'),
                        fetch('/api/wallet/premium/balance'),
                        fetch('/api/addresses'),
                    ]);
                    if (infoR.ok) freshInfo    = await infoR.json();
                    if (balR.ok)  freshBalance = await balR.json();
                    if (addrR.ok) freshAddrs   = await addrR.json();
                } catch { /* Fallback auf zuletzt geladenen Stand */ }
                await _openWalletManageModal('premium', el, freshInfo, freshBalance, freshAddrs);
            });
        }

    } catch (err) {
        el.innerHTML = `<div class="settings-card settings-error">Fehler: ${err.message}</div>`;
    }
}

// ── Guthaben – Modal (identische Aufschlüsselung wie im Dashboard) ───────────

/** Wandelt die flache /api/wallet/liquidity/balance-Antwort in das von
 *  buildWalletDetailHtml() erwartete { walletMonitor: { snapshot, tokens } }. */
function _walletMonitorShape(balance) {
    return {
        walletMonitor: {
            snapshot: {
                sol_balance:  balance?.sol ?? 0,
                usdc_balance: balance?.usdc ?? 0,
                total_usd:    balance?.total_usd ?? 0,
                recorded_at:  balance?.recorded_at ?? null,
                age_seconds:  balance?.recorded_at ? (Date.now() - balance.recorded_at) / 1000 : null,
            },
            tokens: balance?.tokens ?? [],
        },
    };
}


const SCAM_INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// ── „Verschieben" aus dem Reiter „Auffällig" ─────────────────────────────────
//
// Öffnet bewusst KEIN eigenes Formular, sondern den vorhandenen Senden-Reiter:
// Adressbuch, Betragsfeld und Rückmeldungen sind dort schon gebaut und dem Nutzer
// vertraut. Der Token wird als zusätzliche Option in die Auswahl gehängt und trägt
// seinen Mint an der Option — daran erkennt der Sende-Knopf, dass er die
// Verschiebe-Route nehmen muss statt der regulären.
function _openMoveInSendTab(modalEl, tk) {
    const tabBtn = modalEl.querySelector('.wb-tab[data-wb="senden"]');
    tabBtn?.click();

    const sel = modalEl.querySelector('#wm-token');
    if (!sel) return;

    const symbol = (tk.symbol ?? '').replace(SCAM_INVISIBLE_RE, '').trim() || tk.mint.slice(0, 8) + '…';

    let opt = sel.querySelector(`option[data-mint="${CSS.escape(tk.mint)}"]`);
    if (!opt) {
        opt = document.createElement('option');
        opt.value           = symbol;
        opt.dataset.mint    = tk.mint;
        opt.dataset.bal     = String(tk.balance ?? 0);
        opt.textContent     = `${symbol} (${_fmt(tk.balance ?? 0)})`;
        sel.appendChild(opt);
    }
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));

    // Voller Bestand vorbelegt — der Sinn der Aktion ist, ihn loszuwerden.
    const amountInp = modalEl.querySelector('#wm-amount');
    if (amountInp) amountInp.value = String(tk.balance ?? 0);

    const fb = modalEl.querySelector('#wm-send-feedback');
    if (fb) {
        fb.textContent = tr('scam.move_hint', 'Auffälliger Token – wird an die gewählte Adresse verschoben, nicht gelöscht.');
        fb.className   = 'modal-feedback';
    }
}

// ── Kombiniertes Wallet-Modal: Guthaben / Senden / Empfangen / Private Key ───
async function _openWalletManageModal(flavor, el, info, balance, addrs) {
    // Rein aus der DB gerechnet – kein externer Abruf beim Öffnen des Modals.
    const scam = await fetchScamTokens(flavor);
    const mid   = `${flavor}-wallet-modal`;
    const title = flavor === 'premium' ? tr('sliq.manage_premium_wallet', 'Premium-Wallet verwalten') : tr('sb.manage_wallet', 'Wallet verwalten');
    const tokens = [
        { symbol: 'SOL',  balance: balance.sol  ?? 0 },
        { symbol: 'USDC', balance: balance.usdc ?? 0 },
        ...(balance.tokens ?? [])
            .filter(t => t.symbol !== 'SOL' && t.symbol !== 'USDC' && (t.balance ?? 0) > 0),
    ];

    showModal({
        id:    mid,
        title,
        body: `
            <div class="wb-tab-bar">
                <button class="wb-tab active" data-wb="guthaben">${tr('len.balance', 'Guthaben')}</button>
                <button class="wb-tab" data-wb="senden">${tr('msg.send', 'Senden')}</button>
                <button class="wb-tab" data-wb="empfangen">${tr('sb.receive', 'Empfangen')}</button>
                <button class="wb-tab" data-wb="key">${tr('sb.private_key', 'Private Key')}</button>
                <button class="wb-tab" data-wb="scam">${tr('scam.tab', 'Auffällig')}${(scam.tokens ?? []).length ? ` <span class="scam-tab-count">(${scam.tokens.length})</span>` : ''}</button>
            </div>
            <div id="wb-tab-guthaben">${buildWalletDetailHtml(_walletMonitorShape(balance))}</div>
            <div id="wb-tab-senden" hidden>
                <div id="wm-send">${_buildSendPanel(tokens)}</div>
                <div id="wm-addrbook" hidden></div>
                <div class="bot-actions" id="wm-send-actions" style="margin-top:0.6rem;"></div>
            </div>
            <div id="wb-tab-empfangen" hidden>${_buildReceivePanelHtml(flavor, info)}</div>
            <div id="wb-tab-key" hidden>${_buildKeyPanelHtml(flavor, info)}</div>
            <div id="wb-tab-scam" hidden>${buildScamTabHtml(scam)}</div>`,
        footerNote: '<span id="wb-footer-note">' + tr('sb.value_gt_zero', 'Wert &gt; 0,00 USDC') + '</span>',
        actions: [
            { label: tr('common.close', 'Schließen'), onClick: () => closeModal(mid) },
        ],
    });

    const modalEl = getModal(mid);
    if (!modalEl) return;

    modalEl.querySelectorAll('.wb-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            modalEl.querySelectorAll('.wb-tab').forEach(b => b.classList.toggle('active', b === btn));
            modalEl.querySelector('#wb-tab-guthaben').hidden  = btn.dataset.wb !== 'guthaben';
            modalEl.querySelector('#wb-tab-senden').hidden    = btn.dataset.wb !== 'senden';
            modalEl.querySelector('#wb-tab-empfangen').hidden = btn.dataset.wb !== 'empfangen';
            modalEl.querySelector('#wb-tab-key').hidden       = btn.dataset.wb !== 'key';
            modalEl.querySelector('#wb-tab-scam').hidden      = btn.dataset.wb !== 'scam';
            const note = modalEl.querySelector('#wb-footer-note');
            if (note) note.hidden = btn.dataset.wb !== 'guthaben';
        });
    });

    _wireSendPanel(modalEl, flavor, tokens, addrs);
    _wireReceivePanel(modalEl, info);
    _wireKeyPanel(modalEl, flavor, mid, el, info);
    // Nach einem Löschvorgang Modal schließen und die Karte neu aufbauen — sonst
    // stünde der eben entfernte Token weiter in der Liste.
    wireScamTab(modalEl, flavor, scam, () => { closeModal(mid); _renderWallet(el); },
                tk => _openMoveInSendTab(modalEl, tk));
}

// ── Reiter "Empfangen": Adresse + QR-Code (wie bisheriges Einzahlen-Modal) ───
function _buildReceivePanelHtml(flavor, info) {
    return `
        <div class="settings-row">
            <span class="settings-label">${tr('sb.address', 'Adresse')}</span>
            <div class="addr-display-row">
                <span class="addr-text" title="${_esc(info.pubkey)}">${_esc(info.preview)}</span>
                <button class="btn btn-secondary btn-icon" id="wb-receive-copy-btn" title="${tr('sb.copy', 'Kopieren')}">&#128203;</button>
            </div>
        </div>
        <div class="settings-row" style="border:none; align-items:flex-start; margin-top:0.75rem;">
            <span class="settings-label">${tr('sb.qr_code', 'QR-Code')}</span>
            <div class="qr-wrapper">
                <img src="/api/wallet/${flavor}/qr" alt="${tr('sb.qr_code', 'QR-Code')}" class="qr-img">
            </div>
        </div>`;
}

function _wireReceivePanel(modalEl, info) {
    modalEl.querySelector('#wb-receive-copy-btn')?.addEventListener('click', () => {
        const btn = modalEl.querySelector('#wb-receive-copy-btn');
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(info.pubkey).then(() => _flashCopy(btn));
        } else {
            const ta = document.createElement('textarea');
            ta.value = info.pubkey;
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); ta.remove();
            _flashCopy(btn);
        }
    });
}

function _flashCopy(btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '&#10003;';
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1500);
}

// ── Reiter "Private Key": Download (falls gesetzt) + Import in einem Reiter ──
function _buildKeyPanelHtml(flavor, info) {
    return `
        <div class="wat-modal-status">
            <span class="key-status ${info.keypairSet ? 'set' : 'unset'}">
                ${info.keypairSet
                    ? `&#10003; Gesetzt &nbsp;<span class="key-preview">${_esc(info.preview)}</span>`
                    : tr('sb.key_missing', '&#9888; Kein Key konfiguriert')}
            </span>
        </div>
        ${info.keypairSet ? `
        <div class="bot-actions" style="margin:0.6rem 0;">
            <a class="btn btn-secondary btn-sm" href="/api/wallet/${flavor}/keypair/export" download>${tr('sb.download', '&#11015; Herunterladen')}</a>
        </div>
        <p class="modal-hint" style="margin:0 0 0.9rem;">
            ${tr('sb.key_download_hint', 'Bewahre die heruntergeladene Datei sicher auf — wer sie besitzt, hat vollen Zugriff auf dieses Wallet.')}
        </p>` : ''}
        <p class="modal-hint" style="margin-top:0.5rem;">
            ${info.keypairSet ? tr('sb.key_import_replace', 'Neuen Key importieren, um den bestehenden zu ersetzen:') : tr('sb.key_paste', 'Key einfügen:')}<br>
            ${tr('sb.key_formats', 'Akzeptierte Formate:')}<br>
              ${tr('sb.key_format_base58', '&bull; Base58-String (64 Bytes, Solana CLI Format)')}<br>
              ${tr('sb.key_format_json', '&bull; JSON-Array:')} <code>[1, 2, &hellip;, 64]</code></p>
        <textarea id="wb-key-input" class="key-textarea"
            placeholder="${info.keypairSet ? tr('sb.key_ph_replace', 'Neuen Key einfügen um zu ersetzen…') : tr('sb.key_ph_paste', 'Key einfügen (Strg+V)…')}"
            autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
        <div class="bot-actions" style="margin-top:0.6rem;">
            <button class="btn btn-secondary btn-uniform" id="wb-key-save-btn">${tr('msg.save', 'Speichern')}</button>
        </div>
        <div class="modal-feedback" id="wb-key-feedback"></div>`;
}

function _wireKeyPanel(modalEl, flavor, mid, el, info) {
    modalEl.querySelector('#wb-key-save-btn')?.addEventListener('click', () => _saveKey(flavor, mid, modalEl, el));
}

async function _saveKey(flavor, mid, modalEl, el) {
    const input    = modalEl.querySelector('#wb-key-input');
    const feedback = modalEl.querySelector('#wb-key-feedback');
    const content  = input?.value.trim();

    if (!content) {
        if (feedback) { feedback.textContent = tr('sb.key_required', 'Bitte Key einfügen.'); feedback.className = 'modal-feedback error'; }
        return;
    }
    if (feedback) { feedback.textContent = tr('sb.saving', 'Speichere…'); feedback.className = 'modal-feedback'; }

    try {
        const res  = await fetch(`/api/wallet/${flavor}/keypair`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ content }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

        closeModal(mid);
        _ctx.showToast?.(tr('sb.key_saved', 'Key gespeichert. Adresse: {address}', { address: data.preview }), 'success');
        if (el) await _renderWallet(el);
    } catch (err) {
        if (feedback) { feedback.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); feedback.className = 'modal-feedback error'; }
    }
}

// ── Reiter "Senden" (innere Tabs Senden/Adressbuch, wie bisheriges Auszahlen) ─
function _buildSendPanel(tokens) {
    const sel    = _selectedSendAddr;
    const isSol  = tokens.length > 0 && tokens[0].symbol === 'SOL';
    return `
        <div class="settings-row">
            <span class="settings-label">
                Token
                <span id="wm-sol-hint" style="margin-left:0.3rem;${isSol ? '' : 'display:none;'}"
                    data-tooltip-title="${tr('sb.sol_reserve', 'SOL-Reserve')}"
                    data-tooltip-content="${tr('sb.sol_reserve_tip', '0,1 SOL werden für den Betrieb des Bots auf dem Wallet benötigt und können nicht über diese Funktion abgezogen werden.')}">&#9432;</span>
            </span>
            <div style="display:flex;gap:0.4rem;align-items:center;">
                <select class="modal-select" id="wm-token">
                    ${tokens.map(t =>
                        `<option value="${_esc(t.symbol)}" data-bal="${t.balance}">
                            ${_esc(t.symbol)} (${_fmt(t.balance)})
                        </option>`
                    ).join('')}
                </select>
                <button class="btn btn-secondary btn-icon" id="wm-refresh" title="${tr('sb.refresh_balance', 'Guthaben aktualisieren')}">&#8635;</button>
            </div>
        </div>
        <div class="settings-row">
            <span class="settings-label">${tr('msg.amount', 'Betrag')}</span>
            <div class="send-amount-row">
                <input class="modal-input" id="wm-amount" type="number" min="0" step="any" placeholder="0.00">
                <button class="btn btn-secondary btn-sm" id="wm-max">Max</button>
            </div>
        </div>
        <div class="settings-row">
            <span class="settings-label">${tr('msg.to', 'An')}</span>
            <div class="addr-select-row">
                <div class="addr-selected-display${sel ? '' : ' empty'}" id="wm-addr-display"
                     title="${sel ? _esc(sel.address) : ''}">
                    ${sel ? _esc(sel.name) : tr('sb.no_address_selected', 'Keine Adresse gewählt')}
                </div>
                <button class="btn btn-secondary btn-sm wm-to-addrbook" title="${tr('sb.address_book', 'Adressbuch')}">&#128218;</button>
            </div>
        </div>
        <div class="modal-feedback" id="wm-send-feedback" style="margin-top:0.5rem;"></div>`;
}

function _buildAddrbookList(addrs) {
    if (addrs.length === 0) {
        return `<p class="wallet-hint" style="margin-bottom:0.75rem;">${tr('sb.no_addresses', 'Noch keine Adressen gespeichert.')}</p>`;
    }
    return `
        <div class="ab-modal-list">
            ${addrs.map(a => `
                <div class="ab-modal-row">
                    <div class="ab-modal-info">
                        <div class="ab-modal-name">${_esc(a.name)}</div>
                        <div class="ab-modal-addr">${_esc(a.address)}</div>
                    </div>
                    <div class="ab-modal-actions">
                        <button class="btn btn-secondary btn-sm ab-select" data-id="${a.id}">${tr('sb.select_btn', '&#8629; Wählen')}</button>
                        <button class="btn btn-secondary btn-icon ab-edit" data-id="${a.id}" title="${tr('sb.edit', 'Bearbeiten')}">&#9998;</button>
                        <button class="btn btn-secondary btn-icon ab-del" data-id="${a.id}" title="${tr('msg.delete', 'Löschen')}">&#10005;</button>
                    </div>
                </div>`).join('')}
        </div>`;
}

function _buildAddrbookForm(row) {
    return `
        <span class="ab-form-title">${row ? tr('sb.edit_address', 'Adresse bearbeiten') : tr('sb.new_address', 'Neue Adresse')}</span>
        <label class="modal-label" style="margin-top:0.75rem;">Name</label>
        <input id="ab-form-name" class="modal-input" type="text"
            value="${row ? _esc(row.name) : ''}" placeholder="${tr('sb.addr_name_ph', 'z. B. Coinbase Wallet')}" autocomplete="off">
        <label class="modal-label" style="margin-top:0.75rem;">${tr('sb.solana_address', 'Solana-Adresse')}</label>
        <input id="ab-form-address" class="modal-input" type="text"
            value="${row ? _esc(row.address) : ''}" placeholder="${tr('sb.base58_ph', 'Base58-Adresse…')}"
            autocomplete="off" autocorrect="off" spellcheck="false">
        <div class="modal-feedback" id="ab-form-feedback"></div>`;
}

function _wireSendPanel(modalEl, flavor, tokens, initialAddrs) {
    const backdrop = modalEl;
    if (!backdrop) return;

    let currentAddrs = initialAddrs;

    // ── Aktionsleiste unten: zeigt je Ansicht genau einen Button (Senden /
    //    + Neue Adresse / Speichern) — löst sich beim Ansichtswechsel komplett
    //    neu auf, kein separates Zurück/Senden-Duo mehr nötig ─────────────────
    function setActionBar(html) {
        const bar = backdrop.querySelector('#wm-send-actions');
        if (bar) bar.innerHTML = html;
        return bar;
    }

    // ── Ansicht "Senden" (Token/Betrag/Empfänger) ────────────────────────────
    function showSend() {
        backdrop.querySelector('#wm-send').hidden     = false;
        backdrop.querySelector('#wm-addrbook').hidden = true;
        setActionBar('<button class="btn btn-secondary btn-uniform" id="wb-send-btn">' + tr('sb.send_btn', '&#9654; Senden') + '</button>');
        wireSendButton();
    }

    backdrop.querySelector('.wm-to-addrbook')
        ?.addEventListener('click', showList);

    // ── SOL-Hint + Max-Betrag bei Token-Wechsel aktualisieren ────────────────
    const SOL_RESERVE = 0.1;

    function getMaxSendable() {
        const tokenSel = backdrop.querySelector('#wm-token');
        const sym      = tokenSel?.value ?? '';
        const bal      = parseFloat(tokenSel?.options[tokenSel.selectedIndex]?.dataset.bal ?? '0') || 0;
        return sym === 'SOL' ? Math.max(0, bal - SOL_RESERVE) : bal;
    }

    function updateSolHint() {
        const tokenSel = backdrop.querySelector('#wm-token');
        const hint     = backdrop.querySelector('#wm-sol-hint');
        if (hint) hint.style.display = tokenSel?.value === 'SOL' ? '' : 'none';
    }

    backdrop.querySelector('#wm-token')?.addEventListener('change', updateSolHint);

    // ── Refresh-Button ────────────────────────────────────────────────────────
    backdrop.querySelector('#wm-refresh')?.addEventListener('click', async () => {
        const btn = backdrop.querySelector('#wm-refresh');
        btn.disabled = true;
        btn.textContent = '…';
        try {
            const res = await fetch(`/api/wallet/${flavor}/balance`);
            if (!res.ok) throw new Error();
            const bal       = await res.json();
            const newTokens = [
                { symbol: 'SOL',  balance: bal.sol  ?? 0 },
                { symbol: 'USDC', balance: bal.usdc ?? 0 },
                ...(bal.tokens ?? []).filter(t => t.symbol !== 'SOL' && t.symbol !== 'USDC' && (t.balance ?? 0) > 0),
            ];
            const sel = backdrop.querySelector('#wm-token');
            if (sel) {
                const prev    = sel.value;
                sel.innerHTML = newTokens.map(t =>
                    `<option value="${_esc(t.symbol)}" data-bal="${t.balance}">${_esc(t.symbol)} (${_fmt(t.balance)})</option>`
                ).join('');
                if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
                updateSolHint();
            }
        } catch { /* Fehler still ignorieren */ } finally {
            btn.disabled    = false;
            btn.textContent = '↺';
        }
    });

    // ── Max-Button ────────────────────────────────────────────────────────────
    backdrop.querySelector('#wm-max')?.addEventListener('click', () => {
        const inp = backdrop.querySelector('#wm-amount');
        if (!inp) return;
        const v = getMaxSendable();
        if (v === 0) { inp.value = '0'; return; }
        const mag      = Math.floor(Math.log10(Math.abs(v)));
        const decimals = mag >= 0 ? 8 : Math.min(10, -mag + 6);
        inp.value      = v.toFixed(decimals).replace(/(\.\d*[1-9])0+$/, '$1').replace(/\.0*$/, '');
    });

    // ── Adress-Anzeige im Senden-Tab aktualisieren ────────────────────────────
    function updateAddrDisplay() {
        const display = backdrop.querySelector('#wm-addr-display');
        if (!display) return;
        if (_selectedSendAddr) {
            display.textContent = _selectedSendAddr.name;
            display.title       = _selectedSendAddr.address;
            display.classList.remove('empty');
        } else {
            display.textContent = tr('sb.no_address_selected', 'Keine Adresse gewählt');
            display.title       = '';
            display.classList.add('empty');
        }
    }

    // ── Ansicht "Adressbuch-Liste" ────────────────────────────────────────────
    function showList() {
        backdrop.querySelector('#wm-send').hidden     = true;
        backdrop.querySelector('#wm-addrbook').hidden = false;
        const panel = backdrop.querySelector('#wm-addrbook');
        panel.innerHTML = _buildAddrbookList(currentAddrs);
        wireList(panel);
        const bar = setActionBar('<button class="btn btn-secondary btn-uniform" id="ab-new">' + tr('sb.new_address_btn', '+ Neue Adresse') + '</button>');
        bar?.querySelector('#ab-new')?.addEventListener('click', () => showForm(null));
    }

    // ── Ansicht "Adressbuch-Formular" (row=null → Neu, row={...} → Bearbeiten) ─
    function showForm(row) {
        backdrop.querySelector('#wm-send').hidden     = true;
        backdrop.querySelector('#wm-addrbook').hidden = false;
        const panel = backdrop.querySelector('#wm-addrbook');
        panel.innerHTML = _buildAddrbookForm(row);

        const bar = setActionBar('<button class="btn btn-secondary btn-uniform" id="ab-form-save">' + tr('msg.save', 'Speichern') + '</button>');
        bar?.querySelector('#ab-form-save')?.addEventListener('click', async () => {
            const name    = panel.querySelector('#ab-form-name')?.value.trim();
            const address = panel.querySelector('#ab-form-address')?.value.trim();
            const fb      = panel.querySelector('#ab-form-feedback');

            if (!name || !address) {
                if (fb) { fb.textContent = tr('sb.name_addr_required', 'Name und Adresse ausfüllen.'); fb.className = 'modal-feedback error'; }
                return;
            }
            try {
                const res = row
                    ? await fetch(`/api/addresses/${row.id}`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, address }),
                      })
                    : await fetch('/api/addresses', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, address }),
                      });

                if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }

                if (row && _selectedSendAddr?.id === row.id) {
                    _selectedSendAddr = { id: row.id, name, address };
                    updateAddrDisplay();
                }
                const r  = await fetch('/api/addresses');
                currentAddrs = await r.json();
                showList();
            } catch (err) {
                const fb2 = panel.querySelector('#ab-form-feedback');
                if (fb2) { fb2.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb2.className = 'modal-feedback error'; }
            }
        });
    }

    // ── Adressbuch-Liste verdrahten (Auswahl/Bearbeiten/Löschen) ──────────────
    function wireList(panel) {
        panel.querySelectorAll('.ab-select').forEach(btn => {
            btn.addEventListener('click', () => {
                const addr = currentAddrs.find(a => a.id === Number(btn.dataset.id));
                if (addr) { _selectedSendAddr = addr; updateAddrDisplay(); }
                showSend();
            });
        });

        panel.querySelectorAll('.ab-edit').forEach(btn => {
            btn.addEventListener('click', () => {
                const row = currentAddrs.find(a => a.id === Number(btn.dataset.id));
                if (row) showForm(row);
            });
        });

        panel.querySelectorAll('.ab-del').forEach(btn => {
            btn.addEventListener('click', () => {
                const delId = Number(btn.dataset.id);
                // confirm() hielt den Code an, showModal() tut das nicht – der Rumpf
                // liegt deshalb in einer eigenen Funktion, die erst der Klick auslöst.
                const cid = 'ab-del-confirm';
                showModal({
                    id: cid,
                    title: tr('sb.delete_address_q', 'Adresse wirklich löschen?'),
                    body: `<p style="margin:0;font-size:.88rem;line-height:1.55">${tr('sb.delete_address_note', 'Der Eintrag wird aus dem Adressbuch entfernt. Bereits gesendete Transaktionen bleiben davon unberührt.')}</p>`,
                    actions: [
                        { label: tr('common.delete', 'Löschen'), onClick: () => { closeModal(cid); doDeleteAddress(delId); } },
                        { label: tr('common.cancel', 'Abbrechen'), onClick: () => closeModal(cid) },
                    ],
                });
            });
        });

        async function doDeleteAddress(delId) {

                const delRes = await fetch(`/api/addresses/${delId}`, { method: 'DELETE' });
                if (!delRes.ok) {
                    const err = await delRes.json().catch(() => ({}));
                    if (delRes.status === 409 && err.usages?.length) {
                        const where = err.usages.map(u =>
                            `• ${u.botId} / ${u.poolId}: ${u.fields.join(', ')}`
                        ).join('\n');
                        infoModal(tr('sb.address_in_use', 'Diese Adresse wird noch verwendet und kann nicht gelöscht werden:\n\n{list}', { list: where }));
                    } else {
                        infoModal(err.error ?? tr('sb.delete_failed_dot', 'Löschen fehlgeschlagen.'));
                    }
                    return;
                }

                if (_selectedSendAddr?.id === delId) {
                    _selectedSendAddr = null;
                    updateAddrDisplay();
                }
                const r  = await fetch('/api/addresses');
                currentAddrs = await r.json();
                showList();
        }
    }

    // ── Senden-Button (Aktionsleiste, neu verdrahtet bei jedem showSend()) ───
    function wireSendButton() {
        backdrop.querySelector('#wb-send-btn')?.addEventListener('click', async () => {
            const fb        = backdrop.querySelector('#wm-send-feedback');
            const tokenSel  = backdrop.querySelector('#wm-token');
            const amountInp = backdrop.querySelector('#wm-amount');
            const sendBtn   = backdrop.querySelector('#wb-send-btn');

            const symbol    = tokenSel?.value ?? '';
            const amount    = parseFloat(amountInp?.value ?? '0');
            const toAddress = _selectedSendAddr?.address ?? '';

            // Validierung (client-seitig, Server prüft nochmal)
            if (!symbol) {
                fb.textContent = tr('sb.select_token', 'Bitte einen Token auswählen.');
                fb.className   = 'modal-feedback error';
                return;
            }
            if (!amount || amount <= 0) {
                fb.textContent = tr('sb.enter_amount', 'Bitte einen Betrag eingeben.');
                fb.className   = 'modal-feedback error';
                return;
            }
            if (!toAddress) {
                fb.textContent = tr('sb.select_recipient', 'Bitte eine Empfänger-Adresse im Adressbuch wählen.');
                fb.className   = 'modal-feedback error';
                return;
            }
            if (symbol === 'SOL' && amount > getMaxSendable()) {
                fb.textContent = tr('sb.amount_exceeds_sol', 'Betrag überschreitet das verfügbare Guthaben (max. {max} SOL nach Reserve).', { max: getMaxSendable().toFixed(4) });
                fb.className   = 'modal-feedback error';
                return;
            }

            sendBtn.disabled = true;
            fb.textContent   = tr('sb.tx_sending', 'Transaktion wird gesendet…');
            fb.className     = 'modal-feedback';

            // Auffällige Token tragen ihren Mint an der Option. Sie gehen über eine
            // eigene Route: der reguläre Sende-Pfad löst den Mint über das Symbol aus
            // der Token-Registry auf, kennt nur das Legacy-Token-Programm und benutzt
            // die veraltete Transfer-Instruktion — für diese Token alles untauglich.
            const scamMint = tokenSel?.options[tokenSel.selectedIndex]?.dataset.mint || null;
            const endpoint = scamMint
                ? `/api/wallet/${flavor}/scam/move`
                : `/api/wallet/${flavor}/send`;
            const payload  = scamMint
                ? { mint: scamMint, amount, toAddress }
                : { symbol, amount, toAddress };

            try {
                const res  = await fetch(endpoint, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify(payload),
                });
                const data = await res.json();

                if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

                const explorerUrl = `https://solscan.io/tx/${data.txHash}`;
                fb.innerHTML  = tr('sb.sent_ok', '✓ Gesendet: {amount} {symbol} → {to}', { amount: _fmt(amount), symbol: _esc(symbol), to: _esc(_selectedSendAddr.name) }) + ' '
                              + `<a href="${explorerUrl}" target="_blank" rel="noopener" class="tx-link">${tr('sb.view_tx', 'TX&nbsp;ansehen&nbsp;↗')}</a>`;
                fb.className   = 'modal-feedback ok';
                _ctx.showToast?.(tr('sb.sent_ok_toast', 'Gesendet: {amount} {symbol} → {to}', { amount: _fmt(amount), symbol, to: _selectedSendAddr.name }), 'success');
                if (amountInp) amountInp.value = '';
                // Server aktualisiert wallet-monitor.db im Hintergrund automatisch
                // (TX-Confirm + Propagierungspuffer + Monitor-Lauf, siehe
                // scheduleWalletRefreshAfterSend in bots/settings/routes/wallet.js) —
                // 15s geben dem genug Zeit, bevor die Wallet-Karte neu geladen wird.
                setTimeout(() => {
                    const walletEl = _container?.querySelector('.liquiditybot-grid-wallet');
                    if (walletEl) _renderWallet(walletEl);
                }, 15000);
            } catch (err) {
                fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message });
                fb.className   = 'modal-feedback error';
            } finally {
                sendBtn.disabled = false;
            }
        });
    }

    showSend();
}

// ── Pools-Karte ────────────────────────────────────────────────────────────────

let _activePool       = null;
let _advisorHints     = [];   // aktueller Stand; wird periodisch aktualisiert
let _hintsRefreshTimer = null;

// Pool-Typ-Filter im Pool-Picker (persistiert wie _activePool)
let _poolTypeFilter = localStorage.getItem('liquiditybot.poolTypeFilter') ?? 'all';
// Aktiv/Inaktiv-Filter im Pool-Picker (persistiert, UND-verknüpft mit _poolTypeFilter)
let _poolActiveFilter = localStorage.getItem('liquiditybot.poolActiveFilter') ?? 'all';

// Kurzlabels für poolType (config/pools.json), siehe auch das gleichnamige
// Objekt im Liquidity-Dashboard (html/liquidity/js/app.js).
const POOL_TYPE_LABELS = {
    rebalance_free: tr('sliq.pool_type_rebalance_free', 'Rebalance-frei'),
    volatil_1:      tr('liq.vol_low', 'Gering volatil'),
    volatil_2:      tr('liq.vol_mid', 'Mittel volatil'),
    volatil_3:      tr('liq.vol_high', 'Stark volatil'),
    rwa:            'RWA',
};

/**
 * Header-Icon (gleicher Mechanismus wie html/liquidity/js/app.js): ausgegraut
 * wenn Premium/Score inaktiv, farbig wenn aktiv, Erklärung per Hover-Tooltip.
 * scoreSource ist ein globaler Zustand, an jedem Pool-Objekt identisch
 * angehängt (siehe GET /api/pools/liquidity) – ein Pool reicht zum Auslesen.
 */
function _updatePremiumIcon(pools) {
    const icon = document.getElementById('premiumStatusIcon');
    if (!icon) return;
    const scoreSource = pools?.[0]?.scoreSource;
    icon.classList.remove('hidden');
    const active = !!scoreSource && scoreSource !== 'none';
    icon.classList.toggle('active', active);
    icon.dataset.tooltipTitle = active ? tr('liq.premium_active', 'Premium aktiv') : tr('liq.premium_inactive', 'Premium inaktiv');
    icon.dataset.tooltipContent = active
        ? tr('sliq.premium_active_tip', 'Premium-Datendienst aktiv – Opportunity Score und Score-Limit-Exit laufen mit gelieferten Daten.')
        : tr('sliq.premium_inactive_tip', 'Score-Bewertung nicht aktiv – Opportunity Score und Score-Limit-Exit werden über den Premium-Datendienst geliefert. Trailing Stop und TVL-Schutz arbeiten unabhängig davon weiter.');
}

async function _renderPools(el) {
    el.innerHTML = '<div class="wallet-loading">' + tr('sliq.loading_pools', 'Lade Pools…') + '</div>';
    try {
        const [poolsRes, addrsRes, oppRes, hintsRes] = await Promise.all([
            fetch(`/api/pools/liquidity?t=${Date.now()}`),
            fetch('/api/addresses'),
            fetch(`/api/pools/liquidity/opportunity?t=${Date.now()}`),
            fetch(`/api/pools/liquidity/advisor-hints?t=${Date.now()}`),
        ]);
        if (!poolsRes.ok) throw new Error(tr('sliq.pools_load_failed', 'Pools konnten nicht geladen werden (HTTP {status})', { status: poolsRes.status }));
        if (!addrsRes.ok) throw new Error(tr('sb.addrbook_failed', 'Adressbuch konnte nicht geladen werden (HTTP {status})', { status: addrsRes.status }));
        const pools  = await poolsRes.json();
        const addrs  = await addrsRes.json();
        const opp    = oppRes.ok ? await oppRes.json() : { available: false };
        const hints  = hintsRes.ok ? await hintsRes.json() : [];

        _advisorHints = hints;
        _updatePremiumIcon(pools);

        if (!_activePool) {
            const preset = _presetPoolId;
            if (preset && pools.find(p => p.id === preset)) {
                _activePool = preset;
                localStorage.setItem('liquiditybot.activePool', _activePool);
            } else {
                const saved = localStorage.getItem('liquiditybot.activePool');
                _activePool = (saved && pools.find(p => p.id === saved)) ? saved : (pools[0]?.id ?? null);
            }
        }
        // Preset nur beim ersten Laden wirksam — danach normale Auswahl/localStorage.
        _presetPoolId = null;

        el.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'settings-card';
        el.appendChild(card);
        _renderPoolsTable(card, pools, addrs, opp, hints);

        // Hints alle 5 Min neu laden — aktualisiert Icons in der Dropdown-Liste
        // und den Banner für den aktiven Pool (via _refreshPoolsCard).
        if (_hintsRefreshTimer) clearInterval(_hintsRefreshTimer);
        _hintsRefreshTimer = setInterval(() => _refreshPoolsCard(card), 5 * 60 * 1000);
    } catch (err) {
        el.innerHTML = `<div class="settings-card settings-error">Fehler: ${err.message}</div>`;
    }
}

// ── Ranking-Badge-Helpers ──────────────────────────────────────────────────

/**
 * Tier-Meta: Emoji + Klartext-Code + Langname + Sortier-Priorität.
 * Robust gegen Farbschwäche durch Klartext + Emoji.
 */
const TIER_META = {
    invest:   { score: 1, label: 'Investieren', labelEn: 'Invest',   prio: 1 },
    hold:     { score: 2, label: 'Halten',      labelEn: 'Hold',     prio: 2 },
    withdraw: { score: 3, label: 'Abziehen',    labelEn: 'Withdraw', prio: 3 },
    // Alt-Eintrag: vor dem Tier-Refactor 2026-05-18 existierten "observe"-Einträge
    // in pool_score_history. Die werden für die Anzeige als "Halten" behandelt;
    // neue Snapshots produzieren nie mehr observe.
    observe:  { score: 2, label: 'Halten',      labelEn: 'Hold',     prio: 2 },
};

function _tierMeta(tier) {
    return TIER_META[tier] ?? { score: null, label: 'ohne Tier', labelEn: 'unknown', prio: 99 };
}

function _buildRankingBadge(score, scores, pool) {
    if (!score || score.error) {
        return '<span class="pool-summary-off">' + tr('sliq.no_rating', '— keine Bewertung —') + '</span>';
    }
    const econ = score.economic;
    if (econ?.tier) {
        const m = _tierMeta(econ.tier);
        return `<span class="ranking-info">${tr('sliq.current_recommendation', 'Aktuelle Empfehlung: {tier}', { tier: m.labelEn })}</span>`;
    }
    return '<span class="pool-summary-off">' + tr('sliq.no_data_yet', '— noch keine Daten —') + '</span>';
}

function _findOppScore(opp, poolId) {
    if (!opp?.available) return null;
    return opp.pools?.find(p => p.id === poolId) ?? null;
}

function _poolLabel(p) {
    const raw = p.investScore?.value;
    // Kein Score ohne Premium-Datenzugang (scoreSource === 'none') – Krone statt "---",
    // gleiches Icon wie Dashboard/Header (siehe _premiumLink() in html/liquidity/js/app.js).
    const score = raw != null ? String(Math.round(raw)).padStart(3, '0') : '👑';
    return `[${score}] ${p.displayPair ?? p.pair}`;
}

function _initPoolPicker(card, pools, addrs, opp, hints = []) {
    const input        = card.querySelector('#pool-picker-input');
    const drop         = card.querySelector('#pool-picker-drop');
    const typeFilter   = card.querySelector('#pool-type-filter');
    const activeFilter = card.querySelector('#pool-active-filter');
    if (!input || !drop) return;

    const opts = pools.map(p => ({
        id:       p.id,
        label:    _poolLabel(p),
        active:   p.active,
        enabled:  p.enabled !== false,
        key:      (p.displayPair ?? p.pair).toLowerCase(),
        score:    p.investScore?.value ?? -Infinity,
        poolType: p.poolType ?? null,
    })).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

    // Aufgabe 2/3: Status-Optionen (Aktiv/Inaktiv/Deaktiviert) dürfen nur
    // wählbar sein, wenn es in der aktuellen Typ-Auswahl mindestens einen
    // passenden Pool gibt. Ist die gerade gewählte Option nicht mehr gültig,
    // zurück auf "Alle" springen.
    function _updateStatusFilterOptions(typeFilterVal) {
        if (!activeFilter) return;
        let list = opts;
        if (typeFilterVal !== 'all') list = list.filter(o => o.poolType === typeFilterVal);
        const hasActive      = list.some(o => o.active);
        const hasInactive    = list.some(o => !o.active && o.enabled);
        const hasDeactivated = list.some(o => !o.enabled);
        const optActive      = activeFilter.querySelector('option[value="active"]');
        const optInactive    = activeFilter.querySelector('option[value="inactive"]');
        const optDeactivated = activeFilter.querySelector('option[value="deactivated"]');
        if (optActive)      optActive.disabled      = !hasActive;
        if (optInactive)    optInactive.disabled    = !hasInactive;
        if (optDeactivated) optDeactivated.disabled = !hasDeactivated;
        if ((_poolActiveFilter === 'active' && !hasActive)
            || (_poolActiveFilter === 'inactive' && !hasInactive)
            || (_poolActiveFilter === 'deactivated' && !hasDeactivated)) {
            _poolActiveFilter = 'all';
            localStorage.setItem('liquiditybot.poolActiveFilter', _poolActiveFilter);
            activeFilter.value = 'all';
        }
    }

    // Aufgabe 1: passt der aktuell aktive Pool nach einem Filter-Wechsel nicht
    // mehr zu Typ- UND Status-Filter, auf den Pool mit dem höchsten Score aus
    // der neuen Auswahl wechseln. Wird von beiden Filtern (Typ + Status) genutzt.
    function _poolMatchesFilters(p) {
        if (_poolTypeFilter !== 'all' && p.poolType !== _poolTypeFilter) return false;
        const enabled = p.enabled !== false;
        if (_poolActiveFilter === 'active')      return p.active === true;
        if (_poolActiveFilter === 'inactive')    return p.active !== true && enabled;
        if (_poolActiveFilter === 'deactivated') return !enabled;
        return true;
    }

    // Sorgt dafür, dass ein Pool-Wechsel dem Nutzer nicht entgeht (er bearbeitet
    // sonst evtl. unbemerkt einen anderen Pool als gedacht).
    function _notifyPoolSwitch(poolId) {
        const p = pools.find(x => x.id === poolId);
        if (p) _ctx.showToast?.(tr('sliq.pool_switched', 'Pool gewechselt: {pool}', { pool: p.displayPair ?? p.pair }), 'info');
    }

    function _switchToBestMatchIfNeeded() {
        const current = pools.find(p => p.id === _activePool);
        if (current && _poolMatchesFilters(current)) return false;
        const candidates = pools
            .filter(_poolMatchesFilters)
            .sort((a, b) => (b.investScore?.value ?? -Infinity) - (a.investScore?.value ?? -Infinity));
        if (candidates[0] && candidates[0].id !== _activePool) {
            _activePool = candidates[0].id;
            localStorage.setItem('liquiditybot.activePool', _activePool);
            _notifyPoolSwitch(_activePool);
            return true;
        }
        return false;
    }

    if (typeFilter && !typeFilter.dataset.bound) {
        typeFilter.dataset.bound = '1';
        typeFilter.innerHTML = `<option value="all">${tr('liq.all_types', 'Alle Typen')}</option>`
            + Object.entries(POOL_TYPE_LABELS).map(([val, label]) =>
                `<option value="${_esc(val)}">${_esc(label)}</option>`).join('');
        typeFilter.value = _poolTypeFilter;
        typeFilter.addEventListener('change', () => {
            _poolTypeFilter = typeFilter.value;
            localStorage.setItem('liquiditybot.poolTypeFilter', _poolTypeFilter);

            _updateStatusFilterOptions(_poolTypeFilter);
            const poolChanged = _switchToBestMatchIfNeeded();

            if (poolChanged) {
                _renderPoolsTable(card, pools, addrs, opp, hints);
            } else {
                // Leere Query wie beim focus-Handler: der stehengebliebene Text im
                // Suchfeld (Name des zuletzt gewählten Pools) darf die Liste hier
                // nicht zusätzlich einschränken.
                renderDrop('');
                drop.style.display = '';
            }
        });
    }

    if (activeFilter && !activeFilter.dataset.bound) {
        activeFilter.dataset.bound = '1';
        activeFilter.innerHTML = `
            <option value="all">${tr('sliq.filter_all', 'Alle')}</option>
            <option value="active">${tr('sliq.filter_active', 'Aktiv')}</option>
            <option value="inactive">${tr('sliq.filter_inactive', 'Inaktiv')}</option>
            <option value="deactivated">${tr('sb.disabled', 'Deaktiviert')}</option>`;
        activeFilter.value = _poolActiveFilter;
        activeFilter.addEventListener('change', () => {
            _poolActiveFilter = activeFilter.value;
            localStorage.setItem('liquiditybot.poolActiveFilter', _poolActiveFilter);

            const poolChanged = _switchToBestMatchIfNeeded();

            if (poolChanged) {
                _renderPoolsTable(card, pools, addrs, opp, hints);
            } else {
                renderDrop('');
                drop.style.display = '';
            }
        });
    }

    _updateStatusFilterOptions(_poolTypeFilter);

    function renderDrop(q) {
        let list = q ? opts.filter(o => o.key.includes(q.toLowerCase())) : opts;
        if (_poolTypeFilter !== 'all') list = list.filter(o => o.poolType === _poolTypeFilter);
        if (_poolActiveFilter === 'active')      list = list.filter(o => o.active);
        if (_poolActiveFilter === 'inactive')    list = list.filter(o => !o.active && o.enabled);
        if (_poolActiveFilter === 'deactivated') list = list.filter(o => !o.enabled);
        drop.innerHTML = list.map(o => {
            const hint = _advisorHints.some(h => h.poolId === o.id) ? ' &#9888;' : '';
            const inactive = !o.enabled ? tr('sb.suffix_deactivated', ' (deaktiviert)') : (o.active ? '' : tr('sb.suffix_inactive', ' (inaktiv)'));
            return `<div class="pool-picker-opt${o.active ? '' : ' pp-inactive'}"
                 data-pool-id="${_esc(o.id)}"
                 ${o.id === _activePool ? 'data-active="true"' : ''}>
                ${_esc(o.label)}${hint}${inactive}
            </div>`;
        }).join('');
        drop.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('focus', () => {
        renderDrop('');
        drop.style.display = '';
    });
    input.addEventListener('input', () => {
        renderDrop(input.value);
        drop.style.display = '';
    });
    input.addEventListener('blur', () => {
        setTimeout(() => {
            drop.style.display = 'none';
            const cur = pools.find(p => p.id === _activePool) ?? pools[0];
            if (cur) input.value = _esc(cur.displayPair ?? cur.pair);
        }, 150);
    });
    drop.addEventListener('mousedown', e => {
        const opt = e.target.closest('.pool-picker-opt');
        if (!opt) return;
        _activePool = opt.dataset.poolId;
        localStorage.setItem('liquiditybot.activePool', _activePool);
        _notifyPoolSwitch(_activePool);
        drop.style.display = 'none';
        _renderPoolsTable(card, pools, addrs, opp, hints);
        card.classList.remove('card-pool-switch-flash');
        void card.offsetWidth;
        card.classList.add('card-pool-switch-flash');
        card.addEventListener('animationend', () => card.classList.remove('card-pool-switch-flash'), { once: true });
    });
}

/**
 * Baut das persistente Tab-Gerüst ("Liquidity Pools" / "Pool Typen") einmalig in `card`
 * auf. `_renderPoolsTable()` schreibt danach nur noch in das innere `#pool-panel-pools`,
 * damit wiederholte Refreshes (5-Min-Timer, nach Aktionen) den "Pool Typen"-Tab nicht
 * zurücksetzen, falls der Nutzer dort gerade ist.
 */
function _ensurePoolTabsScaffold(card) {
    if (card.dataset.tabsInit) return;
    card.dataset.tabsInit = '1';
    card.innerHTML = `
        <div class="wm-tab-bar">
            <button type="button" class="wm-tab active" data-tab="pools">${tr('sliq.liquidity_pools', 'Liquidity Pools')}</button>
            <button type="button" class="wm-tab" data-tab="types">${tr('sliq.pool_types', 'Pool Typen')}</button>
        </div>
        <div id="pool-panel-pools"></div>
        <div id="pool-panel-types" hidden></div>`;

    card.querySelectorAll('.wm-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            card.querySelectorAll('.wm-tab').forEach(b => b.classList.toggle('active', b === btn));
            const tab = btn.dataset.tab;
            card.querySelector('#pool-panel-pools').hidden = tab !== 'pools';
            const typesPanel = card.querySelector('#pool-panel-types');
            typesPanel.hidden = tab !== 'types';
            if (tab === 'types' && !typesPanel.dataset.loaded) {
                typesPanel.dataset.loaded = '1';
                _renderPoolTypesTab(typesPanel);
            }
        });
    });
}

function _renderPoolsTable(card, pools, addrs, opp, hints = []) {
    // Sortierung nach InvestScore (gleiche Logik wie Dashboard)
    pools = [...pools].sort((a, b) => {
        const sa = a.investScore?.value ?? -Infinity;
        const sb = b.investScore?.value ?? -Infinity;
        if (sa !== sb) return sb - sa;
        return (a.displayPair ?? a.pair).localeCompare(b.displayPair ?? b.pair);
    });
    const pool = pools.find(p => p.id === _activePool) ?? pools[0];
    _ensurePoolTabsScaffold(card);
    const panel = card.querySelector('#pool-panel-pools');
    if (!pool) {
        panel.innerHTML = `<p class="wallet-hint">${tr('sliq.no_pools', 'Keine Pools konfiguriert.')}</p>`;
        return;
    }

    // Solange der Bot nicht läuft, können Pool-Daten veraltet sein (letzter
    // Stand vor dem Stopp) – Pool-Zeile zeigt dann einen eindeutigen Platzhalter
    // statt einer Auswahl, alle Aktionen sind gesperrt (siehe analoger Fund/Fix
    // beim Lending Bot).
    const noData = _ctx.getStatus?.(SVC_ID) !== 'active';

    const activeHint = hints.find(h => h.poolId === pool.id) ?? null;

    // Benutzer-Freigabe (enabled) vs. operativer Zustand (active):
    //   enabled=false → Pool gesperrt, nimmt kein Kapital auf (User oder TVL-Exit).
    //   active=true   → Pool hält offene Position → kann nicht deaktiviert werden.
    const poolEnabled = pool.enabled !== false;
    const hasBalance  = pool.active === true;
    // Dry-Run-Gate (pool-offers.md Schritt 6): über einen Pool-Offer übernommene Pools
    // (pool.premiumOffer) dürfen erst aktiviert werden, wenn pool-offers-dryrun.js einen
    // erfolgreichen deposit.js --dry-run bestätigt hat. Korrigiert 2026-09-04 (LIQ#0380):
    // vorher lautete das Kriterium cleanup.rankingEligible===false — das setzt aber auch
    // der ganz normale Modus "Cleanup inaktiv" (kein Offer-Bezug), wodurch so ein Pool nie
    // wieder aktivierbar war, weil pool-offers-dryrun.js für ihn nie ein Gate erzeugt.
    const isOfferPool = !!pool.premiumOffer;
    const dryRunGate   = pool.settings?.dryRunGate ?? null;
    const gateBlocked  = isOfferPool && dryRunGate?.status !== 'passed';
    // Tatsächlicher Cleanup-Status (unabhängig von der Herkunft) — separat von isOfferPool,
    // seit das dort nicht mehr dasselbe ist (LIQ#0380). Bestimmt, was das Select unten als
    // aktuell ausgewählt anzeigt.
    const cleanupIneligible = pool.settings?.cleanup?.rankingEligible === false;

    // Tooltip-Text fürs (i)-Icon neben einem gesperrten Aktivieren-Button: wann + warum,
    // damit ein gesperrter Pool nicht wie ein stiller Bug aussieht (Fund 2026-08-06:
    // forge-pub1 PUMP/SOL ohne erkennbaren Grund deaktiviert, siehe setPoolEnabled()).
    function disabledSinceTooltip() {
        const when = pool.enabledChangedAt
            ? new Intl.DateTimeFormat(NUM_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' })
                .format(new Date(pool.enabledChangedAt))
              + ' um ' + new Intl.DateTimeFormat(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' })
                .format(new Date(pool.enabledChangedAt)) + ' Uhr'
            : tr('sliq.unknown_time', 'unbekanntem Zeitpunkt');
        const reason = pool.enabledReason ?? tr('sliq.no_reason_logged', 'Grund nicht protokolliert');
        return `<span class="info-tip-label pool-disabled-hint"
            data-tooltip-title="${tr('sliq.pool_locked', '🔒 Pool gesperrt')}"
            data-tooltip-content="${_escTip(tr('sliq.disabled_since', 'Dieser Pool wurde am {when} deaktiviert.\n\nGrund: {reason}', { when, reason }))}">&#9432;</span>`;
    }

    // Kapitalfluss-Modus (LIQ#0365): fasst enabled + cleanup.rankingEligible zu einer
    // geordneten Drei-Stufen-Auswahl zusammen — ersetzt den früheren Aktivieren/
    // Deaktivieren-Button und das dafür unerreichbare Ranking-Modal.
    const currentMode = !poolEnabled ? 'disabled' : (cleanupIneligible ? 'cleanup-inactive' : 'cleanup-active');
    const MODE_LABELS = {
        disabled:         tr('sliq.mode_disabled', 'Deaktiviert'),
        'cleanup-inactive': tr('sliq.mode_cleanup_inactive', 'Cleanup inaktiv'),
        'cleanup-active':   tr('sliq.mode_cleanup_active', 'Cleanup aktiv'),
    };

    // 'disabled' ist gesperrt, solange eine offene Position besteht (Guthaben muss
    // erst vollständig ausgezahlt werden) — derselbe Wortlaut wie am alten Button.
    const disabledOptionAttrs = hasBalance
        ? `disabled title="${_esc(tr('sliq.cannot_deactivate_tip', 'Pool hält eine offene Position. Erst vollständig auszahlen, dann deaktivieren.'))}"`
        : '';
    // Beide Cleanup-Stufen sind gesperrt, solange das Dry-Run-Gate für eine aktuell
    // gesetzte Cleanup-Sperre noch nicht bestanden ist — derselbe Wortlaut wie am
    // alten Button (native <option title> statt Forge-Tooltip, da ein Browser-Select
    // seine Optionen ohne DOM/JS-Zugriff rendert).
    const gateOptionAttrs = gateBlocked
        ? `disabled title="${_esc(dryRunGate?.status === 'failed'
            ? tr('sliq.dryrun_failed', 'Dry-Run-Testlauf fehlgeschlagen: {error}. Wird automatisch erneut versucht.', { error: dryRunGate.error ?? tr('sliq.unknown_error_short', 'unbekannter Fehler') })
            : tr('sliq.dryrun_pending_tip', 'Automatischer Testlauf (deposit.js --dry-run) läuft noch – wartet auf erste Pool-Daten (~1 Bot-Zyklus nach der Übernahme).'))}"`
        : '';

    // Die gerade aktive Option nie sperren — sonst zeigt der Browser eine
    // selected+disabled Option (Zustand kann verlassen, aber nicht "gehalten" werden).
    const modeOption = (value, attrs) =>
        `<option value="${value}" ${currentMode === value ? 'selected' : ''} ${currentMode === value ? '' : attrs}>${_esc(MODE_LABELS[value])}</option>`;

    // (i)-Icon mit Datum+Grund bleibt neben dem Select, sobald Modus 'disabled' ist —
    // unabhängig davon ob der Bot selbst gesperrt hat (z.B. TVL-Voll-Exit) oder ob es
    // manuell geschah (Fund 2026-08-06: gesperrter Pool ohne erkennbaren Grund sah wie ein
    // stiller Bug aus).
    const modeHtml = `${!poolEnabled ? disabledSinceTooltip() : ''}<select id="pool-mode-select" class="pool-type-filter${!poolEnabled ? ' btn-pool-disabled' : ''}" style="margin-left:0">
            ${modeOption('disabled', disabledOptionAttrs)}
            ${modeOption('cleanup-inactive', gateOptionAttrs)}
            ${modeOption('cleanup-active', gateOptionAttrs)}
        </select>`;

    panel.innerHTML = `
        <table class="wallet-action-table">
            <tbody>
                <tr>
                    <td class="wat-label">${tr('liq.pool', 'Pool')}</td>
                    <td class="wat-info">
                        <div style="display:flex;align-items:center">
                            <div class="pool-picker" id="pool-picker">
                                <input type="text" id="pool-picker-input" class="modal-input pool-select"
                                       autocomplete="off" spellcheck="false"
                                       placeholder="${tr('liq.search_pool', 'Pool suchen…')}"
                                       value="${_esc(pool.displayPair ?? pool.pair)}">
                                <div id="pool-picker-drop" class="pool-picker-drop" style="display:none"></div>
                            </div>
                            <select id="pool-type-filter" class="pool-type-filter"></select>
                            <select id="pool-active-filter" class="pool-type-filter"></select>
                        </div>
                    </td>
                    <td class="wat-action">
                        ${modeHtml}
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        ${tr('sliq.max_investment', 'Max Investment')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.max_investment', 'Max Investment')}"
                            data-tooltip-content="${tr('sliq.max_investment_tip', 'Begrenzt, wie viel Kapital per Cleanup-Reinvest oder manueller Einzahlung maximal in diesen Pool fließen darf – schützt vor Übergewichtung in volatilen Pools.||Wird nur beim Hineinlegen geprüft: Autocompounding läuft unverändert weiter, ein bereits über der Grenze liegender Bestand wird nicht automatisch reduziert.||Leer = unbegrenzt (Standard).')}">&#9432;</span>
                        ${_ndMarker(pool, ['maxInvestment'])}
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">${_buildMaxInvestmentSummary(pool)}</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-maxinv">${tr('sb.manage', 'Verwalten')}</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        ${tr('liq.range', 'Range')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.range_rebalance', 'Range &amp; Rebalance')}"
                            data-tooltip-content="${tr('sliq.range_tip', 'Zeigt die aktuelle Position-Range und ermöglicht einen manuellen Rebalance (Position wird geschlossen und mit neuer Range neu eröffnet).')}">&#9432;</span>
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">${tr('sliq.range_summary', 'Range anzeigen und manuell rebalancen.')}</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-rebalance"
                            ${activeHint ? `style="background:var(--accent);color:#000;border-color:var(--accent);"
                            data-tooltip-title="${tr('sliq.range_hint_title', 'Range-Empfehlung (Konfidenz: {conf})', { conf: activeHint.confidence === 'high' ? tr('sliq.conf_high', 'hoch') : tr('sliq.conf_mid', 'mittel') })}"
                            data-tooltip-content="${tr('sliq.range_hint_tip', 'Range nicht mehr optimal: ±{cur}% → ±{rec}%.', { cur: activeHint.currentPct, rec: activeHint.recommendedPct })}${activeHint.paybackHours != null ? tr('sliq.range_hint_payback', '|Reopen amortisiert in ~{hours} Stunden.', { hours: Math.round(activeHint.paybackHours) }) : ''}${tr('sliq.range_hint_action', '|Verwalten → Rebalance um die Empfehlung sofort umzusetzen.|Ohne Aktion wird die neue Range beim nächsten natürlichen Rebalance automatisch übernommen.')}"` : ''}>${tr('sb.manage', 'Verwalten')}</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Fee Claim
                        <span class="info-tip-label"
                            data-tooltip-title="Fee Claim"
                            data-tooltip-content="${tr('sliq.fee_claim_tip', 'Steuert ab welchem Betrag Fees geclaimed werden und was danach damit passiert.\n\nAuto Compounding: Fees sofort wieder in den Pool reinvestieren (ganz oder anteilig).\n\nSenden an: Verbleibende Fees optional an eine Adresse senden – ggf. vorher in USDC tauschen.')}">&#9432;</span>
                        ${_ndMarker(pool, ['autoCompound'])}
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">${tr('sliq.fee_claim_summary', 'Regelt den Umgang mit den Fee-Einnahmen.')}</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-ac">${tr('sb.manage', 'Verwalten')}</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        ${tr('sliq.risk_management', 'Risk-Management')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.risk_management', 'Risk-Management')}"
                            data-tooltip-content="${tr('sliq.risk_tip', 'Zwei voneinander unabhängige Schutzmechanismen:||Score Limit: Schließt die Position automatisch, sobald der Opportunity Score des Pools unter eine einstellbare Schwelle fällt.||Trailing Stop (TS): Schließt die Position, wenn der Pool-Wert um einen einstellbaren Prozentsatz unter den bisherigen Höchststand fällt (High-Water-Mark).||Bei beiden Mechanismen kann das entnommene Kapital optional in USDC getauscht und an eine Adresse gesendet werden.')}">&#9432;</span>
                        ${_ndMarker(pool, ['scoreLimit', 'trailingStop', 'tvlProtection'])}
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">${_buildSafetySummary(pool)}</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-sltp">${tr('sb.manage', 'Verwalten')}</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        ${tr('sb.deposit', 'Einzahlen')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.deposit_into_pool', 'In den Pool einzahlen')}"
                            data-tooltip-content="${tr('sliq.deposit_tip', 'Fügt der bestehenden Pool-Position Kapital hinzu, oder eröffnet eine neue Position wenn der Pool gerade inaktiv ist.\n\nZwei Modi:\n• USDC-Betrag: Wallet-USDC wird in beide Pool-Tokens geswappt.\n• Wallet-Coins: Vorhandene Pool-Tokens werden direkt verwendet, kein Swap.')}">&#9432;</span>
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">${tr('sliq.deposit_summary', 'Liquidität dem Pool hinzufügen.')}</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-deposit"
                            ${pool.uiDepositDisabled ? 'disabled title="' + tr('sliq.deposit_refpool', 'Preis-Referenzpool – keine Einzahlungen möglich') + '"'
                              : (!poolEnabled ? 'disabled data-tooltip-title="' + tr('sliq.pool_deactivated', 'Pool deaktiviert') + '" data-tooltip-content="' + tr('sliq.pool_deactivated_tip', 'Pool ist deaktiviert – erst aktivieren, dann einzahlen.') + '"' : '')}>${tr('sb.deposit', 'Einzahlen')}</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        ${tr('sb.withdraw', 'Auszahlen')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.withdraw_from_pool', 'Aus dem Pool auszahlen')}"
                            data-tooltip-content="${tr('sliq.withdraw_tip', 'Entnimmt Liquidität aus der bestehenden Pool-Position. Optional können die entnommenen Coins vor dem Verbleib im Wallet in USDC getauscht und/oder an eine Adresse gesendet werden.\n\nZwei Modi:\n• USDC-Wert: Liquidität im Gegenwert dieses USDC-Betrags wird proportional entnommen.\n• Token-Menge: Anteilige Entnahme über einen Pool-Token als Anker — beide Seiten kommen anteilig zurück.')}">&#9432;</span>
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">${tr('sliq.withdraw_summary', 'Liquidität aus dem Pool entfernen.')}</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-withdraw" ${pool.active ? '' : 'disabled'}>${tr('sb.withdraw', 'Auszahlen')}</button>
                    </td>
                </tr>
            </tbody>
        </table>
        ${noData
            ? `<p class="wallet-hint" style="margin-top:0.5rem; font-size:0.78rem;">${tr('sliq.no_pool_data_hint', 'Noch keine verlässlichen Pool-Daten – prüfe oben in der Zeile "Status", ob der Liquidity Bot läuft.')}</p>`
            : (currentMode === 'disabled'
                ? `<p class="wallet-hint" style="margin-top:0.5rem; font-size:0.78rem;">${tr('sliq.pool_off_hint', '&#128274; Pool deaktiviert – nimmt kein Kapital auf (kein Cleanup-Reinvest), bis er wieder aktiviert wird. Einstellungen können trotzdem gespeichert werden.')}</p>`
                : (currentMode === 'cleanup-inactive'
                    ? `<p class="wallet-hint" style="margin-top:0.5rem; font-size:0.78rem;">${tr('sliq.pool_cleanup_inactive_hint', '&#9888; Cleanup inaktiv – der automatische Cleanup („Bester Pool“) legt kein neues Kapital hinein. Bestehende Position, manuelle Einzahlung/Auszahlung und Risk-Management laufen unverändert weiter.')}</p>`
                    : (!pool.active ? `<p class="wallet-hint" style="margin-top:0.5rem; font-size:0.78rem;">${tr('sliq.pool_idle_hint', '&#9888; Pool ruht – keine offene Position. Einstellungen können trotzdem gespeichert werden.')}</p>` : '')))}`;

    if (noData) {
        const input = panel.querySelector('#pool-picker-input');
        if (input) {
            input.value       = '';
            input.placeholder = tr('sliq.activate_bot_first', 'Bitte Liquidity Bot aktivieren');
            input.disabled    = true;
        }
        panel.querySelector('#pool-type-filter')?.setAttribute('disabled', 'disabled');
        panel.querySelector('#pool-active-filter')?.setAttribute('disabled', 'disabled');
        panel.querySelectorAll('.wat-action button, .wat-action select').forEach(b => { b.disabled = true; });
        return;
    }

    _initPoolPicker(card, pools, addrs, opp, hints);

    card.querySelector('#pool-btn-ac')
        ?.addEventListener('click', () => _openFeeClaimModal(pool, addrs, card));
    card.querySelector('#pool-btn-sltp')
        ?.addEventListener('click', () => _openSLTPModal(pool, addrs, card));
    card.querySelector('#pool-btn-maxinv')
        ?.addEventListener('click', () => _openMaxInvestmentModal(pool, card));
    card.querySelector('#pool-btn-rebalance')
        ?.addEventListener('click', () => _openPoolRebalanceModal(pool, activeHint));
    card.querySelector('#pool-mode-select')
        ?.addEventListener('change', (ev) => _setPoolMode(pool, card, ev.target, currentMode));
    card.querySelector('#pool-btn-deposit')
        ?.addEventListener('click', () => _openPoolDepositModal(pool));
    card.querySelector('#pool-btn-withdraw')
        ?.addEventListener('click', () => _openPoolWithdrawModal(pool, addrs));
}

// ── Strategie-Auswahl (LIQ#0372) ──────────────────────────────────────────────
// Backend fertig (lib/strategies.js, bots/settings/lib/strategy-apply.js, siehe KB
// Strategien/strategie-auswahl.md) — hier nur die Oberfläche. "Standard" (Entscheidung 8)
// ist die Abwesenheit einer Strategie, nie ein eigener Feldsatz, deshalb der eigene Pfad
// über POST /api/strategy/standard statt über applyStrategy().

/** Menschlich lesbarer Name je Strategie-ID — die IDs selbst bleiben stabile Backend-Werte. */
function _strategyName(id) {
    switch (id) {
        case 'ruhiges_kapital':    return tr('sliq.strategy_name_ruhiges_kapital', 'Ruhiges Kapital');
        case 'fee_ernte':          return tr('sliq.strategy_name_fee_ernte', 'Fee-Ernte');
        case 'stablecoin':         return tr('sliq.strategy_name_stablecoin', 'Stablecoin');
        case 'token_maximierung':  return tr('sliq.strategy_name_token_maximierung', 'Token Maximierung');
        case 'lambo':              return tr('sliq.strategy_name_lambo', 'Lambo');
        default:                   return id;
    }
}

/** Klartext-Zusammenfassung je Strategie-ID für den "Funktionsweise"-Tab (LIQ#0385) —
 *  dasselbe Muster wie _strategyName(), fallback ist der `summary` aus /api/strategy. */
function _strategySummary(id, fallback) {
    switch (id) {
        case 'ruhiges_kapital':    return tr('sliq.strategy_summary_ruhiges_kapital', fallback ?? '');
        case 'fee_ernte':          return tr('sliq.strategy_summary_fee_ernte', fallback ?? '');
        case 'stablecoin':         return tr('sliq.strategy_summary_stablecoin', fallback ?? '');
        case 'token_maximierung':  return tr('sliq.strategy_summary_token_maximierung', fallback ?? '');
        case 'lambo':              return tr('sliq.strategy_summary_lambo', fallback ?? '');
        default:                   return fallback ?? '';
    }
}

async function _fetchStrategyContext() {
    const [premium, listRes, statusRes] = await Promise.all([
        _fetchPremiumStatus().catch(() => ({ available: false })),
        fetch('/api/strategy'),
        fetch('/api/strategy/status'),
    ]);
    const strategies = listRes.ok ? await listRes.json() : [];
    const active      = statusRes.ok ? await statusRes.json() : { strategyId: null, appliedAt: null, version: null };
    return { premium, strategies, active };
}

/** Eigenes kleines Table-Fragment, gleiches Muster wie _loadAndRenderCleanupRow() daneben —
 *  beide sind globale Installationseinstellungen, kein Pool-individueller Zustand. */
async function _loadAndRenderStrategyRow(wrap) {
    const ctx = await _fetchStrategyContext();
    wrap.innerHTML = `<table class="wallet-action-table"><tbody>${_strategyRowHtml(ctx)}</tbody></table>`;

    const strategySelect = wrap.querySelector('#strategy-select');
    strategySelect?.addEventListener('change', () => _onStrategyChange(strategySelect, wrap, ctx));
    wrap.querySelector('#strategy-details-btn')?.addEventListener('click', () =>
        _openStrategyDetailsModal(strategySelect?.value ?? (ctx.active.strategyId ?? 'standard'), ctx));
}

/** Nach einem Strategie-Schreibvorgang: die eigene Zeile neu laden (neue aktive Strategie/
 *  Abweichungen) UND, falls gerade offen, die Pool-Tabelle (nondefault-Marker, Safety-
 *  Summary usw. ändern sich durch den Bulk-Write tatsächlich). */
async function _refreshStrategyUI(wrap) {
    await _loadAndRenderStrategyRow(wrap);
    const poolsEl = _container?.querySelector('.liquiditybot-grid-pools');
    if (poolsEl) await _renderPools(poolsEl);
}

function _strategyRowHtml(ctx) {
    // Freischaltung über status.entitled (KB Strategien/strategie-auswahl.md).
    // 🔒 Bewusst NICHT zusätzlich auf status.available geprüft (anders als das bestehende
    // Premium-Badge, das sich auf dem Master ganz ausblendet): Der Master liefert available
    // immer false (routes/premium.js) — eine Kopplung daran würde die Zeile dort komplett
    // unsichtbar machen und wäre auf dem Entwicklungssystem nie überprüfbar.
    // LIQ#0381: Auf dem Master liefert routes/premium.js seit Variante A bewusst
    // entitled: true (ohne Premium-Wallet) — der Master ist Urheber der Strategien, ein
    // Gate gegen sich selbst ist sinnlos.
    // 🔒 LIQ#0388: hier stand `enabled` — der AUTOPAY-Schalter. Damit war die Auswahl auf
    // jedem berechtigten, aber nicht zahlenden Host gesperrt (forge-pub1 über die
    // Systemdaten-Freigabe). Dieselbe Verwechslung wie beim Rückfall-Auslöser in
    // bots/settings/lib/strategy-apply.js, deshalb hier mit korrigiert.
    const locked = !ctx.premium?.entitled;

    // LIQ#0379, Punkt 3: Ohne Premium keine Optionen anbieten, die ohnehin nicht wählbar
    // sind — Ausnahme die eine laufende, eingefrorene Strategie (Nebenpunkt 1 unten), sonst
    // stünde dort scheinbar "Standard", obwohl in Wahrheit etwas anderes aktiv ist.
    const standardOption = `<option value="standard" ${!ctx.active.strategyId ? 'selected' : ''}>${_esc(tr('sliq.strategy_standard', 'Standard'))}</option>`;
    const activeStrategyMeta = ctx.strategies.find(s => s.id === ctx.active.strategyId);
    const options = locked
        ? [
            standardOption,
            ...(activeStrategyMeta
                ? [`<option value="${activeStrategyMeta.id}" selected>${_esc(_strategyName(activeStrategyMeta.id))}</option>`]
                : []),
        ].join('')
        : [
            standardOption,
            ...ctx.strategies.map(s => `<option value="${s.id}" ${ctx.active.strategyId === s.id ? 'selected' : ''}>${_esc(_strategyName(s.id))}</option>`),
        ].join('');

    // LIQ#0373, Nebenpunkt 1: zwei Fälle hinter demselben "gesperrt" sind nicht dasselbe.
    // Läuft bereits eine Strategie und ist nur Premium ausgelaufen, läuft sie unverändert
    // weiter (Entscheidung 6, Einfrieren) — "erst aktivieren" wäre dort schlicht falsch.
    const lockedAttrs = locked
        ? (ctx.active.strategyId
            ? `disabled data-tooltip-title="${tr('sliq.strategy_locked_frozen_title', 'Strategie eingefroren')}" data-tooltip-content="${_esc(tr('sliq.strategy_locked_frozen_tip', '„{name}" läuft mit den zuletzt gelieferten Werten unverändert weiter. Ohne Premium lässt sie sich nur nicht mehr ändern.', { name: _strategyName(ctx.active.strategyId) }))}"`
            : `disabled data-tooltip-title="${tr('sliq.strategy_locked_title', 'Premium erforderlich')}" data-tooltip-content="${_esc(tr('sliq.strategy_locked_tip', 'Strategien sind Teil des Premium-Zugangs. Erst oben in der Premium-Zeile aktivieren.'))}"`)
        : '';

    return `
        <tr>
            <td class="wat-label">
                <div style="display:flex;align-items:center;gap:0.4rem;">
                    ${tr('sliq.strategy', 'Strategie')}
                    <span class="info-tip-label"
                        data-tooltip-title="${tr('sliq.strategy', 'Strategie')}"
                        data-tooltip-content="${tr('sliq.strategy_tip', 'Eine gewählte Risikohaltung setzt Ausstiege, Wiedereinstieg und Range-Verhalten automatisch für alle passenden Pools. Wirkt global für die ganze Installation, nicht nur für den hier ausgewählten Pool.||„Standard" ist keine eigene Strategie: Der Wechsel dahin nimmt die von der vorherigen Strategie gesetzten Felder zurück, soweit sie seither unverändert sind – danach zählen nur noch individuell gesetzte Werte.')}">&#9432;</span>
                </div>
            </td>
            <td class="wat-info">
                <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
                    <select id="strategy-select" class="pool-type-filter strategy-select" style="margin-left:0" ${lockedAttrs}>${options}</select>
                </div>
            </td>
            <td class="wat-action">
                <button class="btn btn-secondary btn-sm" id="strategy-details-btn" ${locked ? 'disabled' : ''}>${tr('sliq.details', 'Details')}</button>
            </td>
        </tr>`;
}

/** "Unterstützte Pools"-Tab: Pools im Geltungsbereich gegen das globale Score-Gate
 *  (CLEANUP_MIN_SCORE), das unabhängig von der Strategie über die automatische
 *  Investition entscheidet (bin/cleanup.js). Bewusst ein clientseitiger Join dreier
 *  bereits vorhandener Endpunkte (Scope aus /preview, InvestScore aus /pools/liquidity,
 *  Schwelle aus /config/liquiditybot) statt eines neuen Backend-Endpunkts — Rücksprache
 *  Festlegung 2026-09-04: „reicht erstmal, wird vermutlich noch öfter umgebaut". */
function _renderStrategySupportedPoolsHtml(scopePools, poolsById, minScore) {
    if (!scopePools.length) {
        return `<p class="wallet-hint">${tr('sliq.strategy_no_pools_in_scope', 'Kein Pool im Geltungsbereich dieser Strategie.')}</p>`;
    }
    const rows = scopePools.map(p => {
        const score = poolsById.get(p.poolId)?.investScore?.value ?? null;
        const qualifies = score != null && score >= minScore;
        const qualifiedCell = qualifies
            ? `<span style="color:var(--success);">✓</span>`
            : `<span style="color:var(--danger);">✗</span>`;
        return `
            <tr>
                <td>${_esc(p.pair)}</td>
                <td style="text-align:center;">${score != null ? score : '–'}</td>
                <td style="text-align:center;">${minScore}</td>
                <td style="text-align:center;">${qualifiedCell}</td>
            </tr>`;
    }).join('');
    return `
        <div style="max-height:280px;overflow:auto;">
        <table class="wallet-action-table">
            <thead><tr style="color:var(--text-muted);font-size:0.78rem;text-align:left;">
                <th>${tr('liq.pool', 'Pool')}</th>
                <th style="text-align:center;">${tr('sliq.strategy_pool_score', 'Score aktuell')}</th>
                <th style="text-align:center;">${tr('sliq.strategy_pool_gate', 'Score-Gate')}</th>
                <th style="text-align:center;">${tr('sliq.strategy_pool_qualified', 'Qualifiziert')}</th>
            </tr></thead>
            <tbody style="font-size:0.82rem;">${rows}</tbody>
        </table>
        </div>`;
}

/** Menschlich lesbarer Wert für die Rücknahme-Vorschau (LIQ#0384) — dasselbe Muster wie
 *  die frühere `_fmtStrategyVal()` aus LIQ#0368, die mit dem Wegfall der Feldsatz-Tabelle
 *  (LIQ#0385) mitentfernt wurde. Hier wieder gebraucht: Anders als beim Anwenden ist eine
 *  Rücknahme nicht aus dem Strategietext ablesbar, sie MUSS gezeigt werden (Ticket-Vorgabe). */
function _fmtRollbackVal(v) {
    if (v === null || v === undefined) return tr('sliq.strategy_val_none', 'kein Wert');
    if (typeof v === 'boolean') return v ? tr('sb.on', 'An') : tr('sb.off', 'Aus');
    return String(v);
}

function _strategyRollbackSkipReasonText(reason) {
    switch (reason) {
        case 'deferred_open_position': return tr('sliq.strategy_reason_deferred', 'wartet auf Positionsende');
        case 'locked':                 return tr('sliq.strategy_reason_locked', 'Range fest verankert (locked)');
        case 'no_range_slot':          return tr('sliq.strategy_reason_no_slot', 'kein Range-Slot vorhanden');
        default:                       return reason ?? '';
    }
}

/** Vorschau der Rücknahme vor dem Wechsel auf "Standard" (LIQ#0384) — zeigt konkret, welche
 *  Felder auf welchen Pools zurückgenommen werden und welche wegen einer offenen Position
 *  zurückgestellt bleiben (Entscheidung 5, rückwärts). Bewusst eine schlanke Liste statt der
 *  früheren vierspaltigen Tabelle (LIQ#0385 hat die für den Anwenden-Flow bereits entfernt,
 *  zugunsten des Klartexts) — hier aber nicht verzichtbar: Anders als beim Anwenden steht
 *  das Ergebnis nirgends im Strategietext, das Ticket verlangt ausdrücklich Sichtbarkeit. */
function _renderStrategyRollbackPreviewHtml(result) {
    const pools = result?.pools ?? [];
    if (!pools.length) {
        return `<p class="wallet-hint">${tr('sliq.strategy_standard_no_changes', 'Nichts zurückzunehmen – keine Felder stehen noch auf einem von der Strategie gesetzten Wert.')}</p>`;
    }
    const items = pools.flatMap(p => [
        ...p.reverted.map(i => `<li>${_esc(p.pair)} — <b>${_esc(i.field)}</b>: ${_esc(_fmtRollbackVal(i.from))} → ${_esc(_fmtRollbackVal(i.to))}</li>`),
        ...p.skipped.map(i => `<li style="color:var(--text-muted);">${_esc(p.pair)}${p.hasOpenPosition ? ` (${tr('sliq.strategy_open_position', 'offene Position')})` : ''} — <b>${_esc(i.field)}</b>: ${tr('sliq.strategy_status_skip', 'ausgelassen')} – ${_esc(_strategyRollbackSkipReasonText(i.reason))}</li>`),
    ]);
    return `<ul style="margin:0 0 0.6rem;padding-left:1.2rem;max-height:220px;overflow:auto;font-size:0.85rem;">${items.join('')}</ul>`;
}

/** Tab-Leiste "Funktionsweise / Unterstützte Pools" — gemeinsame Basis für das rein
 *  lesende Detail-Modal (Entscheidung 4) UND das Anwenden-Bestätigungs-Modal (LIQ#0368):
 *  beide zeigen dieselbe Übersicht, nur mit unterschiedlichen Actions darunter.
 *  🔒 Der frühere dritte Tab "Abweichungen" ist bewusst entfernt (Festlegung 2026-09-04):
 *  ein Strategiewechsel überschreibt/resettet jetzt alle individuellen Werte — wer
 *  Individuelles will, nutzt "Standard". Damit gibt es nichts mehr, wovon eine aktive
 *  Strategie abweichen könnte. `deviations()` bleibt als Backend-/CLI-Werkzeug
 *  (bots/settings/bin/strategy.js --deviations) für Admin-Debugging bestehen. */
function _strategyTabsBarHtml() {
    return `
        <div class="wm-tab-bar">
            <button class="wm-tab active" data-wm="does">${tr('sliq.strategy_tab_does', 'Funktionsweise')}</button>
            <button class="wm-tab" data-wm="pools">${tr('sliq.strategy_tab_pools', 'Unterstützte Pools')}</button>
        </div>
        <div id="strategy-tab-does" style="min-height:160px;font-size:0.85rem;">${tr('sliq.please_wait', 'Bitte warten…')}</div>
        <div id="strategy-tab-pools" style="min-height:160px;font-size:0.85rem;" hidden>${tr('sliq.please_wait', 'Bitte warten…')}</div>`;
}

function _wireStrategyTabs(backdrop) {
    backdrop.querySelectorAll('.wm-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            backdrop.querySelectorAll('.wm-tab').forEach(b => b.classList.toggle('active', b === btn));
            backdrop.querySelector('#strategy-tab-does').hidden  = btn.dataset.wm !== 'does';
            backdrop.querySelector('#strategy-tab-pools').hidden = btn.dataset.wm !== 'pools';
        });
    });
}

/** Füllt die beiden Tabs eines bereits im DOM stehenden Backdrops.
 *  `existingPreview`: der Anwenden-Flow hat den Probelauf ohnehin schon für die Kopfzeile
 *  geladen — hier durchgereicht, um ihn nicht doppelt zu holen. */
async function _loadStrategyTabsContent(backdrop, selectedId, strategyCtx, existingPreview = null) {
    const doesEl  = backdrop.querySelector('#strategy-tab-does');
    const poolsEl = backdrop.querySelector('#strategy-tab-pools');
    const isStandard = selectedId === 'standard' || selectedId == null;

    if (isStandard) {
        if (doesEl)  doesEl.innerHTML  = `<p class="wallet-hint">${tr('sliq.strategy_standard_does', 'Standard setzt keinen eigenen Feldsatz. Beim Wechsel dahin werden die von der zuvor aktiven Strategie gesetzten Felder zurückgenommen, soweit sie seither unverändert sind (LIQ#0384) — danach gelten die individuell gespeicherten Werte wieder.')}</p>`;
        if (poolsEl) poolsEl.innerHTML = `<p class="wallet-hint">${tr('sliq.strategy_standard_pools', 'Standard hat keinen festen Pool-Kreis — jeder Pool ist ein möglicher Kandidat.')}</p>`;
        return;
    }

    const meta = strategyCtx.strategies.find(s => s.id === selectedId);
    const summaryText = _strategySummary(selectedId, meta?.summary);
    if (doesEl) doesEl.innerHTML = summaryText ? `<p style="margin:0;">${_esc(summaryText)}</p>` : '';

    try {
        const [preview, pools, cfg] = await Promise.all([
            existingPreview ?? fetch(`/api/strategy/${selectedId}/preview`, { method: 'POST' }).then(async r => {
                const data = await r.json();
                if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
                return data;
            }),
            fetch(`/api/pools/liquidity?t=${Date.now()}`).then(r => r.ok ? r.json() : []),
            fetch('/api/config/liquiditybot').then(r => r.ok ? r.json() : {}),
        ]);
        const poolsById = new Map(pools.map(p => [p.id, p]));
        const minScore   = Math.max(0, Math.min(100, parseInt(cfg.CLEANUP_MIN_SCORE ?? '65', 10) || 65));
        if (poolsEl) poolsEl.innerHTML = _renderStrategySupportedPoolsHtml(preview.pools, poolsById, minScore);
    } catch (err) {
        if (poolsEl) poolsEl.innerHTML = `<p class="modal-feedback error">${tr('sb.error_prefix', 'Fehler: {error}', { error: err.message })}</p>`;
    }
}

/** Rein lesendes Detail-Modal (Entscheidung 4) — zwei Tabs, für die im Select gerade
 *  ausgewählte Strategie (kann von der aktiven abweichen, wenn nur verglichen wird). */
async function _openStrategyDetailsModal(selectedId, strategyCtx) {
    const mid        = 'strategy-details-modal';
    const isStandard = selectedId === 'standard' || selectedId == null;
    const name        = isStandard ? tr('sliq.strategy_standard', 'Standard') : _strategyName(selectedId);

    showModal({
        id:    mid,
        title: tr('sliq.strategy_details_title', 'Strategie: {name}', { name }),
        body:  _strategyTabsBarHtml(),
        actions: [
            { label: tr('common.close', 'Schließen'), onClick: () => closeModal(mid) },
        ],
    });

    const backdrop = getModal(mid);
    if (!backdrop) return;
    _wireStrategyTabs(backdrop);
    await _loadStrategyTabsContent(backdrop, selectedId, strategyCtx);
}

/** Select geändert → NIE eine stille Nebenwirkung (🔒 Ticket-Vorgabe): erst Probelauf/
 *  Bestätigung, erst danach schreiben. Ein Abbruch (Abbrechen/ESC/Backdrop) setzt den
 *  Select über onClose immer auf den vorherigen Wert zurück. */
function _onStrategyChange(selectEl, wrap, strategyCtx) {
    const newId  = selectEl.value;
    const prevId = strategyCtx.active.strategyId ?? 'standard';
    if (newId === prevId) return;

    if (newId === 'standard') {
        _openStrategyStandardConfirmModal(prevId, selectEl, wrap);
    } else {
        _openStrategyApplyConfirmModal(newId, prevId, selectEl, wrap, strategyCtx);
    }
}

/** Probelauf der Rücknahme abrufen, dann Bestätigungs-Modal zeigen — derselbe Ablauf
 *  "Auswahl → Probelauf → anzeigen → Bestätigung → anwenden" wie beim Anwenden einer
 *  Strategie (_openStrategyApplyConfirmModal), hier über switchToStandard(dryRun) statt
 *  applyStrategy(dryRun). 🔒 Ticket-Vorgabe LIQ#0384: Der Wechsel schreibt auf Live-Kapital
 *  und gehört hinter dieselbe Bestätigung wie das Anwenden. */
async function _openStrategyStandardConfirmModal(prevId, selectEl, wrap) {
    let preview;
    try {
        const res  = await fetch('/api/strategy/standard/preview', { method: 'POST' });
        preview = await res.json();
        if (!res.ok) throw new Error(preview.error ?? `HTTP ${res.status}`);
    } catch (err) {
        _ctx.showToast?.(tr('sliq.strategy_preview_failed', 'Vorschau nicht ladbar: {error}', { error: err.message }), 'error');
        selectEl.value = prevId;
        return;
    }

    const mid = 'strategy-standard-confirm';
    showModal({
        id:    mid,
        title: tr('sliq.strategy_to_standard_q', 'Zurück zu „Standard"?'),
        body: `
            <p style="margin:0 0 0.5rem;">
                ${tr('sliq.strategy_to_standard_body1', 'Nimmt die von „{name}" gesetzten Felder zurück, soweit sie seither unverändert sind – danach gilt an jedem Pool wieder der Zustand von davor.', { name: _strategyName(prevId) })}
            </p>
            <p style="margin:0 0 0.6rem;color:var(--text-muted);font-size:0.85rem;">
                ${tr('sliq.strategy_to_standard_body2', 'Verschärfungen (z. B. Trailing Stop wieder an) werden bei einer offenen Position zurückgestellt, bis diese schließt – dieselbe Regel wie beim Anwenden, nur rückwärts.')}
            </p>
            ${_renderStrategyRollbackPreviewHtml(preview)}
            <div id="strategy-standard-feedback" class="modal-feedback"></div>`,
        actions: [
            {
                label: tr('sliq.confirm', 'Bestätigen'), onClick: async () => {
                    const modalEl = getModal(mid);
                    const fb      = modalEl?.querySelector('#strategy-standard-feedback');
                    const btns    = modalEl?.querySelectorAll('.forge-modal-footer button') ?? [];
                    btns.forEach(b => { b.disabled = true; });
                    if (fb) { fb.textContent = tr('sliq.please_wait', 'Bitte warten…'); fb.className = 'modal-feedback'; }
                    try {
                        const res  = await fetch('/api/strategy/standard', { method: 'POST' });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
                        closeModal(mid);
                        _ctx.showToast?.(tr('sliq.strategy_standard_saved', 'Zurück zu Standard – {n} Feld(er) zurückgenommen.', { n: data.summary?.reverted ?? 0 }), 'success');
                        await _refreshStrategyUI(wrap);
                    } catch (err) {
                        if (fb) { fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb.className = 'modal-feedback error'; }
                        btns.forEach(b => { b.disabled = false; });
                    }
                },
            },
            { label: tr('sliq.cancel', 'Abbrechen'), onClick: () => closeModal(mid) },
        ],
        onClose: () => { selectEl.value = prevId; },
    });
}

/** Probelauf abrufen, dann Bestätigungs-Modal mit der Schreib-Vorschau zeigen — der im
 *  Ticket geforderte Ablauf "Auswahl → Probelauf → anzeigen → Bestätigung → anwenden". */
async function _openStrategyApplyConfirmModal(newId, prevId, selectEl, wrap, strategyCtx) {
    let preview;
    try {
        const res  = await fetch(`/api/strategy/${newId}/preview`, { method: 'POST' });
        preview = await res.json();
        if (!res.ok) throw new Error(preview.error ?? `HTTP ${res.status}`);
    } catch (err) {
        _ctx.showToast?.(tr('sliq.strategy_preview_failed', 'Vorschau nicht ladbar: {error}', { error: err.message }), 'error');
        selectEl.value = prevId;
        return;
    }

    const mid = `strategy-apply-confirm-${newId}`;

    showModal({
        id:    mid,
        title: tr('sliq.strategy_apply_q', 'Strategie „{name}" anwenden?', { name: _strategyName(newId) }),
        body: `
            ${_strategyTabsBarHtml()}
            <div id="strategy-apply-feedback" class="modal-feedback"></div>`,
        actions: [
            {
                label: tr('sliq.apply', 'Übernehmen'), onClick: async () => {
                    const modalEl = getModal(mid);
                    const fb      = modalEl?.querySelector('#strategy-apply-feedback');
                    const btns    = modalEl?.querySelectorAll('.forge-modal-footer button') ?? [];
                    btns.forEach(b => { b.disabled = true; });
                    if (fb) { fb.textContent = tr('sliq.please_wait', 'Bitte warten…'); fb.className = 'modal-feedback'; }
                    try {
                        const res  = await fetch(`/api/strategy/${newId}/apply`, { method: 'POST' });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
                        closeModal(mid);
                        _ctx.showToast?.(tr('sliq.strategy_applied', 'Strategie „{name}" aktiv – {n} Feld(er) geschrieben.', { name: _strategyName(newId), n: data.summary.written }), 'success');
                        await _refreshStrategyUI(wrap);
                    } catch (err) {
                        if (fb) { fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb.className = 'modal-feedback error'; }
                        btns.forEach(b => { b.disabled = false; });
                    }
                },
            },
            { label: tr('sliq.cancel', 'Abbrechen'), onClick: () => closeModal(mid) },
        ],
        onClose: () => { selectEl.value = prevId; },
    });

    const backdrop = getModal(mid);
    if (backdrop) {
        _wireStrategyTabs(backdrop);
        await _loadStrategyTabsContent(backdrop, newId, strategyCtx, preview);
    }
}


// ── Tab "Pool Typen" ──────────────────────────────────────────────────────────
// Setzt Default-Werte pro Pool-Typ, die beim Speichern SOFORT auf alle Pools dieses
// Typs durchgeschrieben werden (Bulk-Write, kein Template/Override-Konzept).

/**
 * Pool-Typen-Tab: links zwei Auswahlboxen (Pool-Typ, darunter "PoolSettings" — zum
 * Start nur "Risk-Management"), rechts der zur Auswahl passende Inhalt. Jede Auswahl
 * merkt sich ihren zuletzt bearbeiteten Eintrag in localStorage (Muster wie
 * _poolTypeFilter/_activePool, siehe oben).
 */
function _renderPoolTypesTab(container) {
    container.innerHTML = `
        <div style="display:flex; gap:1.5rem; align-items:flex-start; flex-wrap:wrap;">
            <div style="display:flex; flex-direction:column; gap:0.9rem; min-width:220px;">
                <div>
                    <label class="settings-label" style="display:block;margin-bottom:0.3rem;">${tr('sliq.pool_type', 'Pool Typ')}</label>
                    <select class="modal-select" id="pt-type-select" style="width:100%;"></select>
                </div>
                <div>
                    <label class="settings-label" style="display:block;margin-bottom:0.3rem;">${tr('sliq.pool_settings_group', 'Einstellung')}</label>
                    <select class="modal-select" id="pt-setting-select" style="width:100%;">
                        <option value="risk-management">${tr('sliq.risk_management', 'Risk-Management')}</option>
                    </select>
                </div>
            </div>
            <div style="flex:1; min-width:300px;" id="pt-content">
                <div class="wallet-loading">${tr('sliq.loading_pool_types', 'Lade Pool-Typen…')}</div>
            </div>
        </div>`;

    const typeSelect    = container.querySelector('#pt-type-select');
    const settingSelect = container.querySelector('#pt-setting-select');
    const contentEl     = container.querySelector('#pt-content');

    const savedSetting  = localStorage.getItem('liquiditybot.activePoolSetting');
    settingSelect.value = (savedSetting && settingSelect.querySelector(`option[value="${savedSetting}"]`)) ? savedSetting : 'risk-management';

    async function loadAndRender() {
        contentEl.innerHTML = `<div class="wallet-loading">${tr('sliq.loading_pool_types', 'Lade Pool-Typen…')}</div>`;
        try {
            const [rowsRes, addrsRes, poolsRes] = await Promise.all([
                fetch(`/api/pools/liquidity/pool-types?t=${Date.now()}`),
                fetch('/api/addresses'),
                fetch(`/api/pools/liquidity?t=${Date.now()}`),
            ]);
            if (!rowsRes.ok) throw new Error(tr('sliq.pool_types_failed', 'Pool-Typen konnten nicht geladen werden (HTTP {status})', { status: rowsRes.status }));
            const rows   = await rowsRes.json();
            const addrs  = addrsRes.ok ? await addrsRes.json() : [];
            const pools  = poolsRes.ok ? await poolsRes.json() : [];
            // scoreSource ist pro Pool identisch (globaler Feed-Status, s. _updatePremiumIcon).
            const globalScoreSource = pools[0]?.scoreSource ?? 'none';

            // Select-Optionen (mit Pool-Anzahl) aus den frischen Zeilen aufbauen — die aktuelle
            // Auswahl bleibt erhalten, sonst würde ein Reload nach dem Speichern zurückspringen.
            const prevType = typeSelect.value;
            typeSelect.innerHTML = rows.map(r => {
                const lbl = POOL_TYPE_LABELS[r.poolType] ?? r.poolType;
                return `<option value="${_esc(r.poolType)}">${_esc(lbl)} (${r.poolCount} ${tr('sliq.pools_short', 'Pools')})</option>`;
            }).join('');
            const savedType = localStorage.getItem('liquiditybot.activePoolType');
            typeSelect.value = rows.some(r => r.poolType === prevType) ? prevType
                : rows.some(r => r.poolType === savedType) ? savedType
                : (rows[0]?.poolType ?? '');

            const row = rows.find(r => r.poolType === typeSelect.value);
            if (!row) { contentEl.innerHTML = `<p class="wallet-hint">${tr('sliq.no_pools', 'Keine Pools konfiguriert.')}</p>`; return; }
            if (settingSelect.value === 'risk-management') {
                _renderPoolTypeRiskManagement(contentEl, row, addrs, globalScoreSource, container);
            }
        } catch (err) {
            contentEl.innerHTML = `<p class="wallet-hint">Fehler: ${_esc(err.message)}</p>`;
        }
    }

    typeSelect.addEventListener('change', () => {
        localStorage.setItem('liquiditybot.activePoolType', typeSelect.value);
        loadAndRender();
    });
    settingSelect.addEventListener('change', () => {
        localStorage.setItem('liquiditybot.activePoolSetting', settingSelect.value);
        loadAndRender();
    });

    loadAndRender();
}

/**
 * Baut die "Risk-Management"-Ansicht für einen Pool-Typ: dieselben drei Tabs wie im
 * "Risk-Management > Verwalten"-Modal auf dem Liquidity-Pools-Tab (Trailing Stop / TVL /
 * Score Limit), eingebettet statt im Modal. Trailing-Stop-"Pool Mindestwert" und
 * "TVL-Schwelle" entfallen (pool-individuell, siehe DEFAULT_POOL_TYPE_SETTINGS-Kommentar
 * in routes/pools.js) — alle anderen Felder sind identisch zum Pool-Modal.
 *
 * Eigenes ID-Präfix ("pt-", siehe mode='type' in den Panel-Buildern) verhindert
 * Kollisionen mit einem gleichzeitig geöffneten Pool-Modal, dessen Save-Funktion
 * unpräfigierte IDs über document.getElementById() liest.
 */
function _renderPoolTypeRiskManagement(contentEl, row, addrs, globalScoreSource, scaffoldContainer) {
    const poolType = row.poolType;
    const pseudoPool = {
        settings:           row.settings,
        poolType,
        currentValue:       null,
        currentTvl:         null,
        trailingStopStatus: null,
        tsAdvice:           { available: false, source: 'none' },
        scoreSource:        globalScoreSource,
    };
    const investedPools = row.investedPools ?? [];
    const lockDisable   = investedPools.length > 0 && row.settings.enabled !== false;

    contentEl.innerHTML = `
        <div class="wm-tab-bar">
            <button type="button" class="wm-tab active" data-wm="ts">Trailing Stop</button>
            <button type="button" class="wm-tab"        data-wm="tvl">TVL</button>
            <button type="button" class="wm-tab"        data-wm="sl">Score Limit</button>
        </div>
        <div id="pt-panel-ts"  class="sltp-settings ts-settings">${_buildTrailingStopPanel(pseudoPool, addrs, 'type')}</div>
        <div id="pt-panel-tvl" class="sltp-settings" hidden>${_buildTvlPanel(pseudoPool, addrs, 'type')}</div>
        <div id="pt-panel-sl"  hidden>${_buildScoreLimitPanel(pseudoPool, addrs, 'type')}</div>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:0.8rem; margin-top:1rem; padding-top:0.8rem; border-top:1px solid var(--border, #2a2a3a);">
            <div style="display:flex; align-items:center; gap:0.5rem;">
                <label class="toggle-switch toggle-sm"
                    ${lockDisable ? `data-tooltip-title="${tr('sliq.not_deactivatable', 'Nicht deaktivierbar')}" data-tooltip-content="${tr('sliq.invested_pools_hint', '{pools} – erst auszahlen, dann deaktivieren.', { pools: _esc(investedPools.map(p => p.displayPair).join(', ')) })}"` : ''}>
                    <input type="checkbox" id="pt-type-enabled" ${row.settings.enabled !== false ? 'checked' : ''} ${lockDisable ? 'disabled' : ''}>
                    <span class="toggle-slider"></span>
                </label>
                <span style="font-size:0.82rem;">${tr('sliq.pool_type_accepts_capital', 'Nimmt Kapital an')}</span>
            </div>
            <button class="btn btn-primary btn-sm" id="pt-save-risk"
                ${_ctx.getStatus?.(SVC_ID) !== 'active' ? 'disabled' : ''}>${tr('msg.save', 'Speichern')}</button>
        </div>
        <div class="modal-feedback" id="pt-rm-feedback"></div>`;

    // Tab-Umschaltung (identisches Muster zu _openSLTPModal)
    contentEl.querySelectorAll('.wm-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const which = btn.dataset.wm;
            contentEl.querySelectorAll('.wm-tab').forEach(b => b.classList.toggle('active', b === btn));
            contentEl.querySelector('#pt-panel-sl').hidden  = which !== 'sl';
            contentEl.querySelector('#pt-panel-ts').hidden  = which !== 'ts';
            contentEl.querySelector('#pt-panel-tvl').hidden = which !== 'tvl';
        });
    });

    // Trailing Stop: Toggle steuert Sichtbarkeit der Folgezeilen (analog _openSLTPModal)
    contentEl.querySelector('#pt-ts-enabled')?.addEventListener('change', e => {
        const on = e.target.checked;
        contentEl.querySelectorAll('#pt-panel-ts .ts-dependent').forEach(el => { el.style.opacity = on ? '1' : '0.4'; });
        ['pt-ts-threshold', 'pt-ts-threshold2', 'pt-ts-swap', 'pt-ts-sendto', 'pt-ts-cooldown'].forEach(id => {
            const el = contentEl.querySelector('#' + id);
            if (el) el.disabled = !on;
        });
        const auto = contentEl.querySelector('#pt-ts-auto');
        if (auto) auto.disabled = !on || auto.dataset.locked === '1';
    });

    // TVL: Toggle steuert Sichtbarkeit der Folgezeile (analog _wireTvlPanel)
    contentEl.querySelector('#pt-tvl1-enabled')?.addEventListener('change', e => {
        const on = e.target.checked;
        contentEl.querySelectorAll('#pt-panel-tvl .tvl1-dependent').forEach(el => { el.style.opacity = on ? '1' : '0.4'; });
        const pctEl = contentEl.querySelector('#pt-tvl1-pct');
        if (pctEl) pctEl.disabled = !on;
    });

    // Score Limit: Toggle steuert Sichtbarkeit der Folgezeilen (analog _wireSlPanelListeners)
    contentEl.querySelector('#pt-sl-enabled')?.addEventListener('change', e => {
        const on = e.target.checked;
        contentEl.querySelectorAll('#pt-panel-sl .sl-dependent').forEach(el => { el.style.opacity = on ? '1' : '0.4'; });
        ['pt-sl-minscore', 'pt-sl-swap', 'pt-sl-sendto', 'pt-sl-cooldown'].forEach(id => {
            const el = contentEl.querySelector('#' + id);
            if (el) el.disabled = !on;
        });
    });

    contentEl.querySelector('#pt-save-risk')?.addEventListener('click', () => {
        _confirmSavePoolTypeRiskManagement(contentEl, row, scaffoldContainer);
    });
}

/** Liest die Formularwerte der Pool-Typ-Risk-Management-Ansicht (Präfix "pt-"). */
function _readPoolTypeRiskManagementForm(contentEl) {
    const get = id => contentEl.querySelector('#pt-' + id);

    const thresholdPct  = parseFloat(get('ts-threshold')?.value ?? '');
    const ts2Raw         = get('ts-threshold2')?.value ?? '';
    const thresholdPct2  = String(ts2Raw).trim() !== '' ? parseFloat(ts2Raw) : null;
    const autoEl          = get('ts-auto');
    const auto             = !!(autoEl?.checked) && autoEl?.dataset.locked !== '1';

    return {
        thresholdPct, thresholdPct2,
        trailingStop: {
            enabled:        get('ts-enabled')?.checked ?? false,
            thresholdPct,
            thresholdPct2,
            auto,
            autoSwapToUSDC: get('ts-swap')?.checked ?? true,
            sendTo:         get('ts-sendto')?.value ?? '',
            cooldownHours:  parseInt(get('ts-cooldown')?.value ?? '6', 10),
        },
        tvlProtection: {
            level1: {
                enabled:     get('tvl1-enabled')?.checked ?? false,
                withdrawPct: parseInt(get('tvl1-pct')?.value ?? '100', 10),
            },
            swapToUsdc:    get('tvl-swap')?.checked ?? true,
            sendTo:        get('tvl-sendto')?.value ?? '',
            cooldownHours: parseInt(get('tvl-cooldown')?.value ?? '12', 10),
        },
        scoreLimit: {
            enabled:       get('sl-enabled')?.checked ?? false,
            minScore:      parseFloat(get('sl-minscore')?.value ?? '30'),
            swapToUsdc:    get('sl-swap')?.checked ?? true,
            sendTo:        get('sl-sendto')?.value ?? '',
            cooldownHours: parseInt(get('sl-cooldown')?.value ?? '1', 10),
        },
        enabled: get('type-enabled')?.checked ?? true,
    };
}

function _confirmSavePoolTypeRiskManagement(contentEl, row, scaffoldContainer) {
    const poolType = row.poolType;
    const label    = POOL_TYPE_LABELS[poolType] ?? poolType;
    const fb       = contentEl.querySelector('#pt-rm-feedback');
    const setErr   = msg => { if (fb) { fb.textContent = msg; fb.className = 'modal-feedback error'; } };

    const form = _readPoolTypeRiskManagementForm(contentEl);

    if (!Number.isFinite(form.thresholdPct) || form.thresholdPct < 0.5 || form.thresholdPct > 90) {
        return setErr(tr('sliq.ts_range_err', 'Drawdown 1 muss zwischen 0,5 und 90 % liegen.'));
    }
    if (form.thresholdPct2 != null) {
        if (!Number.isFinite(form.thresholdPct2) || form.thresholdPct2 < 0.5 || form.thresholdPct2 > 90) {
            return setErr(tr('sliq.ts2_range_err', 'Drawdown 2 muss zwischen 0,5 und 90 % liegen.'));
        }
        if (form.thresholdPct2 >= form.thresholdPct) {
            return setErr(tr('sliq.ts2_order_err', 'Drawdown 2 muss kleiner als Drawdown 1 sein — die zweite Stufe sichert enger ab.'));
        }
    }
    for (const cd of [form.trailingStop.cooldownHours, form.tvlProtection.cooldownHours, form.scoreLimit.cooldownHours]) {
        if (!Number.isFinite(cd) || cd < 1 || cd > 24) {
            return setErr(tr('sliq.cooldown_range_err', 'Cleanup-Cooldown muss zwischen 1 und 24 h liegen.'));
        }
    }
    if (!Number.isFinite(form.scoreLimit.minScore) || form.scoreLimit.minScore < 0 || form.scoreLimit.minScore > 100) {
        return setErr(tr('sliq.score_limit_range_err', 'Score-Limit-Schwelle muss zwischen 0 und 100 liegen.'));
    }
    if (fb) { fb.textContent = ''; fb.className = 'modal-feedback'; }

    // Bestätigung über ein eigenes Modal statt window.confirm() (bewusst keine
    // nativen Browser-Dialoge) — analog deleteSupportThread() in html/js/message.js.
    const mid = `pool-type-confirm-${poolType}`;
    showModal({
        id:    mid,
        title: tr('sliq.pool_type_save_q', 'Pool-Typ "{type}" speichern?', { type: label }),
        body: `
            <p style="margin:0 0 0.5rem;">
                ${tr('sliq.overwrite_prefix_rm', 'Dies überschreibt Trailing-Stop-, TVL-Schutz- und Score-Limit-Werte bei')}
                <strong>${row.poolCount} Pool${row.poolCount === 1 ? '' : 's'}</strong> ${tr('sliq.of_type', 'vom Typ')}
                <strong>${_esc(label)}</strong> ${tr('sliq.immediately', 'sofort.')}
            </p>
            <p style="margin:0;color:var(--text-muted);font-size:0.85rem;">
                Bestehende individuelle Anpassungen bei diesen Pools gehen dabei verloren.
                ${form.enabled === false ? tr('sliq.also_deactivates', ' Zusätzlich werden alle Pools dieses Typs deaktiviert (keine Cleanup-Zuweisung mehr).') : ''}
            </p>
            <div id="pt-confirm-feedback" style="margin-top:0.6rem;font-size:0.82rem"></div>`,
        actions: [
            {
                label: tr('msg.save', 'Speichern'), onClick: async () => {
                    const modalEl = getModal(mid);
                    const cfb     = modalEl?.querySelector('#pt-confirm-feedback');
                    const btns    = modalEl?.querySelectorAll('.forge-modal-footer button') ?? [];
                    btns.forEach(b => { b.disabled = true; });
                    if (cfb) { cfb.style.color = 'var(--text-muted)'; cfb.textContent = tr('sb.saving', 'Speichere…'); }
                    try {
                        const res = await fetch(`/api/pools/liquidity/pool-types/${poolType}`, {
                            method:  'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                trailingStop:  form.trailingStop,
                                tvlProtection: form.tvlProtection,
                                scoreLimit:    form.scoreLimit,
                                enabled:       form.enabled,
                            }),
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

                        closeModal(mid);
                        const failCount = data.failed?.length ?? 0;
                        if (failCount > 0) {
                            // Höchstens 3 Gründe nennen — sonst wird der Toast bei vielen
                            // Pools desselben Typs unlesbar lang (Befund LIQ#0354, Rollout
                            // 30.08.: 6 Pools gleichzeitig übersprungen).
                            const shown   = data.failed.slice(0, 3).map(f => `${f.poolId}: ${f.reason}`).join(' | ');
                            const more    = failCount > 3 ? tr('sliq.and_more', ' … und {n} weitere', { n: failCount - 3 }) : '';
                            _ctx.showToast?.(tr('sliq.saved_with_skips', 'Gespeichert, aber {n} Pool(s) übersprungen – {reasons}{more}', { n: failCount, reasons: shown, more }), 'error');
                        } else {
                            _ctx.showToast?.(
                                tr('sliq.pool_type_saved', 'Pool-Typ "{type}"', { type: label }),
                                'success',
                                { pair: tr('sliq.changes_saved', 'Änderungen gespeichert') },
                            );
                        }
                        // Kein zusätzlicher Hinweis, wenn "Drawdown Auto" bei einzelnen Pools
                        // (noch) nicht greift (fehlende Advisor-Empfehlung) — das Info-Icon am
                        // Feld erklärt das bereits dauerhaft, ein Toast bei jedem Speichern wäre
                        // hier reine Wiederholung.

                        // Tab-Inhalt + darunterliegende Pool-Liste (falls schon geladen)
                        // aktualisieren, damit neue Werte sofort sichtbar sind.
                        if (scaffoldContainer) _renderPoolTypesTab(scaffoldContainer);
                        const scaffoldCard = (scaffoldContainer ?? contentEl).closest('.settings-card');
                        if (scaffoldCard?.querySelector('#pool-panel-pools')) {
                            await _refreshPoolsCard(scaffoldCard);
                        }
                    } catch (err) {
                        if (cfb) { cfb.style.color = 'var(--danger)'; cfb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); }
                        btns.forEach(b => { b.disabled = false; });
                    }
                },
            },
            { label: tr('sliq.cancel', 'Abbrechen'), onClick: () => closeModal(mid) },
        ],
    });
}

// ── Kapitalfluss-Modus (Benutzer-Freigabe + Cleanup-Berücksichtigung) ─────────

/** Menschlich lesbare Begründung je Zielmodus, fürs Bestätigungs-Modal. */
function _modeExplain(mode) {
    switch (mode) {
        case 'disabled':
            return tr('sliq.pool_disable_hint', 'In den Pool wird kein Kapital mehr investiert (kein Cleanup-Reinvest, keine Einzahlung), bis er wieder aktiviert wird.');
        case 'cleanup-inactive':
            return tr('sliq.pool_cleanup_inactive_hint', 'Der automatische Cleanup („Bester Pool“) legt kein neues Kapital hinein. Bestehende Position, manuelle Einzahlung/Auszahlung und Risk-Management laufen unverändert weiter.');
        default:
            return tr('sliq.pool_enable_hint', 'Der Pool kann danach wieder Kapital aufnehmen (Einzahlungen und Cleanup-Reinvest).');
    }
}

/**
 * select-Wechsel bestätigen und speichern (LIQ#0365). Bei Abbruch oder Fehler
 * springt das Select zurück auf den vorherigen Wert — kein stiller Fehlzustand.
 */
function _setPoolMode(pool, card, selectEl, previousMode) {
    const targetMode = selectEl.value;
    const name        = _esc(pool.displayPair ?? pool.pair);
    const mid         = 'liquiditybot-mode-modal';
    const modeLabel   = { disabled: tr('sliq.mode_disabled', 'Deaktiviert'), 'cleanup-inactive': tr('sliq.mode_cleanup_inactive', 'Cleanup inaktiv'), 'cleanup-active': tr('sliq.mode_cleanup_active', 'Cleanup aktiv') }[targetMode];

    const body = `
        <p style="margin:0 0 0.5rem">${tr('sliq.mode_change_q', 'Pool <strong>{pool}</strong> auf <strong>{mode}</strong> stellen?', { pool: name, mode: _esc(modeLabel) })}</p>
        <p style="margin:0;color:var(--text-muted);font-size:0.85rem">${_modeExplain(targetMode)}</p>
        <div id="mode-feedback" style="margin-top:0.6rem;font-size:0.82rem"></div>`;

    let saved = false; // onClose feuert bei JEDEM Schließen (auch nach Erfolg) — nur ohne Erfolg zurückspringen

    const doSet = async () => {
        const modalEl = getModal(mid);
        const fb      = modalEl?.querySelector('#mode-feedback');
        const btns    = modalEl?.querySelectorAll('.forge-modal-footer button') ?? [];
        btns.forEach(b => { b.disabled = true; });
        if (fb) { fb.style.color = 'var(--text-muted)'; fb.textContent = tr('sliq.saving_dots', 'Wird gespeichert…'); }
        try {
            const res  = await fetch(`/api/pools/liquidity/${pool.id}/mode`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ mode: targetMode }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

            saved = true;
            closeModal(mid);
            _ctx.showToast?.(data.message ?? tr('sliq.mode_saved', 'Kapitalfluss-Modus gespeichert.'), 'success');
            _renderPools(card.parentElement);
        } catch (err) {
            if (fb) { fb.style.color = 'var(--danger)'; fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); }
            btns.forEach(b => { b.disabled = false; });
        }
    };

    showModal({
        id:    mid,
        title: tr('sliq.mode_change_title', 'Kapitalfluss-Modus ändern'),
        body,
        actions: [
            { label: tr('msg.save', 'Speichern'), primary: true, onClick: doSet },
            { label: tr('sliq.cancel', 'Abbrechen'), onClick: () => closeModal(mid) },
        ],
        onClose: () => { if (!saved) selectEl.value = previousMode; },
    });
}

// ── Pool-Info-Tooltips ────────────────────────────────────────────────────────

// ── Hinweis auf vom Standard abweichende Einstellungen ────────────────────────
//
// Seit 2026-08-15 überlebt jede Pool-Einstellung einen Kapitalabzug (Trailing Stop,
// TVL-Schutz, Score-Limit, manueller Withdraw) — vorher fiel alles außer trailingStop
// und tvlProtection beim Exit auf Default zurück. Damit ein abweichender Wert nicht
// unbemerkt über Monate weiterwirkt, wird jeder davon hier ausgewiesen: als Marker in
// der Pool-Zeile, als Hinweiszeile im jeweiligen Modal und gesammelt unter der Tabelle.
// Datenquelle ist `pool.nonDefault` aus GET /api/pools/liquidity (dort berechnet gegen
// lib/pool-settings-defaults.js, damit UI und Bot dasselbe „Default" meinen).

const NONDEFAULT_LABELS = {
    'autoCompound.enabled':      () => tr('sliq.nd_ac_enabled',      'Auto Compounding'),
    'autoCompound.fraction':     () => tr('sliq.nd_ac_fraction',     'Reinvest-Anteil'),
    'autoCompound.minClaimUsdc': () => tr('sliq.nd_ac_minclaim',     'Claim ab Betrag'),
    'autoCompound.sendTo':       () => tr('sliq.nd_ac_sendto',       'Fees senden an'),
    'autoCompound.swapToUsdc':   () => tr('sliq.nd_ac_swap',         'Fees in USDC tauschen'),
    'scoreLimit.enabled':        () => tr('sliq.nd_sl_enabled',      'Score Limit'),
    'scoreLimit.minScore':       () => tr('sliq.nd_sl_minscore',     'Score-Schwelle'),
    'scoreLimit.swapToUsdc':     () => tr('sliq.nd_sl_swap',         'Score Limit: in USDC tauschen'),
    'scoreLimit.sendTo':         () => tr('sliq.nd_sl_sendto',       'Score Limit: senden an'),
    'scoreLimit.cooldownHours':  () => tr('sliq.nd_sl_cooldown',     'Score Limit: Cleanup-Sperrfrist'),
    'trailingStop.enabled':      () => tr('sliq.nd_ts_enabled',      'Trailing Stop'),
    'trailingStop.thresholdPct': () => tr('sliq.nd_ts_threshold',    'Trailing Stop: Schwelle'),
    'trailingStop.thresholdPct2':() => tr('sliq.nd_ts_threshold2',   'Trailing Stop: Schwelle Stufe 2'),
    'trailingStop.auto':        () => tr('sliq.nd_ts_auto',         'Trailing Stop: Auto (Advisor)'),
    'trailingStop.autoSwapToUSDC': () => tr('sliq.nd_ts_swap',       'Trailing Stop: in USDC tauschen'),
    'trailingStop.sendTo':       () => tr('sliq.nd_ts_sendto',       'Trailing Stop: senden an'),
    'trailingStop.cooldownHours':() => tr('sliq.nd_ts_cooldown',     'Trailing Stop: Cleanup-Sperrfrist'),
    'cleanup.rankingEligible':   () => tr('sliq.nd_cl_eligible',     'Beim Cleanup berücksichtigen'),
    'maxInvestment.enabled':     () => tr('sliq.nd_maxinv_enabled',  'Max Investment'),
    'maxInvestment.amountUsdc':  () => tr('sliq.nd_maxinv_amount',   'Max Investment: Obergrenze'),
    'tvlProtection.level1.enabled':      () => tr('sliq.nd_tvl1_enabled',   'TVL-Schutz Stufe 1'),
    'tvlProtection.level1.thresholdUsd': () => tr('sliq.nd_tvl1_threshold', 'TVL-Schutz Stufe 1: Schwelle'),
    'tvlProtection.level1.withdrawPct':  () => tr('sliq.nd_tvl1_pct',       'TVL-Schutz Stufe 1: Abzug'),
    'tvlProtection.swapToUsdc':          () => tr('sliq.nd_tvl_swap',       'TVL-Schutz: in USDC tauschen'),
    'tvlProtection.sendTo':              () => tr('sliq.nd_tvl_sendto',     'TVL-Schutz: senden an'),
    'tvlProtection.cooldownHours':       () => tr('sliq.nd_tvl_cooldown',   'TVL-Schutz: Cleanup-Sperrfrist'),
};

// Einheit je Pfad-Endung – ohne sie wäre "10 → 2" nicht als Prozent lesbar.
function _ndFormatValue(path, value) {
    if (value === true)  return tr('sb.on',  'An');
    if (value === false) return tr('sb.off', 'Aus');
    if (value === null || value === undefined || value === '') return tr('sliq.nd_unset', 'nicht gesetzt');
    if (/sendTo$/.test(path))        return String(value).slice(0, 6) + '…';
    if (/Pct2?$|withdrawPct$/.test(path)) return `${value} %`;
    if (/minScore$/.test(path))      return String(value);
    if (/Usdc?$|thresholdUsd$/.test(path)) return `${Number(value).toLocaleString(NUM_LOCALE)} USDC`;
    if (/Hours$/.test(path))         return tr('sliq.nd_hours', '{n} h', { n: value });
    return String(value);
}

/** Abweichungen eines Pools, optional gefiltert auf bestimmte Sektionen. */
function _nonDefaults(pool, prefixes = null) {
    const list = pool?.nonDefault ?? [];
    if (!prefixes) return list;
    return list.filter(d => prefixes.some(p => d.path === p || d.path.startsWith(p + '.')));
}

/** Eine Zeile "Label: Wert (Standard: X)" – für Tooltip und Hinweisblock. */
function _ndLine(d) {
    const label = (NONDEFAULT_LABELS[d.path]?.() ?? d.path);
    return tr('sliq.nd_line', '{label}: {value} (Standard: {default})', {
        label,
        value:   _ndFormatValue(d.path, d.value),
        default: _ndFormatValue(d.path, d.defaultValue),
    });
}

/**
 * Marker fürs Zeilen-Label einer Sektion. Bewusst mit eigenem Zeichen (✱) statt nur
 * einer Farbe – die Bedeutung muss ohne Farbwahrnehmung erkennbar sein.
 */
function _ndMarker(pool, prefixes) {
    const list = _nonDefaults(pool, prefixes);
    if (list.length === 0) return '';
    const body = list.map(d => '• ' + _ndLine(d)).join('\n');
    return `<span class="info-tip-label pool-nondefault-marker"
        data-tooltip-title="${tr('sliq.nd_title', 'Abweichend vom Standard ({n})', { n: list.length })}"
        data-tooltip-content="${_escTip(tr('sliq.nd_marker_tip', 'Diese Einstellungen weichen vom Standard ab und bleiben auch nach einem Kapitalabzug erhalten:\n\n{list}', { list: body }))}">&#10033;</span>`;
}

/** Hinweiszeile für den Kopf eines Modals (nur die Sektionen dieses Modals). */
function _ndModalNotice(pool, prefixes) {
    const list = _nonDefaults(pool, prefixes);
    if (list.length === 0) return '';
    const items = list.map(d => `<li>${_esc(_ndLine(d))}</li>`).join('');
    return `
        <div class="nd-notice">
            <div class="nd-notice-title">&#10033; ${tr('sliq.nd_title', 'Abweichend vom Standard ({n})', { n: list.length })}</div>
            <ul class="nd-notice-list">${items}</ul>
            <div class="nd-notice-hint">${tr('sliq.nd_persist_hint', 'Diese Werte bleiben erhalten, wenn das Kapital aus dem Pool abgezogen wird — auch bei Trailing Stop, TVL-Schutz oder Score Limit.')}</div>
        </div>`;
}

function _buildFeeClaimSummary(pool) {
    const s    = pool.settings.autoCompound;
    const min  = s.minClaimUsdc ?? 1;
    const parts = [];
    if (s.enabled) {
        const pct = s.fraction ?? 100;
        parts.push(`<span class="pool-summary-on">AC ${pct}%</span>`);
    } else {
        parts.push(`<span class="pool-summary-off">${tr('sliq.ac_off', 'AC Aus')}</span>`);
    }
    if (s.sendTo) {
        parts.push(`→ ${s.swapToUsdc ? 'USDC · ' : ''}${_esc(s.sendTo.slice(0, 6))}…`);
    }
    parts.push(`ab ${min} USDC`);
    return parts.join(' &middot; ');
}

function _buildSafetySummary(_pool) {
    return tr('sliq.risk_summary_tip', 'Regeln um Verluste einzugrenzen und Gewinne zu sichern.');
}

function _buildRMTip(pool) {
    const sl = pool.settings.scoreLimit ?? { enabled: false, minScore: 30 };
    const ts = pool.settings.trailingStop ?? { enabled: false, thresholdPct: 33 };
    return [
        `Score Limit: ${sl.enabled ? tr('sliq.below_score', 'Unter {score}', { score: sl.minScore ?? 30 }) : tr('sb.off', 'Aus')}`,
        // Bei zwei Stufen beide zeigen — sonst wäre aus der Übersicht nicht erkennbar,
        // dass nach erreichtem Gewinn eine engere Schwelle gilt.
        `Trailing Stop: ${ts.enabled
            ? '-' + (ts.thresholdPct ?? 33) + ' %' + (ts.thresholdPct2 != null && ts.thresholdPct2 !== '' ? ` / -${ts.thresholdPct2} %` : '')
            : tr('sb.off', 'Aus')}`,
    ].join('\n');
}

function _escTip(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
}

// ── Fee Claim – Modal ─────────────────────────────────────────────────────────

// ── Ranking – Detail-Modal ────────────────────────────────────────────────────

function _fmtPct(n, dp = 0) {
    if (n === undefined || n === null || !isFinite(n)) return '—';
    const rounded = dp === 0 ? Math.round(n) : n;
    return `${dp === 0 ? rounded.toLocaleString(NUM_LOCALE) : rounded.toFixed(dp)}%`;
}

function _fmtUsd(n) {
    if (n === undefined || n === null || !isFinite(n)) return '—';
    if (n >= 1_000_000) return (n/1_000_000).toFixed(2) + ' M USDC';
    if (n >= 1_000)     return (n/1_000).toFixed(1) + ' K USDC';
    return n.toFixed(0) + ' USDC';
}

function _fmtCost(n) {
    if (n === undefined || n === null || !isFinite(n) || n <= 0) return '—';
    if (n >= 1)    return n.toFixed(2) + ' USDC';
    if (n >= 0.01) return n.toFixed(3) + ' USDC';
    return n.toFixed(4) + ' USDC';
}

/**
 * Registriert einen visibilitychange-Listener für ein offenes Modal.
 * Wird das Modal geschlossen (getModal liefert null), entfernt sich der Listener selbst.
 * @param {string} mid       Modal-ID
 * @param {function} refreshFn  Async-Funktion, die beim Tab-Wechsel aufgerufen wird
 */
function _addModalVisibilityRefresh(mid, refreshFn) {
    const handler = () => {
        if (document.visibilityState !== 'visible') return;
        if (!getModal(mid)) {
            document.removeEventListener('visibilitychange', handler);
            return;
        }
        refreshFn().catch(() => {});
    };
    document.addEventListener('visibilitychange', handler);
}

function _openFeeClaimModal(pool, addrs, card) {
    const mid = 'liquiditybot-ac-modal';
    const s   = pool.settings.autoCompound;

    const acEnabled  = s.enabled !== false;
    const fraction   = s.fraction ?? 100;
    const minClaim   = s.minClaimUsdc ?? 1;
    const sendToVal  = s.sendTo ?? '';
    const swapVal    = s.swapToUsdc === true;

    const sendDisabled = acEnabled && fraction >= 100;

    // 0,1 USDC ist nur zum Testen gedacht (schnelle Claims bei kleinen Testbeträgen) –
    // der Default bleibt 1 USDC (s.minClaimUsdc ?? 1 oben), diese Option muss also
    // aktiv ausgewählt werden.
    const minOptions = [0.1,1,2,3,4,5,6,7,8,9,10].map(v =>
        `<option value="${v}" ${v === minClaim ? 'selected' : ''}>${String(v).replace('.', ',')} USDC</option>`
    ).join('');
    const fractionOptions = [10,20,30,40,50,60,70,80,90,100].map(v =>
        `<option value="${v}" ${v === fraction ? 'selected' : ''}>${v}%</option>`
    ).join('');

    showModal({
        id:    mid,
        title: `Fee Claim – ${pool.displayPair ?? pool.pair}`,
        body:  `
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-fc="cfg">${tr('sliq.general', 'Allgemein')}</button>
                <button class="wm-tab"        data-fc="ac">Auto Compounding</button>
                <button class="wm-tab"        data-fc="send">${tr('sb.send_to', 'Senden an')}</button>
            </div>
            ${_ndModalNotice(pool, ['autoCompound'])}
            <div id="fc-cfg-panel" class="fc-settings">
                <div class="settings-row" style="border:none;">
                    <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                        ${tr('sliq.min_amount', 'Mindestbetrag')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.min_amount', 'Mindestbetrag')}"
                            data-tooltip-content="${tr('sliq.min_amount_tip', 'Fees werden nur geclaimed wenn der Gesamtwert diesen Betrag erreicht hat.')}">&#9432;</span>
                    </span>
                    <select class="modal-select" id="ac-min-claim" style="width:auto;">
                        ${minOptions}
                    </select>
                </div>
                <div class="settings-row" style="border:none; opacity:0.55;">
                    <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                        ${tr('sliq.claim_interval', 'Claim-Intervall')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.claim_interval', 'Claim-Intervall')}"
                            data-tooltip-content="${tr('sliq.claim_interval_tip', 'Der Bot prüft alle {interval} ob Fees geclaimed werden sollen. Dieser Wert ist nicht konfigurierbar.', { interval: tr('sliq.ten_minutes', '10 Minuten') })}">&#9432;</span>
                    </span>
                    <span style="font-size:0.85rem;">${tr('sliq.ten_minutes', '10 Minuten')}</span>
                </div>
            </div>
            <div id="fc-ac-panel" class="fc-settings" hidden>
                <div class="settings-row" style="border:none;">
                    <span class="settings-label">${tr('sliq.enabled_col', 'Aktiviert')}</span>
                    <label class="toggle-switch">
                        <input type="checkbox" id="ac-enabled" ${acEnabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="settings-row ac-dependent" style="border:none; opacity:${acEnabled ? '1' : '0.4'};">
                    <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                        ${tr('sliq.reinvest_share', 'Reinvest-Anteil')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.reinvest_share', 'Reinvest-Anteil')}"
                            data-tooltip-content="${tr('sliq.reinvest_share_tip', 'Anteil der geclaimten Fees der sofort wieder in den Pool reinvestiert wird. Der Rest verbleibt im Wallet oder wird über „Senden an“ weitergeleitet.')}">&#9432;</span>
                    </span>
                    <select class="modal-select" id="ac-fraction" ${acEnabled ? '' : 'disabled'} style="width:auto;">
                        ${fractionOptions}
                    </select>
                </div>
            </div>
            <div id="fc-send-panel" class="fc-settings" hidden>
                <p class="wallet-hint" id="fc-send-hint" style="margin: 0.4rem 0 0.6rem;">${sendDisabled ? tr('sliq.ac_only_hint', '⚠️ Nur verfügbar wenn Auto Compounding &lt; 100% oder deaktiviert.') : ''}</p>
                <div class="settings-row" style="border:none; opacity:${sendDisabled ? '0.4' : '1'};">
                    <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                        ${tr('sliq.swap_usdc', 'Swap → USDC')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.swap_usdc', 'Swap → USDC')}"
                            data-tooltip-content="${tr('sliq.fc_swap_tip', 'Verbleibende Coins vor dem Transfer automatisch in USDC tauschen.')}">&#9432;</span>
                    </span>
                    <label class="toggle-switch toggle-sm">
                        <input type="checkbox" id="ac-swap" ${swapVal ? 'checked' : ''} ${sendDisabled ? 'disabled' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="settings-row" style="border:none; opacity:${sendDisabled ? '0.4' : '1'};">
                    <span class="settings-label">${tr('sliq.recipient', 'Empfänger')}</span>
                    <select class="modal-select" id="ac-sendto" ${sendDisabled ? 'disabled' : ''}>
                        <option value="">${tr('sliq.dont_send', '– Nicht senden –')}</option>
                        ${_addrOptions(addrs, sendToVal)}
                    </select>
                </div>
            </div>
            <div class="modal-feedback" id="ac-feedback"></div>`,
        actions: [
            { label: tr('msg.save', 'Speichern'), primary: true, onClick: () => _saveFeeClaimModal(mid, pool, card) },
            { label: tr('common.close', 'Schließen'), onClick: () => closeModal(mid) },
        ],
    });

    const backdrop = getModal(mid);
    if (!backdrop) return;

    function syncSendPanel() {
        const enabled  = backdrop.querySelector('#ac-enabled')?.checked ?? true;
        const frac     = Number(backdrop.querySelector('#ac-fraction')?.value ?? 100);
        const disabled = enabled && frac >= 100;
        const hint     = backdrop.querySelector('#fc-send-hint');
        const rows     = backdrop.querySelectorAll('#fc-send-panel .settings-row');
        if (hint) hint.textContent = disabled ? '⚠️ Nur verfügbar wenn Auto Compounding < 100% oder deaktiviert.' : '';
        rows.forEach(r => { r.style.opacity = disabled ? '0.4' : '1'; });
        backdrop.querySelectorAll('#fc-send-panel select, #fc-send-panel input[type="checkbox"]').forEach(el => {
            el.disabled = disabled;
        });
    }

    function syncAcPanel() {
        const enabled = backdrop.querySelector('#ac-enabled')?.checked ?? true;
        backdrop.querySelectorAll('.ac-dependent').forEach(r => { r.style.opacity = enabled ? '1' : '0.4'; });
        const fracSel = backdrop.querySelector('#ac-fraction');
        if (fracSel) fracSel.disabled = !enabled;
        syncSendPanel();
    }

    backdrop.querySelector('#ac-enabled')?.addEventListener('change', syncAcPanel);
    backdrop.querySelector('#ac-fraction')?.addEventListener('change', syncSendPanel);

    backdrop.querySelectorAll('.wm-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const which = btn.dataset.fc;
            backdrop.querySelectorAll('.wm-tab').forEach(b => b.classList.toggle('active', b === btn));
            backdrop.querySelector('#fc-cfg-panel').hidden  = which !== 'cfg';
            backdrop.querySelector('#fc-ac-panel').hidden   = which !== 'ac';
            backdrop.querySelector('#fc-send-panel').hidden = which !== 'send';
        });
    });
}

async function _saveFeeClaimModal(mid, pool, card) {
    const fb = document.getElementById('ac-feedback');
    const data = {
        enabled:      document.getElementById('ac-enabled')?.checked ?? true,
        fraction:     Number(document.getElementById('ac-fraction')?.value ?? 100),
        minClaimUsdc: Number(document.getElementById('ac-min-claim')?.value ?? 1),
        sendTo:       document.getElementById('ac-sendto')?.value ?? '',
        swapToUsdc:   document.getElementById('ac-swap')?.checked ?? false,
    };
    if (fb) { fb.textContent = tr('sb.saving', 'Speichere…'); fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/pools/liquidity/${pool.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autoCompound: data }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        closeModal(mid);
        _ctx.showToast?.(tr('sliq.fee_claim_saved', 'Fee Claim gespeichert'), 'success');
        await _refreshPoolsCard(card);
    } catch (err) {
        if (fb) { fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb.className = 'modal-feedback error'; }
    }
}

// ── SL / TP – Modal (zwei Tabs) ───────────────────────────────────────────────

function _openSLTPModal(pool, addrs, card) {
    const mid = 'liquiditybot-sltp-modal';

    const resetAction = { label: tr('sliq.hwm_reset_btn', '↺ Höchststand zurücksetzen'), onClick: null };
    const saveAction  = { label: tr('msg.save', 'Speichern'), primary: true, onClick: null };

    showModal({
        id:    mid,
        title: `${tr('sliq.risk_management', 'Risk-Management')} – ${pool.displayPair ?? pool.pair}`,
        body:  `
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-wm="ts">Trailing Stop</button>
                <button class="wm-tab"        data-wm="tvl">TVL</button>
                <button class="wm-tab"        data-wm="sl">Score Limit</button>
            </div>
            <div id="sltp-ts"  class="sltp-settings ts-settings">${_ndModalNotice(pool, ['trailingStop'])}${_buildTrailingStopPanel(pool, addrs)}</div>
            <div id="sltp-tvl" class="sltp-settings" hidden>${_ndModalNotice(pool, ['tvlProtection'])}${_buildTvlPanel(pool, addrs)}</div>
            <div id="sltp-sl"  hidden>${_ndModalNotice(pool, ['scoreLimit'])}${_buildScoreLimitPanel(pool, addrs)}</div>`,
        // Reihenfolge bestimmt die Position im Fuß (flex, justify-end): Reset links von Speichern.
        actions: [
            resetAction,
            saveAction,
            { label: tr('common.close', 'Schließen'), onClick: () => closeModal(mid) },
        ],
    });

    const backdrop = getModal(mid);
    if (!backdrop) return;

    const saveBtn  = backdrop.querySelector('[data-mi="1"]');
    const resetBtn = backdrop.querySelector('[data-mi="0"]');

    function setSaveTarget(which) {
        if (which === 'sl') {
            saveAction.onClick = () => _saveScoreLimitPanel(pool, addrs, card, getModal(mid));
        } else if (which === 'tvl') {
            saveAction.onClick = () => _saveTvlPanel(pool, card, getModal(mid));
        } else {
            saveAction.onClick = () => _saveTrailingStopPanel(pool, card, getModal(mid));
        }
        if (saveBtn) saveBtn.textContent = tr('msg.save', 'Speichern');
        // Reset-Button gehört nur zum Trailing-Stop-Tab, und nur solange ein
        // Referenzwert (HWM) existiert — sonst gäbe es nichts zurückzusetzen.
        if (resetBtn) {
            const hasHwm = !!backdrop.querySelector('.ts-status-block[data-hwm]');
            resetBtn.style.display = (which === 'ts' && hasHwm) ? '' : 'none';
        }
    }
    setSaveTarget('ts');

    // Alle drei Panels kurz einblenden, maximale Höhe messen und als min-height setzen,
    // damit der Modalinhalt beim Tab-Wechsel nicht springt.
    requestAnimationFrame(() => {
        const panels = ['sltp-tvl', 'sltp-ts', 'sltp-sl']
            .map(id => backdrop.querySelector(`#${id}`)).filter(Boolean);
        panels.forEach(p => { p._wasHidden = p.hidden; p.hidden = false; });
        const maxH = Math.max(...panels.map(p => p.scrollHeight));
        panels.forEach(p => { p.hidden = p._wasHidden; delete p._wasHidden; });
        panels.forEach(p => { p.style.minHeight = maxH + 'px'; });
    });

    backdrop.querySelectorAll('.wm-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const which = btn.dataset.wm;
            backdrop.querySelectorAll('.wm-tab').forEach(b => b.classList.toggle('active', b === btn));
            backdrop.querySelector('#sltp-sl').hidden  = which !== 'sl';
            backdrop.querySelector('#sltp-ts').hidden  = which !== 'ts';
            backdrop.querySelector('#sltp-tvl').hidden = which !== 'tvl';
            setSaveTarget(which);
        });
    });

    // TVL-Schutz: Toggle-Sichtbarkeit + Live-Validierung der Summe
    _wireTvlPanel(backdrop);

    _wireSlPanelListeners(backdrop);

    // Trailing-Stop: Live-Update wenn eine der beiden Drawdown-Schwellen geändert wird.
    // Maßgeblich ist die Stufe, die der Bot aktuell anwendet — bei scharfer Stufe 2 also
    // Drawdown 2. Sonst würde die Vorschau eine Liquidationsgrenze zeigen, die nicht gilt.
    const _tsD2Armed = !!pool.trailingStopStatus?.d2ArmedAt;
    const _tsLivePreview = () => {
        const raw1 = backdrop.querySelector('#ts-threshold')?.value ?? '';
        const raw2 = backdrop.querySelector('#ts-threshold2')?.value ?? '';
        const has2 = String(raw2).trim() !== '';
        const thr  = parseFloat(_tsD2Armed && has2 ? raw2 : raw1);
        if (!Number.isFinite(thr) || thr < 0.5) return;
        const sb = backdrop.querySelector('.ts-status-block[data-hwm]');
        if (!sb) return;
        const hwmUsd     = parseFloat(sb.dataset.hwm);
        const currentUsd = parseFloat(sb.dataset.current);
        if (!(hwmUsd > 0)) return;
        const trigger = hwmUsd * (1 - thr / 100);
        const fmt     = v => v.toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        // Liquidations-Label aktualisieren
        const valEl = backdrop.querySelector('#ts-liquidation-val');
        if (valEl) valEl.textContent = fmt(trigger);

        // Aktuell-Marker neu positionieren (Bar-Ursprung verschiebt sich mit Liquidation)
        const barSpan  = hwmUsd - trigger;
        const newPctN  = barSpan > 0 ? Math.max(0, Math.min(100, (currentUsd - trigger) / barSpan * 100)) : 0;
        const marker   = backdrop.querySelector('#ts-curr-marker');
        if (marker) {
            marker.style.left      = newPctN.toFixed(1) + '%';
            marker.style.transform = `translateX(${newPctN > 80 ? '-100%' : newPctN < 20 ? '0%' : '-50%'})`;
        }
    };
    backdrop.querySelector('#ts-threshold')?.addEventListener('input', _tsLivePreview);
    backdrop.querySelector('#ts-threshold2')?.addEventListener('input', _tsLivePreview);

    // Trailing-Stop: Höchststand zurücksetzen (Fuß-Button, links von Speichern)
    resetAction.onClick = async () => {
        const btn = resetBtn;
        if (btn) btn.disabled = true;
        try {
            const sb0 = backdrop.querySelector('.ts-status-block[data-hwm]');
            const targetHwm = sb0 ? parseFloat(sb0.dataset.current) : null;
            const res = await fetch(`/api/pools/liquidity/${pool.id}/trailing-stop/reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetHwm }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

            // Gauge sofort aktualisieren: neuer Höchststand = aktueller Wert
            const sb = backdrop.querySelector('.ts-status-block[data-hwm]');
            if (sb) {
                const currentUsd = parseFloat(sb.dataset.current);
                // Auch hier die geltende Stufe verwenden — der Höchststand-Reset ändert
                // die Referenz, nicht die Schwelle: eine scharfe Stufe 2 bleibt scharf.
                const _raw2      = backdrop.querySelector('#ts-threshold2')?.value ?? '';
                const thr        = (_tsD2Armed && String(_raw2).trim() !== '')
                    ? parseFloat(_raw2)
                    : parseFloat(backdrop.querySelector('#ts-threshold')?.value ?? '33');
                const fmt        = v => v.toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                if (currentUsd > 0 && Number.isFinite(thr)) {
                    const newTrigger = currentUsd * (1 - thr / 100);

                    // data-hwm auf neuen Wert setzen (damit Slider korrekt weiterrechnet)
                    sb.dataset.hwm = currentUsd;

                    // Höchststand-Label
                    const hwmLbl = sb.querySelector('span[style*="color:#94a3b8"] span');
                    if (hwmLbl) hwmLbl.textContent = fmt(currentUsd);

                    // Liquidations-Label
                    const valEl = sb.querySelector('#ts-liquidation-val');
                    if (valEl) valEl.textContent = fmt(newTrigger);

                    // Marker: Aktuell = HWM → ganz rechts
                    const marker = sb.querySelector('#ts-curr-marker');
                    if (marker) {
                        marker.style.left      = '100%';
                        marker.style.transform = 'translateX(-100%)';
                    }
                }
            }

            _ctx.showToast?.(tr('sliq.hwm_reset', 'Referenzwert zurückgesetzt'), 'success');

            // Pools-Karte neu laden (wie nach jedem anderen Speichern in diesem Modal,
            // z.B. _saveTrailingStopPanel()) — sonst zeigt jede andere Ansicht auf
            // dieselben Pool-Daten (Tabelle, ein Wiederöffnen dieses Modals) weiterhin den
            // alten Höchststand, bis die Seite manuell neu geladen wird. Der Server kennt
            // den neuen Wert sofort (routes/pools.js zeigt resetTargetUsd an, solange
            // hwm_at < resetRequestedAt), nur diese Karte hatte ihn nie erneut abgefragt.
            await _refreshPoolsCard(card);
        } catch (err) {
            _ctx.showToast?.(tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    // Trailing-Stop-Panel: Toggle steuert Sichtbarkeit der Folgezeilen
    backdrop.querySelector('#ts-enabled')?.addEventListener('change', e => {
        const on = e.target.checked;
        backdrop.querySelectorAll('.ts-dependent').forEach(el => { el.style.opacity = on ? '1' : '0.4'; });
        const thr      = backdrop.querySelector('#ts-threshold');
        const thr2     = backdrop.querySelector('#ts-threshold2');
        const auto     = backdrop.querySelector('#ts-auto');
        const minVal   = backdrop.querySelector('#ts-min-value');
        const swap     = backdrop.querySelector('#ts-swap');
        const send     = backdrop.querySelector('#ts-sendto');
        const cooldown = backdrop.querySelector('#ts-cooldown');
        if (thr)      thr.disabled      = !on;
        // #ts-threshold2 fehlte hier bis LIQ#0351: Bei ausgeschaltetem Trailing Stop
        // wirkte die Zeile ausgegraut, blieb aber bedienbar.
        if (thr2)     thr2.disabled     = !on;
        // „Auto" bleibt gesperrt, wenn es gar keine Empfehlung gibt — dann darf ein
        // Einschalten des Trailing Stops es nicht freigeben.
        if (auto)     auto.disabled     = !on || auto.dataset.locked === '1';
        if (minVal)   minVal.disabled   = !on;
        if (swap)     swap.disabled     = !on;
        if (send)     send.disabled     = !on;
        if (cooldown) cooldown.disabled = !on;
        _tsSyncAdviceDisplay(backdrop);
    });

    // „Drawdown Auto" umlegen: Ausgrauen und übernommenen Wert sofort nachziehen.
    backdrop.querySelector('#ts-auto')?.addEventListener('change', () => _tsSyncAdviceDisplay(backdrop));

    // Score-Status-Block beim Tab-Wechsel leise aktualisieren (Formwerte bleiben erhalten)
    _addModalVisibilityRefresh(mid, async () => {
        const res = await fetch(`/api/pools/liquidity?t=${Date.now()}`);
        if (!res.ok) return;
        const freshPools = await res.json();
        const freshPool  = freshPools.find(p => p.id === pool.id);
        if (!freshPool) return;
        const sb = getModal(mid)?.querySelector('#sl-status-block');
        if (!sb) return;
        const minScore       = Number(getModal(mid)?.querySelector('#sl-minscore')?.value) || 30;
        const minConsecutive = Number.isFinite(Number(pool.settings?.scoreLimit?.minConsecutive))
            ? Number(pool.settings.scoreLimit.minConsecutive) : 1;
        const tmp = document.createElement('div');
        tmp.innerHTML = _buildSlStatusBlock(freshPool, minScore, minConsecutive);
        sb.replaceWith(tmp.firstElementChild);
    });
}

function _buildTrailingStopStatusBlock(pool, threshold, stageInfo = {}) {
    const st = pool.trailingStopStatus;
    if (!st || !(st.hwmUsd > 0) || !(st.currentUsd > 0)) {
        return `
        <div class="ts-status-block">
            <p class="wallet-hint" style="font-size:0.78rem; margin:0;">
                ${tr('sliq.hwm_pending', 'ℹ Referenzwert wird beim nächsten Snapshot (≤10 Min) etabliert.')}
            </p>
        </div>`;
    }

    const triggerUsd = st.hwmUsd * (1 - threshold / 100);
    const fmt        = v => v.toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Timestamp nur per Hover sichtbar
    const snapshotDate = st.snapshotAt ? new Date(st.snapshotAt) : null;
    const standTxt = snapshotDate
        ? tr('time.hour_label', '{time} Uhr', {
            time: snapshotDate.toLocaleDateString(NUM_LOCALE, { day: '2-digit', month: '2-digit', year: '2-digit' })
                  + ' ' + snapshotDate.toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' }),
          })
        : '–';
    const hoverAttrs = `data-tooltip-title="${tr('sliq.last_update', 'Letztes Update')}" data-tooltip-content="${standTxt}"`;

    // Stufen-Hinweis: nur wenn Stufe 2 tatsächlich scharf ist. Der Hinweis auf die noch
    // inaktive Stufe 1 entfällt bewusst — das Panel wäre sonst zu hoch (Festlegung 23.08.2026).
    const { d2Armed = false, threshold: thr1 = null, threshold2: thr2 = null } = stageInfo;
    const stageBadge = (thr2 != null && d2Armed)
        ? `<div style="margin-top:0.45rem; font-size:0.7rem; color:#86efac;">
               ${tr('sliq.ts_stage2_active', '● Stufe 2 aktiv (Gewinnsicherung): Drawdown {pct}&thinsp;% statt {first}&thinsp;%.', { pct: thr2, first: thr1 })}
           </div>`
        : '';

    // Bar spannt exakt von triggerUsd (links) bis hwmUsd (rechts)
    const barSpan = st.hwmUsd - triggerUsd;
    const currPct = barSpan > 0
        ? Math.max(0, Math.min(100, (st.currentUsd - triggerUsd) / barSpan * 100))
        : 0;

    return `
    <div class="ts-status-block" style="margin-top:0.8rem; padding-top:0.8rem; border-top:1px solid rgba(255,255,255,0.08);"
         data-hwm="${st.hwmUsd}" data-current="${st.currentUsd}">

        <!-- Labels über der Bar: Liquidation links, Höchststand rechts -->
        <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:0.18rem; font-size:0.68rem; line-height:1.2;">
            <span style="color:#ef4444; white-space:nowrap;">
                ${tr('sliq.liquidation_label', 'Liquidation:')} <span id="ts-liquidation-val" style="cursor:default;" ${hoverAttrs}>${fmt(triggerUsd)}</span> USDC
            </span>
            <span style="color:#94a3b8; white-space:nowrap;">
                ${tr('sliq.hwm_label', 'Höchststand:')} <span style="cursor:default;" ${hoverAttrs}>${fmt(st.hwmUsd)}</span> USDC
            </span>
        </div>

        <!-- Bar mit Endpunkt-Ticks und Gradient -->
        <div style="display:flex; align-items:center;">
            <div style="width:2px; height:14px; background:#ef4444; flex-shrink:0; border-radius:1px;"></div>
            <div style="flex:1; position:relative;">
                <div style="height:8px; background:linear-gradient(to right, rgba(239,68,68,0.35), rgba(34,197,94,0.28));"></div>
                <!-- Aktuell-Marker unter der Bar -->
                <!-- transform je nach Position: links/mittig/rechts bündig, damit kein Overflow -->
                <div id="ts-curr-marker" style="position:absolute; top:0; left:${currPct.toFixed(1)}%; transform:translateX(${currPct > 80 ? '-100%' : currPct < 20 ? '0%' : '-50%'});">
                    <div style="width:2px; height:8px; background:#60a5fa; ${currPct > 80 ? 'margin-left:auto;' : currPct < 20 ? '' : 'margin:0 auto;'}"></div>
                    <div style="margin-top:4px; white-space:nowrap; font-size:0.68rem; color:#60a5fa; line-height:1.2; text-align:${currPct > 80 ? 'right' : currPct < 20 ? 'left' : 'center'};">
                        ${tr('sliq.current_label', 'Aktuell:')} <span style="cursor:default;" ${hoverAttrs}>${fmt(st.currentUsd)}</span> USDC
                    </div>
                </div>
            </div>
            <div style="width:2px; height:14px; background:#94a3b8; flex-shrink:0; border-radius:1px;"></div>
        </div>

        ${stageBadge}
    </div>`;
}

function _fmtUsdExact(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '–';
    return n.toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDC';
}

function _buildTrailingStopPanel(pool, addrs = [], mode = 'pool') {
    const typeMode = mode === 'type';
    // Type-Mode: eigenes ID-Präfix, damit auf derselben Seite gleichzeitig ein Pool-Modal
    // (unpräfigierte IDs, document.getElementById-Zugriffe in _saveTrailingStopPanel) und
    // diese eingebettete Ansicht existieren können, ohne dass IDs kollidieren.
    const idp = typeMode ? 'pt-' : '';
    const ts = pool.settings.trailingStop ?? { enabled: true, thresholdPct: 33, thresholdPct2: null, minimumValueUsd: null, autoSwapToUSDC: true, sendTo: '', cooldownHours: 1 };
    const on = !!ts.enabled;
    const threshold = Number.isFinite(Number(ts.thresholdPct)) ? Number(ts.thresholdPct) : 33;
    // null/'' bedeutet „zweite Stufe aus" — nicht auf einen Default fallen, sonst würde
    // ein enger Stop stillschweigend aktiviert, den der Nutzer nie gesetzt hat.
    const threshold2 = (ts.thresholdPct2 != null && ts.thresholdPct2 !== '' && Number.isFinite(Number(ts.thresholdPct2)))
        ? Number(ts.thresholdPct2)
        : null;
    // Fallback 6 h seit LIQ#0359 — muss POOL_SETTINGS_DEFAULTS.trailingStop.cooldownHours entsprechen.
    const cooldownHours = Number.isFinite(Number(ts.cooldownHours)) ? Number(ts.cooldownHours) : 6;
    // „Auto": Schwellen vom Trailing-Stop-Advisor übernehmen (LIQ#0351).
    // Einschaltbar nur, wenn eine belastbare Empfehlung vorliegt — ein Schalter ohne
    // Wirkung wäre schlimmer als keiner. Der Grund steht im Tooltip, nie nur „gesperrt".
    // Im Typ-Modus gibt es keine poolgebundene Empfehlung — der Schalter bleibt frei
    // editierbar, wirkt aber erst, sobald für den jeweiligen Pool eine Empfehlung vorliegt
    // (Hinweistext im Info-Icon, s.u.).
    const advice     = typeMode ? { available: false, source: 'none' } : (pool.tsAdvice ?? { available: false, source: 'none' });
    const autoOn     = !!ts.auto;
    const autoLocked = typeMode ? false : !advice.available;
    const autoLockReason = advice.source === 'none'
        ? tr('sliq.ts_auto_needs_premium', 'Die Empfehlung wird zentral berechnet und über den Premium-Service geliefert. Ohne aktiven Premium-Service gibt es nichts zu übernehmen.')
        : tr('sliq.ts_auto_no_data', 'Für diesen Pool und seinen Pool-Typ liegt noch keine belastbare Empfehlung vor. Der Advisor braucht genügend abgeschlossene Positionen, um einen Vorteil gegenüber dem eingestellten Wert nachzuweisen.');

    // Herkunft der Empfehlung als Kurzform neben dem Schalter. Drei Stufen, absteigend
    // nach Beweiskraft (siehe bots/liquidity/lib/ts-advice-provider.js): gemessen an der
    // 30-s-Reihe des Pools > aus seiner Preisreihe modelliert > vom Pool-Typ übernommen.
    // Die Unterscheidung gemessen/modelliert bleibt sichtbar — ein modellierter Wert ist
    // eine Herleitung, kein Messwert, und der Nutzer soll das ohne Umweg sehen.
    // Im Typ-Modal bleibt die Zeile leer: Dort gibt es prinzipbedingt keine poolgebundene
    // Empfehlung, „Keine Daten verfügbar" läse sich dort als Störung statt als Zustand.
    const adviceBasis = typeMode
        ? ''
        : !advice.available
        ? tr('sliq.ts_auto_basis_none',  'Keine Daten verfügbar')
        : advice.scope === 'pool'
            ? tr('sliq.ts_auto_basis_pool',  'Basis: Pool Daten')
            : advice.scope === 'pool_floor'
                ? tr('sliq.ts_auto_basis_floor', 'Basis: Pool Daten, angehoben')
                : advice.scope === 'pool_model'
                    ? tr('sliq.ts_auto_basis_model', 'Basis: Preisreihe')
                    : tr('sliq.ts_auto_basis_type',  'Basis: Pool Typ');

    // Greift die Empfehlung gerade wirklich? Nur dann wird der Eingabewert ausgegraut und
    // der übernommene Wert daneben gestellt. `autoOn && advice.available` ist exakt die
    // Bedingung, unter der loadTsConfig() im Bot die Empfehlung statt des Feldwerts nimmt.
    const adviceActive = on && autoOn && !autoLocked && advice.available;
    const adviceD1 = adviceActive ? advice.thresholdPct  : null;
    const adviceD2 = adviceActive ? advice.thresholdPct2 : null;

    const minValueUsd = (ts.minimumValueUsd != null && Number(ts.minimumValueUsd) > 0) ? Math.round(Number(ts.minimumValueUsd)) : 0;
    const currentUsd = pool.currentValue ?? null;
    // Der Status-Block muss mit der Schwelle rechnen, die der Bot gerade anwendet —
    // sonst zeigt das Modal einen Liquidationswert an, der nicht dem echten entspricht.
    // Im Typ-Modus gibt es keine Live-Position, entsprechend auch keinen Gauge.
    const d2Armed     = !!pool.trailingStopStatus?.d2ArmedAt && threshold2 != null;
    const activeThr   = d2Armed ? threshold2 : threshold;
    const statusBlock = (on && !typeMode) ? _buildTrailingStopStatusBlock(pool, activeThr, { d2Armed, threshold, threshold2 }) : '';
    return `
        <div class="settings-row" style="border:none;">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.ts_active', 'Trailing Stop aktiv')}
                <span class="info-tip-label"
                    data-tooltip-title="Trailing Stop"
                    data-tooltip-content="${tr('sliq.ts_tip', 'Zieht den Stop-Wert dynamisch nach: jeder neue Pool-Höchststand (High-Water-Mark) wird gemerkt. Fällt der aktuelle Pool-Wert um den eingestellten Prozentsatz unter die HWM, wird die Position geschlossen.||Snapshot-Quelle: position_snapshots (alle 5-10 Min, lp_value_usd inkl. offener Fees).||Einmalige Aktion — kein automatischer Wiedereinstieg. Cleanup im Modus „Bester Pool“ reinvestiert das freie Kapital im nächsten Lauf.||HWM wird beim Öffnen einer neuen Position zurückgesetzt.')}">&#9432;</span>
            </span>
            <label class="toggle-switch">
                <input type="checkbox" id="${idp}ts-enabled" ${on ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        ${typeMode ? '' : `
        <div class="settings-row ts-dependent" style="opacity:${on ? '1' : '0.4'};"
             data-current-value="${currentUsd ?? ''}">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.pool_min_value', 'Pool Mindestwert')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.pool_min_value', 'Pool Mindestwert')}"
                    data-tooltip-content="${tr('sliq.pool_min_value_tip', 'Fällt der Pool-Betrag unter diesen USDC Betrag, wird er geschlossen.||Tipp: Sinnvoll als absoluter Kapitalschutz, unabhängig vom prozentualen Drawdown.')}">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short" id="ts-min-value"
                    type="number" min="0" step="1" value="${minValueUsd}"
                    ${on ? '' : 'disabled'}>
                <span class="input-unit">USDC</span>
            </div>
        </div>`}
        <div class="settings-row ts-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.drawdown_threshold', 'Drawdown 1')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.drawdown_threshold', 'Drawdown 1')}"
                    data-tooltip-content="${tr('sliq.drawdown_tip', 'Gilt ab dem Einstieg. Empfehlung: 25–40 %. Position wird einmalig komplett geschlossen.||Bewusst weit gewählt: direkt nach dem Einstieg soll normale Schwankung nicht sofort zum Ausstieg führen.||Ohne Send-Adresse bleiben die Coins im Wallet und der nächste Cleanup-Lauf im Modus „Bester Pool“ reinvestiert sie automatisch.')}">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short ts-advised-input${adviceActive ? ' is-advised' : ''}" id="${idp}ts-threshold"
                    type="number" min="0.5" max="90" step="0.01" value="${threshold}"
                    ${on ? '' : 'disabled'}>
                <span class="input-unit">%</span>
                <span class="ts-advised-value" id="${idp}ts-advised-1"${adviceD1 != null
                    ? ` data-tooltip-title="${_esc(TS_ADVISED_TIP.title())}" data-tooltip-content="${_esc(TS_ADVISED_TIP.body())}"` : ''}
                    >${adviceD1 != null ? `→ <strong>${adviceD1} %</strong>` : ''}</span>
            </div>
        </div>
        <div class="settings-row ts-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.drawdown2_threshold', 'Drawdown 2')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.drawdown2_threshold', 'Drawdown 2')}"
                    data-tooltip-content="${tr('sliq.drawdown2_tip', 'Optionale zweite, engere Stufe zur Gewinnsicherung. Leer lassen = aus.||Sie wird scharf, sobald der Pool-Wert den Einstieg um Drawdown 1 übertroffen hat. Ab da gilt sie statt Drawdown 1 — gemessen wie zuvor vom Höchststand.||Beispiel (Drawdown 1 = 2 %, Drawdown 2 = 1 %): Steigt der Wert um 3 %, wird Stufe 2 scharf; der Ausstieg liegt dann bei 1 % unter dem Höchststand, also mit 2 % Gewinn.||Muss kleiner als Drawdown 1 sein. Einmal scharf, bleibt sie es bis zum Schließen der Position.')}">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short ts-advised-input${adviceActive ? ' is-advised' : ''}" id="${idp}ts-threshold2"
                    type="number" min="0.5" max="90" step="0.01" value="${threshold2 ?? ''}"
                    placeholder="${tr('sliq.off_short', 'aus')}"
                    ${on ? '' : 'disabled'}>
                <span class="input-unit">%</span>
                <span class="ts-advised-value" id="${idp}ts-advised-2"${adviceActive
                    ? ` data-tooltip-title="${_esc(TS_ADVISED_TIP.title())}" data-tooltip-content="${_esc(TS_ADVISED_TIP.body())}"` : ''}
                    >${adviceActive ? `→ <strong>${adviceD2 != null ? adviceD2 + ' %' : tr('sliq.off_short', 'aus')}</strong>` : ''}</span>
            </div>
        </div>
        <div class="settings-row ts-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.ts_auto', 'Drawdown Auto')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.ts_auto', 'Drawdown Auto')}"
                    data-tooltip-content="${tr('sliq.ts_auto_tip', 'Drawdown 1 und 2 automatisch bestimmen lassen. Statt fester Werte misst FORGE, wie stark dieser Pool im Normalbetrieb schwankt, und legt die Schwellen knapp darüber — weit genug, um gewöhnliche Schwankungen auszuhalten, eng genug, um bei echten Einbrüchen zu greifen.||Die Werte werden alle zwölf Stunden neu bestimmt. Woher sie gerade stammen, steht rechts neben diesem Schalter.||Ist Auto aus oder liegt nichts vor, gelten die Werte in den beiden Feldern darüber; sind auch die leer, greifen 1,75 % und 0,75 %.')}${typeMode ? '||Hinweis: wirkt erst, sobald für den jeweiligen Pool eine Empfehlung vorliegt.' : ''}">&#9432;</span>
            </span>
            <div style="display:flex;align-items:center;gap:0.6rem;">
                <label class="toggle-switch toggle-sm"
                    ${autoLocked ? `data-tooltip-title="${tr('sliq.ts_auto_locked', 'Drawdown Auto nicht verfügbar')}" data-tooltip-content="${_esc(autoLockReason)}"` : ''}>
                    <input type="checkbox" id="${idp}ts-auto" data-locked="${autoLocked ? '1' : '0'}"
                        data-advice-available="${advice.available ? '1' : '0'}"
                        data-advice-d1="${advice.available ? advice.thresholdPct : ''}"
                        data-advice-d2="${advice.available && advice.thresholdPct2 != null ? advice.thresholdPct2 : ''}"
                        ${autoOn && !autoLocked ? 'checked' : ''} ${on && !autoLocked ? '' : 'disabled'}>
                    <span class="toggle-slider"></span>
                </label>
                <span class="modal-hint ts-advice-basis" style="margin:0;"${adviceBasis
                    ? ` data-tooltip-title="${_esc(adviceBasis)}" data-tooltip-content="${_esc(_tsAdviceTooltip(advice))}"` : ''}
                    >${adviceBasis}</span>
            </div>
        </div>
        <div class="settings-row ts-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.swap_usdc', 'Swap → USDC')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.swap_usdc', 'Swap → USDC')}"
                    data-tooltip-content="${tr('sliq.ts_swap_tip', 'Coins nach Entnahme automatisch in USDC tauschen.')}">&#9432;</span>
            </span>
            <label class="toggle-switch toggle-sm">
                <input type="checkbox" id="${idp}ts-swap" ${ts.autoSwapToUSDC ? 'checked' : ''} ${on ? '' : 'disabled'}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row ts-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label">${tr('sb.send_to', 'Senden an')}</span>
            <select class="modal-select" id="${idp}ts-sendto" ${on ? '' : 'disabled'}>
                <option value="">${tr('sliq.dont_send', '– Nicht senden –')}</option>
                ${_addrOptions(addrs, ts.sendTo ?? '')}
            </select>
        </div>
        <div class="settings-row ts-dependent" style="border:none; opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.cleanup_cooldown', 'Cleanup-Cooldown')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.cleanup_cooldown', 'Cleanup-Cooldown')}"
                    data-tooltip-content="${tr('sliq.ts_cooldown_tip', 'Nach einer Liquidation durch den Trailing Stop ist dieser Pool für die eingestellte Zeit für automatisierte Cleanup-Zuweisungen gesperrt.||Manuelle Einzahlungen bleiben jederzeit möglich.||Cooldown-Start: Zeitpunkt der Liquidation.')}">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short" id="${idp}ts-cooldown"
                    type="number" min="1" max="24" step="1" value="${cooldownHours}"
                    ${on ? '' : 'disabled'}>
                <span class="input-unit">h</span>
            </div>
        </div>
        ${statusBlock}
        <div class="modal-feedback" id="${idp}ts-feedback"></div>`;
}

/**
 * Hält Ausgrauen und übernommenen Wert im Trailing-Stop-Panel aktuell.
 *
 * Ohne das zeigt das Modal nach dem Umlegen von „Drawdown Auto" bis zum nächsten Neuaufbau
 * einen Zustand, den der Bot gar nicht anwendet — genau die stille Abweichung zwischen
 * Anzeige und Wirkung, die das Panel sonst überall vermeidet.
 */
function _tsSyncAdviceDisplay(root) {
    const auto = root.querySelector('#ts-auto');
    const en   = root.querySelector('#ts-enabled');
    if (!auto) return;

    const aktiv = !!en?.checked && !!auto.checked
               && auto.dataset.locked !== '1' && auto.dataset.adviceAvailable === '1';

    for (const [feld, anzeige, wert] of [
        ['#ts-threshold',  '#ts-advised-1', auto.dataset.adviceD1],
        ['#ts-threshold2', '#ts-advised-2', auto.dataset.adviceD2],
    ]) {
        root.querySelector(feld)?.classList.toggle('is-advised', aktiv);
        const el = root.querySelector(anzeige);
        if (!el) continue;
        el.innerHTML = !aktiv
            ? ''
            : `\u2192 <strong>${wert ? wert + ' %' : tr('sliq.off_short', 'aus')}</strong>`;
        // Ohne dieses Mitziehen bliebe der Tooltip an einem leeren Element hängen.
        if (aktiv) {
            el.dataset.tooltipTitle   = TS_ADVISED_TIP.title();
            el.dataset.tooltipContent = TS_ADVISED_TIP.body();
        } else {
            delete el.dataset.tooltipTitle;
            delete el.dataset.tooltipContent;
        }
    }
}

/** Tooltip am übernommenen Drawdown-Wert. Ein Ort, den Template und Live-Abgleich teilen. */
const TS_ADVISED_TIP = {
    title: () => tr('sliq.ts_advised_tip_title', 'Info zum Drawdown-Wert'),
    body:  () => tr('sliq.ts_advised_tip', 'Daten stammen vom Drawdown Auto Premium Service.'),
};

/**
 * Erklärt die Herkunft der Trailing-Stop-Empfehlung für den Nutzer.
 *
 * 🔒 Bewusst NICHT `advice.reason` aus `ts_advisor_log`: Der Text ist für die CLI und den
 * Betrieb geschrieben („95 % unter 1,27 %, Referenz-Range 6,0 %") und beantwortet die Frage
 * eines Entwicklers, nicht die des Nutzers.
 *
 * 🔒 Beantwortet wird nur „woher kommt der Wert und was ändert sich noch" — nicht, wie er
 * gerechnet wird. Stichprobengrößen, Quantile und Fensterzahlen sind hier bewusst raus: Sie
 * sind für die Entscheidung des Nutzers folgenlos und haben den Tooltip auf die dreifache
 * Länge gebracht. Wer die Herleitung braucht, findet sie in `bin/trailing-stop-advisor.js`
 * und in `ts_advisor_log.reason`.
 */
function _tsAdviceTooltip(advice) {
    if (!advice?.available) {
        return tr('sliq.ts_basis_tip_none',
            'Für diesen Pool und ähnliche liegen noch nicht genug Daten vor. Es gelten die Werte '
          + 'in den Feldern darüber.');
    }
    if (advice.scope === 'pool') {
        return tr('sliq.ts_basis_tip_pool',
            'Gemessen an diesem Pool, während er investiert war. Der Kursverlauf bestätigt die '
          + 'Messung — beide Wege kommen auf denselben Wert.');
    }
    // Die Messung sieht nur Rücksetzer, von denen sich der Pool wieder erholt hat. Ein
    // Rücksetzer unterhalb der laufenden Schwelle beendet die Position und fehlt deshalb in
    // der Messung (LIQ#0399). Der Nutzer soll sehen, dass hier nicht die Messung entschied.
    if (advice.scope === 'pool_floor') {
        return tr('sliq.ts_basis_tip_floor',
            'Gemessen an diesem Pool — der Wert wurde aber angehoben: Der Stop beendet die '
          + 'Messung, sobald er auslöst, und verdeckt so die größeren Ausschläge. Der '
          + 'Kursverlauf des Pools zeigt sie und gibt den weiteren Wert vor.');
    }
    if (advice.scope === 'pool_model') {
        return tr('sliq.ts_basis_tip_model',
            'Dieser Pool war noch nicht lange genug investiert — FORGE leitet die Werte aus seinem '
          + 'Kursverlauf ab. Sobald er länger läuft, ersetzt die echte Messung sie.');
    }
    return tr('sliq.ts_basis_tip_type',
        'Für diesen Pool allein reichen die Daten noch nicht — FORGE nimmt den Wert ähnlich '
      + 'bewegter Pools. Sobald genug eigene Daten da sind, bekommt er seinen eigenen.');
}

async function _saveTrailingStopPanel(pool, card, modalEl) {
    const fb = document.getElementById('ts-feedback');
    const enabled        = document.getElementById('ts-enabled')?.checked ?? false;
    const thresholdRaw   = document.getElementById('ts-threshold')?.value ?? '33';
    const threshold2Raw  = document.getElementById('ts-threshold2')?.value ?? '';
    const minValueRaw    = document.getElementById('ts-min-value')?.value ?? '';
    const autoEl         = document.getElementById('ts-auto');
    // Ein gesperrtes „Auto" darf nie als true gesendet werden — der Server weist es
    // ohnehin ab, aber die Oberfläche soll gar nicht erst etwas Unmögliches behaupten.
    const auto           = !!(autoEl?.checked) && autoEl?.dataset.locked !== '1';
    const autoSwapToUSDC = document.getElementById('ts-swap')?.checked ?? false;
    const sendTo         = document.getElementById('ts-sendto')?.value ?? '';
    const cooldownRaw    = document.getElementById('ts-cooldown')?.value ?? '1';

    const threshold = parseFloat(thresholdRaw);
    if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 90) {
        if (fb) { fb.textContent = tr('sliq.drawdown_range_err', 'Drawdown 1 muss zwischen 0,5 und 90 % liegen.'); fb.className = 'modal-feedback error'; }
        return;
    }

    // Drawdown 2: leer = zweite Stufe aus. Sonst enger als Stufe 1, sonst würde die
    // Scharfschaltung den Schutz lockern statt ihn zu verschärfen.
    let threshold2 = null;
    if (String(threshold2Raw).trim() !== '') {
        threshold2 = parseFloat(threshold2Raw);
        if (!Number.isFinite(threshold2) || threshold2 < 0.5 || threshold2 > 90) {
            if (fb) { fb.textContent = tr('sliq.drawdown2_range_err', 'Drawdown 2 muss zwischen 0,5 und 90 % liegen.'); fb.className = 'modal-feedback error'; }
            return;
        }
        if (threshold2 >= threshold) {
            if (fb) { fb.textContent = tr('sliq.drawdown2_order_err', 'Drawdown 2 muss kleiner als Drawdown 1 sein — die zweite Stufe sichert enger ab.'); fb.className = 'modal-feedback error'; }
            return;
        }
    }

    // Pool Mindestwert: 0 = deaktiviert; sonst ganzzahlig > 0 und < aktueller Pool-Wert
    // Validierung nur wenn Trailing Stop aktiv – beim Deaktivieren ist der Wert irrelevant
    const parsedMin = parseInt(minValueRaw, 10);
    let minimumValueUsd = null;
    if (Number.isFinite(parsedMin) && parsedMin > 0) {
        if (enabled) {
            const currentUsd = pool.currentValue ?? null;
            if (currentUsd !== null && parsedMin >= currentUsd) {
                const fmt = v => v.toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                if (fb) { fb.textContent = tr('sliq.pool_min_too_high', 'Pool Mindestwert ({min} USDC) muss kleiner sein als der aktuelle Pool-Wert ({current} USDC).', { min: parsedMin, current: fmt(currentUsd) }); fb.className = 'modal-feedback error'; }
                return;
            }
        }
        minimumValueUsd = parsedMin;
    }

    const cooldownHours = parseInt(cooldownRaw, 10);
    if (!Number.isFinite(cooldownHours) || cooldownHours < 1 || cooldownHours > 24) {
        if (fb) { fb.textContent = tr('sliq.cooldown_range_err', 'Cleanup-Cooldown muss zwischen 1 und 24 h liegen.'); fb.className = 'modal-feedback error'; }
        return;
    }

    if (fb) { fb.textContent = tr('sb.saving', 'Speichere…'); fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/pools/liquidity/${pool.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trailingStop: { enabled, thresholdPct: threshold, thresholdPct2: threshold2, auto, minimumValueUsd, autoSwapToUSDC, sendTo, cooldownHours } }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        if (fb) { fb.textContent = tr('sliq.saved_no_dot', '✓ Gespeichert'); fb.className = 'modal-feedback success'; }
        _ctx.showToast?.(tr('sliq.ts_saved', 'Trailing-Stop-Einstellungen gespeichert'), 'success');

        // Gauge im offenen Modal mit gespeichertem Threshold aktualisieren
        const sb = modalEl?.querySelector('.ts-status-block[data-hwm]');
        if (sb) {
            const hwmUsd     = parseFloat(sb.dataset.hwm);
            const currentUsd = parseFloat(sb.dataset.current);
            const fmt        = v => v.toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            if (hwmUsd > 0) {
                const trigger = hwmUsd * (1 - threshold / 100);
                const barSpan = hwmUsd - trigger;
                const newPctN = barSpan > 0 ? Math.max(0, Math.min(100, (currentUsd - trigger) / barSpan * 100)) : 0;

                const valEl  = modalEl.querySelector('#ts-liquidation-val');
                const marker = modalEl.querySelector('#ts-curr-marker');

                if (valEl) valEl.textContent = fmt(trigger);
                if (marker) {
                    marker.style.left      = newPctN.toFixed(1) + '%';
                    marker.style.transform = `translateX(${newPctN > 80 ? '-100%' : newPctN < 20 ? '0%' : '-50%'})`;
                }
            }
        }

        await _refreshPoolsCard(card);
    } catch (err) {
        if (fb) { fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb.className = 'modal-feedback error'; }
    }
}

function _wireSlPanelListeners(backdrop) {
    backdrop.querySelector('#sl-enabled')?.addEventListener('change', e => {
        const on = e.target.checked;
        backdrop.querySelectorAll('.sl-dependent').forEach(el => { el.style.opacity = on ? '1' : '0.4'; });
        const score    = backdrop.querySelector('#sl-minscore');
        const swap     = backdrop.querySelector('#sl-swap');
        const send     = backdrop.querySelector('#sl-sendto');
        const cooldown = backdrop.querySelector('#sl-cooldown');
        if (score)    score.disabled    = !on;
        if (swap)     swap.disabled     = !on;
        if (send)     send.disabled     = !on;
        if (cooldown) cooldown.disabled = !on;
    });
    backdrop.querySelector('#sl-minscore')?.addEventListener('input', e => {
        const threshold = Number(e.target.value);
        if (!Number.isFinite(threshold)) return;
        const sb = backdrop.querySelector('#sl-status-block');
        if (!sb) return;
        const scoreRaw = parseFloat(sb.dataset.score);
        if (!Number.isFinite(scoreRaw)) return;
        const below = scoreRaw < threshold;
        const valEl = sb.querySelector('#sl-score-value');
        if (!valEl) return;
        valEl.style.color = below ? 'var(--danger)' : 'var(--success)';
        valEl.innerHTML   = `${below ? '✗' : '✓'}&thinsp;${scoreRaw}`;
    });
}

function _buildSlStatusBlock(pool, minScore, minConsecutive) {
    const state = pool.scoreLimitState ?? {};
    // exitValue statt value: lib/score-limit.js vergleicht exakt gegen exitValue (den
    // Score OHNE Volumen-Malus, damit dieser Malus nie einen Exit auslöst — Absicht,
    // siehe invest-score-compute.js). Vorher zeigte diese Karte value an, was bei
    // Pools mit Malus einen anderen (meist niedrigeren) Wert als die tatsächliche
    // Trigger-Entscheidung zeigte — sichtbar u.a. daran, dass "X/3 Zyklen unterschritten"
    // nie hochzählte, obwohl der angezeigte Wert dauerhaft unter der Schwelle lag.
    const currentScore = pool.investScore?.exitValue ?? pool.investScore?.value ?? null;
    const { consecutiveBelow = 0, lastCheckedAt = null, checkIntervalMs = 300_000 } = state;

    // Ein fehlender Score hat zwei grundverschiedene Ursachen (Entscheidung 2026-07-25,
    // Analogie zum Dashboard-Platzhalter in html/liquidity/js/app.js): scoreSource==='none'
    // ist ein Premium-Merkmal, das hier nicht bezogen wird (kein Fehler); "keine Daten"
    // bleibt für den Fall reserviert, dass die Daten schlicht noch nicht vorliegen.
    let scoreHtml;
    if (currentScore === null && pool.scoreSource === 'none') {
        scoreHtml = `<span style="color:var(--text-muted);font-size:0.82rem;">${tr('sliq.premium_locked', 'Premium 🔒')}</span>`;
    } else if (currentScore === null) {
        scoreHtml = `<span style="color:var(--text-muted);font-size:0.82rem;">${tr('sliq.no_data_lc', 'keine Daten')}</span>`;
    } else {
        const below = currentScore < Number(minScore);
        const color = below ? 'var(--danger)' : 'var(--success)';
        const icon  = below ? '✗' : '✓';
        scoreHtml = `<span id="sl-score-value" style="font-size:1.05rem;font-weight:700;color:${color};">${icon}&thinsp;${currentScore}</span>`;
        // Zyklen-Zähler nur anzeigen, wenn es überhaupt mehrere zu zählen gibt
        // (minConsecutive > 1). Bei "sofort" (Default seit 2026-07-29) wäre "1/1
        // Zyklen unterschritten" reine Redundanz zum roten Score darüber — der Pool
        // ist dann ohnehin schon fällig, nicht "im Zählvorgang".
        if (below && consecutiveBelow > 0 && minConsecutive > 1) {
            const displayCount = Math.min(consecutiveBelow, minConsecutive);
            scoreHtml += `<div style="font-size:0.75rem;color:var(--danger);margin-top:0.15rem;">${tr('sliq.cycles_below', '{n}&thinsp;/&thinsp;{max} Zyklen unterschritten', { n: displayCount, max: minConsecutive })}</div>`;
        }
    }

    let nextCheckHtml = '';
    if (lastCheckedAt) {
        const d  = new Date(lastCheckedAt + checkIntervalMs);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        nextCheckHtml = `<span style="font-size:0.75rem;color:var(--text-muted);">${tr('sliq.next_check', 'Nächster Check:&nbsp;{time}&nbsp;Uhr', { time: `${hh}:${mm}` })}</span>`;
    }

    return `
        <div id="sl-status-block" data-score="${currentScore ?? ''}"
             style="margin-top:0.6rem;padding:0.55rem 0.75rem;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;display:flex;justify-content:space-between;align-items:flex-end;gap:0.5rem;">
            <div>
                <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);margin-bottom:0.25rem;">${tr('sliq.current_score', 'Aktueller Score')}</div>
                ${scoreHtml}
            </div>
            ${nextCheckHtml ? `<div style="text-align:right;flex-shrink:0;">${nextCheckHtml}</div>` : ''}
        </div>`;
}

// Score-Zustand als eigener Hinweis-Kasten (Entscheidung 2026-07-25 „Zustand immer sichtbar"):
// Der Schalter bleibt bedienbar und die Einstellung wird gespeichert, damit sie sofort greift,
// sobald der Score verfügbar wird — nur die aktuelle Wirkungslosigkeit muss klar sein, statt
// still zu bleiben (fail-safe im Bot: shouldTriggerScoreLimit löst bei fehlendem Score nie aus).
function _buildScoreStateNotice(pool) {
    if (pool.scoreSource === 'none') {
        return `<div style="margin-bottom:0.75rem;padding:0.6rem 0.75rem;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;font-size:0.78rem;color:var(--text-muted);line-height:1.5;">
            ${tr('sliq.score_premium_hint_1', '🔒&nbsp; Der Opportunity Score wird über den Premium-Datendienst geliefert und ist in dieser Installation nicht aktiv. Die Einstellung wird gespeichert,')} <strong>${tr('sliq.score_premium_hint_2', 'löst aber aktuell nicht aus')}</strong> ${tr('sliq.score_premium_hint_3', '— Trailing Stop und TVL-Schutz arbeiten unabhängig davon.')}
        </div>`;
    }
    if (pool.scoreSource === 'delivered' && pool.scoreStale) {
        return `<div style="margin-bottom:0.75rem;padding:0.6rem 0.75rem;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;font-size:0.78rem;color:var(--text-muted);line-height:1.5;">
            ${tr('sliq.score_stale_hint', '⚠️&nbsp; Die gelieferten Premium-Score-Daten sind veraltet (&gt;2h). Score Limit ist bis zur nächsten Lieferung ausgesetzt.')}
        </div>`;
    }
    return '';
}

function _buildScoreLimitPanel(pool, addrs, mode = 'pool') {
    const typeMode = mode === 'type';
    const idp      = typeMode ? 'pt-' : '';
    const s  = pool.settings.scoreLimit ?? { enabled: false, minScore: 30, minConsecutive: 1, swapToUsdc: true, sendTo: '', cooldownHours: 1 };
    const on = !!s.enabled;
    const minScore       = Number.isFinite(Number(s.minScore))       ? Number(s.minScore)       : 30;
    const minConsecutive = Number.isFinite(Number(s.minConsecutive)) ? Number(s.minConsecutive) :  1;
    const cooldownHours  = Number.isFinite(Number(s.cooldownHours))  ? Number(s.cooldownHours)  :  1;

    return `
        <div class="sltp-settings">
        ${_buildScoreStateNotice(pool)}
        <div class="settings-row">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.3rem;">
                ${tr('sliq.filter_active', 'Aktiv')}
                <span class="info-tip-label"
                    data-tooltip-title="Score Limit"
                    data-tooltip-content="${tr('sliq.score_limit_tip', 'Fällt der Opportunity Score des Pools unter die eingestellte Schwelle, wird das gesamte Kapital automatisch abgezogen.||Gezeigt und verglichen wird der Score OHNE Volumen-Malus – dieser Malus darf nie einen Exit auslösen, deshalb kann der hier angezeigte Wert vom Dashboard-Score abweichen.||Null-Score (fehlende Daten) → kein Auslösen.||Einmalige Aktion – kein automatischer Wiedereinstieg.')}">&#9432;</span>
            </span>
            <label class="toggle-switch">
                <input type="checkbox" id="${idp}sl-enabled" ${on ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row sl-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.opp_score_below', 'Opportunity Score unter')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.opp_score_below', 'Opportunity Score unter')}"
                    data-tooltip-content="${tr('sliq.score_limit_rec_tip', 'Empfehlung: Schwelle 25–35. Position wird einmalig komplett geschlossen.||Ohne Send-Adresse bleiben die Coins im Wallet und der nächste Cleanup-Lauf im Modus „Bester Pool“ reinvestiert sie automatisch.')}">&#9432;</span>
            </span>
            <input class="modal-input input-short" id="${idp}sl-minscore"
                type="number" min="0" max="100" step="1" value="${minScore}"
                ${on ? '' : 'disabled'}>
        </div>
        <div class="settings-row sl-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.swap_usdc', 'Swap → USDC')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.swap_usdc', 'Swap → USDC')}"
                    data-tooltip-content="${tr('sliq.ts_swap_tip', 'Coins nach Entnahme automatisch in USDC tauschen.')}">&#9432;</span>
            </span>
            <label class="toggle-switch toggle-sm">
                <input type="checkbox" id="${idp}sl-swap" ${s.swapToUsdc !== false ? 'checked' : ''} ${on ? '' : 'disabled'}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row sl-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label">${tr('sb.send_to', 'Senden an')}</span>
            <select class="modal-select" id="${idp}sl-sendto" ${on ? '' : 'disabled'}>
                <option value="">${tr('sliq.dont_send', '– Nicht senden –')}</option>
                ${_addrOptions(addrs, s.sendTo ?? '')}
            </select>
        </div>
        <div class="settings-row sl-dependent" style="border:none; opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.cleanup_cooldown', 'Cleanup-Cooldown')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.cleanup_cooldown', 'Cleanup-Cooldown')}"
                    data-tooltip-content="${tr('sliq.sl_cooldown_tip', 'Nach einer Liquidation durch das Score Limit ist dieser Pool für die eingestellte Zeit für automatisierte Cleanup-Zuweisungen gesperrt.||Manuelle Einzahlungen bleiben jederzeit möglich.||Cooldown-Start: Zeitpunkt der Liquidation.')}">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short" id="${idp}sl-cooldown"
                    type="number" min="1" max="24" step="1" value="${cooldownHours}"
                    ${on ? '' : 'disabled'}>
                <span class="input-unit">h</span>
            </div>
        </div>
        <div style="margin-top:0.9rem;padding:0.6rem 0.75rem;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;font-size:0.78rem;color:var(--text-muted);line-height:1.5;">
            ${minConsecutive <= 1
                ? tr('sliq.liq_immediate', '&#9432;&nbsp; Liquidation erfolgt <strong>sofort</strong> im ersten Zyklus, in dem der Score unter <strong>{score}</strong> liegt <em>und</em> die Position dabei nicht Out-of-Range ist.', { score: minScore })
                : tr('sliq.liq_consecutive', '&#9432;&nbsp; Liquidation erfolgt nur, wenn der Score mindestens <strong>{n} Zyklen&nbsp;in Folge</strong> unter <strong>{score}</strong> liegt <em>und</em> die Position dabei nicht Out-of-Range ist. OOR-Zyklen setzen den Zähler zurück.', { n: minConsecutive, score: minScore })}
        </div>
        ${typeMode ? '' : _buildSlStatusBlock(pool, minScore, minConsecutive)}
        <div class="modal-feedback" id="${idp}sl-feedback"></div>
        </div>`;
}

async function _saveScoreLimitPanel(pool, addrs, card, backdrop) {
    const panel    = backdrop?.querySelector('#sltp-sl');
    const fb       = panel?.querySelector('#sl-feedback');
    const enabled       = panel?.querySelector('#sl-enabled')?.checked ?? false;
    const minScore      = parseFloat(panel?.querySelector('#sl-minscore')?.value ?? '30');
    const cooldownHours = parseInt(panel?.querySelector('#sl-cooldown')?.value ?? '1', 10);
    if (!Number.isFinite(cooldownHours) || cooldownHours < 1 || cooldownHours > 24) {
        if (fb) { fb.textContent = tr('sliq.cooldown_range_err', 'Cleanup-Cooldown muss zwischen 1 und 24 h liegen.'); fb.className = 'modal-feedback error'; }
        return;
    }
    const data = {
        enabled,
        minScore:     Number.isFinite(minScore) ? minScore : 30,
        swapToUsdc:   panel?.querySelector('#sl-swap')?.checked ?? true,
        sendTo:       panel?.querySelector('#sl-sendto')?.value ?? '',
        cooldownHours,
    };

    if (fb) { fb.textContent = tr('sb.saving', 'Speichere…'); fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/pools/liquidity/${pool.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scoreLimit: data }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        _ctx.showToast?.(tr('sliq.score_limit_saved', 'Score Limit gespeichert'), 'success');

        // Tab-Inhalt mit frischen Daten neu rendern
        const freshRes   = await fetch(`/api/pools/liquidity?t=${Date.now()}`);
        const freshPools = freshRes.ok ? await freshRes.json() : null;
        const freshPool  = freshPools?.find(p => p.id === pool.id);
        if (freshPool && panel && backdrop) {
            panel.innerHTML = _buildScoreLimitPanel(freshPool, addrs);
            _wireSlPanelListeners(backdrop);
        }

        await _refreshPoolsCard(card);
    } catch (err) {
        if (fb) { fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb.className = 'modal-feedback error'; }
    }
}

// ── Max Investment – Panel ──────────────────────────────────────────────────

function _buildMaxInvestmentSummary(pool) {
    const s = pool.settings.maxInvestment ?? { enabled: false, amountUsdc: null };
    if (s.enabled !== true || !(Number(s.amountUsdc) > 0)) {
        return tr('sliq.max_investment_unlimited', 'Unbegrenzt.');
    }
    const cap = Number(s.amountUsdc);
    const cur = Number.isFinite(Number(pool.capitalUsdc)) ? Number(pool.capitalUsdc) : 0;
    return tr('sliq.max_investment_summary', '{cur} von {cap} USDC investiert.', {
        cur: cur.toLocaleString(NUM_LOCALE, { maximumFractionDigits: 0 }),
        cap: cap.toLocaleString(NUM_LOCALE, { maximumFractionDigits: 0 }),
    });
}

function _buildMaxInvestmentPanel(pool) {
    const s   = pool.settings.maxInvestment ?? { enabled: false, amountUsdc: null };
    const on  = !!s.enabled;
    const amt = s.amountUsdc ?? '';
    const cur = Number.isFinite(Number(pool.capitalUsdc)) ? Number(pool.capitalUsdc) : 0;
    return `
        <div class="settings-row" style="border:none;">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.3rem;">
                ${tr('sliq.filter_active', 'Aktiv')}
            </span>
            <label class="toggle-switch">
                <input type="checkbox" id="mi-enabled" ${on ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row mi-dependent" style="border:none; opacity:${on ? '1' : '0.4'};">
            <span class="settings-label">${tr('sliq.max_investment_amount', 'Obergrenze')}</span>
            <div class="input-unit-row">
                <input class="modal-input input-short" id="mi-amount"
                    type="number" min="1" step="1" placeholder="${tr('sliq.unlimited', 'unbegrenzt')}"
                    value="${amt}" ${on ? '' : 'disabled'}>
                <span class="input-unit">USDC</span>
            </div>
        </div>
        <div style="margin-top:0.9rem;padding:0.6rem 0.75rem;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;font-size:0.78rem;color:var(--text-muted);line-height:1.5;">
            ${tr('sliq.max_investment_note', '&#9432;&nbsp; Aktuell gebuchtes Kapital in diesem Pool: <strong>{cur} USDC</strong>.||Die Grenze blockiert nur künftige Einzahlungen (Cleanup und manuell) — ein bereits höherer Bestand wird nicht automatisch reduziert. Autocompounding bleibt in jedem Fall unverändert.', { cur: cur.toLocaleString(NUM_LOCALE, { maximumFractionDigits: 2 }) })}
        </div>
        <div class="modal-feedback" id="mi-feedback"></div>`;
}

function _wireMiPanelListeners(backdrop) {
    const enabledCb = backdrop.querySelector('#mi-enabled');
    enabledCb?.addEventListener('change', () => {
        const on = enabledCb.checked;
        backdrop.querySelectorAll('.mi-dependent').forEach(row => {
            row.style.opacity = on ? '1' : '0.4';
            row.querySelectorAll('input').forEach(inp => { inp.disabled = !on; });
        });
    });
}

function _openMaxInvestmentModal(pool, card) {
    const mid = 'liquiditybot-maxinv-modal';
    showModal({
        id:    mid,
        title: `${tr('sliq.max_investment', 'Max Investment')} – ${pool.displayPair ?? pool.pair}`,
        body:  `${_ndModalNotice(pool, ['maxInvestment'])}${_buildMaxInvestmentPanel(pool)}`,
        actions: [
            { label: tr('msg.save', 'Speichern'), primary: true, onClick: () => _saveMaxInvestmentPanel(pool, card, getModal(mid)) },
            { label: tr('common.close', 'Schließen'), onClick: () => closeModal(mid) },
        ],
    });
    const backdrop = getModal(mid);
    if (backdrop) _wireMiPanelListeners(backdrop);
}

async function _saveMaxInvestmentPanel(pool, card, backdrop) {
    const fb        = backdrop?.querySelector('#mi-feedback');
    const enabled   = backdrop?.querySelector('#mi-enabled')?.checked ?? false;
    const rawAmount = backdrop?.querySelector('#mi-amount')?.value ?? '';
    const amountUsdc = rawAmount === '' ? null : parseFloat(rawAmount);
    if (enabled && (amountUsdc === null || !Number.isFinite(amountUsdc) || amountUsdc <= 0)) {
        if (fb) { fb.textContent = tr('sliq.max_investment_range_err', 'Bitte eine positive Obergrenze in USDC angeben.'); fb.className = 'modal-feedback error'; }
        return;
    }

    if (fb) { fb.textContent = tr('sb.saving', 'Speichere…'); fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/pools/liquidity/${pool.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxInvestment: { enabled, amountUsdc } }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        _ctx.showToast?.(tr('sliq.max_investment_saved', 'Max Investment gespeichert'), 'success');
        closeModal('liquiditybot-maxinv-modal');
        await _refreshPoolsCard(card);
    } catch (err) {
        if (fb) { fb.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }); fb.className = 'modal-feedback error'; }
    }
}

// ── TVL-Schutz – Panel ────────────────────────────────────────────────────────

/** Optionen 0,10,…,100 für die Prozent-Selectbox */
function _pctOptions(selected) {
    let html = '';
    for (let v = 0; v <= 100; v += 10) {
        html += `<option value="${v}" ${v === selected ? 'selected' : ''}>${v} %</option>`;
    }
    return html;
}

/** TVL-Schutz-Stufe als Block rendern. Es gibt nur noch eine Stufe (Ticket #0324:
 *  Stufe 2 war nie konfiguriert und wurde aus der Oberfläche entfernt).
 *  Im Typ-Modus (mode==='type') entfällt die TVL-Schwelle — pool-individuell (siehe
 *  DEFAULT_POOL_TYPE_SETTINGS-Kommentar in routes/pools.js). */
function _buildTvlLevel(lvl, defaultThreshold, mode = 'pool') {
    const typeMode  = mode === 'type';
    const idp       = typeMode ? 'pt-' : '';
    const on        = !!lvl.enabled;
    const threshold = lvl.thresholdUsd != null ? lvl.thresholdUsd : (defaultThreshold ?? '');
    const pct       = Number.isFinite(Number(lvl.withdrawPct)) ? Number(lvl.withdrawPct) : 100;
    return `
        <div class="settings-row" style="border:none;">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;font-weight:600;">
                ${tr('sliq.tvl_active', 'TVL-Schutz aktiv')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.tvl_active', 'TVL-Schutz aktiv')}"
                    data-tooltip-content="${tr('sliq.tvl_stage1_tip', 'Fällt der Pool-TVL unter diesen Wert, wird der eingestellte Anteil abgezogen — voreingestellt 100 % und Tausch in USDC.')}">&#9432;</span>
            </span>
            <label class="toggle-switch">
                <input type="checkbox" id="${idp}tvl1-enabled" ${on ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        ${typeMode ? '' : `
        <div class="settings-row tvl1-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.tvl_threshold', 'TVL-Schwelle')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.tvl_threshold', 'TVL-Schwelle')}"
                    data-tooltip-content="${tr('sliq.tvl_threshold_tip', 'Pool-TVL in USDC. Wird dieser Wert unterschritten, tritt die Aktion in Kraft.')}">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input" id="tvl1-threshold" style="width:8rem;"
                    type="number" min="0" step="1000" value="${threshold}" ${on ? '' : 'disabled'}>
                <span class="input-unit" id="tvl1-threshold-fmt" style="min-width:5rem;">${_fmtUsd(Number(threshold))}</span>
            </div>
        </div>`}
        <div class="settings-row tvl1-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.action_col', 'Aktion')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.action_col', 'Aktion')}"
                    data-tooltip-content="${tr('sliq.tvl_action_tip_single', 'Anteil des Kapitals, der bei Unterschreiten aus dem Pool gezogen wird.')}">&#9432;</span>
            </span>
            <select class="modal-select" id="${idp}tvl1-pct" style="width:6rem;" ${on ? '' : 'disabled'}>
                ${_pctOptions(pct)}
            </select>
        </div>`;
}

function _buildTvlPanel(pool, addrs = [], mode = 'pool') {
    const typeMode = mode === 'type';
    const idp      = typeMode ? 'pt-' : '';
    const tp = pool.settings.tvlProtection ?? {};
    const l1 = tp.level1 ?? { enabled: true,  thresholdUsd: null, withdrawPct: 100 };
    const cooldownHours = Number.isFinite(Number(tp.cooldownHours)) ? Number(tp.cooldownHours) : 1;

    const currentTvl = pool.currentTvl != null
        ? `<strong style="color:var(--text);">${_fmtUsd(pool.currentTvl)}</strong>`
        : `<strong style="color:var(--text-muted);">${tr('sliq.no_data_lc', 'keine Daten')}</strong>`;
    // Aktivierungs-TVL als Klammerwert mit eigenem Tooltip (nur wenn vorhanden)
    const activationTvl = tp.tvlAtActivation != null
        ? `<span style="color:var(--text-muted);font-weight:400;">(${_fmtUsd(tp.tvlAtActivation)}
               <span class="info-tip-label"
                   data-tooltip-title="${tr('sliq.tvl_at_activation', 'TVL bei Aktivierung')}"
                   data-tooltip-content="${tr('sliq.tvl_at_activation_tip', 'Pool-TVL zum Zeitpunkt des ersten Deposits in diesen Pool. Dient als Referenz für die Schwellenwerte unten.')}">&#9432;</span>)</span>`
        : '';

    return `
        <div class="sltp-settings">
        ${typeMode ? '' : `
        <div class="settings-row" style="background:var(--bg-soft, rgba(255,255,255,0.03)); border-radius:8px; padding:0.6rem 0.8rem;">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sb.current_tvl', 'Aktueller TVL')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sb.current_tvl', 'Aktueller TVL')}"
                    data-tooltip-content="${tr('sliq.current_tvl_tip', 'Aktueller Total Value Locked des Pools (Dashboard-Wert).')}">&#9432;</span>
            </span>
            <span style="text-align:right;">${currentTvl} ${activationTvl}</span>
        </div>`}
        ${_buildTvlLevel(l1, pool.tvlExitDefault, mode)}
        <div class="settings-row" style="border-top:1px solid var(--border, #2a2a3a);">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.swap_usdc', 'Swap → USDC')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.swap_usdc', 'Swap → USDC')}"
                    data-tooltip-content="${tr('sliq.tvl_swap_tip_single', 'Coins nach der Entnahme automatisch in USDC tauschen.')}">&#9432;</span>
            </span>
            <label class="toggle-switch toggle-sm">
                <input type="checkbox" id="${idp}tvl-swap" ${tp.swapToUsdc !== false ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sb.send_to', 'Senden an')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sb.send_to', 'Senden an')}"
                    data-tooltip-content="${tr('sliq.tvl_sendto_tip_single', 'Empfänger-Adresse für das entnommene Kapital.||Ohne Adresse bleibt das Kapital im Wallet.')}">&#9432;</span>
            </span>
            <select class="modal-select" id="${idp}tvl-sendto">
                <option value="">${tr('sliq.dont_send', '– Nicht senden –')}</option>
                ${_addrOptions(addrs, tp.sendTo ?? '')}
            </select>
        </div>
        <div class="settings-row" style="opacity:1;">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                ${tr('sliq.cleanup_cooldown', 'Cleanup-Cooldown')}
                <span class="info-tip-label"
                    data-tooltip-title="${tr('sliq.cleanup_cooldown', 'Cleanup-Cooldown')}"
                    data-tooltip-content="${tr('sliq.tvl_cooldown_tip', 'Nach einem teilweisen TVL-Schutz-Abzug ist der Pool für die eingestellte Zeit für automatisierte Cleanup-Zuweisungen gesperrt.||Bei 100 %-Abzug ist der Pool ohnehin leer.')}">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short" id="${idp}tvl-cooldown"
                    type="number" min="1" max="24" step="1" value="${cooldownHours}">
                <span class="input-unit">h</span>
            </div>
        </div>
        <div class="modal-feedback" id="${idp}tvl-feedback"></div>
        </div>`;
}

/** Verdrahtet Toggle-Sichtbarkeit, Schwellen-Formatierung und die Summen-Kopplung. */
function _wireTvlPanel(backdrop) {
    const panel = backdrop.querySelector('#sltp-tvl');
    if (!panel) return;

    const getEl = id => panel.querySelector('#' + id);

    // Sichtbarkeit/Disabled der Stufe an ihren Toggle koppeln
    function syncLevelEnabled() {
        const on = getEl('tvl1-enabled')?.checked ?? false;
        panel.querySelectorAll('.tvl1-dependent').forEach(el => { el.style.opacity = on ? '1' : '0.4'; });
        ['threshold', 'pct'].forEach(suf => {
            const el = getEl(`tvl1-${suf}`);
            if (el) el.disabled = !on;
        });
    }

    getEl('tvl1-enabled')?.addEventListener('change', syncLevelEnabled);
    // Schwellen-Formatierung live
    getEl('tvl1-threshold')?.addEventListener('input', e => {
        const fmt = getEl('tvl1-threshold-fmt');
        if (fmt) fmt.textContent = _fmtUsd(Number(e.target.value));
    });
}

async function _saveTvlPanel(pool, card, backdrop) {
    const panel = backdrop?.querySelector('#sltp-tvl');
    const fb    = panel?.querySelector('#tvl-feedback');
    const getEl = id => panel?.querySelector('#' + id);

    const level1 = {
        enabled:      getEl('tvl1-enabled')?.checked ?? false,
        thresholdUsd: parseFloat(getEl('tvl1-threshold')?.value ?? ''),
        withdrawPct:  parseInt(getEl('tvl1-pct')?.value ?? '0', 10),
    };
    const swapToUsdc    = getEl('tvl-swap')?.checked ?? false;
    const sendTo        = getEl('tvl-sendto')?.value ?? '';
    const cooldownHours = parseInt(getEl('tvl-cooldown')?.value ?? '1', 10);

    // ── Client-seitige Validierung (Backend prüft erneut) ──
    // Stufe 2 ist seit Ticket #0324 nicht mehr über die Oberfläche editierbar; das
    // Feld bleibt im PUT-Payload einfach weg, saveSettings() lässt sie dann unangetastet.
    const setErr = msg => { if (fb) { fb.textContent = msg; fb.className = 'modal-feedback error'; } };
    if (!Number.isFinite(cooldownHours) || cooldownHours < 1 || cooldownHours > 24)
        return setErr(tr('sliq.cooldown_range_err', 'Cleanup-Cooldown muss zwischen 1 und 24 h liegen.'));
    if (level1.enabled && !(level1.thresholdUsd > 0))
        return setErr(tr('sliq.tvl1_err', 'TVL-Schwelle muss größer als 0 sein.'));

    if (fb) { fb.textContent = tr('sb.saving', 'Speichere…'); fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/pools/liquidity/${pool.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tvlProtection: { level1, swapToUsdc, sendTo, cooldownHours } }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        if (fb) { fb.textContent = tr('sliq.saved_no_dot', '✓ Gespeichert'); fb.className = 'modal-feedback success'; }
        _ctx.showToast?.(tr('sliq.tvl_guard_saved', 'TVL-Schutz gespeichert'), 'success');
        setTimeout(() => { if (fb) fb.textContent = ''; }, 2000);
        await _refreshPoolsCard(card);
    } catch (err) {
        setErr(tr('sb.error_prefix', 'Fehler: {error}', { error: err.message }));
    }
}

// ── Pools-Karte neu laden (nach Save) ────────────────────────────────────────

async function _refreshPoolsCard(card) {
    const [poolsRes, addrsRes, oppRes, hintsRes] = await Promise.all([
        fetch(`/api/pools/liquidity?t=${Date.now()}`),
        fetch('/api/addresses'),
        fetch(`/api/pools/liquidity/opportunity?t=${Date.now()}`),
        fetch(`/api/pools/liquidity/advisor-hints?t=${Date.now()}`),
    ]);
    const pools = await poolsRes.json();
    const addrs = await addrsRes.json();
    const opp   = oppRes.ok ? await oppRes.json() : { available: false };
    const hints = hintsRes.ok ? await hintsRes.json() : [];
    _advisorHints = hints;
    _renderPoolsTable(card, pools, addrs, opp, hints);
}

// ── Adress-Optionen für Dropdowns ─────────────────────────────────────────────

function _addrOptions(addrs, selectedAddr) {
    return addrs.map(a =>
        `<option value="${_esc(a.address)}" ${a.address === selectedAddr ? 'selected' : ''}>
            ${_esc(a.name)}
         </option>`
    ).join('');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _statusLabel(s) {
    if (s === 'active')   return tr('sb.status_active', 'Aktiv');
    if (s === 'inactive') return tr('sb.status_stopped', 'Gestoppt');
    if (s === 'failed')   return tr('sb.status_failed', 'Fehler');
    return s ?? tr('sb.status_unknown', 'Unbekannt');
}

function _statusClass(s) {
    if (s === 'active')   return 'active';
    if (s === 'inactive') return 'inactive';
    if (s === 'failed')   return 'failed';
    return 'unknown';
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _esc(s)   { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _fmt(n) {
    const v = parseFloat(n);
    if (isNaN(v) || v === 0) return '0';
    const mag      = Math.floor(Math.log10(Math.abs(v)));
    const decimals = mag >= 0 ? 4 : Math.min(10, -mag + 4);
    return v.toLocaleString(NUM_LOCALE, { maximumFractionDigits: decimals });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pool-Deposit / Pool-Withdraw Modals
// ═══════════════════════════════════════════════════════════════════════════════

async function _fetchPoolState(poolId) {
    try {
        const r = await fetch(`/api/pools/liquidity/${encodeURIComponent(poolId)}/position-state`);
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

// Live On-Chain-Preis/Range-Status (dauert wegen RPC+Rate-Limiter spürbar länger als
// _fetchPoolState) — bewusst separat, damit das Deposit-Modal nicht auf diesen Call
// warten muss. Siehe pools-actions.js:/position-state/live.
async function _fetchPoolStateLive(poolId) {
    try {
        const r = await fetch(`/api/pools/liquidity/${encodeURIComponent(poolId)}/position-state/live`);
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

async function _fetchWalletBalanceFresh() {
    try {
        const r = await fetch(`/api/wallet/liquidity/balance?fresh=1&t=${Date.now()}`);
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

async function _fetchDepositGasEstimate(poolId, isNew) {
    try {
        const r = await fetch(`/api/pools/liquidity/${encodeURIComponent(poolId)}/deposit-gas-estimate?isNew=${isNew ? '1' : '0'}&t=${Date.now()}`);
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

/**
 * Aktualisiert ein offenes Modal periodisch (Standard: alle 60s), solange es offen ist.
 * `fn` läuft asynchron und wird nie überlappend erneut gestartet (kein Re-Entry bei
 * langsamer Antwort). Timer wird automatisch gestoppt, wenn das Modal geschlossen wird
 * (via showModal-Option `onClose`) — daher `onClose` in showModal IMMER mit übergeben,
 * wenn dieser Helper genutzt wird.
 */
function _attachModalAutoRefresh(mid, fn, intervalMs = 60_000) {
    let running = false;
    const timer = setInterval(async () => {
        if (running || !getModal(mid)) return;
        running = true;
        try { await fn(); } finally { running = false; }
    }, intervalMs);
    return () => clearInterval(timer);
}

function _walletAmount(balance, symbol) {
    if (!balance) return 0;
    if (symbol === 'SOL')  return balance.sol  ?? 0;
    if (symbol === 'USDC') return balance.usdc ?? 0;
    const t = (balance.tokens ?? []).find(x => x.symbol === symbol);
    return t?.balance ?? 0;
}

function _renderPreviewResult(payload) {
    if (!payload) return '';
    const { dryRun, costs } = payload;
    if (!dryRun?.ok) {
        return `<div class="modal-feedback error" style="display:block;">${_esc(dryRun?.error ?? tr('sliq.preview_failed', 'Vorschau fehlgeschlagen'))}</div>`;
    }
    const r = dryRun.result ?? {};
    const rowsLines = [];
    if (r.estimatedTokenA != null) rowsLines.push(`${_fmt(r.estimatedTokenA)} ${_esc(r.tokenALabel)} + ${_fmt(r.estimatedTokenB)} ${_esc(r.tokenBLabel)}`);
    if (r.estimatedUsdc != null)   rowsLines.push(`≈ ${_fmt(r.estimatedUsdc)} USDC`);
    if (r.priceLower != null)      rowsLines.push(`Range: ${_fmt(r.priceLower)} – ${_fmt(r.priceUpper)}`);
    if (r.fraction != null && r.mode === 'decreaseLiquidity') rowsLines.push(`Anteil: ${(r.fraction * 100).toFixed(2)}%`);
    let costLine = '';
    if (costs?.costs?.total != null) {
        costLine = `<div style="margin-top:0.35rem;">Kosten: ~${_fmt(costs.costs.total)} USD (TX-Fees + Slippage)</div>`;
    }
    return `<div class="modal-feedback ok" style="display:block;">
        <div><strong>${tr('sliq.preview_label', 'Vorschau:')}</strong></div>
        ${rowsLines.map(l => `<div>${_esc(l)}</div>`).join('')}
        ${costLine}
    </div>`;
}

// ── Einzahlen-Modal ──────────────────────────────────────────────────────────

// ── Range-Chart-Renderer (für Pool-Verwalten-Modal) ───────────────────────────
function _renderRebalanceChart(svgEl, state) {
    const pos        = state?.position;
    const priceLower = pos?.priceLower ?? null;
    const priceUpper = pos?.priceUpper ?? null;
    const priceNow   = pos?.priceNow   ?? state?.poolStats?.price ?? null;
    const history    = state?.priceHistory ?? [];

    let filtered = history.slice(); // already filtered to 24h by server
    if (filtered.length === 0 && priceNow != null) {
        filtered = [{ t: Date.now() - 60_000, price: priceNow }, { t: Date.now(), price: priceNow }];
    } else if (filtered.length === 1 && priceNow != null) {
        filtered = [...filtered, { t: Date.now(), price: priceNow }];
    }
    if (filtered.length < 2) return false;

    const W   = svgEl.getBoundingClientRect().width || svgEl.parentElement?.clientWidth || 440;
    const H   = 200;
    const pad = { top: 24, right: 96, bottom: 30, left: 68 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    const ts   = filtered.map(r => r.t);
    const vals = filtered.map(r => r.price);
    const minT = Math.min(...ts), maxT = Math.max(...ts);

    const allV = [...vals, priceLower ?? Infinity, priceUpper ?? -Infinity].filter(isFinite);
    const span = (Math.max(...allV) - Math.min(...allV)) || Math.max(...allV) * 0.1 || 1;
    const minV = Math.min(...allV) - span * 0.08;
    const maxV = Math.max(...allV) + span * 0.08;

    const xOf  = t => pad.left + ((t - minT) / ((maxT - minT) || 1)) * iW;
    const yOf  = v => pad.top  + (1 - (v - minV) / ((maxV - minV) || 1)) * iH;
    const fmtP = (v, d = 2) => Number(v).toLocaleString(NUM_LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
    const xLbl = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };

    const tokenALbl = state?.tokenALabel ?? '';
    const tokenBLbl = state?.tokenBLabel ?? '';

    let html = `<defs>
        <linearGradient id="rebGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%"   stop-color="#00d4ff" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/>
        </linearGradient></defs>`;

    // Chart-Titel: welcher Preis wird gezeigt
    if (tokenALbl && tokenBLbl) {
        const cx = ((pad.left + W - pad.right) / 2).toFixed(1);
        html += `<text x="${cx}" y="13" text-anchor="middle" font-size="9.5" fill="#64748b">${tokenALbl}-Preis in ${tokenBLbl}</text>`;
    }

    // Gitter + Y-Achse
    for (let i = 0; i <= 4; i++) {
        const v = minV + (maxV - minV) * i / 4;
        const y = yOf(v).toFixed(1);
        html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
        html += `<text x="${pad.left - 5}" y="${(+y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#94a3b8">${fmtP(v, 2)}</text>`;
    }
    // X-Achse
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        html += `<text x="${xOf(t).toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="10" fill="#94a3b8">${xLbl(t)}</text>`;
    }

    // Preislinie + Fläche
    let path = `M ${xOf(ts[0]).toFixed(1)} ${yOf(vals[0]).toFixed(1)}`;
    for (let i = 1; i < filtered.length; i++) path += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
    const area = path + ` L ${xOf(ts[ts.length-1]).toFixed(1)} ${H - pad.bottom} L ${xOf(ts[0]).toFixed(1)} ${H - pad.bottom} Z`;
    html += `<path d="${area}" fill="url(#rebGrad)"/>`;
    html += `<path d="${path}" stroke="#00d4ff" stroke-width="1.5" fill="none"/>`;

    // Obere Range-Grenze
    if (priceUpper != null) {
        const yU = yOf(priceUpper).toFixed(1);
        const toU = priceUpper - (priceNow ?? 0);
        const pU  = priceNow ? (toU / priceNow * 100) : 0;
        html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${yU}" y2="${yU}" stroke="#10b981" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.85"/>`;
        html += `<text x="${W - pad.right + 5}" y="${(+yU + 4).toFixed(1)}" font-size="9.5" font-weight="600" fill="#10b981">${fmtP(priceUpper, 2)}</text>`;
        html += `<text x="${W - pad.right + 5}" y="${(+yU + 14).toFixed(1)}" font-size="9" fill="#10b981">+${fmtP(toU, 2)} (+${pU.toFixed(1)}%)</text>`;
    }
    // Untere Range-Grenze
    if (priceLower != null) {
        const yL = yOf(priceLower).toFixed(1);
        const toL = (priceNow ?? 0) - priceLower;
        const pL  = priceNow ? (toL / priceNow * 100) : 0;
        html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${yL}" y2="${yL}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.85"/>`;
        html += `<text x="${W - pad.right + 5}" y="${(+yL + 4).toFixed(1)}" font-size="9.5" font-weight="600" fill="#f59e0b">${fmtP(priceLower, 2)}</text>`;
        html += `<text x="${W - pad.right + 5}" y="${(+yL + 14).toFixed(1)}" font-size="9" fill="#f59e0b">−${fmtP(toL, 2)} (−${pL.toFixed(1)}%)</text>`;
    }

    // Aktueller Preis-Marker
    const lx = xOf(ts[ts.length-1]).toFixed(1);
    const ly = yOf(vals[vals.length-1]).toFixed(1);
    html += `<circle cx="${lx}" cy="${ly}" r="5" fill="#00d4ff"/>`;
    html += `<circle cx="${lx}" cy="${ly}" r="8" fill="none" stroke="#00d4ff" stroke-width="1.5" opacity="0.4"/>`;

    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.setAttribute('height', H);
    svgEl.innerHTML = html;
    return true;
}

function _renderCompositionBar(el, state) {
    const pos = state?.position;
    if (!pos || !el) return;

    const amountA   = pos.amountA ?? 0;
    const amountB   = pos.amountB ?? 0;
    const priceNow  = pos.priceNow ?? state?.poolStats?.price ?? 0;
    const tokenALbl = state.tokenALabel ?? 'A';
    const tokenBLbl = state.tokenBLabel ?? 'B';

    // USDC-Wert beider Seiten ermitteln
    let valueA, valueB;
    if (state.usdcIsTokenA) {
        valueA = amountA;                    // tokenA = USDC
        valueB = amountB * priceNow;         // tokenB * Preis in USDC
    } else if (state.btcPrice && tokenBLbl !== 'USDC') {
        valueA = amountA * state.btcPrice;   // beide non-USDC (z.B. cbBTC/WBTC)
        valueB = amountB * state.btcPrice;
    } else {
        valueA = amountA * priceNow;         // tokenA * Preis, tokenB = USDC
        valueB = amountB;
    }

    const total = valueA + valueB || 1;
    const pctA  = Math.round(valueA / total * 100);
    const pctB  = 100 - pctA;

    const fmtAmt = (v, lbl) => {
        const stable = lbl === 'USDC' || lbl === 'EURC';
        const d = stable ? 2 : (v < 0.01 ? 6 : v < 1 ? 4 : 2);
        return Number(v).toLocaleString(NUM_LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
    };

    el.innerHTML = `
        <div style="font-size:0.73rem; color:#64748b; margin-bottom:0.3rem;">${tr('sliq.current_composition', 'Aktuelle Zusammensetzung')}</div>
        <div style="height:7px; border-radius:4px; overflow:hidden; background:#1e293b; display:flex;">
            <div style="width:${pctA}%; background:#00d4ff; min-width:${pctA > 0 ? 2 : 0}px;"></div>
            <div style="flex:1; background:#475569;"></div>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:0.73rem; margin-top:0.3rem; color:var(--text-muted);">
            <span><span style="color:#00d4ff;">▪</span> ${tokenALbl}: ${fmtAmt(amountA, tokenALbl)} <span style="color:#64748b;">(${pctA}%)</span></span>
            <span><span style="color:#475569;">▪</span> ${tokenBLbl}: ${fmtAmt(amountB, tokenBLbl)} <span style="color:#64748b;">(${pctB}%)</span></span>
        </div>`;
}

async function _openAdvisorRebalanceModal(pool, hint) {
    const mid  = 'liquiditybot-advisor-rebalance-modal';
    const pair = pool.displayPair ?? pool.pair;
    showModal({
        id:    mid,
        title: `${_esc(pair)} – Range-Empfehlung umsetzen`,
        body:  `
            <p style="margin:0 0 0.75rem; font-size:0.9rem; color:var(--text-secondary);">
                ${tr('sliq.advisor_intro', 'Der Range Advisor empfiehlt eine engere Range für diesen Pool. Die aktuelle Position wird')} <strong>${tr('sliq.advisor_closed_reopened', 'geschlossen und neu eröffnet')}</strong>.
            </p>
            <table style="width:100%; font-size:0.85rem; border-collapse:collapse; margin-bottom:0.9rem;">
                <tr>
                    <td style="padding:0.25rem 0; color:var(--text-muted); width:50%;">${tr('sliq.current_range', 'Aktuelle Range')}</td>
                    <td style="padding:0.25rem 0; font-weight:600;">±${hint.currentPct}%</td>
                </tr>
                <tr>
                    <td style="padding:0.25rem 0; color:var(--text-muted);">${tr('sliq.recommended_range', 'Empfohlene Range')}</td>
                    <td style="padding:0.25rem 0; font-weight:600;">±${hint.recommendedPct}%</td>
                </tr>
                ${hint.paybackHours != null ? `
                <tr>
                    <td style="padding:0.25rem 0; color:var(--text-muted);">${tr('sliq.amortisation', 'Amortisation')}</td>
                    <td style="padding:0.25rem 0; font-weight:600;">~${Math.round(hint.paybackHours)} Stunden</td>
                </tr>` : ''}
            </table>
            <p style="margin:0 0 0.85rem; font-size:0.82rem; color:var(--text-muted);">
                ${tr('sliq.rebalance_duration_hint', 'Das dauert ca. 1–2 Minuten und kann nicht abgebrochen werden. Ein- und Auszahlungen sind währenddessen gesperrt.')}
            </p>
            <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
                <button class="btn btn-secondary" id="arb-cancel-btn">${tr('sliq.cancel', 'Abbrechen')}</button>
                <button class="btn btn-secondary" id="arb-confirm-btn">${tr('sliq.switch_now', 'Jetzt umstellen')}</button>
            </div>
            <div id="arb-feedback" class="modal-feedback" style="display:none; margin-top:0.6rem;"></div>`,
    });

    const bd = getModal(mid);
    bd.querySelector('#arb-cancel-btn').addEventListener('click', () => closeModal(mid));
    bd.querySelector('#arb-confirm-btn').addEventListener('click', async () => {
        const confirmBtn = bd.querySelector('#arb-confirm-btn');
        const cancelBtn  = bd.querySelector('#arb-cancel-btn');
        const fb         = bd.querySelector('#arb-feedback');
        confirmBtn.disabled    = true;
        cancelBtn.disabled     = true;
        confirmBtn.textContent = tr('sliq.starting', 'Wird gestartet…');
        try {
            const r    = await fetch(`/api/pools/liquidity/${encodeURIComponent(pool.id)}/advisor-rebalance`, { method: 'POST' });
            const data = await r.json();
            if (r.ok) {
                fb.className     = 'modal-feedback ok';
                fb.innerHTML     = `&#10003; ${_esc(data.message ?? tr('sliq.rebalancing_started', 'Rebalancing gestartet.'))}`;
                fb.style.display = 'block';
                confirmBtn.style.display = 'none';
                cancelBtn.textContent = tr('common.close', 'Schließen');
                cancelBtn.disabled    = false;
                cancelBtn.onclick     = () => closeModal(mid);
            } else {
                fb.className     = 'modal-feedback error';
                fb.textContent   = data.error ?? tr('set.unknown_error', 'Unbekannter Fehler');
                fb.style.display = 'block';
                confirmBtn.disabled    = false;
                cancelBtn.disabled     = false;
                confirmBtn.textContent = tr('sliq.switch_now', 'Jetzt umstellen');
            }
        } catch (e) {
            fb.className     = 'modal-feedback error';
            fb.textContent   = `Netzwerkfehler: ${e.message}`;
            fb.style.display = 'block';
            confirmBtn.disabled    = false;
            cancelBtn.disabled     = false;
            confirmBtn.textContent = tr('sliq.switch_now', 'Jetzt umstellen');
        }
    });
}

async function _openPoolRebalanceModal(pool, activeHint = null) {
    const mid   = 'liquiditybot-rebalance-modal';
    const state = await _fetchPoolState(pool.id);

    showModal({
        id:    mid,
        title: `${_esc(pool.displayPair ?? pool.pair)} – ${tr('sb.manage', 'Verwalten')}`,
        body:  `
            <svg id="reb-chart-svg" width="100%" style="display:block; overflow:visible;"></svg>
            <p id="reb-chart-empty" style="display:none; text-align:center; color:var(--text-muted); padding:1.5rem 0; font-size:0.85rem;">
                ${tr('sliq.no_price_history', 'Keine Preishistorie verfügbar')}
            </p>
            <div id="reb-comp" style="margin-top:0.6rem; margin-bottom:0.25rem;"></div>
            <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:0.75rem;">
                <button class="btn btn-secondary" id="reb-start-btn"
                    ${activeHint ? 'style="background:var(--accent);color:#000;border-color:var(--accent);"' : ''}>Rebalance</button>
                <button class="btn btn-secondary" id="reb-close-btn">${tr('common.close', 'Schließen')}</button>
            </div>
            <div id="reb-confirm" style="display:none; margin-top:0.8rem; padding:0.75rem; border:1px solid rgba(220,80,80,0.4); border-radius:6px; background:rgba(220,80,80,0.06); font-size:0.85rem;">
                <p style="margin:0 0 0.5rem; font-weight:600;">${tr('sliq.are_you_sure', 'Bist du sicher?')}</p>
                <p style="margin:0 0 0.75rem; color:var(--text-muted);">
                    ${tr('sliq.confirm_reopen_1', 'Die Position wird geschlossen und neu eröffnet. Das dauert')} <strong>${tr('sliq.confirm_reopen_2', 'ca. 1–2 Minuten')}</strong> ${tr('sliq.confirm_reopen_3', 'und kann')}
                    <strong>${tr('sliq.confirm_reopen_4', 'nicht abgebrochen')}</strong> ${tr('sliq.confirm_reopen_5', 'werden. Ein- und Auszahlungen sind währenddessen gesperrt.')}
                </p>
                <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
                    <button class="btn btn-secondary" id="reb-cancel-btn">${tr('sliq.cancel', 'Abbrechen')}</button>
                    <button class="btn btn-secondary" id="reb-confirm-btn">${tr('sliq.yes_rebalance', 'Ja, jetzt rebalancen')}</button>
                </div>
                <div id="reb-feedback" class="modal-feedback" style="display:none; margin-top:0.6rem;"></div>
            </div>`,
    });

    const bd = getModal(mid);

    // Modal breiter als Standard (480px) – Grafik + Labels brauchen mehr Platz
    const modalEl = bd.querySelector('.forge-modal');
    if (modalEl) modalEl.style.maxWidth = '620px';

    // Chart + Kompositions-Balken nach DOM-Attach rendern
    requestAnimationFrame(() => {
        const svgEl   = bd.querySelector('#reb-chart-svg');
        const emptyEl = bd.querySelector('#reb-chart-empty');
        const compEl  = bd.querySelector('#reb-comp');
        if (svgEl) {
            const ok = _renderRebalanceChart(svgEl, state);
            if (!ok) {
                svgEl.style.display   = 'none';
                emptyEl.style.display = 'block';
            }
            // Kompositions-Balken bündig mit den Chart-Linien ausrichten
            if (compEl) {
                compEl.style.paddingLeft  = '68px';
                compEl.style.paddingRight = '96px';
            }
        }
        _renderCompositionBar(compEl, state);
    });

    bd.querySelector('#reb-close-btn').addEventListener('click', () => closeModal(mid));
    bd.querySelector('#reb-start-btn').addEventListener('click', () => {
        if (activeHint) {
            closeModal(mid);
            _openAdvisorRebalanceModal(pool, activeHint);
            return;
        }
        bd.querySelector('#reb-confirm').style.display   = 'block';
        bd.querySelector('#reb-start-btn').style.display = 'none';
    });
    bd.querySelector('#reb-cancel-btn').addEventListener('click', () => {
        bd.querySelector('#reb-confirm').style.display   = 'none';
        bd.querySelector('#reb-start-btn').style.display = '';
    });
    bd.querySelector('#reb-confirm-btn').addEventListener('click', async () => {
        const confirmBtn = bd.querySelector('#reb-confirm-btn');
        const cancelBtn  = bd.querySelector('#reb-cancel-btn');
        const fb         = bd.querySelector('#reb-feedback');
        confirmBtn.disabled    = true;
        cancelBtn.disabled     = true;
        confirmBtn.textContent = tr('sliq.starting', 'Wird gestartet…');
        try {
            const r    = await fetch(`/api/pools/liquidity/${encodeURIComponent(pool.id)}/rebalance`, { method: 'POST' });
            const data = await r.json();
            if (r.ok) {
                fb.className         = 'modal-feedback ok';
                fb.innerHTML         = tr('sliq.rebalance_queued', '&#10003; Rebalancing gestartet. Der Bot führt es beim nächsten Tick aus.');
                fb.style.display     = 'block';
                confirmBtn.style.display = 'none';
                bd.querySelector('#reb-close-btn').style.display = 'none';
                cancelBtn.textContent = tr('common.close', 'Schließen');
                cancelBtn.disabled    = false;
                cancelBtn.onclick     = () => closeModal(mid);
            } else {
                fb.className         = 'modal-feedback error';
                fb.textContent       = data.error ?? tr('set.unknown_error', 'Unbekannter Fehler');
                fb.style.display     = 'block';
                confirmBtn.disabled  = false;
                cancelBtn.disabled   = false;
                confirmBtn.textContent = tr('sliq.yes_rebalance', 'Ja, jetzt rebalancen');
            }
        } catch (e) {
            fb.className         = 'modal-feedback error';
            fb.textContent       = `Netzwerkfehler: ${e.message}`;
            fb.style.display     = 'block';
            confirmBtn.disabled  = false;
            cancelBtn.disabled   = false;
            confirmBtn.textContent = tr('sliq.yes_rebalance', 'Ja, jetzt rebalancen');
        }
    });
}

// Baut den USDC-Tab-Hinweistext (initial + bei Auto-Refresh identisch genutzt).
// Mindestbetrag ist der effektive Wert: normalerweise minUsdc, bei knapper SOL-Reserve
// aber der höhere gasEstimate.minUsdcTotal (deckt den nötigen SOL-Nachkauf mit ab) —
// ein einzelner Betrag statt einer separaten Gas-Aufschlüsselung.
function _buildDepositUsdcHint({ walletUsdc, minUsdc, isNew, isBtcPair, tokenALabel, tokenBLabel, gasEstimate }) {
    const effectiveMin = gasEstimate?.minUsdcTotal > minUsdc ? gasEstimate.minUsdcTotal : minUsdc;
    return `
        ${tr('sliq.deposit_usdc_hint', 'Wallet-USDC wird in beide Pool-Tokens geswappt und dann eingezahlt.')}<br>
        ${tr('sliq.wallet_min_line', 'Wallet: {wallet} USDC · Mindestbetrag: {min} USDC', { wallet: _fmt(walletUsdc), min: _fmt(effectiveMin) })}
        ${isNew ? '<br>' + tr('slen.pool_inactive_new_position', '&#9888; Pool aktuell inaktiv – es wird eine neue Position eröffnet.') : ''}
        ${isBtcPair ? '<br>' + tr('sliq.btc_pair_hint', '&#9432; btcPair: 2 Swaps nötig (USDC → {a} + USDC → {b})', { a: tokenALabel, b: tokenBLabel }) : ''}`;
}

async function _openPoolDepositModal(pool) {
    const mid = 'liquiditybot-deposit-modal';
    const [state, balance, cfgRes] = await Promise.all([
        _fetchPoolState(pool.id),
        _fetchWalletBalanceFresh(),
        fetch('/api/config/liquiditybot').catch(() => null),
    ]);
    if (!state) { infoModal(tr('sliq.pool_state_failed', 'Pool-State konnte nicht geladen werden.')); return; }
    const cleanupMode = cfgRes?.ok ? _parseCleanupMode(await cfgRes.json()) : 'ranking';

    const tokenALabel = state.tokenALabel;
    const tokenBLabel = state.tokenBLabel;
    const isNew       = !state.position;
    // LIQ#0362: Ohne offene Position ist das die Erst-Einzahlung in diesen Pool (oder eine
    // Neueröffnung nach vollständigem Exit) — der Fall, in dem bin/deposit.js Trailing Stop
    // + TVL-Schutz mit den Pool-Typ-/Standardwerten scharf schaltet. Kein eigenes
    // Bedienelement dafür (Rückbau, Festlegung 03.09.2026: dieselben Werte inkl. An/Aus
    // stehen bereits unter Risk-Management → Trailing Stop; ein zweiter Bedienort ohne die
    // Werte war schlechter als keiner) — nur ein Hinweis, wo man es ändert.
    const showArmHint = isNew;
    // Müssen mit Backend (bin/deposit.js) synchron sein: 1 / 2 / 5 USDC
    const minUsdc     = isNew ? 5 : (state.btcPricePoolId ? 2 : 1);
    const isBtcPair   = !!state.btcPricePoolId;

    // Decimals für Rundung (Floor, damit nie über Wallet hinaus)
    const decA = state.decimalsA ?? 6;
    const decB = state.decimalsB ?? 6;
    const econDecA = Math.min(decA, 8);
    const econDecB = Math.min(decB, 8);

    // Alle folgenden Werte ändern sich bei jedem Auto-Refresh (Wallet-Guthaben, Pool-Preis,
    // In-Range-Status) — daher `let` statt `const`, damit die Closures unten (_onSliderChange,
    // _checkUsdcMin, …) bei jedem Aufruf die jeweils aktuellen Werte sehen.
    let walletA     = _walletAmount(balance, tokenALabel);
    let walletB     = _walletAmount(balance, tokenBLabel);
    let walletUsdc  = balance?.usdc ?? 0;
    // volatilePair braucht 2 Swaps (USDC→tokenA + USDC→tokenB), je mit 1,5% Slippage-Buffer.
    // Sicherheitsabzug 3% damit der Backend-Abort "nicht genug USDC für 2 Swaps" nicht auftritt.
    let walletUsdcSafe = state.volatilePair ? _floorDec(walletUsdc * 0.97, 2) : walletUsdc;
    // Pool-Preis + In-Range Status für Live-Ratio-Hinweis
    let price   = state.poolStats?.price ?? state.position?.priceNow ?? null;
    let inRange = state.position?.inRange ?? null;
    let prLower = state.position?.priceLower ?? null;
    let prUpper = state.position?.priceUpper ?? null;
    // SOL-Reserve ist bereits im Fresh-Balance-Endpoint abgezogen (fetchLiquidityBalanceFresh: -0.1 SOL).
    let walletASafe = walletA;
    let walletBSafe = walletB;
    // Pool muss in-Range sein (oder neu) damit Einzahlen erlaubt ist.
    // Out-of-Range Position: Backend würde sowieso ablehnen, UI sperrt vorher.
    let blockedOutOfRange = !isNew && inRange === false;
    // Schätzung "wie viel USDC mind. nötig, damit der Deposit trotz knapper SOL-Reserve
    // funktioniert" — separater Endpoint, siehe bots/settings/routes/pools-actions.js.
    let gasEstimate = await _fetchDepositGasEstimate(pool.id, isNew);
    // Wirtschaftliches Maximum-Paar (Engpass) — Slider skaliert davon.
    // Für CLMM-Pools: CLMM-Deposit-Ratio statt Spot-Preis, damit Engpass korrekt erkannt wird
    // (Spot-Preis stimmt nur im geometrischen Zentrum der Range; nahe am Tick-Rand stark abweichend).
    let clmmRatio = isBtcPair ? null : _clmmDepositRatio(price, prLower, prUpper);
    let econMax   = _computeEconomicMax(walletASafe, walletBSafe, clmmRatio ?? price, isBtcPair);

    const oorBannerHtml = () => blockedOutOfRange
        ? `<div class="modal-feedback error" style="display:block; margin-bottom:0.5rem;">
             ${tr('sliq.position_is', '⚠ Position ist')} <strong>${tr('sliq.out_of_range_lc', 'out of Range')}</strong> ${tr('sliq.deposit_not_possible', '– Einzahlen aktuell nicht möglich.')}
           </div>`
        : '';

    // LIQ#0362: reiner Hinweis, kein Bedienelement — die Werte (inkl. An/Aus) stehen bereits
    // unter Risk-Management → Trailing Stop / TVL-Schutz.
    const armSectionHtml = showArmHint
        ? `<div class="wallet-hint" style="font-size:0.78rem; margin-bottom:0.6rem;">${tr('sliq.arm_intro', 'Erst-Einzahlung in diesen Pool: Trailing Stop und TVL-Schutz Stufe 1 werden mit den Pool-Typ-/Standardwerten aktiviert – änderbar unter Risk-Management.')}</div>`
        : '';

    showModal({
        id: mid,
        title: `Einzahlen – ${state.displayPair ?? state.pair}`,
        body: `
            <div id="pd-oor-banner">${oorBannerHtml()}</div>
            ${_cleanupHint(cleanupMode)}
            ${armSectionHtml}
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-pdtab="usdc">${tr('sliq.by_usdc_amount', 'Per USDC-Betrag')}</button>
                <button class="wm-tab" data-pdtab="pair">${tr('sliq.by_token_amounts', 'Per Token-Mengen')}</button>
            </div>
            <div id="pd-tab-usdc">
                <div class="settings-row">
                    <span class="settings-label">${tr('sliq.usdc_amount', 'USDC-Betrag')}</span>
                    <div class="send-amount-row">
                        <input class="modal-input" id="pd-usdc" type="number" min="0" step="any" placeholder="${minUsdc}.00">
                        <button class="btn btn-secondary btn-sm" id="pd-usdc-max">Max</button>
                    </div>
                </div>
                <div class="wallet-hint" id="pd-usdc-hint" style="font-size:0.78rem;">
                    ${_buildDepositUsdcHint({ walletUsdc, minUsdc, isNew, isBtcPair, tokenALabel, tokenBLabel, gasEstimate })}
                </div>
            </div>
            <div id="pd-tab-pair" hidden>
                <div class="settings-row">
                    <span class="settings-label">${_esc(tokenALabel)}</span>
                    <div class="send-amount-row">
                        <input class="modal-input" id="pd-max-a" type="text" readonly value="0" style="opacity:0.85;">
                        <span class="wallet-hint" id="pd-wallet-a" style="font-size:0.72rem; min-width:7rem;">Wallet: ${_fmt(walletA)}</span>
                    </div>
                </div>
                <div class="settings-row">
                    <span class="settings-label">${_esc(tokenBLabel)}</span>
                    <div class="send-amount-row">
                        <input class="modal-input" id="pd-max-b" type="text" readonly value="0" style="opacity:0.85;">
                        <span class="wallet-hint" id="pd-wallet-b" style="font-size:0.72rem; min-width:7rem;">Wallet: ${_fmt(walletB)}</span>
                    </div>
                </div>
                <div style="margin-top:1rem; padding:0 0.25rem;">
                    <input type="range" id="pd-slider" min="0" max="100" step="1" value="100"
                           style="width:100%; cursor:pointer;">
                    <div id="pd-slider-readout" style="text-align:center; font-size:0.85rem; margin-top:0.35rem; display:flex; align-items:center; justify-content:center; gap:0.4rem;">
                        <span><strong>100%</strong> ${tr('sliq.of_maximum', 'des Maximums')}</span>
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.slider', 'Schieberegler')}"
                            data-tooltip-content="${tr('sliq.slider_deposit_tip', 'Schieberegler wählt den Anteil des wirtschaftlichen Maximums. Beim Einzahlen wird das limitierende Paar nach aktuellem Pool-Ratio verwendet (Toleranz für Preisbewegung ist eingebaut). Kein Swap.')}">&#9432;</span>
                    </div>
                </div>
                <div class="wallet-hint" id="pd-ratio-hint" style="font-size:0.75rem; margin-top:0.6rem;"></div>
                <div class="wallet-hint" style="font-size:0.78rem;">
                    Mindesteinzahlung: ca. ${_fmt(minUsdc)} USDC.
                </div>
            </div>
            <div id="pd-preview" style="margin-top:0.6rem;"></div>
            <div class="modal-feedback" id="pd-feedback" style="margin-top:0.5rem;"></div>
            <div class="wallet-hint" style="font-size:0.7rem; margin-top:0.5rem;">${tr('sliq.auto_refresh_hint', 'Aktualisiert sich automatisch jede Minute.')}</div>`,
        actions: [
            { label: 'Vorschau',   onClick: () => _runPoolPreview(mid, 'deposit', pool.id, isNew) },
            { label: tr('sb.deposit_btn', '&#10004; Einzahlen'), onClick: () => _runPoolAction(mid, 'deposit', pool.id, isNew) },
            { label: tr('common.close', 'Schließen'),  onClick: () => closeModal(mid) },
        ],
        onClose: () => stopRefresh(),
    });

    const backdrop = getModal(mid);
    if (!backdrop) return;

    // Tab-Switching (Submit-Status pro Tab neu setzen, damit Out-of-Range konsistent bleibt)
    backdrop.querySelectorAll('[data-pdtab]').forEach(b => {
        b.addEventListener('click', () => {
            backdrop.querySelectorAll('[data-pdtab]').forEach(x => x.classList.toggle('active', x === b));
            backdrop.querySelector('#pd-tab-usdc').hidden = b.dataset.pdtab !== 'usdc';
            backdrop.querySelector('#pd-tab-pair').hidden = b.dataset.pdtab !== 'pair';
            if (b.dataset.pdtab === 'pair') {
                _onSliderChange();
            } else {
                _checkUsdcMin();
            }
        });
    });
    backdrop.querySelector('#pd-usdc-max')?.addEventListener('click', () => {
        // Abrunden statt toFixed(2) (das rundet kaufmännisch → kann Wallet-Bestand überschreiten).
        // volatilePair: walletUsdcSafe (3% Puffer abgezogen) damit Backend-Swap-Abort nicht auftritt.
        backdrop.querySelector('#pd-usdc').value = _floorDec(Math.max(0, walletUsdcSafe), 2).toFixed(2);
        _checkUsdcMin();
    });

    function _checkUsdcMin() {
        const v = parseFloat(backdrop.querySelector('#pd-usdc')?.value) || 0;
        if (blockedOutOfRange) {
            _setSubmitDisabled(backdrop, true, tr('sliq.oor_deposit_blocked', 'Position ist out of Range – Einzahlen nicht möglich'));
        } else if (v < minUsdc) {
            _setSubmitDisabled(backdrop, true, `Mindesteinzahlung: ${minUsdc} USDC`);
        } else {
            _setSubmitDisabled(backdrop, false);
        }
    }

    backdrop.querySelector('#pd-usdc')?.addEventListener('input', _checkUsdcMin);
    backdrop.querySelector('#pd-usdc')?.addEventListener('input', () => { backdrop.querySelector('#pd-preview').innerHTML = ''; });
    backdrop.querySelector('#pd-slider')?.addEventListener('input', () => { backdrop.querySelector('#pd-preview').innerHTML = ''; });

    // Slider-Handler: füllt readonly-Felder, aktualisiert Anzeige + Min-Check
    function _onSliderChange() {
        const slider = backdrop.querySelector('#pd-slider');
        const pct = Math.max(0, Math.min(100, parseInt(slider.value, 10)));
        const factor = pct / 100;
        const a = _floorDec(econMax.maxA * factor, econDecA);
        const b = _floorDec(econMax.maxB * factor, econDecB);
        backdrop.querySelector('#pd-max-a').value = String(a);
        backdrop.querySelector('#pd-max-b').value = String(b);
        // Nur den %-Text in der ersten Span ändern, Info-Icon erhalten
        const readoutTxt = backdrop.querySelector('#pd-slider-readout span:first-child');
        if (readoutTxt) readoutTxt.innerHTML = `<strong>${pct}%</strong> des Maximums`;

        // Frühzeitig abbrechen wenn Wallet-Balance für Token-Mengen-Modus nicht reicht
        if (econMax.maxA <= 0 && econMax.maxB <= 0) {
            const hint = backdrop.querySelector('#pd-ratio-hint');
            if (hint) {
                let reason;
                if (tokenALabel === 'SOL' && walletASafe <= 0)
                    reason = tr('sliq.sol_reserve_blocks', '{token}-Balance im Wallet ({amount} SOL) zu niedrig – SOL-Reserve (0.10 SOL) deckt das gesamte Guthaben ab. Bitte SOL ins Wallet einzahlen oder den USDC-Modus verwenden.', { token: _esc(tokenALabel), amount: _fmt(walletA) });
                else if (tokenBLabel === 'SOL' && walletBSafe <= 0)
                    reason = tr('sliq.sol_reserve_blocks', '{token}-Balance im Wallet ({amount} SOL) zu niedrig – SOL-Reserve (0.10 SOL) deckt das gesamte Guthaben ab. Bitte SOL ins Wallet einzahlen oder den USDC-Modus verwenden.', { token: _esc(tokenBLabel), amount: _fmt(walletB) });
                else
                    reason = tr('sliq.wallet_too_low_pair', 'Wallet-Balance für {a} und/oder {b} zu niedrig. Bitte Tokens aufstocken oder den USDC-Modus verwenden.', { a: _esc(tokenALabel), b: _esc(tokenBLabel) });
                hint.innerHTML = `<span style="color:var(--danger);">⚠ ${reason}</span>`;
            }
            _setSubmitDisabled(backdrop, true, tr('sliq.wallet_too_low_token_mode', 'Wallet-Balance zu niedrig für Token-Mengen-Modus'));
            return;
        }

        _updateRatioHint(backdrop, tokenALabel, tokenBLabel, price, isBtcPair, state.btcPrice, state.usdcIsTokenA, minUsdc, blockedOutOfRange,
            state.volatilePair ? { volatilePair: true, quoteIsTokenA: state.quoteIsTokenA, quotePrice: state.quotePrice } : null);
    }
    backdrop.querySelector('#pd-slider')?.addEventListener('input', _onSliderChange);
    backdrop._revalidate = () => {
        if (!backdrop.querySelector('#pd-tab-pair')?.hidden) _onSliderChange();
        else _checkUsdcMin();
    };
    // Pair-Tab initial befüllen (default 100%)
    _onSliderChange();
    // USDC-Tab ist aktiv → initialen Button-State setzen (leeres Feld = disabled)
    _checkUsdcMin();

    // ── Auto-Refresh: Wallet/Preis/Range können sich ändern, während das Modal offen ist ──
    async function _refreshDepositModal() {
        const [freshState, freshBalance, freshGas] = await Promise.all([
            _fetchPoolState(pool.id),
            _fetchWalletBalanceFresh(),
            _fetchDepositGasEstimate(pool.id, isNew),
        ]);
        if (freshState) {
            price   = freshState.poolStats?.price ?? freshState.position?.priceNow ?? null;
            inRange = freshState.position?.inRange ?? null;
            prLower = freshState.position?.priceLower ?? null;
            prUpper = freshState.position?.priceUpper ?? null;
            blockedOutOfRange = !isNew && inRange === false;
            clmmRatio = isBtcPair ? null : _clmmDepositRatio(price, prLower, prUpper);
        }
        if (freshBalance) {
            walletA       = _walletAmount(freshBalance, tokenALabel);
            walletB       = _walletAmount(freshBalance, tokenBLabel);
            walletUsdc    = freshBalance?.usdc ?? 0;
            walletUsdcSafe = state.volatilePair ? _floorDec(walletUsdc * 0.97, 2) : walletUsdc;
            walletASafe   = walletA;
            walletBSafe   = walletB;
        }
        if (freshGas) gasEstimate = freshGas;
        econMax = _computeEconomicMax(walletASafe, walletBSafe, clmmRatio ?? price, isBtcPair);

        if (!getModal(mid)) return; // Modal in der Zwischenzeit geschlossen
        // Läuft gerade Einzahlen/Auszahlen (oder die Retry-Wartezeit danach) – Refresh
        // darf den gesperrten Submit-Button NICHT wieder freischalten (Fund 2026-08-07:
        // der Button wurde während einer laufenden TX durch diesen Refresh reaktiviert).
        if (backdrop._actionRunning) return;
        const oorEl = backdrop.querySelector('#pd-oor-banner');
        if (oorEl) oorEl.innerHTML = oorBannerHtml();
        const hintEl = backdrop.querySelector('#pd-usdc-hint');
        if (hintEl) hintEl.innerHTML = _buildDepositUsdcHint({ walletUsdc, minUsdc, isNew, isBtcPair, tokenALabel, tokenBLabel, gasEstimate });
        const wA = backdrop.querySelector('#pd-wallet-a');
        if (wA) wA.textContent = `Wallet: ${_fmt(walletA)}`;
        const wB = backdrop.querySelector('#pd-wallet-b');
        if (wB) wB.textContent = `Wallet: ${_fmt(walletB)}`;
        backdrop._revalidate?.();
    }
    const stopRefresh = _attachModalAutoRefresh(mid, _refreshDepositModal);

    // Live On-Chain-Preis/Range einmalig im Hintergrund nachladen (dauert wegen
    // RPC+Rate-Limiter ein paar Sekunden — das Modal öffnet daher sofort mit dem
    // schnellen Cache-Wert aus _fetchPoolState oben und korrigiert sich hier still,
    // sobald der Live-Wert da ist). Fund 2026-08-07: ein blockierender Live-Call
    // beim Öffnen ließ das Modal ~30s hängen, bevor es überhaupt erschien.
    _fetchPoolStateLive(pool.id).then(live => {
        if (!live?.ok || !getModal(mid)) return;
        // Wie bei _refreshDepositModal: läuft gerade eine Aktion, nicht in den
        // gesperrten Submit-Button hineinfunken.
        if (backdrop._actionRunning) return;
        inRange = live.inRange;
        prLower = live.priceLower ?? prLower;
        prUpper = live.priceUpper ?? prUpper;
        price   = live.currentPrice ?? price;
        blockedOutOfRange = !isNew && inRange === false;
        clmmRatio = isBtcPair ? null : _clmmDepositRatio(price, prLower, prUpper);
        econMax   = _computeEconomicMax(walletASafe, walletBSafe, clmmRatio ?? price, isBtcPair);
        const oorEl = backdrop.querySelector('#pd-oor-banner');
        if (oorEl) oorEl.innerHTML = oorBannerHtml();
        backdrop._revalidate?.();
    });
}

// Berechnet das wirtschaftlich maximale Token-Paar aus Wallet + Pool-Preis.
function _cleanupHint(cleanupMode = 'ranking') {
    if (cleanupMode === 'disabled') return '';
    const mm  = new Date().getMinutes();
    const min = (65 - mm) % 60;
    if (min === 0) return `<div class="wallet-hint" style="font-size:0.78rem; color:var(--danger);">${tr('sliq.cleanup_running_now', '⚠ Cleanup läuft gerade.')}</div>`;
    const style = min < 10 ? 'color:var(--danger);' : 'color:var(--text-muted);';
    return `<div class="wallet-hint" style="font-size:0.78rem; ${style}">${min === 1
        ? tr('sliq.next_cleanup_one', 'Nächster Cleanup in 1 Minute.')
        : tr('sliq.next_cleanup', 'Nächster Cleanup in {min} Minuten.', { min })}</div>`;
}

// Berechnet den effektiven CLMM-Deposit-Ratio (tokenB pro 1 tokenA) basierend auf
// aktuellem Preis + Range. Weicht vom Spot-Preis ab wenn der Preis nicht im
// geometrischen Zentrum der Range liegt.
// Gibt null zurück wenn Preis oder Range fehlen (Fallback: Spot-Preis).
function _clmmDepositRatio(price, priceLower, priceUpper) {
    if (!price || price <= 0 || !priceLower || !priceUpper) return null;
    if (price >= priceUpper) return Infinity;  // 100% tokenB — kein tokenA nötig
    if (price <= priceLower) return 0;         // 100% tokenA — kein tokenB nötig
    const sqrtP = Math.sqrt(price);
    const sqrtL = Math.sqrt(priceLower);
    const sqrtU = Math.sqrt(priceUpper);
    const tokenAPerLiq = (sqrtU - sqrtP) / (sqrtP * sqrtU);
    const tokenBPerLiq = sqrtP - sqrtL;
    if (tokenAPerLiq <= 0) return Infinity;
    return tokenBPerLiq / tokenAPerLiq;  // tokenB pro 1 tokenA
}

// price = tokenB pro 1 tokenA (z.B. 91 USDC pro 1 SOL).
// btcPair: Ratio ≈ 1 → Engpass = min(walletA, walletB).
function _computeEconomicMax(walletA, walletB, price, isBtcPair) {
    if (isBtcPair) {
        const m = Math.min(walletA, walletB);
        return { maxA: m, maxB: m };
    }
    if (!price || price <= 0) return { maxA: 0, maxB: 0 };
    // Wieviel tokenB würde walletA "kaufen"? → walletA * price
    const bForWalletA = walletA * price;
    if (bForWalletA <= walletB) {
        // tokenA ist Engpass → maxA = walletA, maxB = bForWalletA
        return { maxA: walletA, maxB: bForWalletA };
    } else {
        // tokenB ist Engpass → maxB = walletB, maxA = walletB / price
        return { maxA: walletB / price, maxB: walletB };
    }
}

function _floorDec(v, decimals) {
    if (!Number.isFinite(v) || v <= 0) return 0;
    const f = Math.pow(10, decimals);
    return Math.floor(v * f) / f;
}

function _updateRatioHint(backdrop, tokenALabel, tokenBLabel, price, isBtcPair, btcPrice, usdcIsTokenA, minUsdc, blockedOutOfRange = false, volatileOpts = null) {
    const hint = backdrop.querySelector('#pd-ratio-hint');
    if (!hint) return;
    const a = parseFloat(backdrop.querySelector('#pd-max-a').value);
    const b = parseFloat(backdrop.querySelector('#pd-max-b').value);

    // USDC-Schätzung für den eingesetzten Paar-Wert
    let estUsdc = null;
    if (Number.isFinite(a) && Number.isFinite(b)) {
        if (isBtcPair && btcPrice > 0)                                              estUsdc = (a + b) * btcPrice;
        else if (volatileOpts?.volatilePair && volatileOpts.quotePrice > 0 && price > 0) {
            // quoteIsTokenA: (a + b/price) * quotePrice; quoteIsTokenB: (a*price + b) * quotePrice
            estUsdc = volatileOpts.quoteIsTokenA
                ? (a + b / price) * volatileOpts.quotePrice
                : (a * price + b) * volatileOpts.quotePrice;
        }
        else if (usdcIsTokenA && price > 0)                                         estUsdc = a + b / price;
        else if (price > 0)                                                         estUsdc = a * price + b;
    }

    const ratioLine = isBtcPair
        ? (btcPrice > 0 ? `Pool-Ratio: 1 ${tokenALabel} ≈ 1 ${tokenBLabel} · BTC ≈ ${_fmt(btcPrice)} USDC` : `Pool-Ratio: 1 ${tokenALabel} ≈ 1 ${tokenBLabel}`)
        : `Pool-Ratio: 1 ${tokenALabel} ≈ ${_fmt(price)} ${tokenBLabel}`;

    if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) {
        hint.innerHTML = ratioLine;
        _setSubmitDisabled(backdrop, true, tr('sliq.move_slider', 'Bitte Schieberegler bewegen'));
        return;
    }

    let engpass;
    if (isBtcPair) {
        engpass = `Beide Seiten: ${_fmt(a)} ${tokenALabel} + ${_fmt(b)} ${tokenBLabel}`;
    } else {
        const bForA = a * price;
        if (bForA <= b) {
            engpass = tr('sliq.bottleneck', 'Engpass: {token} ({amount} → {converted} {other}, {rest} {other} bleibt)', { token: tokenALabel, amount: _fmt(a), converted: _fmt(bForA), other: tokenBLabel, rest: _fmt(b - bForA) });
        } else {
            const aForB = b / price;
            engpass = tr('sliq.bottleneck', 'Engpass: {token} ({amount} → {converted} {other}, {rest} {other} bleibt)', { token: tokenBLabel, amount: _fmt(b), converted: _fmt(aForB), other: tokenALabel, rest: _fmt(a - aForB) });
        }
    }

    const usdcLine = estUsdc != null ? '<br>' + tr('sliq.value_approx', 'Wert: ≈ {usd} USDC', { usd: _fmt(estUsdc) }) : '';
    hint.innerHTML = `${ratioLine}<br>${engpass}${usdcLine}`;

    // Submit-Sperren: Out-of-Range hat Vorrang vor Min-Check
    if (blockedOutOfRange) {
        _setSubmitDisabled(backdrop, true, tr('sliq.oor_deposit_blocked', 'Position ist out of Range – Einzahlen nicht möglich'));
    } else if (estUsdc != null && minUsdc != null && estUsdc < minUsdc) {
        _setSubmitDisabled(backdrop, true, tr('sliq.min_deposit_hint', 'Mindesteinzahlung ≈ {min} USDC (aktuell {cur} USDC)', { min: _fmt(minUsdc), cur: _fmt(estUsdc) }));
    } else {
        _setSubmitDisabled(backdrop, false);
    }
}

function _updateWithdrawHint(backdrop, tokenALabel, tokenBLabel, a, b, estUsdc, minUsdc) {
    const hint = backdrop.querySelector('#pw-ratio-hint');
    if (!hint) return;
    if (estUsdc <= 0) {
        hint.innerHTML = '';
        _setSubmitDisabled(backdrop, true, tr('sliq.move_slider_gt0', 'Bitte Schieberegler auf > 0 stellen'));
        return;
    }
    hint.innerHTML = `${_fmt(a)} ${_esc(tokenALabel)} + ${_fmt(b)} ${_esc(tokenBLabel)}<br>${tr('sliq.value_approx', 'Wert: ≈ {usd} USDC', { usd: _fmt(estUsdc) })}`;
    if (estUsdc < minUsdc) {
        _setSubmitDisabled(backdrop, true, tr('sliq.min_withdraw_hint', 'Mindestauszahlung ≈ {min} USDC (aktuell {cur} USDC)', { min: _fmt(minUsdc), cur: _fmt(estUsdc) }));
    } else {
        _setSubmitDisabled(backdrop, false);
    }
}

function _setSubmitDisabled(backdrop, disabled, reason = '') {
    // data-mi="0" = Vorschau, data-mi="1" = Einzahlen/Auszahlen — beide sperren
    for (const mi of ['0', '1']) {
        const btn = backdrop.querySelector(`[data-mi="${mi}"]`);
        if (!btn) continue;
        btn.disabled = disabled;
        btn.style.opacity = disabled ? '0.4' : '';
        btn.style.cursor  = disabled ? 'not-allowed' : '';
        btn.title         = disabled ? reason : '';
    }
}

// ── Auszahlen-Modal ──────────────────────────────────────────────────────────

async function _openPoolWithdrawModal(pool, addrs = []) {
    const mid = 'liquiditybot-withdraw-modal';
    const [state, cfgRes] = await Promise.all([
        _fetchPoolState(pool.id),
        fetch('/api/config/liquiditybot').catch(() => null),
    ]);
    if (!state) { infoModal(tr('sliq.pool_state_failed', 'Pool-State konnte nicht geladen werden.')); return; }
    if (!state.position) { infoModal(tr('sliq.no_open_position', 'Keine offene Position – Auszahlung nicht möglich.')); return; }
    const cleanupMode = cfgRes?.ok ? _parseCleanupMode(await cfgRes.json()) : 'ranking';

    const tokenALabel = state.tokenALabel;
    const tokenBLabel = state.tokenBLabel;
    const isBtcPair   = !!state.btcPricePoolId;
    const decA        = state.decimalsA ?? 6;
    const decB        = state.decimalsB ?? 6;
    const minUsdc     = isBtcPair ? 2 : 1;

    // Ändern sich bei jedem Auto-Refresh (Position kann sich durch Fees/Rebalancing
    // während das Modal offen ist verändern) — daher `let`.
    let posA     = state.position?.amountA ?? 0;
    let posB     = state.position?.amountB ?? 0;
    let posValue = state.position?.myValue ?? 0;
    let inRange  = state.position?.inRange ?? null;

    const oorWarningHtml = () => inRange === false
        ? `<div class="modal-feedback" style="display:block; margin-bottom:0.5rem;">
             ${tr('sliq.position_is_info', '&#9432; Position ist')} <strong>${tr('sliq.out_of_range_lc', 'out of Range')}</strong> ${tr('sliq.maybe_one_token', '– enthält evtl. nur einen Token.')}
           </div>`
        : '';

    showModal({
        id: mid,
        title: `Auszahlen – ${state.displayPair ?? state.pair}`,
        body: `
            <div id="pw-oor-banner">${oorWarningHtml()}</div>
            ${_cleanupHint(cleanupMode)}
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-pwtab="usdc">${tr('sliq.by_usdc_value', 'Per USDC-Wert')}</button>
                <button class="wm-tab" data-pwtab="pair">${tr('sliq.by_token_amounts', 'Per Token-Mengen')}</button>
            </div>
            <div id="pw-tab-usdc">
                <div class="settings-row">
                    <span class="settings-label">${tr('sliq.usdc_value', 'USDC-Wert')}</span>
                    <div class="send-amount-row">
                        <input class="modal-input" id="pw-usdc" type="number" min="0" step="any" placeholder="${minUsdc}.00">
                        <button class="btn btn-secondary btn-sm" id="pw-usdc-max">Max</button>
                    </div>
                </div>
                <div class="wallet-hint" style="font-size:0.78rem;">
                    ${tr('sliq.withdraw_usdc_hint', 'Liquidität im Gegenwert dieses USDC-Betrags wird proportional entnommen.')}<br>
                    ${tr('sliq.position_approx', 'Position: ≈')} <span id="pw-pos-value">${_fmt(posValue)}</span> USDC · ${tr('sliq.min_amount', 'Mindestbetrag')}: ${minUsdc} USDC
                </div>
            </div>
            <div id="pw-tab-pair" hidden>
                <div class="settings-row">
                    <span class="settings-label">${_esc(tokenALabel)}</span>
                    <div class="send-amount-row">
                        <input class="modal-input" id="pw-max-a" type="text" readonly value="0" style="opacity:0.85;">
                        <span class="wallet-hint" id="pw-pos-a" style="font-size:0.72rem; min-width:7rem;">Position: ${_fmt(posA)}</span>
                    </div>
                </div>
                <div class="settings-row">
                    <span class="settings-label">${_esc(tokenBLabel)}</span>
                    <div class="send-amount-row">
                        <input class="modal-input" id="pw-max-b" type="text" readonly value="0" style="opacity:0.85;">
                        <span class="wallet-hint" id="pw-pos-b" style="font-size:0.72rem; min-width:7rem;">Position: ${_fmt(posB)}</span>
                    </div>
                </div>
                <div style="margin-top:1rem; padding:0 0.25rem;">
                    <input type="range" id="pw-slider" min="0" max="100" step="1" value="100"
                           data-pos-value="${posValue}"
                           style="width:100%; cursor:pointer;">
                    <div id="pw-slider-readout" style="text-align:center; font-size:0.85rem; margin-top:0.35rem; display:flex; align-items:center; justify-content:center; gap:0.4rem;">
                        <span><strong>100%</strong> ${tr('sliq.of_position', 'der Position')}</span>
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.slider', 'Schieberegler')}"
                            data-tooltip-content="${tr('sliq.slider_withdraw_tip', 'Schieberegler wählt den prozentualen Anteil der Position zum Auszahlen. Beide Token werden proportional entnommen (LP-Ratio). Kein Swap.')}">&#9432;</span>
                    </div>
                </div>
                <div class="wallet-hint" id="pw-ratio-hint" style="font-size:0.75rem; margin-top:0.6rem;"></div>
                <div class="wallet-hint" style="font-size:0.78rem;">
                    Mindestauszahlung: ca. ${_fmt(minUsdc)} USDC.
                </div>
            </div>
            <div class="pw-settings">
                <div class="settings-row" style="margin-top:0.6rem;">
                    <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                        ${tr('sliq.swap_usdc', 'Swap → USDC')}
                        <span class="info-tip-label"
                            data-tooltip-title="${tr('sliq.swap_usdc', 'Swap → USDC')}"
                            data-tooltip-content="${tr('sliq.pw_swap_tip', 'Entnommene Coins vor dem Verbleib im Wallet (bzw. vor dem Senden) automatisch in USDC tauschen.')}">&#9432;</span>
                    </span>
                    <label class="toggle-switch toggle-sm">
                        <input type="checkbox" id="pw-swap">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="settings-row">
                    <span class="settings-label">${tr('sb.send_to', 'Senden an')}</span>
                    <select class="modal-select" id="pw-sendto">
                        <option value="">${tr('sliq.dont_send_keep_wallet', '– Nicht senden (im Wallet belassen) –')}</option>
                        ${_addrOptions(addrs, '')}
                    </select>
                </div>
            </div>
            <div id="pw-preview" style="margin-top:0.6rem;"></div>
            <div class="modal-feedback" id="pw-feedback" style="margin-top:0.5rem;"></div>
            <div class="wallet-hint" style="font-size:0.7rem; margin-top:0.5rem;">${tr('sliq.auto_refresh_hint', 'Aktualisiert sich automatisch jede Minute.')}</div>`,
        actions: [
            { label: 'Vorschau',   onClick: () => _runPoolPreview(mid, 'withdraw', pool.id, false) },
            { label: tr('sb.withdraw_btn', '&#10004; Auszahlen'), onClick: () => _runPoolAction(mid, 'withdraw', pool.id, false) },
            { label: tr('common.close', 'Schließen'),  onClick: () => closeModal(mid) },
        ],
        onClose: () => stopRefresh(),
    });

    const backdrop = getModal(mid);
    if (!backdrop) return;

    backdrop.querySelectorAll('[data-pwtab]').forEach(b => {
        b.addEventListener('click', () => {
            backdrop.querySelectorAll('[data-pwtab]').forEach(x => x.classList.toggle('active', x === b));
            backdrop.querySelector('#pw-tab-usdc').hidden = b.dataset.pwtab !== 'usdc';
            backdrop.querySelector('#pw-tab-pair').hidden = b.dataset.pwtab !== 'pair';
            if (b.dataset.pwtab === 'pair') {
                _onWithdrawSliderChange();
            } else {
                _checkWithdrawUsdcMin();
            }
        });
    });

    backdrop.querySelector('#pw-usdc-max')?.addEventListener('click', () => {
        // Abrunden statt toFixed(2) (das rundet kaufmännisch → kann Position-Wert überschreiten)
        const input = backdrop.querySelector('#pw-usdc');
        input.value = _floorDec(Math.max(0, posValue), 2).toFixed(2);
        input.dataset.full = 'true';
        _checkWithdrawUsdcMin();
    });

    function _checkWithdrawUsdcMin() {
        const v = parseFloat(backdrop.querySelector('#pw-usdc')?.value) || 0;
        if (v < minUsdc) {
            _setSubmitDisabled(backdrop, true, `Mindestauszahlung: ${minUsdc} USDC`);
        } else {
            _setSubmitDisabled(backdrop, false);
        }
    }

    backdrop.querySelector('#pw-usdc')?.addEventListener('input', _checkWithdrawUsdcMin);
    backdrop.querySelector('#pw-usdc')?.addEventListener('input', e => {
        delete e.target.dataset.full;
        backdrop.querySelector('#pw-preview').innerHTML = '';
    });
    backdrop.querySelector('#pw-slider')?.addEventListener('input', () => { backdrop.querySelector('#pw-preview').innerHTML = ''; });

    const econDecA = Math.min(decA, 8);
    const econDecB = Math.min(decB, 8);

    function _onWithdrawSliderChange() {
        const slider = backdrop.querySelector('#pw-slider');
        const pct    = Math.max(0, Math.min(100, parseInt(slider.value, 10)));
        const factor = pct / 100;
        const a = _floorDec(posA * factor, econDecA);
        const b = _floorDec(posB * factor, econDecB);
        backdrop.querySelector('#pw-max-a').value = String(a);
        backdrop.querySelector('#pw-max-b').value = String(b);
        const readoutTxt = backdrop.querySelector('#pw-slider-readout span:first-child');
        if (readoutTxt) readoutTxt.innerHTML = `<strong>${pct}%</strong> der Position`;
        _updateWithdrawHint(backdrop, tokenALabel, tokenBLabel, a, b, posValue * factor, minUsdc);
    }

    backdrop.querySelector('#pw-slider')?.addEventListener('input', _onWithdrawSliderChange);
    backdrop._revalidate = () => {
        if (!backdrop.querySelector('#pw-tab-pair')?.hidden) _onWithdrawSliderChange();
        else _checkWithdrawUsdcMin();
    };
    // Pair-Tab initial befüllen (default 100%)
    _onWithdrawSliderChange();
    // USDC-Tab ist aktiv → initialen Button-State setzen (leeres Feld = disabled)
    _checkWithdrawUsdcMin();

    // ── Auto-Refresh: Positionswerte können sich ändern (Fees, Rebalancing), während
    // das Modal offen ist. Der getippte USDC-Betrag im Feld bleibt unangetastet.
    async function _refreshWithdrawModal() {
        const freshState = await _fetchPoolState(pool.id);
        if (!freshState?.position) return; // Position evtl. inzwischen geschlossen — nichts überschreiben
        posA     = freshState.position?.amountA ?? 0;
        posB     = freshState.position?.amountB ?? 0;
        posValue = freshState.position?.myValue ?? 0;
        inRange  = freshState.position?.inRange ?? null;

        if (!getModal(mid)) return; // Modal in der Zwischenzeit geschlossen
        if (backdrop._actionRunning) return; // läuft gerade Aus-/Einzahlen — Button nicht vorzeitig freigeben
        const oorEl = backdrop.querySelector('#pw-oor-banner');
        if (oorEl) oorEl.innerHTML = oorWarningHtml();
        const posValEl = backdrop.querySelector('#pw-pos-value');
        if (posValEl) posValEl.textContent = _fmt(posValue);
        const posAEl = backdrop.querySelector('#pw-pos-a');
        if (posAEl) posAEl.textContent = `Position: ${_fmt(posA)}`;
        const posBEl = backdrop.querySelector('#pw-pos-b');
        if (posBEl) posBEl.textContent = `Position: ${_fmt(posB)}`;
        const slider = backdrop.querySelector('#pw-slider');
        if (slider) slider.dataset.posValue = String(posValue);
        // Wenn der Max-Button aktiv war (Vollentnahme), Betrag mitziehen
        const usdcInput = backdrop.querySelector('#pw-usdc');
        if (usdcInput?.dataset.full === 'true') usdcInput.value = _floorDec(Math.max(0, posValue), 2).toFixed(2);
        backdrop._revalidate?.();
    }
    const stopRefresh = _attachModalAutoRefresh(mid, _refreshWithdrawModal);
}

// ── Gemeinsame Helper: Body aus aktuellem Tab bauen ─────────────────────────

function _buildPoolBody(backdrop, action, isNew) {
    const prefix = action === 'deposit' ? 'pd' : 'pw';
    const tabBtns = backdrop.querySelectorAll(`[data-${prefix}tab]`);
    const active = [...tabBtns].find(b => b.classList.contains('active'))?.dataset[`${prefix}tab`];

    // Swap → USDC / Senden an gelten pool-/tab-übergreifend nur für Auszahlungen.
    const withdrawExtra = action === 'withdraw'
        ? {
            swapToUsdc: backdrop.querySelector('#pw-swap')?.checked ?? false,
            sendTo:     backdrop.querySelector('#pw-sendto')?.value ?? '',
          }
        : {};

    if (active === 'usdc') {
        const input  = backdrop.querySelector(`#${prefix}-usdc`);
        const v      = parseFloat(input?.value);
        if (isNaN(v) || v <= 0) return { error: tr('sliq.enter_usdc_amount', 'Bitte einen USDC-Betrag eingeben.') };
        // Max-Button gesetzt → Vollentnahme; manuell eingetippter Betrag → anteilig
        if (action === 'withdraw' && input?.dataset.full === 'true') {
            return { body: { action, mode: 'full', isNew, ...withdrawExtra } };
        }
        return { body: { action, mode: 'usdc', usdc: v, isNew, ...withdrawExtra } };
    } else if (active === 'pair') {
        if (action === 'deposit') {
            // Deposit-Modus C: beide Token als Obergrenzen
            const a = parseFloat(backdrop.querySelector(`#${prefix}-max-a`)?.value);
            const b = parseFloat(backdrop.querySelector(`#${prefix}-max-b`)?.value);
            if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) {
                return { error: tr('sliq.move_slider_gt0_dot', 'Bitte Schieberegler auf > 0 stellen.') };
            }
            return { body: { action, mode: 'pair', maxA: a, maxB: b, isNew } };
        } else {
            // Withdraw-Modus: Slider bei 100% → Vollentnahme; darunter → anteilig
            const slider = backdrop.querySelector(`#${prefix}-slider`);
            const pct    = parseFloat(slider?.value) || 0;
            if (pct >= 100) return { body: { action, mode: 'full', isNew, ...withdrawExtra } };
            const posVal = parseFloat(slider?.dataset.posValue) || 0;
            const usdc   = posVal * pct / 100;
            if (usdc <= 0) return { error: tr('sliq.move_slider_gt0_dot', 'Bitte Schieberegler auf > 0 stellen.') };
            return { body: { action, mode: 'usdc', usdc, isNew, ...withdrawExtra } };
        }
    }
}

async function _runPoolPreview(mid, action, poolId, isNew) {
    const backdrop = getModal(mid);
    if (!backdrop) return;
    const prefix = action === 'deposit' ? 'pd' : 'pw';
    const previewBox  = backdrop.querySelector(`#${prefix}-preview`);
    const feedbackBox = backdrop.querySelector(`#${prefix}-feedback`);
    feedbackBox.textContent = '';
    feedbackBox.className   = 'modal-feedback';

    const built = _buildPoolBody(backdrop, action, isNew);
    if (built.error) { feedbackBox.textContent = built.error; feedbackBox.classList.add('err'); feedbackBox.style.display = 'block'; return; }

    // Buttons während Berechnung sperren
    const closeBtn = backdrop.querySelector('[data-mi="2"]');
    if (closeBtn) { closeBtn.disabled = true; closeBtn.style.opacity = '0.4'; closeBtn.style.cursor = 'not-allowed'; }
    _setSubmitDisabled(backdrop, true, tr('sliq.calculating_preview', 'Vorschau wird berechnet…'));
    backdrop._actionRunning = true;

    previewBox.innerHTML = '<div class="wallet-hint">' + tr('sliq.loading_preview', 'Lade Vorschau…') + '</div>';
    try {
        const r = await fetch(`/api/pools/liquidity/${encodeURIComponent(poolId)}/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(built.body),
        });
        const data = await r.json();
        previewBox.innerHTML = _renderPreviewResult(data);
    } catch (err) {
        previewBox.innerHTML = `<div class="modal-feedback error" style="display:block;">${tr('sliq.preview_error', 'Vorschau-Fehler: {error}', { error: _esc(err.message) })}</div>`;
    } finally {
        backdrop._actionRunning = false;
        if (closeBtn) { closeBtn.disabled = false; closeBtn.style.opacity = ''; closeBtn.style.cursor = ''; }
        backdrop._revalidate?.();
    }
}

/**
 * Fehler, bei denen ein zweiter Versuch realistisch hilft (Marktpreis bewegt,
 * Balance kurz nicht lesbar) — dann bietet das Modal einen 30s-Countdown an
 * statt abzubrechen.
 *
 * 🔒 Der Abgleich läuft über `errorCode` aus bin/deposit.js, NICHT über den
 * Meldungstext. Vorher wurde der (deutsche) Skripttext mit den hier übersetzten
 * Vergleichstexten verglichen — auf einer englischen Installation traf das nie zu
 * und der Retry entfiel stillschweigend (Fund 2026-08-11). Ein Vergleich auf Prosa
 * ist auch einsprachig fragil: eine umformulierte Meldung hätte dasselbe bewirkt.
 */
const RETRYABLE_CODES = ['WALLET_BALANCE', 'SWAP_ROUTING', 'MARKET_DATA'];

function _isRetryableError(data) {
    return RETRYABLE_CODES.includes(data?.errorCode);
}

function _startRetryCountdown(feedbackBox, backdrop, seconds) {
    _setSubmitDisabled(backdrop, true, tr('sliq.wait_seconds', 'Bitte {n}s warten', { n: seconds }));
    feedbackBox.className   = 'modal-feedback error';
    feedbackBox.style.display = 'block';
    let remaining = seconds;
    (function tick() {
        if (remaining <= 0) {
            feedbackBox.textContent = tr('sliq.wallet_read_failed_retry', 'Wallet-Balance konnte nicht gelesen werden. Bitte versuche es noch einmal.');
            backdrop._actionRunning = false;
            _setSubmitDisabled(backdrop, false);
            backdrop._revalidate?.();
            return;
        }
        feedbackBox.textContent = tr('sliq.wallet_read_wait', 'Wallet-Balance konnte nicht gelesen werden. Bitte warte noch {n}s…', { n: remaining });
        remaining--;
        setTimeout(tick, 1000);
    })();
}

async function _runPoolAction(mid, action, poolId, isNew) {
    const backdrop = getModal(mid);
    if (!backdrop) return;
    const prefix = action === 'deposit' ? 'pd' : 'pw';
    const feedbackBox = backdrop.querySelector(`#${prefix}-feedback`);
    feedbackBox.textContent = '';
    feedbackBox.className   = 'modal-feedback';
    // Vorschau-Ergebnis ausblenden sobald die echte Aktion startet
    const previewBox = backdrop.querySelector(`#${prefix}-preview`);
    if (previewBox) previewBox.innerHTML = '';

    const built = _buildPoolBody(backdrop, action, isNew);
    if (built.error) { feedbackBox.textContent = built.error; feedbackBox.classList.add('err'); feedbackBox.style.display = 'block'; return; }

    feedbackBox.textContent = tr('sliq.action_running_long', '{action} läuft – das kann 30–60 Sekunden dauern…', { action: action === 'deposit' ? tr('sb.deposit', 'Einzahlen') : tr('sb.withdraw', 'Auszahlen') });
    feedbackBox.style.display = 'block';
    _setSubmitDisabled(backdrop, true, tr('sliq.action_running', '{action} läuft…', { action: action === 'deposit' ? tr('sb.deposit', 'Einzahlen') : tr('sb.withdraw', 'Auszahlen') }));
    backdrop._actionRunning = true;
    let retryMode = false;
    try {
        const r = await fetch(`/api/pools/liquidity/${encodeURIComponent(poolId)}/${action}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(built.body),
        });
        const data = await r.json();
        if (data.ok) {
            feedbackBox.className = 'modal-feedback ok';
            const txHash = data.result?.txHash;
            const txLink = txHash
                ? ` <a href="https://solscan.io/tx/${txHash}" target="_blank" rel="noopener" class="tx-link">${tr('sliq.view_tx_plain', 'TX ansehen ↗')}</a>`
                : '';
            feedbackBox.innerHTML = `✓ ${action === 'deposit' ? tr('sliq.deposited', 'Eingezahlt') : tr('sliq.withdrawn', 'Ausgezahlt')}.${txLink}`;
            // Wallet-Karte nach Deposit/Withdraw aktualisieren (deposit.js hat refreshAfterAction
            // bereits abgeschlossen → wallet-monitor.db ist frisch → direktes Re-Render reicht)
            const walletEl = _container?.querySelector('.liquiditybot-grid-wallet');
            if (walletEl) _renderWallet(walletEl);
        } else if (_isRetryableError(data)) {
            retryMode = true;
            _startRetryCountdown(feedbackBox, backdrop, 30);
        } else {
            feedbackBox.className   = 'modal-feedback error';
            feedbackBox.textContent = tr('sb.error_prefix', 'Fehler: {error}', { error: data.error ?? tr('set.unknown_error', 'Unbekannter Fehler') });
        }
    } catch (err) {
        feedbackBox.className   = 'modal-feedback error';
        feedbackBox.textContent = tr('sliq.network_error', 'Netzwerk-Fehler: {error}', { error: err.message });
    } finally {
        if (!retryMode) {
            backdrop._actionRunning = false;
            _setSubmitDisabled(backdrop, false);
            backdrop._revalidate?.();
        }
        // retryMode: _actionRunning bleibt true, bis _startRetryCountdown fertig ist
        // (verhindert, dass ein zwischenzeitlicher Refresh den Button vorzeitig freigibt).
    }
}
