/**
 * Schreibt Wallet-Snapshots in FORGE/data/wallet-monitor.db (Single Source für die
 * Wallet-Ansicht im Dashboard/Settings-UI, siehe bots/settings/routes/wallet.js).
 *
 * writeWalletSnapshot – Schreibt einen frischen Snapshot nach manuellen Operationen
 *   (deposit, withdraw) damit die Wallet-Ansicht sofort aktuelle Werte zeigt, statt
 *   bis zu 10 Min auf den nächsten core/wallet-monitor/monitor.js-Cronlauf zu warten.
 *
 * Analog zu bots/liquidity/lib/wallet-monitor-client.js (dort bereits produktiv).
 */

import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';

const WM_DB_PATH = PATHS.walletMonitorDb;

/**
 * @param {object} opts
 * @param {string}   opts.walletId      z.B. 'lending'
 * @param {string}   opts.walletLabel   z.B. 'Lending'
 * @param {string}   opts.walletAddress Solana-Adresse (base58)
 * @param {number}   opts.solBalance    SOL-Guthaben
 * @param {number}   opts.usdcBalance   USDC-Guthaben
 * @param {number}   [opts.solPriceUsd] SOL-Preis in USDC (default: 0)
 * @param {Array}    [opts.tokens]      SPL-Token [{symbol, mint, balance, priceUsd, valueUsd}]
 */
export function writeWalletSnapshot({
    walletId, walletLabel, walletAddress,
    solBalance, usdcBalance, solPriceUsd = 0, tokens = [],
}) {
    let wmDb;
    try {
        wmDb = new Database(WM_DB_PATH, { fileMustExist: true });
        const splUsd   = tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0);
        const totalUsd = solBalance * solPriceUsd + usdcBalance + splUsd;
        const ts       = Date.now();

        const ins = wmDb.prepare(`
            INSERT INTO snapshots
                (wallet_id, wallet_label, wallet_address, recorded_at, sol_balance, usdc_balance, total_usd)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(walletId, walletLabel, walletAddress, ts, solBalance, usdcBalance, totalUsd);

        for (const t of tokens) {
            wmDb.prepare(`
                INSERT INTO token_balances (snapshot_id, symbol, mint, balance, price_usd, value_usd)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(ins.lastInsertRowid, t.symbol, t.mint, t.balance, t.priceUsd ?? 0, t.valueUsd ?? 0);
        }
    } catch (err) {
        console.warn('[wallet-monitor-client] writeWalletSnapshot fehlgeschlagen:', err.message);
    } finally {
        wmDb?.close();
    }
}
