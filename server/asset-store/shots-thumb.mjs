/**
 * Shot thumbnail read endpoint is a pure move; detection/Python/render dependencies do not enter
 * the asset role.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { tr } from '../i18n.mjs';
// Sole behavior of original dataDir(root), preserving compatibility with legacy LAN local directories.
const dataDir = root => process.env.PROMPTCUT_DATA_DIR ?? path.join(root, 'out');
const sendJson = (res, code, data) => { if (res.headersSent) return; res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };

export function shotsDir(root        )         {
  const scope = (globalThis       )[Symbol.for("promptcut.asset.project-roots.v2")]?.get(path.resolve(root));
  if (scope) { scope.assertActive(); return path.join(scope.root, "out", "shots"); }
  return path.join(dataDir(root), "shots");
}

/**
 * Cloud thumbnail read endpoint selects project directory only by verified principal; perception
 * owner generating thumb must use the same scoped root.
 */
export function shotsThumbMiddleware(root        , { projectStores, projectAccess }                                               = {}) {
  if (!!projectStores !== !!projectAccess) throw new TypeError("projectStores and projectAccess required together");
  return async (req                         , res                , next            ) => {
    const match = ["GET", "HEAD"].includes(req.method ?? "GET") && String(req.url ?? "").split("?")[0].match(/^\/api\/shots\/thumb\/([\w.-]+)$/);
    if (!match) return next();
    let lease     ;
    let finish                          ;
    let handle                                             = null;
    try {
      lease = projectAccess ? await projectAccess.resolve(req, { action: "read", resource: { ns: "media", route: String(req.url).split("?")[0] }, close: () => { req.destroy(); res.destroy(); } }) : null;
      finish = lease?.hold();
      const scope = lease ? projectStores.project(lease.projectId) : null;
      const dir = shotsDir(scope?.root ?? root), file = path.join(dir, match[1]);
      if (!file.startsWith(dir + path.sep)) return sendJson(res, 400, { ok: false });
      handle = await fs.open(file, "r");
      lease?.trackHandle(handle);
      const stat = await handle.stat();
      await lease?.assert();
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Cache-Control", lease ? "no-store" : "max-age=3600");
      if (req.method === "HEAD") return res.end();
      const stream = handle.createReadStream(); handle = null;
      lease?.track(stream);
      res.once("close", () => { stream.destroy(); lease?.release(); });
      res.once("finish", () => lease?.release());
      stream.once("error", () => res.destroy());
      stream.pipe(res);
    } catch (error     ) { if (!res.destroyed) sendJson(res, error?.status ?? 404, { ok: false, error: error?.code ?? tr("Thumbnail not found") }); }
    finally { await handle?.close().catch(() => {}); finish?.(); if (res.writableFinished || !res.headersSent) lease?.release(); }
  };
}
