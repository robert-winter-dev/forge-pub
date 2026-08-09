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
 */

import { existsSync }    from 'fs';
import path              from 'path';
import { describeError } from '../../../lib/error-messages.js';
import { FORGE_TZ }      from '../../../core/config.js';
import { config }        from './config.js';
import { getBotConfig }  from '../../../lib/bot-registry.js';
import { PATHS }         from '../../../config/paths.js';

const NEXUS_URL      = 'http://127.0.0.1:3100';
const BOT_ID         = config.botId;
// Gesetzt vom Installer (bin/setup-lib/common.sh update_notify_suppress_on)
// zwischen Bot-Stop und -Neustart eines Updates. startup()/shutdown() prüfen
// das bei jedem Aufruf frisch (kein Caching) – der Marker kann sich innerhalb
// des Prozesslebens ändern.
const UPDATE_SUPPRESS_FLAG = path.join(PATHS.data, 'update-notify-suppress');
const { displayName: BOT_DISPLAY_NAME, service: SERVICE_NAME } = getBotConfig('liquidity');

// ─── HTML → Markdown (für Telegram-kompatible Speicherung in nexus.db) ─────

/**
 * Baut den anzuhängenden Detail-Teil einer Fehler-Meldung aus describeError().
 *   'none'   → nichts anhängen, der reason-Satz reicht.
 *   'inline' → voller Rohtext (bisheriges Verhalten).
 *   'logref' → neutraler Verweis aufs Service-Log statt unlesbarem Rohtext-Dump.
 * `detail` bleibt in jedem Fall vollständig im `context` (DB) erhalten — nur die
 * Nutzer-Meldung wird gekürzt.
 */
function detailSuffix(detail, detailMode) {
    if (detailMode === 'inline') return `\n${detail}`;
    if (detailMode === 'logref') {
        const now = new Date().toLocaleTimeString('de-DE', { timeZone: FORGE_TZ, hour: '2-digit', minute: '2-digit' });
        return `\nZu technisch für eine Kurzmeldung – Details: \`journalctl -u ${SERVICE_NAME} --since '${now}'\``;
    }
    return '';
}

function htmlToMd(text) {
    return text
        .replace(/<b>([\s\S]*?)<\/b>/g, '*$1*')
        .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`');
}

// ─── Handlungsaufforderungen ──────────────────────────────────────────────────
//
// 🔒 Regel (Betreiber-Vorgabe 2026-07-30): JEDE Meldung endet mit einem Satz, der
// sagt was der Nutzer tun soll — auch wenn die Antwort "nichts" ist. Der Adressat
// ist kein IT-Fachmann: eine Meldung, die nur einen Befund nennt ("TVL unter
// Schwelle"), lässt ihn ratlos zurück und wird auf Dauer ignoriert.
//
// Die Bausteine stehen hier zentral, damit die Formulierungen über alle Meldungen
// hinweg gleich klingen und an EINER Stelle nachgeschärft werden können. Neue
// Meldung = passenden Baustein anhängen, keinen neuen Freitext erfinden.
const ACTION = {
    /** Bot löst das selbst, es ist nichts zu tun. */
    selfHeal:  'Es ist nichts zu tun – der Bot holt das im nächsten Zyklus automatisch nach.',
    /** Lage im Blick behalten, noch keine Handlung nötig. */
    observe:   'Es ist nichts zu tun. Beobachte den Pool im Dashboard – der Bot greift selbst ein, wenn es nötig wird.',
    /** Rein informativ, abgeschlossenes Ereignis. */
    fyi:       'Es ist nichts zu tun, diese Meldung dient nur zur Information.',
    /** Position/Kapital wurde bewegt, Geld liegt in der Wallet. */
    inWallet:  'Es ist nichts zu tun. Das Kapital liegt in deiner Wallet – du kannst es dort lassen oder neu anlegen.',
    /** Bot versucht es erneut; wenn es bleibt, ist ein Blick nötig. */
    retrying:  'Der Bot versucht es erneut. Kommt diese Meldung mehrfach hintereinander, starte den Bot neu.',
    /** Endgültig gescheitert, Nutzer muss handeln. */
    manual:    'Bitte im Dashboard prüfen und den Pool danach von Hand wieder freigeben.',
    /** Wallet braucht Geld. */
    topUp:     'Bitte Wallet mit mindestens 0,15 SOL aufladen.',
    /** Konfiguration muss angepasst werden. */
    configure: 'Bitte die Einstellung im Dashboard unter Risk-Management neu setzen.',
    /** Verdacht auf Datenfehler/Angriff – nichts automatisch übernehmen. */
    verify:    'Es wurde nichts automatisch übernommen. Bitte die Angaben prüfen, bevor du dem Pool weiter Kapital gibst.',
};

// ─── Interner Sender ──────────────────────────────────────────────────────────

// Kopfzeile (Datum/Uhrzeit + Bot) auf JEDE Nachricht, egal wo sie später angezeigt
// wird (Message Center, Telegram, Roh-DB-Dump) – der Pool steht bereits in fast
// jedem Nachrichtentext selbst (siehe die einzelnen send()-Aufrufer unten), ohne
// Datum/Bot wusste man in Telegram aber oft nicht mehr, wann/von wem eine Meldung kam.
function fmtNotifyTimestamp() {
    return new Intl.DateTimeFormat('de-DE', {
        timeZone: FORGE_TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date());
}

async function send(level, category, message, context = null, telegramOnly = false) {
    const msg = `📅 ${fmtNotifyTimestamp()} · ${BOT_DISPLAY_NAME}\n${htmlToMd(message)}`;
    try {
        const res = await fetch(`${NEXUS_URL}/notify`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ botId: BOT_ID, displayName: BOT_DISPLAY_NAME, level, category, message: msg, context, telegramOnly }),
        });
        if (!res.ok) {
            const errText = await res.text();
            console.error(`[notify] Nexus-Fehler: HTTP ${res.status} – ${errText}`);
        }
    } catch (err) {
        console.error(`[notify] Nexus nicht erreichbar: ${err.message} | ${level} | ${category} | ${msg.slice(0, 80)}`);
    }
}

// ─── Öffentliche Nachrichten ─────────────────────────────────────────────────

/** Bot-Start */
export async function startup() {
    // Während eines Updates sendet do_update() (bin/setup-lib/lifecycle.sh) am
    // Ende EINE Zusammenfassung statt der Einzelmeldung jedes neu gestarteten
    // Bots (Fund 2026-08-09: bei mehreren Diensten kamen sonst mehrere fast
    // gleichzeitige "gestartet"-Meldungen, die nichts zueinander in Bezug
    // setzten). Ein Crash-Restart außerhalb eines Updates hat den Marker nicht
    // gesetzt und meldet sich weiterhin wie bisher.
    if (existsSync(UPDATE_SUPPRESS_FLAG)) return;
    await send('lifecycle', 'system',
        `🟢 *Liquidity Bot gestartet*\n${ACTION.fyi}`);
}

/** Neue CLMM-Position wurde geöffnet */
export async function positionOpened(pool, position) {
    const pair = pool.displayPair ?? pool.pair;
    await send('info', 'trade',
        `<b>Position geöffnet</b> – ${pair}\n` +
        `Range: ${position.priceLower.toFixed(2)} – ${position.priceUpper.toFixed(2)} USDC\n` +
        `${ACTION.fyi}`,
        { pair }
    );
}

/** Fees wurden geclaimed */
export async function feesClaimed(pool, amountA, amountB, action, txHash, usdValue = null) {
    const pair   = pool.displayPair ?? pool.pair;
    const val    = usdValue ?? amountB;
    const fmtVal = val >= 1 ? val.toFixed(2) : val >= 0.01 ? val.toFixed(4) : val.toFixed(6);
    await send('info', 'trade', `${pair}: +${fmtVal} USDC`, { pair });
}

/** Position ist out of range */
export async function outOfRange(pool, currentPrice, priceLower, priceUpper) {
    const pair = pool.displayPair ?? pool.pair;
    const side = currentPrice < priceLower ? 'unter' : 'über';
    await send('info', 'grid',
        `<b>Out of Range</b> – ${pair}\n` +
        `Preis ${currentPrice.toFixed(2)} USDC ist ${side} der Range\n` +
        `Range: ${priceLower.toFixed(2)} – ${priceUpper.toFixed(2)} USDC\n` +
        `Solange der Preis draußen ist, verdient die Position keine Gebühren. ` +
        `Es ist nichts zu tun – der Bot verschiebt die Range selbst, wenn sich das nicht von allein löst.`,
        { pair }
    );
}

/** Position ist wieder in range */
export async function backInRange(pool, currentPrice) {
    const pair = pool.displayPair ?? pool.pair;
    await send('info', 'grid',
        `<b>Wieder in Range</b> – ${pair}\n` +
        `Preis: ${currentPrice.toFixed(2)} USDC\n` +
        `Die Position verdient wieder Gebühren. ${ACTION.fyi}`,
        { pair }
    );
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
    const TIER_LABEL = {
        invest:   '🟢 INVESTIEREN',
        hold:     '🟡 HALTEN',
        withdraw: '🔴 ABZIEHEN',
        // Alt-Tier: kommt nur noch bei Übergängen aus dem alten Schema vor (vor 2026-05-18)
        observe:  '⚪ HALTEN',
    };
    const level = newTier === 'withdraw' ? 'error'
                : newTier === 'invest'   ? 'warn'
                                          : 'info';

    const totalReturn = scoreData.totalReturnAprPct ?? scoreData.netEconPct;
    const totalLine = totalReturn != null
        ? `Total Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}% p.a.`
        : '';
    const dailyPnl = scoreData.dailyPnlPct;
    const dailyLine = (dailyPnl != null)
        ? `PnL 1D: ${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(2)}%`
        : '';
    const triggerLine = scoreData.withdrawTriggers?.length
        ? `Auslöser: ${scoreData.withdrawTriggers.join(', ')}`
        : '';

    await send(level, 'ranking',
        `<b>Tier-Wechsel</b> – ${pool.displayPair ?? pool.pair}\n` +
        `${TIER_LABEL[oldTier] ?? oldTier} → ${TIER_LABEL[newTier] ?? newTier}\n` +
        (totalLine ? `${totalLine}\n` : '') +
        (dailyLine ? `${dailyLine}\n` : '') +
        (triggerLine ? `${triggerLine}\n` : '') +
        `Konfidenz: ${scoreData.confidence?.toFixed?.(0) ?? '?'}%\n` +
        (newTier === 'withdraw'
            ? 'Die Bewertung des Pools ist auf ABZIEHEN gefallen. Der Bot schließt die ' +
              'Position automatisch, sobald das Risk-Management greift – du kannst sie im ' +
              'Dashboard auch sofort selbst schließen.'
            : newTier === 'invest'
                ? 'Der Pool ist wieder attraktiv. Es ist nichts zu tun – der Bot legt beim ' +
                  'nächsten Cleanup-Lauf von selbst Kapital nach, wenn welches frei ist.'
                : ACTION.observe),
        {
            pair:              pool.displayPair ?? pool.pair,
            pool:              pool.displayPair ?? pool.pair,
            poolId:            pool.id,
            oldTier, newTier,
            totalReturnAprPct: scoreData.totalReturnAprPct,
            dailyPnlPct:       scoreData.dailyPnlPct,
            withdrawTriggers:  scoreData.withdrawTriggers,
        },
    );
}

/** APR unter Schwellenwert */
export async function aprAlert(pool, currentApr, threshold) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'system',
        `<b>APR-Alert</b> – ${pair}\n` +
        `Aktueller APR: ${currentApr.toFixed(2)}% (Schwellenwert: ${threshold}%)\n` +
        `Pool-Aktivität könnte nachgelassen haben.\n` +
        `${ACTION.observe}`,
        { pair }
    );
}

// ─── TVL-Hilfsfunktion ────────────────────────────────────────────────────────

const fmtM = v => (v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : (v / 1000).toFixed(0) + 'K');

/** TVL unter Warnschwelle (Stufe 1) */
export async function tvlWarnAlert(pool, currentTvl, threshold) {
    const pair = pool.displayPair ?? pool.pair;
    await send('error', 'tvl',
        `⚠️ <b>TVL-Warnschwelle</b> – ${pair}\n` +
        `Aktuell: ${fmtM(currentTvl)} USDC (Schwelle: ${fmtM(threshold)} USDC)\n` +
        `Im Pool liegt weniger Fremdkapital als erwartet – das drückt die Gebühren ` +
        `und erschwert den Ausstieg.\n` +
        `Es ist noch nichts zu tun. Fällt der Wert weiter, zieht der Bot das Kapital ` +
        `automatisch ab; du kannst die Position im Dashboard auch vorher schließen.`,
        { pair }
    );
}

/** TVL unter Exit-Schwelle (Stufe 2) – Notfall-Exit wird ausgelöst */
export async function tvlExitAlert(pool, currentTvl, threshold) {
    const pair = pool.displayPair ?? pool.pair;
    await send('error', 'tvl',
        `🚨 <b>NOTFALL-EXIT</b> – ${pair}\n` +
        `TVL ${fmtM(currentTvl)} USDC unter Exit-Schwelle ${fmtM(threshold)} USDC!\n` +
        `Position wird sofort geschlossen.\n` +
        `${ACTION.inWallet}`,
        { pair }
    );
}

/**
 * Allgemeine Info-Meldung.
 * Der Aufrufer liefert den Sachverhalt, die Handlungsaufforderung kommt von hier —
 * eine Info ist definitionsgemäß nichts, wofür der Nutzer etwas tun muss.
 */
export async function info(context, message) {
    await send('info', 'system',
        `<b>Info</b> – ${context}\n${message}\n${ACTION.fyi}`,
        { context, message }
    );
}

/** Range Advisor – bessere Range verfügbar → warn+range-hint → DB + Telegram */
export async function rangeHint(context, message) {
    await send('warn', 'range-hint',
        `📐 *${context}*\n${message}\n` +
        `Es ist nichts zu tun – der Bot stellt die Range beim nächsten Rebalancing selbst um.`,
        { context, message }
    );
}

/**
 * Fehler-Notification mit bereits fertig formulierter Meldung → DB + Telegram.
 * Für Callsites, die selbst schon (per describeError/matchErrorCode) eine
 * spezifische, verständliche Meldung gebaut haben — verhindert eine doppelte
 * Klassifizierung durch error(), die den fertigen Text erneut interpretieren würde.
 */
export async function errorRaw(context, message) {
    await send('error', 'system',
        `<b>Fehler</b> – ${context}\n${message}\n${ACTION.retrying}`,
        { context, message }
    );
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
    const { reason, detail, detailMode } = describeError(err);
    // SOL-Balance-Fehler sind selbstheilend (SOL-Topup in cleanup.js) → warn statt error
    const level = err?.solBalance !== undefined ? 'warn' : 'error';
    // SOL-Fehler heilen sich über den Topup selbst — dort wäre "starte den Bot neu"
    // ein falscher Rat (der Neustart ändert nichts am SOL-Bestand).
    const action = err?.solBalance !== undefined ? ACTION.selfHeal : ACTION.retrying;
    await send(level, 'system',
        `<b>Fehler</b> – ${context} – ${reason}${detailSuffix(detail, detailMode)}\n${action}`,
        { context, errorMessage: detail, errorStack: err?.stack }
    );
}

/** Reinvest (increaseLiquidity) fehlgeschlagen → DB + Telegram. */
export async function reinvestError(pool, err) {
    const pair = pool.displayPair ?? pool.pair;
    const { reason, detail, detailMode } = describeError(err);
    await send('error', 'system',
        `${pair}: Reinvest fehlgeschlagen – ${reason}${detailSuffix(detail, detailMode)}\n` +
        `Die Gebühren bleiben in der Position, es geht nichts verloren. ${ACTION.selfHeal}`,
        { context: pair, errorMessage: detail, errorStack: err?.stack }
    );
}

/**
 * openPosition fehlgeschlagen → DB + Telegram.
 * @param {string} context  z.B. 'nach Rebalancing' | 'beim Öffnen'
 */
export async function openPositionError(pool, err, context = 'beim Öffnen') {
    const pair = pool.displayPair ?? pool.pair;
    const { reason, detail, detailMode } = describeError(err);
    await send('error', 'system',
        `${pair}: Position-Öffnung fehlgeschlagen (${context}) – ${reason}${detailSuffix(detail, detailMode)}\n` +
        `Das Kapital liegt weiter in deiner Wallet. ${ACTION.selfHeal}`,
        { context: pair, errorMessage: detail, errorStack: err?.stack }
    );
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
    const { reason, detail, detailMode } = describeError(err);
    await send('error', 'system',
        `${pair}: Automatische Öffnung nach ${fails} Fehlversuchen gestoppt (${context}) – ${reason}. ` +
        `Der Pool wurde deaktiviert, das Kapital liegt in deiner Wallet.${detailSuffix(detail, detailMode)}\n` +
        `${ACTION.manual}`,
        { context: pair, errorMessage: detail, errorStack: err?.stack }
    );
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
        await send('error', 'wallet',
            `SOL-Reserve beträgt aktuell ${solBalance.toFixed(4)} SOL. ` +
            `Der Bot kann sich aus eigener Kraft nicht mehr auffüllen – für den Tausch ` +
            `in SOL fehlt ihm selbst das Geld für die Transaktionsgebühr.\n` +
            `${ACTION.topUp}`
        );
    } else {
        await send('info', 'wallet',
            `SOL-Reserve beträgt aktuell ${solBalance.toFixed(4)} SOL. ` +
            `Unter ${String(config.solReserve).replace('.', ',')} SOL werden keine neuen Positionen mehr eröffnet.\n` +
            `Bitte Wallet mit mindestens 0,15 SOL aufladen oder warten, bis sich der SOL Bestand wieder erholt.`
        );
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
    const when = phase === 'pre' ? 'vor der Liquidierung' : 'nach der Liquidierung';
    await send('error', 'wallet',
        `🔴 *Zu wenig SOL*\n` +
        `Konnte ${when} nicht genug SOL beschaffen (aktuell ${solAfter.toFixed(4)} SOL). ` +
        `Es liegt kein Guthaben in der Wallet, das sich in SOL tauschen ließe.\n` +
        `${ACTION.topUp} Ohne SOL kann der Bot die Position nicht schließen.`,
        { pair, phase, solAfter });
}

/** Allgemeine Warnung (nur DB, kein Telegram) */
export async function warn(context, err) {
    const { reason, detail } = describeError(err);
    await send('warn', 'system',
        `<b>Warnung</b> – ${context} wegen ${reason} abgebrochen.\n${ACTION.selfHeal}`,
        { context, errorMessage: detail, errorStack: err.stack }
    );
}

/** Manueller Deposit in eine bestehende oder neue Position */
export async function depositAdded(pool, depositUsdc, amountA, amountB, txHash, isNew = false) {
    const pair    = pool.displayPair ?? pool.pair;
    const tokenA  = pool.pair.split('/')[0];
    const action  = isNew ? 'Neue Position eröffnet' : 'Liquidität erhöht';
    await send('info', 'trade',
        `<b>Deposit</b> – ${pair}\n` +
        `${action}: ${amountA.toFixed(6)} ${tokenA} + ${amountB.toFixed(2)} USDC\n` +
        `Einzahlung: ${depositUsdc.toFixed(2)} USDC\n` +
        `${ACTION.fyi}`,
        { pair }
    );
}

/** Manueller Withdraw aus einer bestehenden Position */
export async function withdrawCompleted(pool, usdcRequested, amountA, amountB, fraction, txHash) {
    const pair   = pool.displayPair ?? pool.pair;
    const tokenA = pool.pair.split('/')[0];
    await send('info', 'trade',
        `<b>Auszahlung</b> – ${pair}\n` +
        `Entnommen: ${amountA.toFixed(6)} ${tokenA} + ${amountB.toFixed(2)} USDC\n` +
        `Ziel: ${usdcRequested.toFixed(2)} USDC (${(fraction * 100).toFixed(2)}% der Position)\n` +
        `${ACTION.inWallet}`,
        { pair }
    );
}

/** Pool Mindestwert wurde deaktiviert – User muss neu konfigurieren.
 *  reason: 'withdraw' | 'rebalance' */
export async function minimumValueCleared(pool, oldMinValueUsd, reason = 'withdraw') {
    const pair = pool.displayPair ?? pool.pair;
    const causeText = reason === 'rebalance'
        ? 'da der Pool-Wert nach dem Rebalancing zu nah am Mindestwert liegt'
        : 'da Coins aus dem Pool abgezogen wurden';
    await send('warn', 'trailing-stop',
        `Pool Mindestwert (${Math.round(oldMinValueUsd)} USDC) wurde beim Trailing Stop deaktiviert, ` +
        `${causeText}.\n` +
        `Solange der Mindestwert nicht gesetzt ist, greift diese Schutzschwelle nicht. ` +
        `${ACTION.configure}`,
        { pair, oldMinValueUsd, reason }
    );
}

/** Bot wird heruntergefahren */
export async function shutdown(reason = 'SIGTERM') {
    if (existsSync(UPDATE_SUPPRESS_FLAG)) return;
    // SIGTERM = geplanter Stop (Deployment, bin/svc). Alles andere ist ein Abbruch,
    // bei dem systemd zwar neu startet, ein Blick ins Log aber angebracht ist.
    const expected = reason === 'SIGTERM' || reason === 'SIGINT';
    await send('lifecycle', 'system',
        `🔴 *Liquidity Bot gestoppt* (${reason})\n` +
        (expected
            ? 'Offene Positionen bleiben bestehen, es wird nur nicht mehr nachgesteuert. ' +
              'Es ist nichts zu tun, wenn du den Stop selbst ausgelöst hast.'
            : 'Der Stop war nicht geplant. Es ist nichts zu tun – der Dienst startet automatisch ' +
              'neu. Bleibt eine Startmeldung aus, bitte den Bot-Status im Dashboard prüfen.'));
}

/**
 * Risk-Management Vorwarnung – feuert beim ersten Erreichen eines Schwellwerts,
 * bevor die eigentliche Ausführung startet.
 */
export async function rmWarning(pool, scenarioLabel, lpValueUsd) {
    const pair = pool.displayPair ?? pool.pair;
    await send('error', 'rm-warning',
        `⚠️ *Risk-Management: Ereignis steht bevor*\n` +
        `*${scenarioLabel}* erreicht.\n` +
        `Der Bot schließt die Position gleich automatisch und tauscht den Erlös in USDC. ` +
        `Es ist nichts zu tun – greif nur ein, wenn du die Position bewusst halten willst.`,
        { pair });
}

/**
 * Risk-Management Ausführung abgeschlossen – ersetzt alle szenario-spezifischen
 * Completed-Nachrichten (trailingStopCompleted, scoreLimitCompleted, rankingExitCompleted).
 */
export async function rmExecuted(pool, scenarioLabel, lpValueUsd) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'rm-executed',
        `🔴 *Risk-Management: Ereignis eingetreten*\n` +
        `*${scenarioLabel}* unterschritten: Position geschlossen.\n` +
        `${ACTION.inWallet}`,
        { pair });
}

/** Score Limit unterschritten – Position wurde geschlossen */
export async function scoreLimitTriggered(pool, score, minScore) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'score-limit',
        `Risk-Management: Opportunity Score <${minScore}\n` +
        `Die Bewertung des Pools ist unter deine Mindestschwelle gefallen, ` +
        `die Position wurde geschlossen.\n` +
        `${ACTION.inWallet}`,
        { pair });
}

/**
 * Gemeinsamer Rumpf der drei Exit-Abschlussmeldungen (Score-Limit, Ranking-Exit,
 * Trailing Stop). Vorher dreimal wortgleich kopiert — mit der neuen
 * Handlungsaufforderung wären es drei Stellen gewesen, die auseinanderdriften.
 */
function exitDoneBody(pool, headline, { coinsA, coinsB, swappedUsdc, sentTo }) {
    const [symA, symB] = pool.pair.split('/');
    let body = `${headline}\n`;
    body += `Entnommen: ${coinsA.toFixed(6)} ${symA} + ${coinsB.toFixed(6)} ${symB}\n`;
    if (swappedUsdc != null) body += `Getauscht: ${swappedUsdc.toFixed(2)} USDC\n`;
    if (sentTo) {
        body += `Gesendet an: \`${sentTo.slice(0, 8)}…\`\n`;
        body += `Es ist nichts zu tun. Das Kapital wurde an die von dir hinterlegte Adresse überwiesen.`;
    } else {
        body += `Kapital verbleibt im Wallet\n${ACTION.inWallet}`;
    }
    return body;
}

/** Score Limit vollständig abgeschlossen */
export async function scoreLimitCompleted(pool, { score, coinsA, coinsB, swappedUsdc, sentTo }) {
    const pair = pool.displayPair ?? pool.pair;
    const body = exitDoneBody(pool, `Risk-Management: Opportunity Score ${score} – abgeschlossen`,
        { coinsA, coinsB, swappedUsdc, sentTo });
    await send('warn', 'score-limit-done', body, { pair });
}

/** Score Limit fehlgeschlagen */
export async function scoreLimitError(pool, step, err) {
    const pair = pool.displayPair ?? pool.pair;
    const { reason, detail, detailMode } = describeError(err);
    await send('error', 'score-limit',
        `Risk-Management: Fehler (Schritt: ${step}) – ${reason}${detailSuffix(detail, detailMode)}\n` +
        `${ACTION.retrying}`,
        { pair, errorMessage: detail });
}

/** Ranking-Exit hat Schwelle erreicht – Ausführung beginnt */
export async function rankingExitTriggered(pool, streakHours, badDurationHours) {
    const pair = pool.displayPair ?? pool.pair;
    await send('warn', 'ranking-exit',
        `Ranking: Pool seit ${streakHours.toFixed(1)}h durchgehend schwach\n` +
        `Andere Pools sind seit über ${streakHours.toFixed(0)} Stunden durchgehend besser bewertet, ` +
        `die Position wird geschlossen.\n` +
        `Es ist nichts zu tun – der Erlös landet in deiner Wallet, die Abschlussmeldung folgt.`,
        { pair });
}

/** Ranking-Exit vollständig abgeschlossen */
export async function rankingExitCompleted(pool, { coinsA, coinsB, swappedUsdc, sentTo }) {
    const pair = pool.displayPair ?? pool.pair;
    const body = exitDoneBody(pool, 'Ranking: Abgeschlossen', { coinsA, coinsB, swappedUsdc, sentTo });
    await send('warn', 'ranking-exit-done', body, { pair });
}

/** Ranking-Exit fehlgeschlagen */
export async function rankingExitError(pool, step, err) {
    const pair = pool.displayPair ?? pool.pair;
    const { reason, detail, detailMode } = describeError(err);
    await send('error', 'ranking-exit',
        `Ranking: Fehler (Schritt: ${step}) – ${reason}${detailSuffix(detail, detailMode)}\n` +
        `${ACTION.retrying}`,
        { pair, errorMessage: detail });
}

// ─── Trailing Stop ────────────────────────────────────────────────────────────

export async function trailingStopTriggered(pool, hwmUsd, currentUsd, thresholdPct) {
    const pair = pool.displayPair ?? pool.pair;
    const drawdownPct = hwmUsd > 0 ? ((hwmUsd - currentUsd) / hwmUsd) * 100 : 0;
    await send('warn', 'trailing-stop',
        `Trailing Stop: ${drawdownPct.toFixed(1)}% Wertverlust seit Höchststand\n` +
        `Höchststand: ${hwmUsd.toFixed(2)} USDC → Aktuell: ${currentUsd.toFixed(2)} USDC\n` +
        `Die von dir gesetzte Verlustgrenze ist erreicht, die Position wird geschlossen.\n` +
        `Es ist nichts zu tun – der Erlös landet in deiner Wallet, die Abschlussmeldung folgt.`,
        { pair });
}

export async function trailingStopCompleted(pool, { coinsA, coinsB, swappedUsdc, sentTo }) {
    const pair = pool.displayPair ?? pool.pair;
    const body = exitDoneBody(pool, 'Trailing Stop: Abgeschlossen', { coinsA, coinsB, swappedUsdc, sentTo });
    await send('warn', 'trailing-stop-done', body, { pair });
}

export async function trailingStopError(pool, step, err) {
    const pair = pool.displayPair ?? pool.pair;
    const { reason, detail, detailMode } = describeError(err);
    await send('error', 'trailing-stop',
        `Trailing Stop: Fehler (Schritt: ${step}) – ${reason}${detailSuffix(detail, detailMode)}\n` +
        `${ACTION.retrying}`,
        { pair, errorMessage: detail });
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
 * @param {string} summary  Einzeilige Zusammenfassung
 * @param {object} details  Strukturierte Details für DB-Context
 */
export async function opportunityParamCheck(status, summary, details) {
    if (status === 'ok') return;
    const level = status === 'update_recommended' ? 'error' : 'warn';
    const icon  = status === 'update_recommended' ? '⚠️' : 'ℹ️';
    await send(level, 'opportunity-score',
        `${icon} *Opportunity-Score Param-Check*\n${summary}\n` +
        (status === 'update_recommended'
            ? 'Die Bewertungsparameter passen nicht mehr gut zum Marktverhalten. ' +
              'Bitte im Dashboard den Score-Adviser aufrufen und die vorgeschlagenen Werte prüfen.'
            : ACTION.observe),
        details,
    );
}

// ─── FORGE.pub Premium: Pool-Offer-Lebenszyklus ──────────────────────────────

/**
 * Erste Feststellung, dass ein übernommener Pool zurückgestuft wurde. Noch passiert
 * NICHTS mit dem Kapital — die Meldung sagt ausdrücklich, was wann folgt, damit der
 * Nutzer vorher eingreifen kann.
 */
export async function premiumPoolRetired(pool, { reason, kind, confirmHours }) {
    const pair = pool.displayPair ?? pool.pair;
    const wie = kind === 'absent'
        ? 'Er fehlt in der Angebotsliste des Datendienstes.'
        : 'Der Datendienst hat ihn ausdrücklich zurückgestuft.';
    await send('warn', 'premium-offer',
        `📉 <b>Pool zurückgestuft</b> – ${pair}\n` +
        `${wie}\n${reason}\n\n` +
        `Bleibt das ${confirmHours}h stabil, wird die Position automatisch geschlossen und ` +
        `der Erlös in USDC getauscht (er bleibt in deiner Wallet). ` +
        `Bis dahin passiert nichts – du kannst den Pool vorher selbst schließen oder behalten.`,
        { pair, reason, kind }
    );
}

/** Rückstufung zurückgenommen, bevor der Exit lief. */
export async function premiumPoolReinstated(pool) {
    const pair = pool.displayPair ?? pool.pair;
    await send('info', 'premium-offer',
        `<b>Rückstufung aufgehoben</b> – ${pair}\n` +
        `Der Datendienst bietet den Pool wieder an. Der geplante automatische Exit entfällt.\n` +
        `${ACTION.fyi}`,
        { pair }
    );
}

/** Kapital wurde wegen der Rückstufung aus dem Pool gezogen → DB + Telegram. */
export async function premiumPoolExitDone(pool, { reason, swappedUsdc, observedTvlUsd }) {
    const pair = pool.displayPair ?? pool.pair;
    const erlös = swappedUsdc > 0 ? `${swappedUsdc.toFixed(2)} USDC` : 'kein Erlös (Position war leer)';
    const eigen = observedTvlUsd > 0
        ? `\nEigene Messung zum Zeitpunkt des Exits: Pool-TVL ${fmtM(observedTvlUsd)} USDC.`
        : '';
    await send('error', 'premium-offer',
        `🚪 <b>Pool verlassen (zurückgestuft)</b> – ${pair}\n` +
        `${reason}\n` +
        `Position geschlossen, Erlös: ${erlös} – in deiner Wallet.${eigen}\n` +
        `Der Pool ist jetzt gesperrt und wird nicht automatisch neu bestückt.\n` +
        `${ACTION.inWallet}`,
        { pair, reason, swappedUsdc }
    );
}

export async function premiumPoolExitError(pool, err) {
    const pair = pool.displayPair ?? pool.pair;
    await send('error', 'premium-offer',
        `🚨 <b>Exit nach Rückstufung fehlgeschlagen</b> – ${pair}\n` +
        `${err.message}\nDer Pool bleibt gesperrt, das Kapital liegt noch in der Position.\n` +
        `${ACTION.retrying}`,
        { pair, error: err.message }
    );
}

/** Übernommene Feldänderungen eines bestehenden Pools (alt → neu, im Klartext). */
export async function premiumPoolUpdated(pool, { applied, deferred }) {
    const pair = pool.displayPair ?? pool.pair;
    const fmt = v => (v === null || v === undefined || v === '') ? 'no data' : String(v);
    const lines = applied.map(c => `• ${c.label}: ${fmt(c.from)} → ${fmt(c.to)}`).join('\n');
    const rest = deferred.length > 0
        ? `\n\nAufgeschoben, solange Kapital im Pool liegt (ändert die Berechnung laufender ` +
          `Positionen):\n${deferred.map(c => `• ${c.label}: ${fmt(c.from)} → ${fmt(c.to)}`).join('\n')}`
        : '';
    await send('info', 'premium-offer',
        `🔄 <b>Pool-Angaben aktualisiert</b> – ${pair}\n${lines}${rest}\n\n` +
        `Betrifft nur die Vorschlagswerte. Eigene Einstellungen im Risk-Management bleiben unverändert.\n` +
        `${ACTION.fyi}`,
        { pair, applied, deferred }
    );
}

/**
 * Ein Offer beschreibt unter bekannter ID einen anderen Pool (Adresse/Mints/Fee-Tier
 * weichen ab). Das ist kein Update, sondern ein Bruch — nie still übernehmen.
 */
export async function premiumPoolIdentityMismatch(pool, changes) {
    const pair = pool.displayPair ?? pool.pair;
    const lines = changes.map(c => `• ${c.field}: lokal ${c.local} ≠ geliefert ${c.offered}`).join('\n');
    await send('error', 'premium-offer',
        `🚨 <b>Angebot passt nicht zum bekannten Pool</b> – ${pair}\n${lines}\n\n` +
        `Entweder hat der Datendienst einen Fehler, oder die Lieferung wurde verändert.\n` +
        `${ACTION.verify}`,
        { pair, changes }
    );
}

/** Neue Orca-Pools über Fees24h- und TVL-Schwelle, noch nicht in pools.json */
export async function newPoolsFound(pools, feesThresholdUsdc, tvlThresholdUsdc) {
    const lines = pools.map(p =>
        `${p.pair} – Fees24h ${p.fees24h.toFixed(0)} USDC, TVL ${p.tvlUsd.toFixed(0)} USDC\n\`${p.address}\``
    ).join('\n\n');
    await send('warn', 'new-pool-alert',
        `🆕 *Neue Orca-Pool(s)* – Fees24h ≥ ${feesThresholdUsdc.toLocaleString('de-DE')} USDC, TVL ≥ ${tvlThresholdUsdc.toLocaleString('de-DE')} USDC\n\n${lines}\n\n` +
        `Es ist nichts zu tun. Wenn du einen der Pools nutzen willst, musst du ihn selbst anlegen — ` +
        `der Bot investiert nicht von allein in unbekannte Pools.`,
        { pools: pools.map(p => p.address) },
        true, // telegramOnly – nur Erinnerung, keine Dashboard-Notification
    );
}
