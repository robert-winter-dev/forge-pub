/**
 * ════════════════════════════════════════════════════════════════════════════
 *  FORGE Liquidity – Abgleich Kapitalflüsse On-Chain ↔ Datenbank
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  WOZU
 *  ────
 *  Eine Kapitalbewegung besteht aus zwei Schritten: die Transaktion geht on-chain,
 *  danach bucht der Bot sie in `transactions` + `positions`. Stirbt der Prozess
 *  zwischen beidem, ist das Kapital bewegt und die DB weiß nichts davon.
 *
 *  Genau das ist am 2026-08-15 passiert: Der Cleanup-Lauf um 08:05 starb mitten in
 *  `depositVolatilePair()` (`uncaughtException: failed to get signature status`),
 *  nachdem die increaseLiquidity-TX bereits gelandet war. Ergebnis: 131,65 USDC
 *  flossen in die Position, ohne dass eine Zeile davon in der DB stand.
 *
 *  Weil `FORGE/lib/pnl.js` den Kapital-Anker `cap` ausschließlich aus
 *  `transactions(deposit/withdraw)` mitzieht, blieb `cap` stehen, während `value`
 *  sprang — der volle Einzahlungsbetrag wurde als Gewinn ausgewiesen. Und zwar
 *  DAUERHAFT: der Versatz bleibt in der Kurve und wandert beim Close in `cumRealized`.
 *
 *  WARUM KEIN WRITE-AHEAD-JOURNAL
 *  ──────────────────────────────
 *  Naheliegend wäre, vor dem Senden einen "läuft gerade"-Eintrag zu schreiben. Das
 *  deckt aber nur die Abbrüche ab, die man vorher eingeplant hat, und es verteilt
 *  Zustand über einen weiteren Speicher. Die Signaturliste der Position-PDA ist
 *  dagegen die vollständige, vom Prozess unabhängige Wahrheit über JEDE
 *  Kapitalbewegung dieser Position — egal wie oder wo der Bot gestorben ist.
 *  Ein Mechanismus statt zweier, und er heilt auch Fälle, die es noch nicht gab.
 *
 *  METHODIK
 *  ────────
 *   1. Für jede Position (offen, oder in den letzten 24 h geschlossen) die
 *      Position-PDA aus dem NFT-Mint ableiten.
 *   2. `getSignaturesForAddress(PDA)` — enthält Open, jedes Increase/Decrease,
 *      jeden Fee-Claim und den Close. Fehlgeschlagene TX (err != null) fallen raus:
 *      sie haben nichts bewegt.
 *   3. Jede Signatur, die nicht in `transactions.tx_hash` steht, ist ein Kandidat.
 *   4. Richtung aus den VAULT-Deltas bestimmen (Token-Konten, deren `owner` die
 *      Whirlpool-Adresse ist): alle Deltas ≥ 0 und mindestens eines > 0 = Zufluss.
 *
 *  WAS AUTOMATISCH GEBUCHT WIRD — UND WAS NICHT
 *  ────────────────────────────────────────────
 *  NUR Zuflüsse (Wallet → Pool). Die sind eindeutig: ein Zufluss kann nur
 *  increaseLiquidity oder openPosition sein.
 *
 *  Abflüsse werden ausdrücklich NICHT gebucht, sondern gemeldet. `decreaseLiquidity`
 *  (echte Entnahme, PnL-neutral) und `collectFees` (verdienter Ertrag, PnL-wirksam)
 *  sehen on-chain gleich aus — beide nehmen Token aus dem Vault. Die Instruktion
 *  selbst ist nicht unterscheidbar: Orca loggt bei Increase/Decrease/Collect kein
 *  `Program log: Instruction:` (nachgeprüft am 2026-08-15 an sieben echten TX, es
 *  erscheint nur `TransferChecked` des Token-Programms). Ein Claim fälschlich als
 *  Entnahme zu buchen würde echten Gewinn aus dem PnL löschen — schlimmer als die
 *  Lücke, die dieser Abgleich schließt.
 *
 *  BEWERTUNG
 *  ─────────
 *  `usd_value` kommt aus dem Sprung in `position_snapshots` um die TX herum, NICHT
 *  aus einer eigenen Preisrechnung. Grund: `position_snapshots` IST die Wertreihe,
 *  gegen die `lib/pnl.js` rechnet. Wird `cap` um genau den dort beobachteten Sprung
 *  bewegt, ist das Ergebnis per Konstruktion konsistent — eine unabhängig
 *  hergeleitete Zahl könnte die beiden Reihen wieder auseinanderlaufen lassen.
 *  Gegenprobe am realen Fall: Preisrechnung 131,648 vs. Snapshot-Sprung 131,572,
 *  Abweichung 0,06 %.
 *
 *  Ohne brauchbare Klammer-Snapshots (siehe SNAPSHOT_MAX_GAP_MS) wird nicht
 *  gebucht, sondern gemeldet.
 *
 *  Alle Chain-Abfragen laufen über den `rpcLimiter` (Rate-Limit-Regel).
 * ════════════════════════════════════════════════════════════════════════════
 */

import { PublicKey } from '@solana/web3.js';
import { PDAUtil, ORCA_WHIRLPOOL_PROGRAM_ID } from '@orca-so/whirlpools-sdk';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { rpcLimiter } from './rate-limiter.js';
import { insertTransaction } from './db.js';
import { isLegBooked } from './chain-tx-log.js';
import { PATHS } from '../../../config/paths.js';
import * as notify from './notify.js';

/** Auch kürzlich geschlossene Positionen prüfen — ein Abbruch kurz vor dem Close
 *  wäre sonst für immer unsichtbar. */
const CLOSED_LOOKBACK_MS = 24 * 3600 * 1000;

/** Snapshots dürfen höchstens so weit von der TX entfernt liegen, damit ihr
 *  Sprung als Bewertung taugt. Der Bot schreibt alle ~5 Min einen. 12 Min lässt
 *  einen ausgefallenen Tick zu, ohne beliebige Kursdrift einzusammeln. */
const SNAPSHOT_MAX_GAP_MS = 12 * 60 * 1000;

/** Beträge darunter sind Staub und keine Buchung wert (Rundung, Fee-Reste). */
const MIN_BOOKABLE_USD = 0.5;

/** Wieviele Signaturen je Position maximal geholt werden. Eine Position lebt
 *  selten länger als ein paar Tage und sammelt dabei Open + Deposits + Claims. */
const SIG_LIMIT = 200;

/**
 * Rückfallebene für mehrteilige Vorgänge OHNE Leg-Vermerk.
 *
 * Ein logischer Vorgang kann aus MEHREREN On-Chain-Transaktionen bestehen, von denen
 * der Bot nur eine mit Hash bucht (Fee-Claim + decreaseLiquidity + Burn → eine
 * gemeinsame `close_position`-Zeile). Seit dem 2026-08-15 vermerkt der Bot diese
 * Legs beim Senden in `chain_tx_log`, und `isLegBooked()` (lib/chain-tx-log.js)
 * erklärt sie positionsgenau und ohne Zeitbezug. Dieses Fenster deckt nur noch ab,
 * was keinen Vermerk hat: Transaktionen von vor der Einführung und der
 * Emergency-Exit-Prozess (lib/emergency-withdraw.js), der bewusst nichts bucht —
 * dort ist eine Meldung nach dem Notfall auch die richtige Reaktion.
 *
 * Warum es als alleiniger Mechanismus nicht taugte: Es hält nur, solange ein Exit in
 * einem Durchlauf fertig wird. Am 2026-08-15 brach der Trailing-Stop-Exit auf
 * forge-pub1 nach dem Decrease an einem Orca-Stale-Read ab und wurde erst 5 Minuten
 * später fortgesetzt — das Fenster verfehlte den gebuchten Close um zwei Minuten und
 * meldete einen vollständig gebuchten Vorgang als Kapitallücke. Ein größeres Fenster
 * wäre die falsche Antwort gewesen: es verdeckt genau die Löcher, die dieser Abgleich
 * finden soll.
 *
 * Gilt bewusst NUR für Abflüsse. Zuflüsse (openPosition, increaseLiquidity) sind je
 * genau EINE Transaktion, die der Bot mit ihrem eigenen Hash bucht — dort bleibt der
 * Abgleich exakt über den Hash, ohne Toleranzfenster. Genau diese Strenge hat den
 * Vorfall vom 2026-08-15 sichtbar gemacht.
 */
const OUTFLOW_MATCH_WINDOW_MS = 3 * 60 * 1000;

/** Gemeldete Abflüsse merken: der Abgleich läuft stündlich und schaut 24 h zurück —
 *  ohne Gedächtnis würde derselbe Befund bis zu 24 Mal gemeldet. */
const SEEN_FILE = join(PATHS.liquidityData, 'capital-reconcile-seen.json');

function loadSeen() {
    if (!existsSync(SEEN_FILE)) return {};
    try { return JSON.parse(readFileSync(SEEN_FILE, 'utf8')); } catch { return {}; }
}

function saveSeen(seen) {
    // Einträge älter als der Rückblick können weg — sie können nicht mehr auftauchen.
    const cutoff = Date.now() - CLOSED_LOOKBACK_MS * 2;
    const pruned = Object.fromEntries(Object.entries(seen).filter(([, ts]) => ts > cutoff));
    try { writeFileSync(SEEN_FILE, JSON.stringify(pruned), 'utf8'); } catch { /* nicht kritisch */ }
}

/**
 * Token-Deltas der Vault-Konten (owner === Whirlpool-Adresse) einer Transaktion.
 * @returns {{ mint: string, delta: number }[]}
 */
function vaultDeltas(tx, whirlpoolAddress) {
    const key = b => `${b.owner}|${b.mint}`;
    const pre  = new Map((tx.meta?.preTokenBalances  ?? []).map(b => [key(b), b.uiTokenAmount.uiAmount ?? 0]));
    const post = new Map((tx.meta?.postTokenBalances ?? []).map(b => [key(b), b.uiTokenAmount.uiAmount ?? 0]));
    const out = [];
    for (const k of new Set([...pre.keys(), ...post.keys()])) {
        const [owner, mint] = k.split('|');
        if (owner !== whirlpoolAddress) continue;
        const delta = (post.get(k) ?? 0) - (pre.get(k) ?? 0);
        if (Math.abs(delta) > 1e-9) out.push({ mint, delta });
    }
    return out;
}

/** Wertsprung in position_snapshots um `ts` herum. null wenn keine brauchbare Klammer. */
function snapshotJump(db, poolId, ts) {
    const before = db.prepare(`
        SELECT recorded_at t, lp_value_usd + fees_pending_usd v FROM position_snapshots
         WHERE pool_id = ? AND recorded_at < ? AND lp_value_usd IS NOT NULL
         ORDER BY recorded_at DESC LIMIT 1
    `).get(poolId, ts);
    const after = db.prepare(`
        SELECT recorded_at t, lp_value_usd + fees_pending_usd v FROM position_snapshots
         WHERE pool_id = ? AND recorded_at > ? AND lp_value_usd IS NOT NULL
         ORDER BY recorded_at ASC LIMIT 1
    `).get(poolId, ts);
    if (!before || !after) return null;
    if (ts - before.t > SNAPSHOT_MAX_GAP_MS || after.t - ts > SNAPSHOT_MAX_GAP_MS) return null;
    return { usd: after.v - before.v, beforeAt: before.t, afterAt: after.t };
}

/**
 * Gleicht die Kapitalflüsse aller relevanten Positionen gegen die Chain ab.
 *
 * @param {import('better-sqlite3').Database} db  schreibend geöffnet
 * @param {object}   opts
 * @param {Map|object} opts.poolsById   Pool-Konfigurationen (id → pool)
 * @param {import('@solana/web3.js').Connection} opts.connection
 * @param {boolean}  [opts.dryRun=false]  nur berichten, nichts schreiben
 * @param {Function} [opts.log=console.log]
 * @returns {Promise<{ booked: object[], flagged: object[], checked: number }>}
 */
export async function reconcileCapitalFlows(db, { poolsById, connection, dryRun = false, log = console.log }) {
    const booked = [], flagged = [];
    const since = Date.now() - CLOSED_LOOKBACK_MS;

    const positions = db.prepare(`
        SELECT id, pool_id, nft_mint, opened_at, closed_at, open_tx
          FROM positions
         WHERE nft_mint IS NOT NULL AND (closed_at IS NULL OR closed_at > ?)
         ORDER BY opened_at ASC
    `).all(since);

    for (const pos of positions) {
        const pool = poolsById instanceof Map ? poolsById.get(pos.pool_id) : poolsById?.[pos.pool_id];
        if (!pool?.address) continue;

        let sigs;
        try {
            const pda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, new PublicKey(pos.nft_mint)).publicKey;
            await rpcLimiter.wait();
            sigs = await connection.getSignaturesForAddress(pda, { limit: SIG_LIMIT });
        } catch (err) {
            log(`[reconcile] ${pool.pair}: Signaturen nicht lesbar – übersprungen (${err.message})`);
            continue;
        }

        // Nur Signaturen aus der Laufzeit dieser Position, nur erfolgreiche.
        const endAt = pos.closed_at ?? Date.now();
        const relevant = sigs.filter(s =>
            s.err == null && s.blockTime != null &&
            s.blockTime * 1000 >= pos.opened_at - 60_000 &&
            s.blockTime * 1000 <= endAt + 60_000
        );

        for (const s of relevant) {
            const known = db.prepare(`SELECT 1 FROM transactions WHERE tx_hash = ? LIMIT 1`).get(s.signature);
            if (known) continue;

            const whenMs = s.blockTime * 1000;
            let tx;
            try {
                await rpcLimiter.wait();
                tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
            } catch (err) {
                log(`[reconcile] ${pool.pair}: TX ${s.signature.slice(0, 12)}… nicht lesbar (${err.message})`);
                continue;
            }
            if (!tx?.meta) continue;

            const deltas = vaultDeltas(tx, pool.address);
            if (deltas.length === 0) continue;   // berührt die Vaults nicht (z.B. reine Metadaten-TX)

            const isInflow = deltas.every(d => d.delta >= 0);
            const flag = (reason) => {
                log(`[reconcile] ⚠ ${pool.pair}: ${s.signature.slice(0, 12)}… nicht gebucht – ${reason}`);
                flagged.push({ poolId: pool.id, pair: pool.displayPair ?? pool.pair, txHash: s.signature, whenMs, reason });
            };

            if (!isInflow) {
                // Mehrteiliger Vorgang, sauberer Weg: Der Bot vermerkt jedes Leg, das
                // bewusst keine eigene Buchung bekommt, beim Senden in `chain_tx_log`.
                // `isLegBooked()` erklärt es erst, wenn der Vorgang auch gebucht wurde —
                // stirbt der Bot dazwischen, wird weiterhin gemeldet (lib/chain-tx-log.js).
                if (isLegBooked(db, s.signature)) continue;

                // Fallback für Legs ohne Vermerk (TX von vor der Einführung des Logs,
                // Emergency-Exit-Prozess): Ein Close besteht aus decreaseLiquidity + Burn,
                // gebucht wird nur eine der beiden (siehe OUTFLOW_MATCH_WINDOW_MS).
                const explained = db.prepare(`
                    SELECT 1 FROM transactions
                     WHERE pool_id = ?
                       AND type IN ('close_position','withdraw','withdraw_full','claim','rebalance')
                       AND created_at BETWEEN ? AND ?
                     LIMIT 1
                `).get(pool.id, whenMs - OUTFLOW_MATCH_WINDOW_MS, whenMs + OUTFLOW_MATCH_WINDOW_MS);
                if (explained) continue;

                // Abfluss: decreaseLiquidity und collectFees sind on-chain nicht
                // unterscheidbar (siehe Dateikopf). Nicht raten.
                flag('Abfluss aus dem Pool – Entnahme und Fee-Claim sind on-chain nicht unterscheidbar, bitte manuell zuordnen');
                continue;
            }

            const jump = snapshotJump(db, pool.id, whenMs);
            if (!jump) {
                flag('kein Snapshot-Paar eng genug um die TX – Wert nicht belastbar bestimmbar');
                continue;
            }
            if (jump.usd <= 0) {
                // Zufluss on-chain, aber der Positionswert ist nicht gestiegen —
                // die beiden Quellen widersprechen sich, das muss ein Mensch ansehen.
                flag(`Zufluss on-chain, aber Wertsprung ${jump.usd.toFixed(2)} USDC – widersprüchlich`);
                continue;
            }
            if (jump.usd < MIN_BOOKABLE_USD) continue;   // Staub

            const amountA = deltas.find(d => d.mint === pool.tokenA)?.delta ?? 0;
            const amountB = deltas.find(d => d.mint === pool.tokenB)?.delta ?? 0;

            log(`[reconcile] ${pool.pair}: nicht gebuchte Einzahlung gefunden – ` +
                `${jump.usd.toFixed(2)} USDC vom ${new Date(whenMs).toLocaleString('de-DE')} (${s.signature})`);

            if (dryRun) {
                booked.push({ poolId: pool.id, txHash: s.signature, usdValue: jump.usd, whenMs, dryRun: true });
                continue;
            }

            db.transaction(() => {
                insertTransaction(db, {
                    poolId:   pool.id,
                    type:     'deposit',
                    amountA,
                    amountB,
                    usdValue: jump.usd,
                    txHash:   s.signature,
                    txFeeSol: (tx.meta.fee ?? 0) / 1e9,
                    note:     'nachgetragen (Abgleich on-chain ↔ DB)',
                    // Echter blockTime, NICHT "jetzt": lib/pnl.js rollt `cap` entlang der
                    // Snapshot-Zeitachse — ein falscher Zeitpunkt ließe die Kurve zwischen
                    // TX und Nachtrag weiterhin den Phantomgewinn zeigen.
                    createdAt: whenMs,
                });
                db.prepare(`
                    UPDATE positions
                       SET capital_usdc = capital_usdc + ?,
                           hodl_token_a = hodl_token_a + ?,
                           hodl_token_b = hodl_token_b + ?
                     WHERE id = ?
                `).run(jump.usd, amountA, amountB, pos.id);
            })();

            booked.push({ poolId: pool.id, txHash: s.signature, usdValue: jump.usd, whenMs });
            await notify.capitalFlowRecovered(pool, { usdValue: jump.usd, txHash: s.signature, whenMs });
        }
    }

    // Nur beim ERSTEN Auftauchen melden — der Abgleich läuft stündlich über dasselbe
    // 24-h-Fenster, ein Befund würde sonst bis zu 24 Mal die gleiche Meldung erzeugen.
    if (!dryRun && flagged.length) {
        const seen = loadSeen();
        for (const f of flagged) {
            if (seen[f.txHash]) continue;
            seen[f.txHash] = Date.now();
            const pool = poolsById instanceof Map ? poolsById.get(f.poolId) : poolsById?.[f.poolId];
            if (pool) await notify.capitalFlowNeedsReview(pool, { txHash: f.txHash, whenMs: f.whenMs, reason: f.reason });
        }
        saveSeen(seen);
    }

    return { booked, flagged, checked: positions.length };
}
