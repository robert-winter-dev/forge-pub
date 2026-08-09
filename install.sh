#!/bin/bash
# FORGE.pub – Installer-Einstiegspunkt
#
# Reiner Passthrough nach bin/setup.sh, damit ein Neuling nach dem Entpacken
# sofort eine Datei findet, ohne unter bin/ nachschauen zu müssen. Keine eigene
# Logik hier — alles Weitere (Menü, install/update/uninstall/...) lebt
# ausschließlich in bin/setup.sh, damit es nur eine einzige Quelle der Wahrheit
# gibt. 'exec' ersetzt den Prozess: ${BASH_SOURCE[0]} in setup.sh zeigt danach
# korrekt auf bin/setup.sh selbst, die ARTIFACT_DIR-Berechnung dort bleibt
# unverändert korrekt.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bin/setup.sh" "$@"
