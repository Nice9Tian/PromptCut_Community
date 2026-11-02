// Disk persistence route for SKILL floating preview: when SKILL mode is on, page sends POST
// /api/skill-mode/last-action (frame of previous action in desktop session, requested by editor
// process via SSE skill.preview), writing skillRoot/last-action.{png,json}; writes nothing when
// SKILL mode is off. Also locks in return shape of close route.
// Run: node --test server/test/skill-last-action.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-skill-last-action-'));
const SKILL_DIR = path.join(OUT, 'skill');
process.env.PROMPTCUT_SKILL_DIR = SKILL_DIR;

// Transpile to temporary directory: two dynamic imports in plugin use paths relative to
// import.meta.url; rewrite them to absolute paths in repository
const gateUrl = pathToFileURL(path.join(ROOT, 'server', 'skill-gate.mjs')).href;
const projectsUrl = pathToFileURL(path.join(ROOT, 'server', 'vite-plugin-projects.ts')).href;
let src = fs.readFileSync(path.join(ROOT, 'server', 'vite-plugin-skill-state.ts'), 'utf8');
src = src.split('new URL("./skill-gate.mjs", import.meta.url).href').join(JSON.stringify(gateUrl));
src = src.split('new URL("./vite-plugin-projects.ts", import.meta.url).href').join(JSON.stringify(projectsUrl));
// server/i18n.mjs is not copied into the scratch folder: point the import back at the real file
src = src.replace(/from (['"])(?:\.\.?\/)+i18n\.mjs\1/g, (_m, q) => `from ${q}${pathToFileURL(path.join(ROOT, 'server', 'i18n.mjs')).href}${q}`);
const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
const file = path.join(OUT, 'skill-state.mjs');
fs.writeFileSync(file, js);
const { skillStatePlugin } = await import(pathToFileURL(file).href);

/** Extract middleware mounted on /api/skill-mode (plugin uses use(path, fn) form) */
function handlerOf() {
  const handlers = new Map();
  skillStatePlugin().configureServer({
    config: { root: OUT },
    middlewares: { use(p, f) { handlers.set(typeof p === 'string' ? p : '*', f ?? p); } },
  });
  const fn = handlers.get('/api/skill-mode');
  assert.ok(fn, 'The plugin does not mount /api/skill-mode');
  return fn;
}

/** connect strips mount prefix, so url here is directly passed the stripped portion */
function call(fn, method, url, body) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.url = url;
  req.method = method;
  req.headers = body == null ? {} : { 'content-type': 'application/json' };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headersSent: false,
      setHeader() {},
      end(payload) { this.headersSent = true; resolve({ status: this.statusCode, json: JSON.parse(String(payload)) }); },
    };
    fn(req, res);
  });
}

// Minimal valid png (1×1, pngjs not needed as long as file header is valid)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const gate = await import(gateUrl);

test('SKILL-LA-1 report while SKILL mode is on: both the png and the json land in skillRoot, and the json carries the tool name / time point / moment', async () => {
  gate.openGate();
  try {
    const fn = handlerOf();
    const r = await call(fn, 'POST', '/last-action', { tool: 'add_clip', clipId: 'c-1', t: 3.5, base64: PNG_1x1.toString('base64') });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.tool, 'add_clip');
    assert.equal(r.json.t, 3.5);
    assert.equal(r.json.bytes, PNG_1x1.length);

    const png = fs.readFileSync(path.join(SKILL_DIR, 'last-action.png'));
    assert.ok(png.equals(PNG_1x1), 'The png is written to disk as is');
    const meta = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'last-action.json'), 'utf8'));
    assert.equal(meta.tool, 'add_clip');
    assert.equal(meta.clipId, 'c-1');
    assert.equal(meta.t, 3.5);
    assert.ok(Date.parse(meta.at) > 0);
    // Temporary files must not be left behind
    assert.ok(!fs.existsSync(path.join(SKILL_DIR, 'last-action.png.tmp')));
    assert.ok(!fs.existsSync(path.join(SKILL_DIR, 'last-action.json.tmp')));
  } finally {
    gate.closeGate('test');
  }
});

test('SKILL-LA-2 content that is not a png is rejected', async () => {
  gate.openGate();
  try {
    const fn = handlerOf();
    const r = await call(fn, 'POST', '/last-action', { tool: 'add_clip', base64: Buffer.from('hello').toString('base64') });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /png/);
  } finally {
    gate.closeGate('test');
  }
});

test('SKILL-LA-3 report is skipped while SKILL mode is off, no file is written', async () => {
  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  const fn = handlerOf();
  const r = await call(fn, 'POST', '/last-action', { tool: 'add_clip', base64: PNG_1x1.toString('base64') });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.skipped, 'skill-off');
  assert.ok(!fs.existsSync(path.join(SKILL_DIR, 'last-action.png')));
});

test('SKILL-LA-4 close route: returns ok and the state after closing, closedBy records who closed it', async () => {
  const fn = handlerOf();
  const r = await call(fn, 'POST', '/close', { by: 'user' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.state.active, false);
  assert.equal(r.json.state.closedBy, 'user');
  assert.ok(Date.parse(r.json.state.closedAt) > 0);
});
