/**
 * M8 规模复测探针（计划 `docs/plan/m8-plan.md` 第 2.2 节 K1-X、I1-X，第 4 节第 9 项；主会话裁定 D4）。
 * 不渲染：假节点（`render-queue-e2e.mjs` 的写法，`scripts/probes/m8/conn.mjs` 的 startFakeNode）睡一会儿就报完成。
 * 一个进程开多个假节点连接；连接分在两台机器上（PC、笔记本各一个 worker），经协调口 KV 汇总，由 coordinator 判。
 *
 * 两个用例（原始定义：`docs/plan/Master-Execution-Plan.md` 第 7 节 M5b 的 K 表、C6 的 I 表；`docs/plan/render-queue-contract.md` K1、K2、I1、I2）：
 *
 *   K1-X（--case k1）指纹前置过滤防锁风暴。两种指纹各 --nodes 个节点（缺省 4），--tasks 个快照任务（缺省 200 = 20 张卡 × 2 种指纹 × 5 段），
 *     一半的卡锁在 X 上、另一半锁在 Y 上，于是每个节点看来都有一半的卡被另一种指纹锁住。顺序同 M5b 的场景台
 *     （`server/test/render-queue-prefilter.test.mjs` runStorm）：节点全部报到 → 发布「会被别的指纹锁住」的 100 个死任务
 *     → 紧接着（不等回包）`card.lock` 20 张卡 → 等全部 card.locked → 发布与锁同指纹的 100 个活任务 → 跑到活任务全部完成。
 *     判据：
 *       K1  过滤开（主会话〔裁〕2026-09-28 改过）：稳态下 `card-locked` 拒绝 0 次（硬）；竞态窗口内的拒绝 ≤ 本轮节点总数（硬，
 *           每个节点同时只有一条认领在路上）；窗口时长只记录；--order lock-first 那一轮竞态窗口内也要 0。
 *           原文「≤ 认领总数的 1%」来自 M5b 冻结时钟的单进程场景，跨机有天然的传播窗口，200 个任务时 1% 只容 1 次。
 *           「稳态」按节点自己的消息顺序定：收到第一条活任务的 task.opened 之后算稳态，之前算竞态窗口（不靠两台机器的时钟）。
 *           过滤关（D4 对照组，只在本机替身跑）：拒绝数作基数，要求 > 0（否则场景没意义）；M5b 本机的数是 400。
 *       K2  过滤开：不匹配的节点（节点指纹 ≠ 卡的锁指纹）收到已锁卡任务的 task.opened 0 条。
 *           计法：活任务里锁指纹不同的，收到就算；死任务在锁定之前的第一次可见（task.opened / queue.snapshot）不算，
 *           收到它的 hidden 撤回之后再可见、或第二次可见才算。过滤关时要求 > 0（对照）。
 *       死任务从没被认领（两种模式都要求：认领第 3a 步的锁检查不看开关）。
 *       J-全完、J-恰一（活任务，按 epoch）、J-纯层（每个活任务要求的指纹 = 完成它的节点的指纹）。
 *
 *   I1-X（--case i1）按项目的频道隔离。--projects-total 个队列项目（缺省 20，`i1p01`～`i1p20`），每个项目 --nodes-per-project 个节点
 *     （缺省 10）只 watch 本项目；对项目 A（`i1p01`）连续发布、认领、完成 --tasks 次（缺省 500，按 --batch 一批，上一批全完成再发下一批）。
 *     队列项目分在 --spaces 个探针共享项目里（缺省 2，按项目编号轮流分）：同一共享项目里的节点证 watch 隔离，
 *     另一个共享项目里的节点证共享项目（空间）隔离。判据：
 *       I1  非 A 的节点收到 A 的消息 0 条（任何 task.* / queue.snapshot 条目指向别的项目都算），也收到任何任务消息 0 条。
 *       I2  A 的每个任务，`task.closed(done)` 的实际投递次数 = watch 了 A 的连接数（每条连接恰好一次）；
 *           task.opened / task.taken 不超过能看见它的连接数（队列对它们带合并键，慢连接上可能只留最新一条，只记偏差不判少）。
 *       J-全完、J-恰一（按 epoch）。放云端时 --sample 采阿里云 RSS、CPU、网卡（要 PROMPTCUT_REMOTE，公共件 resources.mjs）。
 *
 * 角色（KV 前缀 `m8sc`，键名约定见 `scripts/probes/m8/kv.mjs`）：
 *   coordinator   建探针共享项目（K1 一个，I1 --spaces 个）、写 config；起旁观节点（K1）与发布方；等 --workers 各自 ready；
 *                 跑用例；写 done；收各 worker 的 result，判上面的判据；收尾删项目。
 *   worker        按 config 开假节点（K1：--nodes 个、指纹 --fingerprint；I1：--projects 范围内每个项目 --nodes-per-project 个），
 *                 全部连上后写 ready；等 done；把每个节点的计数写进 result。--name 是它在 KV 里的角色名（pc / laptop）。
 *   coord+nodes   coordinator，另以子进程在本机起一个 worker（--name 缺省 pc，其余参数照传）。
 *   all           本机替身：起临时托管组合（端口 0）与协调口（开信箱），一个 coordinator 加两个 worker 子进程（pc、laptop）模拟两台机器。
 *                 --prefilter off 时托管组合的队列关掉指纹前置过滤（D4 对照组，见下），只有 all 能用。
 *
 * 用法（命令里不放令牌；协调口开了信箱时令牌只从环境变量 PROBE_MAIL_TOKEN 取）：
 *   本机替身   node scripts/probes/m8-scale-probe.mjs --role all --case k1
 *              node scripts/probes/m8-scale-probe.mjs --role all --case k1 --prefilter off      D4 对照组（过滤关）
 *              node scripts/probes/m8-scale-probe.mjs --role all --case i1
 *   放云端     PC    node scripts/probes/m8-scale-probe.mjs --role coord+nodes --place cloud --case k1 --workers pc,laptop --fingerprint X --nodes 4 --tasks 200 --lock-half
 *              笔记本 node scripts/probes/m8-scale-probe.mjs --role worker --place cloud --case k1 --name laptop --fingerprint Y --nodes 4
 *              PC    node scripts/probes/m8-scale-probe.mjs --role coord+nodes --place cloud --case i1 --workers pc,laptop --projects 1-10 [--sample]
 *              笔记本 node scripts/probes/m8-scale-probe.mjs --role worker --place cloud --case i1 --name laptop --projects 11-20
 *   放本机     同上，--place lan --lan-host <PC 局域网 ip:端口> --coord <PC 上的协调口>（coordinator 必须在 PC：局域网模式只许本机建项目）
 *   worker 没给 --run 时从 KV 的 `m8sc.latest` 取本轮 id（10 分钟内写的），所以先起 coordinator 再起笔记本；也可以两边都给同一个 --run。
 *
 * 参数：
 *   --case k1|i1  --place cloud|lan|local  [--hosted <文档服务 http(s) 基址>] [--coord <协调口>] [--lan-host ip:port] [--run <id>] [--timeout-min 10]
 *   K1：[--tasks 200] [--segments 5] [--nodes 4] [--fingerprint X|Y|<16 位十六进制>] [--task-ms 200] [--lock-half（缺省就是，写不写都一样）]
 *       [--order join-first|lock-first]  join-first（缺省）= M5b 的顺序，节点报到后才发布死任务并锁卡，量竞态窗口；
 *                                        lock-first = 节点报到前就发布死任务并锁卡，节点只见锁定之后的世界（纯稳态，没有竞态窗口）
 *   I1：[--tasks 500] [--batch 50] [--projects 1-10] [--projects-total 20] [--nodes-per-project 10] [--spaces 2] [--task-ms 50] [--sample]
 *   all：[--prefilter on|off] [--keep-temp] [--out <目录>]
 *
 * D4 对照组（过滤关）怎么关：队列的开关 PREFILTER 只有构造参数（`server/render-queue/constants.mjs` 的 QUEUE_ENV 只登记了名字，
 * 文档服务不读它），托管组合没有运行时开关。本探针不改生产代码：`--role all --prefilter off` 起托管组合子进程时经 NODE_OPTIONS
 * 挂一个模块加载钩子，只把 `server/render-queue/constants.mjs` 源码里的 `PREFILTER: true` 换成 `false`，并在子进程 stderr
 * 打一行 `m8scale.prefilter-off` 作凭证（探针核这一行在）。只用于本机替身，放云端 / 放本机不支持。
 *
 * 端口：本分支分到 5750～5759；实际全用端口 0（托管组合、协调口），不占固定端口。
 * 输出：过程写 stderr；stdout 最后一行是结果行（`scripts/probes/m8/lib.mjs` 的 createResult 形状），ok 为假退出码 1，参数不对 2。
 * 纯逻辑（任务表、节点账本、判据）导出给单测 `server/test/m8-scale.test.mjs`；作为脚本运行时才跑入口。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  argsOf, createResult, mergeRoleResults, sayer, newRunId, fingerprintOf, judgeAllDone, judgeExactlyOnce,
  judgePureLayers, layerObservations, parseTaskId, placeParams, FINGERPRINT_RE,
} from './m8/lib.mjs';

const SELF = fileURLToPath(import.meta.url);
export const PREFIX = 'm8sc';
export const PROBE = 'm8-scale';
/** 两种测试指纹（16 位小写十六进制）；--fingerprint X / Y 指它们 */
export const FP = Object.freeze({ X: fingerprintOf('m8-scale-X'), Y: fingerprintOf('m8-scale-Y') });

/* ================================================================== 纯逻辑：K1 */

/** --fingerprint 的取值：X / Y / 16 位十六进制 */
export function resolveFingerprint(v, fps = FP) {
  if (v === 'X' || v === 'Y') return fps[v];
  if (typeof v === 'string' && FINGERPRINT_RE.test(v)) return v;
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * K1 的任务表：cards 张卡 × 2 种指纹 × segments 段。卡 0～cards/2-1 锁在 X 上，其余锁在 Y 上；
 * 指纹与锁指纹不同的是死任务（锁之前发布），相同的是活任务（锁之后发布）。形状同 `fakeLayerTasks`
 * （id = `snapshot:<resultKey>:<from>-<to>`），另带 `input.contentKey`（锁键 `snapshot:<contentKey>`，契约 F.1）。
 * @returns {{ tasks, dead: string[], live: string[], info: Record<string, { card: number, fp: string, lockFp: string, dead: boolean }>, locks: Array<{ contentKey: string, fp: string }> }}
 */
export function k1Plan({ run, queueProject, cards = 20, segments = 5, fpX = FP.X, fpY = FP.Y, framesPerSegment = 60 }) {
  if (!Number.isInteger(cards) || cards < 2 || cards % 2) throw new RangeError(`K1 的卡数要是 ≥ 2 的偶数：${cards}`);
  if (!Number.isInteger(segments) || segments < 1) throw new RangeError(`K1 的段数要是正整数：${segments}`);
  const tasks = [];
  const dead = [];
  const live = [];
  const info = {};
  const locks = [];
  for (let c = 0; c < cards; c++) {
    const contentKey = `m8sc-${run}-k1-card${pad2(c)}`;
    const lockFp = c < cards / 2 ? fpX : fpY;
    locks.push({ contentKey, fp: lockFp });
    for (const [tag, fp] of [['X', fpX], ['Y', fpY]]) {
      const resultKey = `m8sc-${run}-k1-c${pad2(c)}-${tag}`;
      for (let s = 0; s < segments; s++) {
        const from = s * framesPerSegment;
        const to = from + framesPerSegment - 1;
        const id = `snapshot:${resultKey}:${from}-${to}`;
        tasks.push({
          id, kind: 'snapshot', tier: 'shared', resultKey, range: { unit: 'localFrame', from, to },
          source: { projectId: queueProject, projectRev: 1 }, input: { contentKey },
          weight: { class: 'light', estMs: null, frames: framesPerSegment }, requires: { envFingerprint: fp }, priority: 0,
        });
        const isDead = fp !== lockFp;
        info[id] = { card: c, fp, lockFp, dead: isDead };
        (isDead ? dead : live).push(id);
      }
    }
  }
  return { tasks, dead, live, info, locks };
}

/** 从 --tasks 与 --segments 推卡数：tasks = cards × 2 × segments */
export function k1CardsOf(tasks, segments) {
  const cards = tasks / (2 * segments);
  if (!Number.isInteger(cards) || cards < 2 || cards % 2) throw new RangeError(`--tasks ${tasks} 要是 4 × --segments（${segments}）的整数倍`);
  return cards;
}

/**
 * K1 一个节点的账本：喂它这条连接上收到的每条业务消息（按到达顺序），最后 `tally()`。
 * @param {{ name: string, nodeFp: string, info: Record<string, { fp, lockFp, dead }> }} o
 */
export function createK1Ledger({ name, nodeFp, info, now = Date.now }) {
  let steady = false;               // 收到第一条活任务的 task.opened 之后
  let firstDeadSeenAt = null;       // 本节点第一次看见本指纹的死任务（本机时钟）
  let lastHiddenAt = null;          // 最后一条 hidden 撤回（本机时钟）；两者之差是本节点看到的竞态窗口
  const hidden = new Set();
  const visibleOnce = new Set();
  const claimedIds = [];
  const rejected = { race: {}, steady: {} };
  let claims = 0;
  let openedMismatch = 0;
  const mismatchSample = [];
  const hiddenUnexpected = [];
  let deadClaimed = 0;
  let live = 0;

  function visible(id) {
    const i = info[id];
    if (!i) return;
    if (i.lockFp !== nodeFp) {
      // 死任务：锁定前的第一次可见不算；撤回之后再可见、或第二次可见才算
      const counts = !i.dead || hidden.has(id) || visibleOnce.has(id);
      if (counts) {
        openedMismatch += 1;
        if (mismatchSample.length < 5) mismatchSample.push(id);
      }
    }
    if (i.dead && i.fp === nodeFp && firstDeadSeenAt === null) firstDeadSeenAt = now();
    visibleOnce.add(id);
  }

  return {
    onMessage(m) {
      switch (m?.type) {
        case 'queue.snapshot':
          for (const t of m.tasks ?? []) if (t?.id) visible(t.id);
          break;
        case 'task.opened': {
          const id = m.task?.id;
          if (!id) break;
          if (info[id] && !info[id].dead) { steady = true; live += 1; }
          visible(id);
          break;
        }
        case 'task.closed':
          if (m.state === 'hidden' && typeof m.id === 'string') {
            hidden.add(m.id);
            lastHiddenAt = now();
            const i = info[m.id];
            // 过滤开时锁定那一步撤回的应当恰好是本指纹、锁在别的指纹上的死任务
            if (!i || !i.dead || i.fp !== nodeFp) hiddenUnexpected.push(m.id);
          }
          break;
        case 'task.claimed':
          claims += 1;
          if (typeof m.id === 'string') {
            claimedIds.push(m.id);
            if (info[m.id]?.dead) deadClaimed += 1;
          }
          break;
        case 'task.claim-rejected': {
          claims += 1;
          const bucket = steady ? rejected.steady : rejected.race;
          const reason = m.reason ?? 'unknown';
          bucket[reason] = (bucket[reason] ?? 0) + 1;
          break;
        }
        default:
      }
    },
    tally() {
      return {
        name, fp: nodeFp, claims, claimed: claimedIds.length, rejected,
        cardLockedRace: rejected.race['card-locked'] ?? 0, cardLockedSteady: rejected.steady['card-locked'] ?? 0,
        openedMismatch, mismatchSample, hidden: hidden.size, hiddenUnexpected: hiddenUnexpected.slice(0, 5), hiddenUnexpectedCount: hiddenUnexpected.length,
        deadClaimed, liveOpened: live, sawSteady: steady,
        raceWindowMs: firstDeadSeenAt !== null && lastHiddenAt !== null ? lastHiddenAt - firstDeadSeenAt : null,
      };
    },
  };
}

/**
 * K1 / K2 的判据（汇总所有节点的账本）。
 * 过滤开的判据（主会话〔裁〕2026-09-28，改计划原文「竞态窗口内 ≤ 认领总数的 1%」）：稳态拒绝 = 0（硬）；
 * 竞态窗口内拒绝 ≤ 本轮节点总数（硬：每个节点同时只有一条认领在路上，这是协议能保证的上界；原 1% 来自 M5b 冻结时钟的
 * 单进程场景，跨机有天然的传播窗口）；窗口时长只记录。lock-first 那一轮另要求竞态窗口内拒绝 = 0。
 * @param {{ prefilter: boolean, tallies: Array<ReturnType<ReturnType<typeof createK1Ledger>['tally']>>, order?: 'join-first' | 'lock-first' }} o
 * @returns {{ k1, k2, deadNeverClaimed, totals }} 每个都是带 ok 的判据对象
 */
export function judgeK1({ prefilter, tallies, order = 'join-first' }) {
  const sum = (f) => tallies.reduce((s, t) => s + (t[f] ?? 0), 0);
  const totals = {
    nodes: tallies.length, claims: sum('claims'), claimed: sum('claimed'),
    cardLockedRace: sum('cardLockedRace'), cardLockedSteady: sum('cardLockedSteady'),
    openedMismatch: sum('openedMismatch'), hidden: sum('hidden'), hiddenUnexpected: sum('hiddenUnexpectedCount'), deadClaimed: sum('deadClaimed'),
  };
  totals.cardLocked = totals.cardLockedRace + totals.cardLockedSteady;
  const windows = tallies.map((t) => t.raceWindowMs).filter((v) => Number.isFinite(v));
  totals.raceWindowMsMax = windows.length ? Math.max(...windows) : null;
  const nodesOk = tallies.length > 0;
  const k1 = prefilter
    ? { ok: nodesOk && totals.cardLockedSteady === 0 && totals.cardLockedRace <= (order === 'lock-first' ? 0 : tallies.length),
      mode: 'prefilter-on', order, steady: totals.cardLockedSteady, race: totals.cardLockedRace, raceLimit: order === 'lock-first' ? 0 : tallies.length,
      claims: totals.claims, raceWindowMsMax: totals.raceWindowMsMax }
    : { ok: nodesOk && totals.cardLocked > 0, mode: 'prefilter-off (control)', cardLocked: totals.cardLocked, steady: totals.cardLockedSteady, race: totals.cardLockedRace, claims: totals.claims };
  const k2 = prefilter
    ? { ok: nodesOk && totals.openedMismatch === 0, mode: 'prefilter-on', openedMismatch: totals.openedMismatch, hiddenUnexpected: totals.hiddenUnexpected }
    : { ok: nodesOk && totals.openedMismatch > 0, mode: 'prefilter-off (control)', openedMismatch: totals.openedMismatch };
  const deadNeverClaimed = { ok: nodesOk && totals.deadClaimed === 0, deadClaimed: totals.deadClaimed };
  return { k1, k2, deadNeverClaimed, totals };
}

/* ================================================================== 纯逻辑：I1 */

/** 队列项目 id：i1p01～ */
export const i1ProjectId = (k) => `i1p${pad2(k)}`;
/** 第 k 个项目（从 1 起）放在第几个探针共享项目（从 0 起）：按编号轮流分 */
export const i1SpaceOf = (k, spaces) => (k - 1) % spaces;

/** `1-10` / `3` / `1-5,11-15` → [1..10]；不合法抛错 */
export function parseRange(text) {
  const out = [];
  for (const part of String(text).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) throw new RangeError(`范围写法不对：${text}`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < a) throw new RangeError(`范围写法不对：${text}`);
    for (let k = a; k <= b; k++) if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** I1 的任务：都在项目 A；resultKey 带项目 id，别的连接收到时认得出是哪个项目的 */
export function i1Tasks({ run, projectId, count, framesPerSegment = 60 }) {
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const resultKey = `m8sc-${run}-${projectId}-${String(i).padStart(4, '0')}`;
    const id = `snapshot:${resultKey}:0-${framesPerSegment - 1}`;
    tasks.push({
      id, kind: 'snapshot', tier: 'shared', resultKey, range: { unit: 'localFrame', from: 0, to: framesPerSegment - 1 },
      source: { projectId, projectRev: 1 }, input: {}, weight: { class: 'light', estMs: null, frames: framesPerSegment }, requires: {}, priority: 0,
    });
  }
  return tasks;
}

/** 任务 id → 队列项目 id（认 i1Tasks 的 resultKey；认不出回 null） */
export function i1ProjectOfId(id) {
  const rk = parseTaskId(id)?.resultKey;
  const m = rk ? /-(i1p\d+)-\d{4}$/.exec(rk) : null;
  return m ? m[1] : null;
}

/**
 * I1 一个节点的账本。`own` 是它 watch 的项目，`aProject` 是被连续发布的项目 A。
 * A 的节点另记每个任务收到的 opened / taken / closed(done) 条数（I2）。
 */
export function createI1Ledger({ name, own, aProject }) {
  const isA = own === aProject;
  let taskMsgs = 0;
  let foreign = 0;
  const foreignByType = {};
  const foreignSample = [];
  const byType = {};
  const perTask = new Map();   // id → [opened, taken, closedDone]
  const bump = (id, i) => {
    if (!isA) return;
    const a = perTask.get(id) ?? [0, 0, 0];
    a[i] += 1;
    perTask.set(id, a);
  };
  function seen(type, id, projectId) {
    taskMsgs += 1;
    byType[type] = (byType[type] ?? 0) + 1;
    const p = projectId ?? i1ProjectOfId(id);
    if (p !== own) {
      foreign += 1;
      foreignByType[type] = (foreignByType[type] ?? 0) + 1;
      if (foreignSample.length < 5) foreignSample.push({ type, id, project: p });
      return false;
    }
    return true;
  }
  return {
    isA,
    onMessage(m) {
      switch (m?.type) {
        case 'queue.snapshot':
          for (const t of m.tasks ?? []) if (t?.id) seen('snapshot', t.id, t.source?.projectId ?? t.projectId ?? null);
          break;
        case 'task.opened':
          if (m.task?.id && seen('task.opened', m.task.id, m.task.source?.projectId ?? null)) bump(m.task.id, 0);
          break;
        case 'task.taken':
          if (typeof m.id === 'string' && seen('task.taken', m.id, null)) bump(m.id, 1);
          break;
        case 'task.closed':
          if (typeof m.id === 'string' && seen('task.closed', m.id, null) && m.state === 'done') bump(m.id, 2);
          break;
        default:
      }
    },
    tally() {
      return { name, own, isA, taskMsgs, byType, foreign, foreignByType, foreignSample, ...(isA ? { perTask: Object.fromEntries(perTask) } : {}) };
    },
  };
}

/** 把若干 A 节点的 perTask 逐任务相加（worker 内、coordinator 跨 worker 都用它） */
export function sumPerTask(list) {
  const out = {};
  for (const pt of list) {
    for (const [id, a] of Object.entries(pt ?? {})) {
      const o = out[id] ?? [0, 0, 0];
      for (let i = 0; i < 3; i++) o[i] += a[i] ?? 0;
      out[id] = o;
    }
  }
  return out;
}

/**
 * I1：非 A 的节点收到 A 的消息 0 条、任何任务消息 0 条；所有节点收到别的项目的消息 0 条。
 * @param {Array<{ name, own, isA, taskMsgs, foreign }>} nodes 所有 worker 的节点账本（去掉 perTask 也行）
 */
export function judgeI1(nodes, { aProject }) {
  const nonA = nodes.filter((n) => n.own !== aProject);
  const foreign = nodes.reduce((s, n) => s + (n.foreign ?? 0), 0);
  const nonATaskMsgs = nonA.reduce((s, n) => s + (n.taskMsgs ?? 0), 0);
  const offenders = nodes.filter((n) => (n.foreign ?? 0) > 0 || (n.own !== aProject && (n.taskMsgs ?? 0) > 0)).slice(0, 5)
    .map((n) => ({ name: n.name, own: n.own, foreign: n.foreign, taskMsgs: n.taskMsgs, sample: n.foreignSample }));
  return { ok: nodes.length > 0 && nonA.length > 0 && foreign === 0 && nonATaskMsgs === 0, nodes: nodes.length, nonANodes: nonA.length, foreign, nonATaskMsgs, offenders };
}

/**
 * I2：A 的每个任务，closed(done) 投递次数 = watch 了 A 的连接数；opened ≤ 连接数、taken ≤ 连接数 - 1（认领者自己不收 taken）。
 * @param {{ ids: string[], perTask: Record<string, number[]>, watchers: number }} o
 */
export function judgeI2({ ids, perTask, watchers }) {
  const closedOff = [];
  const over = [];
  let openedShort = 0;
  let takenShort = 0;
  for (const id of ids) {
    const [o, t, c] = perTask[id] ?? [0, 0, 0];
    if (c !== watchers) closedOff.push({ id, closedDone: c });
    if (o > watchers || t > watchers - 1) over.push({ id, opened: o, taken: t });
    if (o < watchers) openedShort += watchers - o;
    if (t < watchers - 1) takenShort += watchers - 1 - t;
  }
  const delivered = ids.reduce((s, id) => s + ((perTask[id] ?? [0, 0, 0])[2]), 0);
  return {
    ok: ids.length > 0 && watchers > 0 && closedOff.length === 0 && over.length === 0,
    tasks: ids.length, watchers, closedDoneDelivered: delivered, closedDoneExpected: ids.length * watchers,
    closedOff: closedOff.slice(0, 5), closedOffCount: closedOff.length, over: over.slice(0, 5),
    coalesced: { openedShort, takenShort },
  };
}

/* ================================================================== D4：过滤关的加载钩子 */

/** 钩子模块的源码：只改 constants.mjs 里的 PREFILTER 缺省值，改不到就抛错（免得对照组静默变成实验组） */
export const PREFILTER_OFF_HOOK = `
export async function load(url, context, next) {
  const r = await next(url, context);
  if (!url.endsWith('/server/render-queue/constants.mjs')) return r;
  const src = String(r.source);
  const out = src.replace(/PREFILTER:\\s*true,/, 'PREFILTER: false,');
  if (out === src) throw new Error('m8scale prefilter hook: PREFILTER: true 没找到');
  process.stderr.write(JSON.stringify({ event: 'm8scale.prefilter-off', url }) + '\\n');
  return { ...r, source: out };
}
`;

/** 写钩子文件，回要追加进 NODE_OPTIONS 的片段 */
export function writePrefilterOffHook(dir) {
  const hooks = path.join(dir, 'm8scale-prefilter-hooks.mjs');
  const reg = path.join(dir, 'm8scale-prefilter-register.mjs');
  fs.writeFileSync(hooks, PREFILTER_OFF_HOOK);
  fs.writeFileSync(reg, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
  return `--import "${pathToFileURL(reg).href}"`;
}

/* ================================================================== 入口（只在作为脚本运行时） */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (isMain) await main();

async function main() {
  const [{ roleKv, resolveRun }, procs, conn] = await Promise.all([
    import('./m8/kv.mjs'), import('./m8/procs.mjs'), import('./m8/conn.mjs'),
  ]);
  const { startHostedCombo, startCoord, runRole, until } = procs;
  const { sharedEntry, createProbeProject, deleteProbeProject, startWatcher, startFakeNode, openConn } = conn;

  const { argv, arg, flag } = argsOf();
  const ROLE = arg('--role', 'all');
  const CASE = arg('--case', 'k1');
  const PLACE = arg('--place', ROLE === 'all' ? 'local' : 'cloud');
  const say = sayer(PROBE, ROLE === 'worker' ? arg('--name', 'worker') : ROLE);
  const TIMEOUT_MS = Number(arg('--timeout-min', 10)) * 60_000;
  const deadline = Date.now() + TIMEOUT_MS;
  const num = (name, fallback) => {
    const v = Number(arg(name, fallback));
    if (!Number.isFinite(v)) throw new RangeError(`${name} 要是数`);
    return v;
  };

  /** 放法的连接参数：coordinator 与 worker 都按它连（worker 最终用 config 里的 ws） */
  const placeOf = () => placeParams(PLACE, { hosted: arg('--hosted') ?? undefined, coord: arg('--coord') ?? undefined, lanHost: arg('--lan-host') ?? undefined });

  /* ---------------------------------------------------------------- 发布方 */

  async function openPublisher({ entry, publisherId }) {
    const c = await openConn({ entry, role: 'page', tag: 'publisher', log: say });
    if (!c) throw new Error('发布方连不上项目');
    const doneEvents = [];
    const states = new Map();
    const errors = [];
    const epochs = [];
    c.ep.onMessage((m) => {
      if (typeof m?.epoch === 'string' && !epochs.includes(m.epoch)) epochs.push(m.epoch);
      if (m?.type === 'task.done' && typeof m.id === 'string') { doneEvents.push({ id: m.id, epoch: m.epoch ?? null, at: Date.now() }); states.set(m.id, 'done'); }
      else if (m?.type === 'task.failed' && typeof m.id === 'string') { states.set(m.id, 'failed'); errors.push(`task.failed ${m.id}: ${m.error ?? ''}`); }
      else if (m?.type === 'error') errors.push(`error ${m.reason ?? ''}: ${m.detail ?? ''}`);
    });
    const hello = await c.rpc({ type: 'publisher.hello', publisherId });
    if (hello.type !== 'publisher.welcome') throw new Error(`publisher.hello 回 ${hello.type} ${hello.reason ?? ''}`);
    return {
      doneEvents, states, errors, epochs,
      /** 发布一批（分块，每块 ≤ 100 个）；回每个任务的结果 */
      async publish(tasks) {
        const results = [];
        for (let i = 0; i < tasks.length; i += 100) {
          const r = await c.rpc({ type: 'task.publish', tasks: tasks.slice(i, i + 100) }, 60_000);
          if (r.type !== 'task.published') throw new Error(`task.publish 回 ${r.type} ${r.reason ?? ''}`);
          results.push(...(r.results ?? []));
        }
        return results;
      },
      /** 不等回包就发出去（与前一条消息保持顺序），回等回包的 Promise */
      lock: (contentKey, fp) => c.rpc({ type: 'card.lock', kind: 'snapshot', contentKey, envFingerprint: fp }, 60_000),
      async waitDone(ids, until_) {
        while (Date.now() < until_) {
          if (ids.every((id) => states.get(id) === 'done' || states.get(id) === 'failed')) return true;
          await delay(100);
        }
        return false;
      },
      close: () => c.close(),
    };
  }

  const healthzOf = async (P) => {
    try {
      const res = await fetch(P.healthz, { signal: AbortSignal.timeout(10_000) });
      const h = await res.json();
      return { connections: h?.connections ?? null, sessions: h?.sessions ?? null, epoch: h?.queue?.epoch ?? h?.epoch ?? null };
    } catch (error) {
      return { error: String(error?.message ?? error).slice(0, 120) };
    }
  };

  /* ---------------------------------------------------------------- coordinator */

  async function runCoordinator(r, { spawnWorker = null } = {}) {
    const P = placeOf();
    const workers = String(arg('--workers', 'pc,laptop')).split(',').map((s) => s.trim()).filter(Boolean);
    const prefilter = arg('--prefilter', 'on') !== 'off';
    if (!prefilter && PLACE !== 'local') { r.fail('--prefilter off 只用于本机替身（D4 对照组）'); process.exitCode = 2; return; }
    if (CASE !== 'k1' && CASE !== 'i1') { r.fail('--case 取 k1 | i1'); process.exitCode = 2; return; }
    const run = await resolveRun({ coord: P.coord, prefix: PREFIX, run: arg('--run'), isCreator: true, newRun: newRunId, deadline, log: say });
    r.set({ run, case: CASE, place: PLACE, prefilter, workers });
    const kv = roleKv({ coord: P.coord, prefix: PREFIX, run, role: 'coordinator', log: say });
    const projects = [];
    let watcher = null;
    let publisher = null;
    let child = null;
    try {
      r.set({ healthzBefore: await healthzOf(P) });
      const where = PLACE === 'lan' ? 'lan' : 'hosted';
      const spaces = CASE === 'i1' ? Math.max(1, num('--spaces', 2)) : 1;
      for (let s = 0; s < spaces; s++) {
        projects.push(await createProbeProject({ where, ws: P.ws, lanBase: P.hosted, name: `m8sc-${run}-${CASE}-${s}` }));
      }
      r.set({ projectIds: projects.map((p) => p.projectId) });
      const spaceEntries = projects.map((p) => ({ projectId: p.projectId, member: { username: 'member', password: p.projectPassword } }));
      const common = { run, case: CASE, ws: P.ws, spaces: spaceEntries, prefilter, at: Date.now() };
      let cfg;
      if (CASE === 'k1') {
        const segments = num('--segments', 5);
        const cards = k1CardsOf(num('--tasks', 200), segments);
        const order = arg('--order', 'join-first');
        if (order !== 'join-first' && order !== 'lock-first') { r.fail('--order 取 join-first | lock-first'); process.exitCode = 2; return; }
        cfg = { ...common, queueProject: `m8sc-k1-${run}`, cards, segments, fps: FP, taskMs: num('--task-ms', 200), order };
      } else {
        cfg = { ...common, projectsTotal: num('--projects-total', 20), aProject: i1ProjectId(1), taskMs: num('--task-ms', 50), tasks: num('--tasks', 500), batch: num('--batch', 50) };
      }
      const creatorEntry = (p, tag) => sharedEntry({ url: P.ws, projectId: p.projectId, username: 'creator', password: p.creatorPassword, as: 'creator', role: 'page', run, tag });
      const memberEntry = (p, tag) => sharedEntry({ url: P.ws, projectId: p.projectId, username: 'member', password: p.projectPassword, run, tag });
      let k1 = null;
      if (CASE === 'k1') {
        // 旁观节点（不带指纹：前置过滤对它不生效，看得见全部，只收不认领）与发布方先连上
        const plan = k1Plan({ run, queueProject: cfg.queueProject, cards: cfg.cards, segments: cfg.segments, fpX: cfg.fps.X, fpY: cfg.fps.Y });
        watcher = await startWatcher({ entry: memberEntry(projects[0], 'watcher'), projects: [cfg.queueProject], nodeId: `m8sc-watcher-${run}`, log: say });
        publisher = await openPublisher({ entry: creatorEntry(projects[0], 'publisher'), publisherId: `m8sc-pub-${run}` });
        k1 = { plan, byId: new Map(plan.tasks.map((t) => [t.id, t])), watcher, publisher, locked: false };
        // lock-first：节点报到之前就发布死任务并锁卡（节点只见锁定之后的世界，没有竞态窗口）
        if (cfg.order === 'lock-first' && !(await k1DeadAndLock(r, k1))) return;
      }
      await kv.config(cfg);
      say('config', { projects: r.extra.projectIds, case: CASE });
      if (spawnWorker) child = spawnWorker(run);

      // 等各 worker 的 ready；有人写了 abort 就不再等
      const readies = {};
      for (const w of workers) {
        readies[w] = await until(async () => (await kv.client.get(kv.key('ready', w), 5_000).catch(() => null)) ?? ((await kv.aborted()) ? { ok: false, aborted: true } : null),
          Math.max(1000, deadline - Date.now()), 100);
      }
      const missing = workers.filter((w) => !readies[w]?.ok);
      if (!r.check('workers-ready', missing.length === 0, { missing, nodes: Object.fromEntries(workers.map((w) => [w, readies[w]?.nodes ?? null])) })) {
        await kv.abort(`workers not ready: ${missing.join(',')}`);
        return;
      }
      r.set({ healthzReady: await healthzOf(P) });

      if (CASE === 'k1') await coordK1({ r, kv, cfg, readies, workers, k1 });
      else await coordI1({ r, kv, cfg, readies, workers, projects, creatorEntry, setPublisher: (p) => { publisher = p; } });
      r.set({ healthzAfter: await healthzOf(P) });
    } catch (error) {
      r.fail(`coordinator 出错：${String(error?.message ?? error).slice(0, 600)}`);
      say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
      await kv.abort(error?.message ?? error);
    } finally {
      if (r.fails.length) await kv.abort(`coordinator: ${r.fails[0].slice(0, 160)}`);
      await kv.done({});
      await publisher?.close();
      await watcher?.close();
      for (const p of projects) {
        const del = await deleteProbeProject({ ws: P.ws, projectId: p.projectId, creatorPassword: p.creatorPassword, run });
        r.check(`project-deleted:${p.projectId}`, del.deleted, del.error);
      }
      if (child) {
        const res = await child;
        r.set({ localWorker: { code: res.code, ok: res.line?.ok ?? null } });
      }
      await kv.result(r.toJSON());
    }
  }

  /** 死任务 → 紧接着锁全部卡（不等回包）→ 等全部 card.locked；回是否都成 */
  async function k1DeadAndLock(r, k1) {
    const { plan, byId, publisher } = k1;
    const deadTasks = plan.dead.map((id) => byId.get(id));
    const t0 = Date.now();
    const pubDead = publisher.publish(deadTasks);
    const lockReplies = Promise.all(plan.locks.map((l) => publisher.lock(l.contentKey, l.fp)));
    const deadResults = await pubDead;
    const locked = await lockReplies;
    const deadErrors = deadResults.filter((x) => x.error);
    r.check('dead-published', deadErrors.length === 0 && deadResults.length === plan.dead.length, { n: deadResults.length, errors: deadErrors.slice(0, 3) });
    const notGranted = locked.filter((m) => m.type !== 'card.locked' || m.granted !== true);
    r.set({ deadPublishToAllLockedMs: Date.now() - t0 });
    k1.locked = r.check('locks-granted', notGranted.length === 0 && locked.length === plan.locks.length, { n: locked.length, notGranted: notGranted.slice(0, 3) });
    return k1.locked;
  }

  async function coordK1({ r, kv, cfg, readies, workers, k1 }) {
    const { plan, byId, watcher, publisher } = k1;
    const fpsOfWorkers = Object.fromEntries(workers.map((w) => [w, readies[w].fingerprint]));
    r.set({ tasks: plan.tasks.length, dead: plan.dead.length, live: plan.live.length, cards: cfg.cards, workerFingerprints: fpsOfWorkers });
    r.check('two-fingerprints', new Set(Object.values(fpsOfWorkers)).size >= 2 && Object.values(fpsOfWorkers).every((f) => f === cfg.fps.X || f === cfg.fps.Y), fpsOfWorkers);

    // join-first（缺省，M5b 的顺序）：节点都报到了，这时才发布死任务并锁卡 → 有竞态窗口
    if (cfg.order === 'join-first' && !(await k1DeadAndLock(r, k1))) return;
    if (!k1.locked) return;
    const liveTasks = plan.live.map((id) => byId.get(id));
    const t0 = Date.now();
    const liveResults = await publisher.publish(liveTasks);
    const liveErrors = liveResults.filter((x) => x.error);
    r.check('live-published', liveErrors.length === 0, { n: liveResults.length, errors: liveErrors.slice(0, 3) });
    const allDone = await publisher.waitDone(plan.live, deadline - 60_000);
    r.set({ liveToDoneMs: allDone ? Math.max(...publisher.doneEvents.map((e) => e.at)) - t0 : null });
    await delay(2000);   // 稳态：让迟到的认领、拒绝都落地
    await kv.done({ tasks: plan.live.length });

    const results = {};
    for (const w of workers) results[w] = await kv.takeResult(w, deadline);
    r.check('worker-results', workers.every((w) => results[w]), Object.fromEntries(workers.map((w) => [w, !!results[w]])));
    const tallies = workers.flatMap((w) => results[w]?.tallies ?? []);
    const completedBy = {};
    const nodeFps = {};
    for (const t of tallies) {
      nodeFps[t.name] = t.fp;
      for (const id of t.completed ?? []) completedBy[id] ??= t.name;
    }
    const v = judgeK1({ prefilter: cfg.prefilter, tallies, order: cfg.order });
    r.judge('K1-card-locked', v.k1);
    r.judge('K2-opened-mismatch', v.k2);
    r.judge('K1-dead-never-claimed', v.deadNeverClaimed);
    r.judge('J-all-done', judgeAllDone(plan.live, publisher.states));
    r.judge('J-exactly-once', judgeExactlyOnce(plan.live, publisher.doneEvents));
    r.judge('J-pure-layers', judgePureLayers(layerObservations(liveTasks, completedBy, nodeFps)));
    // 旁观节点：死任务从没被认领（时间线里没有 taken）
    const deadTaken = plan.dead.filter((id) => watcher.events(id).some((e) => e.ev === 'taken'));
    r.check('watcher-dead-never-taken', deadTaken.length === 0, { deadTaken: deadTaken.slice(0, 5) });
    r.set({ totals: v.totals, perWorker: Object.fromEntries(workers.map((w) => [w, summarizeK1Worker(results[w])])), publisherErrors: publisher.errors.slice(0, 5), epochs: publisher.epochs });
    r.count('doneEvents', publisher.doneEvents.length);
    r.check('kv-no-401', kv.client.stats.unauthorized === 0, kv.client.stats);
  }

  const summarizeK1Worker = (res) => {
    if (!res) return null;
    const t = res.tallies ?? [];
    const s = (f) => t.reduce((a, x) => a + (x[f] ?? 0), 0);
    return { fingerprint: res.fingerprint, nodes: t.length, claims: s('claims'), claimed: s('claimed'), completed: t.reduce((a, x) => a + (x.completed?.length ?? 0), 0),
      cardLockedRace: s('cardLockedRace'), cardLockedSteady: s('cardLockedSteady'), openedMismatch: s('openedMismatch'), hidden: s('hidden'), lost: s('lost'), failed: s('failed') };
  };

  async function coordI1({ r, kv, cfg, readies, workers, projects, creatorEntry, setPublisher }) {
    const aProject = cfg.aProject;
    const aSpace = projects[i1SpaceOf(1, projects.length)];
    const served = workers.flatMap((w) => readies[w].projects ?? []);
    const missingProjects = Array.from({ length: cfg.projectsTotal }, (_, i) => i + 1).filter((k) => !served.includes(k));
    const dupProjects = served.filter((k, i) => served.indexOf(k) !== i);
    r.check('projects-covered', missingProjects.length === 0 && dupProjects.length === 0, { served: served.length, missing: missingProjects, dup: dupProjects });

    let sampler = null;
    if (flag('--sample')) {
      if (!process.env.PROMPTCUT_REMOTE) r.check('sampler', false, '要 PROMPTCUT_REMOTE（--sample 采阿里云资源）');
      else {
        const { startSampler } = await import('./m8/resources.mjs');
        sampler = startSampler({ everyMs: 15_000 });
      }
    }
    const publisher = await openPublisher({ entry: creatorEntry(aSpace, 'publisher'), publisherId: `m8sc-pub-${cfg.run}` });
    setPublisher(publisher);
    const tasks = i1Tasks({ run: cfg.run, projectId: aProject, count: cfg.tasks });
    const ids = tasks.map((t) => t.id);
    const t0 = Date.now();
    const errors = [];
    for (let i = 0; i < tasks.length; i += cfg.batch) {
      const batch = tasks.slice(i, i + cfg.batch);
      const res = await publisher.publish(batch);
      errors.push(...res.filter((x) => x.error));
      if (!(await publisher.waitDone(batch.map((t) => t.id), deadline - 60_000))) { r.fail(`第 ${i / cfg.batch + 1} 批没在时限内完成`); break; }
    }
    r.check('published', errors.length === 0, { errors: errors.slice(0, 3) });
    r.set({ publishToAllDoneMs: Date.now() - t0 });
    await delay(2000);   // 让最后一批的 task.closed 送到每条连接
    if (sampler) r.set({ resources: await sampler.stop() });
    await kv.done({ tasks: ids.length });

    const results = {};
    for (const w of workers) results[w] = await kv.takeResult(w, deadline);
    r.check('worker-results', workers.every((w) => results[w]), Object.fromEntries(workers.map((w) => [w, !!results[w]])));
    const nodes = workers.flatMap((w) => results[w]?.nodes ?? []);
    const aWatchers = workers.reduce((s, w) => s + (results[w]?.aNodes ?? 0), 0);
    const perTask = sumPerTask(workers.map((w) => results[w]?.aPerTask));
    r.judge('I1-no-cross-project', judgeI1(nodes, { aProject }));
    r.judge('I2-delivery-equals-watchers', judgeI2({ ids, perTask, watchers: aWatchers }));
    r.judge('J-all-done', judgeAllDone(ids, publisher.states));
    r.judge('J-exactly-once', judgeExactlyOnce(ids, publisher.doneEvents));
    r.set({
      aProject, aWatchers, connections: nodes.length, spaces: projects.length,
      perWorker: Object.fromEntries(workers.map((w) => [w, results[w] ? { nodes: results[w].nodes?.length ?? 0, aNodes: results[w].aNodes, projects: results[w].projects,
        taskMsgs: (results[w].nodes ?? []).reduce((s, n) => s + n.taskMsgs, 0), foreign: (results[w].nodes ?? []).reduce((s, n) => s + n.foreign, 0),
        completed: results[w].completed, lost: results[w].lost, failed: results[w].failed } : null])),
      publisherErrors: publisher.errors.slice(0, 5), epochs: publisher.epochs,
    });
    r.count('doneEvents', publisher.doneEvents.length);
    r.check('kv-no-401', kv.client.stats.unauthorized === 0, kv.client.stats);
  }

  /* ---------------------------------------------------------------- worker */

  async function runWorker(r) {
    const P = placeOf();
    const name = arg('--name');
    if (!name || !/^[A-Za-z0-9_-]{1,16}$/.test(name)) { r.fail('worker 要给 --name（1～16 个 [A-Za-z0-9_-]）'); process.exitCode = 2; return; }
    const run = await resolveRun({ coord: P.coord, prefix: PREFIX, run: arg('--run'), isCreator: false, newRun: newRunId, deadline, log: say });
    r.set({ run, name });
    const kv = roleKv({ coord: P.coord, prefix: PREFIX, run, role: name, log: say });
    const nodes = [];
    try {
      const cfg = await kv.takeConfig(deadline);
      if (!r.check('config', !!cfg)) return;
      r.set({ case: cfg.case });
      const entryFor = (s, tag) => sharedEntry({ url: cfg.ws, projectId: cfg.spaces[s].projectId, username: cfg.spaces[s].member.username, password: cfg.spaces[s].member.password, run, tag });
      let readyFields;
      if (cfg.case === 'k1') {
        const fingerprint = resolveFingerprint(arg('--fingerprint'), cfg.fps);
        if (!fingerprint) { r.fail('K1 的 worker 要给 --fingerprint X | Y | <16 位十六进制>'); process.exitCode = 2; await kv.ready({ ok: false }); return; }
        const plan = k1Plan({ run, queueProject: cfg.queueProject, cards: cfg.cards, segments: cfg.segments, fpX: cfg.fps.X, fpY: cfg.fps.Y });
        const count = num('--nodes', 4);
        for (let i = 0; i < count; i++) {
          const nodeName = `${name}-${i}`;
          const ledger = createK1Ledger({ name: nodeName, nodeFp: fingerprint, info: plan.info });
          const node = await startFakeNode({ entry: entryFor(0, nodeName), nodeId: `m8sc-${nodeName}-${run}`, fingerprint, profile: 'pc', taskMs: cfg.taskMs, maxConcurrent: 2,
            projects: [cfg.queueProject], log: say, onMessage: (m) => ledger.onMessage(m) });
          nodes.push({ name: nodeName, node, ledger });
        }
        r.set({ fingerprint });
        readyFields = { fingerprint, nodes: count };
      } else {
        const mine = parseRange(arg('--projects', `1-${cfg.projectsTotal}`));
        const per = num('--nodes-per-project', 10);
        for (const k of mine) {
          if (k > cfg.projectsTotal) throw new RangeError(`--projects 里的 ${k} 超出 ${cfg.projectsTotal}`);
          const own = i1ProjectId(k);
          const s = i1SpaceOf(k, cfg.spaces.length);
          for (let i = 0; i < per; i++) {
            const nodeName = `${name}-${own}-${i}`;
            const ledger = createI1Ledger({ name: nodeName, own, aProject: cfg.aProject });
            const node = await startFakeNode({ entry: entryFor(s, nodeName), nodeId: `m8sc-${nodeName}-${run}`, profile: 'pc', taskMs: cfg.taskMs, maxConcurrent: 2,
              projects: [own], log: say, onMessage: (m) => ledger.onMessage(m) });
            nodes.push({ name: nodeName, node, ledger, own });
          }
        }
        r.set({ projects: mine });
        readyFields = { projects: mine, nodes: nodes.length };
      }
      const opened = await until(() => nodes.every((n) => n.node.rec.opens > 0), 60_000, 200);
      if (!r.check('nodes-connected', !!opened, { nodes: nodes.length, notOpen: nodes.filter((n) => n.node.rec.opens === 0).map((n) => n.name).slice(0, 5) })) {
        await kv.ready({ ok: false, ...readyFields });
        await kv.abort(`${name}: 节点没全部连上`);
        return;
      }
      // queue.watch 由节点自己在 start 后发；等一小会儿让它落地再报 ready
      await delay(1500);
      await kv.ready({ ok: true, ...readyFields });
      say('ready', readyFields);

      const done = await until(async () => (await kv.get('done', 0).catch(() => null)) ?? ((await kv.aborted()) ? { aborted: true } : null), Math.max(1000, deadline - Date.now()), 300);
      r.check('coordinator-done', !!done && !done.aborted, done);
      const failed = nodes.reduce((s, n) => s + n.node.failed.length, 0);
      const lost = nodes.reduce((s, n) => s + n.node.lost.length, 0);
      if (cfg.case === 'k1') {
        r.set({ tallies: nodes.map((n) => ({ ...n.ledger.tally(), completed: [...n.node.completed, ...n.node.dedup], lost: n.node.lost.length, failed: n.node.failed.length })) });
      } else {
        const tallies = nodes.map((n) => n.ledger.tally());
        const aPerTask = sumPerTask(tallies.filter((t) => t.isA).map((t) => t.perTask));
        r.set({ nodes: tallies.map(({ perTask, ...rest }) => rest), aNodes: tallies.filter((t) => t.isA).length, aPerTask,
          completed: nodes.reduce((s, n) => s + n.node.completed.length, 0), lost, failed });
      }
      r.check('nodes-no-failed', failed === 0, { failed });
    } catch (error) {
      r.fail(`${name} 出错：${String(error?.message ?? error).slice(0, 600)}`);
      await kv.abort(`${name}: ${error?.message ?? error}`);
    } finally {
      await Promise.all(nodes.map((n) => n.node.stop().catch(() => {})));
      await kv.result(r.toJSON());
    }
  }

  /* ---------------------------------------------------------------- all（本机替身） */

  async function runAll() {
    const out = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-m8sc-${Date.now().toString(36)}`)));
    fs.mkdirSync(out, { recursive: true });
    const prefilter = arg('--prefilter', 'on') !== 'off';
    const head = { probe: PROBE, place: 'local', case: CASE, startedAt: Date.now() };
    let hosted = null;
    let coord = null;
    try {
      process.env.PROBE_MAIL_TOKEN = randomBytes(24).toString('base64url');
      const savedNodeOptions = process.env.NODE_OPTIONS;
      if (!prefilter) process.env.NODE_OPTIONS = `${savedNodeOptions ?? ''} ${writePrefilterOffHook(out)}`.trim();
      const hostedP = startHostedCombo({ dir: out });   // 环境在调用时同步拷走
      if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedNodeOptions;
      hosted = await hostedP;
      coord = await startCoord({ mailToken: process.env.PROBE_MAIL_TOKEN });
      say('infra', { hosted: hosted.hosted, coord: coord.url, prefilter });
      const hookApplied = hosted.lines.some((l) => l.includes('m8scale.prefilter-off'));
      const run = newRunId();
      const common = ['--place', 'local', '--hosted', hosted.hosted, '--coord', coord.url, '--run', run, '--case', CASE, '--timeout-min', String(TIMEOUT_MS / 60_000)];
      const pass = (names) => names.flatMap((n) => (arg(n) !== null ? [n, arg(n)] : []));
      const caseArgs = pass(['--tasks', '--segments', '--task-ms', '--batch', '--projects-total', '--spaces', '--order']);
      let roles;
      if (CASE === 'k1') {
        roles = [
          ['coordinator', 'coordinator', [...common, ...caseArgs, '--workers', 'pc,laptop', '--prefilter', prefilter ? 'on' : 'off']],
          ['pc', 'worker', [...common, '--name', 'pc', '--fingerprint', 'X', '--nodes', arg('--nodes', '4')]],
          ['laptop', 'worker', [...common, '--name', 'laptop', '--fingerprint', 'Y', '--nodes', arg('--nodes', '4')]],
        ];
      } else {
        const total = Number(arg('--projects-total', 20));
        const half = Math.floor(total / 2);
        const per = arg('--nodes-per-project', '10');
        roles = [
          ['coordinator', 'coordinator', [...common, ...caseArgs, '--workers', 'pc,laptop']],
          ['pc', 'worker', [...common, '--name', 'pc', '--projects', `1-${half}`, '--nodes-per-project', per]],
          ['laptop', 'worker', [...common, '--name', 'laptop', '--projects', `${half + 1}-${total}`, '--nodes-per-project', per]],
        ];
      }
      const results = await Promise.all(roles.map(([, role, args]) => runRole(SELF, role, args)));
      const merged = mergeRoleResults({ ...head, run }, results.map((x, i) => ({ ...x, role: roles[i][0] })));
      if (!prefilter) merged.check('prefilter-off-hook-applied', hookApplied, { hookApplied });
      const c = merged.extra.roles?.coordinator ?? {};
      merged.set({ out, prefilter, summary: { totals: c.totals ?? null, perWorker: c.perWorker ?? null, liveToDoneMs: c.liveToDoneMs ?? null, publishToAllDoneMs: c.publishToAllDoneMs ?? null,
        aWatchers: c.aWatchers ?? null, connections: c.connections ?? null }, hostedHealthz: await hosted.healthz().then((h) => ({ connections: h?.connections ?? null, sessions: h?.sessions ?? null })).catch(() => null) });
      return merged;
    } catch (error) {
      const r = createResult({ ...head, role: 'all' });
      r.fail(`all 出错：${String(error?.message ?? error).slice(0, 600)}`);
      return r;
    } finally {
      await coord?.stop();
      await hosted?.stop();
      if (!flag('--keep-temp')) { try { fs.rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄没放 */ } }
    }
  }

  /* ---------------------------------------------------------------- 分派 */

  let result;
  if (ROLE === 'all') result = await runAll();
  else if (ROLE === 'coordinator' || ROLE === 'coord+nodes') {
    result = createResult({ probe: PROBE, role: 'coordinator', place: PLACE, case: CASE });
    const spawnWorker = ROLE === 'coord+nodes'
      ? (run) => {
        const drop = new Set(['--role', '--run', '--workers', '--name', '--sample', '--prefilter', '--order']);
        const rest = [];
        for (let i = 0; i < argv.length; i++) {
          if (drop.has(argv[i])) { if (argv[i] !== '--sample') i += 1; continue; }
          rest.push(argv[i]);
        }
        return runRole(SELF, 'worker', [...rest, '--run', run, '--name', arg('--name', 'pc')]);
      }
      : null;
    try { await runCoordinator(result, { spawnWorker }); } catch (error) { result.fail(`出错：${String(error?.message ?? error).slice(0, 600)}`); }
  } else if (ROLE === 'worker') {
    result = createResult({ probe: PROBE, role: arg('--name', 'worker'), place: PLACE, case: CASE });
    try { await runWorker(result); } catch (error) { result.fail(`出错：${String(error?.message ?? error).slice(0, 600)}`); }
  } else {
    result = createResult({ probe: PROBE, role: String(ROLE) });
    result.fail('--role 取 all | coordinator | coord+nodes | worker');
    process.exitCode = 2;
  }
  process.stdout.write(`${JSON.stringify(result.toJSON())}\n`);
  if (process.exitCode !== 2) process.exitCode = result.ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 10_000).unref();
}
