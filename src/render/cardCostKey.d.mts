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
   * 单次最大的活渲帧（ms）。**只作诊断，不进判重和分派**（任务书 3.3 / K1）：限 2 核下同一张卡
   * 两次实测的单次最大能差十几倍（`particles-orbit` 33 ms 对 2.2 ms），越线的是偶发的一帧卡顿、
   * 不是卡的稳定成本，所以 `stepMs` 改取百分位、单次最大另记在这里。
   * 只有计时趟留得下逐帧样本，所以只有 `kind: 'stepped'` 和补抽够样本的 `direct` 卡有这一项。
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
   * 计时趟真实采到的帧数（`summarizeProbe` 的 `samples`）。只给共享成本记录用（文档服务的 `samples`，
   * `mechanism/document-service.md`「成本记录」），不进判重和分派；旧记录没有这一项，转写时按 `device` 串里的 `stepN` 记。
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
