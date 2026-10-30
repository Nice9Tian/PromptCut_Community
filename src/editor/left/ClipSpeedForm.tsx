import { useEffect, useState } from "react";
import { actions, useStore } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import { CLIP_SPEED_MAX, CLIP_SPEED_MIN, CLIP_SPEED_PRESETS, SPEED_AUDIO_NOTE, SPEED_MUTE_NOTE, clipSpeed, speedChangeNotes, speedLabel } from "../../kernel/clipTime.mjs";

/** 改速度的结果说给人听:转场跟着缩了多少、谁跟着挪了、推开了几段(kernel/clipTime.mjs 的 speedChangeNotes) */
export function speedResultText(r: ReturnType<typeof actions.setClipSpeed>, clipId: string): string | null {
  if (!r.ok) return r.error;
  return speedChangeNotes(r, clipId);
}

/**
 * 编辑分区里视频段、声音段的「速度」一栏:几档倍数,也能手动输入(0.25～4,可带小数,超出范围拒绝并提示,不夹)。
 * 起点不动、终点按新速度重算(store 的 setClipSpeed:变长碰到后面的段整体推开、变短尾部留空)。
 * 手机版的入口在子导航栏的「速度」(`src/mobile/sheets.tsx` 的 SpeedSheet),两边同一个动作、同一句说明。
 */
export function ClipSpeedForm({ clip }: { clip: TrackClip }) {
  const kind = useStore((s) => s.project.media.find((m) => m.id === clip.mediaId)?.kind);
  const [msg, setMsg] = useState<string | null>(null);
  const cur = clipSpeed(clip);
  const [text, setText] = useState(String(cur));
  useEffect(() => setText(String(cur)), [cur]);
  const presets = CLIP_SPEED_PRESETS.includes(cur) ? CLIP_SPEED_PRESETS : [...CLIP_SPEED_PRESETS, cur].sort((a, b) => a - b);
  const apply = (v: number) => setMsg(speedResultText(actions.setClipSpeed(clip.id, v), clip.id));
  const commitText = () => {
    const v = Number(text.trim().replace(/[×x]$/i, ""));
    if (!Number.isFinite(v) || Math.abs(v - cur) < 1e-9) { setText(String(cur)); return; }
    apply(v);
  };
  return (
    <div className="mt-2 pt-2 pc-left-divider" data-pc="clip-speed">
      <div className="flex items-center gap-2 mb-1">
        <span className="pc-left-muted shrink-0">速度</span>
        <select data-pc="clip-speed-select" value={String(cur)} onChange={(e) => apply(Number(e.target.value))} className="flex-1 pc-left-select is-sm">
          {presets.map((v) => <option key={v} value={String(v)}>{speedLabel(v)}</option>)}
        </select>
        <input data-pc="clip-speed-input" className="w-16 pc-left-input is-sm" inputMode="decimal" type="number" min={CLIP_SPEED_MIN} max={CLIP_SPEED_MAX} step={0.01}
          title={`手动输入倍率(${CLIP_SPEED_MIN}～${CLIP_SPEED_MAX})`} value={text} onChange={(e) => setText(e.target.value)}
          onBlur={commitText} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        <span className="pc-left-faint">×</span>
      </div>
      <div className={cur === 1 ? "pc-left-faint" : "pc-left-muted"} data-pc="clip-speed-note">{kind === "audio" ? SPEED_AUDIO_NOTE : SPEED_MUTE_NOTE}</div>
      {msg && <div className="pc-left-faint" data-pc="clip-speed-msg" role="status">{msg}</div>}
    </div>
  );
}
