/**
 * 仅供测试:可复现的随机项目与随机修改。diffProject / docsync 的性质测试共用。
 *
 * 形状照 Project 的大致样子(序列、片段、部件、素材、效果库、剪辑),外加一些专门刁难
 * 路径编码的键名(含 `/`、`~`、`@` 开头)和不带 id 的数组。
 */

/** mulberry32:种子一样,序列一样 */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (arr) => arr[int(arr.length)];
  const chance = (p) => next() < p;
  return { next, int, pick, chance };
}

const WEIRD_KEYS = ["a/b", "~k", "@k", "~1", "x~0y", "空格 键", "0", "12"];
const PLAIN_KEYS = ["x", "y", "w", "h", "color", "text", "size", "speed", "mode", "label", "on", "gain"];

let idSeq = 0;
function freshId(r, prefix) {
  idSeq++;
  // 偶尔带上需要转义的字符
  const odd = r.chance(0.05) ? r.pick(["/", "~", "@", "~1"]) : "";
  return `${prefix}${idSeq.toString(36)}${odd}`;
}

export function randScalar(r) {
  switch (r.int(6)) {
    case 0: return r.int(2000) - 500;
    case 1: return Math.round(r.next() * 1e4) / 100;
    case 2: return r.pick(["", "hello", "中文", "a/b", "~x", "@y"]);
    case 3: return r.chance(0.5);
    case 4: return null;
    default: return r.int(10);
  }
}

function randKey(r) {
  return r.chance(0.15) ? r.pick(WEIRD_KEYS) : r.pick(PLAIN_KEYS);
}

export function randValue(r, depth = 0) {
  const roll = r.int(10);
  if (depth > 2 || roll < 6) return randScalar(r);
  if (roll < 8) return randObject(r, depth + 1);
  if (roll < 9) return Array.from({ length: r.int(4) }, () => randScalar(r));
  return randIdArray(r, depth + 1, "e");
}

export function randObject(r, depth = 0) {
  const o = {};
  const n = r.int(5);
  for (let i = 0; i < n; i++) o[randKey(r)] = randValue(r, depth);
  return o;
}

function randIdArray(r, depth, prefix) {
  return Array.from({ length: r.int(4) }, () => ({ id: freshId(r, prefix), ...randObject(r, depth + 1) }));
}

export function randClip(r) {
  const start = Math.round(r.next() * 600) / 10;
  const c = { id: freshId(r, "c"), cardId: r.pick(["title", "lower", "chart", "composite"]), start, end: start + 1 + r.int(5), params: randObject(r, 1) };
  if (r.chance(0.5)) c.frame = { x: r.int(1920), y: r.int(1080), w: 100 + r.int(800), h: 100 + r.int(600) };
  if (r.chance(0.2)) c.parts = randIdArray(r, 2, "p");
  if (r.chance(0.2)) c.tags = Array.from({ length: r.int(3) }, () => randScalar(r));
  if (r.chance(0.2)) c.fadeIn = r.int(3);
  return c;
}

export function randTrack(r, maxClips = 6) {
  return { id: freshId(r, "t"), name: `序列 ${r.int(9)}`, ...(r.chance(0.2) ? { hidden: true } : {}), clips: Array.from({ length: r.int(maxClips) }, () => randClip(r)) };
}

export function randProject(r, opts = {}) {
  const maxTracks = opts.maxTracks ?? 4;
  const p = {
    version: 1,
    id: freshId(r, "p-"),
    name: r.pick(["未命名", "demo", "a/b"]),
    width: 1920,
    height: 1080,
    fps: r.pick([24, 30, 60]),
    duration: 30 + r.int(60),
    themeId: "midnight",
    media: Array.from({ length: r.int(3) }, () => ({ id: freshId(r, "m"), kind: r.pick(["video", "audio", "image"]), name: "m.mp4", url: "/@media/x", ...(r.chance(0.3) ? { transcript: { engine: "w", segments: [{ start: 0, end: 1, text: "hi" }] } } : {}) })),
    tracks: Array.from({ length: 1 + r.int(maxTracks) }, () => randTrack(r)),
  };
  if (r.chance(0.4)) p.filters = Array.from({ length: r.int(3) }, () => ({ id: freshId(r, "f"), kind: "grade", strength: r.next() }));
  if (r.chance(0.3)) p.cuts = Array.from({ length: 1 + r.int(2) }, () => ({ id: freshId(r, "k"), name: "剪辑", tracks: [randTrack(r, 3)] }));
  if (r.chance(0.3)) p.style = randObject(r, 1);
  return p;
}

/** 收集所有容器节点(对象、数组),给随机修改挑落点 */
function containers(root) {
  const out = [];
  const walk = (v) => {
    if (v === null || typeof v !== "object") return;
    out.push(v);
    if (Array.isArray(v)) v.forEach(walk);
    else for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(root);
  return out;
}

const isIdArr = (a) => Array.isArray(a) && a.every((e) => e && typeof e === "object" && !Array.isArray(e) && typeof e.id === "string") && new Set(a.map((e) => e.id)).size === a.length;

/** 在一个深拷贝上做 n 次随机修改(原地),返回拷贝 */
export function mutate(r, project, n) {
  const p = structuredClone(project);
  for (let i = 0; i < n; i++) mutateOnce(r, p);
  return p;
}

export function mutateOnce(r, p) {
  const all = containers(p);
  const node = r.pick(all);
  if (Array.isArray(node)) {
    if (isIdArr(node) && node.length > 0 && r.chance(0.85)) {
      const i = r.int(node.length);
      switch (r.int(7)) {
        case 0: node.splice(i, 1); break;
        case 1: node.splice(r.int(node.length + 1), 0, { id: freshId(r, "n"), ...randObject(r, 1) }); break;
        case 2: { const [el] = node.splice(i, 1); node.splice(r.int(node.length + 1), 0, el); break; }
        case 3: node.reverse(); break;
        case 4: node[i] = { ...node[i], id: freshId(r, "r") }; break;
        case 5: node[i] = { id: node[i].id, ...randObject(r, 1) }; break;
        default: for (let k = node.length - 1; k > 0; k--) { const j = r.int(k + 1); [node[k], node[j]] = [node[j], node[k]]; }
      }
    } else if (isIdArr(node) && r.chance(0.7)) {
      node.push({ id: freshId(r, "n"), ...randObject(r, 1) });
    } else {
      switch (r.int(4)) {
        case 0: node.push(randScalar(r)); break;
        case 1: node.pop(); break;
        case 2: if (node.length) node[r.int(node.length)] = randScalar(r); break;
        default: if (node.length && isIdArr(node)) node.push({ ...node[0] }); // 造一个重复 id,变成不带 id 的数组
      }
    }
    return;
  }
  const keys = Object.keys(node);
  const k = keys.length ? r.pick(keys) : null;
  switch (r.int(6)) {
    case 0:
    case 1:
      if (k && k !== "id") node[k] = randScalar(r);
      break;
    case 2:
      if (k && k !== "id" && node !== p) delete node[k];
      break;
    case 3:
      node[randKey(r)] = randValue(r, 1);
      break;
    case 4:
      if (k && k !== "id") node[k] = r.chance(0.5) ? randObject(r, 1) : [randScalar(r)];
      break;
    default: {
      const tracks = Array.isArray(p.tracks) ? p.tracks.filter((t) => t && Array.isArray(t.clips)) : [];
      if (tracks.length) {
        const clips = r.pick(tracks).clips;
        if (isIdArr(clips)) clips.push(randClip(r));
      }
    }
  }
}

export function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

/** 把一个项目放大到 n 个片段(性能基准用) */
export function bigProject(r, clipCount, trackCount = 10) {
  const tracks = Array.from({ length: trackCount }, (_, ti) => ({ id: `t-${ti}`, name: `序列 ${ti}`, clips: [] }));
  for (let i = 0; i < clipCount; i++) {
    const t = tracks[i % trackCount];
    const start = t.clips.length * 3;
    t.clips.push({
      id: `c-${i}`,
      cardId: "title",
      start,
      end: start + 2.5,
      params: { text: `片段 ${i}`, size: 48, color: "#fff", align: "center", shadow: { x: 1, y: 2, blur: 4 }, items: ["a", "b", "c"] },
      frame: { x: 100, y: 200, w: 800, h: 200, anchor: "center", scale: 1, rotation: 0 },
      fadeIn: 0.2,
      fadeOut: 0.2,
    });
  }
  return { version: 1, id: "p-big", name: "big", width: 1920, height: 1080, fps: 30, duration: 3000, themeId: "midnight", media: [], tracks };
}

/**
 * 像编辑器 action 那样的一次修改(不可变更新,只换改到的路径):挪片段、改参数、加删片段、
 * 调片段顺序、改序列名、加删序列、改项目设置。返回新项目;项目里没有可改的对象时原样返回。
 */
export function realisticEdit(r, p) {
  const tracks = Array.isArray(p.tracks) ? p.tracks : [];
  const withTrack = (ti, fn) => ({ ...p, tracks: tracks.map((t, i) => (i === ti ? fn(t) : t)) });
  const ti = tracks.length ? r.int(tracks.length) : -1;
  const t = tracks[ti];
  const clips = t && Array.isArray(t.clips) ? t.clips : [];
  const ci = clips.length ? r.int(clips.length) : -1;
  switch (r.int(10)) {
    case 0:
    case 1: // 拖动片段
      if (ci < 0) break;
      return withTrack(ti, (tr) => ({ ...tr, clips: clips.map((c, i) => (i === ci ? { ...c, start: (c.start ?? 0) + 0.5, end: (c.end ?? 1) + 0.5 } : c)) }));
    case 2:
    case 3: // 改参数
      if (ci < 0) break;
      return withTrack(ti, (tr) => ({ ...tr, clips: clips.map((c, i) => (i === ci ? { ...c, params: { ...(c.params ?? {}), [r.pick(["text", "size", "color"])]: randScalar(r) } } : c)) }));
    case 4: // 加片段
      if (ti < 0) break;
      return withTrack(ti, (tr) => {
        const at = r.int(clips.length + 1);
        return { ...tr, clips: [...clips.slice(0, at), randClip(r), ...clips.slice(at)] };
      });
    case 5: // 删片段
      if (ci < 0) break;
      return withTrack(ti, (tr) => ({ ...tr, clips: clips.filter((_, i) => i !== ci) }));
    case 6: // 片段换顺序
      if (clips.length < 2) break;
      return withTrack(ti, (tr) => { const cs = [...clips]; const [el] = cs.splice(ci, 1); cs.splice(r.int(cs.length + 1), 0, el); return { ...tr, clips: cs }; });
    case 7: // 改序列名 / 隐藏
      if (ti < 0) break;
      return withTrack(ti, (tr) => (r.chance(0.5) ? { ...tr, name: `序列 ${r.int(100)}` } : { ...tr, hidden: !tr.hidden }));
    case 8: // 加删序列
      if (r.chance(0.7) || tracks.length < 2) return { ...p, tracks: [...tracks, randTrack(r, 3)] };
      return { ...p, tracks: tracks.filter((_, i) => i !== ti) };
    default: // 项目设置
      return { ...p, [r.pick(["name", "fps", "duration", "themeId"])]: randScalar(r) };
  }
  return p;
}
