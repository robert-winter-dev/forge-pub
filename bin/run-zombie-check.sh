#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# FORGE – Zombie-NFT Cleanup (täglich 00:01)
# ══════════════════════════════════════════════════════════════════════════════
# Findet und verbrennt Orca-Position-NFTs, die nach einem Rebalancing im Wallet
# verblieben sind (Liquidität = 0 oder Dust). Läuft vollautomatisch mit --execute.
#
# Ablauf:
#   1. burn-zombie-nfts.js --include-dust --execute ausführen
#   2. Ergebnis auf stdout/stderr ausgeben
#   3. Telegram-Notification:
#      - Bei Zombies (erfolgreich geburnt): warn → Telegram ✅
#      - Bei Fehlern: warn → Telegram 🚨
#      - Bei sauberem Wallet: keine Telegram-Nachricht (kein Spam)
#
# Kein eigenes Logfile mehr (Fund 2026-08-05, forge-pub1): bin/forge-cron.js
# fängt stdout+stderr JEDES Cron-Jobs bereits automatisch und fork-sicher in
# <PATHS.logs>/cron/<job-id>.log auf (Master: FORGE/logs/cron/zombie-check.log,
# Fork: /opt/forge/log/cron/zombie-check.log – siehe forge-cron.js runJob()).
# Ein zusätzliches, selbst geschriebenes Log hier lief dem NIE fork-bewusst
# hinterher (fest verdrahtetes "${FORGE_ROOT}/logs", auf dem Fork also
# fälschlich unter app/logs/ statt log/ – app/ wird bei jedem Update ersetzt)
# und erzeugte am Ende zwei bis drei divergierende Kopien derselben Datei.
# Bei einem manuellen Aufruf AUSSERHALB von forge-cron.js (z.B. zum Testen)
# gibt es dadurch bewusst kein Logfile mehr, nur Terminal-Ausgabe.
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

FORGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIQUIDITY="${FORGE_ROOT}/bots/liquidity"

# Fork-Erkennung: identische Logik wie config/paths.js detectForkBase() (siehe
# emergency-exit.sh) — Code liegt unter <base>/app, persistente Daten unter
# <base>/local/data. Auf dem Master (kein 'app'-Verzeichnis als FORGE_ROOT)
# bleibt STATE_JSON unverändert bei FORGE_ROOT/data.
# Fund forge-pub#0287: STATE_JSON zeigte hier bisher fest auf
# ${FORGE_ROOT}/data (= app/data auf dem Fork, existiert seit der
# Verzeichnis-Restrukturierung nicht mehr) → Cron-Exit 1, obwohl der eigentliche
# Zombie-Check fehlerfrei lief.
DATA_DIR="${FORGE_ROOT}/data"
if [[ "$(basename "${FORGE_ROOT}")" == "app" && -d "$(dirname "${FORGE_ROOT}")/local" ]]; then
    DATA_DIR="$(dirname "${FORGE_ROOT}")/local/data"
fi
STATE_JSON="${FORGE_DATA_DIR:-${DATA_DIR}}/zombie-check-state.json"
NEXUS_URL="${NEXUS_URL:-http://localhost:3100}"

TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  FORGE Zombie-NFT Cleanup – ${TS}"
echo "══════════════════════════════════════════════════════════════"

OUT_FILE="$(mktemp)"
trap 'rm -f "${OUT_FILE}"' EXIT

if (cd "${LIQUIDITY}" && node bin/burn-zombie-nfts.js --full-close --execute) > "${OUT_FILE}" 2>&1; then
  EXIT_OK=1
else
  EXIT_OK=0
fi

cat "${OUT_FILE}"

# Auswertung aus Script-Output
COUNT="$(grep -oE 'Zombies gesamt: [0-9]+'       "${OUT_FILE}" | grep -oE '[0-9]+' | tail -1 || true)"
BURNED="$(grep -oE 'Fertig: [0-9]+'              "${OUT_FILE}" | grep -oE '[0-9]+' | tail -1 || true)"
FAILED="$(grep -c '❌ Fehler bei'                 "${OUT_FILE}" || true)"
SKIPPED="$(grep -c '⛔ SICHERHEIT'                "${OUT_FILE}" || true)"
COUNT="${COUNT:-0}"
BURNED="${BURNED:-0}"
FAILED="${FAILED:-0}"
SKIPPED="${SKIPPED:-0}"

if [[ "${EXIT_OK}" -eq 0 ]]; then
  # burn-zombie-nfts.js prüft SOL VOR dem ersten Burn (assertSufficientSol) und bricht
  # dann sauber ab (Exit 1, kein Crash) — jede gefundene Zombie-Position steht dann als
  # [burn-pending] im Output. Nur in diesem Fall die spezifische Pool-Tabelle senden;
  # jeder andere Script-Crash (kein [burn-pending] vorhanden) bleibt bei der generischen
  # Meldung, weil die Ursache dann unbekannt ist.
  ROWS=""
  while IFS= read -r LINE; do
    [[ -z "${LINE}" ]] && continue
    POOL="$(sed -n 's/.*pool=\(.*\) mint=.*/\1/p' <<<"${LINE}")"
    [[ -z "${POOL}" ]] && continue
    ROWS="${ROWS}| ${POOL} | ❌ | zu wenig SOL, wiederhole es morgen |
"
  done < <(grep '^\[burn-pending\]' "${OUT_FILE}" | sort -u)

  if [[ -z "${ROWS}" ]]; then
    MSG="Zombie-NFT-Cleanup fehlgeschlagen (Script-Exit != 0) — siehe Cron-Log zombie-check"
    echo "  ✗ ${MSG}"
    curl -s -X POST "${NEXUS_URL}/notify" \
      -H 'Content-Type: application/json' \
      -d "{\"botId\":\"liquidity\",\"level\":\"warn\",\"category\":\"zombie-check\",\"message\":\"🚨 ${MSG}\"}" \
      >/dev/null 2>&1 || true
  fi

elif [[ "${COUNT}" -gt 0 ]]; then
  # Vereinheitlichtes Format (seit 2026-08-29, Festlegung): erfolgreiche
  # ([burn-result]) und fehlgeschlagene ([burn-fail]) Einzel-Burns in EINER Tabelle
  # statt getrennter Text-Varianten für "alles ok" / "teilweise Fehler" — bis dahin
  # sah dieselbe Nachricht je nach Ausgang komplett verschieden aus (Master zeigte nur
  # die Aggregatzahl "2/4 geburnt — 2 Fehler", pub1 die Pool-Liste der Erfolge).
  ROWS=""
  TOTAL_RENT="0"
  while IFS= read -r LINE; do
    [[ -z "${LINE}" ]] && continue
    POOL="$(sed -n 's/.*pool=\(.*\) mint=.*/\1/p' <<<"${LINE}")"
    RENT="$(sed -n 's/.*rentSol=\(.*\)$/\1/p' <<<"${LINE}")"
    [[ -z "${POOL}" ]] && continue
    ROWS="${ROWS}| ${POOL} | ✅ | ${RENT} SOL |
"
    TOTAL_RENT="$(awk -v a="${TOTAL_RENT}" -v b="${RENT}" 'BEGIN{printf "%.5f", a+b}')"
  done < <(grep '^\[burn-result\]' "${OUT_FILE}")

  while IFS= read -r LINE; do
    [[ -z "${LINE}" ]] && continue
    POOL="$(sed -n 's/.*pool=\(.*\) mint=.*/\1/p' <<<"${LINE}")"
    REASON="$(sed -n 's/.*reason=\(.*\)$/\1/p' <<<"${LINE}")"
    [[ -z "${POOL}" ]] && continue
    ROWS="${ROWS}| ${POOL} | ❌ | ${REASON:-Fehler} |
"
  done < <(grep '^\[burn-fail\]' "${OUT_FILE}")

  if [[ -n "${ROWS}" ]]; then
    LEVEL="info"
    ICON="🔥"
    if [[ "${FAILED}" -gt 0 ]]; then
      LEVEL="warn"
      ICON="⚠️"
    fi
    MSG="Info: Fees geschlossener Pools

Folgende Fees eines oder mehrerer geschlossener Pools wurde versucht abzuholen:

\`\`\`
| Pool | Status | Ergebnis |
|------|:------:|---------:|
${ROWS}\`\`\`

Im heutigen Nachtlauf wurden ${TOTAL_RENT} SOL bereits geschlossener Pools abgeholt."
    echo "  ${MSG}"
    curl -s -X POST "${NEXUS_URL}/notify" \
      -H 'Content-Type: application/json' \
      -d "$(printf '{"botId":"liquidity","level":"%s","category":"zombie-check","message":"%s %s"}' "${LEVEL}" "${ICON}" "${MSG//$'\n'/\\n}")" \
      >/dev/null 2>&1 || true
  fi

  if [[ "${SKIPPED}" -gt 0 ]]; then
    MSG="⚠️ ${SKIPPED} NFT(s) mit Liquidität übersprungen (manuelle Prüfung nötig)"
    echo "  ⚠ ${MSG}"
    curl -s -X POST "${NEXUS_URL}/notify" \
      -H 'Content-Type: application/json' \
      -d "{\"botId\":\"liquidity\",\"level\":\"warn\",\"category\":\"zombie-check\",\"message\":\"⚠️ ${MSG}\"}" \
      >/dev/null 2>&1 || true
  fi

else
  if [[ "${SKIPPED}" -gt 0 ]]; then
    MSG="Keine Zombies — aber ${SKIPPED} NFT(s) mit Liquidität übersprungen (manuelle Prüfung nötig)"
    echo "  ⚠ ${MSG}"
    curl -s -X POST "${NEXUS_URL}/notify" \
      -H 'Content-Type: application/json' \
      -d "{\"botId\":\"liquidity\",\"level\":\"warn\",\"category\":\"zombie-check\",\"message\":\"⚠️ ${MSG}\"}" \
      >/dev/null 2>&1 || true
  else
    echo "  ✓ Keine Zombies — Wallet sauber"
  fi
fi

# State-JSON für forge-check.js schreiben
cat > "${STATE_JSON}" <<JSON
{
  "lastRun": "${TS}",
  "lastRunTs": $(date +%s%3N),
  "count": ${COUNT},
  "burned": ${BURNED},
  "failed": ${FAILED},
  "skipped": ${SKIPPED},
  "ok": $([ "${EXIT_OK}" -eq 1 ] && echo "true" || echo "false")
}
JSON
