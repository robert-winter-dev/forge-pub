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
    mkdir -p "$VERSIONS_DIR" "$BACKUP_DIR/local"
}

# Schützt laufende Cron-Jobs (bin/forge-cron.js, per Crontab jede Minute
# aufgerufen – läuft unabhängig von den systemd-SERVICES weiter) vor dem
# Fenster zwischen do_deploy()'s "rm -rf APP_DIR" und dem Ende von do_npm().
# Fund 2026-08-09: pool-offers-sync sprang genau in diesem Fenster an und
# crashte mit "Cannot find package 'dotenv'", weil node_modules gerade
# gelöscht/neu installiert wurde – health-check.js meldete das fälschlich als
# "Dienst nicht erreichbar, bitte neu starten". $DATA_DIR liegt unter
# $LOCAL_DIR und überlebt do_deploy()'s rm -rf (nur APP_DIR betroffen) – die
# Lock-Datei ist also während des gesamten Fensters sichtbar.
deploy_lock_acquire() {
    mkdir -p "$DATA_DIR"
    echo "$$" > "$DATA_DIR/deploy.lock"
}
deploy_lock_release() {
    rm -f "$DATA_DIR/deploy.lock" 2>/dev/null || true
}

# Unterdrückt die automatischen "🟢 X gestartet"/"🔴 X gestoppt"-Einzelmeldungen
# der Bots (bots/liquidity/lib/notify.js startup()/shutdown(), bots/lending/bin/
# bot.js) während eines Updates — der Betreiber bekommt stattdessen EINE
# Zusammenfassung am Ende von do_update() (siehe send_update_summary() dort).
# Außerhalb eines Updates (Crash, manueller bin/svc restart) bleibt der Marker
# unberührt, die Bots senden dann wie gewohnt ihre Einzelmeldung.
update_notify_suppress_on() {
    mkdir -p "$DATA_DIR"
    echo "$$" > "$DATA_DIR/update-notify-suppress"
}
update_notify_suppress_off() {
    rm -f "$DATA_DIR/update-notify-suppress" 2>/dev/null || true
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
    c_err "$(t COMMON_GUARD_LEGACY_STRUCTURE "$BASE_DIR")"
    c_err "$(t COMMON_GUARD_LEGACY_DBS "$1")"
    c_err "$(t COMMON_GUARD_LEGACY_VERSION "$APP_DIR" "$LOCAL_DIR")"
    c_err "$(t COMMON_GUARD_LEGACY_BACKUP_FIRST "$BASE_DIR")"
    exit 2
}

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
