/**
 * 仅供测试。`npm test` 的全局准备（`node --test --test-global-setup=server/test/global-setup.mjs`），
 * 在测试运行器的主进程里跑一次，早于所有测试文件的子进程。
 *
 * 做两件事：
 *
 * 1. **不继承外部的 `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`**（`scripts/lib/user-dirs.mjs`）：桌面版把它们设成
 *    `%USERPROFILE%\Videos\PromptCut` 与应用数据目录；从桌面版的环境里（例如桌面版里的 Agent）跑 `npm test`，
 *    测试起的编辑器、预渲染进程、`FramePipeline` 会把帧库和成本记录写进用户目录。这里在主进程里摘掉，
 *    各测试文件的子进程都继承摘过的环境，产物落在仓库 `out/` 或各测试自己设的临时目录。守门见 `no-user-dirs.test.mjs`。
 * 2. **在整个测试期间占住 fetch 规范里的「坏端口」**，让各测试文件 `listen(0)` 拿不到它们。下面说的都是这一件。
 *
 * 为什么：Node 的 `fetch` 和内置 `WebSocket`（都是 undici）按 WHATWG fetch 规范拒绝连这些端口，
 * 报 `TypeError: fetch failed`（cause `bad port`）或 WebSocket 直接 error / 1006，连都不连。
 * 测试里的服务几乎都是 `listen(0)` 让系统给端口；系统的临时端口段缺省是 49152～65535，碰不到这份名单，
 * 但 Windows 的临时端口段可以被改到低段（有的机器就是），而且 Windows 是**全机一个计数器顺序发号**，
 * 并行跑的几十个测试进程一起往前走：走过 1719、4190、6000、6665～6669、10080 这些号时，恰好拿到它的服务
 * 就连不上。表现是全量测试偶发失败、单独跑必过，而且常常几个文件同时挂在 30 ms 左右（6665～6669 连着 5 个）。
 *
 * 占法：每个端口在 127.0.0.1 和 ::1 上各绑一个不接连接的监听（只绑回环，不开防火墙口子）。
 * 实测 Windows 给 `listen(0)` 发号时会跳过这些已占用的号，不论调用方绑的是 127.0.0.1、::1、0.0.0.0、:: 还是缺省。
 * 绑不上（端口已经被别的程序占着）就跳过：别人占着，系统同样不会把它发给测试。
 *
 * 并行跑多份 `npm test`（几个 worktree 同时跑）时，先起的那份占住了，后起的那份占不到；先起的那份收尾放掉之后，
 * 后起的那份的测试文件就可能拿到这些号。所以运行期间每秒重试一次还没占到的（端口, 地址）对：谁先放手，
 * 仍在跑的那份就接着占。定时器 `unref`，不拖住进程；`globalTeardown` 里停掉定时器、关掉全部监听。
 *
 * 子进程从环境变量 `PROMPTCUT_TEST_BAD_PORTS_HELD` 知道启动时本次占住了哪些（只作参考）。
 * `bad-ports.test.mjs` 核对的是「名单里每个端口都 listen 不到」，不论谁占着。
 */
import net from 'node:net';
import { scrubUserDirEnv, markNoPortFile } from '../../scripts/lib/user-dirs.mjs';

/**
 * WHATWG fetch 规范「bad port」名单里 ≥ 1024 的部分（低于 1024 的系统不会当临时端口发）。
 * 最大的是 10080；自动挑端口的脚本因此从 20000 以上挑。
 */
export const FETCH_BAD_PORTS = Object.freeze([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const HOSTS = ['127.0.0.1', '::1'];
const TOTAL = FETCH_BAD_PORTS.length * HOSTS.length;
const RETRY_MS = 1000;
/** `${port}@${host}` → 占着它的监听 */
const held = new Map();
let retryTimer = null;
let retrying = null;

function hold(port, host) {
  const key = `${port}@${host}`;
  if (held.has(key)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.unref();
      held.set(key, server);
      resolve(true);
    });
  });
}

/** 把还没占到的（端口, 地址）对都试一遍；返回至少一个地址占着的端口。 */
async function holdAll() {
  const got = [];
  for (const port of FETCH_BAD_PORTS) {
    let any = false;
    for (const host of HOSTS) if (await hold(port, host)) any = true;
    if (any) got.push(port);
  }
  return got;
}

function stopRetry() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
}

export async function globalSetup() {
  for (const { key, value } of scrubUserDirEnv(process.env)) {
    console.error(`[global-setup] 不继承外部的 ${key}=${value}（测试不写用户目录，见 scripts/lib/user-dirs.mjs）`);
  }
  // 测试起的编辑器不写公共的 %TEMP%\promptcut\port.json（scripts/lib/user-dirs.mjs 的 markNoPortFile；守门 port-file.test.mjs）
  markNoPortFile(process.env);
  const got = await holdAll();
  process.env.PROMPTCUT_TEST_BAD_PORTS_HELD = got.join(',');
  if (held.size >= TOTAL) return;
  retryTimer = setInterval(() => {
    if (retrying) return;
    retrying = holdAll().finally(() => {
      retrying = null;
      if (held.size >= TOTAL) stopRetry();
    });
  }, RETRY_MS);
  retryTimer.unref();
}

export async function globalTeardown() {
  stopRetry();
  if (retrying) await retrying;
  const servers = [...held.values()];
  held.clear();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
}
