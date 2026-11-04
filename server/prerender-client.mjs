/**
 * How the UI side (ui) reaches the prerender process.
 *
 * State is written by vite-plugin-prerender (responsible for launching and supervising the prerender
 * process); other plugins are read-only:
 *   - Server-side tools in vite-plugin-ai (see_frames / get_gif / bake_card / inspect_card_dom) use
 *     prerenderPost to query prerender directly: bypassing the editor page, thus avoiding occupying
 *     browser connections to the editor origin;
 *   - Legacy endpoints (/api/vision/*, /api/ai/visual, /api/cards/dom) use proxyToPrerender to forward
 *     as-is, serving as a fallback for callers not yet switched to direct connections. Long-hanging
 *     requests in the editor page have already switched to connect directly to the prerender origin;
 *     forwarding is only a fallback, do not treat it as the main path.
 */
import http from "node:http";
import { tr } from "./i18n.mjs";

const state = { url: null, ready: false, error: null, restarts: 0 };

/** Used by vite-plugin-prerender: updates state */
export function setPrerender(patch) {
  Object.assign(state, patch);
}

/** State snapshot at the current moment */
export function prerenderState() {
  return { ...state };
}

function fetchFailure(pathname, error) {
  const snapshot = prerenderState();
  const cause = error?.cause;
  const detail = cause?.code || cause?.message || error?.message || String(error);
  const where = snapshot.url || tr("prerender address unknown");
  const message = tr("Failed to connect to the prerender service: the connection was closed while requesting {0} ({1}).", pathname, detail) +
    tr(" Prerender state: {0}, address: {1}, restarts: {2}.", snapshot.ready ? "ready" : tr("not ready"), where, snapshot.restarts) +
    tr(" The prerender process or Chrome may have crashed or been reclaimed. Please retry later.");
  return Object.assign(new Error(message, { cause: error }), {
    code: "PRERENDER_UNAVAILABLE",
    status: 503,
    retryable: true,
  });
}

/** Waits for prerender ready. Starting process + Vite ready takes 1-2s; allows up to 60s for initial prebuild */
export async function whenPrerenderReady(timeoutMs = 60000) {
  const t0 = Date.now();
  while (!state.ready) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(tr("The prerender process was not ready within {0} seconds{1}", Math.round(timeoutMs / 1000), state.error ? `(${state.error})` : ""));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return state.url;
}

/**
 * POSTs a JSON to prerender and gets JSON back.
 * `signal`: trigger when caller aborts (MCP bridge timeout, Agent cancellation): once connection
 * breaks, prerender removes queued work.
 */
export async function prerenderPost(pathname, body, { timeoutMs = 180000, signal } = {}) {
  const base = await whenPrerenderReady();
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetch(base + pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === "TimeoutError") {
      throw Object.assign(new Error(tr("Prerender request {0} got no response after {1} seconds.", pathname, Math.round(timeoutMs / 1000))), {
        code: "PRERENDER_TIMEOUT", status: 504, retryable: true, cause: error,
      });
    }
    throw fetchFailure(pathname, error);
  }
  const data = await res.json().catch(() => ({ ok: false, error: tr("Prerender returned non-JSON (HTTP {0})", res.status) }));
  if (!res.ok && data && data.ok !== false) data.ok = false;
  return data;
}

/**
 * Forwards this request to prerender as-is (mirroring method, path, headers, body, and response).
 * Uses originalUrl: connect strips the req.url prefix when mounting middleware by prefix.
 *
 * `unavailable`: what to return when unreachable (not ready, connection failed). Default is generic
 * 503 / 502 `PRERENDER_UNAVAILABLE`; routes serving only Agents (`/api/cards/layout`) pass
 * `{ status: 503, code: "NO_AGENT_LANE" }`: the editor process has no Agent lane; if forwarding
 * fails, report so truthfully without rendering on the editor side (T1a review #14).
 */
export function proxyToPrerender(req, res, { unavailable = null, waitMs = 30000 } = {}) {
  const fail = (status, error) => {
    if (res.headersSent) return res.destroy();
    res.statusCode = unavailable?.status ?? status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, code: unavailable?.code ?? "PRERENDER_UNAVAILABLE", retryable: true,
      error: unavailable?.error ? tr("{0} ({1})", unavailable.error, error) : error }));
  };
  whenPrerenderReady(waitMs).then((base) => {
    const target = new URL(req.originalUrl || req.url, base);
    const headers = { ...req.headers, host: target.host };
    // Same-origin requests omit Origin; if present, it is from editor side, and prerender accepts via allowlist
    const up = http.request(target, { method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => fail(502, tr("Failed to connect to the prerender service: the connection was closed while forwarding {0} ({1}). Please retry later.", target.pathname, e.code || e.message)));
    // If user disconnects, stop prerender: disconnect is forwarded and prerender removes queued work
    res.on("close", () => { if (!res.writableEnded) up.destroy(); });
    req.pipe(up);
  }, (e) => fail(503, tr("Failed to connect to the prerender service: {0}", e.message || e)));
}
