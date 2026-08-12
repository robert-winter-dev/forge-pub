/**
 * FORGE public Premium – Wallet für die Bezahlung des Premium-Service (FORK-ONLY)
 *
 * Getrennt von den Bot-Wallets (Liquidity/Lending): läge das Premium-Guthaben auf
 * einem Bot-Wallet, würde der Cleanup es automatisch in den nächsten Pool
 * investieren — eine zusätzliche Reserve-Logik dort wäre fehleranfällig
 * (Produktentscheidung 2026-07-29). Stattdessen ein eigenes, vom Installer
 * angelegtes Wallet mit einer kleinen Menge SOL + USDC, das ausschließlich für die
 * stündliche Premium-Zahlung genutzt wird.
 *
 * Existiert NUR auf einem FORGE-public-Fork — der Master zahlt nicht für sich selbst.
 * `core/premium/.env` auf dem Master hat kein `PREMIUM_WALLET_PATH` gesetzt (weil
 * bin/install.sh, das diesen Wert schreibt, nur auf einem Fork ausgeführt wird).
 * Jede Funktion hier liefert dann `null`/false statt zu werfen — Aufrufer
 * entscheiden selbst, ob das ein Fehler ist (Route zeigt „nicht verfügbar" statt
 * eines 500ers).
 *
 * Dateiformat identisch zu bots/liquidity/lib/wallet.js (Base58-String ODER
 * JSON-Array) — Installer/Backup-Workflows brauchen dadurch keinen Sonderfall.
 *
 * Balances werden über Nexus geholt (FORGE-Grundregel: kein Bot ruft Solana-RPC
 * direkt auf), analog core/wallet-monitor/monitor.js.
 */

import { readFileSync, existsSync } from 'fs';
import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Database from 'better-sqlite3';
import bs58 from 'bs58';
import { PATHS, envFile } from '../config/paths.js';
import { isAutoPayEnabled, isOutagePaused } from './premium-auto-pay-store.js';

const PREMIUM_ENV_PATH = envFile('premium');
const NEXUS_RPC = 'http://127.0.0.1:3100/rpc';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/**
 * Liest einen einzelnen Wert aus core/premium/.env. Derselbe dependency-freie
 * Zeilenparser wie in premium-identity-context.js (bewusst dupliziert statt
 * geteilt: beide Module sollen unabhängig voneinander funktionieren, auch wenn
 * eines künftig anders strukturiert wird).
 */
function readPremiumEnvVar(key) {
    if (!existsSync(PREMIUM_ENV_PATH)) return null;
    try {
        const raw = readFileSync(PREMIUM_ENV_PATH, 'utf8');
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            if (trimmed.slice(0, eq).trim() !== key) continue;
            let value = trimmed.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            return value.trim() || null;
        }
        return null;
    } catch {
        return null;
    }
}

/** Pfad zur Premium-Wallet-Keypair-Datei, oder null wenn nicht konfiguriert (Master). */
export function walletPath() {
    return readPremiumEnvVar('PREMIUM_WALLET_PATH');
}

export function walletExists() {
    const p = walletPath();
    return !!p && existsSync(p);
}

/**
 * Lädt das Premium-Wallet-Keypair. NIEMALS gecacht (anders als bots/liquidity/lib/
 * wallet.js) — dieses Modul läuft in kurzlebigen Skripten/Requests, kein
 * Dauerprozess, für den ein Cache einen Vorteil brächte.
 *
 * @returns {import('@solana/web3.js').Keypair|null} null wenn kein Wallet vorhanden.
 */
export function loadPremiumKeypair() {
    const p = walletPath();
    if (!p || !existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8').trim();
    try {
        if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
        return Keypair.fromSecretKey(bs58.decode(raw));
    } catch (err) {
        throw new Error(`Premium-Wallet-Datei (${p}) hat unbekanntes Format: ${err.message}`);
    }
}

export function getPremiumPublicKey() {
    return loadPremiumKeypair()?.publicKey.toBase58() ?? null;
}

/**
 * SOL- und USDC-Balance des Premium-Wallets.
 * @returns {Promise<{solBalance:number, usdcBalance:number}|null>} null wenn kein Wallet konfiguriert.
 */
export async function fetchPremiumBalances() {
    const pubkeyBase58 = getPremiumPublicKey();
    if (!pubkeyBase58) return null;

    const connection = new Connection(NEXUS_RPC, 'confirmed');
    const pubkey = new PublicKey(pubkeyBase58);
    const [lamports, tokenAccounts] = await Promise.all([
        connection.getBalance(pubkey, 'confirmed'),
        connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
    ]);

    let usdcBalance = 0;
    for (const { account } of tokenAccounts.value) {
        const info = account.data.parsed.info;
        if (info.mint === USDC_MINT) usdcBalance = info.tokenAmount.uiAmount ?? 0;
    }
    return { solBalance: lamports / LAMPORTS_PER_SOL, usdcBalance };
}

/**
 * Verbleibende Laufzeit des Premium-Service bei aktuellem USDC-Guthaben und Preis.
 * @returns {number|null} Stunden, oder null bei fehlenden/ungültigen Eingaben.
 */
export function remainingServiceHours(usdcBalance, priceUsdcPerHour) {
    if (!(usdcBalance >= 0) || !(priceUsdcPerHour > 0)) return null;
    return usdcBalance / priceUsdcPerHour;
}

/**
 * Deckungszustand des Premium-Zugriffs für die Dashboard-Anzeige (2026-07-29):
 * ist Auto-Pay an, und bis wann reicht die zuletzt tatsächlich bezahlte Stunde.
 *
 * `coveredUntilMs` ist bewusst KEIN Schätzwert aus Wallet-Guthaben/Preis (das
 * beantwortet nur „wie lange könnte ich mir das noch leisten", nicht „bis wann
 * kommen wirklich noch Daten") — bei deaktiviertem Auto-Pay wird unabhängig vom
 * Kontostand keine neue Stunde mehr bezahlt. Stattdessen die exakte, bereits
 * feststehende UTC-Stundengrenze aus der letzten echten Zahlung
 * (core/premium/premium-pay.js, Tabelle premium_pay_log, hourId-Konvention
 * siehe lib/premium-memo.js hourIdOf()).
 *
 * Rein lesend auf core/premium's premium.db — Konvention „nur SELECT auf fremde
 * DBs" (CLAUDE.md). Fehlt die Datei/Tabelle (Master zahlt nicht für sich selbst;
 * Fork vor der allerersten Zahlung), liefert coveredUntilMs null statt zu werfen.
 *
 * `outagePaused` unterscheidet die eine echte "vorübergehend nicht erreichbar"-
 * Ursache (core/premium/blob-health-check.js, Master/Netzwerk antwortet nicht)
 * von jedem anderen Grund für veraltete Daten — insbesondere fehlendem Guthaben
 * (core/premium/premium-pay.js schaltet dabei stattdessen `autoPayEnabled` ab,
 * setzt `outage_paused` aber nicht). Nur bei echtem `outagePaused` darf das
 * Dashboard "Premium Service ist derzeit nicht erreichbar" anzeigen.
 *
 * @returns {{ autoPayEnabled: boolean, coveredUntilMs: number|null, outagePaused: boolean }}
 */
export function getPremiumCoverage() {
    const autoPayEnabled = isAutoPayEnabled();
    const outagePaused = isOutagePaused();

    let coveredUntilMs = null;
    try {
        const db = new Database(PATHS.premiumDb, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare(`SELECT MAX(hour_id) AS maxHour FROM premium_pay_log`).get();
            if (row?.maxHour != null) coveredUntilMs = (row.maxHour + 1) * 3_600_000;
        } finally {
            db.close();
        }
    } catch {
        // Datei/Tabelle fehlt — keine Deckung, kein Fehlerfall.
    }

    return { autoPayEnabled, coveredUntilMs, outagePaused };
}

export function selfTest() {
    const failures = [];

    // Reine Rechenfunktion — unabhängig von Wallet-Existenz überall testbar.
    if (remainingServiceHours(1, 0.05) !== 20) failures.push('remainingServiceHours(1, 0.05) sollte 20 ergeben');
    if (remainingServiceHours(0, 0.05) !== 0) failures.push('remainingServiceHours(0, …) sollte 0 sein, nicht null (0 USDC ist ein gültiger, kritischer Wert)');
    if (remainingServiceHours(5, 0) !== null) failures.push('Preis 0 sollte null liefern (Division durch 0 vermeiden)');
    if (remainingServiceHours(-1, 0.05) !== null) failures.push('negativer Kontostand sollte null liefern');
    if (remainingServiceHours(5, null) !== null) failures.push('fehlender Preis sollte null liefern');

    // getPremiumCoverage(): auf DIESEM System (Master, kein premium.db mit echten
    // Zahlungen) muss coveredUntilMs sauber null liefern statt zu werfen.
    try {
        const cov = getPremiumCoverage();
        if (typeof cov.autoPayEnabled !== 'boolean') failures.push('getPremiumCoverage(): autoPayEnabled sollte boolean sein');
        if (typeof cov.outagePaused !== 'boolean') failures.push('getPremiumCoverage(): outagePaused sollte boolean sein');
        if (cov.coveredUntilMs !== null && !Number.isFinite(cov.coveredUntilMs)) {
            failures.push('getPremiumCoverage(): coveredUntilMs sollte null oder eine endliche Zahl sein');
        }
    } catch (err) {
        failures.push(`getPremiumCoverage() wirft: ${err.message}`);
    }

    // Auf DIESEM System (Master, kein PREMIUM_WALLET_PATH gesetzt) müssen alle
    // Wallet-Funktionen sauber null/false liefern statt zu werfen.
    if (walletExists()) failures.push('walletExists() ist true auf dem Master-Checkout – unerwartet');
    if (loadPremiumKeypair() !== null) failures.push('loadPremiumKeypair() liefert nicht null auf dem Master');
    if (getPremiumPublicKey() !== null) failures.push('getPremiumPublicKey() liefert nicht null auf dem Master');

    return { ok: failures.length === 0, failures };
}
