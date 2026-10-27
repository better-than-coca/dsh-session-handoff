import { resolveConfig, DEFAULTS } from '../lib/config.js';
import { readPressure, formatPressure } from '../lib/pressure.js';
import { sessionEvents, searchEvents, readEventDetail, eventText } from '../lib/history.js';
import { refusalReasons } from '../lib/handoff.js';

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log('PASS ' + name); return; }
    failures += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}

// --- config ---
const cfg = resolveConfig({ mode: 'auto', askRatio: 0.5, autoRatio: 0.7, dryRun: false, maxHandoffsPerSession: 2 });
check('config: valid values applied', cfg.mode === 'auto' && cfg.askRatio === 0.5 && cfg.autoRatio === 0.7 && cfg.dryRun === false && cfg.maxHandoffsPerSession === 2);
const bad = [];
const cfg2 = resolveConfig({ mode: 'nope', askRatio: 2, dryRun: 'yes', maxHandoffsPerSession: -1 }, (m) => bad.push(m));
check('config: invalid values fall back', cfg2.mode === 'ask' && cfg2.askRatio === DEFAULTS.askRatio && cfg2.dryRun === true && cfg2.maxHandoffsPerSession === 1);
check('config: invalid values reported', bad.length === 4, 'reported=' + bad.length);
const cfg3 = resolveConfig({ askRatio: 0.9, autoRatio: 0.4 });
check('config: ask>auto resets to defaults', cfg3.askRatio === DEFAULTS.askRatio && cfg3.autoRatio === DEFAULTS.autoRatio);
check('config: frozen', Object.isFrozen(cfg));

// --- pressure ---
const session = {
    id: 'session-a',
    header: { isSeeded: false, delegationDepth: 0 },
    events: [
        { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '我们来做上下文交接插件' }] } },
        { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，先看宿主 API' }] } } },
        { seq: 2, type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: 'compactNow(agent, signal)' }] } } }
    ]
};
const fakeCtx = { get: (name) => name === 'sessionProjections' ? { snapshot: () => ({ values: { contextPressure: { pressureTokens: 0, projectedTokens: 620000, contextWindow: 1000000 } } }) } : undefined };
const reading = readPressure(fakeCtx, session);
check('pressure: reads projection', reading !== null && Math.abs(reading.ratio - 0.62) < 1e-9, JSON.stringify(reading));
check('pressure: formats', formatPressure(reading) === '62.0% (620k / 1000k)', formatPressure(reading));
check('pressure: null without projections', readPressure({ get: () => undefined }, session) === null);

// --- history ---
check('history: snapshot falls back to events', sessionEvents(session).length === 3);
const hits = searchEvents(sessionEvents(session), 'compactNow', 5);
check('history: literal search finds seq', hits.length === 1 && hits[0].seq === 2, JSON.stringify(hits));
check('history: search miss', searchEvents(sessionEvents(session), 'zzz-none', 5).length === 0);
const detail = readEventDetail(sessionEvents(session), 1, 1, 0);
check('history: read includes neighbours', detail.includes('>> [1]') && detail.includes('[0]'), detail);
check('history: unknown seq', readEventDetail(sessionEvents(session), 99, 0, 0).startsWith('No event at seq'));
check('history: eventText on tool result', eventText(session.events[2]).includes('compactNow'));

// --- guards ---
const st = { counts: new WeakMap(), handoffs: new WeakMap(), busy: new WeakSet(), pending: new WeakSet(), notifiedAt: new WeakMap(), routed: new WeakSet(), doneNotified: new WeakSet(), autoTried: new WeakSet() };
check('guard: plain session allowed', refusalReasons(session, cfg, st).length === 0);
const child = { id: 'session-b', header: { isSeeded: true, delegationDepth: 0 }, events: session.events };
check('guard: seeded child refused', refusalReasons(child, cfg, st).some((r) => r.includes('forked child')));
const sub = { id: 'session-c', header: { isSeeded: false, delegationDepth: 1 }, events: [] };
check('guard: subagent refused', refusalReasons(sub, cfg, st).some((r) => r.includes('subagent')));
st.counts.set(session, 2);
check('guard: limit enforced', refusalReasons(session, cfg, st).some((r) => r.includes('limit reached')));

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
