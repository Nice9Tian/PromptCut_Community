import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse, IncomingMessage } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { tr } from "./i18n.mjs";

/**
 * SKILL: desktop app connects directly via MCP to the project currently used by the user (plan
 * `docs/plan/agent-workflow-plan.md` A4). Two things are handled here:
 *
 *   1. **Register with the desktop app**: write PromptCut's MCP service into user-level configs
 *      for Claude Code / Codex (`server/desktop-register.mjs`: entry name fixed to `promptcut`,
 *      no port written, backed up before writing, reversible).
 *        GET  /api/skill/desktop-register                              → { ok, command, targets: [current status…] }
 *        POST /api/skill/desktop-register { target, action: "register" | "unregister" } → { ok, …current status }
 *      On the desktop app side, each session launches an instance of `server/mcp-server.mjs` and
 *      connects to this instance via the port file; identity, permissions, the SKILL gate, and
 *      writes are all in `/api/mcp/call` in `server/vite-plugin-ai.ts`.
 *   2. **Open .proc by path** (POST /api/skill/open-path): double-clicking a file and desktop shell
 *      startup arguments go through here. Copied to `.pc-work/opened/` first before handing to
 *      the frontend; the original file is not locked or modified. Unrelated to SKILL, mounted under
 *      the same route for historical reasons.
 *
 * Originally, this was the "task directory + headless instance + deep link launching a new desktop
 * app chat + returning for a three-way merge" workflow, archived in A4 (preserved in git history).
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
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => reject(new Error(tr("Failed to read request body"))));
  });
}

/**
 * Open a .proc by disk path: double-clicking a file and desktop shell startup arguments go here.
 * **Copy to .pc-work/opened/ first then read the replica**: the original file is not occupied or
 * modified, and double-clicking a .proc currently being edited by someone else will not collide.
 */
async function openPath(root: string, req: IncomingMessage, res: ServerResponse) {
  const { path: raw } = JSON.parse((await readBody(req)) || "{}");
  const src = path.resolve(String(raw || ""));
  if (!/\.(proc|json)$/i.test(src)) return sendJson(res, 400, { ok: false, error: "Only .proc / .json are accepted" });
  if (!fs.existsSync(src)) return sendJson(res, 404, { ok: false, error: `File does not exist: ${src}` });
  const text = fs.readFileSync(src, "utf8");
  /*
   * Content must **look like a PromptCut project** before returning it to the caller.
   *
   * A directory allowlist cannot be set here: double-clicking a .proc anywhere on disk is
   * inherently what this path must support. But validating the extension alone is not enough:
   * `.json` can be anything, and this endpoint returns the file content as is. There are numerous
   * credential-bearing `.json` files on the machine (Codex login state is one of them), and their
   * paths are fixed. The same-origin guard (vite-plugin-api-guard) already blocks cross-site pages;
   * this line defends against same-origin injection (such as scripts rendered from chat history):
   * it cannot use this endpoint to read things that are not projects.
   */
  const doc = JSON.parse(text) as Record<string, unknown>;
  const looksLikeProject =
    doc?.format === "promptcut-project" ||
    (doc?.project && typeof doc.project === "object") ||
    (doc?.version === 1 && Array.isArray(doc?.tracks));
  if (!looksLikeProject) {
    return sendJson(res, 400, { ok: false, error: tr("This file is not a PromptCut project") });
  }
  const name = path.basename(src);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(root, ".pc-work", "opened", `${stamp}-${name.replace(/[\\/:*?"<>|]/g, "")}`);
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, name);
  fs.copyFileSync(src, copy);
  return sendJson(res, 200, { ok: true, text, name, copy, original: src });
}

/** Registration module reloads based on mtime: modifying it requires no dev server restart (Node ESM caches by URL) */
async function loadRegister() {
  const url = new URL("./desktop-register.mjs", import.meta.url);
  try { url.searchParams.set("t", String(fs.statSync(url).mtimeMs)); } catch { /* Fall back to cache if mtime cannot be read after bundling */ }
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
          // POST /api/skill/open-path: mounted under the same route: connect matches by prefix,
          // so registering /api/skill/open-path separately would be intercepted by this one first and never reached
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
              if (!reg.TARGETS.includes(target)) return sendJson(res, 400, { ok: false, error: `target must be one of ${reg.TARGETS.join(" / ")}` });
              if (body.action === "register") return sendJson(res, 200, reg.register(target, want));
              if (body.action === "unregister") return sendJson(res, 200, reg.unregister(target, want));
              return sendJson(res, 400, { ok: false, error: "action must be register / unregister" });
            }
          }
          return sendJson(res, 404, { ok: false, error: "API not available" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });
    },
  };
}

export default skillPlugin;
