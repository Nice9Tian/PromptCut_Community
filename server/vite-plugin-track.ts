/**
 * 运动追踪的服务端接口。
 *
 * 端点形状照 vite-plugin-shots 抄，Python 侧的进程/环境/SSE 工具直接从
 * vite-plugin-stt import——那套 `._pth` 和 pylibs 的处理很微妙，不要抄第二份。
 *
 * 追踪分两档：
 *   - 拓展装好了 → BootsTAPIR，任意点追踪，有遮挡判断
 *   - 没装      → 前端的 JS 模板匹配兜底（不在这里跑）
 * `status` 里的 engine 字段就是给前端和 AI 看的档位标记。
 */
import type { Plugin, ServerResponse } from "vite";
import type { Connect } from "vite";
import { randomUUID } from "node:crypto";

import {
  findPython,
  buildEnv,
  spawnPython,
  pipeToSse,
  readBody,
} from "./vite-plugin-stt";
import { createAssetSourceResolver } from "./audio-source.mjs";
import { assetServiceOrigin } from "./asset-client";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { pythonInput, resolveMediaSource } from "./perception-source.mjs";

/** 素材记录 → 素材服务上的 HTTP 地址。写法与 vite-plugin-shots.ts 相同,见 server/perception-source.mjs */
const resolveSource = createAssetSourceResolver({ origin: assetServiceOrigin, toUrl: (m, origin) => mediaSourceOf(m, origin) });

type TrackEngine = "bootstapir" | "template";

interface TrackPoint {
  query: [number, number, number];
  xy: [number, number][];
  visible: boolean[];
  /** 这个点没能追（纹理不够、贴边），兜底档才会给。给了就别用这条轨迹 */
  note?: string;
}

interface TrackJob {
  id: string;
  mediaId?: string;
  status: "running" | "done" | "error";
  /**
   * 哪一档在跑。**以 result 事件里的 engine 为准**，不要在起作业时就写死——
   * 选档是 Python 侧按 status 决定的（装了拓展走神经网络，没装走模板匹配），
   * Node 这边猜一个只会在没装拓展时把 template 报成 bootstapir。
   */
  engine?: TrackEngine;
  percent: number;
  message?: string;
  width?: number;
  height?: number;
  frames?: number;
  points?: TrackPoint[];
}

const jobs = new Map<string, TrackJob>();

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

/**
 * 跑一次追踪。stdout 一行一个 JSON，按 event 分派。
 * video 是素材服务上的 HTTP 地址;Python 包认地址就递地址,老包先流到临时文件(见 server/perception-source.mjs),跑完删。
 */
function runTracking(
  root: string,
  job: TrackJob,
  video: string,
  points: number[][],
  ref: Record<string, string>,
): Promise<void> {
  return new Promise(async (resolveRun) => {
    const python = findPython(root);
    if (!python) {
      job.status = "error";
      job.message = "没有可用的 Python，无法运行追踪拓展。";
      return resolveRun();
    }
    const env = await buildEnv(root, python);
    let input: { input: string; cleanup: () => void };
    try {
      input = await pythonInput({ src: video, ref, python, env, pkg: "promptcut_track", spawnPython });
    } catch (e) {
      job.status = "error";
      job.message = (e as Error).message;
      return resolveRun();
    }
    const resolve = () => { input.cleanup(); resolveRun(); };
    // 不能加 -I：隔离模式会忽略 PYTHONPATH，promptcut_track 就 import 不到了。
    // 只有 install 用 -I（那一步不需要我们的包在 path 上）。
    let child: ReturnType<typeof spawnPython>;
    try {
      child = spawnPython(
        python,
        ["-m", "promptcut_track", "track", "--video", input.input,
         "--points", JSON.stringify(points)],
        env,
      );
    } catch (e) {
      // 起不来(例如 .cmd 解释器拒绝带元字符的参数)也要收尾:临时文件要删,作业要落到 error
      job.status = "error";
      job.message = (e as Error).message;
      return resolve();
    }

    // stderr 要留着：Python 侧那些「给人看的话」和真正的崩溃栈都在这里。
    // 只读 stdout 的话，进程一崩就只剩一个退出码，没法查。
    let errTail = "";
    child.stderr?.on("data", (d: Buffer) => {
      errTail = (errTail + d.toString("utf-8")).slice(-2000);
    });

    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      // 按行切；最后一段可能不完整，留着等下一批
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"event"')) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.event === "progress" && typeof ev.percent === "number") {
          job.percent = ev.percent as number;
        } else if (ev.event === "result") {
          if (ev.engine === "bootstapir" || ev.engine === "template") {
            job.engine = ev.engine;
          }
          job.width = ev.width as number;
          job.height = ev.height as number;
          job.frames = ev.frames as number;
          job.points = ev.points as TrackPoint[];
          job.percent = 100;
        } else if (ev.event === "error") {
          job.status = "error";
          job.message = String(ev.message ?? "追踪失败");
        }
      }
    });

    child.on("error", (e) => {
      job.status = "error";
      job.message = e.message;
      resolve();
    });
    child.on("close", (code) => {
      if (job.status !== "error") {
        // 退出码 0 但没拿到结果，同样算失败——半成品比报错更难查
        job.status = code === 0 && job.points ? "done" : "error";
        if (job.status === "error" && !job.message) {
          job.message = errTail.trim()
            ? `追踪进程异常退出（代码 ${code}）：${errTail.trim().slice(-500)}`
            : `追踪进程异常退出（代码 ${code}）`;
        }
      }
      resolve();
    });
  });
}

export function trackPlugin(): Plugin {
  return {
    name: "vite-plugin-track",
    configureServer(server) {
      const root = server.config.root;

      server.middlewares.use(async (req: Connect.IncomingMessage, res, next) => {
        if (!req.url?.startsWith("/api/track")) return next();
        const url = req.url.split("?")[0];

        // GET /api/track/status —— 拓展装没装
        if (req.method === "GET" && url === "/api/track/status") {
          const python = findPython(root);
          if (!python) {
            // engine 给 null 而不是 "template"：兜底档也是 Python 跑的
            // （numpy 做模板匹配），没有解释器时两档都用不了。报成 template
            // 会让调用方以为还能追，结果每次调用都失败。
            return sendJson(res, 200, {
              ok: true, ready: false, engine: null,
              reason: "没有可用的 Python",
            });
          }
          const env = await buildEnv(root, python);
          const child = spawnPython(python, ["-m", "promptcut_track", "status"], env);
          let out = "";
          child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
          child.on("error", () =>
            sendJson(res, 200, { ok: true, ready: false, engine: null,
                                 reason: "解释器启动失败" }));
          child.on("close", () => {
            try {
              const line = out.split(/\r?\n/).find((l) => l.includes('"event"'));
              const info = line ? JSON.parse(line) : {};
              // engine 直接采信 Python 侧的判断：那边同时看了 torch、权重
              // 和 numpy，比在这里按 ready 反推准。
              sendJson(res, 200, {
                ok: true,
                ready: !!info.ready,
                engine: info.engine ?? null,
                detail: info,
              });
            } catch {
              sendJson(res, 200, { ok: true, ready: false, engine: null,
                                   reason: "解释器没有返回可解析的状态" });
            }
          });
          return;
        }

        // POST /api/track/install —— 装 torch，SSE 流式回日志（190 MB，要跑一会儿）
        if (req.method === "POST" && url === "/api/track/install") {
          const python = findPython(root);
          if (!python) return sendJson(res, 400, { ok: false, error: "没有可用的 Python" });
          const env = await buildEnv(root, python);
          return pipeToSse(spawnPython(python, ["-m", "promptcut_track", "install"], env), res);
        }

        // POST /api/track/track { mediaId, media: { id, name, kind, url, hash }, points } —— 起一个后台作业。
        // 素材经素材服务取(见 server/perception-source.mjs):没有这份素材回 404,素材服务不可达回 502;请求体里的 path 不看。
        if (req.method === "POST" && url === "/api/track/track") {
          try {
            const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
            const points = body.points;
            if (!Array.isArray(points) || points.length === 0
                || !points.every((p: unknown) => Array.isArray(p) && p.length === 3
                    && p.every((v) => typeof v === "number" && Number.isFinite(v)))) {
              return sendJson(res, 400, {
                ok: false,
                error: "points 要写成 [[帧号, x, y], ...]，且至少一个点",
              });
            }

            const source = await resolveMediaSource(body, resolveSource);
            if (!source.ok) return sendJson(res, source.status, { ok: false, error: source.error, ...(source.kind ? { kind: source.kind } : null) });
            const video = source.src;

            const job: TrackJob = {
              id: randomUUID().slice(0, 8),
              mediaId: body.mediaId ?? source.media.id,
              status: "running",
              percent: 0,
            };
            jobs.set(job.id, job);
            // 不 await：立刻把 jobId 回给前端，进度靠轮询
            void runTracking(root, job, video, points, source.media).catch((e) => {
              job.status = "error";
              job.message = e instanceof Error ? e.message : String(e);
            });
            return sendJson(res, 200, { ok: true, jobId: job.id });
          } catch (e) {
            return sendJson(res, 400, { ok: false, error: (e as Error).message });
          }
        }

        // GET /api/track/job/<id>
        const jobMatch = req.method === "GET" && url.match(/^\/api\/track\/job\/([\w-]+)$/);
        if (jobMatch) {
          const job = jobs.get(jobMatch[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: "作业不存在，可能服务已重启" });
          return sendJson(res, 200, { ok: true, job });
        }

        return next();
      });
    },
  };
}
