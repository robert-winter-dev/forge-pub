/**
 * FORGE Liquidity – Stimmungs-Verlauf (LIQ#001967), gilt identisch auf Master und Fork.
 *
 * 🔒 LIQ#000938: Hier wird nichts gerechnet. Der Wert (`po.chance`) kommt auf dem Master aus
 * chance-score.js, im Fork als Lieferung; beide Seiten schreiben ihn nur stündlich in
 * `chance_history`. Dieses Modul importiert chance-score.js bewusst NICHT (Master-only, closureExclude).
 *
 * Nur Zeilen ab dem Formelwechsel (LIQ#001964, 13.11.2026 ~19 Uhr) sind vergleichbar: Sie tragen je
 * Signal einen Teilpunkt `"sc"` in `signals`. Ältere Zeilen (Zählwert) werden nie gezeigt, und der Fork
 * schreibt eine Lieferung ohne Teilpunkte (alter Master) gar nicht erst.
 *
 * Format `signals`: wie lib/chance-score.js encodeSignals (JSON, `s`,`tf`,`v`,`st`,`sc`,`ref`).
 */

const STATUS_CODE = { met: 'm', unmet: 'u', nodata: 'n' };

/** Serialisiert gelieferte/gerechnete Signale im Verlaufsformat, ohne zu rechnen. */
export function serializeSignals(signals) {
    return JSON.stringify(signals.map(s => ({
        s: s.src, tf: s.tf, v: s.raw ?? null, st: STATUS_CODE[s.status] ?? 'n',
        ...(Number.isFinite(s.score) ? { sc: s.score } : {}),
        ...(Number.isFinite(s.ref) ? { ref: s.ref } : {}),
    })));
}

/** Nur Werte mit Teilpunkten sind mit der aktuellen Formel vergleichbar. */
export function isScoredChance(c) {
    return !!c && Number.isFinite(c.value) && Array.isArray(c.signals) && c.signals.length > 0
        && c.signals.every(s => Number.isFinite(s.score));
}

/** Legt die Tabelle an (Fork hat sie nicht per Migration, Master schon: IF NOT EXISTS). */
export function ensureChanceHistory(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS chance_history (
        pool_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, chance_pct INTEGER NOT NULL,
        met INTEGER NOT NULL, applicable INTEGER NOT NULL, signals TEXT NOT NULL,
        PRIMARY KEY (pool_id, recorded_at))`);
}

/** Eine Zeile je Pool und voller Stunde, vorhandene bleiben (INSERT OR IGNORE). */
export function recordChanceHistory(db, pools, nowMs) {
    ensureChanceHistory(db);
    const hour = Math.floor(nowMs / 3_600_000) * 3_600_000;
    const ins = db.prepare(`INSERT OR IGNORE INTO chance_history
        (pool_id, recorded_at, chance_pct, met, applicable, signals) VALUES (?, ?, ?, ?, ?, ?)`);
    let n = 0;
    db.transaction(() => {
        for (const po of pools) {
            const c = po.chance;
            if (!isScoredChance(c)) continue;
            n += ins.run(po.id, hour, c.value, c.met, c.applicable, serializeSignals(c.signals)).changes;
        }
    })();
    return n;
}

/** Buckets je Range wie beim Edge-Verlauf. Stündliche Daten: kürzere Ranges haben wenige Punkte. */
export const CHANCE_RANGES = {
    '6h': [6 * 3_600_000, 3_600_000], '12h': [12 * 3_600_000, 3_600_000], '1d': [86_400_000, 3_600_000],
    '1w': [7 * 86_400_000, 3_600_000], '1m': [31 * 86_400_000, 86_400_000],
};

/** Setzt `po.metricHistory[range].chance = [{ts, v}]` (v = Mittel je Bucket, ganze %). */
export function attachChanceHistory(db, pools, nowMs) {
    ensureChanceHistory(db);
    const stmts = Object.fromEntries(Object.entries(CHANCE_RANGES).map(([k, [, bucket]]) => [k, db.prepare(`
        SELECT CAST(recorded_at / ${bucket} AS INTEGER) * ${bucket} AS ts, CAST(ROUND(AVG(chance_pct)) AS INTEGER) AS v
        FROM chance_history WHERE pool_id = ? AND recorded_at > ? AND signals LIKE '%"sc":%'
        GROUP BY CAST(recorded_at / ${bucket} AS INTEGER) ORDER BY ts`)]));
    for (const po of pools) {
        po.metricHistory ??= {};
        for (const [range, [span]] of Object.entries(CHANCE_RANGES)) {
            (po.metricHistory[range] ??= {}).chance = stmts[range].all(po.id, nowMs - span).map(r => ({ ts: r.ts, v: r.v }));
        }
    }
}
