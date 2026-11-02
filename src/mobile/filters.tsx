/**
 * 手机版的滤镜入口(`docs/plan/mobile-online-task.md` 待用户项第 4 条,用户 2026-10-21 定「先补滤镜」):
 * - 卡片库「滤镜」分类:项目的滤镜库,挂到 / 摘掉选中的视频、图片段,删除(同桌面「特效 → 滤镜」组 `filtersGroup.tsx`);
 * - 调整面板里素材段的「滤镜」一栏:挑一个挂上、逐段调它声明的参数(同桌面编辑页 `ClipFilterForm.tsx`)。
 * 校验与门槛和桌面、Agent 的 apply_filter / remove_filter 是同一份(`createFilterTools`),这里只画手机版的控件。
 */
import { useState } from "react";
import { actions, getState, useStore } from "../store/project";
import { findClip, type Project, type TrackClip } from "../kernel/project";
import { cssFilter, describeFilter, isAnimated, resolveOps, type FilterDef, type FilterParamSpec } from "../kernel/filters.mjs";
import { createFilterTools, usesOf } from "../editor/right/filterTools";
import { ControlField, Slider } from "./controls";
import { useConfirm, useToast } from "./ui";
import { tr } from "../i18n/index.ts";

const tools = createFilterTools({ getState, actions });

/** 滤镜库是空的时的提示:口径同桌面(`ClipFilterForm.tsx`、`filtersGroup.tsx`),位置换成手机版的「卡片库 → 滤镜」 */
export const FILTERS_EMPTY_SHORT = tr("The filter library is empty: ask the Agent to create one, and it will appear in the \"Filters\" category of the card library");
export const FILTERS_EMPTY_LONG = tr("No filters yet. Ask the Agent to create one (for example, \"give those night-scene clips a cool tone\"). It will appear here and can then be attached to any video / image clip for reuse.");

/** 能不能挂滤镜:视频 / 图片段(不是卡片、不是声音、不是剪辑段) */
export function filterableClip(p: Project, c: TrackClip | null | undefined): c is TrackClip {
  if (!c || !c.mediaId || c.cardId) return false;
  const m = p.media.find((x) => x.id === c.mediaId);
  return !!m && m.kind !== "audio";
}

const stepOf = (spec: FilterParamSpec) => {
  const span = spec.max !== undefined && spec.min !== undefined ? spec.max - spec.min : Math.abs(spec.default) || 1;
  return span <= 2 ? 0.01 : span <= 20 ? 0.1 : 1;
};

/** 一块彩色样片套上滤镜(片段 1 秒处的样子),同桌面滤镜组的样片 */
export function FilterSwatch({ def }: { def: FilterDef }) {
  const css = cssFilter(resolveOps(def, undefined, 1, 2), 0.25);
  return <div className="fx-swatch" aria-hidden="true" style={{ filter: css || undefined }} />;
}

const run = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

/** 卡片库「滤镜」分类 */
export function FiltersGrid() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const toast = useToast();
  const confirm = useConfirm();
  const filters = project.filters ?? [];
  const sel = selection[0] ? findClip(project, selection[0])?.clip : null;
  const target = filterableClip(project, sel) ? sel : null;
  return (
    <>
      {filters.length > 0 && <div className="hint" data-pcm="filters-hint">
        {target ? tr("Tap a filter to apply it to the selected clip (one per clip, it replaces the existing one); tap again to remove it.") : tr("First select a video or image in the thumbnail timeline, then tap a filter to apply it.")}
      </div>}
      {filters.length === 0 ? <div className="hint" data-pcm="filters-empty">{FILTERS_EMPTY_LONG}</div> : (
        <div className="grid">
          {filters.map((f) => {
            const on = !!target && target.filter?.id === f.id;
            const uses = usesOf(project, f.id);
            return (
              <div key={f.id} className={on ? "tile fx picked" : "tile fx"} data-pcm="filter" data-filter={f.id} data-on={on ? "1" : undefined}>
                <button type="button" className="fx-pick" disabled={!target} data-pcm="filter-apply" onClick={() => {
                  if (!target) { toast(tr("Select a video or image first")); return; }
                  const err = run(() => tools.applyFilter({ clipId: target.id, filterId: on ? "" : f.id }));
                  toast(err ?? (on ? tr("Detached \"{0}\" from the selected clip", f.name) : tr("Attached \"{0}\" to the selected clip", f.name)));
                }}>
                  <div className="pic"><FilterSwatch def={f} />{isAnimated(f) && <span className="st">{tr("Changes over time")}</span>}</div>
                  <div className="cap">{f.name}<small title={describeFilter(f)}>{uses.length ? tr("Used on {0} clips · ", uses.length) : ""}{describeFilter(f)}</small></div>
                </button>
                <button type="button" className="fx-del" data-pcm="filter-del" aria-label={tr("Delete filter \"{0}\"", f.name)} onClick={() => confirm({
                  text: uses.length ? tr("\"{0}\" is used on {1} clips; deleting it removes it from those clips too. Delete?", f.name, uses.length) : tr("Delete \"{0}\" from the filter library?", f.name),
                  ok: tr("Delete"), danger: true,
                  run: () => { const err = run(() => tools.removeFilter({ filterId: f.id, force: uses.length > 0, reason: "User deleted it in the mobile app card library" })); toast(err ?? tr("Deleted \"{0}\"", f.name)); },
                })}>×</button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** 调整面板里素材段的「滤镜」一栏 */
export function ClipFilterFields({ clip }: { clip: TrackClip }) {
  const filters = useStore((s) => s.project.filters) ?? [];
  const [err, setErr] = useState<string | null>(null);
  const cur = clip.filter ? filters.find((f) => f.id === clip.filter!.id) : undefined;
  const apply = (filterId: string, params?: Record<string, number>) => setErr(run(() => tools.applyFilter({ clipId: clip.id, filterId, params })));
  return (
    <div data-pcm="clip-filter">
      <div className="field"><label>{tr("Filter")}</label>
        <select className="text-in" data-pcm="clip-filter-select" value={cur?.id ?? ""} onChange={(e) => apply(e.target.value)}>
          <option value="">{tr("None")}</option>
          {filters.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>
      {filters.length === 0 && <div className="hint" data-pcm="clip-filter-empty">{FILTERS_EMPTY_SHORT}</div>}
      {cur && <div className="hint">{describeFilter(cur)}</div>}
      {cur?.params && Object.entries(cur.params).map(([k, spec]) => {
        const value = clip.filter?.params?.[k] ?? spec.default;
        const commit = (n: unknown) => {
          const x = Number(n);
          if (!Number.isFinite(x)) return;
          // 只带声明过的键:删掉过的参数还留在片段上的话,整栏都会被「没有参数 X」卡住(同桌面)
          const kept = Object.fromEntries(Object.entries(clip.filter?.params ?? {}).filter(([key]) => cur.params && key in cur.params));
          apply(cur.id, { ...kept, [k]: x });
        };
        return spec.min !== undefined && spec.max !== undefined
          ? <Slider key={k} label={spec.label ?? k} pcm={`clip-filter-param-${k}`} value={value} min={spec.min} max={spec.max} step={stepOf(spec)} unit="" onCommit={commit} />
          : <ControlField key={k} ctl={{ key: k, label: spec.label ?? k, type: "number" }} value={value} onCommit={commit} />;
      })}
      {err && <div className="hint err" data-pcm="clip-filter-err">{err}</div>}
    </div>
  );
}
