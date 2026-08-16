/**
 * LiquidityMiningBot3 – Dashboard App
 * V3 CLMM Pools (Orca Whirlpools, Raydium CLMM)
 *
 * Prototyp – Detailimplementierung folgt nach Bot-Fertigstellung.
 */

import { initNav, initFooter, setLastUpdate } from '../../js/nav.js?v=20260816a';
// Sprache. Bewusst als `tr` importiert und nicht als `t`: `t` ist in dieser Datei
// durchgängig ein Timestamp (57 Fundstellen) – ein gleichnamiger Import wäre eine
// Verwechslungsfalle. bin/i18n-check.js kennt beide Namen.
import { t as tr, NUM_LOCALE } from '../../js/i18n.js?v=20260811a';
import { filterOutliers, filterSpikes, attachHoverOverlay, attachBarTooltip } from '../../js/chart.js?v=20260609a';
import { startOfDayMs }                        from '../../js/tz.js?v=20260414a';
import { EarningsToast }                       from '../../js/earnings-toast.js?v=20260720a';
import { ToastManager }                        from '../../js/toast.js?v=20260809a';
import { initMessageBell }                     from '../../js/message-bell.js?v=20260816a';
import { initWalletDetailModal }               from '../../js/wallet-detail-modal.js?v=20260807a';
import { loadTokenInfo, getTokenInfo }         from './token-info-store.js?v=20260727a';
import { renderBotInactivePanel, removeBotInactivePanel } from '../../js/bot-inactive-panel.js?v=20260807a';

'use strict';

const DATA_URL      = 'data/data.json';
const HISTORY_URL   = 'data/data-history.json';
const REFRESH_MS    = 60 * 1000;  // jede Minute
const earningsToast    = new EarningsToast();
earningsToast.startPolling('data/data.json', null);

const rebalanceToast = new ToastManager({
    storageKey: 'liquiditybot_rebalance_lastToastTs',
    muteKey:    'liquiditybot_rebalance_toastMuted',
    panelId:    'notifPanel',
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

// Pool-Name wie auf Orca anzeigen (displayPair aus pools.json), nicht DB-pair.
//
// WICHTIG für alle UI-Beschriftungen mit Pool-Namen:
//   - `pos.pair` / `pool.pair` ist das INTERNE Pair, entsprechend tokenA/tokenB-
//     Reihenfolge auf der Chain. Wird für Datenfilterung, data-pool-pair-Attribute
//     und Spalten-Labels von amountA/amountB-Werten verwendet.
//   - `displayPair` ist die UI-Schreibweise (wie auf Orca). Pools können hier
//     vertauschte Token-Reihenfolge haben (z.B. pair="SOL/HYPE" → display="HYPE/SOL").
//
// Faustregel: JEDER user-sichtbare Pool-Name (Modal-Titel, Toast, Tooltip-Text,
// Notification-Label) MUSS durch displayPairOf() laufen. Direktes Einsetzen von
// pos.pair in einen Text führt bei flipped-Pools zu falsch herum stehenden Namen
// — historischer Bug (2026-05-19) betraf TVL/VOL/Composition/Fee-Claims-/Range-
// Modals + Pool-Tx-Liste.
function displayPairOf(data, pair) {
    return data?.positions?.find(p => p.pair === pair)?.displayPair
        ?? data?.pools?.find(p => p.pair === pair)?.displayPair
        ?? pair;
}

function fmtUsdc(v, dec = 2) {
    if (v == null) return '—';
    return Number(v).toLocaleString(NUM_LOCALE, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtPct(v, dec = 2) {
    if (v == null) return '—';
    const sign = v >= 0 ? '+' : '';
    return sign + Number(v).toLocaleString(NUM_LOCALE, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '\u202f%';
}

function fmtPrice(v, dec = 4) {
    if (v == null) return '—';
    return Number(v).toLocaleString(NUM_LOCALE, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtTs(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())} Uhr`;
}

/** Wie fmtTs, aber gibt HTML mit separaten date/time-Spans zurück.
 *  data-age="today|yesterday|older" steuert CSS-Ausblendung im Hochformat. */
function fmtTsHtml(ts) {
    if (!ts) return '<span class="tx-ts">—</span>';
    const d   = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}`;
    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())} Uhr`;
    const now           = new Date();
    const todayStart    = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86_400_000;
    const age = +d >= todayStart ? 'today' : +d >= yesterdayStart ? 'yesterday' : 'older';
    return `<span class="tx-ts" data-age="${age}"><span class="tx-ts-date">${dateStr}</span>\u202f<span class="tx-ts-time">${timeStr}</span></span>`;
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setVal(id, val) {
    const el = $(id);
    if (el) el.textContent = val ?? '—';
}

// ── Tx-Detail-Tooltip ─────────────────────────────────────────────────────────

// Tooltip für Transaktions-Mengen.
//
// Frühere Versionen versuchten pro Token einen USD-Gegenwert zu berechnen,
// haben dabei aber A=SOL und B=USDC hardcoded — was nur für SOL/USDC stimmt.
// Bei allen anderen Pools (HYPE/SOL, ZEC/USDC, cbBTC/USDC, …) standen falsche
// Beträge in der „Gegenwert"-Spalte. Wir zeigen jetzt nur die Coin-Mengen
// mit korrekten Labels (in displayPair-Reihenfolge, von export.js geliefert);
// der USD-Gesamtbetrag steht in der Hauptspalte der TX-Zeile und als Summe
// im Tooltip.
function buildTxAmountTooltip(tx, solPrice = 0) {
    if (tx.amountA == null && tx.amountB == null) return null;
    const tokens = tx.pool?.split('/') ?? [tr('liq.token_a', 'Token A'), tr('liq.token_b', 'Token B')];
    const tokenA = tokens[0] ?? tr('liq.token_a', 'Token A');
    const tokenB = tokens[1] ?? tr('liq.token_b', 'Token B');
    const time   = fmtTs(tx.createdAt);
    const rows   = [];

    if (tx.amountA != null) {
        rows.push(
            `<tr>` +
            `<td>${escHtml(time)}</td>` +
            `<td>${escHtml(tokenA)}</td>` +
            `<td style="text-align:right;padding-left:12px">${fmtPrice(tx.amountA, 6)}</td>` +
            `</tr>`);
    }
    if (tx.amountB != null) {
        rows.push(
            `<tr>` +
            `<td>${escHtml(time)}</td>` +
            `<td>${escHtml(tokenB)}</td>` +
            `<td style="text-align:right;padding-left:12px">${fmtPrice(tx.amountB, 6)}</td>` +
            `</tr>`);
    }
    if (rows.length === 0) return null;

    const totalRow = tx.amount != null
        ? `<tr style="border-top:1px solid rgba(255,255,255,0.15);font-weight:600">` +
          `<td colspan="2">Gesamt</td>` +
          `<td style="text-align:right;padding-left:12px">${fmtUsdc(tx.amount)}\u202fUSDC</td>` +
          `</tr>`
        : '';

    return `<table>` +
        `<tr style="border-bottom:1px solid rgba(255,255,255,0.15)">` +
        `<td style="font-weight:600">Zeit</td>` +
        `<td style="font-weight:600">${tr('liq.coin', 'Coin')}</td>` +
        `<td style="font-weight:600;text-align:right;padding-left:12px">${tr('liq.quantity', 'Menge')}</td>` +
        `</tr>` +
        rows.join('') +
        totalRow +
        `</table>`;
}

async function loadData() {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const v = Date.now();
            const [rLive, rHist] = await Promise.all([
                fetch(DATA_URL   + '?v=' + v, { cache: 'no-store' }),
                fetch(HISTORY_URL + '?v=' + v, { cache: 'no-store' }),
            ]);
            if (!rLive.ok) { if (attempt === 0) { await new Promise(ok => setTimeout(ok, 5000)); continue; } return null; }
            const live = await rLive.json();
            if (rHist.ok) {
                try { Object.assign(live, await rHist.json()); } catch { /* history parse failed, continue without */ }
            }
            return live;
        } catch { if (attempt === 0) { await new Promise(ok => setTimeout(ok, 5000)); continue; } return null; }
    }
    return null;
}

// ── APR-Card ──────────────────────────────────────────────────────────────────

function renderRendite(p) {
    const renditeEl    = $('renditeValue');
    const renditeGroup = $('renditeGroup');
    if (!renditeEl) return;
    const apr = p.avgApr ?? null;
    if (apr != null) {
        const sign = apr >= 0 ? '+' : '−';
        renditeEl.textContent = sign + Math.abs(apr).toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (renditeGroup) renditeGroup.setAttribute('data-type', apr > 0 ? 'positive' : 'neutral');
    } else {
        renditeEl.textContent = '0,00';
        if (renditeGroup) renditeGroup.setAttribute('data-type', 'neutral');
    }
}

// ── Metriken rendern ──────────────────────────────────────────────────────────

function renderMetrics(data) {
    const p      = data?.portfolio ?? {};
    const wmSnap = data?.walletMonitor?.snapshot ?? null;

    // Wallet: Wallet-Monitor bevorzugen, Fallback auf portfolio.walletValueUsd
    const freeWallet = wmSnap ? wmSnap.total_usd : (p.walletValueUsd ?? 0);
    const walletEl = $('walletValue');
    if (walletEl) walletEl.textContent = fmtUsdc(freeWallet);

    // Gesamt: LP + Fees + Wallet (balance)
    const gesamt = p.balance ?? 0;
    const gesEl = $('gesamtValue');
    if (gesEl) gesEl.textContent = fmtUsdc(gesamt);

    // PnL (24h): server-seitig berechnet (calcPnl, kapitalfluss-korrigiert).
    // Fallback auf client-seitige Methode wenn Wert noch fehlt (alte JSON-Version).
    const pnl24h    = data.portfolio?.pnl24h ?? calcPortfolioPnl24h(data);
    const pnl24hEl  = $('pnl24hValue');
    const pnl24hUnit = $('pnl24hUnit');
    if (pnl24hEl) {
        // Rundet auf die angezeigten 2 Nachkommastellen, bevor entschieden wird, ob
        // Vorzeichen/Farbe gezeigt werden (Fund 2026-08-07): ein winziger Rest-Wert wie
        // 0,00003 zeigte bisher "+0,00 USDC" in Grün — sieht wie ein Darstellungsfehler
        // aus. Rundet der Wert auf 0,00, gilt er als neutral: kein Vorzeichen, keine Farbe.
        const rounded = pnl24h != null ? Math.round(pnl24h * 100) / 100 : 0;
        if (pnl24h != null && rounded !== 0) {
            const sign = pnl24h >= 0 ? '+' : '−';
            pnl24hEl.textContent = sign + fmtUsdc(Math.abs(pnl24h));
            const dtype = pnl24h >= 0 ? 'positive' : 'negative';
            pnl24hEl.setAttribute('data-type', dtype);
            if (pnl24hUnit) pnl24hUnit.setAttribute('data-type', dtype);
        } else {
            pnl24hEl.textContent = '0,00';
            pnl24hEl.setAttribute('data-type', 'neutral');
            if (pnl24hUnit) pnl24hUnit.setAttribute('data-type', 'neutral');
        }
    }

    // Rendite: Summe geclaimter Fees (immer positiv) – Selector: Heute / Gestern / Monat
    renderRendite(p);
}

// ── PnL-24h-Modal ─────────────────────────────────────────────────────────────

function calcPortfolioPnl24h(data) {
    const history = data?.portfolioHistory ?? [];
    if (history.length < 2) return null;
    const WINDOW_MS = 24 * 3600 * 1000;
    const last = history[history.length - 1];
    const target = last.t - WINDOW_MS;
    let baseIdx = -1;
    for (let i = 0; i < history.length - 1; i++) {
        if (history[i].t <= target) baseIdx = i;
        else break;
    }
    if (baseIdx < 0) return null;
    return last.v - history[baseIdx].v;
}

// ── Gemeinsamer Pool-Sortierschlüssel ─────────────────────────────────────────
// Wird von renderPools, renderOpportunity und renderPositions verwendet,
// damit alle drei Tabellen identische Reihenfolge zeigen.
// Reihenfolge: 1. investScore.value (desc), 2. sortRank (asc, trägt Tier+rankPos),
//              3. displayPair alphabetisch als absoluter Notfallfall.
function poolSortKey(investScore, sortRank, displayPair) {
    return {
        score:    investScore?.value ?? -Infinity,
        rank:     sortRank           ?? 9999,
        pair:     displayPair        ?? '',
    };
}
function comparePoolSortKeys(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (a.rank  !== b.rank)  return a.rank  - b.rank;
    return a.pair.localeCompare(b.pair);
}

// ── Pool Metriken ─────────────────────────────────────────────────────────────

function fmtTvl(n) {
    if (n == null || isNaN(n) || n <= 0) return '—';
    if (n >= 1_000_000) return fmtUsdc(n / 1_000_000, 1) + '\u202fM';
    if (n >= 1_000)     return fmtUsdc(n / 1_000, 0) + '\u202fK';
    return fmtUsdc(n, 0);
}

function fmtVol(n) {
    if (n == null || isNaN(n) || n <= 0) return '—';
    if (n >= 1_000_000) return fmtUsdc(n / 1_000_000, 1) + '\u202fM';
    if (n >= 1_000)     return fmtUsdc(n / 1_000, 0) + '\u202fK';
    return fmtUsdc(n, 0);
}

const LS_APR_COL = 'liquiditybot_apr_col_mode';
let _aprColMode   = localStorage.getItem(LS_APR_COL) ?? 'apr';

// Opportunity: Timeframe-Wahl + Pool-Filter + Suche
const LS_OPP_POOL_FILTER  = 'liquiditybot_opp_pool_filter';
let _oppPoolFilter = localStorage.getItem(LS_OPP_POOL_FILTER) ?? 'all';

const LS_OPP_TYPE_FILTER = 'liquiditybot_opp_type_filter';
let _oppTypeFilter = localStorage.getItem(LS_OPP_TYPE_FILTER) ?? 'all';

// Kurzlabels für poolType (config/pools.json), siehe auch _typeInfo im InvestScore-Modal
// für die ausführlichen Erklärtexte je Typ.
const POOL_TYPE_LABELS = {
    rebalance_free: 'Rebalance-frei',
    volatil_1:      tr('liq.vol_low', 'Gering volatil'),
    volatil_2:      tr('liq.vol_mid', 'Mittel volatil'),
    volatil_3:      tr('liq.vol_high', 'Stark volatil'),
    rwa:            'RWA',
};

const LS_OPP_SEARCH = 'liquiditybot_opp_search';
let _oppSearchQuery = localStorage.getItem(LS_OPP_SEARCH) ?? '';

const LS_OPP_PNL_MODE = 'liquiditybot_opp_pnl_mode';
let _oppPnlMode = (localStorage.getItem(LS_OPP_PNL_MODE) === 'sim') ? 'sim' : 'hist';

// Pool Metriken: Wahl der APR-Spalte (24h / 1h) — persistent in localStorage
const LS_POOLS_APR_TF = 'liquiditybot_pools_apr_tf';
let _poolsAprTf = localStorage.getItem(LS_POOLS_APR_TF) === '1h' ? '1h' : '24h';

// Pool Metriken: Pool-Filter (alle / nur aktive) — persistent in localStorage
const LS_POOLS_VIS_FILTER = 'liquiditybot_pools_vis_filter';
let _poolsVisFilter = localStorage.getItem(LS_POOLS_VIS_FILTER) === 'active' ? 'active' : 'all';

// Pool Metriken: Suchfilter — persistent in localStorage
const LS_POOLS_SEARCH = 'liquiditybot_pools_search';
let _poolsSearchQuery = localStorage.getItem(LS_POOLS_SEARCH) ?? '';

// Operative Metriken: Suchfilter — persistent in localStorage
const LS_ACTIVE_SEARCH = 'liquiditybot_active_search';
let _activeSearchQuery = localStorage.getItem(LS_ACTIVE_SEARCH) ?? '';

// Pool Metriken: Sortierspalte (APR/VOL/TVL) + Richtung — persistent in localStorage
// (null = Standard nach InvestScore)
const LS_POOLS_SORT_COL = 'liquiditybot_pools_sort_col';
const LS_POOLS_SORT_DIR = 'liquiditybot_pools_sort_dir';
const _POOLS_SORT_COLS  = new Set(['apr', 'vol', 'tvl']);
let _poolsSortCol = _POOLS_SORT_COLS.has(localStorage.getItem(LS_POOLS_SORT_COL))
    ? localStorage.getItem(LS_POOLS_SORT_COL) : null;
let _poolsSortDir = (localStorage.getItem(LS_POOLS_SORT_DIR) === 'asc') ? 'asc' : 'desc';

// Opportunity-Tabelle: aktive Sortierspalte + Richtung (null = Standard nach Score)
const LS_OPP_SORT_COL = 'liquiditybot_opp_sort_col';
const LS_OPP_SORT_DIR = 'liquiditybot_opp_sort_dir';
const _OPP_SORT_COLS  = new Set(['score','pnl','priceSlope','aprSlope','tvlSlope']);
let _oppSortCol = _OPP_SORT_COLS.has(localStorage.getItem(LS_OPP_SORT_COL))
    ? localStorage.getItem(LS_OPP_SORT_COL) : null;
let _oppSortDir = (localStorage.getItem(LS_OPP_SORT_DIR) === 'asc') ? 'asc' : 'desc';

// Opportunity-Anzeige-Zeitfenster (steuert nur die PnL-Spalte in der Opportunity-Tabelle)
const LS_OPP_DISPLAY_TIMEFRAME = 'liquiditybot_opp_display_tf';
const OPP_TF_OPTIONS = [
    { id: '6h',  label: '6 h'    },
    { id: '12h', label: '12 h'   },
    { id: '24h', label: '24 h'   },
    { id: '7d',  label: '7 Tage' },
];
const OPP_TF_VALID = new Set(OPP_TF_OPTIONS.map(o => o.id));
const _lsOppDisplayTf = localStorage.getItem(LS_OPP_DISPLAY_TIMEFRAME);
let _oppDisplayTf = OPP_TF_VALID.has(_lsOppDisplayTf) ? _lsOppDisplayTf : '24h';

// ── Premium-Deckung (2026-07-29) ──────────────────────────────────────────────
// Eine Stelle für "hat diese Installation gerade Zugriff", von renderNotifs()
// (Krone/Tooltip) UND renderOpportunityScores() (Tabelle ein/aus) genutzt — sonst
// könnten Krone und Tabelle auseinanderlaufen (Krone sagt "aktiv", Tabelle ist
// schon leer, oder umgekehrt).
//
// scoreSource==='compute' (Master rechnet selbst) hat kein Deckungskonzept, ist
// immer "Zugriff vorhanden". scoreSource==='delivered' (Fork mit Premium-Historie)
// prüft die Frische der gelieferten Daten (scoreStale). scoreSource==='none' hat
// nie Zugriff.
//
// GEÄNDERT 2026-07-30: Vorher wurde hier gegen premiumCoveredUntilMs geprüft (die
// UTC-Stundengrenze der letzten Zahlung), mit der Begründung, scoreStale sei ein
// Sicherheitsnetz für die Exit-Logik und kein "ist noch bezahlt"-Signal. Das war
// als Trennung sauber gedacht, in der Praxis aber falsch herum:
//   • Die Deckung endet auf die volle Stunde, der Zahlungs-Cron läuft erst um :05
//     → 5–6 Minuten pro Stunde wurde die Tabelle ausgeblendet, obwohl die Daten
//     Minuten alt und voll brauchbar waren (≈ 9 % der Betriebszeit).
//   • Umgekehrt galt Premium als "aktiv", solange die Stunde bezahlt war — auch
//     wenn der Master längst tot war und gar keine Daten mehr lieferte.
// Was mit der bezahlten Stunde endet, ist der Anspruch auf NEUE Daten, nicht die
// Gültigkeit der vorhandenen. Deshalb entscheidet jetzt der Nutzwert der Daten.
// premiumCoveredUntilMs bleibt für die Countdown-Anzeige bei abgeschalteter
// Auto-Zahlung in Gebrauch (siehe showCountdown weiter unten).
/**
 * Darf die Premium-Ansicht (Opportunity-Tabelle, Score-Spalten, Charts) gezeigt werden?
 *
 * Maßgeblich ist die **Frische der gelieferten Daten**, NICHT die Grenze der zuletzt
 * bezahlten Stunde (Änderung 2026-07-30).
 *
 * Vorher wurde gegen `premiumCoveredUntilMs` geprüft — die Deckung endet aber auf die
 * volle Stunde, während der Cron erst um :05 zahlt. Ergebnis war eine Lücke von 5–6
 * Minuten pro Stunde (≈ 9 % der Zeit), in der die Tabelle verschwand, obwohl die
 * gelieferten Daten wenige Minuten alt und vollständig brauchbar waren. Genau das ist
 * der Punkt: **bezahlte Daten liegen vor und bleiben nutzbar** — was mit der Stunde
 * endet, ist der Anspruch auf NEUE Daten, nicht die Gültigkeit der vorhandenen.
 *
 * Die ursprüngliche Absicht der harten Grenze („die Tabelle darf nicht ewig auf dem
 * letzten Stand eingefroren stehen bleiben") bleibt trotzdem erfüllt: hört die
 * Belieferung auf — sei es durch abgeschaltete Auto-Zahlung oder einen Ausfall des
 * Masters —, altern die Daten und `scoreStale` (2 h, siehe DELIVERED_MAX_AGE_MS in
 * lib/invest-score-provider.js) blendet die Tabelle aus. Der Übergang ist dann nur
 * kein Fallbeil mehr, sondern folgt dem tatsächlichen Nutzwert der Daten.
 *
 * Kein Kapitalbezug: Diese Funktion steuert ausschließlich die Anzeige. Score-Limit-
 * laufen im Bot und hängt an derselben 2-h-Frische, nie an der
 * Zahlungsgrenze.
 */
function hasPremiumAccess(data) {
    if (data?.scoreSource === 'compute') return true;
    if (data?.scoreSource === 'delivered') return !data?.scoreStale;
    return false;
}

/** "(noch aktiviert bis 19:00 Uhr)" – Text neben der Krone im Header. */
function formatPremiumCountdown(coveredUntilMs) {
    const tz = window.FORGE_TZ || 'Europe/Berlin';
    const timeStr = new Intl.DateTimeFormat(NUM_LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(coveredUntilMs));
    return `(noch aktiviert bis ${timeStr} Uhr)`;
}

function renderOpportunityScores(data) {
    const container = $('opportunityScoreContainer');
    const emptyMsg  = $('opportunityScoreEmpty');
    const tfBtns    = $('opportunityScoreTimeframeBtns');
    if (!container) return;

    // Event-Delegation für Pool-Chart-Modal, InvestScore-Modal und Metric-Charts (einmalig binden)
    if (!container.dataset.chartClickBound) {
        container.dataset.chartClickBound = '1';
        container.addEventListener('click', async e => {
            // Premium-Link (Score-/Slope-Zellen ohne Premium-Datenzugang) navigiert normal
            // zu den Settings – darf NICHT das Metric-Chart-/Score-Modal der umschließenden
            // Zelle öffnen (das hätte ohnehin keine Daten zu zeigen).
            if (e.target.closest('a.premium-link')) return;
            const scoreEl = e.target.closest('.invest-score-clickable[data-pool-id]');
            if (scoreEl) {
                if (_lastData) openInvestScoreModal(scoreEl.dataset.poolId, _lastData);
                return;
            }
            const metricEl = e.target.closest('.opp-metric-clickable[data-pool-id]');
            if (metricEl) {
                if (_lastData) openMetricChartModal(metricEl.dataset.poolId, metricEl.dataset.metric, _lastData, metricEl.dataset.metricTf);
                return;
            }
            const infoEl = e.target.closest('.opp-info-btn[data-pool-id]');
            if (infoEl) {
                const pool = (_lastData?.pools ?? []).find(p => p.id === infoEl.dataset.poolId);
                if (!pool) return;
                const { openTokenInfoModal } = await import('./token-info-modal.js?v=20260727a');
                await openTokenInfoModal(pool);
                return;
            }
            const el = e.target.closest('.opp-chart-btn[data-pool-id]');
            if (!el) return;
            const pool = (_lastData?.pools ?? []).find(p => p.id === el.dataset.poolId);
            if (!pool) return;
            const { openPoolChartModal } = await import('./pool-chart-modal.js?v=20260720a');
            openPoolChartModal(pool);
        });
    }

    // Timeframe-Buttons (Stil wie Chart-Range-Filter) – idempotent rendern
    if (tfBtns && tfBtns.childElementCount === 0) {
        for (const o of OPP_TF_OPTIONS) {
            const btn = document.createElement('button');
            btn.className     = 'chart-range-btn';
            btn.dataset.range = o.id;
            btn.textContent   = o.label;
            btn.addEventListener('click', () => {
                // Buttons steuern nur die Anzeige-Spalten in diesem Bereich —
                // die Sortierung aller Tabellen bleibt bei _oppSortTf (Settings > Strategie).
                _oppDisplayTf = o.id;
                localStorage.setItem(LS_OPP_DISPLAY_TIMEFRAME, _oppDisplayTf);
                tfBtns.querySelectorAll('.chart-range-btn').forEach(b =>
                    b.classList.toggle('active', b.dataset.range === _oppDisplayTf));
                if (_lastData) renderOpportunityScores(_lastData);
            });
            tfBtns.appendChild(btn);
        }
    }
    if (tfBtns) {
        tfBtns.querySelectorAll('.chart-range-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.range === _oppDisplayTf));
    }

    const scores   = data?.opportunityScores ?? {};
    const allPools = data?.pools ?? [];

    // Header-Kontrollen (Suche/Typfilter/Zeitfenster) – nur relevant, wenn wirklich
    // eine Tabelle gerendert wird. In beiden Sonderfällen unten (keine Pools, kein
    // Premium) ausgeblendet, damit nichts auf eine leere Fläche wirkt.
    const searchInputEl = document.getElementById('oppSearchInput');
    const typeFilterEl  = document.getElementById('oppTypeFilterSelect');

    // Ohne Premium-Zugang zeigt die Tabelle GAR NICHTS an (Entscheidung 2026-07-29) –
    // kein Score, keine PnL-Spalte, keine Charts/Token-Infos (beide hängen aus-
    // schließlich an dieser Tabelle). Statt einzelner Schloss-Zellen pro Spalte/Zeile
    // (bisheriger Zustand) EIN zentrierter Block im leeren Rahmen. Greift bei
    // scoreSource==='none' (nie Premium gehabt) und sobald die gelieferten Daten
    // veraltet sind (hasPremiumAccess(), s.o.) — so bleibt die Tabelle nicht ewig auf
    // dem letzten Stand eingefroren stehen. Seit 2026-07-30 ist dafür die Datenfrische
    // maßgeblich statt der Grenze der bezahlten Stunde: bezahlte Daten bleiben nutzbar,
    // auch wenn die Stunde gerade umgesprungen und die nächste noch nicht bezahlt ist.
    if (!hasPremiumAccess(data)) {
        if (emptyMsg) emptyMsg.style.display = 'none';
        if (searchInputEl) searchInputEl.style.display = 'none';
        if (typeFilterEl)  typeFilterEl.style.display  = 'none';
        if (tfBtns)        tfBtns.style.display        = 'none';
        container.querySelectorAll('.opp-score-table').forEach(el => el.remove());

        // Zusatzhinweis unter Krone+Link (2026-08-03): unterscheidet zwei
        // Unterfälle von "keine Score-Daten", die für den Nutzer sonst identisch aussehen
        // und leicht mit "nie Premium gehabt" verwechselt werden:
        //   - War schon aktiv und geliefert, aber die Daten sind jetzt veraltet (>2h,
        //     scoreSource==='delivered') – Ausfall bzw. bewusst abgeschaltet.
        //   - Gerade erst aktiviert (Auto-Pay an oder schon eine Stunde bezahlt), aber
        //     noch nie ein Blob integriert (scoreSource==='none') – normale Anlaufzeit
        //     von wenigen Sekunden/Minuten bis zum ersten 10-Min-Publish-Zyklus.
        // "Nie Premium gehabt" (scoreSource==='none', kein Auto-Pay, keine Zahlung) bleibt
        // bewusst ohne Zusatztext – da ist der Krone+Link-Hinweis allein zutreffend.
        // "Nicht erreichbar" nur bei einem ECHTEN Ausfall (premiumOutagePaused,
        // core/premium/blob-health-check.js) anzeigen. Veraltete Daten haben eine
        // zweite, häufigere Ursache: das Guthaben ist alle, premium-pay.js hat
        // daraufhin premiumAutoPayEnabled selbst abgeschaltet (siehe lib/premium-
        // wallet.js getPremiumCoverage()) — dafür gibt es bereits eine eigene
        // Meldung im Message Center, hier fällt der Fall bewusst durch auf denselben
        // leeren Hinweis wie "nie Premium gehabt" (kein zweiter, irreführender Text
        // der einen baldigen automatischen Wiederanlauf verspricht).
        const unreachable = data?.scoreSource === 'delivered' && data?.scoreStale && data?.premiumOutagePaused;
        const waitingForFirstDelivery = !unreachable && data?.scoreSource === 'none'
            && (data?.premiumAutoPayEnabled || data?.premiumCoveredUntilMs != null);
        // Überschrift richtet sich nach demselben Dreiwege-Unterschied wie der
        // Zusatzhinweis: "inaktiv" ist nur bei "nie Premium gehabt" korrekt — bei
        // einem echten Ausfall hat der Nutzer nichts deaktiviert, und wer gerade
        // erst aktiviert hat/auf die ersten Daten wartet, hat Premium ebenfalls
        // nicht "aus". Der Zusatzhinweis unter der Überschrift entfällt jetzt für
        // "nicht erreichbar" (wäre reine Wiederholung), bleibt aber für "wartet
        // auf erste Daten" bestehen.
        const headline = unreachable
            ? tr('liq.premium_service_unreachable', 'Premium Service derzeit nicht erreichbar')
            : waitingForFirstDelivery
                ? tr('liq.premium_service_activating', 'Premium Service wird aktiviert')
                : tr('liq.premium_service_inactive', 'Premium Service inaktiv');
        const note = waitingForFirstDelivery ? tr('liq.premium_waiting', 'Warte auf den ersten Premium-Datensatz.') : '';

        let panel = container.querySelector('.premium-locked-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'premium-locked-panel';
            container.appendChild(panel);
        }
        panel.innerHTML = '<div class="premium-locked-panel-main">'
            + `<a class="premium-link" href="../../index.html#liquidity">${headline}</a>`
            + '<span class="premium-locked-crown"><img src="img/forge-logo.png?v=20260329a" alt="Premium"></span></div>'
            + (note ? `<div class="premium-locked-note">${note}</div>` : '');
        return;
    }
    container.querySelectorAll('.premium-locked-panel').forEach(el => el.remove());
    if (searchInputEl) searchInputEl.style.display = '';
    if (typeFilterEl)  typeFilterEl.style.display  = '';
    if (tfBtns)         tfBtns.style.display        = '';

    if (!allPools.length) {
        if (emptyMsg) emptyMsg.style.display = '';
        container.querySelectorAll('.opp-score-table').forEach(el => el.remove());
        return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    // Suchfeld: Event idempotent binden + Wert setzen
    const searchInput = document.getElementById('oppSearchInput');
    if (searchInput && !searchInput.dataset.bound) {
        searchInput.dataset.bound = '1';
        searchInput.addEventListener('input', () => {
            _oppSearchQuery = searchInput.value;
            localStorage.setItem(LS_OPP_SEARCH, _oppSearchQuery);
            if (_lastData) renderOpportunityScores(_lastData);
        });
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                searchInput.value = '';
                _oppSearchQuery = '';
                localStorage.setItem(LS_OPP_SEARCH, '');
                if (_lastData) renderOpportunityScores(_lastData);
            }
        });
    }
    if (searchInput && searchInput.value !== _oppSearchQuery) searchInput.value = _oppSearchQuery;

    // Pool-Typ-Filter (im Header über der Tabelle, neben dem Suchfeld): Optionen + Event
    // idempotent binden.
    const typeFilterInput = document.getElementById('oppTypeFilterSelect');
    if (typeFilterInput && !typeFilterInput.dataset.bound) {
        typeFilterInput.dataset.bound = '1';
        typeFilterInput.innerHTML = `<option value="all">${tr('liq.all_types', 'Alle Typen')}</option>`
            + Object.entries(POOL_TYPE_LABELS).map(([val, label]) =>
                `<option value="${val}">${escHtml(label)}</option>`).join('');
        typeFilterInput.addEventListener('change', () => {
            _oppTypeFilter = typeFilterInput.value;
            localStorage.setItem(LS_OPP_TYPE_FILTER, _oppTypeFilter);
            _oppSortCol = null; _oppSortDir = 'desc';
            localStorage.setItem(LS_OPP_SORT_COL, ''); localStorage.setItem(LS_OPP_SORT_DIR, 'desc');
            if (_lastData) renderOpportunityScores(_lastData);
        });
    }
    if (typeFilterInput && typeFilterInput.value !== _oppTypeFilter) typeFilterInput.value = _oppTypeFilter;

    // Pool-Filter + Typ-Filter + Suche anwenden
    const _searchQ = _oppSearchQuery.trim().toLowerCase();
    const pools = allPools
        .filter(p => _oppPoolFilter === 'active'   ?  p.active
                   : _oppPoolFilter === 'inactive' ? !p.active : true)
        .filter(p => _oppTypeFilter === 'all' || p.poolType === _oppTypeFilter)
        .filter(p => !_searchQ ||
            (p.displayPair ?? p.pair ?? '').toLowerCase().includes(_searchQ));

    let table = container.querySelector('.opp-score-table');
    if (!table) {
        table = document.createElement('div');
        table.className = 'opp-score-table';
        container.appendChild(table);
    }

    // Pool-Reihen: generische Spaltensortierung, Fallback auf InvestScore
    const rows = pools.map(p => {
        const s = scores[p.id]?.[_oppDisplayTf] ?? null;
        return { pool: p, s };
    }).sort((a, b) => {
        if (_oppSortCol) {
            const dir = _oppSortDir === 'asc' ? 1 : -1;
            // Numerische Spalten: null-Werte ans Ende
            const getVal = (item) => {
                if (_oppSortCol === 'score')      return item.pool.investScore?.value ?? null;
                if (_oppSortCol === 'pnl') {
                    if (_oppPnlMode === 'sim') {
                        const _npRaw = item.pool.npWindows?.[_oppDisplayTf] ?? null;
                        if (_npRaw == null) return null;
                        const _npCap = item.pool.capitalUSDC > 0 ? item.pool.capitalUSDC : null;
                        return _npCap != null ? _npRaw * _npCap / 1000 : _npRaw;
                    }
                    const _sRaw = item.pool.pnlWindows?.[_oppDisplayTf] ?? null;
                    const _sCap = item.pool.capitalUSDC > 0 ? item.pool.capitalUSDC : null;
                    if (_sRaw != null) return _sCap != null ? _sRaw / _sCap * 1000 : _sRaw;
                    const _npRaw = item.pool.npWindows?.[_oppDisplayTf] ?? null;
                    if (_npRaw == null) return null;
                    return _sCap != null ? _npRaw * _sCap / 1000 : _npRaw;
                }
                if (_oppSortCol === 'priceSlope') return item.s?.priceSlopePct ?? null;
                if (_oppSortCol === 'aprSlope')   return item.s?.yieldSlopePct ?? null;
                if (_oppSortCol === 'tvlSlope')   return item.s?.tvlSlopePct   ?? null;
                return null;
            };
            const aVal = getVal(a), bVal = getVal(b);
            if (aVal == null && bVal == null) return 0;
            if (aVal == null) return 1;
            if (bVal == null) return -1;
            return dir * (aVal - bVal);
        }
        return comparePoolSortKeys(
            poolSortKey(a.pool.investScore, a.pool.sortRank, a.pool.displayPair ?? a.pool.pair),
            poolSortKey(b.pool.investScore, b.pool.sortRank, b.pool.displayPair ?? b.pool.pair),
        );
    });

    // ── Helpers ────────────────────────────────────────────────────────
    // Schätzt, ab wann ein neuer Pool genug Messpunkte hat (Backend: MIN_SAMPLES=3
    // in lib/opportunity-score/config.js, stündliche pool_stats-Erfassung in bot.js).
    // Nur eine Näherung ("ca."), kein Daten-Lookup gegen das Live-Backend.
    const OPP_MIN_SAMPLES      = 3;
    const OPP_STATS_INTERVAL_MS = 3600_000;
    const _dataEtaTooltip = (poolId, tf) => {
        const entry = scores[poolId]?.[tf];
        if (!entry || entry.reason !== 'insufficient_data') return null;
        const missing = Math.max(0, OPP_MIN_SAMPLES - (entry.sampleCount ?? 0));
        if (missing <= 0) return tr('liq.premium_next_cycle', 'Daten sollten mit dem nächsten Bot-Zyklus verfügbar sein.');
        const etaDate = new Date(Date.now() + missing * OPP_STATS_INTERVAL_MS);
        const etaDateStr = etaDate.toLocaleDateString(NUM_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
        const etaTimeStr = etaDate.toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' });
        return `Messpunkte sind verfügbar:\n${etaDateStr} ab ca. ${etaTimeStr} Uhr`;
    };
    const _noDataSpan = (poolId, tf) => {
        const tip = _dataEtaTooltip(poolId, tf);
        return tip
            ? `<span class="has-tooltip text-muted" data-tooltip-title="${tr('liq.no_data_yet', 'Noch keine Daten')}" data-tooltip-content="${escHtml(tip)}" data-tooltip-type="text" style="font-size:0.78em;cursor:default">no data</span>`
            : '<span class="text-muted" style="font-size:0.78em">no data</span>';
    };
    // Ab hier ist scoreSource garantiert nicht 'none' (früher Return oben) — ein
    // fehlender Score/Slope-Wert bedeutet also immer "noch nicht erhoben", nie
    // "Premium fehlt". Der bis 2026-07-29 hier nötige Fall-Unterschied (Premium-
    // Schloss pro Zelle vs. "no data") entfällt: ohne Premium wird die ganze
    // Tabelle gar nicht erst gerendert (siehe oben, premium-locked-panel).
    const slopeArrow = v => v == null ? '' : v >  0.1 ? '↑' : v < -0.1 ? '↓' : '→';
    const slopeCls   = v => v == null ? '' : v >  0.1 ? 'value-good' : v < -0.1 ? 'value-danger' : 'text-muted';
    const fmtSlope   = (v, unit, poolId, tf, label) => {
        if (v == null) return _noDataSpan(poolId, tf);
        const sign = v >= 0 ? '+' : '−';
        return `${sign}${Number(Math.abs(v)).toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit} ${slopeArrow(v)}`;
    };
    const fmtPnl = v => {
        if (v == null) return '<span class="text-muted" style="font-size:0.78em">no data</span>';
        if (v === 0)   return '<span class="text-muted">0.00 USDC</span>';
        const cls  = v > 0 ? 'value-good' : 'value-danger';
        const sign = v > 0 ? '+' : '−';
        return `<span class="${cls}">${sign}${fmtUsdc(Math.abs(v))} USDC</span>`;
    };
    // Simulierter NP: weiß + kursiv als visueller Hinweis "geschätzt, kein realer PnL"
    const fmtNp = v => {
        if (v == null) return '<span class="text-muted" style="font-size:0.78em">no data</span>';
        if (v === 0)   return '<em style="color:#fff;font-size:0.9em;opacity:0.7">0.00 USDC</em>';
        const sign = v > 0 ? '+' : '−';
        return `<em style="color:#fff;font-size:0.9em;opacity:0.85">${sign}${fmtUsdc(Math.abs(v))} USDC</em>`;
    };
    const tfLabel = OPP_TF_OPTIONS.find(o => o.id === _oppDisplayTf)?.label ?? _oppDisplayTf;

    // Pool-Filter Select (inline im Header, idempotent)
    const poolFilterSel = `<select id="oppPoolFilterSelect" style="background:#0f172a;border:none;color:#f1f5f9;font:inherit;cursor:pointer;padding:0;outline:none;border-radius:3px;font-size:0.7rem;letter-spacing:0.05em;text-transform:uppercase">
        <option value="all"${_oppPoolFilter==='all'?' selected':''}>${tr('liq.all_pools', 'Alle Pools')}</option>
        <option value="active"${_oppPoolFilter==='active'?' selected':''}>${tr('liq.active_pools', 'Aktive Pools')}</option>
        <option value="inactive"${_oppPoolFilter==='inactive'?' selected':''}>${tr('liq.inactive_pools', 'Inaktive Pools')}</option>
    </select>`;

    // PnL-Modus Select (hist = historischer PnL aktiver Pools, sim = Modell-Prognose aller Pools)
    // Tooltip liegt auf dem Wrapper-Span (Select-Hover ist browserübergreifend unzuverlässig).
    const _pnlSelTitle   = _oppPnlMode === 'sim' ? tr('liq.simulation_future', 'Simulation – Zukunft') : tr('liq.hist_pnl_norm', 'Historischer PnL – norm. 1.000 USDC');
    const _pnlSelContent = _oppPnlMode === 'sim'
        ? tr('liq.np_forecast', 'Modell-Prognose des Netto-Ertrags für alle Pools im gewählten Zeitfenster. Berechnet aus aktuellem Fee-APR, Volatilität und geschätztem Impermanent Loss nach Range-Advisor-Modell. Basis: 1.000 USDC. Bezieht sich auf die Zukunft — kein realer Messwert, kursiv dargestellt.')
        : 'Tatsächlich realisierter PnL im gewählten Zeitfenster (Kurswert + Fees − Kapitalflüsse, cashflow-bereinigt), normiert auf 1.000 USDC Poolkapital. Alle Pools sind so direkt vergleichbar.\n\nAktive Pools: realer PnL, auf 1.000 USDC normiert.\nInaktive Pools: Schätzwert aus Modell (kursiv) — für eine Zukunftsprognose den Modus "PnL sim" wählen.';
    const pnlModeSel = `<span class="has-tooltip" data-tooltip-title="${_pnlSelTitle}" data-tooltip-content="${escHtml(_pnlSelContent)}" data-tooltip-type="text" style="display:inline-flex"><select id="oppPnlModeSelect" style="background:#0f172a;border:none;color:#94a3b8;font:inherit;cursor:pointer;padding:0;outline:none;border-radius:3px;font-size:0.7rem;letter-spacing:0.05em;text-transform:uppercase">
        <option value="hist"${_oppPnlMode==='hist'?' selected':''}>${tr('liq.pnl_hist', 'PnL hist.')}</option>
        <option value="sim"${_oppPnlMode==='sim'?' selected':''}>${tr('liq.pnl_sim', 'PnL sim')}</option>
    </select></span>`;

    const _chartIconSvg = `<svg width="14" height="12" viewBox="0 0 14 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <polyline points="1,11 4,7 7,9 10,3 13,1" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;

    const _infoIconSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/>
        <line x1="6" y1="5.3" x2="6" y2="8.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        <circle cx="6" cy="3.4" r="0.8" fill="currentColor"/>
    </svg>`;

    // InvestScore-Hilfsfunktionen
    const isScoreCls = v => v == null ? 'text-muted' : v >= 60 ? 'value-good' : v < 35 ? 'value-danger' : '';
    const fmtInvestScore = pool => {
        const is = pool.investScore;
        if (!is || is.value == null) return _noDataSpan(pool.id, '24h');
        return `<span class="${isScoreCls(is.value)}">${is.value}</span>`;
    };

    // Token-Info-Icon: Kategorien beider Tokens als Teaser, Details im Klick-Modal.
    // "Layer-1-Coin" (i.d.R. SOL) ist Boilerplate, da fast jeder Pool eine Seite davon hat —
    // wird nur gezeigt, wenn die andere Seite keine eigene, aussagekräftigere Kategorie hat.
    const _tokenInfoTip = pool => {
        const catA = getTokenInfo(pool.tokenA)?.category;
        const catB = getTokenInfo(pool.tokenB)?.category;
        let cats = [catA, catB].filter(Boolean);
        if (cats.length > 1) {
            const specific = cats.filter(c => c !== 'Layer-1-Coin');
            if (specific.length > 0) cats = specific;
        }
        return (cats.length ? `${cats.join(' / ')}\n` : '') + tr('liq.more_info', 'Klick für mehr Infos.');
    };

    // Sortier-Button-Helper
    const _sortBtn = (col, title) => {
        const active = _oppSortCol === col;
        const icon   = active ? (_oppSortDir === 'desc' ? '↓' : '↑')
                              : '<span style="opacity:0.35">⇅</span>';
        const color  = active ? 'var(--text-primary)' : 'inherit';
        return `<button data-sort-col="${col}" style="background:none;border:none;padding:0 2px 0 0;cursor:pointer;line-height:1;font-size:0.85em;color:${color}" title="${title}">${icon}</button>`;
    };

    table.innerHTML = `
        <div class="opp-score-header">
            <span style="display:flex;align-items:center;gap:3px">${poolFilterSel}</span>
            <span class="has-tooltip" data-tooltip-title="Chart" data-tooltip-content="${tr('liq.tip.chart_open', 'Öffnet den Kurs- und Fee-Chart des Pools.')}" data-tooltip-type="text" style="cursor:default">Chart</span>
            <span style="display:flex;align-items:center;gap:3px">${_sortBtn('score',tr('liq.sort_score', 'Nach Score sortieren'))}<span class="has-tooltip" data-tooltip-title="Opportunity Score" data-tooltip-content="${tr('liq.tip.opp_score', 'Bewertet die aktuelle Investitionsqualität eines Pools (0–100). Hauptfaktor ist der PnL (verdient die Position gerade Geld), dazu Fee-APR, Preis-Trend und APR-Entwicklung. Die Gewichtung hängt vom Pool-Typ ab (z. B. zählt bei stabilen/RWA-Pools der PnL stärker, bei sehr volatilen die Fee-APR). Details je Pool im Score-Klick → Reiter „Bewertung“.\\n\\n≥ 60 – Gute Bedingungen, Position lohnt sich.\\n35–59 – Neutrale Lage, abwarten.\\n&lt; 35 – Ungünstige Bedingungen, kein Invest.')}" data-tooltip-type="text" style="cursor:default">${tr('liq.score', 'Score')}</span></span>
            <span style="display:flex;align-items:center;gap:3px">${_sortBtn('pnl',tr('liq.sort_pnl', 'Nach PnL sortieren'))}${pnlModeSel}</span>
            <span class="opp-col-detail" style="display:flex;align-items:center;gap:3px">${_sortBtn('priceSlope',tr('liq.sort_price_slope', 'Nach Preis-Slope sortieren'))}Preis-Slope</span>
            <span class="opp-col-detail" style="display:flex;align-items:center;gap:3px">${_sortBtn('aprSlope',tr('liq.sort_apr_slope', 'Nach APR-Slope sortieren'))}APR-Slope</span>
            <span class="opp-col-detail" style="display:flex;align-items:center;gap:3px">${_sortBtn('tvlSlope',tr('liq.sort_tvl_slope', 'Nach TVL-Slope sortieren'))}TVL-Slope</span>
        </div>
        <div class="opp-score-body">
        ${rows.map(({pool, s}) => {
            const rowCls  = pool.active ? '' : ' inactive';
            const pair    = escHtml(pool.displayPair ?? pool.pair ?? '—');
            const isGated   = pool.investScore?.hopiumVeto === true;
            const isNewPool = (pool.investScore?.dataDays ?? 1) === 0;
            const badge   = isGated
                ? ` <span class="has-tooltip" data-tooltip-title="${tr('liq.higher_risk', 'Höheres Risiko!')}" data-tooltip-content="${tr('liq.tip.signal_6h', '6h-Signal: Kurs fällt stärker als −0,5 %/h und der Fee-APR sinkt gleichzeitig. Score auf max. 40 gedeckelt.')}" data-tooltip-type="text" style="cursor:default">🚫</span>`
                : '';
            const newPoolBadge = isNewPool
                ? ` <span class="has-tooltip" data-tooltip-title="${tr('liq.few_data', 'Wenig Daten')}" data-tooltip-content="${tr('liq.pool_young', 'Pool erst seit weniger als 24h beobachtet – Zeitfenster-Werte sind noch identisch.')}" data-tooltip-type="text" style="color:#f59e0b;font-size:0.75em;cursor:default">&#60;24h</span>`
                : '';
            const pnlVal   = pool.pnlWindows?.[_oppDisplayTf] ?? null;
            const capital  = pool.capitalUSDC > 0 ? pool.capitalUSDC : null;
            const pid     = escHtml(pool.id);
            const mc      = `opp-metric-clickable`;
            const _tfMs   = { '6h': 6, '12h': 12, '24h': 24, '7d': 168 };
            let pnlCell;
            // NP auf kurzen Fenstern für volatile Pools unzuverlässig (Richtungstreffer < 50%).
            const _npUnreliable = Array.isArray(pool.npUnreliableWindows)
                && pool.npUnreliableWindows.includes(_oppDisplayTf);
            const _unreliableNote = tr('liq.unreliable_note', ' ⚠ Für volatile Pools auf kurzen Zeitfenstern (6h/12h) unzuverlässig')
                + ' — Richtungstreffer unter 50 %. Nur als grobe Tendenz lesen.';
            if (_oppPnlMode === 'sim') {
                const npRaw    = pool.npWindows?.[_oppDisplayTf] ?? null;
                const npScaled = npRaw != null ? (capital != null ? npRaw * capital / 1000 : npRaw) : null;
                const simBasis = capital != null
                    ? `Basis: ${capital.toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC (aktuelles Poolkapital).`
                    : `Basis: 1.000 USDC (kein aktives Kapital).`;
                const simTip = `Simulierter Netto-Ertrag aus Fee-APR und geschätztem Impermanent Loss nach Range-Advisor-Modell. ${simBasis} Kein realer Messwert.${_npUnreliable ? _unreliableNote : ''}`;
                const simTitle = `Simulierter Ertrag ${tfLabel}${_npUnreliable ? tr('liq.unreliable_short', ' (unzuverlässig)') : ''}`;
                const _simIcon = `<span style="display:inline-block;min-width:1.2em;text-align:center;color:#f59e0b;${_npUnreliable ? '' : 'visibility:hidden'}">⚠</span>`;
                pnlCell = npScaled != null
                    ? `<span>${_simIcon}<span class="has-tooltip" data-tooltip-title="${simTitle}" data-tooltip-content="${escHtml(simTip)}" data-tooltip-type="text" style="cursor:default">${fmtNp(npScaled)}</span></span>`
                    : _noDataSpan(pool.id, _oppDisplayTf);
            } else {
                // hist-Modus: echter PnL für aktive Pools, npWindows-Schätzung für inaktive.
                if (pnlVal != null) {
                    const pnlNorm = capital != null ? pnlVal / capital * 1000 : pnlVal;
                    const _capStr = capital != null ? capital.toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDC' : 'unbekannt';
                    const _pnlTip = `Realer PnL ${tfLabel}, normiert auf 1.000 USDC Poolkapital (aktuelles Kapital: ${_capStr}). Klicken für PnL-Verlauf.`;
                    pnlCell = `<span><span style="display:inline-block;min-width:1.2em;text-align:center;visibility:hidden">⚠</span><span class="${mc} has-tooltip" data-tooltip-title="${tr('liq.real_pnl_norm', 'Realer PnL (norm. 1.000 USDC)')}" data-tooltip-content="${escHtml(_pnlTip)}" data-tooltip-type="text" data-pool-id="${pid}" data-metric="pnl" data-metric-tf="${escHtml(_oppDisplayTf)}" style="cursor:pointer">${fmtPnl(pnlNorm)}</span></span>`;
                } else {
                    // Kein realer PnL (Pool inaktiv oder zu jung) → NP-Schätzung als Fallback.
                    const npRaw    = pool.npWindows?.[_oppDisplayTf] ?? null;
                    const npScaled = npRaw != null ? (capital != null ? npRaw * capital / 1000 : npRaw) : null;
                    let npTip;
                    if (pool.active) {
                        const availMs  = pool.positionOpenedAt
                            ? pool.positionOpenedAt + (_tfMs[_oppDisplayTf] ?? 24) * 3_600_000 : null;
                        const availStr = availMs
                            ? new Date(availMs).toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' }) : null;
                        npTip = `Schätzwert auf Basis historischer Pool-Daten — realer PnL noch nicht verfügbar (Pool zu jung für dieses Zeitfenster${availStr ? `, voraussichtlich ab ${availStr} Uhr` : ''}). Kursiv dargestellt.`;
                    } else {
                        npTip = `Auf historischen Pool-Daten (Fee-APR, Volatilität, Preisverlauf) basierender Schätzwert. Basis: 1.000 USDC. Kein realer PnL-Messwert — kursiv dargestellt.`;
                    }
                    const npTitle = `Schätzung (hist. Daten)${_npUnreliable ? tr('liq.unreliable_dash', ' – unzuverlässig') : ''}`;
                    const _npIcon = `<span style="display:inline-block;min-width:1.2em;text-align:center;color:#f59e0b;${_npUnreliable ? '' : 'visibility:hidden'}">⚠</span>`;
                    pnlCell = npScaled != null
                        ? `<span>${_npIcon}<span class="has-tooltip" data-tooltip-title="${npTitle}" data-tooltip-content="${escHtml(npTip + (_npUnreliable ? _unreliableNote : ''))}" data-tooltip-type="text" style="cursor:default">${fmtNp(npScaled)}</span></span>`
                        : _noDataSpan(pool.id, _oppDisplayTf);
                }
            }
            return `
        <div class="opp-score-row${rowCls}">
            <span class="opp-pool-name"><button class="opp-info-btn has-tooltip" data-pool-id="${pid}" data-tooltip-title="Token-Info" data-tooltip-content="${escHtml(_tokenInfoTip(pool))}" data-tooltip-type="text" aria-label="${tr('liq.token_info_show', 'Token-Infos anzeigen')}">${_infoIconSvg}</button><span class="opp-pool-name-text">${pair}${badge}${newPoolBadge}</span></span>
            <button class="opp-chart-btn" data-pool-id="${pid}">${_chartIconSvg}</button>
            <span class="invest-score-clickable" data-pool-id="${pid}" style="cursor:pointer;white-space:nowrap"${(pool.investScore?.value == null) ? '' : ' title="' + tr('liq.opp_details_show', 'Opportunity Score – Details anzeigen') + '"'}>${fmtInvestScore(pool)}</span>
            ${pnlCell}
            <span class="opp-col-detail ${mc} ${slopeCls(s?.priceSlopePct)}" data-pool-id="${pid}" data-metric="priceSlope" style="cursor:pointer"${s?.priceSlopePct == null ? '' : ' title="' + tr('liq.slope_price_show', 'Preis-Slope-Verlauf anzeigen') + '"'}>${fmtSlope(s?.priceSlopePct, '%/h', pool.id, _oppDisplayTf, 'Preis-Slope')}</span>
            <span class="opp-col-detail ${mc} ${slopeCls(s?.yieldSlopePct)}" data-pool-id="${pid}" data-metric="aprSlope"   style="cursor:pointer"${s?.yieldSlopePct == null ? '' : ' title="' + tr('liq.slope_apr_show', 'APR-Slope-Verlauf anzeigen') + '"'}>${fmtSlope(s?.yieldSlopePct, 'pp/h', pool.id, _oppDisplayTf, 'APR-Slope')}</span>
            <span class="opp-col-detail ${mc} ${slopeCls(s?.tvlSlopePct)}"  data-pool-id="${pid}" data-metric="tvlSlope"   style="cursor:pointer"${s?.tvlSlopePct == null ? '' : ' title="' + tr('liq.slope_tvl_show', 'TVL-Slope-Verlauf anzeigen') + '"'}>${fmtSlope(s?.tvlSlopePct, '%/h', pool.id, _oppDisplayTf, 'TVL-Slope')}</span>
        </div>`;
        }).join('')}
        </div>`;

    const body = table.querySelector('.opp-score-body');
    if (body) {
        if (rows.length > 5) {
            body.style.maxHeight = '185px';
            body.style.overflowY = 'auto';
        } else {
            body.style.maxHeight = '';
            body.style.overflowY = '';
        }
    }

    table.querySelectorAll('[data-sort-col]').forEach(btn => {
        btn.addEventListener('click', () => {
            const col = btn.dataset.sortCol;
            if (_oppSortCol === col) {
                // gleiche Spalte: desc ↔ asc (kein Reset)
                _oppSortDir = _oppSortDir === 'desc' ? 'asc' : 'desc';
            } else {
                _oppSortCol = col;
                _oppSortDir = 'desc';
            }
            localStorage.setItem(LS_OPP_SORT_COL, _oppSortCol ?? '');
            localStorage.setItem(LS_OPP_SORT_DIR, _oppSortDir);
            if (_lastData) renderOpportunityScores(_lastData);
        });
    });

    table.querySelector('#oppPoolFilterSelect')?.addEventListener('change', e => {
        _oppPoolFilter = e.target.value;
        localStorage.setItem(LS_OPP_POOL_FILTER, _oppPoolFilter);
        _oppSortCol = null; _oppSortDir = 'desc';
        localStorage.setItem(LS_OPP_SORT_COL, ''); localStorage.setItem(LS_OPP_SORT_DIR, 'desc');
        if (_lastData) renderOpportunityScores(_lastData);
    });

    table.querySelector('#oppPnlModeSelect')?.addEventListener('change', e => {
        _oppPnlMode = e.target.value;
        localStorage.setItem(LS_OPP_PNL_MODE, _oppPnlMode);
        if (_lastData) renderOpportunityScores(_lastData);
    });
}

function renderPools(data) {
    const container = $('poolsContainer');
    const emptyMsg  = $('poolsEmpty');
    if (!container) return;

    // Anders als bei den positionsbezogenen Boxen (Operative Metriken, Fees, Volumen)
    // ist "keine offene Position" hier KEIN Grund, die Tabelle auszublenden — Pool
    // Metriken listet die verfügbaren Pools, nicht Positionen. Ohne offene Position
    // greift stattdessen einfach der Default-Filter "Alle Pools" (_poolsVisFilter).
    const poolsSearchInputEl = document.getElementById('poolsSearchInput');
    if (poolsSearchInputEl) poolsSearchInputEl.style.display = '';
    removeBotInactivePanel(container);

    // Event-Delegation für Pool-Chart-Modal (einmalig binden – reserviert für künftige Icon-Spalte)
    if (!container.dataset.chartClickBound) {
        container.dataset.chartClickBound = '1';
    }

    // Sortierung: per Spaltenwahl (APR/VOL/TVL) oder Standard nach InvestScore
    const useApr1hSort = _poolsAprTf === '1h';
    const allPools = [...(data?.pools ?? [])].sort((a, b) => {
        if (_poolsSortCol) {
            const dir = _poolsSortDir === 'asc' ? 1 : -1;
            const getVal = p => {
                if (_poolsSortCol === 'apr') {
                    const raw = useApr1hSort ? p.apr1hDisplay : p.apr24hDisplay;
                    return (raw != null && raw >= 0) ? raw : null;
                }
                if (_poolsSortCol === 'vol') return p.volume24h ?? null;
                if (_poolsSortCol === 'tvl') return p.tvl ?? null;
                return null;
            };
            const aVal = getVal(a), bVal = getVal(b);
            if (aVal == null && bVal == null) return 0;
            if (aVal == null) return 1;
            if (bVal == null) return -1;
            return dir * (aVal - bVal);
        }
        return comparePoolSortKeys(
            poolSortKey(a.investScore, a.sortRank, a.displayPair ?? a.pair),
            poolSortKey(b.investScore, b.sortRank, b.displayPair ?? b.pair),
        );
    });
    // Pool-Filter + Suche anwenden
    const _poolsSearchQ = _poolsSearchQuery.trim().toLowerCase();
    const pools = allPools
        .filter(p => _poolsVisFilter === 'active'   ?  p.active
                   : _poolsVisFilter === 'inactive' ? !p.active : true)
        .filter(p => !_poolsSearchQ ||
            (p.displayPair ?? p.pair ?? '').toLowerCase().includes(_poolsSearchQ));

    // Suchfeld-State synchronisieren (idempotent)
    const poolsSearchInput = document.getElementById('poolsSearchInput');
    if (poolsSearchInput && !poolsSearchInput.dataset.bound) {
        poolsSearchInput.dataset.bound = '1';
        poolsSearchInput.addEventListener('input', () => {
            _poolsSearchQuery = poolsSearchInput.value;
            localStorage.setItem(LS_POOLS_SEARCH, _poolsSearchQuery);
            if (_lastData) renderPools(_lastData);
        });
        poolsSearchInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                poolsSearchInput.value = '';
                _poolsSearchQuery = '';
                localStorage.setItem(LS_POOLS_SEARCH, '');
                if (_lastData) renderPools(_lastData);
            }
        });
    }
    if (poolsSearchInput && poolsSearchInput.value !== _poolsSearchQuery) poolsSearchInput.value = _poolsSearchQuery;

    let table = container.querySelector('.pools-overview-table');
    if (!table) {
        table = document.createElement('div');
        table.className = 'pools-overview-table';
        container.appendChild(table);
    }

    // Bei leerem Filterergebnis: Header mit Filter-Select behalten, leere Meldung zeigen
    if (pools.length === 0) {
        if (emptyMsg) emptyMsg.style.display = 'none';
        const poolFilterSelectEmpty = `<select id="poolsVisFilterSelect" class="pools-header-select" data-stop-tooltip="1">
            <option value="all"${_poolsVisFilter==='all'?' selected':''}>${tr('liq.all_pools', 'Alle Pools')}</option>
            <option value="active"${_poolsVisFilter==='active'?' selected':''}>${tr('liq.active_pools', 'Aktive Pools')}</option>
            <option value="inactive"${_poolsVisFilter==='inactive'?' selected':''}>${tr('liq.inactive_pools', 'Inaktive Pools')}</option>
        </select>`;
        table.style.maxHeight = '';
        table.style.overflowY = '';
        table.innerHTML = `
            <div class="pools-overview-header">
                <span>${poolFilterSelectEmpty}</span>
                <span class="col-r"></span>
                <span class="col-r"></span>
                <span class="col-r"></span>
            </div>
            <div class="pools-overview-empty-row">${tr('liq.no_pool_data_plain', 'Keine Pool-Daten verfügbar')}</div>`;
        const visSelEmpty = table.querySelector('#poolsVisFilterSelect');
        if (visSelEmpty) {
            visSelEmpty.addEventListener('mousedown', e => e.stopPropagation());
            visSelEmpty.addEventListener('click',     e => e.stopPropagation());
            visSelEmpty.addEventListener('change', e => {
                _poolsVisFilter = ['active', 'inactive'].includes(e.target.value) ? e.target.value : 'all';
                localStorage.setItem(LS_POOLS_VIS_FILTER, _poolsVisFilter);
                _poolsSortCol = null; _poolsSortDir = 'desc';
                localStorage.setItem(LS_POOLS_SORT_COL, ''); localStorage.setItem(LS_POOLS_SORT_DIR, 'desc');
                if (_lastData) renderPools(_lastData);
            });
        }
        return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    // Pool-Filter-Select (Alle / Aktive) im Pool-Spaltenkopf
    const poolFilterSelect = `<select id="poolsVisFilterSelect" class="pools-header-select" data-stop-tooltip="1">
        <option value="all"${_poolsVisFilter==='all'?' selected':''}>${tr('liq.all_pools', 'Alle Pools')}</option>
        <option value="active"${_poolsVisFilter==='active'?' selected':''}>${tr('liq.active_pools', 'Aktive Pools')}</option>
        <option value="inactive"${_poolsVisFilter==='inactive'?' selected':''}>${tr('liq.inactive_pools', 'Inaktive Pools')}</option>
    </select>`;

    // APR-Spalten-Select (24h vs. 1h) im Header
    const aprSelect = `<select id="poolsAprTfSelect" class="pools-header-select" data-stop-tooltip="1">
        <option value="24h"${_poolsAprTf==='24h'?' selected':''}>${tr('liq.apr_24h', 'APR 24h')}</option>
        <option value="1h"${_poolsAprTf==='1h'?' selected':''}>${tr('liq.apr_1h', 'APR 1H')}</option>
    </select>`;

    const useApr1h = _poolsAprTf === '1h';

    // Sortier-Button-Helper (analog Opportunity-Tabelle)
    const _poolsSortBtn = (col, title) => {
        const active = _poolsSortCol === col;
        const icon   = active ? (_poolsSortDir === 'desc' ? '↓' : '↑')
                              : '<span style="opacity:0.35">⇅</span>';
        const color  = active ? 'var(--text-primary)' : 'inherit';
        return `<button data-sort-col="${col}" style="background:none;border:none;padding:0 2px 0 0;cursor:pointer;line-height:1;font-size:0.85em;color:${color}" title="${title}">${icon}</button>`;
    };

    table.innerHTML = `
        <div class="pools-overview-header">
            <span>${poolFilterSelect}</span>
            <span class="col-r" style="display:flex;align-items:center;justify-content:flex-end;gap:3px">${_poolsSortBtn('apr',tr('liq.sort_apr', 'Nach APR sortieren'))}${aprSelect}</span>
            <span class="col-r" style="display:flex;align-items:center;justify-content:flex-end;gap:3px">${_poolsSortBtn('vol',tr('liq.sort_volume', 'Nach Volumen sortieren'))}VOL 24h</span>
            <span class="col-r" style="display:flex;align-items:center;justify-content:flex-end;gap:3px">${_poolsSortBtn('tvl',tr('liq.sort_tvl', 'Nach TVL sortieren'))}TVL</span>
        </div>
        ${pools.map(pool => {
            const rowCls = pool.active ? '' : ' inactive';
            const tvlNum = pool.tvl ?? 0;
            let tvlCls = '';
            if (pool.tvlExitThreshold && tvlNum > 0 && tvlNum < pool.tvlExitThreshold)      tvlCls = ' value-danger';
            else if (pool.tvlWarnThreshold && tvlNum > 0 && tvlNum < pool.tvlWarnThreshold) tvlCls = ' value-warn';
            // APR-Wert je nach Timeframe-Wahl. Tilde-Markierung für Schätzungen.
            // Defensiv-Guard: negative Werte (Mess-Artefakt in beiden Pfaden) → "—".
            const aprRaw = useApr1h ? pool.apr1hDisplay : pool.apr24hDisplay;
            const aprEst = useApr1h ? pool.apr1hEstimated : pool.apr24hEstimated;
            const aprNum = (aprRaw != null && aprRaw >= 0) ? aprRaw : null;
            const _nd = '<span style="color:#64748b;font-size:0.78em">no data</span>';
            const aprVal = aprNum != null
                ? aprNum.toLocaleString(NUM_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %'
                : _nd;
            return `
        <div class="pools-overview-row${rowCls}">
            <span>${escHtml(pool.displayPair ?? pool.pair ?? '—')}</span>
            <span class="col-r"><span class="pool-apr-clickable" data-pool-pair="${escHtml(pool.pair ?? '')}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">${aprVal}</span></span>
            <span class="col-r"><span class="vol-clickable" data-pool-pair="${escHtml(pool.pair ?? '')}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">${pool.volume24h == null ? _nd : fmtVol(pool.volume24h)}</span></span>
            <span class="col-r"><span class="tvl-clickable${tvlCls}" data-pool-pair="${escHtml(pool.pair ?? '')}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">${pool.tvl == null ? _nd : fmtTvl(pool.tvl)}</span></span>
        </div>`;
        }).join('')}`;

    // Scrollbalken nur bei > 5 sichtbaren Einträgen (analog active-pools-table).
    if (pools.length > 5) {
        table.style.maxHeight = '237px';
        table.style.overflowY = 'auto';
    } else {
        table.style.maxHeight = '';
        table.style.overflowY = '';
    }

    // Pool-Filter-Select: Wert speichern, Tabelle neu rendern.
    const visSel = table.querySelector('#poolsVisFilterSelect');
    if (visSel) {
        visSel.addEventListener('mousedown', e => e.stopPropagation());
        visSel.addEventListener('click',     e => e.stopPropagation());
        visSel.addEventListener('change', e => {
            _poolsVisFilter = ['active', 'inactive'].includes(e.target.value) ? e.target.value : 'all';
            localStorage.setItem(LS_POOLS_VIS_FILTER, _poolsVisFilter);
            _poolsSortCol = null; _poolsSortDir = 'desc';
            localStorage.setItem(LS_POOLS_SORT_COL, ''); localStorage.setItem(LS_POOLS_SORT_DIR, 'desc');
            if (_lastData) renderPools(_lastData);
        });
    }

    // APR-TF-Select: Wert speichern, Tabelle neu rendern.
    const aprSel = table.querySelector('#poolsAprTfSelect');
    if (aprSel) {
        aprSel.addEventListener('mousedown',  e => e.stopPropagation());
        aprSel.addEventListener('click',      e => e.stopPropagation());
        aprSel.addEventListener('change', e => {
            _poolsAprTf = e.target.value === '1h' ? '1h' : '24h';
            localStorage.setItem(LS_POOLS_APR_TF, _poolsAprTf);
            if (_lastData) renderPools(_lastData);
        });
    }

    // Sortier-Buttons (APR/VOL/TVL): Spalte/Richtung speichern, Tabelle neu rendern.
    table.querySelectorAll('[data-sort-col]').forEach(btn => {
        btn.addEventListener('click', () => {
            const col = btn.dataset.sortCol;
            if (_poolsSortCol === col) {
                _poolsSortDir = _poolsSortDir === 'desc' ? 'asc' : 'desc';
            } else {
                _poolsSortCol = col;
                _poolsSortDir = 'desc';
            }
            localStorage.setItem(LS_POOLS_SORT_COL, _poolsSortCol ?? '');
            localStorage.setItem(LS_POOLS_SORT_DIR, _poolsSortDir);
            if (_lastData) renderPools(_lastData);
        });
    });
}

// ── Operative Metriken ────────────────────────────────────────────────────────

function renderActivePositions(data) {
    const container = $('activePoolsContainer');
    const emptyMsg  = $('activePoolsEmpty');
    if (!container) return;

    const activeSearchInputEl = document.getElementById('activePoolsSearchInput');
    if (data?.botActive === false) {
        if (emptyMsg) emptyMsg.style.display = 'none';
        if (activeSearchInputEl) activeSearchInputEl.style.display = 'none';
        container.querySelector('.active-pools-table')?.remove();
        renderBotInactivePanel(container, tr('liq.no_open_positions', 'Keine offenen Positionen'));
        return;
    }
    if (activeSearchInputEl) activeSearchInputEl.style.display = '';
    removeBotInactivePanel(container);

    // Sortierung nach InvestScore des zugehörigen Pools
    const _poolsById = Object.fromEntries((data?.pools ?? []).map(p => [p.id, p]));
    const positions = [...(data?.positions ?? [])].filter(p => p.active).sort((a, b) => {
        const pa = _poolsById[a.poolId], pb = _poolsById[b.poolId];
        return comparePoolSortKeys(
            poolSortKey(pa?.investScore, pa?.sortRank, a.displayPair ?? a.pair),
            poolSortKey(pb?.investScore, pb?.sortRank, b.displayPair ?? b.pair),
        );
    });

    // Suchfilter anwenden
    const _activeSearchQ = _activeSearchQuery.trim().toLowerCase();
    const filteredPositions = _activeSearchQ
        ? positions.filter(p => (p.displayPair ?? p.pair ?? '').toLowerCase().includes(_activeSearchQ))
        : positions;

    // Aktive Pools ohne offene Position → "Eröffnung ausstehend"-Zeilen
    const positionPoolIds = new Set(positions.map(p => p.poolId));
    const pendingPools = (data?.pools ?? [])
        .filter(p => p.active && !positionPoolIds.has(p.id))
        .filter(p => !_activeSearchQ || (p.displayPair ?? p.pair ?? '').toLowerCase().includes(_activeSearchQ))
        .sort((a, b) => (a.displayPair ?? a.pair ?? '').localeCompare(b.displayPair ?? b.pair ?? ''));

    let table = container.querySelector('.active-pools-table');
    if (!table) {
        table = document.createElement('div');
        table.className = 'active-pools-table';
        container.appendChild(table);
    }

    if (filteredPositions.length === 0 && pendingPools.length === 0) {
        if (emptyMsg) emptyMsg.style.display = 'none';
        table.style.maxHeight = '';
        table.style.overflowY = '';
        table.innerHTML = `
            <div class="active-pools-header">
                <span>${tr('liq.active_pools', 'Aktive Pools')}</span>
                <span>Range</span>
                <span class="col-r">${tr('liq.reb', 'Reb.')}</span>
                <span class="col-r">${tr('liq.fees', 'Fees')}</span>
                <span class="col-r">${tr('liq.share', 'Anteil')}</span>
            </div>
            <div class="pools-overview-empty-row">${positions.length === 0 ? tr('liq.no_active_positions_plain', 'Keine aktiven Positionen') : tr('liq.no_matches', 'Keine Treffer')}</div>`;
        _bindActiveSearch();
        return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    // Tages-Zähler je Pool aus data.rebalances (Berlin-TZ-Tagesstart).
    // Match über poolId — pair-Felder können sich zwischen rebalances (displayPair)
    // und positions (internal pair) unterscheiden, daher poolId nutzen.
    const _tzNow      = data?.timestamp ? new Date(data.timestamp) : new Date();
    const _todayStart = new Date(_tzNow); _todayStart.setHours(0, 0, 0, 0);
    const rebalanceCountByPool = {};
    for (const r of (data?.rebalances ?? [])) {
        if (r.rebalancedAt >= _todayStart.getTime()) {
            rebalanceCountByPool[r.poolId] = (rebalanceCountByPool[r.poolId] ?? 0) + 1;
        }
    }

    const _rangeIconSvg = `<svg width="14" height="10" viewBox="0 0 14 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <line x1="1" y1="2" x2="1" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="13" y1="2" x2="13" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="1" y1="5" x2="13" y2="5" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="7" cy="5" r="2" fill="currentColor"/>
    </svg>`;

    table.innerHTML = `
        <div class="active-pools-header">
            <span>${tr('liq.active_pools', 'Aktive Pools')}</span>
            <span class="has-tooltip" data-tooltip-title="Range" data-tooltip-content="${tr('liq.tip.range_open', 'Öffnet die aktuelle Kursrange und Coin-Verteilung der Position.')}" data-tooltip-type="text" style="cursor:default">Range</span>
            <span class="col-r has-tooltip" data-tooltip-title="Rebalances" data-tooltip-content="${tr('liq.tip.rebalances', 'Anzahl der Rebalancings heute. Ein Rebalancing schließt die aktuelle Position und öffnet sie mit angepasster Kursrange neu.')}" data-tooltip-type="text" style="cursor:default">${tr('liq.reb', 'Reb.')}</span>
            <span class="col-r">${tr('liq.fees', 'Fees')}</span>
            <span class="col-r">${tr('liq.share', 'Anteil')}</span>
        </div>
        ${filteredPositions.map(pos => {
            const pair    = escHtml(pos.displayPair ?? pos.pair ?? '—');
            const partVal = pos.myValue != null ? fmtUsdc(pos.myValue) + ' USDC' : '—';
            let partValCls = '';
            const rbCnt   = rebalanceCountByPool[pos.poolId] ?? 0;
            // Zahl immer klickbar — auch "0", damit Monatsstatistik der Pools
            // ohne heutige Rebalances erreichbar bleibt. Bei 0 visuell dezenter.
            const rbCls   = rbCnt > 0 ? '' : ' text-muted';
            const rbHtml  = `<span class="rebalance-clickable${rbCls}" data-pool-id="${escHtml(pos.poolId ?? '')}" data-pool-pair="${escHtml(pos.pair ?? '')}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">${rbCnt}</span>`;
            const _claimCnt = pos.todayClaimCount ?? 0;
            const _claimUsd = pos.todayClaimUsd   ?? 0;
            const _feeTodayDate = new Intl.DateTimeFormat(NUM_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: window.FORGE_TZ || 'Europe/Berlin' }).format(new Date());
            const _feeTtTitle   = `${pair}: Fees ${_feeTodayDate}`;
            const _feeTtContent = `${_claimCnt} Claims (${fmtUsdc(_claimUsd)} USDC)`;
            const _pnlToday     = pos.todayPnlUsd;
            const _pnlSign      = _pnlToday != null && _pnlToday >= 0 ? '+' : '';
            const _pnlTodayDate = new Intl.DateTimeFormat(NUM_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: window.FORGE_TZ || 'Europe/Berlin' }).format(new Date());
            const _pnlPct       = _pnlToday != null && pos.myValue != null && pos.myValue !== 0 ? (_pnlToday / pos.myValue) * 100 : null;
            const _pnlTodayBlock = `${_pnlTodayDate} (heute, ab 00:00 Uhr):\n${_pnlToday != null
                ? `${_pnlSign}${fmtUsdc(_pnlToday)} USDC${_pnlPct != null ? ` (${fmtPct(_pnlPct)})` : ''}`
                : '—'}`;
            const _pnlDep       = pos.sinceDepositPnlUsd;
            const _pnlDepSign   = _pnlDep != null && _pnlDep >= 0 ? '+' : '';
            const _pnlDepPct    = _pnlDep != null && pos.myValue != null && pos.myValue !== 0 ? (_pnlDep / pos.myValue) * 100 : null;
            if (_pnlDepPct != null) partValCls = _pnlDepPct > 1 ? 'value-good' : _pnlDepPct < -1 ? 'value-danger' : '';
            const _pnlDepDate   = pos.sinceDepositAt != null
                ? new Intl.DateTimeFormat(NUM_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: window.FORGE_TZ || 'Europe/Berlin' }).format(new Date(pos.sinceDepositAt))
                : null;
            const _pnlDepTime   = pos.sinceDepositAt != null
                ? new Intl.DateTimeFormat(NUM_LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: window.FORGE_TZ || 'Europe/Berlin' }).format(new Date(pos.sinceDepositAt))
                : null;
            const _pnlDepBlock  = _pnlDepDate != null
                ? `${_pnlDepDate}, ${_pnlDepTime} Uhr (letzte Einzahlung):\n${_pnlDep != null
                    ? `${_pnlDepSign}${fmtUsdc(_pnlDep)} USDC${_pnlDepPct != null ? ` (${fmtPct(_pnlDepPct)})` : ''}`
                    : '—'}`
                : null;
            const _pnlTtTitle   = `${pair}: PnL`;
            const _pnlTtContent = [_pnlTodayBlock, _pnlDepBlock].filter(Boolean).join('\n\n');
            return `
        <div class="active-pools-row">
            <span>${pair}</span>
            <button class="range-icon-btn" data-pool-pair="${escHtml(pos.pair ?? '')}">${_rangeIconSvg}</button>
            <span class="col-r">${rbHtml}</span>
            <span class="col-r"><span class="fees-clickable has-tooltip" data-pool-pair="${escHtml(pos.pair ?? '')}" data-tooltip-title="${escHtml(_feeTtTitle)}" data-tooltip-content="${escHtml(_feeTtContent)}" data-tooltip-type="text" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">${pos.feesPendingUsd != null ? fmtUsdc(pos.feesPendingUsd) + ' USDC' : '—'}</span></span>
            <span class="col-r"><span class="composition-clickable has-tooltip${partValCls ? ' ' + partValCls : ''}" data-pool-pair="${escHtml(pos.pair ?? '')}" data-tooltip-title="${escHtml(_pnlTtTitle)}" data-tooltip-content="${escHtml(_pnlTtContent)}" data-tooltip-type="text" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">${partVal}</span></span>
        </div>`;
        }).join('')}
        ${pendingPools.map(pool => {
            const pair = escHtml(pool.displayPair ?? pool.pair ?? '—');
            return `
        <div class="active-pools-row" style="opacity:0.5">
            <span>${pair}</span>
            <span style="color:var(--text-secondary);font-size:0.75em;grid-column:2/6">${tr('liq.position_opening', 'Position wird eröffnet …')}</span>
        </div>`;
        }).join('')}`;

    if (filteredPositions.length + pendingPools.length > 5) {
        table.style.maxHeight = '237px';
        table.style.overflowY = 'auto';
    } else {
        table.style.maxHeight = '';
        table.style.overflowY = '';
    }

    _bindActiveSearch();
}

function _bindActiveSearch() {
    const input = document.getElementById('activePoolsSearchInput');
    if (!input || input.dataset.bound) return;
    input.dataset.bound = '1';
    input.value = _activeSearchQuery;
    input.addEventListener('input', () => {
        _activeSearchQuery = input.value;
        localStorage.setItem(LS_ACTIVE_SEARCH, _activeSearchQuery);
        if (_lastData) renderActivePositions(_lastData);
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            input.value = '';
            _activeSearchQuery = '';
            localStorage.setItem(LS_ACTIVE_SEARCH, '');
            if (_lastData) renderActivePositions(_lastData);
        }
    });
}

// ── Transaktionen rendern ─────────────────────────────────────────────────────

const TX_LABELS = {
    open_position:  'Einzahlung',
    close_position: 'Auszahlung',
    deposit:        'Einzahlung',
    withdraw:       'Auszahlung',
    withdraw_full:  tr('liq.pool_emptied', 'Pool geleert'),
    claim:          tr('liq.fee_claim', 'Fee Claim'),
    reinvest:       'Reinvest',
    rebalance:      'Rebalance',
    compounding:    'Compounding',
    'fee-transfer': tr('liq.fee_transfer', 'Fee Transfer'),
};

function txLabel(tx) {
    if (tx.type === 'deposit' && (tx.note?.startsWith('cleanup') || tx.note?.startsWith('Auto-Top-Up'))) return 'Cleanup';
    if (tx.type === 'swap' && tx.note?.startsWith('stuck-dust swap')) return tr('liq.dust_swap_24h', 'Dust Swap 24h');
    if (tx.type === 'swap' && tx.note?.startsWith('dust swap')) return tr('liq.dust_swap', 'Dust Swap');
    return TX_LABELS[tx.type] ?? tx.type;
}

function txRow(time, type, pool, amount, link, tipHtml = null) {
    const amtSpan = `<span class="col-r tx-amount">${amount}</span>`;
    return `
        <div class="tx-row">
            <span class="tx-time">${time}</span>
            <span class="tx-type">${type}</span>
            <span class="tx-pool">${pool}</span>
            ${amtSpan}
            <span class="col-r tx-hash">${link}</span>
        </div>`;
}

function txToRows(tx, solPrice) {
    const tokens = tx.pool?.split('/') ?? ['TokenA', 'TokenB'];
    const txLink = tx.txHash
        ? `<a href="https://solscan.io/tx/${escHtml(tx.txHash)}" target="_blank" rel="noopener" title="Solscan">🔗</a>`
        : '—';
    const time = fmtTsHtml(tx.createdAt);
    const type = escHtml(txLabel(tx));
    // Für Swaps: Swap-Pfad aus note extrahieren (z.B. "cleanup swap USDC→WBTC" → "USDC→WBTC",
    // aber auch "sol-topup USDC→SOL" ohne das Wort "swap" im Text — daher nur auf den
    // TOKEN→TOKEN-Pfeil matchen, nicht zusätzlich das Wort "swap" verlangen)
    let details;
    if (tx.type === 'swap') {
        const match = tx.note?.match(/(\S+→\S+)/);
        details = escHtml(match ? match[1] : (tx.pool ?? '—'));
    } else {
        details = escHtml(tx.pool ?? '—');
    }

    // Claim + Reinvest: usd_value bevorzugen; Fallback auf amountA × solPrice nur für SOL/USDC-Historie
    if (tx.type === 'claim' || tx.type === 'reinvest') {
        let totalUsdc;
        if (tx.amount != null) {
            totalUsdc = tx.amount;
        } else {
            const valA = (tx.amountA ?? 0) * solPrice;
            const valB = tx.amountB ?? 0;
            totalUsdc = valA + valB;
        }
        const amount    = totalUsdc > 0 ? fmtUsdc(totalUsdc) + ' USDC'
                        : tx.amount != null ? '0.00 USDC' : '—';
        const txEnriched = { ...tx, amount: Math.round(totalUsdc * 100) / 100 };
        const tip = buildTxAmountTooltip(txEnriched, solPrice);
        return txRow(time, type, details, amount, txLink, tip);
    }

    // Alle anderen Typen: eine Zeile mit optionalem Detail-Tooltip
    const amount = tx.amount != null ? fmtUsdc(tx.amount) + ' USDC' : '—';
    const tip    = buildTxAmountTooltip(tx, solPrice);
    return txRow(time, type, details, amount, txLink, tip);
}

// ── Statistiken-Section ──────────────────────────────────────────────────────

function renderStatistics(data) {
    const p = data?.portfolio ?? {};
    const now = data?.timestamp ? new Date(data.timestamp) : new Date();

    // Datum-Labels (mit Jahr)
    const fmtDate = d => d.toLocaleDateString(NUM_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const today = new Date(now); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const monthStart = new Date(today); monthStart.setDate(1);

    const todayLabel     = fmtDate(today);
    const yesterdayLabel = fmtDate(yesterday);
    const [td, tm, ty]   = todayLabel.split('.');
    const monthLabel     = `01.–${td}.${tm}.${ty}`;

    const el = id => document.getElementById(id);
    const setDate = (id, txt) => { const e = el(id); if (e) e.textContent = txt; };
    setDate('statDateToday',     todayLabel);
    setDate('statDateYesterday', yesterdayLabel);
    setDate('statDateMonth',     monthLabel);

    // LMB#0167 – single source: Payed-Fees-in-USDC kommen vorberechnet aus export.js
    // (konsistenter solPrice + FORGE_TZ-Datum). Dashboard zeigt nur an, rechnet nicht.
    const fmtPayedClickable = vUsdc =>
        `<span class="stat-value-number clickable-value">−${fmtUsdc(+vUsdc || 0)}</span><span class="stat-value-unit">USDC</span>`;
    const fmtUsdcClickable = v =>
        `<span class="stat-value-number clickable-value">+${fmtUsdc(+v || 0)}</span><span class="stat-value-unit">USDC</span>`;
    const fmtPct  = (v, sign = true) => {
        const abs = Math.abs(+v || 0);
        const prefix = sign ? ((+v || 0) >= 0 ? '+' : '−') : '';
        return `<span class="stat-value-number">${prefix}${Number(abs).toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span><span class="stat-value-unit">%</span>`;
    };

    // APR + Netto: vorberechnet in export.js (single source, LMB#0167).
    const todayApr     = p.apr?.today     ?? 0;
    const yesterdayApr = p.apr?.yesterday ?? 0;
    const monthApr     = p.apr?.month     ?? 0;

    const setVal = (id, html, type) => {
        const e = el(id);
        if (!e) return;
        e.innerHTML = html;
        if (type !== undefined) e.dataset.type = type;
    };
    const pctType  = v => v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral';
    const usdcType = v => v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral';

    // PnL-Formatierung (Portfoliowert-Differenz, kann positiv oder negativ sein)
    const fmtPnl = v => {
        if (v == null) return '<span class="text-muted" style="font-size:0.78em">no data</span>';
        const pos = v >= 0;
        return `<span class="stat-value-number">${pos ? '+' : '−'}${fmtUsdc(Math.abs(v))}</span><span class="stat-value-unit">USDC</span>`;
    };

    // Heute
    setVal('statPayedFeesToday',    fmtPayedClickable(p.payedFeesUsdc?.today ?? 0));
    setVal('statClaimedFeesToday',  fmtUsdcClickable(p.feesToday    ?? 0));
    setVal('statRenditeToday',      fmtPct(todayApr),      pctType(todayApr));
    setVal('statPnlToday',          fmtPnl(p.pnlToday ?? null), p.pnlToday != null ? usdcType(p.pnlToday) : 'neutral');

    // Gestern
    setVal('statPayedFeesYesterday',   fmtPayedClickable(p.payedFeesUsdc?.yesterday ?? 0));
    setVal('statClaimedFeesYesterday', fmtUsdcClickable(p.feesYesterday   ?? 0));
    setVal('statRenditeYesterday',     fmtPct(yesterdayApr),     pctType(yesterdayApr));
    setVal('statPnlYesterday',         fmtPnl(p.pnlYesterday ?? null), p.pnlYesterday != null ? usdcType(p.pnlYesterday) : 'neutral');

    // Monat
    setVal('statPayedFeesMonth',   fmtPayedClickable(p.payedFeesUsdc?.month ?? 0));
    setVal('statClaimedFeesMonth', fmtUsdcClickable(p.feesMonth   ?? 0));
    setVal('statRenditeMonth',     fmtPct(monthApr),     pctType(monthApr));
    setVal('statPnlMonth',         fmtPnl(p.pnlMonth ?? null), p.pnlMonth != null ? usdcType(p.pnlMonth) : 'neutral');

    // Top-Card APR: rolling 24h – vorberechnet in export.js (single source, LMB#0167).
    const apr24h   = p.apr24h ?? null;
    const topEl    = document.getElementById('renditeValue');
    const topGroup = document.getElementById('renditeGroup');
    if (topEl) {
        if (apr24h != null) {
            const sign = apr24h >= 0 ? '+' : '−';
            topEl.textContent = sign + Math.abs(apr24h).toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            topGroup?.setAttribute('data-type', apr24h > 0 ? 'positive' : apr24h < 0 ? 'negative' : 'neutral');
        } else {
            topEl.textContent = '0,00';
            topGroup?.setAttribute('data-type', 'neutral');
        }
    }

    // Klick-Handler Payed Fees
    const pfe = el('statPayedFeesToday');
    if (pfe) pfe.onclick = () => openPayedFeesModal('today', data);
    const pfy = el('statPayedFeesYesterday');
    if (pfy) pfy.onclick = () => openPayedFeesModal('yesterday', data);
    const pfm = el('statPayedFeesMonth');
    if (pfm) pfm.onclick = () => openPayedFeesModal('month', data);

    // Klick-Handler Claimed Fees
    const cft = el('statClaimedFeesToday');
    if (cft) cft.onclick = () => openClaimedFeesModal('today', data);
    const cfy = el('statClaimedFeesYesterday');
    if (cfy) cfy.onclick = () => openClaimedFeesModal('yesterday', data);
    const cfm = el('statClaimedFeesMonth');
    if (cfm) cfm.onclick = () => openClaimedFeesModal('month', data);
}

// ── Payed-Fees-Modal ─────────────────────────────────────────────────────────

function openPayedFeesModal(period, data) {
    const p     = data?.portfolio ?? {};
    const modal = document.getElementById('payedFeesModal');
    const title = document.getElementById('payedFeesModalTitle');
    const body  = document.getElementById('payedFeesModalBody');
    if (!modal) return;

    const now = data?.timestamp ? new Date(data.timestamp) : new Date();
    const _tz = window.FORGE_TZ || 'Europe/Berlin';
    const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const monthStart = new Date(todayStart); monthStart.setDate(1);

    const fromMs = period === 'today'     ? todayStart.getTime()
                 : period === 'yesterday' ? yesterdayStart.getTime()
                 :                          monthStart.getTime();
    const toMs   = period === 'yesterday' ? todayStart.getTime() : null;

    const fmtDE = ms => new Intl.DateTimeFormat(NUM_LOCALE,
        { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: _tz }
    ).format(new Date(ms));
    const fmtDT = ms => new Intl.DateTimeFormat(NUM_LOCALE,
        { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: _tz }
    ).format(new Date(ms));

    const todayDE   = fmtDE(todayStart.getTime());
    const [td, tm, ty] = todayDE.split('.');
    const dateLabel = period === 'today'     ? todayDE
                    : period === 'yesterday' ? fmtDE(yesterdayStart.getTime())
                    :                          `01.–${td}.${tm}.${ty}`;
    const labels = { today: 'Heute', yesterday: 'Gestern', month: 'Monat' };
    title.textContent = `TX-Fees – ${labels[period] ?? period}: ${dateLabel}`;

    const txs = (data?.transactions ?? []).filter(t =>
        t.txFeeSol != null && t.createdAt >= fromMs && (toMs === null || t.createdAt < toMs)
    );
    const total = period === 'today'     ? (p.txFeesToday     ?? 0)
                : period === 'yesterday' ? (p.txFeesYesterday ?? 0)
                :                          (p.txFeesMonth     ?? 0);



    if (txs.length === 0) {
        body.innerHTML = `<p class="empty-state" style="padding:1rem">${tr('liq.no_tx_period', '— Keine Transaktionen im Zeitraum')}</p>`;
    } else {
        const rows = txs.map(t => `<tr>
            <td style="white-space:nowrap">${fmtDT(t.createdAt)}</td>
            <td>${txLabel(t)}</td>
            <td>${t.pool ?? '—'}</td>
            <td style="text-align:right">${t.txFeeSol.toFixed(6)}&nbsp;SOL</td>
        </tr>`).join('');
        body.innerHTML = `
            <div class="fees-table-scroll">
                <table class="wallet-detail-table">
                    <thead><tr><th>Zeit</th><th>Typ</th><th>Pool</th><th>${tr('liq.tx_fee', 'TX-Fee')}</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <table class="wallet-detail-table">
                <tfoot><tr class="wallet-detail-total">
                    <td colspan="3">Gesamt</td>
                    <td style="text-align:right">${(+total || 0).toFixed(6)}&nbsp;SOL</td>
                </tr></tfoot>
            </table>`;
    }
    modal.style.display = 'flex';
}

function initPayedFeesModal() {
    const modal    = document.getElementById('payedFeesModal');
    const closeBtn = document.getElementById('payedFeesModalClose');
    if (!modal) return;
    closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none';
    });
}

// ── Claimed-Fees-Modal ───────────────────────────────────────────────────────

function openClaimedFeesModal(period, data) {
    const p     = data?.portfolio ?? {};
    const modal = document.getElementById('claimedFeesModal');
    const title = document.getElementById('claimedFeesModalTitle');
    const body  = document.getElementById('claimedFeesModalBody');
    if (!modal) return;

    const now = data?.timestamp ? new Date(data.timestamp) : new Date();
    const _tz = window.FORGE_TZ || 'Europe/Berlin';
    const todayStart     = new Date(now); todayStart.setHours(0,0,0,0);
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const monthStart     = new Date(todayStart); monthStart.setDate(1);

    const fromMs = period === 'today'     ? todayStart.getTime()
                 : period === 'yesterday' ? yesterdayStart.getTime()
                 :                          monthStart.getTime();
    const toMs   = period === 'yesterday' ? todayStart.getTime() : null;
    const isMonth = period === 'month';

    const fmtDE = ms => new Intl.DateTimeFormat(NUM_LOCALE,
        { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: _tz }
    ).format(new Date(ms));
    const fmtDT = ms => new Intl.DateTimeFormat(NUM_LOCALE,
        { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: _tz }
    ).format(new Date(ms));
    const isoDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: _tz }).format(new Date(ms));

    const todayDE      = fmtDE(todayStart.getTime());
    const [td, tm, ty] = todayDE.split('.');
    const dateLabel = period === 'today'     ? todayDE
                    : period === 'yesterday' ? fmtDE(yesterdayStart.getTime())
                    :                          `01.–${td}.${tm}.${ty}`;
    const labels = { today: 'Heute', yesterday: 'Gestern', month: 'Monat' };
    title.textContent = `Claimed Fees – ${labels[period] ?? period}: ${dateLabel}`;

    const entries = (data?.claimHistory ?? []).filter(e =>
        e.claimedAt >= fromMs && (toMs === null || e.claimedAt < toMs)
    );

    // Authoritative total
    const total = period === 'today'     ? (p.feesToday     ?? 0)
                : period === 'yesterday' ? (p.feesYesterday ?? 0)
                :                          (p.feesMonth     ?? 0);
    const count = period === 'today'     ? entries.length
                : period === 'yesterday' ? entries.length
                :                          entries.length;

    // Pair → Token-A-Symbol (auf Anzeige-Pair anwenden, nicht DB-Pair)
    const displayOf = e => e.displayPair ?? e.pair ?? '—';
    const tokenA    = pair => pair?.split('/')[0] ?? '?';

    const buildTable = (cols, rows) => {
        if (rows.length === 0) {
            return `<p class="empty-state" style="padding:1rem">${tr('liq.no_entries_period', '— Keine Einträge im Zeitraum')}</p>`;
        }
        const ths = cols.map(c => `<th${c.right ? ' style="text-align:right"' : ''}>${c.label}</th>`).join('');
        const trs = rows.map(cells => `<tr>${cells.map((c, i) => {
            const s = cols[i]?.right ? ' style="text-align:right"' : '';
            return `<td${s}>${c.val}</td>`;
        }).join('')}</tr>`).join('');
        return `
            <div class="fees-table-scroll">
                <table class="wallet-detail-table">
                    <thead><tr>${ths}</tr></thead>
                    <tbody>${trs}</tbody>
                </table>
            </div>
            <table class="wallet-detail-table">
                <tfoot><tr class="wallet-detail-total">
                    <td colspan="${cols.length - 1}">Gesamt (${count} Claim${count !== 1 ? 's' : ''})</td>
                    <td style="text-align:right">+${fmtUsdc(+total || 0, 4)}&nbsp;USDC</td>
                </tr></tfoot>
            </table>`;
    };

    let html;
    if (isMonth) {
        // Tagesaggregation pro Pool
        const byDayPool = new Map();
        for (const e of entries) {
            const disp = displayOf(e);
            const key = `${isoDay(e.claimedAt)}|${disp}`;
            if (!byDayPool.has(key)) byDayPool.set(key, { day: isoDay(e.claimedAt), pair: disp, count: 0, usd: 0 });
            const g = byDayPool.get(key);
            g.count++;
            g.usd += e.usdValue ?? 0;
        }
        const rows = [...byDayPool.values()]
            .sort((a, b) => a.day.localeCompare(b.day) || a.pair.localeCompare(b.pair))
            .map(g => {
                const [y, m, d] = g.day.split('-');
                return [
                    { val: `${d}.${m}.${y}` },
                    { val: g.pair },
                    { val: `${g.count} Claim${g.count !== 1 ? 's' : ''}` },
                    { val: `+${fmtUsdc(g.usd, 4)}&nbsp;USDC`, right: true },
                ];
            });
        html = buildTable(
            [{ label: tr('liq.date', 'Datum') }, { label: 'Pool' }, { label: 'Claims' }, { label: 'Gegenwert', right: true }],
            rows
        );
    } else {
        // Einzeleinträge – ein Eintrag pro Claim, Menge zeigt beide Token-Seiten
        const rows = entries.map(e => {
            const disp = displayOf(e);
            const [symA, symB] = (disp ?? 'A/B').split('/');
            const aA   = +e.amountA || 0;
            const aB   = +e.amountB || 0;
            const usd  = +(e.usdValue) || 0;
            const parts = [];
            if (aA > 0) parts.push(`${aA.toFixed(6)}&nbsp;${escHtml(symA ?? '?')}`);
            if (aB > 0) parts.push(`${aB.toFixed(6)}&nbsp;${escHtml(symB ?? '?')}`);
            return [
                { val: fmtDT(e.claimedAt) },
                { val: disp },
                { val: parts.join('&nbsp;+&nbsp;') || '—' },
                { val: `+${fmtUsdc(usd, 4)}&nbsp;USDC`, right: true },
            ];
        });
        html = buildTable(
            [{ label: 'Zeit' }, { label: 'Pool' }, { label: tr('liq.quantity', 'Menge') }, { label: 'Gegenwert', right: true }],
            rows
        );
    }

    body.innerHTML = html;
    modal.style.display = 'flex';
}

function initClaimedFeesModal() {
    const modal    = document.getElementById('claimedFeesModal');
    const closeBtn = document.getElementById('claimedFeesModalClose');
    if (!modal) return;
    closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none';
    });
}

function renderTransactions(data) {
    const list = $('txList');
    if (!list) return;
    const txs = (data?.transactions ?? []).slice(0, 25);
    const solPool = (data?.pools ?? []).find(p => p.pair === 'SOL/USDC');
    const solPrice = solPool?.price ?? 0;
    if (txs.length === 0) {
        list.innerHTML = '<p class="empty-state">— Keine Transaktionen</p>';
        return;
    }
    list.innerHTML = txs.map(tx => txToRows(tx, solPrice)).join('');
}

// ── Header: Status + Letztes Update ──────────────────────────────────────────

function renderHeader(data) {
    const el      = $('lastUpdate');
    const titleEl = $('headerTitle');
    if (!el) return;

    const iconEl       = $('botStateIcon');

    // Bewusst gestoppter Bot (bin/svc stop bzw. Settings-Toggle): bot.js schreibt
    // 'offline' beim Graceful-Shutdown als letzten Export-Wert, bevor der Prozess
    // endet (siehe SIGTERM-Handler). data.timestamp altert danach zwangsläufig —
    // das ist dann aber kein Alarm, sondern erwartetes Verhalten. Statt des roten
    // Blink-Dreiecks zeigen wir explizit "Bot deaktiviert", nichts blinkt mehr.
    if (data?.botState === 'offline') {
        el.textContent = tr('liq.bot_disabled', 'Bot deaktiviert');
        el.className   = 'last-update';
        if (iconEl) { iconEl.textContent = '⏸'; iconEl.className = 'bot-state-icon state-paused'; }
        if (titleEl) titleEl.className = '';
        setVal('footerVersion', data.version ? 'v' + data.version : '');
        return;
    }

    if (!data?.timestamp) {
        setLastUpdate(null);
        if (iconEl) { iconEl.textContent = '⚠'; iconEl.className = 'bot-state-icon state-stale'; }
        if (titleEl) titleEl.className = '';
        return;
    }

    const ageSec = (Date.now() - new Date(data.timestamp)) / 1000;

    setLastUpdate(data.timestamp);

    if (ageSec < 600) {
        if (iconEl) { iconEl.textContent = '▶'; iconEl.className = 'bot-state-icon state-running'; }
    } else if (ageSec < 900) {
        if (iconEl) { iconEl.textContent = '⚠'; iconEl.className = 'bot-state-icon state-waiting'; }
    } else {
        if (iconEl) { iconEl.textContent = '⚠'; iconEl.className = 'bot-state-icon state-stale'; }
    }

    // Header-Titel blinkt/pulsiert bewusst NICHT mehr bei alten Daten (2026-08-07,
    // Fund: ein absichtlich deaktivierter Bot lässt data.timestamp zwangsläufig
    // altern — das sah wie ein Alarm aus, obwohl alles wie gewünscht lief). Der
    // kleine Status-Icon (iconEl, oben) bleibt als dezenter Hinweis bestehen.
    if (titleEl) titleEl.className = '';

    setVal('footerVersion', data.version ? 'v' + data.version : '');
}

// ── Notifications ─────────────────────────────────────────────────────────────

let _lastData = null;

function renderNotifs(data) {
    // Das Brief-Icon führt jetzt ins Message Center (siehe initMessageBell()).
    // Wartungsmodus und SOL-Limit liefen früher als dauerhafte Inline-Banner hier
    // oben auf der Seite (bis 2026-07-28) – beide Ereignisse laufen bereits über
    // die zentrale Nexus-Notification-Pipeline (wallet-monitor sol_low-Alert bzw.
    // Bot-Lifecycle-Meldungen bei Start/Stop) und landen dort als System-Nachricht
    // im Message Center; ein zusätzliches, permanent sichtbares Banner war doppelt
    // gemoppelt und zu aufdringlich (z.B. während eines geplanten Wartungsfensters).
    // Das Brief-Icon zeigt stattdessen ein Badge, sobald eine neue System-Nachricht
    // eingetroffen ist (siehe js/message-bell.js). Das letzte verbliebene Inline-Banner
    // ("Score-Daten veraltet") ist seit der Umstellung des Message-Systems auf
    // Zustandswechsel-Benachrichtigungen (2026-08-03, siehe core/premium/server.js)
    // ebenfalls entfernt – der Premium-Ausfall wird jetzt dort einmalig gemeldet
    // (die alte Dauer-Meldung war dadurch redundant geworden).
    //
    // Score-Zustand sichtbar machen (Entscheidung 2026-07-25, Icon statt Banner seit
    // 2026-07-26 – die Dauerzustand-Meldung "Premium inaktiv" war als permanente
    // Banner-Zeile zu präsent). Ein Nutzer darf trotzdem nie rätseln, warum keine
    // Bewertung erscheint — und muss wissen, welche Notausstiege davon betroffen sind
    // und welche unabhängig weiterlaufen. Steht jetzt im Tooltip des Header-Icons.
    const premiumIcon = document.getElementById('premiumStatusIcon');
    const premiumCountdownText = document.getElementById('premiumCountdownText');
    if (premiumIcon) {
        const active = hasPremiumAccess(data);
        // Dritter Zustand (2026-07-29): Auto-Pay ist aus, aber die zuletzt bezahlte
        // Stunde läuft noch – der Nutzer hat aktiv abgeschaltet und soll wissen,
        // wann die Tabelle tatsächlich leer wird, statt es einfach zu erleben.
        // Nur relevant bei scoreSource==='delivered' (Fork); auf dem Master
        // (scoreSource==='compute') gibt es kein Auto-Pay, autoPayEnabled ist
        // dort immer false und coveredUntilMs immer null → showCountdown bleibt aus.
        // Bis 2026-07-31 pulsierte hierfür die Krone – zu unruhig, ersetzt durch
        // den Restlaufzeit-Text rechts daneben (siehe premiumCountdownText).
        const coveredUntil  = data?.premiumCoveredUntilMs ?? null;
        // 🔒 `coverageSource === 'paid'` ist Pflicht (2026-08-13): Bei der
        // Systemdaten-Freigabe ist Auto-Pay dauerhaft aus UND es liegt eine Deckung
        // vor — ohne diese Bedingung träfe genau das die Abschalt-Anzeige darunter
        // und meldete "Der Premium Service ist deaktiviert", während er in
        // Wirklichkeit läuft und stündlich weiterläuft. Für Zahler ändert die
        // Bedingung nichts: dort war coveredUntil ohnehin nur bei 'paid' gesetzt.
        const showCountdown = active && data?.scoreSource === 'delivered'
            && !data?.premiumAutoPayEnabled && coveredUntil != null
            && data?.premiumCoverageSource === 'paid';

        premiumIcon.classList.toggle('active', active);
        if (showCountdown) {
            premiumIcon.dataset.tooltipTitle   = 'Premium';
            premiumIcon.dataset.tooltipContent = tr('liq.premium_disabled', 'Der Premium Service ist deaktiviert.');
        } else {
            // 2026-08-14: Kein eigener Tooltip-Zustand mehr für coverageSource==='shared'
            // — ein Freigabe-Teilnehmer sieht denselben Zustand wie ein Zahler.
            premiumIcon.dataset.tooltipTitle = active ? tr('liq.premium_active', 'Premium aktiv') : tr('liq.premium_inactive', 'Premium inaktiv');
            premiumIcon.dataset.tooltipContent = active
                ? 'Premium-Datendienst aktiv – Opportunity Score und Score-Limit-Exit laufen mit gelieferten Daten.'
                : tr('liq.score_inactive', 'Score-Bewertung nicht aktiv – Opportunity Score und Score-Limit-Exit werden über den Premium-Datendienst geliefert. Trailing Stop und TVL-Schutz arbeiten unabhängig davon weiter.');
        }

        if (premiumCountdownText) {
            premiumCountdownText.classList.toggle('hidden', !showCountdown);
            if (showCountdown) {
                premiumCountdownText.textContent = formatPremiumCountdown(coveredUntil);
                premiumCountdownText.dataset.tooltipTitle   = 'Premium';
                premiumCountdownText.dataset.tooltipContent = tr('liq.premium_disabled', 'Der Premium Service ist deaktiviert.');
            }
        }
    }
}

// ── Bell-Interaktion ──────────────────────────────────────────────────────────

// Brief-Icon → Message Center (nur LAN). Ersetzt das frühere Notification-Panel.
// Verdrahtung zentral in js/message-bell.js.


// ── Chart-Hilfsfunktionen ─────────────────────────────────────────────────────

const RANGE_DEFS = [
    { key: '1D',  label: '1D' },
    { key: '1W',  label: '1W' },
    { key: '1M',  label: '1M' },
];

function filterByRange(arr, range, getTs) {
    const cutoff = { '1D': 86_400_000, '1W': 7 * 86_400_000, '1M': 30 * 86_400_000 }[range];
    if (!cutoff) return arr;
    const since = Date.now() - cutoff;
    return arr.filter(r => getTs(r) >= since);
}

function xLabel(ts, range) {
    const d = new Date(ts);
    if (range === '1D') {
        return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }
    return `${d.getDate()}.${String(d.getMonth()+1).padStart(2,'0')}.`;
}

function updateChartRangeBtns(containerId, history, getTs, getRange, setRange, rerender, defs = RANGE_DEFS) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (container.childElementCount === 0) {
        defs.forEach(def => {
            const btn = document.createElement('button');
            btn.className   = 'chart-range-btn';
            btn.dataset.range = def.key;
            btn.textContent = def.label;
            btn.addEventListener('click', () => { setRange(def.key); syncRangeBtns(containerId, def.key); rerender(); });
            container.appendChild(btn);
        });
    }
    syncRangeBtns(containerId, getRange());
}

function syncRangeBtns(containerId, active) {
    document.querySelectorAll(`#${containerId} .chart-range-btn`).forEach(b => {
        b.classList.toggle('active', b.dataset.range === active);
    });
}

// ── Chart-Range localStorage-Keys ────────────────────────────────────────────

const LS_RANGE = {
    portfolio:   'liquiditybot_chart_portfolio',
    volume:      'liquiditybot_chart_volume',
    myApr:       'liquiditybot_chart_myApr',
    composition: 'liquiditybot_chart_composition',
    posValue:    'liquiditybot_chart_posValue',
    posValueA:   'liquiditybot_chart_posValueA',
    posValueB:   'liquiditybot_chart_posValueB',
    posValuePnl: 'liquiditybot_chart_posValuePnl',
    myAprIL:     'liquiditybot_chart_myAprIL',
    myAprNP:     'liquiditybot_chart_myAprNP',
    rangeChart:  'liquiditybot_chart_range',
    tvl:         'liquiditybot_chart_tvl',
    volModal:    'liquiditybot_chart_volModal',
    oppScore:    'liquiditybot_chart_oppScore',
    metricChart: 'liquiditybot_chart_metricChart',
};

// ── Portfolio-Wert Chart ──────────────────────────────────────────────────────

let _portfolioRange    = localStorage.getItem(LS_RANGE.portfolio) ?? '1D';
let _portfolioResizeOb = null;

/**
 * Zeichnet den Portfolio-Wert-Chart in ein SVG-Element.
 * Wird sowohl vom Inline-Chart als auch vom Modal genutzt.
 *
 * @param {SVGElement} svgEl
 * @param {number}     H          – Höhe in Pixel
 * @param {number}     PAD_L      – Linkes Padding (Y-Labels)
 * @param {number}     PAD_R
 * @param {number}     PAD_T
 * @param {number}     PAD_B      – Unteres Padding (X-Labels)
 * @param {object[]}   history    – Bereits range-gefiltertes [{t, v}]-Array
 * @param {boolean}    filterOl   – Ausreißer filtern (filterSpikes + filterOutliers)
* @returns {object|false}        – geo-Objekt für attachHoverOverlay, oder false
 */
function _buildPortfolioSvg(svgEl, H, PAD_L, PAD_R, PAD_T, PAD_B, history, filterOl) {
    const W  = svgEl.getBoundingClientRect().width || svgEl.parentElement?.clientWidth || 800;
    const cW = W - PAD_L - PAD_R;
    const cH = H - PAD_T - PAD_B;

    const ts     = history.map(r => r.t);
    const rawVs  = history.map(r => r.v);
    const vs     = filterOl ? filterOutliers(filterSpikes(rawVs, 0.20), 3) : rawVs;
    const validVs = vs.filter(v => v !== null);
    if (validVs.length < 2) return false;

    const tMin = Math.min(...ts), tMax = Math.max(...ts);
    let yMin = Math.min(...validVs);
    let yMax = Math.max(...validVs);
    const yRng = yMax - yMin;
    if (yRng < 1) { yMin -= 1; yMax += 1; }
    else          { yMin -= yRng * 0.05; yMax += yRng * 0.08; }

    const sx = t => PAD_L + ((t - tMin) / (tMax - tMin || 1)) * cW;
    const sy = v => PAD_T + (1 - (v - yMin) / (yMax - yMin || 1)) * cH;

    const spanMs   = tMax - tMin;
    const decimals = yRng > 50 ? 0 : 2;

    // Grad-ID eindeutig per SVG-Id (damit Inline + Modal nicht kollidieren)
    const gradId = `pvGrad_${svgEl.id}`;

    // Grid + Y-Labels
    const yAxisCenterY = (PAD_T + cH / 2).toFixed(1);
    let gridLines = `<text class="chart-label" transform="translate(16,${yAxisCenterY}) rotate(-90)" text-anchor="middle">USDC</text>`;
    for (let i = 0; i <= 4; i++) {
        const v = yMin + (yMax - yMin) * i / 4;
        const y = sy(v).toFixed(1);
        gridLines += `<line class="chart-grid" x1="${PAD_L}" x2="${(PAD_L+cW).toFixed(1)}" y1="${y}" y2="${y}"/>`;
        gridLines += `<text class="chart-label chart-label-y" x="${(PAD_L-5).toFixed(1)}" y="${(+y+4).toFixed(1)}">${fmtUsdc(v, decimals)}</text>`;
    }

    // X-Labels
    let xLabels = '';
    for (let i = 0; i <= 4; i++) {
        const t = tMin + spanMs * i / 4;
        xLabels += `<text class="chart-label chart-label-x" x="${sx(t).toFixed(1)}" y="${(PAD_T+cH+16).toFixed(1)}">${xLabel(t, _portfolioRange)}</text>`;
    }

    // Pfad-Segmente (Lücken bei null durch filterOutliers)
    const bottomY = (PAD_T + cH).toFixed(1);
    const segs = [];
    let seg = [];
    for (let i = 0; i < history.length; i++) {
        if (vs[i] === null) { if (seg.length >= 2) segs.push(seg); seg = []; }
        else seg.push({ t: history[i].t, v: vs[i] });
    }
    if (seg.length >= 2) segs.push(seg);

    const lineD = segs.map(s =>
        'M ' + s.map(p => `${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' L ')
    ).join(' ');
    const areaD = segs.map(s => {
        const pts = s.map(p => `${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' L ');
        return `M ${pts} L ${sx(s[s.length-1].t).toFixed(1)},${bottomY} L ${sx(s[0].t).toFixed(1)},${bottomY} Z`;
    }).join(' ');


    // Letzter Datenpunkt: Marker
    const lastSeg = segs[segs.length - 1];
    const lastPt  = lastSeg?.[lastSeg.length - 1];
    const marker  = lastPt
        ? `<circle cx="${sx(lastPt.t).toFixed(1)}" cy="${sy(lastPt.v).toFixed(1)}" r="5" class="price-marker"/>
           <circle cx="${sx(lastPt.t).toFixed(1)}" cy="${sy(lastPt.v).toFixed(1)}" r="8" class="price-marker-ring" opacity="0.4"/>`
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
        <path d="${lineD}" class="chart-line" stroke-linejoin="round" stroke-linecap="round"/>
        ${marker}`;

    return {
        tMin, tMax, spanMs,
        PAD_L, cW, PAD_T, cH, W, H,
        yMin, yMax,
        formatY: v => fmtUsdc(v, decimals) + ' USDC',
    };
}

function renderPortfolioChart(data) {
    const svg      = document.getElementById('portfolioChartSvg');
    const emptyMsg = document.getElementById('portfolioChartEmptyMsg');
    if (!svg) return;

    const history = filterByRange(data?.portfolioHistory ?? [], _portfolioRange, r => r.t);

    if (history.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';

    svg.setAttribute('height', '160');
    _buildPortfolioSvg(svg, 160, 55, 40, 20, 30, history, true);

    if (!_portfolioResizeOb && typeof ResizeObserver !== 'undefined') {
        _portfolioResizeOb = new ResizeObserver(() => { if (_lastData) renderPortfolioChart(_lastData); });
        _portfolioResizeOb.observe(svg.parentElement);
    }
}

// ── Portfolio-Chart-Modal (Gesamt-Karte) ──────────────────────────────────────

function renderDetailPortfolioChart() {
    const svg = document.getElementById('portfolioChartModalSvg');
    if (!svg || !_lastData) return;

    const H       = svg.getBoundingClientRect().height || 380;
    const history = filterByRange(_lastData?.portfolioHistory ?? [], _portfolioRange, r => r.t);
    if (history.length < 2) {
        svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" class="chart-label" dominant-baseline="middle">${tr('liq.no_data_range_plain', 'Keine Daten für diesen Zeitraum')}</text>`;
        return;
    }

    svg.setAttribute('height', H);
    const geo = _buildPortfolioSvg(svg, H, 72, 16, 16, 32, history, true);
    if (geo) attachHoverOverlay(svg, geo);
}

function initPortfolioChartModal() {
    const modal    = document.getElementById('portfolioChartModal');
    const closeBtn = document.getElementById('portfolioChartModalClose');
    if (!modal) return;

    const openModal = () => {
        if (!_lastData) return;
        modal.style.display = 'flex';
        updateChartRangeBtns(
            'portfolioChartModalRangeBtns',
            _lastData?.portfolioHistory ?? [], r => r.t,
            () => _portfolioRange,
            v  => { _portfolioRange = v; localStorage.setItem(LS_RANGE.portfolio, v); },
            () => { renderDetailPortfolioChart(); if (_lastData) renderPortfolioChart(_lastData); }
        );
        requestAnimationFrame(() => requestAnimationFrame(() => renderDetailPortfolioChart()));
    };

    document.getElementById('gesamtValue')?.addEventListener('click', openModal);
    document.getElementById('portfolioChartSvg')?.addEventListener('click', openModal);

    closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none';
    });
}

// ── Fee-Chart (Balkendiagramm geclaimter Fees) ───────────────────────────────

const LS_FEE_RANGE = 'liquiditybot_chart_fee';
let _feeRange    = localStorage.getItem(LS_FEE_RANGE) ?? '1W';
let _feeResizeOb = null;

/**
 * Zeichnet Fee-Balken in ein SVG-Element.
 * Wiederverwendbar für Inline-Chart und Modal.
 *
 * @param {SVGElement} svgEl
 * @param {Array}      fees   – [{date|label, fees}]
 * @param {number}     H      – Höhe in Pixel
 */
function _drawFeeBars(svgEl, fees, H = 160) {
    const W  = svgEl.getBoundingClientRect().width || svgEl.parentElement?.clientWidth || 400;
    svgEl.setAttribute('height', H);
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const PAD_L = 58, PAD_R = 16, PAD_T = 14, PAD_B = 32;
    const cW = W - PAD_L - PAD_R;
    const cH = H - PAD_T - PAD_B;

    const values = fees.map(f => f.fees);
    const maxVal = Math.max(...values, 0.01);
    const margin = maxVal * 0.15;
    const yMin   = 0;
    const yMax   = maxVal + margin;

    const sy     = v => PAD_T + cH - ((v - yMin) / (yMax - yMin || 1)) * cH;
    const bottomY = (PAD_T + cH).toFixed(1);

    // Gitterlinien: 0 + max
    const decimals = maxVal >= 10 ? 2 : 4;
    const gridVals = [0, maxVal / 2, maxVal];
    const gridLines = gridVals.map(v =>
        `<line x1="${PAD_L}" y1="${sy(v).toFixed(1)}" x2="${PAD_L + cW}" y2="${sy(v).toFixed(1)}" class="${v === 0 ? 'chart-zero-line' : 'chart-grid'}"/>` +
        `<text x="${(PAD_L - 5).toFixed(1)}" y="${sy(v).toFixed(1)}" class="chart-label chart-label-y" dominant-baseline="middle">${fmtUsdc(v, decimals)}</text>`
    ).join('');

    const n    = fees.length;
    const step = cW / Math.max(n, 1);
    const barW = Math.max(3, step * 0.65);
    const DAYS = ['So','Mo','Di','Mi','Do','Fr','Sa'];

    const bars = fees.map((f, i) => {
        const cx   = PAD_L + step * i + step / 2;
        const barH = Math.max(1, Math.abs(sy(f.fees) - parseFloat(bottomY)));
        const barY = sy(f.fees);
        let lbl;
        if (f.label) {
            lbl = f.label;
        } else {
            const d = new Date(f.date + 'T12:00:00');
            lbl = n <= 7 ? DAYS[d.getDay()] : `${d.getDate()}.`;
        }
        const lblStep = lbl.includes(':') ? 3 : Math.ceil(n / Math.max(2, Math.floor(cW / 40)));
        const show    = i % lblStep === 0;
        const tipKey  = f.label ?? f.date;
        return `<rect class="fee-bar" data-fees="${f.fees.toFixed(6)}" data-date="${tipKey}"
            x="${(cx - barW / 2).toFixed(1)}" y="${barY.toFixed(1)}"
            width="${barW.toFixed(1)}" height="${barH.toFixed(1)}"
            fill="var(--primary)" opacity="0.82" rx="1"/>` +
            (show ? `<text x="${cx.toFixed(1)}" y="${(PAD_T + cH + 18).toFixed(1)}" class="chart-label chart-label-x" text-anchor="middle">${lbl}</text>` : '');
    }).join('');

    svgEl.innerHTML = `${gridLines}${bars}`;
}

function _getFeeData(data, range) {
    if (range === '1D') {
        const now    = Date.now();
        const cutoff = now - 86_400_000;
        // claimHistory enthaelt ALLE Claims des Monats (transactions ist auf 25 Eintraege limitiert
        // und enthaelt daher bei viel Aktivitaet nur einen Bruchteil der Claims).
        const claims = (data?.claimHistory ?? [])
            .filter(t => t.claimedAt >= cutoff);

        // Alle Stunden im 24h-Fenster vorbelegen (0 USDC)
        const nowHour = new Date(now);
        nowHour.setMinutes(0, 0, 0);
        const buckets = new Map();
        for (let h = 23; h >= 0; h--) {
            const t = new Date(nowHour.getTime() - h * 3_600_000);
            const key = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}-${t.getHours()}`;
            buckets.set(key, { label: `${String(t.getHours()).padStart(2,'0')}:00`, fees: 0, ts: t.getTime() });
        }
        // Claims in die passenden Stunden einbuchen
        for (const t of claims) {
            const d   = new Date(t.claimedAt);
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
            if (buckets.has(key)) buckets.get(key).fees += t.usdValue ?? 0;
        }
        return [...buckets.values()]
            .sort((a, b) => a.ts - b.ts)
            .map(b => ({ label: b.label, fees: parseFloat(b.fees.toFixed(4)) }));
    }
    const days = range === '1W' ? 7 : 30;
    return (data?.dailyFees ?? []).slice(-days);
}

function renderFeeChart(data) {
    const svg      = document.getElementById('feeChartSvg');
    const emptyMsg = document.getElementById('feeChartEmptyMsg');
    if (!svg) return;

    const fees = _getFeeData(data, _feeRange);
    if (fees.length === 0) {
        svg.style.display      = 'none';
        if (emptyMsg) emptyMsg.textContent = data?.botActive === false ? tr('liq.no_open_positions', 'Keine offenen Positionen') : tr('liq.no_fee_data_plain', 'Noch keine Fee-Daten');
        emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';
    _drawFeeBars(svg, fees, 160);

    if (!_feeResizeOb && typeof ResizeObserver !== 'undefined') {
        _feeResizeOb = new ResizeObserver(() => { if (_lastData) renderFeeChart(_lastData); });
        _feeResizeOb.observe(svg.parentElement);
    }
}

function _feeBarTooltipText(bar) {
    const fees    = parseFloat(bar.dataset.fees);
    const dateStr = bar.dataset.date;
    const lbl     = dateStr.includes(':')
        ? `${dateStr} Uhr`
        : new Date(dateStr + 'T12:00:00').toLocaleDateString(NUM_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
    return `${lbl}: ${fmtUsdc(fees, 4)} USDC`;
}

function initFeeBarTooltip() {
    const svg     = document.getElementById('feeChartSvg');
    const wrapper = svg?.closest('.chart-wrapper');
    if (!svg || !wrapper) return;
    attachBarTooltip(svg, wrapper, '.fee-bar', _feeBarTooltipText);
}

function renderDetailFeeChart() {
    const svg = document.getElementById('feeChartModalSvg');
    if (!svg || !_lastData) return;

    const H    = svg.getBoundingClientRect().height || 380;
    const fees = _getFeeData(_lastData, _feeRange);
    if (fees.length === 0) {
        svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" class="chart-label" dominant-baseline="middle">${tr('liq.no_data_range_plain', 'Keine Daten für diesen Zeitraum')}</text>`;
        return;
    }
    _drawFeeBars(svg, fees, H);

    const body = svg.closest('.chart-modal-body');
    if (body) attachBarTooltip(svg, body, '.fee-bar', _feeBarTooltipText);
}

function initFeeChartModal() {
    const modal    = document.getElementById('feeChartModal');
    const closeBtn = document.getElementById('feeChartModalClose');
    if (!modal) return;

    const openModal = () => {
        if (!_lastData) return;
        modal.style.display = 'flex';
        updateChartRangeBtns(
            'feeChartModalRangeBtns',
            _lastData?.dailyFees ?? [], r => new Date(r.date + 'T00:00:00').getTime(),
            () => _feeRange,
            v  => { _feeRange = v; localStorage.setItem(LS_FEE_RANGE, v); },
            () => { renderDetailFeeChart(); if (_lastData) renderFeeChart(_lastData); }
        );
        requestAnimationFrame(() => requestAnimationFrame(() => renderDetailFeeChart()));
    };

    document.getElementById('feeChartSvg')?.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none';
    });

    if (typeof ResizeObserver !== 'undefined') {
        const body = modal.querySelector('.chart-modal-body');
        if (body) new ResizeObserver(() => {
            if (_lastData && modal.style.display !== 'none') renderDetailFeeChart();
        }).observe(body);
    }
}

// ── Volume Chart ─────────────────────────────────────────────────────────────

/** Aggregiert stündliche Candles auf FORGE_TZ-Tages-Summen → [{t: midnightMs, volume}] */
function aggregateDailyVolume(hourlyRows) {
    const byDay = new Map();
    for (const r of hourlyRows) {
        const key = startOfDayMs(new Date(r.t));     // Tages-Start in FORGE_TZ
        byDay.set(key, (byDay.get(key) ?? 0) + (r.volume ?? 0));
    }
    return [...byDay.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, volume]) => ({ t, volume: Math.round(volume) }));
}

let _volRange        = localStorage.getItem(LS_RANGE.volume) ?? '1D';
let _volSelectedPool = null;   // null = ersten verfügbaren Pool wählen
let _volResizeOb     = null;

/**
 * Zeichnet Volumen-Balken in ein SVG-Element.
 * Gemeinsame Render-Funktion für Inline-Chart und Modal.
 *
 * @param {SVGElement} svgEl
 * @param {number}     H        – Höhe in Pixel
 * @param {object[]}   filtered – Bereits gefilterte [{t, volume}]-Datenpunkte
 * @param {string}     range    – Aktiver Range-Key (für X-Labels)
 * @param {string}     clipId   – Eindeutige ClipPath-ID (kein Namenskonflikt)
 * @returns {boolean}           – false wenn keine Daten
 */
function _buildVolSvg(svgEl, H, filtered, range, clipId) {
    if (filtered.length < 1) return false;

    const W   = svgEl.getBoundingClientRect().width || svgEl.parentElement?.clientWidth || 800;
    const pad = { top: 20, right: 50, bottom: 30, left: 58 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    const allTs  = filtered.map(r => r.t);
    const allVol = filtered.map(r => r.volume);
    const minT   = Math.min(...allTs), maxT = Math.max(...allTs);
    let   maxV   = Math.max(...allVol);
    if (maxV <= 0) maxV = 1;
    maxV *= 1.1;

    const color = 'var(--primary)';
    const barW  = Math.max(2, (iW / filtered.length) * 0.7);
    const halfB = barW / 2;

    // X-Mapping um halbe Balkenbreite eingerückt, damit erster und letzter Balken
    // vollständig innerhalb des clipPath liegen statt halb angeschnitten zu sein.
    const xOf = t => pad.left + halfB + ((t - minT) / (maxT - minT || 1)) * (iW - barW);
    const yOf = v => pad.top  + (1 - v / maxV) * iH;

    let html = `<defs><clipPath id="${clipId}"><rect x="${pad.left}" y="${pad.top}" width="${iW}" height="${iH}"/></clipPath></defs>`;
    html += `<g clip-path="url(#${clipId})">`;
    for (const r of filtered) {
        const bx = xOf(r.t) - barW / 2;
        const by = yOf(r.volume);
        const bh = Math.max(1, iH - (by - pad.top));
        html += `<rect class="vol-bar" data-vol="${r.volume}" data-t="${r.t}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="0.75"/>`;
    }
    html += `</g>`;

    for (let i = 0; i <= 4; i++) {
        const v = (maxV / 4) * i;
        const y = yOf(v).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${(pad.left - 5).toFixed(1)}" y="${(+y + 4).toFixed(1)}">${fmtVol(v)}</text>`;
    }
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        html += `<text class="chart-label chart-label-x" x="${xOf(t).toFixed(1)}" y="${(H - 5).toFixed(1)}">${xLabel(t, range)}</text>`;
    }

    const last = filtered[filtered.length - 1];
    html += `<text class="chart-label" x="${(xOf(last.t) + 5).toFixed(1)}" y="${(yOf(last.volume) - 4).toFixed(1)}"
              fill="${color}" font-size="10" font-weight="600">${fmtVol(last.volume)}</text>`;

    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.setAttribute('height', H);
    svgEl.innerHTML = html;
    return true;
}

function _volBarTooltipText(bar) {
    const vol = parseInt(bar.dataset.vol, 10);
    const t   = parseInt(bar.dataset.t, 10);
    const d   = new Date(t);
    const lbl = _volRange === '1D'
        ? `${String(d.getHours()).padStart(2, '0')}:00 Uhr`
        : d.toLocaleDateString(NUM_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
    return `${lbl}: ${fmtVol(vol)}`;
}

function _getVolFiltered(data, poolId, range) {
    const history = data?.volumeHistory ?? [];
    const hourly  = filterByRange(
        history.filter(r => r.poolId === poolId && r.volume != null),
        range, r => r.t
    );
    if (range !== '1D') return aggregateDailyVolume(hourly);

    // Lookup: Stunden-Start (ms) → Volumen-Summe aus vorhandenen Daten
    const lookup = new Map();
    for (const r of hourly) {
        const d = new Date(r.t);
        d.setMinutes(0, 0, 0);
        const key = d.getTime();
        lookup.set(key, (lookup.get(key) ?? 0) + r.volume);
    }
    // Immer exakt 24 Stunden-Slots, fehlende Stunden → 0
    const nowHour = new Date();
    nowHour.setMinutes(0, 0, 0);
    return Array.from({ length: 24 }, (_, i) => {
        const t = nowHour.getTime() - (23 - i) * 3_600_000;
        return { t, poolId, volume: lookup.get(t) ?? 0 };
    });
}

function renderVolumeChart(data) {
    const svg      = document.getElementById('volChartSvg');
    const emptyMsg = document.getElementById('volChartEmptyMsg');
    const select   = document.getElementById('volPoolSelect');
    if (!svg) return;

    const pools = (data?.pools ?? [])
        .filter(p => p.active)
        .sort((a, b) => (a.rankPos ?? 999) - (b.rankPos ?? 999));

    // Dropdown befüllen / aktualisieren
    if (select) {
        const currentIds = [...select.options].map(o => o.value);
        const newIds     = pools.map(p => p.id);
        if (JSON.stringify(currentIds) !== JSON.stringify(newIds)) {
            select.innerHTML = pools.map(p =>
                `<option value="${escHtml(p.id)}">${escHtml(p.displayPair ?? p.pair ?? p.id)}</option>`
            ).join('');
            if (!select.dataset.listenerAdded) {
                select.addEventListener('change', () => {
                    _volSelectedPool = select.value;
                    if (_lastData) { renderVolumeChart(_lastData); renderDetailVolChart(); }
                });
                select.dataset.listenerAdded = 'true';
            }
        }
        if (_volSelectedPool && [...select.options].some(o => o.value === _volSelectedPool)) {
            select.value = _volSelectedPool;
        } else if (select.options.length > 0) {
            _volSelectedPool = select.options[0].value;
            select.value     = _volSelectedPool;
        } else {
            _volSelectedPool = null;
        }
    }

    const poolId = _volSelectedPool ?? pools[0]?.id;
    if (!poolId) {
        svg.style.display = 'none';
        if (emptyMsg) emptyMsg.textContent = data?.botActive === false ? tr('liq.no_open_positions', 'Keine offenen Positionen') : tr('liq.no_active_pool', 'Kein aktiver Pool');
        emptyMsg.style.display = 'block';
        return;
    }

    const filtered = _getVolFiltered(data, poolId, _volRange);
    const ok       = _buildVolSvg(svg, 160, filtered, _volRange, 'volMainClip');
    svg.style.display      = ok ? 'block' : 'none';
    if (emptyMsg) emptyMsg.textContent = tr('liq.volume_building', 'Volumen-Verlauf wird aufgebaut…');
    emptyMsg.style.display = ok ? 'none'  : 'block';

    if (ok) {
        const wrapper = svg.closest('.chart-wrapper');
        if (wrapper) attachBarTooltip(svg, wrapper, '.vol-bar', _volBarTooltipText);
    }

    if (!_volResizeOb && typeof ResizeObserver !== 'undefined') {
        _volResizeOb = new ResizeObserver(() => { if (_lastData) renderVolumeChart(_lastData); });
        _volResizeOb.observe(svg.parentElement);
    }
}

// ── Composition Chart + Modal ─────────────────────────────────────────────────

let _compositionRange    = localStorage.getItem(LS_RANGE.composition) ?? '1W';
let _compositionPool     = null;
let _compositionResizeOb = null;

function renderCompositionChart(data, poolPair, svgId = 'compositionChartSvg', emptyId = 'compositionChartEmptyMsg') {
    const svg      = document.getElementById(svgId);
    const emptyMsg = document.getElementById(emptyId);
    if (!svg) return;

    const pos     = (data?.positions ?? []).find(p => p.pair === poolPair);
    const poolId  = pos?.poolId ?? null;
    const history = (data?.compositionHistory ?? []).filter(r => r.poolId === poolId);
    const filtered = filterByRange(history, _compositionRange, r => r.t)
        .sort((a, b) => a.t - b.t);

    if (filtered.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';

    const [symA, symB] = (displayPairOf(data, poolPair) ?? poolPair ?? 'A/B').split('/');

    const W   = svg.getBoundingClientRect().width || svg.parentElement?.clientWidth || 700;
    const H   = 220;
    const pad = { top: 24, right: 20, bottom: 30, left: 48 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    const ts    = filtered.map(r => r.t);
    const pcts  = filtered.map(r => r.pctA);   // % Token A
    const minT  = Math.min(...ts), maxT = Math.max(...ts);

    const xOf  = t   => pad.left + ((t - minT) / (maxT - minT || 1)) * iW;
    const yOf  = pct => pad.top  + (1 - pct / 100) * iH;

    // ── Boundary-Pfad (Trennlinie A/B) ───────────────────────────────────────
    let boundary = `M ${xOf(ts[0]).toFixed(1)} ${yOf(pcts[0]).toFixed(1)}`;
    for (let i = 1; i < filtered.length; i++)
        boundary += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(pcts[i]).toFixed(1)}`;

    const x0 = xOf(ts[0]).toFixed(1);
    const xN = xOf(ts[ts.length - 1]).toFixed(1);
    const yBottom = yOf(0).toFixed(1);
    const yTop    = yOf(100).toFixed(1);

    // Token A: boundary oben, y=0 (bottom) unten
    const areaA = boundary
        + ` L ${xN} ${yBottom} L ${x0} ${yBottom} Z`;
    // Token B: y=100 (top) oben, boundary unten
    const areaB = `M ${x0} ${yTop} L ${xN} ${yTop}`
        + ` L ${xN} ${yOf(pcts[pcts.length - 1]).toFixed(1)}`
        + boundary.replace(/^M [^ ]+ [^ ]+/, '')   // alle L-Segmente rückwärts nicht nötig, stattdessen:
        + ` L ${x0} ${yOf(pcts[0]).toFixed(1)} Z`;

    // ── SVG aufbauen ──────────────────────────────────────────────────────────
    let html = `<defs>
        <clipPath id="compClip"><rect x="${pad.left}" y="${pad.top}" width="${iW}" height="${iH}"/></clipPath>
    </defs>`;

    // Flächen
    html += `<g clip-path="url(#compClip)">`;
    html += `<path d="${areaB}" fill="var(--success)" opacity="0.25"/>`;
    html += `<path d="${areaA}" fill="var(--primary)" opacity="0.35"/>`;
    html += `<path d="${boundary}" fill="none" stroke="var(--primary)" stroke-width="1.5" opacity="0.8"/>`;
    html += `</g>`;

    // Y-Achse: 0/25/50/75/100 %
    for (let i = 0; i <= 4; i++) {
        const pct = i * 25;
        const y   = yOf(pct).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${pad.left - 5}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${pct}%</text>`;
    }

    // X-Achse
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        html += `<text class="chart-label chart-label-x" x="${xOf(t).toFixed(1)}" y="${H - 5}">${xLabel(t, _compositionRange)}</text>`;
    }

    // Legende
    const legY = pad.top - 8;
    html += `<rect x="${pad.left}" y="${legY - 8}" width="10" height="10" fill="var(--primary)" opacity="0.7" rx="2"/>`;
    html += `<text class="chart-label" x="${pad.left + 14}" y="${legY}" style="font-size:0.65rem">${escHtml(symA)}</text>`;
    html += `<rect x="${pad.left + 60}" y="${legY - 8}" width="10" height="10" fill="var(--success)" opacity="0.6" rx="2"/>`;
    html += `<text class="chart-label" x="${pad.left + 74}" y="${legY}" style="font-size:0.65rem">${escHtml(symB)}</text>`;

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    svg.innerHTML = html;

    // ── Hover ─────────────────────────────────────────────────────────────────
    let _compTip = svg.parentElement?.querySelector('.comp-tooltip');
    if (!_compTip) {
        _compTip = document.createElement('div');
        _compTip.className = 'comp-tooltip chart-tooltip-box';
        _compTip.style.display = 'none';
        svg.parentElement?.appendChild(_compTip);
    }
    let _compLine = svg.querySelector('.comp-crosshair');
    svg._compData  = { filtered, ts, pcts, xOf, yOf, pad, iW, iH, H, symA, symB };

    svg.onmousemove = e => {
        const d = svg._compData;
        if (!d) return;
        const rect  = svg.getBoundingClientRect();
        const svgX  = (e.clientX - rect.left) * (W / rect.width);
        if (svgX < d.pad.left || svgX > W - d.pad.right) { _compTip.style.display='none'; return; }
        // Nächsten Datenpunkt finden
        const ratio = (svgX - d.pad.left) / d.iW;
        const tCur  = minT + ratio * (maxT - minT);
        let best = 0;
        for (let i = 1; i < d.ts.length; i++) {
            if (Math.abs(d.ts[i] - tCur) < Math.abs(d.ts[best] - tCur)) best = i;
        }
        const pt   = d.filtered[best];
        const pctA = pt.pctA;
        const pctB = Math.round((100 - pctA) * 10) / 10;

        // Crosshair-Linie
        const cx = d.xOf(d.ts[best]).toFixed(1);
        let line = svg.querySelector('.comp-crosshair');
        if (!line) {
            line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.classList.add('comp-crosshair');
            line.setAttribute('stroke', 'rgba(255,255,255,0.4)');
            line.setAttribute('stroke-width', '1');
            line.setAttribute('stroke-dasharray', '3 3');
            svg.appendChild(line);
        }
        line.setAttribute('x1', cx); line.setAttribute('x2', cx);
        line.setAttribute('y1', d.pad.top); line.setAttribute('y2', d.pad.top + d.iH);

        _compTip.innerHTML =
            `<span style="color:var(--primary)">&#9632;</span> ${escHtml(d.symA)}: <b>${pctA}%</b> (${fmtUsdc(pt.amountA)} ${escHtml(d.symA)})<br>` +
            `<span style="color:var(--success)">&#9632;</span> ${escHtml(d.symB)}: <b>${pctB}%</b> (${fmtUsdc(pt.amountB)} ${escHtml(d.symB)})`;

        const wRect = svg.parentElement.getBoundingClientRect();
        let tx = e.clientX - wRect.left + 14;
        const tipW = _compTip.offsetWidth || 220;
        if (tx + tipW > wRect.width - 4) tx = e.clientX - wRect.left - tipW - 8;
        _compTip.style.left    = `${tx}px`;
        _compTip.style.top     = `${Math.max(4, e.clientY - wRect.top - 50)}px`;
        _compTip.style.display = 'block';
    };
    svg.onmouseleave = () => { _compTip.style.display = 'none'; };

    if (!_compositionResizeOb && typeof ResizeObserver !== 'undefined') {
        _compositionResizeOb = new ResizeObserver(() => {
            if (_lastData && _compositionPool) renderCompositionChart(_lastData, _compositionPool);
        });
        _compositionResizeOb.observe(svg.parentElement);
    }
}

function openCompositionModal(poolPair, data) {
    _compositionPool = poolPair;
    const modal = $('compositionModal');
    if (!modal) return;
    // Modal-Titel zeigt Orca-Schreibweise (displayPair), nicht das interne pair.
    $('compositionModalTitle').textContent = tr('liq.coin_distribution_prefix', 'Coin-Verteilung: ') + displayPairOf(data, poolPair);
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    updateChartRangeBtns('compositionRangeBtns', data?.compositionHistory ?? [], r => r.t,
        () => _compositionRange,
        v  => { _compositionRange = v; localStorage.setItem(LS_RANGE.composition, v); },
        () => { if (_lastData && _compositionPool) renderCompositionChart(_lastData, _compositionPool); });
    renderCompositionChart(data, poolPair);
}

function closeCompositionModal() {
    $('compositionModal')?.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function initCompositionModal() {
    $('compositionModalClose')?.addEventListener('click', closeCompositionModal);
    $('compositionModal')?.addEventListener('click', e => {
        if (e.target === $('compositionModal')) closeCompositionModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('compositionModal')?.classList.contains('hidden')) closeCompositionModal();
    });
    document.addEventListener('click', e => {
        const link = e.target.closest('.composition-clickable');
        if (link) {
            const poolPair = link.dataset.poolPair;
            if (poolPair && _lastData) openPosValueModal(poolPair, _lastData);
        }
    });
}

// ── Positionswert-Modal (Mein Anteil historisch) ─────────────────────────────

let _posValueRange    = localStorage.getItem(LS_RANGE.posValue)    ?? '1W';
let _posValueRangePnl = localStorage.getItem(LS_RANGE.posValuePnl) ?? '1W';
let _posValuePool     = null;
let _posValueTab      = 'mine';  // aktiver Tab: 'mine' | 'pnl'

/**
 * Zeichnet den LP-Wert-Chart (Tab 1).
 */
function renderPosValueChart(data, poolPair) {
    const svg      = $('posValueChartSvg');
    const emptyMsg = $('posValueChartEmptyMsg');
    if (!svg) return;

    const poolId  = (data?.positions ?? []).find(p => p.pair === poolPair)?.poolId ?? null;
    const history = poolId
        ? (data?.posValueHistory ?? []).filter(r => r.poolId === poolId)
        : [];
    const filtered = filterByRange(history, _posValueRange, r => r.t);

    if (filtered.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';

    const W   = svg.getBoundingClientRect().width || svg.parentElement?.clientWidth || 700;
    const H   = 200;
    const pad = { top: 20, right: 20, bottom: 30, left: 72 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    const ts   = filtered.map(r => r.t);
    const vals = filtered.map(r => r.value);
    const minT = Math.min(...ts), maxT = Math.max(...ts);
    let   minV = Math.min(...vals), maxV = Math.max(...vals);
    const span = maxV - minV;
    if (span < 1) { minV = Math.max(0, minV - 1); maxV += 1; }
    else          { minV = Math.max(0, minV - span * 0.05); maxV += span * 0.05; }

    const xOf = t => pad.left + ((t - minT) / (maxT - minT || 1)) * iW;
    const yOf = v => pad.top  + (1 - (v - minV) / (maxV - minV)) * iH;

    let html = `<defs>
        <linearGradient id="posValGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%"   stop-color="var(--primary)" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
        </linearGradient>
        <clipPath id="posValClip"><rect x="${pad.left}" y="${pad.top}" width="${iW}" height="${iH}"/></clipPath>
    </defs>`;

    for (let i = 0; i <= 4; i++) {
        const v = minV + (maxV - minV) * i / 4;
        const y = yOf(v).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${pad.left - 5}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${fmtUsdc(v)}</text>`;
    }
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        const x = xOf(t).toFixed(1);
        html += `<text class="chart-label chart-label-x" x="${x}" y="${H - 5}" text-anchor="middle">${xLabel(t, _posValueRange)}</text>`;
    }

    let line = `M ${xOf(ts[0]).toFixed(1)} ${yOf(vals[0]).toFixed(1)}`;
    let area = line;
    for (let i = 1; i < filtered.length; i++) {
        line += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
        area += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
    }
    const areaClose = ` L ${xOf(ts[ts.length - 1]).toFixed(1)} ${yOf(minV).toFixed(1)} L ${xOf(ts[0]).toFixed(1)} ${yOf(minV).toFixed(1)} Z`;

    html += `<g clip-path="url(#posValClip)">`;
    html += `<path d="${area + areaClose}" fill="url(#posValGrad)"/>`;
    html += `<path d="${line}" fill="none" stroke="var(--primary)" stroke-width="1.5"/>`;
    html += `</g>`;

    svg.innerHTML = html;
    svg.setAttribute('height', H);

    // Hover-Fadenkreuz mit Achsen-Labels
    attachHoverOverlay(svg, {
        tMin: minT, tMax: maxT, spanMs: maxT - minT,
        PAD_L: pad.left, cW: iW, PAD_T: pad.top, cH: iH,
        yMin: minV, yMax: maxV,
        formatY: v => fmtUsdc(v) + '  USDC',
    });
}

// ── PnL-Chart: rollende 24h-PnL für jeden Zeitpunkt ─────────────────────────
// Y-Achse = "Was hat der Pool in den 24h vor diesem Zeitpunkt verdient/verloren?"
// Endwert (rechts) = aktuelle PnL-1D = Spaltenwert. Konsistent über alle Ranges.
function renderPnLChart(data, poolPair) {
    const svg      = $('posValueChartSvgPnl');
    const emptyMsg = $('posValueChartEmptyMsgPnl');
    if (!svg) return;

    const summaryEl = $('posValuePnlSummary');

    const poolId  = (data?.positions ?? []).find(p => p.pair === poolPair)?.poolId ?? null;
    const fullHist = poolId ? (data?.pnlHistory ?? []).filter(r => r.poolId === poolId) : [];

    // Rolling-24h-PnL pro Punkt: rolling(t) = pnl(t) − pnl(t − 24h)
    // Punkte ohne 24h-Vorgeschichte (z.B. erste 24h nach Pool-Open) werden übersprungen.
    const WINDOW_MS = 24 * 3600 * 1000;
    const rolling = [];
    let baselineIdx = -1;
    for (let i = 0; i < fullHist.length; i++) {
        const targetT = fullHist[i].t - WINDOW_MS;
        while (baselineIdx + 1 < fullHist.length && fullHist[baselineIdx + 1].t <= targetT) {
            baselineIdx++;
        }
        if (baselineIdx < 0) continue;
        rolling.push({ t: fullHist[i].t, pnl1d: fullHist[i].pnlUsd - fullHist[baselineIdx].pnlUsd });
    }

    const filtered = filterByRange(rolling, _posValueRangePnl, r => r.t);

    if (filtered.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        if (summaryEl) summaryEl.textContent = '';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';

    const W   = svg.getBoundingClientRect().width || svg.parentElement?.clientWidth || 700;
    const H   = 200;
    const pad = { top: 20, right: 20, bottom: 30, left: 72 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    const ts   = filtered.map(r => r.t);
    const vals = filtered.map(r => r.pnl1d);
    const last = vals[vals.length - 1];

    if (summaryEl) {
        const fmtSigned = v => (v >= 0 ? '+' : '−') + fmtUsdc(Math.abs(v)) + ' USDC';
        const color = v => v >= 0 ? '#22c55e' : '#ef4444';
        summaryEl.innerHTML =
            `PnL 1D aktuell: <strong style="color:${color(last)}">${fmtSigned(last)}</strong>`;
    }

    const minT = Math.min(...ts), maxT = Math.max(...ts);
    let minV = Math.min(...vals, 0), maxV = Math.max(...vals, 0);
    const span = maxV - minV;
    if (span < 1) { minV -= 1; maxV += 1; }
    else          { minV -= span * 0.05; maxV += span * 0.05; }

    const xOf  = t => pad.left + ((t - minT) / (maxT - minT || 1)) * iW;
    const yOf  = v => pad.top  + (1 - (v - minV) / (maxV - minV)) * iH;
    const zeroY = yOf(0).toFixed(1);

    let html = `<defs><clipPath id="pnlClip"><rect x="${pad.left}" y="${pad.top}" width="${iW}" height="${iH}"/></clipPath></defs>`;

    for (let i = 0; i <= 4; i++) {
        const v = minV + (maxV - minV) * i / 4;
        const y = yOf(v).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${pad.left - 5}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${fmtUsdc(v)}</text>`;
    }
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        const x = xOf(t).toFixed(1);
        html += `<text class="chart-label chart-label-x" x="${x}" y="${H - 5}" text-anchor="middle">${xLabel(t, _posValueRangePnl)}</text>`;
    }
    html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${zeroY}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>`;

    let line = `M ${xOf(ts[0]).toFixed(1)} ${yOf(vals[0]).toFixed(1)}`;
    for (let i = 1; i < vals.length; i++) {
        line += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
    }
    const lastX  = xOf(ts[ts.length - 1]).toFixed(1);
    const firstX = xOf(ts[0]).toFixed(1);
    const baseY  = Math.min(Math.max(+zeroY, pad.top), pad.top + iH);
    const area   = `${line} L ${lastX} ${baseY.toFixed(1)} L ${firstX} ${baseY.toFixed(1)} Z`;
    const areaColor   = last >= 0 ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.12)';
    const strokeColor = last >= 0 ? '#22c55e' : '#ef4444';

    html += `<g clip-path="url(#pnlClip)">`;
    html += `<path d="${area}" fill="${areaColor}"/>`;
    html += `<path d="${line}" fill="none" stroke="${strokeColor}" stroke-width="1.5"/>`;
    html += `</g>`;

    svg.innerHTML = html;
    svg.setAttribute('height', H);

    attachHoverOverlay(svg, {
        tMin: minT, tMax: maxT, spanMs: maxT - minT,
        PAD_L: pad.left, cW: iW, PAD_T: pad.top, cH: iH,
        yMin: minV, yMax: maxV,
        formatY: v => (v >= 0 ? '+' : '−') + fmtUsdc(Math.abs(v)) + '  USDC',
    });
}

/**
 * Zeichnet einen Token-Mengen-Chart (Tab 2 oder 3).
 * @param {string} svgId      Element-ID des SVG
 * @param {string} emptyId    Element-ID der Leer-Meldung
 * @param {object} data       Daten-Objekt (_lastData)
 * @param {string} poolPair   z.B. "SOL/USDC"
 * @param {string} tokenKey   'amountA' oder 'amountB'
 * @param {string} range      '1D' | '1W' | '1M'
 */
function renderTokenAmountChart(svgId, emptyId, data, poolPair, tokenKey, range) {
    const svg      = $(svgId);
    const emptyMsg = $(emptyId);
    if (!svg) return;

    const poolId  = (data?.positions ?? []).find(p => p.pair === poolPair)?.poolId ?? null;
    const history = poolId
        ? (data?.posValueHistory ?? []).filter(r => r.poolId === poolId)
        : [];
    const filtered = filterByRange(history, range, r => r.t);

    if (filtered.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';

    const W   = svg.getBoundingClientRect().width || svg.parentElement?.clientWidth || 700;
    const H   = 200;
    const pad = { top: 20, right: 20, bottom: 30, left: 72 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    // Nur Records mit gesetztem Token-Wert verwenden (Legacy-Snapshots haben null)
    const usable = filtered.filter(r => r[tokenKey] != null);
    if (usable.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    const ts   = usable.map(r => r.t);
    const vals = usable.map(r => r[tokenKey]);
    const minT = Math.min(...ts), maxT = Math.max(...ts);
    let   minV = Math.min(...vals), maxV = Math.max(...vals);
    const span = maxV - minV;
    if (span < 1e-8) { minV = Math.max(0, minV * 0.95); maxV = maxV * 1.05 + 1e-8; }
    else             { minV = Math.max(0, minV - span * 0.05); maxV += span * 0.05; }

    const xOf  = t => pad.left + ((t - minT) / (maxT - minT || 1)) * iW;
    const yOf  = v => pad.top  + (1 - (v - minV) / (maxV - minV || 1)) * iH;

    // Y-Achsen-Format: Dezimalstellen abhängig von Wertgröße
    const absMax = Math.max(Math.abs(maxV), Math.abs(minV));
    const fmtY = v =>
        absMax >= 100  ? fmtUsdc(v, 2) :
        absMax >= 10   ? fmtUsdc(v, 3) :
        absMax >= 1    ? fmtUsdc(v, 4) :
        absMax >= 0.01 ? fmtUsdc(v, 5) :
                         fmtUsdc(v, 6);

    const suffix = tokenKey === 'amountA' ? 'A' : 'B';
    const gradId = `tokAmtGrad${suffix}`;
    const clipId = `tokAmtClip${suffix}`;

    let html = `<defs>
        <linearGradient id="${gradId}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%"   stop-color="var(--primary)" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
        </linearGradient>
        <clipPath id="${clipId}"><rect x="${pad.left}" y="${pad.top}" width="${iW}" height="${iH}"/></clipPath>
    </defs>`;

    for (let i = 0; i <= 4; i++) {
        const v = minV + (maxV - minV) * i / 4;
        const y = yOf(v).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${pad.left - 5}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${fmtY(v)}</text>`;
    }
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        const x = xOf(t).toFixed(1);
        html += `<text class="chart-label chart-label-x" x="${x}" y="${H - 5}" text-anchor="middle">${xLabel(t, range)}</text>`;
    }

    let line = `M ${xOf(ts[0]).toFixed(1)} ${yOf(vals[0]).toFixed(1)}`;
    let area = line;
    for (let i = 1; i < usable.length; i++) {
        line += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
        area += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
    }
    const areaClose = ` L ${xOf(ts[ts.length - 1]).toFixed(1)} ${yOf(minV).toFixed(1)} L ${xOf(ts[0]).toFixed(1)} ${yOf(minV).toFixed(1)} Z`;

    html += `<g clip-path="url(#${clipId})">`;
    html += `<path d="${area + areaClose}" fill="url(#${gradId})"/>`;
    html += `<path d="${line}" fill="none" stroke="var(--primary)" stroke-width="1.5"/>`;
    html += `</g>`;

    svg.innerHTML = html;
    svg.setAttribute('height', H);

    // Hover-Fadenkreuz mit Achsen-Labels
    const symLabel = (displayPairOf(data, poolPair) ?? poolPair ?? 'A/B').split('/')[tokenKey === 'amountA' ? 0 : 1];
    attachHoverOverlay(svg, {
        tMin: minT, tMax: maxT, spanMs: maxT - minT,
        PAD_L: pad.left, cW: iW, PAD_T: pad.top, cH: iH,
        yMin: minV, yMax: maxV,
        formatY: v => fmtY(v) + '  ' + symLabel,
    });
}

/**
 * Zeichnet den Impermanent-Loss-Chart (Tab 4).
 */
function renderILChart(data, poolPair) {
    const svg      = $('myAprChartSvgIL');
    const emptyMsg = $('myAprChartEmptyMsgIL');
    if (!svg) return;

    const poolId  = (data?.positions ?? []).find(p => p.pair === poolPair)?.poolId ?? null;
    const history = poolId
        ? (data?.posValueHistory ?? []).filter(r => r.poolId === poolId && r.ilUsd != null)
        : [];
    const filtered = filterByRange(history, _myAprRangeIL, r => r.t);

    if (filtered.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';

    const W   = svg.getBoundingClientRect().width || svg.parentElement?.clientWidth || 700;
    const H   = 200;
    const pad = { top: 20, right: 20, bottom: 30, left: 72 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    // Outlier-Filter: IQR-basiert (entfernt Transient-Snapshots bei Rebalancing)
    const rawVals = filtered.map(r => r.ilUsd);
    const sorted  = [...rawVals].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lo  = q1 - 3 * iqr;
    const hi  = q3 + 3 * iqr;
    const clean = filtered.filter(r => r.ilUsd >= lo && r.ilUsd <= hi);
    if (clean.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }

    const ts   = clean.map(r => r.t);
    const vals = clean.map(r => r.ilUsd);
    const minT = Math.min(...ts), maxT = Math.max(...ts);
    let   minV = Math.min(...vals), maxV = Math.max(...vals);
    const span = maxV - minV;
    if (span < 1) { minV -= 1; maxV += 1; }
    else          { minV -= span * 0.05; maxV += span * 0.05; }

    const xOf = t => pad.left + ((t - minT) / (maxT - minT || 1)) * iW;
    const yOf = v => pad.top  + (1 - (v - minV) / (maxV - minV)) * iH;

    // Nulllinie berechnen
    const zeroY = yOf(0).toFixed(1);

    let html = `<defs>
        <clipPath id="ilClip"><rect x="${pad.left}" y="${pad.top}" width="${iW}" height="${iH}"/></clipPath>
    </defs>`;

    // Gitternetz + Achsenbeschriftung
    for (let i = 0; i <= 4; i++) {
        const v = minV + (maxV - minV) * i / 4;
        const y = yOf(v).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${pad.left - 5}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${fmtUsdc(v)}</text>`;
    }
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        const x = xOf(t).toFixed(1);
        html += `<text class="chart-label chart-label-x" x="${x}" y="${H - 5}" text-anchor="middle">${xLabel(t, _myAprRangeIL)}</text>`;
    }

    // Nulllinie hervorheben
    html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${zeroY}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>`;

    // Pfad aufbauen
    let line = `M ${xOf(ts[0]).toFixed(1)} ${yOf(vals[0]).toFixed(1)}`;
    for (let i = 1; i < clean.length; i++) {
        line += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
    }

    html += `<g clip-path="url(#ilClip)">`;
    html += `<path d="${line}" fill="none" stroke="#94a3b8" stroke-width="1.5"/>`;
    html += `</g>`;

    svg.innerHTML = html;
    svg.setAttribute('height', H);

    attachHoverOverlay(svg, {
        tMin: minT, tMax: maxT, spanMs: maxT - minT,
        PAD_L: pad.left, cW: iW, PAD_T: pad.top, cH: iH,
        yMin: minV, yMax: maxV,
        formatY: v => fmtUsdc(v) + '  USDC',
    });
}

// ── Renders N-APR chart (Tab 3): pool_score_history.net_apr_pct in % p.a. ────
function renderNPChart(data, poolPair) {
    const svg      = $('myAprChartSvgNP');
    const emptyMsg = $('myAprChartEmptyMsgNP');
    if (!svg) return;

    const poolId  = (data?.positions ?? []).find(p => p.pair === poolPair)?.poolId ?? null;
    const history = poolId
        ? (data?.scoreHistory ?? []).filter(r => r.poolId === poolId)
        : [];
    // Kein IQR-Filter mehr — N-APR ist eine annualisierte Prozentzahl, große
    // Sprünge (z.B. nach Volatilitäts-Spike oder TVL-Drop) sind echte Signale,
    // keine Mess-Artefakte. Der alte Filter aus dem kumulativen NP-Chart
    // hat legitime Vorzeichen-Wechsel als "Ausreißer" weggeschnitten.
    const filtered = filterByRange(history, _myAprRangeNP, r => r.t);

    if (filtered.length < 2) {
        svg.style.display      = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    emptyMsg.style.display = 'none';

    const W   = svg.getBoundingClientRect().width || svg.parentElement?.clientWidth || 700;
    const H   = 200;
    const pad = { top: 20, right: 20, bottom: 30, left: 72 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    const ts   = filtered.map(r => r.t);
    const vals = filtered.map(r => r.netAprPct);
    const minT = Math.min(...ts), maxT = Math.max(...ts);
    let   minV = Math.min(...vals), maxV = Math.max(...vals);
    const span = maxV - minV;
    if (span < 1) { minV -= 1; maxV += 1; }
    else          { minV -= span * 0.05; maxV += span * 0.05; }

    const xOf  = t => pad.left + ((t - minT) / (maxT - minT || 1)) * iW;
    const yOf  = v => pad.top  + (1 - (v - minV) / (maxV - minV)) * iH;
    const zeroY = yOf(0).toFixed(1);

    let html = `<defs>
        <clipPath id="npClip"><rect x="${pad.left}" y="${pad.top}" width="${iW}" height="${iH}"/></clipPath>
    </defs>`;

    for (let i = 0; i <= 4; i++) {
        const v = minV + (maxV - minV) * i / 4;
        const y = yOf(v).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${pad.left - 5}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${v.toFixed(0)}%</text>`;
    }
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        const x = xOf(t).toFixed(1);
        html += `<text class="chart-label chart-label-x" x="${x}" y="${H - 5}" text-anchor="middle">${xLabel(t, _myAprRangeNP)}</text>`;
    }

    html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${zeroY}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>`;

    let line = `M ${xOf(ts[0]).toFixed(1)} ${yOf(vals[0]).toFixed(1)}`;
    for (let i = 1; i < vals.length; i++) {
        line += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
    }

    // Fläche unter der Kurve — grün wenn positiv, gedämpft wenn negativ
    const lastX  = xOf(ts[ts.length - 1]).toFixed(1);
    const firstX = xOf(ts[0]).toFixed(1);
    const baseY  = Math.min(Math.max(+zeroY, pad.top), pad.top + iH);
    const area   = `${line} L ${lastX} ${baseY.toFixed(1)} L ${firstX} ${baseY.toFixed(1)} Z`;
    const areaColor = vals[vals.length - 1] >= 0 ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.1)';

    html += `<g clip-path="url(#npClip)">`;
    html += `<path d="${area}" fill="${areaColor}"/>`;
    html += `<path d="${line}" fill="none" stroke="#94a3b8" stroke-width="1.5"/>`;
    html += `</g>`;

    svg.innerHTML = html;
    svg.setAttribute('height', H);

    attachHoverOverlay(svg, {
        tMin: minT, tMax: maxT, spanMs: maxT - minT,
        PAD_L: pad.left, cW: iW, PAD_T: pad.top, cH: iH,
        yMin: minV, yMax: maxV,
        formatY: v => fmtPct(v),
    });
}

/**
 * Wechselt den aktiven Tab im Positionswert-Modal (Mein Anteil / PnL).
 * @param {'mine'|'pnl'} tab
 */
function _switchPosValueTab(tab) {
    _posValueTab = tab;

    const defs = [
        { key: 'mine', btnId: 'posValueTabLp',  panelId: 'posValuePanelLp'  },
    ];
    defs.forEach(({ key, btnId, panelId }) => {
        const isActive = key === tab;
        $(btnId)?.classList.toggle('active', isActive);
        $(panelId)?.classList.toggle('active', isActive);
    });

    if (!_lastData || !_posValuePool) return;
    if (tab === 'mine')     renderPosValueChart(_lastData, _posValuePool);
    else if (tab === 'pnl') renderPnLChart(_lastData, _posValuePool);
}

function openPosValueModal(poolPair, data) {
    _posValuePool = poolPair;
    const modal = $('posValueModal');
    if (!modal) return;

    $('posValueModalTitle').textContent = tr('liq.my_share_prefix', 'Mein Anteil: ') + displayPairOf(data, poolPair);

    _switchPosValueTab('mine');

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    const posHistory = data?.posValueHistory ?? [];
    updateChartRangeBtns('posValueRangeBtns', posHistory, r => r.t,
        () => _posValueRange,
        v  => { _posValueRange = v; localStorage.setItem(LS_RANGE.posValue, v); },
        () => { if (_lastData && _posValuePool) renderPosValueChart(_lastData, _posValuePool); });

    renderPosValueChart(data, poolPair);
}

function closePosValueModal() {
    $('posValueModal')?.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function initPosValueModal() {
    $('posValueModalClose')?.addEventListener('click', closePosValueModal);
    $('posValueModal')?.addEventListener('click', e => {
        if (e.target === $('posValueModal')) closePosValueModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('posValueModal')?.classList.contains('hidden')) closePosValueModal();
    });

    // Tab-Wechsel verdrahten
    $('posValueModalTabs')?.addEventListener('click', e => {
        const btn = e.target.closest('.modal-tab-btn');
        if (!btn) return;
        const tab = btn.dataset.tab;
        if (tab && tab !== _posValueTab) _switchPosValueTab(tab);
    });
}

// ── Volumen-Chart-Modal ───────────────────────────────────────────────────────

function renderDetailVolChart() {
    const svg = document.getElementById('volChartModalSvg');
    if (!svg || !_lastData) return;

    const H        = svg.getBoundingClientRect().height || 380;
    const poolId   = _volSelectedPool;
    if (!poolId) {
        svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" class="chart-label" dominant-baseline="middle">${tr('liq.no_pool_selected', 'Kein Pool ausgewählt')}</text>`;
        return;
    }
    const filtered = _getVolFiltered(_lastData, poolId, _volRange);
    if (!_buildVolSvg(svg, H, filtered, _volRange, 'volModalMainClip')) {
        svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" class="chart-label" dominant-baseline="middle">${tr('liq.no_data_range_plain', 'Keine Daten für diesen Zeitraum')}</text>`;
    } else {
        const body = svg.closest('.chart-modal-body');
        if (body) attachBarTooltip(svg, body, '.vol-bar', _volBarTooltipText);
    }
}

function initVolChartModal() {
    const modal    = document.getElementById('volChartModal');
    const closeBtn = document.getElementById('volChartModalClose');
    if (!modal) return;

    const openModal = () => {
        if (!_lastData) return;

        // Modal-Pool-Select mit Inline-Select synchronisieren
        const modalSelect = document.getElementById('volChartModalPoolSelect');
        const pools = (_lastData?.pools ?? []).filter(p => p.active);
        if (modalSelect) {
            modalSelect.innerHTML = pools.map(p =>
                `<option value="${escHtml(p.id)}"${p.id === _volSelectedPool ? ' selected' : ''}>${escHtml(p.displayPair ?? p.pair ?? p.id)}</option>`
            ).join('');
            if (!modalSelect.dataset.listenerAdded) {
                modalSelect.addEventListener('change', () => {
                    _volSelectedPool = modalSelect.value;
                    // Inline-Select ebenfalls synchronisieren
                    const inlineSelect = document.getElementById('volPoolSelect');
                    if (inlineSelect) inlineSelect.value = _volSelectedPool;
                    renderDetailVolChart();
                    if (_lastData) renderVolumeChart(_lastData);
                });
                modalSelect.dataset.listenerAdded = 'true';
            } else {
                modalSelect.value = _volSelectedPool ?? '';
            }
        }

        updateChartRangeBtns(
            'volChartModalRangeBtns',
            _lastData?.volumeHistory ?? [], r => r.t,
            () => _volRange,
            v  => { _volRange = v; localStorage.setItem(LS_RANGE.volume, v); },
            () => { renderDetailVolChart(); if (_lastData) renderVolumeChart(_lastData); }
        );
        modal.style.display = 'flex';
        requestAnimationFrame(() => requestAnimationFrame(() => renderDetailVolChart()));
    };

    document.getElementById('volChartSvg')?.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none';
    });

    if (typeof ResizeObserver !== 'undefined') {
        const body = modal.querySelector('.chart-modal-body');
        if (body) new ResizeObserver(() => {
            if (_lastData && modal.style.display !== 'none') renderDetailVolChart();
        }).observe(body);
    }
}

// ── Meine APR Chart + Modal ───────────────────────────────────────────────────

let _myAprRange    = localStorage.getItem(LS_RANGE.myApr)   ?? '1D';
let _myAprRangeIL  = localStorage.getItem(LS_RANGE.myAprIL) ?? '1W';
let _myAprRangeNP  = localStorage.getItem(LS_RANGE.myAprNP) ?? '1W';
let _myAprPool     = null;
let _myAprUseMyApr = false;
let _myAprTab      = 'apr';  // aktiver Tab: 'apr' | 'il' | 'np'
let _myAprResizeOb = null;

function renderMyAprChart(data, poolPair) {
    const svg = document.getElementById('myAprChartSvg');
    if (!svg) return;

    const openPos   = (data?.positions ?? []).find(p => p.pair === poolPair && !p.closedAt);
    const poolId    = openPos?.poolId
                   ?? (data?.pools ?? []).find(p => p.pair === poolPair)?.id
                   ?? null;
    const myHistory = openPos && poolId ? (data?.myAprHistory ?? []).filter(r => r.poolId === poolId) : [];
    const useMyApr  = _myAprUseMyApr && myHistory.length >= 2;
    const history   = useMyApr
        ? myHistory
        : (poolId ? (data?.aprHistory ?? []).filter(r => r.poolId === poolId) : []);
    const filtered  = filterByRange(history, _myAprRange, r => r.t);

    const W   = svg.getBoundingClientRect().width || svg.parentElement.clientWidth || 700;
    const H   = 200;

    svg.style.display = 'block';

    if (filtered.length < 2) {
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" class="chart-label" dominant-baseline="middle">${tr('liq.no_data_range_plain', 'Keine Daten für diesen Zeitraum')}</text>`;
        return;
    }
    const pad = { top: 20, right: 65, bottom: 30, left: 60 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    const ts   = filtered.map(r => r.t);
    const vals = filtered.map(r => useMyApr ? r.myApr : r.apr);
    const minT = Math.min(...ts), maxT = Math.max(...ts);
    let   minV = Math.min(...vals), maxV = Math.max(...vals);
    const span = maxV - minV;
    if (span < 1) { minV = Math.max(0, minV - 1); maxV += 1; }
    else          { minV = Math.max(0, minV - span * 0.05); maxV += span * 0.05; }

    const xOf = t => pad.left + ((t - minT) / (maxT - minT || 1)) * iW;
    const yOf = v => pad.top  + (1 - (v - minV) / (maxV - minV)) * iH;

    let html = `<defs>
        <linearGradient id="aprGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%"   stop-color="var(--primary)" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
        </linearGradient></defs>`;

    for (let i = 0; i <= 4; i++) {
        const v = minV + (maxV - minV) * i / 4;
        const y = yOf(v).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${pad.left - 5}" y="${(+y + 4).toFixed(1)}">${v.toFixed(1)}%</text>`;
    }
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        html += `<text class="chart-label chart-label-x" x="${xOf(t).toFixed(1)}" y="${H - 5}">${xLabel(t, _myAprRange)}</text>`;
    }

    const meanV  = vals.reduce((s, v) => s + v, 0) / vals.length;
    const meanY  = yOf(meanV).toFixed(1);
    html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${meanY}" y2="${meanY}"
        stroke="var(--warning)" stroke-width="1.2" opacity="0.9"/>`;
    html += `<text x="${W - pad.right + 5}" y="${(+meanY + 4).toFixed(1)}"
        class="chart-label" style="fill:var(--warning);font-size:0.6rem;font-weight:600">Ø ${meanV.toFixed(1)}%</text>`;

    let path = `M ${xOf(ts[0]).toFixed(1)} ${yOf(vals[0]).toFixed(1)}`;
    for (let i = 1; i < filtered.length; i++) path += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
    const area = path + ` L ${xOf(ts[ts.length-1]).toFixed(1)} ${H - pad.bottom} L ${xOf(ts[0]).toFixed(1)} ${H - pad.bottom} Z`;
    html += `<path d="${area}" fill="url(#aprGrad)"/>`;
    html += `<path d="${path}" class="chart-line"/>`;

    const lx = xOf(ts[ts.length-1]).toFixed(1);
    const ly = yOf(vals[vals.length-1]).toFixed(1);
    html += `<circle cx="${lx}" cy="${ly}" r="5" class="price-marker"/>`;
    html += `<circle cx="${lx}" cy="${ly}" r="8" class="price-marker-ring" opacity="0.4"/>`;

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = html;

    // Hover-Fadenkreuz via shared chart.js
    attachHoverOverlay(svg, {
        tMin: minT, tMax: maxT, spanMs: maxT - minT,
        PAD_L: pad.left, cW: iW, PAD_T: pad.top, cH: iH,
        yMin: minV, yMax: maxV,
        formatY: v => v.toFixed(2) + '\u202f%',
    });

    if (!_myAprResizeOb && typeof ResizeObserver !== 'undefined') {
        _myAprResizeOb = new ResizeObserver(() => {
            if (_lastData && _myAprPool) renderMyAprChart(_lastData, _myAprPool);
        });
        _myAprResizeOb.observe(svg.parentElement);
    }
}

function _switchMyAprTab(tab) {
    _myAprTab = tab;
    const defs = [
        { key: 'apr', btnId: 'myAprTabApr', panelId: 'myAprPanelApr' },
    ];
    defs.forEach(({ key, btnId, panelId }) => {
        const isActive = key === tab;
        $(btnId)?.classList.toggle('active', isActive);
        $(panelId)?.classList.toggle('active', isActive);
    });

    const titleEl = $('myAprModalTitle');
    if (titleEl && _myAprPool) {
        titleEl.textContent = (_myAprUseMyApr ? 'APR' : tr('liq.pool_apr', 'Pool APR')) + ': ' + displayPairOf(_lastData, _myAprPool);
    }

    if (!_lastData || !_myAprPool) return;
    renderMyAprChart(_lastData, _myAprPool);
}

function openMyAprModal(poolPair, data, initialTab = 'apr') {
    _myAprPool = poolPair;
    const modal = $('myAprModal');
    if (!modal) return;

    const openPos   = (data?.positions ?? []).find(p => p.pair === poolPair && !p.closedAt);
    const poolId    = openPos?.poolId
                   ?? (data?.pools ?? []).find(p => p.pair === poolPair)?.id
                   ?? null;
    const myHistory = openPos && poolId ? (data?.myAprHistory ?? []).filter(r => r.poolId === poolId) : [];
    _myAprUseMyApr  = myHistory.length >= 2;
    const useMyApr  = _myAprUseMyApr;
    const rangeData = useMyApr
        ? myHistory
        : (poolId ? (data?.aprHistory ?? []).filter(r => r.poolId === poolId) : []);

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    const posHistory = poolId ? (data?.posValueHistory ?? []).filter(r => r.poolId === poolId) : [];
    updateChartRangeBtns('myAprRangeBtns', rangeData, r => r.t,
        () => _myAprRange,
        v  => { _myAprRange = v; localStorage.setItem(LS_RANGE.myApr, v); },
        () => { if (_lastData && _myAprPool) renderMyAprChart(_lastData, _myAprPool); });

    _switchMyAprTab('apr');
}

function closeMyAprModal() {
    $('myAprModal')?.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function initMyAprModal() {
    $('myAprModalClose')?.addEventListener('click', closeMyAprModal);
    $('myAprModal')?.addEventListener('click', e => {
        if (e.target === $('myAprModal')) closeMyAprModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('myAprModal')?.classList.contains('hidden')) closeMyAprModal();
    });
    $('myAprModalTabs')?.addEventListener('click', e => {
        const btn = e.target.closest('.modal-tab-btn');
        if (!btn) return;
        const tab = btn.dataset.tab;
        if (tab && tab !== _myAprTab) _switchMyAprTab(tab);
    });
}

// ── TVL Chart + Modal ─────────────────────────────────────────────────────────

const _TVL_VALID_RANGES = new Set(['1D', '1W', '1M']);

let _tvlRange    = _TVL_VALID_RANGES.has(localStorage.getItem(LS_RANGE.tvl) ?? '') ? localStorage.getItem(LS_RANGE.tvl) : '1W';
let _tvlPool     = null;
let _tvlData     = null;   // data bei Modal-Öffnung – hat tvlHistory garantiert
let _tvlResizeOb = null;

function renderTvlChart(data, poolPair) {
    const svg      = document.getElementById('tvlChartSvg');
    if (!svg) return;

    const pool     = (data?.pools ?? []).find(p => p.pair === poolPair) ?? null;
    const poolId   = (data?.positions ?? []).find(p => p.pair === poolPair)?.poolId
                  ?? (data?.pools ?? []).find(p => p.pair === poolPair)?.id
                  ?? null;
    const history  = poolId
        ? (data?.tvlHistory ?? []).filter(r => r.poolId === poolId)
        : [];

    const filtered = filterByRange(history, _tvlRange, r => r.t).sort((a, b) => a.t - b.t);

    if (filtered.length < 2) {
        svg.style.display = 'none';
        return;
    }
    svg.style.display = 'block';

    const W   = svg.getBoundingClientRect().width || svg.parentElement?.clientWidth || 700;
    const H   = 220;
    const pad = { top: 20, right: 60, bottom: 30, left: 60 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    const ts   = filtered.map(r => r.t);
    const vals = filtered.map(r => r.tvl);
    const minT = Math.min(...ts), maxT = Math.max(...ts);

    // TVL-Schutz: L1 (Stufe 1, Teil-Abzug) + L2 (Stufe 2, Voll-Exit).
    // Werte stammen aus den Risk-Management-Settings (settings.db), nicht mehr aus pools.json.
    const warnLine  = pool?.tvlWarnThreshold ?? null;  // L1-Schwelle
    const exitLine  = pool?.tvlExitThreshold ?? null;  // L2-Schwelle
    const allValues = [...vals];
    if (warnLine) allValues.push(warnLine);
    if (exitLine) allValues.push(exitLine);

    let minV = Math.min(...allValues), maxV = Math.max(...allValues);
    const span = maxV - minV;
    if (span < 1) { minV = Math.max(0, minV - 1); maxV += 1; }
    else          { minV = Math.max(0, minV - span * 0.08); maxV += span * 0.08; }

    const xOf = t => pad.left + ((t - minT) / (maxT - minT || 1)) * iW;
    const yOf = v => pad.top  + (1 - (v - minV) / (maxV - minV)) * iH;
    const fmtY = v => v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : (v / 1000).toFixed(0) + 'K';


    let html = `<defs>
        <linearGradient id="tvlGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%"   stop-color="var(--primary)" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
        </linearGradient></defs>`;

    // Grid + Y-Achse
    for (let i = 0; i <= 4; i++) {
        const v = minV + (maxV - minV) * i / 4;
        const y = yOf(v).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${pad.left - 5}" y="${(+y + 4).toFixed(1)}">${fmtY(v)}</text>`;
    }

    // X-Achse
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        html += `<text class="chart-label chart-label-x" x="${xOf(t).toFixed(1)}" y="${H - 5}">${xLabel(t, _tvlRange)}</text>`;
    }

    // Fläche + Linie
    let path = `M ${xOf(ts[0]).toFixed(1)} ${yOf(vals[0]).toFixed(1)}`;
    for (let i = 1; i < filtered.length; i++) path += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
    const area = path + ` L ${xOf(ts[ts.length-1]).toFixed(1)} ${H - pad.bottom} L ${xOf(ts[0]).toFixed(1)} ${H - pad.bottom} Z`;
    html += `<path d="${area}" fill="url(#tvlGrad)"/>`;
    html += `<path d="${path}" class="chart-line"/>`;

    // Warn-Schwelle (gestrichelt)
    if (warnLine != null && warnLine >= minV && warnLine <= maxV) {
        const yW = yOf(warnLine).toFixed(1);
        html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${yW}" y2="${yW}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.9"/>`;
        html += `<text x="${W - pad.right + 4}" y="${(+yW + 4).toFixed(1)}" class="chart-label" style="fill:#f59e0b;font-size:0.6rem;font-weight:600">L1</text>`;
    }

    // Exit-Schwelle (durchgezogen rot)
    if (exitLine != null && exitLine >= minV && exitLine <= maxV) {
        const yE = yOf(exitLine).toFixed(1);
        html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${yE}" y2="${yE}" stroke="#ef4444" stroke-width="1.5" opacity="0.9"/>`;
        html += `<text x="${W - pad.right + 4}" y="${(+yE + 4).toFixed(1)}" class="chart-label" style="fill:#ef4444;font-size:0.6rem;font-weight:600">L2</text>`;
    }

    // Marker letzter Wert
    const lx = xOf(ts[ts.length-1]).toFixed(1);
    const ly = yOf(vals[vals.length-1]).toFixed(1);
    html += `<circle cx="${lx}" cy="${ly}" r="5" class="price-marker"/>`;
    html += `<circle cx="${lx}" cy="${ly}" r="8" class="price-marker-ring" opacity="0.4"/>`;

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    svg.setAttribute('width', '100%');
    svg.innerHTML = html;

    // Hover-Fadenkreuz via shared chart.js
    attachHoverOverlay(svg, {
        tMin: minT, tMax: maxT, spanMs: maxT - minT,
        PAD_L: pad.left, cW: iW, PAD_T: pad.top, cH: iH,
        yMin: minV, yMax: maxV,
        formatY: v => fmtY(v) + ' USDC',
    });

    if (!_tvlResizeOb && typeof ResizeObserver !== 'undefined') {
        _tvlResizeOb = new ResizeObserver(() => {
            const d = (_tvlData?.tvlHistory?.length > 0 ? _tvlData : _lastData);
            if (d && _tvlPool) renderTvlChart(d, _tvlPool);
        });
        _tvlResizeOb.observe(svg.parentElement);
    }
}

function _updateTvlRangeBtns() {
    const container = document.getElementById('tvlRangeBtns');
    if (!container) return;
    if (container.childElementCount === 0) {
        RANGE_DEFS.forEach(def => {
            const btn = document.createElement('button');
            btn.className     = 'chart-range-btn';
            btn.dataset.range = def.key;
            btn.textContent   = def.label;
            btn.addEventListener('click', () => {
                _tvlRange = def.key;
                localStorage.setItem(LS_RANGE.tvl, def.key);
                syncRangeBtns('tvlRangeBtns', def.key);
                // _tvlData bevorzugen: hat tvlHistory garantiert; _lastData nur Fallback
                const d = (_tvlData?.tvlHistory?.length > 0 ? _tvlData : _lastData);
                if (d && _tvlPool) renderTvlChart(d, _tvlPool);
            });
            container.appendChild(btn);
        });
    }
    syncRangeBtns('tvlRangeBtns', _tvlRange);
}

function openTvlModal(poolPair, data) {
    _tvlPool = poolPair;
    _tvlData = data;   // tvlHistory ist hier garantiert vorhanden
    const modal = $('tvlModal');
    if (!modal) return;
    // Modal-Titel zeigt Orca-Schreibweise (displayPair), nicht das interne pair.
    $('tvlModalTitle').textContent = 'TVL: ' + displayPairOf(data, poolPair);
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    _updateTvlRangeBtns();
    renderTvlChart(data, poolPair);
}

function closeTvlModal() {
    $('tvlModal')?.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function initTvlModal() {
    $('tvlModalClose')?.addEventListener('click', closeTvlModal);
    $('tvlModal')?.addEventListener('click', e => {
        if (e.target === $('tvlModal')) closeTvlModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('tvlModal')?.classList.contains('hidden')) closeTvlModal();
    });
    document.addEventListener('click', e => {
        const link = e.target.closest('.tvl-clickable');
        if (link) {
            const poolPair = link.dataset.poolPair;
            if (poolPair && _lastData) openTvlModal(poolPair, _lastData);
        }
    });
}

// ── VOL-Chart-Modal ───────────────────────────────────────────────────────────

const VOL_MODAL_RANGE_DEFS = [
    { key: '1W', label: '1W' },
    { key: '1M', label: '1M' },
];

let _volModalRange    = localStorage.getItem(LS_RANGE.volModal) ?? '1W';
let _volModalPool     = null;
let _volModalResizeOb = null;

function renderVolModalChart(data, poolPair) {
    const svg = document.getElementById('volModalChartSvg');
    if (!svg) return;

    const pool    = (data?.pools ?? []).find(p => p.pair === poolPair);
    const history = (data?.volumeHistory ?? [])
        .filter(r => r.poolId === pool?.id && r.volume != null);

    const filtered = aggregateDailyVolume(
        filterByRange(history, _volModalRange, r => r.t)
    );

    if (filtered.length < 1) {
        svg.style.display = 'none';
        return;
    }
    svg.style.display = 'block';

    const W   = svg.getBoundingClientRect().width || svg.parentElement.clientWidth || 800;
    const H   = 180;
    const pad = { top: 20, right: 55, bottom: 30, left: 60 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    const allTs  = filtered.map(r => r.t);
    const allVol = filtered.map(r => r.volume);
    const minT   = Math.min(...allTs), maxT = Math.max(...allTs);
    const minV   = 0;
    let   maxV   = Math.max(...allVol);
    if (maxV <= 0) maxV = 1;
    maxV *= 1.15;

    const barW  = Math.max(2, (iW / filtered.length) * 0.7);
    const halfB = barW / 2;

    // X-Mapping um halbe Balkenbreite eingerückt, damit erster und letzter Balken
    // vollständig innerhalb des clipPath liegen statt halb angeschnitten zu sein.
    const xOf = t => pad.left + halfB + ((t - minT) / (maxT - minT || 1)) * (iW - barW);
    const yOf = v => pad.top  + (1 - v / maxV) * iH;

    let html = `<defs><clipPath id="volModalClip"><rect x="${pad.left}" y="${pad.top}" width="${iW}" height="${iH}"/></clipPath></defs>`;

    // Bars (geclippt auf inneren Chart-Bereich)
    const color = 'var(--primary)';
    html += `<g clip-path="url(#volModalClip)">`;
    for (const r of filtered) {
        const bx = xOf(r.t) - barW / 2;
        const by = yOf(r.volume);
        const bh = Math.max(1, iH - (by - pad.top));
        html += `<rect class="vol-modal-bar" data-vol="${r.volume}" data-t="${r.t}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="0.75"/>`;
    }
    html += `</g>`;

    // Grid + Y-Labels
    for (let i = 0; i <= 4; i++) {
        const v = (maxV / 4) * i;
        const y = yOf(v).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${pad.left - 5}" y="${(+y + 4).toFixed(1)}">${fmtVol(v)}</text>`;
    }

    // X-Labels
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        html += `<text class="chart-label chart-label-x" x="${xOf(t).toFixed(1)}" y="${H - 5}">${xLabel(t, _volModalRange)}</text>`;
    }

    // Letzter Wert-Label
    const last = filtered[filtered.length - 1];
    const lx   = xOf(last.t).toFixed(1);
    const ly   = yOf(last.volume);
    html += `<text class="chart-label" x="${(+lx + 5).toFixed(1)}" y="${(ly - 4).toFixed(1)}"
              fill="${color}" font-size="10" font-weight="600">${fmtVol(last.volume)}</text>`;

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = html;

    // Balken-Tooltip via shared chart.js
    const volModalWrap = svg.closest('.modal-box') ?? svg.parentElement;
    if (volModalWrap) attachBarTooltip(svg, volModalWrap, '.vol-modal-bar', bar => {
        const d = new Date(parseInt(bar.dataset.t, 10));
        const lbl = d.toLocaleDateString(NUM_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
        return `${lbl}: ${fmtVol(parseInt(bar.dataset.vol, 10))}`;
    });

    if (!_volModalResizeOb && typeof ResizeObserver !== 'undefined') {
        _volModalResizeOb = new ResizeObserver(() => {
            if (_lastData && _volModalPool) renderVolModalChart(_lastData, _volModalPool);
        });
        _volModalResizeOb.observe(svg.parentElement);
    }
}

function _updateVolModalRangeBtns(data) {
    const container = document.getElementById('volModalRangeBtns');
    if (!container) return;
    if (container.childElementCount === 0) {
        VOL_MODAL_RANGE_DEFS.forEach(def => {
            const btn = document.createElement('button');
            btn.className     = 'chart-range-btn';
            btn.dataset.range = def.key;
            btn.textContent   = def.label;
            btn.addEventListener('click', () => {
                _volModalRange = def.key;
                localStorage.setItem(LS_RANGE.volModal, def.key);
                document.querySelectorAll('#volModalRangeBtns .chart-range-btn').forEach(b =>
                    b.classList.toggle('active', b.dataset.range === def.key));
                if (_lastData && _volModalPool) renderVolModalChart(_lastData, _volModalPool);
            });
            container.appendChild(btn);
        });
    }
    document.querySelectorAll('#volModalRangeBtns .chart-range-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.range === _volModalRange));
}

function openVolModal(poolPair, data) {
    _volModalPool = poolPair;
    const modal = $('volModal');
    if (!modal) return;
    // Modal-Titel zeigt Orca-Schreibweise (displayPair), nicht das interne pair.
    $('volModalTitle').textContent = tr('liq.vol24h_prefix', 'VOL 24h: ') + displayPairOf(data, poolPair);
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    _updateVolModalRangeBtns(data);
    renderVolModalChart(data, poolPair);
}

function closeVolModal() {
    $('volModal')?.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function initVolModal() {
    $('volModalClose')?.addEventListener('click', closeVolModal);
    $('volModal')?.addEventListener('click', e => {
        if (e.target === $('volModal')) closeVolModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('volModal')?.classList.contains('hidden')) closeVolModal();
    });
    document.addEventListener('click', e => {
        const link = e.target.closest('.vol-clickable');
        if (link) {
            const poolPair = link.dataset.poolPair;
            if (poolPair && _lastData) openVolModal(poolPair, _lastData);
        }
    });
}

// ── Range-Chart-Modal ─────────────────────────────────────────────────────────

let _rangeChartRange = localStorage.getItem(LS_RANGE.rangeChart) ?? '1D';
let _rangeChartPool  = null;
let _rangeResizeOb   = null;

function renderRangeChart(data, poolPair) {
    const svg      = document.getElementById('rangeChartSvg');
    const emptyMsg = document.getElementById('rangeChartEmptyMsg');
    if (!svg) return;

    const pos = (data?.positions ?? []).find(p => p.pair === poolPair && p.active);
    if (!pos) {
        svg.style.display      = 'none';
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    }

    const { priceLower, priceUpper, priceNow, poolId } = pos;
    const history  = (data?.priceHistory ?? []).filter(r => r.poolId === poolId);
    let   filtered = filterByRange(history, _rangeChartRange, r => r.t);

    // Aktuellen Preis immer als neuesten Punkt anhängen – verhindert veraltete
    // Endpunkte nach Bot-Pausen (z.B. Score-Limit-Exit). Bei 0/1 Punkten zwei
    // synthetische Punkte erzeugen damit Chart.js eine Linie rendern kann.
    if (priceNow != null) {
        if (filtered.length === 0) {
            filtered = [{ t: Date.now() - 60_000, poolId, price: priceNow }];
        }
        filtered = [...filtered, { t: Date.now(), poolId, price: priceNow }];
    }

    if (filtered.length < 2) {
        svg.style.display      = 'none';
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    }
    svg.style.display      = 'block';
    if (emptyMsg) emptyMsg.style.display = 'none';

    const W   = svg.getBoundingClientRect().width || svg.parentElement.clientWidth || 700;
    const H   = 220;
    const pad = { top: 24, right: 100, bottom: 30, left: 70 };
    const iW  = W - pad.left - pad.right;
    const iH  = H - pad.top  - pad.bottom;

    const ts   = filtered.map(r => r.t);
    const vals = filtered.map(r => r.price);
    const minT = Math.min(...ts), maxT = Math.max(...ts);

    const allV = [...vals, priceLower ?? Infinity, priceUpper ?? -Infinity];
    const span = (Math.max(...allV) - Math.min(...allV)) || Math.max(...allV) * 0.1;
    const minV = Math.min(...allV) - span * 0.08;
    const maxV = Math.max(...allV) + span * 0.08;

    const xOf = t => pad.left + ((t - minT) / (maxT - minT || 1)) * iW;
    const yOf = v => pad.top  + (1 - (v - minV) / (maxV - minV)) * iH;

    let html = `<defs>
        <linearGradient id="priceGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%"   stop-color="var(--primary)" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
        </linearGradient></defs>`;

    // Gitter + Y-Achse
    for (let i = 0; i <= 4; i++) {
        const v = minV + (maxV - minV) * i / 4;
        const y = yOf(v).toFixed(1);
        html += `<line class="chart-grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`;
        html += `<text class="chart-label chart-label-y" x="${pad.left - 6}" y="${(+y + 4).toFixed(1)}">${fmtPrice(v, 2)}</text>`;
    }
    // X-Achse
    for (let i = 0; i <= 4; i++) {
        const t = minT + (maxT - minT) * i / 4;
        html += `<text class="chart-label chart-label-x" x="${xOf(t).toFixed(1)}" y="${H - 5}">${xLabel(t, _rangeChartRange)}</text>`;
    }

    // Preislinie + Fläche
    let path = `M ${xOf(ts[0]).toFixed(1)} ${yOf(vals[0]).toFixed(1)}`;
    for (let i = 1; i < filtered.length; i++) path += ` L ${xOf(ts[i]).toFixed(1)} ${yOf(vals[i]).toFixed(1)}`;
    const area = path + ` L ${xOf(ts[ts.length-1]).toFixed(1)} ${H - pad.bottom} L ${xOf(ts[0]).toFixed(1)} ${H - pad.bottom} Z`;
    html += `<path d="${area}" fill="url(#priceGrad)"/>`;
    html += `<path d="${path}" class="chart-line"/>`;

    // Bounds
    if (priceUpper != null) {
        const yU  = yOf(priceUpper).toFixed(1);
        const toU = priceUpper - (priceNow ?? 0);
        const pU  = priceNow ? (toU / priceNow * 100) : 0;
        html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${yU}" y2="${yU}" stroke="var(--success)" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.85"/>`;
        html += `<text x="${W - pad.right + 6}" y="${(+yU + 4).toFixed(1)}" class="chart-label" style="fill:var(--success);font-size:0.6rem;font-weight:600">${fmtPrice(priceUpper, 2)}</text>`;
        html += `<text x="${W - pad.right + 6}" y="${(+yU + 14).toFixed(1)}" class="chart-label" style="fill:var(--success);font-size:0.58rem">+${fmtPrice(toU, 2)} (+${pU.toFixed(1)}%)</text>`;
    }
    if (priceLower != null) {
        const yL  = yOf(priceLower).toFixed(1);
        const toL = (priceNow ?? 0) - priceLower;
        const pL  = priceNow ? (toL / priceNow * 100) : 0;
        html += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${yL}" y2="${yL}" stroke="var(--warning)" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.85"/>`;
        html += `<text x="${W - pad.right + 6}" y="${(+yL + 4).toFixed(1)}" class="chart-label" style="fill:var(--warning);font-size:0.6rem;font-weight:600">${fmtPrice(priceLower, 2)}</text>`;
        html += `<text x="${W - pad.right + 6}" y="${(+yL + 14).toFixed(1)}" class="chart-label" style="fill:var(--warning);font-size:0.58rem">−${fmtPrice(toL, 2)} (−${pL.toFixed(1)}%)</text>`;
    }

    // Aktueller Preis-Marker
    const lx = xOf(ts[ts.length-1]).toFixed(1);
    const ly = yOf(vals[vals.length-1]).toFixed(1);
    html += `<circle cx="${lx}" cy="${ly}" r="5" class="price-marker"/>`;
    html += `<circle cx="${lx}" cy="${ly}" r="8" class="price-marker-ring" opacity="0.4"/>`;

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    svg.innerHTML = html;

    // Hover-Fadenkreuz via shared chart.js
    attachHoverOverlay(svg, {
        tMin: minT, tMax: maxT, spanMs: maxT - minT,
        PAD_L: pad.left, cW: iW, PAD_T: pad.top, cH: iH,
        yMin: minV, yMax: maxV,
        formatY: v => fmtPrice(v, 2) + ' USDC',
    });

    if (!_rangeResizeOb && typeof ResizeObserver !== 'undefined') {
        _rangeResizeOb = new ResizeObserver(() => {
            if (_lastData && _rangeChartPool) renderRangeChart(_lastData, _rangeChartPool);
        });
        _rangeResizeOb.observe(svg.parentElement);
    }
}


function _switchRangeTab(tabKey) {
    document.querySelectorAll('#rangeModalTabs .modal-tab-btn').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.tab === tabKey));
    document.querySelectorAll('#rangeModal .modal-tab-panel').forEach(panel =>
        panel.classList.toggle('active', panel.id === `rangeTab${tabKey.charAt(0).toUpperCase() + tabKey.slice(1)}`));

    if (tabKey === 'range' && _lastData && _rangeChartPool) {
        requestAnimationFrame(() => renderRangeChart(_lastData, _rangeChartPool));
    }
    if (tabKey === 'composition' && _lastData && _rangeChartPool) {
        requestAnimationFrame(() => renderCompositionChart(_lastData, _rangeChartPool, 'rangeCompChartSvg', 'rangeCompEmptyMsg'));
    }
}

function openRangeModal(poolPair, data) {
    const modal = $('rangeModal');
    if (!modal) return;

    _rangeChartPool = poolPair;
    // Modal-Titel zeigt Orca-Schreibweise (displayPair), nicht das interne pair.
    $('rangeModalTitle').textContent = displayPairOf(data, poolPair) ?? 'Pool';

    const pos = (data?.positions ?? []).find(p => p.pair === poolPair && p.active);

    // Range-Buttons für Chart-Tab
    updateChartRangeBtns(
        'rangeChartRangeBtns',
        (data?.priceHistory ?? []).filter(r => r.poolId === pos?.poolId), r => r.t,
        () => _rangeChartRange,
        v  => { _rangeChartRange = v; localStorage.setItem(LS_RANGE.rangeChart, v); },
        () => { if (_lastData && _rangeChartPool) renderRangeChart(_lastData, _rangeChartPool); }
    );

    // Composition-Range-Buttons für den Coin-Verteilung-Tab
    updateChartRangeBtns(
        'rangeCompRangeBtns',
        data?.compositionHistory ?? [], r => r.t,
        () => _compositionRange,
        v  => { _compositionRange = v; localStorage.setItem(LS_RANGE.composition, v); },
        () => { if (_lastData && _rangeChartPool) renderCompositionChart(_lastData, _rangeChartPool, 'rangeCompChartSvg', 'rangeCompEmptyMsg'); }
    );

    // Range-Tab vorauswählen (erstes Tab)
    _switchRangeTab('range');

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => renderRangeChart(data, poolPair));
}

function closeRangeModal() {
    $('rangeModal')?.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function initRangeModal() {
    $('rangeModalClose')?.addEventListener('click', closeRangeModal);
    $('rangeModal')?.addEventListener('click', e => {
        if (e.target === $('rangeModal')) closeRangeModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('rangeModal')?.classList.contains('hidden')) closeRangeModal();
    });

    // Tab-Klick
    document.getElementById('rangeModalTabs')?.addEventListener('click', e => {
        const btn = e.target.closest('.modal-tab-btn');
        if (btn) _switchRangeTab(btn.dataset.tab);
    });
}

// ── Pool-TX-Modal ─────────────────────────────────────────────────────────────

function openPoolTxModal(poolPair, data, opts = {}) {
    const modal = $('poolTxModal');
    if (!modal) return;
    renderPoolTxList(poolPair, data, opts);
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
}

function closePoolTxModal() {
    const modal = $('poolTxModal');
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function renderPoolTxList(poolPair, data, opts = {}) {
    const { typeFilter = null, titlePrefix = tr('liq.last_25_tx', 'Letzte 25 Transaktionen') } = opts;
    const titleEl = $('poolTxModalTitle');
    const listEl  = $('poolTxList');
    if (!listEl) return;

    listEl.style.overflow  = '';
    listEl.style.maxHeight = '';

    // Modal-Titel zeigt Orca-Schreibweise (displayPair), nicht das interne pair.
    if (titleEl) titleEl.textContent = titlePrefix + ': ' + displayPairOf(data, poolPair);

    const isClaimsOnly = typeFilter?.length === 1 && typeFilter[0] === 'claim';
    const txSource = isClaimsOnly ? (data?.recentClaims ?? []) : (data?.transactions ?? []);
    // Filter über interne pair (matcht data-pool-pair-Attribute). tx.pool ist der
    // displayPair-Name, der bei gedrehten Pools (HYPE/SOL etc.) vom internen
    // pair abweicht — daher hier explizit pair statt pool prüfen.
    let txFiltered = txSource.filter(tx => (tx.pair ?? tx.pool) === poolPair);
    if (typeFilter && !isClaimsOnly) txFiltered = txFiltered.filter(tx => typeFilter.includes(tx.type));
    const allTx = txFiltered.slice(0, 25);

    if (allTx.length === 0) {
        listEl.innerHTML = '<div class="tx-modal-empty">— ' + tr('liq.no_tx_pool', 'Keine Transaktionen für diesen Pool') + '</div>';
        return;
    }

    const solPool  = (data?.pools ?? []).find(p => p.pair === 'SOL/USDC');
    const solPrice = solPool?.price ?? 0;

    // Summe: Einzahlungen minus Auszahlungen; Claims/Reinvests via berechneten USDC-Wert
    let netSum = 0;
    for (const tx of allTx) {
        if (tx.type === 'open_position' || tx.type === 'deposit')         netSum += (tx.amount ?? 0);
        else if (tx.type === 'close_position' || tx.type === 'withdraw')  netSum -= (tx.amount ?? 0);
        else if (tx.type === 'claim' || tx.type === 'reinvest')           netSum += tx.amount ?? ((tx.amountA ?? 0) * solPrice + (tx.amountB ?? 0));
    }

    const rows = allTx.map(tx => {
        const time   = fmtTsHtml(tx.createdAt);
        const label  = txLabel(tx);
        const isIn   = tx.type === 'open_position' || tx.type === 'deposit';
        const isOut  = tx.type === 'close_position' || tx.type === 'withdraw';
        const typCls = isIn ? 'tx-type-deposit' : isOut ? 'tx-type-withdraw' : '';
        const amtCls = isIn ? 'tx-amount-deposit' : isOut ? 'tx-amount-withdraw' : '';
        let amount;
        if (tx.amount != null) {
            amount = fmtUsdc(tx.amount) + ' USDC';
        } else if ((tx.type === 'claim' || tx.type === 'reinvest') && (tx.amountA != null || tx.amountB != null)) {
            const total = (tx.amountA ?? 0) * solPrice + (tx.amountB ?? 0);
            amount = total > 0 ? fmtUsdc(total) + ' USDC' : '—';
        } else {
            amount = '—';
        }
        const txLink = tx.txHash
            ? `<a href="https://solscan.io/tx/${escHtml(tx.txHash)}" target="_blank" rel="noopener" title="Solscan">🔗</a>`
            : '—';
        const amtHtml = amount;
        return `<tr>
            <td>${time}</td>
            <td class="${typCls}">${escHtml(label)}</td>
            <td class="tx-amount${amtCls ? ' ' + amtCls : ''}">${amtHtml}</td>
            <td class="tx-hash-col">${txLink}</td>
        </tr>`;
    }).join('');

    const isPos   = netSum >= 0;
    const netCls  = isPos ? 'tx-amount-deposit' : 'tx-amount-withdraw';
    const netStr  = (isPos ? '+' : '') + fmtUsdc(netSum) + ' USDC';
    const netLabel = (typeFilter?.length === 1 && typeFilter[0] === 'claim') ? 'Gesamt' : 'Netto';

    listEl.innerHTML = `
        <table class="tip-orders">
            <thead>
                <tr>
                    <th>${tr('liq.date', 'Datum')}</th>
                    <th>Typ</th>
                    <th class="tx-amount">Betrag</th>
                    <th class="tx-hash-col"></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
                <tr class="tip-total">
                    <td colspan="2">${netLabel}</td>
                    <td class="tx-amount${netCls ? ' ' + netCls : ''}">${netStr}</td>
                    <td></td>
                </tr>
            </tfoot>
        </table>`;
}

// ── Pool-Claim-History-Modal ──────────────────────────────────────────────────

let _claimHistPool = null;
let _claimHistData = null;

function openPoolClaimHistoryModal(poolPair, data) {
    _claimHistPool = poolPair;
    _claimHistData = data;

    const modal   = $('poolTxModal');
    const titleEl = $('poolTxModalTitle');
    if (!modal) return;

    // Modal-Titel zeigt Orca-Schreibweise (displayPair), nicht das interne pair.
    if (titleEl) titleEl.textContent = `Fee Claims: ${displayPairOf(data, poolPair)}`;
    _renderClaimHistTab('today');

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
}

function _renderClaimHistTab(tab) {
    const listEl = $('poolTxList');
    if (!listEl) return;

    listEl.style.overflow  = 'visible';
    listEl.style.maxHeight = 'none';

    const data     = _claimHistData;
    const poolPair = _claimHistPool;
    const now      = data?.timestamp ? new Date(data.timestamp) : new Date();

    const todayStart     = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const monthStart     = new Date(todayStart); monthStart.setDate(1);

    const allEntries       = (data?.claimHistory ?? []).filter(e => e.pair === poolPair);
    const todayEntries     = allEntries.filter(e => e.claimedAt >= todayStart.getTime());
    const yesterdayEntries = allEntries.filter(e =>
        e.claimedAt >= yesterdayStart.getTime() && e.claimedAt < todayStart.getTime());
    const monthEntries     = allEntries.filter(e => e.claimedAt >= monthStart.getTime());

    const _tz     = window.FORGE_TZ || 'Europe/Berlin';
    const isoDay  = ms => new Intl.DateTimeFormat('en-CA', { timeZone: _tz }).format(new Date(ms));
    const fmtTime = ms => new Intl.DateTimeFormat(NUM_LOCALE, {
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: _tz,
    }).format(new Date(ms));

    const tabDefs = [
        { key: 'today',     label: 'Heute',       entries: todayEntries },
        { key: 'yesterday', label: 'Gestern',      entries: yesterdayEntries },
        { key: 'month',     label: tr('liq.this_month', 'Dieser Monat'), entries: monthEntries },
    ];
    const tabsHtml = tabDefs.map(t =>
        `<button class="modal-tab-btn${t.key === tab ? ' active' : ''}" data-claim-tab="${t.key}">${t.label}</button>`
    ).join('');

    const entries  = tabDefs.find(t => t.key === tab)?.entries ?? [];
    const isMonth  = tab === 'month';
    const dp       = displayPairOf(data, poolPair) ?? poolPair ?? 'A/B';
    const tokenA   = dp.split('/')[0] ?? '?';
    const tokenB   = dp.split('/')[1] ?? '?';
    const isUsdcB  = tokenB === 'USDC' || tokenB === 'EURC';

    let rows, cols;
    if (isMonth) {
        const byDay = new Map();
        for (const e of entries) {
            const day = isoDay(e.claimedAt);
            if (!byDay.has(day)) byDay.set(day, { count: 0, usd: 0 });
            const g = byDay.get(day);
            g.count++;
            g.usd += e.usdValue ?? 0;
        }
        rows = [...byDay.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, g]) => {
                const [y, m, d] = day.split('-');
                return `<tr>
                    <td>${d}.${m}.</td>
                    <td>${g.count}&nbsp;Claim${g.count !== 1 ? 's' : ''}</td>
                    <td class="tx-amount">+${g.usd.toFixed(4)}&nbsp;USDC</td>
                </tr>`;
            });
        cols = [{ label: tr('liq.date', 'Datum') }, { label: 'Claims' }, { label: 'Gegenwert', right: true }];
    } else {
        rows = entries.map(e => {
            const aA = +e.amountA || 0;
            const aB = +e.amountB || 0;
            const parts = [];
            if (aA > 0) parts.push(`${aA.toFixed(6)}&nbsp;${tokenA}`);
            if (aB > 0) parts.push(`${aB.toFixed(isUsdcB ? 4 : 6)}&nbsp;${tokenB}`);
            const solscanLink = e.txHash
                ? `&nbsp;<a href="https://solscan.io/tx/${escHtml(e.txHash)}" target="_blank" rel="noopener" title="Solscan">🔗</a>`
                : '';
            const mengeHtml = (parts.length > 0 ? parts.join('&nbsp;+&nbsp;') : '—') + solscanLink;
            return `<tr>
                <td>${fmtTime(e.claimedAt)}</td>
                <td>${mengeHtml}</td>
                <td class="tx-amount">+${(e.usdValue ?? 0).toFixed(4)}&nbsp;USDC</td>
            </tr>`;
        });
        cols = [{ label: 'Zeit' }, { label: tr('liq.quantity', 'Menge') }, { label: 'Gegenwert', right: true }];
    }

    const total      = entries.reduce((s, e) => s + (e.usdValue ?? 0), 0);
    const contentHtml = _buildClaimTable(cols, rows, total, entries.length);

    listEl.innerHTML = `
        <div class="modal-tabs" style="margin:-0.25rem 0 0.75rem">${tabsHtml}</div>
        ${contentHtml}`;

    listEl.querySelectorAll('[data-claim-tab]').forEach(btn =>
        btn.addEventListener('click', () => _renderClaimHistTab(btn.dataset.claimTab))
    );
}

function _buildClaimTable(cols, rows, total, claimCount) {
    if (rows.length === 0) {
        return `<p class="tx-modal-empty">${tr('liq.no_entries_period', '— Keine Einträge im Zeitraum')}</p>`;
    }
    const ths = cols.map(c => `<th${c.right ? ' class="tx-amount"' : ''}>${c.label}</th>`).join('');
    const scrollAttr = rows.length > 5 ? ' style="max-height:165px;overflow-y:auto"' : '';
    return `
        <div${scrollAttr}>
            <table class="tip-orders" style="width:100%">
                <thead><tr>${ths}</tr></thead>
                <tbody>${rows.join('')}</tbody>
            </table>
        </div>
        <table class="tip-orders">
            <tfoot>
                <tr class="tip-total">
                    <td colspan="${cols.length - 1}">Gesamt (${claimCount}&nbsp;Claim${claimCount !== 1 ? 's' : ''})</td>
                    <td class="tx-amount">+${total.toFixed(4)}&nbsp;USDC</td>
                </tr>
            </tfoot>
        </table>`;
}

// ── Pool-Rebalance-History-Modal ──────────────────────────────────────────────
// Analog zu openPoolClaimHistoryModal, aber Datenquelle: data.rebalances.

const REBAL_REASON_LABELS = {
    out_of_range: tr('liq.out_of_range', 'Out of Range'),
    proactive:    'Proaktiv',
    manual:       'Manuell',
    drift:        'Drift',
    rebalance:    'Rebalance',
};

let _rebalHistPoolId = null;
let _rebalHistData   = null;

function openPoolRebalanceModal(poolId, data) {
    _rebalHistPoolId = poolId;
    _rebalHistData   = data;

    const modal   = $('poolTxModal');
    const titleEl = $('poolTxModalTitle');
    if (!modal) return;

    // Titel zeigt displayPair via Pool-Lookup über poolId.
    const pool = (data?.pools ?? []).find(p => p.id === poolId);
    const dispPair = pool?.displayPair ?? pool?.pair ?? poolId;
    if (titleEl) titleEl.textContent = `Rebalance: ${dispPair}`;
    _renderRebalHistTab('today');

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
}

function _renderRebalHistTab(tab) {
    const listEl = $('poolTxList');
    if (!listEl) return;

    listEl.style.overflow  = 'visible';
    listEl.style.maxHeight = 'none';

    const data   = _rebalHistData;
    const poolId = _rebalHistPoolId;
    const now    = data?.timestamp ? new Date(data.timestamp) : new Date();

    const todayStart     = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const monthStart     = new Date(todayStart); monthStart.setDate(1);

    // Filter via poolId (eindeutig, Pair-Strings können sich Display/Internal unterscheiden).
    const allEntries       = (data?.rebalances ?? []).filter(e => e.poolId === poolId);
    const todayEntries     = allEntries.filter(e => e.rebalancedAt >= todayStart.getTime());
    const yesterdayEntries = allEntries.filter(e =>
        e.rebalancedAt >= yesterdayStart.getTime() && e.rebalancedAt < todayStart.getTime());
    const monthEntries     = allEntries.filter(e => e.rebalancedAt >= monthStart.getTime());

    const _tz     = window.FORGE_TZ || 'Europe/Berlin';
    const isoDay  = ms => new Intl.DateTimeFormat('en-CA', { timeZone: _tz }).format(new Date(ms));
    const fmtTime = ms => new Intl.DateTimeFormat(NUM_LOCALE, {
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: _tz,
    }).format(new Date(ms));

    const tabDefs = [
        { key: 'today',     label: 'Heute',        entries: todayEntries },
        { key: 'yesterday', label: 'Gestern',      entries: yesterdayEntries },
        { key: 'month',     label: tr('liq.this_month', 'Dieser Monat'), entries: monthEntries },
    ];
    const tabsHtml = tabDefs.map(t =>
        `<button class="modal-tab-btn${t.key === tab ? ' active' : ''}" data-rebal-tab="${t.key}">${t.label}</button>`
    ).join('');

    const entries  = tabDefs.find(t => t.key === tab)?.entries ?? [];
    const isMonth  = tab === 'month';

    let rows, cols;
    if (isMonth) {
        // Pro Tag aggregiert: Anzahl + Summe Kosten + "Mein Anteil" am Tagesende.
        // entries ist nach rebalancedAt DESC sortiert → der erste Treffer pro Tag
        // ist der jüngste Rebalance des Tages, dessen lpValueAtEvent zeigt
        // den Guthaben-Stand kurz vor diesem Event (≈ Tagesendwert).
        const byDay = new Map();
        for (const e of entries) {
            const day = isoDay(e.rebalancedAt);
            if (!byDay.has(day)) byDay.set(day, { count: 0, costSol: 0, lpValueAtEvent: null });
            const g = byDay.get(day);
            g.count++;
            g.costSol += e.costSol ?? 0;
            // Ersten nicht-null-Wert behalten = jüngster Rebalance mit Snapshot.
            if (g.lpValueAtEvent == null && e.lpValueAtEvent != null) {
                g.lpValueAtEvent = e.lpValueAtEvent;
            }
        }
        rows = [...byDay.entries()]
            .sort(([a], [b]) => b.localeCompare(a))  // neueste oben
            .map(([day, g]) => {
                const [y, m, d] = day.split('-');
                const myShare = g.lpValueAtEvent != null
                    ? `${(+g.lpValueAtEvent).toFixed(2)}&nbsp;USDC`
                    : '—';
                return `<tr>
                    <td>${d}.${m}.</td>
                    <td>${g.count}&nbsp;Rebalance${g.count !== 1 ? 's' : ''}</td>
                    <td class="tx-amount">${myShare}</td>
                    <td class="tx-amount">−${g.costSol.toFixed(6)}&nbsp;SOL</td>
                </tr>`;
            });
        cols = [
            { label: tr('liq.date', 'Datum') },
            { label: 'Rebalances' },
            { label: 'Mein Anteil', right: true },
            { label: 'Kosten',      right: true },
        ];
    } else {
        rows = entries.map(e => {
            const reasonLabel = REBAL_REASON_LABELS[e.reason] ?? e.reason ?? '—';
            const solscanLink = e.txHash
                ? `&nbsp;<a href="https://solscan.io/tx/${escHtml(e.txHash)}" target="_blank" rel="noopener" title="Solscan">🔗</a>`
                : '';
            const costStr  = e.costSol != null ? `−${(+e.costSol).toFixed(6)}&nbsp;SOL` : '—';
            // "Mein Anteil" zum Rebalance-Zeitpunkt — LP-Value aus letztem snapshot
            // vor dem Event. Bei sehr alten Rebalances ggf. null → "—".
            const myShare  = e.lpValueAtEvent != null
                ? `${(+e.lpValueAtEvent).toFixed(2)}&nbsp;USDC`
                : '—';
            return `<tr>
                <td>${fmtTime(e.rebalancedAt)}</td>
                <td>${escHtml(reasonLabel)}</td>
                <td class="tx-amount">${myShare}</td>
                <td class="tx-amount">${costStr}${solscanLink}</td>
            </tr>`;
        });
        cols = [
            { label: 'Zeit' },
            { label: 'Grund' },
            { label: 'Mein Anteil', right: true },
            { label: 'Kosten',      right: true },
        ];
    }

    const totalCost  = entries.reduce((s, e) => s + (e.costSol ?? 0), 0);
    // Pool-Eröffnungsdatum für aussagekräftigen Empty-State (kein Rebalance ≠ kaputt).
    const activePos  = (data?.positions ?? []).find(p => p.poolId === poolId && p.active);
    const contentHtml = _buildRebalTable(cols, rows, totalCost, entries.length, activePos?.openedAt);

    listEl.innerHTML = `
        <div class="modal-tabs" style="margin:-0.25rem 0 0.75rem">${tabsHtml}</div>
        ${contentHtml}`;

    listEl.querySelectorAll('[data-rebal-tab]').forEach(btn =>
        btn.addEventListener('click', () => _renderRebalHistTab(btn.dataset.rebalTab))
    );
}

function _buildRebalTable(cols, rows, totalCost, count, poolOpenedAt) {
    if (rows.length === 0) {
        let msg = '— Keine Rebalances im Zeitraum';
        if (poolOpenedAt) {
            const _tz = window.FORGE_TZ || 'Europe/Berlin';
            const since = new Intl.DateTimeFormat(NUM_LOCALE, {
                day: '2-digit', month: '2-digit', year: 'numeric', timeZone: _tz,
            }).format(new Date(poolOpenedAt));
            msg = `— Keine Rebalances im Zeitraum<br><span class="text-muted" style="font-size:0.78rem">Pool eröffnet am ${since} – seitdem keine Rebalances nötig</span>`;
        }
        return `<p class="tx-modal-empty">${msg}</p>`;
    }
    const ths = cols.map(c => `<th${c.right ? ' class="tx-amount"' : ''}>${c.label}</th>`).join('');
    const scrollAttr = rows.length > 5 ? ' style="max-height:165px;overflow-y:auto"' : '';
    return `
        <div${scrollAttr}>
            <table class="tip-orders" style="width:100%">
                <thead><tr>${ths}</tr></thead>
                <tbody>${rows.join('')}</tbody>
            </table>
        </div>
        <table class="tip-orders">
            <tfoot>
                <tr class="tip-total">
                    <td colspan="${cols.length - 1}">Gesamt (${count}&nbsp;Rebalance${count !== 1 ? 's' : ''})</td>
                    <td class="tx-amount">−${totalCost.toFixed(6)}&nbsp;SOL</td>
                </tr>
            </tfoot>
        </table>`;
}

function initPoolTxModal() {
    const modal = $('poolTxModal');
    if (!modal) return;

    $('poolTxModalClose')?.addEventListener('click', closePoolTxModal);

    modal.addEventListener('click', e => {
        if (e.target === modal) closePoolTxModal();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) closePoolTxModal();
    });

    $('activePoolsContainer')?.addEventListener('click', e => {
        const rangeBtn = e.target.closest('.range-icon-btn');
        if (rangeBtn) {
            const poolPair = rangeBtn.dataset.poolPair;
            if (poolPair && _lastData) openRangeModal(poolPair, _lastData);
            return;
        }
        const feesLink = e.target.closest('.fees-clickable');
        if (feesLink) {
            // Mobile-Portrait: Modal ist zu breit für den Bildschirm → nicht öffnen.
            if (window.matchMedia('(max-width: 768px) and (orientation: portrait)').matches) return;
            const poolPair = feesLink.dataset.poolPair;
            if (poolPair && _lastData) openPoolClaimHistoryModal(poolPair, _lastData);
            return;
        }
        const rebalLink = e.target.closest('.rebalance-clickable');
        if (rebalLink) {
            // Mobile-Portrait: Modal ist zu breit für den Bildschirm → nicht öffnen.
            if (window.matchMedia('(max-width: 768px) and (orientation: portrait)').matches) return;
            const poolId = rebalLink.dataset.poolId;
            if (poolId && _lastData) openPoolRebalanceModal(poolId, _lastData);
            return;
        }
    });

    $('poolsContainer')?.addEventListener('click', e => {
        const aprLink = e.target.closest('.pool-apr-clickable');
        if (aprLink) {
            const poolPair = aprLink.dataset.poolPair;
            if (poolPair && _lastData) openMyAprModal(poolPair, _lastData);
        }
    });
}

// ── Haupt-Refresh-Schleife ────────────────────────────────────────────────────

async function refresh() {
    await loadTokenInfo(); // idempotent — nach dem ersten Aufruf sofort aus Cache
    const data = await loadData();
    if (data) _lastData = data;       // Fehlgeschlagener Fetch behält alte Daten
    const d = _lastData;
    if (!d) return;                    // Noch nie Daten erhalten

    const _safeRender = (fn, name) => { try { fn(); } catch (e) { console.error('[refresh] ' + name + ' failed:', e); } };
    _safeRender(() => renderHeader(d),           'renderHeader');
    _safeRender(() => renderMetrics(d),          'renderMetrics');
    _safeRender(() => renderPools(d),            'renderPools');
    _safeRender(() => renderActivePositions(d),  'renderActivePositions');
    _safeRender(() => renderOpportunityScores(d),'renderOpportunityScores');
    _safeRender(() => renderStatistics(d),       'renderStatistics');
    _safeRender(() => renderTransactions(d),     'renderTransactions');
    _safeRender(() => renderNotifs(d),           'renderNotifs');
    // Rebalancing-Toast (silent, kein Sound)
    if (d.rebalances?.length) {
        const rebalanceNotifs = d.rebalances.map(r => ({
            ts:      r.rebalancedAt,
            level:   'info',
            message: (r.reason === 'proactive' ? '⚡ Rebalancing ProAktiv' : '🔄 Rebalancing') + ` – ${r.displayPair ?? r.pair}`,
            pair:    r.pair,
        }));
        rebalanceToast.update(rebalanceNotifs);
    }
    // earningsToast pollt selbstständig via startPolling()

    updateChartRangeBtns('portfolioRangeBtns', d?.portfolioHistory ?? [], r => r.t,
        () => _portfolioRange, v => { _portfolioRange = v; localStorage.setItem(LS_RANGE.portfolio, v); }, () => { if (_lastData) renderPortfolioChart(_lastData); });
    updateChartRangeBtns('volRangeBtns', d?.volumeHistory ?? [], r => r.t,
        () => _volRange, v => { _volRange = v; localStorage.setItem(LS_RANGE.volume, v); }, () => { if (_lastData) renderVolumeChart(_lastData); });
    updateChartRangeBtns('feeRangeBtns', d?.dailyFees ?? [], r => new Date(r.date + 'T00:00:00').getTime(),
        () => _feeRange, v => { _feeRange = v; localStorage.setItem(LS_FEE_RANGE, v); }, () => { if (_lastData) renderFeeChart(_lastData); });

    renderPortfolioChart(d);
    renderVolumeChart(d);
    renderFeeChart(d);
}

// ── InvestScore Modal ────────────────────────────────────────────────────────

// ── Opportunity Score Chart ───────────────────────────────────────────────────

let _oppScoreRange = localStorage.getItem(LS_RANGE.oppScore) ?? '1d';

function _drawScoreChart(svgEl, points, range) {
    const W  = svgEl.getBoundingClientRect().width || 300;
    const H  = 180;
    const PL = 28, PR = 16, PT = 10, PB = 22;
    const cW = W - PL - PR;
    const cH = H - PT - PB;

    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.setAttribute('height', H);

    const yPx  = v => PT + cH - (v / 100) * cH;
    const RANGE_MS = { '1d': 86_400_000, '1w': 7 * 86_400_000, '1m': 30 * 86_400_000 };
    const tMax  = Date.now();
    const tMin  = tMax - (RANGE_MS[range] ?? 86_400_000);
    const tSpan = tMax - tMin;
    const xPx   = t => PL + ((t - tMin) / tSpan) * cW;

    // Zone bands (background)
    const bands = [
        { lo:  0, hi:  35, fill: 'rgba(239,68,68,0.12)'  },
        { lo: 35, hi:  60, fill: 'rgba(234,179,8,0.09)'  },
        { lo: 60, hi: 100, fill: 'rgba(34,197,94,0.12)'  },
    ];

    let svg = '';
    for (const b of bands) {
        const by = yPx(b.hi), bh = yPx(b.lo) - by;
        svg += `<rect x="${PL}" y="${by.toFixed(1)}" width="${cW}" height="${bh.toFixed(1)}" fill="${b.fill}"/>`;
    }

    // Reference lines + right-side labels
    const refs = [
        { y: 35, stroke: 'rgba(239,68,68,0.55)',  label: '35' },
        { y: 60, stroke: 'rgba(34,197,94,0.55)',   label: '60' },
    ];
    for (const r of refs) {
        const ry = yPx(r.y).toFixed(1);
        svg += `<line x1="${PL}" y1="${ry}" x2="${PL + cW}" y2="${ry}" stroke="${r.stroke}" stroke-width="1" stroke-dasharray="4,3"/>`;
        svg += `<text x="${(PL + cW + 3).toFixed(1)}" y="${(parseFloat(ry) + 3.5).toFixed(1)}" font-size="9" fill="${r.stroke}">${r.label}</text>`;
    }

    // Y-axis labels (left): 0 and 100 only (35/60 shown on right)
    for (const v of [0, 100]) {
        svg += `<text x="${(PL - 3).toFixed(1)}" y="${(yPx(v) + 3.5).toFixed(1)}" font-size="9" fill="#64748b" text-anchor="end">${v}</text>`;
    }

    // X-axis labels
    const tickCount = range === '1w' ? 6 : 5;
    for (let i = 0; i <= tickCount; i++) {
        const t = tMin + (i / tickCount) * tSpan;
        const d = new Date(t);
        const label = range === '1d'
            ? `${String(d.getHours()).padStart(2, '0')}h`
            : `${d.getDate()}.${d.getMonth() + 1}.`;
        const x = (PL + (i / tickCount) * cW).toFixed(1);
        svg += `<text x="${x}" y="${(H - 4).toFixed(1)}" font-size="9" fill="#64748b" text-anchor="middle">${label}</text>`;
    }

    // Data line
    const linePoints = points.map(p => `${xPx(p.ts).toFixed(1)},${yPx(p.v).toFixed(1)}`).join(' ');
    if (points.length >= 2) {
        svg += `<polyline points="${linePoints}" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    // Dots for sparse data
    if (points.length <= 14) {
        for (const p of points) {
            svg += `<circle cx="${xPx(p.ts).toFixed(1)}" cy="${yPx(p.v).toFixed(1)}" r="3" fill="#60a5fa"/>`;
        }
    }

    svgEl.innerHTML = svg;
}

function openInvestScoreModal(poolId, data) {
    const modal = $('investScoreModal');
    if (!modal) return;

    const pool = (data?.pools ?? []).find(p => p.id === poolId);
    if (!pool) return;

    const is   = pool.investScore;
    const pair = pool.displayPair ?? pool.pair ?? poolId;
    const titleEl = $('investScoreModalTitle');
    if (titleEl) titleEl.textContent = `Opportunity Score – ${pair}`;

    // ── Bewertung-Panel ──────────────────────────────────────────────────────
    const bewertungEl = $('oppScoreBewertungPanel');
    if (bewertungEl) {
        const _sc = v => v == null ? '' : v >= 60 ? 'value-good' : v < 35 ? 'value-danger' : '';
        const _fmtPct = (v, unit) => {
            if (v == null) return '<span style="color:#64748b;font-size:0.78em">no data</span>';
            const sign = v >= 0 ? '+' : '';
            const cls  = v >= 0 ? 'value-good' : 'value-danger';
            return `<span class="${cls}">${sign}${v.toFixed(1)}&thinsp;${escHtml(unit)}</span>`;
        };
        const _scoreCell = (v, bold) => v == null
            ? '<span style="color:#64748b;font-size:0.78em">no data</span>'
            : `<span class="${_sc(v)}"${bold ? ' style="font-weight:700"' : ''}>${v}</span>`;

        const isInactive = !pool.active;
        const allMetrics = is?.metrics ?? [];
        const metrics    = isInactive ? allMetrics.filter(m => !m.label.startsWith('PnL')) : allMetrics;
        const visibleTotalWeight = metrics.reduce((s, m) => s + m.weight, 0) || 1;

        // Column widths fixed so scrollable tbody aligns with thead
        const colWidths = ['auto', '28%', '16%', '20%'];
        const thStyle   = (i, extra = '') => `padding:4px 8px;font-weight:500${extra};width:${colWidths[i]}`;

        const metricRows = metrics.map(m => {
            const wPct = Math.round(m.weight / visibleTotalWeight * 100);
            return `<tr style="display:table;width:100%;table-layout:fixed">
                <td style="padding:5px 8px;color:#e2e8f0;width:${colWidths[0]}">${escHtml(m.label)}</td>
                <td style="padding:5px 8px;text-align:right;width:${colWidths[1]}">${_fmtPct(m.pct, m.unit ?? '%')}</td>
                <td style="padding:5px 8px;text-align:right;font-weight:600;width:${colWidths[2]}">${_scoreCell(m.score)}</td>
                <td style="padding:5px 8px;text-align:right;color:#94a3b8;width:${colWidths[3]}">${wPct}%</td>
            </tr>`;
        }).join('');

        // Volumen-Malus: separate Modifier-Zeile (keine gewichtete Metrik) – erklärt die
        // Differenz zwischen dem gewichteten Blend und dem Gesamt-Score.
        const volMalus = is?.volumeMalus ?? 0;
        const volMalusRow = volMalus > 0 ? `<tr>
                <td style="padding:6px 8px;color:#f59e0b;width:${colWidths[0]}">${tr('liq.volume_malus', 'Volumen-Malus')}<br><span style="font-size:0.72rem;color:#94a3b8">${volMalus} h ohne Handel (letzte 24 h)</span></td>
                <td style="width:${colWidths[1]}"></td>
                <td style="padding:6px 8px;text-align:right;font-weight:600;color:#f59e0b;width:${colWidths[2]}">−${volMalus}</td>
                <td style="width:${colWidths[3]}"></td>
            </tr>` : '';

        const scrollable = metrics.length > 5;
        const tbodyStyle = scrollable
            ? 'display:block;max-height:155px;overflow-y:auto'
            : 'display:block';

        const confNote   = is?.confidence === 'low'
            ? `<p style="color:#f59e0b;font-size:0.78rem;margin:8px 0 0">⚠ Nur ${is.dataDays ?? 0} Tag(e) Daten – Score mit Vorsicht verwenden</p>` : '';
        const hopiumNote = is?.hopiumVeto
            ? `<p style="color:#ef4444;font-size:0.78rem;margin:8px 0 0">🚫 6h-Warnsignal aktiv: Preis und APR fallen gleichzeitig. Score wurde auf max. 40 gedeckelt.</p>` : '';
        const npVal24h   = pool.npWindows?.['24h'];
        const npNote     = npVal24h != null
            ? (() => {
                const sign = npVal24h >= 0 ? '+' : '−';
                const cls  = npVal24h >= 0 ? 'value-good' : 'value-danger';
                const abs  = Math.abs(npVal24h).toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return ` Simulierter Netto-Ertrag auf 1.000 USDC (NP 24h): <span class="${cls}">${sign}${abs} USDC</span>.`;
            })()
            : '';
        const pnlNote    = isInactive
            ? `<p style="color:#64748b;font-size:0.78rem;margin:4px 0 0">Kein PnL verfügbar (inaktiver Pool) – Score basiert ausschließlich auf Marktdaten. Wertebereich: 10–90.${npNote}</p>` : '';

        const _typeInfo = {
            rebalance_free: tr('liq.vol_norebal_desc', 'Rebalance-frei – PnL zählt stark, niedrige Fee-APR ist hier normal'),
            volatil_1:      tr('liq.vol_low_desc', 'Gering volatil – PnL-betont'),
            volatil_2:      tr('liq.vol_mid_desc', 'Mittel volatil – ausgewogen zwischen PnL und Fee-APR'),
            volatil_3:      tr('liq.vol_high_desc', 'Stark volatil – Fee-APR-betont, PnL bewusst gedämpft'),
            rwa:            tr('liq.vol_rwa_desc', 'RWA (Real-World-Asset) – PnL-betont, kein Krypto-Preistrend'),
        };
        const _typeNote = is?.poolType
            ? `<p style="color:#94a3b8;font-size:0.75rem;margin:0 0 4px">${tr('liq.pool_type', 'Pool-Typ:')} <span style="color:#e2e8f0">${escHtml(is.poolType)}</span> – ${escHtml(_typeInfo[is.poolType] ?? tr('liq.type_weighting', 'typ-abhängige Gewichtung'))}</p>`
            : '';

        bewertungEl.innerHTML = `
            <div style="padding:8px 0 0">
            ${_typeNote}
            <p style="color:#94a3b8;font-size:0.75rem;margin:0 0 8px">Score: 0 = sehr schlecht · 50 = neutral · 100 = sehr gut · Gewichtung je nach Pool-Typ</p>
            <table style="width:100%;border-collapse:collapse;font-size:0.82rem;table-layout:fixed">
                <thead style="display:table;width:100%;table-layout:fixed">
                    <tr style="color:#94a3b8;text-transform:uppercase;font-size:0.72rem;letter-spacing:0.05em;border-bottom:1px solid #334155">
                        <th style="${thStyle(0,';text-align:left')}">${tr('liq.designation', 'Bezeichnung')}</th>
                        <th style="${thStyle(1,';text-align:right')}">${tr('liq.value', 'Wert')}</th>
                        <th style="${thStyle(2,';text-align:right')}">${tr('liq.score', 'Score')}</th>
                        <th style="${thStyle(3,';text-align:right')}">${tr('liq.weighting', 'Gewichtung')}</th>
                    </tr>
                </thead>
                <tbody style="${tbodyStyle}">
                    ${metricRows}
                </tbody>
                <tfoot style="display:table;width:100%;table-layout:fixed;border-top:1px solid #334155">
                    ${volMalusRow}
                    <tr>
                        <td style="padding:6px 8px;font-weight:600;color:#e2e8f0;width:${colWidths[0]}">Gesamt</td>
                        <td style="width:${colWidths[1]}"></td>
                        <td style="padding:6px 8px;text-align:right;font-size:1rem;width:${colWidths[2]}">${_scoreCell(is?.value ?? null, true)}</td>
                        <td style="padding:6px 8px;text-align:right;color:#94a3b8;width:${colWidths[3]}">100%</td>
                    </tr>
                </tfoot>
            </table>
            ${confNote}${hopiumNote}${pnlNote}
            </div>`;
    }

    // ── Chart-Panel + Range-Buttons ──────────────────────────────────────────
    const chartEl    = $('oppScoreChartPanel');
    const rangeBtns  = $('oppScoreRangeBtns');

    const renderChart = () => {
        const svgEl = chartEl?.querySelector('svg.opp-score-chart');
        if (!svgEl) return;
        const pts = (pool.scoreHistory ?? {})[_oppScoreRange] ?? [];
        if (!pts.length) {
            svgEl.setAttribute('viewBox', '0 0 300 180');
            svgEl.setAttribute('height', '180');
            svgEl.innerHTML = `<text x="150" y="90" dominant-baseline="middle" text-anchor="middle" fill="#64748b" font-size="12">${tr('liq.no_data_yet', 'Noch keine Daten')}</text>`;
            return;
        }
        _drawScoreChart(svgEl, pts, _oppScoreRange);
    };

    if (rangeBtns) {
        rangeBtns.innerHTML = ['1d', '1w', '1m'].map(r =>
            `<button class="chart-range-btn${_oppScoreRange === r ? ' active' : ''}" data-range="${r}">${r.toUpperCase()}</button>`
        ).join('');
        rangeBtns.querySelectorAll('.chart-range-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                _oppScoreRange = btn.dataset.range;
                localStorage.setItem(LS_RANGE.oppScore, _oppScoreRange);
                rangeBtns.querySelectorAll('.chart-range-btn').forEach(b =>
                    b.classList.toggle('active', b.dataset.range === _oppScoreRange));
                renderChart();
            });
        });
    }

    if (chartEl) {
        chartEl.innerHTML = `<svg class="opp-score-chart" width="100%" style="display:block;overflow:visible"></svg>`;
        requestAnimationFrame(renderChart);
    }

    // ── Tab switching ────────────────────────────────────────────────────────
    const tabsEl = $('oppScoreModalTabs');
    if (tabsEl && !tabsEl.dataset.bound) {
        tabsEl.dataset.bound = '1';
        tabsEl.addEventListener('click', e => {
            const btn = e.target.closest('.modal-tab-btn');
            if (!btn) return;
            const tab = btn.dataset.tab;
            tabsEl.querySelectorAll('.modal-tab-btn').forEach(b =>
                b.classList.toggle('active', b.dataset.tab === tab));
            $('oppScoreChartPanel')?.classList.toggle('active',    tab === 'chart');
            $('oppScoreBewertungPanel')?.classList.toggle('active', tab === 'bewertung');
            // Range-Buttons nur beim Chart-Tab sichtbar
            if (rangeBtns) rangeBtns.style.display = tab === 'chart' ? 'flex' : 'none';
        });
    }
    // Reset to Chart tab on every open
    tabsEl?.querySelectorAll('.modal-tab-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === 'chart'));
    $('oppScoreChartPanel')?.classList.add('active');
    $('oppScoreBewertungPanel')?.classList.remove('active');
    if (rangeBtns) rangeBtns.style.display = 'flex';

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
}

function initInvestScoreModal() {
    const modal = $('investScoreModal');
    if (!modal) return;
    const close = () => { modal.classList.add('hidden'); document.body.classList.remove('modal-open'); };
    $('investScoreModalClose')?.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
    });
}

// ── Metric Chart Modal (PnL / Slopes) ────────────────────────────────────────

let _metricChartRange = localStorage.getItem(LS_RANGE.metricChart) ?? '1d';

const _METRIC_META = {
    pnl:        { label: 'PnL',         unit: ' USDC', zeroline: true  },
    priceSlope: { label: 'Preis-Slope', unit: ' %/h',  zeroline: true  },
    aprSlope:   { label: 'APR-Slope',   unit: ' pp/h', zeroline: true  },
    tvlSlope:   { label: 'TVL-Slope',   unit: ' %/h',  zeroline: true  },
};

function _drawMetricChart(svgEl, points, meta) {
    const W  = svgEl.getBoundingClientRect().width || 560;
    const H  = 200;
    const PL = 52, PR = 12, PT = 12, PB = 24;
    const cW = W - PL - PR;
    const cH = H - PT - PB;

    const vals   = points.map(p => p.v).filter(v => v != null && isFinite(v));
    if (!vals.length) {
        svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svgEl.setAttribute('height', H);
        svgEl.innerHTML = `<text x="${W/2}" y="${H/2}" dominant-baseline="middle" text-anchor="middle" fill="#64748b" font-size="12">${tr('liq.no_data_yet', 'Noch keine Daten')}</text>`;
        return;
    }

    let yMin = Math.min(...vals);
    let yMax = Math.max(...vals);
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    // Include zero for zero-line metrics
    if (meta.zeroline) { yMin = Math.min(yMin, 0); yMax = Math.max(yMax, 0); }
    const yPad = (yMax - yMin) * 0.08;
    yMin -= yPad; yMax += yPad;
    const yRange = yMax - yMin;

    const yPx  = v  => PT + cH - ((v - yMin) / yRange) * cH;
    const tMin = points[0].ts;
    const tMax = points[points.length - 1].ts;
    const tSpan = Math.max(tMax - tMin, 1);
    const xPx  = t  => PL + ((t - tMin) / tSpan) * cW;

    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.setAttribute('height', H);

    let svg = '';

    // Y-axis grid lines + labels (4 ticks)
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
        const v  = yMin + (i / yTicks) * yRange;
        const py = yPx(v).toFixed(1);
        svg += `<line x1="${PL}" y1="${py}" x2="${PL+cW}" y2="${py}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
        const lbl = Math.abs(v) < 0.001 ? '0' : v >= 10 || v <= -10 ? v.toFixed(1) : v.toFixed(2);
        svg += `<text x="${(PL-4).toFixed(1)}" y="${(parseFloat(py)+3.5).toFixed(1)}" font-size="9" fill="#64748b" text-anchor="end">${lbl}</text>`;
    }

    // Zero line
    if (meta.zeroline) {
        const zy = yPx(0).toFixed(1);
        svg += `<line x1="${PL}" y1="${zy}" x2="${PL+cW}" y2="${zy}" stroke="rgba(148,163,184,0.4)" stroke-width="1" stroke-dasharray="4,3"/>`;
    }

    // X-axis labels
    const tickCount = 5;
    for (let i = 0; i <= tickCount; i++) {
        const t = tMin + (i / tickCount) * tSpan;
        const d = new Date(t);
        const label = (tMax - tMin) <= 86_400_000
            ? `${String(d.getHours()).padStart(2,'0')}h`
            : `${d.getDate()}.${d.getMonth()+1}.`;
        svg += `<text x="${(PL + (i/tickCount)*cW).toFixed(1)}" y="${(H-4).toFixed(1)}" font-size="9" fill="#64748b" text-anchor="middle">${label}</text>`;
    }

    // Area fill (positive above zero, negative below)
    if (points.length >= 2 && meta.zeroline) {
        const zy = yPx(0);
        const areaSegs = points.map((p, i) => {
            const px = xPx(p.ts).toFixed(1), py = yPx(p.v).toFixed(1);
            return i === 0 ? `M${px},${zy.toFixed(1)} L${px},${py}` : `L${px},${py}`;
        });
        areaSegs.push(`L${xPx(points[points.length-1].ts).toFixed(1)},${zy.toFixed(1)} Z`);
        svg += `<path d="${areaSegs.join(' ')}" fill="rgba(96,165,250,0.12)" stroke="none"/>`;
    }

    // Data line
    if (points.length >= 2) {
        const lineD = points.map((p, i) =>
            `${i===0?'M':'L'}${xPx(p.ts).toFixed(1)},${yPx(p.v).toFixed(1)}`).join(' ');
        svg += `<path d="${lineD}" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    if (points.length <= 14) {
        for (const p of points)
            svg += `<circle cx="${xPx(p.ts).toFixed(1)}" cy="${yPx(p.v).toFixed(1)}" r="3" fill="#60a5fa"/>`;
    }

    svgEl.innerHTML = svg;
}

// Mappt Opportunity-Tabellen-Timeframe auf den passenden metricHistory-Range.
// Stellt sicher, dass der letzte Chart-Punkt dem angeklickten Tabellenwert entspricht.
const _OPP_TF_TO_CHART_RANGE = { '6h': '6h', '12h': '12h', '24h': '1d', '7d': '1w' };

function openMetricChartModal(poolId, metric, data, oppTf) {
    const modal  = $('metricChartModal');
    const titleEl = $('metricChartModalTitle');
    const bodyEl  = $('metricChartBody');
    const rangEl  = $('metricChartRangeBtns');
    if (!modal || !bodyEl) return;

    const pool = (data?.pools ?? []).find(p => p.id === poolId);
    if (!pool) return;

    // Beim Klick auf PnL-Zelle: Range passend zum Tabellen-Zeitfenster setzen.
    if (metric === 'pnl' && oppTf && _OPP_TF_TO_CHART_RANGE[oppTf]) {
        _metricChartRange = _OPP_TF_TO_CHART_RANGE[oppTf];
        localStorage.setItem(LS_RANGE.metricChart, _metricChartRange);
    }

    const meta = _METRIC_META[metric] ?? { label: metric, unit: '', zeroline: true };
    const pair = pool.displayPair ?? pool.pair ?? poolId;
    if (titleEl) titleEl.textContent = `${pair} – ${meta.label}`;

    const renderChart = () => {
        const svgEl = bodyEl.querySelector('svg.metric-chart-svg');
        if (!svgEl) return;
        const pts = pool.metricHistory?.[_metricChartRange]?.[metric] ?? [];
        _drawMetricChart(svgEl, pts, meta);
    };

    bodyEl.innerHTML = `<svg class="metric-chart-svg" width="100%" style="display:block;overflow:visible"></svg>`;

    if (rangEl) {
        rangEl.innerHTML = ['6h', '12h', '1d', '1w', '1m'].map(r =>
            `<button class="chart-range-btn${_metricChartRange === r ? ' active' : ''}" data-range="${r}">${r.toUpperCase()}</button>`
        ).join('');
        rangEl.querySelectorAll('.chart-range-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                _metricChartRange = btn.dataset.range;
                localStorage.setItem(LS_RANGE.metricChart, _metricChartRange);
                rangEl.querySelectorAll('.chart-range-btn').forEach(b =>
                    b.classList.toggle('active', b.dataset.range === _metricChartRange));
                renderChart();
            });
        });
    }

    requestAnimationFrame(renderChart);
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
}

function initMetricChartModal() {
    const modal = $('metricChartModal');
    if (!modal) return;
    const close = () => { modal.classList.add('hidden'); document.body.classList.remove('modal-open'); };
    $('metricChartModalClose')?.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
    });
}

// ── Tooltip-System ───────────────────────────────────────────────────────────

function initTooltips() {
    const tooltip = document.getElementById('forgeTooltip');
    const titleEl = document.getElementById('forgeTooltipTitle');
    const bodyEl  = document.getElementById('forgeTooltipBody');
    if (!tooltip) return;

    // Mobile/Touch: JS-Hover-Tooltips deaktivieren. Auf Touch-Geräten feuert
    // mouseover beim Tap, aber kein mouseout → Tooltip bleibt kleben.
    if (window.matchMedia('(hover: none), (pointer: coarse)').matches) return;

    document.addEventListener('mouseover', e => {
        const el = e.target.closest('.has-tooltip');
        if (!el) return;
        const content = el.dataset.tooltipContent ?? '';
        titleEl.textContent = el.dataset.tooltipTitle ?? '';
        const isTable = content.includes('<table');
        if (isTable) {
            tooltip.style.maxWidth = '520px';
            tooltip.style.minWidth = '260px';
        } else {
            tooltip.style.maxWidth = '';
            tooltip.style.minWidth = '';
        }
        bodyEl.innerHTML = isTable ? content : escHtml(content).replace(/\n/g, '<br>');
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
        const margin = 12;
        let x = e.pageX + margin;
        let y = e.pageY + margin;
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        const vw = window.innerWidth + window.scrollX;
        const vh = window.innerHeight + window.scrollY;
        if (x + tw > vw) x = e.pageX - tw - margin;
        if (y + th > vh) y = e.pageY - th - margin;
        tooltip.style.left = x + 'px';
        tooltip.style.top  = y + 'px';
    }
}

// ── Init ─────────────────────────────────────────────────────────────────────


initNav({ current: 'liquidity-dashboard' });
initFooter({ botName: 'Liquidity Bot' });
initMessageBell();
initTooltips();
initPoolTxModal();
initMyAprModal();
initTvlModal();
initVolModal();
initCompositionModal();
initPosValueModal();
initRangeModal();
initWalletDetailModal(() => _lastData);
initInvestScoreModal();
initMetricChartModal();
initPayedFeesModal();
initClaimedFeesModal();
initPortfolioChartModal();
initFeeBarTooltip();
initFeeChartModal();
initVolChartModal();

refresh();
setInterval(refresh, REFRESH_MS);

// Header-Zeit alle 10s neu rendern (ohne Datei-Fetch), damit die relative Zeit live hochzählt
setInterval(() => { if (_lastData) renderHeader(_lastData); }, 10_000);

// Sofort refreshen wenn der Tab wieder sichtbar wird (Browser drosselt Timer im Hintergrund)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
});

// Sofort refreshen wenn die Seite aus dem bfcache restauriert wird (Browser-Zurück)
window.addEventListener('pageshow', e => {
    if (e.persisted) refresh();
});

