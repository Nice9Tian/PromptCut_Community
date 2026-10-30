/**
 * 完整时间轴(语义 `workflow/editing.md`「手机版界面」;演示稿第四、十轮):按时间缩放、刻度、多轨、播放头,
 * 选中片段后两端有手柄。空白处按住左右拖 = 横向滑动(播放头不动),点空白处 = 取消选中,点或拖刻度尺 = 移动播放头。
 * 缩放:「−」「＋」以播放头为中心,「适应宽度」,双指捏合以两指中点为中心;捏合时不拖动、不选中、不移动播放头。
 * 拖片段在本地预览,松手才调一次 `moveClip`(一次拖动 = 一步撤销)。主轨上的段位置由顺序决定,只能拖两端改时长。
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Project, Track, TrackClip } from "../kernel/project";
import { clipSpeed, speedLabel } from "../kernel/clipTime.mjs";
import { clipMakesNoSound } from "../editor/timeline/clipSilence";
import { clipKind, clipName } from "./mainContent";
import { PX_MAX, PX_MIN, TL_PAD, ZOOM_STEP, clampPx, fitPx, playheadX, rulerStep, timeToX, zoomAround } from "./zoom";
import { overlaysOfClip } from "../editor/timeline/overlays";
import { planOverlayBadge } from "./overlayBadge";
import { Icon } from "./icons";

/** 捏合松手后这么久内不把抬手当成点击 */
const PINCH_GRACE_MS = 350;
/** 拖动吸附到 0.5 秒 */
const SNAP = 0.5;

export interface FullTimelineHandle { fit: () => void }

function laneLabel(p: Project, t: Track, i: number): string {
  const kinds = new Set(t.clips.map((c) => clipKind(p, c)));
  if (kinds.has("video") || kinds.has("image")) return "视";
  if (kinds.has("cut")) return "剪";
  if (kinds.has("audio") && kinds.size === 1) return "音";
  if (kinds.has("card")) return "效";
  return String(i + 1);
}

type Drag = { id: string; start: number; end: number } | null;

export const FullTimeline = forwardRef<FullTimelineHandle, {
  project: Project;
  t: number;
  playing: boolean;
  selected: string | null;
  mainTrackId: string | undefined;
  cardName: (cardId: string) => string | undefined;
  onSelect: (clipId: string | null) => void;
  onScrub: (t: number) => void;
  onCommitMove: (clipId: string, patch: { start: number; end: number }) => void;
  onAlign: (which: "start" | "end") => void;
  /** 点片段上的叠加卡角标:选中这一段并把「调整」开到叠加卡那一节 */
  onOverlays: (clipId: string) => void;
  /** 只读项目(游客):拖动平移 / 改起止、对齐播放头都不接,点选、缩放、播放头照常 */
  locked?: boolean;
  /** 置灰时的悬停说明(`viewOnlyText()` 那一句,由调用方给) */
  lockedWhy?: string;
}>(function FullTimeline(props, ref) {
  const { project, selected } = props;
  const total = Math.max(project.duration, ...project.tracks.flatMap((t) => t.clips.map((c) => c.end)), 1);
  const [px, setPx] = useState(22);
  const pxRef = useRef(px);
  pxRef.current = px;
  const [drag, setDrag] = useState<Drag>(null);
  const sc = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  /** 捏合:两个手指的 pointerId → 位置;代号每次开始 / 结束捏合 +1,拖到一半被捏合打断的手势据此作废 */
  const pinch = useRef<{ d0: number; px0: number; tA: number } | null>(null);
  const pinchGen = useRef(0);
  const pinchUntil = useRef(0);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pendingScroll = useRef<number | null>(null);
  const pinching = (g: number) => !!pinch.current || g !== pinchGen.current || Date.now() < pinchUntil.current;

  const applyZoom = (np: number, scrollLeft: number) => {
    pendingScroll.current = scrollLeft;
    setPx(np);
  };
  useLayoutEffect(() => {
    if (pendingScroll.current !== null && sc.current) { sc.current.scrollLeft = pendingScroll.current; pendingScroll.current = null; }
  });
  const fit = () => {
    const el = sc.current;
    if (!el) return;
    applyZoom(fitPx(el.clientWidth, total), 0);
  };
  useImperativeHandle(ref, () => ({ fit }));
  // 进入时间轴默认「适应宽度」
  useEffect(() => { requestAnimationFrame(fit); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const zoomBy = (f: number) => {
    const el = sc.current!;
    const r = zoomAround(px, el.scrollLeft, playheadX(px, el.scrollLeft, props.t), px * f);
    applyZoom(r.px, r.scrollLeft);
  };

  // 播放时让播放头保持在可视范围
  useEffect(() => {
    const el = sc.current;
    if (!el || !props.playing) return;
    const x = timeToX(px, props.t);
    if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 60;
    if (x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 60);
  }, [props.t, props.playing, px]);

  // 双指捏合:捕获阶段先拿到两个触点,第二根手指不再触发选中、拖空白等
  useEffect(() => {
    const el = sc.current!;
    const pts = () => [...ptrs.current.values()];
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.current.size < 2) return;
      e.stopPropagation();
      if (ptrs.current.size === 2) {
        const [a, b] = pts();
        const rl = el.getBoundingClientRect().left, mid = (a.x + b.x) / 2;
        pinch.current = { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), px0: pxRef.current, tA: (el.scrollLeft + mid - rl - TL_PAD) / pxRef.current };
        pinchGen.current++;
        setDrag(null);
      }
    };
    const move = (e: PointerEvent) => {
      if (!ptrs.current.has(e.pointerId)) return;
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pc = pinch.current;
      if (!pc || ptrs.current.size < 2) return;
      const [a, b] = pts();
      const mid = (a.x + b.x) / 2, rl = el.getBoundingClientRect().left;
      const np = clampPx(pc.px0 * Math.hypot(a.x - b.x, a.y - b.y) / pc.d0);
      applyZoom(np, Math.max(0, pc.tA * np + TL_PAD - (mid - rl)));
    };
    const end = (e: PointerEvent) => {
      if (!ptrs.current.delete(e.pointerId)) return;
      if (pinch.current && ptrs.current.size < 2) { pinch.current = null; pinchGen.current++; pinchUntil.current = Date.now() + PINCH_GRACE_MS; }
    };
    el.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
    };
  }, []);

  const timeAt = (clientX: number) => {
    const r = inner.current!.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - r.left - TL_PAD) / pxRef.current));
  };

  /** 刻度尺:点或拖 = 移动播放头。触屏等手指动了或抬起再动,免得捏合起手时误动 */
  const onRulerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const g = pinchGen.current, touch = e.pointerType !== "mouse";
    let done = !touch;
    if (!touch) props.onScrub(timeAt(e.clientX));
    const mv = (ev: PointerEvent) => { if (!pinching(g)) { props.onScrub(timeAt(ev.clientX)); done = true; } };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      if (!done && !pinching(g)) props.onScrub(timeAt(ev.clientX));
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  /** 空白处:按住左右拖 = 横向滑动;点一下 = 取消选中 */
  const onBlankDown = (e: React.PointerEvent) => {
    const el = sc.current!;
    const x0 = e.clientX, sl0 = el.scrollLeft, g = pinchGen.current;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      if (pinching(g)) return;
      if (Math.abs(ev.clientX - x0) > 4) moved = true;
      if (moved) el.scrollLeft = sl0 - (ev.clientX - x0);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      if (!moved && !pinching(g) && selected) props.onSelect(null);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  /** 片段:点选;选中后拖动平移,拖两端改起止;主轨只能拖两端 */
  const onClipDown = (e: React.PointerEvent, c: TrackClip, onMain: boolean) => {
    e.stopPropagation();
    const g0 = pinchGen.current;
    if (selected !== c.id) {
      if (e.pointerType === "mouse") { props.onSelect(c.id); return; }
      // 触屏:抬手时才算选中,这样双指捏合起手落在片段上也不会选中它
      const x0 = e.clientX;
      let moved = false;
      const mv = (ev: PointerEvent) => { if (Math.abs(ev.clientX - x0) > 6) moved = true; };
      const up = () => {
        window.removeEventListener("pointermove", mv);
        window.removeEventListener("pointerup", up);
        if (!moved && !pinching(g0)) props.onSelect(c.id);
      };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
      return;
    }
    if (props.locked) return;
    const cls = (e.target as HTMLElement).classList;
    const edge = cls.contains("l") ? "l" : cls.contains("r") ? "r" : "m";
    if (onMain && edge === "m") return;
    const x0 = e.clientX, s0 = c.start, e0 = c.end, g = pinchGen.current;
    let moved = false;
    let cur = { id: c.id, start: s0, end: e0 };
    const mv = (ev: PointerEvent) => {
      if (pinching(g)) return;
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (!moved) return;
      const dt = Math.round((ev.clientX - x0) / pxRef.current / SNAP) * SNAP;
      if (edge === "m") { const s = Math.max(0, s0 + dt); cur = { id: c.id, start: s, end: s + (e0 - s0) }; }
      else if (edge === "r") cur = { id: c.id, start: s0, end: Math.max(s0 + SNAP, e0 + dt) };
      else cur = { id: c.id, start: Math.max(0, Math.min(e0 - SNAP, s0 + dt)), end: e0 };
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (pinching(g) || !moved) return; // 捏合打断了拖动:还原,不记撤销
      if (Math.abs(cur.start - s0) > 1e-6 || Math.abs(cur.end - e0) > 1e-6) props.onCommitMove(c.id, { start: cur.start, end: cur.end });
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const step = rulerStep(px);
  const ticks: number[] = [];
  for (let s = 0; s <= total + 1e-6; s += step) ticks.push(s);
  const width = total * px + TL_PAD + 60;
  return (
    <div className="pane-edit" data-pcm="full-timeline">
      <div className="timeline">
        <div ref={sc} className="tl-scroll" data-pcm="tl-scroll">
          <div ref={inner} className="tl-inner" style={{ width }} data-px={px} onPointerDown={onBlankDown}>
            <div className="ruler" data-pcm="ruler" onPointerDown={onRulerDown}>
              {ticks.map((s) => <span key={s} style={{ left: timeToX(px, s) }}>{+s.toFixed(1)}s</span>)}
            </div>
            {project.tracks.map((tr, i) => (
              <div key={tr.id} className="lane" data-lane={tr.id}>
                <div className="lane-head"><span>{laneLabel(project, tr, i)}</span></div>
                {tr.clips.map((c) => {
                  const d = drag?.id === c.id ? drag : c;
                  const kind = clipKind(project, c);
                  return (
                    <div
                      key={c.id}
                      className={`clip k-${kind}${c.id === selected ? " sel" : ""}`}
                      data-id={c.id}
                      data-pcm="clip"
                      style={{ left: timeToX(px, d.start), width: Math.max((d.end - d.start) * px - 2, 18) }}
                      onPointerDown={(e) => onClipDown(e, c, tr.id === props.mainTrackId && kind !== "card" && kind !== "audio")}
                    >
                      <span className="h l" />
                      {clipName(project, c, props.cardName)}
                      {/* 叠加卡:手机上不画带(带里的卡片低于能点中的尺寸),只留一个计数角标。
                          最窄那一档不吃点击 —— 角标几乎就是整个片段,入口交给子导航的「叠加层」 */}
                      {(() => {
                        const plan = planOverlayBadge(
                          Math.max((d.end - d.start) * px - 2, 18),
                          overlaysOfClip(project, c, { cardName: props.cardName }).length,
                        );
                        if (!plan) return null;
                        const title = `${plan.text.startsWith("叠加") ? plan.text : `叠加卡 ${plan.text} 张`}${plan.tappable ? "，点开在「调整」里改" : "，片段太短，点这一段再用底下的「叠加层」"}`;
                        return plan.tappable
                          ? <button type="button" className="ovm" data-pcm="clip-overlays" title={title}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); props.onOverlays(c.id); }}>{plan.text}</button>
                          : <span className="ovm is-flat" data-pcm="clip-overlays" title={title}>{plan.text}</span>;
                      })()}
                      {c.audioMuted && <span className="mute"><Icon name="mute" />已静音</span>}
                      {/* 变速段:写明倍数和「无原声」(〔裁〕第一版变速段不出原声,kernel/clipTime.mjs) */}
                      {!c.audioMuted && clipMakesNoSound(project, c) && <span className="mute" data-pcm="clip-speed" title="变速段不出原声"><Icon name="mute" />{speedLabel(clipSpeed(c))} 无原声</span>}
                      <span className="h r" />
                    </div>
                  );
                })}
              </div>
            ))}
            <div className="playhead" data-pcm="playhead" style={{ left: timeToX(px, props.t) }} />
          </div>
        </div>
      </div>
      <div className="tl-tools">
        <div className="zoom">
          <button type="button" data-pcm="zoom-out" aria-label="缩小" title="缩小" disabled={px <= PX_MIN + 1e-6} onClick={() => zoomBy(1 / ZOOM_STEP)}><Icon name="minus" /></button>
          <button type="button" data-pcm="zoom-in" aria-label="放大" title="放大" disabled={px >= PX_MAX - 1e-6} onClick={() => zoomBy(ZOOM_STEP)}><Icon name="plus" /></button>
          <button type="button" data-pcm="zoom-fit" aria-label="适应宽度" title="适应宽度" onClick={fit}><Icon name="fit" />适应宽度</button>
        </div>
        <span className="spacer" />
        <button type="button" data-pcm="align-start" disabled={props.locked} title={props.locked ? props.lockedWhy : "起点对齐播放头"} onClick={() => props.onAlign("start")}><Icon name="alignStart" />起点</button>
        <button type="button" data-pcm="align-end" disabled={props.locked} title={props.locked ? props.lockedWhy : "终点对齐播放头"} onClick={() => props.onAlign("end")}>终点<Icon name="alignEnd" /></button>
      </div>
    </div>
  );
});
