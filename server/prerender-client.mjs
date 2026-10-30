/**
 * 界面那一端(ui)怎么够到预渲染进程。
 *
 * 状态由 vite-plugin-prerender 写入(它负责拉起、看护预渲染进程),其余插件只读:
 *   - vite-plugin-ai 的服务端工具(see_frames / get_gif / bake_card / inspect_card_dom)用 prerenderPost
 *     直接问预渲染 —— 不经过编辑器页面,也就不占编辑器那个源的浏览器连接;
 *   - 老地址(/api/vision/*、/api/ai/visual、/api/cards/dom)用 proxyToPrerender 原样转过去,
 *     给还没改成直连的调用方兜底。编辑器页面里挂得久的请求都已经改成直连预渲染的源了,
 *     转发只是兜底,别把它当成主路。
 */
import http from "node:http";

const state = { url: null, ready: false, error: null, restarts: 0 };

/** vite-plugin-prerender 用:更新状态 */
export function setPrerender(patch) {
  Object.assign(state, patch);
}

/** 此刻的状态快照 */
export function prerenderState() {
  return { ...state };
}

function fetchFailure(pathname, error) {
  const snapshot = prerenderState();
  const cause = error?.cause;
  const detail = cause?.code || cause?.message || error?.message || String(error);
  const where = snapshot.url || "预渲染地址未知";
  const message = `连接预渲染服务失败：请求 ${pathname} 时连接被关闭（${detail}）。` +
    ` 预渲染状态：${snapshot.ready ? "ready" : "未就绪"}，地址：${where}，重启次数：${snapshot.restarts}。` +
    " 可能是预渲染进程或 Chrome 崩溃/被回收，请稍后重试。";
  return Object.assign(new Error(message, { cause: error }), {
    code: "PRERENDER_UNAVAILABLE",
    status: 503,
    retryable: true,
  });
}

/** 等预渲染就绪。起进程 + Vite 就绪一般一两秒;首次要预构建依赖,给到 60 秒 */
export async function whenPrerenderReady(timeoutMs = 60000) {
  const t0 = Date.now();
  while (!state.ready) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`预渲染进程 ${Math.round(timeoutMs / 1000)} 秒内没有就绪${state.error ? `(${state.error})` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return state.url;
}

/**
 * 向预渲染 POST 一个 JSON,拿回 JSON。
 * `signal`:调用方不要了(MCP 桥超时、Agent 取消)就拨它 —— 连接一断,预渲染那边会把还在排队的活摘掉。
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
      throw Object.assign(new Error(`预渲染请求 ${pathname} 超过 ${Math.round(timeoutMs / 1000)} 秒没有回应。`), {
        code: "PRERENDER_TIMEOUT", status: 504, retryable: true, cause: error,
      });
    }
    throw fetchFailure(pathname, error);
  }
  const data = await res.json().catch(() => ({ ok: false, error: `预渲染返回了非 JSON(HTTP ${res.status})` }));
  if (!res.ok && data && data.ok !== false) data.ok = false;
  return data;
}

/**
 * 把这个请求原样转给预渲染(方法、路径、头、body、回应都照搬)。
 * 用 originalUrl:connect 按前缀挂中间件时会把 req.url 的前缀剥掉。
 *
 * `unavailable`:够不着预渲染进程(没就绪、连不上)时回什么。缺省是通用的 503 / 502
 * `PRERENDER_UNAVAILABLE`;只服务 Agent 的路由(`/api/cards/layout`)传
 * `{ status: 503, code: "NO_AGENT_LANE" }` —— 编辑器进程没有 Agent lane,转不过去就如实说,
 * 不在编辑器这一侧自己渲(T1a 审查 #14)。
 */
export function proxyToPrerender(req, res, { unavailable = null, waitMs = 30000 } = {}) {
  const fail = (status, error) => {
    if (res.headersSent) return res.destroy();
    res.statusCode = unavailable?.status ?? status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, code: unavailable?.code ?? "PRERENDER_UNAVAILABLE", retryable: true,
      error: unavailable?.error ? `${unavailable.error}（${error}）` : error }));
  };
  whenPrerenderReady(waitMs).then((base) => {
    const target = new URL(req.originalUrl || req.url, base);
    const headers = { ...req.headers, host: target.host };
    // 同源请求本来就不带 Origin;带了也是编辑器那一端的,预渲染按放行名单认它
    const up = http.request(target, { method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => fail(502, `连接预渲染服务失败：转发 ${target.pathname} 时连接被关闭（${e.code || e.message}）。请稍后重试。`));
    // 用户那边断了就别让预渲染接着干:断开会传过去,预渲染按断开摘掉排队的活
    res.on("close", () => { if (!res.writableEnded) up.destroy(); });
    req.pipe(up);
  }, (e) => fail(503, `连接预渲染服务失败：${e.message || e}`));
}
