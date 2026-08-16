/**
 * FORGE public Premium – Fork-seitiger Ingest
 *
 * Baustein 4 der Premium-Anbindung (siehe datenaustausch.md
 * „PoC-Spezifikation" Punkt 3). Läuft NUR im FORGE-public-Fork (bzw. hier zu Testzwecken auch
 * auf dem Master gegen eine isolierte Test-DB, siehe selfTest()) — Gegenstück zu
 * core/premium/publish-blob.js auf dem Master.
 *
 * Bisher nur `marketTable` (Klasse-A/B-Ingest folgt additiv, sobald der Master sie
 * publiziert). Schreibt in `pool_score_history` (idempotent) + aktualisiert die mtime von
 * `data/pool-scores.json`, deren mtime früher der Ranking-Exit als reines Frische-Gate las
 * (Feature 2026-08-15 ausgebaut; siehe [[master-architektur]] Befund 1 — der Dateiinhalt selbst wurde dabei NICHT
 * gelesen, nur `statSync(...).mtimeMs`).
 *
 * Versionierungs-Reihenfolge exakt wie in [[blob-schema]] festgelegt: schemaVersion →
 * sequence (> zuletzt integriert) → generatedAt (nicht Zukunft, nicht zu alt) → erst dann
 * integrieren. Bei Ablehnung bleiben die alten Daten unverändert (kein Teil-Ingest).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { downloadBlob } from '../../../lib/blob-download.js';
import { decryptBlob } from '../../../lib/premium-blob.js';
import { insertPoolScoreHistory } from './db.js';
import { DELIVERED_SCORES_PATH } from './invest-score-provider.js';
import { writePoolOffers, loadPoolOffers } from './premium-offers-store.js';
import { PATHS } from '../../../config/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPPORTED_SCHEMA_VERSIONS = [1];
// Publish-Takt ist 10 Min (config/cron-jobs.json) — 30 Min Toleranz deckt einen
// verpassten Publish-Lauf + Zustellverzögerung ab, ohne echte Ausfälle zu verschleiern.
const MAX_BLOB_AGE_MS = 30 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000; // Uhr-Drift zwischen Master und Fork

function ensureIngestStateTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS premium_ingest_state (
            id                INTEGER PRIMARY KEY CHECK (id = 1),
            last_sequence     INTEGER NOT NULL DEFAULT 0,
            last_ingested_at  INTEGER
        );
        INSERT OR IGNORE INTO premium_ingest_state (id, last_sequence) VALUES (1, 0);
    `);
    // last_covered_hour_id (2026-08-13, Systemdaten-Freigabe): die Abrechnungsstunde,
    // für die zuletzt tatsächlich Daten vorlagen — abgeleitet aus `generatedAt` des
    // Blobs, das der Master exakt zusammen mit seiner hourId setzt
    // (core/premium/publish-blob.js). Bewusst NICHT `last_ingested_at` (Empfangszeit):
    // bei einer verzögerten Zustellung würde die Deckung sonst eine Stunde zu weit
    // reichen. Bis hierher ließ sich die Deckung nur aus `premium_pay_log` ableiten —
    // einer Tabelle, die ausschließlich beim Bezahlen gefüllt wird und bei einem
    // Teilnehmer der Systemdaten-Freigabe deshalb für immer leer bleibt.
    const cols = db.prepare(`PRAGMA table_info(premium_ingest_state)`).all().map(c => c.name);
    if (!cols.includes('last_covered_hour_id')) {
        db.exec(`ALTER TABLE premium_ingest_state ADD COLUMN last_covered_hour_id INTEGER`);
    }
}

/**
 * Zuletzt integrierte Sequenznummer (0, wenn noch nie integriert). Exportiert, damit
 * z.B. bin/premium-fetch.js --dry-run denselben Stand für validateEnvelope() nutzen
 * kann, ohne die interne Tabelle selbst anzulegen/kennen zu müssen.
 */
export function getLastSequence(db) {
    ensureIngestStateTable(db);
    return db.prepare(`SELECT last_sequence FROM premium_ingest_state WHERE id = 1`).get().last_sequence;
}

function setLastSequence(db, sequence, coveredHourId = null) {
    const current = db.prepare(`SELECT last_covered_hour_id AS h FROM premium_ingest_state WHERE id = 1`).get()?.h ?? null;
    // Bewusst in JS statt als SQL-MAX über COALESCE(...,-1): der Sentinel -1 würde bei
    // fehlender Stunde eine Deckung BEHAUPTEN, wo keine ist (-1 ist nicht NULL, und
    // (-1+1)*3600000 = 0 ergäbe „gedeckt bis 1970"). Zwei Regeln, beide fail-safe:
    // eine später eintreffende ältere Lieferung nimmt eine erreichte Deckung nie
    // zurück, und eine Lieferung ohne lesbare Stunde lässt den Stand unverändert.
    const covered = coveredHourId == null ? current
                  : current == null      ? coveredHourId
                  : Math.max(current, coveredHourId);
    db.prepare(`
        UPDATE premium_ingest_state
           SET last_sequence = ?, last_ingested_at = ?, last_covered_hour_id = ?
         WHERE id = 1
    `).run(sequence, Date.now(), covered);
}

/**
 * Prüft einen entschlüsselten Blob gegen die Versionierungsregeln aus [[blob-schema]],
 * bevor irgendetwas geschrieben wird.
 */
export function validateEnvelope(data, lastSequence) {
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(data?.schemaVersion)) {
        return { valid: false, reason: `unbekannte schemaVersion ${data?.schemaVersion}` };
    }
    if (!(Number.isFinite(data.sequence) && data.sequence > lastSequence)) {
        return { valid: false, reason: `sequence ${data.sequence} nicht neuer als zuletzt integriert (${lastSequence})` };
    }
    const generatedTs = Date.parse(data.generatedAt ?? '');
    if (!Number.isFinite(generatedTs)) {
        return { valid: false, reason: 'generatedAt fehlt oder ungültig' };
    }
    const now = Date.now();
    if (generatedTs > now + FUTURE_TOLERANCE_MS) {
        return { valid: false, reason: 'generatedAt liegt in der Zukunft' };
    }
    if (now - generatedTs > MAX_BLOB_AGE_MS) {
        return { valid: false, reason: `Blob zu alt (${Math.round((now - generatedTs) / 60000)} Min)` };
    }
    return { valid: true };
}

function touchScoresJsonFreshness(scoresJsonPath) {
    fs.mkdirSync(path.dirname(scoresJsonPath), { recursive: true });
    if (!fs.existsSync(scoresJsonPath)) fs.writeFileSync(scoresJsonPath, '{}');
    const now = new Date();
    fs.utimesSync(scoresJsonPath, now, now);
}

/**
 * Schreibt JSON atomar (temp-Datei im selben Verzeichnis + rename). Verhindert, dass ein
 * gleichzeitiger Reader (export.js läuft im ~60s-Takt, dieser Ingest nur alle ~10 Min, siehe
 * bot.js) die Datei mitten im Schreibvorgang als Torso sieht: ein `writeFileSync` direkt auf
 * den Zielpfad truncatet zuerst und schreibt dann – ein `readFileSync` in genau diesem Fenster
 * liefert kaputtes JSON, `JSON.parse` wirft, `invest-score-provider.js` wertet das als „nie
 * geliefert" (kind: 'none') statt als transienten Lesefehler und lässt Premium-Tabelle +
 * -Zugriff für einen Export-Zyklus verschwinden, obwohl bezahlt und aktiv (2026-07-30
 * beobachtet). `rename()` innerhalb desselben Dateisystems ist POSIX-atomar – ein Reader sieht
 * immer entweder die alte oder die vollständige neue Datei, nie etwas dazwischen.
 */
function writeJsonAtomic(filePath, data) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
}

/**
 * Integriert einen bereits entschlüsselten + validierten Blob in die Bot-DB.
 * Idempotent: eine Zeile pro (pool_id, recorded_at) — recorded_at kommt aus
 * data.generatedAt, ist also für alle Pools desselben Blobs identisch.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} data
 * @param {object} [opts]
 * @param {string} [opts.scoresJsonPath] - Default: bots/liquidity/data/pool-scores.json;
 *   überschreibbar für Tests.
 * @param {string} [opts.deliveredScoresPath] - Default: DELIVERED_SCORES_PATH (die echte
 *   Naht aus invest-score-provider.js); überschreibbar für Tests.
 * @param {string} [opts.poolOffersPath] - Default: bots/liquidity/data/premium/pool-offers.json
 *   (reine Ablage, siehe Kommentar unten); überschreibbar für Tests.
 * @returns {{ ingested: boolean, reason?: string, rows?: number, coveredPools?: string[], scoresWritten?: boolean, poolOffersWritten?: boolean }}
 */
export function ingestBlob(db, data, {
    scoresJsonPath = PATHS.liquidityScores,
    deliveredScoresPath = DELIVERED_SCORES_PATH,
    poolOffersPath = path.join(PATHS.liquidityData, 'premium', 'pool-offers.json'),
} = {}) {
    const lastSequence = getLastSequence(db);
    const check = validateEnvelope(data, lastSequence);
    if (!check.valid) return { ingested: false, reason: check.reason };

    const recordedAt = Date.parse(data.generatedAt);
    let rows = 0;
    let scoreHistoryRows = 0;
    const txn = db.transaction(() => {
        for (const p of data.marketTable ?? []) {
            const existing = db.prepare(
                `SELECT 1 FROM pool_score_history WHERE pool_id = ? AND recorded_at = ?`
            ).get(p.id, recordedAt);
            if (existing) continue;

            insertPoolScoreHistory(db, {
                poolId:        p.id,
                recordedAt,
                tier:          p.tier ?? null,
                shortTermTier: p.short_term_tier ?? null,
                rankPos:       p.rank ?? null,
                rankOf:        p.of ?? null,
                netAprPct:     p.net_apr_pct ?? null,
                grossAprPct:   p.gross_apr_pct ?? null,
            });
            rows++;
        }

        // Klasse B (scoreHistory) — laufender Score-Punkt, additiv/optional wie
        // scores. Eigener recorded_at pro Zeile (data.scoreHistory[].t), unabhängig vom
        // marketTable-Zeitstempel — beide speisen dieselbe Tabelle mit unterschiedlicher
        // Taktung, das ist beabsichtigt (dichtere Stichprobe der Score-Historie).
        for (const h of data.scoreHistory ?? []) {
            const hRecordedAt = h.t;
            const existing = db.prepare(
                `SELECT 1 FROM pool_score_history WHERE pool_id = ? AND recorded_at = ?`
            ).get(h.p, hRecordedAt);
            if (existing) continue;

            insertPoolScoreHistory(db, {
                poolId:        h.p,
                recordedAt:    hRecordedAt,
                tier:          h.tier ?? null,
                shortTermTier: h.st ?? null,
                rankPos:       h.rp ?? null,
                rankOf:        h.ro ?? null,
                netEconPct:    h.ne ?? null,
            });
            scoreHistoryRows++;
        }

        // recordedAt ist Date.parse(data.generatedAt) — derselbe Moment, aus dem der
        // Master seine hourId bildet. Ist generatedAt unlesbar, bleibt die Deckung
        // unverändert (null → MAX() greift nicht), statt eine falsche zu behaupten.
        setLastSequence(db, data.sequence,
            Number.isFinite(recordedAt) ? Math.floor(recordedAt / 3_600_000) : null);
    });
    txn();

    touchScoresJsonFreshness(scoresJsonPath);

    // Klasse A (scores) ist additiv/optional — nicht jeder Blob enthält sie (siehe
    // core/premium/publish-blob.js: best-effort, fällt bei veralteter data.json weg).
    // Schreibt exakt an die Stelle, die lib/invest-score-provider.js bereits als
    // "delivered"-Quelle erwartet (DELIVERED_SCORES_PATH) — kein neues Schema, keine
    // neue Naht, nur der fehlende Absender.
    let scoresWritten = false;
    if (data.scores) {
        writeJsonAtomic(deliveredScoresPath, JSON.stringify(data.scores));
        scoresWritten = true;
    }

    // Klasse C (poolOffers) — DER INGEST LEGT NUR AB. Kein Schreibzugriff auf pools.json
    // oder die pools-Tabelle, keine Übernahme, keine Kapitalfreigabe. Das ist die einzige
    // Datenklasse, die laut pool-offers.md echtes Kapital bewegen kann; alles, was daraus
    // Wirkung ableitet, sitzt bewusst hinter eigenen Gates in eigenen Modulen:
    // Validator (On-Chain-Abgleich), Übernahme-UI, Dry-Run-Gate, Offer-Update-Sync
    // (bin/pool-offers-sync.js) und Retirement-Exit (lib/pool-retirement.js).
    let poolOffersWritten = false;
    if (data.poolOffers) {
        // Normalisierte Form { meta, offers } (siehe premium-offers-store.js). `meta`
        // trägt das `complete`-Flag des Masters — ohne das darf die Retirement-Erkennung
        // ein fehlendes Offer NICHT als Rückstufung werten.
        writePoolOffers(poolOffersPath, data.poolOffers, data.poolOffersMeta ?? null);
        poolOffersWritten = true;
    }

    return { ingested: true, rows, scoreHistoryRows, coveredPools: data.coveredPools ?? [], scoresWritten, poolOffersWritten };
}

/**
 * Kompletter Fetch+Ingest-Zyklus: Blob per HTTPS herunterladen, mit K_H entschlüsseln,
 * validieren, integrieren. K_H + URL kommen im echten Betrieb aus der Gift-Wrap-DM des
 * Masters (Zahlungs-Watcher, noch nicht gebaut) — bis dahin als Parameter für manuelle
 * Tests, siehe bin/premium-fetch.js.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} url
 * @param {string} keyHex - K_H, 64-stelliger Hex-String (32 Byte).
 * @param {object} [opts] - durchgereicht an ingestBlob().
 */
export async function fetchAndIngest(db, url, keyHex, opts) {
    const key = Buffer.from(keyHex, 'hex');
    const buffer = await downloadBlob(url);
    const data = decryptBlob(buffer, key);
    return ingestBlob(db, data, opts);
}

/**
 * Selbsttest gegen eine temporäre, isolierte DB + Datei (NIE die echte Bot-DB) —
 * Sequenz-Gate, Zukunfts-/Altersgrenze, Idempotenz bei doppelter Integration, Zeilen
 * landen korrekt in pool_score_history.
 */
export async function selfTest() {
    const { openDatabase } = await import('./db.js');
    const { tmpdir } = await import('os');
    const { randomBytes } = await import('crypto');

    const dbPath = path.join(tmpdir(), `premium-ingest-selftest-${randomBytes(4).toString('hex')}.db`);
    const scoresJsonPath = path.join(tmpdir(), `premium-ingest-selftest-${randomBytes(4).toString('hex')}.json`);
    const deliveredScoresPath = path.join(tmpdir(), `premium-ingest-selftest-delivered-${randomBytes(4).toString('hex')}.json`);
    const poolOffersPath = path.join(tmpdir(), `premium-ingest-selftest-offers-${randomBytes(4).toString('hex')}.json`);
    const failures = [];

    const sampleBlob = (sequence, ageMs = 0, withScores = false, withScoreHistory = false, withPoolOffers = false) => ({
        schemaVersion: 1,
        generatedAt: new Date(Date.now() - ageMs).toISOString(),
        sequence,
        coveredPools: ['liq-sol-usdc'],
        marketTable: [{
            id: 'liq-sol-usdc', displayPair: 'SOL/USDC', address: 'Addr123',
            tvl_usd: 100000, vol24h_usd: 50000, feeTier_pct: 0.16,
            net_apr_pct: 20, gross_apr_pct: 30, confidence: 80,
            rank: 1, of: 5, tier: 'invest', short_term_tier: 'hold',
        }],
        ...(withScores ? {
            scores: {
                generatedAt: new Date(Date.now() - ageMs).toISOString(),
                timeframeIds: ['24h'],
                opportunityScores: { 'liq-sol-usdc': { '24h': { score: 0.04, sampleCount: 96, reason: 'ok' } } },
                investScores: { 'liq-sol-usdc': { value: 63, exitValue: 63, arrow: 'up', confidence: 'high',
                    dataDays: 14, hopiumVeto: false, volumeMalus: 0, poolType: 'volatil_2', metrics: [] } },
            },
        } : {}),
        ...(withScoreHistory ? {
            // Bewusst ein ANDERER Zeitstempel als generatedAt (eigene Taktung, siehe
            // premium-ingest.js Kommentar bei der scoreHistory-Verarbeitung).
            scoreHistory: [{ p: 'liq-sol-usdc', t: Date.now() - ageMs - 60_000, tier: 'withdraw', st: 'hold', rp: 2, ro: 5, ne: -3.5 }],
        } : {}),
        ...(withPoolOffers ? {
            poolOffers: [{ id: 'liq-new-usdc', address: 'AddrNew', poolShape: { kind: 'stable' },
                compat: { adaptiveFeeEnabled: false }, suggested: {}, rationale: {},
                lifecycle: { status: 'active', reason: null } }],
            poolOffersMeta: { generatedAt: new Date(Date.now() - ageMs).toISOString(), sequence, complete: true, count: 1 },
        } : {}),
    });

    let db;
    try {
        db = openDatabase(dbPath);

        const r1 = ingestBlob(db, sampleBlob(1), { scoresJsonPath, deliveredScoresPath, poolOffersPath });
        if (!r1.ingested || r1.rows !== 1) failures.push(`erster Ingest fehlgeschlagen: ${JSON.stringify(r1)}`);
        if (r1.scoresWritten) failures.push('scoresWritten war true, obwohl der Blob keine scores enthielt');
        if (fs.existsSync(deliveredScoresPath)) failures.push('scores.json wurde ohne scores-Feld im Blob angelegt');
        if (r1.poolOffersWritten) failures.push('poolOffersWritten war true, obwohl der Blob keine poolOffers enthielt');
        if (fs.existsSync(poolOffersPath)) failures.push('pool-offers.json wurde ohne poolOffers-Feld im Blob angelegt');

        const rowCount1 = db.prepare(`SELECT COUNT(*) AS n FROM pool_score_history`).get().n;
        if (rowCount1 !== 1) failures.push(`erwartete 1 Zeile in pool_score_history, gefunden ${rowCount1}`);

        // Alte/gleiche Sequenz erneut → muss abgelehnt werden, keine Doppel-Zeile.
        const r2 = ingestBlob(db, sampleBlob(1), { scoresJsonPath, deliveredScoresPath });
        if (r2.ingested) failures.push('gleiche Sequenz wurde fälschlich erneut integriert');

        // Neuere Sequenz, aber Blob zu alt → muss abgelehnt werden.
        const r3 = ingestBlob(db, sampleBlob(2, MAX_BLOB_AGE_MS + 60_000), { scoresJsonPath, deliveredScoresPath });
        if (r3.ingested) failures.push('zu alter Blob wurde fälschlich integriert');

        // Neuere Sequenz, frisch, MIT scores + scoreHistory + poolOffers → muss durchgehen,
        // scores.json schreiben, eine zusätzliche pool_score_history-Zeile anlegen UND
        // pool-offers.json als reine Ablage schreiben (keine DB-/pools.json-Wirkung).
        const r4 = ingestBlob(db, sampleBlob(2, 0, true, true, true), { scoresJsonPath, deliveredScoresPath, poolOffersPath });
        if (!r4.ingested) failures.push(`gültiger Folge-Ingest wurde abgelehnt: ${r4.reason}`);
        if (!r4.scoresWritten) failures.push('scoresWritten war false, obwohl der Blob scores enthielt');
        if (r4.scoreHistoryRows !== 1) failures.push(`erwartete 1 scoreHistoryRows, bekam ${r4.scoreHistoryRows}`);
        if (!r4.poolOffersWritten) failures.push('poolOffersWritten war false, obwohl der Blob poolOffers enthielt');
        if (!fs.existsSync(poolOffersPath)) {
            failures.push('pool-offers.json wurde trotz poolOffers-Feld im Blob nicht geschrieben');
        } else {
            const written = loadPoolOffers(poolOffersPath);
            if (written.offers[0]?.id !== 'liq-new-usdc') failures.push('pool-offers.json-Inhalt weicht vom gelieferten Blob ab');
            if (written.meta?.complete !== true) failures.push('poolOffersMeta.complete wurde nicht mitgeschrieben');
            if (written.offers[0]?.lifecycle?.status !== 'active') failures.push('lifecycle des Offers ging beim Ablegen verloren');
        }
        // Kritischste Prüfung: poolOffers darf NIE pools.json anfassen oder Zeilen in die
        // pools-Tabelle schreiben — reine Datei-Ablage, keine Betriebswirkung.
        const poolsTableCount = db.prepare(`SELECT COUNT(*) AS n FROM pools WHERE id = 'liq-new-usdc'`).get().n;
        if (poolsTableCount !== 0) failures.push('poolOffers-Ingest hat fälschlich eine Zeile in die pools-Tabelle geschrieben');

        const rowCount2 = db.prepare(`SELECT COUNT(*) AS n FROM pool_score_history`).get().n;
        if (rowCount2 !== 3) failures.push(`erwartete 3 Zeilen nach marketTable+scoreHistory-Ingest, gefunden ${rowCount2}`);

        const withdrawRow = db.prepare(
            `SELECT tier, net_econ_pct FROM pool_score_history WHERE pool_id = ? AND tier = 'withdraw'`
        ).get('liq-sol-usdc');
        if (!withdrawRow || withdrawRow.net_econ_pct !== -3.5) {
            failures.push('scoreHistory-Zeile (tier=withdraw, net_econ_pct=-3.5) nicht wie erwartet in der DB');
        }

        if (!fs.existsSync(scoresJsonPath)) failures.push('pool-scores.json-Platzhalter wurde nicht angelegt');

        if (!fs.existsSync(deliveredScoresPath)) {
            failures.push('scores.json wurde trotz scores-Feld im Blob nicht geschrieben');
        } else {
            const written = JSON.parse(fs.readFileSync(deliveredScoresPath, 'utf8'));
            if (written.investScores?.['liq-sol-usdc']?.value !== 63) {
                failures.push('scores.json-Inhalt weicht vom gelieferten Blob ab');
            }
        }
    } catch (err) {
        failures.push(`Ausnahme: ${err.message}`);
    } finally {
        db?.close();
        fs.rmSync(dbPath, { force: true });
        fs.rmSync(scoresJsonPath, { force: true });
        fs.rmSync(deliveredScoresPath, { force: true });
        fs.rmSync(poolOffersPath, { force: true });
        for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    }

    return { ok: failures.length === 0, failures };
}
