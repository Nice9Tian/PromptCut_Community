import { useState } from "react";
import { actions } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import type { Control, PartInstance } from "../../kernel/types";
import { addPart, findPart, movePart, removePart, updatePart } from "../../kernel/parts";
import { allParts, getPart } from "../../kernel/partRegistry";
import { NumberField } from "../fields/NumberField";
import { tr } from "../../i18n/index.ts";

/**
 * Parameters panel for a composite card: a tree of part instances; each instance can have its parameters,
 * frame, entrance timing and order changed, and parts can be added or removed.
 *
 * Difference from ParamsForm: ParamsForm deals with "the flat parameters of one card", while this deals with
 * "a tree". All changes compute a new tree with the pure functions in kernel/parts.ts and then call
 * setClipParts, the same path as the Agent's add_part / set_part.
 */
export function PartsForm({ clip }: { clip: TrackClip }) {
  const tree = clip.parts ?? [];
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);

  const commit = (fn: () => PartInstance[]) => {
    try {
      actions.setClipParts(clip.id, fn());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onAdd = (partId: string, parentId: string | null = null) => {
    if (!partId) return;
    commit(() => addPart(tree, { partId }, getPart, { parentId }).tree);
    setAdding("");
  };

  return (
    <div className="flex flex-col gap-2 py-2 text-xs">
      <div className="flex items-center gap-2 px-3">
        <select
          data-pc="parts-add"
          value={adding}
          onChange={(e) => onAdd(e.target.value)}
          className="flex-1 pc-left-select"
          title={tr("Add a part from the part library to this card")}
        >
          <option value="">{tr("+ Add part…")}</option>
          {allParts().map((p) => (
            <option key={p.id} value={p.id}>{p.name} · {p.role}</option>
          ))}
        </select>
      </div>
      {tree.length === 0 && <div className="px-4 py-3 text-center pc-left-muted">{tr("This composite card is still empty. Pick a part from above to add it")}</div>}
      <PartList clip={clip} tree={tree} list={tree} depth={0} commit={commit} />
      {error && <div className="mx-3 px-2 py-1 rounded border border-red-900 bg-red-950/40 text-red-400 whitespace-pre-wrap">{error}</div>}
    </div>
  );
}

function PartList({ clip, tree, list, depth, commit }: { clip: TrackClip; tree: PartInstance[]; list: PartInstance[]; depth: number; commit: (fn: () => PartInstance[]) => void }) {
  return (
    <>
      {list.map((inst, i) => (
        <PartRow key={inst.id} clip={clip} tree={tree} inst={inst} index={i} count={list.length} depth={depth} commit={commit} />
      ))}
    </>
  );
}

function PartRow({ clip, tree, inst, index, count, depth, commit }: { clip: TrackClip; tree: PartInstance[]; inst: PartInstance; index: number; count: number; depth: number; commit: (fn: () => PartInstance[]) => void }) {
  const def = getPart(inst.partId);
  const [open, setOpen] = useState(true);
  const parentId = findPart(tree, inst.id)?.parentId ?? null;
  const merged = { ...(def?.defaults ?? {}), ...inst.params };
  const set = (patch: Parameters<typeof updatePart>[2]) => commit(() => updatePart(tree, inst.id, patch, getPart).tree);
  const frame = inst.frame;
  const setFrame = (k: "x" | "y" | "w" | "h", v: number) => set({ frame: { x: frame?.x ?? 0, y: frame?.y ?? 0, ...(frame?.w ? { w: frame.w } : {}), ...(frame?.h ? { h: frame.h } : {}), ...(frame?.anchor ? { anchor: frame.anchor } : {}), ...(frame?.scale ? { scale: frame.scale } : {}), ...(frame?.rotate ? { rotate: frame.rotate } : {}), [k]: v } });
  const num = "w-16 pc-left-input is-sm";
  const btn = "pc-left-btn is-sm";

  return (
    <div data-pc-part-row={inst.id} className="pc-left-box" style={{ marginLeft: 12 + depth * 12, marginRight: 12 }}>
      <div className="flex items-center gap-1 px-2 py-1">
        <button type="button" className="pc-left-faint w-4" onClick={() => setOpen((o) => !o)} aria-label={open ? tr("Collapse") : tr("Expand")}>{open ? "▾" : "▸"}</button>
        <span className="flex-1 truncate pc-left-strong font-medium" title={`${inst.partId} · ${inst.id}`}>{inst.label || def?.name || inst.partId}</span>
        <span className="text-[10px] pc-left-faint">{def?.role ?? "?"}</span>
        <button type="button" className={btn} disabled={index === 0} onClick={() => commit(() => movePart(tree, inst.id, { parentId, index: index - 1 }))} title={tr("Move down one layer (drawn first)")}>↑</button>
        <button type="button" className={btn} disabled={index >= count - 1} onClick={() => commit(() => movePart(tree, inst.id, { parentId, index: index + 1 }))} title={tr("Move up one layer (drawn later)")}>↓</button>
        <button type="button" className={`${btn} is-danger-hover`} onClick={() => commit(() => removePart(tree, inst.id))} title={tr("Delete this part (including child parts)")}>✕</button>
      </div>
      {open && (
        <div className="flex flex-col gap-1 px-2 pb-2">
          <div className="flex items-center gap-1 pc-left-muted flex-wrap">
            <span className="w-8">{tr("Box")}</span>
            <span>x</span><NumberField className={num} value={frame?.x ?? 0} onCommit={(v) => setFrame("x", v)} />
            <span>y</span><NumberField className={num} value={frame?.y ?? 0} onCommit={(v) => setFrame("y", v)} />
            <span>w</span><NumberField className={num} value={frame?.w} placeholder={tr("full")} validate={(v) => v > 0} onCommit={(v) => setFrame("w", v)} />
            <span>h</span><NumberField className={num} value={frame?.h} placeholder={tr("full")} validate={(v) => v > 0} onCommit={(v) => setFrame("h", v)} />
            <button type="button" className={btn} onClick={() => set({ frame: null })} title={tr("Clear the frame and fill the parent frame")}>{tr("Fill")}</button>
          </div>
          <div className="flex items-center gap-1 pc-left-muted">
            <span className="w-8">{tr("Enter")}</span>
            <NumberField className={num} min={0} step={50} value={inst.enterMs ?? 0} onCommit={(v) => set({ enterMs: Math.max(0, v) })} />
            <span>ms</span>
            <span className="ml-2">{tr("Name")}</span>
            <input type="text" className="flex-1 pc-left-input is-sm" value={inst.label ?? ""} placeholder={def?.name} onChange={(e) => set({ label: e.target.value })} />
          </div>
          {(def?.controls ?? []).map((ctrl) => (
            <ControlRow key={ctrl.key} ctrl={ctrl} value={merged[ctrl.key]} onChange={(v) => set({ params: { [ctrl.key]: v } })} />
          ))}
          {inst.children?.length ? <PartList clip={clip} tree={tree} list={inst.children} depth={depth + 1} commit={commit} /> : null}
          {depth < 3 && (
            <select
              value=""
              onChange={(e) => { if (e.target.value) commit(() => addPart(tree, { partId: e.target.value }, getPart, { parentId: inst.id }).tree); }}
              className="pc-left-select is-sm pc-left-faint"
              title={tr("Add a child part (its frame is relative to this part's frame)")}
            >
              <option value="">{tr("+ Child part…")}</option>
              {allParts().map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

/** One row of controls: same types as ParamsForm, but values are read and written through the part instance rather than clip.params */
function ControlRow({ ctrl, value, onChange }: { ctrl: Control; value: unknown; onChange: (v: unknown) => void }) {
  const cls = "flex-1 pc-left-input is-sm";
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 shrink-0 text-[11px] pc-left-muted truncate" title={ctrl.hint ? `${tr(ctrl.label)}: ${tr(ctrl.hint)}` : tr(ctrl.label)}>{tr(ctrl.label)}</div>
      {ctrl.type === "text" && <input type="text" className={cls} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />}
      {ctrl.type === "number" && <NumberField className={cls} value={Number(value ?? 0)} min={ctrl.min} max={ctrl.max} step={ctrl.step} onCommit={onChange} />}
      {ctrl.type === "select" && (
        <select className="flex-1 pc-left-select is-sm" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {ctrl.options.map((o) => <option key={o.value} value={o.value}>{tr(o.label)}</option>)}
        </select>
      )}
      {ctrl.type === "color" && (
        <div className="flex flex-1 items-center gap-1">
          <input type="color" value={/^#([0-9A-Fa-f]{3}){1,2}$/.test(String(value ?? "")) ? String(value) : "#ffffff"} onChange={(e) => onChange(e.target.value)} className="pc-left-color is-sm" />
          <input type="text" className={cls} value={String(value ?? "")} placeholder={tr("Leave empty to use the theme color")} onChange={(e) => onChange(e.target.value)} />
        </div>
      )}
      {ctrl.type === "asset" && (
        <select className="flex-1 pc-left-select is-sm" value={ctrl.options.some((o) => o.value === String(value ?? "")) ? String(value) : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">{tr("— No media —")}</option>
          {ctrl.options.map((o) => <option key={o.value} value={o.value}>{tr(o.label)}</option>)}
        </select>
      )}
    </div>
  );
}
