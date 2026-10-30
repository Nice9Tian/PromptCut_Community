import { QUEUE_DEFAULTS, taskIdOf, lockKeyOf, backfillPlanTaskOf, isBackfillPlan, clipsPlanTaskOf, isClipsPlan, isListPlan, STREAM_DENSITY_SPARSE } from '../render-queue/index.mjs';
import { snapshotTier } from '../snapshot-tier.mjs';
import { resultKeyOf } from './fingerprint.mjs';
import { isStreamOrigin, streamSegmentFrameCount, STREAM_SEGMENT_FRAMES } from '../../src/render/streamSegments.mjs';
import { EXPORT_FRAMES_PRIORITY } from './export-plan.mjs';
import { reviewedCard } from '../../src/kernel/frameMode.mjs';
import { frame3d } from '../../src/render/streamPlanRules.mjs';

/**
 * `plan` 任务 → 细任务(设计第 2 节、Q1,契约 B.4)。
 *
 * 页面只发粗任务「给这一版项目做计划」;第一个认领它的节点在 Chrome 里算出 card plan、
 * 用 `card-cache.mjs` 算出结果键和预渲染集合,再用这里的 `splitPlan` 切成细任务发布回队列
 * (`source.derivedFrom` 指向那个 `plan` 任务)。
 *
 *   快照:每个 control 的本地帧 0 .. count-1 按 SNAPSHOT_SPAN 切段(缺省 60 帧);本地档缺 entryKey 的跳过
 *   轨道流:firstSegment .. lastSegment 按 STREAM_SEGMENTS 切(缺省 8 段,每段 15 帧);没有 streamKey 的跳过。
 *     分段号是这条流自己的:从它的第一帧 `originFrame` 起每 15 帧一段(`src/render/streamSegments.mjs`),所以 firstSegment 恒为 0。
 *          流任务的 `requires.capabilities = { streams: true }`(M6c X1):只给报了能产流的节点
 *
 * 结果键 = 内容键 × 切分节点**自己的**环境指纹(设计 2.1;卡被别的环境锁定时见下文「卡片级指纹锁」):认领 `plan` 的节点定下这一版
 * 项目的指纹,写进每个细任务的 `requires.envFingerprint`,只有同指纹的节点能认领。
 * 含锚帧的快照段优先级 50,其余 10。快照任务的 `input.canvasHeavy` 取 `control.capabilities?.canvasHeavy === true`
 * (契约 J.3)。
 *
 * 内容键(契约 E.5):M4 起 card plan 的 `snapshotKey` 和流的 `streamKey` 本身已经乘过指纹,
 * 所以这里取它们带的**内容键**(`control.contentKey` / `stream.contentKey`)再乘一次指纹 ——
 * 指纹与 plan 相同时,共享档任务的 `resultKey` 正好等于 `control.snapshotKey`,流任务的正好等于
 * `spec.streamKey`,细任务的产物和本机预渲染进程写的是同一个目录。没有内容键字段的输入
 * (M2 夹具的旧形状)照旧把 `snapshotKey` / `streamKey` 当内容键。
 *
 * # 卡片级指纹锁(契约 F.2,设计 2.1「谁定指纹」)
 *
 * 锁的单位是「一张卡的一种结果」,锁键 `<kind>:<contentKey>`,`contentKey` 就是细任务的
 * `input.contentKey`(本地档带 `<entryKey>/` 前缀)。调用方可以传 `cardLocks`(锁键 → 锁指纹)
 * 和 `takeover`(要接手哪些锁),每张卡、每条流按下面三种之一出键:
 *
 *   没锁,或锁在本节点的指纹上   按本节点指纹出键,不加 takeover 字段(即上面的规则)
 *   锁在别的指纹 X 上,且接手     按本节点指纹出键,每个任务加 `takeover: true`,
 *                                 发布时锁转给本节点,X 的未完成任务作废(superseded)
 *   锁在别的指纹 X 上,不接手     `resultKey` 与 `requires.envFingerprint` 都用 X:
 *                                 剩余帧只给与锁定方同指纹的节点,这一层不混环境
 *
 * # 本地档能力闸(M6c X2,`docs/plan/m6c-contract.md`)
 *
 * 没有内容哈希的素材只在发布方本机(别的机器拿不到它的字节,素材回退只认哈希)。调用方给 `localMedia`
 * (发布方的 nodeId)和 `usesLocalMedia(control)`,判真的每个任务在 `requires` 里写 `localMedia`,
 * 只有那个节点能认领(节点侧过滤规则 1 与队列的前置过滤、认领检查一起守)。不给 `localMedia` 时任务形状不变。
 *
 * # 纯浏览器可做的卡出两份(M7 契约 D1,第 3.3 节)
 *
 * 调用方给 `browserFingerprints`(文档服务上本项目在线、与 plan 同一用户的纯浏览器节点的指纹,由队列在 plan 的
 * `task.claimed` 里给出,见 `render-queue/queue.mjs` 的 `browserFingerprintsFor`)时,**没被锁**的、纯浏览器做得了的卡
 * (共享档、独立卡、内置卡片、`cardSources` 为空、重度 light / medium、不用只在发布方本机的素材)
 * 除了照旧按自己的指纹出一份,再按每个浏览器指纹各出一份:
 *
 *   结果键 = 内容键 × 浏览器指纹,`requires.envFingerprint` = 浏览器指纹,其余 requires 相同;
 *   两份都带 `input.dual: true`,都不带 `takeover`;浏览器那份另带 `input.compositing` 与 `input.bake`
 *   (隔离单卡工程要的 `start`、`end`、`count`、`sampling`,页面不算 cardSampling)。
 *
 * 谁先认领这张卡的任一段谁得锁,队列在建锁时把另一份(`dual`、还 open 的异指纹任务)作废。
 * 已锁的卡照旧按锁出一份(锁在浏览器指纹上时那一份同样带 bake / compositing);浏览器指纹与自己相同、
 * 或没给浏览器指纹时,切分与原来完全相同。
 *
 * # 用户卡、素材效果卡也可以给浏览器(块 N,`docs/plan/online-card-exec-contract.md` 第 7 节第 3 条,2026-10-06 用户改语义)
 *
 * 任务的 `requires.userCards` 或 `requires.graphCards` 为真的卡(在线页面在舞台里转译、执行同步来的用户卡与素材效果卡),
 * 调用方给 `browserCards`(页面自报在清单计划 `input.browser` 里的 `{ cardEnvFingerprint, userCards, graphCards, cardSources }`,
 * 经 `browserCardsOf` 规整)和 `browserCardEnvFingerprints`(文档服务确认「本项目有同一用户的在线浏览器节点带着这些
 * `cardEnvFingerprint`」)时,两边对得上才出浏览器那一份:
 *   - 页面声明了对应能力(`userCards` / `graphCards`),且这张卡 `requires.cardSources` 里每一项的代码身份都在 `browserCards.cardSources` 里;
 *   - 浏览器那一份的指纹和结果键用 `cardEnvFingerprint`(不是页面的 `envFingerprint`):结果键 = 内容键 × cardEnvFingerprint,
 *     所以同一台机器上的桌面节点与浏览器节点对同一张用户卡 / 素材效果卡的结果键不同、不串。
 * 不给 `browserCards` 或对不上时,用户卡、素材效果卡不出浏览器那一份,切分与原来相同。内置卡片的切分与结果键一个字不变。
 *
 * # 单卡轨道流也给浏览器一份(`docs/plan/browser-stream-task.md` 第一处)
 *
 * 调用方给的每条流除了流键与分段范围,还可以带这条流的形状(`planStreams` 算出的 `kind`、`plane`、`clipIds`、`fps`、`bound`、
 * `offset`、`firstFrame`、`total`)。**单卡流**(`kind: 'card'`、`plane: 'local'`、恰好一张成员卡),而且这张成员卡照上面快照那一套
 * 判下来浏览器做得了(共享档、独立卡、light / medium、不是画布卡、不用只在发布方本机的素材;用户卡、素材效果卡要本页
 * 声明能运行且代码身份对得上),就另出浏览器指纹的一份:
 *
 *   结果键 = 流的内容键 × 浏览器指纹(用户卡、素材效果卡用页面的 cardEnvFingerprint),`requires.envFingerprint` 同它;
 *   `requires.transcode: false`(浏览器用自带的编码器压,不要本机转码),仍要求 `capabilities.streams`;
 *   `requires.cardSources`、`userCards`、`graphCards` 照这张卡的快照任务写(只画这一张卡);
 *   `input` 带 `compositing`、`bake`(同快照那一份)和 `stream`:
 *     `{ kind: 'card', plane: 'local', clipIds, fps, bound, offset, firstFrame, count, total }` —— 页面不自己算这些。
 *
 * 锁的规矩同快照:锁键 `stream:<内容键>`;没锁(或锁在自己的指纹上且不接手)才出两份,两份都带 `input.dual`;锁在别的指纹上照锁只出一份,
 * 锁在浏览器指纹上时那一份是浏览器的形状。组流、成员卡不在 card plan 里的流、缺形状字段的流(旧调用方)只出切分方自己的一份,与原来逐字相同。
 * 浏览器指纹与切分方自己的相同时不另出(两份的任务 id 会相同,而切分方那一份要本机转码,浏览器做不了)。
 *
 * 一条流标了 `browserOnly: true` 时不出切分方自己的那一份(在线页面发的清单计划用,见 `local-node.mjs` 的 `listPlanOverrides`):
 * 只出浏览器做得了的那几份,做不了就一份都不出。
 *
 * # 稀疏流任务(语义 `mechanism/rendering.md`「重管线:预渲染」:每条流有稀疏、满密度两版,同一个键;稀疏版排在满密度版前面)
 *
 * 队列认稀疏流任务时(`sparseStreams: true`,`node.welcome` 带来的;旧队列不带,就照原来只出满密度的),每一份流在满密度任务之外
 * 另出一组**稀疏流任务**:范围与满密度任务逐个相同(所以内容库里的清单键相同),`input.density: 'sparse'`,id 末尾多 `:sparse`
 * (`messages.mjs` 的 `taskIdOf`),`priority` 是 `SPARSE_STREAM_PRIORITY`(高于满密度流任务和普通快照任务,低于锚帧),
 * 别的字段(结果键、`requires`、`input.dual`、锁键)与同一份的满密度任务相同。稀疏任务排在这条流的满密度任务前面发。
 *
 * 一条流标了 `ownSparseOnly: true`(托管方的渲染节点、这个项目的「生成轨道流」关着,见 `listPlanOverrides`)时,切分方自己的那一份
 * **只出稀疏流任务**。这时有浏览器那一份可出(没锁)就不出自己的:一条流只归一个指纹产(同一把锁),自己这份只有稀疏版,
 * 抢到了锁浏览器就补不了满密度;没有浏览器能产这条流、或者锁已经在自己的指纹上时才出自己的稀疏版。
 *
 * # 依赖下层的流(`docs/plan/prerender-products-contract.md` 第 5.1 节)
 *
 * `kind: 'below'` 的流(`frame-stream.mjs` 的 `planStreams` 在开关打开时才出)要整场景的下层和素材,只由桌面应用和渲染主机产:
 *   - 只出切分方自己的一份,浏览器那一份不出(`browserStreamInputOf` 只认单卡流);标了 `browserOnly` 的就一份都不出;
 *   - `requires.transcode: true`、`requires.belowDependent: true`,`capabilities.streams` 照旧;`cardSources` 照旧是全部定制卡;
 *   - 重度一律记 `heavy`(整场景渲);
 *   - 本地档能力闸:`usesLocalMedia` 收到的那一项另带 `streamKind: 'below'` 和 `belowClipIds`(算进键里的下层),
 *     判据要把下层的素材算进去(`queue-local-media.mjs` 现在对流任务一律判真,已经包含)。
 * 调用方不给这种流时,切分与原来逐字相同。
 *
 * # 导出专用的逐帧位图(`../export-frames.mjs`;语义 `product/platforms.md`「在线浏览器」的「导出」)
 *
 * 调用方给 `exportStreams`(只为导出的清单计划才有,`local-node.mjs` 的 `listPlanOverrides`;每项是 `exportStreamOf` 的结果)时,
 * 每条另出一组**导出位图任务**:沿用流任务的种类与范围(`kind: 'stream'`,分段号 0 .. lastSegment 按 STREAM_SEGMENTS 切),
 * `input.exportFrames: true`、`input.exportKey`(导出位图的内容键)、`input.stream`(这条流的形状),结果键 = `exportKey × 自己的指纹`。
 *   - 只出切分方自己的一份,不给浏览器(纯浏览器节点只收带 `input.bake` 的浏览器形状的流任务,`filter.mjs` 规则 7,这种任务它不收);
 *     不要求本机转码、不要求 `capabilities.streams`(取位图不用 ffmpeg、不用编码器;不带 `--streams` 的独立渲染主机也做得了);
 *   - `input` 里**不带 `contentKey`**:不参加卡片级指纹锁(这份产物只给这一次导出用,和这张卡的轨道流不是一个键);
 *   - 名次 `EXPORT_FRAMES_PRIORITY`,排在所有别的细任务前面(用户正等着导出)。
 * 不给 `exportStreams` 时切分与原来逐字相同。
 *
 * 纯函数:不读环境变量、不做 I/O。
 */

/** 轨道流每段的帧数(G2 的分段规则;取 `src/render/streamSegments.mjs` 的,不另写一个数)。 */
const SEGMENT_FRAMES = STREAM_SEGMENT_FRAMES;
const ANCHOR_PRIORITY = 50;
const NORMAL_PRIORITY = 10;
/** 稀疏流任务的名次:排在满密度流任务和普通快照任务(`NORMAL_PRIORITY`)前面、锚帧(`ANCHOR_PRIORITY`)后面 */
export const SPARSE_STREAM_PRIORITY = 30;

/**
 * 这一版项目的粗任务(发布方发布的那一个)。
 * `codeVersion` / `envFingerprint` 给了就写进 `requires`(契约 J.3),只有代码版本、指纹对得上的
 * 节点能认领这个 plan;没给的项不写,`requires` 与 B.4 相同。id 与 resultKey 不随它们变。
 */
export function planTaskOf({ projectId, projectRev, priority = 0, codeVersion, envFingerprint, preferNode }) {
  const resultKey = `${projectId}@${projectRev}`;
  const requires = {};
  if (codeVersion !== undefined) requires.codeVersion = codeVersion;
  if (envFingerprint !== undefined) requires.envFingerprint = envFingerprint;
  // M6c X4:发布方自己的节点优先认领(独占窗口 PLAN_PREFER_MS),窗口过后给任何指纹符合的 pc
  if (preferNode !== undefined) requires.preferNode = preferNode;
  return {
    id: taskIdOf({ kind: 'plan', resultKey, range: null }), kind: 'plan', resultKey, range: null,
    source: { projectId, projectRev }, input: {}, weight: { class: 'medium', estMs: null, frames: null },
    requires, priority,
  };
}

/**
 * 预渲染重试计划任务(c10a 契约第 17 节)(旧页面的 `backfill` 档;2026-10-07 起在线页面一律发普通优先级的清单计划,这一档没有新的发布方,留着只为认部署切换期间的老页面):老页面发现判重的层在素材服务里
 * 没有产物时发布,带片段清单(`input.clips`),标 `priority: 'backfill'`。认领它的节点把清单里的片段当重卡算键、
 * 切出细任务,细任务同样标 `backfill`(`splitPlan` 的 `lane`)。形状与校验在队列那边(`messages.mjs`)。
 */
export { backfillPlanTaskOf, isBackfillPlan, clipsPlanTaskOf, isClipsPlan, isListPlan };

/** `[from, to]` 闭区间序列:first .. last 每 span 一段,最后一段到 last。若给定了 minSpan 且尾段不足 minSpan，并入前一段 */
function spans(first, last, span, minSpan = 1) {
  const out = [];
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return out;
  for (let from = first; from <= last; from += span) out.push([from, Math.min(last, from + span - 1)]);
  if (minSpan > 1 && out.length > 1) {
    const lastSpan = out[out.length - 1];
    if (lastSpan[1] - lastSpan[0] + 1 < minSpan) {
      out[out.length - 2][1] = lastSpan[1];
      out.pop();
    }
  }
  return out;
}

const stepOf = value => Math.max(1, Math.floor(Number(value) || 0));

/** 任务的锁键(契约 F.1):只有一份实现,在队列那边;这里转出,节点侧照旧从切分模块取 */
export { lockKeyOf };

/** 锁指纹只认非空字符串;别的值(`null`、空串、非字符串)一律当没锁。 */
const fingerprintOr = value => (typeof value === 'string' && value !== '' ? value : null);

/** `cardLocks`(Map 或普通对象)→ `(lockKey) => 锁指纹 | null`。普通对象只看自有属性。 */
function lockLookup(cardLocks) {
  if (cardLocks == null) return () => null;
  if (typeof cardLocks.get === 'function') return key => fingerprintOr(cardLocks.get(key));
  if (typeof cardLocks === 'object') {
    return key => (Object.prototype.hasOwnProperty.call(cardLocks, key) ? fingerprintOr(cardLocks[key]) : null);
  }
  return () => null;
}

/** `takeover`(布尔 / Set / 函数)→ `(lockKey) => boolean`。其余值当不接手。 */
function takeoverTest(takeover) {
  if (takeover === true) return () => true;
  if (typeof takeover === 'function') return key => takeover(key) === true;
  if (takeover != null && typeof takeover.has === 'function') return key => takeover.has(key) === true;
  return () => false;
}

/** 纯浏览器能认领的重度(filter.mjs 的 `DEFAULT_WEIGHT_POLICY.browser`) */
const BROWSER_WEIGHTS = new Set(['light', 'medium']);

/**
 * 判断流对应的卡是否为 motion 式（相对应为 remotion 式）。
 * 依据：control / stream 上的 writing、frameMode、或审阅表能力。
 */
export function isMotionCard(control, stream) {
  const writing = control?.writing ?? control?.capabilities?.writing ?? stream?.writing;
  if (writing === 'remotion') return false;
  if (writing === 'motion') return true;

  const cardId = control?.cardId ?? stream?.cardId;
  if (cardId) {
    const rev = reviewedCard(cardId);
    if (rev?.writing === 'remotion') return false;
    if (rev?.writing === 'motion') return true;
  }

  const frameMode = control?.frameMode ?? control?.capabilities?.frameMode ?? stream?.frameMode;
  if (frameMode === 'direct') return false;
  if (frameMode === 'stateful') return true;

  return false;
}


/**
 * 这个控件里面有哪几张卡(卡片 id,去重)。`planForQueue` 经 `withInnerCards` 给的 `cardIds` 优先;
 * 没有这一栏的(旧调用方、单测只给 `cardId`)就是 `cardId` 那一张,没有就是空。
 */
export function cardIdsOf(control) {
  const list = Array.isArray(control?.cardIds) ? control.cardIds : [control?.cardId];
  return [...new Set(list.filter(id => typeof id === 'string' && id !== ''))];
}

/**
 * 这个控件的任务用不用执行用户卡的代码(`planForQueue` 交给切分的 `isUserCard`):里面任何一张卡的源码版本是 `user:` 开头就算。
 * 里面是什么拿不准(`cardIdsUnsure`)时,这一版只要有用户卡就算 —— 宁可多要一项能力,不让没有这项能力的节点认领。
 */
export function isUserCardControl(control, sourceVersions = {}) {
  const user = cardId => String(sourceVersions?.[cardId] ?? '').startsWith('user:');
  if (control?.cardIdsUnsure === true) return Object.keys(sourceVersions ?? {}).some(user);
  return cardIdsOf(control).some(user);
}

/**
 * 卡片图里一个节点「里面有哪几张卡」:节点自己的 `cardId` 在前,再顺着 `inputs` 一层层往上游收(输入按名字排序,去重)。
 * 片段挂了强调、滤镜、声音效果时输出节点是外面那一层(`@clip/<id>/emphasis` 等,没有 `cardId`),卡片在它的
 * `inputs.source` 后面;套了几层就走几层,走到底。回 `(nodeId) => { cardIds, unsure, canvasHeavy }`:
 * `unsure` 为真 = 这个节点或它的某个上游在图里找不到(或成环),里面是什么拿不准;
 * `canvasHeavy` 为真 = 这个节点或它的某个上游是画布卡(能力表 `canvasHeavy`)。
 */
export function innerCardIds(graph) {
  const byId = new Map((graph?.nodes ?? []).filter(node => node?.id != null).map(node => [node.id, node]));
  const memo = new Map();
  const walk = (nodeId, path) => {
    if (memo.has(nodeId)) return memo.get(nodeId);
    const node = byId.get(nodeId);
    if (!node || path.has(nodeId)) return { cardIds: [], unsure: true, canvasHeavy: false };
    path.add(nodeId);
    const ids = typeof node.cardId === 'string' && node.cardId ? [node.cardId] : [];
    let unsure = false;
    // 外面那一层的能力表是从上游推的,只有「要不要预渲染」「依不依赖下层」两项(`projectCardGraph`),画布卡这一项在里面那张卡的节点上
    let canvasHeavy = node.capabilities?.canvasHeavy === true;
    for (const name of Object.keys(node.inputs ?? {}).sort()) {
      const input = node.inputs[name];
      const up = walk(typeof input === 'string' ? input : input?.nodeId, path);
      if (up.unsure) unsure = true;
      if (up.canvasHeavy) canvasHeavy = true;
      for (const id of up.cardIds) if (!ids.includes(id)) ids.push(id);
    }
    path.delete(nodeId);
    const out = { cardIds: ids, unsure, canvasHeavy };
    // 成环时路上的节点只算了一半,不记;正常的图(`validateCardGraph` 过了的)无环,都记
    if (!unsure) memo.set(nodeId, out);
    return out;
  };
  return nodeId => walk(nodeId, new Set());
}

/**
 * 给 card plan 的每个控件补上里面的卡(`FramePipeline.planForQueue` 用;卡片计划里的控件只有 `nodeId`)。〔裁〕取法:
 *
 *   - `cardIds`:输出节点和它全部上游里的卡片 id(`innerCardIds`)。切分按它判「要哪几张卡的代码」「是不是用户卡」「给不给浏览器」。
 *   - `cardId`(写进任务的 `input.cardId`):输出节点自己是卡片就是它(与原来逐字相同);输出节点不是卡片、里面恰好一张卡
 *     就是那一张(片段挂了强调、滤镜);里面没有卡、不止一张(外面一层接着两段的转场)、或拿不准,是 null。
 *   - `cardIdsUnsure: true`:里面是什么拿不准。切分按最保守的算:要这一版全部定制卡的代码、不给浏览器节点。
 *   - `innerCanvasHeavy: true`:控件自己的能力表没标画布卡、里面却有画布卡(挂了强调、滤镜的画布卡)。切分照画布卡办:
 *     不给浏览器节点、重度记「重」。只管这两件;任务的 `input.canvasHeavy`(清单的体积上限)不跟着变 —— 它要和推送那一侧
 *     按控件能力表算的同一个值,那一侧不在这里。
 *
 * 输出节点自己是卡片、上游里没有别的卡的控件(普通卡片段),补出来的 `cardId` 与原来相同,`cardIds` 只有它一张,
 * 切出的任务逐字段不变。
 */
export function withInnerCards(cardPlan, graph) {
  const inner = innerCardIds(graph);
  const own = new Map((graph?.nodes ?? []).map(node => [node?.id, typeof node?.cardId === 'string' && node.cardId ? node.cardId : null]));
  return (cardPlan ?? []).map(control => {
    const { cardIds, unsure, canvasHeavy } = inner(control?.nodeId);
    const given = typeof control?.cardId === 'string' && control.cardId ? control.cardId : null;
    const all = given && !cardIds.includes(given) ? [given, ...cardIds] : cardIds;
    const cardId = given ?? own.get(control?.nodeId) ?? (all.length === 1 && !unsure ? all[0] : null);
    const out = { ...control, cardId, cardIds: [...all] };
    if (unsure) out.cardIdsUnsure = true;
    if (canvasHeavy && control?.capabilities?.canvasHeavy !== true) out.innerCanvasHeavy = true;
    return out;
  });
}

/**
 * 这张卡纯浏览器做不做得了(M7 契约 D1、D4):共享档、独立卡、light / medium、不用只在发布方本机的素材;
 * 内置卡片要没改过源码(`cardSources` 为空);用户卡、素材效果卡(块 N)要本页声明能运行(`pageCards`)且这张卡要的代码身份本页都有;
 * 另外不是画布卡(`canvasHeavy`:逐帧顺推与桌面不等价)、
 * (Lottie 素材卡不再排除:2026-10-14 渲染重构「癸二」量过,浏览器当场生成快照画成位图的体积、耗时和别的内置重卡同一量级,见 `docs/plan/render-standard.md` 的 Lottie 一节)、
 * 里面不超过一张卡且认得出是哪张(`cardIdsOf`、`cardIdsUnsure`;拿不准一律不给)、
 * 调用方没标它的帧超体积上限(`control.snapshotOversize`,执行器按本机快照库里已记为超限的内容键给)。
 * `requires` 是这张卡自己那一份的 requires(已含 localMedia)。
 */
function browserEligible({ tier, compositing, requires, weight, control, pageCards = null }) {
  return tier === 'shared' && compositing === 'independent'
    && cardCodeAllowed(requires, pageCards)
    && !('localMedia' in requires)
    && BROWSER_WEIGHTS.has(weight?.class)
    && control?.capabilities?.canvasHeavy !== true && control?.innerCanvasHeavy !== true
    && cardIdsOf(control).length <= 1 && control?.cardIdsUnsure !== true
    && control?.snapshotOversize !== true;
}

/** 这张卡的任务用不用在节点里执行用户卡、素材效果卡的代码 */
const runsCardCode = requires => requires.userCards === true || requires.graphCards === true;

/**
 * 卡片代码这一条(`browserEligible` 的一部分):
 *   内置卡片:`cardSources` 为空(没改过源码);
 *   用户卡、素材效果卡:页面声明了对应能力、`cardSources` 非空(用户卡一定有代码身份,空了说明切分方没有身份可对)、
 *   每一项的代码身份页面都在 `pageCards.cardSources` 里(同一张卡的身份对不上就是页面手里是另一版,不给)。
 */
function cardCodeAllowed(requires, pageCards) {
  const sources = Object.entries(requires.cardSources ?? {});
  if (!runsCardCode(requires)) return requires.userCards === false && requires.graphCards === false && sources.length === 0;
  if (!pageCards) return false;
  if (requires.userCards === true && !pageCards.userCards) return false;
  if (requires.graphCards === true && !pageCards.graphCards) return false;
  if (sources.length === 0) return false;
  return sources.every(([cardId, version]) => pageCards.cardSources?.[cardId] === version);
}

/** 浏览器那一份要的隔离单卡工程参数(M7 契约第 4.3 节):页面照桌面 `isolatedCardProject` 的变换载入,不算 cardSampling */
function bakeInputOf(control) {
  const out = { start: control.start, end: control.end, count: control.count };
  if (control.sampling != null) out.sampling = structuredClone(control.sampling);
  return out;
}

const isInt = Number.isInteger;
const isNum = Number.isFinite;

/**
 * 浏览器那一份流任务的 `input.stream`:只认单卡流(`kind: 'card'`、`plane: 'local'`、成员恰好是这一张卡),字段齐、形状对才给;
 * 否则回 null(组流、旧调用方只给了流键与分段范围的流,都不出浏览器那一份)。`count` 取成员卡的帧数:本地帧 0 .. count-1 之外的帧是全透明。
 * `originFrame` / `lastFrame`:这条流自己的第一帧和最后一帧(项目帧号)。页面按它们把分段号换成帧(`streamSegments.mjs`),不自己算;
 * 流的计划没给这两项(改分段规则之前的调用方)就不出浏览器那一份。
 * 流标了 `solo`(源依赖卡的流:要解素材、执行素材效果卡;框用了三维的独立卡的流:浏览器那条取像素的路没有验过)也不出:
 * 这两类只由桌面应用和渲染主机产,浏览器节点收不到这种任务(切分方自己的那一份要本机转码,`filter.mjs` 规则 2 本来就挡着)。
 * 例外是 `solo: 'flat'`(剪辑段里摊出来的独立卡)里外框平面的那些:〔裁〕R02(2026-10-22 用户定「在线浏览器也替剪辑段里的重卡产流」),
 * 和顶层的平面独立卡一样给浏览器出一份。浏览器按任务的片段 id 认出它是虚拟片段,隔离工程带着剪辑段链建
 * (`src/online/bakeTask.ts` 的 `isolatedBakeProject`),后台舞台在嵌套场景里取这张卡的包裹层(`src/StageView.tsx` 的 `bakeFrame`)。
 * 外框三维的(`control.appearance.frame`)照旧只由桌面应用和渲染主机产,同顶层的 `'spatial'`。
 */
function browserStreamInputOf(stream, control) {
  if (stream?.kind !== 'card' || stream.plane !== 'local') return null;
  // 单独成流的两类卡(`frame-stream.mjs` 的 `soloStreamKind`:源依赖卡、框用了三维的独立卡)只出切分方自己的那一份;
  // 剪辑段里外框平面的独立卡(`'flat'`)例外(〔裁〕R02,见上)
  if (stream.solo && !(stream.solo === 'flat' && !frame3d(control?.appearance?.frame ?? control?.frame))) return null;
  const ids = stream.clipIds;
  if (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== stream.topClipId || control?.clipId !== ids[0]) return null;
  const { bound, offset } = stream;
  const fps = Number(stream.fps), firstFrame = stream.firstFrame, total = stream.total, count = Number(control.count);
  const { originFrame, lastFrame } = stream;
  if (!(fps > 0) || !isInt(firstFrame) || !isInt(total) || total < 1 || !isInt(count) || count < 1) return null;
  if (!isStreamOrigin(originFrame) || !isInt(lastFrame) || lastFrame < originFrame) return null;
  if (!bound || !isInt(bound.x) || !isInt(bound.y) || !isInt(bound.w) || !isInt(bound.h) || bound.w < 2 || bound.h < 2 || bound.w % 2 || bound.h % 2) return null;
  if (!offset || !isNum(offset.x) || !isNum(offset.y)) return null;
  return { kind: 'card', plane: 'local', clipIds: [ids[0]], fps, bound: { x: bound.x, y: bound.y, w: bound.w, h: bound.h },
    offset: { x: offset.x, y: offset.y }, firstFrame, count, total, originFrame, lastFrame };
}

/** → TaskInput[]:先快照(按 cardPlan 顺序、段升序),后轨道流(按 streams 顺序、段升序);同一 id 只留第一个。 */
export function splitPlan({
  planTask,
  entryKey,
  cardPlan,
  prerenderSet,
  streams = [],
  envFingerprint,
  codeVersion,
  cardSourceVersions = {},
  streamCardSources = null, // (stream) => Record<cardId, version>:一条流展开出的子集里用到的定制卡(见 `streamSources`);不给就要全部
  anchorFrames = [],
  weightOf = () => ({ class: 'heavy', estMs: null }),
  isUserCard = () => false,
  isGraphCard = () => false,
  constants = {},
  cardLocks = {},           // Map | Record<lockKey, envFingerprint>(契约 F.2)
  takeover = false,         // boolean | Set<lockKey> | (lockKey) => boolean
  localMedia = null,        // 发布方的 nodeId(M6c X2):给了,且 usesLocalMedia 判真的任务写进 requires.localMedia
  usesLocalMedia = () => true,   // (control) => boolean;流任务传 { clipId: topClipId, kind: 'stream' }
  lane = 'normal',          // 'backfill':预渲染重试计划任务切出的细任务,priority 一律标 'backfill'(c10a 契约第 17 节)
  sparseStreams = false,    // 队列认不认稀疏流任务(`node.welcome.sparseStreams`):为真才切稀疏流任务,见文件头「稀疏流任务」
  browserFingerprints = [], // 本项目在线、同一用户的纯浏览器节点的指纹(M7 契约 D1):浏览器可做、没锁的卡另出这些指纹的一份
  browserCards = null,      // 块 N:本页能运行的用户卡、素材效果卡(`browserCardsOf(planTask.input.browser)` 的结果),见上文「用户卡、素材效果卡也可以给浏览器」
  browserCardEnvFingerprints = [], // 块 N:文档服务确认的在线浏览器节点的 cardEnvFingerprint;`browserCards.cardEnvFingerprint` 不在里面就不出用户卡、素材效果卡的浏览器那一份
  exportStreams = [],       // 导出专用的逐帧位图(只为导出的清单计划才有),见文件头「导出专用的逐帧位图」
  browser = null,           // 同上的另一种写法:`{ nodeId, envFingerprint }` 或它的数组(契约第 3.3 节的形状)。
                            // 注意:切分方不读 `planTask.input.browser`(页面自报的),浏览器指纹以文档服务给的为准
}) {
  /** 细任务的 priority:预渲染重试档一律 'backfill';normal 档照旧按锚帧给整数名次 */
  const priorityOf = anchored => (lane === 'backfill' ? 'backfill' : anchored ? ANCHOR_PRIORITY : NORMAL_PRIORITY);
  const snapshotSpan = stepOf(constants.SNAPSHOT_SPAN ?? QUEUE_DEFAULTS.SNAPSHOT_SPAN);
  const streamSegments = stepOf(constants.STREAM_SEGMENTS ?? QUEUE_DEFAULTS.STREAM_SEGMENTS);
  const { projectId, projectRev } = planTask?.source ?? {};
  const derivedFrom = planTask?.id ?? null;
  const anchors = [...(anchorFrames ?? [])];
  const lockOf = lockLookup(cardLocks);
  const takesOver = takeoverTest(takeover);
  /** 浏览器指纹:非空字符串、去重、不等于自己的指纹(相同就不必另出一份) */
  const browserAlias = (Array.isArray(browser) ? browser : browser != null ? [browser] : []).map(b => b?.envFingerprint);
  /** 浏览器指纹(非空字符串、去重);其中等于自己指纹的不另出一份,但自己那份同样要带页面生成快照的两项 */
  const browserSet = new Set([...(Array.isArray(browserFingerprints) ? browserFingerprints : []), ...browserAlias]
    .filter(fp => typeof fp === 'string' && fp !== ''));
  const browserFps = [...browserSet].filter(fp => fp !== envFingerprint);
  /** 本页的用户卡、素材效果卡运行情况:页面自报、且文档服务确认过有这样一台在线节点才算数 */
  const cardEnvSet = new Set((Array.isArray(browserCardEnvFingerprints) ? browserCardEnvFingerprints : []).filter(fp => typeof fp === 'string' && fp !== ''));
  const pageCards = browserCards && typeof browserCards.cardEnvFingerprint === 'string' && cardEnvSet.has(browserCards.cardEnvFingerprint) ? browserCards : null;
  const mediaOwner = typeof localMedia === 'string' && localMedia !== '' ? localMedia : null;
  /** 本地档能力闸(M6c X2):这一项的输入用到只在发布方本机的素材时,requires 加 `localMedia` */
  const gateLocalMedia = (requires, control) => {
    if (mediaOwner !== null && usesLocalMedia(control) === true) requires.localMedia = mediaOwner;
    return requires;
  };
  /**
   * 这一层按哪个指纹出键:`{ fingerprint, takeover }`。`takeover` 只在真的接手别的指纹时为真;
   * 没锁或同指纹时任务不加这个字段(契约 F.2)。
   */
  const keyingOf = lockKey => {
    const locked = lockOf(lockKey);
    if (locked == null || locked === envFingerprint) return { fingerprint: envFingerprint, takeover: false };
    if (takesOver(lockKey)) return { fingerprint: envFingerprint, takeover: true };
    return { fingerprint: locked, takeover: false };
  };
  /**
   * 卡片代码要求(c66-host-cards,契约 B.4〔c66-host-cards 改〕):`cardSourceVersions` 是这一版用到的定制卡
   * (用户卡、改动层里改过的卡)的代码身份。共享档只画这一张卡,只要它自己的;本地档与流画的是整个场景
   * (本地档的内容键里有 entry.key,整场景键带着全部定制卡的身份),要全部。
   */
  const allCardSources = () => {
    const out = {};
    for (const [cardId, version] of Object.entries(cardSourceVersions ?? {})) if (typeof version === 'string' && version) out[cardId] = version;
    return out;
  };
  /**
   * 一条流(切分方自己的那一份)要的代码身份(0.7.19 多项目模式:按这条流展开出的子集算,`render-node/expand.mjs` 的
   * `streamNeed` / `subsetCardSources`;产流的节点按同一个子集建隔离工程)。调用方没给 `streamCardSources`(旧执行器、测试替身)
   * 或算不出时照旧要全部
   */
  const streamSources = stream => {
    if (typeof streamCardSources !== 'function') return allCardSources();
    let got = null;
    try { got = streamCardSources(stream); } catch { got = null; }
    if (!got || typeof got !== 'object') return allCardSources();
    const out = {};
    for (const [cardId, version] of Object.entries(got)) if (typeof version === 'string' && version && cardSourceVersions?.[cardId] === version) out[cardId] = version;
    return out;
  };
  /** 一张卡的重度:调用方给的;里面有画布卡而控件自己没标的(`innerCanvasHeavy`)照画布卡记「重」 */
  const cardWeightOf = control => (control?.innerCanvasHeavy === true ? { ...weightOf(control), class: 'heavy' } : weightOf(control));
  /**
   * 只画这一个片段的任务(共享档快照、单卡流的浏览器那一份)要的代码身份:片段里面每张定制卡各一项(`cardIdsOf`:
   * 挂了强调、滤镜的片段取里面那张);里面是什么拿不准(`cardIdsUnsure`)就要全部。
   */
  const ownCardSources = control => {
    if (control?.cardIdsUnsure === true) return allCardSources();
    const out = {};
    for (const cardId of cardIdsOf(control)) {
      const version = cardSourceVersions?.[cardId];
      if (version) out[cardId] = version;
    }
    return out;
  };
  /**
   * 这张卡的结果浏览器出哪几份(M7 D1,块 N;快照与单卡流共用):`eligible` 做不做得了;`copyFps` 另出哪些指纹(用户卡、素材效果卡用页面的
   * cardEnvFingerprint,内置卡片用浏览器的 envFingerprint);`browserOf` 哪些指纹的那一份要带页面要的输入。
   */
  const browserPlanOf = ({ tier, compositing, requires, weight, control }) => {
    const cardTask = runsCardCode(requires);
    const eligible = (cardTask ? pageCards !== null : browserSet.size > 0) && browserEligible({ tier, compositing, requires, weight, control, pageCards });
    const copyFps = cardTask ? (pageCards ? [pageCards.cardEnvFingerprint] : []) : browserFps;
    const browserOf = cardTask ? new Set(copyFps) : browserSet;
    return { eligible, copyFps, browserOf };
  };
  const out = [];
  const seen = new Set();
  const emit = task => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    out.push(task);
  };

  for (const control of cardPlan ?? []) {
    const { snapshotKey, clipId } = control ?? {};
    if (!snapshotKey || !clipId) continue;
    if (prerenderSet && !prerenderSet.has(clipId)) continue;
    const tier = control.tier ?? snapshotTier(control.capabilities);
    if (tier !== 'shared' && tier !== 'local') continue;
    // 本地档的内容键要 entry.key;没给就跳过,不生成 `undefined/<共享键>` 这种键(契约 A.10a)
    if (tier === 'local' && (entryKey == null || entryKey === '')) continue;
    const baseKey = control.contentKey ?? snapshotKey;
    const contentKey = tier === 'shared' ? baseKey : `${entryKey}/${baseKey}`;
    const lockKey = `snapshot:${contentKey}`;
    const keying = keyingOf(lockKey);
    const cardId = control.cardId ?? null;
    // 决定清单的体积上限,推送与拉取两边要一致(C6.2 第 11 节第 2 条,J.3)
    const canvasHeavy = control.capabilities?.canvasHeavy === true;
    const compositing = control.compositing ?? control.capabilities?.compositing;
    // 锚帧是全局帧号,换成这张卡的本地帧再比;没有 firstFrame 就判不了,一律按普通段
    const firstFrame = Number(control.sampling?.firstFrame);
    const requires = {
      envFingerprint: keying.fingerprint, codeVersion,
      cardSources: tier === 'local' ? allCardSources() : ownCardSources(control),
      transcode: false,
      userCards: !!isUserCard(control),
      graphCards: !!isGraphCard(control),
      belowDependent: compositing === 'belowDependent',
    };
    gateLocalMedia(requires, control);
    const weight = cardWeightOf(control);
    // M7 D1:这张卡出哪几份。没锁(或锁在自己的指纹上)、浏览器做得了时另出浏览器指纹的;锁在别处的照锁只出一份
    // 用户卡、素材效果卡(块 N)的浏览器那一份用页面的 cardEnvFingerprint;内置卡片照旧用浏览器的 envFingerprint
    const { eligible, copyFps, browserOf } = browserPlanOf({ tier, compositing, requires, weight, control });
    const fingerprints = eligible && lockOf(lockKey) == null && keying.fingerprint === envFingerprint ? [keying.fingerprint, ...copyFps] : [keying.fingerprint];
    const dual = fingerprints.length > 1;
    for (const fingerprint of fingerprints) {
      const resultKey = resultKeyOf(contentKey, fingerprint);
      // 浏览器那一份(或锁在浏览器指纹上、照锁出的那一份)带页面生成快照要的两项
      const forBrowser = eligible && browserOf.has(fingerprint);
      const inputOf = () => {
        const input = { clipId, cardId, entryKey: tier === 'local' ? entryKey : null, contentKey, canvasHeavy };
        if (dual) input.dual = true;
        if (forBrowser) Object.assign(input, { compositing, bake: bakeInputOf(control) });
        return input;
      };
      for (const [from, to] of spans(0, Number(control.count) - 1, snapshotSpan)) {
        const range = { unit: 'localFrame', from, to };
        const anchored = anchors.some(a => from <= a - firstFrame && a - firstFrame <= to);
        const task = {
          id: taskIdOf({ kind: 'snapshot', resultKey, range }), kind: 'snapshot', tier, resultKey, range,
          source: { projectId, projectRev, derivedFrom },
          input: inputOf(),
          weight: { ...weight, frames: to - from + 1 },
          requires: { ...requires, envFingerprint: fingerprint, cardSources: { ...requires.cardSources } },
          priority: priorityOf(anchored),
        };
        if (keying.takeover) task.takeover = true;
        emit(task);
      }
    }
  }

  /** 流的成员卡:clipId → control(card plan 里的那一项,带 cardId 与执行器标的 snapshotOversize) */
  const controlOf = new Map();
  for (const control of cardPlan ?? []) if (control?.clipId && !controlOf.has(control.clipId)) controlOf.set(control.clipId, control);

  for (const stream of streams ?? []) {
    const { streamKey, topClipId, firstSegment, lastSegment } = stream ?? {};
    if (!streamKey) continue;
    const contentKey = stream.contentKey ?? streamKey;
    const lockKey = `stream:${contentKey}`;
    const keying = keyingOf(lockKey);
    // 依赖下层的流:整场景渲,只出切分方自己的一份(下面 `browserStreamInputOf` 不认它,`browser` 恒为 null)
    const belowStream = stream.kind === 'below';
    const weight = belowStream ? { ...weightOf(controlOf.get(topClipId) ?? { clipId: topClipId }), class: 'heavy' } : weightOf(controlOf.get(topClipId) ?? { clipId: topClipId });
    // 浏览器那一份(单卡流):成员卡照快照任务的规矩判做不做得了,requires 也照那张卡的快照任务写(只画这一张卡)
    const control = controlOf.get(topClipId) ?? null;
    const streamInput = control ? browserStreamInputOf(stream, control) : null;
    let browser = null;
    if (streamInput) {
      const caps = control.capabilities ?? {};
      const isStateful = control.tier === 'shared' || caps.frameMode === 'stateful' || caps.need_prerendering === true || caps.needPrerendering === true || control.needPrerendering === true;
      if (isStateful) {
        const tier = 'shared';
        const compositing = control.compositing ?? caps.compositing;
        const requires = gateLocalMedia({
          envFingerprint: keying.fingerprint, codeVersion,
          cardSources: ownCardSources(control),
          transcode: false,
          userCards: !!isUserCard(control),
          graphCards: !!isGraphCard(control),
          belowDependent: compositing === 'belowDependent',
          capabilities: { streams: true },
        }, control);
        const cardWeight = cardWeightOf(control);
        const plan = browserPlanOf({ tier, compositing, requires, weight: cardWeight, control });
        if (plan.eligible) {
          // 流的浏览器那一份不含切分方自己的指纹:同指纹时两份的任务 id 相同,而切分方那一份要本机转码
          const copyFps = plan.copyFps.filter(fp => fp !== envFingerprint);
          browser = { copyFps, browserOf: new Set(copyFps), requires, weight: cardWeight, compositing, control, input: streamInput };
        }
      }
    }
    // 出哪几份:没锁(或锁在自己的指纹上且不接手)时切分方一份、浏览器各一份;锁在别处照锁只出一份
    const wantsOwn = stream.browserOnly !== true;
    // 自己的那一份只出稀疏版(见文件头「稀疏流任务」);队列不认稀疏流任务时这一份等于不出
    const ownSparseOnly = stream.ownSparseOnly === true;
    const copies = [];
    if (browser && lockOf(lockKey) == null && keying.fingerprint === envFingerprint) {
      if (wantsOwn && !(ownSparseOnly && browser.copyFps.length > 0)) copies.push({ fingerprint: keying.fingerprint, forBrowser: false });
      for (const fingerprint of browser.copyFps) copies.push({ fingerprint, forBrowser: true });
    } else {
      const forBrowser = !!browser && browser.browserOf.has(keying.fingerprint);
      if (forBrowser || wantsOwn) copies.push({ fingerprint: keying.fingerprint, forBrowser });
    }
    const isMotion = isMotionCard(control, stream);
    const streamFps = Number(stream?.fps) > 0 ? Number(stream.fps) : 30;
    const motionSpan = Math.ceil(30 * streamFps / SEGMENT_FRAMES);
    const dual = copies.length > 1;
    for (const { fingerprint, forBrowser } of copies) {
      const resultKey = resultKeyOf(contentKey, fingerprint);
      // 先稀疏、后满密度(同一条流里稀疏任务排在前面发);自己的那一份标了 `ownSparseOnly` 时不出满密度的
      const densities = [...(sparseStreams === true ? [STREAM_DENSITY_SPARSE] : []), ...(!forBrowser && ownSparseOnly ? [] : [null])];
      for (const density of densities) {
        const span = density === STREAM_DENSITY_SPARSE
          ? Math.max(1, lastSegment - firstSegment + 1)
          : isMotion
            ? motionSpan
            : streamSegments;
        const minSpan = (!density && isMotion) ? motionSpan : 1;
        for (const [from, to] of spans(firstSegment, lastSegment, span, minSpan)) {
        const range = { unit: 'segment', from, to };
        // 这一段任务的帧数:流的计划带着第一帧和最后一帧时按实际算(流的末段可以不满 15 帧),没带的照满段估
        let frames = (to - from + 1) * SEGMENT_FRAMES;
        if (isStreamOrigin(stream.originFrame) && isInt(stream.lastFrame)) {
          frames = 0;
          for (let n = from; n <= to; n++) frames += streamSegmentFrameCount(n, stream.originFrame, stream.lastFrame);
        }
        const input = forBrowser
          ? { clipId: topClipId, cardId: browser.control.cardId ?? null, entryKey: null, contentKey, canvasHeavy: false }
          : { clipId: topClipId, cardId: null, entryKey: null, contentKey };
        if (dual) input.dual = true;
        if (density) input.density = density;
        if (forBrowser) Object.assign(input, { compositing: browser.compositing, bake: bakeInputOf(browser.control), stream: structuredClone(browser.input) });
        const task = {
          id: taskIdOf({ kind: 'stream', resultKey, range, density }), kind: 'stream', resultKey, range,
          source: { projectId, projectRev, derivedFrom },
          input,
          weight: forBrowser ? { ...browser.weight, frames } : { ...weight, frames },
          requires: forBrowser
            ? { ...browser.requires, envFingerprint: fingerprint, cardSources: { ...browser.requires.cardSources }, capabilities: { streams: true } }
            : gateLocalMedia({
              envFingerprint: fingerprint, codeVersion, cardSources: streamSources(stream),
              transcode: true, userCards: false, graphCards: false, belowDependent: belowStream,
              // M6c X1:只有报了 `capabilities.streams: true`(探到编码器)的节点能认领(filter.mjs 规则 2)
              capabilities: { streams: true },
            }, belowStream
              ? { clipId: topClipId, kind: 'stream', streamKind: 'below', belowClipIds: Array.isArray(stream.belowClipIds) ? [...stream.belowClipIds] : [] }
              : { clipId: topClipId, kind: 'stream' }),
          priority: density && lane !== 'backfill' ? SPARSE_STREAM_PRIORITY : priorityOf(false),
        };
        // 接手只属于切分方自己的那一份;浏览器那一份照快照的规矩不带
        if (keying.takeover && !forBrowser) task.takeover = true;
        emit(task);
      }
    }
  }
}

  // 导出专用的逐帧位图:每条一组,只出自己的一份(见文件头)
  for (const stream of exportStreams ?? []) {
    const { clipId, exportKey, lastSegment } = stream ?? {};
    if (typeof clipId !== 'string' || !clipId || typeof exportKey !== 'string' || !exportKey || !isInt(lastSegment) || lastSegment < 0) continue;
    if (typeof envFingerprint !== 'string' || !envFingerprint) continue;
    const resultKey = resultKeyOf(exportKey, envFingerprint);
    const belowStream = stream.kind === 'below';
    const control = controlOf.get(clipId) ?? { clipId };
    const weight = belowStream ? { ...weightOf(control), class: 'heavy' } : weightOf(control);
    for (const [from, to] of spans(0, lastSegment, streamSegments)) {
      const range = { unit: 'segment', from, to };
      let frames = (to - from + 1) * SEGMENT_FRAMES;
      if (isStreamOrigin(stream.originFrame) && isInt(stream.lastFrame)) {
        frames = 0;
        for (let n = from; n <= to; n++) frames += streamSegmentFrameCount(n, stream.originFrame, stream.lastFrame);
      }
      emit({
        id: taskIdOf({ kind: 'stream', resultKey, range }), kind: 'stream', resultKey, range,
        source: { projectId, projectRev, derivedFrom },
        input: { clipId, cardId: null, entryKey: null, exportFrames: true, exportKey, ...(stream.salt ? { exportSalt: stream.salt } : {}),
          stream: { clipId, kind: stream.kind, plane: stream.plane, fps: stream.fps, originFrame: stream.originFrame, lastFrame: stream.lastFrame,
            rect: stream.rect ? { ...stream.rect } : null, offset: stream.offset ? { ...stream.offset } : null } },
        weight: { ...weight, frames },
        requires: gateLocalMedia({
          envFingerprint, codeVersion, cardSources: allCardSources(),
          transcode: false, userCards: false, graphCards: false, belowDependent: belowStream,
        }, belowStream
          ? { clipId, kind: 'stream', streamKind: 'below', belowClipIds: Array.isArray(stream.belowClipIds) ? [...stream.belowClipIds] : [] }
          : { clipId, kind: 'stream' }),
        priority: EXPORT_FRAMES_PRIORITY,
      });
    }
  }
  return out;
}
