/**
 * 单张卡片画面(`bake_card`、3D 视图的贴图)当场渲出位图:把这份(只剩一张卡的)项目装进预渲染间,
 * 从这张卡的挂载帧推到要的那几帧,直接截成 PNG 交回去。
 *
 * 语义:`docs/semantics/mechanism/asset-service.md`「不经任务队列的单张卡片画面……是当场渲出的位图,不存这张卡的 HTML」、
 * `docs/semantics/glossary.md`「快照」(任何地方都不把某一张卡的快照存下来)。
 *
 * 和 `FramePipeline.see_frames` 的区别只在「记不记」:
 *   - 不建帧库条目、不查也不写帧库(`<帧库>/<键>/` 下的整场景 HTML 档、逐帧 PNG、`controls-html/` 都不碰)。
 *     以前这条路经 `see_frames` 走,隔离出来的单卡项目在帧库里各占一个条目,条目里存着它的 HTML,
 *     这张卡的快照还会进快照库、推到素材服务的 `snap`;旧条目留在原处按容量上限淘汰,这里不读它们;
 *   - 不生成快照:截图就是这一帧的画面(`bakeFrames` 的 `fullFrame`),一份 HTML 都不产;
 *   - 不往页面里注别处预渲染好的卡片帧(`cardRender`):这张卡在这里真渲。
 * 排队照旧:Agent 的走 Agent 专用实例(`runAgentTask`),用户等着看的贴图插在普通预渲染待办之前、
 * 空闲贴图预取排队尾(`runQueueTask`),缩放都是 1 倍(`mechanism/rendering.md`「查询渲染与预渲染进程」)。
 *
 * 位图的缓存、对账、推送远程素材服务在调用方(`bake.ts` 的 `bakeOne` 经 `bake-store.mjs`),这里只出像素。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { frameService, renderProject } from "../vite-plugin-frames";
import { bakeFrames } from "../bakery/index.mjs";
import { dirtyStreamLease } from "../bakery/bake.mjs";
import { outRoot } from "./http";

/** `bakeFrames` 要一个输出目录(它会建 `<out>/frames`);这条路不写帧文件,目录一直是空的 */
export const cardBitmapScratch = (root: string) => path.join(outRoot(root), "card-bitmap-scratch");

/**
 * 渲这份项目的若干个时刻,回「帧号 → PNG」。帧号的算法同 `see_frames`:按 fps 取整、夹在项目时长内。
 * `lane`:`"agent"`(缺省)/ `"preview"` / `"prerender"`,见文件头。
 */
export async function renderCardBitmaps(
  root: string,
  origin: string,
  project: any,
  times: number[],
  o: { signal?: AbortSignal; lane?: "agent" | "preview" | "prerender" } = {},
): Promise<Map<number, Buffer>> {
  const service: any = frameService(root, origin);
  const normalized = renderProject(project);
  const fps = normalized.fps || 30;
  const max = Math.max(0, Math.floor((normalized.duration || 0) * fps) - 1);
  if (!times.length || times.some((t) => !Number.isFinite(t))) throw new Error("Frame times must be finite numbers");
  const frames = [...new Set(times.map((t) => Math.max(0, Math.min(max, Math.round(t * fps)))))].sort((a, b) => a - b);
  const scratch = cardBitmapScratch(root);
  const shots = new Map<number, Buffer>();
  const work = async (lease: (project: any) => Promise<any>) => {
    if (o.signal?.aborted) throw Object.assign(new Error("Frame request cancelled"), { cancelled: true });
    const bakery = await lease(normalized);
    // 这个预渲染间可能刚做过轨道流:它的流租约到此作废,下一次产流付一次完整回放
    dirtyStreamLease(bakery);
    shots.clear();
    await fsp.mkdir(scratch, { recursive: true });
    await bakeFrames(bakery, {
      out: scratch, targetFrames: frames, snapshotOnly: false, fullFrame: true, writeFrames: false, signal: o.signal,
      onFrame: async (frame: number, buf: Buffer) => { shots.set(frame, buf); },
    });
    return shots;
  };
  const lane = o.lane === "preview" || o.lane === "prerender" ? o.lane : "agent";
  if (lane === "agent") await service.runAgentTask(work);
  else await service.runQueueTask(work, o.signal, { front: lane === "preview", scaleLane: "preview", kind: lane });
  for (const frame of frames) if (!shots.has(frame)) throw new Error(`第 ${frame} 帧没渲出来`);
  return shots;
}
