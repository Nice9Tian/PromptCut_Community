/**
 * 云端 Agent 的网页采集(`server/agent/service/hosted-collect.mjs`;契约 `docs/plan/cloud-agent-contract.md` 第 9.4d 节)。
 * 跑:node scripts/test-suite.mjs server/test/cloud-agent-collect.test.mjs
 *
 * 下载器用替身(`scripts/probes/fixtures/cloud-collect/fake-collect.mjs`:说同一份命令行与 JSONL,只按环境里的代理出网);
 * 出网闸与它的代理、工作区与受限子进程都是真的。「外部地址」是本机回环上的替身,经出网闸的测试例外放行。
 *
 *   CA-COL-01  整条链:查状态 → 探测 → 下载 → 入库。子进程的工作目录是对话目录、环境里没有任何 `PROMPTCUT_*`、只有指向出网闸代理的代理变量;
 *              下载物落在对话的 `collect/<作业号>/` 下,入库走调用方给的那条路(字节与源站相同),入库后作业目录删掉;
 *              每次调用记一行用量(次数与字节);作业表随对话落盘
 *   CA-COL-02  出网只经出网闸的代理:本机回环、内网、云厂商元数据地址、`localhost`——探测与下载都被代理拒掉,替身一次也没被连到;
 *              不是 http(s) 的地址(`file:`、`ftp:`、以 `-` 开头的)在起子进程之前就被拒
 *   CA-COL-03  上限与取消:下载物超过体积上限、片子超过时长上限、超过墙钟时限——停下、不入库、不留文件;一位成员同时只跑一个;
 *              取消(对话结束)停掉在跑的下载
 *   CA-COL-04  节点上没装:`collect_status` 回 `ready: false` 与明确的原因,`collect_install` 不装东西,`collect_download` 回「没有装采集工具」,
 *              一个子进程也不起;装了时 `collect_install` 也不起安装的子进程
 *   CA-COL-05  只读成员:下载之前就被拒,不起子进程、不连源站
 *   CA-COL-06  作业表按实例分(别的实例查不到);服务重启后查得到「中断了」;下载器报的作业目录以外的文件不认
 *   CA-COL-07  读部署配置:没配回 null;路径不存在、测试参数不是数组——报配置错
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createCollect, newCollectState, readCollectConfig } from '../agent/service/hosted-collect.mjs';
import { createEgressGate } from '../agent/service/egress.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { CLOUD_TOOL_PLAN } from '../agent/service/cloud-tools.mjs';
import { ROOT } from './cloud-agent-kit.mjs';

const FAKE = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'cloud-collect', 'fake-collect.mjs');
const OWNER = 'e'.repeat(32);
class ToolError extends Error { constructor(message, extra = {}) { super(message); Object.assign(this, extra); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitJob = async (tools, jobId, ms = 20_000) => {
  const t0 = Date.now();
  for (;;) {
    const j = await tools.collect_job({ jobId });
    if (j.status !== 'running') return j;
    if (Date.now() - t0 > ms) throw new Error(`作业 ${jobId} 没有在时限内结束`);
    await sleep(50);
  }
};

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

async function setup(t, { limits = {}, config = undefined, readOnly = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-collect-'));
  const clip = randomBytes(4096);
  const hits = { collector: [], decoy: 0 };
  const collector = await listen((req, res) => {
    hits.collector.push(req.url);
    if (req.url.startsWith('/slow')) {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      const timer = setInterval(() => { try { res.write(Buffer.alloc(8192, 7)); } catch { clearInterval(timer); } }, 40);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (req.url.startsWith('/trickle')) {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      const timer = setInterval(() => { try { res.write(Buffer.alloc(16, 7)); } catch { clearInterval(timer); } }, 100);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', ...(req.url.startsWith('/long') ? { 'x-fake-duration': '99999' } : {}) });
    res.end(clip);
  });
  const decoy = await listen((_req, res) => { hits.decoy += 1; res.end('FAKE-CREDENTIAL-local-service'); });
  const spawned = [];
  const workspaces = createWorkspaces({
    dataDir,
    spawnImpl: (cmd, args, options) => { spawned.push({ cmd, args: [...args], cwd: options.cwd, env: { ...options.env } }); return spawn(cmd, args, options); },
  });
  const egress = createEgressGate({ testAllow: [`127.0.0.1:${collector.port}`] });
  const collect = createCollect({
    config: config === undefined ? { python: process.execPath, args: [FAKE], testRunner: true, pythonPath: path.join(ROOT, 'python') } : config,
    egress, limits: { watchMs: 100, ...limits },
  });
  t.after(async () => { await collector.close(); await decoy.close(); await sleep(100); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }); });
  function conversation(projectId, conversationId, state = newCollectState()) {
    const ws = workspaces.open({ projectId, ownerKey: OWNER, conversationId });
    const st = { ws, state, imported: [], usage: [] };
    st.tools = collect.forConversation({
      state, workspace: () => ws, ToolError, conversationId,
      ensureCanWrite: async () => { if (readOnly) throw new ToolError('你在这个项目里只有只读权限,云端 Agent 不能替你把素材写进项目。', { code: 'forbidden' }); },
      importFile: async (rel, name) => { const bytes = ws.read(rel); st.imported.push({ rel, name, bytes }); return { mediaId: `m-${st.imported.length}`, kind: 'video', bytes: bytes.length }; },
      record: (row) => st.usage.push(row),
    });
    return st;
  }
  return { dataDir, clip, hits, spawned, collect, conversation, src: `http://127.0.0.1:${collector.port}`, decoyUrl: `http://127.0.0.1:${decoy.port}` };
}

test('CA-COL-01 整条链:查状态 → 探测 → 下载 → 入库;子进程收紧;记用量;作业表落盘', { timeout: 120_000 }, async (t) => {
  process.env.PROMPTCUT_TEST_SECRET_FOR_COLLECT = 'FAKE-CREDENTIAL-agent-env';
  t.after(() => { delete process.env.PROMPTCUT_TEST_SECRET_FOR_COLLECT; });
  const k = await setup(t);
  const a = k.conversation('p-col', 'c1');
  const st = await a.tools.collect_status({});
  assert.equal(st.ok, true);
  assert.equal(st.ready, true, JSON.stringify(st));
  assert.deepEqual([st.cloud, st.ffmpeg, st.cookies], [true, true, {}]);
  assert.equal(st.pylibs, undefined);
  // 子进程自己看到的环境(替身只读、只报告)
  const dir = a.ws.dir();
  assert.equal(fs.realpathSync(st.seen.cwd), fs.realpathSync(dir), '工作目录是这个对话的工作目录');
  assert.deepEqual(st.seen.promptcutEnv, [], '环境里没有任何 PROMPTCUT_*');
  assert.equal(st.seen.proxy, true);
  assert.equal(st.seen.home, dir);
  assert.ok(st.seen.tmp.startsWith(dir));
  const env = k.spawned[0].env;
  assert.equal(Object.values(env).some((v) => String(v).includes('FAKE-CREDENTIAL')), false);
  assert.match(env.HTTP_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(env.HTTPS_PROXY, env.HTTP_PROXY);
  assert.equal(env.NO_PROXY, '');
  assert.deepEqual(k.spawned[0].args.slice(-1), ['status']);

  const probe = await a.tools.collect_probe({ url: `${k.src}/clip.mp4` });
  assert.deepEqual([probe.ok, probe.title, probe.duration], [true, 'Fake Video', 12.5]);
  assert.equal(probe.formats, undefined, '探测结果里不带冗长的格式表');
  assert.deepEqual(k.hits.collector, ['/clip.mp4'], '探测是经代理到源站的');
  const search = await a.tools.collect_search({ query: '测试' });
  assert.equal(search.results[0].id, 'BV1FAKE00000');

  const started = await a.tools.collect_download({ url: `${k.src}/clip.mp4`, quality: 720, cookies: '/etc/passwd' });
  assert.equal(started.ok, true);
  assert.match(started.jobId, /^collect-[a-f0-9]{12}$/);
  const job = await waitJob(a.tools, started.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.deepEqual([job.percent, job.quality, job.mediaIds], [100, 720, ['m-1']]);
  assert.ok(job.notes.some((n) => /cookies 参数没有用上/.test(n)));
  assert.equal(a.imported.length, 1);
  assert.match(a.imported[0].rel, new RegExp(`^collect/${started.jobId}/item-0\\.mp4$`));
  assert.equal(a.imported[0].name, 'Fake Clip [FAKE0001].mp4');
  assert.ok(a.imported[0].bytes.equals(k.clip), '入库的字节就是源站给的');
  const dl = k.spawned.find((s) => s.args.includes('download'));
  assert.equal(dl.args.includes('--cookies'), false, '云端不带任何 cookies 文件');
  assert.ok(path.resolve(dl.args[dl.args.indexOf('--out-dir') + 1]).startsWith(dir + path.sep), '下载物落在对话的工作目录里');
  assert.equal(fs.existsSync(path.join(dir, 'collect', started.jobId)), false, '入库后作业目录删掉');
  // 用量:按次数与字节
  assert.deepEqual(a.usage.map((u) => [u.service, u.vendor, u.model, u.unit, u.ok]), [
    ['collect', 'yt-dlp', 'status', 'bytes', true], ['collect', 'yt-dlp', 'probe', 'bytes', true], ['collect', 'yt-dlp', 'search', 'bytes', true], ['collect', 'yt-dlp', 'download', 'bytes', true],
  ]);
  assert.equal(a.usage[3].units, k.clip.length);
  // 作业表随对话落盘
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'collect', 'jobs.json'), 'utf8'));
  assert.deepEqual(saved.map((j) => [j.id, j.status]), [[started.jobId, 'done']]);
  assert.deepEqual(await a.tools.collect_logout({}), { ok: true, loggedOut: false, note: '云端不存任何站点的登录态,没有可退出的。' });
  assert.equal((await a.tools.collect_install({})).alreadyInstalled, true);
  assert.equal(k.spawned.some((s) => s.args.includes('install')), false, '云端从不起安装的子进程');
});

test('CA-COL-02 出网只经出网闸的代理:回环、内网、元数据地址到不了;不是 http(s) 的地址不起子进程', { timeout: 120_000 }, async (t) => {
  const k = await setup(t);
  const a = k.conversation('p-col', 'c2');
  const refused = [k.decoyUrl, `${k.decoyUrl.replace('127.0.0.1', 'localhost')}/x`, 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://[::1]/', `http://127.1:${new URL(k.decoyUrl).port}/`];
  for (const url of refused) {
    const err = await a.tools.collect_probe({ url }).then(() => null, (e) => e);
    assert.ok(err, `${url} 探测被拒`);
    assert.match(err.message, /egress refused|HTTP Error 403|Unable to download/, `${url}: ${err.message}`);
  }
  const dl = await a.tools.collect_download({ url: `${k.decoyUrl}/secret.mp4` });
  const job = await waitJob(a.tools, dl.jobId);
  assert.equal(job.status, 'error');
  assert.match(job.message, /egress refused|403/);
  assert.equal(k.hits.decoy, 0, '同机的替身服务一次也没被连到');
  assert.equal(a.imported.length, 0);
  const before = k.spawned.length;
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a', '--exec=calc', '-o /tmp/x', 'javascript:alert(1)', '', 'http://a b', 'x'.repeat(3000)]) {
    await assert.rejects(a.tools.collect_probe({ url }), /url 要是 http/, url);
    await assert.rejects(a.tools.collect_download({ url }), /url 要是 http/, url);
  }
  assert.equal(k.spawned.length, before, '不合规矩的地址没有起子进程');
});

test('CA-COL-03 上限与取消:体积、时长、墙钟;一位成员同时只跑一个;对话结束停掉在跑的', { timeout: 120_000 }, async (t) => {
  const big = await setup(t, { limits: { maxDownloadBytes: 64 * 1024 } });
  const a = big.conversation('p-col', 'c3');
  const j1 = await a.tools.collect_download({ url: `${big.src}/slow` });
  // 同时只跑一个
  await assert.rejects(a.tools.collect_download({ url: `${big.src}/clip.mp4` }), /已经有 1 个下载在跑/);
  const r1 = await waitJob(a.tools, j1.jobId);
  assert.equal(r1.status, 'error');
  assert.match(r1.message, /超过 0 MB 的上限|超过.*上限/);
  assert.equal(a.imported.length, 0, '超了体积上限的不入库');
  assert.equal(fs.existsSync(path.join(a.ws.dir(), 'collect', j1.jobId)), false, '不留文件');
  assert.equal(a.usage.at(-1).ok, false);
  assert.ok(a.usage.at(-1).units > 64 * 1024, '下了多少字节照记');

  const long = await a.tools.collect_download({ url: `${big.src}/long` });
  const r2 = await waitJob(a.tools, long.jobId);
  assert.equal(r2.status, 'error');
  assert.match(r2.message, /超过 2 小时/);
  assert.equal(a.imported.length, 0);
  const lp = await a.tools.collect_probe({ url: `${big.src}/long` });
  assert.equal(lp.tooLong, true);

  const timed = await setup(t, { limits: { downloadMs: 1200 } });
  const b = timed.conversation('p-col', 'c4');
  const j3 = await b.tools.collect_download({ url: `${timed.src}/trickle` });
  const r3 = await waitJob(b.tools, j3.jobId);
  assert.equal(r3.status, 'error');
  assert.match(r3.message, /时限/);

  const c = timed.conversation('p-col', 'c5');
  const j4 = await c.tools.collect_download({ url: `${timed.src}/trickle` });
  await sleep(300);
  c.tools.stopAll();
  const r4 = await waitJob(c.tools, j4.jobId);
  assert.deepEqual([r4.status, r4.message], ['error', '已取消']);
});

test('CA-COL-04 / 05 节点上没装时各回明确的原因、不起子进程;只读成员下载之前就被拒', { timeout: 60_000 }, async (t) => {
  const none = await setup(t, { config: null });
  const a = none.conversation('p-col', 'c6');
  const st = await a.tools.collect_status({});
  assert.deepEqual([st.ok, st.ready, st.ytdlp.installed], [true, false, false]);
  assert.match(st.hint, /这台云节点没有装采集工具/);
  const inst = await a.tools.collect_install({});
  assert.deepEqual([inst.ok, inst.cloudUnavailable], [false, true]);
  assert.match(inst.error, /不能由 Agent 往节点上装东西/);
  const dl = await a.tools.collect_download({ url: `${none.src}/clip.mp4` });
  assert.deepEqual([dl.ok, dl.cloudUnavailable], [false, true]);
  await assert.rejects(a.tools.collect_probe({ url: `${none.src}/clip.mp4` }), /没有装采集工具/);
  await assert.rejects(a.tools.collect_search({ query: 'x' }), /没有装采集工具/);
  assert.equal(none.spawned.length, 0);
  assert.equal(none.collect.available, false);

  const ro = await setup(t, { readOnly: true });
  const r = ro.conversation('p-col', 'c7');
  await assert.rejects(r.tools.collect_download({ url: `${ro.src}/clip.mp4` }), /只读/);
  assert.equal(ro.spawned.length, 0, '只读成员:没有起子进程');
  assert.deepEqual(ro.hits.collector, [], '也没有连源站');
});

test('CA-COL-06 / 07 作业表按实例分;重启后查得到「中断了」;作业目录以外的文件不认;读部署配置', { timeout: 60_000 }, async (t) => {
  const k = await setup(t);
  const a = k.conversation('p-a', 'c8');
  const other = k.conversation('p-b', 'c8');
  const j = await a.tools.collect_download({ url: `${k.src}/clip.mp4` });
  await assert.rejects(other.tools.collect_job({ jobId: j.jobId }), /找不到这个下载作业/, '别的项目的实例查不到');
  assert.equal((await waitJob(a.tools, j.jobId)).status, 'done');
  // 下载器报了作业目录以外的文件:不认、不入库
  fs.mkdirSync(path.join(a.ws.dir(), 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(a.ws.dir(), 'attachments', 'not-mine.mp4'), 'someone else');
  const out = await a.tools.collect_download({ url: `${k.src}/outside` });
  const r = await waitJob(a.tools, out.jobId);
  assert.equal(r.status, 'error');
  assert.match(r.message, /作业目录里却没有它/);
  assert.equal(a.imported.length, 1, '只有第一次那一个入了库');
  // 服务重启:内存里的作业表没了,同一个对话从盘上读到;上次还在跑的现在是「中断了」
  const file = path.join(a.ws.dir(), 'collect', 'jobs.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.push({ id: 'collect-aaaaaaaaaaaa', conversationId: 'c8', url: 'http://x/', quality: 1080, site: 'auto', status: 'running', stage: 'video', percent: 40, notes: [], items: [], startedAt: 1 });
  fs.writeFileSync(file, JSON.stringify(saved));
  const again = k.conversation('p-a', 'c8');
  assert.equal((await again.tools.collect_job({ jobId: j.jobId })).status, 'done');
  const lost = await again.tools.collect_job({ jobId: 'collect-aaaaaaaaaaaa' });
  assert.deepEqual([lost.ok, lost.status], [false, 'error']);
  assert.match(lost.message, /重启过,这次下载中断了/);
  await assert.rejects(again.tools.collect_job({ jobId: 'collect-ffffffffffff' }), /找不到/);

  // CA-COL-07
  assert.equal(readCollectConfig({}, { root: ROOT }), null);
  assert.match(readCollectConfig({ PROMPTCUT_AGENT_COLLECT_PYTHON: 'python' }, { root: ROOT }).error, /绝对路径/);
  assert.match(readCollectConfig({ PROMPTCUT_AGENT_COLLECT_PYTHON: path.join(ROOT, 'no-such-python') }, { root: ROOT }).error, /绝对路径/);
  assert.match(readCollectConfig({ PROMPTCUT_AGENT_COLLECT_PYTHON: process.execPath, PROMPTCUT_AGENT_COLLECT_TEST_ARGS: '{"a":1}' }, { root: ROOT }).error, /JSON 数组/);
  const real = readCollectConfig({ PROMPTCUT_AGENT_COLLECT_PYTHON: process.execPath }, { root: ROOT });
  assert.deepEqual([real.python, real.args, real.testRunner, real.pythonPath], [process.execPath, undefined, undefined, path.join(ROOT, 'python')]);
  const fake = readCollectConfig({ PROMPTCUT_AGENT_COLLECT_PYTHON: process.execPath, PROMPTCUT_AGENT_COLLECT_TEST_ARGS: JSON.stringify([FAKE]) }, { root: ROOT });
  assert.deepEqual([fake.args, fake.testRunner], [[FAKE], true]);
  for (const n of ['collect_status', 'collect_install', 'collect_search', 'collect_probe', 'collect_download', 'collect_job', 'collect_logout']) assert.deepEqual(CLOUD_TOOL_PLAN[n], { mode: 'hosted' }, n);
  for (const n of ['user_interface_collect_login', 'collect_login_check']) assert.equal(CLOUD_TOOL_PLAN[n].mode, 'initiator', n);
});
