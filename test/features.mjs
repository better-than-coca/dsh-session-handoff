
import { compressionStats, forkCard, routeCard, STRONG_RATIO, TRUST_RATIO } from '../lib/route-card.js';
import { HandoffSummaryEngine, identifierIndex, shadowedText } from '../lib/summary-engine.js';
import { isFirstConversation } from '../lib/index.js';

let failures = 0;
const check = (name, cond, detail) => {
    if (cond) { console.log('PASS ' + name); return; }
    failures += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
};

function sessionWith(shadowed, summaryTokens) {
    const text = 'x'.repeat(summaryTokens * 3);
    return {
        id: 'session-child',
        header: { isSeeded: true, parentSession: 'session-parent' },
        events: [
            { seq: 0, type: 'user/message', data: { content: [] } },
            { seq: 1, type: 'compaction/summary', data: { shadowedTokenCount: shadowed, usage: { outputTokens: summaryTokens }, summary: [{ type: 'text', text }] } },
            { seq: 2, type: 'compaction/end', data: {} }
        ],
        snapshotEvents() { return this.events; }
    };
}

// --- compressionStats ---
const low = compressionStats(sessionWith(70000, 2450));   // 28.6:1
check('stats: low ratio computed', low !== null && low.ratio < STRONG_RATIO, JSON.stringify(low));
const high = compressionStats(sessionWith(570000, 2469)); // 231:1
check('stats: high ratio computed', high !== null && high.ratio > STRONG_RATIO, JSON.stringify(high));
const mid = compressionStats(sessionWith(130365, 2134)); // 61:1 — measured as骨架
check('stats: 61:1 lands in the middle band', mid !== null && mid.ratio > TRUST_RATIO && mid.ratio < STRONG_RATIO && Math.round(mid.ratio) === 61, JSON.stringify(mid));
check('stats: 29:1 stays trusted', low.ratio < STRONG_RATIO);
const fallback = compressionStats({ events: [{ seq: 0, type: 'compaction/summary', data: { summary: [{ type: 'text', text: 'x'.repeat(2600) }] } }], snapshotEvents() { return this.events; } });
check('stats: char fallback used without usage', fallback !== null && fallback.summaryTokens === 1000, JSON.stringify(fallback));
check('stats: empty log -> null', compressionStats({ events: [], snapshotEvents() { return []; } }) === null);
check('stats: no checkpoint -> null', compressionStats({ events: [{ seq: 0, type: 'user/message', data: {} }], snapshotEvents() { return this.events; } }) === null);

// --- routeCard branches ---
const weak = routeCard(sessionWith(570000, 2469));
check('card: high ratio demands retrieval', weak.includes('硬性要求') && weak.includes('handoff_history'), weak.slice(0, 160));
const midCard = routeCard(sessionWith(130365, 2134));
check('card: middle band keeps facts, questions attribution', midCard.includes('归属') && !midCard.includes('硬性要求'), midCard.slice(0, 200));
check('card: high ratio mentions parent', weak.includes('session-parent'));
const mild = routeCard(sessionWith(70000, 2450));
check('card: low ratio permits summary first', mild.includes('摘要能直接回答') && !mild.includes('硬性要求'), mild.slice(0, 160));
const none = routeCard({ header: {}, events: [], snapshotEvents() { return []; } });
check('card: unknown stats falls back to retrieval', none.includes('handoff_history') && none.includes('source: "parent"'), none.slice(0, 160));
const fromRecord = routeCard({ header: {}, events: [], snapshotEvents() { return []; } }, { shadowed: 415197, summaryTokens: 3041, ratio: 415197 / 3041 });
check('card: uses handoff record stats when given', fromRecord.includes('137:1') && fromRecord.includes('硬性要求'), fromRecord.slice(0, 200));
check('card: points retrieval at the parent archive', fromRecord.includes('source: "parent"'), fromRecord.slice(0, 200));
check('card: no longer claims the log is in this session', !fromRecord.includes('本会话自己的日志'), fromRecord.slice(0, 200));

// --- legacy fork card: the raw events really are in the child's own log ---
const fork = forkCard(sessionWith(415197, 3041));
check('fork card: points at this session log', fork.includes('本会话自己的日志') && fork.includes('handoff_history'), fork.slice(0, 200));
check('fork card: never sends a fork child to a parent record', !fork.includes('source: "parent"'), fork.slice(0, 200));
check('fork card: keeps the measured ratio', fork.includes('137:1'), fork.slice(0, 200));

// --- summary engine ---
const seen = [];
const ctx = {
    llm: {
        async *stream(options) {
            seen.push(options);
            yield { type: 'text', text: '## Exact Facts\n- SessionCreateError' };
        }
    }
};
const engine = new HandoffSummaryEngine(ctx, { maxTokens: 12288, auto: false });
const agent = {
    session: { id: 'session-x', requestHeader: () => ({ config: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'high' } }) },
    options: {}
};
const result = await engine.summarize({ messages: [{ role: 'user', content: [] }], system: { text: 'sys' }, tools: [{ name: 't' }] }, agent, undefined);
check('engine: returns summary text blocks', Array.isArray(result.summary) && result.summary[0].text.includes('SessionCreateError'), JSON.stringify(result.summary));
check('engine: marks llmStreamCall', result.llmStreamCall === true);
check('engine: routes to durable model', result.provider === 'commandcode' && result.model === 'deepseek/deepseek-v4.1-flash');
check('engine: forwards maxTokens', result.maxTokens === 12288 && seen[0].maxTokens === 12288);
check('engine: inherits request controls', seen[0].reasoningEffort === 'high');
check('engine: appends instruction as last message', seen[0].messages.length === 2 && seen[0].messages[1].content[0].text.includes('Exact Facts'));
check('engine: instruction source is producer-owned', seen[0].messages[1].source.kind.startsWith('plugin:'), seen[0].messages[1].source.kind);
check('engine: purpose is compaction', seen[0].purpose === 'compaction');

// --- engine failure modes ---
const noLlmCtx = { llm: { async *stream() { yield { type: 'text', text: '' }; } } };
const engine2 = new HandoffSummaryEngine(noLlmCtx, { maxTokens: 8192 });
let threw = false;
try { await engine2.summarize({ messages: [] }, agent, undefined); } catch { threw = true; }
check('engine: empty text throws', threw);

// --- first-conversation detection: where a parked checkpoint may land ---
const ev = (seq, type, extra = {}) => ({ seq, type, data: extra });
check('first conversation: empty log counts', isFirstConversation({ events: [], snapshotEvents() { return this.events; } }) === false);
const fresh = { events: [ev(0, 'user/message', { source: { kind: 'user' } })], snapshotEvents() { return this.events; } };
const T1 = { turn: 1, step: 1 };
check('first conversation: one prompt, no reply', isFirstConversation(fresh, T1) === true);
const replied = { events: [ev(0, 'user/message', { source: { kind: 'user' } }), ev(1, 'assistant/message', {})], snapshotEvents() { return this.events; } };
check('first conversation: an existing reply disqualifies it', isFirstConversation(replied, T1) === false);
const twoPrompts = { events: [ev(0, 'user/message', { source: { kind: 'user' } }), ev(1, 'user/message', { source: { kind: 'user' } })], snapshotEvents() { return this.events; } };
check('first conversation: two prompts disqualify it', isFirstConversation(twoPrompts, T1) === false);
const injectedOnly = { events: [ev(0, 'user/message', { source: { kind: 'plugin:x' } })], snapshotEvents() { return this.events; } };
check('first conversation: injected notices do not count as prompts', isFirstConversation(injectedOnly, T1) === true);
check('first conversation: unreadable session is never "new"', isFirstConversation({ snapshotEvents() { return []; } }, T1) === false);
// Regression (2026-10-27): the host appends the submitted prompt to the durable log
// only after the first pre-step resolves, so a brand-new conversation shows just
// turn/start + step/start + system turns at that moment (verified against a real log).
const beforePrompt = { events: [ev(0, 'turn/start', { turn: 1 }), ev(1, 'step/start', { turn: 1, step: 1 }), ev(2, 'system/message', {})], snapshotEvents() { return this.events; } };
check('first conversation: prompt not yet logged still counts at turn 1', isFirstConversation(beforePrompt, T1) === true);
check('first conversation: a later turn is never new', isFirstConversation(beforePrompt, { turn: 2, step: 1 }) === false);

// --- ratio accounting: hidden reasoning must not inflate fidelity ---
function sessionWithUsage(shadowed, usage, textLen) {
    return {
        id: 'session-usage',
        header: { isSeeded: true },
        events: [{ seq: 0, type: 'compaction/summary', data: { shadowedTokenCount: shadowed, usage, summary: [{ type: 'text', text: 'x'.repeat(textLen) }] } }],
        snapshotEvents() { return this.events; }
    };
}
// The measured 2026-10-27 desktop handoff: 415197 shadowed, 3312 reported output
// of which 271 was hidden reasoning, 7215 characters of checkpoint.
const measured = compressionStats(sessionWithUsage(415197, { outputTokens: 3312, reasoningTokens: 271 }, 7215));
check('stats: subtracts hidden reasoning tokens', measured !== null && measured.summaryTokens === 3041, JSON.stringify(measured));
check('stats: measured handoff reads 137:1 not 125:1', measured !== null && Math.round(measured.ratio) === 137, JSON.stringify(measured));
const noReasoningField = compressionStats(sessionWithUsage(100000, { outputTokens: 1000 }, 3000));
check('stats: uses output tokens when reasoning is absent', noReasoningField !== null && noReasoningField.summaryTokens === 1000, JSON.stringify(noReasoningField));
const zeroReasoning = compressionStats(sessionWithUsage(100000, { outputTokens: 1000, reasoningTokens: 0 }, 3000));
check('stats: zero reasoningTokens keeps output tokens', zeroReasoning !== null && zeroReasoning.summaryTokens === 1000, JSON.stringify(zeroReasoning));
const reasoningOverflow = compressionStats(sessionWithUsage(100000, { outputTokens: 500, reasoningTokens: 500 }, 3000));
check('stats: reasoning >= output falls back to chars', reasoningOverflow !== null && reasoningOverflow.summaryTokens > 500, JSON.stringify(reasoningOverflow));

// --- deterministic identifier index ---
const span = 'edited E:\\dsh\\dsh-session-handoff\\lib\\route-card.js with TRUST_RATIO=30 and `askRatio`, see usage.outputTokens';
// Recurrence is the filter: a name has to show up twice to earn a slot.
const spanTwice = span + '\n' + span;
const idx = identifierIndex(spanTwice, '## Exact Facts\n- changed the ratio maths');
check('index: carries the dropped path', idx.includes('route-card.js'), idx);
check('index: carries the dropped constant', idx.includes('TRUST_RATIO'), idx);
check('index: carries the dropped member', idx.includes('usage.outputTokens'), idx);
check('index: carries the inline code span', idx.includes('askRatio'), idx);
check('index: is a headed markdown section', idx.startsWith('\n## Identifier Index'), idx.slice(0, 60));
check('index: empty when the checkpoint covers everything', identifierIndex(spanTwice, spanTwice) === '', identifierIndex(spanTwice, spanTwice));
check('index: one-off identifiers are skipped', identifierIndex(span, 'nothing') === '', identifierIndex(span, 'nothing'));
const sessionPath = 'C:\\Users\\camellia\\.dsh\\sessions\\session-98f2f9b0-fc27-4737-9665-fe38004047b9\\session.v4.jsonl.zstd';
check('index: session-id paths are skipped', identifierIndex(sessionPath + ' ' + sessionPath, 'nothing') === '', identifierIndex(sessionPath + ' ' + sessionPath, 'nothing'));
const tempPath = 'C:\\Users\\camellia\\AppData\\Local\\Temp\\dsh-subprocess-31644\\stdout.log';
check('index: temp paths are skipped', identifierIndex(tempPath + ' ' + tempPath, 'nothing') === '', identifierIndex(tempPath + ' ' + tempPath, 'nothing'));
const longPath = 'C:\\Users\\camellia\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai\\dsh-token-meter';
check('index: npx cache paths are skipped', identifierIndex(longPath + ' ' + longPath, 'nothing') === '', identifierIndex(longPath + ' ' + longPath, 'nothing'));
const capped = identifierIndex(
    Array.from({ length: 40 }, (_, n) => 'CONST_NUMBER_' + n + ' CONST_NUMBER_' + n).join(' '),
    'nothing'
);
check('index: hard cap keeps the appendix small', capped.split('\n').filter((l) => l.startsWith('- ')).length === 24, capped.split('\n').length);
check('index: empty for an empty span', identifierIndex('', 'anything') === '');
check('index: ignores noise identifiers', identifierIndex('require("example.com") and console.log', 'nothing') === '', identifierIndex('require("example.com") and console.log', 'nothing'));
check('shadowedText: flattens nested messages', shadowedText([{ role: 'user', content: [{ type: 'text', text: 'needle-xyz' }] }]).includes('needle-xyz'));

// --- engine wiring for the index ---
const idxAgent = { session: { id: 'session-idx', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {} };
const idxCtx = { llm: { async *stream() { yield { type: 'text', text: '## Exact Facts\n- changed the ratio maths' }; } } };
const idxEngine = new HandoffSummaryEngine(idxCtx, { maxTokens: 8192 });
const idxResult = await idxEngine.summarize({ messages: [{ role: 'user', content: [{ type: 'text', text: spanTwice }] }] }, idxAgent, undefined);
check('engine: appends the index as a second block', Array.isArray(idxResult.summary) && idxResult.summary.length === 2, JSON.stringify(idxResult.summary.map((b) => b.text?.slice(0, 30))));
check('engine: keeps the model checkpoint as block one', idxResult.summary[0].text.includes('ratio maths'));
check('engine: index block names the dropped constant', idxResult.summary[1].text.includes('TRUST_RATIO'));

const covCtx = { llm: { async *stream() { yield { type: 'text', text: spanTwice }; } } };
const covEngine = new HandoffSummaryEngine(covCtx, { maxTokens: 8192 });
const covResult = await covEngine.summarize({ messages: [{ role: 'user', content: [{ type: 'text', text: spanTwice }] }] }, idxAgent, undefined);
check('engine: no index block when nothing was dropped', covResult.summary.length === 1, JSON.stringify(covResult.summary.length));

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);