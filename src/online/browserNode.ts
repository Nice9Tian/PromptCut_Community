/**
 * Pure-browser render node for online pages (M7 contract `docs/plan/m7-contract.md`
 * Sections 2, 4, 5, 7; Section 13 rulings D6, D8, D10, D14, D16).
 *
 * This module contains only arrangement and criteria, touching no stage, network, storage, or UI:
 * these are injected via `deps` by the host (`src/editor/browserNodeHost.ts`).
 * Node sessions (claim, renew, release, drop claim) use the same render node state machine
 * `server/render-node/session.mjs`; execution rules for fine-grained tasks (report 0 first,
 * deduplicate, complete only after pushing, drop results on lost claims) use the same desktop
 * `server/render-node/task-runner.mjs` (D11 (a)); this page manages frames and yielding only
 * inside its `render`.
 *
 * # Node eligibility conditions (`browserNodeEligibility`, Section 2)
 *
 * Online build, embedded code version (D16: development builds are ineligible), identity is
 * computer (mobile is ineligible), not the lowest tier, handshakes completed with both cross-origin
 * stages, Chromium engine (D14), connected to a cloud project as a member, and measurement for
 * opening the project has settled: eligible only when all hold. Pure function, reads no
 * compile-time constants (Node unit tests load it directly).
 *
 * # Check-in (D10, page side)
 *
 * `node.hello { profile: 'browser', maxConcurrent: 1, environment }`: reports only raw values
 * (`pageEnvironment()`), not fingerprints; the document service calculates the fingerprint from
 * raw values and returns it in `node.welcome.envFingerprint`. The node records it (node-side
 * filtering compares task fingerprints against it) and passes it to the host (required by
 * `input.browser` in the manifest plan, Section 3.3). `queue.watch` lists only this project
 * (the queue forbids pure browsers from watching `'all'`).
 *
 * # User cards and media effect cards (Chunk N, `docs/plan/online-card-exec-contract.md` Section 7)
 *
 * When this page can execute synced user cards and media effect cards (`deps.cardInfo()` returns
 * registry contents, `nodeCardInfo.ts`):
 *   - `node.hello` reports an extra `cardRuntime` (online card runtime version, raw value;
 *     fingerprint is still computed by the document service);
 *   - The document service returns an extra `cardEnvFingerprint` in `node.welcome` (the three
 *     environment items plus runtime version). The node records it: tasks for user cards and media
 *     effect cards compare fingerprints against it (`filter.mjs` Rule 1), while tasks for built-in
 *     cards compare against `envFingerprint` as before;
 *   - Capability flags `capabilities.userCards` / `graphCards` and `cardSourceVersions` (code
 *     identity of each card successfully loaded by this page) update in real time with the
 *     registry, and node-side filtering (Rules 1, 3) claims tasks accordingly; they are not
 *     reported for a brief period after a generation switch (`NODE_CARD_SETTLE_MS` in the registry).
 * If the runtime version becomes reportable only after check-in (the gate is raised later than
 * check-in), re-send `node.hello` once (resuming with held claims). When execution is not supported,
 * behavior is identical to before.
 *
 * # A fine-grained task (Section 4)
 *
 *   Claimed → `progress(0)` (stall rule must cover hung executors) → deduplicate (if
 *   `lookupResult` is provided: complete immediately if the content store manifest and all chunks
 *   are present)
 *   → Fetch project: the `projectRev` revision of the task, using the one kept from publication
 *     (`keptProject`) first, then falling back to `fetchSnapshot`; if neither is available, release
 *     (`reason: 'no-snapshot'`), never rendering with a different revision (D6)
 *   → Frame-by-frame `bakeFrame` (background stage generating snapshots, pushing to asset service,
 *     and storing into in-page snapshot store are all on the host side), with
 *     `progress(completedFrames)` for each frame
 *   → Once the full segment is complete, `finishTask` (assemble manifest, write to content store)
 *     → `task.complete { ranges, ...manifest }`.
 *
 * Completed frames remain on this page keyed by task id: after yielding and releasing, re-claiming
 * the same segment fills only missing frames (Section 2 "Yielding").
 *
 * # A stream task (`docs/plan/browser-stream-task.md` Part 4)
 *
 * Only when the host reports stream encoding support (`deps.streams()`, probed via
 * `probeStreamEncoder`) is the capability flag `capabilities.streams` reported as true; the
 * single-card stream slice dispatched by the splitter to the browser (`kind: 'stream'`,
 * `input.stream`, `input.bake`) follows the same rules as snapshot tasks: report 0 first,
 * deduplicate, fetch the project revision for the task, then hand the entire segment over to the
 * host's `bakeStream` (create an isolated single-card project per `input.bake`, request pixels from
 * the stage frame-by-frame, feed the encoder, push segments to the asset service). Once all
 * segments are ready, `finishStream` writes the stream manifest to the content store, followed by
 * `task.complete { ranges, ...manifest }`.
 * How frame numbers are converted (`streamTaskFrames`) and what the manifest looks like
 * (`streamManifest`, field-for-field isomorphic with desktop `collectStreamResult`) are pure
 * functions here.
 * Yielding: the host checks `yielding()` before each frame; once the current frame finishes, it
 * stops and returns `{ yielded: true }`, and the node releases (already pushed segments remain on
 * the host side; re-claiming the same segment fills only missing segments); page hiding or lost
 * claims abort as usual (`signal`).
 *
 * # Yielding (D8, `yieldFor`)
 *
 * - `play` / `drag` / `urgent` (playback or scrub begins, more urgent background work arrives):
 *   stop claiming; once the current frame completes, call `task.release` (not counted as failure,
 *   C2) and do not generate the next frame. If no frame is currently being processed (still
 *   fetching project or checking deduplication), release immediately.
 * - `hidden` (page hidden, parent page rAF gap): do not wait for the current frame; abort it
 *   (`signal`) and release immediately; late results are discarded.
 * Whether to resume claiming after yielding is determined by the host's `isIdle()` (not playing,
 * not scrubbing, quiet period elapsed since the last interaction...).
 *
 * # Reporting busy (M7 D2 supplementary [ruling], `claude/queue-maint`)
 *
 * A queue lock idle for more than 30 s will be taken over by the splitter (D2). When a page locks a
 * card but is busy doing something else (generating snapshots for other cards, or the background
 * stage is measuring or doing catch-up runs), that card has no output, but the page is still active.
 * When `node.welcome` includes `activeIntervalMs` (new queue), the node sends `node.active { busy }`
 * at this interval during such times (`busy`: `'bake'` if holding a claim, otherwise query the
 * host's `busy()`, such as `'stage'`); based on this, the queue does not mark the locked card as
 * idle.
 * Do not send when idle, page hidden, or simply playing or scrubbing with no background work: during
 * these times, locks are considered idle based on output as usual. Old queues do not include
 * `activeIntervalMs` and nothing is sent.
 *
 * # Lost claims
 *
 * `task.lease-lost`, `node.welcome.lost`: abort this snapshot generation and discard results;
 * already pushed chunks are not reclaimed (content-addressed, reusable for deduplication by the
 * next claimer).
 *
 * # Diagnostics (Section 7)
 *
 * `debug()`: state (`off` / `idle` / `busy` / `baking`) and reason, `nodeId`, `envFingerprint`,
 * `codeVersion`, held tasks;
 * counts (claimed, completed, deduplicated, released by reason, failed, lost claims, snapshot
 * frames generated with per-frame duration p50 / p95, tasks blocked by node-side filtering by
 * reason); latest error.
 *
 * This module belongs to the render layer (`src/online/`): does not import editor, does not import
 * `mode.ts`.
 */
import { isStreamOrigin, STREAM_SEGMENT_FRAMES as SEGMENT_FRAMES_SHARED, streamSegmentFirstFrame, streamSegmentLastFrame } from "../render/streamSegments.mjs";
import { streamBucketManifest, streamBucketRanges, streamLastSegmentOf } from "../render/streamBuckets.mjs";
// @ts-expect-error Untyped .mjs (universal to browser and Node, pure logic)
import { createNodeSession as createNodeSessionUntyped } from "../../server/render-node/session.mjs";
// @ts-expect-error Untyped .mjs (pure functions)
import { checkClaimable as checkClaimableUntyped } from "../../server/render-node/filter.mjs";
// @ts-expect-error Untyped .mjs (isomorphic: execution rules for fine-grained tasks, shared between desktop and page, D11)
import { createTaskRunner as createTaskRunnerUntyped, ABORTED as ABORTED_UNTYPED } from "../../server/render-node/task-runner.mjs";
import { tr } from "../i18n/index.ts";

/* ------------------------------------------------------------------ Node eligibility conditions */

/**
 * Whether the UA is Chromium-based (D14). Recognizes `Chrome/<number>`, `Chromium/<number>`,
 * and `HeadlessChrome/<number>` (included by Chromium-based browsers such as Edge and Opera);
 * Chrome / Firefox / Edge on iOS (`CriOS`, `FxiOS`, `EdgiOS`) are WebKit, and Firefox has
 * `Firefox/`, neither of which counts.
 * Matches the check logic on the document service side (that side blocks dishonest pages,
 * while this side prevents honest pages from opening connections altogether).
 */
export function isChromiumUserAgent(userAgent: unknown): boolean {
  const ua = String(userAgent ?? "");
  if (/\b(?:CriOS|FxiOS|EdgiOS)\//.test(ua) || /\bFirefox\//.test(ua)) return false;
  return /\b(?:HeadlessChrome|Chrome|Chromium)\/\d+/.test(ua);
}

export interface EligibilityInput {
  /** Online build (`ONLINE` in `src/online/mode.ts`, passed by caller) */
  online: boolean;
  /** Embedded code version in online builds (`CODE_VERSION` in `buildInfo.ts`); empty in development builds */
  codeVersion: string | null | undefined;
  /** Identity is mobile (`onlineTier.ts`; semantics in `product/platforms.md` "Identity": mobile does not act as a render node) */
  phone: boolean;
  /** Lowest tier (cannot run even a baseline card or sustain a single stage): does not act as a node or produce streams for this page */
  lowest: boolean;
  /** `'dual'` when handshakes complete with both cross-origin stages; `'single'` when there is only one stage (stage gate level 1, fell back after handshake failure) */
  /** `pending`: opened with two stages, but handshakes not yet completed with both (stage gate is probing the background stage); does not act as a node, nor counted as a single stage */
  stageLayout: "dual" | "single" | "pending";
  userAgent: string;
  /** Connected as a member to a shared project moved to the cloud (page connection is online) */
  member: boolean;
  /** Measurement for opening the project has settled (loading overlay dismissed) */
  measured: boolean;
}

export type EligibilityReason = "not-online" | "dev-build" | "lowest" | "phone" | "single-stage" | "not-chromium" | "not-member" | "measuring";

/** Node eligibility conditions (Section 2): returns `{ ok: true }` if all hold, otherwise returns the reason for the first unmet condition */
export function browserNodeEligibility(input: EligibilityInput): { ok: boolean; reason: EligibilityReason | null } {
  const no = (reason: EligibilityReason) => ({ ok: false, reason });
  if (input.online !== true) return no("not-online");
  if (typeof input.codeVersion !== "string" || !input.codeVersion) return no("dev-build");
  if (input.lowest) return no("lowest");
  if (input.phone) return no("phone");
  if (input.stageLayout !== "dual") return no("single-stage");
  if (!isChromiumUserAgent(input.userAgent)) return no("not-chromium");
  if (input.member !== true) return no("not-member");
  if (input.measured !== true) return no("measuring");
  return { ok: true, reason: null };
}

/* ------------------------------------------------------------------ Pure functions for stream tasks */

/** Frame count per segment in a track stream: count and conversion are in `render/streamSegments.mjs` (shared by stream production and reading); re-exported here under legacy name */
export const STREAM_SEGMENT_FRAMES = SEGMENT_FRAMES_SHARED;
/** Encoder name written in the manifest for browser-encoded streams (desktop uses ffmpeg encoder names such as `libx264`): indicates it was encoded by the browser using its built-in encoder */
export const BROWSER_STREAM_ENCODER = "webcodecs-avc";
/** Manifest version and size limit (same as `RESULT_VERSION` and `RESULT_MAX_BYTES` in `server/artifact-transfer.mjs`) */
const STREAM_RESULT_VERSION = 1;
const STREAM_RESULT_MAX_BYTES = 256 * 1024;

export interface StreamRectLike { x: number; y: number; w: number; h: number }
/** `input.stream` written by the splitter in the browser's stream task slice (`server/render-node/split.mjs`): the page does not compute these itself */
export interface StreamTaskInput {
  kind: "card";
  plane: "local";
  clipIds: string[];
  fps: number;
  /** Stream rectangle: wrapper layer's own coordinates (origin at top-left corner of the box) */
  bound: StreamRectLike;
  /** Where the box is placed in the desktop isolated project; unused on the browser path, written into the manifest as-is */
  offset: { x: number; y: number };
  /** Global frame number corresponding to local frame 0 of the card */
  firstFrame: number;
  /** Frame count of the card: fully transparent outside local frames 0 .. count-1 */
  count: number;
  /** Total frame count of the project (originally used to truncate the final segment; now segments truncate at `lastFrame`, so this item is kept as before) */
  total: number;
  /** First frame of this stream itself (project frame number): segments are 15 frames each starting from it. For a single-card stream, this is `firstFrame` */
  originFrame: number;
  /** Last frame of this stream itself (project frame number): the final segment ends at it and may have fewer than 15 frames */
  lastFrame: number;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const HEX64 = /^[a-f0-9]{64}$/;

/** Task → `input.stream`; returns null if shape is invalid (no guessing) */
export function streamInputOf(task: { input?: Record<string, unknown> } | null | undefined): StreamTaskInput | null {
  const s = task?.input?.stream as Partial<StreamTaskInput> | undefined;
  if (!s || typeof s !== "object" || s.kind !== "card" || s.plane !== "local") return null;
  const ids = s.clipIds;
  if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string" || !ids[0]) return null;
  const b = s.bound, o = s.offset;
  const fps = Number(s.fps);
  if (!(fps > 0) || !Number.isFinite(fps) || !isInt(s.firstFrame) || !isInt(s.count) || s.count < 1 || !isInt(s.total) || s.total < 1) return null;
  // Segments count from this stream's own first frame: skip tasks missing this frame (produced by splitters before segment rules changed), rather than guessing from project frame 0
  if (!isStreamOrigin(s.originFrame) || !isInt(s.lastFrame) || s.lastFrame < s.originFrame) return null;
  if (!b || !isInt(b.x) || !isInt(b.y) || !isInt(b.w) || !isInt(b.h) || b.w < 2 || b.h < 2 || b.w % 2 || b.h % 2) return null;
  if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
  return { kind: "card", plane: "local", clipIds: [ids[0]], fps, bound: { x: b.x, y: b.y, w: b.w, h: b.h }, offset: { x: o.x, y: o.y },
    firstFrame: s.firstFrame, count: s.count, total: s.total, originFrame: s.originFrame, lastFrame: s.lastFrame };
}

export interface StreamSegmentPlan {
  /** Segment index: the first frame of this segment is project frame `originFrame + index × 15` */
  index: number;
  /** Requested local frame number for each frame in this segment; `null` = frame outside card bounds, send fully transparent */
  frames: (number | null)[];
}

/**
 * Which frames a stream task segment needs to produce (Part 4 "Frame number conversion"): each
 * segment in the task range is 15 frames (counting from the stream's first frame `originFrame`,
 * ending at the stream's last frame `lastFrame`; conversion uses `render/streamSegments.mjs`, the
 * same copy as the splitter and player). Project frame number minus `firstFrame` gives the card's
 * local frame; frames outside 0 .. count-1 fall outside the card's range and receive full
 * transparency. Returns null if the task is not a browser-shaped stream task. `frames` is the
 * total frame count for this task segment.
 */
export function streamTaskFrames(task: { range?: { from: number; to: number } | null; input?: Record<string, unknown> } | null | undefined): { input: StreamTaskInput; segments: StreamSegmentPlan[]; frames: number } | null {
  const input = streamInputOf(task);
  const range = task?.range;
  if (!input || !range || !isInt(range.from) || !isInt(range.to) || range.from < 0 || range.to < range.from) return null;
  const segments: StreamSegmentPlan[] = [];
  let frames = 0;
  for (let n = range.from; n <= range.to; n++) {
    const first = streamSegmentFirstFrame(n, input.originFrame);
    const last = streamSegmentLastFrame(n, input.originFrame, input.lastFrame);
    const list: (number | null)[] = [];
    for (let g = first; g <= last; g++) {
      const local = g - input.firstFrame;
      list.push(local >= 0 && local < input.count ? local : null);
    }
    // Entire segment is after the stream's last frame: such segments should not appear in tasks (splitting ends at the stream's final segment); if encountered, it is a task mismatch, so skip it
    if (!list.length) return null;
    segments.push({ index: n, frames: list });
    frames += list.length;
  }
  return { input, segments, frames };
}

/** Registration of a head file (`ftyp + moov`) in the manifest; key is the first 16 characters of the hash */
export interface StreamInitMeta { hash: string; bytes: number; codec: string | null; width: number | null; height: number | null; timescale: number | null; rect: StreamRectLike | null; encoder: string | null }
/**
 * Registration of a segment (`moof + mdat`) in the manifest; key is the segment number. `stride`: 1
 * is full density, > 1 is sparse version (captures only the segment's first frame, repeated for
 * remaining frames). `box`: position rectangle for this segment: bounding box of opaque pixels in
 * the captured frame, in plane coordinates (same coordinate system as `inits[].rect` and
 * `header.bound`), null if fully transparent; measured when producing sparse versions, omitted if
 * unmeasured (same convention as `segments[n].box` in desktop `stream.json`).
 */
export interface StreamSegmentMeta { hash: string; bytes: number; init: string; stride: number; samples: number; sig: string | null; encoder: string | null; box?: StreamRectLike | null }

/** Stream task density: `input.density: 'sparse'` is a sparse stream task (id ends with `:sparse`, `taskIdOf` in `server/render-queue/messages.mjs`); omitted means full-density task */
export const STREAM_DENSITY_SPARSE = "sparse";
export const isSparseStreamTask = (task: { kind?: unknown; input?: Record<string, unknown> | null } | null | undefined): boolean =>
  task?.kind === "stream" && task.input?.density === STREAM_DENSITY_SPARSE;
/** Capture interval in frames for this stream task: frame count of a segment for sparse stream tasks (capturing only the first frame per segment), 1 for full-density tasks */
export const streamTaskStride = (task: { kind?: unknown; input?: Record<string, unknown> | null } | null | undefined): number =>
  (isSparseStreamTask(task) ? SEGMENT_FRAMES_SHARED : 1);

/**
 * Bounding box `{ x, y, w, h }` of opaque pixels (alpha > 0) in an RGBA frame (pixels, origin at
 * top-left corner); returns null if fully transparent. Measured once per segment in sparse versions
 * (position rectangle `box`), using the same method as `rgbaAlphaBox` in desktop
 * `server/bakery/capture-canvas.mjs`.
 */
export function alphaBoxOf(data: ArrayLike<number>, width: number, height: number): StreamRectLike | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let first = -1, last = -1;
    for (let x = 0; x < width; x++) if (data[row + x * 4 + 3] > 0) { first = x; break; }
    if (first < 0) continue;
    for (let x = width - 1; x >= first; x--) if (data[row + x * 4 + 3] > 0) { last = x; break; }
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export interface StreamManifestOut {
  v: 1;
  kind: "stream";
  resultKey: string;
  range: { from: number; to: number };
  /** `lastFrame`: last frame of this stream itself (project frame number); used to truncate the end of 8-segment buckets when writing to content store (`render/streamBuckets.mjs`). Omitted in older manifests */
  header: { kind: "card"; plane: "local"; clipIds: string[]; fps: number; originFrame: number; lastFrame?: number; bound: StreamRectLike; offset: { x: number; y: number }; tight: null };
  inits: Record<string, StreamInitMeta>;
  segments: Record<string, StreamSegmentMeta>;
}

/**
 * Manifest for a stream task segment: field-for-field identical in shape to `collectStreamResult` in
 * desktop `server/artifact-transfer.mjs` (cross-checked by unit tests, passing `manifestMatches` and
 * `streamAdoption`), so desktop can pull and consume streams produced by the browser. Lists only
 * segments within the task range and head files they use; segments record `stride` according to their
 * output density (segment frame count for sparse stream tasks, with `box`; 1 for full density),
 * rectangle is fixed to `bound` (`header.tight: null`), and segment signatures are omitted
 * (`sig: null`, desktop recognizes as `adopted` without recomputing via local encoder).
 * Throws `code: 'result-too-large'` if exceeding 256 KiB (non-retryable).
 */
export function streamManifest(
  task: { resultKey: string; range: { from: number; to: number } | null; input?: Record<string, unknown> },
  parts: { inits: Readonly<Record<string, StreamInitMeta>>; segments: Readonly<Record<string | number, StreamSegmentMeta>> },
): StreamManifestOut {
  const input = streamInputOf(task);
  if (!input || !task.range) throw Object.assign(new Error("Task has no input.stream / range"), { retryable: false });
  const { from, to } = task.range;
  const inits: Record<string, StreamInitMeta> = {};
  const segments: Record<string, StreamSegmentMeta> = {};
  for (let n = from; n <= to; n++) {
    const seg = parts.segments[n];
    const init = seg ? parts.inits[seg.init] : undefined;
    if (!seg || !init) continue;
    if (!inits[seg.init]) inits[seg.init] = { hash: init.hash, bytes: init.bytes, codec: init.codec ?? null, width: init.width ?? null, height: init.height ?? null,
      timescale: init.timescale ?? null, rect: init.rect ? { ...init.rect } : null, encoder: init.encoder ?? null };
    segments[n] = { hash: seg.hash, bytes: seg.bytes, init: seg.init, stride: seg.stride, samples: seg.samples, sig: seg.sig ?? null, encoder: init.encoder ?? null,
      ...(seg.box !== undefined ? { box: seg.box ? { ...seg.box } : null } : {}) };
  }
  const out: StreamManifestOut = {
    v: STREAM_RESULT_VERSION, kind: "stream", resultKey: task.resultKey, range: { from, to },
    header: { kind: "card", plane: "local", clipIds: [...input.clipIds], fps: input.fps, originFrame: input.originFrame, lastFrame: input.lastFrame, bound: { ...input.bound }, offset: { ...input.offset }, tight: null },
    inits, segments,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  if (bytes > STREAM_RESULT_MAX_BYTES) throw Object.assign(new Error(`Task manifest is ${bytes} bytes, over the limit of ${STREAM_RESULT_MAX_BYTES}`), { code: "result-too-large", bytes, retryable: false });
  return out;
}

/**
 * Copies of a stream task segment manifest to write into the content store (`render-manifest`): the
 * task's own key `<resultKey>:<start>-<end>`, plus each differing bucket in "8 segments per bucket"
 * (`render/streamBuckets.mjs`, following the same rule as `writeManifest` in desktop
 * `server/artifact-transfer.mjs`). Bucket ends are truncated to **the last segment of the entire stream**,
 * converted from the task's `input.stream` (`originFrame` / `lastFrame`), without capping at task
 * `range.to`: when task `[0, 59]` is not the end of the stream, the final bucket is `56-63`, writing to
 * the same key as task `[60, 124]`. Before writing each copy, callers merge it with any existing copy
 * in the content store (`mergeStreamManifest`), combining segments from both sides.
 */
export function streamManifestPuts(
  task: { resultKey: string; range: { from: number; to: number } | null; input?: Record<string, unknown> },
  manifest: StreamManifestOut,
): { key: string; body: StreamManifestOut }[] {
  const range = task.range;
  if (!range || typeof task.resultKey !== "string" || !task.resultKey || !isInt(range.from) || !isInt(range.to) || range.from < 0 || range.to < range.from) return [];
  const out = [{ key: `${task.resultKey}:${range.from}-${range.to}`, body: manifest }];
  const span = task.input?.stream as { originFrame?: unknown; lastFrame?: unknown } | undefined;
  const lastSegment = streamLastSegmentOf(span) ?? streamLastSegmentOf(manifest.header);
  for (const bucket of streamBucketRanges(range.from, range.to, lastSegment)) {
    if (bucket.from === range.from && bucket.to === range.to) continue;
    out.push({ key: `${task.resultKey}:${bucket.from}-${bucket.to}`, body: streamBucketManifest(manifest, bucket) as StreamManifestOut });
  }
  return out;
}

/**
 * Merges with the existing copy in the content store (same key) before writing a stream manifest,
 * without downgrading: if a segment in the new manifest is sparse while the existing one is full
 * density, keep the existing one; retain segments present in the existing manifest but absent from the
 * new one; use the new ones for the rest. Retained segments bring along their head files. If a new
 * segment lacks a position rectangle (`box`, measured only in the sparse pass) while the existing
 * segment has one, carry it over: the position rectangle persists after upgrading to full density.
 * Follows the same rule as `mergeStreamResult` in desktop `server/artifact-transfer.mjs`. If the
 * existing copy does not match (key, range, shape), returns the new copy as-is.
 */
export function mergeStreamManifest(existing: unknown, next: StreamManifestOut): StreamManifestOut {
  const old = existing as StreamManifestOut | null;
  if (!old || typeof old !== "object" || old.v !== next.v || old.kind !== "stream" || old.resultKey !== next.resultKey) return next;
  if (old.range?.from !== next.range.from || old.range?.to !== next.range.to || !old.segments || typeof old.segments !== "object" || !old.inits || typeof old.inits !== "object") return next;
  const segments = { ...next.segments }, inits = { ...next.inits };
  let kept = 0;
  for (const [n, seg] of Object.entries(old.segments)) {
    const init = seg && typeof seg === "object" ? old.inits[seg.init] : undefined;
    if (!init || !HEX64.test(String(seg.hash)) || !HEX64.test(String(init.hash))) continue;
    const cur = segments[n];
    if (cur && (!(cur.stride > 1) || seg.stride > 1)) {
      if (cur.box === undefined && seg.box !== undefined) { segments[n] = { ...cur, box: seg.box }; kept++; }
      continue;
    }
    segments[n] = seg;
    if (!inits[seg.init]) inits[seg.init] = init;
    kept++;
  }
  return kept ? { ...next, inits, segments } : next;
}

/**
 * Whether a stream manifest retrieved from the content store can be used directly as this segment's
 * result (deduplication): shape is valid, and every segment in the task range along with its head
 * file is listed. For `dense` (full-density tasks), additionally requires every segment to be full
 * density; for sparse stream tasks, any version for each segment qualifies.
 */
export function streamManifestCovers(body: unknown, task: { resultKey: string; range: { from: number; to: number } | null }, opts: { dense?: boolean } = {}): body is StreamManifestOut {
  const b = body as StreamManifestOut | null;
  if (!b || typeof b !== "object" || b.v !== STREAM_RESULT_VERSION || b.kind !== "stream" || b.resultKey !== task.resultKey || !task.range) return false;
  if (b.range?.from !== task.range.from || b.range?.to !== task.range.to) return false;
  if (!b.header || !Array.isArray(b.header.clipIds) || !isStreamOrigin(b.header.originFrame) || !b.inits || typeof b.inits !== "object" || !b.segments || typeof b.segments !== "object") return false;
  for (let n = task.range.from; n <= task.range.to; n++) {
    const seg = b.segments[n];
    const init = seg ? b.inits[seg.init] : undefined;
    if (!seg || !init || !HEX64.test(String(seg.hash)) || !HEX64.test(String(init.hash))) return false;
    if (!isInt(seg.samples) || seg.samples < 1 || !isInt(seg.stride) || seg.stride < 1) return false;
    if (opts.dense === true && seg.stride !== 1) return false;
  }
  return true;
}

/** Chunks in the stream manifest required to exist on the asset service (all under pixel category `px`): head files and segments, deduplicated by hash */
export function streamManifestBlocks(m: StreamManifestOut): { ns: "px"; hash: string }[] {
  const out = new Map<string, { ns: "px"; hash: string }>();
  for (const init of Object.values(m.inits ?? {})) out.set(init.hash, { ns: "px", hash: init.hash });
  for (const seg of Object.values(m.segments ?? {})) out.set(seg.hash, { ns: "px", hash: seg.hash });
  return [...out.values()];
}

/* ------------------------------------------------------------------ Arrangement */

/** A task in the queue (TaskView from Contract A.4; only these fields are used here) */
export interface NodeTask {
  id: string;
  kind: string;
  tier?: string;
  resultKey: string;
  range: { unit?: string; from: number; to: number } | null;
  source: { projectId: string; projectRev: number; userId?: string };
  input?: Record<string, unknown>;
  requires?: Record<string, unknown>;
  version?: number;
  [k: string]: unknown;
}

/** Output for a single frame (returned by the host's `bakeFrame`) */
export interface BakedFrame {
  /** sha256 of original-size HTML snapshot (raw bytes) */
  hash: string;
  bytes: number;
  htmlGz?: ArrayBuffer;
  /** sha256 and byte length of small-size prerender (WebP) */
  small?: { hash: string; bytes: number } | null;
  [k: string]: unknown;
}
export type FrameRecord = BakedFrame & { localFrame: number };

export type YieldCause = "play" | "drag" | "urgent" | "hidden";

export interface BrowserNodeDeps {
  nodeId: string;
  projectId: string;
  /** "username@device" (isomorphic with `source.userId` populated by document service from credentials) */
  userId: string;
  codeVersion: string | null;
  /** Raw value of `pageEnvironment()` */
  environment: { platform: string; userAgent: string; renderer: string; vendor: string };
  now: () => number;
  /** Idle criterion (decided by the parent page, section 2) */
  isIdle: () => boolean;
  /** Send one message on the render connection */
  send: (message: Record<string, unknown>) => boolean | void;
  /** Confirmed version kept when the manifest plan was published (D6); null if none */
  keptProject: (rev: number) => unknown | null;
  /** The version returned by `project.snapshot.get`; null if none */
  fetchSnapshot: (rev: number) => Promise<unknown | null>;
  /** Generate this frame (background stage) and push it; stop as early as possible when `signal` aborts */
  bakeFrame: (job: { task: NodeTask; project: unknown; localFrame: number; signal: AbortSignal }) => Promise<BakedFrame>;
  /**
   * Once all segments are in, assemble the manifest and write the content store; the returned object
   * is spread into the `task.complete` result
   */
  finishTask: (arg: { task: NodeTask; frames: FrameRecord[] }) => Promise<Record<string, unknown>>;
  /**
   * Dedup (section 4.1): returns the manifest if the content store has it, it covers the whole segment,
   * and all its chunks are on the asset service; otherwise null
   */
  lookupResult?: (task: NodeTask) => Promise<Record<string, unknown> | null>;
  /**
   * Whether this page can currently encode a track stream (the result the host probed with
   * `probeStreamEncoder`). Read once per tick, not cached. Only when it returns true and `bakeStream` is
   * provided does the capability flag `capabilities.streams` report true (node-side filter rule 2 claims
   * stream tasks based on it). If not provided, the node does not produce streams, same as before.
   */
  streams?: () => boolean;
  /**
   * Runs one stream task (`kind: 'stream'`): builds an isolated single-card project from `input.bake`,
   * then, for each segment and frame in the task range, requests pixels, feeds the encoder, and pushes
   * the head file and segments to the asset service.
   * `progress(n)` reports how many frames are done (report the starting point once at the start: the frame
   * count of segments already pushed in the previous claim, or 0 if none); ask `yielding()` before each
   * frame, and if it is true, stop once the current frame is done and return `{ yielded: true }`; stop as
   * early as possible when `signal` aborts.
   * When all segments are pushed, returns `{ manifest }` (the manifest, in the shape of `streamManifest`).
   */
  bakeStream?: (job: { task: NodeTask; project: unknown; signal: AbortSignal; progress: (frames: number) => void; yielding: () => boolean }) => Promise<{ manifest: Record<string, unknown> } | { yielded: true }>;
  /**
   * Writes the content store (`render-manifest`) once all segments of a stream task are in; the returned
   * object is spread into the `task.complete` result. If not provided, the manifest returned by
   * `bakeStream` is used directly
   */
  finishStream?: (arg: { task: NodeTask; manifest: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  /**
   * Called after a segment task ends (completed, failed, released, claim lost); the host hands the
   * background stage back on this signal
   */
  onTaskEnd?: (task: NodeTask, outcome: string) => void;
  /** `node.welcome` returned a fingerprint */
  onFingerprint?: (envFingerprint: string) => void;
  /**
   * Returns the registry contents (`getNodeCardInfo` in `nodeCardInfo.ts`) when this page can run synced
   * user cards and media effect cards; if it cannot, or this is not provided, the node stays the plain
   * browser node as before.
   * Read once per tick, not cached.
   */
  cardInfo?: () => { cardRuntime: string | null; userCards: boolean; graphCards: boolean; cardSources: Readonly<Record<string, string>> } | null;
  /**
   * `node.welcome` returned (or did not return) the fingerprint used for user cards and media effect
   * cards (null is passed when absent)
   */
  onCardEnvFingerprint?: (cardEnvFingerprint: string | null) => void;
  /**
   * Check-in was rejected by the document service (`forbidden`, `not-chromium`, `bad-message`, ...): the
   * host ends the session and does not reconnect
   */
  onRefused?: (reason: string) => void;
  /**
   * What the page is busy with when it holds no claim (used for reporting busy, M7 D2 addendum): a short
   * string such as `'stage'` when the background stage is measuring or running a catch-up run; null when
   * idle, the page is hidden, or it is only playing or scrubbing and the background has no work. If not
   * provided, busy is reported only while holding a claim
   */
  busy?: () => string | null;
  random?: () => number;
  constants?: Record<string, unknown>;
}

export interface BrowserNodeDebug {
  state: "off" | "idle" | "busy" | "baking";
  reason: string | null;
  nodeId: string;
  envFingerprint: string | null;
  /**
   * Fingerprint used for user card and media effect card tasks (block N); null if no runtime version
   * was reported or the queue is old
   */
  cardEnvFingerprint: string | null;
  /**
   * User card and media effect card capabilities and card code identities currently reported to the
   * node-side filter (block N): card id → identity
   */
  cards: { runtime: string | null; userCards: boolean; graphCards: boolean; sources: Record<string, string> };
  /**
   * The "can produce track streams" flag currently reported to the node-side filter (the host found an
   * encoder and provided a method to run stream tasks)
   */
  streams: boolean;
  codeVersion: string | null;
  holding: { id: string; token: number; done: number; of: number; projectRev: number | null }[];
  counters: {
    claims: number; completed: number; dedup: number; failed: number; lost: number; bakedFrames: number;
    /** Stream tasks: frames fed to the encoder (including fully transparent ones) and stream tasks completed */
    streamFrames: number; streamTasks: number;
    /** Number of `node.active` messages sent (busy reports, M7 D2 addendum) */
    active: number;
    released: Record<string, number>;
    /** Tasks blocked by the node-side filter, keyed by "rule number: reason" (each task id is recorded once) */
    blocked: Record<string, number>;
    frameMs: { n: number; p50: number | null; p95: number | null };
  };
  lastError: string | null;
}

export interface BrowserNode {
  /**
   * Check in and watch this project (called when a new session is established; resumes with the claims
   * in hand)
   */
  start(): void;
  /** Messages received on the render connection */
  receive(message: Record<string, unknown>): void;
  /** Tick for claiming and lease renewal (the host calls it at an interval) */
  tick(): void;
  /** Yield (D8) */
  yieldFor(cause: YieldCause): void;
  /** Go offline: release everything and stop claiming */
  stop(): void;
  debug(): BrowserNodeDebug;
  /**
   * Whether a claim is in hand (running, checking dedup, or fetching the project all count). Page-side
   * stream production (`pageStreams.ts`) uses this to avoid using the background stage at the same time
   * as a claimed task
   */
  working(): boolean;
  readonly envFingerprint: string | null;
  readonly cardEnvFingerprint: string | null;
}

type NodeSession = {
  start(resume?: { id: string; token: number }[]): void;
  receive(message: unknown): void;
  tick(): void;
  progress(id: string, done: number): boolean;
  complete(id: string, result?: unknown): boolean;
  fail(id: string, error?: string, retryable?: boolean): boolean;
  yieldAll(reason?: string): number;
  held(): { id: string; token: number; lastSentAt: number }[];
  known(): NodeTask[];
};
const createNodeSession = createNodeSessionUntyped as (options: Record<string, unknown>) => NodeSession;
const checkClaimable = checkClaimableUntyped as (task: unknown, node: unknown) => { ok: boolean; rule?: number; reason?: string };

type TaskRunner = {
  onTask(task: NodeTask, ctx: { token: number }): void;
  onLost(id: string, reason: string): void;
  stop(reason?: string): void;
  tokenOf(id: string): number | null;
};
const createTaskRunner = createTaskRunnerUntyped as (options: Record<string, unknown>) => TaskRunner;
/**
 * Abort marker (the same one as in task-runner: losing the race to the abort signal is not the
 * executor's fault)
 */
const ABORTED = ABORTED_UNTYPED as symbol;

function untilAborted<T>(work: () => Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(ABORTED);
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const settled = new Promise<T>((resolve) => resolve(work()));
  return Promise.race([settled, aborted]).finally(() => { if (onAbort) signal.removeEventListener("abort", onAbort); });
}

const quantile = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;

/** Keep this many of the most recent per-frame timing samples to compute p50 / p95 */
const FRAME_SAMPLES = 200;
/**
 * After yielding (play / drag / urgent), wait at most this long for the current frame to finish; after
 * that, abort it and release immediately, as when the page is hidden (level-3 number).
 * While playing or scrubbing, the gate for background work closes and the frame in progress is blocked
 * in the stage; without an upper limit it would neither produce a frame nor release (M7 acceptance
 * probes A5 / A6).
 */
export const YIELD_FRAME_MAX_MS = 1000;
/**
 * How many segments of finished frames to keep (after yielding, re-claiming the same segment only
 * fills in the missing frames)
 */
const RETAINED_TASKS = 8;

/**
 * This page's bookkeeping for one claim (the execution rules live in task-runner; this only handles
 * frames, yielding and diagnostics)
 */
interface Run {
  task: NodeTask;
  token: number;
  /**
   * Aborts the stage's current snapshot generation: follows the runner's abort signal, and is also
   * aborted by this page when it is hidden
   */
  controller: AbortController;
  /**
   * Which step: checking dedup and fetching the project (`prep`), waiting for `bakeFrame` to return
   * (`baking`), between frames (`between`), assembling the manifest once all segments are in (`finishing`)
   */
  phase: "prep" | "baking" | "between" | "finishing";
  /** Reason yielding was requested (release once the current frame is done) */
  yieldCause: YieldCause | null;
  /**
   * When yielding was requested (`deps.now()`): if the current frame is not done within
   * `YIELD_FRAME_MAX_MS`, release immediately
   */
  yieldAt: number | null;
  frames: Map<number, FrameRecord>;
  /** Stream task: which frame this claim has reached (reported by the host) */
  streamDone: number;
  /** Stream task: starting frame count reported by the host at the start (null if not reported yet) */
  streamBase: number | null;
  /** Manifest found by the dedup check (`sink.resultFor` returns it) */
  found: Record<string, unknown> | null;
  ended: boolean;
}

export function createBrowserNode(deps: BrowserNodeDeps): BrowserNode {
  const nodeDesc = {
    profile: "browser",
    nodeId: deps.nodeId,
    userId: deps.userId,
    envFingerprint: null as string | null,
    /**
     * Fingerprint used for user card and media effect card tasks (block N,
     * `node.welcome.cardEnvFingerprint`); rule 1 of filter.mjs compares against it for such tasks
     */
    cardEnvFingerprint: null as string | null,
    codeVersions: deps.codeVersion ? [deps.codeVersion] : [],
    capabilities: { transcode: false, streams: false, userCards: false, graphCards: false },
    cardSourceVersions: {} as Record<string, string[]>,
  };
  /**
   * The card registry last reported to the node-side filter (diagnostics) and the runtime version last
   * reported in `node.hello` (used to decide whether to check in again)
   */
  let cardsNow: { runtime: string | null; userCards: boolean; graphCards: boolean; sources: Record<string, string> } = { runtime: null, userCards: false, graphCards: false, sources: {} };
  let helloRuntime: string | null = null;
  /** This page's current card registry (from the host); unreadable or throwing counts as absent */
  const readCardInfo = () => {
    try {
      const info = deps.cardInfo?.() ?? null;
      if (!info || typeof info.cardRuntime !== "string" || !info.cardRuntime) return { runtime: null, userCards: false, graphCards: false, sources: {} as Record<string, string> };
      return { runtime: info.cardRuntime, userCards: info.userCards === true, graphCards: info.graphCards === true, sources: { ...info.cardSources } };
    } catch { return { runtime: null, userCards: false, graphCards: false, sources: {} as Record<string, string> }; }
  };
  /**
   * Whether this page can produce streams right now: the host found an encoder and also provided a method
   * to run stream tasks (unreadable or throwing counts as unable)
   */
  const canStream = (): boolean => {
    if (typeof deps.bakeStream !== "function") return false;
    try { return deps.streams?.() === true; } catch { return false; }
  };
  /**
   * Sync the registry into the node description (capability flags and card code identities); node-side
   * filtering and claiming decide based on it
   */
  const refreshCards = () => {
    cardsNow = readCardInfo();
    // When the document service did not return cardEnvFingerprint (old queue, runtime version not
    // acceptable), do not report the capability: a claim would be rejected anyway because the fingerprint
    // does not match, so there is no point in sending the request
    const usable = cardsNow.runtime !== null && nodeDesc.cardEnvFingerprint !== null;
    nodeDesc.capabilities = { ...nodeDesc.capabilities, streams: canStream(), userCards: usable && cardsNow.userCards, graphCards: usable && cardsNow.graphCards };
    const versions: Record<string, string[]> = {};
    if (usable) for (const [id, v] of Object.entries(cardsNow.sources)) versions[id] = [v];
    nodeDesc.cardSourceVersions = versions;
  };
  let stopped = false;
  let welcomed = false;
  let refused: string | null = null;
  let run: Run | null = null;
  let lastError: string | null = null;
  /**
   * Busy-report interval (`node.welcome.activeIntervalMs`); an old queue does not send it, so it is null
   * and no report is sent
   */
  let activeEvery: number | null = null;
  let lastActiveAt = -Infinity;
  /** Finished frames: task id → frames; evicted in insertion order */
  const retained = new Map<string, Map<number, FrameRecord>>();
  const blockedSeen = new Set<string>();
  const frameMs: number[] = [];
  const counters = {
    claims: 0, completed: 0, dedup: 0, failed: 0, lost: 0, bakedFrames: 0, streamFrames: 0, streamTasks: 0, active: 0,
    released: {} as Record<string, number>,
    blocked: {} as Record<string, number>,
  };
  const bump = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };

  /**
   * Send on the render connection: `node.hello` reports only raw values (D10); the self-reported
   * fingerprint is dropped
   */
  const send = (message: Record<string, unknown>) => {
    let m = message;
    if (m.type === "node.hello") {
      const { envFingerprint: _own, ...rest } = m;
      m = { ...rest, profile: "browser", maxConcurrent: 1, environment: { ...deps.environment } };
      // Block N: if user cards and media effect cards can run, also report the runtime version (raw value;
      // the document service computes cardEnvFingerprint); when they cannot, it is identical to before,
      // character for character
      const runtime = readCardInfo().runtime;
      helloRuntime = runtime;
      if (runtime) m = { ...m, cardRuntime: runtime };
    }
    if (m.type === "task.claim") counters.claims++;
    return deps.send(m);
  };

  const holding = (r: Run) => !stopped && !r.ended && run === r && !r.controller.signal.aborted
    && session.held().some((h) => h.id === r.task.id && h.token === r.token);

  const endRun = (r: Run, outcome: string) => {
    if (r.ended) return;
    r.ended = true;
    if (run === r) run = null;
    try { deps.onTaskEnd?.(r.task, outcome); } catch { /* A broken host does not affect the protocol */ }
  };

  const keepFrames = (id: string, frames: Map<number, FrameRecord>) => {
    retained.delete(id);
    if (!frames.size) return;
    retained.set(id, frames);
    while (retained.size > RETAINED_TASKS) retained.delete(retained.keys().next().value as string);
  };

  /**
   * Do not wait for the current frame: abort it and release immediately (page hidden; or, after yielding,
   * the current frame times out without finishing)
   */
  const abortAndRelease = (r: Run, reason: string) => {
    if (!holding(r)) return;
    keepFrames(r.task.id, r.frames);
    session.yieldAll(reason);
    bump(counters.released, reason);
    r.controller.abort();
    endRun(r, `released:${reason}`);
  };

  /**
   * Release the segment in hand (yielding, project unavailable): not counted as a failure (C2). After the
   * release the runner decides "no longer held" and discards this execution
   */
  const release = (r: Run, reason: string) => {
    if (!holding(r)) { endRun(r, "discarded"); return; }
    keepFrames(r.task.id, r.frames);
    session.yieldAll(reason);
    bump(counters.released, reason);
    endRun(r, `released:${reason}`);
  };

  const runOf = (ref: { resultKey?: unknown; range?: { from?: unknown; to?: unknown } | null }) => {
    const r = run;
    return r && r.task.resultKey === ref?.resultKey && r.task.range?.from === ref?.range?.from && r.task.range?.to === ref?.range?.to ? r : null;
  };

  /**
   * Run one segment (executor.render of task-runner): fetch the project, generate snapshots frame by
   * frame, handle yielding. Returns this segment's frames
   */
  async function render(task: NodeTask, { signal, progress }: { signal: AbortSignal; progress: (done: number) => void }): Promise<FrameRecord[] | { stream: Record<string, unknown> } | null> {
    const r = run && run.task.id === task.id ? run : null;
    if (!r) throw ABORTED;
    signal.addEventListener("abort", () => r.controller.abort(), { once: true });
    const mine = r.controller.signal;
    const isStream = task.kind === "stream";
    if ((task.kind !== "snapshot" && !isStream) || !task.range || (isStream && (typeof deps.bakeStream !== "function" || !streamTaskFrames(task)))) {
      // The node-side filter lets in only snapshot tasks and browser-shaped single-card streams; if anything
      // else arrives (or the host produces no streams), release it and do not run it
      release(r, "unsupported");
      return null;
    }
    if (r.yieldCause) { release(r, `yield-${r.yieldCause}`); return null; }
    // D6: the version matching the task's projectRev; use the one kept at publish time first, otherwise
    // fetch the snapshot, and if neither exists release the task rather than render another version
    const rev = Number(task.source?.projectRev);
    let project: unknown = Number.isSafeInteger(rev) ? deps.keptProject(rev) : null;
    if (!project && Number.isSafeInteger(rev)) {
      project = await untilAborted(() => deps.fetchSnapshot(rev), mine).catch((e) => { if (e === ABORTED) throw e; return null; });
      if (!holding(r)) return null;
    }
    if (!project) {
      lastError = tr("Cannot get project revision {0}", Number.isSafeInteger(rev) ? rev : "?");
      release(r, "no-snapshot");
      return null;
    }
    if (isStream) {
      // The whole stream task is handed to the host: it requests pixels frame by frame, feeds the encoder
      // and pushes segments; it asks before each frame whether to yield, and stops only after the current
      // frame is done
      r.phase = "baking";
      let out: { manifest: Record<string, unknown> } | { yielded: true };
      try {
        out = await untilAborted(() => deps.bakeStream!({
          task, project, signal: mine,
          progress: (n) => {
            const done = Math.max(0, Math.floor(Number(n) || 0));
            // The host first reports a starting point once (the frame count of segments already pushed in the
            // previous claim; nonzero when returning after a yield and release): the starting point is not counted
            // as frames fed to the encoder this time
            if (r.streamBase !== null && done > r.streamDone) counters.streamFrames += done - r.streamDone;
            if (r.streamBase === null) r.streamBase = done;
            r.streamDone = Math.max(r.streamDone, done);
            if (holding(r)) progress(r.streamDone);
          },
          yielding: () => r.yieldCause !== null,
        }), mine);
      } finally {
        r.phase = "between";
      }
      if (!holding(r)) return null;
      if (!("manifest" in out)) { release(r, `yield-${r.yieldCause ?? "urgent"}`); return null; }
      // All segments are in: from here on, finish up even if asked to yield (same as snapshot tasks)
      r.phase = "finishing";
      counters.streamTasks++;
      return { stream: out.manifest };
    }
    const { from, to } = task.range;
    for (let f = from; f <= to; f++) {
      if (r.frames.has(f)) continue;
      if (r.yieldCause) { release(r, `yield-${r.yieldCause}`); return null; }
      if (!holding(r)) return null;
      const t0 = deps.now();
      r.phase = "baking";
      let out: BakedFrame;
      try {
        out = await untilAborted(() => deps.bakeFrame({ task, project, localFrame: f, signal: mine }), mine);
      } finally {
        r.phase = "between";
      }
      if (!holding(r)) return null;
      r.frames.set(f, { ...out, localFrame: f });
      counters.bakedFrames++;
      frameMs.push(Math.max(0, deps.now() - t0));
      if (frameMs.length > FRAME_SAMPLES) frameMs.splice(0, frameMs.length - FRAME_SAMPLES);
      progress(r.frames.size);
    }
    // All segments in: from here on, finish up even if asked to yield (this batch is done, and releasing
    // would only make the next claimer redo it)
    r.phase = "finishing";
    return [...r.frames.values()].sort((a, b) => a.localFrame - b.localFrame);
  }

  const sink = {
    /**
     * Dedup (section 4.1): if the content store manifest exists, covers the whole segment, and all chunks
     * are present, complete directly
     */
    async has(ref: { resultKey: string; range: NodeTask["range"] }) {
      const r = runOf(ref);
      if (!r || !deps.lookupResult) return false;
      const found = await untilAborted(() => deps.lookupResult!(r.task), r.controller.signal).catch((e) => { if (e === ABORTED) throw e; return null; });
      r.found = found && typeof found === "object" ? found : null;
      return !!r.found;
    },
    async resultFor(ref: { resultKey: string; range: NodeTask["range"] }) {
      return runOf(ref)?.found ?? null;
    },
    /**
     * Once all segments are in, assemble the manifest and write the content store (the host's finishTask);
     * the returned manifest is spread into `task.complete`
     */
    async put(entry: { resultKey: string; range: NodeTask["range"]; artifacts: FrameRecord[] | { stream: Record<string, unknown> } | null }) {
      const r = runOf(entry);
      if (r && entry.artifacts && !Array.isArray(entry.artifacts) && entry.artifacts.stream && typeof entry.artifacts.stream === "object") {
        // Stream task: all segments are already pushed to the asset service, so only writing the manifest to
        // the content store remains (a failed write is only recorded as a diagnostic; the manifest is still
        // delivered to subscribers with task.complete)
        const manifest = entry.artifacts.stream;
        const result = deps.finishStream ? await deps.finishStream({ task: r.task, manifest }) : manifest;
        return { complete: true, result };
      }
      if (!r || !Array.isArray(entry.artifacts)) return { complete: false };
      const result = await deps.finishTask({ task: r.task, frames: entry.artifacts });
      return { complete: true, result };
    },
  };

  /** Diagnostic events from task-runner: wrap-up and counts */
  const onRunnerEvent = (e: { type: string; id: string; error?: string; retryable?: boolean }) => {
    const r = run && run.task.id === e.id ? run : null;
    switch (e.type) {
      case "completed":
        counters.completed++;
        retained.delete(e.id);
        if (r) endRun(r, "completed");
        break;
      case "dedup":
        counters.dedup++;
        retained.delete(e.id);
        if (r) endRun(r, "dedup");
        break;
      case "failed":
        counters.failed++;
        lastError = e.error ?? lastError;
        if (r) { keepFrames(e.id, r.frames); endRun(r, e.retryable === false ? "failed-final" : "failed"); }
        break;
      case "discarded":
        if (r) { keepFrames(e.id, r.frames); endRun(r, "discarded"); }
        break;
      default:
        break;
    }
  };

  const runner = createTaskRunner({
    nodeId: deps.nodeId,
    session: () => session,
    executor: { render },
    sink,
    emit: (e: { type: string; id: string; error?: string; retryable?: boolean }) => { try { onRunnerEvent(e); } catch { /* A diagnostics failure does not interrupt the protocol */ } },
  });

  const session = createNodeSession({
    nodeId: deps.nodeId,
    node: nodeDesc,
    send,
    now: deps.now,
    isIdle: () => !stopped && refused === null && welcomed && deps.isIdle(),
    maxConcurrent: 1,
    projects: [deps.projectId],
    ...(deps.random ? { random: deps.random } : {}),
    ...(deps.constants ? { constants: deps.constants } : {}),
    onTask: (task: NodeTask, ctx: { token: number }) => {
      if (!task || typeof task.id !== "string") return;
      if (run) { run.controller.abort(); endRun(run, "replaced"); }
      run = {
        task, token: ctx.token, controller: new AbortController(), phase: "prep", yieldCause: null, yieldAt: null,
        frames: new Map(retained.get(task.id) ?? []), streamDone: 0, streamBase: null, found: null, ended: false,
      };
      // The rules for reporting 0 at the start, dedup, execution, pushing and completion live in task-runner
      // (one copy shared by the desktop and the page, D11)
      runner.onTask(task, ctx);
    },
    onLost: (id: string, reason: string) => {
      counters.lost++;
      runner.onLost(id, reason);
      const r = run;
      if (r && r.task.id === id) { r.controller.abort(); keepFrames(id, r.frames); endRun(r, `lost:${reason}`); }
    },
  });

  /**
   * What is busy right now (for busy reports): holding a claim means generating snapshots / encoding a
   * stream; dragging / scrubbing reports scrub, playing reports play; otherwise ask the host (more urgent
   * work on the background stage)
   */
  const busyNow = (): string | null => {
    const r = run;
    if (r && !r.ended) {
      if (r.yieldCause === "drag") return "scrub";
      if (r.yieldCause === "play") return "play";
      return "bake";
    }
    try {
      const b = deps.busy?.() ?? null;
      if (typeof b === "string" && b) {
        if (b === "drag") return "scrub";
        return b.slice(0, 32);
      }
      return null;
    } catch { return null; }
  };

  /**
   * Report busy (M7 D2 addendum): sent only if the queue is new, the node has checked in, it is busy, and
   * the interval since the last report has passed
   */
  const reportActive = () => {
    if (activeEvery === null || !welcomed || stopped || refused) return;
    const now = deps.now();
    if (now - lastActiveAt < activeEvery) return;
    const busy = busyNow();
    if (!busy) return;
    if (send({ type: "node.active", busy }) === false) return;
    lastActiveAt = now;
    counters.active++;
  };

  /**
   * Record a task blocked by the node-side filter once per reason (diagnostics; both the server and the
   * node side block it, so the page makes no separate decision)
   */
  const noteBlocked = () => {
    for (const task of session.known()) {
      if (blockedSeen.has(task.id)) continue;
      const c = checkClaimable(task, nodeDesc);
      if (c.ok) continue;
      blockedSeen.add(task.id);
      bump(counters.blocked, `${c.rule}:${c.reason}`);
    }
    if (blockedSeen.size > 5000) blockedSeen.clear();
  };

  return {
    start() {
      if (stopped || refused) return;
      welcomed = false;
      // The capability flags sent with the check-in are the current ones (whether the host has found an
      // encoder); after that they sync every tick as usual
      refreshCards();
      // New session: resume with the claims in hand that are genuinely running (HT-a section 4.4; the queue
      // resumes by token, and any that do not match come back as lost)
      session.start(session.held().filter((h) => runner.tokenOf(h.id) === h.token).map(({ id, token }) => ({ id, token })));
    },
    receive(message) {
      if (stopped || !message || typeof message !== "object") return;
      if (message.type === "node.welcome") {
        welcomed = true;
        // A new queue recognizes node.active (M7 D2 addendum): record the interval; it is counted from scratch
        // at every check-in, and if busy, report on the next tick
        const every = Number(message.activeIntervalMs);
        activeEvery = Number.isFinite(every) && every > 0 ? every : null;
        lastActiveAt = -Infinity;
        const fp = typeof message.envFingerprint === "string" && message.envFingerprint ? message.envFingerprint : null;
        if (fp && fp !== nodeDesc.envFingerprint) {
          nodeDesc.envFingerprint = fp;
          try { deps.onFingerprint?.(fp); } catch { /* The host is broken */ }
        }
        // Block N: fingerprint used for user cards and media effect cards (clear it if absent: checking in
        // again, old queue)
        const cardFp = typeof message.cardEnvFingerprint === "string" && message.cardEnvFingerprint ? message.cardEnvFingerprint : null;
        if (cardFp !== nodeDesc.cardEnvFingerprint) {
          nodeDesc.cardEnvFingerprint = cardFp;
          try { deps.onCardEnvFingerprint?.(cardFp); } catch { /* The host is broken */ }
        }
        refreshCards();
      } else if (message.type === "error" && !welcomed && message.reqId === undefined) {
        // Check-in rejected (D9 forbidden, D14 not-chromium, D10 bad-message): do not act as a node, do not reconnect
        refused = String(message.reason ?? "error");
        lastError = `Check-in refused: ${refused}`;
        try { deps.onRefused?.(refused); } catch { /* The host is broken */ }
      }
      if (message.type === "queue.snapshot" || message.type === "task.opened") refreshCards();
      session.receive(message);
      if (message.type === "queue.snapshot" || message.type === "task.opened") noteBlocked();
    },
    tick() {
      if (stopped || refused) return;
      // Block N: whenever the registry changes, sync it into the node description; if the runtime version
      // becomes reportable only after check-in (or changes), check in once more (resuming with the claims
      // in hand)
      refreshCards();
      if (welcomed && cardsNow.runtime !== helloRuntime) {
        welcomed = false;
        session.start(session.held().filter((h) => runner.tokenOf(h.id) === h.token).map(({ id, token }) => ({ id, token })));
      }
      // After yielding the current frame stays unfinished (when playing or scrubbing, the gate for background
      // work is closed and this frame is blocked in the stage): stop waiting, abort and release immediately
      const r = run;
      if (r && !r.ended && r.yieldCause && r.phase === "baking" && r.yieldAt !== null && deps.now() - r.yieldAt >= YIELD_FRAME_MAX_MS) {
        abortAndRelease(r, `yield-${r.yieldCause}`);
      }
      session.tick();
      reportActive();
    },
    yieldFor(cause) {
      const r = run;
      if (!r || r.ended) return;
      if (cause === "hidden") {
        // Timers on a hidden page are throttled, so lease renewal is unreliable: do not wait for the current
        // frame, abort and release immediately; discard late results
        abortAndRelease(r, "yield-hidden");
        return;
      }
      if (!r.yieldCause) { r.yieldCause = cause; r.yieldAt = deps.now(); }
      // Which step we are waiting on decides when to release:
      //   prep       snapshot generation has not started (checking dedup, fetching the project), so there
      //              is no "current batch": release immediately and abort
      //   baking     release after the current frame is done (the execution loop checks yieldCause once
      //              the frame returns)
      //   finishing  all segments are in, only assembling the manifest and reporting completion remain:
      //              complete as usual (releasing would only make the next claimer redo it)
      if (r.phase === "prep") {
        release(r, `yield-${cause}`);
        r.controller.abort();
      }
    },
    stop() {
      if (stopped) return;
      const r = run;
      if (r) { r.controller.abort(); keepFrames(r.task.id, r.frames); }
      try { session.yieldAll("offline"); } catch { /* The connection is broken */ }
      if (r) endRun(r, "released:offline");
      stopped = true;
      runner.stop("offline");
    },
    debug() {
      const sorted = [...frameMs].sort((a, b) => a - b);
      const r = run;
      const held = session.held();
      const state: BrowserNodeDebug["state"] = stopped || refused ? "off" : r && !r.ended ? (r.phase === "baking" ? "baking" : "busy") : "idle";
      return {
        state,
        reason: stopped ? "stopped" : refused ? `refused:${refused}` : !welcomed ? "hello" : r?.yieldCause ? `yield-${r.yieldCause}` : null,
        nodeId: deps.nodeId,
        envFingerprint: nodeDesc.envFingerprint,
        cardEnvFingerprint: nodeDesc.cardEnvFingerprint,
        cards: { runtime: cardsNow.runtime, userCards: nodeDesc.capabilities.userCards, graphCards: nodeDesc.capabilities.graphCards, sources: { ...cardsNow.sources } },
        streams: nodeDesc.capabilities.streams === true,
        codeVersion: deps.codeVersion,
        holding: held.map((h) => ({
          id: h.id, token: h.token,
          // A stream task's range is segment numbers: report by frame count (frames done as reported by the
          // host / total frames of this segment task)
          done: r && r.task.id === h.id ? (r.task.kind === "stream" ? r.streamDone : r.frames.size) : 0,
          of: r && r.task.id === h.id && r.task.range ? (r.task.kind === "stream" ? streamTaskFrames(r.task)?.frames ?? 0 : r.task.range.to - r.task.range.from + 1) : 0,
          projectRev: r && r.task.id === h.id ? Number(r.task.source?.projectRev) : null,
        })),
        counters: {
          claims: counters.claims, completed: counters.completed, dedup: counters.dedup, failed: counters.failed, lost: counters.lost,
          bakedFrames: counters.bakedFrames, streamFrames: counters.streamFrames, streamTasks: counters.streamTasks, active: counters.active,
          released: { ...counters.released }, blocked: { ...counters.blocked },
          frameMs: { n: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95) },
        },
        lastError,
      };
    },
    working() { return !stopped && ((!!run && !run.ended) || session.held().length > 0); },
    get envFingerprint() { return nodeDesc.envFingerprint; },
    get cardEnvFingerprint() { return nodeDesc.cardEnvFingerprint; },
  };
}
