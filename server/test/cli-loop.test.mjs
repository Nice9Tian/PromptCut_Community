/**
 * 审查环路走 CLI(runners/cli-loop.mjs):一个角色回合起一次 CLI,结论从回复末尾的代码块里取,
 * 只读靠服务端的锁。这里用一个按角色写好台词的假 runner 顶替 agy,不起真进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCliLoop, parseSubmission, submitFormat } from '../runners/cli-loop.mjs';

const block = (name, obj) => `好的。\n\`\`\`${name}\n${JSON.stringify(obj)}\n\`\`\``;
const roleOf = (sys) => sys.startsWith('你是这条片子的 judger') ? 'judger' : sys.startsWith('你是 reviewer') ? 'reviewer' : 'worker';

/** 假 runner:按角色弹台词;每次调用都发 session、text、done,就像 agy */
function fakeCli(lines, calls) {
  const q = { judger: [...(lines.judger || [])], worker: [...(lines.worker || [])], reviewer: [...(lines.reviewer || [])] };
  let n = 0;
  return (opts) => {
    const role = roleOf(opts.systemPrompt);
    const say = q[role].shift();
    calls.push({ role, sessionId: opts.sessionId, systemPrompt: opts.systemPrompt, prompt: opts.prompt });
    const done = (async () => {
      await null;
      const sid = opts.sessionId || `${role}-conv-${++n}`;
      opts.onEvent({ type: 'session', sessionId: sid });
      if (say === undefined) { opts.onEvent({ type: 'error', message: `${role} 的台词用完了` }); return; }
      if (say?.error) { opts.onEvent({ type: 'error', ...say.error }); return; }
      opts.onEvent({ type: 'tool_call', name: 'get_project', input: {} });
      opts.onEvent({ type: 'text', delta: say });
      opts.onEvent({ type: 'done', sessionId: sid, usage: { input_tokens: 100, output_tokens: 10 } });
    })();
    return { abort() {}, done };
  };
}

async function run(lines) {
  const calls = [], events = [], locks = [];
  const r = startCliLoop({
    provider: 'agy', prompt: '配三张卡', systemPrompt: '编辑台系统提示', cwd: '.', reviewLoop: true,
    setToolAccess: (l) => locks.push(l === null ? null : [...l]),
    onEvent: (e) => events.push(e),
  }, fakeCli(lines, calls), { lessonsStore: { read: () => [], add() {} } });
  await r.done;
  return { calls, events, locks };
}

test('结论块:取最后一个合格的;JSON 坏了或缺必填字段不算', () => {
  assert.deepEqual(parseSubmission(block('phase_done', { summary: '都达到' }), ['phase_done']), { name: 'phase_done', input: { summary: '都达到' } });
  assert.equal(parseSubmission('```phase_done\n{坏的}\n```', ['phase_done']), null);
  assert.equal(parseSubmission(block('phase_done', {}), ['phase_done']), null, '缺 summary');
  assert.equal(parseSubmission(block('phase_done', { summary: 'x' }), ['issue_plan']), null, '这一回合不许交 phase_done');
  const two = block('request_revision', { rulings: [], requirements: '一' }) + '\n' + block('request_revision', { rulings: [], requirements: '二' });
  assert.equal(parseSubmission(two, ['request_revision']).input.requirements, '二');
});

test('交结论的说明写清「不是工具」、给出字段', () => {
  const s = submitFormat(['request_revision']);
  assert.match(s, /不是工具/);
  assert.match(s, /rulings/);
  assert.match(s, /采纳 \/ 驳回 \/ 降级/);
});

test('走通一圈:judger/reviewer 回合上只读锁,worker 回合解锁,结束一定解锁;内层 done/session 不外泄', async () => {
  const { events, locks, calls } = await run({
    judger: [block('issue_plan', { requirements: '要求 A', reviewerBrief: '检查 X' }), block('phase_done', { summary: '四条都有依据' })],
    worker: ['交货:做了 A'],
    reviewer: [block('submit_review', { opinions: [] })],
  });
  const done = events.filter((e) => e.type === 'done');
  assert.equal(done.length, 1, '只能有环路最后那一个 done');
  assert.equal(done[0].outcome, 'passed');
  assert.ok(!events.some((e) => e.type === 'session'), '角色回合的会话 id 不能漏给前端');
  assert.ok(events.some((e) => e.type === 'status' && /judger:通过/.test(e.text)));
  // judger 开场只读 → 解锁 → worker 全开(null) → reviewer 只读 → judger 只读,每回合后都解锁
  const readonly = (l) => Array.isArray(l) && l.includes('see_frames') && !l.includes('add_clip');
  assert.ok(readonly(locks[0]), 'judger 开场是只读锁');
  assert.equal(locks.at(-1), null, '最后必须解锁');
  const workerCall = calls.find((c) => c.role === 'worker');
  assert.match(workerCall.prompt, /要求 A/, 'worker 拿到 judger 的要求');
  assert.ok(!calls.find((c) => c.role === 'judger').sessionId, 'judger 开场是新会话');
});

test('judger 没交结论:接着它自己那个会话推一次', async () => {
  const { calls, events } = await run({
    judger: [block('issue_plan', { requirements: 'A', reviewerBrief: 'X' }), '我觉得还行', block('phase_done', { summary: 'ok' })],
    worker: ['交货'],
    reviewer: [block('submit_review', { opinions: [{ issue: '小问题', evidence: 't=1' }] })],
  });
  const judgerCalls = calls.filter((c) => c.role === 'judger');
  assert.equal(judgerCalls.length, 3);
  assert.ok(judgerCalls[2].sessionId, '推的那一次要带上会话 id');
  assert.match(judgerCalls[2].prompt, /还没有按规定交出结论/);
  assert.equal(events.find((e) => e.type === 'done').outcome, 'passed');
});

test('可续跑的错误:接着同一个会话重试;不可续跑的错误结束环路并报错', async () => {
  const ok = await run({
    judger: [{ error: { message: '被拒了', retryable: true, retryPrompt: '接着做' } }, block('issue_plan', { requirements: 'A', reviewerBrief: 'X' }), block('phase_done', { summary: 'ok' })],
    worker: ['交货'], reviewer: [block('submit_review', { opinions: [] })],
  });
  assert.equal(ok.events.find((e) => e.type === 'done').outcome, 'passed');
  assert.ok(ok.events.some((e) => e.type === 'status' && /重试/.test(e.text)));

  const bad = await run({ judger: [{ error: { message: '模型名不对' } }] });
  assert.ok(bad.events.some((e) => e.type === 'error' && /模型名不对/.test(e.message)));
  assert.equal(bad.locks.at(-1), null, '出错也要解锁');
});

/*
 * 实跑:worker 三次都被 agy 自家的内建工具拒掉(list_dir / read_url_content / grep_search),
 * 重试用完就 throw,整个环路报错结束 —— judger 定好的要求、worker 已经动过的工程全白跑。
 */
const denied = { error: { message: 'Antigravity 拒绝了它自己的内建工具(GrepSearch)', retryable: true, retryPrompt: '接着做' } };

test('worker 重试用完仍然中断:不作废环路,改动交给 reviewer / judger 核对,算一次没通过', async () => {
  const { events, calls } = await run({
    judger: [block('issue_plan', { requirements: 'A', reviewerBrief: 'X' }),
      block('request_revision', { rulings: [], requirements: '接着把 A 做完' }), block('phase_done', { summary: 'ok' })],
    worker: [denied, denied, denied, '交货:A 做完了'],
    reviewer: [block('submit_review', { opinions: [] }), block('submit_review', { opinions: [] })],
  });
  assert.ok(!events.some((e) => e.type === 'error'), '不能报错结束');
  assert.equal(events.find((e) => e.type === 'done').outcome, 'passed');
  assert.ok(events.some((e) => e.type === 'status' && /重试用完仍然中断/.test(e.text)));
  const reviewer = calls.find((c) => c.role === 'reviewer');
  assert.match(reviewer.prompt, /被技术原因打断[\s\S]*GrepSearch/, 'reviewer 要知道这次交货是中断的、为什么');
  const workers = calls.filter((c) => c.role === 'worker');
  assert.equal(workers.length, 4, '三次尝试 + 下一轮新的一次');
  assert.ok(!workers[3].sessionId, '下一轮 worker 是新会话');
});

test('worker 连着两轮中断:停下来正常收尾(不是报错),说明原因', async () => {
  const { events } = await run({
    judger: [block('issue_plan', { requirements: 'A', reviewerBrief: 'X' }), block('request_revision', { rulings: [], requirements: 'A' })],
    worker: Array(6).fill(denied),
    reviewer: [block('submit_review', { opinions: [] })],
  });
  assert.ok(!events.some((e) => e.type === 'error'));
  assert.equal(events.find((e) => e.type === 'done').outcome, 'interrupted');
  assert.ok(events.some((e) => e.type === 'text' && /连续 2 轮都被技术原因打断[\s\S]*GrepSearch/.test(e.delta)));
});

test('reviewer 重试用完仍然中断:judger 被告知自己核对,而不是当成「没有意见」', async () => {
  const { events, calls } = await run({
    judger: [block('issue_plan', { requirements: 'A', reviewerBrief: 'X' }), block('phase_done', { summary: 'ok' })],
    worker: ['交货'],
    reviewer: [denied, denied, denied],
  });
  assert.equal(events.find((e) => e.type === 'done').outcome, 'passed');
  assert.match(calls.filter((c) => c.role === 'judger')[1].prompt, /reviewer 这一轮因技术原因中断/);
});
