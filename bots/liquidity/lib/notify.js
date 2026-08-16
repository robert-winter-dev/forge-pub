/**
 * FORGE Liquidity – Notifications
 *
 * Sendet alle Notifications an FORGE Nexus (POST /notify).
 * Nexus übernimmt: DB-Speicherung, Telegram-Versand (nur error-Level),
 * Spam-Prevention und zentrale Observability.
 *
 * Level-Mapping:
 *   error  → DB + Telegram 🚨 (tvlWarnAlert, tvlExitAlert, error)
 *   warn   → nur DB          (aprAlert)
 *   info   → nur DB          (alle anderen)
 *
 * ── Mehrsprachigkeit (Schritt 5, Core/forge-pub/i18n.md E4) ─────
 *
 * 🔒 Hier steht KEIN Meldungstext mehr. Jede Funktion liefert einen
 * Katalogschlüssel (`notify.liq.*` in lib/i18n/<lang>.json) und die Daten dazu;
 * der Satz entsteht erst beim Anzeigen (lib/notify-render.js). Vorher wurde
 * fertiger deutscher Fließtext in nexus.db geschrieben — eine Sprachumschaltung
 * hätte diese Texte nie erreicht.
 *
 * Regeln für neue Meldungen:
 *   - Text in beide Katalogdateien, hier nur Key + Daten.
 *   - Die Handlungsaufforderung ist ein eigener Key in `_action` (ACTION unten).
 *   - Optionale Zeilen: Parameter weglassen — die Zeile fällt dann automatisch
 *     weg (Konvention 1 in notify-render.js), kein zweiter Katalogeintrag nötig.
 *   - Ein Textbaustein aus dem Code wird als `{ k, p }` übergeben, nicht als
 *     fertiger Satz.
 *
 * Bewusste Ausnahme: Freitext, den ein AUFRUFER formuliert (info(), rangeHint(),
 * opportunityParamCheck(), Begründungen des Premium-Datendienstes), wird
 * unverändert durchgereicht. Diese Texte entstehen außerhalb dieser Datei; sie zu
 * übersetzen ist Aufgabe der jeweiligen Quelle, nicht dieser Fassade.
 */

import { describeError } from '../../../lib/error-messages.js';
import { FORGE_TZ }      from '../../../core/config.js';
import { config }        from './config.js';
import { getBotConfig }  from '../../../lib/bot-registry.js';
import { renderNotification } from '../../../lib/notify-render.js';
import { getLang, t }    from '../../../lib/i18n.js';

const NEXUS_URL      = 'http://127.0.0.1:3100';
const BOT_ID         = config.botId;
const { displayName: BOT_DISPLAY_NAME, service: SERVICE_NAME } = getBotConfig('liquidity');

/**
 * Baut den Detail-Teil einer Fehler-Meldung aus describeError() als optionale Zeile.
 *   'none'   → keine Zeile, der reason-Satz reicht.
 *   'inline' → voller Rohtext.
 *   'logref' → neutraler Verweis aufs Service-Log statt unlesbarem Rohtext-Dump.
 * `detail` bleibt in jedem Fall vollständig im `context` (DB) erhalten — nur die
 * Nutzer-Meldung wird gekürzt.
 *
 * @returns {string|{k: string, p: object}|undefined} undefined = Zeile entfällt
 */
function detailLine(detail, detailMode) {
    if (detailMode === 'inline') return detail;
    if (detailMode === 'logref') {
        const now = new Date().toLocaleTimeString('de-DE', { timeZone: FORGE_TZ, hour: '2-digit', minute: '2-digit' });
        return { k: 'notify.common.logref', p: { cmd: `journalctl -u ${SERVICE_NAME} --since '${now}'` } };
    }
    return undefined;
}

/** describeError() → Meldungsbausteine (Grund als Katalog-Verweis, Detailzeile). */
function errorParts(err) {
    const { reasonKey, reasonParams, detail, detailMode } = describeError(err);
    return {
        reason: { k: reasonKey, p: reasonParams },
        detail: detailLine(detail, detailMode),
        raw:    detail,
    };
}

// ─── Handlungsaufforderungen ──────────────────────────────────────────────────
//
// 🔒 Regel (Betreiber-Vorgabe 2026-07-30): JEDE Meldung endet mit einem Satz, der
// sagt was der Nutzer tun soll — auch wenn die Antwort "nichts" ist. Der Adressat
// ist kein IT-Fachmann: eine Meldung, die nur einen Befund nennt ("TVL unter
// Schwelle"), lässt ihn ratlos zurück und wird auf Dauer ignoriert.
//
// Die Bausteine stehen als eigene Katalog-Keys da, damit die Formulierungen über
// alle Meldungen hinweg gleich klingen und an EINER Stelle nachgeschärft werden
// können. Neue Meldung = passenden Baustein referenzieren, keinen neuen Freitext.
const ACTION = {
    /** Bot löst das selbst, es ist nichts zu tun. */
    selfHeal:  'notify.act.self_heal',
    /** Lage im Blick behalten, noch keine Handlung nötig. */
    observe:   'notify.act.observe',
    /** Rein informativ, abgeschlossenes Ereignis. */
    fyi:       'notify.act.fyi',
    /** Position/Kapital wurde bewegt, Geld liegt in der Wallet. */
    inWallet:  'notify.act.in_wallet',
    /** Bot versucht es erneut; wenn es bleibt, ist ein Blick nötig. */
    retrying:  'notify.act.retrying',
    /** Endgültig gescheitert, Nutzer muss handeln. */
    manual:    'notify.act.manual',
    /** Wallet braucht Geld. */
    topUp:     'notify.act.top_up',
    /** Konfiguration muss angepasst werden. */
    configure: 'notify.act.configure',
    /** Verdacht auf Datenfehler/Angriff – nichts automatisch übernehmen. */
    verify:    'notify.act.verify',
};

/** Handlungsaufforderung mitten im Satz (statt als eigene Schlusszeile). */
const inline = key => ({ k: key });

// ─── Interner Sender ──────────────────────────────────────────────────────────

/**
 * @param {string} level     'info' | 'warn' | 'error' | 'lifecycle'
 * @param {string} category  Dedup-/Routing-Kategorie
 * @param {string} msgKey    Katalogschlüssel (lib/i18n/<lang>.json)
 * @param {object} params    Daten für die Platzhalter (siehe notify-render.js)
 * @param {object|null} context  Forensik-Daten für die DB
 * @param {boolean} telegramOnly
 */
async function send(level, category, msgKey, params = {}, context = null, telegramOnly = false) {
    // Der gerenderte Text geht als `message` mit: Telegram verschickt ihn sofort,
    // und für Zeilen ohne Katalogtreffer bleibt er der Fallback in der DB.
    const message = renderNotification(
        { msgKey, params, displayName: BOT_DISPLAY_NAME, timestamp: Date.now() },
        getLang(),
    );
    try {
        const res = await fetch(`${NEXUS_URL}/notify`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                botId: BOT_ID, displayName: BOT_DISPLAY_NAME, level, category,
                message, context, telegramOnly, msgKey, params,
            }),
        });
        if (!res.ok) {
            const errText = await res.text();
            console.error(`[notify] Nexus-Fehler: HTTP ${res.status} – ${errText}`);
        }
    } catch (err) {
        console.error(`[notify] Nexus nicht erreichbar: ${err.message} | ${level} | ${category} | ${msgKey}`);
    }
}

// ─── Öffentliche Nachrichten ─────────────────────────────────────────────────

/**
 * Deaktiviert (2026-08-14): reine Routine-Meldung ohne Mehrwert – der
 * Bediener löst den Neustart i.d.R. selbst aus und weiß es bereits. Ein
 * Crash-Neustart wird unabhängig davon von forge-check.js über systemd
 * (crashRestarts) erkannt und als Anomalie gemeldet.
 */
export async function startup() {
    return;
}

/** Neue CLMM-Position wurde geöffnet */
export async function positionOpened(pool, position) {
    const pair = pool.displayPair ?? pool.pair;
    await send('info', 'trade', 'notify.liq.position_opened', {
        pair,
        lower: position.priceLower.toFixed(2),
        upper: position.priceUpper.toFixed(2),
        _action: ACTION.fyi,
    }, { pair });
}

/** Fees wurden geclaimed */
export async function feesClaimed(pool, amountA, amountB, action, txHash, usdValue = null) {
    const pair   = pool.displayPair ?? pool.pair;
    const val    = usdValue ?? amountB;
    const fmtVal = val >= 1 ? val.toFixed(2) : val >= 0.01 ? val.toFixed(4) : val.toFixed(6);
    await send('info', 'trade', 'notify.liq.fees_claimed', { pair, value: fmtVal }, { pair });
}

/** Position ist out of range */
export async function outOfRange(pool, currentPrice, priceLower, priceUpper) {
    const pair = pool.displayPair ?? pool.pair;
    await send('info', 'grid', 'notify.liq.out_of_range', {
        pair,
        price: currentPrice.toFixed(2),
        side:  inline(currentPrice < priceLower ? 'notify.common.below' : 'notify.common.above'),
        lower: priceLower.toFixed(2),
        upper: priceUpper.toFixed(2),
    }, { pair });
}

/** Position ist wieder in range */
export async function backInRange(pool, currentPrice) {
    const pair = pool.displayPair ?? pool.pair;
    await send('info', 'grid', 'notify.liq.back_in_range', {
        pair,
        price:  currentPrice.toFixed(2),
        action: inline(ACTION.fyi),
    }, { pair });
}

/**
 * Tier-Wechsel im Economic-Scorer.
 *
 * Wird nur ausgelöst wenn der neue Tier in notifyOnTierTransition steht
 * (Default: ['withdraw', 'invest']). Tier-Wechsel-Spam wird durch
 * Hysterese im Tier-Classifier verhindert (3-Snapshot-Konsens).
 *
 * Level:
 *   → withdraw  → error (Telegram), weil sofortige Aufmerksamkeit nötig
 *   → invest    → warn  (nur DB), informativ
 *   → andere    → info  (nur DB), Übergänge die nicht gesondert melden
 */
export async function tierTransition(pool, oldTier, newTier, scoreData) {
    // Alt-Tier `observe`: kommt nur noch bei Übergängen aus dem alten Schema
    // vor (vor 2026-05-18) und wird wie `hold` angezeigt.
    const tierLabel = tier => ({ k: `notify.tier.${tier}` });
    const known     = t => ['invest', 'hold', 'withdraw', 'observe'].includes(t);

    const level = newTier === 'withdraw' ? 'error'
                : newTier === 'invest'   ? 'warn'
                                          : 'info';

    const totalReturn = scoreData.totalReturnAprPct ?? scoreData.netEconPct;
    const dailyPnl    = scoreData.dailyPnlPct;

    const tail = newTier === 'withdraw' ? 'notify.liq.tier_tail_withdraw'
               : newTier === 'invest'   ? 'notify.liq.tier_tail_invest'
                                        : ACTION.observe;

    await send(level, 'ranking', 'notify.liq.tier_transition', {
        pair:     pool.displayPair ?? pool.pair,
        oldLabel: known(oldTier) ? tierLabel(oldTier) : oldTier,
        newLabel: known(newTier) ? tierLabel(newTier) : newTier,
        totalLine: totalReturn != null
            ? { k: 'notify.liq.tier_total', p: { value: `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}` } }
            : undefined,
        dailyLine: dailyPnl != null
            ? { k: 'notify.liq.tier_daily', p: { value: `${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(2)}` } }
            : undefined,
        triggerLine: scoreData.withdrawTriggers?.length
            ? { k: 'notify.liq.tier_triggers', p: { triggers: scoreData.withdrawTriggers.join(', ') } }
            : undefined,
        confidence: scoreData.confidence?.toFixed?.(0) ?? '?',
        _action:    tail,
    }, {
        pair:              pool.displayPair ?? pool.pair,
        pool:              pool.displayPair ?? pool.pair,
        poolId:            pool.id,
        oldTier, newTier,
        totalReturnAprPct: scoreData.totalReturnAprPct,
        dailyPnlPct:       scoreData.dailyPnlPct,
        withdrawTriggers:  scoreData.withdrawTriggers,
    });
}

/** APR unter Schwellenwert */
export async function aprAlert(pool, currentApr, threshold) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'system', 'notify.liq.apr_alert', {
        pair, apr: currentApr.toFixed(2), threshold,
        _action: ACTION.observe,
    }, { pair });
}

// ─── TVL-Hilfsfunktion ────────────────────────────────────────────────────────

const fmtM = v => (v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : (v / 1000).toFixed(0) + 'K');

/** TVL unter Warnschwelle (Stufe 1) */
export async function tvlWarnAlert(pool, currentTvl, threshold) {
    const pair = pool.displayPair ?? pool.pair;
    await send('error', 'tvl', 'notify.liq.tvl_warn', {
        pair, current: fmtM(currentTvl), threshold: fmtM(threshold),
    }, { pair });
}

/** TVL unter Exit-Schwelle (Stufe 2) – Notfall-Exit wird ausgelöst */
export async function tvlExitAlert(pool, currentTvl, threshold) {
    const pair = pool.displayPair ?? pool.pair;
    await send('error', 'tvl', 'notify.liq.tvl_exit', {
        pair, current: fmtM(currentTvl), threshold: fmtM(threshold),
        _action: ACTION.inWallet,
    }, { pair });
}

/**
 * TVL-Voll-Exit abgeschlossen – bisher gab es dafür keine Abschlussmeldung,
 * nur die Vorab-Warnung (tvlExitAlert). exitInfo siehe exitMetricsParams().
 */
export async function tvlExitCompleted(pool, tvl, threshold, exitInfo = {}) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'tvl-done', 'notify.liq.tvl_exit_done', {
        pair, tvl: tvl.toFixed(2), threshold: threshold.toFixed(0),
        ...exitMetricsParams(pool, exitInfo),
        _action: ACTION.inWallet,
    }, { pair });
}

/**
 * Allgemeine Info-Meldung.
 * Der Aufrufer liefert den Sachverhalt, die Handlungsaufforderung kommt von hier —
 * eine Info ist definitionsgemäß nichts, wofür der Nutzer etwas tun muss.
 * `context`/`message` sind Freitext des Aufrufers (siehe Kopfkommentar).
 */
export async function info(context, message) {
    await send('info', 'system', 'notify.liq.info', {
        context, message, _action: ACTION.fyi,
    }, { context, message });
}

/** Range Advisor – bessere Range verfügbar → warn+range-hint → DB + Telegram */
export async function rangeHint(context, message) {
    await send('warn', 'range-hint', 'notify.liq.range_hint', { context, message },
        { context, message });
}

/**
 * Fehler-Notification mit bereits fertig formulierter Meldung → DB + Telegram.
 * Für Callsites, die selbst schon (per describeError/matchErrorCode) eine
 * spezifische, verständliche Meldung gebaut haben — verhindert eine doppelte
 * Klassifizierung durch error(), die den fertigen Text erneut interpretieren würde.
 */
export async function errorRaw(context, message) {
    await send('error', 'system', 'notify.liq.error_raw', {
        context, message, _action: ACTION.retrying,
    }, { context, message });
}

/**
 * Fehler-Notification → DB + Telegram.
 * @param {string} context  Pool-Name (z.B. "ORE/SOL") oder kurze Beschreibung.
 *                          Kein Funktionsname – der gehört ggf. in err.message.
 */
export async function error(context, err) {
    // Manche Callsites (z.B. score-advisor.js) übergeben einen fertig formulierten String
    // statt eines Error-Objekts — kein Fehler zum Klassifizieren, direkt durchreichen.
    if (typeof err === 'string') return errorRaw(context, err);
    const { reason, detail, raw } = errorParts(err);
    // SOL-Balance-Fehler sind selbstheilend (SOL-Topup in cleanup.js) → warn statt error
    const level = err?.solBalance !== undefined ? 'warn' : 'error';
    // SOL-Fehler heilen sich über den Topup selbst — dort wäre "starte den Bot neu"
    // ein falscher Rat (der Neustart ändert nichts am SOL-Bestand).
    const action = err?.solBalance !== undefined ? ACTION.selfHeal : ACTION.retrying;
    await send(level, 'system', 'notify.liq.error', {
        context, reason, detail, _action: action,
    }, { context, errorMessage: raw, errorStack: err?.stack });
}

/** Reinvest (increaseLiquidity) fehlgeschlagen → DB + Telegram. */
export async function reinvestError(pool, err) {
    const pair = pool.displayPair ?? pool.pair;
    const { reason, detail, raw } = errorParts(err);
    await send('error', 'system', 'notify.liq.reinvest_error', {
        pair, reason, detail, action: inline(ACTION.selfHeal),
    }, { context: pair, errorMessage: raw, errorStack: err?.stack });
}

/**
 * openPosition fehlgeschlagen → DB + Telegram.
 * @param {string} context  z.B. 'nach Rebalancing' | 'beim Öffnen'
 */
export async function openPositionError(pool, err, context = 'beim Öffnen') {
    const pair = pool.displayPair ?? pool.pair;
    const { reason, detail, raw } = errorParts(err);
    await send('error', 'system', 'notify.liq.open_position_error', {
        pair, context: openContext(context), reason, detail, action: inline(ACTION.selfHeal),
    }, { context: pair, errorMessage: raw, errorStack: err?.stack });
}

/**
 * Die beiden bekannten Kontexte von openPosition* sind Textbausteine, keine Daten —
 * sie kommen als deutsche Literale aus bin/bot.js. Bekannte Werte werden auf einen
 * Katalog-Key abgebildet, alles andere unverändert durchgereicht.
 */
function openContext(context) {
    if (context === 'nach Rebalancing') return { k: 'notify.common.after_rebalance' };
    if (context === 'beim Öffnen')      return { k: 'notify.common.while_opening' };
    return context;
}

/**
 * openPosition wiederholt fehlgeschlagen → Bot gibt auf, Pool wird automatisch
 * deaktiviert (active=false), damit die Retry-Schleife + die Dashboard-Zeile
 * "Position wird eröffnet …" nicht unbegrenzt stehen bleiben (Lehre aus dem
 * SPCX-Vorfall 2026-06-23). Kapital bleibt als Dust im Wallet, normaler
 * Cleanup-Sweep tauscht es zurück; manuelle Reaktivierung nötig.
 * @param {string} context  z.B. 'nach Rebalancing' | 'beim Öffnen'
 */
export async function openPositionGaveUp(pool, err, context, fails) {
    const pair = pool.displayPair ?? pool.pair;
    const { reason, detail, raw } = errorParts(err);
    await send('error', 'system', 'notify.liq.open_position_gave_up', {
        pair, fails, context: openContext(context), reason, detail,
        _action: ACTION.manual,
    }, { context: pair, errorMessage: raw, errorStack: err?.stack });
}

// Cooldown für solLow() (2026-07-29): die Funktion wird von vielen Call-Sites
// unkoordiniert aufgerufen (openPosition/increaseLiquidity-Fehlerpfade in bot.js,
// deposit.js, withdraw.js) — bei anhaltend knappem SOL feuerte das bisher jeden
// Zyklus erneut (Befund: "sehr oft"). Der Cooldown gehört deshalb HIER
// zentral hin statt in jede einzelne Call-Site kopiert zu werden (genau der
// Fehler, der zur Häufung geführt hat — ein Aufrufer, bin/bot.js's periodischer
// SOL-Alert, hatte längst einen eigenen 1h-Cooldown, alle anderen keinen).
let _lastSolLowNotifyAt = 0;
const SOL_LOW_COOLDOWN_MS = 60 * 60 * 1000; // max. 1× pro Stunde

/**
 * SOL-Balance unter der Reserve (nur DB, kein Telegram), max. 1×/h.
 *
 * Schwelle = `config.solReserve` (Default 0,1), NICHT darüber: erst unter der
 * Reserve hört der Bot tatsächlich auf Positionen zu eröffnen. Eine Warnung
 * oberhalb meldet Normalbetrieb als Störung — genau der Grund, warum die
 * Schwelle im `wallet-monitor` am 30.07.2026 von 0,12 auf 0,1 zurückgenommen
 * wurde (17 Fehlalarme in 48h auf forge-pub1). Beide Schwellen gehören zusammen;
 * wird eine geändert, muss die andere mit.
 */
export async function solLow(solBalance) {
    if (solBalance >= config.solReserve) return;
    if (Date.now() - _lastSolLowNotifyAt < SOL_LOW_COOLDOWN_MS) return;
    _lastSolLowNotifyAt = Date.now();
    if (solBalance < 0.05) {
        await send('error', 'wallet', 'notify.liq.sol_low_critical', {
            sol: solBalance.toFixed(4), _action: ACTION.topUp,
        });
    } else {
        await send('info', 'wallet', 'notify.liq.sol_low', {
            sol:     solBalance.toFixed(4),
            reserve: String(config.solReserve).replace('.', ','),
        });
    }
}

/**
 * SOL-Selbstheilung fehlgeschlagen – beim Risk-Management-Exit konnte nicht
 * genug SOL beschafft werden (kein ausreichendes Wallet-Guthaben zum Swappen).
 * error-Level → Telegram + Dashboard. Cooldown verantwortet der Aufrufer.
 *
 * @param {object} pool
 * @param {'pre'|'post'} phase  'pre' = vor der Liquidierung, 'post' = danach
 * @param {number} solAfter     verbleibender SOL-Bestand nach dem Topup-Versuch
 */
export async function solTopupFailed(pool, phase, solAfter) {
    const pair = pool.displayPair ?? pool.pair;
    await send('error', 'wallet', 'notify.liq.sol_topup_failed', {
        when:   inline(phase === 'pre' ? 'notify.common.before_liquidation' : 'notify.common.after_liquidation'),
        sol:    solAfter.toFixed(4),
        action: inline(ACTION.topUp),
    }, { pair, phase, solAfter });
}

/** Allgemeine Warnung (nur DB, kein Telegram) */
export async function warn(context, err) {
    const { reason, raw } = errorParts(err);
    await send('warn', 'system', 'notify.liq.warn', {
        context, reason, _action: ACTION.selfHeal,
    }, { context, errorMessage: raw, errorStack: err.stack });
}

/**
 * Eine on-chain gelandete, aber nie gebuchte Einzahlung wurde nachgetragen.
 * Level `warn`, nicht `info`: dass es dazu kam, heißt ein Lauf ist vorher
 * abgebrochen — das soll sichtbar sein. Zu tun ist trotzdem nichts mehr.
 */
export async function capitalFlowRecovered(pool, { usdValue, txHash, whenMs }) {
    await send('warn', 'system', 'notify.liq.capital_recovered', {
        pair: pool.displayPair ?? pool.pair,
        usd:  usdValue.toFixed(2),
        tx:   txHash,
        when: new Date(whenMs).toLocaleString('de-DE'),
        _action: ACTION.fyi,
    }, { context: pool.id, txHash, usdValue });
}

/**
 * Kapitalbewegung on-chain gefunden, die NICHT gebucht ist und die der
 * Reconciler bewusst nicht selbst nachträgt (Richtung mehrdeutig, Bewertung
 * nicht belastbar). ACTION.verify — hier darf nichts automatisch übernommen werden.
 */
export async function capitalFlowNeedsReview(pool, { txHash, whenMs, reason }) {
    await send('warn', 'system', 'notify.liq.capital_unclear', {
        pair: pool.displayPair ?? pool.pair,
        tx:   txHash,
        when: new Date(whenMs).toLocaleString('de-DE'),
        reason,
        _action: ACTION.verify,
    }, { context: pool.id, txHash, reason });
}

/** Manueller Deposit in eine bestehende oder neue Position */
export async function depositAdded(pool, depositUsdc, amountA, amountB, txHash, isNew = false) {
    const pair    = pool.displayPair ?? pool.pair;
    const tokenA  = pool.pair.split('/')[0];
    await send('info', 'trade', 'notify.liq.deposit_added', {
        pair,
        what:    inline(isNew ? 'notify.liq.deposit_new' : 'notify.liq.deposit_increase'),
        amountA: amountA.toFixed(6),
        tokenA,
        amountB: amountB.toFixed(2),
        deposit: depositUsdc.toFixed(2),
        _action: ACTION.fyi,
    }, { pair });
}

/** Manueller Withdraw aus einer bestehenden Position */
export async function withdrawCompleted(pool, usdcRequested, amountA, amountB, fraction, txHash) {
    const pair   = pool.displayPair ?? pool.pair;
    const tokenA = pool.pair.split('/')[0];
    await send('info', 'trade', 'notify.liq.withdraw_completed', {
        pair,
        amountA: amountA.toFixed(6),
        tokenA,
        amountB: amountB.toFixed(2),
        target:  usdcRequested.toFixed(2),
        pct:     (fraction * 100).toFixed(2),
        _action: ACTION.inWallet,
    }, { pair });
}

/** Pool Mindestwert wurde deaktiviert – User muss neu konfigurieren.
 *  reason: 'withdraw' | 'rebalance' */
export async function minimumValueCleared(pool, oldMinValueUsd, reason = 'withdraw') {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'trailing-stop', 'notify.liq.min_value_cleared', {
        value:  Math.round(oldMinValueUsd),
        cause:  inline(reason === 'rebalance' ? 'notify.liq.min_value_cause_rebalance' : 'notify.liq.min_value_cause_withdraw'),
        action: inline(ACTION.configure),
    }, { pair, oldMinValueUsd, reason });
}

/** Deaktiviert (2026-08-14) – siehe startup(). */
export async function shutdown(reason = 'SIGTERM') { // eslint-disable-line no-unused-vars
    return;
}

/**
 * Risk-Management Vorwarnung – feuert beim ersten Erreichen eines Schwellwerts,
 * bevor die eigentliche Ausführung startet.
 */
export async function rmWarning(pool, scenarioLabel, lpValueUsd) {
    const pair = pool.displayPair ?? pool.pair;
    await send('error', 'rm-warning', 'notify.liq.rm_warning', {
        scenario: rmScenario(scenarioLabel),
    }, { pair });
}

/**
 * Gemeinsame Exit-Kennzahlen für Risk-Management- und TVL-Abschlussmeldungen:
 * Pool-Wert bei Schließung, entnommene Coins, Swap-Ergebnis und die daraus
 * abgeleiteten Exit-Kosten (Pool-Wert minus tatsächlich erhaltenes USDC).
 *
 * Fehlende Werte (z.B. kein Snapshot verfügbar) lassen die jeweilige Zeile
 * automatisch entfallen (Konvention 1, notify-render.js) statt eine falsche
 * Zahl zu erfinden.
 */
function exitMetricsParams(pool, { lpValueUsd, coinsA, coinsB, swappedUsdc } = {}) {
    const [symA, symB] = pool.pair.split('/');
    const hasCoins = coinsA != null && coinsB != null;
    return {
        lpValue: lpValueUsd != null ? lpValueUsd.toFixed(2) : undefined,
        coinsA:  hasCoins ? coinsA.toFixed(6) : undefined,
        symA,
        coinsB:  hasCoins ? coinsB.toFixed(6) : undefined,
        symB,
        noSwapSuffix: hasCoins ? (swappedUsdc == null ? inline('notify.liq.rm_no_swap') : '') : undefined,
        swappedLine: (hasCoins && swappedUsdc != null)
            ? { k: 'notify.liq.rm_swapped', p: {
                  usdc: swappedUsdc.toFixed(2),
                  cost: lpValueUsd != null ? (lpValueUsd - swappedUsdc).toFixed(2) : undefined,
              } }
            : undefined,
    };
}

/**
 * Risk-Management Ausführung abgeschlossen – ersetzt alle szenario-spezifischen
 * Completed-Nachrichten (trailingStopCompleted, scoreLimitCompleted).
 *
 * @param {object} exitInfo  { lpValueUsd, coinsA, coinsB, swappedUsdc } – alle
 *   optional, fehlende Werte lassen die zugehörige Zeile entfallen.
 */
export async function rmExecuted(pool, scenarioLabel, exitInfo = {}) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'rm-executed', 'notify.liq.rm_executed', {
        scenario: rmScenario(scenarioLabel),
        pair,
        ...exitMetricsParams(pool, exitInfo),
        _action:  ACTION.inWallet,
    }, { pair });
}

/**
 * Szenario-Bezeichner der Risk-Management-Meldungen.
 *
 * Die Aufrufer (trailing-stop.js, score-limit.js) liefern ihn
 * seit Schritt 5 als Katalog-Verweis `{ k, p }` — das Label enthält Zahlen
 * ("Trailing Stop (33%)") und lässt sich deshalb nicht über eine feste Tabelle
 * übersetzen. Ein einfacher String wird unverändert durchgereicht, damit ein
 * neuer Aufrufer nicht sofort eine leere Meldung erzeugt.
 */
function rmScenario(label) {
    return label;
}

/** Score Limit unterschritten – Position wurde geschlossen */
export async function scoreLimitTriggered(pool, score, minScore) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'score-limit', 'notify.liq.score_limit_triggered', {
        minScore, _action: ACTION.inWallet,
    }, { pair });
}

/**
 * Gemeinsame Parameter der drei Exit-Abschlussmeldungen (Score-Limit,
 * Trailing Stop) — der Rumpf steht als EIN Katalogeintrag
 * (`notify.liq.exit_done`), die Überschrift kommt vom Aufrufer.
 *
 * Die beiden Varianten "an Adresse gesendet" / "bleibt im Wallet" unterscheiden
 * sich in genau zwei Zeilen; beide werden als Katalog-Verweis übergeben, damit
 * der Rumpf nicht dreimal existieren muss.
 */
function exitDoneParams(pool, headline, { coinsA, coinsB, swappedUsdc, sentTo }) {
    const [symA, symB] = pool.pair.split('/');
    return {
        headline,
        coinsA: coinsA.toFixed(6), symA,
        coinsB: coinsB.toFixed(6), symB,
        swappedLine: swappedUsdc != null
            ? { k: 'notify.liq.exit_swapped', p: { usdc: swappedUsdc.toFixed(2) } }
            : undefined,
        destLine: sentTo
            ? { k: 'notify.liq.exit_sent_to', p: { addr: sentTo.slice(0, 8) } }
            : { k: 'notify.liq.exit_stays_in_wallet' },
        _action: sentTo ? 'notify.liq.exit_sent_action' : ACTION.inWallet,
    };
}

/** Score Limit vollständig abgeschlossen */
export async function scoreLimitCompleted(pool, { score, coinsA, coinsB, swappedUsdc, sentTo }) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'score-limit-done', 'notify.liq.exit_done',
        exitDoneParams(pool, { k: 'notify.liq.exit_head_score_limit', p: { score } },
            { coinsA, coinsB, swappedUsdc, sentTo }),
        { pair });
}

/** Score Limit fehlgeschlagen */
export async function scoreLimitError(pool, step, err) {
    const pair = pool.displayPair ?? pool.pair;
    const { reason, detail, raw } = errorParts(err);
    await send('error', 'score-limit', 'notify.liq.score_limit_error', {
        step, reason, detail, _action: ACTION.retrying,
    }, { pair, errorMessage: raw });
}

// ─── Trailing Stop ────────────────────────────────────────────────────────────

export async function trailingStopTriggered(pool, hwmUsd, currentUsd, thresholdPct) {
    const pair = pool.displayPair ?? pool.pair;
    const drawdownPct = hwmUsd > 0 ? ((hwmUsd - currentUsd) / hwmUsd) * 100 : 0;
    await send('warn', 'trailing-stop', 'notify.liq.trailing_stop_triggered', {
        drawdown: drawdownPct.toFixed(1),
        hwm:      hwmUsd.toFixed(2),
        current:  currentUsd.toFixed(2),
    }, { pair });
}

export async function trailingStopCompleted(pool, { coinsA, coinsB, swappedUsdc, sentTo }) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'trailing-stop-done', 'notify.liq.exit_done',
        exitDoneParams(pool, { k: 'notify.liq.exit_head_trailing_stop' }, { coinsA, coinsB, swappedUsdc, sentTo }),
        { pair });
}

export async function trailingStopError(pool, step, err) {
    const pair = pool.displayPair ?? pool.pair;
    const { reason, detail, raw } = errorParts(err);
    await send('error', 'trailing-stop', 'notify.liq.trailing_stop_error', {
        step, reason, detail, _action: ACTION.retrying,
    }, { pair, errorMessage: raw });
}

/**
 * Opportunity-Score Paramter-Check (wöchentlich via Cron).
 *
 * status:
 *   'ok'                 → kein Versand (nur Log)
 *   'warn'               → warn → nur DB (Degradation 5–15%)
 *   'update_recommended' → error → DB + Telegram (Degradation > 15%)
 *
 * @param {'ok'|'warn'|'update_recommended'} status
 * @param {string} summary  Einzeilige Zusammenfassung (Freitext des Aufrufers)
 * @param {object} details  Strukturierte Details für DB-Context
 */
export async function opportunityParamCheck(status, summary, details) {
    if (status === 'ok') return;
    const recommend = status === 'update_recommended';
    await send(recommend ? 'error' : 'warn', 'opportunity-score', 'notify.liq.param_check', {
        icon:    recommend ? '⚠️' : 'ℹ️',
        summary,
        _action: recommend ? 'notify.liq.param_check_action' : ACTION.observe,
    }, details);
}

// ─── FORGE public Premium: Pool-Offer-Lebenszyklus ──────────────────────────────

/**
 * Erste Feststellung, dass ein übernommener Pool zurückgestuft wurde. Noch passiert
 * NICHTS mit dem Kapital — die Meldung sagt ausdrücklich, was wann folgt, damit der
 * Nutzer vorher eingreifen kann.
 */
export async function premiumPoolRetired(pool, { reason, kind, confirmHours }) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'premium-offer', 'notify.liq.premium_retired', {
        pair,
        how:    inline(kind === 'absent' ? 'notify.liq.premium_retired_absent' : 'notify.liq.premium_retired_explicit'),
        reason,
        hours:  confirmHours,
    }, { pair, reason, kind });
}

/** Rückstufung zurückgenommen, bevor der Exit lief. */
export async function premiumPoolReinstated(pool) {
    const pair = pool.displayPair ?? pool.pair;
    await send('info', 'premium-offer', 'notify.liq.premium_reinstated', {
        pair, _action: ACTION.fyi,
    }, { pair });
}

/** Kapital wurde wegen der Rückstufung aus dem Pool gezogen → DB + Telegram. */
export async function premiumPoolExitDone(pool, { reason, swappedUsdc, observedTvlUsd }) {
    const pair = pool.displayPair ?? pool.pair;
    await send('error', 'premium-offer', 'notify.liq.premium_exit_done', {
        pair,
        reason,
        proceeds: swappedUsdc > 0
            ? { k: 'notify.liq.premium_proceeds', p: { usdc: swappedUsdc.toFixed(2) } }
            : { k: 'notify.liq.premium_no_proceeds' },
        ownTvlLine: observedTvlUsd > 0
            ? { k: 'notify.liq.premium_own_tvl', p: { tvl: fmtM(observedTvlUsd) } }
            : undefined,
        _action: ACTION.inWallet,
    }, { pair, reason, swappedUsdc });
}

export async function premiumPoolExitError(pool, err) {
    const pair = pool.displayPair ?? pool.pair;
    await send('error', 'premium-offer', 'notify.liq.premium_exit_error', {
        pair, error: err.message, _action: ACTION.retrying,
    }, { pair, error: err.message });
}

/** Übernommene Feldänderungen eines bestehenden Pools (alt → neu, im Klartext). */
export async function premiumPoolUpdated(pool, { applied, deferred }) {
    const pair = pool.displayPair ?? pool.pair;
    const fmt   = v => (v === null || v === undefined || v === '') ? 'no data' : String(v);
    const lines = applied.map(c => `• ${c.label}: ${fmt(c.from)} → ${fmt(c.to)}`).join('\n');
    await send('info', 'premium-offer', 'notify.liq.premium_updated', {
        pair,
        lines,
        deferredLine: deferred.length > 0
            ? {
                k: 'notify.liq.premium_updated_deferred',
                p: { lines: deferred.map(c => `• ${c.label}: ${fmt(c.from)} → ${fmt(c.to)}`).join('\n') },
              }
            : undefined,
        _action: ACTION.fyi,
    }, { pair, applied, deferred });
}

/**
 * Ein Offer beschreibt unter bekannter ID einen anderen Pool (Adresse/Mints/Fee-Tier
 * weichen ab). Das ist kein Update, sondern ein Bruch — nie still übernehmen.
 */
export async function premiumPoolIdentityMismatch(pool, changes) {
    const pair = pool.displayPair ?? pool.pair;
    // Die Zeilenliste ist dynamisch — sie kann nicht als EIN Katalogeintrag stehen.
    // Deshalb wird die Zeilenvorlage hier schon aufgelöst; sie friert damit in der
    // Sprache ein, die beim Erzeugen aktiv war (dieselbe bewusste Grenze wie bei
    // allen anderen Listen, siehe Kopfkommentar).
    const lines = changes
        .map(c => t('notify.liq.premium_mismatch_line', { field: c.field, local: c.local, offered: c.offered }))
        .join('\n');
    await send('error', 'premium-offer', 'notify.liq.premium_identity_mismatch', {
        pair, lines, _action: ACTION.verify,
    }, { pair, changes });
}

/** Neue Orca-Pools über Fees24h- und TVL-Schwelle, noch nicht in pools.json */
export async function newPoolsFound(pools, feesThresholdUsdc, tvlThresholdUsdc) {
    const lines = pools.map(p =>
        `${p.pair} – Fees24h ${p.fees24h.toFixed(0)} USDC, TVL ${p.tvlUsd.toFixed(0)} USDC\n\`${p.address}\``
    ).join('\n\n');
    await send('warn', 'new-pool-alert', 'notify.liq.new_pools', {
        fees: feesThresholdUsdc.toLocaleString('de-DE'),
        tvl:  tvlThresholdUsdc.toLocaleString('de-DE'),
        lines,
    },
    { pools: pools.map(p => p.address) },
    true, // telegramOnly – nur Erinnerung, keine Dashboard-Notification
    );
}
