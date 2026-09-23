// ══════════════════════════════════════════════════════════════════════════════
// FORGE – DB-Wachstumswächter (CORE#000837)
// ══════════════════════════════════════════════════════════════════════════════
// Prüft je SQLite-DB und Tabelle Größe, Zeilenzahl und ältesten Eintrag gegen die
// Retention aus config/db-retention.json. Rein lesend (readonly-Handle).
//
// Warum: liquiditybot.db wuchs auf 422 MB, weil vier Tabellen keine Retention hatten
// und ein Prune an einem Job hing, den der Fork nie ausführt (KB Core/db-wachstum-retention.md).
// Eine Notiz verhindert das nicht, dieser Test schlägt an.
//
// Warnungen (id, message):
//   db-growth-stale:<db>:<tabelle>  ältester Eintrag älter als Retention + Puffer
//   db-growth-unbounded:<db>:<tab>  keine Retention hinterlegt und mehr als unboundedRowWarn Zeilen
//   db-growth-size:<db>             Datei über maxMb
// ══════════════════════════════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DAY = 86_400_000;
const CONFIG_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'db-retention.json');

export function loadRetentionConfig(file = CONFIG_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Freie Seiten einer DB: Anteil und absolute Größen (für Wächter und VACUUM-Entscheidung). */
export function freelistStats(dbFile) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const pageSize  = db.pragma('page_size', { simple: true });
    const pageCount = db.pragma('page_count', { simple: true });
    const free      = db.pragma('freelist_count', { simple: true });
    return {
      sizeBytes: pageSize * pageCount,
      freeBytes: pageSize * free,
      freeRatio: pageCount ? free / pageCount : 0,
    };
  } finally { db.close(); }
}

/** Alle nicht leeren *.db unter root und root/<unterordner> (ohne backups). */
export function discoverDbs(roots) {
  const found = new Set();
  const add = f => { try { if (statSync(f).size > 0) found.add(f); } catch { /* fehlt */ } };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, e.name);
      if (e.isFile() && e.name.endsWith('.db')) add(p);
      else if (e.isDirectory() && e.name !== 'backups' && e.name !== 'checks') {
        for (const s of readdirSync(p, { withFileTypes: true })) {
          if (s.isFile() && s.name.endsWith('.db')) add(join(p, s.name));
        }
      }
    }
  }
  return [...found].sort();
}

function oldestMs(db, table, spec) {
  const r = db.prepare(`SELECT MIN("${spec.column}") AS m FROM "${table}"`).get();
  if (r.m == null) return null;
  if (spec.unit === 'iso') { const t = Date.parse(r.m); return Number.isNaN(t) ? null : t; }
  return Number(r.m);
}

/**
 * @returns {{file, name, sizeBytes, freeRatio, tables: object[], warnings: {id, message}[]}}
 */
export function inspectDb(file, cfg = loadRetentionConfig(), nowMs = Date.now()) {
  const name = basename(file);
  const dbCfg = cfg.databases?.[name] ?? {};
  const tableCfg = dbCfg.tables ?? {};
  const maxMb = dbCfg.maxMb ?? cfg.defaultMaxMb;
  const bufferDays = cfg.warnBufferDays ?? 7;
  const rowWarn = cfg.unboundedRowWarn ?? 500_000;
  const warnings = [];
  const db = new Database(file, { readonly: true });
  try {
    const pageSize  = db.pragma('page_size', { simple: true });
    const pageCount = db.pragma('page_count', { simple: true });
    const sizeBytes = pageSize * pageCount;
    const freeRatio = pageCount ? db.pragma('freelist_count', { simple: true }) / pageCount : 0;

    const bytesByName = {};
    try {
      for (const r of db.prepare('SELECT name, SUM(pgsize) AS b FROM dbstat GROUP BY name').all()) bytesByName[r.name] = r.b;
    } catch { /* dbstat nicht einkompiliert: Größe je Tabelle unbekannt */ }

    const tables = [];
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name: t } of names) {
      const spec = tableCfg[t] ?? null;
      const rows = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      const row = { name: t, rows, bytes: bytesByName[t] ?? null, oldestMs: null, retentionDays: null, status: 'ok' };

      if (spec?.column) {
        row.retentionDays = spec.retentionDays;
        try { row.oldestMs = oldestMs(db, t, spec); }
        catch (e) { row.status = 'fehler'; warnings.push({ id: `db-growth-config:${name}:${t}`, message: `${name}.${t}: Zeitstempelspalte "${spec.column}" nicht lesbar (${e.message}), config/db-retention.json prüfen` }); }
        if (row.oldestMs != null) {
          const ageDays = (nowMs - row.oldestMs) / DAY;
          if (ageDays > spec.retentionDays + bufferDays) {
            row.status = 'stale';
            warnings.push({
              id: `db-growth-stale:${name}:${t}`,
              message: `${name}.${t}: ältester Eintrag ${Math.floor(ageDays)} Tage alt, Retention ${spec.retentionDays} Tage + ${bufferDays} Puffer (${rows} Zeilen). Prune läuft nicht?`,
            });
          }
        }
      } else if (spec?.unbounded || spec?.boundedBy) {
        row.status = spec.unbounded ? 'unbegrenzt (bewusst)' : `an ${spec.boundedBy} gebunden`;
      } else if (rows > rowWarn) {
        row.status = 'ohne Retention';
        warnings.push({
          id: `db-growth-unbounded:${name}:${t}`,
          message: `${name}.${t}: ${rows} Zeilen, keine Retention in config/db-retention.json hinterlegt`,
        });
      }
      tables.push(row);
    }
    tables.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.rows - a.rows);

    if (sizeBytes > maxMb * 1e6) {
      warnings.push({
        id: `db-growth-size:${name}`,
        message: `${name}: ${(sizeBytes / 1e6).toFixed(0)} MB über Grenze ${maxMb} MB (${(freeRatio * 100).toFixed(0)} % freie Seiten${freeRatio >= (cfg.vacuum?.minFreeRatio ?? 0.3) ? ', VACUUM lohnt: bin/db-vacuum.js' : ''})`,
      });
    }
    return { file, name, sizeBytes, freeRatio, tables, warnings };
  } finally { db.close(); }
}

export function inspectAll(files, cfg = loadRetentionConfig(), nowMs = Date.now()) {
  return files.map(f => {
    try { return inspectDb(f, cfg, nowMs); }
    catch (e) {
      return { file: f, name: basename(f), sizeBytes: 0, freeRatio: 0, tables: [],
               warnings: [{ id: `db-growth-unreadable:${basename(f)}`, message: `${basename(f)}: nicht lesbar (${e.message})` }] };
    }
  });
}

export function formatReport(results, { topN = 5 } = {}) {
  const lines = [];
  for (const r of results) {
    lines.push(`  ${r.name.padEnd(22)} ${(r.sizeBytes / 1e6).toFixed(1).padStart(7)} MB  frei ${(r.freeRatio * 100).toFixed(0).padStart(2)} %`);
    for (const t of r.tables.slice(0, topN)) {
      const mb = t.bytes == null ? '      ?' : (t.bytes / 1e6).toFixed(1).padStart(7);
      const oldest = t.oldestMs == null ? '-' : new Date(t.oldestMs).toISOString().slice(0, 10);
      const flag = t.status === 'stale' || t.status === 'ohne Retention' || t.status === 'fehler' ? '⚠ ' : '  ';
      lines.push(`   ${flag}${mb} MB ${String(t.rows).padStart(9)} Z.  ältester ${oldest.padEnd(10)}  ${t.name}${t.retentionDays ? ` (${t.retentionDays} d)` : ''}${t.status !== 'ok' ? `  [${t.status}]` : ''}`);
    }
  }
  return lines;
}
