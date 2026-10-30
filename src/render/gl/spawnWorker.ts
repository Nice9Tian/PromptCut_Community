/**
 * 起 GL Worker(R9 M2)。舞台 / 导出页的 `glHost`(路线 1)和编辑器父页(路线 2)都经这里起。
 *
 * **为什么不直接 `new Worker(new URL('./glWorker.ts', import.meta.url))`**:那样 Worker 的主脚本是
 * 页面自己发的请求,而它的收尾事件(`loadingFinished`)在 CDP 里报到 Worker 自己的 target 上 ——
 * 导出页的 `waitNet`(`server/bakery/chrome.mjs`)在页面的 Network 域里看到它一直「在路上」,
 * 每一帧白等满 30 秒然后报错(实测)。所以页面只起一个 `blob:` 的引导脚本,真正的模块由 Worker 自己去取,
 * 那个请求记在 Worker 的 target 上,不挂在页面的账上。
 *
 * 舞台加固收走了全局的 `Worker`(不让卡片代码自己起后台线程),这里经 `spawnRuntimeWorker` 用守卫安装前留在模块闭包里的原生构造函数起。
 * 开发态 vite 把 Worker 当 ES 模块服务 → 引导脚本用 `import`;构建产物里 Worker 缺省打成 iife → `importScripts`。
 */
import workerUrl from "./glWorker.ts?worker&url";
import { spawnRuntimeWorker } from "../../online/isolation/scopeGuard.ts";

/**
 * 在线的跨源舞台若带 Trusted Types(`require-trusted-types-for 'script'`),blob Worker 继承它:
 * Worker 里 `importScripts` 要先有缺省策略。只在本文档已经有缺省策略时才加这一句,别处引导脚本一个字不变。
 */
export function trustedTypesPrelude(): string {
  const tt = (globalThis as { trustedTypes?: { defaultPolicy?: unknown } }).trustedTypes;
  if (!tt?.defaultPolicy) return "";
  return `if (self.trustedTypes && !self.trustedTypes.defaultPolicy) self.trustedTypes.createPolicy("default", { createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s });`;
}

export function spawnGlWorker(): Worker {
  const abs = new URL(workerUrl, location.href).href;
  if (import.meta.env.DEV) {
    return spawnRuntimeWorker(`import ${JSON.stringify(abs)};`, { type: "module" });
  }
  return spawnRuntimeWorker(`${trustedTypesPrelude()}importScripts(${JSON.stringify(abs)});`);
}
