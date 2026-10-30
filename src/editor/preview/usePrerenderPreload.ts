import { useEffect, useRef } from "react";
import type { Project } from "../../kernel/project";
import { frameRequest } from "../../render/frameClient";
import { createPreloadScheduler, type PreloadScheduler, type PreloadStatus } from "./prerenderPreload";
import { onProbeProgress, probeSettledFor, syncProbeRun } from "../probeRunner";

/**
 * 页面触发预渲染的公共 hook(调度见 `prerenderPreload.ts`):编辑推送成功、空闲时防抖发 `preload`,没就绪就接着问。
 *
 * - 双舞台预览(`Preview.tsx`):`idle` = 不在播放、不在拖动;
 * - legacy 预览(`UnifiedPreview`):沿用以前的行为,`idle` 恒为 true,`onStatus` 归档采样帧。
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

  // 空闲状态先于编辑通知送进去:同一次渲染里两样都变时,编辑那一下才按新的空闲状态排
  useEffect(() => { schedulerRef.current?.setIdle(opts.idle && (!opts.waitForProbe || probeSettledFor(project))); }, [opts.enabled, opts.idle, opts.waitForProbe, project]);
  useEffect(() => {
    if (opts.waitForProbe) syncProbeRun(project);
    schedulerRef.current?.setIdle(opts.idle && (!opts.waitForProbe || probeSettledFor(project)));
    schedulerRef.current?.edited();
  }, [opts.enabled, project, opts.waitForProbe]);
}
