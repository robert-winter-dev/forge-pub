#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# FORGE – Emergency-Exit-Wrapper
# Ersatz für: node bin/emergency-exit.js <optionen>
#
# Reicht alle Argumente 1:1 an bin/emergency-exit.js durch. Der einzige Zweck:
# auf einer FORGE.pub-Fork-Installation gehören .env/Secrets dem Systemnutzer
# 'forge' (0600) — ein manueller Aufruf als der eigene Login-Nutzer (z.B. per
# SSH) scheitert sonst mit einem irreführenden "Pflichtfeld fehlt in .env:
# KEYPAIR_PATH", weil dotenv die Datei mangels Leserecht still ignoriert statt
# einen Fehler zu werfen (gefunden 2026-08-04, forge-pub1).
#
# WICHTIG, was dieses Script NICHT behebt: config/paths.js erkennt die Fork-
# Struktur bereits vollautomatisch am Layout (<base>/app + <base>/local,
# detectForkBase()) — dafür ist keine Environment-Variable nötig. Ein früherer
# Verdacht, FORGE_ENV_DIR müsse manuell gesetzt werden, war beim Nachprüfen
# falsch: isoliert getestet lief der Aufruf allein mit korrektem Nutzer (forge),
# ganz ohne die Variable. Dieses Script setzt sie deshalb bewusst NICHT — nur
# der fehlende sudo-Wechsel wird ergänzt.
#
# Nutzung: identisch zu bin/emergency-exit.js, siehe dessen Kopfkommentar.
#   bin/emergency-exit.sh --bot:liquiditybot --dry-run=C
#   bin/emergency-exit.sh --all
# ══════════════════════════════════════════════════════════════════════════════

set -uo pipefail

if command -v git >/dev/null 2>&1 \
   && FORGE_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)" \
   && [[ -n "$FORGE_ROOT" ]]; then
    :
else
    FORGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$FORGE_ROOT" || exit 1

# Fork-Erkennung: identische Logik wie config/paths.js detectForkBase() — Code
# liegt unter <base>/app, UND <base>/local existiert daneben. Auf dem Master
# (kein 'app'-Verzeichnis als FORGE_ROOT) bleibt der Aufruf unverändert, dort
# gehören .env/Secrets ohnehin dem eigenen Login-Nutzer.
BASENAME="$(basename "$FORGE_ROOT")"
PARENT_DIR="$(dirname "$FORGE_ROOT")"
IS_FORK=0
[[ "$BASENAME" == "app" && -d "$PARENT_DIR/local" ]] && IS_FORK=1

if [[ "$IS_FORK" -eq 1 && "$(id -un)" != "forge" && "$(id -u)" -ne 0 ]]; then
    exec sudo -u forge node bin/emergency-exit.js "$@"
fi

exec node bin/emergency-exit.js "$@"
