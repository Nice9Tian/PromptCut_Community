/**
 * 独立渲染主机的节点编排(M6b,契约 `docs/plan/render-host-contract.md` 第 2、3 节)。
 *
 * 独立渲染主机就是只开 `render` 连接的设备:配置里每个共享项目一条连接、一个节点(`profile: 'host'`),
 * 所有节点共用同一个预渲染执行器,并发总数不超过 `maxConcurrent`(缺省 1,上限 4)。
 *
 *   parseHostConfig(raw)  规整配置(M6a 的形状:一项或数组),另取 `maxConcurrent`(不合格抛 bad-host-config)
 *   loadHostConfig(env)   读 `PROMPTCUT_SHARED_CONFIG` 指的文件,再经 parseHostConfig
 *   createRenderHost(…)   按配置每项调一次 `connect(entry)` 拿 { endpoint, executor, sink },
 *                         每条连接上起一个 `createLocalNode`(`profile: 'host'`),由调用方按节拍调 `tick()`
 *
 * # 并发总数
 *
 * 每个节点的会话各自只看自己的持有数,所以另加一道全局闸:每个节点的 `isIdle()` 回
 * 「全部节点的持有数 + 在飞的认领数 < maxConcurrent」。在飞的认领在包过的 `send` 里记(发 `task.claim` 时记上,
 * 收到同 id 的 `task.claimed` / `task.claim-rejected`、不带 reqId 的 `error`、重新报到或断线时清掉),
 * 与 `session.mjs` 的在飞规则一致。`tick()` 按顺序逐个节点推进,`send` 是同步的,前一个节点刚发的认领
 * 在后一个节点判闲时已经算进去,所以任何时刻持有 + 在飞都不超过上限。
 *
 * # 闲时认领(契约 `render-queue-contract.md` A.12〔裁〕)
 *
 * 所有节点共用的预渲染管线里,快照与 `plan` 走同一条串行 lane(一次只做一件)。并发上限 2 时若一次认领两段快照,
 * 第二段只能在 lane 里排队:帧数不动、工作计数也不动,排过 STALL_MS 就被队列当成卡死收回(M8 C1)。所以执行器给了
 * `laneOf` 时再加一道:要用串行 lane 的任务,只在这条 lane 空着(执行器报 `laneBusy() === 0`)、全部节点手里也没有
 * 还没走到推送的同 lane 任务(`local.occupying()`)、也没有在飞的同 lane 认领时才认领。推产物不占 lane:前一段推送时
 * 下一段照样认领、渲染。执行器没给 `laneOf`(测试替身)时不加这道闸,行为同前。
 *
 * # 只认领带片段清单的 `plan`
 *
 * 节点侧过滤 `filter.mjs` 规则 6:`profile: 'host'` 的节点见到不带片段清单的 `plan`(桌面发布方的)直接跳过,
 * 不发认领(契约第 3、4 节),那种 `plan` 留给发布方自己的节点。带片段清单的 `plan`(在线页面的清单计划、旧页面的
 * 预渲染重试计划)主机照常认领,用自己的指纹切分、发布细任务(C10 契约第 18 节第 9 条,对 M6c X4 的修改)。
 * 主机自己不发布 `plan`。
 *
 * # 看得见哪些任务(M6c X3)
 *
 * 队列对 host 的 `watch: 'all'` 只回项目摘要 `queue.summary`,不发单任务增量。节点会话(`session.mjs` 的
 * `followSummary`)接到摘要就改 watch 摘要里有活的项目,随即收到它们的快照与增量、照常认领;新项目有活
 * 最迟一个扫描周期后出现在摘要里。诊断 `nodes()` 的 `watching` 是会话此刻 watch 着的项目。
 *
 * # 闲时门槛
 *
 * 主机没有页面、没有播放:只要全局闸有空位就认领(契约第 3 节「闲时门槛」),不看执行器的 `isIdle`。
 *
 * # 退出
 *
 * `shutdown(reason)`:每个节点 `yieldAll(reason)`(持有的一律 `task.release`,在飞的认领回来即放回)
 * 再 `stop()`;调用方随后关连接。队列收到 `task.release` 立即把任务放回 `open`,不必等断线的宽限期。
 *
 * # 运行中增删项目(托管方的渲染节点,`docs/plan/hosted-render-contract.md` 第 2、4、7.1 节)
 *
 * `dynamic: true` 时 `entries` 可以是空的,之后由调用方 `add(entry)` / `remove(projectId, { drain })`:
 *   - `add`:照构造时的同一条路接线(`connect`)、起节点;同一个 `projectId` 已经在就只更新它的 `members`;
 *   - `remove(projectId)`:让掉这个项目手里的认领(`task.release`)、停节点、调接线时给的 `close()`;
 *   - `remove(projectId, { drain: true })`:不再认领新的,手里的做完(持有与在飞都清空)才停、才关;
 *   - `setPaused(true)`:全部节点不再认领新任务,手里的照做(背压);
 *   - **产物到了容量上限**:某个任务以 `service-quota` 失败(素材服务回 507,`artifact-transfer.mjs`)时,全部节点暂停认领
 *     `QUOTA_PAUSE_MS`(10 分钟),发一条 `quota-paused` 事件;`quotaPausedUntil` 可查。那个任务是不可重试的失败;
 *   - **各项目轮流**(0.7.19 多项目模式,语义 `product/rendering.md`「渲染服务的两种模式」;`./multi-queue.mjs`):每一拍按
 *     「最久没轮到的项目先」推进,全局闸的空位先给它;一个项目发出一个认领就排到最后。原来的「有成员在线的项目优先」与多项目模式的
 *     「同一类里各项目轮流」冲突,取消;`members` / `setMembers` 照旧记着(诊断里看得到),不再影响先后。
 * 不带 `dynamic` 时这些方法照样在,行为与原来一致(成员表就是构造时那几项)。
 *
 * # 按项目「搁着不认领」(托管方渲染服务的用户卡隔离,`docs/plan/hosted-render-contract.md` 第 7.5 节)
 *
 * 接线时(`connect` 的返回值)可以多给两项:
 *   - `hold()`:回 true 时这个项目**一个任务也不认领**(连接、报到、看队列照常)。常驻工作进程对内容库里有 `card-source` 的项目
 *     这样搁着——它不执行任何项目带来的代码,这种项目整个交给隔离工作进程;隔离工作进程在卡片同步对完账之前也这样搁着;
 *   - `cards()`:回 `{ state: 'unknown' | 'none' | 'some', count }`,原样进诊断。
 * 给了 `hold` 的项目,诊断里另有 `pending`(此刻看得见、换一个带着卡片代码的工作进程就能认领的任务数——环境指纹、代码版本、
 * 能力都按本节点算,只是不看卡片代码身份、并当作有 `userCards`)与 `pendingKey`(这批任务 id 的摘要,变了说明来了新任务)。
 * `setLimit(n)`:运行中把并发压到 n(0～`maxConcurrent`;隔离工作进程在跑时管理进程把常驻的压低,两者合起来不超过上限)。
 * 都不给时行为与原来逐项相同。
 *
 * # 按项目「产不产轨道流」(托管方渲染服务的「生成轨道流」,`docs/plan/hosted-render-contract.md` 第 3.1 节;任务书「甲三」)
 *
 * 配置项(`add(entry)` 的 `entry`)带布尔的 `streams` 时,这个项目按它管:
 *   - `streams: false`:**不认领这个项目的任何轨道流任务**(既不认稀疏流也不认满密度流;快照任务、计划任务照常;连接照旧,手里已经认领的流任务照做完、不放回);
 *     诊断里的 `pending` / `claimable` 也不数流任务(不然管理进程会为没人做的流任务起隔离工作进程);
 *   - `streams: true`:照常认领。
 * 按的是**这条连接所属的项目**,不看任务里写的 `source.projectId`。`setStreams(projectId, bool)` 在运行中改(`reconcileHostProjects`
 * 每次对账照清单更新);接线时 `connect(entry, index, live)` 的第三个参数给 `live.streams()`(现读),调用方把它交给这个项目的执行器
 * (切分清单计划时出不出自己的那一份流)。配置项不带 `streams`(普通的独立渲染主机)时不按项目管,`live.streams()` 回 null,行为与原来逐项相同。
 *
 * 除 `loadHostConfig` 读一次配置文件外(经 `../auth/shared-config.mjs`),本模块不开计时器、不碰网络:
 * 端点、执行器、产物库都由调用方注入(预渲染进程里是 `vite-plugin-frames.ts` 的 `startHostNode`)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalNode, idleLockTakeover } from './local-node.mjs';
import { createRotation, orderByPolicy } from './multi-queue.mjs';
import { checkClaimable } from './filter.mjs';
import { isExportFramesTask } from './export-plan.mjs';
import { normalizeEntry, SHARED_CONFIG_ENV } from '../auth/shared-config.mjs';
import { localDeviceInfo } from '../auth/device.mjs';

/** 主机并发总数的上限(契约第 2 节) */
export const HOST_MAX_CONCURRENT = 4;
/** 环境变量覆盖配置里的并发数(`cloud/scripts/render-host.mjs --max-concurrent`) */
export const HOST_CONCURRENCY_ENV = 'PROMPTCUT_HOST_MAX_CONCURRENT';
/** 与 PC 节点相同的能力(契约第 3 节 `node.hello`) */
export const HOST_CAPABILITIES = Object.freeze({ userCards: true, graphCards: false });
/** 产物到了容量上限(任务以 `service-quota` 失败)后暂停认领多久(`docs/plan/hosted-render-contract.md` 第 6 节) */
export const QUOTA_PAUSE_MS = 10 * 60_000;

/**
 * 托管方渲染服务的工作进程报的能力位(`docs/plan/hosted-render-contract.md` 第 5、7.5 节),集中在这一处:
 *   - `userCards`:只有开着卡片同步的工作进程才报 true。常驻工作进程绝不同步任何项目的卡(它不执行项目带来的代码),报 false,
 *     要用户卡的任务它不认领;按项目隔离的工作进程(方案 A)开着同步,报 true;
 *   - `graphCards`:false。第二段(在线执行用户卡与素材效果卡)合流后由主会话对这一位;
 *   - 其余能力位(`streams`、`transcode`)按预渲染管线的实测值,不在这里改。
 * @param {object} base 预渲染管线实测出的能力(`nodeCapabilities`)
 * @param {{ cardSync: boolean }} o 这个工作进程开没开卡片同步
 *
 * 素材效果卡如实写:托管方的渲染节点**现在不渲素材效果卡**。预渲染管线里 PC 节点与独立渲染主机报的都是 `graphCards: false`
 * (`vite-plugin-frames.ts` 的 `nodeCapabilities`),切分时写了 `requires.graphCards: true` 的任务谁都不认领——
 * 这是现有规则,不是托管方这一侧的限制;隔离工作进程照此报 false。哪天独立渲染主机能渲素材效果卡了,这里跟着改一处即可。
 */
export function hostedRenderCapabilities(base, { cardSync }) {
  return { ...base, userCards: cardSync === true, graphCards: false };
}

function badHost(detail) {
  const err = new Error(`独立渲染主机配置:${detail}`);
  err.code = 'bad-host-config';
  return err;
}

/**
 * 校验并发数(契约第 2 节;集成裁定 2026-09-26,契约第 6 节):不给(undefined / null)是 1;1～4 的整数照收;
 * 其余一律是配置错误 `code: 'bad-host-config'` —— 超过 4 报错、不截断;0、负数、小数、字符串都报错。
 */
export function hostMaxConcurrent(value) {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw badHost('maxConcurrent 要是 1～4 的整数');
  if (value > HOST_MAX_CONCURRENT) throw badHost(`maxConcurrent 上限 ${HOST_MAX_CONCURRENT}(给了 ${value})`);
  return value;
}

/**
 * 解析主机配置(文件内容 JSON.parse 之后):一项或数组(M6a 契约第 11 节),每项规整见 `normalizeEntry`
 * (缺字段、格式不对、空数组抛 `code: 'bad-shared-config'`,错误信息里没有口令与 K)。
 * 主机只开 `render` 连接:某项给了 `role` 且不是 `render` 抛 `bad-host-config`。
 * `maxConcurrent` 可写在任意一项上,取各项最大值,缺省 1;任一项的值不合格(含超过 4)抛 `bad-host-config`。
 * @param {unknown} raw
 * @param {{ device?: { deviceId: string, deviceName: string } }} [options] 缺省设备信息(同 `normalizeEntry` 第二个参数)
 * @returns {{ entries: object[], maxConcurrent: number }}
 */
export function parseHostConfig(raw, { device } = {}) {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    const err = new Error(`${SHARED_CONFIG_ENV}:配置是空数组`);
    err.code = 'bad-shared-config';
    throw err;
  }
  const entries = list.map((item) => (device ? normalizeEntry(item, device) : normalizeEntry(item)));
  for (const [i, item] of list.entries()) {
    if (item.role !== undefined && item.role !== 'render') throw badHost(`第 ${i} 项的 role 要是 'render'(主机只开 render 连接)`);
  }
  const given = list.filter((item) => item.maxConcurrent !== undefined && item.maxConcurrent !== null).map((item) => hostMaxConcurrent(item.maxConcurrent));
  return { entries, maxConcurrent: given.length ? Math.max(...given) : 1 };
}

/**
 * 读主机配置:`PROMPTCUT_SHARED_CONFIG` 指的文件,内容见 `parseHostConfig`;读不了、不是 JSON 抛 `bad-shared-config`。
 * `PROMPTCUT_HOST_MAX_CONCURRENT`(`render-host --max-concurrent`)设了就优先,同样要 1～4 的整数,否则 `bad-host-config`。
 * 没设环境变量回 null。
 * @returns {null | { entries: object[], maxConcurrent: number }}
 */
export function loadHostConfig(env = process.env) {
  const file = env[SHARED_CONFIG_ENV];
  if (!file) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const e = new Error(`${SHARED_CONFIG_ENV}:读不了配置文件(${err?.code ?? 'bad-json'})`);
    e.code = 'bad-shared-config';
    throw e;
  }
  const parsed = parseHostConfig(raw, { device: localDeviceInfo(env) });
  const override = env[HOST_CONCURRENCY_ENV];
  if (override !== undefined && override !== '') {
    if (!/^\d+$/.test(String(override))) throw badHost(`${HOST_CONCURRENCY_ENV} 要是 1～4 的整数`);
    parsed.maxConcurrent = hostMaxConcurrent(Number(override));
  }
  return parsed;
}

/** `superseded`:执行器判这份内容已被新版本取代、报给队列作废的任务数(`render-queue-contract.md` J.15),不计入 `failed` */
/**
 * `completed` / `dedup` 只数**细任务**:渲完交付的、与产物库里已有而以去重方式交付的。`plans` 数做完的计划任务(切分并发布了细任务;
 * 托管方的渲染节点认领带片段清单的计划时走这里)。一个只切了计划、细任务都以去重方式交付的节点 `completed` 是 0,要看 `plans` 与 `dedup`。
 */
const emptyStats = () => ({ claimed: 0, completed: 0, dedup: 0, plans: 0, failed: 0, superseded: 0, lost: 0, discarded: 0, released: 0 });

/**
 * @param {object} options
 * @param {object[]} options.entries  规整过的配置项(`loadHostConfig().entries`),每项要有 `projectId`;`dynamic` 时可以为空
 * @param {boolean} [options.dynamic]  允许空的 `entries`,项目由 `add` / `remove` 在运行中增减
 * @param {(entry: object, index: number, live: { streams: () => boolean | null }) => { endpoint: object, executor: object, sink: object, close?: () => void }} options.connect
 *   每项调一次(第三个参数见文件头「按项目产不产轨道流」):到那个项目文档服务的 `render` 连接(`createWsEndpoint` 的形状;有 `onOpen` / `onClose` 就挂上,
 *   没有就当已连上),以及这个项目用的执行器与产物库
 * @param {(entry: object, index: number) => string} options.nodeIdOf  每个节点的 id
 * @param {string} options.envFingerprint
 * @param {string} options.codeVersion  一个主机实例只有一个代码版本(契约第 3 节〔裁〕)
 * @param {number} [options.maxConcurrent]  并发总数,缺省 1,上限 4
 * @param {object} [options.capabilities]  缺省 `HOST_CAPABILITIES`
 * @param {Record<string, string[]>} [options.cardSourceVersions]  本机此刻有的卡片代码身份(契约 B.2;c66-host-cards:
 *   任务的 `requires.cardSources` 按它过滤,本机没有这份代码就不认领)。可以是现取现算的视图(`card-code.mjs` 的 `view`),
 *   每一拍认领时读;缺省空(只认不要求卡片代码的任务)
 * @param {() => number} options.now
 * @param {() => number} [options.random]
 * @param {object} [options.constants]
 * @param {(event: object) => void} [options.onEvent]  local-node 的事件,多带 `projectId`、`index`
 */
export function createRenderHost({
  entries,
  connect,
  nodeIdOf,
  envFingerprint,
  codeVersion,
  maxConcurrent = 1,
  capabilities = HOST_CAPABILITIES,
  cardSourceVersions,
  now,
  random,
  constants,
  onEvent = () => {},
  dynamic = false,
}) {
  if (!Array.isArray(entries) || (entries.length === 0 && !dynamic)) throw new TypeError('createRenderHost:entries 至少一项');
  if (typeof connect !== 'function') throw new TypeError('createRenderHost:connect 必须是函数');
  const cap = hostMaxConcurrent(maxConcurrent);
  let version = codeVersion;
  let stopped = false;
  let started = false;
  let paused = false;
  let quotaUntil = 0;
  let nextIndex = 0;
  /** 运行中的并发上限(`setLimit`),不超过 `cap` */
  let limit = cap;
  /** 各项目轮流的记账(多项目模式;产流那一类):按接线时发的号记,摘掉的项目一并忘掉 */
  const rotation = createRotation();

  const emit = (event) => { try { onEvent(event); } catch { /* 诊断回调出错不影响节点 */ } };

  /** 任务 id 的前缀就是 kind(`snapshot:` / `stream:` / `plan:`) */
  const kindOfId = (id) => (typeof id === 'string' ? id.slice(0, id.indexOf(':')) : null);

  /** 闲时认领(见文件头):这个任务要用的串行 lane 此刻空不空 */
  function laneFree(m, task) {
    const ex = m.executor;
    if (typeof ex?.laneOf !== 'function') return true;
    const lane = ex.laneOf(task);
    if (lane === null || lane === undefined) return true;
    if (typeof ex.laneBusy === 'function' && ex.laneBusy() > 0) return false;
    for (const x of members) {
      const laneOfX = (t) => (typeof x.executor?.laneOf === 'function' ? x.executor.laneOf(t) : null);
      if (x.inflight !== null && laneOfX({ kind: kindOfId(x.inflight) }) === lane) return false;
      for (const run of x.local?.occupying?.() ?? []) if (laneOfX(run) === lane) return false;
    }
    return true;
  }

  /** 配置项里的 `streams`:布尔才按项目管,别的值(没给)是 null */
  const streamsOf = (entry) => (typeof entry?.streams === 'boolean' ? entry.streams : null);
  /**
   * 这个项目的这个任务过不过「生成轨道流」这一道：关着时（m.streams === false）托管方渲染节点什么轨道流都不产
   * （既不产稀疏流也不产满密度流；只留 Agent 查帧 see_frames/get_gif/get_layout）。
   * 开着时稀疏流与满密度流都产。
   */
  // 导出专用的逐帧位图任务(`../export-frames.mjs`;种类也是流任务)不是轨道流,不归这一项管:这一项关着的项目照样能导出
  const streamsPass = (m, task) => task?.kind !== 'stream' || m.streams !== false || isExportFramesTask(task);

  /** 这个项目此刻是不是搁着不认领(见文件头);判不出来按搁着算 */
  const held = (m) => {
    if (!m.hold) return false;
    try { return m.hold() !== false; } catch { return true; }
  };

  /**
   * 搁着的项目里,换一个带着卡片代码的工作进程就能认领的任务:按本节点的环境指纹、代码版本、能力过滤,
   * 只是不看卡片代码身份(`requires.cardSources`)、并当作有 `userCards`。回 `{ pending, pendingKey, claimable }`(`claimable` 是按本节点手里真有的卡片代码、此刻就能认领的数)。
   */
  function pendingOf(m) {
    let tasks = [];
    try { tasks = m.local?.session.known?.() ?? []; } catch { tasks = []; }
    const node = { nodeId: m.nodeId, profile: 'host', envFingerprint, codeVersions: [version], capabilities: { ...capabilities, userCards: true }, maxConcurrent: cap };
    const mine = { ...node, capabilities, ...(cardSourceVersions ? { cardSourceVersions } : {}) };
    const ids = [];
    let claimable = 0;
    for (const task of tasks) {
      // 这个项目不产轨道流:它的流任务谁也不会来做,不算「等着的」(见文件头)
      if (!streamsPass(m, task)) continue;
      const { cardSources: _ignored, ...requires } = task?.requires ?? {};
      if (checkClaimable({ ...task, requires }, node).ok) ids.push(String(task.id));
      // 按本节点手里真有的卡片代码算:此刻就能认领的(隔离工作进程据此判「还有没有活」)
      if (checkClaimable(task, mine).ok) claimable += 1;
    }
    ids.sort();
    return { pending: ids.length, pendingKey: ids.length ? createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16) : '', claimable };
  }

  /** 全部节点的持有数 + 在飞的认领数 */
  const busy = () => members.reduce((n, m) => n + (m.local ? m.local.session.held().length : 0) + (m.inflight !== null ? 1 : 0), 0);

  /** @type {any[]} 现有的项目;运行中 `add` 追加、`remove` 摘掉。`index` 是接线时发的号,摘掉后不复用 */
  const members = [];
  function wire(entry) {
    const index = nextIndex++;
    /** 这个项目产不产轨道流(`null` 不按项目管);先于接线建好,接线时把现读的口子交出去 */
    const live = { streams: streamsOf(entry) };
    const wired = connect(entry, index, { streams: () => live.streams });
    const endpoint = wired?.endpoint;
    if (!endpoint || typeof endpoint.send !== 'function' || typeof endpoint.onMessage !== 'function') {
      throw new TypeError(`createRenderHost:第 ${index} 项的 endpoint 不对`);
    }
    const m = {
      index,
      projectId: entry.projectId ?? null,
      nodeId: nodeIdOf ? nodeIdOf(entry, index) : `host-${index}`,
      endpoint,
      executor: wired.executor,
      sink: wired.sink,
      local: null,
      inflight: null,
      started: false,
      stats: emptyStats(),
      seen: new Set(),
      close: typeof wired.close === 'function' ? wired.close : null,
      hold: typeof wired.hold === 'function' ? wired.hold : null,
      cards: typeof wired.cards === 'function' ? wired.cards : null,
      prefer: entry.members === true,
      draining: false,
      removed: false,
      get streams() { return live.streams; },
      set streams(value) { live.streams = value; },
    };
    // 包一层 send:记在飞的认领、放回数
    m.ep = {
      send(message) {
        if (message?.type === 'task.claim') m.inflight = message.id;
        else if (message?.type === 'node.hello') m.inflight = null;
        else if (message?.type === 'task.release') m.stats.released++;
        return endpoint.send(message);
      },
      onMessage: (handler) => endpoint.onMessage(handler),
    };
    endpoint.onMessage((message) => {
      switch (message?.type) {
        case 'task.claimed':
          m.stats.claimed++;
          if (m.inflight === message.id) m.inflight = null;
          break;
        case 'task.claim-rejected':
          if (m.inflight === message.id) m.inflight = null;
          break;
        case 'error':
          if (message.reqId === undefined) m.inflight = null;
          break;
        case 'task.opened':
          if (message.task?.id != null) m.seen.add(message.task.id);
          break;
        case 'queue.snapshot':
          for (const task of message.tasks ?? []) if (task?.id != null) m.seen.add(task.id);
          break;
        default:
          break;
      }
    });
    if (typeof endpoint.onOpen === 'function') endpoint.onOpen(() => open(m));
    if (typeof endpoint.onClose === 'function') endpoint.onClose(() => { m.started = false; m.inflight = null; });
    members.push(m);
    return m;
  }
  for (const entry of entries) wire(entry);

  /** 摘掉一个项目:停节点、从成员表拿掉、调接线时给的 close */
  function detach(m, reason) {
    if (m.removed) return;
    m.removed = true;
    try { m.local?.stop(); } catch { /* 已停 */ }
    m.started = false;
    const i = members.indexOf(m);
    if (i >= 0) members.splice(i, 1);
    rotation.forget(String(m.index));
    try { m.close?.(); } catch { /* 已关 */ }
    emit({ type: 'project-removed', projectId: m.projectId, index: m.index, reason });
  }

  function build(m) {
    m.local?.stop();
    m.local = createLocalNode({
      nodeId: m.nodeId,
      node: { profile: 'host', envFingerprint, codeVersions: [version], capabilities, maxConcurrent: cap, ...(cardSourceVersions ? { cardSourceVersions } : {}) },
      endpoint: m.ep,
      now,
      ...(random ? { random } : {}),
      ...(constants ? { constants } : {}),
      isIdle: () => !paused && now() >= quotaUntil && !m.draining && busy() < limit && !held(m),
      canClaim: (task) => streamsPass(m, task) && laneFree(m, task),
      maxConcurrent: cap,
      codeVersion: version,
      executor: m.executor,
      sink: m.sink,
      // M7 D2:队列锁的锁定方闲置严格超 30 s、这张卡又没做完,切分时带 takeover 按本主机的指纹接手整张卡
      takeoverLocked: idleLockTakeover,
      onEvent: (event) => {
        const type = event?.type;
        if (type === 'completed') m.stats.completed++;
        else if (type === 'dedup') m.stats.dedup++;
        else if (type === 'plan-split') m.stats.plans++;
        else if (type === 'failed') {
          m.stats.failed++;
          if (event.error === 'service-quota') {
            quotaUntil = now() + QUOTA_PAUSE_MS;
            emit({ type: 'quota-paused', until: quotaUntil, id: event.id, projectId: m.projectId, index: m.index });
          }
        }
        else if (type === 'superseded') m.stats.superseded++;
        else if (type === 'lost') m.stats.lost++;
        else if (type === 'discarded') m.stats.discarded++;
        emit({ ...event, projectId: m.projectId, index: m.index });
      },
    });
  }

  /** (重)连上就报到,接续本实例仍持有的认领(G.7 约定写法) */
  function open(m) {
    if (stopped || !m.local || m.removed) return;
    m.inflight = null;
    m.local.start(m.local.session.held().map(({ id, token }) => ({ id, token })));
    m.started = true;
  }

  return {
    /** 起全部节点;已经连上的(或没有连接状态的,如进程内环回)立即报到 */
    start() {
      stopped = false;
      started = true;
      for (const m of members) {
        build(m);
        if (m.endpoint.connected === true || (typeof m.endpoint.onOpen !== 'function' && m.endpoint.closed !== true)) open(m);
      }
    },
    /**
     * 一拍:逐个节点续约、认领。各项目轮流:最久没轮到的项目先推进(全局闸的空位先给它),这一拍发出认领的项目排到最后;
     * 排空中的项目做完就摘掉
     */
    tick() {
      if (stopped) return;
      const order = orderByPolicy(members.map((m) => ({ m, projectId: String(m.index), kind: 'stream', seq: m.index })), rotation).map((x) => x.m);
      for (const m of order) {
        if (m.removed) continue;
        const before = m.inflight;
        if (m.started && m.local) m.local.tick();
        if (m.inflight !== null && m.inflight !== before) rotation.served('stream', String(m.index));
        if (m.draining && m.inflight === null && (m.local ? m.local.session.held().length : 0) === 0 && (m.local?.running?.().length ?? 0) === 0) detach(m, 'drained');
      }
    },
    /**
     * 运行中加一个项目(`entry.projectId` 必须有;`entry.members` 表示此刻有成员在线)。已经在的只更新 `members`、取消排空。
     * 回 true = 新加的。
     */
    add(entry) {
      if (stopped && started) return false;
      const existing = members.find((m) => m.projectId === entry?.projectId);
      if (existing) {
        existing.prefer = entry.members === true;
        existing.draining = false;
        if (streamsOf(entry) !== null) existing.streams = entry.streams;
        return false;
      }
      const m = wire(entry);
      if (started) {
        build(m);
        if (m.endpoint.connected === true || (typeof m.endpoint.onOpen !== 'function' && m.endpoint.closed !== true)) open(m);
      }
      return true;
    },
    /**
     * 运行中摘掉一个项目。缺省:让掉它手里的认领(`task.release`)后立即停、关;`drain: true`:不再认领新的,手里的做完再停、再关。
     * 回让掉的条数(排空时是 0);没有这个项目回 -1。
     */
    remove(projectId, { drain = false, reason = 'removed' } = {}) {
      const m = members.find((x) => x.projectId === projectId);
      if (!m) return -1;
      if (drain) {
        m.draining = true;
        return 0;
      }
      let released = 0;
      try { released = m.local?.yieldAll(reason) ?? 0; } catch { /* 连接坏了:队列按断线回收 */ }
      detach(m, reason);
      return released;
    },
    /** 这个项目此刻有没有成员在线(有的优先) */
    setMembers(projectId, online) {
      const m = members.find((x) => x.projectId === projectId);
      if (m) m.prefer = online === true;
    },
    /** 这个项目产不产轨道流(见文件头):只认布尔;改成不产不放回手里的认领,只是不再认领新的流任务 */
    setStreams(projectId, value) {
      const m = members.find((x) => x.projectId === projectId);
      if (m && typeof value === 'boolean') m.streams = value;
    },
    /** 背压:暂停认领新任务,手里的照做 */
    setPaused(value) { paused = value === true; },
    get paused() { return paused; },
    /** 运行中把并发压到 n(0～maxConcurrent);不是这个范围里的整数就恢复成 maxConcurrent。手里已有的照做 */
    setLimit(n) { limit = Number.isInteger(n) && n >= 0 && n <= cap ? n : cap; },
    get limit() { return limit; },
    /** 因产物容量上限暂停认领到什么时刻(毫秒时间戳);没在暂停回 null */
    get quotaPausedUntil() { return now() < quotaUntil ? quotaUntil : null; },
    /** 现有项目的 projectId(含排空中的) */
    projects: () => members.map((m) => m.projectId),
    /** 代码版本变了:全部让掉、按新版本重新报到 */
    setCodeVersion(next) {
      if (next === version) return false;
      version = next;
      for (const m of members) {
        try { m.local?.yieldAll('code-changed'); } catch { /* 连接坏了 */ }
        build(m);
        if (m.started) { m.started = false; open(m); }
      }
      return true;
    },
    /** 退出:让掉全部认领、停节点。回让掉的条数 */
    shutdown(reason = 'shutdown') {
      let released = 0;
      for (const m of members) {
        try { released += m.local?.yieldAll(reason) ?? 0; } catch { /* 连接坏了:队列按断线回收 */ }
        try { m.local?.stop(); } catch { /* 已停 */ }
        m.started = false;
      }
      stopped = true;
      return released;
    },
    /** 还没落定的执行(`shutdown` 之后等它们收尾) */
    async settled() { await Promise.all(members.map((m) => m.local?.settled())); },
    running: () => members.flatMap((m) => m.local?.running() ?? []),
    busy,
    get maxConcurrent() { return cap; },
    get codeVersion() { return version; },
    /** 契约第 3 节「诊断」的 `nodes` 一项一个节点 */
    nodes() {
      return members.map((m) => ({
        projectId: m.projectId,
        index: m.index,
        prefer: m.prefer,
        draining: m.draining,
        nodeId: m.nodeId,
        connected: m.endpoint.connected === true || (m.endpoint.connected === undefined && m.endpoint.closed !== true),
        claimed: m.stats.claimed,
        completed: m.stats.completed,
        dedup: m.stats.dedup,
        plans: m.stats.plans,
        failed: m.stats.failed,
        superseded: m.stats.superseded,
        lost: m.stats.lost,
        discarded: m.stats.discarded,
        released: m.stats.released,
        seen: m.seen.size,
        watching: m.local?.session.watching?.() ?? [],
        held: m.local ? m.local.session.held().map(({ id }) => id) : [],
        running: m.local ? m.local.running() : [],
        ...(m.streams !== null ? { streams: m.streams } : {}),
        ...(m.hold ? { hold: held(m), ...pendingOf(m) } : {}),
        ...(m.cards ? { cards: (() => { try { return m.cards(); } catch { return { state: 'unknown', count: 0 }; } })() } : {}),
        ...(typeof m.endpoint.stats === 'function' ? { transport: m.endpoint.stats() } : {}),
      }));
    },
  };
}

/** `cloud/scripts/render-host.mjs` 的命令行参数(契约第 2 节);放在这里是因为 `server/**` 不许引 `scripts/`(单测要用) */
export function renderHostArgs(argv) {
  const opts = { port: 5400, config: null, data: null, maxConcurrent: null, streams: false, verbose: false, cwd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} 要跟一个值`); return v; };
    if (a === '--port') opts.port = Number(next());
    else if (a === '--config') opts.config = next();
    else if (a === '--data') opts.data = next();
    else if (a === '--max-concurrent') opts.maxConcurrent = Number(next());
    else if (a === '--streams') opts.streams = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--cwd') opts.cwd = next();
    else throw new Error(`不认识的参数 ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65533) throw new Error('--port 不对');
  if (opts.maxConcurrent !== null && !(Number.isInteger(opts.maxConcurrent) && opts.maxConcurrent >= 1 && opts.maxConcurrent <= 4)) {
    throw new Error('--max-concurrent 要是 1～4 的整数');
  }
  return opts;
}

/** `cloud/scripts/render-host.mjs` 给编辑器子进程设的环境变量(契约第 2 节) */
export function renderHostEnv(base, { config, data, streams, maxConcurrent }) {
  const env = { ...base };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_PUSH', 'PROMPTCUT_ROLE']) delete env[key];
  const tmp = path.join(data, 'tmp');
  // 代理模式(托管方的渲染节点):没有配置文件,项目清单与票据向管理进程要(`PROMPTCUT_RENDER_BROKER`)
  if (config) env.PROMPTCUT_SHARED_CONFIG = path.resolve(config);
  else delete env.PROMPTCUT_SHARED_CONFIG;
  Object.assign(env, {
    PROMPTCUT_QUEUE_NODE: '1',
    PROMPTCUT_NODE_PROFILE: 'host',
    PROMPTCUT_STREAMS: streams ? '1' : '0',
    PROMPTCUT_EXPORT_DIR: data,
    PROMPTCUT_DATA_DIR: path.join(data, 'data'),
    TEMP: tmp, TMP: tmp, TMPDIR: tmp,
  });
  if (maxConcurrent !== null && maxConcurrent !== undefined) env.PROMPTCUT_HOST_MAX_CONCURRENT = String(maxConcurrent);
  else delete env.PROMPTCUT_HOST_MAX_CONCURRENT;
  return env;
}

/** 代理模式的两个环境变量(`docs/plan/hosted-render-contract.md` 第 7.1 节):管理进程的本机代理口与这次启动的口令 */
export const BROKER_URL_ENV = 'PROMPTCUT_RENDER_BROKER';
export const BROKER_KEY_ENV = 'PROMPTCUT_RENDER_BROKER_KEY';

/**
 * 代理模式的客户端:工作进程向管理进程要「现在该连哪些项目」与连接票据。工作进程里没有服务私钥,也没有任何项目的口令。
 *   projects() → { docUrl, paused, projects: [{ projectId, members, drain, nodeId }] }
 *   ticket(projectId) → 连接票据(字符串);要不到抛错
 * @param {{ url: string, key: string, fetch?: typeof globalThis.fetch, timeoutMs?: number }} options
 */
export function createBrokerClient({ url, key, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  const base = String(url).replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  async function call(pathname, init = {}) {
    const res = await fetchImpl(`${base}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    if (res.status !== 200 || !body || body.ok !== true) {
      const err = new Error(`渲染代理口 ${pathname}:${res.status} ${body?.error ?? ''}`.trim());
      err.code = body?.error ?? `http-${res.status}`;
      throw err;
    }
    return body;
  }
  return {
    projects: () => call('/projects'),
    async ticket(projectId) { return (await call('/ticket', { method: 'POST', body: JSON.stringify({ projectId }) })).ticket; },
    /** 工作进程把自己的诊断交给管理进程(它不用反过来请求工作进程) */
    report: (body) => call('/report', { method: 'POST', body: JSON.stringify(body) }).catch(() => null),
  };
}

/**
 * 按代理口给的清单对账:该加的 `add`,不在清单里的 `remove`,清单里标了 `drain` 的排空,`members`、`streams`(这个项目产不产轨道流)与 `paused` 跟着改。
 * 纯编排,不碰网络;回 `{ added, removed, drained }`(projectId 列表)。
 * @param {ReturnType<typeof createRenderHost>} host
 * @param {{ paused?: boolean, projects: { projectId: string, members?: boolean, drain?: boolean }[] }} listing
 * @param {(item: object) => object} entryOf  清单项 → `add` 用的配置项
 */
export function reconcileHostProjects(host, listing, entryOf) {
  const want = new Map((listing?.projects ?? []).map((p) => [p.projectId, p]));
  const out = { added: [], removed: [], drained: [] };
  host.setPaused(listing?.paused === true);
  // 清单没给 `limit`(旧的管理进程、测试替身)就是不压:恢复成 maxConcurrent
  host.setLimit?.(Number.isInteger(listing?.limit) ? listing.limit : null);
  for (const projectId of host.projects()) {
    if (want.has(projectId)) continue;
    host.remove(projectId, { reason: 'not-listed' });
    out.removed.push(projectId);
  }
  for (const [projectId, item] of want) {
    if (item.drain === true) {
      if (host.remove(projectId, { drain: true }) === 0) out.drained.push(projectId);
      continue;
    }
    // 已经在的项目:`add` 照这份配置项更新 `members` 与 `streams`(创建者开、关「生成轨道流」后清单变了,这里一拍之内跟上)
    if (host.add(entryOf(item))) out.added.push(projectId);
    else host.setMembers(projectId, item.members === true);
  }
  return out;
}

/**
 * 素材回退(J.6)按基址挑票据:素材票据只在签发它的素材服务上有效,主机加入的项目分属不同素材服务时,
 * 读哪台的回退就要用那台所属项目的票据(M6b 集成修的遗留:原来只用第一个项目的票据,读第二台会 401)。
 * 交给 `asset-client.ts` 的 `setMediaFallbackTicket`,它每试一个回退基址调一次。
 * @param {Array<{ base: () => string | null, ticket: () => Promise<string | null> }>} records  每个项目一项,顺序同配置
 * @returns {(base: string) => Promise<string | null> | null}  基址不属于任何项目时回 null(不带票据)
 */
export function fallbackTicketFor(records) {
  const norm = (b) => String(b ?? '').trim().replace(/\/+$/, '');
  return (base) => {
    const want = norm(base);
    const rec = records.find((r) => {
      const b = r.base();
      return !!b && norm(b) === want;
    });
    return rec ? rec.ticket() : null;
  };
}
