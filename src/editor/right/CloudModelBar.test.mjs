/**
 * 云端工具条(CloudModelBar)渲染出来的样子:模型下拉在托管方配了多个模型时才有;思考强度下拉在节点报了档位时才有,
 * 存着的档位不在清单里就显示「默认」。跑:node --test src/editor/right/CloudModelBar.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { EFFORT_LABEL } from '../../ai/modelOptions.ts';

async function render(props) {
  const source = await fs.readFile(new URL('./CloudModelBar.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const actualRequire = createRequire(import.meta.url);
  const mocks = {
    '../../ai/agentTabs': { setTabCreativity() {}, useAgentTabs: () => ({ tabs: [] }) },
    '../../ai/liveChat': { MAIN_TAB: 'main' },
    '../../store/project': { useStore: select => select({ project: null }) },
    '../../kernel/creativity.mjs': { CREATIVITY_HINT: { high: '' }, CREATIVITY_LABEL: { high: '高' }, CREATIVITY_LEVELS: ['high'],
      normalizeCreativity: v => v || null, projectCreativity: () => 'high' },
    '../../ui/icons': { IconMore: () => null },
    './chat/usePopover': { usePopover: () => ({ anchorRef: { current: null }, open: false, toggle() {} }) },
    '../../ai/modelOptions': { EFFORT_LABEL },
    './ModelBar.css': {},
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(id => Object.hasOwn(mocks, id) ? mocks[id] : actualRequire(id), mod, mod.exports);
  return renderToStaticMarkup(React.createElement(mod.exports.CloudModelBar, { model: '', onModel() {}, ...props }));
}
const info = extra => ({ enabled: true, models: [], defaultModel: null, running: [], limits: {}, ...extra });
const select = (html, pc) => html.match(new RegExp(`<select[^>]*data-pc="${pc}"[\\s\\S]*?</select>`))?.[0] ?? null;
const options = html => [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(m => [m[1], m[2]]);

test('CMB1 节点报了档位:出思考强度下拉,「默认」在最前,标签与本机相同', async () => {
  const html = await render({ info: info({ efforts: ['low', 'medium', 'high'] }), effort: 'high', onEffort() {} });
  const effort = select(html, 'ai-cloud-effort');
  assert.ok(effort, '有思考强度下拉');
  assert.deepEqual(options(effort), [['', '思考 默认'], ['low', '思考 低'], ['medium', '思考 中'], ['high', '思考 高']]);
  assert.match(effort, /<option value="high" selected="">/, '选中存着的档位');
});

test('CMB2 节点没报档位、或不给回调:不出思考强度下拉;存着的档位不在清单里显示「默认」', async () => {
  assert.equal(select(await render({ info: info(), effort: 'high', onEffort() {} }), 'ai-cloud-effort'), null);
  assert.equal(select(await render({ info: info({ efforts: ['low'] }), effort: 'low' }), 'ai-cloud-effort'), null);
  const stale = select(await render({ info: info({ efforts: ['low', 'medium', 'high'] }), effort: 'max', onEffort() {} }), 'ai-cloud-effort');
  assert.match(stale, /<option value="" selected="">/);
});

test('CMB3 模型下拉:配了两个及以上才出现,缺省一项写明是哪个', async () => {
  assert.equal(select(await render({ info: info({ models: [{ id: 'a' }], defaultModel: 'a' }) }), 'ai-cloud-model'), null);
  const model = select(await render({ info: info({ models: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }], defaultModel: 'claude-sonnet-5-5' }),
    model: 'claude-opus-5-5' }), 'ai-cloud-model');
  assert.deepEqual(options(model), [['', '默认(claude-sonnet-5-5)'], ['claude-sonnet-5-5', 'claude-sonnet-5-5'], ['claude-opus-5-5', 'claude-opus-5-5']]);
  assert.match(model, /<option value="claude-opus-5-5" selected="">/);
});
