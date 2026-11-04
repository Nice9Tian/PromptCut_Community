import { useEffect, useRef, useState } from "react";
import { setScript, useScript } from "../../../ai/script";
import { useDockSide } from "../../dock/dockSide";
import { CollapsePanelButton } from "./CollapsePanelButton";
import "./chat.css";
import { tr } from "../../../i18n/index.ts";

/**
 * Script page: an independent item on the rail (it used to be a popup), on the right by default, and
 * can also be dragged to the left.
 *
 * While editing, only a local draft changes, and it is written into the store only when Save is clicked:
 * having it half-edited and read by the AI midway would be a worse experience.
 *
 * The page stays mounted (display:none when not in front), so there is no moment of "fetch the latest
 * from the store on every open". Instead: when there are no unsaved changes, the draft follows the store
 * as soon as it changes (the AI edited the script in the previous turn);
 * when there are unsaved changes it is left alone and only a notice is shown, and the user decides
 * whether to save and overwrite or to discard and switch to the new version.
 */
export function ScriptPage(props: { active: boolean }) {
  const { active } = props;
  const side = useDockSide("right");
  const saved = useScript();
  const [draft, setDraft] = useState(saved);
  /** Which version the draft was edited from. Equal to the draft = the user hasn't touched it */
  const [base, setBase] = useState(saved);
  const [justSaved, setJustSaved] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const dirty = draft !== base;
  /** While the user was editing, the script in the store was replaced elsewhere (by the AI) */
  const stale = saved !== base;

  useEffect(() => {
    if (saved === base || dirty) return;
    setDraft(saved);
    setBase(saved);
    // Follow only the store; dirty / base read at this moment are the latest values
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  // Put focus into the editing area when switching in from another page. Don't steal focus on first mount: when a refresh happens to land on the script page, focus should stay where it was
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) textRef.current?.focus();
    wasActive.current = active;
  }, [active]);

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [justSaved]);

  const save = () => {
    setScript(draft);
    setBase(draft);
    setJustSaved(true);
  };
  const revert = () => {
    setDraft(saved);
    setBase(saved);
  };

  return (
    <section className="pc-script-page" data-pc="script-page" aria-label={tr("Script")} style={{ display: active ? undefined : "none" }}>
      {/* The top bar and the assistant tab's ChatHeader have the same height and padding: "Collapse panel"
          stays in the same position when switching tabs. The collapse button follows the side it is on:
          placed on the far left on the right side, and on the far right on the left side */}
      <div className={`pc-script-head${side === "left" ? " is-left" : ""}`}>
        <CollapsePanelButton placement="start" />
        <span className="pc-section-title">{tr("Script")}</span>
        <span className="pc-script-count">{tr("{0} characters", draft.length)}</span>
        <CollapsePanelButton placement="end" />
      </div>
      <div className="pc-script-body">
        <p className="pc-script-hint">
          {tr("Write down what this video is about and in what order. It is attached to the AI's system prompt ")}<b>{tr("every turn")}</b>{tr(", to pull multi-turn runs back on track; leave empty to attach nothing.")}
        </p>
        {stale && dirty && (
          <div className="pc-script-note" role="status">
            {tr("The script was just changed by the AI. Saving will overwrite it with your version; click \"Undo changes\" to switch to the new one.")}
          </div>
        )}
        <textarea
          ref={textRef}
          className="pc-script-text"
          data-pc="script-text"
          aria-label={tr("Script content")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter saves, consistent with the input boxes elsewhere
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              if (dirty) save();
            }
          }}
          spellCheck={false}
          placeholder={tr("e.g.\n1. Open with the pain point in 5 seconds, using a quote card\n2. Middle follows \"problem → data → solution\", with a trend chart in the data part\n3. Close by echoing the opening line")}
        />
        <div className="pc-script-actions">
          {justSaved && <span className="pc-script-saved" role="status">{tr("Saved")}</span>}
          <button type="button" className="pc-script-btn" disabled={!draft} onClick={() => setDraft("")}>{tr("Clear")}</button>
          <button type="button" className="pc-script-btn" disabled={!dirty} onClick={revert}>{tr("Undo changes")}</button>
          <button type="button" className="pc-btn-primary pc-script-save" data-pc="script-save" disabled={!dirty} title="Ctrl+Enter" onClick={save}>
            {tr("Save")}
          </button>
        </div>
      </div>
    </section>
  );
}
