/**
 * Candidate selection (design 4.3 last paragraph, section 7 "Fairness", contract B.3).
 *
 * Sorting: priority tier (`normal` precedes `backfill`, c10a contract section 17) → plan precedes
 * fine-grained task → rank within tier (integer `priority` descending) → `source.publishedAt`
 * ascending → `id` ascending (compared by code units, results are locale-independent).
 * Only pick within the top tier: while `normal` is still claimable, do not touch any `backfill`
 * (semantics "prerender retries are queued behind").
 * [ruling 2026-09-28] (lead session; found in notebook M7-A4): within a tier, only pick within the top
 * integer rank: while anchor frame segments (50) are claimable, do not touch any regular segments (10).
 * Previously picked randomly among top K without distinguishing ranks, mixing anchor frame segments
 * with regular segments, so anchor frame priority had almost no effect.
 * [ruling 2026-10-01] (`claude/m7-race`; found during M7-A10 card racing): within the same tier, plan tasks
 * (`kind: 'plan'`) precede fine-grained tasks ahead of integer rank: fine-grained tasks only exist after
 * plan splitting; when a plan is queued behind backlog fine-grained tasks on this node, newly modified
 * cards must wait until backlog completes before tasks appear, leaving pure browser nodes that cannot
 * split idle during this period (measured 224-295 s). Splitting itself takes one or two seconds. Tier still
 * ranks first, so prerender retry plans still follow all normal tasks.
 * Then randomly pick one to claim among top K of this rank: if all nodes contest the first, they collide
 * into a series of `taken`.
 * When `lastProjectId` is given, switch projects first at same priority (rotation when multiple projects
 * share a render host).
 *
 * Pure function; random source injected by caller, can be fixed for tests.
 */

const priorityOf = task => (Number.isFinite(task?.priority) ? task.priority : 0);
/**
 * Priority tier: only `'backfill'` ranks behind; default, integer, and `'normal'` are all normal
 * (omitted by older clients)
 */
const bandOf = task => (task?.priority === 'backfill' ? 1 : 0);
/** Within the same tier, plan tasks precede fine-grained tasks ([ruling] see file header) */
const classOf = task => (task?.kind === 'plan' ? 0 : 1);
// Those without published timestamps (TaskInput not yet entered the queue) rank last at same priority
const publishedAtOf = task => (Number.isFinite(task?.source?.publishedAt) ? task.source.publishedAt : Infinity);
const idOf = task => String(task?.id ?? '');

function compare(a, b) {
  const byBand = bandOf(a) - bandOf(b);
  if (byBand) return byBand;
  const byClass = classOf(a) - classOf(b);
  if (byClass) return byClass;
  const byPriority = priorityOf(b) - priorityOf(a);
  if (byPriority) return byPriority;
  const pa = publishedAtOf(a), pb = publishedAtOf(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  const ia = idOf(a), ib = idOf(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** New array, does not mutate arguments. */
export function rankCandidates(tasks) {
  return [...(tasks ?? [])].sort(compare);
}

/** → Task or `null`. `random()` values in `[0, 1)`. */
export function pickCandidate(tasks, { k = 4, random = Math.random, lastProjectId = null } = {}) {
  if (!tasks?.length) return null;
  const ranked = rankCandidates(tasks);
  // Only pick within the top tier, top class (plan / fine-grained task), and top integer rank
  // (do not touch backfill while normal remains; do not touch regular segments 10 while anchor frame
  // segments 50 remain, [ruling] see file header)
  const head = bandOf(ranked[0]);
  const headClass = classOf(ranked[0]);
  const headRank = priorityOf(ranked[0]);
  const top = ranked.filter(task => bandOf(task) === head && classOf(task) === headClass && priorityOf(task) === headRank).slice(0, Math.max(1, Math.floor(Number(k) || 0)));
  let candidates = top;
  if (lastProjectId != null) {
    const headPriority = priorityOf(top[0]);
    const rotated = top.filter(task => priorityOf(task) === headPriority && task.source?.projectId !== lastProjectId);
    if (rotated.length) candidates = rotated;
  }
  const index = Math.floor(random() * candidates.length);
  return candidates[Math.min(candidates.length - 1, Math.max(0, index))] ?? null;
}
