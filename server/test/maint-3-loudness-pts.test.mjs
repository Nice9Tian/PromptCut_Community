/**
 * Timeline-tier loudness measurement per-second curve occasionally drops points (item 2 of
 * AGENT-maint-3).
 *
 * When a clip ends before timeline end, ffmpeg 9 amix occasionally stamps subsequent frames with
 * NOPTS, ebur128 outputs `t: -192153584101141.06`, `parseEbur128` does not recognize negative
 * numbers, and per-second curve drops points thereafter. Fix: add `asetpts=N/SR/TB` after mixing
 * (including atrim) and before ebur128.
 *
 *   MNT3-L-1  Arguments: asetpts is after amix / atrim and before ebur128; present even without
 *             duration;
 *   MNT3-L-2  Real ffmpeg: same timeline (four clips, two end early) repeated 40 times, per-second
 *             curve is 0..6 every time with no negative t, summary values and per-second curves are
 *             verbatim identical every time, and verbatim identical to defect-free runs with pre-fix
 *             arguments removing asetpts. Before fix, 13 out of 100 runs dropped points for the
 *             same configuration on this machine.
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

test('MNT3-L-1 measuring loudness on the timeline: timestamps are re-stamped by sample index after the mix and before ebur128', () => {
  const entries = [
    { file: 'a.wav', start: 0, dur: 2, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
    { file: 'b.wav', start: 0, dur: 7, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
  ];
  assert.match(graphOf(timelineMeasureArgs(entries, 7)), /amix=[^,;]+,atrim=0:7,asetpts=N\/SR\/TB,ebur128=peak=true\[aout\]$/);
  assert.match(graphOf(timelineMeasureArgs(entries)), /amix=[^,;]+,asetpts=N\/SR\/TB,ebur128=peak=true\[aout\]$/);
});

const FFMPEG = findFfmpeg();
const skip = FFMPEG ? false : 'ffmpeg not found';
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

test('MNT3-L-2 measuring a timeline on which one segment ends first, repeated 40 times: the per-second curve has no missing points, and the result is identical every time and identical to the runs before the change that did not go wrong', { skip, timeout: 120_000 }, () => {
  const args = timelineMeasureArgs(entries, 7);
  const fixed = new Set();
  for (let i = 0; i < 40; i++) {
    const r = run(args);
    assert.equal(r.negative, false, `Negative t appeared on run ${i}`);
    assert.equal(r.ticks, '0,1,2,3,4,5,6', `The per-second curve has missing points on run ${i}`);
    fixed.add(r.all);
  }
  assert.equal(fixed.size, 1, 'The result is identical every time');
  // Pre-fix arguments (asetpts removed): comparing runs without missing points, summary values and
  // per-second curve are verbatim identical
  const pre = args.map(a => a.replace(',asetpts=N/SR/TB', ''));
  let compared = 0;
  for (let i = 0; i < 10 && compared < 3; i++) {
    const r = run(pre);
    if (r.negative || r.ticks !== '0,1,2,3,4,5,6') continue;
    assert.equal(r.all, [...fixed][0], 'Identical to the output before the change when it did not go wrong');
    compared++;
  }
  assert.ok(compared >= 1, 'With the pre-change parameters, at least one run had no missing points to compare against');
});
