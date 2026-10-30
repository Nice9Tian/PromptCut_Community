/**
 * 云端 Agent 的测响度(`server/agent/service/hosted-audio.mjs`;契约 `docs/plan/cloud-agent-contract.md` 第 9.4b 节)。
 * 跑:node scripts/test-suite.mjs server/test/cloud-agent-audio.test.mjs
 *
 *   CA-AUD-01  三档(素材、片段、时间轴)量出来的数对;素材是凭票据取到这个对话的工作目录里再量的,量完删掉;
 *              子进程的工作目录是对话目录、环境变量里没有任何 `PROMPTCUT_*`、每个输入前都有 `-protocol_whitelist file`
 *   CA-AUD-02  读不到与不该读的:素材服务回 404 / 403、取回的字节与内容哈希不符、超过上限、项目里没有这份素材、图片——
 *              各回明确的原因,工作目录里不留文件;伪装成媒体的播放列表不会让 ffmpeg 去连网络地址;报错里不带磁盘路径
 *   CA-AUD-03  节点上没有 ffmpeg 时回明确的原因;进程里同时只跑一个测量
 *
 * 要本机有 ffmpeg / ffprobe(没有时 CA-AUD-01、02 里用到它的断言跳过,并打印一行说明)。不出网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createVite } from 'vite';
import { createAudioTools, findAudioTools, localOnlyArgs } from '../agent/service/hosted-audio.mjs';
import { createSlot } from '../agent/service/hosted-sound.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { ROOT } from './cloud-agent-kit.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
class ToolError extends Error { constructor(message, extra = {}) { super(message); Object.assign(this, extra); } }
const OWNER = 'd'.repeat(32);

/** 一段正弦波的 PCM16 单声道 WAV */
function sineWav({ seconds = 2, hz = 1000, amp = 0.25, rate = 48000 } = {}) {
  const frames = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write('RIFF', 0, 'latin1'); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVE', 8, 'latin1'); buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36, 'latin1'); buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / rate) * amp * 32767), 44 + i * 2);
  return buf;
}

async function setup(t, { tools, limits } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-audio-'));
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(async () => { await vite.close(); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); });
  const host = await loadSsrHost((id) => vite.ssrLoadModule(id));
  const spawned = [];
  const workspaces = createWorkspaces({
    dataDir,
    spawnImpl: (cmd, args, options) => { spawned.push({ cmd, args: [...args], cwd: options.cwd, env: { ...options.env }, windowsHide: options.windowsHide, shell: options.shell }); return spawn(cmd, args, options); },
  });
  const ws = workspaces.open({ projectId: 'p-aud', ownerKey: OWNER, conversationId: 'c1' });
  const loud = sineWav({ amp: 0.5 });
  const quiet = sineWav({ amp: 0.05, seconds: 3 });
  const assets = new Map([[sha256(loud), loud], [sha256(quiet), quiet]]);
  const st = {
    fetches: [], status: null, tamper: false,
    project: {
      version: 1, id: 'p-aud', name: '量', width: 1920, height: 1080, fps: 30, duration: 8, themeId: 'midnight',
      media: [
        { id: 'm-loud', kind: 'audio', name: '响.wav', url: `/@media/${sha256(loud)}`, hash: sha256(loud), ext: 'wav', duration: 2 },
        { id: 'm-quiet', kind: 'audio', name: '轻.wav', url: `/@media/${sha256(quiet)}`, hash: sha256(quiet), ext: 'wav', duration: 3 },
        { id: 'm-gone', kind: 'audio', name: '没了.wav', url: `/@media/${'0'.repeat(64)}`, hash: '0'.repeat(64), ext: 'wav', duration: 1 },
        { id: 'm-img', kind: 'image', name: '图.png', url: `/@media/${'1'.repeat(64)}`, hash: '1'.repeat(64), ext: 'png' },
        { id: 'm-legacy', kind: 'audio', name: '旧.wav', url: '/@media/old-name.wav', duration: 1 },
      ],
      tracks: [
        { id: 't1', name: '序列 1', clips: [{ id: 'a1', cardId: '', mediaId: 'm-loud', start: 0, end: 2, params: {}, label: '响' }] },
        { id: 't2', name: '序列 2', clips: [{ id: 'a2', cardId: '', mediaId: 'm-quiet', start: 4, end: 6, mediaOffset: 0.5, params: {}, label: '轻' }, { id: 'k1', cardId: 'title', start: 6, end: 8, params: {}, label: '卡' }] },
      ],
      transitions: [],
    },
  };
  const audio = createAudioTools({
    workspace: () => ws, host: async () => host, slot: createSlot(), ToolError, ...(tools !== undefined ? { tools } : {}), ...(limits ? { limits } : {}),
    read: async (apply) => { host.resetStore(); host.setProject(st.project); try { await apply(host); } finally { host.clearProject(); } },
    fetchAsset: async (hash, onChunk) => {
      st.fetches.push(hash);
      if (st.status) return { status: st.status };
      const bytes = assets.get(hash);
      if (!bytes) return { status: 404 };
      const body = st.tamper ? Buffer.concat([bytes.subarray(0, bytes.length - 2), Buffer.from([1, 2])]) : bytes;
      for (let i = 0; i < body.length; i += 65536) onChunk(body.subarray(i, i + 65536));
      return { status: 200 };
    },
  });
  return { audio, st, ws, spawned, assets, dataDir, sha: { loud: sha256(loud), quiet: sha256(quiet) } };
}

const HAVE = findAudioTools();
if (!HAVE) console.log('CA-AUD 这台机器没有 ffmpeg / ffprobe:用到它的断言跳过');

test('CA-AUD-01 素材、片段、时间轴三档;素材取到对话的工作目录里量,量完删掉;子进程收紧', { timeout: 120_000, skip: !HAVE }, async (t) => {
  const { audio, st, ws, spawned, sha, dataDir } = await setup(t);
  const media = await audio.measure_audio({ mediaId: 'm-loud' });
  assert.equal(media.ok, true, JSON.stringify(media));
  assert.equal(media.scope, 'media');
  // 0.5 幅度的 1 kHz 正弦:峰值约 -6 dBFS,响度约 -9 LUFS
  assert.ok(Math.abs(media.truePeak - -6.02) < 0.3, `truePeak ${media.truePeak}`);
  assert.ok(Math.abs(media.integrated - -9.0) < 1, `integrated ${media.integrated}`);
  assert.equal(media.series, undefined, '没要逐秒曲线就不给');
  const quiet = await audio.measure_audio({ mediaId: 'm-quiet', series: true });
  assert.ok(Math.abs((media.integrated - quiet.integrated) - 20) < 0.5, '幅度差十倍,响度差 20 LU');
  assert.ok(Array.isArray(quiet.series) && quiet.series.length >= 2);

  const clip = await audio.measure_audio({ clipId: 'a2' });
  assert.equal(clip.scope, 'clip');
  assert.ok(Math.abs(clip.integrated - quiet.integrated) < 0.5);
  assert.ok(clip.notes.some((n) => /原声/.test(n)));

  const tl = await audio.measure_audio({ scope: 'timeline' });
  assert.equal(tl.scope, 'timeline');
  assert.deepEqual(tl.clips.map((c) => [c.clipId, c.mediaId, c.start, c.end]), [['a1', 'm-loud', 0, 2], ['a2', 'm-quiet', 4, 6]]);
  assert.ok(tl.series.length >= 5);
  assert.deepEqual(tl.series.find((s) => s.t >= 0.9 && s.t <= 1.1)?.sounding, ['a1'], JSON.stringify(tl.series.slice(0, 3)));
  assert.deepEqual(tl.series.find((s) => s.t >= 4.9 && s.t <= 5.1)?.sounding, ['a2']);
  assert.deepEqual([...new Set(st.fetches)].sort(), [sha.loud, sha.quiet].sort(), '只取了项目素材表里这两份');

  // 量完工作目录里不留取来的素材
  assert.deepEqual(ws.list().filter((f) => f.path.startsWith('measure/')), []);
  // 子进程:工作目录是对话目录,环境变量按白名单重建,每个输入前都限定只读本地文件
  assert.ok(spawned.length >= 8);
  const dir = ws.dir();
  for (const s of spawned) {
    assert.equal(s.cwd, dir);
    assert.equal(s.windowsHide, true);
    assert.equal(s.shell, false);
    assert.deepEqual(Object.keys(s.env).filter((k) => /^PROMPTCUT_/i.test(k) || /proxy/i.test(k)), []);
    assert.equal(s.env.HOME, dir);
    const inputs = s.args.map((a, i) => (a === '-i' ? i : -1)).filter((i) => i >= 0);
    assert.ok(inputs.length >= 1);
    for (const i of inputs) {
      assert.deepEqual(s.args.slice(i - 2, i), ['-protocol_whitelist', 'file'], s.args.join(' '));
      assert.ok(path.resolve(s.args[i + 1]).startsWith(path.join(dataDir, 'work') + path.sep), '输入只有对话工作目录里的文件');
    }
  }
  assert.deepEqual(localOnlyArgs(['-ss', '1', '-i', 'a', '-i', 'b', '-f', 'null']), ['-ss', '1', '-protocol_whitelist', 'file', '-i', 'a', '-protocol_whitelist', 'file', '-i', 'b', '-f', 'null']);
});

test('CA-AUD-02 读不到与不该读的各回明确的原因,不留文件;播放列表不会让 ffmpeg 连出去', { timeout: 120_000, skip: !HAVE }, async (t) => {
  const { audio, st, ws, assets, dataDir } = await setup(t);
  const left = () => ws.list().filter((f) => f.path.startsWith('measure/'));
  await assert.rejects(audio.measure_audio({ mediaId: 'm-gone' }), /素材文件不存在/);
  await assert.rejects(audio.measure_audio({ mediaId: 'm-legacy' }), /素材文件不存在/, '不是按内容哈希登记的素材云端读不到');
  await assert.rejects(audio.measure_audio({ mediaId: 'm-img' }), /是图片,没有声音/);
  await assert.rejects(audio.measure_audio({ mediaId: 'no-such' }), /找不到素材/);
  await assert.rejects(audio.measure_audio({ clipId: 'k1' }), /卡片没有声音/);
  await assert.rejects(audio.measure_audio({ mediaId: '../../etc/passwd' }), /找不到素材/, '只认项目素材表里的素材 id');
  st.status = 403;
  await assert.rejects(audio.measure_audio({ mediaId: 'm-loud' }), (err) => err.code === 'forbidden' && /拒绝了读取/.test(err.message));
  st.status = null;
  st.tamper = true;
  await assert.rejects(audio.measure_audio({ mediaId: 'm-loud' }), /内容哈希不符/);
  st.tamper = false;
  assert.deepEqual(left(), []);

  // 超过上限:不量,不留文件
  const small = await setup(t, { limits: { maxFetchBytes: 1000 } });
  await assert.rejects(small.audio.measure_audio({ mediaId: 'm-loud' }), (err) => err.code === 'too-large');
  assert.deepEqual(small.ws.list().filter((f) => f.path.startsWith('measure/')), []);

  // 伪装成媒体的播放列表:指向本机回环上的一个替身。ffmpeg 没有连过去,工具回「没有音频流」
  let hits = 0;
  const decoy = http.createServer((_req, res) => { hits += 1; res.end('x'); });
  await new Promise((resolve) => decoy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { decoy.closeAllConnections?.(); decoy.close(resolve); }));
  const port = decoy.address().port;
  const playlist = Buffer.from(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhttp://127.0.0.1:${port}/seg0.ts\n#EXT-X-ENDLIST\n`);
  const ph = sha256(playlist);
  assets.set(ph, playlist);
  st.project = { ...st.project, media: [...st.project.media, { id: 'm-pl', kind: 'audio', name: '列表.wav', url: `/@media/${ph}`, hash: ph, ext: 'wav', duration: 2 }] };
  const err = await audio.measure_audio({ mediaId: 'm-pl' }).then(() => null, (e) => e);
  assert.ok(err, '播放列表量不出来');
  assert.equal(hits, 0, 'ffmpeg / ffprobe 没有连到播放列表指的地址');
  assert.equal(String(err.message).includes(dataDir), false, '报错里不带工作目录的磁盘路径');
  assert.deepEqual(left(), []);
});

test('CA-AUD-03 没有 ffmpeg 时回明确的原因;进程里同时只跑一个测量', { timeout: 120_000 }, async (t) => {
  const none = await setup(t, { tools: () => null });
  await assert.rejects(none.audio.measure_audio({ mediaId: 'm-loud' }), (err) => err.code === 'no-ffmpeg' && /没有装 ffmpeg/.test(err.message));
  assert.deepEqual(none.st.fetches, [], '没有 ffmpeg 就不取素材');
  // 没有会出声的片段:不取素材、不起子进程
  none.st.project = { ...none.st.project, tracks: [] };
  const fake = await setup(t, { tools: () => ({ ffmpeg: 'no-such-ffmpeg-bin', ffprobe: 'no-such-ffprobe-bin' }) });
  fake.st.project = { ...fake.st.project, tracks: [] };
  const empty = await fake.audio.measure_audio({ scope: 'timeline' });
  assert.deepEqual([empty.ok, empty.empty, empty.scope], [true, true, 'timeline']);
  assert.equal(fake.spawned.length, 0);
  if (!HAVE) return;
  const { audio, spawned } = await setup(t);
  // 两个测量同时发:后一个等前一个放手(子进程不交叠)
  const order = [];
  const a = audio.measure_audio({ mediaId: 'm-loud' }).then(() => order.push(['a', spawned.length]));
  const b = audio.measure_audio({ mediaId: 'm-quiet' }).then(() => order.push(['b', spawned.length]));
  await Promise.all([a, b]);
  assert.deepEqual(order.map((o) => o[0]), ['a', 'b']);
  assert.equal(order[0][1], 2, '甲量完时只起过甲的两个子进程(ffprobe、ffmpeg)');
});
