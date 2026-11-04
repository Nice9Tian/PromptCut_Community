/**
 * Overreach probe user card (fixture): runs the probe once when visual component mounts; `audio()`
 * runs the Worker group in the sound thread. Probe code itself is in `probe-boundary-attempts.ts`.
 * Used via real loading path (`online-card-security-probe.mjs`): `content.put` to
 * `src/cards/user/probe-boundary-card.tsx` (probe code itself in
 * `src/cards/user/probe-boundary-attempts.ts`) → transpiled by editor → sent to stage → executed by
 * loader.
 *
 * Parameters come from clip's `params.ctx` (collection station address, session id, asset hash…;
 * does nothing if absent). Window half runs only once in visible stage (`role: "front"`), results
 * are in `globalThis.__pcBoundary["user-card"]` on that stage; sound half results are emitted from
 * thread via `postMessage` (probe wraps `Worker` in the stage to receive them).
 * Module top level writes a marker to `globalThis`: it should not appear in documents of editor or
 * same-origin single stage (card contract section 10, "Editor does not execute").
 */
import { useEffect } from "react";
import { runAll, workerAttempts } from "./probe-boundary-attempts";

(globalThis as any).__pcBoundaryLoaded = { ...((globalThis as any).__pcBoundaryLoaded ?? {}), "user-card": true };

function BoundaryCard({ params }: { params: any }) {
  useEffect(() => {
    const g = globalThis as any;
    const base = params?.ctx;
    if (!base?.collector || g.__pcBoundaryStarted?.["user-card"]) return;
    if (!base.anyRole && g.__pcStageDiag?.().role !== "front") return;
    g.__pcBoundaryStarted = { ...(g.__pcBoundaryStarted ?? {}), "user-card": true };
    void runAll({ ...base, tag: "user-card", graph: false }).then((r: unknown) => { g.__pcBoundary = { ...(g.__pcBoundary ?? {}), "user-card": r }; });
  }, []);
  return <div className="absolute inset-0 flex items-center justify-center text-[80px]">probe-boundary-card</div>;
}

let audioStarted = false;

export const probeBoundaryCard = {
  id: "probe-boundary-card",
  name: "Overreach probe user card",
  description: "Used by the security acceptance probe: tries to read credentials, tickets, local storage and parent page objects, and sends requests to external addresses",
  tags: ["probe"],
  frameMode: "stateful",
  defaults: { ctx: null },
  controls: [],
  Component: BoundaryCard,
  // No DOM in the sound thread: only runs the Worker group, results are sent out from the thread
  audio: (_sources: unknown, range: { start: number; count: number }, params: any) => {
    const base = params?.ctx;
    if (base?.collector && !audioStarted) {
      audioStarted = true;
      void workerAttempts({ ...base, tag: "user-card-audio" }).then((r: unknown) => { (self as any).postMessage({ __pcBoundary: "user-card-audio", r }); });
    }
    return new Float32Array(range.count);
  },
};
