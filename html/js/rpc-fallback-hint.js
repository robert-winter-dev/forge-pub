/**
 * FORGE – Hinweis im Senden-Reiter, solange der Nexus im Notbetrieb läuft (CORE#000992).
 *
 * Im Notbetrieb (Helius-Kontingent erschöpft) gehen Wallet-Sendungen über den
 * öffentlichen Solana-RPC. Das klappt, die Bestätigung kann aber länger dauern. Der
 * Hinweis sagt das vorab, damit eine langsame Bestätigung nicht wie ein Fehler aussieht.
 *
 * Genutzt von bots/settings/html/js/bot-liquidity.js (Liquidity- und Premium-Wallet) und
 * bot-lending.js. Ein Modul statt zweier Kopien, wie scam-tab.js.
 */
import { t as tr } from '/forge/js/i18n.js?v=20260811a';

/**
 * Fragt den Notbetrieb ab und setzt bei Bedarf den Hinweis an den Anfang von `container`.
 * Ein Fehler beim Abruf zeigt schlicht nichts an: der Hinweis ist Zusatzinformation.
 *
 * @param {HTMLElement|null} container  z. B. #wm-send im Wallet-Modal
 */
export async function showFallbackSendHint(container) {
    if (!container) return;
    try {
        const r = await fetch('/api/wallet/rpc-status');
        if (!r.ok) return;
        const { fallbackActive } = await r.json();
        if (!fallbackActive || container.querySelector('.rpc-fallback-hint')) return;
        const p = document.createElement('p');
        p.className   = 'modal-hint rpc-fallback-hint';
        p.textContent = '⚠️ ' + tr('wallet.fallback_send_hint',
            'Notbetrieb: Das Helius-Kontingent ist erschöpft. Senden läuft über den öffentlichen Solana-RPC, die Bestätigung kann länger dauern.');
        container.prepend(p);
    } catch { /* Hinweis ist optional */ }
}
