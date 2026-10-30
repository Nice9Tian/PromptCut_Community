import { useState, type ReactNode } from "react";
import { actions, useStore } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import type { ClipFrame } from "../../kernel/types";
import { resolveFrame } from "../../kernel/layout";
import { cutDuration } from "../../kernel/cutSegments";
import { fadeOwner } from "../../kernel/transitions";
import { openCutInTimeline } from "../timeline/CutTabs";
import { NumberField } from "../fields/NumberField";
import { RangeField } from "../fields/RangeField";

/**
 * 编辑分区里剪辑段的属性(`product/project-model.md`「片段」的剪辑段一条):从被引用剪辑的第几秒开始,
 * 以及和素材段相同的起止、框、不透明度、淡入淡出、音量与静音。引用哪条剪辑不能改(2026-10-21 用户定,
 * `workflow/editing.md`「剪辑段的属性」),所以这里没有换引用的下拉框;要换就删掉这段,从素材库重新拖一条。
 *
 * 每一项都走现有的 store 动作(`setCutSegment`、`moveClip`、`setClipFrame`、`updateClip`、`setClipVolume`、`setClipMuted`),
 * 它们换新对象写回项目、进撤销栈;偏移超出被引用剪辑总长这类拒绝原样显示在表单底下。
 * 「打开被引用剪辑」和双击时间轴上的剪辑段同效(`openCutInTimeline`)。
 *
 * 数字框与滑块是 `../fields/` 里共用的 NumberField / RangeField:数字框敲字只改草稿,回车或失焦才提交一步;
 * 滑块一次拖动只记一步撤销(2026-10-20 用户定,`docs/semantics/workflow/editing.md`「撤销、重做」)。
 */
export function CutSegmentForm({ clip }: { clip: TrackClip }) {
  const project = useStore((s) => s.project);
  const [err, setErr] = useState<string | null>(null);
  const cuts = project.cuts ?? [];
  const cutId = clip.cutId!;
  const target = cuts.find((c) => c.id === cutId);
  const total = cutDuration(project, cutId);
  const offset = clip.cutOffset ?? 0;
  const len = clip.end - clip.start;
  const beyond = Math.max(0, len - Math.max(0, total - offset));
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
  const locked = !!track?.locked;

  /** 跑一个 store 动作:抛的错、回 { ok: false, error } 的都显示出来 */
  const run = (fn: () => unknown) => {
    try {
      const r = fn() as { ok?: boolean; error?: string; blocked?: string[] } | undefined;
      if (r && typeof r === "object" && r.ok === false) setErr(r.error ?? (r.blocked?.length ? "这一侧的淡化由转场管着,要改先删掉转场" : "没改成"));
      else if (r && typeof r === "object" && r.blocked?.length) setErr("这一侧的淡化由转场管着,要改先删掉转场");
      else setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const stage = { width: project.width, height: project.height };
  const frame = resolveFrame(clip.frame, stage);
  const patchFrame = (p: Partial<ClipFrame>) => run(() => actions.setClipFrame(clip.id, { ...(clip.frame ?? { x: 0, y: 0 }), ...p } as ClipFrame));

  const row = (label: string, body: ReactNode, hint?: string) => (
    <div className="flex items-center gap-2" title={hint}>
      <span className="w-14 shrink-0 pc-left-muted">{label}</span>
      {body}
    </div>
  );
  const numberBox = (dataPc: string, value: number, step: number, onValue: (n: number) => void, opts: { min?: number; max?: number; disabled?: boolean } = {}) => (
    <NumberField attrs={{ "data-pc": dataPc }} value={value} step={step} min={opts.min} max={opts.max} disabled={opts.disabled || locked} onCommit={onValue} className="w-14 shrink-0 pc-left-input is-sm" />
  );
  const sub = (text: string) => <span className="shrink-0 whitespace-nowrap pc-left-muted">{text}</span>;
  const slider = (dataPc: string, value: number, min: number, max: number, step: number, onValue: (n: number) => void, disabled = false) => (
    <RangeField attrs={{ "data-pc": dataPc }} min={min} max={max} step={step} value={value} disabled={disabled || locked} onValue={onValue} className="flex-1 min-w-0 pc-left-range" />
  );

  const fadeInLocked = !!fadeOwner(project, clip.id, "fadeIn");
  const fadeOutLocked = !!fadeOwner(project, clip.id, "fadeOut");
  const volume = clip.audioVolume ?? 1;
  const muted = !!clip.audioMuted;

  return (
    <div data-pc="cut-segment-form" className="flex-1 min-h-0 overflow-y-auto pc-left-scroll flex flex-col gap-2 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold pc-left-strong truncate">剪辑段 · {target?.name ?? "(引用的剪辑已删除)"}</div>
        <button
          type="button"
          data-pc="cut-segment-open"
          className="pc-left-btn is-sm shrink-0"
          disabled={!target}
          title="在时间轴上方的标签栏里打开并激活被引用的剪辑(和双击剪辑段一样)"
          onClick={() => openCutInTimeline(cutId)}
        >
          打开被引用剪辑
        </button>
      </div>

      {locked && <div className="pc-left-faint">所在序列锁着,先解锁才能改</div>}

      {row("起点偏移", (
        <>
          {numberBox("cut-segment-offset", offset, 0.1, (n) => run(() => actions.setCutSegment(clip.id, { cutOffset: Math.max(0, n) })), { min: 0 })}
          <span className="pc-left-faint whitespace-nowrap">秒,共 {total.toFixed(2)} 秒</span>
        </>
      ), "从被引用剪辑的第几秒开始放")}

      <div className="flex items-center gap-2" title={`段长 ${len.toFixed(2)} 秒`}>
        {sub("开始")}
        {numberBox("clip-start", clip.start, 0.1, (n) => run(() => actions.moveClip(clip.id, { start: n })), { min: 0 })}
        {sub("结束")}
        {numberBox("clip-end", clip.end, 0.1, (n) => run(() => actions.moveClip(clip.id, { end: n })), { min: 0 })}
      </div>
      {beyond > 0.0005 && (
        <div data-pc="cut-segment-beyond" className="pc-left-faint">
          被引用剪辑变短了:最后 {beyond.toFixed(2)} 秒超出它的总时长,那一截画面透明、无声
        </div>
      )}

      <div className="mt-1 pt-2 pc-left-divider flex items-center justify-between">
        <span className="font-semibold pc-left-strong">框</span>
        <button
          type="button"
          data-pc="cut-segment-frame-reset"
          className="pc-left-btn is-sm"
          disabled={!clip.frame || locked}
          title="清掉框,铺满整个画面"
          onClick={() => run(() => actions.setClipFrame(clip.id, undefined))}
        >
          铺满
        </button>
      </div>
      {row("位置", (
        <>
          <span className="shrink-0 pc-left-faint">X</span>
          {numberBox("cut-segment-x", frame.x, 1, (n) => patchFrame({ x: n }))}
          <span className="shrink-0 pc-left-faint">Y</span>
          {numberBox("cut-segment-y", frame.y, 1, (n) => patchFrame({ y: n }))}
        </>
      ), "锚点所在位置(像素)")}
      {row("缩放", (
        <>
          {slider("cut-segment-scale", frame.scale, 0.05, 2, 0.01, (n) => patchFrame({ scale: n }))}
          {numberBox("cut-segment-scale-num", frame.scale, 0.01, (n) => patchFrame({ scale: Math.max(0.01, n) }), { min: 0.01 })}
        </>
      ))}
      {row("旋转", (
        <>
          {slider("cut-segment-rotate", frame.rotate, -180, 180, 1, (n) => patchFrame({ rotate: n }))}
          {numberBox("cut-segment-rotate-num", frame.rotate, 1, (n) => patchFrame({ rotate: n }))}
          <span className="pc-left-faint">°</span>
        </>
      ))}

      <div className="mt-1 pt-2 pc-left-divider font-semibold pc-left-strong">画面</div>
      {row("不透明度", (
        <>
          {slider("cut-segment-opacity", clip.opacity ?? 1, 0, 1, 0.01, (n) => run(() => actions.updateClip(clip.id, { opacity: n })))}
          {numberBox("cut-segment-opacity-num", clip.opacity ?? 1, 0.05, (n) => run(() => actions.updateClip(clip.id, { opacity: Math.max(0, Math.min(1, n)) })), { min: 0, max: 1 })}
        </>
      ))}
      <div className="flex items-center gap-2" title={fadeInLocked || fadeOutLocked ? "由转场管着的那一侧要先删掉转场才能改" : "画面与声音一起淡(秒)"}>
        {sub("淡入")}
        {numberBox("cut-segment-fadein", clip.fadeIn ?? 0, 0.1, (n) => run(() => actions.updateClip(clip.id, { fadeIn: Math.max(0, Math.min(len, n)) })), { min: 0, disabled: fadeInLocked })}
        {sub("淡出")}
        {numberBox("cut-segment-fadeout", clip.fadeOut ?? 0, 0.1, (n) => run(() => actions.updateClip(clip.id, { fadeOut: Math.max(0, Math.min(len, n)) })), { min: 0, disabled: fadeOutLocked })}
        <span className="shrink-0 pc-left-faint">秒</span>
      </div>

      <div className="mt-1 pt-2 pc-left-divider font-semibold pc-left-strong">声音</div>
      {row("音量", (
        <>
          {slider("cut-segment-volume", volume, 0, 1, 0.01, (n) => run(() => actions.setClipVolume(clip.id, n)))}
          {numberBox("cut-segment-volume-num", volume, 0.05, (n) => run(() => actions.setClipVolume(clip.id, Math.max(0, Math.min(1, n)))), { min: 0, max: 1 })}
        </>
      ), "乘在被引用剪辑整份混音上")}
      <label className="flex items-center gap-2 pc-left-muted">
        <input
          data-pc="cut-segment-muted"
          type="checkbox"
          checked={muted}
          disabled={locked}
          onChange={(e) => run(() => actions.setClipMuted(clip.id, e.target.checked))}
        />
        静音(只关这一段的声音,画面照常)
      </label>

      {err && <div data-pc="cut-segment-error" className="text-red-400 mt-1" role="alert">{err}</div>}
    </div>
  );
}

