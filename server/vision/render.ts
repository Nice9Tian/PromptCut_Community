/**
 * 渲染入口:把「这份项目的这几个时刻」变成 PNG。从 server/vite-plugin-vision.ts 逐字搬来。
 *
 * **这份模块状态只有这里能写**:`counter`(临时文件名的取号器)。bake.ts 通过 `nextCounter()` 取号,
 * 全进程只有这一个计数器。依赖方向:render → worker-pool / http,单向。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { frameService, renderProject } from "../vite-plugin-frames";
import { postFrame } from "../png-post.mjs";
import { outRoot } from "./http";
import { cardBitmapScratch, renderCardBitmaps } from "./card-bitmap";
import { runExport } from "./worker-pool";
import type { RenderJob2, Runner } from "./worker-pool";

let counter = 0;

/** 删临时导出目录,删不掉按退避重试(Windows 上渲染子进程刚退、文件可能还占着)。回是否删掉了。 */
async function removeTempDir(dir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); return true; }
    catch { await new Promise((r) => setTimeout(r, 200 * (attempt + 1))); }
  }
  return false;
}

/** 取一个号。`counter` 只住在本模块,跨模块(bake.ts 的临时文件名)只能通过它取 */
export function nextCounter(): number {
  return counter++;
}

/** 一帧交出去的结果。width / height / transparentRatio 只在做过后处理时才有 */
export interface FrameResult {
  buf: Buffer;
  width?: number | null;
  height?: number | null;
  transparentRatio?: number;
  /**
   * D3:这一帧的实体矩形(舞台像素坐标,不是缩图坐标)。只在要了 rects 时有;null = 这一帧没量出来。
   * 某项的 `solid` 为 null 表示那张卡此刻没有实体像素。
   */
  rects?: EntityRect[] | null;
}

/** D3:一张卡在这一帧的包裹层外框和实体范围,都是 `[x, y, w, h]` 舞台像素 */
export interface EntityRect {
  clipId: string;
  box: [number, number, number, number];
  solid: [number, number, number, number] | null;
}

/** 渲染的附加选项 */
export interface RenderOpts {
  /** 调用方不要了就拨它:排队的摘掉,在跑的叫停 */
  signal?: AbortSignal;
  /** 交出去之前的像素活:shrink = 给模型看的缩图;bg = 压底色(六位十六进制);stats = 数透明像素 */
  post?: { shrink?: boolean; bg?: string | null; stats?: boolean };
  /** 谁来跑:不给就是渲染池 */
  runner?: Runner;
  /**
   * D3:每帧附实体矩形(`FrameResult.rects`),并按 clipId 一行写进 `notes`(工具结果的文字部分)。
   * 不给就看 `post.shrink`:缩图 = 给模型看的那张(`see_frames`),给模型看的图一律附矩形;
   * 预渲染贴图、动图这些不缩图的调用方不付这一趟。只在 FramePipeline 那条路上有,`runner` 旁路不量。
   */
  rects?: boolean;
  /**
   * FramePipeline 那条路上排哪条队(`mechanism/rendering.md`「查询渲染与预渲染进程」)。缺省 `"agent"`:Agent 的查询,
   * 只在 Agent 专用实例上走(`see_frames`、`get_gif` 的 `/render`、`bake_card`)。
   *   - `"preview"`:用户在 AI 栏点开的操作预览 —— 插在普通预渲染队列所有待办之前,不占用 Agent 的专用实例;
   *   - `"prerender"`:普通的预渲染(3D 视图的空闲贴图预取)—— 排普通预渲染队列的队尾,Agent 专用实例空闲时可以接。
   * `runner` 旁路不看它。
   */
  lane?: "agent" | "preview" | "prerender";
  /**
   * 单张卡片画面(`bake_card`、3D 视图的贴图):当场渲出位图,不建帧库条目、不查也不写帧库、不生成快照
   * (`card-bitmap.ts`;`mechanism/asset-service.md`「不经任务队列的单张卡片画面」)。不附实体矩形。`runner` 旁路不看它
   * (那条路本来就只在临时目录里出 PNG、用完删)。
   */
  bitmapOnly?: boolean;
}

const fmtBox = (b: readonly number[] | null) => (b ? `[${b.join(", ")}]` : "null");

/**
 * D3 的文字部分:每帧一段,段里按 clipId 一行。坐标是舞台像素(项目的 width × height);
 * 给模型看的图多半缩过,所以两个尺寸都写出来。
 */
export function entityRectsNote(stage: { width: number; height: number }, fps: number, frames: [number, EntityRect[] | null][], image?: { width?: number | null; height?: number | null }): string {
  const scaled = image?.width && image?.height && (image.width !== stage.width || image.height !== stage.height)
    ? `图片缩到了 ${image.width}×${image.height},按比例换算` : "和图片像素一致";
  const head = `实体矩形(舞台 ${stage.width}×${stage.height} 像素坐标 [x, y, w, h],${scaled};box = 片段包裹层外框,solid = 实体像素的范围,solid 为 null = 这张卡此刻没有实体像素):`;
  const blocks = frames.map(([frame, rects]) => {
    const t = `t=${+(frame / fps).toFixed(3)}s`;
    if (!rects) return `${t}:没量出来。`;
    if (!rects.length) return `${t}:画面上没有片段。`;
    return [`${t}:`, ...rects.map((r) => `${r.clipId} box=${fmtBox(r.box)} solid=${fmtBox(r.solid)}`)].join("\n");
  });
  return [head, ...blocks].join("\n");
}

/** 给已经渲好的几帧附实体矩形。量不出来不连累图片:记一句话照样交图;只有调用方撤了才往上抛 */
async function attachEntityRects(service: ReturnType<typeof frameService>, project: any, times: number[], result: Map<number, FrameResult>, notes: string[], signal?: AbortSignal): Promise<void> {
  try {
    const measured: Map<number, EntityRect[] | null> = await service.entityRects(project, times, { signal });
    for (const [frame, value] of result) value.rects = measured.get(frame) ?? null;
    const fps = Number(project.fps) > 0 ? project.fps : 30;
    const frames = [...result.keys()].sort((a, b) => a - b);
    notes.push(entityRectsNote({ width: project.width, height: project.height }, fps,
      frames.map((frame): [number, EntityRect[] | null] => [frame, result.get(frame)?.rects ?? null]), result.get(frames[0])));
  } catch (e: any) {
    if (signal?.aborted) throw e;
    for (const value of result.values()) value.rects = null;
    notes.push(`实体矩形没量出来(${e?.message || e}),图片不受影响。`);
  }
}

/**
 * 跑一次单帧渲染,拿到那一帧的 PNG 字节。
 *
 * 默认路径通过 FramePipeline 在同一个 Chrome 页面里渲染完整 FrameScene；视频只在目标截图帧
 * 挂载并 seek。显式选择旧 ffmpeg 兼容旁路时，才会把素材层单独抽帧并合到卡片下面。
 */
/**
 * 单帧就是只要一个时刻的 renderFrames:两条路截出来的画面逐字节相同(单张走 frames `F-F`
 * 也是从第 0 帧推到 F,见 renderFrames 的说明),合成一条就不会出现「单张和批量不是同一张图」。
 */
export async function renderOneFrame(root: string, origin: string, project: any, t: number, notes: string[], priority = 0, o: RenderOpts = {}): Promise<FrameResult> {
  const m = await renderFrames(root, origin, project, [t], notes, priority, o);
  const first = m.values().next().value;
  if (!first) throw new Error("一帧都没渲出来");
  return first;
}

/**
 * 一趟渲**同一份项目的若干个时刻**。返回「帧号 → PNG」。
 *
 * 和 renderOneFrame 的唯一区别是「一趟出几张」。为什么值得单开一条路:导出脚本不管要第几帧
 * 都从第 0 帧顺推(确定性要求 —— 动画的锚点是「首次出现那一帧」,跳着推就没有锚点),
 * 所以渲一张卡的 N 个时刻,分 N 趟就是 N 次重复顺推,是 O(N²);一趟推过去沿途截,推进只付一次。
 *
 * 实测(1920x1080、同一张卡的 7 个时刻):分 7 趟 31.0s → 一趟 2.7s,**11.4 倍**,而且
 * 7 张逐字节相同。单价拆开是:推一帧约 18~23ms,截一张约 78ms,而单独起一趟要 4.0~5.0s。
 * 也就是说同一张卡的第 2 个时刻起,成本从 4400ms 掉到 78ms。
 */
export async function renderFrames(root: string, origin: string, project: any, times: number[], notes: string[], priority = 0, o: RenderOpts = {}): Promise<Map<number, FrameResult>> {
  if (!o.runner && o.bitmapOnly) {
    const shots = await renderCardBitmaps(root, origin, project, times, { signal: o.signal, lane: o.lane ?? "agent" });
    const result = new Map<number, FrameResult>();
    const wantPost = !!(o.post && (o.post.shrink || o.post.bg || o.post.stats));
    const scratch = cardBitmapScratch(root);
    for (const [frame, buf] of shots) {
      if (!wantPost) { result.set(frame, { buf, width: project.width, height: project.height }); continue; }
      // 压底色、数透明像素照旧交给 postFrame(它按文件收发);临时文件放在这条路自己的空目录里,用完就删
      const stem = path.join(scratch, "post-" + process.pid + "-" + counter++);
      const file = stem + "-input.png", out = stem + ".png";
      try {
        await fsp.mkdir(scratch, { recursive: true });
        await fsp.writeFile(file, buf);
        const info = await postFrame({ cards: file, layers: [], out, bg: o.post?.bg ?? null, shrink: !!o.post?.shrink, stats: !!o.post?.stats });
        result.set(frame, { ...info, buf: await fsp.readFile(out) });
      } finally { await Promise.all([fsp.rm(out, { force: true }), fsp.rm(file, { force: true })]); }
    }
    return result;
  }
  if (!o.runner) {
    const service = frameService(root, origin);
    const normalized = renderProject(project);
    const entry = await service.entry(normalized);
    const frames = await service.see_frames(normalized, times, { signal: o.signal, lane: o.lane ?? "agent" });
    const result = new Map<number, FrameResult>();
    for (const [frame, value] of frames) {
      if (value.incomplete) throw new Error(`画面尚未就绪：${(value.missing || []).join("、")}`);
      if (o.post && (o.post.shrink || o.post.bg || o.post.stats)) {
        // The authoritative frame may come from MOV, a mixed control cache,
        // or live rendering. None promises a duplicate in frames/<n>.png.
        const stem = path.join(entry.dir, "post-" + process.pid + "-" + counter++);
        const file = stem + "-input.png", out = stem + ".png";
        try {
          await fsp.mkdir(entry.dir, { recursive: true });
          await fsp.writeFile(file, value.buf);
          const info = await postFrame({ cards: file, layers: [], out, bg: o.post.bg ?? null, shrink: !!o.post.shrink, stats: !!o.post.stats });
          result.set(frame, { ...info, buf: await fsp.readFile(out) });
        } finally { await Promise.all([fsp.rm(out, { force: true }), fsp.rm(file, { force: true })]); }
      } else result.set(frame, { buf: value.buf, width: project.width, height: project.height });
    }
    if (o.rects ?? !!o.post?.shrink) await attachEntityRects(service, normalized, times, result, notes, o.signal);
    return result;
  }

  // 带上 pid:编辑器进程(热备渲染器)和预渲染进程往同一个 out/ 里写,各自的 counter 都从 0 数
  const id = `vision-${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const dir = path.resolve(outRoot(root), `export-${id}`);
  await fsp.mkdir(dir, { recursive: true });

  const fps = project.fps || 30;
  // 帧号必须落在项目时长内,否则脚本会去渲一个空舞台,模型看到一片空白还以为卡没生效
  const maxFrame = Math.max(0, Math.floor((project.duration || 0) * fps) - 1);
  const frames = [...new Set(times.map((t) => Math.min(maxFrame, Math.max(0, Math.round(t * fps)))))].sort((a, b) => a - b);
  const pad = (f: number) => String(f).padStart(6, "0");
  const frameFile = (f: number) => path.join(dir, "frames", `${pad(f)}.png`);
  const finalFile = (f: number) => path.join(dir, `final-${pad(f)}.png`);

  try {
    // 素材层按帧各抽各的,和起 Chrome 渲卡片并行跑(卡片的隔离项目通常没有素材层,这里多半是空的)
    const layersPromises = frames.map(() => Promise.resolve([]));
    await fsp.writeFile(path.join(dir, "project.json"), JSON.stringify(project, null, 2), "utf8");
    const relOut = process.env.PROMPTCUT_EXPORT_DIR ? dir : `out/export-${id}`;
    const wantPost = !!(o.post && (o.post.shrink || o.post.bg || o.post.stats));
    const job: RenderJob2 = {
      opts: {
        url: `${origin}/?export=1&timeline=/@export/${id}/project.json`,
        out: relOut,
        frames: `0-${frames[frames.length - 1]}`,
        targetFrames: frames,
        fps,
      },
      /*
       * 渲完帧再决定要不要后处理:素材层这时也抽好了。**什么都不用做就返回 null**,
       * 下面直接读帧文件交出去 —— 原来没有素材层时也要解码再原样编码一遍,纯属白烧。
       */
      post: async () => {
        const layers = await Promise.all(layersPromises);
        if (!wantPost && layers.every((l) => l.length === 0)) return null;
        return frames.map((f, i) => ({
          cards: frameFile(f), layers: layers[i], out: finalFile(f),
          bg: o.post?.bg ?? null, stats: !!o.post?.stats, shrink: !!o.post?.shrink,
        }));
      },
    };
    const run: Runner = o.runner ?? ((j, s) => runExport(root, j, priority, s));
    const results = await run(job, o.signal);

    const out = new Map<number, FrameResult>();
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const r = results ? results[i] : null;
      const buf = await fsp.readFile(r ? finalFile(f) : frameFile(f));
      out.set(f, {
        buf,
        width: r?.width ?? null,
        height: r?.height ?? null,
        ...(r && r.transparentRatio !== undefined ? { transparentRatio: r.transparentRatio } : {}),
      });
    }
    return out;
  } finally {
    // 看一眼就够了,不留垃圾:等删完(Windows 上渲染子进程刚退、文件可能还占着,退避重试);
    // 还是删不掉也不该让这次调用失败,记一笔,下次启动由 sweepExportRoot 按 pid 清
    if (!(await removeTempDir(dir))) console.warn(`[vision] 临时导出目录删不掉,留给下次启动清理:${dir}`);
  }
}
