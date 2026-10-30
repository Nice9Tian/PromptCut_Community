import { useState } from "react";
import { actions } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import type { Control, PartInstance } from "../../kernel/types";
import { addPart, findPart, movePart, removePart, updatePart } from "../../kernel/parts";
import { allParts, getPart } from "../../kernel/partRegistry";
import { NumberField } from "../fields/NumberField";

/**
 * 组合卡的参数面板:一棵部件实例树,每个实例可以改参数、框、进场时机、次序,也能加减部件。
 *
 * 和 ParamsForm 的区别:ParamsForm 面对的是「一张卡的扁平参数」,这里面对的是「一棵树」。
 * 所有改动都走 kernel/parts.ts 的纯函数算出新树再 setClipParts,和 Agent 的 add_part / set_part 一条路。
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
          title="从部件库里加一个部件到这张卡"
        >
          <option value="">+ 加部件…</option>
          {allParts().map((p) => (
            <option key={p.id} value={p.id}>{p.name} · {p.role}</option>
          ))}
        </select>
      </div>
      {tree.length === 0 && <div className="px-4 py-3 text-center pc-left-muted">这张组合卡还是空的,从上面挑一个部件加进来</div>}
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
        <button type="button" className="pc-left-faint w-4" onClick={() => setOpen((o) => !o)} aria-label={open ? "收起" : "展开"}>{open ? "▾" : "▸"}</button>
        <span className="flex-1 truncate pc-left-strong font-medium" title={`${inst.partId} · ${inst.id}`}>{inst.label || def?.name || inst.partId}</span>
        <span className="text-[10px] pc-left-faint">{def?.role ?? "?"}</span>
        <button type="button" className={btn} disabled={index === 0} onClick={() => commit(() => movePart(tree, inst.id, { parentId, index: index - 1 }))} title="往下一层(先画)">↑</button>
        <button type="button" className={btn} disabled={index >= count - 1} onClick={() => commit(() => movePart(tree, inst.id, { parentId, index: index + 1 }))} title="往上一层(后画)">↓</button>
        <button type="button" className={`${btn} is-danger-hover`} onClick={() => commit(() => removePart(tree, inst.id))} title="删掉这个部件(连子部件)">✕</button>
      </div>
      {open && (
        <div className="flex flex-col gap-1 px-2 pb-2">
          <div className="flex items-center gap-1 pc-left-muted flex-wrap">
            <span className="w-8">框</span>
            <span>x</span><NumberField className={num} value={frame?.x ?? 0} onCommit={(v) => setFrame("x", v)} />
            <span>y</span><NumberField className={num} value={frame?.y ?? 0} onCommit={(v) => setFrame("y", v)} />
            <span>w</span><NumberField className={num} value={frame?.w} placeholder="满" validate={(v) => v > 0} onCommit={(v) => setFrame("w", v)} />
            <span>h</span><NumberField className={num} value={frame?.h} placeholder="满" validate={(v) => v > 0} onCommit={(v) => setFrame("h", v)} />
            <button type="button" className={btn} onClick={() => set({ frame: null })} title="清掉框,铺满父框">铺满</button>
          </div>
          <div className="flex items-center gap-1 pc-left-muted">
            <span className="w-8">进场</span>
            <NumberField className={num} min={0} step={50} value={inst.enterMs ?? 0} onCommit={(v) => set({ enterMs: Math.max(0, v) })} />
            <span>ms</span>
            <span className="ml-2">名字</span>
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
              title="加一个子部件(它的框相对这个部件的框)"
            >
              <option value="">+ 子部件…</option>
              {allParts().map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

/** 一行控件:和 ParamsForm 同一套类型,但值的读写走部件实例而不是 clip.params */
function ControlRow({ ctrl, value, onChange }: { ctrl: Control; value: unknown; onChange: (v: unknown) => void }) {
  const cls = "flex-1 pc-left-input is-sm";
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 shrink-0 text-[11px] pc-left-muted truncate" title={ctrl.hint ? `${ctrl.label}:${ctrl.hint}` : ctrl.label}>{ctrl.label}</div>
      {ctrl.type === "text" && <input type="text" className={cls} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />}
      {ctrl.type === "number" && <NumberField className={cls} value={Number(value ?? 0)} min={ctrl.min} max={ctrl.max} step={ctrl.step} onCommit={onChange} />}
      {ctrl.type === "select" && (
        <select className="flex-1 pc-left-select is-sm" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {ctrl.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {ctrl.type === "color" && (
        <div className="flex flex-1 items-center gap-1">
          <input type="color" value={/^#([0-9A-Fa-f]{3}){1,2}$/.test(String(value ?? "")) ? String(value) : "#ffffff"} onChange={(e) => onChange(e.target.value)} className="pc-left-color is-sm" />
          <input type="text" className={cls} value={String(value ?? "")} placeholder="留空用主题色" onChange={(e) => onChange(e.target.value)} />
        </div>
      )}
      {ctrl.type === "asset" && (
        <select className="flex-1 pc-left-select is-sm" value={ctrl.options.some((o) => o.value === String(value ?? "")) ? String(value) : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">— 不用素材 —</option>
          {ctrl.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </div>
  );
}
