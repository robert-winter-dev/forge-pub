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
import { buildWalletDetailHtml } from '/forge/js/wallet-detail-modal.js?v=20260731c';

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

// ── Öffentliche API ────────────────────────────────────────────────────────────

export function mount(container, ctx = {}) {
    _container = container;
    _ctx       = ctx;
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

    const poolOffersEl = document.createElement('div');
    poolOffersEl.style.marginTop = '1rem';
    _container.appendChild(poolOffersEl);

    _renderService(serviceEl);
    _renderWallet(walletEl);
    _renderPools(poolsEl);
    _renderPoolOffers(poolOffersEl);
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
        return { level: 'critical', icon: '🔴', text: `Kritisch: Guthaben reicht noch ~${remainingHours.toFixed(1)}h – bitte zeitnah aufladen.` };
    }
    if (remainingHours <= (lowBalanceWarnHours ?? 0)) {
        return { level: 'warn', icon: '🟡', text: `Guthaben wird knapp: reicht noch ~${remainingHours.toFixed(1)}h.` };
    }
    return null;
}

function _formatPremiumEndDate(remainingHours) {
    if (remainingHours == null) return 'no data';
    const end = new Date(Date.now() + remainingHours * 3600 * 1000);
    const dd   = String(end.getDate()).padStart(2, '0');
    const mm   = String(end.getMonth() + 1).padStart(2, '0');
    const min  = String(end.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}.${end.getFullYear()} / ${end.getHours()}:${min} Uhr`;
}

function _premiumTabPanelHtml(status) {
    if (!status.walletConfigured) {
        return `
            <p class="modal-hint" style="margin:0;">
                Kein Premium-Wallet konfiguriert. Wird bei der Installation automatisch angelegt
                (bin/install.sh) — bei einer bestehenden Installation ggf. neu installieren.
            </p>`;
    }

    const warning = _premiumBalanceWarning(status);
    const untilText = _formatPremiumEndDate(status.remainingHours);
    const priceText = status.priceUsdcPerHour != null ? `${status.priceUsdcPerHour} USDC/h` : 'no data';
    const disableBtns = !status.activated || !status.pricingKnown;
    const disableReason = !status.activated ? 'Kein Aktivierungs-Token vorhanden.' : 'Preisliste noch nicht bekannt.';

    return `
        <div style="display:grid;grid-template-columns:auto 1fr;gap:0.3rem 1rem;font-size:0.85rem;margin-bottom:0.8rem">
            <span style="color:var(--text-muted)">Aktueller Status</span>
            <span>${status.enabled ? 'Premium Service aktiviert' : 'Premium Service deaktiviert'}</span>
            <span style="color:var(--text-muted)">SOL Guthaben</span>
            <span>${status.solBalance != null ? status.solBalance.toFixed(4) : 'no data'} SOL</span>
            <span style="color:var(--text-muted)">USDC Guthaben</span>
            <span>${status.usdcBalance != null ? status.usdcBalance.toFixed(2) : 'no data'} USDC</span>
            <span style="color:var(--text-muted)">Kosten pro Stunde</span>
            <span>${_esc(priceText)}</span>
            <span style="color:var(--text-muted)">Reicht bis zum</span>
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
                ${disableBtns ? `data-tooltip-title="Noch nicht möglich" data-tooltip-content="${_esc(disableReason)}"` : ''}>
                Aktivieren
            </button>
            <button class="btn btn-secondary btn-uniform" id="premium-btn-disable"
                ${disableBtns || !status.enabled ? 'disabled' : ''}
                ${disableBtns ? `data-tooltip-title="Noch nicht möglich" data-tooltip-content="${_esc(disableReason)}"` : ''}>
                Deaktivieren
            </button>
        </div>
        <div class="modal-feedback" id="premium-modal-feedback"></div>`;
}

function _premiumExplainerHtml() {
    return `
        <p style="margin:0 0 0.6rem;">
            Der Premium-Service verbindet diesen Bot mit dem FORGE.pub-Datendienst: automatisch
            geprüfte neue Pool-Angebote (Adresse, Token, Fee-Tier gegen die Chain verifiziert),
            laufendes Marktscoring/Scanner-Daten für die Poolbewertung sowie priorisierter
            Support-Kontakt.
        </p>
        <p style="margin:0 0 0.6rem;color:var(--text-muted);">
            Die Kosten werden stündlich automatisch aus dem hier hinterlegten Premium-Wallet
            beglichen (getrennt vom Bot-Kapital) — solange Guthaben reicht und der Service unten
            aktiviert ist.
        </p>
        <p style="margin:0;color:var(--text-muted);">
            Dieser Premium-Service ist speziell auf den Liquidity Bot zugeschnitten und wird
            unabhängig von anderen Bots verwaltet und bezahlt.
        </p>`;
}

async function _openPremiumModal() {
    const mid = 'liquiditybot-premium-modal';
    let status;
    try {
        status = await _fetchPremiumStatus();
    } catch (err) {
        _ctx.showToast?.(`Premium-Status nicht ladbar: ${err.message}`, 'error');
        return;
    }
    if (!status.available) return; // Master, oder Fork ohne Premium-Wallet

    showModal({
        id: mid,
        title: 'Premium Service verwalten',
        body: `
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-wm="settings">Einstellungen</button>
                <button class="wm-tab" data-wm="explain">Erklärung</button>
            </div>
            <div id="premium-tab-settings" style="min-height:220px;">${_premiumTabPanelHtml(status)}</div>
            <div id="premium-tab-explain" style="min-height:220px;font-size:0.85rem;" hidden>${_premiumExplainerHtml()}</div>`,
        actions: [
            { label: 'Schließen', onClick: () => closeModal(mid) },
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
            if (fb) { fb.textContent = 'Bitte warten…'; fb.className = 'modal-feedback'; }
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
                            ? 'Premium Service aktiviert – erste Zahlung gesendet, Daten sind in Kürze aktuell'
                            : `Premium Service aktiviert. Hinweis zur ersten Zahlung: ${data.immediatePayment.error}`,
                        data.immediatePayment.ok ? 'success' : 'info'
                    );
                } else {
                    _ctx.showToast?.(data.enabled ? 'Premium Service aktiviert' : 'Premium Service deaktiviert', 'success');
                }
                await _refreshPremiumBadge();
                await _openPremiumModal(); // Modal mit frischem Status neu aufbauen
            } catch (err) {
                if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
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
        text.innerHTML   = status.enabled ? '&#10003; Aktiv' : '&#9888; Inaktiv';
        text.className   = 'key-status ' + (status.enabled ? 'set' : 'unset');
    } catch { /* Text bleibt wie zuletzt bekannt */ }
}

// ── Neue Pool-Angebote (Premium-Datendienst, Klasse C) ────────────────────────
//
// Übernehmen != Kapitalfreigabe: "Übernehmen" macht den Pool nur bekannt
// (enabled:false, kein Cleanup-Reinvest). Der Bot investiert dabei nie automatisch
// Kapital — die Freigabe läuft danach über denselben "Pool aktivieren"-Weg wie bei
// jedem anderen Pool. Drei Zustände sichtbar: angeboten (hier) / übernommen+gesperrt
// (erscheint dann in der normalen Pool-Liste, deaktiviert) / aktiv (Nutzer hat
// separat freigegeben).

const STATUS_LABEL = {
    verified:    { text: 'Geprüft',           icon: '✅' },
    unsupported: { text: 'Nicht unterstützt', icon: '⚠️' },
    rejected:    { text: 'Abgelehnt',         icon: '❌' },
};

async function _renderPoolOffers(el) {
    el.innerHTML = '';
    let offers;
    try {
        const res = await fetch('/api/pools/liquidity/pool-offers');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        offers = (data.offers ?? []).filter(o => !o.alreadyKnown);
    } catch (err) {
        // Premium evtl. nicht aktiv oder noch nie geliefert — kein Fehlerzustand,
        // die Karte bleibt einfach weg (kein "kaputt" wirkender leerer Kasten).
        return;
    }
    if (offers.length === 0) return;

    const card = document.createElement('div');
    card.className = 'settings-card';
    card.innerHTML = `
        <div class="settings-card-header">
            <span class="sch-title">Neue Pool-Angebote &#128081;</span>
            <span class="sch-meta">${offers.length} verfügbar</span>
        </div>
        <p style="margin:0 0 0.6rem;color:var(--text-muted);font-size:0.82rem">
            Vom Premium-Datendienst geprüfte Pools, die dieser Bot noch nicht kennt.
            Übernehmen macht den Pool nur bekannt — es wird dabei nie Kapital investiert.
        </p>
        <div class="pool-offers-list"></div>`;
    el.appendChild(card);

    const list = card.querySelector('.pool-offers-list');
    for (const offer of offers) {
        const st = STATUS_LABEL[offer.status] ?? { text: offer.status, icon: '?' };
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
            + 'padding:0.5rem 0;border-top:1px solid var(--border-subtle,#2a3441)';
        row.innerHTML = `
            <span>
                <strong>${_esc(offer.display.displayPair ?? offer.id)}</strong>
                <span style="color:var(--text-muted);font-size:0.8rem"> · ${_esc(offer.display.protocol ?? '')}</span>
            </span>
            <span style="display:flex;align-items:center;gap:0.6rem">
                <span class="status-badge ${offer.status === 'verified' ? 'active' : offer.status === 'unsupported' ? 'unknown' : 'inactive'}">
                    ${st.icon} ${st.text}${offer.acceptedException ? ' (Ausnahme akzeptiert)' : ''}
                </span>
                <button class="btn btn-secondary btn-uniform" data-offer-details>Details</button>
            </span>`;
        row.querySelector('[data-offer-details]')
            .addEventListener('click', () => _openAdoptOfferModal(offer, el));
        list.appendChild(row);
    }
}

function _renderOfferChecks(checks) {
    if (!checks?.length) return '';
    const rows = checks.map(c => `
        <tr>
            <td style="padding:2px 8px 2px 0">${c.match ? '✓' : '✗'} ${_esc(c.field)}</td>
            <td style="padding:2px 8px;color:var(--text-muted)">${_esc(JSON.stringify(c.expected))}</td>
            <td style="padding:2px 0;color:${c.match ? 'var(--text-muted)' : 'var(--danger)'}">${_esc(JSON.stringify(c.actual))}${c.error ? ` (${_esc(c.error)})` : ''}</td>
        </tr>`).join('');
    return `
        <div style="margin-top:0.6rem">
            <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:2px">Prüfergebnisse (gegen die Chain verifiziert):</div>
            <table style="font-size:0.8rem;border-collapse:collapse">
                <tr style="color:var(--text-muted)"><th style="text-align:left;padding-right:8px">Feld</th><th style="text-align:left;padding-right:8px">Erwartet</th><th style="text-align:left">Tatsächlich</th></tr>
                ${rows}
            </table>
        </div>`;
}

function _renderOfferTokenInfo(tokenInfo) {
    const entries = Object.values(tokenInfo ?? {});
    if (entries.length === 0) return '';
    const items = entries.map(t => `
        <div style="margin-top:4px">
            <strong>${_esc(t.symbol ?? '?')}</strong>
            <span style="color:var(--text-muted)"> — ${_esc(t.category ?? '')}</span>
            <div style="color:var(--text-muted);font-size:0.8rem">${_esc(t.description ?? '')}</div>
        </div>`).join('');
    return `<div style="margin-top:0.6rem"><div style="font-size:0.8rem;color:var(--text-muted)">Token-Infos:</div>${items}</div>`;
}

function _openAdoptOfferModal(offer, containerEl) {
    const mid = 'liquiditybot-adopt-offer';
    const name = _esc(offer.display.displayPair ?? offer.id);
    const canAdopt = offer.status === 'verified';

    const rationale = offer.unprovable?.rationale;
    const rationaleHtml = rationale
        ? `<div style="margin-top:0.6rem;font-size:0.82rem;color:var(--text-muted)">
             Warum vorgeschlagen: Fees 24h ≈ ${rationale.fees24hUsd != null ? rationale.fees24hUsd.toFixed(2) : 'no data'} USDC,
             TVL ≈ ${rationale.tvlUsd != null ? Math.round(rationale.tvlUsd).toLocaleString('de-DE') : 'no data'} USDC,
             beobachtet seit ${rationale.observedDays ?? 'no data'} Tagen.
             Nicht on-chain prüfbar — reine Einschätzung des Datendienstes.
           </div>`
        : '';

    const acceptedHtml = offer.acceptedException
        ? `<div style="margin-top:0.6rem;padding:0.5rem;background:rgba(234,179,8,0.1);border-radius:6px;font-size:0.82rem">
             ⚠️ Dieser Pool löst ein technisches Abbruchkriterium aus (Token-2022 und/oder
             adaptive Gebühren), wurde aber ausdrücklich als Ausnahme freigegeben:
             <div style="margin-top:4px;color:var(--text-muted)">${_esc(offer.acceptedReason ?? '')}</div>
           </div>`
        : '';

    const statusHtml = !canAdopt
        ? `<div style="margin-top:0.6rem;padding:0.5rem;background:rgba(239,68,68,0.1);border-radius:6px;font-size:0.82rem">
             ${offer.status === 'rejected'
                ? '❌ Mindestens ein gelieferter Wert stimmt nicht mit der Chain überein. Dieser Pool kann nicht übernommen werden.'
                : '⚠️ Dieser Pool erfüllt ein technisches Abbruchkriterium ohne akzeptierte Ausnahme und wird nicht unterstützt.'}
           </div>`
        : '';

    const body = `
        <p style="margin:0 0 0.4rem"><strong>${name}</strong> · ${_esc(offer.display.protocol ?? '')}</p>
        <p style="margin:0;color:var(--text-muted);font-size:0.85rem">
            Übernehmen macht diesen Pool im Bot bekannt (deaktiviert, kein Cleanup-Reinvest).
            <strong>Es wird dabei kein Kapital investiert.</strong> Freigeben für echtes Kapital
            geschieht danach separat über "Pool aktivieren", genau wie bei jedem anderen Pool.
        </p>
        ${statusHtml}
        ${acceptedHtml}
        ${_renderOfferChecks(offer.checks)}
        ${_renderOfferTokenInfo(offer.display.tokenInfo)}
        ${rationaleHtml}
        <div id="adopt-feedback" style="margin-top:0.6rem;font-size:0.82rem"></div>`;

    const doAdopt = async () => {
        const modalEl = getModal(mid);
        const fb = modalEl?.querySelector('#adopt-feedback');
        const btns = modalEl?.querySelectorAll('.forge-modal-footer button') ?? [];
        btns.forEach(b => { b.disabled = true; });
        if (fb) { fb.style.color = 'var(--text-muted)'; fb.textContent = 'Wird übernommen…'; }
        try {
            const res = await fetch(`/api/pools/liquidity/pool-offers/${encodeURIComponent(offer.id)}/adopt`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

            closeModal(mid);
            _ctx.showToast?.(`${name} übernommen — noch kein Kapital investiert, Freigabe separat über "Pool aktivieren".`, 'success');
            _render();
        } catch (err) {
            if (fb) { fb.style.color = 'var(--danger)'; fb.textContent = `Fehler: ${err.message}`; }
            btns.forEach(b => { b.disabled = false; });
        }
    };

    const actions = canAdopt
        ? [{ label: 'Übernehmen (kein Kapital)', onClick: doAdopt }, { label: 'Abbrechen', onClick: () => closeModal(mid) }]
        : [{ label: 'Schließen', onClick: () => closeModal(mid) }];

    showModal({ id: mid, title: 'Pool-Angebot prüfen', body, actions });
}

// ── Service-Karte (inkl. Cleanup) ─────────────────────────────────────────────

async function _renderService(el) {
    const card = document.createElement('div');
    card.className = 'settings-card';
    card.innerHTML = `
        <div class="settings-card-header">
            <span class="sch-title">Liquidity Bot</span>
        </div>
        <table class="wallet-action-table">
            <tbody>
                <tr>
                    <td class="wat-label">Status</td>
                    <td class="wat-info">
                        <span class="key-status" id="liquiditybot-status-text">laden…</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="liquiditybot-btn-status-manage">Verwalten</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label">Premium &#128081;</td>
                    <td class="wat-info">
                        <span class="key-status" id="liquiditybot-premium-text">laden…</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="liquiditybot-btn-premium">Verwalten</button>
                    </td>
                </tr>
            </tbody>
        </table>
        <div id="liquiditybot-cleanup-wrap"></div>`;
    el.appendChild(card);

    const cachedStatus = _ctx.getStatus?.(SVC_ID);
    if (cachedStatus) _applyStatus(cachedStatus);
    _refreshPremiumBadge();

    card.querySelector('#liquiditybot-btn-status-manage')?.addEventListener('click', () => _openBotControlModal());
    card.querySelector('#liquiditybot-btn-premium')?.addEventListener('click', () => _openPremiumModal());

    const cleanupWrap = card.querySelector('#liquiditybot-cleanup-wrap');
    try {
        if (cleanupWrap) await _loadAndRenderCleanupRow(cleanupWrap);
    } catch { /* Config nicht verfügbar */ }
}

function _openBotControlModal() {
    const mid = 'liquiditybot-control-modal';
    showModal({
        id: mid,
        title: 'Liquidity Bot verwalten',
        body: `
            <div class="bcm-row">
                <button class="btn btn-secondary btn-uniform" id="liquiditybot-btn-start">&#9654; Start</button>
                <span class="bcm-hint">Startet den Bot, falls er aktuell gestoppt ist.</span>
            </div>
            <div class="bcm-row">
                <button class="btn btn-secondary btn-uniform" id="liquiditybot-btn-stop">&#9632; Stop</button>
                <span class="bcm-hint">Stoppt den Bot vollständig. Offene Positionen bleiben unverändert bestehen.</span>
            </div>
            <div class="bcm-row">
                <button class="btn btn-secondary btn-uniform" id="liquiditybot-btn-restart">&#8635; Restart</button>
                <span class="bcm-hint">Stoppt und startet den Bot neu, z.&nbsp;B. nach einer Konfigurationsänderung.</span>
            </div>
            <div class="task-status" id="liquiditybot-task-status"></div>`,
        actions: [
            { label: 'Schließen', onClick: () => closeModal(mid) },
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

function _parseCleanupCfg(cfg) {
    const mode       = _parseCleanupMode(cfg);
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
    return { mode, minScore, maxDeposit, minDeposit, dustEnabled, dustMin, dustMax };
}

async function _loadAndRenderCleanupRow(wrap) {
    const [cfgRes, poolsRes] = await Promise.all([
        fetch('/api/config/liquiditybot'),
        fetch(`/api/pools/liquidity?t=${Date.now()}`),
    ]);
    if (!cfgRes.ok) throw new Error('Config nicht verfügbar');
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
    const botInactive = _ctx.getStatus?.(SVC_ID) !== 'active';
    wrap.innerHTML = `
        <table class="wallet-action-table">
            <tbody>
                <tr>
                    <td class="wat-label">Cleanup</td>
                    <td class="wat-info">${_esc(_cleanupModeSummary(parsed, pools))}</td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="sys-cleanup-manage-btn" ${botInactive ? 'disabled' : ''}>Verwalten</button>
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
    const { mode, minScore, dustEnabled } = parsed;
    let base;
    if (mode === 'ranking') {
        base = `Bester Pool · Score ≥ ${minScore}`;
    } else if (mode === 'disabled') {
        base = 'Deaktiviert';
    } else if (mode?.startsWith('pool:')) {
        const id = mode.slice('pool:'.length);
        const p  = pools.find(pp => String(pp.id) === id);
        base = `Manuell: ${p ? (p.displayPair ?? p.pair) : 'gewählter Pool'}`;
    } else {
        base = 'Unbekannt';
    }
    return `${base} · Dust ${dustEnabled ? 'aktiv' : 'aus'}`;
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
        title: 'Cleanup verwalten',
        body:  `
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-wm="manuell">Manuell</button>
                <button class="wm-tab" data-wm="bester">Bester Pool</button>
                <button class="wm-tab" data-wm="dust">Dust</button>
            </div>
            <div id="cu-tab-manuell">${_manuellTabHtml(cfgParsed, pools)}</div>
            <div id="cu-tab-bester" hidden>${_besterPoolTabHtml(cfgParsed, pools, premiumLocked)}</div>
            <div id="cu-tab-dust" hidden>${_dustTabHtml(cfgParsed)}</div>`,
        actions: [
            { label: 'Schließen', onClick: () => closeModal(mid) },
        ],
    });

    const modalEl = getModal(mid);
    if (!modalEl) return;

    modalEl.querySelectorAll('.wm-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            modalEl.querySelectorAll('.wm-tab').forEach(b => b.classList.toggle('active', b === btn));
            modalEl.querySelector('#cu-tab-manuell').hidden = btn.dataset.wm !== 'manuell';
            modalEl.querySelector('#cu-tab-bester').hidden  = btn.dataset.wm !== 'bester';
            modalEl.querySelector('#cu-tab-dust').hidden    = btn.dataset.wm !== 'dust';
        });
    });

    _wireManuellTab(modalEl, mid, wrap);
    _wireBesterPoolTab(modalEl, mid, wrap, pools);
    _wireDustTab(modalEl, mid, wrap);
}

// ── Tab "Manuell": sofort in einen gewählten Pool investieren ───────────────
function _manuellTabHtml(cfgParsed, pools) {
    const { mode } = cfgParsed;
    const sortedPools = pools
        .slice()
        .sort((a, b) => (a.displayPair ?? a.pair).localeCompare(b.displayPair ?? b.pair));

    return `
        ${_cuDescHtml(
            'Investiert das Wallet-Guthaben gezielt in einen von dir gewählten Pool.',
            'Manuell',
            'Investiert das gesamte investierbare Wallet-Guthaben einmalig in den hier gewählten Pool – unabhängig vom Opportunity Score. Dieser Pool wird damit zum neuen Cleanup-Ziel, bis du hier oder im Reiter „Bester Pool" etwas anderes wählst.'
        )}
        <div style="display:flex;gap:0.4rem;margin-bottom:0.4rem;">
            <input type="text" id="cu-manuell-search" placeholder="Pool suchen…"
                   style="flex:1;min-width:0;box-sizing:border-box;padding:0.3rem 0.5rem;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:5px;font-size:0.875rem">
            <select id="cu-manuell-active-filter"
                    style="flex-shrink:0;box-sizing:border-box;padding:0.3rem 0.5rem;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:5px;font-size:0.875rem">
                <option value="all">Alle</option>
                <option value="active">Aktiv</option>
                <option value="inactive">Inaktiv</option>
            </select>
        </div>
        <div id="cu-manuell-list" class="cu-panel-body" style="max-height:14rem;overflow-y:auto;display:flex;flex-direction:column;gap:0.2rem;padding-bottom:0.25rem;">
            ${sortedPools.map(p => `
            <label class="cleanup-radio-option" data-cu-pool="${_esc(p.displayPair ?? p.pair).toLowerCase()}" data-cu-active="${p.active ? '1' : '0'}">
                <input type="radio" name="cleanup-mode-pool" value="pool:${p.id}" ${mode === 'pool:' + p.id ? 'checked' : ''}>
                <span${p.active ? '' : ' style="opacity:0.55;font-style:italic;"'}>Invest in ${_esc(p.displayPair ?? p.pair)}${p.active ? '' : ' (inaktiv)'}</span>
            </label>`).join('')}
        </div>
        <div class="bot-actions" style="margin-top:0.6rem;">
            <button class="btn btn-secondary btn-uniform" id="cu-manuell-start-btn">Jetzt starten</button>
        </div>
        <div class="modal-feedback" id="cu-manuell-feedback"></div>`;
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
function _bestPoolHtml(bestPool, bestScore, bestName, threshold) {
    if (!bestPool || bestScore == null)
        return `<span style="color:var(--text-muted)">— Keine Score-Daten verfügbar</span>`;
    const ok    = bestScore >= threshold;
    const color = ok ? 'var(--success)' : 'var(--danger)';
    const icon  = ok ? '✓' : '✗';
    const hint  = ok ? '' : `<br><span style="color:var(--text-muted);font-size:0.78rem">Minimum ${threshold} nicht erreicht → kein Investment</span>`;
    return `<span style="color:var(--text)">${bestName}</span> — Score <strong style="color:${color}">${bestScore}</strong> <span style="color:${color}">${icon}</span>${hint}`;
}

function _besterPoolTabHtml(cfgParsed, pools, premiumLocked) {
    const desc = _cuDescHtml(
        'Automatischer, wiederkehrender Invest in den Pool mit dem höchsten Opportunity Score.',
        'Bester Pool',
        'Läuft zu jeder vollen Stunde: investiert das Wallet-Guthaben automatisch in den Pool mit dem höchsten Opportunity Score – sofern dieser die Minimum-Score-Schwelle erreicht. Steht nur mit aktiviertem Premium-Service zur Verfügung (Opportunity Score wird zentral berechnet).'
    );

    if (premiumLocked) {
        return `${desc}
            <p class="modal-hint" style="margin:0;">
                Nur mit aktiviertem Premium-Service verfügbar (Opportunity Score wird zentral berechnet).
            </p>`;
    }

    const { mode, minScore, maxDeposit, minDeposit } = cfgParsed;
    const bestPool  = pools
        .slice()
        .sort((a, b) => (b.investScore?.value ?? -Infinity) - (a.investScore?.value ?? -Infinity))[0] ?? null;
    const bestScore = bestPool?.investScore?.value ?? null;
    const bestName  = bestPool ? _esc(bestPool.displayPair ?? bestPool.pair) : null;

    return `
        ${desc}
        ${_cleanupHint(mode)}
        <div class="cu-panel-body" style="display:flex;flex-direction:column;gap:0.6rem">
            <label class="cleanup-radio-option">
                <input type="radio" name="cleanup-mode-ranking" value="ranking" ${mode === 'ranking' ? 'checked' : ''}>
                <span>Bester Pool <small style="opacity:0.7;">— investiert in den Pool mit dem höchsten InvestScore</small></span>
            </label>
            <label class="cleanup-radio-option">
                <input type="radio" name="cleanup-mode-ranking" value="disabled" ${mode === 'disabled' ? 'checked' : ''}>
                <span>Deaktiviert</span>
            </label>
            <div style="border-top:1px solid var(--border);padding-top:0.6rem">
                <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;color:var(--text-muted)">Minimum-Score (0–100)</label>
                <input type="number" id="cu-bester-min-score" min="0" max="100" value="${minScore}"
                       style="width:80px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                <p style="margin:0.3rem 0 0;font-size:0.76rem;color:var(--text-muted)">
                    50 = neutral &nbsp;·&nbsp; <strong>65 = empfohlen</strong> &nbsp;·&nbsp; 75 = konservativ
                </p>
            </div>
            <div style="border-top:1px solid var(--border);padding-top:0.6rem;display:flex;gap:1rem;">
                <div style="flex:1">
                    <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;color:var(--text-muted)">
                        Min. Einzahlung/Lauf
                        <span class="info-tip-label"
                            data-tooltip-title="Minimale Einzahlung"
                            data-tooltip-content="Cleanup investiert nur wenn mindestens dieser Betrag an investierbarem USDC-Gegenwert im Wallet liegt.||Beispiel: Minimum 10 USDC, im Wallet liegen nur 9 USDC Gegenwert → es passiert nichts.||Leer lassen oder 0 = kein Minimum.">&#9432;</span>
                    </label>
                    <div style="display:flex;align-items:center;gap:0.4rem;">
                        <input type="number" id="cu-bester-min-deposit" min="1" max="10000" step="1"
                               value="${minDeposit > 0 ? minDeposit : ''}" placeholder="kein Minimum"
                               style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                        <span style="font-size:0.8rem;color:var(--text-muted)">USDC</span>
                    </div>
                </div>
                <div style="flex:1">
                    <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;color:var(--text-muted)">
                        Max. Einzahlung/Lauf
                        <span class="info-tip-label"
                            data-tooltip-title="Maximale Einzahlung"
                            data-tooltip-content="Begrenzt wie viel USDC pro Cleanup-Lauf in den besten Pool investiert werden darf.||Beispiel: 2.350 USDC im Wallet, Limit 500 USDC → pro Lauf werden max. 500 USDC eingezahlt; der Rest bleibt liquide.||Leer lassen oder 0 = kein Limit.">&#9432;</span>
                    </label>
                    <div style="display:flex;align-items:center;gap:0.4rem;">
                        <input type="number" id="cu-bester-max-deposit" min="10" max="10000" step="10"
                               value="${maxDeposit > 0 ? maxDeposit : ''}" placeholder="kein Limit"
                               style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                        <span style="font-size:0.8rem;color:var(--text-muted)">USDC</span>
                    </div>
                </div>
            </div>
            <p style="margin:-0.3rem 0 0;font-size:0.74rem;color:var(--text-muted)">10–10.000 bzw. 1–10.000 USDC &nbsp;·&nbsp; leer = kein Limit/Minimum</p>
            <div style="border-top:1px solid var(--border);padding-top:0.6rem">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:0.4rem">Aktuell bester Pool</div>
                <div id="cu-bester-best-pool-row">${_bestPoolHtml(bestPool, bestScore, bestName, minScore)}</div>
            </div>
        </div>
        <div class="bot-actions" style="margin-top:0.6rem;">
            <button class="btn btn-secondary btn-uniform" id="cu-bester-save-btn">Speichern</button>
        </div>
        <div class="modal-feedback" id="cu-bester-feedback"></div>`;
}

function _wireBesterPoolTab(modalEl, mid, wrap, pools) {
    const bestPool  = pools
        .slice()
        .sort((a, b) => (b.investScore?.value ?? -Infinity) - (a.investScore?.value ?? -Infinity))[0] ?? null;
    const bestScore = bestPool?.investScore?.value ?? null;
    const bestName  = bestPool ? _esc(bestPool.displayPair ?? bestPool.pair) : null;

    const minScoreInput = modalEl.querySelector('#cu-bester-min-score');
    const bestRow       = modalEl.querySelector('#cu-bester-best-pool-row');
    if (minScoreInput && bestRow) {
        minScoreInput.addEventListener('input', () => {
            const t = Math.max(0, Math.min(100, parseInt(minScoreInput.value, 10) || 0));
            bestRow.innerHTML = _bestPoolHtml(bestPool, bestScore, bestName, t);
        });
    }

    // Validierung: Minimale Einzahlung darf die Maximale nicht überschreiten –
    // sonst Speichern sperren, statt eine widersprüchliche Config zuzulassen.
    const minDepositInput = modalEl.querySelector('#cu-bester-min-deposit');
    const maxDepositInput = modalEl.querySelector('#cu-bester-max-deposit');
    const fb              = modalEl.querySelector('#cu-bester-feedback');
    const saveBtn         = modalEl.querySelector('#cu-bester-save-btn');
    const _validateDepositRange = () => {
        const minVal    = parseFloat(minDepositInput?.value ?? '');
        const maxVal    = parseFloat(maxDepositInput?.value ?? '');
        const conflict  = Number.isFinite(minVal) && minVal > 0 && Number.isFinite(maxVal) && maxVal > 0 && minVal > maxVal;
        if (saveBtn) saveBtn.disabled = conflict;
        if (fb) {
            if (conflict) { fb.textContent = 'Minimale Einzahlung darf nicht größer als die Maximale sein.'; fb.className = 'modal-feedback error'; }
            else if (fb.classList.contains('error')) { fb.textContent = ''; fb.className = 'modal-feedback'; }
        }
    };
    minDepositInput?.addEventListener('input', _validateDepositRange);
    maxDepositInput?.addEventListener('input', _validateDepositRange);
    _validateDepositRange();

    saveBtn?.addEventListener('click', () => _saveBesterPool(mid, wrap));
}

// ── Tab "Dust": Dust-Sweep an/aus + Grenzwerte konfigurieren ─────────────────
function _dustTabHtml(cfgParsed) {
    const { mode, dustEnabled, dustMin, dustMax } = cfgParsed;
    return `
        ${_cuDescHtml(
            'Tauscht kleine Token-Reste am Ende jedes Cleanup-Laufs automatisch zu USDC.',
            'Dust',
            'Nach jedem Cleanup-Lauf bleiben oft kleine Reste bekannter Pool-Token im Wallet zurück (z. B. nach einem Swap nicht exakt aufgehende Beträge). Der Dust-Sweep tauscht diese Reste automatisch zu USDC, damit sie nicht ungenutzt liegen bleiben. Unter- und Obergrenze bestimmen, welcher Gegenwert als „Dust" zählt.'
        )}
        ${_cleanupHint(mode)}
        <div class="cu-panel-body" style="display:flex;flex-direction:column;gap:0.6rem">
            <label class="cleanup-radio-option">
                <input type="radio" name="cleanup-dust-mode" value="on" ${dustEnabled ? 'checked' : ''}>
                <span>Aktivieren</span>
            </label>
            <label class="cleanup-radio-option">
                <input type="radio" name="cleanup-dust-mode" value="off" ${!dustEnabled ? 'checked' : ''}>
                <span>Deaktivieren</span>
            </label>
            <div style="border-top:1px solid var(--border);padding-top:0.6rem;display:flex;gap:1rem;">
                <div style="flex:1">
                    <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;color:var(--text-muted)">Untergrenze</label>
                    <div style="display:flex;align-items:center;gap:0.4rem;">
                        <input type="number" id="cu-dust-min" min="0" step="0.01" value="${dustMin}"
                               style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                        <span style="font-size:0.8rem;color:var(--text-muted)">USDC</span>
                    </div>
                </div>
                <div style="flex:1">
                    <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.3rem;color:var(--text-muted)">Obergrenze</label>
                    <div style="display:flex;align-items:center;gap:0.4rem;">
                        <input type="number" id="cu-dust-max" min="0" step="0.5" value="${dustMax}"
                               style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                        <span style="font-size:0.8rem;color:var(--text-muted)">USDC</span>
                    </div>
                </div>
            </div>
            <p style="margin:-0.3rem 0 0;font-size:0.76rem;color:var(--text-muted)">
                Reste in diesem Bereich werden nach jedem Cleanup automatisch zu USDC getauscht.
                Darunter: vernachlässigbar, bleibt liegen. Darüber: bleibt liegen, regulärer Invest folgt.
            </p>
        </div>
        <div class="bot-actions" style="margin-top:0.6rem;">
            <button class="btn btn-secondary btn-uniform" id="cu-dust-save-btn">Speichern</button>
        </div>
        <div class="modal-feedback" id="cu-dust-feedback"></div>`;
}

function _wireDustTab(modalEl, mid, wrap) {
    const dustMinInput = modalEl.querySelector('#cu-dust-min');
    const dustMaxInput = modalEl.querySelector('#cu-dust-max');
    const fb           = modalEl.querySelector('#cu-dust-feedback');
    const saveBtn      = modalEl.querySelector('#cu-dust-save-btn');
    const _validateDustRange = () => {
        const minVal   = parseFloat(dustMinInput?.value ?? '');
        const maxVal   = parseFloat(dustMaxInput?.value ?? '');
        const conflict = Number.isFinite(minVal) && Number.isFinite(maxVal) && minVal >= maxVal;
        if (saveBtn) saveBtn.disabled = conflict;
        if (fb) {
            if (conflict) { fb.textContent = 'Untergrenze muss kleiner als die Obergrenze sein.'; fb.className = 'modal-feedback error'; }
            else if (fb.classList.contains('error')) { fb.textContent = ''; fb.className = 'modal-feedback'; }
        }
    };
    dustMinInput?.addEventListener('input', _validateDustRange);
    dustMaxInput?.addEventListener('input', _validateDustRange);
    _validateDustRange();

    saveBtn?.addEventListener('click', () => _saveDust(mid, wrap));
}

// ── "Manuell": sofort in den gewählten Pool investieren ──────────────────────
async function _runCleanupManuell(mid, wrap) {
    const fb       = document.getElementById('cu-manuell-feedback');
    const selected = document.querySelector('input[name="cleanup-mode-pool"]:checked');
    if (!selected) {
        if (fb) { fb.textContent = 'Bitte einen Pool wählen.'; fb.className = 'modal-feedback error'; }
        return;
    }

    if (fb) { fb.textContent = 'Speichere Modus…'; fb.className = 'modal-feedback'; }
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

        if (fb) { fb.textContent = 'Cleanup läuft… (kann bis zu 5 min dauern)'; fb.className = 'modal-feedback'; }
        const runRes = await fetch('/api/pools/liquidity/cleanup/run', { method: 'POST' });
        const data   = await runRes.json().catch(() => ({}));

        if (runRes.ok && data.ok) {
            if (fb) { fb.textContent = '✓ Cleanup erfolgreich abgeschlossen.'; fb.className = 'modal-feedback success'; }
            _ctx.showToast?.('Cleanup erfolgreich', 'success');
            const walletEl = _container?.querySelector('.liquiditybot-grid-wallet');
            const poolsEl  = _container?.querySelector('.liquiditybot-grid-pools');
            if (walletEl) _renderWallet(walletEl);
            if (poolsEl)  _renderPools(poolsEl);
        } else {
            const msg = data.error ?? data.log?.find(l => l.level === 'error')?.msg ?? `HTTP ${runRes.status}`;
            throw new Error(msg);
        }
    } catch (err) {
        if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
        _ctx.showToast?.(`Cleanup: ${err.message}`, 'error');
    } finally {
        btns.forEach(b => { b.disabled = false; });
    }
}

// ── "Bester Pool": Ranking-Modus (oder Deaktiviert) speichern ────────────────
async function _saveBesterPool(mid, wrap) {
    const fb       = document.getElementById('cu-bester-feedback');
    const selected = document.querySelector('input[name="cleanup-mode-ranking"]:checked');
    if (!selected) {
        if (fb) { fb.textContent = 'Bitte eine Option wählen.'; fb.className = 'modal-feedback error'; }
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

    if (minDepositVal > 0 && maxDepositVal > 0 && minDepositVal > maxDepositVal) {
        if (fb) { fb.textContent = 'Minimale Einzahlung darf nicht größer als die Maximale sein.'; fb.className = 'modal-feedback error'; }
        return;
    }

    if (fb) { fb.textContent = 'Speichere…'; fb.className = 'modal-feedback'; }
    try {
        const res = await fetch('/api/config/liquiditybot', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                CLEANUP_MODE:        selected.value,
                CLEANUP_MIN_SCORE:   String(minScoreVal),
                CLEANUP_MAX_DEPOSIT: String(maxDepositVal),
                CLEANUP_MIN_DEPOSIT: String(minDepositVal),
            }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        if (fb) { fb.textContent = '✓ Cleanup gespeichert.'; fb.className = 'modal-feedback success'; }
        _ctx.showToast?.('Cleanup gespeichert', 'success');
        await _loadAndRenderCleanupRow(wrap);
    } catch (err) {
        if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
    }
}

// ── "Dust": Dust-Sweep an/aus + Grenzwerte speichern ─────────────────────────
async function _saveDust(mid, wrap) {
    const fb       = document.getElementById('cu-dust-feedback');
    const selected = document.querySelector('input[name="cleanup-dust-mode"]:checked');
    if (!selected) return;
    const minEl  = document.getElementById('cu-dust-min');
    const maxEl  = document.getElementById('cu-dust-max');
    const minVal = parseFloat(minEl?.value ?? '0.01');
    const maxVal = parseFloat(maxEl?.value ?? '25');

    if (!Number.isFinite(minVal) || minVal < 0 || !Number.isFinite(maxVal) || maxVal <= 0 || minVal >= maxVal) {
        if (fb) { fb.textContent = 'Untergrenze muss kleiner als die Obergrenze sein (beide ≥ 0).'; fb.className = 'modal-feedback error'; }
        return;
    }

    if (fb) { fb.textContent = 'Speichere…'; fb.className = 'modal-feedback'; }
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
        if (fb) { fb.textContent = '✓ Dust-Einstellungen gespeichert.'; fb.className = 'modal-feedback success'; }
        _ctx.showToast?.('Dust-Einstellungen gespeichert', 'success');
    } catch (err) {
        if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
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
    const canStop    = status === 'active'   || status === 'failed';
    const canRestart = status === 'active'   || status === 'failed';

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
        if (taskEl) { taskEl.textContent = `Fehler: ${err.message}`; taskEl.className = 'task-status failed'; }
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
                const msg = task.error ?? 'Unbekannter Fehler';
                if (taskEl) { taskEl.textContent = `❌ ${msg}`; taskEl.className = 'task-status failed'; }
                _ctx.showToast?.(`LMBot: ${msg}`, 'error');
                return;
            }
            if (taskEl) { taskEl.textContent = `${task.status}…`; }
        } catch { /* ignorieren, weiter warten */ }
    }
    if (taskEl) { taskEl.textContent = 'Timeout – kein Ergebnis'; taskEl.className = 'task-status failed'; }
}

// ── Wallet-Tab ─────────────────────────────────────────────────────────────────

// Datum/Uhrzeit + Minuten seit dem letzten Wallet-Monitor-Check (beide Wallets
// werden gemeinsam per monitor.js aktualisiert, siehe _refreshWalletMonitor).
function _formatLastCheck(ms) {
    if (!ms) return 'noch kein Check';
    const d      = new Date(ms);
    const dd     = String(d.getDate()).padStart(2, '0');
    const mo     = String(d.getMonth() + 1).padStart(2, '0');
    const hh     = String(d.getHours()).padStart(2, '0');
    const mi     = String(d.getMinutes()).padStart(2, '0');
    const ageMin = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return `${dd}.${mo}.${d.getFullYear()} ${hh}:${mi} Uhr (vor ${ageMin} Min.)`;
}

async function _refreshWalletMonitor(card, el) {
    const btn = card.querySelector('#wallet-btn-refresh-all');
    if (!btn || btn.disabled) return;
    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Aktualisiere…';
    try {
        const r = await fetch('/api/wallet/refresh-monitor', { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        _ctx.showToast?.('Wallet aktualisiert', 'success');
        await _renderWallet(el);
    } catch (err) {
        btn.disabled = false;
        btn.textContent = origLabel;
        _ctx.showToast?.(`Wallet-Update fehlgeschlagen: ${err.message}`, 'error');
    }
}

/**
 * status: { ok: boolean, tooltip: string } | null
 *   ok === true  → grüner Haken (genug SOL)
 *   ok === false → roter Kreuz + Tooltip (zu wenig SOL)
 *   null         → kein Haken/Kreuz, normale Textfarbe (z.B. Premium deaktiviert
 *                   oder noch keine SOL-Daten vorhanden)
 */
function _walletRowHtml(label, balance, status = null) {
    const amountText = balance?.recorded_at
        ? `${(balance.total_usd ?? 0).toFixed(2)} USDC`
        : '<span class="wat-muted">noch keine Daten – auf Aktualisieren klicken</span>';

    const infoHtml = (balance?.recorded_at && status)
        ? `<span class="key-status ${status.ok ? 'set' : 'crit'}"
                ${!status.ok ? `data-tooltip-title="Zu wenig SOL" data-tooltip-content="${_esc(status.tooltip)}"` : ''}>
                ${status.ok ? '&#10003;' : '&#10007;'} ${amountText}
           </span>`
        : amountText;

    return `
        <tr>
            <td class="wat-label">${_esc(label)}</td>
            <td class="wat-info">${infoHtml}</td>
            <td class="wat-action">
                <button class="btn btn-secondary btn-sm" data-wallet-manage-btn>Verwalten</button>
            </td>
        </tr>`;
}

async function _renderWallet(el) {
    el.innerHTML = '<div class="wallet-loading">Lade…</div>';
    try {
        const [infoRes, balRes, addrRes, premiumInfoRes] = await Promise.all([
            fetch('/api/wallet/liquidity/info'),
            fetch('/api/wallet/liquidity/balance'),
            fetch('/api/addresses'),
            fetch('/api/wallet/premium/info'),
        ]);
        if (!infoRes.ok) throw new Error(`Wallet-Info konnte nicht geladen werden (HTTP ${infoRes.status})`);
        if (!balRes.ok) throw new Error(`Wallet-Bestand konnte nicht geladen werden (HTTP ${balRes.status})`);
        if (!addrRes.ok) throw new Error(`Adressbuch konnte nicht geladen werden (HTTP ${addrRes.status})`);
        const info        = await infoRes.json();
        const balance      = await balRes.json();
        const addrs        = await addrRes.json();
        const premiumInfo  = premiumInfoRes.ok ? await premiumInfoRes.json() : { available: false };

        // Premium-Zeile nur wenn dieser Fork überhaupt ein Premium-Wallet hat
        // (Master oder Fork ohne Wallet → premiumInfo.available === false).
        let premiumBalance = null;
        let premiumEnabled = false;
        if (premiumInfo.available) {
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
            ? { ok: balance.sol > SOL_LOW_THRESHOLD_LIQUIDITY, tooltip: 'Zu wenig SOL im Wallet für den Betrieb des Bots.' }
            : null;
        // Kein Haken/Kreuz solange Premium deaktiviert ist — der Zustand ist dann
        // ohnehin irrelevant (siehe Wunsch: neutrale, weiße Darstellung).
        const premiumStatus = premiumEnabled && premiumBalance?.sol != null
            ? { ok: premiumBalance.sol > SOL_LOW_THRESHOLD_PREMIUM, tooltip: 'Zu wenig SOL im Premium-Wallet für die stündliche Zahlung.' }
            : null;

        el.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'settings-card';
        const lastCheckMs = Math.max(balance?.recorded_at ?? 0, premiumBalance?.recorded_at ?? 0) || null;
        card.innerHTML = `
            <div class="settings-card-header">
                <span class="sch-title">Wallet</span>
            </div>
            <table class="wallet-action-table">
                <tbody>
                    ${_walletRowHtml('Liquidity Bot', balance, liquidityStatus)}
                    ${premiumInfo.available ? _walletRowHtml('Premium Service', premiumBalance, premiumStatus) : ''}
                    <tr>
                        <td class="wat-label">Letzter Check</td>
                        <td class="wat-info">${_esc(_formatLastCheck(lastCheckMs))}</td>
                        <td class="wat-action">
                            <button class="btn btn-secondary btn-sm" id="wallet-btn-refresh-all">Aktualisieren</button>
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
            _openWalletManageModal('liquidity', el, freshInfo, freshBalance, freshAddrs);
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
                _openWalletManageModal('premium', el, freshInfo, freshBalance, freshAddrs);
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

// ── Kombiniertes Wallet-Modal: Guthaben / Senden / Empfangen / Private Key ───
function _openWalletManageModal(flavor, el, info, balance, addrs) {
    const mid   = `${flavor}-wallet-modal`;
    const title = flavor === 'premium' ? 'Premium-Wallet verwalten' : 'Wallet verwalten';
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
                <button class="wb-tab active" data-wb="guthaben">Guthaben</button>
                <button class="wb-tab" data-wb="senden">Senden</button>
                <button class="wb-tab" data-wb="empfangen">Empfangen</button>
                <button class="wb-tab" data-wb="key">Private Key</button>
            </div>
            <div id="wb-tab-guthaben">${buildWalletDetailHtml(_walletMonitorShape(balance))}</div>
            <div id="wb-tab-senden" hidden>
                <div id="wm-send">${_buildSendPanel(tokens)}</div>
                <div id="wm-addrbook" hidden></div>
                <div class="bot-actions" id="wm-send-actions" style="margin-top:0.6rem;"></div>
            </div>
            <div id="wb-tab-empfangen" hidden>${_buildReceivePanelHtml(flavor, info)}</div>
            <div id="wb-tab-key" hidden>${_buildKeyPanelHtml(flavor, info)}</div>`,
        footerNote: '<span id="wb-footer-note">Wert &gt; 0,00 USDC</span>',
        actions: [
            { label: 'Schließen', onClick: () => closeModal(mid) },
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
            const note = modalEl.querySelector('#wb-footer-note');
            if (note) note.hidden = btn.dataset.wb !== 'guthaben';
        });
    });

    _wireSendPanel(modalEl, flavor, tokens, addrs);
    _wireReceivePanel(modalEl, info);
    _wireKeyPanel(modalEl, flavor, mid, el, info);
}

// ── Reiter "Empfangen": Adresse + QR-Code (wie bisheriges Einzahlen-Modal) ───
function _buildReceivePanelHtml(flavor, info) {
    return `
        <div class="settings-row">
            <span class="settings-label">Adresse</span>
            <div class="addr-display-row">
                <span class="addr-text" title="${_esc(info.pubkey)}">${_esc(info.preview)}</span>
                <button class="btn btn-secondary btn-icon" id="wb-receive-copy-btn" title="Kopieren">&#128203;</button>
            </div>
        </div>
        <div class="settings-row" style="border:none; align-items:flex-start; margin-top:0.75rem;">
            <span class="settings-label">QR-Code</span>
            <div class="qr-wrapper">
                <img src="/api/wallet/${flavor}/qr" alt="QR-Code" class="qr-img">
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
                    : '&#9888; Kein Key konfiguriert'}
            </span>
        </div>
        ${info.keypairSet ? `
        <div class="bot-actions" style="margin:0.6rem 0;">
            <a class="btn btn-secondary btn-sm" href="/api/wallet/${flavor}/keypair/export" download>&#11015; Herunterladen</a>
        </div>
        <p class="modal-hint" style="margin:0 0 0.9rem;">
            Bewahre die heruntergeladene Datei sicher auf — wer sie besitzt, hat vollen Zugriff auf dieses Wallet.
        </p>` : ''}
        <p class="modal-hint" style="margin-top:0.5rem;">
            ${info.keypairSet ? 'Neuen Key importieren, um den bestehenden zu ersetzen:' : 'Key einfügen:'}<br>
            Akzeptierte Formate:<br>
              &bull; Base58-String (64 Bytes, Solana CLI Format)<br>
              &bull; JSON-Array: <code>[1, 2, &hellip;, 64]</code></p>
        <textarea id="wb-key-input" class="key-textarea"
            placeholder="${info.keypairSet ? 'Neuen Key einfügen um zu ersetzen…' : 'Key einfügen (Strg+V)…'}"
            autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
        <div class="bot-actions" style="margin-top:0.6rem;">
            <button class="btn btn-secondary btn-uniform" id="wb-key-save-btn">Speichern</button>
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
        if (feedback) { feedback.textContent = 'Bitte Key einfügen.'; feedback.className = 'modal-feedback error'; }
        return;
    }
    if (feedback) { feedback.textContent = 'Speichere…'; feedback.className = 'modal-feedback'; }

    try {
        const res  = await fetch(`/api/wallet/${flavor}/keypair`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ content }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

        closeModal(mid);
        _ctx.showToast?.(`Key gespeichert. Adresse: ${data.preview}`, 'success');
        if (el) await _renderWallet(el);
    } catch (err) {
        if (feedback) { feedback.textContent = `Fehler: ${err.message}`; feedback.className = 'modal-feedback error'; }
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
                    data-tooltip-title="SOL-Reserve"
                    data-tooltip-content="0,1 SOL werden für den Betrieb des Bots auf dem Wallet benötigt und können nicht über diese Funktion abgezogen werden.">&#9432;</span>
            </span>
            <div style="display:flex;gap:0.4rem;align-items:center;">
                <select class="modal-select" id="wm-token">
                    ${tokens.map(t =>
                        `<option value="${_esc(t.symbol)}" data-bal="${t.balance}">
                            ${_esc(t.symbol)} (${_fmt(t.balance)})
                        </option>`
                    ).join('')}
                </select>
                <button class="btn btn-secondary btn-icon" id="wm-refresh" title="Guthaben aktualisieren">&#8635;</button>
            </div>
        </div>
        <div class="settings-row">
            <span class="settings-label">Betrag</span>
            <div class="send-amount-row">
                <input class="modal-input" id="wm-amount" type="number" min="0" step="any" placeholder="0.00">
                <button class="btn btn-secondary btn-sm" id="wm-max">Max</button>
            </div>
        </div>
        <div class="settings-row">
            <span class="settings-label">An</span>
            <div class="addr-select-row">
                <div class="addr-selected-display${sel ? '' : ' empty'}" id="wm-addr-display"
                     title="${sel ? _esc(sel.address) : ''}">
                    ${sel ? _esc(sel.name) : 'Keine Adresse gewählt'}
                </div>
                <button class="btn btn-secondary btn-sm wm-to-addrbook" title="Adressbuch">&#128218;</button>
            </div>
        </div>
        <div class="modal-feedback" id="wm-send-feedback" style="margin-top:0.5rem;"></div>`;
}

function _buildAddrbookList(addrs) {
    if (addrs.length === 0) {
        return `<p class="wallet-hint" style="margin-bottom:0.75rem;">Noch keine Adressen gespeichert.</p>`;
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
                        <button class="btn btn-secondary btn-sm ab-select" data-id="${a.id}">&#8629; Wählen</button>
                        <button class="btn btn-secondary btn-icon ab-edit" data-id="${a.id}" title="Bearbeiten">&#9998;</button>
                        <button class="btn btn-secondary btn-icon ab-del" data-id="${a.id}" title="Löschen">&#10005;</button>
                    </div>
                </div>`).join('')}
        </div>`;
}

function _buildAddrbookForm(row) {
    return `
        <span class="ab-form-title">${row ? 'Adresse bearbeiten' : 'Neue Adresse'}</span>
        <label class="modal-label" style="margin-top:0.75rem;">Name</label>
        <input id="ab-form-name" class="modal-input" type="text"
            value="${row ? _esc(row.name) : ''}" placeholder="z. B. Coinbase Wallet" autocomplete="off">
        <label class="modal-label" style="margin-top:0.75rem;">Solana-Adresse</label>
        <input id="ab-form-address" class="modal-input" type="text"
            value="${row ? _esc(row.address) : ''}" placeholder="Base58-Adresse…"
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
        setActionBar('<button class="btn btn-secondary btn-uniform" id="wb-send-btn">&#9654; Senden</button>');
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
            display.textContent = 'Keine Adresse gewählt';
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
        const bar = setActionBar('<button class="btn btn-secondary btn-uniform" id="ab-new">+ Neue Adresse</button>');
        bar?.querySelector('#ab-new')?.addEventListener('click', () => showForm(null));
    }

    // ── Ansicht "Adressbuch-Formular" (row=null → Neu, row={...} → Bearbeiten) ─
    function showForm(row) {
        backdrop.querySelector('#wm-send').hidden     = true;
        backdrop.querySelector('#wm-addrbook').hidden = false;
        const panel = backdrop.querySelector('#wm-addrbook');
        panel.innerHTML = _buildAddrbookForm(row);

        const bar = setActionBar('<button class="btn btn-secondary btn-uniform" id="ab-form-save">Speichern</button>');
        bar?.querySelector('#ab-form-save')?.addEventListener('click', async () => {
            const name    = panel.querySelector('#ab-form-name')?.value.trim();
            const address = panel.querySelector('#ab-form-address')?.value.trim();
            const fb      = panel.querySelector('#ab-form-feedback');

            if (!name || !address) {
                if (fb) { fb.textContent = 'Name und Adresse ausfüllen.'; fb.className = 'modal-feedback error'; }
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
                if (fb2) { fb2.textContent = `Fehler: ${err.message}`; fb2.className = 'modal-feedback error'; }
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
            btn.addEventListener('click', async () => {
                if (!confirm('Adresse wirklich löschen?')) return;
                const delId = Number(btn.dataset.id);

                const delRes = await fetch(`/api/addresses/${delId}`, { method: 'DELETE' });
                if (!delRes.ok) {
                    const err = await delRes.json().catch(() => ({}));
                    if (delRes.status === 409 && err.usages?.length) {
                        const where = err.usages.map(u =>
                            `• ${u.botId} / ${u.poolId}: ${u.fields.join(', ')}`
                        ).join('\n');
                        alert(`Diese Adresse wird noch verwendet und kann nicht gelöscht werden:\n\n${where}`);
                    } else {
                        alert(err.error ?? 'Löschen fehlgeschlagen.');
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
            });
        });
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
                fb.textContent = 'Bitte einen Token auswählen.';
                fb.className   = 'modal-feedback error';
                return;
            }
            if (!amount || amount <= 0) {
                fb.textContent = 'Bitte einen Betrag eingeben.';
                fb.className   = 'modal-feedback error';
                return;
            }
            if (!toAddress) {
                fb.textContent = 'Bitte eine Empfänger-Adresse im Adressbuch wählen.';
                fb.className   = 'modal-feedback error';
                return;
            }
            if (symbol === 'SOL' && amount > getMaxSendable()) {
                fb.textContent = `Betrag überschreitet das verfügbare Guthaben (max. ${getMaxSendable().toFixed(4)} SOL nach Reserve).`;
                fb.className   = 'modal-feedback error';
                return;
            }

            sendBtn.disabled = true;
            fb.textContent   = 'Transaktion wird gesendet…';
            fb.className     = 'modal-feedback';

            try {
                const res  = await fetch(`/api/wallet/${flavor}/send`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ symbol, amount, toAddress }),
                });
                const data = await res.json();

                if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

                fb.textContent = `✓ Gesendet: ${amount} ${symbol} → ${_selectedSendAddr.name}`;
                fb.className   = 'modal-feedback ok';
                if (amountInp) amountInp.value = '';
            } catch (err) {
                fb.textContent = `Fehler: ${err.message}`;
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
    rebalance_free: 'Rebalance-frei',
    volatil_1:      'Gering volatil',
    volatil_2:      'Mittel volatil',
    volatil_3:      'Stark volatil',
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
    icon.dataset.tooltipTitle = active ? 'Premium aktiv' : 'Premium inaktiv';
    icon.dataset.tooltipContent = active
        ? 'Premium-Datendienst aktiv – Opportunity Score, Score-Limit-Exit und Ranking-Exit laufen mit gelieferten Daten.'
        : 'Score-Bewertung nicht aktiv – Opportunity Score, Score-Limit-Exit und Ranking-Exit werden über den Premium-Datendienst geliefert. Trailing Stop und TVL-Schutz arbeiten unabhängig davon weiter.';
}

async function _renderPools(el) {
    el.innerHTML = '<div class="wallet-loading">Lade Pools…</div>';
    try {
        const [poolsRes, addrsRes, oppRes, hintsRes] = await Promise.all([
            fetch(`/api/pools/liquidity?t=${Date.now()}`),
            fetch('/api/addresses'),
            fetch(`/api/pools/liquidity/opportunity?t=${Date.now()}`),
            fetch(`/api/pools/liquidity/advisor-hints?t=${Date.now()}`),
        ]);
        if (!poolsRes.ok) throw new Error(`Pools konnten nicht geladen werden (HTTP ${poolsRes.status})`);
        if (!addrsRes.ok) throw new Error(`Adressbuch konnte nicht geladen werden (HTTP ${addrsRes.status})`);
        const pools  = await poolsRes.json();
        const addrs  = await addrsRes.json();
        const opp    = oppRes.ok ? await oppRes.json() : { available: false };
        const hints  = hintsRes.ok ? await hintsRes.json() : [];

        _advisorHints = hints;
        _updatePremiumIcon(pools);

        if (!_activePool) {
            const saved = localStorage.getItem('liquiditybot.activePool');
            _activePool = (saved && pools.find(p => p.id === saved)) ? saved : (pools[0]?.id ?? null);
        }

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
function _findScore(scores, poolId) {
    if (!scores?.available) return null;
    return scores.pools?.find(s => s.id === poolId) ?? null;
}

function _formatAge(ms) {
    if (!ms || ms < 0) return '?';
    const min = Math.round(ms / 60000);
    if (min < 1)   return 'gerade eben';
    if (min < 60)  return `vor ${min} Min`;
    const h = Math.round(min / 60);
    return `vor ${h}h`;
}

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
        return '<span class="pool-summary-off">— keine Bewertung —</span>';
    }
    const econ = score.economic;
    if (econ?.tier) {
        const m = _tierMeta(econ.tier);
        return `<span class="ranking-info">Aktuelle Empfehlung: ${m.labelEn}</span>`;
    }
    return '<span class="pool-summary-off">— noch keine Daten —</span>';
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
        poolType: p.poolType ?? null,
    })).sort((a, b) => a.key.localeCompare(b.key));

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
        if (p) _ctx.showToast?.(`Pool gewechselt: ${p.displayPair ?? p.pair}`, 'info');
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
        typeFilter.innerHTML = `<option value="all">Alle Typen</option>`
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
            <option value="all">Alle</option>
            <option value="active">Aktiv</option>
            <option value="inactive">Inaktiv</option>
            <option value="deactivated">Deaktiviert</option>`;
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
            const inactive = !o.enabled ? ' (deaktiviert)' : (o.active ? '' : ' (inaktiv)');
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
            <button type="button" class="wm-tab active" data-tab="pools">Liquidity Pools</button>
            <button type="button" class="wm-tab" data-tab="types">Pool Typen</button>
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
        panel.innerHTML = `<p class="wallet-hint">Keine Pools konfiguriert.</p>`;
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
    // (cleanup.rankingEligible===false) dürfen erst aktiviert werden, wenn
    // pool-offers-dryrun.js einen erfolgreichen deposit.js --dry-run bestätigt hat.
    const isOfferPool = pool.settings?.cleanup?.rankingEligible === false;
    const dryRunGate   = pool.settings?.dryRunGate ?? null;
    const gateBlocked  = isOfferPool && dryRunGate?.status !== 'passed';

    let enableBtnHtml;
    if (!poolEnabled && gateBlocked) {
        const gateTooltip = dryRunGate?.status === 'failed'
            ? `Dry-Run-Testlauf fehlgeschlagen: ${_esc(dryRunGate.error ?? 'unbekannter Fehler')}. Wird automatisch erneut versucht.`
            : 'Automatischer Testlauf (deposit.js --dry-run) läuft noch – wartet auf erste Pool-Daten (~1 Bot-Zyklus nach der Übernahme).';
        enableBtnHtml = `<button class="btn btn-secondary btn-sm" id="pool-btn-enable" disabled
            data-tooltip-title="⏳ Dry-Run-Gate ausstehend"
            data-tooltip-content="${gateTooltip}">Aktivieren</button>`;
    } else if (!poolEnabled) {
        enableBtnHtml = `<button class="btn btn-secondary btn-sm" id="pool-btn-enable">Aktivieren</button>`;
    } else if (hasBalance) {
        enableBtnHtml = `<button class="btn btn-secondary btn-sm" id="pool-btn-enable" disabled
            data-tooltip-title="Deaktivieren nicht möglich"
            data-tooltip-content="Pool hält eine offene Position. Erst vollständig auszahlen, dann deaktivieren.">Deaktivieren</button>`;
    } else {
        enableBtnHtml = `<button class="btn btn-secondary btn-sm" id="pool-btn-enable">Deaktivieren</button>`;
    }

    panel.innerHTML = `
        <table class="wallet-action-table">
            <tbody>
                <tr>
                    <td class="wat-label">Pool</td>
                    <td class="wat-info">
                        <div style="display:flex;align-items:center">
                            <div class="pool-picker" id="pool-picker">
                                <input type="text" id="pool-picker-input" class="modal-input pool-select"
                                       autocomplete="off" spellcheck="false"
                                       placeholder="Pool suchen…"
                                       value="${_esc(pool.displayPair ?? pool.pair)}">
                                <div id="pool-picker-drop" class="pool-picker-drop" style="display:none"></div>
                            </div>
                            <select id="pool-type-filter" class="pool-type-filter"></select>
                            <select id="pool-active-filter" class="pool-type-filter"></select>
                        </div>
                    </td>
                    <td class="wat-action">
                        ${enableBtnHtml}
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Range
                        <span class="info-tip-label"
                            data-tooltip-title="Range &amp; Rebalance"
                            data-tooltip-content="Zeigt die aktuelle Position-Range und ermöglicht einen manuellen Rebalance (Position wird geschlossen und mit neuer Range neu eröffnet).">&#9432;</span>
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">Range anzeigen und manuell rebalancen.</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-rebalance"
                            ${activeHint ? `style="background:var(--accent);color:#000;border-color:var(--accent);"
                            data-tooltip-title="Range-Empfehlung (Konfidenz: ${activeHint.confidence === 'high' ? 'hoch' : 'mittel'})"
                            data-tooltip-content="Range nicht mehr optimal: ±${activeHint.currentPct}% → ±${activeHint.recommendedPct}%.${activeHint.paybackHours != null ? `|Reopen amortisiert in ~${Math.round(activeHint.paybackHours)} Stunden.` : ''}|Verwalten → Rebalance um die Empfehlung sofort umzusetzen.|Ohne Aktion wird die neue Range beim nächsten natürlichen Rebalance automatisch übernommen."` : ''}>Verwalten</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Fee Claim
                        <span class="info-tip-label"
                            data-tooltip-title="Fee Claim"
                            data-tooltip-content="Steuert ab welchem Betrag Fees geclaimed werden und was danach damit passiert.\n\nAuto Compounding: Fees sofort wieder in den Pool reinvestieren (ganz oder anteilig).\n\nSenden an: Verbleibende Fees optional an eine Adresse senden – ggf. vorher in USDC tauschen.">&#9432;</span>
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">Regelt den Umgang mit den Fee-Einnahmen.</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-ac">Verwalten</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Risk-Management
                        <span class="info-tip-label"
                            data-tooltip-title="Risk-Management"
                            data-tooltip-content="Zwei voneinander unabhängige Schutzmechanismen:||Score Limit: Schließt die Position automatisch, sobald der Opportunity Score des Pools unter eine einstellbare Schwelle fällt.||Trailing Stop (TS): Schließt die Position, wenn der Pool-Wert um einen einstellbaren Prozentsatz unter den bisherigen Höchststand fällt (High-Water-Mark).||Bei beiden Mechanismen kann das entnommene Kapital optional in USDC getauscht und an eine Adresse gesendet werden.">&#9432;</span>
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">${_buildSafetySummary(pool)}</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-sltp">Verwalten</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Einzahlen
                        <span class="info-tip-label"
                            data-tooltip-title="In den Pool einzahlen"
                            data-tooltip-content="Fügt der bestehenden Pool-Position Kapital hinzu, oder eröffnet eine neue Position wenn der Pool gerade inaktiv ist.\n\nZwei Modi:\n• USDC-Betrag: Wallet-USDC wird in beide Pool-Tokens geswappt.\n• Wallet-Coins: Vorhandene Pool-Tokens werden direkt verwendet, kein Swap.">&#9432;</span>
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">Liquidität dem Pool hinzufügen.</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-deposit"
                            ${pool.uiDepositDisabled ? 'disabled title="Preis-Referenzpool – keine Einzahlungen möglich"'
                              : (!poolEnabled ? 'disabled data-tooltip-title="Pool deaktiviert" data-tooltip-content="Pool ist deaktiviert – erst aktivieren, dann einzahlen."' : '')}>Einzahlen</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Auszahlen
                        <span class="info-tip-label"
                            data-tooltip-title="Aus dem Pool auszahlen"
                            data-tooltip-content="Entnimmt Liquidität aus der bestehenden Pool-Position. Optional können die entnommenen Coins vor dem Verbleib im Wallet in USDC getauscht und/oder an eine Adresse gesendet werden.\n\nZwei Modi:\n• USDC-Wert: Liquidität im Gegenwert dieses USDC-Betrags wird proportional entnommen.\n• Token-Menge: Anteilige Entnahme über einen Pool-Token als Anker — beide Seiten kommen anteilig zurück.">&#9432;</span>
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">Liquidität aus dem Pool entfernen.</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="pool-btn-withdraw" ${pool.active ? '' : 'disabled'}>Auszahlen</button>
                    </td>
                </tr>
            </tbody>
        </table>
        ${noData
            ? `<p class="wallet-hint" style="margin-top:0.5rem; font-size:0.78rem;">Noch keine verlässlichen Pool-Daten – prüfe oben in der Zeile "Status", ob der Liquidity Bot läuft.</p>`
            : (!poolEnabled
                ? `<p class="wallet-hint" style="margin-top:0.5rem; font-size:0.78rem;">&#128274; Pool deaktiviert – nimmt kein Kapital auf (kein Cleanup-Reinvest), bis er wieder aktiviert wird. Einstellungen können trotzdem gespeichert werden.</p>`
                : (!pool.active ? `<p class="wallet-hint" style="margin-top:0.5rem; font-size:0.78rem;">&#9888; Pool ruht – keine offene Position. Einstellungen können trotzdem gespeichert werden.</p>` : ''))}`;

    if (noData) {
        const input = panel.querySelector('#pool-picker-input');
        if (input) {
            input.value       = '';
            input.placeholder = 'Bitte Liquidity Bot aktivieren';
            input.disabled    = true;
        }
        panel.querySelector('#pool-type-filter')?.setAttribute('disabled', 'disabled');
        panel.querySelector('#pool-active-filter')?.setAttribute('disabled', 'disabled');
        panel.querySelectorAll('.wat-action button').forEach(b => { b.disabled = true; });
        return;
    }

    _initPoolPicker(card, pools, addrs, opp, hints);

    card.querySelector('#pool-btn-ac')
        ?.addEventListener('click', () => _openFeeClaimModal(pool, addrs, card));
    card.querySelector('#pool-btn-sltp')
        ?.addEventListener('click', () => _openSLTPModal(pool, addrs, card));
    card.querySelector('#pool-btn-rebalance')
        ?.addEventListener('click', () => _openPoolRebalanceModal(pool, activeHint));
    card.querySelector('#pool-btn-enable')
        ?.addEventListener('click', () => _toggleEnabled(pool, card));
    card.querySelector('#pool-btn-deposit')
        ?.addEventListener('click', () => _openPoolDepositModal(pool));
    card.querySelector('#pool-btn-withdraw')
        ?.addEventListener('click', () => _openPoolWithdrawModal(pool, addrs));
}

// ── Tab "Pool Typen" ──────────────────────────────────────────────────────────
// Setzt Default-Werte pro Pool-Typ, die beim Speichern SOFORT auf alle Pools dieses
// Typs durchgeschrieben werden (Bulk-Write, kein Template/Override-Konzept).

function _renderPoolTypesTab(container) {
    container.innerHTML = '<div class="wallet-loading">Lade Pool-Typen…</div>';
    fetch(`/api/pools/liquidity/pool-types?t=${Date.now()}`)
        .then(async res => {
            if (!res.ok) throw new Error(`Pool-Typen konnten nicht geladen werden (HTTP ${res.status})`);
            return res.json();
        })
        .then(rows => _drawPoolTypesTable(container, rows))
        .catch(err => {
            container.innerHTML = `<p class="wallet-hint">Fehler: ${_esc(err.message)}</p>`;
        });
}

function _poolTypeRowHtml(r) {
    const label = POOL_TYPE_LABELS[r.poolType] ?? r.poolType;
    const s = r.settings;
    const investedPools = r.investedPools ?? [];
    const investedCount = investedPools.length;
    const lockDisable   = investedCount > 0 && s.enabled !== false;
    const countLine     = `${r.poolCount} Pool${r.poolCount === 1 ? '' : 's'}`
        + (investedCount > 0 ? ` / ${investedCount} Pool${investedCount === 1 ? '' : 's'} investiert` : '');
    return `
        <tr data-pool-type="${r.poolType}">
            <td class="wat-label">
                ${_esc(label)}
                <div style="font-size:0.75rem;color:var(--text-muted);">${countLine}</div>
            </td>
            <td class="wat-info">
                <div class="input-unit-row">
                    <input type="number" class="modal-input input-short" id="pt-ts-${r.poolType}"
                        min="1" max="90" step="1" value="${s.trailingStop.thresholdPct ?? ''}">
                    <span class="input-unit">%</span>
                </div>
            </td>
            <td class="wat-info">
                <div class="input-unit-row">
                    <span class="input-unit">$</span>
                    <input type="number" class="modal-input input-short" id="pt-tvl1-${r.poolType}"
                        min="0" step="100" placeholder="leer = aus" value="${s.tvlProtection.level1.thresholdUsd ?? ''}">
                </div>
            </td>
            <td class="wat-info">
                <div class="input-unit-row">
                    <span class="input-unit">$</span>
                    <input type="number" class="modal-input input-short" id="pt-tvl2-${r.poolType}"
                        min="0" step="100" placeholder="leer = aus" value="${s.tvlProtection.level2.thresholdUsd ?? ''}">
                </div>
            </td>
            <td class="wat-info">
                <label class="toggle-switch toggle-sm"
                    ${lockDisable ? `data-tooltip-title="Nicht deaktivierbar" data-tooltip-content="${_esc(investedPools.map(p => p.displayPair).join(', '))} – erst auszahlen, dann deaktivieren."` : ''}>
                    <input type="checkbox" id="pt-enabled-${r.poolType}" ${s.enabled !== false ? 'checked' : ''} ${lockDisable ? 'disabled' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </td>
            <td class="wat-action">
                <button class="btn btn-secondary btn-sm" id="pt-save-${r.poolType}"
                    ${_ctx.getStatus?.(SVC_ID) !== 'active' ? 'disabled' : ''}>Speichern</button>
            </td>
        </tr>
        <tr>
            <td colspan="6"><div class="modal-feedback" id="pt-feedback-${r.poolType}"></div></td>
        </tr>`;
}

function _drawPoolTypesTable(container, rows) {
    container.innerHTML = `
        <p class="wallet-hint" style="margin:0 0 0.8rem;font-size:0.8rem;">
            Speichern überträgt die Werte einer Zeile sofort auf ALLE Pools dieses Typs und
            überschreibt dort bestehende individuelle Einstellungen (Risk-Management-Modal).
        </p>
        <table class="wallet-action-table pool-types-table">
            <thead>
                <tr>
                    <th>Pool Typ</th>
                    <th>Trailing Stop Drawdown</th>
                    <th>TVL Schwelle 1</th>
                    <th>TVL Schwelle 2</th>
                    <th>Aktiviert</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(r => _poolTypeRowHtml(r)).join('')}
            </tbody>
        </table>`;

    rows.forEach(r => {
        container.querySelector(`#pt-save-${r.poolType}`)
            ?.addEventListener('click', () => _confirmSavePoolType(container, r));
    });
}

function _confirmSavePoolType(container, row) {
    const poolType = row.poolType;
    const label    = POOL_TYPE_LABELS[poolType] ?? poolType;
    const get      = id => container.querySelector(`#${id}`);
    const fb       = get(`pt-feedback-${poolType}`);
    const setErr   = msg => { if (fb) { fb.textContent = msg; fb.className = 'modal-feedback error'; } };

    const thresholdPct = parseFloat(get(`pt-ts-${poolType}`)?.value ?? '');
    if (!Number.isFinite(thresholdPct) || thresholdPct < 1 || thresholdPct > 90) {
        return setErr('Trailing-Stop-Drawdown muss zwischen 1 und 90 % liegen.');
    }
    const tvl1Raw = get(`pt-tvl1-${poolType}`)?.value ?? '';
    const tvl2Raw = get(`pt-tvl2-${poolType}`)?.value ?? '';
    const tvl1 = tvl1Raw === '' ? null : parseFloat(tvl1Raw);
    const tvl2 = tvl2Raw === '' ? null : parseFloat(tvl2Raw);
    if (tvl1 != null && !(tvl1 > 0)) return setErr('TVL-Schwelle 1 muss größer als 0 sein (oder leer lassen).');
    if (tvl2 != null && !(tvl2 > 0)) return setErr('TVL-Schwelle 2 muss größer als 0 sein (oder leer lassen).');
    const enabled = get(`pt-enabled-${poolType}`)?.checked ?? true;
    if (fb) { fb.textContent = ''; fb.className = 'modal-feedback'; }

    // Bestätigung über ein eigenes Modal statt window.confirm() (bewusst keine
    // nativen Browser-Dialoge) — analog deleteSupportThread() in html/js/message.js.
    const mid = `pool-type-confirm-${poolType}`;
    showModal({
        id:    mid,
        title: `Pool-Typ "${label}" speichern?`,
        body: `
            <p style="margin:0 0 0.5rem;">
                Dies überschreibt Trailing-Stop- und TVL-Schutz-Werte bei
                <strong>${row.poolCount} Pool${row.poolCount === 1 ? '' : 's'}</strong> vom Typ
                <strong>${_esc(label)}</strong> sofort.
            </p>
            <p style="margin:0;color:var(--text-muted);font-size:0.85rem;">
                Bestehende individuelle Anpassungen bei diesen Pools gehen dabei verloren.
                ${enabled === false ? ' Zusätzlich werden alle Pools dieses Typs deaktiviert (keine Cleanup-Zuweisung mehr).' : ''}
            </p>
            <div id="pt-confirm-feedback" style="margin-top:0.6rem;font-size:0.82rem"></div>`,
        actions: [
            {
                label: 'Speichern', onClick: async () => {
                    const modalEl = getModal(mid);
                    const cfb     = modalEl?.querySelector('#pt-confirm-feedback');
                    const btns    = modalEl?.querySelectorAll('.forge-modal-footer button') ?? [];
                    btns.forEach(b => { b.disabled = true; });
                    if (cfb) { cfb.style.color = 'var(--text-muted)'; cfb.textContent = 'Speichere…'; }
                    try {
                        const res = await fetch(`/api/pools/liquidity/pool-types/${poolType}`, {
                            method:  'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                trailingStop:  { thresholdPct },
                                tvlProtection: { level1: { thresholdUsd: tvl1 }, level2: { thresholdUsd: tvl2 } },
                                enabled,
                            }),
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

                        closeModal(mid);
                        const failCount = data.failed?.length ?? 0;
                        if (failCount > 0) {
                            const reasons = data.failed.map(f => `${f.poolId}: ${f.reason}`).join(' | ');
                            _ctx.showToast?.(`Gespeichert, aber ${failCount} Pool(s) übersprungen – ${reasons}`, 'error');
                        } else {
                            _ctx.showToast?.(`Pool-Typ "${label}" gespeichert (${data.updated?.length ?? 0} Pools)`, 'success');
                        }

                        // Tab-Inhalt + darunterliegende Pool-Liste (falls schon geladen)
                        // aktualisieren, damit neue Werte sofort sichtbar sind.
                        _renderPoolTypesTab(container);
                        const scaffoldCard = container.closest('.settings-card');
                        if (scaffoldCard?.querySelector('#pool-panel-pools')) {
                            await _refreshPoolsCard(scaffoldCard);
                        }
                    } catch (err) {
                        if (cfb) { cfb.style.color = 'var(--danger)'; cfb.textContent = `Fehler: ${err.message}`; }
                        btns.forEach(b => { b.disabled = false; });
                    }
                },
            },
            { label: 'Abbrechen', onClick: () => closeModal(mid) },
        ],
    });
}

// ── Pool aktivieren / deaktivieren (Benutzer-Freigabe) ────────────────────────

function _toggleEnabled(pool, card) {
    const enable = pool.enabled === false; // aktuell gesperrt → jetzt aktivieren
    const name   = _esc(pool.displayPair ?? pool.pair);
    const mid    = 'liquiditybot-toggle-enabled';

    const explain = enable
        ? 'Der Pool kann danach wieder Kapital aufnehmen (Einzahlungen und Cleanup-Reinvest).'
        : 'In den Pool wird kein Kapital mehr investiert (kein Cleanup-Reinvest, keine Einzahlung), bis er wieder aktiviert wird.';

    const body = `
        <p style="margin:0 0 0.5rem">Pool <strong>${name}</strong> ${enable ? 'aktivieren' : 'deaktivieren'}?</p>
        <p style="margin:0;color:var(--text-muted);font-size:0.85rem">${explain}</p>
        <div id="toggle-feedback" style="margin-top:0.6rem;font-size:0.82rem"></div>`;

    const doToggle = async () => {
        const modalEl = getModal(mid);
        const fb      = modalEl?.querySelector('#toggle-feedback');
        const btns    = modalEl?.querySelectorAll('.forge-modal-footer button') ?? [];
        btns.forEach(b => { b.disabled = true; });
        if (fb) { fb.style.color = 'var(--text-muted)'; fb.textContent = 'Wird gespeichert…'; }
        try {
            const res  = await fetch(`/api/pools/liquidity/${pool.id}/toggle-enabled`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ enabled: enable }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

            closeModal(mid);
            _ctx.showToast?.(data.message ?? (enable ? 'Pool aktiviert' : 'Pool deaktiviert'), 'success');
            _renderPools(card.parentElement);
        } catch (err) {
            if (fb) { fb.style.color = 'var(--danger)'; fb.textContent = `Fehler: ${err.message}`; }
            btns.forEach(b => { b.disabled = false; });
        }
    };

    showModal({
        id:    mid,
        title: enable ? 'Pool aktivieren' : 'Pool deaktivieren',
        body,
        actions: [
            { label: enable ? 'Aktivieren' : 'Deaktivieren', onClick: doToggle },
            { label: 'Abbrechen', onClick: () => closeModal(mid) },
        ],
    });
}

// ── Pool-Info-Tooltips ────────────────────────────────────────────────────────

function _buildFeeClaimSummary(pool) {
    const s    = pool.settings.autoCompound;
    const min  = s.minClaimUsdc ?? 1;
    const parts = [];
    if (s.enabled) {
        const pct = s.fraction ?? 100;
        parts.push(`<span class="pool-summary-on">AC ${pct}%</span>`);
    } else {
        parts.push(`<span class="pool-summary-off">AC Aus</span>`);
    }
    if (s.sendTo) {
        parts.push(`→ ${s.swapToUsdc ? 'USDC · ' : ''}${_esc(s.sendTo.slice(0, 6))}…`);
    }
    parts.push(`ab ${min} USDC`);
    return parts.join(' &middot; ');
}

function _buildSafetySummary(_pool) {
    return 'Regeln um Verluste einzugrenzen und Gewinne zu sichern.';
}

function _buildRMTip(pool) {
    const sl = pool.settings.scoreLimit ?? { enabled: false, minScore: 30 };
    const ts = pool.settings.trailingStop ?? { enabled: false, thresholdPct: 33 };
    return [
        `Score Limit: ${sl.enabled ? 'Unter ' + (sl.minScore ?? 30) : 'Aus'}`,
        `Trailing Stop: ${ts.enabled ? '-' + (ts.thresholdPct ?? 33) + ' %' : 'Aus'}`,
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
    return `${dp === 0 ? rounded.toLocaleString('de-DE') : rounded.toFixed(dp)}%`;
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

// ── Ranking-Modal Tab-Builder ─────────────────────────────────────────────────

function _buildCleanupToggle(eligible) {
    return `
        <div class="ranking-section">
            <div class="ranking-section-title">Cleanup-Berücksichtigung</div>
            <div class="settings-row" style="border:none;padding:0.35rem 0;">
                <span class="settings-label" style="flex:1;">
                    Beim Cleanup (Bester Pool) berücksichtigen
                    <span class="info-tip-label"
                        data-tooltip-title="Cleanup – Bester Pool"
                        data-tooltip-content="Ist diese Option aktiviert, nimmt der Pool am stündlichen Cleanup im Modus „Bester Pool" teil.||Ist sie deaktiviert, wird der Pool dort übersprungen — auch wenn er den höchsten Opportunity-Score hätte. Manuelle Pool-Auswahl bleibt unverändert.">&#9432;</span>
                </span>
                <label class="toggle-switch">
                    <input type="checkbox" id="ranking-eligible" ${eligible ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
        </div>`;
}

/**
 * PnL-Sektion: zeigt PnL 1D + 7D bei fiktivem Einsatz von 1.000 USDC.
 *
 * Datenherkunft je nach Pool-Status:
 *   • Aktiv:   pnl_1d_pct / pnl_7d_pct — cashflow-bereinigt aus lib/pnl-history.js
 *              (identische Methode wie Dashboard-pnl1d). Fallback: Projektion
 *              aus total_return_apr_pct wenn Messung fehlt (z.B. < 7 d Historie).
 *   • Inaktiv: 1D + 7D = Projektion aus total_return_apr_pct (Modell).
 *
 * Badge kennzeichnet jede Zelle eindeutig:
 *   gemessen   → grün   (echter cashflow-bereinigter Wert)
 *   Projektion → blau   (Hochrechnung aus gemessenem Total Return p.a.)
 *   Simulation → orange (Modell, kein Live-Kapital im Pool)
 */
function _buildSimulationSection(econ) {
    if (!econ) return '';
    const STAKE = 1000;

    const totalReturn = econ.total_return_apr_pct;
    const pnl1dPct    = econ.pnl_1d_pct;
    const pnl7dPct    = econ.pnl_7d_pct;

    // 1D-Wert ermitteln
    let val1d = null, badge1d = null;
    if (econ.is_active && pnl1dPct != null && isFinite(pnl1dPct)) {
        val1d = (pnl1dPct / 100) * STAKE;
        badge1d = 'measured';
    } else if (totalReturn != null && isFinite(totalReturn)) {
        val1d = (totalReturn / 100 / 365) * STAKE;
        badge1d = econ.is_active ? 'projected' : 'simulated';
    }

    // 7D-Wert ermitteln
    let val7d = null, badge7d = null;
    if (econ.is_active && pnl7dPct != null && isFinite(pnl7dPct)) {
        val7d = (pnl7dPct / 100) * STAKE;
        badge7d = 'measured';
    } else if (totalReturn != null && isFinite(totalReturn)) {
        val7d = (totalReturn / 100 / 52) * STAKE;
        badge7d = econ.is_active ? 'projected' : 'simulated';
    }

    if (val1d == null && val7d == null) return '';

    const badgeMeta = {
        measured:  { label: 'gemessen',   cls: 'sim-badge-measured'  },
        projected: { label: 'Projektion', cls: 'sim-badge-projected' },
        simulated: { label: 'Simulation', cls: 'sim-badge-simulated' },
    };

    const renderCell = (label, value, badgeKey) => {
        if (value == null) {
            return `<div><span>${label}</span><strong>—</strong></div>`;
        }
        const sign = value >= 0 ? '+' : '';
        const cls  = value >= 0 ? 'positive' : 'negative';
        const b    = badgeMeta[badgeKey];
        return `
            <div>
                <span>${label}</span>
                <strong class="${cls}">
                    ${sign}${value.toFixed(2)} USDC
                    <span class="sim-badge ${b.cls}">${b.label}</span>
                </strong>
            </div>`;
    };

    return `
        <div class="ranking-section">
            <div class="ranking-section-title"
                data-tooltip-title="Profit and Loss (PnL)"
                data-tooltip-content="Erwartete bzw. gemessene Wertentwicklung der LP-Position bei einem Einsatz von 1.000 USDC.||gemessen: echte Snapshot-Werte (nur aktive Pools)|Projektion: linear hochgerechnet aus Total Return p.a.|Simulation: aus Modell-APR für inaktive Pools">
                Profit and Loss (PnL) <span class="info-tip-label">&#9432;</span>
            </div>
            <div class="ranking-grid">
                ${renderCell('PnL 1D', val1d, badge1d)}
                ${renderCell('PnL 7D', val7d, badge7d)}
            </div>
        </div>`;
}

function _buildBewertungTab(econ, eligible) {
    if (!econ) return `
        <div class="ranking-section">
            <div class="ranking-section-title">Score-Aufschlüsselung (Legacy)</div>
            <div style="font-size:0.8rem;opacity:0.7;padding:0.4rem 0;">
                Noch keine Economic-Scorer-Daten — wird beim nächsten Cron-Lauf aktualisiert.
            </div>
        </div>
        ${_buildCleanupToggle(eligible)}`;

    const aprLabel = econ.is_active ? 'Realized APR (7d)' : 'Geschätzter APR';
    const aprValue = econ.is_active ? econ.realized_apr_pct : econ.estimated_apr_pct;

    // Token-Wert-Zeile: nur anzeigen wenn Wert vorhanden (sonst Hinweis-Text)
    const tokenLine = econ.token_return_apr_pct != null
        ? `<div><span>± Token-Wert-Bewegung p.a.</span><strong>${econ.token_return_apr_pct >= 0 ? '+' : ''}${_fmtPct(econ.token_return_apr_pct, 1)}</strong></div>`
        : `<div><span>± Token-Wert-Bewegung p.a.</span><strong>— (nicht messbar)</strong></div>`;

    const totalReturn = econ.total_return_apr_pct ?? econ.net_econ_pct;

    return `
        <div class="ranking-section">
            <div class="ranking-section-title">Wirtschaftlichkeit</div>
            <div class="ranking-grid">
                <div><span>${aprLabel}</span><strong>${_fmtPct(aprValue, 1)}</strong></div>
                <div><span>− Rebalance-Kosten p.a.</span><strong>−${_fmtPct(econ.rebal_cost_apr_pct, 2)}</strong></div>
                <div><span>− Reinvest-Effizienz-Verlust</span><strong>−${_fmtPct(econ.reinvest_loss_apr_pct, 2)}</strong></div>
                ${tokenLine}
                <div class="ranking-grid-total"
                    data-tooltip-title="Total Return"
                    data-tooltip-content="Erwartete Jahresrendite der Position:|Realized APR aus Fees|− Rebalance-Kosten|− Reinvest-Effizienz-Verlust|± Token-Wert-Bewegung|||Die Token-Wert-Bewegung kann positiv oder negativ sein. Fällt der Wert der gehaltenen Tokens, kippt der Total Return ins Negative — auch wenn die Fees gut laufen.">
                    <span>= Total Return p.a. <span class="info-tip-label">&#9432;</span></span>
                    <strong>${totalReturn >= 0 ? '+' : ''}${_fmtPct(totalReturn, 1)}</strong>
                </div>
            </div>
        </div>
        ${_buildSimulationSection(econ)}
        ${_buildCleanupToggle(eligible)}`;
}

function _buildDetailsTab(econ, score) {
    if (!econ) {
        const trendArrow = { up: '↗', down: '↘', sideways: '→' }[score.trend] ?? '';
        const trendLabel = { up: 'Aufwärts', down: 'Abwärts', sideways: 'Seitwärts' }[score.trend] ?? '?';
        return `
            <div class="ranking-section">
                <div class="ranking-section-title">Aufschlüsselung (Legacy)</div>
                <div class="ranking-grid">
                    <div><span>Brutto-APR (Fees)</span><strong>${_fmtPct(score.gross_apr_pct)}</strong></div>
                    <div><span>− Rebalance-Kosten</span><strong>−${_fmtPct(score.rebal_cost_apr_pct)}</strong></div>
                    <div><span>− Impermanent Loss</span><strong>−${_fmtPct(score.annual_il_pct)}</strong></div>
                    <div class="ranking-grid-total"><span>= Netto-APR</span><strong>${_fmtPct(score.net_apr_pct)}</strong></div>
                </div>
            </div>
            <div class="ranking-section">
                <div class="ranking-section-title">Volatilität & Trend</div>
                <div class="ranking-grid">
                    <div><span>Vola stündlich</span><strong>${_fmtPct(score.vola_hourly_pct, 2)}</strong></div>
                    <div><span>Vola annualisiert</span><strong>${_fmtPct(score.vola_annualized_pct, 0)}</strong></div>
                    <div style="grid-column:1/-1;border-right:none;border-bottom:none;"
                        data-tooltip-title="EMA-Stack"
                        data-tooltip-content="Trend-Bewertung anhand der drei exponentiellen gleitenden Durchschnitte über die letzten 10/20/30 Stunden:\n\nEMA 10 ${score.ema?.ema10?.toFixed(2)} / EMA 20 ${score.ema?.ema20?.toFixed(2)} / EMA 30 ${score.ema?.ema30?.toFixed(2)}\n\n↗ Aufwärts: Preis > EMA 10 > EMA 20 > EMA 30\n↘ Abwärts: Preis < EMA 10 < EMA 20 < EMA 30\n→ Seitwärts: gemischt">
                        <span>Trend (EMA-Stack)</span><strong>${trendArrow} ${trendLabel}</strong></div>
                </div>
            </div>
            <div class="ranking-section">
                <div class="ranking-section-title">Rebalancing-Prognose</div>
                <div class="ranking-grid">
                    <div><span>Range</span><strong>±${score.range_pct}%</strong></div>
                    <div><span>OOR alle</span><strong>${score.hours_until_oor?.toFixed(1)} h</strong></div>
                    <div><span>Rebalances/Tag</span><strong>${score.rebals_per_day?.toFixed(1)}</strong></div>
                    <div><span>MyShare bei ${_fmtUsd(score.capital_usdc)}</span><strong>${_fmtPct(score.myShare * 100, 3)}</strong></div>
                </div>
            </div>`;
    }

    const trendDir   = { up: '↗ steigend', down: '↘ fallend', sideways: '→ seitwärts', unknown: '— unbekannt' }[econ.trend_direction] ?? '—';
    const trendSlope = econ.trend_7d_slope != null
        ? `${econ.trend_7d_slope >= 0 ? '+' : ''}${econ.trend_7d_slope.toFixed(2)} %-Pkt/Tag`
        : '—';
    const rebalsPerMonth = econ.rebals_per_year != null
        ? (econ.rebals_per_year / 12).toFixed(1)
        : '—';
    const estimatedCostPerRebal = (econ.rebal_cost_apr_pct != null && econ.rebals_per_year > 0 && econ.avg_capital_usd > 0)
        ? Math.abs(econ.rebal_cost_apr_pct) / 100 * econ.avg_capital_usd / econ.rebals_per_year
        : null;

    return `
        <div class="ranking-section">
            <div class="ranking-section-title">Qualitäts-Modifikatoren</div>
            <div class="ranking-grid">
                <div data-tooltip-title="Konfidenz" data-tooltip-content="Datenreife des Scorers: Wie viele Tage fee_history sind vorhanden?|Skaliert von 0 % (3 Tage) bis 100 % (14+ Tage).|Unter 3 Tagen: Pool landet automatisch in „Halten" (kein Invest-Signal).|Inaktive Pools: maximal 60 % (APR geschätzt, nicht gemessen).">
                    <span>Konfidenz <span class="info-tip-label">&#9432;</span></span>
                    <strong>${_fmtPct(econ.confidence_pct, 0)}</strong>
                </div>
                <div><span>Daten-Tage</span><strong>${econ.confidence_days?.toFixed?.(1) ?? '—'}</strong></div>
                <div><span>Trend (7d)</span><strong>${trendDir}</strong></div>
                <div><span>Steigung</span><strong>${trendSlope}</strong></div>
                <div><span>Range-Hit-Rate</span><strong>${_fmtPct(econ.range_hit_rate_pct, 0)}</strong></div>
                <div><span>TVL-Trend (7d)</span><strong>${_fmtPct(econ.tvl_trend_pct, 1)}</strong></div>
                <div><span>Volume / TVL</span><strong>${econ.vol_tvl_ratio != null ? (econ.vol_tvl_ratio * 100).toFixed(1) + '%' : '—'}</strong></div>
                <div><span>Realized − Pool-APR</span><strong>${_fmtPct(econ.apr_delta_pct, 1)}</strong></div>
            </div>
        </div>
        <div class="ranking-section">
            <div class="ranking-section-title">Wertentwicklung</div>
            <div class="ranking-grid">
                <div data-tooltip-title="Token-Wert-Bewegung"
                    data-tooltip-content="Annualisierte Veränderung des LP-Werts in USDC über die letzten Tage (max 7 d).|Erfasst Token-Preis-Bewegungen — komplementär zur Fee-Sicht (Realized APR).|Bei stark fallenden Tokens kann dieser Wert deutlich negativ werden, auch wenn die Fees gut laufen.">
                    <span>Token-Wert p.a. <span class="info-tip-label">&#9432;</span></span>
                    <strong>${econ.token_return_apr_pct != null ? (econ.token_return_apr_pct >= 0 ? '+' : '') + _fmtPct(econ.token_return_apr_pct, 1) : '—'}</strong>
                </div>
                <div data-tooltip-title="PnL 1D"
                    data-tooltip-content="LP-Wert-Veränderung der letzten 24 Stunden.|Akut-Indikator für plötzliche Kursabstürze.|Trigger für „Abziehen": fällt der Wert um mehr als 10 %, wird der Pool sofort als withdraw markiert (Hysterese muss noch zustimmen).">
                    <span>PnL 1D <span class="info-tip-label">&#9432;</span></span>
                    <strong>${econ.daily_pnl_pct != null ? (econ.daily_pnl_pct >= 0 ? '+' : '') + _fmtPct(econ.daily_pnl_pct, 2) : '—'}</strong>
                </div>
            </div>
        </div>
        <div class="ranking-section">
            <div class="ranking-section-title">Rebalancing</div>
            <div class="ranking-grid">
                <div><span>Erw. Rebalances/Monat</span><strong>${rebalsPerMonth}</strong></div>
                <div><span>Gesch. Kosten/Rebalance</span><strong>${_fmtCost(estimatedCostPerRebal)}</strong></div>
            </div>
        </div>`;
}

function _buildMarktTab(score, scores) {
    return `
        <div class="ranking-section">
            <div class="ranking-section-title">Markt-Daten</div>
            <div class="ranking-grid">
                <div><span>Preis</span><strong>${score.price != null ? score.price.toFixed(4) + ' USDC' : '—'}</strong></div>
                <div><span>24h-Change</span><strong>${_fmtPct(score.change24h_pct, 2)}</strong></div>
                <div><span>TVL</span><strong>${_fmtUsd(score.tvl_usd)}</strong></div>
                <div><span>Volume (24h)</span><strong>${_fmtUsd(score.vol24h_usd)}</strong></div>
                <div><span>Vol/TVL</span><strong>${_fmtPct(score.volPerTvl * 100, 1)}</strong></div>
                <div><span>Fee-Tier</span><strong>${score.feeTier_pct}%</strong></div>
            </div>
        </div>
        <div class="ranking-footer">
            Daten aktualisiert ${_formatAge(scores?.ageMs)} ·
            Cron-Refresh alle 15 Min ·
            Quelle: GeckoTerminal
        </div>`;
}

function _initRankingModalTabs(mid) {
    const backdrop = getModal(mid);
    if (!backdrop) return;
    const tabs   = backdrop.querySelectorAll('.rk-tab');
    const panels = [...backdrop.querySelectorAll('.rk-panel')];

    // Alle Panels kurz einblenden, maximale Höhe messen, dann angleichen
    panels.forEach(p => { p.hidden = false; });
    const maxH = Math.max(...panels.map(p => p.getBoundingClientRect().height));
    panels.forEach((p, i) => {
        p.style.minHeight = maxH + 'px';
        p.hidden = i > 0;
    });

    tabs.forEach(tab => tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.toggle('active', t === tab));
        panels.forEach(p => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    }));
}

/**
 * Berechnet die Pool-Position auf dem Tier-Slider (0–100 %).
 *
 * Wichtig: Das **Tier** (Hysterese-stabilisiert) bestimmt das Drittel, in dem
 * der Punkt liegt. So bleibt die Anzeige immer konsistent mit der offiziellen
 * Empfehlung — ein Pool mit Tier "hold" zeigt nie einen Punkt im Invest-Drittel,
 * auch wenn sein roher Total Return temporär über dem Median liegt.
 *
 * Innerhalb des Drittels positioniert der Total Return relativ zu den
 * Tier-Schwellen, sodass die Nähe zum nächsten Wechsel sichtbar ist.
 */
function _computeSliderPosition(econ, scores) {
    if (!econ) return 50;
    const tr = econ.total_return_apr_pct ?? econ.net_econ_pct;
    if (tr == null || !isFinite(tr)) return 50;

    // observe-Einträge (Alt-Tier) wie hold behandeln
    const tier = econ.tier === 'observe' ? 'hold' : econ.tier;

    const withdrawThreshold = econ.is_active ? -20 : 0;
    const median = _calcEconomicMedian(scores) ?? (withdrawThreshold + 40);

    if (tier === 'withdraw') {
        // 0–33 %: je weiter unter withdrawThreshold, desto weiter links
        const floor = withdrawThreshold - 80;
        const frac  = Math.max(0, Math.min(1, (tr - floor) / (withdrawThreshold - floor)));
        return frac * 33;
    }

    if (tier === 'invest') {
        // 66–100 %: je weiter über Median, desto weiter rechts
        const ceiling = median + Math.max(40, Math.abs(median));
        const frac    = Math.max(0, Math.min(1, (tr - median) / (ceiling - median)));
        return 66 + frac * 34;
    }

    // Hold (Default, inkl. observe): 33–66 %.
    // Position innerhalb des Drittels gemäß Total Return zwischen den Tier-Schwellen,
    // aber stets auf [33 %, 66 %] geklemmt – auch wenn der rohe Wert außerhalb liegt.
    const lo   = withdrawThreshold;
    const hi   = median;
    const span = Math.max(1, hi - lo);
    const frac = Math.max(0, Math.min(1, (tr - lo) / span));
    return 33 + frac * 33;
}

/** Median der totalReturnAprPct aller wirtschaftlichen (≠ withdraw) Pools. */
function _calcEconomicMedian(scores) {
    if (!scores?.pools) return null;
    const values = scores.pools
        .map(s => s.economic)
        .filter(e => e && e.tier && e.tier !== 'withdraw')
        .map(e => e.total_return_apr_pct ?? e.net_econ_pct)
        .filter(v => v != null && isFinite(v))
        .sort((a, b) => a - b);
    if (!values.length) return null;
    return values[Math.floor(values.length / 2)];
}

/** Bestimmt anhand der Slider-Position welches der drei Labels aktiv ist. */
function _activeLabelForPosition(posPct) {
    if (posPct < 33.33) return 'withdraw';
    if (posPct < 66.66) return 'hold';
    return 'invest';
}

function _buildTierSlider(econ, scores) {
    const pos       = _computeSliderPosition(econ, scores);
    const active    = _activeLabelForPosition(pos);
    const lowConf   = (econ?.confidence_pct ?? 0) < 30;
    const lowClass  = lowConf ? ' low-confidence' : '';

    return `
        <div class="tier-slider${lowClass}">
            <div class="tier-slider-track">
                <div class="tier-slider-dot in-${active}" style="left:${pos.toFixed(1)}%"></div>
            </div>
            <div class="tier-slider-labels">
                <span class="tier-withdraw-label${active === 'withdraw' ? ' active' : ''}">Withdraw</span>
                <span class="tier-hold-label${active === 'hold' ? ' active' : ''}">Hold</span>
                <span class="tier-invest-label${active === 'invest' ? ' active' : ''}">Invest</span>
            </div>
        </div>`;
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

function _openRankingModal(pool, score, scores, card) {
    if (!score || score.error) return;
    const mid      = 'liquiditybot-ranking-modal';
    const eligible = pool?.settings?.cleanup?.rankingEligible !== false;
    const econ     = score.economic;
    const tierMeta = econ?.tier ? _tierMeta(econ.tier) : null;

    // Englische Tier-Begriffe im Head (konsistent mit den Slider-Labels)
    const econHeader = tierMeta
        ? `Empfehlung: ${tierMeta.labelEn}`
        : `Platz ${score.rank}/${score.of}`;
    const econHeaderClass = econ?.tier ? `tier-${econ.tier}` : `ranking-${score.verdict}`;

    showModal({
        id:    mid,
        title: `Pool-Ranking – ${pool.displayPair ?? pool.pair}`,
        body:  `
            <div class="ranking-modal">
                <div class="ranking-headline ${econHeaderClass}">
                    <div class="ranking-headline-row">
                        <span class="ranking-headline-net">${econHeader}</span>
                    </div>
                    ${_buildTierSlider(econ, scores)}
                </div>
                <div class="rk-tab-bar">
                    <button class="rk-tab active" data-tab="bewertung">Bewertung</button>
                    <button class="rk-tab" data-tab="details">Details</button>
                    <button class="rk-tab" data-tab="markt">Markt</button>
                </div>
                <div class="rk-panel" data-panel="bewertung">${_buildBewertungTab(econ, eligible)}</div>
                <div class="rk-panel" data-panel="details" hidden>${_buildDetailsTab(econ, score)}</div>
                <div class="rk-panel" data-panel="markt" hidden>${_buildMarktTab(score, scores)}</div>
                <div class="modal-feedback" id="ranking-feedback"></div>
            </div>`,
        actions: [
            { label: 'Speichern', primary: true, onClick: () => _saveRankingModal(mid, pool, card) },
            { label: 'Schließen', onClick: () => closeModal(mid) },
        ],
    });
    requestAnimationFrame(() => _initRankingModalTabs(mid));

    // Ranking-Daten beim Tab-Wechsel neu laden (alles read-only, sicheres Re-Render)
    _addModalVisibilityRefresh(mid, async () => {
        const [poolsRes, oppRes] = await Promise.all([
            fetch(`/api/pools/liquidity?t=${Date.now()}`),
            fetch(`/api/pools/liquidity/opportunity?t=${Date.now()}`),
        ]);
        if (!poolsRes.ok) return;
        const freshPools  = await poolsRes.json();
        const freshScores = oppRes.ok ? await oppRes.json() : { available: false };
        const freshPool   = freshPools.find(p => p.id === pool.id);
        const freshScore  = _findScore(freshScores, pool.id);
        if (!freshPool || !freshScore || freshScore.error) return;
        const freshEcon   = freshScore.economic;
        const freshTier   = freshEcon?.tier ? _tierMeta(freshEcon.tier) : null;
        const freshHeader = freshTier ? `Empfehlung: ${freshTier.labelEn}` : `Platz ${freshScore.rank}/${freshScore.of}`;
        const freshClass  = freshEcon?.tier ? `tier-${freshEcon.tier}` : `ranking-${freshScore.verdict}`;
        const freshEl     = getModal(mid);
        if (!freshEl) return;
        const rankingBox = freshEl.querySelector('.ranking-modal');
        if (!rankingBox) return;
        const activeTab  = freshEl.querySelector('.rk-tab.active')?.dataset.tab ?? 'bewertung';
        const eligible   = freshPool.settings?.cleanup?.rankingEligible !== false;
        rankingBox.querySelector('.ranking-headline').className = `ranking-headline ${freshClass}`;
        rankingBox.querySelector('.ranking-headline-net').textContent = freshHeader;
        rankingBox.querySelector('.ranking-headline-row').innerHTML =
            `<span class="ranking-headline-net">${freshHeader}</span>`;
        rankingBox.querySelector('[data-panel="bewertung"]').innerHTML = _buildBewertungTab(freshEcon, eligible);
        rankingBox.querySelector('[data-panel="details"]').innerHTML   = _buildDetailsTab(freshEcon, freshScore);
        rankingBox.querySelector('[data-panel="markt"]').innerHTML     = _buildMarktTab(freshScore, freshScores);
        // Aktiven Tab wieder zeigen
        rankingBox.querySelectorAll('.rk-panel').forEach(p => { p.hidden = p.dataset.panel !== activeTab; });
    });
}

async function _saveRankingModal(mid, pool, card) {
    const fb        = document.getElementById('ranking-feedback');
    const eligible  = document.getElementById('ranking-eligible')?.checked ?? true;
    if (fb) { fb.textContent = 'Speichere…'; fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/pools/liquidity/${pool.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cleanup: { rankingEligible: eligible } }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        closeModal(mid);
        _ctx.showToast?.('Ranking-Einstellung gespeichert', 'success');
        if (card) await _refreshPoolsCard(card);
    } catch (err) {
        if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
    }
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
                <button class="wm-tab active" data-fc="cfg">Allgemein</button>
                <button class="wm-tab"        data-fc="ac">Auto Compounding</button>
                <button class="wm-tab"        data-fc="send">Senden an</button>
            </div>
            <div id="fc-cfg-panel" class="fc-settings">
                <div class="settings-row" style="border:none;">
                    <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Mindestbetrag
                        <span class="info-tip-label"
                            data-tooltip-title="Mindestbetrag"
                            data-tooltip-content="Fees werden nur geclaimed wenn der Gesamtwert diesen Betrag erreicht hat.">&#9432;</span>
                    </span>
                    <select class="modal-select" id="ac-min-claim" style="width:auto;">
                        ${minOptions}
                    </select>
                </div>
                <div class="settings-row" style="border:none; opacity:0.55;">
                    <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Claim-Intervall
                        <span class="info-tip-label"
                            data-tooltip-title="Claim-Intervall"
                            data-tooltip-content="Der Bot prüft alle 10 Minuten ob Fees geclaimed werden sollen. Dieser Wert ist nicht konfigurierbar.">&#9432;</span>
                    </span>
                    <span style="font-size:0.85rem;">10 Minuten</span>
                </div>
            </div>
            <div id="fc-ac-panel" class="fc-settings" hidden>
                <div class="settings-row" style="border:none;">
                    <span class="settings-label">Aktiviert</span>
                    <label class="toggle-switch">
                        <input type="checkbox" id="ac-enabled" ${acEnabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="settings-row ac-dependent" style="border:none; opacity:${acEnabled ? '1' : '0.4'};">
                    <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Reinvest-Anteil
                        <span class="info-tip-label"
                            data-tooltip-title="Reinvest-Anteil"
                            data-tooltip-content="Anteil der geclaimten Fees der sofort wieder in den Pool reinvestiert wird. Der Rest verbleibt im Wallet oder wird über „Senden an" weitergeleitet.">&#9432;</span>
                    </span>
                    <select class="modal-select" id="ac-fraction" ${acEnabled ? '' : 'disabled'} style="width:auto;">
                        ${fractionOptions}
                    </select>
                </div>
            </div>
            <div id="fc-send-panel" class="fc-settings" hidden>
                <p class="wallet-hint" id="fc-send-hint" style="margin: 0.4rem 0 0.6rem;">${sendDisabled ? '⚠️ Nur verfügbar wenn Auto Compounding &lt; 100% oder deaktiviert.' : ''}</p>
                <div class="settings-row" style="border:none; opacity:${sendDisabled ? '0.4' : '1'};">
                    <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Swap → USDC
                        <span class="info-tip-label"
                            data-tooltip-title="Swap → USDC"
                            data-tooltip-content="Verbleibende Coins vor dem Transfer automatisch in USDC tauschen.">&#9432;</span>
                    </span>
                    <label class="toggle-switch toggle-sm">
                        <input type="checkbox" id="ac-swap" ${swapVal ? 'checked' : ''} ${sendDisabled ? 'disabled' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="settings-row" style="border:none; opacity:${sendDisabled ? '0.4' : '1'};">
                    <span class="settings-label">Empfänger</span>
                    <select class="modal-select" id="ac-sendto" ${sendDisabled ? 'disabled' : ''}>
                        <option value="">– Nicht senden –</option>
                        ${_addrOptions(addrs, sendToVal)}
                    </select>
                </div>
            </div>
            <div class="modal-feedback" id="ac-feedback"></div>`,
        actions: [
            { label: 'Speichern', primary: true, onClick: () => _saveFeeClaimModal(mid, pool, card) },
            { label: 'Schließen', onClick: () => closeModal(mid) },
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
    if (fb) { fb.textContent = 'Speichere…'; fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/pools/liquidity/${pool.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autoCompound: data }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        closeModal(mid);
        _ctx.showToast?.('Fee Claim gespeichert', 'success');
        await _refreshPoolsCard(card);
    } catch (err) {
        if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
    }
}

// ── SL / TP – Modal (zwei Tabs) ───────────────────────────────────────────────

function _openSLTPModal(pool, addrs, card) {
    const mid = 'liquiditybot-sltp-modal';

    const saveAction = { label: 'Speichern', primary: true, onClick: null };

    showModal({
        id:    mid,
        title: `Risk-Management – ${pool.displayPair ?? pool.pair}`,
        body:  `
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-wm="ts">Trailing Stop</button>
                <button class="wm-tab"        data-wm="tvl">TVL</button>
                <button class="wm-tab"        data-wm="sl">Score Limit</button>
            </div>
            <div id="sltp-ts"  class="sltp-settings ts-settings">${_buildTrailingStopPanel(pool, addrs)}</div>
            <div id="sltp-tvl" class="sltp-settings" hidden>${_buildTvlPanel(pool, addrs)}</div>
            <div id="sltp-sl"  hidden>${_buildScoreLimitPanel(pool, addrs)}</div>`,
        actions: [
            saveAction,
            { label: 'Schließen', onClick: () => closeModal(mid) },
        ],
    });

    const backdrop = getModal(mid);
    if (!backdrop) return;

    const saveBtn = backdrop.querySelector('[data-mi="0"]');

    function setSaveTarget(which) {
        if (which === 'sl') {
            saveAction.onClick = () => _saveScoreLimitPanel(pool, addrs, card, getModal(mid));
        } else if (which === 'tvl') {
            saveAction.onClick = () => _saveTvlPanel(pool, card, getModal(mid));
        } else {
            saveAction.onClick = () => _saveTrailingStopPanel(pool, card, getModal(mid));
        }
        if (saveBtn) saveBtn.textContent = 'Speichern';
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

    // Trailing-Stop: Live-Update wenn Drawdown-Schwelle geändert wird
    backdrop.querySelector('#ts-threshold')?.addEventListener('input', e => {
        const thr = parseFloat(e.target.value);
        if (!Number.isFinite(thr) || thr < 1) return;
        const sb = backdrop.querySelector('.ts-status-block[data-hwm]');
        if (!sb) return;
        const hwmUsd     = parseFloat(sb.dataset.hwm);
        const currentUsd = parseFloat(sb.dataset.current);
        if (!(hwmUsd > 0)) return;
        const trigger = hwmUsd * (1 - thr / 100);
        const fmt     = v => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

        // Puffer aktualisieren
        const bufferUsd = currentUsd - trigger;
        const bufferPct = bufferUsd / hwmUsd * 100;
        const bufferOk  = bufferUsd > 0;
        const pufferEl  = backdrop.querySelector('#ts-puffer');
        if (pufferEl) {
            pufferEl.style.color = bufferOk ? '#86efac' : '#fca5a5';
            pufferEl.innerHTML   = bufferOk
                ? `Puffer: ${fmt(bufferUsd)}&thinsp;USDC&ensp;/&ensp;${bufferPct.toFixed(1)}&thinsp;%`
                : `⚠ Auslöser überschritten`;
        }
    });

    // Trailing-Stop: Höchststand zurücksetzen
    backdrop.querySelector('#ts-hwm-reset-btn')?.addEventListener('click', async () => {
        const btn = backdrop.querySelector('#ts-hwm-reset-btn');
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
                const thr        = parseFloat(backdrop.querySelector('#ts-threshold')?.value ?? '33');
                const fmt        = v => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                if (currentUsd > 0 && Number.isFinite(thr)) {
                    const newTrigger = currentUsd * (1 - thr / 100);
                    const bufferUsd  = currentUsd - newTrigger;
                    const bufferPct  = thr; // bufferUsd / currentUsd * 100 == thr

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

                    // Puffer
                    const pufferEl = sb.querySelector('#ts-puffer');
                    if (pufferEl) {
                        pufferEl.style.color = '#86efac';
                        pufferEl.innerHTML   = `Puffer: ${fmt(bufferUsd)}&thinsp;USDC&ensp;/&ensp;${bufferPct.toFixed(1)}&thinsp;%`;
                    }
                }
            }

            _ctx.showToast?.('Referenzwert zurückgesetzt', 'success');
        } catch (err) {
            _ctx.showToast?.(`Fehler: ${err.message}`, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    });

    // Trailing-Stop-Panel: Toggle steuert Sichtbarkeit der Folgezeilen
    backdrop.querySelector('#ts-enabled')?.addEventListener('change', e => {
        const on = e.target.checked;
        backdrop.querySelectorAll('.ts-dependent').forEach(el => { el.style.opacity = on ? '1' : '0.4'; });
        const thr      = backdrop.querySelector('#ts-threshold');
        const minVal   = backdrop.querySelector('#ts-min-value');
        const swap     = backdrop.querySelector('#ts-swap');
        const send     = backdrop.querySelector('#ts-sendto');
        const cooldown = backdrop.querySelector('#ts-cooldown');
        if (thr)      thr.disabled      = !on;
        if (minVal)   minVal.disabled   = !on;
        if (swap)     swap.disabled     = !on;
        if (send)     send.disabled     = !on;
        if (cooldown) cooldown.disabled = !on;
    });

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

function _buildTrailingStopStatusBlock(pool, threshold) {
    const st = pool.trailingStopStatus;
    if (!st || !(st.hwmUsd > 0) || !(st.currentUsd > 0)) {
        return `
        <div class="ts-status-block">
            <p class="wallet-hint" style="font-size:0.78rem; margin:0;">
                ℹ Referenzwert wird beim nächsten Snapshot (≤10 Min) etabliert.
            </p>
        </div>`;
    }

    const triggerUsd = st.hwmUsd * (1 - threshold / 100);
    const fmt        = v => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Timestamp nur per Hover sichtbar
    const snapshotDate = st.snapshotAt ? new Date(st.snapshotAt) : null;
    const standTxt = snapshotDate
        ? snapshotDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
          + ' ' + snapshotDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'
        : '–';
    const hoverAttrs = `data-tooltip-title="Letztes Update" data-tooltip-content="${standTxt}"`;

    // Puffer
    const bufferUsd = st.currentUsd - triggerUsd;
    const bufferPct = bufferUsd / st.hwmUsd * 100;
    const bufferOk  = bufferUsd > 0;

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
                Liquidation: <span id="ts-liquidation-val" style="cursor:default;" ${hoverAttrs}>${fmt(triggerUsd)}</span> USDC
            </span>
            <span style="color:#94a3b8; white-space:nowrap;">
                Höchststand: <span style="cursor:default;" ${hoverAttrs}>${fmt(st.hwmUsd)}</span> USDC
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
                        Aktuell: <span style="cursor:default;" ${hoverAttrs}>${fmt(st.currentUsd)}</span> USDC
                    </div>
                </div>
            </div>
            <div style="width:2px; height:14px; background:#94a3b8; flex-shrink:0; border-radius:1px;"></div>
        </div>

        <!-- Puffer (Abstand Aktuell zu Liquidation) -->
        <div id="ts-puffer" style="margin-top:2.0rem; font-size:0.71rem; color:${bufferOk ? '#86efac' : '#fca5a5'};">
            ${bufferOk
                ? `Puffer: ${fmt(bufferUsd)}&thinsp;USDC&ensp;/&ensp;${bufferPct.toFixed(1)}&thinsp;%`
                : `⚠ Auslöser überschritten`}
        </div>

        <!-- Reset-Button -->
        <div style="margin-top:0.9rem; text-align:right;">
            <button id="ts-hwm-reset-btn" class="btn btn-sm"
                style="font-size:0.72rem; padding:0.25rem 0.65rem; opacity:0.75;"
                title="Höchststand auf den aktuellen Pool-Wert zurücksetzen">
                ↺ Höchststand zurücksetzen
            </button>
        </div>
    </div>`;
}

function _fmtUsdExact(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '–';
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDC';
}

function _buildTrailingStopPanel(pool, addrs = []) {
    const ts = pool.settings.trailingStop ?? { enabled: true, thresholdPct: 33, minimumValueUsd: null, autoSwapToUSDC: true, sendTo: '', cooldownHours: 1 };
    const on = !!ts.enabled;
    const threshold = Number.isFinite(Number(ts.thresholdPct)) ? Number(ts.thresholdPct) : 33;
    const cooldownHours = Number.isFinite(Number(ts.cooldownHours)) ? Number(ts.cooldownHours) : 1;
    const minValueUsd = (ts.minimumValueUsd != null && Number(ts.minimumValueUsd) > 0) ? Math.round(Number(ts.minimumValueUsd)) : 0;
    const currentUsd = pool.currentValue ?? null;
    const statusBlock = on ? _buildTrailingStopStatusBlock(pool, threshold) : '';
    return `
        <div class="settings-row" style="border:none;">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Trailing Stop aktiv
                <span class="info-tip-label"
                    data-tooltip-title="Trailing Stop"
                    data-tooltip-content="Zieht den Stop-Wert dynamisch nach: jeder neue Pool-Höchststand (High-Water-Mark) wird gemerkt. Fällt der aktuelle Pool-Wert um den eingestellten Prozentsatz unter die HWM, wird die Position geschlossen.||Snapshot-Quelle: position_snapshots (alle 5-10 Min, lp_value_usd inkl. offener Fees).||Einmalige Aktion — kein automatischer Wiedereinstieg. Cleanup im Modus „Bester Pool" reinvestiert das freie Kapital im nächsten Lauf.||HWM wird beim Öffnen einer neuen Position zurückgesetzt.">&#9432;</span>
            </span>
            <label class="toggle-switch">
                <input type="checkbox" id="ts-enabled" ${on ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row ts-dependent" style="opacity:${on ? '1' : '0.4'};"
             data-current-value="${currentUsd ?? ''}">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Pool Mindestwert
                <span class="info-tip-label"
                    data-tooltip-title="Pool Mindestwert"
                    data-tooltip-content="Fällt der Pool-Betrag unter diesen USDC Betrag, wird er geschlossen.||Tipp: Sinnvoll als absoluter Kapitalschutz, unabhängig vom prozentualen Drawdown.">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short" id="ts-min-value"
                    type="number" min="0" step="1" value="${minValueUsd}"
                    ${on ? '' : 'disabled'}>
                <span class="input-unit">USDC</span>
            </div>
        </div>
        <div class="settings-row ts-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Drawdown-Schwelle
                <span class="info-tip-label"
                    data-tooltip-title="Drawdown-Schwelle"
                    data-tooltip-content="Empfehlung: 25–40 %. Position wird einmalig komplett geschlossen.||Ohne Send-Adresse bleiben die Coins im Wallet und der nächste Cleanup-Lauf im Modus „Bester Pool" reinvestiert sie automatisch.">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short" id="ts-threshold"
                    type="number" min="1" max="90" step="1" value="${threshold}"
                    ${on ? '' : 'disabled'}>
                <span class="input-unit">%</span>
            </div>
        </div>
        <div class="settings-row ts-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Swap → USDC
                <span class="info-tip-label"
                    data-tooltip-title="Swap → USDC"
                    data-tooltip-content="Coins nach Entnahme automatisch in USDC tauschen.">&#9432;</span>
            </span>
            <label class="toggle-switch toggle-sm">
                <input type="checkbox" id="ts-swap" ${ts.autoSwapToUSDC ? 'checked' : ''} ${on ? '' : 'disabled'}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row ts-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label">Senden an</span>
            <select class="modal-select" id="ts-sendto" ${on ? '' : 'disabled'}>
                <option value="">– Nicht senden –</option>
                ${_addrOptions(addrs, ts.sendTo ?? '')}
            </select>
        </div>
        <div class="settings-row ts-dependent" style="border:none; opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Cleanup-Cooldown
                <span class="info-tip-label"
                    data-tooltip-title="Cleanup-Cooldown"
                    data-tooltip-content="Nach einer Liquidation durch den Trailing Stop ist dieser Pool für die eingestellte Zeit für automatisierte Cleanup-Zuweisungen gesperrt.||Manuelle Einzahlungen bleiben jederzeit möglich.||Cooldown-Start: Zeitpunkt der Liquidation.">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short" id="ts-cooldown"
                    type="number" min="1" max="24" step="1" value="${cooldownHours}"
                    ${on ? '' : 'disabled'}>
                <span class="input-unit">h</span>
            </div>
        </div>
        ${statusBlock}
        <div class="modal-feedback" id="ts-feedback"></div>`;
}

async function _saveTrailingStopPanel(pool, card, modalEl) {
    const fb = document.getElementById('ts-feedback');
    const enabled        = document.getElementById('ts-enabled')?.checked ?? false;
    const thresholdRaw   = document.getElementById('ts-threshold')?.value ?? '33';
    const minValueRaw    = document.getElementById('ts-min-value')?.value ?? '';
    const autoSwapToUSDC = document.getElementById('ts-swap')?.checked ?? false;
    const sendTo         = document.getElementById('ts-sendto')?.value ?? '';
    const cooldownRaw    = document.getElementById('ts-cooldown')?.value ?? '1';

    const threshold = parseFloat(thresholdRaw);
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 90) {
        if (fb) { fb.textContent = 'Drawdown-Schwelle muss zwischen 1 und 90 % liegen.'; fb.className = 'modal-feedback error'; }
        return;
    }

    // Pool Mindestwert: 0 = deaktiviert; sonst ganzzahlig > 0 und < aktueller Pool-Wert
    // Validierung nur wenn Trailing Stop aktiv – beim Deaktivieren ist der Wert irrelevant
    const parsedMin = parseInt(minValueRaw, 10);
    let minimumValueUsd = null;
    if (Number.isFinite(parsedMin) && parsedMin > 0) {
        if (enabled) {
            const currentUsd = pool.currentValue ?? null;
            if (currentUsd !== null && parsedMin >= currentUsd) {
                const fmt = v => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                if (fb) { fb.textContent = `Pool Mindestwert (${parsedMin} USDC) muss kleiner sein als der aktuelle Pool-Wert (${fmt(currentUsd)} USDC).`; fb.className = 'modal-feedback error'; }
                return;
            }
        }
        minimumValueUsd = parsedMin;
    }

    const cooldownHours = parseInt(cooldownRaw, 10);
    if (!Number.isFinite(cooldownHours) || cooldownHours < 1 || cooldownHours > 24) {
        if (fb) { fb.textContent = 'Cleanup-Cooldown muss zwischen 1 und 24 h liegen.'; fb.className = 'modal-feedback error'; }
        return;
    }

    if (fb) { fb.textContent = 'Speichere…'; fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/pools/liquidity/${pool.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trailingStop: { enabled, thresholdPct: threshold, minimumValueUsd, autoSwapToUSDC, sendTo, cooldownHours } }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        if (fb) { fb.textContent = '✓ Gespeichert'; fb.className = 'modal-feedback success'; }
        _ctx.showToast?.('Trailing-Stop-Einstellungen gespeichert', 'success');

        // Gauge + Puffer im offenen Modal mit gespeichertem Threshold aktualisieren
        const sb = modalEl?.querySelector('.ts-status-block[data-hwm]');
        if (sb) {
            const hwmUsd     = parseFloat(sb.dataset.hwm);
            const currentUsd = parseFloat(sb.dataset.current);
            const fmt        = v => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            if (hwmUsd > 0) {
                const trigger   = hwmUsd * (1 - threshold / 100);
                const barSpan   = hwmUsd - trigger;
                const bufferUsd = currentUsd - trigger;
                const bufferPct = bufferUsd / hwmUsd * 100;
                const bufferOk  = bufferUsd > 0;
                const newPctN   = barSpan > 0 ? Math.max(0, Math.min(100, (currentUsd - trigger) / barSpan * 100)) : 0;

                const valEl    = modalEl.querySelector('#ts-liquidation-val');
                const marker   = modalEl.querySelector('#ts-curr-marker');
                const pufferEl = modalEl.querySelector('#ts-puffer');

                if (valEl) valEl.textContent = fmt(trigger);
                if (marker) {
                    marker.style.left      = newPctN.toFixed(1) + '%';
                    marker.style.transform = `translateX(${newPctN > 80 ? '-100%' : newPctN < 20 ? '0%' : '-50%'})`;
                }
                if (pufferEl) {
                    pufferEl.style.color = bufferOk ? '#86efac' : '#fca5a5';
                    pufferEl.innerHTML   = bufferOk
                        ? `Puffer: ${fmt(bufferUsd)}&thinsp;USDC&ensp;/&ensp;${bufferPct.toFixed(1)}&thinsp;%`
                        : `⚠ Auslöser überschritten`;
                }
            }
        }

        await _refreshPoolsCard(card);
    } catch (err) {
        if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
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
        scoreHtml = `<span style="color:var(--text-muted);font-size:0.82rem;">Premium 🔒</span>`;
    } else if (currentScore === null) {
        scoreHtml = `<span style="color:var(--text-muted);font-size:0.82rem;">keine Daten</span>`;
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
            scoreHtml += `<div style="font-size:0.75rem;color:var(--danger);margin-top:0.15rem;">${displayCount}&thinsp;/&thinsp;${minConsecutive} Zyklen unterschritten</div>`;
        }
    }

    let nextCheckHtml = '';
    if (lastCheckedAt) {
        const d  = new Date(lastCheckedAt + checkIntervalMs);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        nextCheckHtml = `<span style="font-size:0.75rem;color:var(--text-muted);">Nächster Check:&nbsp;${hh}:${mm}&nbsp;Uhr</span>`;
    }

    return `
        <div id="sl-status-block" data-score="${currentScore ?? ''}"
             style="margin-top:0.6rem;padding:0.55rem 0.75rem;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;display:flex;justify-content:space-between;align-items:flex-end;gap:0.5rem;">
            <div>
                <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);margin-bottom:0.25rem;">Aktueller Score</div>
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
            🔒&nbsp; Der Opportunity Score wird über den Premium-Datendienst geliefert und ist in
            dieser Installation nicht aktiv. Die Einstellung wird gespeichert, <strong>löst aber
            aktuell nicht aus</strong> — Trailing Stop und TVL-Schutz arbeiten unabhängig davon.
        </div>`;
    }
    if (pool.scoreSource === 'delivered' && pool.scoreStale) {
        return `<div style="margin-bottom:0.75rem;padding:0.6rem 0.75rem;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;font-size:0.78rem;color:var(--text-muted);line-height:1.5;">
            ⚠️&nbsp; Die gelieferten Premium-Score-Daten sind veraltet (&gt;2h). Score Limit ist
            bis zur nächsten Lieferung ausgesetzt.
        </div>`;
    }
    return '';
}

function _buildScoreLimitPanel(pool, addrs) {
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
                Aktiv
                <span class="info-tip-label"
                    data-tooltip-title="Score Limit"
                    data-tooltip-content="Fällt der Opportunity Score des Pools unter die eingestellte Schwelle, wird das gesamte Kapital automatisch abgezogen.||Gezeigt und verglichen wird der Score OHNE Volumen-Malus – dieser Malus darf nie einen Exit auslösen, deshalb kann der hier angezeigte Wert vom Dashboard-Score abweichen.||Null-Score (fehlende Daten) → kein Auslösen.||Einmalige Aktion – kein automatischer Wiedereinstieg.">&#9432;</span>
            </span>
            <label class="toggle-switch">
                <input type="checkbox" id="sl-enabled" ${on ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row sl-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Opportunity Score unter
                <span class="info-tip-label"
                    data-tooltip-title="Opportunity Score unter"
                    data-tooltip-content="Empfehlung: Schwelle 25–35. Position wird einmalig komplett geschlossen.||Ohne Send-Adresse bleiben die Coins im Wallet und der nächste Cleanup-Lauf im Modus „Bester Pool" reinvestiert sie automatisch.">&#9432;</span>
            </span>
            <input class="modal-input input-short" id="sl-minscore"
                type="number" min="0" max="100" step="1" value="${minScore}"
                ${on ? '' : 'disabled'}>
        </div>
        <div class="settings-row sl-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Swap → USDC
                <span class="info-tip-label"
                    data-tooltip-title="Swap → USDC"
                    data-tooltip-content="Coins nach Entnahme automatisch in USDC tauschen.">&#9432;</span>
            </span>
            <label class="toggle-switch toggle-sm">
                <input type="checkbox" id="sl-swap" ${s.swapToUsdc !== false ? 'checked' : ''} ${on ? '' : 'disabled'}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row sl-dependent" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label">Senden an</span>
            <select class="modal-select" id="sl-sendto" ${on ? '' : 'disabled'}>
                <option value="">– Nicht senden –</option>
                ${_addrOptions(addrs, s.sendTo ?? '')}
            </select>
        </div>
        <div class="settings-row sl-dependent" style="border:none; opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Cleanup-Cooldown
                <span class="info-tip-label"
                    data-tooltip-title="Cleanup-Cooldown"
                    data-tooltip-content="Nach einer Liquidation durch das Score Limit ist dieser Pool für die eingestellte Zeit für automatisierte Cleanup-Zuweisungen gesperrt.||Manuelle Einzahlungen bleiben jederzeit möglich.||Cooldown-Start: Zeitpunkt der Liquidation.">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short" id="sl-cooldown"
                    type="number" min="1" max="24" step="1" value="${cooldownHours}"
                    ${on ? '' : 'disabled'}>
                <span class="input-unit">h</span>
            </div>
        </div>
        <div style="margin-top:0.9rem;padding:0.6rem 0.75rem;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;font-size:0.78rem;color:var(--text-muted);line-height:1.5;">
            ${minConsecutive <= 1
                ? `&#9432;&nbsp; Liquidation erfolgt <strong>sofort</strong> im ersten Zyklus, in dem der Score unter <strong>${minScore}</strong> liegt
                   <em>und</em> die Position dabei nicht Out-of-Range ist.`
                : `&#9432;&nbsp; Liquidation erfolgt nur, wenn der Score mindestens <strong>${minConsecutive} Zyklen&nbsp;in Folge</strong> unter <strong>${minScore}</strong> liegt
                   <em>und</em> die Position dabei nicht Out-of-Range ist.
                   OOR-Zyklen setzen den Zähler zurück.`}
        </div>
        ${_buildSlStatusBlock(pool, minScore, minConsecutive)}
        <div class="modal-feedback" id="sl-feedback"></div>
        </div>`;
}

async function _saveScoreLimitPanel(pool, addrs, card, backdrop) {
    const panel    = backdrop?.querySelector('#sltp-sl');
    const fb       = panel?.querySelector('#sl-feedback');
    const enabled       = panel?.querySelector('#sl-enabled')?.checked ?? false;
    const minScore      = parseFloat(panel?.querySelector('#sl-minscore')?.value ?? '30');
    const cooldownHours = parseInt(panel?.querySelector('#sl-cooldown')?.value ?? '1', 10);
    if (!Number.isFinite(cooldownHours) || cooldownHours < 1 || cooldownHours > 24) {
        if (fb) { fb.textContent = 'Cleanup-Cooldown muss zwischen 1 und 24 h liegen.'; fb.className = 'modal-feedback error'; }
        return;
    }
    const data = {
        enabled,
        minScore:     Number.isFinite(minScore) ? minScore : 30,
        swapToUsdc:   panel?.querySelector('#sl-swap')?.checked ?? true,
        sendTo:       panel?.querySelector('#sl-sendto')?.value ?? '',
        cooldownHours,
    };

    if (fb) { fb.textContent = 'Speichere…'; fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/pools/liquidity/${pool.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scoreLimit: data }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        _ctx.showToast?.('Score Limit gespeichert', 'success');

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
        if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
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

/** Eine Stufe (L1 oder L2) als Block rendern */
function _buildTvlLevel(n, lvl, defaultThreshold) {
    const on        = !!lvl.enabled;
    const threshold = lvl.thresholdUsd != null ? lvl.thresholdUsd : (defaultThreshold ?? '');
    const pct       = Number.isFinite(Number(lvl.withdrawPct)) ? Number(lvl.withdrawPct) : (n === 1 ? 50 : 100);
    const dep       = `tvl${n}-dependent`;
    return `
        <div class="settings-row" style="border:none;">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;font-weight:600;">
                Stufe ${n} aktiv
                <span class="info-tip-label"
                    data-tooltip-title="TVL-Schutz Stufe ${n}"
                    data-tooltip-content="${n === 1
                        ? 'Erste Eskalationsstufe (höhere Schwelle). Fällt der Pool-TVL unter diesen Wert, wird der eingestellte Anteil abgezogen.||Optional – kann deaktiviert werden. Dann reagiert nur Stufe 2.'
                        : 'Zweite Eskalationsstufe (tiefere Schwelle). Default je Pool aktiv: 100 % abziehen und in USDC tauschen.||Die Schwelle muss kleiner als bei Stufe 1 sein.'}">&#9432;</span>
            </span>
            <label class="toggle-switch">
                <input type="checkbox" id="tvl${n}-enabled" ${on ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row ${dep}" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                TVL-Schwelle
                <span class="info-tip-label"
                    data-tooltip-title="TVL-Schwelle Stufe ${n}"
                    data-tooltip-content="Pool-TVL in USDC. Wird dieser Wert unterschritten, tritt die Aktion in Kraft.">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input" id="tvl${n}-threshold" style="width:8rem;"
                    type="number" min="0" step="1000" value="${threshold}" ${on ? '' : 'disabled'}>
                <span class="input-unit" id="tvl${n}-threshold-fmt" style="min-width:5rem;">${_fmtUsd(Number(threshold))}</span>
            </div>
        </div>
        <div class="settings-row ${dep}" style="opacity:${on ? '1' : '0.4'};">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Aktion
                <span class="info-tip-label"
                    data-tooltip-title="Aktion Stufe ${n}"
                    data-tooltip-content="Anteil des Kapitals, der bei Unterschreiten aus dem Pool gezogen wird.||Sind beide Stufen aktiv, muss die Summe beider Aktionen 100 % ergeben – Stufe 2 wird dann automatisch ergänzt.">&#9432;</span>
            </span>
            <select class="modal-select" id="tvl${n}-pct" style="width:6rem;" ${on ? '' : 'disabled'}>
                ${_pctOptions(pct)}
            </select>
        </div>`;
}

function _buildTvlPanel(pool, addrs = []) {
    const tp = pool.settings.tvlProtection ?? {};
    const l1 = tp.level1 ?? { enabled: false, thresholdUsd: null, withdrawPct: 50  };
    const l2 = tp.level2 ?? { enabled: true,  thresholdUsd: null, withdrawPct: 100 };
    const cooldownHours = Number.isFinite(Number(tp.cooldownHours)) ? Number(tp.cooldownHours) : 1;

    const currentTvl = pool.currentTvl != null
        ? `<strong style="color:var(--text);">${_fmtUsd(pool.currentTvl)}</strong>`
        : `<strong style="color:var(--text-muted);">keine Daten</strong>`;
    // Aktivierungs-TVL als Klammerwert mit eigenem Tooltip (nur wenn vorhanden)
    const activationTvl = tp.tvlAtActivation != null
        ? `<span style="color:var(--text-muted);font-weight:400;">(${_fmtUsd(tp.tvlAtActivation)}
               <span class="info-tip-label"
                   data-tooltip-title="TVL bei Aktivierung"
                   data-tooltip-content="Pool-TVL zum Zeitpunkt des ersten Deposits in diesen Pool. Dient als Referenz für die Schwellenwerte unten.">&#9432;</span>)</span>`
        : '';

    return `
        <div class="sltp-settings">
        <div class="settings-row" style="background:var(--bg-soft, rgba(255,255,255,0.03)); border-radius:8px; padding:0.6rem 0.8rem;">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Aktueller TVL
                <span class="info-tip-label"
                    data-tooltip-title="Aktueller TVL"
                    data-tooltip-content="Aktueller Total Value Locked des Pools (Dashboard-Wert).">&#9432;</span>
            </span>
            <span style="text-align:right;">${currentTvl} ${activationTvl}</span>
        </div>
        ${_buildTvlLevel(1, l1, pool.tvlWarnDefault)}
        ${_buildTvlLevel(2, l2, pool.tvlExitDefault)}
        <div class="settings-row" style="border-top:1px solid var(--border, #2a2a3a);">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Swap → USDC
                <span class="info-tip-label"
                    data-tooltip-title="Swap → USDC"
                    data-tooltip-content="Coins nach jeder Entnahme (Stufe 1 und Stufe 2) automatisch in USDC tauschen.">&#9432;</span>
            </span>
            <label class="toggle-switch toggle-sm">
                <input type="checkbox" id="tvl-swap" ${tp.swapToUsdc !== false ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Senden an
                <span class="info-tip-label"
                    data-tooltip-title="Senden an"
                    data-tooltip-content="Empfänger-Adresse für das entnommene Kapital (gilt für beide Stufen).||Ohne Adresse bleibt das Kapital im Wallet.">&#9432;</span>
            </span>
            <select class="modal-select" id="tvl-sendto">
                <option value="">– Nicht senden –</option>
                ${_addrOptions(addrs, tp.sendTo ?? '')}
            </select>
        </div>
        <div class="settings-row" style="opacity:1;">
            <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                Cleanup-Cooldown
                <span class="info-tip-label"
                    data-tooltip-title="Cleanup-Cooldown"
                    data-tooltip-content="Nach einem teilweisen TVL-Schutz-Abzug ist der Pool für die eingestellte Zeit für automatisierte Cleanup-Zuweisungen gesperrt.||Bei 100 %-Abzug ist der Pool ohnehin leer.">&#9432;</span>
            </span>
            <div class="input-unit-row">
                <input class="modal-input input-short" id="tvl-cooldown"
                    type="number" min="1" max="24" step="1" value="${cooldownHours}">
                <span class="input-unit">h</span>
            </div>
        </div>
        <div id="tvl-sum-hint" style="font-size:0.8rem;text-align:right;padding:0.2rem 0;"></div>
        <div class="modal-feedback" id="tvl-feedback"></div>
        </div>`;
}

/** Verdrahtet Toggle-Sichtbarkeit, Schwellen-Formatierung und die Summen-Kopplung. */
function _wireTvlPanel(backdrop) {
    const panel = backdrop.querySelector('#sltp-tvl');
    if (!panel) return;

    const getEl = id => panel.querySelector('#' + id);

    // Sichtbarkeit/Disabled einer Stufe an ihren Toggle koppeln
    function syncLevelEnabled(n) {
        const on = getEl(`tvl${n}-enabled`)?.checked ?? false;
        panel.querySelectorAll(`.tvl${n}-dependent`).forEach(el => { el.style.opacity = on ? '1' : '0.4'; });
        ['threshold', 'pct'].forEach(suf => {
            const el = getEl(`tvl${n}-${suf}`);
            if (el) el.disabled = !on;
        });
    }

    // Wenn beide Stufen aktiv: L2-Aktion = 100 − L1, readonly. Sonst L2 frei wählbar.
    function syncSum() {
        const l1on  = getEl('tvl1-enabled')?.checked ?? false;
        const l2on  = getEl('tvl2-enabled')?.checked ?? false;
        const l1pct = parseInt(getEl('tvl1-pct')?.value ?? '0', 10);
        const l2sel = getEl('tvl2-pct');
        const hint  = getEl('tvl-sum-hint');

        if (l1on && l2on) {
            const rest = 100 - l1pct;
            if (l2sel) { l2sel.value = String(rest); l2sel.disabled = true; }
            if (hint) {
                hint.style.color   = 'var(--success, #86efac)';
                hint.textContent   = `Summe: ${l1pct} % + ${rest} % = 100 % (Stufe 2 automatisch ergänzt)`;
            }
        } else {
            if (l2sel) l2sel.disabled = !l2on;
            if (hint) hint.textContent = '';
        }
    }

    [1, 2].forEach(n => {
        getEl(`tvl${n}-enabled`)?.addEventListener('change', () => { syncLevelEnabled(n); syncSum(); });
        // Schwellen-Formatierung live
        getEl(`tvl${n}-threshold`)?.addEventListener('input', e => {
            const fmt = getEl(`tvl${n}-threshold-fmt`);
            if (fmt) fmt.textContent = _fmtUsd(Number(e.target.value));
        });
    });
    getEl('tvl1-pct')?.addEventListener('change', syncSum);

    syncSum();
}

async function _saveTvlPanel(pool, card, backdrop) {
    const panel = backdrop?.querySelector('#sltp-tvl');
    const fb    = panel?.querySelector('#tvl-feedback');
    const getEl = id => panel?.querySelector('#' + id);

    function readLevel(n) {
        return {
            enabled:      getEl(`tvl${n}-enabled`)?.checked ?? false,
            thresholdUsd: parseFloat(getEl(`tvl${n}-threshold`)?.value ?? ''),
            withdrawPct:  parseInt(getEl(`tvl${n}-pct`)?.value ?? '0', 10),
        };
    }
    const level1 = readLevel(1);
    const level2 = readLevel(2);
    const swapToUsdc    = getEl('tvl-swap')?.checked ?? false;
    const sendTo        = getEl('tvl-sendto')?.value ?? '';
    const cooldownHours = parseInt(getEl('tvl-cooldown')?.value ?? '1', 10);

    // ── Client-seitige Validierung (Backend prüft erneut) ──
    const setErr = msg => { if (fb) { fb.textContent = msg; fb.className = 'modal-feedback error'; } };
    if (!Number.isFinite(cooldownHours) || cooldownHours < 1 || cooldownHours > 24)
        return setErr('Cleanup-Cooldown muss zwischen 1 und 24 h liegen.');
    if (level1.enabled && !(level1.thresholdUsd > 0))
        return setErr('Stufe 1: TVL-Schwelle muss größer als 0 sein.');
    if (level2.enabled && !(level2.thresholdUsd > 0))
        return setErr('Stufe 2: TVL-Schwelle muss größer als 0 sein.');
    if (level1.enabled && level2.enabled && level1.thresholdUsd <= level2.thresholdUsd)
        return setErr('Schwelle Stufe 1 muss größer als Stufe 2 sein (Eskalation).');
    if (level1.enabled && level2.enabled && (level1.withdrawPct + level2.withdrawPct) !== 100)
        return setErr('Aktionen von Stufe 1 und Stufe 2 müssen zusammen 100 % ergeben.');

    if (fb) { fb.textContent = 'Speichere…'; fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/pools/liquidity/${pool.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tvlProtection: { level1, level2, swapToUsdc, sendTo, cooldownHours } }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
        if (fb) { fb.textContent = '✓ Gespeichert'; fb.className = 'modal-feedback success'; }
        _ctx.showToast?.('TVL-Schutz gespeichert', 'success');
        setTimeout(() => { if (fb) fb.textContent = ''; }, 2000);
        await _refreshPoolsCard(card);
    } catch (err) {
        setErr(`Fehler: ${err.message}`);
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
    if (s === 'active')   return 'Aktiv';
    if (s === 'inactive') return 'Gestoppt';
    if (s === 'failed')   return 'Fehler';
    return s ?? 'Unbekannt';
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
    return v.toLocaleString('de-DE', { maximumFractionDigits: decimals });
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
        return `<div class="modal-feedback err" style="display:block;">${_esc(dryRun?.error ?? 'Vorschau fehlgeschlagen')}</div>`;
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
        <div><strong>Vorschau:</strong></div>
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
    const fmtP = (v, d = 2) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
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
        return Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
    };

    el.innerHTML = `
        <div style="font-size:0.73rem; color:#64748b; margin-bottom:0.3rem;">Aktuelle Zusammensetzung</div>
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
                Der Range Advisor empfiehlt eine engere Range für diesen Pool.
                Die aktuelle Position wird <strong>geschlossen und neu eröffnet</strong>.
            </p>
            <table style="width:100%; font-size:0.85rem; border-collapse:collapse; margin-bottom:0.9rem;">
                <tr>
                    <td style="padding:0.25rem 0; color:var(--text-muted); width:50%;">Aktuelle Range</td>
                    <td style="padding:0.25rem 0; font-weight:600;">±${hint.currentPct}%</td>
                </tr>
                <tr>
                    <td style="padding:0.25rem 0; color:var(--text-muted);">Empfohlene Range</td>
                    <td style="padding:0.25rem 0; font-weight:600;">±${hint.recommendedPct}%</td>
                </tr>
                ${hint.paybackHours != null ? `
                <tr>
                    <td style="padding:0.25rem 0; color:var(--text-muted);">Amortisation</td>
                    <td style="padding:0.25rem 0; font-weight:600;">~${Math.round(hint.paybackHours)} Stunden</td>
                </tr>` : ''}
            </table>
            <p style="margin:0 0 0.85rem; font-size:0.82rem; color:var(--text-muted);">
                Das dauert ca. 1–2 Minuten und kann nicht abgebrochen werden.
                Ein- und Auszahlungen sind währenddessen gesperrt.
            </p>
            <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
                <button class="btn btn-secondary" id="arb-cancel-btn">Abbrechen</button>
                <button class="btn btn-secondary" id="arb-confirm-btn">Jetzt umstellen</button>
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
        confirmBtn.textContent = 'Wird gestartet…';
        try {
            const r    = await fetch(`/api/pools/liquidity/${encodeURIComponent(pool.id)}/advisor-rebalance`, { method: 'POST' });
            const data = await r.json();
            if (r.ok) {
                fb.className     = 'modal-feedback ok';
                fb.innerHTML     = `&#10003; ${_esc(data.message ?? 'Rebalancing gestartet.')}`;
                fb.style.display = 'block';
                confirmBtn.style.display = 'none';
                cancelBtn.textContent = 'Schließen';
                cancelBtn.disabled    = false;
                cancelBtn.onclick     = () => closeModal(mid);
            } else {
                fb.className     = 'modal-feedback err';
                fb.textContent   = data.error ?? 'Unbekannter Fehler';
                fb.style.display = 'block';
                confirmBtn.disabled    = false;
                cancelBtn.disabled     = false;
                confirmBtn.textContent = 'Jetzt umstellen';
            }
        } catch (e) {
            fb.className     = 'modal-feedback err';
            fb.textContent   = `Netzwerkfehler: ${e.message}`;
            fb.style.display = 'block';
            confirmBtn.disabled    = false;
            cancelBtn.disabled     = false;
            confirmBtn.textContent = 'Jetzt umstellen';
        }
    });
}

async function _openPoolRebalanceModal(pool, activeHint = null) {
    const mid   = 'liquiditybot-rebalance-modal';
    const state = await _fetchPoolState(pool.id);

    showModal({
        id:    mid,
        title: `${_esc(pool.displayPair ?? pool.pair)} – Verwalten`,
        body:  `
            <svg id="reb-chart-svg" width="100%" style="display:block; overflow:visible;"></svg>
            <p id="reb-chart-empty" style="display:none; text-align:center; color:var(--text-muted); padding:1.5rem 0; font-size:0.85rem;">
                Keine Preishistorie verfügbar
            </p>
            <div id="reb-comp" style="margin-top:0.6rem; margin-bottom:0.25rem;"></div>
            <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:0.75rem;">
                <button class="btn btn-secondary" id="reb-start-btn"
                    ${activeHint ? 'style="background:var(--accent);color:#000;border-color:var(--accent);"' : ''}>Rebalance</button>
                <button class="btn btn-secondary" id="reb-close-btn">Schließen</button>
            </div>
            <div id="reb-confirm" style="display:none; margin-top:0.8rem; padding:0.75rem; border:1px solid rgba(220,80,80,0.4); border-radius:6px; background:rgba(220,80,80,0.06); font-size:0.85rem;">
                <p style="margin:0 0 0.5rem; font-weight:600;">Bist du sicher?</p>
                <p style="margin:0 0 0.75rem; color:var(--text-muted);">
                    Die Position wird geschlossen und neu eröffnet.
                    Das dauert <strong>ca. 1–2 Minuten</strong> und kann
                    <strong>nicht abgebrochen</strong> werden.
                    Ein- und Auszahlungen sind währenddessen gesperrt.
                </p>
                <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
                    <button class="btn btn-secondary" id="reb-cancel-btn">Abbrechen</button>
                    <button class="btn btn-secondary" id="reb-confirm-btn">Ja, jetzt rebalancen</button>
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
        confirmBtn.textContent = 'Wird gestartet…';
        try {
            const r    = await fetch(`/api/pools/liquidity/${encodeURIComponent(pool.id)}/rebalance`, { method: 'POST' });
            const data = await r.json();
            if (r.ok) {
                fb.className         = 'modal-feedback ok';
                fb.innerHTML         = '&#10003; Rebalancing gestartet. Der Bot führt es beim nächsten Tick aus.';
                fb.style.display     = 'block';
                confirmBtn.style.display = 'none';
                bd.querySelector('#reb-close-btn').style.display = 'none';
                cancelBtn.textContent = 'Schließen';
                cancelBtn.disabled    = false;
                cancelBtn.onclick     = () => closeModal(mid);
            } else {
                fb.className         = 'modal-feedback err';
                fb.textContent       = data.error ?? 'Unbekannter Fehler';
                fb.style.display     = 'block';
                confirmBtn.disabled  = false;
                cancelBtn.disabled   = false;
                confirmBtn.textContent = 'Ja, jetzt rebalancen';
            }
        } catch (e) {
            fb.className         = 'modal-feedback err';
            fb.textContent       = `Netzwerkfehler: ${e.message}`;
            fb.style.display     = 'block';
            confirmBtn.disabled  = false;
            cancelBtn.disabled   = false;
            confirmBtn.textContent = 'Ja, jetzt rebalancen';
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
        Wallet-USDC wird in beide Pool-Tokens geswappt und dann eingezahlt.<br>
        Wallet: ${_fmt(walletUsdc)} USDC · Mindestbetrag: ${_fmt(effectiveMin)} USDC
        ${isNew ? '<br>&#9888; Pool aktuell inaktiv – es wird eine neue Position eröffnet.' : ''}
        ${isBtcPair ? '<br>&#9432; btcPair: 2 Swaps nötig (USDC → ' + tokenALabel + ' + USDC → ' + tokenBLabel + ')' : ''}`;
}

async function _openPoolDepositModal(pool) {
    const mid = 'liquiditybot-deposit-modal';
    const [state, balance, cfgRes] = await Promise.all([
        _fetchPoolState(pool.id),
        _fetchWalletBalanceFresh(),
        fetch('/api/config/liquiditybot').catch(() => null),
    ]);
    if (!state) { alert('Pool-State konnte nicht geladen werden.'); return; }
    const cleanupMode = cfgRes?.ok ? _parseCleanupMode(await cfgRes.json()) : 'ranking';

    const tokenALabel = state.tokenALabel;
    const tokenBLabel = state.tokenBLabel;
    const isNew       = !state.position;
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
        ? `<div class="modal-feedback err" style="display:block; margin-bottom:0.5rem;">
             ⚠ Position ist <strong>out of Range</strong> – Einzahlen aktuell nicht möglich.
           </div>`
        : '';

    showModal({
        id: mid,
        title: `Einzahlen – ${state.displayPair ?? state.pair}`,
        body: `
            <div id="pd-oor-banner">${oorBannerHtml()}</div>
            ${_cleanupHint(cleanupMode)}
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-pdtab="usdc">Per USDC-Betrag</button>
                <button class="wm-tab" data-pdtab="pair">Per Token-Mengen</button>
            </div>
            <div id="pd-tab-usdc">
                <div class="settings-row">
                    <span class="settings-label">USDC-Betrag</span>
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
                        <span><strong>100%</strong> des Maximums</span>
                        <span class="info-tip-label"
                            data-tooltip-title="Schieberegler"
                            data-tooltip-content="Schieberegler wählt den Anteil des wirtschaftlichen Maximums. Beim Einzahlen wird das limitierende Paar nach aktuellem Pool-Ratio verwendet (Toleranz für Preisbewegung ist eingebaut). Kein Swap.">&#9432;</span>
                    </div>
                </div>
                <div class="wallet-hint" id="pd-ratio-hint" style="font-size:0.75rem; margin-top:0.6rem;"></div>
                <div class="wallet-hint" style="font-size:0.78rem;">
                    Mindesteinzahlung: ca. ${_fmt(minUsdc)} USDC.
                </div>
            </div>
            <div id="pd-preview" style="margin-top:0.6rem;"></div>
            <div class="modal-feedback" id="pd-feedback" style="margin-top:0.5rem;"></div>
            <div class="wallet-hint" style="font-size:0.7rem; margin-top:0.5rem;">Aktualisiert sich automatisch jede Minute.</div>`,
        actions: [
            { label: 'Vorschau',   onClick: () => _runPoolPreview(mid, 'deposit', pool.id, isNew) },
            { label: '&#10004; Einzahlen', onClick: () => _runPoolAction(mid, 'deposit', pool.id, isNew) },
            { label: 'Schließen',  onClick: () => closeModal(mid) },
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
            _setSubmitDisabled(backdrop, true, 'Position ist out of Range – Einzahlen nicht möglich');
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
                    reason = `${_esc(tokenALabel)}-Balance im Wallet (${_fmt(walletA)} SOL) zu niedrig – SOL-Reserve (0.10 SOL) deckt das gesamte Guthaben ab. Bitte SOL ins Wallet einzahlen oder den USDC-Modus verwenden.`;
                else if (tokenBLabel === 'SOL' && walletBSafe <= 0)
                    reason = `${_esc(tokenBLabel)}-Balance im Wallet (${_fmt(walletB)} SOL) zu niedrig – SOL-Reserve (0.10 SOL) deckt das gesamte Guthaben ab. Bitte SOL ins Wallet einzahlen oder den USDC-Modus verwenden.`;
                else
                    reason = `Wallet-Balance für ${_esc(tokenALabel)} und/oder ${_esc(tokenBLabel)} zu niedrig. Bitte Tokens aufstocken oder den USDC-Modus verwenden.`;
                hint.innerHTML = `<span style="color:var(--danger);">⚠ ${reason}</span>`;
            }
            _setSubmitDisabled(backdrop, true, 'Wallet-Balance zu niedrig für Token-Mengen-Modus');
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
}

// Berechnet das wirtschaftlich maximale Token-Paar aus Wallet + Pool-Preis.
function _cleanupHint(cleanupMode = 'ranking') {
    if (cleanupMode === 'disabled') return '';
    const mm  = new Date().getMinutes();
    const min = (65 - mm) % 60;
    if (min === 0) return `<div class="wallet-hint" style="font-size:0.78rem; color:var(--danger);">⚠ Cleanup läuft gerade.</div>`;
    const style = min < 10 ? 'color:var(--danger);' : 'color:var(--text-muted);';
    return `<div class="wallet-hint" style="font-size:0.78rem; ${style}">Nächster Cleanup in ${min} Minute${min === 1 ? '' : 'n'}.</div>`;
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
        _setSubmitDisabled(backdrop, true, 'Bitte Schieberegler bewegen');
        return;
    }

    let engpass;
    if (isBtcPair) {
        engpass = `Beide Seiten: ${_fmt(a)} ${tokenALabel} + ${_fmt(b)} ${tokenBLabel}`;
    } else {
        const bForA = a * price;
        if (bForA <= b) {
            engpass = `Engpass: ${tokenALabel} (${_fmt(a)} → ${_fmt(bForA)} ${tokenBLabel}, ${_fmt(b - bForA)} ${tokenBLabel} bleibt)`;
        } else {
            const aForB = b / price;
            engpass = `Engpass: ${tokenBLabel} (${_fmt(b)} → ${_fmt(aForB)} ${tokenALabel}, ${_fmt(a - aForB)} ${tokenALabel} bleibt)`;
        }
    }

    const usdcLine = estUsdc != null ? `<br>Wert: ≈ ${_fmt(estUsdc)} USDC` : '';
    hint.innerHTML = `${ratioLine}<br>${engpass}${usdcLine}`;

    // Submit-Sperren: Out-of-Range hat Vorrang vor Min-Check
    if (blockedOutOfRange) {
        _setSubmitDisabled(backdrop, true, 'Position ist out of Range – Einzahlen nicht möglich');
    } else if (estUsdc != null && minUsdc != null && estUsdc < minUsdc) {
        _setSubmitDisabled(backdrop, true, `Mindesteinzahlung ≈ ${_fmt(minUsdc)} USDC (aktuell ${_fmt(estUsdc)} USDC)`);
    } else {
        _setSubmitDisabled(backdrop, false);
    }
}

function _updateWithdrawHint(backdrop, tokenALabel, tokenBLabel, a, b, estUsdc, minUsdc) {
    const hint = backdrop.querySelector('#pw-ratio-hint');
    if (!hint) return;
    if (estUsdc <= 0) {
        hint.innerHTML = '';
        _setSubmitDisabled(backdrop, true, 'Bitte Schieberegler auf > 0 stellen');
        return;
    }
    hint.innerHTML = `${_fmt(a)} ${_esc(tokenALabel)} + ${_fmt(b)} ${_esc(tokenBLabel)}<br>Wert: ≈ ${_fmt(estUsdc)} USDC`;
    if (estUsdc < minUsdc) {
        _setSubmitDisabled(backdrop, true, `Mindestauszahlung ≈ ${_fmt(minUsdc)} USDC (aktuell ${_fmt(estUsdc)} USDC)`);
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
    if (!state) { alert('Pool-State konnte nicht geladen werden.'); return; }
    if (!state.position) { alert('Keine offene Position – Auszahlung nicht möglich.'); return; }
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
             &#9432; Position ist <strong>out of Range</strong> – enthält evtl. nur einen Token.
           </div>`
        : '';

    showModal({
        id: mid,
        title: `Auszahlen – ${state.displayPair ?? state.pair}`,
        body: `
            <div id="pw-oor-banner">${oorWarningHtml()}</div>
            ${_cleanupHint(cleanupMode)}
            <div class="wm-tab-bar">
                <button class="wm-tab active" data-pwtab="usdc">Per USDC-Wert</button>
                <button class="wm-tab" data-pwtab="pair">Per Token-Mengen</button>
            </div>
            <div id="pw-tab-usdc">
                <div class="settings-row">
                    <span class="settings-label">USDC-Wert</span>
                    <div class="send-amount-row">
                        <input class="modal-input" id="pw-usdc" type="number" min="0" step="any" placeholder="${minUsdc}.00">
                        <button class="btn btn-secondary btn-sm" id="pw-usdc-max">Max</button>
                    </div>
                </div>
                <div class="wallet-hint" style="font-size:0.78rem;">
                    Liquidität im Gegenwert dieses USDC-Betrags wird proportional entnommen.<br>
                    Position: ≈ <span id="pw-pos-value">${_fmt(posValue)}</span> USDC · Mindestbetrag: ${minUsdc} USDC
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
                        <span><strong>100%</strong> der Position</span>
                        <span class="info-tip-label"
                            data-tooltip-title="Schieberegler"
                            data-tooltip-content="Schieberegler wählt den prozentualen Anteil der Position zum Auszahlen. Beide Token werden proportional entnommen (LP-Ratio). Kein Swap.">&#9432;</span>
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
                        Swap → USDC
                        <span class="info-tip-label"
                            data-tooltip-title="Swap → USDC"
                            data-tooltip-content="Entnommene Coins vor dem Verbleib im Wallet (bzw. vor dem Senden) automatisch in USDC tauschen.">&#9432;</span>
                    </span>
                    <label class="toggle-switch toggle-sm">
                        <input type="checkbox" id="pw-swap">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="settings-row">
                    <span class="settings-label">Senden an</span>
                    <select class="modal-select" id="pw-sendto">
                        <option value="">– Nicht senden (im Wallet belassen) –</option>
                        ${_addrOptions(addrs, '')}
                    </select>
                </div>
            </div>
            <div id="pw-preview" style="margin-top:0.6rem;"></div>
            <div class="modal-feedback" id="pw-feedback" style="margin-top:0.5rem;"></div>
            <div class="wallet-hint" style="font-size:0.7rem; margin-top:0.5rem;">Aktualisiert sich automatisch jede Minute.</div>`,
        actions: [
            { label: 'Vorschau',   onClick: () => _runPoolPreview(mid, 'withdraw', pool.id, false) },
            { label: '&#10004; Auszahlen', onClick: () => _runPoolAction(mid, 'withdraw', pool.id, false) },
            { label: 'Schließen',  onClick: () => closeModal(mid) },
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
        if (isNaN(v) || v <= 0) return { error: 'Bitte einen USDC-Betrag eingeben.' };
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
                return { error: 'Bitte Schieberegler auf > 0 stellen.' };
            }
            return { body: { action, mode: 'pair', maxA: a, maxB: b, isNew } };
        } else {
            // Withdraw-Modus: Slider bei 100% → Vollentnahme; darunter → anteilig
            const slider = backdrop.querySelector(`#${prefix}-slider`);
            const pct    = parseFloat(slider?.value) || 0;
            if (pct >= 100) return { body: { action, mode: 'full', isNew, ...withdrawExtra } };
            const posVal = parseFloat(slider?.dataset.posValue) || 0;
            const usdc   = posVal * pct / 100;
            if (usdc <= 0) return { error: 'Bitte Schieberegler auf > 0 stellen.' };
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
    _setSubmitDisabled(backdrop, true, 'Vorschau wird berechnet…');

    previewBox.innerHTML = '<div class="wallet-hint">Lade Vorschau…</div>';
    try {
        const r = await fetch(`/api/pools/liquidity/${encodeURIComponent(poolId)}/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(built.body),
        });
        const data = await r.json();
        previewBox.innerHTML = _renderPreviewResult(data);
    } catch (err) {
        previewBox.innerHTML = `<div class="modal-feedback err" style="display:block;">Vorschau-Fehler: ${_esc(err.message)}</div>`;
    } finally {
        if (closeBtn) { closeBtn.disabled = false; closeBtn.style.opacity = ''; closeBtn.style.cursor = ''; }
        backdrop._revalidate?.();
    }
}

function _isRetryableError(msg) {
    if (!msg) return false;
    return msg.startsWith('Wallet-Balance konnte nicht gelesen werden') ||
           msg.startsWith('Der Swap konnte nicht ausgeführt werden') ||
           msg.startsWith('Konnte aktuelle Marktdaten nicht abrufen');
}

function _startRetryCountdown(feedbackBox, backdrop, seconds) {
    _setSubmitDisabled(backdrop, true, `Bitte ${seconds}s warten`);
    feedbackBox.className   = 'modal-feedback err';
    feedbackBox.style.display = 'block';
    let remaining = seconds;
    (function tick() {
        if (remaining <= 0) {
            feedbackBox.textContent = 'Wallet-Balance konnte nicht gelesen werden. Bitte versuche es noch einmal.';
            _setSubmitDisabled(backdrop, false);
            backdrop._revalidate?.();
            return;
        }
        feedbackBox.textContent = `Wallet-Balance konnte nicht gelesen werden. Bitte warte noch ${remaining}s…`;
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

    feedbackBox.textContent = `${action === 'deposit' ? 'Einzahlen' : 'Auszahlen'} läuft – das kann 30–60 Sekunden dauern…`;
    feedbackBox.style.display = 'block';
    _setSubmitDisabled(backdrop, true, `${action === 'deposit' ? 'Einzahlen' : 'Auszahlen'} läuft…`);
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
                ? ` <a href="https://solscan.io/tx/${txHash}" target="_blank" rel="noopener" style="color:inherit;">TX ansehen ↗</a>`
                : '';
            feedbackBox.innerHTML = `✓ ${action === 'deposit' ? 'Eingezahlt' : 'Ausgezahlt'}.${txLink}`;
            // Wallet-Karte nach Deposit/Withdraw aktualisieren (deposit.js hat refreshAfterAction
            // bereits abgeschlossen → wallet-monitor.db ist frisch → direktes Re-Render reicht)
            const walletEl = _container?.querySelector('.liquiditybot-grid-wallet');
            if (walletEl) _renderWallet(walletEl);
        } else if (_isRetryableError(data.error)) {
            retryMode = true;
            _startRetryCountdown(feedbackBox, backdrop, 30);
        } else {
            feedbackBox.className   = 'modal-feedback err';
            feedbackBox.textContent = `Fehler: ${data.error ?? 'Unbekannter Fehler'}`;
        }
    } catch (err) {
        feedbackBox.className   = 'modal-feedback err';
        feedbackBox.textContent = `Netzwerk-Fehler: ${err.message}`;
    } finally {
        if (!retryMode) {
            _setSubmitDisabled(backdrop, false);
            backdrop._revalidate?.();
        }
    }
}
