/**
 * The parent-page half of K6 automatic rebalancing (downgrade only, never upgrade).
 *
 * The stage side (`checkDemote` in `StageView`) computes a one-second window, picks the light card
 * with the largest cumulative measured time in this window, and posts `{ type: 'demote', clipId }`;
 * this side does four things:
 *
 *  1. Look up `identityKey` from the clipId (`costs` is content-addressed and the records have no
 *     clipId), and get the **old record**;
 *  2. **PUT the whole record** `{ ...old record, capped: true, demoted: true }`: `costs-store`
 *     replaces whole records, and `validRecord` requires `identityKey` + `device`, so sending only a
 *     few fields would be rejected; keep the old values of the measured values, do not write `null`;
 *     **use only the `demoted` flag**, do not write `pinnedHeavy`;
 *  3. Merge in place into the `costs` that `planDispatch` holds: `planPipelines` treats `demoted` as
 *     `capped`, so this card is judged heavy at every position and merged into the prerender set.
 *     **Both ends recompute on their own**: on the page side that is `setPlan`; on the prerender
 *     process side, `forwardToPrerender` of `vite-plugin-costs` forwards the same PUT over;
 *  4. Record it in `pendingDemote` (`snapshotFeed`): **until the dead assets are ready, keep live
 *     rendering as usual** (the picture the user sees does not change, it may just be slower), and
 *     only on the next tick after they are ready does it switch into `suppressed` / `snapshots`.
 *
 * `demoted` only takes effect for this session: the next time the project is opened, the rule in
 * `probeRunner` that "skips only when a record exists and `demoted !== true`" makes this card be
 * probed again, and the probe explicitly writes back `demoted: false`.
 */
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import { getState } from "../store/project";
import { clipIdentityOf } from "./costIdentity";
import { currentCosts, mergePlanCosts } from "./planDispatch";
import { markPendingDemote } from "./snapshotFeed";

/** Cards already downgraded in this session (do not PUT repeatedly for the same card) */
const demoted = new Set<string>();

export function demotedClips(): ReadonlySet<string> {
  return demoted;
}

/** The acceptance check probe needs to see whether this was really written */
export interface DemoteResult {
  ok: boolean;
  clipId: string;
  identityKey?: string;
  reason?: string;
}

export async function onStageDemote(clipId: string): Promise<DemoteResult> {
  if (demoted.has(clipId)) return { ok: true, clipId, reason: "already" };
  const project = getState().project;
  const identityKey = clipIdentityOf(project).identityKeys[clipId];
  if (!identityKey) return { ok: false, clipId, reason: "no-identity" };
  const old = currentCosts().find((r) => r.identityKey === identityKey);
  if (!old) return { ok: false, clipId, identityKey, reason: "no-record" };
  demoted.add(clipId);
  // Keep live rendering as usual until ready (pinned rendering 6: the downgrade does not take effect immediately)
  markPendingDemote(clipId);
  const next: CardCostRecord = { ...old, capped: true, demoted: true };
  // Merge into the copy in hand first: setPlan recomputes immediately, no need to wait for the PUT round trip
  mergePlanCosts([next]);
  try {
    const res = await fetch("/api/data/costs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [next] }),
    });
    return { ok: res.ok, clipId, identityKey, ...(res.ok ? {} : { reason: `http ${res.status}` }) };
  } catch (err) {
    return { ok: false, clipId, identityKey, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** For tests */
export function resetDemote(): void {
  demoted.clear();
}
