/**
 * 视频取帧节奏探针的压力版:一边让机器满载,一边把 `video-source-cadence-probe.mjs` 连跑若干遍,数挂了几遍。
 * 用来复现「素材效果卡的视频输入源偶发取到上一帧」(机器忙时 `seeked` 之后读到的还是 seek 前那一帧)。
 *
 *   node scripts/probes/video-source-cadence-stress.mjs [--port 6210] [--runs 20] [--hogs 16] [--parallel 1] [--logdir DIR]
 *
 *   --parallel P  同时跑 P 个探针(端口 port、port+3、port+6…,每个占三个连号),共 runs 遍。多个 Chrome 同时导出
 *                 比纯 CPU 负载更像「认领闸探针起一堆 Chrome」那种忙法。
 *   --logdir DIR  挂了的那一遍把探针的完整输出存成 DIR/run-<n>.log(含页面日志),便于事后对照。
 *
 *   --hogs N   另起 N 个占满一个核的 node 子进程(纯 JS 死循环,不读写文件);默认 = CPU 核数。0 = 不加负载。
 *   --runs K   探针一共跑 K 遍(--parallel 1 时串行、同一个端口)。
 *
 * 负载进程由本脚本起、本脚本结束(正常退出、异常、Ctrl+C 都收)。
 * 输出最后一行 JSON:`{ ok, runs, failed, exportMs: [...], fails: [[...], ...] }`;退出码 0 当且仅当每一遍都过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(opt('--port', 6210));
const RUNS = Number(opt('--runs', 20));
const HOGS = Number(opt('--hogs', os.cpus().length));
const PARALLEL = Math.max(1, Number(opt('--parallel', 1)));
const LOGDIR = opt('--logdir', '');
if (LOGDIR) fs.mkdirSync(LOGDIR, { recursive: true });
const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'video-source-cadence-probe.mjs');
const log = (msg) => console.log(`[cadence-stress] ${msg}`);

const hogs = [];
const stopHogs = () => { for (const h of hogs.splice(0)) { try { h.kill(); } catch { /* 已退出 */ } } };
process.on('exit', stopHogs);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopHogs(); process.exit(130); });
for (let i = 0; i < HOGS; i++) {
  hogs.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
}
log(`负载进程 ${HOGS} 个,探针 ${RUNS} 遍,并行 ${PARALLEL},端口 ${PORT} 起`);

const runOnce = (port) => new Promise((resolve) => {
  const child = spawn(process.execPath, [PROBE, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  child.stderr.on('data', (d) => { text += d; });
  child.on('close', (code) => {
    const last = text.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
    let json = null;
    try { json = JSON.parse(last); } catch { /* 没有结果行 */ }
    resolve({ code, json, text, tail: text.slice(-800) });
  });
});

const result = { ok: false, port: PORT, runs: RUNS, hogs: HOGS, failed: 0, exportMs: [], fails: [] };
try {
  let next = 0;
  const lane = async (port) => {
    while (next < RUNS) {
      const r = next++;
      const { code, json, text, tail } = await runOnce(port);
      const fails = json?.fails ?? [`没有结果行,退出码 ${code}:${tail}`];
      result.exportMs[r] = json?.exportMs ?? null;
      if (code !== 0 || fails.length) {
        result.failed++; result.fails.push({ run: r + 1, fails });
        if (LOGDIR) fs.writeFileSync(path.join(LOGDIR, `run-${r + 1}.log`), text);
      }
      log(`第 ${r + 1} 遍(端口 ${port}):${code === 0 ? '过' : '挂'} exportMs=${json?.exportMs}${fails.length ? ' ' + JSON.stringify(fails).slice(0, 400) : ''}`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, (_, i) => lane(PORT + 3 * i)));
} finally {
  stopHogs();
}
result.ok = result.failed === 0;
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
