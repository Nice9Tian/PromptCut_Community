import type { Project } from "../kernel/project";
import { invalidatePrerenderBase, prerenderUrl } from "./prerender";
import { alignMirror, resyncDataMirror } from "./dataMirror";
import { activeCutRenderMeta, reachableCutContents } from "../kernel/cutIdentity.mjs";

export type FrameTarget = "user" | "prerender";
export type FrameLane = "user" | "inter_face" | "agent" | "background" | "archive" | "playback";
export interface FrameRequestOptions {
  /** Human preview uses same-origin; long tasks and background prerendering can explicitly go through the prerender process. */
  target?: FrameTarget;
  lane?: FrameLane;
}

const signatureFields = (project: Project) => JSON.stringify([project.width, project.height, project.fps, project.duration, project.themeId, project.camera3dFov, project.tracks, project.media, project.filters, project.pixelMaps, project.audioFx, project.cardNodes, project.style]);
// Added only when cuts referenced by cut segments exist (kernel/cutIdentity.mjs); project
// signatures without cut segments remain unchanged by a single byte
const signature = (project: Project) => {
  const cutRefs = reachableCutContents(project);
  const cutMeta = activeCutRenderMeta(project);
  return signatureFields(project) + (cutRefs.length ? JSON.stringify(cutRefs) : "") + (cutMeta ? JSON.stringify(cutMeta) : "");
};
let saved: { signature: string; snapshots: string } | null = null;
let restorePending: Promise<void> | null = null;
export function snapshotsFor(project: Project) { return saved?.signature === signature(project) ? saved.snapshots : undefined; }
export function restoreSnapshots(project: Project, snapshots?: string) {
  saved = typeof snapshots === "string" ? { signature: signature(project), snapshots } : null;
  restorePending = saved
    ? frameRequest("import", project, { snapshots: saved.snapshots }, undefined, { target: "user", lane: "archive" }).then(() => undefined, () => undefined)
    : null;
}
function frameFetchError(error: any) {
  if (error?.name === "AbortError") return error;
  const detail = error?.cause?.code || error?.cause?.message || error?.message || String(error);
  return Object.assign(new Error(`Frame service connection lost (${detail}). The render Chrome or the service may be restarting, please try again later.`, { cause: error }), {
    code: "FRAME_SERVICE_UNAVAILABLE",
    retryable: true,
  });
}
/**
 * A single frame request. **Body does not carry the project**, only
 * `{session, localRev, lane, ...extra}` (A7): the server retrieves the project by this key from
 * this process's mirror plugin (server/vite-plugin-mirror.ts). Aligns before sending: if the
 * revision number does not match what was pushed, flush once first, otherwise the server receives
 * the previous version and scrubbing one step still displays the previous step.
 *
 * Pages that do not mirror (read-only viewing page / stage page / export page) cannot obtain a key
 * and fall back to the migration-period path: carrying the project in the body.
 */
export async function frameRequest(operation: string, project: Project, extra: Record<string, unknown> = {}, signal?: AbortSignal, options: FrameRequestOptions = {}, resynced = false): Promise<any> {
  let url = options.target === "prerender" ? await prerenderUrl(`/api/frames/${operation}`) : `/api/frames/${operation}`;
  let res: Response;
  const key = await alignMirror();
  const payload = key
    ? { session: key.session, localRev: key.localRev, lane: options.lane, ...extra }
    : { project, lane: options.lane, ...extra };
  const request = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal });
  try {
    res = await request();
  } catch (error) {
    // A prerender restart changes its port.  Retry one time against the new
    // health-checked address; never retry a caller cancellation.
    if (options.target === "prerender" && (error as any)?.name !== "AbortError") {
      invalidatePrerenderBase();
      try {
        url = await prerenderUrl(`/api/frames/${operation}`);
        res = await request();
      } catch (retryError) { throw frameFetchError(retryError); }
    } else throw frameFetchError(error);
  }
  let result: any;
  try { result = await res.json(); }
  catch (error) { throw frameFetchError(error); }
  // The mirror on the other end lacks this key (mostly because prerender just restarted and forwarding
  // happened to drop at that exact moment): repush the full copy once and try again. Replenish only
  // once: if still unobtainable after replenishing, something else is wrong, and continuing to retry
  // will just flood a series of 409s.
  if (res.status === 409 && result?.code === "MIRROR_MISSING" && key && !resynced && !signal?.aborted) {
    await resyncDataMirror();
    return frameRequest(operation, project, extra, signal, options, true);
  }
  if (!res.ok) throw Object.assign(new Error(result.error || "Frame read failed"), {
    code: result.code,
    status: res.status,
    retryable: result.retryable,
  });
  if (result.video) result.video = new URL(result.video, new URL(url, location.href)).href;
  if (result.mov) result.mov = new URL(result.mov, new URL(url, location.href)).href;
  if (result.movie) result.movie = new URL(result.movie, new URL(url, location.href)).href;
  if (result.frames) result.frames = result.frames.map((f: any) => f.url ? { ...f, url: new URL(f.url, new URL(url, location.href)).href } : f);
  return result;
}
export async function collectSnapshots(project: Project) {
  const result = await frameRequest("archive", project, {}, undefined, { target: "user", lane: "archive" });
  saved = typeof result.snapshots === "string" ? { signature: signature(project), snapshots: result.snapshots } : null;
  restorePending = null;
}
/** Timeline preview and Agent use this same server queue. */
export async function see_frames(project: Project, times: number[], signal?: AbortSignal, options: FrameRequestOptions = {}) {
  // Loading a .proc restores the compressed archive asynchronously.  Wait for
  // that import before the first foreground request so a freshly opened
  // project can actually hit its saved B/C cache instead of starting A again.
  await restorePending;
  /*
   * D5: Defaults to hitting the **prerender origin** (before R7 it was `"user"`, namely the editor's
   * own origin). The editor process is now `interactive: false`, and both `user` / `playback` lanes
   * immediately return `USE_PRERENDER`: defaulting to staying same-origin means hitting a brick wall
   * every time. Full-frame `<img>` in `?preview=legacy` also goes through here, so its `see` likewise
   * hits the prerender origin (the D5 rollback switch path).
   */
  return frameRequest("see", project, { times }, signal, { target: options.target ?? "prerender", lane: options.lane ?? "user" });
}
