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

# ═════════════════════════════════════════════════════════════════════════════
# Zusammenfassung neu erzeugter Secrets (Wallets + Nostr-Identität)
# ═════════════════════════════════════════════════════════════════════════════
# Vorher zeigte jeder neu erzeugte Wallet SOFORT seinen Private Key inline
# (3× "Kopie abgelegt unter ..." + eigener Bestätigungs-Prompt, verstreut über
# den Installationsverlauf, dazwischen liegen Wallet-Monitor/Adressbuch-Schritte
# und der komplett separate Nostr-Schritt). Jetzt wird nur noch ein leiser
# Fortschritts-Hinweis pro Secret ausgegeben (WALLET_GENERATING_NEW/
# NOSTR_IDENTITY_CREATED); die eigentliche Anzeige aller Keys + Pfade läuft
# gebündelt über print_secrets_summary() am Ende des jeweiligen Aufrufs
# (do_wallets/do_nostr einzeln, oder einmal gemeinsam nach do_nostr in
# do_install) — einfacher für den Nutzer zum Sichern/Copy-Paste in einem Zug.
SECRET_SUMMARY_TYPE=()
SECRET_SUMMARY_LABEL=()
SECRET_SUMMARY_ADDR=()
SECRET_SUMMARY_FILE=()

secret_summary_add() {
    # secret_summary_add <type: wallet|nostr> <label> <adresse/npub> <keyfile>
    SECRET_SUMMARY_TYPE+=("$1")
    SECRET_SUMMARY_LABEL+=("$2")
    SECRET_SUMMARY_ADDR+=("$3")
    SECRET_SUMMARY_FILE+=("$4")
}

# Der Datei-Hinweis (WALLET_KEY_COPY_SAVED) steht bewusst NUR EINMAL am Ende als
# gemeinsame Pfadliste, nicht mehr pro Wallet wiederholt (Fund 2026-08-07: bei
# drei Wallets + Nostr stand exakt derselbe Satz vier Mal hintereinander).
print_secrets_summary() {
    [[ ${#SECRET_SUMMARY_TYPE[@]} -eq 0 ]] && return 0
    local i
    say ""
    say "═══════════════════════════════════════════════════════════"
    say "  $(t SECRETS_SUMMARY_TITLE)"
    say "═══════════════════════════════════════════════════════════"
    say "$(t SECRETS_SUMMARY_INTRO)"
    for ((i = 0; i < ${#SECRET_SUMMARY_TYPE[@]}; i++)); do
        say ""
        say "  ── ${SECRET_SUMMARY_LABEL[$i]} ──"
        say "  $(t WALLET_PUBLIC_ADDRESS "${SECRET_SUMMARY_ADDR[$i]}")"
        if [[ "${SECRET_SUMMARY_TYPE[$i]}" == "wallet" ]]; then
            say "  $(t WALLET_PRIVATE_KEY_INTRO)"
            say "    $(cat "${SECRET_SUMMARY_FILE[$i]}")"
        fi
    done
    say ""
    say "$(t WALLET_KEY_COPY_SAVED)"
    for ((i = 0; i < ${#SECRET_SUMMARY_TYPE[@]}; i++)); do
        say "  ${SECRET_SUMMARY_LABEL[$i]}: ${SECRET_SUMMARY_FILE[$i]}"
    done
    say ""
    say "$(t WALLET_BACKUP_WARNING)"
    [[ "$INTERACTIVE" -eq 1 ]] && { read -r -p "$(t WALLET_CONFIRM_SAVED) " || true; }
    SECRET_SUMMARY_TYPE=(); SECRET_SUMMARY_LABEL=(); SECRET_SUMMARY_ADDR=(); SECRET_SUMMARY_FILE=()
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
' 2>/dev/null || c_warn "$(t WALLET_MONITOR_ADD_FAILED "$id")"
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
        && c_ok "$(t ADDRESSBOOK_ADDED "$name")" \
        || c_warn "$(t ADDRESSBOOK_ADD_FAILED "$name")"
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
    step "$(t STEP_WALLETS)"
    ensure_dirs
    local -A meta=(
        [liquidity]="Liquidity Bot|liquidity-wallet.json|Liquidity"
        [lending]="Lending Bot|lending-wallet.json|Lending"
        [premium]="Premium Service|premium-wallet.json|Premium Service"
    )
    IFS=',' read -ra gewuenscht <<< "$OPT_WALLETS"
    for w in "${gewuenscht[@]}"; do
        w="$(echo "$w" | xargs)"
        [[ -n "${meta[$w]:-}" ]] || { c_warn "$(t WALLET_UNKNOWN "$w")"; continue; }
        IFS='|' read -r label datei monitor <<< "${meta[$w]}"
        local keyfile="$SECRETS_DIR/$datei" pk=""

        if [[ -f "$keyfile" ]]; then
            pk=$(wallet_pubkey_of "$keyfile")
            [[ -n "$pk" ]] && c_ok "$(t WALLET_REUSED "$label" "$pk")" \
                           || c_err "$(t WALLET_FILE_UNREADABLE "$label" "$keyfile")"
        else
            pk=$(wallet_generate "$keyfile")
            if [[ -n "$pk" ]]; then
                c_ok "$(t WALLET_GENERATING_NEW "$label-Wallet")"
                secret_summary_add "wallet" "$label-Wallet" "$pk" "$keyfile"
            else
                c_err "$(t WALLET_GENERATION_FAILED "$label")"
            fi
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
    step "$(t STEP_NOSTR)"
    ensure_dirs
    local keyfile="$SECRETS_DIR/${NOSTR_IDENTITY_NAME}.json"
    if [[ -f "$keyfile" ]]; then
        c_ok "$(t NOSTR_IDENTITY_REUSED)"
        return 0
    fi
    # Keine Nachfrage — die meisten Nutzer wissen nicht, was Nostr ist, eine
    # Anzeigename-Frage würde nur verwirren. Fester Default, per --nostr-alias
    # weiterhin für Automatisierung/Fortgeschrittene überschreibbar.
    OPT_NOSTR_ALIAS="${OPT_NOSTR_ALIAS:-FORGE Public User}"
    local npub
    npub=$(cd "$APP_DIR" && sudo -u "$INSTALL_USER" env \
        NOSTR_SECRETS_DIR="$SECRETS_DIR" ALIAS="$OPT_NOSTR_ALIAS" IDNAME="$NOSTR_IDENTITY_NAME" \
        node --input-type=module -e "
import { createIdentity } from '$APP_DIR/lib/nostr-client.js';
console.log(createIdentity(process.env.IDNAME, { alias: process.env.ALIAS }).npub);
" 2>/dev/null) || true
    if [[ -n "$npub" ]]; then
        c_ok "$(t NOSTR_IDENTITY_CREATED "$npub")"
        secret_summary_add "nostr" "Nostr" "$npub" "$keyfile"
    else
        c_err "$(t NOSTR_IDENTITY_FAILED)"
    fi
}
