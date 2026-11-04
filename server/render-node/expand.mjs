/**
 * "Expansion" in multi-project mode (semantics: `docs/semantics/product/rendering.md` "Two modes of
 * render services"; mechanism: `docs/semantics/mechanism/rendering.md` "Practices in multi-project
 * mode", item 1): starting from the frames (or the card segment) requested by a request, assemble
 * a project containing only the clips used and pass it to the render page.
 *
 *   - Take clips mounted on these frames (including mount lead `CARD_MOUNT_LEAD`); each clip keeps
 *     its card (code identity `cardId`, parameters, parts, all preserved as-is on the clip) and
 *     used assets;
 *   - Follow dependencies until no new ones can be found:
 *       · Below-dependent cards include layers below them: lower-layer clips mounted at the same
 *         moment in frame requests are already present; requests for "a segment of a card" take
 *         the whole segment, so all lower layers mounted during this segment are included;
 *       · Transitions include both adjacent clips (if either `aId` or `bId` in `transitions` is
 *         retained, both are retained, and the transition record is also retained);
 *       · Media effect cards include their inputs (clip `nodeId` → this node in `cardNodes`, and
 *         nodes reached by traversing `inputs`; when an input points to another clip
 *         `@clip/<id>/…`, that clip is also retained, whether or not it is on these frames);
 *       · Cut segments (`cutId`) include clips in the referenced cut that, after time conversion
 *         for the segment, are also mounted on these frames (arbitrary depth, stops on cycles);
 *   - In addition, project-level settings: fields such as aspect ratio, frame rate, duration,
 *     theme, style, and 3D field of view are **preserved as-is** (only replacing contents in
 *     `tracks`, `transitions`, `cardNodes`, `media`, effects library, and `cuts`);
 *   - **Timeline positions unchanged**: retained clips are not altered at all, no tracks are
 *     deleted (only clips inside them are reduced), painter's order is unchanged; frame-push cards
 *     replay from their own mount frames as usual.
 *
 * **Take supersets, never omit**: clips not mounted on these frames do not render into the picture,
 * so retaining an extra one does not alter the image; omitting one causes errors. Therefore, when
 * checking "mounted or not", an extra frame (`1 / fps`) is added before and after, which is
 * strictly greater than or equal to the stage's mounting formula (`cardMountedAt` in
 * `frameWindow.mjs`).
 *
 * Pure function, does not mutate input arguments, does not import `src/`. Single-project mode
 * (prerender process in desktop app) does not go through here.
 */
/**
 * Mount lead (seconds), same value as `CARD_MOUNT_LEAD` in stage's `src/render/frameWindow.mjs`.
 * Copied here instead of imported: standalone entry points like render service and Agent service
 * are not allowed to import `src/` (`server/test/accept-018-rest-ssr-seam.test.mjs`). Equality on
 * both sides is verified by `server/test/multi-project-expand.test.mjs`
 */
export const CARD_MOUNT_LEAD = 0.05;

const ACTIVE = '\u0000active';
const MAX_DEPTH = 32;
const HEX64 = /[0-9a-f]{64}/g;

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Active cut in the cuts list (same as `activeIdOf` in `kernel/cutFlatten.mjs`) */
function activeIdOf(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c?.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

/** Track list for a timeline (active is `project.tracks`; parked are in `cuts[].tracks`); returns null if not found */
function tracksOf(project, timelineId) {
  if (timelineId === ACTIVE) return Array.isArray(project.tracks) ? project.tracks : [];
  if (timelineId === activeIdOf(project)) return Array.isArray(project.tracks) ? project.tracks : [];
  const entry = (Array.isArray(project.cuts) ? project.cuts : []).find((c) => c?.id === timelineId);
  return entry && Array.isArray(entry.tracks) ? entry.tracks : null;
}

/** Merges and deduplicates interval lists (closed intervals `[lo, hi]`, single time point is `[t, t]`) */
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

/** Whether the clip's mounted interval (with lead, extra `margin` before/after) intersects requested interval */
function clipNeeded(clip, intervals, margin) {
  const start = num(clip.start, NaN), end = num(clip.end, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true; // Retain clips whose start/end cannot be recognized (superset)
  const lo = start - CARD_MOUNT_LEAD - margin, hi = end + margin;
  return intervals.some(([a, b]) => lo <= b && hi > a);
}

/** Clips referenced by node id: `@clip/<clip id>/<suffix>` */
function clipRefOf(nodeId) {
  const m = /^@clip\/([^/]+)\//.exec(String(nodeId ?? ''));
  return m ? m[1] : null;
}

/** Collects all strings in a value into `out` (asset references: id, hash, URL in params, parts, nodes, effect defs) */
function collectStrings(value, out, depth = 0) {
  if (depth > 64 || value === null || value === undefined) return;
  if (typeof value === 'string') { out.add(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return; }
  if (typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
}

/**
 * Expand.
 * @param {any} project Entire project (not mutated)
 * @param {object} need What this request needs
 * @param {number[]} [need.times] Requested times (seconds)
 * @param {number[]} [need.frames] Requested frame numbers (converted to times using project frame rate)
 * @param {[number, number][]} [need.spans] Requested time spans (seconds, `[start, end)`): "a segment of a card"
 * @param {string[]} [need.clipIds] Clips that must be retained (the card specified by request), whether or not on these frames
 * @returns {{ project: any, clipIds: string[], cardIds: string[], mediaIds: string[], nodeIds: string[], cutIds: string[] }}
 *   `project` is the project containing only used clips; the rest records what was retained (for diagnostics and tests)
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
  /** All timelines (active + parked): cut segment conversions, specified clips, transitions are all looked up here */
  const timelines = [ACTIVE, ...(Array.isArray(project.cuts) ? project.cuts.map((c) => c?.id).filter((id) => typeof id === 'string' && id !== activeIdOf(project)) : [])];
  const transitionsOf = (tid) => {
    if (tid === ACTIVE) return Array.isArray(project.transitions) ? project.transitions : [];
    const entry = (project.cuts ?? []).find((c) => c?.id === tid);
    return Array.isArray(entry?.transitions) ? entry.transitions : [];
  };

  /** Timeline → requested intervals (intervals converted from cut segments are added to parked timelines) */
  let needs = new Map([[ACTIVE, mergeIntervals(base)]]);
  let kept = new Map();
  let keptNodes = new Set();
  for (let round = 0; round < 1000; round += 1) {
    kept = new Map();
    const nextNeeds = new Map([[ACTIVE, needs.get(ACTIVE)]]);
    const addNeed = (tid, list) => { nextNeeds.set(tid, mergeIntervals([...(nextNeeds.get(tid) ?? []), ...list])); };
    /** Retained clips in a timeline; cut segments pass requirements to referenced cuts using converted intervals */
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
            if (path.includes(clip.cutId) || depth >= MAX_DEPTH) continue; // Cycle or too deep: stop traversing (stage does not render either)
            const start = num(clip.start, NaN), end = num(clip.end, NaN);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            const offset = Math.max(0, num(clip.cutOffset, 0));
            const shift = start - offset;
            // Specified cut segments taken as whole segment; otherwise convert by intersecting requested spans with visible window
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
    // Specified clips (media effect card inputs, other side of transitions) may reside in parked timelines: inspect those too
    for (const tid of timelines) {
      if (kept.has(tid)) continue;
      const tracks = tracksOf(project, tid);
      if (!tracks) continue;
      const set = new Set();
      for (const track of tracks) for (const clip of track?.clips ?? []) if (clip && forced.has(clip.id)) set.add(clip.id);
      if (set.size) kept.set(tid, set);
    }
    // Dependencies: media effect card nodes and their inputs, both clips of transitions
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

  // ---------- Assemble a project containing only these clips
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
  // Effects library: retain only entries referenced by retained clips
  for (const [field, library] of [['filter', 'filters'], ['pixelMap', 'pixelMaps'], ['audioFx', 'audioFx']]) {
    if (!Array.isArray(project[library])) continue;
    const ids = new Set(keptClips.map((c) => c?.[field]?.id).filter(Boolean));
    out[library] = project[library].filter((d) => ids.has(d?.id));
  }
  // Assets: entries that appeared in retained clips, nodes, effect definitions, or project styles (id, hash, URL)
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

/* ------------------------------------------------------------------ Look requests: which frames are needed */

/** Time of last frame in project duration (matches clamping in `/api/vision/snapshot`: out-of-bounds renders as last frame) */
function clampTime(project, t) {
  const fps = num(project?.fps, 30) > 0 ? num(project.fps, 30) : 30;
  const last = Math.max(0, Math.floor(num(project?.duration, 0) * fps) - 1) / fps;
  return Math.min(Math.max(0, t), last);
}

/** Frame rendered for a time in worker process: includes both original time and that frame's time (superset) */
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
 * Frames and card needed by look requests (`LOOK_ROUTES` in `server/hosted-render/look.mjs`).
 * Returns null if unrecognized (not expanded, forwarded as-is).
 * @returns {null | { key: 'project' | 'after', need: { times?: number[], spans?: [number, number][], clipIds?: string[] } }}
 *   `key`: which field in the request body holds the project
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
          if (!span) return null; // Worker process will return "no such clip": forward as-is
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
 * Replaces the project in a look request body with the expanded version. Returns unrecognized
 * requests as-is.
 * @returns {{ body: object, expanded: null | ReturnType<typeof expandProject> }}
 */
export function expandLookBody(pathname, body) {
  const hit = lookNeed(pathname, body);
  if (!hit) return { body, expanded: null };
  const expanded = expandProject(body[hit.key], hit.need);
  return { body: { ...body, [hit.key]: expanded.project }, expanded };
}

/* ------------------------------------------------------------------ Stream tasks: which segment a stream needs */

/** Separator for virtual clip IDs flattened from cut segments (same as `FLAT_SEP` in `src/kernel/cutFlatten.mjs`; no `src/` import) */
const FLAT_SEP = '~';
/** Top-level timeline clip for a clip id: flattened virtual clips (`segment id~inner clip id`) map to outermost cut segment */
const topLevelIdOf = (id) => (typeof id === 'string' && id.includes(FLAT_SEP) ? id.slice(0, id.indexOf(FLAT_SEP)) : id);

/**
 * Which segment a track stream (or export bitmap) needs: from playback start (mount frame, where
 * frame-push cards push from) to the last frame, naming this stream's card and its lower layers.
 * Publisher (writing `requires.cardSources` during splitting, computing keys when below-dependent
 * streams fall back to whole scene) and node (loading only what is used in this segment during
 * stream generation) **use the same function**, computing the same `need` and expanding to the
 * same subset for the same stream (`expandProject` is deterministic). Returns null if unrecognized
 * (missing frame numbers or frame rate).
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
 * Code identities of custom cards used in the subset: entries in `versions` (card id → code
 * identity for the entire project) whose card ids appear in the expanded subset (clip `cardId`,
 * media effect card nodes, and part parameters referenced by id all count: matched by strings in
 * the subset, taking supersets).
 * Written into `requires.cardSources` of the stream task during splitting: the node can claim as
 * long as it has these code pieces, without needing cards for the entire project.
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

/** Whether process is a multi-project render node (standalone host, hosted render worker: `profile: 'host'`). Desktop prerender is single-project */
export const multiProjectNode = (env = process.env) => String(env?.PROMPTCUT_NODE_PROFILE ?? '') === 'host';
