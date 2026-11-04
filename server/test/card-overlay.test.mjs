/**
 * User cards and overlay layer (two leftovers before M8, report
 * `docs/archive/agent-reports/AGENT-card-overlay.md`).
 *
 *   CO1  create_card with overwrite: when the overlay layer contains an older version of this card,
 *        new content must take effect (previously written to base, obscured by old overlay version).
 *   CO2  Host does not write to checkout directory when overlay layer exists: user cards not
 *        originally on this machine (content store sync, open .proc, create_card) are all written
 *        to overlay layer; `src/cards/user/` in checkout does not gain extra files; finding cards
 *        by id, source closure, and code identity all recognize user cards in overlay layer.
 *   CO3  Without overlay layer (development phase), writes to checkout directory as usual.
 *
 * Overlay layer is determined solely by environment variables (`overridesRoot` in `card-overrides.mjs`
 * is re-read each time), set temporarily per test case.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.PROMPTCUT_CARD_OVERRIDES;
delete process.env.PROMPTCUT_DATA_DIR;

const cards = await import('../vite-plugin-cards.ts');
const { readEffective } = await import('../card-overrides.mjs');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

function withOverlay(dir, fn) {
  const before = process.env.PROMPTCUT_CARD_OVERRIDES;
  if (dir) process.env.PROMPTCUT_CARD_OVERRIDES = dir; else delete process.env.PROMPTCUT_CARD_OVERRIDES;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.PROMPTCUT_CARD_OVERRIDES; else process.env.PROMPTCUT_CARD_OVERRIDES = before;
  }
}

const cardSource = (text, extra = '') => `import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
${extra}interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <motion.div animate={{ opacity: 1 }}>{params.text}</motion.div>;
}
export const priceTag: CardDef<Params> = {
  id: "price-tag", name: "Price", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "${text}" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
`;
const USER_KEY = 'src/cards/user/price-tag.tsx';

/** A minimal checkout: core files, user card loading entrypoint */
function checkout(prefix, extra = {}) {
  const root = tmp(prefix);
  put(root, 'src/kernel/types.ts', 'export type CardDef<T> = any;\nexport type CardProps<T> = any;\n');
  put(root, 'src/cards/user/index.ts', 'export const userCards = [];\n');
  for (const [rel, text] of Object.entries(extra)) put(root, rel, text);
  return root;
}
const userDirFiles = (root) => fs.readdirSync(path.join(root, 'src', 'cards', 'user')).sort();

/* ================================================================== CO1 */

test('CO1 create_card with overwrite: when the overlay layer has an old version, the new content takes effect and the base copy is untouched', () => {
  const root = checkout('pc-co1-', { [USER_KEY]: cardSource('v1') });
  const overlay = tmp('pc-co1-overlay-');
  put(overlay, USER_KEY, cardSource('v1-edited'));
  withOverlay(overlay, () => {
    assert.match(readEffective(root, path.join(root, USER_KEY)), /v1-edited/, 'precondition: the copy in the overlay layer is the effective one');
    const r = cards.createUserCard({ root, id: 'price-tag', source: cardSource('v2'), existingIds: [], overwrite: true });
    assert.equal(r.ok, true, JSON.stringify(r.ok ? {} : r.body));
    assert.equal(r.already, true);
    assert.match(readEffective(root, path.join(root, USER_KEY)), /"v2"/, 'after the overwrite the new content is the effective one');
    assert.equal(r.written, path.join(overlay, USER_KEY), 'written into the overlay layer');
    assert.equal(fs.readFileSync(path.join(root, USER_KEY), 'utf8'), cardSource('v1'), 'the base copy is untouched');
  });
});

test('CO1b create_card without overwrite: a card present in the overlay layer (absent from the base copy) also counts as existing, 409', () => {
  const root = checkout('pc-co1b-');
  const overlay = tmp('pc-co1b-overlay-');
  put(overlay, USER_KEY, cardSource('v1'));
  withOverlay(overlay, () => {
    const r = cards.createUserCard({ root, id: 'price-tag', source: cardSource('v2'), existingIds: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 409);
    assert.match(readEffective(root, path.join(root, USER_KEY)), /"v1"/);
  });
});

/* ================================================================== CO2 */

test('CO2 with an overlay layer, a user card that did not exist on this machine is written into the overlay layer and the checkout directory gains no extra file (content store sync, opening .proc, create_card)', () => {
  const root = checkout('pc-co2-');
  const overlay = tmp('pc-co2-overlay-');
  const history = tmp('pc-co2-history-');
  const before = userDirFiles(root);
  withOverlay(overlay, () => {
    // Content store sync (standalone render host and editor both take this path)
    const synced = cards.installSyncedFile({ root, historyDir: history, rel: USER_KEY, source: cardSource('v1') });
    assert.equal(synced.ok, true, synced.error);
    assert.equal(synced.status, 'written');
    assert.equal(synced.written, path.join(overlay, USER_KEY));
    assert.equal(fs.readFileSync(path.join(overlay, USER_KEY), 'utf8'), cardSource('v1'));
    // Load the same copy again: compare by effective content, untouched
    assert.equal(cards.installSyncedFile({ root, historyDir: history, rel: USER_KEY, source: cardSource('v1') }).status, 'unchanged');
    // Files used by user cards (not on this machine) also only go into overlay layer
    const dep = cards.installSyncedFile({ root, historyDir: history, rel: 'src/cards/user/price-tag-util.ts', source: 'export const k = 1;\n' });
    assert.equal(dep.ok, true, dep.error);
    assert.equal(fs.existsSync(path.join(overlay, 'src/cards/user/price-tag-util.ts')), true);

    // Open .proc
    const [bundled] = cards.installBundledCards({ root, historyDir: history, cards: [{ id: 'coupon', source: cardSource('c1').replace('"price-tag"', '"coupon"') }], existingIds: [] });
    assert.equal(bundled.status, 'written', bundled.error);
    assert.equal(fs.existsSync(path.join(overlay, 'src/cards/user/coupon.tsx')), true);

    // create_card
    const created = cards.createUserCard({ root, id: 'ticket', source: cardSource('t1').replace('"price-tag"', '"ticket"'), existingIds: [] });
    assert.equal(created.ok, true, JSON.stringify(created.ok ? {} : created.body));
    assert.equal(created.written, path.join(overlay, 'src/cards/user/ticket.tsx'));
  });
  assert.deepEqual(userDirFiles(root), before, 'the user card directory in the checkout has no extra file at all');
});

test('CO2b a user card in the overlay layer (absent from the base copy): can be found by id, its source closure includes the overlay layer files it uses, and its code identity is a custom card', () => {
  const root = checkout('pc-co2b-');
  const overlay = tmp('pc-co2b-overlay-');
  put(overlay, USER_KEY, cardSource('v1', 'import { k } from "./price-tag-util";\n'));
  put(overlay, 'src/cards/user/price-tag-util.ts', 'export const k = 1;\n');
  withOverlay(overlay, () => {
    assert.equal(cards.findCardFile(root, 'price-tag'), USER_KEY);
    assert.deepEqual(cards.importClosure(root, USER_KEY), [USER_KEY, 'src/cards/user/price-tag-util.ts']);
    const id1 = cards.cardCodeIdentity(root, 'price-tag');
    assert.ok(id1, 'the definition can be found');
    assert.equal(id1.custom, true);
    // Computes same identity as "same source placed in checkout": between two nodes, one installed
    // in checkout and one in overlay layer, still recognized as same code
    const other = checkout('pc-co2b-other-', { [USER_KEY]: cardSource('v1', 'import { k } from "./price-tag-util";\n'), 'src/cards/user/price-tag-util.ts': 'export const k = 1;\n' });
    const id2 = withOverlay(null, () => cards.cardCodeIdentity(other, 'price-tag'));
    assert.equal(id1.version, id2.version);
  });
  assert.equal(withOverlay(null, () => cards.findCardFile(root, 'price-tag')), null, 'without the overlay layer it is invisible');
});

/* ================================================================== CO3 */

test('CO3 no overlay layer (development phase): create_card and content store sync write to the checkout directory as before', () => {
  const root = checkout('pc-co3-');
  const history = tmp('pc-co3-history-');
  withOverlay(null, () => {
    const r = cards.createUserCard({ root, id: 'price-tag', source: cardSource('v1'), existingIds: [] });
    assert.equal(r.ok, true);
    assert.equal(r.written, path.join(root, USER_KEY));
    const again = cards.createUserCard({ root, id: 'price-tag', source: cardSource('v2'), existingIds: [], overwrite: true });
    assert.equal(again.ok, true);
    assert.match(fs.readFileSync(path.join(root, USER_KEY), 'utf8'), /"v2"/);
    const synced = cards.installSyncedFile({ root, historyDir: history, rel: 'src/cards/user/coupon.tsx', source: cardSource('c1').replace('"price-tag"', '"coupon"') });
    assert.equal(synced.status, 'written', synced.error);
    assert.equal(fs.existsSync(path.join(root, 'src/cards/user/coupon.tsx')), true);
  });
});

/* ================================================================== CO4 */

test('CO4 the user card loading entry can see cards in the overlay layer: the manifest module lists files absent from the base copy, and resolution maps them to the corresponding paths in the repo', () => {
  const root = checkout('pc-co4-', { 'src/cards/user/in-base.tsx': cardSource('b') });
  const overlay = tmp('pc-co4-overlay-');
  put(overlay, USER_KEY, cardSource('v1', 'import { k } from "./lib/util";\n'));
  put(overlay, 'src/cards/user/lib/util.ts', 'export const k = 1;\n');
  put(overlay, 'src/cards/user/in-base.tsx', cardSource('b-edited'));
  put(overlay, 'src/cards/user/_scopes.json', '{}');
  const posix = (p) => p.split(path.sep).join('/');

  // Without overlay layer: manifest is empty (src/cards/userOverlay.ts on disk), resolution left
  // entirely to Vite
  withOverlay(null, () => {
    assert.match(cards.userOverlayModuleCode(root), /export const overlayModules = \{  \};/);
    assert.equal(cards.resolveOverlayOnly(root, '/src/cards/user/price-tag.tsx'), null);
  });

  withOverlay(overlay, () => {
    const code = cards.userOverlayModuleCode(root);
    // What exists in base (in-base) is not listed: glob collects it, load hook yields the overlay
    // layer copy; ownership table is not source code, not listed
    assert.doesNotMatch(code, /in-base|_scopes/);
    assert.match(code, /import \* as m\d+ from "\/src\/cards\/user\/price-tag\.tsx";/);
    assert.match(code, /import r\d+ from "\/src\/cards\/user\/price-tag\.tsx\?raw";/);
    assert.match(code, /import r\d+ from "\/src\/cards\/user\/lib\/util\.ts\?raw";/);
    assert.doesNotMatch(code, /import \* as m\d+ from "\/src\/cards\/user\/lib/, 'files in subdirectories are referenced implementations and are not collected as cards');
    assert.match(code, /overlayModules = \{ "\.\/price-tag\.tsx": m\d+ \}/);
    assert.match(code, /overlayDependencyRaws = \{ "\.\/lib\/util\.ts": r\d+, "\.\/price-tag\.tsx": r\d+ \}/);

    const card = posix(path.join(root, USER_KEY));
    assert.equal(cards.resolveOverlayOnly(root, '/src/cards/user/price-tag.tsx'), card, 'root-relative');
    assert.equal(cards.resolveOverlayOnly(root, '/src/cards/user/price-tag.tsx?raw'), `${card}?raw`, 'the query string is carried over as is');
    assert.equal(cards.resolveOverlayOnly(root, './lib/util', card), posix(path.join(root, 'src/cards/user/lib/util.ts')), 'relative imports get the extension filled in');
    assert.equal(cards.resolveOverlayOnly(root, card), card, 'absolute path');
    assert.equal(cards.resolveOverlayOnly(root, '/src/cards/user/in-base.tsx'), null, 'files present in the base copy are left to Vite');
    assert.equal(cards.resolveOverlayOnly(root, '/src/cards/user/nope.tsx'), null, 'files absent from both sides are left to Vite (which reports not found as usual)');
    assert.equal(cards.resolveOverlayOnly(root, '../../kernel/types', card), null, 'kernel files do not belong to the overlay layer');
    assert.equal(cards.resolveOverlayOnly(root, 'motion/react', card), null, 'package names are left to Vite');
  });
});
