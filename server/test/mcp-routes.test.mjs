/**
 * Reconciliation between route table (src/mcp/routes.mjs) and tools table (server/mcp-tools.mjs).
 *
 * Adding an MCP tool requires registration in three places: tools table schema, this route table,
 * and src/mcp/handlers implementation. Missing the latter two causes compilation failure (EditorApi
 * cannot be assembled / method names do not match), but **a mismatch between tools table and route
 * table does not**: it only reports "Unknown tool" when model actually calls that tool, by which
 * time a task has already been ruined. Two tools were lost this way during the last refactor.
 * Both sides are locked down here: any extra or missing tool fails immediately.
 *
 * How to run: node --test server/test/mcp-routes.test.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tools as mcpTools } from '../mcp-tools.mjs';
import { TOOL_ROUTES, SPECIAL_TOOLS } from '../../src/mcp/routes.mjs';

const EXECUTOR = readFileSync(new URL('../../src/ai/mcpExecutor.ts', import.meta.url), 'utf8');
// Tools handled by page executor: side is page (page only) and agent (executed on Agent server
// when project replica exists, through page as usual when absent; C6.5 D1)
const browserTools = mcpTools.filter((t) => t.side === 'page' || t.side === 'agent').map((t) => t.name);
const routed = Object.keys(TOOL_ROUTES);

test('Every browser tool is either in the route table or in the list of special branches outside the table', () => {
  const handled = new Set([...routed, ...SPECIAL_TOOLS]);
  const missing = browserTools.filter((n) => !handled.has(n));
  assert.deepEqual(missing, [], `Unregistered tools: ${missing.join(', ')}`);
});

test('The route table has no names that do not exist in the tool table', () => {
  const declared = new Set(mcpTools.map((t) => t.name));
  const orphans = routed.filter((n) => !declared.has(n));
  assert.deepEqual(orphans, [], `Extra names in the route table: ${orphans.join(', ')}`);
});

test('The list of special branches outside the table also has no names that do not exist in the tool table', () => {
  const declared = new Set(mcpTools.map((t) => t.name));
  const orphans = SPECIAL_TOOLS.filter((n) => !declared.has(n));
  assert.deepEqual(orphans, [], `Extra names in the special-branch list: ${orphans.join(', ')}`);
});

test('The route table and the special branches do not overlap, and both hold only browser-side tools', () => {
  const dup = routed.filter((n) => SPECIAL_TOOLS.includes(n));
  assert.deepEqual(dup, [], 'The same tool cannot both use the table and take a special branch');
  const browser = new Set(browserTools);
  assert.deepEqual([...routed, ...SPECIAL_TOOLS].filter((n) => !browser.has(n)), [], 'Server-side tools do not go through the editor');
});

/**
 * Method names in route table must actually exist on EditorApi. routes.mjs is a pure data .mjs (so
 * this test can directly import it), and TypeScript only sees its .d.mts declaration, not what
 * strings are written inside: mistyped method names will not report compilation errors. So this
 * test checks directly against EditorApi declarations.
 */
test('Every method name in the route table exists on EditorApi', () => {
  const start = EXECUTOR.indexOf('export interface EditorApi {');
  assert.ok(start >= 0, 'Cannot find the declaration of EditorApi');
  const body = EXECUTOR.slice(start, EXECUTOR.indexOf('\n}', start));
  const declared = new Set([...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*)\(/gm)].map((m) => m[1]));
  assert.ok(declared.size > 100, `Only ${declared.size} methods were parsed from EditorApi, so the parsing is probably wrong`);
  const bad = routed.filter((n) => !declared.has(TOOL_ROUTES[n].method));
  assert.deepEqual(bad, [], `Method names that do not exist on EditorApi: ${bad.map((n) => `${n} → ${TOOL_ROUTES[n].method}`).join(', ')}`);
});

test('passArgs / awaited of every entry are booleans', () => {
  const bad = routed.filter((n) => typeof TOOL_ROUTES[n].passArgs !== 'boolean' || typeof TOOL_ROUTES[n].awaited !== 'boolean');
  assert.deepEqual(bad, []);
});

/**
 * Special branches are "deliberately left off the table", not "forgotten to register". They must
 * have real branches in the executor.
 */
test('Every special branch outside the table has a place in the executor that actually handles it', () => {
  const missing = SPECIAL_TOOLS.filter((n) =>
    n.startsWith('web_')
      ? !EXECUTOR.includes(`case "${n}":`)
      : !EXECUTOR.includes(`tool === "${n}"`));
  assert.deepEqual(missing, [], `Tools in the special-branch list that have no branch in the executor: ${missing.join(', ')}`);
  assert.ok(EXECUTOR.includes('tool.startsWith("web_")'), 'web_* is dispatched by prefix; without this line all eight web tools would be lost');
});

test('The error message for an unknown tool name is unchanged', () => {
  assert.ok(EXECUTOR.includes('throw new Error(trText("Unknown tool: {0}", tool))'), 'The Agent and the tests both rely on this message text to recognize "this tool does not exist"');
});
