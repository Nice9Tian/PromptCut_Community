/**
 * C10 用户卡与素材效果卡、置灰与离线文案、`/api` 棘轮（`docs/plan/c10-contract.md` 第 9、10、17 节）。
 * 跑：node --experimental-test-module-mocks --test server/test/c10-ui-gates.test.mjs
 *
 *   C10-UI-01 表 A 的文案（顶栏五种状态、离线常驻提示、置灰悬停的模板）以原文出现在 `src/` 的非测试源文件里；
 *   C10-UI-02 「该模式暂不支持素材输入的音频素材效果卡」「该模式暂不支持自定义卡」不再出现（第 9 节：并入图标；徽标换了文字），
 *             「需要本地 PC 渲染辅助」也不再出现（2026-10-21 用户定：图标与徽标一并撤掉）；
 *   C10-UI-03 本页运行不了的用户卡、素材效果卡（内容库同步来的没载入成功的；素材效果卡；2026-10-21 起不按档另挡本页能运行的用户卡）在线时与内置重卡一样：一律按重卡（分派表判轻也一样）、
 *             选帧、报缺口、取字节；暂停态整台「已精确」时它们的快照照挂（停下不追）——2026-09-29 用户改语义，撤销原豁免；
 *   C10-UI-04 桌面（在线开关关着）用户卡、素材效果卡照常选帧，同步表不影响桌面；
 *   C10-RA-01 旧本机 `/api` 清单只减不增；已批准账号入口固定11条字面量（含 2026-10-23 的三条第三方登录），网盘导入另固定三条（2026-10-24），两桶都逐条精确、不按前缀放行，不重复。
 *
 * 置灰入口「点了不发请求、不露报错」要在真页面里点，归探针与验收 C10-A7（主会话），这里只核文案。
 * 假设见 `c10-kit.mjs` 的 K7、K8、K9。门不开时整组 skip。
 */
import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  uiGate, ratchetGate, TABLE_A, DROPPED_TEXTS, srcFilesContaining, repoPath, RATCHET_FILE, RATCHET_BASELINE, useTs, repoUrl,
} from './c10-kit.mjs';

const ui = uiGate();
const itUi = (name, fn) => test(name, { skip: ui.ok ? false : ui.reason }, fn);

itUi('C10-UI-01 表 A 的文案以原文出现在 src/ 的非测试源文件里', () => {
  const missing = TABLE_A.filter((text) => srcFilesContaining(text).length === 0);
  assert.deepEqual(missing, [], `这些文案在 src/ 里找不到：\n${missing.join('\n')}`);
});

itUi('C10-UI-02 「该模式暂不支持素材输入的音频素材效果卡」不再单独出现', () => {
  for (const text of DROPPED_TEXTS) assert.deepEqual(srcFilesContaining(text), [], `「${text}」还在`);
});

/* ------------------------------------------------------------------ 用户卡、素材效果卡不发快照请求（K7） */

let feed = null, registry = null, placeholder = null;
let plan = { segments: [] };
let now = 1000;
async function load() {
  if (feed) return;
  await useTs();
  const srcUrl = (rel) => repoUrl(`src/${rel}`);
  mock.module(srcUrl('editor/planDispatch.ts'), { exports: { currentPlan: () => plan } });
  mock.module(srcUrl('render/dataMirror.ts'), { exports: { mirrorKey: () => ({ session: 's', localRev: 1 }), pushWanted: () => {} } });
  performance.now = () => now;
  feed = await import(srcUrl('editor/snapshotFeed.ts'));
  registry = await import(srcUrl('kernel/registry.ts'));
  placeholder = await import(srcUrl('render/placeholderHost.ts'));
}

const FPS = 30;
const card = (id, cardId) => ({ id, cardId, start: 0, end: 10, params: {} });
const project = (clips) => ({ version: 1, name: 'p', width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: 't', name: 't', clips }] });
let src = null;
function fakeSource() {
  const s = {
    push: null,
    fetched: [],
    subscribeReady(_s, _r, onMessage) { s.push = onMessage; return () => { s.push = null; }; },
    async fetchSnapshot(kind, key, frame) { s.fetched.push(`${kind}/${key}/${frame}`); return `html:${key}/${frame}`; },
  };
  return s;
}

beforeEach(async () => {
  if (!ui.ok) return;
  await load();
  feed.resetSnapshotFeed();
  src = fakeSource();
  feed.setSnapshotSource(src);
  feed.syncSnapshotSubscription(() => {});
  feed.setExtraSuppressed([]);
  registry.registerCards([
    { id: 'c10-user-card', name: 'u', Component: () => null },
    { id: 'c10-graph-card', name: 'g', card: () => ({}), Component: () => null },
  ]);
  registry.setUserCardSources({ 'c10-user-card.tsx': '' }, { 'c10-user-card': 'c10-user-card.tsx' });
  // 内容库同步来的用户卡:本机没有定义,只在同步表里
  registry.setSyncedUserCards([{ id: 'c10-synced-card', name: '同步卡', source: 'src/cards/user/c10-synced-card.tsx' }]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(['b', 'g', 'u']) }] };
  for (const id of ['b', 'g', 'u', 's']) src.push({ type: 'layer', clipId: id, kind: 'html', key: `k-${id}`, ranges: [[0, 100]] });
  now += 10_000;
});

// 's' 是同步来的用户卡,分派表里故意不判重(表里没有它):这台设备跑不了的卡一律按重卡
const clips = () => [card('b', 'builtin-heavy'), card('g', 'c10-graph-card'), card('u', 'c10-user-card'), card('s', 'c10-synced-card')];

async function feedOnce(online, { playing = true } = {}) {
  placeholder.setOnlineBrowserMode(online);
  try {
    const head = { project: project(clips()), t: 1, playing };
    const f = feed.planFeed(head);
    const stage = { calls: [], async setSnapshots(patch, opts) { this.calls.push({ patch, opts }); } };
    await feed.deliverSnapshots(stage, 'front', head);
    await new Promise((r) => setImmediate(r));
    return { f, fetched: [...src.fetched] };
  } finally {
    placeholder.setOnlineBrowserMode(false);
  }
}

itUi('C10-UI-03 在线时用户卡、素材效果卡（含同步来的）与内置重卡一样一律按重卡抑制', async () => {
  const { f, fetched } = await feedOnce(true);
  assert.deepEqual(f.heavy, ['b', 'g', 's', 'u'], '同步卡分派表里没判重,在线照样按重卡');
  assert.equal(f.picks.size, 0, '快照已退役');
  assert.equal(fetched.length, 0, '不再取快照字节');
  placeholder.setOnlineBrowserMode(true);
  try {
    // 第 150 帧不在就绪区间里:退役后 picks 仍为空
    const late = feed.planFeed({ project: project(clips()), t: 5, playing: true });
    assert.deepEqual(late.heavy, ['b', 'g', 's', 'u']);
    assert.equal(late.picks.size, 0);
    assert.deepEqual(late.wanted, []);
  } finally {
    placeholder.setOnlineBrowserMode(false);
  }
  // 暂停态整台「已精确」(K5 第二路互换之后):内置卡不再抑制,这台设备跑不了的卡停下不追,进 scrub 占位
  placeholder.setOnlineBrowserMode(true);
  try {
    assert.deepEqual(feed.suppressedAt({ project: project(clips()), t: 1, playing: true }), ['b', 'g', 's', 'u'], '播放中一律抑制');
    feed.markAllSettled('front');
    const paused = feed.planFeed({ project: project(clips()), t: 1, playing: false });
    // 2026-10-06(online-card-exec-contract.md 第 6 节):构建时就在包里的用户卡本页能运行,停下照内置卡追精确、不再抑制
    assert.deepEqual(paused.scrub.sort(), ['g', 's'], '停下只剩本页运行不了的卡还进 scrub 占位');
    // 同步来的卡载入成功(运行状态 ready):不再一律按重,照分派表(表里没判它重)
    registry.setCardRunStates([['c10-synced-card', { state: 'ready', version: 'g1' }]]);
    assert.deepEqual(feed.suppressedAt({ project: project(clips()), t: 1, playing: true }), ['b', 'g', 'u'], '能运行的同步卡不再一律抑制');
    assert.deepEqual(feed.planFeed({ project: project(clips()), t: 1, playing: false }).scrub.sort(), ['g'], '停下它也追精确');
    registry.setCardRunStates([['c10-synced-card', { state: 'missing-module', detail: 'lodash' }]]);
    assert.deepEqual(feed.suppressedAt({ project: project(clips()), t: 1, playing: true }), ['b', 'g', 's', 'u'], '运行不了的照旧一律抑制');
    // 2026-10-21 用户定「暂停时渲染出精确的帧」:不按档另挡本页能运行的用户卡(原来按档挡的开关 2026-10-22 删掉),
    // 只有一个舞台时构建时的用户卡停下照内置卡追精确
    assert.deepEqual(feed.planFeed({ project: project(clips()), t: 1, playing: false, single: true }).scrub.sort(), ['g', 's'], '单舞台:构建时的用户卡停下也追精确');
  } finally {
    placeholder.setOnlineBrowserMode(false);
    registry.setCardRunStates([]);
  }
});

itUi('C10-UI-04 桌面（在线开关关着）用户卡、素材效果卡按分派表，同步表不影响桌面', async () => {
  const { f } = await feedOnce(false);
  assert.deepEqual(f.heavy, ['b', 'g', 'u'], '桌面按分派表:同步表不起作用(桌面也不设它)');
  assert.equal(f.heavy.includes('s'), false);
  feed.markAllSettled('front');
  assert.equal(feed.planFeed({ project: project(clips()), t: 1, playing: false }).scrub.length, 0, '桌面暂停态整台精确:一张不抑制');
});

itUi('C10-UI-05 双舞台同步卡变更为 ready 后自动重投 pumpFeed 与 localOnlyMissing（无需手动播放或跳转）', async () => {
  const previewSrc = fs.readFileSync(repoPath('src/editor/Preview.tsx'), 'utf8');
  assert.match(previewSrc, /onCardRunStatesChanged\(refresh\)/, 'Preview.tsx 应订阅 onCardRunStatesChanged 刷新抑制与缺失表');
  assert.match(previewSrc, /queueMicrotask\(\(\)\s*=>\s*\{\s*void pumpRef\.current\(\);\s*\}\)/, 'Preview.tsx 应在 planDispatch 微任务之后重投 pumpRef.current()');

  placeholder.setOnlineBrowserMode(true);
  try {
    const p = project([card('s', 'c10-synced-card')]);
    plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set() }] };
    // 初载时舞台 B 尚未报回 card-states，同步卡 s 仍属 localOnly，暂停在 t=0 时被抑制显示沙漏
    registry.setCardRunStates([['c10-synced-card', { state: 'loading' }]]);
    assert.deepEqual(feed.suppressedAt({ project: p, t: 0, playing: false }), ['s'], 'loading 期间暂停在 t=0 应抑制');

    let pumpedSuppressed = null;
    const offRun = registry.onCardRunStatesChanged(() => {
      queueMicrotask(() => {
        pumpedSuppressed = feed.suppressedAt({ project: p, t: 0, playing: false });
      });
    });
    try {
      registry.setCardRunStates([['c10-synced-card', { state: 'ready', version: 'g1' }]]);
      await new Promise((r) => queueMicrotask(r));
      assert.deepEqual(pumpedSuppressed, [], '变为 ready 后不经 seek/play 即解除抑制');
    } finally {
      offRun();
    }
  } finally {
    placeholder.setOnlineBrowserMode(false);
    registry.setCardRunStates([]);
  }
});

/* ------------------------------------------------------------------ 棘轮（K9） */

const ratchet = ratchetGate();
// account-binding-task.md / account-binding-contract.md：独立固定官网同源账号入口，
// editor/ 是动态拼接的产物字面量，不能使其它 editor 子路径获得许可。
/*
 * 网盘导入（`/api/media/storage/*`）在在线产物里**一条都不许有**，所以这一桶是空的。
 *
 * 经过：2026-10-24 合网盘连接器时，connect / disconnect / import 三条字面量进了在线产物，
 * 我当时在这里登记了三条把门弄绿——那是治标。这些口由**本机编辑器进程**发，在线页面没有对端，
 * 本来就不该打进在线产物。同日 `claude/drive-connector` 给了治本的改法（`src/editor/io/storageImport.ts`
 * 三个函数开头内联 `if (!storageImportSupported) throw …`，在线构建里那是编译期常量 false，
 * 打包器据此把代码连同字面量一并剪掉），于是这一桶清空。
 *
 * 空桶不是「不管」：下面的 `added` 判定把任何 `/api/media/storage/` 开头的路径都算成未许可，
 * 所以哪天它们又漏进在线产物，这道门立刻红——比登记三条更严。
 */
const STORAGE_PATHS = [];

const ACCOUNT_PATHS = [
  '/api/account/cloud-agent-consent',
  '/api/account/editor/', '/api/account/editor/renew', '/api/account/editor/session',
  '/api/account/login', '/api/account/logout', '/api/account/me', '/api/account/projects',
  // 2026-10-23 第三方登录（Google）：取开着哪几种方式（GET config）、登录与第一次注册（POST）。
  // 和上面八条同类，都是官网账号服务的接口；`src/online/apiGuard.ts` 里逐条精确放行、方法钉死，`third-party/unlink` 不放行
  '/api/account/third-party/config', '/api/account/third-party/login', '/api/account/third-party/register',
];
test('C10-RA-03 project members has one separate exact hosted path without enlarging the /api scanner set', () => {
  const list = JSON.parse(fs.readFileSync(repoPath(RATCHET_FILE), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(repoPath(RATCHET_BASELINE), 'utf8'));
  for (const source of [list, baseline]) {
    assert.deepEqual(source.projectAccountPaths, ['/hosted/shared/account/members']);
    assert.equal(source.paths.some(p => p.startsWith('/hosted/')), false);
  }
  assertRatchet(list.paths, baseline);
});
function assertRatchet(paths, baseline) {
  assert.ok(Array.isArray(paths), `${RATCHET_FILE} 应有 paths 数组`);
  assert.deepEqual(baseline.accountPaths, ACCOUNT_PATHS, '账号许可必须是固定8条，不能扩为前缀');
  assert.deepEqual(baseline.storagePaths, STORAGE_PATHS, '网盘路径一条都不许进在线产物');
  assert.equal(new Set(paths).size, paths.length, '清单里有重复');
  const legacy = new Set(baseline.paths);
  assert.ok(baseline.paths.every((p) => !p.startsWith('/api/account/')), '旧基线不能夹带账号许可');
  assert.ok(baseline.paths.every((p) => !p.startsWith('/api/media/storage/')), '旧基线不能夹带网盘许可');
  const added = paths.filter((p) => p.startsWith('/api/account/') ? !ACCOUNT_PATHS.includes(p)
    : p.startsWith('/api/media/storage/') ? !STORAGE_PATHS.includes(p)
    : !legacy.has(p));
  assert.deepEqual(added, [], `棘轮清单多出了未许可的路径：${added.join(', ')}`);
  assert.deepEqual(paths.filter((p) => p.startsWith('/api/account/')), ACCOUNT_PATHS, '账号产物清单逐条精确登记');
  assert.deepEqual(paths.filter((p) => p.startsWith('/api/media/storage/')), STORAGE_PATHS, '在线产物里不许出现网盘路径');
}
test('C10-RA-01 旧本机 /api 只减不增、账号入口固定11条、不重复', { skip: ratchet.ok ? false : ratchet.reason }, () => {
  const list = JSON.parse(fs.readFileSync(repoPath(RATCHET_FILE), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(repoPath(RATCHET_BASELINE), 'utf8'));
  assertRatchet(list.paths, baseline);
});
test('C10-RA-02 未知账号、恢复桌面账号入口、旧本机增项和重复仍拒绝', { skip: ratchet.ok ? false : ratchet.reason }, () => {
  const list = JSON.parse(fs.readFileSync(repoPath(RATCHET_FILE), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(repoPath(RATCHET_BASELINE), 'utf8'));
  for (const extra of ['/api/account/unknown', '/api/account/editor/login', '/api/account/editor/recover', '/api/ai/chat', '/api/new-local', '/api/media/storage/unknown', '/api/media/storage/config']) {
    assert.throws(() => assertRatchet([...list.paths, extra], baseline), { code: 'ERR_ASSERTION' });
  }
  assert.throws(() => assertRatchet([...list.paths, list.paths[0]], baseline), { code: 'ERR_ASSERTION' });
  assert.throws(() => assertRatchet(list.paths, { ...baseline, accountPaths: [...ACCOUNT_PATHS, '/api/account/unknown'] }), { code: 'ERR_ASSERTION' });
  assertRatchet(list.paths.filter((p) => p !== '/api/asset'), baseline); // 旧本机项可继续删除。
});
