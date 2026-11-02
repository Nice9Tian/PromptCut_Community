/**
 * `glHost`: shared WebGL renderer entry on the stage / export page side (R9 M2 / M3).
 *
 * **`StageView` and `ExportView` each create one upon mounting**: the prerender process loads
 * the export page, and without creating one there is no Worker and gl planes remain permanently
 * empty. It performs four tasks:
 *
 *   1. **Connect the rendering half according to the route** (M2).
 *      - Route 1 `perDocument` (desktop default; export page always uses this): `new Worker` by
 *        itself (module Worker);
 *      - Route 2 `shared` (online page stage gate tiers 1 and 2): wait for port passed from
 *        parent page via `{ type: 'gl-port', stageId, port }`, send and receive the same set of
 *        `beat` / `done` / `layout` / `release` over the port; before receiving it, `beat` queues
 *        and canvas cards are not presented;
 *      - **Capability fallback**: if `webgl2` on `OffscreenCanvas` is unavailable in Worker (or
 *        forced via `?glOffscreen=0`), create a context on the main thread to replace the Worker,
 *        import the same `programs.ts`, with protocol unchanged;
 *      - Only one stage (`compact`) + Route 1 + role `back`: do not start Worker; take the main
 *        thread fallback.
 *      Worker is **lazily created**: created only when canvas cards actually need rendering for
 *      the first time; pure DOM projects start no Worker at all.
 *   2. **`beat`** (M3): read the frame just committed in `glPlanes`; if the active set changed,
 *      send `layout` first, then send `{ type: 'beat', t, cards: [{ clipId, t, params?, reset? }] }`.
 *      Claim a `beginFrameWork('gl')` ticket on each send, and return it upon receiving `done`:
 *      the export page's `__pcFrameReady` / prerender's `waitFrameReady` naturally wait for `done`.
 *   3. **Paste bitmaps**: when `done` arrives, `transferFromImageBitmap` each bitmap to its plane
 *      and write `data-pc-gl-frame`.
 *   4. **`release`**: release this `stageId`'s atlas in the Worker on `setRole('back')`.
 *
 * **Late `done` does not freeze playhead**: tests show occasional 30-84 ms spikes in `beat → done`
 * (spent in Worker's draw / blit stages, main thread not blocked). K4 is inherently "wait on slow
 * frames": tick loop `await`s this tick, shifting timeline overall without dropping frames; but
 * if Worker truly hangs, the loop cannot hang forever: if a live render tick gets no response
 * within 1 s, treat it as unrendered (plane retains the previous frame), and if a strict tick
 * (export, probe, generate snapshots) gets no response within 15 s, fail the ticket and report an
 * explicit export error. Late `done` is dropped directly.
 */

import { beginFrameWork } from "../../kernel/frameReady";
import type { GlBeatCard, GlFromWorker, GlLayoutCard, GlToWorker, GlWorkerDiag } from "./CanvasCardProgram";
import { glPlanes, type GlPlaneEntry } from "./planes";
import type { GlRenderer } from "./renderer";
import { spawnGlWorker } from "./spawnWorker";

export type GlRoute = "perDocument" | "shared";

export interface GlBeatOptions {
  /** Wait for compilation / textures to be ready before rendering (export, probe, generate snapshots, catch-up run settle); default = leave unready cards blank for this tick */
  strict?: boolean;
  /** Also measure GPU time for each card (M4) */
  measure?: boolean;
  /** Global time of this tick (seconds, only included in messages for diagnostics; each card's `t` is always local seconds) */
  t?: number;
}

export interface GlBeatResult {
  seq: number;
  /** `beat → done` round trip (actual wall-clock milliseconds) */
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
  /** Round trips of the last 120 ticks, used by probe to compute quantiles */
  roundTrips: number[];
  lastSkipped: Record<string, string> | null;
  lastGpuMs: Record<string, number> | null;
  portWaitTimeouts: number;
  workerFailed: string | null;
  planes: number;
}

export interface GlHost {
  /** Send a tick. **Returns `null` if no canvas cards need rendering at this moment** (caller does not await, pure DOM projects yield no extra microtask) */
  beat(opts?: GlBeatOptions): Promise<GlBeatResult> | null;
  /** Whether there are attached gl planes at this moment (whether to wait for `done` for them) */
  hasPlanes(): boolean;
  /** Release this `stageId`'s atlas in the Worker (`setRole('back')`) */
  release(): void;
  setRoute(route: GlRoute): void;
  setRole(role: "front" | "back"): void;
  /** Route 2: port handed over from parent page (`null` = parent page cannot start shared Worker, start self) */
  acceptPort(port: MessagePort | null): void;
  diag(): GlHostDiag;
  /** For probe: query rendering half for diagnostics (context count, texture upload count, atlas size) */
  workerDiag(): Promise<GlWorkerDiag | null>;
  dispose(): void;
}

type TransportKind = "worker" | "port" | "main";

interface Transport {
  kind: TransportKind;
  send(msg: GlToWorker, transfer?: Transferable[]): void;
  close(): void;
  /** `init` response: whether it can render */
  ready: Promise<boolean>;
}

/** Live render ticks wait at most this long (actual wall-clock); once exceeded, treat this tick as unrendered, plane retaining the previous frame */
const LIVE_TIMEOUT_MS = 1000;
/** Strict ticks (export, probe) wait at most this long; once exceeded, mark the ticket as failed */
const STRICT_TIMEOUT_MS = 15000;
/** Worker's `init` response waits at most this long; once exceeded, take main thread fallback due to insufficient capability */
const INIT_TIMEOUT_MS = 8000;
/** Route 2 waits for parent page port at most this long; once exceeded, start Worker self (parent page might not have started shared Worker at all) */
const PORT_WAIT_MS = 2000;
/** When cards in a live render tick are not ready yet, send a catch-up tick after this interval */
const PREPARE_RETRY_MS = 40;

const realNow = (): number => (typeof window !== "undefined" && window.__pcRealNow ? window.__pcRealNow() : performance.now());
const realSetTimeout = (cb: () => void, ms: number): number =>
  (typeof window !== "undefined" && window.__pcRealSetTimeout ? window.__pcRealSetTimeout : setTimeout)(cb, ms) as unknown as number;
const realClearTimeout = (id: number) => clearTimeout(id);

/** `?glOffscreen=0`: force `offscreenGl` probe to `false` (acceptance check: canvas cards render on main thread, protocol unchanged) */
export function glOffscreenForcedOff(): boolean {
  try {
    return new URLSearchParams(location.search).get("glOffscreen") === "0";
  } catch {
    return false;
  }
}

export function createGlHost(opts: {
  stageId: string;
  /** Only one stage (online page stage gate stopped at tier 1, lowest tier): atlas is allocated with a smaller limit, background role starts no Worker on Route 1 */
  compact: boolean;
  route: GlRoute;
  /** Do not start Worker; always take the main thread route (export page currently uses this, see description in `ExportView.tsx`) */
  mainThread?: boolean;
}): GlHost {
  const stageId = opts.stageId;
  let route: GlRoute = opts.route;
  let role: "front" | "back" = "front";
  /** Port handed over from parent page; `undefined` = not handed over yet, `null` = parent page says it cannot start */
  let offeredPort: MessagePort | null | undefined;
  let portWaitStarted = 0;
  let portWaitTimedOut = false;
  let workerFailed: string | null = null;
  let transport: Transport | null = null;
  let disposed = false;
  /** Generation of `release`: catch-up ticks (see PREPARE_RETRY_MS) only catch up ticks prior to release; not allowed to rebuild the atlas back after release */
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

  /* ---------------------------------------------------------------- Which route to connect */

  const desired = (): TransportKind | "waiting-port" => {
    if (opts.mainThread || workerFailed || glOffscreenForcedOff()) return "main";
    if (route === "shared" && !portWaitTimedOut) {
      if (offeredPort) return "port";
      if (offeredPort === undefined) return "waiting-port";
      // Parent page explicitly states shared Worker cannot be started: fall back to starting self
    }
    if (route === "perDocument" && opts.compact && role === "back") return "main";
    return "worker";
  };

  const onMessage = (msg: GlFromWorker) => {
    if (msg.type === "done") {
      const p = pending.get(msg.seq);
      if (!p) {
        // Arrived after timeout: discard, release bitmaps
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
          if (!m.ok) workerFailed = m.error || "webgl2 is not available in the Worker";
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
      // Module load failed / Worker crashed: switch to main thread fallback for next tick
      workerFailed = workerFailed ?? (e.message || "GL Worker error");
      if (transport?.kind === "worker") dropTransport();
    });
    const ready = withInit(send, (h) => { worker.onmessage = (e) => h(e.data as GlFromWorker); });
    return { kind: "worker", send, ready, close: () => { try { worker.postMessage({ type: "release", stageId }); } catch { /* Already gone */ } worker.terminate(); } };
  };

  const openPort = (port: MessagePort): Transport => {
    const send: Transport["send"] = (m, t) => port.postMessage(m, t ?? []);
    const ready = withInit(send, (h) => { port.onmessage = (e) => h(e.data as GlFromWorker); port.start(); });
    return {
      kind: "port", send, ready,
      close: () => { try { port.postMessage({ type: "release", stageId }); } catch { /* Port closed */ } port.onmessage = null; port.close(); },
    };
  };

  /** Main thread fallback: same renderer code, same `programs.ts`, messages dispatched locally */
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
    // Port cannot be reused once closed: wait for parent page to hand over a new one (start self if timeout)
    if (t?.kind === "port") { offeredPort = undefined; portWaitStarted = 0; }
    lastLayoutKey = "";
    lastRows.clear();
    lastSent.clear();
    for (const [s, p] of [...pending]) { pending.delete(s); p.resolve(null); }
    t?.close();
  }

  /** Connect to the appropriate route; returns null when `waiting-port` */
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

  /* ---------------------------------------------------------------- One tick */

  const planes = (): GlPlaneEntry[] => [...glPlanes.values()].filter((e) => e.canvas.isConnected);

  const rowKey = (e: GlPlaneEntry) => `${e.programId}|${e.kind}|${e.w}x${e.h}|${e.textures.map((t) => `${t.name}=${t.url}`).join(",")}|${JSON.stringify(e.stage)}`;

  const doBeat = async (o: GlBeatOptions, ticket: ReturnType<typeof beginFrameWork>): Promise<GlBeatResult> => {
    const empty: GlBeatResult = { seq: 0, roundTripMs: 0, cards: 0 };
    try {
      let t = connect();
      if (!t) {
        // Route 2 port has not arrived yet: live render ticks do not wait (canvas cards not presented);
        // strict ticks wait for port, and start self if not received
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
        // Insufficient capability: discard this route and retry with main thread fallback
        if (t.kind !== "main") {
          workerFailed = workerFailed ?? "GL Worker initialization failed";
          dropTransport();
          t = connect();
          if (!t || !(await t.ready)) { ticket.ready(); return { ...empty, error: "No WebGL2 available" }; }
        } else {
          ticket.ready();
          return { ...empty, error: "WebGL2 is not available on the main thread either" };
        }
      }
      if (transport !== t) { ticket.ready(); return empty; }

      /* layout: sent only when active set changes (includes suppressed / snapshot-pasted cards; they just do not render for this tick) */
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

      /* beat: only omit cards that are "in suppressed" and "in snapshots and not in settling" (skip) */
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
        if (o.strict) ticket.fail(new Error(`GL Worker did not reply done within ${STRICT_TIMEOUT_MS} ms`));
        else ticket.ready();
        return { seq: mySeq, roundTripMs, cards: cards.length, timedOut: true };
      }
      if (!done) { ticket.ready(); return { seq: mySeq, roundTripMs, cards: cards.length, error: "transport-closed" }; }
      /* Paste bitmaps: paste only if later than the already pasted tick */
      if (mySeq >= appliedSeq) {
        appliedSeq = mySeq;
        for (const [clipId, bm] of done.bitmaps) {
          const e = glPlanes.get(clipId);
          if (!e || !e.canvas.isConnected) { bm.close(); continue; }
          const ctx = e.canvas.getContext("bitmaprenderer");
          if (!ctx) { bm.close(); continue; }
          ctx.transferFromImageBitmap(bm);
          // Generate snapshots verifies against it: same formula as `data-pc-local-frame` on the wrapper layer (M4)
          e.canvas.setAttribute("data-pc-gl-frame", String(frames.get(clipId)));
        }
      } else {
        for (const bm of done.bitmaps.values()) bm.close();
      }
      stats.lastSkipped = done.skipped ?? null;
      stats.lastGpuMs = done.gpuMs ?? null;
      /*
       * When cards in a live render tick are still compiling / decoding textures (this tick is left
       * blank, that layer transparent): a paused stage will not receive another tick, so it issues
       * a catch-up tick after an interval until all are rendered. During playback, the next tick
       * arrives anyway, so this catch-up tick gets merged.
       */
      if (!o.strict && Object.values(done.skipped ?? {}).includes("preparing")) {
        const gen = releaseGen;
        realSetTimeout(() => { if (!inflight && !disposed && gen === releaseGen) void beat({ t: o.t }); }, PREPARE_RETRY_MS);
      }
      if (done.error === "context-lost") dropTransport();
      const hardErrors = Object.entries(done.skipped ?? {}).filter(([, why]) => why !== "preparing");
      if (o.strict && (done.error || hardErrors.length)) {
        ticket.fail(new Error(`canvas card failed to render: ${done.error ?? hardErrors.map(([id, why]) => `${id}: ${why}`).join("; ")}`));
      } else {
        ticket.ready();
      }
      return { seq: mySeq, roundTripMs, cards: cards.length, gpuMs: done.gpuMs, skipped: done.skipped, error: done.error };
    } catch (e) {
      ticket.fail(e);
      return { ...empty, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /* Only one tick in flight at a time; those arriving while in flight are merged into "send another tick after flight completes", reading glPlanes at that time */
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
      // Active set is empty: notify the rendering half (release atlas, scene), but does not count as a tick
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
      // Already using its own Worker (waiting for port timed out): switch back to the shared one
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
