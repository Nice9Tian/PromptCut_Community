/**
 * Pure functions required for a fine-grained task to generate snapshots on a pure browser node
 * (M7 contract sections 4.3 and 4.5):
 *
 *   - `bakeInputOf`: Task → parameters required for the isolated single-card project
 *     (`isolatedCardProject`). The required `start`, `end`, `count`, and `sampling` are written by the
 *     splitter into `input.bake` on the browser side; the page does not compute `cardSampling`; clip
 *     id is taken from `input.clipId`.
 *   - `snapshotManifest`: Manifest assembled after the full segment is complete, shaped
 *     identically to `collectSnapshotResult` in desktop `server/artifact-transfer.mjs` (`v: 1`,
 *     `kind: 'snapshot'`, `tier: 'shared'`, `resultKey`, `dirKey = resultKey`, `entryKey: null`,
 *     `range`, `canvasHeavy`, `frames: [[local frame, hash, byte count]]`, includes `small` if small
 *     size exists); unit-tested against desktop `manifestMatches`.
 *   - `manifestKey`: Manifest key in the content store `<resultKey>:<from>-<to>` (same as
 *     `manifestKeyOf`).
 *
 * `isolatedCardProject` has been moved to the pure module `src/kernel/isolatedCard.mjs` shared
 * between page and server; desktop `FramePipeline#isolatedCardProject` was updated to reference it
 * (contract section 4.3). Cards flattened out of cut segments (virtual clips, [ruling] R02: online
 * browser also produces streams for heavy cards in cut segments) take the other branch of
 * `isolatedBakeProject`: the isolated project carries the cut segment chain (`isolatedFlatProject`
 * in `kernel/cutFlatten.mjs`, same instance used when the splitter produces `'flat'` streams),
 * without time shifting; the background stage calculates the project frame based on "task local
 * frame + card first frame", advances to the project frame, and retrieves this card's wrapper layer
 * in the nested scene (`bakeFrame` in `StageView.tsx`, request includes `frameBase`).
 *
 * This module belongs to the render layer (`src/online/`): does not import editor, does not import
 * `mode.ts`.
 */

import { isolatedCardProject } from "../kernel/isolatedCard.mjs";
import { isFlatClipId, isolatedFlatProject } from "../kernel/cutFlatten.mjs";

/** Manifest version (same as `RESULT_VERSION` in `artifact-transfer.mjs`) */
export const RESULT_VERSION = 1;
/** Size upper limit for manifest JSON (same as `RESULT_MAX_BYTES`) */
export const RESULT_MAX_BYTES = 256 * 1024;

export interface BakeInput {
  clipId: string;
  start: number;
  end: number;
  count: number;
  sampling: { phase: { numerator: number | string; denominator: number | string }; [k: string]: unknown };
}

/** Task → parameters needed for isolated single-card project; returns null if missing (no guessing) */
export function bakeInputOf(task: { input?: Record<string, unknown> } | null | undefined): BakeInput | null {
  const input = task?.input ?? {};
  const bake = input.bake as Record<string, unknown> | undefined;
  const clipId = input.clipId;
  if (typeof clipId !== "string" || !clipId || !bake || typeof bake !== "object") return null;
  const start = Number(bake.start), end = Number(bake.end), count = Number(bake.count);
  const sampling = bake.sampling as BakeInput["sampling"] | undefined;
  const phase = sampling?.phase;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isInteger(count) || count < 1) return null;
  if (!phase || !Number.isFinite(Number(phase.numerator)) || !(Number(phase.denominator) > 0)) return null;
  return { clipId, start, end, count, sampling };
}

/** Isolated single-card project: single instance shared between desktop prerender and this page (`src/kernel/isolatedCard.mjs`) */
export { isolatedCardProject };

/** Cards in cut segments strip their appearance in the isolated project (added by their outer wrapper layer on the stage, not in the stream; same items stripped by the splitter's `localClip`); box kept as is (snapshots capture inside the wrapper layer) */
function bareCardClip(clip: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(clip);
  delete out.motion; delete out.opacity; delete out.fadeIn; delete out.fadeOut; delete out.emphasis;
  return out;
}

/**
 * Isolated project for this segment of the task: top-level cards use isolated single-card projects
 * (target shifted to start from `-phase`, local frame n is global frame n); cards flattened out of
 * cut segments (clip id contains `~`) carry the cut segment chain without time shifting
 * (`isolatedFlatProject`), where local frame n is project frame `input.sampling.firstFrame + n`.
 * Throws error if clip is not found (non-retryable).
 */
export function isolatedBakeProject<P extends object>(project: P, input: BakeInput): P {
  if (!isFlatClipId(input.clipId)) return isolatedCardProject(project, input);
  const isolated = isolatedFlatProject(project, input.clipId, bareCardClip);
  if (!isolated) throw Object.assign(new Error(`No clip ${input.clipId} in the cut segment`), { retryable: false });
  return isolated as P;
}

/** Cards in cut segments: project frame for task local frame 0 (`input.sampling.firstFrame`); top-level cards return null (local frame is global frame of isolated project) */
export function bakeFrameBase(input: BakeInput): number | null {
  if (!isFlatClipId(input.clipId)) return null;
  const first = Number((input.sampling as { firstFrame?: unknown }).firstFrame);
  return Number.isSafeInteger(first) && first >= 0 ? first : null;
}

/** Manifest key in content store: `<resultKey>:<from>-<to>`; returns null if missing */
export function manifestKey(ref: { resultKey?: unknown; range?: { from?: unknown; to?: unknown } | null } | null | undefined): string | null {
  const key = ref?.resultKey;
  const from = ref?.range?.from, to = ref?.range?.to;
  if (typeof key !== "string" || !key || !Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 0 || (to as number) < (from as number)) return null;
  return `${key}:${from}-${to}`;
}

export interface ManifestFrame { localFrame: number; hash: string; bytes: number; small?: { hash: string; bytes: number } | null }

export interface SnapshotManifest {
  v: 1;
  kind: "snapshot";
  tier: "shared";
  resultKey: string;
  dirKey: string;
  entryKey: null;
  range: { from: number; to: number };
  canvasHeavy: boolean;
  frames: [number, string, number][];
  small?: [number, string, number][];
}

/** UTF-8 byte count of manifest JSON */
export function manifestBytes(m: unknown): number {
  return new TextEncoder().encode(JSON.stringify(m)).length;
}

/**
 * Manifest assembled after the full segment is complete (shaped identically to
 * `collectSnapshotResult`). If exceeding 256 KiB, throws `code: 'result-too-large'` (non-retryable,
 * same as `assertResultSize`). Oversized frames (DOM 300 KB, canvas bitmap 1 MB) are listed in the
 * manifest as on desktop, judged by the puller.
 */
export function snapshotManifest(task: { resultKey: string; range: { from: number; to: number } | null; input?: Record<string, unknown> }, frames: readonly ManifestFrame[]): SnapshotManifest {
  if (!task.range) throw Object.assign(new Error("Task has no range"), { retryable: false });
  const { from, to } = task.range;
  const inRange = [...frames].filter((f) => f.localFrame >= from && f.localFrame <= to).sort((a, b) => a.localFrame - b.localFrame);
  const small = inRange.filter((f) => f.small && typeof f.small.hash === "string" && f.small.bytes > 0)
    .map((f) => [f.localFrame, f.small!.hash, f.small!.bytes] as [number, string, number]);
  const out: SnapshotManifest = {
    v: RESULT_VERSION, kind: "snapshot", tier: "shared",
    resultKey: task.resultKey, dirKey: task.resultKey, entryKey: null,
    range: { from, to },
    canvasHeavy: task.input?.canvasHeavy === true,
    frames: inRange.map((f) => [f.localFrame, f.hash, f.bytes]),
    ...(small.length ? { small } : {}),
  };
  const bytes = manifestBytes(out);
  if (bytes > RESULT_MAX_BYTES) throw Object.assign(new Error(`Task manifest is ${bytes} bytes, over the limit of ${RESULT_MAX_BYTES}`), { code: "result-too-large", bytes, retryable: false });
  return out;
}

/** Whether the manifest fetched from the content store can be used directly as the result for this segment (deduplication, section 4.1): correct shape, covers the entire segment, and every frame has small size */
export function manifestCovers(body: unknown, task: { resultKey: string; range: { from: number; to: number } | null }): body is SnapshotManifest {
  const b = body as SnapshotManifest | null;
  if (!b || typeof b !== "object" || b.v !== RESULT_VERSION || b.kind !== "snapshot" || b.resultKey !== task.resultKey || !task.range) return false;
  if (b.range?.from !== task.range.from || b.range?.to !== task.range.to || !Array.isArray(b.frames)) return false;
  const HEX = /^[a-f0-9]{64}$/;
  const have = new Set<number>();
  for (const item of b.frames) {
    if (!Array.isArray(item) || !Number.isInteger(item[0]) || !HEX.test(String(item[1]))) return false;
    have.add(item[0]);
  }
  const smallHave = new Set<number>();
  for (const item of Array.isArray(b.small) ? b.small : []) {
    if (!Array.isArray(item) || !Number.isInteger(item[0]) || !HEX.test(String(item[1]))) return false;
    smallHave.add(item[0]);
  }
  // Both tiers must be present for this segment to be considered complete (c10a section 9)
  for (let f = task.range.from; f <= task.range.to; f++) if (!have.has(f) || !smallHave.has(f)) return false;
  return true;
}

/** Chunks from manifest required on asset service: `[{ ns, hash }]` (original size `snap`, small size `px`) */
export function manifestBlocks(m: SnapshotManifest): { ns: "snap" | "px"; hash: string }[] {
  const out = new Map<string, { ns: "snap" | "px"; hash: string }>();
  for (const [, hash] of m.frames) out.set(`snap/${hash}`, { ns: "snap", hash });
  for (const [, hash] of m.small ?? []) out.set(`px/${hash}`, { ns: "px", hash });
  return [...out.values()];
}
