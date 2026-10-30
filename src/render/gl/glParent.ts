/**
 * 路线 2(`shared`)的父页一侧(R9 M2):编辑器文档 `new Worker` **一次**、持唯一的上下文和图集,
 * 给每个舞台 iframe 开一条 `MessageChannel`,`port2` 交给 Worker、`port1` 转进舞台
 * (`MessagePort` 可跨源转移,两个舞台 iframe 是跨源的)。
 *
 * **端口转交协议**:父页在收到该舞台 `pc-stage-ready` 之后、发任何 RPC 之前,先
 * `postMessage({ type: 'gl-port', stageId, port }, [port])`;舞台的 `glHost` 收到之前把 `beat` 排队、
 * 不呈现 canvas 卡。路线 1 下这条消息不发。父页这边开不了共享 Worker 时发 `port: null`,舞台自己开。
 *
 * 代价(语义里写明的):GL 线程落在编辑器进程里(独立线程,不碰主线程),舞台的进程隔离对它不成立。
 * 导出页在预渲染进程里没有父页,永远走路线 1,和这里无关。
 */
import type { GlFromWorker, GlWorkerDiag } from "./CanvasCardProgram";
import { spawnGlWorker } from "./spawnWorker";

export interface SharedGl {
  /** 给这个舞台开一条通道并把端口交过去(同一个 stageId 再来一次 = 那个 iframe 重载了,旧通道作废) */
  connect(win: Window, targetOrigin: string, stageId: string): void;
  /** 探针用:共享 Worker 那一侧的诊断 */
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
