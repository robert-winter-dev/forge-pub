/**
 * FORGE – Reiter „Auffällig“ im Wallet-Modal
 *
 * Zeigt Token, die im Wallet liegen, aber zu keinem bekannten Pool, Protokoll oder
 * überwachten Bestand gehören — und bietet an, sie zu verbrennen.
 *
 * Wird von `bots/settings/html/js/bot-liquidity.js` (Liquidity- und Premium-Wallet)
 * und `bot-lending.js` genutzt. Bewusst EIN Modul statt einer Kopie je Bot: die
 * Belehrungstexte und Sicherheitsstufen sind der heikelste Teil dieser Funktion,
 * und genau solche Kopien sind in FORGE schon einmal auseinandergelaufen
 * (`LIQ#0299`, Symbolvergleich in zwei close-scam-Skripten).
 *
 * 🔒 Wortwahl: Hier steht nirgends „Scam“ als Feststellung. Was wir sehen, ist ein
 * Verdacht mit Belegen — die Entscheidung trifft der Nutzer. Ein Fehlurteil in einer
 * Produktoberfläche wiegt schwerer als ein zu vorsichtiger Text.
 *
 * 🔒 Stufen (kommen aus lib/scam-classify.js, die Route liefert sie mit):
 *   BURN   – Symbol imitiert ein bekanntes Token, kein nennenswerter Wert.
 *            Mülleimer mit einfacher Rückfrage.
 *   REVIEW – Symbol imitiert ein bekanntes Token UND der Bestand ist etwas wert.
 *            Mülleimer, aber das Symbol muss abgetippt werden.
 *   WARN   – Kein Marktpreis, keine Symbol-Kollision. Wir wissen es schlicht nicht.
 *            KEIN Mülleimer: Receipt-/LP-Token und Positions-NFTs sehen genau so
 *            aus, und genau diese Klasse hat am 12.08.2026 rund 70 USDC vernichtet.
 *
 * 🔒 Layout: Karten, keine Tabelle. Vier Spalten passen nicht in ein Modal, das
 * Ergebnis war ein waagerechter Scrollbalken (Sichtprüfung 19.08.). Ein Kartenblock
 * fließt und bleibt auf jeder Breite lesbar — und hat Platz für die Belege, auf die
 * es hier eigentlich ankommt.
 *
 * 🔒 Drei Zeilen, in dieser Reihenfolge (Vorgabe 19.08.):
 *   1. Was liegt da, was ist es wert, und wie stufen wir es ein
 *   2. Wann wurde der Mint erzeugt
 *   3. Seit wann liegt es im Wallet — mit Link auf die Transaktion, die es brachte
 *
 * 🔒 „Vermutet: Scam" steht NUR bei den Imitat-Stufen. Bei WARN haben wir keine
 * Evidenz, sondern nur fehlende Information — dort steht „Unklar". Ein Quittungs-
 * oder LP-Token als Scam-Verdacht zu etikettieren wäre genau der Fehler, der am
 * 12.08.2026 rund 70 USDC gekostet hat.
 */

import { showModal, closeModal, getModal } from '/forge/js/modal.js?v=20260731a';
import { t as tr } from '/forge/js/i18n.js?v=20260811a';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Zero-Width, Bidi-Marks, Bidi-Embedding/Overrides, Bidi-Isolates, BOM.
// Gleiche Menge wie INVISIBLE_RE in lib/token-symbol.js.
const INVISIBLE_RE = /[​-‏‪-‮⁦-⁩﻿]/g;

/**
 * Entfernt unsichtbare Steuerzeichen aus einem Symbol.
 *
 * Der ganze Trick dieser Token ist, dass „‮PMUP“ im Browser als „PUMP“ gerendert
 * wird — U+202E kehrt die Leserichtung um. Gäben wir das Symbol unverändert aus,
 * würde die Oberfläche die Täuschung mitmachen und der Nutzer läse genau das, was
 * der Angreifer will.
 *
 * Entfernen statt ersetzen: ohne das Steuerzeichen stehen die gespeicherten
 * Buchstaben in ihrer echten Reihenfolge da („PMUP“). Ein Platzhalter-Zeichen wäre
 * ein Kästchen im Namen, das niemand einordnen kann — dass ein Steuerzeichen drin
 * steckt, ist ein BELEG und gehört als eigener Hinweis daneben, nicht in den Namen.
 */
function cleanSymbol(sym) {
    if (!sym) return null;
    const out = String(sym).replace(INVISIBLE_RE, '').trim();
    return out.length ? out : null;
}

function fmtAmount(v) {
    if (v == null) return tr('common.no_data', 'no data');
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** Absolutes Datum mit Uhrzeit — „19.08.2026, 02:28". */
function fmtDateTime(ms) {
    if (!ms) return null;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

// ── Ignorierte Token ─────────────────────────────────────────────────────────
//
// Rein visuell: die Karte klappt auf eine Zeile zusammen, der Eintrag bleibt in der
// Liste. Persistiert im localStorage je Mint — nur im Arbeitsspeicher wäre es
// wertlos, beim nächsten Öffnen des Modals stünde wieder alles aufgeklappt da.
//
// 🔒 Der Zähler am Wallet-Icon zählt ignorierte Token WEITER mit. Sonst könnte man
// sich ein echtes Problem dauerhaft selbst ausblenden — Ignorieren ist eine
// Ansichtssache, keine Entwarnung.
const IGNORE_KEY = 'forge.scam.ignored';

function loadIgnored() {
    try {
        const raw = localStorage.getItem(IGNORE_KEY);
        return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
}

function toggleIgnored(mint) {
    const set = loadIgnored();
    if (set.has(mint)) set.delete(mint); else set.add(mint);
    try { localStorage.setItem(IGNORE_KEY, JSON.stringify([...set])); } catch { /* Speicher voll/gesperrt */ }
    return set.has(mint);
}

/** Lädt die Liste. Die Route rechnet nur aus der DB — kein externer Abruf. */
export async function fetchScamTokens(flavor) {
    try {
        const res = await fetch(`/api/wallet/${flavor}/scam`);
        if (!res.ok) return { available: false, tokens: [] };
        return await res.json();
    } catch {
        return { available: false, tokens: [] };
    }
}

/**
 * Info-Icon für die Wallet-Zeile in der Übersicht.
 * Leerer String, wenn nichts vorliegt — das Icon soll nur auftauchen, wenn es auch
 * etwas zu sagen hat.
 */
export function scamInfoIconHtml(tokens) {
    const n = (tokens ?? []).length;
    if (n === 0) return '';
    return ` <span class="info-tip-label"
        data-tooltip-title="${tr('scam.icon_title', 'Auffällige Token')}"
        data-tooltip-content="${tr('scam.icon_tip', 'Im Wallet liegen {n} Token, die zu keinem bekannten Pool oder Protokoll gehören. Öffne „Verwalten“ und sieh im Reiter „Auffällig“ nach.', { n })}"
        >&#9432;</span>`;
}

/** Inhalt des Reiters. */
export function buildScamTabHtml(data) {
    const tokens  = data?.tokens ?? [];
    const ignored = loadIgnored();

    if (tokens.length === 0) {
        return `<p class="wat-muted">${tr('scam.empty', 'Im Wallet liegt nichts Auffälliges. Alle Token gehören zu einem bekannten Pool, Protokoll oder überwachten Bestand.')}</p>`;
    }

    return `
        <p class="wat-muted scam-intro">
            ${tr('scam.intro', 'Diese Token liegen in deinem Wallet, gehören aber zu keinem bekannten Pool oder Protokoll. Meist sind es unaufgefordert zugeschickte Airdrops. Prüfe jeden Eintrag selbst — Löschen kann nicht rückgängig gemacht werden.')}
        </p>
        <div class="scam-list">${tokens.map(tk => scamCardHtml(tk, ignored.has(tk.mint))).join('')}</div>`;
}

/**
 * Baut den Begründungstext als Aufzählung.
 *
 * `tooltip.js` wandelt `|` in einen Zeilenumbruch — mehr HTML geht nicht, der Text
 * steht in einem Attribut und wird escaped. Aufzählungszeichen deshalb als Text.
 * Bei nur einem Punkt kein Aufzählungszeichen: eine einelementige Liste sieht
 * nach einem Formatfehler aus.
 *
 * Reihenfolge bewusst: die Handelbarkeit zuerst. Sie beantwortet die Frage, die
 * ein Nutzer als erstes hat — kann ich damit überhaupt etwas verlieren?
 */
// Unterhalb dieser Grenze ist ein Bestand faktisch unverkäuflich — jeder Verkauf
// würde den Kurs sofort auffressen. Bewusst grob: die Zahl trennt „Airdrop-Staub"
// von „echter Markt", sie ist keine Handelsentscheidung.
const THIN_LIQUIDITY_USDC = 25_000;

// Ab wann ein Mint nicht mehr „neu" ist. Airdrop-Wellen laufen über Tage, nicht über
// Monate; alles darüber ist als Indiz wertlos.
const RECENT_MINT_DAYS = 30;

/**
 * Baut den Begründungstext als kurze Aufzählung.
 *
 * 🔒 Jeder Punkt ist ein FAKT, der für sich steht — keine Erklärung, warum ein Fakt
 * verdächtig ist. Ein Nutzer, der „Ähnelt bekanntem Namen: PUMP" liest, zieht den
 * Schluss selbst; ein Absatz darüber, dass Namensimitation eine Täuschungsabsicht
 * verrät, hilft ihm nicht und kostet Aufmerksamkeit (Vorgabe 19.08.).
 *
 * 🔒 Ein Punkt erscheint NUR, wenn er zuverlässig ermittelbar ist. Fehlt die
 * Datengrundlage, bleibt er weg — lieber ein kurzer Tooltip als eine Behauptung, die
 * wir nicht belegen können. Genau daran sind die beiden Vorgängertexte gescheitert:
 * „ein Token, den du wirklich nutzt" stimmte für 25 von 26 Whitelist-Symbolen nicht,
 * und „ein Zeichen, das die Anzeige umdreht" war bei einem Zero-Width-Space falsch.
 *
 * `tooltip.js` wandelt `|` in einen Zeilenumbruch — mehr HTML geht nicht, der Text
 * steht in einem Attribut. Aufzählungszeichen deshalb als Text, und bei nur einem
 * Punkt gar keins: eine einelementige Liste sieht nach einem Formatfehler aus.
 */
function buildVerdictTip(tk) {
    const points = [];

    // Handelbarkeit: nur behaupten, wenn eine Liquiditätsangabe vorliegt UND sie
    // tatsächlich dünn ist. Ohne Angabe wissen wir es nicht.
    if (tk.liquidity != null && tk.liquidity < THIN_LIQUIDITY_USDC) {
        points.push(tr('scam.tip_no_volume', 'Kann mangels Volumen nicht gehandelt werden'));
    }

    // Alter des Mints: nur wenn bekannt und tatsächlich frisch.
    const createdMs = tk.createdAt ? Date.parse(tk.createdAt) : NaN;
    if (!Number.isNaN(createdMs) && (Date.now() - createdMs) < RECENT_MINT_DAYS * 86_400_000) {
        points.push(tr('scam.tip_recent', 'Wurde erst vor kurzem erzeugt'));
    }

    // Namensähnlichkeit: `dupSymbol` ist die Grundlage der Einstufung selbst, also
    // genau dann verlässlich, wenn es gesetzt ist. Sonst kein Wort darüber.
    if (tk.dupSymbol) {
        points.push(tr('scam.tip_similar', 'Ähnelt bekanntem Namen: {sym}', { sym: tk.dupSymbol }));
    }

    // Auffangfall: alter Mint, ausreichend Liquidität, keine Namensähnlichkeit — dann
    // bleibt als Aussage nur der Grund, aus dem der Token überhaupt in dieser Liste
    // steht. Ohne diesen Zweig wäre der Tooltip leer.
    if (points.length === 0) {
        points.push(tr('scam.tip_unlisted', 'Gehört zu keinem bekannten Pool oder Protokoll'));
    }

    return points.length === 1 ? points[0] : points.map(p => `• ${p}`).join('|');
}

/** Eine Karte. `collapsed` = vom Nutzer ignoriert, auf eine Zeile zusammengeklappt. */
function scamCardHtml(tk, collapsed) {
    const shown = cleanSymbol(tk.symbol) ?? tr('scam.no_symbol', 'ohne Symbol');
    const url   = `https://solscan.io/token/${encodeURIComponent(tk.mint)}`;

    // Einstufung. „Vermutet: Scam" NUR bei Symbol-Kollision — bei WARN haben wir
    // keine Evidenz, sondern nur fehlende Information.
    const isImitation = !!tk.dupSymbol;
    const verdict = isImitation
        ? tr('scam.verdict_scam', 'Vermutet: Scam')
        : tr('scam.verdict_unclear', 'Unklar');

    const verdictTip = buildVerdictTip(tk);

    // Ein vorhandener Gegenwert bleibt sichtbar — er sagt, wie viel auf dem Spiel
    // steht. Das Gegenteil („nicht handelbar") steht dagegen im Tooltip: als Zeile 1
    // war es doppelt gemoppelt neben „Vermutet: Scam" und widersprach obendrein der
    // früheren Liquiditätszeile.
    const worthHtml = tk.value != null
        ? `<span class="scam-worth">&middot; ${esc(tr('scam.worth', 'entspricht {value} USDC', {
               value: Number(tk.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
           }))}</span>`
        : '';

    const ignoreTitle = collapsed
        ? tr('scam.unignore', 'Wieder ausklappen')
        : tr('scam.ignore', 'Ignorieren – Eintrag zusammenklappen');

    const actions = `
        <button class="btn btn-secondary btn-icon" data-scam-ignore="${esc(tk.mint)}"
                title="${esc(ignoreTitle)}" aria-label="${esc(ignoreTitle)}"
                aria-pressed="${collapsed ? 'true' : 'false'}">${collapsed ? '&#128065;' : '&#128584;'}</button>
        <button class="btn btn-secondary btn-icon" data-scam-move="${esc(tk.mint)}"
                title="${tr('scam.move', 'Verschieben – an eine andere Wallet-Adresse senden')}"
                aria-label="${tr('scam.move', 'Verschieben – an eine andere Wallet-Adresse senden')}">&#128228;</button>
        ${tk.burnable
            ? `<button class="btn btn-secondary btn-icon" data-scam-burn="${esc(tk.mint)}"
                       title="${tr('scam.delete', 'Token löschen')}"
                       aria-label="${tr('scam.delete', 'Token löschen')}">&#128465;</button>`
            : `<span class="info-tip-label"
                     data-tooltip-title="${tr('scam.no_action', 'Kein Löschen möglich')}"
                     data-tooltip-content="${tr('scam.no_action_tip', 'Für diesen Token fehlt uns die Grundlage für eine Empfehlung. Sieh ihn dir im Explorer an und entscheide selbst.')}"
                     >&#9432;</span>`}`;

    // Zeile 1 trägt allein schon die Entscheidung — deshalb bleibt genau sie stehen,
    // wenn der Nutzer die Karte zusammenklappt.
    const line1 = `
        <div class="scam-line1">
            <span class="scam-amount">${esc(fmtAmount(tk.balance))}</span>
            <a class="scam-symbol" href="${esc(url)}" target="_blank" rel="noopener"
               title="${tr('scam.explorer', 'Im Explorer ansehen')}">${esc(shown)} &#8599;</a>
            ${worthHtml}
            <span class="scam-verdict info-tip-label"
                  data-tooltip-title="${tr('scam.verdict_title', 'Scamverdacht')}"
                  data-tooltip-content="${esc(verdictTip)}">${esc(verdict)} &#9432;</span>
            <span class="scam-actions">${actions}</span>
        </div>`;

    if (collapsed) {
        return `<div class="scam-card scam-card-collapsed">${line1}</div>`;
    }

    const created = fmtDateTime(tk.createdAt ? Date.parse(tk.createdAt) : null);
    const line2 = created
        ? `<div class="scam-detail">${tr('scam.created_line', 'Dieser „{sym}“-Token wurde erzeugt: {date}', { sym: esc(shown), date: esc(created) })}</div>`
        : '';

    // Empfangszeitpunkt aus der Kette schlägt first_seen: Letzteres sagt nur, wann WIR
    // ihn zuerst gesehen haben, nicht wann er ankam.
    const receivedMs   = tk.receivedAt ?? tk.first_seen ?? null;
    const receivedText = fmtDateTime(receivedMs);
    // Nur der Pfeil: dass ein Link zur Erklärung führt, versteht sich. Titel und
    // aria-label tragen den Text weiter — für Screenreader ist ein nackter Pfeil
    // sonst bedeutungslos.
    const txLink = tk.receivedSig
        ? ` <a href="https://solscan.io/tx/${esc(tk.receivedSig)}" target="_blank" rel="noopener"
               class="scam-tx" title="${tr('scam.show_tx', 'Transaktion ansehen, mit der der Token ankam')}"
               aria-label="${tr('scam.show_tx', 'Transaktion ansehen, mit der der Token ankam')}">&#8599;</a>`
        : '';
    const line3 = receivedText
        ? `<div class="scam-detail">${tr('scam.since_line', 'Im Wallet seit: {date}', { date: esc(receivedText) })}${txLink}</div>`
        : '';

    return `<div class="scam-card">${line1}${line2}${line3}</div>`;
}

/**
 * Verdrahtet die Mülleimer im Reiter.
 *
 * @param {HTMLElement} modalEl   Das Wallet-Modal
 * @param {string}      flavor    liquidity | lending | premium
 * @param {object}      data      Rückgabe von fetchScamTokens()
 * @param {Function}    onChanged Callback nach erfolgreichem Löschen (Neu-Rendern)
 * @param {Function}   [onMove]   Callback für „Verschieben" — bekommt den Token und
 *                                öffnet im aufrufenden Modal den Senden-Reiter. Die
 *                                DOM-Details dieses Reiters liegen bewusst dort:
 *                                bot-liquidity.js und bot-lending.js haben je eigene
 *                                Fassungen davon.
 */
export function wireScamTab(modalEl, flavor, data, onChanged, onMove) {
    const byMint = new Map((data?.tokens ?? []).map(tk => [tk.mint, tk]));

    const wire = () => {
        modalEl.querySelectorAll('[data-scam-burn]').forEach(btn => {
            btn.addEventListener('click', () => {
                const tk = byMint.get(btn.dataset.scamBurn);
                if (tk) confirmAndBurn(flavor, tk, onChanged);
            });
        });

        modalEl.querySelectorAll('[data-scam-move]').forEach(btn => {
            btn.addEventListener('click', () => {
                const tk = byMint.get(btn.dataset.scamMove);
                if (tk) onMove?.(tk);
            });
        });

        modalEl.querySelectorAll('[data-scam-ignore]').forEach(btn => {
            btn.addEventListener('click', () => {
                const mint = btn.dataset.scamIgnore;
                const tk   = byMint.get(mint);
                if (!tk) return;
                const nowCollapsed = toggleIgnored(mint);
                // Nur die eine Karte neu bauen statt der ganzen Liste: die Scroll-
                // position bleibt erhalten, und die übrigen Karten flackern nicht.
                const card = btn.closest('.scam-card');
                if (!card) return;
                card.outerHTML = scamCardHtml(tk, nowCollapsed);
                wire();
            });
        });
    };
    wire();
}

/** Belehrung + Ausführung. Niemals confirm() — immer das FORGE-Modal. */
function confirmAndBurn(flavor, tk, onChanged) {
    const mid    = 'scam-burn-confirm';
    const shown  = cleanSymbol(tk.symbol) ?? tr('scam.no_symbol', 'ohne Symbol');
    const typing = tk.needsTyping;

    const warning = typing
        ? tr('scam.confirm_review',
             'Dieser Token gibt sich als „{sym}“ aus, stammt aber von einem fremden Mint — und der Bestand ist derzeit rund {value} wert. Falls du ihn doch selbst erworben hast, wäre dieses Geld unwiderruflich weg. Tippe zum Bestätigen das angezeigte Symbol ab.',
             { sym: tk.dupSymbol, value: tk.value != null
                 ? `${Number(tk.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`
                 : '?' })
        : tr('scam.confirm_burn',
             'Der Token wird verbrannt und sein Konto geschlossen. Das lässt sich nicht rückgängig machen — auch nicht von uns. Bitte entscheide selbst, ob du ihn wirklich nicht brauchst.',
             {});

    const typingHtml = typing
        ? `<div class="settings-row" style="border:none; margin-top:0.75rem;">
               <span class="settings-label">${tr('scam.type_symbol', 'Symbol abtippen')}</span>
               <input type="text" id="scam-confirm-input" class="settings-input"
                      autocomplete="off" spellcheck="false" placeholder="${esc(shown)}">
           </div>`
        : '';

    showModal({
        id:    mid,
        title: tr('scam.confirm_title', 'Token wirklich löschen?'),
        body: `
            <p><strong>${esc(shown)}</strong> — ${esc(fmtAmount(tk.balance))}</p>
            <p>${esc(warning)}</p>
            ${typingHtml}
            <p class="wat-muted" style="margin-top:0.75rem;">
                ${tr('scam.confirm_rent', 'Beim Schließen des Kontos bekommst du die hinterlegte Konto-Miete in SOL zurück. Den genauen Betrag nennen wir dir danach.')}
            </p>
            <p id="scam-burn-status" class="wat-muted" style="margin-top:0.5rem;"></p>`,
        actions: [
            {
                label: tr('scam.confirm_delete', 'Löschen'),
                onClick: async () => {
                    const modalEl = getModal(mid);
                    const status  = modalEl?.querySelector('#scam-burn-status');
                    const payload = { mint: tk.mint };

                    if (typing) {
                        const typed = modalEl?.querySelector('#scam-confirm-input')?.value ?? '';
                        // Gegen das BEREINIGTE Symbol prüfen — niemand soll ein
                        // unsichtbares Steuerzeichen abtippen müssen. Der Server prüft
                        // zusätzlich gegen den Originalwert, ein Client ist keine
                        // Sicherheitsgrenze.
                        if (typed.trim().toLowerCase() !== String(shown).trim().toLowerCase()) {
                            if (status) status.textContent = tr('scam.type_mismatch', 'Das Symbol stimmt noch nicht überein.');
                            return;
                        }
                        payload.confirmSymbol = tk.symbol;
                    }

                    if (status) status.textContent = tr('scam.deleting', 'Wird gelöscht…');
                    try {
                        const res  = await fetch(`/api/wallet/${flavor}/scam/burn`, {
                            method:  'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body:    JSON.stringify(payload),
                        });
                        const json = await res.json();

                        if (res.status === 409 || json.busy) {
                            if (status) status.textContent = tr('scam.busy', 'Gerade läuft schon eine Prüfung. Versuch es in einer Minute noch einmal.');
                            return;
                        }
                        if (!json.ok) {
                            if (status) status.textContent = tr('scam.failed', 'Löschen fehlgeschlagen: {error}', { error: json.error ?? 'unbekannt' });
                            return;
                        }

                        const freed = json.result?.freedSol ?? 0;
                        closeModal(mid);
                        showModal({
                            id:    'scam-burn-done',
                            title: tr('scam.done_title', 'Token gelöscht'),
                            body: `<p>${tr('scam.done_body',
                                '„{sym}“ wurde verbrannt und sein Konto geschlossen. {sol} SOL Konto-Miete sind wieder in deinem Wallet.',
                                { sym: esc(shown), sol: freed.toFixed(6) })}</p>`,
                            actions: [{ label: tr('common.close', 'Schließen'), onClick: () => closeModal('scam-burn-done') }],
                        });
                        onChanged?.();
                    } catch (err) {
                        if (status) status.textContent = tr('scam.failed', 'Löschen fehlgeschlagen: {error}', { error: err.message });
                    }
                },
            },
            { label: tr('common.cancel', 'Abbrechen'), onClick: () => closeModal(mid) },
        ],
    });
}
