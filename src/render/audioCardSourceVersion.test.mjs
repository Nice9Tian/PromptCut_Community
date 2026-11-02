/**
 * Gatekeeper test: pin source versions of three built-in audio cards (av-pulse, sound-notification,
 * sound-keyboard) and the file manifests of their source import closures.
 * Run: node --test src/render/audioCardSourceVersion.test.mjs
 *
 * Why pin: the source version (`cardSourceVersion` in `src/render/cardSourceVersion.mjs`: the card's
 * source file plus the full text of files imported relatively all the way) enters the card audio
 * identity (`cardAudioIdentity` in `src/kernel/cardAudioRendition.mjs`). If any file in the closure
 * changes by even one character (even just adding a comment), previously generated card audio is
 * flagged as "Expired, please regenerate" (`resolveCardAudioRendition`). The user never consented to this.
 * Source: docs/plan/prerender-products-contract.md Section 9.2.
 *
 * Pin three things:
 *   1. Source version of each card (uses the same function and source table in product code,
 *      see `src/render/cardSourceFiles.mjs`);
 *   2. File manifest of each card's closure (cannot grow, cannot swap members: a new file
 *      entering the audio card closure also fails);
 *   3. Full-text hash of each file in closure (only used to clarify which file changed when 1 fails).
 *
 * What to do when it turns red: this is not an ordinary test failure. Stop first, ask the user,
 * then update the pinned values below.
 *
 * Record of pinned value modifications:
 *   2026-10-13 "clean edition merge" (branch claude/rr-clean): user consented to expire card
 *   audio once (`docs/plan/user-decisions-2026-10-13.md` Section 1 items 14-16). Only a single file
 *   changed: `src/kernel/frameMode.mjs` (implementation only extracts declarations; canvas cards
 *   are derived from review table surface), source versions of the three cards changed accordingly;
 *   closure file manifest did not change.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBuiltinCards } from '../testing/loadBuiltinCards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const WHY = 'This value is part of the card audio identity (cardAudioIdentity). Changing it would make users\' already generated card audio be judged "expired, please regenerate", which the user has not agreed to.'
  + 'Ask the user before changing this value or the files in the closure (source: docs/plan/prerender-products-contract.md, section 9.2).';

/** Pinned values for the three cards. Two sound effect cards share sound-effects.ts as entry point, so versions are identical */
const AUDIO_CARDS = {
  'av-pulse': {
    entry: '/src/cards/native/av-pulse.tsx',
    version: '535ba03a7f19c0270c176c9bdbe84b4e698f8ae9bc2f75a6266431830d996e92',
    closure: [
      '/src/cards/native/av-pulse.tsx', '/src/cards/native/sound-effects.ts', '/src/kernel/cardGpu.ts', '/src/kernel/cardGraph.mjs',
      '/src/kernel/emphasis.ts', '/src/kernel/frameMode.mjs', '/src/kernel/soundEffects.ts', '/src/kernel/types.ts',
      '/src/kernel/typingEvents.ts', '/src/render/cards/gpuExecutor.ts',
    ],
  },
  'sound-notification': {
    entry: '/src/cards/native/sound-effects.ts',
    version: '1a663d9c7b086d16d9988114246eb4e876f375845d2d1f4e248f63b9fb431a81',
    closure: [
      '/src/cards/native/sound-effects.ts', '/src/kernel/cardGpu.ts', '/src/kernel/cardGraph.mjs', '/src/kernel/emphasis.ts',
      '/src/kernel/frameMode.mjs', '/src/kernel/soundEffects.ts', '/src/kernel/types.ts', '/src/kernel/typingEvents.ts',
      '/src/render/cards/gpuExecutor.ts',
    ],
  },
  'sound-keyboard': {
    entry: '/src/cards/native/sound-effects.ts',
    version: '1a663d9c7b086d16d9988114246eb4e876f375845d2d1f4e248f63b9fb431a81',
    closure: [
      '/src/cards/native/sound-effects.ts', '/src/kernel/cardGpu.ts', '/src/kernel/cardGraph.mjs', '/src/kernel/emphasis.ts',
      '/src/kernel/frameMode.mjs', '/src/kernel/soundEffects.ts', '/src/kernel/types.ts', '/src/kernel/typingEvents.ts',
      '/src/render/cards/gpuExecutor.ts',
    ],
  },
};

/** Full-text hash for each file in closure (sha256 after normalizing newlines to LF), only used to indicate which file changed */
const FILE_HASHES = {
  '/src/cards/native/av-pulse.tsx': '4cd748f37edcfa2740e31d11d5c62c760bd75757e9fc93c6e83f63424ac2de71',
  '/src/cards/native/sound-effects.ts': 'd94e49a53de2f3ecd80e80e78b58b5bee836b06c714c8ab3d8f741c7b41a1dcf',
  '/src/kernel/cardGpu.ts': 'e0565a932d84d3609ac30ddede25514864259ae89c528917e4d7e58bf9c32303',
  '/src/kernel/cardGraph.mjs': 'b169185628d1fab39f21535c9b1b09b4b69032cab776b608c740af4979174e61',
  '/src/kernel/emphasis.ts': 'b868ea9adbe15e878b71c4864a7c783cad3e64b6dc4aef7a2702acd1e020506b',
  '/src/kernel/frameMode.mjs': '45b246838e3a3d571e9cdcb2f869d257de0d6c78bbd44b94ccc3cbe392b2da31',
  '/src/kernel/soundEffects.ts': '7724b629e74053993de7002535fe573b786259c8f5afa958df831d793aaba350',
  '/src/kernel/types.ts': 'c78a5db7a8c0df5d12cb52ed5bf4b02280a832de430e761c51d886fbf52f5f94',
  '/src/kernel/typingEvents.ts': '1273354a9e3c3e2ff6c6d58b36c20d27d002aadc68287c268493fefcb07fc774',
  '/src/render/cards/gpuExecutor.ts': '86f1d3a26491efd7397d9ca85fd136ec20a70a6a841c64af1a4ae02f03b3fdbf',
};

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

let kit, cardSourceVersion, normalizeEol, files;

before(async () => {
  kit = await loadBuiltinCards(ROOT);
  ({ cardSourceVersion, normalizeEol } = await kit.load('/src/render/cardSourceVersion.mjs'));
  // The source table used in product code to compute source version
  // (`cardSourceVersion(card, builtinCardSourceFiles)` in `src/cards/index.ts`)
  ({ builtinCardSourceFiles: files } = await kit.load('/src/render/cardSourceFiles.mjs'));
});
after(async () => { await kit?.close(); });

/** Traverse closure from entry point, recording files read (`cardSourceVersion` reads `files[file]` once per file visited; given an entry path it will not scan the whole table) */
function closureOf(card, entry) {
  const visited = [];
  const spy = new Proxy(files, { get(target, key) { if (typeof key === 'string' && key.startsWith('/src/')) visited.push(key); return target[key]; } });
  const version = cardSourceVersion(card, spy, entry);
  return { version, closure: [...new Set(visited)].sort() };
}

for (const [id, pinned] of Object.entries(AUDIO_CARDS)) {
  test(`${id}: source closure has the same files (none added, none swapped)`, () => {
    const card = kit.cards.find((c) => c.id === id);
    assert.ok(card, `${id} not found among built-in cards`);
    const { closure } = closureOf(card, pinned.entry);
    const added = closure.filter((f) => !pinned.closure.includes(f));
    const removed = pinned.closure.filter((f) => !closure.includes(f));
    assert.deepEqual({ added, removed }, { added: [], removed: [] },
      `The source import closure of ${id} changed (${JSON.stringify(added)} added, ${JSON.stringify(removed)} removed). ${WHY}`);
    assert.equal(closure.length, pinned.closure.length, `The closure file count of ${id} changed. ${WHY}`);
  });

  test(`${id}: source version is pinned`, () => {
    const card = kit.cards.find((c) => c.id === id);
    // Production approach: without providing an entry point, find the file declaring it in the source
    // table using the card id. First verify that what was found is the pinned entry point, and that
    // only this single file declares this id
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaring = Object.keys(files).filter((file) => new RegExp(`\\bid\\s*:\\s*['"]${escaped}['"]`).test(files[file]));
    assert.deepEqual(declaring, [pinned.entry], `The files declaring ${id} in the source table are not just the pinned one, or not it. ${WHY}`);
    const version = cardSourceVersion(card, files);
    assert.ok(version.startsWith(`${pinned.entry}\n`), `The source version of ${id} does not start with ${pinned.entry}. ${WHY}`);
    const actual = sha256(version);
    if (actual !== pinned.version) {
      const changed = pinned.closure.filter((f) => Object.hasOwn(files, f) && sha256(normalizeEol(files[f])) !== FILE_HASHES[f]);
      assert.fail(`The source version of ${id} changed (pinned ${pinned.version.slice(0, 16)}, now ${actual.slice(0, 16)}); closure files whose content changed: ${changed.length ? changed.join(', ') : '(none found, a closure member may have changed)'}. ${WHY}`);
    }
  });
}

test('the pinned file hashes cover exactly the union of the three closures', () => {
  const union = [...new Set(Object.values(AUDIO_CARDS).flatMap((c) => c.closure))].sort();
  assert.deepEqual(Object.keys(FILE_HASHES).sort(), union);
});
