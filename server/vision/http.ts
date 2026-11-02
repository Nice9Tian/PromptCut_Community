/**
 * HTTP utilities on the vision side: JSON responses, disconnect detection, artifact directory,
 * asset URL rewriting, loopback source URL. Copied verbatim from server/vite-plugin-vision.ts; holds
 * no module-level state.
 */
import path from "node:path";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { tr } from "../i18n.mjs";

export function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

/**
 * Signal triggered when this request's caller disconnects.
 *
 * `res` close triggers in two cases: after normal response completion, and when the remote end
 * disconnects first. Only the latter (not yet ended) counts as "aborted". Previously the server
 * never inspected disconnects: when the page aborted a request (3D view switched timestamps,
 * Agent timed out and gave up), the job stayed in the queue and finished rendering anyway, wasting
 * a Chrome instance: the one queued in front that was actually needed had to wait longer.
 */
export function abortOnClose(res: ServerResponse): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  return ac.signal;
}

export function outRoot(root: string): string {
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(root, "out");
}

/**
 * Replaces asset blob: URLs with /@media/<filename> accessible to the render process.
 *
 * For assets freshly imported in the editor, url is a blob: from URL.createObjectURL: that is
 * private to the editor page and inaccessible to the render process. Without replacement, the video
 * layer in the frame is empty, and the model would conclude from this image that "video was not
 * imported": letting it see a false frame is worse than not showing it at all. Fortunately, upon
 * import the file has already been uploaded to the server and its path recorded (see
 * src/editor/io/index.ts); accessing /@media by filename retrieves it, using the same conversion
 * logic as project loading.
 *
 * If conversion fails (both blob: and missing path), report truthfully instead of letting the model
 * assume it was originally black.
 */
export function resolveMediaUrls(project: any): { project: any; unresolved: string[] } {
  const unresolved: string[] = [];
  const media = (project.media || []).map((m: any) => {
    // A1: If there is a content hash, always use /@media/<hash>: hash is identity, stored by it in
    // the local content store, and the render process gets the exact same bytes as the editor.
    // If the URL is already usable, keep it as is (during export, /@export/<id>/media/<file> is also
    // usable); only empty URLs and page-private blob: / data: URLs are replaced.
    if (m?.hash) {
      const u = String(m.url || "");
      return !u || u.startsWith("blob:") || u.startsWith("data:") ? { ...m, url: `/@media/${m.hash}` } : m;
    }
    const url = String(m?.url || "");
    if (!url || (!url.startsWith("blob:") && !url.startsWith("data:"))) return m;
    const base = m?.path ? String(m.path).split(/[/\\]/).pop() : "";
    if (!base) {
      unresolved.push(m?.name || m?.id || tr("(Unnamed media)"));
      return { ...m, url: "" };
    }
    return { ...m, url: `/@media/${encodeURIComponent(base)}` };
  });
  return { project: { ...project, media }, unresolved };
}

/**
 * Which URL the render process should use to connect back to the dev server.
 *
 * Cannot hardcode 127.0.0.1 like export: vite binds only to localhost by default, and on Windows
 * localhost may only resolve to ::1: in that configuration, 127.0.0.1 yields ECONNREFUSED directly,
 * Chrome cannot open the page, and the error reported is an obscure goto failure. Ask httpServer
 * directly where it is actually bound.
 */
export function originOf(server: ViteDevServer): string {
  const addr = server.httpServer?.address() as AddressInfo | null;
  const port = server.config.server.port || addr?.port || 5190;
  const host = addr?.address;
  if (!host || host === "0.0.0.0" || host === "127.0.0.1") return `http://127.0.0.1:${port}`;
  // :: (all network interfaces) also uses ::1; local loopback does not need external addresses
  if (addr?.family === "IPv6") return `http://[${host === "::" ? "::1" : host}]:${port}`;
  return `http://${host}:${port}`;
}
