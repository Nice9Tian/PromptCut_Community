import { useMemo, useState } from "react";
import { actions, useStore } from "../../../store/project";
import { listCuts } from "../../../kernel/cuts";
import { clearDragPayload, MIME_CUT, setDragPayload } from "../../dnd";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu";
import { ConfirmDialog } from "../ConfirmDialog";
import { IconFilm, openCutInTimeline } from "../../timeline/CutTabs";
import { fmtDur } from "./mediaGroups";
import type { GroupData, GroupItem } from "./groups";
import { useReadOnly } from "../../readOnly";
import "../../timeline/cut-tabs.css";
import { tr } from "../../../i18n/index.ts";
import { shownName } from "../../../i18n/names.ts";

/**
 * 素材库的「剪辑」组(`workflow/materials.md`「素材库里的剪辑」,2026-10-20 用户定)。
 *
 * 项目里的每条剪辑一格,显示名字与时长:
 *   - 单击:在时间轴上方打开它的标签并激活(`openCutInTimeline`);
 *   - 拖到时间轴的序列上:在激活剪辑里放一个引用它的剪辑段(放进自己、会循环引用时落点预览写明原因、不接受);
 *   - 悬停按钮 / 右键:改名、删除(最后一条不能删;被别的剪辑引用着时先说明被哪些剪辑用着,确认后连同引用它的剪辑段一起删,可撤销);
 *   - 组详情顶上「新建剪辑」。
 */

type Row = ReturnType<typeof listCuts>[number];

function describeRefs(row: Row): string {
  return row.referencedBy.map((r) => tr("\"{0}\" ({1} clips)", r.name, r.clipIds.length)).join(tr(", "));
}

export function useCutsGroup(q: string, flash: (text: string, ms?: number) => void): { data: GroupData; overlay: React.ReactNode } {
  const project = useStore((s) => s.project);
  // 这个项目只给了只读权限(游客):新建 / 改名 / 删除 / 打开(切换激活的剪辑)/ 拖进时间轴都是写
  const ro = useReadOnly();
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const rows = useMemo(() => listCuts(project), [project]);

  const askDelete = (row: Row) => {
    if (rows.length <= 1) { flash(tr("This is the last cut and cannot be deleted"), 3000); return; }
    setConfirm(row);
  };

  const data = useMemo<GroupData>(() => {
    const hits = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
    const items: GroupItem[] = hits.map((r) => ({
      id: r.id,
      aspect: 9 / 16,
      node: (
        <CutTile row={r} canDelete={rows.length > 1} renaming={renaming === r.id} locked={ro.locked} why={ro.why}
          onRename={() => setRenaming(r.id)} onRenamed={() => setRenaming(null)} onDelete={() => askDelete(r)}
          onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, id: r.id }); }} />
      ),
    }));
    const thumbs: GroupItem[] = hits.slice(0, 2).map((r) => ({ id: r.id, aspect: 9 / 16, node: <CutThumb row={r} /> }));
    return {
      items,
      thumbs,
      detailTop: (
        <button type="button" className="pc-btn-primary is-block pc-lib-cut-new" data-pc="lib-cut-add"
          disabled={ro.locked} title={ro.title()}
          onClick={() => { const cut = actions.addCut(undefined, { switchTo: false }); openCutInTimeline(cut.id); }}>
          {tr("New cut")}
        </button>
      ),
      emptyHint: tr("No cuts yet"),
      emptyDetail: <div className="pc-left-note">{tr("No matching cuts")}</div>,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, renaming, ro.locked]);

  const menuItems = (id: string): ContextMenuItem[] => {
    const row = rows.find((r) => r.id === id);
    if (!row) return [];
    const off = ro.locked ? { disabled: true, title: ro.why } : null;
    return [
      { label: tr("Open on the timeline"), onClick: () => openCutInTimeline(id), ...off },
      { label: tr("Rename"), onClick: () => setRenaming(id), ...off },
      {
        label: tr("Delete cut"), danger: true, disabled: rows.length <= 1,
        title: rows.length <= 1 ? tr("This is the last cut and cannot be deleted") : undefined,
        onClick: () => askDelete(row),
        ...off,
      },
    ];
  };

  const overlay = (
    <>
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={menuItems(ctx.id)} onClose={() => setCtx(null)} />}
      {confirm && (
        <ConfirmDialog
          open={true}
          title={tr("Delete cut")}
          message={confirm.referencedBy.length
            ? tr("Cut \"{0}\" is in use by these cuts: {1}.\nIf you confirm, it is deleted together with the cut segments that reference it. This can be undone.", confirm.name, describeRefs(confirm))
            : tr("Delete cut \"{0}\"?{1}\nThis can be undone.", confirm.name, confirm.clipCount ? tr("\nIt contains {0} items.", confirm.clipCount) : "")}
          confirmText={tr("Delete")}
          onConfirm={() => {
            try {
              const { removedSegments } = actions.removeCut(confirm.id);
              const n = removedSegments.reduce((s, r) => s + r.clipIds.length, 0);
              flash(n ? tr("Deleted \"{0}\" and the {1} cut segments that reference it (undoable)", confirm.name, n) : tr("Deleted \"{0}\" (undoable)", confirm.name), 3000);
            } catch (err) {
              flash(err instanceof Error ? err.message : String(err), 4000);
            }
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
  return { data, overlay };
}

function CutThumb({ row }: { row: Row }) {
  return (
    <div className={`pc-lib-cut${row.active ? " is-on" : ""}`} aria-hidden="true">
      <span className="pc-lib-cut-name">{shownName(row.name)}</span>
      <span className="pc-lib-cut-meta">{fmtDur(row.duration)}</span>
    </div>
  );
}

function CutTile({ row, canDelete, renaming, locked, why, onRename, onRenamed, onDelete, onContextMenu }: {
  row: Row; canDelete: boolean; renaming: boolean;
  /** 只读项目(游客):不接点击 / 拖动 / 改名 / 删除;why 是置灰说明 */
  locked: boolean; why: string;
  onRename: () => void; onRenamed: () => void; onDelete: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [draft, setDraft] = useState(row.name);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== row.name) actions.renameCut(row.id, next);
    onRenamed();
  };
  const refs = row.referencedBy.length ? tr("\nReferenced by {0}", describeRefs(row)) : "";
  return (
    <div
      className={`pc-lib-cut${row.active ? " is-on" : ""}`}
      data-pc-lib-cut={row.id}
      role="button"
      tabIndex={0}
      draggable={!renaming && !locked}
      aria-disabled={locked || undefined}
      title={locked ? `${shownName(row.name)} · ${fmtDur(row.duration)}${refs}\n${why}` : tr("{0} · {1}{2}\nClick to open on the timeline, drag onto a track to place a cut segment", shownName(row.name), fmtDur(row.duration), refs)}
      onClick={() => { if (!renaming && !locked) openCutInTimeline(row.id); }}
      onKeyDown={(e) => { if (!locked && !renaming && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openCutInTimeline(row.id); } }}
      onContextMenu={onContextMenu}
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME_CUT, row.id);
        e.dataTransfer.effectAllowed = "copy";
        setDragPayload({ kind: "cut", cutId: row.id, name: row.name, duration: Math.max(0.1, row.duration) });
      }}
      onDragEnd={() => clearDragPayload()}
    >
      <span className="pc-tl-cut-glyph" style={{ position: "absolute", top: 8, left: 8 }}><IconFilm size={12} /></span>
      {renaming ? (
        <input className="pc-tl-cut-input" value={draft} autoFocus aria-label={tr("Cut name")}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(); else if (e.key === "Escape") onRenamed(); }}
          onClick={(e) => e.stopPropagation()} />
      ) : (
        <span className="pc-lib-cut-name">{shownName(row.name)}</span>
      )}
      <span className="pc-lib-cut-meta">
        {tr("{0} · {1} segments{2}{3}", fmtDur(row.duration), row.clipCount, row.active ? tr(" · current") : "", row.referencedBy.length ? tr(" · referenced {0}", row.referencedBy.length) : "")}
      </span>
      <span className="pc-lib-cut-acts">
        <button type="button" className="pc-lib-cut-act" data-pc="lib-cut-rename" title={locked ? why : tr("Rename")} aria-label={tr("Rename {0}", shownName(row.name))}
          disabled={locked}
          onClick={(e) => { e.stopPropagation(); onRename(); }}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12z" /></svg>
        </button>
        <button type="button" className="pc-lib-cut-act" data-pc="lib-cut-delete" disabled={!canDelete || locked}
          title={locked ? why : canDelete ? tr("Delete this cut") : tr("This is the last cut and cannot be deleted")} aria-label={tr("Delete {0}", shownName(row.name))}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></svg>
        </button>
      </span>
    </div>
  );
}
