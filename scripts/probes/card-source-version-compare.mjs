/**
 * Verify "whether source versions of existing cards have changed": compute once for baseline commit
 * and current workspace, and compare card by card.
 *
 * Why it exists: source version of each card = its definition file together with full text of every
 * file in its import closure (`src/render/cardSourceVersion.mjs`). Even adding a single comment line
 * to any file in the closure changes the key for this card's prerender output, and generated card
 * sounds will also be marked expired. Run once after modifying card loading, kernel, or render to
 * confirm existing card keys were not inadvertently changed.
 *
 * Usage (at repository root or worktree root):
 *   node scripts/probes/card-source-version-compare.mjs [--base main]
 *
 * What it does:
 *   1. Extract `src/` from baseline commit to a temp directory via `git archive <base> src` (without
 *      touching workspace or switching branches);
 *   2. Build a source table on each side (matching `src/render/cardSourceFiles.mjs` glob: ts / tsx /
 *      mjs / css under cards, parts, render, kernel, excluding tests), and compute source version
 *      using each file under `src/cards/` and `src/parts/` as an entry (page-side algorithm);
 *   3. Compute server-side code identity (`cardCodeIdentity` in `server/vite-plugin-cards.ts`) for
 *      each built-in card on both sides;
 *   4. Compare one by one. Entries present only in baseline or only in current are listed separately.
 *
 * Output: progress written to stderr; last line of stdout is JSON:
 *   { ok, base, entries, changed: [...], added: [...], removed: [...], identities, identityChanged: [...] }.
 * Pass criteria: both changed and identityChanged are empty (added files are not counted as changes).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const BASE = arg('--base', 'main');
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, ...fields })}\n`);

const { cardSourceVersion } = await import(pathToFileURL(path.join(ROOT, 'src/render/cardSourceVersion.mjs')).href);
const cards = await import(pathToFileURL(path.join(ROOT, 'server/vite-plugin-cards.ts')).href);

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);

/** Source table for a tree: `/src/...` → raw text (matches glob in cardSourceFiles.mjs) */
function sourceTable(root) {
  const files = {};
  for (const dir of ['cards', 'parts', 'render', 'kernel']) {
    for (const abs of walk(path.join(root, 'src', dir))) {
      if (!/\.(ts|tsx|mjs|css)$/.test(abs) || /\.test\.(ts|tsx|mjs|js)$/.test(abs)) continue;
      files[`/${path.relative(root, abs).replace(/\\/g, '/')}`] = fs.readFileSync(abs, 'utf8');
    }
  }
  return files;
}

/** Source version (hash) using each card / part file as an entry */
function versions(root) {
  const files = sourceTable(root);
  const out = new Map();
  for (const key of Object.keys(files)) {
    if (!/^\/src\/(cards|parts)\//.test(key) || !/\.(ts|tsx)$/.test(key)) continue;
    out.set(key, sha(cardSourceVersion({ id: 'entry-given' }, files, key)));
  }
  return out;
}

/** Server-side code identity for each built-in card */
function identities(root) {
  const out = new Map();
  for (const id of cards.builtinCardIds(root).sort()) {
    const identity = cards.cardCodeIdentity(root, id);
    out.set(id, identity ? `${identity.version}${identity.custom ? ':custom' : ''}` : 'none');
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-source-version-'));
let result = { ok: false };
try {
  const tar = path.join(tmp, 'base.tar');
  const archive = spawnSync('git', ['archive', '--format=tar', '-o', tar, BASE, 'src'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`git archive ${BASE} failed: ${archive.stderr}`);
  const baseRoot = path.join(tmp, 'base');
  fs.mkdirSync(baseRoot);
  const untar = spawnSync('tar', ['-xf', 'base.tar', '-C', 'base'], { cwd: tmp, windowsHide: true, encoding: 'utf8' });
  if (untar.status !== 0) throw new Error(`Unpack failed: ${untar.stderr}`);
  const baseCommit = spawnSync('git', ['rev-parse', '--short', BASE], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).stdout.trim();
  say('base', { ref: BASE, commit: baseCommit });

  // An overlay layer causes "effective source" to differ from the checkout:
  // this compares two checkouts without overlay layers
  delete process.env.PROMPTCUT_CARD_OVERRIDES;
  const before = versions(baseRoot), after = versions(ROOT);
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)).sort();
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  say('versions', { base: before.size, head: after.size, changed: changed.length, added: added.length, removed: removed.length });

  const idBefore = identities(baseRoot), idAfter = identities(ROOT);
  const identityChanged = [...idAfter.keys()].filter((id) => idBefore.has(id) && idBefore.get(id) !== idAfter.get(id)).sort();
  const identityAdded = [...idAfter.keys()].filter((id) => !idBefore.has(id)).sort();
  say('identities', { base: idBefore.size, head: idAfter.size, changed: identityChanged.length, added: identityAdded.length });

  result = { ok: changed.length === 0 && identityChanged.length === 0, base: `${BASE}@${baseCommit}`, entries: after.size, changed, added, removed, identities: idAfter.size, identityChanged, identityAdded };
} catch (err) {
  result = { ok: false, error: String(err?.message ?? err) };
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
