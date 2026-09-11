/**
 * Gemeinsamer Schema-Helfer für `settings_history` (LIQ#0366).
 *
 * Warum nicht einfach in `0007-settings-history-source.js`: Migrationen laufen
 * alphabetisch, `0006-trailing-stop-cooldown-6h.js` also VOR `0007`. `0006` schreibt aber
 * selbst eine Historien-Zeile und muss sie als `source='migration'` kennzeichnen — sonst
 * greift der Spalten-Default `'user'` und die Migration sperrt die von ihr korrigierte
 * Zeile rückwirkend für jede künftige Default-Korrektur. Genau der Schaden, den die Spalte
 * verhindern soll. `0006` stellt die Spalte deshalb selbst sicher; `0007` bleibt der
 * formale, in der Übersicht gemeldete Träger dieses Schemaschritts und meldet dann
 * „bereits vorhanden".
 *
 * ⚠️ Dieselbe Spalte wird an zwei weiteren Stellen aufgeführt und muss dort identisch
 * bleiben: das `CREATE TABLE settings_history` in `bots/settings/routes/pools.js`
 * (Pflicht — `baseline()` überspringt Migrationen auf einer Neuinstallation, der
 * Zielzustand muss im Code mitkommen) und das idempotente Nachrüsten in dessen `openDb()`.
 */

/** Erlaubte Herkunftswerte. Muss zu HISTORY_SOURCES in bots/settings/routes/pools.js passen. */
export const HISTORY_SOURCES = ['user', 'strategy', 'migration', 'bot'];

/** True wenn `settings_history` existiert und die Spalte `source` trägt. */
export function hasSourceColumn(db) {
    try {
        return db.prepare(`PRAGMA table_info(settings_history)`).all().some(c => c.name === 'source');
    } catch {
        return false;
    }
}

/**
 * Legt `source` an, falls die Tabelle existiert und die Spalte fehlt. Idempotent.
 *
 * Kein CHECK auf HISTORY_SOURCES: `ALTER TABLE ADD COLUMN` und das `CREATE TABLE` im
 * Settings-Server würden sonst zwei verschiedene Schemata erzeugen, je nachdem ob eine
 * Installation migriert oder frisch aufgesetzt wurde. Geprüft wird im Code, an der
 * Schreibstelle (`recordSettingsHistory()`).
 *
 * @returns {'added'|'present'|'no-table'}
 */
export function ensureSourceColumn(db) {
    let cols;
    try {
        cols = db.prepare(`PRAGMA table_info(settings_history)`).all();
    } catch {
        return 'no-table';
    }
    if (!cols.length)                            return 'no-table';
    if (cols.some(c => c.name === 'source'))     return 'present';
    db.exec(`ALTER TABLE settings_history ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`);
    return 'added';
}
