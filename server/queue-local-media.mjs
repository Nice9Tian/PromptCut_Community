/**
 * Criteria for the local tier capability gate (M6c X2, `docs/plan/m6c-contract.md`): which assets in
 * the project exist only on the publisher's local machine, and which fine-grained tasks use them
 * in their inputs.
 *
 * **Assets without a content hash exist only locally**: hash-addressed assets can be retrieved by
 * other nodes via the asset service (the J.6 fallback only recognizes `/@media/<hash>`);
 * `/@media/<filename>` stored by filename during migration period, legacy `.proc` `path` /
 * `/api/media/file?path=`, and this export pass's own `/@export/…` all exist only on the publisher's
 * machine, and the frame pipeline also queries the local asset service (`media-stamp.mjs`) to stamp
 * them. When other nodes render such inputs, either they cannot retrieve the assets or they produce
 * different stamps (the local tier is blocked by `plan-mismatch`, but the shared tier cannot block
 * it). Therefore, when splitting, write `requires.localMedia = <publisher nodeId>` for these tasks,
 * so only the publisher's node can claim them.
 *
 * Which controls count as "used":
 *   - Local tier (whole scene render): counts if the project contains any such asset, as every
 *     layer of the whole scene might use it;
 *   - Track stream: same rationale, counts;
 *   - Shared tier (isolated single-card render, brings only this clip): counts only if this clip's
 *     JSON references the id / url / path of such asset; conservatively counted if this clip cannot
 *     be found in the project.
 *
 * Pure function, does no I/O; `vite-plugin-frames.ts` calls `withLocalMedia` based on this
 * version's entry after `executor.plan`.
 */
import { mediaHashOf } from './media-stamp.mjs';
import { snapshotTier } from './snapshot-tier.mjs';

/** Whether this asset's bytes exist only on this machine: has no content hash, and uses one of the local-address retrieval forms */
function onlyLocal(media) {
  if (!media || typeof media !== 'object' || mediaHashOf(media) !== null) return false;
  if (media.path) return true;
  const url = String(media.url || '');
  return url.startsWith('/@media/') || url.startsWith('/api/media/file?') || url.startsWith('/@export/');
}

/** Assets in the project that exist only on this machine (no content hash); returns these asset records as is */
export function hashlessMedia(project) {
  return (Array.isArray(project?.media) ? project.media : []).filter(onlyLocal);
}

/**
 * → `null` (no assets in the project exist only on this machine, no gate set) or `(control) => boolean` (whether this item's input uses them).
 * `control` is an item in the card plan (has `clipId`, `tier` / `capabilities`); stream tasks pass `{ clipId, kind: 'stream' }`.
 */
export function localMediaGate(project) {
  const local = hashlessMedia(project);
  if (local.length === 0) return null;
  // Look for "quoted strings" in the clip JSON, lest an id happen to be part of another string
  const needles = [...new Set(local.flatMap(m => [m.id, m.url, m.path]).filter(v => typeof v === 'string' && v !== ''))]
    .map(v => JSON.stringify(v));
  const clips = new Map();
  for (const track of Array.isArray(project?.tracks) ? project.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) if (clip?.id != null) clips.set(clip.id, clip);
  }
  return (control) => {
    if (control?.kind === 'stream') return true;
    const tier = control?.tier || snapshotTier(control?.capabilities);
    if (tier !== 'shared') return true;
    const clip = clips.get(control?.clipId);
    if (!clip) return true;
    const text = JSON.stringify(clip);
    return needles.some(needle => text.includes(needle));
  };
}

/**
 * Adds the local tier capability gate to `executor.plan`'s PlanContext (`local-node.mjs` passes it as is to `splitPlan`).
 * `owner` is the node id of the machine where the assets reside: the plan's publisher (`source.publisher.id`; a PC node's publisher id is its nodeId).
 * Returns as is if there are no local-only assets in the project, or if there is no owner.
 */
export function withLocalMedia(ctx, { project, owner, projectId }) {
  if (projectId && ctx?.projectId && ctx.projectId !== projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
  if (projectId) ctx = { ...ctx, projectId }; // The task output recipient verifies against this trusted context, not the self-reported id in the document
  const gate = localMediaGate(project);
  if (!gate || typeof owner !== 'string' || owner === '' || !ctx || typeof ctx !== 'object') return ctx;
  return { ...ctx, localMedia: owner, usesLocalMedia: gate };
}
