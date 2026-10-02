// html/js/chart-range.js
// ─────────────────────────────────────────────────────────────────────────────
// ⛔ ZENTRALE LIB FÜR ZEITRAUM-FILTER (1D / 1W / 1M …) ALLER CHARTS
// ─────────────────────────────────────────────────────────────────────────────
// Warum es sie gibt, die Freischalt-Regel und woher der Historie-Beginn kommt:
// KB Core/chart-range-lib.md (CORE#000933).
//
// 🔒 Neue Charts rechnen keine eigenen Zeitraum-Cutoffs (86_400_000 & Co.) und
//    bauen keine eigene Button-Leiste — sie rufen nur diese Lib auf.
//
// Aufteilung:
//   - reine Funktionen (ohne DOM, per node --test geprüft, bin/ui-test/chart-range.test.js):
//     buildRanges, normalizeRangeKey, unlockedRanges, isRangeUnlocked,
//     resolveRange, rangeCutoff, filterToRange, historyStartOf
//   - createRangeBar(): die Button-Leiste als Komponente
//
// Freischalt-Regel: Ein Zeitraum ist wählbar, sobald die Daten WEITER zurück-
// reichen als der nächstkleinere Zeitraum (streng „länger als"). Der kleinste
// Zeitraum ist immer wählbar. 0 Tage → [1D], 2 Tage → [1D,1W], 8 Tage → alle.
//
// Historie-Beginn: der erste tatsächlich vorhandene Datenpunkt der angezeigten
// Reihe (ms) — nie aus einem separaten Feld wie opened_at geschätzt.
// ─────────────────────────────────────────────────────────────────────────────

import { t } from './i18n.js?v=20260811a';

const DAY = 86_400_000;

/** Standard-Zeiträume, aufsteigend. ms = Länge des Zeitraums. */
export const DEFAULT_RANGES = Object.freeze([
    Object.freeze({ key: '1D', label: '1D', ms: DAY }),
    Object.freeze({ key: '1W', label: '1W', ms: 7 * DAY }),
    Object.freeze({ key: '1M', label: '1M', ms: 30 * DAY }),
]);

/**
 * Standard-Zeiträume plus Zusatz-Zeiträume eines Aufrufers, aufsteigend nach ms.
 * Gleicher Key (ohne Groß-/Kleinschreibung) überschreibt den Standard.
 *
 *   buildRanges([{ key: 'all', label: 'Alle', ms: Infinity }])
 *
 * @param {Array<{key:string,label?:string,ms:number}>} [extra]
 */
export function buildRanges(extra = []) {
    const byKey = new Map(DEFAULT_RANGES.map(r => [r.key.toLowerCase(), r]));
    for (const r of extra) {
        if (!r?.key || !(r.ms > 0)) throw new Error(`chart-range: ungültiger Zeitraum ${JSON.stringify(r)}`);
        byKey.set(r.key.toLowerCase(), Object.freeze({ key: r.key, label: r.label ?? r.key, ms: r.ms }));
    }
    return Object.freeze([...byKey.values()].sort((a, b) => a.ms - b.ms));
}

/**
 * Vereinheitlicht einen Key auf die Schreibweise der Definition ('1d' → '1D').
 * @returns {string|null} kanonischer Key oder null, wenn unbekannt
 */
export function normalizeRangeKey(key, ranges = DEFAULT_RANGES) {
    if (key == null) return null;
    const k = String(key).trim().toLowerCase();
    return ranges.find(r => r.key.toLowerCase() === k)?.key ?? null;
}

function _spanMs(historyStartMs, now) {
    if (historyStartMs == null || !Number.isFinite(historyStartMs)) return 0;
    return Math.max(0, now - historyStartMs);
}

/**
 * Keys aller wählbaren Zeiträume (reine Funktion).
 * @param {number|null} historyStartMs  frühester Datenpunkt der Reihe (ms), null = keine Daten
 */
export function unlockedRanges(historyStartMs, { ranges = DEFAULT_RANGES, now = Date.now() } = {}) {
    const span = _spanMs(historyStartMs, now);
    return ranges.filter((r, i) => i === 0 || span > ranges[i - 1].ms).map(r => r.key);
}

export function isRangeUnlocked(key, historyStartMs, opts = {}) {
    const k = normalizeRangeKey(key, opts.ranges ?? DEFAULT_RANGES);
    return k != null && unlockedRanges(historyStartMs, opts).includes(k);
}

/**
 * Der tatsächlich anzuzeigende Zeitraum: der gewünschte, wenn wählbar —
 * sonst (gesperrt oder unbekannt) der größte wählbare (Rückfall).
 */
export function resolveRange(wanted, historyStartMs, opts = {}) {
    const ranges   = opts.ranges ?? DEFAULT_RANGES;
    const unlocked = unlockedRanges(historyStartMs, { ...opts, ranges });
    const k        = normalizeRangeKey(wanted, ranges);
    return k != null && unlocked.includes(k) ? k : unlocked[unlocked.length - 1];
}

/** Zeitpunkt „jetzt minus Zeitraum" (ms). Unendlicher Zeitraum → -Infinity. */
export function rangeCutoff(key, { ranges = DEFAULT_RANGES, now = Date.now() } = {}) {
    const k = normalizeRangeKey(key, ranges);
    if (k == null) throw new Error(`chart-range: unbekannter Zeitraum "${key}"`);
    return now - ranges.find(r => r.key === k).ms;
}

/** Zeitstempel (ms) eines Punktes: [ts, …], {x}, {ts}. */
const defaultGetTs = p => (Array.isArray(p) ? p[0] : (p?.x ?? p?.ts));

/**
 * Punkte auf einen Zeitraum filtern (ts >= Cutoff). Reihenfolge bleibt.
 * @param {(p:any)=>number} [opts.getTs]  Zeitstempel in ms
 */
export function filterToRange(points, key, { ranges = DEFAULT_RANGES, now = Date.now(), getTs = defaultGetTs } = {}) {
    if (!points?.length) return [];
    const cutoff = rangeCutoff(key, { ranges, now });
    return points.filter(p => getTs(p) >= cutoff);
}

/** Frühester Zeitstempel (ms) einer Reihe, null bei leerer Reihe. */
export function historyStartOf(points, getTs = defaultGetTs) {
    let min = null;
    for (const p of points ?? []) {
        const ts = getTs(p);
        if (Number.isFinite(ts) && (min == null || ts < min)) min = ts;
    }
    return min;
}

// ── Button-Leiste ────────────────────────────────────────────────────────────

function _spanText(ms) {
    const days = Math.round(ms / DAY);
    return days === 1
        ? t('chart_range.span.one_day', '1 Tag')
        : t('chart_range.span.days', '{n} Tage', { n: days });
}

function _lsGet(k) { try { return k ? localStorage.getItem(k) : null; } catch { return null; } }
function _lsSet(k, v) { try { if (k) localStorage.setItem(k, v); } catch { /* privat/blockiert */ } }

/**
 * Rendert die Zeitraum-Leiste (.chart-range-btn) in `container` und verwaltet
 * den aktiven Zeitraum. Der Container gehört danach der Leiste.
 *
 * Zwei Zustände werden getrennt geführt:
 *   - Wunsch  = letzte Wahl des Nutzers (bzw. Vorgabe/gespeicherter Wert)
 *   - aktiv   = resolveRange(Wunsch, Historie-Beginn)
 * Ein Rückfall überschreibt den Wunsch NICHT: Reicht die Historie später (Reload,
 * anderer Tab mit längerer Reihe) wieder aus, kehrt die Leiste zum Wunsch zurück.
 *
 * onChange(key, { reason }) feuert, wenn sich der AKTIVE Zeitraum ändert:
 *   reason 'user'     — Klick
 *   reason 'history'  — setHistoryStart() hat Rückfall bzw. Rückkehr ausgelöst
 *   reason 'set'      — setActive()
 * Beim Erzeugen feuert onChange nicht; den Startwert liefert bar.active.
 *
 * @param {HTMLElement} container
 * @param {object}   [o]
 * @param {Array}    [o.ranges=DEFAULT_RANGES]  z.B. buildRanges([{key:'all',…}])
 * @param {string}   [o.active]        Vorgabe, wenn nichts gespeichert ist (sonst größter Zeitraum)
 * @param {string}   [o.storageKey]    localStorage-Key für die Nutzerwahl (optional)
 * @param {number|null} [o.historyStart=null]  frühester Datenpunkt (ms)
 * @param {Function} [o.onChange]
 * @param {Function} [o.now]           Uhr, nur für Tests
 */
export function createRangeBar(container, o = {}) {
    const ranges   = o.ranges ?? DEFAULT_RANGES;
    const now      = o.now ?? Date.now;
    const onChange = o.onChange ?? (() => {});

    let wish = normalizeRangeKey(_lsGet(o.storageKey), ranges)
            ?? normalizeRangeKey(o.active, ranges)
            ?? ranges[ranges.length - 1].key;
    let historyStart = o.historyStart ?? null;
    let active = resolveRange(wish, historyStart, { ranges, now: now() });

    function render() {
        const unlocked = unlockedRanges(historyStart, { ranges, now: now() });
        container.innerHTML = '';
        ranges.forEach((r, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chart-range-btn' + (r.key === active ? ' active' : '');
            btn.dataset.range = r.key;
            btn.textContent = r.label;
            if (!unlocked.includes(r.key)) {
                btn.disabled = true;
                btn.setAttribute('aria-disabled', 'true');
                btn.classList.add('has-tooltip');
                btn.dataset.tooltipTitle = t('chart_range.locked.title', 'Noch zu wenig Historie');
                btn.dataset.tooltipContent = t('chart_range.locked.body',
                    'Verfügbar, sobald die Daten mehr als {span} zurückreichen.',
                    { span: _spanText(ranges[i - 1].ms) });
            }
            container.appendChild(btn);
        });
    }

    function apply(reason) {
        const next = resolveRange(wish, historyStart, { ranges, now: now() });
        const changed = next !== active;
        active = next;
        render();
        if (changed) onChange(active, { reason });
    }

    function onClick(e) {
        const btn = e.target.closest('.chart-range-btn');
        if (!btn || !container.contains(btn) || btn.disabled) return;
        if (!isRangeUnlocked(btn.dataset.range, historyStart, { ranges, now: now() })) return;
        wish = btn.dataset.range;
        _lsSet(o.storageKey, wish);
        apply('user');
    }

    container.addEventListener('click', onClick);
    render();

    return {
        get active() { return active; },
        get ranges() { return ranges; },
        /** Neuer Historie-Beginn (ms oder null), z.B. nach Daten-Reload oder Tabwechsel. */
        setHistoryStart(ms) { historyStart = ms ?? null; apply('history'); },
        /** Programmatisch wählen (wird nicht gespeichert). */
        setActive(key) {
            const k = normalizeRangeKey(key, ranges);
            if (k == null) throw new Error(`chart-range: unbekannter Zeitraum "${key}"`);
            wish = k;
            apply('set');
        },
        /** Punkte auf den aktiven Zeitraum filtern. */
        filter(points, getTs) { return filterToRange(points, active, { ranges, now: now(), getTs }); },
        destroy() { container.removeEventListener('click', onClick); container.innerHTML = ''; },
    };
}
