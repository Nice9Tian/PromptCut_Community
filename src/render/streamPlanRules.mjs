/**
 * 划分轨道流时「哪张卡出哪一种流」的判据 —— **唯一出处**。预渲染进程、渲染主机(`server/frame-stream.mjs` 的 `planStreams`)
 * 与在线页面(`src/online/pageStreamPlan.ts` 的 `planPageStreams`)都从这里取,所以两边对「哪些流占解码器预算、哪几张独立卡要并进组流」
 * 判得一样:页面只产平面独立卡的单卡流,但单独成流的两类卡(`soloStreamKind`)和依赖下层的流(`belowTargets`)
 * 也照切分方的算法算进预算(`docs/reports/AGENT-rr-page-plan-parity.md`)。
 *
 * 原来写在 `server/frame-stream.mjs` 里,挪过来一字不改;那里照旧以原名再导出。纯函数,不碰文件、网络、注册表。
 * `control` 是卡片计划的一项(`clipId`、`count`、`sampling`、`compositing` 或 `capabilities.compositing`),`clip`、`track` 是项目里的片段与序列。
 */
import { mountFrameOf } from './frameWindow.mjs';

/** 外框用了三维变形(`rotateX`、`rotateY`、`translateZ` 有一项非零) */
export const frame3d = frame => !!(frame?.rotateX || frame?.rotateY || frame?.translateZ);

/**
 * 这张卡是不是**平面的独立卡**(单卡流里可以和相邻的独立卡并成组流的那一种)。**只收 `independent`**:毛玻璃(`belowDependent`)
 * 要采样下层,`unknown` 一律按 `belowDependent` 处理(G1「哪些卡不进流」)。源依赖卡(转场、接素材的素材效果卡)和框用了三维的
 * 独立卡不在这里:它们同样产单卡流,但单独成流、不并进组流,判据在下面的 `soloStreamKind`。
 */
export function streamEligible(control, clip, track) {
  if (!control?.clipId || !clip || !track) return false;
  if (track.hidden || track.sourceOnly) return false;
  if (!clip.cardId) return false;
  // 剪辑段里摊出来的卡单独成流(`soloStreamKind` 的 `'flat'`),不并进组流
  if (clip.flat) return false;
  const compositing = control.capabilities?.compositing ?? control.compositing;
  if (compositing !== 'independent') return false;
  if (frame3d(clip.frame)) return false;
  return Number.isInteger(control.count) && control.count > 0;
}

/** 项目里 `id` 是这个值的卡片节点(`project.cardNodes`;数组,旧数据里也可能是按 id 存的对象) */
export function cardNodeOf(project, nodeId) {
  if (typeof nodeId !== 'string' || !nodeId) return null;
  const raw = project?.cardNodes;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  return list.find(node => node?.id === nodeId) ?? null;
}

/**
 * 这个片段是不是**接着输入的素材效果卡**(转场、套在素材上的滤镜这一类):片段挂的节点是出画面的素材效果卡节点
 * (判据同 `src/render/cards/GraphCard.tsx` 的 `graphVisualNode`),而且它有输入(接素材、接别的片段、接另一张素材效果卡;
 * 输入指向的片段已经删掉的也算 —— 边还记在节点上)。没有输入的素材效果卡(自己生成画面的)不算。
 */
export function graphCardWithInputs(project, clip) {
  const node = cardNodeOf(project, clip?.nodeId);
  if (!node || node.adapter !== 'card' || node.kind === 'audio') return false;
  return !!node.inputs && typeof node.inputs === 'object' && Object.keys(node.inputs).length > 0;
}

/**
 * 两类**单独成流**的卡(`docs/semantics/mechanism/rendering.md`「重管线:预渲染」「怎么产,按卡分」;用户 2026-10-13 定,
 * `docs/plan/user-decisions-2026-10-13.md` 第 1 节第 7 条)。它们各产一条单卡流(`kind: 'card'`、`plane: 'local'`,和独立卡的单卡流
 * 同一种形状、走同一套稀疏版与满密度版、分段、位置矩形、任务队列),只是不参加组流合并,浏览器也不产(见下):
 *
 *   - `'source'` **源依赖卡**:转场、套在视频上的素材效果卡 —— 画面取决于别的素材或别的片段。连同它用到的视频一起渲:
 *     隔离工程里它的源片段都留着(藏起来的序列是 `sourceOnly`,不出画,素材效果卡解输入时找得到),流里就是「视频经过这张卡以后」
 *     的画面;贴的时候这条流顶替这张卡原来的画面(套在视频上的那一种,这一段的视频本来就由这张卡画,不另画)。
 *     判据:审阅表写了 `sourceDependent`;或者没有审阅过(`unknown`、旧的统称 `context`)而片段挂着接了输入的素材效果卡节点
 *     (`graphCardWithInputs`)。素材效果卡的画面是宿主照它给的描述在画布上执行出来的,采样不到下面的层,所以不走「依赖下层的流」。
 *     流键里顺着输入带着整条源链(`CardFrameCache.plan` 的 `streamMemberKey`:素材本身、素材的裁剪起点、每条输入的时间映射、
 *     上游各张卡的参数与源码版本),页面的输入签名同样(`src/render/layerInputSig.mjs`),任一变了旧流就不再贴;
 *   - `'spatial'` **外框用了三维变形的独立卡**:流里是变形之前的平面画面(隔离工程里框只留位置和宽高,`localClip`),
 *     贴的时候流平面是包裹层的子元素,包裹层照常带着三维变形,所以画面跟着变形。三维那几项不进流键(它们不在流里)。
 *
 *   - `'flat'` **剪辑段里摊出来的独立卡**(`src/kernel/cutFlatten.mjs`;用户 2026-10-21 定:剪辑段里的卡和没有剪辑段时一样,
 *     重卡各自走轨道流):流里是这张卡在它自己包裹层里的画面(平面的和外框三维的都一样,三维那几项不在流里),贴的时候嵌套场景
 *     外面那几层(段的框、不透明度、淡入淡出)照常加。产流的隔离工程要带着这条剪辑段链(`isolatedFlatProject`),
 *     所以不并进组流(组流按舞台坐标画,嵌套场景里的卡摆不进去)。浏览器也产外框平面的那些(〔裁〕R02:在线浏览器也替剪辑段里的重卡产流;
 *     外框三维的和顶层的 `'spatial'` 一样只由桌面应用和渲染主机产,见 `render-node/split.mjs` 的 `browserStreamInputOf`)。
 *     只收独立卡:剪辑段里依赖下层、源依赖、没审阅过的卡不产流,照旧在嵌套场景里活渲(〔裁〕R01 2026-10-23 用户推翻「带着下层一起产流」,
 *     按做不通处理:嵌套场景里的毛玻璃会透过剪辑段采样段外面的层,只带段里下层的流和活渲对不上)。
 *
 * 两类同时成立时算 `'source'`(框的三维照样不在流里)。别的卡回 null:平面的独立卡走 `streamEligible`,
 * 依赖下层的、没审阅过又没接输入的走 `belowStreamEligible`(外框带不带三维都走那条路:带三维时三维摆放画进流里)。
 *
 * 不参加组流合并:组流按舞台坐标产,成员的外观(含三维)全画进流里,和「流里是变形之前的画面」对不上;源依赖卡多半整幅不透明,
 * 并进组流会把夹在中间的层关系压平。它们各占一个解码器,算进预算。
 * 浏览器不产(`'flat'` 里外框平面的那些除外,见上):源依赖卡要解素材、执行素材效果卡,三维外框的卡浏览器那条取像素的路没有验过;
 * 切分不出浏览器那一份(`render-node/split.mjs` 的 `browserStreamInputOf`),在线页面本页产流也不认它们(`src/online/pageStreamPlan.ts`),只算进预算。
 */
export function soloStreamKind(control, clip, track, project) {
  if (!control?.clipId || !clip || !track) return null;
  if (track.hidden || track.sourceOnly) return null;
  if (!clip.cardId) return null;
  if (!(Number.isInteger(control.count) && control.count > 0)) return null;
  const compositing = control.capabilities?.compositing ?? control.compositing;
  // 剪辑段里摊出来的卡(`kernel/cutFlatten.mjs`,片段带 `flat`):独立卡单独成流(见上 `'flat'`),别的不产流
  if (clip.flat) return compositing === 'independent' ? 'flat' : null;
  if (compositing === 'sourceDependent') return 'source';
  if (compositing === 'independent') return frame3d(clip.frame) ? 'spatial' : null;
  if (compositing === 'belowDependent') return null;
  return graphCardWithInputs(project, clip) ? 'source' : null;
}

/**
 * 「依赖下层的流」收哪些卡(契约第 5.1 节)之外,另外两类卡进不进:
 *   - `sourceDependent`(不进):源依赖卡(转场、接素材的素材效果卡)。用户 2026-10-13 定它单独成流(上面的 `soloStreamKind`),
 *     `planStreams` 先把它挑走;
 *   - `frame3d`(**进**):**依赖下层(或没审阅过、又没接输入)而外框又用了三维变形的卡**。它的画面取决于它在屏幕上盖住了什么,
 *     产不出「变形之前的画面」,所以照普通的依赖下层的流产:按舞台坐标,三维摆放(`rotateX`、`rotateY`、`translateZ`,
 *     连同项目的透视 `camera3dFov`)照原样画进流里;贴的时候平面挂在舞台根下,不再做变形(舞台的透视只作用在带三维变形的
 *     直接子元素上,平面没有变形,不受它影响)。后果:改一下三维角度流就要重产 —— 三维那几项在目标卡的缓存内容键里
 *     (`server/card-cache.mjs` 的 `appearance.frame`),也在页面的输入签名里(`streamInputSig.mjs` 的 `frame`),
 *     改了键和签名都变,旧流当场不再贴。〔裁:主会话 2026-10-14,按建议的「甲」定,用户可以推翻;`AGENT-rr-below-3d.md`〕
 *     差分取层对它照旧成立(两张都是整幅截图逐像素算,不看卡摆成什么样);只是毛玻璃外框的掩码不收带三维的
 *     (`capture-below.mjs` 的 `axisAligned`:投影以后外框不是圆角矩形),那一块照最小不透明度算,盖回去仍然等于原画面。
 * 外框用了三维的**独立卡**不走这条路(它的流里是变形之前的画面,`soloStreamKind` 的 `'spatial'`),不管这里怎么设。
 */
export const BELOW_STREAM_RULES = Object.freeze({ sourceDependent: false, frame3d: true });

/**
 * 回放从哪一刻挂载算:剪辑段里摊出来的片段(带 `flat`)从嵌套场景最早挂上的那一刻起(`flat.mount`,预卷不会比它更早),
 * 别的片段就是它自己(原样回同一个对象)。与 `server/frame-stream.mjs` 里同名的那一份一字不差;在线页面算预算时用它
 * (`src/online/pageStreamPlan.ts`,剪辑段里单独成流的卡的解码器窗口和切分方一样从这一帧算)。
 */
export function mountClipOf(clip) {
  const mount = clip?.flat?.mount;
  return Number.isFinite(mount) ? { ...clip, start: Math.min(clip.start, mount) } : clip;
}

/**
 * 这张卡进不进「依赖下层的流」。收:依不依赖下层这一样是「依赖下层」(`belowDependent`)、旧的统称 `context`、
 * 或「未知」(`unknown`,审阅表没覆盖到的卡;没写、认不出的值也按未知)的卡,外框带三维的也收(`rules.frame3d`)。
 * 独立卡一律不进这里(平面的走单卡流 `streamEligible`,带三维的单独成流 `soloStreamKind`);源依赖卡看 `rules`。
 * 和 `streamEligible` 不会同时为真。
 */
export function belowStreamEligible(control, clip, track, rules = BELOW_STREAM_RULES) {
  if (!control?.clipId || !clip || !track) return false;
  if (track.hidden || track.sourceOnly) return false;
  if (!clip.cardId) return false;
  // 剪辑段里摊出来的卡不出依赖下层的流(嵌套场景里的毛玻璃照旧活渲;〔裁〕R01 2026-10-23 被推翻,按做不通处理)
  if (clip.flat) return false;
  const spatial = frame3d(clip.frame);
  if (spatial && rules?.frame3d !== true) return false;
  const compositing = control.capabilities?.compositing ?? control.compositing;
  if (compositing === 'independent') return false;
  else if (compositing === 'sourceDependent') { if (rules?.sourceDependent !== true) return false; }
  return Number.isInteger(control.count) && control.count > 0;
}

/**
 * 这一版里要出「依赖下层的流」的目标卡,按画家顺序。每项带它占解码器的那一段 `from..to`(同单卡流的算法)。
 * `where`:片段 id → `{ clip, track }`;`orderOf`:片段 id → 画家顺序;`taken`:已经单独成流的卡(不再出这种流)。
 */
export function belowTargets(plan, { picked, where, fps, total, orderOf, taken = null }) {
  const out = [];
  const seen = new Set();
  for (const control of plan) {
    if (!control?.clipId || seen.has(control.clipId) || taken?.has(control.clipId) || !picked(control.clipId)) continue;
    const at = where.get(control.clipId);
    if (!at || !belowStreamEligible(control, at.clip, at.track)) continue;
    const firstFrame = control.sampling?.firstFrame ?? Math.ceil(at.clip.start * fps - 1e-9);
    const lastFrame = Math.min(total - 1, firstFrame + control.count - 1);
    if (lastFrame < firstFrame) continue;
    seen.add(control.clipId);
    out.push({ control, clip: at.clip, order: orderOf.get(control.clipId) ?? 0, firstFrame, from: Math.min(mountFrameOf(at.clip, fps), firstFrame), to: lastFrame });
  }
  return out.sort((a, b) => a.order - b.order);
}
