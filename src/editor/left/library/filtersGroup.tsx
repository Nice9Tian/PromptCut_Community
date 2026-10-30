import { useState } from "react";
import { actions, getState, useStore } from "../../../store/project";
import { findClip } from "../../../kernel/project";
import { cssFilter, describeFilter, isAnimated, resolveOps, type FilterDef } from "../../../kernel/filters.mjs";
import { createFilterTools, usesOf } from "../../right/filterTools";
import { ThumbTile } from "./ThumbTile";
import { useReadOnly } from "../../readOnly";
import type { GroupData, GroupItem } from "./groups";

/** 和 Agent 的 apply_filter / remove_filter 同一份校验(锁定的序列、卡片段、还挂着就删要确认) */
const tools = createFilterTools({ getState, actions });

/** 滤镜色块卡的高宽比:上面一块样片,下面名字、说明和两个按钮 */
const TILE_ASPECT = 0.75;

/** 一块彩色样片套上滤镜(片段 1 秒处的样子),一眼看出冷暖、黑白、糊不糊 */
function Swatch({ def, className }: { def: FilterDef; className?: string }) {
  const css = cssFilter(resolveOps(def, undefined, 1, 2), 0.25);
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        background: "linear-gradient(135deg, #e8553a 0%, #f2c14e 35%, #3fa9f5 70%, #2d6a4f 100%)",
        filter: css || undefined,
      }}
    />
  );
}

/**
 * 特效 → 滤镜组:项目的滤镜库。
 * 滤镜大多是 Agent 用 create_filter 建的;这里让人看得到、能挂到选中的视频 / 图片片段上复用、能删。
 */
export function useFiltersGroup(q: string, flash: (text: string, ms?: number) => void): GroupData {
  // 这个项目只给了只读权限(游客):挂 / 摘滤镜、删滤镜都是写
  const ro = useReadOnly();
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [armed, setArmed] = useState<string | null>(null);
  const filters = project.filters ?? [];
  const sel = selection[0] ? findClip(project, selection[0]) : null;
  const selClip = sel && sel.clip.mediaId && !sel.clip.cardId ? sel.clip : null;

  const run = (fn: () => unknown, ok: string) => {
    try {
      fn();
      flash(ok);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  };

  const hits = q
    ? filters.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          (f.description ?? "").toLowerCase().includes(q) ||
          describeFilter(f).toLowerCase().includes(q),
      )
    : filters;

  const items: GroupItem[] = hits.map((f) => {
    const uses = usesOf(project, f.id);
    const on = !!selClip && selClip.filter?.id === f.id;
    return {
      id: f.id,
      aspect: TILE_ASPECT,
      node: (
        <div data-pc-filter={f.id} className={`pc-lib-fxcard${on ? " is-on" : ""}`}>
          <Swatch def={f} className="pc-lib-fxcard-swatch" />
          <div className="pc-lib-fxcard-body">
            <div className="pc-lib-fxcard-name" title={f.description ?? f.name}>
              <span className="pc-lib-ellipsis">{f.name}</span>
              {isAnimated(f) && <span className="pc-lib-tag">随时间变化</span>}
            </div>
            <div className="pc-lib-fxcard-sub" title={describeFilter(f)}>
              {describeFilter(f)}
              {uses.length ? ` · 用在 ${uses.length} 段` : ""}
            </div>
            <div className="pc-lib-fxcard-actions">
              <button
                type="button"
                className="pc-left-btn"
                disabled={!selClip || ro.locked}
                title={ro.locked ? ro.why : selClip ? (on ? "从选中的片段上摘掉" : "挂到选中的片段上(每段只挂一个,会替换原来的)") : "先在时间轴上选中一段视频或图片"}
                onClick={() =>
                  selClip &&
                  (on
                    ? run(() => tools.applyFilter({ clipId: selClip.id, filterId: "" }), `已从选中的片段摘掉「${f.name}」`)
                    : run(() => tools.applyFilter({ clipId: selClip.id, filterId: f.id }), `已把「${f.name}」挂到选中的片段`))
                }
              >
                {on ? "摘掉" : "挂到选中"}
              </button>
              <button
                type="button"
                className={`pc-left-btn${armed === f.id ? " is-danger" : ""}`}
                disabled={ro.locked}
                title={ro.title(uses.length ? `用在 ${uses.length} 段上,删了会一起摘掉` : "从滤镜库删掉")}
                onClick={() => {
                  if (uses.length && armed !== f.id) {
                    setArmed(f.id);
                    flash(`「${f.name}」用在 ${uses.length} 段上;再点一次「确认删除」会把这些段上的它一起摘掉`);
                    return;
                  }
                  setArmed(null);
                  run(() => tools.removeFilter({ filterId: f.id, force: uses.length > 0, reason: "用户在素材库里删除" }), `已删除「${f.name}」`);
                }}
              >
                {armed === f.id ? "确认删除" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ),
    };
  });

  const thumbs: GroupItem[] = hits.slice(0, 2).map((f) => ({
    id: f.id,
    node: <ThumbTile title={f.name} preview={<Swatch def={f} className="pc-lib-fill" />} />,
  }));

  return {
    items,
    thumbs,
    emptyHint: "让 AI 助手新建滤镜",
    emptyDetail:
      filters.length === 0 ? (
        <div className="pc-left-note">
          还没有滤镜。
          <br />
          让 Agent 建一个(比如「给夜景那几段做个冷色调」),它会出现在这里,之后能挂到任意视频 / 图片片段上复用。
        </div>
      ) : (
        <div className="pc-left-note">没搜到匹配的滤镜。</div>
      ),
  };
}
