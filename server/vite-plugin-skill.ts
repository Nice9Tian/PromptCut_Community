import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse, IncomingMessage } from "node:http";
import fs from "node:fs";
import path from "node:path";

/**
 * SKILL:桌面 APP 经 MCP 直连用户正在用的项目(计划 `docs/plan/agent-workflow-plan.md` A4)。这里管两件事:
 *
 *   1. **登记到桌面 APP**:把 PromptCut 的 MCP 服务写进 Claude Code / Codex 的用户级配置(`server/desktop-register.mjs`:
 *      条目名固定 `promptcut`、不写端口、写之前备份、能撤销)。
 *        GET  /api/skill/desktop-register                              → { ok, command, targets: [现状…] }
 *        POST /api/skill/desktop-register { target, action: "register" | "unregister" } → { ok, …现状 }
 *      桌面 APP 那边每个会话起一份 `server/mcp-server.mjs`,按端口文件连到这个实例;身份、权限、SKILL 闸、写入都在
 *      `server/vite-plugin-ai.ts` 的 `/api/mcp/call` 里。
 *   2. **按路径打开 .proc**(POST /api/skill/open-path):双击文件、桌面壳启动参数走这里。先复制到 `.pc-work/opened/`
 *      再给前端,原文件不占、不改。和 SKILL 无关,历史原因挂在同一条路由下。
 *
 * 原来这里是「任务目录 + 无头实例 + 深链拉起桌面 app 新对话 + 回来三方合并」那一套,A4 归档(git 历史里有)。
 */

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > limit) {
        req.destroy();
        reject(new Error("请求太大"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => reject(new Error("读取请求体失败")));
  });
}

/**
 * 按磁盘路径打开一份 .proc:双击文件、桌面壳启动参数都走这里。
 * **先复制到 .pc-work/opened/ 再读副本**:原文件不被占用、不被改,双击一份别人正在编辑的
 * .proc 不会互相踩。
 */
async function openPath(root: string, req: IncomingMessage, res: ServerResponse) {
  const { path: raw } = JSON.parse((await readBody(req)) || "{}");
  const src = path.resolve(String(raw || ""));
  if (!/\.(proc|json)$/i.test(src)) return sendJson(res, 400, { ok: false, error: "只认 .proc / .json" });
  if (!fs.existsSync(src)) return sendJson(res, 404, { ok: false, error: `文件不存在:${src}` });
  const text = fs.readFileSync(src, "utf8");
  /*
   * 内容必须**长得像一份 PromptCut 项目**才回给调用方。
   *
   * 这里不能按目录设白名单 —— 双击磁盘上任意位置的 .proc 本来就是这条路要支持的事。
   * 但光校验后缀不够:`.json` 什么都能是,而这个接口是把文件内容原样回出去的。
   * 机器上一堆带凭据的 .json(Codex 的登录态就是其中之一),路径又都是固定的。
   * 同源卡口(vite-plugin-api-guard)已经挡掉了跨站页面,这一道防的是同源里的注入
   * (比如聊天记录渲染出来的脚本)—— 它拿这个接口读不到不是项目的东西。
   */
  const doc = JSON.parse(text) as Record<string, unknown>;
  const looksLikeProject =
    doc?.format === "promptcut-project" ||
    (doc?.project && typeof doc.project === "object") ||
    (doc?.version === 1 && Array.isArray(doc?.tracks));
  if (!looksLikeProject) {
    return sendJson(res, 400, { ok: false, error: "这个文件不是 PromptCut 项目" });
  }
  const name = path.basename(src);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(root, ".pc-work", "opened", `${stamp}-${name.replace(/[\\/:*?"<>|]/g, "")}`);
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, name);
  fs.copyFileSync(src, copy);
  return sendJson(res, 200, { ok: true, text, name, copy, original: src });
}

/** 登记模块按修改时间重新加载:改了它不用重启 dev server(Node 的 ESM 缓存按 URL 记) */
async function loadRegister() {
  const url = new URL("./desktop-register.mjs", import.meta.url);
  try { url.searchParams.set("t", String(fs.statSync(url).mtimeMs)); } catch { /* 打包后读不到 mtime 就用缓存 */ }
  return import(url.href);
}

export function skillPlugin(): Plugin {
  return {
    name: "promptcut-skill",
    configureServer(server: ViteDevServer) {
      const root = server.config.root || process.cwd();

      server.middlewares.use("/api/skill", async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
        try {
          // POST /api/skill/open-path —— 挂在同一条路由里:connect 按前缀匹配,
          // 单独注册 /api/skill/open-path 会被这条先截住,永远走不到
          if (parts[0] === "open-path" && req.method === "POST") return await openPath(root, req, res);

          if (parts[0] === "desktop-register" && parts.length === 1) {
            const reg = await loadRegister();
            const want = reg.mcpCommand(root);
            if (req.method === "GET") {
              return sendJson(res, 200, { ok: true, command: want, targets: reg.TARGETS.map((t: string) => reg.registrationStatus(t, want)) });
            }
            if (req.method === "POST") {
              const body = JSON.parse((await readBody(req, 8192)) || "{}");
              const target = String(body.target || "");
              if (!reg.TARGETS.includes(target)) return sendJson(res, 400, { ok: false, error: `target 只能是 ${reg.TARGETS.join(" / ")}` });
              if (body.action === "register") return sendJson(res, 200, reg.register(target, want));
              if (body.action === "unregister") return sendJson(res, 200, reg.unregister(target, want));
              return sendJson(res, 400, { ok: false, error: "action 只能是 register / unregister" });
            }
          }
          return sendJson(res, 404, { ok: false, error: "没有这个接口" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });
    },
  };
}

export default skillPlugin;
