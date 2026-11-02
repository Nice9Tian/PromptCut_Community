/**
 * Unit tests for `server/vite-plugin-hosted-gate.ts` (build extension loading entrypoint) and
 * `cloud/build/manifest.mjs`: how cloud build manifest tables are located and handled when missing
 * (seams overview `docs/plan/community-boundary.md` sections 1 and 2, isomorphic with
 * `server/test/docservice-extensions.test.mjs`).
 *
 * The module reads the entire table during evaluation (top-level await), so each test case uses
 * a dynamic import with a query string to get a fresh copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(HERE, '..', '..');
// Community edition (public repo) has no cloud/: tests for the closed-source half are skipped
// there, matching the approach in agent-extensions EXT1
const NO_CLOUD = fs.existsSync(path.join(ROOT_DIR, 'cloud')) ? false : 'The current checkout has no cloud/ directory (community edition)';
const ENTRY = path.join(HERE, '..', 'vite-plugin-hosted-gate.ts');
const CLOUD_RENDER_HOST = path.join(HERE, '..', '..', 'cloud', 'scripts', 'render-host.mjs');

/** Load a fresh `vite-plugin-hosted-gate.ts` (bypasses module cache to re-run top-level await) */
async function loadFresh(tag) {
  return import(`${pathToFileURL(ENTRY).href}?case=${tag}`);
}

/** Create a temporary cloud directory with a build manifest table inside */
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
  // After A3, hosted-render is also under cloud/, in the same tree as render-host.mjs: cloud/scripts -> cloud/server
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
  // `cloudSeamsPlugin()` resolves `#promptcut-cloud-*` to the closed-source manifest table. If omitted
  // on any config, that build fails to get the real implementation (on 2026-10-27, omitted on the
  // online config in vite.config.ts, causing the entire online build to immediately fail with
  // "failed to resolve import"). Currently package.json imports provide a fallback layer, at worst
  // degrading to community edition behavior, but "silently becoming community edition when it should
  // be private edition" is still a bug, so it must still be pinned down.
  // Do not use regex: the opening bracket requires escaping in regex, and the local tool writing
  // this file eats backslashes (bitten four times). Directly find 'plugins:' one by one, then take
  // up to the matching ']'.
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
  // Both sides must stay synchronized: plugin points to the closed-source table, while package.json
  // provides fallback stubs **where plugins are not attached** (vite launched by probes themselves,
  // raw Node). Adding only the plugin without fallbacks causes hard failures in those places:
  // actual review on 2026-10-28 showed browser-side transform in three probes failed directly with 500
  // and pages could not open, not a graceful downgrade. Adding only fallbacks without the plugin
  // causes the private edition to silently get community edition behavior. Therefore, both tables
  // must match item by item.
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

  // Fallbacks must always point to empty stubs; no closed-source paths allowed (package.json is a shared file, Invariant 1)
  for (const k of fromPkg) {
    assert.equal(
      pkg.imports[k],
      './src/community/cloudSeamStub.ts',
      k + ' must fall back to the empty stub; pointing at a closed-source path would make the shared file differ between the two sides and put the closed-source layout in the public repository',
    );
  }
});

test('SEAM-PRUNE-01 online build prune table: the entries exist, the criteria are still present, and it is attached only to the online config', async () => {
  // This table replaces desktop-only modules that are "runtime-unreachable in online builds" with empty
  // stubs, keeping them and their underlying /api calls out of build artifacts (compile-time constants
  // cannot achieve this; see "Online build pruning" in src/online/pageFlag.ts for reasons).
  // Its **premise** is that all three criteria are compile-time constants; if criteria change, this
  // table might prune live code. Therefore, all three items must be pinned down:
  const { PRUNED_MODULES } = await import('../vite-plugin-online-prune.ts');

  // 1. Entries must not go stale (CLOUD_FILES just suffered from eight dead entries)
  const dead = PRUNED_MODULES.filter((rel) => !fs.existsSync(path.join(ROOT_DIR, rel)));
  assert.deepEqual(dead, [], 'These modules in the prune table no longer exist, so the table must be updated:' + dead.join(', '));

  // 2. Criteria must remain intact. If any is missing, that module **might already be reachable** in
  //    online builds, and pruning it means pruning live code: at that point, recompute the importer
  //    closure instead of changing this test.
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

  // 3. May only attach to the online config. Attaching to desktop would prune the desktop AI panel and start page.
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
