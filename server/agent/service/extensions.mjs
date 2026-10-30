/**
 * Agent 服务扩展模块加载入口（公开侧接缝）。
 *
 * 1. 为什么惰性加载（不在模块求值阶段顶层 await）：
 *    `cloud/agent/account-runner.mjs` 静态引用了 `server/agent/service/conversation-policy.mjs`，
 *    而 `conversation-policy.mjs` 又静态引用了 `create-agent-service.mjs`（后者再引用本文件）。
 *    若在本模块求值阶段用顶层 await 动态 import `cloud/agent/manifest.mjs`，会形成
 *    `extensions.mjs (top-level await) -> manifest.mjs -> account-runner.mjs -> conversation-policy.mjs -> create-agent-service.mjs -> extensions.mjs`
 *    的 ESM 顶层 await 循环等待死锁。
 *    因此本模块在求值阶段不做任何加载，将 `<云端目录>/agent/manifest.mjs` 的探测与加载推迟到第一次调用
 *    `getAgentExtensions()` / `findAgentExtension(name)` 时（此时所有静态 ESM 模块均已求值完毕），并按解析后的路径缓存结果。
 *
 * 2. 为什么云端目录要能由环境变量 `PROMPTCUT_CLOUD_DIR` 指定（不能只靠 `../../..`）：
 *    在双仓子模块布局下，公开仓库作为子模块挂在私有仓库的 `community/` 下（本文件位于 `community/server/agent/service/extensions.mjs`），
 *    而 `cloud/agent/manifest.mjs` 在私有仓库根下。支持由 `PROMPTCUT_CLOUD_DIR` 显式指定云端目录位置，
 *    缺省仍为 `<当前仓库根>/cloud`，使单仓与子模块两种布局都能工作。
 *
 * 3. 守门规则的唯一例外：
 *    总纲（`docs/plan/community-boundary.md` 第二节不变量 3）规定「共享树里不许出现 `cloud/` 字样」。
 *    **本文件是那条规则在 Agent 服务中的唯一例外，守门测试应当只放行它一个**，别的共享文件一律不许出现 `cloud/`。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EMPTY = Object.freeze([]);

/** @type {Map<string, ReadonlyArray<any>>} */
const cache = new Map();

function resolveManifestFile() {
  const envCloudDir = process.env.PROMPTCUT_CLOUD_DIR?.trim();
  const cloudDir = envCloudDir ? path.resolve(envCloudDir) : path.join(repoRoot, 'cloud');
  return path.join(cloudDir, 'agent/manifest.mjs');
}

/**
 * 惰性探测并加载云端 Agent 扩展表。社区版（无 `cloud/agent/manifest.mjs`）回冻结空数组 `[]`。
 * @returns {ReadonlyArray<any>}
 */
export function getAgentExtensions() {
  const manifestFile = resolveManifestFile();
  const cached = cache.get(manifestFile);
  if (cached) return cached;
  if (!fs.existsSync(manifestFile)) {
    cache.set(manifestFile, EMPTY);
    return EMPTY;
  }
  const mod = require(manifestFile);
  const table = mod?.default ?? mod?.manifest;
  const loaded = Array.isArray(table) ? Object.freeze([...table]) : EMPTY;
  cache.set(manifestFile, loaded);
  return loaded;
}

/**
 * 按名字取已挂载的 Agent 扩展。社区版（无 `cloud/agent/manifest.mjs`）回 `null`。
 * @param {string} name
 */
export function findAgentExtension(name) {
  const list = getAgentExtensions();
  for (const ext of list) {
    if (ext && ext.name === name) return ext;
  }
  return null;
}
