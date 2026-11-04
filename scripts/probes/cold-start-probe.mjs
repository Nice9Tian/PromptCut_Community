/**
 * Measure dev server cold start: how long from process start to `GET /` returning 200, and to
 * handshake completion between editor and visible stage (reusing criteria from editor-preview-smoke).
 * Run in worktree root:
 *
 *   node scripts/probes/cold-start-probe.mjs [--port 5270]
 *
 * Runs three consecutive "cold → warm" groups on the given port (also occupies ports +1 and +2 as
 * stage ports).
 * Cold rounds only delete node_modules/.vite* cache of this worktree; when cacheDir resolved by
 * Vite is not inside this worktree, that cache is not deleted and cold rounds add --force instead.
 * Installs no packages. Output JSON: raw numbers across six rounds and medians for cold and warm
 * groups.
 * Must run outside local sandbox: both Vite native modules and Chrome need to spawn child processes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { resolveConfig } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (path.resolve(process.cwd()) !== root) throw new Error(`Run from the worktree root: ${root}`);
const args = process.argv.slice(2);
if (args.some((arg, i) => arg !== '--port' && (i === 0 || args[i - 1] !== '--port')) ||
    args.filter((arg) => arg === '--port').length > 1) throw new Error('Usage: node scripts/probes/cold-start-probe.mjs [--port 5270]');
const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 5270;
if (!Number.isInteger(port) || port < 5270 || port + 2 > 5279) throw new Error('Port must reserve three ports within 5270–5279');
const origin = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => [...values].sort((a, b) => a - b)[1];
const round = (value) => Math.round(value * 10) / 10;
const within = (base, target) => { const rel = path.relative(base, target); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
let activeChild = null;

async function portIsFree(number) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(number, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function stopTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]);
  }
  activeChild = null;
}

process.once('SIGINT', () => { void stopTree(activeChild).finally(() => process.exit(130)); });
process.once('SIGTERM', () => { void stopTree(activeChild).finally(() => process.exit(143)); });

async function waitForHome(child, startedAt, log) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited early (${child.exitCode}): ${log.join('')}`);
    try {
      const response = await fetch(origin + '/', { signal: AbortSignal.timeout(2000), cache: 'no-store' });
      if (response.status === 200) {
        const elapsedMs = round(performance.now() - startedAt);
        await response.body?.cancel();
        return elapsedMs;
      }
      await response.body?.cancel();
    } catch { /* server is starting */ }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for HTTP 200: ${log.join('')}`);
}

async function runOnce(kind, pair, coldMethod) {
  for (const p of [port, port + 1, port + 2]) {
    if (!await portIsFree(p)) throw new Error(`Port ${p} is occupied; no process was touched`);
  }
  // Chrome is ready before t=0 so this measures the dev server and page load,
  // not Chrome process startup. A fresh browser prevents cross-run HTTP caching.
  const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
  let child;
  const log = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    const commandArgs = ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'];
    if (kind === 'cold' && coldMethod === 'force') commandArgs.push('--force');
    const startedAt = performance.now();
    child = spawn('npx', commandArgs, {
      cwd: root, shell: process.platform === 'win32', detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      // PROMPTCUT_NO_PORT_FILE=1: do not write shared %TEMP%\promptcut\port.json (markNoPortFile in
      // scripts/lib/user-dirs.mjs)
      env: { ...process.env, npm_config_offline: 'true', npm_config_yes: 'false', PROMPTCUT_NO_PORT_FILE: '1' },
    });
    activeChild = child;
    child.once('error', (error) => log.push(String(error)));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      log.push(chunk.toString());
      if (log.length > 100) log.shift();
    });
    const http200Ms = await waitForHome(child, startedAt, log);
    await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 120000 });
    await page.waitForFunction(async () => {
      const { frontStage } = await import('/src/editor/stageBridge.ts');
      return !!frontStage();
    }, { timeout: 120000, polling: 50 });
    const stageReadyMs = round(performance.now() - startedAt);
    const portsResponse = await fetch(origin + '/api/stage/ports');
    const stagePorts = await portsResponse.json();
    if (stagePorts.ports?.join(',') !== `${port + 1},${port + 2}`) throw new Error(`Stage ports did not start: ${JSON.stringify(stagePorts)}`);
    return { pair, kind, pid: child.pid, http200Ms, stageReadyMs };
  } catch (error) {
    throw new Error(`${kind} pair ${pair}, PID ${child?.pid ?? 'none'}: ${error.stack ?? error}\nVite log:\n${log.join('')}`);
  } finally {
    await browser.close().catch(() => {});
    await stopTree(child);
    for (let i = 0; i < 50; i++) {
      if ((await Promise.all([port, port + 1, port + 2].map(portIsFree))).every(Boolean)) break;
      await sleep(100);
    }
  }
}

// Vite's own resolved config is authoritative, not the location of the npx binary.
const viteConfig = await resolveConfig({}, 'serve');
if (!viteConfig) throw new Error('Vite config did not resolve');
const cacheDir = path.resolve(viteConfig.cacheDir);
const ownNodeModules = path.join(root, 'node_modules');
let ownCache = within(ownNodeModules, cacheDir) && path.basename(cacheDir).startsWith('.vite');
const nodeModulesStat = await fs.lstat(ownNodeModules).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
if (nodeModulesStat?.isSymbolicLink()) ownCache = false;
if (nodeModulesStat?.isDirectory()) ownCache &&= within(root, await fs.realpath(ownNodeModules));
const coldMethod = ownCache ? 'delete-worktree-vite-cache' : 'force';
const cleared = [];
const samples = [];
try {
  for (let pair = 1; pair <= 3; pair++) {
    const currentNodeModulesStat = await fs.lstat(ownNodeModules).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (ownCache && currentNodeModulesStat?.isSymbolicLink()) throw new Error('node_modules became a link; refusing cache removal');
    if (ownCache && currentNodeModulesStat?.isDirectory()) {
      if (!within(root, await fs.realpath(ownNodeModules))) throw new Error('node_modules resolves outside this worktree; refusing cache removal');
      for (const entry of await fs.readdir(ownNodeModules, { withFileTypes: true })) {
        if (!entry.name.startsWith('.vite')) continue;
        const target = path.join(ownNodeModules, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Refusing to delete cache link: ${target}`);
        await fs.rm(target, { recursive: true, force: true });
        cleared.push(target);
      }
    }
    samples.push(await runOnce('cold', pair, coldMethod));
    samples.push(await runOnce('hot', pair, coldMethod));
  }
  const group = (kind) => {
    const rows = samples.filter((sample) => sample.kind === kind);
    return { http200Ms: rows.map((row) => row.http200Ms), http200MedianMs: median(rows.map((row) => row.http200Ms)), stageReadyMs: rows.map((row) => row.stageReadyMs), stageReadyMedianMs: median(rows.map((row) => row.stageReadyMs)) };
  };
  console.log(JSON.stringify({ root, command: `npx vite --port ${port} --strictPort --host 127.0.0.1`, cacheDir, coldMethod, cleared, criterion: 'editor-preview-smoke: iframe[data-pc="stage-frame"] then !!frontStage()', samples, cold: group('cold'), hot: group('hot') }, null, 2));
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
