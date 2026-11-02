/**
 * Agent 读写素材的路径,第二段(`docs/plan/TODO.md`「语义与代码的差距」;语义 `docs/semantics/product/agent.md`「素材与产物」、
 * `product/asset-service.md`「职责」):
 *   - 三个感知工具 `detect_shots`(/api/shots/detect)、`track_points`(/api/track/track)、`detect_subjects`(/api/subject/detect)
 *     只收素材标识,经素材服务的 HTTP 接口取字节(server/perception-source.mjs),请求体里的 path 不再读盘;
 *   - 配音 `voice_generate`(/api/voice/generate)的结果先落临时目录,再经素材服务的入库接口进内容库(server/media-ingest.mjs)。
 *     素材收集 `collect_download` 的同类用例在 collect-plugin.test.mjs(MI-5、MI-6)。
 *
 * 用例(PK = perception,感知工具读素材;MI = media ingest,生成的素材入库):
 *   PK-1  请求体 → 素材标识:只取 id / name / kind / url / hash,path 一概不取;没有标识 400、素材服务上没有 404、不可达 502;
 *   PK-2  Python 包认不认地址:答 1 才算认,其余一律按不认;问的那行代码不带 cmd 元字符(用假的解释器,不要本机 Python);
 *   PK-3  给 Python 的输入:认地址递地址,不认先流到临时文件(字节相同、用完删);404 / 连不上抛 AssetSourceError 且不留临时目录;
 *   ── 以下起真的素材服务(fs 内容库 + 媒体中间件,前面挂一个计数的转发)与真的 ffmpeg,插件经 typescript 转译后直接挂到 http 上 ──
 *   PK-4  镜头识别(scdet 档,不要 Python):素材目录不可读、素材服务可达时照常出结果,转场时刻、时长、帧率与直接读文件的 scdet 相同,
 *         缩略图与直接读文件抽的逐字节相同;字节确实经素材服务来(Range 请求);
 *   PK-5  三条接口:请求体带任意 path(指着真实存在的文件)不会被读;没有标识 400、素材服务上没有 404、素材服务不可达 502,分得清;
 *   (要真 Python 的检查 —— 三个包答 ACCEPTS_URL、运动追踪经地址与读文件结果相同、老包走临时文件、主体检测抽帧像素相同 ——
 *    在探针 scripts/probes/asset-path-probe.mjs 的 P6～P11,单测不随机器上有没有 Python 而多出跳过)
 *   MI-1  入库:字节进内容库、哈希是内容的 sha256、同样内容第二次去重;
 *   MI-2  入库失败分得清:取不到地址 / 连不上 / 拒绝(HTTP 500) → AssetSourceError;要入库的文件不见了 → 普通错误;
 *   MI-3  配音:合成结果经入库接口进内容库,回 /@media/<hash> 与入库回包,不回临时路径;素材目录里没有绕过入库的文件;临时目录删掉;
 *   MI-4  配音时素材服务不可达:回 502 与 kind asset-service,素材目录与临时目录都不留东西。
 *
 * 跑:node --test server/test/perception-asset-path.test.mjs
 *   要 ffmpeg(找不到时 PK-4 起跳过)。不要 Python:镜头识别走 scdet 兜底档,追踪与主体检测只测接口的取素材那一步。
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createAssetHarness, ROOT } from './fake-asset-service.mjs';
import { AssetSourceError, createAssetSourceResolver } from '../audio-source.mjs';
import { acceptsUrlCode, downloadToTemp, mediaRefOf, pythonAcceptsUrl, pythonInput, resolveMediaSource } from '../perception-source.mjs';
import { ingestFile } from '../media-ingest.mjs';
import { findFfmpeg } from '../ai-visual.mjs';

const harness = createAssetHarness();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-perception-test-'));
const SAVED_ENV = { ...process.env };
// 插件读的几个目录都指到临时目录:Python 的 pylibs / models、镜头缩略图(dataDir)、配音设置
process.env.PROMPTCUT_PYLIBS = path.join(TMP, 'pylibs');
process.env.PROMPTCUT_MODELS = path.join(TMP, 'models');
process.env.PROMPTCUT_DATA_DIR = path.join(TMP, 'data');
process.env.PROMPTCUT_AI_CONFIG = path.join(TMP, 'config', 'ai.json');
delete process.env.PROMPTCUT_PYTHON;
after(async () => {
  await harness.cleanup();
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve({ server: s, origin: `http://127.0.0.1:${s.address().port}` }));
});
const closeServer = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 一个刚关掉的端口:连上去必然 ECONNREFUSED */
async function closedOrigin() {
  const s = await listen(() => {});
  await closeServer(s.server);
  return s.origin;
}

/* ------------------------------------------------------------------ PK-1 ～ PK-3:不要 ffmpeg */

test('PK-1 request body → asset identifier: path is never used; no identifier gives 400, no such asset gives 404, asset service unreachable gives 502', async () => {
  const h = 'ab'.repeat(32);
  assert.deepEqual(mediaRefOf({ mediaId: 'm1', media: { id: 'm1', name: 'a.mp4', kind: 'video', url: `/@media/${h}`, hash: h, path: 'C:\\Windows\\win.ini' } }),
    { id: 'm1', name: 'a.mp4', kind: 'video', url: `/@media/${h}`, hash: h });
  assert.equal(mediaRefOf({ path: 'C:\\Windows\\win.ini', mediaId: 'm1' }), null, 'An old request body with only path does not count as an asset identifier');
  assert.equal(mediaRefOf({ media: { id: 'm1', path: 'C:\\Windows\\win.ini' } }), null, 'path alone inside media does not count either');
  assert.equal(mediaRefOf({ media: { hash: h } , mediaId: 'm2' }).id, 'm2', 'id defaults to mediaId');

  const seen = [];
  const svc = await listen((req, res) => {
    seen.push(req.url);
    if (req.url.endsWith('/missing')) { res.statusCode = 404; return res.end(); }
    res.writeHead(206, { 'Content-Range': 'bytes 0-0/10', 'Content-Length': 1 }); res.end('x');
  });
  const resolver = createAssetSourceResolver({ origin: () => svc.origin, toUrl: (m, o) => (m.hash ? `${o}/@media/${m.hash}` : null) });
  const noRef = await resolveMediaSource({ path: path.join(ROOT, 'package.json') }, resolver);
  assert.equal(noRef.status, 400);
  assert.match(noRef.error, /no longer accept/);
  const miss = await resolveMediaSource({ media: { name: 'missing.mp4', hash: 'missing' } }, resolver);
  assert.equal(miss.status, 404);
  assert.match(miss.error, /no such asset on the asset service: missing\.mp4/);
  const ok = await resolveMediaSource({ media: { hash: 'fine' }, path: 'D:\\secret.mp4' }, resolver);
  assert.deepEqual([ok.ok, ok.src], [true, `${svc.origin}/@media/fine`]);
  assert.deepEqual(seen, ['/@media/missing', '/@media/fine'], 'The call without an identifier sent no request at all');
  await closeServer(svc.server);

  const gone = await closedOrigin();
  const down = await resolveMediaSource({ media: { hash: 'x' } }, createAssetSourceResolver({ origin: () => gone, toUrl: (m, o) => `${o}/@media/${m.hash}` }));
  assert.equal(down.status, 502);
  assert.equal(down.kind, 'asset-service');
  assert.ok(down.error.includes(`asset service unreachable (${gone})`), down.error);
});

/**
 * 假的「Python」:不管递什么参数,都起一个 node 子进程把 answer 写到 stdout 后退出(退出码 code)。
 * 单测不依赖本机有没有 Python(依赖真 Python 的检查在 scripts/probes/asset-path-probe.mjs 的 P9～P11)。
 */
const fakePython = (answer, code = 0) => () => spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(answer)}); process.exit(${code})`], { windowsHide: true });

test('PK-2 Whether the Python package accepts URLs: an answer of 1 counts as accepting; an answer of 0, a non-zero exit code, an interpreter that fails to start, or a spawn error all count as not accepting; the line of code used to ask contains no cmd metacharacters', async () => {
  for (const pkg of ['promptcut_shots', 'promptcut_track', 'promptcut_subject']) {
    const code = acceptsUrlCode(pkg);
    assert.ok(!/[&|<>^"%]/.test(code), 'The .cmd interpreter rejects arguments that contain metacharacters');
    assert.ok(code.includes(`'${pkg}'`) && code.includes('ACCEPTS_URL'));
  }
  const ask = (spawnPython, python = 'python') => pythonAcceptsUrl({ python, env: process.env, pkg: 'promptcut_track', spawnPython });
  assert.equal(await ask(fakePython('1')), true);
  assert.equal(await ask(fakePython('0')), false);
  assert.equal(await ask(fakePython('1', 3)), false, 'A non-zero exit code counts as not accepting');
  assert.equal(await ask((python, args, env) => spawn(python, args, { env, windowsHide: true }), path.join(TMP, 'no-python.exe')), false, 'An interpreter that fails to start counts as not accepting');
  assert.equal(await ask(() => { throw new Error('refuse'); }), false, 'A spawn error counts as not accepting');
  // 问的时候递的参数:-c 加那一行代码
  let seenArgs = null;
  await ask((python, args) => { seenArgs = args; return fakePython('1')(); });
  assert.deepEqual(seenArgs, ['-c', acceptsUrlCode('promptcut_track')]);
});

test('PK-3 Input for Python: if it accepts URLs, pass the URL; otherwise stream to a temp file (same bytes, deleted after use); a 404 or a failed connection throws AssetSourceError and leaves no temp directory', async () => {
  const body = crypto.randomBytes(300_000);
  const svc = await listen((req, res) => {
    if (req.url === '/missing') { res.statusCode = 404; return res.end('no'); }
    res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
  });
  const root = fs.mkdtempSync(path.join(TMP, 'dl-'));
  const src = `${svc.origin}/ok`;
  const viaUrl = await pythonInput({ src, ref: {}, python: 'py', env: {}, pkg: 'promptcut_track', spawnPython: fakePython('1'), tmpRoot: root });
  assert.deepEqual([viaUrl.via, viaUrl.input], ['url', src], 'New package: pass the URL as is');
  const viaTemp = await pythonInput({ src, ref: { name: '镜头.MP4' }, python: 'py', env: {}, pkg: 'promptcut_track', spawnPython: fakePython('0'), tmpRoot: root });
  assert.equal(viaTemp.via, 'temp', 'Old package: stream to a temp file first');
  assert.equal(path.extname(viaTemp.input), '.mp4', 'The extension follows the asset name');
  assert.deepEqual(fs.readFileSync(viaTemp.input), body);
  viaTemp.cleanup();
  assert.deepEqual(fs.readdirSync(root), [], 'cleanup deletes the directory too');
  await assert.rejects(downloadToTemp(`${svc.origin}/missing`, {}, { tmpRoot: root }), (e) => e instanceof AssetSourceError && /HTTP 404/.test(e.message));
  assert.deepEqual(fs.readdirSync(root), [], 'No temp directory is left behind on failure either');
  await closeServer(svc.server);
  const gone = await closedOrigin();
  await assert.rejects(pythonInput({ src: `${gone}/x`, ref: {}, python: 'py', env: {}, pkg: 'x', spawnPython: fakePython('0'), tmpRoot: root }), (e) => e instanceof AssetSourceError && /failed to fetch bytes/.test(e.message));
  assert.deepEqual(fs.readdirSync(root), []);
  // 地址以外的输入原样递(解析器只拼 http 地址,这条只是兜底),也不去问 Python
  const passthrough = await pythonInput({ src: 'C:\\x.mp4', ref: {}, python: 'none', env: {}, pkg: 'x', spawnPython: () => { throw new Error('Should not have asked'); } });
  assert.equal(passthrough.input, 'C:\\x.mp4');
});

/* ------------------------------------------------------------------ 真的素材服务 + ffmpeg */

const FFMPEG = findFfmpeg();
const FFPROBE = FFMPEG ? path.join(path.dirname(FFMPEG), 'ffprobe' + path.extname(FFMPEG)) : null;
const skip = FFMPEG ? false : 'ffmpeg not found';
// 镜头识别插件按名字 spawn ffprobe / ffmpeg(PATH 上找),把找到的那份放到 PATH 最前面
if (FFMPEG && path.isAbsolute(FFMPEG)) process.env.PATH = path.dirname(FFMPEG) + path.delimiter + process.env.PATH;

const gen = (out, args) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args, out], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return out;
};

/** 素材服务(fs 内容库 + 媒体中间件),前面挂一个计数的转发;素材经 /api/media/upload 入库(和用户导入同一条路) */
async function startService() {
  const svc = await harness.serve({ stores: 'default' });
  const requests = [];
  const front = await listen((req, res) => {
    const up = http.request(new URL(req.url, svc.origin), { method: req.method, headers: req.headers }, (r) => {
      requests.push({ method: req.method, url: req.url, range: req.headers.range || null, status: r.statusCode });
      res.writeHead(r.statusCode, r.headers);
      res.on('close', () => r.destroy());
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) { res.statusCode = 502; res.end(); } });
    req.pipe(up);
  });
  const upload = async (file) => {
    const r = await fetch(`${svc.origin}/api/media/upload/${encodeURIComponent(path.basename(file))}`, { method: 'POST', body: fs.readFileSync(file) });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.hash, sha256(fs.readFileSync(file)));
    return data.hash;
  };
  return {
    origin: front.origin, requests, upload, contentRoot: svc.root,
    mediaGets: (hash) => requests.filter((q) => q.method === 'GET' && q.url.startsWith(`/@media/${hash}`)),
    reset() { requests.length = 0; },
    async stop() { await closeServer(front.server); await svc.close(); },
  };
}

/** 把插件转译后挂到一个 http server 上;落到 next() 回 404 */
async function mountPlugin(file, exportName, root) {
  const mod = await import(harness.compileTs(path.join(ROOT, 'server', file)));
  let fn;
  mod[exportName]().configureServer({ config: { root }, middlewares: { use(f) { fn = f; } } });
  assert.ok(fn, `${file} has no registered middleware`);
  const s = await listen((req, res) => { void fn(req, res, () => { res.statusCode = 404; res.end('next'); }); });
  return s;
}
const post = async (origin, url, body) => {
  const r = await fetch(origin + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function waitJob(origin, prefix, jobId, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`${origin}${prefix}/job/${jobId}`);
    const data = await r.json();
    assert.equal(r.status, 200, JSON.stringify(data));
    if (data.job.status !== 'running') return data.job;
    assert.ok(Date.now() - t0 < timeoutMs, 'The job takes too long to finish');
    await sleep(150);
  }
}

let service;
let shotsSrv;
let trackSrv;
let subjectSrv;
const files = {};
const hashes = {};
/** 空的项目根:没有 desktop 运行时、没有 python/.venv,findPython 在没设 PROMPTCUT_PYTHON 时找不到解释器 */
const BARE_ROOT = path.join(TMP, 'bare-root');
/** 素材记录里的 path 指向一个不存在的目录:素材目录不可读,只有标识可用 */
const GONE = path.join(TMP, 'nonexistent-asset-dir');
const refOf = (k) => ({ id: `m-${k}`, name: path.basename(files[k]), kind: 'video', url: `/@media/${hashes[k]}${path.extname(files[k])}`, hash: hashes[k] });

if (FFMPEG) {
  fs.mkdirSync(BARE_ROOT, { recursive: true });
  // 三段纯色硬切(1 秒、1 秒、1 秒):scdet 在 1 秒、2 秒处各报一次
  files.cuts = gen(path.join(TMP, 'cuts.mp4'), [
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=1',
    '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=25:d=1',
    '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  ]);
}

before(async () => {
  if (!FFMPEG) return;
  service = await startService();
  for (const [k, f] of Object.entries(files)) hashes[k] = await service.upload(f);
  process.env.PROMPTCUT_EDITOR_URL = service.origin;
  shotsSrv = await mountPlugin('vite-plugin-shots.ts', 'shotsPlugin', BARE_ROOT);
  // 追踪、主体检测要找得到仓库里的 python/ 包(buildEnv 按 <root>/python 补 PYTHONPATH),根用仓库目录;数据目录都指到了临时目录
  trackSrv = await mountPlugin('vite-plugin-track.ts', 'trackPlugin', ROOT);
  subjectSrv = await mountPlugin('vite-plugin-subject.ts', 'subjectPlugin', ROOT);
});
after(async () => {
  for (const s of [shotsSrv, trackSrv, subjectSrv, voiceSrv]) if (s) await closeServer(s.server);
  await service?.stop();
});

/** 改前的读法:直接交本地文件给 scdet(原来 detectWithScdet 的参数) */
function scdetTimes(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-vf', 'scdet=threshold=10', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  return [...String(r.stderr).matchAll(/lavfi\.scd\.time:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
}

test('PK-4 Shot detection (scdet tier): with the asset catalog unreadable but the asset service reachable, results are produced as usual, and the results and thumbnails match those from reading the file directly', { skip }, async () => {
  service.reset();
  const r = await post(shotsSrv.origin, '/api/shots/detect', { mediaId: 'm-cuts', media: refOf('cuts'), path: path.join(GONE, 'cuts.mp4') });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const job = await waitJob(shotsSrv.origin, '/api/shots', r.json.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.engine, 'scdet', 'The empty project root has no Python, so it falls back to scdet');
  assert.equal(job.mediaId, 'm-cuts');

  const expected = scdetTimes(files.cuts);
  assert.equal(expected.length, 2, 'The constructed asset should have two hard cuts:' + JSON.stringify(expected));
  assert.deepEqual(job.transitions.map((t) => t.time), expected, 'Transition times match scdet reading the file directly');
  assert.deepEqual(job.shots.map((s) => [s.start, s.end]), [[0, expected[0]], [expected[0], expected[1]], [expected[1], job.duration]]);
  // 时长、帧率:与直接对文件跑同一组 ffprobe 参数相同
  const probe = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate:format=duration', '-of', 'json', files.cuts], { encoding: 'utf8', windowsHide: true }).stdout);
  assert.equal(job.duration, Number(probe.format.duration));
  assert.equal(job.fps, 25);

  // 缩略图:与直接对文件抽(原来 grabThumbs 的参数)逐字节相同
  const thumbDir = path.join(process.env.PROMPTCUT_DATA_DIR, 'shots');
  for (const t of job.transitions) {
    assert.equal(t.thumbs?.length, 1);
    const direct = path.join(TMP, `direct-${t.thumbs[0]}`);
    const g = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t.end + 0.04)), '-i', files.cuts, '-frames:v', '1', '-vf', 'scale=160:-2', '-y', direct], { windowsHide: true });
    assert.equal(g.status, 0);
    assert.deepEqual(fs.readFileSync(path.join(thumbDir, t.thumbs[0])), fs.readFileSync(direct), `Thumbnail ${t.thumbs[0]}`);
    // 缩略图经插件自己的路由照常取得到
    const img = await fetch(`${shotsSrv.origin}/api/shots/thumb/${t.thumbs[0]}`);
    assert.equal(img.status, 200);
  }
  // 字节确实经素材服务的接口来:探测 1 字节 + ffprobe / ffmpeg 的若干次 GET
  const gets = service.mediaGets(hashes.cuts);
  assert.ok(gets.length >= 4, 'The asset service should see requests for probing, ffprobe, scdet and thumbnails:' + JSON.stringify(gets));
  assert.equal(gets[0].range, 'bytes=0-0', 'The first request is the probe');
});

test('PK-5 Three endpoints: an arbitrary path is never read; no identifier gives 400, no such asset gives 404, asset service unreachable gives 502', { skip }, async () => {
  const realFile = files.cuts; // 真实存在的视频:改前递 path 就会被读
  const endpoints = [
    [shotsSrv, '/api/shots/detect', {}],
    [trackSrv, '/api/track/track', { points: [[0, 28, 58]] }],
    [subjectSrv, '/api/subject/detect', { times: [0.5] }],
  ];
  for (const [srv, url, extra] of endpoints) {
    service.reset();
    const onlyPath = await post(srv.origin, url, { mediaId: 'm-x', path: realFile, ...extra });
    assert.equal(onlyPath.status, 400, `${url} given only path:` + JSON.stringify(onlyPath.json));
    assert.equal(onlyPath.json.jobId, undefined, 'No job is started');
    const refPath = await post(srv.origin, url, { mediaId: 'm-x', media: { id: 'm-x', name: 'x.mp4', path: realFile }, ...extra });
    assert.equal(refPath.status, 400, `${url} path only inside media`);
    assert.equal(service.requests.length, 0, `${url}: no request at all is sent when there is no identifier`);

    const missing = await post(srv.origin, url, { mediaId: 'm-x', media: { id: 'm-x', name: 'missing.mp4', hash: 'fe'.repeat(32) }, path: realFile, ...extra });
    assert.equal(missing.status, 404, `${url} not on the asset service:` + JSON.stringify(missing.json));
    assert.match(missing.json.error, /no such asset on the asset service: missing\.mp4/);
    assert.equal(missing.json.jobId, undefined, 'Even when path points at a real file, it is not used as a substitute');
  }
  // 素材服务不可达
  const gone = await closedOrigin();
  process.env.PROMPTCUT_EDITOR_URL = gone;
  try {
    for (const [srv, url, extra] of endpoints) {
      const down = await post(srv.origin, url, { mediaId: 'm-cuts', media: refOf('cuts'), path: realFile, ...extra });
      assert.equal(down.status, 502, `${url} unreachable:` + JSON.stringify(down.json));
      assert.equal(down.json.kind, 'asset-service');
      assert.ok(down.json.error.includes(`asset service unreachable (${gone})`), down.json.error);
    }
  } finally {
    process.env.PROMPTCUT_EDITOR_URL = service.origin;
  }
});

/* ------------------------------------------------------------------ MI:生成的素材经入库接口进内容库 */

test('MI-1 Ingest: bytes go into the content store, the hash is the sha256 of the content, and identical content is deduplicated the second time', { skip }, async () => {
  const file = path.join(TMP, '配音 01.mp3');
  const bytes = crypto.randomBytes(50_000);
  fs.writeFileSync(file, bytes);
  const a = await ingestFile({ file, origin: () => service.origin, tiers: false });
  assert.equal(a.hash, sha256(bytes));
  assert.equal(a.url, `/@media/${a.hash}`);
  assert.equal(a.bytes, bytes.length);
  assert.equal(a.ext, 'mp3');
  const got = await fetch(`${service.origin}/@media/${a.hash}`);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
  const b = await ingestFile({ file, name: 'again.mp3', origin: () => service.origin });
  assert.equal(b.hash, a.hash);
  assert.equal(b.deduped, true);
  assert.ok(service.requests.some((q) => q.method === 'POST' && q.url.startsWith('/api/media/upload/')), 'It goes through the ingest endpoint');
});

test('MI-2 Ingest failures can be told apart: cannot get the address / cannot connect / rejected → AssetSourceError; file missing → plain error', async () => {
  const file = path.join(TMP, 'mi2.wav');
  fs.writeFileSync(file, 'RIFF');
  await assert.rejects(ingestFile({ file, origin: () => null }), (e) => e instanceof AssetSourceError && /cannot get the asset service address/.test(e.message));
  const gone = await closedOrigin();
  await assert.rejects(ingestFile({ file, origin: () => gone }), (e) => e instanceof AssetSourceError && e.message.includes(`asset service unreachable (${gone})`));
  const bad = await listen((req, res) => { req.resume(); req.on('end', () => { res.statusCode = 500; res.end('disk full'); }); });
  await assert.rejects(ingestFile({ file, origin: () => bad.origin }), (e) => e instanceof AssetSourceError && /rejected the ingest.*HTTP 500.*disk full/.test(e.message));
  await closeServer(bad.server);
  await assert.rejects(ingestFile({ file: path.join(TMP, 'nope.wav'), origin: () => 'http://127.0.0.1:9' }), (e) => !(e instanceof AssetSourceError) && /file to ingest is missing/.test(e.message));
});

/** 配音插件:服务商的请求全部截下来回一段假的 mp3(hex 494433 = "ID3"),发往本机的照常 */
async function withFakeProvider(fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input instanceof Request ? input.url : input);
    if (/^http:\/\/127\.0\.0\.1[:/]/.test(u)) return real(input, init);
    calls.push(u);
    return new Response(JSON.stringify({ data: { audio: '494433' }, base_resp: { status_code: 0 } }), { status: 200 });
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

let voiceSrv;
const VOICE_ROOT = path.join(TMP, 'voice-root');

async function voiceServer() {
  if (voiceSrv) return voiceSrv;
  const { writeVoiceConfig } = await import('../voice/voice-config.mjs');
  writeVoiceConfig({ apiKey: 'sk-test', baseUrl: 'https://voice-gateway.test' });
  fs.mkdirSync(VOICE_ROOT, { recursive: true });
  voiceSrv = await mountPlugin('vite-plugin-voice.ts', 'voicePlugin', VOICE_ROOT);
  return voiceSrv;
}
/** 编辑器自己的素材目录(改前配音直接写进这里) */
const voiceMediaDir = () => path.join(VOICE_ROOT, 'out', 'media');
const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);

async function withPrivateTmp(fn) {
  const dir = fs.mkdtempSync(path.join(TMP, 'os-tmp-'));
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: dir, TMP: dir, TMPDIR: dir });
  try { return await fn(dir); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
/** 临时目录是异步删的(fs.rm 回调),等它空 */
async function waitEmpty(dir, prefix) {
  for (let i = 0; i < 50; i++) {
    if (!fs.readdirSync(dir).some((n) => n.startsWith(prefix))) return;
    await sleep(40);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(prefix)), [], 'Temp directory was not deleted');
}

test('MI-3 Voiceover: the synthesized result goes into the content store through the ingest endpoint and returns /@media/<hash> with the ingest response; the asset catalog has no file that bypassed ingest', { skip }, async () => {
  const srv = await voiceServer();
  await withPrivateTmp(async (tmp) => {
    await withFakeProvider(async (calls) => {
      service.reset();
      const r = await post(srv.origin, '/api/voice/generate', { text: '开场旁白：你好' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(calls.length, 1, 'The provider is called only once');
      const hash = sha256(Buffer.from('ID3', 'latin1'));
      assert.equal(r.json.hash, hash);
      assert.equal(r.json.url, `/@media/${hash}`);
      assert.equal(r.json.media.hash, hash, 'The ingest response is passed to the page as is (the page registers by it, the same way as importing media)');
      assert.equal(r.json.path, undefined, 'No temp path is returned');
      assert.match(r.json.name, /^voice-\d{8}-\d{6}-开场旁白你好-[0-9a-f]{4}\.mp3$/);
      assert.ok(service.requests.some((q) => q.method === 'POST' && q.url.startsWith('/api/media/upload/')), 'It goes through the ingest endpoint');
      const got = await fetch(`${service.origin}/@media/${hash}`);
      assert.equal(Buffer.from(await got.arrayBuffer()).toString('latin1'), 'ID3');
    });
    assert.deepEqual(listDir(voiceMediaDir()), [], 'No voiceover file that bypassed ingest should appear in the asset catalog');
    await waitEmpty(tmp, 'pc-voice-');
  });
});

test('MI-4 Asset service unreachable during voiceover: returns 502 and kind asset-service, and nothing is left in the asset catalog or the temp directory', { skip }, async () => {
  const srv = await voiceServer();
  const gone = await closedOrigin();
  process.env.PROMPTCUT_EDITOR_URL = gone;
  try {
    await withPrivateTmp(async (tmp) => {
      await withFakeProvider(async () => {
        const r = await post(srv.origin, '/api/voice/generate', { text: 'Hello' });
        assert.equal(r.status, 502, JSON.stringify(r.json));
        assert.equal(r.json.kind, 'asset-service');
        assert.ok(r.json.error.includes(`asset service unreachable (${gone})`), r.json.error);
      });
      await waitEmpty(tmp, 'pc-voice-');
    });
    assert.deepEqual(listDir(voiceMediaDir()), []);
  } finally {
    process.env.PROMPTCUT_EDITOR_URL = service.origin;
  }
});

test('MI-7 Voiceover preview and voice design preview: land in the preview cache directory, replay via /api/voice/preview/, do not write to the asset catalog; file names cannot escape the cache directory', { skip }, async () => {
  const srv = await voiceServer();
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = String(input instanceof Request ? input.url : input);
    if (/^http:\/\/127\.0\.0\.1[:/]/.test(u)) return real(input, init);
    // 音色设计回 voice_id + trial_audio;合成回 data.audio(都是 hex 494433 = "ID3")
    const body = /voice_design/.test(u)
      ? { voice_id: 'ttv-voice/1', trial_audio: '494433', base_resp: { status_code: 0 } }
      : { data: { audio: '494433' }, base_resp: { status_code: 0 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const r = await post(srv.origin, '/api/voice/generate', { text: 'Preview', preview: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.url, '/api/voice/preview/voice-preview-minimax.mp3');
    assert.equal(r.json.path, undefined, 'No disk path is returned');
    const got = await real(srv.origin + r.json.url);
    assert.equal(got.status, 200);
    assert.equal(Buffer.from(await got.arrayBuffer()).toString('latin1'), 'ID3', 'The page can play the URL exactly as returned');
    assert.ok(fs.existsSync(path.join(process.env.PROMPTCUT_DATA_DIR, 'cache', 'voice-preview', 'voice-preview-minimax.mp3')), 'The preview cache lands under the data directory');

    const d = await post(srv.origin, '/api/voice/design', { prompt: 'Young male voice', previewText: 'Hello' });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.previewUrl, '/api/voice/preview/voice-design-ttv-voice_1.mp3', 'The voice id given by the provider has its slashes stripped before being joined into the file name');
    const dg = await real(srv.origin + d.json.previewUrl);
    assert.equal(Buffer.from(await dg.arrayBuffer()).toString('latin1'), 'ID3');

    for (const bad of ['..%2F..%2Fpackage.json', '..%5Cai.json', 'x.txt', '']) {
      const b = await real(`${srv.origin}/api/voice/preview/${bad}`);
      assert.equal(b.status, 404, bad);
    }
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(listDir(voiceMediaDir()), [], 'No preview file in the asset catalog');
});
