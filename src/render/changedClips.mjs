/**
 * Two-level diff and three-level hash cache (A7).
 *
 * # Why not push the full project
 *
 * Every edit on the editor page pushes the entire project to the mirror plugin, and project JSON
 * with dozens of clips is several hundred KB; dragging a clip over 2 seconds pushes dozens of
 * times, which overwhelms both bandwidth and JSON.stringify. Yet what actually changes is usually
 * only **a single clip**: the store uses immutable updates, so untouched object references remain
 * unchanged, allowing "what changed" to be determined by reference comparison, with each push
 * containing only that clip (< 8 KB in practice).
 *
 * # Two levels
 *
 * 1. **Top level**: Compare each field by reference following the signature field list in
 *    `frameClient.ts`. If anything other than `tracks` changes (changing media, aspect ratio,
 *    theme, card definitions...), push the full project: those fields rarely change anyway,
 *    building deltas for them is not worth it, and missing even one would silently cause desync
 *    between the mirror and the page.
 * 2. **Track level**: Descend only when `tracks` changes. First compare track references to
 *    identify track-level changes (additions/deletions, order, and own properties like `hidden` /
 *    `muted`), then compare clips by reference for **tracks whose reference changed** (comparing
 *    both media clips and card clips).
 *
 * # Three-level hash cache
 *
 * `projectHash` is the criterion for determining "whether the project obtained after the server
 * applies the patch is identical to the one on the page." It is computed across three levels:
 * field → track → clip, with each level cached by **object reference** using a `WeakMap`: dragging
 * a clip only recalculates 1 clip + 1 track + the top-level concatenation, while the rest are all
 * cache hits (< 2 ms in practice). Using references as keys also solves invalidation: if an object
 * hasn't been replaced, it definitely hasn't changed; if replaced, it isn't in the WeakMap to begin
 * with.
 *
 * # Why the hash is not sha256
 *
 * Both the stage bundle and Node need to compute synchronously (`crypto.subtle` is async, and
 * `node:crypto` is unavailable in the page), and what is needed here is "do both sides compute the
 * same result?", not collision resistance. An FNV-1a variant, 64-bit hex, pure string operations.
 */

/**
 * Top-level field list compared by reference: **same set and same order** as `signature()`
 * in `src/render/frameClient.ts`. If a field is added there, one must be added here; otherwise
 * the mirror hash won't see it, making the 409 gate useless: `changedClips.test.mjs` reads
 * frameClient's source code to compare against this table verbatim, turning red immediately
 * if either side is missed.
 */
export const TOP_FIELDS = [
  "width", "height", "fps", "duration", "themeId", "camera3dFov",
  "tracks", "media", "filters", "pixelMaps", "audioFx",
  "cardNodes", "style",
];

import { activeCutRenderMeta, reachableCutContents } from "../kernel/cutIdentity.mjs";

/** Recalculation count (cache misses). Used by tests to prove "the same set of references will not recalculate" */
const stats = { fields: 0, tracks: 0, clips: 0, values: 0 };
/** Takes a snapshot of the recalculation count */
export function hashStats() { return { ...stats }; }
/** Resets the count to zero */
export function resetHashStats() { stats.fields = 0; stats.tracks = 0; stats.clips = 0; stats.values = 0; }

/** Two-way variant of FNV-1a, concatenated into 16 hex characters */
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

/* Three-level cache. Keys are object references, so when the project swaps
 * in new objects, old ones are automatically collected */
const fieldsCache = new WeakMap();
const valueCache = new WeakMap();
const trackCache = new WeakMap();
const clipCache = new WeakMap();

/** Level 3: a clip */
function clipHash(clip) {
  let h = clipCache.get(clip);
  if (h === undefined) { stats.clips++; h = hashString(JSON.stringify(clip)); clipCache.set(clip, h); }
  return h;
}

/**
 * Level 2: a track. **Clips and track's own properties are computed separately**, so key order
 * on the track object (which position `clips` appears at) does not affect the result: when the
 * server applies the patch, the reconstructed track key order may not match the page's copy;
 * computing them separately ensures hashes on both sides match.
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

/** Non-track fields in level 1: stringified once as a block and cached by reference (media may be large) */
function valueHash(v) {
  if (v === null || typeof v !== "object") return String(JSON.stringify(v));
  let h = valueCache.get(v);
  if (h === undefined) { stats.values++; h = hashString(JSON.stringify(v)); valueCache.set(v, h); }
  return h;
}

/** Project render identity hash (covers `TOP_FIELDS` only; `name` / `id` / draft metadata excluded) */
export function projectHash(project) {
  let h = fieldsCache.get(project);
  if (h === undefined) {
    stats.fields++;
    const parts = [];
    for (const k of TOP_FIELDS) {
      const v = project[k];
      parts.push(k + ":" + (k === "tracks" ? tracksHash(Array.isArray(v) ? v : []) : valueHash(v)));
    }
    // Cut referenced by cut segments (kernel/cutIdentity.mjs): added only if present;
    // projects without cut segments do not change the hash by a single byte
    const cutRefs = reachableCutContents(project);
    if (cutRefs.length) parts.push("cutRefs:" + hashString(JSON.stringify(cutRefs)));
    const cutMeta = activeCutRenderMeta(project);
    if (cutMeta) parts.push("cutMeta:" + hashString(JSON.stringify(cutMeta)));
    h = hashString(parts.join("|"));
    fieldsCache.set(project, h);
  }
  return h;
}

/** Are all own keys other than `skip` equal by reference? */
function sameByRef(a, b, skip) {
  for (const k of Object.keys(a)) if (k !== skip && a[k] !== b[k]) return false;
  for (const k of Object.keys(b)) if (k !== skip && !(k in a)) return false;
  return true;
}

function idsOf(list) { return (list || []).map((x) => x.id); }
function sameOrder(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }

/**
 * Patch between two projects. If `prev` is empty or any field other than `tracks` changed → full.
 *
 * The returned shape is the argument for future stage RPC `setProject(patch)` (see `ProjectPatch`).
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
    // Newly added tracks are provided in full: no baseline to compare against, computing per clip is actually larger
    if (!before) { tracks.push({ id: tr.id, track: tr }); continue; }
    if (before === tr) continue;

    const patch = { id: tr.id };
    if (!sameByRef(before, tr, "clips")) {
      // Own properties are provided as a **whole group** (just id / name / hidden / muted / locked),
      // so that "deleting the hidden key" can also be expressed without keeping a separate deletion table
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

/** Whether the patch contains actual changes (empty patches need not be sent) */
export function isEmptyPatch(patch) {
  return !!patch && patch.kind === "tracks" && !patch.order && (!patch.tracks || patch.tracks.length === 0);
}

/**
 * Applies the patch to a project and returns a **new** project object (does not mutate original:
 * mirror must retain old version by version number). Throws if patch mismatches baseline: caller
 * (mirror plugin) translates it to 409, asking the page to repush in full.
 */
export function applyProjectPatch(project, patch) {
  if (!patch) return project;
  if (patch.kind === "full") return patch.project;
  if (patch.kind !== "tracks") throw new Error(`Unknown patch type: ${patch.kind}`);

  const byId = new Map((project.tracks || []).map((t) => [t.id, t]));
  for (const tp of patch.tracks || []) {
    if (tp.track) { byId.set(tp.id, tp.track); continue; }
    const base = byId.get(tp.id);
    if (!base) throw new Error(`Patch references a nonexistent track: ${tp.id}`);
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
        if (!c) throw new Error(`Patch references a nonexistent clip: ${id}`);
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
    if (!t) throw new Error(`Patch references a nonexistent track: ${id}`);
    return t;
  });
  return { ...project, tracks };
}
