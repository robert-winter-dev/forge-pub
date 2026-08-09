# ═════════════════════════════════════════════════════════════════════════════
# GETTING-STARTED.txt
# ═════════════════════════════════════════════════════════════════════════════
write_getting_started() {
    local ip="${OPT_LAN_IP:-$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' || hostname -I | awk '{print $1}')}"
    local version="unbekannt"; [[ -f "$APP_DIR/VERSION" ]] && version=$(cat "$APP_DIR/VERSION")
    {
        echo "═══════════════════════════════════════════════════════════"
        echo "  $(t GETTING_STARTED_TITLE)"
        echo "  $(date '+%Y-%m-%d %H:%M %Z')"
        echo "  $(t GETTING_STARTED_VERSION "$version")"
        echo "═══════════════════════════════════════════════════════════"
        echo
        echo "── $(t GETTING_STARTED_ACCESS_HEADER) ─────────────────────────"
        echo "  $(t GETTING_STARTED_DASHBOARD)      https://${ip}:3200/forge/"
        echo "  $(t GETTING_STARTED_BACKEND) https://${ip}:3200/"
        echo
        echo "── $(t GETTING_STARTED_TLS_HEADER) ──────────────────────────"
        echo "  $(t GETTING_STARTED_TLS_INTRO_1)"
        echo "  $(t GETTING_STARTED_TLS_INTRO_2)"
        echo "  $(t GETTING_STARTED_TLS_INTRO_3)"
        echo
        echo "    1. $(t GETTING_STARTED_TLS_STEP1 "$ip")"
        echo "    2. $(t GETTING_STARTED_TLS_STEP2)"
        echo "    3. $(t GETTING_STARTED_TLS_STEP3)"
        echo "       Windows: $(t GETTING_STARTED_TLS_WINDOWS_1)"
        echo "                $(t GETTING_STARTED_TLS_WINDOWS_2)"
        echo "       macOS:   sudo security add-trusted-cert -d -r trustRoot \\"
        echo "                  -k /Library/Keychains/System.keychain rootCA.pem"
        echo "       Linux:   sudo cp rootCA.pem /usr/local/share/ca-certificates/forge-ca.crt"
        echo "                sudo update-ca-certificates"
        echo "       Firefox: $(t GETTING_STARTED_TLS_FIREFOX_1)"
        echo "                $(t GETTING_STARTED_TLS_FIREFOX_2)"
        echo
        echo "── $(t GETTING_STARTED_DIRS_HEADER) ─────────────────────────"
        echo "  $(t GETTING_STARTED_DIR_APP)     $APP_DIR"
        echo "                $(t GETTING_STARTED_DIR_APP_NOTE)"
        echo "  $(t GETTING_STARTED_DIR_DATA)   $LOCAL_DIR"
        echo "                ./data     $(t GETTING_STARTED_DIR_DATA_DATA)"
        echo "                ./env      $(t GETTING_STARTED_DIR_DATA_ENV)"
        echo "                ./secrets  $(t GETTING_STARTED_DIR_DATA_SECRETS)"
        echo "                $(t GETTING_STARTED_DIR_DATA_NOTE)"
        echo "  $(t GETTING_STARTED_DIR_LOGS):     $LOG_DIR"
        echo "  $(t GETTING_STARTED_DIR_BACKUPS):  $BACKUP_DIR/local"
        echo "                $(t GETTING_STARTED_DIR_BACKUPS_NOTE1 "$BACKUP_RETENTION")"
        echo "                $(t GETTING_STARTED_DIR_BACKUPS_NOTE2)"
        echo "                $(t GETTING_STARTED_DIR_BACKUPS_NOTE3)"
        echo "                $(t GETTING_STARTED_DIR_BACKUPS_NOTE4)"
        echo
        echo "  $(t GETTING_STARTED_WALLET_KEYS_LOCATION "$SECRETS_DIR")"
        echo "  $(t GETTING_STARTED_WALLET_KEYS_FILES_HEADER)"
        for pair in "Liquidity Bot|liquidity-wallet.json" "Lending Bot|lending-wallet.json" \
                    "Premium Service|premium-wallet.json" "Nostr|${NOSTR_IDENTITY_NAME}.json"; do
            local lbl="${pair%%|*}" file="${pair##*|}"
            [[ -f "$SECRETS_DIR/$file" ]] && printf '    - %-16s %s\n' "$lbl:" "$SECRETS_DIR/$file"
        done
        echo "  $(t GETTING_STARTED_WALLET_KEYS_WARNING)"
        echo
        echo "── $(t GETTING_STARTED_BOTS_HEADER) ──"
        echo "  $(t GETTING_STARTED_BOTS_INTRO_1)"
        echo "  $(t GETTING_STARTED_BOTS_INTRO_2)"
        echo "  $(t GETTING_STARTED_BOTS_INTRO_3)"
        echo
        echo "    sudo systemctl enable --now forge-liquiditybot"
        echo "    sudo systemctl enable --now forge-lendingbot"
        echo
        echo "  $(t GETTING_STARTED_BOTS_ALT_1 "$ip")"
        echo "  $(t GETTING_STARTED_BOTS_ALT_2)"
        echo "  $(t GETTING_STARTED_BOTS_ALT_3)"
        echo
        echo "── $(t GETTING_STARTED_CONTROL_HEADER) ──────────────────────────"
        echo "  $(t GETTING_STARTED_CONTROL_START):  $BASE_DIR/start.sh"
        echo "  $(t GETTING_STARTED_CONTROL_STOP):  $BASE_DIR/stop.sh"
        echo "  $(t GETTING_STARTED_CONTROL_SETUP):    $BASE_DIR/setup.sh          $(t GETTING_STARTED_CONTROL_SETUP_NOTE)"
        echo "  $(t GETTING_STARTED_CONTROL_STATUS):   $BASE_DIR/setup.sh status"
        echo "  $(t GETTING_STARTED_CONTROL_BACKUP):   $BASE_DIR/setup.sh backup"
        echo "═══════════════════════════════════════════════════════════"
    } > "$GETTING_STARTED"
    chmod 644 "$GETTING_STARTED"
}

# ═════════════════════════════════════════════════════════════════════════════
# Hilfe
# ═════════════════════════════════════════════════════════════════════════════
show_help() {
    echo "$(t HELP_TITLE)"
    echo
    echo "  $(t HELP_USAGE "$0")"
    echo
    echo "$(t HELP_COMMANDS_HEADER)"
    echo "  install      $(t HELP_CMD_INSTALL)"
    echo "  update       $(t HELP_CMD_UPDATE)"
    echo "  rollback-code  $(t HELP_CMD_ROLLBACK_1)"
    echo "                 $(t HELP_CMD_ROLLBACK_2)"
    echo "  uninstall    $(t HELP_CMD_UNINSTALL)"
    echo "  repair       $(t HELP_CMD_REPAIR)"
    echo "  packages     $(t HELP_CMD_PACKAGES)"
    echo "  ssl          $(t HELP_CMD_SSL)"
    echo "  wallet       $(t HELP_CMD_WALLET)"
    echo "  nostr        $(t HELP_CMD_NOSTR)"
    echo "  services     $(t HELP_CMD_SERVICES)"
    echo "  cron         $(t HELP_CMD_CRON)"
    echo "  logrotate    $(t HELP_CMD_LOGROTATE)"
    echo "  backup       $(t HELP_CMD_BACKUP)"
    echo "  restore      $(t HELP_CMD_RESTORE)"
    echo "  status       $(t HELP_CMD_STATUS)"
    echo "  help         $(t HELP_CMD_HELP)"
    echo
    echo "$(t HELP_OPTIONS_HEADER)"
    echo "  --non-interactive     $(t HELP_OPT_NON_INTERACTIVE)"
    echo "  --yes                 $(t HELP_OPT_YES)"
    echo "  --quiet               $(t HELP_OPT_QUIET)"
    echo "  --json                $(t HELP_OPT_JSON)"
    echo "  --log-file <pfad>     $(t HELP_OPT_LOG_FILE)"
    echo "  --lang <de|en>        $(t HELP_OPT_LANG)"
    echo
    echo "  --jupiter-key <key>   $(t HELP_OPT_JUPITER_KEY)"
    echo "  --helius-key <key>    $(t HELP_OPT_HELIUS_KEY)"
    echo "  --lan-ip <ip>         $(t HELP_OPT_LAN_IP)"
    echo "  --nostr-alias <name>  $(t HELP_OPT_NOSTR_ALIAS)"
    echo "  --wallets <liste>     $(t HELP_OPT_WALLETS)"
    echo "  --from <datei>        $(t HELP_OPT_FROM)"
    echo "  --keep-data           $(t HELP_OPT_KEEP_DATA)"
    echo "  --to-version <n>      $(t HELP_OPT_TO_VERSION)"
    echo
    echo "$(t HELP_EXAMPLES_HEADER)"
    echo "  sudo $0 install --jupiter-key JUP... --helius-key HEL... --lan-ip 203.0.113.50 \\"
    echo "       --non-interactive --yes"
    echo "  sudo $0 backup --json          $(t HELP_EXAMPLE_BACKUP_COMMENT)"
    echo "  sudo $0 status --json"
    echo
    echo "$(t HELP_DIRECTORIES_HEADER)"
    echo "  $APP_DIR          $(t HELP_DIR_APP)"
    echo "  $LOCAL_DIR        $(t HELP_DIR_LOCAL)"
    echo "    ./data          $(t HELP_DIR_LOCAL_DATA)"
    echo "    ./env           $(t HELP_DIR_LOCAL_ENV)"
    echo "    ./secrets       $(t HELP_DIR_LOCAL_SECRETS)"
    echo "  $LOG_DIR          $(t HELP_DIR_LOG)"
    echo "  $BACKUP_DIR/local $(t HELP_DIR_BACKUP "$BACKUP_RETENTION")"
    echo "    ./versions      $(t HELP_DIR_BACKUP_VERSIONS "$VERSIONS_RETENTION")"
}
