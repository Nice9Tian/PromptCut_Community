import { cyrb53 } from './cyrb53.mjs';

/** Same recursive key-sorted serialisation as server/frame-identity.mjs `stableJson`
 * (duplicated here because that file imports node:crypto and cannot be loaded in the browser). */
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

/**
 * K1 probe identity: which `costs` record a (card, params, source version, fps, length) maps to.
 *
 * - `clipId` is stripped: the same card in two clips is measured once.
 * - `sourceVersion` is included: editing the card's source must retire the old timing record
 *   (pinned render 5: the record is reused only while the identity is unchanged). It is passed
 *   separately because cardGraph.mjs's synthesized node does not carry it (card-identity.mjs
 *   feeds it to `digest` as a sibling of `node`).
 * - `node.capabilities` (the review table) stays inside the node, so a review-table edit re-probes.
 * - Synchronous, browser-safe (cyrb53), NOT the SHA-256 `digest` used by the snapshot keys (A3a).
 */
export function cardCostKey(node, sourceVersion, fps, durationFrames) {
  // `flat` (how much head is cropped by visible window of a flattened card in cut segment, and which
  // segment layers it passes through; `kernel/cutFlatten.mjs`) only changes pixels in stream,
  // not frame cost: the same card is measured only once across instances
  const { clipId: _clipId, id: _id, inputs: _inputs, flat: _flat, ...rest } = node ?? {};
  return cyrb53(stableJson({ node: rest, sourceVersion: sourceVersion ?? null, fps, durationFrames }));
}
