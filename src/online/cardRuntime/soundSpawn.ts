/**
 * 声音线程的起法(只在浏览器里用):**从 blob 地址引导**,真正的线程脚本由线程自己从舞台源取。
 *
 * 舞台的内容安全策略只许从 blob 地址起后台线程(`worker-src blob:`,`docs/plan/online-card-exec-contract.md` 3.3:
 * blob 线程继承舞台文档的策略,同源地址起的不继承)。舞台加固收走了全局的 `Worker`(不让卡片代码自己起后台线程),
 * 这里经 `spawnRuntimeWorker` 用守卫安装前留在模块闭包里的原生构造函数起(写法同 `src/render/gl/spawnWorker.ts`)。
 *
 * 开发态 vite 把线程当 ES 模块服务 → 引导脚本用 `import`;构建产物里线程打成一个 iife 文件 → `importScripts`。
 */
import workerUrl from "./soundWorker.ts?worker&url";
import { trustedTypesPrelude } from "../../render/gl/spawnWorker.ts";
import { spawnRuntimeWorker } from "../isolation/scopeGuard.ts";
import type { WorkerLike } from "./soundHost.ts";

export function spawnSoundWorker(): WorkerLike {
  const abs = new URL(workerUrl, location.href).href;
  if (import.meta.env.DEV) {
    return spawnRuntimeWorker(`import ${JSON.stringify(abs)};`, { type: "module", name: "pc-card-sound" }) as unknown as WorkerLike;
  }
  return spawnRuntimeWorker(`${trustedTypesPrelude()}importScripts(${JSON.stringify(abs)});`, { name: "pc-card-sound" }) as unknown as WorkerLike;
}
