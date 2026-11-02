/**
 * Source file for voiceover cloning fetches bytes via asset service (item 3 of AGENT-maint-3).
 *
 * Originally `/api/voice/clone` received `path` (absolute path in local content store) and
 * `isInside` in upload response and read directly; now page only passes media identifier
 * `media: { hash, url, name }`, server resolves to address using asset service resolver and passes
 * to ffmpeg, ignoring `path` in request body completely.
 *
 *   MNT3-V-1  resolveCloneSource: legacy request body with only path → 400-class VoiceError,
 *             without reading that path; missing on asset service → VoiceError; asset service
 *             unreachable → AssetSourceError (route returns 502 kind: asset-service); with
 *             identifier → returns address given by resolver and asset name;
 *   MNT3-V-2  Real asset service (in this process, single-process mode) + real ffmpeg: stores a
 *             12 s audio clip, via identifier resolution and prepareCloneAudio transcodes mono
 *             32 kHz wav, duration matches; ffmpeg launched asynchronously, event loop runs as
 *             usual during transcoding (synchronous launch freezes its own asset service);
 *   MNT3-V-3  Page `cloneVoiceFromFile`: passes media (hash / url / name) after upload, no longer
 *             passes path.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createAssetHarness, ROOT } from './fake-asset-service.mjs';
import { AssetSourceError, createAssetSourceResolver } from '../audio-source.mjs';
import { findFfmpeg } from '../ai-visual.mjs';

const harness = createAssetHarness();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-mnt3-voice-'));
after(async () => { await harness.cleanup(); fs.rmSync(TMP, { recursive: true, force: true }); });

let voice;
let VoiceError;
before(async () => {
  voice = await import(harness.compileTs(path.join(ROOT, 'server', 'vite-plugin-voice.ts')));
  ({ VoiceError } = await import('../voice/providers.mjs'));
});

test('MNT3-V-1 the clone source file is recognized only by asset identifier: an old request body with only path is rejected, and that path is not read', async () => {
  const seen = [];
  const resolve = async (m) => { seen.push(m); return m.hash === 'ab'.repeat(32) ? `http://asset.test/@media/${m.hash}` : null; };
  const real = path.join(TMP, 'real.wav');
  fs.writeFileSync(real, 'x');
  await assert.rejects(voice.resolveCloneSource({ path: real, consent: true }, resolve), (e) => e instanceof VoiceError && /media id/.test(e.message));
  assert.deepEqual(seen, [], 'Without an identifier the resolver is not even asked');
  // Even if path is included in media, it is ignored
  const ok = await voice.resolveCloneSource({ media: { hash: 'ab'.repeat(32), name: '我的声音.m4a', path: real } }, resolve);
  assert.deepEqual(ok, { src: `http://asset.test/@media/${'ab'.repeat(32)}`, label: '我的声音.m4a' });
  assert.equal(seen[0].path, undefined, 'The identifier the resolver receives has no path');
  await assert.rejects(voice.resolveCloneSource({ media: { hash: 'cd'.repeat(32), name: '没入库.wav' } }, resolve),
    (e) => e instanceof VoiceError && /This media is not on the asset service: 没入库\.wav/.test(e.message));
  const down = async () => { throw new AssetSourceError('Asset service unreachable (http://127.0.0.1:9): ECONNREFUSED'); };
  await assert.rejects(voice.resolveCloneSource({ media: { hash: 'ab'.repeat(32) } }, down), (e) => e instanceof AssetSourceError);
});

const FFMPEG = findFfmpeg();
const skip = FFMPEG ? false : 'ffmpeg not found';

test('MNT3-V-2 a real asset service (in this process) + real ffmpeg: bytes are fetched by identifier and converted to the wav used for cloning, and the event loop keeps running during transcoding', { skip, timeout: 120_000 }, async () => {
  const asset = await harness.asset();
  const svc = await harness.serve({ stores: 'default' });
  try {
    const src = path.join(TMP, 'voice.m4a');
    const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=12',
      '-af', 'volume=0.5', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', src], { windowsHide: true });
    assert.equal(r.status, 0, String(r.stderr));
    const buf = fs.readFileSync(src);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const cs = asset.ASSET_CHUNK_SIZE;
    for (let n = 0; n < Math.max(1, Math.ceil(buf.length / cs)); n++) {
      const put = await fetch(`${svc.base}/media/${hash}/${n}`, { method: 'PUT', body: buf.subarray(n * cs, Math.min(buf.length, (n + 1) * cs)), headers: asset.chunkHeaders(buf.length, 'voice.m4a') });
      assert.equal(put.status, 200);
    }
    assert.equal((await fetch(`${svc.base}/media/${hash}/complete`, { method: 'POST' })).status, 200);

    const resolve = createAssetSourceResolver({ origin: () => svc.origin, toUrl: (m, o) => (m.hash ? `${o}/@media/${m.hash}` : null) });
    const source = await voice.resolveCloneSource({ media: { hash, url: `/@media/${hash}`, name: '我的声音.m4a' } }, resolve);
    assert.equal(source.src, `${svc.origin}/@media/${hash}`);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    let prepared;
    try { prepared = await voice.prepareCloneAudio(source.src, { ffmpeg: FFMPEG }); }
    finally { clearInterval(timer); }
    try {
      assert.ok(prepared.seconds > 10 && prepared.seconds <= 12.1, `Seconds ${prepared.seconds}`);
      const head = fs.readFileSync(prepared.file).subarray(0, 44);
      assert.equal(head.toString('ascii', 0, 4), 'RIFF');
      assert.equal(head.readUInt16LE(22), 1, 'Mono');
      assert.equal(head.readUInt32LE(24), 32000, '32 kHz');
      assert.ok(ticks >= 1, `The event loop kept running during transcoding (ticks=${ticks})`);
    } finally { fs.rmSync(prepared.file, { force: true }); }

    // Hash missing from asset service: resolveCloneSource intercepts it and does not pass to ffmpeg
    await assert.rejects(voice.resolveCloneSource({ media: { hash: 'ee'.repeat(32), name: '没入库.wav' } }, resolve), (e) => e instanceof VoiceError);
    // When address is unreadable, prepareCloneAudio reports "Failed to convert source file to audio",
    // leaving no temp files
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(`pc-voice-clone-${process.pid}-`)).length;
    await assert.rejects(voice.prepareCloneAudio(`${svc.origin}/@media/${'ee'.repeat(32)}`, { ffmpeg: FFMPEG }), (e) => e instanceof VoiceError && /Failed to convert source file to audio/.test(e.message));
    await new Promise(r2 => setTimeout(r2, 50));
    assert.equal(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(`pc-voice-clone-${process.pid}-`)).length, before);
  } finally {
    await svc.close?.();
  }
});

test('MNT3-V-3 page cloneVoiceFromFile: after uploading, passes the asset identifier media and not path', async () => {
  const mod = await import(harness.compileTs(path.join(ROOT, 'src', 'ai', 'voice.ts')));
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    if (String(url).startsWith('/api/media/upload/')) {
      return new Response(JSON.stringify({ ok: true, hash: 'ab'.repeat(32), url: `/@media/${'ab'.repeat(32)}.m4a`, path: 'C:\\lib\\x.m4a', name: 'x.m4a' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, voiceId: 'pcVoice1', demoUrl: '', seconds: 12, config: {} }), { status: 200 });
  };
  try {
    const file = new File([new Uint8Array([1, 2, 3])], '我的声音.m4a');
    const r = await mod.cloneVoiceFromFile(file, { name: 'clone' });
    assert.equal(r.voiceId, 'pcVoice1');
  } finally { globalThis.fetch = realFetch; }
  const clone = calls.find(c => c.url === '/api/voice/clone');
  assert.ok(clone, JSON.stringify(calls.map(c => c.url)));
  const body = JSON.parse(clone.body);
  assert.deepEqual(body.media, { hash: 'ab'.repeat(32), url: `/@media/${'ab'.repeat(32)}.m4a`, name: '我的声音.m4a' });
  assert.equal(body.path, undefined);
  assert.equal(body.consent, true);
  assert.equal(body.name, 'clone');
});
