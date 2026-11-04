/**
 * Sound host on the stage side (`docs/plan/online-card-exec-contract.md` 3.5): spawns the sound
 * thread, passes bundles from the editor page for loading, requests sample chunks on behalf of the
 * editor page, and enforces timeouts. **Created only in background stage** (same prerequisite as
 * `stageRuntime.ts`: this page has an isolated environment).
 *
 *   const host = createSoundHost({ spawn: () => Worker bootstrapped from blob URL });
 *   await host.setBundles(bundles from editor page); // Returns: which cards can synthesize audio online, failed entries and reasons
 *   const samples = await host.render({ projectKey, project, nodeId, start, count, sampleRate });
 *   host.dispose();
 *
 * Data flow: editor page → (stage RPC) this host → thread: transpiled bundles, project, node, sample
 * range; thread → this host → editor page: Float32 sample chunks (buffers transferred throughout).
 * Packaging into WAV, uploading, and submitting artifact records all happen on the editor page;
 * read/write tickets never leave the editor page.
 *
 * Time limit: 2 seconds of wall-clock time per second of audio, minimum 10 seconds (`soundTimeoutMs`).
 * When time expires, calls `terminate()` to kill the thread (only way to interrupt an infinite loop),
 * and all in-flight requests fail; next time it is needed, spawns a new one and reloads the bundles
 * on hand. If the same node times out twice consecutively, do not retry (this audio segment is
 * treated as impossible to synthesize online in this session).
 */
import type { CardBundle, LoadResult } from "./protocol.ts";
import type { SoundThreadIn, SoundThreadOut } from "./soundThread.ts";
import { tr } from "../../i18n/index.ts";

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

export interface SoundLoadOutcome {
  results: LoadResult[];
  /** Card IDs that loaded successfully and defined `audio()` */
  audioCards: string[];
  /** Entry key → reason for load failure */
  blocked: Record<string, string>;
}

export interface SoundHostRenderRequest {
  /** Key for this project revision (project is sent to thread only once per key) */
  projectKey: string;
  project: unknown;
  nodeId: string;
  start: number;
  count: number;
  sampleRate: number;
}

export interface SoundHost {
  setBundles(bundles: readonly CardBundle[]): Promise<SoundLoadOutcome>;
  render(request: SoundHostRenderRequest, signal?: AbortSignal): Promise<Float32Array>;
  /** Diagnostics: number of threads spawned, number of timeouts triggered */
  stats(): { spawned: number; timeouts: number; pending: number };
  dispose(): void;
}

export interface SoundHostOptions {
  spawn: () => WorkerLike;
  /** Unit tests replace timing */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** Time limit for this audio chunk (ms): 2s wall clock per second of audio, min 10s [ruling: contract 3.5] */
export const SOUND_WALL_MS_PER_SECOND = 2000;
export const SOUND_MIN_TIMEOUT_MS = 10_000;
export function soundTimeoutMs(count: number, sampleRate: number): number {
  const seconds = sampleRate > 0 ? count / sampleRate : 0;
  return Math.max(SOUND_MIN_TIMEOUT_MS, Math.ceil(seconds * SOUND_WALL_MS_PER_SECOND));
}
/** Time limit to load a set of bundles (transpilation results already in hand, only executing module top level) */
export const SOUND_LOAD_TIMEOUT_MS = 20_000;
/** Stop retrying after this many consecutive timeouts for the same node */
export const SOUND_MAX_TIMEOUTS_PER_NODE = 2;
export const SOUND_TIMEOUT_MESSAGE = tr("Online synthesis of this sound timed out");

interface Pending { resolve: (samples: Float32Array) => void; reject: (err: Error) => void; timer: unknown; nodeId: string; off?: () => void }

export function createSoundHost(opts: SoundHostOptions): SoundHost {
  /*
   * Time limits use real wall-clock time. Stage took over `setTimeout` (virtual clock, does not run
   * when paused, fast-forwards during frame catch-up, `render/virtualTimers.ts`), so by default we use
   * the real timer hook `__pcRealSetTimeout` exposed by stage (same as `gl/glHost.ts`, `playability.ts`);
   * it returns a real id that `clearTimeout` recognizes.
   */
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => ((globalThis as { __pcRealSetTimeout?: typeof setTimeout }).__pcRealSetTimeout ?? setTimeout)(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let worker: WorkerLike | null = null;
  let disposed = false;
  let bundles: readonly CardBundle[] = [];
  /** Signature of the bundle set already loaded (or being loaded) by this thread; reload if different */
  let loadedSig: string | null = null;
  let loading: Promise<SoundLoadOutcome> | null = null;
  let lastOutcome: SoundLoadOutcome = { results: [], audioCards: [], blocked: {} };
  let seq = 0, nextId = 0;
  const loads = new Map<number, { resolve: (o: SoundLoadOutcome) => void; reject: (e: Error) => void; timer: unknown }>();
  const pending = new Map<number, Pending>();
  const sentProjects = new Set<string>();
  const timeoutsOf = new Map<string, number>();
  const counters = { spawned: 0, timeouts: 0 };
  const sigOf = (list: readonly CardBundle[]) => list.map((b) => `${b.entry}\u0000${b.generation}`).sort().join("\u0001");

  function kill(reason: string): void {
    const w = worker;
    worker = null;
    loadedSig = null;
    loading = null;
    sentProjects.clear();
    if (w) { w.onmessage = null; w.onerror = null; try { w.terminate(); } catch { /* Already gone */ } }
    for (const [id, p] of [...pending]) { pending.delete(id); clearTimer(p.timer); p.off?.(); p.reject(new Error(reason)); }
    for (const [id, l] of [...loads]) { loads.delete(id); clearTimer(l.timer); l.reject(new Error(reason)); }
  }

  function onMessage(data: unknown): void {
    const m = data as SoundThreadOut | { t: "ready" } | null;
    if (!m || typeof m !== "object") return;
    if (m.t === "loaded") {
      const l = loads.get(m.seq);
      if (!l) return;
      loads.delete(m.seq);
      clearTimer(l.timer);
      l.resolve({ results: Array.isArray(m.results) ? m.results : [], audioCards: Array.isArray(m.audioCards) ? m.audioCards.filter((x) => typeof x === "string") : [],
        blocked: m.blocked && typeof m.blocked === "object" ? m.blocked : {} });
      return;
    }
    if (m.t === "block" || m.t === "error") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimer(p.timer);
      p.off?.();
      if (m.t === "block" && m.samples instanceof Float32Array) { timeoutsOf.delete(p.nodeId); p.resolve(m.samples); }
      else p.reject(new Error(m.t === "error" ? String(m.message).slice(0, 240) : "The sound thread replied with something that is not a sample chunk"));
    }
  }

  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const w = opts.spawn();
    counters.spawned++;
    w.onmessage = (event) => onMessage(event.data);
    w.onerror = (event) => kill(tr("Sound thread error: {0}", String(event?.message ?? "").slice(0, 120)));
    worker = w;
    return w;
  }

  function load(): Promise<SoundLoadOutcome> {
    const sig = sigOf(bundles);
    if (worker && loadedSig === sig) return loading ?? Promise.resolve(lastOutcome);
    const w = ensureWorker();
    const mySeq = ++seq;
    loadedSig = sig;
    const p = new Promise<SoundLoadOutcome>((resolve, reject) => {
      const timer = setTimer(() => { counters.timeouts++; kill(tr("The sound thread timed out loading the card")); }, SOUND_LOAD_TIMEOUT_MS);
      loads.set(mySeq, { resolve, reject, timer });
      const message: SoundThreadIn = { t: "load", seq: mySeq, bundles: [...bundles] };
      w.postMessage(message);
    }).then((outcome) => {
      if (loadedSig === sig && loading === p) { lastOutcome = outcome; loading = null; }
      return outcome;
    });
    loading = p;
    p.catch(() => undefined);
    return p;
  }

  return {
    setBundles(next) {
      if (disposed) return Promise.reject(new Error("The sound host has already been closed"));
      bundles = [...(next ?? [])];
      return load();
    },
    async render(request, signal) {
      if (disposed) throw new Error("The sound host has already been closed");
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      if ((timeoutsOf.get(request.nodeId) ?? 0) >= SOUND_MAX_TIMEOUTS_PER_NODE) throw new Error(SOUND_TIMEOUT_MESSAGE);
      await load();
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const w = ensureWorker();
      if (!sentProjects.has(request.projectKey)) {
        sentProjects.add(request.projectKey);
        const message: SoundThreadIn = { t: "project", key: request.projectKey, project: request.project };
        w.postMessage(message);
      }
      const id = ++nextId;
      return new Promise<Float32Array>((resolve, reject) => {
        const timer = setTimer(() => {
          counters.timeouts++;
          timeoutsOf.set(request.nodeId, (timeoutsOf.get(request.nodeId) ?? 0) + 1);
          kill(SOUND_TIMEOUT_MESSAGE);
        }, soundTimeoutMs(request.count, request.sampleRate));
        const entry: Pending = { resolve, reject, timer, nodeId: request.nodeId };
        if (signal) {
          // Cancel: computation in thread may be midway with no other way to stop it, so cancel only this
          // request (discard result when it arrives)
          const onAbort = () => { if (!pending.delete(id)) return; clearTimer(timer); reject(new DOMException("aborted", "AbortError")); };
          signal.addEventListener("abort", onAbort, { once: true });
          entry.off = () => signal.removeEventListener("abort", onAbort);
        }
        pending.set(id, entry);
        const message: SoundThreadIn = { t: "render", id, key: request.projectKey, nodeId: request.nodeId, start: request.start, count: request.count, sampleRate: request.sampleRate };
        w.postMessage(message);
      });
    },
    stats: () => ({ spawned: counters.spawned, timeouts: counters.timeouts, pending: pending.size }),
    dispose() {
      disposed = true;
      kill("The sound host has already been closed");
    },
  };
}
