/**
 * AI 云端扩展加载入口（Node 侧 `.mjs`，参照 `server/docservice/extensions.mjs`）。
 *
 * 1. 为什么拆成单独的 `.mjs`：
 *    `src/ai/extensions.ts` 会被浏览器侧 React 组件直接引入，而 `tsconfig.json` 为纯浏览器环境（`types: ["vite/client"]`），
 *    不含 `node:fs` / `node:path` / `node:url` / `process`。将 Node 目录探测与动态加载放在 `.mjs` 中，
 *    保持浏览器侧 `extensions.ts` 纯净无 Node 依赖，同时供 Node 单测验证加载表契约。
 *
 * 2. 查找顺序（与 `server/docservice/extensions.mjs` 一致）：
 *    - 调用 `loadAiExtensions({ cloudDir })` 显式传入的目录（单测用）；
 *    - 环境变量 `PROMPTCUT_CLOUD_DIR`；
 *    - 仓库根下的 `<repoRoot>/cloud`。
 *    找不到 `<cloudDir>/ai/manifest.{ts,mjs,js}` 时返回空冻结数组 `[]`，不抛异常。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMMUNITY_AI_CLOUD_PROVIDER,
  applyAiManifest,
  registerAiCloudProvider,
} from "./extensions.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const ENV_KEY = "PROMPTCUT_CLOUD_DIR";
const DEFAULT_CLOUD_DIR_NAME = "cloud";
const AI_SUBDIR_NAME = "ai";

export async function loadAiExtensions(opts = {}) {
  try {
    const fromEnv = typeof process.env?.[ENV_KEY] === "string" ? process.env[ENV_KEY].trim() : "";
    const cloudDir =
      typeof opts.cloudDir === "string" && opts.cloudDir.trim()
        ? path.resolve(opts.cloudDir.trim())
        : fromEnv
          ? path.resolve(fromEnv)
          : path.join(repoRoot, DEFAULT_CLOUD_DIR_NAME);

    const candidates = ["manifest.ts", "manifest.mjs", "manifest.js"].map((f) =>
      path.join(cloudDir, AI_SUBDIR_NAME, f),
    );
    const manifestPath = candidates.find((p) => fs.existsSync(p));
    if (!manifestPath) return applyAiManifest([]);
    const mod = await import(pathToFileURL(manifestPath).href);
    const raw = mod?.AI_MANIFEST ?? mod?.manifest ?? mod?.default;
    return applyAiManifest(raw);
  } catch {
    return applyAiManifest([]);
  }
}

export { COMMUNITY_AI_CLOUD_PROVIDER, registerAiCloudProvider };
export default loadAiExtensions;
