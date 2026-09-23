#!/usr/bin/env node
/**
 * FORGE public Premium – Zahl-Skript (FORK-ONLY, FINANZ-SKRIPT)
 *
 * Zahlt aus dem Premium-Wallet (lib/premium-wallet.js) die aktuelle Stunde des
 * FORGE-public-Datendienstes: eine USDC-Transaktion an die vom Master signiert
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
 * Bezahlt wird EINE Stunde genau EINMAL — der Cron läuft trotzdem alle 10 Min
 * (config/cron-jobs.json). Grund (2026-08-09): bei genau einem Slot pro Stunde
 * ließ ein einziger verpasster Lauf die ganze Stunde unbezahlt, und der Master
 * liefert ohne Zahlung keinen Blob (Vorfall forge-pub1: der Deploy-Lock in
 * bin/forge-cron.js verwarf den 5-Minuten-Slot, Folge war eine Stunde ohne
 * Premium-Daten plus ein irreführender "Dienst nicht erreichbar"-Alarm). Die
 * Wiederholung ist gefahrlos, weil premium_pay_log (hour_id PRIMARY KEY) eine
 * zweite Zahlung derselben Stunde hart abweist — siehe "Idempotenz" unten.
 *
 * Gated durch lib/premium-auto-pay-store.js: ohne den Ein/Aus-Schalter auf der Verwalten-Seite (Liquidity →
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

import { execFile } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { SimplePool } from 'nostr-tools';
import Database from 'better-sqlite3';
import { PATHS, envFile } from '../../config/paths.js';
import { isForkInstance } from '../../lib/premium-identity-context.js';
import { loadPremiumKeypair, fetchPremiumBalances } from '../../lib/premium-wallet.js';
import { getCurrentPricing } from '../../lib/premium-pricing-store.js';
import { getMyActivationToken } from '../../lib/premium-token-store.js';
import { isAutoPayEnabled, isOutagePaused, isPayFailureNotified, setPayFailureNotified, setAutoPayEnabled } from '../../lib/premium-auto-pay-store.js';
import { buildMemo, hourIdOf } from '../../lib/premium-memo.js';
import { submitAndConfirm } from '../tx-queue-client.js';
import { recordPremiumMessage } from './messages-db.js';
import { identityExists, loadIdentity, loadRelays, loadContacts, sendDirectMessage } from '../../lib/nostr-client.js';
import { cleanVersion } from '../../lib/version.js';
import { rpcCallerHeaders } from '../../lib/rpc-caller.js';

dotenv.config({ path: envFile('premium') });

// USDC_MINT bewusst hier lokal deklariert statt aus core/premium/payment-rules.js
// importiert (obwohl dort identisch vorhanden) — payment-rules.js ist MASTER-ONLY
// (Zahlungs-Watcher-Logik) und soll konzeptionell nicht vom Fork-seitigen Zahl-
// Skript abhängen. Dieselbe Adresse ist bereits an fünf weiteren Stellen im
// Code hart verdrahtet (bots/liquidity/lib/wallet.js u.a.) — etablierte
// Konvention in diesem Repo, kein neues Muster.
const execFileAsync = promisify(execFile);

const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const SPL_PROGRAM_ID   = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOC_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO_PROGRAM_ID  = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
// Dieselbe Nexus-URL wie lib/premium-wallet.js (RPC läuft immer über den
// Proxy, nie direkt gegen Helius – FORGE-Rate-Limit-Grundregel).
const NEXUS_RPC = 'http://127.0.0.1:3100/rpc';

const HELP = `
FORGE public Premium – Stunde bezahlen

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
  - läuft nur auf einem FORGE-public-Fork
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

// Für erwartete "nichts zu tun"-Zustände (kein echter Fehler) — exit 0 statt exit 1,
// damit der stündliche Cron-Lauf sie nicht als ausgefallenen Dienst meldet. Fund
// 2026-08-07: "kein Aktivierungs-Token" und "Auto-Pay ausgeschaltet" liefen bisher
// über fail() (exit 1) — bei einem noch nie aktivierten Fork (oder bewusst
// ausgeschaltetem Auto-Pay) alarmierte der Health-Check dadurch jede Stunde
// fälschlich "Dienst antwortet nicht mehr, bitte neu starten", obwohl ein Neustart
// daran nichts ändert. isForkInstance()/isOutagePaused() nutzten dieses Muster
// bereits vorher korrekt.
function skip(msg, { json } = {}) {
    if (json) console.log(JSON.stringify({ ok: false, skipped: msg }));
    else console.log(`[premium-pay] ${msg}`);
    process.exit(0);
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
    // confirmed_at (2026-08-12): NULL = gesendet, Ausgang noch offen. Vorher gab es
    // diesen Zustand nicht – eine Zeile existierte nur nach bestätigter Zahlung, jeder
    // andere Ausgang galt als "nicht bezahlt" und führte zu einem neuen Zahlungsversuch.
    // Genau daran sind am 2026-08-12 auf forge-pub1 bis zu sechs echte Zahlungen für
    // dieselbe Stunde entstanden (siehe Kommentar bei submitAndConfirm unten).
    const cols = db.prepare(`PRAGMA table_info(premium_pay_log)`).all().map(c => c.name);
    if (!cols.includes('confirmed_at')) {
        db.exec(`ALTER TABLE premium_pay_log ADD COLUMN confirmed_at INTEGER`);
        // Bestandszeilen sind per Definition bestätigt – vor dieser Spalte wurde eine
        // Zeile ausschließlich nach erfolgreicher Confirmation geschrieben. Ohne dieses
        // Nachziehen würden sie als "offen" gelesen und unnötig nachgeprüft.
        db.exec(`UPDATE premium_pay_log SET confirmed_at = sent_at WHERE confirmed_at IS NULL`);
    }
    return db;
}

// Wie lange eine gesendete, aber nicht auffindbare Transaktion als "vielleicht noch
// unterwegs" gilt. Ein Solana-Blockhash ist rund 150 Slots (~60–90s) gültig; danach
// kann das Netz die Transaktion nicht mehr annehmen. 5 Min liegt komfortabel darüber,
// damit erst dann neu gezahlt wird, wenn die alte Transaktion sicher tot ist.
const UNCONFIRMED_GRACE_MS = 5 * 60 * 1000;

/**
 * Fragt den tatsächlichen On-Chain-Ausgang einer Signatur ab (readonly, ein RPC-Call
 * über den Nexus – nie direkt gegen Helius, siehe FORGE-Rate-Limit-Grundregel).
 *
 * `searchTransactionHistory: true` ist hier zwingend: die zu prüfende Transaktion ist
 * typischerweise Minuten alt und damit längst aus dem Kurzzeit-Statuscache gefallen.
 *
 * @returns {Promise<'confirmed'|'failed'|'pending'|'unknown'>}
 *   confirmed – bestätigt, Geld ist geflossen
 *   failed    – on-chain fehlgeschlagen, kein Geld geflossen, Neuversuch sicher
 *   pending   – gesehen, aber noch nicht bestätigt
 *   unknown   – dem RPC nicht bekannt (nie gelandet ODER noch nicht sichtbar)
 */
async function fetchSignatureOutcome(signature) {
    const res = await fetch(NEXUS_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses',
            params: [[signature], { searchTransactionHistory: true }],
        }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Nexus HTTP ${res.status} bei getSignatureStatuses`);
    const json = await res.json();
    if (json.error) throw new Error(`RPC-Fehler: ${JSON.stringify(json.error)}`);

    const status = json.result?.value?.[0];
    if (!status) return 'unknown';
    if (status.err) return 'failed';
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return 'confirmed';
    return 'pending';
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

/**
 * Meldet dem Master bei jedem Lauf die eigene installierte FORGE-public-Version
 * (config/version.json – EINE Quelle für Master und Fork, siehe lib/version.js).
 * cleanVersion() liefert bewusst reines a.b.c ohne '+buildNumber' — der Master vergleicht
 * strikt per Semver (lib/premium-min-version.js isValidVersion), Build-Metadata würde
 * die Prüfung brechen.
 * Fire-and-forget: der Master antwortet nur, wenn die Version unter der Mindestversion
 * liegt (core/premium/server.js `handleVersionCheck`, config/premium-min-version.json).
 * Eine solche Antwort trifft asynchron über den separat laufenden Daemon (server.js)
 * ein, nicht hier – dieses Skript ist ein Cron-Einzellauf ohne offene Subscription.
 *
 * Eigene, kurzlebige SimplePool-Verbindung wie core/premium/deliver-blob.js — nicht
 * die des laufenden forge-premium-Daemons. pool.destroy() danach nicht vergessen,
 * sonst hält der Prozess wegen offener WebSockets nie an.
 *
 * Ein Fehlschlag hier (Relay nicht erreichbar, keine Identität, kein Master-Kontakt)
 * darf den eigentlichen Zahlungsversuch NICHT verhindern – der Aufrufer fängt jeden
 * Fehler ab und wirft ihn nie weiter.
 */
async function reportVersionCheck() {
    const IDENTITY_NAME = process.env.NOSTR_IDENTITY?.trim() || 'FORGE.Master';
    if (!identityExists(IDENTITY_NAME)) return;

    const masterContact = loadContacts().find(c => c.id === 'forge-master');
    if (!masterContact) return;

    const identity = loadIdentity(IDENTITY_NAME);
    const relays = loadRelays();
    const pool = new SimplePool();
    try {
        await Promise.any(sendDirectMessage(
            pool, relays, identity, masterContact.pubkeyHex,
            JSON.stringify({ cmd: 'premium-version-check', version: cleanVersion() }),
        ));
    } finally {
        pool.destroy();
    }
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
        skip('läuft nur auf einem FORGE-public-Fork – auf dem Master gibt es kein Premium-Wallet.', { json });
    }

    // Eigene Version melden (Versions-Gate, siehe core/premium/server.js
    // handleVersionCheck) – VOR jedem weiteren Schritt, auch vor --dry-run, damit der
    // Master immer eine aktuelle Sichtung hat. Best-effort, darf den Zahlungsversuch
    // selbst nie verhindern.
    await reportVersionCheck().catch(err => {
        console.warn(`[premium-pay] Versions-Meldung konnte nicht gesendet werden: ${err.message}`);
    });

    const keypair = loadPremiumKeypair();
    if (!keypair) fail('kein Premium-Wallet konfiguriert (bin/install.sh, Abschnitt "Premium-Wallet")', { json });

    const activation = getMyActivationToken();
    if (!activation) skip('kein Aktivierungs-Token vorhanden – wartet auf Aktivierung per "premium-activate" beim Master (kein Fehler).', { json });

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
        // "Nutzer-Einstellung" stimmt nur, solange der Nutzer selbst ausgeschaltet hat.
        // Nach einem Zahlungsfehlschlag hat sich der Schalter selbst abgeschaltet (siehe
        // unten, setAutoPayEnabled(false)) – das Protokoll behauptete dann stündlich, es
        // sei so gewollt, und verdeckte die eigentliche Ursache (forge-pub1, 2026-08-13).
        skip(isPayFailureNotified()
            ? 'automatische Zahlung wurde nach einem Zahlungsfehlschlag (zu geringes USDC-Guthaben) abgeschaltet – Guthaben nachfüllen, dann Liquidity → Premium → Verwalten → Aktivieren.'
            : 'automatische Zahlung ist deaktiviert (Liquidity → Premium → Verwalten → Aktivieren) – Nutzer-Einstellung, kein Fehler.', { json });
    }

    // System-Pausierung durch blob-health-check.js (>2h keine Daten UND öffentlicher
    // Heartbeat auch alt) – bewusst GETRENNT vom Nutzer-Schalter oben (siehe Kommentar
    // in lib/premium-auto-pay-store.js). --dry-run bleibt davon unberührt wie beim
    // Nutzer-Schalter auch: bewegt ohnehin kein Kapital, soll aber zur Fehlersuche
    // trotzdem funktionieren.
    if (isOutagePaused() && !dryRun) {
        skip('automatische Zahlung ist pausiert – Premium-Service wurde als vorübergehend nicht erreichbar erkannt (siehe Message Center), wird automatisch fortgesetzt, sobald er wieder erreichbar ist.', { json });
    }

    // Liquidity Bot muss laufen, sonst gibt es niemanden, der die gelieferten
    // Marktdaten nutzt (Fund 2026-08-07). Bewusst NUR diese eine Stunde überspringen
    // (skip(), kein enabled-Flag anfassen) statt eines dauerhaften Pausier-Zustands
    // mit eigener Zeitschwelle: premium-pay läuft ohnehin nur stündlich, ein kurzes
    // Down durch ein länger laufendes Update trifft diesen Check nur zufällig genau
    // in der einen Cron-Minute — im schlimmsten Fall fällt eine einzelne Zahlung aus,
    // nichts wird "aus Versehen dauerhaft deaktiviert". Ein bewusstes manuelles
    // Stoppen des Bots deaktiviert die Zahlung dagegen sofort UND dauerhaft direkt
    // in der Stop-Route (bots/settings/routes/bots.js), nicht hier.
    if (!dryRun) {
        let liquidityBotActive = true;
        try {
            await execFileAsync('/usr/bin/systemctl', ['is-active', '--quiet', 'forge-liquiditybot']);
        } catch {
            liquidityBotActive = false;
        }
        if (!liquidityBotActive) {
            skip('Liquidity Bot ist gerade nicht aktiv – Zahlung für diese Stunde übersprungen (kein Fehler, kein dauerhaftes Deaktivieren).', { json });
        }
    }

    const priceRaw = Math.round(pricing.priceUsdcPerHour * 10 ** USDC_DECIMALS);
    const memo = buildMemo(activation.token, hourId);

    const payLogDb = openPayLogDb();
    const already = payLogDb.prepare(`SELECT * FROM premium_pay_log WHERE hour_id = ?`).get(hourId);

    // Offener Ausgang aus einem früheren Lauf: erst den tatsächlichen On-Chain-Stand
    // klären, BEVOR auch nur erwogen wird, erneut zu zahlen. Ohne diesen Schritt wird
    // aus jedem Bestätigungs-Timeout eine echte Doppelzahlung (Vorfall 2026-08-12).
    if (already && already.confirmed_at == null && !dryRun) {
        let outcome;
        try {
            outcome = await fetchSignatureOutcome(already.signature);
        } catch (err) {
            // Der Status ließ sich nicht klären (RPC gerade nicht erreichbar – meist
            // genau die Störung, die den Timeout überhaupt verursacht hat). Im Zweifel
            // NICHT zahlen: eine ausgelassene Stunde kostet Daten, eine Doppelzahlung
            // kostet Geld.
            payLogDb.close();
            skip(`Stunde ${hourId}: Ausgang der bereits gesendeten Zahlung (TX ${already.signature}) ist unklar und ließ sich nicht prüfen (${err.message}) – keine zweite Zahlung, nächster Lauf versucht es erneut.`, { json });
        }

        if (outcome === 'confirmed') {
            payLogDb.prepare(`UPDATE premium_pay_log SET confirmed_at = ? WHERE hour_id = ?`).run(Date.now(), hourId);
            payLogDb.close();
            setPayFailureNotified(false);
            skip(`Stunde ${hourId} ist doch bezahlt – die zuvor unbestätigte Zahlung (TX ${already.signature}) wurde inzwischen on-chain bestätigt und nachgetragen.`, { json });
        }
        if (outcome === 'pending' || (outcome === 'unknown' && Date.now() - already.sent_at < UNCONFIRMED_GRACE_MS)) {
            payLogDb.close();
            skip(`Stunde ${hourId}: Zahlung (TX ${already.signature}) ist gesendet, aber noch nicht bestätigt – keine zweite Zahlung, nächster Lauf prüft erneut.`, { json });
        }

        // 'failed' oder nach der Karenzzeit weiterhin 'unknown': die alte Transaktion ist
        // endgültig tot (kein Geld geflossen), ein neuer Versuch ist jetzt sicher. Die
        // Zeile wird weiter unten beim Erfolg per ON CONFLICT überschrieben.
        console.warn(`[premium-pay] Vorherige Zahlung für Stunde ${hourId} (TX ${already.signature}) ist endgültig fehlgeschlagen (${outcome}) – neuer Zahlungsversuch.`);
    }

    if (already && already.confirmed_at != null && !dryRun) {
        payLogDb.close();
        // skip() statt fail(): seit dem 10-Min-Takt (2026-08-09) ist "diese Stunde ist
        // schon bezahlt" der ERWARTETE Ausgang von 5 der 6 Läufe pro Stunde und damit
        // kein Fehler. Über fail() (exit 1) hätte jeder Wiederholversuch einen
        // Cron-Fehlalarm im Health-Check ausgelöst (checkCronJobs wertet lastExitCode
        // aus) — dieselbe Falle wie 2026-08-07 bei "Auto-Pay ausgeschaltet".
        skip(`Stunde ${hourId} wurde bereits bezahlt (TX ${already.signature}, ${new Date(already.sent_at).toLocaleString('de-DE')}) – keine zweite Zahlung.`, { json });
    }

    const owner = keypair.publicKey;
    const receivingWallet = new PublicKey(pricing.receivingWallet);
    const usdcMint = new PublicKey(USDC_MINT);
    const sourceAta = deriveAta(owner, usdcMint);
    const destAta = deriveAta(receivingWallet, usdcMint);

    const connection = new Connection(NEXUS_RPC, { commitment: 'confirmed', httpHeaders: rpcCallerHeaders() });
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
        // skip() statt fail(): ein leeres Guthaben ist beim Endnutzer der NORMALFALL,
        // kein Defekt — und er ist an dieser Stelle bereits vollständig behandelt
        // (Auto-Pay aus + einmalige Meldung im Message Center, siehe oben). Der
        // zusätzliche Exit 1 machte daraus über cron-state.json einen technischen
        // Ausfallalarm ("cron:premium-pay nicht erreichbar – bitte den Dienst neu
        // starten"), der weder zutrifft noch weiterhilft (belegt 2026-08-07 auf einem
        // Testhost). Gleiche Klasse wie der Ingest-Fehlalarm, nur über den Cron-Kanal.
        skip(`unzureichendes USDC-Guthaben: ${balances?.usdcBalance ?? 0} vorhanden, ${pricing.priceUsdcPerHour} benötigt – automatische Zahlung abgeschaltet, Meldung ging ins Message Center.`, { json });
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
        if (already) {
            summary.note = already.confirmed_at != null
                ? `Stunde ${hourId} wurde bereits bezahlt (TX ${already.signature}) – ein echter Lauf würde jetzt ablehnen.`
                : `Stunde ${hourId} hat eine gesendete, aber noch unbestätigte Zahlung (TX ${already.signature}) – ein echter Lauf würde erst deren On-Chain-Status prüfen, statt erneut zu zahlen.`;
        }
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
        // Unklarer, ausdrücklich NICHT negativer Ausgang: die Transaktion ist gesendet,
        // nur ihre Bestätigung kam nicht rechtzeitig (siehe core/tx-queue-client.js).
        // Sie kann jeden Moment noch landen – deshalb wird die Signatur hier
        // festgehalten statt verworfen, und der nächste Lauf klärt den Ausgang oben,
        // bevor irgendetwas erneut gezahlt wird.
        //
        // Bewusst skip() (Exit 0), nicht fail(): das ist kein Defekt, sondern ein noch
        // offener Vorgang. Ein Exit 1 würde über cron-state.json einen technischen
        // Ausfallalarm auslösen, der weder zutrifft noch weiterhilft – dieselbe Falle
        // wie bei "Auto-Pay ausgeschaltet" (2026-08-07). Bleiben die Daten trotzdem
        // dauerhaft aus, greift der Ingest-Watchdog nach 1h (bin/health-check.js).
        if (err.unconfirmed && err.signature) {
            payLogDb.prepare(`
                INSERT INTO premium_pay_log (hour_id, signature, amount_raw, sent_at, confirmed_at)
                VALUES (?, ?, ?, ?, NULL)
                ON CONFLICT(hour_id) DO UPDATE SET signature = excluded.signature,
                    amount_raw = excluded.amount_raw, sent_at = excluded.sent_at, confirmed_at = NULL
            `).run(hourId, err.signature, priceRaw, Date.now());
            payLogDb.close();
            skip(`Zahlung für Stunde ${hourId} gesendet (TX ${err.signature}), aber nicht innerhalb des Zeitfensters bestätigt – wird beim nächsten Lauf geprüft, KEINE zweite Zahlung.`, { json });
        }

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
        INSERT INTO premium_pay_log (hour_id, signature, amount_raw, sent_at, confirmed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(hour_id) DO UPDATE SET signature = excluded.signature, amount_raw = excluded.amount_raw,
            sent_at = excluded.sent_at, confirmed_at = excluded.confirmed_at
    `).run(hourId, signature, priceRaw, Date.now(), Date.now());
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
