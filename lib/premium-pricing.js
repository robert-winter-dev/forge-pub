/**
 * FORGE public Premium – Preisparameter: signieren (Master) und prüfen (Fork)
 *
 * Der Preis steuert im Fork eine AUTOMATISCHE Zahlung aus dem Premium-Wallet. Damit ist
 * er kein bloßer Anzeigewert, sondern ein kapitalrelevanter Eingabewert — und muss
 * denselben Maßstab erfüllen wie die Blob-Zustellung:
 *
 *   • **Signiert.** Ein unsigniert abgerufener Preis wäre über einen manipulierten Host
 *     oder einen MITM frei setzbar („Preis = 500 USDC") und würde das Premium-Wallet in
 *     einer einzigen Transaktion leeren. Signiert wird mit demselben Master-Nostr-Key,
 *     den der Fork für die Gift-Wrap-DMs ohnehin schon kennt und prüft (secp256k1/
 *     Schnorr über den SHA-256 des kanonischen Payloads) — kein neues Schlüsselmaterial,
 *     kein neues Vertrauensanker.
 *   • **Monoton versioniert.** `version` muss echt steigen. Sonst könnte ein Angreifer
 *     eine ältere, korrekt signierte Datei erneut ausspielen (Replay) — etwa um einen
 *     längst abgeschalteten Empfänger oder einen alten Preis wieder gültig zu machen.
 *   • **Zeitlich begrenzt.** `signedAt` darf nicht aus der Zukunft und nicht beliebig alt
 *     sein.
 *
 * Über allem steht im Fork zusätzlich eine **harte Obergrenze pro Einzelzahlung**
 * (MAX_PRICE_USDC_PER_HOUR, s.u.). Sie ist bewusst KEIN Budget-Cap — das Guthaben des
 * Premium-Wallets ist die vom Nutzer gewollte Obergrenze (Produktentscheidung
 * 2026-07-29) — sondern eine Notbremse gegen genau einen Fehlerfall: dass eine einzelne
 * Zahlung das ganze Wallet nimmt. Sie liegt weit über jedem realistischen Preis und muss
 * darum nie gepflegt werden.
 *
 * Diese Datei läuft auf BEIDEN Seiten: der Master signiert, der Fork prüft. Deshalb liegt
 * sie in lib/ und nicht in core/premium/.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { PATHS } from '../config/paths.js';

/**
 * Absolute Obergrenze, die der Fork NIE überschreitet — egal was signiert geliefert wird.
 * Bei 1 USDC/h wären das ~730 USDC/Monat; jeder real geplante Preis (0,05–0,10) liegt um
 * mindestens den Faktor 10 darunter. Wird diese Grenze je erreicht, ist das ein Fehler
 * oder ein Angriff, nie eine gewollte Preisanpassung.
 */
export const MAX_PRICE_USDC_PER_HOUR = 1.0;

/** Ebenso hart: ein Abrechnungsintervall außerhalb dieser Spanne ist nie plausibel. */
export const MIN_BILLING_MINUTES = 15;
export const MAX_BILLING_MINUTES = 24 * 60;

/** Wie alt eine signierte Preisdatei höchstens sein darf, bevor der Fork sie verwirft. */
export const MAX_PRICING_AGE_MS = 14 * 24 * 60 * 60 * 1000;   // 14 Tage
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Felder, die tatsächlich signiert werden (alles `_comment`-Beiwerk fliegt raus). */
const SIGNED_FIELDS = [
    'version', 'priceUsdcPerHour', 'billingIntervalMinutes',
    'receivingWallet', 'memoVersion', 'lowBalanceWarnHours', 'lowBalanceCriticalHours',
    // Mitsigniert, damit der Fork die Testphase im UI kenntlich machen kann und der
    // Zustand nicht nur in einem Master-Kommentar steht.
    'receivingWalletIsTestAddress',
];

/**
 * Kanonische Serialisierung: feste Feldreihenfolge, keine Leerzeichen. Beide Seiten müssen
 * bitgenau dasselbe hashen — deshalb NICHT einfach JSON.stringify des Rohobjekts (dessen
 * Schlüsselreihenfolge hängt an der Datei und ändert sich beim Editieren still).
 */
export function canonicalPayload(params) {
    return JSON.stringify(SIGNED_FIELDS.map(f => [f, params[f] ?? null]));
}

function digest(params, signedAt) {
    return createHash('sha256').update(`${canonicalPayload(params)}|${signedAt}`).digest();
}

/** Liest config/premium-pricing.json und wirft die Kommentarfelder weg. MASTER-ONLY. */
export function loadPricingConfig(configPath = PATHS.premiumPricing) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const params = {};
    for (const f of SIGNED_FIELDS) params[f] = raw[f] ?? null;
    return params;
}

/**
 * Signiert die Parameter mit dem privaten Master-Nostr-Key. MASTER-ONLY.
 *
 * @param {object} params - aus loadPricingConfig().
 * @param {string} privkeyHex - 64-stelliger hex-Privkey der Master-Identität.
 * @returns {{ params: object, signedAt: number, sig: string, pubkey: string }}
 */
export function signPricing(params, privkeyHex) {
    const problems = validateParams(params);
    if (problems.length > 0) {
        // Lieber gar nicht erst signieren als eine unplausible Datei ausliefern, die der
        // Fork dann ohnehin verwirft (und dabei aussieht wie ein Angriff).
        throw new Error(`Preisparameter unplausibel, nicht signiert: ${problems.join('; ')}`);
    }
    const signedAt = Date.now();
    const sig = schnorr.sign(digest(params, signedAt), privkeyHex);
    return {
        params,
        signedAt,
        sig: Buffer.from(sig).toString('hex'),
        pubkey: Buffer.from(schnorr.getPublicKey(privkeyHex)).toString('hex'),
    };
}

/**
 * Plausibilitätsprüfung der Werte selbst — unabhängig von jeder Signatur. Eine korrekt
 * signierte, aber unsinnige Datei ist genauso gefährlich wie eine gefälschte.
 * @returns {string[]} leere Liste = in Ordnung.
 */
export function validateParams(params) {
    const problems = [];
    const price = Number(params?.priceUsdcPerHour);
    if (!Number.isFinite(price) || price <= 0) {
        problems.push('priceUsdcPerHour fehlt oder ist nicht positiv');
    } else if (price > MAX_PRICE_USDC_PER_HOUR) {
        problems.push(`priceUsdcPerHour ${price} überschreitet die harte Obergrenze ${MAX_PRICE_USDC_PER_HOUR}`);
    }

    const interval = Number(params?.billingIntervalMinutes);
    if (!Number.isFinite(interval) || interval < MIN_BILLING_MINUTES || interval > MAX_BILLING_MINUTES) {
        problems.push(`billingIntervalMinutes ${params?.billingIntervalMinutes} liegt außerhalb ${MIN_BILLING_MINUTES}–${MAX_BILLING_MINUTES}`);
    }

    if (params?.receivingWallet != null && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(params.receivingWallet)) {
        problems.push('receivingWallet ist keine plausible Base58-Solana-Adresse');
    }

    const warn = Number(params?.lowBalanceWarnHours);
    const crit = Number(params?.lowBalanceCriticalHours);
    if (Number.isFinite(warn) && Number.isFinite(crit) && crit >= warn) {
        problems.push('lowBalanceCriticalHours muss kleiner als lowBalanceWarnHours sein');
    }
    return problems;
}

/**
 * Prüft eine gelieferte, signierte Preisdatei. FORK-SEITE.
 *
 * @param {object} envelope - { params, signedAt, sig, pubkey }
 * @param {string} expectedMasterPubkeyHex - aus der Bootstrap-Config des Forks.
 * @param {number|null} lastSeenVersion - zuletzt akzeptierte Version (Downgrade-Schutz).
 * @param {number} [now]
 * @returns {{ valid: boolean, reason: string|null, params: object|null }}
 */
export function verifyPricing(envelope, expectedMasterPubkeyHex, lastSeenVersion, now = Date.now()) {
    const bad = reason => ({ valid: false, reason, params: null });

    if (!envelope?.params || !envelope?.sig || !envelope?.pubkey) return bad('Umschlag unvollständig');

    // Absender zuerst: eine Signatur von einem fremden Key ist nie interessant, egal wie
    // gültig sie in sich ist.
    if (envelope.pubkey.toLowerCase() !== String(expectedMasterPubkeyHex).toLowerCase()) {
        return bad('signiert von einem fremden Schlüssel, nicht vom bekannten Master');
    }

    const signedAt = Number(envelope.signedAt);
    if (!Number.isFinite(signedAt)) return bad('signedAt fehlt oder ist ungültig');
    if (signedAt > now + FUTURE_TOLERANCE_MS) return bad('signedAt liegt in der Zukunft');
    if (now - signedAt > MAX_PRICING_AGE_MS) {
        return bad(`Preisdatei ist ${Math.round((now - signedAt) / 86_400_000)} Tage alt`);
    }

    let sigOk = false;
    try {
        sigOk = schnorr.verify(envelope.sig, digest(envelope.params, signedAt), envelope.pubkey);
    } catch {
        return bad('Signatur nicht prüfbar (Formatfehler)');
    }
    if (!sigOk) return bad('Signatur ungültig');

    const version = Number(envelope.params.version);
    if (!Number.isFinite(version)) return bad('version fehlt');
    if (lastSeenVersion != null && version < lastSeenVersion) {
        return bad(`version ${version} ist älter als die zuletzt akzeptierte ${lastSeenVersion} (Replay?)`);
    }

    const problems = validateParams(envelope.params);
    if (problems.length > 0) return bad(problems.join('; '));

    return { valid: true, reason: null, params: envelope.params };
}

export function selfTest() {
    const failures = [];
    const priv = Buffer.from(schnorr.utils.randomPrivateKey()).toString('hex');
    const pub = Buffer.from(schnorr.getPublicKey(priv)).toString('hex');
    const otherPriv = Buffer.from(schnorr.utils.randomPrivateKey()).toString('hex');

    const params = {
        version: 3, priceUsdcPerHour: 0.05, billingIntervalMinutes: 60,
        receivingWallet: 'H417aeEc8fhnRz5BoPxq7P6p1LVaJBhaikkcxMjx1Hr',
        memoVersion: 1, lowBalanceWarnHours: 48, lowBalanceCriticalHours: 12,
    };

    // 1: sauber signiert + geprüft.
    const env = signPricing(params, priv);
    const r1 = verifyPricing(env, pub, 2);
    if (!r1.valid) failures.push(`Fall 1: gültiger Umschlag abgelehnt (${r1.reason})`);

    // 2: fremder Signierer → abgelehnt.
    const r2 = verifyPricing(signPricing(params, otherPriv), pub, 2);
    if (r2.valid) failures.push('Fall 2: Signatur eines fremden Keys wurde akzeptiert');

    // 3: manipulierter Preis bei gültiger Signatur über den ALTEN Payload → abgelehnt.
    const tampered = { ...env, params: { ...params, priceUsdcPerHour: 0.9 } };
    if (verifyPricing(tampered, pub, 2).valid) failures.push('Fall 3: nachträglich geänderter Preis wurde akzeptiert');

    // 4: Downgrade auf eine ältere Version → abgelehnt.
    const older = signPricing({ ...params, version: 1 }, priv);
    if (verifyPricing(older, pub, 3).valid) failures.push('Fall 4: Versions-Downgrade wurde akzeptiert');

    // 5: harte Obergrenze — auch korrekt signiert nicht akzeptabel.
    let threw = false;
    try { signPricing({ ...params, priceUsdcPerHour: 5 }, priv); } catch { threw = true; }
    if (!threw) failures.push('Fall 5: Preis über der harten Obergrenze wurde signiert');
    // … und selbst wenn er doch ausgeliefert würde, muss der Fork ihn verwerfen.
    const forced = { ...env, params: { ...params, priceUsdcPerHour: 5 } };
    if (verifyPricing(forced, pub, 2).valid) failures.push('Fall 5b: Fork akzeptierte einen Preis über der Obergrenze');

    // 6: zu alte Datei → abgelehnt.
    const stale = { ...env, signedAt: Date.now() - MAX_PRICING_AGE_MS - 60_000 };
    if (verifyPricing(stale, pub, 2).valid) failures.push('Fall 6: überalterte Preisdatei wurde akzeptiert');

    // 7: unplausible Werte fallen unabhängig von der Signatur auf.
    if (validateParams({ ...params, lowBalanceCriticalHours: 99 }).length === 0) {
        failures.push('Fall 7: critical >= warn wurde nicht bemängelt');
    }
    if (validateParams({ ...params, receivingWallet: 'keine-adresse' }).length === 0) {
        failures.push('Fall 7b: unplausible Empfangsadresse wurde nicht bemängelt');
    }

    // 8: gleiche Version erneut ist erlaubt (unveränderte Datei erneut ausgespielt).
    if (!verifyPricing(env, pub, 3).valid) failures.push('Fall 8: unveränderte Version wurde fälschlich abgelehnt');

    return { ok: failures.length === 0, failures };
}
