/**
 * Settings persistence and the two settings routes.
 *
 * Every test runs against a throwaway DSH home so the real profile is never
 * touched, and the fake server keeps node's HTTP stack out of the picture.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'handoff-settings-'));
process.env.DSH_SESSION_HANDOFF_HOME = home;

const {
    CONTROLS, sanitize, readSettings, writeSettings, clearSettings, settingsPath, describe
} = await import('../lib/settings.js');
const { registerHandoffRoutes } = await import('../lib/http.js');
const { DEFAULTS, resolveConfig } = await import('../lib/config.js');

let failed = 0;
function check(name, ok, detail) {
    if (ok) {
        console.log('PASS ' + name);
        return;
    }
    failed += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}

// --- control table ----------------------------------------------------------
{
    const keys = CONTROLS.map(control => control.key);
    check('controls: eight knobs', CONTROLS.length === 8, String(CONTROLS.length));
    check('controls: no duplicate keys', new Set(keys).size === keys.length);
    check('controls: every key exists in DEFAULTS', keys.every(key => key in DEFAULTS), keys.join(','));
    check('controls: every knob has a fallback', CONTROLS.every(control => control.fallback !== undefined));
    check('controls: bounds are ordered', CONTROLS.every(control =>
        control.min === undefined || control.min < control.max));
    check('controls: the follow-up switch is a boolean',
        CONTROLS.some(control => control.key === 'autoOpenSession' && control.kind === 'boolean'));
}

// --- sanitize ---------------------------------------------------------------
{
    check('sanitize: keeps a valid enum', sanitize({ mode: 'auto' }).mode === 'auto');
    check('sanitize: drops an unknown enum', sanitize({ mode: 'sometimes' }).mode === undefined);
    check('sanitize: drops an unknown key', sanitize({ nope: 1 }).nope === undefined);
    check('sanitize: rejects a non-boolean', sanitize({ dryRun: 'yes' }).dryRun === undefined);
    check('sanitize: keeps the follow-up switch', sanitize({ autoOpenSession: false }).autoOpenSession === false);
    check('sanitize: clamps a ratio above the ceiling', sanitize({ askRatio: 0.99 }).askRatio === 0.9);
    check('sanitize: clamps a ratio below the floor', sanitize({ askRatio: 0.01 }).askRatio === 0.3);
    check('sanitize: rounds a ratio to two decimals', sanitize({ askRatio: 0.611 }).askRatio === 0.61);
    check('sanitize: rounds a count', sanitize({ maxHandoffsPerSession: 2.6 }).maxHandoffsPerSession === 3);
    check('sanitize: clamps a count to the ceiling', sanitize({ maxHandoffsPerSession: 99 }).maxHandoffsPerSession === 5);
    check('sanitize: snaps a duration to the step', sanitize({ noticeCooldownMs: 125000 }).noticeCooldownMs === 120000);
    check('sanitize: clamps a duration to the floor', sanitize({ noticeCooldownMs: 1 }).noticeCooldownMs === 60000);
    check('sanitize: rejects NaN', sanitize({ askRatio: Number.NaN }).askRatio === undefined);

    const fixed = sanitize({ askRatio: 0.8, autoRatio: 0.8 });
    check('sanitize: pushes auto above ask when they collide', fixed.autoRatio === 0.85, JSON.stringify(fixed));
    const fixed2 = sanitize({ askRatio: 0.9, autoRatio: 0.5 });
    check('sanitize: never exceeds the auto ceiling', fixed2.autoRatio <= 0.95, JSON.stringify(fixed2));
    const apart = sanitize({ askRatio: 0.5, autoRatio: 0.8 });
    check('sanitize: leaves a valid pair alone', apart.askRatio === 0.5 && apart.autoRatio === 0.8);
}

// --- persistence ------------------------------------------------------------
{
    check('file: path sits under the plugin directory', settingsPath().endsWith(join('dsh-session-handoff', 'settings.json')));
    check('file: starts empty', Object.keys(readSettings()).length === 0);

    writeSettings({ mode: 'auto', dryRun: false });
    const stored = readSettings();
    check('file: round-trips a write', stored.mode === 'auto' && stored.dryRun === false, JSON.stringify(stored));

    writeSettings({ askRatio: 0.65 });
    const merged = readSettings();
    check('file: merges instead of replacing', merged.mode === 'auto' && merged.askRatio === 0.65, JSON.stringify(merged));

    writeSettings({ mode: null });
    check('file: null removes a key', readSettings().mode === undefined);
    check('file: other keys survive the removal', readSettings().askRatio === 0.65);

    check('file: clear reports work done', clearSettings() === true);
    check('file: clear empties the store', Object.keys(readSettings()).length === 0);
    check('file: clear is idempotent', clearSettings() === false);

    mkdirSync(join(home, 'dsh-session-handoff'), { recursive: true });
    writeFileSync(settingsPath(), '{ this is not json', 'utf8');
    check('file: a corrupt file reads as empty', Object.keys(readSettings()).length === 0);
    clearSettings();
}

// --- describe ---------------------------------------------------------------
{
    const effective = resolveConfig({ mode: 'ask', askRatio: 0.5 });
    const payload = describe(effective);
    check('describe: carries every control', payload.controls.length === CONTROLS.length);
    check('describe: carries every value', Object.keys(payload.values).length === CONTROLS.length);
    check('describe: reports the effective ratio', payload.values.askRatio === 0.5);
    check('describe: reports the effective mode', payload.values.mode === 'ask');
    check('describe: reports the file path', payload.path === settingsPath());
    check('describe: empty overrides by default', Object.keys(payload.overrides).length === 0);
    check('describe: survives an undefined config', describe(undefined).values.mode === DEFAULTS.mode);
}

// --- routes -----------------------------------------------------------------
function makeServer() {
    const routes = [];
    return { routes, register(route) { routes.push(route); return () => { route.released = true; }; } };
}
function makeReq(method, url, body) {
    const listeners = {};
    const req = {
        method, url,
        on(event, fn) { (listeners[event] ??= []).push(fn); return req; },
        destroy() { req.destroyed = true; }
    };
    setImmediate(() => {
        if (body !== undefined) for (const fn of listeners.data ?? []) fn(Buffer.from(body, 'utf8'));
        for (const fn of listeners.end ?? []) fn();
    });
    return req;
}
function makeRes() {
    return {
        statusCode: 0, headers: {}, text: '',
        setHeader(key, value) { this.headers[key] = value; },
        end(chunk) { this.text += chunk ?? ''; }
    };
}
const settle = async route => {
    const res = makeRes();
    route.handler(makeReq('POST', '/api/dsh-session-handoff/settings', undefined), res);
    for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
    return res;
};

{
    let live = resolveConfig({ mode: 'ask' });
    const server = makeServer();
    registerHandoffRoutes(server, {
        report: () => ({}),
        request: () => ({ ok: true }),
        resolve: () => undefined,
        settings: {
            describe: () => describe(live),
            update(values) {
                writeSettings(values);
                live = resolveConfig({ ...readSettings() });
                return describe(live);
            },
            reset() {
                clearSettings();
                live = resolveConfig({});
                return describe(live);
            }
        }
    });
    const settingsRoute = server.routes.find(route => route.path.endsWith('/settings'));
    check('routes: four paths are served', new Set(server.routes.map(r => r.path)).size === 4);
    check('routes: one handler serves the settings path', server.routes.filter(route => route.path.endsWith('/settings')).length === 1);
    check('routes: the settings handler exists', settingsRoute !== undefined);

    const getRoute = settingsRoute;
    const getRes = makeRes();
    getRoute.handler(makeReq('GET', '/api/dsh-session-handoff/settings'), getRes);
    const body = JSON.parse(getRes.text);
    check('routes: GET settings is 200', getRes.statusCode === 200, String(getRes.statusCode));
    check('routes: GET settings carries controls', Array.isArray(body.controls) && body.controls.length === CONTROLS.length);
    check('routes: GET settings carries values', body.values.mode === 'ask');

    const wrongMethod = makeRes();
    getRoute.handler(makeReq('PUT', '/api/dsh-session-handoff/settings'), wrongMethod);
    check('routes: an unsupported method is 405', wrongMethod.statusCode === 405, String(wrongMethod.statusCode));

    const postRoute = settingsRoute;
    const postRes = makeRes();
    postRoute.handler(makeReq('POST', '/api/dsh-session-handoff/settings', JSON.stringify({ values: { mode: 'auto', askRatio: 0.6 } })), postRes);
    for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
    const posted = JSON.parse(postRes.text);
    check('routes: POST settings is 200', postRes.statusCode === 200, String(postRes.statusCode));
    check('routes: POST settings applies the value', posted.values.mode === 'auto', JSON.stringify(posted.values));
    check('routes: POST settings persists the value', readSettings().mode === 'auto');
    check('routes: POST settings restates the controls', posted.controls.length === CONTROLS.length);

    const resetRes = makeRes();
    postRoute.handler(makeReq('POST', '/api/dsh-session-handoff/settings', JSON.stringify({ reset: true })), resetRes);
    for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
    const resetBody = JSON.parse(resetRes.text);
    check('routes: reset removes the file', Object.keys(readSettings()).length === 0);
    check('routes: reset restores the default', resetBody.values.mode === 'ask', JSON.stringify(resetBody.values));

    const readBack = makeRes();
    postRoute.handler(makeReq('GET', '/api/dsh-session-handoff/settings'), readBack);
    check('routes: the same handler answers GET', readBack.statusCode === 200, String(readBack.statusCode));

    const bare = makeRes();
    postRoute.handler(makeReq('POST', '/api/dsh-session-handoff/settings', JSON.stringify({ mode: 'off' })), bare);
    for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
    check('routes: POST accepts a bare patch', JSON.parse(bare.text).values.mode === 'off');

    const throwing = makeServer();
    registerHandoffRoutes(throwing, {
        report: () => ({}),
        request: () => ({ ok: true }),
        resolve: () => undefined,
        settings: {
            describe: () => { throw new Error('nope'); },
            update: () => { throw new Error('nope'); },
            reset: () => { throw new Error('nope'); }
        }
    });
    const boom = makeRes();
    throwing.routes[0].handler(makeReq('GET', '/api/dsh-session-handoff/status'), boom);
    const boomGet = makeRes();
    throwing.routes.find(route => route.path.endsWith('/settings')).handler(makeReq('GET', '/api/dsh-session-handoff/settings'), boomGet);
    check('routes: a throwing describe becomes 500', boomGet.statusCode === 500, String(boomGet.statusCode));
    check('routes: 500 is still JSON', JSON.parse(boomGet.text).ok === false);
    void settle;
}

rmSync(home, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
