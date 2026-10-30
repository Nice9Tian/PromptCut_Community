import test from 'node:test';
import assert from 'node:assert/strict';

import { COST_DEVICE_SEPARATOR, costDeviceString, readGpuRenderer, resolveGlRoute, COST_DEVICE_COMPACT_FIELD } from './costDevice.mjs';
import { DEFAULT_TUNING, resolveTuning } from './pipelineTuning.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)';

const parts = (over = {}) => ({ ua: UA, renderer: RENDERER, compact: false, offscreenGl: true, mode: 'dev', ...over });

test('device 串就是 K1 / J4 那八段,顺序和写法钉死', () => {
  assert.equal(
    costDeviceString(parts()),
    [UA, RENDERER, 'lowMemory=false', 'offscreenGl=true', 'glRoute=perDocument', 'mode=dev', 'stepP=0.9', 'stepN=16'].join(' | '),
  );
  assert.equal(COST_DEVICE_SEPARATOR, ' | ');
});

test('两条路(离线探针 / 常驻探针)拼出来逐字节相同', () => {
  /*
   * 这一条钉的就是 R4a 报告 §8 第 10 条要的东西:同一份输入,谁调都一样。
   * 一边先 resolveTuning 过、另一边直接把 GET /api/data/costs 回来的裸覆盖值丢进来,
   * 结果仍然必须逐字节相同(resolveTuning 幂等)。
   */
  const offline = costDeviceString(parts({ tuning: resolveTuning({ STEP_PERCENTILE: 0.95 }) }));
  const inEditor = costDeviceString(parts({ tuning: { STEP_PERCENTILE: 0.95 } }));
  assert.equal(offline, inEditor);
  assert.equal(Buffer.compare(Buffer.from(offline, 'utf8'), Buffer.from(inEditor, 'utf8')), 0);
  assert.match(offline, /stepP=0\.95 \| stepN=16$/);
});

test('量法的两个系数进串,COST_SCALE 不进', () => {
  const base = costDeviceString(parts());
  // COST_SCALE 只影响怎么用这些数,不影响量出来的数本身 —— 改了它旧成绩照样能用
  assert.equal(costDeviceString(parts({ tuning: { COST_SCALE: 4 } })), base);
  // 量法变了旧记录必须不命中
  assert.notEqual(costDeviceString(parts({ tuning: { STEP_PERCENTILE: 1 } })), base);
  assert.notEqual(costDeviceString(parts({ tuning: { STEP_MIN_SAMPLES: 32 } })), base);
});

test('dev 和 build 各占一条记录', () => {
  assert.match(costDeviceString(parts({ mode: 'build' })), /\| mode=build \|/);
  assert.notEqual(costDeviceString(parts({ mode: 'build' })), costDeviceString(parts({ mode: 'dev' })));
  // 认不出来的值一律当 dev(R1 之前的记录全是 dev 量的)
  assert.equal(costDeviceString(parts({ mode: undefined })), costDeviceString(parts({ mode: 'dev' })));
  assert.equal(costDeviceString(parts({ mode: 'preview' })), costDeviceString(parts({ mode: 'dev' })));
});

test('glRoute 缺省路线 1(或调用方给的缺省),显式值优先;只有一个舞台写在历史字段名下,键与旧记录逐字节相同', () => {
  assert.equal(resolveGlRoute(null), 'perDocument');
  assert.equal(resolveGlRoute(null, 'shared'), 'shared', '在线页面把舞台闸门定的路线当缺省传');
  assert.equal(resolveGlRoute('perDocument', 'shared'), 'perDocument');
  assert.equal(resolveGlRoute('shared'), 'shared');
  assert.equal(resolveGlRoute('nonsense'), 'perDocument');
  assert.equal(COST_DEVICE_COMPACT_FIELD, 'lowMemory', '历史字段名不改:改了每台桌面版升级后都要把卡重测一遍');
  assert.match(costDeviceString(parts({ compact: true, glRoute: 'shared' })), /lowMemory=true \| offscreenGl=true \| glRoute=shared \|/);
  assert.match(costDeviceString(parts({ compact: true })), /glRoute=perDocument \|/, '不给路线就是路线 1(不再按只有一个舞台推)');
});

test('缺字段不抛:空 UA、unknown 显卡、全 false', () => {
  assert.equal(costDeviceString(undefined), costDeviceString({}));
  assert.equal(
    costDeviceString({}),
    ['', 'unknown', 'lowMemory=false', 'offscreenGl=false', 'glRoute=perDocument', 'mode=dev',
      `stepP=${DEFAULT_TUNING.STEP_PERCENTILE}`, `stepN=${DEFAULT_TUNING.STEP_MIN_SAMPLES}`].join(' | '),
  );
});

test('readGpuRenderer 在没有 document 的 Node 里回 unknown,不抛', () => {
  assert.equal(readGpuRenderer(null), 'unknown');
  assert.equal(readGpuRenderer({ createElement() { throw new Error('no dom'); } }), 'unknown');
  // 拿不到上下文(软件渲染 / --disable-gpu)也是 unknown
  assert.equal(readGpuRenderer({ createElement: () => ({ getContext: () => null }) }), 'unknown');
});

test('readGpuRenderer 读 UNMASKED_RENDERER_WEBGL,读完把上下文还回去', () => {
  let lost = 0;
  const gl = {
    getExtension: (name) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 }
      : name === 'WEBGL_lose_context' ? { loseContext: () => { lost++; } } : null),
    getParameter: (p) => (p === 37446 ? RENDERER : 'fallback'),
  };
  assert.equal(readGpuRenderer({ createElement: () => ({ getContext: (k) => (k === 'webgl2' ? gl : null) }) }), RENDERER);
  assert.equal(lost, 1);
});
