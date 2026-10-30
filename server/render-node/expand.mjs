/**
 * 多项目模式的「展开」（语义 `docs/semantics/product/rendering.md`「渲染服务的两种模式」；机制 `docs/semantics/mechanism/rendering.md`
 * 「多项目模式的做法」第一条）：从一个请求要的那几帧（或那张卡的那一段）出发，拼一份只含用到的片段的项目交给渲染页。
 *
 *   - 取这些帧上挂着的片段（含挂载提前量 `CARD_MOUNT_LEAD`）；每个片段带上它的卡（源码身份 `cardId`、参数、部件，都在片段上原样留着）
 *     和用到的素材；
 *   - 顺着依赖找，直到找不出新的：
 *       · 依赖下层的卡带上它下面的层——帧请求里同一刻挂着的下层片段本来就在；「一张卡的一段」的请求按整段取，这一段里挂过的下层都在；
 *       · 转场带上前后两段（`transitions` 里 `aId` / `bId` 有一个留下，两个都留，转场记录也留）；
 *       · 素材效果卡带上它的输入（片段的 `nodeId` → `cardNodes` 里这个节点、沿 `inputs` 走得到的节点；输入指向别的片段 `@clip/<id>/…` 时
 *         那个片段也留，不管它在不在这几帧上）；
 *       · 剪辑段（`cutId`）带上被引用的那条剪辑里、按段的时间换算之后同样挂在这几帧上的片段（任意深度，有环就停）；
 *   - 另加项目级设置：画幅、帧率、时长、主题、样式、三维视场角等字段**原样保留**（只换掉 `tracks`、`transitions`、`cardNodes`、
 *     `media`、效果库与 `cuts` 里的内容）；
 *   - **时间位置不变**：留下的片段一个字都不改，序列一条不删（只是里面的片段变少），画家顺序不变；推帧卡照旧从自己的挂载帧回放。
 *
 * **取超集，不取少**：没挂在这几帧上的片段不出画，多留一个不改画面；少留一个才会错。所以判「挂没挂」时前后各多放一帧
 * （`1 / fps`），和舞台的挂载公式（`frameWindow.mjs` 的 `cardMountedAt`）比只多不少。
 *
 * 纯函数，不改入参，不引 `src/`。单项目模式（桌面版的预渲染进程）不经过这里。
 */
/**
 * 挂载提前量（秒），与舞台的 `src/render/frameWindow.mjs` 的 `CARD_MOUNT_LEAD` 同一个数。这里抄一份而不引用：渲染服务、Agent 服务这些
 * 独立入口不许引 `src/`（`server/test/accept-018-rest-ssr-seam.test.mjs`）。两边相等由 `server/test/multi-project-expand.test.mjs` 核对
 */
export const CARD_MOUNT_LEAD = 0.05;

const ACTIVE = '\u0000active';
const MAX_DEPTH = 32;
const HEX64 = /[0-9a-f]{64}/g;

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 剪辑表里激活的那一条（同 `kernel/cutFlatten.mjs` 的 `activeIdOf`） */
function activeIdOf(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c?.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

/** 一条时间轴（激活的那条是 `project.tracks`；停放的在 `cuts[].tracks`）的序列表；找不到回 null */
function tracksOf(project, timelineId) {
  if (timelineId === ACTIVE) return Array.isArray(project.tracks) ? project.tracks : [];
  if (timelineId === activeIdOf(project)) return Array.isArray(project.tracks) ? project.tracks : [];
  const entry = (Array.isArray(project.cuts) ? project.cuts : []).find((c) => c?.id === timelineId);
  return entry && Array.isArray(entry.tracks) ? entry.tracks : null;
}

/** 区间表（闭区间 `[lo, hi]`，单个时刻是 `[t, t]`）合并去重 */
function mergeIntervals(list) {
  const sorted = list.filter(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo).map(([lo, hi]) => [lo, hi]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of sorted) {
    const prev = out.at(-1);
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else out.push(r);
  }
  return out;
}

const sameIntervals = (a, b) => a.length === b.length && a.every((r, i) => r[0] === b[i][0] && r[1] === b[i][1]);

/** 这个片段挂着的区间（含提前量，前后各多放 `margin`）与要的区间有没有交集 */
function clipNeeded(clip, intervals, margin) {
  const start = num(clip.start, NaN), end = num(clip.end, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true; // 认不出起止的留着（超集）
  const lo = start - CARD_MOUNT_LEAD - margin, hi = end + margin;
  return intervals.some(([a, b]) => lo <= b && hi > a);
}

/** 节点 id 引用的片段：`@clip/<片段 id>/<后缀>` */
function clipRefOf(nodeId) {
  const m = /^@clip\/([^/]+)\//.exec(String(nodeId ?? ''));
  return m ? m[1] : null;
}

/** 把一个值里所有字符串收进 `out`（素材引用：id、哈希、地址都可能出现在参数、部件、节点、效果定义里） */
function collectStrings(value, out, depth = 0) {
  if (depth > 64 || value === null || value === undefined) return;
  if (typeof value === 'string') { out.add(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return; }
  if (typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
}

/**
 * 展开。
 * @param {any} project 整份项目（不改它）
 * @param {object} need 这个请求要什么
 * @param {number[]} [need.times] 要的时刻（秒）
 * @param {number[]} [need.frames] 要的帧号（按项目帧率换成时刻）
 * @param {[number, number][]} [need.spans] 要的时间段（秒，`[起, 止)`）——「一张卡的一段」
 * @param {string[]} [need.clipIds] 必须留下的片段（请求点名的那张卡），不管它在不在这几帧上
 * @returns {{ project: any, clipIds: string[], cardIds: string[], mediaIds: string[], nodeIds: string[], cutIds: string[] }}
 *   `project` 是只含用到的片段的项目；其余是留下了什么（诊断与测试用）
 */
export function expandProject(project, need = {}) {
  if (!isObj(project) || !Array.isArray(project.tracks)) {
    return { project, clipIds: [], cardIds: [], mediaIds: [], nodeIds: [], cutIds: [] };
  }
  const fps = num(project.fps, 30) > 0 ? num(project.fps, 30) : 30;
  const margin = 1 / fps;
  const base = [];
  for (const t of need.times ?? []) if (Number.isFinite(Number(t))) base.push([Number(t), Number(t)]);
  for (const f of need.frames ?? []) if (Number.isFinite(Number(f))) base.push([Number(f) / fps, Number(f) / fps]);
  for (const s of need.spans ?? []) if (Array.isArray(s) && Number.isFinite(Number(s[0])) && Number.isFinite(Number(s[1]))) base.push([Number(s[0]), Math.max(Number(s[0]), Number(s[1]))]);
  const forced = new Set((need.clipIds ?? []).filter((id) => typeof id === 'string' && id));

  const nodeList = Array.isArray(project.cardNodes) ? project.cardNodes : isObj(project.cardNodes) ? Object.values(project.cardNodes) : [];
  const nodeById = new Map(nodeList.filter((n) => n && typeof n.id === 'string').map((n) => [n.id, n]));
  /** 全部时间轴（激活的 + 停放的）：剪辑段换算、点名的片段、转场都要在里面找 */
  const timelines = [ACTIVE, ...(Array.isArray(project.cuts) ? project.cuts.map((c) => c?.id).filter((id) => typeof id === 'string' && id !== activeIdOf(project)) : [])];
  const transitionsOf = (tid) => {
    if (tid === ACTIVE) return Array.isArray(project.transitions) ? project.transitions : [];
    const entry = (project.cuts ?? []).find((c) => c?.id === tid);
    return Array.isArray(entry?.transitions) ? entry.transitions : [];
  };

  /** 时间轴 → 要的区间（剪辑段换算出来的会往停放的时间轴里加） */
  let needs = new Map([[ACTIVE, mergeIntervals(base)]]);
  let kept = new Map();
  let keptNodes = new Set();
  for (let round = 0; round < 1000; round += 1) {
    kept = new Map();
    const nextNeeds = new Map([[ACTIVE, needs.get(ACTIVE)]]);
    const addNeed = (tid, list) => { nextNeeds.set(tid, mergeIntervals([...(nextNeeds.get(tid) ?? []), ...list])); };
    /** 一条时间轴里留下的片段；剪辑段按换算后的区间把需要传给被引用的那条 */
    const visit = (tid, depth, path) => {
      const tracks = tracksOf(project, tid);
      if (!tracks) return;
      const intervals = (tid === ACTIVE ? nextNeeds.get(ACTIVE) : needs.get(tid)) ?? [];
      const set = kept.get(tid) ?? new Set();
      kept.set(tid, set);
      for (const track of tracks) {
        for (const clip of track?.clips ?? []) {
          if (!clip || typeof clip.id !== 'string') continue;
          if (!(forced.has(clip.id) || clipNeeded(clip, intervals, margin))) continue;
          set.add(clip.id);
          if (typeof clip.cutId === 'string' && clip.cutId) {
            if (path.includes(clip.cutId) || depth >= MAX_DEPTH) continue; // 有环、太深：不再往下（舞台也不画）
            const start = num(clip.start, NaN), end = num(clip.end, NaN);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            const offset = Math.max(0, num(clip.cutOffset, 0));
            const shift = start - offset;
            // 点名的剪辑段按整段取；否则按要的区间与这一段露出来的窗口的交集换算
            const outer = forced.has(clip.id) ? [[start, end]] : intervals;
            const local = [];
            for (const [a, b] of outer) {
              const lo = Math.max(a, start - CARD_MOUNT_LEAD - margin), hi = Math.min(b, end + margin);
              if (hi >= lo) local.push([lo - shift, hi - shift]);
            }
            if (local.length) {
              addNeed(clip.cutId, local);
              visit(clip.cutId, depth + 1, [...path, clip.cutId]);
            }
          }
        }
      }
    };
    visit(ACTIVE, 0, [activeIdOf(project) ?? ACTIVE]);
    // 点名的片段（素材效果卡的输入、转场的另一段）可能在没被剪辑段引用到的停放时间轴里：也看一遍
    for (const tid of timelines) {
      if (kept.has(tid)) continue;
      const tracks = tracksOf(project, tid);
      if (!tracks) continue;
      const set = new Set();
      for (const track of tracks) for (const clip of track?.clips ?? []) if (clip && forced.has(clip.id)) set.add(clip.id);
      if (set.size) kept.set(tid, set);
    }
    // 依赖：素材效果卡的节点与它的输入、转场的两段
    let grew = false;
    const force = (id) => { if (typeof id === 'string' && id && !forced.has(id)) { forced.add(id); grew = true; } };
    keptNodes = new Set();
    const walkNode = (id) => {
      if (typeof id !== 'string' || !id) return;
      const ref = clipRefOf(id);
      if (ref) { force(ref); return; }
      if (keptNodes.has(id)) return;
      const node = nodeById.get(id);
      if (!node) return;
      keptNodes.add(id);
      for (const input of Object.values(node.inputs ?? {})) walkNode(typeof input === 'string' ? input : input?.nodeId);
    };
    for (const [tid, set] of kept) {
      const tracks = tracksOf(project, tid) ?? [];
      for (const track of tracks) for (const clip of track?.clips ?? []) if (clip && set.has(clip.id) && clip.nodeId) walkNode(clip.nodeId);
      for (const tr of transitionsOf(tid)) {
        if (set.has(tr?.aId) || (tr?.bId && set.has(tr.bId))) { force(tr.aId); if (tr.bId) force(tr.bId); }
      }
    }
    const needsChanged = nextNeeds.size !== needs.size || [...nextNeeds].some(([tid, list]) => !needs.has(tid) || !sameIntervals(list, needs.get(tid)));
    needs = nextNeeds;
    if (!grew && !needsChanged) break;
  }

  // ---------- 拼出只含这些片段的项目
  const keepIn = (tid) => kept.get(tid) ?? new Set();
  const trimTracks = (tracks, set) => tracks.map((track) => ({ ...track, clips: (track?.clips ?? []).filter((c) => c && set.has(c.id)) }));
  const keptClips = [];
  for (const [tid, set] of kept) for (const track of tracksOf(project, tid) ?? []) for (const clip of track?.clips ?? []) if (clip && set.has(clip.id)) keptClips.push(clip);

  const out = { ...project, tracks: trimTracks(project.tracks, keepIn(ACTIVE)) };
  if (Array.isArray(project.transitions)) out.transitions = project.transitions.filter((tr) => keepIn(ACTIVE).has(tr?.aId) && (!tr?.bId || keepIn(ACTIVE).has(tr.bId)));
  if (project.cardNodes !== undefined) {
    out.cardNodes = Array.isArray(project.cardNodes)
      ? project.cardNodes.filter((n) => keptNodes.has(n?.id))
      : Object.fromEntries(Object.entries(project.cardNodes ?? {}).filter(([, n]) => keptNodes.has(n?.id)));
  }
  if (Array.isArray(project.cuts)) {
    const active = activeIdOf(project);
    out.cuts = project.cuts.map((entry) => {
      if (!entry || entry.id === active || !Array.isArray(entry.tracks)) return entry;
      const set = keepIn(entry.id);
      const trimmed = { ...entry, tracks: trimTracks(entry.tracks, set) };
      if (Array.isArray(entry.transitions)) trimmed.transitions = entry.transitions.filter((tr) => set.has(tr?.aId) && (!tr?.bId || set.has(tr.bId)));
      return trimmed;
    });
  }
  // 效果库：只留留下的片段引用到的那几条
  for (const [field, library] of [['filter', 'filters'], ['pixelMap', 'pixelMaps'], ['audioFx', 'audioFx']]) {
    if (!Array.isArray(project[library])) continue;
    const ids = new Set(keptClips.map((c) => c?.[field]?.id).filter(Boolean));
    out[library] = project[library].filter((d) => ids.has(d?.id));
  }
  // 素材：留下的片段、节点、效果定义、项目样式里出现过的（id、哈希、地址）
  const strings = new Set();
  collectStrings(keptClips, strings);
  collectStrings([...keptNodes].map((id) => nodeById.get(id)), strings);
  for (const library of ['filters', 'pixelMaps', 'audioFx']) collectStrings(out[library], strings);
  collectStrings(project.style, strings);
  const hashes = new Set();
  for (const s of strings) for (const h of s.toLowerCase().match(HEX64) ?? []) hashes.add(h);
  const media = Array.isArray(project.media) ? project.media : [];
  const keptMedia = media.filter((m) => m && (strings.has(m.id) || (typeof m.hash === 'string' && hashes.has(m.hash.toLowerCase())) || (typeof m.url === 'string' && strings.has(m.url))));
  if (Array.isArray(project.media)) out.media = keptMedia;

  const cardIds = new Set();
  for (const c of keptClips) if (typeof c.cardId === 'string' && c.cardId) cardIds.add(c.cardId);
  for (const id of keptNodes) { const n = nodeById.get(id); if (typeof n?.cardId === 'string' && n.cardId) cardIds.add(n.cardId); }
  const cutIds = [...kept.keys()].filter((tid) => tid !== ACTIVE && keepIn(tid).size > 0);
  return {
    project: out,
    clipIds: keptClips.map((c) => c.id),
    cardIds: [...cardIds].sort(),
    mediaIds: keptMedia.map((m) => m.id),
    nodeIds: [...keptNodes].sort(),
    cutIds,
  };
}

/* ------------------------------------------------------------------ 看画面请求：要的是哪几帧 */

/** 项目时长内最后一帧的时刻（与工作进程 `/api/vision/snapshot` 的夹法一致：超出的按最后一帧渲） */
function clampTime(project, t) {
  const fps = num(project?.fps, 30) > 0 ? num(project.fps, 30) : 30;
  const last = Math.max(0, Math.floor(num(project?.duration, 0) * fps) - 1) / fps;
  return Math.min(Math.max(0, t), last);
}

/** 一个时刻在工作进程里实际渲的是哪一帧：原时刻与那一帧的时刻都算上（超集） */
function frameTimes(project, t) {
  const fps = num(project?.fps, 30) > 0 ? num(project.fps, 30) : 30;
  const c = clampTime(project, t);
  return [c, Math.round(c * fps) / fps];
}

function clipSpan(project, clipId) {
  for (const track of project?.tracks ?? []) for (const c of track?.clips ?? []) if (c?.id === clipId) return [num(c.start, 0), num(c.end, 0)];
  return null;
}

/**
 * 看画面的请求（`server/hosted-render/look.mjs` 的 `LOOK_ROUTES`）要的是哪几帧、哪张卡。认不出的回 null（不展开，原样转发）。
 * @returns {null | { key: 'project' | 'after', need: { times?: number[], spans?: [number, number][], clipIds?: string[] } }}
 *   `key`：项目在请求体里的哪个字段
 */
export function lookNeed(pathname, body) {
  if (!isObj(body)) return null;
  const clipId = typeof body.clipId === 'string' && body.clipId ? body.clipId : null;
  const project = pathname === '/api/ai/visual' ? body.after : body.project;
  if (!isObj(project) || !Array.isArray(project.tracks)) return null;
  const key = pathname === '/api/ai/visual' ? 'after' : 'project';
  const spanOf = () => {
    const span = clipId ? clipSpan(project, clipId) : null;
    return span ? { key, need: { spans: [span], clipIds: [clipId] } } : null;
  };
  switch (pathname) {
    case '/api/vision/snapshot': {
      const list = Array.isArray(body.times) ? body.times.map(Number).filter(Number.isFinite).slice(0, 10) : [];
      let times = list;
      if (!times.length) {
        let at = Number(body.t);
        if (clipId && !Number.isFinite(at)) {
          const span = clipSpan(project, clipId);
          if (!span) return null; // 工作进程会回「没有这个片段」：原样转发
          at = (span[0] + span[1]) / 2;
        }
        times = [Number.isFinite(at) ? at : 0];
      }
      return { key, need: { times: times.flatMap((t) => frameTimes(project, t)), clipIds: clipId ? [clipId] : [] } };
    }
    case '/api/vision/bake':
    case '/api/cards/dom': {
      if (!clipId) return null;
      const t = Number(body.t);
      if (!Number.isFinite(t)) return spanOf();
      return { key, need: { times: frameTimes(project, t), clipIds: [clipId] } };
    }
    case '/api/cards/layout': {
      const t = Number(body.t);
      const ids = Array.isArray(body.clipIds) ? body.clipIds.filter((x) => typeof x === 'string') : [];
      if (!Number.isFinite(t)) return null;
      return { key, need: { times: frameTimes(project, t), clipIds: ids } };
    }
    case '/api/ai/visual':
      return body.tool === 'get_gif' ? spanOf() : null;
    case '/api/cards/audio':
      return spanOf();
    default:
      return null;
  }
}

/**
 * 把看画面请求体里的项目换成展开后的那一份。认不出的请求原样回。
 * @returns {{ body: object, expanded: null | ReturnType<typeof expandProject> }}
 */
export function expandLookBody(pathname, body) {
  const hit = lookNeed(pathname, body);
  if (!hit) return { body, expanded: null };
  const expanded = expandProject(body[hit.key], hit.need);
  return { body: { ...body, [hit.key]: expanded.project }, expanded };
}

/* ------------------------------------------------------------------ 产流任务：一条流要的是哪一段 */

/** 剪辑段里摊出来的虚拟片段 id 的分隔符（同 `src/kernel/cutFlatten.mjs` 的 `FLAT_SEP`；这里不引 `src/`） */
const FLAT_SEP = '~';
/** 片段 id 在顶层时间轴上对应的那个片段：摊出来的虚拟片段（`段 id~里面的片段 id`）对应它最外层的剪辑段 */
const topLevelIdOf = (id) => (typeof id === 'string' && id.includes(FLAT_SEP) ? id.slice(0, id.indexOf(FLAT_SEP)) : id);

/**
 * 一条轨道流（或导出位图）要的是哪一段：从回放起点（挂载帧，推帧卡要从这里推）到最后一帧，点名这条流的卡、它下面的层。
 * 发布方（切分时写 `requires.cardSources`、算依赖下层的流退回整场景时的键）与节点（产流时只装这一段用到的）**用同一个函数**，
 * 对同一条流算出同一个 `need`，展开出同一个子集（`expandProject` 是确定的）。认不出（没有帧号、没有帧率）回 null。
 * @param {{ fps?: number, mountFrame?: number, firstFrame?: number, lastFrame?: number, clipIds?: string[], belowClipIds?: string[], topClipId?: string }} spec
 * @returns {null | { spans: [number, number][], clipIds: string[] }}
 */
export function streamNeed(spec) {
  const fps = Number(spec?.fps);
  const last = Number(spec?.lastFrame);
  const starts = [spec?.mountFrame, spec?.firstFrame].map(Number).filter(Number.isFinite);
  if (!(fps > 0) || !Number.isFinite(last) || !starts.length) return null;
  const from = Math.min(...starts);
  const ids = [...(spec.clipIds ?? []), ...(spec.belowClipIds ?? []), spec.topClipId].filter((id) => typeof id === 'string' && id).map(topLevelIdOf);
  return { spans: [[from / fps, (last + 1) / fps]], clipIds: [...new Set(ids)].sort() };
}

/**
 * 子集里用到的定制卡的代码身份：`versions`（卡片 id → 代码身份，整个项目的）里，卡片 id 在展开后的子集里出现过的那几项
 * （片段的 `cardId`、素材效果卡节点、部件参数里按 id 引用的都算：按子集里的字符串找，取超集）。
 * 切分时写进流任务的 `requires.cardSources`：节点手里有这几份代码就能认领，不必有整个项目的卡。
 */
export function subsetCardSources(project, need, versions = {}) {
  const out = {};
  if (!need) { for (const [k, v] of Object.entries(versions ?? {})) if (typeof v === 'string' && v) out[k] = v; return out; }
  const sub = expandProject(project, need).project;
  const strings = new Set();
  collectStrings(sub.tracks, strings);
  collectStrings(sub.cardNodes, strings);
  collectStrings(sub.cuts, strings);
  for (const [cardId, version] of Object.entries(versions ?? {})) if (typeof version === 'string' && version && strings.has(cardId)) out[cardId] = version;
  return out;
}

/** 这个进程是不是多项目模式的渲染节点（独立渲染主机、托管方渲染服务的工作进程：`profile: 'host'`）。桌面版的预渲染进程是单项目模式 */
export const multiProjectNode = (env = process.env) => String(env?.PROMPTCUT_NODE_PROFILE ?? '') === 'host';
