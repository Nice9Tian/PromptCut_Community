/**
 * 舞台端口的算式,**一处算、四处用**(J4:「舞台端口数从一个常量 `STAGE_PORTS = 2` 取」)。
 *
 * 用的地方:编辑器进程起反向代理(`vite-plugin-stage-ports.ts`)、拼
 * `PROMPTCUT_CORS_ORIGINS`(`vite-plugin-prerender.ts`)、写 port.json(`vite-plugin-ai.ts`)、
 * 页面按注入的端口拼 iframe 地址(`src/editor/previewMode.ts`)。
 * 将来第三个 iframe(在线浏览器模式的预渲染者,L1)占第三个端口,只改这一个常量。
 *
 * 为什么是「编辑器端口 +1、+2」而不是随便找两个空端口:桌面壳和探针都要**在页面之外**
 * 知道这两个地址(port.json、`--origin` 推算),固定偏移比到处传端口号省事;端口撞了就
 * 不起代理,页面自己退回同源单舞台(见插件里的说明)。
 */

/** 舞台 iframe 的个数 = 舞台端口的个数 */
export const STAGE_PORTS = 2;

/** 编辑器端口 → 两个舞台端口 */
export function stagePortsOf(editorPort) {
  return Array.from({ length: STAGE_PORTS }, (_, i) => Number(editorPort) + 1 + i);
}

/**
 * 两个舞台端口的全部源写法。`PROMPTCUT_CORS_ORIGINS` 要按这个名单放行 ——
 * 舞台 iframe 里的页面打预渲染进程(J3 的快照字节、C3 的 SSE)时带的 Origin 是它自己的源,
 * 不是编辑器的源。
 */
export function stageOriginsOf(editorPort, hosts = ["127.0.0.1", "localhost", "[::1]"]) {
  return stagePortsOf(editorPort).flatMap((p) => hosts.map((h) => `http://${h}:${p}`));
}
