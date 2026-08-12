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

// Ein Bot wird im Health Monitor NUR angezeigt, wenn sein systemd-Service auch
// wirklich aktiviert ist ('systemctl enable', so wie bin/install.sh es für
// tatsächlich installierte Dienste tut) – kein separates Config-Flag nötig,
// der Zustand kommt direkt vom System. Löst zwei Fälle einheitlich: (1) auf dem
// FORGE-public-Fork gibt es den Lending-Bot-Dienst heute schlicht noch nicht
// ('not-found') – ohne diesen Filter würde der Health-Check dort dauerhaft einen
// Fehler für einen nie existierenden Dienst melden; (2) ein künftiger Fork mit
// optionalem Lending-Bot zeigt ihn nur, wenn der Betreiber ihn beim Install
// tatsächlich aktiviert hat. Entscheidung 2026-07-31.
function isBotEnabled(serviceId) {
    try {
        return execSync(`systemctl is-enabled ${serviceId}`, { encoding: 'utf8', timeout: 3000 }).trim() === 'enabled';
    } catch (e) {
        return (e.stdout ?? '').trim() === 'enabled';
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
            ...(isBotEnabled('forge-lendingbot') ? [{
                id:          'forge-lendingbot',
                name:        'LendingBot',
                type:        'systemd',
                bots:        ['lend'],
                description: 'Bot 2 – verleiht USDC auf mehreren Lending-Protokollen (Kamino, Loopscale) und kassiert täglich Zinsen.',
            }] : []),
            {
                id:          'forge-liquiditybot',
                name:        'Liquidity Bot',
                type:        'systemd',
                bots:        ['liq'],
                description: 'Bot 3 – stellt in konzentrierten Liquiditätspools (Orca Whirlpools) Kapital bereit und vereinnahmt Handelsgebühren aus dem DEX-Handel.',
            },
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
