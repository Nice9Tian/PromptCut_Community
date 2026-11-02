/**
 * `server/vite-plugin-hosted-gate.ts`（构建扩展加载入口）与 `cloud/build/manifest.mjs` 的单测：
 * 云端构建加载表怎么找、找不到怎么办（接缝总纲 `docs/plan/community-boundary.md` 第一、二节，
 * 与 `server/test/docservice-extensions.test.mjs` 同形）。
 *
 * 模块在求值阶段就把表读完了（顶层 await），所以每个用例都用带查询串的动态 import 拿一份新的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(HERE, '..', '..');
// 社区版（公开仓库）里没有 cloud/：测闭源那一半的几条在那边跳过，和 agent-extensions 的 EXT1 同一个做法
const NO_CLOUD = fs.existsSync(path.join(ROOT_DIR, 'cloud')) ? false : 'The current checkout has no cloud/ directory (community edition)';
const ENTRY = path.join(HERE, '..', 'vite-plugin-hosted-gate.ts');
const CLOUD_RENDER_HOST = path.join(HERE, '..', '..', 'cloud', 'scripts', 'render-host.mjs');

/** 载一份新的 `vite-plugin-hosted-gate.ts`（绕开模块缓存，让顶层 await 重新跑一遍） */
async function loadFresh(tag) {
  return import(`${pathToFileURL(ENTRY).href}?case=${tag}`);
}

/** 造一个临时云端目录，里面放一张构建加载表 */
function makeCloudDir(keys) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-build-cloud-'));
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  const entries = Object.fromEntries(keys.map((k) => [k, { name: k }]));
  const body = `export const manifest = ${JSON.stringify(entries)};\nexport default manifest;\n`;
  fs.writeFileSync(path.join(dir, 'build', 'manifest.mjs'), body, 'utf8');
  return dir;
}

const withEnv = async (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PROMPTCUT_CLOUD_DIR');
  const old = process.env.PROMPTCUT_CLOUD_DIR;
  if (value === null) delete process.env.PROMPTCUT_CLOUD_DIR;
  else process.env.PROMPTCUT_CLOUD_DIR = value;
  try {
    return await fn();
  } finally {
    if (had) process.env.PROMPTCUT_CLOUD_DIR = old;
    else delete process.env.PROMPTCUT_CLOUD_DIR;
  }
};

test('BEXT1 with no environment variable set: looks under cloud/ at the repository root, and the six build extensions are found in this repository', { skip: NO_CLOUD }, async () => {
  const mod = await withEnv(null, () => loadFresh('default'));
  const table = mod.buildExtensions;
  assert.ok(table && typeof table === 'object' && !Array.isArray(table), 'The export should be an object');
  assert.deepEqual(
    Object.keys(table).sort(),
    ['hostedGate', 'hostedRender', 'mediaStorage', 'recoveryHttp', 'sourceGate', 'stageAllow'],
    'cloud/build/manifest.mjs in this repository should register these six build extensions',
  );
  const plugin = mod.hostedGatePlugin();
  assert.equal(plugin.name, 'promptcut-hosted-gate');
  assert.equal(typeof plugin.configureServer, 'function', 'With a cloud table, a real plugin with configureServer should be returned');
});

test('BEXT2 with the environment variable set: looks in the directory it points to, no longer at the repository root', async () => {
  const dir = makeCloudDir(['alphaGate', 'betaRoute']);
  try {
    const mod = await withEnv(dir, () => loadFresh('env'));
    assert.deepEqual(Object.keys(mod.buildExtensions), ['alphaGate', 'betaRoute']);
    assert.equal(mod.buildExtensions.alphaGate.name, 'alphaGate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BEXT3 pointed at a directory without a table: returns an empty object and hostedGatePlugin degrades to an empty plugin, does not throw. This is exactly the community edition case', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-build-nocloud-'));
  try {
    const mod = await withEnv(empty, () => loadFresh('missing'));
    assert.deepEqual(mod.buildExtensions, {}, 'When no table is found, no extension is attached, but it must not raise an error');
    const plugin = mod.hostedGatePlugin();
    assert.deepEqual(plugin, { name: 'promptcut-hosted-gate' }, 'Without a cloud directory, hostedGatePlugin degrades to a stub plugin');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('BEXT4 a table with the wrong shape (an array or a non-object) also returns an empty object, and the bad table is not handed to the build plugin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-build-badcloud-'));
  try {
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'manifest.mjs'), 'export default ["not an object"];\n', 'utf8');
    const mod = await withEnv(dir, () => loadFresh('bad'));
    assert.deepEqual(mod.buildExtensions, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BEXT5 the exported table is frozen: callers cannot modify it', async () => {
  const mod = await withEnv(null, () => loadFresh('frozen'));
  assert.ok(Object.isFrozen(mod.buildExtensions));
});

test('BEXT6 the render host entry moved into cloud/scripts/render-host.mjs imports only .mjs files and keeps the real finishTree cleanup', { skip: NO_CLOUD }, async () => {
  const src = fs.readFileSync(CLOUD_RENDER_HOST, 'utf8');
  assert.doesNotMatch(src, /\.ts['"]/, 'A production .mjs entry must not import .ts files');
  // A3 之后 hosted-render 也在 cloud/ 下，和 render-host.mjs 同一棵树：cloud/scripts → cloud/server
  assert.match(src, /from '\.\.\/server\/hosted-render\/worker\.mjs'/, 'Imports the real killTree from worker.mjs directly');
  const rh = await import(pathToFileURL(CLOUD_RENDER_HOST).href);
  assert.equal(typeof rh.finishTree, 'function');
  assert.equal(typeof rh.hostClaimStatusOf, 'function');
  const order = [];
  await rh.finishTree({
    killTree: () => order.push('kill'),
    sweepTree: () => order.push('sweep'),
    exited: Promise.resolve(0),
    waitMs: 5,
  });
  assert.deepEqual(order, ['kill', 'sweep']);
});

test('BEXT7 when the loader entry is copied to the system temp directory and evaluated there, it falls back to process.cwd() and can still find cloud/build/manifest.mjs', { skip: NO_CLOUD }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-build-tmpcopy-'));
  try {
    const tmpEntry = path.join(tmp, 'vite-plugin-hosted-gate.ts');
    fs.copyFileSync(ENTRY, tmpEntry);
    const mod = await withEnv(null, () => import(`${pathToFileURL(tmpEntry).href}?case=tmpcopy`));
    assert.deepEqual(
      Object.keys(mod.buildExtensions).sort(),
      ['hostedGate', 'hostedRender', 'mediaStorage', 'recoveryHttp', 'sourceGate', 'stageAllow'],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const NEWLINE = String.fromCharCode(10);

test('SEAM-VITE-01 every vite config attaches the browser-side cloud alias plugin', () => {
  // `cloudSeamsPlugin()` 把 `#promptcut-cloud-*` 解析到闭源加载表。漏挂在哪个配置上，那个构建就
  // 拿不到真实现（2026-10-27 漏在 vite.config.ts 的在线那份配置上，整个在线构建当场报
  // failed to resolve import）。现在 package.json 的 imports 兜了一层、最坏退化成社区版行为，
  // 但「本该是私有版却静默变成社区版」照样是 bug，所以仍然要钉住。
  // 不用正则：那个左方括号在正则里要转义，而本机写这个文件的工具会吃掉反斜杠（踩过四次）。
  // 直接按 'plugins:' 逐个找，再取到对应的 ']' 为止。
  const configs = ['vite.config.ts', 'vite.prerender.config.ts'];
  const missing = [];
  for (const rel of configs) {
    const src = fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');
    const starts = [];
    for (let at = src.indexOf('plugins:'); at !== -1; at = src.indexOf('plugins:', at + 1)) starts.push(at);
    assert.ok(starts.length > 0, rel + ' has no plugins array?');
    for (const m of starts.map((index) => ({ index }))) {
      const tail = src.slice(m.index, src.indexOf(']', m.index) + 1);
      if (!tail.includes('cloudSeamsPlugin(')) {
        const line = src.slice(0, m.index).split(NEWLINE).length;
        missing.push(rel + ':' + line + ' this plugins array has no cloudSeamsPlugin()');
      }
    }
  }
  assert.deepEqual(missing, [], 'These vite configs are missing cloudSeamsPlugin():' + NEWLINE + missing.join(NEWLINE));
});

test('SEAM-VITE-02 alias manifest: every alias the plugin recognizes must appear in the imports of package.json, none missing', () => {
  // 两边必须同步：插件负责指到闭源表，package.json 负责在**没挂插件的地方**兜到空桩
  // （探针自己起的 vite、raw Node）。只加插件不加兜底，那些地方就是硬失败 ——
  // 2026-10-28 审查实测：三个探针的浏览器侧 transform 直接 500、页面打不开，不是优雅降级。
  // 只加兜底不加插件，私有版会静默拿到社区版行为。所以这两张表必须逐项相等。
  const ALIAS_RE = new RegExp('"(#promptcut-cloud-[a-z-]+)"', 'g');
  const plugin = fs.readFileSync(path.join(ROOT_DIR, 'server', 'vite-plugin-cloud-seams.ts'), 'utf8');
  const fromPlugin = [...plugin.matchAll(ALIAS_RE)].map((m) => m[1]).sort();
  assert.ok(fromPlugin.length >= 4, 'Too few aliases recognized in the plugin:' + fromPlugin.join(', '));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const fromPkg = Object.keys(pkg.imports ?? {}).filter((k) => k.startsWith('#promptcut-cloud-')).sort();

  assert.deepEqual(
    fromPkg,
    fromPlugin,
    'The alias manifest in server/vite-plugin-cloud-seams.ts does not match the imports in package.json.' + NEWLINE +
      'Plugin:' + fromPlugin.join(', ') + NEWLINE + 'package.json:' + fromPkg.join(', ') + NEWLINE +
      'When adding an alias, add it in both places: the plugin points to the closed-source table, and imports falls back to an empty stub.',
  );

  // 兜底一律指空桩，不许出现任何闭源路径（package.json 是共享文件，不变量 1）
  for (const k of fromPkg) {
    assert.equal(
      pkg.imports[k],
      './src/community/cloudSeamStub.ts',
      k + ' must fall back to the empty stub; pointing at a closed-source path would make the shared file differ between the two sides and put the closed-source layout in the public repository',
    );
  }
});

test('SEAM-PRUNE-01 online build prune table: the entries exist, the criteria are still present, and it is attached only to the online config', async () => {
  // 这张表把「在线构建里运行期不可达」的桌面专用模块换成空桩，好让它们连同背后的 /api 调用
  // 一起不进产物（编译期常量做不到这件事，理由见 src/online/pageFlag.ts 的「在线构建剪枝」）。
  // 它的**前提**是那三处判据都是编译期常量；判据一变，这张表就可能在剪活代码。所以三样都要钉：
  const { PRUNED_MODULES } = await import('../vite-plugin-online-prune.ts');

  // 一、条目不许烂掉（CLOUD_FILES 刚因为八条死条目吃过苦头）
  const dead = PRUNED_MODULES.filter((rel) => !fs.existsSync(path.join(ROOT_DIR, rel)));
  assert.deepEqual(dead, [], 'These modules in the prune table no longer exist, so the table must be updated:' + dead.join(', '));

  // 二、判据还在。少了任何一条，就说明那个模块在在线构建里**可能已经可达**，
  //     继续剪它就是在剪活代码 —— 这时候该重新算一遍 importer 闭包，不是改这条测试。
  const premises = [
    ['src/editor/dock/DockPages.tsx', 'ONLINE_BUILD ? OnlineAgentSwitch : AiPanel', 'src/editor/right/AiPanel.tsx'],
    ['src/StartPage.tsx', 'ONLINE_BUILD ? OnlineStartPage : DesktopStartPage', 'src/start/DesktopStart.tsx'],
    ['src/mobile/AgentPage.tsx', '!ONLINE && !cloud.accountMode', 'src/mobile/AgentChatLocal.tsx'],
  ];
  for (const [file, premise, pruned] of premises) {
    assert.ok(PRUNED_MODULES.includes(pruned), pruned + ' is not in the prune table, but the assertions below still use its criterion');
    const text = fs.readFileSync(path.join(ROOT_DIR, file), 'utf8');
    assert.ok(
      text.includes(premise),
      file + ' does not contain the criterion `' + premise + '`. Pruning ' + pruned + ' presumes that this branch is, in the online build,' +
        'unreachable at runtime; if the criterion changes, the importer closure must be recomputed before deciding how to change this table.',
    );
  }

  // 三、只许挂在在线那份配置上。挂到桌面那份会把桌面版的 AI 栏和开始页一起剪掉。
  const vc = fs.readFileSync(path.join(ROOT_DIR, 'vite.config.ts'), 'utf8');
  const uses = vc.split('onlinePrunePlugin()').length - 1;
  assert.equal(uses, 1, 'onlinePrunePlugin() should appear only once in vite.config.ts (the online config)');
  assert.ok(
    vc.indexOf('onlinePrunePlugin()') > vc.indexOf('const onlineConfig'),
    'onlinePrunePlugin() appears before onlineConfig, meaning it was attached to the desktop config,' +
      'so the desktop app\'s AI panel and start page would be pruned along with it',
  );
  const pc = fs.readFileSync(path.join(ROOT_DIR, 'vite.prerender.config.ts'), 'utf8');
  assert.ok(!pc.includes('onlinePrunePlugin'), 'The prerender config must not be pruned: it runs on the desktop/host side');
});
