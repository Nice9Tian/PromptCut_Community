/**
 * Convert project sent from the page into a format recognized by prerender (asset addresses).
 * Moved as-is from `vite-plugin-frames.ts` (contract `docs/plan/render-queue-contract.md` J.5); that
 * side re-exports the function with the same name, callers need no changes.
 *
 * Moved out because after the queue executor (`prerender-executor.mjs`) fetches the project by
 * version from the document service, it must do the same thing to the mirror as the
 * `/api/frames/preload` route: calculate the same `entry.key` from the same JSON. Doesn't even
 * import Node built-in modules; pure function, does not mutate input arguments.
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
