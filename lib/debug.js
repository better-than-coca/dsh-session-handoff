/**
 * Opt-in trace log used while validating the handoff chain.
 * Enabled only when DSH_SESSION_HANDOFF_DEBUG points at a file.
 */
import { appendFileSync } from 'node:fs';

export function debugLog(message) {
    const target = process.env.DSH_SESSION_HANDOFF_DEBUG;
    if (target === undefined || target === '') return;
    try {
        appendFileSync(target, new Date().toISOString() + ' ' + message + '\n');
    } catch {}
}
