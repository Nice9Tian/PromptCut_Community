// Stub: replies per CLI conventions of `python -m promptcut_shots`, `ffprobe`, and `ffmpeg`(scdet);
// behavior is determined by "asset file contents" (a JSON script) and ready.txt in the weights
// directory. The first argument specifies who to act as: python / ffprobe / ffmpeg.
// For unit tests (cloud-tools-p1-shots.test.mjs) only: allows paths like cancellation, timeout,
// failure, and orphan processes to run repeatedly without depending on the real model.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const who = argv.shift();
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (extra) => fs.appendFileSync(path.join(process.cwd(), 'stub-calls.jsonl'), `${JSON.stringify({
  who, argv, hasPromptcutEnv: Object.keys(process.env).some((k) => k.startsWith('PROMPTCUT_')), ...extra,
})}\n`);

function hang(extra = {}) {
  const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(path.join(process.cwd(), `stub-pids-${who}.json`), JSON.stringify({ child: process.pid, grandchild: grand.pid, ...extra }));
  setInterval(() => {}, 1000);
}
const planOf = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

if (who === 'python') {
  const opts = {};
  while (['--models-dir', '--pylibs', '--local-only'].includes(argv[0])) {
    const key = argv.shift();
    opts[key] = key === '--local-only' ? true : argv.shift();
  }
  const sub = argv.shift();
  record({ sub, opts });
  const modelsDir = opts['--models-dir'] ?? '';
  const ready = (() => { try { return fs.readFileSync(path.join(modelsDir, 'ready.txt'), 'utf8').trim() === 'yes'; } catch { return false; } })();
  if (sub === 'status') {
    emit({
      event: 'status', version: '1.0.0', ready,
      runtime: { installed: ready, version: ready ? '1.20.1' : null, ...(ready ? {} : { error: "No module named 'onnxruntime'" }) },
      model: { path: path.join(modelsDir, 'transnetv2.onnx'), exists: ready, ...(ready ? { bytes: 4 } : {}) },
      ffmpeg: 'ffmpeg',
    });
    process.exit(0);
  }
  if (sub === 'detect') {
    const file = argv.shift();
    const fps = Number(argv[argv.indexOf('--fps') + 1]);
    const plan = planOf(file);
    if (!plan) { emit({ event: 'error', message: `Video file not found: ${file}` }); process.exit(2); }
    if (plan.python === 'crash') { process.stderr.write(`Traceback (most recent call last):\n  File "x.py"\nRuntimeError: boom at ${file}\n`); process.exit(1); }
    if (plan.python === 'errorevent') { emit({ event: 'error', message: plan.message ?? 'Shot detection extension not ready' }); process.exit(3); }
    if (plan.python === 'hang') { emit({ event: 'progress', phase: 'decoded', frames: 10, fps }); hang({ fps }); }
    else {
      for (const p of [10, 50, 90]) { emit({ event: 'progress', phase: 'infer', percent: p }); await wait(30); }
      if (plan.python === 'badresult') { emit({ event: 'result', engine: 'transnetv2', transitions: [{ kind: 'nope' }], shots: [] }); process.exit(0); }
      emit({
        event: 'result', engine: 'transnetv2', fps, duration: 10, frames: 250, threshold: 0.5,
        transitions: [
          { kind: 'cut', startFrame: 74, endFrame: 74, frame: 74, start: 2.96, end: 3.0, time: 2.96, confidence: 0.97 },
          { kind: 'dissolve', startFrame: 150, endFrame: 175, frame: 160, start: 6.0, end: 7.04, time: 6.4, confidence: 0.81 },
        ],
        shots: [
          { start: 0, end: 2.96, inTransition: null, outTransition: 'cut' },
          { start: 3.0, end: 6.0, inTransition: 'cut', outTransition: 'dissolve' },
          { start: 7.04, end: 10, inTransition: 'dissolve', outTransition: null },
        ],
      });
      process.exit(0);
    }
  }
} else {
  // ffprobe / ffmpeg: the contents of the last input file is the script
  const iIdx = argv.indexOf('-i');
  const file = who === 'ffmpeg' ? (iIdx >= 0 ? argv[iIdx + 1] : null) : argv[argv.length - 1];
  record({ file: file ? path.basename(file) : null });
  if (who === 'ffmpeg' && argv.includes('-version')) { process.stdout.write('ffmpeg version stub-1.0 Copyright (c) the stub\n'); process.exit(0); }
  const plan = file ? planOf(file) : null;
  if (!plan) { process.stderr.write('moov atom not found\nInvalid data found when processing input\n'); process.exit(1); }
  if (who === 'ffprobe') {
    if (plan.probe === 'fail') { process.stderr.write(`${file}: moov atom not found\n`); process.exit(1); }
    process.stdout.write(JSON.stringify({
      streams: plan.probe === 'novideo' ? [] : [{ r_frame_rate: plan.rate ?? '25/1', avg_frame_rate: plan.rate ?? '25/1' }],
      format: { duration: String(plan.duration ?? 10) },
    }));
    process.exit(0);
  }
  if (plan.ffmpeg === 'hang') { process.stdout.write('out_time_us=100000\nprogress=continue\n'); hang(); }
  else if (plan.ffmpeg === 'fail') { process.stderr.write('Error while decoding stream #0:0: Invalid data found\n'); process.exit(1); }
  else {
    if (plan.ffmpeg === 'slow') await wait(plan.delayMs ?? 600);
    for (const [score, time] of plan.hits ?? [[28.092, 3], [26.901, 6.6]]) {
      process.stderr.write(`[Parsed_scdet_0 @ 000001dac8fab2c0] lavfi.scd.score: ${score}, lavfi.scd.time: ${time}\n`);
    }
    process.stdout.write(`out_time_us=${Math.round((plan.duration ?? 10) * 1e6)}\nprogress=end\n`);
    process.exit(0);
  }
}
