/**
 * FORGE – Nostr-Client (gemeinsam genutzt)
 *
 * Dünner Wrapper um nostr-tools für das Message Center (Proof of Concept):
 * Identität laden/anlegen, Relay-Liste laden, private DMs senden/empfangen
 * (NIP-17 Gift-Wrap, NIP-44-Verschlüsselung).
 *
 * Private Keys liegen NIE in Git. Ablageort ist konfigurierbar, weil Master und
 * FORGE-public-Fork unterschiedliche Konventionen haben:
 *
 *   Master (Default):  data/secrets/nostr/<name>.json   – data/ ist .gitignore't
 *   FORGE-public-Fork:    NOSTR_SECRETS_DIR=/opt/forge/secrets
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
import { SimplePool as RawSimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip19, nip17, utils } from 'nostr-tools';
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
 * Bewertet EIN Ergebnis aus Promise.allSettled() über die Promises von pool.publish().
 *
 * 🔴 Nicht trivial, deshalb zentral: nostr-tools' `publish()` (abstract-pool.js) **resolved**
 * bei einem Verbindungsfehler mit dem String `"connection failure: …"`, statt zu rejecten.
 * Ein naives `r.status === 'fulfilled'` zählt genau die Relays als bestätigt, die gar nicht
 * erreicht wurden — die Bestätigungsquoten waren dadurch systematisch zu optimistisch.
 * Nur ein Relay, das ein `OK true` geschickt hat, gilt hier als bestätigt.
 *
 * @returns {{ok: boolean, text: string}} text ist für die Logzeile gedacht (ohne Leerzeichen).
 */
export function bewertePublishErgebnis(ergebnis) {
    if (ergebnis.status === 'rejected') {
        const roh = ergebnis.reason instanceof Error ? ergebnis.reason.message : String(ergebnis.reason ?? '');
        const grund = kuerzeGrund(ergebnis.reason);
        // 🔴 Ein Timeout ist KEIN gescheitertes Publish, sondern eine ausgebliebene Quittung.
        // Gegenprobe 2026-08-14: nach einem Neustart, den das Log mit 1/4 protokollierte,
        // lagen kind 0 UND kind 10050 auf ALLEN VIER Relays in der neuen Fassung — die drei
        // "fehlgeschlagenen" Publishes waren zugestellt, nur das OK kam nicht binnen
        // publishTimeout (4400 ms) zurück. Das eigene Wort dafür verhindert, dass die Zeile
        // erneut als Zustellproblem gelesen wird (Gegenprobe dokumentiert im Changelog 2026-08-14).
        // Gegen den ROHTEXT prüfen: kuerzeGrund() ersetzt Leerzeichen durch Bindestriche.
        if (/timed?\s*out/i.test(roh)) return { ok: false, text: 'unbestaetigt:timeout' };
        return { ok: false, text: `FEHLER:${grund}` };
    }
    const wert = ergebnis.value;
    if (typeof wert === 'string' && wert.startsWith('connection failure')) {
        // Hier ist die Zustellung wirklich gescheitert – es kam nicht einmal eine Verbindung
        // zustande, das Event wurde nie gesendet.
        return { ok: false, text: `FEHLER:${kuerzeGrund(wert)}` };
    }
    // Alles andere ist ein OK des Relays; der Wert ist dessen (meist leere) Begründung.
    return { ok: true, text: wert ? `ok:${kuerzeGrund(wert)}` : 'ok' };
}

/** Macht einen beliebigen Fehlergrund logtauglich: einzeilig, ohne Leerzeichen, gekürzt. */
function kuerzeGrund(grund) {
    const text = grund instanceof Error ? grund.message : String(grund ?? 'unbekannt');
    return text.replace(/\s+/g, '-').slice(0, 60);
}

/**
 * Protokolliert das Ergebnis eines Publish je Relay und gibt das unveränderte
 * Promise-Array zurück — Aufrufer arbeiten damit weiter wie bisher (Promise.any /
 * Promise.allSettled), das Verhalten ändert sich nicht.
 *
 * Die Zeile ist maschinenlesbar, damit sich die Zustellquote je Relay über Tage
 * auswerten lässt (offene Frage aus der Messung vom 2026-08-14: warum
 * bestätigen regelmäßig nur 1–2 von 4 Relays?):
 *   nostr-publish <art> ok=2/4 nostr.mom=ok nos.lol=ok relay.primal.net=FEHLER:… …
 *
 * Nebeneffekt mit Sicherheitsgewinn: die interne allSettled()-Kette hängt an JEDER
 * Publish-Promise einen Handler, auch wenn der Aufrufer nur Promise.any() nutzt —
 * unbehandelte Rejections können dadurch nicht mehr entstehen.
 */
function protokolliereVeroeffentlichung(relays, promises, art) {
    Promise.allSettled(promises).then(ergebnisse => {
        let bestaetigt = 0, unbestaetigt = 0, fehler = 0;
        const felder = ergebnisse.map((e, i) => {
            const bewertung = bewertePublishErgebnis(e);
            if (bewertung.ok) bestaetigt++;
            else if (bewertung.text.startsWith('unbestaetigt')) unbestaetigt++;
            else fehler++;
            return `${(relays[i] ?? '?').replace('wss://', '')}=${bewertung.text}`;
        });
        // Drei getrennte Zähler statt eines "ok=n/m": nur `fehler` bedeutet nachweislich
        // nicht zugestellt, `unbestaetigt` heißt lediglich "keine Quittung erhalten".
        console.log(`nostr-publish ${art} bestaetigt=${bestaetigt}/${relays.length} unbestaetigt=${unbestaetigt} fehler=${fehler} ${felder.join(' ')}`);
    });
    return promises;
}

/**
 * Sendet eine private DM (NIP-17 Gift-Wrap) an einen Empfänger-Pubkey (hex).
 * Gibt die Publish-Promises pro Relay zurück (siehe nostr-tools SimplePool.publish).
 */
export function sendDirectMessage(pool, relays, senderIdentity, recipientPubkeyHex, text) {
    const wrapped = nip17.wrapEvent(senderIdentity.privkeyBytes, { publicKey: recipientPubkeyHex }, text);
    return protokolliereVeroeffentlichung(relays, pool.publish(relays, wrapped), 'dm');
}

// Watchdog gegen lautlos verstummte Subscriptions (Fund 2026-08-01): ein Relay kann
// eine offene REQ intern verwerfen (Restart, Rate-Limit, Bug), ohne CLOSE zu senden
// und ohne die WebSocket-Verbindung zu trennen — Ping/Pong (enablePing) antwortet
// weiter normal, `relay.connected` bleibt true, aber es kommt nie wieder ein Event
// an. enableReconnect greift hier NICHT, weil es nur auf einen echten Verbindungs-
// abbruch reagiert. Einzige robuste Gegenmaßnahme: aktiv prüfen, wie lange das
// letzte Event her ist, und im Zweifel proaktiv neu subscriben (neue REQ-ID zwingt
// den Relay, den Zustand frisch aufzubauen). 15 Min liegt deutlich über dem
// 10-Min-Publish-Takt von FORGE public Premium, damit ein einzelner verzögerter
// Blob-Lauf keinen Fehlalarm/Resubscribe auslöst.
const DM_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const DM_WATCHDOG_STALE_MS    = 15 * 60 * 1000;

// Werden mehrere Relays im selben Tick als still erkannt, wird NICHT alles gleichzeitig
// abgerissen — die Resubscribes laufen um diesen Betrag versetzt. Messung 2026-08-14
// (2026-08-14, ausgewertet über nostr_relay_events): auf beiden Hosts betraf KEIN
// einziger von 176 echten Ausfällen alle Relays gleichzeitig, 167 davon genau eines.
// Ein Sammelabriss aller vier wäre also immer eine selbstgemachte Lücke.
const DM_RESUBSCRIBE_STAGGER_MS = 3000;

// Turnus des Vorsorge-Resubscribes JE RELAY. Bei vier Relays ist damit alle 90 Min genau
// eines an der Reihe. Der Preis jedes Resubscribes ist ein voller Backlog-Replay dieses
// Relays (beim Start am 2026-08-14 gemessen: ~500 Events je Relay, per Dedup abgefangen,
// also ohne Doppelverarbeitung) — deshalb bewusst Stunden statt Minuten.
const DM_VORSORGE_RECONNECT_MS = 6 * 60 * 60 * 1000;

// Mindestabstand zwischen zwei Resubscribes desselben Relays. Verhindert, dass Watchdog
// und Turnus dasselbe Relay kurz hintereinander zweimal abreißen.
const DM_VORSORGE_MIN_ABSTAND_MS = 60 * 60 * 1000;

// Obergrenze für die Dedup-Menge (siehe subscribeDirectMessages): ersetzt das interne
// `_knownIds`-Set von subscribeMany(), das über ein Prozessleben unbegrenzt wächst.
// 10.000 Gift-Wraps sind bei FORGEs Verkehr (Größenordnung 100/Tag) mehrere Monate
// Historie — weit mehr, als ein Relay-Backlog je auf einmal nachliefert.
const DM_SEEN_LIMIT = 10_000;

/**
 * Entschärft eine Falle in nostr-tools 2.24.1 (abstract-relay.js, `ws.onopen`):
 * Nach JEDEM Reconnect setzt die Bibliothek ungefragt `filters[].since = lastEmitted + 1`,
 * wobei `lastEmitted` das höchste gesehene `created_at` ist.
 *
 * 🔴 Für kind 1059 ist das ein Datenverlust-Generator: NIP-17-Gift-Wraps haben laut
 * Spezifikation ABSICHTLICH randomisierte `created_at` (Anti-Korrelations-Schutz). Eine
 * später eintreffende, legitime Nachricht kann einen kleineren Zufalls-Offset haben als
 * eine frühere — und wird vom injizierten `since` dauerhaft verschluckt. Exakt dieselbe
 * Falle hatte FORGE am 2026-08-08 schon einmal selbst gebaut und zurückgenommen (siehe
 * Kommentar in subscribeDirectMessages), hier steckt sie in der Bibliothek und ist nicht
 * über eine Option abschaltbar.
 *
 * Gegenmaßnahme ohne Patch an node_modules: `lastEmitted` auf der konkreten
 * Subscription-Instanz als No-Op überschreiben. Der Schreibzugriff der Bibliothek läuft
 * dann ins Leere, `if (sub.lastEmitted)` ist immer falsy und es wird nie ein `since`
 * gesetzt. Zusätzlich wird ein evtl. bereits injiziertes `since` entfernt.
 *
 * Bewusst defensiv (optional chaining, try/catch): greift die Bibliothek eines Tages
 * anders zu, verliert FORGE nur diesen Schutz — der Empfang läuft weiter.
 */
function schuetzeGegenSinceInjektion(pool, relayUrl) {
    try {
        const relay = pool.relays?.get(utils.normalizeURL(relayUrl));
        if (!relay?.openSubs) return;
        for (const sub of relay.openSubs.values()) {
            // Nur unsere DM-Subscriptions anfassen, keine fremden Abfragen auf demselben Pool.
            if (!sub.filters?.some(f => f.kinds?.includes(1059))) continue;
            for (const f of sub.filters) delete f.since;
            if (sub.__forgeSinceGuard) continue;
            Object.defineProperty(sub, 'lastEmitted', {
                get: () => undefined,
                set: () => { /* absichtlich verworfen, s.o. */ },
                configurable: true,
            });
            sub.__forgeSinceGuard = true;
        }
    } catch (err) {
        console.warn(`nostr: since-Schutz für ${relayUrl} konnte nicht gesetzt werden: ${err.message}`);
    }
}

/**
 * Abonniert eingehende private DMs (kind 1059, an die eigene Pubkey adressiert).
 * onMessage(rumor) wird pro entschlüsselter Nachricht GENAU EINMAL aufgerufen, auch wenn
 * mehrere Relays dasselbe Gift-Wrap liefern (rumor.content = Text, rumor.pubkey =
 * Absender-Pubkey, rumor.created_at = Unix-Sekunden).
 * Gibt einen Closer zurück (`.close()` beendet alle Relay-Subscriptions + Watchdog).
 */
export function subscribeDirectMessages(pool, relays, myIdentity, onMessage) {
    // Bewusst EINE Subscription JE RELAY statt eines gepoolten subscribeMany(relays, …).
    // Grund (Messung 2026-08-14 über nostr_relay_events): Ausfälle treffen
    // fast immer genau ein Relay. Mit einer gepoolten Subscription war weder erkennbar,
    // WELCHES Relay verstummt ist (ein einziger gemeinsamer lastEventAt, und onclose()
    // feuert erst, wenn ALLE Relays geschlossen haben), noch ließ sich gezielt nur das
    // betroffene Relay heilen — der Watchdog riss immer alle vier gleichzeitig ab.
    //
    // Der Preis dieser Umstellung ist die Dedup-Logik: subscribeMany() dedupliziert
    // Events über seine Relays hinweg (internes `_knownIds`), getrennte Subscriptions
    // tun das nicht — dasselbe Gift-Wrap käme sonst bis zu 4x bei onMessage an. Deshalb
    // wird das Dedup hier explizit selbst geführt (siehe `gesehen` unten). Es MUSS nach
    // der Aktivitätsbuchung greifen: gerade die Duplikate sind das Signal dafür, dass ein
    // einzelnes Relay noch liefert.
    const gesehen = new Set();
    const zustand = new Map();   // Relay-URL (wie konfiguriert) → { closer, lastEventAt, events }
    let gestoppt = false;

    /** true, wenn dieses Gift-Wrap noch nicht verarbeitet wurde (und merkt es sich). */
    function istNeu(eventId) {
        if (!eventId) return true;
        if (gesehen.has(eventId)) return false;
        gesehen.add(eventId);
        if (gesehen.size > DM_SEEN_LIMIT) {
            // FIFO: Set behält Einfügereihenfolge, ältester Eintrag fliegt raus.
            gesehen.delete(gesehen.values().next().value);
        }
        return true;
    }

    // 🔴 Fund 2026-08-08, zurückgenommen und weiterhin gültig: ein früherer Versuch, hier
    // einen `since`-Cursor (höchstes je gesehenes `created_at`) an den Resubscribe
    // mitzugeben, hat die Premium-Blob-Auslieferung auf forge-pub1/pub2 komplett
    // stillgelegt. Grund: NIP-17 Gift-Wraps (kind 1059 – GENAU das, was hier gefiltert
    // wird) haben laut Spezifikation ABSICHTLICH randomisierte `created_at`-Werte
    // (Anti-Korrelations-Schutz) – spätere, legitime Nachrichten können einen KLEINEREN
    // Zufalls-Offset haben als eine frühere und wurden dadurch vom `since`-Filter dauerhaft
    // verschluckt. `since` ist auf dieser Ebene grundsätzlich nicht sicher nutzbar; genau
    // deshalb entfernt schuetzeGegenSinceInjektion() auch das `since`, das nostr-tools beim
    // Reconnect von sich aus setzt. Der damalige Bug (Reissue-Schleife durch Backlog-Replay
    // nach Rubriken-Cap-Pruning) ist stattdessen serverseitig gefixt, siehe
    // markActivationEventProcessed() in server.js/messages-db.js.

    /**
     * Öffnet (oder erneuert) die Subscription für GENAU EIN Relay.
     *
     * Der Filter wird pro Relay frisch aufgebaut und nicht wiederverwendet: nostr-tools
     * mutiert das Filterobjekt beim Reconnect in-place (`filters[f].since = …`). Ein
     * gemeinsam genutztes Objekt würde eine solche Mutation an alle anderen Relays
     * weiterreichen — ein einzelner Reconnect könnte damit den Empfang aller vergiften.
     */
    function oeffneFuerRelay(url) {
        const eintrag = zustand.get(url) ?? { closer: null, lastEventAt: Date.now(), events: 0 };
        eintrag.lastEventAt = Date.now();
        eintrag.closer = pool.subscribeMany(
            [url],
            { kinds: [1059], '#p': [myIdentity.pubkeyHex] },
            {
                onevent(event) {
                    // Aktivität VOR dem Dedup buchen – ein Duplikat von diesem Relay ist der
                    // Beweis, dass genau dieses Relay noch liefert. Genau diese Information
                    // ging in der gepoolten Variante verloren.
                    eintrag.lastEventAt = Date.now();
                    eintrag.events++;
                    if (!istNeu(event.id)) return;
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
                    // Feuert jetzt PRO RELAY (die Subscription umfasst nur eines) – vorher erst,
                    // wenn alle vier geschlossen waren, weshalb die Logzeile immer alle vier
                    // auflistete und nie das schuldige Relay benannte (Vorfall 2026-08-01).
                    if (gestoppt) return;
                    const grund = reasons?.[0]?.reason ?? JSON.stringify(reasons);
                    console.warn(`nostr: DM-Subscription zu ${url} geschlossen (${grund}).`);
                },
            },
        );
        zustand.set(url, eintrag);

        // Der since-Schutz muss auf der Subscription-Instanz sitzen, die erst nach dem
        // Verbindungsaufbau in relay.openSubs auftaucht – daher gestaffelt nachziehen.
        // Einmal gesetzt, hält er für alle späteren Reconnects derselben Instanz; der
        // Watchdog-Tick prüft zusätzlich regelmäßig nach.
        for (const verzoegerung of [2000, 10_000, 60_000]) {
            const t = setTimeout(() => schuetzeGegenSinceInjektion(pool, url), verzoegerung);
            t.unref?.();
        }
    }

    for (const url of relays) oeffneFuerRelay(url);

    /**
     * Baut die Subscription EINES Relays neu auf (neue REQ-ID erzwingt frischen Zustand).
     * `grund` landet als Close-Reason im Log der Gegenstelle und in unserer eigenen
     * onclose-Zeile — die beiden Auslöser (Watchdog vs. Turnus) bleiben so unterscheidbar.
     */
    function resubscribe(url, grund, meldung) {
        if (gestoppt) return;
        const eintrag = zustand.get(url);
        console.warn(meldung);
        try { eintrag?.closer?.close(grund); } catch { /* bereits zu, egal */ }
        oeffneFuerRelay(url);
        if (eintrag) eintrag.letzterResubscribeAt = Date.now();
    }

    const watchdogHandle = setInterval(() => {
        const jetzt = Date.now();
        const still = [];
        for (const url of relays) {
            schuetzeGegenSinceInjektion(pool, url);
            const eintrag = zustand.get(url);
            if (!eintrag) continue;
            if (jetzt - eintrag.lastEventAt >= DM_WATCHDOG_STALE_MS) still.push(url);
        }

        // Eine maschinenlesbare Statuszeile je Tick – damit sich im Nachhinein auswerten
        // lässt, WELCHES Relay wann still war (Auswertung siehe Changelog 2026-08-14).
        const felder = relays.map(url => {
            const e = zustand.get(url);
            const alterS = e ? Math.round((jetzt - e.lastEventAt) / 1000) : -1;
            const verbunden = pool.relays?.get(utils.normalizeURL(url))?.connected ? 1 : 0;
            return `${url.replace('wss://', '')}=${alterS}s/${e?.events ?? 0}/conn:${verbunden}`;
        });
        console.log(`nostr-relaystat still=${still.length}/${relays.length} ${felder.join(' ')}`);

        // Versetzt statt gleichzeitig: nie alle Relays im selben Moment abreißen.
        still.forEach((url, i) => {
            const idleMs = jetzt - (zustand.get(url)?.lastEventAt ?? jetzt);
            const meldung = `nostr: ${url} liefert seit ${Math.round(idleMs / 60000)} Min kein Gift-Wrap-Event – erzwinge Resubscribe NUR für dieses Relay (REQ vermutlich lautlos verworfen, siehe Vorfall 2026-08-01).`;
            if (i === 0) { resubscribe(url, 'watchdog-resubscribe', meldung); return; }
            const t = setTimeout(() => resubscribe(url, 'watchdog-resubscribe', meldung), i * DM_RESUBSCRIBE_STAGGER_MS);
            t.unref?.();
        });
    }, DM_WATCHDOG_INTERVAL_MS);

    // ── Vorsorge-Resubscribe (Turnus) ────────────────────────────────────────
    // Der Watchdog ist reaktiv: er merkt eine lautlos verworfene REQ erst nach 15 Min
    // Stille — und nur, wenn überhaupt Verkehr zu erwarten wäre. Diese Rotation erneuert
    // die REQ jedes Relays zusätzlich turnusmäßig, BEVOR sie auffällt.
    //
    // Strikt eines nach dem anderen: pro Timer-Auslösung genau ein Relay, im Abstand von
    // DM_VORSORGE_RECONNECT_MS / Anzahl Relays. Bei vier Relays und 6 h Turnus ist also
    // alle 90 Min genau ein Relay dran — die anderen drei bleiben durchgehend bedient.
    // Das ist die direkte Konsequenz der Messung vom 2026-08-14: Ausfälle sind Einzel-
    // ereignisse, Redundanz ist der Schutz, und ein Sammelabriss wäre die einzige Art,
    // wie FORGE sich diese Redundanz selbst kaputtmachen könnte.
    //
    // Erneuert wird bewusst NUR die Subscription, nicht die WebSocket-Verbindung: gegen
    // eine halbtote Verbindung wirkt bereits enablePing, und ein echter Verbindungs-
    // neuaufbau würde den Reconnect-Pfad von nostr-tools mit seiner since-Injektion
    // betreten (siehe schuetzeGegenSinceInjektion). Eine frische REQ-ID genügt, um einen
    // Relay-seitig verworfenen Subscription-Zustand neu aufzubauen.
    let turnusIndex = 0;
    const turnusHandle = setInterval(() => {
        if (gestoppt || relays.length === 0) return;
        const url = relays[turnusIndex % relays.length];
        turnusIndex++;
        const eintrag = zustand.get(url);
        const seitLetztem = Date.now() - (eintrag?.letzterResubscribeAt ?? 0);
        // Hat der Watchdog dieses Relay eben erst erneuert, wäre ein zweiter Abriss nur
        // unnötiger Backlog-Verkehr — dann diese Runde überspringen.
        if (seitLetztem < DM_VORSORGE_MIN_ABSTAND_MS) {
            console.log(`nostr: Vorsorge-Resubscribe für ${url} übersprungen (vor ${Math.round(seitLetztem / 60000)} Min bereits erneuert).`);
            return;
        }
        resubscribe(url, 'vorsorge-resubscribe',
            `nostr: turnusmäßiger Vorsorge-Resubscribe für ${url} (je Relay alle ${Math.round(DM_VORSORGE_RECONNECT_MS / 3600000)} h, immer nur eines gleichzeitig).`);
    }, Math.max(60_000, Math.round(DM_VORSORGE_RECONNECT_MS / Math.max(1, relays.length))));

    return {
        close(reason) {
            gestoppt = true;
            clearInterval(watchdogHandle);
            clearInterval(turnusHandle);
            for (const eintrag of zustand.values()) {
                try { eintrag.closer?.close(reason); } catch { /* bereits zu, egal */ }
            }
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
    return protokolliereVeroeffentlichung(relays, pool.publish(relays, event), 'profil-kind0');
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
    return protokolliereVeroeffentlichung(relays, pool.publish(relays, event), 'dm-relayliste-kind10050');
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
