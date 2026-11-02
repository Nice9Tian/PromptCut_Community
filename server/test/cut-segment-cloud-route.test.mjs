/**
 * Two Agent tools for cut segments take the cloud path (hosted tier executes on project replica,
 * `server/agent/ssr-host.mjs`):
 * Routing table connects directly to `EditorApi.addCutSegment` / `setCutSegment`; server replica
 * genuinely has these two methods; placement, offset modification, and cycle rejection all take
 * effect in replica store. Local path (editor tool executor) uses the same table and implementation,
 * see `src/mcp/handlers/cutSegments.test.mjs`.
 *
 * Run: node --test server/test/cut-segment-cloud-route.test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { CLOUD_TOOL_PLAN } from '../agent/service/cloud-tools.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

test('Cloud replica: add_cut_segment / set_cut_segment connect directly to their own EditorApi methods, placing, changing the offset, and rejecting cycles', { timeout: 120_000 }, async () => {
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const host = await loadSsrHost((id) => vite.ssrLoadModule(id));
    for (const tool of ['add_cut_segment', 'set_cut_segment']) assert.ok(CLOUD_TOOL_PLAN[tool], `${tool} has a classification in the cloud tool table`);
    assert.deepEqual([host.routeOf('add_cut_segment').method, host.routeOf('set_cut_segment').method], ['addCutSegment', 'setCutSegment']);
    host.resetStore();
    host.setProject({
      version: 1, id: 'p-cloud-cut', name: 't', width: 640, height: 360, fps: 30, duration: 20, themeId: 'midnight', media: [],
      tracks: [{ id: 'ta', name: 'Track 1', clips: [] }],
      cuts: [
        { id: 'A', name: 'Cut 1' },
        { id: 'B', name: 'Cut 2', tracks: [{ id: 'tb', name: 'Track 1', clips: [{ id: 'b1', cardId: 'x', start: 0, end: 6, params: {} }] }], duration: 6, transitions: [] },
      ],
      activeCutId: 'A',
    });
    const added = await host.callRoute('add_cut_segment', { name: 'Cut 2', start: 1, cutOffset: 1 });
    assert.equal(added.ok, true);
    assert.deepEqual([added.segment.cutId, added.segment.start, added.segment.end, added.segment.cutOffset], ['B', 1, 6, 1]);
    const placed = host.getProject().tracks[0].clips.find((c) => c.id === added.segment.clipId);
    assert.deepEqual([placed.cutId, placed.cutOffset], ['B', 1], 'The cut segment was really placed into the replica\'s project');
    await assert.rejects(() => host.callRoute('add_cut_segment', { cutId: 'A', start: 0 }), /inside itself/);
    const set = await host.callRoute('set_cut_segment', { clipId: added.segment.clipId, cutOffset: 3 });
    assert.deepEqual([set.segment.cutOffset, set.segment.end], [3, 4], 'The offset changed, and the out point is clamped to the length remaining in the referenced cut');
    await assert.rejects(() => host.callRoute('set_cut_segment', { clipId: added.segment.clipId, cutOffset: 9 }), /exceeds the total duration/);
    host.clearProject();
  } finally {
    await vite.close();
  }
});
