// 素材收集插件:接口形状、作业表、错误路径。用 fake-collect.cmd 冒充 Python,
// 不联网、不装 yt-dlp。跑法:node --test server/test/collect-plugin.test.mjs
//
// 插件是 .ts,这里用 typescript 转译到临时目录再 import(和 cards.test 一个路数),
// 它依赖的 vite-plugin-stt / vite-plugin-media 也一起转,import 路径改成转译产物。
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
  // 登录那几条路动态 import 浏览器模块;转译产物在临时目录,相对路径找不到,改成绝对的
  ['import("./web/browser.mjs")', `import("${pathToFileURL(path.join(ROOT, 'server', 'web', 'browser.mjs')).href}")`],
  ['import("./web/session.mjs")', `import("${pathToFileURL(path.join(ROOT, 'server', 'web', 'session.mjs')).href}")`],
]);
const { saveCookies } = await import(cookiesUrl);

// 假 Python:插件按 -m promptcut_collect <子命令> 调它,它按子命令回放固定 JSONL
process.env.PROMPTCUT_PYTHON = path.join(ROOT, 'server', 'test', 'fake-collect.cmd');
// 项目根用临时目录:buildEnv 会在 <root>/out 下建 pylibs / models
const FAKE_ROOT = path.join(OUT, 'root');
fs.mkdirSync(FAKE_ROOT, { recursive: true });

// 下载结果经素材服务的入库接口进内容库(server/media-ingest.mjs):起一台真的素材服务(fs 内容库 + 媒体中间件),
// 编辑器进程的素材服务地址指向它(asset-client.ts 的 assetServiceOrigin 先看 PROMPTCUT_EDITOR_URL)
const harness = createAssetHarness();
const assetSvc = await harness.serve({ stores: 'default' });
process.env.PROMPTCUT_EDITOR_URL = assetSvc.origin;
after(async () => { await harness.cleanup(); delete process.env.PROMPTCUT_EDITOR_URL; });
/** fake-collect.cmd 写进 --out-dir 的那份内容(echo 带 CRLF) */
const FAKE_BYTES = Buffer.from('fake video bytes\r\n');

const { collectPlugin } = await import(collectUrl);

/** 把插件的中间件拿出来 */
function handlerOf() {
  const plugin = collectPlugin();
  let fn;
  plugin.configureServer({
    config: { root: FAKE_ROOT },
    middlewares: { use(f) { fn = f; } },
  });
  assert.ok(fn, '插件没有注册中间件');
  return fn;
}

/** 发一个请求,拿回 { status, json } */
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
    fn(req, res, () => reject(new Error('落到了 next(),插件没接这个路径:' + url)));
  });
}

async function waitJob(fn, jobId, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(fn, 'GET', `/api/collect/job/${jobId}`);
    assert.equal(r.status, 200);
    if (r.json.job.status !== 'running') return r.json.job;
    assert.ok(Date.now() - t0 < timeoutMs, '作业迟迟不结束');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('status:转发 Python 的 status 事件,并带 python: true', async () => {
  const fn = handlerOf();
  const r = await call(fn, 'GET', '/api/collect/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.python, true);
  assert.equal(r.json.ready, true);
  assert.equal(r.json.ytdlp.version, 'fake');
  assert.deepEqual(r.json.presets.map((p) => p.name), ['bilibili', 'generic']);
});

test('probe:缺 url 是 400;正常返回 done 的字段并把 412 重试记进 notes', async () => {
  const fn = handlerOf();
  const bad = await call(fn, 'POST', '/api/collect/probe', {});
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);

  const r = await call(fn, 'POST', '/api/collect/probe', { url: 'BV1FAKE00000', site: 'bilibili', quality: 720 });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.title, 'Fake Video 测试', '中文标题要原样过来,不能变成 \\uXXXX');
  assert.equal(r.json.duration, 12.5);
  assert.deepEqual(r.json.heights, [1080, 720]);
  assert.equal(r.json.parts, null);
  // notes 里除了 retry 还有一条「未登录」的说明(B 站链接会看登录态),所以不断言条数
  assert.ok(r.json.notes.some((n) => /412/.test(n)), 'retry 事件要记进 notes:' + JSON.stringify(r.json.notes));
  assert.equal(r.json.cookiesUsed, false);
});

test('probe 失败:ok:false 且 error 是 Python 报的那句', async () => {
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

test('MI-5 download:立刻回 jobId;轮到 done 时 items 带入库后的 /@media/<hash>、percent 100、notes 有重试记录;素材目录里没有绕过入库的文件', async () => {
  const fn = handlerOf();
  const started = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00000', quality: 720 });
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);
  assert.match(started.json.jobId, /^[\w-]{8}$/);
  assert.equal(started.json.outDir, undefined, '不再回素材目录:下载先落临时目录,再经素材服务入库');

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
  assert.equal(item.hash, hash, '内容哈希是素材服务入库时算的');
  assert.equal(item.url, `/@media/${hash}`);
  assert.equal(item.media?.hash, hash, '入库回包原样带给页面');
  assert.equal(item.path, undefined, '不再给临时文件的磁盘路径');
  // 字节确实在素材服务的内容库里,经它的接口取得到
  const got = await fetch(`${assetSvc.origin}/@media/${hash}`);
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), FAKE_BYTES);
  // 编辑器自己的素材目录里没有绕过入库落下的文件
  const own = path.join(FAKE_ROOT, 'out', 'media');
  assert.deepEqual(fs.existsSync(own) ? fs.readdirSync(own) : [], [], '素材目录里不该出现下载直接落下的文件');
  assert.equal(item.vcodec, 'h264');
  assert.equal(item.width, 1920);
  assert.ok(job.notes.some((n) => /412/.test(n)), '412 重试要记进 notes:' + JSON.stringify(job.notes));
  assert.ok(job.finishedAt >= job.startedAt);
});

test('download:done 事件之后进程还没退,轮询看到的仍是 running;报 done 时一定带 finishedAt', async () => {
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

test('MI-6 download:素材服务不可达时作业报错(写明素材服务地址),素材目录与临时目录都不留文件', async () => {
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
    assert.ok(job.message.includes(`素材服务不可达(${gone})`), job.message);
    assert.equal(job.items.length, 0);
  } finally {
    Object.assign(process.env, { PROMPTCUT_EDITOR_URL: saved.url, TEMP: saved.TEMP, TMP: saved.TMP });
  }
  const own = path.join(FAKE_ROOT, 'out', 'media');
  assert.deepEqual(fs.existsSync(own) ? fs.readdirSync(own) : [], []);
  for (let i = 0; i < 50 && fs.readdirSync(privateTmp).some((n) => n.startsWith('pc-collect-')); i++) await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(fs.readdirSync(privateTmp).filter((n) => n.startsWith('pc-collect-')), [], '作业的临时目录要删掉');
});

test('download:清晰度不在白名单里就退回 1080;site 不认识退回 auto', async () => {
  const fn = handlerOf();
  const r = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00001', quality: 999, site: 'evil' });
  const job = await waitJob(fn, r.json.jobId);
  assert.equal(job.quality, 1080);
  assert.equal(job.site, 'auto');
});

test('download 失败:status error,message 是 Python 的 error 事件', async () => {
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

test('作业表:不存在的 jobId 是 404;jobs 列表新的在前;DELETE 已完成的作业不改状态', async () => {
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
  assert.equal(del.json.job.status, 'done', '已经跑完的作业取消不该变成 error');
});

test('缺 url / 坏 JSON / 未知路径 各有明确的错误', async () => {
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

test('登录态:status 里带各站 cookies;没存盘时下载不带 cookie 并在 notes 里说明', async () => {
  const fn = handlerOf();
  const st = await call(fn, 'GET', '/api/collect/status');
  assert.equal(st.json.cookies.bilibili.loggedIn, false);
  assert.equal(st.json.cookies.bilibili.name, '哔哩哔哩');

  const r = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00010' });
  const job = await waitJob(fn, r.json.jobId);
  assert.equal(job.cookiesUsed, false);
  assert.ok(job.notes.some((n) => /未登录/.test(n)), JSON.stringify(job.notes));

  // 不是有登录支持的站:一个字都不提
  const y = await call(fn, 'POST', '/api/collect/download', { url: 'https://www.youtube.com/watch?v=x' });
  const yj = await waitJob(fn, y.json.jobId);
  assert.equal(yj.cookiesUsed, false);
  assert.ok(!yj.notes.some((n) => /登录/.test(n)));
});

test('登录态:存盘之后 B 站链接自动带 cookie,cookies 接口能查能删', async () => {
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

    // 已登录时 login 不弹窗
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

test('扫码登录路由:start 给 key 和 svgUrl,svg 是图,poll 转发状态;登录成功后 login/check 直接从存盘读', async () => {
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
    return { ok: true, status: 200, headers, json: async () => ({ code: 0, data: { code: polls >= 2 ? 0 : 86101, message: polls >= 2 ? '' : '未扫码', url: '' } }) };
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

    // 登录态已经在盘上:check 不碰浏览器,直接回 saved
    const chk = await call(fn, 'POST', '/api/collect/login/check', { site: 'bilibili' });
    assert.equal(chk.json.loggedIn, true);
    assert.equal(chk.json.source, 'saved');
    assert.equal(chk.json.userId, '7');
    // status 里也看得到
    const st = await call(fn, 'GET', '/api/collect/status');
    assert.equal(st.json.cookies.bilibili.loggedIn, true);
    assert.equal((await call(fn, 'GET', '/api/collect/qr/poll')).status, 400);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(path.join(FAKE_ROOT, 'out', 'cookies'), { recursive: true, force: true });
  }
});

test('login/check:没存盘也没开浏览器时,回未登录且不拉起浏览器', async () => {
  const fn = handlerOf();
  const r = await call(fn, 'POST', '/api/collect/login/check', { site: 'bilibili' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.loggedIn, false);
  assert.deepEqual(r.json.missing, ['SESSDATA', 'bili_jct', 'DedeUserID']);
  assert.match(r.json.hint, /collect_login/);
});

test('search:缺 query 是 400;正常回 results,单条失败的带 error 不拖累整批;limit 夹到 1~10', async () => {
  const fn = handlerOf();
  const bad = await call(fn, 'POST', '/api/collect/search', {});
  assert.equal(bad.status, 400);

  const r = await call(fn, 'POST', '/api/collect/search', { query: '视频剪辑教程', limit: 99 });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.site, 'bilibili');
  assert.equal(r.json.results.length, 2);
  assert.equal(r.json.results[0].title, 'Fake Search Hit');
  assert.equal(r.json.results[0].url, 'https://www.bilibili.com/video/BV1FAKE00000');
  assert.equal(r.json.results[0].view_count, 1234);
  assert.match(r.json.results[1].error, /404/, '单条探测失败只标 error');
  assert.equal(r.json.cookiesUsed, false);
});

test('cookies 参数只认 <dataDir>/cookies/ 下的文件:别处的路径被忽略,不会把任意本地文件发给外站', async () => {
  const fn = handlerOf();
  // 造一个在范围外的真实文件,和一个在范围内的
  const outside = path.join(OUT, 'secret.txt');
  fs.writeFileSync(outside, 'not a cookie');
  const insideDir = path.join(FAKE_ROOT, 'out', 'cookies');
  fs.mkdirSync(insideDir, { recursive: true });
  const inside = path.join(insideDir, 'custom.txt');
  fs.writeFileSync(inside, '# Netscape HTTP Cookie File\n');
  try {
    const a = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00020', cookies: outside });
    const ja = await waitJob(fn, a.json.jobId);
    assert.equal(ja.cookiesUsed, false, '范围外的路径必须被忽略');
    assert.ok(!ja.notes.some((n) => n.includes('secret.txt')), '连路径都不该出现在 notes 里');

    const b = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00021', cookies: inside });
    const jb = await waitJob(fn, b.json.jobId);
    assert.equal(jb.cookiesUsed, true, '范围内的显式路径照用');
    // 目录穿越也不行
    const c = await call(fn, 'POST', '/api/collect/download', { url: 'BV1FAKE00022', cookies: path.join(insideDir, '..', '..', 'x.txt') });
    const jc = await waitJob(fn, c.json.jobId);
    assert.equal(jc.cookiesUsed, false);
  } finally {
    fs.rmSync(insideDir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('不是 /api/collect 的路径原样放行给 next()', async () => {
  const fn = handlerOf();
  let passed = false;
  await fn({ url: '/api/shots/status', method: 'GET', headers: {} }, {}, () => { passed = true; });
  assert.equal(passed, true);
});
