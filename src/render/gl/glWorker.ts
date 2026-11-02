/**
 * GL Worker (R9 M2): holds the **sole** WebGL2 context (one `OffscreenCanvas`) and atlas.
 *
 * Receives the same set of messages (`init` / `layout` / `beat` / `release` / `diag`) from
 * two sources:
 *   - Route 1 (`perDocument`) and export page: `glHost` of the stage / export page creates
 *     `new Worker` itself, and messages go directly into `onmessage`;
 *   - Route 2 (`shared`): parent page (editor document) creates this single Worker, with one
 *     `MessageChannel` per stage; the parent page sends `{ type: 'connect', stageId, port }` to pass
 *     `port2` in, and the stage's `glHost` sends and receives on `port1`.
 *     One port is hard-bound to one `stageId`: messages coming from a port are always processed by
 *     its `stageId`; what the stage self-reports does not count.
 *
 * **Time is provided only by the main thread**: do not read rAF, `performance.now` (read only when
 * `measure` measures GPU duration), or `Date.now` here.
 * All work is on the same context, and `renderer.beat` is serialized internally: under Route 2,
 * blits across the two `stageId` values are also serialized.
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

/** Route 2: port → bound stageId (same stageId reconnecting = stage reloaded, release old atlas first) */
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
// Probe reads directly in Worker via CDP (acceptance check: exactly one context in this Worker)
scope.__pcGlDiag = () => renderer?.diag() ?? null;
