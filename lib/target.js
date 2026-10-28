/**
 * Where the follow-up Session should live.
 *
 * A handoff normally continues in the parent's own directory, but the user may
 * want the checkpoint to land in a different project — either a directory that
 * is already a Workspace, or one that does not exist yet.
 *
 * The decision is made here, at request time, rather than when the Session opens:
 * a bad path has to fail BEFORE the summarizer is paid for, or a checkpoint parks
 * with no Session that could ever consume it.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Windows compares directory names case-insensitively; raw strings do not. */
function foldPath(value) {
    const resolved = resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Whether two spellings name the same directory.
 * @param left - first path.
 * @param right - second path.
 * @returns true when both resolve to the same directory.
 */
export function samePath(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') return false;
    return foldPath(left) === foldPath(right);
}

/**
 * Validate the directory a handoff should continue in, creating it when asked.
 * @param rawPath - the user's spelling of the target directory.
 * @param options - `{ create }`: create the directory when it is missing.
 * @returns `{ ok: true, path, created }` or `{ ok: false, code, error }`.
 */
export function planTarget(rawPath, options = {}) {
    const create = options.create === true;
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return { ok: false, code: 'empty-target', error: 'targetDir is empty' };
    }
    // A path pasted out of Explorer usually arrives wrapped in quotes.
    const trimmed = rawPath.trim().replace(/^"(.*)"$/, '$1').trim();
    if (trimmed === '' || !isAbsolute(trimmed)) {
        return {
            ok: false,
            code: 'relative-target',
            error: 'targetDir must be a fully qualified path (a drive letter or a UNC share), got "' + trimmed + '"'
        };
    }
    const target = resolve(trimmed);
    const existed = existsSync(target);
    if (!existed) {
        if (!create) {
            return {
                ok: false,
                code: 'missing-directory',
                error: 'there is no directory at ' + target
                    + '; pass createTargetDir:true to create it, or report the path as wrong'
            };
        }
        try {
            mkdirSync(target, { recursive: true });
        } catch (error) {
            return {
                ok: false,
                code: 'mkdir-failed',
                error: 'could not create ' + target + ': ' + (error instanceof Error ? error.message : String(error))
            };
        }
    }
    try {
        if (!statSync(target).isDirectory()) {
            return { ok: false, code: 'not-a-directory', error: target + ' is not a directory' };
        }
    } catch (error) {
        return {
            ok: false,
            code: 'stat-failed',
            error: 'could not inspect ' + target + ': ' + (error instanceof Error ? error.message : String(error))
        };
    }
    return { ok: true, path: target, created: !existed };
}
