/**
 * Ingress guard for the prerender process:
 * Desktop app stage lockdown: card code inside the stage is not allowed to call local prerender
 * process endpoints.
 *
 * 1. Any request originating from the stage (Origin or Referer containing stage port or stage
 *    origin, or carrying x-pc-stage-client header) is unconditionally rejected with 403.
 * 2. Any cross-origin request (Origin exists and is not in PROMPTCUT_CORS_ORIGINS) without a valid
 *    internal token (x-pc-internal-token === PROMPTCUT_INTERNAL_TOKEN) is unconditionally rejected
 *    with 403.
 */
import { apiPath } from "./http-guard.mjs";
import { stagePortsOf } from "./stage-ports.mjs";

export const PRERENDER_DENY_BODY = JSON.stringify({ ok: false, error: "Stage or unauthorized cross-origin requests are not allowed to access the prerender endpoint" });

/**
 * The only two byte prefixes that the stage is permitted to pull read-only from the prerender
 * process (track streams and snapshot bytes)
 */
const STAGE_PRERENDER_READ_PREFIXES = ["/api/frames/stream/", "/api/frames/snapshot/"];

function sneaky(rawPath) {
  return /(^|\/)\.\.(\/|$)/.test(rawPath) || /\\|%2e|%2f|%5c|%00/i.test(rawPath);
}

function isStageReadStreamOrSnapshot(req) {
  const m = String(req.method || "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  const raw = String(req.url || "/");
  const rawPath = raw.split("?")[0];
  if (!rawPath.startsWith("/") || sneaky(rawPath)) return false;
  const p = apiPath(raw);
  return STAGE_PRERENDER_READ_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Get the set of currently configured stage ports
 */
export function getStagePorts() {
  const envPorts = String(process.env.PROMPTCUT_STAGE_PORTS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (envPorts.length > 0) return new Set(envPorts);
  const editorUrl = process.env.PROMPTCUT_EDITOR_URL;
  if (editorUrl) {
    try {
      const u = new URL(editorUrl);
      if (u.port) return new Set(stagePortsOf(Number(u.port)));
    } catch { /* Ignore format errors */ }
  }
  return new Set();
}

/**
 * Check whether request originates from stage or unauthorized cross-origin
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isPrerenderRequestAllowed(req) {
  // 1. Carries stage proxy client marker header
  if (req.headers && req.headers["x-pc-stage-client"] !== undefined) {
    if (isStageReadStreamOrSnapshot(req)) return { ok: true };
    return { ok: false, reason: "stage-client-header" };
  }

  const stagePorts = getStagePorts();
  const origin = typeof req.headers?.origin === "string" ? req.headers.origin.trim() : null;
  const referer = typeof req.headers?.referer === "string" ? req.headers.referer.trim() : null;

  // 2. Check if Origin is a stage port (stage is only allowed to pull /api/frames/stream/* and
  // /api/frames/snapshot/* bytes via GET/HEAD; all other endpoints return 403)
  if (origin) {
    try {
      const u = new URL(origin);
      const port = Number(u.port);
      if (port && stagePorts.has(port)) {
        if (isStageReadStreamOrSnapshot(req)) return { ok: true };
        return { ok: false, reason: "stage-origin" };
      }
    } catch { /* Non-valid URLs are intercepted in subsequent cross-origin checks */ }
  }

  // 3. Check if Referer contains a stage port
  if (referer) {
    try {
      const u = new URL(referer);
      const port = Number(u.port);
      if (port && stagePorts.has(port)) {
        if (isStageReadStreamOrSnapshot(req)) return { ok: true };
        return { ok: false, reason: "stage-referer" };
      }
    } catch { /* Ignore format anomalies */ }
  }

  // 4. Check cross-origin requests and internal token (allow prerender process's own same-origin
  // requests, such as headless Chrome loading modules at /?export=1)
  if (origin) {
    const host = typeof req.headers?.host === "string" ? req.headers.host.trim() : "";
    const isSameOrigin = host && (origin === `http://${host}` || origin === `https://${host}`);
    if (!isSameOrigin) {
      const allowedOrigins = new Set(String(process.env.PROMPTCUT_CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean));
      if (!allowedOrigins.has(origin)) {
        const token = req.headers?.["x-pc-internal-token"];
        const internalToken = process.env.PROMPTCUT_INTERNAL_TOKEN;
        if (!internalToken || token !== internalToken) {
          return { ok: false, reason: "cross-origin-no-token" };
        }
      }
    }
  }

  return { ok: true };
}

/**
 * Vite plugin: attached at the front of prerender process middleware
 */
export function prerenderGatePlugin() {
  return {
    name: "promptcut-prerender-gate",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const check = isPrerenderRequestAllowed(req);
        if (!check.ok) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          return res.end(PRERENDER_DENY_BODY);
        }
        next();
      });
    },
  };
}

export default prerenderGatePlugin;
