// 替身:按 `python -m promptcut_subject` 的命令行与 JSONL 约定回话,行为由「素材文件的内容」和权重目录里的 engine.txt 决定。
// 只给单测(cloud-tools-p4-subject.test.mjs)用:让取消、超时、失败、孤儿进程这些路径不依赖真模型就能反复跑。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const opts = {};
while (argv[0]?.startsWith('--') && ['--models-dir', '--pylibs', '--local-only'].includes(argv[0])) {
  const key = argv.shift();
  opts[key] = key === '--local-only' ? true : argv.shift();
}
const sub = argv.shift();
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
fs.appendFileSync(path.join(process.cwd(), 'stub-calls.jsonl'), `${JSON.stringify({
  sub, opts, argv, hasPromptcutEnv: Object.keys(process.env).some((k) => k.startsWith('PROMPTCUT_')),
  pythonPath: process.env.PYTHONPATH ?? null, pipNoIndex: process.env.PIP_NO_INDEX ?? null, httpProxy: process.env.HTTP_PROXY ?? null,
})}\n`);

const engineIn = (dir) => { try { return fs.readFileSync(path.join(dir, 'engine.txt'), 'utf8').trim(); } catch { return 'none'; } };
const tier = (ready) => ({ ready, runtime: { installed: ready, version: ready ? '1.20.1' : null, error: ready ? null : `No module named 'onnxruntime' (${opts['--models-dir']})` }, models: { yunet: { path: path.join(opts['--models-dir'] ?? '', 'yunet.onnx'), exists: ready, ...(ready ? { bytes: 228 } : {}) } } });

if (sub === 'status') {
  const e = engineIn(opts['--models-dir'] ?? '');
  emit({ event: 'status', version: '1.0.0', engine: e === 'none' ? null : e, light: tier(e !== 'none'), full: tier(e === 'full'), modelsDir: opts['--models-dir'], ffmpeg: 'ffmpeg' });
  process.exit(0);
}

if (sub === 'detect') {
  const file = argv.shift();
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const times = (flag('--times') ?? '').split(',').map(Number);
  const prompt = argv.find((a) => a.startsWith('--prompt='))?.slice(9) ?? '';
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { emit({ event: 'error', message: `找不到视频文件:${file}` }); process.exit(2); }
  const engine = plan.engine ?? engineIn(opts['--models-dir'] ?? '');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (plan.mode === 'fail') { emit({ event: 'error', message: plan.message ?? '主体检测拓展未就绪' }); process.exit(3); }
  if (plan.mode === 'crash') { process.stderr.write(`Traceback (most recent call last):\n  File "x.py"\nRuntimeError: boom at ${file}\n`); process.exit(1); }
  if (plan.mode === 'hang') {
    const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(path.join(process.cwd(), 'stub-pids.json'), JSON.stringify({ child: process.pid, grandchild: grand.pid }));
    emit({ event: 'progress', done: 0, total: times.length });
    setInterval(() => {}, 1000);
  } else {
    let failed = 0;
    const samples = [];
    for (let i = 0; i < times.length; i++) {
      await wait(plan.delayMs ?? 10);
      const t = times[i];
      if (plan.duration && t > plan.duration) {
        failed += 1;
        samples.push({ t, boxes: [], failed: true, reason: `抽 ${t.toFixed(3)}s 那一帧失败:没有解出数据(时刻超出时长?)`, safeSide: 'right', occupancy: { left: 0, right: 0, top: 0, bottom: 0 } });
      } else {
        samples.push({ t, boxes: [{ label: 'person', x: 100, y: 50, w: 200, h: 400, conf: 0.9 }], safeSide: 'right', occupancy: { left: 0.4, right: 0.05, top: 0.1, bottom: 0.3 } });
      }
      emit({ event: 'progress', done: i + 1, total: times.length });
    }
    if (plan.mode === 'badresult') { emit({ event: 'result', engine, width: 640, height: 360, samples: [{ nope: true }] }); process.exit(0); }
    emit({
      event: 'result', engine: plan.reportEngine ?? engine, width: 640, height: 360, prompt, msPerFrame: 1, failedCount: failed, samples,
      ...(plan.fellBack ? { fellBackFrom: 'full', fallbackReason: `DINO 目录 ${opts['--models-dir']} 缺分词器` } : {}),
    });
    process.exit(0);
  }
}

if (sub === 'install') {
  const reqFile = (() => { const i = argv.indexOf('--requirements'); return i >= 0 ? argv[i + 1] : null; })();
  const mode = reqFile && fs.existsSync(reqFile) ? fs.readFileSync(reqFile, 'utf8').trim() : 'missing';
  emit({ event: 'log', line: `pip install --target ${opts['--pylibs']} -r ${reqFile}` });
  if (mode === 'hang') { setInterval(() => {}, 1000); }
  else if (mode === 'ok') {
    await new Promise((r) => setTimeout(r, 80));
    fs.writeFileSync(path.join(opts['--models-dir'] ?? '.', 'engine.txt'), 'light');
    emit({ event: 'installed', tier: 'light', needsModel: false, engine: 'light' });
    process.exit(0);
  } else { emit({ event: 'error', message: `pip 安装失败(退出码 1):${reqFile}` }); process.exit(1); }
}
