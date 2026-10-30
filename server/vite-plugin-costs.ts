import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadCosts, loadTuning, saveTuning, upsertCosts, filterCosts } from "./costs-store.mjs";
import { isPrerender } from "./render-role.mjs";
import { prerenderState } from "./prerender-client.mjs";

/**
 * K1 探针记录的 HTTP 面(目标 K/K1)。**两个进程都挂这一份插件**,和 A7 的镜像一样。
 *
 *   GET  /api/data/costs?device=<字符串>[&mode=dev|build]   → { ok, device, mode, costs, tuning }
 *   PUT  /api/data/costs  { records: [] }  → { ok, count, added, updated }
 *   PUT  /api/data/costs/tuning  { tuning: {…} | null }  → { ok, tuning }
 *
 * # 为什么 tuning 的写入口挂在这个前缀下
 *
 * R4a 只做了读(改系数靠人手编辑 `out/pipeline-tuning.json`),「不改代码就能调」只剩半条。
 * 写入口挂成 `/api/data/costs/tuning` 而不是另开一个顶层路由,是因为 connect 的
 * `middlewares.use(前缀)` 本来就把子路径一起收进来了 —— 读写同一份数据的两个口子在同一个
 * 中间件里,转发给预渲染进程那一段也能原样复用(两端必须用同一份系数,否则算不出同一张表)。
 * 请求体是 `{ tuning: {…} }`;`tuning` 给 `null` / 不是对象 = **清掉覆盖、全用缺省**(删文件)。
 * 落盘的是夹取之后的一份(见 `costs-store.mjs` 的 `saveTuning`)。不做界面。
 *
 * # 为什么 `tuning` 搭这趟车
 *
 * K2 的三个可调系数(`COST_SCALE` / `STEP_PERCENTILE` / `STEP_MIN_SAMPLES`)覆盖值存在本机
 * `out/pipeline-tuning.json`(没有这个文件 = 全用缺省)。`planPipelines` 在页面和预渲染进程
 * 各算一次、两端必须用**同一份系数**,而两端本来就都要拉 `costs` —— 再开一个端点只会多一个
 * 「一端拿到新系数、另一端还是旧的」的窗口。所以 GET 回包里**加一个 `tuning` 字段**,
 * 原有的 `{ ok, device, mode, costs }` 一个都不动:`scripts/probe-card-costs.mjs`、
 * `server/test/costs.test.mjs` 和将来的页面侧只读自己认识的字段,不受影响
 * (任务书 K2 写的是 `{ records, tuning }`,那会把 `costs` 改名、连带改掉全部现有调用方;
 *  加字段能达到同样的效果,代价小得多)。
 *
 * # 为什么预渲染那一端也要挂
 *
 * `user` / `full` 模式的预渲染进程要按 `costs` 算 `plan.prerenderSet`(K6 的
 * 降级 → 预渲染 → 就绪 → 切换那条闭环)。它自己的页面不跑探针,记录只能从编辑器进程来。
 * 和镜像同一个套路:编辑器进程落盘之后把**同一份 PUT** 原样转过去(不等回复),
 * 预渲染那一端的这份插件就地写自己那一份副本,`frame-pipeline.mjs` 在 4 帧批边界读它。
 * 转发丢了也不致命 —— 下一次探针 PUT 会把整批再带过去,而记录本身是幂等 upsert。
 *
 * `agent` 模式的预渲染进程用不上(Agent 的查询全活渲、不预渲染),但「是不是 agent 模式」
 * 在编辑器这一端看不出来(那是预渲染进程自己的启动参数),所以照转不误 —— 它那边只是
 * 多写一个没人读的文件,没有副作用。
 *
 * # 去重
 *
 * 按 `(identityKey, device)`,见 `server/costs-store.mjs`。`identityKey` 已含 fps,
 * 所以键里不再单列 fps。
 *
 * # 方法
 *
 * 语义上是整批 upsert,所以用 PUT;POST 也收(转发链路和某些旧调用方只会发 POST)。
 * 同源守卫(`vite-plugin-api-guard`)排在所有接口前面,这里不重复判。
 */

const MAX_BODY = 8 * 1024 * 1024;

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, res: ServerResponse, then: (d: any) => void) {
  let body = "", size = 0, over = false;
  req.on("data", (c: Buffer) => {
    if (over) return;
    size += c.length;
    if (size > MAX_BODY) { over = true; sendJson(res, 413, { ok: false, error: "探针记录太大" }); req.destroy(); return; }
    body += c;
  });
  req.on("end", () => {
    if (over) return;
    try { then(JSON.parse(body || "{}")); }
    catch (e: any) { sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
  });
}

function query(req: IncomingMessage, key: string): string | null {
  try { return new URL(req.url || "/", "http://127.0.0.1").searchParams.get(key); } catch { return null; }
}

/* ---------------------------------------------------------------- 转发 */

// 串成一条链发:两批探针记录同时飞的话,到达顺序没保证,后发的那一批可能先落盘。
// upsert 是幂等的,但「后写的是旧数据」仍然会让预渲染那一端短暂拿到过期成绩。
let forwardChain: Promise<unknown> = Promise.resolve();

/** 把这一次 PUT 转给当前就绪的预渲染进程。只有编辑器进程做这件事,而且不等回复 */
function forwardToPrerender(path: string, body: unknown) {
  if (isPrerender) return;
  const remote = prerenderState();
  if (!remote.ready || !remote.url) return;
  const url = remote.url + path;
  forwardChain = forwardChain.then(async () => {
    try {
      await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch { /* 预渲染没就绪 / 正在重启:下一批探针 PUT 会把记录再带过去 */ }
  }, () => {});
}

export function costsPlugin(): Plugin {
  return {
    name: "promptcut-costs",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      server.middlewares.use("/api/data/costs", (req, res) => {
        const method = String(req.method || "GET").toUpperCase();
        // connect 把前缀摘掉了:`/api/data/costs/tuning` 进来时 req.url 是 `/tuning`
        let sub = "/";
        try { sub = new URL(req.url || "/", "http://127.0.0.1").pathname.replace(/\/+$/, "") || "/"; } catch { sub = "/"; }

        if (sub === "/tuning") {
          if (method !== "PUT" && method !== "POST") return sendJson(res, 405, { ok: false, error: "PUT only" });
          return readBody(req, res, (d) => {
            /*
             * body 是 `{ tuning: {…} }`;裸对象也收(和 records 那一支一个待遇)。
             * `tuning: null` = 清掉覆盖、全用缺省。同源守卫由 vite-plugin-api-guard 统一挡在前面,
             * 这里不重复判(它已经保证:跨源 Origin 拒、带 body 必须是 application/json)。
             */
            const raw = d && typeof d === "object" && "tuning" in d ? d.tuning : d;
            try {
              const tuning = saveTuning(root, raw);
              sendJson(res, 200, { ok: true, tuning });
              // 两端必须用同一份系数,否则 planPipelines 算不出同一张表(K2)
              forwardToPrerender("/api/data/costs/tuning", { tuning: raw });
            } catch (e: any) {
              sendJson(res, 500, { ok: false, error: e?.message || String(e) });
            }
          });
        }
        if (sub !== "/") return sendJson(res, 404, { ok: false, error: `没有这个接口:${sub}` });

        if (method === "GET") {
          const device = query(req, "device");
          // mode(dev | build):分派用当前运行模式的记录(任务书 3.1);缺字段的旧记录当 dev
          const mode = query(req, "mode");
          const costs = filterCosts(loadCosts(root), device, mode);
          // tuning 是加出来的字段,原来四项一个不动(见文件头「为什么 tuning 搭这趟车」)
          return sendJson(res, 200, { ok: true, device: device ?? null, mode: mode ?? null, costs, tuning: loadTuning(root) });
        }
        if (method !== "PUT" && method !== "POST") return sendJson(res, 405, { ok: false, error: "GET / PUT only" });
        readBody(req, res, (d) => {
          const records = Array.isArray(d?.records) ? d.records : Array.isArray(d) ? d : null;
          if (!records) return sendJson(res, 400, { ok: false, error: "缺 records:[]" });
          try {
            const out = upsertCosts(root, records);
            sendJson(res, 200, { ok: true, count: out.count, added: out.added, updated: out.updated });
            forwardToPrerender("/api/data/costs", { records });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  };
}

export default costsPlugin;
