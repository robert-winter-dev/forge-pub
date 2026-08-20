/**
 * FORGE Health Monitor – Dienstkonfiguration
 *
 * Zentrale Konfiguration aller zu überwachenden Dienste.
 * Neue Chains als weiteren Eintrag in `chains` ergänzen.
 *
 * service.type:
 *   'systemd'     – systemctl is-active <service.id>
 *   'http'        – HTTP-Check auf service.url (2xx/4xx = ok, 5xx/Timeout = error)
 *   'helius_rpc'  – Helius RPC getHealth (API-Key aus Nexus .env)
 *   'telegram'    – Telegram Bot API getMe (Token aus Nexus .env)
 *   'nostr_relay' – Verbindungsstatus des dauerhaften forge-premium-Relay-Pools
 *                   (lib/nostr-stats.js, abgefragt über core/premium GET /nostr/stats)
 *   'host_disk'   – Belegung eines Dateisystems (service.path, Default '/') via statfs
 *   'host_memory' – verfügbarer Arbeitsspeicher aus /proc/meminfo (MemAvailable),
 *                   Auslagerungsdatei fließt verschärfend ein
 *   'host_oom'    – Zähler abgeschossener Prozesse aus /proc/vmstat (oom_kill).
 *                   Kumulativ seit Systemstart, deshalb Differenz zum letzten Lauf
 *                   (Tabelle host_state) – Vorkommnisse zwischen zwei Prüfungen
 *                   gehen so nicht verloren. Alarmiert sofort, nicht erst beim
 *                   zweiten Fehlschlag in Folge (siehe bin/health-check.js)
 *   'premium_host_status' – Ergebnis des letzten Uploads eines Premium-Blob-Ablage-Hosts
 *                   (svc.hostKey, z.B. 'filebase'), gelesen aus data/premium.db
 *                   (lib/blob-storage.js protokolliert das als Nebenprodukt des ohnehin
 *                   alle 10 Min laufenden Publish-Versuchs – kein zusätzlicher Request)
 *
 * service.bots:
 *   Array von Bot-IDs, die diesen Dienst benötigen.
 *   Bekannte IDs: 'lend' (LendingBot), 'liq' (Liquidity Bot)
 *
 * service.description:
 *   Kurzer Erklärungstext für den Tooltip beim Hovern des Dienstnamens.
 */

import fs                 from 'fs';
import path               from 'path';
import { execSync }       from 'child_process';
import { PATHS }          from './paths.js';
import { identityExists } from '../lib/nostr-client.js';

// Ein Bot wird im Health Monitor angezeigt, sobald seine systemd-Unit auf dem System
// existiert – unabhängig davon, ob sie aktiviert ist. Ausgeblendet wird nur, was es
// gar nicht gibt: auf dem FORGE-public-Fork ist der Lending-Bot-Dienst heute nicht
// zwingend installiert ('not-found'), ohne diesen Filter meldete der Health-Check
// dort dauerhaft einen Fehler für einen nie existierenden Dienst.
//
// Bis 2026-08-13 filterte diese Funktion stattdessen auf 'systemctl is-enabled ==
// enabled' und blendete damit auch bewusst deaktivierte Bots komplett aus. Das war
// falsch: mit der Karte verschwindet auch die letzte Meldung des Dienstes und seine
// 7-Tage-Historie — niemand kann dann noch nachsehen, in welchem Zustand er stand,
// als er abgeschaltet wurde. Ein deaktivierter Dienst bekommt seitdem den eigenen
// Status 'disabled' ("Deaktiviert", siehe checkSystemd in bin/health-check.js), der
// weder warnt noch alarmiert, die Karte aber sichtbar lässt.
function isBotInstalled(serviceId) {
    try {
        const raw = execSync(`systemctl show ${serviceId} -p LoadState`, { encoding: 'utf8', timeout: 3000 });
        return raw.trim() !== 'LoadState=not-found';
    } catch {
        // Kein Urteil möglich (systemctl fehlt, Timeout): Karte lieber zeigen als
        // lautlos verschlucken – ein überflüssiger Eintrag fällt auf, ein fehlender nicht.
        return true;
    }
}

// Relay-Liste kommt aus config/nostr-relays.json (git-versioniert, Master und
// FORGE-public-Fork teilen dieselbe Datei) – hier nicht zweite Quelle der Wahrheit
// anlegen, sondern direkt einlesen. Leere Liste bei fehlender/kaputter Datei statt
// Absturz der gesamten Health-Config.
function loadNostrRelays() {
    try {
        const raw = fs.readFileSync(path.join(PATHS.config, 'nostr-relays.json'), 'utf8');
        const { relays } = JSON.parse(raw);
        return Array.isArray(relays) ? relays : [];
    } catch {
        return [];
    }
}

function relayServiceId(url) {
    return `nostr-${url.replace(/^wss?:\/\//, '').replace(/[^a-z0-9]+/gi, '-')}`;
}

// Umkehrung von isBotEnabled(): dieser Check ist NUR auf einem FORGE-public-Fork
// sinnvoll (Master publiziert Premium-Blobs, ingested aber nie welche). Die
// Master-Identität "FORGE.Master" existiert ausschließlich auf dem Master (ihr
// Private Key verlässt ihn nie, siehe lib/nostr-client.js) – ihre Abwesenheit ist
// damit ein robuster, pfadunabhängiger Fork-Indikator (unabhängig davon, ob
// NOSTR_SECRETS_DIR in diesem Prozess gesetzt ist).
const IS_FORK = !identityExists('FORGE.Master');

export const LOCAL_SERVER = {
    ip:        '0.0.0.0',  // LAN-IP des FORGE-Servers – hier anpassen
    nexusPort: 3100,
};

// Wie viele Tage History in der DB behalten
export const RETENTION_DAYS = 7;

export const chains = [
    // ── Grundfunktionen des Servers ────────────────────────────────────────────
    // Eigene Rubrik "Host", bewusst als erste (Festlegung 2026-08-13): läuft der
    // Server selbst nicht rund, ist jede Aussage der übrigen Rubriken unzuverlässig —
    // genau das war der Vorfall unten. Keine Einreihung unter "Intern": das hier
    // sind Messwerte des Hosts, keine Dienste mit einem Online/Offline-Zustand — sie
    // haben weder eine URL noch etwas, das man neu starten könnte.
    //
    // Anlass ist der Vorfall vom 2026-08-13: ein OOM-Zustand auf `business` (Swap
    // restlos belegt) ließ den Health-Check selbst so lange hängen, dass Jupiter,
    // Helius und Telegram gleichzeitig als "nicht erreichbar" gemeldet wurden. Der
    // Monitor sah den Ausfall, konnte ihn aber niemandem zuordnen, weil er die Lage
    // des eigenen Servers gar nicht kannte — die Fehlersuche lief tagelang gegen die
    // falschen Anbieter. Für FORGE.pub kommt der zweite Grund dazu: dort läuft die
    // Installation auf Hardware des Endnutzers (forge-pub2: 2 GB RAM, 15 GB Platte),
    // wo Knappheit ein realistischer Normalfall ist und nicht erst auffallen sollte,
    // wenn bereits etwas kaputt ist.
    //
    // Alle drei Prüfungen lesen ausschließlich lokal (/proc, statfs) — keine externen
    // Requests (rate-limit-neutral), keine zusätzliche Abhängigkeit und keine
    // erweiterten Rechte. Letzteres ist bewusst so gewählt: der `forge`-Benutzer auf
    // den Pub-Hosts ist NICHT in der Gruppe 'adm' und darf das Kernel-Journal nicht
    // lesen (geprüft 2026-08-13 auf pub1 und pub2) — eine journalctl-basierte
    // OOM-Erkennung hätte dort lautlos immer "kein Befund" geliefert.
    {
        id:    'host',
        label: 'Host',
        services: [
            {
                // Beide Speicher-Karten tragen bewusst dasselbe Präfix (Festlegung 2026-08-13):
                // für den Nutzer ist das EIN Thema ("reicht mein Arbeitsspeicher?"), nur in
                // zwei Blickwinkeln — der Zustand jetzt und die Vorkommnisse dazwischen.
                // "Speicher-Engpässe" allein ließ offen, worum es geht, und stand
                // unverbunden neben der Karte "Arbeitsspeicher".
                id:          'host-oom',
                name:        'RAM / Swap – Engpässe',
                type:        'host_oom',
                bots:        ['lend', 'liq'],
                description: 'Zählt Prozesse, die das Betriebssystem wegen Speichermangels abgeschossen hat (OOM-Killer). Jedes Vorkommnis wird sofort gemeldet – anders als die übrigen Prüfungen ist das kein Momentanwert, sondern ein Nachweis: der Zähler bleibt auch dann korrekt, wenn der Engpass zwischen zwei Prüfungen lag und danach längst vorbei war.',
            },
            {
                id:          'host-memory',
                name:        'RAM / Swap – Auslastung',
                type:        'host_memory',
                bots:        ['lend', 'liq'],
                description: 'Anteil des Arbeitsspeichers, der noch für neue Aufgaben zur Verfügung steht (MemAvailable – schließt Zwischenspeicher ein, der bei Bedarf sofort freigegeben wird). Die Auslagerungsdatei wird mitbewertet: ist sie fast voll, bremst das den ganzen Server aus, lange bevor Programme abstürzen.',
            },
            {
                id:          'host-disk',
                name:        'Festplatte',
                type:        'host_disk',
                path:        '/',
                bots:        ['lend', 'liq'],
                description: 'Belegung des Dateisystems, auf dem FORGE, seine Datenbanken und die Protokolle liegen. Läuft es voll, können die Bots ihre Datenbanken nicht mehr schreiben – ein Zustand, aus dem sie sich nicht selbst befreien können.',
            },
        ],
    },

    // ── Interne Dienste ────────────────────────────────────────────────────────
    {
        id:    'intern',
        label: 'Intern',
        services: [
            {
                id:          'forge-nexus',
                name:        'FORGE Nexus',
                type:        'systemd',
                bots:        ['lend', 'liq'],
                description: 'Zentraler FORGE-Router. Alle externen API-Anfragen der Bots laufen durch den Nexus – er übernimmt Rate-Limiting, RPC-Caching und leitet Benachrichtigungen weiter.',
            },
            ...(isBotInstalled('forge-lendingbot') ? [{
                id:          'forge-lendingbot',
                name:        'LendingBot',
                type:        'systemd',
                bots:        ['lend'],
                description: 'Bot 2 – verleiht USDC auf mehreren Lending-Protokollen (Kamino, Loopscale) und kassiert täglich Zinsen.',
            }] : []),
            // Dieselbe isBotInstalled()-Klammer wie beim LendingBot darüber: eine nicht
            // installierte Unit ist kein Dienst, über den sich etwas aussagen ließe. Der
            // deaktivierte Bot dagegen bleibt sichtbar und trägt den Status "Deaktiviert".
            ...(isBotInstalled('forge-liquiditybot') ? [{
                id:          'forge-liquiditybot',
                name:        'Liquidity Bot',
                type:        'systemd',
                bots:        ['liq'],
                description: 'Bot 3 – stellt in konzentrierten Liquiditätspools (Orca Whirlpools) Kapital bereit und vereinnahmt Handelsgebühren aus dem DEX-Handel.',
            }] : []),
            // Ergänzt 2026-08-13 (Systemdaten-Freigabe): Settings-Server und Premium liefen bis
            // hierhin ohne eigenen Health-Check – ihr Speicherverbrauch wäre für die
            // Refactoring-Messgrundlage (Pro-Prozess-Speicher aller 5 FORGE-Dienste,
            // config/bots.json) unsichtbar geblieben. isBotInstalled() wie bei den Bots
            // darüber, damit ein Fork ohne Settings-Server (falls je vorkommend) keine
            // Fehlkarte bekommt.
            ...(isBotInstalled('forge-settings') ? [{
                id:          'forge-settings',
                name:        'Settings Server',
                type:        'systemd',
                bots:        [],
                description: 'Interner Admin-Server (LAN, Port 3200) – Bot-Steuerung, Konfiguration, Wartungsmodus.',
            }] : []),
            ...(isBotInstalled('forge-premium') ? [{
                id:          'forge-premium',
                name:        'Premium',
                type:        'systemd',
                bots:        [],
                description: 'Nostr-Identität und Message Center – hält den dauerhaften Relay-Pool offen, liefert (Master) bzw. empfängt (Fork) den Premium-Blob.',
            }] : []),
            // Nur auf einem FORGE-public-Fork relevant (siehe IS_FORK) – der Master publiziert
            // Premium-Blobs, ingested aber selbst nie welche. Vorfall 2026-08-01: forge-premium
            // verlor auf forge-pub1 lautlos den DM-Empfang (WebSocket blieb laut `ss -tnp`
            // durchgehend verbunden, das Relay lieferte nur nichts mehr) – weder systemd
            // ('active' die ganze Zeit) noch der bestehende nostr_relay-Check (reiner
            // Verbindungsstatus) hätten das erkannt. Dieser Check bildet stattdessen die
            // tatsächliche Nutzdaten-Frische ab, die auch den "Score-Daten veraltet"-Banner
            // im Liquidity-Bot-Dashboard steuert – und löst über den bestehenden Persistenz-
            // Alert (2 Fehlschläge in Folge ≈ 10 Min) automatisch einen Telegram-Alert aus.
            ...(IS_FORK ? [{
                id:          'premium-ingest',
                name:        'Premium-Auslieferung (Empfang)',
                type:        'premium_ingest_status',
                bots:        ['liq'],
                description: 'Empfang der vom Master alle 10 Min gelieferten Premium-Score-Daten (core/premium/server.js → bots/liquidity/lib/premium-ingest.js). Zeigt, wie alt der letzte erfolgreich integrierte Blob ist – unabhängig davon, ob der Nostr-Relay-Verbindungsstatus selbst grün ist.',
            }] : []),
            // Nur auf einem FORGE-public-Fork relevant (siehe IS_FORK) – bin/update-check.js
            // läuft nie auf dem Master. Bewusst KEIN eigener GitHub-Request: reines Auslesen
            // der beiden Dateien, die update-check.js bei seinem täglichen Cron-Lauf ohnehin
            // schreibt (release-list-cache.json, update-fetch-failures.json). Ein
            // zusätzlicher periodischer Ping hätte genau das Risiko provoziert, das dieser
            // Check eigentlich beobachten soll: GitHub limitiert unauthentifizierte Requests
            // auf 60/h PRO QUELL-IP, und forge-pub1/forge-pub2 teilen sich eine öffentliche
            // IP – ein Vorfall am 2026-08-05 hat dieses Budget bereits einmal an einem
            // Nachmittag geleert (siehe Kopfkommentar bin/update-check.js). Bewusst NICHT in
            // der "Sonstiges"-Kette: die entfällt beim Fork-Export komplett (siehe
            // tools/pub-export/sanitize-text.js) – dort wäre dieser Fork-only-Check nie
            // im ausgelieferten Artefakt gelandet.
            ...(IS_FORK ? [{
                id:          'github-update',
                name:        'GitHub (Auto-Update)',
                type:        'github_update_status',
                bots:        [],
                description: 'GitHub liefert die signierten Releases für die automatischen Code-Updates (bin/update-check.js, täglich per Cron). Zeigt das Ergebnis des letzten Abrufs – kein eigener Check-Request, reine Auswertung des ohnehin laufenden Update-Checks.',
            }] : []),
        ],
    },

    // ── Solana-Dienste ─────────────────────────────────────────────────────────
    {
        id:    'solana',
        label: 'Solana',
        services: [
            {
                id:          'jupiter',
                name:        'Jupiter API',
                type:        'http',
                url:         'https://api.jup.ag/',
                method:      'GET',
                bots:        ['liq'],
                description: 'Dezentraler Swap-Aggregator auf Solana. Findet automatisch die günstigste Route zum Tauschen von Token – alle Käufe und Verkäufe der Bots laufen darüber.',
            },
            {
                id:          'helius',
                name:        'Helius RPC',
                type:        'helius_rpc',
                bots:        ['liq'],
                description: 'Solana-RPC-Node von Helius. Alle Blockchain-Abfragen – Wallet-Balances, Transaktionsstatus, Pool-Daten – laufen über diesen Dienst.',
            },
            {
                id:          'kamino',
                name:        'Kamino',
                type:        'http',
                url:         'https://api.kamino.finance/',
                method:      'HEAD',
                bots:        ['lend'],
                description: 'Lending-Protokoll auf Solana. Der LendingBot verleiht USDC und andere Token hier gegen variable Zinsen.',
            },
            {
                id:          'loopscale',
                name:        'Loopscale',
                type:        'http',
                url:         'https://tars.loopscale.com/',
                method:      'HEAD',
                bots:        ['lend'],
                description: 'Weiteres Lending-Protokoll auf Solana. Ergänzt Kamino im LendingBot-Portfolio und bietet oft unterschiedliche Zinssätze.',
            },
            {
                id:          'orca',
                name:        'Orca',
                type:        'http',
                url:         'https://api.mainnet.orca.so/',
                method:      'GET',
                bots:        ['liq'],
                description: 'CLMM-Liquiditätsprotokoll auf Solana (konzentrierte Liquidität). Der Liquidity Bot stellt hier in engen Preisbereichen Liquidität bereit und verdient Gebühren am Handel.',
            },
        ],
    },

    // ── Nostr-Relays ───────────────────────────────────────────────────────────
    // Minimal gehalten (Vorgabe: keine zusätzliche Systemlast): kein eigener
    // WS-Check, sondern reines Auslesen des Verbindungsstatus, den core/premium
    // (forge-premium) über seinen ohnehin dauerhaft offenen Relay-Pool schon führt
    // (lib/nostr-stats.js). Ein einzelner ausgefallener Relay ist bei einer
    // Relay-LISTE by design unkritisch (Redundanz) – der Persistenz-Alert in
    // bin/health-check.js behandelt diese Chain deshalb als Sonderfall: Meldung
    // nur, wenn ALLE Relays gleichzeitig anhaltend getrennt sind.
    {
        id:    'nostr',
        label: 'Nostr',
        services: loadNostrRelays().map(url => ({
            id:          relayServiceId(url),
            name:        url.replace(/^wss?:\/\//, ''),
            type:        'nostr_relay',
            relayUrl:    url,
            bots:        [],
            description: 'Nostr-Relay für das FORGE Message Center (Support-Chat, Premium-Auslieferung). Zeigt den Verbindungsstatus des dauerhaften Relay-Pools von forge-premium.',
        })),
    },


    // ── Base (Platzhalter – wird später befüllt) ───────────────────────────────
    {
        id:          'base',
        label:       'Base',
        placeholder: true,
        services:    [],
    },
];
