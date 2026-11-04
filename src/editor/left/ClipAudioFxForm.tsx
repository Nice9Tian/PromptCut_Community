import { useState } from "react";
import { actions, getState, useStore } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import { describeAudioFx } from "../../kernel/audioFx.mjs";
import { createAudioFxTools } from "../right/audioFxTools";
import { NumberField } from "../fields/NumberField";
import { tr } from "../../i18n/index.ts";

/** Same validation as the Agent's apply_audio_fx */
const tools = createAudioFxTools({ getState, actions });

const stepOf = (min?: number, max?: number, def?: number) => {
  const span = max !== undefined && min !== undefined ? max - min : Math.abs(def || 0) || 1;
  return span <= 2 ? 0.01 : span <= 20 ? 0.1 : 1;
};

/** The audio effects row for a media clip in the editor: pick one from the audio effects library to attach, then tune its declared parameters per clip */
export function ClipAudioFxForm({ clip }: { clip: TrackClip }) {
  const audioFxList = useStore((s) => s.project.audioFx) ?? [];
  const [err, setErr] = useState<string | null>(null);
  const cur = clip.audioFx ? audioFxList.find((f) => f.id === clip.audioFx!.id) : undefined;

  const apply = (fxId: string, params?: Record<string, number>) => {
    try {
      tools.applyAudioFx({ clipId: clip.id, fxId, params });
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mt-2 pt-2 pc-left-divider" data-pc="clip-audiofx">
      <div className="flex items-center gap-2 mb-1">
        <span className="pc-left-muted shrink-0">{tr("Audio effect")}</span>
        <select
          data-pc="clip-audiofx-select"
          value={cur?.id ?? ""}
          onChange={(e) => apply(e.target.value)}
          className="flex-1 pc-left-select is-sm"
        >
          <option value="">{tr("None")}</option>
          {audioFxList.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      {audioFxList.length === 0 && <div className="pc-left-faint">{tr("The effects library is empty: ask the Agent to create one, or create one in the \"Audio presets\" group of the \"Effects\" section")}</div>}
      {cur && (
        <div className="pc-left-faint mb-1 truncate" title={describeAudioFx(cur)}>
          {describeAudioFx(cur)}
        </div>
      )}
      {cur?.params &&
        Object.entries(cur.params).map(([k, spec]) => (
          <label key={k} className="flex items-center gap-2 mb-1">
            <span className="w-16 truncate pc-left-muted" title={k}>
              {spec.label ?? k}
            </span>
            <NumberField
              attrs={{ "data-pc": `clip-audiofx-param-${k}` }}
              step={stepOf(spec.min, spec.max, spec.default)}
              min={spec.min}
              max={spec.max}
              value={clip.audioFx?.params?.[k] ?? spec.default}
              onCommit={(n) => {
                // Carry only declared keys: if parameters removed by update_audio_fx are still left on the clip, the whole row gets stuck on "no parameter X"
                const kept = Object.fromEntries(Object.entries(clip.audioFx?.params ?? {}).filter(([key]) => cur.params && key in cur.params));
                apply(cur.id, { ...kept, [k]: n });
              }}
              className="w-20 pc-left-input is-sm"
            />
          </label>
        ))}
      {err && <div className="text-red-400 mt-1">{err}</div>}
    </div>
  );
}
