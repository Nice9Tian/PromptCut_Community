/**
 * Web collection for Cloud Agent (`server/agent/service/hosted-collect.mjs`; contract
 * `docs/plan/cloud-agent-contract.md` Section 9.4d).
 * Run: node scripts/test-suite.mjs server/test/cloud-agent-collect.test.mjs
 *
 * Downloader uses a mock (`scripts/probes/fixtures/cloud-collect/fake-collect.mjs`: speaks the same
 * CLI and JSONL, egresses only via the proxy in the environment); egress gate and its proxy,
 * workspace, and restricted child processes are all real. "External address" is a mock on local
 * loopback, allowed via the egress gate's test exception.
 *
 *   CA-COL-01  Entire chain: check status → probe → download → store. Child process working
 *              directory is the chat directory, environment contains no `PROMPTCUT_*`, only proxy
 *              variables pointing to the egress gate proxy; downloads land under the chat's
 *              `collect/<job id>/`, storing uses the path given by the caller (bytes identical to
 *              origin), and the job directory is deleted after storing; each call records a line of
 *              usage (count and bytes); job table is persisted to disk with the chat
 *   CA-COL-02  Egress only via egress gate proxy: local loopback, intranet, cloud vendor metadata
 *              addresses, `localhost`: both probe and download are rejected by the proxy, mock was
 *              never connected to; non-http(s) addresses (`file:`, `ftp:`, starting with `-`) are
 *              rejected before spawning child processes
 *   CA-COL-03  Limits and cancellation: downloaded files exceed size limit, video exceeds duration
 *              limit, wall-clock time limit exceeded: stops, does not store, leaves no files; a
 *              single member runs only one concurrently; cancellation (chat ends) stops running
 *              downloads
 *   CA-COL-04  Not installed on node: `collect_status` returns `ready: false` and a clear reason,
 *              `collect_install` installs nothing, `collect_download` returns "Collection tool not
 *              installed", spawning no child processes; when installed, `collect_install` also
 *              spawns no installation child processes
 *   CA-COL-05  Read-only member: rejected before download, spawns no child processes, does not
 *              connect to origin
 *   CA-COL-06  Job table is partitioned by instance (other instances cannot query it);
 *              "Interrupted" can be queried after service restart; files reported by downloader
 *              outside the job directory are ignored
 *   CA-COL-07  Read deployment config: returns null when unconfigured; path does not exist, test
 *              arguments not an array: reports configuration error
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
    if (Date.now() - t0 > ms) throw new Error(`Job ${jobId} did not finish within the time limit`);
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
      ensureCanWrite: async () => { if (readOnly) throw new ToolError('You only have read-only permission in this project, so the Cloud Agent cannot write media to the project for you.', { code: 'forbidden' }); },
      importFile: async (rel, name) => { const bytes = ws.read(rel); st.imported.push({ rel, name, bytes }); return { mediaId: `m-${st.imported.length}`, kind: 'video', bytes: bytes.length }; },
      record: (row) => st.usage.push(row),
    });
    return st;
  }
  return { dataDir, clip, hits, spawned, collect, conversation, src: `http://127.0.0.1:${collector.port}`, decoyUrl: `http://127.0.0.1:${decoy.port}` };
}

test('CA-COL-01 the whole chain: check status → probe → download → import; subprocess locked down; usage recorded; job table persisted to disk', { timeout: 120_000 }, async (t) => {
  process.env.PROMPTCUT_TEST_SECRET_FOR_COLLECT = 'FAKE-CREDENTIAL-agent-env';
  t.after(() => { delete process.env.PROMPTCUT_TEST_SECRET_FOR_COLLECT; });
  const k = await setup(t);
  const a = k.conversation('p-col', 'c1');
  const st = await a.tools.collect_status({});
  assert.equal(st.ok, true);
  assert.equal(st.ready, true, JSON.stringify(st));
  assert.deepEqual([st.cloud, st.ffmpeg, st.cookies], [true, true, {}]);
  assert.equal(st.pylibs, undefined);
  // Environment seen by child process itself (mock is read-only, reports only)
  const dir = a.ws.dir();
  assert.equal(fs.realpathSync(st.seen.cwd), fs.realpathSync(dir), 'The working directory is this chat\'s working directory');
  assert.deepEqual(st.seen.promptcutEnv, [], 'The environment has no PROMPTCUT_* at all');
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
  assert.equal(probe.formats, undefined, 'The probe result does not include the lengthy formats table');
  assert.deepEqual(k.hits.collector, ['/clip.mp4'], 'The probe goes through the proxy to the origin site');
  const search = await a.tools.collect_search({ query: '测试' });
  assert.equal(search.results[0].id, 'BV1FAKE00000');

  const started = await a.tools.collect_download({ url: `${k.src}/clip.mp4`, quality: 720, cookies: '/etc/passwd' });
  assert.equal(started.ok, true);
  assert.match(started.jobId, /^collect-[a-f0-9]{12}$/);
  const job = await waitJob(a.tools, started.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.deepEqual([job.percent, job.quality, job.mediaIds], [100, 720, ['m-1']]);
  assert.ok(job.notes.some((n) => /cookies parameter was not used/.test(n)));
  assert.equal(a.imported.length, 1);
  assert.match(a.imported[0].rel, new RegExp(`^collect/${started.jobId}/item-0\\.mp4$`));
  assert.equal(a.imported[0].name, 'Fake Clip [FAKE0001].mp4');
  assert.ok(a.imported[0].bytes.equals(k.clip), 'The imported bytes are exactly what the origin site gave');
  const dl = k.spawned.find((s) => s.args.includes('download'));
  assert.equal(dl.args.includes('--cookies'), false, 'The cloud carries no cookies file');
  assert.ok(path.resolve(dl.args[dl.args.indexOf('--out-dir') + 1]).startsWith(dir + path.sep), 'Downloads land in the chat\'s working directory');
  assert.equal(fs.existsSync(path.join(dir, 'collect', started.jobId)), false, 'The job directory is deleted after import');
  // Usage: by count and bytes
  assert.deepEqual(a.usage.map((u) => [u.service, u.vendor, u.model, u.unit, u.ok]), [
    ['collect', 'yt-dlp', 'status', 'bytes', true], ['collect', 'yt-dlp', 'probe', 'bytes', true], ['collect', 'yt-dlp', 'search', 'bytes', true], ['collect', 'yt-dlp', 'download', 'bytes', true],
  ]);
  assert.equal(a.usage[3].units, k.clip.length);
  // Job table is persisted to disk with the chat
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'collect', 'jobs.json'), 'utf8'));
  assert.deepEqual(saved.map((j) => [j.id, j.status]), [[started.jobId, 'done']]);
  assert.deepEqual(await a.tools.collect_logout({}), { ok: true, loggedOut: false, note: 'The cloud stores no login state for any site, so there is nothing to log out of.' });
  assert.equal((await a.tools.collect_install({})).alreadyInstalled, true);
  assert.equal(k.spawned.some((s) => s.args.includes('install')), false, 'The cloud never starts an installing subprocess');
});

test('CA-COL-02 outbound traffic goes only through the egress gate\'s proxy: loopback, internal network and metadata addresses are unreachable; a non-http(s) address starts no subprocess', { timeout: 120_000 }, async (t) => {
  const k = await setup(t);
  const a = k.conversation('p-col', 'c2');
  const refused = [k.decoyUrl, `${k.decoyUrl.replace('127.0.0.1', 'localhost')}/x`, 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://[::1]/', `http://127.1:${new URL(k.decoyUrl).port}/`];
  for (const url of refused) {
    const err = await a.tools.collect_probe({ url }).then(() => null, (e) => e);
    assert.ok(err, `${url} probe rejected`);
    assert.match(err.message, /egress refused|HTTP Error 403|Unable to download/, `${url}: ${err.message}`);
  }
  const dl = await a.tools.collect_download({ url: `${k.decoyUrl}/secret.mp4` });
  const job = await waitJob(a.tools, dl.jobId);
  assert.equal(job.status, 'error');
  assert.match(job.message, /egress refused|403/);
  assert.equal(k.hits.decoy, 0, 'The decoy service on the same machine was never connected to');
  assert.equal(a.imported.length, 0);
  const before = k.spawned.length;
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a', '--exec=calc', '-o /tmp/x', 'javascript:alert(1)', '', 'http://a b', 'x'.repeat(3000)]) {
    await assert.rejects(a.tools.collect_probe({ url }), /url must be a web link starting with http/, url);
    await assert.rejects(a.tools.collect_download({ url }), /url must be a web link starting with http/, url);
  }
  assert.equal(k.spawned.length, before, 'No subprocess was started for the invalid address');
});

test('CA-COL-03 limits and cancellation: size, duration, wall clock; one member runs only one at a time; when the chat ends, running ones are stopped', { timeout: 120_000 }, async (t) => {
  const big = await setup(t, { limits: { maxDownloadBytes: 64 * 1024 } });
  const a = big.conversation('p-col', 'c3');
  const j1 = await a.tools.collect_download({ url: `${big.src}/slow` });
  // Runs only one concurrently
  await assert.rejects(a.tools.collect_download({ url: `${big.src}/clip.mp4` }), /1 downloads are already running/);
  const r1 = await waitJob(a.tools, j1.jobId);
  assert.equal(r1.status, 'error');
  assert.match(r1.message, /exceeds the 0 MB limit|exceeds.*limit/);
  assert.equal(a.imported.length, 0, 'Anything over the size limit is not imported');
  assert.equal(fs.existsSync(path.join(a.ws.dir(), 'collect', j1.jobId)), false, 'No files left behind');
  assert.equal(a.usage.at(-1).ok, false);
  assert.ok(a.usage.at(-1).units > 64 * 1024, 'However many bytes were downloaded are still recorded');

  const long = await a.tools.collect_download({ url: `${big.src}/long` });
  const r2 = await waitJob(a.tools, long.jobId);
  assert.equal(r2.status, 'error');
  assert.match(r2.message, /longer than 2 hours/);
  assert.equal(a.imported.length, 0);
  const lp = await a.tools.collect_probe({ url: `${big.src}/long` });
  assert.equal(lp.tooLong, true);

  const timed = await setup(t, { limits: { downloadMs: 1200 } });
  const b = timed.conversation('p-col', 'c4');
  const j3 = await b.tools.collect_download({ url: `${timed.src}/trickle` });
  const r3 = await waitJob(b.tools, j3.jobId);
  assert.equal(r3.status, 'error');
  assert.match(r3.message, /time limit/);

  const c = timed.conversation('p-col', 'c5');
  const j4 = await c.tools.collect_download({ url: `${timed.src}/trickle` });
  await sleep(300);
  c.tools.stopAll();
  const r4 = await waitJob(c.tools, j4.jobId);
  assert.deepEqual([r4.status, r4.message], ['error', 'Cancelled']);
});

test('CA-COL-04 / 05 when not installed on the node, each returns a clear reason and starts no subprocess; a read-only member is rejected before downloading', { timeout: 60_000 }, async (t) => {
  const none = await setup(t, { config: null });
  const a = none.conversation('p-col', 'c6');
  const st = await a.tools.collect_status({});
  assert.deepEqual([st.ok, st.ready, st.ytdlp.installed], [true, false, false]);
  assert.match(st.hint, /This cloud node has no collection tool \(yt-dlp\) installed/);
  const inst = await a.tools.collect_install({});
  assert.deepEqual([inst.ok, inst.cloudUnavailable], [false, true]);
  assert.match(inst.error, /The cloud does not let the Agent install anything on the node/);
  const dl = await a.tools.collect_download({ url: `${none.src}/clip.mp4` });
  assert.deepEqual([dl.ok, dl.cloudUnavailable], [false, true]);
  await assert.rejects(a.tools.collect_probe({ url: `${none.src}/clip.mp4` }), /has no collection tool \(yt-dlp\) installed/);
  await assert.rejects(a.tools.collect_search({ query: 'x' }), /has no collection tool \(yt-dlp\) installed/);
  assert.equal(none.spawned.length, 0);
  assert.equal(none.collect.available, false);

  const ro = await setup(t, { readOnly: true });
  const r = ro.conversation('p-col', 'c7');
  await assert.rejects(r.tools.collect_download({ url: `${ro.src}/clip.mp4` }), /read-only/);
  assert.equal(ro.spawned.length, 0, 'Read-only member: no subprocess started');
  assert.deepEqual(ro.hits.collector, [], 'The origin site was not contacted either');
});

test('CA-COL-06 / 07 the job table is split per instance; after a restart, "interrupted" can be looked up; files outside the job directory are not recognized; read the deployment config', { timeout: 60_000 }, async (t) => {
  const k = await setup(t);
  const a = k.conversation('p-a', 'c8');
  const other = k.conversation('p-b', 'c8');
  const j = await a.tools.collect_download({ url: `${k.src}/clip.mp4` });
  await assert.rejects(other.tools.collect_job({ jobId: j.jobId }), /This download job was not found/, 'Another project\'s instance cannot look it up');
  assert.equal((await waitJob(a.tools, j.jobId)).status, 'done');
  // Downloader reported files outside the job directory: ignored, not stored
  fs.mkdirSync(path.join(a.ws.dir(), 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(a.ws.dir(), 'attachments', 'not-mine.mp4'), 'someone else');
  const out = await a.tools.collect_download({ url: `${k.src}/outside` });
  const r = await waitJob(a.tools, out.jobId);
  assert.equal(r.status, 'error');
  assert.match(r.message, /but it is not in the job directory/);
  assert.equal(a.imported.length, 1, 'Only the first one was imported');
  // Service restart: in-memory job table is gone, read from disk for the same chat; what was
  // running last time is now "Interrupted"
  const file = path.join(a.ws.dir(), 'collect', 'jobs.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.push({ id: 'collect-aaaaaaaaaaaa', conversationId: 'c8', url: 'http://x/', quality: 1080, site: 'auto', status: 'running', stage: 'video', percent: 40, notes: [], items: [], startedAt: 1 });
  fs.writeFileSync(file, JSON.stringify(saved));
  const again = k.conversation('p-a', 'c8');
  assert.equal((await again.tools.collect_job({ jobId: j.jobId })).status, 'done');
  const lost = await again.tools.collect_job({ jobId: 'collect-aaaaaaaaaaaa' });
  assert.deepEqual([lost.ok, lost.status], [false, 'error']);
  assert.match(lost.message, /restarted and this download was interrupted/);
  await assert.rejects(again.tools.collect_job({ jobId: 'collect-ffffffffffff' }), /This download job was not found/);

  // CA-COL-07
  assert.equal(readCollectConfig({}, { root: ROOT }), null);
  assert.match(readCollectConfig({ PROMPTCUT_AGENT_COLLECT_PYTHON: 'python' }, { root: ROOT }).error, /absolute path/);
  assert.match(readCollectConfig({ PROMPTCUT_AGENT_COLLECT_PYTHON: path.join(ROOT, 'no-such-python') }, { root: ROOT }).error, /absolute path/);
  assert.match(readCollectConfig({ PROMPTCUT_AGENT_COLLECT_PYTHON: process.execPath, PROMPTCUT_AGENT_COLLECT_TEST_ARGS: '{"a":1}' }, { root: ROOT }).error, /JSON array/);
  const real = readCollectConfig({ PROMPTCUT_AGENT_COLLECT_PYTHON: process.execPath }, { root: ROOT });
  assert.deepEqual([real.python, real.args, real.testRunner, real.pythonPath], [process.execPath, undefined, undefined, path.join(ROOT, 'python')]);
  const fake = readCollectConfig({ PROMPTCUT_AGENT_COLLECT_PYTHON: process.execPath, PROMPTCUT_AGENT_COLLECT_TEST_ARGS: JSON.stringify([FAKE]) }, { root: ROOT });
  assert.deepEqual([fake.args, fake.testRunner], [[FAKE], true]);
  for (const n of ['collect_status', 'collect_install', 'collect_search', 'collect_probe', 'collect_download', 'collect_job', 'collect_logout']) assert.deepEqual(CLOUD_TOOL_PLAN[n], { mode: 'hosted' }, n);
  for (const n of ['user_interface_collect_login', 'collect_login_check']) assert.equal(CLOUD_TOOL_PLAN[n].mode, 'initiator', n);
});
