/**
 * What this product edition includes: which locations the collaboration panel can select, whether
 * there is a hosted side, and where the account cloud is located.
 *
 * The declaration is a configuration file, one each for public edition and commercial edition, with
 * different content: `product.config.json` at repo root is for the public edition; if
 * `<cloud directory>/product.config.json` exists, use it (cloud directory follows the same
 * convention as `server/docservice/extensions.mjs`). No hosted addresses are written in the public
 * tree (G6 of `server/test/community-boundary.test.mjs`); addresses reside only in the commercial
 * edition copy.
 *
 * Two ways to obtain the same file:
 * - Browser: `server/vite-plugin-cloud-seams.ts` writes declaration into `__PROMPTCUT_PRODUCT__` at
 *   build time;
 * - Node: reads file synchronously here. This module must also be importable by browsers
 *   (`hosted-default.mjs` must not statically import node: built-in modules), so built-in modules are
 *   fetched via `process.getBuiltinModule`; without `process` in browsers, this path is skipped
 *   naturally.
 *
 * If neither can be read (deployments carrying only partial files), it is treated as "nothing present",
 * identical to the public edition declaration.
 *
 * Gatekeeper exception declaration: this file is registered in `LOADER_WHITELIST` of
 * `server/test/community-ownership.mjs`; it only reads this declaration under the cloud directory
 * without loading code.
 */
/* global __PROMPTCUT_PRODUCT__ */

const NOTHING = { collab: { targets: [] }, hosted: null, accountCloudOrigin: null };

function readDeclaration() {
  const proc = globalThis.process;
  const fs = proc?.getBuiltinModule?.('node:fs');
  if (!fs) return null;
  const path = proc.getBuiltinModule('node:path');
  const { fileURLToPath } = proc.getBuiltinModule('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const envCloudDir = proc.env.PROMPTCUT_CLOUD_DIR?.trim();
  const cloudDir = envCloudDir ? path.resolve(envCloudDir) : path.join(root, 'cloud');
  for (const file of [path.join(cloudDir, 'product.config.json'), path.join(root, 'product.config.json')]) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

export const PRODUCT = Object.freeze({
  ...NOTHING,
  ...(typeof __PROMPTCUT_PRODUCT__ !== 'undefined' ? __PROMPTCUT_PRODUCT__ : readDeclaration()),
});
