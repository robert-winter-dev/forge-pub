/**
 * FORGE – Nostr-Client (gemeinsam genutzt)
 *
 * Dünner Wrapper um nostr-tools für das Message Center (Proof of Concept):
 * Identität laden/anlegen, Relay-Liste laden, private DMs senden/empfangen
 * (NIP-17 Gift-Wrap, NIP-44-Verschlüsselung).
 *
 * Private Keys liegen NIE in Git. Ablageort ist konfigurierbar, weil Master und
 * FORGE.pub-Fork unterschiedliche Konventionen haben:
 *
 *   Master (Default):  data/secrets/nostr/<name>.json   – data/ ist .gitignore't
 *   FORGE.pub-Fork:    NOSTR_SECRETS_DIR=/opt/forge/secrets
 *                      → /opt/forge/secrets/<name>.json
 *
 * Im Fork liegen ALLE schlüsselartigen Dateien bewusst in EINEM Verzeichnis
 * (`secrets/`, 0700, nur User `forge`): pro Bot ein Wallet-Keypair plus die
 * Nostr-Identität. Begründung (2026-07-27): das sind sachlich alles
 * Passwörter und gehören an denselben Ort – ein Verzeichnis zum Sichern,
 * eines zum Schützen. Beide Orte sind über die R7-Invariante in
 * tools/pub-export/forbidden-paths.js (Regeln "data-dir" und "secrets-dir") hart
 * gegen eine versehentliche Aufnahme in ein Repo gesperrt.
 *
 * Die Relay-Liste (config/nostr-relays.json) ist bewusst git-versioniert, damit
 * Master und Forks dieselbe Liste teilen.
 */

import fs from 'fs';
import path from 'path';
import { SimplePool as RawSimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip19, nip17 } from 'nostr-tools';
import { PATHS } from '../config/paths.js';

// setTimeout()-Delays > ~24,8 Tage (2^31-1 ms) laufen in einigen JS-Engines wegen
// 32-Bit-Überlauf sofort statt nie — 7 Tage ist ein sicherer "praktisch nie"-Wert
// für IDLE_TIMEOUT_MS unten (der Prozess wird ohnehin regelmäßig neu gestartet).
const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * SimplePool mit aktiviertem Reconnect + Ping-Keepalive + hohem Idle-Timeout.
 * nostr-tools hat alle drei standardmäßig AUS/kurz (`new SimplePool()` ohne Optionen,
 * `idleTimeout` Default 20s) — **Fund 2026-07-28, per Live-Test isoliert reproduziert:**
 * nostr-tools' `scheduleIdleClose()` schließt eine Relay-Verbindung automatisch, sobald
 * `ongoingOperations` 20s lang bei 0 steht (das ist der Normalzustand einer dauerhaften
 * DM-Subscription nach dem initialen EOSE — sie "tut" ja nichts, solange keine neue
 * Nachricht kommt). Dieses `close()` setzt dabei **explizit** `skipReconnection = true`
 * und ruft `onclose()` direkt auf — bypassed `handleHardClose()`/`enableReconnect`
 * komplett. Ergebnis: `forge-premium` verlor auf forge-pub1 UND auf dem Master nach
 * exakt ~20-45s jede Relay-Verbindung, lautlos, ohne jede Logzeile, ohne jeden Reconnect-
 * Versuch — nicht durch einen Netzwerkfehler, sondern durch dieses "höfliche" Idle-Close.
 * `idleTimeout: IDLE_TIMEOUT_MS` verhindert das gezielt für Langzeit-Subscriptions.
 * `enableReconnect` nutzt zusätzlich nostr-tools' eingebaute Backoff-Logik (10s…60s) und
 * resubscribed automatisch alle offenen Subscriptions nach einem ECHTEN Verbindungsabbruch
 * (inkl. `since`-Gap-Fill). `enablePing` schickt alle 29s ein WS-Ping, damit tote
 * Verbindungen früher erkannt werden statt erst am nächsten Sendeversuch.
 */
export function createPool(opts = {}) {
    return new RawSimplePool({ enableReconnect: true, enablePing: true, idleTimeout: IDLE_TIMEOUT_MS, ...opts });
}

// Bewusst eine FUNKTION statt einer Modul-Konstante: ESM-Imports laufen vor jedem
// anderen Code im importierenden Modul — ein dortiges dotenv.config() käme also zu spät,
// um NOSTR_SECRETS_DIR noch zu setzen. Lazy gelesen funktioniert beides: systemd-
// EnvironmentFile (vor Prozessstart gesetzt) UND dotenv.config() im Prozess.
function secretsDir() {
    return process.env.NOSTR_SECRETS_DIR?.trim()
        || path.join(PATHS.data, 'secrets', 'nostr');
}

/** Liest die Relay-Liste aus config/nostr-relays.json (wss://-URLs). */
export function loadRelays() {
    const raw = fs.readFileSync(path.join(PATHS.config, 'nostr-relays.json'), 'utf8');
    const { relays } = JSON.parse(raw);
    if (!Array.isArray(relays) || relays.length === 0) {
        throw new Error('config/nostr-relays.json enthält keine Relays');
    }
    return relays;
}

/**
 * Liest das mitgelieferte Adressbuch (config/nostr-contacts.json) – ausschließlich
 * öffentliche Pubkeys, u.a. der feste Support-Kontakt "FORGE Master". Fehlt die Datei
 * oder ist sie unlesbar, wird eine leere Liste zurückgegeben: ein fehlendes Adressbuch
 * darf das Message Center nie blockieren (Kontakte lassen sich weiterhin manuell
 * eintippen).
 */
export function loadContacts() {
    try {
        const raw = fs.readFileSync(path.join(PATHS.config, 'nostr-contacts.json'), 'utf8');
        const { contacts } = JSON.parse(raw);
        return Array.isArray(contacts) ? contacts : [];
    } catch {
        return [];
    }
}

/**
 * Legt eine neue Nostr-Identität an und speichert sie unter <SECRETS_DIR>/<name>.json.
 *
 * Schlägt standardmäßig fehl, wenn die Datei bereits existiert — kein versehentliches
 * Überschreiben eines bestehenden Keys (ein überschriebener Nostr-Key ist unwiederbringlich
 * weg: alte Threads verwaisen, die Identität ist für Gegenstellen tot).
 *
 * `{ overwrite: true }` hebt den Schutz bewusst auf — genutzt, wenn der Nutzer seinen
 * Account absichtlich neu anlegt (Festlegung 2026-07-27: bereits existierende Daten
 * werden dabei von den neu angelegten überschrieben). Aufrufer MUSS vorher rückfragen
 * und die alten Nachrichten löschen — die gehören zur weggeworfenen Identität und wären
 * mit dem neuen Key ohnehin nicht mehr zuzuordnen.
 */
export function createIdentity(name, { overwrite = false, alias = null } = {}) {
    const file = path.join(secretsDir(), `${name}.json`);
    if (fs.existsSync(file) && !overwrite) {
        throw new Error(`Identität "${name}" existiert bereits: ${file}`);
    }
    const sk = generateSecretKey();
    const pubkeyHex = getPublicKey(sk);
    const identity = {
        name,
        alias,                       // Nostr-Profilname (kind 0), null = kein Profil publizieren
        pubkeyHex,
        privkeyHex: Buffer.from(sk).toString('hex'),
        npub: nip19.npubEncode(pubkeyHex),
        nsec: nip19.nsecEncode(sk),
        createdAt: Date.now(),
    };
    fs.mkdirSync(secretsDir(), { recursive: true });
    writeIdentityFile(file, identity);
    return identity;
}

/**
 * Schreibt die Identitätsdatei ATOMAR (temp + rename) mit 0600.
 *
 * Atomar, weil die Datei den Private Key enthält und auch nachträglich noch geschrieben
 * wird (Alias-Änderung, s. setIdentityAlias). Ein abgebrochener In-Place-Write würde
 * sonst eine halb geschriebene Key-Datei hinterlassen — der Schlüssel wäre unwiederbringlich
 * verloren. rename() innerhalb desselben Verzeichnisses ist auf POSIX atomar.
 */
function writeIdentityFile(file, identity) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}

/**
 * Setzt den Anzeigenamen (Alias) einer bestehenden Identität und gibt sie zurück.
 * Ändert NUR das alias-Feld, der Schlüssel bleibt unangetastet (read-modify-write,
 * atomar geschrieben). Das Publizieren des kind-0-Profils macht der Aufrufer —
 * publishProfile() braucht einen Relay-Pool, den diese Funktion bewusst nicht kennt.
 */
export function setIdentityAlias(name, alias) {
    const file = path.join(secretsDir(), `${name}.json`);
    if (!fs.existsSync(file)) {
        throw new Error(`Identität "${name}" nicht gefunden: ${file}`);
    }
    const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
    identity.alias = alias;
    writeIdentityFile(file, identity);
    identity.privkeyBytes = Buffer.from(identity.privkeyHex, 'hex');
    return identity;
}

/** Lädt eine bestehende Identität. Wirft, wenn sie nicht existiert. */
export function loadIdentity(name) {
    const file = path.join(secretsDir(), `${name}.json`);
    if (!fs.existsSync(file)) {
        throw new Error(`Identität "${name}" nicht gefunden: ${file}. Erst bin/nostr-setup.js ausführen.`);
    }
    const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
    identity.privkeyBytes = Buffer.from(identity.privkeyHex, 'hex');
    return identity;
}

/** true wenn die Identität bereits existiert (für Setup-Script/Statusanzeige). */
export function identityExists(name) {
    return fs.existsSync(path.join(secretsDir(), `${name}.json`));
}

/**
 * Sendet eine private DM (NIP-17 Gift-Wrap) an einen Empfänger-Pubkey (hex).
 * Gibt die Publish-Promises pro Relay zurück (siehe nostr-tools SimplePool.publish).
 */
export function sendDirectMessage(pool, relays, senderIdentity, recipientPubkeyHex, text) {
    const wrapped = nip17.wrapEvent(senderIdentity.privkeyBytes, { publicKey: recipientPubkeyHex }, text);
    return pool.publish(relays, wrapped);
}

// Watchdog gegen lautlos verstummte Subscriptions (Fund 2026-08-01): ein Relay kann
// eine offene REQ intern verwerfen (Restart, Rate-Limit, Bug), ohne CLOSE zu senden
// und ohne die WebSocket-Verbindung zu trennen — Ping/Pong (enablePing) antwortet
// weiter normal, `relay.connected` bleibt true, aber es kommt nie wieder ein Event
// an. enableReconnect greift hier NICHT, weil es nur auf einen echten Verbindungs-
// abbruch reagiert. Einzige robuste Gegenmaßnahme: aktiv prüfen, wie lange das
// letzte Event her ist, und im Zweifel proaktiv neu subscriben (neue REQ-ID zwingt
// den Relay, den Zustand frisch aufzubauen). 15 Min liegt deutlich über dem
// 10-Min-Publish-Takt von FORGE.pub Premium, damit ein einzelner verzögerter
// Blob-Lauf keinen Fehlalarm/Resubscribe auslöst.
const DM_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const DM_WATCHDOG_STALE_MS    = 15 * 60 * 1000;

/**
 * Abonniert eingehende private DMs (kind 1059, an die eigene Pubkey adressiert).
 * onMessage(rumor) wird pro entschlüsselter Nachricht aufgerufen (rumor.content = Text,
 * rumor.pubkey = Absender-Pubkey, rumor.created_at = Unix-Sekunden).
 * Gibt einen Closer zurück (`.close()` beendet Subscription + Watchdog).
 */
export function subscribeDirectMessages(pool, relays, myIdentity, onMessage) {
    let lastEventAt = Date.now();
    let subCloser = openSubscription();

    function openSubscription() {
        return pool.subscribeMany(
            relays,
            { kinds: [1059], '#p': [myIdentity.pubkeyHex] },
            {
                onevent(event) {
                    lastEventAt = Date.now();
                    try {
                        const rumor = nip17.unwrapEvent(event, myIdentity.privkeyBytes);
                        onMessage(rumor);
                    } catch (err) {
                        // Entschlüsselung fehlgeschlagen – meist ein fremdes Gift-Wrap auf demselben
                        // Relay (nicht an uns adressiert trotz Filter), daher kein harter Fehler.
                        // debug statt silent, damit ein echter Bug hier nicht wieder unbemerkt bleibt.
                        console.debug('nostr: Gift-Wrap konnte nicht entschlüsselt werden:', err.message);
                    }
                },
                onclose(reasons) {
                    // Bewusst sichtbar (nicht mehr leer, siehe Vorfall 2026-08-01): ein Relay-
                    // seitiger Close ohne Log-Zeile war genau das, was die vorherige Stille
                    // >2h unentdeckt ließ. enableReconnect kümmert sich um den Wiederaufbau,
                    // hier reicht Sichtbarkeit.
                    console.warn(`nostr: DM-Subscription geschlossen (${JSON.stringify(reasons)}).`);
                },
            },
        );
    }

    const watchdogHandle = setInterval(() => {
        const idleMs = Date.now() - lastEventAt;
        if (idleMs < DM_WATCHDOG_STALE_MS) return;
        console.warn(`nostr: seit ${Math.round(idleMs / 60000)} Min kein Gift-Wrap-Event über diese Subscription – erzwinge Resubscribe (Relay hat die REQ vermutlich lautlos verworfen, siehe Vorfall 2026-08-01).`);
        try { subCloser.close('watchdog-resubscribe'); } catch { /* bereits zu, egal */ }
        lastEventAt = Date.now();
        subCloser = openSubscription();
    }, DM_WATCHDOG_INTERVAL_MS);

    return {
        close(reason) {
            clearInterval(watchdogHandle);
            subCloser.close(reason);
        },
    };
}

/**
 * Veröffentlicht Profil-Metadaten (NIP-01, kind 0) – Name/Bio, den andere
 * Clients (z.B. Amethyst) statt eines leeren/npub-Profils anzeigen. Kind 0 ist
 * "replaceable": erneutes Publizieren ersetzt das vorherige Profil beim Relay.
 */
export function publishProfile(pool, relays, identity, profile) {
    const event = finalizeEvent(
        {
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: JSON.stringify(profile),
        },
        identity.privkeyBytes,
    );
    return pool.publish(relays, event);
}

/**
 * Veröffentlicht die DM-Relay-Liste (NIP-17/NIP-51, kind 10050) – teilt anderen
 * Clients (z.B. Amethyst) mit, an welche Relays private DMs für diese Identität
 * zugestellt werden sollen. Ohne dieses Event finden Sender-Apps keine
 * "DM-Inbox Relays" und können nicht senden. Kind 10050 ist "replaceable":
 * erneutes Publizieren ersetzt einfach die vorherige Liste beim Relay.
 */
export function publishDmRelayList(pool, relays, identity) {
    const event = finalizeEvent(
        {
            kind: 10050,
            created_at: Math.floor(Date.now() / 1000),
            tags: relays.map(url => ['relay', url]),
            content: '',
        },
        identity.privkeyBytes,
    );
    return pool.publish(relays, event);
}

/**
 * Fragt Profil-Metadaten (kind 0, NIP-01) für eine Liste von Pubkeys (hex) ab.
 * Gibt eine Map pubkeyHex → Anzeigename zurück (name/display_name aus dem
 * JSON-Content, null wenn kein Profil gefunden oder Content nicht parsbar).
 * Bei mehreren kind-0-Events pro Autor zählt das neueste (created_at).
 */
export async function fetchProfileNames(pool, relays, pubkeyHexList) {
    const result = {};
    if (!pubkeyHexList.length) return result;

    const events = await pool.querySync(relays, { kinds: [0], authors: pubkeyHexList });
    const latestByAuthor = new Map();
    for (const event of events) {
        const prev = latestByAuthor.get(event.pubkey);
        if (!prev || event.created_at > prev.created_at) latestByAuthor.set(event.pubkey, event);
    }
    for (const [pubkey, event] of latestByAuthor) {
        try {
            const meta = JSON.parse(event.content);
            result[pubkey] = meta.display_name || meta.name || null;
        } catch {
            result[pubkey] = null;
        }
    }
    return result;
}

// Roher SimplePool-Export bleibt für Fälle ohne Reconnect-Bedarf (kurzlebige Scripts,
// z.B. core/premium/deliver-blob.js) — für alles Langlebige (DM-Subscription) createPool() nutzen.
export { RawSimplePool as SimplePool };
