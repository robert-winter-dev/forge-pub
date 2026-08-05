/**
 * FORGE – Zentrales Wallet-Detail-Modal
 *
 * Gemeinsam genutzt von allen Bot-Dashboards (Liquidity, Lending, ...) UND vom
 * Settings-Backend (bots/settings/html/js/bot-liquidity.js,bot-lending.js) –
 * dort wird buildWalletDetailHtml() direkt in den dortigen eigenen Modal-
 * Mechanismus (showModal()) eingespeist, statt die hiesige Overlay-Chrome
 * (initWalletDetailModal) zu übernehmen. So bleibt die Aufschlüsselung
 * (Tabelle + Meta-Zeile) an EINER Stelle gepflegt, auch wenn Dashboard und
 * Settings unterschiedliche Modal-Rahmen verwenden.
 *
 * Erwartet im HTML (nur für initWalletDetailModal, Dashboard-Gebrauch):
 *   <div id="walletDetailModal">
 *     <button id="walletDetailModalClose">...</button>
 *     <div id="walletDetailModalBody"></div>
 *   </div>
 *   <span id="walletValue">...</span>  (Klick öffnet das Modal)
 *
 * Erwartetes Datenformat (data.walletMonitor):
 *   { snapshot: { sol_balance, usdc_balance, sol_price_usd?, total_usd,
 *                 age_seconds, recorded_at, is_stale },
 *     tokens: [{ symbol, balance, value_usd }] }
 *
 * Verwendung (Dashboard):
 *   import { initWalletDetailModal } from '../../js/wallet-detail-modal.js?v=...';
 *   initWalletDetailModal(() => _lastData);
 *
 *   // Falls der SOL-Preis nicht in snapshot.sol_price_usd steht, sondern
 *   // woanders im Datensatz (z.B. LendingBot: data.portfolio.solPrice):
 *   initWalletDetailModal(() => dm.data, {
 *       solPriceUsd: data => data?.portfolio?.solPrice ?? null,
 *   });
 *
 * Verwendung (Settings, eigener Modal-Rahmen):
 *   import { buildWalletDetailHtml } from '/forge/js/wallet-detail-modal.js?v=...';
 *   showModal({ id, title: 'Wallet-Guthaben', body: buildWalletDetailHtml(data), ... });
 */

function fmt(v, dec = 2) {
    if (v == null) return '—';
    return Number(v).toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// Rundet wie fmt() auf 2 Nachkommastellen – ein Gegenwert, der dabei auf 0,00 USDC
// fällt, ist optisch nicht von "kein Wert" zu unterscheiden und wird ausgeblendet.
function roundsToZeroUsdc(v) {
    return Math.round((v ?? 0) * 100) === 0;
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Baut die Wallet-Aufschlüsselung (Tabelle + Meta-Zeile) als HTML-String –
 * unabhängig vom umgebenden Modal-Rahmen, damit sowohl das Dashboard-Overlay
 * als auch Settings' showModal() dasselbe Markup einspeisen können.
 *
 * @param {object} data  { walletMonitor: { snapshot, tokens } }
 * @param {object} [opts]
 * @param {(data: object, snapshot: object) => (number|null)} [opts.solPriceUsd]
 *        Optionaler SOL-Preis-Getter, falls nicht in snapshot.sol_price_usd enthalten.
 */
export function buildWalletDetailHtml(data, opts = {}) {
    const wmSnap = data?.walletMonitor?.snapshot ?? null;
    const tokens = data?.walletMonitor?.tokens   ?? [];

    if (!wmSnap) {
        return '<p style="color:var(--text-secondary);text-align:center;padding:1rem 0">Keine Wallet-Daten verfügbar</p>';
    }

    const tokenTotalUsd = tokens.reduce((s, t) => s + (t.value_usd ?? 0), 0);
    const solPrice      = opts.solPriceUsd?.(data, wmSnap) ?? wmSnap.sol_price_usd ?? null;
    const solValueUsd   = solPrice != null
        ? wmSnap.sol_balance * solPrice
        : Math.max(0, wmSnap.total_usd - wmSnap.usdc_balance - tokenTotalUsd);
    const SOL_RESERVED  = 0.1;

    const items = [];

    if ((wmSnap.sol_balance ?? 0) > 0 && !roundsToZeroUsdc(Math.max(0, solValueUsd))) {
        items.push({
            symbol: 'SOL',
            valueUsd: Math.max(0, solValueUsd),
            html: `<tr>
                <td class="has-tooltip"
                    data-tooltip-title="SOL-Balance"
                    data-tooltip-content="Davon ${fmt(SOL_RESERVED, 1)}&nbsp;SOL fest reserviert für Transaktionsgebühren."
                    data-tooltip-type="text">${fmt(wmSnap.sol_balance, 4)}&nbsp;SOL</td>
                <td>${fmt(Math.max(0, solValueUsd))}&nbsp;USDC</td>
            </tr>`
        });
    }

    if ((wmSnap.usdc_balance ?? 0) > 0 && !roundsToZeroUsdc(wmSnap.usdc_balance)) {
        items.push({
            symbol: 'USDC',
            valueUsd: wmSnap.usdc_balance,
            html: `<tr>
                <td>${fmt(wmSnap.usdc_balance)}&nbsp;USDC</td>
                <td>${fmt(wmSnap.usdc_balance)}&nbsp;USDC</td>
            </tr>`
        });
    }

    for (const t of tokens) {
        if ((t.balance ?? 0) <= 0 || roundsToZeroUsdc(t.value_usd)) continue;
        items.push({
            symbol: t.symbol,
            valueUsd: t.value_usd ?? 0,
            html: `<tr>
                <td>${fmt(t.balance, 6)}&nbsp;${escHtml(t.symbol)}</td>
                <td>${fmt(t.value_usd)}&nbsp;USDC</td>
            </tr>`
        });
    }

    items.sort((a, b) => {
        const diff = (b.valueUsd ?? 0) - (a.valueUsd ?? 0);
        return diff !== 0 ? diff : a.symbol.localeCompare(b.symbol);
    });

    const scrollClass   = items.length > 5 ? ' scrollable' : '';
    const ageSec        = wmSnap.age_seconds ?? 0;
    const snapDt        = new Date(wmSnap.recorded_at);
    const snapTime      = `${String(snapDt.getHours()).padStart(2,'0')}:${String(snapDt.getMinutes()).padStart(2,'0')} Uhr`;
    const nextSec       = Math.max(0, 10 * 60 - ageSec);
    const nextMin       = Math.round(nextSec / 60);
    const nextHtml      = nextMin <= 0 ? '< 1 Min.' : `${nextMin} Min.`;
    const staleHtml     = wmSnap.is_stale
        ? ' &nbsp;<span style="color:var(--warning,#f59e0b)">⚠ veraltet</span>' : '';

    return `
        <table class="wallet-detail-table${scrollClass}">
            <thead><tr><th>Guthaben</th><th>Wert</th></tr></thead>
            <tbody>${items.map(i => i.html).join('')}</tbody>
            <tfoot>
                <tr class="wallet-detail-total">
                    <td>Gesamt</td>
                    <td>${fmt(wmSnap.total_usd)}&nbsp;USDC</td>
                </tr>
            </tfoot>
        </table>
        <div class="wallet-detail-meta">Stand: ${snapTime} (Nächstes Update in ${nextHtml})${staleHtml}</div>`;
}

/**
 * @param {() => object} getData  Liefert das aktuelle Dashboard-Datenobjekt.
 * @param {object} [opts]  Siehe buildWalletDetailHtml().
 */
export function initWalletDetailModal(getData, opts = {}) {
    const modal    = document.getElementById('walletDetailModal');
    const closeBtn = document.getElementById('walletDetailModalClose');
    const valueEl  = document.getElementById('walletValue');
    if (!modal || !valueEl) return;

    valueEl.addEventListener('click', () => openWalletDetailModal(getData(), opts));
    closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none';
    });
}

function openWalletDetailModal(data, opts = {}) {
    const modal  = document.getElementById('walletDetailModal');
    const bodyEl = document.getElementById('walletDetailModalBody');
    if (!modal || !bodyEl) return;

    bodyEl.innerHTML = buildWalletDetailHtml(data, opts);
    modal.style.display = 'flex';
}
