// pool-chart-modal.js v20260909a
// Kurs-Charts fuer Pools.
// Datenquelle 1 (bevorzugt): lokale price-history.json aus pool_stats-DB
// Datenquelle 2 (Fallback): GeckoTerminal API (CORS: access-control-allow-origin: *)
// Lazy-geladen beim ersten Klick - kein Nexus, kein Backend noetig.
// Pro Tab zusaetzlich ein Link auf den GeckoTerminal-Chart (extern, TradingView-artig),
// wenn GeckoTerminal fuer diese Kombination einen Pool kennt - sonst kein Link.

const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const GECKO_BASE    = 'https://api.geckoterminal.com/api/v2';
const CJS_CDN       = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js';
const GECKO_HEADERS = { Accept: 'application/json;version=20230302' };
const RANGES        = [{ l: '1D', n: 24 }, { l: '1W', n: 168 }, { l: '1M', n: 720 }];
const geckoPoolUrl  = addr => 'https://www.geckoterminal.com/solana/pools/' + addr;

let _modal     = null;
let _cjsLoad   = null;
let _phLoad    = null;   // price-history.json laden (einmalig)
let _ph        = null;   // gecachte price-history
let _charts    = {};
let _cache     = new Map();   // `${source}_${key}_${limit}` -> [{x,y}]
let _tokenPoolCache = new Map(); // mint -> { address, tokenParam } | null (GeckoTerminal-USDC-Pool je Token)
let _pool      = null;
let _tabs      = [];
let _activeTab = 0;

const LS_POOL_CHART_LIMIT = 'liquiditybot_pool_chart_limit';
const _storedLimit = parseInt(localStorage.getItem(LS_POOL_CHART_LIMIT) ?? '', 10);
let _limit = RANGES.some(r => r.n === _storedLimit) ? _storedLimit : 168; // Default 1W

// -- Lazy-Loads --------------------------------------------------------------

function loadChartJs() {
    if (window.Chart) return Promise.resolve();
    if (_cjsLoad)     return _cjsLoad;
    _cjsLoad = new Promise((res, rej) => {
        const s  = document.createElement('script');
        s.src    = CJS_CDN;
        s.onload = res;
        s.onerror = () => rej(new Error('Chart.js konnte nicht geladen werden'));
        document.head.appendChild(s);
    });
    return _cjsLoad;
}

function loadPriceHistory() {
    if (_ph)      return Promise.resolve(_ph);
    if (_phLoad)  return _phLoad;
    _phLoad = fetch('data/price-history.json')
        .then(r => r.ok ? r.json() : null)
        .then(json => { _ph = json; return json; })
        .catch(() => null);
    return _phLoad;
}

// -- Modal-DOM (einmalig) ----------------------------------------------------

function ensureModal() {
    if (_modal) return;
    _modal = document.createElement('div');
    _modal.id = 'poolChartModal';
    _modal.className = 'modal-overlay hidden';
    _modal.setAttribute('role', 'dialog');
    _modal.setAttribute('aria-modal', 'true');
    _modal.innerHTML = `
<div class="modal-box pool-chart-modal-box">
  <div class="modal-header">
    <h3 id="poolChartModalTitle" style="margin:0;font-size:1rem"></h3>
    <div id="poolChartRangeBtns" class="chart-range-btns" style="margin-left:auto;margin-right:1rem"></div>
    <button class="modal-close" id="poolChartModalClose" aria-label="Schliessen">&#x2715;</button>
  </div>
  <div class="modal-tabs" id="poolChartModalTabs"></div>
  <div id="poolChartModalPanels" class="pool-chart-panels"></div>
</div>`;
    document.body.appendChild(_modal);

    document.getElementById('poolChartModalClose')
        .addEventListener('click', closePoolChartModal);
    _modal.addEventListener('click', e => {
        if (e.target === _modal) closePoolChartModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !_modal.classList.contains('hidden'))
            closePoolChartModal();
    });
}

// -- Oeffentliche API --------------------------------------------------------

export function openPoolChartModal(pool) {
    ensureModal();
    Object.values(_charts).forEach(c => c?.destroy());
    _charts    = {};
    _pool      = pool;
    _activeTab = 0;
    _tabs      = buildTabs(pool);

    document.getElementById('poolChartModalTitle').textContent =
        pool.displayPair ?? pool.pair ?? '--';

    buildRangeBtns();
    buildTabsDOM();

    // price-history.json vorladen (parallel zum Oeffnen des Modals)
    loadPriceHistory();

    activateTab(0);
    _modal.classList.remove('hidden');
}

function closePoolChartModal() {
    _modal?.classList.add('hidden');
    Object.values(_charts).forEach(c => c?.destroy());
    _charts = {};
}

// -- Tab-Konfiguration -------------------------------------------------------

function buildTabs(pool) {
    const isUsdcA = pool.tokenA === USDC_MINT;
    const isUsdcB = pool.tokenB === USDC_MINT;

    // Anzeigenamen immer aus displayPair (z.B. "HYPE/SOL"), nicht aus dem
    // internen pair ("SOL/HYPE"), damit Tab-Reihenfolge dem Nutzer entspricht.
    const dp = pool.displayPair ?? pool.pair ?? '/';
    const [dpA, dpB] = dp.split('/').map(s => s.trim());

    if (!isUsdcA && !isUsdcB) {
        // Beide Tokens sind kein USDC (volatile pair oder BTC/BTC).
        // Mint-Zuordnung: dpA-Name mit internem pair-Namen vergleichen → welcher Mint gehört zu dpA?
        const [pA] = (pool.pair ?? '/').split('/').map(s => s.trim());
        const dpAisTokenA = dpA.toUpperCase() === pA.toUpperCase();
        const mintDpA = dpAisTokenA ? pool.tokenA : pool.tokenB;
        const mintDpB = dpAisTokenA ? pool.tokenB : pool.tokenA;
        // Pool speichert tokenB/tokenA. Wenn displayPair gedreht ist (dpA=tokenB),
        // muss der Kehrwert gezeigt werden damit Richtung mit Orca uebereinstimmt.
        const invertRatio = !dpAisTokenA;
        return [
            { label: dp.replace('/', ' / '),  type: 'pair',  address: pool.address, invertRatio },
            { label: dpA + ' / USDC', type: 'token', mint: mintDpA },
            { label: dpB + ' / USDC', type: 'token', mint: mintDpB },
        ];
    }

    // Eine Seite ist USDC: nur ein Tab für den Nicht-USDC-Token.
    const nonUsdcName = dpA.toUpperCase() !== 'USDC' ? dpA : dpB;
    const nonUsdcMint = isUsdcA ? pool.tokenB : pool.tokenA;
    return [{ label: nonUsdcName + ' / USDC', type: 'token', mint: nonUsdcMint }];
}

// -- DOM-Aufbau --------------------------------------------------------------

function buildRangeBtns() {
    const wrap = document.getElementById('poolChartRangeBtns');
    wrap.innerHTML = '';
    for (const { l, n } of RANGES) {
        const btn = document.createElement('button');
        btn.className = 'chart-range-btn' + (n === _limit ? ' active' : '');
        btn.textContent = l;
        btn.addEventListener('click', () => {
            _limit = n;
            localStorage.setItem(LS_POOL_CHART_LIMIT, n);
            wrap.querySelectorAll('.chart-range-btn').forEach(b =>
                b.classList.toggle('active', b.textContent === l));
            loadAndRender(_activeTab, true);
        });
        wrap.appendChild(btn);
    }
}

function buildTabsDOM() {
    const tabBar = document.getElementById('poolChartModalTabs');
    const panels = document.getElementById('poolChartModalPanels');
    tabBar.innerHTML = '';
    panels.innerHTML = '';
    tabBar.style.display = _tabs.length <= 1 ? 'none' : '';

    _tabs.forEach((tab, i) => {
        const btn = document.createElement('button');
        btn.className = 'modal-tab-btn' + (i === 0 ? ' active' : '');
        btn.dataset.tab = i;
        btn.textContent = tab.label;
        btn.addEventListener('click', () => activateTab(i));
        tabBar.appendChild(btn);

        const panel = document.createElement('div');
        panel.id        = 'poolChartPanel' + i;
        panel.className = 'modal-tab-panel pool-chart-panel' + (i === 0 ? ' active' : '');
        panel.innerHTML =
            '<div class="pool-chart-canvas-wrap">' +
            '<canvas id="poolChartCanvas' + i + '"></canvas>' +
            '<div class="pool-chart-overlay" id="poolChartLoading' + i + '">Lade Daten...</div>' +
            '<div class="pool-chart-overlay" id="poolChartEmpty' + i + '" style="display:none">Keine Daten verfuegbar</div>' +
            '</div>' +
            '<div class="pool-chart-gecko-link-row">' +
            '<a class="pool-chart-gecko-link" id="poolChartLink' + i + '" href="#" target="_blank" rel="noopener" style="display:none">GeckoTerminal ↗</a>' +
            '</div>';
        panels.appendChild(panel);
    });
}

function activateTab(i) {
    _activeTab = i;
    document.querySelectorAll('#poolChartModalTabs .modal-tab-btn').forEach((b, j) =>
        b.classList.toggle('active', j === i));
    document.querySelectorAll('#poolChartModalPanels .pool-chart-panel').forEach((p, j) =>
        p.classList.toggle('active', j === i));
    loadAndRender(i, false);
}

// -- Lokale Daten aus price-history.json -------------------------------------

// Gibt lokale OHLCV-Daten zurueck oder null wenn nicht verfuegbar.
// Fuer 'pair': pool_stats.price = tokenB/tokenA (z.B. fuer SOL/ORE-Pool: ORE pro SOL = 0.638).
//   Wenn displayPair gedreht ist (dpAisTokenA=false, z.B. "ORE/SOL"), muss invertiert werden
//   damit die Richtung mit Orca uebereinstimmt (SOL pro ORE = 1/0.638 = 1.567, steigt).
// Fuer 'token': sucht den Pool, in dem dieses Token gegen USDC gehandelt wird.
function findLocalData(tab) {
    if (!_ph?.pools) return null;

    if (tab.type === 'pair') {
        const pairPoolData = _ph.pools[_pool.id];
        if (!pairPoolData?.data?.length) return null;
        const raw = applyLimit(pairPoolData.data);
        if (!raw?.length) return null;
        return tab.invertRatio ? raw.map(pt => ({ x: pt.x, y: 1 / pt.y })) : raw;
    }

    if (tab.type === 'token') {
        for (const poolData of Object.values(_ph.pools)) {
            const { tokenA, tokenB, data } = poolData;
            // tokenA=unserToken, tokenB=USDC: price = USDC/token = USD-Preis ✓
            if (tokenA === tab.mint && tokenB === USDC_MINT) return applyLimit(data);
            // tokenA=USDC, tokenB=unserToken: price = token/USDC (invertiert, aber trend-korrekt)
            if (tokenB === tab.mint && tokenA === USDC_MINT) return applyLimit(data);
        }
    }
    return null;
}

// Filtert auf den aktuellen Zeitbereich (1D/1W/1M) anhand echter Timestamps.
function applyLimit(data) {
    const cutoff = Date.now() - _limit * 3_600_000;
    const filtered = data.filter(([ts]) => ts >= cutoff);
    return filtered.length ? filtered.map(([ts, p]) => ({ x: ts, y: p })) : null;
}

// -- Daten laden & Chart rendern ---------------------------------------------

async function loadAndRender(tabIdx, forceRefetch) {
    const tab = _tabs[tabIdx];
    if (!tab) return;

    const cacheKey = tab.type + '_' + (tab.mint ?? tab.address) + '_' + _limit;
    const loading  = document.getElementById('poolChartLoading' + tabIdx);
    const empty    = document.getElementById('poolChartEmpty'   + tabIdx);
    const canvas   = document.getElementById('poolChartCanvas'  + tabIdx);
    if (!canvas) return;

    let ohlcv = forceRefetch ? null : _cache.get(cacheKey);

    if (!ohlcv) {
        if (loading) { loading.textContent = 'Lade Daten...'; loading.style.display = ''; }
        if (canvas)  canvas.style.display  = 'none';
        if (empty)   empty.style.display   = 'none';

        try {
            await Promise.all([loadChartJs(), loadPriceHistory()]);

            // 1. Lokale Daten versuchen
            ohlcv = findLocalData(tab);

            // 2. Fallback: GeckoTerminal
            if (!ohlcv) {
                ohlcv = tab.type === 'pair'
                    ? await fetchPairOhlcv(tab.address, _limit)
                    : await fetchTokenUsdOhlcv(tab.mint, _limit);
            }
        } catch (e) {
            console.error('[pool-chart-modal]', e);
            ohlcv = null;
        }

        if (ohlcv?.length) _cache.set(cacheKey, ohlcv);
    }

    if (loading) loading.style.display = 'none';

    if (!ohlcv?.length) {
        if (empty)  empty.style.display  = '';
        if (canvas) canvas.style.display = 'none';
        return;
    }

    if (empty)  empty.style.display  = 'none';
    if (canvas) canvas.style.display = '';

    renderChart(tabIdx, ohlcv, tab.label);
    updateGeckoLink(tabIdx, tab);
}

// -- Externer Chart-Link (GeckoTerminal) --------------------------------------

// Sucht den Pool, in dem `mint` gegen USDC gehandelt wird (fuer den externen
// Link UND als OHLCV-Fallback genutzt - ein Ergebnis, ein Cache).
async function findTokenUsdcPool(mint) {
    if (!mint || mint === USDC_MINT) return null;
    if (_tokenPoolCache.has(mint)) return _tokenPoolCache.get(mint);

    let result = null;
    try {
        const r = await fetch(
            GECKO_BASE + '/networks/solana/tokens/' + mint + '/pools?page=1',
            { headers: GECKO_HEADERS }
        );
        if (r.ok) {
            const { data: pools = [] } = await r.json();
            for (const pool of pools) {
                const addr    = pool.attributes?.address;
                const baseId  = pool.relationships?.base_token?.data?.id  ?? '';
                const quoteId = pool.relationships?.quote_token?.data?.id ?? '';
                if (!addr) continue;
                if (baseId.includes(mint) && quoteId.includes(USDC_MINT))  { result = { address: addr, tokenParam: 'base'  }; break; }
                if (quoteId.includes(mint) && baseId.includes(USDC_MINT))  { result = { address: addr, tokenParam: 'quote' }; break; }
            }
        }
    } catch { /* offline/CORS - Link bleibt einfach weg */ }

    _tokenPoolCache.set(mint, result);
    return result;
}

// Loest fuer einen Tab die GeckoTerminal-Pool-Adresse auf, wenn vorhanden.
async function resolveTabGeckoUrl(tab) {
    if (tab.type === 'pair') return tab.address ? geckoPoolUrl(tab.address) : null;
    const found = await findTokenUsdcPool(tab.mint);
    return found ? geckoPoolUrl(found.address) : null;
}

// Zeigt/versteckt den Link je Tab-Panel - laeuft parallel zum Chart-Rendering,
// blockiert es also nicht.
function updateGeckoLink(tabIdx, tab) {
    const linkEl = document.getElementById('poolChartLink' + tabIdx);
    if (!linkEl) return;
    resolveTabGeckoUrl(tab).then(url => {
        if (_activeTab !== tabIdx) return; // Tab inzwischen gewechselt
        if (url) { linkEl.href = url; linkEl.style.display = ''; }
        else       linkEl.style.display = 'none';
    });
}

// -- GeckoTerminal-Calls (Fallback) ------------------------------------------

async function fetchOhlcv(poolAddress, limit, token) {
    let url = GECKO_BASE + '/networks/solana/pools/' + poolAddress + '/ohlcv/hour?limit=' + limit;
    if (token) url += '&token=' + token;
    const r = await fetch(url, { headers: GECKO_HEADERS });
    if (!r.ok) return null;
    const json = await r.json();
    const list = json?.data?.attributes?.ohlcv_list ?? [];
    return list
        .map(([ts, , , , c]) => ({ x: ts * 1000, y: +c }))
        .sort((a, b) => a.x - b.x);
}

async function fetchPairOhlcv(poolAddress, limit) {
    return fetchOhlcv(poolAddress, limit, null);
}

async function fetchTokenUsdOhlcv(tokenMint, limit) {
    const found = await findTokenUsdcPool(tokenMint);
    return found ? fetchOhlcv(found.address, limit, found.tokenParam) : null;
}

// -- Chart.js-Rendering ------------------------------------------------------

function fmtPrice(v) {
    if (v == null || isNaN(v)) return '--';
    if (v >= 10000) return v.toLocaleString('de-DE', { maximumFractionDigits: 0 });
    if (v >= 1000)  return v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
    if (v >= 1)     return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    if (v >= 0.01)  return v.toLocaleString('de-DE', { minimumFractionDigits: 4, maximumFractionDigits: 5 });
    return v.toLocaleString('de-DE', { minimumFractionDigits: 6, maximumFractionDigits: 8 });
}

const HOUR = 3_600_000;

/**
 * Formatiert einen Timestamp für die X-Achse.
 * Basiert auf der echten Datenspanne – nicht auf _limit – damit junge Pools
 * (wenig Daten im 1W/1M-View) korrekte Labels bekommen.
 *
 * ≤ 1 Tag   → nur Uhrzeit  "14:00"
 * ≤ 4 Tage  → Datum + Zeit "18. Mai 06:00" (Mitternacht: nur "18. Mai")
 * > 4 Tage  → nur Datum    "18. Mai"
 */
function fmtTs(ms, spanMs) {
    const d = new Date(ms);
    if (spanMs <= 24 * HOUR)
        return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (spanMs <= 4 * 24 * HOUR) {
        const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const date = d.toLocaleDateString('de-DE', { month: 'short', day: 'numeric' });
        return time === '00:00' ? date : date + ' ' + time;
    }
    return d.toLocaleDateString('de-DE', { month: 'short', day: 'numeric' });
}

/**
 * Berechnet gleichmäßige Tick-Positionen an echten Zeitgrenzen (UTC-Stunden/-Tage).
 * Verhindert "krumme" Zeitstempel wie 23:46 oder 03:33.
 * Fallback auf [minMs, maxMs] wenn Span zu klein für runde Intervalle.
 */
function makeTicks(minMs, maxMs, target = 6) {
    const span = maxMs - minMs;
    if (span < HOUR) return [minMs, maxMs];   // Sehr kurzer Span: nur Start + Ende
    const candidates = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 120, 168].map(h => h * HOUR);
    let bestIv = candidates[0], bestDiff = Infinity;
    for (const iv of candidates) {
        const diff = Math.abs(Math.round(span / iv) - target);
        if (diff < bestDiff) { bestDiff = diff; bestIv = iv; }
    }
    const first = Math.ceil(minMs / bestIv) * bestIv;
    const ticks = [];
    for (let t = first; t <= maxMs; t += bestIv) ticks.push(t);
    return ticks.length ? ticks : [minMs, maxMs];  // Fallback
}

function renderChart(tabIdx, ohlcv, label) {
    const canvas = document.getElementById('poolChartCanvas' + tabIdx);
    if (!canvas || !window.Chart) return;

    _charts[tabIdx]?.destroy();

    const spanMs     = ohlcv[ohlcv.length - 1].x - ohlcv[0].x;
    const tickTarget = spanMs <= 24 * HOUR ? 6 : 7;
    const tickValues = makeTicks(ohlcv[0].x, ohlcv[ohlcv.length - 1].x, tickTarget);

    _charts[tabIdx] = new window.Chart(canvas, {
        type: 'line',
        data: {
            datasets: [{
                data: ohlcv,
                parsing: false,
                borderColor: '#4f9eff',
                backgroundColor: 'rgba(79,158,255,0.07)',
                fill: true,
                pointRadius: 0,
                borderWidth: 1.5,
                tension: 0.2,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    type: 'linear',
                    min: ohlcv[0].x,
                    max: ohlcv[ohlcv.length - 1].x,
                    title: {
                        display: true,
                        text: 'Zeit',
                        color: 'rgba(255,255,255,0.35)',
                        font: { size: 11 },
                    },
                    ticks: {
                        values: tickValues,
                        callback: v => fmtTs(v, spanMs),
                        color: 'rgba(255,255,255,0.4)',
                        font: { size: 11 },
                    },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                },
                y: {
                    title: {
                        display: true,
                        text: label,
                        color: 'rgba(255,255,255,0.35)',
                        font: { size: 11 },
                    },
                    ticks: {
                        maxTicksLimit: 6,
                        callback: v => fmtPrice(v),
                        color: 'rgba(255,255,255,0.4)',
                        font: { size: 11 },
                    },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(20,24,36,0.92)',
                    borderColor: 'rgba(255,255,255,0.12)',
                    borderWidth: 1,
                    callbacks: {
                        title: items => fmtTs(items[0].parsed.x, spanMs),
                        label: item  => label + ': ' + fmtPrice(item.parsed.y),
                    }
                }
            }
        }
    });
}
