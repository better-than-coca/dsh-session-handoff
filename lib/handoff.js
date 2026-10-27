/**
 * The handoff transaction.
 *
 * The parent is never mutated: its surface, its context window, and its log stay
 * exactly as they were, which is what makes it a usable archive. The checkpoint
 * does not go into a session created by this plugin either — the host hides
 * sessions that hold no events, and a plugin cannot write into one it did not open
 * through the UI. So the checkpoint waits in a pending record, and the next
 * brand-new conversation picks it up on its first prompt.
 */

import { readPressure, formatPressure } from './pressure.js';
import { sessionEvents } from './history.js';
import { debugLog } from './debug.js';
import { rootSummaryEngine } from './summary-engine.js';
import { summaryTokensOf, routeCard } from './route-card.js';
import { frameCheckpoint } from './checkpoint.js';
import { writePending } from './archive.js';

/**
 * Resolve a service from the agent's own composition first, then the plugin's
 * context.
 * @param agent - live agent whose context carries the composed services.
 * @param ctx - the plugin's own context.
 * @param name - service name.
 * @returns the service instance, or undefined.
 */
function serviceFor(agent, ctx, name) {
    const scoped = agent?.ctx;
    if (scoped !== undefined && typeof scoped.get === 'function') {
        const fromAgent = scoped.get(name);
        if (fromAgent !== undefined) return fromAgent;
    }
    return ctx.get(name);
}

/**
 * Collect the reasons a handoff must be refused right now.
 * @param session - session proposing to hand off.
 * @param cfg - resolved configuration.
 * @param state - plugin runtime state.
 * @returns an array of human-readable refusal reasons (empty means allowed).
 */
export function refusalReasons(session, cfg, state) {
    const reasons = [];
    const header = session?.header ?? {};
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) reasons.push('subagent sessions cannot hand off');
    const used = state.counts.get(session) ?? 0;
    if (used >= cfg.maxHandoffsPerSession) reasons.push('handoff limit reached (' + used + '/' + cfg.maxHandoffsPerSession + ') for this session');
    const events = sessionEvents(session);
    if (events.length === 0) reasons.push('session log is empty');
    return reasons;
}

/**
 * Rebuild the exact message list the model currently sees, the same way the
 * host's compactor does before summarizing. Only public session methods are
 * used, so this stays valid if the compactor's internals move.
 * @param session - live session.
 * @returns `{ messages, tools? }`, or null when the surface is unreadable.
 */
export function summarizationInput(session) {
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) return null;
    if (typeof session.eventAt !== 'function' || typeof session.deriveEventMessage !== 'function') return null;
    const headEvent = session.eventAt(nodes[0]);
    const system = headEvent?.type === 'system/message' ? session.deriveEventMessage(headEvent) : null;
    const systemHead = system === null || system === undefined ? null : system;
    const regionSeqs = systemHead === null ? nodes : nodes.slice(1);
    const messages = [];
    for (const seq of regionSeqs) {
        const event = session.eventAt(seq);
        if (event === undefined || event === null) continue;
        const message = session.deriveEventMessage(event);
        if (message !== null && message !== undefined) messages.push(message);
    }
    if (messages.length === 0) return null;
    const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
    return {
        ...(header?.tools === undefined ? {} : { tools: [...header.tools] }),
        messages: systemHead === null ? messages : [systemHead, ...messages]
    };
}

/**
 * Price the span the checkpoint replaces.
 * @param ctx - host context exposing `tokenMeter`.
 * @param session - session being measured.
 * @returns shadowed token count, or null when the meter is unavailable.
 */
export function shadowedTokens(ctx, session) {
    try {
        const meter = ctx.get('tokenMeter');
        if (meter === undefined || typeof meter.measure !== 'function') return null;
        const nodes = meter.measure(session)?.nodes ?? [];
        let total = 0;
        for (const node of nodes) if (Number.isFinite(node.tokens)) total += node.tokens;
        return total > 0 ? total : null;
    } catch {
        return null;
    }
}

/**
 * Execute one handoff: summarize the parent's surface and park the checkpoint for
 * the next new conversation.
 * @param ctx - host context.
 * @param cfg - resolved configuration.
 * @param state - plugin runtime state.
 * @param agent - the live agent whose session is handing off.
 * @returns a result record; never throws.
 */
export async function performHandoff(ctx, cfg, state, agent) {
    const session = agent?.session;
    if (session === undefined || session === null) return { ok: false, reason: 'no live session' };
    if (state.busy.has(session)) return { ok: false, reason: 'another handoff is already running' };

    state.busy.add(session);
    try {
        const reading = readPressure(ctx, session);
        if (reading === null) return { ok: false, reason: 'context pressure is unmeasurable' };
        if (reading.ratio < cfg.minRatio) {
            return { ok: false, reason: 'pressure ' + formatPressure(reading) + ' is below minRatio ' + cfg.minRatio };
        }

        const engine = rootSummaryEngine();
        if (engine === undefined || typeof engine.summarize !== 'function') {
            return { ok: false, reason: 'the handoff summarizer is not mounted; nothing was written' };
        }

        const input = summarizationInput(session);
        if (input === null) return { ok: false, reason: 'session surface is empty or unreadable; nothing was written' };

        debugLog('performHandoff: summarize start messages=' + input.messages.length);
        const summarized = await engine.summarize(input, agent, AbortSignal.timeout(cfg.summarizeTimeoutMs));
        debugLog('performHandoff: summarize done');

        const blocks = Array.isArray(summarized?.summary) ? summarized.summary : [];
        const summaryText = blocks
            .map((block) => (typeof block?.text === 'string' ? block.text : ''))
            .join('\n')
            .trim();
        if (summaryText === '') return { ok: false, reason: 'the summarizer produced an empty checkpoint; nothing was written' };

        const summaryTokens = summaryTokensOf(summaryText, summarized?.usage);
        const shadowed = shadowedTokens(ctx, session) ?? reading.used;
        const stats = { shadowed, summaryTokens, ratio: shadowed / summaryTokens };
        const checkpoint = frameCheckpoint(summaryText) + '\n\n' + routeCard(null, { ...stats, parentSession: session.id });
        const path = writePending({
            version: 1,
            parentSession: session.id,
            createdAt: Date.now(),
            summary: summaryText,
            checkpoint,
            stats,
            ...(summarized?.provider === undefined ? {} : { provider: summarized.provider }),
            ...(summarized?.model === undefined ? {} : { model: summarized.model })
        });
        debugLog('performHandoff: pending written ' + path);

        state.counts.set(session, (state.counts.get(session) ?? 0) + 1);
        state.handoffs.set(session, { at: Date.now(), before: reading, stats, pending: true });
        ctx.logger.info(
            'session-handoff: checkpoint ready for ' + session.id +
            ' (checkpoint ' + summaryTokens + ' tokens, ratio ' + Math.round(stats.ratio) + ':1, parent untouched, before=' + formatPressure(reading) + ')'
        );
        return { ok: true, pending: true, stats, before: reading };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cause = error instanceof Error ? error.cause : undefined;
        const causeText = cause instanceof Error ? cause.message : cause === undefined ? '' : String(cause);
        debugLog('performHandoff threw: ' + message + (causeText === '' ? '' : ' <- cause: ' + causeText));
        ctx.logger.warn('session-handoff: handoff aborted: ' + message);
        return { ok: false, reason: message };
    } finally {
        state.busy.delete(session);
    }
}
