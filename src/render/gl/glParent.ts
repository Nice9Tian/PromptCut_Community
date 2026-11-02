/**
 * Parent page side of Route 2 (`shared`) (R9 M2): editor document calls `new Worker` **once**,
 * holding the sole context and atlas, opens a `MessageChannel` for each stage iframe, handing
 * `port2` to the Worker and forwarding `port1` into the stage (`MessagePort` can be transferred
 * across origins; the two stage iframes are cross-origin).
 *
 * **Port transfer protocol**: after receiving `pc-stage-ready` from that stage and before sending
 * any RPC, parent page first sends `postMessage({ type: 'gl-port', stageId, port }, [port])`;
 * before receiving it, stage's `glHost` queues `beat` and does not present canvas cards. Under
 * Route 1, this message is not sent. When parent page side cannot start a shared Worker, it sends
 * `port: null`, and stage starts one itself.
 *
 * Cost (as stated in semantics): GL thread resides in the editor process (independent thread,
 * not touching main thread); stage process isolation does not hold for it. Export page has no
 * parent page in the prerender process, always uses Route 1, and is irrelevant here.
 */
import type { GlFromWorker, GlWorkerDiag } from "./CanvasCardProgram";
import { spawnGlWorker } from "./spawnWorker";

export interface SharedGl {
  /** Open a channel for this stage and pass the port over (same stageId again = that iframe reloaded, old channel invalidated) */
  connect(win: Window, targetOrigin: string, stageId: string): void;
  /** For probe: diagnostics on the shared Worker side */
  diag(): Promise<GlWorkerDiag | null>;
  dispose(): void;
}

export function createSharedGl(opts: { compact: boolean }): SharedGl {
  let worker: Worker | null = null;
  let failed = false;
  let diagSeq = 0;
  const diagWaiters = new Map<number, (d: GlWorkerDiag | null) => void>();
  const ensure = (): Worker | null => {
    if (worker || failed) return worker;
    try {
      worker = spawnGlWorker();
    } catch {
      failed = true;
      return null;
    }
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as GlFromWorker;
      if (m.type === "ready" && !m.ok) failed = true;
      if (m.type === "diag") {
        const w = diagWaiters.get(m.seq);
        if (w) { diagWaiters.delete(m.seq); w(m.diag); }
      }
    };
    worker.postMessage({ type: "init", compact: opts.compact });
    return worker;
  };
  return {
    connect(win, targetOrigin, stageId) {
      const w = ensure();
      if (!w) {
        win.postMessage({ type: "gl-port", stageId, port: null }, targetOrigin);
        return;
      }
      const ch = new MessageChannel();
      w.postMessage({ type: "connect", stageId, port: ch.port2 }, [ch.port2]);
      win.postMessage({ type: "gl-port", stageId, port: ch.port1 }, targetOrigin, [ch.port1]);
    },
    diag() {
      if (!worker) return Promise.resolve(null);
      const id = ++diagSeq;
      return new Promise((resolve) => {
        diagWaiters.set(id, resolve);
        setTimeout(() => { if (diagWaiters.delete(id)) resolve(null); }, 3000);
        worker!.postMessage({ type: "diag", stageId: "*parent", seq: id });
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
    },
  };
}
