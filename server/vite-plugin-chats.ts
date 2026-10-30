import type { Plugin, Connect } from "vite";
import type { ServerResponse } from "http";
import path from "path";
import fs from "fs/promises";
import { existsSync, createReadStream, createWriteStream } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/** 会话存储目录：优先读环境变量，默认在项目根目录下的 .pc-chats */
function chatsDir(root: string): string {
  return process.env.PROMPTCUT_CHATS_DIR ?? path.join(root, ".pc-chats");
}

/** 工作目录：优先读环境变量，默认在项目根目录下的 .pc-work */
function workDir(root: string): string {
  return process.env.PROMPTCUT_WORK_DIR ?? path.join(root, ".pc-work");
}

/** 会话 id 正则白名单：1 到 64 位英文字母、数字、短横线、下划线 */
const CHAT_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/** 过滤文件名中的非法路径分隔符与上卷符号 */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, "").replace(/\.\./g, "");
}

/** 校验会话 id 是否合法 */
function isValidChatId(id: unknown): id is string {
  return typeof id === "string" && CHAT_ID_REGEX.test(id);
}

/** 获取并校验安全可信的会话文件绝对路径，防止路径穿越 */
function getSafeChatPath(root: string, id: string): string | null {
  if (!isValidChatId(id)) return null;
  const safeId = sanitizeFilename(id);
  const baseDir = path.resolve(chatsDir(root));
  const targetPath = path.resolve(baseDir, `${safeId}.json`);

  // 严格断言目标路径落在 baseDir 根目录下
  const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (process.platform === "win32") {
    if (!targetPath.toLowerCase().startsWith(baseWithSep.toLowerCase())) {
      return null;
    }
  } else {
    if (!targetPath.startsWith(baseWithSep)) {
      return null;
    }
  }
  return targetPath;
}

/** 获取并校验安全可信的工作空间目录路径，防止路径穿越 */
function getSafeWorkDir(root: string, id: string): string | null {
  if (!isValidChatId(id)) return null;
  const safeId = sanitizeFilename(id);
  const baseDir = path.resolve(workDir(root));
  const targetPath = path.resolve(baseDir, safeId);

  const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (process.platform === "win32") {
    if (!targetPath.toLowerCase().startsWith(baseWithSep.toLowerCase())) {
      return null;
    }
  } else {
    if (!targetPath.startsWith(baseWithSep)) {
      return null;
    }
  }
  return targetPath;
}

/** 附件记录形状 */
interface AttachmentRecord {
  id: string;            // 前端生成或服务端生成，和 jobId 可以同值
  name: string;          // 原文件名
  kind: "image" | "video" | "audio" | "text" | "pdf" | "json" | "srt" | "other";
  mime?: string;
  bytes?: number;
  srcPath: string | null;  // 原始磁盘路径；浏览器里选的文件拿不到，就是 null
  path?: string;           // 工作副本的绝对路径
  url?: string;            // 站内地址 /@pcwork/<会话id>/<文件名>
  status: "importing" | "ready" | "error";
  error?: string;
  jobId?: string;
  text?: string;           // 仅文本类且不超过 64KB 时，导入完成后由服务端读进来
}

/** 附件导入任务 */
interface AttachJob {
  id: string;
  conversationId: string;
  status: "importing" | "ready" | "error";
  error?: string;
  attachment: AttachmentRecord;
  startedAt: number;
}

const attachJobs = new Map<string, AttachJob>();

/** 服务端根据扩展名推导附件类型 */
function kindOfName(name: string): AttachmentRecord["kind"] {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex === -1) return "other";
  const ext = name.slice(dotIndex + 1).toLowerCase();

  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["srt", "vtt"].includes(ext)) return "srt";
  if (ext === "json") return "json";
  if (["txt", "md", "markdown", "csv", "log"].includes(ext)) return "text";
  return "other";
}

/** 根据文件扩展名推导响应 Content-Type */
function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    case ".mkv": return "video/x-matroska";
    case ".avi": return "video/x-msvideo";
    case ".m4v": return "video/x-m4v";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".aac": return "audio/aac";
    case ".ogg": return "audio/ogg";
    case ".flac": return "audio/flac";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".bmp": return "image/bmp";
    case ".avif": return "image/avif";
    case ".pdf": return "application/pdf";
    case ".json": return "application/json; charset=utf-8";
    case ".srt": return "text/plain; charset=utf-8";
    case ".vtt": return "text/vtt; charset=utf-8";
    case ".txt":
    case ".log": return "text/plain; charset=utf-8";
    case ".md":
    case ".markdown": return "text/markdown; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    default: return "application/octet-stream";
  }
}

/** 提供带 Range 范围请求的静态文件服务 */
async function serveFile(filePath: string, req: Connect.IncomingMessage, res: ServerResponse) {
  try {
    const stat = await fs.stat(filePath);
    const range = req.headers.range;
    const contentType = getContentType(filePath);

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

      const stream = createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      const stream = createReadStream(filePath);
      stream.pipe(res);
    }
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}

/** 从 req body 读取全部字节，默认上限 32MB */
function readBody(req: Connect.IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    req.on("data", (c: Buffer) => {
      receivedBytes += c.length;
      if (receivedBytes > maxBytes) {
        const err = new Error("Payload Too Large");
        (err as any).statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 统一返回 JSON 响应 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export function chatsPlugin(): Plugin {
  return {
    name: "vite-plugin-chats",
    configureServer(server) {
      const root = server.config.root;

      // 从 Vite 监听器中摘掉会话和工作目录，避免写文件导致 dev server 频繁重启或 watcher 崩溃
      try {
        server.watcher.unwatch(chatsDir(root));
        server.watcher.unwatch(workDir(root));
      } catch {
        /* 老版本 chokidar 没有就算了 */
      }

      server.middlewares.use(async (req: Connect.IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url) return next();
        const parsedUrl = new URL(req.url, "http://localhost");
        const pathname = parsedUrl.pathname;

        // ── 1. GET /api/chats/list?q=<关键字>&limit=<数字，默认 200> ──
        if (req.method === "GET" && pathname === "/api/chats/list") {
          const dir = chatsDir(root);
          if (!existsSync(dir)) {
            sendJson(res, 200, { ok: true, items: [] });
            return;
          }

          let files: string[] = [];
          try {
            files = await fs.readdir(dir);
          } catch {
            sendJson(res, 200, { ok: true, items: [] });
            return;
          }

          const q = parsedUrl.searchParams.get("q")?.trim() || "";
          const limitParam = parsedUrl.searchParams.get("limit");
          const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 200) : 200;

          const items: Array<{
            id: string;
            title: string;
            provider?: string;
            createdAt: number;
            updatedAt: number;
            messageCount: number;
            preview?: string;
          }> = [];

          for (const file of files) {
            if (!file.endsWith(".json")) continue;
            const fullPath = path.join(dir, file);
            try {
              const raw = await fs.readFile(fullPath, "utf-8");
              const data = JSON.parse(raw);
              if (!data || typeof data !== "object") continue;

              const id = typeof data.id === "string" && data.id ? data.id : path.basename(file, ".json");
              const messages = Array.isArray(data.messages) ? data.messages : [];

              // title 取文件里存的 title 字段；没有就取第一条 role 为 user 的消息 text 的前 20 个字符（再没有就用「未命名对话」）
              let title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "";
              if (!title) {
                const firstUser = messages.find((m: any) => m && m.role === "user");
                if (firstUser && typeof firstUser.text === "string" && firstUser.text.trim()) {
                  title = firstUser.text.trim().slice(0, 20);
                } else {
                  title = "未命名对话";
                }
              }

              // preview：最后一条消息 text 的前 60 字
              let preview = "";
              if (messages.length > 0) {
                const lastMsg = messages[messages.length - 1];
                if (lastMsg && typeof lastMsg.text === "string") {
                  preview = lastMsg.text.slice(0, 60);
                }
              }

              // q 过滤：不区分大小写，在 title 和所有消息 text 拼起来的正文里找子串
              if (q) {
                const lowerQ = q.toLowerCase();
                let matched = title.toLowerCase().includes(lowerQ);
                if (!matched) {
                  const combined = messages
                    .map((m: any) => (m && typeof m.text === "string" ? m.text : ""))
                    .join(" ");
                  matched = combined.toLowerCase().includes(lowerQ);
                }
                if (!matched) continue;
              }

              const createdAt = typeof data.createdAt === "number" ? data.createdAt : Date.now();
              const updatedAt = typeof data.updatedAt === "number" ? data.updatedAt : createdAt;

              items.push({
                id,
                title,
                provider: typeof data.provider === "string" ? data.provider : undefined,
                createdAt,
                updatedAt,
                messageCount: messages.length,
                preview: preview || undefined,
              });
            } catch {
              // 解析失败的文件跳过，不要抛错让整个接口挂掉
              continue;
            }
          }

          // 按 updatedAt 倒序排
          items.sort((a, b) => b.updatedAt - a.updatedAt);
          sendJson(res, 200, { ok: true, items: items.slice(0, limit) });
          return;
        }

        // ── 2. GET /api/chats/get?id=<id> ──
        if (req.method === "GET" && pathname === "/api/chats/get") {
          const id = parsedUrl.searchParams.get("id");
          if (!id || !isValidChatId(id)) {
            sendJson(res, 400, { ok: false, error: "会话 id 不合法" });
            return;
          }

          const filePath = getSafeChatPath(root, id);
          if (!filePath) {
            sendJson(res, 400, { ok: false, error: "非法路径" });
            return;
          }

          if (!existsSync(filePath)) {
            sendJson(res, 404, { ok: false, error: "会话不存在" });
            return;
          }

          try {
            const raw = await fs.readFile(filePath, "utf-8");
            const chat = JSON.parse(raw);
            sendJson(res, 200, { ok: true, chat });
          } catch {
            sendJson(res, 500, { ok: false, error: "读取会话失败" });
          }
          return;
        }

        // ── 3. POST /api/chats/save ──
        if (req.method === "POST" && pathname === "/api/chats/save") {
          let buffer: Buffer;
          try {
            buffer = await readBody(req);
          } catch (err: any) {
            if (err?.statusCode === 413) {
              sendJson(res, 413, { ok: false, error: "请求体体积超出 32MB 限制" });
              return;
            }
            sendJson(res, 500, { ok: false, error: "读取请求体失败" });
            return;
          }

          let body: any;
          try {
            body = JSON.parse(buffer.toString("utf-8"));
          } catch {
            sendJson(res, 400, { ok: false, error: "JSON 解析错误" });
            return;
          }

          if (!body || !isValidChatId(body.id) || !Array.isArray(body.messages)) {
            sendJson(res, 400, { ok: false, error: "参数不合法，缺少有效 id 或 messages 数组" });
            return;
          }

          const filePath = getSafeChatPath(root, body.id);
          if (!filePath) {
            sendJson(res, 400, { ok: false, error: "非法路径" });
            return;
          }

          // 计算 title
          let title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "";
          if (!title) {
            const firstUser = body.messages.find((m: any) => m && m.role === "user");
            if (firstUser && typeof firstUser.text === "string" && firstUser.text.trim()) {
              title = firstUser.text.trim().slice(0, 20);
            } else {
              title = "未命名对话";
            }
          }

          const now = Date.now();
          // body 没带 createdAt 时，优先沿用已有文件里的 createdAt，已有文件不存在时才用当前时间
          let createdAt: number;
          if (typeof body.createdAt === "number") {
            createdAt = body.createdAt;
          } else {
            let existingCreatedAt: number | undefined;
            if (existsSync(filePath)) {
              try {
                const existingRaw = await fs.readFile(filePath, "utf-8");
                const existingData = JSON.parse(existingRaw);
                if (typeof existingData?.createdAt === "number") {
                  existingCreatedAt = existingData.createdAt;
                }
              } catch {
                /* 忽略解析已有文件失败 */
              }
            }
            createdAt = existingCreatedAt ?? now;
          }
          const updatedAt = now;

          const toSave = {
            ...body,
            title,
            createdAt,
            updatedAt,
          };

          try {
            await fs.mkdir(chatsDir(root), { recursive: true });
            const tmpPath = `${filePath}.tmp`;
            await fs.writeFile(tmpPath, JSON.stringify(toSave, null, 2), "utf-8");
            await fs.rename(tmpPath, filePath);
            sendJson(res, 200, { ok: true, id: body.id, title, updatedAt });
          } catch (err: unknown) {
            sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // ── 4. POST /api/chats/delete ──
        if (req.method === "POST" && pathname === "/api/chats/delete") {
          let buffer: Buffer;
          try {
            buffer = await readBody(req);
          } catch {
            sendJson(res, 500, { ok: false, error: "读取请求体失败" });
            return;
          }

          let body: any;
          try {
            body = JSON.parse(buffer.toString("utf-8"));
          } catch {
            sendJson(res, 400, { ok: false, error: "JSON 解析错误" });
            return;
          }

          if (!body || !isValidChatId(body.id)) {
            sendJson(res, 400, { ok: false, error: "参数不合法，缺少有效 id" });
            return;
          }

          const filePath = getSafeChatPath(root, body.id);
          const workPath = getSafeWorkDir(root, body.id);
          if (!filePath || !workPath) {
            sendJson(res, 400, { ok: false, error: "非法路径" });
            return;
          }

          try {
            await fs.rm(filePath, { force: true });
            await fs.rm(workPath, { recursive: true, force: true });
            sendJson(res, 200, { ok: true });
          } catch (err: unknown) {
            sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // ── 5. POST /api/chats/attach/import ──
        if (req.method === "POST" && pathname === "/api/chats/attach/import") {
          let buffer: Buffer;
          try {
            buffer = await readBody(req);
          } catch {
            sendJson(res, 500, { ok: false, error: "读取请求体失败" });
            return;
          }

          let body: any;
          try {
            body = JSON.parse(buffer.toString("utf-8"));
          } catch {
            sendJson(res, 400, { ok: false, error: "JSON 解析错误" });
            return;
          }

          const conversationId = body?.conversationId;
          const srcPath = body?.srcPath;
          if (!isValidChatId(conversationId)) {
            sendJson(res, 400, { ok: false, error: "无效的 conversationId" });
            return;
          }
          /*
           * srcPath 是**用户自己挑的那个文件**,来自系统文件对话框 —— 磁盘上任何位置都合法,
           * 所以这里不能设目录白名单(设了「附件」这个功能就没了)。
           *
           * 它的防线是 vite-plugin-api-guard 那道同源卡口:跨站页面根本打不进这个接口。
           * 没有那道卡口的时候,任意网页都能用一个 text/plain 的简单 POST 让服务端把
           * 用户机器上任意一个文件复制到 web 目录下 —— 0.3.0 评审列的第一条高危就是这个。
           */
          if (typeof srcPath !== "string" || !srcPath || !existsSync(srcPath)) {
            sendJson(res, 400, { ok: false, error: "源文件路径不存在或不合法" });
            return;
          }

          const destDir = getSafeWorkDir(root, conversationId);
          if (!destDir) {
            sendJson(res, 400, { ok: false, error: "非法路径" });
            return;
          }

          try {
            await fs.mkdir(destDir, { recursive: true });
          } catch (e: unknown) {
            sendJson(res, 500, { ok: false, error: "创建工作目录失败" });
            return;
          }

          const jobId = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const origName = typeof body.name === "string" && body.name ? body.name : path.basename(srcPath);
          const targetFileName = `${jobId}-${sanitizeFilename(path.basename(origName))}`;
          const destPath = path.resolve(destDir, targetFileName);
          const kind = kindOfName(origName);

          const attachment: AttachmentRecord = {
            id: jobId,
            name: origName,
            kind,
            srcPath,
            status: "importing",
            jobId,
          };

          const job: AttachJob = {
            id: jobId,
            conversationId,
            status: "importing",
            attachment,
            startedAt: Date.now(),
          };
          attachJobs.set(jobId, job);

          // 立刻返回任务状态，不阻塞界面
          sendJson(res, 200, { ok: true, job });

          // 后台子进程复制
          const currentPluginDir = path.dirname(fileURLToPath(import.meta.url));
          const runnerScript = path.join(currentPluginDir, "runners", "copy-attachment.mjs");
          const child = spawn(process.execPath, [runnerScript, srcPath, destPath], { windowsHide: true });
          let stdoutData = "";
          let stderrData = "";
          child.stdout?.on("data", (c: Buffer) => { stdoutData += c.toString(); });
          child.stderr?.on("data", (c: Buffer) => { stderrData += c.toString(); });
          child.on("close", async (code) => {
            try {
              let parsed: any = null;
              try {
                parsed = JSON.parse(stdoutData.trim());
              } catch {
                /* 忽略解析错误 */
              }
              if (code === 0 && parsed?.ok) {
                const bytes = typeof parsed.bytes === "number" ? parsed.bytes : 0;
                job.status = "ready";
                job.attachment.status = "ready";
                job.attachment.bytes = bytes;
                job.attachment.path = destPath;
                job.attachment.url = `/@pcwork/${encodeURIComponent(conversationId)}/${encodeURIComponent(targetFileName)}`;

                // 仅文本类且不超过 64KB 时由服务端直接读入内存
                if (["text", "srt", "json"].includes(kind) && bytes <= 64 * 1024) {
                  try {
                    job.attachment.text = await fs.readFile(destPath, "utf-8");
                  } catch {
                    /* 忽略读取失败 */
                  }
                }
              } else {
                const errMsg = parsed?.error || stderrData.trim() || `复制进程退出码 ${code}`;
                job.status = "error";
                job.error = errMsg;
                job.attachment.status = "error";
                job.attachment.error = errMsg;
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              job.status = "error";
              job.error = msg;
              job.attachment.status = "error";
              job.attachment.error = msg;
            }
          });
          return;
        }

        // ── 6. POST /api/chats/attach/upload?conversationId=<id>&name=<文件名> ──
        if (req.method === "POST" && pathname === "/api/chats/attach/upload") {
          const conversationId = parsedUrl.searchParams.get("conversationId");
          const rawName = parsedUrl.searchParams.get("name");
          if (!conversationId || !isValidChatId(conversationId) || !rawName) {
            sendJson(res, 400, { ok: false, error: "缺少有效 conversationId 或 name 参数" });
            return;
          }

          const name = decodeURIComponent(rawName);
          const destDir = getSafeWorkDir(root, conversationId);
          if (!destDir) {
            sendJson(res, 400, { ok: false, error: "非法路径" });
            return;
          }

          try {
            await fs.mkdir(destDir, { recursive: true });
          } catch {
            sendJson(res, 500, { ok: false, error: "创建工作目录失败" });
            return;
          }

          const jobId = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const targetFileName = `${jobId}-${sanitizeFilename(path.basename(name))}`;
          const destPath = path.resolve(destDir, targetFileName);
          const kind = kindOfName(name);

          const attachment: AttachmentRecord = {
            id: jobId,
            name,
            kind,
            srcPath: null,
            status: "importing",
            jobId,
          };

          const job: AttachJob = {
            id: jobId,
            conversationId,
            status: "importing",
            attachment,
            startedAt: Date.now(),
          };
          attachJobs.set(jobId, job);

          // 限制最大 512MB，使用流管道直写磁盘
          const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
          let receivedBytes = 0;
          let limitExceeded = false;

          const limiter = new Transform({
            transform(chunk, _encoding, callback) {
              receivedBytes += chunk.length;
              if (receivedBytes > MAX_UPLOAD_BYTES) {
                limitExceeded = true;
                const err = new Error("File size exceeds 512MB limit");
                (err as any).statusCode = 413;
                callback(err);
                return;
              }
              callback(null, chunk);
            },
          });

          const fileStream = createWriteStream(destPath);
          try {
            await pipeline(req, limiter, fileStream);
            job.status = "ready";
            job.attachment.status = "ready";
            job.attachment.bytes = receivedBytes;
            job.attachment.path = destPath;
            job.attachment.url = `/@pcwork/${encodeURIComponent(conversationId)}/${encodeURIComponent(targetFileName)}`;

            if (["text", "srt", "json"].includes(kind) && receivedBytes <= 64 * 1024) {
              try {
                job.attachment.text = await fs.readFile(destPath, "utf-8");
              } catch {
                /* 忽略读取失败 */
              }
            }
            sendJson(res, 200, { ok: true, job });
          } catch (err: unknown) {
            job.status = "error";
            job.error = limitExceeded ? "文件超出 512MB 限制" : (err instanceof Error ? err.message : String(err));
            job.attachment.status = "error";
            job.attachment.error = job.error;
            try {
              await fs.rm(destPath, { force: true });
            } catch {
              /* 忽略清理临时文件错误 */
            }
            if (limitExceeded) {
              sendJson(res, 413, { ok: false, error: job.error, job });
            } else {
              sendJson(res, 500, { ok: false, error: job.error, job });
            }
          }
          return;
        }

        // ── 7. GET /api/chats/attach/status?jobId=<id> 或 ?ids=a,b,c ──
        if (req.method === "GET" && pathname === "/api/chats/attach/status") {
          const idsParam = parsedUrl.searchParams.get("ids");
          if (idsParam) {
            const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
            const resultJobs: Record<string, AttachJob> = {};
            for (const id of ids) {
              const j = attachJobs.get(id);
              if (j) resultJobs[id] = j;
            }
            sendJson(res, 200, { ok: true, jobs: resultJobs });
            return;
          }

          const jobId = parsedUrl.searchParams.get("jobId");
          if (!jobId) {
            sendJson(res, 400, { ok: false, error: "缺少 jobId 参数" });
            return;
          }

          const job = attachJobs.get(jobId);
          if (!job) {
            sendJson(res, 404, { ok: false, error: "任务不存在" });
            return;
          }

          sendJson(res, 200, { ok: true, job });
          return;
        }

        // ── 8. GET /@pcwork/<会话id>/<文件名> ──
        if (req.method === "GET" && pathname.startsWith("/@pcwork/")) {
          const parts = pathname.slice("/@pcwork/".length).split("/");
          if (parts.length < 2) {
            res.statusCode = 400;
            res.end("Invalid URL");
            return;
          }

          const conversationId = decodeURIComponent(parts[0]);
          const rawFileName = decodeURIComponent(parts.slice(1).join("/"));

          if (!isValidChatId(conversationId)) {
            res.statusCode = 400;
            res.end("Invalid conversation ID");
            return;
          }

          const safeWork = getSafeWorkDir(root, conversationId);
          if (!safeWork) {
            res.statusCode = 400;
            res.end("Invalid path");
            return;
          }

          const safeFileName = sanitizeFilename(rawFileName);
          const targetPath = path.resolve(safeWork, safeFileName);
          const safeWorkWithSep = safeWork.endsWith(path.sep) ? safeWork : safeWork + path.sep;

          if (process.platform === "win32") {
            if (!targetPath.toLowerCase().startsWith(safeWorkWithSep.toLowerCase())) {
              res.statusCode = 400;
              res.end("Invalid path");
              return;
            }
          } else {
            if (!targetPath.startsWith(safeWorkWithSep)) {
              res.statusCode = 400;
              res.end("Invalid path");
              return;
            }
          }

          if (!existsSync(targetPath)) {
            res.statusCode = 404;
            res.end("Not found");
            return;
          }

          await serveFile(targetPath, req, res);
          return;
        }

        next();
      });
    },
  };
}
