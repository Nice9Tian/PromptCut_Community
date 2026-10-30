/**
 * 页面上报渲染环境（契约 `docs/plan/render-queue-contract.md` F.4，测试表 F.5 的 W1～W2）。
 * 跑：node --experimental-test-module-mocks --test src/editor/pageEnvironment.test.mjs
 *
 * 只照契约 F.4 写，不看实现。被测模块 `src/editor/pageEnvironment.mjs` 是 F.4 新建的，按需动态引入：
 * 它不存在时这几条用例失败，不影响别的文件。
 *
 * 假的 `navigator` / `document` / WebGL 只实现契约写明的调用：
 *   `document.createElement('canvas')`、`canvas.getContext('webgl2' | 'webgl')`、
 *   `gl.getExtension('WEBGL_debug_renderer_info' | 'WEBGL_lose_context')`、`gl.getParameter(...)`、`loseContext()`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('./pageEnvironment.mjs');

const UNMASKED_RENDERER_WEBGL = 0x9246;
const UNMASKED_VENDOR_WEBGL = 0x9245;
const RENDERER = 0x1F01;
const VENDOR = 0x1F00;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

/**
 * 假的 WebGL 环境。`contexts`：{ webgl2?: glOptions, webgl?: glOptions }，没给的类型 getContext 回 null。
 * glOptions：{ debug = true, unmasked = ['U-R', 'U-V'], masked = ['M-R', 'M-V'] }。
 */
function fakeDom({ contexts = {}, getContextThrows = false, createThrows = false, getParameterThrows = false } = {}) {
  const log = { created: [], tried: [], extensions: [], params: [], lost: 0, appended: 0 };
  const makeGl = ({ debug = true, unmasked = ['U-R', 'U-V'], masked = ['M-R', 'M-V'] } = {}) => ({
    RENDERER, VENDOR,
    getExtension(name) {
      log.extensions.push(name);
      if (name === 'WEBGL_debug_renderer_info') return debug ? { UNMASKED_RENDERER_WEBGL, UNMASKED_VENDOR_WEBGL } : null;
      if (name === 'WEBGL_lose_context') return { loseContext() { log.lost += 1; } };
      return null;
    },
    getParameter(p) {
      log.params.push(p);
      if (getParameterThrows) throw new Error('context lost');
      return ({ [UNMASKED_RENDERER_WEBGL]: unmasked[0], [UNMASKED_VENDOR_WEBGL]: unmasked[1], [RENDERER]: masked[0], [VENDOR]: masked[1] })[p] ?? null;
    },
  });
  const gls = Object.fromEntries(Object.entries(contexts).map(([type, options]) => [type, makeGl(options)]));
  const canvas = {
    width: 1, height: 1,
    getContext(type) {
      log.tried.push(type);
      if (getContextThrows) throw new Error('getContext blew up');
      return gls[type] ?? null;
    },
  };
  const body = { appendChild() { log.appended += 1; } };
  const document = {
    body, documentElement: body,
    createElement(tag) {
      log.created.push(tag);
      if (createThrows) throw new Error('no DOM');
      return canvas;
    },
  };
  return { document, log };
}
const nav = (over = {}) => ({ platform: 'Win32', userAgent: UA, ...over });

/* ================================================================== W1 */

test('W1 读出四项：platform / userAgent / renderer / vendor；userAgentData.platform 优先；有 debug 扩展读 UNMASKED_*、读完释放上下文、canvas 不挂进文档', async () => {
  const { readPageEnvironment } = await load();
  const { document, log } = fakeDom({ contexts: { webgl2: { unmasked: ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)', 'Google Inc. (NVIDIA)'] } } });
  const env = readPageEnvironment({ navigator: nav({ userAgentData: { platform: 'Windows' } }), document });
  assert.deepEqual(env, { platform: 'Windows', userAgent: UA, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)', vendor: 'Google Inc. (NVIDIA)' });
  assert.deepEqual(log.created, ['canvas']);
  assert.deepEqual(log.tried, ['webgl2'], 'webgl2 拿到了就不再试 webgl');
  assert.ok(log.extensions.includes('WEBGL_debug_renderer_info'));
  assert.ok(log.params.includes(UNMASKED_RENDERER_WEBGL) && log.params.includes(UNMASKED_VENDOR_WEBGL));
  assert.equal(log.lost, 1, '读完用 WEBGL_lose_context 释放');
  assert.equal(log.appended, 0, 'canvas 不挂进文档');
});

test('W1 platform 的取法：userAgentData.platform → navigator.platform → 空串', async () => {
  const { readPageEnvironment } = await load();
  const run = navigator => readPageEnvironment({ navigator, document: fakeDom({ contexts: { webgl2: {} } }).document }).platform;
  assert.equal(run(nav({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' })), 'macOS', 'userAgentData 优先');
  assert.equal(run(nav({ platform: 'MacIntel' })), 'MacIntel', '没有 userAgentData');
  assert.equal(run(nav({ userAgentData: { platform: '' }, platform: 'Linux x86_64' })), 'Linux x86_64', 'userAgentData.platform 为空串时退到 navigator.platform');
  assert.equal(run(nav({ userAgentData: {}, platform: 'Win32' })), 'Win32');
  assert.equal(run({ userAgent: UA }), '', '都没有 → 空串');
  assert.equal(readPageEnvironment({ navigator: { platform: 'Win32' }, document: fakeDom().document }).userAgent, '', '没有 userAgent → 空串');
});

test('W1 没有 webgl2 时试 webgl；没有 debug 扩展时读 RENDERER / VENDOR', async () => {
  const { readPageEnvironment } = await load();
  const a = fakeDom({ contexts: { webgl: { unmasked: ['U-only-webgl', 'U-V'] } } });
  const envA = readPageEnvironment({ navigator: nav(), document: a.document });
  assert.deepEqual([envA.renderer, envA.vendor], ['U-only-webgl', 'U-V']);
  assert.deepEqual(a.log.tried, ['webgl2', 'webgl'], '依次试 webgl2、webgl');
  assert.equal(a.log.lost, 1);

  const b = fakeDom({ contexts: { webgl2: { debug: false, masked: ['WebKit WebGL', 'WebKit'] } } });
  const envB = readPageEnvironment({ navigator: nav(), document: b.document });
  assert.deepEqual([envB.renderer, envB.vendor], ['WebKit WebGL', 'WebKit'], '没有 debug 扩展：gl.RENDERER / gl.VENDOR');
  assert.ok(b.log.params.includes(RENDERER) && b.log.params.includes(VENDOR));
  assert.ok(!b.log.params.includes(UNMASKED_RENDERER_WEBGL));
  assert.equal(b.log.lost, 1);
});

test('W1 pageEnvironment()：缓存一次的 readPageEnvironment()（读 globalThis 的 navigator / document）', async () => {
  const { pageEnvironment } = await load();
  const { document, log } = fakeDom({ contexts: { webgl2: { unmasked: ['G-R', 'G-V'] } } });
  const saved = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  Object.defineProperty(globalThis, 'navigator', { value: nav({ userAgentData: { platform: 'Windows' } }), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
  try {
    const first = pageEnvironment();
    assert.deepEqual(first, { platform: 'Windows', userAgent: UA, renderer: 'G-R', vendor: 'G-V' });
    const second = pageEnvironment();
    assert.deepEqual(second, first);
    assert.equal(log.created.length, 1, '只读一次（第二次用缓存，不再建 canvas）');
  } finally {
    for (const [name, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
  }
});

/* ================================================================== W2 */

test('W2 没有 WebGL（两种上下文都拿不到）：renderer / vendor 为空串，不抛', async () => {
  const { readPageEnvironment } = await load();
  const { document, log } = fakeDom({ contexts: {} });
  const env = readPageEnvironment({ navigator: nav(), document });
  assert.deepEqual(env, { platform: 'Win32', userAgent: UA, renderer: '', vendor: '' });
  assert.deepEqual(log.tried, ['webgl2', 'webgl']);
});

test('W2 getContext 抛出、createElement 抛出、getParameter 抛出、没有 document：回空串，不抛；其余两项照读', async () => {
  const { readPageEnvironment } = await load();
  for (const [label, options] of [
    ['getContext 抛出', { contexts: { webgl2: {}, webgl: {} }, getContextThrows: true }],
    ['createElement 抛出', { contexts: { webgl2: {} }, createThrows: true }],
    ['getParameter 抛出', { contexts: { webgl2: {} }, getParameterThrows: true }],
  ]) {
    const { document } = fakeDom(options);
    let env;
    assert.doesNotThrow(() => { env = readPageEnvironment({ navigator: nav({ userAgentData: { platform: 'Windows' } }), document }); }, label);
    assert.deepEqual(env, { platform: 'Windows', userAgent: UA, renderer: '', vendor: '' }, label);
  }
  for (const [label, document] of [['document 为 undefined', undefined], ['document 为 null', null], ['空对象', {}]]) {
    let env;
    assert.doesNotThrow(() => { env = readPageEnvironment({ navigator: nav(), document }); }, label);
    assert.deepEqual(env, { platform: 'Win32', userAgent: UA, renderer: '', vendor: '' }, label);
  }
  // navigator 本身缺失也不抛
  let env;
  assert.doesNotThrow(() => { env = readPageEnvironment({ navigator: undefined, document: fakeDom().document }); });
  assert.deepEqual(env, { platform: '', userAgent: '', renderer: '', vendor: '' });
  // 四项都是字符串
  for (const value of Object.values(env)) assert.equal(typeof value, 'string');
});
