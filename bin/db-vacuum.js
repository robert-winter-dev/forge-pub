#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// FORGE – Einmal-VACUUM für aufgeblähte SQLite-DBs (CORE#000837)
// ══════════════════════════════════════════════════════════════════════════════
// DELETE gibt in SQLite keinen Platz ans Dateisystem zurück (KB Core/db-wachstum-retention.md).
// Dieses Skript verdichtet jede DB mit mindestens vacuum.minFreeRatio freien Seiten
// und mindestens vacuum.minDbMb Größe (config/db-retention.json).
//
//   node bin/db-vacuum.js                 nur anzeigen, was passieren würde (Trockenlauf)
//   node bin/db-vacuum.js --apply         wirklich VACUUM + integrity_check
//   node bin/db-vacuum.js --file <db>     nur diese DB (Standard: alle unter dem Datenverzeichnis)
//
// 🔒 --apply nur bei GESTOPPTEN Diensten (bin/svc stop …): VACUUM sperrt die DB exklusiv und
// braucht freien Platz in DB-Größe. Ist der Platz zu knapp oder die DB gesperrt, wird diese
// DB übersprungen (Exit 0, das Update darf deshalb nicht scheitern); ein integrity_check
// ungleich "ok" ergibt Exit 2.
// ══════════════════════════════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import { existsSync, statfsSync, statSync } from 'fs';
import { dirname } from 'path';
import { DATA_ROOT, botDbPath } from '../config/paths.js';
import { discoverDbs, freelistStats, loadRetentionConfig } from '../lib/db-growth.js';

const args  = process.argv.slice(2);
const apply = args.includes('--apply');
const one   = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const cfg   = loadRetentionConfig();
const minRatio = cfg.vacuum?.minFreeRatio ?? 0.3;
const minMb    = cfg.vacuum?.minDbMb ?? 20;
const mb = b => `${(b / 1e6).toFixed(1)} MB`;

const files = one ? [one] : [...new Set([
  ...discoverDbs([DATA_ROOT]),
  ...['liquidity', 'lending'].map(b => { try { return botDbPath(b); } catch { return null; } }).filter(f => f && existsSync(f)),
])].sort();

let integrityFailed = false;
for (const f of files) {
  let st;
  try { st = freelistStats(f); } catch (e) { console.log(`  ⚠ ${f}: nicht lesbar (${e.message}), übersprungen`); continue; }
  const pct = (st.freeRatio * 100).toFixed(0);
  if (st.sizeBytes < minMb * 1e6 || st.freeRatio < minRatio) {
    console.log(`  · ${f}: ${mb(st.sizeBytes)}, ${pct} % frei, kein VACUUM nötig`);
    continue;
  }
  const avail = (() => { try { const s = statfsSync(dirname(f)); return s.bavail * s.bsize; } catch { return null; } })();
  if (avail != null && avail < st.sizeBytes * 1.1) {
    console.log(`  ⚠ ${f}: ${mb(st.sizeBytes)}, ${pct} % frei, aber nur ${mb(avail)} Platz frei (VACUUM braucht DB-Größe), übersprungen`);
    continue;
  }
  if (!apply) { console.log(`  → ${f}: ${mb(st.sizeBytes)}, ${pct} % frei, würde VACUUM laufen (~${mb(st.sizeBytes - st.freeBytes)} danach). Trockenlauf, --apply nötig`); continue; }
  const db = new Database(f);
  try {
    db.pragma('busy_timeout = 5000');
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* kein WAL */ }
    db.exec('VACUUM');
    const res = db.pragma('integrity_check', { simple: true });
    const after = statSync(f).size;
    console.log(`  ✅ ${f}: ${mb(st.sizeBytes)} → ${mb(after)}, integrity_check=${res}`);
    if (res !== 'ok') integrityFailed = true;
  } catch (e) {
    console.log(`  ⚠ ${f}: VACUUM fehlgeschlagen (${e.message}), Datei unverändert`);
  } finally { db.close(); }
}
process.exit(integrityFailed ? 2 : 0);
