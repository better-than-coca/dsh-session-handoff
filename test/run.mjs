/**
 * Run both suites in a throwaway sandbox.
 *
 * The plugin imports three host packages by bare specifier, so the suites cannot
 * run inside the source tree: node would fail to resolve them. This script
 * builds a sandbox one directory up with minimal stubs for those three
 * packages, copies lib/ and the two suites in, and runs them there.
 *
 *   node test/run.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const sandbox = resolve(root, '..', '.tmp-handoff-it');

const STUBS = {
    'dsh-llm': {
        'index.js': [
            'export function createUserMessage(input) { return Object.freeze({ role: \'user\', content: input.content, source: input.source }); }',
            'export class BlockAssembler {',
            '  constructor() { this.items = []; this.finish = { kind: \'stop\' }; this.usage = { outputTokens: 42 }; }',
            '  push(chunk) { if (chunk && chunk.type === \'text\') this.items.push({ type: \'text\', text: chunk.text }); }',
            '  blocks() { return this.items; }',
            '}'
        ].join('\n')
    },
    'dsh-tools': {
        'index.js': 'export function defineTool(o) { return o; }'
    },
    'dsh-compaction-basic': {
        'index.js': [
            'export class BasicCompactionEngine {',
            '  static inject = [\'llm\', \'tokenMeter\', \'sessions\'];',
            '  constructor(ctx, config = {}) { this.ctx = ctx; this.config = { maxTokens: 8192, auto: true, ...config }; }',
            '}'
        ].join('\n')
    },
    // index.js is optional: the suites never import the compaction wrapper, but
    // a missing module would fail resolution for anyone who does.
    'none': {}
};

function ensureStubs() {
    for (const [pkg, files] of Object.entries(STUBS)) {
        const dir = join(sandbox, 'node_modules', '@deepseek-ai', pkg);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ name: '@deepseek-ai/' + pkg, version: '0.0.0-stub', type: 'module', main: 'index.js' }, null, 2),
            'utf8'
        );
        for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
    }
}

function copy(from, to) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
}

ensureStubs();
copy(join(root, 'lib', 'index.js'), join(sandbox, 'lib', 'index.js'));
for (const file of ['handoff.js', 'config.js', 'pressure.js', 'history.js', 'route-card.js', 'summary-engine.js', 'debug.js', 'archive.js', 'checkpoint.js', 'http.js', 'settings.js']) {
    copy(join(root, 'lib', file), join(sandbox, 'lib', file));
}
copy(join(root, 'test', 'features.mjs'), join(sandbox, 'test', 'features.mjs'));
copy(join(root, 'test', 'integration.mjs'), join(sandbox, 'integration.mjs'));

copy(join(root, 'test', 'archive.mjs'), join(sandbox, 'test', 'archive.mjs'));
copy(join(root, 'test', 'routes.mjs'), join(sandbox, 'test', 'routes.mjs'));
copy(join(root, 'test', 'settings.mjs'), join(sandbox, 'test', 'settings.mjs'));

const suites = [join('test', 'features.mjs'), join('test', 'archive.mjs'), 'integration.mjs', join('test', 'routes.mjs'), join('test', 'settings.mjs')];
let failed = 0;
for (const suite of suites) {
    process.stdout.write('\n=== ' + suite + ' ===\n');
    const run = spawnSync(process.execPath, [suite], { cwd: sandbox, stdio: 'inherit' });
    if (run.status !== 0) failed += 1;
}

process.stdout.write(failed === 0 ? '\nALL SUITES PASS\n' : '\n' + failed + ' SUITE(S) FAILED\n');
process.exit(failed === 0 ? 0 : 1);
