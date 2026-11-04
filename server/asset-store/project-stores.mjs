/**
 * Physical project asset store; does not own project/member authority. Only wired by trusted
 * services passing projectId; does not select stores from HTTP body.
 */
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
/**
 * Internal root registry uses a global symbol, compatible with Vite bundling and direct module
 * instances; environment variables cannot override project root.
 */
export function projectScopeOfRoot(root) { return roots().get(path.resolve(root)) ?? null; }

/**
 * createProjectAssetStores({ dir, kind:'fs'|'memory', contentTypeForExt?, chunkSize? })
 * -> { v:2, project(id):{projectId,root,dir,stores:{media,snap,px}}, store(id,ns), removeProject(id, { recreatable? }) }
 * Each project has an independent complete store/chunks/indices/tiers/queue/px usage; identical
 * hashes are not reused across stores. removeProject is an internal deletion mechanism, not a user
 * permission decision.
 * `recreatable: true` (used for reclaiming bytes of deleted projects, `project-reaper.mjs`,
 * claude/guest-fix): removes the "deleted" flag after the directory is cleanly deleted, so an
 * **empty** store can be created again later under the same project id. Who can recreate it is
 * determined by the document service (central owner): it only allows the original creator to reuse
 * project ids they deleted (`createProject` in `server/account/authority.mjs`), and every read and
 * write must first pass its permission check. During deletion and on deletion failure, the flag
 * remains in place, and stores for this project id always yield `project-gone`, preventing new
 * bytes from being written into a half-deleted directory.
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
      // Retry deletion that failed halfway last time (marked as deleted, directory still exists):
      // bypasses project(), which only throws project-gone for deleted ids
      const p = removed.has(assertProjectId(projectId)) ? projects.get(projectId) ?? null : project(projectId);
      const dir = p?.dir ?? path.join(base, 'projects', projectStorageKey(projectId));
      // First mark as deleted and invalidate old references, then delete physical directory; old
      // references cannot be reused as new stores. Callers must first close tasks/streams for this project.
      removed.add(projectId);
      p?.retire();
      projects.delete(projectId);
      if (kind === 'fs') await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (recreatable) removed.delete(projectId);
      // Preserve root identity to prevent late code from falling back to global environment paths after
      // deletion. Central owner must authorize recreation.
      return { projectId, removed: true };
    },
  };
}
