/**
 * 素材效果卡的三个值构造器。文件是 .ts,但里面只有 `import type`,Node 自带的类型剥离
 * 能直接加载(试过 `import('./graphValues.ts')`),所以不用 vite。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitmap, draw, glsl } from './graphValues.ts';

test('glsl 把片元源码、输入和 uniform 拼成执行器认的 GlslValue', () => {
  const source = { type: 'source', nodeId: 'a', offset: 0, rate: 1 };
  const value = glsl('void main(){outColor=texture(u_input0,v_uv);}', [source], { amount: .5, tint: [1, 0, 0] });
  assert.equal(value.type, 'glsl');
  assert.deepEqual(value.inputs, [source]);
  assert.deepEqual(value.uniforms, { amount: .5, tint: [1, 0, 0] });
  // 不传就是空的,不是 undefined —— 执行器按 `value.inputs||[]` 走,两种都活,但空数组更好读
  assert.deepEqual(glsl('x').inputs, []);
  assert.deepEqual(glsl('x').uniforms, {});
});

test('draw 原样带着命令列表', () => {
  const commands = [{ type: 'solid', color: [0, 0, 0, 1] }];
  assert.deepEqual(draw(commands), { type: 'draw', commands });
});

test('bitmap 是 CPU 像素算法的出口', () => {
  const image = { width: 2, height: 2 };
  assert.deepEqual(bitmap(image), { type: 'bitmap', image });
});

test('默认 at 查询显式保留卡片源时间，裁切与输入映射不退回局部零点', async () => {
  const { sourceValueAt } = await import('./graphValues.ts');
  assert.deepEqual(sourceValueAt({ nodeId: 'm', offset: -1.5, rate: 1 }, 2.5), { type: 'source', nodeId: 'm', offset: -1.5, rate: 1, time: 2.5 });
  assert.equal(sourceValueAt({ nodeId: 'm' }, 2.5, 7).time, 7);
});
