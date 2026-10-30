/**
 * 配音复刻的源文件经素材服务取字节(AGENT-maint-3 第 3 项)。
 *
 * 原来 `/api/voice/clone` 收上传回包里的 `path`(本地内容库的绝对路径)、`isInside` 后直接读;现在页面只递素材标识
 * `media: { hash, url, name }`,服务端用素材服务的解析器换成地址交 ffmpeg,请求体里的 `path` 一概不看。
 *
 *   MNT3-V-1  resolveCloneSource:只给 path 的老请求体 → 400 类 VoiceError,且不去读那个路径;
 *             素材服务上没有 → VoiceError;素材服务不可达 → AssetSourceError(路由里回 502 kind: asset-service);
 *             有标识 → 回解析器给的地址与素材名;
 *   MNT3-V-2  真的素材服务(本进程里,单进程形态)+ 真 ffmpeg:入库一段 12 秒的音频,经标识解析、prepareCloneAudio
 *             转出单声道 32 kHz wav,秒数对得上;ffmpeg 异步起,事件循环在转码期间照常转(同步起会卡死自己的素材服务);
 *   MNT3-V-3  页面 `cloneVoiceFromFile`:上传后递 media(hash / url / name),不再递 path。
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

test('MNT3-V-1 复刻源文件只认素材标识:老请求体只给 path 被拒,不去读那个路径', async () => {
  const seen = [];
  const resolve = async (m) => { seen.push(m); return m.hash === 'ab'.repeat(32) ? `http://asset.test/@media/${m.hash}` : null; };
  const real = path.join(TMP, 'real.wav');
  fs.writeFileSync(real, 'x');
  await assert.rejects(voice.resolveCloneSource({ path: real, consent: true }, resolve), (e) => e instanceof VoiceError && /素材标识/.test(e.message));
  assert.deepEqual(seen, [], '没有标识时连解析器都不问');
  // media 里夹带 path 也不看
  const ok = await voice.resolveCloneSource({ media: { hash: 'ab'.repeat(32), name: '我的声音.m4a', path: real } }, resolve);
  assert.deepEqual(ok, { src: `http://asset.test/@media/${'ab'.repeat(32)}`, label: '我的声音.m4a' });
  assert.equal(seen[0].path, undefined, '解析器拿到的标识里没有 path');
  await assert.rejects(voice.resolveCloneSource({ media: { hash: 'cd'.repeat(32), name: '没入库.wav' } }, resolve),
    (e) => e instanceof VoiceError && /素材服务上没有这份素材:没入库\.wav/.test(e.message));
  const down = async () => { throw new AssetSourceError('素材服务不可达(http://127.0.0.1:9):ECONNREFUSED'); };
  await assert.rejects(voice.resolveCloneSource({ media: { hash: 'ab'.repeat(32) } }, down), (e) => e instanceof AssetSourceError);
});

const FFMPEG = findFfmpeg();
const skip = FFMPEG ? false : '没找到 ffmpeg';

test('MNT3-V-2 真的素材服务(本进程)+ 真 ffmpeg:经标识取字节转出复刻用的 wav,转码期间事件循环不停', { skip, timeout: 120_000 }, async () => {
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
      assert.ok(prepared.seconds > 10 && prepared.seconds <= 12.1, `秒数 ${prepared.seconds}`);
      const head = fs.readFileSync(prepared.file).subarray(0, 44);
      assert.equal(head.toString('ascii', 0, 4), 'RIFF');
      assert.equal(head.readUInt16LE(22), 1, '单声道');
      assert.equal(head.readUInt32LE(24), 32000, '32 kHz');
      assert.ok(ticks >= 1, `转码期间事件循环在转(ticks=${ticks})`);
    } finally { fs.rmSync(prepared.file, { force: true }); }

    // 素材服务上没有的哈希:resolveCloneSource 就拦下,不交给 ffmpeg
    await assert.rejects(voice.resolveCloneSource({ media: { hash: 'ee'.repeat(32), name: '没入库.wav' } }, resolve), (e) => e instanceof VoiceError);
    // 地址读不到时 prepareCloneAudio 报「源文件转音频失败」,不留临时文件
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(`pc-voice-clone-${process.pid}-`)).length;
    await assert.rejects(voice.prepareCloneAudio(`${svc.origin}/@media/${'ee'.repeat(32)}`, { ffmpeg: FFMPEG }), (e) => e instanceof VoiceError && /源文件转音频失败/.test(e.message));
    await new Promise(r2 => setTimeout(r2, 50));
    assert.equal(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(`pc-voice-clone-${process.pid}-`)).length, before);
  } finally {
    await svc.close?.();
  }
});

test('MNT3-V-3 页面 cloneVoiceFromFile:上传后递素材标识 media,不递 path', async () => {
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
    const r = await mod.cloneVoiceFromFile(file, { name: '复刻' });
    assert.equal(r.voiceId, 'pcVoice1');
  } finally { globalThis.fetch = realFetch; }
  const clone = calls.find(c => c.url === '/api/voice/clone');
  assert.ok(clone, JSON.stringify(calls.map(c => c.url)));
  const body = JSON.parse(clone.body);
  assert.deepEqual(body.media, { hash: 'ab'.repeat(32), url: `/@media/${'ab'.repeat(32)}.m4a`, name: '我的声音.m4a' });
  assert.equal(body.path, undefined);
  assert.equal(body.consent, true);
  assert.equal(body.name, '复刻');
});
