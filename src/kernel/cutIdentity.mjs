/**
 * "Render identity" of cut segments: content of cuts reachable from the active cut via cut segments
 * (to arbitrary depth).
 *
 * Visual caching and prerender identity (project hash for mirrors `projectHash` in
 * `render/changedClips.mjs`, frame service `server/frame-identity.mjs`, snapshot signature
 * `render/frameClient.ts`) originally only inspected `tracks` in the active cut. Cuts referenced by
 * cut segments live in `cuts[]`; if excluded, modifying referenced cuts fails to invalidate old
 * caches (Argon review feedback: "include referenced cut contents in cache and prerender identity").
 *
 * Projects without cut segments return an empty array, and callers accordingly **add nothing to the
 * identity**: hashes and cache keys for legacy projects remain unchanged byte-for-byte.
 *
 * Pure JS (.mjs): frame service and mirror plugins on the server import directly without TS. Same
 * convention as the storage format in `cutSegments.ts`.
 */

function activeIdOf(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

function extraCutMeta(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const out = {};
  if (entry.kind === '3d') out.kind = '3d';
  if (typeof entry.camera3dFov === 'number' && Number.isFinite(entry.camera3dFov)) out.camera3dFov = entry.camera3dFov;
  if (typeof entry.spaceWidth === 'number' && Number.isFinite(entry.spaceWidth)) out.spaceWidth = entry.spaceWidth;
  if (typeof entry.spaceHeight === 'number' && Number.isFinite(entry.spaceHeight)) out.spaceHeight = entry.spaceHeight;
  if (Array.isArray(entry.cameras) && entry.cameras.length > 0) out.cameras = entry.cameras;
  return Object.keys(out).length ? out : null;
}

/**
 * Render-affecting metadata on the active cut (`kind`, `camera3dFov`, `spaceWidth`, `spaceHeight`, `cameras`)
 * plus ephemeral `_renderView` when set to `"space"`.
 * Returns `null` when everything is at legacy 2D defaults so legacy project cache keys stay byte-identical.
 */
export function activeCutRenderMeta(p) {
  if (!p || typeof p !== 'object') return null;
  const id = activeIdOf(p);
  const cuts = Array.isArray(p.cuts) ? p.cuts : [];
  const entry = id ? cuts.find((c) => c?.id === id) : undefined;
  const base = extraCutMeta(entry);
  const view = p._renderView && p._renderView !== 'camera' ? p._renderView : undefined;
  if (!base && !view) return null;
  return { ...(base || {}), ...(view ? { renderView: view } : {}) };
}

function contentOf(p, cutId) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  const entry = cuts.find((c) => c?.id === cutId);
  if (!entry) return null;
  const meta = extraCutMeta(entry);
  if (cutId === activeIdOf(p)) {
    return { id: cutId, tracks: p.tracks ?? [], duration: p.duration, transitions: p.transitions ?? [], ...(meta || {}) };
  }
  if (!Array.isArray(entry.tracks)) return null;
  return { id: cutId, tracks: entry.tracks, duration: entry.duration, transitions: entry.transitions ?? [], ...(meta || {}) };
}

function targetsOf(tracks) {
  const out = [];
  for (const tr of tracks ?? []) for (const c of tr?.clips ?? []) {
    if (typeof c?.cutId === 'string' && c.cutId && !out.includes(c.cutId)) out.push(c.cutId);
  }
  return out;
}

const memo = new WeakMap();

/**
 * Starting from `tracks` (defaults to the active cut's), content of cuts reachable via cut segments,
 * sorted by id. The active cut itself is not included (it is tracks); edges forming cycles stop at
 * already visited cuts.
 */
export function reachableCutContents(project, tracks = project?.tracks) {
  if (!project || !Array.isArray(project.cuts)) return [];
  const useMemo = tracks === project.tracks;
  if (useMemo && memo.has(project)) return memo.get(project);
  const root = activeIdOf(project);
  const seen = new Set(root ? [root] : []);
  const out = [];
  const stack = targetsOf(tracks);
  while (stack.length) {
    const id = stack.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const content = contentOf(project, id);
    if (!content) continue;
    out.push(content);
    for (const next of targetsOf(content.tracks)) if (!seen.has(next)) stack.push(next);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (useMemo) memo.set(project, out);
  return out;
}

/** Asset ids used in `tracks`, together with those used in cuts reached via cut segments */
export function reachableMediaIds(project, tracks = project?.tracks) {
  const ids = new Set();
  const add = (list) => { for (const tr of list ?? []) for (const c of tr?.clips ?? []) if (c?.mediaId) ids.add(c.mediaId); };
  add(tracks);
  for (const c of reachableCutContents(project, tracks)) add(c.tracks);
  return ids;
}
