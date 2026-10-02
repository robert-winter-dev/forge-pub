/**
 * /api/pools – Manuelle Pool-Aktionen (Deposit/Withdraw) für Liquidity
 *
 * GET  /api/pools/liquidity/:poolId/position-state
 *     → aktueller Pool-/Position-Mix (für UI-Anzeige + Modus-B-Validation)
 *
 * POST /api/pools/liquidity/:poolId/preview
 *     Body: { action: 'deposit'|'withdraw', mode: 'usdc'|'token',
 *             usdc?, tokenSymbol?, amount?, isNew? }
 *     → führt CLI-Scripts mit --dry-run + --json aus und gibt Ergebnis zurück;
 *       läuft parallel estimate-costs.js für Kostenschätzung.
 *
 * POST /api/pools/liquidity/:poolId/deposit
 *     Body: { mode, usdc?, tokenSymbol?, amount?, isNew? }
 *     → führt bin/deposit.js produktiv aus. Trailing Stop/TVL-Schutz eines Neuzugangs sind
 *       hierüber nicht abschaltbar (Rückbau LIQ#0362, 03.09.2026: das Deposit-Modal zeigte
 *       dafür Checkboxen, die denselben Wert wie Risk-Management ohne dessen übrige Werte
 *       änderten — zweiter Bedienort für dieselbe Einstellung). Das Opt-out existiert weiter
 *       ausschließlich über bin/deposit.js --no-trailing-stop-default/--no-tvl-protection-default.
 *
 * POST /api/pools/liquidity/:poolId/withdraw
 *     Body: { mode, usdc?, tokenSymbol?, amount?, swapToUsdc?, sendTo? }
 *     → führt bin/withdraw.js produktiv aus
 *       swapToUsdc: entnommene Coins vor Verbleib/Versand in USDC tauschen
 *       sendTo:     Empfänger-Adresse (leer = im Wallet belassen)
 *
 * Sicherheit: dieser Router lebt auf dem internen HTTPS Settings-Server (LAN only).
 */

import { Router }        from 'express';
import fs                from 'fs';
import path              from 'path';
import { fileURLToPath } from 'url';
import { spawn }         from 'node:child_process';
import Database          from 'better-sqlite3';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PATHS }         from '../../../config/paths.js';
import { readEnvField, loadKeypair, LIQUIDITYBOT_ENV, NEXUS_RPC_FRESH, RPC_CONN_OPTS } from './wallet.js';
import { t } from '../../../lib/i18n.js';
import { renderReason, reasonPayload } from '../../../lib/pool-reason.js';
import { registerKind, startJob, waitForJob, jobResponse } from '../lib/finance-jobs.js';

const __dirname        = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT       = PATHS.root;
const LIQUIDITYBOT_ROOT        = PATHS.liquidity;
const POOLS_JSON       = path.join(LIQUIDITYBOT_ROOT, 'config', 'pools.json');
const LIQUIDITYBOT_DB          = PATHS.liquidityDb;
const LIQUIDITYBOT_DATA         = path.join(FORGE_ROOT, 'html', 'liquidity', 'data', 'data.json');
const LIQUIDITYBOT_DATA_HISTORY = path.join(FORGE_ROOT, 'html', 'liquidity', 'data', 'data-history.json');
// Empfehlung gilt maximal 48 h als aktuell
const HINT_STALE_MS = 48 * 60 * 60 * 1000;

const router = Router();

// ── Hilfen ────────────────────────────────────────────────────────────────────

/**
 * Lädt pools.json und sucht den Pool mit der gegebenen ID. Überlagert active/enabled/
 * rangeOverride.fixedPct mit der liquiditybot.db (Single Source of Truth seit Liquidity Bot v0.4.85,
 * siehe bots/liquidity/lib/db.js applyPoolDynamics()) — sonst zeigt/prüft dieser
 * Router veraltete pools.json-Seed-Werte (z.B. active:false trotz offener Position).
 */
function findPool(poolId) {
    const list = JSON.parse(fs.readFileSync(POOLS_JSON, 'utf8'));
    const pool = list.find(p => p.id === poolId) ?? null;
    if (!pool) return null;
    try {
        const db  = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const row = db.prepare(
            `SELECT active, enabled, range_override_fixed_pct, enabled_changed_at, enabled_reason FROM pools WHERE id = ?`
        ).get(poolId);
        db.close();
        if (row) {
            pool.active = row.active === 1;
            if (row.enabled !== null && row.enabled !== undefined) {
                pool.enabled = row.enabled === 1;
            }
            pool.enabledChangedAt = row.enabled_changed_at ?? null;
            pool.enabledReason    = renderReason(row.enabled_reason);
            if (row.range_override_fixed_pct !== null && row.range_override_fixed_pct !== undefined
                && pool.rangeOverride && typeof pool.rangeOverride === 'object') {
                pool.rangeOverride.fixedPct = row.range_override_fixed_pct;
            }
        }
    } catch { /* DB/Spalten (noch) nicht bereit → pools.json-Seed-Werte behalten */ }
    return pool;
}

/**
 * Liest die neueste actionable Advisor-Empfehlung für einen Pool aus liquiditybot.db.
 * Gibt null zurück wenn keine frische Empfehlung vorhanden oder currentPct == recommendedPct.
 */
function readAdvisorHint(pool) {
    try {
        const db   = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const cutoff = Date.now() - HINT_STALE_MS;
        const row  = db.prepare(
            `SELECT recommended_range_pct, confidence, payback_hours, created_at
               FROM advisor_decisions
              WHERE pool_id = ? AND triggered_by IN ('range_hint','daily_scan')
                AND created_at >= ?
              ORDER BY created_at DESC LIMIT 1`
        ).get(pool.id, cutoff);
        db.close();
        if (!row) return null;
        const currentPct = pool.rangeOverride?.fixedPct ?? null;
        if (currentPct == null) return null; // kein fixedPct → kein UI-Rebalance
        if (currentPct === row.recommended_range_pct) return null; // bereits auf Empfehlung
        return {
            poolId:         pool.id,
            currentPct,
            recommendedPct: row.recommended_range_pct,
            confidence:     row.confidence,
            paybackHours:   row.payback_hours ?? null,
            createdAt:      row.created_at,
        };
    } catch { return null; }
}

/** Öffnet liquiditybot.db schreibend mit busy_timeout (analog bots/liquidity/lib/config.js openBotDbRW). */
function openLiquidityDbRW() {
    const db = new Database(LIQUIDITYBOT_DB);
    db.pragma('busy_timeout = 5000');
    return db;
}

/**
 * Setzt `range_override_fixed_pct` in der liquiditybot.db (Single Source of Truth seit v0.4.85,
 * identisch zu updatePoolRangeOverride() in bots/liquidity/lib/config.js). pools.json bleibt
 * unangetastet — ein Schreiben dorthin würde beim nächsten Bot-Zyklus ohnehin vom
 * DB-Wert überschrieben und hätte keine Wirkung.
 */
function writeFixedPct(poolId, newPct) {
    const db = openLiquidityDbRW();
    try {
        const row = db.prepare(`SELECT id FROM pools WHERE id = ?`).get(poolId);
        if (!row) throw new Error(t('api.poolact.pool_row_missing', { pool: poolId }));
        db.prepare(`UPDATE pools SET range_override_fixed_pct = ? WHERE id = ?`).run(newPct, poolId);
    } finally {
        db.close();
    }
}

/**
 * Setzt das Benutzer-Freigabe-Flag `enabled` in der liquiditybot.db (Single Source of Truth
 * seit v0.4.85, identisch zu setPoolEnabled() in bots/liquidity/lib/config.js). pools.json bleibt
 * unangetastet — ein Schreiben dorthin würde beim nächsten Bot-Zyklus ohnehin vom
 * DB-Wert überschrieben und hätte keine Wirkung.
 *
 * `reason` ist kein Klartext, sondern ein Payload aus reasonPayload() (Katalog-Key +
 * Parameter) — gerendert wird erst beim Lesen, siehe lib/pool-reason.js.
 */
function writeEnabled(poolId, enabled, reason) {
    const db = openLiquidityDbRW();
    try {
        const row = db.prepare(`SELECT id FROM pools WHERE id = ?`).get(poolId);
        if (!row) throw new Error(t('api.poolact.pool_row_missing', { pool: poolId }));
        db.prepare(`UPDATE pools SET enabled = ?, enabled_changed_at = ?, enabled_reason = ? WHERE id = ?`)
            .run(enabled ? 1 : 0, Date.now(), reason, poolId);
    } finally {
        db.close();
    }
}

/** True wenn der Pool laut liquiditybot.db eine offene Position hält (Guthaben). */
function hasOpenPosition(poolId) {
    try {
        const db  = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const row = db.prepare(
            `SELECT 1 FROM positions WHERE pool_id = ? AND closed_at IS NULL LIMIT 1`
        ).get(poolId);
        db.close();
        return !!row;
    } catch {
        return false;
    }
}

/** Liest die aktuelle Pool-/Position-Info aus dem live geschriebenen Dashboard-JSON. */
function readPositionState(poolId) {
    try {
        const data    = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA, 'utf8'));
        // Nur OFFENE Position (closedAt == null); data.positions enthält auch History.
        const pos     = (data.positions ?? []).find(p => p.poolId === poolId && p.closedAt == null);
        const poolRow = (data.pools     ?? []).find(p => p.id === poolId);
        if (!pos && !poolRow) return null;
        return { pos, poolRow };
    } catch {
        return null;
    }
}

/**
 * spawned CLI-Script, sammelt stdout, parst das letzte JSON-Objekt.
 * 🔒 Nur für lesende Aufrufe (Dry-Run, position-state): Timeout und Neustart beenden den
 * Prozess. Finanzaktionen laufen über runPoolJob() / lib/finance-jobs.js (CORE#000993).
 */
function runCli(scriptRelPath, cliArgs, { timeoutMs = 90_000 } = {}) {
    return new Promise((resolve) => {
        const args = [path.join(LIQUIDITYBOT_ROOT, scriptRelPath), ...cliArgs];
        const proc = spawn('node', args, { cwd: LIQUIDITYBOT_ROOT });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try { proc.kill('SIGTERM'); } catch {}
            resolve({ ok: false, error: t('api.common.timeout_s', { seconds: timeoutMs / 1000 }), log: [], result: {} });
        }, timeoutMs);
        proc.stdout.on('data', c => { stdout += c.toString(); });
        proc.stderr.on('data', c => { stderr += c.toString(); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            // Letzte JSON-Zeile aus stdout extrahieren (vorher können DeprecationWarnings stehen).
            const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
            const jsonLine = [...lines].reverse().find(l => l.startsWith('{') && l.endsWith('}'));
            if (!jsonLine) {
                resolve({ ok: false, error: t('api.common.no_json_output_exit', { code }), log: [{ level: 'error', msg: stderr.slice(0, 500) }], result: {}, _raw: stdout });
                return;
            }
            try {
                const parsed = JSON.parse(jsonLine);
                resolve(parsed);
            } catch (err) {
                resolve({ ok: false, error: t('api.common.json_parse_failed', { error: err.message }), log: [], result: {}, _raw: stdout });
            }
        });
    });
}

/** Spawned estimate-costs.js für Kostenschätzung. */
function runEstimateCosts(poolPair, action, amount) {
    const args = ['--action', action, '--pool', poolPair, '--amount', String(amount), '--json'];
    return new Promise((resolve) => {
        const proc = spawn('node', [path.join(FORGE_ROOT, 'bin', 'estimate-costs.js'), ...args], { cwd: FORGE_ROOT });
        let stdout = '';
        const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} resolve(null); }, 30_000);
        proc.stdout.on('data', c => { stdout += c.toString(); });
        proc.on('close', () => {
            clearTimeout(timer);
            const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
            const jsonLine = [...lines].reverse().find(l => l.startsWith('{') && l.endsWith('}'));
            if (!jsonLine) { resolve(null); return; }
            try { resolve(JSON.parse(jsonLine)); } catch { resolve(null); }
        });
    });
}

/** Baut die CLI-Args aus dem Request-Body. */
function buildCliArgs(action, body, poolRef) {
    const args = ['--pool', poolRef, '--json']; // pool.id, nie pool.pair: gleiche Paare mit anderem Fee-Tier sind mehrdeutig (LIQ#000967)
    if (body.mode === 'full') {
        if (action !== 'withdraw') return { error: t('api.poolact.mode_full_withdraw_only') };
        args.push('--full');
    } else if (body.mode === 'usdc') {
        if (body.usdc == null) return { error: t('api.common.missing_in_body', { field: 'usdc' }) };
        args.push('--usdc', String(body.usdc));
    } else if (body.mode === 'token') {
        if (!body.tokenSymbol || body.amount == null) return { error: t('api.poolact.missing_token_amount') };
        args.push('--token', String(body.tokenSymbol), '--amount', String(body.amount));
    } else if (body.mode === 'pair') {
        // Beide Seiten als Obergrenze (Engpass-Logik) — nur für deposit, withdraw nutzt es nicht.
        if (action !== 'deposit') return { error: t('api.poolact.mode_pair_deposit_only') };
        if (body.maxA == null || body.maxB == null) return { error: t('api.poolact.missing_max_ab') };
        args.push('--max-a', String(body.maxA), '--max-b', String(body.maxB));
    } else {
        return { error: t('api.poolact.unknown_mode', { mode: body.mode }) };
    }
    if (action === 'deposit' && body.isNew) args.push('--new');
    if (action === 'withdraw') {
        if (body.swapToUsdc) args.push('--swap-to-usdc');
        if (body.sendTo) args.push('--send-to', String(body.sendTo));
    }
    return { args };
}

/**
 * Protokolliert jede kapitalbewegende Anfrage, BEVOR sie ausgeführt wird.
 *
 * Am 2026-08-22 landete eine manuelle Einzahlung von ~250 USDC in einem anderen Pool als
 * erwartet. Ob im Request eine andere Pool-ID stand oder im Modal ein anderer Pool gewählt
 * war, ließ sich nachträglich **nicht** feststellen: Gebucht ist nur das Ergebnis, die
 * Anfrage selbst hinterließ keine Spur. Eine Finanzaktion, die sich im Nachhinein nicht
 * rekonstruieren lässt, kostet im besten Fall eine Stunde Forensik — und im schlechteren
 * das Vertrauen in die Software, weil niemand die Frage beantworten kann.
 *
 * Bewusst vor der Ausführung: Bricht der Prozess ab oder läuft er in einen Timeout, ist die
 * Absicht trotzdem dokumentiert. Das Ergebnis kommt als zweite Zeile dazu.
 *
 * Bewusst ohne Empfängeradresse (`--send-to`): Die Zieladresse einer Auszahlung gehört nicht
 * ins Journal, sie steht bereits im Adressbuch und in der Transaktion.
 */
function logAction(phase, action, pool, body, extra = '') {
    const parts = [`pool=${pool.id}`, `pair=${pool.pair}`, `mode=${body?.mode ?? '?'}`];
    if (body?.usdc         != null) parts.push(`usdc=${body.usdc}`);
    if (body?.amount       != null) parts.push(`amount=${body.amount} ${body.tokenSymbol ?? ''}`.trim());
    if (body?.maxA         != null) parts.push(`maxA=${body.maxA}`, `maxB=${body.maxB}`);
    if (body?.isNew)                parts.push('new=1');
    if (body?.swapToUsdc)           parts.push('swapToUsdc=1');
    if (body?.sendTo)               parts.push('sendTo=gesetzt');
    console.log(`[pools-actions] ${action} ${phase}: ${parts.join(' ')}${extra ? ' – ' + extra : ''}`);
}

/** Startet bin/export.js im Hintergrund – Antwort an Client ist bereits raus. */
function triggerExport() {
    const proc = spawn('node', [path.join(LIQUIDITYBOT_ROOT, 'bin', 'export.js')], {
        cwd: LIQUIDITYBOT_ROOT, detached: true, stdio: 'ignore',
    });
    proc.unref();
}

/** Startet wallet-monitor im Hintergrund, damit wallet-monitor.db sofort aktuell ist. */
function triggerWalletMonitor() {
    const monitorJs = path.join(FORGE_ROOT, 'core', 'wallet-monitor', 'monitor.js');
    const proc = spawn('node', [monitorJs], {
        cwd: FORGE_ROOT, detached: true, stdio: 'ignore',
    });
    proc.unref();
}

// ── Einzahlung/Entnahme als losgelöster Job (CORE#000993) ─────────────────────
// Der Prozess überlebt einen Neustart von forge-settings und wird von keinem Timeout
// beendet (lib/finance-jobs.js). Die Route wartet so lange wie früher der Timeout war;
// ist die Aktion dann noch nicht fertig, antwortet sie mit 202 + jobId und die
// Oberfläche fragt /api/jobs/:id ab. Log und Export laufen in der Nacharbeit, damit sie
// auch nach einem Neustart genau einmal passieren.
const POOL_JOB_WAIT_MS = { deposit: 180_000, withdraw: 120_000 };

for (const action of ['deposit', 'withdraw']) {
    registerKind(`liq-${action}`, {
        onDone(result, job) {
            const { pool, body } = job.meta;
            logAction(result.ok ? 'ausgeführt' : 'fehlgeschlagen', action, pool, body,
                result.ok ? `tx=${result.result?.txHash ?? 'keine'}` : (result.error ?? 'ohne Fehlertext'));
            if (result.ok) { triggerExport(); triggerWalletMonitor(); }
            return result;
        },
    });
}

async function runPoolJob(res, action, pool, body, cliArgs) {
    const { job, conflict } = startJob({
        kind:   `liq-${action}`,
        key:    `liq:${pool.id}`,
        ref:    body?.clientRef,
        script: path.join(LIQUIDITYBOT_ROOT, 'bin', `${action}.js`),
        args:   cliArgs,
        cwd:    LIQUIDITYBOT_ROOT,
        meta:   { pool: { id: pool.id, pair: pool.pair }, body },
    });
    if (conflict) {
        return res.status(409).json({ ok: false, error: t('api.jobs.already_running'), busy: true, jobId: conflict.id });
    }
    logAction('angefordert', action, pool, body);
    const current = await waitForJob(job.id, POOL_JOB_WAIT_MS[action]);
    const { status, body: out } = jobResponse(current, t('api.jobs.still_running'));
    res.status(status).json(out);
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/liquidity/:poolId/position-state', (req, res) => {
    const pool = findPool(req.params.poolId);
    if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });
    const state = readPositionState(req.params.poolId);

    // btcPrice aus data.json
    let btcPrice = null;
    if (pool.btcPricePoolId) {
        try {
            const d  = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA, 'utf8'));
            const ref = (d.pools ?? []).find(p => p.id === pool.btcPricePoolId);
            btcPrice  = ref?.price ?? null;
        } catch { /* ignore */ }
    }
    // quotePrice aus data.json (für volatilePair-Pools)
    let quotePrice = null;
    if (pool.volatilePair && pool.quotePricePoolId) {
        try {
            const d  = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA, 'utf8'));
            const ref = (d.pools ?? []).find(p => p.id === pool.quotePricePoolId);
            quotePrice = ref?.price ?? null;
        } catch { /* ignore */ }
    }
    // priceHistory (letzte 24h) aus data-history.json
    let priceHistory = [];
    try {
        const hist  = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA_HISTORY, 'utf8'));
        const since = Date.now() - 24 * 60 * 60 * 1000;
        priceHistory = (hist.priceHistory ?? []).filter(r => r.poolId === pool.id && r.t >= since);
    } catch { /* ignore */ }

    res.json({
        poolId:        pool.id,
        pair:          pool.pair,
        displayPair:   pool.displayPair ?? pool.pair,
        tokenA:        pool.tokenA,
        tokenB:        pool.tokenB,
        tokenALabel:   pool.usdcIsTokenA ? pool.pair.split('/')[1] : pool.pair.split('/')[0],
        tokenBLabel:   pool.usdcIsTokenA ? pool.pair.split('/')[0] : pool.pair.split('/')[1],
        decimalsA:     pool.decimalsA,
        decimalsB:     pool.decimalsB,
        usdcIsTokenA:  !!pool.usdcIsTokenA,
        btcPricePoolId: pool.btcPricePoolId ?? null,
        btcPrice,
        volatilePair:  !!pool.volatilePair,
        quoteIsTokenA: pool.volatilePair ? (pool.quoteTokenMint === pool.tokenA) : false,
        quotePrice,
        active:        !!pool.active,
        enabled:       pool.enabled !== false,
        position:      state?.pos ?? null,
        poolStats:     state?.poolRow ?? null,
        priceHistory,
    });
});

/**
 * GET /liquidity/:poolId/position-state/live
 *
 * Live-Preis/Range-Status direkt on-chain (adapter.getPositionState(), dieselbe
 * Quelle wie beim Rebalancing-Check) statt aus dem nur stündlich aktualisierten
 * data.json-Cache (Fund 2026-08-07: Deposit-Modal zeigte nach einem Rebalancing
 * bis zu 1h lang fälschlich "out of Range"). Bewusst eigener Endpoint statt Teil
 * von /position-state: der On-Chain-Call dauert (RPC + Rate-Limiter) spürbar
 * länger als ein reiner Cache-Read — das Modal öffnet mit /position-state sofort
 * und holt diesen Live-Wert im Hintergrund nach (siehe bot-liquidity.js), damit
 * der ~30s-Delay eines blockierenden Calls beim Öffnen entfällt.
 */
router.get('/liquidity/:poolId/position-state/live', async (req, res) => {
    const pool = findPool(req.params.poolId);
    if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });
    try {
        const live = await runCli('bin/position-state.js', ['--pool', pool.id], { timeoutMs: 15_000 });
        res.json(live ?? { ok: false, error: t('api.common.no_result') });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

/**
 * GET /liquidity/:poolId/deposit-gas-estimate?isNew=0|1
 *
 * Schätzt, wie viel USDC im Wallet mindestens vorhanden sein muss, damit ein
 * "Per USDC-Betrag"-Deposit trotz knapper SOL-Reserve durchläuft. Muss synchron
 * bleiben mit der Top-Up-Logik in bots/liquidity/bin/deposit.js
 * (_autoTopUpSol + oberer SOL-Check): gleiche Konstanten (solFeePerTx=0.01,
 * TX-Anzahl, +0.01 Zielpuffer, 2% Swap-Slippage) und gleiche solReserve-Quelle
 * (.env SOL_RESERVE) — bei Änderung dort auch hier anpassen.
 */
router.get('/liquidity/:poolId/deposit-gas-estimate', async (req, res) => {
    const pool = findPool(req.params.poolId);
    if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });

    const isNew          = req.query.isNew === '1' || req.query.isNew === 'true';
    const minUsdcDeposit  = isNew ? 5 : (pool.btcPricePoolId ? 2 : 1);
    const txCount         = pool.volatilePair ? 3 : 2;
    const solFeePerTx     = 0.01;
    const solReserve      = parseFloat(readEnvField(LIQUIDITYBOT_ENV, 'SOL_RESERVE') ?? '0.10');

    let walletSolTotal;
    try {
        const keypairPath = readEnvField(LIQUIDITYBOT_ENV, 'KEYPAIR_PATH');
        const kp          = keypairPath ? loadKeypair(keypairPath) : null;
        if (!kp) throw new Error(t('api.poolact.keypair_missing'));
        const conn     = new Connection(NEXUS_RPC_FRESH, RPC_CONN_OPTS);
        const lamports = await conn.getBalance(new PublicKey(kp.pubkey));
        walletSolTotal = lamports / LAMPORTS_PER_SOL;
    } catch (err) {
        return res.status(500).json({ error: t('api.poolact.sol_balance_failed', { error: err.message }) });
    }

    let solPrice = 0;
    try {
        const db  = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const row = db.prepare(
            `SELECT price FROM pool_stats WHERE pool_id = 'liq-sol-usdc' ORDER BY recorded_at DESC LIMIT 1`
        ).get();
        db.close();
        solPrice = row?.price ?? 0;
    } catch { /* ignore */ }

    const usableSol    = Math.max(0, walletSolTotal - solReserve);
    const minNeededSol = solReserve + txCount * solFeePerTx;
    let gapUsdc = 0;
    if (usableSol < minNeededSol && solPrice > 0) {
        const target    = minNeededSol + 0.01;
        const neededSol = target - usableSol;
        gapUsdc = neededSol * solPrice * 1.02;
    }

    res.json({
        walletSolTotal,
        usableSol,
        solReserve,
        minNeededSol,
        solPrice,
        gapUsdc,
        minUsdcDeposit,
        minUsdcTotal: gapUsdc + minUsdcDeposit,
    });
});

router.post('/liquidity/:poolId/preview', async (req, res) => {
    const pool = findPool(req.params.poolId);
    if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });

    const action = req.body?.action;
    if (action !== 'deposit' && action !== 'withdraw') {
        return res.status(400).json({ error: t('api.poolact.invalid_action', { action }) });
    }
    if (action === 'deposit' && pool.uiDepositDisabled) {
        return res.status(409).json({ error: t('api.poolact.no_manual_deposit') });
    }

    const built = buildCliArgs(action, req.body, pool.id);
    if (built.error) return res.status(400).json({ error: built.error });

    const script = action === 'deposit' ? 'bin/deposit.js' : 'bin/withdraw.js';
    const dry    = await runCli(script, [...built.args, '--dry-run']);

    // Kostenschätzung parallel — Amount-Ableitung:
    // - usdc-Mode: req.body.usdc direkt
    // - token-Mode: Dry-Run liefert estimatedUsdc → das nutzen
    let estimateAmount = null;
    if (req.body.mode === 'usdc') estimateAmount = parseFloat(req.body.usdc);
    else if (dry?.result?.estimatedUsdc) estimateAmount = dry.result.estimatedUsdc;
    // full-mode: Dry-Run liefert geschätzten Positionswert
    if (req.body.mode === 'full' && dry?.result?.posValueEstimate) estimateAmount = dry.result.posValueEstimate;

    let costs = null;
    if (estimateAmount > 0) {
        const ecAction = action === 'deposit'
            ? (req.body.isNew ? 'open' : 'deposit')
            : 'withdraw';
        costs = await runEstimateCosts(pool.pair, ecAction, estimateAmount);
    }

    res.json({ dryRun: dry, costs });
});

router.post('/liquidity/:poolId/deposit', (req, res) => {
    const pool = findPool(req.params.poolId);
    if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });
    if (pool.uiDepositDisabled) {
        return res.status(409).json({ error: t('api.poolact.no_manual_deposit') });
    }

    const built = buildCliArgs('deposit', req.body, pool.id);
    if (built.error) return res.status(400).json({ error: built.error });

    return runPoolJob(res, 'deposit', pool, req.body, built.args);
});

router.post('/liquidity/:poolId/withdraw', (req, res) => {
    const pool = findPool(req.params.poolId);
    if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });

    const built = buildCliArgs('withdraw', req.body, pool.id);
    if (built.error) return res.status(400).json({ error: built.error });

    return runPoolJob(res, 'withdraw', pool, req.body, built.args);
});

router.post('/liquidity/:poolId/rebalance', (req, res) => {
    const pool = findPool(req.params.poolId);
    if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });
    if (!pool.active) return res.status(409).json({ error: t('api.poolact.pool_inactive') });

    const flagFile = path.join(PATHS.liquidityData, `force-rebalance-${pool.id}.flag`);
    try {
        fs.writeFileSync(flagFile, '', 'utf8');
    } catch (err) {
        return res.status(500).json({ error: t('api.poolact.flag_failed', { error: err.message }) });
    }

    console.log(`[pools-actions] rebalance angefordert: pool=${pool.id} pair=${pool.pair}`);
    res.json({ ok: true, message: t('api.poolact.rebalance_queued') });
});

/** POST /api/pools/liquidity/:poolId/enabled
 * Benutzer-Freigabe eines Pools setzen (enabled, in liquiditybot.db) — der Knopf
 * „Aktivieren"/„Deaktivieren" in der Pool-Zeile (LIQ#000937).
 *
 *   Body: { enabled: true | false }
 *
 * Deaktivieren nur, wenn der Pool KEINE offene Position hält: erst vollständig auszahlen.
 * Greift per Hot-Reload im nächsten Bot-Zyklus ohne Neustart.
 *
 * Ersetzt die Drei-Stufen-Auswahl POST .../mode (LIQ#0365: Deaktiviert / Cleanup inaktiv /
 * Cleanup aktiv). Deren zweite Achse, `cleanup.rankingEligible`, wertet seit LIQ#000929
 * niemand mehr aus, und mit ihr entfiel die daran gekoppelte Dry-Run-Sperre für
 * Pool-Angebote (bin/pool-offers-dryrun.js meldet seither nur noch).
 */
router.post('/liquidity/:poolId/enabled', (req, res) => {
    const pool = findPool(req.params.poolId);
    if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });

    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: t('api.poolact.body_enabled_required') });
    }

    if (!enabled && hasOpenPosition(pool.id)) {
        return res.status(409).json({ error: t('api.poolact.pool_has_position') });
    }

    if ((pool.enabled !== false) === enabled) { // Default fehlend = freigegeben
        return res.json({ ok: true, enabled, message: t('api.poolact.already_in_state'), unchanged: true });
    }

    try {
        writeEnabled(pool.id, enabled, reasonPayload(enabled ? 'reason.manual_enable' : 'reason.manual_disable'));
    } catch (err) {
        return res.status(500).json({ error: t('api.poolact.enabled_set_failed', { error: err.message }) });
    }

    triggerExport();
    res.json({
        ok: true,
        enabled,
        message: t(enabled ? 'api.poolact.pool_enabled_msg' : 'api.poolact.pool_disabled_msg', { pool: pool.displayPair ?? pool.pair }),
    });
});

/** POST /api/pools/liquidity/:poolId/advisor-rebalance
 * Übernimmt die Advisor-Empfehlung: schreibt neue fixedPct in die liquiditybot.db
 * und setzt das force-rebalance-Flag. Der Bot übernimmt beim nächsten Tick.
 */
router.post('/liquidity/:poolId/advisor-rebalance', (req, res) => {
    const pool = findPool(req.params.poolId);
    if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });
    if (!pool.active) return res.status(409).json({ error: t('api.poolact.pool_inactive') });

    const hint = readAdvisorHint(pool);
    if (!hint) {
        return res.status(409).json({ error: t('api.poolact.no_advisor_hint') });
    }

    try {
        writeFixedPct(pool.id, hint.recommendedPct);
    } catch (err) {
        return res.status(500).json({ error: t('api.poolact.fixedpct_failed', { error: err.message }) });
    }

    const flagFile = path.join(PATHS.liquidityData, `force-rebalance-${pool.id}.flag`);
    try {
        fs.writeFileSync(flagFile, '', 'utf8');
    } catch (err) {
        return res.status(500).json({ error: t('api.poolact.rebalance_flag_failed', { error: err.message }) });
    }

    res.json({
        ok:          true,
        previousPct: hint.currentPct,
        newPct:      hint.recommendedPct,
        message:     t('api.poolact.range_set', { from: hint.currentPct, to: hint.recommendedPct }),
    });
});

export default router;
