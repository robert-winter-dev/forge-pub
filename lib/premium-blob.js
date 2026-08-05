// ══════════════════════════════════════════════════════════════════════════════
// FORGE.pub Premium – Blob-Verschlüsselung
// ══════════════════════════════════════════════════════════════════════════════
// Baustein 1 der Premium-Anbindung (siehe datenaustausch.md
// „PoC-Spezifikation"). Reine, transportunabhängige Krypto-Funktionen — wo der
// verschlüsselte Blob abgelegt wird, regelt lib/blob-storage.js.
//
// Krypto-Schema (Opus-Review 2026-07-21, siehe [[datenaustausch]] „Krypto-Schema"):
//   gzip(JSON.stringify(data)) → AEAD-Verschlüsselung mit XChaCha20-Poly1305 und
//   einem zufälligen Stunden-Key K_H (32 Byte). Ablage-Format: nonce ‖ ciphertext ‖ tag
//   (die 16-Byte-Poly1305-Tag steckt bereits im ciphertext-Rückgabewert der Lib).
//   K_H rotiert stündlich und wird ausschließlich per NIP-17 Gift-Wrap-DM an zahlende
//   Kunden zugestellt (siehe lib/nostr-client.js) — läuft nie über den Datei-Transport.
//
// Bewusst symmetrisch (nicht pro Kunde verschlüsselt): ein Blob für alle Kunden einer
// Abrechnungsstunde, siehe [[datenaustausch]] „Ein Blob für alle statt pro Kunde".
// ══════════════════════════════════════════════════════════════════════════════

import { gzipSync, gunzipSync } from 'zlib';
import { randomBytes } from 'crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const NONCE_BYTES = 24; // XChaCha20: 24-Byte-Nonce, damit kollisionssicher zufällig wählbar
const KEY_BYTES    = 32;

/** Erzeugt einen neuen zufälligen Stunden-Key K_H (32 Byte). */
export function generateBlobKey() {
    return randomBytes(KEY_BYTES);
}

/**
 * Verschlüsselt ein JSON-fähiges Objekt zu einem Blob-Buffer.
 * @param {object} data - Klartext-Datenobjekt (z.B. der Premium-Datenblob).
 * @param {Buffer|Uint8Array} key - K_H, exakt 32 Byte.
 * @returns {Buffer} nonce (24 B) ‖ ciphertext+tag
 */
export function encryptBlob(data, key) {
    if (!key || key.length !== KEY_BYTES) {
        throw new Error(`encryptBlob: key muss ${KEY_BYTES} Byte sein (K_H)`);
    }
    const plaintext = gzipSync(Buffer.from(JSON.stringify(data), 'utf8'));
    const nonce = randomBytes(NONCE_BYTES);
    const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
    return Buffer.concat([nonce, ciphertext]);
}

/**
 * Entschlüsselt einen mit encryptBlob() erzeugten Buffer zurück zum Original-Objekt.
 * Wirft bei falschem Key oder manipuliertem Blob (AEAD-Tag-Prüfung schlägt fehl).
 * @param {Buffer|Uint8Array} blob - nonce ‖ ciphertext+tag, wie von encryptBlob() geliefert.
 * @param {Buffer|Uint8Array} key - K_H, exakt 32 Byte.
 * @returns {object} das ursprüngliche Datenobjekt.
 */
export function decryptBlob(blob, key) {
    if (!key || key.length !== KEY_BYTES) {
        throw new Error(`decryptBlob: key muss ${KEY_BYTES} Byte sein (K_H)`);
    }
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    if (buf.length <= NONCE_BYTES) {
        throw new Error('decryptBlob: Blob zu kurz (fehlt der Nonce-Anteil?)');
    }
    const nonce = buf.subarray(0, NONCE_BYTES);
    const ciphertext = buf.subarray(NONCE_BYTES);
    const plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertext);
    return JSON.parse(gunzipSync(Buffer.from(plaintext)).toString('utf8'));
}

/**
 * Selbsttest: Round-Trip (encrypt→decrypt), Tamper-Erkennung, falscher Key.
 * Rückgabe wie bei den anderen FORGE-selfTest()-Konventionen (sanitize-text.js etc.).
 */
export function selfTest() {
    const failures = [];
    const key = generateBlobKey();
    const sample = { poolOffers: [{ pair: 'SOL/USDC', tvl: 384000 }], generatedAt: Date.now() };

    const blob = encryptBlob(sample, key);
    let roundTrip;
    try {
        roundTrip = decryptBlob(blob, key);
    } catch (err) {
        failures.push(`Round-Trip fehlgeschlagen: ${err.message}`);
    }
    if (roundTrip && JSON.stringify(roundTrip) !== JSON.stringify(sample)) {
        failures.push('Round-Trip lieferte abweichende Daten');
    }

    // Falscher Key muss scheitern (AEAD-Tag-Prüfung), nicht still falsche Daten liefern.
    try {
        decryptBlob(blob, generateBlobKey());
        failures.push('Entschlüsselung mit falschem Key hätte werfen müssen');
    } catch {
        // erwartet
    }

    // Manipulierter Ciphertext muss scheitern (Integritätsschutz).
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    try {
        decryptBlob(tampered, key);
        failures.push('Entschlüsselung eines manipulierten Blobs hätte werfen müssen');
    } catch {
        // erwartet
    }

    return { ok: failures.length === 0, failures };
}
