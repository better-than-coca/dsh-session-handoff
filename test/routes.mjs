/**
 * Route tests for the browser half's two endpoints.
 *
 * These run with a fake server and fake req/res objects: the contract under test
 * is "never throw, never leak, always JSON", not node's HTTP stack.
 */

import { registerHandoffRoutes } from '../lib/http.js';

let failed = 0;
function check(name, ok, detail) {
    if (ok) {
        console.log('PASS ' + name);
        return;
    }
    failed += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}

function makeServer() {
    const routes = [];
    return {
        routes,
        register(route) {
            routes.push(route);
            let released = false;
            return () => {
                released = true;
                route.released = true;
            };
        }
    };
}

function makeReq(method, url, body) {
    const listeners = {};
    const req = {
        method,
        url,
        on(event, fn) {
            (listeners[event] ??= []).push(fn);
            return req;
        },
        destroy() {
            req.destroyed = true;
        }
    };
    setImmediate(() => {
        if (body !== undefined) for (const fn of listeners.data ?? []) fn(Buffer.from(body, 'utf8'));
        for (const fn of listeners.end ?? []) fn();
    });
    return req;
}

function makeRes() {
    const res = {
        statusCode: 0,
        headers: {},
        text: '',
        setHeader(key, value) {
            res.headers[key] = value;
        },
        end(chunk) {
            res.text += chunk ?? '';
        }
    };
    return res;
}

const call = (route, method, url, body) => {
    const res = makeRes();
    route.handler(makeReq(method, url, body), res);
    return res;
};

const callAsync = async (route, method, url, body) => {
    const res = makeRes();
    route.handler(makeReq(method, url, body), res);
    // The handoff route awaits its body; give the microtask queue a turn.
    for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
    return res;
};

const json = res => JSON.parse(res.text);

// --- status route -----------------------------------------------------------
{
    const server = makeServer();
    const seen = [];
    registerHandoffRoutes(server, {
        report: sessionId => {
            seen.push(sessionId);
            return { sessionId: 's-1', mode: 'ask', dryRun: false, pressure: { ratio: 0.42 }, pending: 'none' };
        },
        request: () => ({ ok: true }),
        resolve: () => undefined
    });
    check('routes: four handlers registered, one per path', server.routes.length === 4, String(server.routes.length));
    check('routes: paths are exact', server.routes.every(route => route.kind === 'exact'));

    const status = server.routes.find(route => route.path.endsWith('/status'));
    const res = call(status, 'GET', '/api/dsh-session-handoff/status?sessionId=s-1');
    const body = json(res);
    check('status: 200', res.statusCode === 200, String(res.statusCode));
    check('status: json content type', String(res.headers['content-type']).includes('application/json'));
    check('status: no-store', res.headers['cache-control'] === 'no-store');
    check('status: forwards ok', body.ok === true);
    check('status: forwards the session id from the query', seen[0] === 's-1', String(seen[0]));
    check('status: carries the report', body.mode === 'ask' && body.pending === 'none');

    const missing = call(status, 'GET', '/api/dsh-session-handoff/status');
    check('status: omitted session id passes undefined', seen[1] === undefined, String(seen[1]));
    check('status: omitted session id still answers', json(missing).ok === true);

    const wrong = call(status, 'POST', '/api/dsh-session-handoff/status');
    check('status: rejects POST', wrong.statusCode === 405, String(wrong.statusCode));
    check('status: rejection is JSON', json(wrong).ok === false);

    const crashed = registerHandoffRoutes(makeServer(), {
        report: () => {
            throw new Error('boom');
        },
        request: () => ({ ok: true }),
        resolve: () => undefined
    });
    const bad = makeRes();
    void crashed;
}

// --- status route error handling -------------------------------------------
{
    const server = makeServer();
    registerHandoffRoutes(server, {
        report: () => {
            throw new Error('boom');
        },
        request: () => ({ ok: true }),
        resolve: () => undefined
    });
    const status = server.routes.find(route => route.path.endsWith('/status'));
    const res = call(status, 'GET', '/api/dsh-session-handoff/status');
    check('status: a throwing report becomes 500', res.statusCode === 500, String(res.statusCode));
    check('status: 500 is still JSON', json(res).ok === false && json(res).error === 'boom');
}

// --- handoff route ----------------------------------------------------------
{
    const server = makeServer();
    let requested = null;
    registerHandoffRoutes(server, {
        report: () => ({ ok: true }),
        request: agent => {
            requested = agent;
            return { ok: true, running: true };
        },
        resolve: sessionId => (sessionId === 's-9' ? { session: { id: 's-9' } } : undefined)
    });
    const handoff = server.routes.find(route => route.path.endsWith('/handoff'));

    const okRes = await callAsync(handoff, 'POST', '/api/dsh-session-handoff/handoff', JSON.stringify({ sessionId: 's-9' }));
    check('handoff: 200 when the session resolves', okRes.statusCode === 200, String(okRes.statusCode));
    check('handoff: reports running', json(okRes).running === true);
    check('handoff: resolved the requested session', requested !== null && requested.session.id === 's-9');

    const unknownRes = await callAsync(handoff, 'POST', '/api/dsh-session-handoff/handoff', JSON.stringify({ sessionId: 'nope' }));
    check('handoff: 409 for an unknown session', unknownRes.statusCode === 409, String(unknownRes.statusCode));
    check('handoff: 409 names the reason', json(unknownRes).code === 'no-live-session');

    const refused = registerHandoffRoutes(makeServer(), {
        report: () => ({ ok: true }),
        request: () => ({ ok: false, code: 'refused', error: 'nothing to summarize' }),
        resolve: () => ({ session: { id: 's-9' } })
    });
    void refused;

    const emptyBody = await callAsync(handoff, 'POST', '/api/dsh-session-handoff/handoff');
    check('handoff: tolerates an empty body', emptyBody.statusCode === 409);

    const wrong = await callAsync(handoff, 'GET', '/api/dsh-session-handoff/handoff');
    check('handoff: rejects GET', wrong.statusCode === 405, String(wrong.statusCode));
}

// --- dormant session refusal -------------------------------------------------
{
    const server = makeServer();
    registerHandoffRoutes(server, {
        report: () => ({ ok: true }),
        request: () => ({ ok: true, running: true }),
        resolve: () => undefined,
        absent: sessionId => (typeof sessionId === 'string' && sessionId !== ''
            ? { ok: false, code: 'session-dormant', error: 'not loaded yet' }
            : { ok: false, code: 'no-live-session', error: 'no live session to hand off' })
    });
    const handoff = server.routes.find(route => route.path.endsWith('/handoff'));
    const dormant = await callAsync(handoff, 'POST', '/api/dsh-session-handoff/handoff', '{"sessionId":"s-7"}');
    check('handoff: a named but dormant session is 409', dormant.statusCode === 409, String(dormant.statusCode));
    check('handoff: the refusal names dormancy', json(dormant).code === 'session-dormant', String(json(dormant).code));
    const none = await callAsync(handoff, 'POST', '/api/dsh-session-handoff/handoff');
    check('handoff: no name still means no live session', json(none).code === 'no-live-session', String(json(none).code));
}

// --- attach route ------------------------------------------------------------
{
    const server = makeServer();
    const seen = [];
    registerHandoffRoutes(server, {
        report: () => ({ ok: true }),
        request: () => ({ ok: true }),
        resolve: () => undefined,
        attach: async (sessionId, cwd) => {
            seen.push([sessionId, cwd]);
            return { ok: true, sessionId, workspaceId: 'w-1' };
        }
    });
    const attach = server.routes.find(route => route.path.endsWith('/attach'));
    check('attach: the route exists', attach !== undefined);
    const res = await callAsync(attach, 'POST', '/api/dsh-session-handoff/attach', JSON.stringify({ sessionId: 's-1', cwd: 'E:\\dsh' }));
    check('attach: 200 for a valid request', res.statusCode === 200, String(res.statusCode));
    check('attach: forwards both fields', seen[0] !== undefined && seen[0][0] === 's-1' && seen[0][1] === 'E:\\dsh', JSON.stringify(seen));
    check('attach: reports the workspace', json(res).workspaceId === 'w-1', String(json(res).workspaceId));
    const bad = await callAsync(attach, 'POST', '/api/dsh-session-handoff/attach', JSON.stringify({ sessionId: 's-1' }));
    check('attach: 400 without a directory', bad.statusCode === 400, String(bad.statusCode));
    const wrong = await callAsync(attach, 'GET', '/api/dsh-session-handoff/attach');
    check('attach: rejects GET', wrong.statusCode === 405, String(wrong.statusCode));
}

// --- handoff route refusal and failure --------------------------------------
{
    const server = makeServer();
    registerHandoffRoutes(server, {
        report: () => ({ ok: true }),
        request: () => ({ ok: false, code: 'refused', error: 'nothing to summarize' }),
        resolve: () => ({ session: { id: 's-9' } })
    });
    const handoff = server.routes.find(route => route.path.endsWith('/handoff'));
    const res = await callAsync(handoff, 'POST', '/api/dsh-session-handoff/handoff', '{"sessionId":"s-9"}');
    check('handoff: refusal is 409', res.statusCode === 409, String(res.statusCode));
    check('handoff: refusal carries the reason', json(res).error === 'nothing to summarize');
}

{
    const server = makeServer();
    registerHandoffRoutes(server, {
        report: () => ({ ok: true }),
        request: () => {
            throw new Error('kaboom');
        },
        resolve: () => ({ session: { id: 's-9' } })
    });
    const handoff = server.routes.find(route => route.path.endsWith('/handoff'));
    const res = await callAsync(handoff, 'POST', '/api/dsh-session-handoff/handoff', '{"sessionId":"s-9"}');
    check('handoff: a throwing request becomes 500', res.statusCode === 500, String(res.statusCode));
    check('handoff: 500 is still JSON', json(res).ok === false);
}

// --- disposer ---------------------------------------------------------------
{
    const server = makeServer();
    const dispose = registerHandoffRoutes(server, {
        report: () => ({ ok: true }),
        request: () => ({ ok: true }),
        resolve: () => undefined
    });
    check('disposer: is a function', typeof dispose === 'function');
    dispose();
    check('disposer: released every route', server.routes.every(route => route.released === true));
    dispose();
    check('disposer: is idempotent', true);
}

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
