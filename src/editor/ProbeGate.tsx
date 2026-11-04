import { useEffect, useState } from "react";
import { getState, useStore } from "../store/project";
import { previewMode } from "./previewMode";
import { setPlanProject } from "./planDispatch";
import { onProbeProgress, probeProgress, requeueProbeRun, syncProbeRun, type ProbeProgress } from "./probeRunner";
import { whenStageReady } from "./stageBridge";
import { cardsStamp, onCardRunStatesChanged, onCardsUpdated } from "../kernel/registry";
import { whenStagesHaveCards } from "./stageCards";
import { ONLINE } from "../online/mode";
import { singleStageTier } from "../online/onlineTier";
import "./ProbeGate.css";
import { tr } from "../i18n/index.ts";

/**
 * K1's **loading overlay**: when a project is opened, every active card is measured one by one
 * before editing is entered (pinned render 5).
 *
 * - Rendered by `Editor.tsx` at the same level where it renders `<Preview />`. **The overlay does
 *   not start another iframe**: the two stage iframes are mounted by `Preview` as usual (E1), and
 *   the probe runs on the background one.
 * - It covers the whole editor, and **editing operations are blocked**. The overlay during the
 *   loading phase does not count as an interaction stutter for pinned render 1 (the parenthetical
 *   of render 1 has this exception written in).
 * - **Uses only existing theme variables**, introducing no new fixed colors (pinned interaction
 *   2 / 3, see `ProbeGate.css`).
 * - When `costs` all hit, **it never appears for a single frame**: `probeRunner` first pulls the
 *   records once, and when the number of cards to measure is 0, `running` never flips to true and
 *   this component keeps returning `null`.
 * - Cards added afterwards, or cards whose `cardCostKey` changed, are re-measured in the
 *   background; by then `blocking` is already false and the overlay no longer appears (K1: "the
 *   fallback dispatch is used only for the few seconds while a new card hasn't finished being
 *   measured").
 * - **Not mounted under legacy**: everything new in R2~R6 hides behind `?preview=stage`, and the
 *   resident probe needs a real background stage (legacy has only one same-origin stage, and
 *   running the probe on it would pull the picture away from in front of the user).
 */
export function ProbeGate() {
  const project = useStore((s) => s.project);
  // Only `?preview=stage` has a background stage (E1); the default legacy is unaffected by a single character.
  // An online page with two stages open measures as usual (C10 contract, section 3: opening a project finishes measuring under the loading overlay; if the background stage can't handshake and falls back to a single stage, the probe never gets the background stage and the overlay does not appear);
  // if the stage gate stops at the first tier (lean mode, low-spec mode), only one stage is opened and ProbeGate does not run; light vs. heavy is judged by the bound search (`costSearch.ts`)
  const staged = previewMode() === "stage";
  const enabled = staged && !(ONLINE && singleStageTier());
  const [p, setP] = useState<ProbeProgress>(probeProgress);

  useEffect(() => {
    if (!enabled) return;
    return onProbeProgress(setP);
  }, [enabled]);

  /*
   * When the project changes, re-queue according to the new project (K1). The store updates
   * immutably, so an unchanged reference means nothing changed, and `syncProbeRun` itself returns
   * early, so it is not expensive for this effect to run on every project change.
   */
  useEffect(() => {
    if (!staged) return;
    // K2's dispatch table also follows the project (E0's setPlan; `costs` / `tuning` are fed by probeRunner).
    // With only one stage nothing is measured here, but the dispatch table still needs the project: the display table and the bound search's judgment table both rely on it (C10 integration: turn off only measurement, not dispatch)
    setPlanProject(project);
    if (enabled) syncProbeRun(project);
  }, [staged, enabled, project]);

  /*
   * Card code changed (C6.6 section 5 "changed card code must be explicitly re-measured by the page": syncing in
   * a card someone else edited, or editing a card on this machine):
   * the project is unchanged but a card's code changed, so re-arrange one round for the current project and
   * measure the cards whose identity key changed.
   * The signal comes from the registry's `onCardsUpdated` (emitted after `cards/index.ts` takes the hot update
   * and reinstalls the whole set of cards),
   * which fires only after this whole batch of hot updates has landed, so the card source table is already new.
   * The stage does not reload (integration 3b): the RPC client is always there,
   * but we still wait here for the background stage to be ready, so a freshly opened page does not waste a round
   * before the stage has finished its handshake.
   */
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const off = onCardsUpdated(() => {
      // First wait for both stages to switch to this version of the cards (those that haven't will be reloaded), then wait for the background stage to be ready, and only then queue the re-measurement:
      // otherwise we would measure while the background stage still has old cards or is in the middle of swapping cards (measuring old code, or that round gets interrupted and waits for the RPC to time out)
      void whenStagesHaveCards(cardsStamp())
        .then(() => whenStageReady("back"))
        .then(() => { if (active) requeueProbeRun(getState().project); });
    });
    return () => { active = false; off(); };
  }, [enabled]);

  /*
   * The run state of synchronized cards changed (online pages; `docs/plan/online-card-exec-contract.md`,
   * section 6): a card that has just loaded successfully only now has a cost identity. The project
   * is unchanged, so, like a card code change, explicitly re-queue a round, with immediate
   * measurement for those without a record; a new generation (source version changed) is the same.
   * The desktop has no run state and does not trigger this.
   */
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const off = onCardRunStatesChanged(() => {
      void whenStageReady("back").then(() => { if (active) requeueProbeRun(getState().project); });
    });
    return () => { active = false; off(); };
  }, [enabled]);

  if (!enabled || !p.running || !p.blocking) return null;

  const total = Math.max(1, p.total);
  const done = Math.min(p.done, p.total);
  return (
    <div
      className="pc-probe-gate"
      data-pc="probe-gate"
      role="status"
      aria-live="polite"
      // During the overlay, neither mouse nor keyboard should land on the editor underneath
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="pc-probe-gate-ring" aria-hidden="true" />
      <div className="pc-probe-gate-title">{tr("Measuring card {0} / {1}", done + 1, p.total)}</div>
      <div className="pc-probe-gate-bar" aria-hidden="true"><i style={{ width: `${(done / total) * 100}%` }} /></div>
      {p.card && <div className="pc-probe-gate-card">{p.card}</div>}
      {p.failed.length > 0 && <div className="pc-probe-gate-note">{tr("{0} could not be measured, falling back to the declared dispatch", p.failed.length)}</div>}
    </div>
  );
}

export default ProbeGate;
