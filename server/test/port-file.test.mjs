/**
 * Gatekeeper: Editors started by tests and probes do not write to shared
 * `%TEMP%\promptcut\port.json`.
 *
 * As soon as the editor starts, it writes its port into this file (`server/vite-plugin-ai.ts`),
 * which the PromptCut MCP service (`server/mcp-server.mjs`) in user sessions uses to find the
 * editor. If an editor started by a probe writes to it, user MCP tool calls are routed to that probe
 * machine; on 2026-09-29 the reverse occurred once: `ready-index-probe --port 5693` wrote 5693, and
 * then `c10-ui-probe` opened its proxy on 5693 and received `/api/mcp/call` from the local MCP
 * client, causing A7 to fail spuriously.
 *
 * Approach: The editor does not write when `PROMPTCUT_NO_PORT_FILE=1`; the probe common entry point
 * `scripts/lib/no-user-dirs.mjs` and the global setup of `npm test` (`markNoPortFile` in
 * `scripts/lib/user-dirs.mjs`) set it. Guard here:
 *   1. `markNoPortFile` itself, as well as processes importing `no-user-dirs.mjs` and their child
 *      processes, actually carry this variable;
 *   2. `npm test` global setup sets it;
 *   3. `vite-plugin-ai.ts` honors it and returns before writing the file;
 *   4. Every script under `scripts/` that starts an editor (vite dev server with default config)
 *      includes it: either the first import is `no-user-dirs.mjs`, or it is explicitly set when
 *      spawning the process; production entry points have separate handling (render host);
 *   5. Desktop app and `npm run dev` do not set it, writing as usual.
 * Only read repository files and spawn a node child process without network access; do not touch
 * the shared port.json.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_PORT_FILE_ENV, markNoPortFile } from '../../scripts/lib/user-dirs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('port-file: markNoPortFile sets it to 1 and returns the original value', () => {
  assert.equal(NO_PORT_FILE_ENV, 'PROMPTCUT_NO_PORT_FILE');
  const env = { PATH: 'p' };
  assert.equal(markNoPortFile(env), undefined);
  assert.deepEqual(env, { PATH: 'p', PROMPTCUT_NO_PORT_FILE: '1' });
  const env2 = { PROMPTCUT_NO_PORT_FILE: '0' };
  assert.equal(markNoPortFile(env2), '0', 'Even when set to 0 outside, it is changed to 1: probes do not write the shared port.json');
  assert.equal(env2.PROMPTCUT_NO_PORT_FILE, '1');
});

test('port-file: a process that imports no-user-dirs.mjs, and the child processes it starts with { ...process.env }, both carry PROMPTCUT_NO_PORT_FILE=1', () => {
  const lib = pathToFileURL(path.join(REPO, 'scripts', 'lib', 'no-user-dirs.mjs')).href;
  const script = [
    `await import(${JSON.stringify(lib)});`,
    `const { spawnSync } = await import('node:child_process');`,
    `const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.PROMPTCUT_NO_PORT_FILE))'], { env: { ...process.env }, encoding: 'utf8' });`,
    `process.stdout.write(JSON.stringify({ self: process.env.PROMPTCUT_NO_PORT_FILE, child: r.stdout }));`,
  ].join('\n');
  const env = { ...process.env };
  delete env.PROMPTCUT_NO_PORT_FILE;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { self: '1', child: '1' });
});

test('port-file: the global setup of npm test sets PROMPTCUT_NO_PORT_FILE=1', () => {
  const src = read('server/test/global-setup.mjs');
  const body = src.slice(src.indexOf('export async function globalSetup'));
  assert.match(body.slice(0, body.indexOf('\n}')), /markNoPortFile\(process\.env\)/, 'globalSetup must set this process\'s environment');
  // When running under global setup (PROMPTCUT_TEST_BAD_PORTS_HELD set by it is present),
  // this process already carries it
  if (process.env.PROMPTCUT_TEST_BAD_PORTS_HELD !== undefined) {
    assert.equal(process.env.PROMPTCUT_NO_PORT_FILE, '1');
  }
});

test('port-file: vite-plugin-ai.ts honors PROMPTCUT_NO_PORT_FILE=1 and returns before writing port.json', () => {
  const src = read('server/vite-plugin-ai.ts');
  const at = src.indexOf("httpServer?.on('listening'");
  assert.ok(at > 0, 'Cannot find the listening callback that writes port.json');
  const write = src.indexOf("'port.json'", at);
  assert.ok(write > at, 'Cannot find where port.json is written in the listening callback');
  const guard = src.slice(at, write);
  assert.match(guard, /process\.env\.PROMPTCUT_NO_PORT_FILE === '1'[^\n]*\)\s*return;/, 'Must return on PROMPTCUT_NO_PORT_FILE before writing the file');
  assert.equal(src.split("'port.json'").length - 1, 1, 'There is only one place in vite-plugin-ai.ts that writes port.json');
});

/** Start a dev server with default config (vite.config.ts, with vite-plugin-ai): `<vite entry>, '--port'` */
const STARTS_EDITOR = /(?:viteBin\(\)|viteBin|vite\.js['"]|\bbin\b|['"]vite['"])\s*,\s*['"]--port['"]/;
/** In-process createServer used a config with vite-plugin-ai (not configFile:false, not vite.prerender.config.ts) */
const IN_PROCESS_EDITOR = /createServer\(\{\s*configFile\s*:\s*(?!false\b)(?![^}\n]*prerender)/;

/** Production entry points: do not import no-user-dirs.mjs, use their own mechanism to avoid writing to shared port.json */
const PRODUCT_ENTRIES = new Map([
  ['cloud/scripts/render-host.mjs', /TEMP/],
]);

function listMjs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'archive' && e.name !== 'node_modules') listMjs(p, out); }
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('port-file: every script under scripts/ that starts the editor carries PROMPTCUT_NO_PORT_FILE=1', () => {
  const offenders = [];
  const checked = [];
  for (const file of listMjs(path.join(REPO, 'scripts'))) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    if (!STARTS_EDITOR.test(src) && !IN_PROCESS_EDITOR.test(src)) continue;
    checked.push(rel);
    if (PRODUCT_ENTRIES.has(rel)) {
      if (!PRODUCT_ENTRIES.get(rel).test(src)) offenders.push(`${rel}: product entry point, but its own way of not writing was not found`);
      continue;
    }
    const first = src.match(/^import[\s{*'"][^\n]*/m)?.[0] || '';
    const want = path.relative(path.dirname(file), path.join(REPO, 'scripts', 'lib', 'no-user-dirs.mjs')).split(path.sep).join('/');
    const spec = want.startsWith('.') ? want : `./${want}`;
    const viaEntry = first.startsWith(`import '${spec}'`);
    const explicit = /PROMPTCUT_NO_PORT_FILE:\s*'1'/.test(src);
    if (!viaEntry && !explicit) offenders.push(`${rel}: starts the editor, but its first import is not no-user-dirs.mjs and it does not explicitly set PROMPTCUT_NO_PORT_FILE: '1'`);
  }
  assert.ok(checked.length >= 25, `Too few scripts scanned (${checked.length}), the detection rule may be broken: ${checked.join(', ')}`);
  for (const must of ['scripts/lib/dev-server.mjs', 'scripts/probes/ready-index-probe.mjs', 'scripts/probes/cold-start-probe.mjs']) {
    assert.ok(checked.includes(must), `${must} starts the editor, but the detection rule did not recognize it`);
  }
  assert.deepEqual(offenders, [], 'The editors started by these scripts would overwrite the shared %TEMP%\\promptcut\\port.json');
});

test('port-file: the desktop app and npm run dev do not set PROMPTCUT_NO_PORT_FILE (port.json is written as before)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.doesNotMatch(pkg.scripts.dev, /PROMPTCUT_NO_PORT_FILE/);
  assert.doesNotMatch(read('desktop/src-tauri/src/lib.rs'), /PROMPTCUT_NO_PORT_FILE/);
  assert.doesNotMatch(read('vite.config.ts'), /PROMPTCUT_NO_PORT_FILE/);
});
