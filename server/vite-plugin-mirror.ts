import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMirrorStore } from "./mirror-store.mjs";
import { isPrerender } from "./render-role.mjs";
import { prerenderState } from "./prerender-client.mjs";
import { createReadySessionRegistry, replayReadySessions as replaySessions } from "./ready-session-registry.mjs";

/**
 * Read-only mirror for data management (A7). **Both processes mount this plugin.**
 *
 * # What it solves
 *
 * Previously, the mirror lived inside `vite-plugin-ai`, and the ai plugin was only mounted on
 * the editor side (not on the prerender side: it would overwrite global port.json, pointing MCP
 * to prerender). Consequently, the prerender process had no project in hand, and every frame
 * request had to pack the entire project into the body and send it again: dragging a clip for
 * 2 seconds sent hundreds of KB over a dozen times, when only one segment actually changed.
 * After splitting the mirror into its own plugin, both processes keep a copy, leaving only
 * `{session, localRev, lane}` in the frame request body.
 *
 * # Keys, version windows, and two types of rejection
 *
 * See description in `server/mirror-store.mjs` (the storage itself lives there;
 * this is only the HTTP surface).
 *
 * # Who delivers the project to the prerender process
 *
 * Three paths, all indispensable:
 *
 * 1. **Forwarding**: Every time editor process receives a push (full or patch), it forwards it
 *    as-is to the currently ready prerender process. If the patch gets a 409 (it just restarted
 *    and has no baseline), immediately catch up with a full copy.
 * 2. **Pull-back**: Prerender process uses `PROMPTCUT_EDITOR_URL` (given at spawn, see
 *    vite-plugin-prerender) to request that version from editor via
 *    `GET /api/data/project?session=&localRev=`. This path is taken when forwarding drops, or
 *    when frame requests arrive right after process startup. Prerender processes in `agent` mode
 *    do not carry this variable: their projects are pushed by Agent server (I2), so pull-back
 *    naturally no-ops.
 * 3. **Catch-up push**: When prerender process restarts and health check just passes, the editor
 *    pushes the latest full version of each session.
 *
 * Forwarding is chained per target (only one in flight at a time); otherwise arrival order is
 * not guaranteed, and patches would miss the baseline.
 *
 * After catch-up push, there is one more step (Item 4 Option A): serially replay the last
 * accepted preload of each session per "session version registry", so the prerender process
 * relearns which version each session is on and restores the ready index (`replayReadySessions`).
 */

const store = createMirrorStore();

export type MirrorVersion = { session: string; localRev: number; project: any; hash: string; at: number };

/** Latest version of current editor page session */
export function latestMirror(): MirrorVersion | null { return store.latestMirror() as MirrorVersion | null; }
(globalThis as any).__PC_LATEST_MIRROR__ = latestMirror;
/** Fetch by `{session, localRev}`. Omitting `localRev` = latest version of that session */
export function getMirror(session: string, localRev?: number | string | null): MirrorVersion | null {
  return store.getMirror(session, localRev as any) as MirrorVersion | null;
}
/** C4: "which layers are currently missing near playhead" reported by the page, up to 8 entries */
export type WantedFrame = { clipId: string; frame: number };
/** Playhead of current editor page session */
export function latestPlayhead(): { session: string; t: number; playing: boolean; at: number; wanted?: WantedFrame[] } | null {
  return store.latestPlayhead() as any;
}

/** Address on editor side (only prerender process has it); omitted in `agent` mode */
function editorUrl(): string { return String(process.env.PROMPTCUT_EDITOR_URL || "").replace(/\/+$/, ""); }

const pulling = new Map<string, Promise<MirrorVersion | null>>();

/**
 * Get a project version; if not in this process, pull back once via `PROMPTCUT_EDITOR_URL`.
 * Returns null if unavailable: callers (prologue of frame plugin) use this
 * to return 409 `MIRROR_MISSING`.
 */
export async function ensureMirror(session: string, localRev?: number | string | null): Promise<MirrorVersion | null> {
  if (!session) return null;
  const hit = getMirror(session, localRev);
  if (hit) return hit;
  const base = editorUrl();
  if (!base) return null;
  const key = `${session}@${localRev ?? ""}`;
  let inFlight = pulling.get(key);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const query = `session=${encodeURIComponent(session)}` + (localRev === undefined || localRev === null || localRev === "" ? "" : `&localRev=${encodeURIComponent(String(localRev))}`);
        const res = await fetch(`${base}/api/data/project?${query}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return null;
        const data: any = await res.json();
        if (!data?.ok || !data.project) return null;
        // What is pulled back is by definition "the version missing in this process",
        // often older than the latest in hand: use insert,
        // bypass pushFull's stale gate (that gate blocks out-of-order pushes;
        // if it blocks pull-backs, it can never be recovered)
        store.insert({ session: data.session || session, localRev: data.localRev, project: data.project });
        return getMirror(data.session || session, data.localRev);
      } catch { return null; }
      finally { pulling.delete(key); }
    })();
    pulling.set(key, inFlight);
  }
  return inFlight;
}

/* ---------------------------------------------------------------- Forwarding */

let forwardChain: Promise<unknown> = Promise.resolve();

async function postJson(url: string, body: unknown, timeoutMs = 15000) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.PROMPTCUT_INTERNAL_TOKEN) headers["x-pc-internal-token"] = process.env.PROMPTCUT_INTERNAL_TOKEN;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, data: await res.json().catch(() => null) as any };
}

/** Forward this push to the prerender process. Only the editor process does this */
function forward(pathname: string, payload: any, fallbackFull: () => any | null) {
  if (isPrerender) return;
  const remote = prerenderState();
  if (!remote.ready || !remote.url) return;
  const url = remote.url;
  forwardChain = forwardChain.then(async () => {
    try {
      const { status } = await postJson(url + pathname, payload);
      // It just restarted and has no baseline: backfill a full copy,
      // otherwise every subsequent patch will miss the baseline
      if (status === 409) {
        const full = fallbackFull();
        if (full) await postJson(url + "/api/data/project", full);
      }
    } catch { /* Prerender not ready / restarting: pull-back and catch-up push can still cover it */ }
  }, () => {});
}

/** After prerender process restarts: push the latest full copy of each session to catch up */
export async function repushMirror(url: string): Promise<void> {
  const all = store.allLatest() as MirrorVersion[];
  for (const v of all) {
    try { await postJson(url + "/api/data/project", { session: v.session, localRev: v.localRev, project: v.project }); }
    catch { /* If catch-up fails, wait for the next push or pull-back */ }
  }
}

/* ------------------------------------------------ Session version registry (Item 4 Option A) */

/**
 * The last preload accepted by the prerender process for each page session
 * (`server/ready-session-registry.mjs`). Only populated in the editor process;
 * replayed by `replayReadySessions` after the prerender process restarts.
 */
const readySessions = createReadySessionRegistry();

/**
 * Prerender process accepted a preload: report to editor process to register.
 * What editor process receives itself is registered in place.
 * Fire and forget: registration is only for restart recovery, dropping one does not matter
 * (the next preload will report again).
 */
export function reportReadySession(session: string, localRev: unknown): void {
  if (!session) return;
  if (!isPrerender) { readySessions.record(session, localRev); return; }
  const base = editorUrl();
  if (!base) return;
  void postJson(base + "/api/data/ready-session", { session, localRev }, 3000).catch(() => {});
}

/** For testing / diagnostics */
export function readySessionList() { return readySessions.list(); }

/**
 * After prerender process restarts and mirror catch-up push finishes: serially replay preload
 * per registry (one at a time, most recently active first).
 * `isCurrent`: if prerender process changes again during replay (restarts again),
 * stop and hand off to the next round.
 */
export async function replayReadySessions(url: string, isCurrent: () => boolean = () => true) {
  return replaySessions({
    sessions: readySessions.list(),
    resolve: (session: string, localRev: number) => (getMirror(session, localRev) ?? getMirror(session))?.localRev ?? null,
    preload: async ({ session, localRev }: { session: string; localRev: number }) => {
      const { status, data } = await postJson(url + "/api/frames/preload", { session, localRev, lane: "background" }, 10000);
      return { ok: status >= 200 && status < 300, status: data?.status ?? status };
    },
    isCurrent,
  });
}

/* ---------------------------------------------------------------- HTTP */

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, res: ServerResponse, limit: number, then: (d: any) => void) {
  let body = "", size = 0, over = false;
  req.on("data", (c: Buffer) => {
    if (over) return;
    size += c.length;
    if (size > limit) { over = true; sendJson(res, 413, { ok: false, error: "Push body too large" }); req.destroy(); return; }
    body += c;
  });
  req.on("end", () => {
    if (over) return;
    try { then(JSON.parse(body || "{}")); }
    catch (e: any) { sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
  });
}

function query(req: IncomingMessage, key: string): string | null {
  try { return new URL(req.url || "/", "http://127.0.0.1").searchParams.get(key); } catch { return null; }
}

export function mirrorPlugin(): Plugin {
  return {
    name: "promptcut-mirror",
    configureServer(server: ViteDevServer) {
      /* Full push + read by key */
      server.middlewares.use("/api/data/project", (req, res) => {
        if (req.method === "GET") {
          const session = query(req, "session");
          const localRev = query(req, "localRev");
          const v = session ? getMirror(session, localRev) : latestMirror();
          if (!v) return sendJson(res, 404, { ok: false, error: "No mirror yet: the editor page has never been opened, or this version has already slid out of the window" });
          const head = latestPlayhead();
          // rev / t are legacy field names, kept for callers that have not yet updated
          return sendJson(res, 200, { ok: true, session: v.session, localRev: v.localRev, rev: v.localRev, projectHash: v.hash, at: v.at, t: head?.t ?? 0, project: v.project });
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "GET / POST only" });
        readBody(req, res, 64 * 1024 * 1024, (d) => {
          try {
            const session = String(d.session || "");
            const localRev = Number(d.localRev ?? d.rev) || 0;
            const out = store.pushFull({ session, localRev, project: d.project });
            sendJson(res, 200, { ok: true, session, localRev: out.localRev, projectHash: out.hash, ...(out.status === "stale" ? { stale: true } : {}) });
            /*
             * Full pushes are **always** forwarded, even on `stale`: after the page receives a 409
             * MIRROR_MISSING for a frame request, it re-pushes the full copy once, and the editor side
             * most likely already has this version (what lacks it is the prerender side). If not forwarded
             * here, the "re-push" only loops within the editor, and prerender will never catch up on that
             * version. The forwarded full copy carries its own baseline; if it arrives late, the other side
             * drops it itself via `stale` without corrupting the sequence (patches cannot do this: they need
             * a baseline, so they are only forwarded on `ok`).
             */
            const payload = { session, localRev, project: d.project };
            forward("/api/data/project", payload, () => payload);
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /* Two-level diff */
      server.middlewares.use("/api/data/diff", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        readBody(req, res, 16 * 1024 * 1024, (d) => {
          try {
            const session = String(d.session || "");
            const out = store.pushDiff({ session, fromLocalRev: d.fromLocalRev, toLocalRev: d.toLocalRev, hash: d.projectHash, patch: d.patch });
            if (out.status === "resync") {
              return sendJson(res, 409, { ok: false, code: "MIRROR_RESYNC", reason: out.reason, localRev: out.localRev, error: `Mirror mismatch (${out.reason}), push the whole project again` });
            }
            sendJson(res, 200, { ok: true, session, localRev: out.localRev, projectHash: out.hash, ...(out.status === "stale" ? { stale: true } : {}) });
            if (out.status === "ok") {
              const payload = { session, fromLocalRev: d.fromLocalRev, toLocalRev: d.toLocalRev, projectHash: d.projectHash, patch: d.patch };
              forward("/api/data/diff", payload, () => {
                const v = getMirror(session, out.localRev);
                return v ? { session, localRev: v.localRev, project: v.project } : null;
              });
            }
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /*
       * Session version registry (Item 4 Option A): the prerender process checks in here every time
       * it accepts a preload. Registered only in the editor process: it is the parent process of the
       * prerender process, and after prerender crashes and restarts, it replays preloads from the table.
       */
      server.middlewares.use("/api/data/ready-session", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        if (isPrerender) return sendJson(res, 404, { ok: false, error: "Session versions are only registered in the editor process" });
        readBody(req, res, 4 * 1024, (d) => {
          const session = typeof d.session === "string" ? d.session : "";
          if (!session || session.length > 200) return sendJson(res, 400, { ok: false, error: "Invalid session parameter" });
          sendJson(res, 200, { ok: true, changed: readySessions.record(session, d.localRev) });
        });
      });

      /*
       * The playhead takes a separate path. Its cadence is completely different from the project:
       * the project is "push only on change", while the playhead is "report current time once when
       * stopped": if mixed together, scrubbing the playhead would send the whole project on another
       * round trip.
       *
       * C4's `wanted` rides on the same path (up to 8 `{clipId, frame}` entries): the page reports
       * at most once every 100 ms "which layers are currently missing near the playhead", and the
       * editor process **forwards it as-is, just like diffs**, to the prerender process without waiting
       * for a reply, so that `latestPlayhead()` in the prerender process can include it.
       * Omitting `wanted` from the forwarded body means silently dropping the entire hint, so the
       * whitelist here and in `setPlayhead` must be updated together.
       */
      server.middlewares.use("/api/data/playhead", (req, res) => {
        if (req.method === "GET") {
          const head = latestPlayhead();
          return sendJson(res, head ? 200 : 404, head ? { ok: true, ...head } : { ok: false, error: "No playhead yet" });
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "GET / POST only" });
        readBody(req, res, 64 * 1024, (d) => {
          try {
            const session = String(d.session || "");
            const head = store.setPlayhead(session, d.t, d.playing, d.wanted);
            sendJson(res, 200, { ok: true, ...head });
            forward("/api/data/playhead", { session, t: head.t, playing: head.playing, ...(head.wanted ? { wanted: head.wanted } : {}) }, () => null);
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  };
}

export default mirrorPlugin;
