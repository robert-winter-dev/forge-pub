/**
 * FORGE LendingBot – Dashboard App
 *
 * Erwartet data/data.json im Format:
 * {
 *   meta: { version, botId, exportedAt, botState },
 *   portfolio: { currentValue, totalYield, avgApy, walletUsdc, walletSol },
 *   positions: [{ id, protocol, protocolLabel, asset, amount, netInvested, currentApy, startedAt, accruedYield }],
 *   apyHistory: [{ ts, kamino?, lulo?, marinade? }],
 *   tvlHistory: [{ ts, kamino?, lulo?, marinade? }],  // TVL in USDC pro Protokoll
 *   liqHistory: [{ ts, kamino?, lulo?, marinade? }],  // sofort abhebbare Liquidität in USDC
 *   portfolioHistory: [{ ts, v }],
 *   balanceHistory:   [{ ts, v }],  // wie Gesamt-Karte: Positionen + ganzes Wallet (Chart links)
 *   transactions: [{ id, type, protocol, asset, amount, txHash, createdAt }],
 *   config: { apyThreshold, autoCompounding, autoRebalance },
 *   notifications: [{ id, level, message, ts }]
 * }
 */

import { DataManager }    from './data.js?v=20260421f';
import { ToastManager }   from '../../js/toast.js?v=20260809a';
import { EarningsToast }  from '../../js/earnings-toast.js?v=20260720a';
import { initMessageBell } from '../../js/message-bell.js?v=20260825a';
import { initWalletDetailModal } from '../../js/wallet-detail-modal.js?v=20260807a';
import { initNav, initFooter, setLastUpdate } from '../../js/nav.js?v=20260826a';
import { wireMaximize, fitHeight }             from '../../js/modal.js?v=20261002b';
// Sprache. Bewusst als `tr` importiert und nicht als `t`: `t` ist in dieser Datei
// durchgängig ein Timestamp (15 Fundstellen) – ein gleichnamiger Import wäre eine
// Verwechslungsfalle. bin/i18n-check.js kennt beide Namen.
import { t as tr, NUM_LOCALE } from '../../js/i18n.js?v=20260811a';
import { filterOutliers, attachHoverOverlay, attachBarTooltip } from '../../js/chart.js?v=20260925a';
import {
    TZ, todayISO, startOfDayMs, zonedWallClockToMs,
    partsInTZ, hourBucketKey, makeFmt, fmtDateDE
} from '../../js/tz.js?v=20260414a';
import { renderBotInactivePanel } from '../../js/bot-inactive-panel.js?v=20260807a';
// Zeitraum-Filter (1D/1W/1M, Sperre bei zu wenig Historie): zentrale Lib, siehe KB Core/chart-range-lib (CORE#000933, LEN#000935)
import { DEFAULT_RANGES, createRangeBar, filterToRange, historyStartOf, normalizeRangeKey, rangeCutoff, resolveRange } from '../../js/chart-range.js?v=20260923a';

const toastManager   = new ToastManager({
    storageKey: 'lendingbot_lastToastTs',
    muteKey:    'lendingbot_toastsMuted',
});
const earningsToast  = new EarningsToast();
earningsToast.startPolling('../liquidity/data/data.json', null);

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

// Unter dieser SOL-Reserve eröffnet der Bot keine neuen Positionen mehr
// (siehe SOL_TOPUP_TRIGGER in bots/lending/bin/bot.js) – Schwelle fürs Warn-Icon neben Wallet.
const SOL_RESERVE_MIN = 0.1;

/** Zahlen-Formatierung mit Fallback */
function fmt(n, decimals = 2, fallback = '—') {
    if (n == null || isNaN(n)) return fallback;
    return Number(n).toLocaleString(NUM_LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Kompaktes Datum + Uhrzeit aus Unix-Timestamp (ms) – in FORGE_TZ */
function fmtDateTime(ts) {
    if (!ts) return '—';
    const p   = partsInTZ(ts);
    const day = String(p.day).padStart(2, '0');
    const mon = String(p.month).padStart(2, '0');
    const h   = String(p.hour).padStart(2, '0');
    const min = String(p.minute).padStart(2, '0');
    return `${day}.${mon}.${p.year} ${h}:${min} Uhr`;
}

/** TVL formatieren: null → '—', ≥1M → '$22.7M', ≥1K → '$630K', sonst '$123' */
function fmtTvl(n) {
    if (n == null || isNaN(n) || n <= 0) return '—';
    if (n >= 1_000_000) return '$\u202f' + fmt(n / 1_000_000, 1) + '\u202fM';
    if (n >= 1_000)     return '$\u202f' + fmt(n / 1_000, 0) + '\u202fK';
    return '$\u202f' + fmt(n, 0);
}

// ─── Sofort verfügbare Liquidität ────────────────────────────────────────────
//
// TVL != verfügbare Liquidität: der TVL eines Lending-Pools ist die Summe aus
// verliehenem, extern geparktem und idle liegendem Kapital. Nur der idle-Anteil kann
// eine Abhebung sofort bedienen. Bei Loopscale "USDC Frontier" lag der TVL Mitte
// August 2026 bei ~1 Mio. USDC, während 0,00 USDC abhebbar waren — ein hoher TVL ist
// also kein Sicherheitsmerkmal.
//
// Bis 18.08.2026 bewertete das Dashboard die Liquidität über eigene Heuristik-Stufen
// (crit/warn, absolute Beträge + Anteil am TVL). Die sind ersatzlos entfallen: die
// maßgebliche Grenze ist jetzt die im Settings-UI eingestellte Liquiditäts-Schutz-
// Schwelle — genau der Wert, ab dem der Bot tatsächlich handelt (Abzug + kein
// Investment über „Bester Pool“). Zwei konkurrierende Grenzen im selben Feld waren
// nicht erklärbar.

/**
 * Liquidität formatieren: null → 'no data', ≥1M → '1,0 M USDC', ≥1K → '630 K USDC',
 * sonst auf 2 Nachkommastellen — bei kleinen Beständen ist genau das der springende
 * Punkt (0,00 vs. 0,05 USDC).
 */
function fmtLiquidity(n) {
    if (n == null || isNaN(n)) return tr('len.no_data', 'no data');
    if (n >= 1_000_000) return fmt(n / 1_000_000, 1) + '\u202fM\u202fUSDC';
    if (n >= 1_000)     return fmt(n / 1_000, 0) + '\u202fK\u202fUSDC';
    return fmt(n, 2) + '\u202fUSDC';
}

/** Nur Datum – in FORGE_TZ */
function fmtDate(ts) {
    if (!ts) return '—';
    const p = partsInTZ(ts);
    return `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}.${p.year}`;
}

/** Relative Zeit z.B. "vor 5 Min" */
function fmtRelTime(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)  return 'gerade eben';
    if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min`;
    if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std`;
    return `vor ${Math.floor(diff / 86400)} Tagen`;
}

/** Nur Uhrzeit HH:MM aus Unix-Timestamp (ms) – in FORGE_TZ */
function fmtTime(ts) {
    if (!ts) return '—';
    const p = partsInTZ(ts);
    return String(p.hour).padStart(2, '0') + ':' + String(p.minute).padStart(2, '0');
}

// Pool-Stammdaten (Name, Farbe, Hinweis, Zustand, Sichtbarkeit) kommen aus dem
// Pool-Register des Bots und reisen in data.json mit (`data.pools`, geschrieben von
// bots/lending/bin/export.js). Das Dashboard führt keine eigene Pool-Liste: ein neuer
// Pool braucht nur einen Eintrag in config/lending-pools.json.
let POOL_META = {};

function setPoolMeta(data) {
    if (data?.pools && typeof data.pools === 'object') POOL_META = data.pools;
}

// Namen aus alten Transaktionen, zu denen es keinen Pool im Register gibt.
const LEGACY_LABELS = {
    lulo: 'Lulo', marinade: 'Marinade', loopscale: 'Loopscale', save: 'Save', marginfi: 'MarginFi',
};

/** Protocol-Label aus protocol-Schlüssel */
function protocolLabel(key) {
    return POOL_META[key]?.label ?? LEGACY_LABELS[key] ?? key;
}

/** Protocol-Farbe (Hex) */
function protocolColor(key) {
    return POOL_META[key]?.color ?? '#94a3b8';
}

/** Pools für die Tabelle "Pool Metriken" und die inaktiven Karten (laut Register sichtbar). */
function knownPools() {
    return Object.entries(POOL_META)
        .filter(([, p]) => p.inMetrics)
        .map(([id, p]) => ({ id, label: p.label }));
}

/** Hinweis-Icon ⓘ eines Pools (Texte als i18n-Schlüssel im Register). */
function poolNoteIcon(id) {
    const note = POOL_META[id]?.note;
    if (!note) return '';
    return ` <span class="pc-info has-tooltip" data-tooltip-title="${escHtml(tr(note.titel, 'Hinweis'))}" data-tooltip-content="${escHtml(tr(note.text, ''))}">ⓘ</span>`;
}

// ─── Status-Header ────────────────────────────────────────────────────────────

function renderStatus(data) {
    const stateIcon   = document.getElementById('botStateIcon');
    const titleEl     = document.getElementById('headerTitle');

    if (!data) {
        stateIcon.textContent = '⚫';
        stateIcon.className   = 'bot-state-icon';
        setLastUpdate(null);
        titleEl.className      = '';
        return;
    }

    const state     = data.meta?.botState ?? 'unknown';
    const exported  = data.meta?.exportedAt ?? 0;

    // Bewusst gestoppter Bot (bin/svc stop bzw. Settings-Toggle): bot.js schreibt
    // 'offline' beim Graceful-Shutdown als letzten Export-Wert, bevor der Prozess
    // endet. exportedAt altert danach zwangsläufig — das ist dann aber kein Alarm,
    // sondern erwartetes Verhalten. Statt des roten Blink-Dreiecks zeigen wir
    // explizit "Bot deaktiviert", nichts blinkt mehr.
    if (state === 'offline') {
        stateIcon.textContent = '⏸';
        stateIcon.className   = 'bot-state-icon state-paused';
        const lastUpdateEl = document.getElementById('lastUpdate');
        if (lastUpdateEl) {
            lastUpdateEl.textContent = tr('liq.bot_disabled', 'Bot deaktiviert');
            lastUpdateEl.className   = 'last-update';
        }
        titleEl.className = '';
        const ver = document.getElementById('footerVersion');
        if (ver && data.meta?.version) ver.textContent = 'v' + data.meta.version;
        return;
    }

    const ageSec    = (Date.now() - exported) / 1000;

    // Signal-Alter bestimmt Status-Farbe (600s/1800s – toleriert 5-Min-Export-Zyklus)
    let cssClass = 'offline';
    if (ageSec < 600)       cssClass = 'online';
    else if (ageSec < 1800) cssClass = 'warning';

    // Bot-State Icon
    const iconMap = { running: '▶', paused: '⏸', waiting: '⏳' };
    const stateClass = { running: 'state-running', paused: 'state-paused', waiting: 'state-waiting' };
    stateIcon.textContent = iconMap[state] ?? '⚠';
    stateIcon.className   = 'bot-state-icon ' + (stateClass[state] ?? 'state-stale');

    if (ageSec > 1800) {
        stateIcon.className = 'bot-state-icon state-stale';
        cssClass = 'offline';
    }

    setLastUpdate(exported || null);

    // Header-Titel blinkt/pulsiert bewusst NICHT mehr bei alten Daten (2026-08-07,
    // Fund: ein absichtlich deaktivierter Bot lässt die Daten zwangsläufig altern —
    // das sah wie ein Alarm aus, obwohl alles wie gewünscht lief). Der kleine
    // Status-Icon (stateIcon, oben) bleibt als dezenter Hinweis bestehen.
    titleEl.className = '';

    // Footer-Version
    const ver = document.getElementById('footerVersion');
    if (ver && data.meta?.version) ver.textContent = 'v' + data.meta.version;
}

// ─── Metriken (Row 1) ─────────────────────────────────────────────────────────

function renderMetrics(data) {
    const p      = data?.portfolio;
    const wmSnap = data?.walletMonitor?.snapshot ?? null;

    // Wallet: Wallet-Monitor bevorzugen, Fallback auf portfolio.walletUsdc
    const freeWallet = wmSnap ? wmSnap.total_usd : (p?.walletUsdc ?? 0);
    const el_wallet  = document.getElementById('walletValue');
    if (el_wallet) el_wallet.textContent = fmt(freeWallet);

    // Warn-Icon: SOL-Reserve unterschritten (unter diesem Wert eröffnet der Bot
    // keine neuen Positionen mehr, siehe SOL_TOPUP_TRIGGER in bots/lending/bin/bot.js).
    const solWarnEl = document.getElementById('walletSolWarnIcon');
    if (solWarnEl) {
        const solBal = wmSnap?.sol_balance ?? null;
        if (solBal != null && solBal < SOL_RESERVE_MIN) {
            solWarnEl.setAttribute('data-tooltip-content',
                `SOL-Reserve beträgt aktuell ${fmt(solBal, 4)} SOL. Unter ${fmt(SOL_RESERVE_MIN, 1)} SOL werden keine neuen Positionen mehr eröffnet. Bitte Wallet mit mindestens 0,15 SOL aufladen oder warten, bis sich der SOL Bestand wieder erholt.`);
            solWarnEl.style.display = '';
        } else {
            solWarnEl.style.display = 'none';
        }
    }

    // Gesamt: Positionen + Wallet
    const gebunden = p?.currentValue ?? 0;
    const gesamt   = gebunden + freeWallet;
    const el_ges   = document.getElementById('gesamtValue');
    if (el_ges) el_ges.textContent = fmt(gesamt);

    // APR-Card: wird von renderStatistics gesetzt (Heute netto)
}

// ─── Gebunden-Detail-Modal ────────────────────────────────────────────────────

function initGebundenModal(getData) {
    const modal    = document.getElementById('gebundenModal');
    const closeBtn = document.getElementById('gebundenModalClose');
    const valueEl  = document.getElementById('gebundenValue');
    if (!modal || !valueEl) return;

    valueEl.addEventListener('click', () => openGebundenModal(getData()));
    closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none';
    });
}

function openGebundenModal(data) {
    const modal  = document.getElementById('gebundenModal');
    const bodyEl = document.getElementById('gebundenModalBody');
    if (!modal || !bodyEl) return;

    const positions = data?.positions ?? [];

    if (positions.length === 0) {
        bodyEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:1rem 0">Keine aktiven Positionen</p>';
        modal.style.display = 'flex';
        return;
    }

    const rows = positions.map(pos => {
        const label    = pos.protocolLabel ?? protocolLabel(pos.protocol ?? '');
        const amount   = pos.amount ?? 0;
        const yield_   = pos.accruedYield ?? 0;
        const apyStr   = pos.currentApy != null ? fmt(pos.currentApy, 2) + '\u202f% APY' : '—';
        return `<tr>
            <td>${escHtml(label)}</td>
            <td>${fmt(amount)}&nbsp;USDC</td>
            <td>${fmt(yield_, 4)}&nbsp;USDC</td>
            <td>${apyStr}</td>
        </tr>`;
    }).join('');

    const totalAmount = positions.reduce((s, p) => s + (p.amount ?? 0), 0);
    // LB#0158 – single source: Gesamt-Yield aus export.js (portfolio.totalYield),
    // nicht erneut im Dashboard summieren. Identisch zu Σ der angezeigten Pool-Zeilen.
    const totalYield  = data?.portfolio?.totalYield ?? positions.reduce((s, p) => s + (p.accruedYield ?? 0), 0);

    bodyEl.innerHTML = `
        <table class="wallet-detail-table">
            <thead><tr><th>${tr('liq.pool', 'Pool')}</th><th>${tr('len.capital', 'Kapital')}</th><th>${tr('len.yield', 'Yield')}</th><th>${tr('len.apy', 'APY')}</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot>
                <tr class="wallet-detail-total">
                    <td>${tr('overview.total', 'Gesamt')}</td>
                    <td>${fmt(totalAmount)}&nbsp;USDC</td>
                    <td>${fmt(totalYield, 4)}&nbsp;USDC</td>
                    <td></td>
                </tr>
            </tfoot>
        </table>`;

    modal.style.display = 'flex';
}

// ─── Portfolio-Chart-Modal (Klick auf den Gesamtguthaben-Chart) ─────────────────────────────────

const LS_PORTFOLIO_RANGE    = 'lendingbot_chart_portfolio';
const LS_PORTFOLIO_OUTLIERS = 'lendingbot_portfolioChartFilterOutliers';

let _portfolioChartFilterOutliers = localStorage.getItem(LS_PORTFOLIO_OUTLIERS) === 'true';

function _updatePortfolioOutlierBtn(btn, active) {
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.title = active ? tr('len.show_outliers', 'Ausreißer einblenden') : tr('len.hide_outliers', 'Ausreißer ausblenden');
}

function renderDetailPortfolioChart(data) {
    const svg = document.getElementById('portfolioChartModalSvg');
    if (!svg || !data) return;

    const H       = svg.getBoundingClientRect().height || 380;
    const pRange  = activeRange(portfolioRange, data?.balanceHistory ?? [], r => r.ts);
    const history = filterByRange(data?.balanceHistory ?? [], portfolioRange, r => r.ts);
    if (history.length < 2) {
        svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" class="chart-label" dominant-baseline="middle">${tr('liq.no_data_range_plain', 'Keine Daten für diesen Zeitraum')}</text>`;
        return;
    }

    const baseline = data?.portfolio?.baseline ?? null;
    svg.setAttribute('height', H);
    const geo = _buildPortfolioSvg(svg, H, 72, 16, 16, 34, history, pRange, _portfolioChartFilterOutliers, baseline);
    if (geo) attachHoverOverlay(svg, geo);
}

function initPortfolioChartModal(getData) {
    const modal    = document.getElementById('portfolioChartModal');
    const closeBtn = document.getElementById('portfolioChartModalClose');
    if (!modal) return;

    const openModal = () => {
        const data = getData();
        if (!data) return;
        modal.style.display = 'flex';
        updateChartRangeBtns(
            data?.balanceHistory ?? [], r => r.ts,
            'portfolioChartModalRangeBtns',
            () => portfolioRange,
            v  => {
                portfolioRange = v;
                localStorage.setItem(LS_PORTFOLIO_RANGE, v);
                // Inline-Chart synchron halten
                renderPortfolioChart(getData());
            },
            () => renderDetailPortfolioChart(getData())
        );
        requestAnimationFrame(() => requestAnimationFrame(() => renderDetailPortfolioChart(getData())));
    };

    document.getElementById('portfolioChartSvg')?.addEventListener('click', openModal);

    closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none';
    });

    const outlierBtn = document.getElementById('portfolioChartOutlierToggle');
    _updatePortfolioOutlierBtn(outlierBtn, _portfolioChartFilterOutliers);
    outlierBtn?.addEventListener('click', () => {
        _portfolioChartFilterOutliers = !_portfolioChartFilterOutliers;
        localStorage.setItem(LS_PORTFOLIO_OUTLIERS, _portfolioChartFilterOutliers);
        _updatePortfolioOutlierBtn(outlierBtn, _portfolioChartFilterOutliers);
        renderDetailPortfolioChart(getData());
    });
}

// ─── Chart-Range-Definitionen ─────────────────────────────────────────────────

// Zeitraum-Filter: zentrale Lib html/js/chart-range.js (LEN#000935). Der Wunsch (gespeicherte
// Nutzerwahl) steckt in den _xxxRange-Variablen. Angezeigt wird activeRange(): der Wunsch, sofern
// die Reihe weit genug zurückreicht, sonst der größte wählbare Zeitraum.
// Kein Zusatz-Zeitraum „Alle": der Export liefert 30 Tage, „Alle" zeigte nie mehr als 1M (KB Core/chart-range-lib).
// Ein gespeicherter Altwert 'all' ist unbekannt und fällt auf den größten wählbaren Zeitraum zurück.

/** Tatsächlich angezeigter Zeitraum einer Reihe (Rückfall bei zu wenig Historie). */
function activeRange(wish, series, getTs, ranges = DEFAULT_RANGES) {
    return resolveRange(wish, historyStartOf(series, getTs), { ranges });
}

/** Reihe auf den aktiven Zeitraum filtern. */
function filterByRange(arr, range, getTs, ranges = DEFAULT_RANGES) {
    return filterToRange(arr, activeRange(range, arr, getTs, ranges), { ranges, getTs });
}

/**
 * Gibt die passende X-Achsen-Beschriftung zurück:
 * - 1D → Uhrzeit (HH:MM)
 * - alle anderen → Datum (TT.MM.)
 */
function xLabel(ts, range) {
    return range === '1D' ? fmtTime(ts) : fmtDate(ts).slice(0, 5);
}

// containerId → { bar, container, getRange, historyStart }: eine Leiste je Container, mehrere
// Container dürfen denselben Wunsch teilen (z.B. Inline-Chart und Modal).
const _rangeBars = new Map();

function _syncRangeBar(entry) {
    const wish = normalizeRangeKey(entry.getRange(), entry.bar.ranges);
    if (wish != null) entry.bar.setActive(wish);   // 'set'/'history' lösen kein onChange-Rendern aus (siehe onChange unten)
    entry.bar.setHistoryStart(entry.historyStart);
}

/**
 * Hängt die Zeitraum-Leiste `containerId` an die Lib. Gesperrte Zeiträume (zu wenig Historie)
 * bleiben sichtbar, aber nicht klickbar; der Wunsch bleibt bei einem Rückfall erhalten.
 * Die Leiste ändert nur den Wunsch (setRange) und ruft rerender; gezeichnet wird mit activeRange().
 */
function updateChartRangeBtns(history, getTs, containerId, getRange, setRange, rerender, ranges = DEFAULT_RANGES) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const historyStart = historyStartOf(history, getTs);
    let entry = _rangeBars.get(containerId);
    if (!entry || entry.container !== container) {
        entry?.bar.destroy();
        entry = { container, getRange, historyStart };
        entry.bar = createRangeBar(container, {
            ranges,
            active: getRange(),
            historyStart,
            onChange: (key, { reason }) => {
                if (reason !== 'user') return;   // Rückfall/Programmwahl: der Aufrufer rendert selbst
                setRange(key);
                _rangeBars.forEach(_syncRangeBar);   // andere Leisten mit demselben Wunsch nachziehen
                rerender();
            },
        });
        _rangeBars.set(containerId, entry);
    }
    entry.getRange     = getRange;
    entry.historyStart = historyStart;
    _syncRangeBar(entry);
}

// ─── Portfolio-Chart (Row 2 + Modal) ─────────────────────────────────────────

let portfolioRange = localStorage.getItem(LS_PORTFOLIO_RANGE) ?? '1D';

/**
 * Zeichnet einen Portfolio-Verlaufs-Chart in ein SVG-Element.
 * Wiederverwendbar für Inline-Chart (H=160) und Modal (H=380).
 * History-Format: [{ts, v}]
 *
 * @returns {object|false}  Geo-Objekt für attachHoverOverlay, oder false bei < 2 Punkten
 */
function _buildPortfolioSvg(svgEl, H, PAD_L, PAD_R, PAD_T, PAD_B, history, range, filterOl, baseline) {
    const W  = svgEl.getBoundingClientRect().width || svgEl.parentElement?.clientWidth || 800;
    const cW = W - PAD_L - PAD_R;
    const cH = H - PAD_T - PAD_B;

    const tsArr  = history.map(r => r.ts);
    const rawVs  = history.map(r => r.v);
    const vs     = filterOl ? filterOutliers(rawVs, 3) : rawVs;
    const validVs = vs.filter(v => v !== null);
    if (validVs.length < 2) return false;

    const tMin = Math.min(...tsArr), tMax = Math.max(...tsArr);
    let yMin = Math.min(...validVs);
    let yMax = Math.max(...validVs);
    if (baseline != null) { yMin = Math.min(yMin, baseline); yMax = Math.max(yMax, baseline); }
    const yRng = yMax - yMin;
    if (yRng < 1) { yMin -= 1; yMax += 1; }
    else          { yMin -= yRng * 0.05; yMax += yRng * 0.08; }

    const sx = t => PAD_L + ((t - tMin) / (tMax - tMin || 1)) * cW;
    const sy = v => PAD_T + (1 - (v - yMin) / (yMax - yMin || 1)) * cH;

    const spanMs   = tMax - tMin;
    const decimals = yRng > 50 ? 0 : 2;

    const gradId = `pvGrad_${svgEl.id}`;

    // Grid + Y-Labels
    let gridLines = '';
    for (let i = 0; i <= 4; i++) {
        const v = yMin + (yMax - yMin) * i / 4;
        const y = sy(v).toFixed(1);
        gridLines += `<line class="chart-grid" x1="${PAD_L}" x2="${(PAD_L + cW).toFixed(1)}" y1="${y}" y2="${y}"/>`;
        gridLines += `<text class="chart-label chart-label-y" x="${(PAD_L - 5).toFixed(1)}" y="${(+y + 4).toFixed(1)}">${fmt(v, decimals)}</text>`;
    }

    // X-Labels
    let xLabels = '';
    for (let i = 0; i <= 4; i++) {
        const t = tMin + spanMs * i / 4;
        xLabels += `<text class="chart-label chart-label-x" x="${sx(t).toFixed(1)}" y="${(PAD_T + cH + 16).toFixed(1)}">${xLabel(t, range)}</text>`;
    }
    // Achsentitel: Y = Einheit (gedreht), X = Uhrzeit bzw. Datum.
    const xTitle = range === '1D' ? tr('liq.axis_time', 'Uhrzeit') : tr('liq.axis_date', 'Datum');
    xLabels += `<text class="chart-label" transform="translate(11,${(PAD_T + cH / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-size="10">USDC</text>`;
    xLabels += `<text class="chart-label" x="${(PAD_L + cW / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle" font-size="10">${xTitle}</text>`;

    // Pfad: herausgefilterte Ausreißer (null) werden übersprungen, die Linie läuft durchgehend
    // weiter — ein Abbruch je Ausreißer hinterließ Löcher im Chart (LIQ#000986).
    const bottomY = (PAD_T + cH).toFixed(1);
    const segs = [];
    let seg = [];
    for (let i = 0; i < history.length; i++) {
        if (vs[i] !== null) seg.push({ ts: history[i].ts, v: vs[i] });
    }
    if (seg.length >= 2) segs.push(seg);

    const lineD = segs.map(s =>
        'M ' + s.map(p => `${sx(p.ts).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' L ')
    ).join(' ');
    const areaD = segs.map(s => {
        const pts = s.map(p => `${sx(p.ts).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' L ');
        return `M ${pts} L ${sx(s[s.length - 1].ts).toFixed(1)},${bottomY} L ${sx(s[0].ts).toFixed(1)},${bottomY} Z`;
    }).join(' ');

    // Baseline-Linie
    const baselineSvg = baseline != null
        ? `<line x1="${PAD_L}" y1="${sy(baseline).toFixed(1)}" x2="${(PAD_L + cW).toFixed(1)}" y2="${sy(baseline).toFixed(1)}" class="baseline-line" stroke-dasharray="4,3"><title>Basis: ${fmt(baseline)} USDC</title></line>`
        : '';

    // Letzter Datenpunkt: Marker
    const lastSeg = segs[segs.length - 1];
    const lastPt  = lastSeg?.[lastSeg.length - 1];
    const marker  = lastPt
        ? `<circle cx="${sx(lastPt.ts).toFixed(1)}" cy="${sy(lastPt.v).toFixed(1)}" r="5" class="price-marker"/>
           <circle cx="${sx(lastPt.ts).toFixed(1)}" cy="${sy(lastPt.v).toFixed(1)}" r="8" class="price-marker-ring" opacity="0.4"/>`
        : '';

    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.innerHTML = `
        <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stop-color="var(--primary)" stop-opacity="0.30"/>
                <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
            </linearGradient>
        </defs>
        ${gridLines}${xLabels}
        <path d="${areaD}" fill="url(#${gradId})" stroke="none"/>
        ${baselineSvg}
        <path d="${lineD}" class="chart-line" stroke-linejoin="round" stroke-linecap="round"/>
        ${marker}`;

    return {
        tMin, tMax, spanMs,
        PAD_L, cW, PAD_T, cH, W, H,
        yMin, yMax,
        formatY: v => fmt(v, decimals) + ' USDC',
    };
}

function renderPortfolioChart(data) {
    const svg      = document.getElementById('portfolioChartSvg');
    const emptyMsg = document.getElementById('portfolioChartEmptyMsg');
    if (!svg) return;

    // Quelle balanceHistory (Export): dieselbe Basis wie die Gesamt-Karte (Positionen + ganzes Wallet).
    const pRange  = activeRange(portfolioRange, data?.balanceHistory ?? [], r => r.ts);
    const history = filterByRange(data?.balanceHistory ?? [], portfolioRange, r => r.ts);
    svg.style.display = 'block';   // für die Breitenmessung in _buildPortfolioSvg
    svg.setAttribute('height', '160');
    const geo = history.length >= 2 && _buildPortfolioSvg(svg, 160, 62, 16, 12, 34, history, pRange, false, null);
    svg.style.display = geo ? 'block' : 'none';
    if (emptyMsg) emptyMsg.style.display = geo ? 'none' : 'block';
    if (geo) attachHoverOverlay(svg, geo);
}

// ─── Aktive Positionen (Row 3) ────────────────────────────────────────────────

function renderPositions(data) {
    const container = document.getElementById('positionsContainer');
    const positions = data?.positions ?? [];
    const showInactive = document.getElementById('showInactivePools')?.checked ?? false;

    // ── Einheitliche Liste: aktive + inaktive Pools ──────────────────────────
    const activeIds = new Set(positions.map(p => p.protocol));
    const cards = [];

    // Aktive Positionen
    for (const pos of positions) {
        cards.push({ active: true, pos, apy: pos.currentApy ?? -1 });
    }

    // Inaktive Protokolle (nur mit bekannter APY)
    if (showInactive) {
        for (const proto of knownPools()) {
            if (activeIds.has(proto.id)) continue;
            const stats  = data?.protocolStats?.[proto.id];
            if (stats?.apy == null) continue;
            cards.push({ active: false, proto, stats, apy: stats.apy });
        }
    }

    // Sortierung: APY absteigend
    cards.sort((a, b) => b.apy - a.apy);

    // ── Rendern ──────────────────────────────────────────────────────────────
    let html = '<div class="positions-grid">';

    for (const card of cards) {
        if (card.active) {
            html += renderActiveCard(card.pos, data);
        } else {
            html += renderInactiveCard(card.proto, card.stats);
        }
    }

    html += '</div>';
    container.innerHTML = html;
}

/** Rendert eine aktive Pool-Card */
function renderActiveCard(pos) {
    const proto  = pos.protocol ?? 'unknown';
    const label  = pos.protocolLabel ?? protocolLabel(proto);
    const asset  = pos.asset ?? 'USDC';

    const apyVal = pos.currentApy;
    const apyStr = apyVal != null ? fmt(apyVal, 2) + ' % APY' : '— % APY';
    const apyCls = apyVal == null ? '' : apyVal < 3 ? 'apy-low' : apyVal >= 7 ? 'apy-good' : 'apy-ok';

    const yieldVal    = pos.accruedYield ?? 0;
    const yieldStr    = fmt(yieldVal, 4);
    const yieldPosCls = yieldVal >= 0 ? 'positive' : '';

    const duration = (() => {
        if (!pos.startedAt) return '—';
        const totalH = Math.floor((Date.now() - pos.startedAt) / 3_600_000);
        const d = Math.floor(totalH / 24);
        const h = totalH % 24;
        if (d === 0) return `${h}\u202fStd`;
        return `${d}\u202fTag${d !== 1 ? 'e' : ''}\u202f${h}\u202fStd`;
    })();

    const tvlStr = fmtTvl(pos.poolTvl);
    const noteIcon = poolNoteIcon(proto);

    const investVal    = pos.netInvested ?? pos.amount;
    // Guthaben = On-Chain-Stand direkt (pos.amount), nicht aus netInvested + yield
    // rekonstruiert. Sonst weicht es bei gedeckeltem accruedYield (LB#0161) vom
    // tatsächlichen Positionswert ab.
    const guthabenStr  = fmt(pos.amount ?? (investVal + yieldVal));

    const breakEvenBadge = (() => {
        if (pos.breakEven !== true) return '';
        const totalFee = ((pos.txFeeUsdc ?? 0) + (pos.exitFeeUsdc ?? 0));
        const tip = `Yield deckt alle bisherigen TX-Gebühren\n+ geschätzte Auszahlungsgebühr\n(${fmt(totalFee, 4)} USDC gesamt).\nEin Ausstieg ist jetzt netto profitabel.`;
        return ` <span class="break-even-badge has-tooltip" data-tooltip-title="${tr('len.break_even', 'Break-Even erreicht')}" data-tooltip-content="${tip}">✓</span>`;
    })();

    return `
        <div class="position-card ${proto}" style="--pc-color:${protocolColor(proto)}">
            <div class="pc-header">
                <span class="pc-protocol">${label}${noteIcon}</span>
                <span class="pc-apy ${apyCls} apy-clickable" data-protocol="${proto}" data-label="${label}" title="${tr('len.apy_show', 'APY-Verlauf anzeigen')}">${apyStr}</span>
            </div>
            <div class="pc-tvl-row">
                <span class="pc-label">${tr('liq.tvl', 'TVL')}</span>
                <span class="pc-value pc-tvl tvl-clickable" data-protocol="${proto}" data-label="${label}" title="${tr('len.tvl_show', 'TVL-Verlauf anzeigen')}">${tvlStr}</span>
            </div>
            <div class="pc-body">
                <div class="pc-row">
                    <span class="pc-label">${tr('len.investment', 'Investment')}</span>
                    <span class="pc-value investment-clickable" data-protocol="${proto}" data-label="${label}">${fmt(investVal)} <span class="pc-unit">${asset}</span></span>
                </div>
                <div class="pc-row">
                    <span class="pc-label">${tr('len.yield', 'Yield')}</span>
                    <span class="pc-value ${yieldPosCls}">${yieldStr} <span class="pc-unit">${asset}</span></span>
                </div>
                <div class="pc-row pc-row-guthaben">
                    <span class="pc-label">${tr('len.balance', 'Guthaben')}</span>
                    <span class="pc-value">${guthabenStr} <span class="pc-unit">${asset}</span></span>
                </div>
            </div>
            <div class="pc-meta">
                <span>Laufzeit: ${duration}</span>${breakEvenBadge}
            </div>
        </div>`;
}

/** Rendert eine inaktive Pool-Card */
function renderInactiveCard(proto, stats) {
    const apyStr   = fmt(stats.apy, 2) + '\u202f% APY';
    const tvlStr   = fmtTvl(stats?.tvl ?? null);
    const noteIcon = poolNoteIcon(proto.id);

    return `
        <div class="position-card ${proto.id} pc-inactive" style="--pc-color:${protocolColor(proto.id)}">
            <div class="pc-header">
                <span class="pc-protocol">${proto.label}${noteIcon}</span>
                <span class="pc-apy apy-inactive apy-clickable" data-protocol="${proto.id}" data-label="${proto.label}" title="${tr('len.apy_show', 'APY-Verlauf anzeigen')}">${apyStr}</span>
            </div>
            <div class="pc-tvl-row">
                <span class="pc-label">${tr('liq.tvl', 'TVL')}</span>
                <span class="pc-value pc-tvl tvl-clickable" data-protocol="${proto.id}" data-label="${proto.label}" title="${tr('len.tvl_show', 'TVL-Verlauf anzeigen')}">${tvlStr}</span>
            </div>
            <div class="pc-body">
                <div class="pc-row">
                    <span class="pc-label">${tr('len.investment', 'Investment')}</span>
                    <span class="pc-value investment-clickable" data-protocol="${proto.id}" data-label="${proto.label}">— <span class="pc-unit">USDC</span></span>
                </div>
                <div class="pc-row">
                    <span class="pc-label">${tr('len.yield', 'Yield')}</span>
                    <span class="pc-value pc-dimmed">—</span>
                </div>
                <div class="pc-row pc-row-guthaben">
                    <span class="pc-label">${tr('len.balance', 'Guthaben')}</span>
                    <span class="pc-value pc-dimmed">—</span>
                </div>
            </div>
            <div class="pc-meta">
                <span>${tr('len.runtime_none', 'Laufzeit: —')}</span>
            </div>
        </div>`;
}

// ─── Row 3: Pool Metriken + Operative Metriken ──────────────────────────────────────

const LS_POOL_VIS_FILTER = 'lendingbot_pools_vis_filter';
let   _poolsVisFilter    = localStorage.getItem(LS_POOL_VIS_FILTER) ?? 'all';

function renderAvailablePools(data) {
    const container = document.getElementById('availablePoolsContainer');
    if (!container) return;

    // Anders als bei den positionsbezogenen Boxen (Operative Metriken) ist
    // "keine offene Position" hier KEIN Grund, die Tabelle auszublenden — Pool
    // Metriken listet die verfügbaren Pools, nicht Positionen. Ohne offene
    // Position wird stattdessen der Filter auf "Alle Pools" gezwungen, damit
    // die Tabelle nicht leer bleibt, falls zuletzt "Aktive Pools" gewählt war.
    // Analog zur Lösung im Liquidity Bot (html/liquidity/js/app.js).
    if (data?.botActive === false && _poolsVisFilter !== 'all') {
        _poolsVisFilter = 'all';
        localStorage.setItem(LS_POOL_VIS_FILTER, _poolsVisFilter);
    }

    const activeIds = new Set((data?.positions ?? []).map(p => p.protocol));
    const stats     = data?.protocolStats ?? {};

    const allRows = knownPools()
        .map(proto => {
            const st = stats[proto.id] ?? {};
            const meta = POOL_META[proto.id] ?? {};
            return {
                // Zustand laut Pool-Register. Ein nicht mehr abgefragter Pool hat keine
                // Messwerte: Die Zeile zeigt dann Striche statt eingefrorener Zahlen.
                depositClosed: meta.state !== 'aktiv',
                notQueried:    meta.queried === false,
                id:      proto.id,
                label:   proto.label,
                apy:     st.apy ?? null,
                tvl:     st.tvl ?? null,
                liq:     st.liquidity ?? null,
                // Schutz-Zustand kommt fertig aus dem Export (bin/export.js) – das
                // Dashboard hat keinen Zugriff auf die settings.db.
                enabled:      st.poolEnabled !== false,
                tvlBelow:     st.tvlBelow === true,
                liqBelow:     st.liqBelow === true,
                tvlThreshold: st.tvlThreshold ?? null,
                liqThreshold: st.liqThreshold ?? null,
                // Dritter Grund, aus dem "Bester Pool" einen Pool überspringt: zu
                // wenig Messpunkte für einen fairen APY-Vergleich (frisch ins
                // Polling aufgenommen). Kein Fehler und keine Gefahr – ein
                // Übergangszustand, der sich von selbst erledigt.
                basisBelow:    st.dataBasisBelow === true,
                dataPoints:    st.dataPoints ?? 0,
                coverageHours: st.coverageHours ?? 0,
                active:  activeIds.has(proto.id),
            };
        })
        .filter(r => r.apy != null || r.notQueried)
        .sort((a, b) => (b.apy ?? -Infinity) - (a.apy ?? -Infinity));

    const rows = _poolsVisFilter === 'active'   ? allRows.filter(r =>  r.active)
               : _poolsVisFilter === 'inactive' ? allRows.filter(r => !r.active)
               : allRows;

    const filterSelect = `<select id="lbPoolsVisFilterSelect" class="pools-header-select" data-stop-tooltip="1">
        <option value="all"${_poolsVisFilter==='all'?' selected':''}>${tr('liq.all_pools', 'Alle Pools')}</option>
        <option value="active"${_poolsVisFilter==='active'?' selected':''}>${tr('liq.active_pools', 'Aktive Pools')}</option>
        <option value="inactive"${_poolsVisFilter==='inactive'?' selected':''}>${tr('liq.inactive_pools', 'Inaktive Pools')}</option>
    </select>`;

    const header = `
        <div class="lb-pools-header">
            <span>${filterSelect}</span>
            <span class="col-r lb-pools-col-asset">${tr('len.asset', 'Asset')}</span>
            <span class="col-r">${tr('len.apy', 'APY')}</span>
            <span class="col-r">${tr('liq.tvl', 'TVL')}</span>
            <span class="col-r">${tr('len.liquidity', 'Liquidität')}</span>
        </div>`;

    if (rows.length === 0) {
        container.innerHTML = header + '<p class="empty-state">— ' + tr('len.no_pools_view_plain', 'Keine Pools in dieser Ansicht') + '</p>';
    } else {
        let rowsHtml = '';
        for (const r of rows) {
            // Zeilen-Zustand: vom Nutzer deaktivierte Pools (Pool-Freigabe aus) werden grau
            // dargestellt. Kein Verbots-Icon mehr (Festlegung 13.10.2026, LEN#001365). Damit
            // die Bedeutung nicht allein an der Farbe hängt, trägt der Pool-Name den Tooltip.
            const rowCls = [
                r.active ? 'lb-row-active' : 'lb-row-inactive',
                r.enabled ? '' : 'lb-row-disabled',
            ].filter(Boolean).join(' ');

            const nameHtml = r.enabled ? escHtml(r.label) :
                `<span class="has-tooltip" data-tooltip-title="${tr('len.pool_disabled_title', 'Pool deaktiviert')}" data-tooltip-content="${tr('len.pool_disabled_tip', 'Dieser Pool ist deaktiviert. Es wird weder automatisch noch manuell in ihn eingezahlt, bis du ihn in den Einstellungen wieder aktivierst.')}">${escHtml(r.label)}</span>`;

            // Keine Einzahlungen mehr (Zustand im Pool-Register): eigenes Icon mit Tooltip,
            // unabhängig von der Pool-Freigabe des Nutzers.
            const closedIcon = !r.depositClosed ? '' :
                `<span class="lb-pool-icon has-tooltip" data-tooltip-title="${tr('len.pool_closed_title', 'Keine Einzahlungen mehr')}" data-tooltip-content="${r.notQueried
                    ? tr('len.pool_closed_unqueried_tip', 'Dieser Pool nimmt bei FORGE keine Einzahlungen mehr an und wird nicht mehr abgefragt. Deshalb gibt es keine aktuellen Werte.')
                    : tr('len.pool_closed_tip', 'Dieser Pool nimmt bei FORGE keine Einzahlungen mehr an. Bestehendes Guthaben kannst du in den Einstellungen auszahlen.')}">\u26D4</span> `;

            const apyStr = r.apy != null ? fmt(r.apy, 2) + ' %' : '—';

            // Zu dünne Datenbasis: Sanduhr-Icon an der APY-Spalte – dort steht der
            // Wert, der noch nicht vergleichbar ist. Bewusst NICHT das Warndreieck
            // der beiden Schutzschwellen: hier ist nichts in Gefahr, es fehlen nur
            // noch Messpunkte. Die Bedeutung steht im Tooltip, nie in der Farbe.
            const basisIcon = r.basisBelow
                ? `<span class="lb-pool-icon has-tooltip" data-tooltip-title="${tr('len.basis_below_title', 'Datenbasis reicht noch nicht')}" data-tooltip-content="${tr('len.basis_below_tip', 'Für den Vergleich über „Bester Pool“ braucht ein Pool mindestens {minPoints} Messpunkte über {minHours} Stunden. Dieser Pool hat bisher {points} Messpunkte über {hours} Stunden — sein Durchschnitts-APY ist damit noch nicht mit dem der anderen Pools vergleichbar. Der Wert wird weiter erfasst, der Pool rankt automatisch mit, sobald die Datenbasis reicht.', {
                    minPoints: data?.config?.minDataPoints ?? 12,
                    minHours:  data?.config?.minCoverageHours ?? 24,
                    points:    r.dataPoints,
                    hours:     fmt(r.coverageHours, 1),
                  })}">⏳</span> `
                : '';

            // Unterschrittene Schutz-Schwelle: Wert rot + Icon links davon.
            // Beides zusammen, nie Farbe allein.
            const tvlIcon = r.tvlBelow
                ? `<span class="lb-pool-icon has-tooltip" data-tooltip-title="${tr('len.tvl_below_title', 'TVL unter der Schwelle')}" data-tooltip-content="${tr('len.tvl_below_tip', 'Der TVL dieses Pools liegt unter der eingestellten TVL-Schutz-Schwelle ({threshold}). Über „Bester Pool“ wird derzeit nicht in diesen Pool investiert.', { threshold: fmtTvl(r.tvlThreshold) })}">\u26A0</span> `
                : '';
            const liqIcon = r.liqBelow
                ? `<span class="lb-pool-icon has-tooltip" data-tooltip-title="${tr('len.liq_below_title', 'Liquidität unter der Schwelle')}" data-tooltip-content="${tr('len.liq_below_tip', 'Die sofort abhebbare Liquidität dieses Pools liegt unter der eingestellten Liquiditäts-Schutz-Schwelle ({threshold}). Über „Bester Pool“ wird derzeit nicht in diesen Pool investiert.', { threshold: fmtLiquidity(r.liqThreshold) })}">\u26A0</span> `
                : '';

            rowsHtml += `
            <div class="lb-pools-row ${rowCls}">
                <span>${closedIcon}${nameHtml}</span>
                <span class="col-r lb-pools-col-asset" style="color:var(--text-muted);font-size:0.78rem">USDC</span>
                <span class="col-r">${basisIcon}<span class="apy-clickable" data-protocol="${escHtml(r.id)}" data-label="${escHtml(r.label)}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px" title="${tr('len.apy_history', 'APY-Verlauf')}">${apyStr}</span></span>
                <span class="col-r">${tvlIcon}<span class="tvl-clickable${r.tvlBelow ? ' lb-below' : ''}" data-protocol="${escHtml(r.id)}" data-label="${escHtml(r.label)}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px" title="${tr('len.tvl_history', 'TVL-Verlauf')}">${fmtTvl(r.tvl)}</span></span>
                <span class="col-r">${liqIcon}<span class="liq-clickable${r.liqBelow ? ' lb-below' : ''}" data-protocol="${escHtml(r.id)}" data-label="${escHtml(r.label)}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px" title="${tr('len.liq_history', 'Liquiditäts-Verlauf')}">${fmtLiquidity(r.liq)}</span></span>
            </div>`;
        }
        container.innerHTML = header + `<div class="lb-pools-scroll">${rowsHtml}</div>`;
    }

    // Select verdrahten
    container.querySelector('#lbPoolsVisFilterSelect')?.addEventListener('change', e => {
        _poolsVisFilter = e.target.value;
        localStorage.setItem(LS_POOL_VIS_FILTER, _poolsVisFilter);
        renderAvailablePools(data);
    });
}


function _calcInOut1D(proto, txns) {
    const cutoff = rangeCutoff('1D');
    const relevant = (txns ?? []).filter(t => t.protocol === proto && t.createdAt >= cutoff);
    if (relevant.length === 0) return null;
    return relevant.reduce((s, t) => s + (t.type === 'deposit' ? t.amount : t.type === 'withdraw' ? -t.amount : 0), 0);
}

function renderActivePools(data) {
    const container = document.getElementById('activePoolsContainer');
    if (!container) return;

    if (data?.botActive === false) {
        container.innerHTML = '';
        renderBotInactivePanel(container, tr('liq.no_open_positions', 'Keine offenen Positionen'));
        return;
    }

    const positions = [...(data?.positions ?? [])]
        .sort((a, b) => (b.currentApy ?? -1) - (a.currentApy ?? -1));

    if (positions.length === 0) {
        container.innerHTML = '<p class="empty-state">— Keine aktiven Positionen</p>';
        return;
    }

    const colMode = _activePoolsColMode;
    const colSelect = `<select id="activePoolsColSelect" class="active-pools-col-select">
        <option value="investment"${colMode === 'investment' ? ' selected' : ''}>${tr('len.investment', 'Investment')}</option>
        <option value="inout1d"${colMode === 'inout1d' ? ' selected' : ''}>${tr('len.in_out_1d', 'In- / Out (1D)')}</option>
    </select>`;

    let html = `
        <div class="lb-active-header">
            <span>${tr('liq.active_pools', 'Aktive Pools')}</span>
            <span class="col-r">${colSelect}</span>
            <span class="col-r lb-active-col-yield">${tr('len.yield', 'Yield')}</span>
            <span class="col-r">${tr('len.balance', 'Guthaben')}</span>
        </div>`;

    for (const pos of positions) {
        const proto       = pos.protocol ?? 'unknown';
        const label       = pos.protocolLabel ?? protocolLabel(proto);
        const investVal   = pos.netInvested ?? pos.amount;
        const yieldVal    = pos.accruedYield ?? 0;
        // Guthaben = On-Chain-Stand direkt (pos.amount), nicht aus netInvested + yield
        // rekonstruiert (konsistent mit renderActiveCard, robust gegen accruedYield-Cap).
        const guthabenVal = pos.amount ?? (investVal + yieldVal);

        const unit = `<span class="pc-unit" style="font-size:0.75rem;color:var(--text-secondary)"> USDC</span>`;

        let col2Html;
        if (colMode === 'inout1d') {
            const net = _calcInOut1D(proto, data?.transactions);
            if (net === null) {
                col2Html = '<span style="color:var(--text-secondary);font-size:0.85em">no data</span>';
            } else if (net === 0) {
                col2Html = `<span style="color:var(--text-secondary)">±0${unit}</span>`;
            } else {
                const sign = net >= 0 ? '+' : '−';
                const type = net >= 0 ? 'positive' : 'negative';
                col2Html = `<span class="inout-clickable" data-protocol="${escHtml(proto)}" data-label="${escHtml(label)}"
                    data-type="${type}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px"
                    >${sign}${fmt(Math.abs(net))}${unit}</span>`;
            }
        } else {
            col2Html = `${fmt(investVal)}${unit}`;
        }

        html += `
        <div class="lb-active-row">
            <span>${escHtml(label)}</span>
            <span class="col-r">${col2Html}</span>
            <span class="col-r lb-active-col-yield">${fmt(yieldVal, 4)}${unit}</span>
            <span class="col-r">${fmt(guthabenVal)}${unit}</span>
        </div>`;
    }

    container.innerHTML = html;
}

// ─── Pending Withdrawals (Row 3b) ────────────────────────────────────────────

function renderPendingWithdrawals(data) {
    const card      = document.getElementById('pendingWithdrawalsCard');
    const container = document.getElementById('pendingWithdrawalsContainer');
    const pending   = data?.pendingWithdrawals ?? [];

    if (pending.length === 0) {
        card.classList.add('hidden');
        return;
    }

    card.classList.remove('hidden');
    const now = Date.now();

    container.innerHTML = '<div class="pending-list">' + pending.map(pw => {
        const total    = pw.cooldownSeconds * 1000;
        const elapsed  = now - pw.initiatedAt;
        const pct      = Math.min(100, Math.round((elapsed / total) * 100));
        const isReady  = pw.isReady || now >= pw.readyAt;
        const remaining = Math.max(0, pw.readyAt - now);

        const remainingLabel = isReady
            ? tr('len.ready_to_finish', 'Bereit zum Abschließen!')
            : fmtCooldown(remaining);

        const badge = isReady
            ? `<span class="pending-ready-badge">${tr('len.ready', '✓ Bereit')}</span>`
            : `<span class="pending-waiting-badge">${tr('len.waiting', '⏳ Wartet')}</span>`;

        return `
        <div class="pending-item" data-id="${pw.id}">
            <div class="pending-item-left">
                <span class="pending-item-amount">${fmt(pw.amount)} <span class="pending-item-unit">${pw.asset ?? 'USDC'}</span></span>
                <span class="pending-item-meta">Lulo ${pw.poolType} · Initiiert ${fmtDateTime(pw.initiatedAt)}</span>
            </div>
            <div class="pending-item-center">
                <div class="cooldown-bar-wrapper">
                    <div class="cooldown-bar-fill ${isReady ? 'ready' : ''}" style="width:${pct}%"></div>
                </div>
                <span class="cooldown-label ${isReady ? 'ready' : ''}">${remainingLabel}</span>
            </div>
            <div class="pending-item-right">
                ${badge}
            </div>
        </div>`;
    }).join('') + '</div>';
}

/** Formatiert verbleibende Zeit in "X Tage Y Std" oder "X Std Y Min" */
function fmtCooldown(ms) {
    const totalSec  = Math.floor(ms / 1000);
    const days      = Math.floor(totalSec / 86400);
    const hours     = Math.floor((totalSec % 86400) / 3600);
    const minutes   = Math.floor((totalSec % 3600) / 60);
    if (days > 0)   return `Noch ${days}T ${hours}Std`;
    if (hours > 0)  return `Noch ${hours}Std ${minutes}Min`;
    return `Noch ${minutes} Min`;
}

// ─── Statistiken (Row 4) ─────────────────────────────────────────────────────

/**
 * Berechnet Periodenstart-Timestamps und Datums-Labels für die Statistik-Karten.
 * Alle Zeiten beziehen sich auf FORGE_TZ (zentraler Helper in /js/tz.js).
 *
 * Vorher nutzte diese Funktion den fragilen Pattern
 *   new Date(now).toLocaleString('en-US', { timeZone: 'Europe/Berlin' })
 * plus manuelle tzOffset-Subtraktion. Das war a) hartcodiert und b) brüchig
 * bei Sommerzeit-Übergängen und nicht-Latin-locales. Neu über Intl und
 * zonedWallClockToMs().
 */
function tzPeriodBounds() {
    const p              = partsInTZ();                     // Heute in FORGE_TZ
    const todayIsoStr    = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    const monthIsoStr    = `${p.year}-${String(p.month).padStart(2, '0')}-01`;

    const todayMs        = startOfDayMs();                  // 00:00 in FORGE_TZ, heute
    const yesterdayMs    = todayMs - 86_400_000;            // 24h früher – genügt für Tagesstatistik
    const monthMs        = zonedWallClockToMs(monthIsoStr + 'T00:00:00');
    const daysThisMonth  = Math.max(1, p.day);

    const fmtDE          = (ms) => fmtDateDE(ms, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const isoInTZ        = (ms) => todayISO(new Date(ms));

    const todayDE        = fmtDE(todayMs);
    const [td, tm, ty]   = todayDE.split('.');

    return {
        todayMs, yesterdayMs, monthMs, daysThisMonth,
        todayDE,
        yesterdayDE:    fmtDE(yesterdayMs),
        monthDE:        `01.–${td}.${tm}.${ty}`,
        todayISO:       todayIsoStr,
        yesterdayISO:   isoInTZ(yesterdayMs),
        monthStartISO:  monthIsoStr,
    };
}
// Alias für bestehende Aufrufe; kann später entfernt werden.
const berlinPeriodBounds = tzPeriodBounds;

function renderStatistics(data) {
    const stats    = data?.statistics ?? {};
    const b        = berlinPeriodBounds();

    // Datums-Labels setzen
    const setTxt = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    setTxt('statDateToday',     b.todayDE);
    setTxt('statDateYesterday', b.yesterdayDE);
    setTxt('statDateMonth',     b.monthDE);

    // LB#0158 – single source: Fees, APR und PnL werden in export.js aus dem konsistenten
    // Datensnapshot berechnet. Das Dashboard zeigt sie nur an (keine Neuberechnung mehr).
    const yieldToday     = stats.today?.usdc     ?? 0;
    const yieldYesterday = stats.yesterday?.usdc ?? 0;
    const yieldMonth     = stats.month?.usdc     ?? 0;

    const feesToday     = stats.fees?.today     ?? 0;
    const feesYesterday = stats.fees?.yesterday ?? 0;
    const feesMonth     = stats.fees?.month     ?? 0;

    const aprToday     = stats.apr?.today     ?? null;
    const aprYesterday = stats.apr?.yesterday ?? null;
    const aprMonth     = stats.apr?.month     ?? null;

    const pnlToday     = stats.pnl?.today     ?? 0;
    const pnlYesterday = stats.pnl?.yesterday ?? 0;
    const pnlMonth     = stats.pnl?.month     ?? 0;

    // Formatierung
    const fmtFees  = v => `<span class="stat-value-number clickable-value">−${fmt(v, 4)}</span><span class="stat-value-unit">USDC</span>`;
    const fmtYield = v => `<span class="stat-value-number clickable-value">+${fmt(v, 4)}</span><span class="stat-value-unit">USDC</span>`;
    const fmtPnl   = v => {
        const pos = v >= 0;
        return `<span class="stat-value-number">${pos ? '+' : '−'}${fmt(Math.abs(v), 4)}</span><span class="stat-value-unit">USDC</span>`;
    };
    const fmtApr = v => {
        const rounded = v != null ? Math.round(v * 100) / 100 : 0;
        if (v == null || rounded === 0) {
            return '<span class="stat-value-number">0,00</span><span class="stat-value-unit">%</span>';
        }
        return `<span class="stat-value-number">+${fmt(v, 2)}</span><span class="stat-value-unit">%</span>`;
    };
    // Rundet vor der Farbentscheidung (Fund 2026-08-07): ein Wert wie 0,001 wurde bisher
    // fest als 'positive' (grün) eingefärbt, obwohl er auf 0,00 % gerundet angezeigt wird —
    // sah wie ein Darstellungsfehler aus. Rundet der Wert auf 0, gilt er als neutral.
    const aprType = v => {
        const rounded = v != null ? Math.round(v * 100) / 100 : 0;
        return rounded === 0 ? 'neutral' : 'positive';
    };
    const numType = v => v == null ? 'neutral' : v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral';

    const setVal = (id, html, type) => {
        const e = document.getElementById(id);
        if (!e) return;
        e.innerHTML = html;
        if (type !== undefined) e.dataset.type = type;
    };

    setVal('statPayedFeesToday',     fmtFees(feesToday));
    setVal('statYieldToday',         fmtYield(yieldToday));
    setVal('statRenditeToday',       fmtApr(aprToday),          aprType(aprToday));
    setVal('statPnlToday',           fmtPnl(pnlToday),          numType(pnlToday));

    setVal('statPayedFeesYesterday', fmtFees(feesYesterday));
    setVal('statYieldYesterday',     fmtYield(yieldYesterday));
    setVal('statRenditeYesterday',   fmtApr(aprYesterday),      aprType(aprYesterday));
    setVal('statPnlYesterday',       fmtPnl(pnlYesterday),      numType(pnlYesterday));

    setVal('statPayedFeesMonth',     fmtFees(feesMonth));
    setVal('statYieldMonth',         fmtYield(yieldMonth));
    setVal('statRenditeMonth',       fmtApr(aprMonth),          aprType(aprMonth));
    setVal('statPnlMonth',           fmtPnl(pnlMonth),          numType(pnlMonth));

    // Top-Cards: rolling 24h – in export.js vorberechnet (single source, LB#0158).
    const _yield24h = stats.rolling24h?.yield ?? 0;
    const apr24h    = stats.rolling24h?.apr   ?? null;

    // Card 3: PnL (24h)
    // Rundet auf die angezeigten 2 Nachkommastellen, bevor Vorzeichen/Farbe entschieden
    // werden (Fund 2026-08-07): vorher immer "+X,XXXX USDC" in Grün, auch bei 0 – sah wie
    // ein Darstellungsfehler aus. Rundet der Wert auf 0,00, gilt er als neutral: kein
    // Vorzeichen, keine Farbe, 2 statt 4 Nachkommastellen (einheitlich mit anderen USDC-
    // Anzeigen).
    const pnl24hEl   = document.getElementById('pnl24hValue');
    const pnl24hUnit = document.getElementById('pnl24hUnit');
    if (pnl24hEl) {
        const rounded = Math.round(_yield24h * 100) / 100;
        if (rounded !== 0) {
            const sign = _yield24h >= 0 ? '+' : '−';
            pnl24hEl.textContent = sign + fmt(Math.abs(_yield24h), 2);
            const dtype = _yield24h >= 0 ? 'positive' : 'negative';
            pnl24hEl.setAttribute('data-type', dtype);
            pnl24hUnit?.setAttribute('data-type', dtype);
        } else {
            pnl24hEl.textContent = '0,00';
            pnl24hEl.setAttribute('data-type', 'neutral');
            pnl24hUnit?.setAttribute('data-type', 'neutral');
        }
    }

    // Card 4: Yield-APR (24h)
    const topEl    = document.getElementById('renditeValue');
    const topGroup = document.getElementById('renditeGroup');
    if (topEl) {
        if (apr24h != null) {
            topEl.textContent = '+' + fmt(apr24h, 2);
            topGroup?.setAttribute('data-type', 'positive');
        } else {
            topEl.textContent = '0,00';
            topGroup?.setAttribute('data-type', 'neutral');
        }
    }
    // Bei sehr kleinem Kapital rundet lib/pnl.js den 24h-Ertrag auf 0,00 USDC — export.js
    // weicht dann auf den protokollseitig gemeldeten Ø-APY aus (siehe rolling24h.aprIsEstimate).
    // Ein ⓘ-Icon macht das transparent, statt den Schätzwert wie eine gemessene Rendite
    // aussehen zu lassen (nicht nur Text/Farbe wäre bei Farbschwäche nicht eindeutig genug).
    const estimateIconEl = document.getElementById('renditeEstimateIcon');
    if (estimateIconEl) {
        estimateIconEl.innerHTML = stats.rolling24h?.aprIsEstimate
            ? `<span class="pc-info has-tooltip" data-tooltip-title="${tr('len.apr_estimate.title', 'Geschätzter Wert')}" data-tooltip-content="${tr('len.apr_estimate', "Bei so kleinem Kapital rundet sich dein 24h-Ertrag auf 0,00 USDC – daraus ließe sich keine sinnvolle Rendite berechnen. Stattdessen zeigen wir dir hier den aktuell vom Protokoll gemeldeten Zinssatz.")}">ⓘ</span>`
            : '';
    }

    // Click-Handler (via clickable-value spans)
    const bindSpan = (id, fn) => {
        document.getElementById(id)?.querySelector('.clickable-value')
            ?.addEventListener('click', fn, { once: false });
    };
    // re-bind each render to stay in sync with latest data
    ['statPayedFeesToday', 'statPayedFeesYesterday', 'statPayedFeesMonth'].forEach((id, i) => {
        const period = ['today', 'yesterday', 'month'][i];
        document.getElementById(id)?.querySelector('.clickable-value')
            ?.addEventListener('click', () => openStatPayedFeesModal(period, data, b));
    });
    ['statYieldToday', 'statYieldYesterday', 'statYieldMonth'].forEach((id, i) => {
        const period = ['today', 'yesterday', 'month'][i];
        document.getElementById(id)?.querySelector('.clickable-value')
            ?.addEventListener('click', () => openStatYieldModal(period, data, b));
    });
}

// ── Payed-Fees-Modal ─────────────────────────────────────────────────────────

function openStatPayedFeesModal(period, data, b) {
    const modal = document.getElementById('statPayedFeesModal');
    const title = document.getElementById('statPayedFeesModalTitle');
    const body  = document.getElementById('statPayedFeesModalBody');
    if (!modal) return;

    const labels   = { today: tr('liq.today', 'Heute'), yesterday: tr('liq.yesterday', 'Gestern'), month: tr('liq.month', 'Monat') };
    const dateLabel = period === 'today' ? b.todayDE : period === 'yesterday' ? b.yesterdayDE : b.monthDE;
    title.textContent = `TX-Fees – ${labels[period]}: ${dateLabel}`;

    const fromMs = period === 'today' ? b.todayMs : period === 'yesterday' ? b.yesterdayMs : b.monthMs;
    const toMs   = period === 'yesterday' ? b.todayMs : null;

    const txs = (data?.transactions ?? [])
        .filter(t => t.createdAt >= fromMs && (toMs == null || t.createdAt < toMs) && (t.feeUsdc ?? 0) > 0)
        .sort((a, b2) => a.createdAt - b2.createdAt);

    const total = txs.reduce((s, t) => s + (t.feeUsdc ?? 0), 0);

    const fmtDT = ms => makeFmt(NUM_LOCALE, {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    }).format(new Date(ms));

    const typeLabel = { deposit: 'Einzahlung', withdraw: 'Auszahlung', rebalance: 'Rebalancing', claim: 'Claim' };

    if (txs.length === 0) {
        body.innerHTML = `<p class="empty-state" style="padding:1rem">${tr('liq.no_tx_period', '— Keine Transaktionen im Zeitraum')}</p>`;
    } else {
        const rows = txs.map(t => `<tr>
            <td style="white-space:nowrap">${fmtDT(t.createdAt)}</td>
            <td>${typeLabel[t.type] ?? t.type}</td>
            <td>${protocolLabel(t.protocol)}</td>
            <td style="text-align:right">${fmt(t.feeUsdc ?? 0, 6)}&nbsp;USDC</td>
        </tr>`).join('');
        body.innerHTML = `
            <div class="fees-table-scroll">
                <table class="wallet-detail-table">
                    <thead><tr><th>${tr('liq.col.time', 'Zeit')}</th><th>${tr('liq.col.type', 'Typ')}</th><th>${tr('liq.pool', 'Pool')}</th><th style="text-align:right">${tr('len.fee', 'Fee')}</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <table class="wallet-detail-table">
                <tfoot><tr class="wallet-detail-total">
                    <td colspan="3">Gesamt (${txs.length} TX)</td>
                    <td style="text-align:right">−${fmt(total, 6)}&nbsp;USDC</td>
                </tr></tfoot>
            </table>`;
    }
    modal.style.display = 'flex';
}

function initStatPayedFeesModal() {
    const modal = document.getElementById('statPayedFeesModal');
    if (!modal) return;
    document.getElementById('statPayedFeesModalClose')?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
}

// ── Yield-Modal ───────────────────────────────────────────────────────────────

function openStatYieldModal(period, data, b) {
    const modal = document.getElementById('statYieldModal');
    const title = document.getElementById('statYieldModalTitle');
    const body  = document.getElementById('statYieldModalBody');
    if (!modal) return;

    const labels   = { today: tr('liq.today', 'Heute'), yesterday: tr('liq.yesterday', 'Gestern'), month: tr('liq.month', 'Monat') };
    const dateLabel = period === 'today' ? b.todayDE : period === 'yesterday' ? b.yesterdayDE : b.monthDE;
    title.textContent = `Yield – ${labels[period]}: ${dateLabel}`;

    const profits = data?.statistics?.dailyProfits ?? [];
    let rows;

    if (period === 'month') {
        rows = profits.filter(p => p.date >= b.monthStartISO);
    } else {
        const iso = period === 'today' ? b.todayISO : b.yesterdayISO;
        rows = profits.filter(p => p.date === iso);
    }

    const total = rows.reduce((s, p) => s + (p.usdc ?? 0), 0);
    const fmtDate = iso => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };

    if (rows.length === 0) {
        body.innerHTML = `<p class="empty-state" style="padding:1rem">${tr('len.no_data_period', '— Keine Daten im Zeitraum')}</p>`;
    } else {
        const trs = rows.map(p => `<tr>
            <td>${fmtDate(p.date)}</td>
            <td style="text-align:right">+${fmt(p.usdc ?? 0, 4)}&nbsp;USDC</td>
        </tr>`).join('');
        body.innerHTML = `
            <div class="fees-table-scroll">
                <table class="wallet-detail-table">
                    <thead><tr><th>${tr('liq.date', 'Datum')}</th><th style="text-align:right">${tr('len.yield', 'Yield')}</th></tr></thead>
                    <tbody>${trs}</tbody>
                </table>
            </div>
            <table class="wallet-detail-table">
                <tfoot><tr class="wallet-detail-total">
                    <td>${tr('overview.total', 'Gesamt')}</td>
                    <td style="text-align:right">+${fmt(total, 4)}&nbsp;USDC</td>
                </tr></tfoot>
            </table>`;
    }
    modal.style.display = 'flex';
}

function initStatYieldModal() {
    const modal = document.getElementById('statYieldModal');
    if (!modal) return;
    document.getElementById('statYieldModalClose')?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
}

const LS_ACTIVE_COL_MODE = 'lendingbot_active_col_mode';
let _activePoolsColMode = localStorage.getItem(LS_ACTIVE_COL_MODE) ?? 'investment'; // 'investment' | 'inout1d'

// ─── Yield-Bar-Chart (Row 2 rechts) ──────────────────────────────────────────

const LS_YIELD_RANGE = 'lendingbot_chart_yield';
let _yieldRange    = localStorage.getItem(LS_YIELD_RANGE) ?? '1W';
let _yieldResizeOb = null;

const DAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/**
 * Aktiver Yield-Zeitraum. Historie-Beginn = erster Punkt der Portfolio-Historie (die Balken der
 * Tage kommen aus dailyProfits, einer festen 30-Tage-Reihe, die keinen Datenbeginn verrät).
 */
function _yieldActiveRange(data) {
    return activeRange(_yieldRange, data?.portfolioHistory ?? [], r => r.ts, DEFAULT_RANGES);
}

/**
 * Bereitet die Yield-Daten für den gewählten Zeitraum auf.
 * Rückgabe: [{label, usdc, date}]
 *   1D: rollend 24h (jetzt-24h → jetzt), 24 Stunden-Buckets, Label = HH:00 in FORGE_TZ
 *   1W: letzte 7 Tage
 *   1M: alle 30 Tage
 */
function _getYieldData(data, range) {
    if (range === '1D') {
        // 1D: rollend 24h (jetzt-24h → jetzt), 24 Stunden-Buckets, Label = HH:00 in FORGE_TZ.
        const history  = data?.portfolioHistory ?? [];
        const txns     = data?.transactions     ?? [];

        const nowMs   = Date.now();
        const startMs = rangeCutoff('1D', { now: nowMs }); // rolling 24h

        // Baseline: letzter portfolioHistory-Eintrag VOR dem 24h-Fenster.
        const preWindow = history.filter(r => r.ts < startMs);
        const baseline  = preWindow.length > 0
            ? preWindow.reduce((a, b) => a.ts > b.ts ? a : b).v
            : null;

        if (baseline === null) return [];

        // Kapitalflüsse (Deposits/Withdrawals) pro Stunden-Bucket herausrechnen.
        const hourNetFlow = new Array(24).fill(0);
        for (const tx of txns) {
            if (!tx.createdAt || tx.createdAt < startMs) continue;
            const h = Math.floor((tx.createdAt - startMs) / 3_600_000);
            if (h < 0 || h > 23) continue;
            if (tx.type === 'deposit')  hourNetFlow[h] += tx.amount ?? 0;
            if (tx.type === 'withdraw') hourNetFlow[h] -= tx.amount ?? 0;
        }

        const pts = history.filter(r => r.ts >= startMs).sort((a, b) => a.ts - b.ts);

        const hourVal = {};
        for (const pt of pts) {
            const h = Math.floor((pt.ts - startMs) / 3_600_000);
            if (h >= 0 && h <= 23 && hourVal[h] === undefined) hourVal[h] = pt.v;
        }

        // Sanity-Cap: max. 15 % APY / 24 Stunden – filtert API-Settlement-Lag
        // und fehlende TX-Einträge (analog zum Tages-Cap in export.js).
        const maxHourlyYield = baseline > 0 ? baseline * 0.15 / 365 / 24 : Infinity;

        const bars = [];
        let prevV = baseline;
        for (let h = 0; h <= 23; h++) {
            const bucketStartMs = startMs + h * 3_600_000;
            const p     = partsInTZ(bucketStartMs);
            const label = String(p.hour).padStart(2, '0') + ':00';
            const date  = `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}T${String(p.hour).padStart(2,'0')}`;
            if (hourVal[h] !== undefined) {
                const rawDelta  = hourVal[h] - prevV;
                const trueYield = rawDelta - hourNetFlow[h];
                bars.push({ label, usdc: Math.min(Math.max(0, trueYield), maxHourlyYield), date });
                prevV = hourVal[h];
            } else {
                bars.push({ label, usdc: 0, date });
            }
        }
        return bars;
    }

    // 1W / 1M: daily bars from statistics.dailyProfits
    const profits = data?.statistics?.dailyProfits ?? [];
    const days    = range === '1W' ? 7 : 30;
    const slice   = profits.slice(-days);

    return slice.map(p => {
        const d   = new Date(p.date + 'T12:00:00');
        const lbl = range === '1W' ? DAYS_DE[d.getDay()] : `${d.getDate()}.`;
        return { label: lbl, usdc: p.usdc ?? 0, date: p.date };
    });
}

/**
 * Zeichnet Yield-Balken in ein SVG-Element.
 * Identisches Muster wie _drawFeeBars in Liquidity.
 */
function _drawYieldBars(svgEl, bars, H = 160) {
    const W = svgEl.getBoundingClientRect().width || svgEl.parentElement?.clientWidth || 400;
    svgEl.setAttribute('height', H);
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const PAD_L = 58, PAD_R = 16, PAD_T = 14, PAD_B = 32;
    const cW = W - PAD_L - PAD_R;
    const cH = H - PAD_T - PAD_B;

    const values = bars.map(b => b.usdc);
    const maxVal = Math.max(...values, 0.0001);
    const yMax   = maxVal * 1.15;
    const yMin   = 0;

    const sy      = v => PAD_T + cH - ((v - yMin) / (yMax - yMin || 1)) * cH;
    const bottomY = (PAD_T + cH).toFixed(1);

    const decimals  = maxVal >= 1 ? 4 : 6;
    const gridVals  = [0, maxVal / 2, maxVal];
    const gridLines = gridVals.map(v =>
        `<line x1="${PAD_L}" y1="${sy(v).toFixed(1)}" x2="${PAD_L + cW}" y2="${sy(v).toFixed(1)}" class="${v === 0 ? 'chart-zero-line' : 'chart-grid'}"/>` +
        `<text x="${(PAD_L - 5).toFixed(1)}" y="${sy(v).toFixed(1)}" class="chart-label chart-label-y" dominant-baseline="middle">${fmt(v, decimals)}</text>`
    ).join('');

    const n    = bars.length;
    const step = cW / Math.max(n, 1);
    const barW = Math.max(3, step * 0.65);

    const rects = bars.map((b, i) => {
        const cx   = PAD_L + step * i + step / 2;
        const barH = Math.max(b.usdc > 0 ? 1 : 0, Math.abs(sy(b.usdc) - parseFloat(bottomY)));
        const barY = sy(b.usdc);
        const lblStep = b.label.includes(':') ? 3 : Math.ceil(n / Math.max(2, Math.floor(cW / 40)));
        const show    = i % lblStep === 0;
        return `<rect class="yield-bar" data-usdc="${b.usdc.toFixed(6)}" data-date="${b.date}"
            x="${(cx - barW / 2).toFixed(1)}" y="${barY.toFixed(1)}"
            width="${barW.toFixed(1)}" height="${barH.toFixed(1)}"
            fill="var(--primary)" opacity="0.82" rx="1"/>` +
            (show ? `<text x="${cx.toFixed(1)}" y="${(PAD_T + cH + 18).toFixed(1)}" class="chart-label chart-label-x" text-anchor="middle">${b.label}</text>` : '');
    }).join('');

    svgEl.innerHTML = `${gridLines}${rects}`;
}

function _yieldBarTooltipText(bar) {
    const usdc    = parseFloat(bar.dataset.usdc);
    const dateStr = bar.dataset.date;
    const isHour  = dateStr.length > 10;
    const lbl     = isHour
        ? dateStr.slice(11, 13) + ':00 Uhr'
        : makeFmt(NUM_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })
            .format(new Date(dateStr + 'T12:00:00Z')); // noon UTC → eindeutig
    return `${lbl}: ${fmt(usdc, 4)} USDC`;
}

// 1D braucht einen Portfolio-Wert VOR dem 24h-Fenster. Fehlt er bei vorhandener Historie (Konto jünger
// als 24 h), zeigt der Chart einen Hinweis statt Wochenbalken unter einer 1D-Beschriftung (LEN#000935).
function _yieldLacks24h(data, range) {
    return range === '1D' && (data?.portfolioHistory?.length ?? 0) > 0;
}
const _yieldNo24hText = () => tr('len.yield_no_24h', 'Noch keine 24 h Daten');

function renderYieldChart(data) {
    const svg      = document.getElementById('yieldChartSvg');
    const emptyMsg = document.getElementById('yieldChartEmptyMsg');
    const wrapper  = document.getElementById('yieldChartWrapper');
    if (!svg) return;

    const range = _yieldActiveRange(data);
    const bars  = _getYieldData(data, range);

    if (bars.length === 0) {
        svg.style.display      = 'none';
        if (emptyMsg) emptyMsg.textContent = data?.botActive === false ? tr('liq.no_open_positions', 'Keine offenen Positionen')
            : _yieldLacks24h(data, range) ? _yieldNo24hText()
            : tr('len.no_yield_data', 'Keine Yield-Daten vorhanden…');
        emptyMsg.style.display = 'block';
        return;
    }

    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';
    _drawYieldBars(svg, bars, 160);

    if (wrapper) attachBarTooltip(svg, wrapper, '.yield-bar', _yieldBarTooltipText);

    if (!_yieldResizeOb && typeof ResizeObserver !== 'undefined') {
        _yieldResizeOb = new ResizeObserver(() => { if (dm?.data) renderYieldChart(dm.data); });
        _yieldResizeOb.observe(svg.parentElement);
    }
}

function renderDetailYieldChart(data) {
    const svg     = document.getElementById('yieldChartModalSvg');
    const bodyEl  = document.getElementById('yieldChartModalBody');
    if (!svg || !data) return;

    const H     = svg.getBoundingClientRect().height || 380;
    const range = _yieldActiveRange(data);
    const bars  = _getYieldData(data, range);

    if (bars.length === 0) {
        const msg = _yieldLacks24h(data, range) ? _yieldNo24hText() : tr('liq.no_data_range_plain', 'Keine Daten für diesen Zeitraum');
        svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" class="chart-label" dominant-baseline="middle">${msg}</text>`;
        return;
    }

    _drawYieldBars(svg, bars, H);
    if (bodyEl) attachBarTooltip(svg, bodyEl, '.yield-bar', _yieldBarTooltipText);
}

function initYieldChartModal(getData) {
    const modal    = document.getElementById('yieldChartModal');
    const closeBtn = document.getElementById('yieldChartModalClose');
    if (!modal) return;

    const openModal = () => {
        const data = getData();
        if (!data) return;
        modal.style.display = 'flex';
        updateChartRangeBtns(
            data?.portfolioHistory ?? [], r => r.ts,
            'yieldChartModalRangeBtns',
            () => _yieldRange,
            v  => { _yieldRange = v; localStorage.setItem(LS_YIELD_RANGE, v); renderYieldChart(getData()); },
            () => renderDetailYieldChart(getData()),
            DEFAULT_RANGES
        );
        requestAnimationFrame(() => requestAnimationFrame(() => renderDetailYieldChart(getData())));
    };

    document.getElementById('yieldChartSvg')?.addEventListener('click', openModal);

    closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none';
    });
}

// ─── Transaktionen (Row 6) ────────────────────────────────────────────────────

function renderTransactions(data) {
    const listEl = document.getElementById('txList');
    const txs    = data?.transactions ?? [];

    if (txs.length === 0) {
        listEl.innerHTML = '<p class="empty-state">— Keine Transaktionen</p>';
        return;
    }

    const typeLabel = { deposit: 'Einzahlung', withdraw: 'Auszahlung', claim: 'Claim', rebalance: 'Rebalance' };

    listEl.innerHTML = txs.slice(0, 25).map(tx => {
        const hashHtml = tx.txHash
            ? `<a href="https://solscan.io/tx/${tx.txHash}" target="_blank" rel="noopener">🔗</a>`
            : '—';

        return `<div class="tx-item">
            <span class="tx-time">${fmtDateTime(tx.createdAt)}</span>
            <span class="tx-type ${tx.type ?? ''}">${typeLabel[tx.type] ?? tx.type ?? '—'}</span>
            <span class="tx-protocol tx-col-pool">${protocolLabel(tx.protocol)}</span>
            <span class="tx-amount col-r">${fmt(tx.amount)} <span style="font-size:0.75rem;color:var(--text-secondary)">${tx.asset ?? 'USDC'}</span></span>
            <span class="tx-hash col-r tx-col-hash">${hashHtml}</span>
        </div>`;
    }).join('');
}

// ─── Notifications ────────────────────────────────────────────────────────────

// Notifications-Panel entfällt – das Brief-Icon führt jetzt ins Message Center
// (nur LAN, siehe js/message-bell.js). Bot-Events stehen dort im System-Tab.

function escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ─── Pool-APY-Modal ───────────────────────────────────────────────────────────

const LS_POOL_APY_RANGE = 'lendingbot_pool_apy_range';
let _poolApyRange = localStorage.getItem(LS_POOL_APY_RANGE) ?? '1D';
let _poolApyCtx   = null;  // { protoKey, label, data }

function openPoolApyModal(protoKey, label, data) {
    _poolApyCtx = { protoKey, label, data };

    document.getElementById('poolApyModalTitle').textContent = label + tr('len.apy_hist_suffix', ' – APY-Verlauf');

    const history = (data?.apyHistory ?? []).filter(r => r[protoKey] != null);

    updateChartRangeBtns(
        history, r => r.ts,
        'poolApyRangeBtns',
        () => _poolApyRange,
        v  => { _poolApyRange = v; localStorage.setItem(LS_POOL_APY_RANGE, v); },
        ()  => renderPoolApyChart()
    );

    document.getElementById('poolApyModal').classList.remove('hidden');
    document.getElementById('poolApyModalClose').focus();
    requestAnimationFrame(() => requestAnimationFrame(() => renderPoolApyChart()));
    document.body.classList.add('modal-open');
}

function closePoolApyModal() {
    document.getElementById('poolApyModal').classList.add('hidden');
    _poolApyCtx = null;
    document.body.classList.remove('modal-open');
}

function _buildPoolLineSvg(svgEl, points, H, PAD_L, PAD_R, PAD_T, PAD_B, range, formatY) {
    const W     = svgEl.getBoundingClientRect().width || svgEl.parentElement?.clientWidth || 620;
    const cW    = W - PAD_L - PAD_R;
    const cH    = H - PAD_T - PAD_B;
    const ts    = points.map(r => r.ts);
    const vals  = points.map(r => r.v);
    const minV  = Math.max(0, Math.min(...vals) * 0.97);
    const maxV  = Math.max(...vals) * 1.03 + 0.001;
    const rangeV = maxV - minV || 1;
    const tMin  = Math.min(...ts);
    const tMax  = Math.max(...ts);
    const spanMs = tMax - tMin || 1;

    const sx = t => PAD_L + ((t - tMin) / spanMs) * cW;
    const sy = v => PAD_T + (1 - (v - minV) / rangeV) * cH;

    const gradId = `plGrad_${svgEl.id}`;
    let grid = '';
    for (let i = 0; i <= 4; i++) {
        const v = minV + (rangeV / 4) * i;
        const y = sy(v).toFixed(1);
        grid += `<line class="chart-grid" x1="${PAD_L}" x2="${(PAD_L+cW).toFixed(1)}" y1="${y}" y2="${y}"/>`;
        grid += `<text class="chart-label chart-label-y" x="${(PAD_L-5).toFixed(1)}" y="${(+y+4).toFixed(1)}">${formatY(v)}</text>`;
    }
    let xLbls = '';
    for (let i = 0; i <= 4; i++) {
        const t = tMin + spanMs * i / 4;
        xLbls += `<text class="chart-label chart-label-x" x="${sx(t).toFixed(1)}" y="${(PAD_T+cH+16).toFixed(1)}">${xLabel(t, range)}</text>`;
    }
    let line = `M ${sx(ts[0]).toFixed(1)},${sy(vals[0]).toFixed(1)}`;
    for (let i = 1; i < points.length; i++) line += ` L ${sx(ts[i]).toFixed(1)},${sy(vals[i]).toFixed(1)}`;
    const btm  = (PAD_T + cH).toFixed(1);
    const area = `${line} L ${sx(ts[ts.length-1]).toFixed(1)},${btm} L ${sx(ts[0]).toFixed(1)},${btm} Z`;
    const lx   = sx(ts[ts.length-1]).toFixed(1);
    const ly   = sy(vals[vals.length-1]).toFixed(1);

    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.setAttribute('height', H);
    svgEl.innerHTML = `
        <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="var(--primary)" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
        </linearGradient></defs>
        ${grid}${xLbls}
        <path d="${area}" fill="url(#${gradId})" stroke="none"/>
        <path d="${line}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${lx}" cy="${ly}" r="5" class="price-marker"/>
        <circle cx="${lx}" cy="${ly}" r="8" class="price-marker-ring" opacity="0.4"/>
        <text class="chart-label" x="${(+lx+10).toFixed(1)}" y="${(+ly+4).toFixed(1)}"
              fill="var(--primary)" font-size="10" font-weight="600">${formatY(vals[vals.length-1])}</text>`;

    return { tMin, tMax, spanMs, PAD_L, cW, PAD_T, cH, W, H, yMin: minV, yMax: maxV, formatY };
}

function renderPoolApyChart() {
    if (!_poolApyCtx) return;
    const { protoKey, data } = _poolApyCtx;
    const svg      = document.getElementById('poolApyChartSvg');
    const emptyMsg = document.getElementById('poolApyChartEmptyMsg');

    const history  = (data?.apyHistory ?? []).filter(r => r[protoKey] != null);
    const range    = activeRange(_poolApyRange, history, r => r.ts);
    const filtered = filterByRange(history, _poolApyRange, r => r.ts);

    if (filtered.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';

    const points = filtered.map(r => ({ ts: r.ts, v: r[protoKey] }));
    const H      = fitHeight(svg, parseInt(svg.getAttribute('height')) || 200);
    const geo    = _buildPoolLineSvg(svg, points, H, 48, 16, 16, 28, range, v => fmt(v, 1) + ' %');
    if (geo) attachHoverOverlay(svg, geo);
}

function initPoolApyModal() {
    // Click auf APY-Span → Modal öffnen (document-level, gilt für alle Container)
    document.addEventListener('click', e => {
        const span = e.target.closest('.apy-clickable[data-protocol]');
        if (!span) return;
        openPoolApyModal(span.dataset.protocol, span.dataset.label, dm.data);
    });

    // Modal schließen
    document.getElementById('poolApyModalClose')?.addEventListener('click', closePoolApyModal);
    document.getElementById('poolApyModal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closePoolApyModal();  // Klick auf Backdrop
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closePoolApyModal();
            closePoolTvlModal();
            closePoolLiqModal();
            closePoolTxModal();
        }
    });
}

// ─── Pool-TVL-Modal ───────────────────────────────────────────────────────────

const LS_POOL_TVL_RANGE = 'lendingbot_pool_tvl_range';
let _poolTvlRange = localStorage.getItem(LS_POOL_TVL_RANGE) ?? '1D';
let _poolTvlCtx   = null;  // { protoKey, label, data }

function openPoolTvlModal(protoKey, label, data) {
    _poolTvlCtx = { protoKey, label, data };

    document.getElementById('poolTvlModalTitle').textContent = label + tr('len.tvl_hist_suffix', ' – TVL-Verlauf');

    const history = (data?.tvlHistory ?? []).filter(r => r[protoKey] != null);

    updateChartRangeBtns(
        history, r => r.ts,
        'poolTvlRangeBtns',
        () => _poolTvlRange,
        v  => { _poolTvlRange = v; localStorage.setItem(LS_POOL_TVL_RANGE, v); },
        ()  => renderPoolTvlChart()
    );

    document.getElementById('poolTvlModal').classList.remove('hidden');
    document.getElementById('poolTvlModalClose').focus();
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => requestAnimationFrame(() => renderPoolTvlChart()));
}

function closePoolTvlModal() {
    document.getElementById('poolTvlModal').classList.add('hidden');
    _poolTvlCtx = null;
    document.body.classList.remove('modal-open');
}

function renderPoolTvlChart() {
    if (!_poolTvlCtx) return;
    const { protoKey, data } = _poolTvlCtx;
    const svg      = document.getElementById('poolTvlChartSvg');
    const emptyMsg = document.getElementById('poolTvlChartEmptyMsg');

    const history  = (data?.tvlHistory ?? []).filter(r => r[protoKey] != null);
    const range    = activeRange(_poolTvlRange, history, r => r.ts);
    const filtered = filterByRange(history, _poolTvlRange, r => r.ts);

    if (filtered.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';

    const points = filtered.map(r => ({ ts: r.ts, v: r[protoKey] }));
    const H      = fitHeight(svg, parseInt(svg.getAttribute('height')) || 200);
    const geo    = _buildPoolLineSvg(svg, points, H, 62, 16, 16, 28, range, v => fmtTvl(v));
    if (geo) attachHoverOverlay(svg, geo);
}

function initPoolTvlModal() {
    // Click auf TVL-Span → Modal öffnen (document-level, gilt für alle Container)
    document.addEventListener('click', e => {
        const span = e.target.closest('.tvl-clickable[data-protocol]');
        if (!span) return;
        openPoolTvlModal(span.dataset.protocol, span.dataset.label, dm.data);
    });

    document.getElementById('poolTvlModalClose')?.addEventListener('click', closePoolTvlModal);
    document.getElementById('poolTvlModal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closePoolTvlModal();
    });
}

// ─── Pool-Liquiditäts-Modal ──────────────────────────────────────────────────
//
// Baugleich zum TVL-Modal: die Liquidität ist die zweite Kennzahl, an der ein
// Schutz hängt — ihr Verlauf muss genauso nachvollziehbar sein wie der TVL-Verlauf.

const LS_POOL_LIQ_RANGE = 'lendingbot_pool_liq_range';
let _poolLiqRange = localStorage.getItem(LS_POOL_LIQ_RANGE) ?? '1D';
let _poolLiqCtx   = null;  // { protoKey, label, data }

function openPoolLiqModal(protoKey, label, data) {
    _poolLiqCtx = { protoKey, label, data };

    document.getElementById('poolLiqModalTitle').textContent = label + tr('len.liq_hist_suffix', ' – Liquiditäts-Verlauf');

    const history = (data?.liqHistory ?? []).filter(r => r[protoKey] != null);

    updateChartRangeBtns(
        history, r => r.ts,
        'poolLiqRangeBtns',
        () => _poolLiqRange,
        v  => { _poolLiqRange = v; localStorage.setItem(LS_POOL_LIQ_RANGE, v); },
        ()  => renderPoolLiqChart()
    );

    document.getElementById('poolLiqModal').classList.remove('hidden');
    document.getElementById('poolLiqModalClose').focus();
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => requestAnimationFrame(() => renderPoolLiqChart()));
}

function closePoolLiqModal() {
    document.getElementById('poolLiqModal').classList.add('hidden');
    _poolLiqCtx = null;
    document.body.classList.remove('modal-open');
}

function renderPoolLiqChart() {
    if (!_poolLiqCtx) return;
    const { protoKey, data } = _poolLiqCtx;
    const svg      = document.getElementById('poolLiqChartSvg');
    const emptyMsg = document.getElementById('poolLiqChartEmptyMsg');

    const history  = (data?.liqHistory ?? []).filter(r => r[protoKey] != null);
    const range    = activeRange(_poolLiqRange, history, r => r.ts);
    const filtered = filterByRange(history, _poolLiqRange, r => r.ts);

    if (filtered.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';

    const points = filtered.map(r => ({ ts: r.ts, v: r[protoKey] }));
    const H      = fitHeight(svg, parseInt(svg.getAttribute('height')) || 200);
    const geo    = _buildPoolLineSvg(svg, points, H, 62, 16, 16, 28, range, v => fmtLiquidity(v));
    if (geo) attachHoverOverlay(svg, geo);
}

function initPoolLiqModal() {
    document.addEventListener('click', e => {
        const span = e.target.closest('.liq-clickable[data-protocol]');
        if (!span) return;
        openPoolLiqModal(span.dataset.protocol, span.dataset.label, dm.data);
    });

    document.getElementById('poolLiqModalClose')?.addEventListener('click', closePoolLiqModal);
    document.getElementById('poolLiqModal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closePoolLiqModal();
    });
}

// ─── Pool-InOut-Modal (In-/Out-Klick in Operative Metriken) ──────────────────

const LS_POOL_INOUT_RANGE = 'lendingbot_pool_inout_range';
let _poolInOutRange  = localStorage.getItem(LS_POOL_INOUT_RANGE) ?? '1D';
let _poolInOutProto  = null;
let _poolInOutLabel  = null;

function openPoolInOutModal(proto, label, data) {
    _poolInOutProto = proto;
    _poolInOutLabel = label;
    document.getElementById('poolInOutModalTitle').textContent = label + tr('len.inout_suffix', ' – Ein-/Auszahlungen');
    _renderPoolInOutRangeBtns(data);
    document.getElementById('poolInOutModal').classList.remove('hidden');
    document.getElementById('poolInOutModalClose').focus();
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => requestAnimationFrame(() => _renderPoolInOutChart(data)));
}

function closePoolInOutModal() {
    document.getElementById('poolInOutModal').classList.add('hidden');
    document.body.classList.remove('modal-open');
}

/** Historie des Pools (Reihe der APY-Werte): bestimmt, welche Zeiträume der Ein-/Auszahlungs-Chart freigibt. */
function _poolInOutHistory(data) {
    return (data?.apyHistory ?? []).filter(r => r[_poolInOutProto] != null);
}

function _getInOutBars(proto, txns, range) {
    const cutoff = rangeCutoff(range);
    const relevant = (txns ?? []).filter(t =>
        t.protocol === proto && t.createdAt >= cutoff &&
        (t.type === 'deposit' || t.type === 'withdraw'));

    if (range === '1D') {
        return Array.from({ length: 24 }, (_, h) => {
            const bucketStart = cutoff + h * 3_600_000;
            const bucketEnd   = bucketStart + 3_600_000;
            const bTxs = relevant.filter(t => t.createdAt >= bucketStart && t.createdAt < bucketEnd);
            const net  = bTxs.reduce((s, t) => s + (t.type === 'deposit' ? t.amount : -t.amount), 0);
            const p    = partsInTZ(bucketStart);
            return { label: String(p.hour).padStart(2,'0') + ':00', net };
        });
    }

    const days = range === '1W' ? 7 : 30;
    const todayMs = berlinPeriodBounds().todayMs;
    return Array.from({ length: days }, (_, i) => {
        const dayStart = todayMs - (days - 1 - i) * 86_400_000;
        const dayEnd   = dayStart + 86_400_000;
        const bTxs     = relevant.filter(t => t.createdAt >= dayStart && t.createdAt < dayEnd);
        const net      = bTxs.reduce((s, t) => s + (t.type === 'deposit' ? t.amount : -t.amount), 0);
        const d        = new Date(dayStart + 43_200_000);
        const label    = range === '1W' ? DAYS_DE[d.getDay()] : `${d.getDate()}.`;
        return { label, net };
    });
}

function _drawInOutBars(svgEl, bars, H = 200) {
    const W = svgEl.getBoundingClientRect().width || svgEl.parentElement?.clientWidth || 400;
    svgEl.setAttribute('height', H);
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const PAD_L = 58, PAD_R = 16, PAD_T = 14, PAD_B = 32;
    const cW = W - PAD_L - PAD_R;
    const cH = H - PAD_T - PAD_B;

    const nets   = bars.map(b => b.net);
    const maxVal = Math.max(...nets,  0.0001);
    const minVal = Math.min(...nets, -0.0001);
    const span   = maxVal - minVal;
    const yMax   = maxVal + span * 0.12;
    const yMin   = minVal - span * 0.12;

    const sy      = v => PAD_T + cH - ((v - yMin) / (yMax - yMin || 1)) * cH;
    const zeroY   = sy(0).toFixed(1);
    const decimals = Math.max(...nets.map(v => Math.abs(v))) >= 1 ? 2 : 4;

    const gridVals = [minVal < 0 ? minVal : null, 0, maxVal > 0 ? maxVal : null].filter(v => v !== null);
    const gridLines = [...new Set(gridVals)].map(v =>
        `<line x1="${PAD_L}" y1="${sy(v).toFixed(1)}" x2="${PAD_L+cW}" y2="${sy(v).toFixed(1)}" class="${v===0 ? 'chart-zero-line' : 'chart-grid'}"/>` +
        `<text x="${(PAD_L-5).toFixed(1)}" y="${sy(v).toFixed(1)}" class="chart-label chart-label-y" dominant-baseline="middle">${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), decimals)}</text>`
    ).join('');

    const n = bars.length;
    const step = cW / Math.max(n, 1);
    const barW = Math.max(3, step * 0.65);
    const lblStep = bars[0]?.label?.includes(':') ? 3 : Math.ceil(n / Math.max(2, Math.floor(cW / 40)));

    const rects = bars.map((b, i) => {
        const cx    = PAD_L + step * i + step / 2;
        const isPos = b.net >= 0;
        const top   = sy(b.net);
        const barH  = Math.max(b.net !== 0 ? 1 : 0, Math.abs(top - parseFloat(zeroY)));
        const barY  = isPos ? top : parseFloat(zeroY);
        const fill  = isPos ? 'var(--color-positive, #4caf79)' : 'var(--color-negative, #e05252)';
        const show  = i % lblStep === 0;
        return `<rect class="inout-bar" data-net="${b.net.toFixed(4)}" data-label="${b.label}"
            x="${(cx-barW/2).toFixed(1)}" y="${barY.toFixed(1)}"
            width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${fill}" opacity="0.82" rx="1"/>` +
            (show ? `<text x="${cx.toFixed(1)}" y="${(PAD_T+cH+18).toFixed(1)}" class="chart-label chart-label-x" text-anchor="middle">${b.label}</text>` : '');
    }).join('');

    svgEl.innerHTML = `${gridLines}${rects}`;
}

function _inOutBarTooltipText(bar) {
    const net   = parseFloat(bar.dataset.net);
    const label = bar.dataset.label ?? '';
    const sign  = net >= 0 ? '+' : '−';
    return `${label}: ${sign}${fmt(Math.abs(net), 4)} USDC`;
}

function _renderPoolInOutChart(data) {
    const svgEl    = document.getElementById('poolInOutChartSvg');
    const emptyMsg = document.getElementById('poolInOutChartEmptyMsg');
    if (!svgEl || !_poolInOutProto) return;

    const bars    = _getInOutBars(_poolInOutProto, data?.transactions, activeRange(_poolInOutRange, _poolInOutHistory(data), r => r.ts, DEFAULT_RANGES));
    const hasData = bars.some(b => b.net !== 0);

    svgEl.style.display    = hasData ? '' : 'none';
    emptyMsg.style.display = hasData ? 'none' : '';
    if (hasData) {
        _drawInOutBars(svgEl, bars);
        const wrapper = svgEl.closest('.chart-wrapper') ?? svgEl.parentElement;
        if (wrapper) attachBarTooltip(svgEl, wrapper, '.inout-bar', _inOutBarTooltipText);
    }
}

function _renderPoolInOutRangeBtns(data) {
    updateChartRangeBtns(
        _poolInOutHistory(data), r => r.ts,
        'poolInOutRangeBtns',
        () => _poolInOutRange,
        v  => { _poolInOutRange = v; localStorage.setItem(LS_POOL_INOUT_RANGE, v); },
        ()  => _renderPoolInOutChart(dm.data),   // dm.data statt data: die Leiste wird nur einmal angelegt
        DEFAULT_RANGES
    );
}

function initPoolInOutModal() {
    // Select-Box in Operative Metriken (event delegation)
    document.addEventListener('change', e => {
        if (e.target.id !== 'activePoolsColSelect') return;
        _activePoolsColMode = e.target.value;
        localStorage.setItem(LS_ACTIVE_COL_MODE, _activePoolsColMode);
        if (dm?.data) renderActivePools(dm.data);
    });

    // Click auf inout-clickable → Modal öffnen
    document.addEventListener('click', e => {
        const span = e.target.closest('.inout-clickable[data-protocol]');
        if (!span) return;
        openPoolInOutModal(span.dataset.protocol, span.dataset.label, dm.data);
    });

    document.getElementById('poolInOutModalClose')?.addEventListener('click', closePoolInOutModal);
    document.getElementById('poolInOutModal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closePoolInOutModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !document.getElementById('poolInOutModal')?.classList.contains('hidden'))
            closePoolInOutModal();
    });
}

// ─── Tooltip-System ───────────────────────────────────────────────────────────

function initTooltips() {
    const tooltip  = document.getElementById('forgeTooltip');
    const titleEl  = document.getElementById('forgeTooltipTitle');
    const bodyEl   = document.getElementById('forgeTooltipBody');

    // Event-Delegation: funktioniert auch für dynamisch gerenderte Cards
    document.addEventListener('mouseover', e => {
        const el = e.target.closest('.has-tooltip');
        if (!el) return;
        const content = el.dataset.tooltipContent ?? '';
        titleEl.textContent = el.dataset.tooltipTitle ?? '';
        const isTable = content.includes('<table');
        if (isTable) {
            tooltip.style.maxWidth = '550px';
            tooltip.style.minWidth = '300px';
        } else {
            tooltip.style.maxWidth = '';
            tooltip.style.minWidth = '';
        }
        bodyEl.innerHTML = isTable ? content : escHtml(content);
        tooltip.style.display = 'block';
        moveTooltip(e);
    });
    document.addEventListener('mousemove', e => {
        if (tooltip.style.display !== 'none') moveTooltip(e);
    });
    document.addEventListener('mouseout', e => {
        const el = e.target.closest('.has-tooltip');
        if (el && (!e.relatedTarget || !el.contains(e.relatedTarget))) {
            tooltip.style.display = 'none';
        }
    });

    function moveTooltip(e) {
        const margin = 16;
        let x = e.clientX + margin;
        let y = e.clientY + margin;
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        if (x + tw > window.innerWidth)  x = e.clientX - tw - margin;
        if (y + th > window.innerHeight) y = e.clientY - th - margin;
        tooltip.style.left = x + 'px';
        tooltip.style.top  = y + 'px';
    }
}

// ─── Notification Panel ───────────────────────────────────────────────────────

// Brief-Icon → Message Center (nur LAN). Verdrahtung zentral in js/message-bell.js.

// ─── Main Render ──────────────────────────────────────────────────────────────

function render(data) {
    setPoolMeta(data);
    renderStatus(data);
    if (!data) return;

    renderMetrics(data);

    // Range-Buttons dynamisch aufbauen (vor Chart-Render, damit Range ggf. resettet wird)
    updateChartRangeBtns(
        data?.balanceHistory ?? [], r => r.ts,
        'portfolioRangeBtns',
        () => portfolioRange,
        v  => { portfolioRange = v; localStorage.setItem(LS_PORTFOLIO_RANGE, v); },
        ()  => { if (dm.data) renderPortfolioChart(dm.data); }
    );

    updateChartRangeBtns(
        data?.portfolioHistory ?? [], r => r.ts,
        'yieldRangeBtns',
        () => _yieldRange,
        v  => { _yieldRange = v; localStorage.setItem(LS_YIELD_RANGE, v); },
        ()  => { if (dm.data) renderYieldChart(dm.data); },
        DEFAULT_RANGES
    );

    renderPortfolioChart(data);
    renderYieldChart(data);
    renderAvailablePools(data);
    renderActivePools(data);
    renderStatistics(data);
    renderPendingWithdrawals(data);
    renderTransactions(data);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

const dm = new DataManager();
dm.addListener(data => render(data));
// earningsToast pollt selbstständig via startPolling()


// ─── Checkbox: Inaktive Pools anzeigen ────────────────────────────────────────

function initInactiveToggle() {
    const cb = document.getElementById('showInactivePools');
    if (!cb) return;
    // Gespeicherten Zustand wiederherstellen
    cb.checked = localStorage.getItem('lendingbot_show_inactive') === 'true';
    cb.addEventListener('change', () => {
        localStorage.setItem('lendingbot_show_inactive', cb.checked);
        if (dm.data) renderPositions(dm.data);
    });
}

initNav({ current: 'lending-dashboard' });
initFooter({ botName: 'LendingBot' });

document.addEventListener('DOMContentLoaded', () => {
    initTooltips();
    initMessageBell();
    initPoolApyModal();
    initPoolTvlModal();
    initPoolLiqModal();
    initPoolInOutModal();
    initInactiveToggle();
    initWalletDetailModal(() => dm.data, {
        solPriceUsd: data => data?.portfolio?.solPrice ?? null,
    });
    initGebundenModal(() => dm.data);
    initPortfolioChartModal(() => dm.data);
    initYieldChartModal(() => dm.data);
    initStatPayedFeesModal();
    initStatYieldModal();
    // Maximieren-Schalter für alle Dialoge; der Callback zeichnet Charts mit der neuen Fläche neu.
    wireMaximize({
        poolApyModal:        () => renderPoolApyChart(),
        poolTvlModal:        () => renderPoolTvlChart(),
        poolLiqModal:        () => renderPoolLiqChart(),
        poolInOutModal:      () => { if (dm.data) _renderPoolInOutChart(dm.data); },
        portfolioChartModal: () => { if (dm.data) renderDetailPortfolioChart(dm.data); },
        yieldChartModal:     () => { if (dm.data) renderDetailYieldChart(dm.data); },
        gebundenModal:       null,
        walletDetailModal:   null,
        statPayedFeesModal:  null,
        statYieldModal:      null,
    });
    dm.start();
});

// Charts neu rendern wenn Fenstergröße ändert (Debounced)
let _resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
        if (dm.data) {
            renderPortfolioChart(dm.data);
            renderYieldChart(dm.data);
            const pModal = document.getElementById('portfolioChartModal');
            if (pModal && pModal.style.display !== 'none') renderDetailPortfolioChart(dm.data);
            const yModal = document.getElementById('yieldChartModal');
            if (yModal && yModal.style.display !== 'none') renderDetailYieldChart(dm.data);
        }
    }, 200);
});

// Pending-Withdrawal-Countdown + Rebalance-Badge jede Minute aktualisieren
setInterval(() => {
    if (dm.data?.pendingWithdrawals?.length) {
        renderPendingWithdrawals(dm.data);
    }
}, 60_000);
