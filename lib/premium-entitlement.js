/**
 * FORGE public Premium – ist diese Installation zur Premium-Nutzung BERECHTIGT? (FORK)
 *
 * Eine Frage, ein Ort. Konsument ist heute die Premium-Ende-Rücknahme
 * (`rollbackStrategyOnPremiumLoss()` in bots/settings/lib/strategy-apply.js) und die
 * Anzeige-Sperre der Strategie-Auswahl (`GET /api/premium/status` → `entitled`).
 *
 * ─── Warum diese Datei existiert (LIQ#0388) ──────────────────────────────────
 * Die Rücknahme hing bis hierher an `isAutoPayEnabled()` — dem AUTOPAY-Schalter
 * (`premium_settings.enabled`, lib/premium-auto-pay-store.js). Das beantwortet
 * „zahlt dieser Host stündlich USDC?", nicht „darf dieser Host Premium nutzen?".
 * Die beiden Größen sind unabhängig: `forge-pub1` ist über die Systemdaten-Freigabe
 * berechtigt, sein Autopay ist seit 2026-08-13 aus (Zahl-Wallet leergelaufen). Der
 * alte Auslöser hätte dort eine berechtigte Strategie beim nächsten Cron-Tick
 * zurückgesetzt.
 *
 * ─── Die Berechtigung ist die DECKUNG, nicht der Token ───────────────────────
 * `getMyActivationToken()` (lib/premium-token-store.js) taugt allein NICHT als
 * Kriterium: Der Token steht in einer eingehenden Nostr-DM, die nie gelöscht wird.
 * Widerruft der Master serverseitig, erfährt der Fork davon nichts — „Token fehlt"
 * feuert praktisch nur bei „nie aktiviert".
 *
 * Belastbar ist stattdessen `getPremiumCoverage()` (lib/premium-wallet.js): bezahlte
 * Stunden (`premium_pay_log`) UND gelieferte Stunden (`premium_ingest_state`), es
 * gewinnt der spätere Zeitpunkt. Das ist selbst-belegend — der Master liefert
 * ausschließlich an Zahler der Stunde oder an freigeschaltete npubs
 * (core/premium/deliver-blob.js). Kein lokales Flag, dem man vertrauen müsste.
 * Siehe auch den Kopf von lib/health-share-state.js: „Ob Premium tatsächlich läuft,
 * entscheidet allein, ob Daten ankommen."
 *
 * 🔒 ─── Fail-SAFE, nicht fail-closed ─────────────────────────────────────────
 * `core/premium/health-share-allowlist.js` ist ausdrücklich fail-closed: Dort
 * verschenkt ein falsches `true` Premium an alle. HIER ist es umgekehrt. Ein
 * falsches `false` löst eine Rücknahme aus, die auf FREMDES LIVE-KAPITAL schreibt
 * und laut Regel 4 aus LIQ#0382 nie automatisch rückgängig gemacht wird. Jeder
 * Zweifelsfall liefert deshalb `entitled: true`.
 */

import { getMyActivationToken } from './premium-token-store.js';
import { getPremiumCoverage } from './premium-wallet.js';

/**
 * Nachlauf, bevor eine ausgelaufene Deckung als „Berechtigung beendet" gilt.
 *
 * 🔒 Ohne diesen Nachlauf wäre der Auslöser ein AUSFALL-Detektor statt eines
 * Berechtigungs-Detektors: `coveredUntilMs` wird binnen einer Stunde alt, sobald
 * irgendetwas hakt (Relay-Abbruch, Master-Wartung, gestoppter Liquidity Bot).
 *
 * Die Kosten sind asymmetrisch, deshalb ist die Zahl großzügig:
 *   - zu SPÄT auslösen kostet nichts. Die Strategie läuft unverändert weiter — genau
 *     der „Einfrieren"-Zustand aus Entscheidung 6, der vor LIQ#0382 monatelang der
 *     Normalfall war.
 *   - zu FRÜH auslösen schreibt auf Live-Kapital und wird nie zurückgenommen.
 *
 * 72 h liegt weit über allem, was FORGE sonst als Störung einstuft (Blob-Health
 * 2 h in core/premium/blob-health-check.js, `LAPSE_AFTER_MS` 90 min in
 * core/premium/health-share-allowlist.js) und übersteht ein volles Wochenende.
 */
export const ENTITLEMENT_GRACE_MS = 72 * 60 * 60 * 1000;

/**
 * Die reine Entscheidung — KEIN DB-Zugriff, damit sie einzeln prüfbar ist
 * (bin/test-strategy-premium-rollback.js). Genau deshalb taucht der Autopay-Schalter
 * in dieser Signatur nicht auf: Er kann strukturell nicht mehr einfließen.
 *
 * @param {object} input
 * @param {boolean} input.hasToken              ein Aktivierungs-Token liegt vor
 * @param {number|null} input.coveredUntilMs    Ende der letzten gedeckten Stunde (ms)
 * @param {number|null} input.activationReceivedAt  Zeitpunkt der Token-DM (ms)
 * @param {boolean} input.outagePaused          vorübergehende Störung (blob-health-check)
 * @param {number} input.now
 * @returns {{entitled: boolean, reason: 'outage'|'covered'|'grace'|'awaiting_first_delivery'
 *            |'never_activated'|'expired'}}
 */
export function decideEntitlement({
    hasToken, coveredUntilMs, activationReceivedAt, outagePaused, now,
}) {
    // 🔒 Regel 1 aus LIQ#0382, ab jetzt AUSDRÜCKLICH statt implizit: Solange die
    // Störung als vorübergehend erkannt ist, ist gar nichts entschieden. Vorher war
    // das nur dadurch gegeben, dass `outage_paused` eine andere Spalte als `enabled`
    // ist — mit der Deckung als Kriterium wäre eine Störung sonst binnen Stunden
    // von einem Berechtigungsende ununterscheidbar.
    if (outagePaused) return { entitled: true, reason: 'outage' };

    if (coveredUntilMs != null) {
        if (now < coveredUntilMs) return { entitled: true, reason: 'covered' };
        if (now < coveredUntilMs + ENTITLEMENT_GRACE_MS) return { entitled: true, reason: 'grace' };
        return { entitled: false, reason: 'expired' };
    }

    // Nie eine gedeckte Stunde gesehen. Ein frisch aktivierter Host wartet auf die
    // erste Lieferung — das ist kein Berechtigungsende, sondern ein Anfang.
    //
    // ⚠️ `activationReceivedAt` stammt aus `rumor.created_at` einer NIP-17-DM und ist
    // damit nur ungefähr: Absender randomisieren diesen Wert bewusst (siehe
    // core/premium/health-share-allowlist.js). Die Streuung liegt im Bereich von
    // Stunden bis ~2 Tagen und damit innerhalb des Nachlauffensters — ein in die
    // ZUKUNFT gerutschter Wert wird zusätzlich auf `now` gedeckelt, damit er die
    // Berechtigung nicht unbegrenzt verlängert.
    if (hasToken) {
        if (activationReceivedAt == null) return { entitled: true, reason: 'awaiting_first_delivery' };
        const since = Math.min(activationReceivedAt, now);
        return now < since + ENTITLEMENT_GRACE_MS
            ? { entitled: true, reason: 'awaiting_first_delivery' }
            : { entitled: false, reason: 'expired' };
    }

    return { entitled: false, reason: 'never_activated' };
}

/**
 * Dieselbe Entscheidung gegen die echten Speicher.
 *
 * Wirft nie: Kann einer der beiden Speicher nicht gelesen werden, gilt die
 * Installation als berechtigt (fail-safe, siehe Kopfkommentar) — eine unlesbare
 * premium.db darf keine Rücknahme auf Live-Kapital auslösen.
 *
 * @param {{now?: number}} [opts]
 * @returns {{entitled: boolean, reason: string}}
 */
export function hasPremiumEntitlement({ now = Date.now() } = {}) {
    let activation = null;
    try {
        activation = getMyActivationToken();
    } catch {
        // premium.db fehlt/nicht lesbar (Fork vor der ersten DM) — wie „kein Token".
    }

    let coverage;
    try {
        coverage = getPremiumCoverage();
    } catch {
        return { entitled: true, reason: 'unknown' };
    }

    return decideEntitlement({
        hasToken: activation != null,
        coveredUntilMs: coverage.coveredUntilMs ?? null,
        activationReceivedAt: activation?.receivedAt ?? null,
        outagePaused: coverage.outagePaused === true,
        now,
    });
}
