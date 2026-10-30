import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { projectTools } from '../../../server/tools/project.mjs';

test('018 local/LAN get_selection returns every selected clip and explicit missing IDs', async () => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { actions } = await vite.ssrLoadModule('/src/store/project.ts');
    const { createEmptyProject } = await vite.ssrLoadModule('/src/kernel/project.ts');
    const { projectHandlers } = await vite.ssrLoadModule('/src/mcp/handlers/project.ts');
    const project = createEmptyProject();
    project.tracks = [{ id: 'track', name: 'track', clips: [{ id: 'c1', start: 0, end: 1 }, { id: 'c2', start: 1, end: 2 }] }];
    actions.loadProject(project);
    actions.select(['c1', 'deleted', 'c2']);
    const result = projectHandlers.getSelection();
    assert.deepEqual(result.selection.clipIds, ['c1', 'deleted', 'c2']);
    assert.deepEqual(result.items.map(item => [item.id, item.trackId, item.missing]),
      [['c1', 'track', undefined], ['deleted', undefined, true], ['c2', 'track', undefined]]);
    actions.select([]);
    assert.deepEqual(projectHandlers.getSelection(), { selection: { clipIds: [] }, items: [] });
    const tool = projectTools.find(item => item.name === 'get_selection');
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
    assert.equal(tool.side, 'page', 'central cloud tool routing is a separate owner');
  } finally { await vite.close(); }
});
