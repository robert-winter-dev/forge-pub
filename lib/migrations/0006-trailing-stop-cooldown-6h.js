/**
 * Trailing-Stop-Cleanup-Cooldown von 1 h auf 6 h heben (2026-09-03, LIQ#0359).
 *
 * Der Cleanup läuft stündlich. Mit einem Cooldown von 1 h stieg „Bester Pool" nach einem
 * Trailing-Stop-Exit regelmäßig 1–2 h später in denselben Pool wieder ein — in 178
 * Kapital-Episoden seit März blockierte die Frist keinen einzigen Wiedereinstieg. 6 h hätten
 * 63 Wiedereinstiege verhindert, deren Ergebnis in Summe negativ war (Roundtrip-Kosten,
 * die nie verdient wurden). Zahlen und Methode:
 * KB Liquidity Bot/History/Verworfen/2026-09-03-tvl-slippage-invest-gate.md
 *
 * Der Code-Default steht seit 0.9.11+95 auf 6 h — er greift aber nur für neue Pools: jede
 * bestehende Pool- und Pool-Typ-Zeile trägt den alten Wert explizit. Diese Migration zieht
 * sie nach.
 *
 * 🔒 Einstufung `safe`: Ein längerer Cooldown kann weder eine Position schließen noch
 * Kapital bewegen — er verzögert nur den automatischen Wiedereinstieg. Frei werdendes
 * Kapital geht an den nächstbesten Pool oder bleibt liquide.
 *
 * 🔒 Eine bewusst gesetzte Frist bleibt unangetastet: Übersprungen wird jede Zeile, deren
 * `trailingStop.cooldownHours` laut `settings_history` je von Hand geändert wurde, und jede,
 * die nicht exakt auf dem alten Default 1 steht. Zeilen ohne das Feld bleiben ebenfalls
 * unberührt — dort greift bereits der neue Code-Fallback.
 */
import { IMPACT_SAFE } from './runner.js';
import { POOL_SETTINGS_DEFAULTS } from '../pool-settings-defaults.js';
import { ensureSourceColumn, hasSourceColumn } from './_settings-history.js';

const FIELD   = 'trailingStop.cooldownHours';
const OLD_H   = 1;
const NEW_H   = POOL_SETTINGS_DEFAULTS.trailingStop.cooldownHours;   // 6

/**
 * Zeilen (pool + pool_type), deren Cooldown-Frist je über die Oberfläche geändert wurde.
 *
 * 🔒 Verengt auf `source = 'user'` (LIQ#0366): Ab dem Strategie-Backend schreiben auch
 * nicht-menschliche Quellen in diese Tabelle. Ohne den Filter würde jede von einer
 * Strategie berührte Zeile hier als Nutzerentscheidung gelten und diese Migration — sowie
 * jede künftige Default-Korrektur — dort dauerhaft aussetzen.
 *
 * 🔒 Die Spalte wird geprüft, nicht vorausgesetzt: `plan()` darf nur lesen, kann das
 * Schema also nicht nachziehen. Fehlt die Spalte, gilt die alte Abfrage — korrekt, denn
 * alle Zeilen aus der Zeit vor der Spalte stammen vom Settings-Server oder aus einer
 * Migration und WAREN Nutzerentscheidungen. Ein hart eingebautes `AND source = 'user'`
 * würde dort werfen, der catch ein leeres Set liefern und die Migration genau die
 * handgesetzten Werte überschreiben, die sie schützen soll. `up()` ruft vorher
 * `ensureSourceColumn()` auf und sieht die Spalte deshalb immer.
 */
function userTouched(settingsDb) {
    const sourceFilter = hasSourceColumn(settingsDb) ? `AND source = 'user'` : '';
    try {
        const rows = settingsDb.prepare(
            `SELECT DISTINCT scope, scope_id FROM settings_history
              WHERE bot_id = 'liquidity' AND field = ? ${sourceFilter}`
        ).all(FIELD);
        return new Set(rows.map(r => `${r.scope}:${r.scope_id}`));
    } catch {
        return new Set();   // Tabelle fehlt (ältere Installation) → nichts als Nutzerentscheidung bekannt
    }
}

function readRows(settingsDb, table, idCol, scope) {
    let rows;
    try {
        rows = settingsDb.prepare(`SELECT ${idCol} AS id, settings FROM ${table} WHERE bot_id = 'liquidity'`).all();
    } catch {
        return [];
    }
    const out = [];
    for (const r of rows) {
        try { out.push({ scope, id: r.id, settings: JSON.parse(r.settings) }); } catch { /* unlesbar → überspringen */ }
    }
    return out;
}

function analyse(ctx) {
    if (NEW_H === OLD_H) return { touched: [], skipped: [] };
    const touchedByUser = userTouched(ctx.settingsDb);
    const rows = [
        ...readRows(ctx.settingsDb, 'pool_settings',      'pool_id',   'pool'),
        ...readRows(ctx.settingsDb, 'pool_type_settings', 'pool_type', 'pool_type'),
    ];
    const touched = [], skipped = [];
    for (const r of rows) {
        const ts = r.settings?.trailingStop;
        if (!ts || ts.cooldownHours === undefined) continue;           // Feld fehlt → Code-Fallback greift
        if (Number(ts.cooldownHours) !== OLD_H) continue;              // eigener Wert → Nutzerentscheidung
        if (touchedByUser.has(`${r.scope}:${r.id}`)) { skipped.push(r); continue; }
        touched.push(r);
    }
    return { touched, skipped };
}

const label = (r) => `${r.scope === 'pool_type' ? 'Typ ' : ''}${r.id}`;

export default {
    id:          '0006-trailing-stop-cooldown-6h',
    description: `Trailing-Stop-Cleanup-Cooldown ${OLD_H} h → ${NEW_H} h`,
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        const { touched, skipped } = analyse(ctx);
        return {
            pending: touched.length > 0,
            summary: touched.length
                ? `${touched.length} Eintrag/Einträge noch auf ${OLD_H} h`
                : `alle Einträge tragen ${NEW_H} h oder einen eigenen Wert`,
            details: [
                ...touched.map(r => `${label(r)}: ${OLD_H} h → ${NEW_H} h`),
                ...skipped.map(r => `${label(r)}: bleibt bei ${OLD_H} h (von Hand gesetzt)`),
            ],
            warnings: [],
        };
    },

    async up(ctx) {
        // Spalte `source` sicherstellen, BEVOR gelesen und geschrieben wird (LIQ#0366):
        // 0007 legt sie an, läuft aber alphabetisch erst nach dieser Migration. Ohne den
        // Schritt schreibt die Zeile unten ohne Herkunft, der Spalten-Default macht daraus
        // rückwirkend eine Nutzerentscheidung — und sperrt genau die Zeile, die diese
        // Migration korrigiert hat, für jede künftige Default-Korrektur.
        // Das Ergebnis von analyse() ändert sich dadurch nicht: alle vor dem ALTER
        // vorhandenen Zeilen tragen anschließend 'user', der Filter liefert dieselbe Menge.
        ensureSourceColumn(ctx.settingsDb);

        const { touched } = analyse(ctx);
        const now = Date.now();
        const upsertPool = ctx.settingsDb.prepare(`
            INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('liquidity', ?, ?)
            ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings`);
        const upsertType = ctx.settingsDb.prepare(`
            INSERT INTO pool_type_settings (bot_id, pool_type, settings) VALUES ('liquidity', ?, ?)
            ON CONFLICT(bot_id, pool_type) DO UPDATE SET settings = excluded.settings`);
        // Gleiche Form wie recordSettingsHistory() im Settings-Server, damit „wann wurde die
        // Frist geändert" auch für diese Korrektur beantwortbar bleibt.
        // source='migration' (LIQ#0366) — sonst würde die eigene Korrektur die betroffene
        // Zeile für jede künftige Default-Migration als Nutzerentscheidung sperren. Die
        // Spalte wird geprüft, weil 0007 alphabetisch erst nach dieser Migration läuft.
        let history = null;
        try {
            history = hasSourceColumn(ctx.settingsDb)
                ? ctx.settingsDb.prepare(`
                    INSERT INTO settings_history (bot_id, scope, scope_id, field, old_value, new_value, changed_at, source)
                    VALUES ('liquidity', ?, ?, ?, ?, ?, ?, 'migration')`)
                : ctx.settingsDb.prepare(`
                    INSERT INTO settings_history (bot_id, scope, scope_id, field, old_value, new_value, changed_at)
                    VALUES ('liquidity', ?, ?, ?, ?, ?, ?)`);
        } catch { /* Tabelle fehlt → ohne Historie fortfahren */ }

        const tx = ctx.settingsDb.transaction(() => {
            for (const r of touched) {
                r.settings.trailingStop.cooldownHours = NEW_H;
                (r.scope === 'pool' ? upsertPool : upsertType).run(r.id, JSON.stringify(r.settings));
                history?.run(r.scope, r.id, FIELD, JSON.stringify(OLD_H), JSON.stringify(NEW_H), now);
            }
        });
        tx();
        return { changed: touched.length, summary: `${touched.length} Eintrag/Einträge auf ${NEW_H} h gesetzt` };
    },
};
