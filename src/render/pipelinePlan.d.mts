import type { CardNode } from '../kernel/cardGraph.mjs';
import type { CardCostRecord } from './cardCostKey.mjs';
import type { PipelineTuning, PipelineTuningOverrides } from './pipelineTuning.mjs';

/** Real-time evaluation result at a position (between two adjacent segment boundaries) */
export interface PipelineSegment {
  fromSec: number;
  toSec: number;
  /** Cards pasting dead assets at this position */
  heavy: Set<string>;
  /** Cards rendered live at this position */
  light: Set<string>;
}

export interface PipelinePlan {
  segments: PipelineSegment[];
  /**
   * Union of cards classified as heavy at any position (pinned render 9): static set entering the
   * prerender pipeline, prerendered for the entire segment.
   */
  prerenderSet: Set<string>;
}

/** Clip → cost record index. Accepts both Map and plain objects. */
export type ClipIndex<V> = Readonly<Record<string, V>> | ReadonlyMap<string, V>;

export interface PlanPipelinesOptions {
  /**
   * Fixed cost (ms) for a heavy card to paste one frame of dead asset per tick. Defaults to `DEAD_MS`;
   * replaced with measured frame swap cost only in L4: a number is identical for every card, while a
   * function is queried per clip (falls back to `DEAD_MS` if non-negative number is not provided).
   */
  deadMs?: number | ((clipId: string) => number);
  /** Override values for tunable parameters, or a copy already processed by `resolveTuning`. Both ends must match. */
  tuning?: PipelineTuning | PipelineTuningOverrides;
  /** Result of clipId → `cardCostKey` (see `clipCostIndex`). Missing clips fall back to "no record". */
  identityKeys?: ClipIndex<string>;
  /** clipId → declared frame mode. Used only when this card has no cost record: `direct` is treated as light, others as heavy. */
  frameModes?: ClipIndex<string>;
  /**
   * Every card is classified as heavy at every position and enters the prerender set for the entire
   * segment, ignoring cost records and declarations. Used for **display** in the lowest tier (never
   * rendered live during playback; semantics in `product/platforms.md` "online browser" > "lowest
   * tier"); light/heavy classification depends on `searchLight`.
   */
  allHeavy?: boolean;
  /**
   * Determination for bounds search (when an online page has only one stage,
   * `src/render/boundarySearch.mjs`): `identityKey` of cards classified as light. When provided, cost
   * records and declarations are ignored: cards in the set are classified as light at every position
   * (not squeezed out by budget), while the rest are classified as heavy at every position. Ignored
   * when `allHeavy` is true.
   */
  searchLight?: Iterable<string> | null;
  /**
   * When 3D mode is enabled, standalone cards originally classified as light are also included in the
   * single-card track stream production plan `prerenderSet`. `scene-3d` itself is a true 3D mesh in 3D
   * view and is excluded as before, so that all card boards have track streams to paste during 3D view
   * playback.
   */
  includeLightCardsFor3D?: boolean;
  /** Shorthand for `includeLightCardsFor3D` */
  view3d?: boolean;
  /** Declared kind of the active cut (`"2d"` or `"3d"`). When `"3d"`, standalone light cards are also included in `prerenderSet`. */
  cutKind?: '2d' | '3d';
  /** Capability table / function to determine whether a card is a standalone card; when omitted, all except `scene-3d` are included */
  isIndependent?: ((clip: any) => boolean) | null;
  compositing?: ClipIndex<string> | ((clip: any) => string | undefined) | null;
  capabilities?: ClipIndex<{ compositing?: string }> | ((clip: any) => { compositing?: string } | undefined) | null;
}

export const DEAD_MS: number;
export const CATCHUP_STEPS_PER_BEAT: number;
export function maxCatchUpBeats(fps: number): number;
/** Budget for pinned render 3: `1000 / fps × 70%` */
export function budgetOf(fps: number): number;

/** Tier of a card. The three `pinned` tiers (`capped` / `over-catchup` / `declared-heavy`) are classified as heavy at every position. */
export type PipelineTier =
  | 'declared-light' | 'declared-heavy'
  | 'capped' | 'over-catchup'
  | 'direct' | 'seek' | 'catchup-a' | 'catchup-b'
  | 'search-light';

export interface ClipWeight {
  /** Classified as heavy at every position, does not participate in greedy selection */
  pinned: boolean;
  /** Weight per tick (Infinity when `pinned`) */
  w: number;
  tier: PipelineTier;
}

/** Weight per tick and tier of a card. Exported only for diagnostics and unit tests; `planPipelines` uses the same copy internally. */
export function clipWeight(
  record: CardCostRecord | null | undefined,
  frameMode: string | undefined,
  fps: number,
  tuning?: PipelineTuning | PipelineTuningOverrides,
): ClipWeight;

export function planPipelines(
  project: any,
  costs: readonly CardCostRecord[] | null | undefined,
  fps: number,
  opts?: PlanPipelinesOptions,
): PipelinePlan;

export function pipelineAt(plan: PipelinePlan | null | undefined, clipId: string, tSec: number): 'light' | 'heavy';

export function clipCostIndex(
  project: any,
  graph: { nodes?: CardNode[] } | null | undefined,
  sourceVersionOf?: (node: CardNode) => string | null,
  opts?: ClipCostNodeOptions,
): { identityKeys: Record<string, string>; frameModes: Record<string, string> };

export interface ClipCostNodeOptions {
  /** Whether clip's own media effect card node (without `clipId`) counts as its cost identity node; omitted = no. See `clipCostNodes` */
  ownNode?: (node: CardNode, clip: any) => boolean;
}

/** Clip → node used for cost identity */
export function clipCostNodes(
  project: any,
  graph: { nodes?: CardNode[] } | null | undefined,
  opts?: ClipCostNodeOptions,
): Map<string, CardNode>;
