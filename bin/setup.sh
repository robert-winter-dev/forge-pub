#!/bin/bash
# ═════════════════════════════════════════════════════════════════════════════
# FORGE public – Setup
# ═════════════════════════════════════════════════════════════════════════════
# Nachfolger von bin/install.sh. Deckt den gesamten Lebenszyklus einer
# FORGE-public-Installation ab, nicht nur die Erstinstallation:
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
#   /opt/forge/BACKUP/local    Zustands-Archive (letzte 10, kein Codestand)
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
#
# ── Modul-Aufteilung + Zweisprachigkeit (2026-08-07) ─────────────────────────
# Diese Datei ist nur noch der Einstiegspunkt: Konstanten, Sourcing der Module
# unter setup-lib/, Argument-Parsing, Dispatch. Die eigentliche Logik lebt in
# setup-lib/*.sh (thematisch aufgeteilt — output.sh/common.sh/deploy.sh/
# packages.sh/wallets.sh/services.sh/lifecycle.sh/menu.sh/help.sh), Nachrichten
# in setup-lib/i18n-de.sh + i18n-en.sh (siehe t() in output.sh). Grund: eine
# 1400-Zeilen-Datei fiel in Code-Reviews des öffentlichen Repos negativ auf,
# und dieselbe Aufteilung machte die Übersetzung überhaupt erst handhabbar
# (jedes Modul einmal anfassen statt eine Datei mit wechselnder Sprache).
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
TRUST_DIR="$LOCAL_DIR/trust"
VERSIONS_DIR="$BACKUP_DIR/versions"

INSTALL_USER="forge"
SUDOERS_FILE="/etc/sudoers.d/forge-systemctl"
GETTING_STARTED="$BASE_DIR/GETTING-STARTED.txt"
# Wird direkt vor dem ersten "echten" Installationsschritt angelegt und erst
# nach vollständig erfolgreichem do_install() wieder gelöscht. Jeder Abbruch
# dazwischen lässt sie bewusst liegen — Erkennungsmerkmal für eine
# unvollständige Installation (Fund 2026-08-07: ein bei der Key-Eingabe
# abgebrochener Lauf sah beim nächsten 'install' wie eine echte, fertige
# Installation mit schützenswertem Kapital aus).
INSTALL_MARKER="$LOCAL_DIR/.install-in-progress"
BACKUP_RETENTION=10
VERSIONS_RETENTION=1
LOG_RETENTION=10

SERVICES=(forge-nexus forge-premium forge-settings forge-settings-daemon forge-liquiditybot forge-lendingbot)
NOSTR_IDENTITY_NAME="forge-pub-nostr"

# Unterprojekte mit eigener package.json ("" = App-Wurzel). EINE Quelle für
# do_npm() und das Retten von node_modules über den Deploy (do_deploy) – liefen
# die Listen auseinander, bliebe ein node_modules unbemerkt auf der Strecke.
NPM_SUBPROJECTS=("" bots/liquidity bots/lending bots/settings core/nexus core/premium core/wallet-monitor)

ARTIFACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Optionen (per CLI überschreibbar) ────────────────────────────────────────
INTERACTIVE=1
ASSUME_YES=0
QUIET=0
JSON_OUT=0
LOG_FILE=""
OPT_JUPITER_KEY=""
OPT_HELIUS_KEY=""
OPT_TIMEZONE=""
OPT_LAN_IP=""
OPT_NOSTR_ALIAS=""
OPT_RESTORE_FROM=""
OPT_WALLETS="liquidity,lending,premium"
OPT_KEEP_DATA=0
OPT_ROLLBACK_VERSION=""
# --renew-deps: node_modules verwerfen und komplett neu installieren. Normalfall
# ist die Wiederverwendung (siehe do_deploy/do_npm) – dieser Schalter ist die
# Notbremse für einen kaputten oder verdächtigen Abhängigkeitsbaum.
OPT_RENEW_DEPS=0

# ── Module laden ─────────────────────────────────────────────────────────────
# setup-lib/ liegt immer als Geschwisterverzeichnis neben dieser Datei — egal
# ob im Artefakt (bin/setup-lib/) oder als Komfort-Kopie unter $BASE_DIR (siehe
# do_services in services.sh, die setup-lib/ dorthin mitkopiert).
SETUP_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup-lib"
# shellcheck source=setup-lib/output.sh
source "$SETUP_LIB/output.sh"
# shellcheck source=setup-lib/common.sh
source "$SETUP_LIB/common.sh"
# Netz für deploy_lock_acquire() (common.sh): egal ob der Lauf normal endet
# oder über die() abbricht, die Lock-Datei darf nie hängen bleiben – sonst
# würde forge-cron.js nach einem gescheiterten Update dauerhaft alle Jobs
# überspringen. deploy_lock_release() ist ein no-op, wenn nie gelockt wurde.
trap 'deploy_lock_release; update_notify_suppress_off' EXIT
# shellcheck source=setup-lib/deploy.sh
source "$SETUP_LIB/deploy.sh"
# shellcheck source=setup-lib/packages.sh
source "$SETUP_LIB/packages.sh"
# shellcheck source=setup-lib/wallets.sh
source "$SETUP_LIB/wallets.sh"
# shellcheck source=setup-lib/services.sh
source "$SETUP_LIB/services.sh"
# shellcheck source=setup-lib/lifecycle.sh
source "$SETUP_LIB/lifecycle.sh"
# shellcheck source=setup-lib/menu.sh
source "$SETUP_LIB/menu.sh"
# shellcheck source=setup-lib/help.sh
source "$SETUP_LIB/help.sh"

# Menü NUR bei Aufruf ganz ohne Argument UND an einem echten Terminal — jeder
# explizite Subcommand-Aufruf (Cron, --non-interactive, Automatisierung) läuft
# unverändert am Menü vorbei direkt in den Dispatch weiter unten.
if [[ $# -eq 0 ]] && [[ -t 0 ]]; then
    require_root
    select_language_interactive
    load_i18n
    init_log
    _log "=== setup.sh menu (interactive, lang=$LANG_CODE) ==="
    show_menu
    exit 0
fi

# Nicht-interaktiver/expliziter Aufruf: Sprache VOR jeder Ausgabe auflösen
# (--lang-Flag > local/language.txt > Default Englisch), fragt nie.
resolve_language "$@"
load_i18n

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
        --lang)             shift ;;  # bereits von resolve_language() ausgewertet
        --jupiter-key)     OPT_JUPITER_KEY="$2"; shift ;;
        --helius-key)      OPT_HELIUS_KEY="$2"; shift ;;
        --timezone)        OPT_TIMEZONE="$2"; shift ;;
        --lan-ip)          OPT_LAN_IP="$2"; shift ;;
        --nostr-alias)     OPT_NOSTR_ALIAS="$2"; shift ;;
        --wallets)         OPT_WALLETS="$2"; shift ;;
        --from)            OPT_RESTORE_FROM="$2"; shift ;;
        --keep-data)       OPT_KEEP_DATA=1 ;;
        --renew-deps)      OPT_RENEW_DEPS=1 ;;
        --to-version)      OPT_ROLLBACK_VERSION="$2"; shift ;;
        -h|--help)         show_help; exit 0 ;;
        *) die "Unbekannte Option: $1  (Hilfe: $0 help)" ;;
    esac
    shift
done

[[ "$CMD" == "help" ]] && { show_help; exit 0; }
require_root "$CMD"
init_log
_log "=== setup.sh $CMD (interactive=$INTERACTIVE, lang=$LANG_CODE) ==="

case "$CMD" in
    install)   do_install ;;
    update)    do_update ;;
    rollback-code) do_rollback_code ;;
    uninstall) do_uninstall ;;
    repair)    do_repair ;;
    packages)  do_packages ;;
    ssl)       do_ssl ;;
    wallet|wallets) do_wallets; print_secrets_summary ;;
    nostr)     do_nostr; print_secrets_summary ;;
    services)  do_services ;;
    cron)      do_cron ;;
    logrotate) do_logrotate ;;
    backup)    do_backup ;;
    restore)   do_restore ;;
    status)    do_status ;;
    *)         die "Unbekannter Befehl: $CMD  (Hilfe: $0 help)" ;;
esac
