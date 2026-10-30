import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_OPEN_TOOLS, CLOUD_SYSTEM_NOTE, CLOUD_TOOL_PLAN, checkCloudTool } from '../agent/service/cloud-tools.mjs';
import { buildTools } from '../harness/tools/index.mjs';
import { project, script, startKit } from './cloud-agent-kit.mjs';

const alice = { projectId: 'p-spawn-disabled', userId: 'alice@device', username: 'alice', deviceName: 'device', creator: true };
const PAGE = 'pg-0123456789abcdef';
const hold = () => script([{ sleepMs: 20_000 }, { say: 'done' }]);

test('hosted spawn_agent is hidden and consistently rejected without page or run side effects', async (t) => {
  assert.equal(CLOUD_OPEN_TOOLS.has('spawn_agent'), false);
  assert.deepEqual(checkCloudTool('spawn_agent'), {
    ok: false, cloudUnavailable: true, error: '云端暂不支持开子 Agent',
  });
  assert.equal(CLOUD_TOOL_PLAN.spawn_agent.disabled, true);
  assert.ok(CLOUD_SYSTEM_NOTE.includes('云端暂不支持开子 Agent'));
  const offered = await buildTools({ callTool: async () => [], workspaceDir: null, only: CLOUD_OPEN_TOOLS, localTools: false });
  assert.equal(offered.some(({ name }) => name === 'spawn_agent'), false);

  const kit = await startKit(t);
  await kit.doc.seed(project(alice.projectId, 'spawn disabled'));
  const before = await kit.doc.stateOf(alice.projectId);

  for (const [conversationId, pageId] of [['online', PAGE], ['offline', undefined]]) {
    await kit.service.send(alice, `c-${conversationId}`, { prompt: hold(), ...(pageId ? { pageId } : {}) });
    const conversationsBefore = kit.service.conversations(alice).map(({ id }) => id);
    const events = [];
    const unsubscribe = pageId
      ? kit.service.subscribe(alice, `c-${conversationId}`, 0, (event) => events.push(event), { pageId })
      : null;
    const instance = kit.service._instance(alice);
    assert.deepEqual(await instance.callTool('spawn_agent', { role: 'editor', task: 'x' }, `c-${conversationId}`), {
      ok: false, cloudUnavailable: true, error: '云端暂不支持开子 Agent',
    });
    assert.deepEqual(kit.service.conversations(alice).map(({ id }) => id), conversationsBefore, 'rejection creates no hosted conversation');
    assert.equal(events.some((event) => event.type === 'page.request'), false);
    unsubscribe?.();
    kit.service.abort(alice, `c-${conversationId}`);
  }

  assert.equal((await kit.doc.stateOf(alice.projectId)).rev, before.rev, 'rejection leaves the project unchanged');
});
