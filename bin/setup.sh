#!/bin/bash
# ═════════════════════════════════════════════════════════════════════════════
# FORGE.pub – Setup
# ═════════════════════════════════════════════════════════════════════════════
# Nachfolger von bin/install.sh. Deckt den gesamten Lebenszyklus einer
# FORGE.pub-Installation ab, nicht nur die Erstinstallation:
#
#   install | uninstall | packages | wallet | nostr | ssl | services | cron
#   backup  | restore   | update   | status | help
#
# Jeder Teilschritt ist EINZELN aufrufbar und vollständig über Parameter
# steuerbar (--non-interactive), damit Automatisierung und Cron ihn nutzen
# können. Grund: der Vorgänger war eine starre Kette aus ~10 `read -p`-Prompts —
# ein einziger zusätzlicher/übersehener Prompt verschob ALLE folgenden Antworten
# still und ohne Fehlermeldung. Genau so entstand der Vorfall vom 2026-07-31
# (Jupiter-Key als TLS-Hostname, Wallet nicht importiert, Bot-DB verloren).
# Siehe installer-fragilitaet.md.
#
# ── Verzeichnisstruktur ──────────────────────────────────────────────────────
#   /opt/forge/app             aktuelle Version (wird bei Update/Reinstall ERSETZT)
#   /opt/forge/local/data      Datenbanken
#   /opt/forge/local/env       .env-Dateien          (0700)
#   /opt/forge/local/secrets   Wallet-Keys, Nostr, TLS (0700)
#   /opt/forge/log             Logdateien (bewusst NICHT unter local/)
#   /opt/forge/BACKUP          Zustands-Archive + forge-pub-current.tgz
#
# Alles Instanzspezifische liegt unter `local/`. Dadurch lautet die Backup-Regel
# schlicht "sichere local/" statt einer Aufzählung, die man unvollständig
# zusammensetzen kann — und der Code daneben ist jederzeit aus dem Artefakt
# reproduzierbar (node_modules per npm install, html/ und Code aus current.tgz).
#
# Der entscheidende Punkt: ein Update löscht ausschließlich `app/`. Es braucht
# KEINE Ausschlussliste, die man versehentlich zu eng oder zu weit fassen kann —
# Zustandsdaten liegen strukturell außerhalb der Löschzone. `config/paths.js`
# erkennt dieses Layout selbst (siehe dort), deshalb gilt es auch für Cron-Jobs
# und Handaufrufe, nicht nur für die systemd-Services.
#
# ── Warum root ───────────────────────────────────────────────────────────────
# Das Script MUSS als root laufen. Das ist keine Bequemlichkeit, sondern
# verhindert strukturell den Fehler aus Root-Cause #3: läuft mkcert mal als
# `forge` und mal als der aufrufende Mensch, entstehen ZWEI verschiedene
# Root-CAs — und alle Clients im LAN, die der ersten vertraut haben, bekommen
# nach einer Reparatur Zertifikatsfehler. Mit festem User UND festem CAROOT
# (unter secrets/) kann das nicht mehr passieren.
# ═════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Konstanten ───────────────────────────────────────────────────────────────
BASE_DIR="/opt/forge"
APP_DIR="$BASE_DIR/app"
LOCAL_DIR="$BASE_DIR/local"
DATA_DIR="$LOCAL_DIR/data"
ENV_DIR="$LOCAL_DIR/env"
SECRETS_DIR="$LOCAL_DIR/secrets"
LOG_DIR="$BASE_DIR/log"
BACKUP_DIR="$BASE_DIR/BACKUP"
CERTS_DIR="$SECRETS_DIR/certs"
CAROOT_DIR="$SECRETS_DIR/mkcert-ca"
CURRENT_TGZ="$BACKUP_DIR/forge-pub-current.tgz"
TRUST_DIR="$LOCAL_DIR/trust"
VERSIONS_DIR="$BACKUP_DIR/versions"

INSTALL_USER="forge"
SUDOERS_FILE="/etc/sudoers.d/forge-systemctl"
GETTING_STARTED="$BASE_DIR/GETTING-STARTED.txt"
BACKUP_RETENTION=30
VERSIONS_RETENTION=5

SERVICES=(forge-nexus forge-premium forge-settings forge-settings-daemon forge-liquiditybot forge-lendingbot)
NOSTR_IDENTITY_NAME="forge-pub-nostr"

ARTIFACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Optionen (per CLI überschreibbar) ────────────────────────────────────────
INTERACTIVE=1
ASSUME_YES=0
QUIET=0
JSON_OUT=0
LOG_FILE=""
OPT_JUPITER_KEY=""
OPT_HELIUS_KEY=""
OPT_TELEGRAM_TOKEN=""
OPT_TELEGRAM_CHAT=""
OPT_LAN_IP=""
OPT_NOSTR_ALIAS=""
OPT_RESTORE_FROM=""
OPT_WALLETS="liquidity,lending,premium"
OPT_KEEP_DATA=0
OPT_ROLLBACK_VERSION=""

# ── Ausgabe ──────────────────────────────────────────────────────────────────
# Jede Meldung geht zusätzlich ins Logfile. Das Log liegt in log/ und damit
# außerhalb von app/ — es überlebt ein Update und ist genau dann noch da, wenn
# man nach einem missglückten Lauf nachvollziehen will, was passiert ist.
_log() { [[ -n "$LOG_FILE" ]] && printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE" || true; }
say()    { [[ "$QUIET" -eq 0 ]] && echo -e "$1" || true; _log "$1"; }
c_ok()   { say "  ✅  $1"; }
c_warn() { say "  ⚠️   $1"; }
c_err()  { echo -e "  ❌  $1" >&2; _log "FEHLER: $1"; }
step()   { say ""; say "── $1 ─────────────────────────────────────────"; }
die()    { c_err "$1"; exit "${2:-1}"; }

# Fragt nur im interaktiven Modus. Im automatisierten Lauf MUSS ein Wert per
# Parameter gesetzt sein — es gibt bewusst keinen stillen Default, der einen
# fehlenden Wert überdeckt.
ask() {
    # ask <variable> <prompt> [default]
    local __var="$1" __prompt="$2" __default="${3:-}" __ans=""
    if [[ "$INTERACTIVE" -eq 0 ]]; then
        [[ -n "$__default" ]] && { printf -v "$__var" '%s' "$__default"; return 0; }
        die "--non-interactive: benötigter Wert fehlt ($__var). Siehe '$0 help'."
    fi
    read -r -p "$__prompt" __ans || true
    printf -v "$__var" '%s' "${__ans:-$__default}"
}

confirm() {
    # confirm <frage>  → 0 = ja
    local frage="$1" ans=""
    [[ "$ASSUME_YES" -eq 1 ]] && return 0
    [[ "$INTERACTIVE" -eq 0 ]] && return 1
    read -r -p "  $frage [j/N]: " ans || true
    [[ "$ans" == "j" || "$ans" == "J" ]]
}

require_root() {
    [[ "$EUID" -eq 0 ]] || die "Bitte als root ausführen:  sudo $0 $*"
}

init_log() {
    mkdir -p "$LOG_DIR/setup"
    [[ -z "$LOG_FILE" ]] && LOG_FILE="$LOG_DIR/setup/$(date +%Y%m%d-%H%M%S)-setup.log"
    touch "$LOG_FILE"; chmod 640 "$LOG_FILE"
    # Logrotation: die letzten 30 Setup-Logs reichen zur Fehlersuche. Ohne diese
    # Grenze läuft log/setup/ bei häufigen Testläufen langsam voll.
    local alt
    alt=$(ls -1t "$LOG_DIR"/setup/*-setup.log 2>/dev/null | tail -n +31 || true)
    [[ -n "$alt" ]] && echo "$alt" | xargs -r rm -f || true
}

# ═════════════════════════════════════════════════════════════════════════════
# Verzeichnisse
# ═════════════════════════════════════════════════════════════════════════════
ensure_dirs() {
    mkdir -p "$BASE_DIR" "$LOCAL_DIR" "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR"
    mkdir -p "$DATA_DIR/liquidity" "$DATA_DIR/lending" "$DATA_DIR/cron-locks"
    mkdir -p "$LOG_DIR/cron" "$LOG_DIR/liquidity" "$LOG_DIR/setup"
    # env/ und secrets/ enthalten API-Keys bzw. Private Keys im Klartext → 0700.
    # Bei env/ hängt der Schutz an dieser expliziten Rechtevergabe (es erbt ihn
    # nicht mehr von secrets/, seit es ein eigenes Verzeichnis ist).
    mkdir -p -m 700 "$ENV_DIR" "$SECRETS_DIR" "$CERTS_DIR" "$CAROOT_DIR" "$TRUST_DIR"
    chmod 700 "$ENV_DIR" "$SECRETS_DIR" "$TRUST_DIR"
    chmod 700 "$BACKUP_DIR"; chown root:root "$BACKUP_DIR"
    mkdir -p "$VERSIONS_DIR"
}

# 🔒 Trust-Anchor (öffentliche Update-Signaturschlüssel) NUR bei der Erstinstallation
# aus dem Artefakt übernehmen — TOFU (Trust On First Use). NIEMALS bei einem Update
# erneut schreiben: local/trust/ liegt bewusst außerhalb von $APP_DIR, das do_deploy
# komplett ersetzt (rm -rf), damit kein Code-Update den Vertrauensanker austauschen
# kann (Befund C, update.md "Umsetzungsentwurf 2026-08-03"). Ein späterer
# Schlüsselwechsel läuft ausschließlich über den eigenen, signierten
# trust-rotation-Manifest-Typ — nie durch Überschreiben dieser Datei.
do_trust_anchor() {
    local src="$APP_DIR/config/pub-trust-anchor.json"
    local dst="$TRUST_DIR/trust-anchor.json"
    if [[ -f "$dst" ]]; then
        say "  Trust-Anchor bereits vorhanden ($dst) — unverändert gelassen."
        return 0
    fi
    if [[ ! -f "$src" ]]; then
        c_warn "Kein Trust-Anchor im Artefakt gefunden ($src) — Auto-Update-Verifikation wird nicht möglich sein, bis das nachgeholt wird."
        return 0
    fi
    cp "$src" "$dst"
    chmod 600 "$dst"
    chown "$INSTALL_USER:$INSTALL_USER" "$dst" 2>/dev/null || true
    c_ok "Trust-Anchor angelegt: $dst"
}

fix_ownership() {
    # Alles, worauf die Services schreibend zugreifen, gehört dem Service-User.
    # BACKUP/ und die Logdatei bewusst NICHT — die gehören root.
    chown -R "$INSTALL_USER:$INSTALL_USER" "$APP_DIR" "$LOCAL_DIR" 2>/dev/null || true
    chown "$INSTALL_USER:$INSTALL_USER" "$LOG_DIR" "$LOG_DIR/cron" "$LOG_DIR/liquidity" "$LOG_DIR/setup" 2>/dev/null || true
    chmod 700 "$ENV_DIR" "$SECRETS_DIR"
}

# Erkennt eine Installation in der ALTEN Struktur (Code direkt unter /opt/forge).
# Wichtig, weil ein normaler install/update dort die Bot-DBs verwaisen ließe:
# der Bot startete mit leerer DB, während on-chain echte Positionen offen sind.
is_legacy_layout() {
    [[ -d "$BASE_DIR/bots" && ! -d "$APP_DIR" ]]
}
guard_legacy() {
    is_legacy_layout || return 0
    c_err "Unter $BASE_DIR liegt eine Installation in der alten Struktur."
    c_err "Ein '$1' würde die vorhandenen Bot-Datenbanken verwaisen lassen."
    c_err "Diese Version unterstützt nur noch $APP_DIR + $LOCAL_DIR."
    c_err "Zustand ($BASE_DIR/data, /secrets, die .env-Dateien) zuerst manuell sichern."
    exit 2
}

# ═════════════════════════════════════════════════════════════════════════════
# Code-Versionsarchiv (Rollback-Grundlage, Befund A / update.md
# "Umsetzungsentwurf 2026-08-03")
# ═════════════════════════════════════════════════════════════════════════════
# do_backup() (unten) sichert nur local/ (Zustand) — der Codestand lag bisher NUR
# als fester Name BACKUP/forge-pub-current.tgz daneben und wurde von do_deploy bei
# JEDEM Update mit dem NEUEN Code überschrieben. Ein Rollback hatte damit nie eine
# Quelle. Diese beiden Funktionen legen stattdessen EINEN Ordner pro VersionCode an
# (BACKUP/versions/v<N>/app.tgz), damit rollback-code gezielt eine ältere Version
# zurückspielen kann. Bewusst getrennt von do_backup: Code ist versions-indiziert,
# Zustand ist zeit-indiziert (siehe update.md, "Backup-Layout").
version_code_of() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    # '|| true' NACH der Pipeline (nicht davor/darin, siehe tools/pub-export/CLAUDE.md
    # "Bekannte Fallstricke"): grep liefert bei alten VERSION-Dateien ohne VersionCode-
    # Zeile (Stand vor 2026-08-03, z.B. forge-pub1) Exit-Code 1 — unter 'set -o
    # pipefail' bricht das sonst über eine 'code=$(version_code_of …)'-Zuweisung das
    # GANZE Script ab (set -e), obwohl "keine VersionCode-Zeile" ein normaler,
    # erwarteter Fall ist, kein Fehler. Live gefunden beim ersten echten Update-Lauf
    # auf forge-pub1 (2026-08-03).
    grep -m1 '^VersionCode:' "$file" 2>/dev/null | awk '{print $2}' || true
}

archive_current_code() {
    local code
    code=$(version_code_of "$APP_DIR/VERSION")
    if [[ -z "$code" ]]; then
        c_warn "Installierte VERSION-Datei hat keine VersionCode-Zeile (Artefakt-Stand vor 2026-08-03) — kein Code-Rollback-Archiv möglich für diesen Stand."
        return 0
    fi
    local dir="$VERSIONS_DIR/v$code"
    if [[ -f "$dir/app.tgz" ]]; then
        say "  Code-Archiv für v$code existiert bereits — nicht erneut geschrieben."
        return 0
    fi
    mkdir -p "$dir"
    say "  → Sichere aktuellen Codestand (v$code) nach $dir/app.tgz ..."
    tar czf "$dir/app.tgz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")" --exclude=node_modules 2>/dev/null \
        || tar czf "$dir/app.tgz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
    chmod 600 "$dir/app.tgz"
    c_ok "Code-Archiv erstellt: $dir/app.tgz ($(du -h "$dir/app.tgz" | cut -f1))"

    # Retention: nur die letzten VERSIONS_RETENTION Versionsordner behalten (numerisch
    # nach v<N> sortiert, nicht nach Dateidatum — analog zur bestehenden do_backup-Rotation).
    local alt
    # '|| true' aus demselben Grund wie in version_code_of(): 'ls' auf ein noch
    # leeres/frisches VERSIONS_DIR (kein "v*"-Treffer) liefert Exit-Code 2, würde
    # sonst unter 'set -e'+pipefail das Script abbrechen.
    alt=$(ls -1d "$VERSIONS_DIR"/v* 2>/dev/null | sed 's#.*/v##' | sort -rn | tail -n +$((VERSIONS_RETENTION + 1)) || true)
    if [[ -n "$alt" ]]; then
        local n=0
        for v in $alt; do rm -rf "$VERSIONS_DIR/v$v"; n=$((n + 1)); done
        c_ok "$n alte(r) Versionsordner entfernt (Retention: $VERSIONS_RETENTION)."
    fi
}

do_rollback_code() {
    step "Code-Rollback"
    guard_legacy rollback-code
    if [[ -z "$(ls -A "$VERSIONS_DIR" 2>/dev/null)" ]]; then
        die "Keine Versionsarchive in $VERSIONS_DIR gefunden — Rollback nicht möglich."
    fi
    local target="$OPT_ROLLBACK_VERSION"
    if [[ -z "$target" ]]; then
        target=$(ls -1d "$VERSIONS_DIR"/v* 2>/dev/null | sed 's#.*/v##' | sort -rn | head -1 || true)
        say "  Keine Version angegeben (--to-version) — nehme die neueste verfügbare: v$target"
    fi
    local archive="$VERSIONS_DIR/v$target/app.tgz"
    [[ -f "$archive" ]] || die "Kein Code-Archiv für Version v$target gefunden ($archive). Verfügbar: $(ls -1d "$VERSIONS_DIR"/v* 2>/dev/null | sed 's#.*/v#v#' | tr '\n' ' ' || true)"

    local aktuell_code; aktuell_code=$(version_code_of "$APP_DIR/VERSION")
    say "  Aktuell installiert: v${aktuell_code:-unbekannt}"
    say "  Rollback-Ziel:       v$target"
    c_warn "Das betrifft NUR den Code (app/). Datenbanken, .env und Keys (local/) bleiben unangetastet."
    c_warn "🔴 Falls seit v$target eine Datenbank-Migration lief, kann der alte Code mit dem"
    c_warn "   heutigen (migrierten) Datenstand inkompatibel sein — im Zweifel vorher klären,"
    c_warn "   nicht blind zurückrollen."
    confirm "Code-Rollback auf v$target jetzt durchführen?" || { say "  Abgebrochen."; return 0; }

    # Den aktuellen (vermutlich fehlerhaften) Codestand ebenfalls archivieren, falls für
    # ihn noch kein Archiv existiert — sonst wäre ein Rollback vom Rollback nicht mehr möglich.
    archive_current_code

    say "  → Dienste stoppen ..."
    systemctl stop "${SERVICES[@]}" 2>/dev/null || true
    rm -rf "${APP_DIR:?}"
    mkdir -p "$APP_DIR"
    tar xzf "$archive" -C "$(dirname "$APP_DIR")"
    fix_ownership
    say "  → npm install (Zielversion kann andere Abhängigkeiten brauchen) ..."
    do_npm
    do_services
    do_cron
    do_logrotate
    say "  → Dienste starten ..."
    systemctl start forge-nexus forge-premium forge-settings forge-settings-daemon 2>/dev/null || true
    sleep 3
    systemctl start forge-liquiditybot forge-lendingbot 2>/dev/null || true
    c_ok "Code-Rollback auf v$target abgeschlossen."
    do_status
}

# ═════════════════════════════════════════════════════════════════════════════
# Backup / Restore
# ═════════════════════════════════════════════════════════════════════════════
# Gesichert werden app + secrets + data. log/ bewusst NICHT: es ist reproduzierbar
# nutzlos für eine Wiederherstellung und würde die Archive erheblich aufblähen.
do_backup() {
    step "Backup"
    ensure_dirs
    [[ -n "$(ls -A "$LOCAL_DIR" 2>/dev/null)" ]] || {
        c_warn "Nichts zu sichern (kein Zustand unter $LOCAL_DIR)."; return 0; }

    # Gesichert wird NUR local/ — also Datenbanken, .env und Keys. Nicht der Code:
    # der liegt als forge-pub-current.tgz daneben (vom Install/Update abgelegt),
    # node_modules kommt aus 'npm install', html/ aus dem Artefakt. Das drückt ein
    # Archiv von ~123 MB auf ~10 MB, ohne dass etwas Unersetzliches fehlt.
    # Die VERSION wandert mit ins Archiv: ein Zustand ohne den zugehörigen
    # Codestand ist wertlos, weil Schema-Migrationen manuell und vorwärtsgerichtet
    # sind — ohne diese Angabe könnte jemand eine DB in inkompatiblen Code zurückspielen.
    local file="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)-forge-pub-state.tgz"
    local stamp="$LOCAL_DIR/VERSION-STAMP"
    { echo "gesichert: $(date '+%Y-%m-%d %H:%M:%S %Z')"
      echo "version:   $([[ -f "$APP_DIR/VERSION" ]] && head -1 "$APP_DIR/VERSION" || echo unbekannt)"
    } > "$stamp"

    say "  → Sichere Zustand (local/) nach $file ..."
    tar czf "$file" -C "$BASE_DIR" local
    chmod 600 "$file"
    rm -f "$stamp"
    c_ok "Backup erstellt: $file ($(du -h "$file" | cut -f1))"
    [[ -f "$CURRENT_TGZ" ]] && c_ok "Passender Code liegt bereits als $(basename "$CURRENT_TGZ") daneben." \
                            || c_warn "Achtung: $(basename "$CURRENT_TGZ") fehlt – Wiederherstellung bräuchte das Artefakt von außen."

    # Rotation: die ältesten Archive über der Grenze fallen weg.
    local alt
    alt=$(ls -1t "$BACKUP_DIR"/*-forge-pub-state.tgz 2>/dev/null | tail -n +$((BACKUP_RETENTION + 1)) || true)
    if [[ -n "$alt" ]]; then
        echo "$alt" | xargs -r rm -f
        c_ok "$(echo "$alt" | wc -l) altes/alte Backup(s) entfernt (Retention: $BACKUP_RETENTION)."
    fi
    [[ "$JSON_OUT" -eq 1 ]] && echo "{\"ok\":true,\"backup\":\"$file\"}"
    return 0
}

do_restore() {
    step "Backup zurückspielen"
    local src="$OPT_RESTORE_FROM"
    if [[ -z "$src" ]]; then
        local neuestes
        neuestes=$(ls -1t "$BACKUP_DIR"/*-forge-pub-state.tgz 2>/dev/null | head -1 || true)
        [[ -n "$neuestes" ]] || die "Kein Backup gefunden in $BACKUP_DIR (oder --from <datei> angeben)."
        say "  Neuestes Backup: $neuestes"
        confirm "Dieses Backup zurückspielen?" || { say "  Abgebrochen."; return 0; }
        src="$neuestes"
    fi
    [[ -f "$src" ]] || die "Backup-Datei nicht gefunden: $src"

    say "  → Services stoppen ..."
    systemctl stop "${SERVICES[@]}" 2>/dev/null || true
    # Vor dem Überschreiben nochmal den IST-Zustand sichern — sonst wäre ein
    # versehentlich falsch gewähltes Archiv nicht mehr rückgängig zu machen.
    do_backup
    say "  → Entpacke $src ..."
    # Nur local/ wird ersetzt — der Code bleibt stehen. Passt die im Archiv
    # vermerkte Version nicht zum installierten Stand, wird gewarnt statt still
    # eine DB unter fremdem Schema zu starten.
    rm -rf "${LOCAL_DIR:?}"
    tar xzf "$src" -C "$BASE_DIR"
    if [[ -f "$LOCAL_DIR/VERSION-STAMP" ]]; then
        say "  Archiv-Info:"; sed 's/^/    /' "$LOCAL_DIR/VERSION-STAMP"
        local jetzt="unbekannt"; [[ -f "$APP_DIR/VERSION" ]] && jetzt=$(head -1 "$APP_DIR/VERSION")
        grep -q "version:   $jetzt" "$LOCAL_DIR/VERSION-STAMP" \
            || c_warn "Version des Backups weicht vom installierten Stand ($jetzt) ab – Schema prüfen!"
        rm -f "$LOCAL_DIR/VERSION-STAMP"
    fi
    fix_ownership
    say "  → Services starten ..."
    systemctl start "${SERVICES[@]}" 2>/dev/null || true
    c_ok "Wiederherstellung abgeschlossen."
}

# ═════════════════════════════════════════════════════════════════════════════
# Pakete
# ═════════════════════════════════════════════════════════════════════════════
# Bewusst KEIN Blind-Install: fehlende Pakete werden gemeldet, nicht ungefragt
# nachgezogen (Entscheidung 2026-07-26, bestätigt 2026-08-01). Ausnahme sind die
# schmalen Hilfspakete mkcert/libnss3-tools/cron/zip, die ausschließlich dieser
# Installer braucht und die kein System nennenswert verändern.
do_packages() {
    step "Systempakete prüfen"
    local -a fehlt=()

    if command -v node &>/dev/null; then
        local major; major=$(node --version | sed 's/^v//' | cut -d. -f1)
        if [[ "$major" -lt 18 ]]; then
            fehlt+=("Node.js >= 18 (gefunden: $(node --version)): curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs")
        else c_ok "Node.js $(node --version)"; fi
    else
        fehlt+=("Node.js >= 18: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs")
    fi

    command -v npm &>/dev/null && c_ok "npm $(npm --version)" || fehlt+=("npm (kommt mit Node.js)")
    if command -v gcc &>/dev/null && command -v make &>/dev/null; then c_ok "build-essential"
    else fehlt+=("build-essential (für better-sqlite3): sudo apt-get install -y build-essential"); fi
    command -v sqlite3 &>/dev/null && c_ok "sqlite3-CLI" || fehlt+=("sqlite3 (Diagnose, kein Muss): sudo apt-get install -y sqlite3")

    if [[ ${#fehlt[@]} -gt 0 ]]; then
        c_err "Fehlende Pakete – bitte nachinstallieren und erneut starten:"
        for m in "${fehlt[@]}"; do echo "      $m" >&2; done
        [[ "$JSON_OUT" -eq 1 ]] && echo "{\"ok\":false,\"missing\":${#fehlt[@]}}"
        return 1
    fi

    # Hilfspakete nachziehen (eng begrenzt, siehe Kommentar oben)
    local -a hilf=()
    command -v mkcert     &>/dev/null || hilf+=(mkcert libnss3-tools)
    command -v crontab    &>/dev/null || hilf+=(cron)
    command -v zip        &>/dev/null || hilf+=(zip)
    command -v logrotate  &>/dev/null || hilf+=(logrotate)
    if [[ ${#hilf[@]} -gt 0 ]]; then
        say "  → Installiere Hilfspakete: ${hilf[*]}"
        apt-get update -qq && apt-get install -y -qq "${hilf[@]}"
        command -v crontab &>/dev/null && systemctl enable --now cron >/dev/null 2>&1 || true
    fi
    c_ok "Alle Voraussetzungen erfüllt."
    [[ "$JSON_OUT" -eq 1 ]] && echo '{"ok":true}'
    return 0
}

# ═════════════════════════════════════════════════════════════════════════════
# Systemnutzer + sudoers
# ═════════════════════════════════════════════════════════════════════════════
do_user() {
    step "Systemnutzer '$INSTALL_USER'"
    if id -u "$INSTALL_USER" &>/dev/null; then c_ok "existiert bereits."
    else useradd --system --create-home --shell /bin/bash "$INSTALL_USER"; c_ok "angelegt."; fi

    # forge-settings-daemon steuert die anderen Services über die Buttons im
    # Backend. Dafür braucht er systemctl — aber NICHT als root: eng geschnittene
    # NOPASSWD-Regel, keine Wildcards, nur diese Services × diese drei Aktionen.
    local tmp; tmp="$(mktemp)"
    {
        echo -n "Cmnd_Alias FORGE_SYSTEMCTL = "
        local first=1
        for s in "${SERVICES[@]}"; do
            for a in start stop restart; do
                [[ $first -eq 1 ]] || echo -n ", "
                echo -n "/usr/bin/systemctl $a $s"
                first=0
            done
        done
        echo
        echo "$INSTALL_USER ALL=(root) NOPASSWD: FORGE_SYSTEMCTL"
    } > "$tmp"
    # visudo -c VOR dem Scharfschalten: eine kaputte sudoers-Datei kann sudo
    # systemweit beschädigen, das darf nie ungeprüft passieren.
    if visudo -c -f "$tmp" >/dev/null 2>&1; then
        install -m 0440 -o root -g root "$tmp" "$SUDOERS_FILE"
        c_ok "sudoers-Regel gesetzt."
    else
        c_err "sudoers-Syntaxprüfung fehlgeschlagen – Regel NICHT gesetzt."
        visudo -c -f "$tmp" || true
    fi
    rm -f "$tmp"
}

# ═════════════════════════════════════════════════════════════════════════════
# Dateien deployen
# ═════════════════════════════════════════════════════════════════════════════
do_deploy() {
    step "Dateien nach $APP_DIR"
    [[ -f "$ARTIFACT_DIR/package.json" ]] || die "Muss aus dem entpackten FORGE.pub-Artefakt laufen (package.json fehlt in $ARTIFACT_DIR)."
    # 🔒 Kritischer Guard (Fund forge-pub2-Test, 2026-08-01): ARTIFACT_DIR wird
    # aus dem Pfad DIESES Scripts abgeleitet (siehe Konstanten oben). Wird
    # install/update aus $APP_DIR selbst gestartet (z.B. genau der in
    # GETTING-STARTED.txt empfohlene Aufruf "/opt/forge/app/bin/setup.sh install" als
    # naiver Reparaturversuch), ist ARTIFACT_DIR == APP_DIR — das folgende
    # 'rm -rf $APP_DIR' löscht dann die eigene Quelle, BEVOR kopiert wird.
    # cp/rsync verweigern den anschließenden Self-Copy zwar, aber da ist der
    # Schaden schon passiert (App-Code komplett weg, nur über ein älteres
    # forge-pub-current.tgz in BACKUP/ zu retten). Deshalb hart VORHER prüfen.
    if [[ "$(cd "$ARTIFACT_DIR" && pwd -P)" == "$(cd "$APP_DIR" 2>/dev/null && pwd -P)" ]]; then
        die "install/update muss aus dem frisch entpackten Artefakt laufen, nicht aus $APP_DIR selbst (würde die laufende Installation löschen). Artefakt neu entpacken und von dort aufrufen."
    fi
    ensure_dirs
    # NUR app/ wird ersetzt. data/, secrets/, log/ und BACKUP/ bleiben unberührt —
    # das ist der Kern der neuen Struktur, deshalb hier kein --exclude-Geflecht.
    rm -rf "${APP_DIR:?}"
    mkdir -p "$APP_DIR"
    if command -v rsync &>/dev/null; then rsync -a "$ARTIFACT_DIR/" "$APP_DIR/"
    else cp -a "$ARTIFACT_DIR/." "$APP_DIR/"; fi
    fix_ownership
    c_ok "Kopiert ($(du -sh "$APP_DIR" | cut -f1))."

    # Den installierten Codestand als forge-pub-current.tgz neben die
    # Zustands-Archive legen. Damit ist BACKUP/ selbsttragend: Code UND Zustand
    # an einem Ort, eine Wiederherstellung braucht nichts von außen.
    say "  → Lege Codestand als $(basename "$CURRENT_TGZ") ab ..."
    tar czf "$CURRENT_TGZ" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")" \
        --exclude=node_modules 2>/dev/null || tar czf "$CURRENT_TGZ" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
    chmod 600 "$CURRENT_TGZ"
    c_ok "$(basename "$CURRENT_TGZ") abgelegt ($(du -h "$CURRENT_TGZ" | cut -f1))."
}

do_npm() {
    step "Abhängigkeiten (npm install, parallel)"
    # node-gyp-Header-Cache einmal sequentiell vorwärmen: mehrere native Builds,
    # die den leeren Cache gleichzeitig befüllen, sind ein bekanntes Race.
    say "  → node-gyp-Header-Cache vorwärmen ..."
    sudo -u "$INSTALL_USER" bash -c "cd '$APP_DIR' && npx --yes node-gyp install" >/dev/null 2>&1 \
        && c_ok "vorgewärmt." || c_warn "Vorwärmen fehlgeschlagen (nicht fatal)."

    local logdir; logdir="$(mktemp -d)"
    declare -A pids
    for sub in "" bots/liquidity bots/lending bots/settings core/nexus core/premium core/wallet-monitor; do
        local dir="$APP_DIR${sub:+/$sub}" label="${sub:-.}"
        [[ -f "$dir/package.json" ]] || continue
        say "  → npm install: $label"
        # stdin auf /dev/null: Hintergrundjobs erben sonst dasselbe stdin wie das
        # Hauptscript und könnten Zeilen aus einer Eingabe-Pipeline stehlen.
        sudo -u "$INSTALL_USER" bash -c "cd '$dir' && npm install --silent" \
            < /dev/null > "$logdir/$(echo "$label" | tr '/' '_').log" 2>&1 &
        pids["$label"]=$!
    done
    # Erst ALLE abwarten, dann Fehler melden — sonst bleiben Hintergrundprozesse
    # verwaist und Folgeschritte laufen auf halbfertigen node_modules.
    local failed=0
    for label in "${!pids[@]}"; do
        if ! wait "${pids[$label]}"; then
            c_err "npm install fehlgeschlagen in $label:"
            cat "$logdir/$(echo "$label" | tr '/' '_').log" >&2
            failed=1
        fi
    done
    rm -rf "$logdir"
    [[ "$failed" -eq 0 ]] || die "Mindestens eine npm-Installation fehlgeschlagen."
    c_ok "Alle Abhängigkeiten installiert."
}

# ═════════════════════════════════════════════════════════════════════════════
# TLS
# ═════════════════════════════════════════════════════════════════════════════
# CAROOT wird FEST auf secrets/mkcert-ca gepinnt statt auf mkcerts User-Default
# ($HOME/.local/share/mkcert). Damit ist die Root-CA (a) unabhängig davon, welcher
# User das Script aufruft, und (b) Teil von secrets/ — sie überlebt jedes Update
# und jede Neuinstallation. Ginge sie verloren, müssten ALLE Clients im LAN das
# Zertifikat neu importieren (Root-Cause #3).
do_ssl() {
    step "TLS-Zertifikat"
    command -v mkcert &>/dev/null || die "mkcert fehlt – erst '$0 packages' ausführen."
    ensure_dirs
    export CAROOT="$CAROOT_DIR"

    local ip="$OPT_LAN_IP"
    if [[ -z "$ip" ]]; then
        local erkannt
        erkannt=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' || hostname -I | awk '{print $1}')
        # Diese Frage steckte früher unsichtbar in einem Unterskript und war die
        # Wurzel des Prompt-Versatzes vom 2026-07-31. Jetzt ein normaler Parameter.
        ask ip "  LAN-IP verwenden? [Enter = $erkannt | andere IP]: " "$erkannt"
    fi
    [[ -n "$ip" ]] || die "Keine LAN-IP ermittelbar – bitte --lan-ip <ip> angeben."

    say "  → Root-CA (CAROOT: $CAROOT) in den System-Trust-Store ..."
    mkcert -install >/dev/null 2>&1 || c_warn "mkcert -install meldete einen Fehler (Trust-Store ggf. unvollständig)."
    say "  → Zertifikat für $ip, localhost, 127.0.0.1 ..."
    mkcert -cert-file "$CERTS_DIR/cert.pem" -key-file "$CERTS_DIR/key.pem" \
           "$ip" localhost 127.0.0.1 >/dev/null 2>&1

    cp "$CAROOT/rootCA.pem" "$CERTS_DIR/rootCA.pem"
    # ZIP, weil Chrome/Edge .pem/.crt-Downloads blockieren, ZIPs aber nie.
    if command -v zip &>/dev/null; then
        cp "$CERTS_DIR/rootCA.pem" "$CERTS_DIR/FORGE-rootCA.crt"
        (cd "$CERTS_DIR" && zip -jq rootCA.zip FORGE-rootCA.crt && rm -f FORGE-rootCA.crt)
    fi
    chown -R "$INSTALL_USER:$INSTALL_USER" "$CERTS_DIR"
    chmod 600 "$CERTS_DIR/key.pem"
    c_ok "Zertifikat bereit ($CERTS_DIR)."
}

# ═════════════════════════════════════════════════════════════════════════════
# Konfiguration (.env)
# ═════════════════════════════════════════════════════════════════════════════
# Legt die .env am ZENTRALEN Ort an (local/env/), Vorlage kommt weiter aus dem
# Code-Baum. Eine bereits vorhandene .env wird nie überschrieben — sonst gingen
# bei einem Update alle vom Betreiber gepflegten Werte verloren.
env_from_example() {
    local dir="$1" ziel="$2"
    [[ -f "$ziel" || ! -f "$dir/.env.example" ]] || {
        cp "$dir/.env.example" "$ziel"
        chown "$INSTALL_USER:$INSTALL_USER" "$ziel"; chmod 600 "$ziel"
    }
}
set_env_var() {
    local file="$1" key="$2" value="$3"
    [[ -f "$file" ]] || { touch "$file"; chown "$INSTALL_USER:$INSTALL_USER" "$file"; chmod 600 "$file"; }
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        sed -i "s#^${key}=.*#${key}=${value}#" "$file"
    else
        echo "${key}=${value}" >> "$file"
    fi
}

do_config() {
    step "Konfiguration (.env)"
    # 🔒 API-Keys sind Vorbedingung, nicht überspringbar: ohne sie startet der
    # Nexus zwar, aber jeder RPC-/Quote-Aufruf scheitert — der Bot liefe blind.
    if [[ -z "$OPT_JUPITER_KEY" ]]; then
        say ""
        say "  API-Keys (Pflicht – ohne sie ist die Installation nicht funktionsfähig):"
        ask OPT_JUPITER_KEY "    Jupiter API Key (https://portal.jup.ag): "
    fi
    [[ -n "$OPT_JUPITER_KEY" ]] || die "Jupiter API Key ist Pflicht (--jupiter-key <key>)."
    [[ -n "$OPT_HELIUS_KEY" ]] || ask OPT_HELIUS_KEY "    Helius API Key (https://helius.dev): "
    [[ -n "$OPT_HELIUS_KEY" ]] || die "Helius API Key ist Pflicht (--helius-key <key>)."
    [[ -n "$OPT_TELEGRAM_TOKEN" ]] || ask OPT_TELEGRAM_TOKEN "    Telegram Bot Token (optional): " " "
    [[ -n "$OPT_TELEGRAM_CHAT"  ]] || ask OPT_TELEGRAM_CHAT  "    Telegram Chat ID (optional): " " "
    OPT_TELEGRAM_TOKEN="$(echo "$OPT_TELEGRAM_TOKEN" | xargs || true)"
    OPT_TELEGRAM_CHAT="$(echo "$OPT_TELEGRAM_CHAT" | xargs || true)"

    local nexus_env="$ENV_DIR/nexus.env"
    env_from_example "$APP_DIR/core/nexus" "$nexus_env"
    set_env_var "$nexus_env" JUPITER_API_KEY "$OPT_JUPITER_KEY"
    set_env_var "$nexus_env" HELIUS_API_KEY  "$OPT_HELIUS_KEY"
    [[ -n "$OPT_TELEGRAM_TOKEN" ]] && set_env_var "$nexus_env" TELEGRAM_BOT_TOKEN "$OPT_TELEGRAM_TOKEN"
    [[ -n "$OPT_TELEGRAM_CHAT"  ]] && set_env_var "$nexus_env" TELEGRAM_CHAT_ID   "$OPT_TELEGRAM_CHAT"

    env_from_example "$APP_DIR/bots/settings" "$ENV_DIR/settings.env"

    # HELIUS_WS_URL wird aus DERSELBEN Antwort für beide Bots gesetzt (Root-Cause
    # #6: früher zwei getrennte Stellen, ein Fix an einer reichte nicht).
    local ws="wss://mainnet.helius-rpc.com/?api-key=${OPT_HELIUS_KEY}"
    local liq="$ENV_DIR/liquidity.env" lend="$ENV_DIR/lending.env"
    env_from_example "$APP_DIR/bots/liquidity" "$liq"
    env_from_example "$APP_DIR/bots/lending"   "$lend"
    set_env_var "$liq"  KEYPAIR_PATH         "$SECRETS_DIR/liquidity-wallet.json"
    set_env_var "$liq"  RPC_URL              "http://localhost:3100/rpc"
    set_env_var "$liq"  HELIUS_WS_URL        "$ws"
    set_env_var "$lend" SOLANA_KEYPAIR_PATH  "$SECRETS_DIR/lending-wallet.json"
    set_env_var "$lend" SOLANA_RPC_URL       "http://localhost:3100/rpc"
    set_env_var "$lend" HELIUS_WS_URL        "$ws"
    for f in "$liq" "$lend"; do
        [[ -n "$OPT_TELEGRAM_TOKEN" ]] && set_env_var "$f" TELEGRAM_BOT_TOKEN "$OPT_TELEGRAM_TOKEN"
        [[ -n "$OPT_TELEGRAM_CHAT"  ]] && set_env_var "$f" TELEGRAM_CHAT_ID   "$OPT_TELEGRAM_CHAT"
    done

    local prem="$ENV_DIR/premium.env"
    env_from_example "$APP_DIR/core/premium" "$prem"
    set_env_var "$prem" PREMIUM_WALLET_PATH "$SECRETS_DIR/premium-wallet.json"
    set_env_var "$prem" NOSTR_SECRETS_DIR   "$SECRETS_DIR"
    set_env_var "$prem" NOSTR_IDENTITY      "$NOSTR_IDENTITY_NAME"

    chown "$INSTALL_USER:$INSTALL_USER" "$ENV_DIR"/*.env 2>/dev/null || true
    chmod 600 "$ENV_DIR"/*.env 2>/dev/null || true
    c_ok "Konfiguration geschrieben."
}

# ═════════════════════════════════════════════════════════════════════════════
# Wallets
# ═════════════════════════════════════════════════════════════════════════════
# NUR generieren oder aus secrets/ weiterverwenden — kein Rohschlüssel-Import
# mehr im Setup. Eigene Keys trägt der Betreiber im Backend nach (Settings).
# Das entfernt gleich zwei Altlasten: die Asymmetrie zwischen den drei Wallets
# (nur zwei prüften auf "existiert bereits") und die im Klartext sichtbare
# Private-Key-Eingabe im Terminal.
wallet_pubkey_of() {
    local keyfile="$1" pk=""
    pk=$(cd "$APP_DIR" && sudo -u "$INSTALL_USER" node --input-type=module -e "
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'fs';
const raw = readFileSync(process.argv[1], 'utf8').trim();
const bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
console.log(Keypair.fromSecretKey(bytes).publicKey.toBase58());
" "$keyfile" 2>/dev/null) || true
    [[ -n "$pk" ]] && echo "$pk"; return 0
}

wallet_generate() {
    # Ausschließlich die CSPRNG aus @solana/web3.js (Keypair.generate() →
    # crypto.randomBytes). Bewusst KEINE eigene Entropie-Beimischung: moderne
    # OS-CSPRNGs brauchen das nicht, selbstgebautes Mixing ist ein bekanntes
    # Fehlerfeld (Debian-OpenSSL 2008). Der Private Key verlässt node nie —
    # nur der öffentliche Key geht über stdout zurück.
    local keyfile="$1" pk=""
    pk=$(cd "$APP_DIR" && sudo -u "$INSTALL_USER" node --input-type=module -e "
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { writeFileSync } from 'fs';
const kp = Keypair.generate();
writeFileSync(process.argv[1], bs58.encode(kp.secretKey), 'utf8');
console.log(kp.publicKey.toBase58());
" "$keyfile" 2>/dev/null) || true
    if [[ -n "$pk" ]]; then chmod 600 "$keyfile"; chown "$INSTALL_USER:$INSTALL_USER" "$keyfile"; echo "$pk"; fi
    return 0
}

wallet_announce() {
    local keyfile="$1" pk="$2" label="$3"
    say ""
    c_ok "Neues $label erzeugt: $pk"
    c_warn "WICHTIG – jetzt sichern, wird nur DIESES eine Mal angezeigt:"
    say ""
    say "    $(cat "$keyfile")"
    say ""
    c_warn "Ohne eigenes Backup ist ein hier liegendes Guthaben bei Datenverlust weg."
    # '|| true': ein reines Bestätigungs-Enter darf den Lauf NIE abbrechen —
    # bei erschöpftem stdin (automatisierter Lauf) liefert read EOF.
    [[ "$INTERACTIVE" -eq 1 ]] && { read -r -p "  Gesichert? Weiter mit Enter … " || true; }
    return 0
}

# Trägt eine Adresse in die Balance-Überwachung ein (SOL-Low-Alerts laufen
# dadurch ohne eigenen Code mit). Additiv + idempotent: ein 'cfg.wallets = [...]'
# würde die zuvor eingetragenen Wallets still überschreiben.
wallet_monitor_add() {
    local id="$1" label="$2" addr="$3"
    sudo -u "$INSTALL_USER" env WM_ID="$id" WM_LABEL="$label" WM_ADDR="$addr" \
        WM_CONFIG="$APP_DIR/core/wallet-monitor/config.json" \
        node --input-type=module -e '
import { readFileSync, writeFileSync } from "fs";
const p = process.env.WM_CONFIG;
const cfg = JSON.parse(readFileSync(p, "utf8"));
cfg.wallets = (cfg.wallets ?? []).filter(w => w.id !== process.env.WM_ID);
cfg.wallets.push({ id: process.env.WM_ID, label: process.env.WM_LABEL, address: process.env.WM_ADDR });
writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' 2>/dev/null || c_warn "Wallet-Monitor-Eintrag für '$id' fehlgeschlagen."
}

# Zentrales Adressbuch (settings.db → shared_addresses). DAS ist der Ort, an dem
# die Adresse im "Guthaben senden"-Dropdown auftaucht. Eigenständig von der
# Balance-Überwachung — unterschiedliche Zwecke, unterschiedliche Speicherorte.
addressbook_add() {
    local name="$1" addr="$2"
    # Muss innerhalb von bots/settings liegen, NICHT unter $SECRETS_DIR: Node
    # löst den bare specifier 'better-sqlite3' beim ESM-Import relativ zum
    # Pfad der Skriptdatei auf (node_modules-Walk ab dortigem Verzeichnis),
    # nicht relativ zum cwd. Unter $SECRETS_DIR gibt es keinen node_modules-
    # Baum, das cd unten hat darauf keinen Einfluss (Fund forge-pub2-Test).
    local script="$APP_DIR/bots/settings/.addressbook-$$.mjs"
    cat > "$script" <<'JSEOF'
import Database from 'better-sqlite3';
const db = new Database(process.env.SETTINGS_DB);
db.exec(`CREATE TABLE IF NOT EXISTS shared_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, address TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
const addr = process.env.ADDR, name = process.env.NAME;
const exists = db.prepare('SELECT 1 FROM shared_addresses WHERE address = ?').get(addr);
if (!exists) db.prepare('INSERT INTO shared_addresses (name, address) VALUES (?, ?)').run(name, addr);
db.close();
JSEOF
    chown "$INSTALL_USER:$INSTALL_USER" "$script"
    (cd "$APP_DIR/bots/settings" && sudo -u "$INSTALL_USER" env \
        NAME="$name" ADDR="$addr" SETTINGS_DB="$DATA_DIR/settings.db" node "$script") \
        && c_ok "Adressbuch: '$name' eingetragen." \
        || c_warn "Adressbuch-Eintrag für '$name' fehlgeschlagen."
    rm -f "$script"
}

# Die Wallet-Adressen liegen in core/wallet-monitor/config.json — also INNERHALB
# von app/ und damit im Löschbereich jedes Updates. Statt die Datei zu sichern und
# zurückzulegen, wird sie aus den vorhandenen Wallets neu erzeugt: das ist die
# gleiche Idee wie beim .env-Umzug, nur dass hier gar kein Aufbewahrungsort nötig
# ist, weil die Quelle (secrets/) das Update ohnehin überlebt.
rebuild_wallet_monitor() {
    local -A monitor=([liquidity]="Liquidity" [lending]="Lending" [premium]="Premium Service")
    local -A datei=([liquidity]="liquidity-wallet.json" [lending]="lending-wallet.json" [premium]="premium-wallet.json")
    for w in liquidity lending premium; do
        local kf="$SECRETS_DIR/${datei[$w]}" pk=""
        [[ -f "$kf" ]] || continue
        pk=$(wallet_pubkey_of "$kf")
        [[ -n "$pk" ]] && wallet_monitor_add "$w" "${monitor[$w]}" "$pk"
    done
}

WALLET_PUBKEYS=()
do_wallets() {
    step "Wallets"
    ensure_dirs
    local -A meta=(
        [liquidity]="Liquidity Bot|liquidity-wallet.json|Liquidity"
        [lending]="Lending Bot|lending-wallet.json|Lending"
        [premium]="Premium Service|premium-wallet.json|Premium Service"
    )
    IFS=',' read -ra gewuenscht <<< "$OPT_WALLETS"
    for w in "${gewuenscht[@]}"; do
        w="$(echo "$w" | xargs)"
        [[ -n "${meta[$w]:-}" ]] || { c_warn "Unbekanntes Wallet '$w' – übersprungen."; continue; }
        IFS='|' read -r label datei monitor <<< "${meta[$w]}"
        local keyfile="$SECRETS_DIR/$datei" pk=""

        if [[ -f "$keyfile" ]]; then
            # Bestehendes Wallet IMMER weiterverwenden — ein neuer Key würde ein
            # dort liegendes Guthaben unwiederbringlich abtrennen. Gilt jetzt für
            # alle drei Wallets gleich (früher nur für zwei).
            pk=$(wallet_pubkey_of "$keyfile")
            [[ -n "$pk" ]] && c_ok "$label: bestehendes Wallet weiterverwendet ($pk)" \
                           || c_err "$label: vorhandene Datei nicht lesbar – bitte prüfen: $keyfile"
        else
            pk=$(wallet_generate "$keyfile")
            [[ -n "$pk" ]] && wallet_announce "$keyfile" "$pk" "$label-Wallet" \
                           || c_err "$label: Wallet-Erzeugung fehlgeschlagen."
        fi

        if [[ -n "$pk" ]]; then
            WALLET_PUBKEYS+=("$w=$pk")
            wallet_monitor_add "$w" "$monitor" "$pk"
            addressbook_add "$monitor" "$pk"
        fi
    done
}

# ═════════════════════════════════════════════════════════════════════════════
# Nostr
# ═════════════════════════════════════════════════════════════════════════════
# Nur erzeugen oder eine vorhandene Identität weiterverwenden — kein freier
# Import. Eine bestehende Identität wird NIE überschrieben: ein neuer Key würde
# alle laufenden Konversationen unwiederbringlich kappen.
do_nostr() {
    step "Nostr-Identität"
    ensure_dirs
    local keyfile="$SECRETS_DIR/${NOSTR_IDENTITY_NAME}.json"
    if [[ -f "$keyfile" ]]; then
        c_ok "Bestehende Identität weiterverwendet (Anzeigename ebenfalls unverändert)."
        return 0
    fi
    [[ -n "$OPT_NOSTR_ALIAS" ]] || ask OPT_NOSTR_ALIAS "  Anzeigename (Enter = \"FORGE Public User\"): " "FORGE Public User"
    local npub
    npub=$(cd "$APP_DIR" && sudo -u "$INSTALL_USER" env \
        NOSTR_SECRETS_DIR="$SECRETS_DIR" ALIAS="$OPT_NOSTR_ALIAS" IDNAME="$NOSTR_IDENTITY_NAME" \
        node --input-type=module -e "
import { createIdentity } from '$APP_DIR/lib/nostr-client.js';
console.log(createIdentity(process.env.IDNAME, { alias: process.env.ALIAS }).npub);
" 2>/dev/null) || true
    if [[ -n "$npub" ]]; then c_ok "Nostr-Identität erzeugt: $npub"
    else c_err "Nostr-Identität konnte nicht erzeugt werden – später über Settings → Message Center nachholbar."; fi
}

# ═════════════════════════════════════════════════════════════════════════════
# Services, Start/Stop-Scripte, Cron
# ═════════════════════════════════════════════════════════════════════════════
do_services() {
    step "systemd-Units + Start/Stop-Scripte"
    for u in core/forge-nexus.service core/forge-premium.service \
             bots/liquidity/forge-liquiditybot.service bots/lending/forge-lendingbot.service \
             bots/settings/forge-settings.service bots/settings/forge-settings-daemon.service; do
        [[ -f "$APP_DIR/$u" ]] && cp "$APP_DIR/$u" "/etc/systemd/system/$(basename "$u")"
    done
    systemctl daemon-reload
    systemctl enable forge-nexus forge-premium forge-settings forge-settings-daemon >/dev/null 2>&1 || true
    c_ok "Units deployed + aktiviert."

    # Start/Stop-Wrapper: der Betreiber soll die Bots steuern können, ohne sich
    # sechs systemd-Unit-Namen merken zu müssen.
    cat > "$BASE_DIR/start.sh" <<EOF
#!/bin/bash
# FORGE.pub – alle Dienste starten (vom Setup erzeugt)
set -e
systemctl start ${SERVICES[*]}
systemctl --no-pager --plain status ${SERVICES[*]} | grep -E 'Loaded|Active|●' || true
EOF
    cat > "$BASE_DIR/stop.sh" <<EOF
#!/bin/bash
# FORGE.pub – alle Dienste stoppen (vom Setup erzeugt)
set -e
systemctl stop ${SERVICES[*]}
EOF
    chmod 755 "$BASE_DIR/start.sh" "$BASE_DIR/stop.sh"
    c_ok "start.sh / stop.sh angelegt."
}

do_cron() {
    step "Cron"
    command -v crontab &>/dev/null || { c_warn "crontab fehlt – Cron übersprungen."; return 0; }
    # FORGE_ENV_DIR muss hier explizit gesetzt werden: config/paths.js envFile()
    # entscheidet Master- vs. Fork-.env-Pfad darüber, cron vererbt aber (anders als
    # die systemd-Units, die ihre eigene EnvironmentFile= laden) keinerlei Umgebung.
    # Ohne diese Zeile fand z.B. premium-pay.js sein eigenes Wallet nicht mehr,
    # obwohl es unter local/env/premium.env korrekt konfiguriert war (Vorfall
    # 2026-08-01, "Score-Daten veraltet" auf forge-pub1).
    local env_line="FORGE_ENV_DIR=$ENV_DIR"
    local line="* * * * * cd $APP_DIR && /usr/bin/node bin/forge-cron.js >> $LOG_DIR/cron/forge-cron-wrapper.log 2>&1"
    # '|| true' NACH der Pipeline: 'crontab -l' schlägt bei noch leerer Crontab
    # fehl, 'grep -v' auf leerem Input ebenfalls — unter set -e würde das die
    # Subshell killen, BEVOR die neue Zeile je geschrieben wird.
    ( sudo -u "$INSTALL_USER" crontab -l 2>/dev/null | grep -v 'bin/forge-cron.js' | grep -v '^FORGE_ENV_DIR=' || true; echo "$env_line"; echo "$line" ) \
        | sudo -u "$INSTALL_USER" crontab -
    c_ok "Cron eingerichtet (bin/forge-cron.js, minütlich)."
}

do_logrotate() {
    step "Logrotate"
    local src="$APP_DIR/logrotate.d/forge-pub"
    if [[ ! -f "$src" ]]; then
        c_warn "logrotate.d/forge-pub fehlt im Artefakt – Logrotation übersprungen."
        return 0
    fi
    command -v logrotate &>/dev/null || { c_warn "logrotate fehlt – Logdateien werden NICHT rotiert (Festplatte kann volllaufen)."; return 0; }
    cp "$src" /etc/logrotate.d/forge-pub
    c_ok "Logrotate eingerichtet (/etc/logrotate.d/forge-pub, täglich, 14 Tage)."
}

do_start() {
    step "Dienste starten"
    systemctl restart forge-nexus; sleep 3
    systemctl restart forge-premium; sleep 2
    systemctl restart forge-settings forge-settings-daemon; sleep 2
    # Liquidity Bot + Lending Bot bleiben bei einer NEUINSTALLATION bewusst
    # deaktiviert (Entscheidung 2026-08-02, Anlass: leeres Wallet auf
    # forge-pub2 führte sofort in einen Crash-Restart-Loop). Der Nutzer aktiviert
    # sie gezielt selbst, sobald das Wallet befüllt ist (siehe GETTING-STARTED.txt).
    # Gilt NUR hier (do_start läuft ausschließlich aus do_install) — ein
    # 'update' fasst den Aktivierungszustand bestehender Installationen
    # bewusst nicht an (siehe do_update, eigener Start-Block dort).
    c_ok "Liquidity Bot + Lending Bot bleiben deaktiviert (Standard bei Neuinstallation, siehe GETTING-STARTED.txt)."
    sleep 2
    do_status
}

do_status() {
    local json="{" first=1
    say ""
    say "  Status:"
    for s in "${SERVICES[@]}"; do
        local st; st=$(systemctl is-active "$s" 2>/dev/null) || true
        [[ -z "$st" ]] && st="unbekannt"
        [[ "$st" == "active" ]] && c_ok "$s: $st" || c_warn "$s: $st"
        [[ $first -eq 1 ]] || json+=","
        json+="\"$s\":\"$st\""; first=0
    done
    json+="}"
    [[ "$JSON_OUT" -eq 1 ]] && echo "$json"
    return 0
}

# ═════════════════════════════════════════════════════════════════════════════
# Update
# ═════════════════════════════════════════════════════════════════════════════
# Vor JEDEM Update ein Pflicht-Backup — nicht abwählbar.
# Das automatische Update (Signatur-/Manifest-Prüfung) ist bewusst noch nicht
# gebaut: es setzt das öffentliche Repo und den Signaturschlüssel voraus
# (siehe update.md, Phase 4). Bis dahin bleibt hier ein
# ehrlicher Platzhalter statt einer Attrappe, die Sicherheit vortäuscht.
do_update() {
    step "Update"
    guard_legacy update
    if [[ ! -d "$APP_DIR" ]]; then die "Keine Installation unter $APP_DIR gefunden."; fi
    local aktuell="unbekannt"
    [[ -f "$APP_DIR/VERSION" ]] && aktuell=$(cat "$APP_DIR/VERSION")
    say "  Installierte Version: $aktuell"

    if [[ -f "$ARTIFACT_DIR/VERSION" ]] && [[ "$ARTIFACT_DIR" != "$APP_DIR" ]]; then
        say "  Version im Artefakt:  $(cat "$ARTIFACT_DIR/VERSION")"
        confirm "Dieses Artefakt jetzt installieren? (Backup läuft vorher automatisch)" || {
            say "  Abgebrochen."; return 0; }
        do_backup
        # Codestand VOR dem Überschreiben durch do_deploy archivieren (Rollback-
        # Grundlage, siehe archive_current_code oben) — muss vor dem rm -rf in
        # do_deploy passieren, sonst gibt es nichts mehr zu archivieren.
        archive_current_code
        systemctl stop "${SERVICES[@]}" 2>/dev/null || true
        do_deploy
        # Bootstrap für Installationen, die VOR dem Trust-Anchor-Feature entstanden
        # sind (z.B. forge-pub1/pub2, Stand 01.08.) — do_trust_anchor() ist idempotent
        # (schreibt nie über einen vorhandenen Anchor), deshalb hier gefahrlos auch
        # bei jedem Update aufrufbar, nicht nur bei der Erstinstallation.
        do_trust_anchor
        do_npm
        # .env liegt in local/env/ und ist vom Wipe gar nicht betroffen — hier
        # muss also nichts gerettet werden. Nur die Wallet-Monitor-Config lag in
        # app/ und wird neu erzeugt.
        rebuild_wallet_monitor
        do_services
        do_cron
        do_logrotate
        # Alle 6 Dienste neu starten, nicht nur die 4 Kern-Services (Entscheidung
        # 2026-08-01: die Bots sollen nach einem Update automatisch weiterlaufen).
        # Vorher blieben forge-liquiditybot/forge-lendingbot nach einem Update
        # ungestartet, obwohl systemctl stop davor alle 6 stoppt (Asymmetrie,
        # Fund forge-pub2-Test). Bewusst gestaffelt: der RPC-Proxy (Nexus) muss
        # stehen, bevor die Bots ihn ansprechen.
        systemctl start forge-nexus forge-premium forge-settings forge-settings-daemon 2>/dev/null || true
        sleep 3
        systemctl start forge-liquiditybot forge-lendingbot 2>/dev/null || true
        c_ok "Update eingespielt."
        do_status
    else
        c_warn "Kein neues Artefakt gefunden (dieses Script läuft aus der Installation selbst)."
        say "      Automatischer Update-Abruf ist noch nicht verfügbar – er braucht das"
        say "      öffentliche Repo samt Signaturprüfung (geplant, siehe Projektdoku)."
        say "      Bis dahin: neues Artefakt entpacken und dort '$0 update' aufrufen."
    fi
}

# ═════════════════════════════════════════════════════════════════════════════
# Deinstallation
# ═════════════════════════════════════════════════════════════════════════════
do_uninstall() {
    step "Deinstallation"
    # Pflicht-Backup zuerst — auch beim Entfernen. Es liegt in BACKUP/ und damit
    # außerhalb dessen, was gleich gelöscht wird.
    do_backup

    say "  → Services stoppen + deaktivieren ..."
    systemctl stop "${SERVICES[@]}" 2>/dev/null || true
    systemctl disable "${SERVICES[@]}" 2>/dev/null || true
    for s in "${SERVICES[@]}"; do rm -f "/etc/systemd/system/$s.service"; done
    systemctl daemon-reload
    rm -f "$SUDOERS_FILE"
    if id -u "$INSTALL_USER" &>/dev/null; then
        ( sudo -u "$INSTALL_USER" crontab -l 2>/dev/null | grep -v 'bin/forge-cron.js' || true ) \
            | sudo -u "$INSTALL_USER" crontab - 2>/dev/null || true
    fi
    rm -f "$BASE_DIR/start.sh" "$BASE_DIR/stop.sh"
    c_ok "Services, Units, sudoers-Regel, Cron entfernt."

    say ""
    c_warn "$SECRETS_DIR enthält Wallet-Keys und die Nostr-Identität, $ENV_DIR die API-Keys."
    # 🔒 Klarstellung (2026-08-01): "uninstall --keep-data" muss NUR die
    # relevanten Daten stehen lassen (data/env/secrets) — der App-Code UND der
    # Systemnutzer gehören zu "deinstalliert", nicht zu "Daten". Vorher ließ
    # --keep-data den kompletten Block inkl. app/ + Nutzer unangetastet, wodurch
    # "uninstall --keep-data" faktisch nichts weiter als "Dienste entfernen" war.
    if [[ "$OPT_KEEP_DATA" -eq 1 ]]; then
        rm -rf "${APP_DIR:?}"
        id -u "$INSTALL_USER" &>/dev/null && { userdel -r "$INSTALL_USER" 2>/dev/null || userdel "$INSTALL_USER" 2>/dev/null || true; }
        c_ok "App-Code + Nutzer '$INSTALL_USER' entfernt. Daten, .env und Keys bleiben erhalten (--keep-data)."
    elif confirm "$APP_DIR, $DATA_DIR, $ENV_DIR, $SECRETS_DIR und Nutzer '$INSTALL_USER' löschen?"; then
        c_warn "Ein Backup liegt in $BACKUP_DIR – das Löschen hier ist am Server endgültig."
        rm -rf "${APP_DIR:?}" "${DATA_DIR:?}" "${ENV_DIR:?}" "${SECRETS_DIR:?}"
        id -u "$INSTALL_USER" &>/dev/null && { userdel -r "$INSTALL_USER" 2>/dev/null || userdel "$INSTALL_USER" 2>/dev/null || true; }
        c_ok "Entfernt. $BACKUP_DIR und $LOG_DIR bleiben bewusst erhalten."
    else
        c_warn "Nichts weiter gelöscht (nur Dienste entfernt) – App-Code, Daten, Keys und Nutzer bleiben erhalten."
    fi
}

# ═════════════════════════════════════════════════════════════════════════════
# GETTING-STARTED.txt
# ═════════════════════════════════════════════════════════════════════════════
# Bewusst kurz: die vollständige Anleitung ist ein eigenes Dokument. Hier steht
# nur, was man unmittelbar nach der Installation braucht.
write_getting_started() {
    local ip="${OPT_LAN_IP:-$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' || hostname -I | awk '{print $1}')}"
    local version="unbekannt"; [[ -f "$APP_DIR/VERSION" ]] && version=$(cat "$APP_DIR/VERSION")
    {
        echo "═══════════════════════════════════════════════════════════"
        echo "  FORGE.pub – Installation abgeschlossen"
        echo "  $(date '+%Y-%m-%d %H:%M %Z')"
        echo "  Version: $version"
        echo "═══════════════════════════════════════════════════════════"
        echo
        echo "── Zugang (nur im LAN erreichbar) ─────────────────────────"
        echo "  Dashboard:        https://${ip}:3200/forge/"
        echo "  Settings/Backend: https://${ip}:3200/"
        echo
        echo "── TLS-Zertifikat aktivieren ──────────────────────────────"
        echo "  Der Browser warnt beim ersten Aufruf. Grund: die Verbindung ist"
        echo "  verschlüsselt, aber mit einer selbst erzeugten Zertifizierungs-"
        echo "  stelle. Einmalig pro Gerät importieren, dann ist Ruhe:"
        echo
        echo "    1. https://${ip}:3200/ aufrufen (Warnung zunächst bestätigen)"
        echo "    2. Auf der Login-Seite 'Root-CA herunterladen' klicken"
        echo "    3. Importieren:"
        echo "       Windows: Datei öffnen → Zertifikat installieren →"
        echo "                Lokaler Computer → Vertrauenswürdige Stammzertifizierungsstellen"
        echo "       macOS:   sudo security add-trusted-cert -d -r trustRoot \\"
        echo "                  -k /Library/Keychains/System.keychain rootCA.pem"
        echo "       Linux:   sudo cp rootCA.pem /usr/local/share/ca-certificates/forge-ca.crt"
        echo "                sudo update-ca-certificates"
        echo "       Firefox: Einstellungen → Datenschutz → Zertifikate →"
        echo "                Zertifizierungsstellen → Importieren"
        echo
        echo "── Wichtige Verzeichnisse ─────────────────────────────────"
        echo "  Programm:     $APP_DIR"
        echo "                (wird bei jedem Update komplett ersetzt)"
        echo "  Ihre Daten:   $LOCAL_DIR"
        echo "                ./data     Datenbanken"
        echo "                ./env      Konfiguration und API-Keys"
        echo "                ./secrets  🔑 Wallet-Keys, Nostr-Identität, TLS"
        echo "                (bleibt bei Updates unangetastet)"
        echo "  Logs:         $LOG_DIR"
        echo "  Backups:      $BACKUP_DIR"
        echo "                (letzte $BACKUP_RETENTION, vor jedem Update automatisch,"
        echo "                 samt passendem Programmstand als forge-pub-current.tgz)"
        echo
        echo "  Die Wallet-Keys liegen NUR in $SECRETS_DIR."
        echo "  Ohne eigenes Backup ist ein Guthaben bei Datenverlust verloren."
        echo
        echo "── Liquidity Bot + Lending Bot: standardmäßig deaktiviert ──"
        echo "  Beide Bots sind nach einer Neuinstallation bewusst NICHT aktiv."
        echo "  Erst Wallet befüllen (Adresse siehe oben/Nachricht bei der Wallet-"
        echo "  Erzeugung), dann gezielt aktivieren:"
        echo
        echo "    sudo systemctl enable --now forge-liquiditybot"
        echo "    sudo systemctl enable --now forge-lendingbot"
        echo
        echo "  Alternativ im Backend (https://${ip}:3200/) über die Bot-Steuerung"
        echo "  starten – dort dann zusätzlich 'sudo systemctl enable forge-<bot>'"
        echo "  ausführen, damit der Bot auch einen Server-Neustart übersteht."
        echo
        echo "── Steuerung ──────────────────────────────────────────────"
        echo "  Starten:  $BASE_DIR/start.sh"
        echo "  Stoppen:  $BASE_DIR/stop.sh"
        echo "  Status:   $APP_DIR/bin/setup.sh status"
        echo "  Backup:   $APP_DIR/bin/setup.sh backup"
        echo "═══════════════════════════════════════════════════════════"
    } > "$GETTING_STARTED"
    chmod 644 "$GETTING_STARTED"
}

# ═════════════════════════════════════════════════════════════════════════════
# Vollinstallation
# ═════════════════════════════════════════════════════════════════════════════
do_install() {
    guard_legacy install
    say "═══════════════════════════════════════════════════════════"
    say "  FORGE.pub – Setup"
    say "  Quelle: $ARTIFACT_DIR"
    say "  Ziel:   $BASE_DIR"
    say "═══════════════════════════════════════════════════════════"

    if [[ -d "$APP_DIR" ]] && [[ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
        c_warn "Es existiert bereits eine Installation unter $APP_DIR."
        say "  Ein Backup wird automatisch erstellt. Daten ($DATA_DIR) und Keys"
        say "  ($SECRETS_DIR) bleiben dabei unangetastet — es wird nur app/ ersetzt."
        confirm "Fortfahren?" || { say "  Abgebrochen."; exit 0; }
        do_backup
    fi

    do_packages
    do_user
    do_deploy
    do_trust_anchor
    do_npm
    do_ssl
    do_config
    do_wallets
    do_nostr
    do_services
    do_cron
    do_logrotate
    fix_ownership
    do_start
    write_getting_started

    say ""
    say "═══════════════════════════════════════════════════════════"
    c_ok "Installation abgeschlossen."
    say "  Hinweise: $GETTING_STARTED"
    say "  Logdatei: $LOG_FILE"
    say "═══════════════════════════════════════════════════════════"
    [[ "$QUIET" -eq 0 ]] && cat "$GETTING_STARTED"
    return 0
}

# ═════════════════════════════════════════════════════════════════════════════
# Hilfe + Argumente
# ═════════════════════════════════════════════════════════════════════════════
show_help() {
cat <<EOF
FORGE.pub – Setup

  $0 <befehl> [optionen]

Befehle:
  install      Vollinstallation (Default, wenn nichts angegeben)
  update       Neues Artefakt einspielen (Backup läuft vorher automatisch)
  rollback-code  NUR den Code auf eine ältere archivierte Version zurücksetzen
                 (local/ bleibt unangetastet — kein Daten-/Key-Rollback)
  uninstall    Dienste entfernen, optional auch Daten und Keys
  packages     Systemvoraussetzungen prüfen
  ssl          TLS-Zertifikat neu erzeugen
  wallet       Wallets anlegen bzw. bestehende weiterverwenden
  nostr        Nostr-Identität anlegen bzw. bestehende weiterverwenden
  services     systemd-Units + start.sh/stop.sh neu schreiben
  cron         Cron-Eintrag setzen
  logrotate    /etc/logrotate.d/forge-pub (neu) installieren
  backup       Backup erstellen (app + secrets + data)
  restore      Backup zurückspielen
  status       Zustand der Dienste anzeigen
  help         Diese Hilfe

Optionen:
  --non-interactive     Keine Rückfragen; fehlende Pflichtwerte brechen ab
  --yes                 Rückfragen automatisch bejahen
  --quiet               Nur Fehler ausgeben
  --json                Maschinenlesbare Ausgabe (backup/status)
  --log-file <pfad>     Abweichender Pfad für das Setup-Log

  --jupiter-key <key>   Jupiter API Key   (Pflicht bei install)
  --helius-key <key>    Helius API Key    (Pflicht bei install)
  --telegram-token <t>  Telegram Bot Token (optional)
  --telegram-chat <id>  Telegram Chat ID   (optional)
  --lan-ip <ip>         LAN-IP für das TLS-Zertifikat
  --nostr-alias <name>  Anzeigename der Nostr-Identität
  --wallets <liste>     Welche Wallets (Default: liquidity,lending,premium)
  --from <datei>        Backup-Datei für restore
  --keep-data           Bei uninstall Daten und Keys behalten
  --to-version <n>      Ziel-VersionCode für rollback-code (Default: neueste archivierte)

Beispiele:
  sudo $0 install --jupiter-key JUP... --helius-key HEL... --lan-ip 203.0.113.50 \\
       --non-interactive --yes
  sudo $0 backup --json          # für Cron
  sudo $0 status --json

Verzeichnisse:
  $APP_DIR          Programm (wird bei Updates ersetzt)
  $LOCAL_DIR        alles Instanzspezifische – DAS ist der Backup-Umfang
    ./data          Datenbanken
    ./env           .env-Dateien (0700)
    ./secrets       Wallet-Keys, Nostr, TLS (0700)
  $LOG_DIR          Logs (bewusst nicht im Backup)
  $BACKUP_DIR       Zustands-Archive (letzte $BACKUP_RETENTION) + forge-pub-current.tgz
    ./versions      Code-Archive je VersionCode (letzte $VERSIONS_RETENTION), Rollback-Grundlage
EOF
}

CMD="${1:-install}"
[[ $# -gt 0 ]] && shift || true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --non-interactive) INTERACTIVE=0 ;;
        --yes|-y)          ASSUME_YES=1 ;;
        --quiet|-q)        QUIET=1 ;;
        # --json ist für Cron/Skript-Konsumenten gedacht (siehe Hilfetext:
        # "backup --json # für Cron") — impliziert deshalb --quiet, sonst
        # steht die JSON-Zeile hinter Klartext-Zeilen und jeder stdout-Parser
        # bricht (Fund forge-pub2-Test: status/backup gaben beides aus).
        --json)            JSON_OUT=1; QUIET=1 ;;
        --log-file)        LOG_FILE="$2"; shift ;;
        --jupiter-key)     OPT_JUPITER_KEY="$2"; shift ;;
        --helius-key)      OPT_HELIUS_KEY="$2"; shift ;;
        --telegram-token)  OPT_TELEGRAM_TOKEN="$2"; shift ;;
        --telegram-chat)   OPT_TELEGRAM_CHAT="$2"; shift ;;
        --lan-ip)          OPT_LAN_IP="$2"; shift ;;
        --nostr-alias)     OPT_NOSTR_ALIAS="$2"; shift ;;
        --wallets)         OPT_WALLETS="$2"; shift ;;
        --from)            OPT_RESTORE_FROM="$2"; shift ;;
        --keep-data)       OPT_KEEP_DATA=1 ;;
        --to-version)      OPT_ROLLBACK_VERSION="$2"; shift ;;
        -h|--help)         show_help; exit 0 ;;
        *) die "Unbekannte Option: $1  (Hilfe: $0 help)" ;;
    esac
    shift
done

[[ "$CMD" == "help" ]] && { show_help; exit 0; }
require_root "$CMD"
init_log
_log "=== setup.sh $CMD (interaktiv=$INTERACTIVE) ==="

case "$CMD" in
    install)   do_install ;;
    update)    do_update ;;
    rollback-code) do_rollback_code ;;
    uninstall) do_uninstall ;;
    packages)  do_packages ;;
    ssl)       do_ssl ;;
    wallet|wallets) do_wallets ;;
    nostr)     do_nostr ;;
    services)  do_services ;;
    cron)      do_cron ;;
    logrotate) do_logrotate ;;
    backup)    do_backup ;;
    restore)   do_restore ;;
    status)    do_status ;;
    *)         die "Unbekannter Befehl: $CMD  (Hilfe: $0 help)" ;;
esac
