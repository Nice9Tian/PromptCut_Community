/*
 * 列出「公开侧还在 import 闭源」的每一处 —— 这就是要拆的接缝清单。
 *
 *   node scripts/dev/community-seams.mjs <仓库根> [--md]
 *
 * 归属表在 `server/test/community-ownership.mjs`（和守门测试 `server/test/community-boundary.test.mjs`
 * 共用同一张，两边各抄一份会漂）。放在 server/test/ 而不是这里，是因为仓库的依赖方向规则是
 * `scripts/ → server/`，反过来不行（`server/test/bakery-deps.test.mjs` 钉着这条）。判定规则：公开代码不许 import 闭源；闭源可以随便 import 公开。
 * 表的内容以 `docs/plan/community-boundary.md` 第三节为准。
 */
import { importsOf, isCloud, isLan, isTest, listCodeFiles } from '../../server/test/community-ownership.mjs';

const ROOT = process.argv[2] ?? '.';
const AS_MD = process.argv.includes('--md');

/** 公开文件 → 它引到的闭源文件们 */
const seams = new Map();
for (const rel of listCodeFiles(ROOT)) {
  if (isCloud(rel)) continue;
  const hits = importsOf(ROOT, rel).filter(isCloud);
  if (hits.length) seams.set(rel, hits);
}

/*
 * 第二维：core → lan（用户 2026-10-28 定的第三类，见 `community-ownership.mjs` 的 `LAN_DIRS`）。
 *
 * 后面要出 Lite 版（只有本地、没有局域网），从社区版裁出来、不另开仓库。方向规则和闭源那一层
 * 同形：core 不许 import lan，否则 Lite 裁不掉。**这一轮不立闸门**（Lite 构建与检查等拆完两仓
 * 之后再加），这里只把数报出来，免得在动手之前先悄悄变差。
 *
 * `src/main.tsx` 是故意留的那一条边（入口注册，见 `src/editor/sync/lanBoot.ts`），单独列出来，
 * 不混在待办里。
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

/** 按「这个文件属于哪一块」分组，方便切成互不撞车的活 */
const AREAS = [
  'src/editor/sync/', 'src/editor/right/', 'src/editor/io/', 'src/editor/left/', 'src/editor/',
  'src/start/', 'src/ai/', 'src/online/', 'src/mobile/', 'src/render/',
  'server/docservice/', 'server/asset-store/', 'server/agent/', 'server/', 'src/', 'scripts/',
];
const areaOf = (f) => AREAS.find((a) => f.startsWith(a)) ?? '其它';

const byArea = new Map();
for (const [f, hits] of prod) {
  const a = areaOf(f);
  if (!byArea.has(a)) byArea.set(a, []);
  byArea.get(a).push([f, hits]);
}
const areasSorted = [...byArea.entries()].sort((x, y) => y[1].length - x[1].length);

if (AS_MD) {
  console.log(`# 要拆的接缝清单（生成于 ${new Date().toISOString().slice(0, 10)}）\n`);
  console.log(`公开侧还在 import 闭源的文件：**产品代码 ${prod.length} 个**，测试与探针 ${tests.length} 个。\n`);
  console.log('按块分，每一块可以独立派一份活（互不撞车）：\n');
  for (const [a, list] of areasSorted) {
    console.log(`## ${a}（${list.length}）\n`);
    for (const [f, hits] of list) console.log(`- \`${f}\` → ${hits.map((h) => `\`${h}\``).join('、')}`);
    console.log('');
  }
  console.log('## 测试与探针\n');
  console.log(`共 ${tests.length} 个，跟着各自的主题走，不单独派活。\n`);
} else {
  console.log(`公开侧还在 import 闭源：产品代码 ${prod.length}、测试与探针 ${tests.length}`);
  console.log('');
  for (const [a, list] of areasSorted) console.log(`${String(list.length).padStart(4)}  ${a}`);
  console.log('');
  const entry = lanSeams.has(LAN_ENTRY);
  const others = [...lanSeams.keys()].filter((f) => f !== LAN_ENTRY);
  console.log(`core 还在 import lan：${others.length} 个（${LAN_ENTRY} 那条入口注册${entry ? '在位' : '不在了'}，不算）`);
  for (const f of others) console.log(`      ${f} → ${lanSeams.get(f).join('、')}`);
  console.log('      ↑ Lite 版（只有本地、没有局域网）要从社区版裁出来，这一维只许降不许升；');
  console.log('        闸门等拆完两仓之后在公开仓库里加（用户 2026-10-28 定）。');
}
