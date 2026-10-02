#!/usr/bin/env node
/**
 * FORGE Liquidity – Wallet-Flow-Scan (LIQ#001063)
 *
 * Findet Geld, das das Bot-Wallet mit der Außenwelt tauscht, und bucht es in
 * `wallet_flows` (Migration + insertWalletFlow(): lib/db.js, LIQ#001062). Grundlage
 * des künftigen Portfolio-PnL ("Gesamtwert-Delta minus diese Zeilen", lib/pnl.js,
 * LIQ#001062) — ohne diese Tabelle ist eine externe Einzahlung nicht von echtem
 * Gewinn zu unterscheiden.
 *
 * WARUM EIN SCAN, WENN DIE DREI SENDE-STELLEN SCHON SELBST BUCHEN
 * ────────────────────────────────────────────────────────────────
 * (routes/wallet.js /liquidity/send, lib/exit-finalizer.js executeTransferStep,
 * bin/transfer.js): Die Quellbuchung deckt nur ab, was der Bot SELBST verschickt.
 * Ein Zufluss von außen (der Nutzer zahlt ein) hat keine solche Stelle — und
 * insertWalletFlow() ist idempotent je (tx_hash, mint), die Quellbuchung gewinnt
 * also ohnehin, falls beide dieselbe Tx sehen.
 *
 * WARUM AUCH DIE TOKEN-KONTEN SELBST GESCANNT WERDEN, NICHT NUR DIE WALLET
 * ─────────────────────────────────────────────────────────────────────────
 * `getSignaturesForAddress(wallet)` liefert nur Transaktionen, in denen die
 * Wallet-Adresse selbst als Account-Key auftaucht. Bei einer SPL-Überweisung auf
 * ein BEREITS EXISTIERENDES Token-Konto (ATA) referenziert die Transfer-Instruktion
 * nur Quell-ATA, Ziel-ATA und den Quell-Owner — der EMPFÄNGER-Owner (unsere Wallet)
 * taucht nirgends auf. Nur die ERSTE Einzahlung auf ein noch nicht existierendes ATA
 * ist sichtbar, weil dessen Anlage die Wallet als "owner"-Account referenziert.
 * Jede Folge-Einzahlung auf ein bereits bestehendes Konto wäre sonst unsichtbar.
 * Deshalb: zusätzlich zur Wallet selbst wird jedes aktuell existierende Token-Konto
 * der Wallet (unabhängig vom Kontostand, auch 0) einzeln gescannt.
 *
 * WAS "EXTERN" HEISST
 * ────────────────────
 * Eine Tx gilt nur dann als Wallet↔außen-Fluss, wenn AUSSCHLIESSLICH System-,
 * Token-, Token-2022-, ATA-, ComputeBudget- oder Memo-Programm aufgerufen werden
 * (top-level UND in inneren Instruktionen) UND sich der Saldo der Wallet dabei
 * ändert. Jede andere Programmbeteiligung (Orca, Jupiter, …) ist ein interner
 * Vorgang (Swap, Claim, Deposit/Withdraw in eine Position) und wird ignoriert —
 * diese laufen bereits über `transactions`/`capital_flows`/`chain_tx_log`.
 *
 * SOL/WSOL: Deltas desselben Vorgangs werden zu einem Saldo verrechnet (Wrap/Unwrap
 * ist kein Fluss). Ist die Wallet Fee-Payer, wird die TX-Gebühr vorher wieder
 * zum SOL-Delta addiert — sie ist Betriebskosten, kein Abfluss an einen Dritten.
 *
 * Unbekannte Mints ohne Kurs (Scam-Token, siehe lib/scam-classify.js, oder schlicht
 * kein Pool dafür) werden NICHT gebucht, sondern nur geloggt — eine geratene Bewertung
 * wäre schlimmer als eine fehlende Zeile.
 *
 * Nutzung:
 *   node bin/wallet-flow-scan.js                        Inkrementell (Marke in kv_config);
 *                                                        ohne Abdeckungsmarke einmalig 30 Tage nachtragen
 *   node bin/wallet-flow-scan.js --dry-run               Nur auflisten, nichts schreiben
 *   node bin/wallet-flow-scan.js --backfill-days 30       Rückwirkend, ignoriert die Marke
 *   node bin/wallet-flow-scan.js --backfill-days 30 --dry-run
 *
 * Cron: alle 30 Minuten (config/cron-jobs.json, LIQ#001063, Intervall wegen Helius-Budget).
 */

import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getKeypair, getConnection, getConnectionFresh } from '../lib/wallet.js';
import { openDatabase, kvGet, kvSet, insertWalletFlow } from '../lib/db.js';
import { getWalletFlowUsdPrice, WSOL_MINT, USDC_MINT } from '../lib/wallet-flow-price.js';
import { rpcLimiter } from '../lib/rate-limiter.js';

// ─── --help ─────────────────────────────────────────────────────────────────
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
FORGE Liquidity – Wallet-Flow-Scan (bin/wallet-flow-scan.js)

  node bin/wallet-flow-scan.js                    Inkrementell ab der letzten Marke
  node bin/wallet-flow-scan.js --dry-run          Nur auflisten, keine DB-Schreibzugriffe
  node bin/wallet-flow-scan.js --backfill-days N  Rückwirkend N Tage, ignoriert die Marke
`);
    process.exit(0);
}

const DRY_RUN         = process.argv.includes('--dry-run');
const VERBOSE         = process.argv.includes('--verbose');
const backfillIdx     = process.argv.indexOf('--backfill-days');
const BACKFILL_ARG    = backfillIdx !== -1 ? parseInt(process.argv[backfillIdx + 1], 10) : null;
if (backfillIdx !== -1 && (!Number.isFinite(BACKFILL_ARG) || BACKFILL_ARG <= 0)) {
    console.error('[wallet-flow-scan] --backfill-days braucht eine positive Zahl.');
    process.exit(1);
}

/** Programme, die eine Tx NICHT automatisch zu einem internen Vorgang machen. */
const ALLOWED_PROGRAMS = new Set([
    '11111111111111111111111111111111',              // System Program
    TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    'ComputeBudget111111111111111111111111111111',
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',    // Memo v2
    'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',    // Memo v1 (legacy)
]);

const KV_STATE_KEY   = 'wallet_flow_scan_state';       // JSON { [address]: lastSignature }
const KV_COVERED_KEY = 'wallet_flows_covered_since';
const SIG_PAGE_LIMIT = 1000;
const MIN_BOOKABLE_USD = 0.01;
// Erster Lauf einer Installation (noch keine Abdeckungsmarke): automatisch so viele Tage
// nachtragen. Ohne das bliebe die Marke auf jeder Installation, auf der niemand von Hand
// --backfill-days ausführt (FORGE public), für immer leer — der Portfolio-PnL in lib/pnl.js
// fiele dort dauerhaft auf die Pool-Summe zurück (LIQ#001062). 30 Tage = Monatskarte.
const AUTO_BACKFILL_DAYS = 30;   // Rundungs-/Lamport-Reste sind keine Buchung wert

let rpcCallsSigs = 0, rpcCallsTx = 0;

// ─── Scan-Adressen ermitten ──────────────────────────────────────────────────

/**
 * Wallet-Adresse selbst + jedes aktuell existierende Token-Konto (ATA), unabhängig
 * vom Kontostand — siehe Dateikopf, WARUM AUCH DIE TOKEN-KONTEN SELBST GESCANNT.
 * @returns {Promise<{address: string, kind: 'wallet'|'token_account', mint: string|null}[]>}
 */
async function scanTargets(connection, walletPubkey) {
    const targets = [{ address: walletPubkey.toBase58(), kind: 'wallet', mint: null }];
    await rpcLimiter.wait();
    const [spl, t22] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(walletPubkey, { programId: TOKEN_PROGRAM_ID }),
        connection.getParsedTokenAccountsByOwner(walletPubkey, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);
    for (const { pubkey, account } of [...spl.value, ...t22.value]) {
        targets.push({ address: pubkey.toBase58(), kind: 'token_account', mint: account.data.parsed.info.mint });
    }
    return targets;
}

// ─── Signaturen holen ─────────────────────────────────────────────────────────

/**
 * Alle Signaturen einer Adresse seit `untilSig` (exklusiv), paginiert. Ohne
 * `untilSig` (Erstlauf) wird NICHTS geholt — nur die neueste Signatur als
 * Startmarke gesetzt, siehe main(). Backfill nutzt stattdessen `cutoffMs`.
 */
async function fetchSignatures(connection, address, { untilSig = null, cutoffMs = null } = {}) {
    const pubkey = new PublicKey(address);
    const out = [];
    let before;
    for (;;) {
        await rpcLimiter.wait();
        rpcCallsSigs++;
        const page = await connection.getSignaturesForAddress(
            pubkey, { limit: SIG_PAGE_LIMIT, before, until: untilSig ?? undefined }
        );
        if (page.length === 0) break;
        out.push(...page);
        const last = page[page.length - 1];
        if (cutoffMs != null && last.blockTime != null && last.blockTime * 1000 < cutoffMs) break;
        if (page.length < SIG_PAGE_LIMIT) break;
        before = last.signature;
    }
    if (cutoffMs != null) return out.filter(s => s.blockTime == null || s.blockTime * 1000 >= cutoffMs);
    return out;
}

function isTxKnown(db, txHash) {
    return !!(
        db.prepare(`SELECT 1 FROM transactions WHERE tx_hash = ? LIMIT 1`).get(txHash) ||
        db.prepare(`SELECT 1 FROM chain_tx_log WHERE tx_hash = ? LIMIT 1`).get(txHash) ||
        db.prepare(`SELECT 1 FROM capital_flows WHERE tx_hash = ? LIMIT 1`).get(txHash) ||
        db.prepare(`SELECT 1 FROM wallet_flows WHERE tx_hash = ? LIMIT 1`).get(txHash)
    );
}

/** Programme dieser Tx (top-level + innere Instruktionen), als Set von Base58-Strings. */
function programsInTx(tx) {
    const programs = new Set();
    for (const ix of tx.transaction.message.instructions) programs.add(ix.programId.toBase58?.() ?? String(ix.programId));
    for (const inner of tx.meta.innerInstructions ?? []) {
        for (const ix of inner.instructions) programs.add(ix.programId.toBase58?.() ?? String(ix.programId));
    }
    return programs;
}

/**
 * Token- + SOL-Deltas der Wallet in dieser Tx, WSOL und natives SOL bereits zu
 * einem Saldo verrechnet (Wrap/Unwrap-Vorgänge heben sich damit auf).
 * @returns {Map<string, number>} mint → Delta (uiAmount, + Zufluss / − Abfluss)
 */
function walletDeltas(tx, walletAddr) {
    const deltas = new Map();

    const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
    const walletIdx = accountKeys.indexOf(walletAddr);
    if (walletIdx !== -1) {
        const pre  = tx.meta.preBalances[walletIdx]  ?? 0;
        const post = tx.meta.postBalances[walletIdx] ?? 0;
        // Ist die Wallet Fee-Payer (immer Index 0), war ein Teil des scheinbaren
        // Abflusses nur die TX-Gebühr — Betriebskosten, kein Fluss an Dritte.
        const fee = walletIdx === 0 ? (tx.meta.fee ?? 0) : 0;
        const solDelta = (post - pre + fee) / 1e9;
        if (Math.abs(solDelta) > 1e-9) deltas.set(WSOL_MINT, (deltas.get(WSOL_MINT) ?? 0) + solDelta);
    }

    const key = b => `${b.owner}|${b.mint}`;
    const pre  = new Map((tx.meta.preTokenBalances  ?? []).filter(b => b.owner === walletAddr).map(b => [key(b), b.uiTokenAmount.uiAmount ?? 0]));
    const post = new Map((tx.meta.postTokenBalances ?? []).filter(b => b.owner === walletAddr).map(b => [key(b), b.uiTokenAmount.uiAmount ?? 0]));
    for (const k of new Set([...pre.keys(), ...post.keys()])) {
        const mint  = k.split('|')[1];
        const delta = (post.get(k) ?? 0) - (pre.get(k) ?? 0);
        if (Math.abs(delta) > 1e-9) deltas.set(mint, (deltas.get(mint) ?? 0) + delta);
    }

    return deltas;
}

/** Bestmögliche Gegenadresse: der andere Account, dessen Saldo sich um denselben
 *  Betrag in die Gegenrichtung geändert hat. `null` wenn nicht eindeutig. */
function findCounterparty(tx, walletAddr, mint, amount) {
    const EPS = 1e-6;
    if (mint === WSOL_MINT) {
        const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
        for (let i = 0; i < accountKeys.length; i++) {
            if (accountKeys[i] === walletAddr) continue;
            const delta = ((tx.meta.postBalances[i] ?? 0) - (tx.meta.preBalances[i] ?? 0)) / 1e9;
            if (Math.abs(delta + amount) < EPS) return accountKeys[i];
        }
        return null;
    }
    const others = new Map();
    for (const b of tx.meta.preTokenBalances ?? []) {
        if (b.mint !== mint || b.owner === walletAddr) continue;
        others.set(b.owner, (others.get(b.owner) ?? 0) - (b.uiTokenAmount.uiAmount ?? 0));
    }
    for (const b of tx.meta.postTokenBalances ?? []) {
        if (b.mint !== mint || b.owner === walletAddr) continue;
        others.set(b.owner, (others.get(b.owner) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
    }
    for (const [owner, delta] of others) {
        if (Math.abs(delta + amount) < EPS) return owner;
    }
    return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const db         = openDatabase();
    const keypair    = getKeypair();
    const walletAddr = keypair.publicKey.toBase58();
    const connFresh  = getConnectionFresh();
    const conn       = getConnection();

    console.log(`[wallet-flow-scan] Wallet: ${walletAddr}${DRY_RUN ? '  (DRY-RUN)' : ''}`);

    const state = JSON.parse(kvGet(db, KV_STATE_KEY, '{}'));
    const BACKFILL_DAYS = BACKFILL_ARG ??
        (kvGet(db, KV_COVERED_KEY, null) == null ? AUTO_BACKFILL_DAYS : null);
    if (BACKFILL_ARG == null && BACKFILL_DAYS != null) {
        console.log(`[wallet-flow-scan] Noch keine Abdeckung — einmaliger Nachtrag über ${BACKFILL_DAYS} Tage.`);
    }
    const cutoffMs = BACKFILL_DAYS != null ? Date.now() - BACKFILL_DAYS * 86_400_000 : null;

    const targets = await scanTargets(connFresh, keypair.publicKey);
    console.log(`[wallet-flow-scan] ${targets.length} Scan-Ziele (Wallet + Token-Konten).`);

    let booked = 0, skippedKnown = 0, skippedInternal = 0, skippedNoPrice = 0, firstRun = 0;
    const bookedRows = [];

    for (const target of targets) {
        const untilSig = BACKFILL_DAYS != null ? null : state[target.address] ?? null;

        if (BACKFILL_DAYS == null && !untilSig) {
            // Erstlauf für diese Adresse: nur Startmarke setzen, kein Nachtrag ohne
            // --backfill-days (siehe fetchSignatures-Doku).
            await rpcLimiter.wait();
            rpcCallsSigs++;
            const [latest] = await connFresh.getSignaturesForAddress(new PublicKey(target.address), { limit: 1 });
            if (latest && !DRY_RUN) state[target.address] = latest.signature;
            firstRun++;
            continue;
        }

        const sigs = await fetchSignatures(connFresh, target.address, { untilSig, cutoffMs });
        const successful = sigs.filter(s => s.err == null).reverse(); // älteste zuerst

        for (const s of successful) {
            if (isTxKnown(db, s.signature)) { skippedKnown++; continue; }

            await rpcLimiter.wait();
            rpcCallsTx++;
            let tx;
            try {
                tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
            } catch (err) {
                console.warn(`[wallet-flow-scan] ${s.signature.slice(0, 12)}… nicht lesbar (${err.message}) – übersprungen`);
                continue;
            }
            if (!tx?.meta) { console.warn(`[wallet-flow-scan] ${s.signature.slice(0, 12)}… nicht lesbar – übersprungen`); continue; }

            // Hat das Bot-Wallet NICHT signiert, kann nur ein Fremder Geld geschickt haben —
            // egal über welches Programm (Börsen-Auszahlung, Wallet-App, „Swap and send“).
            // pub2 25.09.2026: 100 USDC Einzahlung lief über ein Fremdprogramm und wäre mit
            // der reinen Programmliste als intern verworfen worden (LIQ#001062). Die
            // Programmliste entscheidet nur bei Tx, die der Bot selbst signiert hat.
            const botSigned = tx.transaction.message.accountKeys
                .some(k => k.signer && (k.pubkey?.toBase58?.() ?? String(k.pubkey)) === walletAddr);
            const programs = programsInTx(tx);
            const isExternal = !botSigned || [...programs].every(p => ALLOWED_PROGRAMS.has(p));
            if (!isExternal) {
                skippedInternal++;
                if (VERBOSE) {
                    const foreign = [...programs].filter(p => !ALLOWED_PROGRAMS.has(p));
                    console.log(`[wallet-flow-scan] (intern) ${s.signature.slice(0, 12)}… Fremdprogramm(e): ${foreign.join(', ')}`);
                }
                continue;
            }

            const deltas = walletDeltas(tx, walletAddr);
            const whenMs = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;

            for (const [mint, amount] of deltas) {
                if (Math.abs(amount) < 1e-9) continue;
                const usdPrice = getWalletFlowUsdPrice(db, mint, whenMs);
                if (usdPrice == null) {
                    skippedNoPrice++;
                    console.warn(`[wallet-flow-scan] ${s.signature.slice(0, 12)}… Mint ${mint}: kein Kurs zum ${new Date(whenMs).toLocaleString('de-DE')} – nicht gebucht`);
                    continue;
                }
                const usdValue = amount * usdPrice;
                if (Math.abs(usdValue) < MIN_BOOKABLE_USD) continue;

                const counterparty = findCounterparty(tx, walletAddr, mint, amount);
                const row = { txHash: s.signature, mint, amount, usdValue, counterparty, whenMs };
                bookedRows.push(row);

                if (DRY_RUN) {
                    console.log(`[wallet-flow-scan] (dry) ${amount > 0 ? 'Zufluss' : 'Abfluss'} ${usdValue.toFixed(2)} USD` +
                        ` (${amount.toFixed(6)} ${mint.slice(0, 8)}…) ${new Date(whenMs).toLocaleString('de-DE')}` +
                        ` von/an ${counterparty ?? '?'} – ${s.signature}`);
                } else {
                    insertWalletFlow(db, {
                        txHash: s.signature, mint, amount, usdValue,
                        counterparty, source: 'chain_scan', createdAt: whenMs,
                    });
                    console.log(`[wallet-flow-scan] ✓ ${amount > 0 ? 'Zufluss' : 'Abfluss'} ${usdValue.toFixed(2)} USD gebucht – ${s.signature}`);
                }
                booked++;
            }
        }

        if (!DRY_RUN && sigs.length) state[target.address] = sigs[0].signature; // neueste zuerst
    }

    if (!DRY_RUN) {
        kvSet(db, KV_STATE_KEY, JSON.stringify(state));
        if (BACKFILL_DAYS != null) {
            const existing = kvGet(db, KV_COVERED_KEY, null);
            const backfillStart = Date.now() - BACKFILL_DAYS * 86_400_000;
            if (!existing || Number(existing) > backfillStart) kvSet(db, KV_COVERED_KEY, String(backfillStart));
        }
    }

    console.log('');
    console.log(`[wallet-flow-scan] Fertig: ${booked} ${DRY_RUN ? 'gefunden (dry-run)' : 'gebucht'}, ` +
        `${skippedKnown} bereits bekannt, ${skippedInternal} intern, ${skippedNoPrice} ohne Kurs, ` +
        `${firstRun} Adresse(n) im Erstlauf nur markiert.`);
    console.log(`[wallet-flow-scan] RPC-Calls: ${rpcCallsSigs} getSignaturesForAddress, ${rpcCallsTx} getTransaction.`);

    db.close();
}

main().catch(err => {
    console.error(`[wallet-flow-scan] Fehler: ${err.stack || err.message}`);
    process.exit(1);
});
