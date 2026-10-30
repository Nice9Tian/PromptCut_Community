/**
 * M8 端到端编排探针：E1、E2、E3、E4、E6（计划 `docs/plan/m8-plan.md` 第 1 版第 2.1 节、第 2.6 节 C2 / C4、第 4 节第 4 项，
 * 末尾「主会话裁定」D1～D12）。公共件在 `scripts/probes/m8/`（用法见 `docs/archive/agent-reports/AGENT-m8-kit.md` 第 5 节）。
 *
 * 用到的代号：E1～E6 是任务书第 6 节的端到端用例；J-全完 / J-恰一 / J-纯层 是计划第 2 节开头的三条共用判据
 * （任务全部完成、每个任务恰好一次 `task.done`、没有一层混两种指纹）；D2 = 局域网主机的「素材服务重启」按重启整个编辑器进程算；
 * D3 = 「恰好一次」按 epoch 数；D12 = E6 的第二种指纹，测试开关与纯浏览器节点两种都做；C2 = 云端 `pm2 restart`；
 * C4 = 放本机时重启 PC 的局域网主机编辑器。
 *
 * 角色经协调口 KV（前缀 `m8e`，键名约定见 `m8/kv.mjs`）交换配置、信号与结果，不共享文件系统，可以在不同机器上跑。
 *
 * ## 放法（--place）
 *   cloud  项目建在 `--hosted` 的托管端（缺省阿里云主实例 https://203-0-113-16.sslip.io/hosted）。creator（PC）起编辑器
 *          （队列模式，以创建者、`role: 'render'` 连项目）当发布方与 PC 节点；host（笔记本）起独立渲染主机。
 *   lan    creator 以局域网主机起编辑器（`PROMPTCUT_LAN_HOST=1`，绑 0.0.0.0），在本机建局域网模式的项目并组播广播；
 *          host 经局域网发现（`--lan-host <ip:端口>` 可手填兜底）凭项目凭证进入。全程不连阿里云：
 *          creator 收尾时按本轮查：本轮项目名在 `--hosted` 的 `shared/lookup` 查不到（`m8/lib.mjs` 的 `judgeCloudUntouched`；
 *          前后两次 `/healthz` 的总连接数只记录、不判，别人进出会变）。
 *
 * ## 用例（--case）
 *   e1  抢活：PC 节点 + host-a + host-b 同时取活，真实细任务（缺省 10 条 × 10 s = 50 个）；
 *       判 J-全完、J-恰一、J-纯层、三方各完成 ≥ 1 且之和 = 任务数、产物按清单逐段取回 sha256 相符、
 *       与同指纹单机重渲逐字节相同（`--no-identical` 不做）；再跑一轮假细任务（缺省 50 个，`--fake-tasks 0` 不做）：
 *       三方各起一个假节点（专用指纹，真节点看不见这些任务），判同样三条。
 *   e2  半开断线接手：host-a 经代理（`--via-proxy`）连文档服务，第一次持有任务时让代理 stall（开着的连接只攒不转）；
 *       别的节点在 ≤ 37 s 内接手（旁观节点的时间线，从 creator 收到 KV 信号起算）；接手后 creator 写 `takeover`，
 *       host-a 让代理 resume，它手里那几个任务的旧认领一律 `lease-lost`，不产生第二次 `task.done`；J 三条。
 *       C1（笔记本断网 30 s，主会话 2026-09-28 更正为应用层做法，constraints.md「不动宿主机的网络」）：host 加 `--stall-s 30`，
 *       stall 固定秒数后自己 resume、不等接手；判「被接手（≤ 37 s）」或「会话保留期内接续、照常由受害方完成」两种都认，
 *       结果行 `victim.outcomes` 与 `victim.session.kind` 写明是哪一种。本探针不碰网卡、防火墙、代理设置、路由、DNS。
 *   e3  文档服务重启：有任务完成、主机持有任务时重启 ——
 *       cloud（C2）：creator 写 KV `signal.restart.request`、把要在远端执行的命令打到 stderr，等 KV `signal.restart.done`
 *       （由主会话执行 `pm2 restart` 后写，见下文「远端步骤」）；
 *       lan（C4，D2）：creator 结束自己起的局域网主机编辑器进程树，同端口再起。
 *       之后重新发布同一版项目；判 epoch 变了、J-全完、J-恰一（按 epoch，D3）、重启前已完成的任务重启后 0 次重渲
 *       （都走去重）；host 记素材服务地址的撤回与重新下发（lan：重连后 ≤ 10 s）。
 *       在线页面恢复同步、重启前最后一次提交可读（M8 报告第 7 节 C2 的判据，C4 同样适用）：用例开始时 creator 建一份单独的
 *       项目真身 `m8e3-<run>`（KV `signal.e3.doc`），host 立刻开成员 `page` 角色的副本（与 e4 同一个 `openReplica`，
 *       同样是 Node 里按页面协议维持的副本，不是浏览器页面）；重启前 creator 以 `page` 角色写一条无害字段，读回这一版的
 *       rev 与摘要放进 `signal.restart.request` 的 `lastCommit`（放本机也写这个信号，不带远端命令）。host 收到时记副本的
 *       rev（revBefore）；重启后副本由连接层自己建新会话、重新 `project.open`，要追到 rev ≥ lastCommit.rev，且重启之后
 *       见到的那一版摘要与 lastCommit.digest 相同（重启后又有写入、没见到那一版时退回核对写下的值）。host 结果行
 *       `e3.page { revBefore, revAfter, digestMatch, reconnectMs, reopens, … }`，检查 `page-resync-after-restart`、
 *       `last-commit-readable`；creator 汇总成 `page-resync-after-restart-<host>`、`last-commit-readable-<host>`。
 *   e4  Agent 突发修改：后台有一版真实任务在跑时，以 `agent` 角色（带对话号，`project.op` 带 `expectRev`）连项目，
 *       间隔 0 / 200 / 900 ms（`--gaps`）各一轮、每轮 `--burst` 次（缺省 50）；同时一个 `page` 角色的写入方每 100 ms 写一次
 *       （不带期望版本，逼出 `stale`）。Agent 遇 `stale` 重读（`project.open`）再写。每轮结束：文档服务的 rev 与摘要、
 *       PC 这边的副本、host 那边的副本（成员 `page` 角色，按 `project.ops` 应用）三份摘要相同；每轮 50 次都落地；
 *       突发期间后台至少完成 1 个细任务；最后 J-全完。
 *       「页面」是 Node 里按页面同一条协议维持的副本（`project.open` + `project.ops`），不是浏览器页面（见报告）。
 *   e6  两种指纹：host-a 用测试开关 `PROMPTCUT_TEST_ENV_FINGERPRINT`（`--fake-fingerprint`）报另一种指纹，
 *       PC 发布的这一版细任务它认领 0；J-全完、J-纯层。开关只在含 C10 集成的检出上生效：host 用公共件的
 *       `fingerprintApplied()` 判，不生效就整例记「跳过」与理由（不判失败）。反方向（笔记本主机先认领按清单发布的 plan，
 *       C10 契约第 18 节第 9 条）要 C10 的在线页面发布，本检出没有，记跳过理由。
 *       纯浏览器节点那种（D12 的 b，M7 交付）：`--browser-node` 只留接口，记跳过理由，M7 合入后接 M7 探针的节点角色。
 *
 * ## 命令
 *   node scripts/probes/m8-e-probe.mjs --role creator --case <e1|e2|e3|e4|e6> --place <cloud|lan> --coord <协调口>
 *        [--hosted <托管端>] [--port 5780] [--lan-ip <PC 局域网地址>] [--hosts host-a,host-b] [--run <id>]
 *        [--clips 10] [--seconds 10] [--fake-tasks 50] [--no-identical] [--check-port <端口>]
 *        [--burst 50] [--gaps 0,200,900] [--restart-after-done 5] [--browser-node] [--keep] [--band 5780-5789]
 *        [--out <目录>] [--timeout-min 40]
 *   node scripts/probes/m8-e-probe.mjs --role host --name host-a --case … --place … --coord <协调口> [--port 5583]
 *        [--lan-host <ip:端口>] [--via-proxy <代理监听端口>] [--proxy-target <host:port>] [--stall-prob 0]
 *        [--stall] [--stall-s <秒>] [--fake-fingerprint <16 位十六进制>] [--host-concurrency 2] [--band 5580-5599] [--run <id>] [--out <目录>]
 *        [--assert-no-lan <PC 局域网地址>]（异地接入：全程只读地数本机到这个地址、开始时没有的 TCP 连接（基线排除：开始时已有的不算，之后新出现的不论状态都算）、收尾前 3 s 局域网发现，都要 0；
 *        公共件 `m8/no-lan.mjs`）。结果行另有 `idsDetail`：本机每一次丢认领、失败、丢弃的时刻与原因
 *   node scripts/probes/m8-e-probe.mjs --role watcher --coord <协调口> [--run <id>]        （可选：另一台机器上的旁观节点）
 *   node scripts/probes/m8-e-probe.mjs --role signal --coord <协调口> --run <id> --name <信号名> [--value '<json>']
 *   node scripts/probes/m8-e-probe.mjs --role all --case … --place <lan|cloud> [--lan-ip …]    本机替身（见下）
 *
 *   --role all：本机替身。起进程内协调口（开信箱，令牌现场生成）、本机临时托管组合（放云端时它就是托管端；放本机时只用来
 *   判「全程不连托管端」），再以子进程跑 creator（5740～5742）、host-a（5743～5745）、host-b（5746～5748）、代理 5749；
 *   端口段 5740～5749。放云端的 e3 由本进程在收到 `restart.request` 后同端口重启托管组合、写 `restart.done`。
 *
 * ## 远端步骤（主会话执行；探针不连阿里云做破坏性操作）
 *   e3 放云端：creator 打出一行 `{"step":"remote-step", …}`，含要执行的命令与写回信号的命令，形如
 *     ssh <远端> "pm2 restart promptcut-hosted && pm2 describe promptcut-hosted"
 *     node scripts/probes/m8-e-probe.mjs --role signal --coord <协调口> --run <id> --name restart.done
 *   主会话也可以自己盯 KV `m8e.<run>.signal.restart.request`。
 *
 * ## KV 键（`m8e.<run>.<名>`）
 *   config                creator → 各方：放法、成员地址与口令、项目名与 id、PC 节点指纹与代码版本、本轮参数
 *   ready.<host>          host → creator：环境指纹、代码版本、测试指纹是否生效、发现方式
 *   signal.holding.<host> host → creator：e3 时手里有任务了
 *   signal.stall          host → creator：e2 时代理已 stall（带持有的任务 id）
 *   signal.takeover       creator → host：e2 时被扣住的任务都已被别人接手，可以 resume
 *   signal.e3.doc / signal.restart.request（带 lastCommit）/ signal.restart.done / signal.restarted   e3
 *   signal.fake.start / signal.fake.done                              e1 的假任务那一轮
 *   signal.e4.round.<k> / signal.e4.replica.<host>.<k>                e4 每轮的摘要核对
 *   result.<角色>、abort、done
 *
 * 端口：编辑器与独立渲染主机各占「端口、+1、+2」。缺省 PC creator 5780、笔记本 host 5583 / 5586、代理 5596（计划第 1.3 节）；
 *   本机替身 5740～5749。经 `m8/lib.mjs` 的 `checkPorts` 核对，不碰 5190～5192、5203～5205。
 * 令牌：协调口开了信箱时 KV 要 `PROBE_MAIL_TOKEN`（只从环境变量取）；口令只进 KV 与各角色 `--out` 下的配置文件，不进输出。
 * 输出：过程写 stderr（一行一条 JSON）；stdout 最后一行是结果行（`m8/lib.mjs` 的形状），ok 为假退出码 1，参数不对 2。
 *   用例因前置不满足而跳过时 `skipped` 写明理由，ok 为真。
 */
import '../lib/no-user-dirs.mjs';
import '../lib/test-silent-processes.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  argsOf, createResult, mergeRoleResults, sayer, newRunId, fingerprintOf, fakeLayerTasks, judgeAllDone, judgeExactlyOnce,
  judgePureLayers, layerObservations, judgeEachWorked, summarizeTimeline, takeoverMs, placeParams, docTargetOf, CLOUD, judgeLastCommit,
  judgeCloudUntouched, realTasksThreshold,
} from './m8/lib.mjs';
import { roleKv, resolveRun, kvClient, kvKey } from './m8/kv.mjs';
import { startHostedCombo, startCoord, startProxy, startRenderHost, startQueueEditor, runRole, until, portFree } from './m8/procs.mjs';
import { sharedEntry, createProbeProject, deleteProbeProject, openConn, startFakeNode, startFakePublisher } from './m8/conn.mjs';
import { startNoLanWatch } from './m8/no-lan.mjs';

const SELF = fileURLToPath(import.meta.url);
const PREFIX = 'm8e';
const PROBE = 'm8-e-probe';
const CASES = ['e1', 'e2', 'e3', 'e4', 'e6'];
const FPS = 30;
/** 本机替身的端口段与各角色端口 */
const LOCAL_BAND = [5740, 5749];
const LOCAL_PORTS = { creator: 5740, 'host-a': 5743, 'host-b': 5746, proxy: 5749 };
/** 跨机缺省端口（计划第 1.3 节：PC 5780～5789，笔记本 5580～5599） */
const DEFAULT_PORTS = { creator: 5780, host: 5583 };
/** 各用例缺省的主机 */
const DEFAULT_HOSTS = { e1: ['host-a', 'host-b'], e2: ['host-a', 'host-b'], e3: ['host-a'], e4: ['host-a'], e6: ['host-a'] };
/** 各用例缺省的时间轴（条数 × 秒）：每条 seconds × 30 / 60 个细任务 */
const DEFAULT_TIMELINE = { e1: [10, 10], e2: [6, 10], e3: [6, 10], e4: [10, 10], e6: [4, 10] };
/** E2 接手的上限（X6 的口径：租约 30 s + 扫描 5 s + 2 s） */
const TAKEOVER_LIMIT_MS = 37_000;
/** C4 的口径：重连后素材服务地址的重新下发 */
const REANNOUNCE_LIMIT_MS = 10_000;

const { arg, flag } = argsOf();
const ROLE = arg('--role', null);
const CASE = arg('--case', null);
const PLACE = arg('--place', 'cloud');
const NAME = ROLE === 'host' ? arg('--name', 'host-a') : ROLE;
const say = sayer(PROBE, NAME ?? 'none');
const TIMEOUT_MS = Number(arg('--timeout-min', 40)) * 60_000;
const deadline = Date.now() + TIMEOUT_MS;
const COORD = arg('--coord', null);
const BAND = arg('--band', null) ? String(arg('--band')).split('-').map(Number) : null;
const [CLIPS, SECONDS] = [Number(arg('--clips', (DEFAULT_TIMELINE[CASE] ?? [4, 10])[0])), Number(arg('--seconds', (DEFAULT_TIMELINE[CASE] ?? [4, 10])[1]))];
/** 假任务那一轮的专用指纹：真节点（PC、独立渲染主机）的指纹都不是它，前置过滤让它们看不见这些任务 */
const FAKE_FP = fingerprintOf('m8e-fake-tasks');
/** e6 缺省的「另一种指纹」 */
const E6_FP = fingerprintOf('m8e-e6-Y');

/* ================================================================== 小工具 */

async function getJson(url, timeoutMs = 30_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}
async function postJson(url, body, timeoutMs = 30_000) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const errText = (e) => String(e?.message ?? e).slice(0, 600);
const outDirOf = (run, role) => path.resolve(arg('--out', path.join(os.tmpdir(), `pc-m8e-${run}`)), role);

/** 本机的局域网地址（`lan/discovery.mjs` 的选网卡规则：已启用、非回环、非链路本地、IPv4） */
async function autoLanIp() {
  const { selectInterfaces } = await import('../../server/lan/discovery.mjs');
  return selectInterfaces()[0]?.address ?? null;
}

/** 探针项目：clips 条轨道各一段 seconds 秒的 r6-canvas（共享档，参数带盐，结果键全新） */
function probeProject({ id, clips, seconds, salt }) {
  return {
    id, name: 'M8 E 探针', width: 1920, height: 1080, fps: FPS, duration: seconds,
    themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks: Array.from({ length: clips }, (_, i) => ({
      id: `tr-${i + 1}`, name: `tr-${i + 1}`, hidden: false,
      clips: [{ id: `clip-canvas-${i + 1}`, kind: 'card', cardId: 'r6-canvas', start: 0, end: seconds, params: { probeSalt: `${salt}-${i + 1}` } }],
    })),
  };
}

/** 等 KV 的某个键，期间看到 done / abort 就回 null */
async function waitKv(kv, name, { timeoutMs = TIMEOUT_MS, stopOn = ['done', 'abort'] } = {}) {
  const end = Math.min(deadline, Date.now() + timeoutMs);
  while (Date.now() < end) {
    const v = await kv.get(name, Math.max(1, Math.min(5000, end - Date.now()))).catch(() => null);
    if (v !== null && v !== undefined) return v;
    for (const s of stopOn) if (await kv.get(s, 0).catch(() => null)) return null;
  }
  return null;
}

/* ================================================================== 旁观节点 */

/**
 * 旁观节点（只收不认领）：同 `m8/conn.mjs` 的 startWatcher，另记每个任务的 `requires.envFingerprint`（J-纯层用）。
 * 会话结束后重建时重新报到、重新订阅（lan 的 e3 要跨过编辑器重启）。
 */
async function openWatch({ entry, projects, nodeId }) {
  const conn = await openConn({ entry, role: 'render', tag: 'watcher', log: say });
  if (!conn) throw new Error('旁观节点连不上项目');
  const timeline = new Map();
  const requires = new Map();
  const epochs = [];
  let opens = 0;
  const push = (id, ev) => { if (!timeline.has(id)) timeline.set(id, []); timeline.get(id).push({ t: Date.now(), ...ev }); };
  const seeTask = (t) => { if (t?.id && !requires.has(t.id)) requires.set(t.id, t.requires?.envFingerprint ?? null); };
  conn.ep.onMessage((m) => {
    if (typeof m?.epoch === 'string' && !epochs.includes(m.epoch)) epochs.push(m.epoch);
    if (m?.type === 'task.taken' && typeof m.id === 'string') push(m.id, { ev: 'taken', version: m.version ?? null });
    else if (m?.type === 'task.opened' && typeof m.task?.id === 'string') { seeTask(m.task); push(m.task.id, { ev: 'opened', version: m.task.version ?? null }); }
    else if (m?.type === 'task.closed' && typeof m.id === 'string') push(m.id, { ev: 'closed', state: m.state ?? null });
    else if (m?.type === 'queue.snapshot') for (const t of m.tasks ?? []) if (t?.id) { seeTask(t); push(t.id, { ev: 'opened', version: t.version ?? null, snapshot: true }); }
  });
  const hello = async () => {
    opens += 1;
    const h = await conn.rpc({ type: 'node.hello', nodeId, profile: 'pc', codeVersions: [], capabilities: {}, maxConcurrent: 1 });
    const w = await conn.rpc({ type: 'queue.watch', projects });
    if (w.type !== 'queue.snapshot') throw new Error(`queue.watch 回 ${w.type} ${w.reason ?? ''}`);
    return { hello: h.type, watch: w.type };
  };
  const first = await hello();
  conn.ep.onOpen(() => { hello().catch((e) => say('watcher.rehello-failed', { message: errText(e) })); });
  return {
    first, timeline, requires, epochs,
    get opens() { return opens; },
    events: (id) => timeline.get(id) ?? [],
    anyTaken: (ids) => ids.some((id) => (timeline.get(id) ?? []).some((e) => e.ev === 'taken')),
    close: () => conn.close(),
  };
}

/* ================================================================== 发布一版真实任务（creator） */

/** 推镜像 → preload；回 preload 的首个回包 */
async function pushAndPreload(ed, session, project) {
  await ed.prerender();
  const pushed = await postJson(`${ed.url}/api/data/project`, { session, localRev: 1, project });
  if (!pushed.ok) throw new Error(`项目推不进镜像：${JSON.stringify(pushed.body).slice(0, 200)}`);
  const pre = await ed.prerender();
  await until(async () => (await getJson(`${pre}/api/data/project?session=${session}&localRev=1`, 5000)).ok || null, 30_000, 300);
  const first = await postJson(`${pre}/api/frames/preload`, { session, localRev: 1 }, 120_000);
  if (!first.ok) throw new Error(`preload 没开跑：${JSON.stringify(first.body).slice(0, 200)}`);
  return first.body;
}

/** 编辑器诊断的一份快照（发布前记下，用来只算这一版的差值） */
async function queueBaseline(ed) {
  const q = (await ed.queue()) ?? {};
  return {
    at: Date.now(),
    planIds: new Set((q.published ?? []).map((p) => p.planId)),
    applied: (q.stats?.applied ?? 0) + (q.stats?.applyErrors ?? 0),
    applyErrors: q.stats?.applyErrors ?? 0,
    doneCounts: { ...(q.doneCounts ?? {}) },
    local: Object.fromEntries(['claimed', 'completed', 'dedup', 'failed'].map((k) => [k, new Set(q.local?.[k] ?? [])])),
  };
}

/**
 * 等这一版切出的细任务全部落定、清单拉完。`since` 给了就只认那之后发布的 plan（e3 放云端：重连后 plan id 可能不变）。
 * 期间每 2 s 再打一次 preload（保活，同 ht-w-probe）。
 */
async function waitSettled(ed, { session, base, since = null, timeoutMs = TIMEOUT_MS }) {
  let lastStatus = null;
  const pre = await ed.prerender();
  const settled = await until(async () => {
    const st = await postJson(`${pre}/api/frames/preload`, { session, localRev: 1 }, 120_000).catch(() => null);
    if (st?.body?.status) lastStatus = st.body.status;
    const q = await ed.queue();
    const mine = (q?.published ?? []).filter((p) => (since !== null ? p.at >= since : !base.planIds.has(p.planId))).at(-1);
    const derived = mine ? q.plans?.[mine.planId] : null;
    if (!Array.isArray(derived) || derived.length === 0) return null;
    const states = derived.map((id) => q.tasks?.[id]?.state ?? 'pending');
    return states.every((s) => s === 'done' || s === 'failed') ? { planId: mine.planId, derived, states } : null;
  }, Math.min(timeoutMs, Math.max(1000, deadline - Date.now())), 2000);
  if (!settled) return { ok: false, lastStatus };
  await until(async () => {
    const s = (await ed.queue())?.stats ?? {};
    return (s.applied ?? 0) + (s.applyErrors ?? 0) - base.applied >= settled.derived.length || null;
  }, 180_000, 1000);
  const q = (await ed.queue()) ?? {};
  const inPlan = (ids, kind) => (ids ?? []).filter((id) => settled.derived.includes(id) && !base.local[kind].has(id));
  return {
    ok: true, lastStatus, planId: settled.planId, derived: settled.derived, states: settled.states,
    failed: settled.derived.filter((_, i) => settled.states[i] === 'failed').map((id) => ({ id, error: q.tasks?.[id]?.error ?? null })),
    doneCounts: Object.fromEntries([settled.planId, ...settled.derived].map((id) => [id, (q.doneCounts?.[id] ?? 0) - (base.doneCounts[id] ?? 0)])),
    pc: { claimed: inPlan(q.local?.claimed, 'claimed'), completed: inPlan(q.local?.completed, 'completed'), dedup: inPlan(q.local?.dedup, 'dedup'),
      planClaimed: (q.local?.claimed ?? []).includes(settled.planId) },
    stats: q.stats ?? null,
    applyErrors: (q.stats?.applyErrors ?? 0) - (base.applyErrors ?? 0),
  };
}

/* ================================================================== 产物取回与单机重渲比较（e1） */

/** 按清单逐段取回：每个细任务的清单在内容库，清单里的块都能从素材服务取回且 sha256 相符（client.get 自己核哈希） */
async function fetchArtifacts(entry, derived) {
  const [{ createTicketSource }, { createAssetClient }, { watchServiceEndpoints }] = await Promise.all([
    import('../../server/auth/ticket-source.mjs'), import('../../server/asset-store/client.mjs'), import('../../server/render-node/endpoint.mjs')]);
  const conn = await openConn({ entry, role: 'page', tag: 'checker', log: say });
  if (!conn) return { error: '连不上项目' };
  try {
    const assetUrl = await new Promise((resolve) => {
      const t = setTimeout(() => { stop(); resolve(null); }, 8_000);
      const stop = watchServiceEndpoints(conn.ep, ['asset'], (list) => {
        const u = list.find((e) => e.kind === 'asset' && Array.isArray(e.urls) && e.urls.length)?.urls[0];
        if (u) { clearTimeout(t); stop(); resolve(u); }
      });
    });
    // 局域网主机不登记素材服务（只在设了 PROMPTCUT_DOCSERVICE_URL 时登记）：同 hostAssetClient，从文档服务地址推同一进程的素材服务
    const derivedBase = (() => { const u = new URL(entry.url); return `${/^(wss|https):/.test(u.protocol) ? 'https:' : 'http:'}//${u.host}/api/asset`; })();
    const base = assetUrl ?? derivedBase;
    const client = createAssetClient({ base, ticket: createTicketSource(conn.ep, { access: 'r' }), timeoutMs: 120_000 });
    const art = { assetUrl: base, announced: !!assetUrl, manifests: 0, missingManifests: [], blocks: 0, bytes: 0, badBlocks: [] };
    const seen = new Set();
    for (const id of derived) {
      const m = /^(snapshot|stream):(.+)$/.exec(id);
      if (!m) continue;
      const item = await conn.rpc({ type: 'content.get', kind: m[1] === 'snapshot' ? 'snapshot-manifest' : 'render-manifest', key: m[2] }, 30_000).catch((e) => ({ error: errText(e) }));
      if (item.type !== 'content.item' || item.missing || !item.body) { art.missingManifests.push(id); continue; }
      art.manifests += 1;
      const blocks = [];
      for (const f of item.body.frames ?? []) if (Array.isArray(f)) blocks.push(['snap', f[1]]);
      for (const f of item.body.small ?? []) if (Array.isArray(f)) blocks.push(['px', f[1]]);
      for (const p of item.body.pngs ?? []) for (const f of p?.frames ?? []) if (Array.isArray(f)) blocks.push(['px', f[1]]);
      for (const [ns, h] of blocks) {
        if (typeof h !== 'string' || seen.has(`${ns}:${h}`)) continue;
        seen.add(`${ns}:${h}`);
        art.blocks += 1;
        try {
          const bytes = await client.get(ns, h);
          if (!bytes) art.badBlocks.push({ ns, hash: h.slice(0, 12), why: 'missing' });
          else art.bytes += bytes.length;
        } catch (e) { art.badBlocks.push({ ns, hash: h.slice(0, 12), why: e?.code ?? errText(e).slice(0, 80) }); }
      }
    }
    return art;
  } finally {
    await conn.close();
  }
}

async function snapshotTree(library, dirs) {
  const files = new Map();
  const walk = async (dir) => {
    for (const item of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (/\.(html|json)$/.test(item.name)) files.set(path.relative(library, file).replaceAll('\\', '/'), await fsp.readFile(file));
    }
  };
  for (const d of dirs) await walk(path.join(library, d));
  return files;
}
async function topDirs(library) {
  const out = [];
  for (const tier of ['controls-html', 'controls-local']) {
    for (const item of await fsp.readdir(path.join(library, tier), { withFileTypes: true }).catch(() => [])) if (item.isDirectory()) out.push(`${tier}/${item.name}`);
  }
  return out;
}
/** style 属性值拆成声明（同 render-host-probe.mjs：跨进程的声明先后不确定，不影响像素） */
function declarationsOf(style) {
  const text = style.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const out = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const sortStyles = (html) => html.replace(/style="([^"]*)"/g, (_, style) => `style="${declarationsOf(style).sort().join(';')}"`);

/**
 * 与同指纹单机重渲比较（同 render-host-probe 的 check，H1 的 identicalBytes）：另起一个普通模式的编辑器（不走队列、不推送、空帧库），
 * preload 同一份项目，逐个比较这一版的快照文件。
 */
async function identicalCheck({ port, dir, project, library }) {
  const free = await until(async () => (await portFree(port)) && (await portFree(port + 1)) && (await portFree(port + 2)), 90_000, 1000);
  if (!free) return { error: `端口 ${port}～${port + 2} 一直被占` };
  const ed = await startQueueEditor({ port, dir, band: BAND, extraEnv: { PROMPTCUT_QUEUE_NODE: '0', PROMPTCUT_PUSH: '0' } });
  try {
    const session = `m8e-check-${Date.now().toString(36)}`;
    await pushAndPreload(ed, session, project);
    const pre = await ed.prerender();
    const ready = await until(async () => {
      const st = await postJson(`${pre}/api/frames/preload`, { session, localRev: 1 }, 120_000);
      return st.body?.status === 'ready' || st.body?.status === 'error' ? st.body : null;
    }, Math.max(1000, deadline - Date.now() - 60_000), 2000);
    if (ready?.status !== 'ready') return { error: `单机重渲没以 ready 结束：${ready?.status ?? 'timeout'}` };
    const single = path.join(dir, 'frame-library');
    const dirs = await topDirs(single);
    const a = await snapshotTree(single, dirs);
    const b = await snapshotTree(library, dirs);
    const differences = [];
    let styleOrderOnly = 0;
    for (const rel of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const x = a.get(rel);
      const y = b.get(rel);
      if (x && y && x.equals(y)) continue;
      if (x && y && rel.endsWith('.html') && sortStyles(x.toString('utf8')) === sortStyles(y.toString('utf8'))) { styleOrderOnly++; continue; }
      differences.push({ file: rel, reason: !x ? 'only-in-creator' : !y ? 'only-in-single' : 'bytes' });
    }
    return { dirs: dirs.length, singleFiles: a.size, creatorFiles: b.size, htmlFiles: [...a.keys()].filter((k) => k.endsWith('.html')).length,
      styleOrderOnly, differentFrames: differences.length, differences: differences.slice(0, 10), identicalBytes: differences.length === 0 && styleOrderOnly === 0,
      identical: differences.length === 0 };
  } finally {
    await ed.stop();
  }
}

/* ================================================================== 页面副本（e4、e3） */

/**
 * 按页面同一条协议维持的项目副本：`project.open` 拿当前内容，之后按 `project.ops` 逐版应用（`json-ops.mjs` 的 applyOps，
 * 与文档服务同一个函数）；版本对不上或 `resync` 就重读。摘要 = sha256(JSON.stringify(内容))，与文档服务的算法相同。
 * 会话结束后连接层（`createDocEndpoint`，缺省 `renew`）自己建新会话，新会话一建成（`onOpen`）就重读——在线页面的做法；
 * 文档服务重启后旧会话接续不上，走的就是这条路（e3）。
 * `history: true`（e3）：每次重读、每应用一版都记 `{ rev, digest, session, at }`（`session` = 这是第几个新会话，0 是最初那个），
 * 留最近 `HISTORY_MAX` 条；另记会话结束的次数与时刻。
 */
async function openReplica({ entry, docId, tag, history = false }) {
  const { applyOps } = await import('../../server/docservice/json-ops.mjs');
  const conn = await openConn({ entry, role: 'page', tag, log: say });
  if (!conn) throw new Error(`${tag} 连不上项目`);
  const HISTORY_MAX = 200;
  const st = { rev: 0, body: null, reopens: 0, applied: 0, sessions: 0, closes: 0, lastCloseAt: null, seen: [] };
  const note = (via) => {
    if (!history) return;
    st.seen.push({ rev: st.rev, digest: st.body === null ? null : sha256(JSON.stringify(st.body)), session: st.sessions, via, at: Date.now() });
    if (st.seen.length > HISTORY_MAX) st.seen.splice(0, st.seen.length - HISTORY_MAX);
  };
  let reopening = null;
  const reopen = async () => {
    reopening ??= (async () => {
      const s = await conn.rpc({ type: 'project.open', projectId: docId }, 30_000);
      if (s.type !== 'project.state') throw new Error(`project.open 回 ${s.type}`);
      if (s.parts) throw new Error('项目太大（分片），副本不处理');
      st.rev = s.rev;
      st.body = s.project ?? null;
      st.reopens += 1;
      note('open');
    })().finally(() => { reopening = null; });
    return reopening;
  };
  conn.ep.onMessage((m) => {
    if (m?.type !== 'project.ops' || m.projectId !== docId || reopening) return;
    if (m.resync || m.rev !== st.rev + 1 || !Array.isArray(m.ops)) { reopen().catch((e) => say('replica.reopen-failed', { tag, message: errText(e) })); return; }
    try { st.body = applyOps(st.body, m.ops).root; st.rev = m.rev; st.applied += 1; note('ops'); }
    catch (e) { say('replica.apply-failed', { tag, message: errText(e) }); reopen().catch(() => {}); }
  });
  conn.ep.onClose(() => { st.closes += 1; st.lastCloseAt = Date.now(); });
  // 新会话建成（首个会话之后的每一个）：重读。重读失败（服务刚起、还没就绪）隔 1 s 再试，直到这个会话又断了
  conn.ep.onOpen(() => {
    st.sessions += 1;
    const mine = st.sessions;
    const tryOpen = () => reopen().catch((e) => {
      say('replica.reopen-failed', { tag, message: errText(e) });
      if (st.sessions === mine && conn.ep.connected) setTimeout(tryOpen, 1000);
    });
    tryOpen();
  });
  await reopen();
  return {
    st,
    ep: conn.ep,
    digest: () => (st.body === null ? null : sha256(JSON.stringify(st.body))),
    /** 等副本追到 rev（或更新） */
    async at(rev, timeoutMs = 60_000) {
      const ok = await until(() => (st.rev >= rev && !reopening ? true : null), timeoutMs, 50);
      return ok ? { rev: st.rev, digest: sha256(JSON.stringify(st.body)) } : { rev: st.rev, digest: null, timeout: true };
    },
    close: () => conn.close(),
  };
}

/* ================================================================== creator */

async function runCreator(r) {
  if (!COORD || !CASES.includes(CASE) || !['cloud', 'lan'].includes(PLACE)) {
    r.fail('要给 --coord、--case e1|e2|e3|e4|e6、--place cloud|lan'); process.exitCode = 2; return;
  }
  const run = await resolveRun({ coord: COORD, prefix: PREFIX, run: arg('--run'), isCreator: true, newRun: newRunId, deadline, log: say });
  r.set({ run });
  const kv = roleKv({ coord: COORD, prefix: PREFIX, run, role: 'creator', log: say });
  const OUT = outDirOf(run, 'creator');
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(arg('--port', DEFAULT_PORTS.creator));
  const lanIp = PLACE === 'lan' ? (arg('--lan-ip', null) ?? await autoLanIp()) : null;
  if (PLACE === 'lan' && !lanIp) { r.fail('放本机要有局域网地址（--lan-ip）'); process.exitCode = 2; return; }
  const P = PLACE === 'cloud' ? placeParams('cloud', { hosted: arg('--hosted', CLOUD.hosted), coord: COORD })
    : placeParams('lan', { lanHost: `${lanIp}:${port}`, coord: COORD, hosted: arg('--hosted', CLOUD.hosted) });
  const loopbackWs = `ws://127.0.0.1:${port}/docservice`;
  const hosts = String(arg('--hosts', DEFAULT_HOSTS[CASE].join(','))).split(',').filter(Boolean);
  r.set({ place: PLACE, case: CASE, port, lanIp, hosts, member: P.ws });
  const edDir = path.join(OUT, 'editor');
  const creatorConfig = path.join(OUT, 'creator.json');
  const edOpts = { port, dir: edDir, sharedConfig: creatorConfig, lanHost: PLACE === 'lan', band: BAND };
  const ctx = { r, kv, run, P, OUT, port, loopbackWs, hosts, edOpts, ed: null, project: null, watch: null, pc: null, readies: {}, closers: [] };
  let judge = null;
  const cloudBefore = PLACE === 'lan' ? await getJson(P.cloudHealthz, 15_000).then((x) => x.body, () => null) : null;
  try {
    if (PLACE === 'cloud') {
      const h = await getJson(P.healthz, 15_000).catch((e) => ({ ok: false, body: errText(e) }));
      if (!r.check('hosted-healthz', h.ok, h.ok ? { epoch: h.body?.epoch ?? null } : h.body)) throw new Error('托管端不通');
    }
    // 1. 编辑器：放云端只绑回环；放本机以局域网主机起（绑 0.0.0.0）。配置文件在第一次打 /api/frames/* 时才读：先起后写
    ctx.ed = await startQueueEditor(edOpts);
    if (PLACE === 'lan') {
      const up = await until(async () => (await getJson(`http://127.0.0.1:${port}/api/docservice/healthz`, 3000)).ok || null, 240_000, 500);
      if (!r.check('lan-host-up', !!up, ctx.ed.lines.slice(-4))) throw new Error('局域网主机编辑器没起来');
    }
    // 2. 项目
    const name = `m8e-${CASE}-${run}`;
    ctx.project = await createProbeProject(PLACE === 'cloud' ? { where: 'hosted', ws: P.ws, name } : { where: 'lan', lanBase: loopbackWs, name });
    r.set({ projectId: ctx.project.projectId, projectName: name });
    sharedEntry({ url: PLACE === 'cloud' ? P.ws : loopbackWs, projectId: ctx.project.projectId, username: 'creator', password: ctx.project.creatorPassword,
      as: 'creator', role: 'render', run, tag: 'pc', file: creatorConfig });
    // 3. PC 节点报到
    const q0 = await ctx.ed.waitActive();
    ctx.pc = { nodeId: q0.nodeId ?? null, envFingerprint: q0.envFingerprint ?? null, codeVersion: q0.codeVersion ?? null, transport: q0.transport ?? null };
    r.check('pc-node-active', q0.active === true, ctx.pc);
    r.set({ pc: { ...ctx.pc, codeVersion: ctx.pc.codeVersion?.slice(0, 12) ?? null } });
    // 4. 配置 → KV；旁观节点
    await kv.config({ run, case: CASE, place: PLACE, ws: P.ws, name, projectId: ctx.project.projectId, member: { username: 'member', password: ctx.project.projectPassword },
      docPlain: P.docPlain, docPath: new URL(P.ws).pathname.replace(/\/+$/, '') || '', pc: ctx.pc, fakeFp: FAKE_FP, at: Date.now(),
      params: { clips: CLIPS, seconds: SECONDS, gaps: String(arg('--gaps', '0,200,900')).split(',').map(Number), burst: Number(arg('--burst', 50)) } });
    say('config', { projectId: ctx.project.projectId, name });
    ctx.member = (tag, extra = {}) => sharedEntry({ url: P.ws, projectId: ctx.project.projectId, username: 'member', password: ctx.project.projectPassword, run, tag, ...extra });
    ctx.creatorEntry = (tag, role) => sharedEntry({ url: P.ws, projectId: ctx.project.projectId, username: 'creator', password: ctx.project.creatorPassword, as: 'creator', role, run, tag });
    ctx.queueProject = `m8e-${CASE}-${run}`;
    ctx.watch = await openWatch({ entry: ctx.member('watcher'), projects: [ctx.queueProject, `${ctx.queueProject}-fake`], nodeId: `m8e-watcher-${run}` });
    r.check('watcher-watching', ctx.watch.first.watch === 'queue.snapshot', ctx.watch.first);
    // 5. 等主机
    for (const h of hosts) {
      const ready = await kv.takeReady(h, deadline);
      if (!r.check(`ready-${h}`, !!ready)) throw new Error(`${h} 没起来`);
      ctx.readies[h] = ready;
    }
    r.set({ hostsReady: Object.fromEntries(Object.entries(ctx.readies).map(([h, x]) => [h, { envFingerprint: x.envFingerprint, codeVersion: x.codeVersion?.slice(0, 12) ?? null,
      fingerprint: x.fingerprint ?? null, discovery: x.discovery ?? null }])) });
    for (const h of hosts) {
      const x = ctx.readies[h];
      r.check(`code-version-${h}`, x.codeVersion === ctx.pc.codeVersion, { pc: ctx.pc.codeVersion?.slice(0, 12), host: x.codeVersion?.slice(0, 12) });
      if (!x.fingerprint?.requested) r.check(`fingerprint-${h}`, x.envFingerprint === ctx.pc.envFingerprint, { pc: ctx.pc.envFingerprint, host: x.envFingerprint });
    }
    if (r.fails.length) throw new Error('主机与 PC 的代码版本或指纹不一致（细任务它们认领不到）');
    // 6. 用例
    judge = await ({ e1: caseE1, e2: caseE2, e3: caseE3, e4: caseE4, e6: caseE6 })[CASE](ctx);
  } catch (error) {
    r.fail(`creator 出错：${errText(error)}`);
    say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
    await kv.abort(error?.message ?? error);
  } finally {
    await kv.done({ at: Date.now() });
    // 各主机的结果（它们收到 done 才收尾）
    const results = {};
    for (const h of hosts) results[h] = ctx.readies[h] ? await kv.takeResult(h, Math.min(deadline, Date.now() + 5 * 60_000)).catch(() => null) : null;
    for (const h of hosts) if (ctx.readies[h]) r.check(`result-${h}`, !!results[h], results[h] ? { ok: results[h].ok, fails: (results[h].fails ?? []).slice(0, 3) } : null);
    r.set({ hostResults: Object.fromEntries(Object.entries(results).map(([h, x]) => [h, x ? { ok: x.ok, stats: x.stats ?? null, fails: (x.fails ?? []).slice(0, 5) } : null])) });
    if (judge) { try { await judge(results); } catch (error) { r.fail(`判定出错：${errText(error)}`); } }
    for (const c of ctx.closers) { try { await c(); } catch { /* 已关 */ } }
    await ctx.watch?.close().catch(() => {});
    if (ctx.project && !flag('--keep')) {
      const del = await deleteProbeProject({ ws: PLACE === 'cloud' ? P.ws : loopbackWs, projectId: ctx.project.projectId, creatorPassword: ctx.project.creatorPassword, run });
      r.check('project-deleted', del.deleted, del.error);
    } else if (ctx.project) {
      r.set({ kept: { projectId: ctx.project.projectId, name: ctx.project.name, config: creatorConfig } });
    }
    await ctx.ed?.stop();
    if (PLACE === 'lan') {
      // 按本轮查（judgeCloudUntouched）：本轮项目名在云端 shared/lookup 查不到；云端总连接数只记录、不判（别人进出会变）
      const cloudAfter = await getJson(P.cloudHealthz, 15_000).then((x) => x.body, () => null);
      const mine = { name: ctx.project?.name ?? `m8e-${CASE}-${run}`, projectId: ctx.project?.projectId ?? null };
      const cloudBase = P.cloudHealthz.replace(/\/healthz$/, '');
      const lookup = await getJson(`${cloudBase}/shared/lookup?name=${encodeURIComponent(mine.name)}`, 15_000).catch(() => null);
      const cu = judgeCloudUntouched(lookup, mine, { before: cloudBefore?.connections ?? null, after: cloudAfter?.connections ?? null });
      r.check('cloud-untouched', cu.ok, { cloud: cloudBase, project: mine.name, ...cu });
    }
    r.check('kv-no-401', kv.client.stats.unauthorized === 0, kv.client.stats);
    r.set({ out: OUT });
    await kv.result(r.toJSON());
  }
}

/** 公共判据：J-全完、J-恰一（一个 epoch）、J-纯层、各方完成数 */
function judgeRound(ctx, round, results, { label, epochOf = () => ctx.watch.epochs.at(-1) ?? 'e0', nodes = null } = {}) {
  const { r } = ctx;
  r.check(`${label}:manifests-applied`, round.applyErrors === 0, { applyErrors: round.applyErrors, applied: round.stats?.applied ?? null });
  const states = Object.fromEntries(round.derived.map((id, i) => [id, round.states[i]]));
  r.judge(`${label}:J-all-done`, judgeAllDone(round.derived, states));
  const events = [];
  for (const [id, n] of Object.entries(round.doneCounts)) for (let i = 0; i < n; i++) events.push({ id, epoch: epochOf(id, i) });
  r.judge(`${label}:J-exactly-once`, judgeExactlyOnce([round.planId, ...round.derived], events));
  const completedBy = {};
  for (const id of [...round.pc.completed, ...round.pc.dedup]) completedBy[id] ??= 'pc';
  const fps = { pc: ctx.pc.envFingerprint };
  for (const [h, res] of Object.entries(results)) {
    fps[h] = res?.envFingerprint ?? ctx.readies[h]?.envFingerprint ?? null;
    for (const id of [...(res?.ids?.completed ?? []), ...(res?.ids?.dedup ?? [])]) if (round.derived.includes(id)) completedBy[id] ??= h;
  }
  const tasks = round.derived.map((id) => ({ id, requires: { envFingerprint: ctx.watch.requires.get(id) ?? undefined } }));
  const obs = layerObservations(tasks, completedBy, fps);
  r.judge(`${label}:J-pure-layers`, { ...judgePureLayers(obs), attributed: Object.keys(completedBy).length, tasks: round.derived.length });
  const work = { pc: round.pc.completed.length + round.pc.dedup.length };
  for (const [h, res] of Object.entries(results)) work[h] = (res?.stats?.completed ?? 0) + (res?.stats?.dedup ?? 0) - (res?.statsBase?.completed ?? 0) - (res?.statsBase?.dedup ?? 0);
  return { work, completedBy };
}

/* ------------------------------------------------------------------ e1 */

async function caseE1(ctx) {
  const { r, kv, ed, run } = ctx;
  const session = `m8e-${run}`;
  const project = probeProject({ id: ctx.queueProject, clips: CLIPS, seconds: SECONDS, salt: `${run}-${randomBytes(3).toString('hex')}` });
  const base = await queueBaseline(ed);
  const t0 = Date.now();
  await pushAndPreload(ed, session, project);
  const round = await waitSettled(ed, { session, base });
  if (!r.check('real:plan-settled', round.ok, { lastStatus: round.lastStatus })) throw new Error('这一版没落定');
  r.set({ real: { planId: round.planId, tasks: round.derived.length, failed: round.failed.length, ms: Date.now() - t0, pcCompleted: round.pc.completed.length, pcDedup: round.pc.dedup.length } });
  const want = realTasksThreshold({ clips: CLIPS, seconds: SECONDS, fps: FPS });
  r.check(want.label, round.derived.length >= want.need, { tasks: round.derived.length, need: want.need, expected: want.expected });
  r.check('real:no-failed', round.failed.length === 0, round.failed.slice(0, 5));
  r.check('real:plan-by-pc', round.pc.planClaimed);
  // 产物：按清单逐段从该项目所在的素材服务取回
  const art = await fetchArtifacts(ctx.member('checker', { role: 'page' }), round.derived);
  r.check('real:artifacts', !art.error && art.manifests === round.derived.length && art.missingManifests.length === 0 && art.blocks > 0 && art.badBlocks.length === 0,
    { ...art, missingManifests: art.missingManifests?.slice(0, 5), badBlocks: art.badBlocks?.slice(0, 5) });

  // 假任务那一轮：三方各起一个假节点（专用指纹 FAKE_FP），创建者发布
  const fakeN = Number(arg('--fake-tasks', 50));
  let fake = null;
  if (fakeN > 0) {
    const fakeProject = `${ctx.queueProject}-fake`;
    const layers = Math.max(1, Math.round(fakeN / 5));
    const tasks = fakeLayerTasks({ run, projectId: fakeProject, layers: Array.from({ length: layers }, () => ({ fingerprint: FAKE_FP, segments: Math.ceil(fakeN / layers) })) }).slice(0, fakeN);
    const node = await startFakeNode({ entry: ctx.creatorEntry('pc-fake', 'render'), nodeId: `m8e-pc-fake-${run}`, fingerprint: FAKE_FP, taskMs: 300, maxConcurrent: 2, projects: [fakeProject], log: say });
    ctx.closers.push(() => node.stop());
    await kv.signal('fake.start', { project: fakeProject, fingerprint: FAKE_FP, taskMs: 300 });
    // 等主机的假节点报到
    for (const h of ctx.hosts) await waitKv(kv, `signal.fake.ready.${h}`, { timeoutMs: 120_000 });
    const pub = await startFakePublisher({ entry: ctx.creatorEntry('fake-pub', 'page'), publisherId: `m8e-fake-pub-${run}`, tasks, log: say });
    ctx.closers.push(() => pub.close());
    const allDone = await pub.whenAllDone(Math.max(1000, Math.min(15 * 60_000, deadline - Date.now() - 120_000)));
    await kv.signal('fake.done', { at: Date.now() });
    fake = { tasks, pub, node, allDone };
  }
  const withIdentical = !flag('--no-identical');
  return async (results) => {
    const { work } = judgeRound(ctx, round, results, { label: 'real' });
    r.judge('real:each-worked', judgeEachWorked(work, { total: round.derived.length }));
    r.set({ realWork: work });
    if (fake) {
      const ids = fake.tasks.map((t) => t.id);
      r.judge('fake:J-all-done', judgeAllDone(ids, fake.pub.states));
      r.judge('fake:J-exactly-once', judgeExactlyOnce(ids, fake.pub.doneEvents));
      const completedBy = {};
      for (const id of [...fake.node.completed, ...fake.node.dedup]) completedBy[id] ??= 'pc';
      const fps = { pc: FAKE_FP };
      const fwork = { pc: fake.node.completed.length + fake.node.dedup.length };
      for (const [h, res] of Object.entries(results)) {
        fps[h] = res?.fake?.fingerprint ?? null;
        for (const id of [...(res?.fake?.completed ?? []), ...(res?.fake?.dedup ?? [])]) completedBy[id] ??= h;
        fwork[h] = (res?.fake?.completed?.length ?? 0) + (res?.fake?.dedup?.length ?? 0);
      }
      r.judge('fake:J-pure-layers', judgePureLayers(layerObservations(fake.tasks, completedBy, fps)));
      r.judge('fake:each-worked', judgeEachWorked(fwork, { total: ids.length }));
      r.set({ fake: { tasks: ids.length, allDone: fake.allDone, work: fwork, epochs: [...new Set(fake.pub.doneEvents.map((e) => e.epoch))], errors: fake.pub.errors.slice(0, 5) } });
    }
    if (withIdentical) {
      const port = Number(arg('--check-port', ctx.port + 3));
      const ic = await identicalCheck({ port, dir: path.join(ctx.OUT, 'single'), project, library: path.join(ctx.edOpts.dir, 'frame-library') })
        .catch((e) => ({ error: errText(e) }));
      r.check('real:identical-to-single', !ic.error && ic.htmlFiles > 0 && ic.identical, ic);
      r.set({ identical: { identicalBytes: ic.identicalBytes ?? null, styleOrderOnly: ic.styleOrderOnly ?? null, htmlFiles: ic.htmlFiles ?? null } });
    }
  };
}

/* ------------------------------------------------------------------ e2 */

async function caseE2(ctx) {
  const { r, kv, ed, run, watch } = ctx;
  const session = `m8e-${run}`;
  const project = probeProject({ id: ctx.queueProject, clips: CLIPS, seconds: SECONDS, salt: `${run}-${randomBytes(3).toString('hex')}` });
  const base = await queueBaseline(ed);
  await pushAndPreload(ed, session, project);
  // 受害方 stall 之后写 KV；从 creator 收到的那一刻起算接手（跨机不比两台机器的钟）
  const settling = waitSettled(ed, { session, base });
  const stall = await waitKv(kv, 'signal.stall', { timeoutMs: 15 * 60_000 });
  const seenAt = Date.now();
  let takeover = null;
  if (r.check('stall-signal', !!stall?.held?.length, stall)) {
    const held = stall.held;
    if (stall.seconds) {
      // C1(应用层断线,主会话 2026-09-28 更正):受害方 stall 固定秒数后自己 resume,不等接手。两种结局都认:
      // 租约到期被别的节点接手(≤ 37 s),或会话保留期内接续、任务照常由受害方完成(没被放回、最后是 done)
      const outcomeOf = (id) => {
        const ms = takeoverMs(watch.events(id), seenAt);
        const reopen = watch.events(id).find((e) => e.t >= seenAt && e.ev === 'opened');
        if (ms !== null) return { id, outcome: 'takeover', ms, reopenMs: reopen ? reopen.t - seenAt : null };
        const t = summarizeTimeline(watch.events(id).filter((e) => e.t >= seenAt));
        return t.closed.at(-1) === 'done' && t.reopenedAfterTaken === 0 && !watch.events(id).some((e) => e.t >= seenAt && e.ev === 'opened') ? { id, outcome: 'resumed-done' } : null;
      };
      const per = await until(() => { const xs = held.map(outcomeOf); return xs.every(Boolean) ? xs : null; }, (stall.seconds + 180) * 1000, 250);
      const final = per ?? held.map((id) => outcomeOf(id) ?? { id, outcome: null, timeline: summarizeTimeline(watch.events(id)) });
      takeover = { mode: 'c1-fixed', seconds: stall.seconds, held, per: final, stalledAtHostClock: stall.at, seenAt };
      r.check('c1-outcome', !!per && per.every((x) => x.outcome === 'resumed-done' || (x.reopenMs !== null && x.reopenMs <= TAKEOVER_LIMIT_MS)), { limitMs: TAKEOVER_LIMIT_MS, per: final });
    } else {
      // 放回(opened)的用时是协议的上界(租约 30 s + 扫描 + 2 s),判 ≤ 37 s;被别人认领(taken)还要等有空槽,
      // 机器忙、各节点都在做长任务时会晚,只记录(本机替身上十几个子智能体同时在跑,见报告)
      const reopenMs = (id) => watch.events(id).find((e) => e.t >= seenAt && e.ev === 'opened')?.t - seenAt;
      const per = await until(() => {
        const xs = held.map((id) => ({ id, reopenMs: reopenMs(id) ?? null, ms: takeoverMs(watch.events(id), seenAt) }));
        return xs.every((x) => x.ms !== null) ? xs : null;
      }, 10 * 60_000, 200);
      const final = per ?? held.map((id) => ({ id, reopenMs: reopenMs(id) ?? null, ms: takeoverMs(watch.events(id), seenAt), timeline: summarizeTimeline(watch.events(id)) }));
      takeover = { mode: 'until-takeover', held, per: final, stalledAtHostClock: stall.at, seenAt };
      r.check('reopened<=37s', final.every((x) => x.reopenMs !== null && x.reopenMs <= TAKEOVER_LIMIT_MS), { limitMs: TAKEOVER_LIMIT_MS, per: final });
      r.check('taken-over', !!per, { per: final });
      await kv.signal('takeover', { at: Date.now(), per: final });
    }
  }
  const round = await settling;
  if (!r.check('plan-settled', round.ok, { lastStatus: round.lastStatus })) throw new Error('这一版没落定');
  r.set({ round: { planId: round.planId, tasks: round.derived.length, failed: round.failed.length }, takeover });
  return async (results) => {
    const { work } = judgeRound(ctx, round, results, { label: 'e2' });
    r.set({ work });
    const victim = Object.entries(results).find(([, x]) => x?.stall);
    if (victim) {
      const [name, res] = victim;
      // 被接手的任务:受害方恢复后旧认领一律 lease-lost、它自己不再完成;C1 里会话接续、照常完成的那些不在此列
      const takenOver = (takeover?.per ?? []).filter((x) => x.outcome !== 'resumed-done').map((x) => x.id);
      // 旧认领作废:受害方那边这个任务以 lease-lost 收场,或它的执行在断线期间先失败了(例如取项目快照超时,恢复后报的 fail 带旧令牌、不作数)
      const voidIds = new Set([...(res.stall.lost ?? []), ...(res.stall.failed ?? [])].filter((x) => x.at).map((x) => x.id));
      r.check('victim-old-claim-void', takenOver.every((id) => voidIds.has(id)), { host: name, takenOver, lost: res.stall.lost, failed: res.stall.failed ?? [], session: res.stall.session ?? null });
      r.check('victim-no-double-done', takenOver.every((id) => !(res.stall.completedHeld ?? []).includes(id)), { host: name, completedHeld: res.stall.completedHeld ?? [] });
      r.set({ victim: { host: name, mode: takeover?.mode ?? null, session: res.stall.session ?? null, outcomes: (takeover?.per ?? []).map((x) => x.outcome ?? 'takeover') } });
    } else r.check('victim-result', false, '没有主机报 stall');
  };
}

/* ------------------------------------------------------------------ e3 */

async function caseE3(ctx) {
  const { r, kv, run, watch } = ctx;
  const session = `m8e-${run}`;
  const project = probeProject({ id: ctx.queueProject, clips: CLIPS, seconds: SECONDS, salt: `${run}-${randomBytes(3).toString('hex')}` });
  const base = await queueBaseline(ctx.ed);
  // 在线页面（同 e4 的口径：Node 里按页面同一条协议维持的副本，不是浏览器页面）：单独一份项目真身 m8e3-<run>，
  // 创建者以 page 角色写，主机开成员 page 角色的副本跟着（KV signal.e3.doc）
  const docId = `m8e3-${run}`;
  const writer = await openConn({ entry: ctx.creatorEntry('page-writer', 'page'), role: 'page', tag: 'page-writer', log: say });
  if (!r.check('page-writer-connected', !!writer)) throw new Error('页面写入方连不上');
  ctx.closers.push(() => writer.close());
  const openDoc = async () => {
    const s = await writer.rpc({ type: 'project.open', projectId: docId }, 30_000);
    if (s.type !== 'project.state') throw new Error(`project.open 回 ${s.type}`);
    return s;
  };
  const d0 = await openDoc();
  const init = await writer.rpc({ type: 'project.op', projectId: docId, opId: `m8e3-init-${run}`, session: 'm8e3-page', expectRev: d0.rev, ops: [{ op: 'set', path: '', value: { page: {} } }] }, 30_000);
  if (!r.check('page-doc-created', init.type === 'project.op.ok', init)) throw new Error('建不了页面用的项目真身');
  await kv.signal('e3.doc', { docId, at: Date.now() });
  await pushAndPreload(ctx.ed, session, project);
  const needDone = Number(arg('--restart-after-done', 5));
  // 重启时机：已有 needDone 个细任务完成，且有主机持有任务（主机写 signal.holding.<名>）
  let planA = null;
  const ready = await until(async () => {
    const q = await ctx.ed.queue();
    const mine = (q?.published ?? []).filter((p) => !base.planIds.has(p.planId)).at(-1);
    const derived = mine ? q.plans?.[mine.planId] : null;
    if (!Array.isArray(derived)) return null;
    planA = { planId: mine.planId, derived };
    const done = derived.filter((id) => q.tasks?.[id]?.state === 'done').length;
    if (done < needDone) return null;
    for (const h of ctx.hosts) if (await kv.get(`signal.holding.${h}`, 0).catch(() => null)) return { done, holder: h };
    return null;
  }, 20 * 60_000, 1000);
  if (!r.check('restart-window', !!ready, { needDone, planA: planA ? { planId: planA.planId, tasks: planA.derived.length } : null })) throw new Error('等不到重启时机');
  // 重启前页面最后一次提交：写一条无害字段，读回这一版的 rev 与摘要，随 restart.request 交给主机（重启后它的副本要读得到）
  const marker = `${run}-${randomBytes(4).toString('hex')}`;
  const last = await writer.rpc({ type: 'project.op', projectId: docId, opId: `m8e3-last-${run}`, session: 'm8e3-page', ops: [{ op: 'set', path: '/page/lastCommit', value: marker }] }, 30_000);
  if (!r.check('page-last-commit', last.type === 'project.op.ok', last)) throw new Error('页面最后一次提交没落地');
  const d1 = await openDoc();
  const lastCommit = { docId, rev: d1.rev, digest: d1.digest, path: '/page/lastCommit', value: marker, opRev: last.rev };
  r.set({ page: { docId, lastCommit: { rev: lastCommit.rev, opRev: last.rev, digest: String(lastCommit.digest ?? '').slice(0, 16) } } });
  const epochA = watch.epochs.at(-1) ?? null;
  let countsA = null;
  let pcCompletedA = null;
  const restartAt = Date.now();
  if (PLACE === 'lan') {
    // C4（D2）：结束自己起的局域网主机编辑器进程树，同端口再起
    const qa = (await ctx.ed.queue()) ?? {};
    countsA = { ...(qa.doneCounts ?? {}) };
    pcCompletedA = new Set([...(qa.local?.completed ?? []), ...(qa.local?.dedup ?? [])]);
    // 放本机也写 restart.request（不带远端命令）：主机据此记副本重启前的版本、拿到页面最后一次提交
    await kv.signal('restart.request', { how: 'lan-editor', lastCommit, at: Date.now() });
    await ctx.ed.stop();
    const t1 = Date.now();
    ctx.ed = await startQueueEditor(ctx.edOpts);
    await until(async () => (await getJson(`http://127.0.0.1:${ctx.port}/api/docservice/healthz`, 3000)).ok || null, 240_000, 500);
    const qb = await ctx.ed.waitActive();
    r.set({ restart: { how: 'lan-editor', killMs: t1 - restartAt, upMs: Date.now() - t1, envFingerprint: qb.envFingerprint ?? null } });
  } else {
    // C2：由主会话在远端执行；本进程在断开前后盯着编辑器的计数，取断开那一刻的 doneCounts 作 epoch A 的计数
    const cmd = 'ssh <远端> "pm2 restart promptcut-hosted && pm2 describe promptcut-hosted"';
    const signalCmd = `node scripts/probes/m8-e-probe.mjs --role signal --coord ${COORD} --run ${run} --name restart.done`;
    let last = null;
    let broke = null;
    const poller = (async () => {
      while (!broke && Date.now() < deadline) {
        const q = await ctx.ed.queue().catch(() => null);
        if (q) {
          if (q.connected === false || (last && (q.session?.opens ?? 0) > (last.session?.opens ?? 0))) broke = last ?? q;
          else last = q;
        }
        await delay(250);
      }
    })();
    await kv.signal('restart.request', { cmd, signalCmd, lastCommit, at: Date.now() });
    say('remote-step', { what: 'C2：在阿里云上重启托管组合，完成后写回信号', cmd, then: signalCmd, key: kvKey(PREFIX, run, 'signal', 'restart.done') });
    const done = await kv.takeSignal('restart.done', Math.min(deadline, Date.now() + 30 * 60_000));
    if (!r.check('restart-done-signal', !!done)) throw new Error('等不到远端重启完成的信号');
    await until(() => broke, 60_000, 200);
    broke ??= last;
    await poller.catch(() => {});
    countsA = { ...(broke?.doneCounts ?? {}) };
    pcCompletedA = new Set([...(broke?.local?.completed ?? []), ...(broke?.local?.dedup ?? [])]);
    const back = await until(async () => { const q = await ctx.ed.queue(); return q?.active && q.connected ? q : null; }, 5 * 60_000, 1000);
    r.set({ restart: { how: 'remote', signal: done, reconnected: !!back } });
  }
  await kv.signal('restarted', { at: Date.now() });
  // 重新发布同一版：lan 的编辑器是新进程（镜像空了），云端的编辑器 published 已清（J.5）；都推一次再 preload
  const since = Date.now();
  const baseB = await queueBaseline(ctx.ed);
  await pushAndPreload(ctx.ed, session, project);
  const round = await waitSettled(ctx.ed, { session, base: baseB, since: since - 1000 });
  if (!r.check('plan-settled-after-restart', round.ok, { lastStatus: round.lastStatus })) throw new Error('重启后这一版没落定');
  const epochB = watch.epochs.at(-1) ?? null;
  const baseCountsA = base.doneCounts;
  const doneA = new Set(Object.entries(countsA).filter(([id, n]) => n - (baseCountsA[id] ?? 0) > 0 && planA.derived.includes(id)).map(([id]) => id));
  r.set({ epochs: watch.epochs, planA: { planId: planA.planId, tasks: planA.derived.length, doneBeforeRestart: doneA.size }, planB: { planId: round.planId, tasks: round.derived.length } });
  r.check('epoch-changed', !!epochA && !!epochB && epochA !== epochB, { epochA, epochB, all: watch.epochs });
  r.check('same-split', planA.derived.every((id) => round.derived.includes(id)), { a: planA.derived.length, b: round.derived.length });
  // PC 在重启后亲自渲染过的（lan：新进程的全部；云端：减去断开时已有的）
  const pcRenderedB = PLACE === 'lan' ? round.pc.completed : round.pc.completed.filter((id) => !pcCompletedA.has(id));
  return async (results) => {
    // J-全完、重启后这一版（epoch B）之内恰好一次、J-纯层
    judgeRound(ctx, round, results, { label: 'after', epochOf: () => epochB });
    // D3：按 epoch 数。epoch A 的计数取断开 / 结束进程那一刻；epoch B 的是重新发布之后这一版的差值
    const events = [];
    for (const [id, n] of Object.entries(countsA)) if (planA.derived.includes(id)) for (let i = 0; i < n - (baseCountsA[id] ?? 0); i++) events.push({ id, epoch: epochA ?? 'A' });
    for (const [id, n] of Object.entries(round.doneCounts)) for (let i = 0; i < n; i++) events.push({ id, epoch: epochB ?? 'B' });
    r.judge('J-exactly-once-per-epoch', judgeExactlyOnce([round.planId, ...round.derived], events));
    const hostRenderedB = Object.entries(results).flatMap(([h, res]) => (res?.e3?.completedAfter ?? []).map((id) => ({ h, id })));
    const rerendered = [...pcRenderedB.map((id) => ({ h: 'pc', id })), ...hostRenderedB].filter((x) => doneA.has(x.id));
    r.check('no-rerender-of-done', doneA.size > 0 && rerendered.length === 0, { doneBeforeRestart: doneA.size, rerendered: rerendered.slice(0, 5) });
    for (const [h, res] of Object.entries(results)) {
      if (!res?.e3) continue;
      r.check(`reconnected-${h}`, res.e3.reconnected === true, res.e3);
      if (PLACE === 'lan') r.check(`endpoint-reannounced-${h}`, res.e3.reannounceMs !== null && res.e3.reannounceMs <= REANNOUNCE_LIMIT_MS, { limitMs: REANNOUNCE_LIMIT_MS, ...res.e3.endpoints });
      // 在线页面恢复同步、重启前最后一次提交可读（主机侧副本判的两条，纳入汇总）
      const pg = res.e3.page ?? null;
      r.check(`page-resync-after-restart-${h}`, pg?.resync === true, pg);
      r.check(`last-commit-readable-${h}`, pg?.readable === true, pg);
    }
  };
}

/* ------------------------------------------------------------------ e4 */

async function caseE4(ctx) {
  const { r, kv, ed, run, watch } = ctx;
  const session = `m8e-${run}`;
  const project = probeProject({ id: ctx.queueProject, clips: CLIPS, seconds: SECONDS, salt: `${run}-${randomBytes(3).toString('hex')}` });
  const base = await queueBaseline(ed);
  await pushAndPreload(ed, session, project);
  const settling = waitSettled(ed, { session, base });
  // 后台有任务在跑了才开始突发
  const running = await until(async () => {
    const q = await ed.queue();
    const mine = (q?.published ?? []).filter((p) => !base.planIds.has(p.planId)).at(-1);
    const derived = mine ? q.plans?.[mine.planId] : null;
    return Array.isArray(derived) && watch.anyTaken(derived) ? derived : null;
  }, 10 * 60_000, 500);
  if (!r.check('background-running', !!running)) throw new Error('后台任务没跑起来');
  const docId = `m8e4-${run}`;
  const burst = Number(arg('--burst', 50));
  const gaps = String(arg('--gaps', '0,200,900')).split(',').map(Number);
  const agentEntry = { ...ctx.member('agent', { role: 'agent' }), conversation: 1 };
  const agent = await openConn({ entry: agentEntry, role: 'agent', tag: 'agent', log: say });
  const writer = await openConn({ entry: ctx.creatorEntry('page-writer', 'page'), role: 'page', tag: 'page-writer', log: say });
  if (!r.check('agent-and-writer-connected', !!agent && !!writer)) throw new Error('Agent 或页面写入方连不上');
  ctx.closers.push(() => agent.close(), () => writer.close());
  const openRev = async () => {
    const s = await agent.rpc({ type: 'project.open', projectId: docId }, 30_000);
    if (s.type !== 'project.state') throw new Error(`project.open 回 ${s.type}`);
    return s;
  };
  // 建真身：根替换（期望版本 0）
  const s0 = await openRev();
  const init = await agent.rpc({ type: 'project.op', projectId: docId, opId: `m8e4-init-${run}`, session: 'm8e4-agent', expectRev: s0.rev, ops: [{ op: 'set', path: '', value: { burst: {}, page: {} } }] });
  if (!r.check('doc-created', init.type === 'project.op.ok', init)) throw new Error('建不了项目真身');
  const pcReplica = await openReplica({ entry: ctx.creatorEntry('pc-replica', 'page'), docId, tag: 'pc-replica' });
  ctx.closers.push(() => pcReplica.close());
  await kv.signal('e4.doc', { docId, rounds: gaps.length, at: Date.now() });
  const rounds = [];
  const doneSum = async () => { const q = await ed.queue(); return running.filter((id) => q?.tasks?.[id]?.state === 'done').length; };
  for (let k = 0; k < gaps.length; k++) {
    const gap = gaps[k];
    const t0 = Date.now();
    const done0 = await doneSum();
    // 页面写入方：每 100 ms 一次，不带期望版本（按到达顺序落地），逼出 Agent 的 stale
    let writing = true;
    let pageWrites = 0;
    const pageLoop = (async () => {
      let n = 0;
      while (writing) {
        const m = await writer.rpc({ type: 'project.op', projectId: docId, opId: `m8e4-p${k}-${n}-${run}`, session: 'm8e4-page', ops: [{ op: 'set', path: `/page/r${k}n${n}`, value: n }] }, 30_000).catch(() => null);
        if (m?.type === 'project.op.ok') pageWrites++;
        n++;
        await delay(100);
      }
    })();
    let rev = (await openRev()).rev;
    let stale = 0;
    let attempts = 0;
    let landed = 0;
    const others = [];
    for (let i = 0; i < burst; i++) {
      for (;;) {
        attempts++;
        const m = await agent.rpc({ type: 'project.op', projectId: docId, opId: `m8e4-a${k}-${i}-${run}`, session: 'm8e4-agent', expectRev: rev,
          ops: [{ op: 'set', path: `/burst/r${k}i${i}`, value: { i, gap } }] }, 30_000);
        if (m.type === 'project.op.ok') { rev = m.rev; landed++; break; }
        if (m.type === 'project.op.rejected' && m.reason === 'stale') { stale++; rev = (await openRev()).rev; continue; }
        others.push({ i, type: m.type, reason: m.reason ?? null });
        break;
      }
      if (gap > 0) await delay(gap);
    }
    writing = false;
    await pageLoop;
    const burstMs = Date.now() - t0;
    const done1 = await doneSum();
    await delay(500);
    const s = await openRev();
    const pc = await pcReplica.at(s.rev);
    await kv.signal(`e4.round.${k}`, { rev: s.rev, digest: s.digest, at: Date.now() });
    const hostReplicas = {};
    for (const h of ctx.hosts) hostReplicas[h] = await waitKv(kv, `signal.e4.replica.${h}.${k}`, { timeoutMs: 120_000 });
    const round = { gap, burst, landed, stale, attempts, others: others.slice(0, 5), pageWrites, burstMs, rev: s.rev, digest: s.digest?.slice(0, 16) ?? null,
      pc: { rev: pc.rev, digest: pc.digest?.slice(0, 16) ?? null }, hosts: Object.fromEntries(Object.entries(hostReplicas).map(([h, x]) => [h, x ? { rev: x.rev, digest: x.digest?.slice(0, 16) ?? null } : null])),
      doneDuringBurst: done1 - done0 };
    rounds.push(round);
    r.check(`round${k}-gap${gap}:all-landed`, landed === burst && others.length === 0, { landed, burst, others: round.others });
    r.check(`round${k}-gap${gap}:three-digests-equal`, !!s.digest && pc.digest === s.digest && Object.values(hostReplicas).every((x) => x?.digest === s.digest && x?.rev === s.rev),
      { server: round.digest, rev: s.rev, pc: round.pc, hosts: round.hosts });
    say('e4.round', round);
  }
  r.set({ e4: { docId, rounds } });
  r.check('stale-exercised', rounds.some((x) => x.stale > 0), rounds.map((x) => ({ gap: x.gap, stale: x.stale })));
  r.check('background-not-starved', rounds.reduce((n, x) => n + x.doneDuringBurst, 0) >= 1, rounds.map((x) => ({ gap: x.gap, doneDuringBurst: x.doneDuringBurst, burstMs: x.burstMs })));
  await kv.signal('e4.end', { at: Date.now() });
  const round = await settling;
  if (!r.check('plan-settled', round.ok, { lastStatus: round.lastStatus })) throw new Error('后台这一版没落定');
  r.set({ round: { planId: round.planId, tasks: round.derived.length, failed: round.failed.length } });
  return async (results) => {
    const { work } = judgeRound(ctx, round, results, { label: 'background' });
    r.set({ work });
  };
}

/* ------------------------------------------------------------------ e6 */

async function caseE6(ctx) {
  const { r, run, ed } = ctx;
  const skipped = [];
  if (flag('--browser-node')) skipped.push({ what: 'browser-node', reason: '纯浏览器节点（D12 的 b）由 M7 交付，本检出没有；M7 合入后在这里接 M7 探针的节点角色（跨机模式），判 Y 指纹的节点对 PC 这一版认领 0' });
  skipped.push({ what: 'reverse', reason: '反方向（主机先认领按清单发布的 plan，C10 契约第 18 节第 9 条、计划 L18）要在线页面发布不带指纹的 plan；本探针的发布方是桌面编辑器（plan 带发布方指纹，别的指纹的主机永远认领不到），不起在线页面。这一向用 c10-browser-probe.mjs 的跨机模式（--role host 带测试指纹）做' });
  const fake = Object.entries(ctx.readies).filter(([, x]) => x.fingerprint?.requested);
  const notApplied = fake.filter(([, x]) => !x.fingerprint.applied);
  if (!fake.length) {
    r.check('e6-fake-host', false, '没有主机带 --fake-fingerprint');
    return null;
  }
  if (notApplied.length) {
    skipped.unshift({ what: 'test-switch', reason: `测试开关 PROMPTCUT_TEST_ENV_FINGERPRINT 没生效（${notApplied.map(([h, x]) => `${h} 报 ${x.envFingerprint}，要 ${x.fingerprint.value}`).join('；')}）：开关只在含 C10 集成的检出上生效，C10 合入后再跑` });
    r.set({ skipped });
    r.check('e6-skipped-precondition', true, skipped[0]);
    return null;
  }
  const session = `m8e-${run}`;
  const project = probeProject({ id: ctx.queueProject, clips: CLIPS, seconds: SECONDS, salt: `${run}-${randomBytes(3).toString('hex')}` });
  const base = await queueBaseline(ed);
  await pushAndPreload(ed, session, project);
  const round = await waitSettled(ed, { session, base });
  if (!r.check('plan-settled', round.ok, { lastStatus: round.lastStatus })) throw new Error('这一版没落定');
  r.set({ round: { planId: round.planId, tasks: round.derived.length }, skipped });
  return async (results) => {
    const { work } = judgeRound(ctx, round, results, { label: 'e6' });
    r.set({ work });
    for (const [h] of fake) {
      const res = results[h];
      const claimedIds = (res?.ids?.claimed ?? []).filter((id) => round.derived.includes(id));
      r.check(`other-fingerprint-claimed-0-${h}`, (res?.stats?.claimed ?? 0) === 0 && claimedIds.length === 0, { claimed: res?.stats?.claimed ?? null, ids: claimedIds.slice(0, 5), envFingerprint: res?.envFingerprint });
    }
  };
}

/* ================================================================== host */

async function runHost(r) {
  if (!COORD) { r.fail('要给 --coord'); process.exitCode = 2; return; }
  const run = await resolveRun({ coord: COORD, prefix: PREFIX, run: arg('--run'), isCreator: false, newRun: newRunId, deadline, log: say });
  r.set({ run, name: NAME });
  const kv = roleKv({ coord: COORD, prefix: PREFIX, run, role: NAME, log: say });
  const OUT = outDirOf(run, NAME);
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(arg('--port', DEFAULT_PORTS.host));
  let host = null;
  let proxy = null;
  let fakeNode = null;
  let replica = null;
  let epWatch = null;
  const idsSeen = { claimed: new Map(), completed: new Map(), dedup: new Map(), lost: new Map(), failed: new Map() };
  const eventsLog = [];
  const eventsDetail = [];
  let pollTimer = null;
  let prerenderUrl = null;
  // --assert-no-lan <PC 局域网地址>（m8-plan 第 2.3 节「异地接入」的真实渲染一轮）：全程只读地数到这个地址、基线之外的 TCP 连接（不论状态）
  const noLanIp = arg('--assert-no-lan', null);
  const noLan = noLanIp ? startNoLanWatch(noLanIp, { log: say }) : null;
  try {
    const cfg = await kv.takeConfig(deadline);
    if (!r.check('config', !!cfg)) return;
    r.set({ case: cfg.case, place: cfg.place });
    // 1. 文档服务地址：放本机经局域网发现（--lan-host 手填兜底），放云端直接用
    let docUrl = cfg.ws;
    let discovery = null;
    if (cfg.place === 'lan') {
      const [{ findSharedProject }, { discoverLan }] = await Promise.all([import('../../server/auth/route.mjs'), import('../../server/lan/discovery.mjs')]);
      const t0 = Date.now();
      const manual = arg('--lan-host', null);
      const found = await findSharedProject({ name: cfg.name, hostedUrl: null, lan: { discover: discoverLan, manual: manual ? [manual] : [] } }).catch((e) => ({ candidates: [], errors: [{ message: errText(e) }] }));
      const c = found.candidates.find((x) => x.where === 'lan' && x.projectId === cfg.projectId) ?? null;
      discovery = { ms: Date.now() - t0, via: c?.via ?? null, base: c?.base ?? null, firstSeenMs: c?.firstSeenMs ?? null, errors: (found.errors ?? []).slice(0, 3) };
      r.check('lan-found', !!c, discovery);
      if (c) docUrl = (await import('../../server/auth/route.mjs')).wsBaseOf(c.base);
    }
    // 2. 代理（e2 的受害方、C3 的受扰）
    const viaProxy = arg('--via-proxy', null);
    if (viaProxy) {
      const target = docTargetOf(docUrl, arg('--proxy-target', cfg.place === 'cloud' && /^wss:/.test(docUrl) ? CLOUD.docPlain : null)).text;
      proxy = await startProxy({ listen: `127.0.0.1:${viaProxy}`, target, stallProb: Number(arg('--stall-prob', 0)), dir: OUT });
      docUrl = `${proxy.url}${cfg.place === 'lan' ? '/docservice' : ''}`;
      r.set({ proxy: { port: proxy.port, target, meaning: proxy.listen.meaning ?? null } });
    }
    // 3. 独立渲染主机
    const config = path.join(OUT, 'host.json');
    sharedEntry({ url: docUrl, projectId: cfg.projectId, username: 'member', password: cfg.member.password, run, tag: NAME, file: config });
    const fakeFp = arg('--fake-fingerprint', null);
    host = await startRenderHost({ port, dir: OUT, config, maxConcurrent: Number(arg('--host-concurrency', 2)), fakeFingerprint: fakeFp, band: BAND });
    const q0 = await host.queue();
    const fingerprint = fakeFp ? { requested: true, value: fakeFp, applied: await host.fingerprintApplied() } : { requested: false };
    r.set({ envFingerprint: q0?.envFingerprint ?? null, codeVersion: q0?.codeVersion?.slice(0, 12) ?? null, fingerprint, discovery });
    // 预渲染进程诊断里的事件只留最近 80 条：每秒收一次节点事件（带时刻），免得被冲掉
    const pollEvents = async () => {
      try {
        prerenderUrl ??= (await getJson(`${host.editor}/api/prerender/info`, 5000)).body?.url ?? null;
        if (!prerenderUrl) return;
        const events = (await getJson(`${prerenderUrl}/api/frames/diagnostics`, 10_000)).body?.queue?.events ?? [];
        for (const e of events) {
          const m = /^node\.(claimed|completed|dedup|lost|failed|discarded)$/.exec(String(e?.event ?? ''));
          if (!m || typeof e.id !== 'string') continue;
          const key = `${e.event}|${e.id}|${e.at}`;
          if (eventsLog.includes(key)) continue;
          eventsLog.push(key);
          // 丢认领、失败、丢弃每一次都记（同一段可能在这台主机上丢不止一次），带时刻与原因，结果行 `idsDetail`
          if (m[1] === 'lost' || m[1] === 'failed' || m[1] === 'discarded') {
            if (eventsDetail.length < 200) eventsDetail.push({ ev: m[1], id: e.id, at: new Date(e.at ?? Date.now()).toISOString(),
              ...(e.reason ? { reason: String(e.reason).slice(0, 80) } : {}), ...(e.phase ? { phase: String(e.phase).slice(0, 40) } : {}),
              ...(e.error ? { error: String(e.error).slice(0, 160) } : {}) });
          }
          if (m[1] === 'discarded') continue;
          if (!idsSeen[m[1]].has(e.id)) idsSeen[m[1]].set(e.id, { at: e.at ?? Date.now(), error: e.error ? String(e.error).slice(0, 160) : undefined });
        }
      } catch { /* 下一拍再试 */ }
    };
    const tick = async () => { await pollEvents(); if (pollTimer !== false) pollTimer = setTimeout(tick, 1000); };
    void tick();
    await kv.ready({ port, envFingerprint: q0?.envFingerprint ?? null, codeVersion: q0?.codeVersion ?? null, fingerprint, discovery, viaProxy: !!proxy });
    say('ready', { port, envFingerprint: q0?.envFingerprint ?? null, viaProxy: !!proxy });
    const statsBase = { ...((await host.node()) ?? {}) };
    r.set({ statsBase: { completed: statsBase.completed ?? 0, dedup: statsBase.dedup ?? 0 } });

    // 4. 各用例的主机侧动作（与等 done 并行）
    const doneP = until(async () => (await kv.get('done', 0).catch(() => null)) ?? ((await kv.aborted()) ? { aborted: true } : null), Math.max(1000, deadline - Date.now()), 500);
    const side = [];
    if (cfg.case === 'e1') side.push(hostFake(r, kv, cfg, run, docUrl, (n) => { fakeNode = n; }));
    if (cfg.case === 'e2' && flag('--stall')) {
      if (!proxy) r.check('e2-stall-needs-proxy', false, '--stall 要配 --via-proxy');
      else side.push(hostStall(r, kv, host, proxy, idsSeen, pollEvents));
    }
    if (cfg.case === 'e3') side.push(hostE3(r, kv, host, cfg, run, docUrl, (w) => { epWatch = w; }, idsSeen));
    if (cfg.case === 'e4') side.push(hostE4(r, kv, cfg, run, docUrl, (x) => { replica = x; }));
    const done = await doneP;
    r.check('creator-done', !!done && !done.aborted, done);
    await Promise.allSettled(side);
    await pollEvents();
    const n = (await host.node()) ?? {};
    r.set({ stats: { claimed: n.claimed ?? null, completed: n.completed ?? null, dedup: n.dedup ?? null, failed: n.failed ?? null, lost: n.lost ?? null,
      released: n.released ?? null, opens: n.opens ?? null, resumes: n.resumes ?? null, connected: n.connected ?? null },
    ids: Object.fromEntries(Object.entries(idsSeen).map(([k, m]) => [k, [...m.keys()]])), idsDetail: eventsDetail });
    if (noLan) {
      const nl = await noLan.stop();
      r.set({ noLan: nl });
      r.check('no-lan-tcp', nl.tcpOk, { ip: noLanIp, baselineOk: nl.baselineOk, samples: nl.samples, maxTcp: nl.maxTcp, seen: nl.seen, baseline: nl.baseline });
      r.check('no-lan-discovery', nl.discoveryOk, nl.discovery);
    }
    // e2 / C1 的受害方:被扣住的任务在断线期间执行失败是预期的(旧认领随后作废),不算这台主机的失败
    const expected = new Set(r.extra.stall?.held ?? []);
    const unexpected = [...idsSeen.failed].filter(([id]) => !expected.has(id));
    r.check('host-no-failed', unexpected.length === 0, { failed: n.failed ?? null, unexpected: unexpected.slice(0, 3), expectedDuringStall: [...expected].filter((id) => idsSeen.failed.has(id)) });
  } catch (error) {
    r.fail(`${NAME} 出错：${errText(error)}`);
    say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
    await kv.abort(`${NAME}: ${error?.message ?? error}`);
  } finally {
    clearTimeout(pollTimer);
    pollTimer = false;
    await fakeNode?.stop().catch(() => {});
    await replica?.close().catch(() => {});
    await epWatch?.close().catch(() => {});
    if (host) {
      const exitLine = await host.stop();
      r.check('render-host-exit', host.child.exitCode === 0, { exitCode: host.child.exitCode, released: exitLine?.released ?? null });
    }
    if (proxy) {
      const s = await proxy.stop();
      r.set({ proxySummary: s ? { conns: s.conns, chunks: s.chunks, held: s.held, stalledConns: s.stalledConns, stallCommands: s.stallCommands, resumeCommands: s.resumeCommands } : null });
    }
    r.check('kv-no-401', kv.client.stats.unauthorized === 0, kv.client.stats);
    r.set({ out: OUT });
    await kv.result(r.toJSON());
  }
}

/** e1 的假任务那一轮：收到 fake.start 起一个假节点，fake.done 后停，完成的 id 进结果 */
async function hostFake(r, kv, cfg, run, docUrl, keep) {
  const start = await waitKv(kv, 'signal.fake.start');
  if (!start) return;
  const node = await startFakeNode({ entry: sharedEntry({ url: docUrl, projectId: cfg.projectId, username: 'member', password: cfg.member.password, run, tag: `${NAME}-fake` }),
    nodeId: `m8e-${NAME}-fake-${run}`, fingerprint: start.fingerprint, taskMs: start.taskMs ?? 300, maxConcurrent: 2, projects: [start.project], log: say });
  keep(node);
  await until(() => node.rec.opens > 0, 30_000, 100);
  await kv.signal(`fake.ready.${NAME}`, { at: Date.now() });
  await waitKv(kv, 'signal.fake.done');
  await delay(500);
  r.set({ fake: { fingerprint: start.fingerprint, completed: [...node.completed], dedup: [...node.dedup], lost: node.lost.length, failed: node.failed.length } });
  r.check('fake-node-no-failed', node.failed.length === 0, node.failed.slice(0, 3));
}

/** e2 的受害方：第一次持有任务时让代理 stall，写 signal.stall；creator 写 takeover 后 resume，核被扣住的任务旧认领 lease-lost */
async function hostStall(r, kv, host, proxy, idsSeen, pollEvents) {
  let held = null;
  const holding = await until(async () => {
    const n = await host.node().catch(() => null);
    if (n?.connected && Array.isArray(n.held) && n.held.length) { held = [...n.held]; return true; }
    if (await kv.get('done', 0).catch(() => null)) return 'done';
    return null;
  }, Math.max(1000, deadline - Date.now()), 100);
  if (!r.check('held-before-stall', holding === true, { holding })) return;
  const seconds = Number(arg('--stall-s', 0)) || 0;
  const n0 = (await host.node().catch(() => null)) ?? {};
  const stalled = await proxy.stall();
  const stallAt = Date.now();
  await kv.signal('stall', { held, at: stallAt, ...(seconds ? { seconds } : {}) });
  say('stalled', { held, seconds: seconds || null });
  // --stall-s:C1 应用层断线,固定秒数后 resume;不给:等 creator 写 takeover(E2 半开接手)
  const tk = seconds ? (await delay(seconds * 1000), null) : await waitKv(kv, 'signal.takeover', { timeoutMs: 6 * 60_000 });
  const resumed = await proxy.resume();
  const resumeAt = Date.now();
  // 恢复之后:被接手的任务旧认领 complete / 续约回 lease-lost(或会话接续时报丢);会话接续里照常完成的不会有 lost
  await until(async () => {
    await pollEvents();
    return held.every((id) => idsSeen.lost.has(id) || idsSeen.failed.has(id) || idsSeen.completed.has(id) || idsSeen.dedup.has(id)) || null;
  }, 180_000, 1000);
  const n1 = (await host.node().catch(() => null)) ?? {};
  const completedHeld = held.filter((id) => { const c = idsSeen.completed.get(id) ?? idsSeen.dedup.get(id); return c && c.at >= stallAt; });
  r.set({ stall: { held, seconds: seconds || null, stallAt, resumeAt, stalledMs: resumeAt - stallAt, takeoverSignal: !!tk, stallAck: !!stalled, resumeAck: !!resumed,
    lost: held.map((id) => ({ id, ...(idsSeen.lost.get(id) ?? {}), sinceResumeMs: idsSeen.lost.get(id) ? idsSeen.lost.get(id).at - resumeAt : null })), completedHeld,
    failed: held.filter((id) => idsSeen.failed.has(id)).map((id) => ({ id, ...idsSeen.failed.get(id) })),
    session: { opens: [n0.opens ?? null, n1.opens ?? null], resumes: [n0.resumes ?? null, n1.resumes ?? null], kind: (n1.opens ?? 0) > (n0.opens ?? 0) ? 'new-session' : (n1.resumes ?? 0) > (n0.resumes ?? 0) ? 'resumed' : 'unchanged' } } });
  r.check('proxy-stall-resume', !!stalled && !!resumed, { stall: stalled?.event ?? null, resume: resumed?.event ?? null });
}

/**
 * e3 主机侧：持有任务时写 signal.holding.<名>；另开一条成员连接盯 service.endpoints（C4：素材服务地址的撤回与重新下发），
 * 记本主机节点重连（opens 增加）的时刻，之后完成的任务算 epoch B（重启后渲染的）。
 */
async function hostE3(r, kv, host, cfg, run, docUrl, keep, idsSeen) {
  const { watchServiceEndpoints } = await import('../../server/render-node/endpoint.mjs');
  const w = await openConn({ entry: sharedEntry({ url: docUrl, projectId: cfg.projectId, username: 'member', password: cfg.member.password, as: 'member', role: 'page', run, tag: `${NAME}-ep` }), role: 'page', tag: `${NAME}-ep`, log: say });
  keep(w);
  const ep = { events: [], closes: 0, opens: 0, lastOpenAt: null };
  if (w) {
    w.ep.onClose(() => { ep.closes++; ep.events.push({ at: Date.now(), ev: 'close' }); });
    w.ep.onOpen(() => { ep.opens++; ep.lastOpenAt = Date.now(); ep.events.push({ at: Date.now(), ev: 'open' }); });
    watchServiceEndpoints(w.ep, ['asset'], (list) => {
      const urls = list.filter((e) => e.kind === 'asset').flatMap((e) => e.urls ?? []);
      ep.events.push({ at: Date.now(), ev: 'asset', urls: urls.length });
    });
  }
  // 放本机：局域网主机不经 service.endpoints 登记素材服务，地址随局域网发现下发（通告里带 docservice 与 asset）。
  // 重启期间每 2 s 查一次发现，记「查不到 → 又查到」的时刻（本机时钟）
  const lan = { polls: 0, downAt: null, backAt: null, asset: null, oks: [] };
  let lanPolling = cfg.place === 'lan';
  const lanLoop = (async () => {
    if (!lanPolling) return;
    const { discoverLan } = await import('../../server/lan/discovery.mjs');
    while (lanPolling) {
      const d = await discoverLan({ name: cfg.name, timeoutMs: 1500 }).catch(() => ({ hosts: [] }));
      lan.polls++;
      const h = d.hosts.find((x) => x.projectId === cfg.projectId) ?? null;
      if (h) lan.oks.push(Date.now());
      if (!h && lan.downAt === null) lan.downAt = Date.now();
      if (h && lan.downAt !== null && lan.backAt === null) { lan.backAt = Date.now(); lan.asset = h.asset ?? null; }
      await delay(500);
    }
  })();
  // 在线页面的副本：一开始就开，跟着创建者的写入；重启之后要自己以新会话重读、追到重启前最后一次提交
  const pageP = hostE3Page(r, kv, cfg, run, docUrl).catch((e) => { r.fail(`e3 页面副本出错：${errText(e)}`); return null; });
  const n0 = (await host.node()) ?? {};
  const holding = await until(async () => {
    const n = await host.node().catch(() => null);
    if (n?.connected && n.held?.length) return n;
    if (await kv.get('done', 0).catch(() => null)) return 'done';
    return null;
  }, Math.max(1000, deadline - Date.now()), 200);
  if (holding && holding !== 'done') await kv.signal(`holding.${NAME}`, { held: holding.held, at: Date.now() });
  // 等本节点重连：opens 增加（新会话），或连接断过又连上。opens 的基准取「持有任务」那一刻（节点那时一定连着）：
  // 取进本函数时的值不行 —— 节点可能还没连上（opens 0），第一次连上就被当成重连，重启前完成的段被算进「重启后」（AGENT-xnode-dedup）
  const openedAtHold = holding && holding !== 'done' ? (holding.opens ?? n0.opens ?? 0) : (n0.opens ?? 0);
  let wasDown = false;
  const reconnectedAt = await until(async () => {
    const n = await host.node().catch(() => null);
    if (n && n.connected === false) wasDown = true;
    if (n && n.connected && ((n.opens ?? 0) > openedAtHold || wasDown)) return Date.now();
    if (await kv.get('done', 0).catch(() => null)) return 'done';
    return null;
  }, Math.max(1000, deadline - Date.now()), 250);
  const reconnected = typeof reconnectedAt === 'number';
  // 重启很快(几秒)时轮询不一定撞上「查不到」:等重连之后第一次查到(新进程的应答)
  await until(() => (!lanPolling || (reconnected && lan.oks.some((t) => t >= reconnectedAt)) ? true : null), 60_000, 200);
  lanPolling = false;
  await lanLoop.catch(() => {});
  await waitKv(kv, 'done', { stopOn: ['abort'] });
  const page = await pageP;
  // 重新下发：放云端看 service.endpoints（连接重开之后第一次见到非空的素材服务地址）；
  // 放本机看局域网发现（节点重连之后第一次从发现拿到主机与素材服务地址用了多久；重启只几秒时轮询不一定撞上「查不到」）
  const reopenAt = ep.events.filter((e) => e.ev === 'open').at(-1)?.at ?? null;
  const firstAsset = reopenAt ? ep.events.find((e) => e.ev === 'asset' && e.at >= reopenAt && e.urls > 0) : null;
  const withdrawn = ep.events.some((e) => e.ev === 'asset' && e.urls === 0) || ep.closes > 0;
  const completedAfter = reconnected ? [...idsSeen.completed].filter(([, x]) => x.at >= reconnectedAt).map(([id]) => id) : [];
  const reannounceMs = cfg.place === 'lan'
    ? (reconnected ? ((t) => (t === undefined ? null : t - reconnectedAt))(lan.oks.find((t) => t >= reconnectedAt)) : null)
    : (firstAsset && reopenAt ? firstAsset.at - reopenAt : null);
  r.set({ e3: { reconnected, reconnectedAt: reconnected ? reconnectedAt : null, completedAfter, heldAtRestart: holding?.held ?? null, reannounceMs, page,
    lanDiscovery: cfg.place === 'lan' ? { polls: lan.polls, downMs: lan.downAt && lan.backAt ? lan.backAt - lan.downAt : null, asset: lan.asset } : null,
    endpoints: { closes: ep.closes, opens: ep.opens, withdrawn, events: ep.events.slice(-12).map((e) => ({ ...e, at: e.at - (ep.events[0]?.at ?? e.at) })) } } });
}

/**
 * e3 主机侧的在线页面：成员 page 角色的副本（`openReplica`，带历史）。收到 restart.request 记副本当时的版本与会话序号；
 * 等创建者写 restarted 之后，副本要以新会话（服务端重启，旧会话接续不上，连接层自己建新会话、重读）追到
 * rev ≥ lastCommit.rev，并且重启之后见到的那一版摘要与 lastCommit.digest 相同（`m8/lib.mjs` 的 judgeLastCommit）。
 * 结果回 `e3.page`，并判 page-resync-after-restart、last-commit-readable 两条。
 */
async function hostE3Page(r, kv, cfg, run, docUrl) {
  const doc = await waitKv(kv, 'signal.e3.doc');
  if (!r.check('page-doc-signal', !!doc)) return null;
  const replica = await openReplica({ entry: sharedEntry({ url: docUrl, projectId: cfg.projectId, username: 'member', password: cfg.member.password, as: 'member', role: 'page', run, tag: `${NAME}-page` }),
    docId: doc.docId, tag: `${NAME}-page`, history: true });
  try {
    const req = await waitKv(kv, 'signal.restart.request');
    if (!r.check('page-restart-request', !!req?.lastCommit, req ? { hasLastCommit: !!req.lastCommit } : null)) return null;
    const reqAt = Date.now();
    const lastCommit = req.lastCommit;
    const revBefore = replica.st.rev;
    const sessions0 = replica.st.sessions;
    const reopens0 = replica.st.reopens;
    await waitKv(kv, 'signal.restarted', { timeoutMs: 40 * 60_000 });
    // 重启之后：新会话里重读过、追到了那一版
    const synced = await until(() => (replica.st.sessions > sessions0 && replica.st.seen.some((x) => x.session > sessions0) && replica.st.rev >= lastCommit.rev ? true : null), 120_000, 100);
    const st = replica.st;
    const seenAfter = st.seen.filter((x) => x.session > sessions0);
    const firstReopen = seenAfter.find((x) => x.via === 'open') ?? null;
    const detachAt = replica.ep.stats?.().lastDetach?.at ?? null;
    const downAt = [detachAt, st.lastCloseAt].filter((t) => typeof t === 'number' && t >= reqAt - 60_000).sort((a, b) => a - b)[0] ?? null;
    const valueAt = String(lastCommit.path ?? '').split('/').filter(Boolean).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), st.body);
    // 「重启后重读过」只认新会话里真的完成了 project.open 的（会话建成而没重读的，副本还是重启前内存里的内容）
    const reopenedSessions = new Set(seenAfter.filter((x) => x.via === 'open').map((x) => x.session)).size;
    const j = judgeLastCommit(lastCommit, { sessionsAfter: reopenedSessions, rev: st.rev, seenAfter, valueAt });
    r.judge('page-resync-after-restart', j.resync);
    r.judge('last-commit-readable', j.readable);
    const at = seenAfter.filter((x) => x.rev === lastCommit.rev);
    return { docId: doc.docId, resync: j.resync.ok, readable: j.readable.ok, via: j.readable.via ?? null, synced: !!synced,
      revBefore, revAfter: st.rev, lastCommitRev: lastCommit.rev, digestMatch: j.readable.digestMatch ?? null,
      digestAfter: at.at(-1)?.digest?.slice(0, 16) ?? null, digestWant: String(lastCommit.digest ?? '').slice(0, 16),
      reconnectMs: firstReopen && downAt ? firstReopen.at - downAt : null, reopens: st.reopens - reopens0, sessionsAfter: st.sessions - sessions0, reopenedSessions,
      closes: st.closes, applied: st.applied };
  } finally {
    await replica.close().catch(() => {});
  }
}

/** e4 主机侧：成员 page 角色的副本，每轮 creator 写 e4.round.<k> 后追到那一版、回摘要 */
async function hostE4(r, kv, cfg, run, docUrl, keep) {
  const doc = await waitKv(kv, 'signal.e4.doc');
  if (!doc) return;
  const replica = await openReplica({ entry: sharedEntry({ url: docUrl, projectId: cfg.projectId, username: 'member', password: cfg.member.password, as: 'member', role: 'page', run, tag: `${NAME}-replica` }),
    docId: doc.docId, tag: `${NAME}-replica` });
  keep(replica);
  const rounds = [];
  for (let k = 0; k < doc.rounds; k++) {
    const want = await waitKv(kv, `signal.e4.round.${k}`);
    if (!want) break;
    const got = await replica.at(want.rev);
    await kv.signal(`e4.replica.${NAME}.${k}`, { rev: got.rev, digest: got.digest, at: Date.now() });
    rounds.push({ k, rev: got.rev, match: got.digest === want.digest });
  }
  r.set({ e4: { rounds, applied: replica.st.applied, reopens: replica.st.reopens } });
  r.check('replica-matches', rounds.length === doc.rounds && rounds.every((x) => x.match), rounds);
}

/* ================================================================== watcher（可选的独立旁观节点） */

async function runWatcher(r) {
  if (!COORD) { r.fail('要给 --coord'); process.exitCode = 2; return; }
  const run = await resolveRun({ coord: COORD, prefix: PREFIX, run: arg('--run'), isCreator: false, newRun: newRunId, deadline, log: say });
  const kv = roleKv({ coord: COORD, prefix: PREFIX, run, role: 'watcher', log: say });
  let w = null;
  try {
    const cfg = await kv.takeConfig(deadline);
    if (!r.check('config', !!cfg)) return;
    const qp = `m8e-${cfg.case}-${run}`;
    w = await openWatch({ entry: sharedEntry({ url: cfg.ws, projectId: cfg.projectId, username: 'member', password: cfg.member.password, run, tag: 'watcher-x' }),
      projects: [qp, `${qp}-fake`], nodeId: `m8e-watcher-x-${run}` });
    r.check('watching', w.first.watch === 'queue.snapshot', w.first);
    await waitKv(kv, 'done', { stopOn: ['abort'] });
    const ids = [...w.timeline.keys()];
    const s = ids.map((id) => ({ id, ...summarizeTimeline(w.events(id)) }));
    r.set({ tasks: ids.length, epochs: w.epochs, maxTaken: Math.max(0, ...s.map((x) => x.taken)), reopened: s.reduce((n, x) => n + x.reopenedAfterTaken, 0),
      notClosedDone: s.filter((x) => x.closed.at(-1) !== 'done').map((x) => x.id).slice(0, 10) });
  } catch (error) {
    r.fail(`watcher 出错：${errText(error)}`);
  } finally {
    await w?.close().catch(() => {});
    await kv.result(r.toJSON());
  }
}

/* ================================================================== signal（给主会话写回远端步骤完成的信号） */

async function runSignal(r) {
  const run = arg('--run', null);
  const name = arg('--name', null);
  if (!COORD || !run || !name) { r.fail('要给 --coord、--run、--name'); process.exitCode = 2; return; }
  let value = { by: 'signal', at: Date.now() };
  if (arg('--value', null)) { try { value = { ...value, ...JSON.parse(arg('--value')) }; } catch { r.fail('--value 不是 JSON'); process.exitCode = 2; return; } }
  const c = kvClient(COORD, { log: say });
  await c.put(kvKey(PREFIX, run, 'signal', name), value);
  r.check('signal-written', true, { key: kvKey(PREFIX, run, 'signal', name) });
}

/* ================================================================== all（本机替身） */

async function runAll() {
  const head = { probe: PROBE, place: PLACE, case: CASE, startedAt: Date.now() };
  if (!CASES.includes(CASE) || !['cloud', 'lan'].includes(PLACE)) {
    const r = createResult({ ...head, role: 'all' });
    r.fail('要给 --case e1|e2|e3|e4|e6、--place cloud|lan');
    process.exitCode = 2;
    return r;
  }
  const run = arg('--run', null) ?? newRunId();
  const out = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-m8e-${run}`)));
  fs.mkdirSync(out, { recursive: true });
  let hosted = null;
  let coord = null;
  let restarter = null;
  try {
    process.env.PROBE_MAIL_TOKEN = randomBytes(24).toString('base64url');
    hosted = await startHostedCombo({ dir: path.join(out, 'hosted') });
    coord = await startCoord({ mailToken: process.env.PROBE_MAIL_TOKEN });
    say('infra', { hosted: hosted.hosted, coord: coord.url });
    const lanIp = PLACE === 'lan' ? (arg('--lan-ip', null) ?? await autoLanIp()) : null;
    const pass = ['--clips', '--seconds', '--fake-tasks', '--burst', '--gaps', '--restart-after-done', '--timeout-min', '--host-concurrency', '--stall-prob']
      .flatMap((n) => (arg(n, null) !== null ? [n, arg(n)] : []));
    const flags = ['--no-identical', '--browser-node', '--keep'].filter((f) => flag(f));
    const common = ['--case', CASE, '--place', PLACE, '--coord', coord.url, '--run', run, '--out', out, '--band', `${LOCAL_BAND[0]}-${LOCAL_BAND[1]}`, ...pass];
    const hosts = DEFAULT_HOSTS[CASE];
    const roles = [{ role: 'creator', label: 'creator', args: ['--port', String(LOCAL_PORTS.creator), '--hosted', hosted.hosted, '--hosts', hosts.join(','), ...(lanIp ? ['--lan-ip', lanIp] : []), ...flags] }];
    for (const h of hosts) {
      const extra = [];
      if (CASE === 'e2' && h === 'host-a') extra.push('--via-proxy', String(LOCAL_PORTS.proxy), '--stall', ...(arg('--stall-s', null) ? ['--stall-s', arg('--stall-s')] : []));
      if (CASE === 'e6' && h === 'host-a') extra.push('--fake-fingerprint', arg('--fake-fingerprint', E6_FP));
      roles.push({ role: 'host', label: h, args: ['--name', h, '--port', String(LOCAL_PORTS[h]), ...extra] });
    }
    // 放云端的 e3：本机托管组合就是「云端」，收到 restart.request 由本进程同端口重启它
    if (PLACE === 'cloud' && CASE === 'e3') {
      restarter = (async () => {
        const kv = roleKv({ coord: coord.url, prefix: PREFIX, run, role: 'all', log: say });
        const req = await waitKv(kv, 'signal.restart.request');
        if (!req) return;
        const { docPort, assetPort } = hosted;
        await hosted.stop();
        hosted = await startHostedCombo({ dir: path.join(out, 'hosted'), docPort, assetPort });
        await kv.signal('restart.done', { by: 'all', at: Date.now() });
      })().catch((e) => say('restarter-error', { message: errText(e) }));
    }
    const results = await Promise.all(roles.map(({ role, args }) => runRole(SELF, role, [...common, ...args], { timeoutMs: TIMEOUT_MS + 5 * 60_000 })));
    const merged = mergeRoleResults({ ...head, run }, results.map((x, i) => ({ ...x, role: roles[i].label })));
    merged.set({ out, lanIp, hostedHealthz: await hosted.healthz().then((h) => ({ connections: h?.connections ?? null, sessions: h?.sessions ?? null })).catch(() => null) });
    const cr = results[0]?.line;
    if (cr?.skipped) merged.set({ skipped: cr.skipped });
    return merged;
  } catch (error) {
    const r = createResult({ ...head, role: 'all' });
    r.fail(`all 出错：${errText(error)}`);
    return r;
  } finally {
    await restarter;
    await coord?.stop();
    await hosted?.stop();
    if (!flag('--keep-temp')) { try { fs.rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄没放 */ } }
  }
}

/* ================================================================== 入口 */

let result;
if (ROLE === 'all') result = await runAll();
else if (['creator', 'host', 'watcher', 'signal'].includes(ROLE)) {
  result = createResult({ probe: PROBE, role: NAME, place: PLACE, case: CASE });
  try {
    await ({ creator: runCreator, host: runHost, watcher: runWatcher, signal: runSignal })[ROLE](result);
  } catch (error) { result.fail(`出错：${errText(error)}`); }
} else {
  result = createResult({ probe: PROBE, role: String(ROLE) });
  result.fail('--role 取 creator | host | watcher | signal | all（用法见文件头）');
  process.exitCode = 2;
}
process.stdout.write(`${JSON.stringify(result.toJSON())}\n`);
if (process.exitCode !== 2) process.exitCode = result.ok ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 10_000).unref();
