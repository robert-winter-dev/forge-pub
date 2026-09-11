/**
 * Die von `0006` geschriebenen Historien-Zeilen als `source='migration'` nachtragen
 * (2026-09-03, LIQ#0367).
 *
 * Auf `business` lief `0006-trailing-stop-cooldown-6h` am 03.09.2026 um 08:12:33, die
 * Spalte `source` kam mit `0007` erst um 17:32 dazu. Die 41 Zeilen, die `0006` in
 * `settings_history` geschrieben hat, entstanden also VOR der Spalte und tragen seither
 * deren Default `'user'`.
 *
 * 🔒 Warum das mehr ist als ein Schönheitsfehler: `userTouched()` in `0006` liest
 * `settings_history` als Liste der von Hand gesetzten Werte und lässt Default-Migrationen
 * dort dauerhaft aussetzen. Mit 41 falsch als `'user'` markierten Zeilen gilt auf dieser
 * Installation jeder Pool und jeder Pool-Typ als handgesetzt — eine künftige Korrektur an
 * `trailingStop.cooldownHours` würde überall aussetzen. Exakt die Fehlerklasse, für die
 * `0006` gebaut wurde („Ein geänderter Default erreicht bestehende Installationen nie von
 * selbst"). Hintergrund: KB Strategien/strategie-auswahl.md, Entscheidung 7.
 *
 * Betroffen sind nur Installationen, die `0006` ausgeführt haben, bevor `0007` existierte —
 * faktisch nur `business`. Wo beide Migrationen im selben Update ankommen, greift der
 * Schema-Helfer aus LIQ#0366 und diese Migration findet 0 Zeilen.
 *
 * 🔒 Einstufung `safe`: Es ändert sich ausschließlich die Herkunftsangabe einer
 * Historien-Zeile. Kein Einstellungswert wird angefasst, kein Bot liest
 * `settings_history` — die Migration kann weder eine Position schließen noch Kapital
 * bewegen.
 *
 * ── Wie die Zeilen von `0006` erkannt werden ─────────────────────────────────
 * Der Zeitstempel wird NICHT hart eincodiert, sondern aus `applied_migrations.applied_at`
 * von `0006` abgeleitet. `0006` schreibt alle Zeilen in EINER Transaktion mit einem
 * gemeinsamen `now` und verbucht sich unmittelbar danach (auf `business` 25 ms später).
 * Gesucht wird deshalb im Fenster `[applied_at − 10 min, applied_at]` — und davon nur der
 * Cluster mit dem GRÖSSTEN `changed_at`.
 *
 * 🔒 Der Cluster, nicht das ganze Fenster: `old_value='1' AND new_value='6'` schließt die
 * echte Handänderung vom 30.08. (3 → 1) sauber aus, aber nicht eine denkbare
 * Handänderung 1 → 6. Die hätte einen eigenen, früheren Zeitstempel; der letzte Cluster vor
 * `applied_at` gehört immer `0006`. Der Selbsttest (`bin/test-migration-0008.js`) hält
 * genau diesen gemischten Fall fest.
 */
import { IMPACT_SAFE } from './runner.js';
import { ensureSourceColumn, hasSourceColumn } from './_settings-history.js';

const SOURCE_MIGRATION = '0006-trailing-stop-cooldown-6h';
const FIELD     = 'trailingStop.cooldownHours';
const OLD_VALUE = JSON.stringify(1);
const NEW_VALUE = JSON.stringify(6);

/** Wie weit vor `applied_at` darf der Schreibvorgang von `0006` liegen. */
const WINDOW_MS = 10 * 60 * 1000;

/**
 * Zeitpunkt, zu dem `0006` auf dieser Installation ausgeführt wurde.
 *
 * `mode` muss `'applied'` sein (oder fehlen — ältere Zeilen): bei `'baseline'` und
 * `'superseded'` wurde `0006` nur verbucht, nicht ausgeführt, hat also nie eine
 * Historien-Zeile geschrieben.
 *
 * @returns {number|null}
 */
function sourceAppliedAt(db) {
    try {
        const row = db.prepare(
            `SELECT applied_at, mode FROM applied_migrations WHERE id = ?`
        ).get(SOURCE_MIGRATION);
        if (!row) return null;
        if (row.mode && row.mode !== 'applied') return null;
        return Number(row.applied_at);
    } catch {
        return null;   // Tabelle fehlt → 0006 kann hier nicht gelaufen sein
    }
}

/**
 * @returns {{reason: string}|{changedAt: number, rows: Array}} Was umzusetzen ist,
 *          oder der Grund, warum es nichts zu tun gibt.
 */
function analyse(db) {
    if (!hasSourceColumn(db)) return { reason: 'settings_history hat keine Spalte source' };

    const appliedAt = sourceAppliedAt(db);
    if (appliedAt === null || !Number.isFinite(appliedAt)) {
        return { reason: `${SOURCE_MIGRATION} ist hier nie ausgeführt worden` };
    }

    let candidates;
    try {
        // 🔒 Bewusst OHNE Filter auf `source`: Der Cluster wird an den Werten und am
        // Zeitstempel erkannt, nicht an der Herkunft — sonst verschöbe er sich beim zweiten
        // Lauf. Nach der Korrektur trügen die Zeilen von `0006` nämlich 'migration', der
        // „letzte Cluster vor applied_at" wäre dann eine davorliegende Handänderung, und
        // ein Wiederholungslauf würde genau die Zeile umetikettieren, die er schützen soll.
        // (Der Selbsttest hat das gefangen, bevor es je gelaufen ist.)
        candidates = db.prepare(`
            SELECT id, scope, scope_id, changed_at, source
              FROM settings_history
             WHERE bot_id = 'liquidity' AND field = ?
               AND old_value = ? AND new_value = ?
               AND changed_at BETWEEN ? AND ?
             ORDER BY changed_at DESC`
        ).all(FIELD, OLD_VALUE, NEW_VALUE, appliedAt - WINDOW_MS, appliedAt);
    } catch {
        return { reason: 'settings_history existiert nicht' };
    }
    if (!candidates.length) return { reason: `keine Zeile aus dem Lauf von ${SOURCE_MIGRATION} gefunden` };

    // Nur der letzte Cluster vor `applied_at` — siehe Kopfkommentar.
    const changedAt = candidates[0].changed_at;
    const rows = candidates.filter(r => r.changed_at === changedAt && r.source === 'user');
    if (!rows.length) return { reason: 'keine Zeile trägt fälschlich source=\'user\'' };
    return { changedAt, rows };
}

function describe(res) {
    const byScope = new Map();
    for (const r of res.rows) byScope.set(r.scope, (byScope.get(r.scope) ?? 0) + 1);
    return [
        `geschrieben am ${new Date(res.changedAt).toISOString()} durch ${SOURCE_MIGRATION}`,
        ...[...byScope].map(([scope, n]) => `${n} Zeile(n) scope='${scope}'`),
    ];
}

export default {
    id:          '0008-settings-history-migration-source',
    description: `settings_history: die Zeilen von ${SOURCE_MIGRATION} auf source='migration' korrigieren`,
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        const res = analyse(ctx.settingsDb);
        if (res.reason) {
            return { pending: false, summary: `nichts zu tun — ${res.reason}`, details: [], warnings: [] };
        }
        return {
            pending: true,
            summary: `${res.rows.length} Zeile(n) tragen fälschlich source='user'`,
            details: describe(res),
            warnings: [],
        };
    },

    async up(ctx) {
        ensureSourceColumn(ctx.settingsDb);

        const res = analyse(ctx.settingsDb);
        if (res.reason) return { changed: 0, summary: `nichts zu tun — ${res.reason}` };

        // Nur `source`, nichts sonst — und über die IDs des geprüften Ergebnisses, damit
        // die Bedingung der Analyse und die des Schreibens nicht auseinanderlaufen können.
        const stmt = ctx.settingsDb.prepare(
            `UPDATE settings_history SET source = 'migration' WHERE id = ? AND source = 'user'`
        );
        let changed = 0;
        const tx = ctx.settingsDb.transaction(() => {
            for (const r of res.rows) changed += stmt.run(r.id).changes;
        });
        tx();

        return { changed, summary: `${changed} Zeile(n) auf source='migration' gesetzt` };
    },
};
