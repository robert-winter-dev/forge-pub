/**
 * FORGE – System > Updates
 *
 * Bedient bots/settings/routes/update.js. check/apply/rollback laufen über
 * eine Task-Queue (bot-control-daemon.js). Bei apply/rollback schreibt der
 * Daemon die Ausgabe von setup.sh laufend in die DB (siehe dort
 * runUpdateTask()) – das Protokoll pollt daher während des Laufs und rendert
 * bei jedem Poll neu aus dem bis dahin gesammelten Output. check/selftest
 * sind kurze, abgeschlossene Ergebnisse und werden nur gestaffelt eingeblendet.
 */

import { initNav, initFooter }        from '/forge/js/nav.js?v=20260808h';
import { showToast }                  from '/forge/js/toast.js?v=20260722b';
import { showModal, closeModal }      from '/forge/js/modal.js?v=20260731a';
import { initMessageBell }            from '/forge/js/message-bell.js?v=20260809a';

initNav({ current: 'updates' });
initFooter({ botName: 'Updates' });
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
    return `${d.toLocaleDateString('de-DE')} ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`;
}

function fmtDate(ts) {
    if (!ts) return 'unbekannt';
    return new Date(ts).toLocaleDateString('de-DE');
}

function setLastUpdate() {
    const el = $('lastUpdate');
    if (el) el.textContent = `Zuletzt geladen: ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`;
}

// ── Checkliste (Protokoll) ────────────────────────────────────────────────────
// steps: [{ label, state: 'pending'|'done'|'failed'|'neutral' }]
const ICON = { pending: '◌', done: '✓', failed: '✗', neutral: '·' };

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
    $('upChecklist').innerHTML = '';
}

function renderChecklist(steps) {
    const container = $('upChecklist');

    if (!steps.length) {
        _renderedSteps = [];
        container.innerHTML = '<span class="up-checklist-empty">Noch keine Aktion ausgeführt.</span>';
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

async function renderChecklistStaggered(steps, delayMs = 250) {
    const revealed = [];
    for (const step of steps) {
        revealed.push(step);
        renderChecklist(revealed);
        await sleep(delayMs);
    }
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
        if (/🔴|fehlgeschlagen|FEHLER/i.test(line)) current.failed = true;
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

        // "Update einspielen" nur hervorheben, wenn wirklich ein geprüftes Update bereitliegt.
        $('upApplyBtn').classList.toggle('active', updateAvailable);
    } catch (err) {
        console.error('[updates] Status konnte nicht geladen werden:', err);
    }
}

let _cachedVersion = null;
async function currentVersion() {
    if (_cachedVersion) return _cachedVersion;
    try {
        const v = await fetch('/forge/version.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
        _cachedVersion = v?.version ?? null;
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
        showToast(autoApplyPatch ? 'Automatisch aktiviert' : 'Manuell aktiviert', 'success');
    } catch (err) {
        showToast(`Policy konnte nicht gespeichert werden: ${err.message}`, 'error');
    }
}

$('upModeAuto').addEventListener('click', () => setMode(true));
$('upModeManual').addEventListener('click', () => setMode(false));

// ── Task-Polling (apply/rollback: echter Live-Fortschritt) ────────────────────
const ACTION_LABEL = { check: 'Prüfung', apply: 'Update', rollback: 'Rollback' };

// Toast-Texte je Aktion. Bewusst ganze Sätze in Alltagssprache: der Toast ist
// oft das Einzige, was jemand mitbekommt, der die Seite nebenbei offen hat.
const ACTION_TOAST = {
    check:    { start: 'Prüfung gestartet – suche nach einer neuen Version …',
                done:  'Prüfung abgeschlossen.' },
    apply:    { start: 'Update gestartet – die Bots werden dabei kurz neu gestartet.',
                done:  'Update fertig eingespielt – alle Dienste laufen wieder.' },
    rollback: { start: 'Rückkehr zur vorherigen Version gestartet – die Bots werden dabei kurz neu gestartet.',
                done:  'Vorherige Version wiederhergestellt – alle Dienste laufen wieder.' },
};

function setButtonsDisabled(disabled) {
    $('upCheckBtn').disabled = disabled;
    $('upApplyBtn').disabled = disabled;
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

async function triggerUpdateAction(action, endpoint) {
    setButtonsDisabled(true);
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

        if (action === 'check') {
            const task = await pollUntilDone(body.taskId);
            setButtonsDisabled(false);
            if (task.status === 'done') {
                await renderChecklistStaggered(parseLogLines(task.output));
                showToast(ACTION_TOAST.check.done, 'success');
            } else {
                renderChecklist(parseLogLines(task.output).concat([{ label: task.error ?? 'unbekannter Fehler', state: 'failed' }]));
                showToast('Prüfung fehlgeschlagen', 'error');
            }
            await loadStatus();
        } else {
            pollLiveTask(body.taskId, action);
        }
    } catch (err) {
        setButtonsDisabled(false);
        renderChecklist([{ label: err.message, state: 'failed' }]);
        showToast(`${ACTION_LABEL[action]} fehlgeschlagen: ${err.message}`, 'error');
    }
}

// Eigenes Modal statt window.confirm() (keine nativen Browser-Dialoge – gleiches
// Muster wie bot-liquidity.js _confirmSavePoolType()).
function confirmAction({ id, title, body, confirmLabel, onConfirm }) {
    showModal({
        id, title, body,
        actions: [
            { label: confirmLabel, onClick: () => { closeModal(id); onConfirm(); } },
            { label: 'Abbrechen', onClick: () => closeModal(id) },
        ],
    });
}

$('upCheckBtn').addEventListener('click', () => triggerUpdateAction('check', '/api/update/check'));
$('upApplyBtn').addEventListener('click', () => {
    confirmAction({
        id: 'up-confirm-apply',
        title: 'Update jetzt einspielen?',
        body: '<p style="margin:0;">Die Bots werden dafür kurz gestoppt und neu gestartet.</p>',
        confirmLabel: 'Einspielen',
        onConfirm: () => triggerUpdateAction('apply', '/api/update/apply'),
    });
});
$('upRollbackBtn').addEventListener('click', () => {
    confirmAction({
        id: 'up-confirm-rollback',
        title: 'Auf die vorherige Version zurückrollen?',
        body: '<p style="margin:0;">Die Bots werden dafür kurz gestoppt und neu gestartet.</p>',
        confirmLabel: 'Zurückrollen',
        onConfirm: () => triggerUpdateAction('rollback', '/api/update/rollback'),
    });
});

// ── Selbsttest (synchron, keine Queue) – echte Prüfpunkte, gestaffelt gezeigt ──
$('upSelftestBtn').addEventListener('click', async () => {
    $('upSelftestBtn').disabled = true;
    renderChecklist([{ label: 'Selbsttest läuft …', state: 'pending' }]);
    try {
        const result = await fetch('/api/update/selftest', { method: 'POST' }).then(r => r.json());
        const steps = (result.checked ?? []).map(c => ({
            label: `Prüfe ${c.service} …`,
            state: !c.enabled ? 'neutral' : (c.active ? 'done' : 'failed'),
        }));
        await renderChecklistStaggered(steps);
        showToast(result.ok ? 'Selbsttest ok' : 'Selbsttest hat ein Problem gefunden', result.ok ? 'success' : 'warn');
    } catch (err) {
        renderChecklist([{ label: `Selbsttest fehlgeschlagen: ${err.message}`, state: 'failed' }]);
        showToast('Selbsttest fehlgeschlagen', 'error');
    } finally {
        $('upSelftestBtn').disabled = false;
    }
});

setLastUpdate();
loadStatus();
loadPolicy();
loadRollbackAvailability();
