import type { Project } from "../kernel/project";
import { invalidatePrerenderBase, prerenderUrl } from "./prerender";
import { alignMirror, resyncDataMirror } from "./dataMirror";
import { reachableCutContents } from "../kernel/cutIdentity.mjs";

export type FrameTarget = "user" | "prerender";
export type FrameLane = "user" | "inter_face" | "agent" | "background" | "archive" | "playback";
export interface FrameRequestOptions {
  /** 人类预览同源；长任务和后台预渲染可显式走预渲染进程。 */
  target?: FrameTarget;
  lane?: FrameLane;
}

const signatureFields = (project: Project) => JSON.stringify([project.width, project.height, project.fps, project.duration, project.themeId, project.camera3dFov, project.tracks, project.media, project.filters, project.pixelMaps, project.audioFx, project.cardNodes, project.style]);
// 剪辑段引用的剪辑有才加(kernel/cutIdentity.mjs),没有剪辑段的项目签名一个字节不变
const signature = (project: Project) => {
  const cutRefs = reachableCutContents(project);
  return signatureFields(project) + (cutRefs.length ? JSON.stringify(cutRefs) : "");
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
  return Object.assign(new Error(`帧服务连接中断（${detail}）。渲染 Chrome 或服务可能正在重启，请稍后重试。`, { cause: error }), {
    code: "FRAME_SERVICE_UNAVAILABLE",
    retryable: true,
  });
}
/**
 * 一次帧请求。**body 里不带项目**,只带 `{session, localRev, lane, ...extra}`(A7):
 * 服务端按这个键从本进程的镜像插件取项目(server/vite-plugin-mirror.ts)。发之前先对齐 ——
 * 号和已推上去的对不上就 flush 一次,不然服务端拿到的是上一版,拖一格看到的还是上一格。
 *
 * 不做镜像的页面(只读观看页 / 舞台页 / 导出页)拿不到键,退回迁移期那条路:body 里带项目。
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
  // 那一端的镜像里没有这个键(多半是预渲染刚重启、转发正好丢在那一下):整份重推一次再来过。
  // 只补一次 —— 补完还取不到就是别的毛病,接着重试只会把 409 刷成一串。
  if (res.status === 409 && result?.code === "MIRROR_MISSING" && key && !resynced && !signal?.aborted) {
    await resyncDataMirror();
    return frameRequest(operation, project, extra, signal, options, true);
  }
  if (!res.ok) throw Object.assign(new Error(result.error || "帧读取失败"), {
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
   * D5:缺省打**预渲染的源**(R7 之前是 `"user"`,也就是编辑器自己的源)。
   * 编辑器进程现在是 `interactive: false`,`user` / `playback` 两条 lane 立即回
   * `USE_PRERENDER` —— 缺省留在同源等于每一次都先撞一堵墙。`?preview=legacy`
   * 的整帧 `<img>` 也走这里,所以它的 `see` 同样打预渲染源(D5 回滚开关那条)。
   */
  return frameRequest("see", project, { times }, signal, { target: options.target ?? "prerender", lane: options.lane ?? "user" });
}
