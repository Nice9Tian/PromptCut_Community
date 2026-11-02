import { useEffect, useState } from "react";
import type { JSX } from "react";
import { closeSkillMode, subscribeSkill } from "../skill/skillMode";
import { onlinePage } from "../online/pageFlag";
import { onlineUnsupported } from "../online/onlineUnsupported";
import "./ModeSwitch.css";
import { tr } from "../i18n/index.ts";

/**
 * The working mode switch in the top bar: Vibe mode / Classic mode / SKILL (`user-workflow.md`, section
 * "Working mode").
 *
 * It is built as **one whole control** rather than three independent buttons: the modes are one mutually
 * exclusive choice, and whichever slot the slider rests on is the one in effect.
 *
 *   * Vibe mode: without opening the editor, you talk to the Agent to get the video made (it has the same
 *     name in the glossary).
 *     **It is a destination, not a state** -- a person in the editor cannot be in Vibe mode at the same
 *     time, so the slider never rests on this slot; clicking it means leaving the editor and returning to
 *     the Vibe mode screen (clicking a project card from there goes back to Classic mode).
 *   * Classic mode: the user and the Agent in the AI panel do the work; sessions of the desktop app are
 *     blocked by the SKILL gate (`server/skill-gate.mjs`).
 *   * SKILL: the Agent in the desktop app connects directly to this project through MCP (plan
 *     `docs/plan/agent-workflow-plan.md` A4), and the AI panel remains available as usual.
 *     Entering SKILL goes through the "SKILL…" dialog (register with Claude Code / Codex, view connected
 *     sessions, enter SKILL); to exit, click "Classic mode" here, since this control is the nearest at hand.
 *
 * Originally there were only the two slots Classic mode and SKILL (earlier still there was a "chat"
 * layout slot, now removed). The Vibe mode slot was added on 2026-10-23: before that there was no such
 * working mode in the semantics, and after adding it the glossary has three. When first added, that screen
 * existed only in the online browser, and the slot was grayed out in the desktop app; on the same day the
 * desktop app's Vibe mode was also built (`src/start/DesktopStart.tsx`), so both sides can click it.
 */

type Mode = "vibe" | "classic" | "skill";

/**
 * Compile-time constant of the online build (for how it is written and why, see "online build pruning"
 * in `src/online/pageFlag.ts`). Online pages cannot enter SKILL mode (this slot is grayed out, and
 * `skillMode.ts` does not poll either); the subscription and exit are pruned in the online build,
 * together with the /api calls behind `skillMode.ts` (M8 leftover L24).
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

// The order follows the table in `user-workflow.md`, section "Working mode": Vibe mode, Classic mode, SKILL
const ITEMS: { id: Mode; label: string; hint: string }[] = [
  { id: "vibe", label: tr("Vibe mode"), hint: tr("Make the video by talking to the Agent, without opening the editor") },
  { id: "classic", label: tr("Classic mode"), hint: tr("You and the Agent in the AI panel edit together") },
  { id: "skill", label: "SKILL", hint: tr("The Agent in the desktop app edits this project via MCP") },
];

export function ModeSwitch(props: { onOpenSkill: () => void; onEnterVibe?: () => void }): JSX.Element {
  const [skillOn, setSkillOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => (ONLINE_BUILD ? undefined : subscribeSkill((s) => setSkillOn(s.state.active))), []);

  const active: Mode = skillOn ? "skill" : "classic";

  const pick = async (id: Mode) => {
    if (id === "vibe") {
      // Leave the editor and return to the Vibe mode screen. Confirmation of unsaved changes is in TopBar's
      // goHome, shared with "back to the start page"
      props.onEnterVibe?.();
      return;
    }
    if (id === "skill") {
      // Entering SKILL (or, when already in SKILL, viewing connected sessions and registering) all happens in
      // the dialog
      props.onOpenSkill();
      return;
    }
    if (id === active || ONLINE_BUILD) return;
    // Switching back to Classic mode = exiting SKILL mode: afterwards, tool calls from desktop app sessions
    // are all rejected
    setBusy(true);
    try {
      await closeSkillMode("user");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const index = ITEMS.findIndex((i) => i.id === active);

  // Both sides now have the Vibe mode screen (online `src/start/OnlineStart.tsx`, desktop
  // `src/start/DesktopStart.tsx`, added to the desktop app on 2026-10-23). It is grayed out only when the
  // caller gives no destination -- that is a place where this key is not yet wired up
  const vibeOff = !props.onEnterVibe;

  /** Hover description for each slot. With three slots a nested ternary became unreadable, so it is split out */
  const titleOf = (item: (typeof ITEMS)[number], on: boolean): string => {
    if (item.id === "vibe") {
      return vibeOff ? tr("Can't reach the Vibe mode screen from here yet") : item.hint;
    }
    if (item.id === "skill") {
      if (!on && onlinePage()) return onlineUnsupported(tr("SKILL mode"));
      return on
        ? tr("Currently in SKILL mode. Click here to see the connected desktop app sessions; click \"Classic mode\" to exit")
        : tr("Open the SKILL dialog: register with Claude Code / Codex, enter SKILL mode");
    }
    return item.hint;
  };

  return (
    <div className="pc-modeswitch" role="group" aria-label={tr("Working mode")} data-pc="mode-switch">
      {/* Slider: absolutely positioned, translated by the index of the selected item. The three slots have equal
 * width and the slider is one slot wide, so translating by index times its own width lines it up */}
      <span
        className={`pc-modeswitch-thumb${active === "skill" ? " is-skill" : ""}`}
        style={{ transform: `translateX(${index * 100}%)` }}
        aria-hidden="true"
      />
      {ITEMS.map((item) => {
        const on = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            data-pc={`mode-${item.id}`}
            className={`pc-modeswitch-item${on ? " is-on" : ""}`}
            aria-pressed={on}
            // Online browser mode: SKILL needs the local desktop app and editor process (C10 contract section 10), so grayed out
            disabled={busy || (item.id === "skill" && !on && onlinePage()) || (item.id === "vibe" && vibeOff)}
            title={titleOf(item, on)}
            onClick={() => void pick(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
