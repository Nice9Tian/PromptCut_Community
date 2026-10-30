import { useEffect, useRef, useState } from "react";
import type { Project } from "../../kernel/project";
import { collectSnapshots, frameRequest, see_frames } from "../../render/frameClient";
import { usePrerenderPreload } from "./usePrerenderPreload";
import { MovPlayer } from "../../render/movPlayer";
import { frameCss } from "../../kernel/layout";

/** Paused exact frames and live MOV playback share see_frames and its caches. */
export function UnifiedPreview({ project, t, playing }: { project: Project; t: number; playing: boolean }) {
  const [image, setImage] = useState<{ project: Project; url: string } | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [playbackPreview, setPlaybackPreview] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ t, playing }); latest.current = { t, playing };
  const requestFrame = useRef<() => void>(() => {});
  const wakePlayback = useRef<() => void>(() => {});

  // 预渲染触发走公共 hook(双舞台预览用同一份);legacy 这里沿用以前的行为:不看播放状态,采样帧到了就归档
  const archived = useRef({ project, count: 0 });
  usePrerenderPreload(project, {
    enabled: true,
    idle: true,
    onStatus: (status, current) => {
      if (archived.current.project !== current) archived.current = { project: current, count: 0 };
      const sampled = Number(status.sampled) || 0;
      if (sampled > archived.current.count) { archived.current.count = sampled; void collectSnapshots(current); }
    },
  });

  useEffect(() => {
    let active = true, inFlight = false, pending = false;
    let retry: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    const fps = Math.max(1, project.fps || 30);
    const draw = async () => {
      pending = true;
      if (inFlight || !active || latest.current.playing) return;
      clearTimeout(retry);
      inFlight = true;
      while (active && pending && !latest.current.playing) {
        pending = false;
        const requested = latest.current.t;
        controller = new AbortController();
        try {
          // 整帧打预渲染进程(D5):编辑器进程是 `interactive: false`,user lane 一律回 503 `USE_PRERENDER`
          // (`FramePipeline.laneRefused`)。回包里的 `url` 由 `frameRequest` 按预渲染的源补成绝对地址。
          // X7 起由 `server/test/legacy-preview-target.test.mjs` 守着,别改回 `"user"`。
          const result = await see_frames(project, [requested], controller.signal, { target: "prerender", lane: "user" });
          // A stale result can populate the common cache, but never the view.
          if (active && !latest.current.playing && Math.round(requested * fps) === Math.round(latest.current.t * fps)) {
            if (result.frames[0]) setImage({ project, url: result.frames[0].url });
            setMissing(result.frames[0]?.missing || []);
            if (result.incomplete) retry = setTimeout(() => { void draw(); }, 700);
            setError("");
          }
        } catch (e) {
          if (active && !controller.signal.aborted) {
            setError(String(e));
            // A backend restart should recover the paused frame without
            // requiring a timeline edit or a reload of unsaved work.
            if ((e as { retryable?: boolean }).retryable) retry = setTimeout(() => { void draw(); }, 2000);
          }
        }
        if (Math.round(requested * fps) !== Math.round(latest.current.t * fps)) pending = true;
      }
      inFlight = false;
    };
    requestFrame.current = () => {
      if (latest.current.playing) controller?.abort(); else void draw();
    };
    void draw();
    return () => { active = false; clearTimeout(retry); controller?.abort(); };
  }, [project]);
  useEffect(() => { requestFrame.current(); }, [Math.round(t * (project.fps || 30)), playing, project]);

  useEffect(() => {
    if (!canvas.current) return;
    const player = new MovPlayer(canvas.current, setError);
    const owner = crypto.randomUUID();
    let active = true, sequence = 0, running = false, pending = false, raf = 0;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const pulse = async () => {
      pending = true;
      if (running || !active) return;
      clearTimeout(timer); running = true; pending = false;
      const clock = { ...latest.current };
      try {
        // 播放走预渲染进程那条独立的泳道(A7):它挂得久,留在编辑器那个源上会占满浏览器的 6 条连接
        const status = await frameRequest("playback", project, { owner, sequence: ++sequence, ...clock, rate: 1, sentAt: Date.now(),
          deliveryMs: Math.min(5000, player.deliveryMs + 150) }, controller.signal, { target: "prerender", lane: "playback" });
        if (active && !status.closed && clock.playing === latest.current.playing) {
          player.update(status);
          if (clock.playing) { setMissing(status.preview?.missing || []); setPlaybackPreview(status.preview?.url || null); }
          if (status.error) setError(status.error); else if (clock.playing) setError("");
        }
      } catch (e) { if (active && !controller.signal.aborted) setError(String(e)); }
      finally {
        running = false;
        if (active) timer = setTimeout(pulse, pending ? 0 : latest.current.playing ? 100 : 1000);
      }
    };
    wakePlayback.current = () => { void pulse(); };
    const tick = () => {
      if (latest.current.playing) player.draw(latest.current.t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    void pulse(); // Create the full-duration transparent MOV when opening a project.
    return () => {
      active = false; controller.abort(); clearTimeout(timer); cancelAnimationFrame(raf); player.close();
      // 关这一路也得发到同一个进程上,不然预渲染那边的这一路永远不收摊
      void frameRequest("playback", project, { owner, sequence: ++sequence, t: latest.current.t, playing: false, close: true },
        undefined, { target: "prerender", lane: "playback" }).catch(() => {});
    };
  }, [project]);
  useEffect(() => { wakePlayback.current(); }, [playing, project]);

  const style = { position: "absolute" as const, inset: 0, width: "100%", height: "100%", pointerEvents: "none" as const };
  return <div style={style}>
    <canvas ref={canvas} width={project.width} height={project.height} style={{ ...style, display: playing ? "block" : "none" }} />
    {playing && playbackPreview && <img src={playbackPreview} alt="" style={style} />}
    {!playing && image?.project === project && <img src={image.url} alt="" style={style} />}
    <style>{`@keyframes pc-card-hourglass{0%,35%{transform:rotate(0)}65%,100%{transform:rotate(180deg)}}`}</style>
    {project.tracks.flatMap(track => track.hidden ? [] : track.clips).filter(clip => missing.includes(clip.id) && t >= clip.start && t < clip.end).map(clip =>
      <div key={clip.id} role="status" aria-label="正在预渲染" style={{ ...frameCss(clip.frame, project), display: 'grid', placeItems: 'center', border: '2px dashed #dcb66a', boxSizing: 'border-box' }}>
        <span style={{ fontSize: 28, animation: 'pc-card-hourglass 1.8s ease-in-out infinite', background: '#202934', borderRadius: 8, padding: 8 }}>⌛</span>
      </div>)}
    {error && <div role="status" style={{ position: "absolute", bottom: 8, left: 8, color: "white", background: "#842323", fontSize: 16 }}>{error}</div>}
  </div>;
}
