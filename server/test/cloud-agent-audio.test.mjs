/**
 * Loudness measurement for Cloud Agent (`server/agent/service/hosted-audio.mjs`; contract
 * `docs/plan/cloud-agent-contract.md` Section 9.4b).
 * Run: node scripts/test-suite.mjs server/test/cloud-agent-audio.test.mjs
 *
 *   CA-AUD-01  Three tiers (asset, clip, timeline) measure correct values; assets are fetched into
 *              this chat's working directory using tickets before measurement, and deleted
 *              afterward; child process working directory is the chat directory, environment
 *              variables contain no `PROMPTCUT_*`, and each input is preceded by
 *              `-protocol_whitelist file`
 *   CA-AUD-02  Unreadable and what should not be read: asset service returns 404 / 403, fetched bytes
 *              do not match content hash, exceeds limit, asset not in project, images: each returns
 *              a clear reason, leaving no files in the working directory; playlists disguised as
 *              media do not make ffmpeg connect to network addresses; error messages do not include
 *              disk paths
 *   CA-AUD-03  Returns a clear reason when ffmpeg is missing on the node; runs only one measurement
 *              concurrently in the process
 *
 * Requires ffmpeg / ffprobe on this machine (when missing, assertions using them in CA-AUD-01 and 02
 * are skipped, and a line of explanation is printed). No network egress.
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

/** A sine wave PCM16 mono WAV */
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
      version: 1, id: 'p-aud', name: 'Amount', width: 1920, height: 1080, fps: 30, duration: 8, themeId: 'midnight',
      media: [
        { id: 'm-loud', kind: 'audio', name: '响.wav', url: `/@media/${sha256(loud)}`, hash: sha256(loud), ext: 'wav', duration: 2 },
        { id: 'm-quiet', kind: 'audio', name: '轻.wav', url: `/@media/${sha256(quiet)}`, hash: sha256(quiet), ext: 'wav', duration: 3 },
        { id: 'm-gone', kind: 'audio', name: '没了.wav', url: `/@media/${'0'.repeat(64)}`, hash: '0'.repeat(64), ext: 'wav', duration: 1 },
        { id: 'm-img', kind: 'image', name: '图.png', url: `/@media/${'1'.repeat(64)}`, hash: '1'.repeat(64), ext: 'png' },
        { id: 'm-legacy', kind: 'audio', name: '旧.wav', url: '/@media/old-name.wav', duration: 1 },
      ],
      tracks: [
        { id: 't1', name: 'Track 1', clips: [{ id: 'a1', cardId: '', mediaId: 'm-loud', start: 0, end: 2, params: {}, label: '响' }] },
        { id: 't2', name: 'Track 2', clips: [{ id: 'a2', cardId: '', mediaId: 'm-quiet', start: 4, end: 6, mediaOffset: 0.5, params: {}, label: '轻' }, { id: 'k1', cardId: 'title', start: 6, end: 8, params: {}, label: 'Card' }] },
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
if (!HAVE) console.log('CA-AUD this machine has no ffmpeg / ffprobe: assertions that use it are skipped');

test('CA-AUD-01 three tiers: media, clip, timeline; the media is fetched into the chat\'s working directory to be measured and deleted after measuring; the subprocess is locked down', { timeout: 120_000, skip: !HAVE }, async (t) => {
  const { audio, st, ws, spawned, sha, dataDir } = await setup(t);
  const media = await audio.measure_audio({ mediaId: 'm-loud' });
  assert.equal(media.ok, true, JSON.stringify(media));
  assert.equal(media.scope, 'media');
  // 0.5 amplitude 1 kHz sine: peak around -6 dBFS, loudness around -9 LUFS
  assert.ok(Math.abs(media.truePeak - -6.02) < 0.3, `truePeak ${media.truePeak}`);
  assert.ok(Math.abs(media.integrated - -9.0) < 1, `integrated ${media.integrated}`);
  assert.equal(media.series, undefined, 'The per-second curve is not returned unless requested');
  const quiet = await audio.measure_audio({ mediaId: 'm-quiet', series: true });
  assert.ok(Math.abs((media.integrated - quiet.integrated) - 20) < 0.5, 'A tenfold difference in amplitude gives a 20 LU difference in loudness');
  assert.ok(Array.isArray(quiet.series) && quiet.series.length >= 2);

  const clip = await audio.measure_audio({ clipId: 'a2' });
  assert.equal(clip.scope, 'clip');
  assert.ok(Math.abs(clip.integrated - quiet.integrated) < 0.5);
  assert.ok(clip.notes.some((n) => /original sound/.test(n)));

  const tl = await audio.measure_audio({ scope: 'timeline' });
  assert.equal(tl.scope, 'timeline');
  assert.deepEqual(tl.clips.map((c) => [c.clipId, c.mediaId, c.start, c.end]), [['a1', 'm-loud', 0, 2], ['a2', 'm-quiet', 4, 6]]);
  assert.ok(tl.series.length >= 5);
  assert.deepEqual(tl.series.find((s) => s.t >= 0.9 && s.t <= 1.1)?.sounding, ['a1'], JSON.stringify(tl.series.slice(0, 3)));
  assert.deepEqual(tl.series.find((s) => s.t >= 4.9 && s.t <= 5.1)?.sounding, ['a2']);
  assert.deepEqual([...new Set(st.fetches)].sort(), [sha.loud, sha.quiet].sort(), 'Only these two from the project\'s media table were fetched');

  // Leaves no fetched assets in the working directory after measurement
  assert.deepEqual(ws.list().filter((f) => f.path.startsWith('measure/')), []);
  // Child process: working directory is the chat directory, environment variables are rebuilt from
  // a whitelist, and each input is restricted to reading local files only
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
      assert.ok(path.resolve(s.args[i + 1]).startsWith(path.join(dataDir, 'work') + path.sep), 'The inputs are only files inside the chat\'s working directory');
    }
  }
  assert.deepEqual(localOnlyArgs(['-ss', '1', '-i', 'a', '-i', 'b', '-f', 'null']), ['-ss', '1', '-protocol_whitelist', 'file', '-i', 'a', '-protocol_whitelist', 'file', '-i', 'b', '-f', 'null']);
});

test('CA-AUD-02 unreadable and not-allowed-to-read cases each return a clear reason and leave no files; a playlist cannot make ffmpeg connect outward', { timeout: 120_000, skip: !HAVE }, async (t) => {
  const { audio, st, ws, assets, dataDir } = await setup(t);
  const left = () => ws.list().filter((f) => f.path.startsWith('measure/'));
  await assert.rejects(audio.measure_audio({ mediaId: 'm-gone' }), /Media file does not exist/);
  await assert.rejects(audio.measure_audio({ mediaId: 'm-legacy' }), /Media file does not exist/, 'Media not registered by content hash cannot be read in the cloud');
  await assert.rejects(audio.measure_audio({ mediaId: 'm-img' }), /is an image and has no sound/);
  await assert.rejects(audio.measure_audio({ mediaId: 'no-such' }), /Asset no-such not found/);
  await assert.rejects(audio.measure_audio({ clipId: 'k1' }), /Cards have no sound/);
  await assert.rejects(audio.measure_audio({ mediaId: '../../etc/passwd' }), /Asset \.\.\/\.\.\/etc\/passwd not found/, 'Only media ids from the project\'s media table are recognized');
  st.status = 403;
  await assert.rejects(audio.measure_audio({ mediaId: 'm-loud' }), (err) => err.code === 'forbidden' && /refused the read/.test(err.message));
  st.status = null;
  st.tamper = true;
  await assert.rejects(audio.measure_audio({ mediaId: 'm-loud' }), /does not match its content hash/);
  st.tamper = false;
  assert.deepEqual(left(), []);

  // Exceeds limit: does not measure, leaves no files
  const small = await setup(t, { limits: { maxFetchBytes: 1000 } });
  await assert.rejects(small.audio.measure_audio({ mediaId: 'm-loud' }), (err) => err.code === 'too-large');
  assert.deepEqual(small.ws.list().filter((f) => f.path.startsWith('measure/')), []);

  // Playlist disguised as media: points to a mock on local loopback. ffmpeg did not connect to it,
  // tool returns "No audio stream"
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
  assert.ok(err, 'The playlist cannot be measured');
  assert.equal(hits, 0, 'ffmpeg / ffprobe did not connect to the address the playlist points to');
  assert.equal(String(err.message).includes(dataDir), false, 'The error does not include the working directory\'s disk path');
  assert.deepEqual(left(), []);
});

test('CA-AUD-03 returns a clear reason when ffmpeg is missing; only one measurement runs at a time in the process', { timeout: 120_000 }, async (t) => {
  const none = await setup(t, { tools: () => null });
  await assert.rejects(none.audio.measure_audio({ mediaId: 'm-loud' }), (err) => err.code === 'no-ffmpeg' && /no ffmpeg \/ ffprobe installed/.test(err.message));
  assert.deepEqual(none.st.fetches, [], 'Without ffmpeg, no media is fetched');
  // No clips that produce sound: does not fetch assets, does not spawn child processes
  none.st.project = { ...none.st.project, tracks: [] };
  const fake = await setup(t, { tools: () => ({ ffmpeg: 'no-such-ffmpeg-bin', ffprobe: 'no-such-ffprobe-bin' }) });
  fake.st.project = { ...fake.st.project, tracks: [] };
  const empty = await fake.audio.measure_audio({ scope: 'timeline' });
  assert.deepEqual([empty.ok, empty.empty, empty.scope], [true, true, 'timeline']);
  assert.equal(fake.spawned.length, 0);
  if (!HAVE) return;
  const { audio, spawned } = await setup(t);
  // Two measurements sent concurrently: the second waits for the first to release (child processes
  // do not overlap)
  const order = [];
  const a = audio.measure_audio({ mediaId: 'm-loud' }).then(() => order.push(['a', spawned.length]));
  const b = audio.measure_audio({ mediaId: 'm-quiet' }).then(() => order.push(['b', spawned.length]));
  await Promise.all([a, b]);
  assert.deepEqual(order.map((o) => o[0]), ['a', 'b']);
  assert.equal(order[0][1], 2, 'When A finishes measuring, only A\'s two subprocesses (ffprobe, ffmpeg) have been started');
});
