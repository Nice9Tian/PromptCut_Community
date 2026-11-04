// Media collection plugin: interface shape, job table, error paths. Uses fake-collect.cmd to mock
// Python, without networking or installing yt-dlp. Run command:
// node --test server/test/collect-plugin.test.mjs
//
// The plugin is .ts, transpiled here with typescript to a temp directory before import (same pattern
// as cards.test); its dependencies vite-plugin-stt / vite-plugin-media are also transpiled together,
// and import paths are updated to the transpiled output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import http from 'node:http';
import { createAssetHarness } from './fake-asset-service.mjs';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-collect-test-'));

function compile(srcRel, outName, rewrites = []) {
  let src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  for (const [from, to] of rewrites) src = src.split(from).join(to);
  // server/i18n.mjs is not copied into the scratch folder: point the import back at the real file
  src = src.replace(/from (['"])(?:\.\.?\/)+i18n\.mjs\1/g, (_m, q) => `from ${q}${pathToFileURL(path.join(ROOT, 'server', 'i18n.mjs')).href}${q}`);
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return pathToFileURL(file).href;
}

compile('server/vite-plugin-stt.ts', 'stt.mjs');
compile('server/vite-plugin-media.ts', 'media.mjs');
compile('server/asset-client.ts', 'asset-client.mjs');
const ingestUrl = pathToFileURL(path.join(ROOT, 'server', 'media-ingest.mjs')).href;
compile('server/vite-plugin-web.ts', 'web.mjs', [
  ['from "./vite-plugin-stt"', 'from "./stt.mjs"'],
]);
const cookiesUrl = pathToFileURL(path.join(ROOT, 'server', 'collect-cookies.mjs')).href;
const qrLoginUrl = pathToFileURL(path.join(ROOT, 'server', 'collect-qr-login.mjs')).href;
const guardUrl = pathToFileURL(path.join(ROOT, 'server', 'http-guard.mjs')).href;
const collectUrl = compile('server/vite-plugin-collect.ts', 'collect.mjs', [
  ['from "./vite-plugin-stt"', 'from "./stt.mjs"'],
  ['from "./vite-plugin-media"', 'from "./media.mjs"'],
  ['from "./asset-client"', 'from "./asset-client.mjs"'],
  ['from "./media-ingest.mjs"', `from "${ingestUrl}"`],
  ['from "./vite-plugin-web"', 'from "./web.mjs"'],
  ['from "./collect-cookies.mjs"', `from "${cookiesUrl}"`],
  ['from "./collect-qr-login.mjs"', `from "${qrLoginUrl}"`],
  ['from "./http-guard.mjs"', `from "${guardUrl}"`],
  // Login paths dynamically import browser modules; transpiled output is in a temp directory where
  // relative paths cannot find them, so change to absolute paths
  ['import("./web/browser.mjs")', `import("${pathToFileURL(path.join(ROOT, 'server', 'web', 'browser.mjs')).href}")`],
  ['import("./web/session.mjs")', `import("${pathToFileURL(path.join(ROOT, 'server', 'web', 'session.mjs')).href}")`],
]);
const { saveCookies } = await import(cookiesUrl);

// Mock Python: the plugin invokes it as -m promptcut_collect <subcommand>, and it replays fixed
// JSONL based on the subcommand
process.env.PROMPTCUT_PYTHON = path.join(ROOT, 'server', 'test', 'fake-collect.cmd');
// Project root uses a temp directory: buildEnv creates pylibs / models under <root>/out
const FAKE_ROOT = path.join(OUT, 'root');
fs.mkdirSync(FAKE_ROOT, { recursive: true });

// Download results enter content store via the asset service store API (server/media-ingest.mjs):
// start a real asset service (fs content store + media middleware); the editor process asset service
// URL points to it (assetServiceOrigin in asset-client.ts first checks PROMPTCUT_EDITOR_URL)
const harness = createAssetHarness();
const assetSvc = await harness.serve({ stores: 'default' });
process.env.PROMPTCUT_EDITOR_URL = assetSvc.origin;
after(async () => { await harness.cleanup(); delete process.env.PROMPTCUT_EDITOR_URL; });
/** Content written into --out-dir by fake-collect.cmd (echo includes CRLF) */
const FAKE_BYTES = Buffer.from('fake video bytes\r\n');

const { collectPlugin } = await import(collectUrl);

/** Extract the plugin's middleware */
function handlerOf() {
  const plugin = collectPlugin();
  let fn;
  plugin.configureServer({
    config: { root: FAKE_ROOT },
    middlewares: { use(f) { fn = f; } },
  });
  assert.ok(fn, 'The plugin did not register middleware');
  return fn;
}

/** Send a request and get back { status, json } */
function call(fn, method, url, body) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.url = url;
  req.method = method;
  req.headers = body == null ? {} : { 'content-type': 'application/json' };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(code) { this.statusCode = code; },
      write() {},
      end(payload) {
        this.headersSent = true;
        let json;
        try { json = payload ? JSON.parse(String(payload)) : undefined; } catch { json = String(payload); }
        resolve({ status: this.statusCode, json, headers: this.headers });
      },
      on() {},
    };
    fn(req, res, () => reject(new Error('Fell through to next(), the plugin did not handle this path:' + url)));
  });
}

async function waitJob(fn, jobId, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(fn, 'GET', `/api/collect/job/${jobId}`);
    assert.equal(r.status, 200);
    if (r.json.job.status !== 'running') return r.json.job;
    assert.ok(Date.now() - t0 < timeoutMs, 'The job takes too long to finish');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('status: forwards Python\'s status events and includes python: true', async () => {
  const fn = handlerOf();
  const r = await call(fn, 'GET', '/api/collect/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.python, true);
  assert.equal(r.json.ready, true);
  assert.equal(r.json.ytdlp.version, 'fake');
  assert.deepEqual(r.json.presets.map((p) => p.name), ['bilibili', 'generic']);
});

test('probe: a missing url gives 400; a normal run returns the fields of done and records 412 retries in notes', async () => {
  const fn = handlerOf();
  const bad = await call(fn, 'POST', '/api/collect/probe', {});
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);

  const r = await call(fn, 'POST', '/api/collect/probe', { url: 'BV1FAKE00000', site: 'bilibili', quality: 720 });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.title, 'Fake Video 测试', 'Chinese titles must come through unchanged, not turn into \\uXXXX');
  assert.equal(r.json.duration, 12.5);
  assert.deepEqual(r.json.heights, [1080, 720]);
  assert.equal(r.json.parts, null);
  // In addition to retry, notes contains a "Not logged in" explanation (Bilibili links check login
  // state), so do not assert on the item count
  assert.ok(r.json.notes.some((n) => /412/.test(n)), 'The retry event must be recorded in notes:' + JSON.stringify(r.json.notes));
  assert.equal(r.json.cookiesUsed, false);
});

test('probe failure: ok:false and error is the sentence Python reported', async () => {
  const fn = handlerOf();
  process.env.PROMPTCUT_FAKE_FAIL = '1';
  try {
    const r = await call(fn, 'POST', '/api/collect/probe', { url: 'BV1FAKE00000' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /404/);
    assert.equal(r.json.notInstalled, false);
  } finally {
    delete process.env.PROMPTCUT_FAKE_FAIL;
  }
});

test('MI-5 download: returns a jobId immediately; when polling reaches done, items carry the post-ingest /@media/<hash>, percent 100, and notes have the retry record; the asset catalog has no file that bypassed ingest', async () => {
  const fn = handlerOf();
  const started = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00000', quality: 720 });
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);
  assert.match(started.json.jobId, /^[\w-]{8}$/);
  assert.equal(started.json.outDir, undefined, 'No longer returns the asset catalog: downloads land in a temp directory first, then are ingested through the asset service');

  const job = await waitJob(fn, started.json.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.stage, 'done');
  assert.equal(job.percent, 100);
  assert.equal(job.quality, 720);
  assert.equal(job.info.title, 'Fake Video 测试');
  assert.equal(job.items.length, 1);
  const item = job.items[0];
  assert.equal(item.filename, 'Fake Video [BV1FAKE00000].mp4');
  const hash = crypto.createHash('sha256').update(FAKE_BYTES).digest('hex');
  assert.equal(item.hash, hash, 'The content hash is computed by the asset service at ingest');
  assert.equal(item.url, `/@media/${hash}`);
  assert.equal(item.media?.hash, hash, 'The ingest response is passed to the page unchanged');
  assert.equal(item.path, undefined, 'No longer gives the disk path of the temp file');
  // Bytes are indeed in the asset service content store, accessible through its API
  const got = await fetch(`${assetSvc.origin}/@media/${hash}`);
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), FAKE_BYTES);
  // No files dropped by bypassing storage into the library exist in the editor's own asset catalog
  const own = path.join(FAKE_ROOT, 'out', 'media');
  assert.deepEqual(fs.existsSync(own) ? fs.readdirSync(own) : [], [], 'The asset catalog must not contain files written directly by the download');
  assert.equal(item.vcodec, 'h264');
  assert.equal(item.width, 1920);
  assert.ok(job.notes.some((n) => /412/.test(n)), 'The 412 retry must be recorded in notes:' + JSON.stringify(job.notes));
  assert.ok(job.finishedAt >= job.startedAt);
});

test('download: if the process has not yet exited after the done event, polling still sees running; when done is reported, finishedAt is always included', async () => {
  const fn = handlerOf();
  process.env.PROMPTCUT_FAKE_LINGER = '1';
  try {
    const r = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00002' });
    const job = await waitJob(fn, r.json.jobId);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(typeof job.finishedAt, 'number', JSON.stringify(job));
    assert.ok(job.finishedAt >= job.startedAt);
  } finally {
    delete process.env.PROMPTCUT_FAKE_LINGER;
  }
});

test('MI-6 download: when the asset service is unreachable the job reports an error (stating the asset service address), and neither the asset catalog nor the temp directory keeps any file', async () => {
  const fn = handlerOf();
  const gone = await new Promise((resolve) => {
    const srv = http.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => { const o = `http://127.0.0.1:${srv.address().port}`; srv.close(() => resolve(o)); });
  });
  const privateTmp = fs.mkdtempSync(path.join(OUT, 'os-tmp-'));
  const saved = { url: process.env.PROMPTCUT_EDITOR_URL, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { PROMPTCUT_EDITOR_URL: gone, TEMP: privateTmp, TMP: privateTmp });
  try {
    const r = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00030' });
    const job = await waitJob(fn, r.json.jobId);
    assert.equal(job.status, 'error', JSON.stringify(job));
    assert.ok(job.message.includes(`Asset service unreachable (${gone})`), job.message);
    assert.equal(job.items.length, 0);
  } finally {
    Object.assign(process.env, { PROMPTCUT_EDITOR_URL: saved.url, TEMP: saved.TEMP, TMP: saved.TMP });
  }
  const own = path.join(FAKE_ROOT, 'out', 'media');
  assert.deepEqual(fs.existsSync(own) ? fs.readdirSync(own) : [], []);
  for (let i = 0; i < 50 && fs.readdirSync(privateTmp).some((n) => n.startsWith('pc-collect-')); i++) await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(fs.readdirSync(privateTmp).filter((n) => n.startsWith('pc-collect-')), [], 'The job\'s temp directory must be deleted');
});

test('download: a resolution not on the whitelist falls back to 1080; an unknown site falls back to auto', async () => {
  const fn = handlerOf();
  const r = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00001', quality: 999, site: 'evil' });
  const job = await waitJob(fn, r.json.jobId);
  assert.equal(job.quality, 1080);
  assert.equal(job.site, 'auto');
});

test('download failure: status error, message comes from Python\'s error event', async () => {
  const fn = handlerOf();
  process.env.PROMPTCUT_FAKE_FAIL = '1';
  try {
    const r = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00002' });
    const job = await waitJob(fn, r.json.jobId);
    assert.equal(job.status, 'error');
    assert.match(job.message, /Video unavailable/);
    assert.equal(job.items.length, 0);
  } finally {
    delete process.env.PROMPTCUT_FAKE_FAIL;
  }
});

test('Job table: a nonexistent jobId gives 404; the jobs list has the newest first; DELETE on a finished job does not change its status', async () => {
  const fn = handlerOf();
  const miss = await call(fn, 'GET', '/api/collect/job/nope0000');
  assert.equal(miss.status, 404);

  const a = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00003' });
  await waitJob(fn, a.json.jobId);
  const list = await call(fn, 'GET', '/api/collect/jobs');
  assert.equal(list.json.ok, true);
  assert.equal(list.json.jobs[0].id, a.json.jobId);

  const del = await call(fn, 'DELETE', `/api/collect/job/${a.json.jobId}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.job.status, 'done', 'Cancelling a finished job must not turn it into error');
});

test('Missing url / bad JSON / unknown path each give a clear error', async () => {
  const fn = handlerOf();
  const noUrl = await call(fn, 'POST', '/api/collect/download', {});
  assert.equal(noUrl.status, 400);

  const req = Readable.from([Buffer.from('{not json')]);
  req.url = '/api/collect/download'; req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
  const bad = await new Promise((resolve) => {
    fn(req, { statusCode: 200, headersSent: false, setHeader() {}, end(p) { resolve({ status: this.statusCode, json: JSON.parse(String(p)) }); } }, () => {});
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /JSON/);

  const unknown = await call(fn, 'GET', '/api/collect/whatever');
  assert.equal(unknown.status, 404);
});

test('Login state: status carries cookies for each site; when nothing is saved, the download carries no cookie and says so in notes', async () => {
  const fn = handlerOf();
  const st = await call(fn, 'GET', '/api/collect/status');
  assert.equal(st.json.cookies.bilibili.loggedIn, false);
  assert.equal(st.json.cookies.bilibili.name, 'Bilibili');

  const r = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00010' });
  const job = await waitJob(fn, r.json.jobId);
  assert.equal(job.cookiesUsed, false);
  assert.ok(job.notes.some((n) => /Not logged in/.test(n)), JSON.stringify(job.notes));

  // Not a site with login support: do not mention a word
  const y = await call(fn, 'POST', '/api/collect/download', { url: 'https://www.youtube.com/watch?v=x' });
  const yj = await waitJob(fn, y.json.jobId);
  assert.equal(yj.cookiesUsed, false);
  assert.ok(!yj.notes.some((n) => /login|logged in/.test(n)));
});

test('Login state: after saving, Bilibili links automatically carry the cookie, the cookies endpoint can query and delete', async () => {
  const fn = handlerOf();
  const soon = Math.floor(Date.now() / 1000) + 86400;
  const mk = (name, value) => ({ name, value, domain: '.bilibili.com', path: '/', expires: soon, secure: false });
  saveCookies(path.join(FAKE_ROOT, 'out'), 'bilibili', [mk('SESSDATA', 's'), mk('bili_jct', 'j'), mk('DedeUserID', '42')]);
  try {
    const ck = await call(fn, 'GET', '/api/collect/cookies');
    assert.equal(ck.json.cookies.bilibili.loggedIn, true);
    assert.equal(ck.json.cookies.bilibili.userId, '42');

    const r = await call(fn, 'POST', '/api/collect/download', { url: 'https://www.bilibili.com/video/BV1FAKE00011' });
    const job = await waitJob(fn, r.json.jobId);
    assert.equal(job.cookiesUsed, true);
    assert.ok(job.notes.some((n) => /42/.test(n)), JSON.stringify(job.notes));

    const probe = await call(fn, 'POST', '/api/collect/probe', { url: 'BV1FAKE00011' });
    assert.equal(probe.json.cookiesUsed, true);

    // When already logged in, login does not pop up a window
    const login = await call(fn, 'POST', '/api/collect/login', { site: 'bilibili' });
    assert.equal(login.json.alreadyLoggedIn, true);
    assert.equal(login.json.userId, '42');

    const bad = await call(fn, 'DELETE', '/api/collect/cookies?site=evil');
    assert.equal(bad.status, 400);
    const del = await call(fn, 'DELETE', '/api/collect/cookies?site=bilibili');
    assert.equal(del.json.removed, true);
    assert.equal(del.json.cookies.bilibili.loggedIn, false);
  } finally {
    fs.rmSync(path.join(FAKE_ROOT, 'out', 'cookies'), { recursive: true, force: true });
  }
});

test('QR login route: start gives key and svgUrl, svg is an image, poll forwards the status; after a successful login, login/check reads directly from disk', async () => {
  const fn = handlerOf();
  const KEY = 'aa6b16028dda91ae6543bed069a249ea';
  const soon = new Date(Date.now() + 30 * 86400 * 1000).toUTCString();
  let polls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/generate')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ code: 0, data: { url: `https://account.bilibili.com/h5/x?qrcode_key=${KEY}`, qrcode_key: KEY } }) };
    }
    polls++;
    const headers = new Headers();
    if (polls >= 2) {
      for (const l of [`SESSDATA=s; Domain=bilibili.com; Path=/; Expires=${soon}`, `bili_jct=j; Domain=bilibili.com; Path=/; Expires=${soon}`, `DedeUserID=7; Domain=bilibili.com; Path=/; Expires=${soon}`]) headers.append('set-cookie', l);
    }
    return { ok: true, status: 200, headers, json: async () => ({ code: 0, data: { code: polls >= 2 ? 0 : 86101, message: polls >= 2 ? '' : 'Not scanned', url: '' } }) };
  };
  try {
    const s = await call(fn, 'POST', '/api/collect/qr/start', { site: 'bilibili' });
    assert.equal(s.json.ok, true);
    assert.equal(s.json.key, KEY);
    assert.equal(s.json.svgUrl, `/api/collect/qr/svg?key=${KEY}`);
    assert.equal(s.json.expiresIn, 180);

    const svg = await call(fn, 'GET', `/api/collect/qr/svg?key=${KEY}`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers['content-type'], /image\/svg\+xml/);
    assert.match(String(svg.json), /^<svg /);
    assert.equal((await call(fn, 'GET', '/api/collect/qr/svg?key=nope')).status, 404);

    const p1 = await call(fn, 'GET', `/api/collect/qr/poll?key=${KEY}`);
    assert.equal(p1.json.state, 'waiting');
    const p2 = await call(fn, 'GET', `/api/collect/qr/poll?key=${KEY}`);
    assert.equal(p2.json.state, 'ok');
    assert.equal(p2.json.userId, '7');
    assert.ok(fs.existsSync(p2.json.path));

    // Login state is already on disk: check returns saved directly without touching the browser
    const chk = await call(fn, 'POST', '/api/collect/login/check', { site: 'bilibili' });
    assert.equal(chk.json.loggedIn, true);
    assert.equal(chk.json.source, 'saved');
    assert.equal(chk.json.userId, '7');
    // Also visible in status
    const st = await call(fn, 'GET', '/api/collect/status');
    assert.equal(st.json.cookies.bilibili.loggedIn, true);
    assert.equal((await call(fn, 'GET', '/api/collect/qr/poll')).status, 400);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(path.join(FAKE_ROOT, 'out', 'cookies'), { recursive: true, force: true });
  }
});

test('login/check: with nothing saved and no browser open, returns not logged in and does not launch a browser', async () => {
  const fn = handlerOf();
  const r = await call(fn, 'POST', '/api/collect/login/check', { site: 'bilibili' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.loggedIn, false);
  assert.deepEqual(r.json.missing, ['SESSDATA', 'bili_jct', 'DedeUserID']);
  assert.match(r.json.hint, /collect_login/);
});

test('search: a missing query gives 400; normally returns results, a single failing item carries error without dragging down the batch; limit is clamped to 1~10', async () => {
  const fn = handlerOf();
  const bad = await call(fn, 'POST', '/api/collect/search', {});
  assert.equal(bad.status, 400);

  const r = await call(fn, 'POST', '/api/collect/search', { query: 'video editing tutorial', limit: 99 });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.site, 'bilibili');
  assert.equal(r.json.results.length, 2);
  assert.equal(r.json.results[0].title, 'Fake Search Hit');
  assert.equal(r.json.results[0].url, 'https://www.bilibili.com/video/BV1FAKE00000');
  assert.equal(r.json.results[0].view_count, 1234);
  assert.match(r.json.results[1].error, /404/, 'A single probe failure is marked as error only');
  assert.equal(r.json.cookiesUsed, false);
});

test('The cookies parameter only accepts files under <dataDir>/cookies/: paths elsewhere are ignored, so no arbitrary local file is sent to an external site', async () => {
  const fn = handlerOf();
  // Create a real file outside the scope and one inside the scope
  const outside = path.join(OUT, 'secret.txt');
  fs.writeFileSync(outside, 'not a cookie');
  const insideDir = path.join(FAKE_ROOT, 'out', 'cookies');
  fs.mkdirSync(insideDir, { recursive: true });
  const inside = path.join(insideDir, 'custom.txt');
  fs.writeFileSync(inside, '# Netscape HTTP Cookie File\n');
  try {
    const a = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00020', cookies: outside });
    const ja = await waitJob(fn, a.json.jobId);
    assert.equal(ja.cookiesUsed, false, 'Paths outside the allowed scope must be ignored');
    assert.ok(!ja.notes.some((n) => n.includes('secret.txt')), 'Not even the path should appear in notes');

    const b = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00021', cookies: inside });
    const jb = await waitJob(fn, b.json.jobId);
    assert.equal(jb.cookiesUsed, true, 'An explicit path within the allowed scope is used as is');
    // Directory traversal is not allowed either
    const c = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00022', cookies: path.join(insideDir, '..', '..', 'x.txt') });
    const jc = await waitJob(fn, c.json.jobId);
    assert.equal(jc.cookiesUsed, false);
  } finally {
    fs.rmSync(insideDir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('Paths other than /api/collect are passed through to next() unchanged', async () => {
  const fn = handlerOf();
  let passed = false;
  await fn({ url: '/api/shots/status', method: 'GET', headers: {} }, {}, () => { passed = true; });
  assert.equal(passed, true);
});
