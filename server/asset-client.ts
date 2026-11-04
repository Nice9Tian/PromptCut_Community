/**
 * Client side of asset service: Agent process and prerender process fetch assets **only via asset
 * service HTTP API** (item 3 of "Responsibilities" in `docs/semantics/product/asset-service.md`),
 * without reading local content store directory. Contract is at the top of `asset-service.ts`.
 *
 * This module **does not import vite-plugin-media / asset-service**: consumers only know
 * addresses, not directories.
 *
 * # How asset service base URL is determined
 *
 * Take the first available in order:
 *
 * 1. `PROMPTCUT_EDITOR_URL`: provided when prerender process is launched by the dev server on
 *    editor side (`vite-plugin-prerender.ts`). First version of local asset service is hosted inside
 *    editor process, so it is the asset service origin. No new environment variables added: the
 *    existing one is sufficient.
 * 2. This process's own listening address: recorded when media plugin starts up
 *    (`rememberLocalAssetOrigin`). This is **single-process mode**: Agent runs inside editor
 *    process (no separate prerender process, or editor process itself is handling requests), asset
 *    service is in this process, still using loopback HTTP without directly reading directory.
 * 3. Neither available (plain scripts, unit tests) → null, caller accurately reports "asset
 *    service unreachable".
 *
 * When connecting to remote asset service in the future (F4 switch connected service), simply
 * replace base URL with remote one; paths remain unchanged.
 */
import type { Plugin } from "vite";
import type { AddressInfo } from "net";
import http from "http";
import https from "https";
import { tr } from "./i18n.mjs";

const ORIGIN_KEY = Symbol.for("promptcut.asset-service.local-origin");
type Holder = { [ORIGIN_KEY]?: string | null };

/** Vite httpServer may be http / https / http2 Server; only these shared properties are used here */
type Listening = { listening: boolean; address(): AddressInfo | string | null; once(event: "listening", fn: () => void): unknown };

/**
 * Record the address of the asset service in this process. Config was bundled once and module may
 * have two instances, so store on globalThis. When listening on 0.0.0.0 / ::, use loopback address
 * to access itself.
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

/** Asset service origin (without trailing slash); returns null if unavailable */
export function assetServiceOrigin(): string | null {
  const editor = String(process.env.PROMPTCUT_EDITOR_URL || "").trim().replace(/\/+$/, "");
  if (editor) return editor;
  return (globalThis as Holder)[ORIGIN_KEY] || null;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * An asset record in a project → fetch its HTTP URL on the asset service (used as ffmpeg input;
 * ffmpeg seeks using Range on its own).
 *
 * - Has content hash (`m.hash`, or `url` is `/@media/<hash>[.ext]`) → `/@media/<hash>`;
 * - Stored by filename during migration (`/@media/<filename>`, or only a `path` inside the asset
 *   catalog remains) → `/@media/<filename>`.
 *
 * **Take only the last filename segment**, do not accept any directory: the asset service side
 * only looks in the local content store; no matter how an incoming `path` from outside is written,
 * it cannot point to files outside the store (the whitelist boundary previously in `mediaFileOf`
 * is now guarded by the asset service).
 */
export function mediaHttpUrl(m: any, origin: string | null = assetServiceOrigin()): string | null {
  if (!origin) return null;
  const hash = String(m?.hash || "").toLowerCase();
  if (HASH.test(hash)) return `${origin}/@media/${hash}`;
  const raw = String(m?.url || m?.path || "");
  if (!raw || /^(blob|data):/i.test(raw)) return null;
  let base = raw.split("?")[0].split(/[/\\]/).pop() || "";
  // Split again after decoding: `a%2F..%2Fx` cannot be split by slash; the slash only appears after decoding
  try { base = decodeURIComponent(base); } catch { /* As is */ }
  base = (base.split(/[/\\]/).pop() || "").replace(/\.\./g, "");
  if (!base) return null;
  return `${origin}/@media/${encodeURIComponent(base)}`;
}

/* ------------------------------------------------------------------ *
 * Asset fallback for remote nodes (contract `docs/plan/render-queue-contract.md` J.6,
 * design appendix section 4)
 * ------------------------------------------------------------------ */

const FALLBACK_KEY = Symbol.for("promptcut.asset-service.fallback-bases");
type FallbackHolder = { [FALLBACK_KEY]?: string[] };

/**
 * Asset service API base URLs tried in sequence when hash-addressed assets 404 on the primary
 * source (`PROMPTCUT_EDITOR_URL`) (formatted like `http://<ip>:<port>/api/asset`, i.e. `urls` with
 * `kind: 'asset'` in the service endpoint registry).
 * Populated here by queue-mode nodes from `service.endpoints` after excluding itself
 * (`vite-plugin-frames.ts`).
 * Stored on `globalThis`: config is bundled once, and the module may have two instances.
 * Empty list = no fallback (default).
 */
export function setMediaFallbackBases(list: unknown): string[] {
  const bases: string[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    const base = String(item ?? "").trim().replace(/\/+$/, "");
    try {
      const url = new URL(base);
      if ((url.protocol === "http:" || url.protocol === "https:") && !bases.includes(base)) bases.push(base);
    } catch { /* Not an address: skip */ }
  }
  (globalThis as FallbackHolder)[FALLBACK_KEY] = bases;
  return [...bases];
}

const FALLBACK_TICKET_KEY = Symbol.for("promptcut.asset-service.fallback-ticket");
/**
 * Get ticket for fallback requests: parameter is the fallback base URL to try this time
 * (same format as normalized in `setMediaFallbackBases`)
 */
export type FallbackTicketFn = (base: string) => Promise<string | null> | string | null;
type TicketHolder = { [FALLBACK_TICKET_KEY]?: FallbackTicketFn | null };

/**
 * Asset ticket carried by fallback requests (M6a, `docs/plan/auth-contract.md` section 8):
 * the fallback base URL is an asset service on another machine, and reading from non-loopback
 * sources requires a ticket. Nodes entering via a shared project populate a function here that
 * fetches tickets via the document service; null = do not include (default).
 * Called once for each fallback base URL attempted, with that base URL as the argument: tickets
 * are only valid on the asset service that issued them; when projects joined by a standalone render
 * host belong to different asset services, select by base URL (M6b integration). Nodes joining
 * only one project can ignore the argument.
 */
export function setMediaFallbackTicket(fn: FallbackTicketFn | null): void {
  (globalThis as TicketHolder)[FALLBACK_TICKET_KEY] = typeof fn === "function" ? fn : null;
}

/** Current fallback base URLs (copy) */
export function mediaFallbackBases(): string[] {
  return [...((globalThis as FallbackHolder)[FALLBACK_KEY] ?? [])];
}

/**
 * `/@media/<64-digit hex>` (optional extension, query string) → lowercase hash; other paths
 * return null. Only this kind of asset uses fallback
 */
function hashedMediaPath(url: string | undefined): string | null {
  const m = /^\/@media\/([0-9a-fA-F]{64})(?:\.[A-Za-z0-9]{1,8})?(?:\?.*)?$/.exec(String(url || ""));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Fallback requests only carry these headers (Range passed through); fallback address is another
 * machine, do not forward local Cookies, etc.
 */
const FALLBACK_HEADERS = ["range", "if-range", "accept", "accept-encoding", "user-agent"];

/**
 * J.6: When the primary source cannot answer (404, or cannot connect), try `<base>/media/<hash>`
 * on fallback base URLs in sequence. Forward the first response that is not 404 to the page as-is
 * (status code, response headers, and bytes all untouched); if none succeed, return the primary
 * source's response (`primary`). Each base URL is tried only once, with a 10-second timeout.
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
      // The primary source response body was discarded: length, chunking, and compression headers
      // cannot be copied directly
      const out = { ...primary.headers };
      delete out["content-length"]; delete out["transfer-encoding"]; delete out["content-encoding"];
      res.writeHead(primary.status, out);
      res.end(primary.body);
      return;
    }
    let url: URL;
    try { url = new URL(`${bases[i]}/media/${hash}`); } catch { return attempt(i + 1); }
    if (typeof ticketOf !== "function") return request(i, url, headers);
    // Tickets only go into the Authorization header, not into URLs or logs; fetch for this base URL,
    // omit if unavailable
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
 * Prerender process: forward asset routes to asset service
 * ------------------------------------------------------------------ */

/**
 * In the prerender process, these paths were previously served by its own mounted mediaPlugin
 * reading directories directly; now they are all forwarded
 */
function isMediaRoute(url: string | undefined): boolean {
  const u = String(url || "").toLowerCase();
  return u.startsWith("/@media/") || u.startsWith("/api/asset/") || u.startsWith("/api/media/");
}

/**
 * Asset routes in the prerender process: forward as-is to the asset service (`origin`); this
 * process does not touch the local content store.
 *
 * The Chrome instance used for rendering loads the export page from the prerender process origin.
 * `/@media/<hash>` in the page is a relative URL, so this origin still must answer these routes:
 * the mechanism is changed to forwarding: method, request headers (including Range), request body,
 * status code, and response headers (including Content-Range / Accept-Ranges) are all passed
 * through, without altering a single byte.
 *
 * J.6: When fallback base URLs are configured (`setMediaFallbackBases`), GET / HEAD for
 * hash-addressed assets (`/@media/<64-digit hex>`) fall back (`serveFromFallbacks`) if the primary
 * source returns 404 or cannot connect. With no fallback base URLs, or for other requests, it is
 * byte-for-byte identical to before.
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
          // Fallback base URLs present: do not forward the primary source's 404 to the page yet, try fallback
          // instead; other responses are forwarded as-is as before
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
            fallback({ status: 502, headers: { "content-type": "text/plain; charset=utf-8" }, body: tr("Asset service unreachable ({0}): {1}", origin, err.message) });
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
            res.end(tr("Asset service unreachable ({0}): {1}", origin, err.message));
          } else res.destroy();
        });
        // If the page cancels midway (scrubbing the progress bar to change Range is common),
        // tear down upstream immediately too
        res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
        req.pipe(upstream);
      });
    },
  };
}
