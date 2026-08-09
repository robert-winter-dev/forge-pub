# ═════════════════════════════════════════════════════════════════════════════
# Interaktives Menü (nur bei Aufruf ohne Argument, siehe Dispatch am Dateiende)
# ═════════════════════════════════════════════════════════════════════════════
show_menu() {
    while true; do
        say ""
        say "═══════════════════════════════════════════════════════════"
        say "  $(t MENU_TITLE)"
        say "═══════════════════════════════════════════════════════════"
        say "  $(t MENU_ITEM_INSTALL)"
        say "  $(t MENU_ITEM_UPDATE)"
        say "  $(t MENU_ITEM_UNINSTALL)"
        say "  $(t MENU_ITEM_REPAIR)"
        say "  $(t MENU_ITEM_HELP)"
        say "  $(t MENU_ITEM_EXIT)"
        say ""
        local choice=""
        read -r -p "  $(t MENU_PROMPT) " choice || true

        local has_local_artifact=0
        [[ -f "$ARTIFACT_DIR/VERSION" ]] && [[ "$ARTIFACT_DIR" != "$APP_DIR" ]] && has_local_artifact=1

        case "$choice" in
            1)
                if [[ "$has_local_artifact" -eq 1 ]]; then
                    do_install
                else
                    say ""
                    say "  $(t MENU_INSTALL_NEEDS_ARTIFACT_1)"
                    say "  $(t MENU_INSTALL_NEEDS_ARTIFACT_2)"
                    say "  $(t MENU_INSTALL_NEEDS_ARTIFACT_3)"
                    say "    1. $(t MENU_INSTALL_NEEDS_ARTIFACT_STEP1)"
                    say "       $(t MENU_INSTALL_NEEDS_ARTIFACT_STEP1B)"
                    say "    2. cd ~/forge-pub/<entpackt> && sudo bash install.sh"
                    say "  $(t MENU_INSTALL_NEEDS_ARTIFACT_4)"
                fi
                ;;
            2)
                if [[ "$has_local_artifact" -eq 1 ]]; then
                    say ""
                    say "  $(t MENU_UPDATE_LOCAL_ARTIFACT)"
                    do_update
                else
                    say ""
                    say "  $(t MENU_UPDATE_CHECK_GITHUB)"
                    node "$APP_DIR/bin/update-check.js" --confirm
                fi
                ;;
            3)
                do_uninstall
                say ""
                c_ok "$(t MENU_UNINSTALL_DONE)"
                exit 0
                ;;
            4)
                do_repair
                ;;
            5)
                show_help
                read -r -p "  $(t MENU_CONTINUE_PROMPT) " _ || true
                ;;
            6)
                say "  $(t MENU_EXITED)"
                exit 0
                ;;
            *)
                c_warn "$(t MENU_INVALID_CHOICE)"
                ;;
        esac
    done
}
