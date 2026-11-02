import { useState } from "react";
import { actions, getState, useStore } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import { describeFilter, type FilterParamSpec } from "../../kernel/filters.mjs";
import { createFilterTools } from "../right/filterTools";
import { NumberField } from "../fields/NumberField";
import { tr } from "../../i18n/index.ts";

/** Same validation as the Agent's apply_filter */
const tools = createFilterTools({ getState, actions });

const stepOf = (spec: FilterParamSpec) => {
  const span = spec.max !== undefined && spec.min !== undefined ? spec.max - spec.min : Math.abs(spec.default) || 1;
  return span <= 2 ? 0.01 : span <= 20 ? 0.1 : 1;
};

/** The filter row for a media clip in the editor: pick one from the filter library to attach, then tune its declared parameters per clip */
export function ClipFilterForm({ clip }: { clip: TrackClip }) {
  const filters = useStore((s) => s.project.filters) ?? [];
  const [err, setErr] = useState<string | null>(null);
  const cur = clip.filter ? filters.find((f) => f.id === clip.filter!.id) : undefined;

  const apply = (filterId: string, params?: Record<string, number>) => {
    try {
      tools.applyFilter({ clipId: clip.id, filterId, params });
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mt-2 pt-2 pc-left-divider" data-pc="clip-filter">
      <div className="flex items-center gap-2 mb-1">
        <span className="pc-left-muted shrink-0">{tr("Filter")}</span>
        <select
          data-pc="clip-filter-select"
          value={cur?.id ?? ""}
          onChange={(e) => apply(e.target.value)}
          className="flex-1 pc-left-select is-sm"
        >
          <option value="">{tr("None")}</option>
          {filters.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      {filters.length === 0 && <div className="pc-left-faint">{tr("The filter library is empty: ask the Agent to create one, and it will appear in the \"Filters\" group of the \"Effects\" section")}</div>}
      {cur && (
        <div className="pc-left-faint mb-1 truncate" title={describeFilter(cur)}>
          {describeFilter(cur)}
        </div>
      )}
      {cur?.params &&
        Object.entries(cur.params).map(([k, spec]) => (
          <label key={k} className="flex items-center gap-2 mb-1">
            <span className="w-16 truncate pc-left-muted" title={k}>
              {spec.label ?? k}
            </span>
            <NumberField
              attrs={{ "data-pc": `clip-filter-param-${k}` }}
              step={stepOf(spec)}
              min={spec.min}
              max={spec.max}
              value={clip.filter?.params?.[k] ?? spec.default}
              onCommit={(n) => {
                // Carry only declared keys: if parameters removed by update_filter are still left on the clip, the whole row gets stuck on "no parameter X"
                const kept = Object.fromEntries(Object.entries(clip.filter?.params ?? {}).filter(([key]) => cur.params && key in cur.params));
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
