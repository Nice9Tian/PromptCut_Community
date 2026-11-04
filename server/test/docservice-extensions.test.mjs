/**
 * Unit tests for `server/docservice/extensions.mjs`: how cloud loading table is found and what to
 * do if missing (seams outline `docs/plan/community-boundary.md` sections 1 and 2).
 *
 * Why it must be tested: this module's failure mode is **silent**: an incorrect path means "not
 * mounting any extension", with no exception and no log, while both sides have all files in the
 * private repository so missing ones cannot be spotted. The submodule layout (public repository
 * mounted under `community/` of private repository) is precisely the layout that causes relative
 * paths to point incorrectly, so the `PROMPTCUT_CLOUD_DIR` path must be pinned down by tests,
 * rather than relying solely on the default path passing.
 *
 * The module finishes reading the table during evaluation (top-level await), so each test case
 * fetches a fresh copy using dynamic import with a query string.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Community edition (public repo) has no cloud/: tests for the closed-source half are skipped
// there, matching the approach in agent-extensions EXT1
const NO_CLOUD = fs.existsSync(path.join(HERE, '..', '..', 'cloud')) ? false : 'The current checkout has no cloud/ directory (community edition)';
const ENTRY = path.join(HERE, '..', 'docservice', 'extensions.mjs');

/** Load a fresh `extensions.mjs` (bypasses module cache to rerun top-level await) */
async function loadFresh(tag) {
  const mod = await import(`${pathToFileURL(ENTRY).href}?case=${tag}`);
  return mod.docServiceExtensions;
}

/** Create a temporary cloud directory with a table inside */
function makeCloudDir(items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-'));
  fs.mkdirSync(path.join(dir, 'docservice'), { recursive: true });
  const body = `export const manifest = ${JSON.stringify(items)}.map((name) => ({ name, create: () => ({ name }) }));\nexport default manifest;\n`;
  fs.writeFileSync(path.join(dir, 'docservice', 'manifest.mjs'), body, 'utf8');
  return dir;
}

const withEnv = async (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PROMPTCUT_CLOUD_DIR');
  const old = process.env.PROMPTCUT_CLOUD_DIR;
  if (value === null) delete process.env.PROMPTCUT_CLOUD_DIR;
  else process.env.PROMPTCUT_CLOUD_DIR = value;
  try {
    return await fn();
  } finally {
    if (had) process.env.PROMPTCUT_CLOUD_DIR = old;
    else delete process.env.PROMPTCUT_CLOUD_DIR;
  }
};

test('EXT1 without the environment variable: looks under cloud/ in the repo root, and the hosted entry is found in this repo', { skip: NO_CLOUD }, async () => {
  const table = await withEnv(null, () => loadFresh('default'));
  assert.ok(Array.isArray(table), 'the export should be an array');
  assert.deepEqual(table.map((x) => x.name), ['hosted'], 'in this repo cloud/docservice/manifest.mjs currently has only the hosted entry');
});

test('EXT2 with the environment variable set: looks in the directory it points to, no longer at the repo root', async () => {
  const dir = makeCloudDir(['alpha', 'beta']);
  const table = await withEnv(dir, () => loadFresh('env'));
  assert.deepEqual(table.map((x) => x.name), ['alpha', 'beta'], 'table order must be preserved as is (community first, cloud last relies on exactly this)');
});

test('EXT3 pointed at a directory with no table: returns an empty array, does not throw. This is exactly the case of the community edition', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-nocloud-'));
  const table = await withEnv(empty, () => loadFresh('missing'));
  assert.deepEqual(table, [], 'When no table is found, no extension is attached, but it must not raise an error');
});

test('EXT4 a table with the wrong shape (not an array) also returns an empty array, so a bad table is never handed to the document service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-badcloud-'));
  fs.mkdirSync(path.join(dir, 'docservice'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docservice', 'manifest.mjs'), 'export default { notAnArray: "array" };\n', 'utf8');
  const table = await withEnv(dir, () => loadFresh('bad'));
  assert.deepEqual(table, []);
});

test('EXT5 the exported table is frozen: callers cannot modify it', async () => {
  const table = await withEnv(null, () => loadFresh('frozen'));
  assert.ok(Object.isFrozen(table));
});
