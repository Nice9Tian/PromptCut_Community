/**
 * 时间轴档测响度的逐秒曲线偶发缺点(AGENT-maint-3 第 2 项)。
 *
 * 有一段先于时间轴结尾结束时,ffmpeg 9 的 amix 偶发给之后的帧打 NOPTS,ebur128 打出 `t: -192153584101141.06`,
 * `parseEbur128` 认不出负数,逐秒曲线在那之后缺点。修法:混音(含 atrim)之后、ebur128 之前加 `asetpts=N/SR/TB`。
 *
 *   MNT3-L-1  参数:asetpts 在 amix / atrim 之后、ebur128 之前;不带 duration 时也有;
 *   MNT3-L-2  真 ffmpeg:同一条时间轴(四段,有两段先结束)重复 40 次,逐秒曲线每次都是 0..6、没有负的 t,
 *             汇总值与逐秒曲线每次逐字相同,并与去掉 asetpts 的改前参数里没缺点的那几次逐字相同。
 *             修前在本机实测同一配置 100 次缺点 13 次。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { timelineMeasureArgs, parseEbur128 } from '../audio-measure.mjs';
import { findFfmpeg } from '../ai-visual.mjs';

const graphOf = args => args[args.indexOf('-filter_complex') + 1];

test('MNT3-L-1 时间轴测响度:混音之后、ebur128 之前按样本序号重打时间戳', () => {
  const entries = [
    { file: 'a.wav', start: 0, dur: 2, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
    { file: 'b.wav', start: 0, dur: 7, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
  ];
  assert.match(graphOf(timelineMeasureArgs(entries, 7)), /amix=[^,;]+,atrim=0:7,asetpts=N\/SR\/TB,ebur128=peak=true\[aout\]$/);
  assert.match(graphOf(timelineMeasureArgs(entries)), /amix=[^,;]+,asetpts=N\/SR\/TB,ebur128=peak=true\[aout\]$/);
});

const FFMPEG = findFfmpeg();
const skip = FFMPEG ? false : '没找到 ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-mnt3-loud-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const gen = (name, args) => {
  const out = path.join(TMP, name);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args, out], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return out;
};
const noise = d => ['-f', 'lavfi', '-i', `anoisesrc=d=${d}:c=pink:r=48000:a=0.3`, '-f', 'lavfi', '-i', `sine=f=440:r=48000:d=${d}`, '-filter_complex', '[0][1]amerge=inputs=2', '-ac', '2'];
let entries;
before(() => {
  if (!FFMPEG) return;
  const wav = gen('voice.wav', [...noise(6), '-c:a', 'pcm_s16le']);
  const mp3 = gen('music.mp3', [...noise(6), '-c:a', 'libmp3lame', '-b:a', '160k']);
  const mono = gen('mono.wav', ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=5', '-c:a', 'pcm_s16le']);
  const m4a = gen('amb.m4a', [...noise(6), '-c:a', 'aac', '-b:a', '128k']);
  entries = [
    { file: wav, start: 2, dur: 4, offset: 1, volume: 1, fadeIn: 0.5, fadeOut: 0 },
    { file: mp3, start: 1.5, dur: 5, offset: 0.2, volume: 0.6, fadeIn: 0, fadeOut: 1 },
    { file: mono, start: 2, dur: 3, offset: 0, volume: 1.2, fadeIn: 0, fadeOut: 0 },
    { file: m4a, start: 0, dur: 2, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
  ];
});

const run = args => {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const p = parseEbur128(r.stderr);
  return { negative: /t:\s*-\d/.test(r.stderr), ticks: p.series.map(s => s.t).join(','),
    all: JSON.stringify([p.integrated, p.truePeak, p.lra, p.lraLow, p.lraHigh, p.threshold, p.series]) };
};

test('MNT3-L-2 有段先结束的时间轴重复测 40 次:逐秒曲线不缺点,结果每次相同且与改前没出错的那几次相同', { skip, timeout: 120_000 }, () => {
  const args = timelineMeasureArgs(entries, 7);
  const fixed = new Set();
  for (let i = 0; i < 40; i++) {
    const r = run(args);
    assert.equal(r.negative, false, `第 ${i} 次出现负的 t`);
    assert.equal(r.ticks, '0,1,2,3,4,5,6', `第 ${i} 次逐秒曲线缺点`);
    fixed.add(r.all);
  }
  assert.equal(fixed.size, 1, '每次结果逐字相同');
  // 改前的参数(去掉 asetpts):挑没缺点的那几次比,汇总值与逐秒曲线逐字相同
  const pre = args.map(a => a.replace(',asetpts=N/SR/TB', ''));
  let compared = 0;
  for (let i = 0; i < 10 && compared < 3; i++) {
    const r = run(pre);
    if (r.negative || r.ticks !== '0,1,2,3,4,5,6') continue;
    assert.equal(r.all, [...fixed][0], '与改前没出错时的输出相同');
    compared++;
  }
  assert.ok(compared >= 1, '改前参数至少有一次没缺点可比');
});
