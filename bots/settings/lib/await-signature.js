/**
 * Wartet per HTTP-Polling (getSignatureStatuses) auf die Bestätigung einer Signatur.
 *
 * Ersatz für `connection.confirmTransaction()` in forge-settings (CORE#000992): web3.js
 * bestätigt dort über eine WebSocket-Subscription direkt beim RPC-Anbieter, am Nexus
 * vorbei. Ist dessen Kontingent erschöpft, lehnt er den Verbindungsaufbau mit 429 ab —
 * und der WebSocket-Client von web3.js versucht es danach endlos weiter (~1×/s), auch
 * wenn confirmTransaction längst aufgegeben hat. Befund forge-pub2, 25.09.2026: ein
 * einziges Senden im Notbetrieb erzeugte 1,5 h lang Verbindungsversuche, bis zum
 * Neustart des Dienstes. getSignatureStatuses läuft über Nexus und ist auch im
 * Notbetrieb erlaubt (core/nexus/rpc-fallback.js).
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string} signature
 * @param {{ timeoutMs?: number, intervalMs?: number, commitment?: 'confirmed'|'finalized' }} [opts]
 * @returns {Promise<{ confirmed: boolean, err: object|null }>}  confirmed=false bei Timeout
 */
export async function awaitSignature(connection, signature, { timeoutMs = 60_000, intervalMs = 2_000, commitment = 'confirmed' } = {}) {
    const deadline = Date.now() + timeoutMs;
    const levels   = commitment === 'finalized' ? ['finalized'] : ['confirmed', 'finalized'];
    while (Date.now() < deadline) {
        try {
            const { value } = await connection.getSignatureStatuses([signature]);
            const st = value?.[0];
            if (st?.err)                                      return { confirmed: true, err: st.err };
            if (st && levels.includes(st.confirmationStatus)) return { confirmed: true, err: null };
        } catch {
            // Einzelner Lesefehler (Nexus-Neustart, 5xx) — beim nächsten Durchlauf erneut.
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return { confirmed: false, err: null };
}
