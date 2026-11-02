/**
 * Numeric resolution of clip frame width and height: the **only copy** shared between stage and server.
 *
 * Why a standalone .mjs:
 *   - On the stage side, `resolveFrame` / `frameBox` in `layout.ts` positions cards using this width
 *     and height;
 *   - On the server side, `cardSnapshotIdentity` in `server/card-identity.mjs` writes the same width
 *     and height into the shared snapshot key: snapshots inline the **used value** (px), so if two
 *     clips have different frame dimensions, they are two different snapshots and keys must differ
 *     (A3 acceptance check);
 *   - Node cannot directly import `.ts`, so numeric resolution is pushed down here and imported by
 *     both sides. If `frame?.w ?? parent.width` were written in both places, changing default values
 *     in the future would inevitably miss one; missing it throws no error, but the key and actually
 *     rendered frame would silently mismatch.
 *
 * No frame = fills parent coordinate system (stage aspect ratio), synonymous with `resolveFrame` default.
 */
export function resolveFrameSize(frame, parent) {
  return { w: frame?.w ?? parent?.width, h: frame?.h ?? parent?.height };
}
