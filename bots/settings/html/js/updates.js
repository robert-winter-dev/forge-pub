/**
 * FORGE – System > Updates
 *
 * Bedient bots/settings/routes/update.js. check/apply/rollback laufen über
 * eine Task-Queue (bot-control-daemon.js). Bei apply/rollback schreibt der
 * Daemon die Ausgabe von setup.sh laufend in die DB (siehe dort
 * runUpdateTask()) – die Checkliste pollt daher während des Laufs und rendert
 * bei jedem Poll neu aus dem bis dahin gesammelten Output. "Jetzt prüfen" ist
 * kurz und abgeschlossen, zeigt daher ein festes 3-Zeilen-Ergebnis statt
 * live zu pollen (siehe runCheck()).
 */

import { initNav, initFooter }        from '/forge/js/nav.js?v=20260826a';
import { t as tr, NUM_LOCALE } from '/forge/js/i18n.js?v=20260811a';
import { showToast }                  from '/forge/js/toast.js?v=20260722b';
import { showModal, closeModal, getModal } from '/forge/js/modal.js?v=20260731a';
import { initMessageBell }            from '/forge/js/message-bell.js?v=20260825a';
import { initForgeTooltip }           from './tooltip.js?v=20260811a';

initNav({ current: 'updates', logout: '/api/auth/logout' });
// Bewusst ohne botName: die zweite Footer-Zeile ist für "<Name>: <Version>" gedacht
// und wird per id="footerVersion" nachgefüllt (siehe initFooter() in nav.js). Diese
// Seite hat keine eigene Bot-Version zu zeigen – übrig blieb ein nacktes "Settings:"
// ohne Wert dahinter (2026-08-16, gleicher Fund wie zuvor in message.js).
initFooter();
initForgeTooltip();
// Ungelesen-Zähler im Kopf – gleiche Einbindung wie index.html/message.html.
// Fehlte hier bis 2026-08-10: ein Update erzeugt eine System-Nachricht
// ("Update eingespielt – Version X"), ohne den Briefumschlag blieb sie auf
// dieser Seite aber unsichtbar. requireLan:false wie in settings.js, die Seite
// ist ohnehin nur über den LAN-Port erreichbar.
const refreshMessageBell = initMessageBell({ requireLan: false });

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fmtTime(ts) {
    if (!ts) return 'nie';
    const d = new Date(ts);
    return tr('time.hour_label', '{time} Uhr', {
        time: `${d.toLocaleDateString(NUM_LOCALE)} ${d.toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' })}`,
    });
}

function fmtDate(ts) {
    if (!ts) return 'unbekannt';
    return new Date(ts).toLocaleDateString(NUM_LOCALE);
}

function setLastUpdate() {
    const el = $('lastUpdate');
    if (el) el.textContent = tr('upd.last_loaded', 'Zuletzt geladen: {time} Uhr', {
        time: new Date().toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' }),
    });
}

// ── Checkliste (Protokoll) ────────────────────────────────────────────────────
// steps: [{ label, state: 'pending'|'done'|'failed'|'neutral'|'info' }]
// 'info' bewusst OHNE Icon (leerer String) – für reine Ergebniszeilen wie
// "Kein neues Update verfügbar.", die kein Prüfschritt sind und daher weder
// Haken noch Punkt tragen sollen (Feedback 2026-08-11).
const ICON = { pending: '◌', done: '✓', failed: '✗', neutral: '·', info: '' };

// 🔴 INKREMENTELL, bewusst kein innerHTML-Neuaufbau (Fix 2026-08-10): Das
// Protokoll wird während eines Updates alle 2s neu gezeichnet. Wurde dabei die
// ganze Liste ersetzt, startete JEDE Zeile ihre Einblend-Animation (opacity:0 →
// 1) erneut — die komplette Liste blinkte im 2-Sekunden-Takt. Jetzt werden nur
// wirklich neue Zeilen angehängt (die animieren), bestehende bleiben unberührt
// und ändern höchstens ihren Zustand (Icon/Klasse) an Ort und Stelle.
let _renderedSteps = [];

function stepHtml(s) {
    // Icon direkt HINTER dem Text (nicht am rechten Boxrand) – einheitlich mit
    // der Core-Versionszeile oben in der Versionen-Box. <li> bleibt bewusst OHNE
    // display:flex, sonst unterdrückt der Browser den Aufzählungspunkt.
    return `${s.label} <span class="up-step-icon">${ICON[s.state] ?? ICON.pending}</span>`;
}

function resetChecklist() {
    _renderedSteps = [];
    const container = $('upChecklist');
    if (container) container.innerHTML = '';
}

// Zuletzt bekannter Stand, unabhängig davon ob das Protokoll-Modal gerade offen
// ist – #upChecklist existiert nur, während das Modal offen ist (openLogModal()).
// Läuft eine Aktion weiter, während das Modal geschlossen wird, merkt sich
// renderChecklist() den Fortschritt trotzdem und rendert beim nächsten Öffnen
// einmal komplett neu nach.
let _lastSteps = [];

function renderChecklist(steps) {
    _lastSteps = steps;
    const container = $('upChecklist');
    if (!container) return; // Modal gerade geschlossen – nur Modell pflegen

    if (!steps.length) {
        _renderedSteps = [];
        container.innerHTML = '';
        return;
    }

    let list = container.querySelector('.up-checklist-list');
    // Neuaufbau nur, wenn es die Liste noch nicht gibt oder Zeilen WEGgefallen
    // sind (Aktionswechsel) – im Normalfall wächst sie nur.
    if (!list || steps.length < _renderedSteps.length) {
        container.innerHTML = '<ul class="up-checklist-list"></ul>';
        list = container.querySelector('.up-checklist-list');
        _renderedSteps = [];
    }

    steps.forEach((s, i) => {
        const prev = _renderedSteps[i];
        if (!prev) {
            const li = document.createElement('li');
            li.className = `up-step state-${s.state}`;
            li.innerHTML = stepHtml(s);
            list.appendChild(li);            // nur DIESE Zeile animiert
        } else if (prev.state !== s.state || prev.label !== s.label) {
            const li = list.children[i];
            if (li) {
                li.className = `up-step state-${s.state} up-step-settled`; // ohne Einblend-Animation
                li.innerHTML = stepHtml(s);
            }
        }
    });

    _renderedSteps = steps.map(s => ({ ...s }));
    // Immer die neueste Zeile im Blick behalten (Box scrollt, statt zu wachsen).
    list.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

// Verwandelt die rohe update-check.js-Ausgabe ("[update-check] <Text>" pro
// Zeile) in Checklisten-Einträge: ✓ in der Zeile → done, 🔴 → failed, sonst neutral.
function parseLogLines(output) {
    if (!output) return [];
    return output.split('\n')
        .map(line => line.replace(/^\[update-check\]\s*/, '').trim())
        .filter(Boolean)
        .map(label => {
            let state = 'neutral';
            if (label.includes('✓')) state = 'done';
            else if (label.includes('🔴')) state = 'failed';
            return { label, state };
        });
}

// Zwei Quellen liefern Phasen, BEIDE müssen als eigene Zeile erscheinen:
//   1. setup.sh gliedert über step() ("── <Label>", bin/setup-lib/output.sh)
//   2. bin/update-check.js rahmt das Ganze mit "[update-check] <Text>" ein
//      (Signaturprüfung, Entpacken und vor allem "Warte 120s auf Health-Gate …")
// 🔴 Fix 2026-08-10: Anfangs zählten nur "──"-Zeilen als Phase. Die Health-Gate-
// Meldung wurde dadurch als Detailzeile der letzten setup.sh-Phase verschluckt —
// die Anzeige stand zwei Minuten lang scheinbar bei "Logrotate" fest, obwohl
// der Vorgang normal weiterlief. Alles andere bleibt Detailzeile und dient nur
// der Fehlererkennung innerhalb der laufenden Phase.
function parseSetupPhases(output, taskStatus) {
    if (!output) return [];
    const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
    const phases = [];
    let current = null;
    const pushPhase = (label) => {
        current = { label, state: 'pending', failed: false };
        phases.push(current);
    };
    for (const line of lines) {
        const setupPhase  = line.match(/^──\s*(.+)$/);
        const updatePhase = line.match(/^\[update-check\]\s*(.+)$/);
        if (setupPhase)  { pushPhase(setupPhase[1]); continue; }
        if (updatePhase) {
            pushPhase(updatePhase[1].replace(/^[✓]\s*/, ''));
            if (/🔴/.test(updatePhase[1])) current.failed = true;
            continue;
        }
        if (!current) pushPhase('Vorbereitung');
        // 🔴 Sprachunabhängige Marker zuerst (🔴 aus update-check.js, ✗ aus setup.sh
        // c_err seit i18n Schritt 7) — die Wortliste deckt nur noch ALTE Logs ab, in
        // denen die Marker fehlen. Neue Fehlerpfade MÜSSEN einen Marker tragen, sonst
        // fiele die Erkennung auf einer englischen Installation still aus (i18n.md §3f).
        if (/🔴|✗|fehlgeschlagen|FEHLER|\bfailed\b|\bERROR\b/.test(line)) current.failed = true;
    }
    phases.forEach((p, i) => {
        const isLast = i === phases.length - 1;
        if (p.failed) { p.state = 'failed'; return; }
        if (!isLast) { p.state = 'done'; return; }
        // Letzte Phase: nur abgeschlossen wenn der Task selbst fertig ist.
        p.state = taskStatus === 'running' || taskStatus === 'pending' ? 'pending' : (taskStatus === 'failed' ? 'failed' : 'done');
    });
    return phases.map(({ label, state }) => ({ label, state }));
}

// Merkt sich den zuletzt geladenen Update-Status, damit setButtonsDisabled()
// den "Update einspielen"-Button nach einer Aktion nicht versehentlich wieder
// aktiviert, obwohl (weiterhin) kein Update vorliegt.
let _updateAvailable = false;

// ── Version + Status laden ────────────────────────────────────────────────────
async function loadStatus() {
    try {
        const statusRes = await fetch('/api/update/status', { cache: 'no-store' }).then(r => r.json());
        const version = (await currentVersion()) ?? '?';
        const versionText = statusRes.releasedAt
            ? `v${version} vom ${fmtDate(statusRes.releasedAt)}`
            : `v${version}`;

        const availableRow = $('upAvailableRow');
        const updateAvailable = !!(statusRes.available && statusRes.latestVersion);
        if (updateAvailable) {
            availableRow.style.display = '';
            $('upAvailableVersion').textContent = `v${statusRes.latestVersion}`;
        } else {
            availableRow.style.display = 'none';
        }
        // Ganze Zeile grün + ✓ am Ende = aktuell (kein geprüftes Update bereitliegend),
        // ganze Zeile rot + ✗ am Ende = ein neueres Update wurde bereits gefunden.
        // Basiert auf dem letzten "Jetzt prüfen"-Lauf (update-status.json) – ohne
        // kürzlichen Check kann das veraltet sein, dieselbe Einschränkung wie bei
        // "Verfügbar" oben.
        const statusClass = updateAvailable ? 'outdated' : 'current';
        const icon = updateAvailable ? '&#10007;' : '&#10003;';
        $('upCoreVersion').innerHTML = `<span class="up-version-status ${statusClass}">${versionText} ${icon}</span>`;

        // "Update einspielen" nur hervorheben UND nur anklickbar, wenn wirklich
        // ein geprüftes Update bereitliegt – sonst ausgegraut/deaktiviert.
        _updateAvailable = updateAvailable;
        $('upApplyBtn').classList.toggle('active', updateAvailable);
        $('upApplyBtn').disabled = !updateAvailable;
    } catch (err) {
        console.error('[updates] Status konnte nicht geladen werden:', err);
    }
}

let _cachedVersion = null;
async function currentVersion() {
    if (_cachedVersion) return _cachedVersion;
    try {
        // /forge/version.json existiert NUR auf per setup.sh installierten FORGE.pub-Forks
        // (siehe html/js/nav.js). Auf dem Master gibt's die Datei nicht (404) — dann auf
        // /api/version ausweichen, das der Settings-Server immer liefert (server.js).
        const v = await fetch('/forge/version.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
        _cachedVersion = v?.version ?? null;
        if (!_cachedVersion) {
            const av = await fetch('/api/version', { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
            _cachedVersion = av?.version ?? null;
        }
    } catch { /* bleibt null */ }
    return _cachedVersion;
}

// ── Rollback-Verfügbarkeit (nur bei status === 'rollback-failed') ────────────────
async function loadRollbackAvailability() {
    try {
        const result = await fetch('/api/update/result', { cache: 'no-store' }).then(r => r.json());
        const card = $('upRollbackCard');
        if (result.present && result.status === 'rollback-failed') {
            card.style.display = '';
            $('upRollbackInfo').textContent =
                `Version ${result.version ?? '?'} (${fmtTime(result.timestamp)}) – Update fehlgeschlagen, `
                + `automatische Rückkehr zur Vorversion ebenfalls fehlgeschlagen. `
                + (result.problems?.length ? `Betroffen: ${result.problems.join(', ')}` : '');
        } else {
            card.style.display = 'none';
        }
    } catch (err) {
        console.error('[updates] Rollback-Status konnte nicht geladen werden:', err);
    }
}

// ── Update-Modus (zwei Buttons statt Toggle) ──────────────────────────────────
function setModeButtons(autoApplyPatch) {
    $('upModeAuto').classList.toggle('active', autoApplyPatch);
    $('upModeManual').classList.toggle('active', !autoApplyPatch);
}

async function loadPolicy() {
    try {
        const policy = await fetch('/api/update/policy', { cache: 'no-store' }).then(r => r.json());
        setModeButtons(!!policy.autoApplyPatch);
    } catch (err) {
        console.error('[updates] Policy konnte nicht geladen werden:', err);
    }
}

async function setMode(autoApplyPatch) {
    const alreadyActive = $(autoApplyPatch ? 'upModeAuto' : 'upModeManual').classList.contains('active');
    if (alreadyActive) return;
    try {
        const res = await fetch('/api/update/policy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autoApplyPatch }),
        });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
        setModeButtons(autoApplyPatch);
        showToast(autoApplyPatch ? tr('upd.auto_enabled', 'Automatisch aktiviert') : tr('upd.manual_enabled', 'Manuell aktiviert'), 'success');
    } catch (err) {
        showToast(`Policy konnte nicht gespeichert werden: ${err.message}`, 'error');
    }
}

$('upModeAuto').addEventListener('click', () => setMode(true));
$('upModeManual').addEventListener('click', () => setMode(false));

// ── Task-Polling (apply/rollback: echter Live-Fortschritt) ────────────────────
const ACTION_LABEL = { check: tr('upd.check', 'Prüfung'), apply: 'Update', rollback: 'Rollback' };

// Toast-Texte je Aktion. Bewusst ganze Sätze in Alltagssprache: der Toast ist
// oft das Einzige, was jemand mitbekommt, der die Seite nebenbei offen hat.
const ACTION_TOAST = {
    check:    { start: tr('upd.check_started', 'Prüfung gestartet – suche nach einer neuen Version …'),
                done:  tr('upd.check_done', 'Prüfung abgeschlossen.') },
    apply:    { start: tr('upd.install_started', 'Update gestartet – die Bots werden dabei kurz neu gestartet.'),
                done:  tr('upd.install_done', 'Update fertig eingespielt – alle Dienste laufen wieder.') },
    rollback: { start: tr('upd.rollback_started', 'Rückkehr zur vorherigen Version gestartet – die Bots werden dabei kurz neu gestartet.'),
                done:  tr('upd.rollback_done', 'Vorherige Version wiederhergestellt – alle Dienste laufen wieder.') },
};

function setButtonsDisabled(disabled) {
    $('upCheckBtn').disabled = disabled;
    // Beim Wieder-Freigeben (disabled=false) bleibt "Update einspielen" trotzdem
    // gesperrt, solange laut letztem Status kein Update vorliegt.
    $('upApplyBtn').disabled = disabled || !_updateAvailable;
    $('upRollbackBtn').disabled = disabled;
}

async function pollLiveTask(taskId, action) {
    while (true) {
        await sleep(2000);
        let task;
        try {
            task = await fetch(`/api/update/tasks/${taskId}`, { cache: 'no-store' }).then(r => r.json());
        } catch {
            continue; // Netzwerkfehler beim Polling ignorieren, weiter versuchen
        }
        renderChecklist(parseSetupPhases(task.output, task.status));
        if (task.status === 'pending' || task.status === 'running') continue;

        setButtonsDisabled(false);
        if (task.status === 'done') {
            showToast(ACTION_TOAST[action]?.done ?? `${ACTION_LABEL[action]} abgeschlossen`, 'success');
        } else {
            showToast(`${ACTION_LABEL[action]} fehlgeschlagen: ${task.error ?? 'unbekannter Fehler'}`, 'error');
        }
        await loadStatus();
        await loadRollbackAvailability();
        // update-check.js hat gerade eine System-Nachricht erzeugt ("Update
        // eingespielt – Version X") – Zähler sofort nachziehen, statt bis zum
        // nächsten regulären Intervall zu warten.
        await refreshMessageBell();
        return;
    }
}

// check ist kurz (Sekunden) – auf den Endzustand warten und dann als
// gestaffelte Checkliste einblenden, statt Zwischenstände zu pollen.
async function pollUntilDone(taskId) {
    while (true) {
        await sleep(1500);
        const task = await fetch(`/api/update/tasks/${taskId}`, { cache: 'no-store' }).then(r => r.json());
        if (task.status === 'pending' || task.status === 'running') continue;
        return task;
    }
}

// Protokoll-Modal – öffnet sich automatisch bei Aktionsstart (triggerUpdateAction()/
// runCheck()), kein eigener "Protokoll anzeigen"-Button mehr (Feedback
// 2026-08-11). Rendert beim Öffnen sofort den zuletzt bekannten Stand nach
// (_lastSteps), damit ein Neuöffnen nach dem Schließen nicht mit einer leeren
// Liste startet.
function openLogModal() {
    if (getModal('up-log')) return;
    showModal({
        id: 'up-log',
        title: tr('upd.protocol', 'Protokoll'),
        body: '<div class="up-checklist" id="upChecklist"></div>',
        actions: [{ label: tr('common.close', 'Schließen'), onClick: () => closeModal('up-log') }],
    });
    renderChecklist(_lastSteps);
}

async function triggerUpdateAction(action, endpoint) {
    setButtonsDisabled(true);
    openLogModal();
    renderChecklist([{ label: `${ACTION_LABEL[action]} wird eingereiht …`, state: 'pending' }]);
    try {
        const res = await fetch(endpoint, { method: 'POST' });
        const body = await res.json();
        if (!res.ok) {
            setButtonsDisabled(false);
            renderChecklist([{ label: body.error || `${ACTION_LABEL[action]} konnte nicht gestartet werden`, state: 'failed' }]);
            showToast(body.error || `${ACTION_LABEL[action]} konnte nicht gestartet werden`, 'error');
            return;
        }
        // Erst melden, wenn die Aktion tatsächlich eingereiht ist – nicht schon
        // beim Klick, sonst behauptet der Toast einen Start, den ein 409
        // (läuft bereits) gerade abgelehnt hat.
        showToast(ACTION_TOAST[action]?.start ?? `${ACTION_LABEL[action]} gestartet`, 'info');
        pollLiveTask(body.taskId, action);
    } catch (err) {
        setButtonsDisabled(false);
        renderChecklist([{ label: err.message, state: 'failed' }]);
        showToast(`${ACTION_LABEL[action]} fehlgeschlagen: ${err.message}`, 'error');
    }
}

// "Jetzt prüfen" ist kein Live-Poll wie apply/rollback (kurze, abgeschlossene
// Aktion), sondern zeigt drei feste Zeilen: die beiden Prüfschritte, die eine
// erfolgreiche check.js-Ausführung IMMER in dieser Reihenfolge durchläuft
// (Release abrufen, Signatur prüfen — schlägt einer fehl, bricht der Task ab,
// beide sind also entweder gemeinsam ok oder der Task ist 'failed'), plus das
// eigentliche Ergebnis (verfügbar/nicht verfügbar). Bei einem Fehlschlag zeigt
// der rohe Log (parseLogLines) den tatsächlichen Grund, statt zu raten, welcher
// der beiden Schritte genau gescheitert ist.
async function runCheck() {
    $('upCheckBtn').disabled = true;
    openLogModal();
    renderChecklist([{ label: tr('upd.check_step_release', 'Prüfe auf neues Release.'), state: 'pending' }]);
    try {
        const res = await fetch('/api/update/check', { method: 'POST' });
        const body = await res.json();
        if (!res.ok) {
            renderChecklist([{ label: body.error || tr('upd.check_failed', 'Prüfung fehlgeschlagen'), state: 'failed' }]);
            showToast(body.error || tr('upd.check_failed', 'Prüfung fehlgeschlagen'), 'error');
            return;
        }
        showToast(ACTION_TOAST.check.start, 'info');
        const task = await pollUntilDone(body.taskId);
        if (task.status === 'done') {
            await loadStatus(); // aktualisiert _updateAvailable + #upAvailableVersion
            const line3 = _updateAvailable
                ? tr('upd.check_update_available', 'Es ist ein neues Update auf Version {version} verfügbar.', { version: $('upAvailableVersion').textContent })
                : tr('upd.check_no_update', 'Kein neues Update verfügbar.');
            renderChecklist([
                { label: tr('upd.check_step_release', 'Prüfe auf neues Release.'), state: 'done' },
                { label: tr('upd.check_step_signature', 'Prüfe Signatur.'), state: 'done' },
                { label: line3, state: 'info' },
            ]);
            showToast(ACTION_TOAST.check.done, 'success');
        } else {
            renderChecklist(parseLogLines(task.output).concat([{ label: task.error ?? tr('upd.check_failed', 'Prüfung fehlgeschlagen'), state: 'failed' }]));
            showToast(tr('upd.check_failed', 'Prüfung fehlgeschlagen'), 'error');
        }
    } catch (err) {
        renderChecklist([{ label: err.message, state: 'failed' }]);
        showToast(`${ACTION_LABEL.check} fehlgeschlagen: ${err.message}`, 'error');
    } finally {
        $('upCheckBtn').disabled = false;
    }
}

// Selbsttest: läuft synchron, unprivilegiert und in Sekunden — kein Task-Polling.
// Zeigt jeden aktivierten Dienst als eigene Zeile und danach die Datenqualität der
// Positions-Wertreihe. Letzteres ist der eigentliche Grund für den Knopf: Ob ein Dienst
// läuft, sieht man ohnehin; ob eine Zahl im Dashboard auf einem fehlerhaften Messwert
// beruht, konnte ein Nutzer bis dahin gar nicht feststellen.
async function runSelfTest() {
    $('upSelfTestBtn').disabled = true;
    openLogModal();
    renderChecklist([{ label: tr('upd.selftest_running', 'Selbsttest läuft …'), state: 'pending' }]);
    try {
        const res  = await fetch('/api/update/selftest', { method: 'POST' });
        const body = await res.json();
        if (body.error) {
            renderChecklist([{ label: body.error, state: 'failed' }]);
            showToast(body.error, 'error');
            return;
        }

        const steps = (body.checked ?? []).map(c => ({
            label: `${c.service}: ${c.enabled ? (c.active ? tr('upd.selftest_active', 'aktiv') : tr('upd.selftest_not_active', 'läuft NICHT')) : tr('upd.selftest_disabled', 'deaktiviert (übersprungen)')}`,
            state: !c.enabled ? 'info' : (c.active ? 'done' : 'failed'),
        }));

        if (body.snapshots?.available) {
            const bad = body.snapshots.badCount ?? 0;
            steps.push({
                label: bad === 0
                    ? tr('upd.selftest_data_clean', 'Messwerte der Positionen: unauffällig.')
                    : tr('upd.selftest_data_bad', 'Messwerte der Positionen: {count} fehlerhafte(r) Wert(e) in {pools}. Die PnL-Anzeige dieser Pools ist dadurch verfälscht — sie wird mit dem nächsten Update automatisch korrigiert.', { count: bad, pools: (body.snapshots.pools ?? []).join(', ') }),
                state: bad === 0 ? 'done' : 'failed',
            });
        }

        renderChecklist(steps);
        showToast(body.ok
            ? tr('upd.selftest_ok', 'Selbsttest ohne Befund.')
            : tr('upd.selftest_problems', '{count} Problem(e) gefunden.', { count: body.problems?.length ?? 0 }),
            body.ok ? 'success' : 'error');
    } catch (err) {
        renderChecklist([{ label: err.message, state: 'failed' }]);
        showToast(`${tr('upd.selftest', 'Selbsttest')}: ${err.message}`, 'error');
    } finally {
        $('upSelfTestBtn').disabled = false;
    }
}

// Eigenes Modal statt window.confirm() (keine nativen Browser-Dialoge – gleiches
// Muster wie bot-liquidity.js _confirmSavePoolTypeRiskManagement()).
function confirmAction({ id, title, body, confirmLabel, onConfirm }) {
    showModal({
        id, title, body,
        actions: [
            { label: confirmLabel, onClick: () => { closeModal(id); onConfirm(); } },
            { label: 'Abbrechen', onClick: () => closeModal(id) },
        ],
    });
}

$('upCheckBtn').addEventListener('click', runCheck);
$('upSelfTestBtn').addEventListener('click', runSelfTest);
$('upApplyBtn').addEventListener('click', () => {
    confirmAction({
        id: 'up-confirm-apply',
        title: tr('upd.install_confirm', 'Update jetzt einspielen?'),
        body: '<p style="margin:0;">' + tr('upd.bots_restart_note', 'Die Bots werden dafür kurz gestoppt und neu gestartet.') + '</p>',
        confirmLabel: 'Einspielen',
        onConfirm: () => triggerUpdateAction('apply', '/api/update/apply'),
    });
});
$('upRollbackBtn').addEventListener('click', () => {
    confirmAction({
        id: 'up-confirm-rollback',
        title: tr('upd.rollback_confirm', 'Auf die vorherige Version zurückrollen?'),
        body: '<p style="margin:0;">' + tr('upd.bots_restart_note', 'Die Bots werden dafür kurz gestoppt und neu gestartet.') + '</p>',
        confirmLabel: tr('upd.rollback', 'Zurückrollen'),
        onConfirm: () => triggerUpdateAction('rollback', '/api/update/rollback'),
    });
});

// ── Sprache + Zeitzone ─────────────────────────────────────────────────────────
// Gelten pro Installation, nicht pro Nutzer – auf dem FORGE Master gesperrt
// (masterLocked kommt vom Backend, lib/master-lock.js: die Master-Nostr-Identität
// existiert nur dort), auf einem FORGE-public-Fork editierbar. Gesperrt wird als
// reiner Text gerendert statt als deaktiviertes Feld, damit auf einen Blick klar
// ist, dass hier nichts einzustellen ist (kein "warum reagiert das nicht?").
async function loadLanguage() {
    try {
        const d = await fetch('/api/i18n', { cache: 'no-store' }).then(r => r.json());
        const text = $('upLangText');
        const select = $('upLangSelect');
        if (d.masterLocked) {
            text.textContent = d.lang === 'en' ? 'English' : 'Deutsch';
            text.title = tr('upd.master_locked_note', 'Auf dem FORGE Master gesperrt.');
            text.style.display = '';
            select.style.display = 'none';
        } else {
            select.value = d.lang;
            select.style.display = '';
            text.style.display = 'none';
        }
    } catch (err) {
        console.error('[updates] Sprache konnte nicht geladen werden:', err);
    }
}

// Reload nach dem Speichern nötig, siehe settings.js: der Katalog wird synchron
// im <head> geladen (html/i18n/active.js), ein Umschalten ohne Reload erwischt
// nur die Hälfte der Oberfläche.
$('upLangSelect').addEventListener('change', async () => {
    const lang = $('upLangSelect').value;
    try {
        const r = await fetch('/api/i18n', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lang }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        showToast(tr('upd.language_saved', 'Sprache gespeichert.'), 'success');
        setTimeout(() => location.reload(), 700); // Toast kurz sichtbar lassen, bevor der Reload ihn wegräumt
    } catch (err) {
        showToast(tr('set.language_failed', 'Sprache konnte nicht gesetzt werden: {error}', { error: err.message }), 'error');
    }
});

// Suchbare Zeitzonen-Auswahl über <datalist> (Freitext-Input mit Browser-Autocomplete,
// kein eigenes Widget nötig). Intl.supportedValuesOf('timeZone') ist Node genauso wie
// modernen Browsern bekannt (dieselbe API validiert bereits serverseitig in
// routes/timezone.js) – ohne Unterstützung bleibt der Input einfach ein Freitextfeld.
function populateTimezoneList() {
    const list = $('upTzList');
    if (!list) return;
    try {
        list.innerHTML = Intl.supportedValuesOf('timeZone').map(z => `<option value="${z}"></option>`).join('');
    } catch { /* Browser ohne Intl.supportedValuesOf – Input bleibt Freitext */ }
}

let _lastGoodTz = null;

async function loadTimezone() {
    try {
        const d = await fetch('/api/timezone', { cache: 'no-store' }).then(r => r.json());
        _lastGoodTz = d.tz;
        const text = $('upTzText');
        const input = $('upTzInput');
        if (d.masterLocked) {
            text.textContent = d.tz;
            text.title = tr('upd.master_locked_note', 'Auf dem FORGE Master gesperrt.');
            text.style.display = '';
            input.style.display = 'none';
        } else {
            input.value = d.tz;
            input.style.display = '';
            text.style.display = 'none';
        }
    } catch (err) {
        console.error('[updates] Zeitzone konnte nicht geladen werden:', err);
    }
}

// Kein Reload nötig (anders als bei der Sprache) – FORGE_TZ wirkt nur auf
// Bot-Prozesse/Datumsgrenzen, nicht auf diese Oberfläche selbst.
$('upTzInput').addEventListener('change', async () => {
    const tz = $('upTzInput').value.trim();
    if (!tz || tz === _lastGoodTz) return;
    try {
        const r = await fetch('/api/timezone', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tz }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error ?? tr('upd.timezone_invalid', 'Ungültige Zeitzone. Bitte einen IANA-Namen eingeben, z.B. "Europe/Berlin".'));
        _lastGoodTz = tz;
        showToast(tr('upd.timezone_saved', 'Zeitzone gespeichert – Dienste werden neu gestartet.'), 'success');
    } catch (err) {
        $('upTzInput').value = _lastGoodTz ?? '';
        showToast(err.message, 'error');
    }
});

// ── Passwortschutz (Port 3200) ────────────────────────────────────────────────
// Reine Zufallszugriff-Bremse fürs LAN (siehe siteAuthGate() in
// bots/settings/lib/site-auth.js) – "aktiviert" heißt: Passwort ist gesetzt.
// Ein neues Passwort ändert (statt setzt) einfach denselben Zustand; das
// aktuelle Passwort wird nur abgefragt, wenn bereits eines aktiv ist.
let _authEnabled = false;

async function loadAuthStatus() {
    try {
        const d = await fetch('/api/auth/status', { cache: 'no-store' }).then(r => r.json());
        _authEnabled = !!d.enabled;
        const badge = $('authStatusBadge');
        badge.textContent = _authEnabled ? tr('auth.status_enabled', 'Aktiv') : tr('auth.status_disabled', 'Nicht aktiv');
        badge.className = `status-badge ${_authEnabled ? 'active' : 'inactive'}`;
        $('authCurrentRow').style.display = _authEnabled ? '' : 'none';
        $('authSaveBtn').textContent = _authEnabled ? tr('auth.change_password', 'Passwort ändern') : tr('auth.set_password', 'Passwort setzen');
        $('authRemoveBtn').style.display = _authEnabled ? '' : 'none';
    } catch (err) {
        console.error('[updates] Auth-Status konnte nicht geladen werden:', err);
    }
}

$('authSaveBtn').addEventListener('click', async () => {
    const feedback = $('authFeedback');
    const currentPassword = $('authCurrentPw').value;
    const newPassword     = $('authNewPw').value;
    const repeat           = $('authNewPwRepeat').value;

    if (newPassword.length < 8) {
        feedback.textContent = tr('auth.password_too_short', 'Das Passwort muss mindestens 8 Zeichen lang sein.');
        feedback.className = 'task-status failed';
        return;
    }
    if (newPassword !== repeat) {
        feedback.textContent = tr('auth.password_mismatch', 'Die Passwörter stimmen nicht überein.');
        feedback.className = 'task-status failed';
        return;
    }

    $('authSaveBtn').disabled = true;
    try {
        const res = await fetch('/api/auth/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

        $('authCurrentPw').value = '';
        $('authNewPw').value = '';
        $('authNewPwRepeat').value = '';
        feedback.textContent = '';
        showToast(_authEnabled ? tr('auth.password_changed', 'Passwort geändert.') : tr('auth.password_set', 'Passwort gesetzt – ab jetzt ist ein Login nötig.'), 'success');
        await loadAuthStatus();
    } catch (err) {
        feedback.textContent = tr('auth.save_failed', 'Speichern fehlgeschlagen: {error}', { error: err.message });
        feedback.className = 'task-status failed';
    } finally {
        $('authSaveBtn').disabled = false;
    }
});

$('authRemoveBtn').addEventListener('click', () => {
    confirmAction({
        id: 'auth-confirm-remove',
        title: tr('auth.remove_confirm_title', 'Passwortschutz wirklich entfernen?'),
        body: '<p style="margin:0;">' + tr('auth.remove_confirm_body', 'Diese Seite ist danach ohne Passwort für jeden im LAN erreichbar.') + '</p>',
        confirmLabel: tr('auth.remove_password', 'Passwortschutz entfernen'),
        onConfirm: async () => {
            try {
                const res = await fetch('/api/auth/password', { method: 'DELETE' });
                const body = await res.json();
                if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
                showToast(tr('auth.password_removed', 'Passwortschutz entfernt.'), 'success');
                await loadAuthStatus();
            } catch (err) {
                showToast(tr('auth.save_failed', 'Speichern fehlgeschlagen: {error}', { error: err.message }), 'error');
            }
        },
    });
});

setLastUpdate();
loadStatus();
loadPolicy();
loadRollbackAvailability();
loadLanguage();
loadTimezone();
populateTimezoneList();
loadAuthStatus();
