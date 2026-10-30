import type { Plugin, Connect } from "vite";
import type { ServerResponse } from "http";
import type { Readable } from "stream";
import path from "path";
import fs from "fs/promises";
import os from "os";
import crypto from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { spawn } from "child_process";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 网盘连接器 A2 的授权弹窗落地页。
 *
 * 它不在 `/api/media/` 下面,因为这个地址要和 Google 控制台里登记的重定向 URI 逐字一致 ——
 * 改前缀就得同时改控制台,而控制台改完「可能需要 5 分钟到几小时才会生效」。所以是中间件的总入口
 * 特意放它过来,见下面 `media()` 里那条前缀过滤。
 */
export const OAUTH_CALLBACK_PATH = "/oauth2callback";

const MEDIA_CONTEXT_KEY = Symbol.for("promptcut.asset.media-context.v2");
const mediaContext: AsyncLocalStorage<any> = (globalThis as any)[MEDIA_CONTEXT_KEY] ??= new AsyncLocalStorage();
function mediaOwnership(root: string): any {
  const context = mediaContext.getStore();
  if (!projectScope(root)) return null;
  projectScope(root).assertActive();
  if (context?.root !== path.resolve(root)) throw Object.assign(new Error("project-context-required"), { status: 403 });
  const scope = projectScope(root);
  const assert = async () => { scope.assertActive(); await context.lease.check(); scope.assertActive(); };
  return { projectId: context.projectId, authorizationId: context.lease.principal.authorizationId, assert, publish: scope.publishProjectFile, acquire: async () => { await assert(); const lease = await context.lease.fork(); try { scope.assertActive(); return lease; } catch (error) { lease.release(); throw error; } } };
}

function sanitizeFilename(name: string) {
  return name.replace(/[/\\]/g, "").replace(/\.\./g, "");
}

function outRoot(root: string): string {
  if (projectScope(root)) return path.join(path.resolve(root), "out");
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(root, "out");
}

/** 只读可信factory注册表；HTTP字段不能登记root，打包实例共享同一目录身份。 */
function projectScope(root: string): any { return (globalThis as any)[Symbol.for("promptcut.asset.project-roots.v2")]?.get(path.resolve(root)) ?? null; }

function inside(file: string, dir: string): boolean {
  const target = path.resolve(file);
  const base = path.resolve(dir);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Old .proc files store an absolute path from the desktop media library.  The
 * browser cannot read that path directly, so expose only the two media roots
 * owned by PromptCut (current out/media and the legacy Videos/PromptCut/media
 * folder).  The path is never accepted as an arbitrary file read.
 */
function allowedMediaRoots(root: string): string[] {
  const roots = [mediaDir(root)];
  if (projectScope(root)) return roots;
  const legacy = path.join(os.homedir(), "Videos", "PromptCut", "media");
  roots.push(legacy);
  if (process.env.PROMPTCUT_MEDIA_DIR) roots.push(path.resolve(process.env.PROMPTCUT_MEDIA_DIR));
  return roots;
}

/** 「没有这个文件」的那几种系统错误码;别的(没权限、设备错误)都是没读成,不是不存在 */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
/** 素材读接口给页面的判词:`absent` = 确实没有这个文件;`outside` = 路径不在素材目录里,这个接口不会给 */
const MEDIA_VERDICT_HEADER = "X-PC-Media-Verdict";

async function handleMediaFile(req: Connect.IncomingMessage, res: ServerResponse, root: string) {
  try {
    const query = new URL(req.url || "/", "http://promptcut.local").searchParams;
    const raw = query.get("path");
    if (!raw) { res.statusCode = 400; return res.end("Missing media path"); }
    const file = path.resolve(raw);
    const roots = allowedMediaRoots(root);
    if (!roots.some((dir) => inside(file, dir))) {
      res.statusCode = 403;
      // 页面判「本机取不取得到」时要分得清:这是「这条路径不在素材目录里,这个接口永远不会给」,不是一次读取失败
      res.setHeader(MEDIA_VERDICT_HEADER, "outside");
      return res.end("Media path is outside PromptCut media folders");
    }
    return serveFile(file, req, res);
  } catch {
    res.statusCode = 400;
    res.end("Invalid media path");
  }
}

/**
 * 素材落盘目录。上传和素材收集(vite-plugin-collect)都往这里写,
 * 所以 /@media/<文件名> 对两边的文件都能取到。
 *
 * A1 之后这里同时是**本地内容库**:导入的素材按 `<sha256>.<原扩展名>` 存,
 * 同一份内容只有一份文件 —— 改了 mtime、换了文件名再导入一次还是同一个键。
 */
export function mediaDir(root: string): string {
  return path.resolve(outRoot(root), "media");
}

/* ------------------------------------------------------------------ *
 * 内容哈希与本地内容库
 * ------------------------------------------------------------------ */

/** 64 位 hex,可带扩展名:/@media/<hash> 和 /@media/<hash>.<ext> 都认 */
const HASH_URL = /^([0-9a-fA-F]{64})(?:\.([A-Za-z0-9]+))?$/;

export function isMediaHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(String(value || "").toLowerCase());
}

/** 文件名里的扩展名(不含点,小写)。没有扩展名给空串 */
export function extOfName(name: string): string {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return "";
  return base.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** 扩展名 → Content-Type。认不出给 application/octet-stream */
export function contentTypeForExt(ext: string): string {
  return CONTENT_TYPES[String(ext || "").toLowerCase().replace(/^\./, "")] || "application/octet-stream";
}

export function contentTypeForFile(filePath: string): string {
  return contentTypeForExt(extOfName(filePath));
}

/** Content-Type → 扩展名(按上表反查,同一类型取表里第一个);认不出给空串。按需拉取落盘时用 */
export function extForContentType(contentType: string): string {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  for (const [ext, t] of Object.entries(CONTENT_TYPES)) if (t === type) return ext;
  return "";
}

export interface MediaIndexEntry {
  /** 本地内容库里的文件名(<hash>.<ext>) */
  file: string;
  /** 导入时的原文件名,只用来显示和 .procp 里还原 */
  name?: string;
  ext?: string;
  size?: number;
  contentType?: string;
}

type MediaIndex = Record<string, MediaIndexEntry>;

/** 索引文件:out/media/index.json。丢了也不致命 —— 查不到会退回扫目录 */
function indexPath(root: string): string {
  return path.join(mediaDir(root), "index.json");
}

const indexCache = new Map<string, MediaIndex>();

export async function readMediaIndex(root: string): Promise<MediaIndex> {
  const cached = indexCache.get(root);
  if (cached) return cached;
  let parsed: MediaIndex = {};
  try {
    const text = await fs.readFile(indexPath(root), "utf8");
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && raw.items && typeof raw.items === "object") parsed = raw.items as MediaIndex;
  } catch { /* 没索引就是空索引 */ }
  indexCache.set(root, parsed);
  return parsed;
}

export async function writeMediaIndex(root: string, hash: string, entry: MediaIndexEntry): Promise<void> {
  const index = await readMediaIndex(root);
  index[hash] = entry;
  try {
    await fs.mkdir(mediaDir(root), { recursive: true });
    await fs.writeFile(indexPath(root), JSON.stringify({ version: 1, items: index }, null, 2));
  } catch (err) {
    console.warn("[media] 写索引失败", err);
  }
}

/** 从索引里去掉一条(文件已经删了,比如重封装前的那份);没有这条就什么都不做 */
export async function forgetMediaIndex(root: string, hash: string): Promise<void> {
  const index = await readMediaIndex(root);
  if (!(hash in index)) return;
  delete index[hash];
  try {
    await fs.writeFile(indexPath(root), JSON.stringify({ version: 1, items: index }, null, 2));
  } catch (err) {
    console.warn("[media] 写索引失败", err);
  }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true; } catch { return false; }
}

/**
 * 哈希 → 本地内容库里的文件。三条路:URL 自带扩展名 → 索引 → 扫目录(索引丢了还能救)。
 * 找不到返回 null(读路由接着交给按需拉取,见 server/media-pull.mjs)。
 */
export async function resolveHashFile(root: string, hash: string, ext?: string): Promise<string | null> {
  const key = String(hash || "").toLowerCase();
  if (!isMediaHash(key)) return null;
  const dir = mediaDir(root);
  const visible = async (file: string) => await exists(file) && (!projectScope(root) || await projectScope(root).projectFileAccepted(file));
  if (ext) {
    const direct = path.join(dir, `${key}.${ext.toLowerCase()}`);
    if (await visible(direct)) return direct;
  }
  const index = await readMediaIndex(root);
  const entry = index[key];
  if (entry?.file) {
    const file = path.join(dir, sanitizeFilename(entry.file));
    if (await visible(file)) return file;
  }
  try {
    const names = await fs.readdir(dir);
    for (const hit of names) {
      if (!(hit.toLowerCase() === key || hit.toLowerCase().startsWith(key + "."))) continue;
      if (projectScope(root) && !/^[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i.test(hit)) continue;
      if (!await visible(path.join(dir, hit))) continue;
      // 索引缺了就地补上,下次不用再扫
      indexCache.set(root, { ...index, [key]: { file: hit, ext: extOfName(hit), contentType: contentTypeForFile(hit) } });
      return path.join(dir, hit);
    }
  } catch { /* 目录还不存在 */ }
  return null;
}

/* ------------------------------------------------------------------ *
 * 按需拉取与预取(C6.6 第 4 节,实现在 server/media-pull.mjs)
 * ------------------------------------------------------------------ */

/** 本地内容库给拉取模块的几样操作:它不认目录布局,只经这里落盘、入库 */
function pullStore(root: string) {
  const dir = mediaDir(root);
  const ownership = mediaOwnership(root);
  return {
    dir,
    projectId: ownership?.projectId,
    assert: ownership?.assert,
    resolve: (hash: string) => resolveHashFile(root, hash),
    extForType: extForContentType,
    async finalize(hash: string, tmp: string, ext: string, contentType: string): Promise<string> {
      await ownership?.assert();
      const file = ext ? `${hash}.${ext}` : hash;
      const dest = path.join(dir, file);
      if (ownership) {
        const lease = await ownership.acquire(), previous = (await readMediaIndex(root))[hash];
        try { await ownership.publish({ temp: tmp, target: dest, lease, assert: async () => { await ownership.assert(); await lease.assert(); }, afterCommit: async () => { const stat = await fs.stat(dest); await writeMediaIndex(root, hash, { file, name: file, ext, size: stat.size, contentType: contentType || contentTypeForExt(ext) }); }, rollback: () => previous ? writeMediaIndex(root, hash, previous) : forgetMediaIndex(root, hash) }); return dest; }
        finally { await lease.release(); }
      }
      if (await exists(dest)) {
        await fs.rm(tmp, { force: true }).catch(() => {});
      } else {
        try {
          await fs.rename(tmp, dest);
        } catch {
          // 改名被占着(Windows 上有读句柄没带共享删除):复制一份,临时文件稍后再删
          await fs.copyFile(tmp, dest);
          setTimeout(() => { void fs.rm(tmp, { force: true }).catch(() => {}); }, 5000).unref?.();
        }
      }
      const stat = await fs.stat(dest);
      await writeMediaIndex(root, hash, { file, name: file, ext, size: stat.size, contentType: contentType || contentTypeForExt(ext) });
      return dest;
    },
  };
}

type PullModule = typeof import("./media-pull.mjs");
/**
 * 惰性取拉取模块:好几个单测把本文件单独转译到临时目录再 import,静态 import 兄弟模块会解析失败;
 * 取不到就当没有按需拉取(和原来一样回 404)。
 */
async function pullModule(): Promise<PullModule | null> {
  try { return await import("./media-pull.mjs"); } catch { return null; }
}

async function readJsonBody(req: Connect.IncomingMessage, max = 256 * 1024): Promise<any> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new Error("body too large");
    parts.push(chunk);
  }
  const text = Buffer.concat(parts).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/**
 * 页面管的几条(同源,`/api/**` 守卫照旧):
 * - `POST /api/media/remote { base, ticket }`:设当前连接的远程素材服务(null / DELETE 清掉);`GET` 看状态;
 * - `POST /api/media/prefetch { items: [{ hash }] }`:换一份预取清单(有序);
 * - `POST /api/media/originals { hashes }`:这些素材原尺寸在当前素材服务上哪些还没 `complete`(导出前的拦截)。
 */
async function handlePullApi(req: Connect.IncomingMessage, res: ServerResponse, root: string): Promise<boolean> {
  const url = String(req.url || "").split("?")[0];
  if (url !== "/api/media/remote" && url !== "/api/media/prefetch" && url !== "/api/media/originals") return false;
  let mod: any = await pullModule();
  if (!mod) { sendJson(res, 501, { ok: false, error: "pull-unavailable" }); return true; }
  const context = mediaContext.getStore();
  if (projectScope(root)) mod = mod.projectMediaPull(context);
  try {
    if (url === "/api/media/remote") {
      if (req.method === "GET") { sendJson(res, 200, { ok: true, ...mod.pullStatus() }); return true; }
      if (req.method === "DELETE") { mod.setRemoteAssetService(null); sendJson(res, 200, { ok: true, base: null }); return true; }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const target = body?.base ? { base: String(body.base), ticket: typeof body.ticket === "string" ? body.ticket : null } : null;
        const checked = target && context ? await context.verifyRemoteTarget?.(req, target) : target;
        if (target && context && checked?.projectId !== context.projectId) throw Object.assign(new Error("project-mismatch"), { status: 403 });
        const base = checked ? mod.setRemoteAssetService(checked)?.base : mod.setRemoteAssetService(null);
        sendJson(res, 200, { ok: true, base: base ?? null });
        return true;
      }
    }
    if (url === "/api/media/prefetch" && req.method === "POST") {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, queued: mod.prefetch(Array.isArray(body?.items) ? body.items : [], pullStore(root)) });
      return true;
    }
    if (url === "/api/media/originals" && req.method === "POST") {
      const body = await readJsonBody(req);
      const missing = await mod.incompleteOnService(Array.isArray(body?.hashes) ? body.hashes : [], pullStore(root));
      sendJson(res, 200, { ok: true, remote: mod.remoteAssetBase(), missing });
      return true;
    }
    sendJson(res, 405, { ok: false, error: "method" });
  } catch (err) {
    sendJson(res, (err as any)?.status ?? 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

/** 这些哈希里哪些已经完整落在本地内容库(A1 第 5 步的预取队列问的也是这条) */
export async function localHashes(root: string, hashes: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of hashes) {
    if (!isMediaHash(h)) continue;
    if (await resolveHashFile(root, h)) out.push(h.toLowerCase());
  }
  return out;
}

/** 已经落盘的文件算一次 sha256(流式,常数内存) */
export async function hashFile(filePath: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  await pipeline(createReadStream(filePath), digest);
  return digest.digest("hex");
}

export interface StoredMedia {
  hash: string;
  ext: string;
  name: string;
  bytes: number;
  /** 本地内容库里的绝对路径 */
  path: string;
  /** 素材地址:身份就是哈希,不带扩展名 */
  url: string;
  contentType: string;
  /** 这次之前库里就有同样内容(mtime / 文件名不同也算同一份) */
  deduped: boolean;
}

/**
 * **边落盘边算哈希**:请求体一路 pipe 到临时文件,每块顺手 update 一次 sha256,
 * 全程常数内存 —— 4 GB 的视频不会有任何一刻整份待在内存里,也没有一个长任务
 * 卡住事件循环(每块几十 KiB 的 hash.update 是几十微秒级),所以主服务在导入
 * 期间照样能在 100 ms 内答别的请求。算完才按 <hash>.<ext> 改名落库:
 * 库里已经有同样内容就直接删掉临时文件(去重),两次导入同一内容拿到同一个键。
 */
export async function storeMediaStream(root: string, name: string, source: Readable): Promise<StoredMedia> {
  const ownership = mediaOwnership(root);
  const lease = ownership ? mediaContext.getStore()?.lease : null;
  return lease ? lease.run(store) : store();
  async function store(): Promise<StoredMedia> {
  await ownership?.assert();
  const dir = mediaDir(root);
  await fs.mkdir(dir, { recursive: true });
  let decoded = String(name || "");
  try { decoded = decodeURIComponent(decoded); } catch { /* 不是 %xx 就按原样 */ }
  const safeName = sanitizeFilename(decoded);
  const ext = extOfName(safeName);
  const tmp = path.join(dir, `.upload-${crypto.randomBytes(8).toString("hex")}.part`);

  const digest = crypto.createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      digest.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  try {
    const output = createWriteStream(tmp), lease = ownership ? mediaContext.getStore()?.lease : null;
    lease?.track(output);
    if (lease) await pipeline(source, tap, output, { signal: lease.signal });
    else await pipeline(source, tap, output);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }

  const hash = digest.digest("hex");
  const file = ext ? `${hash}.${ext}` : hash;
  const dest = path.join(dir, file);
  const had = await exists(dest);
  try { await ownership?.assert(); } catch (error) { await fs.rm(tmp, { force: true }); throw error; }
  const contentType = contentTypeForExt(ext);
  if (ownership) {
    const previous = (await readMediaIndex(root))[hash];
    try { await ownership.publish({ temp: tmp, target: dest, lease, assert: async () => { await ownership.assert(); await lease.assert(); }, afterCommit: () => writeMediaIndex(root, hash, { file, name: safeName, ext, size: bytes, contentType }), rollback: () => previous ? writeMediaIndex(root, hash, previous) : forgetMediaIndex(root, hash) }); }
    finally { await fs.rm(tmp, { force: true }); }
  } else { if (had) await fs.rm(tmp, { force: true }); else await fs.rename(tmp, dest); await writeMediaIndex(root, hash, { file, name: safeName, ext, size: bytes, contentType }); }
  return { hash, ext, name: safeName, bytes, path: dest, url: `/@media/${hash}`, contentType, deduped: had };
  }
}

/**
 * 给一个**已经在素材目录里**的文件补算内容键(素材收集下载好的那种)。
 *
 * 那条路不经过上传,文件本来就在服务端,再从浏览器 POST 一遍几百 MB 纯属浪费;
 * 但没有键它就进不了 .procp、也享受不到跨机器去重。所以在服务端就地流式算一遍
 * sha256(hashFile,常数内存、不卡事件循环),然后把它挂进内容库:
 * 先试硬链接(同一卷上不占第二份字节),不行才拷。原文件留在原处不动 ——
 * 素材收集那一侧可能还按原名在引用它。
 */
export async function adoptMediaFile(root: string, filePath: string): Promise<StoredMedia> {
  const ownership = mediaOwnership(root);
  const lease = ownership ? mediaContext.getStore()?.lease : null;
  return lease ? lease.run(adopt) : adopt();
  async function adopt(): Promise<StoredMedia> {
  await ownership?.assert();
  const dir = mediaDir(root);
  await fs.mkdir(dir, { recursive: true });
  const src = path.resolve(filePath);
  if (ownership && !inside(src, dir)) throw Object.assign(new Error("project-mismatch"), { status: 403 });
  const stat = await fs.stat(src);
  const name = path.basename(src);
  const ext = extOfName(name);
  const hash = await hashFile(src);
  const file = ext ? `${hash}.${ext}` : hash;
  const dest = path.join(dir, file);

  const had = await exists(dest);
  await ownership?.assert();
  const contentType = contentTypeForExt(ext);
  if (ownership) {
    const tmp = path.join(dir, `.adopt-${crypto.randomBytes(8).toString("hex")}.part`), previous = (await readMediaIndex(root))[hash];
    try { try { await fs.link(src, tmp); } catch { await fs.copyFile(src, tmp); }
      await ownership.publish({ temp: tmp, target: dest, lease, assert: async () => { await ownership.assert(); await lease.assert(); }, afterCommit: () => writeMediaIndex(root, hash, { file, name, ext, size: stat.size, contentType }), rollback: () => previous ? writeMediaIndex(root, hash, previous) : forgetMediaIndex(root, hash) });
    } finally { await fs.rm(tmp, { force: true }); }
  } else {
    if (!had && path.resolve(dest) !== src) { try { await fs.link(src, dest); } catch { await fs.copyFile(src, dest); } }
    await writeMediaIndex(root, hash, { file, name, ext, size: stat.size, contentType });
  }
  return { hash, ext, name, bytes: stat.size, path: dest, url: `/@media/${hash}`, contentType, deduped: had };
  }
}

/* ------------------------------------------------------------------ *
 * 两档素材与上传队列(C6.6,`docs/plan/c66-design.md` 第 2、3 节)
 * ------------------------------------------------------------------ */

/**
 * 每个项目根一份:两档管理器(`media-tiers.mjs`)、上传队列(`upload-queue.mjs`)、当前连接的素材服务。
 * 放在 globalThis 上:配置被打包过一次、模块可能有两份实例。
 *
 * **当前连接的素材服务**(上传队列的目标):
 *   - 缺省是本机素材服务(就是这个插件)—— 导入已经是本地写入,上传队列是空操作;
 *   - `PROMPTCUT_ASSET_URL`(形如 `http://192.168.50.96:5460/api/asset`,与预渲染进程推送用的是同一个变量)设了就是它;
 *   - 页面(连着共享项目、知道远端素材服务与票据的那一方)经 `POST /api/media/upload-queue/target` 改它,
 *     `{ base: null }` 换回缺省(设了 `PROMPTCUT_ASSET_URL` 就是它,否则本机)。票据由页面按时续上(素材票据 15 分钟,见 `docs/plan/auth-contract.md` 第 8 节)。
 */
type TierService = {
  manager: any;
  queue: any | null;
  setTarget(target: { base: string | null; ticket?: string | null } | null): Promise<void>;
  target(): { base: string } | null;
};
const TIERS_KEY = Symbol.for("promptcut.media-tiers.services");
function tierServices(): Map<string, Promise<TierService>> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Promise<TierService>>>;
  holder[TIERS_KEY] ??= new Map();
  return holder[TIERS_KEY];
}

const tiersLog = (event: string, fields: object = {}) => {
  try { console.info("[media-tiers]", event, JSON.stringify(fields)); } catch { console.info("[media-tiers]", event); }
};

/**
 * 取(必要时建)这个根的两档服务。`withQueue: false` 只生成两档、不建上传队列。惰性 import:好几个单测把本文件单独转译到临时目录,静态 import 兄弟模块会解析失败。
 */
export function mediaTierService(root: string, { withQueue = true }: { withQueue?: boolean } = {}): Promise<TierService> {
  const ownership = mediaOwnership(root);
  const services = tierServices();
  const key = path.resolve(root) + (ownership ? `:${ownership.authorizationId}` : "");
  let pending = services.get(key);
  if (pending) return pending;
  pending = (async () => {
    const tiersMod: any = await import("./media-tiers.mjs");
    const { findFfmpeg }: any = await import("./bakery/ffmpeg.mjs");
    let queue: any = null;
    let current: { base: string; client: any; projectId?: string } | null = null;
    let ticketValue: string | null = null;
    const setTargetImpl = async (next: { base: string | null; ticket?: string | null } | null) => {
      const base = String(next?.base || "").trim().replace(/\/+$/, "");
      if (typeof next?.ticket === "string" || next?.ticket === null) ticketValue = next?.ticket || null;
      if (!base) { if (current) tiersLog("upload.target", { base: null }); current = null; return; }
      if (current?.base === base) return;
      const { createAssetClient }: any = await import("./asset-store/client.mjs");
      // 票据只进 Authorization 头(客户端负责),这里不记
      const client = createAssetClient({ base, ticket: () => ticketValue, timeoutMs: 120_000 });
      current = { base, client, ...(ownership ? { projectId: ownership.projectId } : {}) };
      tiersLog("upload.target", { base });
    };
    /*
     * 卡片快照(热备渲染器那条 `ui-render/bake-batch` 在编辑器进程里渲)写进本机素材服务之后,再推一份到当前连接的
     * 素材服务(`bake-store.mjs`);连的是本机时 `current` 为 null,不推。惰性 import,理由同上。
     */
    if (withQueue && !ownership) {
      try {
        const { setBakeRemote }: any = await import("./bake-store.mjs");
        setBakeRemote(() => (current ? { base: current.base, put: (ns: string, bytes: Buffer, o?: any) => current!.client.put(ns, bytes, o) } : null));
      } catch { /* 没有就不推 */ }
    }
    if (withQueue) {
      const { createUploadQueue }: any = await import("./upload-queue.mjs");
      const { sharedBandwidthGate, pushQueueFileProbe }: any = await import("./bandwidth-gate.mjs");
      const gate = sharedBandwidthGate();
      // 推送队列在预渲染进程里:读它落盘的队列文件判断「产物还在推」(`bandwidth-gate.mjs` 文件头)
      gate.setExternal(pushQueueFileProbe(path.join(outRoot(root), "frame-library", "push-queue.json")));
      queue = createUploadQueue({
        file: path.join(outRoot(root), "upload-queue.json"),
        target: () => current,
        resolveFile: (hash: string) => resolveHashFile(root, hash),
        gate,
        log: tiersLog,
        ownership,
      });
    }
    const envBase = ownership ? "" : String(process.env.PROMPTCUT_ASSET_URL || "").trim();
    if (envBase) await setTargetImpl({ base: envBase });
    await fs.mkdir(mediaDir(root), { recursive: true });
    const manager = tiersMod.createTierManager({
      dir: mediaDir(root),
      lib: {
        hashFile,
        writeIndex: (hash: string, entry: MediaIndexEntry) => writeMediaIndex(root, hash, entry),
        entry: async (hash: string) => (await readMediaIndex(root))[hash],
        forget: (hash: string) => forgetMediaIndex(root, hash),
        contentTypeForExt,
      },
      ffmpeg: findFfmpeg,
      queue,
      log: tiersLog,
      ownership,
    });
    return {
      manager,
      queue,
      // `{ base: null }`(页面离开共享项目 / 本机就是主机)= 回到缺省目标:设了 PROMPTCUT_ASSET_URL 就是它,否则本机
      setTarget: (next) => setTargetImpl(next?.base ? next : { base: envBase || null, ticket: null }),
      target: () => (current ? { base: current.base } : null),
    };
  })();
  services.set(key, pending);
  pending.catch(() => services.delete(key));
  return pending;
}

/** 导入(`?tiers=1`)之后:视频做重封装判定、排素材小尺寸;回包字段 */
async function prepareTiers(root: string, stored: StoredMedia) {
  const service = await mediaTierService(root, { withQueue: true });
  const out = await service.manager.prepareImport(stored);
  return out as { stored: StoredMedia; tiers: { original: string; small: string | null } | null; small: string | null; remux: any };
}

function wantsTiers(req: Connect.IncomingMessage): boolean {
  try {
    const v = new URL(req.url || "/", "http://promptcut.local").searchParams.get("tiers");
    return v === "1" || v === "true";
  } catch { return false; }
}

async function handleMediaUpload(req: Connect.IncomingMessage, res: ServerResponse, root: string) {
  const rawName = req.url?.split("?")[0].split("/").pop();
  if (!rawName) {
    res.statusCode = 400;
    res.end("Missing filename");
    return;
  }
  try {
    let stored = await storeMediaStream(root, rawName, req as unknown as Readable);
    let extra: Record<string, unknown> = {};
    if (wantsTiers(req)) {
      try {
        const prepared = await prepareTiers(root, stored);
        stored = prepared.stored;
        if (prepared.tiers) extra = { tiers: prepared.tiers, small: prepared.small, remux: prepared.remux };
      } catch (err) {
        // 两档出了问题不挡导入:照原来的回包,只有素材原尺寸一档
        tiersLog("tiers.prepare-failed", { hash: stored.hash, message: err instanceof Error ? err.message : String(err) });
      }
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      ...(projectScope(root) ? { projectId: projectScope(root).projectId } : {}),
      hash: stored.hash,
      ext: stored.ext,
      name: stored.name,
      path: stored.path,
      url: stored.url,
      bytes: stored.bytes,
      deduped: stored.deduped,
      ...extra,
    }));
  } catch (err: unknown) {
    res.statusCode = 500;
    res.end(err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------------------------------------------ *
 * GET /@media/<hash>/pcm —— 音频素材效果卡的素材输入
 * ------------------------------------------------------------------ */

/** 路由里的哈希。必须排在 /@media/<文件名> 之前,不然 `.pop()` 取出来的是 "pcm" */
const PCM_URL = /^\/@media\/([^/?]+)\/pcm$/;
const PCM_MAX_FRAMES = 1048576;
const PCM_CHANNELS = 2;
const PCM_MAX_BYTES = 256 * 1024 * 1024;

/**
 * ffmpeg 在哪。**惰性**取:vite 配置加载时不该把整个 server/bakery 拖进来,
 * 而且 server/test 里把这个插件转译到临时目录再 import 的那几个测试也不能因此解析失败。
 */
async function ffmpegCommand(): Promise<string> {
  const { findFfmpeg } = await import("./bakery/ffmpeg.mjs");
  return findFfmpeg();
}

/** card-service.mjs:47 的 commandBuffer。子进程的标准输出收成一个 Buffer,超预算就杀掉 */
function commandBuffer(executable: string, args: string[], max = PCM_MAX_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    mediaContext.getStore()?.lease.trackProcess(child);
    const parts: Buffer[] = [];
    let size = 0, diagnostic = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) { child.kill(); reject(new Error("Source buffer exceeds budget")); }
      else parts.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk).slice(-4096); });
    child.on("error", reject);
    child.on("close", (code) => { if (code !== 0) reject(new Error(`Source decoder failed: ${diagnostic}`)); else resolve(Buffer.concat(parts)); });
  });
}

/**
 * 素材的一段 PCM(交错 f32le,恒 2 通道)。`card-service.mjs:308-313` 那段搬过来的:
 * 参数校验一起搬,只是不再写 `.bin` 回描述符,直接回字节。
 *
 * **没有 `offset` 参数**:`clip.mediaOffset + 边.offset` 由页面折算一次,折进 `start`。
 * 所以服务端的 `position = start`,可以为负(前面补静音),素材短于请求时尾部补零。
 */
async function handleMediaPcm(req: Connect.IncomingMessage, res: ServerResponse, root: string, hash: string) {
  try {
    const query = new URL(req.url || "/", "http://promptcut.local").searchParams;
    // 缺参数不能当 0:Number(null) 是 0,漏了 start 会静默从头裁
    const num = (name: string) => { const raw = query.get(name); return raw === null || raw.trim() === "" ? NaN : Number(raw); };
    const start = num("start"), count = num("count"), sampleRate = num("sampleRate");
    const channels = query.has("ch") ? num("ch") : PCM_CHANNELS;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1 || count > PCM_MAX_FRAMES
      || !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || channels !== PCM_CHANNELS) {
      res.statusCode = 400;
      return res.end("Invalid source audio range");
    }
    const file = await resolveHashFile(root, sanitizeFilename(hash).toLowerCase());
    if (!file) { res.statusCode = 404; return res.end("Not found"); }

    const position = start;
    const leading = Math.min(count, Math.max(0, -position));
    const pcm = leading === count ? Buffer.alloc(0) : await commandBuffer(await ffmpegCommand(), [
      "-v", "error", "-ss", String(Math.max(0, position) / sampleRate), "-i", file,
      "-t", String((count - leading) / sampleRate), "-vn",
      "-ar", String(sampleRate), "-ac", String(PCM_CHANNELS), "-f", "f32le", "pipe:1",
    ]);
    // 素材短于请求时尾部补零;position 为负时前 leading 帧是静音
    const bytes = Buffer.alloc(count * PCM_CHANNELS * 4);
    pcm.copy(bytes, leading * PCM_CHANNELS * 4, 0, Math.min(pcm.length, (count - leading) * PCM_CHANNELS * 4));
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store" });
    return res.end(bytes);
  } catch (err) {
    res.statusCode = 500;
    res.end(err instanceof Error ? err.message : String(err));
  }
}

/**
 * 解析 Range 头。只认单段 `bytes=a-b` / `bytes=a-` / `bytes=-n`(后缀);
 * 认不出的返回 null(当没带 Range,回整件 200),落在文件外的返回 "unsatisfiable"(回 416)。
 * 结尾超出文件的按 RFC 9110 截到最后一个字节。合法的 `bytes=a-b` 和原来的行为一字不差。
 */
export function parseRange(header: string, size: number): { start: number; end: number } | null | "unsatisfiable" {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number, end: number;
  if (m[1] === "") {
    const n = parseInt(m[2], 10);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * 发一个文件(整件或一段 Range)。
 *
 * 先把文件打开、在这个句柄上取大小,再从同一个句柄读:原来是先 `stat` 再按路径另开读流,文件在两步之间没了
 * (素材被清、内容库换目录、测试里删文件)时,读流的 `error` 没人接,会把整个编辑器进程带崩 ——
 * 页面上随后所有请求都是 `Failed to fetch`。
 * 现在打不开就回 404;打开之后文件被删,句柄仍然读得完;读到一半出错只断这一条响应。
 */
async function serveFile(filePath: string, req: Connect.IncomingMessage, res: ServerResponse) {
  const ownedLease = mediaContext.getStore()?.lease, finish = ownedLease?.hold();
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, "r");
    ownedLease?.trackHandle(handle);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not a file");
    const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
    const contentType = contentTypeForFile(filePath);
    const head = req.method === "HEAD";
    const lease = mediaContext.getStore()?.lease;
    if (lease && (path.basename(filePath).startsWith(".") || filePath.endsWith(".project-publication.json") || /\.[0-9a-f-]{36}\.backup$/i.test(filePath))) throw Object.assign(new Error("project-publication-private"), { status: 404 });
    if (lease && !await projectScope(mediaContext.getStore().root).projectFileAccepted(filePath)) throw Object.assign(new Error("project-publication-pending"), { status: 404 });
    if (lease) { await lease.assert(); res.setHeader("Cache-Control", "no-store"); }
    if (res.destroyed) return;
    // Last-Modified:没有内容哈希的迁移期素材,帧管线按 `HEAD` 的 Content-Length + Last-Modified 打戳
    // (server/media-stamp.mjs),不再自己去 stat 这个目录
    const lastModified = stat.mtime.toUTCString();
    const send = (opts?: { start: number; end: number }) => {
      const stream = handle!.createReadStream(opts); // 读完或出错时流自己关句柄
      handle = null;
      mediaContext.getStore()?.lease.track(stream);
      stream.on("error", () => { res.destroy(); });
      res.on("close", () => { stream.destroy(); });
      stream.pipe(res);
    };

    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
      return res.end();
    }
    if (range) {
      const { start, end } = range;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": (end - start) + 1,
        "Content-Type": contentType,
        "Last-Modified": lastModified,
      });
      if (head) return res.end();
      send({ start, end });
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Last-Modified": lastModified,
      });
      if (head) return res.end();
      send();
    }
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    // 只有「确实没有这个文件」才回 404;没权限读、磁盘出错之类回 500 —— 页面据此判素材缺失,不能把读取失败说成不存在
    const absent = ABSENT_CODES.has((err as any)?.code);
    res.statusCode = (err as any)?.status ?? (absent || !(err as any)?.code ? 404 : 500);
    if (absent) res.setHeader(MEDIA_VERDICT_HEADER, "absent");
    res.end(res.statusCode === 404 ? "Not found" : "Media read failed");
  } finally {
    await handle?.close().catch(() => {});
    finish?.();
  }
}

export { serveFile };

/**
 * 媒体路由。和插件本身分开导出,单测可以直接把它架在一个裸 http server 上跑
 * (Range/206、哈希 URL 的 contentType、文件名回退都在这一层)。
 */
export interface ProjectMediaOptions { projectAccess?: any; projectStores?: any; verifyRemoteTarget?: (req: Connect.IncomingMessage, target: any) => Promise<any> }
export function mediaMiddleware(root: string, options: ProjectMediaOptions = {}) {
  if (!!options.projectAccess !== !!options.projectStores) throw new TypeError("projectStores and projectAccess required together");
  const local = async function scopedMedia(req: Connect.IncomingMessage, res: ServerResponse, next: () => void, root: string) {
    if (!req.url) return next();

    // POST /api/media/upload/<文件名> —— 流式落盘 + 内容哈希
    if (req.method === "POST" && req.url.startsWith("/api/media/upload/")) {
      return handleMediaUpload(req, res, root);
    }

    // POST /api/media/adopt —— 给素材目录里已有的文件补算内容键(素材收集下载的那种)
    if (req.method === "POST" && req.url.startsWith("/api/media/adopt")) {
      try {
        const query = new URL(req.url, "http://promptcut.local").searchParams;
        const raw = query.get("path");
        if (!raw) { res.statusCode = 400; return res.end("Missing media path"); }
        const file = path.resolve(raw);
        if (!allowedMediaRoots(root).some((dir) => inside(file, dir))) {
          res.statusCode = 403;
          res.setHeader(MEDIA_VERDICT_HEADER, "outside");
          return res.end("Media path is outside PromptCut media folders");
        }
        // 文件确实不在:明确回 404(别的失败照旧 500),页面才分得清「没有」和「没读成」
        try { await fs.stat(file); }
        catch (err: any) {
          if (!ABSENT_CODES.has(err?.code)) throw err;
          res.statusCode = 404; res.setHeader(MEDIA_VERDICT_HEADER, "absent");
          return res.end("Not found");
        }
        let stored = await adoptMediaFile(root, file);
        let extra: Record<string, unknown> = {};
        if (wantsTiers(req)) {
          try {
            // 硬链接进库的那份若要重封装:重封装的结果另存一份,库里那份照常删(原处的文件不动,素材收集还按原名引用它)
            const prepared = await prepareTiers(root, stored);
            stored = prepared.stored;
            if (prepared.tiers) extra = { tiers: prepared.tiers, small: prepared.small, remux: prepared.remux };
          } catch (err) {
            tiersLog("tiers.prepare-failed", { hash: stored.hash, message: err instanceof Error ? err.message : String(err) });
          }
        }
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({
          ok: true,
          ...(projectScope(root) ? { projectId: projectScope(root).projectId } : {}),
          hash: stored.hash,
          ext: stored.ext,
          name: stored.name,
          path: stored.path,
          url: stored.url,
          bytes: stored.bytes,
          deduped: stored.deduped,
          ...extra,
        }));
      } catch (err: unknown) {
        res.statusCode = 500;
        return res.end(err instanceof Error ? err.message : String(err));
      }
    }

    // GET /api/media/storage/config —— 网盘连接器给页面的公开参数(任务书 docs/plan/drive-connector-task.md 第 5 节)。
    // 没配环境变量就回 configured: false,界面把入口置灰并说明原因,不报错。
    if (req.method === "GET" && req.url.split("?")[0] === "/api/media/storage/config") {
      const { buildExtensions }: any = await import("./vite-plugin-hosted-gate");
      const storageConfig = buildExtensions.mediaStorage?.storageConfig;
      if (typeof storageConfig !== "function") return next();
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(storageConfig()));
    }

    // GET /oauth2callback —— A2 的授权弹窗落地页:把授权码 postMessage 回开它的页面,然后自己关掉。
    // 这个地址要和 Google 控制台里登记的重定向 URI 逐字一致;上面那个总入口的前缀过滤也要放它过来。
    if (req.method === "GET" && req.url.split("?")[0] === OAUTH_CALLBACK_PATH) {
      const { buildExtensions }: any = await import("./vite-plugin-hosted-gate");
      const callbackHtml = buildExtensions.mediaStorage?.callbackHtml;
      if (typeof callbackHtml !== "function") return next();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // 授权码在地址栏里,别让它进任何缓存
      res.setHeader("Cache-Control", "no-store");
      return res.end(callbackHtml());
    }

    // 网盘连接器的四个口(任务书第 5 节)。A3 把一次性令牌随 import 递进来;A2 先 connect 再 import(不带令牌)。
    // 令牌与授权码只过手:不落盘、不进日志、不进回包。
    if (req.method && req.url.split("?")[0].startsWith("/api/media/storage/")) {
      const route = req.url.split("?")[0].slice("/api/media/storage/".length);
      const { buildExtensions }: any = await import("./vite-plugin-hosted-gate");
      const mod: any = buildExtensions.mediaStorage;
      if (!mod) return next();
      const { assetServiceOrigin }: any = await import("./asset-client");
      const ctx = { origin: assetServiceOrigin, root, ownership: null };
      const send = (body: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(body));
      };
      try {
        if (req.method === "POST" && route === "import") return send({ ok: true, ...(await mod.handleStorageImport(await readJsonBody(req), ctx)) });
        if (req.method === "POST" && route === "connect") return send({ ok: true, ...(await mod.handleConnect(await readJsonBody(req), ctx)) });
        if (req.method === "GET" && route === "connections") return send(await mod.handleConnections(ctx));
        if (req.method === "POST" && route === "disconnect") return send({ ok: true, ...(await mod.handleDisconnect(await readJsonBody(req), ctx)) });
      } catch (err: any) {
        return send({
          ok: false,
          error: String(err?.code || "error"),
          message: err instanceof Error ? err.message : String(err),
        }, mod.statusForCode(err?.code));
      }
    }

    // POST /api/media/tiers/backfill { items: [{ hash, name? }] } —— 打开项目时补转素材小尺寸(C6.6 设计稿第 9 节第 2 条):
    // 本地内容库里有这份素材原尺寸的视频排进后台转码,回 { ok, items: { [hash]: { state, small? } } };
    // 本地没有素材原尺寸的回 state: 'absent'(不为了转素材小尺寸去拉素材原尺寸)
    if (req.method === "POST" && req.url.split("?")[0] === "/api/media/tiers/backfill") {
      try {
        const body = await readJsonBody(req);
        const list = (Array.isArray(body?.items) ? body.items : []).slice(0, 200);
        const service = await mediaTierService(root, { withQueue: true });
        const items: Record<string, unknown> = {};
        for (const it of list) {
          const hash = String(it?.hash || "").toLowerCase();
          if (!isMediaHash(hash) || items[hash]) continue;
          const file = await resolveHashFile(root, hash);
          items[hash] = file
            ? await service.manager.backfill({ hash, ext: extOfName(file), name: typeof it?.name === "string" ? it.name : "" })
            : { state: "absent" };
        }
        return sendJson(res, 200, { ok: true, items });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // GET /api/media/tiers?hashes=a,b —— 这些素材原尺寸的素材小尺寸情况(C6.6):{ ok, items: { [素材原尺寸]: { state, small? } } }。
    // state:pending(在转)、ready(small 是素材小尺寸哈希)、failed、none(没有视频流)、unknown(本机没登记过)。
    // 页面导入后按它把素材小尺寸哈希写进 project.media[i].tiers.small;这不是同步状态(传没传完只问素材服务的 chunks)
    if (req.method === "GET" && req.url.startsWith("/api/media/tiers")) {
      const query = new URL(req.url, "http://promptcut.local").searchParams;
      const asked = (query.get("hashes") || "").split(",").map((h) => h.trim().toLowerCase()).filter(isMediaHash).slice(0, 200);
      try {
        const service = await mediaTierService(root, { withQueue: true });
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ ok: true, items: service.manager.status(asked) }));
      } catch (err) {
        res.statusCode = 500;
        return res.end(err instanceof Error ? err.message : String(err));
      }
    }

    // GET /api/media/upload-queue —— 上传队列的状态(诊断、探针);POST …/target { base, ticket? } —— 换上传目标;
    // POST …/enqueue { items: [{ name?, original, small? }] } | { hashes } —— 按哈希把本地内容库里已有的素材进队
    // (C10a:开启「放云端」时项目里已有的素材也要上云;只收本地有的,回 queued / missing,见 upload-queue.mjs 的 enqueueLocalMedia)
    if (req.url.startsWith("/api/media/upload-queue")) {
      try {
        const service = await mediaTierService(root, { withQueue: true });
        if (req.method === "POST" && req.url.split("?")[0] === "/api/media/upload-queue/enqueue") {
          const body = await readJsonBody(req);
          res.setHeader("Content-Type", "application/json");
          if (!service.queue) return res.end(JSON.stringify({ ok: false, error: "no-queue" }));
          const { enqueueLocalMedia }: any = await import("./upload-queue.mjs");
          const r = await enqueueLocalMedia(service.queue, body, (hash: string) => resolveHashFile(root, hash), {
            getTiers: (hash: string) => service.manager.status([hash])[hash],
            isLocal: () => !service.target(),
          });
          tiersLog("upload.enqueue-existing", { queued: r.queued.length, deferred: r.deferred?.length ?? 0, missing: r.missing.length, bad: r.bad, local: r.local });
          return res.end(JSON.stringify({ ok: true, ...r }));
        }
        if (req.method === "GET" && req.url.split("?")[0] === "/api/media/upload-queue") {
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ ok: true, target: service.target(), queue: service.queue ? service.queue.stats() : null }));
        }
        if (req.method === "POST" && req.url.split("?")[0] === "/api/media/upload-queue/target") {
          const body = await readJsonBody(req);
          const base = body?.base === null || body?.base === undefined ? null : String(body.base);
          if (base !== null && !/^https?:\/\//i.test(base)) { res.statusCode = 400; return res.end("base must be http(s) or null"); }
          const ticket = typeof body?.ticket === "string" ? body.ticket : null;
          const context = mediaContext.getStore();
          if (base && context) {
            const checked = await context.verifyRemoteTarget?.(req, { base, ticket });
            if (checked?.projectId !== context.projectId || checked.base !== base) return sendJson(res, 403, { ok: false, error: "project-mismatch" });
          }
          await service.setTarget({ base, ticket });
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ ok: true }));
        }
        // POST /api/media/upload-queue/cancel | DELETE /api/media/upload-queue[/<hash>] —— 撤回在途分片并从队列移除、删掉本机未登记的代下文件
        if ((req.method === "POST" && req.url.split("?")[0] === "/api/media/upload-queue/cancel") ||
            (req.method === "DELETE" && req.url.startsWith("/api/media/upload-queue"))) {
          res.setHeader("Content-Type", "application/json");
          if (!service.queue) return res.end(JSON.stringify({ ok: false, error: "no-queue" }));
          let targets: string[] = [];
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            if (Array.isArray(body?.hashes)) targets = body.hashes.map((h: any) => String(h).toLowerCase()).filter(Boolean);
            else if (typeof body?.hash === "string" && body.hash) targets = [body.hash.toLowerCase()];
          } else {
            const sub = req.url.split("?")[0].replace(/^\/api\/media\/upload-queue\/?/, "");
            if (sub && isMediaHash(sub.toLowerCase())) targets = [sub.toLowerCase()];
            else {
              const query = new URL(req.url, "http://promptcut.local").searchParams;
              const q = query.get("hashes")?.split(",").map((h) => h.trim().toLowerCase()).filter(isMediaHash);
              if (q?.length) targets = q;
            }
          }
          const r = await service.queue.cancel(targets.length ? targets : undefined);
          const cleaned: string[] = [];
          // 删掉从队列里撤回的在途/排队文件（已完整传完出队的文件不删，见 10-14 第 180 行）
          for (const cancelledId of r.cancelled) {
            const h = cancelledId.includes(":") ? cancelledId.split(":").pop()! : cancelledId;
            if (isMediaHash(h)) {
              const filePath = await resolveHashFile(root, h);
              if (filePath) {
                try { await fs.rm(filePath, { force: true }); } catch { /* 忽略删除错 */ }
                await forgetMediaIndex(root, h);
                cleaned.push(h);
              }
            }
          }
          tiersLog("upload.cancel", { cancelled: r.cancelled.length, cleaned: cleaned.length });
          return res.end(JSON.stringify({ ok: true, cancelled: r.cancelled, cleaned }));
        }
      } catch (err) {
        res.statusCode = 400;
        return res.end(err instanceof Error ? err.message : String(err));
      }
    }

    // C6.6:当前连接的远程素材服务、预取清单、导出前的素材原尺寸检查
    if (req.url.startsWith("/api/media/remote") || req.url.startsWith("/api/media/prefetch") || req.url.startsWith("/api/media/originals")) {
      if (await handlePullApi(req, res, root)) return;
    }

    // GET /api/media/local?hashes=a,b —— 这些哈希里哪些已经在本地内容库
    if (req.method === "GET" && req.url.startsWith("/api/media/local")) {
      const query = new URL(req.url, "http://promptcut.local").searchParams;
      const asked = (query.get("hashes") || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      const have = await localHashes(root, asked);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: true, hashes: have }));
    }

    // GET / HEAD /api/media/file?path=<legacy absolute path>(HEAD 给帧管线打戳用,见 server/media-stamp.mjs)
    if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/api/media/file")) {
      return handleMediaFile(req, res, root);
    }

    // GET /@media/<hash>/pcm?start=&count=&sampleRate=&ch=2 —— 音频素材效果卡的素材输入。
    // 一定要排在下面 /@media/<文件名> 那支之前:那支用 .split("/").pop() 取名,
    // 取到的会是 "pcm",取到了就直接 serveFile,这条路由永远轮不上。
    if (req.method === "GET") {
      const pcm = PCM_URL.exec(req.url.split("?")[0]);
      if (pcm) return handleMediaPcm(req, res, root, pcm[1]);
    }

    // GET /@media/<hash> | /@media/<hash>.<ext> | /@media/<文件名>(迁移期)
    if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/@media/")) {
      const rawName = req.url.split("?")[0].split("/").pop();
      if (rawName) {
        let decoded = rawName;
        try { decoded = decodeURIComponent(rawName); } catch { /* 原样 */ }
        const name = sanitizeFilename(decoded);
        const hashed = HASH_URL.exec(name);
        if (hashed) {
          const file = await resolveHashFile(root, hashed[1].toLowerCase(), hashed[2]);
          if (file) return serveFile(file, req, res);
          // C6.6 按需拉取:本地内容库没有,就向当前连接的远程素材服务流式拉、边落盘边服务;没连远程才直接 404
          let mod: any = await pullModule();
          if (mod && projectScope(root)) mod = mod.projectMediaPull(mediaContext.getStore());
          if (mod && await mod.pullThrough({ hash: hashed[1].toLowerCase(), req, res, store: pullStore(root), serveFile: (f: string) => serveFile(f, req, res) })) return;
          res.statusCode = 404;
          return res.end("Not found");
        }
        return serveFile(path.resolve(mediaDir(root), name), req, res);
      }
    }

    next();
  };
  return async function media(req: Connect.IncomingMessage, res: ServerResponse, next: () => void) {
    const pathname = String(req.url ?? "").split("?")[0];
    // `/oauth2callback` 不在前两个前缀里,但必须由这里接:它是网盘连接器 A2 的授权弹窗落地页,
    // 地址要和 Google 控制台登记的重定向 URI 逐字一致,改不了前缀。漏掉它就被 vite 的 SPA 兜底
    // 接走、弹窗里渲染出整个编辑器,授权码永远回不到开它的页面(2026-10-24 真这么踩过)。
    if (!pathname.startsWith("/@media/") && !pathname.startsWith("/api/media/") && pathname !== OAUTH_CALLBACK_PATH) return next();
    let context = (req as any)[Symbol.for("promptcut.asset.request.v2")];
    try {
      if (!context && options.projectAccess) {
        const lease = await options.projectAccess.resolve(req, { action: ["GET", "HEAD"].includes(req.method ?? "GET") ? "read" : "write", resource: { ns: "media", route: pathname }, close: () => { req.destroy(); res.destroy(); } });
        context = { ...options.projectStores.project(lease.projectId), lease, verifyRemoteTarget: options.verifyRemoteTarget };
        Object.defineProperty(req, Symbol.for("promptcut.asset.request.v2"), { value: context, configurable: true });
        res.once("finish", () => lease.release());
        res.once("close", () => lease.release());
      }
      if (context) {
        context.verifyRemoteTarget ??= options.verifyRemoteTarget;
        await context.lease.assert();
        if (!["GET", "HEAD"].includes(req.method ?? "GET") && context.lease.principal.access !== "rw") return sendJson(res, 403, { ok: false, error: "forbidden" });
        if (context.lease.principal.service && context.lease.principal.actsFor !== "member" && !["GET", "HEAD"].includes(req.method ?? "GET")) return sendJson(res, 403, { ok: false, error: "forbidden" });
      }
      await mediaContext.run(context ?? null, () => local(req, res, next, context?.root ?? root));
    } catch (err: any) { if (!res.destroyed) sendJson(res, err?.status ?? 500, { ok: false, error: err?.code ?? "media-failed" }); }
  };
}

export function mediaPlugin(): Plugin {
  return {
    name: "vite-plugin-media",
    async configureServer(server) {
      const root = server.config.root;
      // 素材服务(第 5 步:分片上传、对账、按哈希取回、跨源)排在老路由前面:它先给 /@media/*
      // 补上 CORS 头、答预检,不归它管的请求再交给下面的 mediaMiddleware。
      // **惰性 import**:好几个单测把本文件单独转译到临时目录再 import,静态 import 兄弟模块会解析失败。
      const { assetServiceMiddleware, assetPreflightMiddleware } = await import("./asset-service");
      // 预检要抢在 vite 自带的 cors 中间件前面答(它不认局域网的源),理由见 assetPreflightMiddleware
      server.middlewares.stack.unshift({ route: "", handle: assetPreflightMiddleware() as Connect.NextHandleFunction });
      const { rememberLocalAssetOrigin } = await import("./asset-client");
      rememberLocalAssetOrigin(server.httpServer);
      const asset = assetServiceMiddleware(root);
      const handler = mediaMiddleware(root);
      server.middlewares.use((req, res, next) => { void asset(req, res, () => { void handler(req, res, next); }); });

      // 两档素材与上传队列(C6.6):只在编辑器进程(ui)里跑。预渲染进程不导入素材。
      const { isPrerender } = await import("./render-role.mjs");
      if (!isPrerender) {
        void mediaTierService(root).then((service) => {
          service.manager.resume();
          service.queue?.start();
          server.httpServer?.once("close", () => { void service.queue?.stop(); });
        }).catch((err) => tiersLog("tiers.start-failed", { message: err instanceof Error ? err.message : String(err) }));
      }

      // 素材服务地址登记(C5 / D7,`docs/plan/asset-store-contract.md` 第 5 节):监听的不是回环、
      // 又设了 PROMPTCUT_DOCSERVICE_URL,才把本机素材服务的局域网地址报给文档服务。
      // 任何一步出错只打日志,不影响编辑器启动。令牌只交给 WebSocket 端点,不进日志。
      const docservice = process.env.PROMPTCUT_DOCSERVICE_URL;
      const httpServer = server.httpServer;
      if (docservice && httpServer) {
        const announce = async () => {
          try {
            const bound = httpServer.address();
            if (!bound || typeof bound === "string") return;
            const host = String(bound.address || "").toLowerCase();
            if (host === "::1" || /^127\./.test(host) || /^::ffff:127\./.test(host)) return; // 只在本机回环上听,局域网连不进来
            const { lanAssetUrls, startAssetAnnounce } = await import("./asset-announce.mjs");
            let urls: string[] = lanAssetUrls({ port: bound.port });
            // 绑在某一个具体地址上时,别的网卡连不进来,只报这一个
            if (host !== "0.0.0.0" && host !== "::" && host !== "") urls = urls.filter((u) => new URL(u).hostname === host);
            const handle = startAssetAnnounce({
              url: docservice,
              token: process.env.PROMPTCUT_CLUSTER_TOKEN || null,
              urls,
              log: (event: string, fields: object) => {
                // 会话端点的重试日志太密,只留会话建成、结束、传输脱开与接续和本模块自己的
                if (event.startsWith("asset-announce.") || event === "session.open" || event === "session.close" || event === "session.detach" || event === "session.resume") console.info("[asset-announce]", event, JSON.stringify(fields));
              },
            });
            httpServer.once("close", () => {
              try { handle.stop(); } catch (err) { console.warn("[asset-announce] 撤回失败", err instanceof Error ? err.message : String(err)); }
            });
          } catch (err) {
            console.warn("[asset-announce] 地址登记没有启动", err instanceof Error ? err.message : String(err));
          }
        };
        if (httpServer.listening) void announce();
        else httpServer.once("listening", () => { void announce(); });
      }
    }
  };
}
