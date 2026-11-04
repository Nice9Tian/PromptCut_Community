import { useEffect, useState } from "react";
import { actions, useStore } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import { CLIP_SPEED_MAX, CLIP_SPEED_MIN, CLIP_SPEED_PRESETS, SPEED_AUDIO_NOTE, SPEED_MUTE_NOTE, clipSpeed, speedChangeNotes, speedLabel } from "../../kernel/clipTime.mjs";
import { tr } from "../../i18n/index.ts";

/** Explain the result of a speed change in human terms: how much the transitions shrank, who moved along, how many clips were pushed apart (speedChangeNotes in kernel/clipTime.mjs) */
export function speedResultText(r: ReturnType<typeof actions.setClipSpeed>, clipId: string): string | null {
  if (!r.ok) return r.error;
  return speedChangeNotes(r, clipId);
}

/**
 * The "Speed" field in the editing section for video clips and audio clips: a few multiplier tiers, or
 * manual input (0.25 to 4, decimals allowed; values out of range are rejected with a message, not clamped).
 * The start stays fixed and the end is recomputed from the new speed (store's setClipSpeed: when longer,
 * the following clips are pushed back as a whole; when shorter, the tail is left empty).
 * The mobile app entry is "Speed" in the sub-navigation bar (SpeedSheet in `src/mobile/sheets.tsx`);
 * both sides use the same action and the same description.
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
        <span className="pc-left-muted shrink-0">{tr("Speed")}</span>
        <select data-pc="clip-speed-select" value={String(cur)} onChange={(e) => apply(Number(e.target.value))} className="flex-1 pc-left-select is-sm">
          {presets.map((v) => <option key={v} value={String(v)}>{speedLabel(v)}</option>)}
        </select>
        <input data-pc="clip-speed-input" className="w-16 pc-left-input is-sm" inputMode="decimal" type="number" min={CLIP_SPEED_MIN} max={CLIP_SPEED_MAX} step={0.01}
          title={tr("Enter a rate manually ({0}~{1})", CLIP_SPEED_MIN, CLIP_SPEED_MAX)} value={text} onChange={(e) => setText(e.target.value)}
          onBlur={commitText} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        <span className="pc-left-faint">×</span>
      </div>
      <div className={cur === 1 ? "pc-left-faint" : "pc-left-muted"} data-pc="clip-speed-note">{kind === "audio" ? SPEED_AUDIO_NOTE : SPEED_MUTE_NOTE}</div>
      {msg && <div className="pc-left-faint" data-pc="clip-speed-msg" role="status">{msg}</div>}
    </div>
  );
}
