/**
 * FORGE public Premium – Zustellung an den ZAHLER binden
 *
 * Problem (aufgeworfen 2026-07-29): Die Blob-Zustellung geht per Nostr-DM an
 * die Kunden-Identität. Ein Kunde könnte seinen Nostr-Account einfach weitergeben — dann
 * bucht einer, und beliebig viele Freunde lesen mit. Der Nostr-Schlüssel ist kostenlos und
 * verlustfrei kopierbar; ihn zu teilen kostet nichts.
 *
 * Lösung: Der Nutzinhalt der DM (`K_H` + URL) wird zusätzlich so verschlüsselt, dass nur
 * entschlüsseln kann, wer den **privaten Schlüssel der zahlenden Solana-Wallet** besitzt.
 * Den teilt man nicht beiläufig — dort liegt Geld. Aus „Account weitergeben, fertig" wird
 * damit „meine Wallet weitergeben", eine ganz andere Hemmschwelle.
 *
 * ─── Was das NICHT leistet (bewusst ehrlich dokumentiert) ────────────────────
 *
 * Wer die Daten legitim bekommt, kann sie immer weiterreichen — das ist jedem Datenprodukt
 * inhärent und nicht lösbar. Konkret bleiben offen:
 *   • Die komplette Installation kopieren (inkl. Wallet-Key) funktioniert weiterhin.
 *   • `K_H` von Hand weiterschicken funktioniert weiterhin — aber eben JEDE STUNDE neu.
 * Der erreichte Gewinn ist die Umwandlung von „einmal einrichten, dauerhaft mitnutzen" in
 * „stündlich aktiv weiterleiten". Mehr wird hier nicht behauptet.
 *
 * ─── Verfahren ──────────────────────────────────────────────────────────────
 *
 * Solana-Keys sind Ed25519, Nostr nutzt secp256k1 — der Solana-Pubkey lässt sich also nicht
 * direkt für NIP-44 verwenden. Stattdessen die Standard-Umrechnung auf die birational
 * äquivalente Montgomery-Kurve (X25519), dann ECDH:
 *
 *   Master:  eph = zufälliges X25519-Keypair
 *            shared = ECDH(eph.priv, toX25519(zahler_ed25519_pubkey))
 *   Zahler:  shared = ECDH(toX25519(eigener_ed25519_seed), eph.pub)
 *
 * Aus `shared` wird per HKDF-SHA256 ein Sitzungsschlüssel abgeleitet (nie das rohe
 * ECDH-Ergebnis direkt als Schlüssel verwenden) und damit XChaCha20-Poly1305 gefahren —
 * dieselbe AEAD-Familie wie beim Blob selbst.
 *
 * Die ephemere Master-Seite ist wichtig: ohne sie wäre der Sitzungsschlüssel für ein
 * Kundenpaar dauerhaft gleich, und ein einmal abgegriffener Schlüssel würde jede künftige
 * Zustellung aufdecken.
 *
 * Läuft auf BEIDEN Seiten (Master verschlüsselt, Fork entschlüsselt) → lib/.
 */

import { edwardsToMontgomeryPub, edwardsToMontgomeryPriv, x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'crypto';

const VERSION = 1;
const NONCE_BYTES = 24;   // XChaCha20
const KEY_BYTES = 32;
const HKDF_INFO = new TextEncoder().encode('forge.pub/premium-blob-delivery/v1');

/** Ed25519-Pubkey (32 Byte, wie ihn eine Solana-Adresse darstellt) → X25519. */
export function solanaPubkeyToX25519(ed25519PubBytes) {
    return edwardsToMontgomeryPub(ed25519PubBytes);
}

/**
 * Solana-Secret (64 Byte: 32 Seed + 32 Pubkey) oder blanker 32-Byte-Seed → X25519-Privkey.
 * Die Umrechnung geht bewusst vom SEED aus, nicht von den vollen 64 Byte — Ed25519 leitet
 * seinen Skalar per SHA-512 aus dem Seed ab, und genau diesen Schritt bildet
 * `edwardsToMontgomeryPriv` nach.
 */
export function solanaSecretToX25519(secretKeyBytes) {
    const seed = secretKeyBytes.length === 64 ? secretKeyBytes.slice(0, 32) : secretKeyBytes;
    if (seed.length !== 32) throw new Error('solanaSecretToX25519: erwarte 32- oder 64-Byte-Secret');
    return edwardsToMontgomeryPriv(seed);
}

function deriveKey(sharedSecret, ephPub, recipientX25519Pub) {
    // Beide öffentlichen Anteile in den Salt: bindet den Sitzungsschlüssel an genau dieses
    // Paar und verhindert, dass ein Geheimnis in einem anderen Kontext wiederverwendbar wäre.
    const salt = new Uint8Array([...ephPub, ...recipientX25519Pub]);
    return hkdf(sha256, sharedSecret, salt, HKDF_INFO, KEY_BYTES);
}

/**
 * Verschlüsselt für den Inhaber des privaten Schlüssels zu `payerPubkeyBytes`. MASTER.
 *
 * @param {object} payload - beliebiges JSON-serialisierbares Objekt ({K_H, URL, …}).
 * @param {Uint8Array} payerPubkeyBytes - Ed25519-Pubkey der zahlenden Wallet (32 Byte).
 * @returns {{v:number, epk:string, nonce:string, ct:string}} hex-kodiert.
 */
export function sealForPayer(payload, payerPubkeyBytes) {
    const recipientX = solanaPubkeyToX25519(payerPubkeyBytes);
    const ephPriv = x25519.utils.randomPrivateKey();
    const ephPub = x25519.getPublicKey(ephPriv);
    const shared = x25519.getSharedSecret(ephPriv, recipientX);
    const key = deriveKey(shared, ephPub, recipientX);

    const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
    const ct = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(JSON.stringify(payload)));

    return {
        v: VERSION,
        epk: Buffer.from(ephPub).toString('hex'),
        nonce: Buffer.from(nonce).toString('hex'),
        ct: Buffer.from(ct).toString('hex'),
    };
}

/**
 * Entschlüsselt mit dem privaten Schlüssel der zahlenden Wallet. FORK.
 *
 * @param {{v:number, epk:string, nonce:string, ct:string}} sealed
 * @param {Uint8Array} payerSecretKeyBytes - Solana-Secret (64 Byte) oder Seed (32 Byte).
 * @returns {object} der ursprüngliche Payload.
 * @throws bei falschem Schlüssel, manipuliertem Chiffrat oder unbekannter Version.
 */
export function openAsPayer(sealed, payerSecretKeyBytes) {
    if (sealed?.v !== VERSION) {
        throw new Error(`unbekannte Zustell-Version ${sealed?.v} (unterstützt: ${VERSION})`);
    }
    const myPriv = solanaSecretToX25519(payerSecretKeyBytes);
    const myPub = x25519.getPublicKey(myPriv);
    const ephPub = Uint8Array.from(Buffer.from(sealed.epk, 'hex'));
    const shared = x25519.getSharedSecret(myPriv, ephPub);
    const key = deriveKey(shared, ephPub, myPub);

    const nonce = Uint8Array.from(Buffer.from(sealed.nonce, 'hex'));
    const ct = Uint8Array.from(Buffer.from(sealed.ct, 'hex'));
    // Schlägt bei falschem Schlüssel ODER verändertem Chiffrat fehl (AEAD-Tag) — genau
    // das ist gewollt: eine „halb funktionierende" Entschlüsselung darf es nicht geben.
    const pt = xchacha20poly1305(key, nonce).decrypt(ct);
    return JSON.parse(new TextDecoder().decode(pt));
}

export async function selfTest() {
    const failures = [];
    const { Keypair } = await import('@solana/web3.js');

    const payer = Keypair.generate();
    const stranger = Keypair.generate();
    const payload = { cmd: 'premium-blob', url: 'https://example.invalid/x.bin', key: 'ab'.repeat(32), hourId: 495_912 };

    // 1: Rundlauf mit dem richtigen Schlüssel.
    const sealed = sealForPayer(payload, payer.publicKey.toBytes());
    let opened;
    try {
        opened = openAsPayer(sealed, payer.secretKey);
    } catch (err) {
        failures.push(`Fall 1: Entschlüsselung mit dem richtigen Key schlug fehl (${err.message})`);
    }
    if (opened && JSON.stringify(opened) !== JSON.stringify(payload)) {
        failures.push('Fall 1: entschlüsselter Payload weicht ab');
    }

    // 2: Der eigentliche Zweck — ein Fremder mit anderer Wallet kommt NICHT rein.
    let blocked = false;
    try { openAsPayer(sealed, stranger.secretKey); } catch { blocked = true; }
    if (!blocked) failures.push('Fall 2: fremde Wallet konnte entschlüsseln – die Bindung wirkt nicht');

    // 3: Auch der 32-Byte-Seed allein muss funktionieren (manche Key-Ablagen speichern nur ihn).
    try {
        const viaSeed = openAsPayer(sealed, payer.secretKey.slice(0, 32));
        if (JSON.stringify(viaSeed) !== JSON.stringify(payload)) failures.push('Fall 3: Seed-Variante liefert anderen Payload');
    } catch (err) {
        failures.push(`Fall 3: Entschlüsselung nur mit Seed schlug fehl (${err.message})`);
    }

    // 4: Manipuliertes Chiffrat muss auffliegen (AEAD-Integrität), nicht stillschweigend Müll liefern.
    const tampered = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith('00') ? '11' : '00') };
    let caught = false;
    try { openAsPayer(tampered, payer.secretKey); } catch { caught = true; }
    if (!caught) failures.push('Fall 4: manipuliertes Chiffrat wurde akzeptiert');

    // 5: Ausgetauschter ephemerer Pubkey ebenso.
    const otherEph = x25519.getPublicKey(x25519.utils.randomPrivateKey());
    let caught5 = false;
    try { openAsPayer({ ...sealed, epk: Buffer.from(otherEph).toString('hex') }, payer.secretKey); } catch { caught5 = true; }
    if (!caught5) failures.push('Fall 5: ausgetauschter epk wurde akzeptiert');

    // 6: Zwei Zustellungen an denselben Kunden ergeben verschiedene Chiffrate (ephemer!).
    const again = sealForPayer(payload, payer.publicKey.toBytes());
    if (again.ct === sealed.ct || again.epk === sealed.epk) {
        failures.push('Fall 6: Zustellung ist nicht ephemer – gleicher Schlüssel/Chiffrat bei Wiederholung');
    }

    // 7: Unbekannte Version wird abgelehnt statt geraten.
    let caught7 = false;
    try { openAsPayer({ ...sealed, v: 99 }, payer.secretKey); } catch { caught7 = true; }
    if (!caught7) failures.push('Fall 7: unbekannte Version wurde nicht abgelehnt');

    // 8: Umrechnung ist konsistent (Pubkey-Weg == Privkey-Weg).
    const a = solanaPubkeyToX25519(payer.publicKey.toBytes());
    const b = x25519.getPublicKey(solanaSecretToX25519(payer.secretKey));
    if (!Buffer.from(a).equals(Buffer.from(b))) {
        failures.push('Fall 8: X25519-Umrechnung aus Pubkey und aus Privkey stimmen nicht überein');
    }

    return { ok: failures.length === 0, failures };
}
