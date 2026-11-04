/**
 * When export begins, request render nodes to render cards not executed on this page frame by
 * frame at original size (semantics `docs/semantics/product/platforms.md` "Online browser"
 * "Export": "Synced user cards and media effect cards not executed on this page should be
 * rendered frame by frame at original size by render nodes before use when export begins; prompt
 * to wait if not all have arrived"): the page side. For the node side, see
 * `server/export-frames.mjs`.
 *
 * # How to request
 *
 * The page publishes an **export-only** manifest plan over its document service connection
 * (task shape matches manifest plan in `online/planPublisher.ts`, with additional
 * `input.exportOnly: true` and an extra segment in signature, so it is not the same task as
 * normal manifest plans):
 *
 *   `plan:<projectId>@<projectRev>#clips:<sig>`   `input.clips` = clips for render nodes to output   `input.exportOnly: true`   (`input.exportSalt`)
 *
 * Nodes claiming it do not slice snapshots or track streams, but only slice **export bitmap
 * tasks** for these clips; the response upon plan completion carries an index (result key,
 * rectangle, and frame range for each clip, an exact copy of each of its tasks, and clips that
 * cannot be output with reasons). The page is the publisher of this plan and receives its
 * `task.done` when the plan completes.
 *
 * # How to wait (each step has an end: either all arrived, or explaining why not)
 *
 * 1. Wait for index. Re-publish the plan every `EXPORT_PLAN_POLL_MS` and check its status in
 *    the response: `open` = no node has claimed it yet (prompt "No render node online", keep
 *    waiting, no timeout); `claimed` = a node took it; `failed` = plan failed, report failure;
 *    `done` = completed: when a completed plan is re-published, the queue re-sends its
 *    `task.done` (with index) to this connection, so failing to get the index after this round
 *    means this result carries no index, report failure.
 * 2. Wait for manifests. Fetch missing manifests every `EXPORT_MANIFEST_POLL_MS` (content store
 *    `render-manifest`, key `<resultKey>:<from>-<to>`), considering this segment complete only
 *    when every frame is listed. Additionally, re-publish pending tasks as-is every
 *    `EXPORT_TASK_CHECK_MS` (carried in index): the queue will not resend notifications for failed
 *    tasks, so report failure if status in response is `failed`; if tasks are gone (page
 *    connection disconnected beyond grace period, subscriptions cleared, unclaimed tasks deleted),
 *    they are rebuilt here without requiring user to restart. If manifest frame count stops
 *    growing and no task is currently claimed by a node for `EXPORT_STALL_MS`, report failure
 *    (the node exited after slicing the plan: tasks are bound to its environment and cannot be
 *    taken over by other nodes).
 * 3. Click export again after failure. Failed tasks in queue are not reopened within retention
 *    period (10 minutes), nor is the same plan sliced again. Therefore, once this page has failed,
 *    subsequent plans carry a new identifier (`input.exportSalt`, included in plan signature and
 *    export bitmap key): plan is new, tasks are new, and nodes re-render. If no failure occurred,
 *    it is omitted, and exporting the same content reuses the previous result directly.
 * Start exporting only after all have arrived, avoiding half-finished final videos. If a node
 * reports a clip cannot be produced, or the version rendered by the node does not match the
 * version held by this page (project modified during export), also throw an error with explanation.
 *
 * # How to fetch
 *
 * One PNG per frame (`px/<hash>`, read-only ticket), used directly as a `data:` URL once fetched
 * (lossless, no decoding). Keep only the current frame, discarding after use.
 */
import { streamInputSig, streamSigStale } from "../render/streamInputSig.mjs";
import { STREAM_SEGMENT_FRAMES } from "../render/streamSegments.mjs";
import { CLIPS_KEY_MARK, clipsSig } from "../online/planPublisher";
import type { FrameCoverage, LayerRect } from "./cardLayers";
import { ONLINE_EXPORT_TEXT } from "./text";
import { tr } from "../i18n/index.ts";

/** Extra segment in signature for export-only manifest plans */
export const EXPORT_ONLY_SIG = "export=1";
/** Interval to re-publish plan (query status, request completion notice) */
export const EXPORT_PLAN_POLL_MS = 3000;
/** Interval to re-fetch incomplete manifests */
export const EXPORT_MANIFEST_POLL_MS = 2000;
/** Interval while waiting for manifests to re-publish pending tasks as-is (check existence and failures; rebuild if absent) */
export const EXPORT_TASK_CHECK_MS = 6000;
/**
 * Duration without progress while waiting for manifests before reporting failure: manifest frame
 * count has not increased, and no task is currently claimed by a node. Defined only here (level-3
 * number).
 * Tasks actively rendered by nodes remain "claimed" and will not be falsely affected; what is
 * caught is "node exited, task left unclaimed".
 */
export const EXPORT_STALL_MS = 3 * 60_000;

/** Minimum launch interval (ms) for export-only plans per project/session: throttles rapid repeated submissions */
export const EXPORT_PLAN_THROTTLE_MS = 2000;
/** Only 1 export plan allowed to execute concurrently per project/session */
export const MAX_CONCURRENT_EXPORT_PLANS = 1;

interface PlanThrottleEntry {
  inFlight: boolean;
  lastTime: number;
}
const planThrottles = new Map<string, PlanThrottleEntry>();

export function resetExportPlanThrottle(): void {
  planThrottles.clear();
}

export function exportPlanThrottleState(key: string): { inFlight: boolean; lastTime: number } | null {
  const e = planThrottles.get(key);
  return e ? { inFlight: e.inFlight, lastTime: e.lastTime } : null;
}

/**
 * New identifier carried on the next attempt after a previous render node request failure on this
 * page (see file header "Click export again after failure"); null if never failed.
 * Accepts only lowercase letters and digits, up to 32 chars (same standard as `exportSaltOf` in
 * `server/export-frames.mjs` on node side).
 */
let retrySalt: string | null = null;
const freshSalt = () => (Math.random().toString(36).slice(2, 12) + Date.now().toString(36)).replace(/[^0-9a-z]/g, "").slice(0, 32);
export const exportRetrySalt = () => retrySalt;
export function resetExportRetry(): void { retrySalt = null; resetExportPlanThrottle(); }
const HASH_RE = /^[0-9a-f]{64}$/;

export interface ExportFrameDeps {
  /** A request on document service (returning response with matching reqId) */
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** `task.done` / `task.failed` pushed from queue (page is publisher, auto-subscribed); returns unsubscribe */
  subscribeQueue(cb: (msg: Record<string, unknown>) => void): () => void;
  assetBase(): string | null;
  authHeaders(): Promise<Record<string, string>>;
  publisherId: string;
  codeVersion?: string | null;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Duration without progress before reporting failure; omitted = `EXPORT_STALL_MS` (probes inject seconds) */
  stallMs?: number;
  /** Interval to check tasks; omitted = `EXPORT_TASK_CHECK_MS` */
  taskCheckMs?: number;
}

export interface ExportPlanTask {
  id: string;
  kind: "plan";
  resultKey: string;
  range: null;
  source: { projectId: string; projectRev: number };
  input: { clips: string[]; exportOnly: true; exportSalt?: string };
  weight: { class: "medium"; estMs: null; frames: null };
  requires: { codeVersion?: string };
  priority: number;
}

/**
 * Priority of export-only plans in queue: ranked ahead of all fine-grained tasks (anchor frame 50,
 * export bitmap task 60). The user is waiting for export; if priority is low, it won't be reached
 * until other snapshot and track stream tasks on the node finish (measured 5-minute wait in same
 * project). Integer priority still falls into normal tier (`priorityBand` in
 * `server/render-queue/messages.mjs`).
 */
export const EXPORT_PLAN_PRIORITY = 70;

/** Export-only manifest plan (queue accepts as manifest plan: result key shape and `input.clips` shape follow its rules) */
export function exportPlanTask({ projectId, projectRev, clips, codeVersion, salt }: { projectId: string; projectRev: number; clips: readonly string[]; codeVersion?: string | null; salt?: string | null }): ExportPlanTask {
  const list = [...new Set(clips)].map(String).filter(Boolean).sort();
  const tail = typeof salt === "string" && /^[0-9a-z]{1,32}$/.test(salt) ? salt : "";
  const resultKey = `${projectId}@${projectRev}${CLIPS_KEY_MARK}${clipsSig(list, tail ? `${EXPORT_ONLY_SIG}:${tail}` : EXPORT_ONLY_SIG)}`;
  return {
    id: `plan:${resultKey}`, kind: "plan", resultKey, range: null,
    source: { projectId, projectRev }, input: { clips: list, exportOnly: true, ...(tail ? { exportSalt: tail } : {}) }, weight: { class: "medium", estMs: null, frames: null },
    requires: typeof codeVersion === "string" && codeVersion ? { codeVersion } : {}, priority: EXPORT_PLAN_PRIORITY,
  };
}

/** An entry in index (`exportIndexOf` in `server/render-node/export-plan.mjs` on node side) */
export interface ExportIndexStream {
  clipId: string;
  kind: "card" | "below";
  plane: "local" | "stage";
  resultKey: string;
  originFrame: number;
  lastFrame: number;
  lastSegment: number;
  segmentsPerTask: number;
  fps: number;
  rect: LayerRect;
  inputSig?: string;
  /** Each export bitmap task for this entry (original copy published by node; re-published as-is when page checks task status) */
  tasks: Record<string, unknown>[];
}
export interface ExportIndex { streams: ExportIndexStream[]; unsupported: { clipId: string; reason: string }[] }

const rectOf = (r: unknown): LayerRect | null => {
  const o = r as Partial<LayerRect> | null;
  if (!o || typeof o !== "object") return null;
  const { x, y, w, h } = o;
  return [x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)) && (w as number) > 0 && (h as number) > 0 ? { x: x as number, y: y as number, w: w as number, h: h as number } : null;
};

/** Index in plan completion response; returns null if shape is invalid, skipping invalid entries */
export function parseExportIndex(raw: unknown): ExportIndex | null {
  const b = raw as { streams?: unknown; unsupported?: unknown } | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.streams)) return null;
  const streams: ExportIndexStream[] = [];
  for (const s of b.streams as Record<string, unknown>[]) {
    const rect = rectOf(s?.rect);
    const kind = s?.kind === "below" ? "below" : s?.kind === "card" ? "card" : null;
    const plane = s?.plane === "stage" ? "stage" : s?.plane === "local" ? "local" : null;
    const ints = [s?.originFrame, s?.lastFrame, s?.lastSegment, s?.segmentsPerTask].map(Number);
    if (!s || typeof s.clipId !== "string" || !s.clipId || !HASH_RE.test(String(s.resultKey)) || !rect || !kind || !plane) continue;
    if (!ints.every(Number.isInteger) || ints[0] < 0 || ints[1] < ints[0] || ints[2] < 0 || ints[3] < 1 || !(Number(s.fps) > 0)) continue;
    // Tasks only accept export bitmap tasks for this stream (id is `stream:<thisResultKey>:<from>-<to>`,
    // with `exportFrames`), ignoring others
    const tasks = (Array.isArray(s.tasks) ? (s.tasks as Record<string, unknown>[]) : []).filter((t) => !!t && typeof t === "object" && t.kind === "stream"
      && typeof t.id === "string" && t.id.startsWith(`stream:${String(s.resultKey)}:`) && t.resultKey === s.resultKey
      && (t.input as { exportFrames?: unknown } | null)?.exportFrames === true);
    streams.push({ clipId: s.clipId, kind, plane, resultKey: String(s.resultKey), originFrame: ints[0], lastFrame: ints[1], lastSegment: ints[2], segmentsPerTask: ints[3],
      fps: Number(s.fps), rect, ...(typeof s.inputSig === "string" && s.inputSig ? { inputSig: s.inputSig } : {}), tasks });
  }
  const unsupported: ExportIndex["unsupported"] = [];
  for (const u of Array.isArray(b.unsupported) ? (b.unsupported as Record<string, unknown>[]) : []) {
    if (u && typeof u.clipId === "string" && u.clipId) unsupported.push({ clipId: u.clipId, reason: typeof u.reason === "string" && u.reason ? u.reason : "unknown" });
  }
  return { streams, unsupported };
}

/** How manifests for this entry are segmented by task: `[from, to]` (segment numbers), sliced with the same scheme */
export function exportSpans(stream: Pick<ExportIndexStream, "lastSegment" | "segmentsPerTask">): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let from = 0; from <= stream.lastSegment; from += stream.segmentsPerTask) out.push([from, Math.min(stream.lastSegment, from + stream.segmentsPerTask - 1)]);
  return out;
}

/** Frames listed in a manifest: project frame number → PNG hash */
export function readExportManifest(body: unknown, resultKey: string, span: [number, number]): Map<number, string> | null {
  const b = body as { kind?: unknown; resultKey?: unknown; range?: { from?: unknown; to?: unknown }; frames?: unknown } | null;
  if (!b || typeof b !== "object" || b.kind !== "export-frames" || b.resultKey !== resultKey || !Array.isArray(b.frames)) return null;
  if (b.range?.from !== span[0] || b.range?.to !== span[1]) return null;
  const out = new Map<number, string>();
  for (const item of b.frames as unknown[]) {
    if (Array.isArray(item) && Number.isInteger(item[0]) && HASH_RE.test(String(item[1]))) out.set(item[0] as number, String(item[1]));
  }
  return out;
}

const cancelled = () => Object.assign(new Error(ONLINE_EXPORT_TEXT.cancelled), { cancelled: true });

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(cancelled()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Status reported to caller while waiting */
export type ExportFramesStatus =
  | { phase: "publishing"; clips: number }
  /** Plan has been dispatched, no render node has claimed it yet */
  | { phase: "no-node"; clips: number }
  /** A node claimed it and is computing how to output */
  | { phase: "planning"; clips: number }
  /** Node is rendering frame by frame: reached `done` frames out of `total` frames */
  | { phase: "rendering"; clips: number; done: number; total: number };

type PublishResult = { id?: string; error?: string; state?: string };

/** Acquired bitmaps: which frames each clip has and how to fetch them */
export interface ExportFrames {
  coverage: Map<string, FrameCoverage>;
  /** PNG for this clip at this frame (`data:` URL) */
  dataUrl(clipId: string, frame: number, signal?: AbortSignal): Promise<string>;
  stats: { fetched: number; bytes: number };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Request render nodes to render `clips` frame by frame and wait until all arrive. `project` is
 * the version used for export (snapshot held by the page), `projectRev` is revision confirmed
 * by document service.
 * Completion criteria: every manifest segment for each clip in index exists, and manifests list
 * every frame in that segment (frame range follows what node provides: first to last clip frame).
 */
export async function requestExportFrames({ projectId, projectRev, project, clips, deps, signal, onStatus }: {
  projectId: string; projectRev: number; project: unknown; clips: readonly string[];
  deps: ExportFrameDeps; signal: AbortSignal; onStatus?: (s: ExportFramesStatus) => void;
}): Promise<ExportFrames> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const throttleKey = `${projectId}:${deps.publisherId}`;
  const tStart = now();
  const existingThrottle = planThrottles.get(throttleKey);
  if (existingThrottle?.inFlight) {
    throw Object.assign(new Error(tr("This project already has an export plan waiting or running, do not start it again")), { throttled: true, retryable: false });
  }
  if (!retrySalt && existingThrottle && tStart - existingThrottle.lastTime < EXPORT_PLAN_THROTTLE_MS) {
    const waitMs = EXPORT_PLAN_THROTTLE_MS - (tStart - existingThrottle.lastTime);
    await sleep(waitMs, signal);
  }
  const throttleRecord: PlanThrottleEntry = { inFlight: true, lastTime: now() };
  planThrottles.set(throttleKey, throttleRecord);

  const stallMs = deps.stallMs ?? EXPORT_STALL_MS;
  const taskCheckMs = deps.taskCheckMs ?? EXPORT_TASK_CHECK_MS;
  const task = exportPlanTask({ projectId, projectRev, clips, codeVersion: deps.codeVersion ?? null, salt: retrySalt });
  const want = task.input.clips;
  const say = (s: ExportFramesStatus) => { try { onStatus?.(s); } catch { /* Host failure does not affect waiting */ } };
  const heard: { index: ExportIndex | null; planFailed: string | null } = { index: null, planFailed: null };
  /** Failed export bitmap tasks: result key → reason (queue emits `task.failed` only on complete failure: non-retryable or retries exhausted) */
  const taskFailures = new Map<string, string>();
  const off = deps.subscribeQueue((msg) => {
    const id = typeof msg?.id === "string" ? msg.id : "";
    if (id === task.id) {
      if (msg.type === "task.done") heard.index = parseExportIndex((msg.result as { exportIndex?: unknown } | null)?.exportIndex) ?? heard.index;
      else if (msg.type === "task.failed") heard.planFailed = String(msg.error ?? "failed");
      return;
    }
    // Stream task id: `stream:<resultKey>:<from>-<to>`
    if (msg?.type === "task.failed" && id.startsWith("stream:")) taskFailures.set(id.split(":")[1] ?? "", String(msg.error ?? "failed"));
  });
  const failureText = (error: string) => (error === "superseded" ? ONLINE_EXPORT_TEXT.projectChanged : ONLINE_EXPORT_TEXT.nodeFailed(error));
  /** Requesting render nodes failed: the next export carries a new identifier, with a new plan and tasks (failed items in the queue will not be reopened) */
  const failed = (message: string, extra: Record<string, unknown> = {}) => {
    retrySalt = freshSalt();
    return Object.assign(new Error(message), extra);
  };
  let hello = false;
  /** Publishes a batch of tasks and returns each item's response (by id); returns null if disconnected or the response is invalid (resend in the next round) */
  const publish = async (tasks: readonly unknown[]): Promise<Map<string, PublishResult> | null> => {
    try {
      if (!hello) {
        const r = await deps.request({ type: "publisher.hello", publisherId: deps.publisherId });
        hello = r?.type === "publisher.welcome";
      }
      if (!hello) return null;
      const reply = await deps.request({ type: "task.publish", tasks });
      if (reply?.type !== "task.published") { hello = false; return null; }
      const out = new Map<string, PublishResult>();
      for (const r of Array.isArray(reply.results) ? (reply.results as PublishResult[]) : []) if (r && typeof r.id === "string") out.set(r.id, r);
      return out;
    } catch { hello = false; return null; }
  };
  try {
    say({ phase: "publishing", clips: want.length });
    // 1. Send the plan, wait for the index
    let doneRounds = 0;
    while (!heard.index) {
      if (signal.aborted) throw cancelled();
      if (heard.planFailed) throw failed(failureText(heard.planFailed));
      const r = (await publish([task]))?.get(task.id);
      const state = r && !r.error && typeof r.state === "string" ? r.state : null;
      if (heard.index) break;
      // The plan has already failed (will not be reopened during retention period): not "no nodes", report failure
      if (state === "failed") throw failed(failureText(heard.planFailed ?? "plan-failed"));
      // The plan is finished, and the queue resent its completion notice (with index) along with the response; if still missing after one round of waiting, this result has no index
      if (state === "done" && ++doneRounds > 1) throw failed(ONLINE_EXPORT_TEXT.nodeFailed("no-index"));
      say(state === "claimed" || state === "done" ? { phase: "planning", clips: want.length } : { phase: "no-node", clips: want.length });
      await sleep(EXPORT_PLAN_POLL_MS, signal);
    }
    const found: ExportIndex = heard.index;
    // 2. Clips the node says it cannot output or did not list: cannot export, state clearly which ones and why
    const listed = new Map(found.streams.map((s) => [s.clipId, s]));
    const bad = want.filter((id) => !listed.has(id)).map((id) => ({ clipId: id, reason: found.unsupported.find((u) => u.clipId === id)?.reason ?? "unknown" }));
    if (bad.length) throw failed(ONLINE_EXPORT_TEXT.nodeCannot(bad.length, bad[0].reason), { unsupported: bad });
    // The version rendered by the node does not match the version held on this page (project was modified during export): do not use visuals from other versions to produce the video.
    // Those without an input signature cannot be verified, so skip them as well (treated as expired)
    for (const s of found.streams) {
      if (!want.includes(s.clipId)) continue;
      if (!s.inputSig) throw failed(ONLINE_EXPORT_TEXT.nodeFailed("no-input-signature"));
      if (streamSigStale(s.inputSig, streamInputSig(project, { clipIds: [s.clipId], kind: s.kind }))) throw failed(ONLINE_EXPORT_TEXT.projectChanged);
    }
    // 3. Wait until manifests for every segment have arrived
    const frames = new Map<string, Map<number, string>>();
    const pending = new Map<string, { stream: ExportIndexStream; span: [number, number] }>();
    /** Manifest key → task for this segment (included in the index); old node indexes omit it, so those segments rely solely on the "no progress" fallback rule */
    const taskOf = new Map<string, Record<string, unknown>>();
    let total = 0;
    for (const id of want) {
      const s = listed.get(id)!;
      frames.set(id, new Map());
      total += s.lastFrame - s.originFrame + 1;
      for (const span of exportSpans(s)) {
        const key = `${s.resultKey}:${span[0]}-${span[1]}`;
        pending.set(key, { stream: s, span });
        const t = s.tasks.find((x) => x.id === `stream:${key}`);
        if (t) taskOf.set(key, t);
      }
    }
    const doneFrames = () => { let n = 0; for (const got of frames.values()) n += got.size; return n; };
    /** Only accept this segment's manifest if it lists every frame it covers (the node writes the manifest only after pushing the entire segment; incomplete ones should never appear) */
    const covers = (got: Map<number, string>, s: ExportIndexStream, span: [number, number]) => {
      const first = s.originFrame + span[0] * STREAM_SEGMENT_FRAMES;
      const last = Math.min(s.lastFrame, s.originFrame + (span[1] + 1) * STREAM_SEGMENT_FRAMES - 1);
      for (let f = first; f <= last; f++) if (!got.has(f)) return false;
      return true;
    };
    let progressAt = now(), lastDone = 0, checkedAt = -Infinity;
    for (;;) {
      if (signal.aborted) throw cancelled();
      for (const [key, { stream, span }] of [...pending]) {
        let body: unknown = null;
        try {
          const r = await deps.request({ type: "content.get", kind: "render-manifest", key });
          body = r?.type === "content.item" && !r.missing ? r.body : null;
        } catch { body = null; }
        const got = readExportManifest(body, stream.resultKey, span);
        if (!got || !covers(got, stream, span)) continue;
        const into = frames.get(stream.clipId)!;
        for (const [f, hash] of got) if (f >= stream.originFrame && f <= stream.lastFrame) into.set(f, hash);
        pending.delete(key);
      }
      if (!pending.size) break;
      for (const [resultKey, error] of taskFailures) {
        if ([...pending.values()].some((p) => p.stream.resultKey === resultKey)) throw failed(failureText(error));
      }
      // Check tasks that have not arrived yet: republish as is, and inspect the status in the response (failed tasks receive no notice; missing ones are rebuilt from here)
      if (now() - checkedAt >= taskCheckMs) {
        checkedAt = now();
        const tasks = [...pending.keys()].map((key) => taskOf.get(key)).filter((t): t is Record<string, unknown> => !!t);
        const results = tasks.length ? await publish(tasks) : null;
        for (const r of results?.values() ?? []) {
          if (r.error) continue;
          if (r.state === "failed") throw failed(failureText(taskFailures.get(String(r.id).split(":")[1] ?? "") ?? "task-failed"));
          // A node is currently claiming it (or just finished and manifest is on the way): count as progress
          if (r.state === "claimed" || r.state === "done") progressAt = now();
        }
      }
      const done = doneFrames();
      if (done > lastDone) { lastDone = done; progressAt = now(); }
      if (now() - progressAt > stallMs) throw failed(ONLINE_EXPORT_TEXT.nodeStalled(stallMs));
      say({ phase: "rendering", clips: want.length, done, total });
      await sleep(EXPORT_MANIFEST_POLL_MS, signal);
    }
    const coverage = new Map<string, FrameCoverage>();
    for (const id of want) {
      const s = listed.get(id)!;
      coverage.set(id, { clipId: id, plane: s.plane, rect: s.rect, frames: new Set(frames.get(id)!.keys()) });
    }
    const stats = { fetched: 0, bytes: 0 };
    return {
      coverage, stats,
      async dataUrl(clipId, frame, sig) {
        const hash = frames.get(clipId)?.get(frame);
        if (!hash) throw new Error(ONLINE_EXPORT_TEXT.nodeFailed("frame-missing"));
        const base = deps.assetBase();
        if (!base) throw new Error(tr("There is no remote asset service yet"));
        const f = deps.fetch ?? fetch;
        const res = await f(`${base.replace(/\/+$/, "")}/px/${hash}`, { headers: await deps.authHeaders(), signal: sig });
        if (!res.ok) throw new Error(tr("Cannot fetch the frame rendered by the render node {0}: {1}", hash.slice(0, 12), res.status));
        const bytes = new Uint8Array(await res.arrayBuffer());
        stats.fetched++;
        stats.bytes += bytes.length;
        return `data:image/png;base64,${bytesToBase64(bytes)}`;
      },
    };
  } finally {
    throttleRecord.inFlight = false;
    throttleRecord.lastTime = now();
    try { off(); } catch { /* The subscriber is broken */ }
  }
}
