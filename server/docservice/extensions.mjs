/**
 * Document service extension module loading entry point (public-side seam).
 *
 * 1. Why top-level await is used:
 *    `createSharedDocService` in `server/docservice/shared-service.mjs` is a synchronous function,
 *    and all modules must be mounted by the time the caller receives the return value. Therefore,
 *    we can neither change `createSharedDocService` to async nor defer extension mounting to the
 *    next tick or Promise callback. Probing and (if present) loading
 *    `<cloud-dir>/docservice/manifest.mjs` via ESM top-level await during this module's evaluation
 *    phase allows `createSharedDocService` to directly obtain the ready extensions list during
 *    synchronous execution and mount them synchronously in order.
 *
 * 2. Why the cloud directory must be configurable via environment variable `PROMPTCUT_CLOUD_DIR`
 *    (cannot rely solely on `../..`):
 *    Under the final dual-repo submodule layout, the public repo is mounted as a submodule under
 *    `community/` in the private repo (this file is located at
 *    `community/server/docservice/extensions.mjs`), while `cloud/docservice/manifest.mjs` is at the
 *    private repo root. If we rely only on `../..` relative to this file, it resolves to
 *    `community/` rather than the private root, causing probing to fail silently and no cloud
 *    extensions to mount: and because both sides' files exist in the private repo, no missing-file
 *    errors would be raised. Therefore, `PROMPTCUT_CLOUD_DIR` is supported to explicitly specify
 *    the cloud directory location, defaulting to `<repo-root>/cloud`, allowing both single-repo
 *    and submodule layouts to work.
 *
 * 3. The sole exception to gatekeeper rules:
 *    The charter (`docs/plan/community-boundary.md` Section 2 Invariant 3) states that "the term
 *    `cloud/` must not appear in the shared tree".
 *    **This file is the sole exception to that rule in the document service, and gatekeeper tests
 *    should only permit this single file**; no other shared file may contain `cloud/`.
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
