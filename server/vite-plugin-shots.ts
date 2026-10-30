/**
 * 镜头切换识别。
 *
 * 两条路,能力不同,界面要说清楚用户拿到的是哪一条：
 *   - 装了拓展库包 → TransNetV2(ONNX)。硬切和溶解都认，溶解还能给出跨度。
 *   - 没装 → 回退到 ffmpeg 的 scdet 滤镜。只认硬切，溶解一个都看不见。
 *
 * 检测比较慢(5 分钟素材约 36 秒)，所以一律走后台作业 + 轮询，和听写同一套路。
 */
import type { Plugin, Connect, ViteDevServer } from "vite";
import type { ServerResponse } from "http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { buildEnv, dataDir, findPython, pipeToSse, readBody, spawnPython } from "./vite-plugin-stt";
import { createAssetSourceResolver } from "./audio-source.mjs";
import { assetServiceOrigin } from "./asset-client";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { pythonInput, resolveMediaSource } from "./perception-source.mjs";

/**
 * 素材记录 → 素材服务上的 HTTP 地址(ffprobe / ffmpeg / Python 的输入)。和看画面的素材层、音频测量同一条
 * (`mediaSourceOf`,本地素材服务的 `/@media/<hash>` 在共享项目里会向远程素材服务拉)。请求体里的 `path` 不看,
 * 见 `server/perception-source.mjs`。
 */
const resolveSource = createAssetSourceResolver({ origin: assetServiceOrigin, toUrl: (m, origin) => mediaSourceOf(m, origin) });

export type TransitionKind = "cut" | "dissolve";

export interface Transition {
  kind: TransitionKind;
  /** 转场的真实起止(秒)。硬切上两者几乎相等；溶解是整段渐变 */
  start: number;
  end: number;
  /** 置信度最高的那一帧,画标记时对准它 */
  time: number;
  confidence: number;
  /** 缩略图文件名,画到时间轴上用。溶解有两张(渐变前后各一),叠着画 */
  thumbs?: string[];
}

export interface ShotsJob {
  id: string;
  mediaId?: string;
  status: "running" | "done" | "error";
  engine: "transnetv2" | "scdet";
  /** 0~100 */
  percent: number;
  message?: string;
  duration?: number;
  fps?: number;
  transitions?: Transition[];
  shots?: { start: number; end: number; inTransition: TransitionKind | null; outTransition: TransitionKind | null }[];
}

import { shotsDir, shotsThumbMiddleware } from './asset-store/shots-thumb.mjs';

const jobs = new Map<string, ShotsJob>();

export { shotsDir, shotsThumbMiddleware } from './asset-store/shots-thumb.mjs';

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

/** 从 ffprobe 拿帧率和时长。检测要用真实 fps 把帧号换算成秒。 */
async function probeVideo(env: NodeJS.ProcessEnv, video: string): Promise<{ fps: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=r_frame_rate:format=duration",
      "-of", "json", video,
    ], { env, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe 读不出这个文件的视频信息"));
      try {
        const j = JSON.parse(out);
        const raw = j.streams?.[0]?.r_frame_rate ?? "0/1";
        const [n, d] = String(raw).split("/").map(Number);
        const fps = d ? n / d : Number(raw);
        const duration = Number(j.format?.duration ?? 0);
        if (!fps || !Number.isFinite(fps)) return reject(new Error("读不出帧率"));
        resolve({ fps, duration });
      } catch (e) {
        reject(new Error(`ffprobe 输出解析失败：${(e as Error).message}`));
      }
    });
  });
}

/**
 * 没装拓展时的兜底：ffmpeg scdet。
 *
 * 实测只认硬切——1 秒交叉溶解在任何阈值下都检不出来，把阈值压到能看见渐变时，
 * 硬切开始虚报、单镜头内高速运动误报 12 次。所以这里就用默认阈值 10 老老实实
 * 只报硬切，别假装能干 TransNetV2 的活。
 */
function detectWithScdet(env: NodeJS.ProcessEnv, video: string, onLine: (t: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-i", video, "-vf", "scdet=threshold=10", "-f", "null", "-"],
      { env, windowsHide: true });
    let buf = "";
    child.stderr.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const m = line.match(/lavfi\.scd\.time:\s*([0-9.]+)/);
        if (m) onLine(Number(m[1]));
      }
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
  });
}

/**
 * 给每个转场抓缩略图。
 *
 * 硬切抓一张（切换之后的画面）；溶解抓两张（渐变开始前 + 结束后），时间轴上
 * 叠着画就能一眼看出是「两张画面在交融」。
 */
async function grabThumbs(env: NodeJS.ProcessEnv, video: string, outDir: string,
                          jobId: string, transitions: Transition[]): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    // 硬切取转场之后那一帧；溶解取渐变两端，正好是参与叠画的两个镜头
    const stamps = t.kind === "dissolve"
      ? [Math.max(0, t.start - 0.04), t.end + 0.04]
      : [t.end + 0.04];
    const names: string[] = [];
    for (let k = 0; k < stamps.length; k++) {
      const name = `${jobId}-${i}-${k}.jpg`;
      const dest = path.join(outDir, name);
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn("ffmpeg", [
          "-hide_banner", "-loglevel", "error",
          "-ss", String(Math.max(0, stamps[k])), "-i", video,
          "-frames:v", "1", "-vf", "scale=160:-2", "-y", dest,
        ], { env, windowsHide: true });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
      });
      if (ok) names.push(name);
    }
    if (names.length) t.thumbs = names;
  }
}

/**
 * 跑一次检测。优先 TransNetV2，不可用就退回 scdet。
 * video 是素材服务上的 HTTP 地址:ffprobe、scdet、抓缩略图直接吃地址;Python 那一半按包认不认地址决定递地址还是临时文件。
 */
async function runDetection(root: string, job: ShotsJob, video: string, ref: Record<string, string>): Promise<void> {
  const python = findPython(root);
  const env = python ? await buildEnv(root, python) : { ...process.env };

  let meta: { fps: number; duration: number };
  try {
    meta = await probeVideo(env, video);
  } catch (e) {
    job.status = "error";
    job.message = (e as Error).message;
    return;
  }
  job.fps = meta.fps;
  job.duration = meta.duration;

  const useTransNet = python != null && await new Promise<boolean>((resolve) => {
    const child = spawnPython(python!, ["-m", "promptcut_shots", "status"], env);
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => resolve(false));
    child.on("close", () => {
      try {
        const line = out.split(/\r?\n/).find((l) => l.includes('"event"'));
        resolve(Boolean(line && JSON.parse(line).ready));
      } catch { resolve(false); }
    });
  });

  job.engine = useTransNet ? "transnetv2" : "scdet";

  if (useTransNet) {
    let input: { input: string; cleanup: () => void };
    try {
      input = await pythonInput({ src: video, ref, python: python!, env, pkg: "promptcut_shots", spawnPython });
    } catch (e) {
      job.status = "error";
      job.message = (e as Error).message;
      return;
    }
    await new Promise<void>((resolve) => {
      const child = spawnPython(python!, [
        "-m", "promptcut_shots", "detect", input.input, "--fps", String(meta.fps),
      ], env);
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.event === "progress" && typeof ev.percent === "number") job.percent = ev.percent;
            else if (ev.event === "result") {
              job.transitions = ev.transitions;
              job.shots = ev.shots;
              job.duration = ev.duration;
            } else if (ev.event === "error") {
              job.status = "error";
              job.message = ev.message;
            }
          } catch { /* 不是 JSON 的行忽略 */ }
        }
      });
      // stderr 也要留着。Python 侧的 emit_error 走 stdout，但解释器自己崩了
      // (import 失败、段错误、被杀) 只会往 stderr 吐 traceback；只读 stdout 的话
      // 用户拿到的就是一个空 message，什么都查不出来。
      const stderrTail: string[] = [];
      child.stderr?.on("data", (d) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
        }
      });
      child.on("error", (e) => { job.status = "error"; job.message = e.message; resolve(); });
      child.on("close", (code) => {
        // 没拿到结果、也没收到 error 事件，就靠退出码和 stderr 说明发生了什么
        if (code !== 0 && job.status !== "error" && !job.transitions) {
          job.status = "error";
          job.message = stderrTail.join("\n").trim() || `镜头识别进程异常退出（代码 ${code}）`;
        }
        resolve();
      });
    }).finally(() => input.cleanup());
  } else {
    const times: number[] = [];
    try {
      await detectWithScdet(env, video, (t) => {
        times.push(t);
        job.percent = Math.min(95, job.percent + 3);
      });
    } catch (e) {
      job.status = "error";
      job.message = (e as Error).message;
      return;
    }
    // scdet 只给一个时间点,没有跨度,所以起止相同、一律算硬切
    job.transitions = times.map((t) => ({ kind: "cut" as const, start: t, end: t, time: t, confidence: 1 }));
    let cursor = 0;
    job.shots = [];
    for (const t of times) {
      if (t > cursor) job.shots.push({ start: cursor, end: t, inTransition: job.shots.length ? "cut" : null, outTransition: "cut" });
      cursor = t;
    }
    if (meta.duration > cursor) {
      job.shots.push({ start: cursor, end: meta.duration, inTransition: times.length ? "cut" : null, outTransition: null });
    }
  }

  if (job.status === "error") return;

  if (job.transitions?.length) {
    try {
      await grabThumbs(env, video, shotsDir(root), job.id, job.transitions);
    } catch { /* 缩略图抓不到不影响检测结果 */ }
  }
  job.percent = 100;
  job.status = "done";
}

export function shotsPlugin(options: { projectStores?: any; projectAccess?: any } = {}): Plugin {
  return {
    name: "vite-plugin-shots",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      server.middlewares.use(shotsThumbMiddleware(root, options));

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/shots")) return next();
        const url = req.url.split("?")[0];

        // GET /api/shots/status —— 拓展装没装
        if (req.method === "GET" && url === "/api/shots/status") {
          const python = findPython(root);
          if (!python) return sendJson(res, 200, { ok: true, ready: false, engine: "scdet", reason: "没有可用的 Python" });
          const env = await buildEnv(root, python);
          const child = spawnPython(python, ["-m", "promptcut_shots", "status"], env);
          let out = "";
          child.stdout.on("data", (d) => { out += d.toString(); });
          child.on("error", () => sendJson(res, 200, { ok: true, ready: false, engine: "scdet" }));
          child.on("close", () => {
            try {
              const line = out.split(/\r?\n/).find((l) => l.includes('"event"'));
              const info = line ? JSON.parse(line) : {};
              sendJson(res, 200, { ok: true, ready: !!info.ready, engine: info.ready ? "transnetv2" : "scdet", detail: info });
            } catch {
              sendJson(res, 200, { ok: true, ready: false, engine: "scdet" });
            }
          });
          return;
        }

        // POST /api/shots/install —— 装 onnxruntime,SSE 流式回日志
        if (req.method === "POST" && url === "/api/shots/install") {
          const python = findPython(root);
          if (!python) return sendJson(res, 400, { ok: false, error: "没有可用的 Python" });
          const env = await buildEnv(root, python);
          return pipeToSse(spawnPython(python, ["-m", "promptcut_shots", "install"], env), res);
        }

        // POST /api/shots/detect { mediaId, media: { id, name, kind, url, hash } } —— 起一个后台作业。
        // 素材经素材服务取(见 server/perception-source.mjs):没有这份素材回 404,素材服务不可达回 502;请求体里的 path 不看。
        if (req.method === "POST" && url === "/api/shots/detect") {
          try {
            const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
            const source = await resolveMediaSource(body, resolveSource);
            if (!source.ok) return sendJson(res, source.status, { ok: false, error: source.error, ...(source.kind ? { kind: source.kind } : null) });
            const video = source.src;
            const job: ShotsJob = {
              id: randomUUID().slice(0, 8),
              mediaId: body.mediaId ?? source.media.id,
              status: "running",
              engine: "scdet",
              percent: 0,
            };
            jobs.set(job.id, job);
            // 不 await：立刻把 jobId 回给前端，进度靠轮询
            void runDetection(root, job, video, source.media).catch((e) => {
              job.status = "error";
              job.message = e instanceof Error ? e.message : String(e);
            });
            return sendJson(res, 200, { ok: true, jobId: job.id });
          } catch (e) {
            return sendJson(res, 400, { ok: false, error: (e as Error).message });
          }
        }

        // GET /api/shots/job/<id>
        const jobMatch = req.method === "GET" && url.match(/^\/api\/shots\/job\/([\w-]+)$/);
        if (jobMatch) {
          const job = jobs.get(jobMatch[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: "作业不存在,可能服务已重启" });
          return sendJson(res, 200, { ok: true, job });
        }

        // GET /api/shots/thumb/<文件名> —— 时间轴上的缩略图
        const thumbMatch = !options.projectStores && req.method === "GET" && url.match(/^\/api\/shots\/thumb\/([\w.-]+)$/);
        if (thumbMatch) {
          const file = path.join(shotsDir(root), thumbMatch[1]);
          // 文件名已经被正则限死,这里再确认一次没跑出目录
          if (!file.startsWith(shotsDir(root) + path.sep)) return sendJson(res, 400, { ok: false });
          try {
            const data = await fs.readFile(file);
            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("Cache-Control", "max-age=3600");
            return res.end(data);
          } catch {
            return sendJson(res, 404, { ok: false, error: "缩略图不存在" });
          }
        }

        return next();
      });
    },
  };
}
