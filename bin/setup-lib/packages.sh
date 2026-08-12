# ═════════════════════════════════════════════════════════════════════════════
# Pakete
# ═════════════════════════════════════════════════════════════════════════════
# Bewusst KEIN Blind-Install: fehlende Pakete werden gemeldet, nicht ungefragt
# nachgezogen (Entscheidung 2026-07-26, bestätigt 2026-08-01). Ausnahme sind die
# schmalen Hilfspakete mkcert/libnss3-tools/cron/zip, die ausschließlich dieser
# Installer braucht und die kein System nennenswert verändern.
do_packages() {
    step "$(t PACKAGES_STEP)"
    local -a fehlt=()

    if command -v node &>/dev/null; then
        local major; major=$(node --version | sed 's/^v//' | cut -d. -f1)
        if [[ "$major" -lt 18 ]]; then
            fehlt+=("$(t PACKAGES_NODE_TOO_OLD "$(node --version)")")
        else c_ok "$(t PACKAGES_NODE_OK "$(node --version)")"; fi
    else
        fehlt+=("$(t PACKAGES_NODE_MISSING)")
    fi

    command -v npm &>/dev/null && c_ok "$(t PACKAGES_NPM_OK "$(npm --version)")" || fehlt+=("$(t PACKAGES_NPM_MISSING)")
    if command -v gcc &>/dev/null && command -v make &>/dev/null; then c_ok "$(t PACKAGES_BUILD_ESSENTIAL_OK)"
    else fehlt+=("$(t PACKAGES_BUILD_ESSENTIAL_MISSING)"); fi
    command -v sqlite3 &>/dev/null && c_ok "$(t PACKAGES_SQLITE_OK)" || fehlt+=("$(t PACKAGES_SQLITE_MISSING)")

    if [[ ${#fehlt[@]} -gt 0 ]]; then
        c_err "$(t PACKAGES_MISSING_HEADER)"
        for m in "${fehlt[@]}"; do echo "      $m" >&2; done
        [[ "$JSON_OUT" -eq 1 ]] && echo "{\"ok\":false,\"missing\":${#fehlt[@]}}"
        return 1
    fi

    local -a hilf=()
    command -v mkcert     &>/dev/null || hilf+=(mkcert libnss3-tools)
    command -v crontab    &>/dev/null || hilf+=(cron)
    command -v zip        &>/dev/null || hilf+=(zip)
    command -v logrotate  &>/dev/null || hilf+=(logrotate)
    if [[ ${#hilf[@]} -gt 0 ]]; then
        say "$(t PACKAGES_INSTALLING_HELPERS "${hilf[*]}")"
        apt-get update -qq && apt-get install -y -qq "${hilf[@]}"
        command -v crontab &>/dev/null && systemctl enable --now cron >/dev/null 2>&1 || true
    fi
    c_ok "$(t PACKAGES_ALL_OK)"
    [[ "$JSON_OUT" -eq 1 ]] && echo '{"ok":true}'
    return 0
}

# ═════════════════════════════════════════════════════════════════════════════
# Systemnutzer + sudoers
# ═════════════════════════════════════════════════════════════════════════════
do_user() {
    step "$(t USER_STEP "$INSTALL_USER")"
    if id -u "$INSTALL_USER" &>/dev/null; then c_ok "$(t USER_EXISTS)"
    else useradd --system --create-home --shell /bin/bash "$INSTALL_USER"; c_ok "$(t USER_CREATED)"; fi

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
        # Für den manuellen "Updates"-Menüpunkt im Webinterface (System > Updates):
        # feste, vollständige Kommandozeilen ohne Wildcard-Argument — rollback-code
        # bekommt bewusst kein --to-version übergeben (VERSIONS_RETENTION=1, es
        # existiert also ohnehin höchstens ein archiviertes Vorgängerpaket, das
        # rollback-code ohne Angabe automatisch selbst findet). bot-control-daemon.js
        # ruft exakt diese drei Zeilen unverändert per execFile auf.
        echo "Cmnd_Alias FORGE_UPDATE_CHECK = /usr/bin/node $APP_DIR/bin/update-check.js"
        echo "Cmnd_Alias FORGE_UPDATE_APPLY = /usr/bin/node $APP_DIR/bin/update-check.js --confirm"
        echo "Cmnd_Alias FORGE_UPDATE_ROLLBACK = /bin/bash $APP_DIR/bin/setup.sh rollback-code --non-interactive --yes"
        echo "$INSTALL_USER ALL=(root) NOPASSWD: FORGE_SYSTEMCTL, FORGE_UPDATE_CHECK, FORGE_UPDATE_APPLY, FORGE_UPDATE_ROLLBACK"
    } > "$tmp"
    if visudo -c -f "$tmp" >/dev/null 2>&1; then
        install -m 0440 -o root -g root "$tmp" "$SUDOERS_FILE"
        c_ok "$(t USER_SUDOERS_SET)"
    else
        c_err "$(t USER_SUDOERS_FAILED)"
        visudo -c -f "$tmp" || true
    fi
    rm -f "$tmp"
}

# ═════════════════════════════════════════════════════════════════════════════
# TLS
# ═════════════════════════════════════════════════════════════════════════════
do_ssl() {
    step "$(t SSL_STEP)"
    command -v mkcert &>/dev/null || die "$(t SSL_MKCERT_MISSING "$0")"
    ensure_dirs
    export CAROOT="$CAROOT_DIR"

    local ip="$OPT_LAN_IP"
    if [[ -z "$ip" ]]; then
        local erkannt
        erkannt=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' || hostname -I | awk '{print $1}')
        ask ip "$(t SSL_LAN_IP_PROMPT "$erkannt")" "$erkannt"
    fi
    [[ -n "$ip" ]] || die "$(t SSL_LAN_IP_MISSING)"

    say "$(t SSL_CA_TRUST "$CAROOT")"
    mkcert -install >/dev/null 2>&1 || c_warn "$(t SSL_MKCERT_INSTALL_WARN)"
    say "$(t SSL_CERT_GENERATE "$ip")"
    mkcert -cert-file "$CERTS_DIR/cert.pem" -key-file "$CERTS_DIR/key.pem" \
           "$ip" localhost 127.0.0.1 >/dev/null 2>&1

    cp "$CAROOT/rootCA.pem" "$CERTS_DIR/rootCA.pem"
    if command -v zip &>/dev/null; then
        cp "$CERTS_DIR/rootCA.pem" "$CERTS_DIR/FORGE-rootCA.crt"
        (cd "$CERTS_DIR" && zip -jq rootCA.zip FORGE-rootCA.crt && rm -f FORGE-rootCA.crt)
    fi
    chown -R "$INSTALL_USER:$INSTALL_USER" "$CERTS_DIR"
    chmod 600 "$CERTS_DIR/key.pem"
    c_ok "$(t SSL_CERT_READY "$CERTS_DIR")"
}

# ═════════════════════════════════════════════════════════════════════════════
# Zeitzone
# ═════════════════════════════════════════════════════════════════════════════
# Setzt sowohl die OS-Zeitzone (steuert cron-Weckzeiten und Log-/Journal-
# Zeitstempel) als auch FORGE_TZ (steuert Tagesgrenzen/Anzeige der App, siehe
# core/config.js) auf denselben Wert — beide sollen nie auseinanderlaufen.
# Default ist die bereits am Server konfigurierte Zeitzone (nicht hart Europe/
# Berlin): ein Nutzer in z.B. Florida bekommt so America/New_York als
# Vorschlag statt eines für ihn falschen deutschen Defaults, kann aber jede
# gültige IANA-Zone eintippen. Fund 2026-08-11 (forge-pub1/pub2 liefen beide
# unbemerkt auf Etc/UTC): dieser Schritt verhindert das ab jetzt bei jeder
# Neuinstallation.
do_timezone() {
    step "$(t TIMEZONE_STEP)"
    local detected=""
    detected="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"
    [[ -z "$detected" ]] && detected="$(cat /etc/timezone 2>/dev/null || true)"
    [[ -z "$detected" ]] && detected="UTC"

    if [[ -z "$OPT_TIMEZONE" ]]; then
        if [[ "$INTERACTIVE" -eq 1 ]]; then
            ask OPT_TIMEZONE "$(t TIMEZONE_PROMPT "$detected")" "$detected"
        else
            OPT_TIMEZONE="$detected"
        fi
    fi

    if [[ ! -e "/usr/share/zoneinfo/$OPT_TIMEZONE" ]]; then
        c_warn "$(t TIMEZONE_INVALID "$OPT_TIMEZONE" "$detected")"
        OPT_TIMEZONE="$detected"
    fi

    if [[ "$OPT_TIMEZONE" != "$detected" ]]; then
        if timedatectl set-timezone "$OPT_TIMEZONE" 2>/dev/null; then
            # timedatectl aktualisiert nur den /etc/localtime-Symlink, NICHT
            # /etc/timezone (Fund 2026-08-11) — ohne dpkg-reconfigure würden beide
            # Quellen auseinanderlaufen. cron neu starten, damit laufende Ticks die
            # neue Zone sofort verwenden statt erst beim nächsten Boot.
            DEBIAN_FRONTEND=noninteractive dpkg-reconfigure -f noninteractive tzdata >/dev/null 2>&1 || true
            systemctl restart cron 2>/dev/null || true
        else
            c_warn "$(t TIMEZONE_SET_FAILED "$OPT_TIMEZONE")"
            OPT_TIMEZONE="$detected"
        fi
    fi
    c_ok "$(t TIMEZONE_DONE "$OPT_TIMEZONE")"
}

# ═════════════════════════════════════════════════════════════════════════════
# API-Key-Validierung
# ═════════════════════════════════════════════════════════════════════════════
# Leichter Testaufruf direkt gegen Jupiter/Helius (Nexus läuft an dieser Stelle
# von do_install() noch nicht, s.o.). Ein ungültiger Key macht die Installation
# sinnlos — keine der Bot-Funktionen kann ohne ihn laufen (Fund 2026-08-07:
# vorher lief die Installation trotz erkannt-ungültigem Key einfach weiter).
# Ergebnis ist deshalb ein Exit-Code (0 = gültig/nicht prüfbar, 1 = ungültig),
# collect_valid_key() unten entscheidet, was mit einem ungültigen Key passiert.
# Läuft pro Eingabeversuch genau EINMAL — kein RateLimiter nötig.
validate_jupiter_key() {
    local key="$1"
    command -v curl &>/dev/null || return 0
    say "$(t CONFIG_VALIDATING_JUPITER)"
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
        -H "x-api-key: $key" \
        "https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50" \
        2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
        c_ok "$(t CONFIG_JUPITER_KEY_OK)"
        return 0
    fi
    c_err "$(t CONFIG_JUPITER_KEY_INVALID "$code")"
    return 1
}

validate_helius_key() {
    local key="$1"
    command -v curl &>/dev/null || return 0
    say "$(t CONFIG_VALIDATING_HELIUS)"
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
        -X POST "https://mainnet.helius-rpc.com/?api-key=${key}" \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
        2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
        c_ok "$(t CONFIG_HELIUS_KEY_OK)"
        return 0
    fi
    c_err "$(t CONFIG_HELIUS_KEY_INVALID "$code")"
    return 1
}

# Fragt einen API-Key ab und validiert ihn — bei einem ungültigen Key im
# interaktiven Modus Wahl zwischen erneuter Eingabe und Abbruch; im
# nicht-interaktiven Modus (Cron/Automatisierung) sofortiger Abbruch, da dort
# niemand eine Rückfrage beantworten kann. Ohne einen gültigen Key ist kein
# Bot lauffähig — deshalb kein stiller Weiterlauf in keinem der beiden Fälle.
collect_valid_key() {
    local __var="$1" __prompt_key="$2" __required_key="$3" __validator="$4"
    while true; do
        if [[ -z "${!__var}" ]]; then
            ask "$__var" "$(t "$__prompt_key")"
        fi
        [[ -n "${!__var}" ]] || die "$(t "$__required_key")"
        "$__validator" "${!__var}" && return 0
        if [[ "$INTERACTIVE" -eq 0 ]]; then
            die "$(t CONFIG_KEY_INVALID_NONINTERACTIVE)"
        fi
        if confirm "$(t CONFIG_KEY_RETRY_PROMPT)"; then
            printf -v "$__var" ''
        else
            die "$(t CONFIG_ABORTED_INVALID_KEY)"
        fi
    done
}

# ═════════════════════════════════════════════════════════════════════════════
# Konfiguration (.env)
# ═════════════════════════════════════════════════════════════════════════════
do_config() {
    step "$(t CONFIG_STEP)"
    if [[ -z "$OPT_JUPITER_KEY" ]]; then
        say ""
        say "$(t CONFIG_API_KEYS_HEADER)"
    fi
    collect_valid_key OPT_JUPITER_KEY CONFIG_JUPITER_PROMPT CONFIG_JUPITER_REQUIRED validate_jupiter_key
    collect_valid_key OPT_HELIUS_KEY  CONFIG_HELIUS_PROMPT  CONFIG_HELIUS_REQUIRED  validate_helius_key

    local nexus_env="$ENV_DIR/nexus.env"
    env_from_example "$APP_DIR/core/nexus" "$nexus_env"
    set_env_var "$nexus_env" JUPITER_API_KEY "$OPT_JUPITER_KEY"
    set_env_var "$nexus_env" HELIUS_API_KEY  "$OPT_HELIUS_KEY"
    # Telegram-Support existiert derzeit nur auf FORGE Master, nicht auf einem
    # FORGE-public-Fork. .env.example enthält trotzdem die Platzhalter-Zeilen
    # "dein-token-hier"/"dein-chat-id-hier" (Vorlage auch fürs Master-Doku-Beispiel) —
    # die sind als Nicht-Leerstring "konfiguriert" genug, dass core/nexus/server.js
    # (sendTelegram(): `if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;`)
    # sie für echt hält und bei jedem Lifecycle-Event einen realen, fehlschlagenden
    # Telegram-API-Call auslöst (HTTP 404, Fund forge-pub1 2026-08-07). Explizit
    # leer setzen, damit der bestehende Guard sauber greift.
    set_env_var "$nexus_env" TELEGRAM_BOT_TOKEN ""
    set_env_var "$nexus_env" TELEGRAM_CHAT_ID   ""

    env_from_example "$APP_DIR/bots/settings" "$ENV_DIR/settings.env"

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
    local prem="$ENV_DIR/premium.env"
    env_from_example "$APP_DIR/core/premium" "$prem"
    set_env_var "$prem" PREMIUM_WALLET_PATH "$SECRETS_DIR/premium-wallet.json"
    set_env_var "$prem" NOSTR_SECRETS_DIR   "$SECRETS_DIR"
    set_env_var "$prem" NOSTR_IDENTITY      "$NOSTR_IDENTITY_NAME"

    # FORGE_TZ steuert Tagesgrenzen/Anzeige der App (core/config.js) — auf
    # denselben Wert gesetzt wie die OS-Zeitzone aus do_timezone(), damit beide
    # nie auseinanderlaufen (kein hartes Europe/Berlin für Nutzer in anderen Zonen).
    local settings_env="$ENV_DIR/settings.env"
    for f in "$nexus_env" "$settings_env" "$liq" "$lend" "$prem"; do
        set_env_var "$f" FORGE_TZ "$OPT_TIMEZONE"
    done

    chown "$INSTALL_USER:$INSTALL_USER" "$ENV_DIR"/*.env 2>/dev/null || true
    chmod 600 "$ENV_DIR"/*.env 2>/dev/null || true
    c_ok "$(t CONFIG_DONE)"
}
