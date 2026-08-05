/**
 * Liest/schreibt Wallet-Snapshots in FORGE/data/wallet-monitor.db.
 *
 * getSplTokensUsd – Fallback: 0 wenn die DB nicht vorhanden oder der Snapshot zu alt ist.
 * writeWalletSnapshot – Schreibt einen frischen Snapshot nach manuellen Operationen
 *   (deposit, withdraw) damit das Dashboard sofort aktuelle Werte zeigt.
 *
 * Wird in export.js, deposit.js und bot.js verwendet.
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';
import { PATHS } from '../../../config/paths.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const WM_DB_PATH = PATHS.walletMonitorDb;

/** Maximales Alter eines Snapshots in ms – ältere Werte werden ignoriert (2 Zyklen à 10 min) */
const MAX_AGE_MS = 20 * 60 * 1000;

/**
 * Liest die jüngste Wallet-Balance aus wallet-monitor.db.
 * Single Source of Truth für SOL/USDC/SPL-Tokens — keine parallele Quelle mehr.
 *
 * @param {string} walletId  z.B. 'liquidity'
 * @returns {{sol:number, usdc:number, solPriceUsd:number, splTokensUsd:number, totalUsd:number, recordedAt:number}|null}
 *          null wenn kein Snapshot existiert (Cold-Start) oder DB nicht lesbar.
 *          Werte sind die jüngsten verfügbaren — KEIN Age-Cutoff (Caller entscheidet).
 */
export function getLatestWalletBalance(walletId) {
    let wmDb;
    try {
        wmDb = new Database(WM_DB_PATH, { readonly: true, fileMustExist: true });
        // Vollständiger Snapshot inkl. wallet_label, damit Verbraucher (z.B. export.js
        // walletMonitor) KEINEN zweiten Read benötigen (Single Source, LMB#0166).
        const snap = wmDb.prepare(`
            SELECT id, wallet_id, wallet_label, recorded_at,
                   sol_balance, usdc_balance, total_usd
            FROM snapshots WHERE wallet_id = ? ORDER BY recorded_at DESC LIMIT 1
        `).get(walletId);
        if (!snap) return null;

        // Token-Details desselben Snapshots (für Wallet-Modal-Anzeige + SPL-Summe).
        const tokens = wmDb.prepare(`
            SELECT symbol, balance, price_usd, value_usd
            FROM token_balances WHERE snapshot_id = ? ORDER BY value_usd DESC
        `).all(snap.id);
        const splTotal = tokens.reduce((s, t) => s + (t.value_usd > 0 ? t.value_usd : 0), 0);

        // SOL-Preis aus token_balances ableiten (SOL ist nicht in token_balances enthalten,
        // aber total_usd − usdc − splTokens = sol × solPrice → solPrice rückrechnen).
        // Fallback: snap.sol_balance > 0 ? (snap.total_usd − usdc − spl) / sol : 0
        const solPriceCalc = snap.sol_balance > 0
            ? Math.max(0, (snap.total_usd ?? 0) - (snap.usdc_balance ?? 0) - splTotal) / snap.sol_balance
            : 0;

        return {
            sol:          snap.sol_balance ?? 0,
            usdc:         snap.usdc_balance ?? 0,
            solPriceUsd:  solPriceCalc,
            splTokensUsd: splTotal,
            totalUsd:     snap.total_usd ?? 0,
            recordedAt:   snap.recorded_at,
            snapshot:     snap,    // voller Snapshot-Datensatz (für walletMonitor-Anzeige)
            tokens,                // token_balances-Details desselben Snapshots
        };
    } catch {
        return null;
    } finally {
        wmDb?.close();
    }
}

/**
 * Gibt den aktuellen USDC-Wert aller SPL-Whitelist-Token in der Wallet zurück.
 * SOL und USDC sind nicht enthalten (werden vom Bot direkt erfasst).
 *
 * @param {string} walletId  z.B. 'liquidity', 'sgb-sol', 'lending'
 * @returns {number}  Summe der Token-Werte in USDC (0 bei Fehler oder fehlendem Snapshot)
 */
export function getSplTokensUsd(walletId) {
    let wmDb;
    try {
        wmDb = new Database(WM_DB_PATH, { readonly: true, fileMustExist: true });

        const minTs = Date.now() - MAX_AGE_MS;
        const snap  = wmDb.prepare(`
            SELECT id FROM snapshots
            WHERE wallet_id = ? AND recorded_at >= ?
            ORDER BY recorded_at DESC LIMIT 1
        `).get(walletId, minTs);

        if (!snap) return 0;   // kein frischer Snapshot vorhanden

        const row = wmDb.prepare(`
            SELECT COALESCE(SUM(value_usd), 0) AS total
            FROM token_balances
            WHERE snapshot_id = ? AND value_usd > 0
        `).get(snap.id);

        return row?.total ?? 0;
    } catch {
        return 0;   // DB nicht vorhanden oder Lesefehler → silent fallback
    } finally {
        wmDb?.close();
    }
}

/**
 * Liest die Token-Balances aus dem letzten Snapshot einer Wallet.
 * Rückgabe: Array mit {symbol, mint, balance, priceUsd, valueUsd} – leer bei Fehler.
 * Wird genutzt um vorhandene SPL-Token-Daten beim manuellen Snapshot-Update zu erhalten.
 *
 * @param {string} walletId  z.B. 'liquidity'
 * @returns {Array<{symbol:string, mint:string, balance:number, priceUsd:number, valueUsd:number}>}
 */
export function getExistingTokenBalances(walletId) {
    let wmDb;
    try {
        wmDb = new Database(WM_DB_PATH, { readonly: true, fileMustExist: true });
        const snap = wmDb.prepare(
            'SELECT id FROM snapshots WHERE wallet_id = ? ORDER BY recorded_at DESC LIMIT 1'
        ).get(walletId);
        if (!snap) return [];
        return wmDb.prepare(
            'SELECT symbol, mint, balance, price_usd AS priceUsd, value_usd AS valueUsd FROM token_balances WHERE snapshot_id = ?'
        ).all(snap.id);
    } catch { return []; }
    finally { wmDb?.close(); }
}

/**
 * Schreibt einen frischen Wallet-Snapshot in wallet-monitor.db.
 * Aufruf vor syncDashboard() nach manuellen Operationen (deposit, withdraw)
 * damit export.js sofort aktuelle Wallet-Werte in data.json schreibt.
 *
 * @param {object} opts
 * @param {string}   opts.walletId      z.B. 'liquidity'
 * @param {string}   opts.walletLabel   z.B. 'Liquidity Bot'
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
