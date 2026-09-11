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
        say "$(t DEPLOY_TRUST_ANCHOR_EXISTS "$dst")"
        return 0
    fi
    if [[ ! -f "$src" ]]; then
        c_warn "$(t DEPLOY_TRUST_ANCHOR_MISSING "$src")"
        return 0
    fi
    cp "$src" "$dst"
    chmod 600 "$dst"
    chown "$INSTALL_USER:$INSTALL_USER" "$dst" 2>/dev/null || true
    c_ok "$(t DEPLOY_TRUST_ANCHOR_CREATED "$dst")"
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
    grep -m1 '^VersionCode:' "$file" 2>/dev/null | awk '{print $2}' || true
}

archive_current_code() {
    local code
    code=$(version_code_of "$APP_DIR/VERSION")
    if [[ -z "$code" ]]; then
        c_warn "$(t DEPLOY_ARCHIVE_NO_VERSIONCODE)"
        return 0
    fi
    local dir="$VERSIONS_DIR/v$code"
    if [[ -f "$dir/app.tgz" ]]; then
        say "$(t DEPLOY_ARCHIVE_EXISTS "$code")"
        return 0
    fi
    mkdir -p "$dir"
    say "$(t DEPLOY_ARCHIVE_SAVING "$code" "$dir/app.tgz")"
    # Exit-Code 1 bei GNU tar heißt nur "Datei hat sich während des
    # Archivierens geändert" (aktiv schreibender Bot) — Archiv ist trotzdem
    # vollständig, siehe do_backup() oben für den identischen Fund. Der
    # zweite tar-Aufruf (ohne --exclude) ist der Fallback für den Fall, dass
    # --exclude selbst fehlschlägt (z.B. sehr alte tar-Version), nicht für
    # den Schreibkollisions-Fall — sonst würde bei anhaltend aktivem Bot der
    # zweite, teurere Lauf (inkl. node_modules) ebenfalls an derselben
    # Kollision scheitern.
    local rc=0
    tar czf "$dir/app.tgz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")" --exclude=node_modules 2>/dev/null || rc=$?
    if [[ "$rc" -gt 1 ]]; then
        rc=0
        tar czf "$dir/app.tgz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")" || rc=$?
    fi
    [[ "$rc" -le 1 ]] || die "$(t DEPLOY_BACKUP_TAR_FAILED "$rc")"
    [[ "$rc" -eq 1 ]] && c_warn "$(t DEPLOY_BACKUP_TAR_CHANGED_WARN)"
    chmod 600 "$dir/app.tgz"
    c_ok "$(t DEPLOY_ARCHIVE_CREATED "$dir/app.tgz" "$(du -h "$dir/app.tgz" | cut -f1)")"

    local alt
    alt=$(ls -1d "$VERSIONS_DIR"/v* 2>/dev/null | sed 's#.*/v##' | sort -rn | tail -n +$((VERSIONS_RETENTION + 1)) || true)
    if [[ -n "$alt" ]]; then
        local n=0
        for v in $alt; do rm -rf "$VERSIONS_DIR/v$v"; n=$((n + 1)); done
        c_ok "$(t DEPLOY_ARCHIVE_PRUNED "$n" "$VERSIONS_RETENTION")"
    fi
}

do_rollback_code() {
    step "$(t DEPLOY_ROLLBACK_STEP)"
    guard_legacy rollback-code
    if [[ -z "$(ls -A "$VERSIONS_DIR" 2>/dev/null)" ]]; then
        die "$(t DEPLOY_ROLLBACK_NO_ARCHIVES "$VERSIONS_DIR")"
    fi
    local target="$OPT_ROLLBACK_VERSION"
    if [[ -z "$target" ]]; then
        target=$(ls -1d "$VERSIONS_DIR"/v* 2>/dev/null | sed 's#.*/v##' | sort -rn | head -1 || true)
        say "$(t DEPLOY_ROLLBACK_NO_VERSION_GIVEN "$target")"
    fi
    local archive="$VERSIONS_DIR/v$target/app.tgz"
    [[ -f "$archive" ]] || die "$(t DEPLOY_ROLLBACK_ARCHIVE_MISSING "$target" "$archive" "$(ls -1d "$VERSIONS_DIR"/v* 2>/dev/null | sed 's#.*/v#v#' | tr '\n' ' ' || true)")"

    local aktuell_code; aktuell_code=$(version_code_of "$APP_DIR/VERSION")
    say "$(t DEPLOY_ROLLBACK_CURRENT "${aktuell_code:-$(t DEPLOY_UNKNOWN)}")"
    say "$(t DEPLOY_ROLLBACK_TARGET "$target")"
    c_warn "$(t DEPLOY_ROLLBACK_WARN_SCOPE)"
    c_warn "$(t DEPLOY_ROLLBACK_WARN_MIGRATION_1 "$target")"
    c_warn "$(t DEPLOY_ROLLBACK_WARN_MIGRATION_2)"
    c_warn "$(t DEPLOY_ROLLBACK_WARN_MIGRATION_3)"
    confirm "$(t DEPLOY_ROLLBACK_CONFIRM "$target")" || { say "$(t DEPLOY_ABORTED)"; return 0; }

    archive_current_code

    say "$(t DEPLOY_ROLLBACK_STOPPING_SERVICES)"
    systemctl stop "${SERVICES[@]}" 2>/dev/null || true
    rm -rf "${APP_DIR:?}"
    mkdir -p "$APP_DIR"
    tar xzf "$archive" -C "$(dirname "$APP_DIR")"
    fix_ownership
    say "$(t DEPLOY_ROLLBACK_NPM_INSTALL)"
    do_npm
    do_services
    do_cron
    do_logrotate
    say "$(t DEPLOY_ROLLBACK_STARTING_SERVICES)"
    systemctl start forge-nexus forge-premium forge-settings forge-settings-daemon 2>/dev/null || true
    sleep 3
    systemctl start forge-liquiditybot forge-lendingbot 2>/dev/null || true
    c_ok "$(t DEPLOY_ROLLBACK_DONE "$target")"
    do_status
}

# ═════════════════════════════════════════════════════════════════════════════
# Backup / Restore
# ═════════════════════════════════════════════════════════════════════════════
app_version() {
    [[ -f "$APP_DIR/VERSION" ]] || { echo "unbekannt"; return; }
    grep '^Version:' "$APP_DIR/VERSION" | head -1 | sed 's/^Version:[[:space:]]*//' || echo "unbekannt"
}

do_backup() {
    step "$(t DEPLOY_BACKUP_STEP)"
    ensure_dirs
    [[ -n "$(ls -A "$LOCAL_DIR" 2>/dev/null)" ]] || {
        c_warn "$(t DEPLOY_BACKUP_NOTHING "$LOCAL_DIR")"; return 0; }

    local backup_local_dir="$BACKUP_DIR/local"
    mkdir -p "$backup_local_dir"
    local version; version="$(app_version)"
    local file="$backup_local_dir/$(date +%Y%m%d-%H%M)-${version}-local.tgz"
    local stamp="$LOCAL_DIR/VERSION-STAMP"
    { echo "gesichert: $(date '+%Y-%m-%d %H:%M:%S %Z')"
      echo "version:   $version"
    } > "$stamp"

    say "$(t DEPLOY_BACKUP_SAVING "$file")"
    # Exit-Code 1 bei GNU tar heißt laut Doku nur "Datei hat sich während des
    # Archivierens geändert" (z.B. ein Bot schreibt gerade in seine SQLite-DB
    # unter local/data/) — das Archiv ist trotzdem vollständig, nur die
    # betroffene Datei spiegelt evtl. nicht den allerletzten Stand. Unter
    # set -e würde das sonst das gesamte Update-Script abbrechen (beobachtet
    # 2026-08-31, Rollout auf forge-pub1, v0.9.11+75). Exit-Code 2+ bleibt ein
    # echter Fatal Error und bricht weiterhin ab.
    tar czf "$file" -C "$BASE_DIR" local || {
        local rc=$?
        [[ "$rc" -eq 1 ]] || die "$(t DEPLOY_BACKUP_TAR_FAILED "$rc")"
        c_warn "$(t DEPLOY_BACKUP_TAR_CHANGED_WARN)"
    }
    chmod 600 "$file"
    rm -f "$stamp"
    c_ok "$(t DEPLOY_BACKUP_CREATED "$file" "$(du -h "$file" | cut -f1)")"

    local alt
    alt=$(ls -1t "$backup_local_dir"/*-local.tgz 2>/dev/null | tail -n +$((BACKUP_RETENTION + 1)) || true)
    if [[ -n "$alt" ]]; then
        echo "$alt" | xargs -r rm -f
        c_ok "$(t DEPLOY_BACKUP_PRUNED "$(echo "$alt" | wc -l)" "$BACKUP_RETENTION")"
    fi
    [[ "$JSON_OUT" -eq 1 ]] && echo "{\"ok\":true,\"backup\":\"$file\"}"
    return 0
}

do_restore() {
    step "$(t DEPLOY_RESTORE_STEP)"
    local src="$OPT_RESTORE_FROM"
    if [[ -z "$src" ]]; then
        local neuestes
        neuestes=$(ls -1t "$BACKUP_DIR/local"/*-local.tgz 2>/dev/null | head -1 || true)
        [[ -n "$neuestes" ]] || die "$(t DEPLOY_RESTORE_NO_BACKUP "$BACKUP_DIR/local")"
        say "$(t DEPLOY_RESTORE_LATEST "$neuestes")"
        c_warn "$(t DEPLOY_RESTORE_REPLACES_WARNING)"
        confirm "$(t DEPLOY_RESTORE_CONFIRM)" || { say "$(t DEPLOY_ABORTED)"; return 0; }
        src="$neuestes"
    fi
    [[ -f "$src" ]] || die "$(t DEPLOY_RESTORE_FILE_MISSING "$src")"

    say "$(t DEPLOY_RESTORE_STOPPING_SERVICES)"
    systemctl stop "${SERVICES[@]}" 2>/dev/null || true
    do_backup
    say "$(t DEPLOY_RESTORE_EXTRACTING "$src")"
    rm -rf "${LOCAL_DIR:?}"
    tar xzf "$src" -C "$BASE_DIR"
    if [[ -f "$LOCAL_DIR/VERSION-STAMP" ]]; then
        say "$(t DEPLOY_RESTORE_ARCHIVE_INFO)"; sed 's/^/    /' "$LOCAL_DIR/VERSION-STAMP"
        local jetzt; jetzt="$(app_version)"
        grep -q "version:   $jetzt" "$LOCAL_DIR/VERSION-STAMP" \
            || c_warn "$(t DEPLOY_RESTORE_VERSION_MISMATCH "$jetzt")"
        rm -f "$LOCAL_DIR/VERSION-STAMP"
    fi
    fix_ownership
    say "$(t DEPLOY_RESTORE_STARTING_SERVICES)"
    systemctl start "${SERVICES[@]}" 2>/dev/null || true
    c_ok "$(t DEPLOY_RESTORE_DONE)"
}

# ═════════════════════════════════════════════════════════════════════════════
# Dateien deployen
# ═════════════════════════════════════════════════════════════════════════════
do_deploy() {
    step "$(t DEPLOY_DEPLOY_STEP "$APP_DIR")"
    [[ -f "$ARTIFACT_DIR/package.json" ]] || die "$(t DEPLOY_DEPLOY_NO_PACKAGE_JSON "$ARTIFACT_DIR")"
    if [[ "$(cd "$ARTIFACT_DIR" && pwd -P)" == "$(cd "$APP_DIR" 2>/dev/null && pwd -P)" ]]; then
        die "$(t DEPLOY_DEPLOY_SAME_DIR "$APP_DIR")"
    fi
    ensure_dirs

    # node_modules über das rm -rf hinwegretten (2026-08-10).
    #
    # Warum das rm -rf überhaupt sein muss: nur so ist garantiert, dass Dateien,
    # die in der neuen Version ENTFALLEN sind, nicht als Altlast liegenbleiben.
    # node_modules ist dabei aber reiner Kollateralschaden – es gehört gar nicht
    # zum Artefakt, es liegt nur zufällig unterhalb von app/. Ergebnis vorher:
    # ~860 MB Abhängigkeiten wurden bei JEDEM Update gelöscht und neu installiert,
    # inklusive Neukompilierung der nativen Module (better-sqlite3) – der mit
    # Abstand teuerste Schritt des ganzen Updates (gemessen: 84 s von 204 s).
    # Die Wiederverwendung ist unkritisch, weil do_npm() danach anhand eines
    # Fingerabdrucks entscheidet, ob doch installiert werden muss.
    local nm_stash="$BASE_DIR/.deps-cache"
    local nm_saved=0
    if [[ "$OPT_RENEW_DEPS" -eq 1 ]]; then
        say "$(t DEPLOY_DEPS_RENEW)"
    else
        rm -rf "$nm_stash"; mkdir -p "$nm_stash"
        for sub in "${NPM_SUBPROJECTS[@]}"; do
            local nm="$APP_DIR${sub:+/$sub}/node_modules"
            [[ -d "$nm" ]] || continue
            mkdir -p "$nm_stash/${sub:-.}"
            # mv statt cp: gleiches Dateisystem, also ein reines Umhängen (sofort).
            mv "$nm" "$nm_stash/${sub:-.}/node_modules" && nm_saved=$((nm_saved + 1))
        done
        [[ "$nm_saved" -gt 0 ]] && say "$(t DEPLOY_DEPS_STASHED "$nm_saved")"
    fi

    rm -rf "${APP_DIR:?}"
    mkdir -p "$APP_DIR"
    if command -v rsync &>/dev/null; then rsync -a "$ARTIFACT_DIR/" "$APP_DIR/"
    else cp -a "$ARTIFACT_DIR/." "$APP_DIR/"; fi

    if [[ "$nm_saved" -gt 0 ]]; then
        for sub in "${NPM_SUBPROJECTS[@]}"; do
            local src="$nm_stash/${sub:-.}/node_modules"
            local dst="$APP_DIR${sub:+/$sub}/node_modules"
            [[ -d "$src" ]] || continue
            # Unterprojekt in der neuen Version entfallen? Dann bleibt es weg.
            [[ -d "$(dirname "$dst")" ]] || { rm -rf "$src"; continue; }
            rm -rf "$dst"
            mv "$src" "$dst"
        done
        c_ok "$(t DEPLOY_DEPS_RESTORED "$nm_saved")"
    fi
    rm -rf "$nm_stash"

    fix_ownership
    c_ok "$(t DEPLOY_DEPLOY_COPIED "$(du -sh "$APP_DIR" | cut -f1)")"
}

# Fingerabdruck des Abhängigkeitsstands eines Unterprojekts.
#
# 🔒 Die Node-ABI-Version MUSS mit einfließen, nicht nur das Lockfile: alle sieben
# Unterprojekte nutzen better-sqlite3, also nativ kompilierten Code. Nach einem
# Node-Upgrade passt ein übernommenes node_modules nicht mehr ("was compiled
# against a different Node.js version") und JEDER Dienst stürzt beim Start ab.
# Ändert sich die ABI, ändert sich der Fingerabdruck und es wird sauber neu gebaut.
deps_fingerprint() {
    local dir="$1"
    local spec="$dir/package-lock.json"
    [[ -f "$spec" ]] || spec="$dir/package.json"
    printf '%s-abi%s' \
        "$(sha256sum "$spec" 2>/dev/null | cut -d' ' -f1)" \
        "$(node -p 'process.versions.modules' 2>/dev/null || echo unknown)"
}

do_npm() {
    step "$(t DEPLOY_NPM_STEP)"

    # Vorab prüfen, ob überhaupt etwas zu tun ist – sonst kostet allein das
    # Vorwärmen des node-gyp-Caches unnötig Zeit bei einem Update, das die
    # Abhängigkeiten gar nicht anfasst.
    local -a todo=()
    for sub in "${NPM_SUBPROJECTS[@]}"; do
        local d="$APP_DIR${sub:+/$sub}"
        [[ -f "$d/package.json" ]] || continue
        if [[ "$OPT_RENEW_DEPS" -eq 0 && -d "$d/node_modules" && -f "$d/node_modules/.forge-deps" ]] \
           && [[ "$(cat "$d/node_modules/.forge-deps" 2>/dev/null)" == "$(deps_fingerprint "$d")" ]]; then
            continue
        fi
        todo+=("$sub")
    done
    if [[ "${#todo[@]}" -eq 0 ]]; then
        c_ok "$(t DEPLOY_NPM_ALL_CURRENT)"
        return 0
    fi

    say "$(t DEPLOY_NPM_WARMING)"
    sudo -u "$INSTALL_USER" bash -c "cd '$APP_DIR' && npx --yes node-gyp install" >/dev/null 2>&1 \
        && c_ok "$(t DEPLOY_NPM_WARMED)" || c_warn "$(t DEPLOY_NPM_WARM_FAILED)"

    # Parallelität auf die tatsächliche Kernzahl begrenzen (Fund 2026-08-07,
    # forge-pub2: 2 Kerne/1,9 GB RAM). Vorher liefen alle sechs npm install
    # gleichzeitig los — auf schwacher Hardware bremsten sie sich damit
    # gegenseitig stärker aus, als --prefer-offline (s.o.) je einsparen konnte
    # (der eigentliche Engpass war CPU-Konkurrenz, nicht das Netzwerk). Auf
    # stärkerer Hardware (genug Kerne) greift die Grenze praktisch nie.
    local max_parallel
    max_parallel=$(nproc 2>/dev/null || echo 2)
    [[ "$max_parallel" -ge 1 ]] || max_parallel=1

    local logdir; logdir="$(mktemp -d)"
    declare -A pids
    for sub in "${todo[@]}"; do
        local dir="$APP_DIR${sub:+/$sub}" label="${sub:-.}"
        [[ -f "$dir/package.json" ]] || continue

        while [[ "$(jobs -rp | wc -l)" -ge "$max_parallel" ]]; do
            wait -n
        done

        say "$(t DEPLOY_NPM_INSTALLING "$label")"
        # --prefer-offline: npms eigener Paket-Cache liegt im Home-Verzeichnis von
        # $INSTALL_USER, NICHT unter app/. Die Metadaten kommen damit aus dem Cache
        # statt bei jedem Lauf neu über die Registry — spart Netzwerk-Rundlaufzeiten.
        # (Seit 2026-08-10 überlebt zusätzlich node_modules selbst den Deploy, siehe
        # do_deploy — dieser Schalter bleibt trotzdem sinnvoll für die Fälle, in
        # denen tatsächlich installiert werden muss.)
        #
        # Der Fingerabdruck wird ERST nach erfolgreichem npm install geschrieben
        # (&&, nicht ;): bricht die Installation ab, bleibt kein Stand zurück, der
        # beim nächsten Lauf fälschlich als "schon aktuell" durchgewunken würde.
        local fp; fp="$(deps_fingerprint "$dir")"
        sudo -u "$INSTALL_USER" bash -c "cd '$dir' && npm install --silent --prefer-offline && printf '%s' '$fp' > node_modules/.forge-deps" \
            < /dev/null > "$logdir/$(echo "$label" | tr '/' '_').log" 2>&1 &
        pids["$label"]=$!
    done
    local failed=0
    for label in "${!pids[@]}"; do
        if ! wait "${pids[$label]}"; then
            c_err "$(t DEPLOY_NPM_FAILED_IN "$label")"
            cat "$logdir/$(echo "$label" | tr '/' '_').log" >&2
            failed=1
        fi
    done
    rm -rf "$logdir"
    [[ "$failed" -eq 0 ]] || die "$(t DEPLOY_NPM_ONE_FAILED)"
    c_ok "$(t DEPLOY_NPM_ALL_DONE)"
}
