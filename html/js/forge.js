(async function () {
    'use strict';

    const { ToastManager }      = await import('./toast.js?v=20260809a');
    const { EarningsToast }     = await import('./earnings-toast.js?v=20260720a');
    const { renderNotifItem }   = await import('./notifications.js');
    const { NotifHub }          = await import('./notif-hub.js?v=20260720a');
    const { initMessageBell }   = await import('./message-bell.js?v=20260809a');
    const { initNav, initFooter, setLastUpdate } = await import('./nav.js?v=20260809b');
    const { attachHoverOverlay, attachBarTooltip } = await import('./chart.js?v=20260411a');
    const { TZ, todayISO, startOfDayMs, fmtDE, fmtDateDE, fmtTimeDE, partsInTZ, hourBucketKey } = await import('./tz.js?v=20260414a');

    initNav({ current: 'overview' });
    initFooter();

    const toast = new ToastManager({
        storageKey: 'forge_overview_lastToastTs',
        muteKey:    'forge_overview_toastMuted',
        panelId:    'notifPanel',
    });

    const earningsToast = new EarningsToast();
    earningsToast.startPolling('liquidity/data/data.json', null);

    const hub = new NotifHub();
    hub.startPolling('liquidity/data/data.json', 'lending/data/data.json');

    const MONTHS_DE = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
    const RANGE_MS  = { '1D': 86_400_000, '1W': 7*86_400_000, '1M': 30*86_400_000 };

    // persistierter Zustand
    let ovRange  = (['1D','1W','1M'].includes(localStorage.getItem('ovChartRange')))
                   ? localStorage.getItem('ovChartRange') : '1M';
    let earRange = (['1D','1W','1M'].includes(localStorage.getItem('earChartRange')))
                   ? localStorage.getItem('earChartRange') : '1M';

    let _lastData    = null;   // letztes Refresh-Ergebnis
    let _lastPoints  = null;   // aggregierte Portfolio-Punkte (aktueller Range)
    let _lastBars    = null;   // aggregierte Tageseinnahmen (aktueller Range)

    // ── Hilfsfunktionen ───────────────────────────────────────────────────────

    async function loadJSON(url) {
        try {
            const r = await fetch(url + '?v=' + Date.now());
            if (!r.ok) return null;
            return await r.json();
        } catch { return null; }
    }

    function fmt2(v) {
        if (v == null || isNaN(v)) return '–';
        return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtSigned(v, dec = 2) {
        if (v == null || isNaN(v)) return '–';
        const sign = v >= 0 ? '+' : '';
        return sign + v.toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '\u00A0USDC';
    }

    // ── Portfolio-History aggregieren ─────────────────────────────────────────

    function aggregatePortfolioHistory(sources, cutoff, now) {
        const rangeMs  = now - cutoff;
        const bucketMs = rangeMs <= 86_400_000 ? 3_600_000
                       : rangeMs <= 7*86_400_000 ? 21_600_000
                       : 86_400_000;

        const first = Math.ceil(cutoff / bucketMs) * bucketMs;
        const buckets = [];
        for (let t = first; t <= now; t += bucketMs) buckets.push(t);

        return buckets.map(t => {
            let sum = 0, hasData = false;
            for (const src of sources) {
                // binary search: letzter Wert ≤ t
                let lo = 0, hi = src.length - 1, idx = -1;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    if (src[mid].t <= t) { idx = mid; lo = mid + 1; }
                    else hi = mid - 1;
                }
                if (idx >= 0) { sum += src[idx].v; hasData = true; }
            }
            return hasData ? { t, v: sum } : null;
        }).filter(Boolean);
    }

    // ── Stundeneinnahmen (1D-Ansicht) ─────────────────────────────────────────
    // 24 Stunden-Buckets (rolling 24h, FORGE_TZ).
    // Liquidity: claimHistory (alle Claims des Monats, kein 25-TX-Limit).
    // LendingBot: Tagesertrag gleichmäßig auf verstrichene Stunden verteilt.

    function aggregateHourlyEarnings(lendLive, liqLive) {
        const now    = Date.now();
        const cutoff = now - 86_400_000;  // rolling 24h

        // Alle Bucket-Keys/Labels beziehen sich auf FORGE_TZ (nicht Browser-Zeit).
        // So sieht ein Nutzer in New York dieselben Stunden wie der Server in Berlin.
        const nowParts = partsInTZ(now);
        // volle FORGE_TZ-Stunde: Minuten/Sekunden auf 0 normieren
        const nowHMs = now - (nowParts.minute * 60_000 + nowParts.second * 1000 + (now % 1000));

        // 24 Buckets: älteste Stunde links, aktuelle Stunde rechts
        const buckets = new Map();
        for (let h = 23; h >= 0; h--) {
            const t   = nowHMs - h * 3_600_000;
            const p   = partsInTZ(t);
            const key = hourBucketKey(t);
            buckets.set(key, { label: `${String(p.hour).padStart(2,'0')}:00`, lend: 0, liq: 0 });
        }

        // Liquidity: hourlyPnl ist server-seitig vorberechnet (export.js):
        // Δ(kumulativer Portfolio-PnL) + Netto-Fee-Transfers pro Stunde.
        // 24 Einträge in zeitlicher Reihenfolge (ältester zuerst) — positional mit Buckets alignment.
        if (liqLive?.hourlyPnl?.length === 24) {
            const bArr = [...buckets.values()];
            for (let i = 0; i < 24; i++) {
                bArr[i].liq = liqLive.hourlyPnl[i].pnl ?? 0;
            }
        }

        // LendingBot: kein stündliches Datenmodell → heutigen Tagesertrag gleichmäßig
        // auf die bisher verstrichenen vollen Stunden des heutigen Tages (FORGE_TZ) verteilen.
        // Gestrige Stunden im 24h-Fenster werden proportional mit yesterday.usdc / 24 gefüllt
        // (rolling 24h, konsistent mit Liquidity).
        const midnightMs    = startOfDayMs();
        const lendToday     = lendLive?.statistics?.today?.usdc     ?? 0;
        const lendYesterday = lendLive?.statistics?.yesterday?.usdc ?? 0;
        const elapsedH = Math.max(1, Math.floor((now - midnightMs) / 3_600_000));
        if (lendToday > 0) {
            const perH = lendToday / elapsedH;
            for (let h = 0; h < elapsedH; h++) {
                const b = buckets.get(hourBucketKey(midnightMs + h * 3_600_000));
                if (b) b.lend += perH;
            }
        }
        if (lendYesterday > 0) {
            const perHY = lendYesterday / 24;
            for (let h = 1; h <= 24; h++) {
                const b = buckets.get(hourBucketKey(midnightMs - h * 3_600_000));
                if (b) b.lend += perHY;
            }
        }

        return [...buckets.values()].map(b => ({
            date: b.label,   // "HH:00" – direkt als X-Label
            lend: Math.max(0, parseFloat(b.lend.toFixed(4))),
            liq: Math.max(0, parseFloat(b.liq.toFixed(4))),
        }));
    }

    // ── Tageseinnahmen aggregieren ────────────────────────────────────────────

    function aggregateDailyEarnings(lendLive, liqLive, days) {
        // Tagesgrenzen in FORGE_TZ — unabhängig von Browser-Zeitzone.
        // Wir wandern pro Schritt 24h zurück und konvertieren zur FORGE_TZ-Datumsangabe.
        const nowMs = Date.now();
        const dates = Array.from({ length: days }, (_, i) =>
            todayISO(new Date(nowMs - (days - 1 - i) * 86_400_000))
        );

        const lendByDate = {};
        for (const e of (lendLive?.statistics?.dailyProfits ?? [])) {
            lendByDate[e.date] = e.usdc ?? 0;
        }
        const liqByDate = {};
        for (const e of (liqLive?.dailyPnl ?? [])) {
            if (e.pnl != null) liqByDate[e.date] = e.pnl;
        }

        return dates.map(date => ({
            date,
            lend: Math.max(0, lendByDate[date] ?? 0),
            liq: Math.max(0, liqByDate[date] ?? 0),
        }));
    }

    // ── Liniendiagramm zeichnen ───────────────────────────────────────────────
    // attachHover=true nur für Modals (Fadenkreuz-Overlay)

    function buildLineChart(svgEl, points, H = 140, attachHover = false) {
        const emptyEl = svgEl?.parentElement?.querySelector('.ov-empty');
        if (!svgEl) return null;
        if (!points || points.length < 2) {
            svgEl.style.display = 'none';
            if (emptyEl) emptyEl.style.display = 'block';
            return null;
        }
        svgEl.style.display = '';
        if (emptyEl) emptyEl.style.display = 'none';

        const W = svgEl.getBoundingClientRect().width || svgEl.parentElement?.clientWidth || 600;
        svgEl.setAttribute('height', H);
        svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

        const PAD_L = 64, PAD_R = 14, PAD_T = 12, PAD_B = 28;
        const cW = W - PAD_L - PAD_R;
        const cH = H - PAD_T - PAD_B;

        const ts = points.map(p => p.t);
        const vs = points.map(p => p.v);
        const tMin = Math.min(...ts), tMax = Math.max(...ts);

        let yMin = Math.min(...vs);
        let yMax = Math.max(...vs);
        const yRng = yMax - yMin;
        if (yRng < 1) { yMin -= 5; yMax += 5; }
        else          { yMin -= yRng * 0.12; yMax += yRng * 0.08; }

        const sx = t => PAD_L + ((t - tMin) / (tMax - tMin || 1)) * cW;
        const sy = v => PAD_T + cH - ((v - yMin) / (yMax - yMin || 1)) * cH;

        const decimals = yRng > 50 ? 0 : 2;
        const yGrid = Array.from({ length: 4 }, (_, i) => yMin + (yMax - yMin) * i / 3);
        const gridLines = yGrid.map(v =>
            `<line x1="${PAD_L}" y1="${sy(v).toFixed(1)}" x2="${(PAD_L+cW).toFixed(1)}" y2="${sy(v).toFixed(1)}" class="ov-chart-grid"/>` +
            `<text x="${(PAD_L-4).toFixed(1)}" y="${sy(v).toFixed(1)}" class="ov-chart-label ov-chart-label-y" dominant-baseline="middle">${v.toLocaleString('de-DE',{minimumFractionDigits:decimals,maximumFractionDigits:decimals})}</text>`
        ).join('');

        const spanMs = tMax - tMin;
        const xCount = H > 200 ? 6 : 5;
        const xLabels = Array.from({ length: xCount }, (_, i) => {
            const t = tMin + spanMs * i / (xCount - 1);
            // Achsen-Labels in FORGE_TZ rendern (nicht Browser-Zeit)
            const p = partsInTZ(t);
            const label = spanMs < 48*3_600_000
                ? `${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}`
                : `${p.day}. ${MONTHS_DE[p.month - 1]}`;
            return `<text x="${sx(t).toFixed(1)}" y="${(PAD_T+cH+16).toFixed(1)}" class="ov-chart-label ov-chart-label-x">${label}</text>`;
        }).join('');

        const pts   = points.map(p => `${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`);
        const lineD = `M ${pts.join(' L ')}`;
        const bottomY = (PAD_T + cH).toFixed(1);
        const areaD = `${lineD} L ${sx(ts[ts.length-1]).toFixed(1)},${bottomY} L ${sx(ts[0]).toFixed(1)},${bottomY} Z`;

        const gradId = `ovGrad_${svgEl.id}`;
        svgEl.innerHTML = `
            <defs>
                <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.18"/>
                    <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.01"/>
                </linearGradient>
            </defs>
            ${gridLines}
            ${xLabels}
            <path d="${areaD}" fill="url(#${gradId})" stroke="none"/>
            <path d="${lineD}" class="ov-chart-line" stroke="var(--accent)" stroke-linejoin="round" stroke-linecap="round"/>`;

        const geo = { tMin, tMax, spanMs, PAD_L, PAD_T, cW, cH, yMin, yMax,
            formatY: v => v.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) };
        if (attachHover) attachHoverOverlay(svgEl, geo);
        return geo;
    }

    // ── Balkendiagramm zeichnen ───────────────────────────────────────────────

    const BOT_COLORS = {
        lend: '#a78bfa',
        liq: 'var(--success)',
    };
    const BOT_LABELS = { lend: 'Lending Bot', liq: 'Liquidity Bot' };

    // showLegend=true nur für Modals
    function buildBarChart(svgEl, wrapEl, bars, H = 140, showLegend = false) {
        const emptyEl = svgEl?.parentElement?.querySelector('.ov-empty');
        if (!svgEl || !bars || bars.length === 0) {
            if (svgEl) svgEl.style.display = 'none';
            if (emptyEl) emptyEl.style.display = 'block';
            return;
        }
        svgEl.style.display = '';
        if (emptyEl) emptyEl.style.display = 'none';

        // Legende (nur im Modal)
        if (wrapEl) {
            let legendEl = wrapEl.querySelector('.ov-bar-legend');
            if (showLegend) {
                if (!legendEl) {
                    legendEl = document.createElement('div');
                    legendEl.className = 'ov-bar-legend';
                    wrapEl.insertBefore(legendEl, wrapEl.firstChild);
                }
                legendEl.innerHTML = Object.entries(BOT_LABELS).map(([k, label]) =>
                    `<span class="ov-bar-legend-item"><span class="ov-bar-legend-dot" style="background:${BOT_COLORS[k]}"></span>${label}</span>`
                ).join('');
            } else if (legendEl) {
                legendEl.remove();
            }
        }

        const W = svgEl.getBoundingClientRect().width || svgEl.parentElement?.clientWidth || 600;
        svgEl.setAttribute('height', H);
        svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

        const PAD_L = 50, PAD_R = 10, PAD_T = 12, PAD_B = 28;
        const cW = W - PAD_L - PAD_R;
        const cH = H - PAD_T - PAD_B;

        const totals = bars.map(b => (b.lend ?? 0) + (b.liq ?? 0));
        const maxV   = Math.max(...totals, 0.01);
        const yMax   = maxV * 1.12;

        const sy = v => PAD_T + cH - (v / yMax) * cH;

        const barSlot = cW / bars.length;
        const barW    = Math.max(3, barSlot * 0.65);

        // Grid (3 Stufen)
        const gridLines = [0, maxV * 0.5, maxV].map(v => {
            const label = v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
            return `<line x1="${PAD_L}" y1="${sy(v).toFixed(1)}" x2="${(PAD_L+cW).toFixed(1)}" y2="${sy(v).toFixed(1)}" class="ov-chart-grid"/>` +
                   `<text x="${(PAD_L-4).toFixed(1)}" y="${sy(v).toFixed(1)}" class="ov-chart-label ov-chart-label-y" dominant-baseline="middle">${label}</text>`;
        }).join('');

        // Balken (gestapelt: lend unten, liq oben)
        const barsSvg = bars.map((b, i) => {
            const cx = PAD_L + i * barSlot + barSlot / 2;
            const x  = (cx - barW / 2).toFixed(1);
            const total = totals[i];
            const ds = `data-date="${b.date}" data-lend="${(b.lend??0).toFixed(2)}" data-liq="${(b.liq??0).toFixed(2)}" data-total="${total.toFixed(2)}"`;

            let rects = '';
            let acc = 0;
            for (const key of ['lend', 'liq']) {
                const val = b[key] ?? 0;
                if (val <= 0) continue;
                const yTop = sy(acc + val);
                const yBot = sy(acc);
                const h    = Math.max(1, yBot - yTop);
                rects += `<rect x="${x}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${BOT_COLORS[key]}" opacity="0.82" rx="1" ${ds}/>`;
                acc += val;
            }

            const labelTxt = b.date.includes(':') ? b.date
                : (() => { const d = new Date(b.date + 'T12:00:00'); return `${d.getDate()}. ${MONTHS_DE[d.getMonth()]}`; })();
            const lblStep  = labelTxt.includes(':') ? 3 : Math.ceil(bars.length / Math.max(2, Math.floor(cW / 40)));
            const showLabel = i % lblStep === 0;
            const xLabel = showLabel
                ? `<text x="${cx.toFixed(1)}" y="${(PAD_T+cH+16).toFixed(1)}" class="ov-chart-label ov-chart-label-x">${labelTxt}</text>`
                : '';

            return rects + xLabel;
        }).join('');

        svgEl.innerHTML = gridLines + barsSvg;

        // Tooltip-Legende
        attachBarTooltip(svgEl, wrapEl, 'rect[data-date]', bar => {
            const ds    = bar.dataset.date;
            const label = ds.includes(':') ? `${ds} Uhr`
                : (() => { const d = new Date(ds + 'T12:00:00'); return `${d.getDate()}. ${MONTHS_DE[d.getMonth()]}`; })();
            const total = parseFloat(bar.dataset.total);
            return `${label}: ${total.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
        });
    }

    // ── Charts rendern ────────────────────────────────────────────────────────

    function renderCharts(data) {
        const { lendLive, liqLive } = data;
        const now    = Date.now();
        const cutoff = now - (RANGE_MS[ovRange] ?? RANGE_MS['1M']);

        // Portfolio-History quellen normalisieren (LendingBot nutzt 'ts' statt 't')
        const sources = [];
        if (lendLive?.portfolioHistory?.length) {
            sources.push(lendLive.portfolioHistory.map(p => ({ t: p.ts ?? p.t, v: p.v })));
        }
        if (liqLive?.portfolioHistory?.length) {
            sources.push(liqLive.portfolioHistory.map(p => ({ t: p.t, v: p.v })));
        }

        const points = aggregatePortfolioHistory(sources, cutoff, now);

        // Chart-Punkt: gleiche Metrik-Basis wie alle historischen portfolioHistory-Punkte
        // (total_usd = LP + Fees + GESAMTER Wallet inkl. SOL-Reserve, siehe bin/export.js).
        // liqLive.portfolio.balance zieht die SOL-Reserve bewusst ab (Tabellen-Metrik,
        // Spike-Damper-Schutz) – als Chart-Punkt verwendet, knickt die Linie am rechten
        // Rand künstlich ab, sobald genug freies SOL im Wallet liegt (Fund 2026-08-07:
        // sichtbarer "Einbruch" nach einem manuellen Deposit/Withdraw-Test auf forge-pub1,
        // obwohl real nichts fehlte – currentValue blieb stabil, nur balance war niedriger).
        //
        // lendLive.portfolio.currentValue ist NUR die aktiven Pool-Positionen (bewusst ohne
        // Wallet, siehe bin/export.js) – als Chart-/Summen-Punkt verwendet, fällt Kapital,
        // das gerade nicht investiert ist (z.B. nach einem Withdraw, vor Redeploy), komplett
        // aus der Summe (Fund 2026-08-09: 20 USDC + SOL-Reserve im Wallet nach zwei Loopscale-
        // Withdraws auf forge-pub1 verschwanden aus dem Overview-Chart, obwohl real vorhanden).
        //
        // Für den CHART-Punkt bewusst NICHT lendLive.portfolio.balance (das zählt zusätzlich
        // das SOL-Wallet-Guthaben mit) – lendLive.portfolioHistory (5-Min-Verlauf, aus
        // portfolio_history in der DB) enthielt SOL noch nie, nur Pool + Wallet-USDC. Der
        // Live-Punkt muss dieselbe Basis wie die historischen Buckets haben, sonst springt die
        // Linie am rechten Rand künstlich um den SOL-Wert (Fund 2026-08-09, zweiter Fund direkt
        // nach dem ersten Rollout: sichtbarer Sprung 133 → 146 USDC ohne reale Ursache).
        // balance bleibt für Tabelle/Kopf-Wert korrekt (siehe liveTotal unten) – dort ist SOL
        // real Teil des Vermögens, nur die Chart-Zeitreihe darf die Basis nicht wechseln.
        const chartLiveTotal = ((lendLive?.portfolio?.currentValue ?? 0) + (lendLive?.portfolio?.walletUsdc ?? 0))
                              + (liqLive?.portfolio?.currentValue ?? 0);
        if (chartLiveTotal > 0 && points.length > 0) {
            points.push({ t: now, v: chartLiveTotal });
        }

        _lastPoints  = points;

        // Aktueller Wert in Card-Header – identisch mit Tabellen-Summe (balance), NICHT
        // der Chart-Metrik oben – sonst laufen Header und Tabellenzeile wieder auseinander
        // (der ursprüngliche Zweck von liveTotal, siehe Git-Historie dieser Zeile).
        const liveTotal = (lendLive?.portfolio?.balance ?? 0) + (liqLive?.portfolio?.balance ?? 0);
        const curVal = liveTotal > 0 ? liveTotal : (points.length > 0 ? points[points.length - 1].v : null);
        if (curVal != null) {
            const el = document.getElementById('portfolioCurrentVal');
            if (el) el.textContent = curVal.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + '\u00A0USDC';
        }

        // Liniendiagramm – kein Fadenkreuz im Inline-Chart
        buildLineChart(document.getElementById('portfolioChartSvg'), points, 140, false);

        const bars = earRange === '1D'
            ? aggregateHourlyEarnings(lendLive, liqLive)
            : aggregateDailyEarnings(lendLive, liqLive, earRange === '1W' ? 7 : 30);
        _lastBars  = bars;

        // 1D: zentrale pnl24h-Werte verwenden (korrekte zentrale Lib, nicht Bucket-Summe).
        // Bucket-Summe weicht ab weil Stunden-Grenzen nicht exakt mit 24h-Fenster übereinstimmen
        // und negative LP-Schwankungen (Kurs) die Summe verzerren würden.
        const liqProfit24h = liqLive?.portfolio?.pnl24h            ?? null;
        const lendProfit24h = lendLive?.statistics?.rolling24h?.yield ?? null;
        const totalEarnings = earRange === '1D'
            ? (liqProfit24h ?? 0) + (lendProfit24h ?? 0)
            : bars.reduce((s, b) => s + b.lend + b.liq, 0);
        const earEl = document.getElementById('earningsCurrentVal');
        if (earEl) earEl.textContent = fmtSigned(totalEarnings);

        // Balkendiagramm – keine Legende im Inline-Chart
        buildBarChart(
            document.getElementById('earningsChartSvg'),
            document.getElementById('earningsChartWrap'),
            bars, 140, false
        );
    }

    // ── Tabelle rendern ───────────────────────────────────────────────────────

    function renderTable(data) {
        const { lendLive, liqLive, lendStatus } = data;

        // Gesamtguthaben (aus Zeile 1 "Gesamt"-Card des jeweiligen Bots). balance = Pool/LP
        // + volles Wallet, NICHT currentValue (das zählt bei LendingBot nur aktive Positionen,
        // siehe Fund 2026-08-09 oben in renderCharts).
        const lendGesamt = lendLive?.portfolio?.balance ?? null;
        const liqGesamt = liqLive?.portfolio?.balance      ?? null;

        // PnL 24h: direkt aus vorberechneten Feldern der Bot-JSONs
        const lendProfit24h = lendLive?.statistics?.rolling24h?.yield ?? null;
        const liqProfit24h = liqLive?.portfolio?.pnl24h            ?? null;

        // APR 24h: direkt aus vorberechneten Feldern der Bot-JSONs
        const lendApr = lendLive?.statistics?.rolling24h?.apr ?? null;
        const liqApr = liqLive?.portfolio?.apr24h           ?? null;

        // Liquidity Bot zuerst, Lending Bot danach (feste Reihenfolge)
        const rows = [
            { label: 'Liquidity Bot', href: 'liquidity/', gesamt: liqGesamt, profit: liqProfit24h, apr: liqApr },
            { label: 'Lending Bot',   href: 'lending/',          gesamt: lendGesamt, profit: lendProfit24h, apr: lendApr },
        ];

        const tbody = document.getElementById('botTableBody');
        if (!tbody) return;

        tbody.innerHTML = rows.map(r => {
            const g = r.gesamt != null
                ? fmt2(r.gesamt) + '\u00A0USDC' : '0,00\u00A0USDC';

            const p       = r.profit;
            const pRounded = p != null ? Math.round(p * 100) / 100 : 0;
            const pZero   = p == null || pRounded === 0;
            const pCls = pZero ? 'bt-val' : p >= 0 ? 'bt-pos' : 'bt-neg';
            const pTxt = pZero ? '0,00\u00A0USDC'
                : (p >= 0 ? '+' : '') + fmt2(p) + '\u00A0USDC';

            const a    = r.apr;
            const aCls = a == null ? 'bt-neu' : a >= 0 ? 'bt-pos' : 'bt-neg';
            const aTxt = a == null ? '0,0\u00A0%'
                : (a >= 0 ? '+' : '') + a.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '\u00A0%';

            return `<tr>
                <td><a href="${r.href}" class="bt-name">${r.label}</a></td>
                <td><span class="bt-val">${g}</span></td>
                <td><span class="${pCls}">${pTxt}</span></td>
                <td><span class="${aCls}">${aTxt}</span></td>
            </tr>`;
        }).join('');

        // Summenzeile
        const totalGesamt = (lendGesamt     ?? 0) + (liqGesamt     ?? 0);
        const totalProfit = (lendProfit24h  ?? 0) + (liqProfit24h  ?? 0);

        const tgEl = document.getElementById('totalGesamt');
        const tpEl = document.getElementById('totalProfit');
        if (tgEl) tgEl.textContent = fmt2(totalGesamt) + '\u00A0USDC';
        if (tpEl) {
            const totalProfitRounded = Math.round(totalProfit * 100) / 100;
            const cls = totalProfitRounded === 0 ? 'bt-val' : totalProfit >= 0 ? 'bt-pos' : 'bt-neg';
            const txt = totalProfitRounded === 0
                ? '0,00\u00A0USDC'
                : (totalProfit >= 0 ? '+' : '') + fmt2(totalProfit) + '\u00A0USDC';
            tpEl.innerHTML = `<span class="${cls}">${txt}</span>`;
        }
    }

    // ── Modals ────────────────────────────────────────────────────────────────

    function openModal(id)  { const m = document.getElementById(id); if (m) m.style.display = 'flex'; }
    function closeModal(id) { const m = document.getElementById(id); if (m) m.style.display = 'none'; }

    function renderPortfolioModal() {
        if (!_lastPoints) return;
        const svgEl = document.getElementById('portfolioModalSvg');
        if (!svgEl) return;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            // Fadenkreuz nur im Modal
            buildLineChart(svgEl, _lastPoints, svgEl.getBoundingClientRect().height || 380, true);
        }));
    }

    function renderEarningsModal() {
        if (!_lastBars) return;
        const svgEl  = document.getElementById('earningsModalSvg');
        const wrapEl = document.getElementById('earningsModalBody');
        if (!svgEl || !wrapEl) return;
        // Legende vorab im DOM anlegen, damit der SVG-Flex-Anteil korrekt berechnet wird
        let legendEl = wrapEl.querySelector('.ov-bar-legend');
        if (!legendEl) {
            legendEl = document.createElement('div');
            legendEl.className = 'ov-bar-legend';
            wrapEl.insertBefore(legendEl, wrapEl.firstChild);
            legendEl.innerHTML = Object.entries(BOT_LABELS).map(([k, label]) =>
                `<span class="ov-bar-legend-item"><span class="ov-bar-legend-dot" style="background:${BOT_COLORS[k]}"></span>${label}</span>`
            ).join('');
        }
        // Nach Browser-Layout: SVG hat jetzt via flex:1 die korrekte Höhe (Modalfläche − Legende)
        requestAnimationFrame(() => requestAnimationFrame(() => {
            buildBarChart(svgEl, wrapEl, _lastBars, svgEl.getBoundingClientRect().height || 380, true);
        }));
    }

    function initModals() {
        // Portfolio-Modal öffnen (Klick auf Card)
        document.getElementById('portfolioCard')?.addEventListener('click', () => {
            openModal('portfolioModal');
            renderPortfolioModal();
        });
        document.getElementById('portfolioModalClose')?.addEventListener('click', () => closeModal('portfolioModal'));
        document.getElementById('portfolioModal')?.addEventListener('click', e => {
            if (e.target === e.currentTarget) closeModal('portfolioModal');
        });

        // Earnings-Modal öffnen (Klick auf Card)
        document.getElementById('earningsCard')?.addEventListener('click', () => {
            openModal('earningsModal');
            renderEarningsModal();
        });
        document.getElementById('earningsModalClose')?.addEventListener('click', () => closeModal('earningsModal'));
        document.getElementById('earningsModal')?.addEventListener('click', e => {
            if (e.target === e.currentTarget) closeModal('earningsModal');
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') { closeModal('portfolioModal'); closeModal('earningsModal'); }
        });
    }

    // ── Range-Buttons ─────────────────────────────────────────────────────────

    function syncOvRangeBtns() {
        ['ovRangeBtns', 'ovModalRangeBtns'].forEach(id =>
            document.querySelectorAll(`#${id} .ov-range-btn`).forEach(b =>
                b.classList.toggle('active', b.dataset.range === ovRange)));
    }

    function syncEarRangeBtns() {
        ['earningsRangeBtns', 'earModalRangeBtns'].forEach(id =>
            document.querySelectorAll(`#${id} .ov-range-btn`).forEach(b =>
                b.classList.toggle('active', b.dataset.range === earRange)));
    }

    function handleOvRangeClick(e) {
        const btn = e.target.closest('.ov-range-btn');
        if (!btn) return;
        e.stopPropagation();
        ovRange = btn.dataset.range;
        localStorage.setItem('ovChartRange', ovRange);
        syncOvRangeBtns();
        if (_lastData) renderCharts(_lastData);
        // Modal neu rendern falls offen
        const modal = document.getElementById('portfolioModal');
        if (modal && modal.style.display !== 'none') renderPortfolioModal();
    }

    function handleEarRangeClick(e) {
        const btn = e.target.closest('.ov-range-btn');
        if (!btn) return;
        e.stopPropagation();
        earRange = btn.dataset.range;
        localStorage.setItem('earChartRange', earRange);
        syncEarRangeBtns();
        if (_lastData) renderCharts(_lastData);
        // Modal neu rendern falls offen
        const modal = document.getElementById('earningsModal');
        if (modal && modal.style.display !== 'none') renderEarningsModal();
    }

    function initRangeButtons() {
        // Inline-Card Buttons
        document.getElementById('ovRangeBtns')?.addEventListener('click', handleOvRangeClick);
        document.getElementById('earningsRangeBtns')?.addEventListener('click', handleEarRangeClick);

        // Modal-Buttons (gleiche Handler, gleicher State)
        document.getElementById('ovModalRangeBtns')?.addEventListener('click', handleOvRangeClick);
        document.getElementById('earModalRangeBtns')?.addEventListener('click', handleEarRangeClick);

        // Initial aktive Buttons setzen
        syncOvRangeBtns();
        syncEarRangeBtns();
    }

    // ── Notifications ─────────────────────────────────────────────────────────

    function renderNotifs(data) {
        const liqLive = data?.liqLive;
        const lendLive = data?.lendLive;
        hub.feed(liqLive ?? null, lendLive ?? null);

        // Transiente Popup-Toasts für neue Bot-Events (silent). Das Brief-Icon
        // (Bell) führt jetzt ins Message Center – siehe initMessageBell().
        toast.update(hub.getAll().map(n => ({ ...n, pair: n.botLabel })));
    }

    // ── Tooltips (th[data-tooltip]) ───────────────────────────────────────────

    function initTooltips() {
        const tip = document.getElementById('fgt');
        if (!tip) return;

        document.addEventListener('mouseover', e => {
            const el = e.target.closest('[data-tooltip]');
            if (!el || !el.dataset.tooltip) { tip.style.display = 'none'; return; }
            const title = el.dataset.tooltipTitle ?? '';
            tip.innerHTML = (title ? `<div class="fgt-title">${title}</div>` : '') +
                            `<div class="fgt-body">${el.dataset.tooltip}</div>`;
            tip.style.display = 'block';
        });
        document.addEventListener('mousemove', e => {
            if (tip.style.display === 'none') return;
            const r = tip.getBoundingClientRect();
            let x = e.clientX + 14, y = e.clientY - 10;
            if (x + r.width  > window.innerWidth  - 8) x = e.clientX - r.width  - 14;
            if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 10;
            tip.style.left = x + 'px';
            tip.style.top  = y + 'px';
        });
        document.addEventListener('mouseout', e => {
            if (!e.target.closest('[data-tooltip]')) tip.style.display = 'none';
        });
    }

    // ── ResizeObserver ────────────────────────────────────────────────────────

    function initResizeObserver() {
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => { if (_lastData) renderCharts(_lastData); });
        const wrap = document.getElementById('overviewCharts');
        if (wrap) ro.observe(wrap);
    }

    // ── Haupt-Refresh ─────────────────────────────────────────────────────────

    async function refresh() {
        const [lendLive, liqLive, lendStatus, lendHist, liqHist] = await Promise.all([
            loadJSON('lending/data/data.json'),
            loadJSON('liquidity/data/data.json'),
            loadJSON('data/lendingbot-status.json'),
            loadJSON('lending/data/data-history.json'),
            loadJSON('liquidity/data/data-history.json'),
        ]);
        if (lendHist && lendLive) Object.assign(lendLive, lendHist);
        if (liqHist && liqLive) Object.assign(liqLive, liqHist);

        _lastData = { lendLive, liqLive, lendStatus };

        renderCharts(_lastData);
        renderTable(_lastData);
        renderNotifs(_lastData);
        // earningsToast pollt selbstständig via startPolling()

        // Last-Update
        // LendingBot: meta.exportedAt (ms) · Liquidity: timestamp (ISO-String)
        // botState kommt aus kv_config ('running'/'offline'), von bot.js beim SIGTERM-
        // Handler (bewusster Stop über bin/svc/systemctl) gesetzt. Sind BEIDE Bots
        // bewusst gestoppt (z.B. forge-pub2-Testbetrieb), zeigt der Header statt eines
        // irreführend "frischen" oder alarmierend roten Zeitstempels "Bots deaktiviert" –
        // sonst sieht ein bewusst abgeschalteter Zustand wie ein Fehler aus.
        const bothBotsDisabled = lendLive?.meta?.botState === 'offline'
                               && liqLive?.botState      === 'offline';
        const ts = lendLive?.meta?.exportedAt ?? liqLive?.timestamp ?? null;
        if (bothBotsDisabled) {
            setLastUpdate(null, { disabled: true });
        } else if (ts) {
            setLastUpdate(new Date(ts));
        } else {
            setLastUpdate(null);
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    initModals();
    initRangeButtons();
    initMessageBell();
    initTooltips();
    initResizeObserver();

    await refresh();
    setInterval(refresh, 60_000);

})();
