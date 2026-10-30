/**
 * 卡片身份摘要的改前改后比对(渲染重构「丁」的硬约束:除了补登记的卡,别的内置卡的
 * 预渲染结果的键不许因为审阅表多了字段而变)。
 *
 * 做什么:对全部内置卡(`src/cards/index.ts` 注册的那四组:magicui、native、素材封装卡、探针卡),
 * 在基准提交和当前工作区各算一遍,逐张比。每张卡放进一个只有它自己的片段(缺省参数、30 帧每秒、2 秒、
 * 1920×1080),走和产品相同的函数:`projectCardGraph` 摊图 → 节点上的能力表 → `cardNodeIdentities`
 * (节点身份)、`cardSnapshotIdentity`(共享快照键的内容键)、`cardCostKey`(成本键)。源码版本用
 * `cardSourceVersion` 按卡片自己的导入闭包算,生成快照的代码指纹用 `snapshotCode`。
 *
 * 每张卡分四栏比:
 *   能力表      节点上的 `capabilities`(审阅表的内容经它进键)
 *   源码版本    这张卡导入闭包的全文(闭包里任何一个文件改一个字都会变)
 *   键          节点身份、快照内容键、成本键(真实的键,上面两样都在里面)
 *   键(定源码)  把源码版本换成常量后再算一遍的键:只看「能力表和节点」这一路有没有变
 *
 * 用法(在仓库或工作区根目录):
 *   node scripts/probes/card-table-digest-compare.mjs [--base main] [--expect id1,id2,…] [--json out.json]
 *
 *   --base    基准提交,缺省 main。用 `git archive` 把它的 src/ 与 server/ 解到
 *             out/card-table-digest/<提交>/ 下(out/ 不入库),不动任何工作区与分支。
 *   --expect  允许变的卡片 id(逗号分隔)。缺省是「丁」补登记的四张。
 *   --json    把两边逐张的结果写成 JSON。
 *   --caps-only  只核「能力表和节点」这一路:能力表、注册表里的定义、键(定源码)三栏一张都不许变(--expect 里的除外),
 *             源码版本和真实的键变不变不管。用在本来就要让源码版本变的改动上(例如动了 `src/kernel/frameMode.mjs`)。
 *
 * 退出码:0 = 只有 --expect 里的卡变了(键与能力表),并且它们确实都变了;1 = 别的卡变了,
 * 或者该变的没变;2 = 跑不起来。
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

/** 把基准提交的 src/、server/ 解到 out/ 下;依赖向上解析到仓库的 node_modules */
function checkoutBase(ref) {
  const sha = git('rev-parse', ref);
  const dir = path.join(HERE, 'out', 'card-table-digest', sha.slice(0, 12));
  if (fs.existsSync(path.join(dir, '.done'))) return { sha, dir };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(dir, 'base.tar');
  execFileSync('git', ['archive', '--format=tar', '-o', tar, sha, 'src', 'server'], { cwd: HERE, windowsHide: true });
  // 相对路径 + cwd:Git Bash 带的 GNU tar 会把 `C:` 当成远端主机名
  execFileSync('tar', ['-xf', 'base.tar'], { cwd: dir, windowsHide: true });
  fs.rmSync(tar);
  fs.writeFileSync(path.join(dir, '.done'), sha);
  return { sha, dir };
}

const FPS = 30, SECONDS = 2, STAGE = { width: 1920, height: 1080 };

async function compute(root) {
  // 载入器用当前工作区这一份(基准提交里可能还没有它),载的是 root 下的卡
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
    if (!b || !a) { rows.push({ id, note: b ? '改后没有这张卡' : '改前没有这张卡' }); bad.push(id); continue; }
    const diff = { capabilities: !same(b.capabilities, a.capabilities), registered: !same(b.registered, a.registered), sourceVersion: b.sourceVersion !== a.sourceVersion,
      keys: !same(b.keys, a.keys), keysFixedSource: !same(b.keysFixedSource, a.keysFixedSource) };
    const changed = diff.capabilities || diff.registered || diff.keys || diff.keysFixedSource || diff.sourceVersion;
    if (!changed) { unchanged++; continue; }
    rows.push({ id, group: a.group, ...diff, before: b, after: a });
    if (!EXPECT.has(id) && (!CAPS_ONLY || diff.capabilities || diff.registered || diff.keysFixedSource)) bad.push(id);
  }
  const missed = [...EXPECT].filter(id => !rows.some(r => r.id === id && (r.keys || r.capabilities)));

  console.log(`基准 ${BASE} = ${base.sha.slice(0, 12)};当前 HEAD = ${head.sha.slice(0, 12)}${head.dirty ? '(src/ 或 server/ 有未提交的改动,算的是工作区)' : ''}`);
  console.log(`生成快照的代码指纹:改前 ${before.snapshotCode} 改后 ${after.snapshotCode}${before.snapshotCode === after.snapshotCode ? '(相同)' : '(不同!)'}`);
  console.log(`内置卡:改前 ${Object.keys(before.cards).length} 张,改后 ${Object.keys(after.cards).length} 张;逐张相同 ${unchanged} 张,有变化 ${rows.length} 张`);
  const yn = v => v ? '变' : '同';
  if (CAPS_ONLY) {
    const count = key => rows.filter(r => r[key]).length;
    console.log(`只核能力表这一路:能力表变 ${count('capabilities')} 张 / 注册表里的定义变 ${count('registered')} 张 / 键(定源码)变 ${count('keysFixedSource')} 张 / 源码版本变 ${count('sourceVersion')} 张 / 键变 ${count('keys')} 张`);
    console.log(`源码版本变了的: ${rows.filter(r => r.sourceVersion).map(r => r.id).join(', ') || '(无)'}`);
  }
  for (const r of rows) {
    if (CAPS_ONLY && !r.note && !r.capabilities && !r.registered && !r.keysFixedSource) continue;
    if (r.note) { console.log(`  ${r.id}: ${r.note}`); continue; }
    console.log(`  ${r.id}(${r.group}): 能力表 ${yn(r.capabilities)} / 注册表里的定义 ${yn(r.registered)} / 源码版本 ${yn(r.sourceVersion)} / 键 ${yn(r.keys)} / 键(定源码) ${yn(r.keysFixedSource)}`);
    if (r.capabilities) console.log(`      能力表  改前 ${JSON.stringify(r.before.capabilities)}\n              改后 ${JSON.stringify(r.after.capabilities)}`);
    if (r.keys) for (const k of ['node', 'snapshot', 'cost']) console.log(`      ${k.padEnd(8)} 改前 ${String(r.before.keys[k]).slice(0, 16)}  改后 ${String(r.after.keys[k]).slice(0, 16)}`);
  }
  if (JSON_OUT) { fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true }); fs.writeFileSync(JSON_OUT, JSON.stringify({ base: base.sha, head, before, after }, null, 1)); }
  if (bad.length) console.log(`✖ 不在 --expect 里却变了的卡 ${bad.length} 张: ${bad.slice(0, 20).join(', ')}${bad.length > 20 ? ' …' : ''}`);
  if (missed.length) console.log(`✖ --expect 里列了却没变的卡: ${missed.join(', ')}`);
  if (CAPS_ONLY && !bad.length && !missed.length) console.log(`✔ 能力表、注册表里的定义、键(定源码)三栏:除 --expect 里的 ${EXPECT.size} 张外一张没变`);
  else if (!bad.length && !missed.length) console.log(`✔ 只有 --expect 里的 ${EXPECT.size} 张变了,其余 ${unchanged} 张的能力表、源码版本、三个键逐张相同`);
  return bad.length || missed.length ? 1 : 0;
}

// 卡片模块载入后会留下定时器(播放库、粒子库),不显式退出进程收不了场
main().then(code => process.exit(code), error => { console.error(error); process.exit(2); });
