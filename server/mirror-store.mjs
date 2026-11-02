import { applyProjectPatch, projectHash } from "../src/render/changedClips.mjs";

/**
 * Core mirror store (A7). Pure logic, no vite / http dependencies: `server/vite-plugin-mirror.ts`
 * only hooks it up to middleware, mounted once in each of the two processes (editor / prerender).
 *
 * # The key is `{session, localRev}`, not "the latest copy"
 *
 * The frame request body contains only this key (`frameClient.ts`). Keeping the last 8 versions
 * accounts for interleaving requests and pushes: when the page pushes version 12, a frame-fetch
 * request sent 2 seconds ago is still in flight, requesting version 9: if only the latest copy were
 * kept, that request would have to restart from scratch. Eight versions suffice to cover all
 * in-flight requests during a scrub.
 *
 * # Two types of rejection
 *
 * - **stale**: In the same session, `localRev` is not greater than the largest stored number.
 *   The page pushes one at a time, and here provides an extra guard: when two pushes arrive
 *   out of order, the older cannot overwrite the newer. Returns 200 + `stale: true`, not an error.
 * - **resync** (409): The patch baseline slid out of the 8-version window, or after applying,
 *   the hash does not match what the page computed. Upon receiving this, the page repushes the full
 *   copy. This hash check is the **only** place capable of catching "bugs in the two-layer diff
 *   itself"; without it, the mirror would continue serving with a project that went silently wrong.
 */

/** Number of versions to keep per session */
export const MAX_VERSIONS = 8;
/** Maximum number of `wanted` entries in a single playhead push (C4) */
export const MAX_WANTED = 8;

export function createMirrorStore() {
  /** session -> { versions: Version[](ascending by localRev), maxRev } */
  const sessions = new Map();
  /** session -> { t, playing, at } */
  const playheads = new Map();
  let latestSession = null;
  let latestPlayheadSession = null;

  function sessionOf(session) {
    let s = sessions.get(session);
    if (!s) { s = { versions: [], maxRev: -Infinity }; sessions.set(session, s); }
    return s;
  }

  function store(session, localRev, project) {
    const s = sessionOf(session);
    const hash = projectHash(project);
    const version = { session, localRev, project, hash, at: Date.now() };
    s.versions.push(version);
    s.versions.sort((a, b) => a.localRev - b.localRev);
    while (s.versions.length > MAX_VERSIONS) s.versions.shift();
    if (localRev > s.maxRev) { s.maxRev = localRev; latestSession = session; }
    return version;
  }

  /** Full push */
  function pushFull({ session, localRev, project }) {
    if (!session) throw new Error("Missing session");
    if (!project || !Array.isArray(project.tracks)) throw new Error("Missing project");
    const rev = Number(localRev) || 0;
    const s = sessions.get(session);
    if (s && s.versions.length && rev <= s.maxRev) return { status: "stale", localRev: s.maxRev, hash: s.versions[s.versions.length - 1].hash };
    const v = store(session, rev, project);
    return { status: "ok", localRev: v.localRev, hash: v.hash };
  }

  /**
   * Two-layer diff. `hash` is the `projectHash` computed by the page; if provided, it is verified,
   * returning resync on mismatch.
   */
  function pushDiff({ session, fromLocalRev, toLocalRev, hash, patch }) {
    if (!session) throw new Error("Missing session");
    const to = Number(toLocalRev) || 0;
    const from = Number(fromLocalRev) || 0;
    const s = sessions.get(session);
    if (!s || !s.versions.length) return { status: "resync", reason: "session", localRev: null };
    if (to <= s.maxRev) return { status: "stale", localRev: s.maxRev, hash: s.versions[s.versions.length - 1].hash };
    const base = s.versions.find((v) => v.localRev === from);
    // Baseline slid out of the 8-version window: cannot be recovered, must repush full copy
    if (!base) return { status: "resync", reason: "window", localRev: s.maxRev };
    let project;
    try { project = applyProjectPatch(base.project, patch); }
    catch (e) { return { status: "resync", reason: "apply", error: e?.message || String(e), localRev: s.maxRev }; }
    const got = projectHash(project);
    if (hash && got !== hash) return { status: "resync", reason: "hash", localRev: s.maxRev, hash: got, expected: hash };
    const v = store(session, to, project);
    return { status: "ok", localRev: v.localRev, hash: v.hash };
  }

  /**
   * Backfills a version, **bypassing the `stale` gate**. Used only for "pull-back" (when the prerender
   * process is missing a version, it requests that version from the editor): the version it requests is
   * old by definition; going through `pushFull` would block it as an out-of-order push, so a single
   * dropped forward would be unrecoverable: frame requests would keep hitting 409 all the way.
   * If this version already exists, returns as is without storing duplicate.
   */
  function insert({ session, localRev, project }) {
    if (!session) throw new Error("Missing session");
    if (!project || !Array.isArray(project.tracks)) throw new Error("Missing project");
    const rev = Number(localRev) || 0;
    const have = getMirror(session, rev);
    if (have) return { status: "ok", localRev: have.localRev, hash: have.hash };
    const s = sessionOf(session);
    // Older than the oldest in the window: storing it would evict it immediately anyway, better to report it was missed directly
    if (s.versions.length >= MAX_VERSIONS && rev < s.versions[0].localRev) {
      return { status: "resync", reason: "window", localRev: s.maxRev };
    }
    const v = store(session, rev, project);
    return { status: "ok", localRev: v.localRev, hash: v.hash };
  }

  /** Fetches by key. If `localRev` is omitted, returns the latest version for this session */
  function getMirror(session, localRev) {
    const s = sessions.get(session);
    if (!s || !s.versions.length) return null;
    if (localRev === undefined || localRev === null || localRev === "") return s.versions[s.versions.length - 1];
    const rev = Number(localRev);
    return s.versions.find((v) => v.localRev === rev) || null;
  }

  /** Latest version of current editor page session (this is what Agent retrieves) */
  function latestMirror() {
    if (latestSession === null) return null;
    const s = sessions.get(latestSession);
    return s && s.versions.length ? s.versions[s.versions.length - 1] : null;
  }

  /** Latest version of each session, used for "catch-up push after prerender restart" */
  function allLatest() {
    const out = [];
    for (const s of sessions.values()) if (s.versions.length) out.push(s.versions[s.versions.length - 1]);
    return out;
  }

  /**
   * C4 `wanted`: each frame, the page reports "which layers are currently missing near the playhead";
   * the prerender process reads it at 4-frame batch boundaries and moves batches containing these frames
   * to the front.
   *
   * **At most 8 entries** (C4 original text), excess is truncated: it is a hint, not a queue: no matter
   * how much is reported, it only affects where the next batch jumps, and a new one arrives every 100 ms.
   * Bad entries are discarded directly so a single NaN does not invalidate the entire hint.
   */
  function normalizeWanted(value) {
    if (!Array.isArray(value)) return undefined;
    const out = [];
    for (const item of value) {
      const clipId = typeof item?.clipId === "string" ? item.clipId : "";
      const frame = Number(item?.frame);
      if (!clipId || !Number.isInteger(frame) || frame < 0) continue;
      out.push({ clipId, frame });
      if (out.length >= MAX_WANTED) break;
    }
    return out.length ? out : undefined;
  }

  function setPlayhead(session, t, playing, wanted) {
    if (!session) throw new Error("Missing session");
    const list = normalizeWanted(wanted);
    const previous = playheads.get(session);
    const entry = { session, t: Number.isFinite(Number(t)) ? Number(t) : 0, playing: !!playing, at: Date.now(),
      // A pass carrying only `wanted` (the C4 100 ms throttled path) should not overwrite t / playing
      // reported last time, but `wanted` itself always uses the latest; if omitted in this pass, reuse the
      // previous one to avoid alternating paths wiping out hints during scrubbing.
      wanted: list ?? previous?.wanted };
    playheads.set(session, entry);
    latestPlayheadSession = session;
    return entry;
  }

  /** Playhead for the current editor page session; if not yet reported, falls back to the most recently reported one */
  function latestPlayhead() {
    if (latestSession !== null && playheads.has(latestSession)) return playheads.get(latestSession);
    return latestPlayheadSession !== null ? playheads.get(latestPlayheadSession) || null : null;
  }

  return {
    pushFull, pushDiff, insert, getMirror, latestMirror, allLatest, setPlayhead, latestPlayhead,
    /** For testing: inspect which version numbers are currently retained in a session */
    revsOf: (session) => (sessions.get(session)?.versions || []).map((v) => v.localRev),
    clear: () => { sessions.clear(); playheads.clear(); latestSession = null; latestPlayheadSession = null; },
  };
}
