import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const fingerprints = new Map();
const captures = new Map();
const snapshots = new Map();
/** Parent of server/: repository root, and also the runtime/app root after packaging.
 * snapshotCode only reads source code; callers (card-cache) use this when they only hold the cache
 * directory and cannot obtain the repository root. */
const APP_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
/** Code that decides which pixels a screenshot contains. A fix here (e.g. a
 * readiness wait or a stale-screenshot guard) must retire frames captured by
 * the old code, including card caches whose keys do not contain frameCode. */
/* That entire `scripts/export-frames.mjs` file is now seven modules in `server/bakery/`
 * (chrome / bake / shards / media / ffmpeg / export / audio-mix), all seven listed together:
 * the hashed content is exactly identical to before the move, neither more nor less. */
const BAKERY_FILES = ['server/bakery/chrome.mjs', 'server/bakery/bake.mjs', 'server/bakery/shards.mjs',
  'server/bakery/media.mjs', 'server/bakery/ffmpeg.mjs', 'server/bakery/export.mjs', 'server/bakery/audio-mix.mjs'];
/* Direct canvas capture (grabbing pixels from the canvas when producing track streams, bypassing
 * screenshots) also determines pixels in the stream via two files: `capture-canvas.mjs` on the
 * Node side and `src/render/gl/canvasGrab.ts` on the page side. They do not determine snapshot HTML
 * and do not enter `SNAPSHOT_FILES` below. The same applies to differential layer extraction for
 * below-dependent streams (`capture-below.mjs`: how to hide target cards and compute that layer from
 * two screenshots). */
const CAPTURE_FILES = [...BAKERY_FILES, 'server/bakery/capture-frame.mjs', 'server/bakery/capture-snapshot.mjs', 'server/bakery/frame-media.mjs',
  'server/bakery/frame-ready.mjs', 'server/bakery/png-integrity.mjs', 'server/bakery/capture-canvas.mjs', 'src/render/gl/canvasGrab.ts',
  'server/bakery/capture-below.mjs'];
/**
 * Source code is hashed as text, normalizing newlines to LF first: the repository is `text=auto`,
 * checked out as CRLF on Windows and LF on Linux; the same commit must not compute two different
 * code versions across the two machines (standalone render hosts on other machines partition pools
 * by code version and verify tasks by snapshot key).
 */
const textOf = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
/* What is hashed is the verbatim file content, including comments: modifying any file in the
 * manifests below, even touching a single line of comments, will change the code version,
 * invalidating all existing snapshot keys and card cache keys, forcing the entire site to rerender
 * on next deployment. Precedent: in the probe audit on 2026-10-23, changing the probe path in the
 * header of `src/render/snapshotRename.ts` to the archive path was rejected by [ruling] V21-30 on
 * these grounds, recording its destination in `scripts/archive/probes/README.md`. */
const hashFiles = (hash, root, files) => {
  for (const file of files) {
    hash.update(file);
    try { hash.update(textOf(path.join(root, file))); } catch { hash.update('missing'); }
  }
};
/**
 * Everything in the user card directory except the loading entry point `index.ts` (card files, files
 * they use, ownership table `_scopes.json`) does not enter the global code version (C6.6
 * c66-host-cards): user cards are project content, not the renderer version. If two nodes have one
 * more, one less, or a modified user card, they remain the same code version and the same pool; tasks
 * that use user cards (or cards modified in the overlay layer) separately specify the code identity
 * of the card they need in `requires.cardSources`, and a node claims it only if it has this code
 * (`server/card-code.mjs`). The overlay layer (`card-overrides.mjs`) is not here in the first place:
 * it lives in the data directory, not under `src/`.
 */
export function isUserCardSource(rel) {
  const r = String(rel).replaceAll('\\', '/');
  return r.startsWith('src/cards/user/') && r !== 'src/cards/user/index.ts';
}
export function invalidateFrameCode(root) { fingerprints.delete(root); captures.delete(root); snapshots.delete(root); }
export function frameCode(root) {
  if (fingerprints.has(root)) return fingerprints.get(root);
  const hash = createHash('sha256');
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const file = path.join(dir, item.name);
      const rel = path.relative(root, file).replaceAll('\\', '/');
      if (isUserCardSource(rel)) continue;
      if (item.isDirectory()) walk(file);
      else if (/\.(tsx?|mjs|css|json)$/.test(item.name)) { hash.update(rel); hash.update(textOf(file)); }
    }
  }
  walk(path.join(root, 'src'));
  hashFiles(hash, root, [...CAPTURE_FILES, 'server/frame-pipeline.mjs', 'server/frame-identity.mjs']);
  const value = hash.digest('hex'); fingerprints.set(root, value); return value;
}
export function captureCode(root) {
  if (captures.has(root)) return captures.get(root);
  const hash = createHash('sha256');
  hashFiles(hash, root, CAPTURE_FILES);
  const value = hash.digest('hex').slice(0, 32); captures.set(root, value); return value;
}

/**
 * Code fingerprint for generating snapshots: the only "renderer version" entry in the shared
 * snapshot key (A3a).
 *
 * Hashes only the two in CAPTURE_FILES **related to generating snapshots**: the original
 * `export-frames.mjs` (`__pcCreateSnapshot` core: style inlining, id renaming, replacing canvas with
 * img, cutting the control subtree by data-pc-clip; after the move, these are the seven modules in
 * `server/bakery/`) and `capture-snapshot.mjs` (injecting snapshot HTML back into the document for
 * rasterization); plus `src/render/createSnapshot.ts` on the page side along with the four modules it
 * calls (`snapshot/inlineStyles.ts` / `snapshot/rasterizeCanvas.ts` /
 * `snapshot/snapshotStyleProps.mjs` / `snapshot/renameSceneIds.ts`) and
 * `src/render/snapshotRename.ts`. The remaining CAPTURE_FILES (capture-frame / frame-media /
 * frame-ready / png-integrity) determine **screenshots**, not snapshot HTML content, and are not
 * included in this fingerprint.
 *
 * J1 linkage (must be read together): after J1 moved snapshot generation logic from the original
 * export-frames.mjs into src/, **additions are made here only when snapshot code itself splits
 * files**: the set must precisely cover those files that determine snapshot content. Thus:
 *   - Modify snapshot generation code → fingerprint changes → shared key changes → old snapshots
 *     naturally invalidate and will not be erroneously reused;
 *   - No modification → fingerprint unchanged → old snapshots are reused across machines as usual,
 *     and the move itself does not invalidate any snapshots.
 * Counterexample: using `frameCode` directly (which hashes all of src/ (except user cards) plus
 * frame-pipeline.mjs) would wipe out shared snapshots worldwide on any unrelated card change,
 * rendering the shared tier useless.
 *
 * Missing files are recorded as `'missing'` following the established `hashFiles` convention: the
 * fingerprint remains deterministic even when a module is not yet landed.
 */
const SNAPSHOT_FILES = [...BAKERY_FILES, 'server/bakery/capture-snapshot.mjs',
  'src/render/createSnapshot.ts', 'src/render/snapshot/inlineStyles.ts',
  'src/render/snapshot/rasterizeCanvas.ts', 'src/render/snapshot/snapshotStyleProps.mjs',
  'src/render/snapshot/renameSceneIds.ts', 'src/render/snapshotRename.ts'];
export function snapshotCode(root = APP_ROOT) {
  if (snapshots.has(root)) return snapshots.get(root);
  const hash = createHash('sha256');
  hashFiles(hash, root, SNAPSHOT_FILES);
  const value = hash.digest('hex').slice(0, 32); snapshots.set(root, value); return value;
}
