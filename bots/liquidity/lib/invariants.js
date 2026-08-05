/**
 * FORGE Liquidity – Code-Invarianten
 *
 * Statische Asserts über Modul-Konstanten. Werden geprüft:
 *   1. Beim Bot-Start (fail-fast in bin/bot.js)
 *   2. Stündlich via FORGE/bin/forge-check.js → Anomaly-Pipeline
 *
 * Hintergrund: 2026-05-08 hat ein USDC_MINT-Typ-Mismatch (PublicKey statt String)
 * einen Cleanup-Crash verursacht, weil die fehlerhafte Annahme erst Stunden nach
 * Bot-Start in einer SQLite-Bindung sichtbar wurde. Diese Datei macht solche
 * Annahmen explizit prüfbar.
 *
 * Erweiterung: bei jedem neu gefundenen stummen Bug eine neue Invariante
 * hier hinzufügen.
 */

import { PublicKey } from '@solana/web3.js';
import { USDC_MINT, USDC_MINT_KEY } from './wallet.js';

/** Wirft Error wenn eine Invariante verletzt ist. */
export function assertTypeInvariants() {
    const violations = [];

    // USDC_MINT muss String sein (für SQLite-Bind, Vergleiche, Jupiter-API).
    if (typeof USDC_MINT !== 'string') {
        violations.push(`USDC_MINT muss String sein, ist aber ${typeof USDC_MINT} (${USDC_MINT?.constructor?.name})`);
    }
    if (USDC_MINT !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
        violations.push(`USDC_MINT-Wert weicht ab: ${USDC_MINT}`);
    }

    // USDC_MINT_KEY muss PublicKey sein (für Solana-SDK).
    if (!(USDC_MINT_KEY instanceof PublicKey)) {
        violations.push(`USDC_MINT_KEY muss PublicKey sein, ist aber ${USDC_MINT_KEY?.constructor?.name}`);
    }
    if (USDC_MINT_KEY?.toBase58?.() !== USDC_MINT) {
        violations.push(`USDC_MINT_KEY ↔ USDC_MINT inkonsistent (${USDC_MINT_KEY?.toBase58?.()} vs. ${USDC_MINT})`);
    }

    if (violations.length > 0) {
        const msg = `Code-Invarianten verletzt:\n  - ${violations.join('\n  - ')}`;
        throw new Error(msg);
    }
}

/**
 * Sammelt Verletzungen statt zu werfen — für forge-check.js / Anomaly-Pipeline.
 * @returns {string[]} leere Liste = alles OK.
 */
export function checkTypeInvariants() {
    try {
        assertTypeInvariants();
        return [];
    } catch (err) {
        return err.message
            .split('\n')
            .filter(line => line.startsWith('  - '))
            .map(line => line.slice(4));
    }
}
