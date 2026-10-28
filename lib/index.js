/**
 * dsh-session-handoff
 *
 * Watches context pressure, asks the model to check in with the user before the
 * context gets expensive, and turns an accepted handoff into
 * "summarize this session, then create a brand-new session seeded with the
 * checkpoint".
 *
 * Genuine-new-session design (0.3):
 * - the outgoing session is NEVER compacted or otherwise mutated; its log stays
 *   the archive the child reads from;
 * - the child is an ordinary session created by the host, so it holds no copy of
 *   the old conversation and can itself hand off again later;
 * - the checkpoint is injected once, on the child's first turn, from a durable
 *   record under <dsh home>/handoff.
 *
 * Design constraints held deliberately:
 * - never rewrites or deletes session history;
 * - never touches configuration files;
 * - dryRun defaults to true, so installing the plugin changes nothing until an
 *   operator opts in;
 * - every listener swallows its own errors: a broken handoff must never break
 *   the turn that triggered it.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { debugLog } from './debug.js';
import { resolveConfig } from './config.js';
import { readPressure, formatPressure } from './pressure.js';
import { refusalReasons, performHandoff, summarizationInput } from './handoff.js';
import { sessionEvents, searchEvents, readEventDetail } from './history.js';
import { forkCard } from './route-card.js';
import { readHandoff, readSessionEvents, writeHandoff, readPending, consumePending, clearPending } from './archive.js';
import { registerHandoffRoutes } from './http.js';
import { readSettings, writeSettings, clearSettings, describe as describeSettings } from './settings.js';
import { planTarget, samePath } from './target.js';

const PLUGIN = 'dsh-session-handoff';

/**
 * The installed version, for the panel's header chip. Read from the package
 * manifest when this copy sits inside a package; a bare lib/ checkout (the test
 * sandbox copies sources only) simply reports no version.
 */
const PLUGIN_VERSION = (() => {
    try {
        return String(createRequire(import.meta.url)('../package.json').version ?? '');
    } catch {
        return '';
    }
})();

/**
 * Why a known Session can still be unreachable: the host creates an Agent on
 * demand and only then attaches the surface the summarizer replays. A Session
 * that has not run a turn since the process started has history but no surface,
 * so it cannot be handed off until it is used once.
 */
const DORMANT_REASON = 'this conversation has not run a turn since the host started, so its live context is not loaded yet; send one message here, then hand off';

/**
 * First message of the follow-up Session. The Host injects the checkpoint ahead
 * of it on that Session's first step, so the text only exists to open a turn.
 */
const FOLLOW_UP_PROMPT = '继续';


const TEXT_OUTPUT = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }]
};

function state() {
    return {
        counts: new WeakMap(),
        handoffs: new WeakMap(),
        busy: new WeakSet(),
        pending: new WeakSet(),
        notifiedAt: new WeakMap(),
        routed: new WeakSet(),
        doneNotified: new WeakSet(),
        autoTried: new WeakSet(),
        // The browser button addresses a session by id, which a WeakMap cannot do.
        // These two maps are the only strong references the plugin keeps, and they
        // are capped at MAX_LIVE_SESSIONS entries.
        live: new Map(),
        status: new Map(),
        running: new Set(),
        // Outcome of the brand-new Session each parent opened, keyed by parent id.
        followUp: new Map(),
        // Directory a queued handoff should continue in, keyed by parent id. One
        // entry per handoff: it is dropped as soon as it is used, refused or
        // cancelled, so a choice never carries over to the next handoff.
        targets: new Map()
    };
}

/** Upper bound on remembered live Agents, so a long-lived process cannot grow. */
const MAX_LIVE_SESSIONS = 16;

/**
 * Remember the live Agent behind a session so the browser button can reach it.
 * @param st - plugin state.
 * @param agent - agent whose session was just observed.
 */
function rememberAgent(st, agent) {
    const session = agent?.session;
    if (session === undefined || session === null) return;
    const id = String(session.id);
    st.live.delete(id);
    st.live.set(id, agent);
    while (st.live.size > MAX_LIVE_SESSIONS) {
        const oldest = st.live.keys().next().value;
        if (oldest === undefined) break;
        st.live.delete(oldest);
    }
}

/**
 * Resolve a live Agent by session id, falling back to the most recent one.
 * @param st - plugin state.
 * @param sessionId - requested session, or undefined from a caller without one.
 * @returns the Agent, or undefined when nothing live is known.
 */
function resolveAgent(st, sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
        const exact = st.live.get(sessionId);
        if (exact !== undefined) return exact;
        return undefined;
    }
    const keys = [...st.live.keys()];
    const last = keys[keys.length - 1];
    return last === undefined ? undefined : st.live.get(last);
}

function pluginMessage(text) {
    return createUserMessage({
        content: [{ type: 'text', text }],
        // Session format v4 rejects the retired `kind: 'plugin'` wrapper; a
        // producer-owned kind is required. See dsh-session-format-v3-to-v4.
        source: { kind: 'plugin:' + PLUGIN, plugin: PLUGIN }
    });
}

function appendNotice(messages, notice) {
    return [...messages, notice];
}

function askNotice(cfg, reading) {
    return [
        '[' + PLUGIN + '] 上下文压力已达 ' + formatPressure(reading) + '。',
        '在继续执行下一步之前，先用 ask_user_question 问用户一句：',
        '「上下文已到 ' + (reading.ratio * 100).toFixed(0) + '%，要不要现在把上下文摘要出来，开一个新会话接着做？」',
        '如果用户同意，调用 session_handoff(action:"handoff")；如果用户拒绝，直接继续，不要重复询问。',
        '如果用户想把这次交接放到另一个工作区，先问清绝对路径，再调用 session_handoff(action:"handoff", targetDir:"<绝对路径>")。',
        '目录不存在时不要自己猜：先向用户确认，确认是新建后再加上 createTargetDir:true。不确定有哪些工作区时，先调用 session_handoff(action:"workspaces") 看清单。',
        '不要自行执行交接，也不要解释这条提醒的来源。'
    ].join('\n');
}

function doneNotice(record) {
    const stats = record.stats ?? {};
    return [
        '[' + PLUGIN + '] 摘要已生成：压缩比 ' + Math.round(stats.ratio ?? 0) + ':1，' + (stats.summaryTokens ?? 0) + ' tokens。',
        '旧会话没有被压缩、也没有被修改，仍然完整，可以继续在这里检索原文。',
        '现在请提示用户：新建一个对话（全新的空白会话），在里面发出第一句话，摘要会自动成为那个会话的上下文开头。摘要等到那一刻才会被使用，不会丢。',
        '本会话从现在起只作为档案，不要在这里继续派发新任务。'
    ].join('\n');
}

/**
 * Place the checkpoint ahead of the user's first prompt, after any system turns.
 * @param messages - the turn's message list.
 * @param notice - plugin message carrying the checkpoint.
 * @returns new message list.
 */
function injectBeforePrompt(messages, notice) {
    let index = 0;
    while (index < messages.length && messages[index]?.role === 'system') index += 1;
    return [...messages.slice(0, index), notice, ...messages.slice(index)];
}

/**
 * Whether this session has never had a completed exchange, i.e. it is a brand-new
 * conversation whose first prompt is this turn.
 *
 * The turn number is the primary signal, not the prompt count: the host appends the
 * submitted prompt to the durable log only after the first pre-step resolves, so a
 * brand-new conversation legitimately shows zero real prompts here. The log is used
 * to reject sessions that already have a reply, and an empty or unreadable log is
 * NOT treated as new, so a checkpoint can never land in a session whose history we
 * cannot see.
 * @param session - session being entered.
 * @param position - the step position the host passed (`{ turn, step }`).
 * @returns true for a first-turn conversation.
 */
export function isFirstConversation(session, position) {
    const events = sessionEvents(session);
    if (events.length === 0) return false;
    const turn = position?.turn;
    if (typeof turn === 'number' && turn !== 1) return false;
    let prompts = 0;
    for (const event of events) {
        if (event?.type === 'assistant/message') return false;
        if (event?.type === 'user/message' && event?.data?.source?.kind === 'user') prompts += 1;
    }
    return prompts <= 1;
}

export const name = PLUGIN;

export function apply(ctx, rawConfig = {}) {
    const warn = (message) => ctx.logger.warn(PLUGIN + ': ' + message);
    // Panel edits live in their own file and win over the profile patch, so the
    // settings page can take effect without a restart and without this plugin
    // ever rewriting a host configuration file.
    let cfg = resolveConfig({ ...rawConfig, ...readSettings() }, warn);
    // Assigned once the tools scope activates. Until then it is a no-op, so a
    // settings save that lands before the registry exists cannot fail.
    let syncHistoryTool = () => {};
    const reapply = () => {
        cfg = resolveConfig({ ...rawConfig, ...readSettings() }, warn);
        try {
            syncHistoryTool();
        } catch {
            // Re-registering one tool must never break saving the rest.
        }
        return cfg;
    };
    const st = state();
    ctx.on('agent/pre-step', async (payload, next) => {
        const result = await next();
        try {
            if (cfg.mode === 'off') return result;
            if (result === undefined || result.kind !== 'enter' || !Array.isArray(result.messages)) return result;
            const session = payload?.agent?.session;
            if (session === undefined) return result;
            rememberAgent(st, payload.agent);

            const header = session.header ?? {};
            if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return result;

            // A handed-off session receives its checkpoint exactly once.
            // The waiting checkpoint belongs to the next brand-new conversation the
            // user opens, not to any session this plugin could create itself.
            const pending = readPending();
            if (pending !== undefined && pending.consumedBy === undefined
                && String(session.id) !== pending.parentSession
                && isFirstConversation(session, payload)) {
                if (st.routed.has(session)) return result;
                st.routed.add(session);
                consumePending(String(session.id));
                writeHandoff({
                    version: 1,
                    childId: String(session.id),
                    parentSession: pending.parentSession,
                    createdAt: pending.createdAt,
                    summary: pending.summary,
                    stats: pending.stats,
                    injectedAt: Date.now(),
                    ...(pending.provider === undefined ? {} : { provider: pending.provider }),
                    ...(pending.model === undefined ? {} : { model: pending.model })
                });
                return { ...result, messages: injectBeforePrompt(result.messages, pluginMessage(pending.checkpoint)) };
            }

            if (header.isSeeded === true) {
                if (st.routed.has(session)) return result;
                st.routed.add(session);
                return { ...result, messages: appendNotice(result.messages, pluginMessage(forkCard(session))) };
            }

            const record = st.handoffs.get(session);
            if (record !== undefined) {
                if (st.doneNotified.has(session)) return result;
                st.doneNotified.add(session);
                return { ...result, messages: appendNotice(result.messages, pluginMessage(doneNotice(record))) };
            }

            const reading = readPressure(ctx, session);
            if (reading === null || reading.ratio < cfg.askRatio) return result;

            const last = st.notifiedAt.get(session) ?? 0;
            if (Date.now() - last < cfg.noticeCooldownMs) return result;
            st.notifiedAt.set(session, Date.now());
            return { ...result, messages: appendNotice(result.messages, pluginMessage(askNotice(cfg, reading))) };
        } catch (error) {
            ctx.logger.warn(PLUGIN + ': pre-step notice skipped: ' + (error instanceof Error ? error.message : String(error)));
            return result;
        }
    });

    ctx.on('agent/status', (payload) => {
        try {
            const agent = payload?.agent;
            const session = agent?.session;
            if (session === undefined) return;
            // The browser button only starts the summarizer while the session is
            // idle; remember the last observed status so it can tell.
            rememberAgent(st, agent);
            st.status.set(String(session.id), String(payload?.status ?? ''));
            if (payload?.status !== 'idle') return;
            debugLog('status=idle event received');
            if (cfg.mode === 'off') return;

            debugLog('idle: session=' + String(session?.id) + ' pending=' + st.pending.has(session) + ' mode=' + cfg.mode);
            const wanted = st.pending.has(session)
                || (cfg.mode === 'auto' && !st.autoTried.has(session) && autoDue(ctx, cfg, session));
            if (!wanted) return;
            st.pending.delete(session);
            st.autoTried.add(session);
            void runHandoffTracked(ctx, cfg, st, agent);
        } catch (error) {
            debugLog('idle handler threw: ' + (error instanceof Error ? error.stack : String(error)));
            ctx.logger.warn(PLUGIN + ': idle check failed: ' + (error instanceof Error ? error.message : String(error)));
        }
    });

    /**
     * Start or queue a handoff for one Agent.
     *
     * This is the same decision the `session_handoff` tool makes, minus the
     * consent step: the browser button IS the consent. The summarizer still only
     * runs on an idle Agent, so a click that lands mid-turn queues instead.
     * @param agent - live Agent whose session should be handed off.
     * @param target - optional `{ path, create }` naming the directory to continue in.
     * @returns a small result object for the browser.
     */
    const requestHandoff = (agent, target) => {
        const session = agent?.session;
        if (session === undefined) return { ok: false, code: 'no-live-session', error: 'no live session' };
        // A bad target has to fail here, before the summarizer is paid for:
        // otherwise the checkpoint parks with no Session that could consume it.
        const planned = target === undefined
            ? undefined
            : planTarget(target.path, { create: target.create === true && cfg.dryRun !== true });
        if (planned !== undefined && !planned.ok) {
            return { ok: false, code: planned.code ?? 'bad-target', error: planned.error };
        }
        const reasons = refusalReasons(session, cfg, st, readPressure(ctx, session));
        if (reasons.length > 0) return { ok: false, code: 'refused', error: reasons.join('; ') };
        if (cfg.dryRun) return { ok: true, dryRun: true, message: 'dry-run: nothing was changed' };
        if (cfg.mode === 'off') return { ok: false, code: 'mode-off', error: 'mode is off' };
        const id = String(session.id);
        const own = typeof session.header?.cwd === 'string' ? session.header.cwd : null;
        // One-off by design: a target equal to this session's own directory is not
        // a target at all, and anything stored is dropped once it is used.
        if (planned !== undefined && planned.ok && own !== null && samePath(planned.path, own)) {
            st.targets.delete(id);
        } else if (planned !== undefined && planned.ok) {
            st.targets.set(id, planned.path);
        }
        // The browser half opens the follow-up Session itself, so the click needs
        // the working directory to create one in and the switch that allows it.
        const follow = {
            autoOpen: cfg.autoOpenSession,
            cwd: st.targets.get(id) ?? own,
            target: st.targets.get(id) ?? null
        };
        if (st.running.has(id)) return { ok: true, running: true, ...follow };
        if (st.status.get(id) === 'idle') {
            st.pending.delete(session);
            void runHandoffTracked(ctx, cfg, st, agent);
            return { ok: true, running: true, ...follow };
        }
        st.pending.add(session);
        return { ok: true, queued: true, ...follow };
    };

    /**
     * Everything the button needs to render one state, as plain data.
     * @param sessionId - requested session, or undefined to use the most recent.
     * @returns status payload; never throws.
     */
    const report = (sessionId) => {
        const agent = resolveAgent(st, sessionId);
        const session = agent?.session;
        const id = session === undefined ? undefined : String(session.id);
        const reading = session === undefined ? null : readPressure(ctx, session);
        // A Session the browser names but no Agent owns is dormant, not unknown:
        // it exists in the sidebar and needs one turn before it can be summarized.
        const dormant = session === undefined && typeof sessionId === 'string' && sessionId !== '';
        const reasons = session === undefined ? [dormant ? DORMANT_REASON : 'no live session'] : refusalReasons(session, cfg, st, reading);
        const waiting = readPending();
        return {
            sessionId: id ?? null,
            mode: cfg.mode,
            dryRun: cfg.dryRun,
            pressure: reading === null ? null : {
                ratio: reading.ratio,
                used: reading.used,
                window: reading.window,
                text: formatPressure(reading)
            },
            askRatio: cfg.askRatio,
            autoRatio: cfg.autoRatio,
            eligible: reasons.length === 0,
            reason: reasons.length === 0 ? null : reasons.join('; '),
            running: id !== undefined && st.running.has(id),
            dormant,
            followUp: id === undefined ? null : st.followUp.get(id) ?? null,
            // The browser half opens the follow-up session itself, so it needs the
            // working directory to create one in and the switch that allows it.
            // A queued target wins: that is where the child will actually open.
            cwd: id !== undefined && st.targets.has(id)
                ? st.targets.get(id)
                : typeof session?.header?.cwd === 'string' ? session.header.cwd : null,
            target: id !== undefined && st.targets.has(id) ? st.targets.get(id) : null,
            autoOpen: cfg.autoOpenSession,
            pending: waiting === undefined ? 'none' : waiting.consumedBy === undefined ? 'waiting' : 'consumed',
            pendingParent: waiting === undefined ? null : waiting.parentSession
        };
    };

    /**
     * Attach an existing Session to the Workspace that owns a directory.
     *
     * The sidebar lists a Workspace's own sessionIds, so a Session created
     * outside that membership runs but stays invisible. This repairs such a
     * Session — the follow-up flow already attaches what it creates, and this is
     * the one-step recovery for anything created before that fix.
     * @param sessionId - Session to attach.
     * @param cwd - its directory, as stored in the Session header.
     * @returns `{ ok }` or an explicit refusal.
     */
    const attachToWorkspace = async (sessionId, cwd) => {
        try {
            const registry = ctx.get('workspaceRegistry');
            if (registry === undefined || typeof registry.resolveByPath !== 'function') {
                return { ok: false, code: 'unavailable', error: 'the host exposes no workspace registry' };
            }
            const workspace = await registry.resolveByPath(cwd);
            if (workspace === undefined) return { ok: false, code: 'no-workspace', error: 'no workspace owns ' + cwd };
            if (typeof workspace.attachSession !== 'function') {
                return { ok: false, code: 'unavailable', error: 'this workspace cannot attach sessions' };
            }
            await workspace.attachSession(sessionId);
            return { ok: true, sessionId, workspaceId: String(workspace.id ?? '') };
        } catch (error) {
            return { ok: false, code: 'attach-failed', error: messageOf(error) };
        }
    };

    ctx.inject(['tools'], (scoped) => {
        const tools = scoped.get('tools') ?? scoped.tools;
        if (tools === undefined || typeof tools.register !== 'function') return;
        try {
            tools.register(defineTool({
                name: 'session_handoff',
                description: 'Inspect or perform the context handoff. action:"status" reports pressure, eligibility, any queued destination and any waiting checkpoint; action:"workspaces" lists the Workspaces this host knows plus the directory this conversation runs in; action:"handoff" queues a summarization that runs as soon as the current turn ends and parks the checkpoint for the next brand-new conversation; action:"cancel" discards a waiting checkpoint. By default the new session opens in the directory this conversation runs in; pass targetDir to continue in another directory, and add createTargetDir only after the user confirms that a new directory is wanted. The current session is never compacted or modified. Never call "handoff" without explicit user consent.',
                parameters: {
                    action: {
                        type: 'string',
                        required: true,
                        description: '"status" to inspect, "workspaces" to list Workspaces, "handoff" to request the handoff, "cancel" to discard a waiting checkpoint.'
                    },
                    targetDir: {
                        type: 'string',
                        description: 'Absolute path of the directory the new session should run in. Omit to continue in the current directory.'
                    },
                    createTargetDir: {
                        type: 'boolean',
                        description: 'Create targetDir (and any missing parent) when it does not exist. Only set after the user confirmed the directory should be created.'
                    }
                },
                output: TEXT_OUTPUT,
                isConcurrencySafe: () => false,
                execute: (args, exec) => describeOrQueue(ctx, cfg, st, args, exec)
            }));
            // The archive tool can be switched off at runtime from the settings
            // page, so its registration follows cfg on every save instead of being
            // decided once at load. `tools.register` returns the disposer.
            let stopHistory = null;
            const syncHistoryRegistrations = () => {
                const wanted = cfg.includeHistoryTool === true;
                if (wanted && stopHistory === null) {
                    const stop = tools.register(defineTool({
                        name: 'handoff_history',
                        description: 'Search or read a raw session log. source:"self" (default) reads this session; source:"parent" reads the archived log of the session this one was handed off from. A literal text search returns seq numbers, and reading a seq returns the original event in full.',
                        parameters: {
                            query: { type: 'string', description: 'Literal text to search for (case-insensitive).' },
                            seq: { type: 'integer', description: 'Exact event sequence number to read in full.' },
                            source: { type: 'string', description: '"self" (default) or "parent" (the archived session this one came from).' },
                            before: { type: 'integer', description: 'Neighbour events to include before the target seq.' },
                            after: { type: 'integer', description: 'Neighbour events to include after the target seq.' },
                            limit: { type: 'integer', description: 'Maximum search hits (default 8, max 30).' }
                        },
                        output: TEXT_OUTPUT,
                        isConcurrencySafe: () => true,
                        execute: (args, exec) => lookupHistory(ctx, args, exec)
                    }));
                    stopHistory = typeof stop === 'function' ? stop : () => {};
                } else if (!wanted && stopHistory !== null) {
                    try {
                        stopHistory();
                    } catch {
                        // Releasing an already-released registration is fine.
                    }
                    stopHistory = null;
                }
            };
            syncHistoryTool = syncHistoryRegistrations;
            syncHistoryRegistrations();
        } catch (error) {
            ctx.logger.warn(PLUGIN + ': tool registration skipped: ' + (error instanceof Error ? error.message : String(error)));
        }
    });

    const settingsPayload = () => ({ ...describeSettings(cfg), version: PLUGIN_VERSION });

    // The assistant-action button is optional decoration: without a web server
    // (CLI-only deployments) the plugin keeps working through its tool.
    ctx.inject(['webServer'], (scoped) => {
        const server = scoped.get('webServer') ?? scoped.webServer;
        if (server === undefined || server === null || typeof server.register !== 'function') return;
        try {
            const dispose = registerHandoffRoutes(server, {
                report,
                request: requestHandoff,
                resolve: (sessionId) => resolveAgent(st, sessionId),
                attach: attachToWorkspace,
                // Distinguish "that Session is dormant" from "nothing is live at all".
                absent: (sessionId) => (typeof sessionId === 'string' && sessionId !== ''
                    ? { ok: false, code: 'session-dormant', error: DORMANT_REASON }
                    : { ok: false, code: 'no-live-session', error: 'no live session to hand off' }),
                settings: {
                    // Every answer carries the version, or the stale badge comes
                    // back on the first save.
                    describe: () => settingsPayload(),
                    update(values) {
                        writeSettings(values);
                        reapply();
                        return settingsPayload();
                    },
                    reset() {
                        clearSettings();
                        reapply();
                        return settingsPayload();
                    }
                }
            });
            if (typeof scoped.effect === 'function') {
                scoped.effect(() => () => dispose(), PLUGIN + ': handoff routes');
            }
        } catch (error) {
            ctx.logger.warn(PLUGIN + ': handoff routes skipped: ' + (error instanceof Error ? error.message : String(error)));
        }
    });
}

function autoDue(ctx, cfg, session) {
    const reading = readPressure(ctx, session);
    return reading !== null && reading.ratio >= cfg.autoRatio;
}

/**
 * Read the optional destination out of a tool call.
 * @param args - tool arguments.
 * @returns \`{ path, create }\`, or undefined when the caller named no target.
 */
function targetArgs(args) {
    const path = typeof args?.targetDir === 'string' ? args.targetDir.trim() : '';
    if (path === '') return undefined;
    return { path, create: args?.createTargetDir === true };
}

function messageOf(error) {
    if (error === null || error === undefined) return 'unknown';
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return String(error.code ?? error.message ?? error);
}

/**
 * Continue in a brand-new Session the way the Host's own New Session flow does.
 *
 * It goes through the Session controller rather than through a Session object
 * this plugin builds: the controller is what the New Session button calls, so
 * the child is an ordinary listed conversation that can itself be handed off
 * later. The checkpoint parked by {@link performHandoff} is picked up by the
 * pre-step hook on the child's first turn, ahead of {@link FOLLOW_UP_PROMPT}.
 *
 * @param ctx - plugin context.
 * @param cfg - resolved configuration.
 * @param st - plugin state.
 * @param parent - Session that was just handed off.
 * @param target - directory to continue in, when the user chose another one.
 * @returns the outcome record also exposed through the status route.
 */
async function continueInNewSession(ctx, cfg, st, parent, target) {
    const id = String(parent.id);
    const record = (code, extra) => {
        const value = { code, at: Date.now(), ...extra };
        st.followUp.set(id, value);
        return value;
    };
    if (cfg.autoOpenSession !== true) return record('manual');
    const controller = ctx.get('sessionController');
    if (controller === undefined || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
        ctx.logger.warn(PLUGIN + ': follow-up session skipped: the host exposes no session controller');
        return record('unavailable');
    }
    const cwd = target === undefined
        ? typeof parent.header?.cwd === 'string' ? parent.header.cwd : ''
        : target;
    if (cwd === '') return record('no-cwd');
    // A Session created from a bare cwd is NOT attached to the Workspace, and the
    // sidebar lists a Workspace's own sessionIds: the child would run fine but be
    // invisible. Handing the controller the Workspace makes it attach the child
    // itself, so fall back to cwd only when no Workspace owns this directory.
    let workspaceId;
    try {
        const registry = ctx.get('workspaceRegistry');
        if (registry !== undefined && typeof registry.resolveByPath === 'function') {
            let workspace = await registry.resolveByPath(cwd);
            // An explicit destination usually is not a Workspace yet. Register it, or
            // the child runs fine but no sidebar entry lists it.
            if (workspace === undefined && target !== undefined && typeof registry.create === 'function') {
                workspace = await registry.create(cwd);
            }
            if (workspace !== undefined && typeof workspace.id === 'string' && workspace.id !== '') workspaceId = workspace.id;
        }
    } catch (error) {
        debugLog('follow-up: workspace lookup failed: ' + messageOf(error));
    }
    let childId;
    try {
        const created = await controller.create(workspaceId === undefined ? { cwd } : { workspaceId });
        childId = created === null || created === undefined ? undefined : created.sessionId;
    } catch (error) {
        ctx.logger.warn(PLUGIN + ': follow-up session not created: ' + messageOf(error));
        return record('create-failed', { detail: messageOf(error) });
    }
    if (typeof childId !== 'string' || childId === '') {
        return record('create-failed', { detail: 'the host returned no session id' });
    }
    try {
        // The controller reads the signal before admission, so a signal is not
        // optional even for this fire-and-forget prompt.
        await controller.prompt({
            requestId: randomUUID(),
            sessionId: childId,
            mode: 'queue',
            content: [{ type: 'text', text: FOLLOW_UP_PROMPT }]
        }, new AbortController().signal);
    } catch (error) {
        ctx.logger.warn(PLUGIN + ': follow-up session ' + childId + ' was created but not prompted: ' + messageOf(error));
        return record('prompt-failed', { sessionId: childId, detail: messageOf(error) });
    }
    if (workspaceId !== undefined) {
        // The controller attaches only when it created from a Workspace id; this
        // also covers a reused blank Session that predates the attach.
        try {
            const registry = ctx.get('workspaceRegistry');
            const workspace = registry === undefined ? undefined : registry.get?.(workspaceId);
            if (workspace !== undefined && typeof workspace.attachSession === 'function') await workspace.attachSession(childId);
        } catch (error) {
            debugLog('follow-up: attach after prompt failed: ' + messageOf(error));
        }
    }
    ctx.logger.info(PLUGIN + ': follow-up session ' + childId + ' created; the checkpoint is injected on its first step');
    return record('opened', { sessionId: childId, cwd, workspaceId: workspaceId ?? null });
}

/**
 * Run one handoff while reporting it as in-flight, so a second click cannot
 * start a parallel summarization.
 * @param ctx - plugin context.
 * @param cfg - resolved configuration.
 * @param st - plugin state.
 * @param agent - live Agent.
 */
async function runHandoffTracked(ctx, cfg, st, agent) {
    const session = agent?.session;
    const id = session === undefined ? '' : String(session.id);
    if (id !== '') st.running.add(id);
    try {
        await runHandoff(ctx, cfg, st, agent);
    } finally {
        if (id !== '') st.running.delete(id);
    }
}

async function runHandoff(ctx, cfg, st, agent) {
    const session = agent?.session;
    if (session === undefined) return;
    // Consume the one-off destination up front, so a refusal, a failure or a
    // repeated idle event cannot leave the choice behind for the next handoff.
    const target = st.targets.get(String(session.id));
    st.targets.delete(String(session.id));
    debugLog('runHandoff start session=' + String(session.id) + ' target=' + String(target));
    const reasons = refusalReasons(session, cfg, st);
    if (reasons.length > 0) {
        ctx.logger.info(PLUGIN + ': handoff skipped: ' + reasons.join('; '));
        return;
    }
    const result = await performHandoff(ctx, cfg, st, agent);
    debugLog('performHandoff result=' + JSON.stringify(result));
    if (!result.ok) {
        ctx.logger.warn(PLUGIN + ': handoff not completed: ' + result.reason);
        return;
    }
    // The checkpoint is parked; the follow-up Session is the Host's own, so the
    // pre-step hook injects it there on the first turn.
    await continueInNewSession(ctx, cfg, st, session, target);
}

function describeOrQueue(ctx, cfg, st, args, exec) {
    const agent = exec?.agent;
    const session = agent?.session;
    if (session === undefined) return 'ERROR: no live session is attached to this tool call.';
    const reading = readPressure(ctx, session);
    const reasons = refusalReasons(session, cfg, st, reading);

    if (args.action === 'workspaces') {
        const registry = ctx.get('workspaceRegistry');
        if (registry === undefined || typeof registry.list !== 'function') {
            return 'ERROR: the host exposes no workspace registry, so there is nothing to list.';
        }
        const own = typeof session.header?.cwd === 'string' ? session.header.cwd : '';
        const lines = ['current: ' + (own === '' ? '(unknown)' : own), 'registered:'];
        let count = 0;
        for (const workspace of registry.list()) {
            const path = String(workspace.path ?? '');
            if (path === '') continue;
            count += 1;
            const title = String(workspace.title ?? '');
            lines.push('- ' + path
                + (title === '' || title === path ? '' : '  [' + title + ']')
                + (samePath(path, own) ? '  (this conversation)' : ''));
        }
        if (count === 0) lines.push('- (none)');
        lines.push('To continue somewhere else, hand off with targetDir:"<absolute path>"; add createTargetDir:true only after the user confirms the directory should be created.');
        return lines.join('\n');
    }

    if (args.action === 'status') {
        const lines = [
            'mode: ' + cfg.mode,
            'dryRun: ' + cfg.dryRun,
            'pressure: ' + formatPressure(reading),
            'askRatio: ' + cfg.askRatio + '  autoRatio: ' + cfg.autoRatio + '  minRatio: ' + cfg.minRatio,
            'eligible: ' + (reasons.length === 0 ? 'yes' : 'no — ' + reasons.join('; ')),
            ...(st.targets.has(String(session.id)) ? ['queued target: ' + st.targets.get(String(session.id))] : [])
        ];
        // The handoff summarizes the live surface; if these host APIs are not
        // readable on this deployment, say so here instead of at handoff time.
        const surface = summarizationInput(session);
        lines.push('surface: ' + (surface === null ? 'unreadable — the handoff would refuse' : surface.messages.length + ' messages ready to summarize'));
        const waiting = readPending();
        lines.push('pending checkpoint: ' + (waiting === undefined
            ? 'none'
            : waiting.consumedBy === undefined
                ? 'waiting for a brand-new conversation (open a new chat and send one message)'
                : 'consumed by ' + waiting.consumedBy));
        const record = st.handoffs.get(session);
        if (record !== undefined) lines.push('last handoff: checkpoint ready (' + Math.round(record.stats?.ratio ?? 0) + ':1), parent log kept intact');
        const own = readHandoff(String(session.id));
        if (own !== undefined) lines.push('this session was handed off from: ' + own.parentSession);
        return lines.join('\n');
    }

    if (args.action === 'cancel') {
        st.targets.delete(String(session.id));
        return clearPending() ? 'CANCELLED: the waiting checkpoint was discarded.' : 'Nothing was waiting.';
    }
    if (args.action !== 'handoff') return 'ERROR: action must be "status", "workspaces", "handoff" or "cancel".';
    const spec = targetArgs(args);
    // A dry run must not touch the filesystem, so a create request is planned but
    // not performed: the report below says what would have happened instead.
    const planned = spec === undefined
        ? undefined
        : planTarget(spec.path, { create: spec.create === true && cfg.dryRun !== true });
    const wouldCreate = planned !== undefined && !planned.ok && planned.code === 'missing-directory'
        && spec?.create === true && cfg.dryRun === true;
    if (planned !== undefined && !planned.ok && !wouldCreate) return 'REFUSED: ' + planned.error;
    if (reasons.length > 0) return 'REFUSED: ' + reasons.join('; ');
    if (cfg.dryRun) {
        const lines = [
            'DRY-RUN: nothing was changed.',
            'pressure: ' + formatPressure(reading),
            'would summarize this session into one checkpoint and park it for the next new conversation.',
            'this session would NOT be compacted and NOT be modified.'
        ];
        if (wouldCreate) lines.push('would have created ' + spec.path + ' and continued there');
        else if (planned !== undefined && planned.ok) lines.push('would continue in ' + planned.path);
        lines.push('Set dryRun: false in the profile patch to enable the real handoff.');
        return lines.join('\n');
    }
    if (cfg.mode === 'off') return 'REFUSED: mode is off.';
    const id = String(session.id);
    const own = typeof session.header?.cwd === 'string' ? session.header.cwd : '';
    // One-off: the choice is stored for this handoff only and cleared when used.
    if (planned !== undefined && planned.ok && !samePath(planned.path, own)) st.targets.set(id, planned.path);
    else st.targets.delete(id);
    st.pending.add(session);
    const queued = st.targets.get(id);
    return 'QUEUED: the handoff runs as soon as the current turn ends.'
        + (queued === undefined ? '' : ' The new session will open in ' + queued + '.')
        + ' Tell the user it is scheduled, and that afterwards they must open a NEW conversation whose first message will receive the checkpoint.';
}

function lookupHistory(ctx, args, exec) {
    const session = exec?.agent?.session;
    if (session === undefined) return 'ERROR: no live session is attached to this tool call.';
    const source = typeof args.source === 'string' && args.source !== '' ? args.source : 'self';
    let events;
    let label;
    if (source === 'parent') {
        const record = readHandoff(String(session.id));
        if (record === undefined) return 'This session has no handoff record, so it has no parent archive to read.';
        events = readSessionEvents(record.parentSession);
        label = 'parent ' + record.parentSession;
        if (events.length === 0) {
            return 'The parent archive for ' + record.parentSession + ' is not readable: no session log was found under the DSH sessions directory.';
        }
    } else if (source === 'self') {
        events = sessionEvents(session);
        label = 'this session';
        if (events.length === 0) return 'This session has no readable event log.';
    } else {
        return 'ERROR: source must be "self" or "parent".';
    }
    const prefix = source === 'parent' ? '[parent] ' : '';
    const limit = Number.isSafeInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 30) : 8;

    if (Number.isSafeInteger(args.seq)) {
        const before = Number.isSafeInteger(args.before) ? Math.min(Math.max(args.before, 0), 20) : 1;
        const after = Number.isSafeInteger(args.after) ? Math.min(Math.max(args.after, 0), 20) : 1;
        return prefix + readEventDetail(events, args.seq, before, after);
    }
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query === '') return 'Provide either query (literal text) or seq (exact event number).';
    const hits = searchEvents(events, query, limit);
    if (hits.length === 0) {
        return 'No event in ' + label + ' contains "' + query + '". That log holds seq 0..' + (events.length - 1) + ', ' + events.length + ' events.';
    }
    return hits.map((hit) => prefix + '[' + hit.seq + '] ' + hit.type + ': ' + hit.text).join('\n');
}

export default apply;
