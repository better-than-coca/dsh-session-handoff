/**
 * Archive suite: the parent log must stay readable after the handoff, and the
 * child's pointer to it must survive a restart.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const home = mkdtempSync(join(tmpdir(), 'handoff-archive-'));
process.env.DSH_SESSION_HANDOFF_HOME = home;

const archive = await import('../lib/archive.js');

let failures = 0;
const check = (name, cond, detail) => {
    if (cond) { console.log('PASS ' + name); return; }
    failures += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
};

const SESSION = 'session-abc';
const line = (event) => Buffer.from(JSON.stringify(event) + '\n', 'utf8');
// The host appends one zstd frame per write; a single decompress only yields the
// first one, which is why the reader splits frames by their magic bytes.
const frames = Buffer.concat([
    zlib.zstdCompressSync(line({ type: 'session', version: 4, id: SESSION })),
    zlib.zstdCompressSync(Buffer.concat([
        line({ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'needle-alpha' }] } }),
        line({ seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'got it' }] } } })
    ]))
]);
const dir = join(archive.sessionsRoot(), '--E-dsh--', SESSION);
mkdirSync(dir, { recursive: true });
const logPath = join(dir, 'session.v4.jsonl.zstd');
writeFileSync(logPath, frames);

check('archive: locates a log across workspace dirs', archive.locateSessionLog(SESSION) === logPath, archive.locateSessionLog(SESSION));
check('archive: unknown session -> undefined', archive.locateSessionLog('session-missing') === undefined);
const decodedLines = archive.decodeFrames(readFileSync(logPath)).split('\n').filter((line) => line.trim() !== '');
check('archive: decodes every zstd frame', decodedLines.length === 3, JSON.stringify(decodedLines.length));
const events = archive.readSessionEvents(SESSION);
check('archive: returns all events', events.length === 3, JSON.stringify(events.length));
check('archive: keeps the payload intact', JSON.stringify(events[1]).includes('needle-alpha'));
check('archive: missing session -> empty array', archive.readSessionEvents('session-nope').length === 0);

const record = { childId: 'session-child', parentSession: SESSION, summary: '# checkpoint', stats: { shadowed: 10, summaryTokens: 2, ratio: 5 } };
const path = archive.writeHandoff(record);
check('handoff record: file created', existsSync(path) && path.endsWith('session-child.json'), path);
check('handoff record: round-trips', archive.readHandoff('session-child')?.parentSession === SESSION);
check('handoff record: unknown child -> undefined', archive.readHandoff('session-none') === undefined);
archive.updateHandoff('session-child', { injectedAt: 123 });
check('handoff record: update merges fields', archive.readHandoff('session-child').injectedAt === 123 && archive.readHandoff('session-child').summary === '# checkpoint');
check('handoff record: update on missing record -> undefined', archive.updateHandoff('session-none', {}) === undefined);

// Records are deliberately never pruned: an old record is the only pointer a
// child has back to its parent archive, so deleting it would silently break
// retrieval in a session the user may still be using.
check('handoff record: survives arbitrarily long', archive.writeHandoff({ childId: 'session-old', parentSession: SESSION, summary: '# old', createdAt: 1 }) !== undefined && archive.readHandoff('session-old') !== undefined);

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
