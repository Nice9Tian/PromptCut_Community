/**
 * The side panel on the right of the chat page (user decision, 2026-10-23): the button at the top right
 * of the title bar toggles it.
 *
 * Sections can all be collapsed: the form follows the IDE panel picture the user gave (section title +
 * one row per line inside), and the content follows terms already used in the software:
 *   1. **Picture**: this project's real picture (`VibeStage.tsx`, i.e. the editor's preview), with the
 *      playback bar overlaid on the picture; at the top right of the section header is "Detail editing";
 *   2. **This change**: the user asked to archive it first (see `SHOW_CHANGES` below);
 *   2b. **Chat** (user decision, 2026-10-26, issue #4): a card **newly created** only while "Detail
 *      editing" is expanded (`ExtChatPanel.tsx`). Detail editing takes up the whole chat area (the input
 *      box included), so the chat moves into this rail;
 *      it takes the height left over in this rail, and the two sections above spread out as usual.
 *      Collapsing detail editing makes this card disappear with it.
 *   3. **Before / after**: changes in this chat that carry before and after pictures (the picture
 *      records the Agent leaves each time it creates, edits or deletes a card,
 *      `useVisualRecord` in `src/editor/right/ToolVisual.tsx`, fetched through the Cloud Agent service
 *      with the permissions of the current chat); pick one and flip between them.
 *      The two tabs are named after "Before" and "After" in `src/editor/right/chat/OpDetailPreview.tsx`.
 *
 * 2026-10-23: connected to the business layer (`docs/reports/AGENT-claude-vibe-wire.md`). When the
 * picture record cannot be fetched, the reason is stated truthfully; no placeholder image is shown.
 */
import { useMemo, useState } from "react";
import type { JSX } from "react";
import type { ChatMessage } from "../ai/types";
import { actions, useStore } from "../store/project";
import { useVisualRecord, visualIdOf } from "../editor/right/ToolVisual";
import { KIND_LABEL, bareToolName, toolKind } from "../editor/right/chat/iconRuns";
import { partsOf } from "../mobile/agentView";
import { ExtChatPanel } from "./ExtChatPanel";
import { EXT_WIDTH } from "./sideWidth";
import { VibeStage, mmss } from "./VibeStage";
import { WidthGrip } from "./WidthGrip";
import { tr } from "../i18n/index.ts";

/**
 * The "This change" section is archived first and not shown by default: **this was requested by the user
 * on 2026-10-23**. The user's reason: changes are already shown in the bubble of each chat (the "Agent
 * actions" block under the Agent message), so listing them again on the right is a duplicate.
 * The record is also in `docs/plan/user-decisions-2026-10-23.md`. This section was not connected when the
 * business layer was wired (it is not shown anyway); ask the user before adding it back.
 */
const SHOW_CHANGES = false;

function section(key: string, title: string, open: boolean, toggle: () => void, body: JSX.Element, right?: JSX.Element): JSX.Element {
  return (
    // The hook name carries `sec-`: without it the "Picture" section would collide on the same name with the play button inside it (`start-ext-play`)
    <section className="ps-ext-sec" data-pc={`start-ext-sec-${key}`} data-open={open}>
      <div className="ps-card-head">
        <button type="button" className="ps-card-toggle" aria-expanded={open} onClick={toggle}>
          <span className="ps-card-caret" data-open={open} aria-hidden="true">›</span>
          {title}
        </button>
        {right}
      </div>
      {open && <div className="ps-ext-body">{body}</div>}
    </section>
  );
}

/** Changes in this chat that left a picture record (three kinds: added / deleted / modified), newest first */
interface DiffEntry {
  key: string;
  visualId: string;
  kind: string;
  tool: string;
}
function diffEntries(messages: readonly ChatMessage[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    partsOf(m).forEach((p, i) => {
      if (p.kind !== "tool" || p.ok !== true) return;
      const k = toolKind(p.name);
      if (k !== "add" && k !== "remove" && k !== "edit") return;
      const vid = visualIdOf(p.summary);
      if (vid) out.push({ key: `${m.id}:${i}`, visualId: vid, kind: KIND_LABEL[k], tool: bareToolName(p.name) });
    });
  }
  return out.reverse();
}

function DiffView(props: { entry: DiffEntry }): JSX.Element {
  const { rec, err } = useVisualRecord(props.entry.visualId);
  const [side, setSide] = useState<"before" | "after">("after");
  if (err) return <p className="ps-ext-todo" title={err}>{tr("Cannot get the visual for this step: {0}", err)}</p>;
  if (!rec) return <p className="ps-ext-todo">{tr("Getting the picture for this step…")}</p>;
  const before = rec.before?.gif ?? null;
  const after = rec.after?.gif ?? null;
  if (!before && !after) return <p className="ps-ext-todo">{tr("This step only changed parameters, so there are no before/after pictures.")}</p>;
  const src = side === "before" ? before : after;
  return (
    <>
      <div className="ps-ext-seg" role="group" aria-label={tr("View before or after the change")}>
        {(["before", "after"] as const).map((s) => (
          <button key={s} type="button" className="ps-ext-seg-btn" data-pc={`start-ext-${s}`} aria-pressed={side === s}
            disabled={!(s === "before" ? before : after)} onClick={() => setSide(s)}>
            {s === "before" ? tr("Before") : tr("After")}
          </button>
        ))}
      </div>
      <div className="ps-ext-frame ps-ext-frame-img">
        {src ? <img src={src} alt={side === "before" ? tr("Before") : tr("After")} /> : <span className="ps-muted">{side === "before" ? tr("Newly added, no before version") : tr("Deleted, no after version")}</span>}
        <span className="ps-ext-frame-tag">{side === "before" ? tr("Before") : tr("After")}</span>
      </div>
      {rec.diff && rec.diff.length > 0 && (
        <p className="ps-ext-note" title={rec.diff.map((d) => `${d.key}: ${d.from} → ${d.to}`).join("\n")}>
          {rec.diff.slice(0, 3).map((d) => tr("{0}: {1} → {2}", d.key, d.from, d.to)).join(tr(";"))}
        </p>
      )}
    </>
  );
}

export function ChatSidePanel(props: {
  /** Messages of this chat: before / after finds the changes with picture records here */
  messages: readonly ChatMessage[];
  /** "Detail editing" is expanded: the stage is over there, so a second copy is not mounted here */
  detailOpen: boolean;
  /**
   * When detail editing is expanded and this rail is open, a new chat panel (`ExtChatPanel.tsx`) is
   * created here; if the user collapses this rail it is `null`, and the input box drops back to the bottom
   * of the chat column (user decision, 2026-10-26).
   */
  chatPanel: { composer: JSX.Element; whyNot: string | null; onBack: () => void } | null;
  onNote: (text: string) => void;
  /** The "Detail editing" button in the "Picture" section header: expands the editing view that fills the chat area (`DetailEdit.tsx`) */
  onDetail: () => void;
  /** Width: draggable like the left rail, and remembered on this machine */
  width: number;
  onWidth: (px: number) => void;
  onWidthCommit: (px: number) => void;
  onWidthNudge: (delta: number) => void;
}): JSX.Element {
  const [open, setOpen] = useState({ play: true, changes: true, diff: true });
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const duration = useStore((s) => s.project.duration);
  const diffs = useMemo(() => diffEntries(props.messages), [props.messages]);
  const [picked, setPicked] = useState<string | null>(null);
  const pickedEntry = diffs.find((d) => d.key === picked) ?? diffs[0] ?? null;

  return (
    <aside className="ps-ext" data-pc="start-ext" style={{ flexBasis: `${props.width}px` }}>
      {/* The seam on the left: no line normally, it lights up only when the mouse presses on it */}
      <WidthGrip spec={EXT_WIDTH} side="left" width={props.width} label={tr("Side panel width")} pc="start-ext-grip"
        onWidth={props.onWidth} onWidthCommit={props.onWidthCommit} onWidthNudge={props.onWidthNudge} />
      {section(
        "play",
        tr("Video"),
        open.play,
        () => setOpen((o) => ({ ...o, play: !o.play })),
        props.detailOpen ? (
          <p className="ps-ext-todo">{tr("The picture is being shown in \"Detail editing\".")}</p>
        ) : (
          // The playback bar is overlaid on the picture (user decision, 2026-10-23): saves the height of the bar under the frame
          <VibeStage className="ps-ext-frame" pc="start-ext-stage">
            <div className="ps-stage-over">
              <button type="button" className="ps-ext-play" data-pc="start-ext-play" aria-label={playing ? tr("Pause") : tr("Play")} onClick={() => actions.togglePlay()}>
                {playing ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.6 19 12 7 19.4z" /></svg>
                )}
              </button>
              <div className="ps-ext-transport">
                <input type="range" className="ps-ext-scrub" data-pc="start-ext-scrub" min={0} max={Math.max(0.1, duration)} step={0.05}
                  value={Math.min(t, duration)} aria-label={tr("Progress")} onPointerDown={() => window.getSelection()?.removeAllRanges()} onChange={(e) => actions.seek(Number(e.target.value))} />
                <span className="ps-ext-time">{mmss(t)} / {mmss(duration)}</span>
              </div>
            </div>
          </VibeStage>
        ),
        // The button at the top right of the section header: this used to be the fullscreen button in the frame; the user replaced it with this on 2026-10-23
        <button type="button" className="ps-ext-action" data-pc="start-ext-detail" onClick={props.onDetail}>{tr("Detail editing")}</button>,
      )}

      {SHOW_CHANGES && section("changes", tr("This change"), open.changes, () => setOpen((o) => ({ ...o, changes: !o.changes })),
        <p className="ps-ext-todo">{tr("(this section is archived, see the file header)")}</p>)}

      {section(
        "diff",
        tr("Before / after"),
        open.diff,
        () => setOpen((o) => ({ ...o, diff: !o.diff })),
        pickedEntry ? (
          <>
            {diffs.length > 1 && (
              <div className="ps-ext-rows" role="listbox" aria-label={tr("Changes with before/after pictures")}>
                {diffs.slice(0, 12).map((d) => (
                  <button key={d.key} type="button" className="ps-ext-row-main" data-pc="start-ext-change" data-picked={d.key === pickedEntry.key || undefined}
                    aria-selected={d.key === pickedEntry.key} onClick={() => setPicked(d.key)}>
                    <span className="ps-ext-row-top"><span className="ps-ext-kind">{d.kind}</span><span className="ps-ext-tool">{d.tool}</span></span>
                  </button>
                ))}
              </div>
            )}
            <DiffView key={pickedEntry.key} entry={pickedEntry} />
          </>
        ) : (
          <p className="ps-ext-todo" data-pc="start-ext-diff-empty">{tr("This chat has no changes with before/after pictures yet.")}</p>
        ),
      )}

      {/* The block newly created when detail editing is expanded: placed last, taking the height left over in this rail */}
      {props.chatPanel && (
        <ExtChatPanel
          messages={props.messages}
          composer={props.chatPanel.composer}
          whyNot={props.chatPanel.whyNot}
          onBack={props.chatPanel.onBack}
        />
      )}
    </aside>
  );
}
