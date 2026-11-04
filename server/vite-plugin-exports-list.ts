import type { Plugin } from "vite";
import type { ServerResponse } from "http";
import { spawn } from "child_process";
import { exportsRunning } from "./render-pool-state.mjs";
import { exportsRoot, listExports, deleteExport, pruneExport, resolveExportDir } from "./exports-list.mjs";
import { tr } from "./i18n.mjs";

/**
 * Export deliverables API (storage plan `docs/plan/storage-plan.md` section 4), used by the "Storage"
 * section of the start page:
 *
 *   GET  /api/exports                → { ok, items: [{ id, projectName, projectId, at, finished, running, bytes, deliverables, intermediateBytes }] }
 *   POST /api/exports/<id>/delete    → { ok, freedBytes } | { ok: false, error }
 *   POST /api/exports/<id>/prune     → { ok, freedBytes } | { ok: false, error } (only deletes intermediate files)
 *   POST /api/exports/<id>/reveal    → { ok } (reveal in file manager)
 *
 * The filesystem half (enumeration, path validation, non-symlink-following deletion) is in
 * `exports-list.mjs`.
 * In `vite.config.ts`, it is placed after `apiGuardPlugin`, so same-origin guard runs first;
 * online build does not attach any API plugins, and code calling these APIs in the start page is
 * also stripped via `ONLINE_BUILD` (`src/StartPage.tsx`).
 */
function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Open a directory in the file manager. Same as reveal in `vite-plugin-export.ts`: explorer exit code is 1 when opening a directory, so ignore the exit code */
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
            if (req.method !== "GET") return send(res, 405, { ok: false, error: "Only GET is supported" });
            return send(res, 200, { ok: true, items: await listExports(root, opts) });
          }
          const m = /^\/api\/exports\/([^/]+)\/(delete|prune|reveal)$/.exec(url);
          if (!m) return send(res, 404, { ok: false, error: "API not available" });
          if (req.method !== "POST") return send(res, 405, { ok: false, error: "Only POST is supported" });
          let id: string;
          try { id = decodeURIComponent(m[1]); } catch { return send(res, 400, { ok: false, error: tr("Not an export directory name") }); }
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
