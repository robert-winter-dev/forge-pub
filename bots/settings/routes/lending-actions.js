/**
 * /api/lending – Manuelle Aktionen für den LendingBot
 *
 * GET  /api/lending/config
 *     → Protokoll-Liste (name, label, active, enabled, tvlGuard, liqGuard) + auto-deploy-Status
 *
 * PUT  /api/lending/pool-enabled/:protocolId
 *     Body: { enabled: bool }
 *     → Pool-Freigabe setzen. Beim Aktivieren: liegt der aktuelle TVL bzw. die
 *       aktuelle Liquidität unter der jeweiligen Schutz-Schwelle, wird diese auf
 *       50 % des aktuellen Werts gesenkt.
 *
 * PUT  /api/lending/tvl-guard/:protocolId
 *     Body: { enabled, thresholdUsd, sendTo }
 *     → TVL-Schutz-Settings pro Protokoll speichern
 *
 * PUT  /api/lending/liq-guard/:protocolId
 *     Body: { enabled, thresholdUsd, sendTo }
 *     → Liquiditäts-Schutz-Settings pro Protokoll speichern
 *
 * POST /api/lending/deposit
 *     Body: { protocol, amount }
 *     → führt bin/deposit.js --json --yes aus
 *
 * POST /api/lending/withdraw
 *     Body: { protocol, amount }  (amount: Zahl oder "all")
 *     → führt bin/withdraw.js --json --yes aus
 *
 * POST /api/lending/rebalance/trigger
 *     → legt data/force-rebalance.flag an
 *
 * GET  /api/lending/auto-deploy
 *     → { paused: bool }
 *
 * POST /api/lending/auto-deploy
 *     Body: { paused: bool }
 *     → legt data/auto-deploy-paused.flag an oder löscht ihn
 */

import { Router }        from 'express';
import fs                from 'fs';
import path              from 'path';
import { fileURLToPath } from 'url';
import { spawn }         from 'node:child_process';
import Database          from 'better-sqlite3';
import { PATHS, envFile } from '../../../config/paths.js';
import { t } from '../../../lib/i18n.js';
import { listPools, isKnown as isKnownPool, isDepositClosed, isVisible } from '../../../lib/lending-pools.js';
import { registerKind, startJob, waitForJob, jobResponse } from '../lib/finance-jobs.js';

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT     = PATHS.root;
const LB_ROOT        = PATHS.lending;
const MOVE_LOCK      = path.join(PATHS.lendingData, 'move.lock');
const AUTO_DEPLOY_PAUSE = path.join(PATHS.lendingData, 'auto-deploy-paused.flag');
// envFile() statt hardcodiertem LB_ROOT/.env – im Fork liegt die .env unter
// local/env/lending.env (siehe config/paths.js).
const LB_CONFIG_PATH = envFile('lending');
const LB_DATA_JSON   = path.join(PATHS.html, 'lending', 'data', 'data.json');
const SETTINGS_DB    = PATHS.settingsDb;

const router = Router();

// ── TVL- / Liquiditäts-Schutz pro Protokoll (settings.db, bot_id='lending') ───
// Default je Protokoll und Schutz: aktiv, Schwelle 100K, kein Versand.
// Beide Blöcke sind strukturgleich und werden über dieselben Helfer gelesen und
// geschrieben – Unterschied ist allein die Kennzahl (Markt-TVL vs. sofort
// abhebbare Liquidität). Fachliche Herleitung: bots/lending/lib/tvl-guard.js.
const DEFAULT_TVL_GUARD = { enabled: true, thresholdUsd: 100_000, sendTo: '' };
const DEFAULT_LIQ_GUARD = { enabled: true, thresholdUsd: 100_000, sendTo: '' };

const GUARD_FIELDS = {
    tvlGuard: DEFAULT_TVL_GUARD,
    liqGuard: DEFAULT_LIQ_GUARD,
};

function openSettingsDb() {
    const db = new Database(SETTINGS_DB);
    db.exec(`
        CREATE TABLE IF NOT EXISTS pool_settings (
            bot_id   TEXT NOT NULL,
            pool_id  TEXT NOT NULL,
            settings TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (bot_id, pool_id)
        )
    `);
    return db;
}

/** Liest einen Schutz-Block (tvlGuard/liqGuard) eines Protokolls (mit Default-Merge). */
function loadGuard(db, protocolId, field) {
    const defaults = GUARD_FIELDS[field];
    const row = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
    ).get(protocolId);
    if (!row) return { ...defaults };
    try {
        const g = JSON.parse(row.settings)?.[field];
        return { ...defaults, ...(g ?? {}) };
    } catch {
        return { ...defaults };
    }
}

/** Schreibt einen Schutz-Block (tvlGuard/liqGuard) eines Protokolls (validiert). */
function saveGuard(db, protocolId, field, partial) {
    const defaults = GUARD_FIELDS[field];
    const row     = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
    ).get(protocolId);
    let current = {};
    if (row) { try { current = JSON.parse(row.settings); } catch { current = {}; } }

    const merged = { ...defaults, ...(current[field] ?? {}), ...partial };
    const threshold = Number(merged.thresholdUsd);
    if (merged.enabled && !(threshold > 0)) {
        throw new Error(t('api.lending.tvl_threshold_positive'));
    }
    current[field] = {
        enabled:      !!merged.enabled,
        thresholdUsd: threshold > 0 ? threshold : defaults.thresholdUsd,
        sendTo:       typeof merged.sendTo === 'string' ? merged.sendTo : '',
    };

    db.prepare(`
        INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('lending', ?, ?)
        ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
    `).run(protocolId, JSON.stringify(current));
    return current[field];
}

const loadTvlGuard = (db, id) => loadGuard(db, id, 'tvlGuard');
const saveTvlGuard = (db, id, partial) => saveGuard(db, id, 'tvlGuard', partial);

// ── Pool-Freigabe pro Protokoll (settings.db, gleiche Zeile wie tvlGuard) ─────
// Eigenes Feld `poolEnabled` (NICHT tvlGuard.enabled!): tvlGuard.enabled schaltet
// den TVL-Schutz-Mechanismus selbst an/aus, poolEnabled ist die Nutzer-Freigabe,
// ob überhaupt investiert werden darf. Default true (kein Eintrag = aktiviert).

/** Liest die Pool-Freigabe eines Protokolls. */
function loadPoolEnabled(db, protocolId) {
    const row = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
    ).get(protocolId);
    if (!row) return true;
    try { return JSON.parse(row.settings)?.poolEnabled !== false; }
    catch { return true; }
}

/** Setzt die Pool-Freigabe eines Protokolls. */
function savePoolEnabled(db, protocolId, enabled) {
    const row = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
    ).get(protocolId);
    let current = {};
    if (row) { try { current = JSON.parse(row.settings); } catch { current = {}; } }
    current.poolEnabled = !!enabled;
    db.prepare(`
        INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('lending', ?, ?)
        ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
    `).run(protocolId, JSON.stringify(current));
}

/**
 * True wenn das Protokoll laut lendingbot.db eine offene Position mit
 * Kapital hält. Analog zur bereits bestehenden Sperre beim Liquidity Bot
 * (bots/settings/routes/pools-actions.js hasOpenPosition()) — dort verhindert
 * dieselbe Prüfung, dass ein Pool mit offener Position deaktiviert wird.
 * Beim Lending Bot fehlte dieses Gegenstück bisher (Fund 2026-08-07): die
 * Route deaktivierte bis jetzt "einfaches Setzen, keine weitere Logik", auch
 * mit `amount > 0`.
 */
function hasProtocolCapital(protocolId) {
    try {
        const db = new Database(PATHS.lendingDb, { readonly: true, fileMustExist: true });
        const row = db.prepare(
            `SELECT 1 FROM positions WHERE protocol = ? AND closed_at IS NULL AND amount > 0 LIMIT 1`
        ).get(protocolId);
        db.close();
        return !!row;
    } catch {
        return false;
    }
}

/**
 * Startet export.js + sync.sh im Hintergrund – Antwort an Client ist bereits raus.
 *
 * Existenz-Checks + error-Handler bewusst: in einem reduzierten Deployment ohne
 * Lending Bot (z.B. FORGE-public-Fork, aktuell noch scope-bedingt möglich, siehe
 * config/pub-allowlist.json Backlog) existiert LB_ROOT nicht – spawn() liefert
 * dafür ENOENT als ASYNCHRONES 'error'-Event, kein Handler dafür crasht den
 * kompletten forge-settings-Prozess (siehe identischer Fund + Fix in wallet.js,
 * 2026-07-26).
 */
function triggerExportAndSync() {
    const exportPath = path.join(LB_ROOT, 'bin', 'export.js');
    const syncPath    = path.join(FORGE_ROOT, 'bin', 'sync.sh');
    const runSync = () => {
        if (!fs.existsSync(syncPath)) return;
        const syncProc = spawn('bash', [syncPath], { cwd: FORGE_ROOT, detached: true, stdio: 'ignore' });
        syncProc.on('error', err => console.error(`[triggerExportAndSync] sync.sh: ${err.message}`));
        syncProc.unref();
    };
    if (!fs.existsSync(exportPath)) { runSync(); return; }
    const exportProc = spawn('node', [exportPath], { cwd: LB_ROOT, stdio: 'ignore' });
    exportProc.on('error', err => console.error(`[triggerExportAndSync] lending export.js: ${err.message}`));
    exportProc.on('close', runSync);
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function readEnv() {
    try {
        return Object.fromEntries(
            fs.readFileSync(LB_CONFIG_PATH, 'utf8')
                .split('\n')
                .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
                .map(l => { const idx = l.indexOf('='); return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()]; })
        );
    } catch { return {}; }
}

// Pool-Stammdaten (ID, Name, Zustand, Sichtbarkeit) kommen aus dem Pool-Register
// (lib/lending-pools.js, LEN#001365) – dieselbe Quelle wie Bot und Dashboard.

// ── Routen ────────────────────────────────────────────────────────────────────

/** Gibt Protokoll-Liste + aktuellen Auto-Deploy-Status zurück. */
router.get('/config', (req, res) => {
    const env        = readEnv();
    const autoDeploy = !fs.existsSync(AUTO_DEPLOY_PAUSE);
    const moveLocked = fs.existsSync(MOVE_LOCK);

    let protocolStats = {};
    let positions     = [];
    try {
        const data    = JSON.parse(fs.readFileSync(LB_DATA_JSON, 'utf8'));
        protocolStats = data.protocolStats ?? {};
        positions     = data.positions     ?? [];
    } catch { /* data.json nicht verfügbar */ }

    // Aktiv = offene Position mit amount > 0
    const activeAmounts = new Map();
    for (const pos of positions) {
        if ((pos.amount ?? 0) > 0) {
            activeAmounts.set(pos.protocol, (activeAmounts.get(pos.protocol) ?? 0) + pos.amount);
        }
    }

    // TVL bei Aktivierung pro Protokoll (poolTvl der offenen Position, falls vorhanden)
    const activationTvl = new Map();
    for (const pos of positions) {
        if ((pos.amount ?? 0) > 0 && pos.poolTvl > 0 && !activationTvl.has(pos.protocol)) {
            activationTvl.set(pos.protocol, pos.poolTvl);
        }
    }

    const sdb = openSettingsDb();
    // Sichtbarkeit laut Register. Guthaben zählt doppelt abgesichert: data.json ODER
    // direkt die Bot-DB. Fehlt data.json, darf ein ausgelaufener Pool mit Guthaben nicht
    // aus der Liste fallen, sonst wäre der Auszahlungsweg weg.
    const visiblePools = listPools().filter(p => isVisible(p.id, 'settings', {
        hasPosition: (activeAmounts.get(p.id) ?? 0) > 0 || hasProtocolCapital(p.id),
    }));
    const protocols = visiblePools.map(({ id, label }) => {
        const stats     = protocolStats[id] ?? {};
        const apy       = stats.apy  ?? null;
        const tvl       = stats.tvl  ?? 0;
        const liquidity = stats.liquidity ?? null;
        const amount    = activeAmounts.get(id) ?? 0;
        const active    = amount > 0;
        // Gesperrt für Einzahlungen (Zustand im Pool-Register): hier nur Anzeige, `enabled` false hält
        // Einzahlen-Schaltfläche und Dropdown-Markierung konsistent. Die Pool-Freigabe in
        // settings.db bleibt unberührt, ein Bot-Tick zählt die Position weiter mit.
        const retired   = isDepositClosed(id);
        const enabled   = loadPoolEnabled(sdb, id) && !retired;

        // Nutzbar = Pool freigegeben (Einzahlen manuell immer möglich) ODER aktive
        // Position vorhanden. Nur die Pool-Freigabe selbst sperrt hier noch —
        // APY-Schwelle/Datenbasis sind seit 2026-08-21 reine Auto-Deploy-Kriterien
        // (siehe lib/rebalancer.js), manuelles Investieren bleibt uneingeschränkt.
        const disabledReason = (!enabled && !active)
            ? (retired ? t('api.lending.reason_pool_retired') : t('api.lending.reason_pool_disabled'))
            : null;
        const retiredNote = retired ? t('api.lending.pool_retired', { protocol: label }) : null;

        return {
            id, label, active, enabled, apy, amount, disabledReason, retired, retiredNote,
            currentTvl:      tvl || null,
            currentLiquidity: liquidity,
            tvlGuard:        loadTvlGuard(sdb, id),
            liqGuard:        loadGuard(sdb, id, 'liqGuard'),
            tvlAtActivation: activationTvl.get(id) ?? null,
        };
    });
    sdb.close();

    res.json({ protocols, autoDeploy, moveLocked });
});

// ── PUT /api/lending/tvl-guard/:protocolId – TVL-Schutz pro Protokoll speichern ──
router.put('/tvl-guard/:protocolId', (req, res) => {
    const { protocolId } = req.params;
    if (!isKnownPool(protocolId)) {
        return res.status(404).json({ ok: false, error: t('api.lending.unknown_protocol') });
    }
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ ok: false, error: t('api.common.body_object') });
    }
    try {
        const db    = openSettingsDb();
        const saved = saveTvlGuard(db, protocolId, body);
        db.close();
        res.json({ ok: true, tvlGuard: saved });
    } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
    }
});

// ── PUT /api/lending/liq-guard/:protocolId – Liquiditäts-Schutz speichern ────
router.put('/liq-guard/:protocolId', (req, res) => {
    const { protocolId } = req.params;
    if (!isKnownPool(protocolId)) {
        return res.status(404).json({ ok: false, error: t('api.lending.unknown_protocol') });
    }
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ ok: false, error: t('api.common.body_object') });
    }
    try {
        const db    = openSettingsDb();
        const saved = saveGuard(db, protocolId, 'liqGuard', body);
        db.close();
        res.json({ ok: true, liqGuard: saved });
    } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
    }
});

// ── PUT /api/lending/pool-enabled/:protocolId – Pool aktivieren/deaktivieren ──
//
// Deaktivieren: blockiert, solange das Protokoll noch Kapital hält (s.u.
// hasProtocolCapital) — davor "einfaches Setzen, keine weitere Logik".
// Aktivieren (Reaktivierung): liegt der aktuelle TVL unter der konfigurierten
// TVL-Schutz-Schwelle, wird die Schwelle auf 50 % des aktuellen TVL gesenkt –
// sonst würde der Pool durch den TVL-Schutz beim nächsten Bot-Tick sofort
// wieder deaktiviert werden.
router.put('/pool-enabled/:protocolId', (req, res) => {
    const { protocolId } = req.params;
    if (!isKnownPool(protocolId)) {
        return res.status(404).json({ ok: false, error: t('api.lending.unknown_protocol') });
    }
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: t('api.common.missing_field', { field: 'enabled (bool)' }) });
    }
    if (enabled === true && isDepositClosed(protocolId)) {
        return res.status(409).json({ ok: false, error: t('api.lending.pool_retired', { protocol: protocolId }) });
    }
    if (enabled === false && hasProtocolCapital(protocolId)) {
        return res.status(409).json({
            ok: false,
            error: t('api.lending.protocol_has_capital'),
        });
    }

    const db = openSettingsDb();
    try {
        let adjustedTvlGuard = null;
        let adjustedLiqGuard = null;

        if (enabled) {
            let currentTvl = null;
            let currentLiq = null;
            try {
                const data = JSON.parse(fs.readFileSync(LB_DATA_JSON, 'utf8'));
                currentTvl = data.protocolStats?.[protocolId]?.tvl ?? null;
                currentLiq = data.protocolStats?.[protocolId]?.liquidity ?? null;
            } catch { /* data.json nicht verfügbar */ }

            // Gleiche Schwellenkorrektur für den Liquiditäts-Schutz: sonst würde
            // eine Einzahlung nach der Reaktivierung beim nächsten Tick sofort
            // wieder abgezogen. currentLiq === null heißt "nicht gemessen" und
            // löst bewusst keine Korrektur aus.
            const liqGuard = loadGuard(db, protocolId, 'liqGuard');
            if (currentLiq != null && currentLiq > 0 && liqGuard.enabled && currentLiq < liqGuard.thresholdUsd) {
                adjustedLiqGuard = saveGuard(db, protocolId, 'liqGuard', {
                    ...liqGuard,
                    thresholdUsd: Math.max(1, Math.floor(currentLiq * 0.5)),
                });
            }

            const guard = loadTvlGuard(db, protocolId);
            if (currentTvl != null && currentTvl > 0 && guard.enabled && currentTvl < guard.thresholdUsd) {
                // Mindestens 1 USDC (Fund 2026-08-07): bei sehr niedrigem TVL (< 2 USDC)
                // rundet Math.floor(currentTvl * 0.5) auf 0 ab — saveTvlGuard() lehnt
                // eine aktivierte Schwelle von 0 als ungültig ab, die Reaktivierung
                // schlug dadurch komplett fehl, obwohl der Guard-Zweck (Schwelle unter
                // dem aktuellen TVL halten) mit 1 USDC genauso erfüllt ist.
                adjustedTvlGuard = saveTvlGuard(db, protocolId, {
                    ...guard,
                    thresholdUsd: Math.max(1, Math.floor(currentTvl * 0.5)),
                });
            }
        }

        savePoolEnabled(db, protocolId, enabled);
        db.close();
        res.json({ ok: true, enabled, tvlGuard: adjustedTvlGuard, liqGuard: adjustedLiqGuard });
    } catch (err) {
        db.close();
        res.status(400).json({ ok: false, error: err.message });
    }
});

// ── Deposit/Withdraw als losgelöster Job (CORE#000993) ──────────────────────
// Überlebt einen Neustart von forge-settings, kein Timeout beendet den Prozess
// (lib/finance-jobs.js). move.lock bleibt bis zum tatsächlichen Prozessende stehen und
// wird in der Nacharbeit gelöst — auch wenn die erst nach einem Neustart läuft.
const LENDING_JOB_WAIT_MS = 120_000;

for (const action of ['deposit', 'withdraw']) {
    registerKind(`lend-${action}`, {
        onDone(result) {
            try { fs.unlinkSync(MOVE_LOCK); } catch { /* bereits gelöscht */ }
            if (result.ok) triggerExportAndSync();
            console.log(`[lending-actions] ${action} ${result.ok ? 'ausgeführt' : 'fehlgeschlagen'}${result.ok ? '' : ` – ${result.error ?? 'ohne Fehlertext'}`}`);
            return result;
        },
    });
}

async function runLendingJob(res, action, protocol, amount, clientRef) {
    const { job, conflict } = startJob({
        kind:   `lend-${action}`,
        ref:    clientRef,
        key:    'lending',     // ein Wallet, ein move.lock → nie zwei Lending-Aktionen parallel
        script: path.join(LB_ROOT, 'bin', `${action}.js`),
        args:   ['--protocol', protocol, '--amount', String(amount), '--yes', '--json'],
        cwd:    LB_ROOT,
        meta:   { protocol, amount },
    });
    if (conflict) {
        return res.status(409).json({ ok: false, error: t('api.jobs.already_running'), busy: true, jobId: conflict.id });
    }
    // move.lock setzen → Bot deployed während der TX nicht automatisch. PID des Jobs,
    // nicht von server.js: der Job überlebt einen Neustart, server.js nicht.
    const lockInfo = JSON.stringify({ pid: job.pid, startedAt: Date.now(), reason: `manual-${action}`, jobId: job.id });
    try { fs.writeFileSync(MOVE_LOCK, lockInfo, 'utf8'); } catch { /* ignorieren */ }

    const current = await waitForJob(job.id, LENDING_JOB_WAIT_MS);
    const { status, body } = jobResponse(current, t('api.jobs.still_running'));
    res.status(status).json(body);
}

/** Manuelles Deposit in ein Protokoll. */
router.post('/deposit', async (req, res) => {
    const { protocol, amount } = req.body ?? {};
    if (!protocol) return res.status(400).json({ ok: false, error: t('api.common.missing_field', { field: 'protocol' }) });
    if (amount == null) return res.status(400).json({ ok: false, error: t('api.common.missing_field', { field: 'amount' }) });

    // Für Einzahlungen gesperrte Pools (Pool-Register) sind unabhängig von der Pool-Freigabe zu.
    if (isDepositClosed(protocol)) {
        return res.status(409).json({ ok: false, error: t('api.lending.pool_retired', { protocol }) });
    }

    // Deaktivierte Pools sind für JEDEN Deposit-Weg gesperrt, nicht nur Auto-Deploy.
    {
        const sdb = openSettingsDb();
        const enabled = loadPoolEnabled(sdb, protocol);
        sdb.close();
        if (!enabled) {
            return res.status(409).json({ ok: false, error: t('api.lending.pool_disabled', { protocol }) });
        }
    }

    return runLendingJob(res, 'deposit', protocol, amount, req.body?.clientRef);
});

/** Manueller Withdraw aus einem Protokoll. */
router.post('/withdraw', async (req, res) => {
    const { protocol, amount } = req.body ?? {};
    if (!protocol) return res.status(400).json({ ok: false, error: t('api.common.missing_field', { field: 'protocol' }) });
    if (amount == null) return res.status(400).json({ ok: false, error: t('api.common.missing_field', { field: 'amount' }) });

    return runLendingJob(res, 'withdraw', protocol, amount, req.body?.clientRef);
});


/** Aktuelle Positionen (Protokoll + eingesetzter Betrag) aus dem Dashboard-JSON. */
router.get('/positions', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(LB_DATA_JSON, 'utf8'));
        res.json({ positions: data.positions ?? [] });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

/** Liest den aktuellen Auto-Deploy-Status. */
router.get('/auto-deploy', (req, res) => {
    res.json({ paused: fs.existsSync(AUTO_DEPLOY_PAUSE) });
});

/** Setzt oder löscht den Auto-Deploy-Pause-Flag. */
router.post('/auto-deploy', (req, res) => {
    const { paused } = req.body ?? {};
    if (typeof paused !== 'boolean') return res.status(400).json({ ok: false, error: t('api.common.missing_field', { field: 'paused (bool)' }) });

    try {
        if (paused) {
            fs.writeFileSync(AUTO_DEPLOY_PAUSE, '', 'utf8');
        } else {
            if (fs.existsSync(AUTO_DEPLOY_PAUSE)) fs.unlinkSync(AUTO_DEPLOY_PAUSE);
        }
        res.json({ ok: true, paused });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;
