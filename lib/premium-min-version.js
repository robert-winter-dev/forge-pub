/**
 * FORGE.pub Premium – Mindestversion: signieren (Master) und prüfen (Fork)
 *
 * Gegenstück zu lib/premium-pricing.js, exakt dasselbe Muster (Downgrade-Schutz über
 * monotones `version`-Feld, Schnorr-Signatur mit dem ohnehin bekannten Master-Nostr-Key,
 * zeitliche Begrenzung). Der Fork meldet seine eigene Softwareversion ungeprüft an den
 * Master – Schummeln würde dem Nutzer nichts bringen (er zahlt dann ggf. für Daten, die
 * er nicht verarbeiten kann), deshalb ist hier keine Verifikation der Fork-Version nötig.
 * Was hier signiert/geprüft wird, ist ausschließlich die vom MASTER vorgegebene
 * Mindestversion, damit sie unterwegs nicht manipuliert werden kann.
 *
 * Diese Datei läuft auf BEIDEN Seiten: der Master signiert, der Fork prüft. Deshalb liegt
 * sie in lib/ und nicht in core/premium/.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { PATHS } from '../config/paths.js';

/** Wie alt eine signierte Mindestversions-Datei höchstens sein darf, bevor der Fork sie verwirft. */
export const MAX_MIN_VERSION_AGE_MS = 14 * 24 * 60 * 60 * 1000;   // 14 Tage
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Felder, die tatsächlich signiert werden (alles `_comment`-Beiwerk fliegt raus). */
const SIGNED_FIELDS = ['version', 'minRequiredVersion'];

/**
 * Kanonische Serialisierung: feste Feldreihenfolge, keine Leerzeichen. Beide Seiten müssen
 * bitgenau dasselbe hashen.
 */
export function canonicalPayload(params) {
    return JSON.stringify(SIGNED_FIELDS.map(f => [f, params[f] ?? null]));
}

function digest(params, signedAt) {
    return createHash('sha256').update(`${canonicalPayload(params)}|${signedAt}`).digest();
}

/** Liest config/premium-min-version.json und wirft die Kommentarfelder weg. MASTER-ONLY. */
export function loadMinVersionConfig(configPath = PATHS.premiumMinVersion) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const params = {};
    for (const f of SIGNED_FIELDS) params[f] = raw[f] ?? null;
    return params;
}

/**
 * Signiert die Mindestversion mit dem privaten Master-Nostr-Key. MASTER-ONLY.
 *
 * @param {object} params - aus loadMinVersionConfig().
 * @param {string} privkeyHex - 64-stelliger hex-Privkey der Master-Identität.
 * @returns {{ params: object, signedAt: number, sig: string, pubkey: string }}
 */
export function signMinVersion(params, privkeyHex) {
    const problems = validateParams(params);
    if (problems.length > 0) {
        throw new Error(`Mindestversions-Parameter unplausibel, nicht signiert: ${problems.join('; ')}`);
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
 * Plausibilitätsprüfung der Werte selbst — unabhängig von jeder Signatur.
 * @returns {string[]} leere Liste = in Ordnung.
 */
export function validateParams(params) {
    const problems = [];
    if (typeof params?.minRequiredVersion !== 'string' || !isValidVersion(params.minRequiredVersion)) {
        problems.push(`minRequiredVersion "${params?.minRequiredVersion}" ist keine gültige major.minor.patch-Version`);
    }
    return problems;
}

/**
 * Prüft eine gelieferte, signierte Mindestversions-Datei. FORK-SEITE.
 *
 * @param {object} envelope - { params, signedAt, sig, pubkey }
 * @param {string} expectedMasterPubkeyHex - aus der Bootstrap-Config des Forks.
 * @param {number|null} lastSeenVersion - zuletzt akzeptierte Version (Downgrade-Schutz).
 * @param {number} [now]
 * @returns {{ valid: boolean, reason: string|null, params: object|null }}
 */
export function verifyMinVersion(envelope, expectedMasterPubkeyHex, lastSeenVersion, now = Date.now()) {
    const bad = reason => ({ valid: false, reason, params: null });

    if (!envelope?.params || !envelope?.sig || !envelope?.pubkey) return bad('Umschlag unvollständig');

    if (envelope.pubkey.toLowerCase() !== String(expectedMasterPubkeyHex).toLowerCase()) {
        return bad('signiert von einem fremden Schlüssel, nicht vom bekannten Master');
    }

    const signedAt = Number(envelope.signedAt);
    if (!Number.isFinite(signedAt)) return bad('signedAt fehlt oder ist ungültig');
    if (signedAt > now + FUTURE_TOLERANCE_MS) return bad('signedAt liegt in der Zukunft');
    if (now - signedAt > MAX_MIN_VERSION_AGE_MS) {
        return bad(`Mindestversions-Datei ist ${Math.round((now - signedAt) / 86_400_000)} Tage alt`);
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

/** @returns {boolean} true, wenn `v` dem Muster major.minor.patch entspricht (nur nicht-negative Ganzzahlen). */
export function isValidVersion(v) {
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
}

/**
 * Semantischer Versionsvergleich (major.minor.patch), kein String-Vergleich.
 * Kein npm-Package `semver` genutzt – ist im Repo nur transitive Dependency von
 * better-sqlite3, nicht direkt deklariert; für die drei hier gebrauchten Ganzzahlen
 * reicht ein handgerollter Vergleich.
 *
 * @returns {number} <0 wenn a<b, 0 wenn gleich, >0 wenn a>b.
 */
export function compareVersions(a, b) {
    if (!isValidVersion(a)) throw new Error(`compareVersions: "${a}" ist keine gültige Version`);
    if (!isValidVersion(b)) throw new Error(`compareVersions: "${b}" ist keine gültige Version`);
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
}

/** @returns {boolean} true, wenn `version` mindestens `minRequiredVersion` ist. */
export function isVersionSupported(version, minRequiredVersion) {
    return compareVersions(version, minRequiredVersion) >= 0;
}

export function selfTest() {
    const failures = [];
    const priv = Buffer.from(schnorr.utils.randomPrivateKey()).toString('hex');
    const pub = Buffer.from(schnorr.getPublicKey(priv)).toString('hex');
    const otherPriv = Buffer.from(schnorr.utils.randomPrivateKey()).toString('hex');

    const params = { version: 3, minRequiredVersion: '0.9.0' };

    // 1: sauber signiert + geprüft.
    const env = signMinVersion(params, priv);
    const r1 = verifyMinVersion(env, pub, 2);
    if (!r1.valid) failures.push(`Fall 1: gültiger Umschlag abgelehnt (${r1.reason})`);

    // 2: fremder Signierer → abgelehnt.
    const r2 = verifyMinVersion(signMinVersion(params, otherPriv), pub, 2);
    if (r2.valid) failures.push('Fall 2: Signatur eines fremden Keys wurde akzeptiert');

    // 3: manipulierte Mindestversion bei gültiger Signatur über den ALTEN Payload → abgelehnt.
    const tampered = { ...env, params: { ...params, minRequiredVersion: '99.0.0' } };
    if (verifyMinVersion(tampered, pub, 2).valid) failures.push('Fall 3: nachträglich geänderte Mindestversion wurde akzeptiert');

    // 4: Downgrade auf eine ältere Version → abgelehnt.
    const older = signMinVersion({ ...params, version: 1 }, priv);
    if (verifyMinVersion(older, pub, 3).valid) failures.push('Fall 4: Versions-Downgrade wurde akzeptiert');

    // 5: zu alte Datei → abgelehnt.
    const stale = { ...env, signedAt: Date.now() - MAX_MIN_VERSION_AGE_MS - 60_000 };
    if (verifyMinVersion(stale, pub, 2).valid) failures.push('Fall 5: überalterte Mindestversions-Datei wurde akzeptiert');

    // 6: unplausible Werte fallen unabhängig von der Signatur auf.
    if (validateParams({ minRequiredVersion: 'abc' }).length === 0) {
        failures.push('Fall 6: unplausible Mindestversion wurde nicht bemängelt');
    }
    if (validateParams({ minRequiredVersion: '1.2' }).length === 0) {
        failures.push('Fall 6b: unvollständige Version (major.minor) wurde nicht bemängelt');
    }

    // 7: gleiche Version erneut ist erlaubt.
    if (!verifyMinVersion(env, pub, 3).valid) failures.push('Fall 7: unveränderte Version wurde fälschlich abgelehnt');

    // 8: compareVersions/isVersionSupported – semantischer statt String-Vergleich.
    if (compareVersions('0.9.10', '0.9.9') <= 0) failures.push('Fall 8: 0.9.10 wurde fälschlich als <= 0.9.9 gewertet (String-Vergleich-Bug)');
    if (!isVersionSupported('0.9.0', '0.9.0')) failures.push('Fall 8b: exakte Mindestversion wurde nicht als unterstützt gewertet');
    if (isVersionSupported('0.8.9', '0.9.0')) failures.push('Fall 8c: Version unterhalb der Mindestversion wurde als unterstützt gewertet');
    if (!isVersionSupported('1.0.0', '0.9.0')) failures.push('Fall 8d: neuere Major-Version wurde nicht als unterstützt gewertet');

    return { ok: failures.length === 0, failures };
}
