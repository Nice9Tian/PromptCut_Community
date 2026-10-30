/**
 * `glHost`:舞台 / 导出页这一侧的共享 WebGL 渲染器入口(R9 M2 / M3)。
 *
 * **`StageView` 和 `ExportView` 挂载时都建一个**:预渲染进程加载的是导出页,不建就没有 Worker、
 * gl 平面永远是空的。它做四件事:
 *
 *   1. **按路线接上画的那一半**(M2)。
 *      - 路线 1 `perDocument`(桌面默认;导出页永远走这条):自己 `new Worker`(模块 Worker);
 *      - 路线 2 `shared`(在线页面舞台闸门第一、二级):等父页经 `{ type: 'gl-port', stageId, port }` 交来的端口,
 *        在端口上收发同一套 `beat` / `done` / `layout` / `release`;收到之前 `beat` 排队、不呈现 canvas 卡;
 *      - **能力退路**:Worker 里拿不到 `OffscreenCanvas` 的 `webgl2`(或 `?glOffscreen=0` 强制)就在主线程
 *        建一个上下文顶替 Worker,import 同一张 `programs.ts`,协议不变;
 *      - 只有一个舞台(`compact`)+ 路线 1 + 角色 `back`:不开 Worker,走主线程退路。
 *      Worker **懒建**:第一次真有 canvas 卡要画才建,纯 DOM 的项目一个 Worker 都不开。
 *   2. **`beat`**(M3):读 `glPlanes` 里刚提交的那一帧,活跃集合变了先发 `layout`,再发
 *      `{ type: 'beat', t, cards: [{ clipId, t, params?, reset? }] }`。每发一次领一张 `beginFrameWork('gl')`
 *      的票、收到 `done` 再还 —— 导出页的 `__pcFrameReady` / 预渲染的 `waitFrameReady` 天然把 `done` 等进来。
 *   3. **贴位图**:`done` 到了把每张位图 `transferFromImageBitmap` 到它的平面,写 `data-pc-gl-frame`。
 *   4. **`release`**:`setRole('back')` 时放掉这个 `stageId` 在 Worker 里的那份图集。
 *
 * **`done` 晚到不冻播放头**:实测 `beat → done` 偶有 30～84 ms 的尖峰(耗在 Worker 的画 / blit 段,
 * 主线程不堵)。K4 本来就是「慢帧就等」:节拍循环 `await` 这一拍,时间轴整体后移,不跳帧;
 * 但 Worker 真卡死了也不能让循环永远挂着 —— 活渲的拍 1 秒没回就当这一拍没画(平面留上一张),
 * 严格的拍(导出、探针、生成快照)15 秒没回就把票判失败,让导出明确报错。晚到的 `done` 直接丢掉。
 */

import { beginFrameWork } from "../../kernel/frameReady";
import type { GlBeatCard, GlFromWorker, GlLayoutCard, GlToWorker, GlWorkerDiag } from "./CanvasCardProgram";
import { glPlanes, type GlPlaneEntry } from "./planes";
import type { GlRenderer } from "./renderer";
import { spawnGlWorker } from "./spawnWorker";

export type GlRoute = "perDocument" | "shared";

export interface GlBeatOptions {
  /** 等编译 / 纹理就绪再画(导出、探针、生成快照、补跑落定);缺省 = 没好的卡这一拍留空 */
  strict?: boolean;
  /** 顺带量每张卡的 GPU 时间(M4) */
  measure?: boolean;
  /** 这一拍的全局时刻(秒,只进消息给诊断看;每张卡的 `t` 一律是本地秒) */
  t?: number;
}

export interface GlBeatResult {
  seq: number;
  /** `beat → done` 往返(真墙钟毫秒) */
  roundTripMs: number;
  cards: number;
  gpuMs?: Record<string, number>;
  skipped?: Record<string, string>;
  timedOut?: boolean;
  error?: string;
}

export interface GlHostDiag {
  mode: TransportKind | "idle" | "waiting-port" | "none";
  route: GlRoute;
  role: "front" | "back";
  stageId: string;
  beats: number;
  layouts: number;
  releases: number;
  timeouts: number;
  lastRoundTripMs: number;
  maxRoundTripMs: number;
  /** 最近 120 拍的往返,探针算分位数用 */
  roundTrips: number[];
  lastSkipped: Record<string, string> | null;
  lastGpuMs: Record<string, number> | null;
  portWaitTimeouts: number;
  workerFailed: string | null;
  planes: number;
}

export interface GlHost {
  /** 发一拍。**这一刻没有 canvas 卡要画就回 `null`**(调用方不用 await,纯 DOM 的项目不多让一次微任务) */
  beat(opts?: GlBeatOptions): Promise<GlBeatResult> | null;
  /** 此刻有没有挂着的 gl 平面(要不要为它等 `done`) */
  hasPlanes(): boolean;
  /** 放掉这个 `stageId` 在 Worker 里的那份图集(`setRole('back')`) */
  release(): void;
  setRoute(route: GlRoute): void;
  setRole(role: "front" | "back"): void;
  /** 路线 2:父页交来的端口(`null` = 父页那边开不了共享 Worker,自己开) */
  acceptPort(port: MessagePort | null): void;
  diag(): GlHostDiag;
  /** 探针用:问画的那一半要诊断(上下文数、纹理上传次数、图集尺寸) */
  workerDiag(): Promise<GlWorkerDiag | null>;
  dispose(): void;
}

type TransportKind = "worker" | "port" | "main";

interface Transport {
  kind: TransportKind;
  send(msg: GlToWorker, transfer?: Transferable[]): void;
  close(): void;
  /** `init` 的回包:能不能画 */
  ready: Promise<boolean>;
}

/** 活渲的拍最多等这么久(真墙钟);过了当这一拍没画,平面留上一张 */
const LIVE_TIMEOUT_MS = 1000;
/** 严格的拍(导出、探针)最多等这么久;过了把票判失败 */
const STRICT_TIMEOUT_MS = 15000;
/** Worker 的 `init` 回包最多等这么久;过了按能力不足走主线程退路 */
const INIT_TIMEOUT_MS = 8000;
/** 路线 2 等父页端口最多这么久;过了自己开 Worker(父页也许根本没开共享 Worker) */
const PORT_WAIT_MS = 2000;
/** 活渲的拍里有卡还没准备好时,隔这么久补一拍 */
const PREPARE_RETRY_MS = 40;

const realNow = (): number => (typeof window !== "undefined" && window.__pcRealNow ? window.__pcRealNow() : performance.now());
const realSetTimeout = (cb: () => void, ms: number): number =>
  (typeof window !== "undefined" && window.__pcRealSetTimeout ? window.__pcRealSetTimeout : setTimeout)(cb, ms) as unknown as number;
const realClearTimeout = (id: number) => clearTimeout(id);

/** `?glOffscreen=0`:把 `offscreenGl` 探测强制为 `false`(验收:canvas 卡在主线程画、协议不变) */
export function glOffscreenForcedOff(): boolean {
  try {
    return new URLSearchParams(location.search).get("glOffscreen") === "0";
  } catch {
    return false;
  }
}

export function createGlHost(opts: {
  stageId: string;
  /** 只有一个舞台(在线页面舞台闸门停在第一级、最低一档):图集按小的上限开,后台角色走路线 1 时不开 Worker */
  compact: boolean;
  route: GlRoute;
  /** 不开 Worker,一律走主线程那条(导出页现在用它,见 `ExportView.tsx` 的说明) */
  mainThread?: boolean;
}): GlHost {
  const stageId = opts.stageId;
  let route: GlRoute = opts.route;
  let role: "front" | "back" = "front";
  /** 父页交来的端口;`undefined` = 还没交,`null` = 父页说开不了 */
  let offeredPort: MessagePort | null | undefined;
  let portWaitStarted = 0;
  let portWaitTimedOut = false;
  let workerFailed: string | null = null;
  let transport: Transport | null = null;
  let disposed = false;
  /** `release` 的代数:补拍(见 PREPARE_RETRY_MS)只补释放之前那一拍的,释放之后不许它把图集又建回来 */
  let releaseGen = 0;

  let seq = 0;
  let appliedSeq = 0;
  let lastLayoutKey = "";
  const lastRows = new Map<string, string>();
  const lastSent = new Map<string, { t: number; gen: number; paramsKey: string }>();
  const pending = new Map<number, { resolve: (d: Extract<GlFromWorker, { type: "done" }> | null) => void }>();
  const diagWaiters = new Map<number, (d: GlWorkerDiag | null) => void>();
  let diagSeq = 0;

  const stats = {
    beats: 0, layouts: 0, releases: 0, timeouts: 0, lastRoundTripMs: 0, maxRoundTripMs: 0,
    roundTrips: [] as number[], lastSkipped: null as Record<string, string> | null, lastGpuMs: null as Record<string, number> | null,
    portWaitTimeouts: 0,
  };

  /* ---------------------------------------------------------------- 接哪条路 */

  const desired = (): TransportKind | "waiting-port" => {
    if (opts.mainThread || workerFailed || glOffscreenForcedOff()) return "main";
    if (route === "shared" && !portWaitTimedOut) {
      if (offeredPort) return "port";
      if (offeredPort === undefined) return "waiting-port";
      // 父页明说开不了共享 Worker:退回自己开
    }
    if (route === "perDocument" && opts.compact && role === "back") return "main";
    return "worker";
  };

  const onMessage = (msg: GlFromWorker) => {
    if (msg.type === "done") {
      const p = pending.get(msg.seq);
      if (!p) {
        // 超时之后才到的:丢掉,位图放掉
        for (const bm of msg.bitmaps.values()) bm.close();
        return;
      }
      pending.delete(msg.seq);
      p.resolve(msg);
    } else if (msg.type === "diag") {
      const w = diagWaiters.get(msg.seq);
      if (w) { diagWaiters.delete(msg.seq); w(msg.diag); }
    }
  };

  const withInit = (send: Transport["send"], listen: (h: (m: GlFromWorker) => void) => void): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = realSetTimeout(() => { if (!settled) { settled = true; resolve(false); } }, INIT_TIMEOUT_MS);
      listen((m) => {
        if (m.type === "ready" && !settled) {
          settled = true;
          realClearTimeout(timer);
          if (!m.ok) workerFailed = m.error || "Worker 里拿不到 webgl2";
          resolve(m.ok);
          return;
        }
        onMessage(m);
      });
      send({ type: "init", compact: opts.compact });
    });

  const openWorker = (): Transport => {
    let worker: Worker;
    try {
      worker = spawnGlWorker();
    } catch (e) {
      workerFailed = e instanceof Error ? e.message : String(e);
      return openMain();
    }
    const send: Transport["send"] = (m, t) => worker.postMessage(m, t ?? []);
    worker.addEventListener("error", (e) => {
      // 模块加载失败 / Worker 崩了:下一拍改走主线程退路
      workerFailed = workerFailed ?? (e.message || "GL Worker 出错");
      if (transport?.kind === "worker") dropTransport();
    });
    const ready = withInit(send, (h) => { worker.onmessage = (e) => h(e.data as GlFromWorker); });
    return { kind: "worker", send, ready, close: () => { try { worker.postMessage({ type: "release", stageId }); } catch { /* 已经没了 */ } worker.terminate(); } };
  };

  const openPort = (port: MessagePort): Transport => {
    const send: Transport["send"] = (m, t) => port.postMessage(m, t ?? []);
    const ready = withInit(send, (h) => { port.onmessage = (e) => h(e.data as GlFromWorker); port.start(); });
    return {
      kind: "port", send, ready,
      close: () => { try { port.postMessage({ type: "release", stageId }); } catch { /* 端口已关 */ } port.onmessage = null; port.close(); },
    };
  };

  /** 主线程退路:同一份渲染器代码、同一张 `programs.ts`,消息在本地派发 */
  const openMain = (): Transport => {
    let renderer: GlRenderer | null = null;
    const loading = Promise.all([import("./renderer"), import("./programs")]).then(([r, p]) => {
      renderer = r.createGlRenderer({ compact: opts.compact, programOf: p.programOf, canvas: typeof OffscreenCanvas !== "undefined" ? undefined : document.createElement("canvas") });
      return renderer.ok;
    }).catch(() => false);
    const send: Transport["send"] = (m) => {
      void loading.then(() => {
        const r = renderer;
        if (!r) return;
        if (m.type === "layout") onMessage(r.layout(stageId, m.cards));
        else if (m.type === "beat") void r.beat({ ...m, stageId }).then(({ msg }) => onMessage(msg), (e) => onMessage({ type: "done", stageId, seq: m.seq, t: m.t, bitmaps: new Map(), error: String(e) }));
        else if (m.type === "release") r.release(stageId);
        else if (m.type === "diag") onMessage({ type: "diag", stageId, seq: m.seq, diag: r.diag() });
      });
    };
    return { kind: "main", send, ready: loading, close: () => { renderer?.release(stageId); renderer = null; } };
  };

  function dropTransport() {
    const t = transport;
    transport = null;
    // 端口关了就不能再用:等父页交新的(等不到就自己开)
    if (t?.kind === "port") { offeredPort = undefined; portWaitStarted = 0; }
    lastLayoutKey = "";
    lastRows.clear();
    lastSent.clear();
    for (const [s, p] of [...pending]) { pending.delete(s); p.resolve(null); }
    t?.close();
  }

  /** 接上该接的那条路;`waiting-port` 时回 null */
  const connect = (): Transport | null => {
    const want = desired();
    if (want === "waiting-port") {
      if (!portWaitStarted) {
        portWaitStarted = realNow();
        realSetTimeout(() => {
          if (offeredPort === undefined && route === "shared") {
            portWaitTimedOut = true;
            stats.portWaitTimeouts++;
          }
        }, PORT_WAIT_MS);
      }
      return null;
    }
    if (transport && transport.kind === want) return transport;
    if (transport) dropTransport();
    transport = want === "port" ? openPort(offeredPort!) : want === "main" ? openMain() : openWorker();
    return transport;
  };

  /* ---------------------------------------------------------------- 一拍 */

  const planes = (): GlPlaneEntry[] => [...glPlanes.values()].filter((e) => e.canvas.isConnected);

  const rowKey = (e: GlPlaneEntry) => `${e.programId}|${e.kind}|${e.w}x${e.h}|${e.textures.map((t) => `${t.name}=${t.url}`).join(",")}|${JSON.stringify(e.stage)}`;

  const doBeat = async (o: GlBeatOptions, ticket: ReturnType<typeof beginFrameWork>): Promise<GlBeatResult> => {
    const empty: GlBeatResult = { seq: 0, roundTripMs: 0, cards: 0 };
    try {
      let t = connect();
      if (!t) {
        // 路线 2 端口还没到:活渲的拍不等(不呈现 canvas 卡);严格的拍等端口,等不到就自己开
        if (!o.strict) { ticket.ready(); return { ...empty, skipped: { "*": "waiting-port" } }; }
        const until = realNow() + PORT_WAIT_MS + 50;
        while (!t && realNow() < until) {
          await new Promise<void>((r) => realSetTimeout(r, 20));
          t = connect();
        }
        if (!t) { portWaitTimedOut = true; t = connect(); }
        if (!t) { ticket.ready(); return empty; }
      }
      const ok = await t.ready;
      if (!ok) {
        // 能力不足:丢掉这条路,换主线程退路再来一次
        if (t.kind !== "main") {
          workerFailed = workerFailed ?? "GL Worker 初始化失败";
          dropTransport();
          t = connect();
          if (!t || !(await t.ready)) { ticket.ready(); return { ...empty, error: "没有可用的 WebGL2" }; }
        } else {
          ticket.ready();
          return { ...empty, error: "主线程也拿不到 WebGL2" };
        }
      }
      if (transport !== t) { ticket.ready(); return empty; }

      /* layout:活跃集合(含被抑制 / 贴快照的卡,它们只是这一拍不画)变了才发 */
      const all = planes();
      const rows: GlLayoutCard[] = all.map((e) => ({ clipId: e.clipId, programId: e.programId, kind: e.kind, w: e.w, h: e.h, textures: e.textures, stage: e.stage }));
      const layoutKey = all.map((e) => `${e.clipId}:${rowKey(e)}`).sort().join("\n");
      if (layoutKey !== lastLayoutKey) {
        const next = new Map(all.map((e) => [e.clipId, rowKey(e)] as const));
        for (const id of [...lastSent.keys()]) if (lastRows.get(id) !== next.get(id)) lastSent.delete(id);
        lastRows.clear();
        for (const [k, v] of next) lastRows.set(k, v);
        lastLayoutKey = layoutKey;
        t.send({ type: "layout", stageId, cards: rows });
        stats.layouts++;
      }

      /* beat:只剔「在 suppressed 里」和「在 snapshots 里且不在 settling 里」的卡(skip) */
      const draw = all.filter((e) => !e.skip);
      if (!draw.length) { ticket.ready(); return empty; }
      const cards: GlBeatCard[] = draw.map((e) => {
        const last = lastSent.get(e.clipId);
        const card: GlBeatCard = { clipId: e.clipId, t: e.t };
        if (last && (last.gen !== e.gen || e.t < last.t - 1e-9)) card.reset = true;
        if (!last || last.paramsKey !== e.paramsKey) card.params = e.params;
        lastSent.set(e.clipId, { t: e.t, gen: e.gen, paramsKey: e.paramsKey });
        return card;
      });
      const frames = new Map(draw.map((e) => [e.clipId, e.frame] as const));
      const mySeq = ++seq;
      const sentAt = realNow();
      const beatMsg: GlToWorker = { type: "beat", stageId, seq: mySeq, t: o.t ?? 0, cards, strict: !!o.strict, measure: !!o.measure };
      const sleepMs = typeof window !== "undefined" ? Number((window as unknown as { __pcGlDebugSleepMs?: number }).__pcGlDebugSleepMs) || 0 : 0;
      if (sleepMs > 0 && beatMsg.type === "beat") beatMsg.debugSleepMs = sleepMs;
      const done = await new Promise<Extract<GlFromWorker, { type: "done" }> | null | "timeout">((resolve) => {
        const timer = realSetTimeout(() => {
          if (!pending.has(mySeq)) return;
          pending.delete(mySeq);
          resolve("timeout");
        }, o.strict ? STRICT_TIMEOUT_MS : LIVE_TIMEOUT_MS);
        pending.set(mySeq, { resolve: (d) => { realClearTimeout(timer); resolve(d); } });
        t!.send(beatMsg);
      });
      const roundTripMs = realNow() - sentAt;
      stats.beats++;
      stats.lastRoundTripMs = roundTripMs;
      stats.maxRoundTripMs = Math.max(stats.maxRoundTripMs, roundTripMs);
      stats.roundTrips.push(roundTripMs);
      if (stats.roundTrips.length > 120) stats.roundTrips.shift();
      if (done === "timeout") {
        stats.timeouts++;
        if (o.strict) ticket.fail(new Error(`GL Worker ${STRICT_TIMEOUT_MS} ms 没回 done`));
        else ticket.ready();
        return { seq: mySeq, roundTripMs, cards: cards.length, timedOut: true };
      }
      if (!done) { ticket.ready(); return { seq: mySeq, roundTripMs, cards: cards.length, error: "transport-closed" }; }
      /* 贴位图:晚于已贴那一拍的才贴 */
      if (mySeq >= appliedSeq) {
        appliedSeq = mySeq;
        for (const [clipId, bm] of done.bitmaps) {
          const e = glPlanes.get(clipId);
          if (!e || !e.canvas.isConnected) { bm.close(); continue; }
          const ctx = e.canvas.getContext("bitmaprenderer");
          if (!ctx) { bm.close(); continue; }
          ctx.transferFromImageBitmap(bm);
          // 生成快照按它核对:和包裹层的 `data-pc-local-frame` 同一个算式(M4)
          e.canvas.setAttribute("data-pc-gl-frame", String(frames.get(clipId)));
        }
      } else {
        for (const bm of done.bitmaps.values()) bm.close();
      }
      stats.lastSkipped = done.skipped ?? null;
      stats.lastGpuMs = done.gpuMs ?? null;
      /*
       * 活渲的拍里有卡还在编译 / 解码纹理(这一拍留空、那一层透明):暂停着的舞台不会再来下一拍,
       * 所以这里自己隔一会儿补一拍,直到都画出来。播放中下一拍本来就会来,补的这一拍被合并掉。
       */
      if (!o.strict && Object.values(done.skipped ?? {}).includes("preparing")) {
        const gen = releaseGen;
        realSetTimeout(() => { if (!inflight && !disposed && gen === releaseGen) void beat({ t: o.t }); }, PREPARE_RETRY_MS);
      }
      if (done.error === "context-lost") dropTransport();
      const hardErrors = Object.entries(done.skipped ?? {}).filter(([, why]) => why !== "preparing");
      if (o.strict && (done.error || hardErrors.length)) {
        ticket.fail(new Error(`canvas 卡没画出来:${done.error ?? hardErrors.map(([id, why]) => `${id}: ${why}`).join("; ")}`));
      } else {
        ticket.ready();
      }
      return { seq: mySeq, roundTripMs, cards: cards.length, gpuMs: done.gpuMs, skipped: done.skipped, error: done.error };
    } catch (e) {
      ticket.fail(e);
      return { ...empty, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /* 一次只有一拍在飞;飞着的时候再来的合并成「飞完之后再发一拍」,读那时候的 glPlanes */
  let inflight: Promise<GlBeatResult> | null = null;
  let queued: { opts: GlBeatOptions; promise: Promise<GlBeatResult>; ticket: ReturnType<typeof beginFrameWork> } | null = null;

  const run = (o: GlBeatOptions, ticket: ReturnType<typeof beginFrameWork>): Promise<GlBeatResult> => {
    const p = doBeat(o, ticket).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  };

  const beat = (o: GlBeatOptions = {}): Promise<GlBeatResult> | null => {
    if (disposed) return null;
    const any = planes().length > 0;
    if (!any) {
      // 活跃集合空了:告诉画的那一半(放掉图集、场景),但不算一拍
      if (lastLayoutKey && transport) {
        lastLayoutKey = "";
        lastRows.clear();
        lastSent.clear();
        transport.send({ type: "layout", stageId, cards: [] });
        stats.layouts++;
      }
      return null;
    }
    if (inflight) {
      if (queued) {
        queued.opts = { strict: queued.opts.strict || o.strict, measure: queued.opts.measure || o.measure, t: o.t ?? queued.opts.t };
        return queued.promise;
      }
      const ticket = beginFrameWork("gl");
      const entry = { opts: o, ticket, promise: null as unknown as Promise<GlBeatResult> };
      entry.promise = inflight.then(() => {
        if (queued === entry) queued = null;
        return run(entry.opts, entry.ticket);
      });
      queued = entry;
      return entry.promise;
    }
    return run(o, beginFrameWork("gl"));
  };

  return {
    beat,
    hasPlanes: () => planes().length > 0,
    release() {
      releaseGen++;
      if (!transport) return;
      transport.send({ type: "release", stageId });
      stats.releases++;
      lastLayoutKey = "";
      lastRows.clear();
      lastSent.clear();
    },
    setRoute(next) {
      if (next === route) return;
      route = next;
      portWaitStarted = 0;
      portWaitTimedOut = false;
      if (transport && desired() !== transport.kind) dropTransport();
    },
    setRole(next) {
      if (next === role) return;
      role = next;
      if (transport && desired() !== transport.kind && desired() !== "waiting-port") dropTransport();
    },
    acceptPort(port) {
      if (transport?.kind === "port") dropTransport();
      else if (offeredPort && offeredPort !== port) offeredPort.close();
      offeredPort = port;
      portWaitTimedOut = false;
      portWaitStarted = 0;
      // 已经在用自己的 Worker(等端口超时了):换回共享的那一个
      if (route === "shared" && transport && port) dropTransport();
    },
    diag() {
      const d = desired();
      return {
        mode: transport ? transport.kind : d === "waiting-port" ? "waiting-port" : "idle",
        route, role, stageId,
        beats: stats.beats, layouts: stats.layouts, releases: stats.releases, timeouts: stats.timeouts,
        lastRoundTripMs: stats.lastRoundTripMs, maxRoundTripMs: stats.maxRoundTripMs, roundTrips: [...stats.roundTrips],
        lastSkipped: stats.lastSkipped, lastGpuMs: stats.lastGpuMs,
        portWaitTimeouts: stats.portWaitTimeouts, workerFailed,
        planes: planes().length,
      };
    },
    workerDiag() {
      const t = transport;
      if (!t) return Promise.resolve(null);
      const id = ++diagSeq;
      return new Promise((resolve) => {
        diagWaiters.set(id, resolve);
        realSetTimeout(() => { if (diagWaiters.delete(id)) resolve(null); }, 3000);
        t.send({ type: "diag", stageId, seq: id });
      });
    },
    dispose() {
      disposed = true;
      dropTransport();
      offeredPort?.close();
    },
  };
}
