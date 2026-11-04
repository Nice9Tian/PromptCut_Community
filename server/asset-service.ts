/**
 * Asset service: first version of the local asset service (`docs/semantics/product/asset-service.md`;
 * task brief `docs/plan/cloud-task.md` step 5, A1 "all uploads use chunks").
 *
 * It is hooked into the media plugin in the editor process (`mediaPlugin` in `vite-plugin-media.ts`).
 * This module only handles HTTP; all bytes are read and written through the data-layer interface
 * `BlobStore` (`server/asset-store/`, contract `docs/plan/asset-store-contract.md`);
 * defaults to fs implementation, with storage in the local content store `out/media` (`mediaDir`),
 * filename `<sha256>.<ext>`.
 * **Only the data layer and vite-plugin-media read and write that directory**; Agent processes and
 * prerender processes, like external clients, only fetch bytes through the HTTP API below
 * (see `asset-client.ts` for how addresses are determined).
 * Remote asset services (LAN NAS, public cloud) are not in this repository, but must implement the
 * same contract; clients only change the base URL.
 *
 * # Namespaces (C6.2, `docs/plan/artifact-transfer-contract.md` section 1)
 *
 * Routes are `/api/asset/<ns>/<hash>…`, `<ns>` ∈ `media` | `snap` | `px`; each of the three
 * namespaces has its own `BlobStore`, isolated from one another:
 * - `media`: assets, which is the system described in step 5 below, with unchanged behavior;
 *   legacy route `/@media/*` corresponds only to it.
 * - `snap`: HTML snapshot chunks; `px`: pixel artifacts (at this stage, track stream init `.mp4`
 *   and segment `.m4s`). Defaults to fs implementation, with directories
 *   `<root>/out/asset-store/snap` and `<root>/out/asset-store/px`; does not write a media index,
 *   and only locates files by `<hash>[.<ext>]`.
 * Subroutes, status codes, responses, chunking rules, cross-origin headers, and write authorization
 * are identical across all three namespaces; where `media/` is written below, simply replace it
 * with `<ns>/`.
 * Two places differ by namespace: finalize response `url` is `/@media/<hash>` for `media`, and
 * `/api/asset/<ns>/<hash>` for the other two; when reverse-looking up extensions from `X-Media-Type`,
 * `text/html → html` and `video/iso.segment → m4s` only apply to `snap` / `px`; the reverse lookup
 * table for `media` remains unchanged.
 * Fetching `px` has an extra on-demand pull step (claude/bake-asset): when this machine lacks this
 * chunk and the editor is connected to a shared project's remote asset service, it first fetches the
 * whole file once from the remote service, verifies it, stores it, and then responds (`pullArtifact`,
 * defaults to `fetchRemoteArtifact` in `media-pull.mjs`); if not connected to a remote service or
 * the remote service also lacks it, returns 404 as usual.
 * Card snapshots (textures for `bake_card` and 3D view, address `/api/asset/px/<hash>`) rely on this
 * to allow other members to fetch them as well.
 *
 * # API contract (step 5)
 *
 * Base URL `<origin>/api/asset`; paths below are relative to the base URL. The legacy read route
 * `/@media/<hash>` of the local asset service is equivalent to `GET media/<hash>` and also allows
 * cross-origin requests.
 *
 * ## Addressing by hash
 *
 * - `<hash>` is the **sha256 of the whole file content**, 64-character hex, **computed by the
 *   uploader on its end**; case-insensitive, server always stores in lowercase.
 * - Immutable after write, naturally deduplicated: only one copy is stored for the same hash.
 *
 * ## Chunked upload `PUT media/<hash>/<n>`
 *
 * - Chunk size is fixed at `chunkSize = 8 MiB` (8388608 bytes); chunk count is
 *   `count = max(1, ceil(size / chunkSize))`; assets smaller than 8 MiB are 1 chunk.
 *   There is no whole-file `PUT media/<hash>` path.
 * - `<n>` is a decimal chunk number, `0 ≤ n < count`, without leading zeros. Invalid format returns
 *   400, out of bounds returns 416.
 * - Request headers (**must be included with every chunk**; server does not rely on the "first
 *   chunk" to track state; out-of-order, concurrent, and resumed uploads are all treated the same):
 *   - `X-Media-Size: <whole file bytes>`: required, positive integer, maximum 64 GiB. Missing or not
 *     an integer returns 400; mismatch with registered size for this hash returns 409
 *     (`error: "size-mismatch"`).
 *   - `X-Media-Ext: <extension>` and / or `X-Media-Type: <MIME>`: optional, determines Content-Type
 *     when fetching. Extension takes precedence; when only MIME is provided, looks up extension via
 *     table; if neither is provided, defaults to no extension and `application/octet-stream`.
 *     **Whichever chunk provides it first takes precedence**, subsequent chunks do not change it.
 *   - `X-Media-Tier: small | original`: optional, whether this file is a small-size asset or
 *     original-size asset (2026-10-23, guest video count takes the maximum of original count and
 *     small-tier count, `asset-store/guest-quota.mjs`). Only recognizes `small`; missing,
 *     misspelled, or unrecognized values are all treated as `original`; as long as any chunk for
 *     the same hash does not specify `small`, it is recorded as `original`. Only affects guest
 *     video count; fetch and reconcile responses remain unchanged.
 *   - Request body `Content-Type` is ignored (typically `application/octet-stream`).
 * - Length: every chunk except the last must be exactly `chunkSize` bytes; the last chunk is
 *   `size - chunkSize × (count - 1)`. Mismatched `Content-Length` directly returns 400; receiving
 *   more or fewer bytes also returns 400, and this chunk is not counted as received.
 * - **Idempotent**: retransmitting the same chunk overwrites in place with newly arrived bytes,
 *   producing the same result; when this hash is already `complete`, any chunk returns 200 without
 *   writing to disk.
 * - Success returns 200 `{ ok: true, hash, n, bytes }`.
 *
 * ## Reconcile `GET media/<hash>/chunks`
 *
 * - Returns 200 `{ size, chunkSize, received: number[], complete }`. `received` in ascending order.
 * - Never-before-seen hash: `{ size: null, chunkSize, received: [], complete: false }`.
 * - Already stored (including those imported via legacy whole-file import):
 *   `{ size, chunkSize, received: [0..count-1], complete: true }`.
 * - This is the **single source of truth** for whether this tier has all chunks; resumed uploads
 *   only backfill chunks missing from `received`.
 *
 * ## Finalize `POST media/<hash>/complete`
 *
 * - If chunks are incomplete, returns 400 `{ error: "incomplete", missing: number[] }`; already
 *   received chunks remain untouched.
 * - Once all chunks are present, computes sha256 on the whole file in order: if it does not match
 *   `<hash>`, returns **409** `{ error: "hash-mismatch", actual }`, and **discards all received
 *   chunks for this hash** (cannot tell which chunk is corrupt); afterwards `chunks` reports
 *   `received: []`, and the uploader retransmits from the beginning.
 * - Stored only after verification succeeds, returning 200
 *   `{ ok: true, hash, size, complete: true, url: "/@media/<hash>" }`; from then on `chunks`
 *   reports `complete: true`. A hash that is already stored also returns 200 if `complete` is
 *   called again.
 * - Never-before-seen hash returns 404.
 *
 * ## Fetch `GET media/<hash>` (same for `HEAD`)
 *
 * - Only fetches stored whole files, Content-Type according to extension; supports single-range
 *   Range (`bytes=a-b`, `bytes=a-`, `bytes=-n`), returning 206 + `Content-Range`; out-of-file ranges
 *   return 416. Hashes not yet `complete` return 404 (chunks are not exposed externally).
 *
 * ## Cross-origin
 *
 * - Routes managed by this module (`/api/asset/media/...` and `/@media/*`) consistently return
 *   `Access-Control-Allow-Origin: *`,
 *   `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length, Content-Type`.
 * - Preflight `OPTIONS` returns 204: methods `GET, HEAD, PUT, POST, OPTIONS`; headers
 *   `Content-Type, Range, X-Media-Size, X-Media-Ext, X-Media-Type, X-Media-Tier, Authorization`
 *   (`Authorization` carries ticket); when request carries `Access-Control-Request-Private-Network`,
 *   **only returns `Access-Control-Allow-Private-Network: true` if origin is a loopback or LAN address**
 *   (`isPrivateOrigin`); preflights from public web pages are not given this header, so the browser
 *   blocks them as expected.
 * - Carries no credentials (no cookies used), so uses `*`. Same-origin guard for `/api/**` is only
 *   exempted for this set of paths (`isAssetServicePath` in `http-guard.mjs`); all other `/api/**`
 *   routes continue to require same-origin.
 *
 * ## Read and write with ticket (M6a, `docs/plan/auth-contract.md` section 8; semantics `product/asset-service.md` "Read and write with ticket")
 *
 * - **Local loopback origin** (`isTrusted`, defaults to whether the real remote peer address is
 *   loopback): no ticket required, same as before.
 * - **Other origins**:
 *   - Write (`PUT <ns>/<hash>/<n>`, `POST <ns>/<hash>/complete`) requires
 *     `Authorization: Bearer <asset ticket, r: 'rw'>`;
 *   - Read (`GET` / `HEAD` fetch, including Range; `GET chunks`; legacy route `/@media/*`) requires
 *     `Authorization: Bearer <asset ticket>`, or query string `?t=<ticket>`. Query string only
 *     accepts tickets with `r: 'r'`; writes never accept query string;
 *   - Missing ticket, invalid signature, expired, or generation mismatch returns 401
 *     `{ ok: false, error: "unauthorized" }`; writing with a read-only ticket returns 403
 *     `{ ok: false, error: "forbidden" }`. Every request is verified anew, including each Range
 *     request within the same playback segment.
 * - Tickets under legacy LAN/v1 historical mechanisms do not restrict hashes and can read known
 *   content of the service; describes only the legacy mode below. In account v2 cloud mode, after
 *   passing `projectStores`/`projectAccess`, doc authority verifies project ownership each time,
 *   allowing reads only for known hashes in this project's standalone store; knowing hashes of other
 *   projects cannot bypass permissions. This package does not alter legacy LAN semantics.
 * - Tickets are issued by the document service; verification uses credential storage in the same
 *   process (`server/auth/asset-tickets.mjs`), defaulting to the in-process singleton at
 *   `<root>/out/docservice/auth`. **Cluster tokens are no longer used for asset service**
 *   (C5 "non-local writes require cluster token" is retired).
 * - Responses with query string tickets include `Cache-Control: no-store` and
 *   `Referrer-Policy: no-referrer`.
 * - In account cloud mode (`projectAccess`), when reading fully stored `GET` / `HEAD` `media/<hash>`
 *   (including Range 206) successfully via `Authorization` header with no `t` query parameter in the
 *   URL, returns `Cache-Control: private, max-age=31536000, immutable` and `Vary: Authorization`;
 *   not stored, errors, with `?t=`, or other routes return `no-store` as usual.
 * - Raw tickets do not enter logs or responses; this module does not record access logs.
 *
 * ## Disk full (SP, `docs/plan/shared-project-contract.md` section 1)
 *
 * - When data layer write reports `ENOSPC` / `EDQUOT` (chunked upload, finalize): returns **507**
 *   `{ ok: false, error: "insufficient-storage" }`. This chunk is not counted as received, and this
 *   hash is not counted as stored; already received chunks are preserved, and upload can resume once
 *   space is freed.
 *
 * # Storage
 *
 * Read and written via `BlobStore`; this module does not touch the file system. Directory layout
 * for fs implementation (whole files, half-received chunks, and "received" mark for each chunk) is
 * written in the file header of `server/asset-store/fs-store.mjs`, byte-for-byte consistent with
 * step 5.
 */
import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import path from "path";
import { createHash } from "crypto";
import { apiPath, isAssetServicePath, clientAddressOf, isLocalOrigin } from "./http-guard.mjs";
import { createBlobStore, candidateFileResolver, projectScopeOfRoot, assetContextOf, setAssetContext, authorizedAssetStore, createGuestAssetQuota, guestIdOfUserId, SNIFF_BYTES } from "./asset-store/index.mjs";
import {
  mediaDir, isMediaHash, extOfName, contentTypeForExt, resolveHashFile, writeMediaIndex, parseRange,
} from "./vite-plugin-media";

export const ASSET_CHUNK_SIZE = 8 * 1024 * 1024;
/** Single-file limit. Prevents a cross-origin page from reporting an astronomical size to fill up the disk; adjust if genuinely larger assets are needed */
export const ASSET_MAX_SIZE = 64 * 1024 * 1024 * 1024;

export const ASSET_ALLOW_METHODS = "GET, HEAD, PUT, POST, OPTIONS";
export const ASSET_ALLOW_HEADERS = "Content-Type, Range, X-Media-Size, X-Media-Ext, X-Media-Type, X-Media-Tier, Authorization";
export const ASSET_EXPOSE_HEADERS = "Content-Range, Accept-Ranges, Content-Length, Content-Type";
export const ASSET_MEDIA_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** Chunk count: assets smaller than one chunk also count as 1 chunk */
export function chunkCount(size: number, chunkSize = ASSET_CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** Expected number of bytes for chunk n */
export function chunkLength(size: number, n: number, chunkSize = ASSET_CHUNK_SIZE): number {
  const count = chunkCount(size, chunkSize);
  return n < count - 1 ? chunkSize : size - chunkSize * (count - 1);
}

const MIME_TO_EXT: Record<string, string> = {
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac",
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/**
 * Additional recognized MIMEs for artifact namespaces (`snap`, `px`). Added only to these two
 * namespaces; reverse lookup results for `media` must not change by a single byte
 * (for example, when `media` receives `X-Media-Type: text/html`, it still has no extension).
 */
const ARTIFACT_MIME_TO_EXT: Record<string, string> = {
  ...MIME_TO_EXT,
  "text/html": "html", "video/iso.segment": "m4s",
};

/** Asset service namespaces (contract `artifact-transfer-contract.md` section 1) */
export const ASSET_NAMESPACES = ["media", "snap", "px"] as const;
export type AssetNamespace = typeof ASSET_NAMESPACES[number];

/**
 * Extensions permitted for writing to disk in `snap` / `px`, which are also candidate filenames
 * queried directly in order by fs hook `resolveFile` (contract section 10 item 6):
 * `html`, `mp4`, `m4s` come first, followed by remaining extensions in the MIME table for these two
 * namespaces and aliases recognized by Content-Type table, and finally `<hash>` with no extension
 * (added in `resolveFile`). Does not scan directories, so extensions not listed here are stored
 * without an extension (`extFromHeaders`); their Content-Type is `application/octet-stream` anyway,
 * so no external difference is visible upon retrieval.
 */
export const ARTIFACT_EXTS: readonly string[] = [
  ...new Set(["html", "mp4", "m4s", ...Object.values(ARTIFACT_MIME_TO_EXT), "htm", "m4v", "jpeg"]),
];

/**
 * Tier `X-Media-Tier` from request headers. Passed as-is to data layer, which normalizes it
 * (`normalizeTier` in `blob-store.mjs`: only recognizes `small`, all others default to `original`).
 * This is reported by the page, so guest video counts do not rely solely on it (small tier is also
 * counted, taking the maximum of original count and small-tier count); see file header of
 * `guest-quota.mjs`.
 */
function tierFromHeaders(req: IncomingMessage): string {
  return String(req.headers["x-media-tier"] || "");
}

/** Extension from request headers: X-Media-Ext takes precedence, followed by reverse lookup via X-Media-Type. Empty string if none; `snap` / `px` only retain those in `ARTIFACT_EXTS` */
function extFromHeaders(req: IncomingMessage, ns: AssetNamespace = "media"): string {
  const raw = String(req.headers["x-media-ext"] || "").trim().toLowerCase().replace(/^\./, "");
  const mime = String(req.headers["x-media-type"] || "").split(";")[0].trim().toLowerCase();
  if (ns === "media") {
    if (/^[a-z0-9]{1,8}$/.test(raw)) return raw;
    return MIME_TO_EXT[mime] || "";
  }
  const ext = /^[a-z0-9]{1,8}$/.test(raw) ? raw : (ARTIFACT_MIME_TO_EXT[mime] || "");
  return ARTIFACT_EXTS.includes(ext) ? ext : "";
}

/* ------------------------------------------------------------------ *
 * Data layer
 * ------------------------------------------------------------------ */

/** Data-layer interface (JSDoc in `server/asset-store/blob-store.mjs`); only parts used by HTTP layer are written here */
export interface AssetBlobStore {
  kind: string;
  chunkSize: number;
  stat(hash: string): Promise<{ size: number; ext: string; contentType: string; mtimeMs: number | null } | null>;
  read(hash: string, range?: { start?: number; end?: number }): Promise<Readable | null>;
  chunks(hash: string): Promise<{ size: number | null; chunkSize: number; received: number[]; complete: boolean }>;
  putChunk(hash: string, n: number, info: { size: number; ext?: string; tier?: string }, source: AsyncIterable<Buffer> | Readable): Promise<
    | { status: "ok"; bytes: number }
    | { status: "complete" }
    | { status: "size-mismatch"; size: number }
    | { status: "out-of-range"; count: number }
    | { status: "length"; expected: number; got: number }
    | { status: "discarded" }
  >;
  complete(hash: string): Promise<
    | { status: "ok"; size: number; ext: string }
    | { status: "unknown" }
    | { status: "incomplete"; missing: number[] }
    | { status: "hash-mismatch"; actual: string }
  >;
  remove(hash: string): Promise<boolean>;
  usage(): Promise<{ blobs: number; bytes: number; staging: number }>;
  /** Stored and staged, each with extension and tier (`blob-store.mjs`); used for guest video count, implemented in both fs and memory */
  inventory?(): Promise<{ stored: Array<{ hash: string; ext: string; tier: "small" | "original" }>; staging: Array<{ hash: string; ext: string; tier: "small" | "original" }> }>;
}

/** Default data layer: fs implementation, directory is local content store; locating files, writing index, and Content-Type use existing vite-plugin-media logic */
export function defaultAssetStore(root: string): AssetBlobStore {
  return createBlobStore({
    kind: "fs",
    dir: mediaDir(root),
    hooks: {
      resolveFile: (hash: string) => resolveHashFile(root, hash),
      onStored: ({ hash, file, ext, size, contentType }: { hash: string; file: string; ext: string; size: number; contentType: string }) =>
        writeMediaIndex(root, hash, { file, ext, size, contentType }),
      contentTypeForExt,
    },
  }) as AssetBlobStore;
}

/** Content-Type for artifact namespaces: snapshot is HTML, init is mp4, segment is m4s; others follow asset table */
function artifactContentType(ext: string): string {
  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  if (e === "html" || e === "htm") return "text/html; charset=utf-8";
  if (e === "m4s") return "video/iso.segment";
  return contentTypeForExt(e);
}

/** fs directory for artifact namespaces: `<root>/out/asset-store/<ns>` (contract section 1) */
export function artifactStoreDir(root: string, ns: "snap" | "px"): string {
  const scoped = projectScopeOfRoot(root);
  if (scoped) return scoped.dirs[ns];
  return process.env.PROMPTCUT_ARTIFACT_DIR ? path.resolve(process.env.PROMPTCUT_ARTIFACT_DIR, ns) : path.resolve(root, "out", "asset-store", ns);
}

/**
 * Default data layer for artifact namespaces (`snap` / `px`): fs implementation. Hook does not
 * write media index and does nothing after storing; locating files does not scan directories,
 * directly querying `<hash>.<ext>` in order per `ARTIFACT_EXTS`, and finally querying `<hash>`
 * (contract section 10 item 6). This module does not touch the file system; "whether this file
 * exists" is delegated to the data layer's `candidateFileResolver`.
 */
export function defaultArtifactStore(root: string, ns: "snap" | "px"): AssetBlobStore {
  const dir = artifactStoreDir(root, ns);
  return createBlobStore({
    kind: "fs",
    dir,
    hooks: {
      resolveFile: candidateFileResolver(dir, ARTIFACT_EXTS),
      onStored: () => {},
      contentTypeForExt: artifactContentType,
    },
  }) as AssetBlobStore;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Disk full (`ENOSPC`) or quota exceeded (`EDQUOT`) during data-layer write: returns 507, other errors return 500 as usual */
function isStorageFull(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  return code === "ENOSPC" || code === "EDQUOT";
}

/** Disconnect after returning error: request body still in transit, avoid letting it flood server (same reason as overLimit in http-guard.mjs) */
function reject(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  // Request body with declared length not exceeding one chunk: read and discard before responding, so
  // the client cleanly receives this 4xx (otherwise if it is still sending and we close connection
  // early, it only sees ECONNRESET). Only close connection immediately when length is unknown or
  // exceeds one chunk.
  const declared = Number(req.headers["content-length"]);
  if (Number.isSafeInteger(declared) && declared >= 0 && declared <= ASSET_CHUNK_SIZE && !req.readableEnded) {
    void drain(req).then(() => sendJson(res, status, body));
    return;
  }
  res.setHeader("Connection", "close");
  sendJson(res, status, body);
  res.once("finish", () => req.destroy());
  setTimeout(() => req.destroy(), 1000).unref?.();
}

/** Discard request body after reading */
function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => { req.on("end", resolve); req.on("error", () => resolve()); req.on("close", () => resolve()); req.resume(); });
}

/** Reconcile: response for `GET media/<hash>/chunks`. `store` defaults to `root`'s local content store */
export async function chunkStatus(root: string, hash: string, store: AssetBlobStore = defaultAssetStore(root)) {
  return store.chunks(hash);
}

async function handlePutChunk(req: IncomingMessage, res: ServerResponse, store: AssetBlobStore, hash: string, rawN: string, ns: AssetNamespace = "media", writer: WriteTrace = NO_TRACE) {
  if (!/^(0|[1-9]\d*)$/.test(rawN)) return reject(req, res, 400, { ok: false, error: "bad-chunk-number" });
  const n = Number(rawN);
  const sizeHeader = String(req.headers["x-media-size"] || "").trim();
  if (!/^[1-9]\d*$/.test(sizeHeader)) return reject(req, res, 400, { ok: false, error: "missing-size", detail: "Every piece must carry X-Media-Size (the total size in bytes)" });
  const size = Number(sizeHeader);
  if (!Number.isSafeInteger(size) || size > ASSET_MAX_SIZE) return reject(req, res, 413, { ok: false, error: "too-large" });
  const count = chunkCount(size, store.chunkSize);
  if (n >= count) return reject(req, res, 416, { ok: false, error: "chunk-out-of-range", count });
  const expected = chunkLength(size, n, store.chunkSize);
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) !== expected) {
    return reject(req, res, 400, { ok: false, error: "chunk-length", expected, got: Number(declared) });
  }

  // Guest uploading to media: check guest quota first (size checked via X-Media-Size; count video
  // items when opening new staging for original size); account and other namespaces write directly
  const guest = writer.guest;
  if (guest) {
    return guest.quota.putChunk({ accountId: writer.accountId, ns, size, hash, ext: extFromHeaders(req, ns), tier: tierFromHeaders(req), store, key: guest.key },
      () => writeChunk(req, res, store, hash, n, size, expected, ns, writer),
      (denied) => reject(req, res, denied.status, { ok: false, error: denied.error }));
  }
  return writeChunk(req, res, store, hash, n, size, expected, ns, writer);
}

async function writeChunk(req: IncomingMessage, res: ServerResponse, store: AssetBlobStore, hash: string, n: number, size: number, expected: number, ns: AssetNamespace, writer: WriteTrace) {
  // Host service (render service) writing new chunk: check capacity limit first, block only it if
  // reached (member writes do not go here); chunks already stored have no new bytes and do not consume quota
  const usage = writer.usage;
  const accounted = !!(usage && writer.service && usage.accounts(writer.service));
  let reservedHere = false;
  if (accounted && usage && !usage.has(ns, hash, writer.projectId) && !(await store.stat(hash))) {
    if (!usage.reserve(ns, hash, size, writer.projectId)) return reject(req, res, 507, { ok: false, error: "service-quota" });
    reservedHere = true;
  }
  // Write without service flag (member or local) writes to chunk tracked by render service: this chunk
  // no longer belongs exclusively to service
  if (usage && !writer.service) usage.disown(ns, hash, writer.projectId);

  let out;
  try {
    out = await store.putChunk(hash, n, { size, ext: extFromHeaders(req, ns), tier: tierFromHeaders(req) }, req);
  } catch (err) {
    if (reservedHere) usage?.release(ns, hash, writer.projectId);
    // Disk full: marker for this chunk was not added (not counted as received), received chunks remain
    // untouched; request body may still be in transit, disconnect after replying
    if (isStorageFull(err)) return reject(req, res, 507, { ok: false, error: "insufficient-storage" });
    // Disconnected: remote peer already gone, cannot receive any response; marker for this chunk was not
    // added, reported as "not received" during reconcile
    if (!res.headersSent && !res.destroyed) sendJson(res, (err as any)?.status ?? 500, { ok: false, error: (err as any)?.code ?? (err instanceof Error ? err.message : String(err)) });
    return;
  }
  switch (out.status) {
    case "ok": return sendJson(res, 200, { ok: true, hash, n, bytes: out.bytes });
    // Already stored: data layer has already read and discarded the request body, idempotently returns 200
    case "complete": return sendJson(res, 200, { ok: true, hash, n, bytes: expected, complete: true });
    case "size-mismatch": return reject(req, res, 409, { ok: false, error: "size-mismatch", size: out.size });
    case "out-of-range": return reject(req, res, 416, { ok: false, error: "chunk-out-of-range", count: out.count });
    case "length": return sendJson(res, 400, { ok: false, error: "chunk-length", expected: out.expected, got: out.got });
    case "discarded": return sendJson(res, 409, { ok: false, error: "staging-discarded" });
  }
}

async function handleComplete(res: ServerResponse, store: AssetBlobStore, hash: string, ns: AssetNamespace = "media", writer: WriteTrace = NO_TRACE) {
  // Guest finalizing media: count stored items in queue; if reached limit return 403 and keep staging;
  // re-identify by file header after storing (see completeBlob)
  const guest = writer.guest;
  if (guest) {
    return guest.quota.complete({ accountId: writer.accountId, ns, hash, store, key: guest.key },
      (gate) => completeBlob(res, store, hash, ns, writer, gate),
      (denied) => sendJson(res, denied.status, { ok: false, error: denied.error }));
  }
  return completeBlob(res, store, hash, ns, writer);
}

async function completeBlob(res: ServerResponse, store: AssetBlobStore, hash: string, ns: AssetNamespace, writer: WriteTrace, gate: CompleteGate | null = null) {
  const usage = writer.usage;
  const accounted = !!(usage && writer.service && usage.accounts(writer.service) && writer.projectId);
  // Chunk was already stored prior to finalize: not newly written this time (member writes not tracked;
  // render service writes only backfill project ownership)
  const existed = accounted ? !!(await store.stat(hash)) : true;
  const out = await store.complete(hash);
  if (usage && accounted && out.status === "hash-mismatch") usage.release(ns, hash, writer.projectId); // Discard all received chunks for this hash, release in-flight quota
  if (usage && out.status === "ok") {
    if (!writer.service) usage.disown(ns, hash, writer.projectId);
    else if (accounted && (!existed || usage.has(ns, hash, writer.projectId))) usage.record({ ns, hash, size: out.size, projectId: writer.projectId as string });
  }
  // Guest: re-identify by own file header after storing (extensions reported by page do not count);
  // delete it and return 403 if video count exceeded
  if (gate && out.status === "ok") {
    const verdict = await gate();
    if (!verdict.ok) {
      await store.remove(hash).catch(() => false);
      return sendJson(res, verdict.status, { ok: false, error: verdict.error });
    }
  }
  switch (out.status) {
    case "ok": return sendJson(res, 200, { ok: true, hash, size: out.size, complete: true, url: ns === "media" ? `/@media/${hash}` : `/api/asset/${ns}/${hash}` });
    case "unknown": return sendJson(res, 404, { ok: false, error: "unknown-hash" });
    case "incomplete": return sendJson(res, 400, { ok: false, error: "incomplete", missing: out.missing });
    case "hash-mismatch": return sendJson(res, 409, { ok: false, error: "hash-mismatch", actual: out.actual });
  }
}

/**
 * Fetch by hash. Response headers match `serveFile` in `vite-plugin-media`: 200 / 206 / 416,
 * `Content-Type`, `Content-Length`, `Accept-Ranges`, `Last-Modified` (omitted if data layer cannot
 * provide modification time), `Content-Range`.
 */
async function serveBlob(req: IncomingMessage, res: ServerResponse, store: AssetBlobStore, hash: string, longCache = false) {
  const stat = await store.stat(hash);
  if (!stat) return sendJson(res, 404, { ok: false, error: "not-found" });
  const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
  const head = req.method === "HEAD";
  // Last-Modified: for transition-period assets without content hash, frame pipeline timestamps using
  // `HEAD` Content-Length + Last-Modified
  const lastModified = stat.mtimeMs === null || stat.mtimeMs === undefined ? null : new Date(stat.mtimeMs).toUTCString();

  if (range === "unsatisfiable") {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
    return res.end();
  }
  const headers: Record<string, string | number> = range
    ? {
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": (range.end - range.start) + 1,
      "Content-Type": stat.contentType,
    }
    : {
      "Content-Length": stat.size,
      "Content-Type": stat.contentType,
      "Accept-Ranges": "bytes",
    };
  if (lastModified !== null) headers["Last-Modified"] = lastModified;
  // Open stream before sending headers: in case stored content was just deleted, can still return 404 cleanly
  const stream = head ? null : await store.read(hash, range ? { start: range.start, end: range.end } : {});
  if (!head && !stream) return sendJson(res, 404, { ok: false, error: "not-found" });
  await assetContextOf(req)?.lease.assert();
  if (res.destroyed) { stream?.destroy(); return; }
  if (longCache) {
    headers["Cache-Control"] = ASSET_MEDIA_CACHE_CONTROL;
    headers["Vary"] = "Authorization";
  }
  res.writeHead(range ? 206 : 200, headers);
  if (!stream) return res.end();
  stream.on("error", () => res.destroy());
  res.once("close", () => stream.destroy());
  stream.pipe(res);
}

/* ------------------------------------------------------------------ *
 * Read and write with ticket
 * ------------------------------------------------------------------ */

/**
 * Default "local" criterion: the peer is a loopback address, and every hop in the forwarding
 * headers is loopback (those forwarded through a reverse proxy on the same machine do not count,
 * `auth/origin.mjs`). Requests forwarded from the stage port's reverse proxy are judged by the
 * real peer it wrote (`clientAddressOf`).
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = clientAddressOf(req);
  return address !== null && isLocalOrigin(req, address);
}

/**
 * After store finalization succeeds and before sending response (for guests, check whether it
 * is a video by file header of newly stored item); if it fails, delete this item and return
 * the error it provided.
 */
type CompleteGate = () => Promise<{ ok: true } | { ok: false; status: number; error: string }>;

/**
 * Read up to the first `n` bytes from the request body, then unshift them back as-is (`unshift`);
 * subsequent processing reads the entire request body from the beginning as usual.
 * Used by guest whole-file uploads to check whether it is a video by file header
 * (`asset-store/guest-quota.mjs`). If the request body is shorter than `n`, returns all of it.
 * When reading to the end (`ended`), unshift back in the same tick, before the `end` event: once
 * `end` has been emitted, they cannot be unshifted back.
 */
function peekBody(req: IncomingMessage, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let got = 0, settled = false;
    const state = (req as any)._readableState;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      req.off("readable", onReadable);
      req.off("error", finish);
      req.off("close", onClose);
      if (err) return reject(err);
      const buf = Buffer.concat(parts);
      if (buf.length) req.unshift(buf);
      resolve(buf.subarray(0, n));
    };
    const onReadable = () => {
      let chunk: Buffer | null;
      while (got < n && (chunk = req.read()) !== null) { parts.push(chunk); got += chunk.length; }
      if (got >= n || state?.ended || req.readableEnded) finish();
    };
    // Peer disconnected before first few dozen bytes arrived: do not leave a never-settling wait
    const onClose = () => finish(Object.assign(new Error("aborted"), { status: 400, code: "request-aborted" }));
    req.on("readable", onReadable);
    req.once("error", finish);
    req.once("close", onClose);
  });
}

/**
 * Guest quota (`asset-store/guest-quota.mjs`): one copy per middleware, `key` identifies the same
 * store (in hosted mode it is the project; locally it is that store).
 */
interface GuestQuotaHook {
  putChunk(who: { accountId?: string; ns: string; size: number; hash: string; ext?: string; tier?: string; store: AssetBlobStore; key: unknown }, put: () => Promise<unknown>, deny: (d: { status: number; error: string }) => unknown): Promise<unknown>;
  complete(who: { accountId?: string; ns: string; hash: string; store: AssetBlobStore; key: unknown }, complete: (gate: CompleteGate | null) => Promise<unknown>, deny: (d: { status: number; error: string }) => unknown): Promise<unknown>;
  whole(who: { accountId?: string; bytes: number | null; ext?: string; peek?: () => Promise<Buffer>; store: AssetBlobStore; key: unknown; needsLength: boolean }): Promise<{ ok: true; release: () => void } | { ok: false; status: number; error: string }>;
}

/**
 * Origin of this write: for usage accounting (`usage`, `service`, `projectId`), for guest quota
 * (`accountId`, `guest`).
 */
interface WriteTrace { usage?: ServiceUsageHook | null; service?: string; projectId?: string; accountId?: string; guest?: { quota: GuestQuotaHook; key: unknown } | null }
const NO_TRACE: WriteTrace = {};

/** Verify asset tickets (`server/auth/asset-tickets.mjs`) */
export interface AssetTicketVerifier {
  verify(ticket: string): { ok: true; access: "r" | "rw"; projectId: string; userId: string; service?: string; actsFor?: "member" } | { ok: false; reason: string };
}

/** Ticket in `Authorization: Bearer <ticket>`; returns null if missing or malformed */
function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

/** Ticket `?t=` in query string; returns null if missing */
function queryTicketOf(req: IncomingMessage): string | null {
  const url = String(req.url || "");
  const i = url.indexOf("?");
  if (i < 0) return null;
  const t = new URLSearchParams(url.slice(i + 1)).get("t");
  return t ? t : null;
}

/** Whether the URL query string contains a `t` parameter (including empty `?t=`) */
function hasQueryTicketParam(req: IncomingMessage): boolean {
  const url = String(req.url || "");
  const i = url.indexOf("?");
  return i >= 0 && new URLSearchParams(url.slice(i + 1)).has("t");
}

/**
 * On admission, include whose ticket this write belongs to (service identity tickets have
 * `service`, `projectId` is the project scoped by the ticket; for usage accounting), and who is
 * writing (`accountId`: the ticket's `userId`, `accountId` of the principal verified by the
 * document service under hosted mode; for guest quota). Omitted for local loopback sources.
 */
type Access = { ok: true; service?: string; projectId?: string; accountId?: string } | { ok: false; status: 401 | 403; error: "unauthorized" | "forbidden" };
const DENY_401: Access = { ok: false, status: 401, error: "unauthorized" };
const DENY_403: Access = { ok: false, status: 403, error: "forbidden" };

/**
 * Whether to admit this request. `write`: chunked upload and finalize; otherwise read.
 * Loopback sources do not check tickets; other sources follow contract section 8: writes only
 * accept Bearer `rw` tickets; reads accept any Bearer asset ticket or query string `r` ticket.
 * Tickets with host service identity (verification result contains `service`,
 * `docs/plan/hosted-render-contract.md` section 1.6) can only write to prerender output
 * namespaces (`snap`, `px`); writing to original assets (`media`) returns 403.
 */
function accessOf(req: IncomingMessage, write: boolean, tickets: AssetTicketVerifier | null, isTrusted: (req: IncomingMessage) => boolean, ns?: string): Access {
  let trusted = false;
  try { trusted = !!isTrusted(req); } catch { trusted = false; }
  if (trusted) return { ok: true };
  if (!tickets) return DENY_401; // No credential store: reject all non-local requests, fail-closed
  const verify = (t: string) => {
    try { return tickets.verify(t); } catch { return { ok: false as const, reason: "error" }; }
  };
  const bearer = bearerOf(req);
  if (bearer !== null) {
    const v = verify(bearer);
    if (!v.ok) return DENY_401;
    if (write && v.access !== "rw") return DENY_403;
    // Services entering projects on behalf of members (Cloud Agent,
    // `docs/plan/cloud-agent-contract.md` section 4.4): write original assets (`media`) with the
    // member's own permissions, not allowed to write prerender outputs; chunks it writes count toward
    // the member and do not enter host service usage accounting (returned result omits `service`)
    if (v.actsFor === "member") {
      if (write && ns !== "media") return DENY_403;
      return { ok: true, projectId: v.projectId, accountId: guestIdOfUserId(v.userId) ?? v.userId };
    }
    if (write && v.service && ns !== "snap" && ns !== "px") return DENY_403;
    return { ok: true, service: v.service, projectId: v.projectId, accountId: guestIdOfUserId(v.userId) ?? v.userId };
  }
  if (write) return DENY_401; // Writes never accept query strings
  const q = queryTicketOf(req);
  if (q === null) return DENY_401;
  const v = verify(q);
  return v.ok && v.access === "r" ? { ok: true, service: v.service, projectId: v.projectId, accountId: guestIdOfUserId(v.userId) ?? v.userId } : DENY_401;
}

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

/**
 * Whether this request is governed by asset service cross-origin rules: `/api/asset/<ns>/...`
 * (three namespaces, exact match) and `/@media/*`.
 */
export function isAssetCorsPath(url: string | undefined): boolean {
  return isAssetServicePath(url) || String(url || "").startsWith("/@media/");
}

/**
 * Whether the origin is a loopback or LAN address: localhost / *.localhost / *.local, 127.0.0.0/8,
 * 10/8, 172.16/12, 192.168/16, 169.254/16, IPv6 ::1, fc00::/7, fe80::/10. The asset service must
 * allow direct access from devices on the LAN (`docs/semantics/product/asset-service.md`
 * "Responsibilities"), but does not specify allowing public web pages to access this machine:
 * private network access is only granted to these origins, erring on the most conservative side.
 * Unrecognized origins are always treated as public network.
 */
export function isPrivateOrigin(origin: string | string[] | undefined): boolean {
  let host: string;
  try { host = new URL(String(origin || "")).hostname.toLowerCase(); } catch { return false; }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return v6 === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6);
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function applyCors(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", ASSET_EXPOSE_HEADERS);
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", ASSET_ALLOW_METHODS);
    res.setHeader("Access-Control-Allow-Headers", ASSET_ALLOW_HEADERS);
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.headers["access-control-request-private-network"] && isPrivateOrigin(req.headers.origin)) res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

/**
 * Preflight for asset service routes **must be placed before vite's built-in cors middleware**.
 *
 * Vite's `server.cors` only allows localhost / 127.0.0.1 / [::1] origins by default, and precedes
 * all plugin middleware: preflights from LAN devices (e.g. `http://192.168.1.50:8080`) are
 * answered immediately with 204 without `Access-Control-Allow-Origin`, so the browser fails the
 * preflight check and the request never reaches assetServiceMiddleware (verified in testing).
 * Therefore, the media plugin inserts this middleware at the front of the connect stack
 * (`middlewares.stack.unshift`), only answering OPTIONS for asset service routes and passing other
 * requests through as-is. `server.cors` in vite.config.ts remains unchanged, leaving cross-origin
 * behavior for all other routes completely untouched.
 */
export function assetPreflightMiddleware() {
  return function assetPreflight(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (req.method !== "OPTIONS" || !isAssetCorsPath(req.url)) return next();
    applyCors(req, res);
    res.statusCode = 204;
    res.end();
  };
}

/**
 * Middleware for asset service. `/api/asset/<ns>/...` (`media`, `snap`, `px`) are all answered
 * here; `/@media/*` only appends CORS headers and answers preflights, while fetching bytes is
 * still handed over to mediaMiddleware(next) in `vite-plugin-media.ts`. Other requests call next
 * as-is.
 *
 * Options (contracts `docs/plan/asset-store-contract.md` sections 3 and 4;
 * `artifact-transfer-contract.md` section 1):
 * - `stores`: stores for each of the three namespaces `{ media?, snap?, px? }`. Missing ones use
 *   defaults: `media` is the local content store of `root` (`defaultAssetStore`), and `snap` /
 *   `px` are the fs implementation at `<root>/out/asset-store/<ns>` (`defaultArtifactStore`, built
 *   on first use);
 * - `store`: legacy name, still recognized, treated as `stores.media` (`stores.media` takes
 *   precedence when both are given);
 * - `tickets`: object for verifying asset tickets (`server/auth/asset-tickets.mjs`); defaults to
 *   obtaining the in-process credential store at `<root>/out/docservice/auth` (shared with the
 *   document service in this process); passing null rejects all tickets (all non-local get 401);
 * - `isTrusted`: which requests count as local, defaults to `isLoopbackRequest`.
 * Cluster token (the `token` option from C5) has been retired: ignored even if provided.
 */
/**
 * Usage accounting for chunks written by host services (`asset-store/service-usage.mjs`, contract
 * `docs/plan/hosted-render-contract.md` section 6). Only provided by hosted setups; only writes
 * whose ticket verification result includes `service` and `accounts(service)` is truthy are
 * accounted for and constrained by the limit; writes by members are not affected.
 */
export interface ServiceUsageHook {
  accounts(service: string): boolean;
  has(ns: string, hash: string, projectId?: string): boolean;
  /** Whether to admit a new chunk (occupies inflight quota); returns false if it cannot fit */
  reserve(ns: string, hash: string, size: number, projectId?: string): boolean;
  record(rec: { ns: string; hash: string; size: number; projectId: string }): void;
  release(ns: string, hash: string, projectId?: string): void;
  /** Someone else wrote the same chunk: no longer belongs exclusively to the service */
  disown(ns: string, hash: string, projectId?: string): boolean;
}

export interface AssetServiceOptions {
  /**
   * Cloud project mode: must provide both authoritative authorization adapter and project
   * physical store; local trust cannot bypass it. Central owner mount.
   */
  projectStores?: any;
  projectAccess?: any;
  /**
   * Usage accounting for host service writes (provided only by hosted setups); default and null
   * both mean no accounting.
   */
  serviceUsage?: ServiceUsageHook | null;
  stores?: { media?: AssetBlobStore; snap?: AssetBlobStore; px?: AssetBlobStore };
  store?: AssetBlobStore;
  tickets?: AssetTicketVerifier | null;
  isTrusted?: (req: IncomingMessage) => boolean;
  /**
   * On-demand pull for `px` (claude/bake-asset): where to fetch from when this chunk is missing
   * locally. Default is the currently connected remote asset service (`fetchRemoteArtifact` in
   * `media-pull.mjs`, treated as absent if not connected to a remote); null disables it.
   */
  pullArtifact?: ((ns: "px", hash: string) => Promise<{ bytes: Buffer; contentType?: string } | null>) | null;
  /**
   * Capacity eviction for `px` (claude/bake-asset, `asset-store/px-evict.mjs`): enabled by default
   * when `px` uses the default fs store (disabled via environment variable
   * `PROMPTCUT_PX_EVICT=0`); null disables it; passing an object allows modifying limit and
   * timing (for unit tests). Not enabled when a custom `px` store is injected without this option.
   */
  pxEvict?: { capBytes?: number; options?: Record<string, number>; start?: boolean } | null;
}

/**
 * On-demand pull for `px`: the retrieved whole file (sha256 verified by the puller, checked
 * again here) is written in chunks through the store and finalized into storage, becoming a local
 * hit afterwards. The same hash is pulled only once at a time. If any step fails, treat it as
 * absent (caller returns 404 as usual) without throwing.
 */
const artifactPulls = new WeakMap<AssetBlobStore, Map<string, Promise<void>>>();
async function pullArtifactInto(store: AssetBlobStore, hash: string, pull: NonNullable<AssetServiceOptions["pullArtifact"]>): Promise<void> {
  let pulls = artifactPulls.get(store);
  if (!pulls) { pulls = new Map(); artifactPulls.set(store, pulls); }
  const flying = pulls.get(hash);
  if (flying) return flying;
  const job = (async () => {
    try {
      const got = await pull("px", hash);
      if (!got?.bytes?.length) return;
      if (createHash("sha256").update(got.bytes).digest("hex") !== hash) return;
      const mime = String(got.contentType || "").split(";")[0].trim().toLowerCase();
      const ext = ARTIFACT_MIME_TO_EXT[mime] && ARTIFACT_EXTS.includes(ARTIFACT_MIME_TO_EXT[mime]) ? ARTIFACT_MIME_TO_EXT[mime] : "";
      const size = got.bytes.length;
      const count = chunkCount(size, store.chunkSize);
      for (let n = 0; n < count; n++) {
        const part = got.bytes.subarray(n * store.chunkSize, Math.min(size, (n + 1) * store.chunkSize));
        const r = await store.putChunk(hash, n, { size, ext }, Readable.from([part]));
        if (r.status !== "ok") return; // "complete": another request has already stored it; others: treat as absent
      }
      await store.complete(hash);
    } catch { /* Treat as absent */ }
  })();
  pulls.set(hash, job);
  try { await job; } finally { pulls.delete(hash); }
}

export function assetServiceMiddleware(root: string, opts: AssetServiceOptions = {}) {
  if (!!opts.projectStores !== !!opts.projectAccess) throw new TypeError("projectStores and projectAccess required together");
  if (opts.projectStores && opts.serviceUsage && !(opts.serviceUsage as any).projectScoped) throw new TypeError("project-scoped service usage required");
  const media = opts.stores?.media ?? opts.store ?? defaultAssetStore(root);
  const artifactStores: Partial<Record<"snap" | "px", AssetBlobStore>> = { snap: opts.stores?.snap, px: opts.stores?.px };
  const storeOf = (ns: AssetNamespace): AssetBlobStore => {
    if (ns === "media") return media;
    return (artifactStores[ns] ??= defaultArtifactStore(root, ns));
  };
  // Default verifier is loaded lazily: opens the credential store only when a non-local request
  // brings a ticket for the first time
  let defaultTickets: AssetTicketVerifier | null | undefined;
  const ticketsOf = async (): Promise<AssetTicketVerifier | null> => {
    if (opts.tickets !== undefined) return opts.tickets;
    if (defaultTickets === undefined) {
      try {
        const { assetTicketVerifierFor } = await import("./auth/asset-tickets.mjs");
        const { prepareLocalDocumentDir } = await import("./recovery/paths.mjs");
        defaultTickets = assetTicketVerifierFor(path.join(prepareLocalDocumentDir(root), "auth")) as AssetTicketVerifier;
      } catch {
        defaultTickets = null;
      }
    }
    return defaultTickets;
  };
  const isTrusted = typeof opts.isTrusted === "function" ? opts.isTrusted : isLoopbackRequest;
  /*
   * Guest asset quota (`asset-store/guest-quota.mjs`): only governs guest writes to media. Queued
   * per store: under hosted mode, each project has one store, keyed by project id; locally there is
   * only one media store, keyed by itself.
   */
  const guestQuota: GuestQuotaHook = createGuestAssetQuota({ isVideoExt: (ext: string) => contentTypeForExt(ext).startsWith("video/") });
  const guestTrace = (who: { projectId?: string; accountId?: string }) =>
    ({ accountId: who.accountId, guest: who.accountId ? { quota: guestQuota, key: opts.projectStores && who.projectId ? `project:${who.projectId}` : media } : null });
  /**
   * Under hosted mode, whole-file uploads (`POST /api/media/upload/<name>`) and content key
   * backfilling (`POST /api/media/adopt`) from media middleware also write to the project's media,
   * bypassing the chunked routes below. They authorize themselves via `vite-plugin-media.ts`; here
   * we only check first whether it is a guest: if so, intercept by guest quota, and once admitted,
   * hold this project's guest queue until the response completes; non-guests call next as-is.
   * - Authorization errors (including transient 503s) return the error and do not pass down
   *   (claude/guest-fix [ruling], review S2): previously it called next upon `catch`, and the media
   *   middleware re-verified and happened to succeed, so this guest whole-file upload bypassed quota;
   * - Guests cannot backfill content keys (review S3): that route is for media collection and is not
   *   used by guests; it mounts any file in the media directory into the store (including unfinalized
   *   staging `.chunks/<hash>/data` without hash verification), bypassing video count limits during
   *   finalization;
   * - When reported extension for whole-file upload is not a video, first read the first few dozen
   *   bytes from the request body to identify it by file header (`peekBody`, review A2).
   */
  const isWholeMediaWrite = (req: IncomingMessage) => req.method === "POST" && (String(req.url || "").startsWith("/api/media/upload/") || String(req.url || "").startsWith("/api/media/adopt"));
  const gateWholeMediaWrite = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    let lease: any;
    try {
      lease = await opts.projectAccess.resolve(req, { action: "write", resource: { ns: "media", route: apiPath(req.url) }, close: () => { req.destroy(); res.destroy(); } });
    } catch (err: any) { return reject(req, res, err?.status ?? 503, { ok: false, error: err?.code ?? "authority-unavailable" }); }
    let verdict: Awaited<ReturnType<GuestQuotaHook["whole"]>>;
    try {
      const accountId = typeof lease.principal?.accountId === "string" ? lease.principal.accountId : undefined;
      const upload = String(req.url || "").startsWith("/api/media/upload/");
      if (!upload && guestIdOfUserId(accountId ?? null)) verdict = { ok: false, status: 403, error: "guest-adopt-forbidden" };
      else {
      const declared = Number(req.headers["content-length"]);
      const bytes = upload && req.headers["content-length"] !== undefined && Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
      // Extension: whole-file upload takes file name from URL (same way as handleMediaUpload in
      // vite-plugin-media); content key backfilling takes it from file name in `path` parameter
      let ext = "";
      try {
        const u = new URL(String(req.url || "/"), "http://promptcut.local");
        ext = extOfName(upload ? decodeURIComponent(u.pathname.split("/").pop() || "") : (u.searchParams.get("path") || ""));
      } catch { ext = ""; }
      verdict = await guestQuota.whole({ accountId, bytes, ext, peek: () => peekBody(req, SNIFF_BYTES), store: opts.projectStores.project(lease.projectId).stores.media, key: `project:${lease.projectId}`, needsLength: upload });
      }
    } catch (err: any) {
      // Peer disconnected while reading head or store failed: return error, do not pass down
      verdict = { ok: false, status: err?.status ?? 500, error: err?.code ?? "media-failed" };
    } finally { void lease.release(); }
    if (!verdict.ok) return reject(req, res, verdict.status as 403, { ok: false, error: verdict.error });
    const release = verdict.release;
    res.once("close", release);
    res.once("finish", release);
    return next();
  };
  /*
   * Capacity eviction for px: handled inside this process, exposing no external deletion API.
   * Only accesses the px store; media / snap are untouched. Lazy import (several unit tests
   * transpile this file alone, where static imports of sibling modules fail to resolve).
   */
  const pxEvictor: Promise<any> | null = (() => {
    if (opts.projectStores) return null; // Hosted project stores do not apply local px eviction rules
    if (opts.pxEvict === null || process.env.PROMPTCUT_PX_EVICT === "0") return null;
    if (opts.stores?.px && !opts.pxEvict) return null;
    const pxStore: any = storeOf("px");
    if (typeof pxStore.list !== "function") return null;
    const p = import("./asset-store/px-evict.mjs").then((mod: any) => {
      const ev = mod.createPxEvictor({
        dir: artifactStoreDir(root, "px"), store: pxStore, capBytes: opts.pxEvict?.capBytes, options: opts.pxEvict?.options,
        log: (event: string, fields: object = {}) => { try { console.info("[px-evict]", event, JSON.stringify(fields)); } catch { /* No effect */ } },
      });
      if (opts.pxEvict?.start !== false) ev.start();
      return ev;
    }).catch(() => null);
    return p;
  })();
  const touchPx = (hash: string) => { if (pxEvictor) void pxEvictor.then((ev) => ev?.touch(hash)); };  // On-demand pull for px: lazily loads media-pull by default (currently connected remote asset service); several unit tests transpile this file in isolation, where static imports of sibling modules fail to resolve
  const pullArtifact: NonNullable<AssetServiceOptions["pullArtifact"]> | null = opts.pullArtifact === null ? null
    : opts.pullArtifact ?? (async (ns, hash) => {
      try {
        const mod: any = await import("./media-pull.mjs");
        return typeof mod.fetchRemoteArtifact === "function" ? await mod.fetchRemoteArtifact(ns, hash) : null;
      } catch { return null; }
    });
  /**
   * Whether admitted; when rejected, 401 / 403 has already been responded (returns null); when
   * admitted, returns origin of this access.
   */
  const admit = async (req: IncomingMessage, res: ServerResponse, write: boolean, ns?: string): Promise<Extract<Access, { ok: true }> | null> => {
    // Responses with query string tickets: do not cache, do not send Referer outbound
    // (contract section 8)
    if (queryTicketOf(req) !== null) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
    }
    if (opts.projectAccess) {
      res.setHeader("Cache-Control", "no-store");
      try {
        const lease = await opts.projectAccess.resolve(req, { action: write ? "write" : "read", resource: { ns: ns ?? "media", route: apiPath(req.url) }, close: () => { req.destroy(); res.destroy(); } });
        const p = lease.principal;
        if (write && p.access !== "rw") { lease.release(); reject(req, res, 403, { ok: false, error: "forbidden" }); return null; }
        if (write && ((p.actsFor === "member" && ns !== "media") || (p.service && p.actsFor !== "member" && ns === "media"))) { lease.release(); reject(req, res, 403, { ok: false, error: "forbidden" }); return null; }
        const scope = opts.projectStores.project(lease.projectId);
        setAssetContext(req, { ...scope, lease });
        res.once("close", () => lease.release());
        res.once("finish", () => lease.release());
        return { ok: true, projectId: lease.projectId, service: p.actsFor === "member" ? undefined : p.service, accountId: typeof p.accountId === "string" ? p.accountId : undefined };
      } catch (err: any) { reject(req, res, err?.status ?? 503, { ok: false, error: err?.code ?? "authority-unavailable" }); return null; }
    }
    let trusted = false;
    try { trusted = !!isTrusted(req); } catch { trusted = false; }
    const access = accessOf(req, write, trusted ? null : await ticketsOf(), () => trusted, ns);
    if (access.ok) return access;
    reject(req, res, access.status, { ok: false, error: access.error });
    return null;
  };
  const handler = async function assetService(req: Connect.IncomingMessage, res: ServerResponse, next: () => void) {
    if (isAssetMergePath(req.url)) return answerMerge(req, res);
    if (opts.projectAccess && isWholeMediaWrite(req)) return gateWholeMediaWrite(req, res, next);
    if (!isAssetCorsPath(req.url)) return next();
    applyCors(req, res);
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    if (!isAssetServicePath(req.url)) {
      // GET / HEAD for `/@media/*`: non-local requests require read tickets; handed over to
      // mediaMiddleware in vite-plugin-media after admission
      try {
        if (!(await admit(req, res, false))) return;
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return next();
    }

    // The criterion shares the same regex with the same-origin guard exemption; requests admitted by
    // the guard are guaranteed a response from here and will not call next to other `/api` handlers
    const parts = apiPath(req.url).split("/"); // ["", "api", "asset", <ns>, <hash>, <tail>?]
    const ns = parts[3] as AssetNamespace; // Regex only permits media / snap / px
    const hash = parts[4];
    const tail = parts[5];
    const method = String(req.method || "GET").toUpperCase();
    try {
      if (!isMediaHash(hash)) return sendJson(res, 400, { ok: false, error: "bad-hash" });
      const scopedStore = () => {
        const context = assetContextOf(req);
        return context ? authorizedAssetStore(context.stores[ns], context.lease) : storeOf(ns);
      };
      if (tail === undefined) {
        if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { ok: false, error: "method" });
        if (!(await admit(req, res, false, ns))) return;
        const store = scopedStore();
        // When px chunk is missing locally: fetch once from currently connected remote asset service
        // before responding (card snapshots pushed by other members in shared project)
        // Requests with x-promptcut-pull are pulled by another asset service on behalf of its page:
        // do not pull further down to prevent cycles between two machines
        if (!opts.projectStores && ns === "px" && pullArtifact && !req.headers["x-promptcut-pull"] && !(await store.stat(hash))) await pullArtifactInto(store, hash, pullArtifact);
        if (ns === "px") touchPx(hash);
        const longCache = Boolean(opts.projectAccess && ns === "media" && bearerOf(req) !== null && !hasQueryTicketParam(req));
        return await serveBlob(req, res, store, hash, longCache);
      }
      if (tail === "chunks") {
        if (method !== "GET") return sendJson(res, 405, { ok: false, error: "method" });
        if (!(await admit(req, res, false, ns))) return;
        const store = scopedStore();
        // Reconciliation also counts as usage (queried on every card snapshot index hit and each page
        // inventory round): chunks still in use will not be evicted as least recently used
        if (ns === "px") touchPx(hash);
        return sendJson(res, 200, await store.chunks(hash));
      }
      if (tail === "complete") {
        if (method !== "POST") return sendJson(res, 405, { ok: false, error: "method" });
        const who = await admit(req, res, true, ns);
        if (!who) return;
        await handleComplete(res, scopedStore(), hash, ns, { usage: opts.serviceUsage, service: who.service, projectId: who.projectId, ...guestTrace(who) });
        if (ns === "px" && pxEvictor) { touchPx(hash); void pxEvictor.then((ev) => ev?.onStored()); }
        return;
      }
      if (method !== "PUT") return reject(req, res, 405, { ok: false, error: "method" });
      const who = await admit(req, res, true, ns);
      if (!who) return;
      return await handlePutChunk(req, res, scopedStore(), hash, tail, ns, { usage: opts.serviceUsage, service: who.service, projectId: who.projectId, ...guestTrace(who) });
    } catch (err) {
      // Disk full during finalization: store has not stored it, staging retained (fs finalization deletes
      // staging only after successful rename)
      if (isStorageFull(err)) return sendJson(res, 507, { ok: false, error: "insufficient-storage" });
      sendJson(res, (err as any)?.status ?? 500, { ok: false, error: (err as any)?.code ?? (err instanceof Error ? err.message : String(err)) });
    }
  };
  /** For unit tests and troubleshooting: px evictor for this middleware (null if not enabled) */
  return Object.assign(handler, { pxEvictor: () => pxEvictor ?? Promise.resolve(null) });
}

/**
 * Reserved "merge and distribute" endpoint (`docs/semantics/mechanism/platforms.md` "Reserved
 * endpoints"; C10 contract section 11): `POST merge/<projectId>/<sharedKey>`, currently always
 * returns 501. Clients push their prerendered shared results to the asset service, which merges
 * and deduplicates them before distributing to other clients; this step is not implemented yet;
 * currently only pushing one's own (`snap/`, `px/`) is implemented.
 *
 * The asset service has no project semantics (`product/asset-service.md`): this route is only a
 * placeholder; neither `<projectId>` nor shared key is parsed or validated, without reading the
 * request body, touching the store, or verifying tickets. It is not in the same-origin guard
 * exemption regex (`ASSET_ROUTE` in `http-guard.mjs`); it is answered up front by this middleware
 * and will not fall through to other `/api` handlers.
 */
const MERGE_ROUTE = /^\/api\/asset\/merge\/[^/]+\/[^/]+$/;

export function isAssetMergePath(url: string | undefined): boolean {
  return MERGE_ROUTE.test(apiPath(url));
}

function answerMerge(req: IncomingMessage, res: ServerResponse): void {
  applyCors(req, res);
  const method = String(req.method || "GET").toUpperCase();
  if (method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (method !== "POST") { res.setHeader("Allow", "POST"); return sendJson(res, 405, { ok: false, error: "method" }); }
  req.resume(); // Request body is not read and discarded; connection finalized as usual
  sendJson(res, 501, { ok: false, error: "not-implemented" });
}

/**
 * Request headers that the uploader must include for each chunk (for tests and future step 6
 * upload queue).
 */
export function chunkHeaders(size: number, name?: string): Record<string, string> {
  const h: Record<string, string> = { "X-Media-Size": String(size) };
  const ext = extOfName(name || "");
  if (ext) h["X-Media-Ext"] = ext;
  return h;
}
