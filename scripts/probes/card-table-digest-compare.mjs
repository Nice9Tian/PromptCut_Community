/**
 * Card identity digest comparison before and after changes (hard constraint of render refactor
 * "Ding": keys of prerender output for other built-in cards must not change due to added fields
 * in the review table, except for backfilled cards).
 *
 * What it does: for all built-in cards (the four groups registered in `src/cards/index.ts`:
 * magicui, native, media wrapper cards, probe cards), calculate once each on the base commit
 * and current checkout, comparing card by card. Place each card into a clip containing only
 * itself (default parameters, 30 fps, 2 seconds, 1920×1080), running through the same functions
 * as production: `projectCardGraph` graph flattening → capability table on nodes →
 * `cardNodeIdentities` (node identities), `cardSnapshotIdentity` (content key of shared
 * snapshot key), `cardCostKey` (cost key). Source version is calculated by `cardSourceVersion`
 * from the card's own import closure, and code fingerprint for generating snapshots uses
 * `snapshotCode`.
 *
 * Compare each card across four columns:
 *   Capability table   Node `capabilities` (review table content enters keys through it)
 *   Source version     Full text of card's import closure (changes if any file in closure changes a byte)
 *   Keys               Node identities, snapshot content key, cost key (real keys, containing both above)
 *   Keys (fixed src)   Keys recalculated after setting source version to a constant: checks only whether
 *                      the "capability table and nodes" path changed
 *
 * Usage (at repository or workspace root):
 *   node scripts/probes/card-table-digest-compare.mjs [--base main] [--expect id1,id2,…] [--json out.json]
 *
 *   --base       Base commit, defaults to main. Uses `git archive` to unpack its src/ and server/
 *                under out/card-table-digest/<commit>/ (out/ is not stored), without touching any
 *                workspace or branch.
 *   --expect     Card IDs allowed to change (comma-separated). Defaults to four cards backfilled in "Ding".
 *   --json       Write results from both sides card-by-card to JSON.
 *   --caps-only  Only verify the "capability table and nodes" path: none of the capability table,
 *                registry definitions, or keys (fixed src) columns may change for any card (except
 *                those in --expect), ignoring whether source version and real keys change. Used for
 *                changes intended to alter source version (e.g. modifying `src/kernel/frameMode.mjs`).
 *
 * Exit code: 0 = only cards in --expect changed (keys and capability table), and they indeed all
 * changed; 1 = other cards changed, or expected ones did not change; 2 = failed to run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBuiltinCards } from '../../src/testing/loadBuiltinCards.mjs';

const HERE = path.resolve(fileURLToPath(import.meta.url), '../../..');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const BASE = arg('--base', 'main');
const EXPECT = new Set(arg('--expect', 'av-pulse,sound-notification,sound-keyboard,probe-slow').split(',').filter(Boolean));
const JSON_OUT = arg('--json', null);
const CAPS_ONLY = args.includes('--caps-only');

const git = (...a) => execFileSync('git', a, { cwd: HERE, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

/** Unpack src/ and server/ of base commit under out/; dependencies resolve upward to repository node_modules */
function checkoutBase(ref) {
  const sha = git('rev-parse', ref);
  const dir = path.join(HERE, 'out', 'card-table-digest', sha.slice(0, 12));
  if (fs.existsSync(path.join(dir, '.done'))) return { sha, dir };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(dir, 'base.tar');
  execFileSync('git', ['archive', '--format=tar', '-o', tar, sha, 'src', 'server'], { cwd: HERE, windowsHide: true });
  // Relative path + cwd: GNU tar shipped with Git Bash treats `C:` as a remote hostname
  execFileSync('tar', ['-xf', 'base.tar'], { cwd: dir, windowsHide: true });
  fs.rmSync(tar);
  fs.writeFileSync(path.join(dir, '.done'), sha);
  return { sha, dir };
}

const FPS = 30, SECONDS = 2, STAGE = { width: 1920, height: 1080 };

async function compute(root) {
  // Loader uses current workspace copy (base commit may not have it yet), loading cards under root
  const kit = await loadBuiltinCards(root);
  try {
    const { load } = kit;
    const registry = await load('/src/kernel/registry.ts');
    const { projectCardGraph } = await load('/src/kernel/cardGraph.mjs');
    const { cardSourceVersion } = await load('/src/render/cardSourceVersion.mjs');
    const { builtinCardSourceFiles } = await load('/src/render/cardSourceFiles.mjs');
    const { cardCostKey } = await load('/src/render/cardCostKey.mjs');
    const at = file => import(pathToFileURL(path.join(root, file)).href);
    const { cardNodeIdentities, cardSnapshotIdentity, cardSampling } = await at('server/card-identity.mjs');
    const { snapshotCode } = await at('server/frame-code.mjs');
    const { digest } = await at('server/frame-identity.mjs');

    const groups = kit.groups;
    registry.resetCards();
    registry.registerCards(Object.values(groups).flat());
    const code = snapshotCode(root);
    const out = {};
    for (const [group, cards] of Object.entries(groups)) for (const raw of cards) {
      const id = raw.id, def = registry.getCard(id);
      const project = { ...STAGE, fps: FPS, tracks: [{ id: 't1', clips: [{ id: 'c1', cardId: id, start: 0, end: SECONDS, params: {} }] }], media: [], cardNodes: [] };
      const graph = projectCardGraph(project, registry.getCard);
      const output = graph.outputs[0];
      const node = graph.nodes.find(n => n.id === output.nodeId);
      const sourceText = cardSourceVersion(def, builtinCardSourceFiles);
      const keys = sourceVersion => {
        const sourceVersions = { [id]: sourceVersion };
        return {
          node: cardNodeIdentities(graph, { sourceVersions }).get(output.nodeId),
          snapshot: cardSnapshotIdentity(node, { sourceVersions, fps: FPS, sampling: cardSampling(0, FPS), duration: SECONDS, stage: STAGE, snapshotCode: code }),
          cost: cardCostKey(node, sourceVersion, FPS, FPS * SECONDS),
        };
      };
      out[id] = { group, declared: raw.frameMode ?? null, adapter: node.adapter, capabilities: node.capabilities,
        registered: { need_prerendering: def.need_prerendering, compositing: def.compositing, canvasHeavy: def.canvasHeavy },
        sourceVersion: digest(sourceText), keys: keys(sourceText), keysFixedSource: keys('fixed') };
    }
    return { snapshotCode: code, cards: out };
  } finally { await kit.close(); }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const base = checkoutBase(BASE);
  const head = { sha: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'src', 'server') !== '' };
  const before = await compute(base.dir), after = await compute(HERE);
  const ids = [...new Set([...Object.keys(before.cards), ...Object.keys(after.cards)])].sort();
  const rows = [], bad = [];
  let unchanged = 0;
  for (const id of ids) {
    const b = before.cards[id], a = after.cards[id];
    if (!b || !a) { rows.push({ id, note: b ? 'Card absent after the change' : 'Card absent before the change' }); bad.push(id); continue; }
    const diff = { capabilities: !same(b.capabilities, a.capabilities), registered: !same(b.registered, a.registered), sourceVersion: b.sourceVersion !== a.sourceVersion,
      keys: !same(b.keys, a.keys), keysFixedSource: !same(b.keysFixedSource, a.keysFixedSource) };
    const changed = diff.capabilities || diff.registered || diff.keys || diff.keysFixedSource || diff.sourceVersion;
    if (!changed) { unchanged++; continue; }
    rows.push({ id, group: a.group, ...diff, before: b, after: a });
    if (!EXPECT.has(id) && (!CAPS_ONLY || diff.capabilities || diff.registered || diff.keysFixedSource)) bad.push(id);
  }
  const missed = [...EXPECT].filter(id => !rows.some(r => r.id === id && (r.keys || r.capabilities)));

  console.log(`Baseline ${BASE} = ${base.sha.slice(0, 12)}; current HEAD = ${head.sha.slice(0, 12)}${head.dirty ? '(uncommitted changes in src/ or server/, computed from the working tree)' : ''}`);
  console.log(`Code fingerprint for generating snapshots: before ${before.snapshotCode}, after ${after.snapshotCode} ${before.snapshotCode === after.snapshotCode ? '(same)' : '(different!)'}`);
  console.log(`Built-in cards: ${Object.keys(before.cards).length} before the change, ${Object.keys(after.cards).length} after; ${unchanged} identical card by card, ${rows.length} changed`);
  const yn = v => v ? 'changed' : 'same';
  if (CAPS_ONLY) {
    const count = key => rows.filter(r => r[key]).length;
    console.log(`Checking only the capability-table path: capability table changed for ${count('capabilities')} cards / registry definition changed for ${count('registered')} cards / key (fixed source) changed for ${count('keysFixedSource')} cards / source version changed for ${count('sourceVersion')} cards / key changed for ${count('keys')} cards`);
    console.log(`Cards with a changed source version: ${rows.filter(r => r.sourceVersion).map(r => r.id).join(', ') || '(none)'}`);
  }
  for (const r of rows) {
    if (CAPS_ONLY && !r.note && !r.capabilities && !r.registered && !r.keysFixedSource) continue;
    if (r.note) { console.log(`  ${r.id}: ${r.note}`); continue; }
    console.log(`  ${r.id} (${r.group}): capability table ${yn(r.capabilities)} / registry definition ${yn(r.registered)} / source version ${yn(r.sourceVersion)} / key ${yn(r.keys)} / key (fixed source) ${yn(r.keysFixedSource)}`);
    if (r.capabilities) console.log(`      capability table  before ${JSON.stringify(r.before.capabilities)}\n                        after  ${JSON.stringify(r.after.capabilities)}`);
    if (r.keys) for (const k of ['node', 'snapshot', 'cost']) console.log(`      ${k.padEnd(8)} before ${String(r.before.keys[k]).slice(0, 16)}  after ${String(r.after.keys[k]).slice(0, 16)}`);
  }
  if (JSON_OUT) { fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true }); fs.writeFileSync(JSON_OUT, JSON.stringify({ base: base.sha, head, before, after }, null, 1)); }
  if (bad.length) console.log(`✖ ${bad.length} cards not listed in --expect changed: ${bad.slice(0, 20).join(', ')}${bad.length > 20 ? ' …' : ''}`);
  if (missed.length) console.log(`✖ Cards listed in --expect that did not change: ${missed.join(', ')}`);
  if (CAPS_ONLY && !bad.length && !missed.length) console.log(`✔ Capability table, registry definition and key (fixed source), all three columns: nothing changed except the ${EXPECT.size} cards in --expect`);
  else if (!bad.length && !missed.length) console.log(`✔ Only the ${EXPECT.size} cards in --expect changed; for the other ${unchanged} cards the capability table, source version and three keys are identical card by card`);
  return bad.length || missed.length ? 1 : 0;
}

// Card modules leave timers behind after loading (playback library, particle library); process cannot
// terminate cleanly without an explicit exit
main().then(code => process.exit(code), error => { console.error(error); process.exit(2); });
