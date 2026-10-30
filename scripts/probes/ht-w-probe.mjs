/**
 * W-HT-a 跨机探针(主执行计划第 6.5 节 W-HT-a、第 6.8 节、第 7 节 HT-a;契约 `docs/plan/http-transport-contract.md`
 * 第 3、4、8 节;语义 `product/document-service.md` 与 `mechanism/document-service.md` 的「会话与传输」「渲染任务队列」)。
 *
 * 要证的:独立渲染主机持有任务时,它到文档服务的传输断一次 ——
 *   会话在保留期内**接续**(不是新会话),租约不丢(这个任务不被放回、不被别人重新认领、没有 `lease-lost`),
 *   任务照常完成,每个任务恰好一次 `task.done`。
 *
 * 两个角色经协调口 KV(`probe-coord.mjs` 的形状)交换配置与结果,不共享文件系统,可以在不同机器上跑。
 *
 *   node scripts/probes/ht-w-probe.mjs --role creator | host | all
 *        [--place cloud | lan]         缺省 cloud(项目在 --hosted 的托管端)。lan = M8 的 C5-2(计划 `docs/plan/m8-plan.md` 第 2.6 节):
 *                                      creator 以局域网主机起编辑器(`PROMPTCUT_LAN_HOST=1`,绑 0.0.0.0),在本机建局域网模式的项目;
 *                                      host 经局域网发现找到它(`--lan-host <ip:端口>` 手填兜底),代理转到发现的地址;
 *                                      会话计数 `sessions.resumed` 改读 PC 局域网主机的 `/api/docservice/healthz`(只答回环,
 *                                      由 creator 在收到 `host.holding` 与 `host.resumed` 时读,判 `lan-healthz-resumed`)。
 *                                      放本机时不给 --hosted,全程不连托管端
 *        [--lan-ip <PC 局域网地址>]     lan 的 creator:发给主机的地址用它,缺省取本机第一块局域网网卡(`lan/discovery.mjs` 的选网卡规则)
 *        [--lan-host <ip:端口>]         lan 的 host:发现查不到时手填
 *        --hosted <文档服务基址>        cloud 必给(本探针缺省不连任何地址):本机 http://127.0.0.1:8797,阿里云 https://203-0-113-16.sslip.io/hosted
 *        --coord <协调口基址>           必给:本机 http://127.0.0.1:8799,阿里云 https://203-0-113-16.sslip.io/coord
 *        [--run <本轮 id>]             两个角色用同一个;creator 不给就自己生成并写进 KV `htw.latest`,host 不给就从那里取
 *        [--port <编辑器端口>]          creator 缺省 5600、host 缺省 5603(各另占 +1、+2 当舞台端口);--role all 是起点(缺省 5600)
 *        [--out <目录>]                缺省 <系统临时目录>/pc-htw-<run>/<角色>:编辑器、主机、代理的日志
 *        [--cut proxy | external]      缺省 proxy。只 host 与 all 用
 *        [--proxy-port <端口>]          --cut proxy 时本机代理监听的端口,缺省「主机编辑器端口 + 3」(all 里是 5606)
 *        [--proxy-target <host:port>]  --cut proxy 时代理转到哪里。缺省取 --hosted 的主机与端口,只在它是 http:// 或 ws:// 时可推;
 *                                      https 的托管端(阿里云经 nginx 443)要给明文的文档服务端口,例如 203.0.113.16:8787
 *        [--proxy-path <路径>]         主机经代理连的路径,缺省 /(直连文档服务端口时就是根);lan 缺省取发现到的地址的路径(/docservice)
 *        [--seconds 8] [--clips 4]     时间轴:clips 条轨道各放一段 seconds 秒的 `r6-canvas`(共享档,参数带本轮的盐,结果键全新),
 *                                      按 60 帧一段切,缺省 4 × 4 = 16 个细任务
 *        [--host-concurrency 2]        主机并发(`render-host.mjs --max-concurrent`);发布方的本机节点并发是 1,主机多拿一些
 *        [--cut-wait-min 10]           --cut external 时等 KV `cut.done` 的时限
 *        [--resume-timeout-s 90]       断开后等会话接续的时限
 *        [--timeout-min 20] [--keep-temp]
 *
 * 环境变量:协调口开了信箱时 KV 要 `PROBE_MAIL_TOKEN`(`coordClient` 自动带,令牌不打印)。云端跑 host 另要
 * `NODE_USE_ENV_PROXY=1`、`PC_CHROME_ARGS=--no-sandbox`(脚本不管,原样传给子进程)。
 * `PC_CHROME_ARGS` 只把参数原样透传给探针起的 Chrome(典型用途:云端 Linux 以 root 运行要 `--no-sandbox`);不要用它关 TLS 校验(如 `--ignore-certificate-errors`),否则对远端站点的探针在证书有问题时照样通过,掩盖真问题。
 * 输出:过程写 stderr(一行一条 JSON);stdout 最后一行一行 JSON `{ role, ok, checks: [{ name, ok, detail }], fails: [], … }`,
 * `ok` 为假退出码 1,参数不对退出码 2。口令只进 KV(`htw.<run>.config`)与各角色 `--out` 下的配置文件,不进 stdout / stderr。
 *
 * ## KV 键(`htw.<run>.<名>`)
 *   config        creator → host:托管地址、项目 id、成员名与项目口令、盐
 *   host.ready    host → creator:主机起来了,带它的环境指纹与代码版本(creator 核对与本机节点相同才发布)
 *   host.holding  host → 外部(与 creator):主机此刻持有的任务 id,可以断了
 *   cut.done      外部 → host:--cut external 时,外部把连接杀掉之后写(任意 JSON,如 `{ "by": "ss -K" }`)
 *   host.resumed  host → creator:会话已接续(只作记录)
 *   plan          creator → host:细任务 id、每个任务 task.done 的次数、发布方本机节点做了哪些、旁观节点看到的每个任务的认领与放回
 *   host / creator  两个角色的结果;abort 出错时写,对方看到就收尾
 *
 * ## --role creator
 *   1. 核对托管端 `/healthz`;起编辑器(本检出根,只绑回环,队列模式 `PROMPTCUT_QUEUE_NODE=1`,
 *      `PROMPTCUT_SHARED_CONFIG` 指向以创建者身份、`role: 'render'` 连这个项目的配置)—— 预渲染进程是发布方自己的节点(profile pc,并发 1);
 *   2. 在托管端建一个自由进入的共享项目(随机项目名、创建者口令、项目口令),写 KV `config`;
 *   3. 起一个**旁观节点**:以成员 `watcher`、`role: 'render'` 连项目,`node.hello`(profile pc、与本机节点同指纹)后
 *      `queue.watch` 探针项目,只收不认领,记下每个任务的 `task.taken` / `task.opened` / `task.closed`(队列的真相,跨机也能看);
 *   4. 等 KV `host.ready`,核对主机的环境指纹、代码版本与本机节点相同(细任务的 `requires.envFingerprint` 是切分方的指纹,
 *      不同指纹的主机认领不到);
 *   5. 推镜像 → preload:本机节点认领 plan、切出细任务;本机节点与主机一起做;等细任务全部落定、清单拉完,写 KV `plan`;
 *   6. 等 KV `host`,汇总;收尾:经创建者操作 `delete` 删掉托管端这个项目,结束自己起的进程树。
 *
 * ## --role host
 *   1. 从 KV 取 `config`,写一份共享项目配置(成员 `host`、`role: 'render'`);
 *      - `--cut proxy`:配置的 `url` 指向本机 `render-queue-proxy.mjs --cut-once --stdin-control`,由它转到真正的文档服务;
 *      - `--cut external`:直连 `--hosted`,由外部把连接杀掉;
 *   2. 起 `cloud/scripts/render-host.mjs --config … --port … --max-concurrent …`(IPC),起来后写 KV `host.ready`;
 *   3. 每 150 ms 读一次 `GET /api/frames/queue`,等到主机手里有任务(`nodes[0].held` 非空);记下持有的 id、`opens`、`resumes`、
 *      托管端 `/healthz` 的 `sessions.resumed`;写 KV `host.holding`;
 *   4. 断开:`proxy` 往代理的标准输入写 `cut`(代理切断此刻开着的连接,之后一次也不再切 —— 接续那条原样转发);
 *      `external` 等 KV `cut.done`(等不到算失败);
 *   5. 等会话接续(`nodes[0].resumes` 增加、`opens` 不变);读 `/healthz`;写 KV `host.resumed`;
 *   6. 等 KV `plan`,读主机的计数,经 IPC `shutdown` 正常退出(放回认领),结果写 KV `host`。
 *
 * ## 断言(`checks`)
 *   host:
 *     held-before-cut       断开前主机至少持有 1 个任务
 *     cut                   断开确实发生了(代理打了 conn.cut / 外部写了 cut.done)
 *     session-resumed       断开后是会话接续:主机 `GET /api/frames/queue` 的 `resumes` 增加(端点每接续成功一次加一)
 *     not-new-session       没有建新会话:`opens` 不变(主机端点的 `session.*` 日志打在预渲染进程控制台上、编辑器不转出来,
 *                           所以不靠日志;日志里真有 `docservice.session.*` 时记进 detail 作旁证)
 *     same-session-to-end   到全部任务落定时 `opens` 仍不变
 *     healthz-resumed       托管端 `/healthz` 的 `sessions.resumed` 增加
 *     held-no-lease-lost    断开时持有的任务没有 `lease-lost`;断开到接续后 35 s(租约 30 s + 扫描 5 s)内主机任何任务都没有 `lease-lost`。
 *                           这段之外的 `lease-lost`(机器过忙、画面 120 s 不动按停滞回收之类)与传输无关,只记进 detail(`lostTotal`、`lostEvents`)
 *     not-released          主机退出前 `released` 为 0(持有的任务没被放回)
 *     held-single-claim     断开时持有的每个任务:旁观节点看到的认领至多一次、认领之后没有再 open(没被放回、没被别人重新认领),
 *                           结束时是 done;发布方本机节点没认领过它
 *     render-host-exit      render-host 正常退出(退出码 0)
 *   creator:
 *     host-fingerprint      主机的环境指纹、代码版本与发布方本机节点相同
 *     all-done              全部细任务落定为 done,没有失败
 *     done-exactly-once     每个细任务(和 plan)恰好收到一次 task.done
 *     host-worked           主机完成的任务数 ≥ 1;本机节点完成数 + 主机完成数 = 细任务数
 *     project-deleted       删掉了托管端的测试项目
 *
 * ## --role all(本机替身,主执行计划 6.8 节)
 *   同一台机器上各起一个子进程跑两个角色(端口 5600 / 5603,代理 5606),`--cut proxy`,汇总两行结果、合并 `checks`。
 *
 * ## 跑法
 *
 * 本机替身(临时托管组合只绑 127.0.0.1、信任关闭、现场生成集群令牌与协调口令牌,令牌不打印;在 Git Bash 里):
 *   DATA=$(mktemp -d); OUT=<输出目录>; mkdir -p "$OUT"
 *   export PROBE_MAIL_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
 *   PROMPTCUT_CLUSTER_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
 *     PROMPTCUT_DATA_DIR="$DATA" PROMPTCUT_DOCSERVICE_HOST=127.0.0.1 PROMPTCUT_DOCSERVICE_PORT=8797 PROMPTCUT_ASSET_PORT=8798 \
 *     PROMPTCUT_TRUST_LOOPBACK=0 node server/hosted/main.mjs > "$OUT/hosted.log" 2>&1 &
 *   node scripts/probes/probe-coord.mjs serve --port 8799 > "$OUT/coord.log" 2>&1 &
 *   node scripts/probes/ht-w-probe.mjs --role all --cut proxy --hosted http://127.0.0.1:8797 --coord http://127.0.0.1:8799 --out "$OUT/roles"
 *   (跑完结束这两个后台进程、删掉 $DATA)
 *
 * 放本机(C5-2,PC 当局域网主机、笔记本经代理连它;协调口用 PC 局域网上的 probe-coord,全程不连阿里云):
 *   PC:    node scripts/probes/probe-coord.mjs serve --host 0.0.0.0 --port 5789
 *          node scripts/probes/ht-w-probe.mjs --role creator --place lan --coord http://<PC 局域网地址>:5789 --port 5780 --run <id>
 *   笔记本: node scripts/probes/ht-w-probe.mjs --role host --place lan --cut proxy --coord http://<PC 局域网地址>:5789 --run <id> --port 5583 --proxy-port 5596
 *   本机替身:node scripts/probes/ht-w-probe.mjs --role all --place lan --coord <本机协调口> --port 5740 --proxy-port 5749
 *
 * 对阿里云(托管端 https://203-0-113-16.sslip.io/hosted,协调口 https://203-0-113-16.sslip.io/coord,各机都要 PROBE_MAIL_TOKEN):
 *   creator(笔记本):
 *     node scripts/probes/ht-w-probe.mjs --role creator --hosted https://203-0-113-16.sslip.io/hosted --coord https://203-0-113-16.sslip.io/coord --run <id>
 *   host,笔记本第二实例、代理切断(代理转到明文的文档服务端口 8787):
 *     node scripts/probes/ht-w-probe.mjs --role host --cut proxy --proxy-target 203.0.113.16:8787 \
 *       --hosted https://203-0-113-16.sslip.io/hosted --coord https://203-0-113-16.sslip.io/coord --run <id> --port 5603
 *   host,云端容器、外部切断(另要 NODE_USE_ENV_PROXY=1、PC_CHROME_ARGS=--no-sandbox):
 *     node scripts/probes/ht-w-probe.mjs --role host --cut external \
 *       --hosted https://203-0-113-16.sslip.io/hosted --coord https://203-0-113-16.sslip.io/coord --run <id>
 *     看到 KV `htw.<id>.host.holding` 后,在服务器上杀掉这台主机到 nginx 443 的那条连接(见 AGENT-ht-w-probe 报告的 `ss -K` 条件),
 *     再 `PUT /coord/kv/htw.<id>.cut.done`(带 X-Mail-Token)。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawn, spawnSync, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { coordClient } from './probe-coord.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = fileURLToPath(import.meta.url);
const PROXY = path.join(ROOT, 'scripts', 'probes', 'render-queue-proxy.mjs');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROLE = arg('--role', null);
const HOSTED = arg('--hosted', null) ? String(arg('--hosted')).replace(/\/+$/, '') : null;
const COORD = arg('--coord', null) ? String(arg('--coord')).replace(/\/+$/, '') : null;
const CUT = arg('--cut', 'proxy');
const PLACE = arg('--place', 'cloud');
/** 放云端要托管端;放本机不要(项目在 creator 的局域网主机编辑器里) */
const needHosted = () => PLACE === 'cloud' && !HOSTED;
const TIMEOUT_MS = Number(arg('--timeout-min', 20)) * 60_000;
const KEEP = argv.includes('--keep-temp');
const SECONDS = Number(arg('--seconds', 8));
const CLIPS = Number(arg('--clips', 4));
const HOST_CONCURRENCY = Number(arg('--host-concurrency', 2));
const CUT_WAIT_MS = Number(arg('--cut-wait-min', 10)) * 60_000;
const RESUME_TIMEOUT_MS = Number(arg('--resume-timeout-s', 90)) * 1000;
const DEFAULT_PORT = { creator: 5600, host: 5603 };
/** 探针项目在队列里的 id(共享项目的空间里,任务的 source.projectId 就是它) */
const PROBE_PROJECT = 'ht-w-probe';
const FPS = 30;
const started = Date.now();
const deadline = started + TIMEOUT_MS;

const fails = [];
const checks = [];
/** 一条断言:进 checks,不过的同时进 fails */
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) fails.push(`${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
  return !!ok;
};
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), role: ROLE, step, ...fields })}\n`);
const newRunId = () => `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const K = (run, name) => `htw.${run}.${name}`;
const secret = () => randomBytes(12).toString('base64url');

/** 轮询到 fn 回真;超时回 null(不记失败,由调用方判) */
async function until(fn, timeoutMs, everyMs = 200) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await delay(everyMs);
  }
}

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}
const exited = (child, ms = 20_000) => new Promise((resolve) => {
  if (!child || child.exitCode !== null) return resolve(child?.exitCode ?? null);
  const t = setTimeout(() => resolve(null), ms);
  child.once('exit', (code) => { clearTimeout(t); resolve(code); });
});
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
async function json(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}
const postJson = (url, body, timeoutMs) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs });

/** 文档服务的 ws(s) 基址 → `/healthz` 的 http(s) 地址 */
const healthzOf = (wsBase) => `${wsBase.replace(/^ws/, 'http').replace(/\/+$/, '')}/healthz`;
async function sessionsOf(wsBase) {
  try { return (await json(healthzOf(wsBase), { timeoutMs: 15_000 })).body?.sessions ?? null; } catch { return null; }
}

/** 子进程公共环境:不带集群令牌、不连外面的文档服务,数据与临时目录都在 dir 下(不写公共的 port.json) */
function baseEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_NODE_PROFILE', 'PROMPTCUT_SHARED_CONFIG',
    'PROMPTCUT_HOST_MAX_CONCURRENT', 'PROMPTCUT_TEST_CODE_VERSION', 'PROMPTCUT_PUSH', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL',
    'PROMPTCUT_LAN_HOST', 'PROMPTCUT_TRANSPORT']) delete env[key];
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data')]) fs.mkdirSync(d, { recursive: true });
  return { ...env, PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_STREAMS: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...extra };
}

/** 收一个子进程的输出:按行存(最多 limit 行),另可逐行回调 */
function collect(child, { limit = 8000, onLine } = {}) {
  const lines = [];
  let partial = '';
  const keep = (c) => {
    const parts = (partial + c.toString()).split(/\r?\n/);
    partial = parts.pop() ?? '';
    for (const line of parts) {
      if (!line) continue;
      lines.push(line);
      if (lines.length > limit) lines.shift();
      try { onLine?.(line); } catch { /* 回调出错不影响收集 */ }
    }
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return lines;
}

async function mods() {
  const [route, client, shared, link] = await Promise.all([
    import('../../server/auth/route.mjs'), import('../../server/auth/client.mjs'), import('../../server/auth/shared-config.mjs'),
    import('../../server/render-node/session-link.mjs'),
  ]);
  return { ...client, ...shared, ...link, wsBaseOf: route.wsBaseOf, createSharedProject: route.createSharedProject };
}

/** 请求 / 回包按 reqId 配对 */
function rpcOn(ep) {
  const waiting = new Map();
  let seq = 0;
  ep.onMessage((m) => {
    const w = m?.reqId !== undefined ? waiting.get(m.reqId) : undefined;
    if (!w) return;
    waiting.delete(m.reqId);
    clearTimeout(w.timer);
    w.resolve(m);
  });
  return (message, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const reqId = `htw-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`等 ${message.type} 的回包超时`)); }, timeoutMs);
    waiting.set(reqId, { resolve, timer });
    if (!ep.send({ ...message, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error(`${message.type} 没发出去`)); }
  });
}

/** 以某个身份连上项目:回 { ep, rpc, close };20 s 建不成会话回 null */
async function openConn(M, { url, projectId, username, password, as = 'member', role = 'page', tag }) {
  const entry = M.normalizeEntry({ url, projectId, username, password, as, role, deviceId: `htw-${tag}-${randomBytes(6).toString('hex')}`, deviceName: `ht-w-probe ${tag}` });
  const ep = M.createDocEndpoint({ url: entry.url, protocols: M.sharedProtocols(entry, { role }), log: () => {} });
  const rpc = rpcOn(ep);
  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 20_000);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
  if (!opened) { try { ep.close(); } catch { /* 已关 */ } return null; }
  return { ep, rpc, close: () => { try { ep.close(); } catch { /* 已关 */ } } };
}

/* ================================================================== creator */

/** 探针项目:CLIPS 条轨道各一段 SECONDS 秒的 r6-canvas(共享档、canvasHeavy),参数带盐,内容键全新 */
function probeProject(salt) {
  return {
    id: PROBE_PROJECT, name: 'W-HT-a 探针', width: 1920, height: 1080, fps: FPS, duration: SECONDS,
    themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks: Array.from({ length: CLIPS }, (_, i) => ({
      id: `tr-${i + 1}`, name: `tr-${i + 1}`, hidden: false,
      clips: [{ id: `clip-canvas-${i + 1}`, kind: 'card', cardId: 'r6-canvas', start: 0, end: SECONDS, params: { probeSalt: `${salt}-${i + 1}` } }],
    })),
  };
}

async function runCreator(out) {
  if (needHosted() || !COORD || !['cloud', 'lan'].includes(PLACE)) { fails.push('要给 --coord,放云端另要 --hosted(--place 取 cloud | lan)'); process.exitCode = 2; return; }
  const c = coordClient(COORD);
  const run = arg('--run', null) ?? newRunId();
  out.run = run;
  out.place = PLACE;
  const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-htw-${run}`, 'creator')));
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(arg('--port', DEFAULT_PORT.creator));
  const M = await mods();
  let editor = null;
  let editorLines = [];
  let watcher = null;
  let project = null;
  let creatorPw = null;
  let lanSessions = null;
  let delWs = null;
  const put = async (name, value) => { try { await c.put(K(run, name), value); } catch (error) { say('kv-put-failed', { name, message: String(error?.message ?? error) }); } };
  try {
    await c.put('htw.latest', { run, at: Date.now() });
    // 放云端:项目在托管端;放本机:项目在本编辑器(局域网主机)里,本机节点与建项目走回环,主机与旁观节点走局域网地址
    const lanIp = PLACE === 'lan' ? (arg('--lan-ip', null) ?? (await import('../../server/lan/discovery.mjs')).selectInterfaces()[0]?.address ?? null) : null;
    if (PLACE === 'lan' && !lanIp) { fails.push('放本机要有局域网地址(--lan-ip)'); process.exitCode = 2; return; }
    const loopbackWs = `ws://127.0.0.1:${port}/docservice`;
    delWs = PLACE === 'cloud' ? M.wsBaseOf(HOSTED) : loopbackWs;
    const hostedWs = PLACE === 'cloud' ? M.wsBaseOf(HOSTED) : `ws://${lanIp}:${port}/docservice`;
    out.lanIp = lanIp;
    if (PLACE === 'cloud') {
      const health = await json(healthzOf(hostedWs), { timeoutMs: 15_000 }).catch((e) => ({ ok: false, body: String(e?.message ?? e) }));
      if (!check('hosted-healthz', health.ok, health.ok ? undefined : health.body)) return;
    }

    // 1. 编辑器(队列模式;放云端只绑回环,放本机以局域网主机起、绑 0.0.0.0);配置文件在第一次打 /api/frames/* 时才读,先起、后写
    for (const p of [port, port + 1, port + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
    const creatorConfig = path.join(OUT, 'creator.json');
    const env = baseEnv(OUT, { PROMPTCUT_QUEUE_NODE: '1', PROMPTCUT_SHARED_CONFIG: creatorConfig, ...(PLACE === 'lan' ? { PROMPTCUT_LAN_HOST: '1' } : {}) });
    editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', ...(PLACE === 'lan' ? [] : ['--host', '127.0.0.1'])], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    editorLines = collect(editor);
    const editorUrl = `http://127.0.0.1:${port}`;
    const lanHealthz = `${editorUrl}/api/docservice/healthz`;
    if (PLACE === 'lan') {
      const up = await until(async () => (await json(lanHealthz, { timeoutMs: 3000 })).ok || null, 240_000, 500);
      if (!check('lan-host-up', !!up, editorLines.slice(-6))) return;
    }

    // 2. 共享项目(托管端,或本机的局域网模式项目:只有回环能建)
    creatorPw = secret();
    const projectPw = secret();
    project = await M.createSharedProject({ where: PLACE === 'cloud' ? 'hosted' : 'lan', ...(PLACE === 'cloud' ? { hostedUrl: hostedWs } : { lanBase: loopbackWs }),
      name: `htw-${run}`, mode: 'free', creator: { username: 'creator', password: creatorPw }, password: projectPw });
    out.projectId = project.projectId;
    const devId = (tag) => `htw-${tag}-${run}`.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(16, '0').slice(0, 64);
    fs.writeFileSync(creatorConfig, JSON.stringify([{ url: PLACE === 'cloud' ? hostedWs : loopbackWs, projectId: project.projectId, username: 'creator', deviceId: devId('creator'), deviceName: 'W-HT-a creator (probe)', as: 'creator', role: 'render', password: creatorPw }], null, 2));
    const salt = `${run}-${randomBytes(3).toString('hex')}`;
    await c.put(K(run, 'config'), { run, place: PLACE, hosted: HOSTED, hostedWs, name: project.name, projectId: project.projectId, member: { username: 'host', password: projectPw }, salt, at: Date.now() });
    // 放本机:主机读不到局域网主机的 /api/docservice/healthz(只答回环),由本角色在 host.holding / host.resumed 时各读一次 sessions
    lanSessions = PLACE === 'lan' ? (async () => {
      const holding = await c.take(K(run, 'host.holding'), deadline).catch(() => null);
      if (!holding) return null;
      const before = (await json(lanHealthz, { timeoutMs: 10_000 }).catch(() => null))?.body?.sessions ?? null;
      const resumed = await c.take(K(run, 'host.resumed'), deadline).catch(() => null);
      const after = await until(async () => {
        const s = (await json(lanHealthz, { timeoutMs: 10_000 }).catch(() => null))?.body?.sessions ?? null;
        return s && before && (s.resumed ?? 0) > (before.resumed ?? 0) ? s : null;
      }, 15_000, 500) ?? (await json(lanHealthz, { timeoutMs: 10_000 }).catch(() => null))?.body?.sessions ?? null;
      return { resumedSignal: !!resumed, before: before?.resumed ?? null, after: after?.resumed ?? null };
    })() : null;
    say('config', { run, projectId: project.projectId });

    const prerender = await until(async () => {
      const info = await json(`${editorUrl}/api/prerender/info`, { timeoutMs: 3000 });
      return info.body?.ready && info.body.url ? info.body.url : null;
    }, 240_000, 500);
    if (!check('creator-editor-ready', !!prerender, editorLines.slice(-6))) return;
    const diagnostics = async () => (await json(`${prerender}/api/frames/diagnostics`)).body ?? {};
    // 本机节点报到:预渲染进程第一次打 /api/frames/* 才建管线、开 Chrome、起节点,机器忙时要几分钟;记下最后一次看到的状态备查
    let lastQueue = null;
    const active = await until(async () => {
      try { const q = (await diagnostics()).queue ?? null; lastQueue = q ? { active: q.active, connected: q.connected, mode: q.mode, transport: q.transport ?? null } : { queue: null }; }
      catch (error) { lastQueue = { error: String(error?.message ?? error).slice(0, 120) }; }
      return lastQueue?.active === true || null;
    }, 420_000, 1000);
    const d0 = await diagnostics();
    out.pc = { nodeId: d0.queue?.nodeId ?? null, envFingerprint: d0.queue?.envFingerprint ?? null, codeVersion: d0.queue?.codeVersion ?? null, transport: d0.queue?.transport ?? null };
    if (!check('creator-node-active', !!active, { lastQueue, log: editorLines.filter((l) => l.includes('[queue-node]')).slice(-8) })) return;

    // 3. 旁观节点:只收不认领,记每个任务的认领 / 放回 / 关闭
    const seen = new Map();
    const rec = (id) => { if (!seen.has(id)) seen.set(id, { taken: 0, versions: [], reopenedAfterTaken: 0, closed: [] }); return seen.get(id); };
    watcher = await openConn(M, { url: hostedWs, projectId: project.projectId, username: 'watcher', password: projectPw, role: 'render', tag: 'watcher' });
    if (!check('watcher-open', !!watcher)) return;
    watcher.ep.onMessage((m) => {
      if (m?.type === 'task.taken' && typeof m.id === 'string') { const r = rec(m.id); r.taken++; r.versions.push(m.version ?? null); }
      else if (m?.type === 'task.opened' && typeof m.task?.id === 'string') { const r = rec(m.task.id); if (r.taken > 0) r.reopenedAfterTaken++; }
      else if (m?.type === 'task.closed' && typeof m.id === 'string') rec(m.id).closed.push(m.state ?? null);
    });
    const hello = await watcher.rpc({ type: 'node.hello', nodeId: `htw-watcher-${run}`.slice(0, 64), profile: 'pc', envFingerprint: out.pc.envFingerprint ?? undefined,
      codeVersions: out.pc.codeVersion ? [out.pc.codeVersion] : [], capabilities: {}, maxConcurrent: 1 }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    const watch = await watcher.rpc({ type: 'queue.watch', projects: [PROBE_PROJECT] }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    if (!check('watcher-watching', hello.type !== 'error' && watch.type === 'queue.snapshot', { hello: hello.type, helloReason: hello.reason ?? null, watch: watch.type, watchReason: watch.reason ?? null })) return;

    // 4. 等主机起来,核对指纹与代码版本
    say('wait-host');
    const ready = await c.take(K(run, 'host.ready'), deadline);
    if (!check('host-ready', !!ready)) return;
    out.host = { envFingerprint: ready.envFingerprint ?? null, codeVersion: ready.codeVersion ?? null };
    if (!check('host-fingerprint', ready.envFingerprint === out.pc.envFingerprint && ready.codeVersion === out.pc.codeVersion,
      { pc: { fp: out.pc.envFingerprint, code: out.pc.codeVersion?.slice(0, 12) }, host: { fp: ready.envFingerprint, code: ready.codeVersion?.slice(0, 12) } })) {
      await put('abort', { reason: 'fingerprint-mismatch', at: Date.now() });
      return;
    }

    // 5. 推镜像 → preload:本机节点认领 plan、切分,细任务由本机节点与主机一起做
    const before = (await diagnostics()).queue ?? {};
    const publishedBefore = new Set((before.published ?? []).map((p) => p.planId));
    const appliedBefore = (before.stats?.applied ?? 0) + (before.stats?.applyErrors ?? 0);
    const doneBefore = { ...(before.doneCounts ?? {}) };
    const session = `htw-${run}`;
    const projectJson = probeProject(salt);
    const pushed = await postJson(`${editorUrl}/api/data/project`, { session, localRev: 1, project: projectJson });
    if (!check('project-pushed', pushed.ok, pushed.body)) return;
    await until(async () => (await json(`${prerender}/api/data/project?session=${session}&localRev=1`)).ok || null, 30_000);
    const preloadAt = Date.now();
    const first = await postJson(`${prerender}/api/frames/preload`, { session, localRev: 1 }, 120_000);
    if (!check('preload-started', first.ok, first.body)) return;
    say('published', { key: first.body?.key?.slice?.(0, 12) ?? null });
    let lastStatus = null;
    const settled = await until(async () => {
      const st = await postJson(`${prerender}/api/frames/preload`, { session, localRev: 1 }, 120_000).catch(() => null);
      if (st?.body?.status) lastStatus = st.body.status;
      const q = (await diagnostics()).queue;
      const mine = (q?.published ?? []).find((p) => !publishedBefore.has(p.planId));
      const derived = mine ? q.plans?.[mine.planId] : null;
      if (!Array.isArray(derived)) return null;
      const states = derived.map((id) => q.tasks?.[id]?.state ?? 'pending');
      return states.every((s) => s === 'done' || s === 'failed') ? { planId: mine.planId, derived, states } : null;
    }, TIMEOUT_MS, 2000);
    if (!check('plan-settled', !!settled, { preloadStatus: lastStatus })) return;
    await until(async () => {
      const s = (await diagnostics()).queue?.stats ?? {};
      return (s.applied ?? 0) + (s.applyErrors ?? 0) - appliedBefore >= settled.derived.length || null;
    }, 120_000, 1000);
    await delay(1500); // 让旁观节点收齐最后几条 task.closed
    const q = (await diagnostics()).queue ?? {};
    const doneCounts = Object.fromEntries([settled.planId, ...settled.derived].map((id) => [id, (q.doneCounts?.[id] ?? 0) - (doneBefore[id] ?? 0)]));
    const failed = settled.derived.filter((id, i) => settled.states[i] === 'failed').map((id) => ({ id, error: q.tasks?.[id]?.error ?? null }));
    const inPlan = (ids) => (ids ?? []).filter((id) => settled.derived.includes(id));
    const pc = { claimed: inPlan(q.local?.claimed), completed: inPlan(q.local?.completed), dedup: inPlan(q.local?.dedup), planClaimed: (q.local?.claimed ?? []).includes(settled.planId) };
    const watched = Object.fromEntries(settled.derived.map((id) => [id, seen.get(id) ?? { taken: 0, versions: [], reopenedAfterTaken: 0, closed: [] }]));
    const plan = { planId: settled.planId, derived: settled.derived, tasks: settled.derived.length, doneCounts, failed, pc, watched, ms: Date.now() - preloadAt };
    await c.put(K(run, 'plan'), plan);
    Object.assign(out, { planId: plan.planId, tasks: plan.tasks, planMs: plan.ms, pcCompleted: pc.completed.length + pc.dedup.length, pcPlanClaimed: pc.planClaimed });
    check('all-done', failed.length === 0 && settled.states.every((s) => s === 'done'), { failed });
    const notOnce = Object.entries(doneCounts).filter(([, n]) => n !== 1);
    check('done-exactly-once', notOnce.length === 0, notOnce.length ? Object.fromEntries(notOnce) : undefined);
    out.doneCounts = { tasks: Object.keys(doneCounts).length, allOne: notOnce.length === 0 };

    // 6. 等主机的结果
    say('wait-host-result');
    const host = await c.take(K(run, 'host'), deadline);
    if (!check('host-result', !!host)) return;
    const hostDone = (host.completed ?? 0) + (host.dedup ?? 0);
    out.completedByNode = { pc: pc.completed.length + pc.dedup.length, host: hostDone };
    check('host-worked', hostDone >= 1 && out.completedByNode.pc + hostDone === plan.tasks, { ...out.completedByNode, tasks: plan.tasks });
    if (lanSessions) {
      // 放本机:主机那边的 healthz-resumed 由这里代判(局域网主机的 healthz 只答回环)
      const s = await lanSessions;
      out.lanSessions = s;
      check('lan-healthz-resumed', !!s && s.after !== null && s.before !== null && s.after > s.before, s);
    }
  } catch (error) {
    fails.push(`creator 出错:${String(error?.message ?? error).slice(0, 600)}`);
    say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
    await put('abort', { reason: String(error?.message ?? error).slice(0, 200), at: Date.now() });
  } finally {
    // 提前收尾(断言没过就 return 的那些路)也告诉主机别再等
    if (fails.length) await put('abort', { reason: `creator: ${fails[0].slice(0, 160)}`, at: Date.now() });
    watcher?.close();
    if (project && creatorPw) {
      let deleted = false;
      let deleteError;
      let conn = null;
      try {
        conn = await openConn(M, { url: delWs, projectId: project.projectId, username: 'creator', password: creatorPw, as: 'creator', tag: 'creator-del' });
        if (!conn) throw new Error('连不上项目');
        const ch = await conn.rpc({ type: 'shared.challenge' });
        if (ch.type !== 'shared.challenge.ok') throw new Error(`challenge ${ch.reason ?? ch.type}`);
        const key = await M.deriveKey(creatorPw, ch.salt, ch.kdf);
        const m = await M.adminProof({ key, projectId: project.projectId, username: 'creator', op: 'delete', nonce: ch.nonce });
        const r = await conn.rpc({ type: 'shared.admin', op: 'delete', proof: { nonce: ch.nonce, m } });
        deleted = r.type === 'shared.admin.ok';
        if (!deleted) deleteError = r.reason ?? r.type;
      } catch (error) {
        deleteError = String(error?.message ?? error).slice(0, 200);
      }
      conn?.close();
      check('project-deleted', deleted, deleteError);
    }
    if (editor) { killTree(editor); await exited(editor); }
    try { fs.writeFileSync(path.join(OUT, 'editor.log'), editorLines.join('\n')); } catch { /* 写不了不影响结论 */ }
    out.out = OUT;
    try { await c.put(K(run, 'creator'), { ok: fails.length === 0, fails, checks }); } catch { /* 协调口不通 */ }
  }
}

/* ================================================================== host */

async function runHost(out) {
  if (needHosted() || !COORD) { fails.push('要给 --coord,放云端另要 --hosted'); process.exitCode = 2; return; }
  if (!['proxy', 'external'].includes(CUT)) { fails.push('--cut 取 proxy 或 external'); process.exitCode = 2; return; }
  const c = coordClient(COORD);
  const run = arg('--run', null) ?? (await c.take('htw.latest', Date.now() + 120_000))?.run;
  if (!run) { fails.push('没有 --run,KV 里也没有 htw.latest'); return; }
  out.run = run;
  out.cut = CUT;
  const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-htw-${run}`, 'host')));
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(arg('--port', DEFAULT_PORT.host));
  const M = await mods();
  let child = null;
  let proxy = null;
  let lines = [];
  let proxyLines = [];
  const put = async (name, value) => { try { await c.put(K(run, name), value); } catch (error) { say('kv-put-failed', { name, message: String(error?.message ?? error) }); } };
  const aborted = async () => { try { return await c.get(K(run, 'abort'), 0); } catch { return null; } };
  try {
    const cfg = await c.take(K(run, 'config'), deadline);
    if (!check('host-config', !!cfg)) return;
    out.projectId = cfg.projectId;
    out.place = cfg.place ?? 'cloud';
    const lan = cfg.place === 'lan';

    // 0. 放本机:经局域网发现找局域网主机(--lan-host 手填兜底),连发现到的地址;查不到就用 creator 给的地址,记一条失败
    let baseWs = cfg.hostedWs;
    if (lan) {
      const [{ findSharedProject, wsBaseOf }, { discoverLan }] = await Promise.all([import('../../server/auth/route.mjs'), import('../../server/lan/discovery.mjs')]);
      const t0 = Date.now();
      const manual = arg('--lan-host', null);
      const found = await findSharedProject({ name: cfg.name, hostedUrl: null, lan: { discover: discoverLan, manual: manual ? [manual] : [] } })
        .catch((e) => ({ candidates: [], errors: [{ message: String(e?.message ?? e) }] }));
      const hit = found.candidates.find((x) => x.where === 'lan' && x.projectId === cfg.projectId) ?? null;
      out.discovery = { ms: Date.now() - t0, via: hit?.via ?? null, firstSeenMs: hit?.firstSeenMs ?? null, base: hit?.base ?? null, errors: (found.errors ?? []).slice(0, 3) };
      check('lan-found', !!hit, out.discovery);
      if (hit) baseWs = wsBaseOf(hit.base);
    }

    // 1. 连接地址:proxy 经本机代理,external 直连
    let docUrl = baseWs;
    if (CUT === 'proxy') {
      let target = arg('--proxy-target', null);
      if (!target) {
        const u = new URL(baseWs);
        if (u.protocol !== 'ws:') { fails.push('--hosted 是 https / wss 时要给 --proxy-target <明文文档服务的 host:port>(代理不解 TLS)'); process.exitCode = 2; return; }
        target = `${u.hostname}:${u.port || 80}`;
      }
      const proxyPort = Number(arg('--proxy-port', port + 3));
      if (!(await portFree(proxyPort))) throw new Error(`代理端口 ${proxyPort} 被占用`);
      proxy = spawn(process.execPath, [PROXY, '--listen', `127.0.0.1:${proxyPort}`, '--target', target, '--cut-once', '--stdin-control'],
        { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      proxyLines = collect(proxy);
      const listening = await until(() => proxyLines.some((l) => l.includes('"event":"listen"')) || null, 10_000, 100);
      if (!check('proxy-listening', !!listening, proxyLines.slice(-3))) return;
      const p = String(arg('--proxy-path', lan ? new URL(baseWs).pathname.replace(/\/+$/, '') || '/' : '/'));
      docUrl = `ws://127.0.0.1:${proxyPort}${p.startsWith('/') ? p : `/${p}`}`;
      out.proxy = { port: proxyPort, target };
    }

    // 2. 主机配置,起 render-host
    for (const p of [port, port + 1, port + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
    const configFile = path.join(OUT, 'host.json');
    const deviceId = `htw-host-${run}`.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(16, '0').slice(0, 64);
    fs.writeFileSync(configFile, JSON.stringify([{ url: docUrl, projectId: cfg.projectId, username: cfg.member.username, deviceId, deviceName: 'W-HT-a host (probe)', as: 'member', role: 'render', password: cfg.member.password }], null, 2));
    const env = { ...process.env };
    for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_TEST_CODE_VERSION', 'PROMPTCUT_TRANSPORT']) delete env[key];
    const dataDir = path.join(OUT, 'render-host-data');
    child = fork(path.join(ROOT, 'cloud', 'scripts', 'render-host.mjs'), ['--config', configFile, '--port', String(port), '--data', dataDir, '--max-concurrent', String(HOST_CONCURRENCY)],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let exitLine = null;
    lines = collect(child, { onLine: (line) => { if (line.startsWith('[render-host] exit ')) { try { exitLine = JSON.parse(line.slice('[render-host] exit '.length)); } catch { /* 半行 */ } } } });
    const ready = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 300_000);
      child.on('message', (m) => { if (m?.type === 'ready') { clearTimeout(t); resolve(m); } });
      child.once('exit', () => { clearTimeout(t); resolve(null); });
    });
    if (!check('render-host-ready', !!ready, lines.slice(-8))) return;
    const editor = `http://127.0.0.1:${port}`;
    const queue = async () => (await json(`${editor}/api/frames/queue`, { timeoutMs: 10_000 })).body;
    // 预渲染进程诊断里的事件只留最近 80 条:每 3 s 收一次失败 / 丢租约的事件(带时刻),免得被冲掉
    const hostEvents = new Map();
    let prerenderUrl = null;
    let eventsTimer = null;
    const pollEvents = async () => {
      try {
        prerenderUrl ??= (await json(`${editor}/api/prerender/info`, { timeoutMs: 5000 })).body?.url ?? null;
        if (!prerenderUrl) return;
        const events = (await json(`${prerenderUrl}/api/frames/diagnostics`, { timeoutMs: 10_000 })).body?.queue?.events ?? [];
        for (const e of events) {
          if (!/^node\.(failed|lost)$/.test(String(e?.event ?? ''))) continue;
          hostEvents.set(`${e.event}|${e.id}|${e.at}`, { event: e.event, id: e.id ?? null, at: e.at ?? null, error: String(e.error ?? '').slice(0, 200) });
        }
      } catch { /* 诊断读不到:下一拍再试 */ }
    };
    const tickEvents = async () => { await pollEvents(); if (eventsTimer !== false) eventsTimer = setTimeout(tickEvents, 3000); };
    void tickEvents();
    const q0 = await queue();
    await c.put(K(run, 'host.ready'), { port, envFingerprint: q0?.envFingerprint ?? null, codeVersion: q0?.codeVersion ?? null, at: Date.now() });
    say('host-ready', { port, cut: CUT });

    // 3. 等主机手里有任务
    let pre = null;
    const holding = await until(async () => {
      const q = await queue();
      const n = q?.nodes?.[0];
      if (n && Array.isArray(n.held) && n.held.length > 0 && n.connected) { pre = n; return true; }
      if (await c.get(K(run, 'plan'), 0).catch(() => null)) return 'plan-done';
      if (await aborted()) return 'abort';
      return null;
    }, TIMEOUT_MS, 150);
    if (!check('held-before-cut', holding === true, { holding, last: pre ? { held: pre.held } : null })) return;
    // 放本机:局域网主机的 healthz 只答回环,这两次读由 creator 代做(lan-healthz-resumed)
    const sessionsBefore = lan ? null : await sessionsOf(cfg.hostedWs);
    const linesBeforeCut = lines.length;
    Object.assign(out, { held: pre.held, opensBefore: pre.opens, resumesBefore: pre.resumes ?? 0, transport: pre.transport ?? null, sessionsResumedBefore: sessionsBefore?.resumed ?? null });
    await c.put(K(run, 'host.holding'), { held: pre.held, at: Date.now() });
    say('holding', { held: pre.held });

    // 4. 断开
    const cutAt = Date.now();
    let cutOk = false;
    if (CUT === 'proxy') {
      proxy.stdin.write('cut\n');
      cutOk = !!(await until(() => proxyLines.some((l) => l.includes('"event":"conn.cut"')) || null, 10_000, 50));
    } else {
      say('wait-cut-done', { key: K(run, 'cut.done') });
      cutOk = !!(await c.take(K(run, 'cut.done'), Math.min(deadline, Date.now() + CUT_WAIT_MS)));
    }
    // 5. 等接续
    const resumed = await until(async () => {
      const n = (await queue())?.nodes?.[0];
      return n && (n.resumes ?? 0) > out.resumesBefore ? n : null;
    }, RESUME_TIMEOUT_MS, 200);
    const resumedAt = resumed ? Date.now() : null;
    // 主机端点的 `session.*` 日志打在预渲染进程的控制台上,编辑器只留它最后几十行、不转出来(`vite-plugin-prerender.ts`),
    // 所以判据用 `GET /api/frames/queue` 的计数:`resumes`(端点每接续成功一次加一,接续之前必有一次脱开)与 `opens`
    // (建成新会话的次数)。日志里要是真有这几行(将来转出来了),一并记下作旁证。
    const since = lines.slice(linesBeforeCut);
    const has = (ev) => since.some((l) => l.includes(`docservice.${ev} `) || l.includes(`docservice.${ev}"`));
    const logged = { detach: has('session.detach'), resume: has('session.resume'), open: has('session.open'), close: has('session.close') };
    const sessionsAfter = lan ? null : await until(async () => {
      const s = await sessionsOf(cfg.hostedWs);
      return s && sessionsBefore && (s.resumed ?? 0) > (sessionsBefore.resumed ?? 0) ? s : null;
    }, 15_000, 500) ?? await sessionsOf(cfg.hostedWs);
    Object.assign(out, { cutMs: resumed ? Date.now() - cutAt : null, resumesAfter: resumed?.resumes ?? null, opensAfter: resumed?.opens ?? null,
      transportAfter: resumed?.transport ?? null, sessionsResumedAfter: sessionsAfter?.resumed ?? null });
    check('cut', cutOk, { cutOk, proxy: CUT === 'proxy' ? proxyLines.filter((l) => /conn\.cut/.test(l)).slice(0, 3) : undefined });
    check('session-resumed', !!resumed, { resumes: [out.resumesBefore, resumed?.resumes ?? null], logged });
    check('not-new-session', !!resumed && resumed.opens === out.opensBefore && !logged.open && !logged.close,
      { opens: [out.opensBefore, resumed?.opens ?? null], connectFailed: resumed?.connectFailed ?? null, logged });
    if (!lan) check('healthz-resumed', (sessionsAfter?.resumed ?? 0) > (sessionsBefore?.resumed ?? Infinity), { before: sessionsBefore?.resumed ?? null, after: sessionsAfter?.resumed ?? null });
    await put('host.resumed', { at: Date.now(), resumes: resumed?.resumes ?? null });

    // 6. 等 creator 的 plan,核对持有的任务
    say('wait-plan');
    const plan = await until(async () => (await c.get(K(run, 'plan'), 20_000)) ?? ((await aborted()) ? { aborted: true } : null), TIMEOUT_MS, 100);
    clearTimeout(eventsTimer);
    eventsTimer = false;
    await pollEvents();
    if (!check('plan-received', !!plan && !plan.aborted)) return;
    const n = (await queue())?.nodes?.[0] ?? {};
    Object.assign(out, { claimed: n.claimed ?? null, completed: n.completed ?? null, dedup: n.dedup ?? null, failed: n.failed ?? null, lost: n.lost ?? null,
      released: n.released ?? null, opens: n.opens ?? null, resumes: n.resumes ?? null, transportFinal: n.transport ?? null });
    const lostEvents = [...hostEvents.values()].filter((e) => e.event === 'node.lost');
    const windowEnd = (resumedAt ?? cutAt) + 35_000;
    const lostHeld = lostEvents.filter((e) => pre.held.includes(e.id));
    const lostNearCut = lostEvents.filter((e) => typeof e.at === 'number' && e.at >= cutAt - 1000 && e.at <= windowEnd);
    check('held-no-lease-lost', lostHeld.length === 0 && lostNearCut.length === 0 && lostEvents.length === (n.lost ?? 0),
      { lostTotal: n.lost ?? null, lostHeld, lostNearCut, lostEvents: lostEvents.slice(0, 5).map((e) => ({ ...e, sinceCutMs: typeof e.at === 'number' ? e.at - cutAt : null })) });
    check('not-released', n.released === 0, { released: n.released ?? null });
    check('same-session-to-end', n.opens === out.opensBefore, { opens: [out.opensBefore, n.opens ?? null], resumes: n.resumes ?? null });
    const perHeld = pre.held.map((id) => {
      const w = plan.watched?.[id] ?? null;
      return { id, inPlan: plan.derived.includes(id), taken: w?.taken ?? null, reopened: w?.reopenedAfterTaken ?? null, closed: w?.closed ?? null,
        done: plan.doneCounts?.[id] ?? null, pcClaimed: (plan.pc?.claimed ?? []).includes(id) };
    });
    out.perHeld = perHeld;
    check('held-single-claim', perHeld.every((h) => h.inPlan && h.taken !== null && h.taken <= 1 && h.reopened === 0 && h.closed.length === 1 && h.closed[0] === 'done' && h.done === 1 && !h.pcClaimed), perHeld);

    // 主机失败过的任务(可重试的失败会被重新认领,不影响恰好一次;记下原因备查)
    out.failedEvents = [...hostEvents.values()].slice(-10).map((e) => ({ ...e, sinceCutMs: typeof e.at === 'number' ? e.at - cutAt : null }));

    // 7. 正常退出(放回认领)
    child.send({ type: 'shutdown' });
    out.exitCode = await exited(child, 60_000);
    out.releasedOnExit = exitLine?.released ?? null;
    check('render-host-exit', out.exitCode === 0, { exitCode: out.exitCode, tail: lines.slice(-4) });
  } catch (error) {
    fails.push(`host 出错:${String(error?.message ?? error).slice(0, 600)}`);
    say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
    await put('abort', { reason: `host: ${String(error?.message ?? error).slice(0, 200)}`, at: Date.now() });
  } finally {
    if (child && child.exitCode === null) { killTree(child); await exited(child); }
    if (proxy) { try { proxy.stdin.end(); } catch { /* 已关 */ } killTree(proxy); await exited(proxy, 5000); }
    try { fs.writeFileSync(path.join(OUT, 'render-host.log'), lines.join('\n')); } catch { /* 写不了不影响结论 */ }
    if (proxyLines.length) { try { fs.writeFileSync(path.join(OUT, 'proxy.log'), proxyLines.join('\n')); } catch { /* 同上 */ } }
    if (!KEEP) { try { fs.rmSync(path.join(OUT, 'render-host-data'), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄没放 */ } }
    out.out = OUT;
    try { await c.put(K(run, 'host'), { ...out, ok: fails.length === 0, fails, checks }); } catch (e) { fails.push(`结果交不回协调口:${e?.message ?? e}`); }
  }
}

/* ================================================================== all */

async function runAll(out) {
  if (needHosted() || !COORD) { fails.push('要给 --coord,放云端另要 --hosted'); process.exitCode = 2; return; }
  if (CUT !== 'proxy') { fails.push('--role all 只跑 --cut proxy'); process.exitCode = 2; return; }
  const run = arg('--run', null) ?? newRunId();
  out.run = run;
  const outDir = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-htw-${run}`)));
  const base = Number(arg('--port', DEFAULT_PORT.creator));
  const pass = ['--seconds', '--clips', '--host-concurrency', '--resume-timeout-s', '--timeout-min', '--proxy-target', '--proxy-path', '--lan-ip', '--lan-host'].flatMap((n) => (arg(n, null) !== null ? [n, arg(n)] : []));
  const common = [...(HOSTED ? ['--hosted', HOSTED] : []), '--place', PLACE, '--coord', COORD, '--run', run, ...pass, ...(KEEP ? ['--keep-temp'] : [])];
  const roles = [
    { role: 'creator', args: ['--port', String(base)] },
    { role: 'host', args: ['--port', String(base + 3), '--proxy-port', String(arg('--proxy-port', base + 6)), '--cut', 'proxy'] },
  ];
  const results = await Promise.all(roles.map(({ role, args }) => new Promise((resolve) => {
    const c = spawn(process.execPath, [SELF, '--role', role, ...args, '--out', path.join(outDir, role), ...common], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    let stdout = '';
    c.stdout.on('data', (d) => { stdout += d.toString(); });
    c.stderr.on('data', (d) => process.stderr.write(d));
    c.once('exit', (code) => {
      const last = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
      let line = null;
      try { line = JSON.parse(last); } catch { line = { role, ok: false, fails: [`没有结果行(退出码 ${code})`], checks: [] }; }
      resolve({ role, code, line });
    });
  })));
  for (const r of results) {
    out[r.role] = r.line;
    for (const ch of r.line?.checks ?? []) checks.push({ ...ch, name: `${r.role}:${ch.name}` });
    for (const f of r.line?.fails ?? []) fails.push(`${r.role}: ${f}`);
    if (!r.line?.ok && !(r.line?.fails ?? []).length) fails.push(`${r.role}: 退出码 ${r.code}`);
  }
}

/* ================================================================== 入口 */

const out = { role: ROLE };
if (!['creator', 'host', 'all'].includes(ROLE)) {
  process.stderr.write('用法见文件头:--role creator | host | all --hosted <url> --coord <url>\n');
  process.stdout.write(`${JSON.stringify({ role: ROLE, ok: false, error: 'usage', checks: [], fails: ['--role 取 creator | host | all'] })}\n`);
  process.exitCode = 2;
} else {
  try {
    if (ROLE === 'creator') await runCreator(out);
    else if (ROLE === 'host') await runHost(out);
    else await runAll(out);
  } catch (error) {
    fails.push(`出错:${String(error?.message ?? error).slice(0, 600)}`);
  }
  out.ms = Date.now() - started;
  out.checks = checks;
  out.fails = fails;
  out.ok = fails.length === 0 && checks.length > 0;
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (process.exitCode !== 2) process.exitCode = out.ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 10_000).unref();
}
