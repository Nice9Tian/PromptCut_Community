// /api/** 同源守卫这一层的中间件本身。http-guard.test.mjs 测的是判据函数,
// 这里测的是「哪些路由被放行、哪些被拒」—— 尤其是原始字节体的白名单。
//
// 起因是一个真 bug:对话附件的「+」上传(/api/chats/attach/upload)把 File 原样当 body,
// Content-Type 是 video/mp4,而白名单里只有素材上传和导出两条,于是附件一个都传不上去,
// 界面只说「导入失败,点击重试」。跑法:node --test server/test/api-guard.test.mjs
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

/** 把中间件拿出来 */
function handlerOf() {
  let fn;
  apiGuardPlugin().configureServer({ middlewares: { use(f) { fn = f; } } });
  assert.ok(fn, 'The plugin did not register middleware');
  return fn;
}

/** 发一个请求:返回 'next'(放行)或拒绝时的状态码 */
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
  // 听写那条是诊断报告里抓到的:transcribe_media 上传素材被 403,整个转写起不来
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

// 素材服务(第 5 步)按语义允许跨源:只有 /api/asset/media/<hash>[/chunks|/complete|/<n>] 豁免,
// 其余 /api/** 照旧只认同源。见 http-guard.mjs 的 isAssetServicePath。
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

// 局域网监听(npm run dev 绑 0.0.0.0)之后:除素材服务外的 /api/** 默认只答本机
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
    // 本机照旧放行
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
