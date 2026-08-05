/**
 * Einmaliges Skript: Schließt die aktuelle Position sauber (Fees claimen + Position schließen).
 * Der Bot öffnet beim nächsten Zyklus automatisch eine neue Position (Kapital aus letzter DB-Position).
 *
 * Verwendung:
 *   node bin/close-and-reopen.js                          – alle aktiven Pools
 *   node bin/close-and-reopen.js --pool liq-cbtc-wbtc   – nur einen Pool
 */

import { config }     from '../lib/config.js';
import {
    openDatabase, syncPools, getOpenPosition,
    closePosition, insertTransaction, insertFeeHistory, getPoolStats,
} from '../lib/db.js';
import { getAdapter } from '../lib/pool-adapter/index.js';
import { refreshAfterAction } from '../lib/refresh-state.js';
import {
    acquireManualLock, releaseManualLock,
    isCleanupRunning, isSlLocked, waitForBotToFinish,
} from '../lib/cleanup-lock.js';
import { collectFeesQuote, TickArrayUtil, PDAUtil, ORCA_WHIRLPOOL_PROGRAM_ID, NO_TOKEN_EXTENSION_CONTEXT, IGNORE_CACHE } from '@orca-so/whirlpools-sdk';

// ─── --help ────────────────────────────────────────────────────────────────
// Muss vor jedem Seiteneffekt (DB/Lock/Pool-Loop weiter unten) geprüft werden.
// Ohne diesen Check würde --help wie "kein --pool" behandelt und ALLE aktiven
// Pools schließen (poolFilter bleibt null → poolsToProcess = alle aktiven Pools).
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
FORGE Liquidity – Einmalig: Position(en) sauber schließen (bin/close-and-reopen.js)

Schließt die aktuelle Position sauber (Fees claimen + Position schließen).
Der Bot öffnet beim nächsten Zyklus automatisch eine neue Position (Kapital
aus der letzten DB-Position) – KEIN Dry-Run-Modus, jeder Aufruf führt echte
On-Chain-Transaktionen aus.

Ohne --pool werden ALLE aktiven Pools verarbeitet.

Aufruf: node bin/close-and-reopen.js
        node bin/close-and-reopen.js --pool <pool-id>   (nur diesen Pool)
        node bin/close-and-reopen.js --help             (dieser Text, kein Lauf)
`);
    process.exit(0);
}

const poolFilter = (() => {
    const idx = process.argv.indexOf('--pool');
    return idx !== -1 ? process.argv[idx + 1] : null;
})();

const db    = openDatabase();
syncPools(db, config.pools.all);

const poolsToProcess = poolFilter
    ? config.pools.active.filter(p => p.id === poolFilter)
    : config.pools.active;

if (poolFilter && poolsToProcess.length === 0) {
    console.error(`Kein aktiver Pool mit ID "${poolFilter}" gefunden.`);
    process.exit(1);
}

// Bot hat Vorrang: nicht gleichzeitig dieselbe Position mutieren. Erst warten bis
// der Bot mit Claim/Reinvest/Rebalancing fertig ist, dann Manual-Lock halten —
// damit der Bot währenddessen ausweicht (_yieldToManualAction). Release über den
// 'exit'-Handler deckt alle process.exit-Pfade ab.
if (isCleanupRunning()) { console.error('Cleanup läuft – bitte ~30 s warten und erneut versuchen.'); process.exit(1); }
if (isSlLocked())       { console.error('Stop-Loss/Take-Profit-Flow läuft – bitte warten.');          process.exit(1); }
if (!(await waitForBotToFinish())) {
    console.error('Bot ist gerade aktiv (Claim/Reinvest/Rebalance) – bitte in ~1 Min erneut versuchen.');
    process.exit(1);
}
acquireManualLock({ action: 'close-and-reopen', pool: poolFilter ?? 'all' });
process.on('exit', () => { try { releaseManualLock(); } catch { /* */ } });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(1));

for (const pool of poolsToProcess) {
    const position = getOpenPosition(db, pool.id);
    if (!position) {
        console.log(`[${pool.id}] Keine offene Position – überspringe.`);
        continue;
    }

    console.log(`[${pool.id}] Schließe Position ${position.nft_mint}...`);
    const adapter = getAdapter(pool);

    // 1. Pending Fees prüfen + claimen
    let state;
    try {
        state = await adapter.getPositionState(pool, position.nft_mint);
    } catch (err) {
        console.error(`[${pool.id}] getPositionState Fehler: ${err.message}`);
        process.exit(1);
    }

    if (state.feesOwedA > 0 || state.feesOwedB > 0) {
        console.log(`[${pool.id}] Fees claimen vor Close (${state.feesOwedA.toFixed(6)} TokenA, ${state.feesOwedB.toFixed(4)} TokenB)...`);
        try {
            const feeResult = await adapter.collectFees(pool, position.nft_mint);
            insertFeeHistory(db, {
                poolId:     pool.id,
                positionId: position.id,
                amountA:    feeResult.amountA,
                amountB:    feeResult.amountB,
                usdValue:   null,
                action:     'close',
                txHash:     feeResult.txHash,
            });
            console.log(`[${pool.id}] Fees geclaimed: TX=${feeResult.txHash}`);
        } catch (err) {
            console.warn(`[${pool.id}] Fee-Claim fehlgeschlagen (fahre fort): ${err.message}`);
        }
    } else {
        console.log(`[${pool.id}] Keine pending Fees.`);
    }

    // 2. Position schließen (oder als geschlossen markieren wenn Liquidität bereits 0)
    let closeTxHash;
    let closeAmountA = null, closeAmountB = null;
    try {
        const posState = await adapter.getPositionState(pool, position.nft_mint);
        const liquidityBN = BigInt(posState.liquidity ?? '0');

        if (liquidityBN === 0n) {
            // Liquidität bereits entfernt (vorheriger Lauf) — DB-Eintrag nachholen
            closeTxHash = '4ADFVJZYihhFmjVXNQAFDYJ8p4RrLRuvCfcKc7P6yWhRvYVAJMV85NQLGvCdu2ythb7cLns1AADf22nQME648TCz';
            console.log(`[${pool.id}] Liquidität bereits 0 — markiere als geschlossen (TX bekannt).`);
        } else {
            const closeResult = await adapter.closePosition(pool, position.nft_mint);
            closeTxHash = closeResult.txHash;
            closeAmountA = closeResult.amountA;
            closeAmountB = closeResult.amountB;
            console.log(`[${pool.id}] Position geschlossen: TX=${closeTxHash}`);
        }

        closePosition(db, position.id, closeTxHash);
        const closePrice    = getPoolStats(db, pool.id, 1)[0]?.price ?? null;
        const closeUsdValue = closePrice != null ? closeAmountA * closePrice + closeAmountB : null;
        insertTransaction(db, {
            poolId: pool.id, type: 'close_position',
            amountA: closeAmountA, amountB: closeAmountB, usdValue: closeUsdValue,
            txHash: closeTxHash, note: 'manual-deposit',
        });
    } catch (err) {
        console.error(`[${pool.id}] closePosition Fehler: ${err.message}`);
        process.exit(1);
    }
}

// Dashboard sofort aktualisieren: geschlossene Positionen sind in der DB markiert,
// Wallet-Tokens (aus Close + Fee-Claim) sind frisch on-chain. Pos-Snapshots werden
// für geschlossene Positionen nicht mehr aggregiert (writePortfolioSnapshot filtert
// closed_at IS NULL), die nächste Bot-Iteration schreibt für die neu eröffneten
// Positionen wieder Pos-Snapshots.
await refreshAfterAction(db);
db.close();
console.log('Fertig. Bot beim nächsten Zyklus eröffnet neue Position (Kapital aus letzter DB-Position).');
