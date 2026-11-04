/**
 * Clips to publish for prerendering after a Cloud Agent write commits (used by manifest plans in
 * `render-request.mjs`).
 *
 * Top-level clips are selected as usual by clip IDs written in this write (`renderableClips`).
 * Cards inside cut segments (user decision, 2026-10-21: cards inside cut segments work the same
 * as without cut segments, with heavy cards each taking their own track streams) are virtual clips
 * in the flattened view on the plan side (`src/kernel/cutFlatten.mjs`, ID
 * `<segment id>~…~<card clip id>`), which render nodes use to produce streams. So we also collect:
 *   - Virtual clips whose paths contain a clip ID written in this write (a card in a referenced
 *     cut was modified, or a cut segment at some layer was modified; at any depth, appearing as
 *     many times as the same cut is referenced);
 *   - Virtual clips whose content changed compared to the previous write or that are newly added
 *     (`before`: signature table after the previous write). For writes such as modifications in
 *     other cuts or switching the active cut, ops cannot specify clip IDs within the active cut,
 *     which can only be detected by comparing the flattened view. When there is no signature table
 *     from the previous write (the first write of this process generation), collect all of them,
 *     preferring to over-dispatch (streams already on render nodes are locked and reused, not
 *     re-produced).
 * Media clips are not collected. For projects without cut segments, the result is item-for-item
 * identical to `renderableClips`. Selected clips are only candidates; those classified as light
 * are removed (see "Only dispatch heavy cards" below).
 *
 * Kernel functions for the flattened view (`flatPlanProject`, etc.) are fetched and injected by the
 * host via the ssr-host loading seam (`kernel` parameter; standalone entry points do not directly
 * import `src/`, `server/test/accept-018-rest-ssr-seam.test.mjs`). When not injected, only top-level
 * clips are selected by clip ID, as before.
 */
import { MEDIA_CARD_IDS, renderableClips } from './render-request.mjs';

/**
 * Location in `src/` for kernel functions needed by the flattened view (loaded by host via
 * `loadModule`)
 */
export const FLAT_KERNEL_MODULE = '/src/kernel/cutFlatten.mjs';

/**
 * Content signatures of each card (virtual clip) in cut segments within the active cut flattened
 * view; returns an empty table if there are no cut segments
 */
export function flatCardSigs(project, kernel = null) {
  const out = new Map();
  if (!project || !kernel || !kernel.hasFlatSegments(project)) return out;
  const { flatPlanProject, isFlatClipId } = kernel;
  for (const tr of flatPlanProject(project).tracks ?? []) {
    if (!tr || tr.hidden || tr.sourceOnly) continue;
    for (const c of tr.clips ?? []) {
      if (!c || !isFlatClipId(c.id) || typeof c.cardId !== 'string' || !c.cardId || MEDIA_CARD_IDS.has(c.cardId)) continue;
      out.set(c.id, JSON.stringify(c));
    }
  }
  return out;
}

/**
 * @param {any} project Project after the write
 * @param {string[]} clipIds Clip IDs written in this write (`clipIdsOfOps` in `user-editing.mjs`)
 * @param {{ kernel?: object | null, before?: Map<string, string> | null, sigs?: Map<string, string> }} [o]
 */
export function renderClipsOf(project, clipIds, { kernel = null, before = null, sigs = flatCardSigs(project, kernel) } = {}) {
  const out = renderableClips(project, clipIds);
  if (!sigs.size) return out;
  const want = new Set(Array.isArray(clipIds) ? clipIds : []);
  const seen = new Set(out);
  for (const [id, sig] of sigs) {
    const hit = id.split(kernel.FLAT_SEP).some((part) => want.has(part)) || !before || before.get(id) !== sig;
    if (hit && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/*
 * ---------------------------------------------------------------- Only dispatch heavy cards
 *
 * Semantics `product/agent.md` "Can leave after submitting tasks": the host's render nodes generate
 * track streams for **modified heavy cards** for member previews. Render nodes treat all clips in
 * the manifest as heavy cards when producing streams (`listPlanOverrides` in
 * `server/render-node/local-node.mjs`), so light cards cannot enter the manifest. Heavy/light
 * classification follows the same rules as online pages (`src/editor/agentHeavyClips.ts`): shared
 * cost records in the document service + `planPipelines`; when this identity has no records, it is
 * first estimated using records of other identities for the same card (same card ID, same source
 * version); if the same card also has no records, fallback to the pre-measurement rules before the
 * page finishes testing (declared `direct` classified as light, all others classified as heavy).
 *
 * Classification is not performed at the exact moment of the write, but after writes accumulate
 * for `delayMs` (using the same debounce as prerender retries, `debounceMs` in
 * `render-request.mjs`): when an Agent modifies parameters, the card's cost identity changes,
 * requiring online members' pages to finish measuring the new identity and write it to the
 * document service before records exist; when no members are online, it cannot wait and estimates
 * based on the same card.
 * Identities for "the same card" include not only those in the project right now, but also those
 * from project states this gate has seen: one copy is recorded before each write (`before` in
 * `note`, the version prior to modification) and one after.
 * During round finalization (`flush`), it no longer waits; accumulated items are classified
 * immediately and handed over right away.
 *
 * The summary of each classification (`judged`: candidates, classified as heavy, classified as
 * light, reason, record count, number of cards estimated, and clip IDs classified as light
 * truncated to the first `JUDGED_CLIP_IDS`) is both logged and passed to the caller: if there are
 * heavy classifications, it is delivered alongside `emit`; when there are no heavy cards at all,
 * it is passed to `report`. In account mode, it enters the lead service with the `render_request`
 * event and is logged by the lead service into its own logs (`account-render-requests.mjs`),
 * allowing online inspections of each classification result from the lead service logs.
 *
 * Fallbacks (both follow the original approach: dispatch all candidate clips): the classification
 * module cannot be loaded; cost records cannot be retrieved (connection failure, or legacy document
 * service forbids Agent from reading cost records).
 */

/**
 * Location of classification module in `src/` (host loads via `loadModule`; loads registry first,
 * card definitions register via import side effects)
 */
export const HEAVY_JUDGE_MODULE = '/src/editor/agentHeavyClips.ts';
const HEAVY_JUDGE_PRELOAD = ['/src/cards/index.ts', '/src/parts/index.ts'];
/**
 * Maximum number of clip IDs classified as light in classification summary (for log readability
 * only, does not affect classification)
 */
export const JUDGED_CLIP_IDS = 10;

/**
 * Loads classification function
 * `judgeHeavyClips(project, records, candidates, opts) → { heavy, light, estimated }`
 * via loading seam; throws if loading fails.
 * The returned function attaches `groups(project)` (`cardIdentityGroups`: cost identities that
 * appeared for each card in this project), which gate uses to record seen project states.
 */
export async function loadHeavyJudge(loadModule) {
  for (const id of HEAVY_JUDGE_PRELOAD) await loadModule(id);
  const mod = await loadModule(HEAVY_JUDGE_MODULE);
  if (typeof mod?.judgeHeavyClips !== 'function') throw new Error('The judge module has no judgeHeavyClips');
  const judge = (...args) => mod.judgeHeavyClips(...args);
  if (typeof mod.cardIdentityGroups === 'function') judge.groups = (project) => mod.cardIdentityGroups(project);
  return judge;
}

/**
 * Write → accumulate `delayMs` → classify heavy/light → pass only heavy items to `emit`. One
 * instance per chat (account mode: one per task process).
 *
 * @param {object} o
 * @param {{ pick(project, clipIds): string[] }} o.picker Result of `createRenderClipPicker`
 *   (selects candidates at write time; signature table recorded per write)
 * @param {() => ({ project: any, rev?: number } | null)} o.replica Current project replica and
 *   revision
 * @param {() => (Function | null)} o.judge Classification function (result of `loadHeavyJudge`);
 *   returns null if not loaded yet or loading fails
 * @param {() => Promise<object[] | null>} o.records Shared cost records for this project; returns
 *   null if unavailable
 * @param {(clips: string[], info: { rev: number | null, judged: object }) => void} o.emit Emits
 *   clips classified as heavy (with summary of this classification)
 * @param {(judged: object, info: { rev: number | null }) => void} [o.report] Emits summary of this
 *   classification when no heavy clips exist
 * @param {number} o.delayMs
 */
export function createHeavyRenderGate({ picker, replica, judge = () => null, records = async () => null, emit, report = () => {}, delayMs, log = () => {} }) {
  let pending = new Set();
  let timer = null;
  let closed = false;
  let chain = Promise.resolve();
  // Seen project states: identities can only be calculated once classification module arrives;
  // keep references for now, fold into "same card → identity" during classification
  let snapshots = [];
  const sameCard = new Map();
  const say = (event, fields) => { try { log(event, fields); } catch { /* Logging does not affect publishing */ } };
  const current = () => { try { return replica() ?? null; } catch { return null; } };
  const remember = (project) => { if (project && snapshots.at(-1) !== project) snapshots.push(project); };

  function foldSnapshots(fn) {
    if (typeof fn?.groups !== 'function') { snapshots = snapshots.slice(0, 1); return; }
    for (const project of snapshots) {
      let groups = null;
      try { groups = fn.groups(project); } catch { groups = null; }
      for (const [g, keys] of Object.entries(groups ?? {})) {
        let set = sameCard.get(g);
        if (!set) sameCard.set(g, (set = new Set()));
        for (const k of keys ?? []) if (typeof k === 'string') set.add(k);
      }
    }
    snapshots = [];
  }

  async function judgeNow() {
    if (!pending.size) return;
    const candidates = [...pending];
    pending = new Set();
    let clips = candidates;
    let light = [];
    let estimated = 0;
    let why = 'no-judge';
    let count = null;
    const fn = (() => { try { return judge(); } catch { return null; } })();
    if (typeof fn === 'function' && current()?.project) {
      let recs = null;
      try { recs = await records(); } catch { recs = null; }
      if (Array.isArray(recs)) {
        count = recs.length;
        try {
          foldSnapshots(fn);
          const r = fn(current()?.project ?? null, recs, candidates, { sameCard: Object.fromEntries([...sameCard].map(([g, set]) => [g, [...set]])) });
          clips = r.heavy;
          light = r.light;
          estimated = Array.isArray(r.estimated) ? r.estimated.length : 0;
          why = 'judged';
        } catch (err) {
          why = 'judge-failed';
          say('agent.render.judge-failed', { message: String(err?.message ?? err).slice(0, 120) });
        }
      } else why = 'no-records';
    }
    const judged = { candidates: candidates.length, heavy: clips.length, light: light.length, why, ...(count === null ? {} : { records: count }),
      ...(estimated ? { estimated } : {}), ...(light.length ? { lightClips: light.slice(0, JUDGED_CLIP_IDS) } : {}) };
    say('agent.render.judged', judged);
    const rev = current()?.rev;
    const info = { rev: Number.isSafeInteger(rev) ? rev : null };
    if (!clips.length) { try { report(judged, info); } catch { /* Inability to deliver summary does not affect classification */ } return; }
    emit(clips, { ...info, judged });
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    chain = chain.then(judgeNow).catch((err) => say('agent.render.judge-failed', { message: String(err?.message ?? err).slice(0, 120) }));
    return chain;
  }

  return {
    /**
     * A write committed: select candidates based on the current project and accumulate them. `before`
     * is the project before the write (the identity before the Agent modified parameters likely
     * already has records measured by pages, which is useful when estimating by the same card during
     * classification); record both pre-write and post-write projects
     */
    note(clipIds, before = null) {
      if (closed) return;
      const project = current()?.project ?? null;
      remember(before);
      remember(project);
      for (const id of picker.pick(project, clipIds)) pending.add(id);
      if (!pending.size) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, Math.max(0, Number(delayMs) || 0));
      timer.unref?.();
    },
    /** Round finalization: immediately classify accumulated items and hand them over */
    flush,
    /** Teardown: stop timers, accumulated items are no longer handed over */
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      pending.clear();
      snapshots = [];
      sameCard.clear();
    },
    /** Diagnostics, testing */
    pending: () => [...pending],
  };
}

/**
 * Stateful selection: remembers signature table after previous write (one per chat / task
 * process). `kernel` can be the module itself or a function returning the module (available only
 * after host finishes asynchronous loading; treated as not injected before loading completes).
 */
export function createRenderClipPicker(kernel = null) {
  let before = null;
  const k = () => (typeof kernel === 'function' ? kernel() : kernel) ?? null;
  return {
    pick(project, clipIds) {
      const sigs = flatCardSigs(project, k());
      const clips = renderClipsOf(project, clipIds, { kernel: k(), before, sigs });
      before = sigs;
      return clips;
    },
    /**
     * Record an initial copy (after binding, before first write) so the first write only collects
     * what changed
     */
    prime(project) { before = flatCardSigs(project, k()); },
  };
}
