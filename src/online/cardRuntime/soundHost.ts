/**
 * 舞台这一侧的声音宿主(`docs/plan/online-card-exec-contract.md` 3.5):起声音线程、把编辑页面发来的包交给它载入、
 * 替编辑页面向它要采样块、掐超时。**只在后台舞台里建**(与 `stageRuntime.ts` 同一个前提:本页有隔离环境)。
 *
 *   const host = createSoundHost({ spawn: () => 从 blob 地址引导的 Worker });
 *   await host.setBundles(编辑页面发来的包);      // 回:哪些卡的声音能在线合成、哪些入口不成与原因
 *   const samples = await host.render({ projectKey, project, nodeId, start, count, sampleRate });
 *   host.dispose();
 *
 * 数据流:编辑页面 →(舞台 RPC)本宿主 → 线程:转译好的包、项目、节点、采样范围;线程 → 本宿主 → 编辑页面:Float32 采样块
 * (缓冲区一路转移)。打包成 WAV、上传、提交产物记录都在编辑页面,读写票据不出编辑页面。
 *
 * 时限:每秒声音给 2 秒墙钟,最少 10 秒(`soundTimeoutMs`)。到时 `terminate()` 掐掉线程(死循环只有这样掐得断),
 * 在途的请求全部失败;下一次要用时重新起一个、把手里的包重新载入。同一个节点连着两次超时就不再试(本次会话里这段声音
 * 按在线合成不了处理)。
 */
import type { CardBundle, LoadResult } from "./protocol.ts";
import type { SoundThreadIn, SoundThreadOut } from "./soundThread.ts";

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

export interface SoundLoadOutcome {
  results: LoadResult[];
  /** 载入成功、写了 `audio()` 的卡片 id */
  audioCards: string[];
  /** 入口键 → 载入不成的原因 */
  blocked: Record<string, string>;
}

export interface SoundHostRenderRequest {
  /** 这一版项目的键(同一个键只把项目发给线程一次) */
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
  /** 诊断:起过几次线程、掐过几次超时 */
  stats(): { spawned: number; timeouts: number; pending: number };
  dispose(): void;
}

export interface SoundHostOptions {
  spawn: () => WorkerLike;
  /** 单测换掉计时 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** 这一块声音的时限(毫秒):每秒声音 2 秒墙钟,最少 10 秒〔裁:契约 3.5〕 */
export const SOUND_WALL_MS_PER_SECOND = 2000;
export const SOUND_MIN_TIMEOUT_MS = 10_000;
export function soundTimeoutMs(count: number, sampleRate: number): number {
  const seconds = sampleRate > 0 ? count / sampleRate : 0;
  return Math.max(SOUND_MIN_TIMEOUT_MS, Math.ceil(seconds * SOUND_WALL_MS_PER_SECOND));
}
/** 载入一组包的时限(转译结果已在手,只是执行模块顶层) */
export const SOUND_LOAD_TIMEOUT_MS = 20_000;
/** 同一个节点连着超时这么多次就不再试 */
export const SOUND_MAX_TIMEOUTS_PER_NODE = 2;
export const SOUND_TIMEOUT_MESSAGE = "这段声音在线合成超时";

interface Pending { resolve: (samples: Float32Array) => void; reject: (err: Error) => void; timer: unknown; nodeId: string; off?: () => void }

export function createSoundHost(opts: SoundHostOptions): SoundHost {
  /*
   * 时限按真墙钟算。舞台接管了 `setTimeout`(虚拟时钟,暂停时不走、追帧时快进,`render/virtualTimers.ts`),
   * 所以缺省走舞台留的真计时口子 `__pcRealSetTimeout`(同 `gl/glHost.ts`、`playability.ts`);它回的是真 id,`clearTimeout` 认得。
   */
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => ((globalThis as { __pcRealSetTimeout?: typeof setTimeout }).__pcRealSetTimeout ?? setTimeout)(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let worker: WorkerLike | null = null;
  let disposed = false;
  let bundles: readonly CardBundle[] = [];
  /** 这个线程已经载入(或正在载入)的那一组包的签名;不同就要重新载入 */
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
    if (w) { w.onmessage = null; w.onerror = null; try { w.terminate(); } catch { /* 已经没了 */ } }
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
      else p.reject(new Error(m.t === "error" ? String(m.message).slice(0, 240) : "声音线程回的不是采样块"));
    }
  }

  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const w = opts.spawn();
    counters.spawned++;
    w.onmessage = (event) => onMessage(event.data);
    w.onerror = (event) => kill(`声音线程出错:${String(event?.message ?? "").slice(0, 120)}`);
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
      const timer = setTimer(() => { counters.timeouts++; kill("声音线程载入卡片超时"); }, SOUND_LOAD_TIMEOUT_MS);
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
      if (disposed) return Promise.reject(new Error("声音宿主已经关了"));
      bundles = [...(next ?? [])];
      return load();
    },
    async render(request, signal) {
      if (disposed) throw new Error("声音宿主已经关了");
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
          // 取消:线程里可能正算到一半,没有别的办法让它停,只把这一个请求撤了(结果到了丢掉)
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
      kill("声音宿主已经关了");
    },
  };
}
