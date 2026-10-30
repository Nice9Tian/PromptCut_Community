/**
 * CA-SCOPE-01 云端的一轮结束后,这个对话声明过的范围随之撤掉(契约 `docs/plan/cloud-agent-contract.md` 第 25 节的小修)。
 *
 * 云端的对话没有页签可关:不撤的话,别的成员的 AI 栏顶上会一直挂着「〈成员〉的云端 Agent 正在改:…」,而顶栏已经是「Agent:0 个」。
 * 说完、模型调用失败、被主人停掉,三种收尾都验;一轮进行中范围是在的(别的 Agent 的 `list_agents` 看得到)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBoards } from '../agent/agent-board.mjs';
import { waitFor } from './fake-ws-kit.mjs';
import { project, script, startKit } from './cloud-agent-kit.mjs';

const alice = { projectId: 'p-a', userId: 'alice@dev-a', username: 'alice', deviceName: 'A 的电脑' };
const SCOPE = '剪辑1->序列1';

test('CA-SCOPE-01 一轮结束(说完、失败、被停)后范围声明撤掉;进行中是在的', { timeout: 180_000 }, async (t) => {
  // 公告板自己:clearScope 只在原来有范围时回 true,撤掉之后名单里的范围是 null
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
  await kit.doc.seed(project('p-a', '甲'));
  /** 另开一个对话问一次名单,回名单里各 Agent 的 [id, scope] */
  let n = 0;
  const scopesNow = async () => {
    const id = `c-ask-${(n += 1)}`;
    await kit.service.send(alice, id, { prompt: script([{ tool: 'list_agents', input: {} }, { say: '问过了' }]) });
    const ev = await kit.finished(alice, id);
    const out = ev.find((e) => e.type === 'tool_result' && e.name === 'list_agents');
    assert.equal(out?.ok, true);
    return String(out.summary);
  };

  // 进行中:范围在(另一个对话看得到)
  await kit.service.send(alice, 'c-scope', { prompt: script([{ tool: 'declare_scope', input: { scope: SCOPE } }, { sleepMs: 2500 }, { say: '说完了' }]) });
  await waitFor(() => { const all = []; kit.service.subscribe(alice, 'c-scope', 0, (e) => all.push(e))?.(); return all.some((e) => e.type === 'tool_result' && e.name === 'declare_scope'); }, 15_000, '声明了范围');
  assert.ok((await scopesNow()).includes(SCOPE), '一轮进行中别的对话看得到它声明的范围');
  // 说完
  assert.equal((await kit.finished(alice, 'c-scope')).at(-1).state, 'idle');
  assert.equal((await scopesNow()).includes(SCOPE), false, '说完之后范围撤掉了');

  // 模型调用失败
  await kit.service.send(alice, 'c-scope-fail', { prompt: script([{ tool: 'declare_scope', input: { scope: SCOPE } }, { fail: '模拟的模型错误' }]) });
  assert.equal((await kit.finished(alice, 'c-scope-fail')).at(-1).state, 'failed');
  assert.equal((await scopesNow()).includes(SCOPE), false, '失败之后范围撤掉了');

  // 被主人停掉
  await kit.service.send(alice, 'c-scope-stop', { prompt: script([{ tool: 'declare_scope', input: { scope: SCOPE } }, { sleepMs: 30_000 }, { say: '到不了这里' }]) });
  await waitFor(() => { const all = []; kit.service.subscribe(alice, 'c-scope-stop', 0, (e) => all.push(e))?.(); return all.some((e) => e.type === 'tool_result' && e.name === 'declare_scope'); }, 15_000, '声明了范围');
  kit.service.abort(alice, 'c-scope-stop');
  assert.equal((await kit.finished(alice, 'c-scope-stop')).at(-1).reason, 'stopped');
  await waitFor(async () => !(await scopesNow()).includes(SCOPE), 10_000, '被停之后范围撤掉', 300);
});
