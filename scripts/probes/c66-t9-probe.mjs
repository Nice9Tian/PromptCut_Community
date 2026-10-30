/**
 * C6.6 T9 跨机探针(设计稿 `docs/plan/c66-design.md` 第 6 节 T9;主执行计划第 6.5 节 W-T9、第 6.8 节、第 7 节 C6.6)。
 *
 * 三个角色经协调口 KV(`probe-coord.mjs` 的形状)交换配置与结果,不共享文件系统;每个角色可以在不同机器上跑。
 *
 *   node scripts/probes/c66-t9-probe.mjs --role creator | observer | host | all
 *        [--hosted <文档服务基址>]   缺省 https://203-0-113-16.sslip.io/hosted
 *        [--coord <协调口基址>]      缺省 https://203-0-113-16.sslip.io/coord
 *        [--run <本轮 id>]          各角色用同一个;creator 不给就自己生成并写进 KV `c66t9.latest`,另两个不给就从那里取
 *        [--port <编辑器端口>]       单个角色:creator 缺省 5590、observer 5593、host 5596(每个编辑器另占 +1、+2 当舞台端口);
 *                                   --role all:三个角色的端口起点(缺省 5590),三个角色依次用 <端口>、+3、+6
 *        [--port-base <端口>]        只对 --role all,与 --port 同义(集成时两个分支各加了一种写法,都留着);两个都给时以它为准
 *        [--out <截图目录>]          缺省 <系统临时目录>/pc-c66t9-<run>/<角色>
 *        [--timeout-min 25] [--keep-temp]
 *        [--observer-throttle <字节/秒>]  观察端页面加入后用 CDP 限速(舞台 iframe 一并限),复现原尺寸从远端慢慢拉;也可设环境变量 T9_OBSERVER_THROTTLE
 *        [--place cloud | lan]       缺省 cloud(项目在 --hosted 的托管端)。lan = M8-X1(计划 `docs/plan/m8-plan.md` 第 3.1 节「放本机版 T9」):
 *                                   creator 以局域网主机起编辑器 A(`PROMPTCUT_LAN_HOST=1`,绑 0.0.0.0),在本机建局域网模式的项目;
 *                                   observer、host 经局域网发现(`--lan-host <ip:端口>` 手填兜底)凭项目凭证进入。见下文「放本机」
 *        [--lan-ip <PC 局域网地址>]  lan 的 creator:发给另两方的地址,缺省取本机第一块局域网网卡
 *        [--lan-host <ip:端口>]      lan 的 observer / host:发现查不到时手填
 *        [--heavy slow-stepped | pinned]  重卡片段怎么保证「一定判重」(计划第 5 节 L3),缺省 slow-stepped(C10 合入 main 之后,51f01c4):
 *                                   slow-stepped 放 `probe-slow-stepped`(`src/cards/_probe/slow.tsx`:每帧在舞台里烧 40 ms、预渲染间里不烧、
 *                                                `independent`),在哪台机器上都稳定判重,不用钉死;
 *                                   pinned       旧做法,只作对照:放 16 秒 `probe-typewriter`,放卡前按成本记录的「人工钉死」(`pinnedHeavy`)写一条记录
 *
 * ## 放本机(--place lan,M8-X1)与放云端的差别
 *   - 局域网主机就是素材服务所在:页面导入的两档素材直接落在主机本地,没有上传队列(创建者页面就在主机上,素材服务是自己;成员页面按发现通告 / 文档服务地址用主机的素材服务,见 claude/lan-asset),
 *     所以没有「暂停上传 / 续传」那一段:creator 改为核主机上两档都 complete、字节与哈希相符;observer 的「出第一帧时原尺寸还在路上」
 *     与「换档属于覆盖情形」两条不判(只记 `swapMode`),其余先小后大的断言照判(页面还没问过素材服务时先给小尺寸);
 *   - 局域网主机不经 service.endpoints 登记素材服务(`vite-plugin-media.ts` 只在设了 PROMPTCUT_DOCSERVICE_URL 时登记):
 *     探针自己的连接取不到登记时按文档服务地址推 `http://<主机>/api/asset`(同 `vite-plugin-frames.ts` 的 hostAssetClient);
 *   - 跨机:PC 跑 creator,笔记本跑 observer 与 host,协调口用 PC 局域网上的 probe-coord(全程不连阿里云):
 *       PC:    node scripts/probes/probe-coord.mjs serve --host 0.0.0.0 --port 5789
 *              node scripts/probes/c66-t9-probe.mjs --role creator --place lan --coord http://<PC 局域网地址>:5789 --port 5780 --run <id>
 *       笔记本: node scripts/probes/c66-t9-probe.mjs --role observer --place lan --coord http://<PC 局域网地址>:5789 --port 5590 --run <id>
 *              node scripts/probes/c66-t9-probe.mjs --role host --place lan --coord http://<PC 局域网地址>:5789 --port 5583 --run <id>
 *
 * 环境变量:协调口开了信箱时 KV 要 `PROBE_MAIL_TOKEN`(`coordClient` 自动带,令牌不打印)。云端跑 host 另要
 * `NODE_USE_ENV_PROXY=1`、`PC_CHROME_ARGS=--no-sandbox`(脚本不管,原样传给子进程)。
 * `PC_CHROME_ARGS` 只把参数原样透传给探针起的 Chrome(典型用途:云端 Linux 以 root 运行要 `--no-sandbox`);不要用它关 TLS 校验(如 `--ignore-certificate-errors`),否则对远端站点的探针在证书有问题时照样通过,掩盖真问题。
 * 输出:过程写 stderr(一行一条 JSON);stdout 最后一行是一行 JSON `{ role, ok, fails: [], … }`,`ok` 为假退出码 1。
 * 口令只进 KV(`c66t9.<run>.config`)与各角色临时目录里的配置文件,不进 stdout / stderr。
 *
 * ## KV 键(`c66t9.<run>.<名>`)
 *   config          creator → observer、host:托管地址、项目名与 id、成员口令、两档哈希、卡片 key、v1 / v2 记号、v1 源码……
 *   observer.small  observer → creator:小尺寸出画面并稳定了(或没出小尺寸);creator 收到才续传原尺寸
 *   resumed         creator → observer:续传的时刻(观察端出第一帧时它还不该在)
 *   host.ready      host → creator:主机起来了(creator 等它才加重卡片段、发布预渲染任务)
 *   plan            creator → host:这一版 plan 的细任务 id、每个任务收到 task.done 的次数、本机节点做了哪些
 *   editready       creator → observer:可以改卡了(plan 落定之后)
 *   observer.joined observer → creator:观察端进了项目、换档断言做完、第一轮测量测完;creator 收到就改卡
 *   edited          creator → observer:改卡的回包(只作记录)
 *   observer / host 两个角色的结果;creator 自己的汇总写 `creator`
 *   abort           creator 出错时写,另两个角色看到就收尾
 *
 * ## --role creator(主会话所在的 PC)
 *   1. 在托管端建一个自由进入的共享项目(随机项目名、项目口令、创建者口令);探针用户卡(直绘,画面写着记号 v1)写进
 *      本检出的 `src/cards/user/`(同 card-sync-probe;收尾删掉并还原 `_scopes.json`);
 *   2. 起编辑器 A(本检出根,数据目录、改动层、临时目录都在临时目录里),队列模式:`PROMPTCUT_QUEUE_NODE=1`、
 *      `PROMPTCUT_SHARED_CONFIG` 指向以创建者身份、`role: 'render'` 连这个项目的配置 —— 预渲染进程是发布方的本机节点;
 *   3. 页面新建项目、放一个用户卡片段,以创建者身份进入共享项目(`syncManager.enterShared`);
 *      等页面把托管端素材服务交给上传队列(`GET /api/media/upload-queue` 的 `target.base`);
 *   4. ffmpeg 现场生成 1920×1080、30 fps、6 s、顶上一条 10 格帧号条纹、条纹以下铺随机噪声、定码率 56 Mbit/s 的测试视频
 *      (约 44 MB,按素材服务 8 MiB 一片至少 4 片;moov 在尾),经素材库的文件输入(页面导入路径,`?tiers=1`)导入;
 *      小尺寸一在托管端 complete(编辑器日志的 `upload.tier-done` 或 `chunks`),就经编辑器进程的
 *      `POST /api/media/upload-queue/target { base: null }` 暂停上传队列,核对原尺寸没 complete、1.5 s 后仍没 complete、
 *      素材还在队里(正在传的那一片会回 401,队列记一次 `upload.retry`,不丢);
 *   5. 写 KV `config`(带暂停的时刻与原尺寸已到的片数),放观察端进来;后台等观察端 KV `observer.small`(小尺寸出画面并稳定),
 *      再驱动页面自己的 `startUploadTarget`(进入共享项目时 `connectSharedAssets` 调的那个,在同一条连接上签 rw 素材票据)
 *      把上传目标交回编辑器进程,写 KV `resumed`;等原尺寸 complete、上传队列清空,核对日志先小后大、续传时小尺寸一片没重发、
 *      托管端两档字节与哈希相符。与此同时:等 host 报 `host.ready`;等页面测量空闲,按成本记录的「人工钉死」(`pinnedHeavy`)给重卡片段的身份
 *      写一条记录(device 串取页面自己写过的用户卡记录上的那个),等预渲染进程也收到;再加重卡片段(16 秒 `probe-typewriter`,
 *      审阅过的独立推帧卡、共享档,参数带本轮的盐,结果键全新)。实测判重在机器忙闲之间会翻(见 AGENT-c66-t9-fix 报告),
 *      钉死之后两端都判重,预渲染集合里一定有它;
 *      等页面触发的 preload 发布 plan、切出的细任务全部落定、清单拉完,写 KV `plan`、`editready`;
 *   6. 等观察端 `observer.joined`,把用户卡的记号从 v1 改成 v2(`/api/cards/edit`),写 KV `edited`;
 *   7. 等 observer、host 的结果,汇总;收尾:经创建者操作 `delete` 删掉托管端这个项目,结束自己起的进程树。
 *
 * ## --role observer(笔记本辅助节点,或本机替身)
 *   从 KV 取配置;起编辑器 B,环境里删掉 `PROMPTCUT_QUEUE_NODE`、`PROMPTCUT_SHARED_CONFIG`(结果里记下两者为空,
 *   并记 B 的 `GET /api/frames/queue`);页面以成员身份进入;断言:
 *   - 出第一帧时原尺寸还在路上:`config.pause` 说创建方暂停时原尺寸没 complete,且此刻 KV 里还没有 `resumed`;
 *     小尺寸稳定(或没出小尺寸)后写 KV `observer.small`,创建方收到才续传;换档因此必属「覆盖」情形(断言 `swapMode`);
 *   - 素材层先以素材小尺寸出现:可见舞台里**显示着的** `<video>` 第一次解出画面时,来源是小尺寸哈希;
 *     播放头停在 2.5 s,读顶上条纹的帧号(tier-switch-probe 的读法),稳定后记下;素材原尺寸到齐后换成原尺寸,
 *     换档后同一时刻的帧号与换档前相差不超过一帧;换档期间逐帧(rAF)采样没有黑帧;
 *     两档在加入前都已传完时页面第一次轮询就换档(「快换」:换档间隔短于一个采样间隔),小尺寸取不到稳定帧号就用它第一次
 *     出画面时的帧号,采样也不要求落上小尺寸样本(先小后大由 firstShown 与之后的换档保证);否则(「覆盖」)采样须覆盖换档前后。
 *     结果里 `swapMode` 记是哪一种;
 *   - 等第一轮测量测完,拿到 `editready` 后开始计时并写 `observer.joined`;creator 改卡之后 B 在 5 s 内装上 v2
 *     (`/api/cards/source`),并在 5 s 内重测(card-sync-probe 的判据:身份键变了,且测量遮罩出现过或成本表里有了新键的记录)。
 *     计时起点早于 creator 真正改卡(多算了一次 KV 往返与 creator 的反应时间),所以测出来的是上界;
 *   - 结果写 KV `observer`。
 *
 * ## --role host(笔记本辅助节点、云端或本机替身)
 *   从 KV 取配置,写一份共享项目配置(`role: 'render'`、成员口令),起 `cloud/scripts/render-host.mjs --config … --port …`
 *   (IPC);起来后写 `host.ready`;等 KV `plan`;核对:本主机认领数、完成数(`GET /api/frames/queue`),每个细任务
 *   恰好一次 task.done(creator 在 plan 里给的计数),每个快照细任务的清单都在托管端内容库、清单里的每个块都在托管端
 *   素材服务(`has`,带只读票据);经 IPC `shutdown` 正常退出(放回认领),记退出码。结果写 KV `host`。
 *   主机**不再**往本检出里预写探针用户卡(c66-host-cards):代码版本不含用户卡,用到用户卡的任务另标卡片代码身份,
 *   主机经内容库 `card-source` 自己同步(`render-host-contract.md` 第 7 节)。另断言:主机的卡片同步记下了探针卡
 *   (`GET /api/frames/queue` 的 `cardSync`);主机的代码版本与创建者的相同;创建者改卡之后(观察端走到那一步时)
 *   主机 15 s 内装上 v2(记账 rev ≥ 2,生效内容带 v2 记号,在主机自己的改动层里;本检出里原来有这张卡时底版不动)。
 *   主机有改动层(数据目录下的 `card-overrides`),卡片改动层修复(`claude/card-overlay`)之后同步来的新卡只进改动层、
 *   不写检出目录:本检出里原来没有这张卡(跨机)时,另断言检出目录里没有多出它;收尾照旧只删本探针写过的。
 *
 * ## --role all(本机替身,主执行计划 6.8 节)
 *   同一台机器上各起一个子进程跑三个角色(端口缺省 5590 / 5593 / 5596,起点用 --port 或 --port-base 改),汇总三行结果。
 *
 * 本机自测:先起临时托管组合(只绑 127.0.0.1)与临时协调口,例如
 *   PROMPTCUT_DATA_DIR=<临时目录> PROMPTCUT_DOCSERVICE_HOST=127.0.0.1 PROMPTCUT_DOCSERVICE_PORT=8794 PROMPTCUT_ASSET_PORT=8795 \
 *     PROMPTCUT_TRUST_LOOPBACK=0 PROMPTCUT_CLUSTER_TOKEN=<32～256 个 base64url 字符> node server/hosted/main.mjs
 *   （本机信任关掉时必须有集群令牌，`docs/plan/http-transport-contract.md` 第 10 节；令牌的生成方法见 server/docservice/main.mjs 文件头）
 *   PROBE_MAIL_TOKEN=<≥16 字符> node scripts/probes/probe-coord.mjs serve --port 8796
 *   PROBE_MAIL_TOKEN=<同上> node scripts/probes/c66-t9-probe.mjs --role all --hosted http://127.0.0.1:8794 --coord http://127.0.0.1:8796
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawn, spawnSync, fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROLE = arg('--role', null);
const HOSTED = String(arg('--hosted', 'https://203-0-113-16.sslip.io/hosted')).replace(/\/+$/, '');
const COORD = String(arg('--coord', 'https://203-0-113-16.sslip.io/coord')).replace(/\/+$/, '');
const TIMEOUT_MS = Number(arg('--timeout-min', 25)) * 60_000;
const KEEP = argv.includes('--keep-temp');
/** 观察端浏览器限速(字节 / 秒;0 = 不限):复现「原尺寸从远端慢慢拉」,CDP `Network.emulateNetworkConditions`,舞台 iframe 一并限 */
const OBSERVER_THROTTLE = Math.max(0, Number(arg('--observer-throttle', process.env.T9_OBSERVER_THROTTLE ?? 0)) || 0);
const DEFAULT_PORT = { creator: 5590, observer: 5593, host: 5596 };
/** 放法:cloud(托管端)| lan(M8-X1,creator 当局域网主机) */
const PLACE = arg('--place', 'cloud');
/** 重卡片段的保证方式(计划第 5 节 L3):slow-stepped(确定判重的探针卡,缺省)| pinned(人工钉死,旧做法) */
const HEAVY_MODE = arg('--heavy', 'slow-stepped');
const FPS = 30;
const SEEK = 2.5;
const EXPECT_IDX = Math.round(SEEK * FPS);
/**
 * 重卡片段:审阅过的独立推帧卡(共享档)。pinned:16 秒 probe-typewriter,放卡前按成本记录的人工钉死写成重卡(见 runCreator 第 5 步);
 * slow-stepped:probe-slow-stepped(C10 集成分支的探针卡,舞台里每帧烧 burnMs,在哪台机器上都判重),不用钉死
 */
const HEAVY = HEAVY_MODE === 'slow-stepped' ? { cardId: 'probe-slow-stepped', seconds: 16, burnMs: 40 } : { cardId: 'probe-typewriter', seconds: 16 };
const started = Date.now();
const deadline = started + TIMEOUT_MS;

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 400)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), role: ROLE, step, ...fields })}\n`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const newRunId = () => `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const K = (run, name) => `c66t9.${run}.${name}`;

/** 轮询到 fn 回真;超时记一条失败、回 null */
async function until(label, fn, timeoutMs, everyMs = 200) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { fails.push(`超时:${label}`); return null; }
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
const getJson = async (url, timeoutMs = 10_000) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return r.json();
};
const postJson = async (url, body, timeoutMs = 30_000) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** 编辑器子进程的环境:不带集群令牌、不连外面的文档服务、不起队列节点(creator 另加),数据与临时目录都在 dir 下 */
function editorEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_NODE_PROFILE', 'PROMPTCUT_SHARED_CONFIG',
    'PROMPTCUT_HOST_MAX_CONCURRENT', 'PROMPTCUT_TEST_CODE_VERSION', 'PROMPTCUT_PUSH', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL',
    'PROMPTCUT_CARD_SYNC', 'PROMPTCUT_LAN_HOST']) delete env[key];
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data'), path.join(dir, 'card-overrides')]) fs.mkdirSync(d, { recursive: true });
  return {
    ...env, PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    // This probe counts only the explicitly configured creator and render host.
    // The observer must not create an additional automatic desktop render node.
    PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_STREAMS: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...extra,
  };
}

const children = [];
/** 起一个编辑器;`lanHost` 为真时不给 --host(环境里的 PROMPTCUT_LAN_HOST=1 让 vite.config 绑 0.0.0.0,当局域网主机) */
async function startEditor(label, port, env, { lanHost = false } = {}) {
  for (const p of [port, port + 1, port + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  const child = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', ...(lanHost ? [] : ['--host', '127.0.0.1'])],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  children.push(child);
  const log = [];
  let partial = '';
  const keep = (c) => {
    const lines = (partial + c.toString()).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) { log.push(line); if (log.length > 6000) log.shift(); }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  say('editor.spawn', { label, pid: child.pid, port });
  const up = await until(`[${label}] 编辑器起来`, async () => {
    if (child.exitCode !== null) throw new Error('exited');
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 240_000, 500);
  if (!up) throw new Error(`编辑器 ${label} 没起来:${log.slice(-10).join(' | ').slice(0, 600)}`);
  const ed = { label, origin, port, child, log };
  editors.push(ed);
  return ed;
}
const editors = [];
/** 收尾时把编辑器输出(含预渲染进程)存到截图目录,排障用 */
function saveEditorLogs(dir) {
  for (const ed of editors) { try { fs.writeFileSync(path.join(dir, `${ed.label}-editor.log`), ed.log.join('\n')); } catch { /* 写不了不影响结论 */ } }
}

/* ------------------------------------------------------------------ 文档服务连接(Node 侧) */

async function mods() {
  const [route, client, shared, link, endpoint, ticket, asset] = await Promise.all([
    import('../../server/auth/route.mjs'), import('../../server/auth/client.mjs'), import('../../server/auth/shared-config.mjs'),
    import('../../server/render-node/session-link.mjs'), import('../../server/render-node/endpoint.mjs'),
    import('../../server/auth/ticket-source.mjs'), import('../../server/asset-store/client.mjs'),
  ]);
  // route 与 client 都导出 createSharedProject:要 route 的那个(按 where 分派)
  return { ...client, ...route, ...shared, ...link, ...endpoint, ...ticket, ...asset, createSharedProject: route.createSharedProject };
}

/** 请求 / 回包按 reqId 配对(同 shared-project-probe) */
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
    const reqId = `t9-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`等 ${message.type} 的回包超时`)); }, timeoutMs);
    waiting.set(reqId, { resolve, timer });
    if (!ep.send({ ...message, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error(`${message.type} 没发出去`)); }
  });
}

/**
 * 以某个身份连上项目(page 角色):回 { ep, rpc, assetUrl, client(只读或读写票据的素材客户端), close }。
 * 连接是一个会话(HT-a,`createDocEndpoint`,同 render-host-probe.mjs 与编辑器页面):单次传输中断在保留期内接续。
 * 素材服务地址从 service.endpoints 取;局域网主机不登记(只在设了 PROMPTCUT_DOCSERVICE_URL 时登记),取不到就按文档服务地址推
 * `http://<主机>/api/asset`(同 vite-plugin-frames.ts 的 hostAssetClient:局域网模式的素材服务与文档服务在同一个进程)。
 */
async function openConn(M, { url, projectId, username, password, as = 'member', tag }) {
  const entry = M.normalizeEntry({ url, projectId, username, password, as, role: 'page', deviceId: `c66t9-${tag}-${randomBytes(6).toString('hex')}`, deviceName: `c66-t9-probe ${tag}` });
  const ep = M.createDocEndpoint({ url: entry.url, protocols: M.sharedProtocols(entry, { role: 'page' }), log: () => {} });
  const opened = await new Promise((resolve) => {
    if (ep.connected) return resolve(true);
    const t = setTimeout(() => resolve(false), 20_000);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
  if (!opened) { try { ep.close(); } catch { /* 没连上 */ } throw new Error(`${tag} 连不上文档服务`); }
  const announced = await new Promise((resolve) => {
    const t = setTimeout(() => { stop(); resolve(null); }, PLACE === 'lan' ? 5_000 : 15_000);
    const stop = M.watchServiceEndpoints(ep, ['asset'], (list) => {
      const u = list.find((e) => e.kind === 'asset' && Array.isArray(e.urls) && e.urls.length)?.urls[0];
      if (u) { clearTimeout(t); stop(); resolve(u); }
    });
  });
  const derived = (() => { try { const u = new URL(entry.url); return `${/^(wss|https):/.test(u.protocol) ? 'https:' : 'http:'}//${u.host}/api/asset`; } catch { return null; } })();
  const assetUrl = announced ?? (PLACE === 'lan' ? derived : null);
  const rpc = rpcOn(ep);
  const client = (access = 'r', opts = {}) => M.createAssetClient({ base: assetUrl, ticket: M.createTicketSource(ep, { access }), ...opts });
  const close = async () => {
    const closed = ep.connected ? new Promise((r) => ep.onClose(r)) : Promise.resolve();
    try { ep.close(); } catch { /* 已关 */ }
    await Promise.race([closed, delay(3000)]);
  };
  return { ep, rpc, assetUrl, client, close };
}

/**
 * 放本机:经局域网发现按项目名找局域网主机(--lan-host 手填兜底),回 { base(ws 基址), discovery };查不到回 creator 给的地址,
 * discovery.found 为假(调用方记一条失败)
 */
async function discoverLanBase(M, cfg) {
  const { discoverLan } = await import('../../server/lan/discovery.mjs');
  const t0 = Date.now();
  const manual = arg('--lan-host', null);
  const found = await M.findSharedProject({ name: cfg.name, hostedUrl: null, lan: { discover: discoverLan, manual: manual ? [manual] : [] } })
    .catch((e) => ({ candidates: [], errors: [{ message: String(e?.message ?? e) }] }));
  const hit = found.candidates.find((x) => x.where === 'lan' && x.projectId === cfg.projectId) ?? null;
  const discovery = { found: !!hit, ms: Date.now() - t0, via: hit?.via ?? null, firstSeenMs: hit?.firstSeenMs ?? null, base: hit?.base ?? null, errors: (found.errors ?? []).slice(0, 3) };
  return { base: hit ? M.wsBaseOf(hit.base) : cfg.ws, candidateBase: hit?.base ?? cfg.base, discovery };
}

/* ------------------------------------------------------------------ 探针用户卡 */

const cardSource = (cardId, mark) => `import "../../kernel/remotionStyle";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 160, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 64, color: "#fff", background: "#224" }}>{"${mark}"} {params.text}</div>;
}
export const c66t9Probe: CardDef<Params> = {
  id: "${cardId}", name: "T9 探针", description: "c66-t9-probe", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;

/** 本检出里探针卡的底版与 _scopes.json:开跑时记下,收尾时只删自己写的、还原归属表 */
function repoCard(cardRel) {
  const abs = path.join(ROOT, cardRel);
  const scopes = path.join(ROOT, 'src', 'cards', 'user', '_scopes.json');
  const scopesBefore = fs.existsSync(scopes) ? fs.readFileSync(scopes) : null;
  const existedBefore = fs.existsSync(abs);
  let wrote = false;
  return {
    abs, existedBefore,
    write(source) { fs.writeFileSync(abs, source); wrote = true; },
    cleanup(cardId) {
      if (wrote || !existedBefore) { try { fs.rmSync(abs, { force: true }); } catch { /* 没有就算了 */ } }
      try {
        const hist = path.join(ROOT, '.pc-work', 'card-history');
        for (const f of fs.existsSync(hist) ? fs.readdirSync(hist) : []) if (f.startsWith(`${cardId}.`)) fs.rmSync(path.join(hist, f), { force: true });
      } catch { /* 清不掉不影响结论 */ }
      try {
        const now = fs.existsSync(scopes) ? fs.readFileSync(scopes) : null;
        if (scopesBefore === null && now !== null) fs.rmSync(scopes, { force: true });
        else if (scopesBefore !== null && (now === null || !now.equals(scopesBefore))) fs.writeFileSync(scopes, scopesBefore);
      } catch { /* 同上 */ }
    },
  };
}

/* ------------------------------------------------------------------ KV */

function kv(run) {
  const c = coordClient(COORD);
  return {
    put: (name, value) => c.put(K(run, name), value),
    get: (name, waitMs = 0) => c.get(K(run, name), waitMs),
    /** 等到 name 出现;期间 creator 写了 abort 就抛错 */
    async wait(name, label, ms = TIMEOUT_MS) {
      const end = Math.min(Date.now() + ms, deadline);
      while (Date.now() < end) {
        let v = null;
        try { v = await c.get(K(run, name), Math.min(10_000, Math.max(1, end - Date.now()))); } catch { await delay(1000); }
        if (v !== null) return v;
        let a = null;
        try { a = await c.get(K(run, 'abort'), 0); } catch { /* 下一轮再看 */ }
        if (a !== null && name !== 'abort') throw new Error(`creator 已中止:${a.reason ?? ''}`);
      }
      throw new Error(`等 KV ${name}(${label})超时`);
    },
  };
}

/** --run 没给:creator 生成;另两个从 KV `c66t9.latest` 取(10 分钟内写的) */
async function resolveRun(role) {
  const given = arg('--run', null);
  if (given) {
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(given)) throw new Error('--run 要 1～24 个 [A-Za-z0-9_-]');
    return given;
  }
  const c = coordClient(COORD);
  if (role === 'creator') {
    const run = newRunId();
    await c.put('c66t9.latest', { run, at: Date.now() });
    return run;
  }
  for (;;) {
    const v = await c.get('c66t9.latest', 10_000).catch(() => null);
    if (v?.run && Date.now() - (v.at ?? 0) < 10 * 60_000) return v.run;
    if (Date.now() > deadline) throw new Error('KV 里没有本轮 id(c66t9.latest)');
    await delay(2000);
  }
}

/* ------------------------------------------------------------------ 页面小件 */

async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  return puppeteer.launch({
    headless: true, protocolTimeout: 300_000, defaultViewport: { width: 1440, height: 900 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])],
  });
}
const P = (page, fn, ...a) => page.evaluate(fn, ...a);

async function openEditorPage(browser, origin, label, pageErrors) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { pageErrors.push(String(e?.message ?? e).slice(0, 300)); say('pageerror', { label, message: String(e?.message ?? e).slice(0, 300) }); });
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(`${origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const online = await until(`[${label}] 页面同步接上`, () => P(page, () => !!window.__pcSyncTest && window.__pcSyncTest.view().status === 'online'), 180_000, 500);
  if (!online) throw new Error(`${label} 页面没接上同步`);
  await until(`[${label}] 页面舞台起来、测量遮罩退下`, () => P(page, () => document.querySelectorAll('iframe').length >= 2 && !document.querySelector('[data-pc="probe-gate"]')), 300_000, 500);
  // iframe 存在时其入口模块可能还在加载，卡片 HMR 回调尚未注册。
  // 各舞台完成握手后再进入共享项目，避免同步源码的首轮更新被启动中的舞台漏接。
  const stagesReady = await until(`[${label}] 两个舞台完成实际握手`, () => P(page, () => {
    const d = window.__pcPreviewDiag?.();
    return !!d?.hostCaps?.A && !!d?.hostCaps?.B;
  }), 180_000, 100);
  if (!stagesReady) throw new Error(`${label} 两个舞台没有完成握手`);
  await P(page, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  return page;
}

/** 等页面的探针测量连续 1.5 s 空闲(同 card-sync-probe) */
async function waitProbeIdle(page, label) {
  let idleSince = null;
  return until(`[${label}] 测量测完`, async () => {
    const idle = await P(page, async () => {
      const R = await import('/src/editor/probeRunner.ts');
      return !R.probeProgress().running && !document.querySelector('[data-pc="probe-gate"]');
    }).catch(() => false);
    if (!idle) { idleSince = null; return false; }
    idleSince ??= Date.now();
    return Date.now() - idleSince >= 1500;
  }, 300_000, 250);
}

/* ================================================================== creator */

async function runCreator(out) {
  const M = await mods();
  const run = await resolveRun('creator');
  out.run = run;
  const store = kv(run);
  const port = Number(arg('--port', DEFAULT_PORT.creator));
  const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-c66t9-${run}`, 'creator')));
  fs.mkdirSync(OUT, { recursive: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c66t9-creator-'));
  out.port = port;
  out.place = PLACE;
  out.heavyMode = HEAVY_MODE;
  const lan = PLACE === 'lan';
  const lanIp = lan ? (arg('--lan-ip', null) ?? (await import('../../server/lan/discovery.mjs')).selectInterfaces()[0]?.address ?? null) : null;
  if (lan && !lanIp) throw new Error('放本机要有局域网地址(--lan-ip)');
  // 成员(观察端、主机、本探针的检查连接)用 wsBase;创建者自己的节点、建项目、删项目用 selfWs(放本机时走回环:只有回环能建)
  const wsBase = lan ? `ws://${lanIp}:${port}/docservice` : M.wsBaseOf(HOSTED);
  const selfWs = lan ? `ws://127.0.0.1:${port}/docservice` : wsBase;
  const httpBase = lan ? `http://${lanIp}:${port}` : M.httpBaseOf(wsBase);
  out.hosted = httpBase;
  out.lanIp = lanIp;
  const CARD_ID = `c66t9-${run.toLowerCase()}`;
  const CARD_REL = `src/cards/user/${CARD_ID}.tsx`;
  const MARK = (v) => `T9-${run}-${v}`;
  const card = repoCard(CARD_REL);
  let browser = null;
  let conn = null;
  let shared = null;
  let creatorPw = null;
  const pageErrors = [];
  try {
    if (!lan) {
      const health = await getJson(`${httpBase}/healthz`).catch((e) => ({ error: String(e?.message ?? e) }));
      if (!check(health?.ok, '托管端 /healthz', health)) throw new Error('托管端不通');
    }

    // ---- 1. 测试视频:1280×720 画帧号条纹(tier-switch-probe 的画法),最近邻放大到 1920×1080;moov 在尾
    const { findFfmpeg } = await import('../../server/bakery/ffmpeg.mjs');
    const ffmpeg = await findFfmpeg();
    const video = path.join(TMP, `t9-${run}.mp4`);
    // 条纹以下铺随机噪声、定码率 56 Mbit/s:原尺寸约 44 MB,按素材服务 8 MiB 一片至少 4 片,续传时「原尺寸还在路上」有足够的窗口
    const ff = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=1280x720:r=${FPS}:d=6`,
      '-vf', "geq=lum='if(lt(Y,96),255*mod(floor(N/pow(2,floor(X/128))),2),40+176*random(1))':cb=128:cr=128,scale=1920:1080:flags=neighbor",
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '56M', '-maxrate', '60M', '-bufsize', '60M', '-g', '60', '-pix_fmt', 'yuv420p', '-metadata', `comment=c66t9-${run}`, video], { encoding: 'utf8', windowsHide: true });
    if (ff.status !== 0) throw new Error(`ffmpeg 失败:${ff.stderr}`);
    const videoBytes = fs.readFileSync(video);
    out.video = { name: path.basename(video), bytes: videoBytes.length, sha: sha256(videoBytes).slice(0, 12), size: '1920x1080', fps: FPS, seconds: 6 };

    // ---- 2. 探针卡、编辑器 A(发布方;放本机时是局域网主机)、共享项目。共享项目配置在第一次打 /api/frames/* 时才读:先起编辑器、后写
    creatorPw = randomBytes(12).toString('base64url');
    const projectPw = randomBytes(12).toString('base64url');
    const name = `c66t9-${run}`;
    card.write(cardSource(CARD_ID, MARK('v1')));
    const creatorConfig = path.join(TMP, 'creator-shared.json');
    const A = await startEditor('creator', port, editorEnv(path.join(TMP, 'editor'), {
      PROMPTCUT_QUEUE_NODE: '1', PROMPTCUT_SHARED_CONFIG: creatorConfig,
      PROMPTCUT_DEVICE_ID: `c66t9-a-${run}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'c66-t9 creator',
      ...(lan ? { PROMPTCUT_LAN_HOST: '1' } : {}),
    }), { lanHost: lan });
    if (lan && !(await until('[creator] 局域网主机的文档服务起来', async () => (await fetch(`${A.origin}/api/docservice/healthz`, { signal: AbortSignal.timeout(3000) })).ok || null, 120_000, 500))) {
      throw new Error('局域网主机的文档服务没起来');
    }
    shared = await M.createSharedProject({ where: lan ? 'lan' : 'hosted', ...(lan ? { lanBase: selfWs } : { hostedUrl: wsBase }), name, mode: 'free', creator: { username: 'creator', password: creatorPw }, password: projectPw });
    out.projectId = shared.projectId;
    out.projectName = name;
    say('project.created', { projectId: shared.projectId, name, place: PLACE });
    fs.writeFileSync(creatorConfig, JSON.stringify([{ url: selfWs, projectId: shared.projectId, username: 'creator', password: creatorPw, as: 'creator', role: 'render',
      deviceId: `c66t9-pcnode-${run}`.padEnd(16, '0'), deviceName: 'c66-t9 creator node' }]));
    const prerender = await until('[creator] 预渲染进程就绪', async () => {
      const info = await getJson(`${A.origin}/api/prerender/info`, 3000);
      return info?.ready && info.url ? info.url : null;
    }, 240_000, 500);
    if (!prerender) throw new Error('预渲染进程没起来');
    const diag = async () => (await getJson(`${prerender}/api/frames/diagnostics`, 20_000))?.queue ?? null;

    // ---- 3. 页面:新项目 + 用户卡片段,以创建者进入
    browser = await launchBrowser();
    const page = await openEditorPage(browser, A.origin, 'creator', pageErrors);
    await until('[creator] 页面认出探针卡', () => P(page, async (id) => (await import('/src/kernel/registry.ts')).getCard(id) != null, CARD_ID), 30_000);
    const userClip = await P(page, async (id, projName) => {
      const S = await import('/src/store/project.ts');
      S.actions.newProject(projName);
      const t = S.actions.addTrack('T9 用户卡');
      const c = S.actions.addCardClip(id, 0, { trackId: t.id, duration: 6 });
      S.actions.seek(0);
      return c?.id ?? null;
    }, CARD_ID, name);
    if (!userClip) throw new Error('没放上用户卡片段');
    out.userClip = userClip;
    // 记下页面进入共享项目时拿来取素材服务登记的那条连接(connectSharedAssets 用它 service.watch),续传时用同一条连接签票据
    await P(page, async () => {
      const L = await import('/src/editor/sync/link.ts');
      const proto = L.SyncLink.prototype;
      if (proto.__t9Wrapped) return;
      const orig = proto.request;
      proto.request = function (msg, ...rest) { if (msg?.type === 'service.watch') window.__t9AssetLink = this; return orig.call(this, msg, ...rest); };
      proto.__t9Wrapped = true;
    });
    // This is the fixture's creation step, distinct from the observer's later entry.
    const entered = await P(page, async (candidate, cred) => (await import('/src/editor/sync/syncManager.ts')).enterShared(candidate, cred, { initialize: true }),
      { where: shared.where, base: shared.base, projectId: shared.projectId, name: shared.name, mode: shared.mode }, { as: 'creator', username: 'creator', password: creatorPw });
    if (!entered?.ok) throw new Error(`创建者进不去共享项目:${JSON.stringify(entered)}`);
    const pushed = await until('[creator] 用户卡传上内容库', async () => {
      const s = await getJson(`${A.origin}/api/cards/sync/status`);
      return s.projectId === shared.projectId && s.connected && s.records?.[CARD_REL]?.rev >= 1 ? s.records[CARD_REL] : null;
    }, 30_000, 300);
    out.cardPushedRev = pushed?.rev ?? null;
    // 托管端连接(创建者,page 角色):素材服务地址、票据、chunks
    conn = await openConn(M, { url: wsBase, projectId: shared.projectId, username: 'creator', password: creatorPw, as: 'creator', tag: 'creator-check' });
    out.assetUrl = conn.assetUrl;
    if (!check(conn.assetUrl, lan ? '[creator] 拿到局域网主机的素材服务地址(按文档服务地址推)' : '[creator] 从 service.endpoints 拿到托管端素材服务地址')) throw new Error('没有素材服务地址');
    // 放本机:素材就在本机,页面挑不到别处的素材服务、不设上传目标
    const target = lan ? null : await until('[creator] 页面把托管端素材服务交给上传队列', async () => {
      const q = await getJson(`${A.origin}/api/media/upload-queue`);
      return q?.target?.base && q.target.base.replace(/\/+$/, '') === conn.assetUrl.replace(/\/+$/, '') ? q.target : null;
    }, 30_000, 300);
    out.uploadTarget = target?.base ?? null;

    // ---- 4. 经素材库的文件输入导入(页面导入路径,?tiers=1)
    const input = await page.$('[data-pc="library"] input[type=file]');
    if (!input) throw new Error('页面上找不到素材库的文件输入');
    const tImport = Date.now();
    await input.uploadFile(video);
    const media = await until('[creator] 素材入库(tiers.original)', () => P(page, async (fname) => {
      const S = await import('/src/store/project.ts');
      const m = S.getState().project.media.find((x) => x.name === fname && x.hash && x.tiers?.original);
      return m ? { id: m.id, hash: m.hash, original: m.tiers.original } : null;
    }, path.basename(video)), 120_000, 300);
    if (!media) throw new Error('素材没入库');
    out.importMs = Date.now() - tImport;
    // 边传边盯(T9 要验「观察端加入时原尺寸还在路上」):小尺寸一在托管端 complete,就经编辑器进程的
    // `POST /api/media/upload-queue/target { base: null }` 暂停上传队列(设计稿第 9 节第 1 条:目标为空时队列暂停、不丢),
    // 核对原尺寸还没 complete 再放观察端进来;观察端报小尺寸出画面并稳定之后,由页面把上传目标重新交给编辑器进程,
    // 原尺寸续传到 complete。小尺寸的哈希从编辑器的两档登记(`/api/media/tiers`)取;「小尺寸传完」按编辑器日志的
    // `upload.tier-done`(比轮询 chunks 早)或 chunks 的 complete,谁先到算谁
    const cli = conn.client('r');
    const firstComplete = { small: null, original: null };
    let smallHash = null;
    let smallState = null;
    let polls = 0;
    const smallDoneInLog = () => A.log.some((line) => line.includes('[media-tiers] upload.tier-done') && line.includes('"tier":"small"') && line.includes(media.original));
    const smallUp = await until('[creator] 素材小尺寸生成并传到托管端', async () => {
      if (!smallHash) {
        const t = await getJson(`${A.origin}/api/media/tiers?hashes=${media.original}`).catch(() => null);
        smallState = t?.items?.[media.original]?.state ?? smallState;
        smallHash = t?.items?.[media.original]?.small ?? null;
      }
      polls++;
      if (!smallHash) return null;
      if (smallDoneInLog()) return 'log';
      return (await cli.chunks('media', smallHash).catch(() => null))?.complete ? 'chunks' : null;
    }, 360_000, 20);
    if (!smallUp) throw new Error('素材小尺寸没传到托管端');
    const tPause = Date.now();
    if (lan) {
      // 放本机:局域网主机就是素材服务所在,导入即落地、没有上传队列,不暂停也不续传;只核两档在主机上的状态
      const [cs0, co0] = await Promise.all([cli.chunks('media', smallHash).catch(() => null), cli.chunks('media', media.original).catch(() => null)]);
      if (cs0?.complete) firstComplete.small = tPause;
      out.pause = { skipped: 'lan', at: tPause, via: smallUp, chunkSize: cs0?.chunkSize ?? null, smallComplete: cs0?.complete === true, originalComplete: co0?.complete === true };
      check(out.pause.smallComplete, '[creator] 局域网主机上素材小尺寸已 complete', out.pause);
    } else {
      const pausePost = await postJson(`${A.origin}/api/media/upload-queue/target`, { base: null });
      say('upload.paused', { via: smallUp });
      const [cs0, co0] = await Promise.all([cli.chunks('media', smallHash).catch(() => null), cli.chunks('media', media.original).catch(() => null)]);
      if (cs0?.complete) firstComplete.small = tPause;
      const chunkSize = cs0?.chunkSize ?? null;
      const originalSize = videoBytes.length;
      const totalChunks = chunkSize ? Math.max(1, Math.ceil(originalSize / chunkSize)) : null;
      out.pause = { at: tPause, sinceImportMs: tPause - tImport, via: smallUp, postStatus: pausePost.status, chunkSize, originalBytes: originalSize, originalChunks: totalChunks,
        originalReceived: co0?.received?.length ?? 0, originalComplete: co0?.complete === true, smallComplete: cs0?.complete === true };
      check(pausePost.status === 200 && pausePost.body?.ok !== false, '[creator] 暂停上传队列(上传目标置空)', pausePost);
      check(out.pause.smallComplete, '[creator] 暂停时托管端素材小尺寸已 complete', out.pause);
      check(!out.pause.originalComplete, '[creator] 暂停时托管端素材原尺寸还没 complete', out.pause);
      check(totalChunks >= 4, '[creator] 素材原尺寸至少分 4 片', out.pause);
      // 暂停之后队列里还留着这个素材(不丢),原尺寸不再往上走
      await delay(1500);
      const [co1, q1p] = await Promise.all([cli.chunks('media', media.original).catch(() => null), getJson(`${A.origin}/api/media/upload-queue`).catch(() => null)]);
      out.pause.after1500ms = { originalReceived: co1?.received?.length ?? 0, originalComplete: co1?.complete === true, queued: q1p?.queue?.items?.length ?? null, target: q1p?.target ?? null };
      check(!out.pause.after1500ms.originalComplete && out.pause.after1500ms.queued === 1 && !q1p?.target, '[creator] 暂停期间原尺寸停着、素材还在上传队列里', out.pause.after1500ms);
    }
    const smallInProject = await until('[creator] 项目里写上 tiers.small', () => P(page, async (id) => (await import('/src/store/project.ts')).getState().project.media.find((x) => x.id === id)?.tiers?.small ?? null, media.id), 30_000, 300);
    out.tiers = { original: media.original, small: smallHash, remuxed: media.original !== sha256(videoBytes) };
    check(smallHash && /^[0-9a-f]{64}$/.test(smallHash) && smallInProject === smallHash, '[creator] 项目里有 tiers.small,与两档登记一致', { smallHash, smallInProject, smallState });

    /** 观察端报小尺寸出画面并稳定(或它已交结果)之后续传,等原尺寸 complete、队列清空,再核对顺序与字节 */
    /** 两档从素材服务整个取回、核哈希(托管端;放本机时是局域网主机) */
    const checkHostedBytes = async () => {
      // 整个取回再核哈希。原尺寸约 44 MB 只发一个请求,客户端缺省时限 30 s 含读完回包,托管端远时读不完
      // (T9-X3 就是这样被判成不符);这里放宽到 10 分钟,取不回时记下错误原文,不和「字节不符」混在一起
      const whole = conn.client('r', { timeoutMs: 600_000 });
      out.hostedBytes = {};
      for (const [tier, h] of [['small', smallHash], ['original', media.original]]) {
        if (!h) continue;
        const t0 = Date.now();
        let bytes = null;
        let error = null;
        try { bytes = await whole.get('media', h); } catch (e) { error = { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) }; }
        out.hostedBytes[tier] = { ms: Date.now() - t0, bytes: bytes ? bytes.length : null, error };
        check(bytes && sha256(bytes) === h, `[creator] 托管端 ${tier} 字节与哈希相符`, out.hostedBytes[tier]);
      }
    };

    const resumeUpload = async () => {
      if (lan) {
        const origDone = await until('[creator] 局域网主机上素材原尺寸 complete', async () => ((await cli.chunks('media', media.original).catch(() => null))?.complete ? Date.now() : null), 300_000, 200);
        if (origDone) firstComplete.original = origDone;
        out.firstCompleteMs = { small: firstComplete.small ? firstComplete.small - tImport : null, original: firstComplete.original ? firstComplete.original - tImport : null, polls };
        check(firstComplete.small && firstComplete.original, '[creator] 局域网主机上两档都 complete', firstComplete);
        await checkHostedBytes();
        return;
      }
      let signal = null;
      const end = Math.min(Date.now() + 15 * 60_000, deadline);
      while (!signal && Date.now() < end) {
        const small = await store.get('observer.small', 5000).catch(() => null);
        if (small) { signal = 'observer.small'; break; }
        if (await store.get('observer', 0).catch(() => null)) signal = 'observer-gone';
      }
      const tResume = Date.now();
      const resumed = await P(page, async () => {
        const T = await import('/src/editor/media/assetTiers.ts');
        const link = window.__t9AssetLink;
        const base = T.remoteAssetBase();
        if (!link || !base) return { ok: false, link: !!link, base };
        // 页面自己设上传目标的函数(进入共享项目时 connectSharedAssets 调的那个):在这条连接上签 rw 素材票据交给编辑器进程
        window.__t9StopUpload = T.startUploadTarget(link, base);
        return { ok: true, base };
      }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      await store.put('resumed', { at: tResume, signal });
      say('upload.resumed', { signal });
      out.resume = { at: tResume, signal, sincePauseMs: tResume - tPause, ok: resumed.ok, base: resumed.base ?? null };
      check(signal === 'observer.small', '[creator] 观察端报了小尺寸出画面才续传', signal);
      check(resumed.ok && String(resumed.base ?? '').replace(/\/+$/, '') === conn.assetUrl.replace(/\/+$/, ''), '[creator] 页面把上传目标重新交给编辑器进程', resumed);
      const origDone = await until('[creator] 续传后素材原尺寸 complete', async () => ((await cli.chunks('media', media.original).catch(() => null))?.complete ? Date.now() : null), 300_000, 200);
      if (origDone) firstComplete.original = origDone;
      out.resume.originalCompleteMs = origDone ? origDone - tResume : null;
      out.firstCompleteMs = { small: firstComplete.small ? firstComplete.small - tImport : null, original: firstComplete.original ? firstComplete.original - tImport : null, polls };
      check(firstComplete.small && firstComplete.original, '[creator] 托管端两档都 complete', firstComplete);
      const drained = await until('[creator] 上传队列清空', async () => {
        const q = await getJson(`${A.origin}/api/media/upload-queue`);
        return q?.queue && q.queue.items.length === 0 && !q.queue.working ? q.queue : null;
      }, 120_000, 300);
      out.uploadQueue = drained ? { uploaded: drained.uploaded ?? null, failures: drained.failures ?? null,
        lastError: drained.lastError ? { code: drained.lastError.code ?? null, message: String(drained.lastError.message ?? '').slice(0, 120) } : null } : null;
      // 编辑器日志里这个素材的上传顺序。暂停(上传目标置空,票据随之清掉)会让正在传的原尺寸那一片回 401,队列记一次
      // `upload.retry`、素材留在队里;续传时这个素材从头再走一遍:小尺寸问 chunks 已齐、一片不发,原尺寸只补缺的片
      const short = (h) => (h === smallHash ? 'small' : h === media.original ? 'original' : h?.slice(0, 8));
      const order = [];
      const sent = [];
      for (const line of A.log) {
        const m = /\[media-tiers\] (upload\.(?:tier-start|tier-done|item-done|retry)) (\{.*\})$/.exec(line);
        if (!m) continue;
        let f;
        try { f = JSON.parse(m[2]); } catch { continue; }
        if (f.id !== media.original) continue;
        order.push(m[1] === 'upload.item-done' ? 'item-done' : m[1] === 'upload.retry' ? 'retry' : `${m[1].slice(7)} ${short(f.hash)}`);
        if (m[1] === 'upload.tier-done') sent.push({ tier: short(f.hash), attempt: order.filter((x) => x === 'retry').length + 1, sent: Array.isArray(f.sent) ? f.sent.length : null });
      }
      out.uploadOrder = order;
      out.uploadSent = sent;
      const attempts = [[]];
      for (const x of order) { if (x === 'retry') attempts.push([]); else attempts.at(-1).push(x); }
      const first = attempts[0];
      const last = attempts.at(-1);
      const lastNoSmall = last.filter((x) => !x.endsWith(' small'));
      check(first[0] === 'tier-start small' && first[1] === 'tier-done small' && !first.includes('tier-done original')
        && JSON.stringify(lastNoSmall) === JSON.stringify(['tier-start original', 'tier-done original', 'item-done'])
        && (last.length === 3 || JSON.stringify(last.slice(0, 2)) === JSON.stringify(['tier-start small', 'tier-done small'])),
        '[creator] 上传队列日志:先小后大(暂停前小尺寸传完、原尺寸没传完;续传后原尺寸传完出队)', order);
      check(sent.filter((x) => x.tier === 'small' && x.attempt > 1).every((x) => x.sent === 0), '[creator] 续传时小尺寸一片没重发', sent);
      await checkHostedBytes();
    };

    // ---- 5. KV config;等主机;加重卡片段,等 plan 落定
    await store.put('config', {
      run, place: PLACE, where: shared.where, hosted: httpBase, ws: wsBase, projectId: shared.projectId, name: shared.name, mode: shared.mode,
      base: lan ? M.candidateBaseOf(wsBase) : shared.base, memberPassword: projectPw,
      tiers: out.tiers, mediaName: path.basename(video), fps: FPS, seek: SEEK,
      card: { id: CARD_ID, rel: CARD_REL, v1: MARK('v1'), v2: MARK('v2'), source: cardSource(CARD_ID, MARK('v1')) },
      heavy: { cardId: HEAVY.cardId, seconds: HEAVY.seconds, salt: `t9-${run}` },
      pause: { at: out.pause.at, skipped: out.pause.skipped ?? null, originalComplete: out.pause.originalComplete, originalReceived: out.pause.after1500ms?.originalReceived ?? null, originalChunks: out.pause.originalChunks ?? null },
      at: Date.now(),
    });
    // 续传在后台等观察端的信号,与主机、重卡片段、plan 并行
    const resumeTask = resumeUpload().catch((error) => { fails.push(`[creator] ${lan ? '核两档' : '续传'}出错:${String(error?.message ?? error).slice(0, 300)}`); });
    say('config.put', { run });
    const hostReady = await store.wait('host.ready', '主机起来', 15 * 60_000);
    out.hostReady = { at: hostReady.at ?? null, port: hostReady.port ?? null };
    const q0 = await until('[creator] 本机队列节点报到', async () => {
      const q = await diag();
      return q?.active ? q : null;
    }, 120_000, 500);
    if (!check(q0?.active, '[creator] 本机队列节点连着托管端并报到', q0 ? { active: q0.active, connected: q0.connected, url: q0.url } : null)) throw new Error('队列节点不在');
    const before = new Set((q0.published ?? []).map((p) => p.planId));
    // 重卡片段要不论机器忙闲都进预渲染集合。实测判重(K1/K2)只看成本记录,卡片声明(stateful)只在一条记录都没有时兜底;
    // 16 秒 probe-typewriter 在空闲的本机测出来是 over-catchup(追帧比 ≈ 80,门槛 60),机器一忙 p90 抬高就掉到 catchup-b 判轻、
    // 切不出任务(报告 AGENT-c66-t9-fix 第 1 节)。所以放卡前先按成本记录的「人工钉死」(`pinnedHeavy`,costs-store 的粘性旗标)
    // 给这张卡的身份写一条记录:页面探针见到已有记录就不再测,两端的 planPipelines 都判 capped。不改轻重门槛与判定。
    await waitProbeIdle(page, 'creator');
    const pinSpec = { cardId: HEAVY.cardId, duration: HEAVY.seconds, salt: `t9-${run}`, userClip, params: HEAVY.burnMs ? { burnMs: HEAVY.burnMs, label: `T9-${run}` } : {} };
    let pinKeys = { heavy: null, user: null };
    let pinForwarded = null;
    if (HEAVY_MODE === 'slow-stepped') {
      // L3:确定判重的探针卡,不用钉死。C10 集成分支才有它,本检出没有就明说,不退回钉死(免得以为验过了)
      const has = await P(page, async (id) => (await import('/src/kernel/registry.ts')).getCard(id) != null, HEAVY.cardId);
      if (!check(has, `[creator] 本检出有 ${HEAVY.cardId}`, 'C10 集成分支的探针卡(src/cards/_probe/slow.tsx),C10 合入 main 之前没有;先用 --heavy pinned')) throw new Error(`没有 ${HEAVY.cardId}`);
    } else {
      pinKeys = await P(page, async (spec) => {
        const S = await import('/src/store/project.ts');
        const I = await import('/src/editor/costIdentity.ts');
        const R = await import('/src/kernel/registry.ts');
        const p = S.getState().project;
        const def = R.getCard(spec.cardId);
        // 与 addCardClip 同一个形状(参数写入时展开成全量);身份键不含 clipId 与位置(cardCostKey)
        const clip = { id: 't9-pin', cardId: spec.cardId, start: 0, end: spec.duration, params: { ...(def?.defaults ?? {}), probeSalt: spec.salt } };
        I.resetClipIdentityCache();
        const synthetic = I.clipIdentityOf({ ...p, tracks: [...p.tracks, { id: 't9-pin-track', name: 'pin', clips: [clip] }] }).identityKeys;
        I.resetClipIdentityCache();
        const own = I.clipIdentityOf(S.getState().project).identityKeys;
        return { heavy: synthetic['t9-pin'] ?? null, user: own[spec.userClip] ?? null };
      }, pinSpec);
      // 页面的 device 串(probeRunner 私有)从它自己写过的用户卡记录上取:探针按 (identityKey, device) 判「已测过」
      const allCosts = (await getJson(`${A.origin}/api/data/costs`))?.costs ?? [];
      const userRecord = allCosts.find((r) => r.identityKey === pinKeys.user) ?? null;
      if (!check(pinKeys.heavy && userRecord?.device, '[creator] 算出重卡片段的成本身份、拿到页面的 device 串', { pinKeys, userRecord: !!userRecord })) throw new Error('钉不住重卡片段');
      const pinRecord = { identityKey: pinKeys.heavy, device: userRecord.device, ...(userRecord.mode ? { mode: userRecord.mode } : {}), fps: FPS,
        pinnedHeavy: true, measuredAt: Date.now(), note: 'c66-t9-probe 人工钉死' };
      const pinPut = await fetch(`${A.origin}/api/data/costs`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [pinRecord] }) })
        .then((r) => r.json()).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      check(pinPut?.ok, '[creator] 写入重卡片段的钉死记录', pinPut);
      // 编辑器进程转给预渲染进程是不等回复的:等预渲染那一份也有了再放卡(它按自己那份算预渲染集合)
      pinForwarded = await until('[creator] 预渲染进程收到钉死记录', async () => {
        const c = (await getJson(`${prerender}/api/data/costs`, 5000))?.costs ?? [];
        return c.some((r) => r.identityKey === pinKeys.heavy && r.pinnedHeavy === true) || null;
      }, 30_000, 300);
    }
    const heavyClip = await P(page, async (spec, seek) => {
      const S = await import('/src/store/project.ts');
      const t = S.actions.addTrack('T9 重卡');
      const c = S.actions.addCardClip(spec.cardId, 0, { trackId: t.id, duration: spec.duration, params: { ...spec.params, probeSalt: spec.salt } });
      S.actions.seek(seek);
      return c?.id ?? null;
    }, pinSpec, SEEK);
    if (!heavyClip) throw new Error('没放上重卡片段');
    // 放上的片段与钉死的身份是同一个;页面这边的判定(与预渲染进程同一个 planPipelines)
    const heavyState = await P(page, async (clipId) => {
      const S = await import('/src/store/project.ts');
      const I = await import('/src/editor/costIdentity.ts');
      I.resetClipIdentityCache();
      const r = I.clipIdentityOf(S.getState().project);
      return { key: r.identityKeys[clipId] ?? null, frameMode: r.frameModes[clipId] ?? null, compositing: r.capabilities.get(clipId)?.compositing ?? null };
    }, heavyClip);
    out.heavy = { mode: HEAVY_MODE, cardId: HEAVY.cardId, seconds: HEAVY.seconds, clipId: heavyClip, identityKey: heavyState.key, pinned: heavyState.key === pinKeys.heavy,
      forwarded: !!pinForwarded, frameMode: heavyState.frameMode, compositing: heavyState.compositing };
    if (HEAVY_MODE !== 'slow-stepped') check(out.heavy.pinned, '[creator] 放上的重卡片段就是钉死的那个身份', { placed: heavyState.key, pinned: pinKeys.heavy });
    check(heavyState.frameMode === 'stateful' && heavyState.compositing === 'independent', '[creator] 重卡片段是审阅过的独立推帧卡(共享档)', heavyState);
    const tPublish = Date.now();
    let lastNewAt = null;
    let lastNewCount = 0;
    const settled = await until('[creator] 页面发布的 plan 切分完、细任务都落定', async () => {
      const q = await diag();
      const mine = (q?.published ?? []).filter((p) => !before.has(p.planId));
      if (!mine.length) return null;
      if (mine.length !== lastNewCount) { lastNewCount = mine.length; lastNewAt = Date.now(); }
      const latest = mine[mine.length - 1];
      const derived = q.plans?.[latest.planId];
      // 加重卡之前的那一版(比如写 tiers.small 触发的)可能也在基线之后发布,切不出细任务:只认切出了任务的最新一版
      if (!Array.isArray(derived) || derived.length === 0) return null;
      const states = derived.map((id) => q.tasks?.[id]?.state ?? 'pending');
      if (!states.every((s) => s === 'done' || s === 'failed')) return null;
      if (Date.now() - lastNewAt < 3000) return null; // 3 s 内没有新的一版才算
      return { planId: latest.planId, derived, states, plans: mine.map((p) => p.planId) };
    }, 600_000, 1000);
    // 预渲染进程这一端怎么判的这张卡(最后一版 card plan 里它的 control:picked = 进了预渲染集合)
    const heavyControl = async () => {
      const d = await getJson(`${prerender}/api/frames/diagnostics`, 20_000).catch(() => null);
      const c = (d?.plans ?? []).at(-1)?.controls?.find((x) => x.clipId === heavyClip) ?? null;
      return c ? { picked: c.picked, tier: c.tier, frameMode: c.frameMode, costKey: c.costKey } : null;
    };
    out.heavy.control = await heavyControl();
    if (!settled) {
      try { fs.writeFileSync(path.join(OUT, 'creator-queue-diag.json'), JSON.stringify(await getJson(`${prerender}/api/frames/diagnostics`, 20_000), null, 1)); } catch { /* 取不到 */ }
      throw new Error('plan 没落定');
    }
    await until('[creator] 清单拉取完', async () => {
      const s = (await diag())?.stats ?? {};
      return (s.applied ?? 0) + (s.applyErrors ?? 0) >= settled.derived.length || null;
    }, 180_000, 1000);
    const q1 = await diag();
    const inPlan = (ids) => (ids ?? []).filter((id) => settled.derived.includes(id));
    const plan = {
      planId: settled.planId, plans: settled.plans, derived: settled.derived, tasks: settled.derived.length,
      done: settled.states.filter((s) => s === 'done').length,
      failed: settled.derived.filter((_, i) => settled.states[i] === 'failed').map((id) => ({ id, error: q1.tasks?.[id]?.error ?? null })),
      doneCounts: Object.fromEntries(settled.derived.map((id) => [id, q1.doneCounts?.[id] ?? 0])),
      planDoneCount: q1.doneCounts?.[settled.planId] ?? 0,
      pc: { nodeId: q1.local?.nodeId ?? null, claimed: inPlan(q1.local?.claimed), completed: inPlan(q1.local?.completed), dedup: inPlan(q1.local?.dedup),
        failed: inPlan(q1.local?.failed), planClaimed: (q1.local?.claimed ?? []).includes(settled.planId) },
      stats: { applied: q1.stats?.applied ?? null, applyErrors: q1.stats?.applyErrors ?? null, fetched: q1.stats?.fetched ?? null },
      publishToSettledMs: Date.now() - tPublish,
    };
    try { fs.writeFileSync(path.join(OUT, 'creator-queue-diag.json'), JSON.stringify(await getJson(`${prerender}/api/frames/diagnostics`, 20_000), null, 1)); } catch { /* 取不到 */ }
    await store.put('plan', { ...plan, creatorCodeVersion: q0?.codeVersion ?? null });
    out.plan = { planId: plan.planId, plans: plan.plans.length, tasks: plan.tasks, done: plan.done, failed: plan.failed.length, planDoneCount: plan.planDoneCount,
      pcCompleted: plan.pc.completed.length, pcDedup: plan.pc.dedup.length, pcPlanClaimed: plan.pc.planClaimed, publishToSettledMs: plan.publishToSettledMs, stats: plan.stats };
    check(plan.tasks > 0, '[creator] plan 切出了细任务', plan.tasks);
    check(plan.failed.length === 0, '[creator] 没有细任务失败', plan.failed);
    check(plan.pc.planClaimed, '[creator] plan 由发布方的本机节点认领');
    await page.screenshot({ path: path.join(OUT, `${run}-creator-1-published.png`) });

    // ---- 6. 等观察端,改卡
    await store.put('editready', { at: Date.now() });
    // 等观察端报进入;它先交了结果(出错收尾)就不再等
    const joinEnd = Math.min(Date.now() + 20 * 60_000, deadline);
    let joined = null;
    let observerGone = false;
    while (!joined && !observerGone && Date.now() < joinEnd) {
      joined = await store.get('observer.joined', 5000).catch(() => null);
      if (!joined && (await store.get('observer', 0).catch(() => null))) observerGone = true;
    }
    if (!joined && !observerGone) throw new Error('等观察端进入超时');
    if (observerGone) fails.push('[creator] 观察端没报进入就结束了,没有改卡');
    else {
    const tEdit = Date.now();
    const edit = await postJson(`${A.origin}/api/cards/edit`, { id: CARD_ID, find: MARK('v1'), replace: MARK('v2') });
    out.edit = { ok: edit.body?.ok ?? false, ms: Date.now() - tEdit, backup: !!edit.body?.backup };
    await store.put('edited', { ok: edit.body?.ok ?? false, ms: out.edit.ms, at: Date.now() });
    if (!check(edit.body?.ok, '[creator] /api/cards/edit 改成 v2', edit.body?.error)) throw new Error('改卡失败');
    const rev2 = await until('[creator] 改后的卡传上内容库', async () => {
      const s = await getJson(`${A.origin}/api/cards/sync/status`);
      return s.records?.[CARD_REL]?.rev >= 2 ? s.records[CARD_REL].rev : null;
    }, 20_000, 300);
    out.cardRevAfterEdit = rev2;
    }

    // ---- 7. 汇总三方
    await resumeTask;
    const [obs, host] = await Promise.all([
      store.wait('observer', '观察端结果', 15 * 60_000).catch((e) => ({ ok: false, fails: [String(e?.message ?? e)] })),
      store.wait('host', '主机结果', 15 * 60_000).catch((e) => ({ ok: false, fails: [String(e?.message ?? e)] })),
    ]);
    out.observer = obs;
    out.host = host;
    check(obs?.ok === true, '观察端 ok', obs?.fails);
    check(host?.ok === true, '主机 ok', host?.fails);
    const hostDone = (host?.completed ?? 0) + (host?.dedup ?? 0);
    out.completedByNode = { pc: plan.pc.completed.length + plan.pc.dedup.length, host: hostDone };
    check(out.completedByNode.pc + out.completedByNode.host === plan.tasks, '各节点完成数之和 = 细任务数', { ...out.completedByNode, tasks: plan.tasks });
    await page.screenshot({ path: path.join(OUT, `${run}-creator-2-end.png`) });
    out.shots = [path.join(OUT, `${run}-creator-1-published.png`), path.join(OUT, `${run}-creator-2-end.png`)].filter((f) => fs.existsSync(f));
    out.pageErrors = pageErrors.slice(0, 5);
  } catch (error) {
    fails.push(`creator 出错:${String(error?.message ?? error).slice(0, 600)}`);
    say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
    try { await store.put('abort', { reason: String(error?.message ?? error).slice(0, 200), at: Date.now() }); } catch { /* 协调口不通 */ }
  } finally {
    // 删掉托管端的测试项目(创建者操作 delete)
    if (shared && creatorPw) {
      try {
        conn ??= await openConn(M, { url: wsBase, projectId: shared.projectId, username: 'creator', password: creatorPw, as: 'creator', tag: 'creator-del' });
        const ch = await conn.rpc({ type: 'shared.challenge' });
        if (ch.type !== 'shared.challenge.ok') throw new Error(`challenge ${ch.reason ?? ch.type}`);
        const key = await M.deriveKey(creatorPw, ch.salt, ch.kdf);
        const m = await M.adminProof({ key, projectId: shared.projectId, username: 'creator', op: 'delete', nonce: ch.nonce });
        const r = await conn.rpc({ type: 'shared.admin', op: 'delete', proof: { nonce: ch.nonce, m } });
        out.deleted = r.type === 'shared.admin.ok';
      } catch (error) {
        out.deleted = false;
        out.deleteError = String(error?.message ?? error).slice(0, 200);
      }
      check(out.deleted, '[creator] 删掉托管端的测试项目', out.deleteError);
    }
    try { await conn?.close(); } catch { /* 已关 */ }
    try { await browser?.close(); } catch { /* 已关 */ }
    saveEditorLogs(OUT);
    for (const c of children) { killTree(c); await exited(c); }
    card.cleanup(CARD_ID);
    if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄没放 */ } } else out.temp = TMP;
    try { await store.put('creator', { ok: fails.length === 0, fails }); } catch { /* 同上 */ }
  }
}

/* ================================================================== observer */

async function runObserver(out) {
  const run = await resolveRun('observer');
  out.run = run;
  const store = kv(run);
  const port = Number(arg('--port', DEFAULT_PORT.observer));
  const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-c66t9-${run}`, 'observer')));
  fs.mkdirSync(OUT, { recursive: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c66t9-observer-'));
  out.port = port;
  let browser = null;
  let card = null;
  let cfg = null;
  const pageErrors = [];
  try {
    cfg = await store.wait('config', '创建者的配置');
    let candidateBase = cfg.base;
    if (cfg.place === 'lan') {
      const found = await discoverLanBase(await mods(), cfg);
      out.discovery = found.discovery;
      check(found.discovery.found, '[observer] 经局域网发现找到局域网主机', found.discovery);
      candidateBase = found.candidateBase;
    }
    const CARD_ID = cfg.card.id;
    card = repoCard(cfg.card.rel);
    out.cardInRepoBefore = card.existedBefore;
    const env = editorEnv(path.join(TMP, 'editor'), { PROMPTCUT_DEVICE_ID: `c66t9-b-${run}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'c66-t9 observer' });
    out.env = { PROMPTCUT_QUEUE_NODE: env.PROMPTCUT_QUEUE_NODE ?? null, PROMPTCUT_SHARED_CONFIG: env.PROMPTCUT_SHARED_CONFIG ?? null };
    check(!env.PROMPTCUT_QUEUE_NODE && !env.PROMPTCUT_SHARED_CONFIG, '[observer] 编辑器 B 的 PROMPTCUT_QUEUE_NODE、PROMPTCUT_SHARED_CONFIG 为空', out.env);
    const B = await startEditor('observer', port, env);
    const overrides = env.PROMPTCUT_CARD_OVERRIDES;

    browser = await launchBrowser();
    const page = await openEditorPage(browser, B.origin, 'observer', pageErrors);
    out.frameQueue = await getJson(`${B.origin}/api/frames/queue`, 60_000).then((q) => ({ nodes: q?.nodes?.length ?? null, starting: q?.starting ?? null, profile: q?.profile ?? null })).catch((e) => ({ error: String(e?.message ?? e) }));
    check(out.frameQueue.nodes === 0 && out.frameQueue.starting === false, '[observer] B 不是队列节点(/api/frames/queue 没有节点、开关关着)', out.frameQueue);
    const stagePorts = ((await getJson(`${B.origin}/api/stage/ports`))?.ports ?? []).slice(0, 2).map(String);

    // ---- 进入
    const tJoin = Date.now();
    const entered = await P(page, async (candidate, cred) => (await import('/src/editor/sync/syncManager.ts')).enterShared(candidate, cred),
      { where: cfg.where ?? 'hosted', base: candidateBase, projectId: cfg.projectId, name: cfg.name, mode: cfg.mode }, { as: 'member', username: 'observer', password: cfg.memberPassword });
    if (!entered?.ok) throw new Error(`观察端进不去共享项目:${JSON.stringify(entered)}`);
    const clip = await until('[observer] 看到视频片段', () => P(page, async (orig) => {
      const S = await import('/src/store/project.ts');
      const p = S.getState().project;
      const m = p.media.find((x) => (x.tiers?.original ?? x.hash) === orig);
      if (!m) return null;
      const c = p.tracks.flatMap((t) => t.clips).find((x) => x.mediaId === m.id);
      return c ? { mediaId: m.id, clipId: c.id, tiers: m.tiers ?? null } : null;
    }, cfg.tiers.original), 120_000, 200);
    if (!clip) {
      out.debugProject = await P(page, async () => {
        const S = await import('/src/store/project.ts');
        const p = S.getState().project;
        return { id: p.id, name: p.name, media: p.media.map((m) => ({ kind: m.kind, hash: m.hash?.slice(0, 12) ?? null, tiers: m.tiers ?? null, pending: !!m.pending })),
          clips: p.tracks.flatMap((t) => t.clips).map((c) => c.cardId || `media:${c.mediaId}`), view: window.__pcSyncTest?.view() ?? null };
      }).catch((e) => ({ error: String(e?.message ?? e) }));
      throw new Error('观察端没看到视频片段');
    }
    out.joinMs = Date.now() - tJoin;
    if (OBSERVER_THROTTLE) {
      await page.emulateNetworkConditions({ download: OBSERVER_THROTTLE, upload: OBSERVER_THROTTLE, latency: 20 });
      out.throttle = { download: OBSERVER_THROTTLE, latency: 20 };
    }
    out.projectTiers = clip.tiers;
    // 播放头的去向:seek 之前挂一个 store 订阅,记下之后每一次 t 的变化(带调用栈),排查「seek 到 2.5 s 却停在 0」
    await P(page, async (t) => {
      const S = await import('/src/store/project.ts');
      const log = [];
      window.__t9TLog = log;
      let last = S.getState().t;
      const t0 = performance.now();
      window.__t9TOff?.();
      window.__t9TOff = S.subscribe(() => {
        const st = S.getState();
        if (st.t === last) return;
        last = st.t;
        if (log.length < 50) log.push({ ms: Math.round(performance.now() - t0), t: st.t, cut: st.project.activeCutId ?? null, duration: st.project.duration,
          stack: (new Error().stack ?? '').split('\n').slice(2, 12).map((l) => l.trim().replace(/https?:\/\/[^/]+/g, '').replace(/\?[^:]*:/g, ':')) });
      });
      S.actions.pause?.();
      S.actions.seek(t);
    }, SEEK);

    // ---- 素材层:先小后大(tier-switch-probe 的读法)
    const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
    const front = async () => {
      const id = await P(page, () => window.__pcPreviewDiag?.().frontId ?? 'A').catch(() => 'A');
      return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null;
    };
    const layer = async () => (await front())?.evaluate(() => {
      const v = document.querySelector('[data-pc-media] > video');
      if (!v) return { shown: false };
      const r = { shown: true, src: v.currentSrc || v.getAttribute('src') || '', rs: v.readyState, ct: v.currentTime };
      if (v.readyState >= 2 && v.videoWidth) {
        const cv = document.createElement('canvas');
        cv.width = v.videoWidth; cv.height = v.videoHeight;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(v, 0, 0);
        const y = Math.round(cv.height * (48 / 720));
        let idx = 0;
        for (let k = 0; k < 10; k++) if (ctx.getImageData(Math.round(cv.width * ((k + 0.5) / 10)), y, 1, 1).data[0] > 128) idx |= 1 << k;
        r.idx = idx;
        r.w = v.videoWidth;
      }
      return r;
    }).catch(() => null);
    const tierOf = (src) => (src?.includes(cfg.tiers.small) ? 'small' : src?.includes(cfg.tiers.original) ? 'original' : src ? 'other' : 'none');
    const seq = [];
    const note = (l) => {
      const tier = l?.shown && l.rs >= 2 && Number.isInteger(l.idx) ? tierOf(l.src) : 'none';
      if (!seq.length || seq[seq.length - 1].tier !== tier) seq.push({ ms: Date.now() - tJoin, tier, idx: l?.idx ?? null, w: l?.w ?? null, ct: Number.isFinite(l?.ct) ? Number(l.ct.toFixed(3)) : null });
      return tier;
    };
    // 换档期间逐帧(rAF)采样显示着的那一层。素材原尺寸在托管端早已 complete 时,页面第一次问 chunks 就换档
    // (小尺寸只显示一百多毫秒),所以在小尺寸第一次解出画面时就开始采样,不等它稳定
    const startSampling = async () => (await front())?.evaluate(() => {
      window.__t9Samples = [];
      window.__t9Sampling = true;
      // 每个 <video> 出没出过帧(requestVideoFrameCallback):显示中的元素 readyState < 2 时,出过帧的通常还显示着上一帧
      const presented = new WeakSet();
      window.__t9Presented = presented;
      const watch = (v) => {
        if (v.__t9Watch) return;
        v.__t9Watch = true;
        const cb = () => { presented.add(v); v.requestVideoFrameCallback(cb); };
        v.requestVideoFrameCallback(cb);
        if (v.readyState >= 2) presented.add(v);
      };
      for (const v of document.querySelectorAll('video')) watch(v);
      window.__t9LowRs = null;
      const cv = document.createElement('canvas');
      cv.width = 100; cv.height = 72;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const now = () => (window.__pcRealNow ?? (() => performance.now()))();
      const raf = window.__pcRealRaf ?? window.requestAnimationFrame.bind(window);
      const loop = () => {
        if (!window.__t9Sampling) return;
        for (const x of document.querySelectorAll('video')) watch(x);
        const v = document.querySelector('[data-pc-media] > video');
        const s = { at: now(), epoch: performance.timeOrigin + now(), shown: !!v };
        if (v) {
          s.src = (v.currentSrc || '').split('/@media/')[1]?.slice(0, 8) ?? '';
          s.rs = v.readyState;
          s.presented = presented.has(v);
          window.__t9LowRs = v.readyState < 2 ? { since: window.__t9LowRs?.since ?? s.epoch } : null;
          if (v.readyState >= 2 && v.videoWidth) {
            ctx.drawImage(v, 0, 0, cv.width, cv.height);
            let idx = 0;
            for (let k = 0; k < 10; k++) if (ctx.getImageData(Math.round(cv.width * ((k + 0.5) / 10)), 5, 1, 1).data[0] > 128) idx |= 1 << k;
            s.idx = idx;
            const d = ctx.getImageData(0, Math.round(cv.height * 0.5), cv.width, 1).data;
            let sum = 0;
            for (let i = 0; i < d.length; i += 4) sum += d[i];
            s.luma = sum / (d.length / 4);
          }
        }
        if (window.__t9Samples.length < 20000) window.__t9Samples.push(s);
        raf(loop);
      };
      raf(loop);
      return true;
    }).catch(() => false);
    const firstShown = await until('[observer] 素材层第一次解出画面', async () => {
      const l = await layer();
      const tier = note(l);
      return tier !== 'none' ? { tier, idx: l.idx, w: l.w } : null;
    }, 180_000, 100);
    out.firstShown = firstShown;
    // 出第一帧时原尺寸还在路上:创建方在放观察端进来之前暂停了上传、核对过原尺寸没 complete,
    // 而且要等本端报「小尺寸出画面并稳定」才续传 —— 此刻 KV 里还不该有 `resumed`
    const resumedAtFirst = await store.get('resumed', 0).catch(() => undefined);
    out.originalAtFirstFrame = { paused: cfg.pause ?? null, resumedBefore: resumedAtFirst === undefined ? 'unknown' : resumedAtFirst !== null };
    // 放本机:局域网主机导入即落地,原尺寸本来就在,不判「还在路上」(见文件头「放本机」)
    if (cfg.place !== 'lan') check(cfg.pause && cfg.pause.originalComplete === false && resumedAtFirst === null, '[observer] 出第一帧时素材原尺寸还没 complete(创建方暂停着上传、还没续传)', out.originalAtFirstFrame);
    check(firstShown?.tier === 'small', '[observer] 素材层先以素材小尺寸出现', firstShown);
    const samplingStarted = firstShown?.tier === 'small' ? startSampling() : Promise.resolve(false);
    // 诊断:两个舞台里每个 <video> 的事件、页面代码写 currentTime / 调 load() 的地方(带调用栈),写进 __t9MediaLog
    const installMediaLog = async () => {
      for (const f of stageFrames()) {
        await f.evaluate(() => {
          if (window.__t9MediaLog) return;
          const log = [];
          window.__t9MediaLog = log;
          const epoch = () => performance.timeOrigin + (window.__pcRealNow ?? (() => performance.now()))();
          const tag = (v) => ({ src: (v.currentSrc || v.getAttribute('src') || '').split('/@media/')[1]?.slice(0, 8) ?? '', rs: v.readyState, ct: Number(v.currentTime.toFixed(3)),
            shown: !!v.parentElement?.hasAttribute('data-pc-media'), paused: v.paused, net: v.networkState });
          const push = (e) => { if (log.length < 4000) log.push(e); };
          const stack = () => (new Error().stack ?? '').split('\n').slice(2, 9).map((l) => l.trim().replace(/https?:\/\/[^/]+/g, '').replace(/\?[^:)]*:/g, ':'));
          const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
          Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
            configurable: true, enumerable: desc.enumerable, get: desc.get,
            set(v) { push({ at: epoch(), type: 'set-currentTime', to: v, ...tag(this), stack: stack() }); desc.set.call(this, v); },
          });
          const load = HTMLMediaElement.prototype.load;
          HTMLMediaElement.prototype.load = function () { push({ at: epoch(), type: 'load()', ...tag(this), stack: stack() }); return load.call(this); };
          // 换档对齐的帧回调(VideoTrack 的 __pcTierTrace 观察口,数组时才记):哪一刻判定「新档这一帧对齐了」
          const trace = [];
          trace.push = (...xs) => {
            for (const x of xs) push({ at: epoch(), type: 'tier-aligned', src: String(x?.url ?? '').split('/@media/')[1]?.slice(0, 8) ?? '', mediaTime: x?.mediaTime, ref: x?.ref, playing: x?.playing });
            return Array.prototype.push.apply(trace, xs);
          };
          window.__pcTierTrace = trace;
          const events = ['seeking', 'seeked', 'waiting', 'emptied', 'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'stalled', 'suspend', 'abort', 'error', 'play', 'pause'];
          const hook = (v) => {
            if (v.__t9Log) return;
            v.__t9Log = true;
            for (const type of events) v.addEventListener(type, () => push({ at: epoch(), type, ...tag(v) }));
          };
          for (const v of document.querySelectorAll('video')) hook(v);
          new MutationObserver(() => { for (const v of document.querySelectorAll('video')) hook(v); }).observe(document.documentElement, { subtree: true, childList: true });
          // readyState 的变化(事件里没有直接的「降到 1」):每个 rAF 看一眼
          const raf = window.__pcRealRaf ?? window.requestAnimationFrame.bind(window);
          const last = new WeakMap();
          const tick = () => {
            for (const v of document.querySelectorAll('video')) {
              const k = `${v.readyState}|${v.parentElement?.hasAttribute('data-pc-media') ? 1 : 0}|${v.currentSrc}`;
              if (last.get(v) !== k) { last.set(v, k); push({ at: epoch(), type: 'state', ...tag(v) }); }
            }
            raf(tick);
          };
          raf(tick);
        }).catch(() => {});
      }
    };
    await installMediaLog();
    const collectMediaLogs = async () => {
      const mediaLogs = [];
      for (const f of stageFrames()) {
        const l = await f.evaluate(() => window.__t9MediaLog ?? null).catch(() => null);
        if (l) mediaLogs.push({ frame: /id=([AB])/.exec(f.url())?.[1] ?? '?', log: l });
      }
      try { fs.writeFileSync(path.join(OUT, 'observer-media-log.json'), JSON.stringify({ tJoin, frontId: await P(page, () => window.__pcPreviewDiag?.().frontId ?? null).catch(() => null), mediaLogs }, null, 1)); } catch { /* 写不了不影响结论 */ }
      out.mediaEvents = mediaLogs.map((m) => ({ frame: m.frame, seeks: m.log.filter((e) => e.type === 'set-currentTime' && e.src === cfg.tiers.original.slice(0, 8)).map((e) => ({ at: Math.round(e.at - tJoin), to: e.to, from: e.ct, rs: e.rs, shown: e.shown, stack: e.stack.slice(0, 3) })),
        loads: m.log.filter((e) => e.type === 'load()').map((e) => ({ at: Math.round(e.at - tJoin), src: e.src, stack: e.stack.slice(1, 2) })),
        aligned: m.log.filter((e) => e.type === 'tier-aligned' && e.src === cfg.tiers.original.slice(0, 8)).slice(0, 2).map((e) => ({ at: Math.round(e.at - tJoin), mediaTime: e.mediaTime, ref: e.ref })),
        seeked: m.log.filter((e) => e.type === 'seeked' && e.src === cfg.tiers.original.slice(0, 8) && e.ct > 1).map((e) => ({ at: Math.round(e.at - tJoin), shown: e.shown })),
        shownAt: (m.log.find((e) => e.type === 'state' && e.src === cfg.tiers.original.slice(0, 8) && e.shown) ?? null) && ((e) => ({ at: Math.round(e.at - tJoin), rs: e.rs }))(m.log.find((e) => e.type === 'state' && e.src === cfg.tiers.original.slice(0, 8) && e.shown)),
        drops: m.log.filter((e) => e.type === 'state' && e.src === cfg.tiers.original.slice(0, 8) && e.rs < 2).map((e) => ({ at: Math.round(e.at - tJoin), rs: e.rs, shown: e.shown, ct: e.ct })) }));
    };
    // 小尺寸停在 2.5 s:连续 3 次读到同一个帧号才算稳定;期间换到原尺寸就用换之前最后一个
    let smallIdx = null;
    let stable = 0;
    let lastIdx = null;
    let swappedEarly = false;
    if (firstShown?.tier === 'small') {
      await until('[observer] 素材小尺寸的帧号稳定', async () => {
        const l = await layer();
        const tier = note(l);
        if (tier === 'original') { swappedEarly = true; return true; }
        if (tier !== 'small') { stable = 0; return false; }
        stable = l.idx === lastIdx ? stable + 1 : 1;
        lastIdx = l.idx;
        smallIdx = l.idx;
        return stable >= 3;
      }, 20_000, 100);
      if (!swappedEarly) await page.screenshot({ path: path.join(OUT, `${run}-observer-1-small.png`) });
    }
    // 告诉创建方:小尺寸出画面并稳定了,可以续传原尺寸(没出小尺寸也照样报,免得创建方干等)
    await store.put('observer.small', { at: Date.now(), tier: firstShown?.tier ?? null, idx: smallIdx, stable: firstShown?.tier === 'small' && !swappedEarly });
    // 两档在观察端加入前都已传完时,页面挂上小尺寸、第一次轮询就换原尺寸(设计稿第 4 节),可能一个稳定样本都取不到:
    // 这时用小尺寸第一次出画面时读到的帧号(firstShown.idx),误差照旧按「不超过一帧」判
    out.smallIdxSource = smallIdx !== null ? (swappedEarly ? 'last-before-swap' : 'stable') : null;
    if (smallIdx === null && firstShown?.tier === 'small' && Number.isInteger(firstShown.idx)) { smallIdx = firstShown.idx; out.smallIdxSource = 'firstShown'; }
    out.smallIdx = smallIdx;
    out.smallStableBeforeSwap = !swappedEarly;
    check(smallIdx !== null && Math.abs(smallIdx - EXPECT_IDX) <= 1, `[observer] 素材小尺寸停在 ${SEEK} s(帧号 ${EXPECT_IDX} ± 1)`, { smallIdx });
    const sampling = await samplingStarted;
    // 显示中的元素 readyState < 2 时截合成后的舞台画面(视频区:条纹以下、卡片以上的一条),量亮度
    const shots = [];
    let shooting = !!sampling;
    const stageRect = async () => {
      const id = await P(page, () => window.__pcPreviewDiag?.().frontId ?? 'A').catch(() => 'A');
      const h = await page.$(`iframe[src*="id=${id}"]`).catch(() => null);
      return h ? h.boundingBox() : null;
    };
    const shotLoop = (async () => {
      const { PNG } = await import('pngjs').catch(() => ({ PNG: null }));
      while (shooting) {
        const low = await (await front())?.evaluate(() => window.__t9LowRs).catch(() => null);
        if (low) {
          const r = await stageRect();
          if (r && r.width > 10 && PNG) {
            const clip = { x: r.x, y: r.y + r.height * 0.2, width: r.width, height: Math.max(2, r.height * 0.15) };
            const at = Date.now();
            const buf = await page.screenshot({ clip, type: 'png' }).catch(() => null);
            if (buf) {
              const img = PNG.sync.read(buf);
              let sum = 0;
              for (let i = 0; i < img.data.length; i += 4) sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
              shots.push({ at, done: Date.now(), luma: Math.round(sum / (img.data.length / 4)) });
            }
          }
        }
        await delay(40);
      }
    })();
    const tSwapWait = Date.now();
    const orig = await until('[observer] 素材原尺寸到齐后换成原尺寸', async () => {
      const l = await layer();
      return note(l) === 'original' ? { idx: l.idx, w: l.w } : null;
    }, 300_000, 100);
    out.swapWaitMs = Date.now() - tSwapWait;
    out.original = orig;
    out.tierSequence = seq;
    check(orig, '[observer] 换到了素材原尺寸');
    check(orig && smallIdx !== null && Math.abs(orig.idx - smallIdx) <= 1, '[observer] 换档前后同一时刻的帧号相差不超过一帧', { small: smallIdx, original: orig?.idx });
    check(orig && orig.w === 1920, '[observer] 换档后显示的是 1920 宽的原尺寸', orig?.w);
    check(!seq.some((s, i) => i > 0 && s.tier === 'small' && seq.slice(0, i).some((x) => x.tier === 'original')), '[observer] 换到原尺寸之后没有退回小尺寸', seq);
    if (sampling) {
      // 换档之后再采一段:舞台 iframe 在无头浏览器里负载重时每秒只画十来帧,固定等 300 ms 只够两三帧。
      // 等到换档后的原尺寸样本至少 5 个、总样本至少 10 个(最多 5 s)
      const smallKey = cfg.tiers.small.slice(0, 8);
      const origKey = cfg.tiers.original.slice(0, 8);
      await until('[observer] 换档前后的逐帧样本够数', async () => {
        const n = await (await front())?.evaluate((k) => {
          const s = window.__t9Samples ?? [];
          return { total: s.length, after: s.filter((x) => x.src === k).length };
        }, origKey).catch(() => null);
        return n && n.total >= 10 && n.after >= 5 ? n : null;
      }, 5_000, 100);
      const samples = await (await front())?.evaluate(() => { window.__t9Sampling = false; return (window.__t9Samples ?? []).splice(0); }).catch(() => []) ?? [];
      shooting = false;
      await shotLoop;
      // 黑帧:没有显示中的元素;显示中的元素解出的帧本身黑(亮度 ≤ 16);readyState < 2 时这个元素从没出过帧,
      // 或那段时间里截到的合成画面黑(亮度 ≤ 16)。readyState < 2 但出过帧、截图不黑的(浏览器照样显示着上一帧)不算
      const nearShot = (s) => shots.filter((x) => x.at - 400 <= s.epoch && s.epoch <= x.done + 400);
      const lowRs = samples.filter((s) => s.shown && s.rs < 2);
      const black = samples.filter((s) => {
        if (!s.shown) return true;
        if (s.rs >= 2) return !(s.luma > 16);
        if (!s.presented) return true;
        return nearShot(s).some((x) => x.luma <= 16);
      });
      out.lowReadyState = { samples: lowRs.length, presentedBefore: lowRs.filter((s) => s.presented).length, withShot: lowRs.filter((s) => nearShot(s).length).length,
        shots: shots.length, shotLuma: shots.length ? [Math.min(...shots.map((x) => x.luma)), Math.max(...shots.map((x) => x.luma))] : null,
        srcs: [...new Set(lowRs.map((s) => s.src))], windowsMs: (() => {
          const w = [];
          for (const x of lowRs) { const last = w.at(-1); if (last && x.epoch - last.to < 300) last.to = x.epoch; else w.push({ from: x.epoch, to: x.epoch }); }
          return w.map((x) => ({ at: x.from - tJoin, ms: Math.round(x.to - x.from) }));
        })() };
      const idxs = [...new Set(samples.filter((s) => Number.isInteger(s.idx)).map((s) => s.idx))];
      const firstOrig = samples.findIndex((s) => s.src === origKey);
      const coversSwap = firstOrig > 0 && samples.slice(0, firstOrig).some((s) => s.src === smallKey);
      // 换档间隔(轮询看到小尺寸 → 看到原尺寸)与采样间隔(相邻两个 rAF 样本的中位间隔)比:
      // 短于一个采样间隔是「快换」,采样本来就可能一个小尺寸样本都落不上,不要求覆盖换档;否则「覆盖」,照旧要求覆盖
      const gaps = samples.slice(1).map((x, i) => x.at - samples[i].at).sort((a, b) => a - b);
      const sampleIntervalMs = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null;
      const seqSmall = seq.find((x) => x.tier === 'small');
      const seqOrig = seq.find((x) => x.tier === 'original');
      const swapGapMs = seqSmall && seqOrig ? seqOrig.ms - seqSmall.ms : null;
      const mode = swapGapMs !== null && sampleIntervalMs !== null && swapGapMs < sampleIntervalMs ? 'fast' : 'covered';
      out.swapMode = mode;
      out.swapSamples = { n: samples.length, black: black.length, idxSeen: idxs, srcs: [...new Set(samples.map((s) => s.src))], smallBeforeSwap: firstOrig > 0 ? firstOrig : 0,
        spanMs: samples.length > 1 ? Math.round(samples.at(-1).at - samples[0].at) : 0, coversSwap, mode, swapGapMs, sampleIntervalMs };
      check(samples.length >= 10, '[observer] 逐帧采样够数(≥ 10)', out.swapSamples);
      if (mode === 'covered') check(coversSwap, '[observer] 逐帧采样覆盖了换档(先有小尺寸样本、后有原尺寸样本)', out.swapSamples);
      // 创建方暂停着原尺寸、等本端报了小尺寸才续传,换档一定晚于小尺寸出画面好几个采样间隔
      if (cfg.place !== 'lan') check(mode === 'covered', '[observer] 原尺寸加入时还在路上,换档属于「覆盖」情形', { mode, swapGapMs, sampleIntervalMs });
      // 快换时「先小后大」由 firstShown(小尺寸)与之后换成原尺寸那两条断言保证,这里不再要求样本覆盖
      check(black.length === 0, '[observer] 换档期间逐帧采样无黑帧 / 无空档', black.slice(0, 3));
      check(idxs.every((i) => Math.abs(i - EXPECT_IDX) <= 1), '[observer] 换档期间画面一直停在同一时刻', idxs);
    } else {
      out.swapSamples = null;
      out.swapMode = null;
      check(false, '[observer] 逐帧采样没起来(换档期间的黑帧无从判)');
    }
    out.playhead = await P(page, async () => { const S = await import('/src/store/project.ts'); return { t: S.getState().t, log: window.__t9TLog ?? null }; }).catch((e) => ({ error: String(e?.message ?? e) }));
    await page.screenshot({ path: path.join(OUT, `${run}-observer-2-original.png`) });

    // ---- 卡片源码:v1 已装上,第一轮测量测完
    const bSource = async () => getJson(`${B.origin}/api/cards/source?id=${CARD_ID}`).catch(() => null);
    const v1 = await until('[observer] B 装上 v1', async () => ((await bSource())?.source?.includes(cfg.card.v1) ? true : null), 60_000, 300);
    check(v1, '[observer] 进入后 B 有探针卡 v1');
    await waitProbeIdle(page, 'observer');
    // 用户卡片段的 id(B 这一侧的项目里按卡片 id 找)
    const userClipOf = await P(page, async (cardId) => (await import('/src/store/project.ts')).getState().project.tracks.flatMap((t) => t.clips).find((c) => c.cardId === cardId)?.id ?? null, CARD_ID);
    if (!userClipOf) throw new Error('观察端项目里没有用户卡片段');
    const pageCardState = () => P(page, async (cardId, clipId) => {
      const R = await import('/src/kernel/registry.ts');
      const I = await import('/src/editor/costIdentity.ts');
      const S = await import('/src/store/project.ts');
      const u = R.userCardSources();
      const file = u.fileOf[cardId];
      const src = file ? u.files[file] ?? null : null;
      I.resetClipIdentityCache();
      const key = I.clipIdentityOf(S.getState().project).identityKeys[clipId] ?? null;
      const gate = document.querySelector('[data-pc="probe-gate"]')?.innerText?.replace(/\s+/g, ' ') ?? null;
      return { src, key, gate };
    }, CARD_ID, userClipOf);
    const beforeState = await pageCardState();
    out.keyBefore = beforeState.key;
    check(beforeState.src?.includes(cfg.card.v1), '[observer] 改卡前 B 页面里是 v1');
    const stageHas = async (text) => {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        try { if (await f.evaluate((t) => document.body?.innerText?.includes(t) ?? false, text)) return true; } catch { /* 导航中 */ }
      }
      return false;
    };
    out.stageV1 = await stageHas(cfg.card.v1);

    // ---- 计时起点:拿到 editready 之后、写 observer.joined 之前(上界)
    // 改卡会让舞台整页重载(日志随之清空):在那之前收媒体日志
    await collectMediaLogs();
    await store.wait('editready', '创建者可以改卡');
    const t0 = Date.now();
    await store.put('observer.joined', { at: t0 });
    let editedSeen = null;
    void store.wait('edited', '创建者改完', 120_000).then((v) => { editedSeen = { ms: Date.now() - t0, ok: v?.ok ?? null, editMs: v?.ms ?? null }; }, () => {});
    const installedAt = await until('[observer] B 装上 v2', async () => ((await bSource())?.source?.includes(cfg.card.v2) ? Date.now() : null), 30_000, 100);
    out.installMs = installedAt ? installedAt - t0 : null;
    const hmrAt = await until('[observer] B 页面热更新到 v2', async () => ((await pageCardState()).src?.includes(cfg.card.v2) ? Date.now() : null), 30_000, 100);
    out.hmrMs = hmrAt ? hmrAt - t0 : null;
    let remeasure = null;
    let keyAfter = null;
    let gateSeen = null;
    let recordedAt = null;
    const tr = Date.now();
    while (Date.now() - tr < 60_000) {
      const s = await pageCardState().catch(() => null);
      if (s) {
        keyAfter = s.key;
        if (s.gate && !gateSeen) gateSeen = { at: Date.now(), text: s.gate };
        if (s.key && s.key !== out.keyBefore) {
          if (!remeasure && gateSeen) remeasure = { at: gateSeen.at, via: 'gate' };
          const costs = await getJson(`${B.origin}/api/data/costs`).catch(() => null);
          if ((costs?.costs ?? []).some((r) => r.identityKey === s.key)) { recordedAt = Date.now(); if (!remeasure) remeasure = { at: recordedAt, via: 'record' }; break; }
        }
      }
      await delay(100);
    }
    out.keyAfter = keyAfter;
    out.remeasureMs = remeasure ? remeasure.at - t0 : null;
    out.remeasureVia = remeasure?.via ?? null;
    out.newCostRecordMs = recordedAt ? recordedAt - t0 : null;
    const stageAt = await until('[observer] B 舞台画出 v2', async () => ((await stageHas(cfg.card.v2)) ? Date.now() : null), 15_000, 200);
    out.stageMs = stageAt ? stageAt - t0 : null;
    out.editedSeen = editedSeen;
    const st = await getJson(`${B.origin}/api/cards/sync/status`).catch(() => null);
    out.bRecord = st?.records?.[cfg.card.rel] ?? null;
    out.bNotices = (st?.notices ?? []).map((n) => ({ type: n.type, key: n.key, rev: n.rev }));
    const overrideSrc = (() => { try { return fs.readFileSync(path.join(overrides, cfg.card.rel), 'utf8'); } catch { return null; } })();
    out.bOverrideV2 = !!overrideSrc?.includes(cfg.card.v2);
    out.bKindAfter = await P(page, () => window.__pcSyncTest?.view().kind ?? null).catch(() => null);
    await page.screenshot({ path: path.join(OUT, `${run}-observer-3-v2.png`) });
    out.shots = ['1-small', '2-original', '3-v2'].map((s) => path.join(OUT, `${run}-observer-${s}.png`)).filter((f) => fs.existsSync(f));
    out.pageErrors = pageErrors.slice(0, 5);

    check(out.installMs !== null, `[observer] 装上 v2(installMs=${out.installMs},只记录;耗时只记录,不当闸门(verification.md,2026-10-07 用户改定);2026-10-23 探针总审改)`);
    check(out.hmrMs !== null, '[observer] B 页面热更新到 v2');
    if (out.remeasureMs === null) fails.push('[observer] b-no-remeasure');
    else say('observer.remeasureMs', { ms: out.remeasureMs }); // 重测用时只记录(耗时只记录,不当闸门(verification.md,2026-10-07 用户改定);2026-10-23 探针总审改)
    check(keyAfter && keyAfter !== out.keyBefore, '[observer] 用户卡片段的身份键变了');
    check(out.stageMs !== null, '[observer] B 的舞台画出 v2');
    check(out.bOverrideV2, '[observer] v2 装进 B 的改动层');
    check(out.bNotices.some((n) => n.type === 'installed' && n.key === cfg.card.rel && n.rev >= 2), '[observer] B 有 installed 通知(rev ≥ 2)', out.bNotices);
    check(out.bKindAfter === 'shared', '[observer] B 仍在共享项目里', out.bKindAfter);
  } catch (error) {
    fails.push(`observer 出错:${String(error?.message ?? error).slice(0, 600)}`);
    say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
  } finally {
    try { await browser?.close(); } catch { /* 已关 */ }
    saveEditorLogs(OUT);
    for (const c of children) { killTree(c); await exited(c); }
    card?.cleanup(cfg?.card?.id ?? '');
    if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄没放 */ } } else out.temp = TMP;
    try { await store.put('observer', { ...out, ok: fails.length === 0, fails }); } catch (e) { fails.push(`结果交不回协调口:${e?.message ?? e}`); }
  }
}

/* ================================================================== host */

async function runHost(out) {
  const M = await mods();
  const run = await resolveRun('host');
  out.run = run;
  const store = kv(run);
  const port = Number(arg('--port', DEFAULT_PORT.host));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c66t9-host-'));
  const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-c66t9-${run}`, 'host')));
  fs.mkdirSync(OUT, { recursive: true });
  out.port = port;
  let child = null;
  let lines = [];
  let card = null;
  let cfg = null;
  let conn = null;
  try {
    cfg = await store.wait('config', '创建者的配置');
    let docUrl = cfg.ws;
    if (cfg.place === 'lan') {
      const found = await discoverLanBase(M, cfg);
      out.discovery = found.discovery;
      check(found.discovery.found, '[host] 经局域网发现找到局域网主机', found.discovery);
      docUrl = found.base;
    }
    // 主机靠卡片同步拿到它,不往检出里预写(c66-host-cards);同步来的卡只进主机的改动层(卡片改动层修复)。
    // repoCard 只用来记「本检出里原来有没有这张卡」、收尾照旧只删本探针写过的
    card = repoCard(cfg.card.rel);
    out.cardInRepoBefore = card.existedBefore;
    for (const p of [port, port + 1, port + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
    const configFile = path.join(TMP, 'host-shared.json');
    fs.writeFileSync(configFile, JSON.stringify([{ url: docUrl, projectId: cfg.projectId, username: 'render-host', password: cfg.memberPassword, as: 'member', role: 'render',
      deviceId: `c66t9-host-${run}`.padEnd(16, '0'), deviceName: 'c66-t9 render host', maxConcurrent: 2 }]));
    const env = { ...process.env };
    for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_TEST_CODE_VERSION']) delete env[key];
    child = fork(path.join(ROOT, 'cloud', 'scripts', 'render-host.mjs'), ['--config', configFile, '--port', String(port), '--data', path.join(TMP, 'data')],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let exitLine = null;
    const keep = (c) => {
      for (const line of c.toString().split('\n')) {
        if (!line.trim()) continue;
        lines.push(line); if (lines.length > 400) lines.shift();
        if (line.startsWith('[render-host] exit ')) { try { exitLine = JSON.parse(line.slice('[render-host] exit '.length)); } catch { /* 半行 */ } }
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const ready = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 360_000);
      child.on('message', (m) => { if (m?.type === 'ready') { clearTimeout(t); resolve(m); } });
      child.once('exit', () => { clearTimeout(t); resolve(null); });
    });
    if (!check(ready, '[host] render-host 起来了', lines.slice(-6))) throw new Error('render-host 没起来');
    out.readyQueue = { profile: ready.queue?.profile ?? null, nodes: ready.queue?.nodes?.length ?? null, maxConcurrent: ready.queue?.maxConcurrent ?? null,
      codeVersion: ready.queue?.codeVersion?.slice?.(0, 12) ?? null };
    await store.put('host.ready', { at: Date.now(), port });
    say('host.ready', out.readyQueue);
    const editorUrl = `http://127.0.0.1:${port}`;
    const hostOverlay = path.join(TMP, 'data', 'data', 'card-overrides', cfg.card.rel);
    const effective = () => { try { return fs.readFileSync(fs.existsSync(hostOverlay) ? hostOverlay : path.join(ROOT, cfg.card.rel), 'utf8'); } catch { return null; } };
    const syncOf = async () => (await getJson(`${editorUrl}/api/frames/queue`, 30_000).catch(() => null))?.cardSync?.[0] ?? null;
    // 主机经内容库 card-source 同步到了探针卡(记账里有它,rev ≥ 1)
    const synced = await until('[host] 卡片同步记下了探针用户卡', async () => {
      const cs = await syncOf();
      return cs?.enabled && (cs.records?.[cfg.card.rel] ?? 0) >= 1 ? cs : null;
    }, 60_000, 500);
    out.cardSync = synced ? { connected: synced.connected, rev: synced.records?.[cfg.card.rel] ?? null, notices: (synced.notices ?? []).map((n) => n.type) } : null;
    check(synced?.enabled === true, '[host] 主机开着卡片同步', synced);
    check(effective()?.includes(cfg.card.v1), '[host] 主机上生效的探针卡是 v1', { overlay: fs.existsSync(hostOverlay) });
    // 卡片改动层修复之后:主机本来没有的卡只进改动层,不写检出目录(跨机时本检出里原来没有它)
    if (!card.existedBefore) check(fs.existsSync(hostOverlay) && !fs.existsSync(path.join(ROOT, cfg.card.rel)), '[host] 同步来的新卡只进主机的改动层、检出目录里没有多出它',
      { overlay: fs.existsSync(hostOverlay), inCheckout: fs.existsSync(path.join(ROOT, cfg.card.rel)) });

    const plan = await store.wait('plan', '创建者的 plan 落定', 20 * 60_000);
    const editor = `http://127.0.0.1:${port}`;
    const q = await getJson(`${editor}/api/frames/queue`, 30_000).catch(() => null);
    const n = q?.nodes?.[0] ?? {};
    Object.assign(out, { profile: q?.profile ?? null, claimed: n.claimed ?? null, completed: n.completed ?? null, dedup: n.dedup ?? null, failed: n.failed ?? null,
      lost: n.lost ?? null, connected: n.connected ?? null, assetBase: n.assetBase ?? null, codeVersion: q?.codeVersion?.slice?.(0, 12) ?? null });
    out.plan = { planId: plan.planId, tasks: plan.tasks, done: plan.done };
    check(out.profile === 'host', '[host] 诊断里 profile 是 host', out.profile);
    out.creatorCodeVersion = plan.creatorCodeVersion?.slice?.(0, 12) ?? null;
    check(!plan.creatorCodeVersion || q?.codeVersion === plan.creatorCodeVersion, '[host] 代码版本与创建者相同(用户卡不进代码版本)', { host: out.codeVersion, creator: out.creatorCodeVersion });
    check(out.claimed >= 1, '[host] 认领了创建者发布的细任务', out.claimed);
    check((out.completed ?? 0) + (out.dedup ?? 0) >= 1, '[host] 完成了细任务', { completed: out.completed, dedup: out.dedup });
    check(!out.failed, '[host] 没有失败的任务', out.failed);
    const counts = Object.values(plan.doneCounts ?? {});
    out.doneCounts = { tasks: counts.length, exactlyOnce: counts.filter((c) => c === 1).length, missing: counts.filter((c) => c === 0).length, duplicate: counts.filter((c) => c > 1).length };
    check(counts.length > 0 && counts.every((c) => c === 1), '[host] 每个细任务恰好一次 task.done', plan.doneCounts);

    // ---- 产物在托管端:每个快照细任务的清单在内容库、清单里的块都在素材服务
    conn = await openConn(M, { url: cfg.ws, projectId: cfg.projectId, username: 'render-host-check', password: cfg.memberPassword, tag: 'host-check' });
    const cli = conn.client('r');
    const art = { manifests: 0, missingManifests: [], blocks: 0, missingBlocks: [] };
    const seen = new Set();
    for (const id of plan.derived ?? []) {
      const m = /^(snapshot|stream):(.+)$/.exec(id);
      if (!m) continue;
      const kind = m[1] === 'snapshot' ? 'snapshot-manifest' : 'render-manifest';
      const item = await conn.rpc({ type: 'content.get', kind, key: m[2] }).catch((e) => ({ error: String(e?.message ?? e) }));
      if (item.type !== 'content.item' || item.missing || !item.body) { art.missingManifests.push(id); continue; }
      art.manifests++;
      const blocks = [];
      for (const f of item.body.frames ?? []) if (Array.isArray(f) && typeof f[1] === 'string') blocks.push(['snap', f[1]]);
      for (const f of item.body.pngs ?? []) if (Array.isArray(f) && typeof f[1] === 'string') blocks.push(['px', f[1]]);
      for (const [ns, h] of blocks) {
        if (seen.has(`${ns}:${h}`)) continue;
        seen.add(`${ns}:${h}`);
        art.blocks++;
        const has = await cli.has(ns, h).catch(() => false);
        if (!has) art.missingBlocks.push(`${ns}:${h.slice(0, 12)}`);
      }
    }
    out.artifacts = { manifests: art.manifests, missingManifests: art.missingManifests.length, blocks: art.blocks, missingBlocks: art.missingBlocks.slice(0, 10) };
    check(art.manifests > 0 && art.missingManifests.length === 0, '[host] 每个细任务的清单都在托管端内容库', art.missingManifests.slice(0, 5));
    check(art.blocks > 0 && art.missingBlocks.length === 0, '[host] 清单里的块都在托管端素材服务', art.missingBlocks.slice(0, 5));

    // ---- 创建者改卡(v1 → v2)之后,主机按 content.watch 当场装上 v2。观察端没走到改卡那一步时(创建者不改)记为跳过
    let edited = null;
    const editEnd = Math.min(Date.now() + 20 * 60_000, deadline);
    while (!edited && Date.now() < editEnd) {
      edited = await store.get('edited', 5000).catch(() => null);
      if (!edited && ((await store.get('observer', 0).catch(() => null)) || (await store.get('abort', 0).catch(() => null)))) break;
    }
    if (edited?.ok) {
      const t0 = Date.now();
      const v2 = await until('[host] 创建者改卡后主机装上 v2', async () => {
        const cs = await syncOf();
        return (cs?.records?.[cfg.card.rel] ?? 0) >= 2 && effective()?.includes(cfg.card.v2) ? cs : null;
      }, 15_000, 200);
      out.cardV2 = { ms: v2 ? Date.now() - t0 : null, rev: v2?.records?.[cfg.card.rel] ?? null, inOverlay: fs.existsSync(hostOverlay),
        baseUntouched: card.existedBefore ? fs.readFileSync(path.join(ROOT, cfg.card.rel), 'utf8').includes(cfg.card.v1) : null };
      if (card.existedBefore) check(out.cardV2.inOverlay && out.cardV2.baseUntouched, '[host] v2 装进主机自己的改动层,检出里的那份不动', out.cardV2);
      else check(out.cardV2.inOverlay && !fs.existsSync(path.join(ROOT, cfg.card.rel)), '[host] v2 装进主机自己的改动层,检出目录里仍没有这张卡', out.cardV2);
    } else {
      out.cardV2 = { skipped: edited ? '创建者改卡失败' : '创建者没改卡(观察端没走到那一步)' };
    }

    child.send({ type: 'shutdown' });
    out.exitCode = await exited(child, 60_000);
    out.released = exitLine?.released ?? null;
    check(out.exitCode === 0, '[host] render-host 经 IPC 正常退出(退出码 0)', { exitCode: out.exitCode, tail: lines.slice(-4) });
  } catch (error) {
    fails.push(`host 出错:${String(error?.message ?? error).slice(0, 600)}`);
    say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
  } finally {
    try { await conn?.close(); } catch { /* 已关 */ }
    if (child && child.exitCode === null) { killTree(child); await exited(child); }
    try { fs.writeFileSync(path.join(OUT, 'render-host.log'), lines.join('\n')); } catch { /* 写不了不影响结论 */ }
    card?.cleanup(cfg?.card?.id ?? '');
    if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄没放 */ } } else out.temp = TMP;
    try { await store.put('host', { ...out, ok: fails.length === 0, fails }); } catch (e) { fails.push(`结果交不回协调口:${e?.message ?? e}`); }
  }
}

/* ================================================================== all */

async function runAll(out) {
  const run = arg('--run', null) ?? newRunId();
  out.run = run;
  const outDir = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-c66t9-${run}`)));
  const common = ['--hosted', HOSTED, '--coord', COORD, '--run', run, '--timeout-min', String(Number(arg('--timeout-min', 25))), ...(KEEP ? ['--keep-temp'] : []),
    ...(OBSERVER_THROTTLE ? ['--observer-throttle', String(OBSERVER_THROTTLE)] : []),
    '--place', PLACE, '--heavy', HEAVY_MODE, ...['--lan-ip', '--lan-host'].flatMap((n) => (arg(n, null) !== null ? [n, arg(n)] : []))];
  const roles = ['creator', 'observer', 'host'];
  const basePort = Number(arg('--port', DEFAULT_PORT.creator));
  if (!Number.isInteger(basePort) || basePort < 1 || basePort + 8 > 65535) throw new Error('--port 需给三组连续编辑器端口留出 9 个端口');
  const results = await Promise.all(roles.map((role) => new Promise((resolve) => {
    // 集成时合两边:给了 --port-base 就用它(c66-host-cards),没给就把 --port 当起点(c66-plan-timing,缺省 5590);两者缺省一致
    const base = arg('--port-base', null);
    const port = (base !== null ? Number(base) : basePort) + roles.indexOf(role) * 3;
    const c = spawn(process.execPath, [SELF, '--role', role, '--port', String(port), '--out', path.join(outDir, role), ...common],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    let stdout = '';
    c.stdout.on('data', (d) => { stdout += d.toString(); });
    c.stderr.on('data', (d) => process.stderr.write(d));
    c.once('exit', (code) => {
      const last = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
      let line = null;
      try { line = JSON.parse(last); } catch { line = { role, ok: false, fails: [`没有结果行(退出码 ${code})`] }; }
      resolve({ role, code, line });
    });
  })));
  for (const r of results) {
    out[r.role] = r.line;
    for (const f of r.line?.fails ?? []) fails.push(`${r.role}: ${f}`);
    if (!r.line?.ok) check(false, `${r.role} ok`, { code: r.code });
  }
}

/* ================================================================== 入口 */

const out = { role: ROLE };
if (!['creator', 'observer', 'host', 'all'].includes(ROLE)) {
  process.stderr.write('用法见文件头:--role creator | observer | host | all\n');
  process.exitCode = 2;
} else {
  try {
    if (ROLE === 'creator') await runCreator(out);
    else if (ROLE === 'observer') await runObserver(out);
    else if (ROLE === 'host') await runHost(out);
    else await runAll(out);
  } catch (error) {
    fails.push(`出错:${String(error?.message ?? error).slice(0, 600)}`);
  }
  out.ms = Date.now() - started;
  out.fails = fails;
  out.ok = fails.length === 0;
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = out.ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 10_000).unref();
}
