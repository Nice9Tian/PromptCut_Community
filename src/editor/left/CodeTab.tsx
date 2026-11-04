import { useState, useRef, useEffect, useMemo } from "react";
import { actions, getState, useStore } from "../../store/project";
import { getCard } from "../../kernel/registry";
import type { TrackClip } from "../../kernel/project";
import { applyEnvelope, describeLifecycle, envelopeOf, type ClipEnvelope } from "../../kernel/envelope";
import { useReadOnly } from "../readOnly";
import { tr } from "../../i18n/index.ts";

/**
 * Edit → Code: shows and edits this card's **card contract** (kernel/envelope.ts), not the raw code.
 *
 * This used to be a flat blob of `{ cardId, start, end, params }` parameters -- position, fade in/out, part
 * structure and lifecycle were not in it, so you couldn't tell "the animation settles after 1 second and
 * everything after is static", "whether a fade-out can be added", or "which parameter controls which part".
 * Now what is shown is the contract: card (including lifecycle) / time / frame (local writable, world
 * read-only) / blend / motion / parts (the part tree, each part with its own parameters) / params. After
 * editing, Ctrl+Enter or blur applies it, writing only the segments that differ, going through the same
 * applyEnvelope as the Agent's set_clip.
 */
export function CodeTab({ clip }: { clip: TrackClip }) {
  const project = useStore((s) => s.project);
  const card = getCard(clip.cardId);
  const envelope = useMemo(
    () => envelopeOf(project, clip, card, { width: project.width, height: project.height }),
    [project, clip, card],
  );
  const current = useMemo(() => JSON.stringify(envelope, null, 2), [envelope]);
  const lastCurrent = useRef(current);

  const [draft, setDraft] = useState(current);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  // This project only grants read-only access (guest): the code can be viewed and selected for copying as usual, but not edited, applied or reset
  const ro = useReadOnly();

  const missing = envelope.missingParams ?? [];
  /** Just applied: when the next current (carrying read-only segments such as the recomputed world) arrives, adopt it directly, and don't leave the user's edited draft as "unapplied" */
  const adoptNext = useRef(false);

  useEffect(() => {
    if (current !== lastCurrent.current) {
      if (draft === lastCurrent.current || adoptNext.current) {
        setDraft(current);
        adoptNext.current = false;
      }
      lastCurrent.current = current;
      setErrorMsg(null);
    }
  }, [current, draft]);

  const dirty = draft !== current;

  const apply = () => {
    if (ro.locked) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e: any) {
      setErrorMsg(tr("Invalid JSON: {0}", e.message));
      return;
    }
    try {
      const report = applyEnvelope(
        getState().project,
        clip.id,
        parsed,
        card,
        { width: project.width, height: project.height },
        {
          setClipCard: (id, cardId) => actions.setClipCard(id, cardId),
          setClipParams: (id, params, opts) => actions.setClipParams(id, params, opts),
          moveClip: (id, patch) => actions.moveClip(id, patch),
          setClipFrame: (id, frame) => actions.setClipFrame(id, frame),
          updateClip: (id, patch) => actions.updateClip(id, patch),
          setClipParts: (id, parts) => actions.setClipParts(id, parts),
        },
        getCard,
      );
      setErrorMsg(null);
      if (report.changed.length) adoptNext.current = true;
      else setDraft(current);
      setApplied(report.changed.length ? tr("Applied: {0}", report.changed.join(" / ")) : tr("No changes"));
      setTimeout(() => setApplied(null), 2000);
    } catch (e: any) {
      setErrorMsg(e?.message || String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ro.locked) return; // Read-only: Tab moves focus as usual and doesn't insert spaces into the draft
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      apply();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const val = el.value;
      const nextVal = val.substring(0, start) + "  " + val.substring(end);
      setDraft(nextVal);
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      }, 0);
    }
  };

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const handleReset = () => {
    if (ro.locked) return;
    // Write back the full set of defaults instead of clearing to {} -- clearing would put the clip back into the implicit state of "relying on fallback rendering",
    // which is exactly what this change is meant to eliminate.
    const defaults = { ...(card?.defaults ?? {}) };
    actions.setClipParams(clip.id, defaults, { merge: false });
    setErrorMsg(null);
  };

  const lifecycleLine = describeLifecycle(envelope);

  return (
    <div className="flex-1 min-h-0 flex flex-col p-3">
      <div className="flex items-center gap-2 mb-2 shrink-0 flex-wrap">
        <span className="text-[11px] pc-left-muted" title={ENVELOPE_TITLE}>{tr("Card contract")}</span>
        <button type="button" onClick={handleCopy} className="pc-left-btn">
          {copied ? tr("✓ Copied") : tr("Duplicate")}
        </button>
        <button type="button" onClick={handleReset} className="pc-left-btn" disabled={ro.locked} title={ro.title()}>
          {tr("Reset parameters to defaults")}
        </button>
        {missing.length > 0 && (
          <button
            type="button"
            onClick={handleReset}
            disabled={ro.locked}
            title={ro.locked ? ro.why : tr("This card gained new parameters later that the current clip does not have: {0}. Click \"Reset parameters to defaults\" to fill them in (this also discards existing changes)", missing.join(", "))}
            className="text-[11px] px-2 py-1 bg-amber-950 hover:bg-amber-900 text-amber-400 rounded border border-amber-800"
          >
            {tr("Missing {0} parameters", missing.length)}
          </button>
        )}
        {applied && <span className="text-[11px] text-green-500 ml-auto">{applied}</span>}
      </div>

      <div data-pc="code-lifecycle" className="mb-1 shrink-0 text-[10px] pc-left-faint truncate" title={lifecycleLine}>
        {lifecycleLine}
      </div>

      {/*
        Which keys frame.local accepts must be **permanently** written out and cannot be tucked into the
        status bar below: that line is a single h-4 row, and only appears when there are "no errors, no
        unapplied changes, and no missing parameters", normally not visible at all. Moreover, those three
        3D items do not appear in the JSON at all when unset; looking at this JSON snippet alone will not
        reveal their existence, yet this page is intended precisely for people who want to write values
        directly.
      */}
      <div className="mb-2 shrink-0 text-[10px] leading-relaxed pc-left-faint">
        {tr("frame.local:x / y / w / h / anchor / scale / rotate, and for 3D: {0}", " ")}
        <span className="pc-left-muted">rotateX / rotateY / translateZ</span>
        {tr("(for 3D, turn on the perspective camera in the \"Parameters\" tab to get near-large/far-small depth, otherwise it is only a skew)")}
      </div>

      <textarea
        data-pc="code-editor"
        value={draft}
        readOnly={ro.locked}
        title={ro.title()}
        onChange={e => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={onKeyDown}
        spellCheck={false}
        className={`pc-left-code flex-1 min-h-0 w-full${errorMsg ? " is-error" : ""}`}
      />

      <div data-pc="code-status" className="mt-2 shrink-0 h-4">
        {errorMsg ? (
          <div className="text-[10px] text-red-500 truncate" title={errorMsg}>{errorMsg}</div>
        ) : dirty ? (
          <div className="text-[10px] pc-left-muted">{tr("Unapplied changes · Ctrl+Enter to apply / applies on blur")}</div>
        ) : missing.length > 0 ? (
          <div className="text-[10px] text-amber-500 truncate" title={missing.join(", ")}>
            {tr("Missing {0} parameters, rendering with defaults as a fallback: {1}", missing.length, missing.join(", "))}
          </div>
        ) : (
          <div className="text-[10px] pc-left-faint">{tr("Editable: card.id / time / frame.local / blend / parts (the whole composite card tree can be added, removed and edited) / params; world, motion, lifecycle are read-only")}</div>
        )}
      </div>
    </div>
  );
}

const ENVELOPE_TITLE = tr("The one canonical outward form of this card: card (including lifecycle), time, frame (position), blend (fade in/out), parts (part tree), params. This is also what the Agent sees and edits with get_clip / set_clip.");

// Keep the unused type import from failing lint (the type is only mentioned in comments)
export type { ClipEnvelope };
