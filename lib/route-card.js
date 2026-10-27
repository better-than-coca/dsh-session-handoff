/**
 * Route card for a handed-off session.
 *
 * The child starts from one checkpoint and nothing else: the parent's raw
 * conversation is not copied into it. Whether the model may answer from the
 * checkpoint alone depends on how much was compressed into how little text, so
 * the card is graded by the measured compression ratio.
 */

import { sessionEvents } from './history.js';

/**
 * Trust line: at or below this ratio the checkpoint carried every fact the quiz
 * asked for (measured 28.6:1).
 */
export const TRUST_RATIO = 30;
/**
 * Hard line: above this ratio concrete values start colliding or vanishing
 * (measured 177:1 / 231:1 kept only topic words).
 */
export const STRONG_RATIO = 80;

/**
 * Count the checkpoint's own tokens, never the invisible ones.
 *
 * `usage.outputTokens` includes the reasoning block that never reaches the
 * checkpoint (a measured run reported 3312 while the text was 3041), so using it
 * raw understates the ratio and makes the card over-trust a skeleton summary.
 * The character fallback deliberately errs towards a HIGHER ratio: under-counting
 * tokens can only make the card more cautious.
 * @param text - checkpoint text.
 * @param usage - provider usage report, when available.
 * @returns estimated checkpoint token count, at least 1.
 */
export function summaryTokensOf(text, usage) {
    const chars = typeof text === 'string' ? text.length : 0;
    const reported = Number(usage?.outputTokens);
    const reasoning = Number(usage?.reasoningTokens);
    const textTokens = Number.isFinite(reported) && reported > 0
        ? reported - (Number.isFinite(reasoning) && reasoning > 0 ? reasoning : 0)
        : 0;
    if (textTokens > 0) return Math.round(textTokens);
    return Math.max(1, Math.round(chars / 2.6));
}

function summaryText(data) {
    const summary = data?.summary;
    if (Array.isArray(summary)) {
        return summary.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
    }
    return typeof summary === 'string' ? summary : '';
}

/**
 * Measure the newest checkpoint in a session log.
 * Kept for sessions compacted in place (the pre-0.3 fork path); a genuine
 * handoff child has no checkpoint of its own and passes stats in instead.
 * @param session - session whose own log is inspected.
 * @returns tokens/text of the summary and the input it replaced, or null.
 */
export function compressionStats(session) {
    const events = sessionEvents(session);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== 'compaction/summary') continue;
        const text = summaryText(event.data).trim();
        if (text === '') return null;
        const summaryTokens = summaryTokensOf(text, event.data?.usage);
        const shadowed = Number(event.data?.shadowedTokenCount ?? 0);
        return { chars: text.length, summaryTokens, shadowed, ratio: shadowed / summaryTokens };
    }
    return null;
}

/**
 * Build the first-turn route card for a legacy fork child.
 *
 * Sessions created by the pre-0.3 fork path copied the parent's events into
 * themselves, so their own log IS the archive. Telling such a session to read a
 * parent record would send it to a file that does not exist.
 * @param session - the forked session.
 * @returns Markdown-ish text for a plugin message.
 */
export function forkCard(session) {
    const stats = compressionStats(session);
    const lines = [
        '[dsh-session-handoff] 本会话是旧版 fork 出来的会话：父会话的原始事件已经复制进本会话自己的日志。'
    ];
    if (stats !== null) {
        lines.push('交接压缩比 ' + Math.round(stats.ratio) + ':1（' + stats.shadowed + ' tokens 压成 ' + stats.summaryTokens + ' tokens）；上下文里只有摘要 + 近期原文。');
    }
    lines.push('需要旧细节时调用 handoff_history({ query: "关键词" })——默认 source 就是本会话，原文在这里。');
    return lines.join('\n');
}

/**
 * Build the first-turn route card for a handed-off session.
 * @param session - the handed-off session.
 * @param stats - handoff measurement from the child's record; falls back to a
 *   checkpoint found in the session's own log.
 * @returns Markdown-ish text for a plugin message.
 */
export function routeCard(session, stats) {
    const resolved = stats === undefined || stats === null ? compressionStats(session) : stats;
    const parent = typeof resolved?.parentSession === 'string'
        ? resolved.parentSession
        : typeof session?.header?.parentSession === 'string' ? session.header.parentSession : undefined;
    const lines = [
        parent === undefined
            ? '[dsh-session-handoff] 本会话是从旧会话交接出来的新会话，上下文只有下面这份摘要。'
            : '[dsh-session-handoff] 本会话是从 session ' + parent + ' 交接出来的新会话，上下文只有下面这份摘要。',
        '旧会话的完整对话不在本会话里，仍原样保存在它的日志中，可以只读检索。'
    ];
    if (resolved === null) {
        lines.push('需要旧细节时调用 handoff_history({ query: "关键词", source: "parent" }) 检索原文。');
        return lines.join('\n');
    }
    const detail = Math.round(resolved.ratio) + ':1（' + resolved.shadowed + ' tokens 压成 ' + resolved.summaryTokens + ' tokens）';
    if (resolved.ratio > STRONG_RATIO) {
        lines.push('交接压缩比 ' + detail + '，摘要只剩骨架。');
        lines.push('硬性要求：函数名、常量值、错误码、文件路径这类具体事实，必须先 handoff_history({ query, source: "parent" }) 查到原文再回答，禁止凭记忆。');
    } else if (resolved.ratio > TRUST_RATIO) {
        lines.push('交接压缩比 ' + detail + '，摘要保住了大部分事实，但丢掉了「事实属于哪一条/哪一份」这类归属信息。');
        lines.push('具体事实可以照摘要直接回答；涉及出处归属、逐字引用、编号对应时，先用 handoff_history({ query, source: "parent" }) 核对。');
    } else {
        lines.push('交接压缩比 ' + detail + '，摘要保留了主要细节。');
        lines.push('摘要能直接回答的先答；只有涉及具体数值或原文措辞且不确定时，才用 handoff_history({ query, source: "parent" }) 核对。');
    }
    return lines.join('\n');
}
