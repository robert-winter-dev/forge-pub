/**
 * Neue Tabelle `strategy_state` — welche Strategie ist gewählt (2026-09-03, LIQ#0368).
 *
 * Baustein B der Strategie-Auswahl (KB Strategien/strategie-auswahl.md). Genau eine Zeile
 * (`id = 1`) hält die aktive Strategie der Installation; der Geltungsbereich ist global je
 * Installation, nicht pro Pool (Zuschnitt der Initiative).
 *
 * 🔒 `strategy_id IS NULL` bedeutet „Standard" — die ABWESENHEIT einer Strategie
 * (Entscheidung 8). Es gibt bewusst keine ID und keinen Sonderwert dafür: Wäre „Standard"
 * ein Feldsatz, würde seine Auswahl alle handgepflegten Werte auf Defaults zurücksetzen,
 * und die Rückkehr wäre ein Eingriff ins Live-Kapital.
 *
 * 🔒 Einstufung `safe`: Diese Migration legt eine leere Tabelle an. Sie wählt keine
 * Strategie aus, schreibt keine Pool-Einstellung und kann keine Position schließen. Das
 * Anwenden eines Feldsatzes ist ein eigener, ausdrücklicher Vorgang
 * (`applyStrategy()` in bots/settings/lib/strategy-apply.js, dryRun als Default).
 *
 * ⚠️ Baseline-Falle, wie bei 0007: `baseline()` verbucht diese Migration auf einer
 * Neuinstallation als angewendet, ohne sie auszuführen. Der Zielzustand muss deshalb im
 * Code mitkommen — `ensureStrategyState()` in bots/settings/lib/strategy-apply.js legt die
 * Tabelle bei jedem Zugriff idempotent an. Diese Datei ist der formale, in der Übersicht
 * gemeldete Träger des Schemaschritts und meldet dann „bereits vorhanden".
 */
import { IMPACT_SAFE } from './runner.js';

const TABLE = 'strategy_state';

const CREATE = `
    CREATE TABLE IF NOT EXISTS strategy_state (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        strategy_id TEXT,              -- NULL = "Standard" (Abwesenheit einer Strategie)
        applied_at  INTEGER,
        version     INTEGER
    );
`;

/** True wenn die Tabelle bereits existiert. */
function tableExists(db) {
    try {
        return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(TABLE);
    } catch {
        return false;
    }
}

export default {
    id:          '0009-strategy-state',
    description: `${TABLE}: Tabelle für die aktive Strategie anlegen (NULL = Standard)`,
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        if (tableExists(ctx.settingsDb)) {
            return {
                pending: false,
                summary: `${TABLE} ist bereits vorhanden`,
                details: ['angelegt beim ersten Zugriff über ensureStrategyState() (siehe Kopfkommentar)'],
                warnings: [],
            };
        }
        return {
            pending: true,
            summary: `${TABLE} fehlt — wird leer angelegt`,
            details: ['keine Strategie wird dabei gewählt: die Tabelle bleibt leer, das entspricht "Standard"'],
            warnings: [],
        };
    },

    async up(ctx) {
        const existed = tableExists(ctx.settingsDb);
        ctx.settingsDb.exec(CREATE);
        if (!tableExists(ctx.settingsDb)) throw new Error(`${TABLE} fehlt nach dem CREATE`);
        return { summary: existed ? `${TABLE} war bereits vorhanden — nichts zu tun` : `${TABLE} angelegt` };
    },
};
