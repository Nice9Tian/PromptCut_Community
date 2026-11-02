export function stableJson(value: unknown): string;
export function cardCostKey(node: Record<string, unknown>, sourceVersion: string | undefined | null, fps: number, durationFrames: number): string;
/**
 * One K1 probe record as stored in out/card-costs.json (GET/PUT /api/data/costs).
 *
 * R1 (plan 3.8) split the old single `frameMs` into four numbers.  `stepMs` is the live-render
 * cost and the ONLY input to the heavy/light threshold (`capped = stepMs > B`); the three
 * snapshot numbers never enter it — taking a snapshot happens in the probe and the prerenderer,
 * never on a live playback beat — and are used only to schedule probe / prerender throughput.
 * `frameMs` is gone with no compatibility shim: re-run the probe and out/card-costs.json has
 * the new shape.
 */
export interface CardCostRecord {
  identityKey: string;
  fps: number;
  /**
   * Worst single live-render frame in ms, WITHOUT taking a snapshot.  The only capping input.
   * Random-access cards report it too (one `setTime(t, { probe: true })` per sampled frame,
   * measured before the real-rAF wait) — with `frameMs` gone there is nothing else to cap on.
   */
  stepMs: number;
  /**
   * Maximum single live render frame (ms). **For diagnosis only, excluded from heavy classification
   * and dispatch** (task brief 3.3 / K1): under a 2-core limit, two actual measurements of the same
   * card can differ in maximum single frame by over tenfold (`particles-orbit` 33 ms vs 2.2 ms); what
   * crosses the line is an occasional single-frame stutter, not the card's steady cost, so `stepMs`
   * was changed to use a percentile, and the single maximum is recorded separately here.
   * Only timing passes retain frame-by-frame samples, so only `kind: 'stepped'` and `direct` cards
   * with sufficient resampled samples have this field.
   */
  stepMaxMs?: number;
  /** Worst single frame spent inlining styles (DOM clone + computed-style pass). */
  inlineMs: number;
  /** Worst single frame spent rasterising canvases (0 for cards without a canvas). */
  rasterMs: number;
  /** Worst single frame spent serialising the scene. */
  serializeMs: number;
  /** total catch-up from the mount frame to the last clip frame (0 for random-access cards) */
  catchUpMs: number;
  capped?: boolean;
  /**
   * Actual number of frames sampled during timing pass (`samples` in `summarizeProbe`). Used only for
   * shared cost records (`samples` in document service, "Cost record" in
   * `mechanism/document-service.md`), excluded from heavy classification and dispatch; legacy records
   * lack this field and record it from `stepN` in the `device` string when transcribed.
   */
  samples?: number;
  kind: 'random' | 'stepped';
  vtOk?: boolean;
  seekOk?: boolean;
  seekMs?: number | null;
  /**
   * Which server the timings were taken against (plan 3.1).  The desktop app runs the Vite dev
   * server, so `'dev'` is the real runtime environment and dispatch reads the record matching the
   * current mode; `'build'` records are for the future online-browser mode.  `mode` is ALSO spliced
   * into `device`, so the two runs never overwrite each other.  Records written before R1 have no
   * field at all; `filterCosts` reads a missing value as `'dev'`.
   */
  mode?: 'dev' | 'build';
  /**
   * Written explicitly (even as `false`) by the probe: `costs-store.mjs`'s STICKY_FLAGS keeps
   * the old value only when the field is absent, and the store is on disk — without an explicit
   * `false`, one K6 demotion would be pasted back onto every later re-probe and pin the card heavy.
   */
  demoted: boolean;
  /** Reserved for a future manual pin (plan 3.3: R1 never writes it). */
  pinnedHeavy?: boolean;
  measuredAt: number;
  device: string;
}
