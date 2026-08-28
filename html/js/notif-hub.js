/**
 * FORGE NotifHub – Gemeinsamer Notification-Speicher für alle FORGE-Seiten.
 *
 * Alle Seiten teilen dieselben localStorage-Keys:
 *   forge_notif_hub        – [{uid, level, message, ts, botLabel}]
 *   forge_hub_dismissed    – [uid, uid, …]
 *   forge_hub_muted        – 'true'/'false' (Popup-Mute)
 *   forge_earningsSoundEnabled – Kasching-Sound (shared mit EarningsToast)
 *
 * Verwendung:
 *   const hub = new NotifHub(() => hub.renderPanel(badge, body));
 *   hub.startPolling('data/data.json', '../lending/data/data.json');
 *   // Im refresh()-Callback der Seite:
 *   hub.feed(liqData, null);   // null = diese Quelle nicht anfassen
 */

const STORE_KEY   = 'forge_notif_hub';
const DISMISS_KEY = 'forge_hub_dismissed';
const MUTE_KEY    = 'forge_hub_muted';
const SOUND_KEY   = 'forge_earningsSoundEnabled';
const MAX_AGE_MS       = 12 * 60 * 60 * 1000;   // Standard: 12h (Rebalancing, Warnungen, Fehler)
const EARNING_MAX_AGE  = 10 * 60 * 1000;        // Einnahmen: 10 Min. (Yield + Fee-Claims)
const MAX_ITEMS        = 50;

// Einnahmen-Erkennung: LendingBot-Yield (UID-Präfix) oder Liquidity-Fee-Claim
// (Message-Format nach _normalizeLiqMsg: "<Pool>: +<Betrag> USDC", einzeilig).
function _isEarning(n) {
    if (n.uid?.startsWith('lend_yield_')) return true;
    if (n.uid?.startsWith('liq_db_') && /^[^\n]+:\s*\+[\d.]+\s*USDC\s*$/.test(n.message ?? '')) return true;
    return false;
}

export class NotifHub {
    constructor(onUpdate = null) {
        this._onUpdate      = onUpdate;
        this._pollTimer     = null;
    }

    /** Startet eigenständiges Polling beider Datenquellen (Cross-Page-Sync). */
    startPolling(liqUrl, lendUrl, intervalMs = 60_000) {
        this._liqUrl = liqUrl;
        this._lendUrl = lendUrl;
        this._doPoll();
        this._pollTimer = setInterval(() => this._doPoll(), intervalMs);
    }

    /**
     * Notifications aus data.json in den Hub einspeisen.
     * null = diese Quelle nicht anfassen (bestehende Einträge bleiben erhalten).
     */
    feed(liqData, lendData) {
        this._merge(liqData, lendData);
    }

    /** Alle aktiven (nicht-dismissten) Notifications, neueste zuerst. */
    getActive() {
        const d = _loadDismissed();
        return _load().filter(n => !d.has(n.uid));
    }

    /** Alle Notifications (inkl. dismisste). */
    getAll() { return _load(); }

    /** Badge + Panelkörper aktualisieren. */
    renderPanel(badgeEl, bodyEl) {
        const active = this.getActive();
        if (badgeEl) {
            badgeEl.textContent = active.length > 99 ? '99+' : String(active.length);
            badgeEl.classList.toggle('hidden', active.length === 0);
        }
        if (!bodyEl) return;
        bodyEl.innerHTML = active.length === 0
            ? '<div class="notif-empty">Keine Benachrichtigungen</div>'
            : active.map(_renderItem).join('');
    }

    /** Alle aktuell aktiven Notifications als gelesen markieren. */
    clearAll() {
        const d = _loadDismissed();
        _load().forEach(n => d.add(n.uid));
        _saveDismissed(d);
        this._onUpdate?.();
    }

    // ── Mute & Sound ──────────────────────────────────────────────────────────

    get muted()       { return localStorage.getItem(MUTE_KEY) === 'true'; }
    toggleMute()      { const m = !this.muted;  localStorage.setItem(MUTE_KEY, String(m)); return m; }

    get soundEnabled(){ return localStorage.getItem(SOUND_KEY) !== 'false'; }
    toggleSound()     { const s = !this.soundEnabled; localStorage.setItem(SOUND_KEY, String(s)); return s; }

    // ── Intern ────────────────────────────────────────────────────────────────

    async _doPoll() {
        const [liq, lend] = await Promise.all([
            this._liqUrl ? _fetchJson(this._liqUrl) : Promise.resolve(null),
            this._lendUrl ? _fetchJson(this._lendUrl)  : Promise.resolve(null),
        ]);
        this._merge(liq, lend);
    }

    _merge(liqData, lendData) {
        const existing = _load();
        const byUid    = new Map(existing.map(n => [n.uid, n]));

        // Cleanup: alte kombinierte Yield-Einträge (UID-Schema `lend_yield_<ts>`,
        // ohne posId) entfernen. Neues Schema ist `lend_yield_<posId>_<ts>`.
        for (const uid of [...byUid.keys()]) {
            if (uid.startsWith('lend_yield_') && uid.split('_').length === 3) {
                byUid.delete(uid);
            }
        }

        // Liquidity-Einträge aktualisieren (nur wenn liqData nicht null)
        if (liqData !== null) {
            for (const [uid] of byUid) if (uid.startsWith('liq_db_')) byUid.delete(uid);
            for (const n of (liqData?.notifications ?? [])) {
                byUid.set(`liq_db_${n.id}`, {
                    uid: `liq_db_${n.id}`, level: n.level ?? 'info',
                    message: _normalizeLiqMsg(n.message ?? ''),
                    ts: n.ts ?? 0,
                    botLabel: 'Liquidity Bot',
                    pool: n.pool ?? null,
                });
            }
        }

        // LendingBot-Einträge aktualisieren (nur wenn lendData nicht null)
        if (lendData !== null) {
            // DB-Notifications (Events wie Rebalancing, TVL-Crossing, Auto-Exit)
            for (const [uid] of byUid) if (uid.startsWith('lend_db_')) byUid.delete(uid);
            for (const n of (lendData?.notifications ?? [])) {
                byUid.set(`lend_db_${n.id}`, {
                    uid: `lend_db_${n.id}`, level: n.level ?? 'info',
                    message: n.message ?? '', ts: n.ts ?? 0,
                    botLabel: 'Lending Bot',
                });
            }


        }

        // Veraltete Dismissed-UIDs bereinigen
        const currentUids = new Set(byUid.keys());
        const d           = _loadDismissed();
        const pruned      = new Set([...d].filter(uid => currentUids.has(uid)));
        if (pruned.size !== d.size) _saveDismissed(pruned);

        const now    = Date.now();
        const result = [...byUid.values()]
            .filter(n => n.level !== 'info')
            .filter(n => (now - (n.ts ?? 0)) < (_isEarning(n) ? EARNING_MAX_AGE : MAX_AGE_MS))
            .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
            .slice(0, MAX_ITEMS);

        localStorage.setItem(STORE_KEY, JSON.stringify(result));
        this._onUpdate?.();
    }
}

// ── Private Hilfsfunktionen ───────────────────────────────────────────────────

function _load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]'); } catch { return []; }
}
function _loadDismissed() {
    try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]')); } catch { return new Set(); }
}
function _saveDismissed(set) {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...set]));
}

async function _fetchJson(url) {
    try {
        const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

/**
 * Normalisiert alte Liquidity Fee-Claim-Nachrichten aus nexus.db auf das neue Format.
 * Alt: "*Fees geclaimed* – SOL/USDC\n0.006051 SOL + 0.51 USDC\nAktion: ↩ Reinvestiert"
 *      "<b>Fees geclaimed</b> – SOL/USDC\n+0.51 USDC\nAktion: ↩ Reinvestiert"
 * Neu: "SOL/USDC: +0.51 USDC"  (direkt aus notify.js, bereits korrekt)
 */
function _normalizeLiqMsg(msg) {
    // Erkennt alte Formate mit "Fees geclaimed" Header
    const m = msg.match(/(?:\*?Fees geclaimed\*?|<b>Fees geclaimed<\/b>)\s*[–\-]\s*(\S+\/\S+)\s*\n\+?([\d.]+)\s*\S*(?:\s*\+\s*([\d.]+))?\s*USDC/i);
    if (m) {
        const pair = m[1];
        const usdc = parseFloat(m[3] ?? m[2]); // bevorzuge zweiten Summand (= USDC-Seite bei altem Format)
        const fmt  = usdc >= 1 ? usdc.toFixed(2) : usdc >= 0.01 ? usdc.toFixed(4) : usdc.toFixed(6);
        return `${pair}: +${fmt} USDC`;
    }
    return msg; // Bereits im neuen Format oder anderer Typ (Rebalancing etc.)
}

const _pad2 = n => String(n).padStart(2, '0');
function _fmtTime(ts) {
    const d = new Date(ts);
    return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}\u202fUhr`;
}
function _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** ```-Abschnitte als Monospace-Block. Siehe fenceToPre() in notifications.js — identische
 *  Regel: läuft immer auf bereits escaptem Text, einziger eingefügter Tag ist <pre>. */
function _fenceToPre(escaped) {
    return String(escaped).split('```').map((p, i) =>
        i % 2 === 0 ? p : `<pre>${p.replace(/^\n/, '').replace(/\n$/, '')}</pre>`).join('');
}
function _renderItem(n) {
    const time = n.ts ? _fmtTime(n.ts) : '';
    const meta = [time, _esc(n.botLabel ?? ''), _esc(n.pool ?? '')].filter(Boolean).join(' · ');
    return `<div class="notif-item level-${n.level ?? 'info'}">
        <div class="notif-item-top"><span class="notif-item-meta">${meta}</span></div>
        <div class="notif-item-msg">${_fenceToPre(_esc(n.message))}</div>
    </div>`;
}
