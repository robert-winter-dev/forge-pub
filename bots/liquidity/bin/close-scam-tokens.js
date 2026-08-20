/**
 * close-scam-tokens.js
 *
 * Erkennt unbekannte SPL-Token-Konten im Liquidity-Wallet, bewertet sie anhand von
 * Jupiter-Preis, GeckoTerminal-TVL, Token-Alter (älteste on-chain-Signatur) und
 * Name-Kollision mit bekannten Pool-Token, und verbrennt Scam-/Dust-Token auf
 * Wunsch (burn + closeAccount), um die SOL-Miet-Reserve (~0,002 SOL/Token)
 * zurückzuholen.
 *
 * Klassifizierung (TVL ist nur informativ, kein Signal — GeckoTerminal matcht
 * auf Symbol statt Mint und ist für Fakes unzuverlässig):
 *   SKIP   – Preis bekannt + Wert ≥ VALUE_THRESHOLD (Default 5 USDC), keine
 *            Name-Kollision → unberührt
 *   REVIEW – Name-Kollision UND Wert ≥ VALUE_THRESHOLD → wird nie automatisch
 *            verbrannt (burn ist irreversibel), aber deutlich ausgewiesen
 *   WARN   – kein Preis + hohe Balance (>100, ohne Name-Flag) ODER Preis < Schwelle → manuell prüfen
 *   BURN   – NUR bei Name-Kollision mit bekanntem Token (stärkstes Scam-Signal).
 *            Fehlender Preis allein führt seit 2026-08-18 NICHT mehr zu BURN, sondern
 *            zu WARN — LP-/Receipt-Token und Positions-NFTs haben systematisch keinen
 *            Marktpreis (Vorfall 2026-08-12: ~70 USDC LP-Token verbrannt).
 *
 * Aufruf:
 *   node bin/close-scam-tokens.js                              # Dry-Run
 *   node bin/close-scam-tokens.js --report                     # Read-only Scan + Telegram-Report (Cron)
 *   node bin/close-scam-tokens.js --execute                    # mit Bestätigung
 *   node bin/close-scam-tokens.js --threshold 10               # anderer SKIP-Schwellwert (USDC)
 *   node bin/close-scam-tokens.js --skip-warn                  # WARN-Tokens überspringen
 *   node bin/close-scam-tokens.js --mint 1wPta5kVuJT1 --mint 7J6dyjbcoMYV --execute
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { createInterface }       from 'readline';
import { fileURLToPath }         from 'url';
import path                      from 'path';
import {
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    createBurnInstruction,
    createCloseAccountInstruction,
} from '@solana/spl-token';

import { config }               from '../lib/config.js';
import { openDatabase }         from '../lib/db.js';
import { loadPools }            from '../lib/config.js';
import { getKeypair, getConnection, assertSufficientSol } from '../lib/wallet.js';
import { rpcLimiter }           from '../lib/rate-limiter.js';
import { PATHS } from '../../../config/paths.js';
import { classify, fetchJupiterPrices, DEFAULT_VALUE_THRESHOLD } from '../../../lib/scam-classify.js';
import { settle } from '../lib/settle-promise.js';
import { renderNotification } from '../../../lib/notify-render.js';
import { getLang, numLocale } from '../../../lib/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../');

// ─── CLI-Argumente ────────────────────────────────────────────────────────────

const REPORT     = process.argv.includes('--report');
// --report ist strikt read-only: ein versehentlich mitgegebenes --execute wird ignoriert.
const EXECUTE    = process.argv.includes('--execute') && !REPORT;
const SKIP_WARN  = process.argv.includes('--skip-warn');

// --json: genau EIN einzeiliges JSON-Objekt am Ende auf stdout, zusätzlich zur
// menschenlesbaren Ausgabe. Die Settings-Route liest die letzte Zeile, die mit
// '{' beginnt und mit '}' endet (Muster aus routes/pools-actions.js).
const JSON_OUT = process.argv.includes('--json');

// --yes: überspringt die Rückfrage. AUSSCHLIESSLICH für den UI-Pfad gedacht, wo
// die Belehrung im Browser stattfindet (Modal, bei Wert-Token mit Abtipp-Hürde).
// Der readline-Prompt bleibt für den Terminal-Aufruf unverändert erhalten — er
// wird hier übersprungen, nicht entfernt.
const ASSUME_YES = process.argv.includes('--yes');

const THRESHOLD_IDX = process.argv.indexOf('--threshold');
const VALUE_THRESHOLD = THRESHOLD_IDX > -1
    ? parseFloat(process.argv[THRESHOLD_IDX + 1])
    : DEFAULT_VALUE_THRESHOLD;

const MINT_PREFIXES = [];
for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--mint' && process.argv[i + 1]) {
        MINT_PREFIXES.push(process.argv[i + 1].slice(0, 12));
    }
}

const NEXUS          = 'http://127.0.0.1:3100';
const RENT_SOL       = 0.002;
const BATCH_SIZE     = 5;
const BATCH_PAUSE_MS = 10_000;

// ─── JSON-Ausgabe für den UI-Pfad ────────────────────────────────────────────
// Genau ein einzeiliges Objekt, immer als LETZTE stdout-Zeile. Die menschenlesbare
// Ausgabe bleibt daneben bestehen (sie enthält nie eine Zeile, die mit '{' beginnt
// und mit '}' endet, sonst würde der Parser der Settings-Route sie greifen).
let _jsonEmitted = false;
function emitJson(obj) {
    if (!JSON_OUT || _jsonEmitted) return;
    _jsonEmitted = true;
    process.stdout.write(JSON.stringify(obj) + '\n');
}

// ─── Single-Instance-Lock ─────────────────────────────────────────────────────

const LOCK_FILE = path.join(PATHS.liquidityData, 'close-scam-tokens.lock');

if (existsSync(LOCK_FILE)) {
    const pid = readFileSync(LOCK_FILE, 'utf8').trim();
    console.error(`[close-scam] Läuft bereits (PID ${pid}). Lock: ${LOCK_FILE}`);
    // Eigener Zustand statt generischem Fehler: der Wochen-Cron kann gerade laufen.
    // Die Oberfläche übersetzt 'busy' in "Prüfung läuft gerade" statt in eine
    // Fehlermeldung.
    emitJson({ ok: false, busy: true, error: 'scan_running', result: {} });
    process.exit(1);
}
writeFileSync(LOCK_FILE, String(process.pid));
const releaseLock = () => { try { unlinkSync(LOCK_FILE); } catch { } };
process.on('exit',    releaseLock);
process.on('SIGINT',  () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

// ─── Whitelist + bekannte Symbole aufbauen ────────────────────────────────────

function buildWhitelist() {
    const mints   = new Set();
    const symbols = new Map(); // mint → symbol (für Bekannte)

    // 1. wallet-monitor/config.json
    try {
        const wmCfg = JSON.parse(
            readFileSync(path.join(REPO_ROOT, 'core/wallet-monitor/config.json'), 'utf8')
        );
        for (const t of wmCfg.tokens ?? []) {
            if (t.mint) {
                mints.add(t.mint);
                if (t.symbol) symbols.set(t.mint, t.symbol);
            }
        }
    } catch { /* optional – weiter ohne */ }

    // 2. pools.json – Mints UND Symbole (aus pair-Feld "AAA/BBB")
    const { all: pools } = loadPools();
    for (const p of pools) {
        if (p.tokenA) mints.add(p.tokenA);
        if (p.tokenB) mints.add(p.tokenB);
        if (p.pair && p.tokenA && p.tokenB) {
            const [symA, symB] = p.pair.split('/');
            if (symA) symbols.set(p.tokenA, symA);
            if (symB) symbols.set(p.tokenB, symB);
        }
    }

    // 3. NFT-Positionen aus DB — ALLE, auch geschlossene.
    //
    // 🔴 Bewusst ohne `WHERE closed_at IS NULL` (Fix 2026-08-18). Ein Orca-CLMM-
    //    Positions-NFT hat Balance 1 und keinen Jupiter-Preis — exakt das Profil,
    //    das classify() als BURN einstuft. Läge ein NFT noch im Wallet, während
    //    seine DB-Position bereits geschlossen ist, würde es hier aus der Whitelist
    //    fallen und verbrannt: bei einer CLMM-Position ist das NFT der
    //    Eigentumsnachweis, die Liquidität wäre danach unerreichbar.
    //
    //    Dass dieser Zustand real vorkommt, ist im Code dokumentiert: das
    //    Rebalance-Pending-Flag in lib/cleanup-lock.js deckt genau den Fall
    //    "decreaseLiquidity OK, closePosition fehlgeschlagen" ab — dann bleibt das
    //    NFT liegen. Analog zum Vorfall beim LendingBot am 2026-08-12, wo ein
    //    LP-Token über dieselbe Lücke (Whitelist am Positionsstatus aufgehängt)
    //    irreversibel verbrannt wurde (~70 USDC, siehe Changelog).
    //
    //    Ein Mint, der je zu einer eigenen Position gehörte, darf nie Burn-Kandidat
    //    sein. Die Liste wächst nur um wenige hundert Einträge — vernachlässigbar
    //    gegenüber einem irreversiblen Verlust.
    const db = openDatabase();
    for (const { nft_mint } of db.prepare('SELECT nft_mint FROM positions WHERE nft_mint IS NOT NULL').all()) {
        if (nft_mint) mints.add(nft_mint);
    }
    db.close();

    return { mints, symbols };
}

// ─── Wallet-Token-Konten scannen (beide Programme) ───────────────────────────

async function scanTokenAccounts(keypair, conn) {
    const owner = keypair.publicKey;
    await rpcLimiter.wait();
    const [legacy, t2022] = await Promise.all([
        settle(conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })),
        settle(conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })),
    ]);

    const all = [...legacy.value, ...t2022.value];
    return all.map(a => {
        const info    = a.account.data.parsed.info;
        const program = a.account.owner.toBase58() === TOKEN_PROGRAM_ID.toBase58()
            ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
        return {
            pubkey:    a.pubkey,
            mint:      info.mint,
            uiAmount:  info.tokenAmount.uiAmount ?? 0,
            amount:    BigInt(info.tokenAmount.amount),
            decimals:  info.tokenAmount.decimals,
            // Die Konto-Miete steht in der RPC-Antwort schon drin. Mitzunehmen
            // kostet nichts und macht die Meldung "X SOL freigegeben" exakt statt
            // pauschal RENT_SOL (0,002) zu schätzen.
            lamports:  a.account.lamports ?? null,
            program,
        };
    });
}

// ─── Jupiter Preis-Batch ──────────────────────────────────────────────────────

async function fetchPrices(mints) {
    return fetchJupiterPrices(`${NEXUS}/jup/price/v3`, mints);
}

// ─── Helius DAS getAsset (Name + Symbol) ─────────────────────────────────────

async function fetchAssetMeta(mint) {
    try {
        await rpcLimiter.wait();
        const res = await fetch(config.rpcUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'getAsset',
                params: { id: mint },
            }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        const meta = json.result?.content?.metadata;
        return meta ? { name: meta.name ?? null, symbol: meta.symbol ?? null } : null;
    } catch { return null; }
}

// ─── GeckoTerminal TVL (top Pool des Tokens) ─────────────────────────────────

async function fetchTvl(mint) {
    try {
        const res = await fetch(
            `${NEXUS}/gecko/networks/solana/tokens/${mint}/pools?page=1`
        );
        if (!res.ok) return null;
        const json = await res.json();
        const pools = json.data ?? [];
        if (pools.length === 0) return 0;
        // Summe der reserve_in_usd aller geladenen Pools
        return pools.reduce((sum, p) => {
            const r = parseFloat(p.attributes?.reserve_in_usd ?? '0');
            return sum + (isNaN(r) ? 0 : r);
        }, 0);
    } catch { return null; }
}

// ─── Token-Alter: älteste on-chain-Signatur des Mint-Accounts ────────────────

async function fetchTokenAgeDays(mint, conn) {
    try {
        await rpcLimiter.wait();
        // limit: 100 reicht für Scam-Erkennung (neue Token haben < 100 Txs)
        const sigs = await conn.getSignaturesForAddress(
            new PublicKey(mint), { limit: 100 }
        );
        if (sigs.length === 0) return null;
        const oldest = sigs[sigs.length - 1];
        if (!oldest.blockTime) return null;
        return (Date.now() / 1000 - oldest.blockTime) / 86400;
    } catch { return null; }
}

// ─── Klassifizierung ─────────────────────────────────────────────────────────

// classify() lebt zentral in lib/scam-classify.js — siehe Kopf dieser Datei.

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function fmtUsdc(v)    { return v != null ? `${v.toFixed(3)} USDC` : '–'; }
function fmtTvl(v)     { return v == null ? '–' : v < 1000 ? `${v.toFixed(0)} USDC` : `${(v / 1000).toFixed(1)}k USDC`; }
function fmtAge(d)     {
    if (d == null) return '–';
    if (d < 1)     return `${Math.round(d * 24)}h`;
    const days = Math.round(d);
    if (days < 30) return `${days} ${days === 1 ? 'Tag' : 'Tage'}`;
    const months = Math.round(d / 30);
    return `${months} ${months === 1 ? 'Monat' : 'Monate'}`;
}
function shortMint(m)  { return `${m.slice(0, 6)}…${m.slice(-4)}`; }

function confirm(prompt) {
    return new Promise(resolve => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, ans => { rl.close(); resolve(ans.trim().toLowerCase() === 'yes'); });
    });
}

// ─── Telegram-Report via Nexus (lifecycle-Level → immer zugestellt) ───────────
// Baut die Nachricht direkt aus den klassifizierten Datenobjekten — kein Textparsing,
// kein Subprozess. Verschickt nur eine Übersicht; Löschen passiert weiterhin manuell.

async function sendReport(classified, walletAddr) {
    const nameFlagged  = classified.filter(t => t.dupSymbol);
    const otherFlagged = classified.filter(t => !t.dupSymbol && (t.tier === 'BURN' || t.tier === 'WARN'));

    if (nameFlagged.length === 0 && otherFlagged.length === 0) {
        return true;
    }

    const today = new Date().toLocaleDateString(numLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' });

    // msgKey statt fertigem Text (Schritt 5 der Mehrsprachigkeit) — sonst kommt
    // dieser Report auf einer EN-Installation trotzdem deutsch an, siehe
    // lib/notify-render.js.
    const msgKey  = 'notify.liq.scam_report';
    const params  = { today, wallet: shortMint(walletAddr) };
    let message = renderNotification(
        { msgKey, params, displayName: 'Liquidity Bot', timestamp: Date.now() },
        getLang(),
    );

    if (message.length > 3800) message = message.slice(0, 3800) + '\n…(gekürzt)';

    try {
        const res = await fetch(`${NEXUS}/notify`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                botId:       'liquidity',
                displayName: 'Liquidity Bot',
                level:       'lifecycle',
                category:    'scam-report',
                message, msgKey, params,
            }),
        });
        if (!res.ok) {
            console.error(`[close-scam] Report-Versand fehlgeschlagen: HTTP ${res.status}`);
            return false;
        }
        return true;
    } catch (err) {
        console.error(`[close-scam] Report-Versand fehlgeschlagen: ${err.message}`);
        return false;
    }
}


// Maschinenlesbare Sicht auf einen klassifizierten Token. Bewusst dieselben Felder,
// die die Oberfläche als Beleg anzeigt — UI und Burn sehen so nachweislich dasselbe.
function tokenJson(t) {
    return {
        mint:      t.mint,
        symbol:    t.meta?.symbol ?? null,
        name:      t.meta?.name ?? null,
        balance:   t.uiAmount,
        value:     t.value ?? null,
        tier:      t.tier,
        dupSymbol: t.dupSymbol ?? null,
        tvl:       t.tvl ?? null,
        ageDays:   t.ageDays ?? null,
    };
}

// ─── Hauptprogramm ───────────────────────────────────────────────────────────

const keypair = getKeypair();
const conn    = getConnection();

console.log('[close-scam] Starte Scan…');
console.log(`[close-scam] Wallet: ${keypair.publicKey.toBase58()}`);

// 1. Whitelist
const { mints: whitelist, symbols: knownSymbols } = buildWhitelist();
console.log(`[close-scam] Whitelist: ${whitelist.size} bekannte Mints`);

// 2. Wallet scannen
const allAccounts = await scanTokenAccounts(keypair, conn);
console.log(`[close-scam] Token-Konten im Wallet: ${allAccounts.length}`);

// 3. Unbekannte + Filter auf --mint-Prefix
let unknowns = allAccounts.filter(a =>
    !whitelist.has(a.mint) && a.uiAmount > 0
);
if (MINT_PREFIXES.length > 0) {
    unknowns = unknowns.filter(a => MINT_PREFIXES.some(p => a.mint.startsWith(p)));
}

if (unknowns.length === 0) {
    console.log('[close-scam] Keine unbekannten Token mit Balance gefunden. ✓');
    emitJson({ ok: true, result: { tokens: [], closed: [], failed: [] } });
    if (REPORT) {
        const ok = await sendReport([], keypair.publicKey.toBase58());
        process.exit(ok ? 0 : 1);
    }
    process.exit(0);
}

console.log(`[close-scam] ${unknowns.length} unbekannte Token → lade Daten…`);

// 4. Daten laden — Jupiter-Preis als Batch, pro Token sequenziell in 5er-Batches
const unknownMints = unknowns.map(a => a.mint);
const priceMap = await fetchPrices(unknownMints);

const tokens = [];
for (let i = 0; i < unknowns.length; i++) {
    if (i > 0 && i % BATCH_SIZE === 0) {
        console.log(`[close-scam] Batch-Pause ${BATCH_PAUSE_MS / 1000}s (andere Bots nicht blockieren)…`);
        await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
    }
    const a = unknowns[i];
    console.log(`[close-scam] (${i + 1}/${unknowns.length}) ${a.mint.slice(0, 12)}…`);
    const [meta, tvl, ageDays] = await Promise.all([
        settle(fetchAssetMeta(a.mint)),
        settle(fetchTvl(a.mint)),
        settle(fetchTokenAgeDays(a.mint, conn)),
    ]);
    tokens.push({ ...a, meta, tvl, ageDays });
}

// 5. Klassifizieren
const classified = tokens.map(t => {
    const pd = priceMap[t.mint];
    const cl = classify(t, pd, knownSymbols, { valueThreshold: VALUE_THRESHOLD });
    return { ...t, ...cl };
});

// 6. Report-Tabelle
console.log('');
console.log('─'.repeat(110));
console.log(
    'Symbol/Name'.padEnd(14) +
    'Mint'.padEnd(16) +
    'Balance'.padStart(10) +
    'Wert'.padStart(14) +
    'TVL'.padStart(14) +
    'Alter'.padStart(10) +
    'Name-Flag'.padStart(12) +
    'Rent'.padStart(9) +
    '  Stufe'
);
console.log('─'.repeat(110));

for (const t of classified) {
    const symbol   = t.meta?.symbol ?? t.meta?.name ?? '?';
    const nameFlag = t.dupSymbol ? `⚠ ${t.dupSymbol}` : '–';
    const action   = t.tier === 'SKIP'             ? 'unberührt' :
                     t.tier === 'REVIEW'           ? '⚠ MANUELL PRÜFEN (kein Auto-Burn)' :
                     t.tier === 'BURN'             ? 'BURN' :
                     SKIP_WARN                     ? 'übersprungen' : 'WARN→burn';
    console.log(
        symbol.slice(0, 13).padEnd(14) +
        shortMint(t.mint).padEnd(16) +
        String(t.uiAmount).padStart(10) +
        fmtUsdc(t.value).padStart(14) +
        fmtTvl(t.tvl).padStart(14) +
        fmtAge(t.ageDays).padStart(10) +
        nameFlag.padStart(12) +
        `${RENT_SOL} SOL`.padStart(9) +
        `  ${t.tier} → ${action}`
    );
}
console.log('─'.repeat(110));

// REVIEW-Token sind vom Sammel-Burn ausgenommen. Schließbar sind sie nur, wenn ihr
// Mint explizit per --mint benannt wurde — genau das ist die manuelle Prüfung, die
// die Stufe verlangt. Ohne diesen Pfad wäre REVIEW eine Sackgasse.
const burnable = classified.filter(t =>
    t.tier === 'BURN'
    || (t.tier === 'WARN' && !SKIP_WARN)
    || (t.tier === 'REVIEW' && MINT_PREFIXES.length > 0)
);
const totalRent = burnable.length * RENT_SOL;
console.log(`\n${burnable.length} Token-Konto(en) schließbar, ~${totalRent.toFixed(3)} SOL zurückholbar`);

// REVIEW-Token werden bewusst nie automatisch gebrannt — hier nochmal explizit
// ausweisen, damit sie nicht in der Tabelle untergehen.
const review = classified.filter(t => t.tier === 'REVIEW');
if (review.length > 0) {
    console.log(
        `\n⚠  ${review.length} Token mit Namens-Kollision UND Wert ≥ ${VALUE_THRESHOLD} USDC ` +
        `— NICHT automatisch verbrannt:`
    );
    for (const t of review) {
        console.log(
            `   • ${t.meta?.symbol ?? '?'} (${shortMint(t.mint)}) ` +
            `imitiert "${t.dupSymbol}", Wert ${fmtUsdc(t.value)}`
        );
    }
    console.log(`   Prüfen und ggf. gezielt schließen: --mint <mint-prefix> --execute (fragt nochmal nach)`);
}

// 6b. Report-Modus: Übersicht per Telegram, kein On-Chain-Effekt, kein execute-Pfad
if (REPORT) {
    const ok = await sendReport(classified, keypair.publicKey.toBase58());
    console.log(ok
        ? '[close-scam] Report an Telegram gesendet.'
        : '[close-scam] Report konnte NICHT gesendet werden (siehe Fehler oben).');
    process.exit(ok ? 0 : 1);
}

// 7. Dry-Run-Exit
if (!EXECUTE) {
    emitJson({ ok: true, dryRun: true, result: { tokens: classified.map(tokenJson), closed: [], failed: [] } });
    console.log('\n[close-scam] Dry-Run – kein On-Chain-Effekt.');
    console.log('             Zum Ausführen: node bin/close-scam-tokens.js --execute');
    process.exit(0);
}

if (burnable.length === 0) {
    console.log('[close-scam] Nichts zu tun.');
    emitJson({ ok: true, result: { tokens: classified.map(tokenJson), closed: [], failed: [] } });
    process.exit(0);
}

// 8. Bestätigung (außer wenn --mint explizit angegeben).
// Bei REVIEW-Token wird trotz --mint nachgefragt: die Stufe bedeutet nennenswerten
// Wert auf dem Konto, da ist ein Vertipper im Mint-Prefix teuer.
const reviewInBurnable = burnable.some(t => t.tier === 'REVIEW');
if (!ASSUME_YES && (MINT_PREFIXES.length === 0 || reviewInBurnable)) {
    const ok = await confirm(
        `\n${burnable.length} Token-Konto(en) verbrennen und schließen?` +
        (reviewInBurnable ? ` (davon ${burnable.filter(t => t.tier === 'REVIEW').length}× REVIEW mit Wert!)` : '') +
        ` [yes/N] `
    );
    if (!ok) {
        console.log('[close-scam] Abgebrochen.');
        emitJson({ ok: false, error: 'aborted', result: {} });
        process.exit(0);
    }
}

// 9. Ausführen
await assertSufficientSol(keypair.publicKey);

let closed = 0;
const closedJson = [];
const failedJson = [];
for (const t of burnable) {
    try {
        const mintPubkey    = new PublicKey(t.mint);
        const accountPubkey = t.pubkey;
        const owner         = keypair.publicKey;
        const program       = t.program;

        const tx = new Transaction();

        // Erst burn (falls Balance > 0), dann closeAccount
        if (t.amount > 0n) {
            tx.add(createBurnInstruction(
                accountPubkey, mintPubkey, owner, t.amount, [], program
            ));
        }
        tx.add(createCloseAccountInstruction(
            accountPubkey, owner, owner, [], program
        ));

        await rpcLimiter.wait();
        const sig = await sendAndConfirmTransaction(conn, tx, [keypair]);
        const symbol = t.meta?.symbol ?? t.meta?.name ?? t.mint.slice(0, 8);
        const freedSol = t.lamports != null ? t.lamports / LAMPORTS_PER_SOL : RENT_SOL;
        console.log(`  ✅ ${symbol} (${shortMint(t.mint)}) geschlossen | TX=${sig} | ${freedSol.toFixed(6)} SOL frei`);
        closedJson.push({ ...tokenJson(t), signature: sig, freedSol });
        closed++;
    } catch (err) {
        console.error(`  ❌ Fehler bei ${t.mint}: ${err.message}`);
        failedJson.push({ ...tokenJson(t), error: err.message });
    }
}

emitJson({
    ok: failedJson.length === 0,
    result: {
        tokens:   classified.map(tokenJson),
        closed:   closedJson,
        failed:   failedJson,
        freedSol: closedJson.reduce((sum, c) => sum + c.freedSol, 0),
    },
});

console.log(`\n[close-scam] Fertig: ${closed}/${burnable.length} Token-Konten geschlossen.`);
console.log(`[close-scam] SOL-Rent zurückgeholt: ~${(closed * RENT_SOL).toFixed(3)} SOL`);
