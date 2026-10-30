/**
 * 这个进程在三端分离里扮演哪一端(docs/archive/topics/decoupling-plan.md 第 3 节)。
 *
 *   ui         —— 用户自己的 dev server:供编辑器页面、MCP 桥、数据镜像、界面的热备渲染器。
 *   prerender  —— 预渲染进程:由 ui 那一端拉起的第二个 Vite(vite.prerender.config.ts),
 *                 独立进程、独立端口、低于正常的优先级。渲染池、导出、Agent 的看图请求都在这里。
 *
 * 为什么非拆不可:浏览器对同一个源只开约 6 条 HTTP/1.1 连接,渲染请求一挂就是几秒到几分钟,
 * 和编辑器挤在同一个源上就会把连接占满 —— 实测轻请求要排 7.7 秒,而 CPU 一点都不忙。
 */
export const ROLE = process.env.PROMPTCUT_ROLE === "prerender" ? "prerender" : "ui";
export const isPrerender = ROLE === "prerender";
