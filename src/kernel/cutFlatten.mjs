/**
 * 剪辑段的「摊平视图」:给计划这一侧(成本身份、测量、分派、轨道流的计划、层表、输入签名、就绪索引)用的项目,
 * 剪辑段换成它里面的片段(`mechanism/rendering.md`「剪辑段」;用户 2026-10-21 定:剪辑段里的卡和没有剪辑段时一样,
 * 轻卡活渲,重卡各自走轨道流)。
 *
 * 画面照旧走嵌套场景(`render/CutSegmentScene.tsx`),这里不出画。摊平视图只回答「此刻有哪些卡、各在父时间轴的哪一段、
 * 各是什么内容」,让分派、测量、产流把被引用剪辑里的卡当成父时间轴上的普通卡。
 *
 *   - 激活剪辑里每个剪辑段(所在序列没隐藏、不悬空、不成环)换成被引用剪辑里的片段,任意深度递归;
 *     画面序列的位置就是段所在的那条序列(画家顺序不变)。段本身不在摊平视图里;
 *   - 虚拟片段的 id = `<段 id>~<里面片段 id>`(多层一路接下去,`FLAT_SEP`),虚拟序列的 id 同理;
 *   - 时间:父时间 = 被引用剪辑的时间 + `段.start − 段.cutOffset`;只留露出来的窗口 —— `[段.start, 段.end)`、
 *     `被引用剪辑的总时长` 与片段自己区间的交集;
 *   - 框、参数、部件照里面片段原样。被引用剪辑和项目同一个画幅,单卡流在包裹层自己的坐标系里出,段的框(位置、缩放、旋转、
 *     不透明度、淡入淡出)不进流的像素,贴的时候由嵌套场景外面那几层包裹层加 —— 和顶层卡的缩放旋转不进流是同一个道理;
 *   - 另带 `flat`:`lead` 是露出起点那一刻这张卡的本地时间(片段被段截了头时 > 0)、`chain` 是一路经过的剪辑段
 *     (`{ id, cutId, start, end, cutOffset }`)、`mount` 是产流时回放的安全起点(秒,顶层段的 `max(0, start − cutOffset)`:
 *     嵌套场景最早从这里挂上,预卷不会比它更早)。`flat` 进这张卡的预渲染键(`withFlatNodes`),不进成本键。
 *
 * v1 只摊卡片段(`cardId`,没有 `nodeId`)和素材段。挂着素材效果卡节点的片段(`nodeId`)、转场不摊:节点的输入按原片段 id 引用,
 * 换了 id 就悬空;它们照旧在嵌套场景里活渲,不进分派表。
 *
 * 没有剪辑段的项目原样回同一个对象,键、表、签名一个字节不变。纯 JS,页面与服务端共用,不碰注册表(不用推帧口径)。
 */

/** 虚拟片段 id 的分隔符。片段 id 由 `newId` 生成(字母、数字、`-`),不会出现它 */
export const FLAT_SEP = '~';

import { clipSpeed } from "./clipTime.mjs";

const FALLBACK_CUT_DURATION = 30;
const MAX_DEPTH = 32;
const EPS = 1e-9;

/** 这个片段 id 是不是摊平出来的虚拟片段 */
export const isFlatClipId = (id) => typeof id === 'string' && id.includes(FLAT_SEP);

const isSegment = (c) => !!c && typeof c.cutId === 'string' && c.cutId.length > 0;

function activeIdOf(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

/** 剪辑的内容(同 `cutSegments.ts` 的 `cutContent`);找不到回 null */
function contentOf(p, cutId) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  const entry = cuts.find((c) => c?.id === cutId);
  if (!entry) return null;
  if (cutId === activeIdOf(p)) return { tracks: p.tracks ?? [], duration: Number(p.duration) || 0 };
  if (!Array.isArray(entry.tracks)) return null;
  return { tracks: entry.tracks, duration: typeof entry.duration === 'number' && entry.duration > 0 ? entry.duration : FALLBACK_CUT_DURATION };
}

/** 项目的激活剪辑里有没有要摊的剪辑段 */
export function hasFlatSegments(project) {
  for (const track of project?.tracks ?? []) {
    if (track?.hidden) continue;
    for (const c of track?.clips ?? []) if (isSegment(c)) return true;
  }
  return false;
}

function expandSegment(project, seg, ctx, out, trackIdPrefix) {
  const cutId = seg.cutId;
  if (ctx.path.includes(cutId) || ctx.path.length >= MAX_DEPTH) return;
  const content = contentOf(project, cutId);
  if (!content) return;
  const start = Number(seg.start), end = Number(seg.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return;
  const segStart = ctx.shift + start, segEnd = ctx.shift + end;
  const offset = Math.max(0, Number(seg.cutOffset) || 0);
  const shift = segStart - offset;
  const from = Math.max(ctx.from, segStart);
  const to = Math.min(ctx.to, segEnd, shift + content.duration);
  if (!(to > from + EPS)) return;
  const chain = [...ctx.chain, { id: seg.id, cutId, start, end, cutOffset: offset }];
  const mount = ctx.mount ?? Math.max(0, segStart - offset);
  const idPrefix = `${ctx.idPrefix}${seg.id}${FLAT_SEP}`;
  const inner = { shift, from, to, chain, mount, idPrefix, path: [...ctx.path, cutId] };
  for (const track of content.tracks) {
    if (!track || track.hidden || track.sourceOnly) continue;
    const trackId = `${trackIdPrefix}${FLAT_SEP}${seg.id}${FLAT_SEP}${track.id}`;
    const clips = [];
    for (const c of track.clips ?? []) {
      if (!c || typeof c.id !== 'string') continue;
      if (isSegment(c)) { expandSegment(project, c, inner, out, trackId); continue; }
      if (c.nodeId) continue;
      if (!c.cardId && !c.mediaId) continue;
      const s = Number(c.start) + shift, e = Number(c.end) + shift;
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      const vs = Math.max(from, s), ve = Math.min(to, e);
      if (!(ve > vs + EPS)) continue;
      const lead = vs - s;
      const v = { ...c, id: `${idPrefix}${c.id}`, start: vs, end: ve, flat: { lead, chain, mount } };
      // 截掉的那一截按片段速度推进素材起点(kernel/clipTime.mjs;缺省 1 时 lead × 1 = lead,逐位不变)
      if (c.mediaId && lead > 0) v.mediaOffset = (Number(c.mediaOffset) || 0) + lead * clipSpeed(c);
      clips.push(v);
    }
    if (clips.length) out.push({ ...track, id: trackId, clips });
  }
}

const memo = new WeakMap();

/**
 * 摊平视图(见文件头)。没有剪辑段时回同一个对象;同一份项目对象记忆化(页面每拍都问)。
 * 摊平视图里没有剪辑段,再摊一次还是它自己。
 */
export function flatPlanProject(project) {
  if (!project || !Array.isArray(project.tracks) || !hasFlatSegments(project)) return project;
  const hit = memo.get(project);
  if (hit) return hit;
  const root = activeIdOf(project);
  const tracks = [];
  for (const track of project.tracks) {
    if (!track || track.hidden || !(track.clips ?? []).some(isSegment)) { tracks.push(track); continue; }
    for (const seg of track.clips) {
      if (!isSegment(seg)) continue;
      expandSegment(project, seg, { shift: 0, from: -Infinity, to: Infinity, chain: [], mount: undefined, idPrefix: '', path: root ? [root] : [] }, tracks, track.id);
    }
    tracks.push({ ...track, clips: track.clips.filter((c) => !isSegment(c)) });
  }
  const out = { ...project, tracks };
  memo.set(project, out);
  return out;
}

/** 片段带的摊平信息(顶层片段回 undefined) */
export function flatInfoOf(clip) {
  const f = clip?.flat;
  return f && typeof f === 'object' && Array.isArray(f.chain) ? f : undefined;
}

/** 摊平视图里按 id 找片段与它的序列 */
export function flatClipOf(project, clipId) {
  const flat = flatPlanProject(project);
  for (const track of flat?.tracks ?? []) for (const clip of track?.clips ?? []) if (clip?.id === clipId) return { track, clip };
  return null;
}

/**
 * 给卡片计划的图(`projectCardGraph(flatPlanProject(p))` 的结果)里虚拟片段的基节点补上 `flat`(`lead`、`chain`、`mount`):
 * 露出窗口截了多少头、经过哪几层剪辑段都改这张卡在流里的像素,所以进它的内容键、流成员键;成本键剥掉它(`cardCostKey`)。
 * 基节点是 `@clip/<id>/source`(普通卡、素材段)或 `@clip/<id>/card`(只有 `cardId` 的素材效果卡写法);滤镜、强调那几层
 * 顺着输入键带上它。没有虚拟片段时原样回同一个图。
 */
export function withFlatNodes(flatProject, graph) {
  if (!graph || !Array.isArray(graph?.nodes)) return graph;
  const info = new Map();
  for (const track of flatProject?.tracks ?? []) for (const clip of track?.clips ?? []) {
    const f = flatInfoOf(clip);
    if (!f) continue;
    const flat = { lead: f.lead, chain: f.chain, mount: f.mount };
    info.set(`@clip/${clip.id}/source`, flat);
    info.set(`@clip/${clip.id}/card`, flat);
  }
  if (!info.size) return graph;
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const flat = info.get(node?.id);
    if (!flat) return node;
    changed = true;
    return { ...node, flat };
  });
  return changed ? { ...graph, nodes } : graph;
}

/** 去掉剪辑段自己的外观:框(嵌套场景 1:1 铺满画面)、不透明度、淡入淡出、强调、轨迹 */
function bareSegment(seg) {
  const out = structuredClone(seg);
  delete out.frame; delete out.opacity; delete out.fadeIn; delete out.fadeOut; delete out.emphasis; delete out.motion;
  return out;
}

/** 一组序列里只留 `keepId` 这一个片段可见(同 `server/frame-stream.mjs` 的 `isolatedStreamProject`):别的序列、同序列的别的片段都藏成 `sourceOnly` */
function isolateTracks(tracks, keepId, transform) {
  const ids = new Set((tracks ?? []).map((t) => t.id));
  const out = [];
  for (const track of tracks ?? []) {
    const own = (track.clips ?? []).filter((c) => c.id === keepId);
    if (!own.length) { out.push({ ...structuredClone(track), hidden: true, sourceOnly: true }); continue; }
    out.push({ ...structuredClone(track), hidden: false, sourceOnly: false, clips: own.map(transform) });
    const siblings = (track.clips ?? []).filter((c) => c.id !== keepId);
    if (siblings.length) {
      let id = `__pc_source_${track.id}`, n = 1;
      while (ids.has(id)) id = `__pc_source_${track.id}_${n++}`;
      ids.add(id);
      out.push({ ...structuredClone(track), id, hidden: true, sourceOnly: true, clips: structuredClone(siblings) });
    }
  }
  return out;
}

/**
 * 虚拟片段 `clipId` 的单卡流的**隔离工程**:从真实项目出发,一路只留这条链上的剪辑段(去掉段的外观,嵌套场景 1:1 铺满画面),
 * 每条被引用剪辑里只留链上的下一个段或目标卡;目标卡交给 `localize`(`server/frame-stream.mjs` 的 `localClip`:框摆到
 * 截图位置、去掉外观)。嵌套场景照常算预卷、照常截头,所以流里每一帧和活渲时这张卡在包裹层里的样子相同。时间不平移。
 * 找不到这个片段回 null。
 */
export function isolatedFlatProject(project, clipId, localize = (c) => structuredClone(c)) {
  const hit = flatClipOf(project, clipId);
  const f = flatInfoOf(hit?.clip);
  if (!f || !f.chain.length) return null;
  const prefix = f.chain.map((s) => s.id).join(FLAT_SEP) + FLAT_SEP;
  if (!clipId.startsWith(prefix)) return null;
  const innerId = clipId.slice(prefix.length);
  const root = structuredClone(project);
  root.tracks = isolateTracks(root.tracks, f.chain[0].id, bareSegment);
  for (let i = 0; i < f.chain.length; i++) {
    const entry = (root.cuts ?? []).find((c) => c?.id === f.chain[i].cutId);
    if (!entry || !Array.isArray(entry.tracks)) return null;
    const last = i === f.chain.length - 1;
    entry.tracks = isolateTracks(entry.tracks, last ? innerId : f.chain[i + 1].id, last ? localize : bareSegment);
  }
  return { ...root, _cardRender: { mode: 'final', frames: {}, missing: {} } };
}
