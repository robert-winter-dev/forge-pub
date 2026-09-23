# ═════════════════════════════════════════════════════════════════════════════
# Vollinstallation
# ═════════════════════════════════════════════════════════════════════════════
do_install() {
    guard_legacy install
    say "═══════════════════════════════════════════════════════════"
    say "  $(t LIFECYCLE_INSTALL_HEADER_TITLE)"
    say "  $(t LIFECYCLE_INSTALL_HEADER_SOURCE "$ARTIFACT_DIR")"
    say "  $(t LIFECYCLE_INSTALL_HEADER_TARGET "$BASE_DIR")"
    say "═══════════════════════════════════════════════════════════"

    # Erkennt einen vorherigen Lauf, der zwischen INSTALL_MARKER anlegen (unten)
    # und Erfolg abgebrochen ist (z.B. ein bei der Key-Eingabe abgelehnter
    # ungültiger API-Key). OHNE diese Prüfung sah ein bereits von do_deploy
    # kopiertes app/-Verzeichnis beim nächsten 'install' wie eine echte, fertige
    # Installation mit schützenswertem Kapital aus (Fund 2026-08-07) — obwohl nie
    # ein Wallet erzeugt wurde. Hat Vorrang vor der Prüfung darunter.
    if [[ -f "$INSTALL_MARKER" ]]; then
        c_warn "$(t LIFECYCLE_INSTALL_INCOMPLETE_FOUND "$BASE_DIR")"
        confirm "$(t LIFECYCLE_INSTALL_INCOMPLETE_CONFIRM)" || { say "  $(t LIFECYCLE_ABORTED)"; exit 0; }
        cleanup_incomplete_install
    # 🔒 Install macht wirklich ALLES neu (Entscheidung 2026-08-06, korrigiert eine
    # frühere Fehlspezifikation): anders als bei update() werden Wallets, Nostr-
    # Identität und Trust-Anchor bei install() NICHT wiederverwendet, sondern nach
    # dem Pflicht-Backup komplett neu erzeugt. Grund: sonst ließ sich eine wirklich
    # frische Neuinstallation (z.B. zum Testen) nie durchspielen, wenn schon einmal
    # ein Zustand existierte. Wer bestehende Wallets/Daten behalten will, nutzt
    # gezielt update() — nicht install() auf einer bestehenden Installation.
    elif [[ -d "$APP_DIR" ]] && [[ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
        c_warn "$(t LIFECYCLE_INSTALL_EXISTS_WARNING "$APP_DIR")"
        c_warn "$(t LIFECYCLE_INSTALL_EXISTS_REPLACES_ALL)"
        say "  $(t LIFECYCLE_INSTALL_EXISTS_BACKUP_ONLY_1)"
        say "  $(t LIFECYCLE_INSTALL_EXISTS_BACKUP_ONLY_2 "$BACKUP_DIR/local")"
        say "  $(t LIFECYCLE_INSTALL_EXISTS_USE_UPDATE "$0")"
        confirm "$(t LIFECYCLE_INSTALL_CONFIRM_REPLACE)" || { say "  $(t LIFECYCLE_ABORTED)"; exit 0; }
        do_backup
        say "  → $(t LIFECYCLE_INSTALL_WIPING_LOCAL)"
        rm -rf "${LOCAL_DIR:?}"
    fi

    ensure_dirs
    touch "$INSTALL_MARKER"

    do_packages
    do_timezone
    do_user
    # Lock schützt einen bereits laufenden Cron (Re-Install über eine bestehende
    # Installation hinweg, s.o. "exists"-Zweig) vor dem rm-rf/npm-install-Fenster.
    deploy_lock_acquire
    do_deploy
    do_trust_anchor
    do_npm
    deploy_lock_release
    do_ssl
    do_config
    do_wallets
    do_nostr
    print_secrets_summary
    do_services
    do_cron
    do_logrotate
    # Neuinstallation: alle Migrationen als erledigt verbuchen, ohne sie auszufuehren —
    # der frisch installierte Code bringt den Zielzustand bereits mit. Ohne diesen Schritt
    # liefen historische Korrekturen auf einer leeren Installation an und stellten teils
    # Zustaende her, die spaetere Migrationen laengst abgeloest haben.
    baseline_migrations
    fix_ownership
    do_start
    write_getting_started

    rm -f "$INSTALL_MARKER"
    say ""
    say "═══════════════════════════════════════════════════════════"
    c_ok "$(t LIFECYCLE_INSTALL_DONE)"
    say "  $(t LIFECYCLE_INSTALL_HINTS "$GETTING_STARTED")"
    say "  $(t LIFECYCLE_INSTALL_LOGFILE "$LOG_FILE")"
    say "═══════════════════════════════════════════════════════════"
    return 0
}

# Schlanke Variante von do_uninstall() für eine erkannt UNVOLLSTÄNDIGE
# Installation (s.o.) — ohne deren eigene zusätzliche Rückfragen/--keep-data-
# Verzweigung, die Bestätigung ist an dieser Stelle schon über
# LIFECYCLE_INSTALL_INCOMPLETE_CONFIRM eingeholt. do_backup() läuft trotzdem mit
# (kostet nichts, falls z.B. schon ein Wallet mit Adresse angezeigt wurde, bevor
# der Fehler kam) — reine Vorsichtsmaßnahme, kein Ersatz für die volle
# Kapital-Warnung im Zweig darüber.
cleanup_incomplete_install() {
    step "$(t LIFECYCLE_INCOMPLETE_CLEANUP_STEP)"
    do_backup
    teardown_units_and_cron
    rm -rf "${APP_DIR:?}" "${LOCAL_DIR:?}" "${LOG_DIR:?}" "${BASE_DIR:?}/staging" "$GETTING_STARTED"
    LOG_FILE=""
    id -u "$INSTALL_USER" &>/dev/null && { userdel -r "$INSTALL_USER" 2>/dev/null || userdel "$INSTALL_USER" 2>/dev/null || true; }
    c_ok "$(t LIFECYCLE_INCOMPLETE_CLEANUP_DONE)"
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
    step "$(t LIFECYCLE_UPDATE_STEP)"
    guard_legacy update
    [[ -f "$INSTALL_MARKER" ]] && die "$(t LIFECYCLE_INCOMPLETE_BLOCKS_ACTION "$0")"
    if [[ ! -d "$APP_DIR" ]]; then die "$(t LIFECYCLE_UPDATE_NOT_INSTALLED "$APP_DIR")"; fi
    local aktuell="$(t LIFECYCLE_UNKNOWN)"
    [[ -f "$APP_DIR/VERSION" ]] && aktuell=$(cat "$APP_DIR/VERSION")
    say "  $(t LIFECYCLE_UPDATE_CURRENT_VERSION "$aktuell")"

    if [[ -f "$ARTIFACT_DIR/VERSION" ]] && [[ "$ARTIFACT_DIR" != "$APP_DIR" ]]; then
        say "  $(t LIFECYCLE_UPDATE_ARTIFACT_VERSION "$(cat "$ARTIFACT_DIR/VERSION")")"
        confirm "$(t LIFECYCLE_UPDATE_CONFIRM)" || {
            say "  $(t LIFECYCLE_ABORTED)"; return 0; }
        do_backup
        archive_current_code
        # Aktivierungszustand von Liquidity/Lending VOR dem Stop merken — ein Update
        # darf ihn nicht verändern (Fund 2026-08-07: bisher wurden beide Bots am Ende
        # blind gestartet, auch wenn sie vorher bewusst deaktiviert waren, z.B. leeres
        # Wallet ohne SOL → sofortiger Crash-Loop direkt nach dem Update).
        local liq_was_active=0 lend_was_active=0
        systemctl is-active --quiet forge-liquiditybot && liq_was_active=1
        systemctl is-active --quiet forge-lendingbot  && lend_was_active=1
        local update_started_at update_started_epoch
        update_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        update_started_epoch=$(date +%s)
        # Unterdrückt die Einzel-"gestartet"/"gestoppt"-Meldungen jedes Bots für
        # die Dauer des gesamten Updates (Fund 2026-08-09) – am Ende steht
        # stattdessen EINE Zusammenfassung (s.u. send-update-summary.js).
        update_notify_suppress_on
        systemctl stop "${SERVICES[@]}" 2>/dev/null || true
        # Bots stehen bereits still, aber bin/forge-cron.js läuft per Crontab
        # unabhängig davon weiter (jede Minute) – ohne diesen Lock würde ein
        # Job, der genau jetzt fällig ist, mitten in die gelöschte/neu
        # installierte node_modules laufen (Fund 2026-08-09, pool-offers-sync).
        deploy_lock_acquire
        do_deploy
        # config/health-config.js kommt frisch aus dem Artefakt (Placeholder-IP
        # aus dem Fork-Export) — LAN-IP direkt danach wieder eintragen, sonst
        # verliert LIQ#000565 seine Wirkung bei jedem Update (CORE#000568).
        sync_health_config_ip "$(detect_lan_ip)"
        do_trust_anchor
        do_npm
        deploy_lock_release
        rebuild_wallet_monitor
        # Einmaliger Dashboard-Export direkt nach dem Deploy (Fund 2026-08-07):
        # app/html/ (inkl. data.json) liegt INNERHALB von app/ und wird von
        # do_deploy() komplett neu geschrieben (rm -rf + Kopie aus dem Artefakt) —
        # ohne diesen Schritt blieb das Dashboard bei zuvor gestoppten Bots nach
        # jedem Update leer/ENOENT, bis jemand den Bot manuell startet (den finalen
        # Export beim Stoppen selbst gibt es erst seit derselben Session, s.o. bei
        # bot.js — hilft hier aber nicht, weil do_deploy() genau diese Datei gleich
        # wieder löscht). Best-effort (Redirect + `|| true`): auf einer wirklich
        # frischen Installation (do_install(), DB noch ohne Tabellen, hier bewusst
        # NICHT aufgerufen) würde das fehlschlagen — dort ist ein leeres Dashboard
        # vor dem allerersten Bot-Start ohnehin der einzig korrekte Zustand.
        sudo -u "$INSTALL_USER" bash -c "cd '$APP_DIR/bots/liquidity' && node bin/export.js" >/dev/null 2>&1 || true
        sudo -u "$INSTALL_USER" bash -c "cd '$APP_DIR/bots/lending'   && node bin/export.js" >/dev/null 2>&1 || true
        run_migrations
        vacuum_bloated_dbs
        do_services
        do_cron
        do_logrotate
        systemctl start forge-nexus forge-premium forge-settings forge-settings-daemon 2>/dev/null || true
        sleep 3
        local restarted_services=()
        if [[ "$liq_was_active" -eq 1 ]]; then
            systemctl start forge-liquiditybot 2>/dev/null || true
            restarted_services+=("Liquidity Bot")
        fi
        if [[ "$lend_was_active" -eq 1 ]]; then
            systemctl start forge-lendingbot 2>/dev/null || true
            restarted_services+=("LendingBot")
        fi

        # Kurze Gnadenfrist, damit ein Crash-Loop direkt nach dem Start noch
        # sichtbar wird, BEVOR die Zusammenfassung "keine Auffälligkeiten"
        # behauptet – die Zeile soll wirklich nur stehen, wenn alles läuft.
        sleep 8
        local update_problems=()
        if [[ "$liq_was_active" -eq 1 ]] && ! systemctl is-active --quiet forge-liquiditybot; then
            update_problems+=("Liquidity Bot (forge-liquiditybot): läuft nicht – bitte prüfen: journalctl -u forge-liquiditybot -n 50")
        fi
        if [[ "$lend_was_active" -eq 1 ]] && ! systemctl is-active --quiet forge-lendingbot; then
            update_problems+=("LendingBot (forge-lendingbot): läuft nicht – bitte prüfen: journalctl -u forge-lendingbot -n 50")
        fi
        for s in forge-nexus forge-premium forge-settings forge-settings-daemon; do
            systemctl is-active --quiet "$s" \
                || update_problems+=("$s: läuft nicht – bitte prüfen: journalctl -u $s -n 50")
        done

        update_notify_suppress_off
        # $APP_DIR/VERSION ist ein mehrzeiliger Block (Label/Version/VersionCode/…,
        # siehe tools/pub-export/build-artifact.js) – nur die "Version:"-Zeile
        # extrahieren, sonst landet der ganze Block in der Nutzer-Nachricht.
        local artifact_version
        artifact_version="$(grep '^Version:' "$APP_DIR/VERSION" 2>/dev/null | head -1 | sed 's/^Version: *//')"
        [[ -n "$artifact_version" ]] || artifact_version="unbekannt"
        local update_summary_args=(
            --version "$artifact_version"
            --started-at "$update_started_at"
            --duration-sec "$(( $(date +%s) - update_started_epoch ))"
        )
        for s in "${restarted_services[@]}"; do update_summary_args+=(--service "$s"); done
        for p in "${update_problems[@]}"; do update_summary_args+=(--problem "$p"); done
        # Ausgabe abfangen statt direkt durchzureichen (Fund 2026-08-09: die
        # bisherige generische Warnung "Nexus nicht erreichbar?" verdeckte den
        # echten Fehler – ein fehlender Entry-Point in der Fork-Allowlist
        # (MODULE_NOT_FOUND) sah dadurch wie ein Nexus-Ausfall aus). Ausgabe
        # wird trotzdem vollständig geloggt, die Warnung zeigt zusätzlich die
        # letzte (meist aussagekräftigste) Zeile davon.
        local summary_output summary_rc=0 summary_detail
        summary_output="$(sudo -u "$INSTALL_USER" node "$APP_DIR/bin/send-update-summary.js" "${update_summary_args[@]}" 2>&1)" || summary_rc=$?
        say "$summary_output"
        if [[ "$summary_rc" -ne 0 ]]; then
            # Node-Crashes haben die aussagekräftigste Zeile meist als "Error: …"
            # oder "[send-update-summary] …" mittendrin, NICHT ganz am Ende (dort
            # steht oft nur "Node.js vX.Y.Z") – gezielt danach suchen, sonst
            # Rückfall auf die letzte Zeile.
            summary_detail="$(echo "$summary_output" | grep -E '^(Error|\[send-update-summary\])' | tail -1)"
            [[ -n "$summary_detail" ]] || summary_detail="$(echo "$summary_output" | tail -1)"
            c_warn "$(t LIFECYCLE_UPDATE_SUMMARY_FAILED "$summary_detail")"
        fi

        c_ok "$(t LIFECYCLE_UPDATE_DONE)"
        do_status
    else
        c_warn "$(t LIFECYCLE_UPDATE_NO_ARTIFACT)"
        say "      $(t LIFECYCLE_UPDATE_NO_ARTIFACT_INFO_1)"
        say "      $(t LIFECYCLE_UPDATE_NO_ARTIFACT_INFO_2)"
        say "      $(t LIFECYCLE_UPDATE_NO_ARTIFACT_INFO_3 "$0")"
    fi
}

# Gemeinsamer OS-Teardown für do_uninstall() UND cleanup_incomplete_install()
# (s.u.): Services stoppen/deaktivieren, Units/Sudoers/Cron/Komfort-Kopien
# entfernen. Rührt lokale Daten/App-Code NICHT an — das entscheidet jeweils
# der Aufrufer (unterschiedliche Löschumfänge/Rückfragen).
teardown_units_and_cron() {
    say "  → $(t LIFECYCLE_UNINSTALL_STOPPING)"
    systemctl stop "${SERVICES[@]}" 2>/dev/null || true
    systemctl disable "${SERVICES[@]}" 2>/dev/null || true
    for s in "${SERVICES[@]}"; do rm -f "/etc/systemd/system/$s.service"; done
    systemctl daemon-reload
    rm -f "$SUDOERS_FILE"
    if id -u "$INSTALL_USER" &>/dev/null; then
        ( sudo -u "$INSTALL_USER" crontab -l 2>/dev/null | grep -v 'bin/forge-cron.js' || true ) \
            | sudo -u "$INSTALL_USER" crontab - 2>/dev/null || true
    fi
    ( crontab -l 2>/dev/null | grep -v 'bin/update-check.js' || true ) | crontab - 2>/dev/null || true
    rm -f "$BASE_DIR/start.sh" "$BASE_DIR/stop.sh" "$BASE_DIR/setup.sh"
    rm -rf "$BASE_DIR/setup-lib"
    c_ok "$(t LIFECYCLE_UNINSTALL_UNITS_REMOVED)"
}

# ═════════════════════════════════════════════════════════════════════════════
# Deinstallation
# ═════════════════════════════════════════════════════════════════════════════
do_uninstall() {
    step "$(t LIFECYCLE_UNINSTALL_STEP)"
    do_backup
    teardown_units_and_cron
    # Eine abgeschlossene Deinstallation beendet auch jede "Installation läuft
    # noch"-Ambiguität — unabhängig davon, ob --keep-data gleich unten lokale
    # Daten für ein künftiges update() stehen lässt.
    rm -f "$INSTALL_MARKER"

    say ""
    c_warn "$(t LIFECYCLE_UNINSTALL_SECRETS_WARNING "$SECRETS_DIR" "$ENV_DIR")"
    if [[ "$OPT_KEEP_DATA" -eq 1 ]]; then
        rm -rf "${APP_DIR:?}"
        id -u "$INSTALL_USER" &>/dev/null && { userdel -r "$INSTALL_USER" 2>/dev/null || userdel "$INSTALL_USER" 2>/dev/null || true; }
        c_ok "$(t LIFECYCLE_UNINSTALL_KEEP_DATA_DONE "$INSTALL_USER")"
        return 0
    fi

    say "  $(t LIFECYCLE_UNINSTALL_DELETE_LIST_HEADER)"
    say "    - $(t LIFECYCLE_UNINSTALL_DELETE_APP "$APP_DIR")"
    say "    - $(t LIFECYCLE_UNINSTALL_DELETE_DATA "$DATA_DIR")"
    say "    - $(t LIFECYCLE_UNINSTALL_DELETE_ENV "$ENV_DIR")"
    say "    - $(t LIFECYCLE_UNINSTALL_DELETE_SECRETS "$SECRETS_DIR")"
    say "    - $(t LIFECYCLE_UNINSTALL_DELETE_TRUST "$TRUST_DIR")"
    say "    - $(t LIFECYCLE_UNINSTALL_DELETE_LOG "$LOG_DIR")"
    say "    - $(t LIFECYCLE_UNINSTALL_DELETE_STAGING "$BASE_DIR/staging")"
    say "    - $(t LIFECYCLE_UNINSTALL_DELETE_GETTING_STARTED "$GETTING_STARTED")"
    say "    - $(t LIFECYCLE_UNINSTALL_DELETE_SYSUSER "$INSTALL_USER")"
    say ""
    c_warn "$(t LIFECYCLE_UNINSTALL_PASSWORD_WARNING)"
    say ""
    if confirm "$(t LIFECYCLE_UNINSTALL_CONFIRM)"; then
        c_warn "$(t LIFECYCLE_UNINSTALL_BACKUP_EXISTS_WARNING "$BACKUP_DIR")"
        rm -rf "${APP_DIR:?}" "${DATA_DIR:?}" "${ENV_DIR:?}" "${SECRETS_DIR:?}" "${TRUST_DIR:?}" \
               "${LOG_DIR:?}" "${BASE_DIR:?}/staging" "$GETTING_STARTED"
        LOG_FILE=""
        rmdir "$LOCAL_DIR" 2>/dev/null || true
        id -u "$INSTALL_USER" &>/dev/null && { userdel -r "$INSTALL_USER" 2>/dev/null || userdel "$INSTALL_USER" 2>/dev/null || true; }
        c_ok "$(t LIFECYCLE_UNINSTALL_REMOVED)"
        say ""
        c_warn "$(t LIFECYCLE_UNINSTALL_BACKUP_REMAINS "$BACKUP_DIR")"
    else
        c_warn "$(t LIFECYCLE_UNINSTALL_KEPT_NOTHING_DELETED)"
    fi
}

# ═════════════════════════════════════════════════════════════════════════════
# Passwortschutz zurücksetzen (Notausgang bei vergessenem Passwort)
# ═════════════════════════════════════════════════════════════════════════════
# Der gezielte Reset lief bisher ausschließlich über
# "node bin/reset-settings-password.js" (siehe dort für die Begründung, warum
# das bewusst NICHT über die Web-API läuft) — hier nur als regulärer
# setup.sh-Befehl verdrahtet, damit der Notausgang nicht an einer Doku-Fußnote
# hängt, sondern über dieselbe Oberfläche wie jede andere Lifecycle-Aktion
# erreichbar ist. Wirkung unverändert: löscht ausschließlich die eine Zeile in
# site_auth (settings.db), keine Bot-Daten/-Konfiguration, kein Voll-Wipe.
do_reset_password() {
    step "$(t LIFECYCLE_RESET_PASSWORD_STEP)"
    [[ -f "$INSTALL_MARKER" ]] && die "$(t LIFECYCLE_INCOMPLETE_BLOCKS_ACTION "$0")"
    [[ -d "$APP_DIR" ]] || die "$(t LIFECYCLE_REPAIR_NOT_INSTALLED "$APP_DIR")"
    confirm "$(t LIFECYCLE_RESET_PASSWORD_CONFIRM)" || { say "  $(t LIFECYCLE_ABORTED)"; return 0; }
    local out
    out=$(sudo -u "$INSTALL_USER" node "$APP_DIR/bin/reset-settings-password.js" 2>&1) || die "$out"
    say "  $out"
}

# ═════════════════════════════════════════════════════════════════════════════
# Repair (nur nicht-destruktive Schritte erneut anwenden)
# ═════════════════════════════════════════════════════════════════════════════
# Bewusst OHNE do_npm: Repair soll ein schneller Reflex bleiben, wenn Units/
# Cron/Logrotate/Dateirechte manuell verändert oder beschädigt wurden — nicht
# Wallets/Daten/Code anfassen und nicht auf ein npm install warten. Wer
# node_modules neu braucht, nutzt gezielt 'update'.
do_repair() {
    step "$(t LIFECYCLE_REPAIR_STEP)"
    guard_legacy repair
    [[ -f "$INSTALL_MARKER" ]] && die "$(t LIFECYCLE_INCOMPLETE_BLOCKS_ACTION "$0")"
    [[ -d "$APP_DIR" ]] || die "$(t LIFECYCLE_REPAIR_NOT_INSTALLED "$APP_DIR")"
    do_services
    do_cron
    do_logrotate
    # Regeneriert auch die sudoers-Regel (Cmnd_Alias FORGE_SYSTEMCTL/FORGE_UPDATE_*) —
    # do_update() ruft do_user() bewusst nicht auf, ein Repair ist damit der einzige
    # Weg, mit dem eine bereits laufende Installation eine NEU eingeführte
    # sudoers-Regel nachträglich bekommt (z.B. System > Updates im Webinterface).
    do_user
    fix_ownership
    c_ok "$(t LIFECYCLE_REPAIR_DONE)"
    do_status
}

# ─── Migrationen ──────────────────────────────────────────────────────────────
#
# Datenkorrekturen, die eine neue Programmversion voraussetzt (bin/migrate.js).
# Läuft nach dem Deploy und VOR dem Start der Dienste: Die Bots sollen bereits mit
# den korrigierten Werten hochkommen.
#
# 🔒 Bewusst OHNE --financial. Migrationen, die eine Position schließen oder Kapital
#    bewegen können, laufen nie automatisch — sie werden hier nur gemeldet und warten
#    auf eine bewusste Entscheidung (node bin/migrate.js --apply --financial).
#    Ein Update darf niemals ungefragt Kapital bewegen.
# Einmal-VACUUM (CORE#000837): DELETE gibt in SQLite keinen Platz ans Dateisystem zurück, eine
# durch Retention geleerte DB behält ihre Größe. Läuft nach dem Dienststopp und den Migrationen,
# VOR dem Neustart (VACUUM sperrt exklusiv). Schwelle und Platzprüfung stecken in bin/db-vacuum.js
# (config/db-retention.json → vacuum). Best-effort: ein Fehler hier darf das Update nie abbrechen,
# die DB bleibt dann unverändert und das Backup von oben liegt vor.
vacuum_bloated_dbs() {
    [[ -f "$APP_DIR/bin/db-vacuum.js" ]] || return 0
    say "  $(t LIFECYCLE_VACUUM_STEP)"
    local out rc=0
    out=$(sudo -u "$INSTALL_USER" bash -c "cd '$APP_DIR' && node bin/db-vacuum.js --apply" 2>&1) || rc=$?
    sed 's/^/  /' <<< "$out"
    if [[ "$rc" -eq 2 ]]; then
        c_warn "$(t LIFECYCLE_VACUUM_INTEGRITY_FAILED)"
    elif [[ "$rc" -ne 0 ]]; then
        c_warn "$(t LIFECYCLE_VACUUM_FAILED "$rc")"
    fi
}

run_migrations() {
    [[ -f "$APP_DIR/bin/migrate.js" ]] || return 0

    local out
    out=$(sudo -u "$INSTALL_USER" bash -c "cd '$APP_DIR' && node bin/migrate.js --apply" 2>&1) || true

    if grep -q "Zurückgestellt" <<< "$out"; then
        c_warn "$(t LIFECYCLE_MIGRATIONS_DEFERRED)"
        sed -n '/Zurückgestellt/,$p' <<< "$out" | sed 's/^/    /'
        say "$(t LIFECYCLE_MIGRATIONS_DEFERRED_HINT)"
    elif grep -qE "^\s+✓ [0-9]{4}-" <<< "$out"; then
        say "  $(t LIFECYCLE_MIGRATIONS_APPLIED)"
        grep -E "^\s+✓ [0-9]{4}-" <<< "$out" | sed 's/^/  /'
    fi
}

# Verbucht alle bekannten Migrationen als erledigt, ohne sie auszuführen (Neuinstallation).
baseline_migrations() {
    [[ -f "$APP_DIR/bin/migrate.js" ]] || return 0
    sudo -u "$INSTALL_USER" bash -c "cd '$APP_DIR' && node bin/migrate.js --baseline" >/dev/null 2>&1 || true
}
