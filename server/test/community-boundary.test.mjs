/**
 * Gatekeeper test for community edition boundaries (seams overview
 * `docs/plan/community-boundary.md` Section 2 "Invariants").
 *
 * What to guard: PromptCut is open-sourcing a community edition by using the **public repo as the
 * canonical source**, mounting it in the private repo as a git submodule under `community/`, while
 * the private repo itself only hosts `cloud/`. Sync has **only one direction**: public → private.
 * Therefore, the invariant is "files in the shared tree must not differ by a single character
 * between the two repos".
 *
 * Why this must be tested: violations of this invariant happen **silently**. Adding a line like
 * `import ... from '../cloud/...'` to a public file in the private repo breaks nothing locally
 * (the private repo has all files on both sides); what breaks is during the next sync, when this
 * import in the public repo tree points to a non-existent file, and by then it has already been
 * pushed out. In open-sourcing, the cost of leaking a single item is "server internal structures
 * entering public history", which cannot be cleanly purged from git history.
 *
 * Four gates:
 *   G1  Public files must not **load** `cloud/` (imports, dynamic imports, string-concatenated
 *       paths all count; comments do not count)
 *   G2  Extension entry points of each block may only look for load tables under the "cloud
 *       directory" variable, without hardcoding relative paths to escape
 *   G3  Ratchet: the number of files on the public side still importing closed source may only
 *       decrease, never increase
 *   G4  Every cloud load table must be synchronously require-able (callsites using createRequire
 *       will throw directly)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BOUNDARY_TOOLING,
  CLOUD_DIRS,
  CLOUD_FILES,
  LAN_DIRS,
  LAN_FILES,
  LOADER_WHITELIST,
  commentRanges,
  importsOf,
  inComment,
  isCloud,
  isTest,
  listCodeFiles,
  listPublicFiles,
} from './community-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Ceiling for G3. **May only decrease, never increase.**
 *
 * This is the number of product files where "public side still imports closed source directories"
 * (excluding tests and probes). Decoupling seams is the process of driving it to 0. Decrement this
 * number after a chunk of work is merged; if any change makes it larger, this test turns red: that
 * indicates new code in the public side imported closed source stuff again, either by misjudging
 * ownership or by failing to use seams where required.
 *
 * 2026-10-27: 58 (after reclassifying `src/online/l2.ts` `l2Costs.ts` as public, see overview
 * Section 9; baseline when five chunks of work started was 60. Generate manifest:
 * `node scripts/dev/community-seams.mjs . --md`)
 */
// On 2026-10-27, after all five chunks of work were merged and cross-work todos resolved, the
// public side **no longer has a single product file importing closed source**.
// This is the prerequisite for Section 7 "Switch to two-repository layout", so the ceiling is 0:
// adding even one will fail the test.
const SEAM_CEILING = 0;

/**
 * Files to check in the shared tree: public product code (tests and probes follow topics and are
 * not in this rule)
 */
function sharedProductionFiles() {
  return listCodeFiles(ROOT).filter((rel) => !isCloud(rel) && !isTest(rel));
}

test('G1 public product files must not load anything under cloud/ (mentions in comments do not count)', () => {
  // Extension entry points actually load it; boundary tools merely write the `cloud/` name as data
  // (see comments in the ownership table for the difference between the two)
  const whitelist = new Set([...LOADER_WHITELIST, ...BOUNDARY_TOOLING]);
  const offenders = [];

  for (const rel of sharedProductionFiles()) {
    if (whitelist.has(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!src.includes('cloud')) continue; // The vast majority of files return here and do not need to be scanned
    const comments = commentRanges(src);
    // Both patterns must be caught:
    //   1. `'cloud/...'`: path literals with a slash. import specifiers and concatenated paths both look
    //      like this, and are the kind that actually occur.
    //   2. `path.join(root, 'cloud', ...)`: treating cloud as a separate segment. Searching only for the
    //      first pattern lets this slip right through (verified by building a probe on 2026-10-27).
    //
    // The second pattern **only counts in path-concatenation contexts**. A standalone `'cloud'` string
    // in this codebase is mostly a **value** rather than a path segment: realm name, AI panel mode,
    // `data-pcm-agent` attribute; scanning for it naively yields seven false positives.
    // Therefore, it is only classified as concatenating paths if the same statement also contains
    // path.join / path.resolve / import(.
    //
    // Clarify the boundaries of this check: it catches casual writes and segment-joining, but cannot
    // catch deliberate obfuscation (`'c'+'loud'`, reading paths from configuration). Those must rely on
    // G3 calculated from the resolved import graph, as well as human review of diffs.
    // Construct with RegExp rather than regex literals: the tool writing this file on this machine
    // eats escapes like backslash-b into backspaces, hit this three times.
    const ARRAY_ELEMENT = new RegExp(String.raw`(?:\[|,)\s*['\"]cloud['\"]\s*(?:,|\])`);
    const NEEDLE = /(?:cloud\/)|(?:['"`]cloud['"`])/g;
    NEEDLE.lastIndex = 0;
    for (let m = NEEDLE.exec(src); m; m = NEEDLE.exec(src)) {
      const idx = m.index;
      if (!m[0].includes('/')) {
        // Pattern 2: look back a stretch; if there is no trace of path concatenation, it does not count
        const stmt = src.slice(Math.max(0, idx - 120), idx);
        // Category 3: bare array elements (`["..", "..", "cloud", "online", "manifest.ts"]`). Immediately
        // adjacent to `[` / `,` / `]` with only whitespace allowed in between, so **values** like
        // `realm: "cloud"` will not match.
        // Verified on a clean tree on 2026-10-27: zero false positives for category 3, while the original
        // line in boot.ts is caught.
        // The window must be wide enough: once an array wraps across lines (`[`-newline-indent-`".."`-comma-
        // newline-indent-`"cloud"`), the preceding comma becomes far away. ±2 characters only recognizes
        // items written on a single line, and the bug in B1 split across multiple lines by a formatter was
        // shaped exactly like this: an escape hatch pointed out in the 2026-10-28 review.
        const elem = src.slice(Math.max(0, idx - 48), idx + m[0].length + 48);
        const asArrayElement = ARRAY_ELEMENT.test(elem);
        if (!asArrayElement && !/path\.(join|resolve)\s*\(|import\s*\(|fileURLToPath|new URL\s*\(/.test(stmt)) continue;
      }
      if (inComment(comments, idx)) continue;
      // `src/ai/cloud/` is a closed-source directory **inside the source tree**, not `cloud/` under the
      // private root. It is managed by the G3 ratchet (which will gradually reach zero as seams are
      // decoupled) and is not within the scope of this gate.
      const before = src.slice(Math.max(0, idx - 8), idx);
      if (before.endsWith('ai/') || before.endsWith('/ai/')) continue;
      const line = src.slice(0, idx).split('\n').length;
      offenders.push(`${rel}:${line}  ${src.split('\n')[line - 1].trim().slice(0, 120)}`);
      break; // Reporting once per file is enough; no need to flood the screen
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These public files touch cloud/ in code (not in comments).
` +
      `The public repository has no cloud/, so these lines would point to nonexistent files in the community edition.
` +
      `Use the seam instead: hand the cloud part to the loader table (see server/docservice/extensions.mjs for a template).
` +
      `If it really is a new extension entry, add it to LOADER_WHITELIST in server/test/community-ownership.mjs,
` +
      `and state the rationale in docs/plan/community-boundary.md.

` +
      offenders.join('\n'),
  );
});

test('G2 extension entries may only look for the loader table under the cloud directory variable', () => {
  for (const rel of LOADER_WHITELIST) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `Extension entry in the whitelist does not exist: ${rel} (the whitelist should be updated accordingly)`);
    const src = fs.readFileSync(file, 'utf8');

    // Whole-word matching is intentional: substring matching does not prevent renaming, as
    // `PROMPTCUT_CLOUD_DIR_OLD` also contains this substring.
    // Character classes are used instead of regex word-boundary escapes: the tool that writes this
    // file on this machine eats that escape into a backspace character, hit three times.
    // Both forms count: directly `process.env.PROMPTCUT_CLOUD_DIR`, or storing the name as a constant
    // and then `process.env[KEY]` (work item A in `src/ai/extensionsLoad.mjs` is the latter). Quotes
    // enclose the name, so the latter is also a whole-word match, and `'PROMPTCUT_CLOUD_DIR_OLD'` will
    // not be counted as a hit. Neither location uses regex word-boundary escapes: the tool that writes
    // this file on this machine eats that escape into a backspace character, hit three times.
    const namedAsLiteral =
      src.includes("'PROMPTCUT_CLOUD_DIR'") || src.includes('"PROMPTCUT_CLOUD_DIR"');
    const readsEnvByIndex = src.includes('process.env?.[') || src.includes('process.env[');
    assert.ok(
      /env[.]PROMPTCUT_CLOUD_DIR[^A-Za-z0-9_]/.test(src) || (namedAsLiteral && readsEnvByIndex),
      `${rel} does not read PROMPTCUT_CLOUD_DIR. In the submodule layout the cloud directory is not the cloud/ at the repository root,` +
        `The entry must honor this environment variable, otherwise not a single extension can be attached on the private repository side (and silently so).`,
    );

    // Every 'cloud/...' literal appearing in entry points must be the "default location" one;
    // hardcoding other relative paths is not allowed
    const comments = commentRanges(src);
    for (let idx = src.indexOf('..'); idx !== -1; idx = src.indexOf('..', idx + 1)) {
      if (inComment(comments, idx)) continue;
      const line = src.slice(0, idx).split('\n').length;
      const text = src.split('\n')[line - 1];
      // Allow patterns like `'../..'` that "navigate from this file to the repository root"; jumping up
      // again after the cloud directory is not allowed
      assert.ok(
        // Two dots must immediately follow a quote to count as "escaping the cloud directory": it must be
        // `".."` inside a string.
        // Without this restriction, spread operators trigger false positives: `...` in
        // `path.join(cloudDirOf(), ...sub)` also contains two dots (encountered on 2026-10-27 when
        // registering the browser-side alias plugin in the whitelist).
        !/cloud[^'"]*['"]\.\./.test(text),
        `${rel}:${line} goes up one more level after the cloud directory and would escape it: ${text.trim()}`,
      );
    }

    // When the table is not found, it must return empty and must not throw: the community edition is
    // the case where it is not found. Here we only check whether this intent is present; the actual
    // behavior is pinned by EXT3 in server/test/docservice-extensions.test.mjs.
    assert.ok(
      /existsSync|try\s*\{/.test(src),
      `${rel} neither checks whether the file exists nor uses try: the community edition has no cloud/, so this throws right away.`,
    );
  }
});

test('G3 ratchet: the number of product files on the public side that still import closed-source code may only go down, never up', () => {
  const offenders = [];
  for (const rel of sharedProductionFiles()) {
    const cloudHits = importsOf(ROOT, rel).filter(isCloud);
    if (cloudHits.length) offenders.push(`${rel} → ${cloudHits.join(', ')}`);
  }

  assert.ok(
    offenders.length <= SEAM_CEILING,
    `${offenders.length} product files on the public side still import closed-source code, over the ceiling of ${SEAM_CEILING}.\n` +
      `New code must not reference closed-source directories on the public side (${CLOUD_DIRS.join(', ')}).\n` +
      `After finishing a piece of work, lower SEAM_CEILING: this number is a ratchet that only goes down.

` +
      offenders.slice(0, 20).join('\n') +
      (offenders.length > 20 ? `\n… (${offenders.length - 20} more, for the full list run node scripts/dev/community-seams.mjs . --md)` : ''),
  );

  // Warn to lower the upper bound if it drops too much; otherwise the ratchet will loosen.
  //
  // The lower bound is set generously (20) because **every seam work item legitimately lowers this
  // number before being merged**, while the upper bound is written in this shared file and changed
  // only by the integrator upon merging. Setting the lower bound too strictly (originally 4) would
  // make every branch currently decoupling seams turn red on G3, even though they are precisely the
  // branches doing things right: that kind of failure only teaches people to ignore this test. Capped
  // at 20, improvements in a single work item will not trigger false positives, while "finished
  // decoupling but forgot to tighten the upper bound" will still turn red.
  assert.ok(
    offenders.length >= SEAM_CEILING - 20,
    `Only ${offenders.length} seams remain, more than 20 below the ceiling of ${SEAM_CEILING}.\n` +
      `Change SEAM_CEILING in this file to ${offenders.length}, otherwise the ratchet stays loose,` +
      `and it will not go red if someone adds a batch back later.`,
  );
});

test('G4 every cloud loader table must be loadable with a synchronous require', () => {
  // Why this check is needed: loading points have two patterns, and one has hard requirements for
  // the loading table.
  //
  // `server/docservice/extensions.mjs` uses top-level `await import()`. The dependency graph there is
  // acyclic, so it holds. But when `server/agent/service/extensions.mjs` copied this shape, it caused
  // **a total deadlock** (measured 220 failures on 2026-10-27, two test files killed by the watchdog),
  // because the dependency graph on the Agent side is cyclic:
  //
  //   extensions.mjs (top-level await not settled)
  //     → cloud/agent/manifest.mjs → cloud/agent/account-runner.mjs
  //     → server/agent/service/conversation-policy.mjs → create-agent-service.mjs
  //     → back to extensions.mjs
  //
  // Therefore, that loading point was changed to "synchronous lazy loading via
  // `createRequire(...)(table)` on first call", with zero waiting during the module evaluation phase.
  // The trade-off: **synchronously requiring a .mjs file requires that neither it nor its static
  // dependency graph contains any top-level await**, otherwise it throws `ERR_REQUIRE_ASYNC_MODULE`:
  // an explosion that would only be triggered by some future unrelated change.
  //
  // This gate pins this requirement onto all loading tables (not just the loading point using
  // createRequire), so that the two patterns can be swapped at any time, and no one will discover
  // the breakage only after adding a top-level await deep in a table's dependency graph.
  const manifests = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // The community edition does not have cloud/, so this is naturally empty
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^manifest\.(mjs|js|cjs|ts)$/.test(e.name)) manifests.push(full);
    }
    // Respect PROMPTCUT_CLOUD_DIR: under submodule layout, the cloud directory is not under the public
    // repository root; hardcoding ROOT/cloud would make this gate **always empty and always green**:
    // yet its entire reason for existence is to prevent top-level await deadlocks on the Agent side.
  })(process.env.PROMPTCUT_CLOUD_DIR ? path.resolve(process.env.PROMPTCUT_CLOUD_DIR) : path.join(ROOT, 'cloud'));

  const require_ = createRequire(path.join(ROOT, 'g4-probe.js'));
  const broken = [];
  for (const file of manifests) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel.endsWith('.ts')) continue; // Tables on the browser side use aliases and are bundled by the build, without going through require
    try {
      const mod = require_(file);
      const table = mod?.default ?? mod?.manifest;
      if (table === undefined) broken.push(`${rel}: required successfully, but it has neither a default nor a manifest export`);
    } catch (e) {
      broken.push(`${rel}: ${e.code === 'ERR_REQUIRE_ASYNC_MODULE' ? 'ERR_REQUIRE_ASYNC_MODULE: it or its static dependency graph has a top-level await' : e.code || e.message}`);
    }
  }

  assert.deepEqual(
    broken,
    [],
    `These cloud loader tables cannot be loaded with a synchronous require:
` +
      `Loader points that use createRequire (such as server/agent/service/extensions.mjs) will throw directly.
` +
      `Move the top-level await into a function, or change that loader point back to a top-level await import (only if that part of the dependency graph has no cycles).

` +
      broken.join('\n'),
  );
});

test('G5 every entry in the ownership table and the whitelist must really exist', () => {
  // Dead entries do not throw errors; the downside is that **if someone creates a new public file at
  // that path in the future, it will be silently classified as closed source by the ownership table
  // and exempted by G1/G3**. The 2026-10-28 review found four entries in CLOUD_FILES pointing to
  // `src/online/`, when those four files had long been moved into `cloud/online/`.
  //
  // Entries under the cloud directory do not exist in the community edition in the first place, so
  // those are skipped (it is correct that the public repository does not have cloud/).
  const cloudDir = process.env.PROMPTCUT_CLOUD_DIR
    ? path.resolve(process.env.PROMPTCUT_CLOUD_DIR)
    : path.join(ROOT, 'cloud');
  const hasCloud = fs.existsSync(cloudDir);

  const dead = [];
  for (const [name, list] of [
    ['CLOUD_FILES', CLOUD_FILES],
    ['LOADER_WHITELIST', LOADER_WHITELIST],
    ['BOUNDARY_TOOLING', BOUNDARY_TOOLING],
    // LAN_FILES / LAN_DIRS were not originally in this loop: pointed out on 2026-10-28 when another
    // session checked boundaries. The LAN category will likewise leave dead entries when moving in the
    // future, and CLOUD_FILES had just suffered from eight dead entries.
    ['LAN_FILES', LAN_FILES],
    ['LAN_DIRS', LAN_DIRS],
  ]) {
    for (const rel of list) {
      if (rel.startsWith('cloud/') && !hasCloud) continue;
      if (!fs.existsSync(path.join(ROOT, rel))) dead.push(name + ' entry ' + rel);
    }
  }
  assert.deepEqual(
    dead,
    [],
    'These entries point to nonexistent files (if a file was moved, update the entry, otherwise a new file with the same name would be silently exempted):' +
      String.fromCharCode(10) + dead.join(String.fromCharCode(10)),
  );
});

test('G6 the public tree must not contain our own online addresses', () => {
  // 2026-10-30: The hosted address was written in server/auth/hosted-default.mjs; since the file was
  // classified as public, the address was also exposed, and the community edition actually tried to
  // connect to it. Addresses may only be written in the closed-source product declaration
  // (server/auth/product.mjs). This scans all text files included when exporting the community
  // edition, including tests, probes, and documentation: decommissioned addresses cannot even be used
  // as samples; samples should use example domains and documentation-reserved subnets (203.0.113.0/24).
  const closed = path.join(process.env.PROMPTCUT_CLOUD_DIR ? path.resolve(process.env.PROMPTCUT_CLOUD_DIR) : path.join(ROOT, 'cloud'), 'product.config.json');
  const needles = [/visuhive\.com/i];
  if (fs.existsSync(closed)) {
    const { hosted } = JSON.parse(fs.readFileSync(closed, 'utf8'));
    for (const ip of hosted.retiredIps) {
      needles.push(new RegExp(ip.split('.').join('[.-]')));
    }
  }
  const hits = [];
  for (const rel of listPublicFiles(ROOT)) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    if (needles.some((re) => re.test(text))) hits.push(rel);
  }
  assert.deepEqual(hits, [], 'These public files contain online addresses:' + String.fromCharCode(10) + hits.join(String.fromCharCode(10)));
});

test('G7 public probes must not use anything under cloud/ (mentions in comments do not count)', () => {
  // 2026-10-31: G1 only covers product files, probes are not included; when closed-source paths are
  // written as strings (spawn, fork, path concatenation), G3's import graph cannot see them either.
  // Probes that only test closed-source features go in cloud/scripts/probes/, and mobile probes
  // connect to scripts/probes/lib/probe-services.mjs.
  const NEEDLE = /(?:cloud\/(?:server|scripts|src)\/)|(?:['"`]cloud['"`]\s*,\s*['"`](?:server|scripts|src)['"`])/g;
  const hits = [];
  for (const rel of listPublicFiles(ROOT)) {
    if (!rel.startsWith('scripts/probes/') || !/\.(?:mjs|cjs|js|ts)$/.test(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const comments = commentRanges(src);
    for (const m of src.matchAll(NEEDLE)) {
      if (!inComment(comments, m.index)) hits.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], 'These public probes use closed-source things:' + String.fromCharCode(10) + hits.join(String.fromCharCode(10)));
});
