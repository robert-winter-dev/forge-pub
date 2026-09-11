/**
 * `settings_history` bekommt eine Spalte `source` (2026-09-03, LIQ#0366).
 *
 * Werte: 'user' | 'strategy' | 'migration' | 'bot'. Erster Baustein der Strategie-Auswahl
 * (KB Strategien/strategie-auswahl.md, Entscheidungen 2 und 7): Eine Strategie schreibt
 * ihren Feldsatz per Bulk-Write wie die heutige Pool-Typ-Ebene und muss dabei erkennbar
 * bleiben.
 *
 * 🔒 Warum das Voraussetzung ist, nicht Komfort: `userTouched()` in
 * `0006-trailing-stop-cooldown-6h.js` liest `settings_history` als Liste der von Hand
 * gesetzten Werte und lässt Default-Migrationen dort dauerhaft aussetzen. Ohne die Spalte
 * würde jeder von einer Strategie berührte Pool als Nutzerentscheidung gelten — ein
 * bestehender Schutzmechanismus wäre beschädigt.
 *
 * Der Default `'user'` gilt bewusst für die Altzeilen: alle vor Einführung der Spalte
 * geschriebenen Zeilen stammen aus dem Settings-Server oder aus `0006` selbst, waren also
 * Nutzerentscheidungen. Für neuen Code ist der Default kein Freifahrtschein —
 * `recordSettingsHistory()` verlangt den Wert und wirft ohne ihn.
 *
 * 🔒 Einstufung `safe`: reines Schema. Eine zusätzliche Spalte mit Default kann weder eine
 * Position schließen noch Kapital bewegen; kein Bot liest `settings_history`.
 *
 * ── Zwei Baseline-Fallen, die hier bewusst abgedeckt sind ────────────────────
 * 1. `baseline()` verbucht diese Migration auf einer Neuinstallation als angewendet, ohne
 *    sie auszuführen (`bin/setup-lib/lifecycle.sh` → `bin/migrate.js --baseline`). Der
 *    Zielzustand muss also im Code mitkommen: das `CREATE TABLE settings_history` in
 *    `bots/settings/routes/pools.js` trägt die Spalte selbst. Sonst hätte eine frische
 *    Installation eine Tabelle ohne `source`, während diese Migration als erledigt gilt.
 * 2. Migrationen laufen alphabetisch — `0006` also VOR `0007`. Auf einer Installation, die
 *    beide erstmals einspielt, sieht `0006` die Spalte noch nicht. Deshalb prüft
 *    `userTouched()` dort die Spalte per PRAGMA statt sie vorauszusetzen.
 *
 * Der ALTER selbst steht in `_settings-history.js`: `0006` braucht die Spalte bereits für
 * seine eigene Historien-Zeile (Falle 2 oben) und stellt sie deshalb selbst sicher. Diese
 * Migration bleibt der formale, in der Übersicht gemeldete Träger des Schemaschritts —
 * sie meldet dann „bereits vorhanden" und wird regulär verbucht.
 */
import { IMPACT_SAFE } from './runner.js';
import { ensureSourceColumn, hasSourceColumn } from './_settings-history.js';

const TABLE  = 'settings_history';
const COLUMN = 'source';

/**
 * @returns {{table: boolean, column: boolean}} Zustand des Schemas.
 *          Eine fehlende Tabelle ist kein Fehler: Installationen ohne je geöffneten
 *          Settings-Server haben sie noch nicht, `openDb()` legt sie dann korrekt an.
 */
function schemaState(db) {
    try {
        const cols = db.prepare(`PRAGMA table_info(${TABLE})`).all();
        if (!cols.length) return { table: false, column: false };
        return { table: true, column: cols.some(c => c.name === COLUMN) };
    } catch {
        return { table: false, column: false };
    }
}

export default {
    id:          '0007-settings-history-source',
    description: `${TABLE}: Spalte ${COLUMN} ergänzen ('user' | 'strategy' | 'migration' | 'bot')`,
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        const { table, column } = schemaState(ctx.settingsDb);
        if (!table) {
            return {
                pending: false,
                summary: `${TABLE} existiert noch nicht — der Settings-Server legt sie mit der Spalte an`,
                details: [], warnings: [],
            };
        }
        if (column) {
            return {
                pending: false,
                summary: `Spalte ${COLUMN} ist bereits vorhanden`,
                details: ['angelegt beim Öffnen der Settings-DB oder von 0006 (siehe Kopfkommentar)'],
                warnings: [],
            };
        }
        let rows = 0;
        try { rows = ctx.settingsDb.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()?.n ?? 0; } catch { /* egal */ }
        return {
            pending: true,
            summary: `Spalte ${COLUMN} fehlt — wird mit Default 'user' ergänzt`,
            details: [`${rows} bestehende Zeile(n) gelten danach als source='user' (siehe Kopfkommentar)`],
            warnings: [],
        };
    },

    async up(ctx) {
        const res = ensureSourceColumn(ctx.settingsDb);
        if (res === 'no-table') return { summary: `${TABLE} existiert nicht — nichts zu tun` };
        if (res === 'present')  return { summary: `Spalte ${COLUMN} war bereits vorhanden — nichts zu tun` };
        if (!hasSourceColumn(ctx.settingsDb)) throw new Error(`Spalte ${COLUMN} fehlt nach dem ALTER`);
        return { summary: `Spalte ${COLUMN} ergänzt (Default 'user')` };
    },
};
