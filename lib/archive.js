/**
 * Parent-session archive access.
 *
 * A genuine-new-session handoff never copies the parent log: the child receives
 * one injected checkpoint, and every concrete detail stays in the parent's own
 * append-only log. That makes the parent log a first-class read dependency, so
 * this module owns locating it, decoding it, and remembering which parent a
 * child came from.
 *
 * Everything here is read-only with respect to session logs. The only writes are
 * this plugin's own handoff records under <dsh home>/handoff.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const LOG_NAME = 'session.v4.jsonl.zstd';
/** How many frames a decode may merge before the file is treated as unreadable. */
const MAX_FRAMES = 200000;

/** DSH home. Overridable so tests never touch the real profile. */
function home() {
    const override = process.env.DSH_SESSION_HANDOFF_HOME;
    return override === undefined || override === '' ? join(homedir(), '.dsh') : override;
}

export function sessionsRoot() {
    return join(home(), 'sessions');
}

export function handoffRoot() {
    return join(home(), 'handoff');
}

/**
 * Find the durable log of one session, wherever its workspace directory sits.
 * @param sessionId - session identity.
 * @returns absolute path, or undefined when the log is absent.
 */
export function locateSessionLog(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    const root = sessionsRoot();
    if (!existsSync(root)) return undefined;
    let workspaces;
    try {
        workspaces = readdirSync(root, { withFileTypes: true });
    } catch {
        return undefined;
    }
    for (const entry of workspaces) {
        if (!entry.isDirectory()) continue;
        const candidate = join(root, entry.name, sessionId, LOG_NAME);
        if (existsSync(candidate)) return candidate;
    }
    return undefined;
}

/**
 * Decode an append-only zstd file: every append is its own frame, and a single
 * decompress call only yields the first one.
 * @param buffer - raw file bytes.
 * @returns concatenated UTF-8 payload.
 */
export function decodeFrames(buffer) {
    const offsets = [];
    for (let index = 0; index + 4 <= buffer.length; index += 1) {
        if (buffer.compare(ZSTD_MAGIC, 0, 4, index, index + 4) === 0) {
            offsets.push(index);
            if (offsets.length > MAX_FRAMES) break;
        }
    }
    if (offsets.length === 0) return buffer.toString('utf8');
    const parts = [];
    for (let index = 0; index < offsets.length; index += 1) {
        const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
        try {
            parts.push(zlib.zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8'));
        } catch {
            // A partially written trailing frame must not poison the rest.
        }
    }
    return parts.join('');
}

const logCache = new Map();

/**
 * Read the durable events of one archived session.
 * @param sessionId - session identity.
 * @returns parsed events, or an empty array when the log is missing.
 */
export function readSessionEvents(sessionId) {
    const path = locateSessionLog(sessionId);
    if (path === undefined) return [];
    let stats;
    try {
        stats = statSync(path);
    } catch {
        return [];
    }
    const cached = logCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.events;
    let buffer;
    try {
        buffer = readFileSync(path);
    } catch {
        return [];
    }
    if (typeof zlib.zstdDecompressSync !== 'function') return [];
    const events = [];
    for (const line of decodeFrames(buffer).split('\n')) {
        if (line.trim() === '') continue;
        try {
            events.push(JSON.parse(line));
        } catch {
            // Skip a torn line rather than failing the whole archive.
        }
    }
    logCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, events });
    return events;
}

/**
 * The waiting checkpoint.
 *
 * A handoff does not create a session: the host hides sessions with no events and
 * the plugin cannot write into one it did not create through the UI. Instead the
 * checkpoint waits here, and the next brand-new conversation the user opens picks
 * it up on its first prompt.
 */
function pendingPath() {
    return join(handoffRoot(), 'pending.json');
}

export function writePending(record) {
    mkdirSync(handoffRoot(), { recursive: true });
    writeFileSync(pendingPath(), JSON.stringify(record, null, 2), 'utf8');
    return pendingPath();
}

export function readPending() {
    const path = pendingPath();
    if (!existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * Record which conversation took the waiting checkpoint.
 * @param sessionId - session that received it.
 * @returns the updated record, or undefined when nothing was pending.
 */
export function consumePending(sessionId) {
    const record = readPending();
    if (record === undefined) return undefined;
    const next = { ...record, consumedBy: sessionId, consumedAt: Date.now() };
    writeFileSync(pendingPath(), JSON.stringify(next, null, 2), 'utf8');
    return next;
}

/** Drop a waiting checkpoint without using it. */
export function clearPending() {
    const path = pendingPath();
    if (!existsSync(path)) return false;
    try {
        rmSync(path, { force: true });
        return true;
    } catch {
        return false;
    }
}

function recordPath(childId) {
    return join(handoffRoot(), childId + '.json');
}

/**
 * Persist the handoff record that tells a child where its parent archive is.
 * @param record - handoff identity, checkpoint text, and measurement.
 * @returns the absolute record path.
 */
export function writeHandoff(record) {
    mkdirSync(handoffRoot(), { recursive: true });
    const path = recordPath(record.childId);
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf8');
    return path;
}

/**
 * Read the handoff record of one child session.
 * @param childId - child session identity.
 * @returns the record, or undefined when this session was not handed off to.
 */
export function readHandoff(childId) {
    if (typeof childId !== 'string' || childId === '') return undefined;
    const path = recordPath(childId);
    if (!existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * Rewrite a handoff record after its checkpoint was injected into the child.
 * The record is kept: it is the child's only pointer back to its parent archive.
 * @param childId - child session identity.
 * @param patch - fields to merge.
 */
export function updateHandoff(childId, patch) {
    const record = readHandoff(childId);
    if (record === undefined) return undefined;
    const next = { ...record, ...patch };
    writeFileSync(recordPath(childId), JSON.stringify(next, null, 2), 'utf8');
    return next;
}

