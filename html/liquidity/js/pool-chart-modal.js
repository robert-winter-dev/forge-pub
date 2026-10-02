// pool-chart-modal.js v20260930a
// Kurs-Charts fuer Pools.
// Datenquelle 1 (bevorzugt): lokale price-history.json aus pool_stats-DB
// Datenquelle 2 (Fallback): GeckoTerminal API (CORS: access-control-allow-origin: *)
// Lazy-geladen beim ersten Klick - kein Nexus, kein Backend noetig.
// Pro Tab zusaetzlich ein Link auf den GeckoTerminal-Chart (extern, TradingView-artig),
// wenn GeckoTerminal fuer diese Kombination einen Pool kennt - sonst kein Link.
// Zeitraum-Wahl (1D/1W/1M, Sperre bei zu wenig Historie): html/js/chart-range.js
// (CORE#000933). Geladen wird je Tab einmal die volle Reihe, gefiltert wird lokal.
// Maximiert (LIQ#001115): Indikator-Leiste EMA 10/20/30 (im Preis-Chart) sowie RSI und MACD
// (eigene Panels darunter), berechnet im Browser (indicators.js) ueber die volle Reihe
// und erst danach auf den Zeitraum gefiltert.

import { createRangeBar, filterToRange, historyStartOf } from '../../js/chart-range.js?v=20260923a';
import { ema, rsi, macd, volatility, resample, rangeExitStats, MIN_POINTS } from './indicators.js?v=20260929e';

// Indikatoren rechnen auf 4h-Kerzen (Schlusskurs), die Preislinie bleibt stuendlich.
// Auf Stundenwerten sprang der RSI bei ruhigen Pools zwischen ueberkauft und ueberverkauft.
const IND_BUCKET_MS = 4 * 3_600_000;

const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const GECKO_BASE    = 'https://api.geckoterminal.com/api/v2';
const CJS_CDN       = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js';
const GECKO_HEADERS = { Accept: 'application/json;version=20230302' };
const geckoPoolUrl  = addr => 'https://www.geckoterminal.com/solana/pools/' + addr;

let _modal     = null;
let _cjsLoad   = null;
let _phLoad    = null;   // price-history.json laden (einmalig)
let _ph        = null;   // gecachte price-history
let _charts    = {};
let _cache     = new Map();   // `${type}_${mint|address}` -> volle Reihe [{x,y}]
let _tokenPoolCache = new Map(); // mint -> { address, tokenParam } | null (GeckoTerminal-USDC-Pool je Token)
let _pool      = null;
let _tabs      = [];
let _activeTab = 0;
let _bar       = null;   // Zeitraum-Leiste (chart-range.js)
let _syncingBar = false; // setHistoryStart() aus loadAndRender: kein zweites Rendern
let _maximized = false;  // Maximiert-Zustand (nicht gespeichert, Dialog startet immer normal)
let _ind       = { ema: false, range: false, rsi: false, macd: false, vol: false };   // Indikatorwahl (nicht gespeichert)
// Tooltip (schwarzer Kasten) an/aus, Auswahl bleibt im Browser (Vorgabe: an)
const LS_POOL_CHART_TIP = 'liquiditybot_pool_chart_tooltip';
let _showTip = true;
try { _showTip = localStorage.getItem(LS_POOL_CHART_TIP) !== '0'; } catch { /* blockiert */ }
let _indBar    = null;   // Indikator-Leiste (wird in die Fusszeile des aktiven Panels verschoben)
let _ctx       = {};     // tabIdx -> { series, ohlcv, label } fuer Neuzeichnen ohne Neuladen

// Bis v20260909 stand hier die Stundenzahl (24/168/720), seitdem der Key (1D/1W/1M).
// Ein alter Wert wird als Vorgabe übernommen und beim nächsten Klick überschrieben.
const LS_POOL_CHART_RANGE = 'liquiditybot_pool_chart_limit';
const LEGACY_HOURS_TO_KEY = { 24: '1D', 168: '1W', 720: '1M' };
function initialRange() {
    let stored = null;
    try { stored = localStorage.getItem(LS_POOL_CHART_RANGE); } catch { /* blockiert */ }
    return LEGACY_HOURS_TO_KEY[stored] ?? '1W';   // Default 1W
}

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
    <button class="modal-close pool-chart-max-btn" id="poolChartModalMax" type="button"
            aria-label="Maximieren" title="Maximieren">${ICON_MAX}</button>
    <button class="modal-close" id="poolChartModalClose" aria-label="Schliessen">&#x2715;</button>
  </div>
  <div class="modal-tabs" id="poolChartModalTabs"></div>
  <div id="poolChartModalPanels" class="pool-chart-panels"></div>
</div>`;
    document.body.appendChild(_modal);

    _bar = createRangeBar(document.getElementById('poolChartRangeBtns'), {
        active:     initialRange(),
        storageKey: LS_POOL_CHART_RANGE,
        onChange:   () => { if (!_syncingBar) loadAndRender(_activeTab); },
    });

    document.getElementById('poolChartModalClose')
        .addEventListener('click', closePoolChartModal);
    document.getElementById('poolChartModalMax')
        .addEventListener('click', () => setMaximized(!_maximized));
    buildIndBar();
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
    _ctx       = {};
    _pool      = pool;
    _activeTab = 0;
    _tabs      = buildTabs(pool);

    document.getElementById('poolChartModalTitle').textContent =
        pool.displayPair ?? pool.pair ?? '--';

    _ind = { ema: false, range: false, rsi: false, macd: false, vol: false };
    setMaximized(false, { render: false });
    // Range-Schalter nur, wenn der Export eine Empfehlung fuer diesen Pool liefert (nur Master).
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
    _ctx    = {};
}

// -- Maximieren & Indikator-Leiste (LIQ#001115) -------------------------------

const SVG_ATTR = 'width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_MAX     = `<svg ${SVG_ATTR}><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg>`;

const IND_DEFS = [
    { key: 'ema',  label: 'EMA 10/20/30', title: 'EMA 10/20/30',
      tip: 'Exponentielle gleitende Durchschnitte über 10, 20 und 30 Kerzen (4h-Kerzen) im Preis-Chart. Liegt der Kurs über den Linien und sind sie nach Länge geordnet (10 über 20 über 30), spricht das für einen Aufwärtstrend.' },
    { key: 'rsi',  label: 'RSI',  title: 'RSI (14)',
      tip: 'Relative-Stärke-Index über 14 Kerzen à 4 Stunden, Skala 0 bis 100. Über 70 gilt als überkauft, unter 30 als überverkauft. Die Werte weichen leicht von TradingView ab, weil hier die Kurse dieser Reihe genutzt werden.' },
    { key: 'macd', label: 'MACD', title: 'MACD (12, 26, 9)',
      tip: 'Auf 4h-Kerzen: Differenz zweier EMAs (12 und 26) mit Signallinie (9) und Histogramm. Kreuzt die MACD-Linie die Signallinie von unten nach oben, dreht das Momentum nach oben, umgekehrt nach unten.' },
    { key: 'vol',  label: 'Volatilität', title: 'Volatilität (20 Kerzen, 4h)',
      tip: 'Standardabweichung der prozentualen Renditen der letzten 20 Kerzen à 4 Stunden, in Prozent je Kerze. Die gestrichelte Linie ist der Median des gezeigten Zeitraums. Steigt der Wert darüber, wird der Markt unruhiger und eine enge Range wird öfter verlassen; darunter beruhigt er sich.' },
    { key: 'range', label: 'Range', title: 'Range-Empfehlung des Bots',
      tip: 'Blendet die Range ein, die der Range Advisor des Bots für diesen Pool empfiehlt (± % um den aktuellen Kurs, bezogen auf 1000 USDC Einsatz). In der Legende steht, wie oft der Kurs eine Range dieser Breite in den letzten Wochen innerhalb von 24 und 72 Stunden verlassen hätte, gerechnet ab jedem Stundenwert als Start. Hohe Werte heißen häufiges Rebalancing. Gilt nur für den Chart des Pools selbst (erster Tab).' },
];

function buildIndBar() {
    // Die Leiste haengt nicht im Modal-Grundggeruest, sondern in der Fusszeile des aktiven Panels
    // (auf Hoehe des GeckoTerminal-Links, siehe placeIndBar()).
    const bar = document.createElement('div');
    bar.className = 'pool-chart-ind-bar';
    bar.id = 'poolChartIndBar';
    bar.style.display = 'none';
    _indBar = bar;
    // Ganz links: Tooltip-Kasten im Chart ein/aus.
    const lab = document.createElement('label');
    lab.className = 'pool-chart-tip-toggle';
    lab.innerHTML = '<input type="checkbox" id="poolChartTipToggle"><span>Tooltip</span>';
    const cb = lab.querySelector('input');
    cb.checked = _showTip;
    cb.addEventListener('change', () => {
        _showTip = cb.checked;
        try { localStorage.setItem(LS_POOL_CHART_TIP, _showTip ? '1' : '0'); } catch { /* blockiert */ }
        updateIndBar();
        renderAll(_activeTab);
    });
    bar.appendChild(lab);
    bar.insertAdjacentHTML('beforeend', '<span class="pool-chart-ind-label">Indikatoren:</span>');
    IND_DEFS.forEach(def => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pool-chart-ind-btn has-tooltip';
        b.dataset.ind = def.key;
        b.dataset.tooltipTitle = def.title;
        b.dataset.tooltipContent = def.tip;
        b.dataset.tooltipType = 'text';
        b.addEventListener('click', () => {
            _ind[def.key] = !_ind[def.key];
            updateIndBar();
            renderAll(_activeTab);
        });
        bar.appendChild(b);
    });
    updateIndBar();
}

// Die Range gilt fuer den Kurs des Pools selbst: das ist immer der erste Tab (Paar-Chart bzw. bei
// USDC-Pools der einzige Token-Chart). Die USD-Tabs einzelner Tokens sind dafuer nicht aussagekraeftig.
function rangeApplies(tabIdx) {
    return tabIdx === 0 && _pool?.optimalRangePct > 0;
}

function updateRangeBtn() {
    const b = _indBar?.querySelector('[data-ind="range"]');
    if (b) b.style.display = rangeApplies(_activeTab) ? '' : 'none';
}

function placeIndBar() {
    const slot = document.getElementById('poolChartIndSlot' + _activeTab);
    if (slot && _indBar && _indBar.parentNode !== slot) slot.appendChild(_indBar);
}

// Aktiv/inaktiv nicht nur ueber Farbe: Haken bzw. leeres Kaestchen im Text plus aria-pressed.
function updateIndBar() {
    document.querySelectorAll('#poolChartIndBar .pool-chart-ind-btn').forEach(b => {
        const def = IND_DEFS.find(d => d.key === b.dataset.ind);
        const on  = _ind[def.key];
        b.textContent = (on ? '\u2611 ' : '\u2610 ') + def.label;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.classList.toggle('active', on);
        // LIQ#001156: Tooltip-Haken aus -> auch der lange Erklaer-Tooltip der Indikator-Schalter (forge.js) entfaellt
        b.classList.toggle('has-tooltip', _showTip);
    });
}

function setMaximized(on, { render = true } = {}) {
    _maximized = on;
    const box = _modal.querySelector('.pool-chart-modal-box');
    box.classList.toggle('maximized', on);
    _indBar.style.display = on ? '' : 'none';
    placeIndBar();
    const btn = document.getElementById('poolChartModalMax');
    btn.innerHTML = ICON_MAX;   // bewusst dasselbe Icon in beiden Zustaenden
    const t = on ? 'Wiederherstellen' : 'Maximieren';
    btn.setAttribute('aria-label', t);
    btn.title = t;
    updateIndBar();
    if (render && _ctx[_activeTab]) renderAll(_activeTab);
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
            '<div class="pool-chart-stack">' +
            '<div class="pool-chart-canvas-wrap">' +
            '<canvas id="poolChartCanvas' + i + '"></canvas>' +
            '<div class="pool-chart-overlay" id="poolChartLoading' + i + '">Lade Daten...</div>' +
            '<div class="pool-chart-overlay" id="poolChartEmpty' + i + '" style="display:none">Keine Daten verfuegbar</div>' +
            '</div>' +
            ['rsi', 'macd', 'vol'].map(k =>
                '<div class="pool-chart-canvas-wrap pool-chart-sub" id="poolChartSub_' + k + i + '" style="display:none">' +
                '<canvas id="poolChartCanvas_' + k + i + '"></canvas>' +
                '<div class="pool-chart-overlay" id="poolChartNote_' + k + i + '" style="display:none">Zu wenig Historie</div>' +
                '</div>').join('') +
            '</div>' +
            '<div class="pool-chart-gecko-link-row">' +
            '<span class="pool-chart-ind-slot" id="poolChartIndSlot' + i + '"></span>' +
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
    placeIndBar();
    updateRangeBtn();
    loadAndRender(i);
}

// -- Lokale Daten aus price-history.json -------------------------------------

// Gibt die volle lokale Reihe [{x,y}] zurueck oder null, wenn keine frische da ist.
// Frisch = juengster Punkt liegt im kleinsten Zeitraum (1D). Eine veraltete lokale
// Reihe (Pool nicht mehr erfasst) faellt auf GeckoTerminal zurueck.
// Fuer 'pair': pool_stats.price = tokenB/tokenA (z.B. fuer SOL/ORE-Pool: ORE pro SOL = 0.638).
//   Wenn displayPair gedreht ist (dpAisTokenA=false, z.B. "ORE/SOL"), muss invertiert werden
//   damit die Richtung mit Orca uebereinstimmt (SOL pro ORE = 1/0.638 = 1.567, steigt).
// Fuer 'token': sucht den Pool, in dem dieses Token gegen USDC gehandelt wird.
function findLocalSeries(tab) {
    if (!_ph?.pools) return null;

    if (tab.type === 'pair') {
        const raw = freshSeries(_ph.pools[_pool.id]?.data);
        if (!raw) return null;
        return tab.invertRatio ? raw.map(pt => ({ x: pt.x, y: 1 / pt.y })) : raw;
    }

    if (tab.type === 'token') {
        for (const poolData of Object.values(_ph.pools)) {
            const { tokenA, tokenB, data } = poolData;
            // tokenA=unserToken, tokenB=USDC: price = USDC/token = USD-Preis ✓
            // tokenA=USDC, tokenB=unserToken: price = token/USDC, also der KEHRWERT des USD-Preises
            //   (steigt, wenn das Token billiger wird) -> hier auf USD pro Token drehen.
            const match = (tokenA === tab.mint && tokenB === USDC_MINT)
                       || (tokenB === tab.mint && tokenA === USDC_MINT);
            const fresh = match ? freshSeries(data) : null;
            const raw = fresh && usdPerToken(fresh, tokenA);
            if (raw) return raw;
        }
    }
    return null;
}

// pool_stats.price ist tokenB/tokenA. Ist USDC tokenA, steht dort Token pro USDC (Kehrwert des
// USD-Preises, Richtung gespiegelt) -> auf USD pro Token drehen. Sonst unveraendert.
export function usdPerToken(series, tokenA) {
    return tokenA === USDC_MINT ? series.map(pt => ({ x: pt.x, y: 1 / pt.y })) : series;
}

// [[ts, price], ...] -> [{x,y}], sofern der juengste Punkt im kleinsten Zeitraum liegt.
function freshSeries(data) {
    if (!data?.length) return null;
    const smallest = _bar.ranges[0].key;
    if (!filterToRange([data[data.length - 1]], smallest).length) return null;
    return data.map(([ts, p]) => ({ x: ts, y: p }));
}

// -- Daten laden & Chart rendern ---------------------------------------------

// Volle Reihe eines Tabs (lokal bevorzugt, sonst GeckoTerminal), je Tab einmal geladen.
async function loadSeries(tab) {
    const cacheKey = tab.type + '_' + (tab.mint ?? tab.address);
    if (_cache.has(cacheKey)) return _cache.get(cacheKey);

    await Promise.all([loadChartJs(), loadPriceHistory()]);
    let series = findLocalSeries(tab);
    if (!series) {
        // Stundenkerzen fuer den groessten Zeitraum, damit der Historie-Beginn stimmt.
        const hours = Math.ceil(_bar.ranges[_bar.ranges.length - 1].ms / 3_600_000);
        series = tab.type === 'pair'
            ? await fetchPairOhlcv(tab.address, hours)
            : await fetchTokenUsdOhlcv(tab.mint, hours);
    }
    if (series?.length) _cache.set(cacheKey, series);
    return series;
}

async function loadAndRender(tabIdx) {
    const tab = _tabs[tabIdx];
    if (!tab) return;

    const loading  = document.getElementById('poolChartLoading' + tabIdx);
    const empty    = document.getElementById('poolChartEmpty'   + tabIdx);
    const canvas   = document.getElementById('poolChartCanvas'  + tabIdx);
    if (!canvas) return;

    const cached = _cache.has(tab.type + '_' + (tab.mint ?? tab.address));
    if (!cached) {
        if (loading) { loading.textContent = 'Lade Daten...'; loading.style.display = ''; }
        if (canvas)  canvas.style.display  = 'none';
        if (empty)   empty.style.display   = 'none';
    }

    let series = null;
    try {
        series = await loadSeries(tab);
    } catch (e) {
        console.error('[pool-chart-modal]', e);
    }
    if (_activeTab !== tabIdx) return; // Tab inzwischen gewechselt

    // Leiste auf die Historie DIESER Reihe einstellen (Sperre + ggf. Rueckfall).
    _syncingBar = true;
    try { _bar.setHistoryStart(historyStartOf(series)); } finally { _syncingBar = false; }

    const ohlcv = series?.length ? _bar.filter(series) : [];

    if (loading) loading.style.display = 'none';

    if (!ohlcv.length) {
        if (empty)  empty.style.display  = '';
        if (canvas) canvas.style.display = 'none';
        return;
    }

    if (empty)  empty.style.display  = 'none';
    if (canvas) canvas.style.display = '';

    _ctx[tabIdx] = { series, ohlcv, label: tab.label };
    renderAll(tabIdx);
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

// MACD-Werte sind Kursdifferenzen und oft winzig: 3 signifikante Stellen statt fester Nachkommastellen.
function fmtSmall(v) {
    if (v == null || isNaN(v)) return '--';
    return v.toLocaleString('de-DE', { maximumSignificantDigits: 3 });
}

/**
 * Formatiert einen Timestamp für die X-Achse.
 * Basiert auf der echten Datenspanne – nicht auf dem Zeitraum – damit junge Pools
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

// Fadenkreuz (LIQ#001115): senkrechte Linie in ALLEN Panels des aktiven Tabs an derselben
// X-Position (Preis beim RSI-Minimum ablesen), waagerechte nur im Panel unter der Maus.
// Die anderen Panels zeigen zusaetzlich den Tooltip-Wert am selben Zeitpunkt.
let _hover = null;   // { x: Datenwert der X-Achse, key: Chart-Schluessel unter der Maus, py: Pixel-Y }
const crosshairPlugin = {
    id: 'forgeCrosshair',
    afterEvent(chart, args) {
        const e = args.event;
        if (e.type === 'mouseout') { if (_hover) { _hover = null; redrawTab(); } return; }
        if (e.type !== 'mousemove') return;
        const a = chart.chartArea;
        if (e.x < a.left || e.x > a.right || e.y < a.top || e.y > a.bottom) {
            if (_hover) { _hover = null; redrawTab(); }
            return;
        }
        _hover = { x: chart.scales.x.getValueForPixel(e.x), key: chart.$forgeKey, py: e.y };
        redrawTab();
    },
    afterDatasetsDraw(chart) {
        if (!_hover) return;
        const a = chart.chartArea, x = chart.scales.x.getPixelForValue(_hover.x);
        if (x < a.left || x > a.right) return;
        const ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom);
        if (_hover.key === chart.$forgeKey) { ctx.moveTo(a.left, _hover.py); ctx.lineTo(a.right, _hover.py); }
        ctx.stroke();
        ctx.restore();
    },
};

// Zeichnet alle Charts des aktiven Tabs neu und stellt in den anderen Panels den Tooltip
// am Punkt mit dem X-Wert der Maus ein.
// Bei ausgeschaltetem Tooltip (LIQ#001156) bleibt auch dort alles aus; das Fadenkreuz bleibt.
function redrawTab() {
    for (const [key, ch] of Object.entries(_charts)) {
        if (!ch || ch.$forgeTab !== _activeTab) continue;
        if (_hover && ch.$forgeKey !== _hover.key && _showTip) {
            const el = [];
            ch.data.datasets.forEach((ds, di) => {
                const pts = ds.data ?? [];
                if (pts.length <= 2) return;   // Hilfslinien (RSI 30/70) nicht in den Tooltip
                let best = -1, bd = Infinity;
                for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i].x - _hover.x); if (d < bd) { bd = d; best = i; } }
                if (best >= 0) el.push({ datasetIndex: di, index: best });
            });
            ch.setActiveElements(el);
            ch.tooltip?.setActiveElements(el, { x: ch.scales.x.getPixelForValue(_hover.x), y: ch.chartArea.top + 8 });
        } else if (!_hover) {
            ch.setActiveElements([]);
            ch.tooltip?.setActiveElements([], { x: 0, y: 0 });
        }
        // Zustand fuers UI-Pruefskript (bin/pruefe-ui-pool-chart.mjs): 'v' senkrecht, 'vh' zusaetzlich waagerecht
        ch.canvas.dataset.crosshair = !_hover ? '' : (ch.$forgeKey === _hover.key ? 'vh' : 'v');
        ch.draw();
    }
}

function tagChart(chart, tabIdx, key) { chart.$forgeTab = tabIdx; chart.$forgeKey = key; return chart; }

// Einschwingphase (LIQ#001115): Indikatoren brauchen einige Kerzen Vorlauf (RSI 15, EMA 30,
// MACD 34). Liegt der Anfang der Linien rechts vom Chart-Anfang, wird der Bereich davor getoent
// und beschriftet, damit die Luecke nicht wie fehlende Daten wirkt.
const warmupPlugin = {
    id: 'forgeWarmup',
    beforeDatasetsDraw(chart) {
        const to = chart.options.plugins?.forgeWarmup?.to;
        if (to == null) return;
        const a = chart.chartArea, x = Math.min(chart.scales.x.getPixelForValue(to), a.right);
        if (x - a.left < 8) return;
        const ctx = chart.ctx;
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        ctx.fillRect(a.left, a.top, x - a.left, a.bottom - a.top);
        ctx.fillStyle = 'rgba(255,255,255,0.38)';
        ctx.font = '10px sans-serif';
        ctx.textBaseline = 'top';
        if (x - a.left > 90) ctx.fillText('Einschwingphase', a.left + 6, a.top + 4);
        ctx.restore();
    },
};

// Ende der Einschwingphase = spaetester Startpunkt der Indikator-Linien (Linien mit > 2 Punkten).
function warmupEnd(datasets, fromX) {
    let to = null;
    for (const ds of datasets) {
        if (!ds.data || ds.data.length <= 2) continue;
        const x = ds.data[0].x;
        if (x > fromX && (to == null || x > to)) to = x;
    }
    return to;
}

// Feste Breite der Y-Achse, damit die Plot-Flaechen von Preis-, RSI- und MACD-Chart
// untereinander buendig liegen (gleiche X-Positionen).
const Y_AXIS_WIDTH = 64;
const AXIS_COLOR   = 'rgba(255,255,255,0.4)';
const TITLE_COLOR  = 'rgba(255,255,255,0.35)';
const GRID_COLOR   = 'rgba(255,255,255,0.05)';

const EMA_STYLES = [
    { period: 10, color: '#ffd166', dash: [] },        // durchgezogen
    { period: 20, color: '#ef476f', dash: [6, 3] },    // gestrichelt
    { period: 30, color: '#06d6a0', dash: [2, 3] },    // gepunktet
];

// Indikator-Reihe ueber die VOLLE Reihe rechnen, danach auf die sichtbare Spanne kuerzen
// (Einschwingphase liegt links ausserhalb; sonst waeren RSI/MACD in 1D leer bzw. verzerrt).
function indicatorPoints(series, values, fromX) {
    const pts = [];
    for (let i = 0; i < series.length; i++) {
        if (values[i] != null && series[i].x >= fromX) pts.push({ x: series[i].x, y: values[i] });
    }
    return pts;
}

function commonScales(ohlcv, spanMs, yTitle, yExtra = {}) {
    const tickValues = makeTicks(ohlcv[0].x, ohlcv[ohlcv.length - 1].x, spanMs <= 24 * HOUR ? 6 : 7);
    return {
        x: {
            type: 'linear',
            offset: false,   // Balken (MACD-Histogramm) duerfen die X-Achse nicht verschieben
            min: ohlcv[0].x,
            max: ohlcv[ohlcv.length - 1].x,
            title: { display: true, text: 'Zeit', color: TITLE_COLOR, font: { size: 11 } },
            // Gleiche X-Ticks in allen Panels (Chart.js kennt kein ticks.values, daher afterBuildTicks).
            afterBuildTicks: sc => { sc.ticks = tickValues.map(value => ({ value })); },
            ticks: { values: tickValues, callback: v => fmtTs(v, spanMs), color: AXIS_COLOR, font: { size: 11 } },
            grid: { color: GRID_COLOR },
        },
        y: {
            title: { display: true, text: yTitle, color: TITLE_COLOR, font: { size: 11 } },
            ticks: { maxTicksLimit: 6, color: AXIS_COLOR, font: { size: 11 }, ...(yExtra.ticks ?? {}) },
            grid: yExtra.grid ?? { color: GRID_COLOR },
            afterFit: sc => { sc.width = Y_AXIS_WIDTH; },
            ...(yExtra.scale ?? {}),
        },
    };
}

/** Zeichnet Preis-Chart und (nur maximiert) die gewaehlten Indikatoren neu. */
function renderAll(tabIdx) {
    _hover = null;
    const c = _ctx[tabIdx];
    if (!c || !window.Chart) return;
    const { series, ohlcv, label } = c;
    const on = _maximized;

    const base = on ? resample(series, IND_BUCKET_MS) : [];   // 4h-Kerzen der vollen Reihe
    const extra = [];
    if (on && _ind.ema && base.length >= MIN_POINTS.ema) {
        const ys = base.map(p => p.y);
        EMA_STYLES.forEach(st => {
            extra.push({
                label: 'EMA ' + st.period + ' (4h)',
                data: indicatorPoints(base, ema(ys, st.period), ohlcv[0].x),
                parsing: false, borderColor: st.color, borderDash: st.dash,
                backgroundColor: 'transparent', fill: false,
                pointRadius: 0, borderWidth: 1.4, tension: 0,
            });
        });
    }
    const rp = _pool?.optimalRangePct;
    if (on && _ind.range && rangeApplies(tabIdx) && series?.length) {
        const last = series[series.length - 1].y, w = rp / 100;
        const x0 = ohlcv[0].x, x1 = ohlcv[ohlcv.length - 1].x;
        const st = rangeExitStats(series, rp);
        const pct = (a, b) => b ? Math.round(100 * a / b) + ' %' : 'k. A.';
        const fmtPct = v => v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
        extra.push(
            { label: 'Range ±' + fmtPct(rp) + ' % (Bot) · in 24 h verlassen: ' + pct(st.exit24, st.n24) + ' · in 72 h: ' + pct(st.exit72, st.n72),
              data: [{ x: x0, y: last * (1 + w) }, { x: x1, y: last * (1 + w) }], parsing: false,
              borderColor: 'rgba(6,214,160,0.9)', borderDash: [8, 4], backgroundColor: 'transparent', fill: false,
              pointRadius: 0, borderWidth: 1.3, tension: 0 },
            { label: 'Range unten', hideLegend: true,
              data: [{ x: x0, y: last * (1 - w) }, { x: x1, y: last * (1 - w) }], parsing: false,
              borderColor: 'rgba(6,214,160,0.9)', borderDash: [8, 4], backgroundColor: 'rgba(6,214,160,0.07)', fill: '-1',
              pointRadius: 0, borderWidth: 1.3, tension: 0 },
        );
    }
    renderChart(tabIdx, ohlcv, label, extra);
    renderSubCharts(tabIdx, base, ohlcv, on);
}

function renderSubCharts(tabIdx, series, ohlcv, on) {   // series = 4h-Kerzen
    const spanMs = ohlcv[ohlcv.length - 1].x - ohlcv[0].x;
    const ys = series.map(p => p.y);

    const nSubs = ['rsi', 'macd', 'vol'].filter(k => on && _ind[k]).length;
    const stack = document.querySelector('#poolChartPanel' + tabIdx + ' .pool-chart-stack');
    if (stack) stack.dataset.subs = String(nSubs);

    for (const key of ['rsi', 'macd', 'vol']) {
        const wrap   = document.getElementById('poolChartSub_' + key + tabIdx);
        const canvas = document.getElementById('poolChartCanvas_' + key + tabIdx);
        const note   = document.getElementById('poolChartNote_' + key + tabIdx);
        const chartKey = key + tabIdx;
        _charts[chartKey]?.destroy();
        delete _charts[chartKey];
        if (!wrap || !canvas) continue;

        const show = on && _ind[key];
        wrap.style.display = show ? '' : 'none';
        if (!show) continue;

        const fromX = ohlcv[0].x;
        let datasets, yTitle, yExtra = {}, tooltipLabel;
        if (key === 'rsi') {
            const pts = indicatorPoints(series, rsi(ys, 14), fromX);
            const ref = v => ohlcv.map((p, i) => (i === 0 || i === ohlcv.length - 1) ? { x: p.x, y: v } : null).filter(Boolean);
            datasets = [
                { label: 'RSI 14 (4h)', data: pts, parsing: false, borderColor: '#c77dff', backgroundColor: 'transparent',
                  pointRadius: 0, borderWidth: 1.5, tension: 0 },
                { label: 'Überkauft (70)', data: ref(70), parsing: false, borderColor: 'rgba(255,255,255,0.35)',
                  borderDash: [4, 4], pointRadius: 0, borderWidth: 1 },
                { label: 'Überverkauft (30)', data: ref(30), parsing: false, borderColor: 'rgba(255,255,255,0.35)',
                  borderDash: [4, 4], pointRadius: 0, borderWidth: 1 },
            ];
            yTitle = 'RSI 14 · 4h';
            yExtra = { scale: { min: 0, max: 100 }, ticks: { stepSize: 10, maxTicksLimit: 11, autoSkip: false, callback: v => (v === 0 || v === 30 || v === 50 || v === 70 || v === 100) ? v : '' } };
            tooltipLabel = item => item.datasetIndex === 0 ? 'RSI (4h): ' + item.parsed.y.toFixed(1) : null;
            note.style.display = pts.length ? 'none' : '';
        } else if (key === 'macd') {
            const m = macd(ys, 12, 26, 9);
            const line = indicatorPoints(series, m.macd, fromX);
            const sig  = indicatorPoints(series, m.signal, fromX);
            const hist = indicatorPoints(series, m.hist, fromX);
            datasets = [
                { type: 'bar', label: 'Histogramm', data: hist, parsing: false,
                  backgroundColor: hist.map(p => p.y >= 0 ? 'rgba(6,214,160,0.55)' : 'rgba(239,71,111,0.55)'),
                  borderWidth: 0, barPercentage: 1, categoryPercentage: 1, order: 3 },
                { label: 'MACD', data: line, parsing: false, borderColor: '#4f9eff', backgroundColor: 'transparent',
                  pointRadius: 0, borderWidth: 1.5, tension: 0, order: 1 },
                { label: 'Signal', data: sig, parsing: false, borderColor: '#ffd166', borderDash: [6, 3],
                  backgroundColor: 'transparent', pointRadius: 0, borderWidth: 1.3, tension: 0, order: 2 },
            ];
            yTitle = 'MACD · 4h';
            yExtra = {
                ticks: { callback: v => v === 0 ? '0' : fmtSmall(v) },
                // Nulllinie hervorgehoben und mit "0" beschriftet.
                grid: { color: ctx => ctx.tick.value === 0 ? 'rgba(255,255,255,0.45)' : GRID_COLOR,
                        lineWidth: ctx => ctx.tick.value === 0 ? 1.5 : 1 },
            };
            tooltipLabel = item => item.dataset.label + ': ' + fmtSmall(item.parsed.y);
            note.style.display = line.length ? 'none' : '';
        } else {
            const pts = indicatorPoints(series, volatility(ys, 20), fromX);
            const sorted = pts.map(p => p.y).sort((a, b) => a - b);
            const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
            const ref = v => ohlcv.map((p, i) => (i === 0 || i === ohlcv.length - 1) ? { x: p.x, y: v } : null).filter(Boolean);
            datasets = [
                { label: 'Volatilität', data: pts, parsing: false, borderColor: '#ff9f43', backgroundColor: 'rgba(255,159,67,0.12)',
                  fill: true, pointRadius: 0, borderWidth: 1.5, tension: 0 },
                { label: 'Median', data: ref(med), parsing: false, borderColor: 'rgba(255,255,255,0.35)',
                  borderDash: [4, 4], pointRadius: 0, borderWidth: 1 },
            ];
            yTitle = 'Vol. % je 4h';
            yExtra = { scale: { beginAtZero: true }, ticks: { callback: v => v.toLocaleString('de-DE', { maximumFractionDigits: 2 }) } };
            tooltipLabel = item => item.datasetIndex === 0 ? 'Volatilität: ' + item.parsed.y.toFixed(2).replace('.', ',') + ' % (Median ' + med.toFixed(2).replace('.', ',') + ' %)' : null;
            note.style.display = pts.length ? 'none' : '';
        }

        canvas.style.display = (datasets[0].data.length) ? '' : 'none';
        if (!datasets[0].data.length) continue;

        _charts[chartKey] = tagChart(new window.Chart(canvas, {
            type: 'line',
            plugins: [crosshairPlugin, warmupPlugin],
            data: { datasets },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                interaction: { mode: 'index', intersect: false },
                scales: commonScales(ohlcv, spanMs, yTitle, yExtra),
                plugins: {
                    forgeWarmup: { to: warmupEnd(datasets, fromX) },
                    legend: { display: false },
                    tooltip: {
                        enabled: _showTip,
                        backgroundColor: 'rgba(20,24,36,0.92)', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1,
                        callbacks: {
                            title: items => fmtTs(items[0].parsed.x, spanMs),
                            label: tooltipLabel,
                        },
                    },
                },
            },
        }), tabIdx, chartKey);
    }
}

function renderChart(tabIdx, ohlcv, label, extraDatasets = []) {
    const canvas = document.getElementById('poolChartCanvas' + tabIdx);
    if (!canvas || !window.Chart) return;

    _charts[tabIdx]?.destroy();

    const spanMs     = ohlcv[ohlcv.length - 1].x - ohlcv[0].x;
    const tickTarget = spanMs <= 24 * HOUR ? 6 : 7;
    const tickValues = makeTicks(ohlcv[0].x, ohlcv[ohlcv.length - 1].x, tickTarget);

    _charts[tabIdx] = tagChart(new window.Chart(canvas, {
        type: 'line',
        plugins: [crosshairPlugin, warmupPlugin],
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
                label,
            }, ...extraDatasets]
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
                    afterBuildTicks: sc => { sc.ticks = tickValues.map(value => ({ value })); },
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
                    afterFit: sc => { sc.width = Y_AXIS_WIDTH; },
                }
            },
            plugins: {
                forgeWarmup: { to: warmupEnd(extraDatasets, ohlcv[0].x) },
                legend: {
                    display: extraDatasets.length > 0,
                    labels: {
                        color: AXIS_COLOR, boxWidth: 28, font: { size: 11 },
                        filter: (item, data) => item.datasetIndex > 0 && !data.datasets[item.datasetIndex].hideLegend,
                    },
                },
                tooltip: {
                    enabled: _showTip,
                    backgroundColor: 'rgba(20,24,36,0.92)',
                    borderColor: 'rgba(255,255,255,0.12)',
                    borderWidth: 1,
                    callbacks: {
                        title: items => fmtTs(items[0].parsed.x, spanMs),
                        label: item  => (item.datasetIndex === 0 ? label : item.dataset.label) + ': ' + fmtPrice(item.parsed.y),
                    }
                }
            }
        }
    }), tabIdx, String(tabIdx));
}
