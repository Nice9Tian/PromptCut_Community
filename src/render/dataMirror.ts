import type { Project } from "../kernel/project";
import { getState, subscribe } from "../store/project";
import { onlinePage } from "../online/pageFlag";
import { changedClips, projectHash, type ProjectPatch } from "./changedClips.mjs";

/**
 * Read-only mirror for data management: editor page pushes a copy of the project (with version number)
 * to the server (docs/archive/topics/decoupling-plan.md section 3.2 "Data management -> Project", phase 4; A7).
 *
 * # Why
 *
 * Previously, every Agent action had to be relayed through the editor page: the server forwarded calls
 * to the page via SSE, and the page then requested rendering. The timeline's actual data lives in the
 * browser store (seePreview comment in right/index.tsx), so without this detour the project could not
 * be obtained: yet with this detour, the Agent's image-viewing requests hung on the editor page's
 * connection, which was the exact structural reason it could freeze the UI.
 *
 * With the mirror, Agent reads and rendering (get_project / see_frames / get_gif / bake_card /
 * inspect_card_dom) are handled directly by the server querying prerendering with the mirror,
 * without touching the page at all; write operations still go through the page, leaving undo / redo
 * unchanged. **Frame requests work the same way**: the body no longer carries the project, only
 * `{session, localRev}`, and the server fetches it by key from the mirror plugin
 * (src/render/frameClient.ts, server/vite-plugin-mirror.ts).
 *
 * # When to push
 *
 * **Pushes as soon as the editor page loads**, no longer waiting to "connect to MCP bridge": frame
 * requests rely on the mirror to obtain the project, and previews must still be able to render when
 * there is no Agent. The criterion changed from "connected to bridge" to "page role is editor page":
 * read-only viewing pages (`?observe` / `?view`), stage pages, and export pages never push (two pages
 * pushing simultaneously would overwrite each other).
 *
 * # Version numbers
 *
 * `localRev` increments by 1 when the **`project` reference changes** (the store uses immutable updates).
 * It constitutes half of the frame request key, so it can only be incremented here: incrementing only
 * upon pushing would cause the same number to point to two different project versions.
 *
 * # Consistency
 *
 * - User edits: debounced to push once every 250 ms, sending a two-level diff whenever incremental
 *   updates are possible (src/render/changedClips.mjs).
 * - Agent write operations: mcpExecutor calls flushDataMirror() before returning results, so when the
 *   Agent "views immediately after editing", it is guaranteed to see the edited version
 *   (read-after-write consistency). It also aligns before fetching frames (alignMirror).
 * - Playhead `{t, playing}` goes through `/api/data/playhead`, separated from the project: it "reports
 *   the current timestamp once upon stopping"; if mixed into the project path, scrubbing the playhead
 *   once would require sending the entire project on another round trip.
 * - **Send a keepalive every 2 seconds during playback** (`PLAYHEAD_KEEPALIVE_MS`, see "Playback
 *   keepalive" section below): the prerender process relies on messages on this path to determine if
 *   the user is still playing; when there are no gaps under the playhead, `wanted` is not sent, so
 *   without keepalives, continuous playback for 5 seconds would be treated as the user having left.
 * - **Only fly one push at a time**, sending the next only after the previous lands: if two are in
 *   transit simultaneously, arrival order is not guaranteed, and an older one could overwrite a newer
 *   one. At most one waiting push is queued on the chain: when it runs, it reads the latest state, so
 *   queuing ten would be pointless.
 * - **If a push fails (network error, HTTP non-2xx), treat it as never pushed**, retrying on its own
 *   after a moment; otherwise the mirror would stay stuck on the old version.
 * - Server returns 409 = patch mismatch (baseline slid out of 8-version window, or hashes mismatch
 *   after applying): repush the entire copy on the spot.
 */

/** Session id for this page open: resets version number; server uses it to distinguish "new page" from "old pushes" */
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Increments by 1 every time the project reference changes. 0 = mirroring has not started */
let localRev = 0;
/** The version already pushed and confirmed received by the server */
let pushedRev = -1;
let pushedProject: Project | null = null;
let pushedT = -1;
let pushedPlaying: boolean | null = null;

let timer: ReturnType<typeof setTimeout> | null = null;
let headTimer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
let queued = false;
let started = false;

/**
 * Whether this page should push the mirror. Read-only viewing pages, stage pages, and export pages
 * never push: they view someone else's project, and pushing would overwrite the editor page's copy.
 */
function isMirrorPage(): boolean {
  // Online browser mode has no editor process to mirror (C10a contract section 2)
  if (onlinePage()) return false;
  try {
    const p = new URLSearchParams(location.search);
    if (p.has("observe") || p.get("view")) return false;
    if (p.has("export") || p.has("stage")) return false;
    return true;
  } catch {
    return false;
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    // Finish reading the body before leaving to avoid leaving the connection hanging
    await res.json().catch(() => null);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function pushNow(): Promise<void> {
  if (!started) return;
  const project = getState().project as Project | undefined;
  if (!project) return;
  if (project === pushedProject && pushedRev === localRev) return;

  const rev = localRev;
  const hash = projectHash(project);
  const patch: ProjectPatch = pushedProject && pushedRev >= 0
    ? changedClips(pushedProject, project)
    : { kind: "full", project };

  let result = { ok: false, status: 0 };
  if (patch.kind === "tracks") {
    // Empty patches are also sent: when the reference changes but content does not, the server still
    // needs to record this revision number, otherwise frame requests cannot fetch by it
    result = await post("/api/data/diff", { session, fromLocalRev: pushedRev, toLocalRev: rev, projectHash: hash, patch });
    // 409: Server mismatch (baseline slid out of window / hash mismatch). Repush the whole copy;
    // do not continue patching on the wrong baseline
    if (!result.ok) pushedProject = null;
  }
  if (!result.ok) {
    result = await post("/api/data/project", { session, localRev: rev, project, projectHash: hash });
  }

  if (result.ok) {
    pushedProject = project;
    pushedRev = rev;
    // When both project and playhead have changed (e.g. Agent jumps time right after editing), align the playhead as well
    if (headTimer === null && !getState().playing) schedulePlayhead(0);
  } else if (started) {
    // Push failed: retry after two seconds. When the server lacks a new mirror, Agent tools fall
    // back to executing via the page and will not use this outdated version
    schedule(2000);
  }
}

/**
 * Queue into the push chain: send the next only after the previous lands. At most one is queued
 * on the chain: when it runs, it reads the latest state at that time, and queuing a series would
 * just push the same project multiple times.
 */
function push(): Promise<void> {
  if (queued) return chain;
  queued = true;
  const run = () => { queued = false; return pushNow(); };
  chain = chain.then(run, run);
  return chain;
}

function schedule(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void push();
  }, delay);
}

async function pushPlayheadNow(): Promise<void> {
  if (!started) return;
  const s = getState();
  if (s.t === pushedT && s.playing === pushedPlaying) return;
  const t = s.t, playing = s.playing;
  const res = await post("/api/data/playhead", { session, t, playing });
  if (res.ok) { pushedT = t; pushedPlaying = playing; }
}

function schedulePlayhead(delay: number) {
  if (headTimer) clearTimeout(headTimer);
  headTimer = setTimeout(() => {
    headTimer = null;
    void pushPlayheadNow();
  }, delay);
}

/* ------------------------------------------------------------------ C4 wanted */

/**
 * C4: When the parent page selects snapshots by layer, it also derives "which layers are currently
 * missing near the playhead" and reports them here to the prerender process, which moves batches
 * containing these frames to the front upon reading them at 4-frame batch boundaries.
 *
 * **Open a separate sending path instead of using the playhead path above**, because the four
 * properties of that path are all wrong for `wanted`:
 *
 * - The `!s.playing` gate at `:184`: never pushes during playback, yet playback is when paving the
 *   way ahead of the playhead is needed most;
 * - The "early return if `t` and `playing` unchanged" at `:149`: scrubbing stops on the same frame
 *   with a different missing layer, but cannot be sent;
 * - The 400 ms re-entrant debounce at `:186`: never triggers during continuous scrubbing;
 * - `post()` both `await`s and reads the full response body with a 10 s timeout: a "hint" is not
 *   worth holding a connection.
 *
 * Policy here: **100 ms fixed throttle** (not debounced: sends the latest copy when the throttle
 * window expires, sending steadily every 100 ms during continuous scrubbing), `keepalive: true`,
 * **do not read response**, silently ignore failures. Existing playhead push path behavior remains
 * unchanged.
 */
export type WantedFrame = { clipId: string; frame: number };

/** C4 original text: up to 8 entries */
const MAX_WANTED = 8;
/** Fixed throttle window */
const WANTED_MS = 100;

let wantedTimer: ReturnType<typeof setTimeout> | null = null;
let wantedPending: WantedFrame[] | null = null;
let wantedSentAt = 0;

/**
 * A single transmission on the lightweight path: shared between `wanted` and the playback keepalive
 * below. Do not await, do not read response, `keepalive: true`, fail silently: it is a hint, and
 * arriving one tick late only misses one queue jump (if keepalive arrives one tick late, the server
 * still has a 5-second margin).
 */
function sendPlayheadLight(body: Record<string, unknown>) {
  try {
    void fetch("/api/data/playhead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch { /* Page is unloading / network disconnected: try again on the next tick */ }
}

function sendWanted(wanted: WantedFrame[]) {
  wantedSentAt = Date.now();
  sendPlayheadLight({ session, t: getState().t, playing: getState().playing, wanted });
}

/* ------------------------------------------------------------------ Playback keepalive */

/**
 * Interval for playback keepalive. The prerender process determines whether "the user is playing"
 * solely by the most recent message on this path: `playing` and received within 5 seconds
 * (`FramePipeline.streamBusy()`, `interactionReason` in `server/queue-idle.mjs`), so messages must
 * arrive continuously during continuous playback. Originally, only `wanted` above could refresh it
 * during playback, but when every layer under the playhead is covered by streams without gaps,
 * `wanted` is not sent: if playing continuously for over 5 seconds, the prerender process assumed
 * the user had left and continued filling other cards' streams to full density during playback,
 * violating "do not produce during playback".
 *
 * Set to 2 seconds: well below the server's 5-second window, so missing one or two ticks (page
 * stutter, late request) will not expire; much sparser than the 100 ms of `wanted`, with 30 small
 * requests per minute. The server's two windows (5 seconds, 800 milliseconds) remain unchanged.
 */
export const PLAYHEAD_KEEPALIVE_MS = 2000;

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/** Page is backgrounded (tab switched, minimized): user not watching, no keepalive sent, prerender can resume producing streams */
function pageHidden(): boolean {
  try { return typeof document !== "undefined" && document.visibilityState === "hidden"; } catch { return false; }
}

function sendKeepalive() {
  if (!started) return stopKeepalive();
  const s = getState();
  if (!s.playing) return stopKeepalive();
  if (pageHidden()) return;
  // Omits `wanted`: the server reuses the previous gap hint (just like the "push once when stopped"
  // path); keepalives neither refresh nor clear it
  sendPlayheadLight({ session, t: s.t, playing: true });
}

function startKeepalive() {
  if (keepaliveTimer !== null) return;
  keepaliveTimer = setInterval(sendKeepalive, PLAYHEAD_KEEPALIVE_MS);
}

function stopKeepalive() {
  if (keepaliveTimer === null) return;
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

/**
 * Report gaps once. No matter how many times it is called within the same 100 ms window, only one
 * is sent (the latest copy takes precedence); an empty array indicates "nothing is missing right now"
 * and is not sent.
 */
export function pushWanted(wanted: WantedFrame[]): void {
  if (!started || !Array.isArray(wanted) || !wanted.length) return;
  const list = wanted
    .filter((item) => item && typeof item.clipId === "string" && item.clipId && Number.isInteger(item.frame) && item.frame >= 0)
    .slice(0, MAX_WANTED);
  if (!list.length) return;
  const since = Date.now() - wantedSentAt;
  if (since >= WANTED_MS && wantedTimer === null) return sendWanted(list);
  wantedPending = list;
  if (wantedTimer !== null) return;
  wantedTimer = setTimeout(() => {
    wantedTimer = null;
    const next = wantedPending;
    wantedPending = null;
    if (next) sendWanted(next);
  }, Math.max(0, WANTED_MS - since));
}

/** For testing: clear throttle state completely */
export function resetWantedThrottle(): void {
  if (wantedTimer !== null) clearTimeout(wantedTimer);
  wantedTimer = null;
  wantedPending = null;
  wantedSentAt = 0;
}

/**
 * Start mirroring. **Called as soon as the editor page loads**; no-ops when called on read-only
 * viewing pages / stage pages / export pages. Repeated calls have no side effects (the returned
 * disposer is only effective for the first call).
 */
export function startDataMirror(): () => void {
  if (started) return () => {};
  if (!isMirrorPage()) return () => {};
  started = true;
  localRev = 1;
  let lastProject = getState().project;
  let lastPlaying = getState().playing;
  schedule(0);
  schedulePlayhead(0);
  if (lastPlaying) startKeepalive();
  const off = subscribe(() => {
    const s = getState();
    if (s.project !== lastProject) {
      // Revision number follows the **reference**: it is the frame request key and can only be incremented here
      lastProject = s.project;
      localRev++;
      schedule(250);
    }
    if (!s.playing && (lastPlaying || s.t !== pushedT)) {
      // Do not push t during playback; push once only when stopped (or when scrubbing the playhead while paused)
      schedulePlayhead(400);
    } else if (s.playing !== pushedPlaying) {
      schedulePlayhead(0);
    }
    // The playback keepalive timer starts and stops with `playing` (re-entering has no side effects)
    if (s.playing) startKeepalive();
    else stopKeepalive();
    lastPlaying = s.playing;
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    if (headTimer) clearTimeout(headTimer);
    timer = null;
    headTimer = null;
    stopKeepalive();
    resetWantedThrottle();
    started = false;
  };
}

/** Immediately push pending changes and wait for them to land. Called before Agent write tools return results */
export async function flushDataMirror(): Promise<void> {
  if (!started) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await push();
}

/**
 * Repush the entire copy once and wait for it to land. Called when a frame request receives 409
 * `MIRROR_MISSING`: indicating that **some process** does not have this key (most likely prerender
 * just restarted and forwarding was dropped at that moment), and continuing to patch will only keep
 * failing. Clear the baseline so the next push will be the full project; when the editor side
 * receives the full project, it forwards unconditionally to prerender (see forwarding instructions
 * in server/vite-plugin-mirror.ts), so this repush can genuinely replenish the other side.
 */
export async function resyncDataMirror(): Promise<void> {
  if (!started) return;
  pushedProject = null;
  pushedRev = -1;
  await flushDataMirror();
}

/** Key in the mirror for this page; returns null for pages that do not mirror */
export function mirrorKey(): { session: string; localRev: number } | null {
  return started ? { session, localRev } : null;
}

/**
 * Alignment before a frame request: if the revision number does not match what was pushed, flush
 * once first, then hand the key to the caller.
 *
 * Returns null = this page does not mirror (read-only viewing page / stage page / export page).
 * The caller then stuffs the entire project into the body: the server prologue recognizes this
 * migration path, bypassing the mirror for both reads and writes.
 */
export async function alignMirror(): Promise<{ session: string; localRev: number } | null> {
  if (!started) {
    if (!isMirrorPage()) return null;
    // When opening a project, import may race ahead of right rail mounting: replenish once here
    // so the first request does not miss
    startDataMirror();
    if (!started) return null;
  }
  if (localRev !== pushedRev) await flushDataMirror();
  return { session, localRev };
}
