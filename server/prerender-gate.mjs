/**
 * 预渲染进程的入口守卫：
 * 桌面版舞台锁死：舞台里的卡片代码不许调用本机预渲染进程接口。
 *
 * 1. 凡是来自舞台的请求（Origin、Referer 带舞台端口或舞台源，或带 x-pc-stage-client 头）一律 403 拒掉。
 * 2. 凡是跨源请求（Origin 存在且不在 PROMPTCUT_CORS_ORIGINS 中），若没有合法内部 token（x-pc-internal-token === PROMPTCUT_INTERNAL_TOKEN）一律 403 拒掉。
 */
import { apiPath } from "./http-guard.mjs";
import { stagePortsOf } from "./stage-ports.mjs";

export const PRERENDER_DENY_BODY = JSON.stringify({ ok: false, error: "舞台或未经授权的跨源请求禁止访问预渲染接口" });

/** 舞台唯二允许向预渲染进程只读拉取的字节前缀（轨道流与快照字节） */
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
 * 获取当前配置的舞台端口集合
 */
export function getStagePorts() {
  const envPorts = String(process.env.PROMPTCUT_STAGE_PORTS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (envPorts.length > 0) return new Set(envPorts);
  const editorUrl = process.env.PROMPTCUT_EDITOR_URL;
  if (editorUrl) {
    try {
      const u = new URL(editorUrl);
      if (u.port) return new Set(stagePortsOf(Number(u.port)));
    } catch { /* 忽略格式错误 */ }
  }
  return new Set();
}

/**
 * 检查请求是否来自舞台或未授权跨源
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isPrerenderRequestAllowed(req) {
  // 1. 带有舞台代理客户端标记头
  if (req.headers && req.headers["x-pc-stage-client"] !== undefined) {
    if (isStageReadStreamOrSnapshot(req)) return { ok: true };
    return { ok: false, reason: "stage-client-header" };
  }

  const stagePorts = getStagePorts();
  const origin = typeof req.headers?.origin === "string" ? req.headers.origin.trim() : null;
  const referer = typeof req.headers?.referer === "string" ? req.headers.referer.trim() : null;

  // 2. 检查 Origin 是否为舞台端口（舞台只许 GET/HEAD 拉取 /api/frames/stream/* 与 /api/frames/snapshot/* 字节，其余接口一律 403）
  if (origin) {
    try {
      const u = new URL(origin);
      const port = Number(u.port);
      if (port && stagePorts.has(port)) {
        if (isStageReadStreamOrSnapshot(req)) return { ok: true };
        return { ok: false, reason: "stage-origin" };
      }
    } catch { /* 非合法 URL 在后续跨源判断中拦截 */ }
  }

  // 3. 检查 Referer 是否包含舞台端口
  if (referer) {
    try {
      const u = new URL(referer);
      const port = Number(u.port);
      if (port && stagePorts.has(port)) {
        if (isStageReadStreamOrSnapshot(req)) return { ok: true };
        return { ok: false, reason: "stage-referer" };
      }
    } catch { /* 忽略格式异常 */ }
  }

  // 4. 检查跨源请求与内部 token（放行预渲染进程自己的同源请求，如无头 Chrome 加载 /?export=1 的模块）
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
 * Vite 插件：挂在预渲染进程中间件的最前列
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
