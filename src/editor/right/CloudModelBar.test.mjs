/**
 * Rendered appearance of the cloud toolbar (CloudModelBar): model dropdown only appears when the
 * host configures multiple models; thinking effort dropdown only appears when the node reports
 * tiers; if the stored tier is not in the manifest, display "Default".
 * Run: node --test src/editor/right/CloudModelBar.test.mjs
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
    '../../kernel/creativity.mjs': { CREATIVITY_HINT: { high: '' }, CREATIVITY_LABEL: { high: 'High' }, CREATIVITY_LEVELS: ['high'],
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

test('CMB1 The node reported tiers: a thinking effort dropdown appears, "Default" comes first, and the labels are the same as local', async () => {
  const html = await render({ info: info({ efforts: ['low', 'medium', 'high'] }), effort: 'high', onEffort() {} });
  const effort = select(html, 'ai-cloud-effort');
  assert.ok(effort, 'There is a thinking effort dropdown');
  assert.deepEqual(options(effort), [['', 'Thinking default'], ['low', 'Thinking Low'], ['medium', 'Thinking Medium'], ['high', 'Thinking High']]);
  assert.match(effort, /<option value="high" selected="">/, 'The stored tier is selected');
});

test('CMB2 The node reports no tiers, or no callback is given: no thinking effort dropdown; a stored tier that is not in the list shows "Default"', async () => {
  assert.equal(select(await render({ info: info(), effort: 'high', onEffort() {} }), 'ai-cloud-effort'), null);
  assert.equal(select(await render({ info: info({ efforts: ['low'] }), effort: 'low' }), 'ai-cloud-effort'), null);
  const stale = select(await render({ info: info({ efforts: ['low', 'medium', 'high'] }), effort: 'max', onEffort() {} }), 'ai-cloud-effort');
  assert.match(stale, /<option value="" selected="">/);
});

test('CMB3 Model dropdown: appears only when two or more are configured, and the default entry says which one it is', async () => {
  assert.equal(select(await render({ info: info({ models: [{ id: 'a' }], defaultModel: 'a' }) }), 'ai-cloud-model'), null);
  const model = select(await render({ info: info({ models: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }], defaultModel: 'claude-sonnet-5-5' }),
    model: 'claude-opus-5-5' }), 'ai-cloud-model');
  assert.deepEqual(options(model), [['', 'Default(claude-sonnet-5-5)'], ['claude-sonnet-5-5', 'claude-sonnet-5-5'], ['claude-opus-5-5', 'claude-opus-5-5']]);
  assert.match(model, /<option value="claude-opus-5-5" selected="">/);
});
