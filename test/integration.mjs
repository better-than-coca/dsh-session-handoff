/**
 * Integration suite: the handoff transaction against stubbed host services.
 *
 * What must hold: the outgoing session is never compacted, modified or forked;
 * the checkpoint is parked instead of pushed into a session this plugin created;
 * the next brand-new conversation receives it before its first prompt; and the
 * parent archive stays readable through handoff_history.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const home = mkdtempSync(join(tmpdir(), 'handoff-int-'));
process.env.DSH_SESSION_HANDOFF_HOME = home;

const { apply } = await import('./lib/index.js');
const { apply: applyEngine } = await import('./lib/summary-engine.js');
const { readHandoff, readPending, writePending } = await import('./lib/archive.js');

let failures = 0;
const check = (name, cond, detail) => {
    if (cond) { console.log('PASS ' + name); return; }
    failures += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
};

const parentEvents = [
    { seq: 0, type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '做交接插件 needle-alpha' }], source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } }
];
const parentSession = {
    id: 'session-parent',
    header: { isSeeded: false, delegationDepth: 0, cwd: 'E:\\dsh' },
    events: parentEvents,
    surface: { nodes: [0, 1, 2] },
    eventAt(seq) { return this.events.find((event) => event.seq === seq); },
    deriveEventMessage(event) {
        if (event?.data?.message !== undefined) return event.data.message;
        if (event?.type === 'user/message') return { role: 'user', content: event.data.content };
        return null;
    },
    requestHeader() { return { config: { provider: 'p', model: 'm' }, tools: [{ name: 't' }] }; },
    snapshotEvents() { return this.events; }
};
const agent = { session: parentSession };

const summarizeCalls = [];
applyEngine({
    llm: {
        async *stream(options) {
            summarizeCalls.push(options);
            yield { type: 'text', text: '## Current State\n- 插件改到一半' };
        }
    }
}, { maxTokens: 4096 });

const handlers = new Map();
const tools = [];
const routes = [];
const log = [];
const createdSessions = [];
const prompts = [];
const attached = [];
// Mirrors the real registry: register returns the unregister disposer.
const toolsService = {
    register(tool) {
        tools.push(tool);
        return () => {
            const index = tools.indexOf(tool);
            if (index >= 0) tools.splice(index, 1);
        };
    }
};
const webServer = { register(route) { routes.push(route); return () => { route.released = true; }; } };
/** Call one registered route the way the browser half does. */
function invoke(route, method, body) {
    return new Promise((resolve) => {
        const text = body === undefined ? '' : JSON.stringify(body);
        const req = {
            method,
            url: route.path,
            on(event, fn) {
                if (event === 'data' && text !== '') fn(Buffer.from(text, 'utf8'));
                if (event === 'end') fn();
                return req;
            },
            destroy() {}
        };
        const res = {
            statusCode: 0,
            headers: {},
            setHeader(name, value) { this.headers[name] = value; },
            end(payload) { resolve({ status: this.statusCode, body: JSON.parse(payload) }); }
        };
        route.handler(req, res);
    });
}
const scoped = {
    get: (name) => name === 'tools' ? toolsService : name === 'webServer' ? webServer : undefined
};
function hostContext(overrides = {}) {
    return {
        logger: { info: (m) => log.push(['info', m]), warn: (m) => log.push(['warn', m]), debug: () => {} },
        on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => {}; },
        get(name) {
            if (name === 'sessionProjections') {
                return {
                    snapshot: (session) => ({
                        values: { contextPressure: { projectedTokens: session?.id === 'session-parent' ? 620000 : 40000, contextWindow: 1000000 } }
                    })
                };
            }
            if (name === 'tokenMeter') return { measure: () => ({ nodes: [{ seq: 1, tokens: 300000 }, { seq: 2, tokens: 320000 }] }) };
            // Present so the suite can prove the plugin never reaches for it.
            if (name === 'workspaceRegistry') {
                const workspace = (id) => ({
                    id,
                    path: 'E:\\dsh',
                    attachSession: async (sessionId) => { attached.push(sessionId); }
                });
                return {
                    resolveByPath: async (path) => (path === 'E:\\dsh' ? workspace('ws-1') : undefined),
                    get: (id) => workspace(id)
                };
            }
            if (name === 'sessionController') {
                return {
                    create: async (request) => {
                        createdSessions.push(request);
                        return { sessionId: 'session-child' };
                    },
                    prompt: async (request) => {
                        prompts.push(request);
                        return { accepted: true };
                    }
                };
            }
            return undefined;
        },
        inject(deps, fn) { fn(scoped); }
    };
}

const ctx = hostContext();
apply(ctx, { mode: 'ask', dryRun: false, askRatio: 0.5, autoRatio: 0.8, minRatio: 0.3, noticeCooldownMs: 60000, autoOpenSession: false });

const preStep = handlers.get('agent/pre-step')[0];
const idle = handlers.get('agent/status')[0];
const handoffTool = tools.find((tool) => tool.name === 'session_handoff');
const historyTool = tools.find((tool) => tool.name === 'handoff_history');

check('tools: both registered', handoffTool !== undefined && historyTool !== undefined, tools.map((tool) => tool.name).join(','));

const noticed = await preStep({ agent }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [] }] }));
check('pre-step: notice appended at 62%', noticed.messages.length === 2 && JSON.stringify(noticed.messages[1]).includes('session_handoff'));
const silent = await preStep({ agent }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [] }] }));
check('pre-step: cooldown suppresses the repeat', silent.messages.length === 1);

const status = await handoffTool.execute({ action: 'status' }, { agent });
check('status: reports pressure and eligibility', status.includes('62.0%') && status.includes('eligible: yes'), status);
check('status: proves the surface is readable before handoff', status.includes('surface: 3 messages ready'), status);
check('status: reports no waiting checkpoint yet', status.includes('pending checkpoint: none'), status);

// --- the button's follow-up payload -----------------------------------------
{
    const route = routes.find((item) => item.path.endsWith('/status'));
    const answered = await invoke(route, 'GET');
    check('status route: answers', answered.status === 200 && answered.body.ok === true, String(answered.status));
    check('status route: carries the working directory', answered.body.cwd === 'E:\\dsh', JSON.stringify(answered.body.cwd));
    check('status route: carries the auto-open switch', answered.body.autoOpen === false, String(answered.body.autoOpen));
    check('status route: no checkpoint is created by a status read', createdSessions.length === 0, JSON.stringify(createdSessions));
    // A second instance proves the switch follows configuration; both of its
    // registries are dropped again so the shared fixtures stay untouched.
    const routeMark = routes.length;
    const toolMark = tools.length;
    const off = hostContext();
    apply(off, { mode: 'ask', dryRun: false, autoOpenSession: false });
    const offAnswered = await invoke(routes[routeMark], 'GET');
    check('status route: the switch follows configuration', offAnswered.body.autoOpen === false, String(offAnswered.body.autoOpen));
    routes.splice(routeMark);
    tools.splice(toolMark);
}

const queued = await handoffTool.execute({ action: 'handoff' }, { agent });
check('handoff: queued for the end of the turn', queued.startsWith('QUEUED'), queued);
idle({ agent, status: 'idle' });
await new Promise((resolve) => setTimeout(resolve, 120));

check('handoff: summarizer received the live surface', summarizeCalls.length === 1 && summarizeCalls[0].messages.length === 4, JSON.stringify(summarizeCalls[0]?.messages?.length));
check('handoff: no session was created', createdSessions.length === 0, JSON.stringify(createdSessions));

const pending = readPending();
check('handoff: checkpoint parked', pending !== undefined && pending.parentSession === 'session-parent', JSON.stringify(pending?.parentSession ?? null));
check('handoff: parked checkpoint carries the text', typeof pending?.checkpoint === 'string' && pending.checkpoint.includes('<compacted-summary>') && pending.checkpoint.includes('插件改到一半'));
check('handoff: parked checkpoint carries the route card', pending?.checkpoint?.includes('source: "parent"'), String(pending?.checkpoint ?? '').slice(0, 200));
check('handoff: parked checkpoint carries the measurement', pending?.stats?.shadowed === 620000 && pending.stats.summaryTokens === 42, JSON.stringify(pending?.stats));

const after = await preStep({ agent }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [] }] }));
check('pre-step: completion notice on the parent', after.messages.length === 2 && JSON.stringify(after.messages[1]).includes('新建一个对话'));
check('pre-step: the parent never consumes its own checkpoint', readPending()?.consumedBy === undefined);

// --- a brand-new conversation picks the checkpoint up ---
const freshSession = {
    id: 'session-fresh',
    header: { isSeeded: false, delegationDepth: 0 },
    events: [{ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '接着做' }], source: { kind: 'user' } } }],
    surface: { nodes: [0] },
    snapshotEvents() { return this.events; }
};
const firstTurn = await preStep({ agent: { session: freshSession } }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [] }] }));
const firstText = JSON.stringify(firstTurn.messages[0] ?? {});
check('new conversation: checkpoint injected as the first message', firstTurn.messages.length === 2 && firstText.includes('<compacted-summary>'), JSON.stringify(firstTurn.messages.length));
check('new conversation: injection lands before the prompt', firstText.includes('插件改到一半'));
check('new conversation: pending is marked consumed', readPending()?.consumedBy === 'session-fresh', JSON.stringify(readPending()?.consumedBy ?? null));
check('new conversation: a parent pointer is recorded for it', readHandoff('session-fresh')?.parentSession === 'session-parent', JSON.stringify(readHandoff('session-fresh') ?? null));
check('new conversation: the pointer marks when it was injected', typeof readHandoff('session-fresh')?.injectedAt === 'number');

freshSession.events.push({ seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } });
const laterTurn = await preStep({ agent: { session: freshSession } }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [] }] }));
check('new conversation: no second injection', laterTurn.messages.length === 1, JSON.stringify(laterTurn.messages.length));

const otherSession = {
    id: 'session-old',
    header: { isSeeded: false, delegationDepth: 0 },
    events: [{ seq: 0, type: 'user/message', data: { content: [], source: { kind: 'user' } } }, { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } }],
    surface: { nodes: [0, 1] },
    snapshotEvents() { return this.events; }
};
const oldTurn = await preStep({ agent: { session: otherSession } }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [] }] }));
check('existing conversation: nothing injected', oldTurn.messages.length === 1 || !JSON.stringify(oldTurn.messages).includes('<compacted-summary>'), JSON.stringify(oldTurn.messages.length));

// --- parent archive retrieval ---
const parentDir = join(home, 'sessions', '--E-dsh--', 'session-parent');
mkdirSync(parentDir, { recursive: true });
writeFileSync(join(parentDir, 'session.v4.jsonl.zstd'), Buffer.concat(parentEvents.map((event) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))));
const parentHit = await historyTool.execute({ query: 'needle-alpha', source: 'parent' }, { agent: { session: freshSession } });
check('history: parent archive is searchable', parentHit.includes('[parent]') && parentHit.includes('needle-alpha'), String(parentHit).slice(0, 200));
const parentRead = await historyTool.execute({ seq: 1, source: 'parent' }, { agent: { session: freshSession } });
check('history: parent event reads in full', parentRead.includes('needle-alpha') && parentRead.includes('user/message'), String(parentRead).slice(0, 200));
const noArchive = await historyTool.execute({ query: 'x', source: 'parent' }, { agent });
check('history: parent source refuses without a record', String(noArchive).includes('no handoff record'), String(noArchive).slice(0, 160));
const badSource = await historyTool.execute({ query: 'x', source: 'uncle' }, { agent: { session: freshSession } });
check('history: unknown source is rejected', String(badSource).startsWith('ERROR'), String(badSource).slice(0, 120));

// --- cancel ---
writePending({ version: 1, parentSession: 'session-parent', createdAt: Date.now(), summary: '# again', checkpoint: 'x', stats: {} });
const cancelled = await handoffTool.execute({ action: 'cancel' }, { agent });
check('cancel: discards the waiting checkpoint', cancelled.startsWith('CANCELLED') && readPending() === undefined, cancelled);
check('cancel: nothing left to cancel', (await handoffTool.execute({ action: 'cancel' }, { agent })).includes('Nothing was waiting'));

const again = await handoffTool.execute({ action: 'handoff' }, { agent });
check('refusal: second handoff refused', again.startsWith('REFUSED'), again);

// --- dry run ---
handlers.clear();
tools.length = 0;
apply(hostContext(), { mode: 'ask', askRatio: 0.5, minRatio: 0.3 });
const dryHandoff = tools.find((tool) => tool.name === 'session_handoff');
const dryStatus = await dryHandoff.execute({ action: 'status' }, { agent });
check('dryRun: defaults to true', dryStatus.includes('dryRun: true'), dryStatus);
const dryQueue = await dryHandoff.execute({ action: 'handoff' }, { agent });
check('dryRun: reports what it would do without doing it', dryQueue.includes('DRY-RUN') && dryQueue.includes('park it'), dryQueue);
check('dryRun: parks nothing', readPending() === undefined);

// --- settings page: the archive tool follows the toggle without a reload -----
function routeFor(suffix) {
    return routes.filter((route) => route.path.endsWith(suffix)).at(-1);
}
function settingsReq(method, payload) {
    const listeners = {};
    const request = {
        method,
        url: '/api/dsh-session-handoff/settings',
        on(event, fn) { (listeners[event] ??= []).push(fn); return request; },
        destroy() {}
    };
    const response = {
        statusCode: 0,
        headers: {},
        text: '',
        setHeader(key, value) { this.headers[key] = value; },
        end(chunk) { this.text += chunk ?? ''; }
    };
    const applied = routeFor('/settings').handler(request, response);
    if (payload !== undefined) {
        setImmediate(() => {
            for (const fn of listeners.data ?? []) fn(Buffer.from(JSON.stringify(payload), 'utf8'));
            for (const fn of listeners.end ?? []) fn();
        });
    }
    return { response, applied };
}

{
    handlers.clear();
    tools.length = 0;
    routes.length = 0;
    apply(hostContext(), { mode: 'ask', dryRun: false, includeHistoryTool: true });
    check('settings wire: routes registered', routes.length === 4, String(routes.length));
    check('settings wire: archive tool starts on', tools.some((tool) => tool.name === 'handoff_history'));

    const off = settingsReq('POST', { values: { includeHistoryTool: false } });
    await off.applied;
    check('settings wire: toggling off unregisters the archive tool',
        !tools.some((tool) => tool.name === 'handoff_history'), tools.map((tool) => tool.name).join(','));
    check('settings wire: the handoff tool survives the toggle',
        tools.some((tool) => tool.name === 'session_handoff'), tools.map((tool) => tool.name).join(','));
    check('settings wire: the response reports the new value',
        JSON.parse(off.response.text).values.includeHistoryTool === false, off.response.text.slice(0, 120));

    const on = settingsReq('POST', { values: { includeHistoryTool: true } });
    await on.applied;
    const historyTools = tools.filter((tool) => tool.name === 'handoff_history');
    check('settings wire: toggling on re-registers exactly one', historyTools.length === 1, String(historyTools.length));
    check('settings wire: no duplicate handoff tools',
        tools.filter((tool) => tool.name === 'session_handoff').length === 1, tools.map((tool) => tool.name).join(','));

    const reset = settingsReq('POST', { reset: true });
    await reset.applied;
    check('settings wire: reset leaves the archive tool registered',
        tools.some((tool) => tool.name === 'handoff_history'));
}

// --- follow-up session, done by the host half --------------------------------
{
    handlers.clear();
    tools.length = 0;
    routes.length = 0;
    createdSessions.length = 0;
    prompts.length = 0;
    apply(hostContext(), {
        mode: 'ask', dryRun: false, askRatio: 0.5, autoRatio: 0.8, minRatio: 0.3, autoOpenSession: true
    });
    const followingPreStep = handlers.get('agent/pre-step')[0];
    const followingIdle = handlers.get('agent/status')[0];
    const followingTool = tools.find((tool) => tool.name === 'session_handoff');
    await followingPreStep({ agent }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [] }] }));
    const claimed = await followingTool.execute({ action: 'handoff' }, { agent });
    check('follow-up: the handoff is queued first', claimed.startsWith('QUEUED'), claimed);
    followingIdle({ agent, status: 'idle' });
    await new Promise((resolve) => setTimeout(resolve, 400));

    check('follow-up: the host session channel was used', createdSessions.length === 1, JSON.stringify(createdSessions));
    check('follow-up: it was created inside the owning workspace',
        createdSessions[0]?.workspaceId === 'ws-1', JSON.stringify(createdSessions[0]));
    check('follow-up: the new session is attached to that workspace',
        attached.includes('session-child'), JSON.stringify(attached));
    check('follow-up: the new session was prompted exactly once',
        prompts.length === 1 && prompts[0]?.sessionId === 'session-child', JSON.stringify(prompts.map((item) => item.sessionId)));
    check('follow-up: the prompt opens one turn',
        Array.isArray(prompts[0]?.content) && prompts[0].content[0]?.text === '继续', JSON.stringify(prompts[0]?.content));
    check('follow-up: the mode asks for a queued turn', prompts[0]?.mode === 'queue', String(prompts[0]?.mode));

    const answered = await invoke(routes.find((route) => route.path.endsWith('/status')), 'GET');
    check('follow-up: the status route reports the opened session',
        answered.body.followUp?.code === 'opened' && answered.body.followUp?.sessionId === 'session-child',
        JSON.stringify(answered.body.followUp));
}

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
