/**
 * /api/health-share – Systemdaten-Freigabe (Opt-in-Telemetrie im Health Monitor)
 *
 * Zwei streng getrennte Hälften, jede mit EIGENEM Riegel — sie laufen nie auf
 * derselben Installation:
 *
 *   /manage/*  MASTER-ONLY – die Teilnehmerliste verwalten (wer hat aktiviert, wer ist
 *              freigeschaltet, wie viel sendet er). Store:
 *              core/premium/health-share-allowlist.js
 *   /opt-in/*  FORK-ONLY   – der Haken des Nutzers und die eine Aktivierungs-DM
 *              (siehe optIn.post('/enable')). Store: lib/health-share-state.js
 *
 * Bewusst zwei Sub-Router statt eines gemeinsamen Riegels: die beiden Hälften haben
 * gegensätzliche Voraussetzungen (Master vs. Fork). Ein einzelner Riegel müsste sie
 * pro Endpunkt unterscheiden — und genau dort wird beim nächsten ergänzten Endpunkt
 * einer vergessen.
 */

import { Router } from 'express';
import { isMasterLocked } from '../lib/master-lock.js';
import { isForkInstance } from '../../../lib/premium-identity-context.js';
import {
    listParticipants,
    approveParticipant,
    revokeParticipant,
    reopenParticipant,
    deleteParticipant,
} from '../../../core/premium/health-share-allowlist.js';
import { isShareEnabled, setShareEnabled, getShareState, listSentReports } from '../../../lib/health-share-state.js';
import { getPremiumCoverage } from '../../../lib/premium-wallet.js';

const PREMIUM_BASE = `http://127.0.0.1:${process.env.PREMIUM_PORT || '3110'}`;

const router = Router();

// ══════════════════════════════════════════════════════════════════════════════
// MASTER: Allowlist verwalten
// ══════════════════════════════════════════════════════════════════════════════

const manage = Router();

manage.use((_req, res, next) => {
    if (!isMasterLocked()) return res.status(404).json({ error: 'Nicht verfügbar auf dieser Installation.' });
    next();
});

/**
 * Live-Nick-Auflösung on top von listParticipants() – siehe Endpunkt
 * /health-share/profile-names in core/premium/server.js für die Begründung, warum
 * `displayName` (Aktivierungs-Schnappschuss) allein meist leer bleibt. Best-effort:
 * schlägt der Aufruf fehl (Premium-Dienst nicht erreichbar), bleibt es beim
 * gespeicherten `displayName` — kein harter Fehler für die ganze Übersicht wegen
 * einer kosmetischen Zusatzinfo.
 */
async function withLiveNicks(participants) {
    const pubkeys = participants.map(p => p.pubkeyHex);
    if (!pubkeys.length) return participants;
    try {
        const r = await fetch(`${PREMIUM_BASE}/health-share/profile-names?pubkeys=${pubkeys.join(',')}`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return participants;
        const { names } = await r.json();
        return participants.map(p => ({ ...p, displayName: names?.[p.pubkeyHex] ?? p.displayName }));
    } catch {
        return participants;
    }
}

manage.get('/', async (_req, res) => {
    res.json({ participants: await withLiveNicks(listParticipants()) });
});

/**
 * Teilt dem Teilnehmer die Entscheidung per Nostr-DM mit (core/premium hält den
 * Relay-Pool). Best-effort: schlägt es fehl, bleibt die Entscheidung bestehen — ein
 * Widerruf muss greifen, auch wenn der Betroffene die Nachricht gerade nicht erhält.
 * Der Fehler wird zurückgemeldet, damit die Oberfläche ihn zeigen kann.
 */
async function notifyDecision(pubkey, decision) {
    try {
        const r = await fetch(`${PREMIUM_BASE}/health-share/notify`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ pubkey, decision }),
            signal:  AbortSignal.timeout(15000),
        });
        if (!r.ok) return (await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`;
        return null;
    } catch (err) {
        return err.message;
    }
}

/**
 * Journal-Eintrag für jede Zustandsänderung an der Allowlist (2026-08-14, Fund: der
 * Vorfall "pub1 verschwand aus der Teilnehmerliste" am selben Tag ließ sich nicht auf
 * einen Klick zurückführen, weil weder dieser Router noch forge-settings sowas
 * protokollierte — nur `journalctl -u forge-settings` zeigt Neustarts, kein einziger
 * Endpunkt-Aufruf). Landet über den Prozess-stdout im systemd-Journal
 * (`journalctl -u forge-settings`), gleiches Muster wie `[premium]` in
 * core/premium/server.js.
 */
function auditLog(action, pubkey, extra = '') {
    console.log(`[health-share-admin] ${action} ${pubkey.slice(0, 12)}…${extra ? ' ' + extra : ''}`);
}

function action(auditAction, handler, decision = null) {
    return async (req, res) => {
        const pubkey = String(req.params.pubkey ?? '');
        const result = handler(pubkey, req.body ?? {});
        if (!result.ok) return res.status(400).json({ error: result.reason ?? 'nicht möglich' });
        auditLog(auditAction, pubkey);
        // Die Benachrichtigung ist Teil der Entscheidung, nicht Beiwerk: ohne sie weiß
        // der Fork nicht, dass er senden darf (bzw. aufhören muss).
        const notifyError = decision ? await notifyDecision(pubkey, decision) : null;
        res.json({ ok: true, ...result, notifyError });
    };
}

manage.post('/:pubkey/approve', action('approve', (pubkey, body) =>
    approveParticipant(pubkey, { note: body.note ? String(body.note).slice(0, 200) : null }), 'approved'));

manage.post('/:pubkey/revoke', action('revoke', (pubkey, body) =>
    revokeParticipant(pubkey, { note: body.note ? String(body.note).slice(0, 200) : null }), 'revoked'));

manage.post('/:pubkey/reopen', action('reopen', pubkey => reopenParticipant(pubkey)));

/**
 * Konsolidierte Zustandsänderung für das Dropdown im Tab "Health Monitor > Share"
 * ("Kein Status" / "Premium User") – bildet auf approve/revoke/reopen ab, je nachdem
 * in welchem Zustand der Teilnehmer gerade steht, damit das Frontend nicht selbst
 * zwischen approve/revoke/reopen unterscheiden muss.
 */
manage.post('/:pubkey/status', async (req, res) => {
    const pubkey = String(req.params.pubkey ?? '');
    const target = req.body?.status;
    if (target !== 'none' && target !== 'approved') {
        return res.status(400).json({ error: 'status muss "none" oder "approved" sein' });
    }

    const current = listParticipants().find(p => p.pubkeyHex === pubkey);
    if (!current) return res.status(404).json({ error: 'unbekannter Teilnehmer' });

    let result, decision = null;
    if (target === 'approved') {
        // 🔴 Bugfix 2026-08-14 (gemeldet): approveParticipant() lehnt einen
        // widerrufenen Teilnehmer bewusst ab ("zuerst wieder zur Prüfung zulassen") –
        // das schützt einzelne, direkte Aufrufe vor einer versehentlichen
        // Rücknahme des Widerrufs. Diese Route kennt den Zwischenschritt aber
        // nicht: ein Klick auf "Premium User" bei einem widerrufenen Nutzer schlug
        // fehl, obwohl die Oberfläche keinen Hinweis auf den nötigen Umweg über
        // "Kein Status" gab. Hier verkettet – ein Klick reicht.
        if (current.status === 'revoked') reopenParticipant(pubkey);
        result = approveParticipant(pubkey);
        decision = 'approved';
    } else if (current.status === 'revoked') {
        result = reopenParticipant(pubkey);
    } else if (current.status === 'pending') {
        result = { ok: true, status: 'pending', unchanged: true };
    } else {
        result = revokeParticipant(pubkey);
        decision = 'revoked';
    }

    if (!result.ok) return res.status(400).json({ error: result.reason ?? 'nicht möglich' });
    auditLog('status', pubkey, `→ ${target} (war: ${current.status})`);
    const notifyError = decision ? await notifyDecision(pubkey, decision) : null;
    res.json({ ok: true, ...result, notifyError });
});

/**
 * Entfernt einen Teilnehmer aus der Liste (2026-08-14, Auftrag: reine
 * Listenpflege gegen Karteileichen). Bewusst OHNE Nachricht an den Fork (bewusste
 * Entscheidung) und OHNE die Report-Historie anzufassen — siehe deleteParticipant().
 * Die Sicherheitsabfrage läuft ausschließlich im Frontend (Modal vor dem Request),
 * dieser Endpunkt führt ohne weitere Rückfrage aus.
 *
 * 🔴 Bewusst mit eigenem, deutlich markiertem Audit-Log statt nur `auditLog()`: das
 * Löschen ist der einzige Schritt hier, der eine bestehende Freischaltung unwiderruflich
 * aus der Liste entfernt (siehe Vorfall 2026-08-14 – pub1 verlor seine Freischaltung
 * spurlos, weil dieser Aufruf bis dahin nirgends protokolliert wurde).
 */
manage.delete('/:pubkey', (req, res) => {
    const pubkey = String(req.params.pubkey ?? '');
    const previousStatus = listParticipants().find(p => p.pubkeyHex === pubkey)?.status ?? 'unbekannt';
    const result = deleteParticipant(pubkey);
    if (!result.ok) return res.status(400).json({ error: result.reason ?? 'nicht möglich' });
    console.log(`[health-share-admin] 🔴 delete ${pubkey.slice(0, 12)}… (war: ${previousStatus})`);
    res.json({ ok: true });
});

router.use('/manage', manage);

// ══════════════════════════════════════════════════════════════════════════════
// FORK: Haken des Nutzers + Aktivierung
// ══════════════════════════════════════════════════════════════════════════════

const optIn = Router();

optIn.use((_req, res, next) => {
    if (!isForkInstance()) return res.status(404).json({ error: 'Nicht verfügbar auf dieser Installation.' });
    next();
});

/**
 * Ob die Freigabe tatsächlich LÄUFT, weiß der Fork nicht aus sich heraus — das
 * entscheidet der Master. Der einzige belastbare Beleg ist, dass Daten ankommen,
 * ohne dass je bezahlt wurde (`coverageSource === 'shared'`, siehe
 * lib/premium-wallet.js). Deshalb wird die Phase aus dieser Beobachtung abgeleitet
 * und nicht aus einem lokal gesetzten Wert, dem man vertrauen müsste.
 */
function currentState() {
    const hasSharedCoverage = getPremiumCoverage().coverageSource === 'shared';
    return getShareState({ hasSharedCoverage });
}

optIn.get('/', (_req, res) => {
    res.json({ available: true, ...currentState() });
});

/**
 * Verlauf der eigenen gesendeten Reports (Kurswechsel 2026-08-14) — die einzige Stelle,
 * an der der Nutzer nachvollziehen kann, was seine Installation tatsächlich überträgt.
 * Löst die frühere Anzeige über das Message Center ab (siehe recordSentReport()).
 */
optIn.get('/reports', (_req, res) => {
    res.json({ reports: listSentReports() });
});

// Sendet eine schlichte Identifikations-DM ("Health Monitor: Daten teilen
// aktiviert."). Schaltet NICHTS frei; der Master trägt den Absender daraufhin im Tab
// "Health Monitor > Share" ein und schaltet dort manuell frei ("Premium User"). Für
// bereits freigeschaltete Installationen ändert sich nichts (approved_at bleibt
// bestehen).
optIn.post('/enable', async (_req, res) => {
    // Reihenfolge bewusst: erst den Nutzerwillen festhalten, dann senden. Scheitert das
    // Senden (Relay weg), bleibt der Haken gesetzt und die Oberfläche zeigt „noch nicht
    // aktiviert" mit Wiederholmöglichkeit — statt den Willen stillschweigend zu verwerfen.
    setShareEnabled(true);

    try {
        const r = await fetch(`${PREMIUM_BASE}/health-share/activate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(20000),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            return res.status(502).json({ ...currentState(), error: data.error ?? `HTTP ${r.status}` });
        }
        res.json({ ok: true, ...currentState() });
    } catch (err) {
        res.status(502).json({ ...currentState(), error: `Aktivierung konnte nicht gesendet werden: ${err.message}` });
    }
});

optIn.post('/disable', (_req, res) => {
    // Kein „Abmelden" beim Master nötig: ohne neuen Report läuft der Zugang binnen 60
    // Minuten von selbst aus (K_H rotiert stündlich). Eine Kündigungsnachricht wäre eine
    // zusätzliche Fehlerquelle für einen Zustand, der sich ohnehin selbst auflöst.
    setShareEnabled(false);
    res.json({ ok: true, ...currentState() });
});

router.use('/opt-in', optIn);

export { isShareEnabled };
export default router;
