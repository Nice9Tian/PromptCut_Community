/**
 * Registry of page sessions' "current version", residing in the **editor process** (parent process
 * of the prerender process) (Item 4 Option A).
 *
 * # Why in the parent process
 *
 * A session's current version is set only by page preloads, and preload connects directly to the
 * prerender process: once the prerender process crashes and restarts, its session table is lost,
 * and the ready index on the page side can never grow back (the page stops sending preload after
 * becoming ready). The parent process is responsible for launching / restarting the prerender
 * process and repushing the mirror after restarts (`repushMirror`), with a lifetime as long as the
 * page and mirror, so it remembers "which version was the last accepted preload for each session",
 * and **replays** preloads accordingly after restarts. Recovery still takes the preload route,
 * preserving "current version is determined by preload"; the page needs to do nothing.
 *
 * This table is volatile view state (per page, per machine) and does not enter the document service.
 *
 * # Rules
 *
 * - Default session (`''`, scripts / migration-period callers without a session) is not registered:
 *   it has no mirror and cannot be replayed.
 * - For the same session, keep only the highest `localRev` (page localRev increases monotonically;
 *   never regresses when reports arrive out of order).
 * - Sorted by most recent report, capped at `READY_REGISTRY_MAX`; when exceeded, drop the least
 *   recently active.
 * - Replay is **serialized**: sends only one preload at a time, waiting for its response before
 *   sending the next: the newly started prerender process will not be hammered all at once;
 *   most recently active sessions replay first, up to `READY_REPLAY_MAX`. Sessions no longer in the
 *   mirror are skipped; if the recorded version has slid out of the mirror window, fall back to the
 *   latest version for that session.
 */

export const READY_REGISTRY_MAX = 64;
/**
 * Maximum sessions to replay in one restart (the most recently active ones). The registry may still
 * hold long-closed tabs, and replaying all of them would flood background prerendering for pages
 * nobody is watching; earlier sessions wait for their own next preload.
 */
export const READY_REPLAY_MAX = 8;

export function createReadySessionRegistry({ max = READY_REGISTRY_MAX, now = () => Date.now() } = {}) {
  /** session -> { session, localRev, at }; Map insertion order is the order of most recent reports */
  const sessions = new Map();

  /** The prerender process accepted a preload. Returns true = version in the table changed */
  function record(session, localRev) {
    if (typeof session !== 'string' || !session) return false;
    const rev = Number(localRev);
    if (localRev === null || localRev === undefined || !Number.isFinite(rev)) return false;
    const before = sessions.get(session);
    const next = { session, localRev: before && before.localRev > rev ? before.localRev : rev, at: now() };
    sessions.delete(session);
    sessions.set(session, next);
    while (sessions.size > max) sessions.delete(sessions.keys().next().value);
    return !before || before.localRev !== next.localRev;
  }

  return {
    record,
    /** Most recently reported first */
    list: () => [...sessions.values()].reverse().map(item => ({ ...item })),
    drop: session => sessions.delete(session),
    size: () => sessions.size,
    clear: () => sessions.clear(),
  };
}

/**
 * After prerender process restarts and mirror repush completes: replay each session's preload
 * serially according to the registry.
 *
 * - `sessions`: result of `registry.list()` (most recently active first);
 * - `resolve(session, localRev)`: usable version number for this session in the mirror: returns the
 *   recorded version if still present; if it slid out of the window, returns the session's latest
 *   version; returns null (skip) if the whole session is gone;
 * - `preload({ session, localRev })`: sends one preload, returning `{ ok, status? }`; thrown errors
 *   count as failure for this one, then proceed to the next;
 * - `isCurrent()`: stops if the prerender process changes again (restarted again) mid-replay, handing
 *   off to the next round.
 *
 * Returns results for each session, for logs / testing.
 */
export async function replayReadySessions({ sessions, resolve, preload, isCurrent = () => true, limit = READY_REPLAY_MAX }) {
  const results = [];
  for (const item of (sessions ?? []).slice(0, limit)) {
    if (!isCurrent()) { results.push({ session: item.session, skipped: 'superseded' }); break; }
    let localRev = null;
    try { localRev = resolve(item.session, item.localRev); } catch { localRev = null; }
    if (localRev === null || localRev === undefined) { results.push({ session: item.session, skipped: 'no-mirror' }); continue; }
    try {
      const out = await preload({ session: item.session, localRev });
      results.push({ session: item.session, localRev, ok: out?.ok !== false, ...(out?.status !== undefined ? { status: out.status } : {}) });
    } catch (error) {
      results.push({ session: item.session, localRev, ok: false, error: String(error?.message || error) });
    }
  }
  return results;
}
