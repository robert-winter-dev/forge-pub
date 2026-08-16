/**
 * FORGE public – Zustand der Systemdaten-Freigabe auf dem FORK (FORK-ONLY)
 *
 * Gegenstück zur Master-seitigen Allowlist (`core/premium/health-share-allowlist.js`).
 * Hier steht ausschließlich, was der Nutzer selbst entschieden hat und was seitdem
 * passiert ist — nie, ob er freigeschaltet ist. Das weiß nur der Master.
 *
 * 🔒 **`enabled` ist der Nutzerwille, sonst nichts.** Der Schalter darf niemals vom
 * System umgelegt werden (auch nicht bei ausbleibenden Reports oder einem Widerruf) —
 * dasselbe Prinzip wie bei `premium_settings.enabled` in lib/premium-auto-pay-store.js:
 * würde ein Systemzustand denselben Schalter umlegen, ließe sich ein späteres
 * automatisches Wieder-Einschalten nicht mehr von einem bewussten Nutzer-Stopp
 * unterscheiden. Systemzustände bekommen deshalb eigene Spalten.
 *
 * 🔒 **Der Zugang hängt NICHT an diesem Zustand.** Ob Premium tatsächlich läuft,
 * entscheidet allein, ob Daten ankommen (`getPremiumCoverage()`, `coverageSource`).
 * Dieser Speicher steuert nur das Senden und die Anzeige — ein manipulierter Wert hier
 * verschafft niemandem Zugang.
 */

import Database from 'better-sqlite3';
import { PATHS } from '../config/paths.js';

function openDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS health_share_settings (
            id                INTEGER PRIMARY KEY CHECK (id = 1),
            enabled           INTEGER NOT NULL DEFAULT 0,
            applied_at        INTEGER,
            last_report_at    INTEGER,
            last_report_error TEXT,
            revoked_hint_at   INTEGER
        );
        INSERT OR IGNORE INTO health_share_settings (id, enabled) VALUES (1, 0);
    `);
    // approved_at (2026-08-13): Zeitpunkt der vom Master bestätigten Freischaltung.
    // Seit dem Kurswechsel 2026-08-14 steuert das NICHT mehr das Senden (siehe
    // maySendReports()), sondern nur noch die Anzeige: Es ist der lokale Beleg dafür,
    // dass dieser Installation zusätzlich Premium zugesagt wurde. Gesendet wird
    // unabhängig davon, sobald der Nutzer den Haken setzt.
    const cols = db.prepare(`PRAGMA table_info(health_share_settings)`).all().map(c => c.name);
    if (!cols.includes('approved_at')) {
        db.exec(`ALTER TABLE health_share_settings ADD COLUMN approved_at INTEGER`);
    }
    // health_share_sent_reports (2026-08-14, Kurswechsel): voller Text jedes gesendeten
    // Reports, lokal auf dem FORK. Ersetzt die frühere Anzeige über das Message Center
    // (dort lief der Report als System-Notification über den Nexus) — ein stündlicher
    // Report ist Telemetrie, kein Ereignis, das dort Aufmerksamkeit verdient, und hätte
    // das gemeinsame 100er-Fenster des Message Centers mit steigender Teilnehmerzahl
    // zunehmend verdrängt (siehe recordSentReport()).
    db.exec(`
        CREATE TABLE IF NOT EXISTS health_share_sent_reports (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            sent_at INTEGER NOT NULL,
            text    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hssr_sent_at ON health_share_sent_reports(sent_at);
    `);
    return db;
}

/**
 * Wie lange gesendete Reports lokal vorgehalten werden (2026-08-14, Nachbesserung:
 * löst die vorherige Zeilen-Obergrenze ab — Vorgabe war ausdrücklich ein Zeitfenster,
 * „damit wirklich nur die Nachrichten der letzten 7 Tage aufgehoben werden").
 */
export const SENT_REPORTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Löscht alle Reports außerhalb des Zeitfensters. Wird an ZWEI Stellen aufgerufen,
 * nicht nur einer — beide sind nötig, nicht redundant:
 *   - `recordSentReport()`: hält die Tabelle klein, auch wenn nie jemand hinschaut
 *     (sonst wüchse sie beim Senden ohne Freischaltung unbegrenzt weiter).
 *   - `listSentReports()`: „lazy bei jedem Lesezugriff" (gleiches Muster wie
 *     `expireStale()` in core/premium/health-share-allowlist.js) — ohne das bliebe
 *     ein Report sichtbar, der zwar beim letzten Senden noch frisch war, seither
 *     aber aus dem Fenster gefallen ist, weil in der Zwischenzeit nichts Neues kam
 *     (Widerruf, Pause, gestoppter Dienst).
 * Das WHERE in der SELECT-Query darunter ist bewusst zusätzlich zum Pruning gesetzt,
 * nicht nur eine Optimierung: Zeigt die Anzeige NIE etwas außerhalb des Fensters,
 * selbst wenn das Löschen aus irgendeinem Grund ausbliebe.
 */
function pruneSentReports(db, now) {
    db.prepare(`DELETE FROM health_share_sent_reports WHERE sent_at < ?`).run(now - SENT_REPORTS_RETENTION_MS);
}

export function isShareEnabled({ dbPath = PATHS.settingsDb } = {}) {
    const db = openDb(dbPath);
    try {
        return db.prepare(`SELECT enabled FROM health_share_settings WHERE id = 1`).get()?.enabled === 1;
    } finally {
        db.close();
    }
}

/**
 * Ob der Master dieser Installation Premium zugesagt hat (und die Zusage nicht
 * widerrufen ist). Einziger Nutzer ist der npub-Lock: Zu schützen ist die Zusage, denn
 * sie hängt am npub — wer nur Daten teilt, verliert bei einem Wechsel nichts.
 */
export function isShareApproved({ dbPath = PATHS.settingsDb } = {}) {
    const db = openDb(dbPath);
    try {
        const row = db.prepare(`SELECT approved_at, revoked_hint_at FROM health_share_settings WHERE id = 1`).get();
        return row?.approved_at != null && row?.revoked_hint_at == null;
    } finally {
        db.close();
    }
}

/**
 * Legt den Haken um. Beim Ausschalten werden `applied_at` und die Report-Spuren
 * zurückgesetzt: Ein erneutes Einschalten ist eine NEUE Aktivierung, kein Fortsetzen —
 * die alte Freischaltung hängt am npub und gilt beim Master unabhängig weiter oder
 * eben nicht. Einen halb erinnerten Zwischenstand anzuzeigen wäre irreführend.
 */
export function setShareEnabled(enabled, { dbPath = PATHS.settingsDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        if (enabled) {
            db.prepare(`UPDATE health_share_settings SET enabled = 1 WHERE id = 1`).run();
        } else {
            db.prepare(`
                UPDATE health_share_settings
                   SET enabled = 0, applied_at = NULL, last_report_at = NULL,
                       last_report_error = NULL, revoked_hint_at = NULL, approved_at = NULL
                 WHERE id = 1
            `).run();
        }
        return { ok: true, enabled: !!enabled, at: now };
    } finally {
        db.close();
    }
}

/** Hält fest, dass die Aktivierungsnachricht (genau eine, reine Identifikation) raus ist. */
export function recordApplicationSent({ dbPath = PATHS.settingsDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        db.prepare(`UPDATE health_share_settings SET applied_at = ? WHERE id = 1`).run(now);
    } finally {
        db.close();
    }
}

/**
 * Vom Master bestätigte Freischaltung bzw. deren Widerruf. Steuert die Premium-Anzeige
 * und den npub-Lock (siehe `isShareApproved()`) — das stündliche Senden hängt seit dem
 * Kurswechsel nicht mehr daran (siehe `maySendReports()`).
 *
 * Der Widerruf setzt `enabled` bewusst NICHT zurück: das ist der Nutzerwille und gehört
 * ihm. Er sieht den Hinweis, entscheidet selbst — und wäre der Haken automatisch
 * gefallen, ließe sich später ein bewusstes Abschalten nicht mehr von einem
 * systemseitigen unterscheiden.
 */
export function setApproved(approved, { dbPath = PATHS.settingsDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        if (approved) {
            db.prepare(`UPDATE health_share_settings SET approved_at = ?, revoked_hint_at = NULL WHERE id = 1`).run(now);
        } else {
            db.prepare(`UPDATE health_share_settings SET approved_at = NULL, revoked_hint_at = ? WHERE id = 1`).run(now);
        }
    } finally {
        db.close();
    }
}

/**
 * 🔒 Die Bedingung fürs Senden: der Haken. Sonst nichts — der Haken selbst ist die
 * Zustimmung. Die Freischaltung entscheidet unabhängig davon nur noch, ob jemand
 * zusätzlich Premium bekommt (Master-seitige Allowlist).
 *
 * 🔒 Ein Widerruf sperrt das Senden weiterhin. Nicht wegen Premium, sondern weil der
 * Master die Reports eines Widerrufenen ohnehin verwirft (`recordReport()`): Weiter zu
 * senden wäre Funkverkehr ins Leere. Der Widerruf ist die Notbremse des Betreibers und
 * muss in beide Richtungen wirken.
 *
 * Fail-closed — jeder unklare Zustand liefert false und es fließt nichts.
 */
export function maySendReports({ dbPath = PATHS.settingsDb } = {}) {
    const db = openDb(dbPath);
    try {
        const row = db.prepare(`SELECT enabled, revoked_hint_at FROM health_share_settings WHERE id = 1`).get();
        return row?.enabled === 1 && row?.revoked_hint_at == null;
    } finally {
        db.close();
    }
}

/**
 * Ergebnis des letzten Sendeversuchs. `error = null` heißt Erfolg und löscht einen
 * vorherigen Fehler — der Zustand „letzter Report fehlgeschlagen" darf nicht kleben
 * bleiben, nachdem es wieder läuft.
 */
export function recordReportAttempt(error = null, { dbPath = PATHS.settingsDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        if (error) {
            db.prepare(`UPDATE health_share_settings SET last_report_error = ? WHERE id = 1`)
                .run(String(error).slice(0, 300));
        } else {
            db.prepare(`UPDATE health_share_settings SET last_report_at = ?, last_report_error = NULL WHERE id = 1`)
                .run(now);
        }
    } finally {
        db.close();
    }
}

/**
 * Hält den vollen, lesbaren Text eines gesendeten Reports lokal fest — die einzige
 * Stelle, an der der Nutzer nachvollziehen kann, was seine Installation tatsächlich
 * überträgt (Health Monitor > „Daten teilen"). Prunt auf `MAX_SENT_REPORTS` (gleiches
 * Muster wie `MAX_NOTIFICATIONS` in core/nexus/notify-db.js).
 */
export function recordSentReport(text, { dbPath = PATHS.settingsDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        db.prepare(`INSERT INTO health_share_sent_reports (sent_at, text) VALUES (?, ?)`).run(now, String(text ?? ''));
        pruneSentReports(db, now);
    } finally {
        db.close();
    }
}

/**
 * Für die Anzeige im Health Monitor: neueste zuerst, nie älter als
 * `SENT_REPORTS_RETENTION_MS`. Prunt zuerst (siehe `pruneSentReports()`), filtert im
 * selben Aufruf zusätzlich per `WHERE` — zwei unabhängige Sicherungen für dasselbe
 * Versprechen, keine der beiden ist die „eigentliche".
 */
export function listSentReports({ dbPath = PATHS.settingsDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        pruneSentReports(db, now);
        return db.prepare(`
            SELECT sent_at AS sentAt, text FROM health_share_sent_reports
             WHERE sent_at >= ?
             ORDER BY id DESC
        `).all(now - SENT_REPORTS_RETENTION_MS);
    } finally {
        db.close();
    }
}

/**
 * Voller Zustand für die Anzeige. `phase` fasst die Zustandstabelle aus der
 * Festlegung an EINER Stelle zusammen,
 * damit Frontend und Health-Monitor nicht je eigene, driftende Ableitungen bauen.
 *
 * @param {{hasSharedCoverage?: boolean}} [ctx] - kommt von getPremiumCoverage()
 *        (coverageSource === 'shared'): der einzige belastbare Beleg dafür, dass der
 *        Master tatsächlich freigeschaltet hat. Lokal ist das nicht bekannt.
 */
export function getShareState({ hasSharedCoverage = false } = {}, { dbPath = PATHS.settingsDb } = {}) {
    const db = openDb(dbPath);
    let row;
    try {
        row = db.prepare(`
            SELECT enabled, applied_at AS appliedAt, last_report_at AS lastReportAt,
                   last_report_error AS lastReportError, revoked_hint_at AS revokedHintAt,
                   approved_at AS approvedAt
              FROM health_share_settings WHERE id = 1
        `).get();
    } finally {
        db.close();
    }

    const enabled = row?.enabled === 1;
    // Reihenfolge ist Absicht: ein Widerruf muss sichtbar sein, auch wenn noch eine
    // bezahlte/gedeckte Stunde nachläuft — sonst erführe der Nutzer erst beim
    // stillen Ende, dass ihm der Zugang entzogen wurde.
    let phase;
    if (!enabled)                        phase = 'off';
    else if (row?.revokedHintAt != null) phase = 'revoked';
    // 🔒 Ohne bestätigte Freischaltung NIE 'active' — auch dann nicht, wenn noch eine
    // Deckung aus einer früheren Runde nachläuft. Sonst meldet die Oberfläche "Freigabe
    // aktiv", während gar nichts gesendet werden kann (Fund im ersten echten Durchlauf
    // 2026-08-13: Haken erneut gesetzt, Deckung lief noch, `approved_at` war aber leer).
    else if (row?.approvedAt == null)    phase = row?.appliedAt != null ? 'applied' : 'enabling';
    else if (hasSharedCoverage)          phase = row?.lastReportError ? 'active_degraded' : 'active';
    else                                 phase = 'approved_waiting';

    return {
        enabled,
        phase,
        appliedAt:       row?.appliedAt ?? null,
        approvedAt:      row?.approvedAt ?? null,
        lastReportAt:    row?.lastReportAt ?? null,
        lastReportError: row?.lastReportError ?? null,
    };
}

export async function selfTest() {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { randomBytes } = await import('crypto');
    const fs = await import('fs');

    const dbPath = join(tmpdir(), `health-share-state-selftest-${randomBytes(4).toString('hex')}.db`);
    const failures = [];
    const check = (cond, msg) => { if (!cond) failures.push(msg); };
    const o = { dbPath };

    try {
        check(isShareEnabled(o) === false, 'frischer Zustand sollte ausgeschaltet sein');
        check(getShareState({}, o).phase === 'off', 'phase sollte "off" sein');

        setShareEnabled(true, o);
        check(getShareState({}, o).phase === 'enabling', 'eingeschaltet, Aktivierung noch nicht raus → "enabling"');

        // 🔒 npub-Lock hängt an der ZUSAGE, nicht am Haken (Kurswechsel 2026-08-14):
        // resetLockReason() in core/premium/server.js liest isShareApproved(). Wer nur
        // Daten teilt, darf seinen Nostr-Zugang jederzeit wechseln — er verliert dabei
        // nichts. Nur eine Premium-Zusage hängt am npub und wäre danach verloren.
        check(isShareEnabled(o) === true, 'Haken gesetzt, aber isShareEnabled() false');
        check(isShareApproved(o) === false,
            '🔴 npub-Lock griffe zu früh: gesperrt, obwohl nur der Haken gesetzt ist');

        // 🔒 Der Haken allein erlaubt das Senden (Kurswechsel 2026-08-14): „Daten teilen"
        // ist gewöhnliche Opt-in-Telemetrie, die Zustimmung ist der Haken. Vorher hing das
        // Senden zusätzlich an der Freischaltung — ein Nutzer ohne Freischaltung sendete
        // dadurch nie und wartete dauerhaft auf eine Rückmeldung, die nie kam.
        check(maySendReports(o) === true, '🔴 Haken gesetzt, aber es würde nichts gesendet');

        recordApplicationSent(o);
        check(getShareState({}, o).phase === 'applied', 'aktiviert, keine Deckung → "applied"');
        check(maySendReports(o) === true, '🔴 Senden nach der Aktivierungsnachricht gesperrt');

        setApproved(true, o);
        check(maySendReports(o) === true, 'nach Freischaltung sollte gesendet werden dürfen');
        check(isShareApproved(o) === true, 'nach der Zusage sollte der npub-Lock greifen');
        check(getShareState({}, o).phase === 'approved_waiting',
            'freigeschaltet, noch keine Deckung → "approved_waiting"');

        // 🔴 Nachlaufende Deckung ohne Freischaltung darf NICHT "aktiv" behaupten.
        setApproved(false, o);
        db_check_helper: {
            const st = getShareState({ hasSharedCoverage: true }, o);
            check(st.phase !== 'active',
                '🔴 "aktiv" gemeldet, obwohl keine Freischaltung vorliegt (nichts sendbar)');
        }
        setApproved(true, o);

        // Erst die vom Master bestätigte Deckung macht den Zustand "aktiv" – ein rein
        // lokaler Wert darf das nie behaupten.
        check(getShareState({ hasSharedCoverage: true }, o).phase === 'active',
            'Deckung vorhanden → "active"');

        // Widerruf: sofort sichtbar und sofort sendesperrend, auch bei laufender Deckung.
        // 🔒 Der Widerruf ist die Notbremse des Betreibers — der Master verwirft die
        // Reports eines Widerrufenen ohnehin, also darf der Fork sie erst gar nicht
        // schicken. Das ist der einzige Grund, aus dem ein gesetzter Haken NICHT sendet.
        setApproved(false, o);
        check(maySendReports(o) === false, '🔴 nach Widerruf wurde weiter gesendet');
        check(getShareState({ hasSharedCoverage: true }, o).phase === 'revoked',
            '🔴 Widerruf blieb hinter der noch laufenden Deckung verborgen');
        check(isShareEnabled(o) === true,
            'Widerruf darf den Nutzerwillen (Haken) nicht umlegen');
        setApproved(true, o);

        recordReportAttempt('Relay nicht erreichbar', o);
        check(getShareState({ hasSharedCoverage: true }, o).phase === 'active_degraded',
            'Sendefehler → "active_degraded"');
        recordReportAttempt(null, o);
        check(getShareState({ hasSharedCoverage: true }, o).phase === 'active',
            'nach Erfolg darf der Fehlerzustand nicht kleben bleiben');
        check(getShareState({ hasSharedCoverage: true }, o).lastReportAt != null,
            'erfolgreicher Report sollte einen Zeitpunkt hinterlassen');

        // Ausschalten setzt zurück – ein erneutes Einschalten ist eine neue Aktivierung.
        setShareEnabled(false, o);
        const off = getShareState({ hasSharedCoverage: true }, o);
        check(off.phase === 'off', 'ausgeschaltet → "off", auch bei noch laufender Deckung');
        check(off.appliedAt === null, 'Ausschalten sollte die alte Aktivierung vergessen');

        // ── Verlauf gesendeter Reports: 7-Tage-Fenster (Kurswechsel 2026-08-14) ─
        check(listSentReports(o).length === 0, 'frischer Zustand sollte keinen Verlauf haben');
        recordSentReport('Report 1', o);
        recordSentReport('Report 2', o);
        const history = listSentReports(o);
        check(history.length === 2, 'beide Reports sollten im Verlauf stehen');
        check(history[0].text === 'Report 2', 'neuester Report sollte zuerst stehen');

        // 🔒 Kernanforderung: WIRKLICH nur die letzten 7 Tage, nicht mehr, nicht
        // weniger. Drei Zeitpunkte um die Grenze herum, alle mit demselben "jetzt".
        const jetzt      = Date.now();
        const zuAlt      = jetzt - (SENT_REPORTS_RETENTION_MS + 24 * 60 * 60 * 1000); // 8 Tage
        const nochFrisch = jetzt - (SENT_REPORTS_RETENTION_MS - 24 * 60 * 60 * 1000); // 6 Tage
        recordSentReport('Acht Tage alt', { ...o, now: zuAlt });
        recordSentReport('Sechs Tage alt', { ...o, now: nochFrisch });
        recordSentReport('Ganz frisch', { ...o, now: jetzt });

        // 'Report 1'/'Report 2' von oben stehen (mit echtem Date.now()) ebenfalls noch
        // im Fenster — die Erwartung muss sie mitzählen, sonst testet der Vergleich am
        // falschen Ausgangszustand.
        const fenster = listSentReports({ ...o, now: jetzt });
        check(fenster.length === 4,
            `🔴 Verlauf sollte 'Report 1', 'Report 2', 'Sechs Tage alt' und 'Ganz frisch' zeigen (4), hat aber ${fenster.length}`);
        check(!fenster.some(r => r.text === 'Acht Tage alt'),
            '🔴 ein 8 Tage alter Report wurde NICHT aus dem Verlauf gefiltert');
        check(fenster[0].text === 'Ganz frisch', 'neuester Report sollte zuerst stehen');
        check(fenster.some(r => r.text === 'Sechs Tage alt'),
            'ein 6 Tage alter Report sollte noch im Fenster sein');

        // Pruning wirkt auch OHNE erneuten Lesezugriff – recordSentReport() selbst
        // räumt auf, die Tabelle wächst also nicht unbegrenzt, nur weil nie jemand
        // den Verlauf öffnet. Direkt gegen die Tabelle geprüft (nicht über
        // listSentReports(), das filtert ohnehin nochmal separat) — sonst bewiese
        // der Test nur den Lesefilter, nicht das eigentliche Löschen.
        recordSentReport('Nach dem Aufräumen', { ...o, now: jetzt });
        const rawDb = new Database(dbPath);
        const rowCount = rawDb.prepare(`SELECT COUNT(*) AS n FROM health_share_sent_reports`).get().n;
        rawDb.close();
        check(rowCount === 5,
            `🔴 der 8 Tage alte Report hätte physisch aus der Tabelle gelöscht sein müssen (${rowCount} Zeilen statt 5)`);
    } finally {
        fs.rmSync(dbPath, { force: true });
    }

    return { ok: failures.length === 0, failures };
}
