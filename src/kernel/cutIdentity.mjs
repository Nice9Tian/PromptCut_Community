/**
 * 剪辑段的「渲染身份」:激活剪辑经剪辑段(任意深度)能走到的那些剪辑的内容。
 *
 * 画面的缓存与预渲染的身份(镜像的项目哈希 `render/changedClips.mjs` 的 `projectHash`、帧服务的
 * `server/frame-identity.mjs`、快照签名 `render/frameClient.ts`)原来只看激活剪辑的 `tracks`。
 * 剪辑段引用的剪辑住在 `cuts[]` 里,不把它们算进去的话,改了被引用剪辑旧缓存不失效
 * (Argon 审核意见「缓存与预渲染的身份把被引用剪辑内容算进去」)。
 *
 * 没有剪辑段的项目返回空数组,调用方据此**不往身份里加任何东西**:老项目的哈希、缓存键一个字节不变。
 *
 * 纯 JS(.mjs):服务端的帧服务、镜像插件直接 import,不经 TS。和 `cutSegments.ts` 的存法同一口径。
 */

function activeIdOf(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

function contentOf(p, cutId) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  const entry = cuts.find((c) => c?.id === cutId);
  if (!entry) return null;
  if (cutId === activeIdOf(p)) return { id: cutId, tracks: p.tracks ?? [], duration: p.duration, transitions: p.transitions ?? [] };
  if (!Array.isArray(entry.tracks)) return null;
  return { id: cutId, tracks: entry.tracks, duration: entry.duration, transitions: entry.transitions ?? [] };
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
 * 从 `tracks`(缺省激活剪辑的)出发,经剪辑段能走到的剪辑的内容,按 id 排好。
 * 激活剪辑自己不在里面(它就是 tracks);成环的那条边到已经走过的剪辑为止。
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

/** `tracks` 里用到的素材 id,连同经剪辑段走到的剪辑里用到的 */
export function reachableMediaIds(project, tracks = project?.tracks) {
  const ids = new Set();
  const add = (list) => { for (const tr of list ?? []) for (const c of tr?.clips ?? []) if (c?.mediaId) ids.add(c.mediaId); };
  add(tracks);
  for (const c of reachableCutContents(project, tracks)) add(c.tracks);
  return ids;
}
