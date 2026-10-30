/**
 * 测试里要空闲端口：自己挑一个并试着监听确认空着，一次要多个时两两不同。
 * 不写死端口号，所以同一次 npm test 里的各文件之间、同一台机器上同时跑的两个 npm test 之间都不会撞端口。
 * 端口在 20000～49151 里随机挑，不会落在 5xxx、58xx、59xx 这些保留段。
 *
 * 「确认空着」到「真的占上」之间有一段空档：起子进程的夹具要等一两秒才占上，这期间别的测试进程试着监听同一个端口也是空的，
 * 两边就挑到了同一个，后占的那个 EADDRINUSE（机器忙、几份全量测试同时跑时实测得到：16 份 `move-guard.test.mjs` 并发，
 * 32 次里 1 次素材子进程报 `EADDRINUSE`）。所以挑中的端口另在临时目录里记一笔（`<临时目录>/promptcut-test-port-claims/<端口>`，
 * 独占创建），别的进程看到有人记着、而且还没过期，就换一个挑。记的这一笔只为盖住那段空档，`CLAIM_MS` 之后作废，不用谁来还；
 * 记不下来（目录不可写之类）就当没有这回事，退回原来的做法。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CLAIM_DIR = path.join(os.tmpdir(), 'promptcut-test-port-claims');
/** 一笔记录管多久：比「挑中到占上」的空档长得多，又短到同时记着的端口只占这个区间的一小部分 */
const CLAIM_MS = 90_000;
let swept = false;

/** 每个进程头一次用时把过期的记录清掉（尽力而为） */
function sweepClaims() {
  if (swept) return;
  swept = true;
  try {
    fs.mkdirSync(CLAIM_DIR, { recursive: true });
    const now = Date.now();
    for (const name of fs.readdirSync(CLAIM_DIR)) {
      const file = path.join(CLAIM_DIR, name);
      try { if (now - fs.statSync(file).mtimeMs > CLAIM_MS) fs.unlinkSync(file); } catch { /* 别的进程刚清掉 */ }
    }
  } catch { /* 目录用不了：不记，照原来的做法 */ }
}

/** 给这个端口记一笔。回 false = 别的进程刚挑中它、还没过期，换一个 */
function claimPort(port) {
  sweepClaims();
  const file = path.join(CLAIM_DIR, String(port));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return true; }
    catch (error) {
      if (error?.code !== 'EEXIST') return true; // 记不下来不挡路
      try {
        if (Date.now() - fs.statSync(file).mtimeMs <= CLAIM_MS) return false;
        fs.unlinkSync(file); // 过期的：清掉再记一次
      } catch { /* 正好被别人清掉或重记了：再试一次 */ }
    }
  }
  return false;
}

export async function freePorts(count = 1, host = '127.0.0.1') {
  // 这台机器的系统临时端口区间是 1024～15000，会落进 58xx 这类保留段，所以自己在 20000～49151 里随机挑、逐个试着监听确认空着。
  const servers = [], ports = [];
  while (ports.length < count) {
    const port = 20000 + Math.floor(Math.random() * (49152 - 20000));
    if (ports.includes(port) || !claimPort(port)) continue;
    try {
      servers.push(await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
      }));
      ports.push(port);
    } catch { /* 被占了，换一个 */ }
  }
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}

export async function freePort(host = '127.0.0.1') {
  return (await freePorts(1, host))[0];
}

/**
 * 要一段连续的、都空闲的端口（夹具里「基准端口 + 代号」那种用法）：先挑一个空闲的，再试它后面 count-1 个是否也空闲，不行就换一个重来。
 * 返回起点。
 */
export async function freePortRange(count, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const base = await freePort(host);
    if (base + count > 65535) continue;
    const servers = [];
    try {
      for (let i = 0; i < count; i += 1) {
        // 起点已经由 freePort 记过；后面几个也各记一笔，有一个被别人记着就换一个起点
        if (i > 0 && !claimPort(base + i)) break;
        servers.push(await new Promise((resolve, reject) => {
          const server = net.createServer();
          server.once('error', reject);
          server.listen(base + i, host, () => resolve(server));
        }));
      }
    } catch { /* 这一段里有被占的，换一个起点 */ }
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    if (servers.length === count) return base;
  }
  throw new Error('free-port-range-unavailable');
}

/** startRunnerProcessFixture 要的那一组端口，全部取自系统给的空闲端口（identityBase、controlBase 各带一段给「代号」往上加）。 */
export async function runnerPorts() {
  const [a, b, c, d, e, f, g, agent, masterEvents, look, renderWorker] = await freePorts(11);
  return { combo: [a, b, c, d, e, f, g], agent, masterEvents, look, renderWorker,
    identityBase: await freePortRange(16), controlBase: await freePortRange(16) };
}
