// ══════════════════════════════════════════════════════════════════════════════
// FORGE public – Update-Verifier (Ed25519)
// ══════════════════════════════════════════════════════════════════════════════
// Prüft die Signatur eines Release-Manifests gegen den lokal verankerten
// Trust-Anchor (local/trust/trust-anchor.json). Bewusst NUR node:crypto + node:fs
// als Abhängigkeit — KEINE Dependency (siehe update.md "Umsetzungsentwurf 2026-08-03",
// Befund B): `bin/setup.sh update` ruft `do_npm`
// auf, npm install ist also Teil jedes Fork-Updates. Ein Verifier aus node_modules
// wäre über genau die Supply-Chain angreifbar, gegen die er schützen soll — ein
// manipuliertes Paket macht die Prüfung sonst zu einem `return true`.
//
// Akzeptiert eine gültige Signatur von PRIMÄR ODER RECOVERY-Key (beide sind
// gleichwertige Trust-Anchors, siehe update.md "Trust-Anchor & Key-Management" —
// Recovery ist kein Sonderfall nur für Rotation, sondern zweiter voller Anker).
//
// Reine Kernfunktion (verifyAgainstTrustAnchor) arbeitet nur auf Buffern, keine
// Dateizugriffe – leicht isoliert testbar/auditierbar. verifyFile() ist der
// dünne fs-Wrapper darum für den tatsächlichen Gebrauch.
// ══════════════════════════════════════════════════════════════════════════════

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Lädt local/trust/trust-anchor.json. Wirft, wenn die Datei fehlt oder kein
 * primärer Schlüssel verankert ist (z.B. Erstinstallation noch nicht
 * abgeschlossen — do_trust_anchor() in bin/setup.sh läuft erst nach do_deploy).
 */
export function loadTrustAnchor(trustAnchorPath) {
    const raw = JSON.parse(readFileSync(trustAnchorPath, 'utf8'));
    if (!raw.primary) {
        throw new Error(`Trust-Anchor ${trustAnchorPath} hat keinen primären Schlüssel verankert.`);
    }
    return raw;
}

/** Verifiziert still (kein Throw) — eine kaputte/fehlende PEM ist einfach "kein Treffer". */
function tryVerify(dataBuffer, signatureBuffer, publicKeyPem) {
    if (!publicKeyPem) return false;
    try {
        const keyObj = createPublicKey(publicKeyPem);
        if (keyObj.asymmetricKeyType !== 'ed25519') return false;
        return cryptoVerify(null, dataBuffer, keyObj, signatureBuffer);
    } catch {
        return false;
    }
}

/**
 * Kernprüfung, rein auf Buffern. Gibt zurück, OB die Signatur gültig ist und
 * GEGEN WELCHEN Anker sie passte (für Logging/Alarm bei Recovery-Nutzung
 * relevant — ein Release, das nur mit dem Recovery-Key verifiziert, ist ein
 * Signal, dass der Primär-Key gerade rotiert wird oder kompromittiert war).
 */
export function verifyAgainstTrustAnchor(dataBuffer, signatureBuffer, trustAnchor) {
    if (tryVerify(dataBuffer, signatureBuffer, trustAnchor.primary)) {
        return { valid: true, matchedKey: 'primary' };
    }
    if (tryVerify(dataBuffer, signatureBuffer, trustAnchor.recovery)) {
        return { valid: true, matchedKey: 'recovery' };
    }
    return { valid: false, matchedKey: null };
}

/** Bequemlichkeits-Wrapper: liest Datei, Signatur und Trust-Anchor von der Platte. */
export function verifyFile(dataPath, signaturePath, trustAnchorPath) {
    const data = readFileSync(dataPath);
    const signature = readFileSync(signaturePath);
    const trustAnchor = loadTrustAnchor(trustAnchorPath);
    return verifyAgainstTrustAnchor(data, signature, trustAnchor);
}

// ── CLI für manuelle Prüfung/Debugging ──────────────────────────────────────
//   node lib/update-verify.js <datei> <datei.sig> <trust-anchor.json>
if (import.meta.url === `file://${process.argv[1]}`) {
    const [dataPath, sigPath, trustAnchorPath] = process.argv.slice(2);
    if (!dataPath || !sigPath || !trustAnchorPath) {
        console.error('Aufruf: node lib/update-verify.js <datei> <datei.sig> <trust-anchor.json>');
        process.exit(2);
    }
    try {
        const result = verifyFile(dataPath, sigPath, trustAnchorPath);
        console.log(JSON.stringify(result));
        process.exit(result.valid ? 0 : 1);
    } catch (err) {
        console.error(`Fehler: ${err.message}`);
        process.exit(2);
    }
}
