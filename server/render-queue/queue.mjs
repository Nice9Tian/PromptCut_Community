/**
 * 渲染任务队列本体：文档服务托管的拉取式任务队列的纯内存状态机（设计第 3、4、5 节）。
 *
 * 输入只有两种：「某条连接发来一条消息」（handle）和「时钟走到某一刻」（tick）；输出只有一种：
 * 「给某条连接发一条消息」（send）。传输、鉴权、产物存储都在接口外面，所以这里不开计时器、不读环境变量、
 * 不做 I/O，时钟由调用方注入。
 *
 * handle / tick 都是同步的一步，执行中不让出事件循环，也不回调调用方（send 除外）：认领的「比对再加锁」
 * 靠的就是这一点（设计 4.2）。每一步先把状态改完，再往外发消息，发消息出错也不会留下改了一半的状态。
 *
 * 契约：`docs/plan/render-queue-contract.md` A 节；卡片级指纹锁（锁表、card.lock、认领第 3a 步、接手）见 F.1；
 * 按节点指纹前置过滤、锁变更的定向增量、拒绝限流见 I 节（开关 PREFILTER）。
 *
 * M6c（`docs/plan/m6c-contract.md`）：
 * - X2 本地档能力闸：`requires.localMedia = <nodeId>` 的任务只给那个节点——前置过滤里别的节点看不见（PREFILTER），
 *   认领时别的节点回 `local-media`（不看开关，和 card-locked 一样是正确性闸）。
 * - X3 `watch: 'all'` 收紧：`browser` 回 `error { reason: 'forbidden' }`；`host` 只收项目摘要 `queue.summary`
 *   （形状同契约 H.3），不收单任务增量；`pc` 照旧。见 onWatch。
 * - X4 plan 就近认领：带 `requires.preferNode` 的 plan 在发布后 `PLAN_PREFER_MS` 之内只给那个节点认领，
 *   别的回 `preferred`（带 `retryInMs`）；窗口过后任何指纹符合的 pc 能认领。`browser` 认领 plan 一律回
 *   `plan-profile`；`host` 认领不带片段清单的 plan 回 `plan-profile`（C10 契约第 18 节第 9 条：带清单的 plan host 能认领）。
 *   preferNode 断开，窗口立即结束、重连不恢复（集成裁定，见 detachNode）。
 *
 * M7（`docs/plan/m7-contract.md` 第 13 节裁定）：
 * - D1 plan 的 `task.claimed` 带 `browserFingerprints`：本项目在线、与 plan 同一用户、watch 着这个项目的纯浏览器节点的指纹
 *   （见 browserFingerprintsFor），切分方据此给浏览器可做的卡另出一份；认领建锁（以及 card.lock 建锁、同指纹认领）时，
 *   同锁键、异指纹、`input.dual` 为真的未完成任务作废（superseded，见 supersedeDual）。作废的任务记录不挡重新发布（当作不存在）。
 * - D2 锁闲置接手：card-locked 的发布回包与认领回包带 `lockIdleMs`（此刻减锁定方最后一次产出）、`lockedByProfile`，
 *   发布回包另带 `lockUndone`（锁定方这张卡还没做完的任务数）；指纹不同的节点照锁发布（合并或新建都不被拒）时，
 *   回包同样带这三项（不带 lockedBy），切分方才判得了要不要接手（M7-A10）；续约也刷新锁。「产出」只算认领、续约、完成、card.lock，
 *   不算发布（`producedAt`；`touchedAt` 照 F.1 仍管回收）。
 * - D9 nodeId 绑到 userId：节点记录在时，别的 userId 拿同一个 nodeId 报到回 forbidden。
 * - D10 `node.welcome` 回这个节点的 `envFingerprint`（浏览器的指纹由文档服务模块按页面报的原始值算好再交进来）。
 *
 * 在线执行用户卡与素材效果卡（块 N，`docs/plan/online-card-exec-contract.md` 第 7 节）：
 * - 纯浏览器节点另有 `cardEnvFingerprint`（环境三项再加在线卡片运行时版本，同样由文档服务算好交进来），`node.welcome` 带回；
 *   别的 profile、没报运行时版本的浏览器没有这一项。
 * - 浏览器节点对 `requires.userCards` / `requires.graphCards` 为真的任务，前置过滤、认领的指纹检查、锁的闲置判断都按
 *   `cardEnvFingerprint` 比；没有这一项的浏览器对这类任务一律对不上（看不见、认领被挡）。内置卡的任务、别的 profile 一个字不变。
 * - plan 的认领回包另带 `browserCardEnvFingerprints`（本项目在线、同一用户、watch 着的浏览器节点的 `cardEnvFingerprint`），
 *   切分方据此确认页面自报的「本页能运行的卡」确有这样一台节点。
 *
 * M7 D2 补充〔裁〕（`claude/queue-maint`，`REPORT-M7.md` 第 11 节第 1 行「页面只是忙也会被 D2 接手」）：
 * - `node.welcome` 带 `activeIntervalMs`（`NODE_ACTIVE_INTERVAL_MS`）：告诉节点这个队列认 `node.active`；
 * - `node.active { busy? }`：节点还在、在忙（页面在生成别的卡的快照、后台舞台在测量或补跑），不回包，只记 `activeAt`；
 * - 锁记下最后一次为它产出（认领、续约、完成）的节点 `nodeId`。回包里的 `lockIdleMs` 改为「此刻减锁定方最后一次产出或
 *   报忙」：那个节点**此刻连着**、指纹没变、报过 `node.active` 时，它的 `activeAt` 与 `producedAt` 取晚的；断开（含宽限期内）、
 *   从没报过（旧页面）、或报忙停了，就只剩 `producedAt`，与改动之前相同。切分方的判定（`idleLockTakeover`）不用改。
 */
import { randomUUID } from 'node:crypto';
import { QUEUE_DEFAULTS, NODE_ACTIVE_INTERVAL_MS } from './constants.mjs';
import { makeMessage, parseInbound, lockKeyOf, priorityBand, prioritySummaryValue, isListPlan, NODE_TYPES, PUBLISHER_TYPES } from './messages.mjs';

function resolveConstants(overrides) {
  const out = { ...QUEUE_DEFAULTS };
  if (overrides === undefined || overrides === null) return Object.freeze(out);
  if (typeof overrides !== 'object') throw new TypeError('createRenderQueue: constants 必须是对象');
  for (const key of Object.keys(QUEUE_DEFAULTS)) {
    const v = overrides[key];
    if (v === undefined) continue;
    if (typeof QUEUE_DEFAULTS[key] === 'boolean') {
      // 开关（PREFILTER，契约 I.1）只收布尔
      if (typeof v !== 'boolean') throw new TypeError(`createRenderQueue: constants.${key} 必须是布尔值`);
    } else if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`createRenderQueue: constants.${key} 必须是有限的数`);
    out[key] = v;
  }
  return Object.freeze(out);
}

export function createRenderQueue(options = {}) {
  const { now, send } = options;
  if (typeof now !== 'function') throw new TypeError('createRenderQueue: now 必须是函数');
  if (typeof send !== 'function') throw new TypeError('createRenderQueue: send 必须是函数');
  if (options.epoch !== undefined && typeof options.epoch !== 'string') throw new TypeError('createRenderQueue: epoch 必须是字符串');
  const C = resolveConstants(options.constants);
  // 新实例 = 新 epoch：文档服务重启后，各方靠它认出旧认领已作废（设计第 5 节）
  const epoch = options.epoch ?? randomUUID();

  /**
   * 连接：connId → { connId, principal, nodeId, publisherId, watch, cardLockedRejects }。
   * 用对象本身而不是 connId 认「同一条连接」：connId 可能被新连接复用，认领记的是当时那条连接。
   */
  const conns = new Map();
  /**
   * 节点身份（跨连接）：nodeId → { nodeId, userId, profile, envFingerprint, capabilities, codeVersions, maxConcurrent, conn, disconnectedAt,
   * activeAt, activeBusy }（userId：M7 D9；activeAt / activeBusy：M7 D2 补充，最后一次 `node.active` 的时刻与忙什么，没报过为 null）
   */
  const nodes = new Map();
  /** 发布方身份（跨连接）：publisherId → { publisherId, conn, disconnectedAt } */
  const publishers = new Map();
  /** 任务表：id → task（字段见 describe 与 viewOf） */
  const tasks = new Map();
  /** 每项目 open + claimed 的任务数，给 MAX_TASKS_PER_PROJECT 用；done / failed 不计（P10） */
  const activeByProject = new Map();
  /**
   * 卡片级指纹锁（F.1）：lockKey → { envFingerprint, source: 'claim' | 'lock' | 'takeover', since, touchedAt, producedAt, profile, nodeId }。
   * `producedAt` 与 `profile`（M7 D2）：锁定方最后一次产出（认领、续约、完成、card.lock）的时刻与它的 profile，回包的
   * `lockIdleMs` / `lockedByProfile` 由它们算；`nodeId`（M7 D2 补充）：最后一次经认领、续约、完成为它产出的节点，
   * 它此刻连着又在报忙（`node.active`）时锁不算闲置（见 lockLastActive）。三项都不进 describe()。
   * 同一把锁下只让一种环境的结果被产出、投递，页面贴的连续帧才不会混环境（设计 2.1「谁定指纹」）。
   * 只在内存里，和任务表一样随 epoch 作废：新实例的锁从空开始。
   */
  const locks = new Map();

  /** 这一步的时刻：每个入口读一次时钟，同一步里的所有时间戳一致 */
  let at = 0;

  // ---------- 发消息 ----------

  function emit(conn, type, fields, reqId) {
    const msg = makeMessage(epoch, type, fields, reqId);
    // 一条连接的传输出错不该拖垮队列：状态已经改完，这里只丢这一条消息
    try { send(conn.connId, msg); } catch { /* 交给传输层自己处理 */ }
  }

  const isLive = (conn) => conn !== null && conns.get(conn.connId) === conn;

  /** 这条连接此刻代表哪个节点（被同一 nodeId 的新连接取代后就不再代表） */
  function nodeOf(conn) {
    if (conn.nodeId === null) return null;
    const node = nodes.get(conn.nodeId);
    return node && node.conn === conn ? node : null;
  }
  function publisherOf(conn) {
    if (conn.publisherId === null) return null;
    const pub = publishers.get(conn.publisherId);
    return pub && pub.conn === conn ? pub : null;
  }

  /**
   * 可见性（A.9）：只发给 watch 了该项目的节点连接；纯浏览器只见本人任务（Q2），
   * 这条边界由这里守，不靠节点自己过滤。
   * PREFILTER 开着时再加指纹前置过滤（I.2，见 envAllows）。
   */
  function canSee(conn, task) {
    if (conn.watch === null) return false;
    const node = nodeOf(conn);
    if (!node) return false;
    if (conn.watch !== 'all' && !conn.watch.has(task.source.projectId)) return false;
    if (node.profile === 'browser' && task.source.userId !== conn.principal.userId) return false;
    if (C.PREFILTER && (!envAllows(node, task) || !localMediaAllows(node, task))) return false;
    return true;
  }

  /** 非空字符串才算带了指纹；空串、null、缺省都当没带 */
  const fingerprintOf = (v) => (typeof v === 'string' && v !== '' ? v : null);

  /** 任务要不要在节点里执行用户卡、素材效果卡的代码(`requires.userCards` / `requires.graphCards`) */
  const runsCardCode = (task) => !!task?.requires && typeof task.requires === 'object' && (task.requires.userCards === true || task.requires.graphCards === true);
  /**
   * 这个节点认领这个任务时用的环境指纹(块 N,`docs/plan/online-card-exec-contract.md` 第 7 节第 4 条)。
   * 纯浏览器节点执行用户卡、素材效果卡的任务用 `cardEnvFingerprint`(三项环境值再加在线卡片运行时版本);其余一律是 `envFingerprint`,
   * 内置卡的任务与别的 profile 一个字不变。浏览器节点没有 `cardEnvFingerprint`(没报运行时版本、旧页面)时,
   * 用户卡、素材效果卡的任务对它一律对不上(`NO_CARD_RUNTIME` 不等于任何指纹):看不见、认领被指纹挡下——没声明能执行这些卡的页面
   * 不会拿到它们的任务(同一台机器上它的 `envFingerprint` 与桌面那份相同,不挡的话它会看见桌面那份)。
   */
  const NO_CARD_RUNTIME = '<no-card-runtime>';
  function nodeFpFor(node, task) {
    if (node?.profile === 'browser' && runsCardCode(task)) return fingerprintOf(node.cardEnvFingerprint) ?? NO_CARD_RUNTIME;
    return fingerprintOf(node?.envFingerprint);
  }
  /** 非空字符串才算给了；requires 里的 localMedia（X2）、preferNode（X4）都这么读 */
  const requiredOf = (task, name) => {
    const v = task.requires ? task.requires[name] : undefined;
    return typeof v === 'string' && v !== '' ? v : null;
  };

  /**
   * 本地档能力闸（M6c X2）：任务的输入里有没有内容哈希的素材时，切分方写了 `requires.localMedia = <发布方 nodeId>`，
   * 那些素材只在发布方本机，别的节点拿不到。只有这个节点能看见、能认领。没写这一项的任务不受影响。
   */
  function localMediaAllows(node, task) {
    const owner = requiredOf(task, 'localMedia');
    return owner === null || owner === node.nodeId;
  }

  /**
   * plan 要不要查指纹（M6c X4）：带 `requires.preferNode` 的 plan（M6c 起发布方就这么发）窗口过后给「任何指纹符合的 pc」，
   * 所以查；没带的旧形状照 I.10 第 7 条不查（谁认领谁的指纹就是这一版的指纹）。细任务一律查。
   */
  const checksFingerprint = (task) => task.kind !== 'plan' || requiredOf(task, 'preferNode') !== null;

  /**
   * 指纹前置过滤（I.2，语义 mechanism/document-service.md「指纹前置过滤（特例）」）：环境不符、或这张卡已被别的环境锁定的任务，
   * 不发给这个节点。不然锁一变，指纹不符的节点会一拥而上认领、全部被 card-locked 拒掉（锁风暴）。
   * 节点没带指纹时两条都不生效，与加过滤之前一样；能力过滤仍由节点自己做。
   */
  function envAllows(node, task) {
    const nodeFp = nodeFpFor(node, task);
    if (nodeFp === null) return true;
    // 1. 指纹相符：任务没带指纹时不生效。没带 preferNode 的 plan 不看，和节点侧 filter.mjs 规则 1 一致：
    //    plan 不产结果，谁认领谁的指纹就是这一版的指纹；带 preferNode 的 plan 要指纹符合（X4）
    if (checksFingerprint(task)) {
      const taskFp = fingerprintOf(task.requires ? task.requires.envFingerprint : undefined);
      if (taskFp !== null && taskFp !== nodeFp) return false;
    }
    // 2. 没被别的环境锁住：只看参与锁的任务（有锁键也有锁指纹，F.1），和认领第 3a 步的判定对得上
    const id = lockIdOf(task);
    const lock = id ? locks.get(id.key) : undefined;
    return !lock || lock.envFingerprint === nodeFp;
  }

  /**
   * 本次 task.publish 新建的任务（I.3）：它们的 task.opened 在这一步末尾按最终的可见性发，
   * 锁变更的定向增量不再管它们，免得同一个节点收到两条 task.opened。只在 onPublish 执行期间不为 null。
   */
  let freshTasks = null;

  /**
   * 锁变更的定向增量（I.3）：mutate 改锁表里 key 这把锁的指纹（新建、接手转移）。对这个锁键下每个 open 的任务，
   * 比较改前改后每条连接看不看得见：看得见 → 看不见的发 task.closed { state: 'hidden', reason: 'card-locked' }，
   * 看不见 → 看得见的发 task.opened；前后不变的什么都不发。
   * 状态在这里就改完；返回的函数再往外发（没有要发的返回 null），调用方好把自己的回包排在前面。
   * PREFILTER 关着时可见性与锁无关，只做 mutate。
   */
  function changeLock(key, mutate, except = null) {
    if (!C.PREFILTER) { mutate(); return null; }
    const affected = [];
    for (const task of tasks.values()) {
      if (task.state !== 'open' || task === except || (freshTasks && freshTasks.has(task))) continue;
      const id = lockIdOf(task);
      if (id && id.key === key) affected.push(task);
    }
    if (affected.length === 0) { mutate(); return null; }
    const watchers = [...conns.values()].filter((conn) => conn.watch !== null && nodeOf(conn));
    const before = affected.map((task) => new Set(watchers.filter((conn) => canSee(conn, task))));
    mutate();
    const out = [];
    affected.forEach((task, i) => {
      let view = null;
      for (const conn of watchers) {
        const was = before[i].has(conn);
        const will = canSee(conn, task);
        if (was && !will) out.push([conn, 'task.closed', { id: task.id, state: 'hidden', reason: 'card-locked' }]);
        else if (!was && will) out.push([conn, 'task.opened', { task: view ??= viewOf(task) }]);
      }
    });
    return out.length === 0 ? null : () => { for (const [conn, type, fields] of out) emit(conn, type, fields); };
  }

  function broadcast(task, type, fields, exceptConn = null) {
    for (const conn of conns.values()) {
      if (conn !== exceptConn && canSee(conn, task)) emit(conn, type, fields);
    }
  }

  // ---------- 任务表 ----------

  const isActive = (state) => state === 'open' || state === 'claimed';

  function countActive(projectId, delta) {
    const n = (activeByProject.get(projectId) ?? 0) + delta;
    if (n > 0) activeByProject.set(projectId, n);
    else activeByProject.delete(projectId);
  }

  /** 唯一的状态转移入口：每次转移 version 恰好加一（A.7），顺带维护每项目的未完成计数 */
  function transition(task, state) {
    const was = isActive(task.state);
    const will = isActive(state);
    if (was !== will) countActive(task.source.projectId, will ? 1 : -1);
    task.state = state;
    task.version += 1;
  }

  function removeTask(task) {
    if (isActive(task.state)) countActive(task.source.projectId, -1);
    tasks.delete(task.id);
  }

  /**
   * 出站消息里的任务（A.4 TaskView）：不含 claim、subscribers；深拷贝由 makeMessage 做。
   * 上一次放弃的原因 `lastError` 只在有时才带（契约 A.12〔裁〕：回收、失败后放回 open 的广播里看得出为什么；旧节点不认这一项，照常工作）
   */
  function viewOf(task) {
    const v = { id: task.id, kind: task.kind };
    if (task.kind === 'snapshot') v.tier = task.tier;
    Object.assign(v, {
      resultKey: task.resultKey, range: task.range, source: task.source,
      input: task.input, weight: task.weight, requires: task.requires, priority: task.priority,
      state: task.state, version: task.version, attempts: task.attempts,
    });
    if (typeof task.lastError === 'string' && task.lastError) v.lastError = task.lastError;
    return v;
  }

  /**
   * 项目摘要（M6c X3；形状照契约 H.3 的 `queue.summary`）：每个有 open 或 claimed 任务的项目一项，按 projectId 升序。
   * `topPriority` 是 open 任务的最高 priority，没有 open 就是 null；`openByFingerprint` 按 `requires.envFingerprint`
   * 分组数 open 任务，没带指纹的记在 `''` 下，键升序。
   */
  function summaryOf() {
    const byProject = new Map();
    for (const t of tasks.values()) {
      if (!isActive(t.state)) continue;
      const projectId = t.source.projectId;
      let p = byProject.get(projectId);
      if (!p) {
        p = { projectId, open: 0, claimed: 0, topPriority: null, fps: new Map() };
        byProject.set(projectId, p);
      }
      if (t.state === 'claimed') { p.claimed += 1; continue; }
      p.open += 1;
      // c10a 契约第 17 节:`priority` 可以是 'normal' / 'backfill',摘要只比数(预渲染重试档算 -1)
      const value = prioritySummaryValue(t.priority);
      if (p.topPriority === null || value > p.topPriority) p.topPriority = value;
      const fp = t.requires && typeof t.requires.envFingerprint === 'string' ? t.requires.envFingerprint : '';
      p.fps.set(fp, (p.fps.get(fp) ?? 0) + 1);
    }
    const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return [...byProject.values()]
      .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0))
      .map((p) => ({
        projectId: p.projectId, open: p.open, claimed: p.claimed, topPriority: p.topPriority,
        openByFingerprint: Object.fromEntries([...p.fps.entries()].sort(byKey)),
      }));
  }

  function doneFields(task) {
    return {
      id: task.id, resultKey: task.resultKey,
      projectId: task.source.projectId, projectRev: task.source.projectRev, result: task.result,
    };
  }

  /** 给任务当前的每个订阅者发一条消息；订阅者断开了就跳过（A.7.4） */
  function notifySubscribers(task, type, fields) {
    for (const publisherId of task.subscribers) {
      const pub = publishers.get(publisherId);
      if (pub && pub.conn) emit(pub.conn, type, fields);
    }
  }

  /**
   * 「放弃」（A.7.6）：task.fail 与 tick 的各种回收共用。先改完状态，返回的 notify 再往外发，
   * 调用方好把自己的回包排在前面。返回处理后的状态：open / failed / removed。
   */
  function abandon(task, { lastError, retryable = true }) {
    const failedNodeId = task.claim?.nodeId ?? null;
    task.attempts += 1;
    task.claim = null;
    task.lastError = lastError;
    if (!retryable || task.attempts >= C.MAX_ATTEMPTS) {
      transition(task, 'failed');
      task.finishedAt = at;
      return {
        state: 'failed',
        notify() {
          notifySubscribers(task, 'task.failed', { id: task.id, error: task.lastError });
          broadcast(task, 'task.closed', { id: task.id, state: 'failed' });
        },
      };
    }
    transition(task, 'open');
    // Give another eligible node the first chance after a retryable failure.
    // The former owner can try again after one sweep if no peer takes it.
    task.retryNodeId = lastError === 'sink-incomplete' ? failedNodeId : null;
    task.retryAfter = task.retryNodeId ? at + C.SWEEP_INTERVAL_MS : null;
    if (task.subscribers.size === 0) {
      // 没人要的任务回到 open 就直接删掉：留着只会被白做一遍
      removeTask(task);
      return { state: 'removed', notify: () => broadcast(task, 'task.closed', { id: task.id, state: 'removed' }) };
    }
    const view = viewOf(task);
    return { state: 'open', notify: () => broadcast(task, 'task.opened', { task: view }) };
  }

  /**
   * tick 里的回收：放弃，并告诉原认领者（它的那条连接还在的话）。
   * `lease-lost` 的 reason 就是回收的原因（`lease-expired` / `stalled` / `disconnected`，契约 A.12〔裁〕；原来一律 `expired`）
   */
  function reclaim(task, lastError) {
    const { conn, token } = task.claim;
    const out = abandon(task, { lastError });
    if (isLive(conn)) emit(conn, 'task.lease-lost', { id: task.id, token, reason: lastError });
    out.notify();
  }

  // ---------- 卡片级指纹锁（F.1） ----------

  /** 任务的锁身份：锁键 + 锁指纹（`requires.envFingerprint`）。缺一样就不参与锁，也不受锁影响 */
  function lockIdOf(task) {
    const key = lockKeyOf(task);
    const fp = task.requires ? task.requires.envFingerprint : undefined;
    return key !== null && typeof fp === 'string' && fp !== '' ? { key, fp } : null;
  }

  function setLock(key, envFingerprint, source, profile = null, nodeId = null) {
    locks.set(key, { envFingerprint, source, since: at, touchedAt: at, producedAt: at, profile, nodeId });
  }

  /**
   * 锁定方又产出了（M7 D2）：认领、续约、完成、card.lock 都算；发布不算，只刷新 touchedAt（F.1）。
   * 经节点产出的（认领、续约、完成）另记下那个节点（M7 D2 补充）；card.lock 不经节点，原来记的节点不动
   */
  function produced(lock, profile = null, nodeId = null) {
    lock.touchedAt = at;
    lock.producedAt = at;
    if (profile !== null) lock.profile = profile;
    if (nodeId !== null) lock.nodeId = nodeId;
  }

  /**
   * 锁定方最后一次「在」的时刻（M7 D2 补充〔裁〕）：最后一次产出，与最后为它产出的那个节点最后一次报忙（`node.active`）取晚的。
   * 报忙只在那个节点此刻连着（`conn` 在，断开后的宽限期里不算）、指纹仍是锁上的指纹时才算：页面走了（断开、超时被收回）
   * 与从没报过忙的旧页面都只看产出，同改动之前。
   */
  function lockLastActive(lock) {
    let last = lock.producedAt;
    const owner = lock.nodeId != null ? nodes.get(lock.nodeId) : undefined;
    if (owner && owner.conn !== null && isLive(owner.conn) && (owner.envFingerprint === lock.envFingerprint || owner.cardEnvFingerprint === lock.envFingerprint)
      && typeof owner.activeAt === 'number' && owner.activeAt > last) last = owner.activeAt;
    return last;
  }

  /**
   * 回包里描述一把锁（M7 D2）：`lockedBy`、`lockIdleMs`（此刻减最后一次产出）、`lockedByProfile`，发布回包另带 `lockUndone`：
   * 锁定方这张卡还没做完的任务数（同锁键、锁指纹、不是 done、不是被作废的）。切分方据此判断要不要接手：
   * 闲置超过 30 s、又还有没做完的才接手（语义「还缺帧、而锁定方已经有一段时间没有再产出」）。
   */
  function lockInfo(key, lock, { undone = false } = {}) {
    const out = { lockedBy: lock.envFingerprint, lockIdleMs: Math.max(0, at - lockLastActive(lock)), lockedByProfile: lock.profile ?? null };
    if (undone) {
      let n = 0;
      for (const t of tasks.values()) {
        if (t.state === 'done' || t.lastError === 'superseded') continue;
        const id = lockIdOf(t);
        if (id && id.key === key && id.fp === lock.envFingerprint) n += 1;
      }
      out.lockUndone = n;
    }
    return out;
  }

  /**
   * 建锁、同指纹认领、card.lock 之后（M7 D1）：同锁键、异指纹、`input.dual` 为真、还没做完（open / claimed）的任务是切分方为
   * 「先认领者得卡」多出的那一份，这张卡已经归了 fp，它们谁也认领不到了，一律作废（superseded），照 takeoverLock 的收尾：
   * 不加 attempts，认领者收 lease-lost，订阅者收 task.failed，看得见的节点收 task.closed。不带 dual 的任务不动。
   * 先改完状态，返回的函数再往外发（没有要发的返回 null）。
   */
  function supersedeDual(key, fp) {
    const superseded = [];
    for (const task of tasks.values()) {
      if (!isActive(task.state) || task.input?.dual !== true) continue;
      const id = lockIdOf(task);
      if (!id || id.key !== key || id.fp === fp) continue;
      const claim = task.claim;
      transition(task, 'failed');
      task.finishedAt = at;
      task.lastError = 'superseded';
      task.claim = null;
      superseded.push({ task, claim });
    }
    if (superseded.length === 0) return null;
    return () => {
      for (const { task, claim } of superseded) {
        if (claim && isLive(claim.conn)) emit(claim.conn, 'task.lease-lost', { id: task.id, token: claim.token, reason: 'superseded' });
        notifySubscribers(task, 'task.failed', { id: task.id, error: 'superseded' });
        broadcast(task, 'task.closed', { id: task.id, state: 'failed' });
      }
    };
  }

  /** 被作废（superseded）的任务：这种环境的结果当时不要了；锁回到它的指纹上（或带 takeover）时应能重新发布，所以发布时当它不存在 */
  const isSuperseded = (task) => task.state === 'failed' && task.lastError === 'superseded';

  /** 纯浏览器节点报上来的指纹里，一个 plan 最多带几个（M7 D1） */
  const MAX_BROWSER_FINGERPRINTS = 4;

  /**
   * M7 D1：认领这个 plan 的切分方该给哪些浏览器指纹另出一份。规则：文档服务上此刻在线（有连接）、profile 为 browser、
   * 带着指纹、连接的 userId 等于 plan 的 `source.userId`（纯浏览器只能认领本人的任务，细任务继承 plan 的 userId）、
   * 并且 watch 着这个项目的节点；指纹去重、升序，最多 MAX_BROWSER_FINGERPRINTS 个。没有这样的节点回空数组，
   * 切分方就只出自己那一份。
   */
  function browserFingerprintsFor(task, field = 'envFingerprint') {
    const out = new Set();
    for (const node of nodes.values()) {
      const conn = node.conn;
      if (node.profile !== 'browser' || !conn || !isLive(conn)) continue;
      const fp = fingerprintOf(node[field]);
      if (fp === null || conn.principal.userId !== task.source.userId) continue;
      if (!(conn.watch instanceof Set) || !conn.watch.has(task.source.projectId)) continue;
      out.add(fp);
    }
    return [...out].sort().slice(0, MAX_BROWSER_FINGERPRINTS);
  }

  /**
   * 接手：锁转给 fp，原指纹还没做完（open / claimed）的任务一律作废，直接进 failed（lastError 'superseded'）。
   * attempts 不加、不走重试：不是做不了，是这种环境的结果不再要了，重试只会再被锁挡回来。
   * done 的不动：已经产出的结果按内容寻址，去留由 TTL 管。
   * 先改完状态，返回的函数再往外发，调用方好把自己的回包排在前面。
   */
  function takeoverLock(key, fp, profile = null) {
    // 先按锁转移发定向增量（I.3）：这时原指纹的 open 任务还在，看得见它们的节点收 hidden；随后它们作废，
    // task.closed { state: 'failed' } 按改后的可见性发，这些节点就不会再收第二条
    const lockNotify = changeLock(key, () => setLock(key, fp, 'takeover', profile));
    const superseded = [];
    for (const task of tasks.values()) {
      if (!isActive(task.state)) continue;
      const id = lockIdOf(task);
      if (!id || id.key !== key || id.fp === fp) continue;
      const claim = task.claim;
      transition(task, 'failed');
      task.finishedAt = at;
      task.lastError = 'superseded';
      task.claim = null;
      superseded.push({ task, claim });
    }
    return () => {
      if (lockNotify) lockNotify();
      for (const { task, claim } of superseded) {
        // 先告诉原认领者它的令牌作废了，再通知订阅者和 watch 者
        if (claim && isLive(claim.conn)) emit(claim.conn, 'task.lease-lost', { id: task.id, token: claim.token, reason: 'superseded' });
        notifySubscribers(task, 'task.failed', { id: task.id, error: 'superseded' });
        broadcast(task, 'task.closed', { id: task.id, state: 'failed' });
      }
    };
  }

  /**
   * 发布时，这个任务若是新建的，会不会被锁拒建（F.7 第 1 条）：有锁键和锁指纹、锁在别的指纹上、又没带
   * takeover，返回锁上的指纹，否则 null。建出来也谁都认领不了，只会一直 open，页面永远等不到 task.done；
   * 拒掉并回 lockedBy，切分方才知道要照锁定方的指纹重发或者明确接手。
   */
  function lockRefusal(input) {
    if (input.takeover) return null;
    const id = lockIdOf(input);
    const lock = id ? locks.get(id.key) : undefined;
    return lock && lock.envFingerprint !== id.fp ? { key: id.key, lock } : null;
  }

  /**
   * 发布时看锁（F.1「发布」表，F.7 第 2 条）。返回锁在别的指纹上、又没接手时的那个指纹（回包的 lockedBy），否则 null；
   * 这种情况只剩已有同 id 任务的合并，新建的在 lockRefusal 那一步就拒了。
   * 没锁又不接手时不建锁：谁先真正产出由第一次认领决定，只是发布了还不算。
   */
  function lockOnPublish(task, takeover, after, node) {
    const profile = node?.profile ?? null;
    const id = lockIdOf(task);
    if (!id) return null;
    const lock = locks.get(id.key);
    if (!lock) {
      // 没锁时接手也照样作废异指纹的未完成任务（F.7 第 2 条）：两个节点几乎同时切分时，
      // 先发布、还没人认领的那一方的任务不会被留成谁都认领不了的死任务
      if (takeover) after.push(takeoverLock(id.key, id.fp, profile));
      return null;
    }
    if (lock.envFingerprint === id.fp) {
      // 发布只刷新 touchedAt（F.1），不算产出（M7 D2 的 lockIdleMs 不因此归零）
      lock.touchedAt = at;
      // M7-A10（验收探针查出）：切分节点照别的环境的锁出键（它从本机锁库已知这张卡锁在别处）时，发布不会被拒，
      // 它也就收不到锁的闲置情况、永远不接手。所以发布方是指纹不同的节点时，回包同样带锁的描述（不带 lockedBy：
      // 锁就在这份的指纹上），切分方照 D2 判要不要接手
      const nodeFp = fingerprintOf(node?.envFingerprint);
      if (nodeFp !== null && nodeFp !== lock.envFingerprint) {
        const { lockIdleMs, lockedByProfile, lockUndone } = lockInfo(id.key, lock, { undone: true });
        return { lockIdleMs, lockedByProfile, lockUndone };
      }
      return null;
    }
    if (takeover) {
      after.push(takeoverLock(id.key, id.fp, profile));
      return null;
    }
    // 已有的任务照常合并，只是锁变之前认领会被拒（card-locked）；回包带锁的描述（M7 D2）
    return lockInfo(id.key, lock, { undone: true });
  }

  // ---------- 身份 ----------

  /** 这条连接不再代表它原来的节点：那个节点从此算断开，等宽限期 */
  function detachNode(conn) {
    const node = nodeOf(conn);
    if (node) {
      node.conn = null; node.disconnectedAt = at;
      // M6c X4(集成裁定):preferNode 断开,它的独占窗口立即结束,重连也不恢复 —— 别的 pc 马上能认领这个 plan
      for (const task of tasks.values()) {
        if (task.kind === 'plan' && task.state === 'open' && requiredOf(task, 'preferNode') === node.nodeId) task.preferEnded = true;
      }
    }
    conn.nodeId = null;
    unwatch(conn);
  }
  /** 这条连接不再 watch 任何东西：单任务增量与摘要（X3）一并停 */
  function unwatch(conn) {
    conn.watch = null;
    conn.summary = false;
    conn.lastSummary = null;
  }
  function detachPublisher(conn) {
    const pub = publisherOf(conn);
    if (pub) { pub.conn = null; pub.disconnectedAt = at; }
    conn.publisherId = null;
  }

  // ---------- 入站消息 ----------

  function onNodeHello(conn, body, reqId) {
    const { nodeId } = body;
    // M7 D9：nodeId 绑到第一次报到它的 userId（节点记录在期间）。别的用户拿同一个 nodeId 报到会顶掉那个节点的连接、
    // 接续它的认领，一律拒；这条连接原来的身份不动
    const bound = nodes.get(nodeId);
    if (bound && bound.userId !== conn.principal.userId) {
      emit(conn, 'error', { reason: 'forbidden', detail: '这个 nodeId 属于别的用户' }, reqId);
      return;
    }
    if (conn.nodeId !== null && conn.nodeId !== nodeId) detachNode(conn);
    let node = nodes.get(nodeId);
    if (node) {
      // 同一身份的新连接取代旧连接：旧连接此后不再代表这个节点，也不再收广播
      if (node.conn && node.conn !== conn) { node.conn.nodeId = null; unwatch(node.conn); }
    } else {
      node = { nodeId, userId: conn.principal.userId, activeAt: null, activeBusy: null };
      nodes.set(nodeId, node);
    }
    Object.assign(node, {
      profile: body.profile, envFingerprint: body.envFingerprint, capabilities: body.capabilities,
      // 块 N:纯浏览器节点执行用户卡、素材效果卡用的指纹(文档服务按页面报的运行时版本算好交进来);别的 profile 一律没有
      cardEnvFingerprint: body.profile === 'browser' ? (body.cardEnvFingerprint ?? null) : null,
      codeVersions: body.codeVersions, maxConcurrent: body.maxConcurrent,
      conn, disconnectedAt: null,
    });
    conn.nodeId = nodeId;
    // X3：同一条连接换了 profile 再报到，原来的全量 watch 只有 pc 还能留着；摘要只有 host 能留着
    if (conn.watch === 'all' && body.profile !== 'pc') conn.watch = null;
    if (conn.summary && body.profile !== 'host') { conn.summary = false; conn.lastSummary = null; }

    // resume：不论这个 nodeId 有没有记录都一样处理（A.9）
    const resumed = [];
    const lost = [];
    const seen = new Set();
    for (const { id, token } of body.resume) {
      if (seen.has(id)) continue;
      seen.add(id);
      const task = tasks.get(id);
      if (task && task.state === 'claimed' && task.claim.nodeId === nodeId && task.claim.token === token) {
        task.claim.conn = conn;   // 接续：leaseUntil、token 都不变
        resumed.push(id);
        continue;
      }
      let reason = 'token';
      if (!task) reason = 'epoch';                                             // 本实例没有这个任务：多半是文档服务重启过
      else if (task.state === 'claimed' && task.claim.nodeId !== nodeId) reason = 'not-owner';   // C4：令牌只认认领它的节点
      lost.push({ id, token, reason });
    }

    // 这个节点名下没能接续的认领一律放弃：节点自己都不认它了，留着只会等到租约到期
    const resumedSet = new Set(resumed);
    const dropped = [];
    for (const task of tasks.values()) {
      if (task.state === 'claimed' && task.claim.nodeId === nodeId && !resumedSet.has(task.id)) dropped.push(task);
    }
    const outs = dropped.map((task) => abandon(task, { lastError: 'not-resumed' }));

    // activeIntervalMs（M7 D2 补充）：这个队列认 `node.active`，节点忙着时按这个间隔报；旧队列不带，节点据此不发
    emit(conn, 'node.welcome', {
      nodeId, envFingerprint: node.envFingerprint ?? null, resumed, lost: lost.map((l) => l.id), activeIntervalMs: NODE_ACTIVE_INTERVAL_MS,
      // 这个队列认稀疏流任务(id 末尾带 `:sparse`,`messages.mjs` 的 `taskIdOf`):切分方看到这一项才切稀疏流任务;
      // 旧队列不带,切分方就只切满密度的(旧队列校验 id 时不认这种写法,发了会被整批拒掉)
      sparseStreams: true,
      // 块 N:浏览器节点另有一个用户卡、素材效果卡用的指纹;别的节点与没报运行时版本的浏览器不带这一项(旧形状不变)
      ...(node.profile === 'browser' && fingerprintOf(node.cardEnvFingerprint) !== null ? { cardEnvFingerprint: node.cardEnvFingerprint } : {}),
    }, reqId);
    for (const l of lost) emit(conn, 'task.lease-lost', l);
    for (const out of outs) out.notify();
  }

  function onPublisherHello(conn, body, reqId) {
    const { publisherId } = body;
    if (conn.publisherId !== null && conn.publisherId !== publisherId) detachPublisher(conn);
    let pub = publishers.get(publisherId);
    if (pub) {
      if (pub.conn && pub.conn !== conn) pub.conn.publisherId = null;
    } else {
      pub = { publisherId };
      publishers.set(publisherId, pub);
    }
    // 重连：订阅全部保留（F7.4）
    pub.conn = conn;
    pub.disconnectedAt = null;
    conn.publisherId = publisherId;
    emit(conn, 'publisher.welcome', { publisherId }, reqId);
  }

  /**
   * `queue.watch`（A.6；M6c X3 收紧 `'all'`）：
   * - `browser` 用 `'all'`：回 `error { reason: 'forbidden' }`，原来的 watch 不变（纯浏览器只见本人任务，全量会泄露别人的项目）；
   * - `host` 用 `'all'`：只收项目摘要——回一条 `queue.summary`，此后每次 tick 摘要变了才再发一条（每周期至多一条），
   *   不收任何单任务增量；
   * - `host` 用项目列表：照常收这些项目的增量与 `queue.snapshot`；非空列表不影响摘要（主机凭摘要知道哪些项目有活，
   *   再 watch 那些项目，`render-node/host.mjs`），空列表连摘要一起停（文档服务模块切到频道摘要时替它发的就是空列表）；
   * - `pc` 照旧：本机节点依赖全量。
   */
  function onWatch(conn, body, reqId) {
    const node = nodeOf(conn);
    if (body.projects === 'all' && node.profile === 'browser') {
      emit(conn, 'error', { reason: 'forbidden', detail: "纯浏览器节点不能 watch 'all'，请列出本人的项目" }, reqId);
      return;
    }
    if (body.projects === 'all' && node.profile === 'host') {
      conn.watch = new Set();
      conn.summary = true;
      const projects = summaryOf();
      conn.lastSummary = JSON.stringify(projects);
      emit(conn, 'queue.summary', { at, projects }, reqId);
      return;
    }
    if (body.projects !== 'all' && body.projects.length === 0) { conn.summary = false; conn.lastSummary = null; }
    conn.watch = body.projects === 'all' ? 'all' : new Set(body.projects);
    const visible = [...tasks.values()]
      .filter((t) => t.state === 'open' && canSee(conn, t))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(viewOf);
    emit(conn, 'queue.snapshot', { tasks: visible }, reqId);
  }

  /**
   * 派生任务的继承（A.4 末段，设计第 3 节）：细任务的 userId 是产生它的那个 plan 任务的，不是切分节点的，
   * 否则纯浏览器用户的边界（Q2）会被切分节点的身份顶掉；订阅者并上 plan 的订阅者，页面订阅了 plan
   * 就能收到细任务的 task.done，切分节点断开也不会让细任务因没人订阅被删。
   * 只在「plan 此刻正由发布连接这个节点认领着」时继承：别人拿不到这份身份。条件不满足就不继承，不报错。
   */
  function planParentOf(conn, derivedFrom) {
    if (derivedFrom === null) return null;
    const plan = tasks.get(derivedFrom);
    const node = nodeOf(conn);
    if (!plan || plan.kind !== 'plan' || plan.state !== 'claimed' || !node) return null;
    return plan.claim.nodeId === node.nodeId ? plan : null;
  }

  const ttlPassed = (task) => (task.state === 'done' || task.state === 'failed') && at - task.finishedAt > C.DONE_TTL;

  function onPublish(conn, body, reqId) {
    freshTasks = new Set();
    try { publishAll(conn, body, reqId); } finally { freshTasks = null; }
  }

  function publishAll(conn, body, reqId) {
    const publisherId = conn.publisherId;
    const results = [];
    const after = [];
    for (const input of body.tasks) {
      let task = tasks.get(input.id);
      // 过了 TTL 的 done / failed 就当已经不存在，不必等下一次 tick 才能重新发布（C1）；
      // 被作废的（superseded，M7 D1、D2）同样：锁回到它的指纹上、或切分方带 takeover 接手时要能重建
      if (task && (ttlPassed(task) || isSuperseded(task))) { removeTask(task); task = undefined; }
      let result;
      if (!task) {
        if ((activeByProject.get(input.source.projectId) ?? 0) >= C.MAX_TASKS_PER_PROJECT) {
          // 没建成任务，锁也不动：带 takeover 时若照样接手，旧指纹的任务作废了却没有新任务顶上
          results.push({ id: input.id, error: 'limit' });
          continue;
        }
        // 被别的环境锁定的卡不建（F.7 第 1 条），和 limit 一样只影响这一项
        const refusal = lockRefusal(input);
        if (refusal !== null) {
          results.push({ id: input.id, error: 'card-locked', ...lockInfo(refusal.key, refusal.lock, { undone: true }) });
          continue;
        }
        // 用户与租户只认连接凭证，发布方自报的在校验时已经丢掉（A.4、P7）；
        // 派生任务例外：继承它的 plan 任务的身份与订阅者
        const parent = planParentOf(conn, input.source.derivedFrom);
        task = {
          id: input.id, kind: input.kind, tier: input.tier, resultKey: input.resultKey, range: input.range,
          source: {
            projectId: input.source.projectId, projectRev: input.source.projectRev,
            derivedFrom: input.source.derivedFrom,
            userId: parent ? parent.source.userId : conn.principal.userId,
            tenantId: parent ? parent.source.tenantId : conn.principal.tenantId,
            publisher: { id: publisherId }, publishedAt: at,
          },
          input: input.input, weight: input.weight, requires: input.requires, priority: input.priority,
          state: 'open', version: 1, attempts: 0, lastError: null,
          claim: null, finishedAt: null, result: null,
          subscribers: new Set([publisherId, ...(parent ? parent.subscribers : [])]),
        };
        tasks.set(task.id, task);
        freshTasks.add(task);
        countActive(task.source.projectId, 1);
        result = { id: task.id, state: 'open', version: 1, created: true };
        const t = task;
        const view = viewOf(t);
        after.push(() => broadcast(t, 'task.opened', { task: view }));
      } else {
        result = mergeExisting(conn, task, input, after);
      }
      // 原有处理之后再看锁（F.1）；锁身份取表里的任务，和认领第 3a 步查的是同一份
      const locked = lockOnPublish(task, input.takeover, after, nodeOf(conn));
      if (locked !== null) Object.assign(result, locked);
      // M7 D1：合并进来的这一份是 dual、这张卡已经锁在别的指纹上：另一份早就得卡了，这一份谁也认领不到，照建锁时一样作废
      if (locked?.lockedBy && !result.error && isActive(task.state) && task.input?.dual === true) {
        const notify = supersedeDual(lockIdOf(task).key, locked.lockedBy);
        if (notify) after.push(notify);
        Object.assign(result, { state: task.state, version: task.version });
      }
      results.push(result);
    }
    emit(conn, 'task.published', { results }, reqId);
    for (const fn of after) fn();
  }

  /** 发布时已有同 id 的任务（A.7.1 表的后三行，以及 A.4 末段的继承并入）；返回这一项的回包 */
  function mergeExisting(conn, task, input, after) {
    if (isActive(task.state)) {
      task.subscribers.add(conn.publisherId);
      /*
       * 优先级升级（语义 mechanism/document-service.md「优先级」，c10a 契约第 17 节）：同一个结果键已有任务就不另起；
       * 已有的是 backfill 而这次按 normal 发布，升为 normal（取这次的 priority，整数名次也一并带上）。
       * 不是状态转移，version 不变；还 open 的重发一条 task.opened，节点视图里的优先级跟着换。
       */
      if (priorityBand(task.priority) === 'backfill' && priorityBand(input.priority) === 'normal') {
        task.priority = input.priority;
        if (task.state === 'open') {
          const view = viewOf(task);
          after.push(() => broadcast(task, 'task.opened', { task: view }));
        }
      }
      /*
       * M7 D1（验收探针查出）：切分方这一份早先按单份建过（页面报到之前的那一版），这一版又按双份发来 ——
       * 它现在有了另一份，补上 `dual`，建锁时才会被作废，不留成谁都认领不了的死任务。换新对象，不原地改。
       */
      if (input.input?.dual === true && task.input?.dual !== true) {
        task.input = { ...task.input, dual: true };
        // 同优先级升级：还 open 的重发一条 task.opened，看得见它的节点（与旁观者）视图里的 input 跟着换
        if (task.state === 'open') {
          const view = viewOf(task);
          after.push(() => { if (task.state === 'open') broadcast(task, 'task.opened', { task: view }); });
        }
      }
    } else if (task.state === 'done') {
      const fields = doneFields(task);
      after.push(() => emit(conn, 'task.done', fields));
    }
    // failed（未过 TTL）：不重新打开，只在回包里说明（C1）

    // 已存在的任务同样并入 plan 的订阅者（A.4 末段，M3 裁定）：共享档的结果键与项目无关，
    // 这一版切出的细任务常常是上一版或别的项目建的，不并进来页面就收不到它们的结果。
    // 身份不改；已经做完 / 已经失败的，只给新并入的订阅者各补一条通知。
    const parent = planParentOf(conn, input.source.derivedFrom);
    if (parent) {
      const joined = [...parent.subscribers].filter((id) => !task.subscribers.has(id));
      for (const id of joined) task.subscribers.add(id);
      if (task.state === 'done' || task.state === 'failed') {
        const type = task.state === 'done' ? 'task.done' : 'task.failed';
        const fields = task.state === 'done' ? doneFields(task) : { id: task.id, error: task.lastError };
        after.push(() => {
          for (const id of joined) {
            const pub = publishers.get(id);
            // 本连接已经按 A.7.1 收过一条 task.done，不重复发
            if (pub && pub.conn && !(type === 'task.done' && pub.conn === conn)) emit(pub.conn, type, fields);
          }
        });
      }
    }
    return { id: task.id, state: task.state, version: task.version, created: false };
  }

  function onUnsubscribe(conn, body, reqId) {
    const publisherId = conn.publisherId;
    let targets;
    if (body.ids) {
      targets = [...new Set(body.ids)].map((id) => tasks.get(id)).filter(Boolean);
    } else {
      targets = [...tasks.values()].filter((t) => t.source.projectId === body.projectId
        && (body.projectRev === null || t.source.projectRev === body.projectRev));
    }
    const ids = [];
    const removed = [];
    for (const task of targets) {
      if (!task.subscribers.delete(publisherId)) continue;
      ids.push(task.id);
      // 没人要的 open 任务删掉；claimed 的让它做完（结果按内容键寻址，别的版本可能还用得上），做完不通知
      if (task.subscribers.size === 0 && task.state === 'open') {
        removeTask(task);
        removed.push(task);
      }
    }
    emit(conn, 'task.unsubscribed', { ids }, reqId);
    for (const task of removed) broadcast(task, 'task.closed', { id: task.id, state: 'removed' });
  }

  function onClaim(conn, body, reqId) {
    const node = nodeOf(conn);
    const { id, expectVersion } = body;
    // 限流（I.5）：本周期 card-locked 拒绝已超过 THROTTLE_REJECTS 的连接，不看任务、不改任何状态，
    // 直到下一次 tick。前置过滤之下还在反复撞锁的节点多半没按可见性认领，别让它把队列拖进锁风暴
    if (C.PREFILTER && conn.cardLockedRejects > C.THROTTLE_REJECTS) {
      return emit(conn, 'task.claim-rejected', { id, reason: 'throttled' }, reqId);
    }
    const task = tasks.get(id);
    // 设计 4.2 的顺序，一步同步做完
    if (!task) return emit(conn, 'task.claim-rejected', { id, reason: 'gone' }, reqId);
    if (node.profile === 'browser' && task.source.userId !== conn.principal.userId) {
      // 不带 state / version：别人的任务连状态也不给纯浏览器看
      return emit(conn, 'task.claim-rejected', { id, reason: 'forbidden' }, reqId);
    }
    // X4：plan 只给 pc。独立主机不替任何页面做计划，纯浏览器没有 Chrome 和 card-cache（filter.mjs 规则 6 在节点侧也挡）。
    // C10 契约第 18 节第 9 条〔裁〕对 X4 的修改：带片段清单的 plan（在线页面的清单计划、旧页面的预渲染重试计划）host 也能认领，
    // 由认领的节点用自己的指纹切分；不带清单的桌面 plan 照旧只给 pc。纯浏览器一律不认领 plan
    if (task.kind === 'plan' && (node.profile === 'browser' || (node.profile === 'host' && !isListPlan(task)))) {
      return emit(conn, 'task.claim-rejected', { id, reason: 'plan-profile' }, reqId);
    }
    if (task.state !== 'open') {
      return emit(conn, 'task.claim-rejected', { id, reason: 'taken', state: task.state, version: task.version }, reqId);
    }
    if (task.retryNodeId === node.nodeId && at < task.retryAfter) {
      return emit(conn, 'task.claim-rejected', {
        id, reason: 'retry-backoff', state: 'open', version: task.version, retryInMs: task.retryAfter - at,
      }, reqId);
    }
    // X4：plan 就近认领。发布方写了 preferNode（它自己的节点）的 plan，发布后 PLAN_PREFER_MS 之内只给那个节点；
    // 窗口按 A.8 的口径用严格大于判过期。回 retryInMs，节点会话据此把这个候选搁到窗口过后，不必丢掉
    if (task.kind === 'plan') {
      const prefer = requiredOf(task, 'preferNode');
      const until = task.source.publishedAt + C.PLAN_PREFER_MS;
      // preferNode 断开过(`preferEnded`,detachNode 里标)窗口就此结束(集成裁定)
      if (prefer !== null && prefer !== node.nodeId && at <= until && task.preferEnded !== true) {
        return emit(conn, 'task.claim-rejected', {
          id, reason: 'preferred', state: 'open', version: task.version, preferNode: prefer, retryInMs: until - at + 1,
        }, reqId);
      }
    }
    // 指纹不符（I.10 第 4 条，语义「也不让它认领」）：过滤开着、节点与任务都带指纹且不同就拒，和 card-locked 一样
    // 计入限流次数。放在 taken 之后、3a 之前：环境本来就不对的节点不必知道这张卡锁在谁那里。
    // 没带 preferNode 的 plan 不查（同 envAllows）；带的查（X4「指纹符合的 pc」）
    if (C.PREFILTER && checksFingerprint(task)) {
      const nodeFp = nodeFpFor(node, task);
      const taskFp = fingerprintOf(task.requires ? task.requires.envFingerprint : undefined);
      if (nodeFp !== null && taskFp !== null && nodeFp !== taskFp) {
        conn.cardLockedRejects += 1;
        return emit(conn, 'task.claim-rejected', { id, reason: 'fingerprint-mismatch', state: 'open', version: task.version }, reqId);
      }
    }
    // X2：输入里有只在发布方本机的素材，只有那个节点能认领。不看 PREFILTER：这是正确性闸，和 3a 一样；
    // 计入限流次数（前置过滤之下还来认领的节点多半没按可见性认领）
    if (!localMediaAllows(node, task)) {
      conn.cardLockedRejects += 1;
      return emit(conn, 'task.claim-rejected', {
        id, reason: 'local-media', state: 'open', version: task.version, localMedia: requiredOf(task, 'localMedia'),
      }, reqId);
    }
    // 3a（F.1）：这张卡的这种结果已被别的环境锁定，本任务的指纹产出的帧不能混进去。
    // 放在 stale 之前：锁不变，节点拿新版本号重试也没用，早点让它丢掉这个候选
    const lockId = lockIdOf(task);
    const lock = lockId ? locks.get(lockId.key) : undefined;
    if (lock && lock.envFingerprint !== lockId.fp) {
      // 计数两种模式都记（describe 的诊断，对照组要看拒绝数）；只有 PREFILTER 开着时才据此限流（I.5）
      conn.cardLockedRejects += 1;
      const { lockedBy, lockIdleMs, lockedByProfile } = lockInfo(lockId.key, lock);
      return emit(conn, 'task.claim-rejected', {
        id, reason: 'card-locked', state: 'open', version: task.version, lockedBy, lockIdleMs, lockedByProfile,
      }, reqId);
    }
    if (expectVersion !== task.version) {
      return emit(conn, 'task.claim-rejected', { id, reason: 'stale', state: 'open', version: task.version }, reqId);
    }
    // 第一次认领就是第一次真正开始产出：没锁就在这里用任务的指纹锁定（设计 2.1「谁定指纹」）。
    // 新建的锁让同一张卡别的指纹的 open 任务对相应节点变得不可见，定向撤回（I.3）；认领的这个任务自己不算
    let lockNotify = null;
    let dualNotify = null;
    if (lockId) {
      if (lock) produced(lock, node.profile, node.nodeId);
      else lockNotify = changeLock(lockId.key, () => setLock(lockId.key, lockId.fp, 'claim', node.profile, node.nodeId), task);
      // M7 D1：这张卡归了这个指纹，切分方多出的另一份（dual）作废
      dualNotify = supersedeDual(lockId.key, lockId.fp);
    }
    transition(task, 'claimed');
    task.retryNodeId = null;
    task.retryAfter = null;
    task.claim = {
      nodeId: node.nodeId, conn, token: task.version, claimedAt: at,
      leaseUntil: at + C.LEASE_MS, progress: { done: null, step: null, changedAt: at },
    };
    const claimed = { id, token: task.claim.token, version: task.version, leaseUntil: task.claim.leaseUntil, task: viewOf(task) };
    // M7 D1：plan 的认领回包带本项目在线的、同一用户的纯浏览器节点的指纹，切分方据此给浏览器可做的卡另出一份
    if (task.kind === 'plan') {
      const browserFingerprints = browserFingerprintsFor(task);
      if (browserFingerprints.length > 0) claimed.browserFingerprints = browserFingerprints;
      // 块 N:同样的节点用户卡、素材效果卡的指纹(`cardEnvFingerprint`)。切分方只给「文档服务确认过有这样一台在线节点」的指纹出用户卡、素材效果卡的浏览器那一份
      const browserCardEnvFingerprints = browserFingerprintsFor(task, 'cardEnvFingerprint');
      if (browserCardEnvFingerprints.length > 0) claimed.browserCardEnvFingerprints = browserCardEnvFingerprints;
    }
    emit(conn, 'task.claimed', claimed, reqId);
    broadcast(task, 'task.taken', { id, version: task.version }, conn);
    if (lockNotify) lockNotify();
    if (dualNotify) dualNotify();
  }

  /**
   * 令牌栅栏（设计 4.2）：任务在、是 claimed、令牌对、发消息的就是当前认领者，才算持有。
   * 否则回 lease-lost、不改状态：租约被收回后原节点即使做完，也改不了任务状态。
   */
  function heldTask(conn, body, reqId) {
    const task = tasks.get(body.id);
    if (task && task.state === 'claimed' && task.claim.token === body.token && task.claim.nodeId === conn.nodeId) return task;
    emit(conn, 'task.lease-lost', { id: body.id, token: body.token, reason: 'token' }, reqId);
    return null;
  }

  function onProgress(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    const claim = task.claim;
    claim.leaseUntil = at + C.LEASE_MS;
    // 停滞计时只在进度变了的时候重起：心跳还在但工作不动的节点照样按停滞回收（F3.1）。
    // 「进度」是帧数 done，以及节点带来的工作计数 step（推块、换阶段时也在变，契约 A.12〔裁〕）；没带 step 的旧节点只看 done
    const stepChanged = body.step !== null && body.step !== claim.progress.step;
    if (body.done !== claim.progress.done || stepChanged) {
      claim.progress = { done: body.done, step: body.step ?? claim.progress.step, changedAt: at };
    }
    // M7 D2：续约也算锁定方还在产出（一段重卡在浏览器上要十几秒，产出中不该被判闲置）
    const lockId = lockIdOf(task);
    const lock = lockId ? locks.get(lockId.key) : undefined;
    if (lock && lock.envFingerprint === lockId.fp) produced(lock, nodeOf(conn)?.profile ?? null, conn.nodeId);
    emit(conn, 'task.renewed', { id: task.id, token: claim.token, leaseUntil: claim.leaseUntil }, reqId);
  }

  function onComplete(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    transition(task, 'done');
    task.claim = null;
    task.finishedAt = at;
    task.result = body.result;
    // 锁还有人在产出：刷新 touchedAt，tick 的第 5 项扫描不回收它
    const lockId = lockIdOf(task);
    const lock = lockId ? locks.get(lockId.key) : undefined;
    if (lock) {
      lock.touchedAt = at;
      if (lock.envFingerprint === lockId.fp) produced(lock, nodeOf(conn)?.profile ?? null, conn.nodeId);
    }
    emit(conn, 'task.completed', { id: task.id }, reqId);
    // 没有订阅者时一条 task.done 也不发（F7.2）
    notifySubscribers(task, 'task.done', doneFields(task));
    broadcast(task, 'task.closed', { id: task.id, state: 'done' });
  }

  function onRelease(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    // 主动放回是让路，不是做不了：attempts 不加（C2）
    transition(task, 'open');
    task.claim = null;
    // 没人要的任务放回时同样直接删掉（A.7.6 末条），否则它会一直挂在 open 里没人清
    const orphan = task.subscribers.size === 0;
    if (orphan) removeTask(task);
    emit(conn, 'task.released', { id: task.id }, reqId);
    if (orphan) broadcast(task, 'task.closed', { id: task.id, state: 'removed' });
    else broadcast(task, 'task.opened', { task: viewOf(task) });
  }

  function onFail(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    const out = abandon(task, { lastError: body.error ?? 'failed', retryable: body.retryable });
    emit(conn, 'task.fail-ack', { id: task.id, state: out.state }, reqId);
    out.notify();
  }

  /**
   * `card.lock`（F.1）：发布方（页面测量帧入库的那一方）直接申请或接手一把锁，不经任务。
   * 同一把锁下只有一种环境的结果被投递，所以没带 takeover 的异指纹申请只回「没得到」、锁不变。
   */
  function onCardLock(conn, body, reqId) {
    const key = lockKeyOf({ kind: body.kind, input: { contentKey: body.contentKey } });
    const fp = body.envFingerprint;
    const lock = locks.get(key);
    let notify = null;
    let dualNotify = null;
    if (!lock) notify = changeLock(key, () => setLock(key, fp, 'lock'));
    else if (lock.envFingerprint === fp) produced(lock);
    else if (body.takeover) notify = takeoverLock(key, fp);
    const held = locks.get(key).envFingerprint;
    // M7 D1：锁定了就作废另一份（dual）；接手时 takeoverLock 已把异指纹的一并作废
    if (held === fp) dualNotify = supersedeDual(key, fp);
    emit(conn, 'card.locked', { lockKey: key, envFingerprint: held, granted: held === fp }, reqId);
    if (notify) notify();
    if (dualNotify) dualNotify();
  }

  /**
   * `node.active`（M7 D2 补充〔裁〕）：节点还在、在忙。只记时刻与忙什么，不回包、不改任务与锁；
   * 锁闲置怎么算见 lockLastActive。消息很频繁（每个忙着的页面每 10 s 一条），所以连 reqId 也不回。
   */
  function onNodeActive(conn, body) {
    const node = nodeOf(conn);
    node.activeAt = at;
    node.activeBusy = body.busy ?? null;
  }

  const HANDLERS = new Map([
    ['node.hello', onNodeHello],
    ['publisher.hello', onPublisherHello],
    ['queue.watch', onWatch],
    ['task.publish', onPublish],
    ['task.unsubscribe', onUnsubscribe],
    ['card.lock', onCardLock],
    ['task.claim', onClaim],
    ['task.progress', onProgress],
    ['task.complete', onComplete],
    ['task.release', onRelease],
    ['task.fail', onFail],
    ['node.active', onNodeActive],
  ]);

  // ---------- 对外接口 ----------

  function connect(connId, principal) {
    if (principal === null || typeof principal !== 'object' || typeof principal.userId !== 'string') {
      throw new TypeError('connect: principal.userId 必须是字符串');
    }
    at = now();
    // 同一 connId 重复 connect：先按断开处理旧的
    if (conns.has(connId)) disconnect(connId);
    conns.set(connId, {
      connId,
      principal: { userId: principal.userId, tenantId: typeof principal.tenantId === 'string' ? principal.tenantId : null },
      nodeId: null, publisherId: null, watch: null,
      summary: false, lastSummary: null,   // X3：host 的 watch 'all' 只收摘要；上一次发出去的摘要（JSON），变了才再发
      cardLockedRejects: 0,   // 本扫描周期内收到的 card-locked 与 fingerprint-mismatch 拒绝数，tick 清零（I.5、I.10 第 4 条）
    });
  }

  function disconnect(connId) {
    const conn = conns.get(connId);
    if (!conn) return;
    at = now();
    // 认领和订阅都不动，等 tick 的宽限扫描（A.9）
    detachNode(conn);
    detachPublisher(conn);
    conns.delete(connId);
  }

  function handle(connId, message) {
    const conn = conns.get(connId);
    if (!conn) return;
    at = now();
    const parsed = parseInbound(message);
    if (!parsed.ok) {
      emit(conn, 'error', { reason: 'bad-message', detail: parsed.detail }, parsed.reqId);
      return;
    }
    const { type, reqId, body } = parsed;
    if ((NODE_TYPES.has(type) && !nodeOf(conn)) || (PUBLISHER_TYPES.has(type) && !publisherOf(conn))) {
      emit(conn, 'error', { reason: 'not-registered' }, reqId);
      return;
    }
    HANDLERS.get(type)(conn, body, reqId);
  }

  /**
   * 时钟推进后调用：租约、停滞、宽限、TTL 四项扫描，按此顺序，比较一律严格大于（A.8）；
   * 之后是第 5 项，回收没人用的卡片级指纹锁（F.1）。
   */
  function tick() {
    at = now();
    const alive = (task) => tasks.get(task.id) === task;

    for (const task of [...tasks.values()]) {
      if (alive(task) && task.state === 'claimed' && at > task.claim.leaseUntil) reclaim(task, 'lease-expired');
    }
    for (const task of [...tasks.values()]) {
      if (!alive(task) || task.state !== 'claimed') continue;
      const { progress } = task.claim;
      // 从未报过进度的只受租约管（F3.3）
      if (progress.done !== null && at - progress.changedAt > C.STALL_MS) reclaim(task, 'stalled');
    }
    for (const node of [...nodes.values()]) {
      if (node.conn !== null || at - node.disconnectedAt <= C.RECONNECT_GRACE_MS) continue;
      for (const task of [...tasks.values()]) {
        if (alive(task) && task.state === 'claimed' && task.claim.nodeId === node.nodeId) reclaim(task, 'disconnected');
      }
      nodes.delete(node.nodeId);
    }
    for (const pub of [...publishers.values()]) {
      if (pub.conn !== null || at - pub.disconnectedAt <= C.RECONNECT_GRACE_MS) continue;
      // C5：宽限过后移除它的订阅；变得没人要的 open 任务删除，claimed 的让它做完
      for (const task of [...tasks.values()]) {
        if (!task.subscribers.delete(pub.publisherId)) continue;
        if (task.subscribers.size === 0 && task.state === 'open') {
          removeTask(task);
          broadcast(task, 'task.closed', { id: task.id, state: 'removed' });
        }
      }
      publishers.delete(pub.publisherId);
    }
    for (const task of [...tasks.values()]) {
      if (ttlPassed(task)) removeTask(task);   // C1：done / failed 留 DONE_TTL，删除不发消息
    }
    // 第 5 项（F.1）：锁没有任务再引用、且闲置超过 DONE_TTL 才删。排在 TTL 之后，刚过期删掉的任务不再算引用。
    // 比较和前四项一样用严格大于（F.7 第 3 条）
    if (locks.size > 0) {
      const referenced = new Set();
      for (const task of tasks.values()) {
        const key = lockKeyOf(task);
        if (key !== null) referenced.add(key);
      }
      // 删的锁已没有任何任务引用，也就没有 open 任务的可见性会变，不用发定向增量（I.3）
      for (const [key, lock] of locks) {
        if (!referenced.has(key) && at - lock.touchedAt > C.DONE_TTL) locks.delete(key);
      }
    }
    // 新的扫描周期：每条连接的 card-locked 拒绝计数清零，限流随之解除（I.5）
    for (const conn of conns.values()) conn.cardLockedRejects = 0;
    // 第 6 项（M6c X3）：只收摘要的 host 连接，摘要和上一次发给它的不同才发，所以每个扫描周期至多一条
    let projects = null;
    let json = null;
    for (const conn of conns.values()) {
      if (!conn.summary || !nodeOf(conn)) continue;
      if (projects === null) { projects = summaryOf(); json = JSON.stringify(projects); }
      if (json === conn.lastSummary) continue;
      conn.lastSummary = json;
      emit(conn, 'queue.summary', { at, projects });
    }
  }

  function describe() {
    const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const claimsByNode = new Map();
    for (const t of tasks.values()) if (t.state === 'claimed') claimsByNode.set(t.claim.nodeId, (claimsByNode.get(t.claim.nodeId) ?? 0) + 1);
    const out = {
      epoch,
      prefilter: C.PREFILTER,   // I.7
      tasks: [...tasks.values()].sort((a, b) => byId(a.id, b.id)).map((t) => ({
        id: t.id, projectId: t.source.projectId, state: t.state, version: t.version,
        attempts: t.attempts, lastError: t.lastError,
        claim: t.claim && {
          nodeId: t.claim.nodeId, token: t.claim.token, leaseUntil: t.claim.leaseUntil,
          progress: { done: t.claim.progress.done, changedAt: t.claim.progress.changedAt,
            ...(t.claim.progress.step !== null ? { step: t.claim.progress.step } : {}) },
        },
        subscribers: [...t.subscribers].sort(byId),
        finishedAt: t.finishedAt,
      })),
      nodes: [...nodes.values()].sort((a, b) => byId(a.nodeId, b.nodeId)).map((n) => {
        // I.7：这个节点当前那条连接本周期的 card-locked 拒绝数，和它此刻是否被限流；断开的节点记 0 / false
        const rejects = n.conn !== null ? n.conn.cardLockedRejects : 0;
        return {
          nodeId: n.nodeId, profile: n.profile, connected: n.conn !== null, disconnectedAt: n.disconnectedAt,
          cardLockedRejects: rejects, throttled: C.PREFILTER && rejects > C.THROTTLE_REJECTS,
          // M7 第 7 节诊断：节点的用户（带设备）、指纹、此刻持有的认领数；票据之类一律不出现
          userId: n.userId ?? null, envFingerprint: n.envFingerprint ?? null, claims: claimsByNode.get(n.nodeId) ?? 0,
          ...(fingerprintOf(n.cardEnvFingerprint) !== null ? { cardEnvFingerprint: n.cardEnvFingerprint } : {}),
          // M7 D2 补充：报过 node.active 的节点才有这两项（旧节点的 describe 形状不变）
          ...(typeof n.activeAt === 'number' ? { activeAt: n.activeAt, activeBusy: n.activeBusy ?? null } : {}),
        };
      }),
      publishers: [...publishers.values()].sort((a, b) => byId(a.publisherId, b.publisherId)).map((p) => ({
        publisherId: p.publisherId, connected: p.conn !== null, disconnectedAt: p.disconnectedAt,
      })),
      locks: [...locks.entries()].sort((a, b) => byId(a[0], b[0])).map(([lockKey, l]) => ({
        lockKey, envFingerprint: l.envFingerprint, source: l.source, since: l.since, touchedAt: l.touchedAt,
      })),
    };
    return structuredClone(out);
  }

  /** M7 D9：这个 nodeId 此刻绑在哪个 userId 上（节点记录不在回 null）。文档服务模块报到前先查，免得把被拒的连接记成节点 */
  function nodeUserOf(nodeId) {
    return nodes.get(nodeId)?.userId ?? null;
  }

  /**
   * 判断能不能抢占一个在途流任务所需的最小任务视图（给能力更强的节点；文档服务模块挂在 `queue.snapshot` / `task.taken` 上）：
   * 节点侧过滤（`filter.mjs`）与 `canClaim`（托管节点按项目的「生成轨道流」开关、导出位图不归它管）要看的那几项 ——
   * 种类、版本、项目、重度、`requires`、`input` 里的密度与导出位图标记。不带认领令牌、订阅方、发布方的用户、内容键与输入细节。
   */
  function preemptViewOf(task) {
    const input = {};
    if (task.input?.density === 'sparse') input.density = 'sparse';
    if (task.input?.exportFrames === true) input.exportFrames = true;
    return {
      id: task.id, kind: task.kind, version: task.version,
      source: { projectId: task.source.projectId },
      weight: { class: task.weight?.class ?? 'medium' },
      requires: structuredClone(task.requires ?? {}),
      input,
    };
  }

  /**
   * 这条连接看得见的、正被认领着的流任务（可选只看 `id` 这一个）：`[{ task: 最小视图, holderNodeId }]`，按 id 升序。
   * 可见性与 open 任务同一道（`canSee`：watch 了这个项目、指纹前置过滤）；纯浏览器不抢占别人，一律回空。
   * `holderNodeId` 只给文档服务模块换算持有方的设备等级，不往外发。
   */
  function claimedStreamsFor(connId, id = null) {
    const conn = conns.get(connId);
    if (!conn) return [];
    const node = nodeOf(conn);
    if (!node || node.profile === 'browser') return [];
    const pick = id === null ? [...tasks.values()] : [tasks.get(id)].filter(Boolean);
    return pick
      .filter((t) => t.kind === 'stream' && t.state === 'claimed' && t.claim && canSee(conn, t))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((t) => ({ task: preemptViewOf(t), holderNodeId: t.claim.nodeId }));
  }

  return Object.freeze({
    connect, disconnect, handle, tick, describe, nodeUserOf, claimedStreamsFor,
    get epoch() { return epoch; },
  });
}
