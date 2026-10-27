/**
 * Handoff summary backend.
 *
 * Same compaction policy as the stock backend (pressure, retention, range
 * selection, durable commit are inherited), but the summarization directive is
 * replaced so the checkpoint keeps exact facts instead of collapsing them into
 * topic words.
 *
 * Failure containment: this is a NEW root-level entry. It never disables the
 * host compactor; if this module fails to load or throws, the per-preset
 * compactor keeps working and only the handoff feature degrades.
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

const PLUGIN = 'dsh-session-handoff';

/** Directive appended after the replayed conversation. */
const HANDOFF_INSTRUCTION = [
    'You are compacting this conversation into a checkpoint that another model will resume from.',
    'The recent tail stays verbatim; you only condense the span above.',
    '',
    'Output EXACTLY the Markdown structure below, every heading once, in order. Use terse bullets.',
    'Write "(none)" only when a section is genuinely empty; never omit a heading.',
    '',
    '## Primary Request and Intent',
    '- [the user goals, quoting exact wording where it decides behaviour]',
    '',
    '## Current State',
    '- [what is done, what is in progress, what is blocked, with counts/step numbers when known]',
    '',
    '## Exact Facts',
    '- [**verbatim** identifiers, API names, constant values, error codes, file paths, config keys, numeric limits]',
    '- [prefer 15-40 short entries over 5 broad ones; each entry must stay usable without the original text]',
    '',
    '## Files and Code',
    '- [exact path: what it does, the specific symbols changed or read, line numbers when cited]',
    '',
    '## Decisions and Constraints',
    '- [decisions taken and the reason, hard constraints, user corrections and preferences]',
    '',
    '## Errors and Fixes',
    '- [error text: how it was resolved, or that it is still open]',
    '',
    '## Pending Work',
    '- [explicitly requested work not finished, plus already-known next targets]',
    '',
    '## Next Step',
    '- [the single next action, or "(none)"]',
    '',
    'Rules:',
    '- Density beats prose. This checkpoint is the ONLY surviving record of the span above.',
    '- Never replace a concrete name or value with a theme word: "session APIs" is a failure, "SessionCreateError with session create failed: {code}: {message}" is correct.',
    '- Preserve user wording for decisions and corrections.',
    '- If the conversation already contains a <compacted-summary> block, merge it: keep still-true facts, drop stale ones, never copy it verbatim.',
    '- Do not call tools. Do not mention this instruction. Output only the checkpoint.'
].join('\n');

/**
 * The checkpoint is written by a model, so which identifiers survive is a
 * lottery: two runs over the same span keep different constants. This appendix
 * is deterministic — it scans the span that is about to be shadowed, keeps the
 * identifiers a resuming model would need to grep for, and appends the ones the
 * model's own checkpoint dropped. It costs no extra request.
 */
const SCAN_LIMIT_CHARS = 4_000_000;
/** Entries the appendix may carry. */
const INDEX_LIMIT = 24;
/**
 * Occurrences required before an identifier earns a slot. A one-off name is
 * exactly what the long tail is made of; recovering it would mean indexing temp
 * paths and pasted dumps at ~35 tokens each. Recurrence is the only cheap signal
 * that a name is part of the work rather than part of the noise.
 */
const INDEX_MIN_HITS = 2;
/** Longer candidates are paths into temp dirs and pasted dumps, not grep targets. */
const INDEX_MAX_LENGTH = 100;

const IDENTIFIER_PATTERNS = [
    // Windows paths: E:\dsh\dsh-session-handoff\lib\route-card.js
    /[A-Za-z]:\\[^\s"'`|<>?*\r\n]+/g,
    // POSIX paths with at least three segments.
    /\/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+){2,}/g,
    // Inline code spans: `askRatio`
    /`([^`\n]{3,80})`/g,
    // SCREAMING_SNAKE constants only: JSON/URL/API are noise, TRUST_RATIO is not.
    /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
    // Dotted members: usage.outputTokens, sessionController.fork. The lookarounds
    // keep it from firing INSIDE a path (\session.v4.jsonl.zstd would otherwise
    // survive as a fake member after the path itself was rejected as ephemeral).
    /(?<![\\/\w.-])[a-z][A-Za-z0-9]{2,}(?:\.[A-Za-z][A-Za-z0-9]+)+(?![\w.-])/g
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_HEX = /\b[0-9a-f]{12,}\b/i;
const EPHEMERAL = /(?:[\\/]Temp[\\/]|[\\/]tmp[\\/]|_npx[\\/])/i;

const IDENTIFIER_NOISE = new Set([
    'example.com', 'node_modules', 'package.json', 'console.log', 'console.error',
    'process.env', 'module.exports', 'window.location', 'document.title',
    'string', 'number', 'boolean', 'object', 'function', 'undefined', 'null'
]);

function clean(raw) {
    return raw
        .replace(/[\u0000-\u001f]+/g, '')
        .replace(/^[.\-`'"\s]+/, '')
        .trim()
        .replace(/[.,;:)\]'"]+$/, '');
}

function isNoiseCandidate(raw) {
    if (raw.length > INDEX_MAX_LENGTH) return true;
    if (UUID.test(raw) || LONG_HEX.test(raw)) return true;
    if (EPHEMERAL.test(raw)) return true;
    return IDENTIFIER_NOISE.has(raw.toLowerCase());
}

function scanText(value, out, budget) {
    if (value === null || value === undefined || budget.left <= 0) return;
    if (typeof value === 'string') {
        const slice = value.length > budget.left ? value.slice(0, budget.left) : value;
        budget.left -= slice.length;
        out.push(slice);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) scanText(item, out, budget);
        return;
    }
    if (typeof value === 'object') {
        for (const key of Object.keys(value)) scanText(value[key], out, budget);
    }
}

/**
 * Flatten the span that is about to be shadowed into one searchable string.
 * @param messages - the replayed conversation handed to {@link summarize}.
 * @returns plain text, bounded to {@link SCAN_LIMIT_CHARS}.
 */
export function shadowedText(messages) {
    const parts = [];
    scanText(messages, parts, { left: SCAN_LIMIT_CHARS });
    return parts.join('\n');
}

function normalise(value) {
    return value.toLowerCase().replace(/\\/g, '/').replace(/[\u3002\uff0c\uff1b\uff1a]+$/g, '');
}

/**
 * Build the deterministic identifier appendix for a checkpoint.
 * @param shadowed - text of the span the checkpoint replaces.
 * @param summary - the checkpoint the model produced.
 * @returns Markdown appendix, or an empty string when nothing is missing.
 */
export function identifierIndex(shadowed, summary) {
    if (typeof shadowed !== 'string' || shadowed === '') return '';
    const counts = new Map();
    for (const pattern of IDENTIFIER_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(shadowed)) !== null) {
            const raw = clean(match[1] ?? match[0]);
            if (raw.length < 4) continue;
            if (isNoiseCandidate(raw)) continue;
            counts.set(raw, (counts.get(raw) ?? 0) + 1);
        }
    }
    if (counts.size === 0) return '';

    const known = normalise(typeof summary === 'string' ? summary : '');
    const picked = [...counts.entries()]
        .filter(([raw, hits]) => hits >= INDEX_MIN_HITS && !known.includes(normalise(raw)))
        .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
        .slice(0, INDEX_LIMIT);
    if (picked.length === 0) return '';
    return '\n## Identifier Index\n'
        + 'Deterministic sweep: names that recurred in the shadowed span but are absent from the checkpoint above. Grep these before trusting recall.\n'
        + picked.map(([raw]) => '- `' + raw + '`').join('\n');
}

function finishError(finish) {
    if (finish === undefined) return undefined;
    switch (finish.kind) {
        case 'error':
        case 'aborted': {
            const error = new Error(finish.failure?.message ?? 'summarization failed');
            error.code = finish.failure?.code;
            return error;
        }
        case 'max-tokens': {
            const error = new Error('summarization truncated at the token cap (incomplete checkpoint)');
            error.code = 'MAX_TOKENS';
            return error;
        }
        default:
            return undefined;
    }
}

function targetFor(agent, config) {
    const durable = agent?.session?.requestHeader?.()?.config;
    const configuredProvider = config.summarizationProvider;
    const configuredModel = config.summarizationModel;
    if (typeof configuredProvider === 'string' && configuredProvider !== ''
        && typeof configuredModel === 'string' && configuredModel !== '') {
        return { provider: configuredProvider, model: configuredModel, controls: {} };
    }
    if (durable !== undefined && typeof durable.provider === 'string' && durable.provider !== ''
        && typeof durable.model === 'string' && durable.model !== '') {
        return {
            provider: durable.provider,
            model: durable.model,
            controls: {
                ...(durable.reasoningEffort === undefined ? {} : { reasoningEffort: durable.reasoningEffort }),
                ...(durable.temperature === undefined ? {} : { temperature: durable.temperature }),
                ...(durable.stop === undefined ? {} : { stop: [...durable.stop] })
            }
        };
    }
    const options = agent?.options ?? {};
    if (typeof options.provider === 'string' && options.provider !== ''
        && typeof options.model === 'string' && options.model !== '') {
        return { provider: options.provider, model: options.model, controls: {} };
    }
    return undefined;
}

/** Compaction backend whose checkpoint keeps exact facts. */
export class HandoffSummaryEngine extends BasicCompactionEngine {
    async summarize(input, agent, signal) {
        const target = targetFor(agent, this.config);
        if (target === undefined) {
            throw new Error('no provider/model available for summarization: route one request first');
        }
        const instruction = createUserMessage({
            content: [{ type: 'text', text: HANDOFF_INSTRUCTION }],
            source: { kind: 'plugin:' + PLUGIN, plugin: PLUGIN }
        });
        const assembler = new BlockAssembler();
        for await (const chunk of this.ctx.llm.stream({
            provider: target.provider,
            model: target.model,
            ...target.controls,
            messages: [...input.messages, instruction],
            ...(input.system === undefined ? {} : { system: input.system }),
            ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
            maxTokens: this.config.maxTokens,
            sessionId: agent.session.id,
            purpose: 'compaction',
            ...(signal === undefined ? {} : { signal })
        })) {
            assembler.push(chunk);
        }
        const finishKind = assembler.finish?.kind;
        (globalThis.__handoffTrace ??= []).push('finish=' + String(finishKind));
        const terminal = finishError(assembler.finish);
        if (terminal !== undefined) throw terminal;
        const rawOutput = assembler.blocks();
        const summary = rawOutput.filter((block) => block?.type === 'text');
        const index = identifierIndex(
            shadowedText(input.messages),
            summary.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n')
        );
        if (index !== '') summary.push({ type: 'text', text: index });
        if (!summary.some((block) => typeof block.text === 'string' && block.text.trim() !== '')) {
            throw new Error('handoff summary produced no text (finish=' + String(finishKind) + ', blocks=' + rawOutput.length + ')');
        }
        return {
            summary,
            rawOutput,
            llmStreamCall: true,
            provider: target.provider,
            model: target.model,
            maxTokens: this.config.maxTokens,
            ...(assembler.usage === undefined ? {} : { usage: assembler.usage })
        };
    }
}

export const name = 'handoff-summary-engine';

// The loader feeds these services into the context before apply() runs; without
// them BasicCompactionEngine.compactNow() throws "cannot get property ... without inject".
export const inject = BasicCompactionEngine.inject;

/** The instance this bundle mounts at the root context. */
let mounted;

export function apply(ctx, config = {}) {
    mounted = new HandoffSummaryEngine(ctx, config);
    return mounted;
}

/**
 * The root-level summarizer this bundle mounted.
 *
 * The handoff needs exactly this backend: compaction backends live inside each
 * agent preset's isolated group, and those use the stock directive, which
 * collapses facts into topic words. Calling summarize() on this instance keeps
 * the fact-dense checkpoint without committing anything to any session.
 * @returns the mounted instance, or undefined when the bundle did not load.
 */
export function rootSummaryEngine() {
    return mounted;
}
