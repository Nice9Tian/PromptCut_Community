/**
 * Light/heavy judgment before the Cloud Agent publishes prerender (semantics `product/agent.md`
 * "You can leave after sending a task": the host's render node generates the track stream of the
 * **modified heavy cards** for members' preview; `product/rendering.md` "Light card, heavy card":
 * light vs. heavy is decided by measurement).
 *
 * The Agent service does not measure cards itself (it has no stage; `mechanism/rendering.md` "How
 * multi-project mode works": light vs. heavy is measured only in the editor page on the user's
 * device). The measurements it can get are the **shared cost records** in the document service
 * (`mechanism/document-service.md` "Cost records", the copy the page writes after measuring).
 * The judgment follows the same procedure as the online page, with no separate numbers:
 *
 * - clip → cost identity: `clipIdentityOf` in `costIdentity.ts` (the same one the page's probe and
 *   dispatch table use; cards inside a cut segment get an identity by the virtual clip of the
 *   flattened view);
 * - each card's time: the median of the records of the same identity (from different environments)
 *   (`representativeCosts` in `boundarySearch.mjs`, the representative time of the boundary search);
 * - dispatch: `planPipelines` in `pipelinePlan.mjs` (budget B, cost multiplier, greedy by position,
 *   frame-pushing cards and 3D views are all in there); the fixed cost per beat of each heavy card
 *   is taken as the frame-swap cost of the online dual stage (`layerSwapMs` in `swapCost.ts`, the
 *   same one `Preview` hands to `planDispatch`);
 * - if this identity has no record but **the same card** (same card id, same source version;
 *   parameters, length and frame rate arbitrary) has records under other identities, estimate from
 *   those records: treat them as this identity's records and take the median as in the previous
 *   item (the [ruling] in `mechanism/agent.md` "Only publish heavy cards"). Each time the Agent
 *   changes a parameter it gets a new identity,
 *   and if the online member's page has not finished measuring, use the measurement from before the
 *   change (or from another clip of the same card in the project), rather than judging everything
 *   heavy as "no record".
 *   The identity of "the same card" comes from the project at this moment, plus the project states
 *   seen earlier in this chat that the caller recorded (`opts.sameCard`, computed by `cardIdentityGroups`);
 * - only if the same card has no record at all, fall back to `clipWeight`: those that declared
 *   `direct` are judged light, the rest heavy (the same rule as before the page finishes measuring);
 *   cards not defined in the server registry (a user card bundled with the project that has not been
 *   registered yet, an unknown card) have no identity and no declaration, are all judged heavy, and
 *   are sent as before.
 *
 * The result is the intersection of `prerenderSet` (cards judged heavy at any position) and the
 * candidate clips. This file is loaded in the Agent service through the loading seam of ssr-host
 * (`HEAVY_JUDGE_MODULE` in `server/agent/service/render-clips.mjs`); the page does not use it.
 */
import type { Project } from "../kernel/project";
import { flatPlanProject } from "../kernel/cutFlatten.mjs";
import { representativeCosts } from "../render/boundarySearch.mjs";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import { planPipelines } from "../render/pipelinePlan.mjs";
import { resolveTuning } from "../render/pipelineTuning.mjs";
import { clipIdentityOf, sourceVersionsOf } from "./costIdentity";
import { layerSwapMs } from "./swapCost";

/** One entry returned by the document service `cost.list` (only these two fields are used) */
export interface SharedCostLike {
  identityKey: string;
  stepMs: number;
}

/** Key of "the same card": card id + source version (parameters, length, frame rate are not part of the key); cards not in the registry have no key */
function cardGroupOf(cardId: unknown, versions: Record<string, string>): string | null {
  if (typeof cardId !== "string" || !cardId) return null;
  const v = versions[cardId];
  return typeof v === "string" ? `${cardId}\u0000${v}` : null;
}

/** Each clip with a cost identity in the flattened view → its "same card" key */
function clipGroups(project: Project, identityKeys: Record<string, string>): Map<string, string> {
  const versions = sourceVersionsOf();
  const out = new Map<string, string>();
  for (const tr of flatPlanProject(project).tracks) for (const c of tr.clips) {
    if (!identityKeys[c.id]) continue;
    const g = cardGroupOf((c as { cardId?: unknown }).cardId, versions);
    if (g) out.set(c.id, g);
  }
  return out;
}

/**
 * The cost identities that each card (card id + source version) in this project has had. The caller
 * (the gate in `render-clips.mjs`) records one copy at the start of work and after every write, and
 * hands it back at judgment time as `opts.sameCard`: the identity from before a parameter change
 * (most likely already having a record measured by the page) is kept this way.
 */
export function cardIdentityGroups(project: Project | null): Record<string, string[]> {
  if (!project) return {};
  const { identityKeys } = clipIdentityOf(project);
  const out: Record<string, string[]> = {};
  for (const [clipId, g] of clipGroups(project, identityKeys)) {
    const list = (out[g] ??= []);
    if (!list.includes(identityKeys[clipId])) list.push(identityKeys[clipId]);
  }
  return out;
}

/**
 * @param project the project after the write (the active cut is at top level; cards inside a cut segment are judged by the virtual clip id of the flattened view)
 * @param records this project's shared cost records (`records` of `cost.list`)
 * @param candidates ids of the candidate clips to publish this time (picked by `render-clips.mjs`)
 * @param opts.sameCard identities of the same card in project states seen earlier (the result of `cardIdentityGroups`, entries with the same key merged)
 * @returns those judged heavy (`heavy`) and those judged light (`light`) among the candidates, each
 *   keeping the candidates' order; candidates not in the flattened view go in neither.
 *   `estimated` is the candidates whose time was estimated from other identities of the same card
 *   (whether judged light or heavy), for diagnostics
 */
export function judgeHeavyClips(project: Project | null, records: readonly SharedCostLike[] | null | undefined, candidates: readonly string[],
  opts: { sameCard?: Record<string, readonly string[]> | null } = {}): { heavy: string[]; light: string[]; estimated: string[] } {
  if (!project || !candidates.length) return { heavy: [], light: [], estimated: [] };
  const list = records ?? [];
  // Shared records only have the single-frame time (`clipWeight` recognizes only a few fields: without `kind` / `seekOk` / `catchUpMs`, a frame-pushing card is counted as able to catch up within one beat, weight = stepMs)
  const exact = representativeCosts(list);
  const { identityKeys, frameModes } = clipIdentityOf(project);
  // Identities of the same card: the ones in the project now + the ones seen earlier
  const groupOfClip = clipGroups(project, identityKeys);
  const members = new Map<string, Set<string>>();
  const add = (g: string, k: string) => { let s = members.get(g); if (!s) members.set(g, (s = new Set())); s.add(k); };
  for (const [clipId, g] of groupOfClip) add(g, identityKeys[clipId]);
  for (const [g, keys] of Object.entries(opts.sameCard ?? {})) for (const k of keys ?? []) if (typeof k === "string") add(g, k);
  // Identity with no record: the records of other identities of the same card count as its own, with the same median
  const estimatedKeys = new Map<string, number>();
  for (const [clipId, g] of groupOfClip) {
    const k = identityKeys[clipId];
    if (exact.has(k) || estimatedKeys.has(k)) continue;
    const peers = members.get(g)!;
    const borrowed = list.filter((r) => r && r.identityKey !== k && peers.has(r.identityKey)).map((r) => ({ identityKey: k, stepMs: r.stepMs }));
    const v = representativeCosts(borrowed).get(k);
    if (typeof v === "number") estimatedKeys.set(k, v);
  }
  const costs = [...exact, ...estimatedKeys].map(([identityKey, stepMs]) => ({ identityKey, stepMs })) as unknown as CardCostRecord[];
  const fps = Math.max(1, Number(project.fps) || 30);
  const planned = flatPlanProject(project);
  const plan = planPipelines(planned, costs, fps, {
    tuning: resolveTuning(null), identityKeys, frameModes,
    deadMs: (clipId: string) => layerSwapMs(project, clipId),
  });
  const present = new Set(planned.tracks.flatMap((tr) => tr.clips.map((c) => c.id)));
  const heavy: string[] = [];
  const light: string[] = [];
  const estimated: string[] = [];
  for (const id of candidates) {
    if (!present.has(id)) continue;
    (plan.prerenderSet.has(id) ? heavy : light).push(id);
    if (estimatedKeys.has(identityKeys[id])) estimated.push(id);
  }
  return { heavy, light, estimated };
}
