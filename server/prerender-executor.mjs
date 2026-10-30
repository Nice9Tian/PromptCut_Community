/**
 * 渲染任务队列的真实执行器(契约 `docs/plan/render-queue-contract.md` J.4,设计附件 `docs/plan/queue-executor-design.md`
 * 第 1～3 节)。实现 D.1 的 `executor` 接口,交给 `render-node/local-node.mjs` 的 `createLocalNode`。
 *
 * 这是一层很薄的适配:真正的活在 `FramePipeline` 的新方法里(`planForQueue`、`renderCardSnapshotRange`、
 * `renderSceneSnapshotRange`,都走 `'queue'` lane),没有调用它们时 preload 的路径不变。它不能放进
 * `server/render-node/`:那个目录受 D1 守门,只许 Node 内置模块,而这里要引管线。
 *
 *   plan(planTask)   按 `source.projectId@projectRev` 从文档服务取项目快照(`projects.get`,取不到抛
 *                    `no-snapshot`,可重试),`prepareProject` 之后交给 `pipeline.planForQueue`,回 PlanContext
 *                    (`streams`:本机能产轨道流时是这一版的全部流,否则为空 —— M6c X1)。结果按版本缓存
 *                    (LRU 约 4 条),`render` 复用。
 *   render(task)     快照任务:共享档 `renderCardSnapshotRange`,本地档 `renderSceneSnapshotRange`。
 *                    先把任务对回这一版的 control(附件第 3 节「把任务对回 control」),任何一项对不上抛
 *                    `plan-mismatch`(不可重试)。
 *                    流任务(M6c X1):对回这一版的流(内容键、结果键、分段范围),交给 `renderStreamRange` 按段产出;
 *                    对不上同样抛 `plan-mismatch`;本机不能产流(开关关着、没有编码器)抛 `no-streams`(不可重试)。
 *                    清单计划切出的流任务(任务书「甲三」:切分方自己的那一份)在这一版的流里找不到时,按任务的片段现算它的单卡流再对
 *                    (清单是发布方判的,本机没判重的卡不在本机这一版的流里)。
 *                    托管方的渲染节点按项目的「生成轨道流」产流(任务书「甲三」):调用方给 `streamsEnabled`(这个执行器所属的项目此刻产不产,
 *                    `render-node/host.mjs` 文件头「按项目产不产轨道流」)时,带片段清单的计划切分前看它 —— 不产就不出切分方自己的那一份流
 *                    (`context.ownListStreams`)。认领流任务的闸不在这里,在主机的认领闸上(同一个量)。桌面应用与普通的独立渲染主机不给,不按项目管。
 *                    回 `null`:产物在帧库 / 流库里,sink 自己读(`collectSnapshotResult` / `collectStreamResult`)。
 *                    共享档卡在本机快照库里记过超限帧(`index.json` 的 `oversize`,R6-14)的,交给切分的 control 标
 *                    `snapshotOversize: true`(见 `markSnapshotOversize`),切分据此不给纯浏览器另出一份(M7 契约第 13 节
 *                    「探针之后的更正」第 6 条;`claude/queue-maint` 任务 E)。
 *   afterSplit(planTask, { tasks })  (M7 契约 D12)local-node 切分完成、发布回包都回来之后调:按最终发布成功的细任务
 *                    记下每张卡实际出键的指纹(`pipeline.recordSplitCandidates`),带片段清单的 plan 再写一次这一版的层表 v 3
 *                    (候选按实际出键;独立渲染主机用 `publishLayerMap` 选项写,PC 用管线自己的推送队列写)。层表只在切分完成后写,
 *                    不再在切分之前按本机视图写(D12 的时机)。
 *
 * 诊断(`docs/archive/agent-reports/AGENT-stall-phases.md`):`render` 经 runner 给的 `phase(name, fields)` 报它此刻在哪一步 ——
 * `project`(取项目快照、算这一版的计划)、`lane`(交给管线了、这一段的第一批还没交;`ahead` 是当时这条管线上
 * 已经在跑的 `'queue'` lane 工作数,大于 0 就是在排队)、`frames`(在出批)、`finish`(帧都交了,在收尾:补小尺寸、换页)。
 *
 * # 项目往前走了(契约 `docs/plan/render-queue-contract.md` J.15)
 *
 * 细任务的结果按内容寻址,任务里的 `source.projectRev` 只是「去哪一版取输入」的线索。有真身的项目(共享项目)文档服务只给得出
 * 当前这一版:发布之后项目又被改过,旧版本就取不到了。这不算失败——
 *   - 取不到任务指的那一版、文档服务回了当前版本号(`projects.locate` 的 `currentRev`):改按当前版本算(必要时一路追到最新);
 *   - 带片段清单的计划与它切出的细任务另加一条:本执行器已经算过这个项目更新的一版,就不再用旧的那一版,直接对着新的核
 *     (旧版本的画面没人要了,不为它白渲;层表也不会被迟到的旧计划写回旧版本);
 *   - 计划任务:按实际取到的那一版切,回的上下文带 `actualRev`,切分方把它写进细任务的 `source.projectRev`;
 *   - 细任务:在实际那一版里按片段与内容键对回 control。内容没变的照做(产物与原来那一版的逐字节相同);片段没了、或内容键
 *     换了,说明这份内容已经被新版本取代,抛 `superseded`(`error.superseded === true`、不可重试),由 runner 报给队列作废,
 *     不记失败。
 * 没有真身的项目(每一版都有上传的快照)文档服务不回 `currentRev`,行为与原来相同。
 *
 * M6c 起执行器不再有 `isIdle()`(J.4 原有):PC 节点的闲时门槛改为 `queue-idle.mjs`(X5),独立渲染主机本来就
 * 只看全局并发闸,这个判据已经没人用(集成裁定,`docs/plan/m6c-contract.md`「集成时的裁定」)。
 */
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { snapshotTier } from './snapshot-tier.mjs';
import { isListPlan, CLIPS_KEY_MARK, BACKFILL_KEY_MARK, isSparseStreamTask, STREAM_DENSITY_SPARSE } from './render-queue/index.mjs';
import { splitCandidatesOf, splitStreamCandidatesOf, streamCandidateKey } from './artifact-transfer.mjs';
import { isExportFramesTask, isExportOnlyPlan } from './render-node/export-plan.mjs';

/** `cardLocks`(Map、普通对象或缺省)→ `(lockKey) => 锁指纹 | null`(同 `split.mjs` 的读法) */
function lockReader(cardLocks) {
  const fp = value => (typeof value === 'string' && value !== '' ? value : null);
  if (cardLocks == null) return () => null;
  if (typeof cardLocks.get === 'function') return key => fp(cardLocks.get(key));
  if (typeof cardLocks === 'object') return key => (Object.prototype.hasOwnProperty.call(cardLocks, key) ? fp(cardLocks[key]) : null);
  return () => null;
}

/**
 * 按本机快照库给共享档卡标 `snapshotOversize`(`claude/queue-maint` 任务 E):这张卡在本机快照库里有超限帧的记录
 * (`index.json` 的 `oversize` 非空;本机渲过它时 A3c 判超限记下的,或从素材服务拉回它的清单时同样判出来的)就标。
 * 看两个键:本机指纹的键(`control.snapshotKey`),以及这张卡锁在别的环境上时锁定方指纹的键(`cardLocks`)。
 * 标在整张卡上,不按段:一张卡的快照只出自一种环境(卡片级指纹锁),浏览器认领其中一段就锁住整张卡,
 * 超限的那几段它做了也是白做、别的环境又被锁挡住 —— 所以有一帧超限,整张卡都不给浏览器。
 * 本地档不看(纯浏览器只做共享档);画布卡不看(切分本来就不给浏览器)。回新的 cardPlan 数组(标了的 control 是新对象,
 * 缓存里的上下文不动),没有要标的回原数组。读不到快照库(测试替身、库坏了)一律当没有记录。
 */
export async function markSnapshotOversize(pipeline, context) {
  const cardPlan = Array.isArray(context?.cardPlan) ? context.cardPlan : [];
  let store = null;
  try { store = typeof pipeline?.snapshots === 'function' ? pipeline.snapshots() : null; } catch { store = null; }
  if (!store || typeof store.snapshotIndex !== 'function') return { cardPlan, marked: [] };
  const lockOf = lockReader(context?.cardLocks);
  const marked = [];
  const out = [];
  for (const control of cardPlan) {
    const tier = control?.tier || snapshotTier(control?.capabilities);
    if (!control || control.snapshotOversize === true || tier !== 'shared' || !control.contentKey || control.capabilities?.canvasHeavy === true) {
      out.push(control);
      continue;
    }
    const keys = new Set([control.snapshotKey]);
    const locked = lockOf(`snapshot:${control.contentKey}`);
    if (locked) keys.add(resultKeyOf(control.contentKey, locked));
    let over = false;
    for (const key of keys) {
      if (typeof key !== 'string' || !key) continue;
      try {
        const index = await store.snapshotIndex({ tier: 'shared', key });
        if (Array.isArray(index?.oversize) && index.oversize.length > 0) { over = true; break; }
      } catch { /* 读不到当没有记录 */ }
    }
    if (over) { marked.push(control.clipId); out.push({ ...control, snapshotOversize: true }); } else out.push(control);
  }
  return { cardPlan: marked.length ? out : cardPlan, marked };
}

/** 清单计划写着「页面看到『生成轨道流』开着」而本机还没看到时,最多等多久、多久看一眼(三级数字;本机每秒向管理进程对一次账) */
export const STREAMS_SETTLE_MS = 4000;
const STREAMS_SETTLE_POLL_MS = 100;

/** 按版本缓存的上下文条数(附件第 3 节:LRU 约 4 条) */
export const PLAN_CACHE_SIZE = 4;

const fail = (code, message, retryable) => Object.assign(new Error(message), { code, retryable });

/** 追当前版本最多追几跳(每一跳都是文档服务回的更新的版本号;项目在取的那一瞬间又变了才会多跳) */
export const DRIFT_MAX_HOPS = 8;
/** 作废的任务报给队列的 error:队列按它认「这份结果当时不要了」(`render-queue/queue.mjs` 的 `isSuperseded`) */
export const SUPERSEDED = 'superseded';
const superseded = (detail) => Object.assign(new Error(SUPERSEDED), { code: SUPERSEDED, superseded: true, retryable: false, detail });

/** 带片段清单的计划,或它切出的细任务(看 `source.derivedFrom` 指的计划 id) */
export function isListWork(task) {
  if (isListPlan(task)) return true;
  const from = task?.source?.derivedFrom;
  return typeof from === 'string' && (from.includes(CLIPS_KEY_MARK) || from.includes(BACKFILL_KEY_MARK));
}

/**
 * 每条管线上经执行器交给 `'queue'` lane 的工作(快照的一段、plan 的取计划):管线 → 在跑的个数。
 * lane 是串行的(`FramePipeline.runQueueTask`),同一条管线由主机的几个项目节点的执行器共用,所以记在模块里、按管线分。
 * 只计数,不排队、不改管线的行为。
 */
const laneWork = new WeakMap();
async function onLane(pipeline, work) {
  laneWork.set(pipeline, (laneWork.get(pipeline) ?? 0) + 1);
  try { return await work(); }
  finally { laneWork.set(pipeline, Math.max(0, (laneWork.get(pipeline) ?? 1) - 1)); }
}
/** 这条管线上此刻经执行器交给 `'queue'` lane、还没落定的工作数 */
export function laneBusy(pipeline) {
  return laneWork.get(pipeline) ?? 0;
}

/**
 * @param {object} options
 * @param {import('./frame-pipeline.mjs').FramePipeline} options.pipeline
 * @param {{ get(projectId: string, projectRev: number): Promise<object | null> }} options.projects  J.2 的项目客户端
 * @param {(project: any) => any} [options.prepareProject]  缺省原样;预渲染进程传 `renderProject`
 * @param {(event: string, fields?: object) => void} [options.log]
 * @param {(entry: object) => void} [options.publishLayerMap]  认下带片段清单的 plan 之后写层表(C10 契约第 18 节第 9 条):
 *   独立渲染主机没有推送队列,管线自己的 `publishLayerMap` 写不出去,由主机按这条连接的内容库写;PC 节点不给(照旧由推送队列写)
 * @param {() => unknown} [options.codeStamp]  卡片代码的版次(c66-host-cards:`card-code.mjs` 的 `epoch`)。缓存按
 *   「项目版本 + 版次」存:卡片代码变了(同步装上了新卡),同一版项目的上下文要按新代码重算,不然任务对回的还是旧的 control
 * @param {null | (() => boolean)} [options.streamsEnabled]
 *   这个执行器所属的项目此刻产不产轨道流(任务书「甲三」;现读)。托管方渲染服务的工作进程按项目给(`vite-plugin-frames.ts` 的 `startHostNode`);
 *   缺省 null —— 不按项目管,本机能产就产(桌面应用、普通的独立渲染主机)
 * @param {number} [options.streamsSettleMs]  清单计划写着「页面看到这一项开着」(`input.streams`)而本机还没看到时,最多等这么久(见 `plan`)
 * @param {(ms: number) => Promise<void>} [options.sleep]  测试用
 */
export function createPrerenderExecutor({ pipeline, projects, prepareProject = project => project, log = () => {}, codeStamp = () => '', publishLayerMap = null,
  streamsEnabled = null, streamsSettleMs = STREAMS_SETTLE_MS, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!pipeline) throw new Error('createPrerenderExecutor needs a pipeline');
  if (!projects || typeof projects.get !== 'function') throw new Error('createPrerenderExecutor needs a project client');
  /** 按不按项目管 */
  const perProject = typeof streamsEnabled === 'function';
  /** 这个项目此刻产不产流;不按项目管时恒为真。问的那一头出错按不产算 */
  const streamsOn = () => {
    if (!perProject) return true;
    try { return streamsEnabled() === true; } catch { return false; }
  };
  /**
   * 创建者刚打开「生成轨道流」的那一下:在线页面看到开了就重发清单计划(结果键带这一项,`render-queue/messages.mjs` 的 `clipsPlanTaskOf`),
   * 本机从管理进程的清单里看到开了要晚一拍(一秒以内)。计划先到的话,照本机手里的「关着」切就漏掉自己的那一份流,而这一版的计划做完了不会再切。
   * 所以计划写着 `input.streams: true`、本机还是关着时等一等,等到本机也看到开了、或等满 `streamsSettleMs` 为止。
   * 页面写的这一项只决定「要不要等」,产不产仍只看本机从目录来的那一项(页面自报的不作数)。
   */
  const streamsSettled = async (planTask, signal) => {
    if (streamsOn() || planTask?.input?.streams !== true) return streamsOn();
    const until = Date.now() + Math.max(0, streamsSettleMs);
    while (!streamsOn() && Date.now() < until && !signal?.aborted) await sleep(STREAMS_SETTLE_POLL_MS);
    return streamsOn();
  };
  /** `projectId@projectRev` → Promise<{ entry, context }>;Map 的插入顺序就是 LRU 顺序 */
  const cache = new Map();
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志出错不影响执行 */ } };
  /** 同 `say`;`render` 里的 `say` 被阶段回调遮住了,那里用这个名字记日志 */
  const note = say;

  const versionOf = task => {
    const projectId = task?.source?.projectId;
    const projectRev = task?.source?.projectRev;
    if (typeof projectId !== 'string' || !projectId || !Number.isSafeInteger(projectRev)) {
      throw fail('bad-task', `任务的 source 不对:${JSON.stringify(task?.source ?? null)}`, false);
    }
    return { projectId, projectRev, id: `${projectId}@${projectRev}` };
  };

  /** projectId → 本执行器算成过的最新一版(见文件头「项目往前走了」) */
  const newest = new Map();
  /** 计划任务对象 → 它实际按哪一版切的(`afterSplit` 写层表要用同一版) */
  const planned = new WeakMap();

  const cacheIdOf = (projectId, projectRev) => {
    const version = `${projectId}@${projectRev}`;
    let stamp = '';
    try { stamp = String(codeStamp() ?? ''); } catch { stamp = ''; }
    return stamp ? `${version}#${stamp}` : version;
  };

  /** 取这一版的项目:`{ json }`,没有时 `{ json: null, currentRev }`。项目客户端没有 `locate`(测试替身、旧客户端)时只用 `get` */
  async function fetchProject(projectId, projectRev) {
    if (typeof projects.locate === 'function') {
      const found = await projects.locate(projectId, projectRev);
      return { json: found?.project ?? null, currentRev: Number.isSafeInteger(found?.currentRev) ? found.currentRev : null };
    }
    return { json: await projects.get(projectId, projectRev), currentRev: null };
  }

  /** 取(或算)恰好这一版的上下文。失败的不留在缓存里,下次重算;文档服务说了当前版本的,错误带 `currentRev` */
  function exactContext(projectId, projectRev, signal) {
    const version = `${projectId}@${projectRev}`;
    const id = cacheIdOf(projectId, projectRev);
    const hit = cache.get(id);
    if (hit) {
      cache.delete(id);
      cache.set(id, hit);
      return hit;
    }
    const work = (async () => {
      let found;
      try { found = await fetchProject(projectId, projectRev); }
      catch (error) { throw fail(error?.code === 'digest-mismatch' ? 'bad-snapshot' : 'no-snapshot', `取不到项目快照 ${version}:${error?.message || error}`, true); }
      const json = found.json;
      if (!json) throw Object.assign(fail('no-snapshot', `文档服务上没有项目快照 ${version}`, true), { currentRev: found.currentRev });
      const project = prepareProject(json);
      if (!Array.isArray(project?.tracks) || !Number.isFinite(project?.duration) || project.duration <= 0) {
        throw fail('bad-snapshot', `项目快照 ${version} 不是能渲的项目`, false);
      }
      const out = await onLane(pipeline, () => pipeline.planForQueue(project, { signal }));
      if (projectRev > (newest.get(projectId) ?? -1)) newest.set(projectId, projectRev);
      return out;
    })();
    cache.set(id, work);
    while (cache.size > PLAN_CACHE_SIZE) cache.delete(cache.keys().next().value);
    work.catch(() => { if (cache.get(id) === work) cache.delete(id); });
    return work;
  }

  /**
   * 这个任务按哪一版算(见文件头「项目往前走了」)。回 `{ entry, context, streamSpecs, rev, drifted }`:
   * `rev` 是实际用的那一版,`drifted` 为真表示它不是任务指的那一版。
   */
  async function contextFor(task, signal) {
    const { projectId, projectRev, id: version } = versionOf(task);
    let want = projectRev;
    // 带片段清单的计划与它的细任务:已经算过更新的一版就不回头用旧的
    const known = newest.get(projectId);
    if (isListWork(task) && Number.isSafeInteger(known) && known > want) want = known;
    for (let hop = 0; ; hop += 1) {
      try {
        const got = await exactContext(projectId, want, signal);
        if (want !== projectRev) say('executor.drift', { id: task?.id ?? null, version, actual: want });
        return { ...got, rev: want, drifted: want !== projectRev };
      } catch (error) {
        const next = error?.currentRev;
        if (!Number.isSafeInteger(next) || next <= want || hop >= DRIFT_MAX_HOPS) throw error;
        want = next;
      }
    }
  }

  async function plan(planTask, { signal } = {}) {
    const { id } = versionOf(planTask);
    const resolved = await contextFor(planTask, signal);
    if (planTask && typeof planTask === 'object') planned.set(planTask, resolved);
    const { entry, rev, drifted } = resolved;
    // 项目往前走了:按实际那一版切,细任务的 source.projectRev 也写那一版(local-node 读 actualRev)
    let context = drifted ? { ...resolved.context, actualRev: rev } : resolved.context;
    // 任务书「甲三」:清单计划里切分方自己的那一份流出不出 —— 本机能产(`planForQueue` 给的 `ownListStreams`)并且这个项目此刻产流
    // (托管方的渲染节点看「生成轨道流」;别的节点不按项目管)。每次切分现问,不进按版本的缓存
    if (isListPlan(planTask) && perProject && !isExportOnlyPlan(planTask)) {
      const on = await streamsSettled(planTask, signal);
      // 这个项目此刻不产流:本机写层表时不列自己这一版的流(列了没人产,页面白取清单);已经派过的流照候选记录列,产出的保留
      // (`frame-pipeline.mjs` 的 `layerMapStreamOptions` 读 `entry.ownStreamsOff`)。只有按项目管的进程才写这个记号
      if (entry && typeof entry === 'object') entry.ownStreamsOff = !on;
      if (!on && context.ownListStreams === true) {
        // 这一项关着：托管方渲染节点什么轨道流都不产（既不产满密度流也不产稀疏流，只有 Agent 查帧；语义 workflow/project.md「项目设置」）。
        context = { ...context, ownListStreams: false, ownListSparseStreams: false };
        say('executor.list-streams-off', { version: id, sparse: false });
      }
    }
    // c10a 契约第 17 节:预渲染重试计划任务的片段清单记进管线(进预渲染集合、写进层表);切分由 local-node 按清单做。
    // C10 契约第 18 节第 9 条:在线页面的清单计划同一条路(清单是页面自己判重的片段)
    // 只为导出的清单计划(`export-frames.mjs`)不进预渲染集合:它只出导出位图任务,预览不用它的任何结果
    if (isListPlan(planTask) && !isExportOnlyPlan(planTask) && typeof pipeline.addBackfill === 'function') {
      const added = pipeline.addBackfill(entry, planTask.input?.clips ?? []);
      say('executor.backfill', { version: id, clips: planTask.input?.clips?.length ?? 0, added });
    }
    // 层表不在这里写:切分完成后按实际出键写(afterSplit,M7 D12)
    say('executor.plan', { version: id, entryKey: entry.key, controls: context.cardPlan.length, locks: context.cardLocks?.size ?? 0 });
    // 任务 E:本机快照库记过超限帧的卡标 snapshotOversize(每次切分现读:超限记录会随本机渲染、拉取变多,不进按版本的缓存)
    const { cardPlan, marked } = await markSnapshotOversize(pipeline, context);
    if (!marked.length) return context;
    say('executor.oversize', { version: id, clips: marked.length });
    return { ...context, cardPlan };
  }

  /** 附件第 3 节「把任务对回 control」:对不上的每一项都记进 `why`,有就抛 `plan-mismatch` */
  function matchControl(task, entry, { drifted = false } = {}) {
    const input = task.input ?? {};
    const control = (entry.cardPlan ?? []).find(item => item?.clipId === input.clipId);
    const why = [];
    // 按的不是任务指的那一版(项目往前走了):片段没了或内容键换了 = 这份内容已被新版本取代,作废,不算失败
    if (drifted) {
      const tier = control ? (control.tier || snapshotTier(control.capabilities)) : null;
      const current = !control ? null : tier === 'local' ? `${entry.key}/${control.contentKey}` : control.contentKey;
      if (!control || input.contentKey !== current) throw superseded(!control ? `新版本里没有片段 ${input.clipId}` : `片段 ${input.clipId} 的内容在新版本里换了`);
    }
    if (!control) why.push(`这一版没有片段 ${input.clipId}`);
    else {
      const tier = control.tier || snapshotTier(control.capabilities);
      const from = task.range?.from, to = task.range?.to;
      if (tier !== task.tier) why.push(`档位 ${task.tier} ≠ ${tier}`);
      if (!pipeline.queueHandles(control)) why.push('这张卡不由队列产');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > control.count - 1) why.push(`帧范围 ${JSON.stringify(task.range)} 超出 0..${control.count - 1}`);
      const own = pipeline.envFingerprint;
      if (!own) why.push('本机还没有环境指纹');
      if (tier === 'shared') {
        if (input.contentKey !== control.contentKey) why.push('内容键不同');
        else if (own && task.resultKey !== resultKeyOf(control.contentKey, own)) why.push('结果键不是本机指纹的键');
      } else if (tier === 'local') {
        if (input.entryKey !== entry.key) why.push(`entry.key 不同(本机 ${entry.key})`);
        if (input.contentKey !== `${entry.key}/${control.contentKey}`) why.push('内容键不同');
        else if (own && task.resultKey !== resultKeyOf(input.contentKey, own)) why.push('结果键不是本机指纹的键');
      }
    }
    if (why.length) throw fail('plan-mismatch', `任务 ${task.id} 对不上这一版的计划:${why.join(';')}`, false);
    return control;
  }

  /**
   * M6c X1:把流任务对回这一版的流。流按内容键认(`input.contentKey`,即 `planStreams` 的 `contentKey`);
   * 结果键必须是本机指纹乘出来的(节点侧过滤已经按指纹挡过,这里再核一次);分段范围在这条流之内。
   * 依赖下层的流(`requires.belowDependent: true`,`docs/plan/prerender-products-contract.md` 第 5 节)同样按内容键认:
   * 它的内容键里带着目标卡和每个下层,下层改了键就换,对不上(项目往前走了)按作废处理;任务说的种类和这一版的流对不上不产。
   */
  function matchStream(task, specs, { drifted = false, entry = null } = {}) {
    const input = task.input ?? {};
    let spec = (specs ?? []).find(item => item?.contentKey === input.contentKey) ?? null;
    // 任务书「甲三」:清单计划切出的、切分方自己的那一份。清单是发布方判的,本机没判重的卡不在本机这一版的流(`specs`)里;
    // 这一份只有单卡流和依赖下层的流(`local-node.mjs` 的 `listPlanOverrides`),它们的内容键与清单里还有哪些片段无关
    // (单卡流只看这张卡;依赖下层的流看目标卡和它下面的层),按任务的片段现算一条来对。
    // 切分它的可能是别的进程、或本进程重启之前,所以不指望记着当时的清单
    if (!spec && entry && isListWork(task) && typeof input.clipId === 'string' && input.clipId && typeof pipeline.listStreamSpecs === 'function') {
      let listed = [];
      try { listed = pipeline.listStreamSpecs(entry, [input.clipId]) ?? []; } catch { listed = []; }
      spec = listed.find(item => (item?.kind === 'card' || item?.kind === 'below') && item.contentKey === input.contentKey) ?? null;
    }
    if (!spec && drifted) throw superseded('新版本里没有这条流');
    const why = [];
    const wantsBelow = task.requires?.belowDependent === true;
    if (!spec) why.push(`这一版没有内容键为 ${String(input.contentKey).slice(0, 16)}… 的${wantsBelow ? '依赖下层的流(本机没有打开这种流,或目标卡、下层和切分时不同)' : '流'}`);
    else if (wantsBelow !== (spec.kind === 'below')) why.push(`流的种类对不上(任务${wantsBelow ? '要' : '不要'}整场景的下层,这一版的流是 ${spec.kind})`);
    else {
      const own = pipeline.envFingerprint;
      const from = task.range?.from, to = task.range?.to;
      if (!own) why.push('本机还没有环境指纹');
      else if (task.resultKey !== resultKeyOf(spec.contentKey, own)) why.push('结果键不是本机指纹的键');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < spec.firstSegment || to < from || to > spec.lastSegment) {
        why.push(`分段范围 ${JSON.stringify(task.range)} 超出 ${spec.firstSegment}..${spec.lastSegment}`);
      }
    }
    if (why.length) throw fail('plan-mismatch', `任务 ${task.id} 对不上这一版的流:${why.join(';')}`, false);
    return spec;
  }

  /**
   * 导出专用的逐帧位图任务(`export-frames.mjs`):按任务的片段现算这一版的导出位图计划来对(内容键里已经带着这张卡的内容与采样窗口,
   * 依赖下层的另带每个下层),对得上才取。项目往前走了而这张卡的内容换了,这份结果当时不要了(作废,不算失败)。
   */
  async function renderExport(task, { signal, progress }) {
    if (typeof pipeline.exportStreamSpecs !== 'function' || typeof pipeline.renderExportFrames !== 'function') {
      throw fail('no-export-frames', '本机不会取导出位图', false);
    }
    const { entry, drifted } = await contextFor(task, signal);
    const input = task.input ?? {};
    let specs = [];
    try { specs = pipeline.exportStreamSpecs(entry, [input.clipId], input.exportSalt)?.specs ?? []; } catch { specs = []; }
    const spec = specs.find(item => item?.exportKey === input.exportKey) ?? null;
    if (!spec && drifted) throw superseded(`新版本里片段 ${input.clipId} 的内容换了`);
    const why = [];
    const from = task.range?.from, to = task.range?.to;
    if (!spec) why.push(`这一版没有内容键为 ${String(input.exportKey).slice(0, 16)}… 的导出位图`);
    else {
      if (task.resultKey !== spec.exportResultKey) why.push('结果键不是本机指纹的键');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > spec.lastSegment) why.push(`分段范围 ${JSON.stringify(task.range)} 超出 0..${spec.lastSegment}`);
    }
    if (why.length) throw fail('plan-mismatch', `任务 ${task.id} 对不上这一版的导出位图:${why.join(';')}`, false);
    const started = Date.now();
    await pipeline.renderExportFrames(entry, spec, { from, to }, { signal, progress });
    say('executor.render', { id: task.id, kind: 'export-frames', clipId: input.clipId, ms: Date.now() - started });
    return null;
  }

  async function renderStream(task, { signal, progress }) {
    if (typeof pipeline.streamCapable === 'function' && !(await pipeline.streamCapable())) {
      throw fail('no-streams', '本机不能产轨道流(PROMPTCUT_STREAMS=0 或没有能用的 H.264 编码器)', false);
    }
    const { entry, streamSpecs, drifted } = await contextFor(task, signal);
    const spec = matchStream(task, streamSpecs, { drifted, entry });
    // 清单计划切出的流任务同快照任务(见 `render`):这张卡在本机可能没判重,把它记进预渲染集合 —— 本机写的层表才列得出这条流
    // (`frame-pipeline.mjs` 的 `issuedStreamSpecs` 只看预渲染集合里的卡)
    if (isListWork(task) && typeof pipeline.addBackfill === 'function' && typeof pipeline.prerenderPicked === 'function'
      && !pipeline.prerenderPicked(entry, spec.topClipId)) {
      pipeline.addBackfill(entry, [spec.topClipId]);
    }
    const range = { from: task.range.from, to: task.range.to };
    const started = Date.now();
    // 稀疏流任务(`input.density: 'sparse'`):每个分段只截第一帧;满密度任务不带这一项
    await pipeline.renderStreamRange(entry, spec, range, { signal, progress, density: isSparseStreamTask(task) ? STREAM_DENSITY_SPARSE : null });
    say('executor.render', { id: task.id, kind: 'stream', streamKey: spec.streamKey.slice(0, 12), ms: Date.now() - started });
    promoteOwnStream(entry, spec);
    return null;
  }

  /**
   * 一条流几种环境各出一份时(切分方自己的、浏览器的,成对,谁先认领谁得),层表里候选的先后要对着「实际是谁产的」:
   * 之后才进来的页面没收到过完成通知,取第一个候选。切分完成时还不知道谁会赢,先把自己的排在别人后面(`afterSplit`);
   * 本机真产出了这条流的一段,才在这里把自己的提到最前、把层表重写一次。别人赢了的话本机那一份被队列作废、走不到这里,顺序不动。
   * 记录里没有这条流、或没有自己的指纹(切分它的不是本机)时不动。
   */
  function promoteOwnStream(entry, spec) {
    try {
      const own = pipeline.envFingerprint;
      const key = streamCandidateKey(spec?.contentKey);
      const list = typeof pipeline.splitCandidatesFor === 'function' ? pipeline.splitCandidatesFor(key) : null;
      if (!own || !Array.isArray(list) || !list.includes(own) || list[0] === own || typeof pipeline.recordSplitCandidates !== 'function') return false;
      pipeline.recordSplitCandidates(new Map([[key, [own, ...list.filter(fp => fp !== own)]]]));
      if (typeof publishLayerMap === 'function') publishLayerMap(entry);
      else if (typeof pipeline.publishLayerMap === 'function') pipeline.publishLayerMap(entry);
      say('executor.stream-candidates', { streamKey: String(spec.streamKey).slice(0, 12), first: 'own' });
      return true;
    } catch (error) {
      say('executor.stream-candidates-failed', { message: String(error?.message ?? error) });
      return false;
    }
  }

  async function render(task, { signal, progress, phase } = {}) {
    const say = (name, fields) => { try { phase?.(name, fields); } catch { /* 诊断回调出错不影响执行 */ } };
    if (isExportFramesTask(task)) return renderExport(task, { signal, progress });
    if (task?.kind === 'stream') return renderStream(task, { signal, progress });
    if (task?.kind !== 'snapshot') throw fail('bad-task', `不认识的任务 kind:${task?.kind}`, false);
    say('project');
    const { entry, drifted } = await contextFor(task, signal);
    const control = matchControl(task, entry, { drifted });
    // c10a 契约第 17 节:预渲染重试细任务的片段在本机可能判轻(不在预渲染集合里,管线会跳过它);按任务把它记成预渲染重试再渲。
    // 切分它的 plan 可能是别的进程、或本进程重启之前认领的,这里不能指望 plan() 已经记过。
    // 清单计划(在线页面、云端 Agent 服务发的)切出的细任务同理:清单是发布方判的,本机重启后、或换了一版算时都没记过
    if ((task.priority === 'backfill' || isListWork(task)) && typeof pipeline.addBackfill === 'function' && !pipeline.prerenderPicked(entry, control.clipId)) {
      pipeline.addBackfill(entry, [control.clipId]);
    }
    const range = { from: task.range.from, to: task.range.to };
    const started = Date.now();
    const total = range.to - range.from + 1;
    say('lane', { ahead: laneBusy(pipeline) });
    const tracked = done => {
      say(done >= total ? 'finish' : 'frames', { done, total });
      progress?.(done);
    };
    // 诊断(不改行为):共享档这一段各步的用时(排队、借预渲染间、换页、推帧、入库、画小尺寸),记进 executor.render
    const timing = {};
    // 做在 Agent 专用实例上、中途给 Agent 让路时定时报一步(会话的工作计数),租约不被队列当成停滞(AGENT-maint-3)
    const heartbeat = () => say('agent-yield');
    await onLane(pipeline, () => (task.tier === 'shared'
      ? pipeline.renderCardSnapshotRange(entry, control, range, { signal, progress: tracked, timing, heartbeat })
      : pipeline.renderSceneSnapshotRange(entry, control, range, { signal, progress: tracked, heartbeat })));
    say('executor.render', { id: task.id, tier: task.tier, clipId: control.clipId, ms: Date.now() - started });
    // 上面那个 `say` 是阶段回调(这一行照旧);分段耗时另记一行日志(`log`),编辑器进程的转发器放行它
    note('executor.render-timing', { id: task.id, tier: task.tier, clipId: control.clipId, ms: Date.now() - started, ...timing });
    return null;
  }

  /**
   * M7 D12:切分完成后按实际出键写层表。`tasks` 是最终发布成功的细任务;记候选对所有 plan 都做(之后本机写的层表也按它列),
   * 写层表只对带片段清单的 plan(在线页面按层表找清单)。失败只记日志。
   */
  async function afterSplit(planTask, { tasks = [] } = {}) {
    const { id } = versionOf(planTask);
    const candidates = splitCandidatesOf(tasks);
    if (typeof pipeline.recordSplitCandidates === 'function') {
      pipeline.recordSplitCandidates(candidates);
      // 轨道流的候选(层表 `streams` 表用)记在同一份记录里,键带 `stream:` 前缀,与卡的内容键分开;这一次切分没有流任务就不记
      const streamCandidates = splitStreamCandidatesOf(tasks);
      // 自己与别的环境各出了一份的流:自己的先排在后面,真产出了再提到最前(`promoteOwnStream`)。已经是自己在前的(之前产过)不往后挪
      const own = pipeline.envFingerprint;
      const ordered = (contentKey, fps) => {
        if (!own || fps.length < 2 || !fps.includes(own)) return fps;
        const before = typeof pipeline.splitCandidatesFor === 'function' ? pipeline.splitCandidatesFor(streamCandidateKey(contentKey)) : null;
        return Array.isArray(before) && before[0] === own ? [own, ...fps.filter(fp => fp !== own)] : [...fps.filter(fp => fp !== own), own];
      };
      if (streamCandidates.size) pipeline.recordSplitCandidates(new Map([...streamCandidates].map(([contentKey, fps]) => [streamCandidateKey(contentKey), ordered(contentKey, fps)])));
    }
    // 只为导出的计划不写层表(它的产物预览不读,页面从计划的完成回包里拿索引)
    if (!isListPlan(planTask) || isExportOnlyPlan(planTask)) return;
    try {
      // 层表按切分时实际用的那一版写(项目往前走了时不是 planTask 指的那一版)
      const { entry } = planned.get(planTask) ?? await contextFor(planTask);
      if (typeof publishLayerMap === 'function') publishLayerMap(entry);
      else if (typeof pipeline.publishLayerMap === 'function') pipeline.publishLayerMap(entry);
      say('executor.layer-map', { version: id, cards: candidates.size, dual: [...candidates.values()].filter(fps => fps.length > 1).length });
    } catch (error) {
      say('executor.layer-map-failed', { version: id, message: String(error?.message ?? error) });
    }
  }

  /**
   * 独立渲染主机的闲时认领(契约 A.12〔裁〕,`render-node/host.mjs`):任务要用哪条串行 lane —— 快照与 plan 用 `'queue'`
   * (`runQueueTask`,一次只做一件),流用流预渲染间池,不算(回 null)。`laneBusy()` 是这条管线上此刻经执行器交给
   * `'queue'` lane、还没落定的工作数(包括已经被中止、管线还没收手的那一件)。
   */
  const laneOf = task => (task?.kind === 'snapshot' || task?.kind === 'plan' ? 'queue' : null);
  return { plan, render, afterSplit, forget: () => { cache.clear(); newest.clear(); }, laneOf, laneBusy: () => laneBusy(pipeline) };
}
