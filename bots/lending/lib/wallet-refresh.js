/**
 * FORGE LendingBot – Wallet-Refresh nach Deposit/Withdraw.
 *
 * Ohne diesen Mechanismus liest die Wallet-Ansicht (Senden-Funktion, Guthabenanzeige)
 * ausschließlich Snapshots aus wallet-monitor.db, die core/wallet-monitor/monitor.js
 * nur alle 10 Minuten schreibt. Direkt nach einem Deposit/Withdraw wäre die Anzeige
 * also bis zu 10 Min veraltet — genau das Problem, das für den Liquidity Bot bereits
 * mit `refreshAfterAction` (bots/liquidity/lib/refresh-state.js) gelöst ist.
 *
 * Zwei-Phasen-Refresh (analog Liquidity Bot):
 *   Phase 1 (T+settleMs): sofortiger Snapshot via Live-RPC-Read (SOL+USDC) — ggf.
 *                          noch leicht stale, wenn Helius den neuen Stand noch nicht
 *                          propagiert hat.
 *   Phase 2 (T+settleMs+10s): core/wallet-monitor/monitor.js als Subprocess — liest
 *                          alle Wallets mit frischer Connection + Jupiter-Preisen neu,
 *                          zuverlässigerer zweiter Read.
 */

import { spawn }             from 'child_process';
import { resolve, dirname }  from 'path';
import { fileURLToPath }     from 'url';
import Database               from 'better-sqlite3';

import { getSolBalance, getUsdcBalance } from './wallet.js';
import { writeWalletSnapshot }           from './wallet-monitor-client.js';
import { PATHS }                          from '../../../config/paths.js';

const __dirname          = dirname(fileURLToPath(import.meta.url));
const WALLET_MONITOR_JS  = resolve(__dirname, '../../../core/wallet-monitor/monitor.js');

const WALLET_ID    = 'lending';
const WALLET_LABEL = 'Lending';

/** Letzten SOL-Preis aus prices.db (von monitor.js selbst gepflegt) — kein Extra-API-Call nötig. */
function latestSolPriceUsd() {
    let db;
    try {
        db = new Database(PATHS.pricesDb, { readonly: true, fileMustExist: true });
        const row = db.prepare(
            `SELECT price FROM price_history WHERE pair = 'SOL/USDC' ORDER BY recorded_at DESC LIMIT 1`,
        ).get();
        return row?.price ?? 0;
    } catch {
        return 0;
    } finally {
        db?.close();
    }
}

function runWalletMonitorOnce() {
    return new Promise((res, rej) => {
        const child = spawn('node', [WALLET_MONITOR_JS], {
            env:   process.env,
            stdio: 'pipe',
        });
        child.on('close', code => code === 0 ? res() : rej(new Error(`wallet-monitor exit ${code}`)));
        child.on('error', rej);
        setTimeout(() => { child.kill(); rej(new Error('wallet-monitor timeout')); }, 30_000);
    });
}

/**
 * @param {object} opts
 * @param {string} opts.walletAddress
 * @param {number} [opts.settleMs]  Phase-1-Wartezeit in ms (default: 6000)
 */
export async function refreshWalletAfterAction({ walletAddress, settleMs = 6000 }) {
    // ─── Phase 1: sofortiger Snapshot (ggf. leicht stale) ────────────────────
    if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs));
    try {
        const [solBalance, usdcBalance] = await Promise.all([
            getSolBalance(walletAddress),
            getUsdcBalance(walletAddress),
        ]);
        writeWalletSnapshot({
            walletId:      WALLET_ID,
            walletLabel:   WALLET_LABEL,
            walletAddress,
            solBalance,
            usdcBalance,
            solPriceUsd:   latestSolPriceUsd(),
        });
    } catch (err) {
        console.warn(`[wallet-refresh] Phase-1 Snapshot fehlgeschlagen: ${err.message}`);
    }

    // ─── Phase 2: zuverlässiger Wallet-Snapshot via externem monitor.js ───────
    await new Promise(r => setTimeout(r, 10_000));
    try {
        await runWalletMonitorOnce();
    } catch (err) {
        console.warn(`[wallet-refresh] Phase-2 wallet-monitor fehlgeschlagen: ${err.message}`);
    }
}
