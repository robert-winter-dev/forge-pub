// indicators.js
// Technische Indikatoren fuer den Kurs-Chart (LIQ#001115): EMA, RSI (Wilder), MACD.
// Reine Funktionen ohne DOM, laufen im Browser und unter node --test.
// Eingabe: Array von Schlusskursen. Ausgabe: gleich lang, null solange der Wert
// noch nicht definiert ist (Einschwingphase).

/** EMA mit Startwert = einfacher Mittelwert der ersten `period` Werte (TradingView-Konvention). */
export function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let prev = 0;
    for (let i = 0; i < period; i++) prev += values[i];
    prev /= period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
        prev = values[i] * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
}

/** RSI nach Wilder, erster Wert an Index `period`. */
export function rsi(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
        const d = values[i] - values[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    const toRsi = () => loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    out[period] = toRsi();
    for (let i = period + 1; i < values.length; i++) {
        const d = values[i] - values[i - 1];
        gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
        loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
        out[i] = toRsi();
    }
    return out;
}

/** MACD: macd = EMA(fast) - EMA(slow), signal = EMA(macd, signalPeriod), hist = macd - signal. */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
    const n = values.length;
    const emaFast = ema(values, fast);
    const emaSlow = ema(values, slow);
    const line = values.map((_, i) => emaFast[i] == null || emaSlow[i] == null ? null : emaFast[i] - emaSlow[i]);
    const signal = new Array(n).fill(null);
    const first = line.findIndex(v => v != null);
    if (first >= 0) {
        const sig = ema(line.slice(first), signalPeriod);
        sig.forEach((v, i) => { signal[first + i] = v; });
    }
    const hist = line.map((v, i) => v == null || signal[i] == null ? null : v - signal[i]);
    return { macd: line, signal, hist };
}

/** Mindestpunkte, ab denen ein Indikator mindestens einen Wert liefert. */
export const MIN_POINTS = { ema: 30, rsi: 15, macd: 34, vol: 21 };

/**
 * Faßt eine Reihe [{x,y}] zu Kerzen fester Größe zusammen: je UTC-Raster-Fenster der letzte
 * Schlusskurs, Zeitstempel = Zeitpunkt dieses letzten Punkts (liegt bündig zur Preislinie).
 * Stundenwerte → 4h-Kerzen macht RSI/MACD ruhiger (LIQ#001115).
 */
export function resample(series, bucketMs) {
    const out = [];
    let last = null;
    for (const p of series ?? []) {
        const b = Math.floor(p.x / bucketMs);
        if (b === last) out[out.length - 1] = { x: p.x, y: p.y };
        else { out.push({ x: p.x, y: p.y }); last = b; }
    }
    return out;
}

/** Standardabweichung der Grundgesamtheit (wie TradingView ta.stdev). */
const mean  = a => a.reduce((x, y) => x + y, 0) / a.length;
const pstd  = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

/**
 * Volatilitaet: Standardabweichung der prozentualen Kerzen-Renditen ueber `period` Kerzen, in Prozent.
 * Renditen statt Kursniveau, damit ein reiner Trend die Zahl nicht aufblaeht. Erster Wert an Index `period`.
 */
export function volatility(values, period = 20) {
    const ret = values.map((v, i) => i === 0 || !values[i - 1] ? null : (v / values[i - 1] - 1) * 100);
    const out = new Array(values.length).fill(null);
    for (let i = period; i < values.length; i++) out[i] = pstd(ret.slice(i - period + 1, i + 1));
    return out;
}

/**
 * Range-Test (LIQ#001115): Wie oft wuerde eine Range "Startkurs ± halfPct %" innerhalb von 24 h bzw. 72 h
 * verlassen? Jeder Punkt der Reihe gilt einmal als Startpunkt; gezaehlt werden nur Starts, zu denen
 * das ganze Fenster in den Daten liegt. Erwartet aufsteigend sortierte [{x,y}] (Stundenwerte).
 * Rueckgabe: { n24, exit24, n72, exit72 } (Anzahl gewerteter Starts, davon verlassen).
 */
export function rangeExitStats(series, halfPct) {
    const H = 3_600_000, lastX = series.length ? series[series.length - 1].x : 0;
    const w = halfPct / 100;
    const out = { n24: 0, exit24: 0, n72: 0, exit72: 0 };
    for (let i = 0; i < series.length; i++) {
        const p0 = series[i].y, t0 = series[i].x;
        if (!(p0 > 0)) continue;
        let firstExit = Infinity;
        for (let j = i + 1; j < series.length; j++) {
            if (Math.abs(series[j].y / p0 - 1) > w) { firstExit = series[j].x - t0; break; }
        }
        if (t0 + 24 * H <= lastX) { out.n24++; if (firstExit <= 24 * H) out.exit24++; }
        if (t0 + 72 * H <= lastX) { out.n72++; if (firstExit <= 72 * H) out.exit72++; }
    }
    return out;
}

