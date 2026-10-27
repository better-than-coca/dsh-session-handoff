/**
 * Operator settings written from the browser panel.
 *
 * The profile patch (cordis.patch.yml) stays the authoritative installed
 * configuration; this module owns only the handful of knobs the panel exposes,
 * and stores them beside the handoff records as one small JSON file.
 *
 * Precedence at load time: DEFAULTS < profile patch < settings.json. Deleting
 * the file therefore restores exactly what the patch says, which is the whole
 * point of keeping it separate: the plugin still never rewrites a host
 * configuration file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULTS } from './config.js';
import { handoffRoot } from './archive.js';

const MINUTE = 60 * 1000;

/**
 * The controls the browser panel draws, in display order.
 *
 * This array is the single source of truth for the panel: the browser half
 * renders whatever it receives from the Host instead of hard-coding limits, so
 * the two halves cannot drift.
 */
export const CONTROLS = Object.freeze([
    Object.freeze({ key: 'mode', kind: 'enum', options: Object.freeze(['ask', 'auto', 'off']), fallback: DEFAULTS.mode }),
    Object.freeze({ key: 'askRatio', kind: 'ratio', min: 0.3, max: 0.9, step: 0.05, fallback: DEFAULTS.askRatio }),
    Object.freeze({ key: 'autoRatio', kind: 'ratio', min: 0.5, max: 0.95, step: 0.05, fallback: DEFAULTS.autoRatio }),
    Object.freeze({ key: 'noticeCooldownMs', kind: 'duration', min: MINUTE, max: 60 * MINUTE, step: MINUTE, fallback: DEFAULTS.noticeCooldownMs }),
    Object.freeze({ key: 'dryRun', kind: 'boolean', fallback: DEFAULTS.dryRun }),
    Object.freeze({ key: 'maxHandoffsPerSession', kind: 'count', min: 1, max: 5, fallback: DEFAULTS.maxHandoffsPerSession }),
    Object.freeze({ key: 'includeHistoryTool', kind: 'boolean', fallback: DEFAULTS.includeHistoryTool }),
    Object.freeze({ key: 'autoOpenSession', kind: 'boolean', fallback: DEFAULTS.autoOpenSession })
]);

const CONTROL_KEYS = new Set(CONTROLS.map(control => control.key));

/** The file holding panel edits, beside the handoff records. */
export function settingsPath() {
    return join(dirname(handoffRoot()), 'dsh-session-handoff', 'settings.json');
}

/**
 * Coerce one incoming value to its control's domain.
 * @param control - the control declaration.
 * @param value - raw incoming value.
 * @returns the accepted value, or undefined when unacceptable.
 */
function accept(control, value) {
    if (control.kind === 'boolean') return typeof value === 'boolean' ? value : undefined;
    if (control.kind === 'enum') return control.options.includes(value) ? value : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const clamped = Math.min(control.max, Math.max(control.min, value));
    if (control.kind === 'count') {
        const rounded = Math.round(clamped);
        return Number.isSafeInteger(rounded) ? rounded : undefined;
    }
    if (control.kind === 'ratio') return Math.round(clamped * 100) / 100;
    if (control.kind === 'duration') return Math.round(clamped / control.step) * control.step;
    return clamped;
}

/**
 * Keep only known keys with acceptable values.
 * @param input - candidate settings object.
 * @returns a fresh object holding the accepted subset.
 */
export function sanitize(input) {
    const source = input !== null && typeof input === 'object' ? input : {};
    const out = {};
    for (const control of CONTROLS) {
        if (!(control.key in source)) continue;
        const value = accept(control, source[control.key]);
        if (value !== undefined) out[control.key] = value;
    }
    if (typeof out.askRatio === 'number' && typeof out.autoRatio === 'number'
        && out.autoRatio <= out.askRatio) {
        out.autoRatio = Math.min(0.95, Math.round((out.askRatio + 0.05) * 100) / 100);
    }
    return out;
}

/**
 * Read the stored overrides.
 * @returns the stored object, or an empty object when absent or unreadable.
 */
export function readSettings() {
    const file = settingsPath();
    if (!existsSync(file)) return {};
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const values = parsed !== null && typeof parsed === 'object' && parsed.values !== undefined
            ? parsed.values
            : parsed;
        return sanitize(values);
    } catch {
        // A corrupt file must never stop the plugin from loading; the patch wins.
        return {};
    }
}

/**
 * Merge a patch into the stored overrides and persist the result.
 * @param patch - keys to change; a value of null removes that key.
 * @returns the stored overrides after the write.
 */
export function writeSettings(patch) {
    const next = { ...readSettings() };
    const incoming = patch !== null && typeof patch === 'object' ? patch : {};
    for (const key of Object.keys(incoming)) {
        if (CONTROL_KEYS.has(key) && incoming[key] === null) delete next[key];
    }
    Object.assign(next, sanitize(incoming));
    const file = settingsPath();
    mkdirSync(dirname(file), { recursive: true });
    const payload = JSON.stringify({ version: 1, updatedAt: Date.now(), values: next }, null, 2);
    const temp = file + '.tmp-' + String(process.pid);
    writeFileSync(temp, payload, 'utf8');
    renameSync(temp, file);
    return next;
}

/**
 * Drop every stored override, restoring the profile patch's values.
 * @returns true when a file was removed.
 */
export function clearSettings() {
    const file = settingsPath();
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
}

/**
 * Shape the panel's read payload.
 * @param effective - the configuration currently in force.
 * @returns controls, effective values, and the raw overrides.
 */
export function describe(effective) {
    const overrides = readSettings();
    const values = {};
    for (const control of CONTROLS) {
        const value = effective === undefined || effective === null ? undefined : effective[control.key];
        values[control.key] = value === undefined ? control.fallback : value;
    }
    return {
        controls: CONTROLS.map(control => ({ ...control })),
        values,
        overrides,
        path: settingsPath()
    };
}
