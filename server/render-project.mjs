/**
 * 把页面发来的项目换成预渲染间认得的样子(素材地址)。从 `vite-plugin-frames.ts` 原样搬来
 * (契约 `docs/plan/render-queue-contract.md` J.5),那边照旧转出同名函数,调用方不用改。
 *
 * 搬出来是因为队列执行器(`prerender-executor.mjs`)按版本从文档服务取回项目之后,要和
 * `/api/frames/preload` 路由对镜像做同一件事:同一份 JSON 算出同一个 `entry.key`。
 * 这里只引 Node 内置模块也不引,纯函数,不改入参。
 *
 * @param {any} project
 * @returns {any}
 */
export function renderProject(project) {
  return { ...project, media: (project.media || []).map((/** @type {any} */ m) => {
    // .proc files from older versions may contain a bare filename (and some
    // callers still send blob URLs).  The renderer cannot resolve either
    // form; the durable server path is the source of truth for both.
    // A legacy .proc may say /@media/<name> while the actual file lives in
    // the shared Videos/PromptCut/media folder.  Resolve through the guarded
    // media endpoint so the export/Agent page sees the same file as the editor.
    //
    // A1: a hash IS the asset's identity.  Media that carries one is served by
    // /@media/<hash> (vite-plugin-media resolves it in the local content store,
    // with the right Content-Type and Range support), so leave that address
    // alone — rewriting it by path would pin the renderer to one machine's
    // file layout and, from step 5 on, defeat tier switching.  Only migration
    // era media (no hash) is still rewritten by its durable path.  A hashed
    // asset that somehow still carries a page-private address (blob: / data:,
    // or nothing at all) gets the hash address instead — same rule as
    // vite-plugin-vision.ts's resolveMediaUrls, so both paths agree.
    if (m.hash) {
      const u = String(m.url || "");
      return !u || u.startsWith("blob:") || u.startsWith("data:") ? { ...m, url: `/@media/${m.hash}` } : m;
    }
    if (m.path && (!m.url || m.url.startsWith("blob:") || !m.url.startsWith("/@export/"))) {
      return { ...m, url: "/api/media/file?path=" + encodeURIComponent(String(m.path)) };
    }
    return m;
  }) };
}
