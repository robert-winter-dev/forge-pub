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
  # [burn-pending] im Output. Nur in diesem Fall die spezifische Pool-Liste + SOL-Hinweis
  # senden; jeder andere Script-Crash (kein [burn-pending] vorhanden) bleibt bei der
  # generischen Meldung, weil die Ursache dann unbekannt ist.
  PENDING_POOLS="$(grep '^\[burn-pending\]' "${OUT_FILE}" | sed -n 's/.*pool=\(.*\) mint=.*/\1/p' | sort -u || true)"

  if [[ -n "${PENDING_POOLS}" ]]; then
    LIST=""
    while IFS= read -r POOL; do
      [[ -z "${POOL}" ]] && continue
      LIST="${LIST}* Pool: ${POOL}
"
    done <<<"${PENDING_POOLS}"
    MSG="Folgende Fees eines geschlossenen Pools konnten NICHT abgeholt werden:

${LIST}
Bitte überprüfe dein SOL Guthaben!"
    echo "  ✗ ${MSG}"
    curl -s -X POST "${NEXUS_URL}/notify" \
      -H 'Content-Type: application/json' \
      -d "$(printf '{"botId":"liquidity","level":"warn","category":"zombie-check","message":"🚨 %s"}' "${MSG//$'\n'/\\n}")" \
      >/dev/null 2>&1 || true
  else
    MSG="Zombie-NFT-Cleanup fehlgeschlagen (Script-Exit != 0) — siehe Cron-Log zombie-check"
    echo "  ✗ ${MSG}"
    curl -s -X POST "${NEXUS_URL}/notify" \
      -H 'Content-Type: application/json' \
      -d "{\"botId\":\"liquidity\",\"level\":\"warn\",\"category\":\"zombie-check\",\"message\":\"🚨 ${MSG}\"}" \
      >/dev/null 2>&1 || true
  fi

elif [[ "${COUNT}" -gt 0 && "${FAILED}" -gt 0 ]]; then
  SKIP_SUFFIX=""
  if [[ "${SKIPPED}" -gt 0 ]]; then
    SKIP_SUFFIX=" + ${SKIPPED} mit Liquidität übersprungen"
  fi
  MSG="${BURNED}/${COUNT} Zombie-NFT(s) geburnt — ${FAILED} Fehler${SKIP_SUFFIX}. Siehe Cron-Log zombie-check"
  echo "  ⚠ ${MSG}"
  curl -s -X POST "${NEXUS_URL}/notify" \
    -H 'Content-Type: application/json' \
    -d "{\"botId\":\"liquidity\",\"level\":\"warn\",\"category\":\"zombie-check\",\"message\":\"⚠️ ${MSG}\"}" \
    >/dev/null 2>&1 || true

elif [[ "${COUNT}" -gt 0 ]]; then
  echo "  ✓ ${BURNED}/${COUNT} Zombie-NFT(s) erfolgreich geburnt und Rent zurückgeholt"

  # Eine aggregierte Telegram-Notify statt einer pro Burn (bis 2026-08-28), damit
  # mehrere in einem Lauf geburnte Pools in EINER Liste erscheinen statt als
  # mehrere Einzelnachrichten. Level 'info' statt 'warn' (bis 2026-08-24 fälschlich
  # 'warn', siehe LIQ#0327): reiner Erfolgsfall, nichts zu tun.
  LIST=""
  while IFS= read -r LINE; do
    [[ -z "${LINE}" ]] && continue
    POOL="$(sed -n 's/.*pool=\(.*\) mint=.*/\1/p' <<<"${LINE}")"
    RENT="$(sed -n 's/.*rentSol=\(.*\)$/\1/p' <<<"${LINE}")"
    LIST="${LIST}* Pool: ${POOL}: ${RENT} SOL Rent zurückgeholt
"
  done < <(grep '^\[burn-result\]' "${OUT_FILE}")

  if [[ -n "${LIST}" ]]; then
    MSG="Folgende Fees eines geschlossenen Pools wurden abgeholt:

${LIST}"
    curl -s -X POST "${NEXUS_URL}/notify" \
      -H 'Content-Type: application/json' \
      -d "$(printf '{"botId":"liquidity","level":"info","category":"zombie-check","message":"🔥 %s"}' "${MSG//$'\n'/\\n}")" \
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
