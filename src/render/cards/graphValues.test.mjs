/**
 * Three value constructors for media effect cards. The file is .ts, but contains only `import type`;
 * Node's built-in type stripping can load it directly (tested `import('./graphValues.ts')`),
 * so vite is not needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitmap, draw, glsl } from './graphValues.ts';

test('glsl assembles the fragment source, inputs and uniforms into the GlslValue the executor recognizes', () => {
  const source = { type: 'source', nodeId: 'a', offset: 0, rate: 1 };
  const value = glsl('void main(){outColor=texture(u_input0,v_uv);}', [source], { amount: .5, tint: [1, 0, 0] });
  assert.equal(value.type, 'glsl');
  assert.deepEqual(value.inputs, [source]);
  assert.deepEqual(value.uniforms, { amount: .5, tint: [1, 0, 0] });
  // Omitted means empty, not undefined: the executor uses `value.inputs||[]`, both work,
  // but an empty array is easier to read
  assert.deepEqual(glsl('x').inputs, []);
  assert.deepEqual(glsl('x').uniforms, {});
});

test('draw carries the command list through as is', () => {
  const commands = [{ type: 'solid', color: [0, 0, 0, 1] }];
  assert.deepEqual(draw(commands), { type: 'draw', commands });
});

test('bitmap is the output of CPU pixel algorithms', () => {
  const image = { width: 2, height: 2 };
  assert.deepEqual(bitmap(image), { type: 'bitmap', image });
});

test('The default at query explicitly preserves the card source time; trimming and input mapping do not fall back to the local zero point', async () => {
  const { sourceValueAt } = await import('./graphValues.ts');
  assert.deepEqual(sourceValueAt({ nodeId: 'm', offset: -1.5, rate: 1 }, 2.5), { type: 'source', nodeId: 'm', offset: -1.5, rate: 1, time: 2.5 });
  assert.equal(sourceValueAt({ nodeId: 'm' }, 2.5, 7).time, 7);
});
