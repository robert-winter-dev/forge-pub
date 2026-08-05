/**
 * ForgeSettings – LendingBot Panel
 *
 * Wird von settings.js gemountet wenn der "LendingBot"-Tab aktiv ist.
 *
 * API:
 *   mount(container, ctx)  – rendert dreispaltiges Grid
 *   unmount()              – räumt auf
 *   updateStatus(status)   – aktualisiert den Status-Badge (von settings.js-Refresh aufgerufen)
 */

import { showModal, closeModal, getModal } from '/forge/js/modal.js?v=20260731a';
import { buildWalletDetailHtml } from '/forge/js/wallet-detail-modal.js?v=20260731c';

// ── Konstanten ─────────────────────────────────────────────────────────────────
const SVC_ID = 'forge-lendingbot';
// Dieselbe Schwelle wie core/wallet-monitor/monitor.js (SOL_LOW_THRESHOLD) — hier
// nur für die Ampel-Farbe in der Wallet-Box, die eigentliche Alert-Logik läuft dort.
const SOL_LOW_THRESHOLD_LENDING = 0.1;

// ── Modul-State ────────────────────────────────────────────────────────────────
let _container        = null;
let _ctx              = {};
let _lastKnownStatus  = null;  // letzter Bot-Status, für Pools-Karte-Re-Render nur bei Wechsel
let _selectedSendAddr = null;  // { id, name, address } | null
let _activeProtocol   = localStorage.getItem('lb.activeProtocol') ?? null;

// ── Öffentliche API ────────────────────────────────────────────────────────────

export function mount(container, ctx = {}) {
    _container = container;
    _ctx       = ctx;
    _render();

    fetch('/api/version')
        .then(r => r.json())
        .then(({ version }) => {
            const el = document.getElementById('footerVersion');
            if (el) el.textContent = `v${version}`;
        })
        .catch(() => {});
}

export function unmount() {
    _container = null;
    _ctx       = {};
}

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

    const protocolsEl = document.createElement('div');
    protocolsEl.className = 'liquiditybot-grid-pools';
    grid.appendChild(protocolsEl);

    _renderService(serviceEl);
    _renderWallet(walletEl);
    _renderProtocols(protocolsEl);
}

// ── Service-Karte ─────────────────────────────────────────────────────────────

async function _renderService(el) {
    const card = document.createElement('div');
    card.className = 'settings-card';
    card.innerHTML = `
        <div class="settings-card-header"><span class="sch-title">Lending Bot</span></div>
        <table class="wallet-action-table">
            <tbody>
                <tr>
                    <td class="wat-label">Status</td>
                    <td class="wat-info">
                        <span class="key-status" id="lb-status-text">laden…</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="lb-btn-status-manage">Verwalten</button>
                    </td>
                </tr>
            </tbody>
            <tbody id="lb-rebalance-wrap"></tbody>
        </table>`;
    el.appendChild(card);

    const cachedStatus = _ctx.getStatus?.(SVC_ID);
    if (cachedStatus) _applyStatus(cachedStatus);

    card.querySelector('#lb-btn-status-manage')?.addEventListener('click', () => _openBotControlModal());

    await _loadAndRenderAutoDeployRow(card.querySelector('#lb-rebalance-wrap'));
}

function _openBotControlModal() {
    const mid = 'lb-control-modal';
    showModal({
        id: mid,
        title: 'Lending Bot verwalten',
        body: `
            <div class="bcm-row">
                <button class="btn btn-secondary btn-uniform" id="lb-btn-start">&#9654; Start</button>
                <span class="bcm-hint">Startet den Bot, falls er aktuell gestoppt ist.</span>
            </div>
            <div class="bcm-row">
                <button class="btn btn-secondary btn-uniform" id="lb-btn-stop">&#9632; Stop</button>
                <span class="bcm-hint">Stoppt den Bot vollständig. Offene Positionen bleiben unverändert bestehen.</span>
            </div>
            <div class="bcm-row">
                <button class="btn btn-secondary btn-uniform" id="lb-btn-restart">&#8635; Restart</button>
                <span class="bcm-hint">Stoppt und startet den Bot neu, z.&nbsp;B. nach einer Konfigurationsänderung.</span>
            </div>
            <div class="task-status" id="lb-task-status"></div>`,
        actions: [
            { label: 'Schließen', onClick: () => closeModal(mid) },
        ],
    });

    const cachedStatus = _ctx.getStatus?.(SVC_ID);
    if (cachedStatus) _applyButtonStates(cachedStatus);

    document.getElementById('lb-btn-start')  ?.addEventListener('click', () => _doAction('start'));
    document.getElementById('lb-btn-stop')   ?.addEventListener('click', () => _doAction('stop'));
    document.getElementById('lb-btn-restart')?.addEventListener('click', () => _doAction('restart'));
}

// ── Auto-Deploy-Abschnitt (Service-Karte) ─────────────────────────────────────

function _parseAutoDeployMode(cfg) {
    const m = cfg.AUTO_DEPLOY_MODE ?? '';
    if (m === 'disabled' || m === '') return 'disabled';
    if (m === 'ranking')              return 'ranking';
    if (m.startsWith('protocol:'))    return m;
    return 'disabled';
}

function _buildAutoDeploySummary(mode, protocols) {
    if (mode === 'disabled') return '<span class="pool-summary-off">Deaktiviert</span>';
    if (mode === 'ranking')  return '<span class="pool-summary-on">Bester Pool</span>';
    if (mode.startsWith('protocol:')) {
        const id    = mode.slice('protocol:'.length);
        const proto = protocols.find(p => p.id === id);
        const name  = proto?.label ?? id;
        return `<span class="pool-summary-on">Bestimmter Pool: ${_esc(name)}</span>`;
    }
    return '<span class="pool-summary-off">Deaktiviert</span>';
}

// Auto-Deploy prüft alle SYNC_INTERVAL_MS (bin/bot.js) im selben Tick wie der
// Wallet-Snapshot -> dessen recorded_at ist ein verlässlicher Anker für den
// Countdown, ohne dass der Bot dafür einen eigenen KV-Wert pflegen müsste.
const AUTO_DEPLOY_CHECK_INTERVAL_MIN = 5;

function _autoDeployCountdownHtml(mode, recordedAtMs) {
    if (mode === 'disabled' || !recordedAtMs) return '';
    const elapsedMin = (Date.now() - recordedAtMs) / 60000;
    const min = Math.ceil(AUTO_DEPLOY_CHECK_INTERVAL_MIN - elapsedMin);
    if (min <= 0) {
        return `<div class="wallet-hint" style="font-size:0.78rem;color:var(--danger);margin-bottom:0.75rem;">⚠ Auto-Deploy-Check läuft gerade.</div>`;
    }
    const style = min < 2 ? 'color:var(--danger);' : 'color:var(--text-muted);';
    return `<div class="wallet-hint" style="font-size:0.78rem;${style}margin-bottom:0.75rem;">Nächster Auto-Deploy-Check in ${min} Minute${min === 1 ? '' : 'n'}.</div>`;
}

async function _loadAndRenderAutoDeployRow(wrap) {
    if (!wrap) return;
    try {
        const [lendingRes, cfgRes, balRes] = await Promise.all([
            fetch('/api/lending/config'),
            fetch('/api/config/lendingbot'),
            fetch('/api/wallet/lending/balance'),
        ]);
        const lending   = lendingRes.ok ? await lendingRes.json() : {};
        const cfg       = cfgRes.ok     ? await cfgRes.json()     : {};
        const balance   = balRes.ok     ? await balRes.json()     : {};
        const protocols = lending.protocols ?? [];
        const mode      = _parseAutoDeployMode(cfg);
        _buildAutoDeployRow(wrap, mode, cfg, protocols, balance?.recorded_at ?? null);
    } catch { /* Config nicht verfügbar */ }
}

function _buildAutoDeployRow(wrap, mode, cfg, protocols, recordedAt) {
    // Selbe <table> wie die Status-Zeile (wrap ist ein zweites <tbody> darin) –
    // dadurch garantiert identische Spaltenbreiten, "Verwalten" steht exakt
    // untereinander und der Info-Text bleibt linksbündig wie bei Status.
    wrap.innerHTML = `
        <tr>
            <td class="wat-label" style="display:flex;align-items:center;gap:0.4rem;">
                Auto-Deploy
                <span class="info-tip-label"
                    data-tooltip-title="Auto-Deploy"
                    data-tooltip-content="Erkennt neues USDC im Wallet und deployed es automatisch. Modus 'Bester Pool' wählt automatisch das Protokoll mit dem höchsten APY. 'Bestimmter Pool' deployt immer in ein von dir festgelegtes Protokoll.">&#9432;</span>
            </td>
            <td class="wat-info">${_buildAutoDeploySummary(mode, protocols)}</td>
            <td class="wat-action">
                <button class="btn btn-secondary btn-sm" id="lb-autodeploy-row-btn"
                    ${_ctx.getStatus?.(SVC_ID) !== 'active' ? 'disabled' : ''}>Verwalten</button>
            </td>
        </tr>`;

    wrap.querySelector('#lb-autodeploy-row-btn')
        ?.addEventListener('click', () => _openAutoDeployRowModal(wrap, mode, cfg, protocols, recordedAt));
}

// Baut eine Min/Max-Feld-Zeile (Minimale/Maximale Einzahlung), identisches
// Layout für beide Reiter.
function _depositRangeFieldsHtml(minId, maxId, minVal, maxVal, maxTooltip) {
    return `
        <div style="display:flex;gap:1rem;">
            <div style="flex:1">
                <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.4rem;color:var(--text-muted)">
                    Minimale Einzahlung
                    <span class="info-tip-label"
                        data-tooltip-title="Minimale Einzahlung"
                        data-tooltip-content="Mindestbetrag der im Wallet akkumuliert sein muss, bevor Auto-Deploy ausgelöst wird. Kleinere Beträge werden ignoriert und wachsen weiter an.||Leer lassen oder 0 = kein Minimum (deployt ab 1 USDC).">&#9432;</span>
                </label>
                <div style="display:flex;align-items:center;gap:0.4rem;">
                    <input type="number" id="${minId}" min="0" step="5"
                           value="${minVal > 0 ? _esc(String(minVal)) : ''}"
                           placeholder="kein Minimum"
                           style="width:115px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                    <span style="font-size:0.8rem;color:var(--text-muted)">USDC</span>
                </div>
            </div>
            <div style="flex:1">
                <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.4rem;color:var(--text-muted)">
                    Maximale Einzahlung
                    <span class="info-tip-label"
                        data-tooltip-title="Maximale Einzahlung"
                        data-tooltip-content="${_esc(maxTooltip)}">&#9432;</span>
                </label>
                <div style="display:flex;align-items:center;gap:0.4rem;">
                    <input type="number" id="${maxId}" min="0" step="5"
                           value="${maxVal > 0 ? _esc(String(maxVal)) : ''}"
                           placeholder="kein Limit"
                           style="width:115px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                    <span style="font-size:0.8rem;color:var(--text-muted)">USDC</span>
                </div>
            </div>
        </div>
        <p style="margin:-0.3rem 0 0;font-size:0.78rem;color:var(--text-muted)">leer = kein Minimum/Limit</p>`;
}

function _openAutoDeployRowModal(wrap, mode, cfg, protocols, recordedAt) {
    const mid = 'lb-autodeploy-row-modal';

    const minApr      = cfg.APY_THRESHOLD_PERCENT          ?? '';
    const minDeposit  = cfg.AUTO_DEPLOY_MIN_DEPOSIT         ?? '';
    const maxDeposit  = cfg.AUTO_DEPLOY_MAX_DEPOSIT         ?? '';
    const fixedMinDep = cfg.FIXED_AUTO_DEPLOY_MIN_DEPOSIT   ?? '';
    const fixedMaxDep = cfg.FIXED_AUTO_DEPLOY_MAX_DEPOSIT   ?? '';

    const sortedProtos = protocols
        .slice()
        .sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id));

    const currentFixedId = mode.startsWith('protocol:') ? mode.slice('protocol:'.length) : '';

    showModal({
        id:    mid,
        title: 'Auto-Deploy',
        body:  `
            ${_autoDeployCountdownHtml(mode, recordedAt)}
            <div class="cu-tab-bar">
                <button class="cu-tab active" data-cu-tab="bestimmter-pool" id="lb-ad-tab-fixed">Bestimmter Pool</button>
                <button class="cu-tab" data-cu-tab="bester-pool" id="lb-ad-tab-bester">Bester Pool</button>
            </div>

            <div style="min-height:13rem;">
            <div class="cu-panel" id="cu-panel-bestimmter-pool">
                <div style="display:flex;flex-direction:column;gap:0.85rem">
                    ${_depositRangeFieldsHtml(
                        'lb-ad-fixed-min-deposit', 'lb-ad-fixed-max-deposit', fixedMinDep, fixedMaxDep,
                        'Begrenzt wie viel USDC pro Auto-Deploy-Lauf in diesen Pool investiert werden darf. Überschüssiges Guthaben bleibt für den nächsten Lauf im Wallet.||Leer lassen oder 0 = kein Limit.'
                    )}
                    <div style="border-top:1px solid var(--border);padding-top:0.75rem">
                        <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.4rem;color:var(--text-muted)">Pool</label>
                        <select id="lb-ad-fixed-select" class="modal-select"
                                style="width:100%;box-sizing:border-box;padding:0.3rem 0.5rem;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:5px;font-size:0.875rem">
                            <option value="" ${currentFixedId === '' ? 'selected' : ''}>Deaktivieren</option>
                            ${sortedProtos.map(p => `
                                <option value="${_esc(p.id)}" ${currentFixedId === p.id ? 'selected' : ''}>
                                    ${_esc(p.label ?? p.id)}${p.active ? '' : ' (inaktiv)'}
                                </option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="bot-actions" style="margin-top:0.9rem;">
                    <button class="btn btn-secondary btn-uniform" id="lb-ad-fixed-save-btn">Speichern</button>
                </div>
                <div class="modal-feedback" id="lb-ad-fixed-feedback"></div>
            </div>

            <div class="cu-panel" id="cu-panel-bester-pool" style="display:none">
                <div style="display:flex;flex-direction:column;gap:0.85rem">
                    <label class="cleanup-radio-option">
                        <input type="radio" name="lb-ad-bester-mode" value="ranking" ${mode === 'ranking' ? 'checked' : ''}>
                        <span>Bester Pool <small style="opacity:0.7;">— Protokoll mit dem höchsten APY</small></span>
                    </label>
                    <label class="cleanup-radio-option">
                        <input type="radio" name="lb-ad-bester-mode" value="disabled" ${mode !== 'ranking' ? 'checked' : ''}>
                        <span>Deaktiviert</span>
                    </label>
                    <div style="border-top:1px solid var(--border);padding-top:0.75rem">
                        <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.4rem;color:var(--text-muted)">
                            Minimum APR
                            <span class="info-tip-label"
                                data-tooltip-title="Minimum APR"
                                data-tooltip-content="Mindest-APY (in Prozent) den ein Protokoll bieten muss, damit Auto-Deploy dort investiert. Protokolle unterhalb dieser Schwelle werden übersprungen.">&#9432;</span>
                        </label>
                        <div style="display:flex;align-items:center;gap:0.5rem;">
                            <input type="number" id="lb-ad-min-apr" min="0" step="0.1"
                                   value="${_esc(String(minApr))}"
                                   placeholder="z. B. 5.0"
                                   style="width:105px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.3rem 0.5rem;border-radius:5px;font-size:0.875rem">
                            <span style="font-size:0.82rem;color:var(--text-muted)">%</span>
                        </div>
                    </div>
                    <div style="border-top:1px solid var(--border);padding-top:0.75rem">
                        ${_depositRangeFieldsHtml(
                            'lb-ad-min-deposit', 'lb-ad-max-deposit', minDeposit, maxDeposit,
                            'Begrenzt wie viel USDC pro Auto-Deploy-Lauf im Bester-Pool-Modus investiert werden darf. Überschüssiges Guthaben bleibt für den nächsten Lauf im Wallet.||Leer lassen oder 0 = kein Limit.'
                        )}
                    </div>
                </div>
                <div class="bot-actions" style="margin-top:0.9rem;">
                    <button class="btn btn-secondary btn-uniform" id="lb-ad-bester-save-btn">Speichern</button>
                </div>
                <div class="modal-feedback" id="lb-ad-bester-feedback"></div>
            </div>
            </div>`,
        actions: [
            { label: 'Schließen', onClick: () => closeModal(mid) },
        ],
    });

    const modalEl = getModal(mid);
    if (!modalEl) return;

    // Tab-Wechsel
    function _switchTab(which) {
        modalEl.querySelectorAll('[data-cu-tab]').forEach(b => b.classList.toggle('active', b.dataset.cuTab === which));
        modalEl.querySelectorAll('.cu-panel').forEach(p => { p.style.display = 'none'; });
        const panel = modalEl.querySelector(`#cu-panel-${which}`);
        if (panel) panel.style.display = '';
    }
    modalEl.querySelectorAll('[data-cu-tab]').forEach(btn => {
        btn.addEventListener('click', () => _switchTab(btn.dataset.cuTab));
    });

    // Nur eine Regel kann aktiv sein — der jeweils inaktive Reiter wird
    // abgedunkelt (bleibt klickbar), Bester-Pool-Radio spiegelt den Stand.
    function _applyModeUI(curMode) {
        modalEl.querySelector('#lb-ad-tab-fixed') ?.classList.toggle('cu-tab-dim', curMode === 'ranking');
        modalEl.querySelector('#lb-ad-tab-bester')?.classList.toggle('cu-tab-dim', curMode.startsWith('protocol:'));
        const besterRadio = modalEl.querySelector(
            `input[name="lb-ad-bester-mode"][value="${curMode === 'ranking' ? 'ranking' : 'disabled'}"]`
        );
        if (besterRadio) besterRadio.checked = true;
    }
    _applyModeUI(mode);

    // ── Minimale darf die Maximale Einzahlung nicht überschreiten (je Reiter) ──
    function _wireDepositValidation(minId, maxId, saveBtnId, fbId) {
        const minEl   = modalEl.querySelector(`#${minId}`);
        const maxEl   = modalEl.querySelector(`#${maxId}`);
        const saveBtn = modalEl.querySelector(`#${saveBtnId}`);
        const check = () => {
            const minVal   = parseFloat(minEl?.value ?? '');
            const maxVal   = parseFloat(maxEl?.value ?? '');
            const conflict = Number.isFinite(minVal) && minVal > 0 && Number.isFinite(maxVal) && maxVal > 0 && minVal > maxVal;
            const fb       = modalEl.querySelector(`#${fbId}`);
            if (saveBtn) saveBtn.disabled = conflict;
            if (fb) {
                if (conflict) { fb.textContent = 'Minimale Einzahlung darf nicht größer als die Maximale sein.'; fb.className = 'modal-feedback error'; }
                else if (fb.classList.contains('error')) { fb.textContent = ''; fb.className = 'modal-feedback'; }
            }
        };
        minEl?.addEventListener('input', check);
        maxEl?.addEventListener('input', check);
    }
    _wireDepositValidation('lb-ad-fixed-min-deposit', 'lb-ad-fixed-max-deposit', 'lb-ad-fixed-save-btn', 'lb-ad-fixed-feedback');
    _wireDepositValidation('lb-ad-min-deposit', 'lb-ad-max-deposit', 'lb-ad-bester-save-btn', 'lb-ad-bester-feedback');

    // ── Speichern "Bestimmter Pool" ────────────────────────────────────────────
    modalEl.querySelector('#lb-ad-fixed-save-btn')?.addEventListener('click', async () => {
        const fb          = modalEl.querySelector('#lb-ad-fixed-feedback');
        const selectedId  = modalEl.querySelector('#lb-ad-fixed-select')?.value ?? '';
        const minRaw = modalEl.querySelector('#lb-ad-fixed-min-deposit')?.value.trim() ?? '';
        const maxRaw = modalEl.querySelector('#lb-ad-fixed-max-deposit')?.value.trim() ?? '';
        const minVal = minRaw !== '' ? parseFloat(minRaw) : 0;
        const maxVal = maxRaw !== '' ? parseFloat(maxRaw) : 0;
        if (minVal > 0 && maxVal > 0 && minVal > maxVal) {
            if (fb) { fb.textContent = 'Minimale Einzahlung darf nicht größer als die Maximale sein.'; fb.className = 'modal-feedback error'; }
            return;
        }

        const newMode = selectedId === '' ? 'disabled' : `protocol:${selectedId}`;

        if (fb) { fb.textContent = 'Speichere…'; fb.className = 'modal-feedback'; }
        try {
            const res = await fetch('/api/config/lendingbot', {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    AUTO_DEPLOY_MODE:              newMode,
                    FIXED_AUTO_DEPLOY_MIN_DEPOSIT: minRaw !== '' ? minRaw : '0',
                    FIXED_AUTO_DEPLOY_MAX_DEPOSIT: maxRaw !== '' ? maxRaw : '0',
                }),
            });
            if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }

            mode = newMode;
            if (fb) { fb.textContent = '✓ Gespeichert.'; fb.className = 'modal-feedback success'; }
            if (selectedId === '') {
                _ctx.showToast?.('Auto-Deploy deaktiviert', 'success');
            } else {
                const p = sortedProtos.find(pp => pp.id === selectedId);
                _ctx.showToast?.(`"Bestimmter Pool" aktiviert: ${p?.label ?? selectedId}`, 'success');
            }
            _applyModeUI(mode);
            await _loadAndRenderAutoDeployRow(wrap);
        } catch (err) {
            if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
        }
    });

    // ── Speichern "Bester Pool" ─────────────────────────────────────────────────
    modalEl.querySelector('#lb-ad-bester-save-btn')?.addEventListener('click', async () => {
        const fb       = modalEl.querySelector('#lb-ad-bester-feedback');
        const selected = modalEl.querySelector('input[name="lb-ad-bester-mode"]:checked');
        if (!selected) {
            if (fb) { fb.textContent = 'Bitte eine Option wählen.'; fb.className = 'modal-feedback error'; }
            return;
        }
        const minAprRaw = modalEl.querySelector('#lb-ad-min-apr')?.value.trim() ?? '';
        const minDepRaw = modalEl.querySelector('#lb-ad-min-deposit')?.value.trim() ?? '';
        const maxDepRaw = modalEl.querySelector('#lb-ad-max-deposit')?.value.trim() ?? '';
        const minDepVal = minDepRaw !== '' ? parseFloat(minDepRaw) : 0;
        const maxDepVal = maxDepRaw !== '' ? parseFloat(maxDepRaw) : 0;
        if (minDepVal > 0 && maxDepVal > 0 && minDepVal > maxDepVal) {
            if (fb) { fb.textContent = 'Minimale Einzahlung darf nicht größer als die Maximale sein.'; fb.className = 'modal-feedback error'; }
            return;
        }

        const newMode = selected.value;
        const payload = { AUTO_DEPLOY_MODE: newMode };
        if (minAprRaw !== '') payload.APY_THRESHOLD_PERCENT = minAprRaw;
        payload.AUTO_DEPLOY_MIN_DEPOSIT = minDepRaw !== '' ? minDepRaw : '0';
        payload.AUTO_DEPLOY_MAX_DEPOSIT = maxDepRaw !== '' ? maxDepRaw : '0';

        if (fb) { fb.textContent = 'Speichere…'; fb.className = 'modal-feedback'; }
        try {
            const res = await fetch('/api/config/lendingbot', {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload),
            });
            if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }

            mode = newMode;
            if (fb) { fb.textContent = '✓ Gespeichert.'; fb.className = 'modal-feedback success'; }
            _ctx.showToast?.(newMode === 'ranking' ? '"Bester Pool" aktiviert' : 'Auto-Deploy deaktiviert', 'success');

            // "Bester Pool" (aktiv oder bewusst deaktiviert) ist jetzt die
            // gültige Regel — eine zuvor gewählte feste Pool-Auswahl entfernen.
            const fixedSelect = modalEl.querySelector('#lb-ad-fixed-select');
            if (fixedSelect) fixedSelect.value = '';
            const fixedFb = modalEl.querySelector('#lb-ad-fixed-feedback');
            if (fixedFb) { fixedFb.textContent = ''; fixedFb.className = 'modal-feedback'; }

            _applyModeUI(mode);
            await _loadAndRenderAutoDeployRow(wrap);
        } catch (err) {
            if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
        }
    });
}

// ── TVL-Schutz (Auto-Exit) pro Protokoll ──────────────────────────────────────

/** Formatiert einen USDC-Betrag kompakt (K/M). */
function _fmtTvlUsdc(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + ' M USDC';
    if (v >= 1_000)     return (v / 1_000).toFixed(0) + ' K USDC';
    return v.toFixed(0) + ' USDC';
}

/** Kurz-Zusammenfassung der TVL-Schutz-Einstellung eines Protokolls. */
function _tvlGuardSummary(guard) {
    if (!guard?.enabled) return '<span class="pool-summary-off">Aus</span>';
    return `<span class="pool-summary-on">TVL &lt; ${_fmtTvlUsdc(guard.thresholdUsd)}</span>`;
}

/**
 * Öffnet das TVL-Schutz-Modal für ein einzelnes Protokoll.
 * @param {Object} proto  { id, label, tvlGuard, currentTvl, tvlAtActivation }
 * @param {HTMLElement} card  Pools-Karte (für Reload nach Save)
 */
async function _openTvlGuardModal(proto, card) {
    const mid   = 'lb-tvlguard-modal';
    const guard = proto.tvlGuard ?? { enabled: true, thresholdUsd: 100_000, sendTo: '' };
    const on    = !!guard.enabled;

    let addrs = [];
    try { const r = await fetch('/api/addresses'); if (r.ok) addrs = await r.json(); } catch { /* keine Adressen */ }
    const addrOpts = addrs.map(a =>
        `<option value="${_esc(a.address)}" ${a.address === (guard.sendTo ?? '') ? 'selected' : ''}>${_esc(a.name)}</option>`
    ).join('');

    const curTvl = proto.currentTvl != null
        ? `<strong style="color:var(--text);">${_fmtTvlUsdc(proto.currentTvl)}</strong>`
        : `<strong style="color:var(--text-muted);">—</strong>`;
    const actTvl = proto.tvlAtActivation != null
        ? ` <span style="color:var(--text-muted);font-weight:400;">(${_fmtTvlUsdc(proto.tvlAtActivation)}
               <span class="info-tip-label" data-tooltip-title="TVL bei Aktivierung"
                   data-tooltip-content="Markt-TVL zum Zeitpunkt des Deposits in dieses Protokoll.">&#9432;</span>)</span>`
        : '';

    showModal({
        id:    mid,
        title: `TVL-Schutz – ${_esc(proto.label)}`,
        body:  `
            <div style="display:flex;flex-direction:column;gap:0.95rem;">
                <div class="settings-row" style="background:var(--bg-soft, rgba(255,255,255,0.03));border-radius:8px;padding:0.6rem 0.8rem;">
                    <span class="settings-label">Aktueller TVL</span>
                    <span style="text-align:right;">${curTvl}${actTvl}</span>
                </div>
                <div class="settings-row" style="border:none;">
                    <span class="settings-label" style="display:flex;align-items:center;gap:0.4rem;">
                        Auto-Exit aktiv
                        <span class="info-tip-label"
                            data-tooltip-title="TVL-Schutz (Auto-Exit)"
                            data-tooltip-content="Fällt der Markt-TVL dieses Protokolls unter die Schwelle, wird das Kapital automatisch zu 100 % abgezogen.">&#9432;</span>
                    </span>
                    <label class="toggle-switch">
                        <input type="checkbox" id="lb-tg-enabled" ${on ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="tg-dependent" style="opacity:${on ? '1' : '0.4'};">
                    <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.4rem;color:var(--text-muted)">
                        TVL-Schwelle
                        <span class="info-tip-label"
                            data-tooltip-title="TVL-Schwelle"
                            data-tooltip-content="Fällt der Markt-TVL unter diesen Wert, wird die Position zu 100 % abgezogen.">&#9432;</span>
                    </label>
                    <div style="display:flex;align-items:center;gap:0.5rem;">
                        <input type="number" id="lb-tg-threshold" min="0" step="10000" value="${Number(guard.thresholdUsd) || 100000}"
                            class="modal-input" style="width:11rem;" ${on ? '' : 'disabled'}>
                        <span class="input-unit" id="lb-tg-threshold-fmt" style="color:var(--text-muted);">${_fmtTvlUsdc(guard.thresholdUsd)}</span>
                    </div>
                </div>
                <div class="tg-dependent" style="opacity:${on ? '1' : '0.4'};">
                    <label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:0.4rem;color:var(--text-muted)">
                        Senden an
                        <span class="info-tip-label"
                            data-tooltip-title="Senden an"
                            data-tooltip-content="Empfänger-Adresse für das abgezogene Kapital. Ohne Adresse bleibt es im Wallet (und wird ggf. von Auto-Deploy neu verteilt).">&#9432;</span>
                    </label>
                    <select class="modal-select" id="lb-tg-sendto" style="width:100%;" ${on ? '' : 'disabled'}>
                        <option value="">– Nicht senden (ins Wallet) –</option>
                        ${addrOpts}
                    </select>
                </div>
                <div class="modal-feedback" id="lb-tg-feedback"></div>
            </div>`,
        actions: [
            { label: 'Speichern', primary: true, onClick: () => _saveTvlGuardModal(mid, proto, card) },
            { label: 'Schließen',               onClick: () => closeModal(mid) },
        ],
    });

    const modalEl = getModal(mid);
    modalEl?.querySelector('#lb-tg-threshold')?.addEventListener('input', e => {
        const fmt = modalEl.querySelector('#lb-tg-threshold-fmt');
        if (fmt) fmt.textContent = _fmtTvlUsdc(e.target.value);
    });
    modalEl?.querySelector('#lb-tg-enabled')?.addEventListener('change', e => {
        const en = e.target.checked;
        modalEl.querySelectorAll('.tg-dependent').forEach(el => { el.style.opacity = en ? '1' : '0.4'; });
        const t = modalEl.querySelector('#lb-tg-threshold');
        const s = modalEl.querySelector('#lb-tg-sendto');
        if (t) t.disabled = !en;
        if (s) s.disabled = !en;
    });
}

async function _saveTvlGuardModal(mid, proto, card) {
    const modalEl   = getModal(mid);
    const fb        = modalEl?.querySelector('#lb-tg-feedback');
    const enabled   = modalEl?.querySelector('#lb-tg-enabled')?.checked ?? false;
    const threshold = parseFloat(modalEl?.querySelector('#lb-tg-threshold')?.value ?? '');
    const sendTo    = modalEl?.querySelector('#lb-tg-sendto')?.value ?? '';

    if (enabled && (!Number.isFinite(threshold) || threshold <= 0)) {
        if (fb) { fb.textContent = 'TVL-Schwelle muss größer als 0 sein.'; fb.className = 'modal-feedback error'; }
        return;
    }

    if (fb) { fb.textContent = 'Speichere…'; fb.className = 'modal-feedback'; }
    try {
        const res = await fetch(`/api/lending/tvl-guard/${proto.id}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ enabled, thresholdUsd: threshold, sendTo }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }

        if (fb) { fb.textContent = '✓ Gespeichert.'; fb.className = 'modal-feedback success'; }
        _ctx.showToast?.(`TVL-Schutz (${proto.label}) gespeichert`, 'success');
        await _refreshProtocolsCard(card);
        setTimeout(() => closeModal(mid), 600);
    } catch (err) {
        if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
    }
}

function _applyStatus(status) {
    const text = _container?.querySelector('#lb-status-text');
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
        if (poolsEl) _renderProtocols(poolsEl);

        // Auto-Deploy-Zeile (Service-Karte) hat einen eigenen "Verwalten"-Button,
        // der ebenfalls nur bei laufendem Bot bedienbar sein soll.
        const rebalanceWrap = _container?.querySelector('#lb-rebalance-wrap');
        if (rebalanceWrap) _loadAndRenderAutoDeployRow(rebalanceWrap).catch(() => {});
    }
}

function _applyButtonStates(status) {
    // Start/Stop/Restart leben im "Verwalten"-Modal (Status-Zeile), nicht mehr
    // fest in der Karte — document-weite Suche, no-op wenn das Modal gerade zu ist.
    const btnStart   = document.getElementById('lb-btn-start');
    const btnStop    = document.getElementById('lb-btn-stop');
    const btnRestart = document.getElementById('lb-btn-restart');
    if (!btnStart) return;

    const canStart   = status === 'inactive' || status === 'failed';
    const canStop    = status === 'active'   || status === 'failed';
    const canRestart = status === 'active'   || status === 'failed';

    btnStart.disabled   = !canStart;
    btnStop.disabled    = !canStop;
    btnRestart.disabled = !canRestart;
}

async function _doAction(action) {
    const taskEl  = document.getElementById('lb-task-status');
    const buttons = document.querySelectorAll('#lb-btn-start, #lb-btn-stop, #lb-btn-restart');

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
        setTimeout(() => _ctx.refreshStatus?.(), 1500);
    }
}

async function _pollTask(taskId, action, taskEl) {
    for (let i = 0; i < 30; i++) {
        await _sleep(1000);
        try {
            const res = await fetch(`/api/bots/tasks/${taskId}`);
            if (!res.ok) continue;
            const task = await res.json();

            if (task.status === 'done') {
                if (taskEl) { taskEl.textContent = `✅ ${action} erfolgreich`; taskEl.className = 'task-status done'; }
                _ctx.showToast?.(`LendingBot: ${action} OK`, 'success');
                return;
            }
            if (task.status === 'failed') {
                const msg = task.error ?? 'Unbekannter Fehler';
                if (taskEl) { taskEl.textContent = `❌ ${msg}`; taskEl.className = 'task-status failed'; }
                _ctx.showToast?.(`LendingBot: ${msg}`, 'error');
                return;
            }
            if (taskEl) { taskEl.textContent = `${task.status}…`; }
        } catch { /* ignorieren, weiter warten */ }
    }
    if (taskEl) { taskEl.textContent = 'Timeout – kein Ergebnis'; taskEl.className = 'task-status failed'; }
}

// ── Wallet-Karte ───────────────────────────────────────────────────────────────

// Datum/Uhrzeit + Minuten seit dem letzten Wallet-Monitor-Check.
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

/**
 * status: { ok: boolean, tooltip: string } | null
 *   ok === true  → grüner Haken (genug SOL)
 *   ok === false → roter Kreuz + Tooltip (zu wenig SOL)
 *   null         → kein Haken/Kreuz, normale Textfarbe (noch keine SOL-Daten vorhanden)
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

async function _refreshWalletMonitor(card, el) {
    const btn = card.querySelector('#lb-wallet-btn-refresh-all');
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

async function _renderWallet(el) {
    el.innerHTML = '<div class="wallet-loading">Lade…</div>';
    try {
        const [infoRes, balRes, addrRes] = await Promise.all([
            fetch('/api/wallet/lending/info'),
            fetch('/api/wallet/lending/balance'),
            fetch('/api/addresses'),
        ]);
        if (!infoRes.ok) throw new Error(`Wallet-Info konnte nicht geladen werden (HTTP ${infoRes.status})`);
        if (!balRes.ok) throw new Error(`Wallet-Bestand konnte nicht geladen werden (HTTP ${balRes.status})`);
        if (!addrRes.ok) throw new Error(`Adressbuch konnte nicht geladen werden (HTTP ${addrRes.status})`);
        const info    = await infoRes.json();
        const balance = await balRes.json();
        const addrs   = await addrRes.json();

        const lendingStatus = balance?.sol != null
            ? { ok: balance.sol > SOL_LOW_THRESHOLD_LENDING, tooltip: 'Zu wenig SOL im Wallet für den Betrieb des Bots.' }
            : null;

        el.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'settings-card';
        card.innerHTML = `
            <div class="settings-card-header">
                <span class="sch-title">Wallet</span>
            </div>
            <table class="wallet-action-table">
                <tbody>
                    ${_walletRowHtml('Lending Bot', balance, lendingStatus)}
                    <tr>
                        <td class="wat-label">Letzter Check</td>
                        <td class="wat-info">${_esc(_formatLastCheck(balance?.recorded_at))}</td>
                        <td class="wat-action">
                            <button class="btn btn-secondary btn-sm" id="lb-wallet-btn-refresh-all">Aktualisieren</button>
                        </td>
                    </tr>
                </tbody>
            </table>`;
        el.appendChild(card);

        card.querySelector('#lb-wallet-btn-refresh-all')
            ?.addEventListener('click', () => _refreshWalletMonitor(card, el));

        card.querySelector('[data-wallet-manage-btn]')?.addEventListener('click', async () => {
            let freshInfo = info, freshBalance = balance, freshAddrs = addrs;
            try {
                const [infoR, balR, addrR] = await Promise.all([
                    fetch('/api/wallet/lending/info'),
                    fetch('/api/wallet/lending/balance'),
                    fetch('/api/addresses'),
                ]);
                if (infoR.ok) freshInfo    = await infoR.json();
                if (balR.ok)  freshBalance = await balR.json();
                if (addrR.ok) freshAddrs   = await addrR.json();
            } catch { /* Fallback auf zuletzt geladenen Stand */ }
            _openWalletManageModal(el, freshInfo, freshBalance, freshAddrs);
        });

    } catch (err) {
        el.innerHTML = `<div class="settings-card settings-error">Fehler: ${err.message}</div>`;
    }
}

// ── Guthaben – Modal (identische Aufschlüsselung wie im Dashboard) ───────────

/** Wandelt die flache /api/wallet/lending/balance-Antwort in das von
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
function _openWalletManageModal(el, info, balance, addrs) {
    const mid   = 'lb-wallet-modal';
    const tokens = [
        { symbol: 'SOL',  balance: balance.sol  ?? 0 },
        { symbol: 'USDC', balance: balance.usdc ?? 0 },
        ...(balance.tokens ?? [])
            .filter(t => t.symbol !== 'SOL' && t.symbol !== 'USDC' && (t.balance ?? 0) > 0),
    ];

    showModal({
        id:    mid,
        title: 'Wallet verwalten',
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
            <div id="wb-tab-empfangen" hidden>${_buildReceivePanelHtml(info)}</div>
            <div id="wb-tab-key" hidden>${_buildKeyPanelHtml(info)}</div>`,
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

    _wireSendPanel(modalEl, tokens, addrs);
    _wireReceivePanel(modalEl, info);
    _wireKeyPanel(modalEl, mid, el, info);
}

// ── Reiter "Empfangen": Adresse + QR-Code ────────────────────────────────────
function _buildReceivePanelHtml(info) {
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
                <img src="/api/wallet/lending/qr" alt="QR-Code" class="qr-img">
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
function _buildKeyPanelHtml(info) {
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
            <a class="btn btn-secondary btn-sm" href="/api/wallet/lending/keypair/export" download>&#11015; Herunterladen</a>
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

function _wireKeyPanel(modalEl, mid, el, info) {
    modalEl.querySelector('#wb-key-save-btn')?.addEventListener('click', () => _saveKey(mid, modalEl, el));
}

async function _saveKey(mid, modalEl, el) {
    const input    = modalEl.querySelector('#wb-key-input');
    const feedback = modalEl.querySelector('#wb-key-feedback');
    const content  = input?.value.trim();

    if (!content) {
        if (feedback) { feedback.textContent = 'Bitte Key einfügen.'; feedback.className = 'modal-feedback error'; }
        return;
    }
    if (feedback) { feedback.textContent = 'Speichere…'; feedback.className = 'modal-feedback'; }

    try {
        const res  = await fetch('/api/wallet/lending/keypair', {
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

// ── Reiter "Senden" (innere Tabs Senden/Adressbuch) ──────────────────────────
function _buildSendPanel(tokens) {
    const sel   = _selectedSendAddr;
    const isSol = tokens.length > 0 && tokens[0].symbol === 'SOL';
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

function _wireSendPanel(modalEl, tokens, initialAddrs) {
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
            const res = await fetch(`/api/wallet/lending/balance?fresh=1&t=${Date.now()}`);
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
                const res  = await fetch('/api/wallet/lending/send', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ symbol, amount, toAddress }),
                });
                const data = await res.json();

                if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

                const explorerUrl = `https://solscan.io/tx/${data.txHash}`;
                fb.innerHTML  = `✓ Gesendet: ${_fmt(amount)} ${_esc(symbol)} → ${_esc(_selectedSendAddr.name)} `
                              + `<a href="${explorerUrl}" target="_blank" rel="noopener" class="tx-link">TX&nbsp;ansehen&nbsp;↗</a>`;
                fb.className  = 'modal-feedback ok';
                if (amountInp) amountInp.value = '';
                // Nach 3 Sekunden refreshen – Zeit für on-chain settle
                setTimeout(() => {
                    backdrop.querySelector('#wm-refresh')?.click();
                    const walletEl = _container?.querySelector('.liquiditybot-grid-wallet');
                    if (walletEl) _renderWallet(walletEl);
                }, 3000);
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

// ── Protokoll-Karte ───────────────────────────────────────────────────────────

async function _renderProtocols(el) {
    el.innerHTML = '<div class="wallet-loading">Lade…</div>';
    try {
        const [lendingRes, cfgRes] = await Promise.all([
            fetch('/api/lending/config'),
            fetch('/api/config/lendingbot'),
        ]);
        const lending = lendingRes.ok ? await lendingRes.json() : {};
        const cfg     = cfgRes.ok     ? await cfgRes.json()     : {};

        el.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'settings-card';
        el.appendChild(card);
        _renderProtocolsTable(card, lending, cfg);
    } catch (err) {
        el.innerHTML = `<div class="settings-card settings-error">Fehler: ${err.message}</div>`;
    }
}

function _aprLabel(apy) {
    if (apy == null) return '--';
    return String(Math.round(apy)).padStart(2, '0');
}

function _renderProtocolsTable(card, lending, cfg) {
    const protocols = lending.protocols ?? [];

    // Nach APY absteigend sortieren (null-Werte ans Ende)
    const sorted = protocols
        .slice()
        .sort((a, b) => (b.apy ?? -Infinity) - (a.apy ?? -Infinity));

    // Keine verlässlichen Daten: entweder der Bot läuft gerade nicht (Status
    // aus der Service-Karte, Cache via _ctx.getStatus) – dann können auch
    // vorhandene APY-Werte veraltet sein, siehe "Letzter Check" – oder es gibt
    // schlicht noch nie Daten (Bot lief noch nie / ist gerade erst gestartet).
    // Statt einer irreführenden Liste: eindeutiger Hinweis + alle Aktionen
    // gesperrt, damit nichts versehentlich auf Basis unvollständiger/veralteter
    // Daten aktiviert/deaktiviert wird.
    const botStatus = _ctx.getStatus?.(SVC_ID);
    const noData = botStatus !== 'active' || sorted.length === 0 || sorted.every(p => p.apy == null);

    // Aktives Protokoll bestimmen – persistiert in localStorage
    const active = !noData ? (sorted.find(p => p.id === _activeProtocol) ?? sorted[0] ?? null) : null;
    if (active && _activeProtocol !== active.id) {
        _activeProtocol = active.id;
        localStorage.setItem('lb.activeProtocol', _activeProtocol);
    }

    const poolOptionsHtml = noData
        ? `<option disabled selected>Bitte Lending Bot aktivieren</option>`
        : sorted.map(p => `
            <option value="${_esc(p.id)}" ${p.id === active?.id ? 'selected' : ''}${p.active ? '' : ' style="color:#888"'}>
                [${_aprLabel(p.apy)}] ${_esc(p.label)}${p.active ? '' : p.qualified ? '' : ' ⊘'}${p.enabled ? '' : ' (deaktiviert)'}
            </option>`).join('');

    card.innerHTML = `
        <div class="settings-card-header"><span class="sch-title">Lending Pools</span></div>
        <table class="wallet-action-table">
            <tbody>
                <tr>
                    <td class="wat-label">Pool</td>
                    <td class="wat-info">
                        <select class="modal-select pool-select" id="lb-pool-selector" ${noData ? 'disabled' : ''}>
                            ${poolOptionsHtml}
                        </select>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="lb-btn-pool-enabled"
                            ${noData ? 'disabled' : ''}>${active?.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label">
                        <span style="display:flex;align-items:center;gap:0.4rem;">TVL-Schutz
                        <span class="info-tip-label"
                            data-tooltip-title="TVL-Schutz (Auto-Exit)"
                            data-tooltip-content="Fällt der Markt-TVL dieses Protokolls unter die Schwelle, wird das Kapital automatisch zu 100 % abgezogen – optional an eine Adresse versendet.">&#9432;</span></span>
                    </td>
                    <td class="wat-info">${noData || (active && active.disabledReason) ? '<span class="pool-summary-off">—</span>' : _tvlGuardSummary(active?.tvlGuard)}</td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="lb-btn-tvlguard"
                            ${noData ? 'disabled' : (active && active.disabledReason ? 'disabled title="Pool nicht nutzbar – kein TVL-Schutz nötig"' : '')}>Verwalten</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label">
                        <span style="display:flex;align-items:center;gap:0.4rem;">Einzahlen
                        <span class="info-tip-label"
                            data-tooltip-title="In Protokoll einzahlen"
                            data-tooltip-content="Zahlt USDC aus dem Wallet direkt in ein Lending-Protokoll ein. Während der TX wird Auto-Deploy kurz pausiert.">&#9432;</span></span>
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">in Protokoll</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="lb-btn-deposit-proto"
                            ${noData ? 'disabled' : (active && !active.qualified ? 'disabled title="Pool deaktiviert oder erfüllt die APY-Schwelle nicht"' : '')}>Einzahlen</button>
                    </td>
                </tr>
                <tr>
                    <td class="wat-label">
                        <span style="display:flex;align-items:center;gap:0.4rem;">Auszahlen
                        <span class="info-tip-label"
                            data-tooltip-title="Aus Protokoll auszahlen"
                            data-tooltip-content="Hebt USDC aus einem Lending-Protokoll zurück ins Wallet ab. Während der TX wird Auto-Deploy pausiert – schalte ihn ggf. dauerhaft aus, damit die Mittel nicht sofort wieder deployed werden.">&#9432;</span></span>
                    </td>
                    <td class="wat-info">
                        <span class="pool-summary">aus Protokoll</span>
                    </td>
                    <td class="wat-action">
                        <button class="btn btn-secondary btn-sm" id="lb-btn-withdraw-proto"
                            ${noData ? 'disabled' : (active && !active.active ? 'disabled title="Kein Guthaben in diesem Pool"' : '')}>Auszahlen</button>
                    </td>
                </tr>
            </tbody>
        </table>
        ${noData ? `
        <p style="margin:0.6rem 0 0;font-size:0.78rem;color:var(--text-muted);line-height:1.4;">
            Noch keine Pool-Daten verfügbar. Prüfe oben in der Zeile "Status", ob der Lending Bot läuft –
            nach dem Start dauert es nur wenige Sekunden bis zum ersten Tick.
        </p>` : ''}
        ${!noData && active && active.disabledReason ? `
        <p style="margin:0.6rem 0 0;font-size:0.78rem;color:var(--text-muted);line-height:1.4;">
            ⊘ <strong>${_esc(active.label)}</strong> ist derzeit nicht nutzbar: ${_esc(active.disabledReason)}.
            Der Pool wird nur zur Information gelistet – Einzahlen, Auszahlen und TVL-Schutz sind deaktiviert.
        </p>` : ''}`;

    card.querySelector('#lb-pool-selector')?.addEventListener('change', e => {
        _activeProtocol = e.target.value;
        localStorage.setItem('lb.activeProtocol', _activeProtocol);
        _renderProtocolsTable(card, lending, cfg);
        card.classList.remove('card-pool-switch-flash');
        void card.offsetWidth;
        card.classList.add('card-pool-switch-flash');
        card.addEventListener('animationend', () => card.classList.remove('card-pool-switch-flash'), { once: true });
    });

    card.querySelector('#lb-btn-tvlguard')
        ?.addEventListener('click', () => active && _openTvlGuardModal(active, card));
    card.querySelector('#lb-btn-deposit-proto')
        ?.addEventListener('click', () => active && _openProtoDepositModal(active, card));
    card.querySelector('#lb-btn-withdraw-proto')
        ?.addEventListener('click', () => active && _openProtoWithdrawModal(active, card));
    card.querySelector('#lb-btn-pool-enabled')
        ?.addEventListener('click', (e) => active && _togglePoolEnabled(active, card, e.currentTarget));
}

async function _togglePoolEnabled(proto, card, btn) {
    const newEnabled = !proto.enabled;
    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = '…';
    try {
        const res = await fetch(`/api/lending/pool-enabled/${proto.id}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ enabled: newEnabled }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

        _ctx.showToast?.(
            newEnabled ? `Pool "${proto.label}" aktiviert` : `Pool "${proto.label}" deaktiviert`,
            'success'
        );
        if (data.tvlGuard) {
            _ctx.showToast?.(
                `TVL-Schutz-Schwelle für "${proto.label}" auf ${Math.round(data.tvlGuard.thresholdUsd).toLocaleString('de-DE')} USDC gesenkt (50 % des aktuellen TVL) – verhindert sofortiges Wieder-Deaktivieren.`,
                'success'
            );
        }
        await _refreshProtocolsCard(card);
    } catch (err) {
        btn.disabled = false;
        btn.textContent = origLabel;
        _ctx.showToast?.(`Fehler: ${err.message}`, 'error');
    }
}

// ── Einzahlen – Modal ────────────────────────────────────────────────────────

async function _openProtoDepositModal(proto, card) {
    const mid = 'lb-proto-deposit-modal';

    if (!proto.qualified) {
        _ctx.showToast?.(`${proto.label} besteht den internen Filter nicht – Einzahlen nicht möglich.`, 'error');
        return;
    }

    // Wallet-Balance vorab laden für Max-Button und Hinweis
    let walletUsdc = 0;
    try {
        const r = await fetch('/api/wallet/lending/balance');
        if (r.ok) { const d = await r.json(); walletUsdc = d.usdc ?? 0; }
    } catch { /* kein Wallet-Stand – trotzdem öffnen */ }

    showModal({
        id:    mid,
        title: `Einzahlen – ${_esc(proto.label)}`,
        body:  `
            <div class="settings-row">
                <span class="settings-label">Betrag</span>
                <div class="send-amount-row">
                    <input class="modal-input input-short" id="lb-dep-amount"
                        type="number" min="0" step="any" placeholder="0.00">
                    <button class="btn btn-secondary btn-sm" id="lb-dep-max">Max</button>
                    <span class="input-unit">USDC</span>
                </div>
            </div>
            <p class="modal-hint" style="margin-top:0.5rem;">
                Wallet: <strong>${_fmt(walletUsdc)} USDC</strong>
                ${!proto.active ? '<br>&#9888; Pool aktuell inaktiv – es wird eine neue Position eröffnet.' : ''}
            </p>
            <p class="modal-hint">
                Auto-Deploy wird während der Transaktion automatisch pausiert.
            </p>
            <div class="modal-feedback" id="lb-dep-feedback"></div>`,
        actions: [
            { label: '&#10004; Einzahlen', primary: true, onClick: () => _execDeposit(mid, proto, card) },
            { label: 'Schließen',          onClick: () => closeModal(mid) },
        ],
    });

    getModal(mid)?.querySelector('#lb-dep-max')?.addEventListener('click', () => {
        const inp = document.getElementById('lb-dep-amount');
        if (inp) inp.value = Math.floor(walletUsdc * 100) / 100;
    });
}

async function _execDeposit(modalId, proto, card) {
    const fb     = document.getElementById('lb-dep-feedback');
    const amount = parseFloat(document.getElementById('lb-dep-amount')?.value ?? '0');

    if (!amount || amount <= 0) {
        if (fb) { fb.textContent = 'Bitte Betrag eingeben.'; fb.className = 'modal-feedback error'; }
        return;
    }

    const modalEl = getModal(modalId);
    const btns    = modalEl?.querySelectorAll('.forge-modal-footer button') ?? [];
    btns.forEach(b => b.disabled = true);
    if (fb) { fb.textContent = 'Transaktion läuft… (kann bis zu 2 Min. dauern)'; fb.className = 'modal-feedback'; }

    try {
        const res  = await fetch('/api/lending/deposit', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ protocol: proto.id, amount }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

        if (fb) { fb.textContent = `✓ ${amount} USDC in ${data.result?.protoLabel ?? proto.label} eingezahlt.`; fb.className = 'modal-feedback success'; }
        _ctx.showToast?.(`Deposit ${_fmt(amount)} USDC → ${data.result?.protoLabel ?? proto.label}`, 'success');
        _refreshProtocolsCard(card);
    } catch (err) {
        if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
        _ctx.showToast?.(`Deposit fehlgeschlagen: ${err.message}`, 'error');
    } finally {
        btns.forEach(b => b.disabled = false);
    }
}

// ── Auszahlen – Modal ─────────────────────────────────────────────────────────

async function _openProtoWithdrawModal(proto, card) {
    const mid = 'lb-proto-withdraw-modal';

    if (!proto.active) {
        _ctx.showToast?.(`${proto.label} hat kein Guthaben – Auszahlen nicht möglich.`, 'error');
        return;
    }

    const posAmount = proto.amount ?? 0;

    showModal({
        id:    mid,
        title: `Auszahlen – ${_esc(proto.label)}`,
        body:  `
            <div class="settings-row">
                <span class="settings-label">Betrag</span>
                <div class="send-amount-row">
                    <input class="modal-input input-short" id="lb-wd-amount"
                        type="number" min="0" step="any" placeholder="0.00">
                    <button class="btn btn-secondary btn-sm" id="lb-wd-all">Alles</button>
                    <span class="input-unit">USDC</span>
                </div>
            </div>
            <p class="modal-hint" style="margin-top:0.5rem;">
                Position: <strong>${_fmt(posAmount)} USDC</strong>
            </p>
            <p class="modal-hint">
                Auto-Deploy wird während der Transaktion pausiert. Schalte ihn ggf. dauerhaft
                aus (Auto-Deploy → Verwalten), damit die Mittel nicht sofort wieder deployed werden.
            </p>
            <div class="modal-feedback" id="lb-wd-feedback"></div>`,
        actions: [
            { label: '&#10004; Auszahlen', primary: true, onClick: () => _execWithdraw(mid, proto, card) },
            { label: 'Schließen',          onClick: () => closeModal(mid) },
        ],
    });

    getModal(mid)?.querySelector('#lb-wd-all')?.addEventListener('click', () => {
        const inp = document.getElementById('lb-wd-amount');
        if (inp) inp.value = Math.floor(posAmount * 100) / 100;
    });
}

async function _execWithdraw(modalId, proto, card) {
    const fb  = document.getElementById('lb-wd-feedback');
    const raw = document.getElementById('lb-wd-amount')?.value.trim();
    const amount = parseFloat(raw ?? '0');

    if (!amount || amount <= 0) {
        if (fb) { fb.textContent = 'Bitte Betrag eingeben oder „Alles" klicken.'; fb.className = 'modal-feedback error'; }
        return;
    }

    const modalEl = getModal(modalId);
    const btns    = modalEl?.querySelectorAll('.forge-modal-footer button') ?? [];
    btns.forEach(b => b.disabled = true);
    if (fb) { fb.textContent = 'Transaktion läuft… (kann bis zu 2 Min. dauern)'; fb.className = 'modal-feedback'; }

    try {
        const res  = await fetch('/api/lending/withdraw', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ protocol: proto.id, amount }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

        const r = data.result;
        if (r?.withdrawType === 'cooldown') {
            const readyStr = r.readyAt ? new Date(r.readyAt).toLocaleString('de-DE') : '?';
            if (fb) { fb.textContent = `⏳ Cooldown gestartet. Mittel verfügbar ab: ${readyStr}`; fb.className = 'modal-feedback'; }
            _ctx.showToast?.(`Withdraw-Cooldown gestartet – bereit ab ${readyStr}`, 'success');
        } else {
            if (fb) { fb.textContent = `✓ ${_fmt(r?.effectiveAmount ?? amount)} USDC aus ${r?.protoLabel ?? proto.label} abgehoben.`; fb.className = 'modal-feedback success'; }
            _ctx.showToast?.(`Withdraw ${_fmt(r?.effectiveAmount ?? amount)} USDC ← ${r?.protoLabel ?? proto.label}`, 'success');
        }
        _refreshProtocolsCard(card);
    } catch (err) {
        if (fb) { fb.textContent = `Fehler: ${err.message}`; fb.className = 'modal-feedback error'; }
        _ctx.showToast?.(`Withdraw fehlgeschlagen: ${err.message}`, 'error');
    } finally {
        btns.forEach(b => b.disabled = false);
    }
}

// ── Protokoll-Karte neu laden ─────────────────────────────────────────────────

async function _refreshProtocolsCard(card) {
    // Wallet-Karte neu laden
    const walletEl = _container?.querySelector('.liquiditybot-grid-wallet');
    if (walletEl) _renderWallet(walletEl);

    // Protokoll-Karte neu laden (Positionen + APY aktualisiert)
    try {
        const [lendingRes, cfgRes] = await Promise.all([
            fetch('/api/lending/config'),
            fetch('/api/config/lendingbot'),
        ]);
        const lending = lendingRes.ok ? await lendingRes.json() : {};
        const cfg     = cfgRes.ok     ? await cfgRes.json()     : {};
        _renderProtocolsTable(card, lending, cfg);
    } catch { /* ignorieren */ }
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
function _esc(s)    { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _fmt(n)    { const v = parseFloat(n); return isNaN(v) ? '0' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 6 }); }
