#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// FORGE public – Auto-Update-Orchestrator
// ══════════════════════════════════════════════════════════════════════════════
// Läuft täglich per Cron im installierten Fork (/opt/forge/app/bin/update-check.js).
// Setzt lib/update-verify.js + bin/setup.sh (update, rollback-code) zusammen zum
// vollständigen Ablauf aus update.md ("Umsetzungsentwurf 2026-08-03" + "Betriebszyklus"):
//
//   1. GitHub-Releases abfragen, nach Channel filtern
//   2. Manifest + Signatur laden
//   3. Signatur gegen local/trust/trust-anchor.json prüfen (Primär ODER Recovery)
//   4. versionCode > installiert? (Downgrade-Schutz, T3)
//   5. minDataSchema geloggt (informativ – Premium-Client prüft das selbst)
//   6. Tarball laden, sha256 gegen Manifest prüfen
//   7. Entpacken nach /opt/forge/staging/<version>/
//   8. Policy: Patch-Level + Auto-Apply aktiv? Sonst nur Meldung, Ende.
//   9. bin/setup.sh update AUS DEM STAGING-VERZEICHNIS aufrufen (löst das
//      Selbst-Update-Paradox ohne Sonderlogik, siehe do_deploy-ARTIFACT_DIR-Guard)
//  10. Health-Gate: Vergleich gegen den Zustand VOR dem Update (was lief, muss
//      laufen; NRestarts darf nicht steigen) — bewusst NICHT "alle sechs aktiv",
//      sonst rollt jedes Update bei einer Installation zurück, in der ein Dienst
//      aus legitimem Grund steht. Fehlschlag:
//      - hasMigrations:true  → KEIN Auto-Rollback, Dienste stoppen, Alarm
//      - hasMigrations:false → Auto-Rollback per setup.sh rollback-code
//
// 🔒 Läuft NIE auf business — nur im installierten Fork. Der GitHub-Abrufpfad
//    (fetchRelease ohne --source) ist bis zum ersten echten Promote UNGETESTET,
//    da noch kein reales Repo existiert (siehe update.md "Test-Strategie:
//    Staging-Kanal") — vor dem ersten Produktiveinsatz gegen ein echtes Release
//    verifizieren.
//
// Test-/Entwicklungsmodus (kein GitHub nötig):
//   node bin/update-check.js --source <verzeichnis-mit-manifest.json+.sig+tarball>
//   [--dry-run]   bricht nach dem Entpacken ab, wendet nichts an, startet nichts neu
//   [--no-notify] schickt KEINE Meldung an Nexus, schreibt sie nur ins lokale Log.
//                 Pflicht für jeden Testlauf auf 'business': dort läuft unter demselben
//                 Port der produktive forge-nexus, und ein Testlauf ohne Trust-Anchor
//                 erzeugt sonst einen echten error-Alarm samt Telegram-Versand (real
//                 passiert am 2026-08-10, Meldung update-trust). FORGE_PUB_NEXUS_URL
//                 hilft nur, wenn ein Ersatz-Nexus bereitsteht — dieser Schalter
//                 braucht keinen.
//   [--confirm]   übergeht die Auto-Apply-Politik (autoApplyPatch/isPatchLevel) — für
//                 den manuellen "Update"-Menüpunkt in bin/setup.sh, NICHT für Cron.
//                 Signatur-/Hash-/Downgrade-Prüfung bleiben immer aktiv.
//
// FORGE_PUB_BASE_DIR (Env-Override): Basisverzeichnis statt /opt/forge — nur für
// lokale Tests außerhalb einer echten Installation, niemals in Produktion setzen.
//
// FORGE_PUB_UPDATE_TOKEN (Env-Override) / local/update-token.txt: GitHub-Token,
// das an die Releases-API und an Asset-Downloads angehängt wird. Zwei Zwecke:
//   (a) NUR damit dieser Pfad auch gegen ein privates forge-pub-Repo testbar ist
//       (Fund 2026-08-05: das Repo kurz auf "public" zu schalten war die
//       Alternative, ist aber echte, sofort auffindbare Öffentlichkeit — keine
//       "geheime URL", GitHub kennt kein Unlisted).
//   (b) seit 2026-08-12: hebt das GitHub-Rate-Limit für den Abruf der
//       Release-Liste von 60/h (unauthentifiziert, PRO QUELL-IP) auf 5000/h an
//       — nötig für forge-pub1/forge-pub2, die sich dieselbe öffentliche IP
//       teilen und dadurch ihr Budget gemeinsam verbrauchen (real passiert:
//       ein paar manuelle Checks + Diagnose haben das 60er-Limit an einem
//       Nachmittag geleert, `update-check.js` scheiterte reihum mit rohem
//       "fetch failed"). Datei bevorzugt gegenüber der Env-Var, weil sudoers
//       Umgebungsvariablen beim `sudo -n`-Aufruf aus bot-control-daemon.js
//       ohnehin zurücksetzt (env_reset) — ein Datei-Read übersteht das ohne
//       sudoers-Änderung.
// 🔒 Echte Kunden setzen weder die Variable noch legen sie diese Datei an (das
// öffentliche stable-Repo braucht dafür keine Auth) — bewusst kein Bestandteil
// des Artefakts/`local/`-Defaults, keine Doku dafür in GETTING-STARTED.txt,
// kein Setup-Schritt legt sie an. Ein globaler, im Fork mitgeshippter Token
// wäre KEINE Verbesserung für Kunden: alle Installationen würden sich dann ein
// einziges, geteiltes 5000/h-Kontingent teilen — bei wachsender Nutzerzahl
// schneller erschöpft als das heutige Pro-IP-Modell. Diese Datei ist deshalb
// bewusst NUR für unsere beiden Test-VMs gedacht, nie für die Verteilung.
// ══════════════════════════════════════════════════════════════════════════════

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAgainstTrustAnchor } from '../lib/update-verify.js';
import { t } from '../lib/i18n.js';
import { renderNotification } from '../lib/notify-render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const BASE_DIR = process.env.FORGE_PUB_BASE_DIR || path.join(APP_DIR, '..');
const LOCAL_DIR = path.join(BASE_DIR, 'local');
const TRUST_ANCHOR_PATH = path.join(LOCAL_DIR, 'trust/trust-anchor.json');
const STAGING_DIR = path.join(BASE_DIR, 'staging');
const SETUP_SH = path.join(APP_DIR, 'bin/setup.sh');
const SERVICES = ['forge-nexus', 'forge-premium', 'forge-settings', 'forge-settings-daemon', 'forge-liquiditybot', 'forge-lendingbot'];
// FORGE_PUB_NEXUS_URL nur für lokale Tests außerhalb einer echten Installation
// (wie FORGE_PUB_BASE_DIR) — verhindert, dass Testläufe auf 'business' den dort
// unter demselben Port laufenden PRODUKTIVEN forge-nexus mit Test-Meldungen treffen
// (Fund 2026-08-03: erste Testläufe haben genau das getan, siehe Ticket-Kontext).
const NEXUS_URL = process.env.FORGE_PUB_NEXUS_URL || 'http://127.0.0.1:3100';
// --no-notify wird bewusst hier auf Modulebene gelesen und nicht erst in main():
// notify() wird auch aus Pfaden aufgerufen, die kein Argument durchgereicht bekommen —
// ein Schalter, der nur an manchen Stellen greift, wäre schlimmer als keiner.
const NOTIFY_DISABLED = process.argv.slice(2).includes('--no-notify');
// Obergrenze der Beobachtung nach einem Update (siehe waitForStableServices).
const HEALTH_WAIT_MS = 120_000;
// Takt der Messung und Dauer, die am Stück unauffällig sein muss.
const HEALTH_POLL_MS = 5_000;
const HEALTH_STABLE_MS = 20_000;

// ── Exit-Codes ───────────────────────────────────────────────────────────────
// Zweiter, von Nexus UNABHÄNGIGER Signalweg (ergänzt 2026-08-04): bin/forge-cron.js
// hält den letzten Exit-Code je Job in data/cron-state.json und loggt ihn. Vorher
// endete auch ein abgewehrter Angriff mit 0 — aus Cron-Sicht nicht von "nichts zu
// tun" unterscheidbar. Das ist genau dann fatal, wenn der Meldeweg über Nexus selbst
// versagt (real passiert: der Dedup-Bug hat einen Alarm verschluckt, siehe
// core/nexus/dedup.js). Zwei Wege, die unabhängig voneinander ausfallen können.
const EXIT = {
    ok:          0,  // nichts zu tun, Update verfügbar, oder erfolgreich eingespielt
    unexpected:  1,  // unerwarteter Fehler (siehe catch am Dateiende)
    rejected:    2,  // Update aus Sicherheitsgründen ABGELEHNT (Signatur/Hash/Downgrade)
    applyFailed: 3,  // Update eingespielt, aber fehlgeschlagen → Rollback bzw. Handarbeit
};

function log(msg) { console.log(`[update-check] ${msg}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

const BOT_DISPLAY_NAME = 'Auto-Update';

// ── Meldungs-Kategorien ──────────────────────────────────────────────────────
// 🔴 BEWUSST GETRENNT, nicht ein pauschales 'update' (Fix 2026-08-04): Der Nexus
// dedupliziert über botId+level+category (siehe core/nexus/dedup.js) — NICHT über
// den Meldungstext. Lägen alle Update-Alarme in einer Kategorie, würden zwei
// inhaltlich völlig verschiedene Angriffe (z.B. gefälschte Signatur und
// manipuliertes Tarball) innerhalb des Dedup-Fensters zu einer einzigen Meldung
// zusammenfallen — der Betreiber sähe nur den ersten. Jede Kategorie hier
// entspricht einer eigenständigen Fehlerursache und damit einem eigenen Fenster.
const CAT = {
    trust:     'update-trust',      // Vertrauensanker selbst fehlt/unbrauchbar
    signature: 'update-signature',  // Signaturprüfung: ungültig oder Recovery-Key
    integrity: 'update-integrity',  // Inhalt stimmt nicht (Hash, Symlinks)
    available: 'update-available',  // Update liegt bereit, wartet auf Bestätigung
    apply:     'update-apply',      // Einspielen selbst (Erfolg/Fehlschlag)
    rollback:  'update-rollback',   // Health-Gate + Rückrollen
    downgrade: 'update-downgrade',  // Kanal bietet eine ÄLTERE Version an als installiert
};

// ── Handlungsaufforderungen ──────────────────────────────────────────────────
// 🔒 Regel (Betreiber-Vorgabe 2026-07-30, siehe bots/liquidity/lib/notify.js):
// JEDE Meldung endet mit einem Satz, der sagt was der Nutzer tun soll — auch wenn
// die Antwort "nichts" ist. Der Adressat ist kein IT-Fachmann; eine Meldung, die
// nur einen Befund nennt, lässt ihn ratlos zurück und wird auf Dauer ignoriert.
// Seit i18n Schritt 7 sind das KATALOG-KEYS (lib/i18n/<lang>.json), keine Texte:
// gerendert wird beim Anzeigen (lib/notify-render.js, Konvention 3 „_action").
const ACTION = {
    /** Update wurde abgelehnt, laufende Installation ist unverändert und sicher. */
    discarded: 'notify.upd.act_discarded',
    /** Recovery-Key im Spiel: der Nutzer hat einen echten, zweiten Prüfweg. */
    verifyPublisher: 'notify.upd.act_verify_publisher',
    /** Update liegt bereit und wartet auf eine Entscheidung. */
    confirm: 'notify.upd.act_confirm',
    /** Abgeschlossenes Ereignis, rein informativ (gemeinsamer Key aus Schritt 5). */
    fyi: 'notify.act.fyi',
    /** Dienste laufen wieder auf der Vorversion. */
    afterRollback: 'notify.upd.act_after_rollback',
    /** Sofortiges Eingreifen nötig, Bots laufen nicht. */
    urgent: 'notify.upd.act_urgent',
    /** Installation ist unvollständig. */
    checkInstall: 'notify.upd.act_check_install',
    /** Kanal liefert Älteres — einmalig harmlos, wiederholt verdächtig. */
    watchChannel: 'notify.upd.act_watch_channel',
    /** Update-Quelle wiederholt nicht erreichbar — meist Netzwerk/Rate-Limit. */
    fetchRetry: 'notify.upd.act_fetch_retry',
};

/**
 * Sendet eine Meldung im FORGE-Meldungsschema. Seit i18n Schritt 7 gehen
 * msgKey + params mit (E4): der Nexus speichert beides, gerendert wird beim
 * Anzeigen — der mitgeschickte Text ist Telegram-Sofortversand und Fallback
 * für Altbestand (identisches Muster wie die notify.js beider Bots seit Schritt 5).
 * Die Handlungsaufforderung steckt als params._action im Katalog (Konvention 3).
 */
async function notify(level, category, msgKey, params, actionKey) {
    const fullParams = { ...params, _action: actionKey };
    const message = renderNotification(
        { msgKey, params: fullParams, displayName: BOT_DISPLAY_NAME, timestamp: Date.now() },
    );
    if (NOTIFY_DISABLED) {
        // Vollständig loggen statt nur "unterdrückt": Wer einen Testlauf auswertet,
        // will denselben Text sehen, den ein echter Lauf verschickt hätte.
        log(t('cli.upd.no_notify', { category, level, message }));
        return;
    }
    try {
        const res = await fetch(`${NEXUS_URL}/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ botId: 'update-check', displayName: BOT_DISPLAY_NAME, level, category, message, msgKey, params: fullParams }),
        });
        if (!res.ok) {
            log(t('cli.upd.notify_http', { status: res.status }));
            return;
        }
        // Nexus meldet Unterdrückung mit ok:true — wer nur res.ok prüft, hält einen
        // verschluckten Alarm für zugestellt. Bei einem Sicherheitsalarm ist genau das
        // der Unterschied zwischen "Betreiber weiß Bescheid" und "niemand weiß es"
        // (real passiert am 2026-08-04, siehe core/nexus/dedup.js). Mindestens ins
        // lokale Log, damit es bei einer Nachforschung auffindbar bleibt.
        const ack = await res.json().catch(() => ({}));
        if (ack.deduplicated) log(`⚠️  ${t('cli.upd.notify_dedup', { category, level })}`);
        if (ack.rateLimited)  log(`⚠️  ${t('cli.upd.notify_ratelimited', { category, level })}`);
    } catch (err) {
        log(t('cli.upd.notify_failed', { error: err.message }));
    }
}

function installedVersion() {
    const versionPath = path.join(APP_DIR, 'VERSION');
    if (!existsSync(versionPath)) return { code: null, version: null };
    const content = readFileSync(versionPath, 'utf8');
    const code = content.match(/^VersionCode:\s*(\d+)/m);
    const version = content.match(/^Version:\s*(\S+)/m);
    return { code: code ? parseInt(code[1], 10) : null, version: version ? version[1] : null };
}

function readUpdateConfig() {
    const cfg = JSON.parse(readFileSync(path.join(APP_DIR, 'config/pub-update-config.json'), 'utf8'));
    const channelOverridePath = path.join(LOCAL_DIR, 'update-channel.txt');
    const channel = existsSync(channelOverridePath) ? readFileSync(channelOverridePath, 'utf8').trim() : cfg.defaultChannel;
    return { repo: cfg.repo, channel };
}

function readPolicy() {
    const policyPath = path.join(LOCAL_DIR, 'update-policy.json');
    if (!existsSync(policyPath)) return { autoApplyPatch: false };
    try { return JSON.parse(readFileSync(policyPath, 'utf8')); } catch { return { autoApplyPatch: false }; }
}

// Siehe FORGE_PUB_UPDATE_TOKEN im Kopfkommentar — Env-Var hat Vorrang (für
// lokale/manuelle Testläufe), local/update-token.txt ist der Weg, der auch den
// per sudo -n env-zurückgesetzten Cron-/Daemon-Aufruf erreicht.
function readUpdateToken() {
    if (process.env.FORGE_PUB_UPDATE_TOKEN) return process.env.FORGE_PUB_UPDATE_TOKEN;
    const tokenPath = path.join(LOCAL_DIR, 'update-token.txt');
    if (!existsSync(tokenPath)) return undefined;
    const value = readFileSync(tokenPath, 'utf8').trim();
    return value || undefined;
}

// ── Release-Listen-Cache (Rate-Limit-Schutz) ─────────────────────────────────
// Der GET /releases-Aufruf in fetchRelease() ist der EINZIGE Schritt, der
// unauthentifiziert gegen das GitHub-Limit (60/h pro Quell-IP) zählt — Asset-
// Downloads laufen über browser_download_url auf einem anderen Host und sind
// davon unabhängig (siehe download() unten). Ein kurzer TTL-Cache hier senkt
// genau die Last, die ein "check" gefolgt von einem "apply" wenige Sekunden
// später erzeugt (der Normalfall im Web-UI: Nutzer klickt Prüfen, sieht ein
// Update, klickt Einspielen) sowie mehrfaches manuelles Klicken auf "Prüfen" —
// beides real am 2026-08-12 beobachtet, als ein erfolgreicher Check-Lauf und
// der Apply-Lauf zwölf Sekunden später denselben, gerade erst verbrauchten
// Request-Slot ein zweites Mal brauchten. Der tägliche Cron ist von der TTL
// nicht betroffen (Zeitabstand deutlich größer).
const RELEASE_LIST_CACHE_PATH = path.join(LOCAL_DIR, 'data', 'release-list-cache.json');
const RELEASE_LIST_CACHE_TTL_MS = 10 * 60 * 1000;

function readReleaseListCache(repo, channel) {
    try {
        if (!existsSync(RELEASE_LIST_CACHE_PATH)) return null;
        const cached = JSON.parse(readFileSync(RELEASE_LIST_CACHE_PATH, 'utf8'));
        if (cached.repo !== repo || cached.channel !== channel) return null;
        const age = Date.now() - cached.fetchedAt;
        if (age > RELEASE_LIST_CACHE_TTL_MS) return null;
        return { releases: cached.releases, ageSeconds: Math.round(age / 1000) };
    } catch { return null; }
}

function writeReleaseListCache(repo, channel, releases) {
    try {
        mkdirSync(path.dirname(RELEASE_LIST_CACHE_PATH), { recursive: true });
        writeFileSync(RELEASE_LIST_CACHE_PATH, JSON.stringify({ repo, channel, fetchedAt: Date.now(), releases }, null, 2) + '\n');
    } catch { /* Cache ist nur Optimierung, kein Blocker */ }
}

// ── Fehlschlag-Zähler für fetchRelease() (T4 Freeze/Eclipse) ────────────────
// Ein einzelner Fehlschlag ist erwartbar (Netzwerk-Ausrutscher, kurzzeitig
// ausgeschöpftes GitHub-Limit) und bleibt bewusst stumm — sonst würde jede
// kleine Netzwerkstörung eine Meldung auslösen. Erst ab
// FETCH_FAILURE_NOTIFY_THRESHOLD aufeinanderfolgenden Fehlschlägen (z.B. drei
// Cron-Tage in Folge ohne jeden Kontakt zur Update-Quelle) meldet sich das
// System einmalig — vorher war dieser Pfad komplett unsichtbar (siehe
// Kopfkommentar "T4 (Freeze/Eclipse) ... noch offen").
const FETCH_FAILURE_PATH = path.join(LOCAL_DIR, 'data', 'update-fetch-failures.json');
const FETCH_FAILURE_NOTIFY_THRESHOLD = 3;

function recordFetchFailure() {
    let count = 0;
    try {
        if (existsSync(FETCH_FAILURE_PATH)) count = JSON.parse(readFileSync(FETCH_FAILURE_PATH, 'utf8')).count || 0;
    } catch { /* Zähler beginnt neu, kein Blocker */ }
    count += 1;
    try {
        mkdirSync(path.dirname(FETCH_FAILURE_PATH), { recursive: true });
        writeFileSync(FETCH_FAILURE_PATH, JSON.stringify({ count, lastFailedAt: Date.now() }, null, 2) + '\n');
    } catch { /* Zähler ist nur Grundlage für die Alarmschwelle, kein Blocker */ }
    return count;
}

function clearFetchFailures() {
    try { rmSync(FETCH_FAILURE_PATH, { force: true }); } catch { /* nichts zu tun */ }
}

// Merkt sich instanzweit "es liegt ein geprüftes, noch nicht eingespieltes Update
// bereit" — Grundlage für das sanfte Pulsieren der Versionsnummer im Nav-Panel
// (bots/settings/routes/update.js liest dieselbe Datei). Bewusst unter local/data/,
// nicht unter app/: ein Update-Apply ersetzt app/ komplett, lokaler Zustand
// überlebt das nur unter local/ (siehe config/paths.js-Kopfkommentar).
const UPDATE_STATUS_PATH = path.join(LOCAL_DIR, 'data', 'update-status.json');

function writeUpdateStatus(data) {
    try {
        mkdirSync(path.dirname(UPDATE_STATUS_PATH), { recursive: true });
        writeFileSync(UPDATE_STATUS_PATH, JSON.stringify(data, null, 2) + '\n');
    } catch (err) {
        log(t('cli.upd.status_write_failed', { file: 'update-status.json', error: err.message }));
    }
}

function clearUpdateStatus() {
    try { rmSync(UPDATE_STATUS_PATH, { force: true }); } catch { /* nichts zu tun */ }
}

// Dauerhafte Aufzeichnung des letzten Apply-Ausgangs — anders als
// UPDATE_STATUS_PATH (nur "liegt bereit, noch nicht angewendet") wird diese
// Datei bei JEDEM Terminal-Zustand eines Apply-Versuchs geschrieben, auch bei
// Erfolg, und NICHT gelöscht. Grundlage für den manuellen Rollback-Button im
// Webinterface (bots/settings/routes/update.js): der darf NUR erscheinen,
// wenn status === 'rollback-failed' — bei 'stopped-migration' wäre ein
// Rollback gefährlicher als der aktuelle Zustand (siehe hasMigrations-Zweig
// unten), deshalb dort bewusst NICHT anbieten.
const LAST_RESULT_PATH = path.join(LOCAL_DIR, 'data', 'last-update-result.json');

function writeLastUpdateResult(data) {
    try {
        mkdirSync(path.dirname(LAST_RESULT_PATH), { recursive: true });
        writeFileSync(LAST_RESULT_PATH, JSON.stringify({ timestamp: Date.now(), ...data }, null, 2) + '\n');
    } catch (err) {
        log(t('cli.upd.status_write_failed', { file: 'last-update-result.json', error: err.message }));
    }
}

function isActive(service) {
    const r = spawnSync('systemctl', ['is-active', service], { encoding: 'utf8' });
    return r.stdout.trim() === 'active';
}

function restartCount(service) {
    const r = spawnSync('systemctl', ['show', service, '-p', 'NRestarts', '--value'], { encoding: 'utf8' });
    return parseInt(r.stdout.trim(), 10) || 0;
}

/**
 * Wartet, bis die Dienste nach dem Update nachweislich stabil laufen.
 *
 * Zwei Verschlechterungsarten zählen als Fehlschlag:
 *   1. ein vorher laufender Dienst läuft nicht mehr
 *   2. NRestarts gestiegen → Crash-Loop (fängt auch Dienste, die vorher standen
 *      und jetzt von do_update gestartet wurden, aber sofort wegsterben —
 *      'is-active' zeigt die zwischen zwei Restarts kurzzeitig als gesund)
 *
 * 🔴 Vorher: ein starres `sleep(120s)`. Das war der mit Abstand längste Teil des
 * gesamten Updates (120 s von 204 s) — und dabei nicht einmal gründlicher als
 * eine Messung, nur geduldiger. Jetzt wird alle HEALTH_POLL_MS geprüft und
 * abgebrochen, sobald HEALTH_STABLE_MS am Stück nichts auffällig war
 * (Normalfall: ~25 s). Zum Vergleich: der manuelle Terminal-Weg über
 * setup.sh gewährt sich an dieser Stelle 8 s.
 *
 * Bei Auffälligkeiten wird NICHT früh abgebrochen: der Zähler beginnt von vorn
 * und es wird bis HEALTH_WAIT_MS weiter beobachtet — ein Dienst, der sich noch
 * fängt, soll nicht vorschnell einen automatischen Rollback auslösen.
 */
async function waitForStableServices(preActive, preRestarts) {
    const deadline = Date.now() + HEALTH_WAIT_MS;
    let stableSince = null;
    let lastRegressed = [];
    while (Date.now() < deadline) {
        await sleep(HEALTH_POLL_MS);
        lastRegressed = SERVICES.filter((s, i) =>
            (preActive[i] && !isActive(s)) || restartCount(s) > preRestarts[i]);
        if (lastRegressed.length > 0) {
            if (stableSince !== null) log(`   ${t('cli.upd.not_yet_stable', { services: lastRegressed.join(', ') })}`);
            stableSince = null;
            continue;
        }
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= HEALTH_STABLE_MS) return [];
    }
    return lastRegressed;
}

/**
 * Liefert das aktuell relevante Release als {manifestBuf, sigBuf, fetchTarball}.
 * --source <dir>: liest manifest.json + manifest.json.sig + Tarball aus einem
 * lokalen Verzeichnis — für Entwicklung/Staging-Tests OHNE echtes GitHub-Repo.
 * Ohne --source: echter GitHub-Releases-Pfad (siehe Kopfkommentar zum Testrisiko).
 */
async function fetchRelease({ repo, channel, sourceDir }) {
    if (sourceDir) {
        const manifestBuf = readFileSync(path.join(sourceDir, 'manifest.json'));
        const sigBuf = readFileSync(path.join(sourceDir, 'manifest.json.sig'));
        // Kein echtes GitHub-Release im Testmodus — kein Changelog-Link verfügbar.
        return { manifestBuf, sigBuf, releaseUrl: null, fetchTarball: async (name) => readFileSync(path.join(sourceDir, name)) };
    }
    // Siehe FORGE_PUB_UPDATE_TOKEN/readUpdateToken() im Kopfkommentar — bei
    // echten Kunden immer undefined.
    const token = readUpdateToken();
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

    let releases;
    const cached = readReleaseListCache(repo, channel);
    if (cached) {
        log(t('cli.upd.release_list_cached', { age: cached.ageSeconds }));
        releases = cached.releases;
    } else {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'forge-pub-update-check', ...authHeaders },
        });
        if (!res.ok) throw new Error(`GitHub-Releases-API: HTTP ${res.status}`);
        releases = await res.json();
        writeReleaseListCache(repo, channel, releases);
    }
    const wantPrerelease = channel === 'staging';
    const candidate = releases.find((r) => Boolean(r.prerelease) === wantPrerelease);
    if (!candidate) throw new Error(`Kein Release für Channel '${channel}' gefunden.`);
    const findAsset = (name) => {
        const a = candidate.assets.find((x) => x.name === name);
        if (!a) throw new Error(`Asset '${name}' fehlt in Release ${candidate.tag_name}.`);
        return a;
    };
    const download = async (asset) => {
        // 'browser_download_url' ist nur für ÖFFENTLICHE Repos ein direkter Link
        // (funktioniert bei echten Kunden, kein API-Rate-Limit). Bei einem
        // PRIVATEN Repo (nur mit FORGE_PUB_UPDATE_TOKEN im Testbetrieb) liefert
        // dieselbe URL ohne Browser-Session nur 404 — dafür muss die API-URL
        // 'asset.url' mit 'Accept: application/octet-stream' verwendet werden
        // (sonst kämen JSON-Metadaten statt der Rohdatei zurück).
        const url = token ? asset.url : asset.browser_download_url;
        const r = await fetch(url, {
            headers: token ? { Accept: 'application/octet-stream', ...authHeaders } : {},
        });
        if (!r.ok) throw new Error(`Download ${asset.name}: HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
    };
    const manifestBuf = await download(findAsset('manifest.json'));
    const sigBuf = await download(findAsset('manifest.json.sig'));
    // GitHub liefert html_url direkt in der Release-Antwort — kein zusätzlicher
    // Aufbau nötig. Bei einem privaten Repo funktioniert der Link nur für
    // eingeloggte Mitglieder des Repos (Testbetrieb), sonst öffentlich erreichbar.
    return { manifestBuf, sigBuf, releaseUrl: candidate.html_url ?? null, fetchTarball: async (name) => download(findAsset(name)) };
}

async function main() {
    const argv = process.argv.slice(2);
    const sourceIdx = argv.indexOf('--source');
    const sourceDir = sourceIdx >= 0 ? path.resolve(argv[sourceIdx + 1]) : null;
    const dryRun = argv.includes('--dry-run');
    // --confirm: manueller Aufruf durch einen Menschen (z.B. "Update" im setup.sh-Menü),
    // der die Auto-Apply-Politik (autoApplyPatch/isPatchLevel) übergeht. Diese Politik
    // existiert NUR, um den unbeaufsichtigten Cron-Lauf auf Patch-Level zu beschränken —
    // ein Mensch, der gerade explizit "Update" ausgewählt hat, hat die dafür geforderte
    // Entscheidung bereits getroffen. Signatur-, Hash- und Downgrade-Prüfung bleiben
    // davon unberührt, die gelten immer.
    const forceApply = argv.includes('--confirm');

    const { repo, channel } = readUpdateConfig();
    log(t('cli.upd.checking', { info: `channel=${channel}${sourceDir ? `, ${t('cli.upd.source_test', { dir: sourceDir })}` : `, repo=${repo}`}` }));

    let release;
    try {
        release = await fetchRelease({ repo, channel, sourceDir });
    } catch (err) {
        // T4 (Freeze/Eclipse): kein Abbruch mit Fehlercode, nur kein Fortschritt
        // beim einzelnen Fehlschlag. Ab FETCH_FAILURE_NOTIFY_THRESHOLD
        // aufeinanderfolgenden Fehlschlägen meldet sich das System einmalig
        // (siehe recordFetchFailure() oben) — vorher schweigt es bewusst.
        log(t('cli.upd.no_release', { error: err.message }));
        const failCount = recordFetchFailure();
        if (failCount === FETCH_FAILURE_NOTIFY_THRESHOLD) {
            await notify('warn', CAT.available, 'notify.upd.fetch_failed_repeated',
                { attempts: failCount, error: err.message }, ACTION.fetchRetry);
        }
        return;
    }
    clearFetchFailures();

    if (!existsSync(TRUST_ANCHOR_PATH)) {
        log(`🔴 ${t('cli.upd.no_trust_anchor', { path: TRUST_ANCHOR_PATH })}`);
        process.exitCode = EXIT.rejected;
        await notify('error', CAT.trust, 'notify.upd.trust_missing', {}, ACTION.checkInstall);
        return;
    }
    const trustAnchor = JSON.parse(readFileSync(TRUST_ANCHOR_PATH, 'utf8'));
    const sigResult = verifyAgainstTrustAnchor(release.manifestBuf, release.sigBuf, trustAnchor);
    if (!sigResult.valid) {
        log(`🔴 ${t('cli.upd.sig_invalid')}`);
        process.exitCode = EXIT.rejected;
        await notify('error', CAT.signature, 'notify.upd.sig_invalid', {}, ACTION.discarded);
        return;
    }
    log(`✓ ${t('cli.upd.sig_valid', { key: sigResult.matchedKey })}`);
    if (sigResult.matchedKey === 'recovery') {
        // Der Recovery-Key kommt laut Bedrohungsmodell (update.md, T6) nur zum Einsatz,
        // wenn der Primärschlüssel des Herausgebers kompromittiert wurde. Für den Nutzer
        // ist das die einzige Vorwarnung, die er in diesem Fall je bekommt — deshalb warn
        // und nicht info, und deshalb mit einem konkreten, unabhängigen Gegenprüfweg
        // (Nostr-Identität, siehe update.md "Bootstrapping (TOFU)").
        await notify('warn', CAT.signature, 'notify.upd.recovery_key', {}, ACTION.verifyPublisher);
    }

    const manifest = JSON.parse(release.manifestBuf.toString('utf8'));
    const installed = installedVersion();

    if (installed.code !== null && manifest.versionCode <= installed.code) {
        log(t('cli.upd.no_new_update', { installed: installed.code, release: manifest.versionCode }));
        // Wir sind auf dem neuesten (oder einem neueren) Stand — ein evtl. zuvor
        // gemeldetes, noch nicht eingespieltes Update gilt nicht mehr als offen.
        clearUpdateStatus();
        // GLEICHE Version = täglicher Normalfall, dafür gibt es bewusst keine Meldung
        // (sonst Dauerspam). ÄLTERE Version ist etwas völlig anderes: der Kanal liefert
        // dann einen Stand, der HINTER dem installierten liegt — entweder hat der
        // Herausgeber ein Release zurückgezogen, oder jemand hält gezielt Updates zurück
        // bzw. spielt einen alten, verwundbaren Stand ein (Rollback-/Eclipse-Angriff,
        // update.md T3/T4). Das Downgrade-Gate greift zwar, war bis 2026-08-04 aber
        // vollkommen unsichtbar — abgewehrt und niemandem gesagt.
        if (manifest.versionCode < installed.code) {
            process.exitCode = EXIT.rejected;
            await notify('warn', CAT.downgrade, 'notify.upd.downgrade',
                { offered: manifest.version, installed: installed.version ?? `v${installed.code}` },
                ACTION.watchChannel);
        }
        return;
    }
    log(t('cli.upd.new_release', { code: manifest.versionCode, version: manifest.version, schema: manifest.minDataSchema, migrations: manifest.hasMigrations }));

    const tarballBuf = await release.fetchTarball(manifest.artifact.name);
    const actualSha256 = sha256(tarballBuf);
    if (actualSha256 !== manifest.artifact.sha256) {
        log(`🔴 ${t('cli.upd.hash_mismatch', { expected: manifest.artifact.sha256, actual: actualSha256 })}`);
        process.exitCode = EXIT.rejected;
        await notify('error', CAT.integrity, 'notify.upd.integrity', { version: manifest.version }, ACTION.discarded);
        return;
    }
    log(`✓ ${t('cli.upd.hash_ok')}`);

    mkdirSync(STAGING_DIR, { recursive: true });
    const stageTarget = path.join(STAGING_DIR, manifest.version);
    if (existsSync(stageTarget)) rmSync(stageTarget, { recursive: true, force: true });
    mkdirSync(stageTarget, { recursive: true });
    const tarPath = path.join(STAGING_DIR, manifest.artifact.name);
    writeFileSync(tarPath, tarballBuf);
    // Kein --strip-components mehr nötig (Fund 2026-08-06): das Artefakt-Tarball
    // archiviert seit tools/pub-export/build-artifact.js den INHALT von 'current/',
    // nicht mehr den Ordner selbst — es gibt keine Wrapper-Ebene mehr wegzuwerfen.
    execFileSync('tar', ['xzf', tarPath, '-C', stageTarget]);
    rmSync(tarPath);
    // Zusätzlicher Sanity-Check gegen Tar-Traversal/Symlink-Tricks (GNU tar
    // verweigert Entpacken außerhalb des Zielverzeichnisses standardmäßig bereits
    // selbst — das hier ist eine zweite, unabhängige Prüfung, kein Ersatz dafür).
    const symlinks = execFileSync('find', [stageTarget, '-type', 'l'], { encoding: 'utf8' }).trim();
    if (symlinks) {
        log(`🔴 ${t('cli.upd.symlinks_found', { symlinks })}`);
        process.exitCode = EXIT.rejected;
        await notify('error', CAT.integrity, 'notify.upd.symlinks', { version: manifest.version }, ACTION.discarded);
        rmSync(stageTarget, { recursive: true, force: true });
        return;
    }
    log(`✓ ${t('cli.upd.unpacked', { dir: stageTarget })}`);

    // Ab hier hat das Entpacken seinen Zweck erfüllt (Prüfung/Anzeige) und stageTarget
    // muss vor JEDEM verbleibenden Rückkehrpunkt aufgeräumt werden – nicht nur im
    // Erfolgspfad ganz unten (siehe dortiger Kommentar). Ohne das häuften sich pro
    // Fork-Installation mehrere hundert MB an: der TÄGLICHE Normalfall ist genau der
    // "Update verfügbar, aber kein Auto-Apply"-Zweig direkt darunter (jeder Cron-Lauf,
    // der eine neuere, nicht-Patch-Version findet, kehrte bislang zurück, ohne den
    // gerade entpackten Release je zu löschen). Fund 2026-08-20: 23 bzw. 13 liegen-
    // gebliebene Staging-Verzeichnisse auf forge-pub1/forge-pub2, 524 MB / 283 MB.
    const cleanupStaging = () => { try { rmSync(stageTarget, { recursive: true, force: true }); } catch { /* kein Blocker */ } };

    if (dryRun) { log(t('cli.upd.dry_run_end')); cleanupStaging(); return; }

    const policy = readPolicy();
    const isPatchLevel = installed.version
        && installed.version.split('.').slice(0, 2).join('.') === manifest.version.split('.').slice(0, 2).join('.');
    if (!forceApply && (!policy.autoApplyPatch || !isPatchLevel)) {
        log(t('cli.upd.available_no_autoapply', { version: manifest.version }));
        // Grundlage für das sanfte Pulsieren der Versionsnummer im Nav-Panel —
        // siehe writeUpdateStatus()/UPDATE_STATUS_PATH oben.
        writeUpdateStatus({
            latestVersion: manifest.version,
            latestVersionCode: manifest.versionCode,
            releaseUrl: release.releaseUrl,
            notifiedAt: Date.now(),
        });
        await notify('info', CAT.available, 'notify.upd.available',
            {
                version:   manifest.version,
                installed: installed.version ?? t('cli.upd.unknown_word'),
                // Ohne Release-URL fällt die Changelog-Zeile weg (Konvention 1).
                ...(release.releaseUrl ? { changelog: release.releaseUrl } : {}),
            },
            ACTION.confirm);
        cleanupStaging();
        return;
    }

    log(t('cli.upd.applying'));
    // Zustand VOR dem Update festhalten. Das Health-Gate vergleicht danach gegen
    // GENAU DIESEN Zustand statt zu verlangen, dass alle sechs Dienste laufen
    // (Fix 2026-08-04): Läuft ein Dienst aus legitimem Grund nicht — etwa ein Bot,
    // für den der Nutzer nie ein Wallet hinterlegt hat — wäre "alle sechs aktiv"
    // nie erfüllbar, JEDES Update würde zurückgerollt und die Installation bliebe
    // dauerhaft auf ihrer alten Version stehen. Geprüft wird deshalb auf
    // Verschlechterung: was vorher lief, muss nachher laufen.
    const preActive = SERVICES.map(isActive);
    const preRestarts = SERVICES.map(restartCount);
    const applyResult = spawnSync('bash', [path.join(stageTarget, 'bin/setup.sh'), 'update', '--non-interactive', '--yes'], {
        cwd: stageTarget, stdio: 'inherit',
    });
    if (applyResult.status !== 0) {
        log(`🔴 ${t('cli.upd.setup_failed')}`);
        process.exitCode = EXIT.applyFailed;
        await notify('error', CAT.apply, 'notify.upd.apply_failed', { version: manifest.version, code: applyResult.status }, ACTION.urgent);
        cleanupStaging();
        return;
    }

    // Staging hat seinen Zweck erfüllt, sobald setup.sh update daraus deployt hat
    // (do_deploy kopiert nach /opt/forge/app) — unabhängig vom Health-Gate-Ausgang
    // danach. Ohne dieses Aufräumen sammeln sich pro Update ~200MB unter staging/
    // an (live gefunden: forge-pub1 nach dem ersten echten Apply-Test, 2026-08-03).
    cleanupStaging();

    log(t('cli.upd.health_checking'));
    const regressed = await waitForStableServices(preActive, preRestarts);
    if (regressed.length === 0) {
        log(`✓ ${t('cli.upd.all_stable')}`);
        clearUpdateStatus();
        writeLastUpdateResult({ status: 'ok', version: manifest.version, versionCode: manifest.versionCode, hasMigrations: manifest.hasMigrations, problems: [] });
        await notify('info', CAT.apply, 'notify.upd.apply_ok', { version: manifest.version }, ACTION.fyi);
        return;
    }

    log(`🔴 ${t('cli.upd.services_unstable', { services: regressed.join(', ') })}`);
    process.exitCode = EXIT.applyFailed;
    if (manifest.hasMigrations) {
        log(`   ${t('cli.upd.migration_no_rollback')}`);
        for (const s of SERVICES) spawnSync('systemctl', ['stop', s]);
        writeLastUpdateResult({ status: 'stopped-migration', version: manifest.version, versionCode: manifest.versionCode, hasMigrations: true, problems: regressed });
        await notify('error', CAT.rollback, 'notify.upd.stopped_migration', { version: manifest.version, services: regressed.join(', ') }, ACTION.urgent);
        return;
    }
    log(`   ${t('cli.upd.restoring_previous', { code: installed.code })}`);
    const rollback = spawnSync('bash', [SETUP_SH, 'rollback-code', '--to-version', String(installed.code), '--non-interactive', '--yes'], { stdio: 'inherit' });
    if (rollback.status === 0) {
        writeLastUpdateResult({ status: 'auto-rolled-back', version: manifest.version, versionCode: manifest.versionCode, hasMigrations: false, problems: regressed });
        await notify('warn', CAT.rollback, 'notify.upd.rolled_back',
            { version: manifest.version, services: regressed.join(', '), previous: installed.version ?? `v${installed.code}` },
            ACTION.afterRollback);
    } else {
        writeLastUpdateResult({ status: 'rollback-failed', version: manifest.version, versionCode: manifest.versionCode, hasMigrations: false, problems: regressed });
        await notify('error', CAT.rollback, 'notify.upd.rollback_failed', { version: manifest.version, services: regressed.join(', ') }, ACTION.urgent);
    }
}

main().catch((err) => {
    console.error(`[update-check] 🔴 ${t('cli.upd.unexpected', { error: err.stack })}`);
    process.exitCode = EXIT.unexpected;
});
