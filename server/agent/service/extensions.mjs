/**
 * Agent service extension module loading entry point (public-side seam).
 *
 * 1. Why lazy loading (no top-level await during module evaluation):
 *    `cloud/agent/account-runner.mjs` statically references
 *    `server/agent/service/conversation-policy.mjs`, and `conversation-policy.mjs` in turn
 *    statically references `create-agent-service.mjs` (which then references this file).
 *    If top-level await is used to dynamically import `cloud/agent/manifest.mjs` during this
 *    module's evaluation phase, it creates an ESM top-level await circular wait deadlock:
 *    `extensions.mjs (top-level await) -> manifest.mjs -> account-runner.mjs -> conversation-policy.mjs -> create-agent-service.mjs -> extensions.mjs`.
 *    Therefore, this module performs no loading during evaluation, deferring the probing and
 *    loading of `<cloud directory>/agent/manifest.mjs` to the first call to `getAgentExtensions()` /
 *    `findAgentExtension(name)` (when all static ESM modules have finished evaluating), and caches
 *    the result by resolved path.
 *
 * 2. Why the cloud directory must be configurable via the `PROMPTCUT_CLOUD_DIR` environment
 *    variable (and cannot rely solely on `../../..`):
 *    Under a dual-repo submodule layout, the public repository is mounted as a submodule under
 *    `community/` of the private repository (this file is located at
 *    `community/server/agent/service/extensions.mjs`), while `cloud/agent/manifest.mjs` is at the
 *    private repository root. Supporting explicit specification of the cloud directory location
 *    via `PROMPTCUT_CLOUD_DIR`, defaulting to `<current repo root>/cloud`, allows both single-repo
 *    and submodule layouts to work.
 *
 * 3. The only exception to the gatekeeper rule:
 *    The master plan (`docs/plan/community-boundary.md` Section 2 Invariant 3) stipulates that
 *    "the string `cloud/` must not appear in the shared tree".
 *    **This file is the sole exception to that rule in the Agent service; the gatekeeper test
 *    should only pass this one**, and no other shared file is ever allowed to contain `cloud/`.
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
 * Lazily probes and loads the Cloud Agent extension list. Community edition (without
 * `cloud/agent/manifest.mjs`) returns frozen empty array `[]`.
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
 * Gets a mounted Agent extension by name. Community edition (without `cloud/agent/manifest.mjs`)
 * returns `null`.
 * @param {string} name
 */
export function findAgentExtension(name) {
  const list = getAgentExtensions();
  for (const ext of list) {
    if (ext && ext.name === name) return ext;
  }
  return null;
}
