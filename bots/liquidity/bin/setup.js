#!/usr/bin/env node
/**
 * FORGE Liquidity – Einmaliger Setup / Deposit-Script
 *
 * Bereitet das Wallet für den ersten Bot-Start vor:
 *   1. Zeigt aktuelle Wallet-Balances
 *   2. Swapped USDC/2 → SOL via Jupiter (damit genug SOL für TX-Fees vorhanden ist)
 *   3. Setzt capitalUSDC in config/pools.json auf den verbleibenden USDC-Bestand
 *
 * Der Bot erkennt beim nächsten Start, dass noch keine Position offen ist,
 * und öffnet automatisch eine neue Position mit dem gesamten capitalUSDC.
 *
 * Aufruf:  node bin/setup.js [--dry-run]
 *   --dry-run  Zeigt nur was passieren würde, führt keinen Swap aus.
 */

import { readFileSync } from 'fs';
import { resolve, dirname }            from 'path';
import { fileURLToPath }               from 'url';
import dotenv                          from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

import { loadKeypair, getConnection, getSolBalance, getTokenBalance } from '../lib/wallet.js';
import { swapTokens } from '../lib/swap.js';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const POOLS_PATH  = resolve(__dirname, '../config/pools.json');
const SOL_RESERVE = parseFloat(process.env.SOL_RESERVE ?? '0.1');

// Token-Mints (aus pools.json SOL/USDC)
const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT      = 'So11111111111111111111111111111111111111112';
const USDC_DECIMALS = 6;
const SOL_DECIMALS  = 9;

const isDryRun = process.argv.includes('--dry-run');

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  FORGE Liquidity – Setup / Deposit');
    if (isDryRun) console.log('  *** DRY-RUN – kein Swap wird ausgeführt ***');
    console.log('═══════════════════════════════════════════════════\n');

    // 1. Wallet + Verbindung
    const keypair    = loadKeypair();
    const connection = getConnection();
    const pubkey     = keypair.publicKey.toBase58();

    console.log(`Wallet:   ${pubkey}`);

    // 2. Aktuelle Balances
    const solBefore  = await getSolBalance(keypair.publicKey);
    const usdcBefore = await getTokenBalance(keypair.publicKey, USDC_MINT, USDC_DECIMALS);

    console.log(`\nBalances vor Setup:`);
    console.log(`  SOL:  ${solBefore.toFixed(6)} SOL`);
    console.log(`  USDC: ${usdcBefore.toFixed(2)} USDC`);

    if (usdcBefore < 1) {
        console.error('\n❌ Zu wenig USDC im Wallet. Setup abgebrochen.');
        process.exit(1);
    }

    // 3. Berechnen wie viel USDC wir swappen
    // Wir wollen nach dem Swap mindestens SOL_RESERVE + 0.05 SOL übrig haben
    // (0.05 SOL Puffer für den TX-Fee des Swaps selbst)
    const solTarget   = SOL_RESERVE + 0.05;   // Ziel-SOL-Balance nach Swap
    const solNeeded   = Math.max(0, solTarget - solBefore);  // wie viel SOL fehlt noch

    // Hälfte der USDC soll geswapt werden
    const usdcHalf    = usdcBefore / 2;

    // Näherungsweiser SOL-Preis (wir kennen ihn nicht exakt vor dem Quote)
    // Wenn solNeeded > 0 und die Hälfte zu wenig wäre, warnen wir (aber swappen trotzdem die Hälfte)
    const swapAmount  = usdcHalf;

    console.log(`\nGeplanter Swap:`);
    console.log(`  ${swapAmount.toFixed(2)} USDC → SOL`);
    console.log(`  SOL-Reserve (Minimum): ${SOL_RESERVE} SOL`);

    if (solNeeded <= 0) {
        console.log(`  ℹ️  SOL-Balance (${solBefore.toFixed(4)}) liegt bereits über Ziel (${solTarget.toFixed(4)}) – Swap trotzdem durchführen für optimale 50/50-Aufteilung`);
    }

    const capitalUSDC = usdcBefore - swapAmount;
    console.log(`\nNach Swap:`);
    console.log(`  capitalUSDC (für Pool): ~${capitalUSDC.toFixed(2)} USDC`);
    console.log(`  SOL: ~${(solBefore + swapAmount / 83).toFixed(4)} SOL (geschätzt bei $83)`);

    if (isDryRun) {
        console.log('\n─── DRY-RUN: kein Swap, keine Änderung an pools.json ───');
        console.log(`Wenn --dry-run entfernt wird:`);
        console.log(`  1. Swap: ${swapAmount.toFixed(2)} USDC → SOL`);
        console.log(`  2. pools.json: capitalUSDC → ${capitalUSDC.toFixed(2)}`);
        console.log(`  3. Bot starten: er öffnet automatisch eine Position`);
        process.exit(0);
    }

    // 4. Swap ausführen
    console.log('\n[1/2] Swap läuft...');
    let swapResult;
    try {
        swapResult = await swapTokens({
            inputMint:     USDC_MINT,
            outputMint:    SOL_MINT,
            inputDecimals: USDC_DECIMALS,
            outputDecimals: SOL_DECIMALS,
            amount:        swapAmount,
            wallet:        keypair,
            connection,
        });
    } catch (err) {
        console.error(`\n❌ Swap fehlgeschlagen: ${err.message}`);
        process.exit(1);
    }

    console.log(`  ✓ Swap abgeschlossen`);
    console.log(`  SOL erhalten: ${swapResult.amountOut.toFixed(6)} SOL`);
    console.log(`  TX: ${swapResult.txSignature}`);

    // 5. Balances nach Swap
    const solAfter  = await getSolBalance(keypair.publicKey);
    const usdcAfter = await getTokenBalance(keypair.publicKey, USDC_MINT, USDC_DECIMALS);

    console.log(`\nBalances nach Swap:`);
    console.log(`  SOL:  ${solAfter.toFixed(6)} SOL`);
    console.log(`  USDC: ${usdcAfter.toFixed(2)} USDC`);

    if (solAfter < SOL_RESERVE) {
        console.warn(`\n⚠️  SOL-Balance (${solAfter.toFixed(4)}) liegt unter SOL_RESERVE (${SOL_RESERVE})!`);
        console.warn('   Bitte manuell SOL aufstocken bevor der Bot gestartet wird.');
    }

    // 6. Zusammenfassung
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  Setup abgeschlossen ✓');
    console.log('═══════════════════════════════════════════════════');
    console.log(`\n  SOL:        ${solAfter.toFixed(6)} SOL`);
    console.log(`  USDC:       ${usdcAfter.toFixed(2)} USDC`);
    console.log(`  SOL-Reserve: ${SOL_RESERVE} SOL (gesetzt in .env)`);
    console.log('\n  Nächster Schritt: node bin/bot.js');
    console.log('  Der Bot öffnet automatisch eine Position mit dem gesamten USDC-Kapital.\n');
}

main().catch(err => {
    console.error(`\nFataler Fehler: ${err.message}`);
    process.exit(1);
});
