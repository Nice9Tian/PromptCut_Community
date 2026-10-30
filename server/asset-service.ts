/**
 * 素材服务:第一版的本地素材服务(`docs/semantics/product/asset-service.md`;
 * 任务书 `docs/plan/cloud-task.md` 第 5 步、A1「上传一律走分片」)。
 *
 * 它挂在编辑器进程的媒体插件里(`vite-plugin-media.ts` 的 mediaPlugin)。本模块只管 HTTP,
 * 字节一律经数据层接口 `BlobStore`(`server/asset-store/`,契约 `docs/plan/asset-store-contract.md`)读写;
 * 缺省是 fs 实现,存储就是本地内容库 `out/media`(`mediaDir`),文件名 `<sha256>.<ext>`。
 * **只有数据层和 vite-plugin-media 读写那个目录**;Agent 进程、预渲染进程像外部客户端一样
 * 只经下面的 HTTP API 取字节(地址怎么定见 `asset-client.ts`)。
 * 远程素材服务(局域网 NAS、公网云端)不在本仓库,但必须实现同一份契约,客户端只换基址。
 *
 * # 命名空间(C6.2,`docs/plan/artifact-transfer-contract.md` 第 1 节)
 *
 * 路由是 `/api/asset/<ns>/<hash>…`,`<ns>` ∈ `media` | `snap` | `px`,三个命名空间各一个 `BlobStore`,互不可见:
 * - `media`:素材,就是下面第 5 步写的这一套,行为不变;老路由 `/@media/*` 只对应它。
 * - `snap`:HTML 快照块;`px`:像素产物(本阶段是轨道流的 init `.mp4` 与分段 `.m4s`)。
 *   缺省是 fs 实现,目录 `<root>/out/asset-store/snap`、`<root>/out/asset-store/px`;
 *   不写媒体索引,只按 `<hash>[.<ext>]` 找文件。
 * 子路由、状态码、回包、分片规则、跨源头、写入鉴权三个命名空间相同,下文写 `media/` 的地方换成 `<ns>/` 即可。
 * 两处按命名空间区分:收尾回包的 `url`,`media` 是 `/@media/<hash>`,另两个是 `/api/asset/<ns>/<hash>`;
 * `X-Media-Type` 反查扩展名时,`text/html → html`、`video/iso.segment → m4s` 只对 `snap` / `px` 生效,
 * `media` 的反查表不动。
 * `px` 的取回多一步按需拉取(claude/bake-asset):本机没有这一块、且编辑器连着共享项目的远程素材服务时,先向远程整件取一次、
 * 校验入库再答(`pullArtifact`,缺省 `media-pull.mjs` 的 `fetchRemoteArtifact`);没连远程或远程也没有,照旧 404。
 * 卡片快照(`bake_card` 与 3D 视图的贴图,地址 `/api/asset/px/<hash>`)靠它让别的成员也取得到。
 *
 * # API 契约(第 5 步)
 *
 * 基址 `<origin>/api/asset`;下面的路径都相对基址。本地素材服务的老读路由 `/@media/<hash>`
 * 与 `GET media/<hash>` 等价,同样允许跨源。
 *
 * ## 按哈希寻址
 *
 * - `<hash>` 是**全件内容的 sha256**,64 位 hex,**由上传方在自己那边算好**;大小写不敏感,服务端一律按小写存。
 * - 写入后不可变,天然去重:同一个哈希只存一份。
 *
 * ## 分片上传 `PUT media/<hash>/<n>`
 *
 * - 分片固定 `chunkSize = 8 MiB`(8388608 字节);分片数 `count = max(1, ceil(size / chunkSize))`,
 *   小于 8 MiB 的素材就是 1 片。没有整件 `PUT media/<hash>` 这条路。
 * - `<n>` 是十进制分片号,`0 ≤ n < count`,不带前导零。格式不对回 400,越界回 416。
 * - 请求头(**每一片都要带**,服务端不靠「第一片」记状态,乱序、并发、断点重传都一样):
 *   - `X-Media-Size: <全件字节数>` —— 必填,正整数,上限 64 GiB。缺了或不是整数回 400;
 *     与这个哈希已登记的 size 不一致回 409(`error: "size-mismatch"`)。
 *   - `X-Media-Ext: <扩展名>` 与 / 或 `X-Media-Type: <MIME>` —— 选填,决定取回时的 Content-Type。
 *     扩展名优先;只给 MIME 时按表反查扩展名;都没给就是无扩展名、`application/octet-stream`。
 *     **哪一片先带上就以哪一片为准**,之后的不再改它。
 *   - `X-Media-Tier: small | original` —— 选填,这个文件是素材小尺寸还是原尺寸(2026-10-23,游客的视频条数按
 *     「原件几个、小档几个取多的」数,`asset-store/guest-quota.mjs`)。只认 `small`,缺失、拼错、不认识的一律当 `original`;
 *     同一个哈希只要有一片没说 `small` 就记成 `original`。只影响游客的视频条数,取回、对账的回包不变。
 *   - 请求体的 `Content-Type` 不看(一般是 `application/octet-stream`)。
 * - 长度:除最后一片外每片必须恰好 `chunkSize` 字节,最后一片是 `size - chunkSize × (count - 1)`。
 *   `Content-Length` 对不上直接回 400;实收字节多了或少了也回 400,这一片不算收到。
 * - **幂等**:同一片重传,按新到的字节原位重写,结果一样;这一哈希已经 `complete` 时,任何分片都回 200 不落盘。
 * - 成功回 200 `{ ok: true, hash, n, bytes }`。
 *
 * ## 对账 `GET media/<hash>/chunks`
 *
 * - 回 200 `{ size, chunkSize, received: number[], complete }`。`received` 升序。
 * - 从没见过的哈希:`{ size: null, chunkSize, received: [], complete: false }`。
 * - 已入库(包括走老的整件导入进来的):`{ size, chunkSize, received: [0..count-1], complete: true }`。
 * - 这是「这一档到齐没有」的**唯一事实来源**;断点续传只补 `received` 里缺的片。
 *
 * ## 收尾 `POST media/<hash>/complete`
 *
 * - 分片没到齐回 400 `{ error: "incomplete", missing: number[] }`,已收的分片不动。
 * - 到齐了按顺序对全件算 sha256:和 `<hash>` 不符回 **409** `{ error: "hash-mismatch", actual }`,
 *   并**丢弃这一哈希已收的全部分片**(分不清是哪一片坏了),之后 `chunks` 报 `received: []`,上传方从头传。
 * - 校验通过才入库,回 200 `{ ok: true, hash, size, complete: true, url: "/@media/<hash>" }`;
 *   从这以后 `chunks` 报 `complete: true`。已经入库的哈希再 `complete` 一次也回 200。
 * - 从没见过的哈希回 404。
 *
 * ## 取回 `GET media/<hash>`(`HEAD` 同)
 *
 * - 只取已入库的全件,Content-Type 按扩展名;支持单段 Range(`bytes=a-b`、`bytes=a-`、`bytes=-n`),
 *   回 206 + `Content-Range`;落在文件外回 416。还没 `complete` 的哈希回 404(分片不对外)。
 *
 * ## 跨源
 *
 * - 本模块管的路由(`/api/asset/media/...` 和 `/@media/*`)一律回 `Access-Control-Allow-Origin: *`,
 *   `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length, Content-Type`。
 * - 预检 `OPTIONS` 回 204:方法 `GET, HEAD, PUT, POST, OPTIONS`,
 *   头 `Content-Type, Range, X-Media-Size, X-Media-Ext, X-Media-Type, X-Media-Tier, Authorization`(`Authorization` 带票据);
 *   请求带 `Access-Control-Request-Private-Network` 时，**只有来源是回环或局域网地址**（`isPrivateOrigin`）
 *   才回 `Access-Control-Allow-Private-Network: true`；公网网页的预检不给这一项，浏览器照样拦下它。
 * - 不带凭据(不用 cookie),所以用 `*`。`/api/**` 的同源守卫只对这一组路径豁免
 *   (`http-guard.mjs` 的 `isAssetServicePath`),其余 `/api/**` 照旧只认同源。
 *
 * ## 凭票据读写(M6a,`docs/plan/auth-contract.md` 第 8 节;语义 `product/asset-service.md`「凭票据读写」)
 *
 * - **本机回环来源**(`isTrusted`,缺省按真实对端地址是不是回环):不需要票据,与原来相同。
 * - **其它来源**:
 *   - 写(`PUT <ns>/<hash>/<n>`、`POST <ns>/<hash>/complete`)要 `Authorization: Bearer <素材票据,r: 'rw'>`;
 *   - 读(`GET` / `HEAD` 取回,含 Range;`GET chunks`;老路由 `/@media/*`)要 `Authorization: Bearer <素材票据>`,
 *     或者查询串 `?t=<票据>`。查询串只认 `r: 'r'` 的票据,写入一律不认查询串;
 *   - 没票据、签名不对、过期、代数不符回 401 `{ ok: false, error: "unauthorized" }`;写入用了只读票据回 403
 *     `{ ok: false, error: "forbidden" }`。每个请求都重新核对,包括同一段播放里的每个 Range 请求。
 * - 旧LAN/v1历史机制的票据不限定哈希，可读该服务已知内容；仅描述下文旧模式。
 *   账号v2云模式传入projectStores/projectAccess后由doc权威逐次核项目归属，
 *   只能读本项目独立库中的已知哈希；知道其它项目hash不能越权。本包不改旧LAN语义。
 * - 票据由文档服务签发;核对用同一进程里的凭证存储(`server/auth/asset-tickets.mjs`),缺省按
 *   `<root>/out/docservice/auth` 取进程内单例。**集群令牌不再用于素材服务**(C5 的「非本机写入凭集群令牌」退役)。
 * - 带查询串票据的响应加 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`。
 * - 账号云模式(`projectAccess`)下,凭 `Authorization` 头且 URL 不含 `t` 查询参数读已完整入库的 `GET` / `HEAD` `media/<hash>`(含 Range 206)成功时,回 `Cache-Control: private, max-age=31536000, immutable` 与 `Vary: Authorization`;未入库、出错、带 `?t=` 或其它路由照旧 `no-store`。
 * - 票据原文不进日志、不进回包;本模块不记访问日志。
 *
 * ## 磁盘满(SP,`docs/plan/shared-project-contract.md` 第 1 节)
 *
 * - 数据层写入时报 `ENOSPC` / `EDQUOT`(分片上传、收尾):回 **507** `{ ok: false, error: "insufficient-storage" }`。
 *   这一片不算收到、这一哈希不算入库,已收的分片保留,腾出空间后续传即可。
 *
 * # 存储
 *
 * 经 `BlobStore` 读写,本模块不碰文件系统。fs 实现的目录布局(全件、收了一半的分片、每片的「收到」标记)
 * 写在 `server/asset-store/fs-store.mjs` 文件头,与第 5 步逐字节一致。
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
/** 单件上限。防一个跨源页面报个天文数字的 size 把盘占满;真有更大的素材再调 */
export const ASSET_MAX_SIZE = 64 * 1024 * 1024 * 1024;

export const ASSET_ALLOW_METHODS = "GET, HEAD, PUT, POST, OPTIONS";
export const ASSET_ALLOW_HEADERS = "Content-Type, Range, X-Media-Size, X-Media-Ext, X-Media-Type, X-Media-Tier, Authorization";
export const ASSET_EXPOSE_HEADERS = "Content-Range, Accept-Ranges, Content-Length, Content-Type";
export const ASSET_MEDIA_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** 分片数:小于一片的素材也算 1 片 */
export function chunkCount(size: number, chunkSize = ASSET_CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** 第 n 片应有的字节数 */
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
 * 产物命名空间(`snap`、`px`)多认的 MIME。只加给这两个命名空间:`media` 的反查结果一个字节都不许变
 * (比如 `media` 收到 `X-Media-Type: text/html` 仍然是无扩展名)。
 */
const ARTIFACT_MIME_TO_EXT: Record<string, string> = {
  ...MIME_TO_EXT,
  "text/html": "html", "video/iso.segment": "m4s",
};

/** 素材服务的命名空间(契约 `artifact-transfer-contract.md` 第 1 节) */
export const ASSET_NAMESPACES = ["media", "snap", "px"] as const;
export type AssetNamespace = typeof ASSET_NAMESPACES[number];

/**
 * `snap` / `px` 落盘允许的扩展名,也是 fs 钩子 `resolveFile` 依次直接查的候选文件名(契约第 10 节第 6 条):
 * `html`、`mp4`、`m4s` 在前,再是这两个命名空间的 MIME 表里其余的扩展名和 Content-Type 表认得的别名,
 * 最后是没有扩展名的 `<hash>`(`resolveFile` 里补)。不扫目录,所以不在这里的扩展名一律按无扩展名存
 * (`extFromHeaders`);它们的 Content-Type 本来就是 `application/octet-stream`,取回时对外看不出区别。
 */
export const ARTIFACT_EXTS: readonly string[] = [
  ...new Set(["html", "mp4", "m4s", ...Object.values(ARTIFACT_MIME_TO_EXT), "htm", "m4v", "jpeg"]),
];

/**
 * 请求头里的档位 `X-Media-Tier`。原样交给数据层,由它归一(`blob-store.mjs` 的 `normalizeTier`:只认 `small`,
 * 别的一律 `original`)。这是页面说的,所以游客的视频条数不只看它(小档也数,原件几个、小档几个取多的),见 `guest-quota.mjs` 文件头
 */
function tierFromHeaders(req: IncomingMessage): string {
  return String(req.headers["x-media-tier"] || "");
}

/** 请求头里的扩展名:X-Media-Ext 优先,其次按 X-Media-Type 反查。取不出给空串;`snap` / `px` 只留 `ARTIFACT_EXTS` 里的 */
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
 * 数据层
 * ------------------------------------------------------------------ */

/** 数据层接口(`server/asset-store/blob-store.mjs` 的 JSDoc),这里只写 HTTP 层用到的部分 */
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
  /** 已入库与暂存,各带扩展名和档位(`blob-store.mjs`);游客视频条数用,fs、memory 两种实现都有 */
  inventory?(): Promise<{ stored: Array<{ hash: string; ext: string; tier: "small" | "original" }>; staging: Array<{ hash: string; ext: string; tier: "small" | "original" }> }>;
}

/** 缺省的数据层:fs 实现,目录是本地内容库;找文件、写索引、Content-Type 都用 vite-plugin-media 已有的 */
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

/** 产物命名空间的 Content-Type:快照是 HTML,init 是 mp4,分段是 m4s;其余照素材的表 */
function artifactContentType(ext: string): string {
  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  if (e === "html" || e === "htm") return "text/html; charset=utf-8";
  if (e === "m4s") return "video/iso.segment";
  return contentTypeForExt(e);
}

/** 产物命名空间的 fs 目录:`<root>/out/asset-store/<ns>`(契约第 1 节) */
export function artifactStoreDir(root: string, ns: "snap" | "px"): string {
  const scoped = projectScopeOfRoot(root);
  if (scoped) return scoped.dirs[ns];
  return process.env.PROMPTCUT_ARTIFACT_DIR ? path.resolve(process.env.PROMPTCUT_ARTIFACT_DIR, ns) : path.resolve(root, "out", "asset-store", ns);
}

/**
 * 产物命名空间(`snap` / `px`)缺省的数据层:fs 实现。钩子不写媒体索引,入库后什么都不做;
 * 找文件不扫目录,按 `ARTIFACT_EXTS` 依次直接查 `<hash>.<ext>`,最后查 `<hash>`(契约第 10 节第 6 条)。
 * 本模块不碰文件系统,「这个文件在不在」交给数据层的 `candidateFileResolver`。
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
 * 各条路由
 * ------------------------------------------------------------------ */

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** 数据层写入时磁盘满(`ENOSPC`)或超配额(`EDQUOT`):回 507,别的错误照旧 500 */
function isStorageFull(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  return code === "ENOSPC" || code === "EDQUOT";
}

/** 回完错误再掐断:请求体还在路上,别让它继续往服务端灌(和 http-guard.mjs 的 overLimit 同一个理由) */
function reject(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  // 声明了长度、且不超过一片的请求体:读完扔掉再回,客户端能干净地收到这个 4xx(不然它还在发、
  // 我们先掐了连接,它看到的只是 ECONNRESET)。长度不明或超过一片的才直接掐。
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

/** 请求体读完扔掉 */
function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => { req.on("end", resolve); req.on("error", () => resolve()); req.on("close", () => resolve()); req.resume(); });
}

/** 对账:`GET media/<hash>/chunks` 的回包。`store` 缺省是 `root` 的本地内容库 */
export async function chunkStatus(root: string, hash: string, store: AssetBlobStore = defaultAssetStore(root)) {
  return store.chunks(hash);
}

async function handlePutChunk(req: IncomingMessage, res: ServerResponse, store: AssetBlobStore, hash: string, rawN: string, ns: AssetNamespace = "media", writer: WriteTrace = NO_TRACE) {
  if (!/^(0|[1-9]\d*)$/.test(rawN)) return reject(req, res, 400, { ok: false, error: "bad-chunk-number" });
  const n = Number(rawN);
  const sizeHeader = String(req.headers["x-media-size"] || "").trim();
  if (!/^[1-9]\d*$/.test(sizeHeader)) return reject(req, res, 400, { ok: false, error: "missing-size", detail: "每一片都要带 X-Media-Size(全件字节数)" });
  const size = Number(sizeHeader);
  if (!Number.isSafeInteger(size) || size > ASSET_MAX_SIZE) return reject(req, res, 413, { ok: false, error: "too-large" });
  const count = chunkCount(size, store.chunkSize);
  if (n >= count) return reject(req, res, 416, { ok: false, error: "chunk-out-of-range", count });
  const expected = chunkLength(size, n, store.chunkSize);
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) !== expected) {
    return reject(req, res, 400, { ok: false, error: "chunk-length", expected, got: Number(declared) });
  }

  // 游客往 media 传:先过游客限额(尺寸看 X-Media-Size;视频原尺寸开新暂存时数条数),账号与别的命名空间直接写
  const guest = writer.guest;
  if (guest) {
    return guest.quota.putChunk({ accountId: writer.accountId, ns, size, hash, ext: extFromHeaders(req, ns), tier: tierFromHeaders(req), store, key: guest.key },
      () => writeChunk(req, res, store, hash, n, size, expected, ns, writer),
      (denied) => reject(req, res, denied.status, { ok: false, error: denied.error }));
  }
  return writeChunk(req, res, store, hash, n, size, expected, ns, writer);
}

async function writeChunk(req: IncomingMessage, res: ServerResponse, store: AssetBlobStore, hash: string, n: number, size: number, expected: number, ns: AssetNamespace, writer: WriteTrace) {
  // 托管方服务(渲染服务)写新块:先看容量上限,到了只拦它(成员的写入不走这里);块早已入库的没有新字节,不占名额
  const usage = writer.usage;
  const accounted = !!(usage && writer.service && usage.accounts(writer.service));
  let reservedHere = false;
  if (accounted && usage && !usage.has(ns, hash, writer.projectId) && !(await store.stat(hash))) {
    if (!usage.reserve(ns, hash, size, writer.projectId)) return reject(req, res, 507, { ok: false, error: "service-quota" });
    reservedHere = true;
  }
  // 没有服务标记的写入(成员或本机)写到了渲染服务记过账的块:这个块不再只归服务
  if (usage && !writer.service) usage.disown(ns, hash, writer.projectId);

  let out;
  try {
    out = await store.putChunk(hash, n, { size, ext: extFromHeaders(req, ns), tier: tierFromHeaders(req) }, req);
  } catch (err) {
    if (reservedHere) usage?.release(ns, hash, writer.projectId);
    // 磁盘满:这一片的标记没补(不算收到),已收的分片不动;请求体可能还在路上,回完就掐断
    if (isStorageFull(err)) return reject(req, res, 507, { ok: false, error: "insufficient-storage" });
    // 断线:对面已经不在了,回什么都收不到;这一片的标记没补,对账时报「没收到」
    if (!res.headersSent && !res.destroyed) sendJson(res, (err as any)?.status ?? 500, { ok: false, error: (err as any)?.code ?? (err instanceof Error ? err.message : String(err)) });
    return;
  }
  switch (out.status) {
    case "ok": return sendJson(res, 200, { ok: true, hash, n, bytes: out.bytes });
    // 已入库:数据层已经把请求体读完丢掉了,幂等回 200
    case "complete": return sendJson(res, 200, { ok: true, hash, n, bytes: expected, complete: true });
    case "size-mismatch": return reject(req, res, 409, { ok: false, error: "size-mismatch", size: out.size });
    case "out-of-range": return reject(req, res, 416, { ok: false, error: "chunk-out-of-range", count: out.count });
    case "length": return sendJson(res, 400, { ok: false, error: "chunk-length", expected: out.expected, got: out.got });
    case "discarded": return sendJson(res, 409, { ok: false, error: "staging-discarded" });
  }
}

async function handleComplete(res: ServerResponse, store: AssetBlobStore, hash: string, ns: AssetNamespace = "media", writer: WriteTrace = NO_TRACE) {
  // 游客往 media 收尾:在队里数已入库的条数,够了回 403、暂存留着;入库后再按文件头认一遍(见 completeBlob)
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
  // 收尾之前这个块已经入库:不是这次新写的(成员写的不记;渲染服务自己写过的只补项目归属)
  const existed = accounted ? !!(await store.stat(hash)) : true;
  const out = await store.complete(hash);
  if (usage && accounted && out.status === "hash-mismatch") usage.release(ns, hash, writer.projectId); // 这一哈希已收的分片全部丢弃,在途名额放掉
  if (usage && out.status === "ok") {
    if (!writer.service) usage.disown(ns, hash, writer.projectId);
    else if (accounted && (!existed || usage.has(ns, hash, writer.projectId))) usage.record({ ns, hash, size: out.size, projectId: writer.projectId as string });
  }
  // 游客:入库之后按这一条自己的文件头再认一遍(页面报的扩展名不算数),超了视频条数就把它删掉、回 403
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
 * 按哈希取回。响应头与 vite-plugin-media 的 serveFile 一样:200 / 206 / 416,
 * Content-Type、Content-Length、Accept-Ranges、Last-Modified(数据层给不出修改时间就不发)、Content-Range。
 */
async function serveBlob(req: IncomingMessage, res: ServerResponse, store: AssetBlobStore, hash: string, longCache = false) {
  const stat = await store.stat(hash);
  if (!stat) return sendJson(res, 404, { ok: false, error: "not-found" });
  const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
  const head = req.method === "HEAD";
  // Last-Modified:没有内容哈希的迁移期素材,帧管线按 `HEAD` 的 Content-Length + Last-Modified 打戳
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
  // 流先打开再发头:入库的东西万一刚被删,还能干净地回 404
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
 * 凭票据读写
 * ------------------------------------------------------------------ */

/**
 * 缺省的「本机」判据:对端是回环地址,且转发头里每一跳都是回环(经同机反向代理转来的不算,`auth/origin.mjs`)。
 * 舞台端口的反向代理转来的请求按它写进的真实对端判(`clientAddressOf`)
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = clientAddressOf(req);
  return address !== null && isLocalOrigin(req, address);
}

/** 数据层收尾成功之后、回包之前再判一次(游客按刚入库那一条的文件头认是不是视频);不过就删掉这一条、回它给的错误 */
type CompleteGate = () => Promise<{ ok: true } | { ok: false; status: number; error: string }>;

/**
 * 从请求体里先读出开头最多 `n` 个字节,再原样塞回去(`unshift`),后面的处理照常从头读整个请求体。
 * 游客整件上传按文件头认是不是视频用(`asset-store/guest-quota.mjs`)。请求体比 `n` 短就给全部。
 * 读到结尾(`ended`)时在同一拍里塞回,赶在 `end` 事件之前:`end` 发出去之后就塞不回去了。
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
    // 对面在开头那几十个字节到之前就断了:不留一个永远不落地的等待
    const onClose = () => finish(Object.assign(new Error("aborted"), { status: 400, code: "request-aborted" }));
    req.on("readable", onReadable);
    req.once("error", finish);
    req.once("close", onClose);
  });
}

/** 游客限额(`asset-store/guest-quota.mjs`):中间件一份,`key` 标识同一个数据层(托管下是项目,本机是那个数据层) */
interface GuestQuotaHook {
  putChunk(who: { accountId?: string; ns: string; size: number; hash: string; ext?: string; tier?: string; store: AssetBlobStore; key: unknown }, put: () => Promise<unknown>, deny: (d: { status: number; error: string }) => unknown): Promise<unknown>;
  complete(who: { accountId?: string; ns: string; hash: string; store: AssetBlobStore; key: unknown }, complete: (gate: CompleteGate | null) => Promise<unknown>, deny: (d: { status: number; error: string }) => unknown): Promise<unknown>;
  whole(who: { accountId?: string; bytes: number | null; ext?: string; peek?: () => Promise<Buffer>; store: AssetBlobStore; key: unknown; needsLength: boolean }): Promise<{ ok: true; release: () => void } | { ok: false; status: number; error: string }>;
}

/** 这次写入的来历:容量记账用(`usage`、`service`、`projectId`),游客限额用(`accountId`、`guest`) */
interface WriteTrace { usage?: ServiceUsageHook | null; service?: string; projectId?: string; accountId?: string; guest?: { quota: GuestQuotaHook; key: unknown } | null }
const NO_TRACE: WriteTrace = {};

/** 核对素材票据(`server/auth/asset-tickets.mjs`) */
export interface AssetTicketVerifier {
  verify(ticket: string): { ok: true; access: "r" | "rw"; projectId: string; userId: string; service?: string; actsFor?: "member" } | { ok: false; reason: string };
}

/** `Authorization: Bearer <票据>` 里的票据;没带或格式不对给 null */
function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

/** 查询串里的票据 `?t=`;没带给 null */
function queryTicketOf(req: IncomingMessage): string | null {
  const url = String(req.url || "");
  const i = url.indexOf("?");
  if (i < 0) return null;
  const t = new URLSearchParams(url.slice(i + 1)).get("t");
  return t ? t : null;
}

/** URL 查询串里有没有 `t` 参数(含空值 `?t=`) */
function hasQueryTicketParam(req: IncomingMessage): boolean {
  const url = String(req.url || "");
  const i = url.indexOf("?");
  return i >= 0 && new URLSearchParams(url.slice(i + 1)).has("t");
}

/**
 * 放行时带上这次写入是谁的票据(服务身份的票据有 `service`,`projectId` 是票据限定的项目;容量记账用),
 * 以及是谁在写(`accountId`:票据的 `userId`、托管下文档服务核过的主体的 `accountId`;游客限额用)。本机回环来源不带。
 */
type Access = { ok: true; service?: string; projectId?: string; accountId?: string } | { ok: false; status: 401 | 403; error: "unauthorized" | "forbidden" };
const DENY_401: Access = { ok: false, status: 401, error: "unauthorized" };
const DENY_403: Access = { ok: false, status: 403, error: "forbidden" };

/**
 * 这个请求放不放行。`write`:分片上传与收尾;否则是读。
 * 回环来源不看票据;别的来源按契约第 8 节:写只认 Bearer 的 `rw` 票据,读认 Bearer 的任何素材票据或查询串的 `r` 票据。
 * 托管方服务身份的票据(核对结果带 `service`,`docs/plan/hosted-render-contract.md` 第 1.6 节)只能往预渲染产物的命名空间
 * (`snap`、`px`)写,写素材原件(`media`)回 403。
 */
function accessOf(req: IncomingMessage, write: boolean, tickets: AssetTicketVerifier | null, isTrusted: (req: IncomingMessage) => boolean, ns?: string): Access {
  let trusted = false;
  try { trusted = !!isTrusted(req); } catch { trusted = false; }
  if (trusted) return { ok: true };
  if (!tickets) return DENY_401; // 没有凭证存储:非本机一律拒,失败即关
  const verify = (t: string) => {
    try { return tickets.verify(t); } catch { return { ok: false as const, reason: "error" }; }
  };
  const bearer = bearerOf(req);
  if (bearer !== null) {
    const v = verify(bearer);
    if (!v.ok) return DENY_401;
    if (write && v.access !== "rw") return DENY_403;
    // 代成员进项目的服务(云端 Agent,`docs/plan/cloud-agent-contract.md` 第 4.4 节):按成员本人的权限写素材原件(`media`),
    // 不许写预渲染产物;它写的块算成员的,不进托管方服务的容量账(回的结果不带 `service`)
    if (v.actsFor === "member") {
      if (write && ns !== "media") return DENY_403;
      return { ok: true, projectId: v.projectId, accountId: guestIdOfUserId(v.userId) ?? v.userId };
    }
    if (write && v.service && ns !== "snap" && ns !== "px") return DENY_403;
    return { ok: true, service: v.service, projectId: v.projectId, accountId: guestIdOfUserId(v.userId) ?? v.userId };
  }
  if (write) return DENY_401; // 写入一律不认查询串
  const q = queryTicketOf(req);
  if (q === null) return DENY_401;
  const v = verify(q);
  return v.ok && v.access === "r" ? { ok: true, service: v.service, projectId: v.projectId, accountId: guestIdOfUserId(v.userId) ?? v.userId } : DENY_401;
}

/* ------------------------------------------------------------------ *
 * 中间件
 * ------------------------------------------------------------------ */

/** 这条请求归不归素材服务的跨源规则管:`/api/asset/<ns>/...`(三个命名空间,严格匹配)和 `/@media/*` */
export function isAssetCorsPath(url: string | undefined): boolean {
  return isAssetServicePath(url) || String(url || "").startsWith("/@media/");
}

/**
 * 来源是不是回环或局域网地址:localhost / *.localhost / *.local、127.0.0.0/8、10/8、172.16/12、192.168/16、
 * 169.254/16、IPv6 的 ::1、fc00::/7、fe80::/10。素材服务要让局域网里的设备直接访问
 * (`docs/semantics/product/asset-service.md`「职责」),没说要让公网网页访问本机 ——
 * 私有网络访问只放给这些来源,取最保守的一边。认不出的来源一律当公网。
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
 * 素材服务路由的预检,**必须排在 vite 自带的 cors 中间件前面**。
 *
 * vite 的 `server.cors` 默认只放行 localhost / 127.0.0.1 / [::1] 的源,而且它排在所有插件中间件之前:
 * 局域网设备(比如 `http://192.168.1.50:8080`)的预检被它当场答成 204、却不带
 * `Access-Control-Allow-Origin`,浏览器判预检失败,请求根本到不了 assetServiceMiddleware(实测过)。
 * 所以媒体插件把这一个中间件插到 connect 栈的最前面(`middlewares.stack.unshift`),只答素材服务路由的 OPTIONS,
 * 别的请求原样放过。vite.config.ts 的 `server.cors` 不动,其余路由的跨源行为一点不变。
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
 * 素材服务的中间件。`/api/asset/<ns>/...`(`media`、`snap`、`px`)全部在这里答完;`/@media/*` 只补 CORS 头、答预检,
 * 取字节仍交给 `vite-plugin-media.ts` 的 mediaMiddleware(next)。别的请求原样 next。
 *
 * 选项(契约 `docs/plan/asset-store-contract.md` 第 3、4 节;`artifact-transfer-contract.md` 第 1 节):
 * - `stores`:三个命名空间各自的数据层 `{ media?, snap?, px? }`。缺的用缺省:`media` 是 `root` 的本地内容库
 *   (`defaultAssetStore`),`snap` / `px` 是 `<root>/out/asset-store/<ns>` 的 fs 实现(`defaultArtifactStore`,用到时才建);
 * - `store`:旧名,仍然认,当作 `stores.media`(两个都给时 `stores.media` 优先);
 * - `tickets`:核对素材票据的对象(`server/auth/asset-tickets.mjs`);缺省按 `<root>/out/docservice/auth`
 *   取进程内的凭证存储(与本进程的文档服务共用);给 null 表示不认任何票据(非本机一律 401);
 * - `isTrusted`:哪些请求算本机,缺省 `isLoopbackRequest`。
 * 集群令牌(C5 的 `token` 选项)已退役:给了也不认。
 */
/**
 * 托管方服务写成的块的容量记账(`asset-store/service-usage.mjs`,契约 `docs/plan/hosted-render-contract.md` 第 6 节)。
 * 只有托管组合给;票据核对结果带 `service` 且 `accounts(service)` 为真的写入才记账、才受上限约束,成员的写入不受影响。
 */
export interface ServiceUsageHook {
  accounts(service: string): boolean;
  has(ns: string, hash: string, projectId?: string): boolean;
  /** 新块放行与否(占在途名额);放不下回 false */
  reserve(ns: string, hash: string, size: number, projectId?: string): boolean;
  record(rec: { ns: string; hash: string; size: number; projectId: string }): void;
  release(ns: string, hash: string, projectId?: string): void;
  /** 别人写了同一个块:不再只归服务 */
  disown(ns: string, hash: string, projectId?: string): boolean;
}

export interface AssetServiceOptions {
  /** 云项目模式：必须同时给权威授权adapter与项目物理库；本机信任不能绕过它。中央owner挂载。 */
  projectStores?: any;
  projectAccess?: any;
  /** 托管方服务写入的容量记账(只有托管组合给);缺省与 null 都表示不记账 */
  serviceUsage?: ServiceUsageHook | null;
  stores?: { media?: AssetBlobStore; snap?: AssetBlobStore; px?: AssetBlobStore };
  store?: AssetBlobStore;
  tickets?: AssetTicketVerifier | null;
  isTrusted?: (req: IncomingMessage) => boolean;
  /**
   * `px` 的按需拉取(claude/bake-asset):本机没有这一块时向哪里取。缺省是当前连接的远程素材服务
   * (`media-pull.mjs` 的 `fetchRemoteArtifact`,没连远程就是没有);null 关掉。
   */
  pullArtifact?: ((ns: "px", hash: string) => Promise<{ bytes: Buffer; contentType?: string } | null>) | null;
  /**
   * `px` 的容量淘汰(claude/bake-asset,`asset-store/px-evict.mjs`):缺省在 `px` 用缺省 fs 数据层时开
   * (环境变量 `PROMPTCUT_PX_EVICT=0` 关);null 关掉;给对象可改上限与时机(单测用)。注入了自己的 `px` 数据层且没给这一项时不开。
   */
  pxEvict?: { capBytes?: number; options?: Record<string, number>; start?: boolean } | null;
}

/**
 * `px` 的按需拉取:取回来的整件(已由拉取方校验 sha256,这里再核一次)经数据层分片写入、收尾入库,之后就是本机命中。
 * 同一个哈希同时只拉一次。任何一步不成都当没有(调用方照旧回 404),不抛。
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
        if (r.status !== "ok") return; // "complete":别的请求已经入库了;其余:当没有
      }
      await store.complete(hash);
    } catch { /* 当没有 */ }
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
  // 缺省的核对器惰性加载:第一次有非本机请求带票据时才打开凭证存储
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
   * 游客素材限额(`asset-store/guest-quota.mjs`):只管游客往 media 写。按数据层排队:托管下每个项目一个数据层,
   * 用项目编号当键;本机只有一个 media 数据层,用它本身当键。
   */
  const guestQuota: GuestQuotaHook = createGuestAssetQuota({ isVideoExt: (ext: string) => contentTypeForExt(ext).startsWith("video/") });
  const guestTrace = (who: { projectId?: string; accountId?: string }) =>
    ({ accountId: who.accountId, guest: who.accountId ? { quota: guestQuota, key: opts.projectStores && who.projectId ? `project:${who.projectId}` : media } : null });
  /**
   * 托管下媒体中间件的整件上传(`POST /api/media/upload/<名>`)与补算内容键(`POST /api/media/adopt`)也往项目的 media 写,
   * 不经下面的分片路由。它们由 `vite-plugin-media.ts` 自己核权,这里只先看一眼是不是游客:是就按游客限额拦,
   * 放行后占着这个项目的游客队直到回完包;不是游客原样 next。
   * - 核权出错(包括暂时性的 503)照错误回,不往下放(claude/guest-fix〔裁〕,审查 S2):原先 `catch` 了就 next,
   *   媒体中间件再核一次、碰巧成功,这次游客的整件上传就没经过限额;
   * - 游客不能补算内容键(审查 S3):那条路给素材收集用,游客用不到;它会把媒体目录里任何文件(包括还没收尾、
   *   没核哈希的分片暂存 `.chunks/<哈希>/data`)挂进库,绕过收尾时的视频条数;
   * - 整件上传报的扩展名不是视频时,先从请求体里读出开头几十个字节按文件头认(`peekBody`,审查 A2)。
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
      // 扩展名:整件上传从 URL 里的文件名拿(和 vite-plugin-media 的 handleMediaUpload 同一取法),补算内容键从 `path` 参数的文件名拿
      let ext = "";
      try {
        const u = new URL(String(req.url || "/"), "http://promptcut.local");
        ext = extOfName(upload ? decodeURIComponent(u.pathname.split("/").pop() || "") : (u.searchParams.get("path") || ""));
      } catch { ext = ""; }
      verdict = await guestQuota.whole({ accountId, bytes, ext, peek: () => peekBody(req, SNIFF_BYTES), store: opts.projectStores.project(lease.projectId).stores.media, key: `project:${lease.projectId}`, needsLength: upload });
      }
    } catch (err: any) {
      // 读开头时对面断了、数据层出错:照错误回,不往下放
      verdict = { ok: false, status: err?.status ?? 500, error: err?.code ?? "media-failed" };
    } finally { void lease.release(); }
    if (!verdict.ok) return reject(req, res, verdict.status as 403, { ok: false, error: verdict.error });
    const release = verdict.release;
    res.once("close", release);
    res.once("finish", release);
    return next();
  };
  /*
   * px 的容量淘汰:在本进程内部做,不对外开删除接口。只拿 px 这一个数据层,media / snap 碰不到。
   * 惰性 import(好几个单测把本文件单独转译,静态 import 兄弟模块会解析失败)。
   */
  const pxEvictor: Promise<any> | null = (() => {
    if (opts.projectStores) return null; // 托管项目库不应用本地px淘汰规则
    if (opts.pxEvict === null || process.env.PROMPTCUT_PX_EVICT === "0") return null;
    if (opts.stores?.px && !opts.pxEvict) return null;
    const pxStore: any = storeOf("px");
    if (typeof pxStore.list !== "function") return null;
    const p = import("./asset-store/px-evict.mjs").then((mod: any) => {
      const ev = mod.createPxEvictor({
        dir: artifactStoreDir(root, "px"), store: pxStore, capBytes: opts.pxEvict?.capBytes, options: opts.pxEvict?.options,
        log: (event: string, fields: object = {}) => { try { console.info("[px-evict]", event, JSON.stringify(fields)); } catch { /* 不影响 */ } },
      });
      if (opts.pxEvict?.start !== false) ev.start();
      return ev;
    }).catch(() => null);
    return p;
  })();
  const touchPx = (hash: string) => { if (pxEvictor) void pxEvictor.then((ev) => ev?.touch(hash)); };  // px 的按需拉取:缺省惰性加载 media-pull(当前连接的远程素材服务);好几个单测把本文件单独转译,静态 import 兄弟模块会解析失败
  const pullArtifact: NonNullable<AssetServiceOptions["pullArtifact"]> | null = opts.pullArtifact === null ? null
    : opts.pullArtifact ?? (async (ns, hash) => {
      try {
        const mod: any = await import("./media-pull.mjs");
        return typeof mod.fetchRemoteArtifact === "function" ? await mod.fetchRemoteArtifact(ns, hash) : null;
      } catch { return null; }
    });
  /** 放不放行;不放行时已经回了 401 / 403(回 null);放行回这次访问的来历 */
  const admit = async (req: IncomingMessage, res: ServerResponse, write: boolean, ns?: string): Promise<Extract<Access, { ok: true }> | null> => {
    // 带查询串票据的响应:不缓存、不带 Referer 出去(契约第 8 节)
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
      // /@media/* 的 GET / HEAD:非本机要读票据,放行后交给 vite-plugin-media 的 mediaMiddleware
      try {
        if (!(await admit(req, res, false))) return;
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return next();
    }

    // 判据和同源守卫的豁免是同一条正则,守卫放过来的请求从这里起一定有回应,不会 next 给别的 /api 处理函数
    const parts = apiPath(req.url).split("/"); // ["", "api", "asset", <ns>, <hash>, <tail>?]
    const ns = parts[3] as AssetNamespace; // 正则只放过 media / snap / px
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
        // px 本机没有这一块:向当前连接的远程素材服务取一次再答(共享项目里别的成员推上去的卡片快照)
        // 带 x-promptcut-pull 的是别的素材服务替它的页面来拉的:不再往下拉,防两台互指成环
        if (!opts.projectStores && ns === "px" && pullArtifact && !req.headers["x-promptcut-pull"] && !(await store.stat(hash))) await pullArtifactInto(store, hash, pullArtifact);
        if (ns === "px") touchPx(hash);
        const longCache = Boolean(opts.projectAccess && ns === "media" && bearerOf(req) !== null && !hasQueryTicketParam(req));
        return await serveBlob(req, res, store, hash, longCache);
      }
      if (tail === "chunks") {
        if (method !== "GET") return sendJson(res, 405, { ok: false, error: "method" });
        if (!(await admit(req, res, false, ns))) return;
        const store = scopedStore();
        // 对账也算用过(卡片快照的索引每次命中、页面每轮盘点都问它):还在被用着的块不会被当成最久没用的淘汰掉
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
      // 收尾时磁盘满:数据层没有入库、暂存保留(fs 实现的收尾只在成功改名后才删暂存)
      if (isStorageFull(err)) return sendJson(res, 507, { ok: false, error: "insufficient-storage" });
      sendJson(res, (err as any)?.status ?? 500, { ok: false, error: (err as any)?.code ?? (err instanceof Error ? err.message : String(err)) });
    }
  };
  /** 单测、排查用:这个中间件的 px 淘汰器(没开是 null) */
  return Object.assign(handler, { pxEvictor: () => pxEvictor ?? Promise.resolve(null) });
}

/**
 * 预留的「合并分发」接口(`docs/semantics/mechanism/platforms.md`「预留的接口」;C10 契约第 11 节):
 * `POST merge/<projectId>/<共享键>`,现在一律回 501。各客户端把自己预渲染出的共享结果推给素材服务、由它合并去重后
 * 分发给其它客户端,这一步还没做;现在只实现推送自己的(`snap/`、`px/`)。
 *
 * 素材服务没有项目语义(`product/asset-service.md`):这条路由只占位,`<projectId>` 与共享键都不解析、不校验,
 * 不读请求体、不碰数据层、不核对票据。它不在同源守卫的豁免正则(`http-guard.mjs` 的 `ASSET_ROUTE`)里,
 * 由本中间件在最前面答掉,不会落到别的 `/api` 处理函数上。
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
  req.resume(); // 请求体不读,丢掉,连接照常收尾
  sendJson(res, 501, { ok: false, error: "not-implemented" });
}

/** 上传方每一片要带的请求头(测试和将来第 6 步的上传队列用) */
export function chunkHeaders(size: number, name?: string): Record<string, string> {
  const h: Record<string, string> = { "X-Media-Size": String(size) };
  const ext = extOfName(name || "");
  if (ext) h["X-Media-Ext"] = ext;
  return h;
}
