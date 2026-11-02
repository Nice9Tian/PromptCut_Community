import test from 'node:test';
import assert from 'node:assert/strict';

import { COST_DEVICE_SEPARATOR, costDeviceString, readGpuRenderer, resolveGlRoute, COST_DEVICE_COMPACT_FIELD } from './costDevice.mjs';
import { DEFAULT_TUNING, resolveTuning } from './pipelineTuning.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)';

const parts = (over = {}) => ({ ua: UA, renderer: RENDERER, compact: false, offscreenGl: true, mode: 'dev', ...over });

test('the device string is exactly the eight segments of K1 / J4, order and format pinned down', () => {
  assert.equal(
    costDeviceString(parts()),
    [UA, RENDERER, 'lowMemory=false', 'offscreenGl=true', 'glRoute=perDocument', 'mode=dev', 'stepP=0.9', 'stepN=16'].join(' | '),
  );
  assert.equal(COST_DEVICE_SEPARATOR, ' | ');
});

test('the two paths (offline probe / resident probe) produce byte-identical strings', () => {
  /*
   * This nails down what R4a report §8 item 10 asks for: same input yields the same result no
   * matter who calls it. One side calls resolveTuning first, the other directly passes raw override
   * values returned from GET /api/data/costs; results must still be byte-for-byte identical
   * (resolveTuning is idempotent).
   */
  const offline = costDeviceString(parts({ tuning: resolveTuning({ STEP_PERCENTILE: 0.95 }) }));
  const inEditor = costDeviceString(parts({ tuning: { STEP_PERCENTILE: 0.95 } }));
  assert.equal(offline, inEditor);
  assert.equal(Buffer.compare(Buffer.from(offline, 'utf8'), Buffer.from(inEditor, 'utf8')), 0);
  assert.match(offline, /stepP=0\.95 \| stepN=16$/);
});

test('the two measurement coefficients go into the string, COST_SCALE does not', () => {
  const base = costDeviceString(parts());
  // COST_SCALE only affects how these numbers are used, not the measured numbers themselves:
  // changing it still allows old scores to be used
  assert.equal(costDeviceString(parts({ tuning: { COST_SCALE: 4 } })), base);
  // When measurement method changes, old records must not hit
  assert.notEqual(costDeviceString(parts({ tuning: { STEP_PERCENTILE: 1 } })), base);
  assert.notEqual(costDeviceString(parts({ tuning: { STEP_MIN_SAMPLES: 32 } })), base);
});

test('dev and build each take one record', () => {
  assert.match(costDeviceString(parts({ mode: 'build' })), /\| mode=build \|/);
  assert.notEqual(costDeviceString(parts({ mode: 'build' })), costDeviceString(parts({ mode: 'dev' })));
  // Unrecognized values are treated as dev (records prior to R1 were all measured in dev)
  assert.equal(costDeviceString(parts({ mode: undefined })), costDeviceString(parts({ mode: 'dev' })));
  assert.equal(costDeviceString(parts({ mode: 'preview' })), costDeviceString(parts({ mode: 'dev' })));
});

test('glRoute defaults to route 1 (or the caller\'s default), an explicit value takes priority; with only one stage it is written under the legacy field name, and the key is byte-identical to old records', () => {
  assert.equal(resolveGlRoute(null), 'perDocument');
  assert.equal(resolveGlRoute(null, 'shared'), 'shared', 'the online page passes the route decided by the stage gate as the default');
  assert.equal(resolveGlRoute('perDocument', 'shared'), 'perDocument');
  assert.equal(resolveGlRoute('shared'), 'shared');
  assert.equal(resolveGlRoute('nonsense'), 'perDocument');
  assert.equal(COST_DEVICE_COMPACT_FIELD, 'lowMemory', 'do not change the legacy field name: changing it would force every desktop app to retest its cards after upgrading');
  assert.match(costDeviceString(parts({ compact: true, glRoute: 'shared' })), /lowMemory=true \| offscreenGl=true \| glRoute=shared \|/);
  assert.match(costDeviceString(parts({ compact: true })), /glRoute=perDocument \|/, 'no route given means route 1 (no longer inferred from having only one stage)');
});

test('missing fields do not throw: empty UA, unknown GPU, all false', () => {
  assert.equal(costDeviceString(undefined), costDeviceString({}));
  assert.equal(
    costDeviceString({}),
    ['', 'unknown', 'lowMemory=false', 'offscreenGl=false', 'glRoute=perDocument', 'mode=dev',
      `stepP=${DEFAULT_TUNING.STEP_PERCENTILE}`, `stepN=${DEFAULT_TUNING.STEP_MIN_SAMPLES}`].join(' | '),
  );
});

test('readGpuRenderer returns unknown in Node without a document, does not throw', () => {
  assert.equal(readGpuRenderer(null), 'unknown');
  assert.equal(readGpuRenderer({ createElement() { throw new Error('no dom'); } }), 'unknown');
  // If context cannot be obtained (software rendering / --disable-gpu), it is also unknown
  assert.equal(readGpuRenderer({ createElement: () => ({ getContext: () => null }) }), 'unknown');
});

test('readGpuRenderer reads UNMASKED_RENDERER_WEBGL, then returns the context when done', () => {
  let lost = 0;
  const gl = {
    getExtension: (name) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 }
      : name === 'WEBGL_lose_context' ? { loseContext: () => { lost++; } } : null),
    getParameter: (p) => (p === 37446 ? RENDERER : 'fallback'),
  };
  assert.equal(readGpuRenderer({ createElement: () => ({ getContext: (k) => (k === 'webgl2' ? gl : null) }) }), RENDERER);
  assert.equal(lost, 1);
});
