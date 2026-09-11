/**
 * /api/premium – FORGE public Premium-Service verwalten (Liquidity → Premium → Verwalten)
 *
 * GET  /status    → Wallet-Adresse, Guthaben, Restlaufzeit, Preis, Aktivierungsstatus,
 *                    Ein/Aus-Zustand (`enabled`) und Berechtigung (`entitled`, LIQ#0388). Läuft auf Master UND Fork (geteilte Datei!) —
 *                    auf dem Master liefert sie { available: false }, kein Fehler.
 * POST /enable     → schaltet die stündliche Auto-Zahlung frei (premium-pay.js darf
 *                    dann per Cron laufen) UND stößt sofort eine Zahlung für die
 *                    laufende Stunde an (siehe triggerImmediatePayment unten). NUR
 *                    Fork, sonst 403.
 * POST /disable    → schaltet sie wieder ab.
 *
 * Bewusst EIN eigener Ein/Aus-Schalter, getrennt von "existiert ein Aktivierungs-
 * Token": ein Kunde kann aktiviert sein (Token vorhanden), aber die automatische
 * Zahlung bewusst noch nicht freigeben wollen (z.B. um erst das Guthaben zu prüfen).
 * Kapital darf nie ohne diese ausdrückliche zweite Zustimmung bewegt werden — exakt
 * dasselbe Prinzip wie "Übernehmen != Kapitalfreigabe" bei Pool-Offers.
 */

import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PATHS } from '../../../config/paths.js';
import { isForkInstance } from '../../../lib/premium-identity-context.js';
import { walletExists, getPremiumPublicKey, fetchPremiumBalances, remainingServiceHours } from '../../../lib/premium-wallet.js';
import { getCurrentPricing } from '../../../lib/premium-pricing-store.js';
import { getMyActivationToken } from '../../../lib/premium-token-store.js';
import { isAutoPayEnabled, setAutoPayEnabled, setPayFailureNotified } from '../../../lib/premium-auto-pay-store.js';
import { hasPremiumEntitlement } from '../../../lib/premium-entitlement.js';
import { recordPremiumMessage } from '../../../core/premium/messages-db.js';
import { rollbackStrategyOnPremiumLoss } from '../lib/strategy-apply.js';
import { t } from '../../../lib/i18n.js';

const execFileAsync = promisify(execFile);
const router = Router();

/**
 * Stößt core/premium/premium-pay.js für die LAUFENDE Stunde an, statt auf den
 * nächsten Cron-Tick (Minute 5) zu warten. Vorfall 2026-08-01: ohne diesen Trigger
 * wartet ein Nutzer, der Premium gerade erst aktiviert, im schlimmsten Fall fast
 * eine volle Stunde auf die erste Score-Lieferung — inakzeptabel für einen Klick,
 * der "jetzt freischalten" bedeuten soll. premium-pay.js selbst bleibt unverändert
 * das manuell/per-Cron ausführbare Finanz-Skript (siehe dessen Kopfkommentar) —
 * hier wird es nur programmatisch mit denselben Voraussetzungen aufgerufen, die der
 * Cron-Lauf ohnehin hätte (Auto-Pay ist in DIESEM Request gerade erst freigeschaltet
 * worden, exakt dieselbe Nutzer-Zustimmung, die auch den künftigen Cron-Lauf trägt).
 * Idempotent (premium_pay_log) — ein doppelter Aufruf für dieselbe Stunde ist ein
 * harmloser, sauber gemeldeter Fehlschlag, keine zweite Zahlung.
 *
 * Bewusst SYNCHRON (der Client wartet auf das Ergebnis): eine Solana-Tx über die
 * Nexus-RPC-Queue braucht üblicherweise wenige Sekunden, das ist der Zeitpunkt, an
 * dem der Nutzer ohnehin auf eine Rückmeldung des "Aktivieren"-Buttons wartet.
 * Schlägt die Zahlung fehl (z.B. zu wenig USDC), bleibt der Ein/Aus-Schalter trotzdem
 * an (der Cron-Lauf versucht es zur nächsten vollen Stunde erneut) — der Fehler wird
 * nur zusätzlich sofort sichtbar gemacht statt erst nach bis zu einer Stunde Stille.
 */
async function triggerImmediatePayment() {
    const script = `${PATHS.core}/premium/premium-pay.js`;
    try {
        const { stdout } = await execFileAsync(process.execPath, [script, '--json'], { timeout: 25000 });
        return JSON.parse(stdout);
    } catch (err) {
        // premium-pay.js beendet sich bei jedem erwarteten Fehlschlag (kein Guthaben,
        // Stunde bereits bezahlt, …) mit exit 1 UND druckt trotzdem gültiges JSON auf
        // stdout (siehe fail() dort) – execFile wirft dann zwar, err.stdout trägt aber
        // die eigentliche, für den Nutzer lesbare Fehlermeldung.
        if (err.stdout) {
            try { return JSON.parse(err.stdout); } catch { /* fällt durch zu unten */ }
        }
        return { ok: false, error: err.killed ? t('api.premium.payment_timeout') : err.message };
    }
}

router.get('/status', async (_req, res) => {
    if (!isForkInstance()) {
        // Kein Fehler — der Master hat schlicht kein Premium-Wallet. Das Frontend
        // blendet den Menüpunkt in diesem Fall aus (siehe bot-liquidity.js), weil das
        // dort weiterhin an `available` hängt.
        //
        // enabled: true ist bewusst gesetzt (LIQ#0381, Variante A, 04.09.2026):
        // der Master ist der Urheber der Strategien, ein Premium-Gate gegen sich selbst
        // ist sinnlos. bot-liquidity.js _strategyRowHtml() sperrt die Strategie-Auswahl
        // NUR über `enabled` (nicht zusätzlich über `available`, siehe Kommentar dort) —
        // diese eine Zeile reicht deshalb aus, um den Master ohne Premium-Wallet
        // freizuschalten, ohne das Fork-Gate anzufassen. Die Master-Ausnahme hängt
        // bewusst an derselben isForkInstance()-Invariante wie oben, nicht an einem
        // neuen Schalter — sonst ließe sie sich auf einem Fork setzen.
        return res.json({ available: false, enabled: true, entitled: true });
    }
    if (!walletExists()) {
        return res.json({ available: true, walletConfigured: false });
    }

    try {
        const [balances, pricing, activation] = await Promise.all([
            fetchPremiumBalances(),
            Promise.resolve(getCurrentPricing()),
            Promise.resolve(getMyActivationToken()),
        ]);

        const price = pricing?.priceUsdcPerHour ?? null;
        const hours = price != null ? remainingServiceHours(balances?.usdcBalance ?? 0, price) : null;

        res.json({
            available: true,
            walletConfigured: true,
            walletAddress: getPremiumPublicKey(),
            solBalance: balances?.solBalance ?? null,
            usdcBalance: balances?.usdcBalance ?? null,
            remainingHours: hours,
            priceUsdcPerHour: price,
            receivingWalletIsTestAddress: pricing?.receivingWalletIsTestAddress ?? null,
            pricingKnown: pricing != null,
            activated: activation != null,
            activationReceivedAt: activation?.receivedAt ?? null,
            lowBalanceWarnHours: pricing?.lowBalanceWarnHours ?? null,
            lowBalanceCriticalHours: pricing?.lowBalanceCriticalHours ?? null,
            enabled: isAutoPayEnabled(),
            // LIQ#0388: `enabled` ist der AUTOPAY-Schalter (zahlt dieser Host?), `entitled`
            // die BERECHTIGUNG (darf dieser Host Premium nutzen?). Die Premium-Verwalten-
            // Seite zeigt weiterhin `enabled` — sie schaltet ja genau diesen Schalter. Die
            // Strategie-Auswahl hängt dagegen an `entitled`: forge-pub1 ist über die
            // Systemdaten-Freigabe berechtigt, ohne zu zahlen.
            entitled: hasPremiumEntitlement().entitled,
        });
    } catch (err) {
        res.status(500).json({ available: true, error: err.message });
    }
});

router.post('/enable', async (_req, res) => {
    if (!isForkInstance()) return res.status(403).json({ error: t('api.premium.fork_only') });
    if (!walletExists()) return res.status(422).json({ error: t('api.premium.no_wallet') });
    if (getMyActivationToken() == null) return res.status(422).json({ error: t('api.premium.no_token') });
    if (getCurrentPricing() == null) return res.status(422).json({ error: t('api.premium.no_pricing') });
    setAutoPayEnabled(true);
    setPayFailureNotified(false); // frischer Start – ein altes Guthabenproblem gilt hier als quittiert
    recordPremiumMessage(JSON.stringify({ cmd: 'premium-autopay-enabled' }));
    const immediatePayment = await triggerImmediatePayment();
    res.json({ ok: true, enabled: true, immediatePayment });
});

router.post('/disable', (_req, res) => {
    if (!isForkInstance()) return res.status(403).json({ error: t('api.premium.fork_only') });
    setAutoPayEnabled(false);
    recordPremiumMessage(JSON.stringify({ cmd: 'premium-autopay-disabled' }));
    // LIQ#0382: sofort auslösen statt bis zu 10 Min auf den nächsten premium-pay.js-Cron-
    // Tick zu warten. Best-effort, darf das eigentliche Abschalten nie verhindern.
    //
    // 🔒 LIQ#0388: Dieser Aufruf ist seither in aller Regel ein NO-OP und soll es sein.
    // Das Abschalten der Zahlung ist kein Berechtigungsende — die zuletzt bezahlte bzw.
    // gelieferte Stunde deckt weiter, und danach läuft der Nachlauf aus
    // lib/premium-entitlement.js. Die Rücknahme kommt dann vom premium-pay.js-Cron, sobald
    // die Deckung wirklich abgelaufen ist. Der Aufruf bleibt trotzdem stehen: Er ist
    // idempotent, kostenlos, und deckt den Fall ab, dass die Berechtigung zum Zeitpunkt des
    // Abschaltens ohnehin schon beendet war.
    let rollback = null;
    try {
        rollback = rollbackStrategyOnPremiumLoss();
    } catch (err) {
        console.warn(`[premium disable] Strategie-Rücknahme fehlgeschlagen: ${err.message}`);
    }
    res.json({ ok: true, enabled: false, strategyRollback: rollback });
});

export default router;
