/*
 * 构建插件的云端扩展加载点（公开侧，`docs/plan/community-boundary.md` 第二节），兼托管页面闸插件的公开壳。
 *
 * 1. **为什么用顶层 `await`**：`vite.config.ts`、`vite.prerender.config.ts` 以及 `vite-plugin-cards.ts` 的 `cardOverridesLoader()`
 *    都是同步组装插件列表，调用时云端构建扩展必须已经就绪；利用 ESM 顶层 `await` 在模块求值阶段一次性完成存在性探测与加载。
 * 2. **为什么支持 `PROMPTCUT_CLOUD_DIR`**：与 `server/docservice/extensions.mjs` 同一约定。在最终双仓子模块布局下，
 *    公开仓库作为子模块位于私有仓库的 `community/` 下，相对本文件的 `..` 指到的是 `community/` 而非私有根；
 *    允许通过 `PROMPTCUT_CLOUD_DIR` 指定云端目录（缺省为 `<当前仓库根>/cloud`；若本文件被单测转译到系统临时目录则回落到 `process.cwd()/cloud`）。
 * 3. **为什么不搬走本文件改 `vite.config.ts` 的 import**：
 *    `vite.config.ts`（第 8 行）与 `vite.prerender.config.ts`（第 8 行）均直接 `import { hostedGatePlugin } from "./server/vite-plugin-hosted-gate"`，
 *    且二者均为公开共享配置文件（按守门规则不许直接 import `cloud/`，否则社区版无 `cloud/` 时 `npm run build` 与预渲染进程都会因找不到模块当场失败）。
 *    因此把真正的闸门实现迁入 `cloud/build/vite-plugin-hosted-gate.mjs` 并由 `cloud/build/manifest.mjs` 注册，
 *    本文件留在公开侧充当构建块的**唯一扩展加载入口**（与 `server/docservice/extensions.mjs` 同形）：
 *    有 `cloud/build/manifest.mjs` 时挂载真实闸门，没有时返回空插件 `{ name: "promptcut-hosted-gate" }`。
 * 4. **守门例外声明**：本文件是「共享树不许加载 `cloud/`」守门规则在构建（build）块中的**唯一例外**。
 *    本文件中不出现任何具体云端业务模块路径，只固定探测 `<云端目录>/build/manifest.mjs`。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = existsSync(path.join(here, "..", "package.json"))
  ? path.resolve(here, "..")
  : process.cwd();
const envCloudDir = process.env.PROMPTCUT_CLOUD_DIR?.trim();
const cloudDir = envCloudDir
  ? path.resolve(envCloudDir)
  : path.join(repoRoot, "cloud");
const manifestFile = path.join(cloudDir, "build", "manifest.mjs");

let loaded: Record<string, any> = {};
if (existsSync(manifestFile)) {
  const mod: any = await import(pathToFileURL(manifestFile).href);
  const table: any = mod?.default ?? mod?.manifest;
  if (table && typeof table === "object" && !Array.isArray(table)) {
    const clean: Record<string, any> = {};
    for (const [key, item] of Object.entries(table)) {
      if (item && typeof item === "object" && typeof (item as any).name === "string" && (item as any).name) {
        clean[key] = item;
      }
    }
    loaded = clean;
  }
}

export const buildExtensions: Record<string, any> = Object.freeze({ ...loaded });

// 舞台闸的放行规则，`stage-gate.mjs` 按这个键读。这里不 import 它：这个入口可能被拷到临时目录求值，相对路径找不到
(globalThis as Record<symbol, unknown>)[Symbol.for("promptcut.stage-allow")] = buildExtensions.stageAllow?.rules ?? [];

export function hostedGatePlugin(): Plugin {
  if (typeof buildExtensions.hostedGate?.createPlugin === "function") {
    return buildExtensions.hostedGate.createPlugin();
  }
  return { name: "promptcut-hosted-gate" };
}

export default hostedGatePlugin;
