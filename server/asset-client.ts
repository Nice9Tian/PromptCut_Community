/**
 * 素材服务的客户端一侧:Agent 进程和预渲染进程**只经素材服务的 HTTP API** 取素材
 * (`docs/semantics/product/asset-service.md`「职责」第三条),不读本地内容库的目录。
 * 契约在 `asset-service.ts` 文件头。
 *
 * 这个模块**不 import vite-plugin-media / asset-service**:用它的一方只认地址,不认目录。
 *
 * # 素材服务的基址怎么定
 *
 * 按顺序取第一个有的:
 *
 * 1. `PROMPTCUT_EDITOR_URL` —— 预渲染进程由编辑器那一端的 dev server 拉起时给的
 *    (`vite-plugin-prerender.ts`)。本地素材服务第一版就挂在编辑器进程里,所以它就是素材服务的源。
 *    没有新加环境变量:现有这一个够用。
 * 2. 本进程自己的监听地址 —— 媒体插件起来时记下的(`rememberLocalAssetOrigin`)。这是**单进程形态**:
 *    Agent 跑在编辑器进程里(没有单独的预渲染进程,或者就是编辑器进程自己在处理请求),
 *    素材服务就在本进程,照样走回环地址的 HTTP,不直接读目录。
 * 3. 都没有(纯脚本、单测)→ null,调用方如实说「素材服务不可达」。
 *
 * 将来连远程素材服务(F4 切换所连接的服务)时,基址换成远程那一个即可,路径不变。
 */
import type { Plugin } from "vite";
import type { AddressInfo } from "net";
import http from "http";
import https from "https";

const ORIGIN_KEY = Symbol.for("promptcut.asset-service.local-origin");
type Holder = { [ORIGIN_KEY]?: string | null };

/** vite 的 httpServer 可能是 http / https / http2 的 Server,这里只用到它们共有的这几样 */
type Listening = { listening: boolean; address(): AddressInfo | string | null; once(event: "listening", fn: () => void): unknown };

/**
 * 记下本进程素材服务的地址。配置被打包过一次、模块可能有两份实例,所以放在 globalThis 上。
 * 监听在 0.0.0.0 / :: 上时用回环地址访问自己。
 */
export function rememberLocalAssetOrigin(server: Listening | null | undefined): void {
  if (!server) return;
  const record = () => {
    const addr = server.address();
    if (!addr || typeof addr === "string") return;
    let host = addr.address;
    if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
    else if (host.includes(":")) host = `[${host}]`;
    (globalThis as Holder)[ORIGIN_KEY] = `http://${host}:${addr.port}`;
  };
  if (server.listening) record();
  else server.once("listening", record);
}

/** 素材服务的源(不带尾斜杠);取不到返回 null */
export function assetServiceOrigin(): string | null {
  const editor = String(process.env.PROMPTCUT_EDITOR_URL || "").trim().replace(/\/+$/, "");
  if (editor) return editor;
  return (globalThis as Holder)[ORIGIN_KEY] || null;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * 项目里一条素材记录 → 素材服务上取它的 HTTP 地址(给 ffmpeg 当输入,ffmpeg 自己会用 Range 定位)。
 *
 * - 有内容哈希(`m.hash`,或 `url` 是 `/@media/<hash>[.ext]`)→ `/@media/<hash>`;
 * - 迁移期按文件名存的(`/@media/<文件名>`,或只剩一个落在素材目录里的 `path`)→ `/@media/<文件名>`。
 *
 * **只取最后一段文件名**,不接受任何目录:素材服务那一侧只在本地内容库里找,外面递进来的
 * `path` 再怎么写也指不到库外的文件(原来 `mediaFileOf` 的白名单边界,现在由素材服务守)。
 */
export function mediaHttpUrl(m: any, origin: string | null = assetServiceOrigin()): string | null {
  if (!origin) return null;
  const hash = String(m?.hash || "").toLowerCase();
  if (HASH.test(hash)) return `${origin}/@media/${hash}`;
  const raw = String(m?.url || m?.path || "");
  if (!raw || /^(blob|data):/i.test(raw)) return null;
  let base = raw.split("?")[0].split(/[/\\]/).pop() || "";
  // 解码之后再切一次:`a%2F..%2Fx` 按斜杠切不开,解码完才露出斜杠
  try { base = decodeURIComponent(base); } catch { /* 原样 */ }
  base = (base.split(/[/\\]/).pop() || "").replace(/\.\./g, "");
  if (!base) return null;
  return `${origin}/@media/${encodeURIComponent(base)}`;
}

/* ------------------------------------------------------------------ *
 * 远端节点的素材回退(契约 `docs/plan/render-queue-contract.md` J.6,设计附件第 4 节)
 * ------------------------------------------------------------------ */

const FALLBACK_KEY = Symbol.for("promptcut.asset-service.fallback-bases");
type FallbackHolder = { [FALLBACK_KEY]?: string[] };

/**
 * 按哈希寻址的素材在主源(`PROMPTCUT_EDITOR_URL`)上 404 时,依次改试的素材服务 API 基址
 * (形如 `http://<ip>:<port>/api/asset`,即服务地址登记里 `kind: 'asset'` 的 `urls`)。
 * 由队列模式的节点从 `service.endpoints` 里取、排除自己之后填进来(`vite-plugin-frames.ts`)。
 * 放在 `globalThis` 上:配置被打包过一次、模块可能有两份实例。空列表 = 不回退(缺省)。
 */
export function setMediaFallbackBases(list: unknown): string[] {
  const bases: string[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    const base = String(item ?? "").trim().replace(/\/+$/, "");
    try {
      const url = new URL(base);
      if ((url.protocol === "http:" || url.protocol === "https:") && !bases.includes(base)) bases.push(base);
    } catch { /* 不是地址:跳过 */ }
  }
  (globalThis as FallbackHolder)[FALLBACK_KEY] = bases;
  return [...bases];
}

const FALLBACK_TICKET_KEY = Symbol.for("promptcut.asset-service.fallback-ticket");
/** 取回退请求的票据:参数是这次要试的回退基址(与 `setMediaFallbackBases` 规整后的写法相同) */
export type FallbackTicketFn = (base: string) => Promise<string | null> | string | null;
type TicketHolder = { [FALLBACK_TICKET_KEY]?: FallbackTicketFn | null };

/**
 * 回退请求带的素材票据(M6a,`docs/plan/auth-contract.md` 第 8 节):回退基址是别的机器的素材服务,
 * 非回环来源读要票据。凭共享项目进入的节点把经文档服务取票据的函数填进来;null = 不带(缺省)。
 * 每试一个回退基址调一次,参数是那个基址:票据只在签发它的素材服务上有效,独立渲染主机加入的项目分属
 * 不同素材服务时要按基址挑(M6b 集成)。只加入一个项目的节点可以不看参数。
 */
export function setMediaFallbackTicket(fn: FallbackTicketFn | null): void {
  (globalThis as TicketHolder)[FALLBACK_TICKET_KEY] = typeof fn === "function" ? fn : null;
}

/** 现在的回退基址(拷贝) */
export function mediaFallbackBases(): string[] {
  return [...((globalThis as FallbackHolder)[FALLBACK_KEY] ?? [])];
}

/** `/@media/<64 位十六进制>`(可带扩展名、查询串)→ 小写哈希;别的路径回 null。只有这种素材走回退 */
function hashedMediaPath(url: string | undefined): string | null {
  const m = /^\/@media\/([0-9a-fA-F]{64})(?:\.[A-Za-z0-9]{1,8})?(?:\?.*)?$/.exec(String(url || ""));
  return m ? m[1].toLowerCase() : null;
}

/** 回退请求只带这几个头(Range 透传);回退地址是另一台机器,不转发本机的 Cookie 之类 */
const FALLBACK_HEADERS = ["range", "if-range", "accept", "accept-encoding", "user-agent"];

/**
 * J.6:主源答不了(404,或连不上)时依次试回退基址上的 `<base>/media/<hash>`。第一个不是 404 的答复原样转给页面
 * (状态码、响应头、字节都不改);全都不行就回主源那个答复(`primary`)。每个基址只试一次,超时 10 秒。
 */
function serveFromFallbacks(req: http.IncomingMessage, res: http.ServerResponse, hash: string, bases: string[],
  primary: { status: number; headers: http.IncomingHttpHeaders; body?: string }) {
  const headers: Record<string, string> = {};
  for (const name of FALLBACK_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  let settled = false;
  let current: http.ClientRequest | null = null;
  res.on("close", () => { if (!res.writableFinished) current?.destroy(); });
  const ticketOf = (globalThis as TicketHolder)[FALLBACK_TICKET_KEY];
  const attempt = (i: number) => {
    if (settled || res.destroyed) return;
    if (i >= bases.length) {
      settled = true;
      if (res.headersSent) return void res.destroy();
      // 主源答复的正文已经丢掉了:长度、分块、压缩这几个头不能照搬
      const out = { ...primary.headers };
      delete out["content-length"]; delete out["transfer-encoding"]; delete out["content-encoding"];
      res.writeHead(primary.status, out);
      res.end(primary.body);
      return;
    }
    let url: URL;
    try { url = new URL(`${bases[i]}/media/${hash}`); } catch { return attempt(i + 1); }
    if (typeof ticketOf !== "function") return request(i, url, headers);
    // 票据只进 Authorization 头,不进地址与日志;按这个基址取,取不到就不带
    const base = bases[i];
    Promise.resolve().then(() => ticketOf(base)).then((t) => {
      const withTicket = { ...headers };
      if (typeof t === "string" && t !== "") withTicket.authorization = `Bearer ${t}`;
      return withTicket;
    }, () => ({ ...headers })).then((h) => request(i, url, h));
  };
  const request = (i: number, url: URL, h: Record<string, string>) => {
    if (settled || res.destroyed) return;
    let moved = false;
    const next = () => { if (!moved) { moved = true; attempt(i + 1); } };
    const lib = url.protocol === "https:" ? https : http;
    const upstream = lib.request(url, { method: req.method, headers: h }, (up) => {
      if (up.statusCode === 404 || settled) { up.resume(); return next(); }
      moved = true;
      settled = true;
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    current = upstream;
    upstream.setTimeout(10_000, () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      if (moved && settled) { if (!res.writableFinished) res.destroy(); return; }
      next();
    });
    upstream.end();
  };
  attempt(0);
}

/* ------------------------------------------------------------------ *
 * 预渲染进程:素材路由转发到素材服务
 * ------------------------------------------------------------------ */

/** 这些路径在预渲染进程里原来由它自己挂的 mediaPlugin 直接读目录答;现在一律转发 */
function isMediaRoute(url: string | undefined): boolean {
  const u = String(url || "").toLowerCase();
  return u.startsWith("/@media/") || u.startsWith("/api/asset/") || u.startsWith("/api/media/");
}

/**
 * 预渲染进程的素材路由:原样转发给素材服务(`origin`),本进程不碰本地内容库。
 *
 * 渲染用的 Chrome 从预渲染进程的源加载导出页,页面里的 `/@media/<hash>` 是相对地址,
 * 所以这个源上还得答这些路由 —— 答法换成转发:方法、请求头(含 Range)、请求体、状态码、
 * 响应头(含 Content-Range / Accept-Ranges)全部透传,字节一个不改。
 *
 * J.6:设了回退基址(`setMediaFallbackBases`)时,GET / HEAD 按哈希寻址的素材(`/@media/<64 位十六进制>`)
 * 在主源 404 或连不上的情况下改走回退(`serveFromFallbacks`)。没有回退基址、或别的请求,和原来逐字节一样。
 */
export function assetProxyPlugin(origin: string): Plugin {
  const target = new URL(origin);
  const client = target.protocol === "https:" ? https : http;
  return {
    name: "promptcut-asset-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!isMediaRoute(req.url)) return next();
        const headers = { ...req.headers, host: target.host };
        const method = String(req.method || "GET").toUpperCase();
        const hash = method === "GET" || method === "HEAD" ? hashedMediaPath(req.url) : null;
        const bases = hash ? mediaFallbackBases() : [];
        if (hash && bases.length) {
          // 有回退基址:主源的 404 先不转给页面,改试回退;其余答复照旧原样转
          let handed = false;
          const fallback = (primary: { status: number; headers: http.IncomingHttpHeaders; body?: string }) => {
            if (handed) return;
            handed = true;
            serveFromFallbacks(req, res, hash, bases, primary);
          };
          const upstream = client.request({
            protocol: target.protocol, hostname: target.hostname, port: target.port,
            method: req.method, path: req.url, headers,
          }, (up) => {
            if (up.statusCode === 404) { up.resume(); return fallback({ status: 404, headers: up.headers }); }
            handed = true;
            res.writeHead(up.statusCode || 502, up.headers);
            up.pipe(res);
          });
          upstream.on("error", (err) => {
            if (res.headersSent) return void res.destroy();
            fallback({ status: 502, headers: { "content-type": "text/plain; charset=utf-8" }, body: `素材服务不可达(${origin}):${err.message}` });
          });
          res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
          req.pipe(upstream);
          return;
        }
        const upstream = client.request({
          protocol: target.protocol, hostname: target.hostname, port: target.port,
          method: req.method, path: req.url, headers,
        }, (up) => {
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        });
        upstream.on("error", (err) => {
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(`素材服务不可达(${origin}):${err.message}`);
          } else res.destroy();
        });
        // 页面那边中途不要了(拖动进度条换 Range 是常事),上游那一条也立刻收掉
        res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
        req.pipe(upstream);
      });
    },
  };
}
