/**
 * 两层 diff 与三级哈希缓存(A7)。
 *
 * # 为什么不整份推
 *
 * 编辑页每改一次就把整个 project 推给镜像插件,一个几十段的项目 JSON 有几百 KB;
 * 拖一个片段的 2 秒里会推十几次,带宽和 JSON.stringify 都顶不住。可真正变的通常只有
 * **一个片段**:store 是不可变更新,没动过的对象引用不变,所以「变了什么」可以靠引用比出来,
 * 一次推送只有那一段(实测 < 8 KB)。
 *
 * # 两层
 *
 * 1. **顶层**:按 `frameClient.ts` 的签名字段表逐个按引用比。`tracks` 以外任一个变了
 *    (换素材、改画幅、改主题、改卡片定义……)就整份推 —— 那些字段本来就不常动,
 *    为它们做增量不划算,而且漏一个就会让镜像和页面悄悄不一致。
 * 2. **轨道层**:`tracks` 变了才往下走。先按轨道引用比出轨道级变化(增删、顺序、
 *    `hidden` / `muted` 这些自身属性),再对**引用变了的轨道**逐片段按引用比
 *    (素材段和卡片段都比)。
 *
 * # 三级哈希缓存
 *
 * `projectHash` 是「服务端把补丁应用完之后,得到的项目和页面手里那份是不是同一个」的判据。
 * 它按 字段 → 轨道 → 片段 三级算,每一级都用 `WeakMap` 按**对象引用**缓存:
 * 拖一个片段只会重算 1 个片段 + 1 条轨道 + 顶层那一次拼接,其余全是缓存命中(实测 < 2 ms)。
 * 引用当键还顺带解决了失效问题 —— 对象没被换掉就一定没变,换掉了 WeakMap 里本来就没有它。
 *
 * # 哈希为什么不是 sha256
 *
 * 舞台 bundle 和 Node 都要能同步算(`crypto.subtle` 是异步的,`node:crypto` 页面里没有),
 * 而这里要的是「两边算出来一样吗」,不是抗碰撞。FNV-1a 变体,64 位十六进制,纯字符串运算。
 */

/**
 * 顶层按引用比的字段表:和 `src/render/frameClient.ts` 的 `signature()` **同一组、同一顺序**。
 * 那边加一个字段这边就得跟一个,不然镜像的哈希看不见它、409 那道也就白设了 ——
 * `changedClips.test.mjs` 会去读 frameClient 的源码逐字对这张表,改漏一边当场红。
 */
export const TOP_FIELDS = [
  "width", "height", "fps", "duration", "themeId", "camera3dFov",
  "tracks", "media", "filters", "pixelMaps", "audioFx",
  "cardNodes", "style",
];

import { reachableCutContents } from "../kernel/cutIdentity.mjs";

/** 重算次数(缓存未命中)。测试用它证明「同一批引用不会重算」 */
const stats = { fields: 0, tracks: 0, clips: 0, values: 0 };
/** 取一份重算计数的快照 */
export function hashStats() { return { ...stats }; }
/** 计数归零 */
export function resetHashStats() { stats.fields = 0; stats.tracks = 0; stats.clips = 0; stats.values = 0; }

/** FNV-1a 的两路变体,拼成 16 个十六进制字符 */
export function hashString(s) {
  let h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
    h2 = (h2 << 13) | (h2 >>> 19);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/* 三级缓存。键都是对象引用,所以项目一换新对象,旧的自动被回收 */
const fieldsCache = new WeakMap();
const valueCache = new WeakMap();
const trackCache = new WeakMap();
const clipCache = new WeakMap();

/** 第三级:一个片段 */
function clipHash(clip) {
  let h = clipCache.get(clip);
  if (h === undefined) { stats.clips++; h = hashString(JSON.stringify(clip)); clipCache.set(clip, h); }
  return h;
}

/**
 * 第二级:一条轨道。**片段和轨道自身属性分开算**,于是轨道对象的键顺序
 * (`clips` 排在第几个)不影响结果 —— 服务端应用补丁时重建的轨道键顺序和页面那份
 * 不一定一样,分开算才能让两边的哈希对得上。
 */
function trackHash(track) {
  let h = trackCache.get(track);
  if (h === undefined) {
    stats.tracks++;
    const { clips, ...rest } = track;
    h = hashString(JSON.stringify(rest) + "|" + (clips || []).map(clipHash).join(","));
    trackCache.set(track, h);
  }
  return h;
}

function tracksHash(tracks) {
  let h = valueCache.get(tracks);
  if (h === undefined) { h = hashString(tracks.map(trackHash).join(",")); valueCache.set(tracks, h); }
  return h;
}

/** 第一级里的非轨道字段:整块 stringify 一次就按引用记住(media 可能很大) */
function valueHash(v) {
  if (v === null || typeof v !== "object") return String(JSON.stringify(v));
  let h = valueCache.get(v);
  if (h === undefined) { stats.values++; h = hashString(JSON.stringify(v)); valueCache.set(v, h); }
  return h;
}

/** 项目的渲染身份哈希(只覆盖 `TOP_FIELDS`;`name` / `id` / 草稿元信息不进) */
export function projectHash(project) {
  let h = fieldsCache.get(project);
  if (h === undefined) {
    stats.fields++;
    const parts = [];
    for (const k of TOP_FIELDS) {
      const v = project[k];
      parts.push(k + ":" + (k === "tracks" ? tracksHash(Array.isArray(v) ? v : []) : valueHash(v)));
    }
    // 剪辑段引用的剪辑(kernel/cutIdentity.mjs):有才加,没有剪辑段的项目哈希一个字节不变
    const cutRefs = reachableCutContents(project);
    if (cutRefs.length) parts.push("cutRefs:" + hashString(JSON.stringify(cutRefs)));
    h = hashString(parts.join("|"));
    fieldsCache.set(project, h);
  }
  return h;
}

/** 除 `skip` 外的所有自有键都按引用相等? */
function sameByRef(a, b, skip) {
  for (const k of Object.keys(a)) if (k !== skip && a[k] !== b[k]) return false;
  for (const k of Object.keys(b)) if (k !== skip && !(k in a)) return false;
  return true;
}

function idsOf(list) { return (list || []).map((x) => x.id); }
function sameOrder(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }

/**
 * 两份项目之间的补丁。`prev` 为空、或 `tracks` 以外任何字段变了 → 整份。
 *
 * 返回的形状就是将来舞台 RPC 的 `setProject(patch)` 参数(见 `ProjectPatch`)。
 */
export function changedClips(prev, next) {
  if (!prev) return { kind: "full", project: next };
  if (prev === next) return { kind: "tracks", order: null, tracks: [] };
  if (!sameByRef(prev, next, "tracks")) return { kind: "full", project: next };
  if (prev.tracks === next.tracks) return { kind: "tracks", order: null, tracks: [] };

  const prevTracks = prev.tracks || [], nextTracks = next.tracks || [];
  const prevById = new Map(prevTracks.map((t) => [t.id, t]));
  const nextIds = idsOf(nextTracks);
  const order = sameOrder(idsOf(prevTracks), nextIds) ? null : nextIds;

  const tracks = [];
  for (const tr of nextTracks) {
    const before = prevById.get(tr.id);
    // 新加的轨道整条给:没有基线可比,逐段算反而更大
    if (!before) { tracks.push({ id: tr.id, track: tr }); continue; }
    if (before === tr) continue;

    const patch = { id: tr.id };
    if (!sameByRef(before, tr, "clips")) {
      // 自身属性**整组**给(就 id / name / hidden / muted / locked 几个),
      // 这样「把 hidden 这个键删掉」也能表达,不用另记一张删除表
      const { clips: _clips, ...props } = tr;
      patch.props = props;
    }
    if (before.clips !== tr.clips) {
      const beforeClips = new Map((before.clips || []).map((c) => [c.id, c]));
      const changed = [];
      const seen = new Set();
      for (const c of tr.clips || []) {
        seen.add(c.id);
        if (beforeClips.get(c.id) !== c) changed.push({ id: c.id, clip: c });
      }
      for (const id of beforeClips.keys()) if (!seen.has(id)) changed.push({ id, clip: null });
      if (changed.length) patch.clips = changed;
      const afterIds = idsOf(tr.clips);
      if (!sameOrder(idsOf(before.clips), afterIds)) patch.clipOrder = afterIds;
    }
    if (patch.props || patch.clips || patch.clipOrder) tracks.push(patch);
  }
  return { kind: "tracks", order, tracks };
}

/** 补丁里有没有真东西(空补丁不用发) */
export function isEmptyPatch(patch) {
  return !!patch && patch.kind === "tracks" && !patch.order && (!patch.tracks || patch.tracks.length === 0);
}

/**
 * 把补丁应用到一份项目上,返回**新的**项目对象(不改原对象:镜像要按版本号留住旧版)。
 * 补丁和基线对不上就抛 —— 调用方(镜像插件)把它翻成 409,让页面整份重推。
 */
export function applyProjectPatch(project, patch) {
  if (!patch) return project;
  if (patch.kind === "full") return patch.project;
  if (patch.kind !== "tracks") throw new Error(`未知的补丁类型:${patch.kind}`);

  const byId = new Map((project.tracks || []).map((t) => [t.id, t]));
  for (const tp of patch.tracks || []) {
    if (tp.track) { byId.set(tp.id, tp.track); continue; }
    const base = byId.get(tp.id);
    if (!base) throw new Error(`补丁引用了不存在的轨道:${tp.id}`);
    let clips = base.clips || [];
    if (tp.clips) {
      const m = new Map(clips.map((c) => [c.id, c]));
      for (const cp of tp.clips) { if (cp.clip === null) m.delete(cp.id); else m.set(cp.id, cp.clip); }
      clips = [...m.values()];
    }
    if (tp.clipOrder) {
      const m = new Map(clips.map((c) => [c.id, c]));
      clips = tp.clipOrder.map((id) => {
        const c = m.get(id);
        if (!c) throw new Error(`补丁引用了不存在的片段:${id}`);
        return c;
      });
    }
    const props = tp.props ? { ...tp.props } : { ...base };
    delete props.clips;
    byId.set(tp.id, { ...props, clips });
  }

  const order = patch.order || (project.tracks || []).map((t) => t.id);
  const tracks = order.map((id) => {
    const t = byId.get(id);
    if (!t) throw new Error(`补丁引用了不存在的轨道:${id}`);
    return t;
  });
  return { ...project, tracks };
}
