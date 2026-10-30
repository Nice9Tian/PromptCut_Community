/**
 * 剪辑段的两个 Agent 工具走云端那条路(托管档在项目副本上执行,`server/agent/ssr-host.mjs`):
 * 路由表直连 `EditorApi.addCutSegment` / `setCutSegment`,服务端副本上真的有这两个方法,
 * 放置、改偏移、拒绝循环都在副本的 store 里生效。本机那条路(编辑台的工具执行器)用同一张表、同一份实现,
 * 见 `src/mcp/handlers/cutSegments.test.mjs`。
 *
 * 跑:node --test server/test/cut-segment-cloud-route.test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { CLOUD_TOOL_PLAN } from '../agent/service/cloud-tools.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

test('云端副本:add_cut_segment / set_cut_segment 直连各自的 EditorApi 方法,放置、改偏移、拒绝循环', { timeout: 120_000 }, async () => {
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const host = await loadSsrHost((id) => vite.ssrLoadModule(id));
    for (const tool of ['add_cut_segment', 'set_cut_segment']) assert.ok(CLOUD_TOOL_PLAN[tool], `${tool} 在云端工具表里有归类`);
    assert.deepEqual([host.routeOf('add_cut_segment').method, host.routeOf('set_cut_segment').method], ['addCutSegment', 'setCutSegment']);
    host.resetStore();
    host.setProject({
      version: 1, id: 'p-cloud-cut', name: 't', width: 640, height: 360, fps: 30, duration: 20, themeId: 'midnight', media: [],
      tracks: [{ id: 'ta', name: '序列 1', clips: [] }],
      cuts: [
        { id: 'A', name: '剪辑1' },
        { id: 'B', name: '剪辑2', tracks: [{ id: 'tb', name: '序列 1', clips: [{ id: 'b1', cardId: 'x', start: 0, end: 6, params: {} }] }], duration: 6, transitions: [] },
      ],
      activeCutId: 'A',
    });
    const added = await host.callRoute('add_cut_segment', { name: '剪辑2', start: 1, cutOffset: 1 });
    assert.equal(added.ok, true);
    assert.deepEqual([added.segment.cutId, added.segment.start, added.segment.end, added.segment.cutOffset], ['B', 1, 6, 1]);
    const placed = host.getProject().tracks[0].clips.find((c) => c.id === added.segment.clipId);
    assert.deepEqual([placed.cutId, placed.cutOffset], ['B', 1], '副本的项目里真的放进了剪辑段');
    await assert.rejects(() => host.callRoute('add_cut_segment', { cutId: 'A', start: 0 }), /放进它自己/);
    const set = await host.callRoute('set_cut_segment', { clipId: added.segment.clipId, cutOffset: 3 });
    assert.deepEqual([set.segment.cutOffset, set.segment.end], [3, 4], '偏移改了,出点截到被引用剪辑剩下的长度');
    await assert.rejects(() => host.callRoute('set_cut_segment', { clipId: added.segment.clipId, cutOffset: 9 }), /超出/);
    host.clearProject();
  } finally {
    await vite.close();
  }
});
