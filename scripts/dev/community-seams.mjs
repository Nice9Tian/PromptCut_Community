/*
 * Lists every place where "public side still imports closed source": this is the seam manifest to
 * decouple.
 *
 *   node scripts/dev/community-seams.mjs <repo-root> [--md]
 *
 * Ownership table is in `server/test/community-ownership.mjs` (shared with the gatekeeper test
 * `server/test/community-boundary.test.mjs`; copying to both sides would cause drift). Placed in
 * server/test/ rather than here because repo dependency direction rule is `scripts/ → server/`,
 * and the reverse is forbidden (pinned by `server/test/bakery-deps.test.mjs`). Evaluation rule:
 * public code must not import closed source; closed source can freely import public.
 * Table contents are governed by section 3 of `docs/plan/community-boundary.md`.
 */
import { importsOf, isCloud, isLan, isTest, listCodeFiles } from '../../server/test/community-ownership.mjs';

const ROOT = process.argv[2] ?? '.';
const AS_MD = process.argv.includes('--md');

/** Public file → closed source files it imports */
const seams = new Map();
for (const rel of listCodeFiles(ROOT)) {
  if (isCloud(rel)) continue;
  const hits = importsOf(ROOT, rel).filter(isCloud);
  if (hits.length) seams.set(rel, hits);
}

/*
 * Second dimension: core → lan (the third category (user decision, 2026-10-28), see `LAN_DIRS` in
 * `community-ownership.mjs`).
 *
 * Later a Lite edition will be released (local-only, no LAN), carved out of the community edition
 * without creating a separate repo. The direction rule is isomorphic to the closed source layer:
 * core must not import lan, otherwise Lite cannot be carved out. **No gate is established in this
 * round** (Lite build and checks will be added after decoupling the two repos); this only reports
 * the numbers so things do not quietly deteriorate before work begins.
 *
 * `src/main.tsx` is the one edge deliberately retained (entry registration, see
 * `src/editor/sync/lanBoot.ts`), listed separately so it is not mixed into the todo list.
 */
const LAN_ENTRY = 'src/main.tsx';
const lanSeams = new Map();
for (const rel of listCodeFiles(ROOT)) {
  if (isCloud(rel) || isLan(rel) || isTest(rel)) continue;
  const hits = importsOf(ROOT, rel).filter(isLan);
  if (hits.length) lanSeams.set(rel, hits);
}

const rows = [...seams.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
const prod = rows.filter(([f]) => !isTest(f));
const tests = rows.filter(([f]) => isTest(f));

/** Grouped by "which section this file belongs to" to split into non-colliding tasks */
const AREAS = [
  'src/editor/sync/', 'src/editor/right/', 'src/editor/io/', 'src/editor/left/', 'src/editor/',
  'src/start/', 'src/ai/', 'src/online/', 'src/mobile/', 'src/render/',
  'server/docservice/', 'server/asset-store/', 'server/agent/', 'server/', 'src/', 'scripts/',
];
const areaOf = (f) => AREAS.find((a) => f.startsWith(a)) ?? 'Other';

const byArea = new Map();
for (const [f, hits] of prod) {
  const a = areaOf(f);
  if (!byArea.has(a)) byArea.set(a, []);
  byArea.get(a).push([f, hits]);
}
const areasSorted = [...byArea.entries()].sort((x, y) => y[1].length - x[1].length);

if (AS_MD) {
  console.log(`# Seams to cut (generated on ${new Date().toISOString().slice(0, 10)})\n`);
  console.log(`Files on the public side that still import closed-source files: **${prod.length} product code files**, ${tests.length} tests and probes.\n`);
  console.log('Split by chunk; each chunk can be assigned independently (no collisions):\n');
  for (const [a, list] of areasSorted) {
    console.log(`## ${a} (${list.length})\n`);
    for (const [f, hits] of list) console.log(`- \`${f}\` → ${hits.map((h) => `\`${h}\``).join(', ')}`);
    console.log('');
  }
  console.log('## Tests and probes\n');
  console.log(`${tests.length} in total; they follow their own topics and are not assigned separately.\n`);
} else {
  console.log(`Public side still imports closed source: product code ${prod.length}, tests and probes ${tests.length}`);
  console.log('');
  for (const [a, list] of areasSorted) console.log(`${String(list.length).padStart(4)}  ${a}`);
  console.log('');
  const entry = lanSeams.has(LAN_ENTRY);
  const others = [...lanSeams.keys()].filter((f) => f !== LAN_ENTRY);
  console.log(`core still imports lan: ${others.length} (the ${LAN_ENTRY} entry registration is ${entry ? 'present' : 'gone'}, not counted)`);
  for (const f of others) console.log(`      ${f} → ${lanSeams.get(f).join(', ')}`);
  console.log('      ↑ The Lite edition (local only, no LAN) is to be cut out of the community edition; this dimension may only go down, never up;');
  console.log('        the gate is added in the public repo after the two repos are split (user decision, 2026-10-28).');
}
