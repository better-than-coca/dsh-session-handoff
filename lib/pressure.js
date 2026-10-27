/**
 * Context pressure reading.
 *
 * The host already folds prompt-side pressure into the `contextPressure`
 * session projection (see @deepseek-ai/dsh-token-meter), so this plugin reads
 * that projection instead of re-pricing the surface itself. When the
 * projection is unavailable the plugin stays silent rather than guessing.
 */

/**
 * Read the current pressure of one session.
 * @param ctx - host context exposing `sessionProjections`.
 * @param session - session to measure.
 * @returns `{ used, window, ratio }` or `null` when unmeasurable.
 */
export function readPressure(ctx, session) {
    if (session === undefined || session === null) return null;
    const projections = ctx.get('sessionProjections');
    if (projections === undefined || typeof projections.snapshot !== 'function') return null;
    let snapshot;
    try {
        snapshot = projections.snapshot(session);
    } catch {
        return null;
    }
    const pressure = snapshot?.values?.contextPressure;
    if (pressure === undefined || pressure === null) return null;
    const window = pressure.contextWindow;
    if (!Number.isFinite(window) || window <= 0) return null;
    const used = Number.isFinite(pressure.projectedTokens)
        ? pressure.projectedTokens
        : pressure.pressureTokens;
    if (!Number.isFinite(used) || used <= 0) return null;
    return { used, window, ratio: used / window };
}

/**
 * Human-readable pressure line used by tool output and notices.
 * @param reading - result of {@link readPressure}.
 * @returns compact text such as `62.4% (624k / 1000k)`.
 */
export function formatPressure(reading) {
    if (reading === null) return 'unavailable';
    const percent = (reading.ratio * 100).toFixed(1);
    return percent + '% (' + Math.round(reading.used / 1000) + 'k / ' + Math.round(reading.window / 1000) + 'k)';
}
