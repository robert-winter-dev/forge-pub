#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// FORGE.pub – Auto-Update-Orchestrator
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
//
// FORGE_PUB_BASE_DIR (Env-Override): Basisverzeichnis statt /opt/forge — nur für
// lokale Tests außerhalb einer echten Installation, niemals in Produktion setzen.
// ══════════════════════════════════════════════════════════════════════════════

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAgainstTrustAnchor } from '../lib/update-verify.js';
import { FORGE_TZ } from '../core/config.js';

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
const HEALTH_WAIT_MS = 120_000;

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
const ACTION = {
    /** Update wurde abgelehnt, laufende Installation ist unverändert und sicher. */
    discarded: 'Es ist nichts zu tun – das Update wurde verworfen, die laufende Version bleibt unverändert. '
        + 'Kommt diese Meldung wiederholt, spiele keine Updates von Hand ein und wende dich an den Herausgeber.',
    /** Recovery-Key im Spiel: der Nutzer hat einen echten, zweiten Prüfweg. */
    verifyPublisher: 'Prüfe über die Nostr-Identität des Herausgebers, ob dieser Schlüsselwechsel echt ist. '
        + 'Solange das nicht bestätigt ist, spiele keine weiteren Updates ein.',
    /** Update liegt bereit und wartet auf eine Entscheidung. */
    confirm: 'Bitte das Update im Backend bestätigen, damit es eingespielt wird.',
    /** Abgeschlossenes Ereignis, rein informativ. */
    fyi: 'Es ist nichts zu tun, diese Meldung dient nur zur Information.',
    /** Dienste laufen wieder auf der Vorversion. */
    afterRollback: 'Es ist nichts zu tun – die vorherige Version läuft wieder. '
        + 'Bitte im Backend kontrollieren, ob alle Bots wieder aktiv sind.',
    /** Sofortiges Eingreifen nötig, Bots laufen nicht. */
    urgent: 'Die Bots laufen derzeit NICHT und dein Kapital wird nicht überwacht. '
        + 'Bitte umgehend im Backend prüfen und die Dienste von Hand wiederherstellen.',
    /** Installation ist unvollständig. */
    checkInstall: 'Ohne Vertrauensanker kann kein Update geprüft werden. '
        + 'Bitte die Installation mit "sudo bin/setup.sh status" prüfen.',
    /** Kanal liefert Älteres — einmalig harmlos, wiederholt verdächtig. */
    watchChannel: 'Es ist nichts zu tun – die ältere Version wurde nicht installiert. '
        + 'Kommt diese Meldung wiederholt, prüfe über die Nostr-Identität des Herausgebers, '
        + 'ob dort wirklich eine Version zurückgezogen wurde.',
};

function fmtTimestamp() {
    return new Intl.DateTimeFormat('de-DE', {
        timeZone: FORGE_TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date());
}

/**
 * Sendet eine Meldung im FORGE-Meldungsschema: Kopfzeile mit Datum + Bot,
 * dann Art der Meldung, dann Details, dann IMMER eine Handlungsaufforderung.
 */
async function notify(level, category, title, body, action) {
    const message = `📅 ${fmtTimestamp()} · ${BOT_DISPLAY_NAME}\n*${title}*\n${body}\n${action}`;
    try {
        const res = await fetch(`${NEXUS_URL}/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ botId: 'update-check', displayName: BOT_DISPLAY_NAME, level, category, message }),
        });
        if (!res.ok) {
            log(`Notify: Nexus antwortete HTTP ${res.status}`);
            return;
        }
        // Nexus meldet Unterdrückung mit ok:true — wer nur res.ok prüft, hält einen
        // verschluckten Alarm für zugestellt. Bei einem Sicherheitsalarm ist genau das
        // der Unterschied zwischen "Betreiber weiß Bescheid" und "niemand weiß es"
        // (real passiert am 2026-08-04, siehe core/nexus/dedup.js). Mindestens ins
        // lokale Log, damit es bei einer Nachforschung auffindbar bleibt.
        const ack = await res.json().catch(() => ({}));
        if (ack.deduplicated) log(`⚠️  Alarm wurde von Nexus als Dublette unterdrückt (${category}/${level}) — nicht in der Meldungsliste!`);
        if (ack.rateLimited)  log(`⚠️  Alarm wurde von Nexus rate-limitiert (${category}/${level}) — nicht in der Meldungsliste!`);
    } catch (err) {
        log(`Notify fehlgeschlagen (Nexus nicht erreichbar?): ${err.message}`);
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

function isActive(service) {
    const r = spawnSync('systemctl', ['is-active', service], { encoding: 'utf8' });
    return r.stdout.trim() === 'active';
}

function restartCount(service) {
    const r = spawnSync('systemctl', ['show', service, '-p', 'NRestarts', '--value'], { encoding: 'utf8' });
    return parseInt(r.stdout.trim(), 10) || 0;
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
        return { manifestBuf, sigBuf, fetchTarball: async (name) => readFileSync(path.join(sourceDir, name)) };
    }
    const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'forge-pub-update-check' },
    });
    if (!res.ok) throw new Error(`GitHub-Releases-API: HTTP ${res.status}`);
    const releases = await res.json();
    const wantPrerelease = channel === 'staging';
    const candidate = releases.find((r) => Boolean(r.prerelease) === wantPrerelease);
    if (!candidate) throw new Error(`Kein Release für Channel '${channel}' gefunden.`);
    const findAsset = (name) => {
        const a = candidate.assets.find((x) => x.name === name);
        if (!a) throw new Error(`Asset '${name}' fehlt in Release ${candidate.tag_name}.`);
        return a;
    };
    const download = async (asset) => {
        const r = await fetch(asset.browser_download_url);
        if (!r.ok) throw new Error(`Download ${asset.name}: HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
    };
    const manifestBuf = await download(findAsset('manifest.json'));
    const sigBuf = await download(findAsset('manifest.json.sig'));
    return { manifestBuf, sigBuf, fetchTarball: async (name) => download(findAsset(name)) };
}

async function main() {
    const argv = process.argv.slice(2);
    const sourceIdx = argv.indexOf('--source');
    const sourceDir = sourceIdx >= 0 ? path.resolve(argv[sourceIdx + 1]) : null;
    const dryRun = argv.includes('--dry-run');

    const { repo, channel } = readUpdateConfig();
    log(`Prüfe auf neues Release (channel=${channel}${sourceDir ? `, Quelle=${sourceDir} [TEST-MODUS]` : `, repo=${repo}`})`);

    let release;
    try {
        release = await fetchRelease({ repo, channel, sourceDir });
    } catch (err) {
        // T4 (Freeze/Eclipse): kein Abbruch mit Fehlercode, nur kein Fortschritt.
        // Eine echte Freeze-Erkennung (Alarm nach zu langer Stille) ist noch offen.
        log(`Kein Update abgerufen: ${err.message}`);
        return;
    }

    if (!existsSync(TRUST_ANCHOR_PATH)) {
        log(`🔴 Kein Trust-Anchor unter ${TRUST_ANCHOR_PATH}.`);
        process.exitCode = EXIT.rejected;
        await notify('error', CAT.trust, 'Update-Prüfung nicht möglich – Vertrauensanker fehlt',
            'Die Datei mit den Prüfschlüsseln des Herausgebers fehlt in dieser Installation. '
            + 'Es kann deshalb nicht festgestellt werden, ob ein angebotenes Update echt ist. '
            + 'Es wurde nichts eingespielt.',
            ACTION.checkInstall);
        return;
    }
    const trustAnchor = JSON.parse(readFileSync(TRUST_ANCHOR_PATH, 'utf8'));
    const sigResult = verifyAgainstTrustAnchor(release.manifestBuf, release.sigBuf, trustAnchor);
    if (!sigResult.valid) {
        log('🔴 Signatur ungültig — Update wird VERWORFEN.');
        process.exitCode = EXIT.rejected;
        await notify('error', CAT.signature, 'Update abgelehnt – Signatur ungültig',
            'Ein angebotenes Update trug keine gültige Unterschrift des Herausgebers. '
            + 'Das bedeutet: es stammt nicht von ihm oder wurde auf dem Weg verändert. '
            + 'Es wurde nichts installiert.',
            ACTION.discarded);
        return;
    }
    log(`✓ Signatur gültig (${sigResult.matchedKey}-Key).`);
    if (sigResult.matchedKey === 'recovery') {
        // Der Recovery-Key kommt laut Bedrohungsmodell (update.md, T6) nur zum Einsatz,
        // wenn der Primärschlüssel des Herausgebers kompromittiert wurde. Für den Nutzer
        // ist das die einzige Vorwarnung, die er in diesem Fall je bekommt — deshalb warn
        // und nicht info, und deshalb mit einem konkreten, unabhängigen Gegenprüfweg
        // (Nostr-Identität, siehe update.md "Bootstrapping (TOFU)").
        await notify('warn', CAT.signature, 'Herausgeber hat den Signaturschlüssel gewechselt',
            'Dieses Update wurde nicht mit dem üblichen Schlüssel des Herausgebers unterschrieben, '
            + 'sondern mit seinem Ersatzschlüssel. Das ist vorgesehen, wenn sein Hauptschlüssel '
            + 'gestohlen wurde — kann aber auch bedeuten, dass jemand anderes den Ersatzschlüssel hat.',
            ACTION.verifyPublisher);
    }

    const manifest = JSON.parse(release.manifestBuf.toString('utf8'));
    const installed = installedVersion();

    if (installed.code !== null && manifest.versionCode <= installed.code) {
        log(`Kein neues Update (installiert: v${installed.code}, Release: v${manifest.versionCode}).`);
        // GLEICHE Version = täglicher Normalfall, dafür gibt es bewusst keine Meldung
        // (sonst Dauerspam). ÄLTERE Version ist etwas völlig anderes: der Kanal liefert
        // dann einen Stand, der HINTER dem installierten liegt — entweder hat der
        // Herausgeber ein Release zurückgezogen, oder jemand hält gezielt Updates zurück
        // bzw. spielt einen alten, verwundbaren Stand ein (Rollback-/Eclipse-Angriff,
        // update.md T3/T4). Das Downgrade-Gate greift zwar, war bis 2026-08-04 aber
        // vollkommen unsichtbar — abgewehrt und niemandem gesagt.
        if (manifest.versionCode < installed.code) {
            process.exitCode = EXIT.rejected;
            await notify('warn', CAT.downgrade, 'Update-Quelle bietet eine ältere Version an',
                `Die Update-Quelle bietet Version ${manifest.version} an, installiert ist aber bereits `
                + `${installed.version ?? `v${installed.code}`}. Ältere Versionen werden grundsätzlich nicht `
                + 'installiert – sie könnten bereits behobene Sicherheitslücken zurückbringen.',
                ACTION.watchChannel);
        }
        return;
    }
    log(`Neues Release: v${manifest.versionCode} (${manifest.version}), minDataSchema=${manifest.minDataSchema}, hasMigrations=${manifest.hasMigrations}.`);

    const tarballBuf = await release.fetchTarball(manifest.artifact.name);
    const actualSha256 = sha256(tarballBuf);
    if (actualSha256 !== manifest.artifact.sha256) {
        log(`🔴 Tarball-Hash stimmt nicht (erwartet ${manifest.artifact.sha256}, erhalten ${actualSha256}) — VERWORFEN.`);
        process.exitCode = EXIT.rejected;
        await notify('error', CAT.integrity, `Update abgelehnt – Inhalt verändert (v${manifest.version})`,
            'Die Unterschrift des Herausgebers war zwar gültig, das heruntergeladene Programmpaket '
            + 'passt aber nicht zu dem, was er unterschrieben hat. Es wurde also nach der Unterschrift '
            + 'verändert. Es wurde nichts installiert.',
            ACTION.discarded);
        return;
    }
    log('✓ Tarball-Hash stimmt.');

    mkdirSync(STAGING_DIR, { recursive: true });
    const stageTarget = path.join(STAGING_DIR, manifest.version);
    if (existsSync(stageTarget)) rmSync(stageTarget, { recursive: true, force: true });
    mkdirSync(stageTarget, { recursive: true });
    const tarPath = path.join(STAGING_DIR, manifest.artifact.name);
    writeFileSync(tarPath, tarballBuf);
    execFileSync('tar', ['xzf', tarPath, '-C', stageTarget, '--strip-components=1']);
    rmSync(tarPath);
    // Zusätzlicher Sanity-Check gegen Tar-Traversal/Symlink-Tricks (GNU tar
    // verweigert Entpacken außerhalb des Zielverzeichnisses standardmäßig bereits
    // selbst — das hier ist eine zweite, unabhängige Prüfung, kein Ersatz dafür).
    const symlinks = execFileSync('find', [stageTarget, '-type', 'l'], { encoding: 'utf8' }).trim();
    if (symlinks) {
        log(`🔴 Unerwartete Symlinks im entpackten Artefakt — VERWORFEN:\n${symlinks}`);
        process.exitCode = EXIT.rejected;
        await notify('error', CAT.integrity, `Update abgelehnt – verdächtige Verweise im Paket (v${manifest.version})`,
            'Das Programmpaket enthält Dateiverweise, die aus dem vorgesehenen Verzeichnis herausführen können. '
            + 'So etwas gehört nicht in ein reguläres Update. Es wurde nichts installiert.',
            ACTION.discarded);
        rmSync(stageTarget, { recursive: true, force: true });
        return;
    }
    log(`✓ Entpackt nach ${stageTarget}`);

    if (dryRun) { log('--dry-run: Ende vor Anwendung.'); return; }

    const policy = readPolicy();
    const isPatchLevel = installed.version
        && installed.version.split('.').slice(0, 2).join('.') === manifest.version.split('.').slice(0, 2).join('.');
    if (!policy.autoApplyPatch || !isPatchLevel) {
        log(`Update verfügbar (v${manifest.version}), Auto-Apply nicht aktiv oder kein Patch-Level — nur Meldung.`);
        await notify('info', CAT.available, `Update verfügbar – Version ${manifest.version}`,
            `Ein geprüftes, echtes Update des Herausgebers liegt bereit (installiert: ${installed.version ?? 'unbekannt'}). `
            + 'Es wurde noch nichts verändert – das Einspielen wartet auf deine Freigabe.',
            ACTION.confirm);
        return;
    }

    log('Auto-Apply aktiv, Patch-Level-Update — wende an …');
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
        log('🔴 setup.sh update fehlgeschlagen.');
        process.exitCode = EXIT.applyFailed;
        await notify('error', CAT.apply, `Update fehlgeschlagen – Version ${manifest.version}`,
            `Das Einspielen wurde mit einem Fehler abgebrochen (Code ${applyResult.status}). `
            + 'Die Installation kann sich in einem unvollständigen Zustand befinden.',
            ACTION.urgent);
        return;
    }

    // Staging hat seinen Zweck erfüllt, sobald setup.sh update daraus deployt hat
    // (do_deploy kopiert nach /opt/forge/app) — unabhängig vom Health-Gate-Ausgang
    // danach. Ohne dieses Aufräumen sammeln sich pro Update ~200MB unter staging/
    // an (live gefunden: forge-pub1 nach dem ersten echten Apply-Test, 2026-08-03).
    try { rmSync(stageTarget, { recursive: true, force: true }); } catch { /* kein Blocker fürs Health-Gate */ }

    log(`Warte ${HEALTH_WAIT_MS / 1000}s auf Health-Gate …`);
    await sleep(HEALTH_WAIT_MS);
    // Zwei Verschlechterungsarten, beide sind ein Fehlschlag:
    //   1. ein vorher laufender Dienst läuft nicht mehr
    //   2. NRestarts gestiegen → Crash-Loop (fängt auch Dienste, die vorher standen
    //      und jetzt von do_update gestartet wurden, aber sofort wegsterben —
    //      'is-active' zeigt die zwischen zwei Restarts kurzzeitig als gesund)
    const regressed = SERVICES.filter((s, i) =>
        (preActive[i] && !isActive(s)) || restartCount(s) > preRestarts[i]);
    if (regressed.length === 0) {
        log('✓ Health-Check ok.');
        await notify('info', CAT.apply, `Update eingespielt – Version ${manifest.version}`,
            'Das Update wurde installiert und alle Dienste laufen wieder normal.',
            ACTION.fyi);
        return;
    }

    log(`🔴 Health-Check fehlgeschlagen — betroffen: ${regressed.join(', ')}`);
    process.exitCode = EXIT.applyFailed;
    const betroffen = `Betroffene Dienste: ${regressed.join(', ')}.`;
    if (manifest.hasMigrations) {
        log('   hasMigrations=true — KEIN Auto-Rollback (Vorversion wäre inkompatibel mit migriertem Datenstand). Dienste werden gestoppt.');
        for (const s of SERVICES) spawnSync('systemctl', ['stop', s]);
        await notify('error', CAT.rollback, `Update fehlgeschlagen – automatische Rückkehr nicht möglich (v${manifest.version})`,
            `Nach dem Update laufen die Dienste nicht korrekt. ${betroffen} Dieses Update hat die Datenbank `
            + 'umgestellt, deshalb wäre ein automatisches Zurückrollen gefährlicher als der jetzige Zustand – '
            + 'die alte Version passt nicht mehr zu den umgestellten Daten. Die Dienste wurden gestoppt.',
            ACTION.urgent);
        return;
    }
    log(`   Auto-Rollback auf v${installed.code} …`);
    const rollback = spawnSync('bash', [SETUP_SH, 'rollback-code', '--to-version', String(installed.code), '--non-interactive', '--yes'], { stdio: 'inherit' });
    if (rollback.status === 0) {
        await notify('warn', CAT.rollback, `Update zurückgenommen – Version ${manifest.version}`,
            `Nach dem Update liefen die Dienste nicht korrekt. ${betroffen} Die vorherige Version `
            + `(${installed.version ?? `v${installed.code}`}) wurde automatisch wiederhergestellt. `
            + 'Deine Daten, Einstellungen und Wallet-Schlüssel waren davon nicht betroffen.',
            ACTION.afterRollback);
    } else {
        await notify('error', CAT.rollback, `Update fehlgeschlagen und Rücknahme misslungen (v${manifest.version})`,
            'Nach dem Update liefen die Dienste nicht korrekt, und die Wiederherstellung der Vorversion '
            + 'ist ebenfalls fehlgeschlagen.',
            ACTION.urgent);
    }
}

main().catch((err) => {
    console.error(`[update-check] Unerwarteter Fehler: ${err.stack}`);
    process.exitCode = EXIT.unexpected;
});
