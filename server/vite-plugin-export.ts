import { confirmedMissing } from "../src/audio/missingMaterialRecord";
import type { Plugin, ViteDevServer, Connect } from "vite";
import type { ServerResponse } from "http";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { createReadStream } from "fs";
import { spawn } from "child_process";
import type { AddressInfo } from "net";
import { exportBegin, exportEnd } from "./render-pool-state.mjs";
import { exportOriginalsGate } from "./export-originals";
import { hashFromUrl, originalHashOf } from "../src/render/mediaTier";
import { EXPORT_KEEP, claimExportDir, pruneExportDir, sweepExportRoot } from "./storage-leftovers.mjs";

interface ExportJob {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  /** 进行到哪一步:render = Chrome 逐帧渲卡片,compose = ffmpeg 合素材编码。done/total 是这一步的帧数 */
  stage?: "render" | "compose";
  message?: string;
  outDir: string;
  /** 绝对路径,给「打开文件夹」和取件用;不回给浏览器以外的地方 */
  absOutDir: string;
  /** 渲染子进程,取消时要连它的子孙一起杀(它自己还会拉起 Chrome 和 ffmpeg) */
  child?: ReturnType<typeof spawn>;
  cancelled?: boolean;
}

/** 允许被浏览器取走的产物,白名单挡住任意读盘 */
const DELIVERABLES = ["preview.mp4", "overlay.mov"] as const;

const jobs = new Map<string, ExportJob>();
let lastJobId: string | null = null;

function sanitizeFilename(name: string) {
  return name.replace(/[/\\]/g, "").replace(/\.\./g, "");
}

/**
 * 导出根目录。桌面版里 root 是安装目录下的 runtime/app,成品不能落在那里(卸载会一起删),
 * 所以优先读壳设置的 PROMPTCUT_EXPORT_DIR(默认 %USERPROFILE%VideosPromptCut);开发期回落到 <root>/out。
 */
function outRoot(root: string): string {
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(root, "out");
}

function inside(file: string, dir: string): boolean {
  const target = path.resolve(file);
  const base = path.resolve(dir);
  return target === base || target.startsWith(base + path.sep);
}

/** The same PromptCut-owned folders exposed by vite-plugin-media. */
function allowedMediaRoots(root: string): string[] {
  const roots = [path.resolve(outRoot(root), "media"), path.join(os.homedir(), "Videos", "PromptCut", "media")];
  if (process.env.PROMPTCUT_MEDIA_DIR) roots.push(path.resolve(process.env.PROMPTCUT_MEDIA_DIR));
  return roots;
}

/**
 * 导出页拿到的项目里,每条素材该用哪个地址(写回 `project.media[].url`,就地改的是这次导出自己的那份 JSON)。
 *
 * - **有合法哈希的**:哈希就是素材的身份,只认素材服务的按哈希地址 `/@media/<素材原尺寸哈希>`(与
 *   `render-project.mjs`、`vite-plugin-vision.ts` 同一条规矩)。不看 `path`:那是导入那台机器上的落点,
 *   在另一台机器上直接打开带对方路径的 `.proc` 再导出,按路径读会解码失败(2026-09-30 `claude/pack-hash` 发现)。
 *   地址本来就是这份哈希的(`/@media/<hash>` 或带扩展名的写法)原样留着。
 * - **没有哈希、地址为空的**(打开项目后本机取不到文件、已标「(缺失)」的老素材,见 `src/editor/io/mediaUpload.ts`):
 *   地址留空,不再按 `path` 读 —— 那台机器上的路径在这里读不到,读了导出页会解码失败、整次导出作废。回在 `skipped` 里,
 *   由 `dropSkippedMediaClips` 从这次导出的时间轴上去掉引用它的片段,并告诉用户(`/api/export` 回包的 `skippedMedia`)。
 *   上传中(`pending`)的不在此列,照旧。
 * - **没有哈希的**(迁移期老素材):照旧按 `path` 走受保护的读接口 `/api/media/file?path=…`;
 *   路径在 PromptCut 的素材目录里、文件又在的,用解析后的绝对路径(老 `.proc` 可能同时带着过期的短地址 `/@media/<文件名>`)。
 * - 浏览器上传进暂存区的(`/@export/media/<文件>`)换成这次导出目录里的地址。
 *
 * `opts` 给单测:素材目录与「文件在不在」可以换掉。
 */
export async function normalizeExportMedia(
  project: any,
  root: string,
  id: string,
  opts: { roots?: string[]; exists?: (file: string) => Promise<boolean> } = {},
): Promise<{ skipped: Array<{ id: string; name: string }> }> {
  const skipped: Array<{ id: string; name: string }> = [];
  if (!project?.media || !Array.isArray(project.media)) return { skipped };
  const roots = opts.roots ?? allowedMediaRoots(root);
  const exists = opts.exists ?? (async (file: string) => { try { await fs.access(file); return true; } catch { return false; } });
  for (const m of project.media) {
    if (!m || typeof m !== "object") continue;
    // 认定过「确认缺失」的素材不改地址、也不跳过:画面与声音的占位核对记录与素材的地址逐字相同(src/audio/missingMaterial.ts),
    // 导出时这些片段照原位置出占位,不去读它的文件。
    // 判定与画面、声音那一侧用同一个函数(记录与素材的类别、名字、地址、哈希都对得上才算)
    if (confirmedMissing(m) && m.url) continue;
    const hash = originalHashOf(m);
    if (hash) {
      const url = String(m.url || "");
      if (hashFromUrl(url) !== hash || !url.includes(hash)) m.url = `/@media/${hash}`;
      continue;
    }
    if (!String(m.url || "") && !m.pending) {
      // 已标缺失:地址留空,不按 path 读(见函数头)
      m.url = "";
      skipped.push({ id: String(m.id ?? ""), name: String(m.name ?? "") });
      continue;
    }
    const rawPath = typeof m.path === "string" ? m.path : "";
    if (rawPath) {
      // Projects from the desktop media library carry an absolute path,
      // while the export page only knows HTTP URLs. Route it through the
      // guarded media endpoint so legacy projects render their real files.
      const file = path.resolve(rawPath);
      const usable = roots.some((dir) => inside(file, dir)) && await exists(file);
      m.url = `/api/media/file?path=${encodeURIComponent(usable ? file : rawPath)}`;
      continue;
    }
    if (m.url && String(m.url).startsWith("/@export/media/")) {
      const fileName = String(m.url).split("/").pop();
      if (fileName) m.url = `/@export/${id}/media/${fileName}`;
    }
  }
  return { skipped };
}

/**
 * 从这次导出的项目(导出自己的那份 JSON,就地改)里去掉引用 `skipped` 素材的片段,跳过这一段而不是让导出页解码失败。
 * 回真的被去掉了片段的素材(同一条素材只列一次,带去掉的片段数);没有片段引用的缺失素材不影响导出,不列。
 */
export function dropSkippedMediaClips(project: any, skipped: Array<{ id: string; name: string }>): Array<{ id: string; name: string; clips: number }> {
  if (!skipped.length || !Array.isArray(project?.tracks)) return [];
  const byId = new Map(skipped.map((m) => [m.id, m]));
  const hits = new Map<string, number>();
  for (const tr of project.tracks) {
    if (!tr || !Array.isArray(tr.clips)) continue;
    tr.clips = tr.clips.filter((c: any) => {
      const mid = c?.mediaId;
      if (typeof mid !== "string" || !byId.has(mid)) return true;
      hits.set(mid, (hits.get(mid) ?? 0) + 1);
      return false;
    });
  }
  return skipped.filter((m) => hits.has(m.id)).map((m) => ({ ...m, clips: hits.get(m.id)! }));
}

async function handleMediaUpload(req: Connect.IncomingMessage, res: ServerResponse, root: string) {
  const rawName = req.url?.split("/").pop();
  if (!rawName) {
    res.statusCode = 400;
    res.end("Missing filename");
    return;
  }
  const name = decodeURIComponent(rawName);
  const safeName = sanitizeFilename(name);
  const stagingDir = path.resolve(outRoot(root), ".export-staging", "media");
  await fs.mkdir(stagingDir, { recursive: true });
  
  const destPath = path.resolve(stagingDir, safeName);
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", async () => {
    const buffer = Buffer.concat(chunks);
    await fs.writeFile(destPath, buffer);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ url: `/@export/media/${encodeURIComponent(safeName)}` }));
  });
}

/**
 * 导出进程退出后收拾产物目录:只留成片、透明层与 project.json(`storage-leftovers.mjs` 的 `pruneExportDir`)。
 * 成功、取消、失败都做 —— 取消和失败留下的 frames / parts 同样是大块的废料;已有的成片、透明层照留,
 * 列表里能看到这次导出。取消时 Chrome / ffmpeg 孙进程可能比渲染进程晚一点退、还占着文件,
 * 删不掉的隔一会儿再试几次。
 */
async function cleanupExportDir(dir: string, { framesOnly = false } = {}) {
  // --no-video 的导出只有逐帧 PNG,那就是产物,不删
  const keep = framesOnly ? [...EXPORT_KEEP, "frames"] : EXPORT_KEEP;
  for (let attempt = 0; attempt < 4; attempt++) {
    const report = await pruneExportDir(dir, { keep, log: (m: string) => console.log(m) });
    if (!report.skipped.some((s: { reason: string }) => s.reason !== "link")) return report;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  return null;
}

async function handleExportStart(req: Connect.IncomingMessage, res: ServerResponse, server: ViteDevServer, root: string) {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      let project = body;
      let frames: string | undefined;
      let fps: number | undefined;
      let noVideo: boolean | undefined;
      let workers: number | string | undefined;
      if (body.project) {
        project = body.project;
        frames = body.frames;
        fps = body.fps;
        noVideo = body.noVideo;
        workers = body.workers;
      }

      // C6.6:导出只用素材原尺寸。被片段引用的素材原尺寸在当前素材服务上没到齐就不出片(设计稿第 9 节第 3 条)
      const gate = await exportOriginalsGate(project);
      if (!gate.ok) {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "awaiting-uploader", code: "awaiting-uploader", message: gate.message, missing: gate.missing }));
        return;
      }

      const { id, outDir } = await claimExportDir(outRoot(root));
      const mediaDir = path.resolve(outDir, "media");
      await fs.mkdir(mediaDir, { recursive: true });
      
      // Move staging media
      const stagingDir = path.resolve(outRoot(root), ".export-staging", "media");
      try {
        const files = await fs.readdir(stagingDir);
        for (const file of files) {
          await fs.rename(path.resolve(stagingDir, file), path.resolve(mediaDir, file));
        }
      } catch (e) {
        // staging dir might not exist, ignore
      }
      
      // 素材地址:有哈希按哈希、没哈希才按路径;已标缺失的跳过它所在的片段并告诉用户(规则见 normalizeExportMedia)
      const { skipped } = await normalizeExportMedia(project, root, id);
      const skippedMedia = dropSkippedMediaClips(project, skipped);
      if (skippedMedia.length) console.warn(`[export] 跳过缺失素材所在的片段:${skippedMedia.map((m) => `${m.name || m.id}×${m.clips}`).join("、")}`);
      
      const projectJsonPath = path.resolve(outDir, "project.json");
      await fs.writeFile(projectJsonPath, JSON.stringify(project, null, 2));
      
      lastJobId = id;
      // 回给浏览器的路径:开发期是相对项目根的 out/export-<id>,桌面版(设了 PROMPTCUT_EXPORT_DIR)给绝对路径
      const relOutDir = process.env.PROMPTCUT_EXPORT_DIR ? outDir : `out/export-${id}`;
      // The child does not print its first frame until Chrome has loaded and
      // sampled the project.  Seed the job with the real render total so the
      // dialog never shows the misleading 0/1 while that work is underway.
      const renderFps = Number(fps) > 0 ? Number(fps) : Number(project.fps) || 30;
      const renderTotal = frames && /^\d+\s*-\s*\d+$/.test(frames)
        ? (() => { const [a, b] = frames.split("-").map(Number); return Math.max(1, b - a + 1); })()
        : Math.max(1, Math.floor((Number(project.duration) || 0) * renderFps));
      const job: ExportJob = { id, status: "running", done: 0, total: renderTotal, stage: "render", outDir: relOutDir, absOutDir: outDir };
      jobs.set(id, job);
      
      // Spawn child process
      let port = server.config.server.port;
      if (!port) {
        const address = server.httpServer?.address() as AddressInfo;
        port = address?.port || 5190;
      }
      
      const args = [
        "scripts/export-frames.mjs",
        "--url",
        `http://127.0.0.1:${port}/?export=1&timeline=/@export/${id}/project.json`,
        "--out",
        relOutDir,
        // 默认按机器资源并行；每个分片仍从第 0 帧推起，且只在安全卡片边界切开。
        "--workers",
        workers !== undefined && workers !== null && workers !== ""
          ? String(workers)
          : (process.env.PROMPTCUT_EXPORT_WORKERS || "auto"),
      ];
      if (frames) {
        args.push("--frames", frames);
      }
      if (fps) {
        args.push("--fps", String(fps));
      }
      if (noVideo) {
        args.push("--no-video");
      }
      
      const child = spawn(process.execPath, args, { cwd: root, windowsHide: true });
      job.child = child;
      /*
       * 记账(render-pool-state.mjs):导出也起 Chrome、也吃核,渲染池算槽位时要把它算进去,
       * 而且导出期间暂停空闲预渲染(docs/archive/topics/decoupling-plan.md 3.3 节「导出优先级最低」)。
       * 结束只记一次:子进程起不来时可能只有 error 没有 close,两条路都要收。
       */
      exportBegin();
      let accounted = true;
      const settle = () => {
        if (!accounted) return;
        accounted = false;
        exportEnd();
      };
      child.on("error", settle);
      child.on("close", settle);

      let stderrLog: string[] = [];
      child.stdout.on("data", (data) => {
        const str = data.toString();
        // 两步各自报进度:「Exported frame 0 (1/90)」是 Chrome 渲卡片,「Composited frame 45/90」是 ffmpeg 合素材。
        // 一块输出里可能有好几行,取最后一行
        const composed = [...str.matchAll(/Composited frame (\d+)\/(\d+)/g)].pop();
        const rendered = [...str.matchAll(/Exported frame \d+ \((\d+)\/(\d+)\)/g)].pop();
        const m = composed || rendered;
        if (m) {
          job.stage = composed ? "compose" : "render";
          job.done = parseInt(m[1], 10);
          job.total = parseInt(m[2], 10);
        }
      });
      
      child.stderr.on("data", (data) => {
        stderrLog.push(data.toString());
        if (stderrLog.length > 10) stderrLog.shift();
      });
      
      child.on("close", async (code) => {
        job.child = undefined;
        // 先收拾目录再报结束:界面看到「完成」时目录已经是最终的样子(成片与透明层不动,取件不受影响)
        await cleanupExportDir(outDir, { framesOnly: !!noVideo }).catch(() => {});
        if (job.cancelled) {
          job.status = "cancelled";
          job.message = "已取消";
        } else if (code === 0) {
          job.status = "done";
        } else {
          job.status = "error";
          const tail = stderrLog.join("").trim();
          // 0xC0000142 = STATUS_DLL_INIT_FAILED,子进程连 DLL 都没加载起来,
          // 所以 stderr 是空的。裸报一个十进制数字没人看得懂,这里给一句人话。
          job.message = tail
            || (code === 3221225794
              ? "渲染进程启动失败(0xC0000142)。通常是同时开了太多浏览器实例,关掉一些再试;若持续出现请重启软件。"
              : `渲染进程异常退出(代码 ${code})`);
        }
      });
      
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id, outDir: relOutDir, skippedMedia }));
    } catch (err: unknown) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
}

function handleProgress(req: Connect.IncomingMessage, res: ServerResponse) {
  // /api/export/<id>
  const parts = req.url?.split("/") || [];
  const id = parts.pop()?.split("?")[0];
  if (!id) {
    res.statusCode = 400;
    res.end("Missing ID");
    return;
  }
  
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    res.end("Job not found");
    return;
  }
  
  const isSSE = req.headers.accept === "text/event-stream" || req.url?.includes("sse=1");
  if (isSSE) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    
    const sendEvent = () => {
      res.write(`data: ${JSON.stringify({ done: job.done, total: job.total, stage: job.stage, status: job.status, message: job.message })}\n\n`);
    };
    
    sendEvent();
    
    if (job.status !== "running") {
      res.end();
      return;
    }
    
    const interval = setInterval(() => {
      sendEvent();
      if (job.status !== "running") {
        clearInterval(interval);
        res.end();
      }
    }, 500);
    
    req.on("close", () => {
      clearInterval(interval);
    });
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ done: job.done, total: job.total, stage: job.stage, status: job.status, message: job.message }));
  }
}

async function serveFile(filePath: string, req: Connect.IncomingMessage, res: ServerResponse) {
  try {
    const stat = await fs.stat(filePath);
    const range = req.headers.range;
    
    let contentType = "application/octet-stream";
    if (filePath.endsWith(".json")) contentType = "application/json";
    else if (filePath.endsWith(".mp4")) contentType = "video/mp4";
    else if (filePath.endsWith(".webm")) contentType = "video/webm";
    else if (filePath.endsWith(".mov")) contentType = "video/quicktime";
    else if (filePath.endsWith(".png")) contentType = "image/png";
    else if (filePath.endsWith(".wav")) contentType = "audio/wav";
    
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;
      
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": contentType,
      });
      
      const stream = (await import("fs")).createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      const stream = (await import("fs")).createReadStream(filePath);
      stream.pipe(res);
    }
  } catch (err) {
    res.statusCode = 404;
    res.end("Not found");
  }
}

/** 把某个产物流给浏览器。只认白名单里的文件名,不接受路径。 */
async function handleDeliverable(res: ServerResponse, id: string, name: string) {
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    return res.end("Unknown export job");
  }
  if (!(DELIVERABLES as readonly string[]).includes(name)) {
    res.statusCode = 400;
    return res.end("Not a deliverable");
  }
  const file = path.resolve(job.absOutDir, name);
  // 名字来自白名单,这里再确认一次没跑出产物目录
  if (!file.startsWith(path.resolve(job.absOutDir) + path.sep)) {
    res.statusCode = 400;
    return res.end("Path escaped output dir");
  }
  try {
    const stat = await fs.stat(file);
    res.setHeader("Content-Type", name.endsWith(".mov") ? "video/quicktime" : "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store");
    // Stream the finished movie to the browser.  A multi-gigabyte Buffer here
    // would duplicate the export in the Vite process just as the child is
    // closing Chrome/ffmpeg.
    createReadStream(file).on("error", () => { if (!res.headersSent) res.statusCode = 404; res.destroy(); }).pipe(res);
  } catch {
    res.statusCode = 404;
    res.end("产物还没生成");
  }
}

/** 在文件管理器里定位产物目录。Windows 用 explorer,其余平台各按各的。 */
function handleReveal(res: ServerResponse, id: string) {
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    return res.end("Unknown export job");
  }
  const opener = process.platform === "win32" ? "explorer.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  // explorer 打开目录时返回码是 1,这不是失败,所以不看退出码
  spawn(opener, [job.absOutDir], { detached: true, stdio: "ignore" }).unref();
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, dir: job.outDir }));
}

/**
 * 取消导出。渲染进程自己还会拉起 Chrome 和 ffmpeg,只杀它会留下孤儿,
 * 所以 Windows 上走 taskkill /T 把整棵进程树带走。
 */
function handleCancel(res: ServerResponse, id: string) {
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    return res.end("Unknown export job");
  }
  if (job.status === "running" && job.child) {
    job.cancelled = true;
    const pid = job.child.pid;
    if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      job.child.kill("SIGTERM");
    }
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}

export function exportPlugin(): Plugin {
  return {
    name: "vite-plugin-export",
    configureServer(server) {
      const root = server.config.root;
      // 启动清理:死进程留下的视觉工具临时导出 `export-vision-<pid>-*`(只认这一种形态)
      void sweepExportRoot(outRoot(root), { log: (m: string) => console.log(m) }).catch(() => {});
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        
        // POST /api/export/media/<文件名>
        if (req.method === "POST" && req.url.startsWith("/api/export/media/")) {
          return handleMediaUpload(req, res, root);
        }
        
        // POST /api/export
        if (req.method === "POST" && req.url === "/api/export") {
          return handleExportStart(req, res, server, root);
        }
        
        // GET /api/export/<id>/file/<名字> —— 把产物交给浏览器,好让它写到用户
        // 用「另存为」挑的位置去(和保存项目走同一套 File System Access API)
        const fileMatch = req.method === "GET" && req.url.match(/^\/api\/export\/([^/]+)\/file\/([^/?]+)$/);
        if (fileMatch) {
          return handleDeliverable(res, fileMatch[1], decodeURIComponent(fileMatch[2]));
        }

        // POST /api/export/audio-mix/<id> —— 混音页(src/AudioMixView.tsx)把渲好的 mix.wav 原样交回来,
        // 写到 export-<id>/audio/mix.wav,server/bakery 再用 ffmpeg 合进 preview.mp4。
        // 路径是「前缀 + id」的形状,因为 api-guard 只按前缀放行原始体(RAW_BODY_PREFIXES)
        const mixMatch = req.method === "POST" && req.url.match(/^\/api\/export\/audio-mix\/([^/?]+)$/);
        if (mixMatch) {
          const id = sanitizeFilename(mixMatch[1]);
          const dir = path.resolve(outRoot(root), `export-${id}`, "audio");
          try {
            await fs.mkdir(dir, { recursive: true });
            // 直接落盘、不在内存里拼:float32 立体声 48k 一小时 1.4 GB。上限 3 GB(约两小时)
            const MAX = 3 * 1024 * 1024 * 1024;
            let bytes = 0;
            let over = false;
            const out = (await import("fs")).createWriteStream(path.resolve(dir, "mix.wav"));
            await new Promise<void>((resolve, reject) => {
              req.on("data", (c: Buffer) => {
                if (over) return;
                bytes += c.length;
                if (bytes > MAX) { over = true; out.destroy(); req.destroy(); return; }
                out.write(c);
              });
              req.on("end", () => out.end(() => resolve()));
              req.on("error", reject);
              out.on("error", reject);
            });
            if (over) {
              res.statusCode = 413;
              return res.end(JSON.stringify({ ok: false, error: "混音超过 3 GB,没有保存" }));
            }
            const buf = { length: bytes };
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify({ ok: true, bytes: buf.length }));
          } catch (e) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
          }
        }

        // POST /api/export/<id>/reveal —— 在文件管理器里打开产物目录
        const revealMatch = req.method === "POST" && req.url.match(/^\/api\/export\/([^/]+)\/reveal$/);
        if (revealMatch) {
          return handleReveal(res, revealMatch[1]);
        }

        // DELETE /api/export/<id> —— 取消
        const cancelMatch = req.method === "DELETE" && req.url.match(/^\/api\/export\/([^/?]+)$/);
        if (cancelMatch) {
          return handleCancel(res, cancelMatch[1]);
        }

        // GET /api/export/<id>
        if (req.method === "GET" && req.url.startsWith("/api/export/")) {
          return handleProgress(req, res);
        }
        
        // GET /@export/<id>/project.json or /@export/project.json
        if (req.method === "GET" && req.url.startsWith("/@export/")) {
          const url = req.url.split("?")[0];
          let match = url.match(/^\/@export\/([^/]+)\/project\.json$/);
          if (match) {
            const id = match[1];
            return serveFile(path.resolve(outRoot(root), `export-${id}`, "project.json"), req, res);
          }
          if (url === "/@export/project.json") {
            if (!lastJobId) return res.end("{}");
            return serveFile(path.resolve(outRoot(root), `export-${lastJobId}`, "project.json"), req, res);
          }
          
          match = url.match(/^\/@export\/([^/]+)\/media\/(.+)$/);
          if (match) {
            const id = match[1];
            const name = sanitizeFilename(decodeURIComponent(match[2]));
            return serveFile(path.resolve(outRoot(root), `export-${id}`, "media", name), req, res);
          }
          // GET /@export/<id>/audio/<文件> —— 混音页读裁好的 wav 和 plan.json
          match = url.match(/^\/@export\/([^/]+)\/audio\/([^/]+)$/);
          if (match) {
            const id = sanitizeFilename(match[1]);
            const name = sanitizeFilename(decodeURIComponent(match[2]));
            return serveFile(path.resolve(outRoot(root), `export-${id}`, "audio", name), req, res);
          }
          match = url.match(/^\/@export\/media\/(.+)$/);
          if (match) {
            const name = sanitizeFilename(decodeURIComponent(match[1]));
            if (lastJobId) {
              const checkPath = path.resolve(outRoot(root), `export-${lastJobId}`, "media", name);
              try {
                await fs.access(checkPath);
                return serveFile(checkPath, req, res);
              } catch (e) {
                // fall back to staging
              }
            }
            return serveFile(path.resolve(outRoot(root), ".export-staging", "media", name), req, res);
          }
        }
        
        next();
      });
    }
  };
}
