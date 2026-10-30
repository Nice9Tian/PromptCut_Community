/**
 * 守门测试:钉住三张内置有声卡(av-pulse、sound-notification、sound-keyboard)的源码版本,
 * 和它们的源码导入闭包里的文件清单。跑:node --test src/render/audioCardSourceVersion.test.mjs
 *
 * 为什么要钉:源码版本(`src/render/cardSourceVersion.mjs` 的 `cardSourceVersion`:卡片源文件加上它一路相对导入
 * 到的文件的全文)进卡片声音的身份(`src/kernel/cardAudioRendition.mjs` 的 `cardAudioIdentity`)。
 * 闭包里任何一个文件改一个字(哪怕只加注释),已生成的卡片声音就被判「已过期,请重新生成」
 * (`resolveCardAudioRendition`)。用户没有同意过这件事。
 * 出处:docs/plan/prerender-products-contract.md 第 9.2 节。
 *
 * 钉三样:
 *   1. 每张卡的源码版本(取的是产品里的同一个函数、同一张源码表,见 `src/render/cardSourceFiles.mjs`);
 *   2. 每张卡闭包里的文件清单(不许变长、不许换成员:新文件进了有声卡的闭包也红);
 *   3. 闭包里每个文件的全文哈希(只用来在 1 红的时候说清是哪个文件变了)。
 *
 * 红了怎么办:这不是普通的测试失败。先停,问过用户,再改下面的钉住值。
 *
 * 钉住值改过的记录:
 *   2026-10-13「干净版那一次合入」(分支 claude/rr-clean):用户同意卡片声音过期一次
 *   (`docs/plan/user-decisions-2026-10-13.md` 第 1 节第 14～16 条)。变的只有 `src/kernel/frameMode.mjs` 一个文件
 *   (写法只取声明;画布卡由审阅表的 surface 推出),三张卡的源码版本跟着变;闭包的文件清单没有变。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBuiltinCards } from '../testing/loadBuiltinCards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const WHY = '这个值进卡片声音的身份(cardAudioIdentity)。变了会让用户已生成的卡片声音被判「已过期,请重新生成」,用户没有同意过。'
  + '要改这个值或改动闭包里的文件,先问过用户(出处 docs/plan/prerender-products-contract.md 第 9.2 节)。';

/** 三张卡的钉住值。两张音效卡共用 sound-effects.ts 当入口,所以版本相同 */
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

/** 闭包里每个文件的全文哈希(换行统一成 LF 以后的 sha256),只用来指出是哪个文件变了 */
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
  // 产品里算源码版本用的那张源码表(`src/cards/index.ts` 里 `cardSourceVersion(card, builtinCardSourceFiles)`)
  ({ builtinCardSourceFiles: files } = await kit.load('/src/render/cardSourceFiles.mjs'));
});
after(async () => { await kit?.close(); });

/** 从入口走一遍闭包,记下读过哪些文件(`cardSourceVersion` 每访问一个文件读一次 `files[file]`;给了入口路径就不会扫全表) */
function closureOf(card, entry) {
  const visited = [];
  const spy = new Proxy(files, { get(target, key) { if (typeof key === 'string' && key.startsWith('/src/')) visited.push(key); return target[key]; } });
  const version = cardSourceVersion(card, spy, entry);
  return { version, closure: [...new Set(visited)].sort() };
}

for (const [id, pinned] of Object.entries(AUDIO_CARDS)) {
  test(`${id}: source closure has the same files (none added, none swapped)`, () => {
    const card = kit.cards.find((c) => c.id === id);
    assert.ok(card, `内置卡里找不到 ${id}`);
    const { closure } = closureOf(card, pinned.entry);
    const added = closure.filter((f) => !pinned.closure.includes(f));
    const removed = pinned.closure.filter((f) => !closure.includes(f));
    assert.deepEqual({ added, removed }, { added: [], removed: [] },
      `${id} 的源码导入闭包变了(新增 ${JSON.stringify(added)},少了 ${JSON.stringify(removed)})。${WHY}`);
    assert.equal(closure.length, pinned.closure.length, `${id} 的闭包文件数变了。${WHY}`);
  });

  test(`${id}: source version is pinned`, () => {
    const card = kit.cards.find((c) => c.id === id);
    // 产品里的取法:不给入口,用卡的 id 在源码表里找声明它的文件。先确认找到的就是钉住的入口、并且只有这一个文件声明了这个 id
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaring = Object.keys(files).filter((file) => new RegExp(`\\bid\\s*:\\s*['"]${escaped}['"]`).test(files[file]));
    assert.deepEqual(declaring, [pinned.entry], `源码表里声明 ${id} 的文件不止钉住的这一个,或不是它。${WHY}`);
    const version = cardSourceVersion(card, files);
    assert.ok(version.startsWith(`${pinned.entry}\n`), `${id} 的源码版本不是从 ${pinned.entry} 起头。${WHY}`);
    const actual = sha256(version);
    if (actual !== pinned.version) {
      const changed = pinned.closure.filter((f) => Object.hasOwn(files, f) && sha256(normalizeEol(files[f])) !== FILE_HASHES[f]);
      assert.fail(`${id} 的源码版本变了(钉住 ${pinned.version.slice(0, 16)},现在 ${actual.slice(0, 16)});内容变了的闭包文件:${changed.length ? changed.join('、') : '(没有找到,可能是闭包成员变了)'}。${WHY}`);
    }
  });
}

test('the pinned file hashes cover exactly the union of the three closures', () => {
  const union = [...new Set(Object.values(AUDIO_CARDS).flatMap((c) => c.closure))].sort();
  assert.deepEqual(Object.keys(FILE_HASHES).sort(), union);
});
