import type { Plugin } from "vite";
import type { ServerResponse } from "http";
import { spawn } from "child_process";
import { exportsRunning } from "./render-pool-state.mjs";
import { exportsRoot, listExports, deleteExport, pruneExport, resolveExportDir } from "./exports-list.mjs";

/**
 * 导出产物的接口(存储占用计划 `docs/plan/storage-plan.md` 第 4 节),给开始页「存储」一块用:
 *
 *   GET  /api/exports                → { ok, items: [{ id, projectName, projectId, at, finished, running, bytes, deliverables, intermediateBytes }] }
 *   POST /api/exports/<id>/delete    → { ok, freedBytes } | { ok: false, error }
 *   POST /api/exports/<id>/prune     → { ok, freedBytes } | { ok: false, error }(只删中间文件)
 *   POST /api/exports/<id>/reveal    → { ok }(在文件管理器里打开)
 *
 * 文件系统那一半(列举、路径校验、不跟链接的删除)在 `exports-list.mjs`。
 * 在 `vite.config.ts` 里排在 `apiGuardPlugin` 后面,同源守卫先过;在线构建不挂任何接口插件,开始页里调这些接口的代码
 * 也按 `ONLINE_BUILD` 剪掉(`src/StartPage.tsx`)。
 */
function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** 在文件管理器里打开一个目录。同 `vite-plugin-export.ts` 的 reveal:explorer 打开目录时退出码是 1,不看退出码 */
function reveal(dir: string) {
  const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [dir], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

export function exportsListPlugin(): Plugin {
  return {
    name: "vite-plugin-exports-list",
    configureServer(server) {
      const viteRoot = server.config.root;
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || "").split("?")[0];
        if (url !== "/api/exports" && !url.startsWith("/api/exports/")) return next();
        const root = exportsRoot(viteRoot);
        const opts = { exportsRunning: exportsRunning() > 0 };
        try {
          if (url === "/api/exports") {
            if (req.method !== "GET") return send(res, 405, { ok: false, error: "只支持 GET" });
            return send(res, 200, { ok: true, items: await listExports(root, opts) });
          }
          const m = /^\/api\/exports\/([^/]+)\/(delete|prune|reveal)$/.exec(url);
          if (!m) return send(res, 404, { ok: false, error: "没有这个接口" });
          if (req.method !== "POST") return send(res, 405, { ok: false, error: "只支持 POST" });
          let id: string;
          try { id = decodeURIComponent(m[1]); } catch { return send(res, 400, { ok: false, error: "不是导出目录的名字" }); }
          const action = m[2];
          if (action === "reveal") {
            const r = await resolveExportDir(root, id);
            if (!r.ok) return send(res, r.status, { ok: false, error: r.error });
            reveal(r.abs);
            return send(res, 200, { ok: true });
          }
          const r = action === "delete" ? await deleteExport(root, id, opts) : await pruneExport(root, id, opts);
          if (r.ok) return send(res, 200, { ok: true, freedBytes: r.freedBytes });
          const { status, ...body } = r as { status: number; ok: false; error: string };
          return send(res, status || 500, body);
        } catch (e) {
          return send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}
