#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// FORGE – DB-Wachstumswächter als CLI (CORE#000837)
// ══════════════════════════════════════════════════════════════════════════════
//   node bin/db-growth.js                 alle DBs unter dem Datenverzeichnis prüfen
//   node bin/db-growth.js --file <db>     nur eine DB (z.B. eine Kopie)
//   node bin/db-growth.js --top 12        mehr Tabellen je DB zeigen (Standard 5)
//   node bin/db-growth.js --selftest      künstlicher Test auf einer temporären DB
// Exit 1 bei Warnung. Rein lesend. Läuft auch im Fork (dort ohne forge-check.js).
// Logik und Grenzen: lib/db-growth.js, config/db-retention.json.
// ══════════════════════════════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DATA_ROOT, botDbPath } from '../config/paths.js';
import { discoverDbs, inspectAll, inspectDb, formatReport, loadRetentionConfig } from '../lib/db-growth.js';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

function selftest() {
  const dir = mkdtempSync(join(tmpdir(), 'db-growth-'));
  const file = join(dir, 'liquiditybot.db');
  const DAY = 86_400_000, now = Date.now();
  let failed = 0;
  const check = (label, cond) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failed++; };
  try {
    const db = new Database(file);
    db.exec('CREATE TABLE advisor_log (id INTEGER PRIMARY KEY, recorded_at INTEGER)');
    db.exec('CREATE TABLE neue_tabelle (id INTEGER PRIMARY KEY, x INTEGER)');
    const ins = db.prepare('INSERT INTO advisor_log (recorded_at) VALUES (?)');
    ins.run(now - 3 * DAY);          // innerhalb der 14 Tage Retention
    const cfg = loadRetentionConfig();
    check('frische Daten: keine Warnung', inspectDb(file, cfg, now).warnings.length === 0);
    ins.run(now - (14 + cfg.warnBufferDays + 1) * DAY);   // älter als Retention + Puffer
    const w = inspectDb(file, cfg, now).warnings;
    check('Eintrag älter als Retention + Puffer: Warnung stale', w.some(x => x.id === 'db-growth-stale:liquiditybot.db:advisor_log'));
    db.prepare('DELETE FROM advisor_log WHERE recorded_at < ?').run(now - 14 * DAY);
    check('nach Prune: Warnung weg', inspectDb(file, cfg, now).warnings.length === 0);
    const tiny = { ...cfg, unboundedRowWarn: 2 };
    const ins2 = db.prepare('INSERT INTO neue_tabelle (x) VALUES (?)');
    for (let i = 0; i < 3; i++) ins2.run(i);
    check('unbekannte Tabelle über Zeilengrenze: Warnung unbounded',
      inspectDb(file, tiny, now).warnings.some(x => x.id === 'db-growth-unbounded:liquiditybot.db:neue_tabelle'));
    check('unbekannte Tabelle unter Zeilengrenze: still', inspectDb(file, cfg, now).warnings.length === 0);
    const small = { ...cfg, databases: { 'liquiditybot.db': { maxMb: 0.00001, tables: cfg.databases['liquiditybot.db'].tables } } };
    check('Datei über maxMb: Warnung size', inspectDb(file, small, now).warnings.some(x => x.id === 'db-growth-size:liquiditybot.db'));
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nSelbsttest bestanden');
  process.exit(failed ? 1 : 0);
}

if (args.includes('--selftest')) selftest();

const cfg = loadRetentionConfig();
const single = opt('--file');
const files = single
  ? [single]
  : [...new Set([
      ...discoverDbs([DATA_ROOT]),
      ...['liquidity', 'lending'].map(b => { try { return botDbPath(b); } catch { return null; } })
          .filter(f => f && existsSync(f)),
    ])].sort();

const results = inspectAll(files, cfg);
console.log('\n  🗄  DB-Wachstum (Retention laut config/db-retention.json):');
for (const l of formatReport(results, { topN: Number(opt('--top')) || 5 })) console.log(l);
const warnings = results.flatMap(r => r.warnings);
if (warnings.length) { console.log(''); for (const w of warnings) console.log(`  ⚠  ${w.message}`); }
else console.log('\n  ✅ keine Auffälligkeiten');
process.exit(warnings.length ? 1 : 0);
