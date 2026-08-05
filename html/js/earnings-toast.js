/**
 * FORGE – Earnings Toast (Kasching-Nachrichten)
 *
 * Zeigt rechts unten eine Benachrichtigung an, wenn:
 *   - Liquidity Fees geclaiment wurden (neuer Eintrag in claimHistory)
 *   - LendingBot Yield angewachsen ist (totalYield-Delta ≥ 0.001 USDC)
 *
 * Verwendung (selbst-pollend – empfohlen):
 *   const et = new EarningsToast();
 *   et.startPolling('liquidity/data/data.json', 'lending/data/data.json');
 *
 * Verwendung (manuell, wenn die Daten bereits geladen sind):
 *   et.update(liqData, lendData);
 *
 * Sound aktivierbar/deaktivierbar via toggleSound().
 * Einstellung wird in localStorage gespeichert (seitenübergreifend).
 */

// localStorage-Keys für Reload-sichere Timestamps
const LS_LIQ_TS     = 'forge_earningsLiqLastClaimTs';
const LS_LEND_YIELDS = 'forge_earningsLendLastYields';

export class EarningsToast {
    constructor({
        soundKey = 'forge_earningsSoundEnabled',
        soundSrc = '/forge/sounds/cha-ching.mp3',
    } = {}) {
        this._soundKey     = soundKey;
        this._soundEnabled = localStorage.getItem(soundKey) !== 'false';
        this._soundSrc     = soundSrc;
        this._audio        = null;
        this._pollTimer    = null;

        // Timestamps aus localStorage wiederherstellen — überleben Seiten-Reloads.
        // null = noch nie ein Poll → Bootstrap (erster Poll setzt Startpunkt, kein Toast).
        const savedTs = localStorage.getItem(LS_LIQ_TS);
        this._lastLiqClaimTs = savedTs !== null ? Number(savedTs) : null;

        try {
            const savedYields = localStorage.getItem(LS_LEND_YIELDS);
            this._lastLendingYields = savedYields
                ? new Map(Object.entries(JSON.parse(savedYields)))
                : null;
        } catch { this._lastLendingYields = null; }
    }

    get soundEnabled() { return this._soundEnabled; }

    toggleSound() {
        this._soundEnabled = !this._soundEnabled;
        localStorage.setItem(this._soundKey, String(this._soundEnabled));
        return this._soundEnabled;
    }

    /**
     * Startet eigenständiges Polling beider Datenquellen.
     * Jede Seite übergibt die für sie passenden relativen URLs.
     *
     * @param {string|null} liqUrl   Relativer Pfad zu Liquidity data.json (null = kein Liquidity)
     * @param {string|null} lendUrl   Relativer Pfad zu LendingBot data.json (null = kein LB)
     * @param {number}      intervalMs Polling-Intervall (default: 60 s)
     */
    startPolling(liqUrl, lendUrl, intervalMs = 60_000) {
        this._liqUrl = liqUrl;
        this._lendUrl = lendUrl;
        this._poll();
        this._pollTimer = setInterval(() => this._poll(), intervalMs);
    }

    /**
     * Prüft ob neue Earnings vorliegen und zeigt ggf. Toast + Sound.
     * Kann auch direkt aufgerufen werden wenn die Daten bereits vorliegen.
     *
     * @param {object|null} liqData   LiquidityMiningBot3 data.json
     * @param {object|null} lendData   LendingBot data.json
     */
    update(liqData, lendData) {
        const events = [];

        // ── Liquidity: neuer Claim in claimHistory ────────────────────────────────
        const claims = liqData?.claimHistory ?? [];
        if (claims.length > 0) {
            const latest = claims[0]; // DESC sortiert → neueste zuerst
            const ts = latest.claimedAt ?? 0;
            if (this._lastLiqClaimTs === null) {
                this._lastLiqClaimTs = ts; // Bootstrap
                localStorage.setItem(LS_LIQ_TS, String(ts));
            } else if (ts > this._lastLiqClaimTs) {
                this._lastLiqClaimTs = ts;
                localStorage.setItem(LS_LIQ_TS, String(ts));
                events.push({
                    label: 'Liquidity Bot',
                    amount: latest.usdValue ?? 0,
                    sub: latest.displayPair ?? latest.pair ?? '',
                });
            }
        }

        // ── LendingBot: accruedYield pro Position gestiegen ─────────────────
        const positions = lendData?.positions ?? [];
        if (positions.length > 0) {
            if (this._lastLendingYields === null) {
                // Bootstrap: Startwerte setzen, kein Toast
                this._lastLendingYields = new Map(positions.map(p => [String(p.id), p.accruedYield ?? 0]));
                this._saveLendingYields();
            } else {
                for (const pos of positions) {
                    const key   = String(pos.id);
                    const prev  = this._lastLendingYields.get(key) ?? 0;
                    const curr  = pos.accruedYield ?? 0;
                    const delta = curr - prev;
                    if (delta < 0) {
                        // Yield gesunken (Abhebung / Reset) – Basis aktualisieren, kein Toast
                        this._lastLendingYields.set(key, curr);
                        this._saveLendingYields();
                    } else if (delta >= 0.05) {
                        // Toast erst ab 0,05 USDC kumuliertem Yield – kleinere Increments
                        // sammeln sich an (prev wird nicht aktualisiert), bis Schwelle erreicht.
                        this._lastLendingYields.set(key, curr);
                        this._saveLendingYields();
                        events.push({
                            label:  'Lending Bot',
                            amount: delta,
                            sub:    pos.protocolLabel ?? pos.protocol ?? '',
                        });
                    }
                }
                // Geschlossene Positionen aus der Map entfernen
                const activeIds = new Set(positions.map(p => String(p.id)));
                for (const id of this._lastLendingYields.keys()) {
                    if (!activeIds.has(id)) this._lastLendingYields.delete(id);
                }
            }
        }

        if (events.length === 0) return;
        const muted = localStorage.getItem('forge_hub_muted') === 'true';
        if (!muted) {
            events.forEach(e => this._show(e));
            if (localStorage.getItem(this._soundKey) !== 'false') this._play();
        }
    }

    async _poll() {
        const [liq, lend] = await Promise.all([
            this._liqUrl ? _fetchJson(this._liqUrl) : Promise.resolve(null),
            this._lendUrl ? _fetchJson(this._lendUrl) : Promise.resolve(null),
        ]);
        this.update(liq, lend);
    }

    _show(event) {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const el = document.createElement('div');
        el.className = 'toast level-earnings';
        el.innerHTML =
            `<div class="toast-earnings-header">` +
                `<span class="toast-earnings-icon">&#128176;</span>` +
                `<span class="toast-earnings-label">${event.label}</span>` +
            `</div>` +
            (event.sub ? `<div class="toast-pair">${event.sub}</div>` : '') +
            `<div class="toast-earnings-amount">+${_fmtUsdc(event.amount)}&nbsp;USDC</div>`;

        const remove = () => {
            el.classList.add('removing');
            setTimeout(() => el.remove(), 300);
        };
        el.addEventListener('click', remove);
        container.appendChild(el);
        setTimeout(remove, 6_000);
    }

    _saveLendingYields() {
        try {
            const obj = Object.fromEntries(this._lastLendingYields);
            localStorage.setItem(LS_LEND_YIELDS, JSON.stringify(obj));
        } catch { /* localStorage voll o.ä. – still ignorieren */ }
    }

    _play() {
        try {
            if (!this._audio) this._audio = new Audio(this._soundSrc);
            this._audio.currentTime = 0;
            this._audio.play().catch(() => {});
        } catch (_) {}
    }
}

async function _fetchJson(url) {
    try {
        const res = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
    } catch (_) {
        return null;
    }
}

function _fmtUsdc(v) {
    if (v >= 1)    return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(4);
    return v.toFixed(6);
}
