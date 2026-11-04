// The middleware itself for the /api/** same-origin guard layer. http-guard.test.mjs tests
// predicate functions, while this tests "which routes are allowed and which are rejected":
// especially the whitelist for raw byte bodies.
//
// The cause was a real bug: the "+" upload for chat attachments (/api/chats/attach/upload) used
// File as-is for the body, with Content-Type video/mp4, whereas the whitelist only had two entries:
// asset upload and export, so no attachments could be uploaded at all, and the UI only said
// "Import failed, click to retry". Run: node --test server/test/api-guard.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-api-guard-test-'));

const guardUrl = pathToFileURL(path.join(ROOT, 'server', 'http-guard.mjs')).href;
let src = fs.readFileSync(path.join(ROOT, 'server', 'vite-plugin-api-guard.ts'), 'utf8')
  .split('from "./http-guard.mjs"').join(`from "${guardUrl}"`);
// server/i18n.mjs is not copied into the scratch folder: point the import back at the real file
src = src.replace(/from (['"])(?:\.\.?\/)+i18n\.mjs\1/g, (_m, q) => `from ${q}${pathToFileURL(path.join(ROOT, 'server', 'i18n.mjs')).href}${q}`);
const js = ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const file = path.join(OUT, 'api-guard.mjs');
fs.writeFileSync(file, js);
const { apiGuardPlugin } = await import(pathToFileURL(file).href);

/** Extract the middleware */
function handlerOf() {
  let fn;
  apiGuardPlugin().configureServer({ middlewares: { use(f) { fn = f; } } });
  assert.ok(fn, 'The plugin did not register middleware');
  return fn;
}

/** Send a request: returns 'next' (allowed) or the status code when rejected */
function pass(fn, { method = 'POST', url, headers = {} }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ status: this.statusCode, body: JSON.parse(String(body)) }); },
    };
    fn({ method, url, headers }, res, () => resolve('next'));
  });
}

const SAME = { origin: 'http://127.0.0.1:5190', host: '127.0.0.1:5190' };

test('Chat attachment upload is a raw byte body and must be allowed through when same-origin (regression)', async () => {
  const fn = handlerOf();
  const r = await pass(fn, {
    url: '/api/chats/attach/upload?conversationId=c1&name=x.mp4',
    headers: { ...SAME, 'content-type': 'video/mp4' },
  });
  assert.equal(r, 'next', 'The Content-Type of an attachment upload is determined by the file type and must not be required to be JSON');
});

test('The raw-body routes for media upload, export media and speech-to-text upload are also allowed through', async () => {
  const fn = handlerOf();
  // Transcription was caught in diagnostic report: transcribe_media asset upload got 403, failing to start transcription altogether
  for (const url of ['/api/media/upload/a.mp4', '/api/export/media/x', '/api/stt/upload/job1/a.mp4', '/api/export/audio-mix/test1']) {
    const r = await pass(fn, { url, headers: { ...SAME, 'content-type': 'application/octet-stream' } });
    assert.equal(r, 'next', url);
  }
});

test('A regular endpoint with a non-JSON body must be rejected: this is the check that blocks CSRF simple requests', async () => {
  const fn = handlerOf();
  const r = await pass(fn, { url: '/api/ai/config', headers: { ...SAME, 'content-type': 'text/plain' } });
  assert.notEqual(r, 'next');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /application\/json/);
});

test('Cross-origin requests are rejected even on raw-body routes', async () => {
  const fn = handlerOf();
  const r = await pass(fn, {
    url: '/api/chats/attach/upload?conversationId=c1&name=x.mp4',
    headers: { origin: 'https://evil.example', host: '127.0.0.1:5190', 'content-type': 'video/mp4' },
  });
  assert.notEqual(r, 'next');
  assert.equal(r.status, 403);
});

test('GET and POST without a body are not subject to the Content-Type check', async () => {
  const fn = handlerOf();
  assert.equal(await pass(fn, { method: 'GET', url: '/api/collect/status', headers: SAME }), 'next');
  assert.equal(await pass(fn, { url: '/api/shots/install', headers: SAME }), 'next');
});

test('Paths that are not /api/ are allowed straight through', async () => {
  const fn = handlerOf();
  assert.equal(await pass(fn, { url: '/@media/x.mp4', headers: { 'content-type': 'text/plain' } }), 'next');
});

// Asset service (step 5) allows cross-origin by semantics: only
// /api/asset/media/<hash>[/chunks|/complete|/<n>] is exempt,
// while remaining /api/** accepts same-origin only as usual. See isAssetServicePath in http-guard.mjs.
const LAN = { origin: 'http://192.168.1.50:8080', host: '127.0.0.1:5190' };
const H = 'ab'.repeat(32);

test('Asset service routes are exempt from the cross-origin check: chunk, reconcile, finalize, retrieve, preflight', async () => {
  const fn = handlerOf();
  assert.equal(await pass(fn, { method: 'PUT', url: `/api/asset/media/${H}/0`, headers: { ...LAN, 'content-type': 'application/octet-stream' } }), 'next');
  assert.equal(await pass(fn, { method: 'GET', url: `/api/asset/media/${H}/chunks`, headers: LAN }), 'next');
  assert.equal(await pass(fn, { method: 'POST', url: `/api/asset/media/${H}/complete`, headers: { ...LAN, 'content-type': 'text/plain' } }), 'next');
  assert.equal(await pass(fn, { method: 'GET', url: `/api/asset/media/${H.toUpperCase()}`, headers: LAN }), 'next');
  assert.equal(await pass(fn, { method: 'OPTIONS', url: `/api/asset/media/${H}/3`, headers: LAN }), 'next');
});

test('Cross-origin requests to /api/** outside the exemption still get 403 (including the editor\'s internal whole-file upload and look-alike paths)', async () => {
  const fn = handlerOf();
  const denied = [
    { url: '/api/media/upload/x.mp4', headers: { ...LAN, 'content-type': 'video/mp4' } },
    { url: '/api/ai/config', headers: { ...LAN, 'content-type': 'application/json' } },
    { method: 'GET', url: '/api/media/local?hashes=' + H, headers: LAN },
    { url: `/api/asset/media/${H}/../../ai/config`, headers: { ...LAN, 'content-type': 'text/plain' } },
    { url: `/api/asset/media/${H}/chunks/x`, headers: LAN },
    { url: '/api/asset/media/not-a-hash/0', headers: LAN },
    { url: '/api/asset/other', headers: LAN },
  ];
  for (const req of denied) {
    const r = await pass(fn, req);
    assert.notEqual(r, 'next', req.url);
    assert.equal(r.status, 403, req.url);
  }
});

// After LAN listening (npm run dev binds 0.0.0.0): /api/** except asset service answers local only by default
const LAN_CLIENT = { socket: { remoteAddress: '192.168.1.50' } };
const LOCAL_CLIENT = { socket: { remoteAddress: '127.0.0.1' } };

function passFrom(fn, from, { method = 'GET', url, headers = {} }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ status: this.statusCode, body: JSON.parse(String(body)) }); },
    };
    fn({ method, url, headers, ...from }, res, () => resolve('next'));
  });
}

test('A LAN device hitting a regular endpoint without Origin: 403 by default (otherwise it could directly drive the Agent and read the config)', async () => {
  const fn = handlerOf();
  const prev = process.env.PROMPTCUT_LAN_API;
  delete process.env.PROMPTCUT_LAN_API;
  try {
    for (const req of [
      { url: '/api/ai/config' },
      { method: 'POST', url: '/api/ai/chat', headers: { 'content-type': 'application/json' } },
      { url: '/api/media/local' },
    ]) {
      const r = await passFrom(fn, LAN_CLIENT, req);
      assert.notEqual(r, 'next', req.url);
      assert.equal(r.status, 403, req.url);
      assert.match(r.body.error, /PROMPTCUT_LAN_API/);
    }
    // Local allowed as usual
    assert.equal(await passFrom(fn, LOCAL_CLIENT, { url: '/api/ai/config' }), 'next');
  } finally {
    if (prev === undefined) delete process.env.PROMPTCUT_LAN_API; else process.env.PROMPTCUT_LAN_API = prev;
  }
});

test('A LAN device hitting the asset service: allowed (the asset service is open to the LAN by design)', async () => {
  const fn = handlerOf();
  const hash = 'a'.repeat(64);
  for (const url of [`/api/asset/media/${hash}`, `/api/asset/media/${hash}/chunks`, `/api/asset/media/${hash}/0`]) {
    assert.equal(await passFrom(fn, LAN_CLIENT, { url }), 'next', url);
  }
});

test('With PROMPTCUT_LAN_API=1 a LAN device can hit regular endpoints (the other two checks apply as before)', async () => {
  const fn = handlerOf();
  const prev = process.env.PROMPTCUT_LAN_API;
  process.env.PROMPTCUT_LAN_API = '1';
  try {
    assert.equal(await passFrom(fn, LAN_CLIENT, { url: '/api/ai/config' }), 'next');
    const r = await passFrom(fn, LAN_CLIENT, { method: 'POST', url: '/api/ai/config', headers: { 'content-type': 'text/plain' } });
    assert.equal(r.status, 403, 'A non-JSON body is still rejected');
  } finally {
    if (prev === undefined) delete process.env.PROMPTCUT_LAN_API; else process.env.PROMPTCUT_LAN_API = prev;
  }
});
