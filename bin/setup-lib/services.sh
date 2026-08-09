# ═════════════════════════════════════════════════════════════════════════════
# Services, Start/Stop-Scripte, Cron
# ═════════════════════════════════════════════════════════════════════════════
do_services() {
    step "$(t SERVICES_STEP)"
    for u in core/forge-nexus.service core/forge-premium.service \
             bots/liquidity/forge-liquiditybot.service bots/lending/forge-lendingbot.service \
             bots/settings/forge-settings.service bots/settings/forge-settings-daemon.service; do
        [[ -f "$APP_DIR/$u" ]] && cp "$APP_DIR/$u" "/etc/systemd/system/$(basename "$u")"
    done
    systemctl daemon-reload
    systemctl enable forge-nexus forge-premium forge-settings forge-settings-daemon >/dev/null 2>&1 || true
    c_ok "$(t SERVICES_UNITS_DEPLOYED)"

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
    c_ok "$(t SERVICES_START_STOP_CREATED)"

    # setup.sh selbst zusätzlich sichtbar neben start.sh/stop.sh ablegen — ein
    # Neuling, der FORGE.pub nicht kennt, sucht nie unter app/bin/. Die Kopie wird
    # bei jedem Install/Update frisch geschrieben (bleibt also immer aktuell,
    # exakt wie start.sh/stop.sh), die Quelle im Artefakt (bin/setup.sh) bleibt
    # unverändert der Ort, aus dem install/update tatsächlich laufen MUSS (siehe
    # ARTIFACT_DIR-Guard in do_deploy) — diese Kopie ist reiner Komfort-Einstieg
    # für Menü/Uninstall/Status/Help, kein Ersatz für den Artefakt-Aufruf.
    # 🔒 Seit der Modul-Aufteilung (2026-08-07) muss setup-lib/ IMMER mitkopiert
    # werden — setup.sh lädt seine Module relativ zu sich selbst
    # ($(dirname "${BASH_SOURCE[0]}")/setup-lib/), eine Kopie ohne dieses
    # Geschwisterverzeichnis fände beim Ausführen ihre eigenen Funktionen nicht.
    cp "$ARTIFACT_DIR/bin/setup.sh" "$BASE_DIR/setup.sh"
    rm -rf "$BASE_DIR/setup-lib"
    cp -r "$ARTIFACT_DIR/bin/setup-lib" "$BASE_DIR/setup-lib"
    chmod 755 "$BASE_DIR/setup.sh"
    c_ok "$(t SERVICES_SETUP_COPIED "$BASE_DIR")"
}

do_cron() {
    step "$(t CRON_STEP)"
    command -v crontab &>/dev/null || { c_warn "$(t CRON_CRONTAB_MISSING)"; return 0; }
    local env_line="FORGE_ENV_DIR=$ENV_DIR"
    local line="* * * * * cd $APP_DIR && /usr/bin/node bin/forge-cron.js >> $LOG_DIR/cron/forge-cron-wrapper.log 2>&1"
    ( sudo -u "$INSTALL_USER" crontab -l 2>/dev/null | grep -v 'bin/forge-cron.js' | grep -v '^FORGE_ENV_DIR=' || true; echo "$env_line"; echo "$line" ) \
        | sudo -u "$INSTALL_USER" crontab -
    c_ok "$(t CRON_SET_UP)"

    # 🔒 Auto-Update BEWUSST als root-Crontab, nicht über forge-cron.js (das läuft
    # als der unprivilegierte $INSTALL_USER). Grund (Fund 2026-08-05, erster
    # echter Test gegen ein reales GitHub-Repo statt --source-Fixtures):
    # setup.sh update braucht selbst Root (schreibt u.a. nach BACKUP_DIR und
    # /etc/systemd/system/ — bewusst NICHT dem Service-User gehörig, damit ein
    # kompromittierter Bot-Prozess weder seine eigenen Backups noch Systemd-Units
    # manipulieren kann). Eine eng geschnittene Sudo-Regel dafür wäre pro
    # Installation eine weitere, für Nutzer kaum nachvollziehbare Sonderkonfiguration
    # gewesen (Produktentscheidung 2026-08-05) — stattdessen läuft der tägliche
    # Update-Check exakt so, wie er bisher jedes Mal MANUELL getestet wurde: als
    # root. Kein zusätzliches Sudoers-Setup, kein Sonderfall pro Kunde.
    # 🔒 Fund 2026-08-08 (Ticket forge-pub#0284/0285): update-check.log liegt im selben
    # Verzeichnis wie die forge-eigenen Cron-Logs, die logrotate per "su forge forge"
    # rotiert (logrotate.d/forge-pub) — der Verzeichnis-Modus (forge:forge, gruppen-
    # schreibbar) zwingt logrotate dazu, IMMER "su" für alles darin zu verwenden, es
    # gibt keine Ausnahme pro Datei. Schreibt root die Datei zum ersten Mal per ">>"
    # selbst an, gehört sie root:root, und "su forge forge" kann sie beim Rotieren
    # nicht mehr öffnen (copytruncate schlägt fehl). Root selbst braucht die Datei
    # NICHT zu besitzen, um per ">>" anzuhängen (Linux prüft bei root keine
    # Dateirechte) — daher: Datei hier idempotent mit dem richtigen Owner
    # vorlegen, BEVOR der root-Cron sie je anfasst. Einmal korrekt angelegt, bleibt
    # der Owner über beliebig viele append-Schreibvorgänge und copytruncate-
    # Rotationen hinweg stabil.
    mkdir -p "$LOG_DIR/cron"
    [[ -f "$LOG_DIR/cron/update-check.log" ]] || touch "$LOG_DIR/cron/update-check.log"
    chown "$INSTALL_USER:$INSTALL_USER" "$LOG_DIR/cron/update-check.log"

    local update_line="15 4 * * * cd $APP_DIR && $env_line /usr/bin/node bin/update-check.js >> $LOG_DIR/cron/update-check.log 2>&1"
    ( crontab -l 2>/dev/null | grep -v 'bin/update-check.js' || true; echo "$update_line" ) | crontab -
    c_ok "$(t CRON_AUTO_UPDATE_SET_UP)"
}

do_logrotate() {
    step "$(t LOGROTATE_STEP)"
    local src="$APP_DIR/logrotate.d/forge-pub"
    if [[ ! -f "$src" ]]; then
        c_warn "$(t LOGROTATE_SRC_MISSING)"
        return 0
    fi
    command -v logrotate &>/dev/null || { c_warn "$(t LOGROTATE_MISSING)"; return 0; }
    cp "$src" /etc/logrotate.d/forge-pub
    c_ok "$(t LOGROTATE_SET_UP)"
}

do_start() {
    step "$(t START_STEP)"
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
    c_ok "$(t START_LIQUIDITY_LENDING_DISABLED)"
    sleep 2
    do_status 1
}

do_status() {
    # <skip_marker_check>: do_start() (Teil von do_install(), Marker ist dort
    # bis GANZ zum Schluss bewusst noch gesetzt) ruft intern do_status() auf —
    # ohne diesen Parameter würde jede normale Installation sich selbst
    # fälschlich als "unvollständig" melden.
    local skip_marker_check="${1:-0}"
    local json="{" first=1
    [[ "$skip_marker_check" -eq 0 && -f "$INSTALL_MARKER" ]] && c_warn "$(t STATUS_INCOMPLETE_INSTALL "$0")"
    say ""
    say "  $(t STATUS_HEADER)"
    for s in "${SERVICES[@]}"; do
        local st; st=$(systemctl is-active "$s" 2>/dev/null) || true
        [[ -z "$st" ]] && st="$(t STATUS_UNKNOWN)"
        [[ "$st" == "active" ]] && c_ok "$s: $st" || c_warn "$s: $st"
        [[ $first -eq 1 ]] || json+=","
        json+="\"$s\":\"$st\""; first=0
    done
    json+="}"
    [[ "$JSON_OUT" -eq 1 ]] && echo "$json"
    return 0
}
