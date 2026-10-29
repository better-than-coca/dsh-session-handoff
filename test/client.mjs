
/**
 * Client-half regression suite.
 *
 * Plugin packages run behind the dynamic ctx facade the runner builds for them:
 * reading \`ctx.serviceName\` is gated by the plugin's own \`inject\` declaration
 * and throws for anything else, while \`ctx.get(name)\` is the optional lookup
 * that works for undeclared services too. The settings page closes itself by
 * calling \`layout.selectPanel(null)\`, so a panel that reads \`ctx.layout\`
 * directly ends up with a click that silently does nothing — the regression
 * this suite guards.
 */

const entries = [];
globalThis.window = { __ModuleLoader__: { load: entry => entries.push(entry) } };

const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: value => [value, () => {}],
    useEffect: () => {},
    useRef: value => ({ current: value })
};

await import('../client.js');
const factory = entries[0].factory;

let failures = 0;
const check = (name, cond, detail) => {
    if (cond) { console.log('PASS ' + name); return; }
    failures += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
};

const CTX_VERBS = new Set(['effect', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce']);

/** The runner's facade: declared services answer, undeclared reads throw. */
function facade(services, declared) {
    const declaredSet = new Set(declared);
    return new Proxy({}, {
        get(_target, prop) {
            if (prop === 'get') return name => services[name];
            if (typeof prop !== 'string') return undefined;
            if (CTX_VERBS.has(prop)) return () => undefined;
            if (declaredSet.has(prop)) return services[prop];
            throw new Error('service "' + prop + '" is not declared by your plugin');
        }
    });
}

function slotsRecorder(registrations) {
    return {
        inject: (_name, callback) => { callback(); return () => {}; },
        register: (spec, component) => {
            registrations.push({ spec, component });
            return () => {};
        }
    };
}

const plugin = factory(name => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
});

check('client: declares the slots seat', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), String(plugin.inject));
check('client: exposes apply', typeof plugin.apply === 'function');

// --- a host that has both the layout and the navigation service ---
const calls = [];
const registrations = [];
const services = {
    slots: slotsRecorder(registrations),
    layout: { selectPanel: id => { calls.push(id); } }
};

let applyError = null;
try {
    plugin.apply(facade(services, ['slots']));
} catch (error) {
    applyError = error;
}
check('client: mounts against a dynamic facade', applyError === null, applyError && applyError.message);

const main = registrations.find(entry => entry.spec.name === 'main');
check('client: registers the settings page', main !== undefined);
check('client: page is keyed', main !== undefined && typeof main.spec.key === 'string');
check('client: registers the sidebar row', registrations.some(entry => entry.spec.name === 'sidebar.panellist'));

const injected = main === undefined ? {} : main.spec.inject();
check('client: page receives a close handler', typeof injected.close === 'function');

let closeError = null;
try {
    injected.close();
} catch (error) {
    closeError = error;
}
check('client: close does not throw', closeError === null, closeError && closeError.message);
check('client: close returns to the conversation', calls.length === 1 && calls[0] === null, JSON.stringify(calls));

// --- a host without a layout service: the panel simply stays open ---
const bare = [];
let bareError = null;
try {
    plugin.apply(facade({ slots: slotsRecorder(bare) }, ['slots']));
} catch (error) {
    bareError = error;
}
check('client: mounts without a layout service', bareError === null, bareError && bareError.message);

const bareMain = bare.find(entry => entry.spec.name === 'main');
let bareCloseError = null;
try {
    bareMain.spec.inject().close();
} catch (error) {
    bareCloseError = error;
}
check('client: close without a layout service is a no-op', bareCloseError === null, bareCloseError && bareCloseError.message);

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
if (failures > 0) process.exitCode = 1;
