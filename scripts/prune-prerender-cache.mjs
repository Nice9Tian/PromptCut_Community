#!/usr/bin/env node
/**
 * Prune old caches in the frame store that will no longer be referenced (orphan directories after M4
 * key change).
 *
 * Why orphans exist: Starting with M4, prerender result keys are multiplied by environment
 * fingerprints (`docs/plan/render-queue-contract.md` section E); the same merge also modified
 * prerender pipeline code, so keys for whole scene caches and track prefix caches carry the code
 * version (`frameCode`) and were changed together. Directories written before the key change can no
 * longer have their names computed and only consume disk space.
 *
 * How to determine "old": Keys are hashes, so age cannot be discerned from directory names; instead,
 * determined by time: only a key directory whose **newest** file is earlier than the cutoff
 * timestamp (default is when M4 merged into main) is considered old. Directories written after the key
 * change will have newer files, so they will not be deleted by mistake; directories written after the
 * cutoff by processes still running old code will remain, and can be cleaned by running again later.
 *
 * Which directories are managed (all under frame store root, one directory per key):
 *   controls-html/<key>               shared tier snapshots
 *   controls-local/<entry.key>/<key>  local tier snapshots (deleted together if outer directory is empty)
 *   controls/<key>                    standalone card PNG cache
 *   streams/<key>                     track stream
 *   tracks/<key>                      track prefix cache (key includes code version)
 *   <entry.key>                       whole scene cache (key includes code version)
 * Do not touch: `controls-lock/` (per-card fingerprint lock, present only after M4), regular files
 * under root, unrecognized directories.
 *
 * Default only lists without deleting; add `--apply` to actually delete. Symlinks or junctions are
 * always skipped and not followed for deletion.
 *
 * Usage:
 *   node scripts/prune-prerender-cache.mjs                 # list old directories in out/frame-library
 *   node scripts/prune-prerender-cache.mjs --apply         # actually delete
 *   --root <frame-store-dir>   default $PROMPTCUT_EXPORT_DIR/frame-library, if unset ./out/frame-library
 *   --before <timestamp>       ISO time or milliseconds, default M4_KEYS_SINCE
 *   --json                     print results as JSON
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { M4_KEYS_SINCE, findStale, removeStale, looksLikeFrameLibrary } from '../server/prerender-cache-prune.mjs';

function parseArgs(argv) {
  const opts = { apply: false, json: false, root: null, before: M4_KEYS_SINCE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--root') opts.root = argv[++i];
    else if (arg === '--before') {
      const raw = argv[++i];
      const value = /^\d+$/.test(raw ?? '') ? Number(raw) : Date.parse(raw);
      if (!Number.isFinite(value)) throw new Error(`--before not recognized: ${raw}`);
      opts.before = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  opts.root ||= path.join(process.env.PROMPTCUT_EXPORT_DIR || path.join(process.cwd(), 'out'), 'frame-library');
  return opts;
}

const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root);
  if (!await looksLikeFrameLibrary(root)) {
    console.error(`${root} does not look like a frame store (no controls-html / controls / streams subdirectories), skipping.`);
    process.exit(2);
  }
  const { stale, kept, skipped } = await findStale(root, opts.before);
  const byFamily = {};
  for (const item of stale) {
    const row = (byFamily[item.family] ||= { dirs: 0, bytes: 0 });
    row.dirs++; row.bytes += item.bytes;
  }
  const total = stale.reduce((sum, item) => sum + item.bytes, 0);
  const removed = opts.apply ? await removeStale(root, stale) : 0;
  const summary = { root, before: new Date(opts.before).toISOString(), applied: opts.apply, stale: stale.length, bytes: total,
    kept, skipped: skipped.map(item => item.dir), byFamily, removed };
  if (opts.json) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`Frame store: ${root}`);
  console.log(`Cutoff: ${summary.before} (key directories whose newest file is older than this count as stale)`);
  for (const [family, row] of Object.entries(byFamily)) console.log(`  ${family.padEnd(15)} ${String(row.dirs).padStart(5)} directories  ${mb(row.bytes)}`);
  console.log(`Stale directories total ${stale.length}, ${mb(total)}; kept ${kept}; skipped (links) ${skipped.length}`);
  console.log(opts.apply ? `Deleted ${removed} directories.` : 'Listed only, nothing deleted. If everything looks right, run again with --apply.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.message || error); process.exit(1); });
}
