/**
 * Which tier each control's snapshot uses: `none` does not store, `shared` shared tier
 * (pushable and pullable), `local` local tier.
 */
export type SnapshotTier = 'none' | 'shared' | 'local';

/**
 * Capability object read by `snapshotTier`: review table capabilities (`cardCapabilities` in
 * `src/kernel/frameMode.mjs`) or the copy written by `cardGraph` for the composite node.
 */
export type SnapshotTierCapabilities = {
  frameMode?: string;
  need_prerendering?: boolean;
  needPrerendering?: boolean;
  compositing?: string;
  canvasHeavy?: boolean;
  independentCache?: boolean;
} | null | undefined;

/**
 * The sole implementation determining "whether this card stores snapshots and which tier to store
 * in"; the page side (under `src/`) directly imports it without writing a separate copy.
 */
export function snapshotTier(capabilities?: SnapshotTierCapabilities): SnapshotTier;
