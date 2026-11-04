import { useEffect, useState } from "react";
import { commitDraft, useAgentTabs } from "../../../ai/agentTabs";
import { useReadOnly } from "../../readOnly";
import "./startHero.css";
import { tr } from "../../../i18n/index.ts";

/**
 * The start page of the AI panel (user decision, 2026-10-22, `workflow/editing.md`, "Agent tab of the
 * AI panel"): when this project has no Agent session at all, the placeholder page (the `draft` of
 * `agentTabs`) shows it instead of the message list. The lower half of the page is still the usual
 * input box (Composer); this only handles the message area: one sentence of explanation + one preset
 * button.
 *
 *   - Just entered the project, and the user has never manually closed all sessions in this project:
 *     with a guide animation (a breathing light dot + an arrow pointing at the input box, the input
 *     box outline pulses);
 *   - The user has manually closed all sessions: no animation, only the preset and the input box;
 *   - Click the preset: put the preset sentence into the input box, flash the send button to guide
 *     the user to click send (in both cases);
 *   - The user clicks send: only then does the placeholder page become the first real session
 *     (`commitDraft`); before that no session is created and no request is sent.
 *
 * Under `prefers-reduced-motion` all animations are turned off, leaving only the static outline.
 */
export const START_PRESET = tr("Make an animation that tells me what I can do with the software");

export type StartGuide = "input" | "send" | null;

/**
 * State related to the start page in the panel (this machine's AiPanel / cloud CloudAiPanel):
 * whether this page is the start page, whether to show the guide animation, which of the input box and
 * the send button should be guided right now, and what to do on clicking the preset and on clicking send.
 */
export function useStartPage(tabId: string, inputText: string, setInputText: (v: string | ((prev: string) => string)) => void, focus?: () => void, hasMessages = false) {
  const { tabs, cleared } = useAgentTabs();
  const draft = tabs.find((t) => t.id === tabId)?.draft === true;
  // This page already has a chat (an old chat was opened from the history list, "continue and see" was clicked, or similar, not send): it is already a session, so the placeholder page becomes a real page, to keep the chat from being covered by the start page
  useEffect(() => { if (draft && hasMessages) commitDraft(tabId); }, [draft, hasMessages, tabId]);
  const animated = draft && !cleared;
  const [picked, setPicked] = useState(false);
  const has = inputText.trim().length > 0;
  // Once the input box is cleared, stop nudging to send (the hint from the preset click expires)
  useEffect(() => { if (!has) setPicked(false); }, [has]);
  const guide: StartGuide = !draft ? null : has ? (picked || animated ? "send" : null) : animated ? "input" : null;
  return {
    draft,
    animated,
    guide,
    /** Click the preset: put it into the input box (don't add it again if the box already has this sentence), and nudge to send */
    pickPreset: () => {
      setInputText((prev) => (prev.includes(START_PRESET) ? prev : prev.trim() ? `${prev.replace(/\s+$/, "")}\n${START_PRESET}` : START_PRESET));
      setPicked(true);
      focus?.();
    },
    /** Click send, really sending: the placeholder page becomes the first session. Does nothing when not the start page */
    commit: () => { if (draft) commitDraft(tabId); },
  };
}

export function StartHero(props: { animated: boolean; onPickPreset: () => void }) {
  // This project was given read-only permission only (guest): can't send messages to the Agent, so don't show the "type below" guide animation and preset, only explain why
  const ro = useReadOnly();
  const { onPickPreset } = props;
  const animated = props.animated && !ro.locked;
  if (ro.locked) {
    return (
      <div className="ai-messages pc-start" data-pc="ai-start" data-pc-start-animated="0" data-pc-readonly="1">
        <div className="pc-start-title">{tr("View only")}</div>
        <div className="pc-start-hint">{ro.why}</div>
        <button type="button" className="pc-start-preset" data-pc="ai-start-preset" disabled title={ro.why}>
          {START_PRESET}
        </button>
      </div>
    );
  }
  return (
    <div className={`ai-messages pc-start${animated ? " is-animated" : ""}`} data-pc="ai-start" data-pc-start-animated={animated ? "1" : "0"}>
      {animated && (
        <div className="pc-start-orb" data-pc="ai-start-orb" aria-hidden="true">
          <span className="pc-start-orb-ring" />
          <span className="pc-start-orb-ring pc-start-orb-ring--2" />
          <span className="pc-start-orb-core">✦</span>
        </div>
      )}
      <div className="pc-start-title">{animated ? tr("Start here") : tr("Start")}</div>
      <div className="pc-start-hint">
        {animated ? tr("Write the video you want to make in the box below, or click this line:") : tr("Write what you want to make in the box below, or click this line:")}
      </div>
      <button type="button" className="pc-start-preset" data-pc="ai-start-preset" onClick={onPickPreset}>
        {START_PRESET}
      </button>
      {animated && <div className="pc-start-cue" data-pc="ai-start-cue" aria-hidden="true">⌄</div>}
    </div>
  );
}
