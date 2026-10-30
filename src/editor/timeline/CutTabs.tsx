import { useEffect, useRef, useState } from "react";
import { actions, getState, useStore } from "../../store/project";
import { listCuts } from "../../kernel/cuts";
import { closeTab, openTab, openTabs, saveTabs, setTabs, useCutTabsVersion } from "./cutTabsState";
import { memberReadOnlyNow } from "../readOnlyCore";
import { useReadOnly } from "../readOnly";
import "./cut-tabs.css";

/** 胶片:圆角方块里一格画面,两侧各三个齿孔 */
export function IconFilm({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="1.6" />
      <path d="M5 2v12M11 2v12" />
      <path d="M2 5h3M2 8h3M2 11h3M11 5h3M11 8h3M11 11h3" strokeWidth="1.1" />
    </svg>
  );
}

/**
 * 在时间轴上方打开并激活一条剪辑(素材库单击剪辑、双击时间轴上的剪辑段都走这里)。
 * 标签留着,直到用户点它的「×」。
 */
export function openCutInTimeline(cutId: string): void {
  // 哪条剪辑是激活的(`activeCutId`)是项目里的字段:切换是个写。只读项目(游客)里不切,免得白被服务端拒
  if (memberReadOnlyNow()) return;
  const p = getState().project;
  const ids = (p.cuts ?? []).map((c) => c.id);
  if (!ids.includes(cutId)) return;
  if (p.id) openTab(p.id, ids, p.activeCutId, cutId);
  if (p.activeCutId !== cutId) actions.switchCut(cutId);
}

/**
 * 时间轴上方的剪辑标签栏(`workflow/editing.md`「剪辑标签」,2026-10-20 用户定)。
 *
 * 每条打开过的剪辑一个标签:单击切换激活的剪辑,双击改名,「×」只关标签、不删剪辑,最后一个标签不能关
 * (「×」不画,悬停说明为什么)。尾部「+」新建一条剪辑并打开。标签不会因为失去焦点、点了别处、切了面板而消失。
 * 删剪辑在素材库的「剪辑」组里做。
 *
 * 打开了哪几条是本机界面状态(`cutTabsState.ts`),不进项目文档。
 * 以前左侧竖栏尾部的剪辑组(CutsRailGroup)按 Argon 审核意见撤掉:剪辑入口只留素材库剪辑组和这里两处。
 */
export function CutTabBar() {
  const project = useStore((s) => s.project);
  useCutTabsVersion();
  const cuts = listCuts(project);
  const ids = cuts.map((c) => c.id);
  const active = project.activeCutId;
  const projectId = project.id ?? "";
  const tabs = openTabs(projectId, ids, active);
  const [editing, setEditing] = useState<string | null>(null);
  const ro = useReadOnly();

  // 和项目对齐后的结果写回本地存储(激活的补进来、删掉的拿掉)
  const key = tabs.join("|");
  useEffect(() => {
    if (projectId) saveTabs(projectId, tabs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key]);

  const byId = new Map(cuts.map((c) => [c.id, c]));
  const close = (id: string) => {
    // 只读:关激活的那个标签要顺带切到相邻的剪辑(一个写),不给;关别的标签只是界面上收起来,照常
    if (ro.locked && id === active) return;
    const r = closeTab(tabs, id, active);
    if (!r) return;
    setTabs(projectId, r.tabs);
    if (r.switchTo) actions.switchCut(r.switchTo);
  };

  return (
    <div className="pc-tl-cuts" data-pc="cut-tabs" role="tablist" aria-label="打开的剪辑">
      {tabs.map((id) => {
        const c = byId.get(id);
        if (!c) return null;
        return (
          <Tab key={id} id={id} name={c.name} active={c.active} canClose={tabs.length > 1} locked={ro.locked} why={ro.why}
            editing={editing === id} onEdit={() => setEditing(id)} onDone={() => setEditing(null)}
            onClose={() => close(id)} />
        );
      })}
      <button type="button" className="pc-tl-cut-add" data-pc="cut-add" title={ro.title("新建剪辑并打开")} aria-label="新建剪辑" disabled={ro.locked}
        onClick={() => {
          const cut = actions.addCut(undefined, { switchTo: false });
          openCutInTimeline(cut.id);
        }}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
    </div>
  );
}

function Tab({ id, name, active, canClose, locked, why, editing, onEdit, onDone, onClose }: {
  id: string; name: string; active: boolean; canClose: boolean;
  /** 只读项目:切换(改激活的剪辑)、改名都不给;why 是置灰说明 */
  locked: boolean; why: string;
  editing: boolean; onEdit: () => void; onDone: () => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(name);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, name]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) actions.renameCut(id, next);
    onDone();
  };
  return (
    <div className={`pc-tl-cut${active ? " is-on" : ""}`} data-pc-cut-tab={id}>
      <div
        role="tab"
        tabIndex={0}
        aria-selected={active}
        className="pc-tl-cut-main"
        title={editing ? undefined : locked ? `${name}\n${why}` : `${name}\n单击切换,双击改名`}
        aria-disabled={locked && !active ? true : undefined}
        onClick={() => { if (!locked && !editing && !active) actions.switchCut(id); }}
        onDoubleClick={() => { if (!locked) onEdit(); }}
        onKeyDown={(e) => {
          if (!locked && !editing && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); if (!active) actions.switchCut(id); }
        }}
      >
        <span className="pc-tl-cut-glyph"><IconFilm /></span>
        {editing ? (
          <input ref={inputRef} className="pc-tl-cut-input" value={draft} aria-label="剪辑名"
            onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(); else if (e.key === "Escape") onDone(); }}
            onClick={(e) => e.stopPropagation()} />
        ) : (
          <span className="pc-tl-cut-name">{name}</span>
        )}
      </div>
      {canClose ? (
        <button type="button" className="pc-tl-cut-x" data-pc="cut-tab-close" title={locked && active ? why : "关闭这个标签(不删剪辑)"} aria-label={`关闭 ${name} 的标签`}
          disabled={locked && active}
          onClick={(e) => { e.stopPropagation(); onClose(); }}>
          ×
        </button>
      ) : (
        <span className="pc-tl-cut-x is-off" title="最后一个标签不能关" aria-hidden="true" />
      )}
    </div>
  );
}
