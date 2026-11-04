/**
 * Page reports render environment (contract `docs/plan/render-queue-contract.md` F.4, test table F.5
 * W1-W2).
 * Run: node --experimental-test-module-mocks --test src/editor/pageEnvironment.test.mjs
 *
 * Written strictly according to contract F.4, without looking at implementation. The tested module
 * `src/editor/pageEnvironment.mjs` is newly created in F.4 and dynamically imported on demand:
 * if it does not exist, these test cases fail without affecting other files.
 *
 * Mock `navigator` / `document` / WebGL only implements calls specified in the contract:
 *   `document.createElement('canvas')`, `canvas.getContext('webgl2' | 'webgl')`,
 *   `gl.getExtension('WEBGL_debug_renderer_info' | 'WEBGL_lose_context')`, `gl.getParameter(...)`,
 *   `loseContext()`.
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
 * Mock WebGL environment. `contexts`: { webgl2?: glOptions, webgl?: glOptions }; types not provided
 * return null for getContext.
 * glOptions: { debug = true, unmasked = ['U-R', 'U-V'], masked = ['M-R', 'M-V'] }.
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

test('W1 reads four fields: platform / userAgent / renderer / vendor; userAgentData.platform takes priority; with a debug extension it reads UNMASKED_*, releases the context after reading, and the canvas is not attached to the document', async () => {
  const { readPageEnvironment } = await load();
  const { document, log } = fakeDom({ contexts: { webgl2: { unmasked: ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)', 'Google Inc. (NVIDIA)'] } } });
  const env = readPageEnvironment({ navigator: nav({ userAgentData: { platform: 'Windows' } }), document });
  assert.deepEqual(env, { platform: 'Windows', userAgent: UA, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)', vendor: 'Google Inc. (NVIDIA)' });
  assert.deepEqual(log.created, ['canvas']);
  assert.deepEqual(log.tried, ['webgl2'], 'Once webgl2 is obtained, webgl is not tried again');
  assert.ok(log.extensions.includes('WEBGL_debug_renderer_info'));
  assert.ok(log.params.includes(UNMASKED_RENDERER_WEBGL) && log.params.includes(UNMASKED_VENDOR_WEBGL));
  assert.equal(log.lost, 1, 'Released with WEBGL_lose_context after reading');
  assert.equal(log.appended, 0, 'the canvas is not attached to the document');
});

test('W1 how platform is obtained: userAgentData.platform → navigator.platform → empty string', async () => {
  const { readPageEnvironment } = await load();
  const run = navigator => readPageEnvironment({ navigator, document: fakeDom({ contexts: { webgl2: {} } }).document }).platform;
  assert.equal(run(nav({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' })), 'macOS', 'userAgentData takes priority');
  assert.equal(run(nav({ platform: 'MacIntel' })), 'MacIntel', 'No userAgentData');
  assert.equal(run(nav({ userAgentData: { platform: '' }, platform: 'Linux x86_64' })), 'Linux x86_64', 'When userAgentData.platform is an empty string, fall back to navigator.platform');
  assert.equal(run(nav({ userAgentData: {}, platform: 'Win32' })), 'Win32');
  assert.equal(run({ userAgent: UA }), '', 'Neither → empty string');
  assert.equal(readPageEnvironment({ navigator: { platform: 'Win32' }, document: fakeDom().document }).userAgent, '', 'No userAgent → empty string');
});

test('W1 try webgl when there is no webgl2; read RENDERER / VENDOR when there is no debug extension', async () => {
  const { readPageEnvironment } = await load();
  const a = fakeDom({ contexts: { webgl: { unmasked: ['U-only-webgl', 'U-V'] } } });
  const envA = readPageEnvironment({ navigator: nav(), document: a.document });
  assert.deepEqual([envA.renderer, envA.vendor], ['U-only-webgl', 'U-V']);
  assert.deepEqual(a.log.tried, ['webgl2', 'webgl'], 'Tried in order: webgl2, webgl');
  assert.equal(a.log.lost, 1);

  const b = fakeDom({ contexts: { webgl2: { debug: false, masked: ['WebKit WebGL', 'WebKit'] } } });
  const envB = readPageEnvironment({ navigator: nav(), document: b.document });
  assert.deepEqual([envB.renderer, envB.vendor], ['WebKit WebGL', 'WebKit'], 'No debug extension: gl.RENDERER / gl.VENDOR');
  assert.ok(b.log.params.includes(RENDERER) && b.log.params.includes(VENDOR));
  assert.ok(!b.log.params.includes(UNMASKED_RENDERER_WEBGL));
  assert.equal(b.log.lost, 1);
});

test('W1 pageEnvironment(): readPageEnvironment() cached once (reads navigator / document from globalThis)', async () => {
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
    assert.equal(log.created.length, 1, 'Read only once (the second time uses the cache and no longer creates a canvas)');
  } finally {
    for (const [name, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
  }
});

/* ================================================================== W2 */

test('W2 no WebGL (neither context type can be obtained): renderer / vendor are empty strings, no throw', async () => {
  const { readPageEnvironment } = await load();
  const { document, log } = fakeDom({ contexts: {} });
  const env = readPageEnvironment({ navigator: nav(), document });
  assert.deepEqual(env, { platform: 'Win32', userAgent: UA, renderer: '', vendor: '' });
  assert.deepEqual(log.tried, ['webgl2', 'webgl']);
});

test('W2 getContext throws, createElement throws, getParameter throws, or there is no document: returns empty strings, no throw; the other two fields are read as usual', async () => {
  const { readPageEnvironment } = await load();
  for (const [label, options] of [
    ['getContext throws', { contexts: { webgl2: {}, webgl: {} }, getContextThrows: true }],
    ['createElement throws', { contexts: { webgl2: {} }, createThrows: true }],
    ['getParameter throws', { contexts: { webgl2: {} }, getParameterThrows: true }],
  ]) {
    const { document } = fakeDom(options);
    let env;
    assert.doesNotThrow(() => { env = readPageEnvironment({ navigator: nav({ userAgentData: { platform: 'Windows' } }), document }); }, label);
    assert.deepEqual(env, { platform: 'Windows', userAgent: UA, renderer: '', vendor: '' }, label);
  }
  for (const [label, document] of [['document is undefined', undefined], ['document is null', null], ['empty object', {}]]) {
    let env;
    assert.doesNotThrow(() => { env = readPageEnvironment({ navigator: nav(), document }); }, label);
    assert.deepEqual(env, { platform: 'Win32', userAgent: UA, renderer: '', vendor: '' }, label);
  }
  // Does not throw even if navigator itself is missing
  let env;
  assert.doesNotThrow(() => { env = readPageEnvironment({ navigator: undefined, document: fakeDom().document }); });
  assert.deepEqual(env, { platform: '', userAgent: '', renderer: '', vendor: '' });
  // All four items are strings
  for (const value of Object.values(env)) assert.equal(typeof value, 'string');
});
