/**
 * FORGE – Migrations-Runner
 *
 * Datenkorrekturen, die eine neue Programmversion voraussetzt, laufen genau einmal pro
 * Installation. Bis 2026-08-22 lagen sie als lose `bin/migrate-*.js` herum: keins davon war
 * in der Fork-Allowlist, keins wurde von `setup.sh` aufgerufen, keins ist je auf einer
 * Fork-Installation gelaufen. Drei davon ändern Pool-Einstellungen — Installationen konnten
 * also unbemerkt mit Werten weiterlaufen, die zentral längst korrigiert waren.
 *
 * Das Verfahren ist der Standard aus Flyway/Liquibase/Rails: nummerierte Migrationen, eine
 * Tabelle mit den bereits angewendeten IDs, Ausführung in Reihenfolge, jede genau einmal.
 *
 * ── Was FORGE zusätzlich braucht ─────────────────────────────────────────────
 * Übliche Migrationsframeworks gehen davon aus, dass eine Migration Daten umformt. Hier kann
 * sie **Kapital bewegen**: Eine korrigierte Drawdown-Schwelle kann im nächsten Bot-Zyklus
 * einen Exit auslösen (am 2026-08-22 real geschehen, Position über 1500 USDC). Deshalb trägt
 * jede Migration eine Einstufung:
 *
 *   'safe'       Schema, Meldungstexte, Einstellungen ohne Auslösewirkung
 *                → läuft automatisch mit dem Update
 *   'financial'  kann eine Position schließen oder Kapital bewegen
 *                → läuft NIE automatisch; wird gemeldet und wartet auf eine Entscheidung
 *
 * 🔒 Diese Trennung ist der Kern des Moduls. Eine `financial`-Migration ohne ausdrückliche
 * Bestätigung auszuführen, wäre ein stillschweigender Eingriff in fremdes Kapital.
 *
 * ── Baseline ─────────────────────────────────────────────────────────────────
 * Eine frische Installation bringt die korrigierten Werte bereits im Code mit; alte
 * Migrationen dürfen dort nicht laufen (`0001` würde einen Zustand herstellen, den `0002`
 * längst abgelöst hat). `baseline()` verbucht deshalb bei einer Neuinstallation alle
 * bekannten Migrationen als angewendet, ohne sie auszuführen.
 */

import { readdir }         from 'node:fs/promises';
import { dirname, join }   from 'node:path';
import { fileURLToPath }   from 'node:url';
import Database            from 'better-sqlite3';

import { PATHS } from '../../config/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const IMPACT_SAFE      = 'safe';
export const IMPACT_FINANCIAL = 'financial';

// ─── Buchführung ─────────────────────────────────────────────────────────────

/**
 * Die Tabelle liegt in `settings.db`: Sie existiert auf jeder Installation, gehört keinem
 * einzelnen Bot und überlebt ein Code-Update (der Update-Pfad fasst `local/` nicht an).
 */
export function ensureTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS applied_migrations (
            id         TEXT    PRIMARY KEY,
            applied_at INTEGER NOT NULL,
            impact     TEXT,
            mode       TEXT,     -- 'applied' | 'baseline' | 'superseded'
            note       TEXT
        )
    `);
}

/**
 * Muss auch auf einer readonly geöffneten DB funktionieren: Die Übersicht und `--dry-run`
 * dürfen nichts schreiben, und eine noch nicht angelegte Tabelle bedeutet dort schlicht
 * „keine Migration verbucht" — kein Fehler.
 */
export function appliedIds(db) {
    const read = () => new Set(db.prepare('SELECT id FROM applied_migrations').all().map(r => r.id));
    try {
        return read();
    } catch {
        try { ensureTable(db); return read(); } catch { return new Set(); }
    }
}

export function markApplied(db, migration, { mode = 'applied', note = null } = {}) {
    ensureTable(db);
    db.prepare(`
        INSERT INTO applied_migrations (id, applied_at, impact, mode, note)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
    `).run(migration.id, Date.now(), migration.impact ?? IMPACT_SAFE, mode, note);
}

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * Lädt alle Migrationen aus diesem Verzeichnis. Die Dateinamen beginnen mit einer
 * vierstelligen Nummer; die alphabetische Sortierung ist damit die Ausführungsreihenfolge.
 */
export async function loadMigrations() {
    const files = (await readdir(__dirname))
        .filter(f => /^\d{4}-.*\.js$/.test(f))
        .sort();

    const out = [];
    for (const file of files) {
        const mod = await import(join(__dirname, file));
        const m   = mod.default;
        if (!m?.id) throw new Error(`Migration ${file} exportiert kein gültiges Objekt (id fehlt)`);
        if (m.impact !== IMPACT_SAFE && m.impact !== IMPACT_FINANCIAL) {
            throw new Error(`Migration ${m.id}: impact muss '${IMPACT_SAFE}' oder '${IMPACT_FINANCIAL}' sein`);
        }
        out.push({ ...m, file });
    }
    return out;
}

// ─── Ausführungskontext ──────────────────────────────────────────────────────

/**
 * Öffnet die benötigten Datenbanken. `liquidityDb` ist optional — eine Installation ohne
 * Liquidity-Bot soll den Runner trotzdem benutzen können.
 *
 * Beide Handles folgen demselben `readonly`: Die Übersicht und `--dry-run` dürfen nirgends
 * schreiben, `--apply` schon. Bis 2026-08-22 war `liquidityDb` fest readonly — damals
 * schrieb noch keine Migration in eine Bot-DB, seit `0005-phantom-fee-snapshots` (Korrektur
 * fehlerhafter Messwerte in `position_snapshots`) ist das nötig.
 *
 * 🔒 Unkritisch trotz laufender Bots: `run_migrations()` in `bin/setup-lib/lifecycle.sh`
 * läuft nach dem Deploy und VOR dem Start der Dienste. Und selbst bei einem manuellen Lauf
 * im Betrieb serialisiert SQLite im WAL-Modus die Schreiber — der Bot hat keinen exklusiven
 * Lock auf seine Datei, nur die Konvention, dass sonst niemand schreibt.
 */
export function openContext({ readonly = false } = {}) {
    const settingsDb = new Database(PATHS.settingsDb, { readonly });
    let liquidityDb = null;
    try {
        liquidityDb = new Database(PATHS.liquidityDb, { readonly });
        // Zugriff erzwingen: eine nicht vorhandene Datei fällt sonst erst später auf.
        liquidityDb.prepare('SELECT 1').get();
    } catch {
        liquidityDb = null;
    }
    return {
        settingsDb,
        liquidityDb,
        close() {
            try { settingsDb.close(); }  catch { /* egal */ }
            try { liquidityDb?.close(); } catch { /* egal */ }
        },
    };
}

// ─── Planen und Anwenden ─────────────────────────────────────────────────────

/**
 * Was steht an? Ruft `plan()` jeder offenen Migration auf — das darf nur lesen.
 *
 * @returns {Promise<Array>} je Eintrag { migration, applied, plan }
 */
export async function planAll(ctx) {
    const migrations = await loadMigrations();
    const done       = appliedIds(ctx.settingsDb);
    const out        = [];

    for (const m of migrations) {
        if (done.has(m.id)) {
            out.push({ migration: m, applied: true, plan: null });
            continue;
        }
        if (m.superseded) {
            out.push({ migration: m, applied: false, plan: { pending: false, summary: m.supersededNote ?? 'durch eine spätere Migration abgelöst', details: [], warnings: [] } });
            continue;
        }
        let plan;
        try {
            plan = await m.plan(ctx);
        } catch (err) {
            plan = { pending: false, error: err.message, summary: `Prüfung fehlgeschlagen: ${err.message}`, details: [], warnings: [] };
        }
        out.push({ migration: m, applied: false, plan });
    }
    return out;
}

/**
 * Führt die offenen Migrationen aus.
 *
 * 🔒 `financial`-Migrationen laufen nur mit `includeFinancial: true`. Der automatische
 * Aufruf aus dem Update-Pfad setzt das nie — dort werden sie ausschließlich gemeldet.
 *
 * @returns {Promise<{applied: Array, deferred: Array, failed: Array}>}
 */
export async function applyAll(ctx, { includeFinancial = false, onlyId = null, log = console.log } = {}) {
    const entries  = await planAll(ctx);
    const applied  = [];
    const deferred = [];
    const failed   = [];

    for (const { migration: m, applied: already, plan } of entries) {
        if (already) continue;
        if (onlyId && m.id !== onlyId) continue;

        if (m.superseded) {
            markApplied(ctx.settingsDb, m, { mode: 'superseded', note: m.supersededNote ?? null });
            log(`  ○ ${m.id} — ${m.supersededNote ?? 'abgelöst, nichts zu tun'}`);
            continue;
        }
        if (plan?.error) { failed.push({ m, error: plan.error }); continue; }
        if (!plan?.pending) {
            // Nichts zu tun — trotzdem verbuchen, sonst wird sie bei jedem Lauf neu geprüft.
            markApplied(ctx.settingsDb, m, { note: 'nichts zu tun' });
            log(`  ○ ${m.id} — nichts zu tun`);
            continue;
        }
        if (m.impact === IMPACT_FINANCIAL && !includeFinancial) {
            deferred.push({ m, plan });
            continue;
        }

        try {
            const res = await m.up(ctx);
            markApplied(ctx.settingsDb, m, { note: res?.summary ?? null });
            applied.push({ m, res });
            log(`  ✓ ${m.id} — ${res?.summary ?? 'angewendet'}`);
        } catch (err) {
            failed.push({ m, error: err.message });
            log(`  ✗ ${m.id} — fehlgeschlagen: ${err.message}`);
        }
    }
    return { applied, deferred, failed };
}

/**
 * Verbucht alle bekannten Migrationen als angewendet, ohne sie auszuführen.
 * Für Neuinstallationen: der Code bringt die korrigierten Werte bereits mit.
 */
export async function baseline(ctx, { log = console.log } = {}) {
    const migrations = await loadMigrations();
    const done       = appliedIds(ctx.settingsDb);
    let n = 0;
    for (const m of migrations) {
        if (done.has(m.id)) continue;
        markApplied(ctx.settingsDb, m, { mode: 'baseline', note: 'Neuinstallation — Code bringt den Zielzustand mit' });
        n++;
    }
    log(`Baseline gesetzt: ${n} Migration(en) als angewendet verbucht, keine ausgeführt.`);
    return n;
}

/**
 * Heuristik für „frische Installation": noch keine Pool-Einstellungen vorhanden.
 * Wird von `setup.sh install` genutzt, damit alte Migrationen dort nicht anlaufen.
 */
export function looksLikeFreshInstall(ctx) {
    try {
        const row = ctx.settingsDb.prepare(
            `SELECT COUNT(*) AS n FROM pool_settings`
        ).get();
        return (row?.n ?? 0) === 0;
    } catch {
        return true;   // Tabelle gibt es noch nicht → frisch
    }
}
