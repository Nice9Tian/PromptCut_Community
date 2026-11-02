/**
 * 社区版边界的守门测试（接缝总纲 `docs/plan/community-boundary.md` 第二节「不变量」）。
 *
 * 要守的是什么：PromptCut 要开源一个社区版，做法是**公开仓库当正本**，私有仓库把它当
 * git 子模块挂在 `community/` 下，私有仓库自己只放一个 `cloud/`。同步**只有一个方向**：
 * 公开 → 私有。所以不变量是「共享树里的文件，两个仓库里一个字都不能差」。
 *
 * 为什么非测不可：这套不变量的破坏方式都是**悄无声息**的。在私有仓库里给一个公开文件加一行
 * `import ... from '../cloud/...'`，本地什么都不会坏（私有仓库两边文件都齐）；坏的是下一次
 * 同步时公开仓库那棵树里这个 import 指向一个不存在的文件，而那时候已经推出去了。
 * 开源这个方向上，漏一项的代价是「服务器内部结构进了公开历史」，git 历史删不干净。
 *
 * 四道闸门：
 *   G1  公开文件不许**加载** `cloud/`（import、动态 import、字符串拼的路径都算；注释不算）
 *   G2  各块的扩展入口只许在「云端目录」变量下面找加载表，不许写死相对路径逃出去
 *   G3  棘轮：公开侧还在 import 闭源的文件数只许降不许升
 *   G4  每张云端加载表都必须能被同步 require 进来（用 createRequire 的加载点会直接抛）
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
 * G3 的上限。**只许降不许升。**
 *
 * 这是「公开侧还在 import 闭源目录」的产品文件数（不含测试与探针）。拆接缝就是把它推到 0 的过程。
 * 一份活合进来之后把这个数字改小；任何改动让它变大，这条测试就红 —— 那说明新代码又在公开侧
 * 引了闭源的东西，要么是判错了归属，要么是该走接缝没走。
 *
 * 2026-10-27：58（把 `src/online/l2.ts` `l2Costs.ts` 改判成公开之后，见总纲第九节；
 * 五份活开工时的基线是 60。生成清单：`node scripts/dev/community-seams.mjs . --md`）
 */
// 2026-10-27 五份活全部合完、跨活待办做掉之后，公开侧**一个产品文件都不再 import 闭源**。
// 这是第七节「切换到两仓库布局」的前提条件，所以上限就是 0：往上加一个都判红。
const SEAM_CEILING = 0;

/** 共享树里要查的文件：公开的产品代码（测试和探针跟着主题走，不在这条规则里） */
function sharedProductionFiles() {
  return listCodeFiles(ROOT).filter((rel) => !isCloud(rel) && !isTest(rel));
}

test('G1 public product files must not load anything under cloud/ (mentions in comments do not count)', () => {
  // 扩展入口真的会去加载它；边界工具只是把 `cloud/` 这个名字写成数据（两者的区别见归属表里的注释）
  const whitelist = new Set([...LOADER_WHITELIST, ...BOUNDARY_TOOLING]);
  const offenders = [];

  for (const rel of sharedProductionFiles()) {
    if (whitelist.has(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!src.includes('cloud')) continue; // 绝大多数文件在这里就走了，不用扫
    const comments = commentRanges(src);
    // 两类写法都要抓：
    //   1. `'cloud/...'` —— 带斜杠的路径字面量。import 说明符、拼出来的路径都长这样，是实际会出现的那种。
    //   2. `path.join(root, 'cloud', ...)` —— 把 cloud 当单独一段。只搜第一种的话这种大摇大摆走过去
    //      （2026-10-27 造探针验出来的）。
    //
    // 第二类**只在拼路径的上下文里**才算。单独一个 `'cloud'` 字符串在这个代码库里绝大多数是**值**
    // 而不是路径段 —— realm 名、AI 栏的模式、`data-pcm-agent` 属性，一扫就是七条误报。
    // 所以要求同一句里还出现 path.join / path.resolve / import(，才判它在拼路径。
    //
    // 说清这条检查的边界：它拦得住顺手写出来的和拼段式的，拦不住刻意混淆的（`'c'+'loud'`、
    // 从配置里读路径）。那种得靠 G3 按解析后的 import 图算，以及人看 diff。
    // 用 RegExp 构造而不是正则字面量：本机写这个文件的工具会把 backslash-b 一类转义吃成退格符，踩过三次
    const ARRAY_ELEMENT = new RegExp(String.raw`(?:\[|,)\s*['\"]cloud['\"]\s*(?:,|\])`);
    const NEEDLE = /(?:cloud\/)|(?:['"`]cloud['"`])/g;
    NEEDLE.lastIndex = 0;
    for (let m = NEEDLE.exec(src); m; m = NEEDLE.exec(src)) {
      const idx = m.index;
      if (!m[0].includes('/')) {
        // 第二类：往前看一截，没有拼路径的痕迹就不算
        const stmt = src.slice(Math.max(0, idx - 120), idx);
        // 第三类：裸的数组元素（`["..", "..", "cloud", "online", "manifest.ts"]`）。前后紧邻的是
        // `[` / `,` / `]`、中间只许空白，所以 `realm: "cloud"` 这种**值**不会命中。
        // 2026-10-27 在干净树上验过：第三类零误报，而 boot.ts 原来那一行会被抓到。
        // 窗口要够宽：数组一换行（`[`-换行-缩进-`".."`-逗号-换行-缩进-`"cloud"`）之后，
        // 前面那个逗号离得就远了。±2 个字符只认得住写在一行里的，而 B1 那个 bug 被
        // 格式化工具拆成多行之后正是这个样子 —— 2026-10-28 审查点出来的逃生口。
        const elem = src.slice(Math.max(0, idx - 48), idx + m[0].length + 48);
        const asArrayElement = ARRAY_ELEMENT.test(elem);
        if (!asArrayElement && !/path\.(join|resolve)\s*\(|import\s*\(|fileURLToPath|new URL\s*\(/.test(stmt)) continue;
      }
      if (inComment(comments, idx)) continue;
      // `src/ai/cloud/` 是**源码树里**的闭源目录，不是私有根下的 `cloud/`。
      // 它由 G3 的棘轮管（拆接缝的过程中会逐步归零），不在这条闸门的范围里。
      const before = src.slice(Math.max(0, idx - 8), idx);
      if (before.endsWith('ai/') || before.endsWith('/ai/')) continue;
      const line = src.slice(0, idx).split('\n').length;
      offenders.push(`${rel}:${line}  ${src.split('\n')[line - 1].trim().slice(0, 120)}`);
      break; // 一个文件报一处就够，不用刷屏
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

    // 整词匹配是故意的：子串匹配挡不住改名，`PROMPTCUT_CLOUD_DIR_OLD` 也含这个子串。
    // 用字符类而不用正则的单词边界转义 —— 本机写这个文件的工具会把那个转义吃成退格符，踩过三次。
    // 两种写法都算：直接 `process.env.PROMPTCUT_CLOUD_DIR`，或者把名字存成常量再 `process.env[KEY]`
    // （活 A 的 `src/ai/extensionsLoad.mjs` 是后者）。引号把名字框住了，所以后一种也是整词匹配，
    // `'PROMPTCUT_CLOUD_DIR_OLD'` 不会被当成命中。两处都不用正则的单词边界转义 ——
    // 本机写这个文件的工具会把那个转义吃成退格符，踩过三次。
    const namedAsLiteral =
      src.includes("'PROMPTCUT_CLOUD_DIR'") || src.includes('"PROMPTCUT_CLOUD_DIR"');
    const readsEnvByIndex = src.includes('process.env?.[') || src.includes('process.env[');
    assert.ok(
      /env[.]PROMPTCUT_CLOUD_DIR[^A-Za-z0-9_]/.test(src) || (namedAsLiteral && readsEnvByIndex),
      `${rel} does not read PROMPTCUT_CLOUD_DIR. In the submodule layout the cloud directory is not the cloud/ at the repository root,` +
        `The entry must honor this environment variable, otherwise not a single extension can be attached on the private repository side (and silently so).`,
    );

    // 入口里出现的每一处 'cloud/...' 字面量都必须是「缺省位置」那一处，不许写死别的相对路径
    const comments = commentRanges(src);
    for (let idx = src.indexOf('..'); idx !== -1; idx = src.indexOf('..', idx + 1)) {
      if (inComment(comments, idx)) continue;
      const line = src.slice(0, idx).split('\n').length;
      const text = src.split('\n')[line - 1];
      // 允许 `'../..'` 这类「从本文件走到仓库根」的写法；不允许在云端目录后面再往上跳
      assert.ok(
        // 两个点必须紧跟在引号后面才算「逃出云端目录」—— 它得是字符串里的 `".."`。
        // 不加这个限制的话展开运算符会误报：`path.join(cloudDirOf(), ...sub)` 里的 `...` 也含两个点
        // （2026-10-27 给浏览器侧别名插件登记白名单时当场撞到）。
        !/cloud[^'"]*['"]\.\./.test(text),
        `${rel}:${line} goes up one more level after the cloud directory and would escape it: ${text.trim()}`,
      );
    }

    // 找不到表时必须回空、不许抛 —— 社区版就是找不到的情况。这里只查有没有这个意思，
    // 真正的行为由 server/test/docservice-extensions.test.mjs 的 EXT3 钉住。
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

  // 降得太多就提醒把上限跟着降，否则棘轮会松掉。
  //
  // 下界放得很宽（20），是因为**每一份接缝活在合进来之前都会合法地把这个数降下去**，
  // 而上限写在这个共享文件里、由集成方在合并时才改。下界卡太紧（原来是 4）会让每一条
  // 正在拆接缝的分支都在 G3 上红，而它们恰恰是把事情做对的那些分支 —— 那种红只会教人
  // 忽略这条测试。卡在 20 上，单份活的改进不会误报，而「拆完了却忘了收紧上限」还是会红。
  assert.ok(
    offenders.length >= SEAM_CEILING - 20,
    `Only ${offenders.length} seams remain, more than 20 below the ceiling of ${SEAM_CEILING}.\n` +
      `Change SEAM_CEILING in this file to ${offenders.length}, otherwise the ratchet stays loose,` +
      `and it will not go red if someone adds a batch back later.`,
  );
});

test('G4 every cloud loader table must be loadable with a synchronous require', () => {
  // 为什么要这一条：加载点有两种写法，而其中一种对加载表有硬要求。
  //
  // `server/docservice/extensions.mjs` 用的是顶层 `await import()`。那块的依赖图无环，所以成立。
  // 但 `server/agent/service/extensions.mjs` 照搬这个形状时**全线死锁**（2026-10-27 实测 220 条红、
  // 两个测试文件被看门狗杀），因为 Agent 那摊的依赖图是环的：
  //
  //   extensions.mjs（顶层 await 未 settle）
  //     → cloud/agent/manifest.mjs → cloud/agent/account-runner.mjs
  //     → server/agent/service/conversation-policy.mjs → create-agent-service.mjs
  //     → 回到 extensions.mjs
  //
  // 所以那个加载点改成了「首次调用时 `createRequire(...)(表)` 同步惰性加载」，模块求值阶段零等待。
  // 代价是：**同步 require 一个 .mjs 要求它和它的静态依赖图里都不许有顶层 await**，
  // 否则抛 `ERR_REQUIRE_ASYNC_MODULE` —— 而那是将来某次无关改动才会触发的爆炸。
  //
  // 这条闸门把这个要求钉在所有加载表上（不只是用 createRequire 那个加载点的），这样两种写法
  // 随时都能互换，也不会有人在一张表的依赖图深处加一个顶层 await 之后才发现炸了。
  const manifests = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 社区版没有 cloud/，这条自然为空
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^manifest\.(mjs|js|cjs|ts)$/.test(e.name)) manifests.push(full);
    }
    // 认 PROMPTCUT_CLOUD_DIR：子模块布局下云端目录不在公开仓库根下面，写死 ROOT/cloud
    // 会让这条闸门**恒为空、恒绿** —— 而它存在的全部理由就是防 Agent 那摊的顶层 await 死锁。
  })(process.env.PROMPTCUT_CLOUD_DIR ? path.resolve(process.env.PROMPTCUT_CLOUD_DIR) : path.join(ROOT, 'cloud'));

  const require_ = createRequire(path.join(ROOT, 'g4-probe.js'));
  const broken = [];
  for (const file of manifests) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel.endsWith('.ts')) continue; // 浏览器侧的表走别名、由构建打包，不经 require
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
  // 死条目不报错，坏处是**将来谁在那个路径上新建一个公开文件，会被归属表默默判成闭源、
  // 被 G1/G3 豁免**。2026-10-28 审查查出 CLOUD_FILES 里有四条指向 `src/online/` 的条目，
  // 而那四个文件早就搬进了 `cloud/online/`。
  //
  // 云端目录下的条目在社区版里本来就不存在，所以那些跳过（公开仓库里没有 cloud/ 是对的）。
  const cloudDir = process.env.PROMPTCUT_CLOUD_DIR
    ? path.resolve(process.env.PROMPTCUT_CLOUD_DIR)
    : path.join(ROOT, 'cloud');
  const hasCloud = fs.existsSync(cloudDir);

  const dead = [];
  for (const [name, list] of [
    ['CLOUD_FILES', CLOUD_FILES],
    ['LOADER_WHITELIST', LOADER_WHITELIST],
    ['BOUNDARY_TOOLING', BOUNDARY_TOOLING],
    // LAN_FILES / LAN_DIRS 原来不在这个循环里 —— 2026-10-28 另一个会话核对边界时点出来的。
    // 局域网那一类将来搬家一样会留死条目，而 CLOUD_FILES 刚因为八条死条目吃过苦头。
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
  // 2026-10-30：托管地址写在 server/auth/hosted-default.mjs 里，文件归公开，地址就跟着公开了，社区版还真的去连它。
  // 地址只许写在闭源的产品声明里（server/auth/product.mjs）。这里扫的是导出社区版时会带走的全部文本文件，
  // 测试、探针、文档都算：退役地址当样本也不行，样本用 example 域名和文档保留网段（203.0.113.0/24）。
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
  // 2026-10-31：G1 只管产品文件，探针不在里面；闭源路径写成字符串（spawn、fork、拼路径）G3 的 import 图也看不见。
  // 只测闭源功能的探针放 cloud/scripts/probes/，手机探针接 scripts/probes/lib/probe-services.mjs。
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
