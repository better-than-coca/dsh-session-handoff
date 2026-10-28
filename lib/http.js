/**
 * Browser-facing routes for the handoff button.
 *
 * The button lives in the assistant message action row (client half), but the
 * handoff itself needs the live Agent: it summarizes the session surface and the
 * checkpoint must park outside the session. So the client half cannot trigger it
 * directly and asks these two routes instead.
 *
 * Nothing here is reachable from the web until the plugin's Host half registers
 * them, and nothing here can mutate the outgoing session: the only side effect is
 * the handoff record under <dsh home>/handoff, written by the same code path the
 * `session_handoff` tool uses.
 */

const STATUS_PATH = '/api/dsh-session-handoff/status';
const HANDOFF_PATH = '/api/dsh-session-handoff/handoff';
const SETTINGS_PATH = '/api/dsh-session-handoff/settings';
const ATTACH_PATH = '/api/dsh-session-handoff/attach';
/** A status read is a projection lookup; a handoff may start an LLM call. */
const MAX_BODY_BYTES = 4096;

/**
 * Answer with JSON, never a partial write.
 * @param res - node response.
 * @param status - HTTP status code.
 * @param body - serializable payload.
 */
function writeJson(res, status, body) {
    let text;
    try {
        text = JSON.stringify(body);
    } catch {
        text = '{"ok":false,"error":"unserializable response"}';
        status = 500;
    }
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(text);
}

/**
 * Read a small JSON body, tolerating an empty one.
 * @param req - node request.
 * @returns parsed object, or an empty object.
 */
function readJsonBody(req) {
    return new Promise((resolve) => {
        let size = 0;
        const chunks = [];
        const done = (value) => resolve(value);
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                done({});
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (chunks.length === 0) {
                done({});
                return;
            }
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                done(parsed !== null && typeof parsed === 'object' ? parsed : {});
            } catch {
                done({});
            }
        });
        req.on('error', () => done({}));
    });
}

/**
 * Register both routes.
 * @param server - `ctx.webServer`.
 * @param deps - `{ report, request, resolve }` from the plugin body.
 * @returns a disposer releasing both routes.
 */
export function registerHandoffRoutes(server, deps) {
    const disposers = [];

    disposers.push(server.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req, res) => {
            try {
                if (req?.method && req.method !== 'GET') {
                    writeJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                const url = new URL(req.url ?? '/', 'http://localhost');
                const sessionId = url.searchParams.get('sessionId') ?? undefined;
                writeJson(res, 200, { ok: true, ...deps.report(sessionId) });
            } catch (error) {
                writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        }
    }));

    disposers.push(server.register({
        kind: 'exact',
        path: HANDOFF_PATH,
        handler: async (req, res) => {
            try {
                if (req?.method && req.method !== 'POST') {
                    writeJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                const body = await readJsonBody(req);
                const requested = typeof body.sessionId === 'string' ? body.sessionId : undefined;
                const agent = deps.resolve(requested);
                if (agent === undefined) {
                    // The Host owns which Sessions have a live Agent; it names the
                    // refusal so the button can tell a dormant conversation from an
                    // empty host.
                    const absent = typeof deps.absent === 'function'
                        ? deps.absent(requested)
                        : { ok: false, code: 'no-live-session', error: 'no live session to hand off' };
                    writeJson(res, 409, absent);
                    return;
                }
                const target = typeof body.targetDir === 'string' && body.targetDir.trim() !== ''
                    ? { path: body.targetDir, create: body.createTargetDir === true }
                    : undefined;
                const result = deps.request(agent, target);
                writeJson(res, result?.ok === true ? 200 : 409, result);
            } catch (error) {
                writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        }
    }));

    disposers.push(server.register({
        kind: 'exact',
        path: ATTACH_PATH,
        handler: async (req, res) => {
            try {
                if (req?.method && req.method !== 'POST') {
                    writeJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                const body = await readJsonBody(req);
                if (typeof body.sessionId !== 'string' || body.sessionId === ''
                    || typeof body.cwd !== 'string' || body.cwd === '') {
                    writeJson(res, 400, { ok: false, code: 'bad-request', error: 'sessionId and cwd are required' });
                    return;
                }
                const result = await deps.attach(body.sessionId, body.cwd);
                writeJson(res, result?.ok === true ? 200 : 409, result);
            } catch (error) {
                writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        }
    }));

    disposers.push(server.register({
        kind: 'exact',
        path: SETTINGS_PATH,
        handler: async (req, res) => {
            try {
                // One handler per exact path: the server keys routes by path, so a
                // second registration for the same path would never be reached.
                const method = req?.method ?? 'GET';
                if (method === 'GET') {
                    writeJson(res, 200, { ok: true, ...deps.settings.describe() });
                    return;
                }
                if (method !== 'POST') {
                    writeJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                const body = await readJsonBody(req);
                const values = body.values !== null && typeof body.values === 'object' ? body.values : body;
                const payload = body.reset === true ? deps.settings.reset() : deps.settings.update(values);
                writeJson(res, 200, { ok: true, ...payload });
            } catch (error) {
                writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        }
    }));

    return () => {
        for (const release of disposers.splice(0)) {
            if (typeof release !== 'function') continue;
            try {
                release();
            } catch {
                // A failing route disposer must not block the other one.
            }
        }
    };
}
