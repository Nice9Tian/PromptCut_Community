/**
 * 社区版边界的**唯一一张归属表**，以及几个共用的小工具。
 *
 * 为什么要抽出来：接缝清单脚本（`community-seams.mjs`）和守门测试
 * （`server/test/community-boundary.test.mjs`）必须用同一张表。两边各抄一份的话，
 * 改了一处忘了另一处，守门测试就会放过它本该拦住的东西 —— 而这种漏放在开源这件事上
 * 的代价是「服务器内部结构进了公开历史」，git 历史删不干净。
 *
 * 表的内容以 `docs/plan/community-boundary.md` 第三节（分区表）为准。改这里之前先改那份文件。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/*
 * ──────────────────────────────────────────────────────────────────────────────
 * 第三类：局域网（`lan`）。用户 2026-10-28 定的。
 *
 * 后面要出一个 **Lite 版：只有本地，没有局域网**，而且 **Lite 从社区版裁出来、不另开仓库**。
 * 所以共享树内部还要再分一刀：
 *
 *   核心（core）   本地编辑那一套。Lite、社区版、私有版都有
 *   局域网（lan）  只为「局域网里的第二块屏」存在的东西。Lite 裁掉，社区版与私有版保留
 *   闭源（cloud）  下面那两张表。只有私有版有
 *
 * **方向规则和闭源那一层同形**：core 不许 import lan（否则 Lite 裁不掉），lan 可以随便 import core。
 * **这一轮不立闸门** —— 用户明确说 Lite 构建与对应的检查等拆完两仓之后再在公开仓库里加。
 * 现在只把类标出来、让 `scripts/dev/community-seams.mjs` 把这一维的数报出来，
 * 免得在动手做 Lite 之前先悄悄变差。
 *
 * 判据是文件头自己写的用途，不是文件名里有没有 `lan` 三个字母（`planDispatch.ts`、`GlPlane.tsx`、
 * `bakePlan.ts` 都带，跟局域网没关系）。
 *
 * **判 lan 的标准只有一条：Lite 需不需要。** 判准 2026-10-28 订正过：原来写的理由是「云端共享项目
 * 同样要用，所以归 core」，那推不出来 —— lan 在社区版和私有版里**都在**，只有 Lite 砍掉它，所以
 * 「云端也用」和「归 lan」完全可以并存（细节与四档候选的实测边数见 `docs/plan/community-boundary.md`
 * 第十三节）。
 *
 * **多用户界面那六个（甲档）归 lan**（用户 2026-10-30 批准）：`MembersPanel`、`JoinPanel`、`JoinForm`、
 * `MobileJoin`、`CollabSection`、`SharedDialogs`。Lite 里没有任何可加入的东西，这六个一个都到不了；
 * 它们互相引用、对外封闭，合在一起改判，core→lan 边从 4 条变 8 条，多出来的 4 条每条都是单一的界面挂载点。
 *
 * **故意没放进来的**（Lite 那一轮按产品语义再定，别在这里先替它定了）：
 *   `src/online/invite.ts`              邀请链接的读取与解析。`syncManager → invite` 这条主干反向引用挡路
 *   `src/editor/sync/syncManager.ts`  **本机项目自己就走它**（文件头：本机项目连本机编辑器的
 *                                     `/docservice`，`kind: local | shared` 贯穿全文件）。Lite 要它
 *   `collab.ts`、`sharedApi.ts`        先别动：`syncManager → sharedApi` 这条主干反向引用挡路
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** 整个目录归局域网 */
export const LAN_DIRS = Object.freeze([
  'server/lan/',
]);

/** 单个文件归局域网（所在目录本身是 core） */
export const LAN_FILES = Object.freeze([
  'server/lan-open.mjs',
  'server/lan-open.d.mts',
  'server/vite-plugin-lan-open.ts',
  'src/editor/LanOpenDialog.tsx',
  'src/editor/sync/lanMemberSource.ts',
  'src/editor/sync/lanBoot.ts',
  'scripts/dev-lan.mjs',
  // 甲档：多用户界面（用户 2026-10-30 批准，见上面的说明）
  'src/editor/sync/MembersPanel.tsx',
  'src/editor/sync/JoinForm.tsx',
  'src/editor/sync/CollabSection.tsx',
  'src/editor/sync/SharedDialogs.tsx',
  'src/start/JoinPanel.tsx',
  'src/mobile/MobileJoin.tsx',
]);

/** 整个目录归闭源 */
export const CLOUD_DIRS = Object.freeze([
  // A3/D3（2026-10-28）：原来这八个目录散在 `src/` 和 `server/` 下面，只是**被这张表判成**闭源；
  // 现在物理上搬进了 `cloud/` 下、镜像原来的结构（`src/account/` → `cloud/src/account/`，
  // `server/hosted/` → `cloud/server/hosted/`，以此类推）。搬完之后 `'cloud/'` 这一条就把它们全盖住了，
  // 所以这张表只剩一条 —— 这正是「公开仓库里压根没有这些文件」的那个最终形态。
  'cloud/',
]);

/** 单个文件归闭源（目录本身公开） */
/*
 * 2026-10-28:这里原来有四条指向 `src/online/` 的条目，而那四个文件早已搬进 `cloud/online/`。
 * 死条目不报错，坏处是**将来谁在 `src/online/` 下新建同名的公开文件，会被这张表默默判成闭源、
 * 被 G1/G3 豁免**。所以 `server/test/community-boundary.test.mjs` 里加了一条 G5：表里每一项都
 * 必须真的存在。
 */
export const CLOUD_FILES = Object.freeze([
  // A3/D3（2026-10-28）之后这张表**空了**，而且空得有道理：原来它列的那些单个文件
  // （`server/recovery/` 八个、`server/docservice/operation-wiring.mjs` 与 `ecosystem.config.cjs`、
  // `scripts/sync-community.mjs`，以及本来就在 `cloud/` 下的七个）现在**全部**在 `cloud/` 下面，
  // 由 `CLOUD_DIRS` 的 `'cloud/'` 一条盖住。表空 = 闭源的东西一个不剩地住进了 `cloud/`，
  // 这正是第一节那个最终形态要的结果。
  //
  // 什么时候该往这里加：**只有**当某个文件归闭源、却因为别的原因不得不留在共享树里时。
  // 加之前先问一句「为什么不能搬进 cloud/」—— 答不上来就是该搬，不是该加表。
  //
  // 另外记一笔 2026-10-28 的一处**改判**：`server/docservice/main.mjs` 原来在这张表里，
  // 现在**判回公开**。依据是它自己的文件头加实测：「独立运行的文档服务。可以跑在本机、
  // 局域网里的另一台机器或公网云端，协议相同」，而且它的 import 闭包里**零个闭源文件**。
  // 它要是搬去私有侧，社区版就没有文档服务入口了 —— 局域网那一整套（用户明确要保住的东西）
  // 直接没了。这和 lan 那一层踩的是同一个坑：「云端也用它」推不出「归闭源」。
]);

/**
 * 允许真的去加载 `cloud/` 的文件 —— 各块的扩展入口。
 * 按**文件名**白名单放行（总纲第二节）。白名单之外一个都不许，加一个都要在总纲里留依据。
 */
export const LOADER_WHITELIST = Object.freeze([
  'server/docservice/extensions.mjs',
  // 2026-10-27 五份活合并时登记进来的三个新加载点：
  'src/ai/extensionsLoad.mjs',            // 活 A：云端 AI 栏（Node 侧，走 PROMPTCUT_CLOUD_DIR）
  'server/agent/service/extensions.mjs',  // 活 C：服务端 Agent 执行器（惰性同步 require，依赖图有环）
  'server/vite-plugin-hosted-gate.ts',    // 活 D：构建插件与发版脚本
  'server/vite-plugin-cloud-seams.ts',    // 合并时建的浏览器侧别名解析（A1/B1，见第十节）
  'server/auth/product.mjs',              // 产品声明：闭源目录里有 product.config.json 就读那份（总纲第十四节）
  'scripts/test-suite.mjs',               // A2 之后要去闭源目录下收那批搬过去的测试
]);

/**
 * 边界工具本身 —— 不是「扩展入口」，是**边界的定义**。
 *
 * 和 `LOADER_WHITELIST` 是两回事：白名单放行的是「真的去加载 cloud/ 的代码」，
 * 这里放行的是「必须把 `cloud/` 这个名字写成数据的文件」（归属表、守门测试、清单脚本）。
 * 这几个文件在公开仓库里也存在、也必须存在 —— 社区贡献者要靠它们知道边界在哪、
 * 并且能自己跑一遍确认没越界。它们提到 `cloud/` 但从不加载它。
 */
export const BOUNDARY_TOOLING = Object.freeze([
  'server/test/community-ownership.mjs',
  'scripts/dev/community-seams.mjs',
  'server/test/community-boundary.test.mjs',
]);

const CLOUD_FILE_SET = new Set(CLOUD_FILES);

/** 这个仓库相对路径归不归闭源 */
export const isCloud = (rel) => CLOUD_FILE_SET.has(rel) || CLOUD_DIRS.some((d) => rel.startsWith(d));

const LAN_FILE_SET = new Set(LAN_FILES);

/**
 * 这个仓库相对路径归不归局域网。
 *
 * 和 `isCloud` 是**两件独立的事**：一个文件既不是 cloud 也不是 lan 就是 core；
 * 不会既是 cloud 又是 lan（闭源那一侧没有「局域网」这回事）。
 */
export const isLan = (rel) => LAN_FILE_SET.has(rel) || LAN_DIRS.some((d) => rel.startsWith(d));

/**
 * 导出社区版时留在私有仓库的路径（总纲第三节分区表、第八节）。`cloud/` 之外还有这些：
 * 内部计划与报告、历史归档、内部发版验收、本机原型、内部运维工具。
 */
export const PRIVATE_PREFIXES = Object.freeze([
  'cloud/',
  'docs/plan/', 'docs/reports/', 'docs/archive/',
  'archive/', 'scripts/archive/',
  'scripts/acceptance/',
  '.claude/', 'prototypes/', 'wait_to_judge_html/',
  'tools/api-share-gui/', 'tools/report-inbox-gui/', 'tools/report-worker/',
]);

export const PRIVATE_FILES = Object.freeze([
  'README.md',                                        // 社区版有自己的 README
  'make-api-share.bat', 'report-inbox.bat', 'tools/make-api-share.py',
  'proto.html', 'pc_vis_test.png',
  // 内部发版验收运行器的单测（测的是 scripts/acceptance/，社区版不带）
  'server/test/four-stage-acceptance.test.mjs',
  'server/test/four-stage-acceptance-v18.test.mjs',
  'server/test/probe-timings.test.mjs',
  'server/test/wait-writes-quiet.test.mjs',
]);

const PRIVATE_FILE_SET = new Set(PRIVATE_FILES);

/** 导出社区版时带不带走这个路径 */
export const isPublicPath = (rel) => !PRIVATE_FILE_SET.has(rel) && !PRIVATE_PREFIXES.some((d) => rel.startsWith(d));

/** 列出会进社区版的全部文件（正斜杠）：git 跟踪的和还没提交的新文件，构建产物与被忽略的本机文件不算 */
export function listPublicFiles(root) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return out.split(/\r?\n/).filter((rel) => rel && isPublicPath(rel)).sort();
}

/** 测试、探针、验收脚本 —— 归属跟着各自的主题走，不单独算接缝 */
export const isTest = (rel) =>
  rel.endsWith('.test.mjs') || rel.includes('/test/') || rel.includes('/probes/') || rel.includes('/acceptance/');

const CODE_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'target', 'runtime', '.worktrees', '.claude', 'coverage',
]);

/** 走一遍仓库，列出所有代码文件的仓库相对路径（正斜杠） */
export function listCodeFiles(root) {
  const found = [];
  (function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (CODE_EXT.has(path.extname(e.name))) found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  })(root);
  return found.sort();
}

/** 一个相对 import 说明符指向哪个文件（仓库相对路径），指不到就回 null */
export function resolveSpec(root, fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(root, path.dirname(fromRel), spec);
  for (const e of ['', '.ts', '.tsx', '.mjs', '.js', '.d.mts', '/index.ts', '/index.tsx', '/index.mjs']) {
    try {
      if (statSync(base + e).isFile()) return path.relative(root, base + e).split(path.sep).join('/');
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/*
 * 2026-10-28:原来写的是 `[^;\n]*?` —— 排除换行，于是**多行写法整条看不见**：
 *   import {
 *     a,
 *   } from "../../cloud/x";
 * 单行命中、多行不命中。后果是 G3 的接缝数和同步脚本第 4 项检查都会漏报，
 * 而「把一条违规的 import 换行」正是最容易在格式化时自然发生的事。改成只到分号为止。
 */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]|(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 这个文件 import 到的所有相对目标（仓库相对路径） */
export function importsOf(root, rel) {
  let src = '';
  try {
    src = readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return [];
  }
  const hits = new Set();
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(src))) {
    const target = resolveSpec(root, rel, m[1] || m[2]);
    if (target) hits.add(target);
  }
  return [...hits].sort();
}

/**
 * 找出源码里**注释**占的区间。
 *
 * 为什么非要这么细：守门规则是「不许**加载** `cloud/`」，而不是「不许出现 `cloud/` 字样」
 * （总纲第二节 2026-10-27 的修正）。「这段逻辑的云端对应物在 `cloud/...`」这类注释
 * 正是拆完之后最该留下的线索，不能判红。所以要把注释摘出来排除掉。
 *
 * 反过来，**字符串里的 `cloud/` 算违规** —— 用字符串拼路径去 import 是绕过守门最容易的方式。
 * 所以扫的时候要正确跳过字符串（免得 `'https://x'` 里的 `//` 被当成行注释开头），
 * 但不把字符串本身排除。
 */
export function commentRanges(src) {
  const ranges = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i += 1;
      ranges.push([start, i]);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      ranges.push([start, i]);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        if (quote !== '`' && src[i] === '\n') break; // 未闭合的单行字符串，别吃掉整个文件
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return ranges;
}

/** 这个位置在注释里吗 */
export const inComment = (ranges, idx) => ranges.some(([a, b]) => idx >= a && idx < b);
