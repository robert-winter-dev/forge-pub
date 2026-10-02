/**
 * FORGE Liquidity – Cleanup > Reinvest (LIQ#000988): Planung und Ausführung.
 *
 * Freies Wallet-USDC wird in den Pool mit dem besten PnL oder Edge eingezahlt — ausschließlich
 * in eine BESTEHENDE, offene Position. 🔒 Reinvest eröffnet nie eine Position (Open-only-Regel,
 * LIQ#000937). Abgesichert an mehreren Stellen:
 *
 *   1. Kandidaten sind nur Pools mit aktuell offener Position (getOpenPosition).
 *   2. Direkt vor dem Lauf von bin/deposit.js wird die Position frisch gelesen (executeReinvest).
 *   3. bin/deposit.js läuft OHNE `--new` (bricht ohne Position ab) und mit `--expect-position`
 *      (bricht vor dem ersten Swap ab, wenn die Position weg oder eine andere ist).
 *   4. Kein Nachrücken: bricht der Lauf für den Gewinner ab, wird der Zweitplatzierte nicht versucht.
 *   5. Zusätzlich verweigert _openNewPosition() in bin/bot.js jedes Öffnen, das kein Wiedereröffnen ist.
 *
 * Die eigentliche Einzahlung (Pre-Swap auf das CLMM-Verhältnis, increaseLiquidity, Buchung) macht
 * bin/deposit.js — dieselbe, im Betrieb erprobte Route wie „Einzahlen" in den Settings. Dieses Modul
 * entscheidet nur WOHIN und WIEVIEL. Alle Abhängigkeiten werden injiziert, damit
 * bin/test-cleanup-reinvest.js ohne Chain und ohne Wallet läuft.
 *
 * Auswahlregeln (Gleichstand, ≥ 0) stehen in FORGE/lib/reinvest-rules.js.
 * Konzept: LIQ#000988, Abschnitt „Reinvest" im Cleanup-Konzept.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    REINVEST_EDGE_WINDOW, REINVEST_PNL_WINDOW,
    selectReinvestTarget, buildDepositArgs, formatReinvestNote, readEdgeSnapshot,
} from '../../../lib/reinvest-rules.js';
import { getExitReservations, describeReservation, assertReservationsReadable } from './exit-reservation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPOSIT_SCRIPT = path.join(__dirname, '..', 'bin', 'deposit.js');
const DEPOSIT_TIMEOUT_MS = 10 * 60 * 1000;

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

/**
 * Kandidaten und Auswahl für einen Modus, ohne Betrag, Wallet und Range. Gemeinsam für den Cleanup
 * (planReinvest) und die Vorschau im Dashboard/Settings, damit beide dasselbe Ergebnis zeigen.
 * Kandidaten sind NUR Pools mit aktuell offener Position.
 *
 * @param {object} deps  pools, isPoolEnabled, getOpenPosition, exitBlock, checkEligibility, pnl24h
 * @param {'pnl'|'edge'} mode
 * @param {{byPool: Object<string, number|null>}} edge
 */
export function pickReinvestCandidate(deps, mode, edge) {
    const candidates = [];
    const excluded = [];
    for (const pool of deps.pools) {
        const name = pool.displayLabel ?? pool.displayPair ?? pool.pair ?? pool.id;
        if (!deps.isPoolEnabled(pool)) { excluded.push(`${name}: gesperrt`); continue; }
        const pos = deps.getOpenPosition(pool.id);
        if (!pos) { excluded.push(`${name}: keine offene Position`); continue; }
        const ex = deps.exitBlock(pool);
        if (ex.blocked) { excluded.push(`${name}: Exit läuft (${ex.reason})`); continue; }
        const elig = deps.checkEligibility(pool);
        if (!elig.ok) { excluded.push(`${name}: ${elig.reason}`); continue; }
        candidates.push({ poolId: pool.id, name, pnl: deps.pnl24h(pos), edge: edge.byPool[pool.id] ?? null });
    }
    return { sel: selectReinvestTarget({ mode, candidates }), candidates, excluded };
}

/**
 * Vorschau für die Anzeige neben den Optionen „Bester PnL (24h)“ / „Bester Edge (24h)“: in welchen
 * Pool ginge Reinvest jetzt, wenn die Option aktiv wäre? Ohne Wallet-Betrag, Range-Prüfung und
 * Wiedereröffnungs-Wartestand, das sind Momentaufnahmen des Laufs, nicht der Wahl.
 * Der Export schreibt das Ergebnis als `reinvestPreview` in die data.json.
 *
 * @returns {{pnl: {poolId: string, name: string}|null, edge: {poolId: string, name: string}|null}}
 */
export function previewReinvestTargets(deps, edge) {
    const one = mode => {
        const { sel } = pickReinvestCandidate(deps, mode, edge);
        return sel.target ? { poolId: sel.target.poolId, name: sel.target.name } : null;
    };
    return { pnl: one('pnl'), edge: one('edge') };
}

/**
 * Prüft, ob auf einem Pool ein Exit läuft (Pool selbst oder eines seiner Token). Nicht lesbar heißt
 * „blockiert“: nicht investieren ist folgenlos, falsch investieren nicht (LIQ#0310).
 */
export function exitBlockFor(db, logPrefix = '[cleanup:reinvest]') {
    return pool => {
        const r = getExitReservations(db);
        if (!assertReservationsReadable(r, logPrefix)) return { blocked: true, reason: 'Exit-Zustand unbekannt' };
        const own = r.pools.get(pool.id);
        if (own) return { blocked: true, reason: describeReservation(own) };
        for (const mint of [pool.tokenA, pool.tokenB]) {
            const e = mint ? r.mints.get(mint) : null;
            if (e) return { blocked: true, reason: describeReservation(e) };
        }
        return { blocked: false, reason: null };
    };
}

/**
 * Entscheidet, ob und wohin reinvestiert wird. Bewegt nichts.
 *
 * @param {object} deps
 * @param {object[]} deps.pools                          Pool-Konfigurationen (config.pools.all)
 * @param {(pool) => boolean} deps.isPoolEnabled
 * @param {(poolId) => object|null} deps.getOpenPosition offene Position oder null (frisch aus der DB)
 * @param {(pool) => {blocked: boolean, reason: string|null}} deps.exitBlock  laufender Exit?
 * @param {(pool) => {ok: boolean, reason: string|null}} deps.checkEligibility  TVL-Schutz-Guard
 * @param {(pos) => number|null} deps.pnl24h             PnL der letzten 24h (Spalte der Opportunity-Tabelle)
 * @param {() => object} deps.readEdge                   → readEdgeSnapshot()
 * @param {(pool, pos) => Promise<{inRange: boolean}>} deps.getPositionState
 * @param {() => Promise<number>} deps.getWalletUsdc     investierbares USDC (nach Premium-Reserve)
 * @param {(pool) => number} deps.remainingCapacity      Rest bis Max Investment (Infinity = keins)
 * @param {() => string[]} deps.pendingReopens           Pools, die gerade auf eine Wiedereröffnung warten
 * @param {(msg: string) => void} deps.log
 * @param {{mode: 'off'|'pnl'|'edge', minUsdc: number, maxUsdc: number, invalid: string|null}} cfg
 * @returns {Promise<{action: 'skip', reason: string} |
 *                   {action: 'invest', pool: object, pos: object, usdc: number, mode: string,
 *                    target: object, tie: boolean, note: string}>}
 */
export async function planReinvest(deps, cfg) {
    const { log } = deps;
    const skip = (reason, msg) => { if (msg) log(msg); return { action: 'skip', reason }; };

    if (cfg.invalid) return skip('invalid_config', `Reinvest: Einstellung ungültig (${cfg.invalid}) – wie „Deaktiviert“ behandelt.`);
    if (cfg.mode === 'off') return skip('off', 'Reinvest: deaktiviert.');

    const modeLabel = cfg.mode === 'pnl' ? `Bester PnL (${REINVEST_PNL_WINDOW.id})` : `Bester Edge (${REINVEST_EDGE_WINDOW})`;

    // Premium-Sperre: ohne aktuelle Premium-Daten (bzw. auf dem Master ohne eigene Berechnung)
    // wird nichts investiert. Die Route in den Settings verhindert schon das Setzen des Modus,
    // dies hier deckt den späteren Wegfall von Premium ab.
    const edge = deps.readEdge();
    if (!edge.available) {
        return skip('no_premium', `Reinvest (${modeLabel}): keine aktuellen Premium-Daten (${edge.reason}) – nichts investiert.`);
    }

    // Wartet ein Pool auf seine Wiedereröffnung (aktiv, aber gerade ohne Position, oder abgebrochenes
    // Rebalancing vorgemerkt), braucht der Bot das freie USDC dafür — der Reinvest nähme es weg
    // (LIQ#0355: gleiche Fallklasse wie der Dust-Sweep gegen pre-geswappte Token).
    const pending = deps.pendingReopens();
    if (pending.length) {
        return skip('reopen_pending', `Reinvest (${modeLabel}): ${pending.join(', ')} wartet auf Wiedereröffnung – freies USDC bleibt dafür liegen, nichts investiert.`);
    }

    const walletUsdc = await deps.getWalletUsdc();
    if (!(walletUsdc >= cfg.minUsdc)) {
        return skip('below_min', `Reinvest (${modeLabel}): freies USDC ${fmt(walletUsdc)} unter Untergrenze ${fmt(cfg.minUsdc)} – nichts investiert.`);
    }

    // Kandidaten: NUR Pools mit aktuell offener Position.
    const { sel, excluded } = pickReinvestCandidate(deps, cfg.mode, edge);
    if (excluded.length) log(`Reinvest: ausgeschlossen – ${excluded.join('; ')}`);

    const top = sel.ranking.slice(0, 5)
        .map(c => `${c.name} (PnL ${fmt(c.pnl)} USDC, Edge ${fmt(c.edge)})`).join(' | ');
    if (top) log(`Reinvest (${modeLabel}): Rangfolge – ${top}`);

    if (!sel.target) {
        const why = sel.reason === 'no_candidate'
            ? `kein Pool mit ${cfg.mode === 'pnl' ? 'PnL' : 'Edge'} ≥ 0`
            : 'Gleichstand auch im zweiten Kriterium';
        return skip(sel.reason, `Reinvest (${modeLabel}): ${why} – nichts investiert.`);
    }

    const target = sel.target;
    const tie = sel.reason === 'tie_secondary';
    if (tie) log(`Reinvest (${modeLabel}): Gleichstand → ${cfg.mode === 'pnl' ? 'Edge' : 'PnL'} entscheidet für ${target.name}.`);

    const pool = deps.pools.find(p => p.id === target.poolId);
    const pos = deps.getOpenPosition(pool.id);
    if (!pos) return skip('no_position', `Reinvest: ${target.name} hat keine offene Position mehr – nichts investiert.`);

    // Range-Guard VOR dem Swap: bin/deposit.js prüft „in Range" erst nach dem Pre-Swap, eine
    // out-of-range-Position würde einen Hin-und-Rück-Tausch kosten (KB cleanup-invest.md).
    // Kein Nachrücken auf den Zweitplatzierten: das ist eine Momentaufnahme, der nächste Lauf
    // versucht es erneut.
    try {
        const state = await deps.getPositionState(pool, pos);
        if (!state.inRange) return skip('out_of_range', `Reinvest: ${target.name} out-of-range – nichts investiert (nächster Lauf versucht es erneut).`);
    } catch (err) {
        return skip('state_unreadable', `Reinvest: Position-State von ${target.name} nicht abrufbar (${err.message}) – nichts investiert.`);
    }

    const usdc = Math.min(walletUsdc, cfg.maxUsdc, deps.remainingCapacity(pool));
    if (!(usdc >= cfg.minUsdc)) {
        return skip('capacity_below_min', `Reinvest: ${target.name} – verfügbarer Betrag ${fmt(usdc)} USDC unter Untergrenze ${fmt(cfg.minUsdc)} (Obergrenze/Max Investment) – nichts investiert.`);
    }

    const note = formatReinvestNote({ mode: cfg.mode, pnl: target.pnl, edge: target.edge, tie });
    log(`Reinvest (${modeLabel}): ${fmt(usdc)} USDC → ${target.name} (bestehende Position ${pos.nft_mint}).`);
    return { action: 'invest', pool, pos, usdc, mode: cfg.mode, target, tie, note };
}

/**
 * Startet bin/deposit.js als eigenen Prozess (JSON-Ausgabe). Das Skript nimmt den Manual-Lock,
 * wartet auf den Bot und bucht wie bei „Einzahlen“.
 *
 * @param {string[]} args  aus buildDepositArgs()
 * @returns {Promise<{ok: boolean, error: string|null, result: object|null}>}
 */
export function runDepositScript(args) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [DEPOSIT_SCRIPT, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), DEPOSIT_TIMEOUT_MS);
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message, result: null }); });
        child.on('close', () => {
            clearTimeout(timer);
            const lastJson = out.trim().split('\n').reverse().find(l => l.startsWith('{'));
            try {
                const j = JSON.parse(lastJson);
                resolve({ ok: j.ok === true, error: j.error ?? null, result: j.result ?? null });
            } catch {
                resolve({ ok: false, error: `deposit.js ohne lesbare Antwort${err ? `: ${err.trim().slice(-300)}` : ''}`, result: null });
            }
        });
    });
}

/**
 * Führt einen geplanten Reinvest aus.
 *
 * @param {object} plan  Ergebnis von planReinvest() mit action 'invest'
 * @param {object} deps
 * @param {(poolId) => object|null} deps.getOpenPosition
 * @param {() => void} deps.releaseLock         gibt den Cleanup-Lock frei (deposit.js bricht sonst ab)
 * @param {(args: string[]) => Promise<{ok: boolean, error: string|null, result: object|null}>} deps.runDeposit
 * @param {(msg: string) => void} deps.log
 * @returns {Promise<{status: 'deposited'|'no_position'|'failed', error?: string, result?: object}>}
 */
export async function executeReinvest(plan, deps) {
    const { pool, pos, usdc, note } = plan;
    const name = pool.displayPair ?? pool.pair ?? pool.id;

    // 🔒 Zweites Neu-Lesen, direkt vor dem Einzahlen: zwischen Planung (Range-Abfrage On-Chain)
    // und jetzt kann ein Rebalance oder Exit die Position geschlossen haben.
    const fresh = deps.getOpenPosition(pool.id);
    if (!fresh || fresh.nft_mint !== pos.nft_mint) {
        deps.log(`Reinvest: ${name} hat nicht mehr die geplante offene Position – Abbruch, nichts investiert.`);
        return { status: 'no_position' };
    }

    const args = buildDepositArgs({ poolId: pool.id, usdc, nftMint: pos.nft_mint, note });
    deps.releaseLock();
    const run = await deps.runDeposit(args);
    if (!run.ok) {
        deps.log(`Reinvest: Einzahlung in ${name} nicht ausgeführt – ${run.error ?? 'unbekannter Fehler'}`);
        return { status: 'failed', error: run.error ?? 'unbekannter Fehler', result: run.result ?? undefined };
    }
    deps.log(`Reinvest: ${fmt(run.result?.depositedUsdc ?? usdc)} USDC in ${name} eingezahlt (TX ${run.result?.txHash ?? '—'}).`);
    return { status: 'deposited', result: run.result ?? undefined };
}

export { readEdgeSnapshot };
