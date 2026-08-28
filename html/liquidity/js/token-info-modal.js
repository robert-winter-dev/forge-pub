// token-info-modal.js v20260823b
// Zeigt statische Kurzinfos (Kategorie, Beschreibung, Projekt-Link) zu den beiden
// Tokens eines Pools in einem Modal mit zwei Tabs. Daten aus token-info-data.json über
// token-info-store.js (JSON-Fetch statt Modul-Import, siehe dort). Lazy-geladen analog
// pool-chart-modal.js.

import { loadTokenInfo, getTokenInfo } from './token-info-store.js?v=20260727a';

let _modal = null;

function ensureModal() {
    if (_modal) return;
    _modal = document.createElement('div');
    _modal.id = 'tokenInfoModal';
    _modal.className = 'modal-overlay hidden';
    _modal.setAttribute('role', 'dialog');
    _modal.setAttribute('aria-modal', 'true');
    _modal.innerHTML = `
<div class="modal-box modal-box-narrow">
  <div class="modal-header">
    <h3 id="tokenInfoModalTitle" style="margin:0;font-size:1rem"></h3>
    <button class="modal-close" id="tokenInfoModalClose" aria-label="Schliessen">&#x2715;</button>
  </div>
  <div class="modal-tabs" id="tokenInfoModalTabs"></div>
  <div id="tokenInfoModalPanels"></div>
</div>`;
    document.body.appendChild(_modal);

    document.getElementById('tokenInfoModalClose')
        .addEventListener('click', closeTokenInfoModal);
    _modal.addEventListener('click', e => {
        if (e.target === _modal) closeTokenInfoModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !_modal.classList.contains('hidden'))
            closeTokenInfoModal();
    });
}

// Ordnet die Namen aus dem Anzeige-Pair ("SPX"/"USDC") den richtigen Mint-Adressen zu.
//
// Fuer Pools mit `usdcIsTokenA` (SPX/USDC, EURC/USDC, seit bin/export.js:319 exportiert)
// steht USDC on-chain als tokenA, das Pair wird aber in Orca-Reihenfolge geschrieben
// (Nicht-USDC-Seite zuerst) — siehe lib/btc-correlation/index.js, lib/sol-topup.js,
// bin/cleanup.js. Ein Namensvergleich gegen `pool.pair` geht dabei von der falschen
// Reihenfolge aus und dreht die Zuordnung um (historischer Bug: im SPX-Tab stand die
// USDC-Beschreibung). Deshalb hier das maßgebliche Feld direkt auswerten.
//
// Fuer alle anderen Pools (keine USDC-Seite, z.B. SOL/HYPE) gilt weiterhin der
// Namensvergleich gegen pool.pair, gleiche Logik wie buildTabs() in pool-chart-modal.js.
function resolveTabTokens(pool) {
    const dp = pool.displayPair ?? pool.pair ?? '/';
    const [dpA, dpB] = dp.split('/').map(s => s.trim());

    if (pool.usdcIsTokenA) {
        const usdcIsDpA = dpA?.toUpperCase() === 'USDC';
        return [
            { name: dpA ?? '?', mint: usdcIsDpA ? pool.tokenA : pool.tokenB },
            { name: dpB ?? '?', mint: usdcIsDpA ? pool.tokenB : pool.tokenA },
        ];
    }

    const [pA] = (pool.pair ?? '/').split('/').map(s => s.trim());
    const dpAisTokenA = dpA?.toUpperCase() === pA?.toUpperCase();
    return [
        { name: dpA ?? '?', mint: dpAisTokenA ? pool.tokenA : pool.tokenB },
        { name: dpB ?? '?', mint: dpAisTokenA ? pool.tokenB : pool.tokenA },
    ];
}

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function renderPanel(token) {
    const info = getTokenInfo(token.mint);
    if (!info) {
        return `<p class="text-muted" style="margin:0;font-size:0.85rem">Keine Infos zu diesem Token hinterlegt.</p>`;
    }
    const linkHtml = info.url
        ? `<p style="margin:0.75rem 0 0"><a class="token-info-link" href="${escHtml(info.url)}" target="_blank" rel="noopener noreferrer">${escHtml(info.url)}</a></p>`
        : `<p class="text-muted" style="margin:0.75rem 0 0;font-size:0.85rem">Kein Projekt-Link hinterlegt.</p>`;
    return `
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:0.6rem">
            <span style="background:var(--border);color:var(--text-primary);font-size:0.72rem;font-weight:600;padding:2px 8px;border-radius:999px">${escHtml(info.category)}</span>
        </div>
        <p style="margin:0;font-size:0.88rem;line-height:1.5;color:var(--text-secondary)">${escHtml(info.description)}</p>
        ${linkHtml}`;
}

export async function openTokenInfoModal(pool) {
    await loadTokenInfo(); // idempotent — i.d.R. schon durch app.js beim Start geladen
    ensureModal();

    document.getElementById('tokenInfoModalTitle').textContent =
        pool.displayPair ?? pool.pair ?? '--';

    const tokens = resolveTabTokens(pool);
    const tabBar = document.getElementById('tokenInfoModalTabs');
    const panels = document.getElementById('tokenInfoModalPanels');
    tabBar.innerHTML = '';
    panels.innerHTML = '';

    tokens.forEach((token, i) => {
        const btn = document.createElement('button');
        btn.className = 'modal-tab-btn' + (i === 0 ? ' active' : '');
        btn.textContent = token.name;
        btn.addEventListener('click', () => {
            tabBar.querySelectorAll('.modal-tab-btn').forEach((b, j) => b.classList.toggle('active', j === i));
            panels.querySelectorAll('.modal-tab-panel').forEach((p, j) => p.classList.toggle('active', j === i));
        });
        tabBar.appendChild(btn);

        const panel = document.createElement('div');
        panel.className = 'modal-tab-panel' + (i === 0 ? ' active' : '');
        panel.innerHTML = renderPanel(token);
        panels.appendChild(panel);
    });

    _modal.classList.remove('hidden');
}

function closeTokenInfoModal() {
    _modal?.classList.add('hidden');
}
