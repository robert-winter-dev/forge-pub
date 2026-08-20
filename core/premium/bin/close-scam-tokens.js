/**
 * close-scam-tokens.js (Premium-Wallet)
 *
 * Gegenstück zu `bots/liquidity/bin/close-scam-tokens.js` und
 * `bots/lending/bin/close-scam-tokens.js`, aber für das Premium-Wallet.
 *
 * Warum trotz zwei vorhandener Fassungen eine dritte Datei: die beiden anderen
 * hängen fest an ihrem Bot (Keypair, Pool-Liste, Positions-NFTs, Protokoll-Mints).
 * Das Premium-Wallet hat nichts davon — es hält ausschließlich SOL und eine kleine
 * USDC-Reserve für die stündliche Premium-Zahlung. Deshalb ist das hier bewusst die
 * schlanke Variante ohne TVL- und Alters-Abfrage: beide sind reine Anzeigewerte, die
 * die Oberfläche ohnehin aus `wallet-monitor` bezieht, und jeder gesparte Call zählt.
 *
 * 🔒 Die Einstufung selbst kommt aus `lib/scam-classify.js` — dieselbe Funktion, die
 * auch die Settings-Route zur Anzeige benutzt. Eine eigene Kopie hätte genau die
 * Drift erzeugt, die `LIQ#0299` schon einmal aufgedeckt hat.
 *
 * Existiert nur sinnvoll auf einem FORGE-public-Fork: der Master hat kein
 * Premium-Wallet (`PREMIUM_WALLET_PATH` ungesetzt), das Skript endet dort sauber
 * mit einer Meldung.
 *
 * Aufruf:
 *   node bin/close-scam-tokens.js                                   # Dry-Run
 *   node bin/close-scam-tokens.js --execute                         # mit Rückfrage
 *   node bin/close-scam-tokens.js --mint <prefix> --execute         # gezielt
 *   node bin/close-scam-tokens.js --mint <prefix> --execute --yes --json   # UI-Pfad
 */

import { readFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import Database from 'better-sqlite3';
import {
    PublicKey,
    Transaction,
    Connection,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    createBurnInstruction,
    createCloseAccountInstruction,
} from '@solana/spl-token';

import { FORGE_ROOT } from '../../../config/paths.js';
import { loadPremiumKeypair, walletExists } from '../../../lib/premium-wallet.js';
import { classify, fetchJupiterPrices, buildKnownTokens, DEFAULT_VALUE_THRESHOLD } from '../../../lib/scam-classify.js';

const NEXUS = 'http://127.0.0.1:3100';

// ─── CLI-Argumente ───────────────────────────────────────────────────────────

const EXECUTE    = process.argv.includes('--execute');
const JSON_OUT   = process.argv.includes('--json');
// --yes überspringt die Rückfrage, NUR für den UI-Pfad: dort findet die Belehrung
// im Browser statt (Modal, bei Wert-Token zusätzlich mit Abtipp-Hürde). Der Prompt
// unten bleibt für den Terminal-Aufruf unverändert bestehen.
const ASSUME_YES = process.argv.includes('--yes');

const THRESHOLD_IDX   = process.argv.indexOf('--threshold');
const VALUE_THRESHOLD = THRESHOLD_IDX > -1
    ? parseFloat(process.argv[THRESHOLD_IDX + 1])
    : DEFAULT_VALUE_THRESHOLD;

const MINT_PREFIXES = [];
for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--mint' && process.argv[i + 1]) {
        MINT_PREFIXES.push(process.argv[i + 1].slice(0, 12));
    }
}

let _jsonEmitted = false;
function emitJson(obj) {
    if (!JSON_OUT || _jsonEmitted) return;
    _jsonEmitted = true;
    process.stdout.write(JSON.stringify(obj) + '\n');
}

function shortMint(m) { return `${m.slice(0, 6)}…${m.slice(-4)}`; }
function fmtUsdc(v)   { return v != null ? `${v.toFixed(3)} USDC` : '–'; }

function confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(res => rl.question(question, a => {
        rl.close();
        res(a.trim().toLowerCase() === 'yes');
    }));
}

function tokenJson(t) {
    return {
        mint:      t.mint,
        symbol:    t.meta?.symbol ?? null,
        name:      t.meta?.name ?? null,
        balance:   t.uiAmount,
        value:     t.value ?? null,
        tier:      t.tier,
        dupSymbol: t.dupSymbol ?? null,
        tvl:       null,
        ageDays:   null,
    };
}

// ─── Datenquellen ────────────────────────────────────────────────────────────

async function fetchAssetMeta(mint) {
    try {
        const res = await fetch(`${NEXUS}/rpc`, {
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

async function scanTokenAccounts(conn, owner) {
    const [legacy, t2022] = await Promise.all([
        conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
        conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);
    return [...legacy.value, ...t2022.value].map(a => {
        const info    = a.account.data.parsed.info;
        const program = a.account.owner.toBase58() === TOKEN_PROGRAM_ID.toBase58()
            ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
        return {
            pubkey:   a.pubkey,
            mint:     info.mint,
            uiAmount: info.tokenAmount.uiAmount ?? 0,
            amount:   BigInt(info.tokenAmount.amount),
            // Die Konto-Miete steht in der Antwort schon drin — kostet nichts und
            // macht die Meldung "X SOL freigegeben" exakt statt geschätzt.
            lamports: a.account.lamports ?? null,
            program,
        };
    });
}

// ─── Hauptprogramm ───────────────────────────────────────────────────────────

if (!walletExists()) {
    console.log('[close-scam-premium] Kein Premium-Wallet konfiguriert – nichts zu tun.');
    emitJson({ ok: true, result: { tokens: [], closed: [], failed: [] } });
    process.exit(0);
}

const keypair = loadPremiumKeypair();
const conn    = new Connection(`${NEXUS}/rpc`, 'confirmed');
const owner   = keypair.publicKey;

console.log(`[close-scam-premium] Wallet: ${owner.toBase58()}`);

// Whitelist: SOL/USDC plus die überwachten Token. Positions-NFTs gibt es hier
// nicht — das Premium-Wallet hält keine Pool-Positionen.
const { mints: whitelist, symbols: knownSymbols } = buildKnownTokens({
    forgeRoot: FORGE_ROOT,
    deps: { readFileSync, existsSync, Database },
});
console.log(`[close-scam-premium] Whitelist: ${whitelist.size} bekannte Mints`);

const allAccounts = await scanTokenAccounts(conn, owner);
let unknowns = allAccounts.filter(a => !whitelist.has(a.mint) && a.uiAmount > 0);
if (MINT_PREFIXES.length > 0) {
    unknowns = unknowns.filter(a => MINT_PREFIXES.some(p => a.mint.startsWith(p)));
}

if (unknowns.length === 0) {
    console.log('[close-scam-premium] Keine unbekannten Token mit Balance gefunden. ✓');
    emitJson({ ok: true, result: { tokens: [], closed: [], failed: [] } });
    process.exit(0);
}

const priceMap = await fetchJupiterPrices(`${NEXUS}/jup/price/v3`, unknowns.map(a => a.mint));

const classified = [];
for (const a of unknowns) {
    const meta = await fetchAssetMeta(a.mint);
    const cl   = classify({ ...a, meta }, priceMap[a.mint], knownSymbols, { valueThreshold: VALUE_THRESHOLD });
    classified.push({ ...a, meta, ...cl });
}

for (const t of classified) {
    console.log(
        `  ${(t.meta?.symbol ?? '?').slice(0, 12).padEnd(13)}` +
        `${shortMint(t.mint).padEnd(14)}` +
        `${String(t.uiAmount).padStart(12)}` +
        `${fmtUsdc(t.value).padStart(14)}` +
        `  ${t.tier}${t.dupSymbol ? ` (imitiert "${t.dupSymbol}")` : ''}`
    );
}

// REVIEW nur schließbar, wenn der Mint ausdrücklich benannt wurde — dieselbe Regel
// wie in den Bot-Fassungen. WARN wird hier NIE automatisch verbrannt: ohne Preis
// und ohne Symbol-Kollision haben wir keine Evidenz, nur fehlende Information.
const burnable = classified.filter(t =>
    t.tier === 'BURN' || (t.tier === 'REVIEW' && MINT_PREFIXES.length > 0)
);

if (!EXECUTE) {
    emitJson({ ok: true, dryRun: true, result: { tokens: classified.map(tokenJson), closed: [], failed: [] } });
    console.log('\n[close-scam-premium] Dry-Run – kein On-Chain-Effekt.');
    process.exit(0);
}

if (burnable.length === 0) {
    console.log('[close-scam-premium] Nichts zu tun.');
    emitJson({ ok: true, result: { tokens: classified.map(tokenJson), closed: [], failed: [] } });
    process.exit(0);
}

const reviewInBurnable = burnable.some(t => t.tier === 'REVIEW');
if (!ASSUME_YES && (MINT_PREFIXES.length === 0 || reviewInBurnable)) {
    const ok = await confirm(
        `\n${burnable.length} Token-Konto(en) verbrennen und schließen?` +
        (reviewInBurnable ? ` (davon ${burnable.filter(t => t.tier === 'REVIEW').length}× REVIEW mit Wert!)` : '') +
        ` [yes/N] `
    );
    if (!ok) {
        console.log('[close-scam-premium] Abgebrochen.');
        emitJson({ ok: false, error: 'aborted', result: {} });
        process.exit(0);
    }
}

const closedJson = [];
const failedJson = [];
for (const t of burnable) {
    try {
        const tx = new Transaction();
        if (t.amount > 0n) {
            tx.add(createBurnInstruction(t.pubkey, new PublicKey(t.mint), owner, t.amount, [], t.program));
        }
        tx.add(createCloseAccountInstruction(t.pubkey, owner, owner, [], t.program));

        const sig      = await sendAndConfirmTransaction(conn, tx, [keypair]);
        const freedSol = t.lamports != null ? t.lamports / LAMPORTS_PER_SOL : 0.002;
        console.log(`  ✅ ${t.meta?.symbol ?? shortMint(t.mint)} geschlossen | TX=${sig} | ${freedSol.toFixed(6)} SOL frei`);
        closedJson.push({ ...tokenJson(t), signature: sig, freedSol });
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

console.log(`\n[close-scam-premium] Fertig: ${closedJson.length}/${burnable.length} Konten geschlossen.`);
