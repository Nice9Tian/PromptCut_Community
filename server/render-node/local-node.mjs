import { createNodeSession } from './session.mjs';
import { lockKeyOf, splitPlan } from './split.mjs';
import { createTaskRunner, untilAborted } from './task-runner.mjs';
import { browserCardsOf, isListPlan, priorityBand } from '../render-queue/messages.mjs';
import { LOCK_IDLE_TAKEOVER_MS, QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { exportIndexOf, isExportOnlyPlan } from './export-plan.mjs';

/**
 * 本机渲染节点的编排(分布式预渲染 M3,契约 `docs/plan/render-queue-contract.md` D 节)。
 *
 * 生产编排模块:把节点会话(`session.mjs`)、切分(`split.mjs`)、细任务编排(`task-runner.mjs`)和注入进来的三样东西串起来:
 *
 *   endpoint  到队列的一条连接(进程内是环回端点,M5 起是 WebSocket 适配层)
 *   executor  真正干活的:算计划、渲染一段
 *   sink      产物库:先推送、确认收全,再报完成(设计 4.4,语义 `mechanism/asset-service.md`)
 *
 * 只认这些注入接口,不引网络、不碰文件系统、不读环境变量、不开计时器,也不认识任何真实存储。
 * 环回传输、假执行器、假产物库只在 `server/test/`(仅供测试与进程内集成),生产代码不得引用。
 * 节拍由调用方驱动:按间隔调 `tick()`。
 *
 * # 认领到任务之后
 *
 * 开工先同步报一次进度 0,让队列的停滞规则也管得到卡死、从不报进度的执行器。
 *
 *   plan    executor.plan → splitPlan → task.publish 细任务(带 reqId)→ 等同一 reqId 的
 *           task.published → (有 card-locked 就照锁重切重发)→ complete 这个 plan
 *           (带片段清单的计划任务:预渲染集合换成它的片段清单;流只按清单里的片段切;预渲染重试计划(backfill)不切流、细任务标 backfill,见 `listPlanOverrides`)
 *   细任务   sink.has 为真就直接 complete(dedup,带 sink.resultFor 的清单);否则 executor.render →
 *            sink.put → 收全才 complete(带 put 回的清单),没收全 fail(可重试)。
 *            sink 收到的 ref 带任务的 input 与 requires(契约 J.3)。这一段在同构的 `task-runner.mjs` 里
 *            (M7 D11:页面的纯浏览器节点共用,不牵进 split.mjs 与 node:crypto),行为与原来相同
 *   M7       plan 的认领回包带 `browserFingerprints`(D1)时交给切分,浏览器可做的卡另出一份;
 *            切分完成后把最终发布成功的细任务交给 `executor.afterSplit`(可选,写层表 v 3,D12);
 *            `takeoverLocked` 收到发布回包里锁的描述 `{ lockIdleMs, lockedByProfile, lockUndone }`(D2),
 *            pc 与独立渲染主机传 `idleLockTakeover`
 *   出错     fail,`error.retryable === false` 才不可重试
 *
 * 发布必须先于完成:派生任务继承 plan 的用户与订阅者(契约 A.4 末段),条件是发布那一刻
 * plan 仍由本节点认领。所以等发布回包回来、确认发布已生效,才 complete(契约 F.7 第 5 条)。
 *
 * # 发布被锁拒绝(契约 F.7)
 *
 * 队列拒建被别的指纹锁定的卡,回包对应项是 `{ id, error: 'card-locked', lockedBy: X }`。
 * 这些项的锁键和 X 并进 `cardLocks` 重跑 `splitPlan`,只重发这些锁键的任务:
 * `takeoverLocked` 命中的带 `takeover` 按本节点指纹重发,其余照 X 出键。最多重来
 * `RELOCK_ROUNDS` 轮,还被拒的放弃;有过重发就报 `plan-relocked { id, lockKeys, gaveUp }`。
 * `complete` 的 `derived` 只列最终发布成功(回包项没有 `error`)的 id。
 *
 * 等回包不开计时器,只由收到的消息推进:回包、带同一 reqId 的 `error`(按可重试失败处理)、
 * 中止信号(丢认领、让路、stop)。`start()` 重连时,仍持有的 plan 把在等的发布按原 reqId
 * 重发一次(发布是幂等的,合并进已有任务);回包丢了又不重连时,续约的进度停在 0,
 * 由队列的停滞规则回收。
 *
 * # 「仍持有」与迟到的结果
 *
 * 每个认领开一次「执行」(run),带自己的令牌和 AbortController。执行里每个 await 落定后,
 * 往队列发任何消息之前都要重新判一次仍持有:
 *
 *   没有 stop、本次执行没被中止、在跑表里的仍是这一次执行,且 `session.held()` 里有
 *   同 id、同令牌的持有
 *
 * 判完到发消息之间不 await,中间不会插进别的消息。会话的 `complete` / `fail` / `progress`
 * 用的是会话**此刻**持有的令牌,所以「令牌相同」这一条保证旧的执行绝不会拿新令牌去完成任务:
 * 同一 id 被本节点重新认领到新令牌时,旧的执行已经被 `onLost` 中止,而且它的令牌对不上。
 * 判不过就丢弃结果、报 `discarded`,不发任何消息。已经推到产物库的产物不回收:按内容寻址,
 * 下一个认领者查 `has` 会直接完成。
 *
 * `start(resume)` 只接续本实例在跑表里、令牌相同的项:接续只用于同一实例的重连。
 *
 * 对注入接口的每次等待都和中止信号赛跑:执行器或产物库不理会中止、一直不返回,这次执行也会
 * 在中止时落定(`settled()` 不会被卡死的执行器拖住),之后它再返回什么都被丢弃。
 *
 * @typedef {object} PlanContext  executor.plan 的结果,原样喂给 splitPlan(契约 B.4、F.2)
 * @property {string} entryKey
 * @property {object[]} cardPlan
 * @property {Set<string>} [prerenderSet]
 * @property {object[]} [streams]
 * @property {number[]} [anchorFrames]
 * @property {Record<string, string>} [cardSourceVersions]
 * @property {(control: object) => object} [weightOf]
 * @property {(control: object) => boolean} [isUserCard]
 * @property {(control: object) => boolean} [isGraphCard]
 * @property {Map<string, string> | Record<string, string>} [cardLocks]
 *   卡片级指纹锁(契约 F.2):锁键 `<kind>:<input.contentKey>` → 锁指纹。被别的指纹锁定的卡
 *   按锁指纹出键,剩余帧只给同指纹的节点
 * @property {boolean | Set<string> | ((lockKey: string) => boolean)} [takeover]
 *   要接手哪些被别的指纹锁定的卡:按本节点指纹出键,任务带 `takeover: true`
 * @property {string | null} [localMedia]
 *   本地档能力闸(M6c X2):这一版项目里有没有内容哈希的素材时,发布方的 nodeId。`usesLocalMedia` 判真的
 *   细任务写 `requires.localMedia`,只有那个节点能认领
 * @property {(control: object) => boolean} [usesLocalMedia]  哪些 control 的输入用到这些素材(缺省全部)
 *
 * @typedef {object} Executor  执行器(契约 D.1)
 * @property {(planTask: object, opts: { signal: AbortSignal }) => Promise<PlanContext>} plan
 *   算这一版项目的计划。planTask 是 TaskView
 * @property {(task: object, opts: { signal: AbortSignal, progress: (done: number) => void }) => Promise<unknown>} render
 *   渲染一段。task 是 TaskView;progress(done) 报进度;返回的 artifacts 不透明,原样交给 sink.put。
 *   抛出的错误带 `retryable === false` 时按不可重试处理,否则可重试
 * @property {(planTask: object, info: { tasks: object[], derived: string[] }) => unknown} [afterSplit]
 *   (M7 D12)切分完成、发布回包都回来之后调一次,`tasks` 是最终发布成功的细任务(TaskInput)。不等它,出错只记事件
 *
 * @typedef {object} SinkRef
 * @property {string} resultKey
 * @property {'snapshot' | 'stream'} kind
 * @property {'shared' | 'local' | null} tier   流任务是 null
 * @property {{ unit: string, from: number, to: number }} range
 * @property {object} [input]      任务的 input,原样(契约 J.3;C6.2 第 11 节第 3 条)
 * @property {object} [requires]   任务的 requires,原样
 *
 * @typedef {object} Sink  产物库(契约 D.1;M5 起由素材服务实现)
 * @property {(ref: SinkRef) => Promise<boolean>} has   这一段是否已经收全
 * @property {(entry: SinkRef & { artifacts: unknown, meta: { taskId: string, nodeId: string, token: number } }) => Promise<{ complete: boolean, result?: object }>} put
 *   推送一段;`complete !== true` 表示没收全。meta 供记账(设计第 7 节「节点信任」)。
 *   回包带 `result`(任务清单)时,展开进 `task.complete` 的结果(契约 J.3)
 * @property {(ref: SinkRef) => Promise<object | null>} [resultFor]
 *   `has` 回 true 之后取这一段的清单(C6.4 第 3 节);去重完成时展开进结果。没有这个方法、
 *   回 null 或抛错时,只带 `{ ranges, dedup: true }` 完成(契约 J.10)
 *
 * @typedef {object} Endpoint  到队列的一条连接
 * @property {(message: object) => void} send
 * @property {(handler: (message: object) => void) => void} onMessage
 *
 * @typedef {object} LocalNode
 * @property {(resume?: { id: string, token: number }[]) => void} start
 * @property {() => void} tick
 * @property {(reason?: string) => number} yieldAll
 * @property {() => void} stop
 * @property {() => string[]} running
 * @property {() => { id: string, kind: string, phase: string }[]} occupying  还没走到推送的执行(契约 A.12〔裁〕)
 * @property {() => Promise<void>} settled
 * @property {ReturnType<typeof createNodeSession>} session
 */

const noop = () => {};

/** 发布被 card-locked 拒绝后最多重来几轮(契约 F.7 第 5 条)。 */
const RELOCK_ROUNDS = 2;

/**
 * 锁闲置接手的判定(M7 契约 D2,第 13 节裁定):给 `createLocalNode({ takeoverLocked })` 用,pc 与独立渲染主机都传它。
 * 发布回包说这张卡锁在别的环境上时:锁定方闲置**严格超过** 30 s(`lockIdleMs > LOCK_IDLE_TAKEOVER_MS`,与本机锁库
 * `server/card-lock.mjs` 的 `CARD_LOCK_IDLE_MS` 同一个数),且锁定方这张卡还有没做完的(`lockUndone` 不是 0;
 * 没带这一项按「不知道」算,不挡)才接手 —— 语义「还缺帧、而锁定方已经有一段时间没有再产出，就用自己的指纹接手整张卡」
 * (`mechanism/rendering.md`)。回包里没有 `lockIdleMs`(旧队列)一律不接手。纯函数。
 *
 * @param {string} lockKey
 * @param {string} lockedBy
 * @param {{ lockIdleMs?: number, lockedByProfile?: string | null, lockUndone?: number }} [info]
 * @returns {boolean}
 */
export function idleLockTakeover(lockKey, lockedBy, info = {}) {
  const idle = info?.lockIdleMs;
  if (typeof idle !== 'number' || !Number.isFinite(idle)) return false;
  return idle > LOCK_IDLE_TAKEOVER_MS && info.lockUndone !== 0;
}

/**
 * `takeoverLocked`(布尔或 `(lockKey, lockedBy, info) => boolean`)→ 判定函数;只认 `=== true`。
 * `info` 是发布回包里这把锁的描述 `{ lockIdleMs, lockedByProfile, lockUndone }`(M7 D2;旧队列没有)。
 */
function takeoverLockedTest(takeoverLocked) {
  if (takeoverLocked === true) return () => true;
  if (typeof takeoverLocked === 'function') return (lockKey, lockedBy, info) => takeoverLocked(lockKey, lockedBy, info) === true;
  return () => false;
}

/** `cardLocks`(Map、普通对象或缺省)复制成 Map,再并进新的锁。 */
function mergedLocks(cardLocks, extra) {
  const out = new Map();
  if (cardLocks != null) {
    const entries = typeof cardLocks.entries === 'function' && typeof cardLocks.get === 'function'
      ? cardLocks.entries()
      : Object.entries(cardLocks);
    for (const [key, value] of entries) out.set(key, value);
  }
  for (const [key, value] of extra) out.set(key, value);
  return out;
}

/**
 * 带片段清单的计划任务:预渲染重试计划(c10a 契约第 17 节;(旧页面的 `backfill` 档;2026-10-07 起在线页面一律发普通优先级的清单计划,这一档没有新的发布方,留着只为认部署切换期间的老页面))与在线页面的清单计划
 * (C10 契约第 7 节、第 18 节第 9 条)。清单里的片段当重卡算键 —— 预渲染集合换成清单(与本机的判重无关)。
 * 细任务的档跟着 plan:预渲染重试计划的一律标 `backfill`,清单计划照 normal 的名次。不是带清单的 plan 时回空对象,切分照旧。
 *
 * 轨道流(`docs/plan/browser-stream-task.md` 第一处;任务书 `docs/plan/render-refactor-task.md`「甲三」):
 *   - 预渲染重试计划照旧不切流(发它的老页面不消费流);
 *   - 在线页面的清单计划:执行器给了 `browserStreamsFor`(按清单里的片段算流,`frame-pipeline.mjs` 的 `planForQueue`)时,
 *     这些流给浏览器出一份(单卡流、浏览器做得了的才出)。**切分方自己的那一份**看执行器给的 `ownListStreams`:
 *       - 为真(本机此刻能产流;托管方的渲染节点另要这个项目的「生成轨道流」开着,由执行器按项目收,`prerender-executor.mjs` 的 `plan`):单卡流连自己的那一份一起出,
 *         与浏览器那一份照 `splitPlan` 的规矩成对(`input.dual`,谁先认领谁得);
 *       - 不为真而执行器给了 `ownListSparseStreams: true`(托管方的渲染节点能产流、这个项目的「生成轨道流」关着):单卡流标 `ownSparseOnly`,
 *         切分方自己的那一份只出稀疏流任务(`splitPlan` 文件头「稀疏流任务」),浏览器那一份照常;
 *       - 都不为真(本机不能产流、旧执行器):照旧只给浏览器出(`browserOnly`),切分方自己不产。
 *     组流任何时候都只标 `browserOnly`(浏览器画不了,等于不出):组流的内容键跟着「清单里还有哪些片段」变,流任务回来时
 *     对不回这一版,层表也列不出它(`frame-pipeline.mjs` 的 `issuedStreamSpecs` 只认单卡流和依赖下层的流)。
 *     **依赖下层的流**(`kind: 'below'`,任务书「戊二」的「下层四」):照单卡流同一套开关办 —— `ownListStreams` 为真出切分方自己的那一份
 *     (稀疏、满密度两种任务),只有 `ownListSparseStreams` 时标 `ownSparseOnly`,都不为真标 `browserOnly`。浏览器那一份 `splitPlan`
 *     本来就不出(浏览器做不了:要隔离工程加差分取层),所以这种流只按切分方自己的指纹出、由切分方自己产;标了 `browserOnly` 就一份都不出。
 *     它的内容键只由目标卡和它下面的层决定,与清单里还有哪些片段无关,流任务回来时按目标卡现算一条就对得回(`prerender-executor.mjs` 的 `matchStream`)。
 *     执行器没给 `browserStreamsFor`(旧执行器、测试替身)就不切流,与原来相同。
 *
 * 只为导出的清单计划(`input.exportOnly: true`,在线浏览器导出时为本页不执行的卡发的;`../export-frames.mjs`):
 *   预渲染集合是空的(不切快照)、不切轨道流,只按清单里的片段出导出位图任务(`exportStreams`,执行器的 `exportStreamsFor` 给;
 *   出不了的片段和原因在 `exportUnsupported`)。执行器没给 `exportStreamsFor`(旧执行器)时全部记成出不了(`no-executor`)。
 */
export function listPlanOverrides(task, plan) {
  if (!isListPlan(task)) return {};
  const clips = Array.isArray(task.input?.clips) ? task.input.clips.filter(id => typeof id === 'string' && id) : [];
  if (isExportOnlyPlan(task)) {
    let found = null;
    // `input.exportSalt`:页面上一次失败之后重新导出带的标识,导出键跟着换(`../export-frames.mjs` 的 `exportSaltOf`)
    if (typeof plan?.exportStreamsFor === 'function') { try { found = plan.exportStreamsFor(new Set(clips), task.input?.exportSalt); } catch { found = null; } }
    const exportStreams = Array.isArray(found?.streams) ? found.streams.filter(s => s && typeof s === 'object') : [];
    const exportUnsupported = found ? (Array.isArray(found.unsupported) ? found.unsupported : []) : clips.map(clipId => ({ clipId, reason: 'no-executor' }));
    return { prerenderSet: new Set(), streams: [], exportStreams, exportUnsupported, lane: 'normal' };
  }
  const backfill = priorityBand(task.priority) === 'backfill';
  let streams = [];
  if (!backfill && typeof plan?.browserStreamsFor === 'function') {
    const own = plan.ownListStreams === true;
    const sparseOwn = !own && plan.ownListSparseStreams === true;
    const single = s => s.kind === 'card' && s.plane === 'local' && Array.isArray(s.clipIds) && s.clipIds.length === 1;
    // 依赖下层的流:只有目标卡一个成员、按舞台坐标;切分方自己的那一份照单卡流同一套开关出
    const below = s => s.kind === 'below' && s.plane === 'stage' && Array.isArray(s.clipIds) && s.clipIds.length === 1;
    const ownable = s => single(s) || below(s);
    try {
      streams = (plan.browserStreamsFor(new Set(clips)) ?? []).filter(s => s && typeof s === 'object')
        .map(s => (own && ownable(s) ? { ...s } : sparseOwn && ownable(s) ? { ...s, ownSparseOnly: true } : { ...s, browserOnly: true }));
    } catch { streams = []; }
  }
  return { prerenderSet: new Set(clips), streams, lane: backfill ? 'backfill' : 'normal' };
}

/** 发布回包里一把锁的描述(M7 D2):没有的项不带 */
function lockInfoOf(result) {
  const info = {};
  for (const k of ['lockIdleMs', 'lockedByProfile', 'lockUndone']) if (result?.[k] !== undefined) info[k] = result[k];
  return info;
}

/**
 * @param {object} options
 * @param {string} options.nodeId
 * @param {string} [options.publisherId]  缺省等于 nodeId;切分出的细任务以它发布
 * @param {object} options.node           契约 B.2 的节点描述
 * @param {Endpoint} options.endpoint
 * @param {() => number} options.now
 * @param {() => number} [options.random]
 * @param {() => boolean} [options.isIdle]
 * @param {number} [options.maxConcurrent]
 * @param {object} [options.constants]
 * @param {string[] | 'all'} [options.projects]
 * @param {string} [options.codeVersion]  切分细任务时写进 requires.codeVersion
 * @param {Executor} options.executor
 * @param {Sink} options.sink
 * @param {boolean | ((lockKey: string, lockedBy: string, info: object) => boolean)} [options.takeoverLocked]
 *   发布被 card-locked 拒绝时要不要接手(契约 F.7):缺省 false,照锁定方的指纹重发;pc 与独立渲染主机传
 *   `idleLockTakeover`(M7 D2)
 * @param {(event: object) => void} [options.onEvent]  诊断用
 * @param {(task: object, info: { held: number }) => boolean} [options.canClaim]  这个任务此刻能不能开工(会话认领前过一遍;独立渲染主机用,契约 A.12〔裁〕)
 * @param {() => number} [options.claimLimit]  此刻最多持有几项(认领闸;缺省恒为 maxConcurrent,见 session.mjs)
 * @returns {LocalNode}
 */
export function createLocalNode({
  nodeId,
  publisherId = nodeId,
  node,
  endpoint,
  now,
  random,
  isIdle,
  maxConcurrent,
  constants = {},
  projects,
  codeVersion,
  executor,
  sink,
  takeoverLocked = false,
  onEvent = noop,
  canClaim,
  claimLimit,
}) {
  /** 在等回包的发布:reqId → { run, message, resolve, reject } */
  const publishes = new Map();
  let publishSeq = 0;
  /** 队列认不认稀疏流任务(`node.welcome.sparseStreams`;旧队列不带):为真才切稀疏流任务(`splitPlan` 的 `sparseStreams`) */
  let sparseStreams = false;
  let attached = false;
  const takesOverLocked = takeoverLockedTest(takeoverLocked);

  // 诊断回调出错不能打断协议流程(它可能在消息处理器里被调到)
  const emit = event => {
    try { onEvent(event); } catch { /* 诊断回调的异常吞掉 */ }
  };

  // 细任务的编排在同构模块里(M7 D11);plan 的切分只在这里(要 split.mjs)
  // eslint-disable-next-line prefer-const
  let session;
  const runner = createTaskRunner({ nodeId, session: () => session, executor, sink, emit, executePlan, now });
  const { holding } = runner;

  // undefined 不传,让会话用它自己的缺省值
  const sessionOptions = { nodeId, node, send: message => endpoint.send(message), now, constants, onTask: runner.onTask, onLost: runner.onLost };
  if (random !== undefined) sessionOptions.random = random;
  if (isIdle !== undefined) sessionOptions.isIdle = isIdle;
  if (maxConcurrent !== undefined) sessionOptions.maxConcurrent = maxConcurrent;
  if (projects !== undefined) sessionOptions.projects = projects;
  if (canClaim !== undefined) sessionOptions.canClaim = canClaim;
  if (claimLimit !== undefined) sessionOptions.claimLimit = claimLimit;
  session = createNodeSession(sessionOptions);

  /**
   * 发一条 `task.publish`(带本实例唯一的 reqId),等同一 reqId 的 `task.published` 回来,
   * 回它的 `results`。同一 reqId 回的是 `error`(如 bad-message)就按可重试的错误拒绝。
   * 不开计时器;和中止信号赛跑,中止或落定后都撤掉等待。
   */
  function publishAndWait(run, tasks) {
    publishSeq += 1;
    const reqId = `${publisherId}#publish-${publishSeq}`;
    const message = { type: 'task.publish', tasks, reqId };
    const waiting = () => new Promise((resolve, reject) => {
      // 先登记再发:同步传输下回包可能在 send 返回之前就到了
      publishes.set(reqId, { run, message, resolve, reject });
      endpoint.send(message);
    });
    return untilAborted(waiting, run.controller.signal).finally(() => publishes.delete(reqId));
  }

  /**
   * 切分并发布派生任务,处理 card-locked 拒建(契约 F.7 第 5 条)。
   * → `{ derived: 发布成功的 id, published: 发布成功的细任务(TaskInput,层表按它写,M7 D12),
   *      relocked: 重发过的锁键(升序), gaveUp: 最后仍被拒的锁键(升序) }`。
   * 「发布成功」= 回包项没有 `error`、状态不是 failed。
   * 每次等回包之后仍持有才继续;不再持有时提前返回,由调用方丢弃。
   */
  async function publishDerived(run, base, ctxLocks) {
    const derived = [];
    const seen = new Set();
    const published = new Map();   // id → TaskInput(最后一次发布成功的那一份)
    const relocked = new Set();
    const learned = new Map();   // 回包告诉我们的锁:lockKey → lockedBy,逐轮累加
    let gaveUp = [];
    let tasks = splitPlan(base);
    for (let round = 0; tasks.length > 0; round += 1) {
      const results = await publishAndWait(run, tasks);
      if (!holding(run)) break;
      const byId = new Map(tasks.map(t => [t.id, t]));
      /** 这一轮被拒的:lockKey → { lockedBy, info } */
      const rejected = new Map();
      /** 这一轮照别的指纹的锁发布成功、回包带着锁的描述的(M7-A10):lockKey → { lockedBy, info, ids } */
      const followed = new Map();
      for (const r of Array.isArray(results) ? results : []) {
        if (r?.id == null) continue;
        if (r.error == null) {
          if (!seen.has(r.id)) { seen.add(r.id); derived.push(r.id); }
          if (r.state !== 'failed' && byId.has(r.id)) published.set(r.id, byId.get(r.id));
          const task = byId.get(r.id);
          const fp = task?.requires?.envFingerprint;
          const lockKey = lockKeyOf(task);
          // 锁在别的环境上:照锁出键的(fp 不是自己的)、或已有的任务合并进来而回包带 lockedBy 的(没被拒,F.7)
          const lockedBy = typeof r.lockedBy === 'string' && r.lockedBy ? r.lockedBy : fp;
          if (r.lockIdleMs !== undefined && lockKey != null && typeof lockedBy === 'string' && lockedBy && lockedBy !== node?.envFingerprint) {
            const entry = followed.get(lockKey) ?? { lockedBy, info: lockInfoOf(r), ids: [] };
            entry.ids.push(r.id);
            followed.set(lockKey, entry);
          }
          continue;
        }
        // limit 等其它错误:没建成,不进 derived,也不做锁处理(F.7 第 4 条)
        if (r.error !== 'card-locked') continue;
        const lockKey = lockKeyOf(byId.get(r.id));
        if (lockKey == null || typeof r.lockedBy !== 'string' || r.lockedBy === '') continue;
        rejected.set(lockKey, { lockedBy: r.lockedBy, info: lockInfoOf(r) });
      }
      // M7-A10:照锁出键的卡(本机锁库说锁在别的环境上,发布不会被拒)同样按 D2 判接手:锁定方闲置超时、还没做完,
      // 就当这张卡被拒,下面按本节点指纹带 takeover 重发;照锁发出去的那几份随即被队列作废,不算发布成功
      for (const [lockKey, entry] of followed) {
        if (rejected.has(lockKey) || !takesOverLocked(lockKey, entry.lockedBy, entry.info)) continue;
        rejected.set(lockKey, { lockedBy: entry.lockedBy, info: entry.info });
        for (const id of entry.ids) {
          published.delete(id);
          const at = derived.indexOf(id);
          if (at >= 0) derived.splice(at, 1);
          seen.delete(id);
        }
      }
      if (rejected.size === 0) break;
      for (const lockKey of rejected.keys()) relocked.add(lockKey);
      if (round >= RELOCK_ROUNDS) {
        gaveUp = [...rejected.keys()].sort();
        break;
      }
      for (const [lockKey, { lockedBy }] of rejected) learned.set(lockKey, lockedBy);
      const cardLocks = mergedLocks(ctxLocks, learned);
      const takeover = lockKey => rejected.has(lockKey)
        && takesOverLocked(lockKey, rejected.get(lockKey).lockedBy, rejected.get(lockKey).info);
      // 只重发这一轮被拒的锁键;其余任务已经发布过,不重复发
      tasks = splitPlan({ ...base, cardLocks, takeover }).filter(t => rejected.has(lockKeyOf(t)));
    }
    return { derived, published: [...published.values()], relocked: [...relocked].sort(), gaveUp };
  }

  /** plan 任务:算计划 → 切分 → 发布(等回包)→ 交给执行器写层表 → complete。异常由 runner 收(fail) */
  async function executePlan(run, task, ctx = {}) {
    const { id } = run;
    const { signal } = run.controller;
    const discard = () => emit({ type: 'discarded', id });
    const plan = await untilAborted(() => executor.plan(task, { signal }), signal);
    if (!holding(run)) return discard();
    // plan 放在前面:切分节点自己的指纹、plan 与代码版本一定生效(设计 2.1);
    // plan 带的 cardLocks / takeover 随展开原样传给切分(契约 F.2)。
    // M7 D1:认领回包带的浏览器指纹(文档服务上本项目在线、同一用户的纯浏览器节点)交给切分
    const browserFingerprints = Array.isArray(ctx.browserFingerprints) ? ctx.browserFingerprints : [];
    // 块 N:本页(同一用户)能运行哪些用户卡、素材效果卡——页面自报在清单计划的 `input.browser`,文档服务给的 `browserCardEnvFingerprints`
    // 是「确实有这样一台在线节点」的凭据;两边对得上才给浏览器出用户卡、素材效果卡的那一份(`splitPlan` 的 `browserCards`)
    const browserCards = browserCardsOf(task?.input?.browser);
    const browserCardEnvFingerprints = Array.isArray(ctx.browserCardEnvFingerprints) ? ctx.browserCardEnvFingerprints : [];
    // 执行器按别的版本切的(项目往前走了,契约 J.15):细任务的 `source.projectRev` 写实际那一版;`derivedFrom` 仍是这个 plan
    const cutBy = Number.isSafeInteger(plan?.actualRev) && plan.actualRev !== task?.source?.projectRev
      ? { ...task, source: { ...task.source, projectRev: plan.actualRev } }
      : task;
    // 只切分、不认领细任务的节点(`planOnly`,仅供测试,filter.mjs 规则 8)不出自己的那一份流:它不会去做,出了只是多一个永远没人产的候选
    const listPlan = node?.planOnly === true && (plan?.ownListStreams === true || plan?.ownListSparseStreams === true)
      ? { ...plan, ownListStreams: false, ownListSparseStreams: false } : plan;
    const base = { ...plan, planTask: cutBy, envFingerprint: node?.envFingerprint, codeVersion, constants, browserFingerprints, browserCards, browserCardEnvFingerprints, sparseStreams,
      ...listPlanOverrides(task, listPlan) };
    const outcome = await publishDerived(run, base, plan?.cardLocks);
    if (!holding(run)) return discard();
    const { derived, published, relocked, gaveUp } = outcome;
    if (relocked.length > 0) emit({ type: 'plan-relocked', id, lockKeys: relocked, gaveUp });
    // M7 D12:切分完成后写一次层表(每层的候选按最终出键),交给执行器;不等它、失败只记事件
    if (typeof executor.afterSplit === 'function') {
      try {
        Promise.resolve(executor.afterSplit(task, { tasks: published, derived })).catch(error => {
          emit({ type: 'after-split-failed', id, error: String(error?.message ?? error) });
        });
      } catch (error) {
        emit({ type: 'after-split-failed', id, error: String(error?.message ?? error) });
      }
    }
    // 只为导出的计划:把每条导出位图的键与形状随完成一起回给页面(页面从 `task.done` 读,`export-plan.mjs` 的 `exportIndexOf`)
    const exportIndex = isExportOnlyPlan(task)
      ? exportIndexOf({ exportStreams: base.exportStreams, exportUnsupported: base.exportUnsupported, published, projectRev: cutBy?.source?.projectRev,
        segmentsPerTask: constants?.STREAM_SEGMENTS ?? QUEUE_DEFAULTS.STREAM_SEGMENTS })
      : null;
    session.complete(id, { ranges: null, derived, ...(exportIndex ? { exportIndex } : {}) });
    emit({ type: 'plan-split', id, derived });
  }

  function handle(message) {
    if (runner.stopped()) return;
    if (message?.type === 'node.welcome') sparseStreams = message.sparseStreams === true;
    session.receive(message);
    const waiter = message?.reqId != null ? publishes.get(message.reqId) : undefined;
    if (waiter && message.type === 'task.published') {
      waiter.resolve(message.results);
    } else if (waiter && message.type === 'error') {
      const error = new Error(`publish-${message.reason ?? 'error'}`);
      error.retryable = true;
      waiter.reject(error);
    }
    if (message?.type === 'task.published') emit({ type: 'publish-result', results: message.results });
  }

  function start(resume = []) {
    runner.resume();
    if (!attached) {
      endpoint.onMessage(handle);
      attached = true;
    }
    endpoint.send({ type: 'publisher.hello', publisherId });
    // 只接续本实例真在跑、令牌也对得上的认领:别的项没有执行去完成它,接续了只会一直续约、
    // 占住 maxConcurrent。新进程的实例在跑表是空的,等于不接续(契约 D.2〔裁〕)
    const resumable = (resume ?? []).filter(entry => entry && runner.tokenOf(entry.id) === entry.token);
    session.start(resumable);
    // 接续下来的 plan 若还在等发布回包:旧连接上的回包不会再来,按原 reqId 重发一次。
    // 发布是幂等的(已有的任务只合并订阅者),而且此刻 plan 仍由本节点认领,继承条件照样成立
    for (const waiter of [...publishes.values()]) {
      if (holding(waiter.run)) endpoint.send(waiter.message);
    }
  }

  function tick() {
    if (runner.stopped()) return;
    session.tick();
  }

  function yieldAll(reason = 'busy') {
    runner.abortAll(reason);
    return session.yieldAll(reason);
  }

  function stop() {
    runner.stop('stopped');
  }

  return {
    start,
    tick,
    yieldAll,
    stop,
    running: runner.running,
    occupying: runner.occupying,
    settled: runner.settled,
    get session() { return session; },
  };
}
