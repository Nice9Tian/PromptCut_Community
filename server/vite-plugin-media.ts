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
 * Authorization popup landing page for cloud drive connector A2.
 *
 * It is not located under `/api/media/` because this URL must match verbatim the redirect URI
 * registered in the Google Console: changing the prefix would require updating the console at the
 * same time, and console changes "may take 5 minutes to a few hours to take effect". Therefore, the
 * middleware's main entry point intentionally lets it through; see the prefix filter in `media()`
 * below.
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

/**
 * Read-only trusted factory registry; HTTP fields cannot register root, and bundled instances
 * share the same directory identity.
 */
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

/**
 * System error codes for "file not found"; others (no permission, device error) indicate read
 * failures, not non-existence.
 */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
/**
 * Status verdicts returned to the page by the asset read endpoint: `absent` = the file definitely
 * does not exist; `outside` = the path is outside the asset catalog, this endpoint will not serve it.
 */
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
      // When the page determines whether it "can be retrieved locally", it must distinguish: this is
      // "this path is not in the asset catalog, this endpoint will never serve it", not a read failure
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
 * Asset disk storage directory. Both uploads and media collection (vite-plugin-collect) write here,
 * so /@media/<filename> can retrieve files from both sides.
 *
 * Since A1, this is also the **local content store**: imported assets are stored as
 * `<sha256>.<originalExt>`, with only one file per identical content: importing again after
 * modifying mtime or changing the filename still yields the same key.
 */
export function mediaDir(root: string): string {
  return path.resolve(outRoot(root), "media");
}

/* ------------------------------------------------------------------ *
 * Content hash and local content store
 * ------------------------------------------------------------------ */

/** 64-char hex, optional extension: both /@media/<hash> and /@media/<hash>.<ext> are recognized */
const HASH_URL = /^([0-9a-fA-F]{64})(?:\.([A-Za-z0-9]+))?$/;

export function isMediaHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(String(value || "").toLowerCase());
}

/** File extension in the filename (without dot, lowercase). Returns an empty string if none */
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

/** Extension → Content-Type. Defaults to application/octet-stream if unrecognized */
export function contentTypeForExt(ext: string): string {
  return CONTENT_TYPES[String(ext || "").toLowerCase().replace(/^\./, "")] || "application/octet-stream";
}

export function contentTypeForFile(filePath: string): string {
  return contentTypeForExt(extOfName(filePath));
}

/**
 * Content-Type → extension (reverse lookup in the table above, taking the first match for the same
 * type); returns an empty string if unrecognized. Used when writing to disk during on-demand pull.
 */
export function extForContentType(contentType: string): string {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  for (const [ext, t] of Object.entries(CONTENT_TYPES)) if (t === type) return ext;
  return "";
}

export interface MediaIndexEntry {
  /** Filename in the local content store (<hash>.<ext>) */
  file: string;
  /** Original filename at import time, only used for display and restoration in .procp */
  name?: string;
  ext?: string;
  size?: number;
  contentType?: string;
}

type MediaIndex = Record<string, MediaIndexEntry>;

/**
 * Index file: out/media/index.json. Not fatal if lost: falls back to scanning the directory if
 * not found.
 */
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
  } catch { /* Missing index defaults to an empty index */ }
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
    console.warn("[media] Failed to write index", err);
  }
}

/**
 * Remove an entry from the index (the file was deleted, e.g. the pre-remux copy); does nothing if
 * absent.
 */
export async function forgetMediaIndex(root: string, hash: string): Promise<void> {
  const index = await readMediaIndex(root);
  if (!(hash in index)) return;
  delete index[hash];
  try {
    await fs.writeFile(indexPath(root), JSON.stringify({ version: 1, items: index }, null, 2));
  } catch (err) {
    console.warn("[media] Failed to write index", err);
  }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true; } catch { return false; }
}

/**
 * Hash → file in the local content store. Three paths: URL with extension → index → directory scan
 * (recoverable if the index is lost). Returns null if not found (the read route then hands over to
 * on-demand pull; see server/media-pull.mjs).
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
      // If missing from the index, backfill it on the spot so scanning is not needed next time
      indexCache.set(root, { ...index, [key]: { file: hit, ext: extOfName(hit), contentType: contentTypeForFile(hit) } });
      return path.join(dir, hit);
    }
  } catch { /* Directory does not exist yet */ }
  return null;
}

/* ------------------------------------------------------------------ *
 * On-demand pull and prefetch (C6.6 Section 4, implemented in server/media-pull.mjs)
 * ------------------------------------------------------------------ */

/**
 * Operations provided by the local content store to the pull module: unaware of directory layout,
 * it writes to disk and stores into the library only through here.
 */
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
          // Rename blocked (read handle without shared delete on Windows): make a copy, delete temp file later
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
 * Lazy-load the pull module: several unit tests transpile this file alone into a temporary
 * directory before importing, so static imports of sibling modules fail to resolve; if unavailable,
 * treat as no on-demand pull (returns 404 as before).
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
 * Routes managed by the page (same-origin, `/api/**` guard as usual):
 * - `POST /api/media/remote { base, ticket }`: set currently connected remote asset service (null /
 *   DELETE clears it); `GET` inspects status;
 * - `POST /api/media/prefetch { items: [{ hash }] }`: replace with a new prefetch manifest
 *   (ordered);
 * - `POST /api/media/originals { hashes }`: which of these original-size assets are not yet
 *   `complete` on the current asset service (interception before export).
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

/**
 * Which of these hashes are already fully stored in the local content store (the prefetch queue in
 * A1 step 5 queries this same endpoint).
 */
export async function localHashes(root: string, hashes: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of hashes) {
    if (!isMediaHash(h)) continue;
    if (await resolveHashFile(root, h)) out.push(h.toLowerCase());
  }
  return out;
}

/** Compute sha256 once for files already on disk (streaming, constant memory) */
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
  /** Absolute path in the local content store */
  path: string;
  /** Asset URL: identity is the hash, without extension */
  url: string;
  contentType: string;
  /**
   * Identical content already existed in the store prior to this (different mtime / filename still
   * counts as the same copy).
   */
  deduped: boolean;
}

/**
 * **Compute hash while writing to disk**: the request body is piped all the way to a temporary
 * file, updating sha256 with each chunk on the fly, with constant memory throughout: a 4 GB video
 * never stays in memory in its entirety at any point, and no long-running task blocks the event
 * loop (each chunk's tens of KiB `hash.update` takes tens of microseconds), so the main service
 * can still answer other requests within 100 ms during import. Only after computation finishes is
 * it renamed to `<hash>.<ext>` and stored: if identical content already exists in the store, delete
 * the temporary file directly (deduplication); importing the same content twice yields the same
 * key.
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
  try { decoded = decodeURIComponent(decoded); } catch { /* Keep as is if not %xx */ }
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
 * Backfill the content key for a file that is **already in the asset catalog** (such as one
 * downloaded via media collection).
 *
 * That path bypasses upload since the file is already on the server side, making a browser POST of
 * hundreds of megabytes a complete waste; however, without a key it cannot enter `.procp` or
 * benefit from cross-machine deduplication. Therefore, compute sha256 via streaming on the server
 * side in place (`hashFile`, constant memory, does not block the event loop), and attach it into
 * the content store: try hard links first (takes zero additional bytes on the same volume), copying
 * only as fallback. The original file remains in place untouched: the media collection side may
 * still be referencing it by its original name.
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
 * Two-tier assets and upload queue (C6.6, Sections 2 and 3 of docs/plan/c66-design.md)
 * ------------------------------------------------------------------ */

/**
 * One per project root: two-tier manager (`media-tiers.mjs`), upload queue (`upload-queue.mjs`),
 * and currently connected asset service. Stored on `globalThis`: configuration has been bundled
 * once, and modules may have two instances.
 *
 * **Currently connected asset service** (target of the upload queue):
 *   - Defaults to the local asset service (this plugin itself): imports are already local writes,
 *     so the upload queue is a no-op;
 *   - Uses `PROMPTCUT_ASSET_URL` (formatted like `http://192.168.50.96:5460/api/asset`, sharing
 *     the same variable used by prerender process pushes) if set;
 *   - Changed via `POST /api/media/upload-queue/target` by the page (the party connected to a
 *     shared project and aware of remote asset service and tickets); `{ base: null }` reverts to
 *     default (`PROMPTCUT_ASSET_URL` if set, otherwise local). Tickets are renewed periodically
 *     by the page (asset tickets last 15 minutes; see Section 8 of `docs/plan/auth-contract.md`).
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
 * Get (or create if necessary) the two-tier service for this root. `withQueue: false` only
 * generates two tiers without creating an upload queue. Lazy import: several unit tests transpile
 * this file alone into a temporary directory, where static imports of sibling modules would fail
 * to resolve.
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
      // Tickets only go into the Authorization header (client's responsibility) and are not recorded here
      const client = createAssetClient({ base, ticket: () => ticketValue, timeoutMs: 120_000 });
      current = { base, client, ...(ownership ? { projectId: ownership.projectId } : {}) };
      tiersLog("upload.target", { base });
    };
    /*
     * After card snapshots (rendered in the editor process via the hot-standby renderer's
     * `ui-render/bake-batch`) are written into the local asset service, push a copy to the currently
     * connected asset service (`bake-store.mjs`); when connected locally, `current` is null and does
     * not push. Lazy import, for the same reason as above.
     */
    if (withQueue && !ownership) {
      try {
        const { setBakeRemote }: any = await import("./bake-store.mjs");
        setBakeRemote(() => (current ? { base: current.base, put: (ns: string, bytes: Buffer, o?: any) => current!.client.put(ns, bytes, o) } : null));
      } catch { /* Do not push if absent */ }
    }
    if (withQueue) {
      const { createUploadQueue }: any = await import("./upload-queue.mjs");
      const { sharedBandwidthGate, pushQueueFileProbe }: any = await import("./bandwidth-gate.mjs");
      const gate = sharedBandwidthGate();
      // Push queue is in the prerender process: read its on-disk queue file to determine
      // "artifacts are still being pushed" (header of `bandwidth-gate.mjs`)
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
      // `{ base: null }` (page leaves shared project / this machine is the host) = return to default target:
      // use PROMPTCUT_ASSET_URL if set, otherwise this machine
      setTarget: (next) => setTargetImpl(next?.base ? next : { base: envBase || null, ticket: null }),
      target: () => (current ? { base: current.base } : null),
    };
  })();
  services.set(key, pending);
  pending.catch(() => services.delete(key));
  return pending;
}

/** After import (`?tiers=1`): determine video remux, queue small-size asset; response fields */
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
        // Issues with both tiers do not block import: respond as before,
        // with only the original-size asset tier
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
 * GET /@media/<hash>/pcm: media input for audio media effect cards
 * ------------------------------------------------------------------ */

/** Hash in route. Must be placed before /@media/<filename>, otherwise `.pop()` extracts "pcm" */
const PCM_URL = /^\/@media\/([^/?]+)\/pcm$/;
const PCM_MAX_FRAMES = 1048576;
const PCM_CHANNELS = 2;
const PCM_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Where ffmpeg is. Resolved **lazily**: loading vite config should not pull in the entire
 * server/bakery, and the tests in server/test that transpile this plugin to a temp directory
 * and then import it must not fail resolution because of this.
 */
async function ffmpegCommand(): Promise<string> {
  const { findFfmpeg } = await import("./bakery/ffmpeg.mjs");
  return findFfmpeg();
}

/** commandBuffer from card-service.mjs:47. Collect child process stdout to Buffer, kill if over budget */
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
 * A PCM slice of an asset (interleaved f32le, always 2 channels). Moved from
 * `card-service.mjs:308-313`: parameter validation moved as well, but instead of writing `.bin`
 * back to a descriptor, bytes are returned directly.
 *
 * **No `offset` parameter**: `clip.mediaOffset + edge.offset` is converted once by the page
 * into `start`. So on the server `position = start`, which can be negative (padded with leading
 * silence); padded with trailing zeros when the asset is shorter than requested.
 */
async function handleMediaPcm(req: Connect.IncomingMessage, res: ServerResponse, root: string, hash: string) {
  try {
    const query = new URL(req.url || "/", "http://promptcut.local").searchParams;
    // Missing parameters cannot be treated as 0: Number(null) is 0,
    // omitting start silently trims from the beginning
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
    // Pad trailing zeros when the asset is shorter than requested;
    // when position is negative, leading frames are silence
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
 * Parse Range header. Only accepts single-range `bytes=a-b` / `bytes=a-` / `bytes=-n` (suffix);
 * returns null if unrecognized (treated as without Range, returns whole file 200),
 * and returns "unsatisfiable" (returns 416) if falling outside the file.
 * Ends exceeding the file are clamped to the last byte per RFC 9110.
 * Valid `bytes=a-b` behaves byte-for-byte identical to the original behavior.
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
 * Send a file (whole file or a Range).
 *
 * Open the file first, get its size on this handle, and read from the same handle: previously it
 * ran `stat` first then opened a read stream by path. If the file disappeared between the two steps
 * (assets cleared, content store directory changed, files deleted in tests), nothing caught the
 * read stream `error`, crashing the entire editor process: all subsequent requests on the page
 * became `Failed to fetch`.
 * Now returns 404 if it cannot be opened; if deleted after opening, the handle can still be read
 * to completion; errors midway only abort this single response.
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
    // Last-Modified: for migration-period assets without a content hash, the frame pipeline stamps
    // based on `HEAD` Content-Length + Last-Modified (server/media-stamp.mjs),
    // instead of stat-ing this directory itself
    const lastModified = stat.mtime.toUTCString();
    const send = (opts?: { start: number; end: number }) => {
      const stream = handle!.createReadStream(opts); // Stream closes the handle itself on completion or error
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
    // Only return 404 when "the file genuinely does not exist"; return 500 for no read permission,
    // disk errors, etc.: the page uses this to determine missing assets, and read failures must not be
    // reported as nonexistent
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
 * Media routes. Exported separately from the plugin itself, so unit tests can run it mounted
 * directly on a bare http server (Range/206, hash URL contentType, and filename fallbacks
 * are all at this layer).
 */
export interface ProjectMediaOptions { projectAccess?: any; projectStores?: any; verifyRemoteTarget?: (req: Connect.IncomingMessage, target: any) => Promise<any> }
export function mediaMiddleware(root: string, options: ProjectMediaOptions = {}) {
  if (!!options.projectAccess !== !!options.projectStores) throw new TypeError("projectStores and projectAccess required together");
  const local = async function scopedMedia(req: Connect.IncomingMessage, res: ServerResponse, next: () => void, root: string) {
    if (!req.url) return next();

    // POST /api/media/upload/<filename>: streaming persist to disk + content hash
    if (req.method === "POST" && req.url.startsWith("/api/media/upload/")) {
      return handleMediaUpload(req, res, root);
    }

    // POST /api/media/adopt: backfill content keys for existing files in the asset catalog
    // (such as downloads from media collection)
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
        // File genuinely absent: explicitly return 404 (other failures return 500 as usual),
        // so the page can distinguish between "missing" and "failed to read"
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
            // If the copy hard-linked into the store needs remuxing: save the remux result as a separate copy
            // and delete the one in the store as usual (the file at the original location is untouched,
            // and media collection still references it by its original name)
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

    // GET /api/media/storage/config: public parameters from the cloud drive connector for the page
    // (task brief docs/plan/drive-connector-task.md section 5).
    // If env vars are not set, return configured: false; UI grays out the entry with an explanation,
    // without throwing an error.
    if (req.method === "GET" && req.url.split("?")[0] === "/api/media/storage/config") {
      const { buildExtensions }: any = await import("./vite-plugin-hosted-gate");
      const storageConfig = buildExtensions.mediaStorage?.storageConfig;
      if (typeof storageConfig !== "function") return next();
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(storageConfig()));
    }

    // GET /oauth2callback: authorization popup landing page for A2: sends auth code back
    // to the opening page via postMessage, then closes itself.
    // This address must match byte-for-byte with the redirect URI registered in Google Console;
    // the prefix filter at the main entry point above must also let it through.
    if (req.method === "GET" && req.url.split("?")[0] === OAUTH_CALLBACK_PATH) {
      const { buildExtensions }: any = await import("./vite-plugin-hosted-gate");
      const callbackHtml = buildExtensions.mediaStorage?.callbackHtml;
      if (typeof callbackHtml !== "function") return next();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // The auth code is in the address bar; do not let it enter any cache
      res.setHeader("Cache-Control", "no-store");
      return res.end(callbackHtml());
    }

    // Four endpoints of the cloud drive connector (task brief section 5). A3 passes the one-time
    // token in with import; A2 connects first, then imports (without token).
    // Tokens and auth codes are pass-through only: not written to disk, not logged, not in responses.
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

    // POST /api/media/tiers/backfill { items: [{ hash, name? }] }: backfill small-size assets when
    // opening project (C6.6 design doc section 9 item 2):
    // videos with this original-size asset in local content store are queued for background transcoding,
    // returning { ok, items: { [hash]: { state, small? } } };
    // if original-size asset is not present locally, return state: 'absent'
    // (do not pull original-size asset just to transcode small-size asset)
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

    // GET /api/media/tiers?hashes=a,b: small-size asset status for these original-size assets (C6.6):
    // { ok, items: { [originalHash]: { state, small? } } }.
    // state: pending (transcoding), ready (small is small-size asset hash), failed,
    // none (no video stream), unknown (not registered locally).
    // After import, the page writes the small-size asset hash into project.media[i].tiers.small based
    // on it; this is not sync status (whether upload completed is only queried via asset service chunks)
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

    // GET /api/media/upload-queue: upload queue status (diagnostics, probe);
    // POST …/target { base, ticket? }: switch upload target;
    // POST …/enqueue { items: [{ name?, original, small? }] } | { hashes }:
    // enqueue existing assets from local content store by hash
    // (C10a: when "move to the cloud" is enabled, existing assets in project must also go to cloud;
    // only accepts local ones, returns queued / missing, see enqueueLocalMedia in upload-queue.mjs)
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
        // POST /api/media/upload-queue/cancel | DELETE /api/media/upload-queue[/<hash>]:
        // abort in-flight chunks, remove from queue, and delete files downloaded on behalf
        // not registered on this machine
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
          // Delete in-flight/queued files cancelled from the queue
          // (do not delete files dequeued after full upload, see 10-14 line 180)
          for (const cancelledId of r.cancelled) {
            const h = cancelledId.includes(":") ? cancelledId.split(":").pop()! : cancelledId;
            if (isMediaHash(h)) {
              const filePath = await resolveHashFile(root, h);
              if (filePath) {
                try { await fs.rm(filePath, { force: true }); } catch { /* Ignore delete errors */ }
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

    // C6.6: currently connected remote asset service, prefetch manifest,
    // original-size asset check before export
    if (req.url.startsWith("/api/media/remote") || req.url.startsWith("/api/media/prefetch") || req.url.startsWith("/api/media/originals")) {
      if (await handlePullApi(req, res, root)) return;
    }

    // GET /api/media/local?hashes=a,b: which of these hashes are already in the local content store
    if (req.method === "GET" && req.url.startsWith("/api/media/local")) {
      const query = new URL(req.url, "http://promptcut.local").searchParams;
      const asked = (query.get("hashes") || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      const have = await localHashes(root, asked);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: true, hashes: have }));
    }

    // GET / HEAD /api/media/file?path=<legacy absolute path>
    // (HEAD is for frame pipeline stamping, see server/media-stamp.mjs)
    if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/api/media/file")) {
      return handleMediaFile(req, res, root);
    }

    // GET /@media/<hash>/pcm?start=&count=&sampleRate=&ch=2: media input for audio media effect cards.
    // Must be placed before the /@media/<filename> branch below: that branch extracts the name
    // with .split("/").pop(), which would get "pcm", and directly calls serveFile,
    // so this route would never be reached.
    if (req.method === "GET") {
      const pcm = PCM_URL.exec(req.url.split("?")[0]);
      if (pcm) return handleMediaPcm(req, res, root, pcm[1]);
    }

    // GET /@media/<hash> | /@media/<hash>.<ext> | /@media/<filename> (migration period)
    if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/@media/")) {
      const rawName = req.url.split("?")[0].split("/").pop();
      if (rawName) {
        let decoded = rawName;
        try { decoded = decodeURIComponent(rawName); } catch { /* As is */ }
        const name = sanitizeFilename(decoded);
        const hashed = HASH_URL.exec(name);
        if (hashed) {
          const file = await resolveHashFile(root, hashed[1].toLowerCase(), hashed[2]);
          if (file) return serveFile(file, req, res);
          // C6.6 on-demand pull: if not in local content store, stream pull from the currently connected
          // remote asset service, serving while writing to disk;
          // only return 404 directly when not connected to remote
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
    // `/oauth2callback` is not in the first two prefixes, but must be handled here: it is the
    // authorization popup landing page for cloud drive connector A2; the address must match
    // byte-for-byte with the redirect URI registered in Google Console, so the prefix cannot be changed.
    // Missing it causes vite's SPA fallback to catch it, rendering the entire editor in the popup,
    // and the auth code will never return to the page that opened it (actually hit this on 2026-10-24).
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
      // Asset service (step 5: chunked upload, reconcile, retrieve by hash, cross-origin) is placed
      // before legacy routes: it first adds CORS headers to /@media/* and answers preflight,
      // passing requests not handled by it to mediaMiddleware below.
      // **Lazy import**: several unit tests transpile this file separately to a temporary directory
      // and then import it; static imports of sibling modules would fail to resolve.
      const { assetServiceMiddleware, assetPreflightMiddleware } = await import("./asset-service");
      // Preflight must be answered before vite's built-in cors middleware (it does not recognize
      // LAN origins), see assetPreflightMiddleware for reasons
      server.middlewares.stack.unshift({ route: "", handle: assetPreflightMiddleware() as Connect.NextHandleFunction });
      const { rememberLocalAssetOrigin } = await import("./asset-client");
      rememberLocalAssetOrigin(server.httpServer);
      const asset = assetServiceMiddleware(root);
      const handler = mediaMiddleware(root);
      server.middlewares.use((req, res, next) => { void asset(req, res, () => { void handler(req, res, next); }); });

      // Two-tier assets and upload queue (C6.6): only run in the editor process (ui).
      // Prerender process does not import assets.
      const { isPrerender } = await import("./render-role.mjs");
      if (!isPrerender) {
        void mediaTierService(root).then((service) => {
          service.manager.resume();
          service.queue?.start();
          server.httpServer?.once("close", () => { void service.queue?.stop(); });
        }).catch((err) => tiersLog("tiers.start-failed", { message: err instanceof Error ? err.message : String(err) }));
      }

      // Asset service address registration (C5 / D7, docs/plan/asset-store-contract.md section 5):
      // only report local asset service LAN address to document service if listening on non-loopback
      // and PROMPTCUT_DOCSERVICE_URL is set.
      // Errors at any step are only logged and do not affect editor startup.
      // Tokens are only handed to WebSocket endpoint and not logged.
      const docservice = process.env.PROMPTCUT_DOCSERVICE_URL;
      const httpServer = server.httpServer;
      if (docservice && httpServer) {
        const announce = async () => {
          try {
            const bound = httpServer.address();
            if (!bound || typeof bound === "string") return;
            const host = String(bound.address || "").toLowerCase();
            if (host === "::1" || /^127\./.test(host) || /^::ffff:127\./.test(host)) return; // Only listening on local loopback, LAN cannot connect
            const { lanAssetUrls, startAssetAnnounce } = await import("./asset-announce.mjs");
            let urls: string[] = lanAssetUrls({ port: bound.port });
            // When bound to a specific address, other network interfaces cannot connect; report only this one
            if (host !== "0.0.0.0" && host !== "::" && host !== "") urls = urls.filter((u) => new URL(u).hostname === host);
            const handle = startAssetAnnounce({
              url: docservice,
              token: process.env.PROMPTCUT_CLUSTER_TOKEN || null,
              urls,
              log: (event: string, fields: object) => {
                // Session endpoint retry logs are too dense: keep only session established, ended,
                // transport detach and resume, and this module's own
                if (event.startsWith("asset-announce.") || event === "session.open" || event === "session.close" || event === "session.detach" || event === "session.resume") console.info("[asset-announce]", event, JSON.stringify(fields));
              },
            });
            httpServer.once("close", () => {
              try { handle.stop(); } catch (err) { console.warn("[asset-announce] Withdraw failed", err instanceof Error ? err.message : String(err)); }
            });
          } catch (err) {
            console.warn("[asset-announce] Address registration did not start", err instanceof Error ? err.message : String(err));
          }
        };
        if (httpServer.listening) void announce();
        else httpServer.once("listening", () => { void announce(); });
      }
    }
  };
}
