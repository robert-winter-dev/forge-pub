#!/usr/bin/env node
/**
 * FORGE.pub Premium – Zahl-Skript (FORK-ONLY, FINANZ-SKRIPT)
 *
 * Zahlt aus dem Premium-Wallet (lib/premium-wallet.js) die aktuelle Stunde des
 * FORGE.pub-Datendienstes: eine USDC-Transaktion an die vom Master signiert
 * mitgeteilte Empfangsadresse, mit dem Memo `FP1:<T>:<hourId>` (lib/premium-memo.js).
 * Der Master-seitige Zahlungs-Watcher (payment-watcher.js) ordnet die Zahlung
 * darüber der eigenen Aktivierung zu und schaltet die nächste Blob-Zustellung frei.
 *
 * Bewegt echtes Kapital — wie jedes Finanz-Skript in FORGE grundsätzlich manuell
 * vom Nutzer ausgeführt, nie automatisch von Claude. --help und --dry-run müssen
 * VOR jedem Seiteneffekt greifen.
 *
 *   node core/premium/premium-pay.js --help
 *   node core/premium/premium-pay.js --dry-run
 *   node core/premium/premium-pay.js
 *
 * Läuft als Cron stündlich (config/cron-jobs.json), gated durch lib/premium-auto-
 * pay-store.js: ohne den Ein/Aus-Schalter auf der Verwalten-Seite (Liquidity →
 * Premium → Verwalten → Aktivieren) sendet dieses Skript NIE eine echte Zahlung —
 * weder per Cron noch bei manuellem Aufruf ohne --dry-run. Der Schalter gilt für
 * BEIDE Wege gleichermaßen, sonst könnte ein manueller Lauf ihn unterlaufen.
 *
 * ─── Warum keine eigene Betragsermittlung, sondern der signierte Preis ──────
 *
 * Der Preis kommt ausschließlich aus lib/premium-pricing-store.js — dem bereits
 * geprüften Ergebnis von verifyPricing() (core/premium/server.js). Dieses Skript
 * vertraut NICHT auf einen selbst mitgeführten Wert; gäbe es hier eine zweite
 * Preisquelle, könnte sie vom geprüften Stand abweichen, ohne dass es auffällt.
 *
 * ─── Idempotenz ──────────────────────────────────────────────────────────────
 *
 * Eine lokale Tabelle (premium_pay_log) verhindert eine zweite Zahlung für
 * dieselbe Stunde, falls das Skript per Cron mehrfach läuft. Eine ZWEITE echte
 * Zahlung für dieselbe Stunde wäre für den Master ohnehin kein Fehler (er liefert
 * dann nur erneut denselben Schlüssel, ohne Vortrag – siehe payment.md), aber sie
 * wäre für den Nutzer verlorenes Geld. Diese Sperre schützt davor, nicht den Master.
 */

import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import Database from 'better-sqlite3';
import { PATHS } from '../../config/paths.js';
import { isForkInstance } from '../../lib/premium-identity-context.js';
import { loadPremiumKeypair, fetchPremiumBalances } from '../../lib/premium-wallet.js';
import { getCurrentPricing } from '../../lib/premium-pricing-store.js';
import { getMyActivationToken } from '../../lib/premium-token-store.js';
import { isAutoPayEnabled, isOutagePaused, isPayFailureNotified, setPayFailureNotified, setAutoPayEnabled } from '../../lib/premium-auto-pay-store.js';
import { buildMemo, hourIdOf } from '../../lib/premium-memo.js';
import { submitAndConfirm } from '../tx-queue-client.js';
import { recordPremiumMessage } from './messages-db.js';

// USDC_MINT bewusst hier lokal deklariert statt aus core/premium/payment-rules.js
// importiert (obwohl dort identisch vorhanden) — payment-rules.js ist MASTER-ONLY
// (Zahlungs-Watcher-Logik) und soll konzeptionell nicht vom Fork-seitigen Zahl-
// Skript abhängen. Dieselbe Adresse ist bereits an fünf weiteren Stellen im
// Code hart verdrahtet (bots/liquidity/lib/wallet.js u.a.) — etablierte
// Konvention in diesem Repo, kein neues Muster.
const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const SPL_PROGRAM_ID   = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOC_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO_PROGRAM_ID  = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
// Dieselbe Nexus-URL wie lib/premium-wallet.js (RPC läuft immer über den
// Proxy, nie direkt gegen Helius – FORGE-Rate-Limit-Grundregel).
const NEXUS_RPC = 'http://127.0.0.1:3100/rpc';

const HELP = `
FORGE.pub Premium – Stunde bezahlen

  node core/premium/premium-pay.js [--dry-run] [--hour <hourId>] [--json] [--help]

Zahlt aus dem Premium-Wallet die aktuelle (oder mit --hour angegebene) Stunde
des Datendienstes. Bewegt echtes Kapital – ohne --dry-run wird eine reale
USDC-Transaktion gesendet.

Optionen:
  --dry-run       Baut die Transaktion, zeigt sie an, sendet NICHTS.
  --hour <id>     Andere Stunde als die laufende bezahlen (Unix-Stunden). Für
                  Tests/Nachzahlung – der Master akzeptiert nur ein enges
                  Zeitfenster um die aktuelle Stunde (siehe lib/premium-memo.js).
  --json          Maschinenlesbarer Output.
  --help, -h      Dieser Text, keine Zahlung.

Voraussetzungen (mit klarer Fehlermeldung, falls nicht erfüllt):
  - läuft nur auf einem FORGE.pub-Fork
  - Premium-Wallet konfiguriert (bin/install.sh) und mit SOL + USDC gefüllt
  - eigener Aktivierungs-Token vorhanden (per premium-activate-DM erhalten)
  - aktuelle, signiert geprüfte Preisliste vorhanden (kommt mit der Aktivierung)
  - Ein/Aus-Schalter auf "Aktivieren" (Liquidity → Premium → Verwalten) — gilt
    NICHT für --dry-run, der zeigt die Simulation trotzdem.
`;

function fail(msg, { json } = {}) {
    if (json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`❌ ${msg}`);
    process.exit(1);
}

function openPayLogDb() {
    const db = new Database(PATHS.premiumDb);
    db.exec(`
        CREATE TABLE IF NOT EXISTS premium_pay_log (
            hour_id    INTEGER PRIMARY KEY,
            signature  TEXT,
            amount_raw INTEGER,
            sent_at    INTEGER
        )
    `);
    return db;
}

function deriveAta(ownerPubkey, mintPubkey) {
    const [ata] = PublicKey.findProgramAddressSync(
        [ownerPubkey.toBuffer(), SPL_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
        ASSOC_PROGRAM_ID,
    );
    return ata;
}

function buildTransferIx(sourceAta, destAta, ownerPubkey, amountRaw) {
    const data = Buffer.alloc(9);
    data.writeUInt8(3, 0); // SPL Token: Transfer
    data.writeBigUInt64LE(BigInt(amountRaw), 1);
    return new TransactionInstruction({
        programId: SPL_PROGRAM_ID,
        keys: [
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: destAta, isSigner: false, isWritable: true },
            { pubkey: ownerPubkey, isSigner: true, isWritable: false },
        ],
        data,
    });
}

function buildMemoIx(memoText, signerPubkey) {
    return new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [{ pubkey: signerPubkey, isSigner: true, isWritable: false }],
        data: Buffer.from(memoText, 'utf8'),
    });
}

async function main() {
    const args = process.argv.slice(2);
    const json = args.includes('--json');

    if (args.includes('--help') || args.includes('-h')) {
        console.log(HELP);
        process.exit(0);
    }
    const dryRun = args.includes('--dry-run');
    const hourArgIdx = args.indexOf('--hour');
    const hourId = hourArgIdx !== -1 ? Number(args[hourArgIdx + 1]) : hourIdOf();
    if (!Number.isInteger(hourId) || hourId <= 0) fail('--hour muss eine positive Ganzzahl sein', { json });

    if (!isForkInstance()) {
        const msg = 'läuft nur auf einem FORGE.pub-Fork – auf dem Master gibt es kein Premium-Wallet.';
        if (json) console.log(JSON.stringify({ ok: false, skipped: msg }));
        else console.log(`[premium-pay] ${msg}`);
        process.exit(0);
    }

    const keypair = loadPremiumKeypair();
    if (!keypair) fail('kein Premium-Wallet konfiguriert (bin/install.sh, Abschnitt "Premium-Wallet")', { json });

    const activation = getMyActivationToken();
    if (!activation) fail('kein Aktivierungs-Token vorhanden – erst per "premium-activate" beim Master aktivieren', { json });

    const pricing = getCurrentPricing();
    if (!pricing?.receivingWallet) {
        fail('keine geprüfte Preisliste vorhanden – kommt automatisch mit der Aktivierung; ggf. erneut aktivieren', { json });
    }
    if (pricing.receivingWalletIsTestAddress && !json) {
        console.log('⚠️  Empfangsadresse ist laut Master-Konfiguration eine TESTADRESSE – erwartetes Verhalten im Testbetrieb.');
    }

    // Der Ein/Aus-Schalter (Liquidity → Premium → Verwalten) gilt für ECHTE Zahlungen
    // genauso wie für den künftigen Cron-Lauf — nicht nur für die Automatik. Sonst
    // könnte ein manueller Aufruf den Schalter unterlaufen, den der Nutzer bewusst
    // ausgeschaltet hat. --dry-run bleibt davon unberührt: bewegt ohnehin kein Kapital,
    // soll aber auch bei ausgeschaltetem Schalter zur Fehlersuche nutzbar bleiben.
    const autoPayEnabled = isAutoPayEnabled();
    if (!autoPayEnabled && !dryRun) {
        fail('automatische Zahlung ist deaktiviert (Liquidity → Premium → Verwalten → Aktivieren)', { json });
    }

    // System-Pausierung durch blob-health-check.js (>2h keine Daten UND öffentlicher
    // Heartbeat auch alt) – bewusst GETRENNT vom Nutzer-Schalter oben (siehe Kommentar
    // in lib/premium-auto-pay-store.js). --dry-run bleibt davon unberührt wie beim
    // Nutzer-Schalter auch: bewegt ohnehin kein Kapital, soll aber zur Fehlersuche
    // trotzdem funktionieren.
    if (isOutagePaused() && !dryRun) {
        const msg = 'automatische Zahlung ist pausiert – Premium-Service wurde als vorübergehend nicht erreichbar erkannt (siehe Message Center), wird automatisch fortgesetzt, sobald er wieder erreichbar ist.';
        if (json) console.log(JSON.stringify({ ok: false, skipped: msg }));
        else console.log(`[premium-pay] ${msg}`);
        process.exit(0);
    }

    const priceRaw = Math.round(pricing.priceUsdcPerHour * 10 ** USDC_DECIMALS);
    const memo = buildMemo(activation.token, hourId);

    const payLogDb = openPayLogDb();
    const already = payLogDb.prepare(`SELECT * FROM premium_pay_log WHERE hour_id = ?`).get(hourId);
    if (already && !dryRun) {
        payLogDb.close();
        fail(`Stunde ${hourId} wurde bereits bezahlt (TX ${already.signature}, ${new Date(already.sent_at).toLocaleString('de-DE')}) – keine zweite Zahlung.`, { json });
    }

    const owner = keypair.publicKey;
    const receivingWallet = new PublicKey(pricing.receivingWallet);
    const usdcMint = new PublicKey(USDC_MINT);
    const sourceAta = deriveAta(owner, usdcMint);
    const destAta = deriveAta(receivingWallet, usdcMint);

    const connection = new Connection(NEXUS_RPC, 'confirmed');
    const [balances, destInfo] = await Promise.all([
        fetchPremiumBalances(),
        connection.getAccountInfo(destAta),
    ]);

    if (!balances || balances.usdcBalance * 10 ** USDC_DECIMALS < priceRaw) {
        // Kein Guthaben mehr da ist kein vorübergehender Ausfall (anders als
        // isOutagePaused() oben) – ohne Nutzeraktion (Nachfüllen + "Aktivieren")
        // kommt hier nie wieder Geld rein. Deshalb den Ein/Aus-Schalter selbst
        // abschalten statt endlos stündlich denselben Fehlschlag zu wiederholen;
        // /premium/enable setzt pay_failure_notified beim Wieder-Aktivieren zurück
        // (bots/settings/routes/premium.js), das ist der vorgesehene Reset-Pfad.
        // Nur EINMAL melden, nicht bei jedem stündlichen Retry-Fehlschlag erneut (siehe
        // pay_failure_notified in lib/premium-auto-pay-store.js) – reine Diagnose-Läufe
        // (--dry-run) zählen nicht als echter Fehlschlag.
        if (!dryRun) {
            setAutoPayEnabled(false);
            if (!isPayFailureNotified()) {
                recordPremiumMessage(JSON.stringify({
                    cmd: 'premium-pay-failed', reason: 'insufficient-balance',
                    priceUsdc: pricing.priceUsdcPerHour, usdcBalance: balances?.usdcBalance ?? 0,
                }));
                setPayFailureNotified(true);
            }
        }
        fail(`unzureichendes USDC-Guthaben: ${balances?.usdcBalance ?? 0} vorhanden, ${pricing.priceUsdcPerHour} benötigt`, { json });
    }
    if (!destInfo) {
        fail(`Empfangs-Token-Konto (${destAta.toBase58()}) existiert nicht on-chain – ungewöhnlich für eine aktive Master-Adresse, bitte prüfen.`, { json });
    }

    const summary = {
        hourId, memo,
        fromWallet: owner.toBase58(),
        toWallet: receivingWallet.toBase58(),
        amountUsdc: pricing.priceUsdcPerHour,
        walletBalanceSol: balances.solBalance,
        walletBalanceUsdc: balances.usdcBalance,
        autoPayEnabled,
    };

    if (dryRun) {
        payLogDb.close();
        if (already) summary.note = `Stunde ${hourId} wurde bereits bezahlt (TX ${already.signature}) – ein echter Lauf würde jetzt ablehnen.`;
        if (json) console.log(JSON.stringify({ ok: true, dryRun: true, ...summary }, null, 2));
        else {
            console.log('[premium-pay] DRY-RUN – es wird NICHTS gesendet.');
            console.log(`  Von:    ${summary.fromWallet}`);
            console.log(`  An:     ${summary.toWallet}`);
            console.log(`  Betrag: ${summary.amountUsdc} USDC`);
            console.log(`  Memo:   ${summary.memo}`);
            console.log(`  Wallet-Guthaben: ${summary.walletBalanceSol} SOL, ${summary.walletBalanceUsdc} USDC`);
            if (!autoPayEnabled) console.log('  ⚠️  Automatik ist deaktiviert – ein echter Lauf würde jetzt ablehnen (Verwalten-Seite → Aktivieren).');
            if (summary.note) console.log(`  ⚠️  ${summary.note}`);
        }
        process.exit(0);
    }

    const tx = new Transaction()
        .add(buildTransferIx(sourceAta, destAta, owner, priceRaw))
        .add(buildMemoIx(memo, owner));
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    tx.sign(keypair);

    let signature;
    try {
        signature = await submitAndConfirm(tx.serialize());
    } catch (err) {
        payLogDb.close();
        // Häufigste Ursache neben Netzwerkfehlern: zu wenig SOL für die Netzwerkgebühr
        // (wird hier nicht separat geprüft, siehe Dateikopf – der Preis kommt signiert,
        // eine zweite Vorab-Schätzung der Gebühr wäre eine zweite Quelle der Wahrheit).
        if (!isPayFailureNotified()) {
            recordPremiumMessage(JSON.stringify({
                cmd: 'premium-pay-failed', reason: 'tx-failed', detail: err.message?.slice(0, 200),
            }));
            setPayFailureNotified(true);
        }
        fail(`Transaktion fehlgeschlagen: ${err.message}`, { json });
        return;
    }

    setPayFailureNotified(false);

    payLogDb.prepare(`
        INSERT INTO premium_pay_log (hour_id, signature, amount_raw, sent_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(hour_id) DO UPDATE SET signature = excluded.signature, amount_raw = excluded.amount_raw, sent_at = excluded.sent_at
    `).run(hourId, signature, priceRaw, Date.now());
    payLogDb.close();

    // Sichtbar im Message Center (Premium-Tab) machen – bewusst OHNE Nostr-Versand,
    // reine lokale Zahlungshistorie. Strukturiertes Kommando statt Freitext, damit
    // classifyPremiumCommand()/humanizePremiumMessage() (core/premium/server.js) den
    // Stunden-Index in einen lesbaren Zeitraum übersetzen und das Frontend die TX als
    // Block-Explorer-Link rendern kann, statt die rohe Signatur auszuschreiben.
    try {
        recordPremiumMessage(JSON.stringify({
            cmd: 'premium-payment', amountUsdc: summary.amountUsdc, hourId, toWallet: summary.toWallet, signature,
        }));
    } catch (err) {
        console.error(`[premium-pay] Konnte Zahlung nicht im Message Center vermerken: ${err.message}`);
    }

    if (json) console.log(JSON.stringify({ ok: true, dryRun: false, signature, ...summary }, null, 2));
    else {
        console.log(`✅ Bezahlt: ${summary.amountUsdc} USDC für Stunde ${hourId}`);
        console.log(`   TX: ${signature}`);
    }
}

main().catch(err => {
    console.error(`[premium-pay] FEHLER: ${err.message}`);
    process.exit(1);
});
