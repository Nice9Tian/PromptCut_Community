import { createHash } from 'node:crypto';
import { reachableCutContents, reachableMediaIds } from '../src/kernel/cutIdentity.mjs';
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(stableJson(value)).digest('hex');
/**
 * Audio, UI state and unrelated cuts do not change this cut's pixels. Cuts that
 * this cut shows through cut segments (any depth) do: their content joins the
 * digest only when present, so projects without segments keep their keys.
 */
export function frameIdentity(project, code = '') {
  const { width, height, fps, duration, themeId, camera3dFov, tracks, media, filters, pixelMaps, cardNodes, style } = project;
  const refs = reachableCutContents(project, tracks);
  // v3: direct React subtitles compute their transitions from local time.
  // Old HTML/MOV entries must not retain the previous Motion-based phase.
  return digest({ pipeline: 4, code, width, height, fps, duration, themeId, camera3dFov, tracks, media, filters, pixelMaps, cardNodes, style, cutRefs: refs.length ? refs : undefined });
}
export function trackPrefixes(project, code = '') {
  return [...project.tracks].reverse().filter(t => !t.hidden).map((track, i, bottomUp) => {
    const tracks = bottomUp.slice(0, i + 1).reverse();
    // 剪辑段:被引用剪辑里用到的素材也要留在子集里(kernel/cutIdentity.mjs)
    const mediaIds = reachableMediaIds(project, tracks);
    const subset = { ...project, tracks, media: project.media.filter(m => mediaIds.has(m.id)) };
    return { trackId: track.id, trackIds: tracks.map(t => t.id), key: frameIdentity(subset, code) };
  });
}
