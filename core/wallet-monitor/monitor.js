#!/usr/bin/env node
/**
 * FORGE Wallet Monitor
 *
 * Liest alle Bot-Wallets und speichert Snapshots in FORGE/data/wallet-monitor.db:
 *   - SOL-Balance
 *   - USDC-Balance
 *   - Whitelist-Token (cbBTC, ETH, EURC, ...) mit aktuellem Preis und USDC-Wert
 *   - Gesamtwert in USDC
 *
 * SPAM-Schutz: Nur Tokens aus config.json/tokens werden erfasst — alle anderen
 * SPL-Token (inkl. Airdrop-Spam) werden ignoriert.
 *
 * Neue Coins: Eintrag in config.json/tokens hinzufügen — fertig.
 *
 * Ausführung:  node core/wallet-monitor/monitor.js
 * Scheduling:  alle 10 Minuten via crontab oder systemd-Timer
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { getBotConfig }     from '../../lib/bot-registry.js';
import { isAutoPayEnabled } from '../../lib/premium-auto-pay-store.js';
import { PATHS } from '../../config/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = join(__dirname, '..', '..');

// ─── Konstanten ───────────────────────────────────────────────────────────────

const USDC_MINT         = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT         = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM     = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Warnschwelle = GENAU die Reserve, ab der der Bot aufhört Positionen zu eröffnen.
// Historie dieser Zahl, damit sie nicht wieder wandert:
//   bis 29.07.2026: 0,025 — unterhalb der Reserve, im Band 0,025–0,1 gab es also
//                   keine Warnung, obwohl der Bot dort längst eingeschränkt war.
//   29.07.2026:     0,12  — bewusst ÜBER die Reserve gelegt ("warnen solange noch
//                   Handlungsspielraum ist"). Ergebnis: Dauer-Fehlalarme, weil
//                   normale Kapitalbewegungen (SOL-Pair-Pools, Cleanup-Invest) das
//                   Wallet regulär auf ~0,11 ziehen — ein Zustand, in dem gar nichts
//                   kaputt ist. 17 Alerts in 48h auf forge-pub1.
//   30.07.2026:     0,10  — Betreiber-Vorgabe: gemeldet wird nur der Zustand, der
//                   tatsächlich eine Einschränkung bedeutet (= unter der Reserve).
// 🔒 Regel: Diese Schwelle NICHT über die Bot-Reserve (config SOL_RESERVE, Default
// 0,1) heben. Eine Warnung über der Reserve meldet Normalbetrieb als Störung.
const SOL_LOW_THRESHOLD = 0.10;    // SOL – unter diesem Wert → Telegram-Alert
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 Stunde – max. 1 Alert pro Wallet

// Premium-Wallet (FORGE.pub, wallet.id === 'premium') hat andere Regeln als die
// Bot-Wallets (Betreiber-Vorgabe 2026-07-30, siehe interne Doku
// payment.md „Premium-Wallet-Monitoring"): sie hält kein Bot-Kapital, ist an
// keinem Smart Contract beteiligt außer dem reinen USDC-Versand der stündlichen
// Selbstzahlung — ein SOL-Polster für ein paar Transaktionsgebühren reicht.
// Die Bot-Schwelle wäre hier bedeutungslos und hätte auf pub1 zu Dauer-Fehlalarmen
// geführt, obwohl die Wallet ihren Zweck noch problemlos erfüllen konnte.
const PREMIUM_SOL_LOW_THRESHOLD = 0.001; // SOL – reicht für einige Transaktionen

// Absender-Namen, die in der Bot-Registry zu technisch für eine Nutzer-Meldung sind.
// Die Registry-Namen ("Premium (Nostr-Identität, Message Center)") beschreiben den
// systemd-Dienst — im Message Center steht dort aber der ABSENDER einer Nachricht,
// und der soll ohne Vorwissen lesbar sein. Registry bleibt unangetastet, weil sie
// auch bin/svc und forge-check speist.
// "FORGE System" statt "FORGE Master" (2026-07-30): Auf einer Fork-Installation ist
// die premium-Wallet die, die AN den Master zahlt — nicht dessen eigene. "FORGE Master"
// hätte dort gelesen wie "der Master kann nicht zahlen". Der neutrale Name stimmt auf
// beiden Seiten, ohne die Meldung je nach Installation unterscheiden zu müssen.
const WALLET_NAME_OVERRIDES = {
    premium: 'FORGE System',
};

// ─── Config ───────────────────────────────────────────────────────────────────

const config = JSON.parse(
    readFileSync(join(__dirname, 'config.json'), 'utf8')
);

/**
 * Anzeigename des Bots, dem eine Wallet gehört — für die Absender-Zeile im
 * Message Center. Reihenfolge: `botName` aus config.json (explizite Vorgabe) →
 * Bot-Registry über die wallet.id → Wallet-Label als letzter Notnagel.
 * Kein eigener Namens-Katalog: die Registry (config/bots.json) bleibt die Quelle.
 */
function walletDisplayName(wallet) {
    if (wallet.botName) return wallet.botName;
    if (WALLET_NAME_OVERRIDES[wallet.id]) return WALLET_NAME_OVERRIDES[wallet.id];
    try { return getBotConfig(wallet.id).displayName; } catch { return wallet.label; }
}

/**
 * Ist der systemd-Service hinter dieser Wallet gerade aktiv? Wenn der Betreiber
 * einen Bot bewusst gestoppt hat (z.B. Settings → Stop), eröffnet er ohnehin keine
 * neuen Positionen mehr — eine SOL-niedrig-Warnung wäre dann falscher Alarm.
 * Prüfung schlägt "fail open" (true) fehl, wenn der Service-Status nicht ermittelt
 * werden kann, damit ein Defekt der Prüfung selbst keine echten Alerts verschluckt.
 */
function isBotServiceActive(walletId) {
    let service;
    try { service = getBotConfig(walletId).service; } catch { return true; }
    try {
        return execSync(`systemctl is-active ${service} 2>/dev/null`, { encoding: 'utf8' }).trim() === 'active';
    } catch (err) {
        const out = (err.stdout || '').toString().trim();
        return out ? out === 'active' : true;
    }
}

/** Whitelist-Mints als Set für schnelles Lookup */
const whitelistMints = new Set(config.tokens.map(t => t.mint));

/** Mint → Token-Metadaten */
const tokenByMint = Object.fromEntries(config.tokens.map(t => [t.mint, t]));

// ─── DB ───────────────────────────────────────────────────────────────────────

const db = new Database(PATHS.walletMonitorDb);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS sol_low_alerts (
        wallet_id      TEXT    PRIMARY KEY,
        last_alerted_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id      TEXT    NOT NULL,
        wallet_label   TEXT    NOT NULL,
        wallet_address TEXT    NOT NULL,
        recorded_at    INTEGER NOT NULL,
        sol_balance    REAL,
        usdc_balance   REAL,
        total_usd      REAL
    );

    CREATE TABLE IF NOT EXISTS token_balances (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        symbol      TEXT    NOT NULL,
        mint        TEXT    NOT NULL,
        balance     REAL,
        price_usd   REAL,
        value_usd   REAL
    );

    CREATE INDEX IF NOT EXISTS idx_snap_wallet_time ON snapshots(wallet_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tok_snap         ON token_balances(snapshot_id);
`);

// ─── Preise via Jupiter price/v3 (Batch, durch forge-api-proxy) ──────────────
//
// Ein einzelner Call für alle Tokens – kein Rate-Limit-Problem unabhängig von
// der Anzahl der konfigurierten Tokens.
//
async function fetchPrices() {
    const mints = [WSOL_MINT, ...config.tokens.map(t => t.mint)];
    const url   = `${config.jupPriceUrl}?ids=${mints.join(',')}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`price/v3 HTTP ${res.status}`);
    const data = await res.json();

    const prices = {};
    for (const mint of mints) {
        prices[mint] = data[mint]?.usdPrice ?? null;
    }
    return prices;
}

// ─── Wallet-Balances via RPC (durch forge-api-proxy) ─────────────────────────

const connection = new Connection(config.rpcUrl, 'confirmed');

async function fetchWalletSnapshot(walletAddress) {
    const pubkey = new PublicKey(walletAddress);

    // Alle drei Abfragen parallel – SOL + SPL-Token + Token-2022
    // Token-2022 (TokenzQd...) ist ein eigenes Program; getParsedTokenAccountsByOwner
    // mit programId=TOKEN_PROGRAM übersieht Token-2022-Accounts vollständig.
    const [lamports, tokenAccounts, token22Accounts] = await Promise.all([
        connection.getBalance(pubkey, 'confirmed'),
        connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM }),
        connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM }),
    ]);

    const solBalance = lamports / LAMPORTS_PER_SOL;
    let   usdcBalance = 0;
    const tokenBalances = {};   // mint → balance

    for (const { account } of [...tokenAccounts.value, ...token22Accounts.value]) {
        const info   = account.data.parsed.info;
        const mint   = info.mint;
        const amount = info.tokenAmount.uiAmount ?? 0;

        if (mint === USDC_MINT) {
            usdcBalance = amount;
        } else if (whitelistMints.has(mint)) {
            tokenBalances[mint] = amount;
        }
        // Alle anderen Mints (SPAM, unbekannte Airdrops) → ignoriert
    }

    return { solBalance, usdcBalance, tokenBalances };
}

// ─── DB-Statements ────────────────────────────────────────────────────────────

const stmtInsertSnapshot = db.prepare(`
    INSERT INTO snapshots
        (wallet_id, wallet_label, wallet_address, recorded_at, sol_balance, usdc_balance, total_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const stmtInsertToken = db.prepare(`
    INSERT INTO token_balances (snapshot_id, symbol, mint, balance, price_usd, value_usd)
    VALUES (?, ?, ?, ?, ?, ?)
`);

const stmtCleanup = db.prepare(`
    DELETE FROM snapshots
    WHERE recorded_at < ?
`);

// ─── Hauptlogik ───────────────────────────────────────────────────────────────

const now = Date.now();

// 1. Preise einmalig für alle Tokens holen
let prices = {};
try {
    prices = await fetchPrices();
    const lines = config.tokens.map(t => `${t.symbol}=${prices[t.mint]?.toFixed(4) ?? '—'}`);
    lines.unshift(`SOL=${prices[WSOL_MINT]?.toFixed(4) ?? '—'}`);
    console.log(`[wallet-monitor] Preise: ${lines.join(', ')}`);
} catch (err) {
    console.error(`[wallet-monitor] WARNUNG: Preise nicht abrufbar – ${err.message}`);
    console.error(`[wallet-monitor] Snapshot wird ohne Preisinformation gespeichert.`);
}

const solPrice = prices[WSOL_MINT] ?? null;

// Preise in zentrale prices.db schreiben (SOL/USDC + BTC/USDC für cbBTC)
const CBTC_MINT = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
try {
    const pricesDb = new Database(PATHS.pricesDb);
    pricesDb.pragma('journal_mode = WAL');
    pricesDb.exec(`
        CREATE TABLE IF NOT EXISTS price_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            pair        TEXT    NOT NULL,
            price       REAL    NOT NULL,
            source      TEXT    NOT NULL DEFAULT 'unknown',
            recorded_at INTEGER NOT NULL,
            UNIQUE(pair, recorded_at)
        );
    `);
    const stmtPrice = pricesDb.prepare(
        'INSERT OR IGNORE INTO price_history (pair, price, source, recorded_at) VALUES (?, ?, ?, ?)'
    );
    if (prices[WSOL_MINT]  != null) stmtPrice.run('SOL/USDC', prices[WSOL_MINT],  'wallet-monitor', now);
    if (prices[CBTC_MINT]  != null) stmtPrice.run('BTC/USDC', prices[CBTC_MINT],  'wallet-monitor', now);
    pricesDb.close();
    console.log(`[wallet-monitor] prices.db: SOL=${prices[WSOL_MINT]?.toFixed(2) ?? '—'}, BTC=${prices[CBTC_MINT]?.toFixed(2) ?? '—'}`);
} catch (err) {
    console.error(`[wallet-monitor] prices.db Fehler: ${err.message}`);
}

// 2. Pro Wallet: Balance lesen + in DB schreiben (sequenziell – Rate-Limit-freundlich)
let successCount = 0;
for (const wallet of config.wallets) {
    try {
        const { solBalance, usdcBalance, tokenBalances } = await fetchWalletSnapshot(wallet.address);

        // Gesamtwert summieren
        let totalUsd = usdcBalance;
        if (solPrice != null) totalUsd += solBalance * solPrice;

        // Token-Zeilen vorbereiten
        const tokenRows = config.tokens.map(token => {
            const balance  = tokenBalances[token.mint] ?? 0;
            const priceUsd = prices[token.mint] ?? null;
            const valueUsd = (priceUsd != null && balance > 0) ? balance * priceUsd : 0;
            if (priceUsd != null) totalUsd += valueUsd;
            return { symbol: token.symbol, mint: token.mint, balance, priceUsd, valueUsd };
        });

        // Alles in einer Transaktion schreiben
        const insertAll = db.transaction(() => {
            const result = stmtInsertSnapshot.run(
                wallet.id,
                wallet.label,
                wallet.address,
                now,
                solBalance,
                usdcBalance,
                Math.round(totalUsd * 100) / 100,
            );
            const snapshotId = result.lastInsertRowid;
            for (const row of tokenRows) {
                stmtInsertToken.run(
                    snapshotId,
                    row.symbol,
                    row.mint,
                    row.balance,
                    row.priceUsd,
                    row.valueUsd != null ? Math.round(row.valueUsd * 100) / 100 : null,
                );
            }
        });
        insertAll();

        // SOL-Low-Alert (max. 1× pro Stunde pro Wallet)
        const isPremiumWallet = wallet.id === 'premium';
        const solLowThreshold = isPremiumWallet ? PREMIUM_SOL_LOW_THRESHOLD : SOL_LOW_THRESHOLD;
        // Premium (core/premium, systemd forge-premium) läuft bewusst IMMER, auch für
        // das Message Center — der systemd-Status ist hier also kein Signal. Was zählt,
        // ist ob premium-pay.js überhaupt eine Zahlung versuchen würde: dieselbe Quelle
        // (lib/premium-auto-pay-store.js), die auch dort geprüft wird, siehe a81bff7c
        // (Zahlung an Liquidity-Bot-Status gekoppelt). Alles andere prüft weiter den
        // eigenen systemd-Service.
        const botActive = isPremiumWallet ? isAutoPayEnabled() : isBotServiceActive(wallet.id);
        if (solBalance < solLowThreshold && !botActive) {
            console.log(`[wallet-monitor] SOL niedrig: ${wallet.label} (${solBalance.toFixed(4)} SOL) – Premium-Zahlung/Bot gestoppt, Alert unterdrückt`);
        } else if (solBalance < solLowThreshold) {
            const lastAlert = db.prepare(
                'SELECT last_alerted_at FROM sol_low_alerts WHERE wallet_id = ?'
            ).get(wallet.id);
            const elapsed = lastAlert ? now - lastAlert.last_alerted_at : Infinity;
            if (elapsed >= ALERT_COOLDOWN_MS) {
                db.prepare(`
                    INSERT INTO sol_low_alerts (wallet_id, last_alerted_at)
                    VALUES (?, ?)
                    ON CONFLICT(wallet_id) DO UPDATE SET last_alerted_at = excluded.last_alerted_at
                `).run(wallet.id, now);
                // Text-Vorgabe 2026-07-30: keine Warnschwellen-Zahl mehr
                // (verwirrt, wenn sie mit der Reserve identisch ist), kein Wallet-Label
                // im Fließtext (der betroffene Bot steht jetzt als eigene Kopfzeile im
                // Message Center, siehe displayName unten) — und ein Schlusssatz, der
                // sagt was zu TUN ist, inklusive der Option einfach abzuwarten.
                const alertMessage = isPremiumWallet
                    ? `SOL-Reserve beträgt aktuell ${solBalance.toFixed(4)} SOL. ` +
                      `Ohne SOL kann die stündliche Premium-Zahlung nicht mehr gesendet werden ` +
                      `und der Premium-Datenbezug endet.\n` +
                      `Bitte Wallet mit mindestens 0,15 SOL aufladen. Der Bot läuft weiter, nur ohne Premium-Daten.`
                    : `SOL-Reserve beträgt aktuell ${solBalance.toFixed(4)} SOL. ` +
                      `Unter 0,1 SOL werden keine neuen Positionen mehr eröffnet.\n` +
                      `Bitte Wallet mit mindestens 0,15 SOL aufladen oder warten, bis sich der SOL Bestand wieder erholt.`;
                try {
                    await fetch(config.notifyUrl, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            botId:    'wallet-monitor',
                            // Nicht der Absender, sondern der BETROFFENE Bot: ein
                            // wallet-monitor überwacht mehrere Wallets, "wallet-monitor"
                            // als Absender sagt dem Nutzer nicht, welcher Bot gemeint ist.
                            displayName: walletDisplayName(wallet),
                            level:    'error',
                            category: 'sol_low',
                            message:  alertMessage,
                        }),
                    });
                    console.log(`[wallet-monitor] SOL-Alert gesendet: ${wallet.label} (${solBalance.toFixed(4)} SOL)`);
                } catch (err) {
                    console.error(`[wallet-monitor] SOL-Alert fehlgeschlagen: ${err.message}`);
                }
            } else {
                const remainMin = Math.ceil((ALERT_COOLDOWN_MS - elapsed) / 60_000);
                console.log(`[wallet-monitor] SOL niedrig: ${wallet.label} (${solBalance.toFixed(4)} SOL) – Alert throttled, nächster in ${remainMin} min`);
            }
        }

        // Konsolenausgabe
        const tokenInfo = tokenRows
            .filter(r => r.balance > 0)
            .map(r => `${r.symbol}=${r.balance.toPrecision(4)}(≈${r.valueUsd?.toFixed(2) ?? '?'} USDC)`)
            .join(', ');
        console.log(
            `[wallet-monitor] ${wallet.label}: ` +
            `SOL=${solBalance.toFixed(4)}, USDC=${usdcBalance.toFixed(2)}` +
            (tokenInfo ? `, ${tokenInfo}` : '') +
            `, Gesamt≈${totalUsd.toFixed(2)} USDC`
        );

        successCount++;
    } catch (err) {
        console.error(`[wallet-monitor] FEHLER ${wallet.label}: ${err.message}`);
    }
}

// 3. Alte Snapshots aufräumen (> retainDays Tage)
const cutoff = now - config.retainDays * 24 * 60 * 60 * 1000;
const deleted = stmtCleanup.run(cutoff);
if (deleted.changes > 0) {
    console.log(`[wallet-monitor] Cleanup: ${deleted.changes} alte Snapshots entfernt (>${config.retainDays} Tage)`);
}

db.close();
console.log(`[wallet-monitor] Fertig. ${successCount}/${config.wallets.length} Wallets erfasst.`);
