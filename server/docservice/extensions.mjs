/**
 * 文档服务扩展模块加载入口（公开侧接缝）。
 *
 * 1. 为什么用顶层 await（top-level await）：
 *    `server/docservice/shared-service.mjs` 中的 `createSharedDocService` 是同步函数，且调用方拿到返回值时所有模块必须已经挂载完毕。
 *    因此既不能把 `createSharedDocService` 改成 async，也不能把扩展挂载推迟到下一个 tick 或 Promise 回调中。
 *    在本模块求值阶段通过 ESM 顶层 await 先探测并（若存在）加载 `<云端目录>/docservice/manifest.mjs`，
 *    可以让 `createSharedDocService` 在同步执行时直接拿到已就绪的扩展列表并按顺序同步挂载。
 *
 * 2. 为什么云端目录要能由环境变量 `PROMPTCUT_CLOUD_DIR` 指定（不能只靠 `../..`）：
 *    在最终的双仓子模块布局下，公开仓库作为子模块挂在私有仓库的 `community/` 下（本文件位于 `community/server/docservice/extensions.mjs`），
 *    而 `cloud/docservice/manifest.mjs` 在私有仓库根下。若只靠相对本文件的 `../..`，解析到的是 `community/` 而非私有根，
 *    探测会静默落空、云端扩展全部不挂——且因为私有仓库里两边文件都齐，不会有任何缺文件的报错。
 *    因此支持由 `PROMPTCUT_CLOUD_DIR` 显式指定云端目录位置，缺省仍为 `<当前仓库根>/cloud`，使单仓与子模块两种布局都能工作。
 *
 * 3. 守门规则的唯一例外：
 *    总纲（`docs/plan/community-boundary.md` 第二节不变量 3）规定「共享树里不许出现 `cloud/` 字样」。
 *    **本文件是那条规则在文档服务中的唯一例外，守门测试应当只放行它一个**，别的共享文件一律不许出现 `cloud/`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envCloudDir = process.env.PROMPTCUT_CLOUD_DIR?.trim();
const cloudDir = envCloudDir ? path.resolve(envCloudDir) : path.join(repoRoot, 'cloud');
const manifestFile = path.join(cloudDir, 'docservice/manifest.mjs');

let loaded = [];
if (fs.existsSync(manifestFile)) {
  const mod = await import(pathToFileURL(manifestFile).href);
  const table = mod?.default ?? mod?.manifest;
  if (Array.isArray(table)) loaded = table;
}

export const docServiceExtensions = Object.freeze([...loaded]);
export default docServiceExtensions;
