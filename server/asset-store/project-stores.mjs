/** 项目物理素材库；不拥有项目/成员权威。只由可信服务接线传 projectId，不从 HTTP body 选库。 */
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createFsStore } from './fs-store.mjs';
import { createMemoryStore } from './memory-store.mjs';
import { publishProjectFile, projectFileAccepted, recoverProjectPublications } from './project-io.mjs';

const ROOTS = Symbol.for('promptcut.asset.project-roots.v2');
const roots = () => (globalThis[ROOTS] ??= new Map());
export const PROJECT_ASSET_LAYOUT_VERSION = 2;
export function assertProjectId(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new TypeError('invalid-project-id');
  return value;
}
export function projectStorageKey(projectId) { return crypto.createHash('sha256').update(assertProjectId(projectId)).digest('hex'); }
/** 内部 root 注册表使用全局 symbol，兼容 Vite 打包与直接模块实例；环境变量不能覆盖项目 root。 */
export function projectScopeOfRoot(root) { return roots().get(path.resolve(root)) ?? null; }

/**
 * createProjectAssetStores({ dir, kind:'fs'|'memory', contentTypeForExt?, chunkSize? })
 * -> { v:2, project(id):{projectId,root,dir,stores:{media,snap,px}}, store(id,ns), removeProject(id, { recreatable? }) }
 * 每项目独立完整库/分片/索引/tiers/queue/px usage；同 hash 不跨库复用。removeProject 是内部删除机制，非用户权限决策。
 * `recreatable: true`（删掉的项目回收字节用，`project-reaper.mjs`，claude/guest-fix）：目录删干净之后撤掉「已删除」标记，
 * 同一个项目号以后还能再建一个**空的**库。谁能再建由文档服务（中央 owner）定：它只让原创建者重用自己删掉的项目号
 * （`server/account/authority.mjs` 的 `createProject`），每一次读写都先过它的核权。删的途中、删失败时标记一直在，
 * 这个项目号的库一律 `project-gone`，不会有新字节写进删了一半的目录。
 */
export function createProjectAssetStores({ dir, kind = 'fs', contentTypeForExt, chunkSize } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('project asset dir required');
  if (!['fs', 'memory'].includes(kind)) throw new TypeError('unsupported-project-store');
  const base = path.resolve(dir), projects = new Map(), removed = new Set();
  function project(projectId) {
    assertProjectId(projectId);
    if (removed.has(projectId)) throw Object.assign(new Error('project-gone'), { code: 'project-gone', status: 404 });
    if (projects.has(projectId)) return projects.get(projectId);
    const root = path.join(base, 'projects', projectStorageKey(projectId));
    if (kind === 'fs') recoverProjectPublications(root);
    const dirs = { media: path.join(root, 'out', 'media'), snap: path.join(root, 'out', 'asset-store', 'snap'), px: path.join(root, 'out', 'asset-store', 'px') };
    let active = true;
    const assertActive = () => { if (!active) throw Object.assign(new Error('project-gone'), { code: 'project-gone', status: 404 }); };
    const stores = {};
    for (const ns of Object.keys(dirs)) {
      const hooks = { isPublished: projectFileAccepted, contentTypeForExt: ext => ext === 'html' ? 'text/html; charset=utf-8' : ext === 'm4s' ? 'video/iso.segment' : contentTypeForExt?.(ext) ?? 'application/octet-stream' };
      const raw = kind === 'fs' ? createFsStore({ dir: dirs[ns], hooks, chunkSize }) : createMemoryStore({ chunkSize });
      Object.defineProperty(raw, 'projectId', { value: projectId });
      Object.defineProperty(raw, 'namespace', { value: ns });
      Object.defineProperty(raw, 'projectDir', { value: dirs[ns] });
      stores[ns] = new Proxy(raw, { get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args) => {
          assertActive();
          if (key === 'putChunk' || key === 'complete') {
            const n = key === 'putChunk' ? 2 : 1, options = args[n] ?? {}, previous = options.beforeCommit;
            args[n] = { ...options, beforeCommit: async () => { assertActive(); await previous?.(); assertActive(); } };
          }
          return value.apply(target, args);
        };
      } });
    }
    const scope = Object.freeze({ v: 2, projectId, root, dir: root, dirs: Object.freeze(dirs), stores: Object.freeze(stores), assertActive, publishProjectFile, projectFileAccepted, retire: () => { active = false; } });
    roots().set(root, scope);
    projects.set(projectId, scope);
    return scope;
  }
  return {
    v: 2, dir: base, project,
    store(projectId, ns) { if (!['media', 'snap', 'px'].includes(ns)) throw new TypeError('invalid-namespace'); return project(projectId).stores[ns]; },
    async removeProject(projectId, { recreatable = false } = {}) {
      // 上一次删到一半失败（已标成删除、目录还在）的再删一次：不经 project()，它对已删除的号只会抛 project-gone
      const p = removed.has(assertProjectId(projectId)) ? projects.get(projectId) ?? null : project(projectId);
      const dir = p?.dir ?? path.join(base, 'projects', projectStorageKey(projectId));
      // 先标成删除、让旧引用失效，再删物理目录；旧引用不能被重用为新库。调用者必须先关闭该项目任务/流。
      removed.add(projectId);
      p?.retire();
      projects.delete(projectId);
      if (kind === 'fs') await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (recreatable) removed.delete(projectId);
      // 保持 root 身份，避免删除后迟到代码退回全局环境路径。中央 owner 必须授权重新创建。
      return { projectId, removed: true };
    },
  };
}
