/**
 * 层表条目的「输入签名」(`inputSig`):生成这一层的片段输入的摘要,页面按当前项目算同一个签名比对,
 * 认出层表里那一层是不是**这一版片段**的预渲染结果(语义 `product/rendering.md`「兜底顺序」、
 * `product/platforms.md`「在线浏览器模式」:有这一帧的预渲染结果才照贴,旧参数的层不是这一帧的结果)。
 *
 * 为什么不直接比键:在线页面算不出层的键 —— 键里有渲染节点的环境指纹、卡片代码版本、字体指纹,页面也跑不了用户卡
 * (C10 契约第 5 节「页面不算键」)。签名只取两边都拿得到、而且是成员会改的那部分:项目数据里的片段输入。
 * 渲染节点写层表时按它认下的那一版项目(`entry.project`)算,页面按自己手里的项目算;同一份项目数据两边算出同一个签名。
 *
 * 进签名(与共享快照键 `server/card-identity.mjs` 的 `cardSnapshotIdentity` 里「项目数据那一半」对齐):
 *   - 片段:`cardId`、`params`、`parts`、`emphasis`、`mediaId`、`mediaOffset`、速度 `speed`(不是 1 时)、`filter`、`pixelMap`,
 *     框的宽高(`frame.w` / `frame.h`)、时长(`end - start`)、采样相位(`start` 落在帧格里的小数部分);
 *   - 片段引用的库条目:`project.filters` / `project.pixelMaps` 里那一条,素材的 `hash`(没有就 id);
 *   - 素材效果卡(`nodeId`):`project.cardNodes` 里这个节点和它沿 `inputs` 能走到的节点;输入指向别的片段(`@clip/<id>/…`)时
 *     递归取那个片段的签名输入,加上它相对本片段的起点差;
 *   - 项目:画幅宽高、fps、`camera3dFov`、`themeId`、`style`;
 *   - 剪辑段里摊出来的卡(`kernel/cutFlatten.mjs` 的虚拟片段):它的 `flat`(露出起点时的本地时间、经过哪几层剪辑段)。
 * 不进签名:x / y / 锚点 / 缩放 / 旋转、不透明度、淡入淡出、motion、音量与音频效果、片段在时间轴上整帧的平移 ——
 * 它们不在快照里(A2(5)),改了照贴原来那一层。卡片源码、字体、环境不进签名(页面拿不到同口径的值):这几样变了,
 * 渲染节点换键重写层表之后页面跟着换(和以前一样)。
 *
 * 签名带算法版本前缀(`i1-`);页面只比同一版本的签名,版本不同或任何一边没有签名时不比(照旧贴,向后兼容)。
 * 哈希用 `changedClips.mjs` 的 `hashString`(FNV-1a 两路,64 位):要的是「两边算出来一样吗」,不是抗碰撞;
 * 页面与 Node 都能同步算。
 *
 * 纯函数,不引 editor;服务端(`server/artifact-transfer.mjs` 的 `layerMapOf`)与页面(`snapshotSource.ts`、
 * `src/export/originals.ts`)共用这一份。
 */
import { cardJson } from "../kernel/cardGraph.mjs";
import { hashString } from "./changedClips.mjs";
import { speedKeyPart } from "../kernel/clipTime.mjs";

/** 签名算法的版本;改了进签名的内容就加一 */
export const LAYER_INPUT_SIG_VERSION = 1;
const PREFIX = `i${LAYER_INPUT_SIG_VERSION}-`;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** 起点落在帧格里的小数部分(百万分之一帧,整数):整帧平移不变,亚帧挪动会变(采样相位进共享快照键) */
function phaseOf(start, fps) {
  const x = Number(start) * fps;
  if (!Number.isFinite(x)) return null;
  const first = Math.ceil(x - 1e-9);
  return Math.round((first - x) * 1e6);
}

function clipsOf(project) {
  const out = new Map();
  for (const track of Array.isArray(project?.tracks) ? project.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if (clip && typeof clip.id === "string" && !out.has(clip.id)) out.set(clip.id, clip);
    }
  }
  return out;
}

function nodesOf(project) {
  const raw = project?.cardNodes;
  const list = Array.isArray(raw) ? raw : isObj(raw) ? Object.values(raw) : [];
  const out = new Map();
  for (const node of list) if (node && typeof node.id === "string" && !out.has(node.id)) out.set(node.id, node);
  return out;
}

const libraryEntry = (list, ref) => {
  const id = isObj(ref) ? ref.id : undefined;
  if (typeof id !== "string") return undefined;
  return (Array.isArray(list) ? list : []).find((x) => x?.id === id) ?? null;
};

/**
 * 这个片段的签名输入(还没哈希的那份对象);片段不在项目里回 null。导出给单测看口径。
 * @param {any} project
 * @param {string} clipId
 */
export function clipInputs(project, clipId) {
  const clips = clipsOf(project);
  const nodes = nodesOf(project);
  const media = new Map((Array.isArray(project?.media) ? project.media : []).filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
  const fps = Math.max(1, Number(project?.fps) || 30);

  const describeClip = (clip, seen) => {
    if (seen.has(`clip:${clip.id}`)) return { cycle: true };
    const inner = new Set(seen).add(`clip:${clip.id}`);
    const start = Number(clip.start) || 0;
    const mediaEntry = typeof clip.mediaId === "string" ? media.get(clip.mediaId) : undefined;
    return {
      cardId: clip.cardId, params: clip.params, parts: clip.parts, emphasis: clip.emphasis,
      mediaId: clip.mediaId, mediaOffset: clip.mediaOffset,
      // 片段速度:只在不是 1 时才进(`kernel/clipTime.mjs` 的 speedKeyPart),缺省 1 的签名逐字不变
      ...speedKeyPart(clip),
      media: clip.mediaId === undefined ? undefined : mediaEntry ? (mediaEntry.hash ?? mediaEntry.id) : null,
      filter: clip.filter, filterDef: clip.filter ? libraryEntry(project?.filters, clip.filter) : undefined,
      pixelMap: clip.pixelMap, pixelMapDef: clip.pixelMap ? libraryEntry(project?.pixelMaps, clip.pixelMap) : undefined,
      size: isObj(clip.frame) ? { w: clip.frame.w, h: clip.frame.h } : undefined,
      duration: (Number(clip.end) || 0) - start,
      phase: phaseOf(start, fps),
      node: typeof clip.nodeId === "string" && clip.nodeId ? describeNode(clip.nodeId, inner, start) : undefined,
      // 剪辑段里摊出来的卡(`kernel/cutFlatten.mjs`):截了多少头、经过哪几层段。顶层片段没有这一项,签名不变
      ...(clip.flat && typeof clip.flat === "object" ? { flat: clip.flat } : null),
    };
  };

  const describeRef = (nodeId, seen, selfStart) => {
    if (nodes.has(nodeId)) return describeNode(nodeId, seen, selfStart);
    const m = /^@clip\/([^/]+)\/(.+)$/.exec(nodeId);
    const other = m ? clips.get(m[1]) : undefined;
    if (other) return { clip: describeClip(other, seen), part: m[2], rel: (Number(other.start) || 0) - selfStart };
    return { missing: nodeId };
  };

  const describeNode = (nodeId, seen, selfStart) => {
    if (seen.has(`node:${nodeId}`)) return { cycle: nodeId };
    const inner = new Set(seen).add(`node:${nodeId}`);
    const node = nodes.get(nodeId);
    if (!node) return describeRef(nodeId, inner, selfStart);
    const { id: _id, inputs, ...rest } = node;
    const described = {};
    for (const [name, ref] of Object.entries(isObj(inputs) ? inputs : {})) {
      const target = typeof ref === "string" ? ref : isObj(ref) && typeof ref.nodeId === "string" ? ref.nodeId : null;
      if (!target) { described[name] = { bad: true }; continue; }
      described[name] = { ref: describeRef(target, inner, selfStart), offset: isObj(ref) ? ref.offset : undefined, rate: isObj(ref) ? ref.rate : undefined };
    }
    return { ...rest, inputs: described };
  };

  const clip = clips.get(clipId);
  if (!clip) return null;
  return {
    stage: { width: project?.width, height: project?.height, fps: project?.fps, camera3dFov: project?.camera3dFov, themeId: project?.themeId, style: project?.style },
    clip: describeClip(clip, new Set()),
  };
}

/**
 * 片段的输入签名(`i1-<16 位十六进制>`);片段不在项目里、或输入里有序列化不了的值时回 null(不比)。
 * @param {any} project
 * @param {string} clipId
 * @returns {string | null}
 */
export function clipInputSig(project, clipId) {
  try {
    const inputs = clipInputs(project, clipId);
    if (!inputs) return null;
    return PREFIX + hashString(cardJson(inputs));
  } catch {
    return null;
  }
}

/**
 * 层表那一层的签名与页面算的签名:两边都有、同一算法版本、而且不同 → 这一层已过期(不是这一版片段的结果)。
 * 任何一边没有签名、或版本不同 → 不判过期(照旧贴:旧层表、旧页面、旧节点都向后兼容)。
 * @param {unknown} layerSig
 * @param {unknown} pageSig
 */
export function inputSigStale(layerSig, pageSig) {
  if (typeof layerSig !== "string" || typeof pageSig !== "string") return false;
  if (!layerSig.startsWith(PREFIX) || !pageSig.startsWith(PREFIX)) return false;
  return layerSig !== pageSig;
}

/** 每份项目(不可变对象)一张 clipId → 签名 的缓存:项目不换新对象就不重算 */
const cache = new WeakMap();
/**
 * 带缓存的 `clipInputSig`(页面每拍都会问;store 不原地改项目,按对象引用缓存就不会取到过时的值)。
 * @param {any} project
 * @param {string} clipId
 */
export function cachedClipInputSig(project, clipId) {
  if (!project || typeof project !== "object") return null;
  let byClip = cache.get(project);
  if (!byClip) { byClip = new Map(); cache.set(project, byClip); }
  if (byClip.has(clipId)) return byClip.get(clipId);
  const sig = clipInputSig(project, clipId);
  byClip.set(clipId, sig);
  return sig;
}
