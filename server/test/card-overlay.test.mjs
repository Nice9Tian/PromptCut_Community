/**
 * 用户卡与改动层(M8 之前的两处遗留,报告 `docs/archive/agent-reports/AGENT-card-overlay.md`)。
 *
 *   CO1  create_card 带 overwrite:改动层里有这张卡的旧版时,新内容要生效(以前写进底版,被改动层的旧版盖住)
 *   CO2  有改动层时主机不写检出目录:本机原来没有的用户卡(内容库同步、打开 .proc、create_card)一律写进改动层,
 *        检出里的 `src/cards/user/` 不多一个文件;按 id 找卡、源码闭包、代码身份都认改动层里的用户卡
 *   CO3  没有改动层(开发期)照旧写检出目录
 *
 * 改动层只由环境变量决定(`card-overrides.mjs` 的 `overridesRoot` 每次现读),按用例临时设上。
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
  id: "price-tag", name: "价格", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "${text}" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;
const USER_KEY = 'src/cards/user/price-tag.tsx';

/** 一个最小的「检出」:内核文件、用户卡装载入口 */
function checkout(prefix, extra = {}) {
  const root = tmp(prefix);
  put(root, 'src/kernel/types.ts', 'export type CardDef<T> = any;\nexport type CardProps<T> = any;\n');
  put(root, 'src/cards/user/index.ts', 'export const userCards = [];\n');
  for (const [rel, text] of Object.entries(extra)) put(root, rel, text);
  return root;
}
const userDirFiles = (root) => fs.readdirSync(path.join(root, 'src', 'cards', 'user')).sort();

/* ================================================================== CO1 */

test('CO1 create_card 带 overwrite:改动层里有旧版时,新内容生效,底版不动', () => {
  const root = checkout('pc-co1-', { [USER_KEY]: cardSource('v1') });
  const overlay = tmp('pc-co1-overlay-');
  put(overlay, USER_KEY, cardSource('v1-edited'));
  withOverlay(overlay, () => {
    assert.match(readEffective(root, path.join(root, USER_KEY)), /v1-edited/, '前提:生效的是改动层那一份');
    const r = cards.createUserCard({ root, id: 'price-tag', source: cardSource('v2'), existingIds: [], overwrite: true });
    assert.equal(r.ok, true, JSON.stringify(r.ok ? {} : r.body));
    assert.equal(r.already, true);
    assert.match(readEffective(root, path.join(root, USER_KEY)), /"v2"/, '覆盖重写之后生效的是新内容');
    assert.equal(r.written, path.join(overlay, USER_KEY), '写进改动层');
    assert.equal(fs.readFileSync(path.join(root, USER_KEY), 'utf8'), cardSource('v1'), '底版不动');
  });
});

test('CO1b create_card 不带 overwrite:改动层里有这张卡(底版没有)也算已存在,409', () => {
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

test('CO2 有改动层时,本机原来没有的用户卡写进改动层,检出目录不多一个文件(内容库同步、打开 .proc、create_card)', () => {
  const root = checkout('pc-co2-');
  const overlay = tmp('pc-co2-overlay-');
  const history = tmp('pc-co2-history-');
  const before = userDirFiles(root);
  withOverlay(overlay, () => {
    // 内容库同步(独立渲染主机、编辑器都走这条)
    const synced = cards.installSyncedFile({ root, historyDir: history, rel: USER_KEY, source: cardSource('v1') });
    assert.equal(synced.ok, true, synced.error);
    assert.equal(synced.status, 'written');
    assert.equal(synced.written, path.join(overlay, USER_KEY));
    assert.equal(fs.readFileSync(path.join(overlay, USER_KEY), 'utf8'), cardSource('v1'));
    // 再装同一份:按生效内容比对,不动
    assert.equal(cards.installSyncedFile({ root, historyDir: history, rel: USER_KEY, source: cardSource('v1') }).status, 'unchanged');
    // 用户卡用到的文件(本机没有的)同样只进改动层
    const dep = cards.installSyncedFile({ root, historyDir: history, rel: 'src/cards/user/price-tag-util.ts', source: 'export const k = 1;\n' });
    assert.equal(dep.ok, true, dep.error);
    assert.equal(fs.existsSync(path.join(overlay, 'src/cards/user/price-tag-util.ts')), true);

    // 打开 .proc
    const [bundled] = cards.installBundledCards({ root, historyDir: history, cards: [{ id: 'coupon', source: cardSource('c1').replace('"price-tag"', '"coupon"') }], existingIds: [] });
    assert.equal(bundled.status, 'written', bundled.error);
    assert.equal(fs.existsSync(path.join(overlay, 'src/cards/user/coupon.tsx')), true);

    // create_card
    const created = cards.createUserCard({ root, id: 'ticket', source: cardSource('t1').replace('"price-tag"', '"ticket"'), existingIds: [] });
    assert.equal(created.ok, true, JSON.stringify(created.ok ? {} : created.body));
    assert.equal(created.written, path.join(overlay, 'src/cards/user/ticket.tsx'));
  });
  assert.deepEqual(userDirFiles(root), before, '检出里的用户卡目录一个文件都没多');
});

test('CO2b 改动层里的用户卡(底版没有):按 id 找得到、源码闭包带上它用到的改动层文件、代码身份是定制卡', () => {
  const root = checkout('pc-co2b-');
  const overlay = tmp('pc-co2b-overlay-');
  put(overlay, USER_KEY, cardSource('v1', 'import { k } from "./price-tag-util";\n'));
  put(overlay, 'src/cards/user/price-tag-util.ts', 'export const k = 1;\n');
  withOverlay(overlay, () => {
    assert.equal(cards.findCardFile(root, 'price-tag'), USER_KEY);
    assert.deepEqual(cards.importClosure(root, USER_KEY), [USER_KEY, 'src/cards/user/price-tag-util.ts']);
    const id1 = cards.cardCodeIdentity(root, 'price-tag');
    assert.ok(id1, '找得到定义');
    assert.equal(id1.custom, true);
    // 与「同一份源码放在检出里」算出同一个身份:两台节点一台装在检出、一台装在改动层,仍认同一份代码
    const other = checkout('pc-co2b-other-', { [USER_KEY]: cardSource('v1', 'import { k } from "./price-tag-util";\n'), 'src/cards/user/price-tag-util.ts': 'export const k = 1;\n' });
    const id2 = withOverlay(null, () => cards.cardCodeIdentity(other, 'price-tag'));
    assert.equal(id1.version, id2.version);
  });
  assert.equal(withOverlay(null, () => cards.findCardFile(root, 'price-tag')), null, '没有改动层就看不见它');
});

/* ================================================================== CO3 */

test('CO3 没有改动层(开发期):create_card 与内容库同步照旧写检出目录', () => {
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

test('CO4 用户卡装载入口看得见改动层里的卡:清单模块列出底版没有的文件,解析把它们落到仓库里对应的路径', () => {
  const root = checkout('pc-co4-', { 'src/cards/user/in-base.tsx': cardSource('b') });
  const overlay = tmp('pc-co4-overlay-');
  put(overlay, USER_KEY, cardSource('v1', 'import { k } from "./lib/util";\n'));
  put(overlay, 'src/cards/user/lib/util.ts', 'export const k = 1;\n');
  put(overlay, 'src/cards/user/in-base.tsx', cardSource('b-edited'));
  put(overlay, 'src/cards/user/_scopes.json', '{}');
  const posix = (p) => p.split(path.sep).join('/');

  // 没有改动层:清单是空表(磁盘上的 src/cards/userOverlay.ts),解析一律交给 Vite
  withOverlay(null, () => {
    assert.match(cards.userOverlayModuleCode(root), /export const overlayModules = \{  \};/);
    assert.equal(cards.resolveOverlayOnly(root, '/src/cards/user/price-tag.tsx'), null);
  });

  withOverlay(overlay, () => {
    const code = cards.userOverlayModuleCode(root);
    // 底版有的(in-base)不列:glob 收它,加载钩子交出改动层那一份;归属表不是源码,不列
    assert.doesNotMatch(code, /in-base|_scopes/);
    assert.match(code, /import \* as m\d+ from "\/src\/cards\/user\/price-tag\.tsx";/);
    assert.match(code, /import r\d+ from "\/src\/cards\/user\/price-tag\.tsx\?raw";/);
    assert.match(code, /import r\d+ from "\/src\/cards\/user\/lib\/util\.ts\?raw";/);
    assert.doesNotMatch(code, /import \* as m\d+ from "\/src\/cards\/user\/lib/, '子目录里的是被引用的实现,不当卡收');
    assert.match(code, /overlayModules = \{ "\.\/price-tag\.tsx": m\d+ \}/);
    assert.match(code, /overlayDependencyRaws = \{ "\.\/lib\/util\.ts": r\d+, "\.\/price-tag\.tsx": r\d+ \}/);

    const card = posix(path.join(root, USER_KEY));
    assert.equal(cards.resolveOverlayOnly(root, '/src/cards/user/price-tag.tsx'), card, '根相对');
    assert.equal(cards.resolveOverlayOnly(root, '/src/cards/user/price-tag.tsx?raw'), `${card}?raw`, '查询串原样带上');
    assert.equal(cards.resolveOverlayOnly(root, './lib/util', card), posix(path.join(root, 'src/cards/user/lib/util.ts')), '相对导入补扩展名');
    assert.equal(cards.resolveOverlayOnly(root, card), card, '绝对路径');
    assert.equal(cards.resolveOverlayOnly(root, '/src/cards/user/in-base.tsx'), null, '底版有的交给 Vite');
    assert.equal(cards.resolveOverlayOnly(root, '/src/cards/user/nope.tsx'), null, '两边都没有的交给 Vite(照常报找不到)');
    assert.equal(cards.resolveOverlayOnly(root, '../../kernel/types', card), null, '内核文件不归改动层');
    assert.equal(cards.resolveOverlayOnly(root, 'motion/react', card), null, '包名交给 Vite');
  });
});
