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
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { getBotConfig }     from '../../lib/bot-registry.js';
import { isAutoPayEnabled } from '../../lib/premium-auto-pay-store.js';
import { PATHS } from '../../config/paths.js';
import { renderNotification } from '../../lib/notify-render.js';
import { getLang } from '../../lib/i18n.js';
import { fetchTokenSignals, classify, buildKnownTokens } from '../../lib/scam-classify.js';
import { LOCAL_SERVER } from '../../config/health-config.js';
import { rpcCallerHeaders } from '../../lib/rpc-caller.js';

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

// Bestätigungsfenster vor dem ersten Alert (Befund 2026-08-25): Ein einzelner
// teurer Vorgang (Rebalancing/Open/Close) kann den SOL-Stand in einem Schritt
// von "gesund" auf < SOL_LOW_THRESHOLD reißen — noch bevor der nächste
// Bot-Zyklus (CHECK_INTERVAL_MS, Liquidity-Bot Default 5 Min) die eingebaute
// Selbstheilung (ensureWalletSol(), lib/sol-topup.js) auslösen konnte. Traf der
// 10-minütige wallet-monitor-Lauf genau dieses Fenster, meldete er einen Zustand,
// der 1-2 Minuten später schon wieder behoben war (Master 25.08.2026: Alerts um
// 04:05:48/13:05:48/19:05:47/20:05:51, jeweils gefolgt von einem Topup-Erfolg im
// Bot-Log binnen einer Minute) — genau die Störung, die dieser Alert eigentlich
// NICHT melden soll ("nur wenn keine Selbstheilung möglich ist").
// Ein niedriger Stand muss deshalb über dieses Fenster hinweg bestehen bleiben,
// bevor überhaupt in die Cooldown-Logik gegangen wird. 7 Minuten > 5-Minuten-
// Bot-Zyklus mit Puffer; ein echtes "keine Selbstheilung möglich" bleibt über
// den nächsten 10-Minuten-Lauf hinweg ohnehin low und wird weiterhin gemeldet,
// nur um bis zu einem Zyklus (~10 Min) später als bisher.
const SOL_LOW_CONFIRM_MS = 7 * 60 * 1000;

// Premium-Wallet (FORGE public, wallet.id === 'premium') hat andere Regeln als die
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

    CREATE TABLE IF NOT EXISTS sol_low_streak (
        wallet_id  TEXT    PRIMARY KEY,
        low_since  INTEGER NOT NULL
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

    -- Unbekannte Token-Konten (nicht auf der Whitelist, Balance > 0).
    --
    -- Diese Mints wurden bisher beim Snapshot eingesammelt und sofort weggeworfen.
    -- Für den Reiter "Auffällig" in den Einstellungen werden sie stattdessen
    -- festgehalten — das kostet KEINEN zusätzlichen RPC-Call, die Konten stehen
    -- ohnehin in der Antwort von getParsedTokenAccountsByOwner.
    --
    -- Der Zustand wird pro (wallet_id, mint) fortgeschrieben statt je Snapshot neu
    -- angelegt: first_seen ist die Information, die zählt (seit wann liegt das Ding
    -- da), und die Tabelle bleibt klein genug, um sie ohne Aufräumjob zu führen.
    CREATE TABLE IF NOT EXISTS unknown_tokens (
        wallet_id   TEXT    NOT NULL,
        mint        TEXT    NOT NULL,
        balance     REAL    NOT NULL,
        price_usd   REAL,
        -- Beide Felder kommen ohne Zusatzkosten aus derselben Jupiter-Antwort wie der
        -- Preis. Für die Beurteilung eines unbekannten Tokens sind sie wertvoller als
        -- der Preis: ein wenige Stunden alter Mint mit vierstelliger Liquidität ist ein
        -- Airdrop, ein 2024er Mint mit dreistelliger Millionen-Liquidität nicht.
        created_at  TEXT,
        liquidity   REAL,
        -- Ebenfalls aus derselben Antwort (tokens/v2/search), ebenfalls gratis.
        -- holder_count ist reine ANZEIGE — die überzeugendste Zahl für den Menschen
        -- (26 Holder gegen 168.748 beim echten Fartcoin), als Automatik-Kriterium
        -- aber untauglich: der Angreifer treibt sie hoch, indem er weiter verteilt.
        -- Die Entscheidung trifft jupiterScamVerdict() aus is_sus/organic/verified.
        holder_count        INTEGER,
        organic_score_label TEXT,
        is_verified         INTEGER,
        is_sus              INTEGER,
        -- Empfangs-Transaktion: die älteste Signatur des Token-KONTOS ist der Vorgang,
        -- mit dem der Token ins Wallet kam. Unveränderlich, deshalb genau einmal je
        -- Konto abgefragt und danach nie wieder. Für einen Laien ist "am 19.08. von
        -- einer unbekannten Adresse geschickt bekommen" die verständlichste Evidenz,
        -- die wir überhaupt anbieten können.
        received_sig TEXT,
        received_at  INTEGER,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        PRIMARY KEY (wallet_id, mint)
    );

    -- Metadaten-Cache je Mint. Symbol und Name eines Mints ändern sich praktisch
    -- nie, die Abfrage (Helius DAS getAsset) kostet aber jedes Mal einen Credit.
    -- Ohne diesen Cache fragte forge-check.js sie stündlich neu ab: 79 Aufrufe
    -- allein zwischen dem 17. und 19.08.2026, Trefferquote 0 %.
    -- Bewusst OHNE wallet_id — ein Mint ist global, nicht pro Wallet.
    CREATE TABLE IF NOT EXISTS token_meta (
        mint       TEXT PRIMARY KEY,
        symbol     TEXT,
        name       TEXT,
        fetched_at INTEGER NOT NULL
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

// Nachrüsten für DBs, die unknown_tokens vor created_at/liquidity angelegt haben.
// Kein Migrationsskript nötig: ADD COLUMN ist billig und die Tabelle ist tagesjung.
for (const col of [['created_at', 'TEXT'], ['liquidity', 'REAL'], ['received_sig', 'TEXT'], ['received_at', 'INTEGER'],
                   ['holder_count', 'INTEGER'], ['organic_score_label', 'TEXT'],
                   ['is_verified', 'INTEGER'], ['is_sus', 'INTEGER']]) {
    const exists = db.prepare("SELECT 1 FROM pragma_table_info('unknown_tokens') WHERE name = ?").get(col[0]);
    if (!exists) db.exec(`ALTER TABLE unknown_tokens ADD COLUMN ${col[0]} ${col[1]}`);
}

// ─── Token-Metadaten via Helius DAS (durch Nexus) ────────────────────────────
//
// Wird NUR für Mints aufgerufen, die noch nicht in token_meta stehen — Symbol und
// Name eines Mints sind praktisch unveränderlich. Das Ergebnis wird persistent
// gecacht und überlebt damit auch einen Nexus-Neustart (dessen In-Memory-Cache
// nicht).
async function fetchAssetMeta(mint) {
    try {
        const res = await fetch(config.rpcUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        const md   = json?.result?.content?.metadata;
        return md ? { symbol: md.symbol ?? null, name: md.name ?? null } : null;
    } catch { return null; }
}

// ─── Empfangs-Transaktion eines Token-Kontos ─────────────────────────────────
//
// Die ÄLTESTE Signatur des Kontos ist der Vorgang, mit dem der Token ankam (das Konto
// entsteht erst mit dem Empfang). Wird nur einmal je Konto abgefragt und dann dauerhaft
// gespeichert — der Wert kann sich nicht mehr ändern.
//
// Grenze bewusst in Kauf genommen: bei mehr als `limit` Transaktionen wäre die älteste
// hier nicht die tatsächlich erste. Für einen unaufgefordert zugeschickten Token ist das
// praktisch nie der Fall (der geprüfte Airdrop hatte genau eine Signatur); Paginierung
// dafür kostete pro Token weitere Calls, ohne die Aussage zu verbessern.
async function fetchReceiveTx(account) {
    try {
        const res = await fetch(config.rpcUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
                params: [account, { limit: 100 }],
            }),
        });
        if (!res.ok) return null;
        const sigs = (await res.json())?.result ?? [];
        if (sigs.length === 0) return null;
        const oldest = sigs[sigs.length - 1];
        return {
            signature: oldest.signature ?? null,
            at:        oldest.blockTime ? oldest.blockTime * 1000 : null,
        };
    } catch { return null; }
}

// ─── Wallet-Balances via RPC (durch forge-api-proxy) ─────────────────────────
//
// /rpc/fresh statt /rpc: der Nexus-Proxy cached getParsedTokenAccountsByOwner
// 60s (core/nexus/rpc-cache.js). close-scam-tokens.js scannt die Wallet über
// denselben Endpunkt unmittelbar vor einem Burn (Kandidatensuche), füllt den
// Cache also mit dem Vor-Burn-Zustand. Läuft dieser Refresh (der genau diesen
// Snapshot nach dem Burn neu einliest) innerhalb der TTL, bekäme er sonst exakt
// diesen veralteten Stand zurück — der verbrannte Token bliebe fälschlich in
// unknown_tokens stehen, die Auffällig-Badge zeigt weiter (1). Analog zu
// getConnectionFresh() in bots/liquidity/lib/wallet.js.
const connection = new Connection(config.rpcUrl.replace(/\/rpc$/, '/rpc/fresh'), { commitment: 'confirmed', httpHeaders: rpcCallerHeaders() });

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
    const tokenBalances  = {};   // mint → balance (Whitelist)
    const unknownTokens  = {};   // mint → balance (alles andere mit Balance > 0)

    for (const { account, pubkey } of [...tokenAccounts.value, ...token22Accounts.value]) {
        const info   = account.data.parsed.info;
        const mint   = info.mint;
        const amount = info.tokenAmount.uiAmount ?? 0;

        if (mint === USDC_MINT) {
            usdcBalance = amount;
        } else if (whitelistMints.has(mint)) {
            tokenBalances[mint] = amount;
        } else if (amount > 0) {
            // Früher verworfen. Jetzt festgehalten: das ist die Datengrundlage für
            // den Reiter "Auffällig" — ohne einen einzigen zusätzlichen RPC-Call,
            // die Konten stehen bereits in der Antwort oben.
            //
            // Die Konto-Adresse (pubkey) wird mitgeführt, weil die Empfangs-Transaktion
            // an ihr hängt, nicht am Mint: die älteste Signatur DIESES Kontos ist der
            // Vorgang, mit dem der Token ins Wallet kam.
            unknownTokens[mint] = {
                balance: (unknownTokens[mint]?.balance ?? 0) + amount,
                account: pubkey?.toString?.() ?? String(pubkey ?? ''),
            };
        }
    }

    return { solBalance, usdcBalance, tokenBalances, unknownTokens };
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
const unknownByWallet = new Map();   // wallet_id → { mint: balance }
for (const wallet of config.wallets) {
    try {
        const { solBalance, usdcBalance, tokenBalances, unknownTokens } = await fetchWalletSnapshot(wallet.address);
        unknownByWallet.set(wallet.id, unknownTokens);

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
        let confirmedLow = false;
        if (solBalance < solLowThreshold && !botActive) {
            console.log(`[wallet-monitor] SOL niedrig: ${wallet.label} (${solBalance.toFixed(4)} SOL) – Premium-Zahlung/Bot gestoppt, Alert unterdrückt`);
            db.prepare('DELETE FROM sol_low_streak WHERE wallet_id = ?').run(wallet.id);
        } else if (solBalance < solLowThreshold) {
            const streak = db.prepare(
                'SELECT low_since FROM sol_low_streak WHERE wallet_id = ?'
            ).get(wallet.id);
            const lowSince = streak?.low_since ?? now;
            if (!streak) {
                db.prepare(`
                    INSERT INTO sol_low_streak (wallet_id, low_since) VALUES (?, ?)
                    ON CONFLICT(wallet_id) DO UPDATE SET low_since = excluded.low_since
                `).run(wallet.id, now);
            }
            const lowElapsed = now - lowSince;
            confirmedLow = lowElapsed >= SOL_LOW_CONFIRM_MS;
            if (!confirmedLow) {
                const remainSec = Math.ceil((SOL_LOW_CONFIRM_MS - lowElapsed) / 1000);
                console.log(`[wallet-monitor] SOL niedrig: ${wallet.label} (${solBalance.toFixed(4)} SOL) – im Selbstheil-Bestätigungsfenster, Alert erst in ${remainSec}s falls weiter niedrig`);
            }
        } else {
            db.prepare('DELETE FROM sol_low_streak WHERE wallet_id = ?').run(wallet.id);
        }

        if (confirmedLow) {
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
                //
                // msgKey statt fertigem Text (Schritt 5 der Mehrsprachigkeit, siehe
                // lib/notify-render.js): vorher schickte dieser Alert rohen deutschen
                // Fließtext an /notify, der auf einer EN-Installation trotzdem deutsch
                // blieb — der zentrale Notify-Endpoint macht msgKey nicht zur Pflicht,
                // fehlt er, wird `message` unverändert durchgereicht.
                const msgKey       = isPremiumWallet ? 'notify.wm.sol_low_premium' : 'notify.wm.sol_low';
                const displayName  = walletDisplayName(wallet);
                const params       = { sol: solBalance.toFixed(4) };
                const message = renderNotification(
                    { msgKey, params, displayName, timestamp: now },
                    getLang(),
                );
                try {
                    await fetch(config.notifyUrl, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            botId:    'wallet-monitor',
                            // Nicht der Absender, sondern der BETROFFENE Bot: ein
                            // wallet-monitor überwacht mehrere Wallets, "wallet-monitor"
                            // als Absender sagt dem Nutzer nicht, welcher Bot gemeint ist.
                            displayName,
                            level:    'error',
                            category: 'sol_low',
                            message, msgKey, params,
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

// 2b. Unbekannte Token festhalten (Datengrundlage für den Reiter "Auffällig")
//
// Kostenbild, bewusst so gebaut:
//   Token-Liste  – 0 zusätzliche Calls, steht oben schon in der RPC-Antwort
//   Metadaten    – 1 Helius-DAS-Call pro ERSTMALIG gesehenem Mint, danach nie wieder
//   Jupiter-Preis– 1 Batch-Call pro Lauf, und nur solange überhaupt etwas Unbekanntes
//                  im Wallet liegt. Im Normalfall (sauberes Wallet) also gar keiner.
//
// Der Preis wird bewusst JEDEN Lauf neu geholt statt einmalig beim ersten Sehen:
// er entscheidet über die Stufe REVIEW (Imitat MIT Wert, Abtipp-Hürde) gegenüber
// BURN (Imitat ohne Wert, einfache Rückfrage). Ein eingefrorener Null-Preis würde
// ein wertvolles Imitat dauerhaft als harmlos einstufen — das ist genau die
// Richtung, in die man nicht irren darf. Ein Call alle 10 Minuten, und nur während
// einer laufenden Airdrop-Welle, ist dafür der richtige Preis.
try {
    const allUnknownMints = [...new Set(
        [...unknownByWallet.values()].flatMap(m => Object.keys(m))
    )];

    // Bereits bekannte Empfangs-Transaktionen — was hier steht, wird nie neu geholt.
    const knownReceives = new Map(
        db.prepare('SELECT wallet_id, mint, received_sig, received_at FROM unknown_tokens WHERE received_sig IS NOT NULL')
          .all().map(r => [`${r.wallet_id}::${r.mint}`, { signature: r.received_sig, at: r.received_at }])
    );

    if (allUnknownMints.length > 0) {
        console.log(`[wallet-monitor] ${allUnknownMints.length} unbekannte Mint(s) – Metadaten/Preis prüfen…`);

        // Metadaten nur für Mints holen, die wir noch nie gesehen haben.
        const cachedMints = new Set(
            db.prepare('SELECT mint FROM token_meta').all().map(r => r.mint)
        );
        const newMints = allUnknownMints.filter(m => !cachedMints.has(m));
        const stmtMeta = db.prepare(`
            INSERT INTO token_meta (mint, symbol, name, fetched_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, fetched_at = excluded.fetched_at
        `);
        for (const mint of newMints) {
            const meta = await fetchAssetMeta(mint);
            stmtMeta.run(mint, meta?.symbol ?? null, meta?.name ?? null, now);
            console.log(`[wallet-monitor]   neuer Mint ${mint.slice(0, 12)}… → ${meta?.symbol ?? '?'}`);
        }

        // tokens/v2/search statt price/v3: derselbe eine Call, aber zusätzlich die
        // Felder, mit denen sich ein Airdrop überhaupt beurteilen lässt.
        const unknownPrices = await fetchTokenSignals(
            config.jupTokenSearchUrl ?? 'http://127.0.0.1:3100/jup/tokens/v2/search',
            allUnknownMints,
        );

        // Empfangs-Transaktion nur für Paare holen, die wir noch nicht kennen.
        const receives = new Map(knownReceives);
        for (const [walletId, mints] of unknownByWallet) {
            for (const [mint, entry] of Object.entries(mints)) {
                const key = `${walletId}::${mint}`;
                if (receives.has(key) || !entry.account) continue;
                const rcv = await fetchReceiveTx(entry.account);
                if (rcv?.signature) receives.set(key, rcv);
            }
        }

        // Vor dem Upsert merken, welche (wallet_id, mint)-Paare schon bekannt sind —
        // nur was hier fehlt, ist in diesem Lauf neu und potenziell eine System-
        // Message wert (Datengrundlage für den Reiter "Auffällig", siehe oben).
        const existingPairs = new Set(
            db.prepare('SELECT wallet_id, mint FROM unknown_tokens').all()
              .map(r => `${r.wallet_id}::${r.mint}`)
        );
        const metaByMint = new Map(
            db.prepare('SELECT mint, symbol, name FROM token_meta').all()
              .map(r => [r.mint, { symbol: r.symbol, name: r.name }])
        );

        const stmtUnknown = db.prepare(`
            INSERT INTO unknown_tokens
                (wallet_id, mint, balance, price_usd, created_at, liquidity,
                 holder_count, organic_score_label, is_verified, is_sus,
                 received_sig, received_at, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(wallet_id, mint) DO UPDATE SET
                balance      = excluded.balance,
                price_usd    = excluded.price_usd,
                created_at   = excluded.created_at,
                liquidity    = excluded.liquidity,
                holder_count        = excluded.holder_count,
                organic_score_label = excluded.organic_score_label,
                is_verified         = excluded.is_verified,
                is_sus              = excluded.is_sus,
                -- Nie überschreiben: der Empfang liegt in der Vergangenheit und ist
                -- unveränderlich. Ein fehlgeschlagener Abruf darf einen bereits
                -- gespeicherten Wert nicht auf NULL zurücksetzen.
                received_sig = COALESCE(excluded.received_sig, unknown_tokens.received_sig),
                received_at  = COALESCE(excluded.received_at,  unknown_tokens.received_at),
                last_seen    = excluded.last_seen
        `);
        const stmtDropWallet = db.prepare('DELETE FROM unknown_tokens WHERE wallet_id = ?');

        db.transaction(() => {
            for (const [walletId, mints] of unknownByWallet) {
                // Verschwundene Mints (bereinigt oder weitergeschickt) müssen raus,
                // sonst zeigt die Oberfläche dauerhaft Token an, die es nicht mehr gibt.
                // Nur für Wallets, die in DIESEM Lauf erfolgreich gelesen wurden —
                // sonst würde ein RPC-Fehler die Liste fälschlich leeren.
                stmtDropWallet.run(walletId);
                for (const [mint, entry] of Object.entries(mints)) {
                    const jup = unknownPrices[mint];
                    const rcv = receives.get(`${walletId}::${mint}`) ?? null;
                    stmtUnknown.run(
                        walletId, mint, entry.balance,
                        jup?.price ?? null, jup?.createdAt ?? null, jup?.liquidity ?? null,
                        jup?.holderCount ?? null, jup?.organicScoreLabel ?? null,
                        // SQLite kennt kein BOOLEAN — und `null` heißt hier "Jupiter
                        // kennt den Mint nicht", was etwas anderes ist als `false`.
                        jup ? (jup.isVerified ? 1 : 0) : null,
                        jup ? (jup.isSus ? 1 : 0) : null,
                        rcv?.signature ?? null, rcv?.at ?? null,
                        now, now,
                    );
                }
            }
        })();

        // Neu gefundene Scam-/Imitat-Token per System-Message melden — Ersatz für den
        // früheren Weg über forge-check.js/anomaly-sync.js (Ticket pro Welle). Der
        // Reiter "Auffällig" (Settings > Wallet) ist jetzt die eigentliche Anzeige;
        // diese Meldung ist nur der aktive Hinweis, dass dort etwas Neues liegt.
        //
        // Dieselbe Einstufung wie die Oberfläche (lib/scam-classify.js) — nur BURN/
        // REVIEW gelten als scam-artig genug für eine Meldung, WARN/SKIP nicht (siehe
        // Doku dort). Pool-Token und Positions-NFTs fallen über die volle Whitelist
        // (buildKnownTokens, inkl. Positions-DB) raus, nicht nur über config.json —
        // sonst würde eine frisch eröffnete Position als Scam-Fund gemeldet.
        try {
            const whitelistByWallet = new Map();
            const getWalletWhitelist = walletId => {
                if (!whitelistByWallet.has(walletId)) {
                    whitelistByWallet.set(walletId, buildKnownTokens({
                        forgeRoot:   FORGE_ROOT,
                        positionsDb: walletId === 'liquidity' ? PATHS.liquidityDb : null,
                        deps:        { readFileSync, existsSync, Database },
                    }));
                }
                return whitelistByWallet.get(walletId);
            };

            const findsByWallet = new Map(); // wallet_id → [{ label, dupSymbol, value }]
            for (const [walletId, mints] of unknownByWallet) {
                const { mints: knownMints, symbols: knownSymbols } = getWalletWhitelist(walletId);
                for (const [mint, entry] of Object.entries(mints)) {
                    if (existingPairs.has(`${walletId}::${mint}`)) continue; // schon bekannt
                    if (knownMints.has(mint)) continue; // Pool-Token/Positions-NFT, kein Fund
                    const meta = metaByMint.get(mint) ?? { symbol: null, name: null };
                    // Volle Signale durchreichen, nicht nur den Preis: sonst sieht die
                    // Meldung eine andere Stufe als die Oberfläche.
                    const cl = classify(
                        { uiAmount: entry.balance, meta },
                        unknownPrices[mint] ?? null,
                        knownSymbols,
                    );
                    if (cl.tier !== 'BURN' && cl.tier !== 'REVIEW') continue;
                    if (!findsByWallet.has(walletId)) findsByWallet.set(walletId, []);
                    findsByWallet.get(walletId).push({
                        label: meta.symbol ?? meta.name ?? `${mint.slice(0, 8)}…`,
                        dupSymbol: cl.dupSymbol,
                        susReason: cl.susReason,
                        value: cl.value,
                    });
                }
            }

            for (const [walletId, finds] of findsByWallet) {
                const wallet = config.wallets.find(w => w.id === walletId);
                if (!wallet) continue;
                // Der Grund steht jetzt nicht mehr zwingend fest: seit dem
                // Jupiter-Urteil kann ein Fund auffällig sein, OHNE ein bekanntes
                // Token zu imitieren. „Imitat von null“ wäre die Folge gewesen.
                const list = finds
                    .map(f => {
                        const why = f.dupSymbol
                            ? `Imitat von „${f.dupSymbol}“`
                            : 'von Jupiter als verdächtig eingestuft';
                        return f.value != null
                            ? `${f.label} (${why}, ~${f.value.toFixed(2)} USDC)`
                            : `${f.label} (${why})`;
                    })
                    .join(' · ');
                const msgKey      = 'notify.wm.scam_token_found';
                const displayName = walletDisplayName(wallet);
                const dashboardUrl = `https://${LOCAL_SERVER.ip}:3200/#${wallet.id}`;
                const params      = { n: finds.length, list, dashboardUrl };
                const message = renderNotification(
                    { msgKey, params, displayName, timestamp: now },
                    getLang(),
                );
                try {
                    await fetch(config.notifyUrl, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            botId: 'wallet-monitor',
                            displayName,
                            level:    'info',
                            category: 'scam_token',
                            message, msgKey, params,
                        }),
                    });
                    console.log(`[wallet-monitor] Scam-Token-Meldung gesendet: ${wallet.label} (${finds.length} neu)`);
                } catch (err) {
                    console.error(`[wallet-monitor] Scam-Token-Meldung fehlgeschlagen: ${err.message}`);
                }
            }
        } catch (err) {
            console.error(`[wallet-monitor] Scam-Token-Erkennung fehlgeschlagen: ${err.message}`);
        }
    } else {
        // Alle erfolgreich gelesenen Wallets sind sauber → Alteinträge entfernen.
        const stmtDropWallet = db.prepare('DELETE FROM unknown_tokens WHERE wallet_id = ?');
        db.transaction(() => {
            for (const walletId of unknownByWallet.keys()) stmtDropWallet.run(walletId);
        })();
    }
} catch (err) {
    // Bewusst nicht fatal: der Snapshot ist das Kerngeschäft dieses Dienstes,
    // die Auffällig-Liste ist Beiwerk und darf ihn nie scheitern lassen.
    console.error(`[wallet-monitor] Unbekannte Token nicht verarbeitet: ${err.message}`);
}

// 3. Alte Snapshots aufräumen (> retainDays Tage)
const cutoff = now - config.retainDays * 24 * 60 * 60 * 1000;
const deleted = stmtCleanup.run(cutoff);
if (deleted.changes > 0) {
    console.log(`[wallet-monitor] Cleanup: ${deleted.changes} alte Snapshots entfernt (>${config.retainDays} Tage)`);
}

db.close();
console.log(`[wallet-monitor] Fertig. ${successCount}/${config.wallets.length} Wallets erfasst.`);
