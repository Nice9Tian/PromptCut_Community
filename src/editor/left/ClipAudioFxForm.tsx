import { useState } from "react";
import { actions, getState, useStore } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import { describeAudioFx } from "../../kernel/audioFx.mjs";
import { createAudioFxTools } from "../right/audioFxTools";
import { NumberField } from "../fields/NumberField";

/** 和 Agent 的 apply_audio_fx 同一份校验 */
const tools = createAudioFxTools({ getState, actions });

const stepOf = (min?: number, max?: number, def?: number) => {
  const span = max !== undefined && min !== undefined ? max - min : Math.abs(def || 0) || 1;
  return span <= 2 ? 0.01 : span <= 20 ? 0.1 : 1;
};

/** 编辑页里素材段的音频效果一栏:从音频效果库挑一个挂上,再逐段调它声明的参数 */
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
        <span className="pc-left-muted shrink-0">音频效果</span>
        <select
          data-pc="clip-audiofx-select"
          value={cur?.id ?? ""}
          onChange={(e) => apply(e.target.value)}
          className="flex-1 pc-left-select is-sm"
        >
          <option value="">无</option>
          {audioFxList.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      {audioFxList.length === 0 && <div className="pc-left-faint">效果库是空的:让 Agent 建一个,或去「特效」分区的「音频预设」组新建</div>}
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
                // 只带声明过的键:update_audio_fx 删掉过的参数还留在片段上的话,整栏都会被「没有参数 X」卡住
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
