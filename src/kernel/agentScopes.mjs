/**
 * Multi-Agent "scope" (plan `docs/plan/agent-workflow-plan.md` A3; semantics `user-workflow.md`
 * "Multi-Agent", "Protection").
 *
 * Scopes are written as "CutX->TrackX", separated by commas if multiple. Only pure logic shared
 * between page and server is placed here:
 *   - `diffScopes(before, after)`: which "Cut->Track" changed before and after a change (the active
 *     cut, and parked cuts modified in place);
 *   - `scopeOverlaps(a, b)` / `overlappingScopes(written, declared)`: whether two scopes overlap
 *     (same name, or one is an ancestor of the other);
 *   - `splitScopes(s)`: split declared text into individual scopes;
 *   - `parkedCutsIndex(p)` / `otherCutsHint(p)`: clip index in parked cuts, used by get_project,
 *     list_cuts, and tool responses that Agents read first (end of file).
 *
 * Why `.mjs`: server (`server/agent/agent-board.mjs`, fed by document service commit stream) and
 * page (when not connected to document service, page runner computes before and after tool calls)
 * use the same criteria; Node cannot directly import `.ts`.
 *
 * Only checks `tracks` in project (content of the active cut lives on Project) and
 * `cuts` / `activeCutId`; a changed reference in a track's `clips` array counts as a change:
 * store creates a new array on every change, and the document service operation engine
 * (copy-on-write) only replaces the modified branch, leaving untouched references unchanged.
 */

/** Name of the current cut; "Cut 1" when the project has no cuts (legacy file) */
export function cutNameOf(project) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts : [];
  const hit = cuts.find((c) => c && c.id === project?.activeCutId) ?? cuts[0];
  return typeof hit?.name === 'string' && hit.name ? hit.name : 'Cut 1';
}

const tracksOf = (p) => (Array.isArray(p?.tracks) ? p.tracks.filter((t) => t && typeof t === 'object') : []);

/**
 * Which "Cut->Track" in project changed before and after a change. Switching cuts counts the
 * entire cut as scope; adjusting only the track order records "Cut->Track order"; theme changes
 * record "Global theme". Others (project name, effects library, cards) do not count as scope.
 */
export function diffScopes(before, after) {
  if (!before || !after || before === after) return [];
  const out = [];
  if ((before.activeCutId ?? null) !== (after.activeCutId ?? null)) return [cutNameOf(after)];
  const name = cutNameOf(after);
  const prev = new Map(tracksOf(before).map((t) => [t.id, t]));
  for (const t of tracksOf(after)) {
    const b = prev.get(t.id);
    if (!b || b.clips !== t.clips || b.name !== t.name || !!b.hidden !== !!t.hidden || !!b.muted !== !!t.muted || !!b.locked !== !!t.locked) {
      out.push(`${name}->${t.name}`);
    }
  }
  for (const b of tracksOf(before)) {
    if (!tracksOf(after).some((t) => t.id === b.id)) out.push(`${name}->${b.name}(deleted)`);
  }
  // Modified in place within a parked cut (Agent modifies its clips directly without switching cuts,
  // runInCutScope in store/core.ts) also counts as scope: content lives in cuts[].tracks,
  // comparing tracks for each parked cut using the same criteria
  const beforeCuts = Array.isArray(before.cuts) ? before.cuts : [];
  for (const c of Array.isArray(after.cuts) ? after.cuts : []) {
    if (!c || c.id === after.activeCutId || !Array.isArray(c.tracks)) continue;
    const bc = beforeCuts.find((x) => x && x.id === c.id);
    if (!bc || !Array.isArray(bc.tracks)) continue;
    const cname = typeof c.name === 'string' && c.name ? c.name : c.id;
    const bprev = new Map(tracksOf({ tracks: bc.tracks }).map((t) => [t.id, t]));
    for (const t of tracksOf(c)) {
      const b = bprev.get(t.id);
      if (!b || b.clips !== t.clips || b.name !== t.name || !!b.hidden !== !!t.hidden || !!b.muted !== !!t.muted || !!b.locked !== !!t.locked) out.push(`${cname}->${t.name}`);
    }
    for (const b of tracksOf({ tracks: bc.tracks })) {
      if (!tracksOf(c).some((t) => t.id === b.id)) out.push(`${cname}->${b.name}(deleted)`);
    }
  }
  if (out.length === 0) {
    const order = (p) => tracksOf(p).map((t) => t.id).join('\n');
    if (order(before) !== order(after)) out.push(`${name}->track order`);
  }
  if (out.length === 0 && before.theme !== after.theme && JSON.stringify(before.theme ?? null) !== JSON.stringify(after.theme ?? null)) {
    out.push('global theme');
  }
  return out;
}

/**
 * Declared text → individual scopes (separated by commas, semicolons, or enumeration marks;
 * strip suffixes like "(deleted)" before comparing)
 */
export function splitScopes(text) {
  if (typeof text !== 'string') return [];
  return text.split(/[,，;；、]/).map((x) => x.trim()).filter(Boolean); // i18n-allow
}

const bare = (s) => s.replace(/[(（](?:已删|deleted)[)）]$/, '').trim(); // i18n-allow

/**
 * Whether two scope strings overlap: same name, or one is ancestor of the other
 * ("Cut 1" contains "Cut 1->Track 2")
 */
export function scopeOverlaps(a, b) {
  const xs = splitScopes(a).map(bare);
  const ys = splitScopes(b).map(bare);
  return xs.some((x) => ys.some((y) => x === y || x.startsWith(y + '->') || y.startsWith(x + '->')));
}

/** Among written scopes, those that fall within declared scopes */
export function overlappingScopes(written, declared) {
  const list = Array.isArray(written) ? written : splitScopes(written);
  return list.filter((w) => scopeOverlaps(w, declared));
}

/* ---------- Clip index for parked cuts (used by get_project / list_cuts / tool responses read by Agents first) ---------- */

/**
 * Clip index for parked cuts: used by items Agents read first (get_project, list_cuts,
 * timeline in tool responses).
 *
 * Why it exists: these read tracks / timeline are only for the **active cut**. For the model to
 * modify clips in other cuts, it first needs clipId; without an index, its way to "look into"
 * Cut 2 was switch_cut, and active cut is state shared across all members, so switching flips
 * everyone's UI together (`product/project-model.md` "Cuts", user decision, 2026-10-21: tools
 * modifying properties by clip id modify clips in other cuts in place without switching).
 * Production 2026-10-21: tool descriptions and system prompts both stated "no need to switch", yet
 * the model still did switch_cut -> update_clip -> switch_cut. Putting clipId directly where it
 * reads first eliminates the reason to switch.
 *
 * Placed in this file (rather than a separate .mjs) because the standalone entry of Agent service
 * may only reference `src/` via the loading seam `server/agent/ssr-host.mjs`, and this file is
 * already shared pure logic exported through that seam and deployed with the service (ratchet in
 * `accept-018-rest-ssr-seam.test.mjs`). Shared between page-side handler and server-side
 * projectView, without going through TS. Read-only, does not touch store.
 * Output has limits (total clips, clips per cut); overflows provide count and point to
 * list_cuts({cutId}): that one returns the entire cut.
 */

/** Default limits: at most this many clips total / at most this many per cut / label max chars */
export const CUTS_INDEX_LIMITS = Object.freeze({ maxClips: 60, perCutMax: 30, labelMax: 24 });

/** A note for the model. Included in the index of get_project / list_cuts */
export const PARKED_EDIT_NOTE =
  "These are clips in cuts that are not active. To edit them, do not use user_interface_switch_cut: pass the clipId directly to update_clip / set_clip / get_clip / " +
  "set_position / set_rect / align / nudge / set_emphasis / set_clip_volume / set_clip_muted, which edit the clips in that cut in place." +
  " To view their frames, pass cutId to see_frames, no switch needed either. The active cut is shared by all members, and user_interface_switch_cut flips everyone's UI at once, so switch only when you need to add / delete / split / duplicate clips in another cut." +
  "trackId must be the id of that cut's own track (each clip below carries it).";

const round2 = (n) => Math.round(n * 100) / 100;

function activeCutIdForIndex(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c?.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

/**
 * @param {object} project
 * @param {{ maxClips?: number, perCutMax?: number, labelMax?: number, cardName?: (cardId: string) => string | undefined }} [opts]
 *   `cardName`: passed when card registry is available on page side; clip includes an extra card
 *   display name to help match terms like "Particle background"
 * @returns {null | {
 *   activeCutId: string, note: string,
 *   cuts: { cutId: string, name: string, duration: number, clipCount: number, trackCount: number,
 *           clips: object[], omitted?: number, more?: string }[]
 * }} Returns null when project has only one cut (no parked cuts)
 */
export function parkedCutsIndex(project, opts = {}) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts : [];
  if (cuts.length < 2) return null;
  const activeCutId = activeCutIdForIndex(project);
  const maxClips = Math.max(0, opts.maxClips ?? CUTS_INDEX_LIMITS.maxClips);
  const perCutMax = Math.max(0, opts.perCutMax ?? CUTS_INDEX_LIMITS.perCutMax);
  const labelMax = Math.max(1, opts.labelMax ?? CUTS_INDEX_LIMITS.labelMax);
  let budget = maxClips;
  const out = [];
  for (const c of cuts) {
    if (!c || c.id === activeCutId) continue;
    const tracks = Array.isArray(c.tracks) ? c.tracks : [];
    const flat = [];
    for (const tr of tracks) for (const cl of Array.isArray(tr?.clips) ? tr.clips : []) flat.push([tr, cl]);
    const take = Math.min(perCutMax, budget, flat.length);
    budget -= take;
    const clips = flat.slice(0, take).map(([tr, cl]) => {
      const label = typeof cl.label === "string" && cl.label ? (cl.label.length > labelMax ? `${cl.label.slice(0, labelMax)}…` : cl.label) : undefined;
      const name = cl.cardId && opts.cardName ? opts.cardName(cl.cardId) : undefined;
      return {
        id: cl.id,
        trackId: tr.id,
        ...(cl.cutId ? { cutSegmentOf: cl.cutId } : cl.cardId ? { cardId: cl.cardId } : cl.mediaId ? { mediaId: cl.mediaId } : null),
        ...(name ? { cardName: name } : null),
        ...(label ? { label } : null),
        start: round2(cl.start),
        end: round2(cl.end),
      };
    });
    const omitted = flat.length - clips.length;
    out.push({
      cutId: c.id,
      name: c.name,
      ...(c.kind === "3d" ? { kind: "3d" } : null),
      ...(Array.isArray(c.cameras) && c.cameras.length > 0 ? { cameraCount: c.cameras.length } : null),
      duration: round2(typeof c.duration === "number" && c.duration > 0 ? c.duration : 30),
      trackCount: tracks.length,
      clipCount: flat.length,
      clips,
      ...(omitted > 0 ? { omitted, more: `${omitted} more clips not listed, use list_cuts({ cutId: "${c.id}" }) to see all of this cut` } : null),
    });
  }
  return { activeCutId, note: PARKED_EDIT_NOTE, cuts: out };
}

/**
 * Lightweight hint next to timeline in tool response: which other cuts exist and how many clips
 * each has. Does not list clips (included in every response, saves space), points to parkedCuts
 * in get_project / list_cuts({ cutId }). Returns null when no other cuts have content.
 * @param {object} project
 * @returns {null | { cuts: { cutId: string, name: string, clipCount: number }[], hint: string }}
 */
export function otherCutsHint(project) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts : [];
  if (cuts.length < 2) return null;
  const activeCutId = activeCutIdForIndex(project);
  const rest = [];
  for (const c of cuts) {
    if (!c || c.id === activeCutId) continue;
    let n = 0;
    for (const tr of Array.isArray(c.tracks) ? c.tracks : []) n += Array.isArray(tr?.clips) ? tr.clips.length : 0;
    if (n > 0) rest.push({ cutId: c.id, name: c.name, clipCount: n });
  }
  if (!rest.length) return null;
  return {
    cuts: rest,
    hint: "The timeline above is only for the active cut. For clips in other cuts, do not use user_interface_switch_cut: the clipId is in parkedCuts of get_project or in list_cuts({ cutId }), pass it directly to update_clip etc. to edit in place; to view frames, pass cutId to see_frames.",
  };
}

/* ---------- View frames of other cuts (cutId in see_frames; user decision, 2026-10-21: viewing frames can specify cut without switching) ---------- */

/**
 * Project view passed to render when see_frames has `cutId`: swaps that cut into the "active"
 * state (replaces tracks / duration / transitions with its content, moves the truly active
 * cut back into an entry with its own content, and resolves cut segment references as usual). Same
 * shape as `cutEditView` in `src/kernel/cuts.ts`, here as a pure JS version shared between server
 * (imported directly by Node) and page.
 *
 * View is used only for generating this single frame: does not enter store, does not enter document
 * sync, does not change activeCutId, and touches no one's UI. The render side sees an ordinary
 * project, so legacy render processes (recognizing only project, not cutId) also render frames
 * correctly.
 *
 * @param {object} project Actual project
 * @param {string | undefined | null} cutId When omitted (or empty string), current active cut
 * @returns {{ project: object, cut: { id: string, name: string }, active: boolean, parkedT: number | null }}
 *   `parkedT`: playhead when that cut was last left (`t` stored in parked entry); active cut
 *   returns null (uses page playhead)
 * @throws Thrown when cutId is given but cut is not in project; error lists existing cuts
 */
export function cutLookView(project, cutId) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts.filter((c) => c && typeof c === "object") : [];
  const activeId = activeCutIdForIndex(project) ?? "cut-1";
  const activeName = cuts.find((c) => c.id === activeId)?.name || "Cut 1";
  const want = typeof cutId === "string" ? cutId.trim() : "";
  if (!want || want === activeId) return { project, cut: { id: activeId, name: activeName }, active: true, parkedT: null };
  const target = cuts.find((c) => c.id === want);
  if (!target) {
    const list = cuts.length ? cuts.map((c) => `${c.name || c.id}(${c.id})`).join(", ") : `${activeName}(${activeId})`;
    throw Object.assign(new Error(`Cut ${JSON.stringify(want)} not found; existing cuts: ${list}. Get cutId from list_cuts; if omitted, the currently active cut is used.`), { code: "cut-not-found" });
  }
  const nextCuts = cuts.map((c) => {
    if (c.id === activeId) return { ...c, tracks: project.tracks ?? [], duration: project.duration, transitions: Array.isArray(project.transitions) ? project.transitions : [] };
    if (c.id === want) {
      const { tracks: _t, duration: _d, transitions: _x, t: _pt, ...rest } = c;
      return rest;
    }
    return c;
  });
  const view = {
    ...project,
    tracks: Array.isArray(target.tracks) ? target.tracks : [],
    duration: typeof target.duration === "number" && target.duration > 0 ? target.duration : 30,
    transitions: Array.isArray(target.transitions) ? target.transitions : [],
    cuts: nextCuts,
    activeCutId: want,
  };
  const parkedT = typeof target.t === "number" && Number.isFinite(target.t) && target.t >= 0 ? target.t : 0;
  return { project: view, cut: { id: target.id, name: target.name || target.id }, active: false, parkedT };
}
