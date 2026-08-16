/**
 * /api/wallet – Wallet-Management (öffentliche Adresse, Keypair, Adressbuch)
 *
 * GET  /api/wallet/liquidity/info              → Öffentliche Adresse + Key-Status
 * PUT  /api/wallet/liquidity/keypair           → Neuen Key schreiben (Body: { content })
 * GET  /api/wallet/liquidity/keypair/export    → Rohen Key als Datei herunterladen
 * GET  /api/wallet/liquidity/qr               → QR-Code der Adresse (SVG)
 * GET  /api/wallet/liquidity/balance          → Wallet-Balances (aus wallet-monitor.db)
 * POST /api/wallet/liquidity/send             → Token senden (Body: { symbol, amount, toAddress })
 * GET  /api/wallet/liquidity/addresses        → Adressbuch lesen
 * POST /api/wallet/liquidity/addresses        → Adresse hinzufügen (Body: { name, address })
 * PUT  /api/wallet/liquidity/addresses/:id    → Name/Adresse ändern (Body: { name?, address? })
 * DELETE /api/wallet/liquidity/addresses/:id  → Adresse löschen
 */

import { Router }        from 'express';
import fs                from 'fs';
import path              from 'path';
import { spawn }         from 'child_process';
import { fileURLToPath } from 'url';
import bs58              from 'bs58';
import QRCode            from 'qrcode';
import Database          from 'better-sqlite3';
import { PATHS, envFile } from '../../../config/paths.js';
import {
    Keypair, Connection, Transaction, SystemProgram, PublicKey,
    TransactionInstruction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { isForkInstance } from '../../../lib/premium-identity-context.js';
import {
    walletPath as premiumWalletPath, walletExists as premiumWalletExists,
    loadPremiumKeypair, getPremiumPublicKey,
} from '../../../lib/premium-wallet.js';
import { t } from '../../../lib/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FORGE_ROOT        = PATHS.root;
// envFile() statt hardcodiertem PATHS.<bot>/.env – im Fork liegt die .env unter
// local/env/<bot>.env (siehe config/paths.js), sonst zeigt der Pfad ins Leere
// und das Wallet erscheint als "kein Key gesetzt", obwohl einer existiert.
const LIQUIDITYBOT_ENV  = envFile('liquidity');
const LENDING_ENV       = envFile('lending');
const WALLET_MONITOR_DB = PATHS.walletMonitorDb;
const SETTINGS_DB       = PATHS.settingsDb;

/**
 * Startet Liquidity- und LendingBot-Export + sync.sh im Hintergrund.
 *
 * Existenz-Checks + error-Handler bewusst: alle drei Skripte können in einem
 * reduzierten Deployment fehlen (z.B. FORGE-public-Fork ohne Lending Bot/ohne
 * bin/sync.sh, das nur den privaten Dashboard-Sync des Betreibers macht) – spawn() liefert
 * dafür ENOENT über ein ASYNCHRONES 'error'-Event, nicht als Exception. Ohne
 * eigenen Handler ist das ein "Unhandled 'error' event", das den kompletten
 * forge-settings-Prozess abschießt (gefunden 2026-07-26 auf forge-pub1: jeder
 * Klick auf "Wallet aktualisieren" crashte den Server, weil bots/lending dort
 * nicht existiert).
 */
function triggerExportsAndSync() {
    const liquidityExportPath = path.join(PATHS.liquidity, 'bin', 'export.js');
    if (fs.existsSync(liquidityExportPath)) {
        const liquidityExport = spawn('node', [liquidityExportPath], {
            cwd: PATHS.liquidity, detached: true, stdio: 'ignore',
        });
        liquidityExport.on('error', err => console.error(`[triggerExportsAndSync] liquidity export.js: ${err.message}`));
        liquidityExport.unref();
    }

    const syncPath = path.join(FORGE_ROOT, 'bin', 'sync.sh');
    const runSync = () => {
        if (!fs.existsSync(syncPath)) return;
        const syncProc = spawn('bash', [syncPath], { cwd: FORGE_ROOT, detached: true, stdio: 'ignore' });
        syncProc.on('error', err => console.error(`[triggerExportsAndSync] sync.sh: ${err.message}`));
        syncProc.unref();
    };

    const lendingExportPath = path.join(PATHS.lending, 'bin', 'export.js');
    if (fs.existsSync(lendingExportPath)) {
        const lbExport = spawn('node', [lendingExportPath], {
            cwd: PATHS.lending, detached: true, stdio: 'ignore',
        });
        lbExport.on('error', err => console.error(`[triggerExportsAndSync] lending export.js: ${err.message}`));
        lbExport.on('close', runSync);
        lbExport.unref();
    } else {
        runSync();
    }
}

// ── Wallet-Monitor-Refresh (manueller Button + automatisch nach Send) ────────────
const WALLET_MONITOR_SCRIPT     = PATHS.walletMonitor;
const WALLET_MONITOR_TIMEOUT_MS = 30_000;

let _walletMonitorRunning = false;

/**
 * Führt core/wallet-monitor/monitor.js einmal synchron aus (alle konfigurierten
 * Wallets) und stößt danach die Dashboard-Exports + sync.sh an. Wird von der
 * Route /refresh-monitor (Klick auf "Aktualisieren") UND automatisch nach
 * jedem erfolgreichen Send verwendet (siehe scheduleWalletRefreshAfterSend).
 *
 * Wirft bei Fehler (Skript fehlt, Timeout, Non-Zero-Exit, bereits laufend).
 */
async function runWalletMonitorRefresh() {
    if (_walletMonitorRunning) {
        throw new Error(t('api.wallet.monitor_running'));
    }
    if (!fs.existsSync(WALLET_MONITOR_SCRIPT)) {
        throw new Error(t('api.wallet.monitor_not_found', { path: WALLET_MONITOR_SCRIPT }));
    }

    _walletMonitorRunning = true;
    try {
        await new Promise((resolve, reject) => {
            const child = spawn('node', [WALLET_MONITOR_SCRIPT], {
                cwd:   path.dirname(WALLET_MONITOR_SCRIPT),
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', d => { stderr += d.toString(); });
            const killTimer = setTimeout(() => {
                child.kill('SIGTERM');
                reject(new Error(t('api.common.timeout_ms', { ms: WALLET_MONITOR_TIMEOUT_MS })));
            }, WALLET_MONITOR_TIMEOUT_MS);
            child.on('exit', code => {
                clearTimeout(killTimer);
                if (code === 0) resolve();
                else reject(new Error(t('api.wallet.monitor_exit', { code, stderr: stderr.slice(-300) })));
            });
            child.on('error', err => {
                clearTimeout(killTimer);
                reject(err);
            });
        });
        triggerExportsAndSync();
    } finally {
        _walletMonitorRunning = false;
    }
}

/**
 * Stößt nach einem erfolgreichen Send automatisch einen frischen Wallet-Snapshot an —
 * ohne die HTTP-Antwort zu blockieren (Aufrufer NICHT awaiten, siehe Sende-Routen).
 *
 * Hintergrund: Ohne dies blieb wallet-monitor.db (und damit die Wallet-Ansicht) nach
 * einem Send bis zu 10 Min veraltet (nächster Cronlauf) — dasselbe Problem, das für
 * Deposit/Withdraw bereits über refreshAfterAction()/refreshWalletAfterAction() in
 * den jeweiligen Bot-CLIs gelöst ist. Die Sende-Routen hier nutzen aber
 * `sendRawTransaction` OHNE auf Bestätigung zu warten (anders als die Bot-CLIs) —
 * ein sofortiger Snapshot-Lauf würde daher fast immer noch den alten Stand lesen.
 * Deshalb hier zusätzlich explizit auf Confirmation warten + Propagierungspuffer,
 * bevor monitor.js läuft.
 *
 * @param {Connection} connection
 * @param {string}     txHash
 */
function scheduleWalletRefreshAfterSend(connection, txHash) {
    (async () => {
        try {
            await connection.confirmTransaction(txHash, 'confirmed');
        } catch (err) {
            console.warn(`[wallet/send] confirmTransaction fehlgeschlagen (Refresh läuft trotzdem): ${err.message}`);
        }
        // Helius-Indexer braucht nach der Bestätigung manchmal noch ein paar Sekunden,
        // bis getParsedTokenAccountsByOwner den neuen Stand zurückgibt (siehe
        // bots/liquidity/lib/refresh-state.js für dasselbe Phänomen bei Deposit/Withdraw).
        await new Promise(r => setTimeout(r, 3_000));
        try {
            await runWalletMonitorRefresh();
        } catch (err) {
            console.warn(`[wallet/send] Automatischer Wallet-Refresh fehlgeschlagen: ${err.message}`);
        }
    })();
}

// ── Adressbuch-Tabelle sicherstellen ──────────────────────────────────────────
function openSettingsDb() {
    const db = new Database(SETTINGS_DB);
    db.exec(`
        CREATE TABLE IF NOT EXISTS address_book (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id     TEXT    NOT NULL,
            name       TEXT    NOT NULL,
            address    TEXT    NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
    `);
    return db;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readEnvField(envPath, field) {
    if (!fs.existsSync(envPath)) return null;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const ln = line.trim();
        if (ln.startsWith(field + '=')) return ln.slice(field.length + 1).trim();
    }
    return null;
}

/**
 * Lädt das Keypair aus der Datei.
 * Unterstützt JSON-Array [0..63] und Base58-String (64 Byte).
 * @returns {{ bytes: Uint8Array, pubkey: string } | null}
 */
function loadKeypair(keypairPath) {
    if (!keypairPath || !fs.existsSync(keypairPath)) return null;
    try {
        const raw = fs.readFileSync(keypairPath, 'utf8').trim();
        let bytes;
        if (raw.startsWith('[')) {
            // JSON-Array: [1, 2, ..., 64]
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr) || arr.length !== 64) return null;
            bytes = new Uint8Array(arr);
        } else {
            // Base58-String
            bytes = bs58.decode(raw);
            if (bytes.length !== 64) return null;
        }
        const pubkey = bs58.encode(bytes.slice(32));
        return { bytes, pubkey };
    } catch {
        return null;
    }
}

function maskAddress(addr) {
    if (!addr || addr.length < 18) return addr;
    return addr.slice(0, 10) + '…' + addr.slice(-6);
}

/** Einfache Validierung einer Solana-Adresse: 32–44 Base58-Zeichen */
function isValidSolanaAddress(addr) {
    return typeof addr === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

// ── GET /liquidity/info ────────────────────────────────────────────────────────────
router.get('/liquidity/info', (req, res) => {
    const keypairPath = readEnvField(LIQUIDITYBOT_ENV, 'KEYPAIR_PATH');
    const kp          = keypairPath ? loadKeypair(keypairPath) : null;

    res.json({
        keypairSet:  !!kp,
        keypairPath: keypairPath ?? null,
        pubkey:      kp?.pubkey ?? null,
        preview:     kp ? maskAddress(kp.pubkey) : null,
    });
});

// ── PUT /liquidity/keypair ─────────────────────────────────────────────────────────
router.put('/liquidity/keypair', (req, res) => {
    const { content } = req.body;
    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'content' }) });
    }

    const keypairPath = readEnvField(LIQUIDITYBOT_ENV, 'KEYPAIR_PATH');
    if (!keypairPath) {
        return res.status(500).json({ error: t('api.wallet.env_field_missing', { field: 'KEYPAIR_PATH', bot: 'Liquidity' }) });
    }

    const raw = content.trim();
    let bytes;
    try {
        if (raw.startsWith('[')) {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr) || arr.length !== 64) {
                return res.status(400).json({ error: t('api.wallet.json_array_64') });
            }
            bytes = new Uint8Array(arr);
        } else {
            bytes = bs58.decode(raw);
            if (bytes.length !== 64) {
                return res.status(400).json({ error: t('api.wallet.base58_length', { bytes: bytes.length }) });
            }
        }
    } catch (err) {
        return res.status(400).json({ error: t('api.wallet.invalid_format', { error: err.message }) });
    }

    const pubkey = bs58.encode(bytes.slice(32));

    // Als Base58-String schreiben (wie bestehendes Format)
    fs.writeFileSync(keypairPath, bs58.encode(bytes), 'utf8');

    res.json({ ok: true, pubkey, preview: maskAddress(pubkey) });
});

// ── GET /liquidity/keypair/export ──────────────────────────────────────────────────
// Lädt den rohen Key als Datei herunter (gleiches Base58-Format wie beim Import) –
// gleiche Vertrauensstufe wie PUT /keypair, kein zusätzlicher Schutz nötig (interner
// HTTPS-Admin-Server, LAN-only, siehe forge-settings CLAUDE.md).
router.get('/liquidity/keypair/export', (req, res) => {
    const keypairPath = readEnvField(LIQUIDITYBOT_ENV, 'KEYPAIR_PATH');
    const kp          = keypairPath ? loadKeypair(keypairPath) : null;
    if (!kp) return res.status(404).json({ error: t('api.wallet.no_key') });

    const raw = fs.readFileSync(keypairPath, 'utf8').trim();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="liquidity-wallet-${kp.pubkey.slice(0, 8)}.key"`);
    res.send(raw);
});

// ── GET /liquidity/qr ─────────────────────────────────────────────────────────────
router.get('/liquidity/qr', async (req, res) => {
    const keypairPath = readEnvField(LIQUIDITYBOT_ENV, 'KEYPAIR_PATH');
    const kp          = keypairPath ? loadKeypair(keypairPath) : null;

    if (!kp) {
        return res.status(404).json({ error: t('api.wallet.no_keypair') });
    }

    try {
        const svg = await QRCode.toString(kp.pubkey, {
            type:       'svg',
            margin:     1,
            width:      200,
            color:      { dark: '#f1f5f9', light: '#1e293b' },
        });
        res.set('Content-Type', 'image/svg+xml');
        res.send(svg);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /liquidity/balance ─────────────────────────────────────────────────────────
// ?fresh=1 → direkt von der Blockchain lesen (umgeht wallet-monitor.db-Cache)
const USDC_MINT_STR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM      = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

async function fetchLiquidityBalanceFresh(res) {
    const keypairPath = readEnvField(LIQUIDITYBOT_ENV, 'KEYPAIR_PATH');
    const kp          = keypairPath ? loadKeypair(keypairPath) : null;
    if (!kp) return res.status(500).json({ error: t('api.wallet.keypair_missing', { wallet: 'Liquidity' }) });

    try {
        const conn   = new Connection(NEXUS_RPC_FRESH, 'confirmed');
        const pubkey = new PublicKey(kp.pubkey);

        // SOL + SPL-Token-Konten (TOKEN_PROGRAM + TOKEN_2022 parallel)
        const [lamports, tokenAccounts, token22Accounts] = await Promise.all([
            conn.getBalance(pubkey),
            conn.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM }),
            conn.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM }),
        ]);

        const { mints: TOKEN_MINTS } = loadTokenRegistry();
        const mintToSymbol = Object.fromEntries(Object.entries(TOKEN_MINTS).map(([sym, mint]) => [mint, sym]));
        const sol  = Math.max(0, lamports / LAMPORTS_PER_SOL - 0.1);
        let   usdc = 0;
        const tokens = [];

        for (const { account } of [...tokenAccounts.value, ...token22Accounts.value]) {
            const info   = account.data.parsed.info;
            const mint   = info.mint;
            const amount = info.tokenAmount.uiAmount ?? 0;
            if (mint === USDC_MINT_STR) { usdc = amount; continue; }
            const symbol = mintToSymbol[mint];
            if (symbol && amount > 0) tokens.push({ symbol, balance: amount, value_usd: null });
        }

        res.set('Cache-Control', 'no-store');
        res.json({ sol, usdc, total_usd: null, tokens });
    } catch (err) {
        res.status(500).json({ error: t('api.wallet.fresh_balance_failed', { error: err.message }) });
    }
}

router.get('/liquidity/balance', async (req, res) => {
    if (req.query.fresh === '1') return fetchLiquidityBalanceFresh(res);

    if (!fs.existsSync(WALLET_MONITOR_DB)) {
        return res.json({ sol: null, usdc: null, total_usd: null, tokens: [] });
    }

    try {
        const db  = new Database(WALLET_MONITOR_DB, { readonly: true });
        const snap = db.prepare(
            `SELECT id, sol_balance, usdc_balance, total_usd, recorded_at
             FROM snapshots WHERE wallet_id = 'liquidity'
             ORDER BY recorded_at DESC LIMIT 1`
        ).get();

        if (!snap) {
            db.close();
            return res.json({ sol: null, usdc: null, total_usd: null, tokens: [], recorded_at: null });
        }

        const tokens = db.prepare(
            `SELECT symbol, balance, value_usd
             FROM token_balances WHERE snapshot_id = ?
             ORDER BY value_usd DESC NULLS LAST`
        ).all(snap.id);

        db.close();
        res.json({
            sol:         snap.sol_balance,
            usdc:        snap.usdc_balance,
            total_usd:   snap.total_usd,
            tokens,
            recorded_at: snap.recorded_at,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /liquidity/addresses ───────────────────────────────────────────────────────
router.get('/liquidity/addresses', (req, res) => {
    const db  = openSettingsDb();
    const rows = db.prepare(
        `SELECT id, name, address, created_at FROM address_book WHERE bot_id = 'liquidity' ORDER BY name`
    ).all();
    db.close();
    res.json(rows);
});

// ── POST /liquidity/addresses ──────────────────────────────────────────────────────
router.post('/liquidity/addresses', (req, res) => {
    const { name, address } = req.body;
    if (!name  || typeof name !== 'string'  || !name.trim()) {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'name' }) });
    }
    if (!address || typeof address !== 'string') {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'address' }) });
    }
    if (!isValidSolanaAddress(address.trim())) {
        return res.status(400).json({ error: t('api.common.invalid_address') });
    }

    const db     = openSettingsDb();
    const result = db.prepare(
        `INSERT INTO address_book (bot_id, name, address) VALUES ('liquidity', ?, ?)`
    ).run(name.trim(), address.trim());
    db.close();

    res.json({ id: result.lastInsertRowid, name: name.trim(), address: address.trim() });
});

// ── PUT /liquidity/addresses/:id ───────────────────────────────────────────────────
router.put('/liquidity/addresses/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: t('api.common.invalid_id') });

    const { name, address } = req.body;

    const db  = openSettingsDb();
    const row = db.prepare(`SELECT id FROM address_book WHERE id = ? AND bot_id = 'liquidity'`).get(id);
    if (!row) { db.close(); return res.status(404).json({ error: t('api.common.address_not_found') }); }

    if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim()) {
            db.close(); return res.status(400).json({ error: t('api.common.invalid_name') });
        }
        db.prepare(`UPDATE address_book SET name = ? WHERE id = ?`).run(name.trim(), id);
    }
    if (address !== undefined) {
        if (!isValidSolanaAddress(address.trim())) {
            db.close(); return res.status(400).json({ error: t('api.common.invalid_address') });
        }
        db.prepare(`UPDATE address_book SET address = ? WHERE id = ?`).run(address.trim(), id);
    }

    db.close();
    res.json({ ok: true });
});

// ── DELETE /liquidity/addresses/:id ────────────────────────────────────────────────
router.delete('/liquidity/addresses/:id', (req, res) => {
    const id = Number(req.params.id);
    const db = openSettingsDb();
    db.prepare(`DELETE FROM address_book WHERE id = ? AND bot_id = 'liquidity'`).run(id);
    db.close();
    res.json({ ok: true });
});

// ── Token-Registry: datengetrieben aus core/wallet-monitor/config.json ────────────
// Vorher hartcodiert (FORGE public Pool-Offers Blocker 2, 2026-07-27) — jeder neue Pool-Token
// brauchte einen Edit hier + Neustart (Checkliste Schritt 3). Quelle jetzt: dasselbe
// { symbol, mint, decimals }-Array, das core/wallet-monitor bereits für die Balance-Erfassung
// nutzt und das die Pool-Checkliste (Schritt 2) bei jedem neuen Pool ohnehin pflegt — kein
// zusätzlicher Pflegeaufwand, ein Edit weniger pro Pool.
//
// NICHT aus config/pools.json ableitbar: dessen `pair`-Feld folgt NICHT zuverlässig der
// tokenA/tokenB-Reihenfolge. Befund (liq-eurc-usdc): pair="EURC/USDC", aber tokenA ist die
// USDC-Mint (usdcIsTokenA:true) — eine Symbol-Zuordnung per pair.split('/') würde USDC und
// EURC vertauschen. (Derselbe Fehler existiert bereits, unabhängig von dieser Änderung, in
// bin/close-scam-tokens.js:113 — dort nicht mit angefasst, separat gemeldet.)
//
// USDC separat hartcodiert: taucht in wallet-monitor/config.json nicht auf (dort nur
// „andere" Token, USDC läuft eigenständig als Quote-Currency), wird hier aber für /send
// gebraucht. Frisch von Disk gelesen (kein Require-Cache) — neue Pool-Token wirken ohne
// Neustart von forge-settings, Schritt 3 der Checkliste entfällt komplett.
const WALLET_MONITOR_CONFIG = path.resolve(FORGE_ROOT, 'core', 'wallet-monitor', 'config.json');

function loadTokenRegistry() {
    const decimals = { USDC: 6 };
    const mints    = { USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
    try {
        const cfg = JSON.parse(fs.readFileSync(WALLET_MONITOR_CONFIG, 'utf8'));
        for (const tok of cfg.tokens ?? []) {
            if (!tok.symbol || !tok.mint) continue;
            mints[tok.symbol]    = tok.mint;
            decimals[tok.symbol] = tok.decimals;
        }
    } catch (err) {
        console.warn(`[wallet] Token-Registry aus wallet-monitor/config.json nicht ladbar: ${err.message}`);
    }
    return { decimals, mints };
}

const SOL_RESERVE_LAMPORTS = 0.1 * LAMPORTS_PER_SOL;
const NEXUS_RPC_FRESH       = 'http://127.0.0.1:3100/rpc/fresh';

const SPL_PROGRAM_ID   = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOC_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function deriveATA(walletPubkey, mintPubkey) {
    const [ata] = PublicKey.findProgramAddressSync(
        [walletPubkey.toBuffer(), SPL_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
        ASSOC_PROGRAM_ID,
    );
    return ata;
}

function loadKeypairFull(envPath, field) {
    const keypairPath = readEnvField(envPath, field);
    if (!keypairPath) return null;
    return loadKeypair(keypairPath);
}

// ── POST /liquidity/send ───────────────────────────────────────────────────────────
router.post('/liquidity/send', async (req, res) => {
    const { symbol, amount, toAddress } = req.body;

    // ── Eingabe-Validierung ───────────────────────────────────────────────────
    if (!symbol || typeof symbol !== 'string') {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'symbol' }) });
    }
    if (typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)) {
        return res.status(400).json({ error: t('api.common.invalid_amount') });
    }
    if (!isValidSolanaAddress(toAddress)) {
        return res.status(400).json({ error: t('api.wallet.invalid_target') });
    }

    const sym = symbol.trim();
    const { decimals: TOKEN_DECIMALS, mints: TOKEN_MINTS } = loadTokenRegistry();
    if (sym !== 'SOL' && !TOKEN_MINTS[sym]) {
        return res.status(400).json({ error: t('api.wallet.unknown_token', { symbol: sym }) });
    }

    // ── Keypair laden ─────────────────────────────────────────────────────────
    const kpData = loadKeypairFull(LIQUIDITYBOT_ENV, 'KEYPAIR_PATH');
    if (!kpData) {
        return res.status(500).json({ error: t('api.wallet.keypair_missing', { wallet: 'Liquidity' }) });
    }
    const wallet     = Keypair.fromSecretKey(kpData.bytes);
    const connection = new Connection(NEXUS_RPC_FRESH, 'confirmed');

    try {
        if (sym === 'SOL') {
            // ── SOL-Transfer ──────────────────────────────────────────────────
            const currentLamports = await connection.getBalance(wallet.publicKey);
            const maxSendable     = currentLamports - SOL_RESERVE_LAMPORTS;

            if (maxSendable <= 0) {
                return res.status(400).json({ error: t('api.wallet.below_reserve') });
            }

            const requestedLamports = Math.round(amount * LAMPORTS_PER_SOL);
            if (requestedLamports > maxSendable) {
                return res.status(400).json({
                    error: t('api.wallet.exceeds_available', { max: (maxSendable / LAMPORTS_PER_SOL).toFixed(4) }),
                });
            }

            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey:   new PublicKey(toAddress),
                    lamports:   requestedLamports,
                })
            );
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.feePayer        = wallet.publicKey;
            tx.sign(wallet);

            const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            scheduleWalletRefreshAfterSend(connection, txHash);
            return res.json({ ok: true, txHash, symbol: sym, amount });

        } else {
            // ── SPL-Token-Transfer ────────────────────────────────────────────
            const mintPubkey = new PublicKey(TOKEN_MINTS[sym]);
            const destPubkey = new PublicKey(toAddress);
            const sourceATA  = deriveATA(wallet.publicKey, mintPubkey);
            const destATA    = deriveATA(destPubkey, mintPubkey);
            const decimals   = TOKEN_DECIMALS[sym];
            const tx         = new Transaction();

            // ATA anlegen wenn nötig
            const destATAInfo = await connection.getAccountInfo(destATA);
            if (!destATAInfo) {
                tx.add(new TransactionInstruction({
                    programId: ASSOC_PROGRAM_ID,
                    keys: [
                        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
                        { pubkey: destATA,                 isSigner: false, isWritable: true  },
                        { pubkey: destPubkey,              isSigner: false, isWritable: false },
                        { pubkey: mintPubkey,              isSigner: false, isWritable: false },
                        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                        { pubkey: SPL_PROGRAM_ID,          isSigner: false, isWritable: false },
                    ],
                    data: Buffer.alloc(0),
                }));
            }

            // On-Chain-Balance holen und als Obergrenze verwenden (Snapshot kann veraltet sein)
            let onChainRaw = BigInt(0);
            try {
                const ataInfo = await connection.getTokenAccountBalance(sourceATA);
                onChainRaw = BigInt(ataInfo.value.amount);
            } catch {
                return res.status(400).json({ error: t('api.wallet.no_token_account', { symbol: sym }) });
            }

            const requestedRaw = BigInt(Math.round(amount * 10 ** decimals));
            const rawAmount    = requestedRaw > onChainRaw ? onChainRaw : requestedRaw;

            if (rawAmount === BigInt(0)) {
                return res.status(400).json({ error: t('api.wallet.token_balance_zero', { symbol: sym }) });
            }

            const data = Buffer.alloc(9);
            data.writeUInt8(3, 0);
            data.writeBigUInt64LE(rawAmount, 1);

            tx.add(new TransactionInstruction({
                programId: SPL_PROGRAM_ID,
                keys: [
                    { pubkey: sourceATA,        isSigner: false, isWritable: true  },
                    { pubkey: destATA,          isSigner: false, isWritable: true  },
                    { pubkey: wallet.publicKey, isSigner: true,  isWritable: false },
                ],
                data,
            }));

            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.feePayer        = wallet.publicKey;
            tx.sign(wallet);

            const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            scheduleWalletRefreshAfterSend(connection, txHash);
            return res.json({ ok: true, txHash, symbol: sym, amount });
        }
    } catch (err) {
        console.error(`[wallet/send] Fehler: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LendingBot – /lending/*
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /lending/info ─────────────────────────────────────────────────────────
router.get('/lending/info', (req, res) => {
    const keypairPath = readEnvField(LENDING_ENV, 'SOLANA_KEYPAIR_PATH');
    const kp          = keypairPath ? loadKeypair(keypairPath) : null;

    res.json({
        keypairSet:  !!kp,
        keypairPath: keypairPath ?? null,
        pubkey:      kp?.pubkey ?? null,
        preview:     kp ? maskAddress(kp.pubkey) : null,
    });
});

// ── PUT /lending/keypair ──────────────────────────────────────────────────────
router.put('/lending/keypair', (req, res) => {
    const { content } = req.body;
    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'content' }) });
    }

    const keypairPath = readEnvField(LENDING_ENV, 'SOLANA_KEYPAIR_PATH');
    if (!keypairPath) {
        return res.status(500).json({ error: t('api.wallet.env_field_missing', { field: 'SOLANA_KEYPAIR_PATH', bot: 'LendingBot' }) });
    }

    const raw = content.trim();
    let bytes;
    try {
        if (raw.startsWith('[')) {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr) || arr.length !== 64) {
                return res.status(400).json({ error: t('api.wallet.json_array_64') });
            }
            bytes = new Uint8Array(arr);
        } else {
            bytes = bs58.decode(raw);
            if (bytes.length !== 64) {
                return res.status(400).json({ error: t('api.wallet.base58_length', { bytes: bytes.length }) });
            }
        }
    } catch (err) {
        return res.status(400).json({ error: t('api.wallet.invalid_format', { error: err.message }) });
    }

    const pubkey = bs58.encode(bytes.slice(32));

    // Als Base58-String schreiben (wie bestehendes Format)
    fs.writeFileSync(keypairPath, bs58.encode(bytes), 'utf8');

    res.json({ ok: true, pubkey, preview: maskAddress(pubkey) });
});

// ── GET /lending/qr ───────────────────────────────────────────────────────────
router.get('/lending/qr', async (req, res) => {
    const keypairPath = readEnvField(LENDING_ENV, 'SOLANA_KEYPAIR_PATH');
    const kp          = keypairPath ? loadKeypair(keypairPath) : null;

    if (!kp) {
        return res.status(404).json({ error: t('api.wallet.no_keypair') });
    }

    try {
        const svg = await QRCode.toString(kp.pubkey, {
            type:   'svg',
            margin: 1,
            width:  200,
            color:  { dark: '#f1f5f9', light: '#1e293b' },
        });
        res.set('Content-Type', 'image/svg+xml');
        res.send(svg);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /lending/balance ──────────────────────────────────────────────────────
// ?fresh=1 → direkt von der Blockchain lesen (umgeht wallet-monitor.db-Cache)
async function fetchLendingBalanceFresh(res) {
    const keypairPath = readEnvField(LENDING_ENV, 'SOLANA_KEYPAIR_PATH');
    const kp          = keypairPath ? loadKeypair(keypairPath) : null;
    if (!kp) return res.status(500).json({ error: t('api.wallet.keypair_missing', { wallet: 'Lending' }) });

    try {
        const conn   = new Connection(NEXUS_RPC_FRESH, 'confirmed');
        const pubkey = new PublicKey(kp.pubkey);

        const [lamports, tokenAccounts, token22Accounts] = await Promise.all([
            conn.getBalance(pubkey),
            conn.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM }),
            conn.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM }),
        ]);

        const { mints: TOKEN_MINTS } = loadTokenRegistry();
        const mintToSymbol = Object.fromEntries(Object.entries(TOKEN_MINTS).map(([sym, mint]) => [mint, sym]));
        const sol  = Math.max(0, lamports / LAMPORTS_PER_SOL - 0.1);
        let   usdc = 0;
        const tokens = [];

        for (const { account } of [...tokenAccounts.value, ...token22Accounts.value]) {
            const info   = account.data.parsed.info;
            const mint   = info.mint;
            const amount = info.tokenAmount.uiAmount ?? 0;
            if (mint === USDC_MINT_STR) { usdc = amount; continue; }
            const symbol = mintToSymbol[mint];
            if (symbol && amount > 0) tokens.push({ symbol, balance: amount, value_usd: null });
        }

        res.set('Cache-Control', 'no-store');
        res.json({ sol, usdc, total_usd: null, tokens });
    } catch (err) {
        res.status(500).json({ error: t('api.wallet.fresh_balance_failed', { error: err.message }) });
    }
}

router.get('/lending/balance', async (req, res) => {
    if (req.query.fresh === '1') return fetchLendingBalanceFresh(res);

    if (!fs.existsSync(WALLET_MONITOR_DB)) {
        return res.json({ sol: null, usdc: null, total_usd: null, tokens: [] });
    }

    try {
        const db  = new Database(WALLET_MONITOR_DB, { readonly: true });
        const snap = db.prepare(
            `SELECT id, sol_balance, usdc_balance, total_usd, recorded_at
             FROM snapshots WHERE wallet_id = 'lending'
             ORDER BY recorded_at DESC LIMIT 1`
        ).get();

        if (!snap) {
            db.close();
            return res.json({ sol: null, usdc: null, total_usd: null, tokens: [] });
        }

        const tokens = db.prepare(
            `SELECT symbol, balance, value_usd
             FROM token_balances WHERE snapshot_id = ?
             ORDER BY value_usd DESC NULLS LAST`
        ).all(snap.id);

        db.close();
        res.json({
            sol:         snap.sol_balance,
            usdc:        snap.usdc_balance,
            total_usd:   snap.total_usd,
            recorded_at: snap.recorded_at,
            tokens,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /lending/send ────────────────────────────────────────────────────────
router.post('/lending/send', async (req, res) => {
    const { symbol, amount, toAddress } = req.body;

    if (!symbol || typeof symbol !== 'string') {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'symbol' }) });
    }
    if (typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)) {
        return res.status(400).json({ error: t('api.common.invalid_amount') });
    }
    if (!isValidSolanaAddress(toAddress)) {
        return res.status(400).json({ error: t('api.wallet.invalid_target') });
    }

    const sym = symbol.trim();
    const { decimals: TOKEN_DECIMALS, mints: TOKEN_MINTS } = loadTokenRegistry();
    if (sym !== 'SOL' && !TOKEN_MINTS[sym]) {
        return res.status(400).json({ error: t('api.wallet.unknown_token', { symbol: sym }) });
    }

    const kpData = loadKeypairFull(LENDING_ENV, 'SOLANA_KEYPAIR_PATH');
    if (!kpData) {
        return res.status(500).json({ error: t('api.wallet.keypair_missing', { wallet: 'Lending' }) });
    }
    const wallet     = Keypair.fromSecretKey(kpData.bytes);
    const connection = new Connection(NEXUS_RPC_FRESH, 'confirmed');

    try {
        if (sym === 'SOL') {
            const currentLamports = await connection.getBalance(wallet.publicKey);
            const maxSendable     = currentLamports - SOL_RESERVE_LAMPORTS;

            if (maxSendable <= 0) {
                return res.status(400).json({ error: t('api.wallet.below_reserve') });
            }

            const requestedLamports = Math.round(amount * LAMPORTS_PER_SOL);
            if (requestedLamports > maxSendable) {
                return res.status(400).json({
                    error: t('api.wallet.exceeds_available', { max: (maxSendable / LAMPORTS_PER_SOL).toFixed(4) }),
                });
            }

            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey:   new PublicKey(toAddress),
                    lamports:   requestedLamports,
                })
            );
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.feePayer        = wallet.publicKey;
            tx.sign(wallet);

            const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            scheduleWalletRefreshAfterSend(connection, txHash);
            return res.json({ ok: true, txHash, symbol: sym, amount });

        } else {
            const mintPubkey = new PublicKey(TOKEN_MINTS[sym]);
            const destPubkey = new PublicKey(toAddress);
            const sourceATA  = deriveATA(wallet.publicKey, mintPubkey);
            const destATA    = deriveATA(destPubkey, mintPubkey);
            const decimals   = TOKEN_DECIMALS[sym];
            const tx         = new Transaction();

            const destATAInfo = await connection.getAccountInfo(destATA);
            if (!destATAInfo) {
                tx.add(new TransactionInstruction({
                    programId: ASSOC_PROGRAM_ID,
                    keys: [
                        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
                        { pubkey: destATA,                 isSigner: false, isWritable: true  },
                        { pubkey: destPubkey,              isSigner: false, isWritable: false },
                        { pubkey: mintPubkey,              isSigner: false, isWritable: false },
                        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                        { pubkey: SPL_PROGRAM_ID,          isSigner: false, isWritable: false },
                    ],
                    data: Buffer.alloc(0),
                }));
            }

            let onChainRaw = BigInt(0);
            try {
                const ataInfo = await connection.getTokenAccountBalance(sourceATA);
                onChainRaw = BigInt(ataInfo.value.amount);
            } catch {
                return res.status(400).json({ error: t('api.wallet.no_token_account', { symbol: sym }) });
            }

            const requestedRaw = BigInt(Math.round(amount * 10 ** decimals));
            const rawAmount    = requestedRaw > onChainRaw ? onChainRaw : requestedRaw;

            if (rawAmount === BigInt(0)) {
                return res.status(400).json({ error: t('api.wallet.token_balance_zero', { symbol: sym }) });
            }

            const data = Buffer.alloc(9);
            data.writeUInt8(3, 0);
            data.writeBigUInt64LE(rawAmount, 1);

            tx.add(new TransactionInstruction({
                programId: SPL_PROGRAM_ID,
                keys: [
                    { pubkey: sourceATA,        isSigner: false, isWritable: true  },
                    { pubkey: destATA,          isSigner: false, isWritable: true  },
                    { pubkey: wallet.publicKey, isSigner: true,  isWritable: false },
                ],
                data,
            }));

            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.feePayer        = wallet.publicKey;
            tx.sign(wallet);

            const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            scheduleWalletRefreshAfterSend(connection, txHash);
            return res.json({ ok: true, txHash, symbol: sym, amount });
        }
    } catch (err) {
        console.error(`[wallet/lending/send] Fehler: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /refresh-monitor ─────────────────────────────────────────────────────
// Triggert sofortiges Einlesen aller Wallets via core/wallet-monitor/monitor.js.
// Bypasst den 10-Min-Cron-Zyklus. Antwortet erst nach Exit (≤ Timeout).
router.post('/refresh-monitor', async (req, res) => {
    const started = Date.now();
    try {
        await runWalletMonitorRefresh();
        res.json({ ok: true, durationMs: Date.now() - started });
    } catch (err) {
        const status = err.message === t('api.wallet.monitor_running') ? 409 : 500;
        res.status(status).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Premium-Service-Wallet – /premium/* (nur auf einem FORGE-public-Fork vorhanden,
// siehe lib/premium-wallet.js; Guthaben/Historie kommen aus wallet-monitor.db
// wallet_id='premium' — install.sh trägt das Wallet dort mit ein, siehe
// bin/install.sh "Premium-Wallet wird überwacht")
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /premium/info ──────────────────────────────────────────────────────────────
router.get('/premium/info', (req, res) => {
    if (!isForkInstance()) return res.json({ available: false });
    const exists = premiumWalletExists();
    const pubkey = exists ? getPremiumPublicKey() : null;
    res.json({
        available:   true,
        keypairSet:  exists,
        keypairPath: premiumWalletPath(),
        pubkey,
        preview:     pubkey ? maskAddress(pubkey) : null,
    });
});

// ── PUT /premium/keypair ────────────────────────────────────────────────────────────
router.put('/premium/keypair', (req, res) => {
    const { content } = req.body;
    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'content' }) });
    }

    const keypairPath = premiumWalletPath();
    if (!keypairPath) {
        return res.status(500).json({ error: t('api.wallet.premium_path_missing') });
    }

    const raw = content.trim();
    let bytes;
    try {
        if (raw.startsWith('[')) {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr) || arr.length !== 64) {
                return res.status(400).json({ error: t('api.wallet.json_array_64') });
            }
            bytes = new Uint8Array(arr);
        } else {
            bytes = bs58.decode(raw);
            if (bytes.length !== 64) {
                return res.status(400).json({ error: t('api.wallet.base58_length', { bytes: bytes.length }) });
            }
        }
    } catch (err) {
        return res.status(400).json({ error: t('api.wallet.invalid_format', { error: err.message }) });
    }

    const pubkey = bs58.encode(bytes.slice(32));
    fs.writeFileSync(keypairPath, bs58.encode(bytes), 'utf8');
    res.json({ ok: true, pubkey, preview: maskAddress(pubkey) });
});

// ── GET /premium/keypair/export ─────────────────────────────────────────────────────
router.get('/premium/keypair/export', (req, res) => {
    const keypairPath = premiumWalletPath();
    if (!keypairPath || !premiumWalletExists()) {
        return res.status(404).json({ error: t('api.wallet.no_key') });
    }
    const pubkey = getPremiumPublicKey();
    const raw    = fs.readFileSync(keypairPath, 'utf8').trim();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="premium-wallet-${pubkey.slice(0, 8)}.key"`);
    res.send(raw);
});

// ── GET /premium/qr ─────────────────────────────────────────────────────────────────
router.get('/premium/qr', async (req, res) => {
    const pubkey = premiumWalletExists() ? getPremiumPublicKey() : null;
    if (!pubkey) return res.status(404).json({ error: t('api.wallet.no_keypair') });

    try {
        const svg = await QRCode.toString(pubkey, {
            type:   'svg',
            margin: 1,
            width:  200,
            color:  { dark: '#f1f5f9', light: '#1e293b' },
        });
        res.set('Content-Type', 'image/svg+xml');
        res.send(svg);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /premium/balance ────────────────────────────────────────────────────────────
// Gleiche wallet-monitor.db, nur wallet_id='premium' statt 'liquidity' — kein
// eigenes Token-Tracking nötig (Premium-Wallet hält bewusst nur SOL + USDC).
router.get('/premium/balance', async (req, res) => {
    if (!fs.existsSync(WALLET_MONITOR_DB)) {
        return res.json({ sol: null, usdc: null, total_usd: null, tokens: [] });
    }

    try {
        const db   = new Database(WALLET_MONITOR_DB, { readonly: true });
        const snap = db.prepare(
            `SELECT id, sol_balance, usdc_balance, total_usd, recorded_at
             FROM snapshots WHERE wallet_id = 'premium'
             ORDER BY recorded_at DESC LIMIT 1`
        ).get();

        if (!snap) {
            db.close();
            return res.json({ sol: null, usdc: null, total_usd: null, tokens: [], recorded_at: null });
        }

        const tokens = db.prepare(
            `SELECT symbol, balance, value_usd
             FROM token_balances WHERE snapshot_id = ?
             ORDER BY value_usd DESC NULLS LAST`
        ).all(snap.id);

        db.close();
        res.json({
            sol:         snap.sol_balance,
            usdc:        snap.usdc_balance,
            total_usd:   snap.total_usd,
            tokens,
            recorded_at: snap.recorded_at,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /premium/send ──────────────────────────────────────────────────────────────
// Nur SOL/USDC (bewusst kein dynamisches Token-Registry-Scanning wie bei
// /liquidity/send — das Premium-Wallet hält architekturbedingt nichts anderes).
router.post('/premium/send', async (req, res) => {
    const { symbol, amount, toAddress } = req.body;

    if (!symbol || typeof symbol !== 'string') {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'symbol' }) });
    }
    if (typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)) {
        return res.status(400).json({ error: t('api.common.invalid_amount') });
    }
    if (!isValidSolanaAddress(toAddress)) {
        return res.status(400).json({ error: t('api.wallet.invalid_target') });
    }

    const sym = symbol.trim();
    if (sym !== 'SOL' && sym !== 'USDC') {
        return res.status(400).json({ error: t('api.wallet.unknown_token', { symbol: sym }) });
    }

    const wallet = loadPremiumKeypair();
    if (!wallet) {
        return res.status(500).json({ error: t('api.wallet.keypair_missing', { wallet: 'Premium' }) });
    }
    const connection = new Connection(NEXUS_RPC_FRESH, 'confirmed');

    try {
        if (sym === 'SOL') {
            const currentLamports = await connection.getBalance(wallet.publicKey);
            const maxSendable     = currentLamports - SOL_RESERVE_LAMPORTS;

            if (maxSendable <= 0) {
                return res.status(400).json({ error: t('api.wallet.below_reserve') });
            }

            const requestedLamports = Math.round(amount * LAMPORTS_PER_SOL);
            if (requestedLamports > maxSendable) {
                return res.status(400).json({
                    error: t('api.wallet.exceeds_available', { max: (maxSendable / LAMPORTS_PER_SOL).toFixed(4) }),
                });
            }

            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey:   new PublicKey(toAddress),
                    lamports:   requestedLamports,
                })
            );
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.feePayer        = wallet.publicKey;
            tx.sign(wallet);

            const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            scheduleWalletRefreshAfterSend(connection, txHash);
            return res.json({ ok: true, txHash, symbol: sym, amount });

        } else {
            const mintPubkey = new PublicKey(USDC_MINT_STR);
            const destPubkey = new PublicKey(toAddress);
            const sourceATA  = deriveATA(wallet.publicKey, mintPubkey);
            const destATA    = deriveATA(destPubkey, mintPubkey);
            const decimals   = 6;
            const tx         = new Transaction();

            const destATAInfo = await connection.getAccountInfo(destATA);
            if (!destATAInfo) {
                tx.add(new TransactionInstruction({
                    programId: ASSOC_PROGRAM_ID,
                    keys: [
                        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
                        { pubkey: destATA,                 isSigner: false, isWritable: true  },
                        { pubkey: destPubkey,              isSigner: false, isWritable: false },
                        { pubkey: mintPubkey,              isSigner: false, isWritable: false },
                        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                        { pubkey: SPL_PROGRAM_ID,          isSigner: false, isWritable: false },
                    ],
                    data: Buffer.alloc(0),
                }));
            }

            let onChainRaw = BigInt(0);
            try {
                const ataInfo = await connection.getTokenAccountBalance(sourceATA);
                onChainRaw = BigInt(ataInfo.value.amount);
            } catch {
                return res.status(400).json({ error: t('api.wallet.no_token_account', { symbol: sym }) });
            }

            const requestedRaw = BigInt(Math.round(amount * 10 ** decimals));
            const rawAmount    = requestedRaw > onChainRaw ? onChainRaw : requestedRaw;

            if (rawAmount === BigInt(0)) {
                return res.status(400).json({ error: t('api.wallet.token_balance_zero', { symbol: sym }) });
            }

            const data = Buffer.alloc(9);
            data.writeUInt8(3, 0);
            data.writeBigUInt64LE(rawAmount, 1);

            tx.add(new TransactionInstruction({
                programId: SPL_PROGRAM_ID,
                keys: [
                    { pubkey: sourceATA,        isSigner: false, isWritable: true  },
                    { pubkey: destATA,          isSigner: false, isWritable: true  },
                    { pubkey: wallet.publicKey, isSigner: true,  isWritable: false },
                ],
                data,
            }));

            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.feePayer        = wallet.publicKey;
            tx.sign(wallet);

            const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            scheduleWalletRefreshAfterSend(connection, txHash);
            return res.json({ ok: true, txHash, symbol: sym, amount });
        }
    } catch (err) {
        console.error(`[wallet/send] Premium-Transfer fehlgeschlagen: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

export default router;
export { readEnvField, loadKeypair, LIQUIDITYBOT_ENV, NEXUS_RPC_FRESH };
