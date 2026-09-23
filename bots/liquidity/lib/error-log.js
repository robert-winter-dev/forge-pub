/**
 * FORGE Liquidity – Fehler-Logging für unbekannte On-Chain-Fehler
 *
 * Rohe Solana/Anchor-Fehlermeldungen (Program-Logs, Stack) sind für Nutzer in
 * Telegram/UI nicht lesbar und verwirren nur. Für erkannte Fehlertypen (Slippage,
 * Routing) gibt es bereits kurze, verständliche Texte. Für alle anderen Fälle
 * schreibt diese Funktion die volle Fehlermeldung in eine Logdatei und liefert
 * eine kurze Referenz (Datei + Uhrzeit) für die neutrale User-Meldung.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FORGE_TZ, todayTz } from '../../../core/config.js';
import { PATHS } from '../../../config/paths.js';

const LOG_DIR = join(PATHS.liquidityLogs, 'action-errors');

/**
 * @param {string} context  Kurzbeschreibung (z.B. "deposit openPosition MPLX/USDC")
 * @param {Error}  err
 * @returns {{file: string, time: string}}  Relativer Logpfad + Uhrzeit für die User-Meldung
 */
export function logActionError(context, err) {
    mkdirSync(LOG_DIR, { recursive: true });
    const dateStr = todayTz();
    const timeStr = new Intl.DateTimeFormat('de-DE', {
        timeZone: FORGE_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date());
    const relFile = `logs/action-errors/${dateStr}.log`;
    const detail = err?.stack || err?.message || String(err);
    appendFileSync(
        join(LOG_DIR, `${dateStr}.log`),
        `\n[${dateStr} ${timeStr}] ${context}\n${detail}\n`,
        'utf8',
    );
    return { file: relFile, time: timeStr };
}
