/**
 * Same-origin guard for local endpoints.
 *
 * # Why local services also need this
 *
 * This sidecar listens on 127.0.0.1, making it easy to think "only our own side can access it".
 * That is not true: **any web page in the user's browser can send requests to 127.0.0.1**.
 * Cross-origin XHR cannot read response bodies (the browser's same-origin policy blocks "reading"),
 * but **the request itself is still sent and side effects occur all the same**:
 * as long as it is a "simple request" (GET / HEAD, or POST whose Content-Type is one of
 * text/plain, application/x-www-form-urlencoded, or multipart/form-data),
 * there will be no preflight and the server cannot block it.
 *
 * A real example breached by this (caught in the 0.3.0 review): a malicious page sends a POST to
 * `/api/ai/config` with `Content-Type: text/plain` and body `{"api":{"baseUrl":"https://attacker"}}`.
 * Because writeConfig performs a partial merge, if there is no apiKey in the payload, the old one
 * is retained: thus the user's real API Key was preserved as is, and was sent along with the Key to
 * the attacker's server during the next chat. The attacker never needed to read any response from
 * start to finish.
 *
 * # Two defenses, used together
 *
 * 1. **Origin**: browsers always include Origin on cross-origin POSTs; reject if the value does
 *    not match this site.
 * 2. **Content-Type must be application/json**: this is not a simple request, so browsers will
 *    first send a preflight OPTIONS; since we return no CORS headers, the preflight fails, so
 *    cross-origin requests **cannot even reach the server**. This defense is harder than defense 1:
 *    it does not depend on the presence of an Origin header.
 *
 * Allowing requests without an Origin header is intentional: same-origin GETs, as well as curl /
 * built-in sidecars / MCP scripts do not carry an Origin. CSRF refers to "requests sent by the
 * browser on behalf of the user", and browsers always include Origin when sending cross-origin
 * POSTs.
 */
import path from "node:path";

/**
 * Normalize the request URL into the form "used to compare against route prefixes":
 * **lowercase + collapse duplicate slashes**, and strip query strings.
 *
 * Skipping this step causes serious issues. connect (vite's middleware layer) is
 * **case-insensitive** when matching routes:
 * node_modules/vite/dist/node/chunks/node.js:7059:
 *     if (path.toLowerCase().substr(0, route.length) !== route.toLowerCase()) return next(err);
 *
 * So `POST /aPi/ai/config` still lands on the handler for `/api/ai/config`. If the guard used
 * case-sensitive `startsWith("/api/")` checks, it would deem "this is not an API request" and let
 * it pass: the entire checkpoint is bypassed by a single uppercase letter. Tested in practice:
 * cross-origin text/plain hitting `/aPi/ai/config` actually changed `baseUrl` in `ai.json` to the
 * attacker's address.
 *
 * The same applies to duplicate slashes: `//api/x` can also match in connect.
 *
 * No percent-decoding: connect does not decode either, and `/%61pi/...` also does not match there
 * (tested returning 404); keeping both sides consistent prevents gaps where "one side accepts
 * while the other does not".
 */
export function apiPath(url) {
  return String(url || "/").split("?")[0].toLowerCase().replace(/\/{2,}/g, "/");
}

/**
 * Routes for the asset service (contract in the file header of `server/asset-service.ts`):
 * `/api/asset/<ns>/<hash>`, optionally followed by `/chunks`, `/complete`, or a chunk number.
 * `<ns>` only recognizes the three namespaces `media`, `snap`, and `px` (Section 1 of
 * `docs/plan/artifact-transfer-contract.md`); anything else does not count.
 *
 * The asset service must allow cross-origin requests by semantics ("Responsibilities" in
 * `docs/semantics/mechanism/asset-service.md`), so the same-origin guard for `/api/**` exempts it:
 * **only exempting paths that strictly match this regex**, evaluated against the normalized form of
 * `apiPath`; the asset service's own middleware also uses the same function to recognize routes.
 * Both sides recognize the same set of paths, so requests allowed by the guard are guaranteed to
 * land in the hands of the asset service and will not leak to other `/api` handlers.
 * Remaining `/api/**` routes (including internal editor whole-file uploads like `/api/media/upload/`)
 * are guarded as usual.
 */
const ASSET_ROUTE = /^\/api\/asset\/(?:media|snap|px)\/[0-9a-f]{64}(?:\/(?:chunks|complete|\d{1,10}))?$/;

export function isAssetServicePath(url) {
  return ASSET_ROUTE.test(apiPath(url));
}

/**
 * After LAN listening (`npm run dev` binds to 0.0.0.0 so devices like phones can directly access
 * the asset service), **"missing Origin header treated as trusted" holds only for this machine**:
 * any device on the LAN could curl `/api/**` directly without an Origin (driving Agents, reading
 * configs, deleting directories). Therefore, `/api/**` other than the asset service only answers
 * requests from the local loopback address by default; it is open to the LAN only when
 * `PROMPTCUT_LAN_API=1` is set.
 *
 * The reverse proxy for the stage port (`vite-plugin-stage-ports.ts`) forwards from 127.0.0.1 back to
 * vite, so the peer seen by vite is always loopback: the proxy therefore writes the real peer into
 * `STAGE_CLIENT_HEADER` (**overwriting** any incoming header with the same name). This header is
 * trusted only when the peer is loopback: forging it from a LAN device connecting directly to the
 * vite port is useless, because the peer address itself is not loopback.
 */
import { isLocalOrigin } from "./auth/origin.mjs";
export { forwardedHops, isLocalOrigin, remoteTagOf } from "./auth/origin.mjs";

export const STAGE_CLIENT_HEADER = "x-pc-stage-client";

/**
 * Whether this request came in via the stage port (sent by code in the stage window). The stage
 * port proxy writes `STAGE_CLIENT_HEADER` onto every forwarded request (overwriting any incoming
 * header), while requests directly connecting to the editor port do not have it. The stage window
 * runs code from user cards (which may be written by other members); to it, the stage port is
 * same-origin, so `originOk` cannot block it; endpoints that card code should not touch (fetching
 * tickets, modifying bindings) use this criterion as an additional guard. Directly connecting to the
 * editor port and adding this header yourself will only get you blocked and cannot bypass anything;
 * directly hitting the editor port from the stage window is cross-origin and cannot pass `originOk`.
 */
export function viaStagePort(req) {
  return req.headers?.[STAGE_CLIENT_HEADER] !== undefined;
}

/** Loopback addresses: 127.0.0.0/8, ::1, IPv4-mapped ::ffff:127.x */
export function isLoopbackAddress(address) {
  const a = String(address || "").toLowerCase();
  return a === "::1" || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

/** The real peer address of this request. Returns null if there is no socket (in-process direct calls, unit tests) */
export function clientAddressOf(req) {
  const remote = req.socket?.remoteAddress;
  if (!remote) return null;
  if (isLoopbackAddress(remote)) {
    const forwarded = req.headers?.[STAGE_CLIENT_HEADER];
    if (typeof forwarded === "string" && forwarded) return forwarded;
  }
  return remote;
}

/** Request from this machine? (In-process requests without a socket count as local; for those via reverse proxy, check forwarding headers using `isLocalOrigin`) */
export function fromLocalClient(req) {
  const address = clientAddressOf(req);
  return address === null || isLocalOrigin(req, address);
}

/** Whether `/api/**` other than the asset service should be exposed to the LAN */
export function lanApiAllowed() {
  return process.env.PROMPTCUT_LAN_API === "1";
}

/** Same-origin? Missing Origin header is treated as trusted (curl, sidecar, same-origin GET omit it) */
export function originOk(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  const host = req.headers?.host;
  if (origin === "http://" + host || origin === "https://" + host) return true;
  /*
   * The prerender process (PROMPTCUT_ROLE=prerender) allows origins from the editor side: the editor
   * page sends long-pending requests directly here to avoid occupying connections on its own origin
   * (docs/archive/topics/decoupling-plan.md section 1.1). The list is passed via environment variables
   * by vite-plugin-prerender which launches it, and only contains several forms for the local editor;
   * the user's own dev server does not have this variable, so behavior remains unchanged.
   */
  const allowed = String(process.env.PROMPTCUT_CORS_ORIGINS || "");
  return !!allowed && allowed.split(",").map((s) => s.trim()).includes(origin);
}

/** Whether Content-Type is application/json (including with charset) */
export function jsonContentType(req) {
  const ct = String(req.headers?.["content-type"] || "").toLowerCase();
  return ct.startsWith("application/json");
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Guard an endpoint. Returns true to allow through; if blocked, **a 403 has already been sent**, so
 * the caller should return directly.
 *
 * Usage: `if (!guard(req, res)) return;` placed on the first line of every /api handler.
 *
 * @param {object} opts
 *   - `json`: Whether to enforce JSON types other than application/x-www. Defaults to "required only
 *     for write methods". Endpoints like file uploads whose body is not JSON should pass
 *     `json: false`, leaving only the Origin check.
 */
export function guard(req, res, opts = {}) {
  const method = String(req.method || "GET").toUpperCase();
  const wantJson = opts.json ?? WRITE_METHODS.has(method);

  if (!originOk(req)) {
    return deny(res, "Cross-origin request denied");
  }
  if (wantJson && WRITE_METHODS.has(method) && !jsonContentType(req)) {
    // Also block requests not sent by browsers (such as curl forgetting headers): the purpose of this
    // gate is "simple requests cannot get in"; leaving a backdoor defeats the purpose. All our own code
    // uses JSON.
    return deny(res, "This endpoint only accepts Content-Type: application/json");
  }
  return true;
}

function deny(res, error) {
  if (!res.headersSent) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error }));
  }
  return false;
}

/**
 * Whether a path falls within the allowed root directories.
 *
 * Compare after path.resolve, and require the next character to be a separator: using only
 * startsWith would treat `C:\a\projects-evil` as inside `C:\a\projects`. The directory itself
 * with the exact name is included. Case-insensitive on Windows.
 */
export function isInside(child, parent) {
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Counts as valid if it falls within **any one** of the allowed root directories */
export function isInsideAny(child, parents) {
  return parents.some((p) => p && isInside(child, p));
}

/**
 * When request body exceeds the limit: **send 413 first, then close connection**. Returns true if
 * a response has already been sent, indicating the caller should not proceed further.
 *
 * We ran into both pitfalls in this single function:
 *
 * 1. Various places originally wrote `if (body.length > max) req.destroy()`, leaving 413 for
 *    `req.on('end')` to send. That 413 was dead code: destroy() directly destroys the underlying
 *    socket, and `end` **never triggers**. As a result, the server killed the connection silently,
 *    and the frontend received uninformative errors like "network error / connection interrupted".
 * 2. Changing to "sendJson first, then synchronous destroy()" was still not enough: `res.end()` is
 *    asynchronous, and calling destroy() synchronously right after often destroys the socket before
 *    those few bytes leave the kernel buffer, so the client still sees connection interrupted.
 *
 * Therefore, closing is moved into the `end` callback; if the callback does not fire (connection
 * was already broken), the fallback timer cleans up anyway.
 */
export function overLimit(req, res, len, max, message) {
  if (len <= max) return false;
  if (!res.headersSent) {
    res.statusCode = 413;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: message }), () => req.destroy());
    setTimeout(() => req.destroy(), 1000).unref?.();
  } else {
    req.destroy();
  }
  return true;
}
