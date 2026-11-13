// Builds the JSON body for Telegram sendMessage (CORE#001859).
// TELEGRAM_THREAD_ID is optional: empty = message goes to the chat itself (as before);
// set (e.g. "6") = message goes into that topic of a forum group via message_thread_id.

/** @returns {number|undefined} numeric thread id, undefined if unset/invalid */
export function parseThreadId(raw) {
    const s = String(raw ?? '').trim();
    if (!/^\d+$/.test(s)) return undefined;
    const n = Number(s);
    return n > 0 ? n : undefined;
}

export function buildSendMessageBody({ chatId, threadId, text, extra = {} }) {
    const body = { chat_id: chatId, text, ...extra };
    const tid = parseThreadId(threadId);
    if (tid !== undefined) body.message_thread_id = tid;
    return body;
}

/**
 * Parses "backup:8,skopos:9" into a Map botId -> thread id (DEVOPS#001864).
 * Invalid entries are skipped.
 * @returns {Map<string, number>}
 */
export function parseThreadMap(raw) {
    const map = new Map();
    for (const part of String(raw ?? '').split(',')) {
        const [bot, tid] = part.split(':').map(s => s.trim());
        const n = parseThreadId(tid);
        if (bot && n !== undefined) map.set(bot, n);
    }
    return map;
}

/** Thread for a bot: per-bot mapping wins, otherwise the global default (may be undefined). */
export function resolveThreadId(botId, threadMap, defaultThreadId) {
    return threadMap.get(botId) ?? defaultThreadId;
}

/**
 * Title line of a Telegram message (DEVOPS#001871): bold in Telegram legacy Markdown (`*x*`),
 * at most one icon (the warning sign, only when `warn`). If the text contains Markdown control
 * characters it stays plain, so the message can never fail to parse because of the title.
 */
export function tgTitle(text, warn = false) {
    const t = `${warn ? '⚠ ' : ''}${text}`;
    return /[*_`\[]/.test(t) ? t : `*${t}*`;
}
