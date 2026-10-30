/**
 * 核对「现有卡片的源码版本有没有变」：把基准提交与当前工作区各算一遍，逐张比。
 *
 * 为什么要有它：每张卡的源码版本 = 它的定义文件连同导入闭包里每个文件的全文（`src/render/cardSourceVersion.mjs`）。
 * 闭包里任何一个文件哪怕只加一行注释，这张卡的预渲染结果的键就变了，已生成的卡片声音也会被判过期。
 * 改卡片载入、kernel、render 之后跑一遍，确认没有把现有卡的键带着变。
 *
 * 用法（在仓库根或 worktree 根）：
 *   node scripts/probes/card-source-version-compare.mjs [--base main]
 *
 * 做什么：
 *   1. 用 `git archive <base> src` 把基准提交的 `src/` 解到临时目录（不动工作区、不切分支）；
 *   2. 两边各建一张源码表（口径同 `src/render/cardSourceFiles.mjs` 的 glob：cards、parts、render、kernel 下的
 *      ts / tsx / mjs / css，不含测试），对 `src/cards/`、`src/parts/` 下的每个文件当入口算一遍源码版本（页面一侧的算法）；
 *   3. 两边各对每张内置卡算一遍服务端的代码身份（`server/vite-plugin-cards.ts` 的 `cardCodeIdentity`）；
 *   4. 逐个比。只在基准里有、只在当前里有的入口单列。
 *
 * 输出：过程写 stderr；stdout 最后一行 JSON：{ ok, base, entries, changed: [...], added: [...], removed: [...], identities, identityChanged: [...] }。
 * 通过标准：changed 与 identityChanged 都是空的（新增的文件不算变）。
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

/** 一棵树的源码表：`/src/...` → 原文（口径同 cardSourceFiles.mjs 的 glob） */
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

/** 每个卡片 / 部件文件当入口的源码版本（哈希） */
function versions(root) {
  const files = sourceTable(root);
  const out = new Map();
  for (const key of Object.keys(files)) {
    if (!/^\/src\/(cards|parts)\//.test(key) || !/\.(ts|tsx)$/.test(key)) continue;
    out.set(key, sha(cardSourceVersion({ id: 'entry-given' }, files, key)));
  }
  return out;
}

/** 每张内置卡的服务端代码身份 */
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
  if (archive.status !== 0) throw new Error(`git archive ${BASE} 失败：${archive.stderr}`);
  const baseRoot = path.join(tmp, 'base');
  fs.mkdirSync(baseRoot);
  const untar = spawnSync('tar', ['-xf', 'base.tar', '-C', 'base'], { cwd: tmp, windowsHide: true, encoding: 'utf8' });
  if (untar.status !== 0) throw new Error(`解包失败：${untar.stderr}`);
  const baseCommit = spawnSync('git', ['rev-parse', '--short', BASE], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).stdout.trim();
  say('base', { ref: BASE, commit: baseCommit });

  // 改动层会让「生效的源码」不是检出里的那一份：这里比的是两棵检出，不带改动层
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
