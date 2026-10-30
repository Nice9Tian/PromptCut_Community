/**
 * vision 这一侧的 HTTP 小工具:回 JSON、断开检测、产物目录、素材地址改写、回连源地址。
 * 从 server/vite-plugin-vision.ts 逐字搬来,不持有任何模块级状态。
 */
import path from "node:path";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";

export function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

/**
 * 这个请求的调用方断开时拨一下的 signal。
 *
 * `res` 的 close 在两种时候都会触发:正常回完话,和对面先断了。只有后一种(还没 end)才算「不要了」。
 * 以前服务端从不看断开:页面那边掐了请求(3D 视图换了时刻、Agent 超时放弃),活照样留在队里、
 * 照样渲完,白占一个 Chrome —— 前面排着的真正要看的那张就得多等。
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
 * 把素材的 blob: 地址换成渲染进程够得着的 /@media/<文件名>。
 *
 * 编辑器里刚导入的素材,url 是 URL.createObjectURL 出来的 blob: —— 那是编辑器
 * 那个页面私有的,渲染进程打不开。不换的话画面里视频那一层是空的,而模型会照着
 * 这张图得出「视频没进来」的结论 —— 让它看一张假画面,比不给它看更糟。
 * 好在导入时文件已经上传到服务端并记了 path(见 src/editor/io/index.ts),
 * 按文件名走 /@media 就能取到,和项目载入时做的换算是同一套。
 *
 * 换不成的(既是 blob: 又没有 path)如实说出来,别让模型以为那里本来就是黑的。
 */
export function resolveMediaUrls(project: any): { project: any; unresolved: string[] } {
  const unresolved: string[] = [];
  const media = (project.media || []).map((m: any) => {
    // A1:有内容哈希就一律 /@media/<hash> —— 哈希是身份,本地内容库按它存,
    // 渲染进程取到的和编辑器是同一份字节。已经是能用的地址就原样(导出期的
    // /@export/<id>/media/<文件> 也是能用的),只有空地址和页面私有的 blob: / data: 才换。
    if (m?.hash) {
      const u = String(m.url || "");
      return !u || u.startsWith("blob:") || u.startsWith("data:") ? { ...m, url: `/@media/${m.hash}` } : m;
    }
    const url = String(m?.url || "");
    if (!url || (!url.startsWith("blob:") && !url.startsWith("data:"))) return m;
    const base = m?.path ? String(m.path).split(/[/\\]/).pop() : "";
    if (!base) {
      unresolved.push(m?.name || m?.id || "(未命名素材)");
      return { ...m, url: "" };
    }
    return { ...m, url: `/@media/${encodeURIComponent(base)}` };
  });
  return { project: { ...project, media }, unresolved };
}

/**
 * 渲染进程该从哪个地址回连 dev server。
 *
 * 不能像导出那样写死 127.0.0.1:vite 默认只绑 localhost,而 Windows 上 localhost
 * 可能只解析到 ::1 —— 那种配置下 127.0.0.1 直接 ECONNREFUSED,Chrome 打不开页面,
 * 报出来的还是一句难懂的 goto 失败。直接问 httpServer 它到底绑在哪。
 */
export function originOf(server: ViteDevServer): string {
  const addr = server.httpServer?.address() as AddressInfo | null;
  const port = server.config.server.port || addr?.port || 5190;
  const host = addr?.address;
  if (!host || host === "0.0.0.0" || host === "127.0.0.1") return `http://127.0.0.1:${port}`;
  // ::（全网卡）也走 ::1，本机回连不需要走外部地址
  if (addr?.family === "IPv6") return `http://[${host === "::" ? "::1" : host}]:${port}`;
  return `http://${host}:${port}`;
}
