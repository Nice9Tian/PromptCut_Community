/**
 * Stress version of video frame-fetching cadence probe: runs `video-source-cadence-probe.mjs`
 * repeatedly while fully loading the machine, counting how many runs fail. Used to reproduce
 * "video input source of media effect cards occasionally fetches the previous frame" (reading the
 * pre-seek frame after `seeked` when the machine is busy).
 *
 *   node scripts/probes/video-source-cadence-stress.mjs [--port 6210] [--runs 20] [--hogs 16] [--parallel 1] [--logdir DIR]
 *
 *   --parallel P  Run P probes concurrently (ports: port, port+3, port+6..., each occupying three
 *                 consecutive numbers), for runs times in total. Multiple Chrome instances
 *                 exporting concurrently resembles the workload of "claim gate probe launching a
 *                 bunch of Chromes" better than pure CPU load.
 *   --logdir DIR  For failed runs, saves full probe output to DIR/run-<n>.log (including page logs)
 *                 for post-mortem analysis.
 *
 *   --hogs N   Spawn N additional node child processes that fully saturate one core (pure JS
 *              infinite loop, no file I/O); default = CPU core count. 0 = no added load.
 *   --runs K   Run the probe K times in total (serial on the same port when `--parallel 1`).
 *
 * Load processes are started and terminated by this script (cleaned up on normal exit, errors,
 * and Ctrl+C).
 * Outputs JSON on the last line: `{ ok, runs, failed, exportMs: [...], fails: [[...], ...] }`;
 * exit code 0 if and only if every run passes.
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
const stopHogs = () => { for (const h of hogs.splice(0)) { try { h.kill(); } catch { /* Exited */ } } };
process.on('exit', stopHogs);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopHogs(); process.exit(130); });
for (let i = 0; i < HOGS; i++) {
  hogs.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
}
log(`${HOGS} load processes, ${RUNS} probe runs, ${PARALLEL} in parallel, ports starting at ${PORT}`);

const runOnce = (port) => new Promise((resolve) => {
  const child = spawn(process.execPath, [PROBE, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  child.stderr.on('data', (d) => { text += d; });
  child.on('close', (code) => {
    const last = text.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
    let json = null;
    try { json = JSON.parse(last); } catch { /* No result line */ }
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
      const fails = json?.fails ?? [`No result line, exit code ${code}: ${tail}`];
      result.exportMs[r] = json?.exportMs ?? null;
      if (code !== 0 || fails.length) {
        result.failed++; result.fails.push({ run: r + 1, fails });
        if (LOGDIR) fs.writeFileSync(path.join(LOGDIR, `run-${r + 1}.log`), text);
      }
      log(`Run ${r + 1} (port ${port}): ${code === 0 ? 'pass' : 'fail'} exportMs=${json?.exportMs}${fails.length ? ' ' + JSON.stringify(fails).slice(0, 400) : ''}`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, (_, i) => lane(PORT + 3 * i)));
} finally {
  stopHogs();
}
result.ok = result.failed === 0;
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
