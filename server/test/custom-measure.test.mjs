/**
 * 计划 agent-workflow-plan.md A6:Agent 用 JS 自定义测量(measure_audio_js)。
 *
 * 用例 CM-1～CM-14(三档 × 这条工具在 creativity-gate.test.mjs 的 CR-6 / CR-11):
 *   CM-1  采样率与窗口的规整(缺省 16 kHz、夹到 8～48 kHz;start / duration 截窗口、越界报错);
 *   CM-2  样本数预算:超了先不解码,报错写明这个采样率与声道数下最多几秒、怎么缩;
 *   CM-3  ffmpeg 参数:单文件按窗口截、f32le 输出;时间轴混音图与测响度(timelineMeasureArgs)同一份;
 *   CM-4  交错 PCM 拆声道,丢掉不完整的尾帧;
 *   CM-5  measureJs 的前置检查(空代码、素材不存在、没有音频流、无效 scope)不解码、不进沙箱;
 *   ── 以下起真的 ffmpeg 与专用 Chrome ──
 *   CM-6  正常测量:ffmpeg lavfi 生成的 1 kHz 正弦波(振幅 0.5),RMS 与峰值与理论值一致(-9.03 / -6.02 dBFS);
 *         片段档按窗口截、mono(按平均混,响度不变)、timeline 混音档(音量 0.5 → 再低 6.02 dB,单声道同样);
 *   CM-7  死循环在时限内被终止,编辑器进程(本进程)的事件循环照常转;
 *   CM-8  内存炸弹回清楚的错误(心跳判卡死 / 分配失败),几秒内回来,之后的测量照常;
 *   CM-9  联网尝试失败:fetch / XHR / WebSocket / importScripts 抛「沙箱里不能联网」;本机回环上的 HTTP 服务一次都没被打到;
 *   CM-10 抛异常带报错文字和行号;语法错误也回清楚的话;
 *   CM-11 结果超大被拒;
 *   CM-12 结果不能序列化(BigInt、循环引用、undefined)被拒;
 *   CM-13 代码拿不到 Node 能力(process、require、Buffer 都没有),postMessage 伪造结果不行;
 *   CM-14 时限规整、代码长度上限、排队上限。
 *
 * 跑:node --test server/test/custom-measure.test.mjs(要 ffmpeg 与 chrome-headless-shell;找不到 ffmpeg 时 CM-6 起跳过)
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { PCM_LIMITS, pcmFormat, windowOf, sampleBudgetError, filePcmArgs, timelinePcmArgs, deinterleave } from '../audio-pcm.mjs';
import { timelineMeasureArgs } from '../audio-measure.mjs';
import { measureJs, probeAudioChannels } from '../audio-measure-js.mjs';
import { createAudioSandbox, clampTimeout, SANDBOX_LIMITS } from '../audio-sandbox.mjs';
import { findFfmpeg } from '../ai-visual.mjs';

/* ------------------------------------------------------------------ 纯函数 */

test('CM-1 采样率与窗口的规整', () => {
  assert.deepEqual(pcmFormat({}), { sampleRate: 16000, mono: false });
  assert.deepEqual(pcmFormat({ sampleRate: 100, mono: true }), { sampleRate: 8000, mono: true });
  assert.deepEqual(pcmFormat({ sampleRate: 96000 }), { sampleRate: 48000, mono: false });
  assert.deepEqual(pcmFormat({ sampleRate: 22050.4, mono: 'yes' }), { sampleRate: 22050, mono: false });
  assert.deepEqual(windowOf({ baseOffset: 3, baseDuration: 10 }), { offset: 3, duration: 10 });
  assert.deepEqual(windowOf({ baseOffset: 3, baseDuration: 10, start: 2, duration: 4 }), { offset: 5, duration: 4 });
  assert.deepEqual(windowOf({ baseOffset: 3, baseDuration: 10, start: 8, duration: 4 }), { offset: 11, duration: 2 });
  assert.deepEqual(windowOf({ start: 1 }), { offset: 1, duration: undefined });
  assert.deepEqual(windowOf({ start: 1, duration: 2 }), { offset: 1, duration: 2 });
  assert.throws(() => windowOf({ baseDuration: 5, start: 5 }), /超出了这段声音的长度/);
});

test('CM-2 样本数预算:超了先不解码,报错写明最多几秒与怎么缩', () => {
  assert.equal(sampleBudgetError({ duration: undefined, sampleRate: 16000, channels: 2 }), null);
  assert.equal(sampleBudgetError({ duration: 60, sampleRate: 16000, channels: 2 }), null);
  const msg = sampleBudgetError({ duration: 600, sampleRate: 48000, channels: 2 });
  assert.match(msg, /超过上限 12000000/);
  assert.match(msg, /最多 125 秒/);
  assert.match(msg, /mono: true/);
  assert.match(msg, /start \/ duration/);
});

test('CM-3 ffmpeg 参数:单文件按窗口截;时间轴混音图与测响度同一份', () => {
  const a = filePcmArgs({ file: 'x.wav', offset: 1.5, duration: 2, sampleRate: 16000, channels: 1 });
  assert.deepEqual(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 4), ['-ss', '1.5', '-t', '2']);
  assert.ok(a.join(' ').endsWith('-ac 1 -ar 16000 -f f32le -acodec pcm_f32le pipe:1'));
  assert.ok(!filePcmArgs({ file: 'x.wav', offset: 0, sampleRate: 8000, channels: 2 }).includes('-ss'));
  // 混成单声道按平均(不用 ffmpeg -ac 1 缺省的功率混,那样两路相同的声音会响 3 dB)
  const m = filePcmArgs({ file: 'x.wav', sampleRate: 8000, channels: 1, sourceChannels: 2 });
  assert.equal(m[m.indexOf('-af') + 1], 'pan=mono|c0=0.5*c0+0.5*c1');
  assert.ok(!filePcmArgs({ file: 'x.wav', sampleRate: 8000, channels: 1, sourceChannels: 1 }).includes('-af'));
  const entries = [
    { file: 'a.wav', start: 0, dur: 3, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
    { file: 'b.wav', start: 1, dur: 2, offset: 4, volume: 0.5, fadeIn: 0.5, fadeOut: 0 },
  ];
  const measure = timelineMeasureArgs(entries, 5);
  const pcm = timelinePcmArgs(entries, { total: 5, sampleRate: 16000, channels: 2 });
  const graph = (args) => args[args.indexOf('-filter_complex') + 1];
  // 同一张混音图:测响度在 amix 后重打时间戳再接 ebur128(amix 偶发 NOPTS,见 audio-measure.mjs),这里接输出
  assert.equal(graph(measure).replace(',asetpts=N/SR/TB,ebur128=peak=true[aout]', ''), graph(pcm).replace('[aout]', ''));
  const win = timelinePcmArgs(entries, { total: 5, offset: 1, duration: 2, sampleRate: 16000, channels: 2 });
  assert.match(graph(win), /atrim=0:5,atrim=start=1:duration=2,asetpts=PTS-STARTPTS\[aout\]$/);
});

test('CM-4 交错 PCM 拆声道,丢掉不完整的尾帧', () => {
  const inter = new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
  const buf = Buffer.concat([Buffer.from(inter.buffer), Buffer.from([1, 2, 3])]);
  const [l, r] = deinterleave(buf, 2);
  assert.deepEqual([...l].map((v) => +v.toFixed(3)), [0.1, 0.2, 0.3]);
  assert.deepEqual([...r].map((v) => +v.toFixed(3)), [-0.1, -0.2, -0.3]);
  // 奇数偏移上的 Buffer(池子里切出来的)也读得对
  const odd = Buffer.alloc(13);
  Buffer.from(new Float32Array([0.5, 0.25, -1]).buffer).copy(odd, 1);
  assert.deepEqual([...deinterleave(odd.subarray(1), 1)[0]], [0.5, 0.25, -1]);
});

test('CM-5 measureJs 的前置检查不解码、不进沙箱', async () => {
  let ran = 0;
  const sandbox = { run: async () => { ran += 1; return { ok: true, value: 1 }; } };
  const base = { ffmpeg: 'ffmpeg-不存在', ffprobe: 'ffprobe-不存在', sandbox };
  const r1 = await measureJs({ ...base, body: { scope: 'media', media: {}, code: '  ' }, resolveFile: () => 'x' });
  assert.equal(r1.body.ok, false); assert.match(r1.body.error, /code 是空的/);
  const r2 = await measureJs({ ...base, body: { scope: 'media', media: { url: '/x' }, code: 'return 1' }, resolveFile: () => null });
  assert.equal(r2.body.kind, 'no-media');
  const r3 = await measureJs({ ...base, body: { scope: 'clip', media: {}, code: 'return 1' }, resolveFile: () => 'x', probeChannels: () => 0 });
  assert.equal(r3.body.kind, 'no-audio');
  const r4 = await measureJs({ ...base, body: { scope: 'nope', code: 'return 1' }, resolveFile: () => 'x' });
  assert.match(r4.body.error, /无效的 scope/);
  const r5 = await measureJs({ ...base, body: { scope: 'clip', media: {}, offset: 0, duration: 900, sampleRate: 48000, code: 'return 1' }, resolveFile: () => 'x', probeChannels: () => 2 });
  assert.equal(r5.body.kind, 'too-many-samples');
  const r6 = await measureJs({ ...base, body: { scope: 'timeline', entries: [{ media: { name: '甲' } }], code: 'return 1' }, resolveFile: () => null });
  assert.equal(r6.body.kind, 'no-audio');
  assert.equal(ran, 0);
});

test('CM-14 时限规整、代码长度上限、排队上限', async () => {
  assert.equal(clampTimeout(undefined), SANDBOX_LIMITS.defaultTimeoutMs);
  assert.equal(clampTimeout(10), 1000);
  assert.equal(clampTimeout(999999), SANDBOX_LIMITS.maxTimeoutMs);
  let launched = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  // 假的 Chrome:第一次 newPage 卡住,用来把队列塞满
  const fakeLaunch = async () => {
    launched += 1;
    return { on() {}, close: async () => {}, process: () => null, createBrowserContext: async () => ({ close: async () => {}, newPage: async () => { await gate; throw new Error('假的'); } }) };
  };
  const sb = createAudioSandbox({ launch: fakeLaunch, limits: { maxQueue: 2 } });
  const pcm = [new Float32Array(4)];
  assert.match((await sb.run({ code: 'x'.repeat(SANDBOX_LIMITS.maxCodeChars + 1), channels: pcm, sampleRate: 8000 })).error, /超过上限/);
  assert.equal((await sb.run({ code: '', channels: pcm, sampleRate: 8000 })).kind, 'invalid');
  const a = sb.run({ code: 'return 1', channels: pcm, sampleRate: 8000 });
  const b = sb.run({ code: 'return 2', channels: pcm, sampleRate: 8000 });
  const c = await sb.run({ code: 'return 3', channels: pcm, sampleRate: 8000 });
  assert.equal(c.kind, 'busy');
  release();
  const [ra] = await Promise.all([a, b]);
  assert.equal(ra.ok, false);
  assert.equal(launched >= 1, true);
  await sb.close();
});

/* ------------------------------------------------------------------ 真的 ffmpeg + 专用 Chrome */

const FFMPEG = findFfmpeg();
const FFPROBE = FFMPEG ? path.join(path.dirname(FFMPEG), 'ffprobe' + path.extname(FFMPEG)) : null;
const skip = FFMPEG ? false : '没找到 ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-custom-measure-'));
const SINE = path.join(TMP, 'sine.wav');
const SINE_MONO = path.join(TMP, 'sine-mono.wav');
if (FFMPEG) {
  // 1 kHz、振幅 0.5 的正弦波,48 kHz 立体声 3 秒(左右一样);另一份单声道
  const wave = '0.5*sin(2*PI*1000*t)';
  const gen = (out, stereo) => spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${stereo ? `${wave}|${wave}` : wave}:s=48000:d=3`, '-c:a', 'pcm_f32le', out], { windowsHide: true });
  gen(SINE, true);
  gen(SINE_MONO, false);
}
const sandbox = createAudioSandbox();
after(async () => { await sandbox.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const RMS_PEAK = `
  const out = [];
  for (const x of input.channels) {
    let s = 0, pk = 0;
    for (let i = 0; i < x.length; i++) { s += x[i] * x[i]; const a = Math.abs(x[i]); if (a > pk) pk = a; }
    out.push({ rmsDb: 10 * Math.log10(s / x.length), peakDb: 20 * Math.log10(pk) });
  }
  return { channels: out, frames: input.frames, sampleRate: input.sampleRate, duration: input.duration, scope: input.scope, mediaId: input.mediaId };
`;
const run = (body) => measureJs({ body, resolveFile: (m) => m?.path ?? null, ffmpeg: FFMPEG, ffprobe: FFPROBE, sandbox });
const media = (file) => ({ id: 'm1', name: path.basename(file), path: file });

test('CM-6 正常测量:正弦波的 RMS 与峰值与理论值一致', { skip, timeout: 120_000 }, async () => {
  assert.equal(probeAudioChannels(SINE, FFPROBE), 2);
  const RMS = 20 * Math.log10(0.5 / Math.SQRT2); // -9.031
  const PEAK = 20 * Math.log10(0.5); // -6.021
  const r = await run({ scope: 'media', media: media(SINE), code: RMS_PEAK, meta: { mediaId: 'm1' } });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const v = r.body.value;
  assert.equal(v.channels.length, 2);
  for (const ch of v.channels) {
    assert.ok(Math.abs(ch.rmsDb - RMS) < 0.05, `RMS ${ch.rmsDb} vs ${RMS}`);
    assert.ok(Math.abs(ch.peakDb - PEAK) < 0.1, `峰值 ${ch.peakDb} vs ${PEAK}`);
  }
  assert.equal(v.sampleRate, 16000);
  assert.ok(Math.abs(v.frames - 48000) <= 16, `frames ${v.frames}`);
  assert.equal(v.scope, 'media');
  assert.equal(v.mediaId, 'm1');
  assert.equal(r.body.input.numberOfChannels, 2);

  // 片段档:素材里第 0.5 秒起 2 秒,再截窗口 start 0.5 / duration 1 → 1 秒;mono、48 kHz
  const c = await run({ scope: 'clip', media: media(SINE), offset: 0.5, duration: 2, start: 0.5, length: 1, mono: true, sampleRate: 48000, code: RMS_PEAK });
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
  assert.equal(c.body.value.channels.length, 1);
  assert.ok(Math.abs(c.body.value.frames - 48000) <= 48, `frames ${c.body.value.frames}`);
  assert.ok(Math.abs(c.body.value.channels[0].rmsDb - RMS) < 0.05);
  assert.equal(c.body.input.start, 1);

  // 时间轴混音档:单声道素材在第 1 秒起放 2 秒、音量 0.5,时间轴 3 秒;只测 1～3 秒这一窗口 → 再低 6.02 dB;
  // 单声道素材在混音里按导出的做法(server/bakery/audio-mix.mjs 的 -ac 2)摊到两个声道,每路再低 3.01 dB
  const t = await run({
    scope: 'timeline', total: 3, start: 1, length: 2,
    entries: [{ clipId: 'c1', media: media(SINE_MONO), start: 1, dur: 2, offset: 0, volume: 0.5, fadeIn: 0, fadeOut: 0 }],
    code: RMS_PEAK,
  });
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  assert.equal(t.body.value.channels.length, 2);
  const HALF = RMS + 20 * Math.log10(0.5) + 20 * Math.log10(Math.SQRT1_2);
  assert.ok(Math.abs(t.body.value.channels[0].rmsDb - HALF) < 0.1, `混音 RMS ${t.body.value.channels[0].rmsDb} vs ${HALF}`);
  assert.ok(t.body.notes.some((n) => /每路低 3 dB/.test(n)), JSON.stringify(t.body.notes));
  // 同一段混音要单声道:两路相同,按平均混,响度不变
  const tm = await run({
    scope: 'timeline', total: 3, start: 1, length: 2, mono: true,
    entries: [{ clipId: 'c1', media: media(SINE_MONO), start: 1, dur: 2, offset: 0, volume: 0.5, fadeIn: 0, fadeOut: 0 }],
    code: RMS_PEAK,
  });
  assert.equal(tm.body.value.channels.length, 1);
  assert.ok(Math.abs(tm.body.value.channels[0].rmsDb - HALF) < 0.1, `单声道混音 RMS ${tm.body.value.channels[0].rmsDb} vs ${HALF}`);
});

test('CM-7 死循环在时限内被终止,本进程的事件循环照常转', { skip, timeout: 60_000 }, async () => {
  let ticks = 0;
  const iv = setInterval(() => { ticks += 1; }, 50);
  const t0 = Date.now();
  const r = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'while (true) {}', timeoutMs: 1500 });
  const ms = Date.now() - t0;
  clearInterval(iv);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.kind, 'timeout');
  assert.match(r.body.error, /超过 1\.5 秒,已终止/);
  assert.ok(ms < 1500 + 8000, `死循环 ${ms} ms 才回来`);
  assert.ok(ticks >= Math.floor(ms / 50) * 0.5, `事件循环被卡住了:${ms} ms 里只转了 ${ticks} 次`);
  // 沙箱之后照常可用
  const ok = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'return input.frames' });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  // async 的死循环(await 之后才卡住)同样掐得断
  const r2 = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'await null; for (;;) {}', timeoutMs: 1000 });
  assert.equal(r2.body.kind, 'timeout');
});

test('CM-8 内存炸弹回清楚的错误,之后的测量照常', { skip, timeout: 120_000 }, async () => {
  const t0 = Date.now();
  const bomb = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, timeoutMs: 30000, code: 'const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random()));' });
  // 实测 Worker 堆到上限后整个渲染进程卡死、不报 crash;心跳连续 3 次没回话就判,不等满 30 秒的时限
  assert.ok(Date.now() - t0 < 20000, `内存炸弹 ${Date.now() - t0} ms 才回来`);
  assert.equal(bomb.body.ok, false, JSON.stringify(bomb.body));
  assert.ok(['crashed', 'exception', 'timeout'].includes(bomb.body.kind), bomb.body.kind);
  assert.match(bomb.body.error, /内存|memory|heap|allocation/i, bomb.body.error);
  // 一次要一块超大的 ArrayBuffer:浏览器拒绝分配,回抛错文字
  const big = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'return new Float64Array(2 ** 40).length' });
  assert.equal(big.body.ok, false);
  assert.match(big.body.error, /RangeError/);
  const ok = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'return input.numberOfChannels' });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal(ok.body.value, 1);
});

test('CM-9 联网尝试失败;本机回环上的 HTTP 服务一次都没被打到', { skip, timeout: 60_000 }, async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits += 1; res.setHeader('Access-Control-Allow-Origin', '*'); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/leak`;
  try {
    const cases = {
      fetch: `return await fetch(${JSON.stringify(url)}).then((r) => r.text());`,
      protoFetch: `let o = self; while (o && !Object.prototype.hasOwnProperty.call(o, 'fetch')) o = Object.getPrototypeOf(o); return await o.fetch.call(self, ${JSON.stringify(url)}).then((r) => r.text());`,
      xhr: `const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(url)}, false); x.send(); return x.responseText;`,
      ws: `new WebSocket('ws://127.0.0.1:1/'); return 'opened';`,
      importScripts: `importScripts(${JSON.stringify(url + '.js')}); return 'imported';`,
      dynamicImport: `return await import(${JSON.stringify(url + '.mjs')});`,
      external: `return await fetch('https://example.com/').then((r) => r.status);`,
    };
    for (const [name, code] of Object.entries(cases)) {
      const r = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code });
      assert.equal(r.body.ok, false, `${name} 居然成功了:${JSON.stringify(r.body)}`);
      assert.ok(r.body.error.length > 0, name);
      if (name !== 'dynamicImport') assert.match(r.body.error, /沙箱里不能联网/, `${name}:${r.body.error}`);
    }
    // 代码自己吞掉错误、回报「失败」:照样连不出去
    const swallowed = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: `try { await fetch(${JSON.stringify(url)}); return 'leaked'; } catch (e) { return 'blocked: ' + e.message; }` });
    assert.match(swallowed.body.value, /^blocked/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
  assert.equal(hits, 0, '沙箱里的代码打到了本机的 HTTP 服务');
});

test('CM-10 抛异常带报错文字和行号;语法错误也回清楚的话', { skip, timeout: 60_000 }, async () => {
  const r = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'const a = 1;\nthrow new Error("测不出来:" + a);' });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.kind, 'exception');
  assert.match(r.body.error, /代码运行时抛错:Error: 测不出来:1/);
  assert.match(r.body.error, /第 2 行/);
  const t = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'return input.nope.deeper;' });
  assert.match(t.body.error, /TypeError/);
  const s = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'return {;' });
  assert.equal(s.body.kind, 'syntax');
  assert.match(s.body.error, /语法错误:SyntaxError/);
  const nonErr = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'throw "字符串";' });
  assert.match(nonErr.body.error, /字符串/);
});

test('CM-11 结果超大被拒', { skip, timeout: 60_000 }, async () => {
  const r = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'return Array.from(input.channels[0]);' });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.kind, 'too-large');
  assert.match(r.body.error, /超过上限 262144/);
  assert.match(r.body.error, /不要返回原始样本/);
});

test('CM-12 结果不能序列化被拒', { skip, timeout: 60_000 }, async () => {
  for (const code of ['return 1n;', 'const o = {}; o.self = o; return o;', 'return undefined;', 'return () => 1;']) {
    const r = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code });
    assert.equal(r.body.ok, false, code);
    assert.equal(r.body.kind, 'unserializable', `${code}:${r.body.kind}`);
    assert.match(r.body.error, /JSON/);
  }
  // NaN / Infinity 按 JSON 的规矩变成 null,不算错
  const n = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'return { a: NaN, b: -Infinity };' });
  assert.deepEqual(n.body.value, { a: null, b: null });
});

test('CM-13 拿不到 Node 能力,postMessage 伪造结果不行', { skip, timeout: 60_000 }, async () => {
  const r = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'return [typeof process, typeof require, typeof Buffer, typeof module, typeof window, typeof document];' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.value, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  const f = await run({ scope: 'media', media: media(SINE_MONO), sampleRate: 8000, code: 'postMessage({ ok: true, json: "\\"伪造\\"" }); return "真的";' });
  assert.equal(f.body.ok, false);
  assert.match(f.body.error, /用 return 返回结果/);
});
