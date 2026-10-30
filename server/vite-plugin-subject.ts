/**
 * 主体检测：画面里的人在哪、哪一侧是空的。
 *
 * 用来回答「别让卡片遮住人物的脸」这类要求 —— 在此之前这件事只能靠 see_frames
 * 让模型看图猜，猜错了还看不出来。
 *
 * 两档，能力差得很远，界面和工具描述都要说清用户拿到的是哪一档：
 *   - light：YuNet(人脸) + RT-DETR-R18(人体)，跑 onnxruntime。只认 person / face。
 *   - full：再加 Grounding DINO tiny，能按任意文字提示找目标（"猫"、"手机"、"红色的车"）。
 * 哪一档由 Python 侧看依赖和权重决定，Node 不猜。两档都没有时 engine 为 null，
 * **没有兜底档** —— 这一点和运动追踪不同，调用方要据此退回 see_frames 看图。
 *
 * 抽帧检测比镜头识别快得多（每个采样一次 ffmpeg seek + 一次前向），但一段素材
 * 动辄二三十个采样，仍然会超过 MCP 桥的调用超时，所以照样走后台作业 + 轮询。
 */
import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { buildEnv, findPython, pipeToSse, readBody, spawnPython } from "./vite-plugin-stt";
import { createAssetSourceResolver } from "./audio-source.mjs";
import { assetServiceOrigin } from "./asset-client";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { pythonInput, resolveMediaSource } from "./perception-source.mjs";
// 采样上限和前端共用同一个常数 —— 以前服务端写 200、kernel 那边没有上限,
// 于是「不传 times 就自动算」这条默认路径在长素材上必然撞这个 400。
import { MAX_SUBJECT_TIMES } from "../src/kernel/project";

export type SafeSide = "left" | "right" | "top" | "bottom";

export interface SubjectBox {
  /** light 档只有 person / face；full 档是提示词里的名词 */
  label: string;
  /** 原始视频像素 */
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface SubjectSample {
  /** 素材内的秒数 */
  t: number;
  boxes: SubjectBox[];
  safeSide: SafeSide;
  occupancy: { left: number; right: number; top: number; bottom: number };
  /** 这一帧没抽出来(seek 越界、文件那段坏了)。boxes 空、occupancy 四个 0 都是占位,读取侧要先过滤掉 */
  failed?: boolean;
  /** failed 时 Python 侧给的原因 */
  reason?: string;
}

export interface SubjectJob {
  id: string;
  mediaId?: string;
  status: "running" | "done" | "error";
  /** 跑完前是 undefined：哪一档由 Python 侧选，结果回来才知道 */
  engine?: "light" | "full";
  /** 0~100 */
  percent: number;
  message?: string;
  width?: number;
  height?: number;
  prompt?: string;
  samples?: SubjectSample[];
  /** samples 里 failed 的个数。Python 侧 result 事件给,拿不到就自己数 */
  failedCount?: number;
  /** 本来要跑 full、中途退回 light 时是 "full"。只看 engine 会以为用户本来就只装了 light */
  fellBackFrom?: "full";
  fallbackReason?: string;
  /** 内部用:跑着的子进程 pid 和超时计时器,取消/超时时要拿它杀进程树 */
  pid?: number;
  timer?: NodeJS.Timeout;
  /** 已经被取消或超时杀掉,close 回调不要再改 message */
  killed?: boolean;
}

const jobs = new Map<string, SubjectJob>();

/** 素材记录 → 素材服务上的 HTTP 地址。写法与 vite-plugin-shots.ts 相同,见 server/perception-source.mjs */
const resolveSource = createAssetSourceResolver({ origin: assetServiceOrigin, toUrl: (m, origin) => mediaSourceOf(m, origin) });

/** 作业跑完(done/error)之后在表里留多久 —— 留一会儿是给最后一次轮询,再久就是纯泄漏 */
const JOB_TTL_MS = 10 * 60 * 1000;

/** 一次最多抽多少帧。每帧一次 ffmpeg seek，几百帧会把机器占死。和 kernel 共用一个常数 */
const MAX_TIMES = MAX_SUBJECT_TIMES;

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

/**
 * 跑一次 `promptcut_subject status`，把那一行 JSON 取回来。
 *
 * 契约要求「什么都没装也必须成功吐一行合法 JSON」，所以这里拿不到 JSON 一律当
 * 环境有问题，而不是当「没装拓展」—— 两者要给用户看的话完全不同。
 */
async function readStatus(root: string): Promise<
  { ok: true; info: Record<string, unknown> } | { ok: false; reason: string }
> {
  const python = findPython(root);
  if (!python) return { ok: false, reason: "没有可用的 Python" };
  const env = await buildEnv(root, python);
  return new Promise((resolve) => {
    const child = spawnPython(python, ["-m", "promptcut_subject", "status"], env);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => resolve({ ok: false, reason: `解释器启动失败：${e.message}` }));
    child.on("close", () => {
      const line = out.split(/\r?\n/).find((l) => l.includes('"event"'));
      if (!line) {
        // stderr 的最后一行通常就是 traceback 的那句 —— 只回一句「没返回状态」
        // 等于让用户对着空白排查。
        const tail = err.split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(" ");
        return resolve({ ok: false, reason: tail || "解释器没有返回可解析的状态" });
      }
      try {
        resolve({ ok: true, info: JSON.parse(line) });
      } catch {
        resolve({ ok: false, reason: "状态不是合法 JSON" });
      }
    });
  });
}

/**
 * 跑一次检测。engine 由 Python 侧挑，Node 只负责传参、收事件。
 * video 是素材服务上的 HTTP 地址:新包直接递地址,每个采样时刻起一次 ffmpeg 按 Range 只取那一段;
 * 老包先流到临时文件再递路径(见 server/perception-source.mjs),跑完删。
 */
async function runDetection(
  root: string,
  job: SubjectJob,
  video: string,
  ref: Record<string, string>,
  times: number[],
  prompt: string | undefined,
  engine: string | undefined,
  maxSide: number | undefined,
): Promise<void> {
  const python = findPython(root);
  if (!python) {
    job.status = "error";
    job.message = "没有可用的 Python，装不了也跑不了主体检测";
    return;
  }
  const env = await buildEnv(root, python);
  let input: { input: string; cleanup: () => void };
  try {
    input = await pythonInput({ src: video, ref, python, env, pkg: "promptcut_subject", spawnPython });
  } catch (e) {
    job.status = "error";
    job.message = (e as Error).message;
    return;
  }
  // 取消走 killTree,close 回调照样会到;这里用 finally 保证临时文件无论怎么收尾都删
  try {
    await runDetectionOn(python, env, job, input.input, times, prompt, engine, maxSide);
  } finally {
    input.cleanup();
  }
}

async function runDetectionOn(
  python: string,
  env: NodeJS.ProcessEnv,
  job: SubjectJob,
  video: string,
  times: number[],
  prompt: string | undefined,
  engine: string | undefined,
  maxSide: number | undefined,
): Promise<void> {
  const args = ["-m", "promptcut_subject", "detect", video, "--times", times.join(",")];
  if (prompt) args.push("--prompt", prompt);
  if (engine) args.push("--engine", engine);
  if (maxSide) args.push("--max-side", String(maxSide));

  // 每帧 20 秒余量、下限 120 秒。full 档实测 2.7 s/帧,20 秒是 7 倍余量;
  // 120 秒的地板留给模型加载(full 档冷启动实测约 4 秒,机械盘上更久)。
  const limitMs = Math.max(120_000, times.length * 20_000);

  await new Promise<void>((resolve) => {
    const child = spawnPython(python, args, env);
    job.pid = child.pid;
    // 上限计时器。full 档实测 2.7 s/帧,满配 200 采样就是 9 分钟、峰值约 2 GB,
    // 这期间以前谁都叫不停;ffmpeg 在坏文件上死等的话作业会永远停在 running,
    // 而前端 waitForSubjects 是死循环轮询,会一直转下去。20 秒/帧是实测 full 档
    // (2.7 s/帧)的 7 倍余量,再加 120 秒地板给模型加载(full 档约 4 秒,冷启动更久)。
    job.timer = setTimeout(() => {
      job.killed = true;
      job.status = "error";
      job.message = `主体检测超时(超过 ${Math.round(limitMs / 1000)} 秒),已强制结束。`
        + "可以减少 times 的个数,或先用 subject_status 确认档位(full 档很慢)。";
      killTree(child.pid);
    }, limitMs);
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.event === "progress") {
            const total = Number(ev.total) || times.length;
            const done = Number(ev.done) || 0;
            job.percent = Math.max(0, Math.min(99, Math.round((done / total) * 100)));
          } else if (ev.event === "result") {
            job.engine = ev.engine;
            job.width = ev.width;
            job.height = ev.height;
            job.prompt = ev.prompt ?? prompt ?? "";
            job.samples = ev.samples;
            // failedCount 优先采信 Python 侧的数字;老版本没有这个字段就自己数
            // (抽帧失败的样本带 failed:true)。数不出来时留 undefined,不要报 0 ——
            // 「一个都没失败」和「不知道有没有失败」不是一回事。
            job.failedCount = Number.isFinite(Number(ev.failedCount))
              ? Number(ev.failedCount)
              : Array.isArray(ev.samples)
                ? (ev.samples as SubjectSample[]).filter((s) => s?.failed).length
                : undefined;
            if (ev.fellBackFrom === "full") {
              job.fellBackFrom = "full";
              job.fallbackReason = typeof ev.fallbackReason === "string" ? ev.fallbackReason : undefined;
            }
          } else if (ev.event === "error") {
            job.status = "error";
            job.message = ev.message;
          }
        } catch { /* 不是 JSON 的行忽略 */ }
      }
    });
    // stderr 要留着：Python 侧的 emit_error 走 stdout，但解释器自己崩了
    // （import 失败、模型文件损坏、被杀）只会往 stderr 吐 traceback；只读
    // stdout 的话用户拿到的是一个空 message，什么都查不出来。
    const stderrTail: string[] = [];
    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > 20) stderrTail.shift();
      }
    });
    child.on("error", (e) => { job.status = "error"; job.message = e.message; resolve(); });
    child.on("close", (code) => {
      if (job.timer) { clearTimeout(job.timer); job.timer = undefined; }
      job.pid = undefined;
      // 被超时/取消杀掉时 message 已经写好了,别被「进程异常退出（代码 1）」盖掉 ——
      // 那句话会让人以为是 Python 崩了,而真正的原因是我们自己动的手。
      if (job.killed) { resolve(); return; }
      if (job.status !== "error" && !job.samples) {
        job.status = "error";
        job.message = stderrTail.join("\n").trim()
          || (code === 0 ? "主体检测没有返回结果" : `主体检测进程异常退出（代码 ${code}）`);
      }
      resolve();
    });
  });

  if (job.status === "error") return;
  job.percent = 100;
  job.status = "done";
}

/**
 * 杀掉整棵进程树。
 *
 * Windows 上 child.kill() 只杀得掉 python.exe 自己,它 spawn 出去的 ffmpeg 会变成
 * 孤儿继续占着文件和 CPU;taskkill /F /T 才是连子带孙一起收。stt 那边(killJob)
 * 就是这么做的,这里照抄。
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).unref();
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch { /* 进程可能刚好自己退了,杀不到不算错 */ }
}

/** done/error 之后过 10 分钟从表里删掉。不删的话 jobs 只增不减,一次剪辑攒几十条 */
function retireLater(id: string): void {
  setTimeout(() => {
    const j = jobs.get(id);
    if (j && j.status !== "running") jobs.delete(id);
  }, JOB_TTL_MS).unref?.();
}

export function subjectPlugin(): Plugin {
  return {
    name: "vite-plugin-subject",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/subject")) return next();
        const url = req.url.split("?")[0];

        // GET /api/subject/status —— 能跑到哪一档
        if (req.method === "GET" && url === "/api/subject/status") {
          const r = await readStatus(root);
          if (!r.ok) {
            return sendJson(res, 200, { ok: true, ready: false, engine: null, reason: r.reason });
          }
          const info = r.info as {
            engine?: "light" | "full" | null;
            light?: { ready?: boolean };
            full?: { ready?: boolean };
          };
          // engine 直接采信 Python 侧的判断：那边同时看了依赖能不能 import
          // 和权重在不在，比在这里按某个布尔量反推准。
          const engine = info.engine ?? null;
          return sendJson(res, 200, {
            ok: true,
            ready: engine !== null,
            engine,
            detail: info,
          });
        }

        // POST /api/subject/install —— 在线 pip 装 light 档依赖(onnxruntime)，SSE 回日志。
        // full 档是 torch + transformers + 690 MB 权重，不走在线装，只随拓展库包发。
        if (req.method === "POST" && url === "/api/subject/install") {
          const python = findPython(root);
          if (!python) return sendJson(res, 400, { ok: false, error: "没有可用的 Python" });
          const env = await buildEnv(root, python);
          // 不能带 -I：-I 隐含 -E,会**完全忽略 PYTHONPATH**,而 buildEnv 对非
          // embeddable 解释器(python/.venv、或 PROMPTCUT_PYTHON 指向 conda 环境)
          // 正是靠 PYTHONPATH 送包。实测带 -I 时这一路必报 No module named
          // promptcut_subject,而同环境 status/detect(都没带 -I)一切正常。
          // 内置的 embeddable 解释器本来就不认 PYTHONPATH,走 promptcut_pylibs.pth
          // 钩子,去掉 -I 对它没有任何副作用。
          return pipeToSse(spawnPython(python, ["-m", "promptcut_subject", "install"], env), res);
        }

        // POST /api/subject/detect { mediaId, media: { id, name, kind, url, hash }, times, prompt? } —— 起一个后台作业。
        // 素材经素材服务取(见 server/perception-source.mjs):没有这份素材回 404,素材服务不可达回 502;请求体里的 path 不看。
        if (req.method === "POST" && url === "/api/subject/detect") {
          try {
            const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
            const raw: unknown = body.times;
            if (!Array.isArray(raw) || raw.length === 0) {
              return sendJson(res, 400, { ok: false, error: "times 至少要有一个时刻(秒),写成 [1.2, 5.4]" });
            }
            const times = raw
              .map(Number)
              .filter((t) => Number.isFinite(t) && t >= 0)
              .sort((a, b) => a - b);
            if (times.length === 0) {
              return sendJson(res, 400, { ok: false, error: "times 里没有一个合法的秒数" });
            }
            if (times.length > MAX_TIMES) {
              return sendJson(res, 400, {
                ok: false,
                error: `一次最多 ${MAX_TIMES} 个采样时刻(收到 ${times.length} 个)，请分批`,
              });
            }
            const source = await resolveMediaSource(body, resolveSource);
            if (!source.ok) return sendJson(res, source.status, { ok: false, error: source.error, ...(source.kind ? { kind: source.kind } : null) });
            const video = source.src;
            const job: SubjectJob = {
              id: randomUUID().slice(0, 8),
              mediaId: body.mediaId ?? source.media.id,
              status: "running",
              percent: 0,
              prompt: typeof body.prompt === "string" ? body.prompt : "",
            };
            jobs.set(job.id, job);
            // 不 await：立刻把 jobId 回给前端，进度靠轮询
            void runDetection(
              root, job, video, source.media, times,
              typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : undefined,
              typeof body.engine === "string" ? body.engine : undefined,
              Number.isFinite(Number(body.maxSide)) ? Number(body.maxSide) : undefined,
            ).catch((e) => {
              job.status = "error";
              job.message = e instanceof Error ? e.message : String(e);
            }).finally(() => retireLater(job.id));
            return sendJson(res, 200, { ok: true, jobId: job.id, times: times.length });
          } catch (e) {
            return sendJson(res, 400, { ok: false, error: (e as Error).message });
          }
        }

        // POST /api/subject/job/<id>/cancel —— 叫停一个跑着的作业。
        // full 档满配能跑九分多钟,没有这条路由的话用户和 Agent 都只能干等。
        const cancelMatch = req.method === "POST" && url.match(/^\/api\/subject\/job\/([\w-]+)\/cancel$/);
        if (cancelMatch) {
          const job = jobs.get(cancelMatch[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: "作业不存在,可能服务已重启" });
          if (job.status !== "running") {
            return sendJson(res, 200, { ok: true, cancelled: false, status: job.status, message: "作业已经结束了" });
          }
          job.killed = true;
          job.status = "error";
          job.message = "主体检测已被取消";
          if (job.timer) { clearTimeout(job.timer); job.timer = undefined; }
          killTree(job.pid);
          retireLater(job.id);
          return sendJson(res, 200, { ok: true, cancelled: true });
        }

        // GET /api/subject/job/<id>
        const jobMatch = req.method === "GET" && url.match(/^\/api\/subject\/job\/([\w-]+)$/);
        if (jobMatch) {
          const job = jobs.get(jobMatch[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: "作业不存在,可能服务已重启" });
          // timer 是 Node 的 Timeout 对象,JSON.stringify 出来是个空壳,pid 也不该
          // 透给前端 —— 只回契约里的那些字段。
          const { timer: _timer, pid: _pid, killed: _killed, ...safe } = job;
          return sendJson(res, 200, { ok: true, job: safe });
        }

        return next();
      });
    },
  };
}
