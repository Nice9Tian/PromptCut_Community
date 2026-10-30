import type { Plugin, ViteDevServer } from "vite";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { isPrerender } from "./render-role.mjs";
import { prerenderState, setPrerender } from "./prerender-client.mjs";
import { repushMirror, replayReadySessions } from "./vite-plugin-mirror";
import { stageOriginsOf, stagePortsOf } from "./stage-ports.mjs";
import { listenSafe } from "./safe-port.mjs";
import { createSessionLineForwarder } from "./render-node/session-diag.mjs";
import { autoRenderNodeOffReason, normalizeBinding, ticketOk } from "./auto-render-node.mjs";
import { createBindingMemory, createTicketRelay } from "./render-node-relay.mjs";
import { localPrerenderMode } from "./prerender-mode.mjs";

/**
 * 拉起并看护预渲染进程(docs/archive/topics/decoupling-plan.md 第 3 节「预渲染」,阶段 2)。
 *
 * 编辑器这一端的 dev server 一开始监听,就用同一个 node 起第二个 Vite(vite.prerender.config.ts),
 * 放在另一个端口上,**进程优先级设成低于正常**。之后它拉起的渲染 worker 和 Chrome 都继承这个优先级
 * (Windows 上子进程默认继承父进程的 BELOW_NORMAL),所以 Agent 同时开几个 Chrome 在渲,
 * 系统也会先把 CPU 分给编辑器和界面自己那对热备渲染器。
 *
 * 页面从 /api/prerender/info 拿到它的地址,挂得久的请求(预渲染、动图、导出进度)直接发过去。
 */

/** 连续崩几次就不再重启,免得一个起不来的进程被无限拉起 */
const MAX_RESTARTS = 5;

/**
 * 给预渲染进程挑一个空端口。不能直接 `listen(0)`:动态端口段被改到低段的机器上会拿到
 * 1719、6000、6665 这类「坏端口」,浏览器以 ERR_UNSAFE_PORT 拒绝、Node 的 fetch 报 bad port,
 * 预渲染进程起来了也没人连得上。`listenSafe` 拿到坏端口就换(server/safe-port.mjs)。
 */
async function freePort(): Promise<number> {
  const s = net.createServer();
  s.unref();
  const port = await listenSafe(s, "127.0.0.1");
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** 编辑器那一端可能被浏览器以哪几种写法打开 —— 预渲染的跨源放行名单 */
/**
 * 放行给预渲染进程的源。编辑器自己那个源,**外加两个舞台端口的源**(E1):
 * 舞台 iframe 里的页面打预渲染进程(J3 的快照字节、C3 的 SSE)时带的 Origin 是它自己的源,
 * 不是编辑器的源 —— 漏掉就是一片 403。
 */
function editorOrigins(server: ViteDevServer): string[] {
  const addr = server.httpServer?.address() as AddressInfo | null;
  const port = addr?.port || server.config.server.port || 5190;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, ...stageOriginsOf(port)];
}

/**
 * 起第二个 Vite 用的那个 bin 在哪。
 *
 * 先看 `<root>/node_modules/vite/bin/vite.js`(常规安装),**找不到就按模块解析** ——
 * git worktree 里没有自己的 `node_modules`(Node 会往上走到主仓库那一份),
 * pnpm 的非提升布局同理。写死路径的话这两种情况下预渲染进程根本起不来,
 * 而症状只是「一直没就绪」,很难看出是解析问题。
 *
 * vite 的 `exports` 不放行 `./bin/vite.js`,所以解析主入口再回到包根。
 */
function viteBin(root: string): string {
  const local = path.join(root, "node_modules", "vite", "bin", "vite.js");
  if (fs.existsSync(local)) return local;
  try {
    const main = createRequire(import.meta.url).resolve("vite");
    const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
    if (at < 0) return local;
    const guess = path.join(main.slice(0, at + 6), "bin", "vite.js");
    return fs.existsSync(guess) ? guess : local;
  } catch { return local; }
}

function killTree(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || !child.pid) return;
  // 预渲染自己还拉着渲染 worker 和 Chrome,只杀它会留孤儿
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGKILL");
}

export function prerenderPlugin(): Plugin {
  return {
    name: "promptcut-prerender",
    configureServer(server: ViteDevServer) {
      if (isPrerender) return;
      const root = server.config.root;

      server.middlewares.use("/api/prerender/info", (_req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        const s = prerenderState();
        // `mode`:拉起时给它的模式(`prerender-mode.mjs`),只多一个键
        res.end(JSON.stringify({ ok: true, url: s.url, ready: s.ready, error: s.error, mode }));
      });

      /*
       * 预渲染进程的模式(docs/semantics/mechanism/rendering.md「查询渲染与预渲染进程」;cloud-task.md I4(a)):
       * 用户机缺省一个进程,本机有 Agent 时 `full`、没有时 `user`。编辑器进程总挂着本机 Agent(`vite-plugin-ai`),
       * 所以缺省 `full`;编辑器的环境里显式给了 `PROMPTCUT_PRERENDER_MODE` 就照它(`localPrerenderMode`)。
       */
      const mode = localPrerenderMode(process.env);

      let child: ChildProcess | null = null;
      let closing = false;
      const tail: string[] = [];

      /*
       * ---------------- 桌面应用自动成为共享项目的渲染节点(编辑器进程一侧,`server/render-node-relay.mjs`) ----------------
       *
       *   POST /api/render-node/bind            页面:进入共享项目 { url, projectId, assetBase?, contentId?, ticket? };记下(票据不记)转给预渲染进程
       *   POST /api/render-node/unbind          页面:离开项目 / 取消协作 { projectId };转过去撤掉
       *   POST /api/render-node/ticket          页面:交回连接票据 { reqId, ticket | error }
       *   POST /api/render-node/ticket-request  预渲染进程(本机、不带 Origin):{ projectId } → { ticket };经 HMR `pc:render-node` 向页面要
       *   GET  /api/render-node/status          诊断(不含票据)
       * 预渲染进程崩溃重启、健康检查通过后,照记下的配置再转一次(不带票据)。
       * 开关 `PROMPTCUT_AUTO_RENDER_NODE=0`(或环境变量已经配好节点)时 bind 回 `{ enabled: false, reason }`,什么都不转。
       */
      const rnLog = (event: string, fields: object = {}) => {
        try { console.info("[render-node]", event, JSON.stringify(fields)); } catch { console.info("[render-node]", event); }
      };
      const rnMemory = createBindingMemory();
      const rnRelay = createTicketRelay({
        send: (data: object) => server.ws.send({ type: "custom", event: "pc:render-node", data }),
        hasPage: () => { const n = (server.ws as any)?.clients?.size; return typeof n === "number" ? n > 0 : true; },
      });
      const rnSend = (res: any, status: number, data: unknown) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(data));
      };
      const rnBody = (req: any, limit = 16 * 1024) => new Promise<any>((resolve, reject) => {
        let body = "";
        req.on("data", (c: Buffer) => { body += c; if (body.length > limit) { req.destroy(); reject(new Error("请求体太大")); } });
        req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("请求体不是 JSON")); } });
        req.on("error", reject);
      });
      /** 转给预渲染进程;它没就绪就算了(就绪后照记下的再转) */
      const rnForward = async (pathname: string, body: object) => {
        const s = prerenderState();
        if (!s.ready || !s.url) return { ok: true, pending: true };
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (process.env.PROMPTCUT_INTERNAL_TOKEN) headers["x-pc-internal-token"] = process.env.PROMPTCUT_INTERNAL_TOKEN;
          const r = await fetch(s.url + pathname, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
          return await r.json().catch(() => ({ ok: false, error: `预渲染进程回了非 JSON(HTTP ${r.status})` }));
        } catch (e: any) {
          return { ok: false, pending: true, error: String(e?.message ?? e) };
        }
      };
      const rnDeliverRemembered = () => {
        const b = rnMemory.get();
        if (!b) return;
        void rnForward("/api/frames/render-node", b).then((r: any) => rnLog("replay", { projectId: b.projectId, action: r?.action ?? null, ok: r?.ok !== false }));
      };
      server.middlewares.use("/api/render-node", (req, res, next) => {
        const route = (req.url || "/").split("?")[0];
        if (req.method === "GET" && route === "/status") {
          return rnSend(res, 200, { ok: true, enabled: autoRenderNodeOffReason(process.env) === null, off: autoRenderNodeOffReason(process.env), binding: rnMemory.get(), relay: rnRelay.stats() });
        }
        if (req.method !== "POST") return next();
        void (async () => {
          let input: any;
          try { input = await rnBody(req); } catch (e: any) { return rnSend(res, 400, { ok: false, error: e?.message || String(e) }); }
          if (route === "/bind") {
            const off = autoRenderNodeOffReason(process.env);
            if (off) return rnSend(res, 200, { ok: true, enabled: false, reason: off });
            let binding;
            try { binding = normalizeBinding(input); } catch (e: any) { return rnSend(res, 400, { ok: false, error: e?.message || String(e) }); }
            const prev = rnMemory.get();
            rnMemory.set(binding);
            if (!prev || prev.projectId !== binding.projectId || prev.url !== binding.url) rnLog("bind", { projectId: binding.projectId, url: binding.url, assetBase: binding.assetBase, contentId: binding.contentId });
            const r = await rnForward("/api/frames/render-node", { ...binding, ...(ticketOk(input.ticket) ? { ticket: input.ticket } : {}) });
            return rnSend(res, 200, { enabled: true, ...r });
          }
          if (route === "/unbind") {
            const projectId = typeof input?.projectId === "string" ? input.projectId : null;
            const cleared = rnMemory.clear(projectId);
            if (cleared) rnLog("unbind", { projectId, reason: typeof input?.reason === "string" ? input.reason.slice(0, 40) : null });
            const r = await rnForward("/api/frames/render-node/unbind", { projectId, reason: typeof input?.reason === "string" ? input.reason.slice(0, 40) : "page-left" });
            return rnSend(res, 200, { cleared, ...r });
          }
          if (route === "/ticket") {
            return rnSend(res, rnRelay.answer(input) ? 200 : 404, { ok: true });
          }
          if (route === "/ticket-request") {
            // 只给本机的预渲染进程(不带 Origin 的服务端请求);浏览器里的页面发来的一律拒(api 守卫之外再挡一道)
            if (req.headers.origin) return rnSend(res, 403, { ok: false, error: "只给本机进程" });
            const projectId = typeof input?.projectId === "string" ? input.projectId : "";
            const b = rnMemory.get();
            if (!b || b.projectId !== projectId) return rnSend(res, 409, { ok: false, code: "not-bound", error: "编辑器没有绑这个项目" });
            try {
              const ticket = await rnRelay.request(projectId);
              return rnSend(res, 200, { ok: true, ticket });
            } catch (e: any) {
              return rnSend(res, 503, { ok: false, code: e?.code ?? "no-ticket", error: e?.message || String(e) });
            }
          }
          return rnSend(res, 404, { ok: false, error: "Unknown render-node operation" });
        })();
      });

      const start = async () => {
        const port = await freePort();
        const url = `http://127.0.0.1:${port}`;
        const addr = server.httpServer?.address() as AddressInfo | null;
        const editorPort = addr?.port || server.config.server.port || 5190;
        const stagePorts = stagePortsOf(editorPort);
        const internalToken = process.env.PROMPTCUT_INTERNAL_TOKEN || (globalThis as any).__PC_INTERNAL_TOKEN__ || (() => {
          const tok = ((globalThis as any).__PC_INTERNAL_TOKEN__ = "pc-tok-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
          return tok;
        })();
        process.env.PROMPTCUT_INTERNAL_TOKEN = internalToken;
        child = spawn(process.execPath, [
          viteBin(root), "--config", path.join(root, "vite.prerender.config.ts"),
          "--port", String(port), "--strictPort", "--host", "127.0.0.1",
        ], {
          cwd: root,
          env: {
            ...process.env,
            PROMPTCUT_ROLE: "prerender",
            PROMPTCUT_PRERENDER_MODE: mode,
            PROMPTCUT_CORS_ORIGINS: editorOrigins(server).join(","),
            PROMPTCUT_STAGE_PORTS: stagePorts.join(","),
            PROMPTCUT_INTERNAL_TOKEN: internalToken,
            /*
             * 编辑器那一端的地址,给镜像插件回拉整份项目用(A7)。帧请求的 body 里只有
             * `{session, localRev}`,转发丢了或者这个进程刚起来的时候,它就按这个键
             * 去 `GET /api/data/project?session=&localRev=` 把那一版要回来。
             *
             * 〔裁〕三种模式都带。计划(cloud-task.md I1、I4(a))写的是 `agent` 模式不带、项目由 Agent 服务端推(I2),
             * 但 I2 的推送还没有:今天本机 Agent 的查询只带 `{session, localRev}`,靠这个地址回拉;素材服务的基址
             * (`asset-client.ts` 的 `assetServiceOrigin`)也还是它。本机拉起的 `agent` 模式不带它就一张图都查不出来。
             * 等 I2 的推送与 I3 的「拉起时告诉它素材服务地址」落地,再按计划去掉。
             */
            PROMPTCUT_EDITOR_URL: editorOrigins(server)[0],
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        try {
          os.setPriority(child.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch { /* 设不了优先级不影响功能,只是少了一层保护 */ }
        const keep = (c: Buffer) => { tail.push(c.toString()); if (tail.length > 30) tail.shift(); };
        /*
         * 预渲染进程的输出只留尾巴给崩溃时报错用;其中队列节点与推送队列到文档服务的会话事件行
         * (`[queue-node] docservice.session.*`,源头已按事件节流,见 `vite-plugin-frames.ts`)转进编辑器进程的日志,
         * 混沌测试时从编辑器这一侧看得到「脱开、接续、重建」。行里没有会话号与凭证。
         */
        const forwardOut = createSessionLineForwarder((line: string) => console.info(`[prerender] ${line}`));
        const forwardErr = createSessionLineForwarder((line: string) => console.info(`[prerender] ${line}`));
        child.stdout?.on("data", keep);
        child.stderr?.on("data", keep);
        child.stdout?.on("data", forwardOut);
        child.stderr?.on("data", forwardErr);
        // 托管方渲染服务的工作进程:预渲染进程里页面请求闸的记录(`[page-gate] …`,源头已限量)原样转出,管理进程的日志里看得到拦了什么
        if (process.env.PROMPTCUT_RENDER_BROKER) {
          let gateTail = "";
          child.stdout?.on("data", (c: Buffer) => {
            const lines = (gateTail + c.toString()).split(/\r?\n/);
            gateTail = (lines.pop() ?? "").slice(-4000);
            for (const line of lines) if (line.startsWith("[page-gate]")) console.info(line.slice(0, 2000));
          });
        }
        /*
         * 排障用(缺省不开):`PROMPTCUT_PRERENDER_LOG=<文件>` 时把预渲染进程的全部输出原样追加进这个文件,
         * 每块前带收到的时刻(`docs/archive/agent-reports/AGENT-uc-latency.md` 查换页卡住用)。不设就什么都不做。
         */
        const fullLog = String(process.env.PROMPTCUT_PRERENDER_LOG || "").trim();
        if (fullLog) {
          const tee = (c: Buffer) => { try { fs.appendFileSync(fullLog, `@${Date.now()} ${c.toString()}`); } catch { /* 写不了就算了 */ } };
          child.stdout?.on("data", tee);
          child.stderr?.on("data", tee);
        }
        setPrerender({ url, ready: false, error: null });

        const me = child;
        me.on("exit", (code) => {
          if (child === me) child = null;
          setPrerender({ ready: false, error: `预渲染进程退出(代码 ${code}):${tail.join("").trim().slice(-400)}` });
          if (closing) return;
          const n = prerenderState().restarts + 1;
          setPrerender({ restarts: n });
          if (n <= MAX_RESTARTS) setTimeout(() => { if (!closing) start().catch(() => {}); }, 1000 * n);
        });

        // 就绪 = 它自己的健康检查接口答话(vite-plugin-vision 在 prerender 这一端注册)
        const t0 = Date.now();
        while (child === me && Date.now() - t0 < 120000) {
          try {
            const r = await fetch(`${url}/api/prerender/health`, { signal: AbortSignal.timeout(2000) });
            if (r.ok) {
              setPrerender({ ready: true, error: null, restarts: 0 });
              /*
               * 它刚起来(或刚崩完重起),手里一份项目都没有。把每个 session 的最新一版
               * 补推过去,不然下一个帧请求只能靠回拉兜 —— 回拉是一趟额外的往返,
               * 而且崩溃重启往往正赶上用户在拖时间轴。
               */
              /*
               * 补推完镜像,再照会话版本登记把 preload 串行重放一遍(Item 4 方案 A):
               * 预渲染进程只认 preload 带来的会话版本,崩溃重启后靠这一步重新知道每个会话是哪一版,
               * 页面不用做任何事。重放途中它又重启了(`child !== me`)就停,交给下一轮。
               */
              void repushMirror(url)
                .then(() => replayReadySessions(url, () => child === me))
                .then((results) => { if (results.length) console.log(`[prerender] 重启后重放 preload:${JSON.stringify(results)}`); })
                .catch(() => {})
                // 页面交过共享配置(自动渲染节点):它刚起来,手里没有,照记下的再转一次(不带票据,建会话时它自己来要)
                .then(() => { if (child === me) rnDeliverRemembered(); });
              return;
            }
          } catch { /* 还没起来 */ }
          await new Promise((r) => setTimeout(r, 300));
        }
      };

      server.httpServer?.once("listening", () => {
        start().catch((e) => setPrerender({ ready: false, error: e?.message || String(e) }));
      });
      const stop = () => { closing = true; killTree(child); };
      server.httpServer?.on("close", stop);
      process.once("exit", stop);
    },
  };
}

export default prerenderPlugin;
