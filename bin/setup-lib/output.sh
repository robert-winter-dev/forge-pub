# ═════════════════════════════════════════════════════════════════════════════
# Ausgabe, Logging, Übersetzung
# ═════════════════════════════════════════════════════════════════════════════
# Jede Meldung geht zusätzlich ins Logfile. Das Log liegt in log/ und damit
# außerhalb von app/ — es überlebt ein Update und ist genau dann noch da, wenn
# man nach einem missglückten Lauf nachvollziehen will, was passiert ist.
_log() { [[ -n "$LOG_FILE" ]] && printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE" || true; }
say()    { [[ "$QUIET" -eq 0 ]] && echo -e "$1" || true; _log "$1"; }
c_ok()   { say "  $1"; }
c_warn() { say "  $1"; }
c_err()  { echo -e "  $1" >&2; _log "ERROR: $1"; }
# Bewusst KEINE nachlaufenden Striche mehr (Fund 2026-08-07, echter Testlauf auf
# forge-pub2): eine feste Gesamtbreite mit Auffüll-Strichen sah bei einer ersten
# Umsetzung noch uneinheitlich aus. Statt die Breite weiter zu justieren, bleibt
# nur noch der Anstrich vor dem Titel ("── Titel") — robust gegen jede Titellänge,
# kein Terminalbreiten-Ratespiel nötig.
step() { say ""; say "── $1"; }
die()    { c_err "$1"; exit "${2:-1}"; }

# ── Übersetzung ────────────────────────────────────────────────────────────
# Zwei Sprachtabellen (i18n-de.sh/i18n-en.sh, assoziative Arrays) statt zweier
# kompletter Skript-Kopien — dieselbe Logik läuft in beiden Sprachen, nur der
# angezeigte Text unterscheidet sich. t() liest den aktiven Satz (MSG, von
# load_i18n() befüllt) und interpoliert Variablen über printf-Platzhalter
# (%s), damit Wortstellung je Sprache frei sein darf.
declare -A MSG
LANG_CODE="en"

t() {
    local key="$1"; shift
    local fmt="${MSG[$key]:-$key}"
    # shellcheck disable=SC2059 -- fmt enthält bewusst printf-Platzhalter
    printf -- "$fmt" "$@"
}

# Lädt die Sprachtabelle für $LANG_CODE. Muss NACH dem Setzen von LANG_CODE
# aufgerufen werden (siehe resolve_language()/select_language_interactive()
# in bin/setup.sh). setup-lib/ liegt immer neben dieser Datei — funktioniert
# unverändert, egal ob aus dem Artefakt (bin/setup-lib/) oder aus der
# $BASE_DIR-Komfort-Kopie (siehe do_services in services.sh) geladen.
load_i18n() {
    local lib_dir; lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck disable=SC1090
    source "$lib_dir/i18n-${LANG_CODE}.sh"
}

# Bestimmt die Sprache für NICHT-interaktive Aufrufe (Cron, Automatisierung,
# jeder explizite Subcommand): --lang-Flag > lokal gespeicherte Wahl aus einem
# früheren interaktiven Lauf > Default Englisch. Fragt NIE — wer automatisiert
# aufruft, hat entweder --lang gesetzt oder bekommt den Default, nie einen
# blockierenden Prompt.
resolve_language() {
    local lang="" args=("$@")
    local i
    for ((i = 0; i < ${#args[@]}; i++)); do
        if [[ "${args[$i]}" == "--lang" && -n "${args[$i+1]:-}" ]]; then lang="${args[$i+1]}"; fi
    done
    if [[ -z "$lang" && -f "$LOCAL_DIR/language.txt" ]]; then
        lang="$(cat "$LOCAL_DIR/language.txt" 2>/dev/null || true)"
    fi
    [[ "$lang" == "de" || "$lang" == "en" ]] || lang="en"
    LANG_CODE="$lang"
}

# Fragt NUR im interaktiven Menü-Einstieg (kein Argument, echtes Terminal),
# ein einziges Mal pro Lauf, bevor irgendein anderer Text erscheint — dieser
# eine Prompt kann selbst noch nicht übersetzt sein (die Sprache steht ja
# noch nicht fest), deshalb bewusst zweisprachig fest im Code. Die Wahl wird
# gespeichert (local/language.txt, gleiches Muster wie local/update-channel.txt),
# spätere Aufrufe (Update/Uninstall/Status) fragen dadurch nie wieder.
select_language_interactive() {
    echo ""
    echo "  Language / Sprache:"
    echo "    [1] English (default)"
    echo "    [2] Deutsch"
    local choice=""
    read -r -p "  [Enter = English]: " choice || true
    case "$choice" in
        2) LANG_CODE="de" ;;
        *) LANG_CODE="en" ;;
    esac
    mkdir -p "$LOCAL_DIR" 2>/dev/null || true
    echo "$LANG_CODE" > "$LOCAL_DIR/language.txt" 2>/dev/null || true
}

# Fragt nur im interaktiven Modus. Im automatisierten Lauf MUSS ein Wert per
# Parameter gesetzt sein — es gibt bewusst keinen stillen Default, der einen
# fehlenden Wert überdeckt.
ask() {
    # ask <variable> <prompt> [default]
    local __var="$1" __prompt="$2" __default="${3:-}" __ans=""
    if [[ "$INTERACTIVE" -eq 0 ]]; then
        [[ -n "$__default" ]] && { printf -v "$__var" '%s' "$__default"; return 0; }
        die "$(t ASK_NONINTERACTIVE_MISSING "$__var" "$0")"
    fi
    read -r -p "$__prompt" __ans || true
    printf -v "$__var" '%s' "${__ans:-$__default}"
}

confirm() {
    # confirm <frage>  → 0 = ja
    local frage="$1" ans=""
    [[ "$ASSUME_YES" -eq 1 ]] && return 0
    [[ "$INTERACTIVE" -eq 0 ]] && return 1
    read -r -p "  $frage $(t CONFIRM_SUFFIX): " ans || true
    [[ "$ans" == "$(t CONFIRM_YES)" || "$ans" == "$(t CONFIRM_YES_UPPER)" ]]
}

require_root() {
    [[ "$EUID" -eq 0 ]] || die "$(t REQUIRE_ROOT "$0 $*")"
}

init_log() {
    mkdir -p "$LOG_DIR/setup"
    # Ein Logfile pro Tag (nicht pro Lauf) — mehrere Aufrufe am selben Tag hängen
    # sich dank _log()'s Append-Schreibweise (>>) automatisch an dieselbe Datei.
    [[ -z "$LOG_FILE" ]] && LOG_FILE="$LOG_DIR/setup/$(date +%Y%m%d)-setup.log"
    touch "$LOG_FILE"; chmod 640 "$LOG_FILE"
    # Logrotation: die letzten LOG_RETENTION Setup-Logs reichen zur Fehlersuche.
    # Ohne diese Grenze läuft log/setup/ bei häufigen Testläufen langsam voll.
    local alt
    alt=$(ls -1t "$LOG_DIR"/setup/*-setup.log 2>/dev/null | tail -n +$((LOG_RETENTION + 1)) || true)
    [[ -n "$alt" ]] && echo "$alt" | xargs -r rm -f || true
}
