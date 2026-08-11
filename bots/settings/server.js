/**
 * forge-settings – Interner HTTPS Admin-Server
 *
 * Port 3200 (HTTPS): Settings-Frontend + FORGE-Dashboards + API
 * Port 3201 (HTTP):  CA-Download-Seite (kein TLS nötig, Bootstrapping)
 *
 * TLS: bots/settings/certs/cert.pem + key.pem (via mkcert, siehe bin/setup-ssl.sh)
 *
 * Routen (HTTPS :3200):
 *   /             → Settings-Frontend (bots/settings/html/)
 *   /dashboard/   → FORGE-Dashboards (FORGE/html/) als statische Dateien
 *   /api/bots     → Bot-Steuerung (Status, Task-Queue für Restart/Start/Stop)
 *   /api/config   → Bot-Konfiguration (lesen/schreiben, ohne Private Keys)
 *   /api/keys     → Private-Key-Management (anzeigen/setzen)
 *
 * Routen (HTTP :3201):
 *   /             → CA-Install-Anleitung mit Download-Button
 *   /rootCA.pem   → rootCA.pem als Download
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { PATHS } from '../../config/paths.js';
import botsRouter      from './routes/bots.js';
import configRouter    from './routes/config.js';
import keysRouter      from './routes/keys.js';
import walletRouter    from './routes/wallet.js';
import poolsRouter           from './routes/pools.js';
import poolsActionsRouter    from './routes/pools-actions.js';
import poolOffersRouter      from './routes/pool-offers.js';
import lendingActionsRouter  from './routes/lending-actions.js';
import addressesRouter       from './routes/addresses.js';
import messagesRouter from './routes/messages.js';
import premiumRouter  from './routes/premium.js';
import updateRouter   from './routes/update.js';
import i18nRouter     from './routes/i18n.js';
import timezoneRouter from './routes/timezone.js';
import { displayVersion } from '../../lib/version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = displayVersion();

const PORT      = parseInt(process.env.PORT      || '3200');
const PORT_CA   = parseInt(process.env.PORT_CA   || '3201');
// Master: bots/settings/certs — FORGE.pub-Fork: <FORGE_SECRETS_DIR>/certs, damit
// die mkcert-Root-CA ein Update übersteht (geht sie verloren, müssen ALLE Clients
// im LAN das Zertifikat neu importieren). Auflösung in config/paths.js.
const CERT_FILE = path.join(PATHS.certs, 'cert.pem');
const KEY_FILE  = path.join(PATHS.certs, 'key.pem');
const CA_FILE   = path.join(PATHS.certs, 'rootCA.pem');
const CA_ZIP    = path.join(PATHS.certs, 'rootCA.zip');

// ── Zertifikat-Check ──────────────────────────────────────────────────────────
if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
    console.error('❌  TLS-Zertifikate fehlen.');
    console.error(`    Erwartet: ${CERT_FILE}`);
    console.error(`    Erwartet: ${KEY_FILE}`);
    console.error('    Bitte einmalig ausführen: bash bots/settings/bin/setup-ssl.sh');
    process.exit(1);
}

// ── Express App ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// API
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION }));
app.use('/api/i18n',      i18nRouter);
app.use('/api/timezone',  timezoneRouter);
app.use('/api/bots',      botsRouter);
app.use('/api/config',    configRouter);
app.use('/api/keys',      keysRouter);
app.use('/api/wallet',    walletRouter);
// poolOffersRouter MUSS vor poolsRouter registriert werden: Express matcht
// Routen in Registrierungsreihenfolge, und pools.js' GET/POST /liquidity/:poolId
// würde sonst "/liquidity/pool-offers" fälschlich als poolId="pool-offers" fangen
// (Fund 2026-07-28, live reproduziert: "Pool nicht gefunden" statt Offers-Liste).
app.use('/api/pools',     poolOffersRouter);
app.use('/api/pools',     poolsRouter);
app.use('/api/pools',     poolsActionsRouter);
app.use('/api/lending',   lendingActionsRouter);
app.use('/api/addresses', addressesRouter);
app.use('/api/messages',  messagesRouter);
app.use('/api/premium',   premiumRouter);
app.use('/api/update',    updateRouter);

// FORGE-Dashboards intern erreichbar unter /forge/ (identisch zum externen Pfad)
// Kein PHP-Interpreter: .php-Dateien werden als text/html serviert (PHP-Tags werden vom Browser ignoriert).
// Directory-Index: index.php (kein index.html, generate-html entfernt seit f769047).
// Eine gemeinsame Options-Definition für BEIDE Mounts (:3200 unten + caApp/:3201
// weiter unten) – Bug 2026-08-08: der :3201-Mount hatte lange Zeit eine eigene,
// unvollständige Kopie ohne setHeaders(). Ohne die Content-Type-Zuweisung erkennt
// der Browser index.php nicht als HTML und bietet es zum Download an; ohne die
// index-Option findet express.static gar keinen Verzeichnis-Index ("Cannot GET
// /forge/") – auf dem Master gibt es nur index.php, kein index.html (siehe oben),
// beide Symptome fielen auf den Forks nicht auf, weil der Export index.php zu
// index.html konvertiert (generate-html.js).
const FORGE_HTML = PATHS.html;
const FORGE_STATIC_OPTS = {
    index: ['index.php', 'index.html'],
    // Ohne das generiert express.static einen ETag/Last-Modified aus Dateigröße+
    // mtime der HTML/PHP-Datei. Der bleibt über einen Server-Codefix hinweg
    // unverändert (nur server.js ändert sich, nicht die Dashboard-Datei selbst) –
    // Browser fragen dann per If-None-Match/If-Modified-Since nach, der Server
    // antwortet "304 Not Modified" OHNE die Header neu zu senden, und der Browser
    // zeigt für immer die alte (falsche) Antwort weiter, egal wie oft man den
    // Server danach fixt (Bug 2026-08-08: index.php löste auf Port 3201 einen
    // Download aus, ein Server-Fix allein reichte nicht, weil ETag-Revalidierung
    // den alten Content-Type am Leben hielt). "no-cache/no-store" unten reicht
    // dafür allein nicht, weil das nur *Revalidierung erzwingt* statt *jede
    // Validierung zu unterbinden* – erst ganz ohne Validator (kein ETag, kein
    // Last-Modified) muss der Server bei jeder Anfrage wirklich neu antworten.
    etag: false,
    lastModified: false,
    setHeaders(res, filePath) {
        if (filePath.endsWith('.php')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
        // HTML/PHP-Seiten nie cachen – sonst sieht der Browser nach Code-Änderungen
        // die neuen ?v=-Parameter in den <script>/<link>-Tags nicht.
        if (filePath.endsWith('.php') || filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
        // JSON-Daten (data.json) werden jede Minute neu generiert –
        // kein Browser- oder Proxy-Caching erlaubt.
        if (filePath.endsWith('.json')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
        // JS/CSS: keine Stale-Versionen nach Code-Updates.
        // index.php/html haben bereits no-cache, aber JS/CSS müssen
        // ebenfalls neu geladen werden wenn sich der Inhalt ändert.
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    },
};
app.use('/forge', express.static(FORGE_HTML, FORGE_STATIC_OPTS));

// Settings-Frontend (root)
app.use(express.static(path.join(__dirname, 'html'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    },
}));

// ── HTTPS Server ──────────────────────────────────────────────────────────────
const server = https.createServer({
    cert: fs.readFileSync(CERT_FILE),
    key:  fs.readFileSync(KEY_FILE),
}, app);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅  forge-settings (HTTPS) läuft auf Port ${PORT}`);
    console.log(`    Settings:   https://<LAN-IP>:${PORT}/`);
    console.log(`    Dashboards: https://<LAN-IP>:${PORT}/forge/`);
});

server.on('error', (err) => {
    console.error('❌  HTTPS Server-Fehler:', err.message);
    process.exit(1);
});

// ── HTTP CA-Download-Server ───────────────────────────────────────────────────
const caApp = express();

// /forge/ same-origin verfügbar machen (nav.js, Logo, CSS): ein Cross-Origin-Import
// von https://host:3200 aus dieser HTTP-Seite (Port 3201) scheitert an CORS
// (unterschiedlicher Port = unterschiedliche Origin, express.static setzt keine
// Access-Control-Allow-Origin-Header) – deshalb hier identisch zur HTTPS-Seite mounten,
// mit denselben FORGE_STATIC_OPTS (siehe Kommentar dort) statt einer eigenen Kopie.
caApp.use('/forge', express.static(FORGE_HTML, FORGE_STATIC_OPTS));

// ZIP-Download: Chrome/Edge prüfen den Dateiinhalt und blockieren PEM-kodierte
// Zertifikate unabhängig von der Dateiendung. ZIP-Dateien werden nie blockiert.
caApp.get('/rootCA.zip', (req, res) => {
    if (!fs.existsSync(CA_ZIP)) {
        return res.status(404).send('rootCA.zip nicht gefunden. Bitte setup-ssl.sh erneut ausführen.');
    }
    res.download(CA_ZIP, 'FORGE-rootCA.zip');
});

caApp.get('/', (req, res) => {
    const ua       = req.headers['user-agent'] || '';
    const isWin    = /windows/i.test(ua);
    const isMac    = /macintosh|mac os/i.test(ua);
    const isAndroid = /android/i.test(ua);
    const host     = req.headers.host?.split(':')[0] || '<Server-IP>';

    const highlight = (id) => isWin && id === 'win' ? 'active'
                            : isMac && id === 'mac' ? 'active'
                            : isAndroid && id === 'android' ? 'active'
                            : (!isWin && !isMac && !isAndroid) && id === 'linux' ? 'active'
                            : '';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FORGE – CA-Zertifikat installieren</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0f172a; color: #f1f5f9;
    font-family: 'Segoe UI', system-ui, sans-serif;
    min-height: 100vh; display: flex; flex-direction: column;
  }
  .header {
    background: linear-gradient(to right, rgba(15,23,42,0.8), rgba(30,41,59,0.8));
    backdrop-filter: blur(10px);
    border-bottom: 1px solid #475569;
    position: sticky; top: 0; z-index: 100;
    padding: 0.85rem 1.5rem;
  }
  .header-content { max-width: 1400px; margin: 0 auto; }
  .header-logo { display: flex; align-items: center; gap: 0.75rem; text-decoration: none; }
  .header-logo img { height: 40px; width: auto; border-radius: 6px; }
  .header-logo h1 {
    font-size: 1.3rem; font-weight: 700; color: #00d4ff;
    text-shadow: 0 0 24px rgba(0,212,255,0.35); cursor: pointer;
  }
  .main-content {
    flex: 1; display: flex; align-items: center; justify-content: center;
    padding: 1.5rem;
  }
  .card {
    background: #1e293b; border: 1px solid #475569; border-radius: 14px;
    padding: 2rem 2.5rem; max-width: 560px; width: 100%;
  }
  h1 { font-size: 1.3rem; color: #00d4ff; margin-bottom: 0.25rem; }
  .sub { color: #94a3b8; font-size: 0.85rem; margin-bottom: 1.75rem; }
  .dl-btn {
    display: block; width: 100%; padding: 0.85rem;
    background: #00d4ff; color: #0f172a;
    border: none; border-radius: 9px; font-size: 1rem; font-weight: 700;
    cursor: pointer; text-align: center; text-decoration: none; margin-bottom: 1.75rem;
  }
  .dl-btn:hover { opacity: 0.88; }
  .tabs { display: flex; gap: 0.4rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .tab {
    padding: 0.35rem 0.85rem; border-radius: 6px; font-size: 0.8rem; font-weight: 500;
    cursor: pointer; border: 1px solid #475569; background: transparent; color: #94a3b8;
  }
  .tab.active { background: rgba(0,212,255,0.12); border-color: #00d4ff; color: #00d4ff; }
  .instructions { display: none; }
  .instructions.active { display: block; }
  .instructions ol { padding-left: 1.3rem; }
  .instructions li { margin-bottom: 0.55rem; font-size: 0.875rem; line-height: 1.5; color: #cbd5e1; }
  .instructions li b { color: #f1f5f9; }
  code {
    background: #0f172a; border: 1px solid #334155;
    padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.8rem; color: #7dd3fc;
  }
  .cmd-box {
    background: #0f172a; border: 1px solid #334155; border-radius: 7px;
    padding: 0.6rem 0.75rem; font-family: 'Consolas','Courier New',monospace;
    font-size: 0.78rem; color: #7dd3fc; width: 100%; resize: none;
    cursor: text; line-height: 1.55; margin-bottom: 0.5rem;
  }
  .copy-btn {
    display: block; width: 100%; padding: 0.5rem;
    background: rgba(0,212,255,0.12); border: 1px solid rgba(0,212,255,0.35);
    color: #00d4ff; border-radius: 7px; font-size: 0.82rem; font-weight: 600;
    cursor: pointer; margin-bottom: 0.9rem;
  }
  .copy-btn:hover { background: rgba(0,212,255,0.2); }
  .copy-btn.copied { background: rgba(16,185,129,0.15); border-color: #10b981; color: #10b981; }
  .hint {
    margin-top: 1.5rem; padding: 0.75rem 1rem;
    background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3);
    border-radius: 8px; font-size: 0.8rem; color: #fcd34d;
  }
</style>
</head>
<body>
<header class="header">
  <div class="header-content">
    <div class="header-logo">
      <a href="https://${host}:${PORT}/" title="Zur Hauptseite">
        <img src="/forge/img/forge-logo.png" alt="FORGE Logo">
      </a>
      <h1>CA-Setup</h1>
    </div>
  </div>
</header>
<main class="main-content">
<div class="card">
  <h1>Root-Zertifikat installieren</h1>
  <p class="sub">Einmalig nötig, damit der Browser der FORGE-Settings-Seite vertraut.</p>

  <a class="dl-btn" href="/rootCA.zip">
    ⬇ FORGE-rootCA.zip herunterladen
  </a>
  <p style="font-size:0.75rem;color:#64748b;margin-top:-1rem;margin-bottom:1.5rem;text-align:center;">
    ZIP-Datei → entpacken → <b>FORGE-rootCA.crt</b> doppelklicken
  </p>

  <div class="tabs">
    <button class="tab ${highlight('win')}"     onclick="show('win',this)">Windows</button>
    <button class="tab ${highlight('mac')}"     onclick="show('mac',this)">macOS</button>
    <button class="tab ${highlight('linux')}"   onclick="show('linux',this)">Linux</button>
    <button class="tab ${highlight('android')}" onclick="show('android',this)">Android</button>
    <button class="tab"                         onclick="show('firefox',this)">Firefox</button>
  </div>

  <div class="instructions ${highlight('win')}" id="win">
    <p style="font-size:0.8rem;color:#94a3b8;margin-bottom:0.9rem;">Option 1 – ZIP (empfohlen)</p>
    <ol>
      <li>ZIP oben herunterladen → im Explorer entpacken (Rechtsklick → <b>Alle extrahieren</b>).</li>
      <li>Die Datei <b>FORGE-rootCA.crt</b> doppelklicken.</li>
      <li>Im Dialog <b>„Zertifikat installieren"</b> klicken.</li>
      <li><b>„Lokaler Computer"</b> auswählen → Weiter.</li>
      <li><b>„Alle Zertifikate in folgendem Speicher speichern"</b> → <b>Durchsuchen</b>.</li>
      <li><b>„Vertrauenswürdige Stammzertifizierungsstellen"</b> → OK → Fertig stellen.</li>
      <li>Browser neu starten.</li>
    </ol>
    <p style="font-size:0.8rem;color:#94a3b8;margin:1.2rem 0 0.5rem;">Option 2 – PowerShell (kein manueller Download, keine Admin-Rechte nötig)</p>
    <p style="font-size:0.8rem;color:#cbd5e1;margin-bottom:0.6rem;">
      <b>Windows-Taste</b> drücken → <b>PowerShell</b> eintippen → normal öffnen (keine Elevation nötig) → Befehl kopieren → ins PowerShell-Fenster einfügen:
    </p>
    <p style="font-size:0.75rem;color:#64748b;margin-bottom:0.5rem;">
      💡 Im blauen PowerShell-Fenster: Einfügen = <b>Rechtsklick</b> (nicht Strg+V)
    </p>
    <textarea class="cmd-box" id="psCmd" rows="4" readonly onclick="this.select()">$f="$env:TEMP\\forge.zip"; $d="$env:TEMP\\forge-ca"; Invoke-WebRequest http://${host}:${PORT_CA}/rootCA.zip -OutFile $f; Expand-Archive $f $d -Force; Import-Certificate -FilePath "$d\\FORGE-rootCA.crt" -CertStoreLocation Cert:\\CurrentUser\\Root; Remove-Item $f,$d -Recurse -Force</textarea>
    <button class="copy-btn" id="copyBtn" onclick="copyCmd()">⎘&nbsp; Befehl kopieren</button>
    <p style="font-size:0.8rem;color:#fcd34d;margin-top:0.5rem;">
      ⚠ Danach alle Browser-Fenster schließen und den Browser neu starten.
    </p>
    <p style="font-size:0.75rem;color:#64748b;margin-top:0.6rem;">
      Gilt nur für den aktuellen Windows-Benutzer. Für alle Benutzer des Geräts: PowerShell
      <b>als Administrator</b> öffnen und im Befehl oben <code>CurrentUser</code> durch
      <code>LocalMachine</code> ersetzen.
    </p>
  </div>

  <div class="instructions ${highlight('mac')}" id="mac">
    <ol>
      <li>Die heruntergeladene Datei <b>FORGE-rootCA.crt</b> doppelklicken – öffnet <b>Schlüsselbundverwaltung</b>.</li>
      <li>Zertifikat in <b>„System"</b> ablegen.</li>
      <li>Zertifikat in der Liste finden → Doppelklick → <b>„Vertrauen"</b> aufklappen.</li>
      <li><b>„Beim Verwenden dieses Zertifikats"</b> auf <b>„Immer vertrauen"</b> setzen → Schließen.</li>
      <li>Passwort eingeben → Browser neu starten.</li>
    </ol>
  </div>

  <div class="instructions ${highlight('linux')}" id="linux">
    <ol>
      <li>Datei nach <code>/usr/local/share/ca-certificates/</code> kopieren:<br>
        <code>sudo cp FORGE-rootCA.crt /usr/local/share/ca-certificates/forge-ca.crt</code></li>
      <li>CA-Store aktualisieren:<br>
        <code>sudo update-ca-certificates</code></li>
      <li>Browser neu starten.</li>
    </ol>
  </div>

  <div class="instructions ${highlight('android')}" id="android">
    <ol>
      <li><b>Einstellungen</b> öffnen → <b>Sicherheit</b> (oder „Biometrie &amp; Sicherheit").</li>
      <li><b>„Weitere Sicherheitseinstellungen"</b> → <b>„Zertifikat installieren"</b>.</li>
      <li><b>„CA-Zertifikat"</b> auswählen → Warnung bestätigen.</li>
      <li>Die heruntergeladene Datei <b>FORGE-rootCA.crt</b> auswählen.</li>
      <li>Browser neu starten.</li>
    </ol>
  </div>

  <div class="instructions" id="firefox">
    <ol>
      <li>Firefox öffnen → <b>Einstellungen</b> → <b>Datenschutz &amp; Sicherheit</b>.</li>
      <li>Ganz unten: <b>„Zertifikate"</b> → <b>„Zertifikate anzeigen"</b>.</li>
      <li>Tab <b>„Zertifizierungsstellen"</b> → <b>„Importieren"</b>.</li>
      <li>Datei <b>FORGE-rootCA.crt</b> auswählen → <b>„Dieser CA vertrauen, um Webseiten zu identifizieren"</b> anhaken → OK.</li>
      <li>Firefox neu starten.</li>
    </ol>
  </div>

  <div class="hint">
    Nach der Installation: <a href="https://${host}:${PORT}/" style="color:#fcd34d;">https://${host}:${PORT}/</a> aufrufen.
  </div>

  <details style="margin-top:1.25rem;">
    <summary style="font-size:0.8rem;color:#64748b;cursor:pointer;user-select:none;">Zertifikat wieder entfernen</summary>
    <div style="margin-top:0.85rem;">
      <p style="font-size:0.8rem;color:#94a3b8;margin-bottom:0.5rem;">Option 1 – PowerShell (ohne Admin-Rechte, wenn per CurrentUser installiert)</p>
      <textarea class="cmd-box" id="rmCmd" rows="2" readonly onclick="this.select()">Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Subject -like "*mkcert*" } | Remove-Item</textarea>
      <p style="font-size:0.75rem;color:#64748b;margin:0.4rem 0;">Falls per LocalMachine installiert: PowerShell als Administrator öffnen, <code>CurrentUser</code> durch <code>LocalMachine</code> ersetzen.</p>
      <button class="copy-btn" id="rmBtn" onclick="
        const ta=document.getElementById('rmCmd');
        ta.select(); ta.setSelectionRange(0,99999); document.execCommand('copy');
        const b=document.getElementById('rmBtn');
        b.textContent='✓  Kopiert!'; b.classList.add('copied');
        setTimeout(()=>{b.textContent='⎘  Befehl kopieren';b.classList.remove('copied');},2000);
      ">⎘&nbsp; Befehl kopieren</button>
      <p style="font-size:0.8rem;color:#94a3b8;margin:0.75rem 0 0.4rem;">Option 2 – Grafisch (certmgr)</p>
      <ol style="padding-left:1.3rem;">
        <li style="font-size:0.82rem;color:#cbd5e1;margin-bottom:0.4rem;"><b>Windows-Taste</b> → <code>certmgr.msc</code> → Enter</li>
        <li style="font-size:0.82rem;color:#cbd5e1;margin-bottom:0.4rem;"><b>Vertrauenswürdige Stammzertifizierungsstellen</b> → <b>Zertifikate</b></li>
        <li style="font-size:0.82rem;color:#cbd5e1;margin-bottom:0.4rem;">„mkcert" in der Liste suchen → Rechtsklick → <b>Löschen</b></li>
        <li style="font-size:0.82rem;color:#cbd5e1;">Browser neu starten</li>
      </ol>
    </div>
  </details>
</div>
</main>
<script>
  function show(id, btn) {
    document.querySelectorAll('.instructions').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    btn.classList.add('active');
  }

  function copyCmd() {
    const ta = document.getElementById('psCmd');
    const btn = document.getElementById('copyBtn');

    // navigator.clipboard funktioniert nur über HTTPS – Fallback: execCommand
    const done = () => {
      btn.textContent = '✓  Kopiert!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '⎘  Befehl kopieren'; btn.classList.remove('copied'); }, 2000);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(ta.value).then(done).catch(() => fallback());
    } else {
      fallback();
    }

    function fallback() {
      ta.select();
      ta.setSelectionRange(0, 99999);
      const ok = document.execCommand('copy');
      if (ok) done();
      else {
        btn.textContent = '⚠ Bitte manuell markieren (Strg+A) und kopieren';
        setTimeout(() => { btn.textContent = '⎘  Befehl kopieren'; }, 3000);
      }
    }
  }

  // Beim Laden: falls kein Tab aktiv, ersten Tab aktivieren
  window.addEventListener('DOMContentLoaded', () => {
    if (!document.querySelector('.instructions.active')) {
      document.querySelector('.tab').click();
    }
  });
</script>
<script type="module">
  import { initNav } from '/forge/js/nav.js?v=20260811b';
  initNav({ current: 'ssl-cert' });
</script>
</body>
</html>`);
});

const caServer = http.createServer(caApp);
caServer.listen(PORT_CA, '0.0.0.0', () => {
    console.log(`✅  CA-Download   (HTTP)  läuft auf Port ${PORT_CA}`);
    console.log(`    CA-Seite: http://<LAN-IP>:${PORT_CA}/`);
});
caServer.on('error', (err) => {
    console.error('❌  CA-Server Fehler:', err.message);
});
