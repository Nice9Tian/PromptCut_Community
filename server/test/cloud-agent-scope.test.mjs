/**
 * CA-SCOPE-01 After a cloud round finishes, the scope declared by this chat is cleared accordingly
 * (contract `docs/plan/cloud-agent-contract.md` section 25 minor amendment).
 *
 * Cloud chats have no tab to close: if not cleared, other members' AI panel top will keep showing
 * "Cloud Agent for <member> is editing: …", while the top bar already shows "Agent: 0".
 * Tests all three completions: finished speaking, model call failure, and stopped by owner;
 * scope remains present during a round (visible to other Agents' `list_agents`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBoards } from '../agent/agent-board.mjs';
import { waitFor } from './fake-ws-kit.mjs';
import { project, script, startKit } from './cloud-agent-kit.mjs';

const alice = { projectId: 'p-a', userId: 'alice@dev-a', username: 'alice', deviceName: 'A\'s computer' };
const SCOPE = 'Cut 1->Track 1';

test('CA-SCOPE-01 after a round ends (finished, failed, stopped) the scope declaration is withdrawn; while running it is present', { timeout: 180_000 }, async (t) => {
  // Bulletin board itself: clearScope returns true only when a scope previously existed; after
  // clearing, scope in the list is null
  const board = createAgentBoards(() => ({})).boardFor('p-x');
  board.beginRun('c-1', 0);
  assert.equal(board.clearScope('c-1'), false);
  board.declareScope('c-1', { scope: SCOPE });
  assert.equal(board.listRaw('').find((a) => a.id === 'c-1').scope, SCOPE);
  assert.equal(board.clearScope('c-1'), true);
  assert.equal(board.listRaw('').find((a) => a.id === 'c-1')?.scope ?? null, null);
  assert.equal(board.clearScope('c-1'), false);
  assert.equal(board.clearScope('no-such'), false);

  const kit = await startKit(t);
  await kit.doc.seed(project('p-a', 'A'));
  /** Open another chat to query the list once, returning [id, scope] for each Agent in the list */
  let n = 0;
  const scopesNow = async () => {
    const id = `c-ask-${(n += 1)}`;
    await kit.service.send(alice, id, { prompt: script([{ tool: 'list_agents', input: {} }, { say: 'Already asked' }]) });
    const ev = await kit.finished(alice, id);
    const out = ev.find((e) => e.type === 'tool_result' && e.name === 'list_agents');
    assert.equal(out?.ok, true);
    return String(out.summary);
  };

  // In progress: scope is present (visible in another chat)
  await kit.service.send(alice, 'c-scope', { prompt: script([{ tool: 'declare_scope', input: { scope: SCOPE } }, { sleepMs: 2500 }, { say: 'That\'s all' }]) });
  await waitFor(() => { const all = []; kit.service.subscribe(alice, 'c-scope', 0, (e) => all.push(e))?.(); return all.some((e) => e.type === 'tool_result' && e.name === 'declare_scope'); }, 15_000, 'scope was declared');
  assert.ok((await scopesNow()).includes(SCOPE), 'While a round is in progress, other chats can see the scope it declared');
  // Finished speaking
  assert.equal((await kit.finished(alice, 'c-scope')).at(-1).state, 'idle');
  assert.equal((await scopesNow()).includes(SCOPE), false, 'After finishing, the scope was withdrawn');

  // Model call failure
  await kit.service.send(alice, 'c-scope-fail', { prompt: script([{ tool: 'declare_scope', input: { scope: SCOPE } }, { fail: 'Simulated model error' }]) });
  assert.equal((await kit.finished(alice, 'c-scope-fail')).at(-1).state, 'failed');
  assert.equal((await scopesNow()).includes(SCOPE), false, 'After failure, the scope was withdrawn');

  // Stopped by owner
  await kit.service.send(alice, 'c-scope-stop', { prompt: script([{ tool: 'declare_scope', input: { scope: SCOPE } }, { sleepMs: 30_000 }, { say: 'Never reached' }]) });
  await waitFor(() => { const all = []; kit.service.subscribe(alice, 'c-scope-stop', 0, (e) => all.push(e))?.(); return all.some((e) => e.type === 'tool_result' && e.name === 'declare_scope'); }, 15_000, 'scope was declared');
  kit.service.abort(alice, 'c-scope-stop');
  assert.equal((await kit.finished(alice, 'c-scope-stop')).at(-1).reason, 'stopped');
  await waitFor(async () => !(await scopesNow()).includes(SCOPE), 10_000, 'After being stopped, the scope is withdrawn', 300);
});
