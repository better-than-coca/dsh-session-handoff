/**
 * Configuration resolution and validation for dsh-session-handoff.
 * Every value is validated once at plugin load; a bad value never throws into
 * the host loader, it falls back to the documented default and is reported.
 */

export const DEFAULTS = Object.freeze({
    /** off | ask | auto */
    mode: 'ask',
    /** Safety default: only report what would happen. */
    dryRun: true,
    /** Ratio of the model context window at which the model is asked to check in. */
    askRatio: 0.55,
    /** Ratio at which auto mode performs the handoff without asking. */
    autoRatio: 0.75,
    /** Never hand off below this ratio, even if requested. */
    minRatio: 0.3,
    /** Hard cap: refuse further handoffs once reached for the same session. */
    maxHandoffsPerSession: 1,
    /** Register the handoff_history lookup tool. */
    includeHistoryTool: true,
    /** Open a brand-new session and continue there once the checkpoint is parked. */
    autoOpenSession: true,
    /** Minimum gap between two "context is filling up" notices. */
    noticeCooldownMs: 10 * 60 * 1000,
    /** Timeout for the summarization request that builds the checkpoint. */
    summarizeTimeoutMs: 180000
});

const RATIO_KEYS = ['askRatio', 'autoRatio', 'minRatio'];

function isRatio(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
}

/**
 * Merge user configuration over the defaults, rejecting invalid values.
 * @param raw - configuration object supplied by the loader.
 * @param warn - reporter used for every rejected value.
 * @returns a frozen resolved configuration.
 */
export function resolveConfig(raw, warn = () => {}) {
    const input = raw !== null && typeof raw === 'object' ? raw : {};
    const resolved = { ...DEFAULTS };

    if (input.mode !== undefined) {
        if (input.mode === 'off' || input.mode === 'ask' || input.mode === 'auto') resolved.mode = input.mode;
        else warn('mode must be one of off|ask|auto; using ' + DEFAULTS.mode);
    }
    if (input.dryRun !== undefined) {
        if (typeof input.dryRun === 'boolean') resolved.dryRun = input.dryRun;
        else warn('dryRun must be a boolean; using ' + DEFAULTS.dryRun);
    }
    for (const key of RATIO_KEYS) {
        if (input[key] === undefined) continue;
        if (isRatio(input[key])) resolved[key] = input[key];
        else warn(key + ' must be a number in (0, 1); using ' + DEFAULTS[key]);
    }
    if (!(resolved.askRatio < resolved.autoRatio)) {
        warn('askRatio must be lower than autoRatio; keeping defaults');
        resolved.askRatio = DEFAULTS.askRatio;
        resolved.autoRatio = DEFAULTS.autoRatio;
    }
    if (resolved.minRatio > resolved.askRatio) resolved.minRatio = resolved.askRatio;

    if (input.includeHistoryTool !== undefined) {
        if (typeof input.includeHistoryTool === 'boolean') resolved.includeHistoryTool = input.includeHistoryTool;
        else warn('includeHistoryTool must be a boolean; using ' + DEFAULTS.includeHistoryTool);
    }
    if (input.autoOpenSession !== undefined) {
        if (typeof input.autoOpenSession === 'boolean') resolved.autoOpenSession = input.autoOpenSession;
        else warn('autoOpenSession must be a boolean; using ' + DEFAULTS.autoOpenSession);
    }
    if (input.maxHandoffsPerSession !== undefined) {
        const value = input.maxHandoffsPerSession;
        if (Number.isSafeInteger(value) && value >= 0) resolved.maxHandoffsPerSession = value;
        else warn('maxHandoffsPerSession must be a non-negative integer; using ' + DEFAULTS.maxHandoffsPerSession);
    }
    if (input.noticeCooldownMs !== undefined) {
        const value = input.noticeCooldownMs;
        if (Number.isFinite(value) && value >= 0) resolved.noticeCooldownMs = value;
        else warn('noticeCooldownMs must be a non-negative number; using ' + DEFAULTS.noticeCooldownMs);
    }
    const timeout = input.summarizeTimeoutMs ?? input.compactTimeoutMs;
    if (timeout !== undefined) {
        if (Number.isSafeInteger(timeout) && timeout > 0) resolved.summarizeTimeoutMs = timeout;
        else warn('summarizeTimeoutMs must be a positive integer; using ' + DEFAULTS.summarizeTimeoutMs);
    }
    return Object.freeze(resolved);
}
