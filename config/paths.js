// ══════════════════════════════════════════════════════════════════════════════
// FORGE – Zentrale Pfad-Definitionen
// ══════════════════════════════════════════════════════════════════════════════
// EINE Quelle der Wahrheit für alle wichtigen FORGE-Verzeichnisse und -Dateien.
// Statt fehleranfälliger relativer Laufzeit-Auflösungen (resolve(__dirname,
// '../../data/prices.db')) importieren Module diese Konstanten:
//
//     import { PATHS } from '<relativ>/config/paths.js';
//     const db = new Database(PATHS.pricesDb);
//
// FORGE_ROOT wird EINMAL hier robust bestimmt (config/ liegt direkt unter FORGE).
// Alle abgeleiteten Pfade sind absolut und damit unabhängig davon, wie tief die
// importierende Datei liegt oder ob ein Bot-Verzeichnis verschoben wird.
//
// Hinweis (Node-Grenze): Statische `import`-Specifier geteilter Module
// (z.B. import ... from '../../core/config.js') KÖNNEN diese Konstanten nicht
// nutzen — Import-Pfade müssen String-Literale sein. Dafür wäre ein Workspace-/
// Bare-Specifier-Umbau nötig (bewusst zurückgestellt). PATHS deckt Laufzeit-
// Pfade ab (Dateien öffnen, Kindprozesse spawnen, Verzeichnisse bilden).
// ══════════════════════════════════════════════════════════════════════════════

import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { getBotConfig } from '../lib/bot-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// config/ liegt direkt unter FORGE-Root → genau eine stabile relative Auflösung.
export const FORGE_ROOT = path.resolve(__dirname, '..');

const j = (...p) => path.join(FORGE_ROOT, ...p);

// Bot-Verzeichnisse/DB-Dateien kommen aus der zentralen Registry (config/bots.json,
// siehe lib/bot-registry.js) statt hier ein zweites Mal hartcodiert zu sein.
const liquidityBot = getBotConfig('liquidity');
const lendingBot   = getBotConfig('lending');
const settingsBot  = getBotConfig('settings');

// ══════════════════════════════════════════════════════════════════════════════
// Ablage-Wurzeln: Zustandsdaten und Logs getrennt vom Code adressierbar
// ══════════════════════════════════════════════════════════════════════════════
// Master (Default, ENV nicht gesetzt): data/ und logs/ liegen INNERHALB des
// Checkouts — historisch gewachsen, bleibt exakt so.
//
// FORGE.pub-Fork: der Installer deployt den Code nach /opt/forge/app und setzt
// FORGE_DATA_DIR=/opt/forge/data, FORGE_LOG_DIR=/opt/forge/log,
// FORGE_SECRETS_DIR=/opt/forge/secrets. Dadurch ersetzt ein Update/Reinstall
// ausschließlich app/ und kann Zustandsdaten (offene Positionen, TVL-Schutz-
// Fortschritt, Premium-Token, Wallet-Keys) strukturell nicht mehr mitreißen —
// der teuerste Einzelschaden des Vorfalls vom 2026-07-31 (Root-Cause #4, siehe
// installer-fragilitaet.md).
//
// 🔒 INVARIANTE: Ohne gesetzte ENV-Variablen muss JEDER hier abgeleitete Pfad
// bit-identisch mit der Fassung vor dieser Umstellung sein. Das ist die einzige
// Absicherung dafür, dass der produktive Master von der Fork-Anpassung nichts
// merkt — bei Änderungen an diesem Block zwingend erhalten.
// Layout-Erkennung statt ENV-Variablen als Hauptweg: der Fork liegt unter
// <base>/app, daneben <base>/data. Das erkennt paths.js selbst — und zwar für
// JEDEN Aufrufweg gleichermaßen (systemd, Cron, manueller CLI-Aufruf). Würde die
// Struktur nur über Environment= in den systemd-Units gesetzt, liefen Cron-Jobs
// und Handaufrufe still auf <app>/data statt <base>/data — ein Fehler, der erst
// auffiele, wenn Daten an zwei Orten auseinanderlaufen.
// ENV-Variablen bleiben als Override möglich (Tests, Sonderfälle) und haben Vorrang.
// Erkannt wird an <base>/local — dem Sammelverzeichnis für ALLES, was zu dieser
// einen Installation gehört und ein Update überleben muss:
//     <base>/app            Code (wird bei jedem Update ersetzt)
//     <base>/local/data     Datenbanken
//     <base>/local/env      .env-Dateien
//     <base>/local/secrets  Wallet-Keys, Nostr-Identität, TLS
//     <base>/log            Logs (bewusst NICHT unter local/ – nicht im Backup)
// Dadurch lautet die Backup-Regel „sichere local/" statt einer Aufzählung, die
// man unvollständig zusammensetzen kann.
function detectForkBase(root) {
    if (path.basename(root) !== 'app') return null;
    const base = path.dirname(root);
    return existsSync(path.join(base, 'local')) ? base : null;
}
const FORK_BASE = detectForkBase(FORGE_ROOT);

const DATA_ROOT_ENV    = process.env.FORGE_DATA_DIR?.trim()
                      || (FORK_BASE && path.join(FORK_BASE, 'local', 'data'))    || null;
const LOG_ROOT_ENV     = process.env.FORGE_LOG_DIR?.trim()
                      || (FORK_BASE && path.join(FORK_BASE, 'log'))              || null;
const SECRETS_ROOT_ENV = process.env.FORGE_SECRETS_DIR?.trim()
                      || (FORK_BASE && path.join(FORK_BASE, 'local', 'secrets')) || null;
const ENV_ROOT_ENV     = process.env.FORGE_ENV_DIR?.trim()
                      || (FORK_BASE && path.join(FORK_BASE, 'local', 'env'))     || null;

/** Wurzel der zentralen (bot-übergreifenden) Datenbanken. */
export const DATA_ROOT    = DATA_ROOT_ENV    ?? j('data');
/** Wurzel aller Logdateien. */
export const LOG_ROOT     = LOG_ROOT_ENV     ?? j('logs');
/** Wurzel für Keys/Zertifikate (Master: FORGE/secrets, vom Installer sonst gesetzt). */
export const SECRETS_ROOT = SECRETS_ROOT_ENV ?? j('secrets');

/**
 * Datenverzeichnis eines Bots (DB, Lock-/PID-/Flag-Dateien, erzeugte JSON-Zustände).
 * Master: <FORGE>/bots/<bot>/data — Fork: <FORGE_DATA_DIR>/<botId>
 */
export function botDataDir(botId) {
    if (DATA_ROOT_ENV) return path.join(DATA_ROOT_ENV, botId);
    return j(getBotConfig(botId).dir, 'data');
}

/**
 * Logverzeichnis eines Bots.
 * Master: <FORGE>/bots/<bot>/logs — Fork: <FORGE_LOG_DIR>/<botId>
 */
export function botLogDir(botId) {
    if (LOG_ROOT_ENV) return path.join(LOG_ROOT_ENV, botId);
    return j(getBotConfig(botId).dir, 'logs');
}

/**
 * DB-Datei eines Bots. Dateiname kommt aus der Registry (config/bots.json),
 * das Verzeichnis über botDataDir() — dadurch wandert die DB im Fork automatisch mit.
 */
export function botDbPath(botId) {
    const { dbFile } = getBotConfig(botId);
    if (!dbFile) throw new Error(`paths: Bot "${botId}" hat keine dbFile in config/bots.json`);
    return path.join(botDataDir(botId), path.basename(dbFile));
}

// Legacy-Orte der .env-Dateien: im Master liegt jede .env neben ihrem Dienst.
// Genau diese Pfade liefert envFile() zurück, solange kein ENV-Root gesetzt ist —
// der Master merkt vom Umzug also nichts.
const LEGACY_ENV = {
    liquidity: j(liquidityBot.dir, '.env'),
    lending:   j(lendingBot.dir,   '.env'),
    settings:  j(settingsBot.dir,  '.env'),
    nexus:     j('core', 'nexus',   '.env'),
    premium:   j('core', 'premium', '.env'),
};

/**
 * Pfad der .env-Datei einer Komponente.
 * Master: neben dem Dienst — Fork: <base>/local/env/<komponente>.env
 *
 * Im Fork liegen die .env-Dateien bewusst AUSSERHALB von app/: sie enthalten
 * API-Keys und Wallet-Pfade, würden bei einem Update aber mit app/ gelöscht.
 * Sie über das Backup zurückzuholen wäre ein zusätzlicher Schritt, der laufen
 * MUSS — und der einen zwischenzeitlich geänderten Key stillschweigend auf den
 * Stand des letzten Backups zurückdrehen würde.
 */
export function envFile(component) {
    const legacy = LEGACY_ENV[component];
    if (!legacy) throw new Error(`paths: unbekannte .env-Komponente "${component}"`);
    return ENV_ROOT_ENV ? path.join(ENV_ROOT_ENV, `${component}.env`) : legacy;
}

/** PID-Datei eines Bots (gleiche Herleitung wie botDbPath). */
export function botPidPath(botId) {
    const { pidFile } = getBotConfig(botId);
    if (!pidFile) throw new Error(`paths: Bot "${botId}" hat keine pidFile in config/bots.json`);
    return path.join(botDataDir(botId), path.basename(pidFile));
}

export const PATHS = {
    root:    FORGE_ROOT,

    // Geteilte Infrastruktur (FORGE-Root)
    core:    j('core'),
    lib:     j('lib'),
    bin:     j('bin'),
    config:  j('config'),
    data:    DATA_ROOT,
    html:    j('html'),
    logs:    LOG_ROOT,
    secrets: SECRETS_ROOT,
    envDir:  ENV_ROOT_ENV ?? FORGE_ROOT,
    tmp:     j('.tmp'),
    bots:    j('bots'),

    // TLS-Zertifikate (Master: bots/settings/certs — Fork: <FORGE_SECRETS_DIR>/certs).
    // Im Fork bewusst unter secrets/: die mkcert-Root-CA ist wie ein Private Key ein
    // dauerhaftes Asset — geht sie bei einem Update verloren, müssen ALLE Clients im
    // LAN das Zertifikat neu importieren (siehe installer-fragilitaet.md Root-Cause #3).
    certs: SECRETS_ROOT_ENV
        ? path.join(SECRETS_ROOT_ENV, 'certs')
        : j(settingsBot.dir, 'certs'),

    // Bot-Roots (nach Restrukturierung: FORGE/bots/<name>)
    liquidity: j(liquidityBot.dir),
    lending:   j(lendingBot.dir),
    settings:  j(settingsBot.dir),

    // Bot-eigene Daten-/Logverzeichnisse (im Fork außerhalb von app/)
    liquidityData: botDataDir('liquidity'),
    lendingData:   botDataDir('lending'),
    liquidityLogs: botLogDir('liquidity'),

    // Zentrale DBs (liegen gemeinsam in DATA_ROOT)
    pricesDb:        path.join(DATA_ROOT, 'prices.db'),
    settingsDb:      path.join(DATA_ROOT, 'settings.db'),
    nexusDb:         path.join(DATA_ROOT, 'nexus.db'),
    healthDb:        path.join(DATA_ROOT, 'health.db'),
    premiumDb:       path.join(DATA_ROOT, 'premium.db'),
    rpcStatsDb:      path.join(DATA_ROOT, 'rpc-stats.db'),
    walletMonitorDb: path.join(DATA_ROOT, 'wallet-monitor.db'),

    // Cross-Bot-Ziele (von bots/settings/Reports gelesen – bot-intern, aber zentral referenziert)
    liquidityDb:      botDbPath('liquidity'),
    liquidityPools:   j('bots', 'liquidity', 'config', 'pools.json'),
    premiumPricing:   j('config', 'premium-pricing.json'),
    premiumMinVersion: j('config', 'premium-min-version.json'),
    version:          j('config', 'version.json'),
    liquidityScores:  path.join(botDataDir('liquidity'), 'pool-scores.json'),
    lendingDb:        botDbPath('lending'),

    // Geteilte Skripte / Module (für Kindprozess-Spawns)
    walletMonitor:  j('core', 'wallet-monitor', 'monitor.js'),
    syncScript:     j('bin', 'sync.sh'),
};

export default PATHS;
