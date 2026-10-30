/**
 * GL Worker(R9 M2):持**唯一的** WebGL2 上下文(一张 `OffscreenCanvas`)和图集。
 *
 * 两种来路收同一套消息(`init` / `layout` / `beat` / `release` / `diag`):
 *   - 路线 1(`perDocument`)和导出页:舞台 / 导出页的 `glHost` 自己 `new Worker`,消息直接进 `onmessage`;
 *   - 路线 2(`shared`):父页(编辑器文档)建这一个 Worker,每个舞台一条 `MessageChannel`,
 *     父页发 `{ type: 'connect', stageId, port }` 把 `port2` 交进来,舞台的 `glHost` 在 `port1` 上收发。
 *     一个端口绑死一个 `stageId`:端口上来的消息一律按它的 `stageId` 处理,舞台自报的不作数。
 *
 * **时间只由主线程给**:这里不读 rAF、`performance.now`(只有 `measure` 量 GPU 耗时时读)、`Date.now`。
 * 活都在同一个上下文上,`renderer.beat` 内部串行 —— 路线 2 下两个 `stageId` 的 blit 也是串行的。
 */

import { createGlRenderer, type GlRenderer } from "./renderer";
import { programOf } from "./programs";
import type { GlFromWorker, GlToWorker } from "./CanvasCardProgram";

type Reply = (msg: GlFromWorker, transfer?: Transferable[]) => void;

const scope = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  __pcGlDiag?: () => unknown;
};

let renderer: GlRenderer | null = null;
const ensure = (compact: boolean): GlRenderer => (renderer ??= createGlRenderer({ compact, programOf }));

/** 路线 2:端口 → 它绑的 stageId(同一个 stageId 重连 = 舞台重载了,旧的那份图集先放掉) */
const ports = new Map<string, MessagePort>();

function handle(msg: GlToWorker, reply: Reply, boundStageId: string | null): void {
  switch (msg.type) {
    case "init": {
      const r = ensure(!!msg.compact);
      reply({ type: "ready", ok: r.ok, error: r.error ?? undefined, renderer: r.renderer, samples: r.samples });
      return;
    }
    case "connect": {
      const old = ports.get(msg.stageId);
      if (old && old !== msg.port) {
        old.onmessage = null;
        old.close();
        renderer?.release(msg.stageId);
      }
      ports.set(msg.stageId, msg.port);
      const stageId = msg.stageId;
      msg.port.onmessage = (e: MessageEvent) => handle(e.data as GlToWorker, (m, t) => msg.port.postMessage(m, t ?? []), stageId);
      msg.port.start();
      return;
    }
    case "layout": {
      const r = renderer ?? ensure(false);
      reply(r.layout(boundStageId ?? msg.stageId, msg.cards));
      return;
    }
    case "beat": {
      const r = renderer ?? ensure(false);
      const stageId = boundStageId ?? msg.stageId;
      void r.beat({ ...msg, stageId }).then(
        ({ msg: done, transfer }) => reply(done, transfer),
        (e) => reply({ type: "done", stageId, seq: msg.seq, t: msg.t, bitmaps: new Map(), error: e instanceof Error ? e.message : String(e) }),
      );
      return;
    }
    case "release": {
      renderer?.release(boundStageId ?? msg.stageId);
      return;
    }
    case "diag": {
      const r = renderer ?? ensure(false);
      reply({ type: "diag", stageId: boundStageId ?? msg.stageId, seq: msg.seq, diag: r.diag() });
      return;
    }
  }
}

scope.onmessage = (e: MessageEvent) => handle(e.data as GlToWorker, (m, t) => scope.postMessage(m, t ?? []), null);
// 探针经 CDP 直接在 Worker 里读(验收:这个 Worker 里恰好一个上下文)
scope.__pcGlDiag = () => renderer?.diag() ?? null;
