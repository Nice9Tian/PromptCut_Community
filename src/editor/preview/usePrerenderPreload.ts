import { useEffect, useRef } from "react";
import type { Project } from "../../kernel/project";
import { frameRequest } from "../../render/frameClient";
import { createPreloadScheduler, type PreloadScheduler, type PreloadStatus } from "./prerenderPreload";
import { onProbeProgress, probeSettledFor, syncProbeRun } from "../probeRunner";

/**
 * Shared hook for pages to trigger prerendering (scheduling in `prerenderPreload.ts`): after an
 * edit push succeeds, send `preload` debounced when idle, and keep asking if not ready.
 *
 * - Dual-stage preview (`Preview.tsx`): `idle` = not playing and not dragging;
 * - Legacy preview (`UnifiedPreview`): keeps the old behavior, `idle` is always true, and
 *   `onStatus` archives the sampled frames.
 */
export function usePrerenderPreload(project: Project, opts: { enabled: boolean; idle: boolean; waitForProbe?: boolean; onStatus?: (status: PreloadStatus, project: Project) => void }): void {
  const projectRef = useRef(project);
  projectRef.current = project;
  const onStatusRef = useRef(opts.onStatus);
  onStatusRef.current = opts.onStatus;
  const schedulerRef = useRef<PreloadScheduler | null>(null);
  const idleRef = useRef(opts.idle);
  idleRef.current = opts.idle;
  const waitRef = useRef(opts.waitForProbe === true);
  waitRef.current = opts.waitForProbe === true;

  useEffect(() => {
    if (!opts.enabled) return;
    const scheduler = createPreloadScheduler({
      request: (signal) => frameRequest("preload", projectRef.current, {}, signal, { target: "prerender", lane: "background" }),
      onStatus: (status) => onStatusRef.current?.(status, projectRef.current),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    });
    schedulerRef.current = scheduler;
    const offProbe = onProbeProgress(() => {
      if (!waitRef.current) return;
      const ready = probeSettledFor(projectRef.current);
      scheduler.setIdle(idleRef.current && ready);
      if (ready) scheduler.edited();
    });
    return () => {
      offProbe();
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
    };
  }, [opts.enabled]);

  // Feed the idle state in before the edit notification: when both change in the same render, the edit is scheduled with the new idle state
  useEffect(() => { schedulerRef.current?.setIdle(opts.idle && (!opts.waitForProbe || probeSettledFor(project))); }, [opts.enabled, opts.idle, opts.waitForProbe, project]);
  useEffect(() => {
    if (opts.waitForProbe) syncProbeRun(project);
    schedulerRef.current?.setIdle(opts.idle && (!opts.waitForProbe || probeSettledFor(project)));
    schedulerRef.current?.edited();
  }, [opts.enabled, project, opts.waitForProbe]);
}
