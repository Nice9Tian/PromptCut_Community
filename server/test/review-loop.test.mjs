/**
 * 审查环路(harness/loop.mjs)的各条路径。模型全是按角色写好台词的假 provider,不走网络。
 *
 * 盯的几件事:只有 judger 能宣布完成;worker 每轮都看得到用户原话;三次失败换成反省、
 * 反省时不给工具;judger 改写的教训会被存下来;卡住时提前反省;两批都没过就停下交给用户。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runReviewLoop, presentLoopEvent } from '../harness/loop.mjs';

const USER = '把这段口播配上动效,三十秒以内';

/** 一个角色的台词:每次「新一轮请求」弹一句;刚执行完工具就回一句「好」收尾 */
function scripted(role, actions, calls) {
  const queue = [...actions];
  let n = 0;
  return {
    name: role,
    async *stream(messages, tools, system) {
      const last = messages[messages.length - 1];
      const afterTool = last?.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
      calls.push({ role, messages: JSON.parse(JSON.stringify(messages)), tools: tools.map((t) => t.name), system, afterTool });
      if (afterTool) { yield { type: 'text_delta', text: '好' }; yield { type: 'stop', reason: 'end_turn' }; return; }
      const a = queue.shift();
      if (!a) throw new Error(`${role} 的台词用完了`);
      if (a.abort) { a.abort(); yield { type: 'text_delta', text: '…' }; yield { type: 'stop', reason: 'end_turn' }; return; }
      if (a.tool) { yield { type: 'tool_use', id: `${role}-${++n}`, name: a.tool, input: a.input }; yield { type: 'stop', reason: 'tool_use' }; return; }
      yield { type: 'text_delta', text: a.text }; yield { type: 'stop', reason: 'end_turn' };
    },
  };
}

const tool = (name) => ({ name, inputSchema: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) });
const TOOLS = [tool('get_project'), tool('see_frames'), tool('add_clip'), tool('think')];

const plan = (req = '要求 A', lessons) => ({ tool: 'issue_plan', input: { requirements: req, reviewerBrief: '检查项 X', ...(lessons ? { lessons } : {}) } });
const done = { tool: 'phase_done', input: { summary: '四条都有依据' } };
const revise = (op, req) => ({ tool: 'request_revision', input: { rulings: [{ opinion: op, verdict: '采纳', reason: '成立' }], requirements: req || `改 ${op}` } });
const review = (issue = '卡片 3 模板雷同') => ({ tool: 'submit_review', input: { opinions: [{ issue, evidence: 'list_cards' }] } });
const deliver = (s = '交货:做了 A') => ({ text: s });

async function run({ judger, worker, reviewer, lessons = [], signal }) {
  const calls = [];
  const events = [];
  const saved = [];
  const out = await runReviewLoop({
    providers: { judger: scripted('judger', judger, calls), worker: scripted('worker', worker, calls), reviewer: scripted('reviewer', reviewer, calls) },
    tools: TOOLS, system: '编辑台系统提示', userText: USER, signal,
    lessonsStore: { read: () => lessons, add: (l) => saved.push(...l) },
    onEvent: (e) => events.push(e),
  });
  const first = (role) => calls.filter((c) => c.role === role && !c.afterTool);
  return { out, calls, events, saved, first };
}

test('一次通过:judger 开场 → worker → reviewer → judger 判 phase_done', async () => {
  const { out, first } = await run({ judger: [plan(), done], worker: [deliver()], reviewer: [review()] });
  assert.equal(out.outcome, 'passed');
  assert.match(out.text, /四条都有依据/);
  const w = first('worker')[0];
  assert.match(JSON.stringify(w.messages), new RegExp(USER), 'worker 要看得到用户原话');
  assert.match(JSON.stringify(w.messages), /要求 A/, 'worker 要看得到 judger 的要求');
  assert.ok(!w.tools.includes('phase_done'), 'worker 不能有 phase_done');
  const r = first('reviewer')[0];
  assert.ok(!r.tools.includes('add_clip'), 'reviewer 只能拿只读工具');
  assert.ok(r.tools.includes('see_frames') && r.tools.includes('submit_review'));
});

test('不通过一次后通过:第二轮 worker 拿到的是 judger 改过的要求,而且是一段新历史', async () => {
  const { out, first } = await run({
    judger: [plan(), revise('卡片 3 模板雷同', '把卡片 3 换成另一种卡'), done],
    worker: [deliver(), deliver('交货:换了卡片 3')],
    reviewer: [review(), review('无')],
  });
  assert.equal(out.outcome, 'passed');
  const second = first('worker')[1];
  assert.match(JSON.stringify(second.messages), /把卡片 3 换成另一种卡/);
  assert.equal(second.messages.length, 1, '每一轮 worker 都是新历史,只有这一轮的任务说明');
});

test('三次失败 → 反省(不给工具)→ judger 改写 → 通过;认可的教训被存下来', async () => {
  const { out, calls, saved, first } = await run({
    judger: [plan(), revise('问题一'), revise('问题二'), revise('问题三'), plan('新要求', ['先看画面再排卡']), done],
    worker: [deliver(), deliver(), deliver(), { text: '反省:没看画面就排卡' }, deliver('交货:照新要求做了')],
    reviewer: [review(), review(), review(), review()],
  });
  assert.equal(out.outcome, 'passed');
  const reflect = first('worker')[3];
  assert.deepEqual(reflect.tools, [], '反省那一轮不给工具');
  assert.match(JSON.stringify(reflect.messages), /问题一[\s\S]*问题二[\s\S]*问题三/, '反省要看到三次裁决');
  const rewrite = calls.filter((c) => c.role === 'judger' && !c.afterTool)[4];
  assert.match(JSON.stringify(rewrite.messages), /没看画面就排卡/, 'judger 改写时要看到反省');
  assert.match(JSON.stringify(first('worker')[4].messages), /先看画面再排卡/, '教训要交给之后的 worker');
  assert.deepEqual(saved, ['先看画面再排卡']);
});

test('judger 不裁决:推一次;推了还不交就按不通过算,worker 再来一轮', async () => {
  const { out, events, first } = await run({
    judger: [plan(), { text: '我觉得还行' }, { text: '嗯' }, done],
    worker: [deliver(), deliver()],
    reviewer: [review(), review()],
  });
  assert.equal(out.outcome, 'passed');
  assert.equal(first('worker').length, 2);
  assert.ok(events.some((e) => e.type === 'loop' && e.stage === 'verdict' && e.verdict === 'none'));
});

test('卡住:连续两次裁决的缺口一样,不等满三次就反省', async () => {
  const { out, first } = await run({
    judger: [plan(), revise('同一个问题'), revise('同一个问题'), plan('换个要求'), done],
    worker: [deliver(), deliver(), { text: '反省' }, deliver()],
    reviewer: [review(), review(), review()],
  });
  assert.equal(out.outcome, 'passed');
  assert.deepEqual(first('worker')[2].tools, [], '第三次 worker 调用应当是反省');
});

test('两批都没过:第二次反省后停下,把两次反省交给用户', async () => {
  const { out } = await run({
    judger: [plan(), revise('一'), revise('二'), revise('三'), plan('改写'), revise('四'), revise('五'), revise('六')],
    worker: [deliver(), deliver(), deliver(), { text: '第一次反省的内容' }, deliver(), deliver(), deliver(), { text: '第二次反省的内容' }],
    reviewer: Array(6).fill(0).map(() => review()),
  });
  assert.equal(out.outcome, 'exhausted');
  assert.match(out.text, /第一次反省的内容[\s\S]*第二次反省的内容/);
});

test('聊天栏显示:裁决变成逐条列出的状态行,reviewer/judger 的话进思考区,worker 的话进正文', () => {
  const [st] = presentLoopEvent({ type: 'loop', stage: 'verdict', role: 'judger', verdict: 'request_revision',
    input: { rulings: [{ opinion: '卡片 3 雷同', verdict: '采纳', reason: '成立' }, { opinion: '换配乐', verdict: '驳回', reason: '改不动' }] } });
  assert.equal(st.type, 'status');
  assert.match(st.text, /采纳 1 条、降级 0 条、驳回 1 条/);
  assert.match(st.text, /\[驳回\] 换配乐 —— 改不动/);
  assert.equal(presentLoopEvent({ type: 'text', role: 'judger', delta: '我看看' })[0].type, 'thinking');
  assert.equal(presentLoopEvent({ type: 'text', role: 'worker', delta: '交货' })[0].type, 'text');
  assert.match(presentLoopEvent({ type: 'progress', role: 'reviewer', text: '第 1 轮' })[0].text, /^reviewer · 第 1 轮/);
  assert.deepEqual(presentLoopEvent({ type: 'loop', stage: 'done', outcome: 'passed' }), [], '结束不另起状态行,结论走正文');
  // 实跑见过:没有逐条裁定、judger 自己核对后要求返工 —— 要把要求摆出来,不能只写「采纳 0 条」
  const [own] = presentLoopEvent({ type: 'loop', stage: 'verdict', role: 'judger', verdict: 'request_revision',
    input: { rulings: [], requirements: 'worker 必须真实调用工具执行整改\n1. 清理全部冗余卡片' } });
  assert.match(own.text, /它自己核对后要求返工/);
  assert.match(own.text, /worker 必须真实调用工具执行整改/);
  assert.equal(presentLoopEvent({ type: 'loop', stage: 'judging', role: 'judger' })[0].text, 'judger 正在逐条裁定 reviewer 的意见');
});

test('网关超时:接着同一段历史重试,不把整个环路作废;重试也用完才冒出去', async () => {
  const flaky = (inner, fails) => {
    let left = fails;
    return { name: 'flaky', async *stream(...a) {
      if (left-- > 0) throw Object.assign(new Error('The operation was aborted due to timeout(120 秒没有收到任何数据)'), { name: 'TimeoutError' });
      yield* inner.stream(...a);
    } };
  };
  const calls = [], events = [];
  const out = await runReviewLoop({
    providers: {
      judger: scripted('judger', [plan(), done], calls),
      worker: flaky(scripted('worker', [deliver()], calls), 1),
      reviewer: scripted('reviewer', [review()], calls),
    },
    tools: TOOLS, system: 's', userText: USER, onEvent: (e) => events.push(e),
  });
  assert.equal(out.outcome, 'passed', '超时一次之后应当接着跑完');
  assert.ok(events.some((e) => e.type === 'loop' && e.stage === 'retry' && e.role === 'worker'));
  assert.match(presentLoopEvent({ type: 'loop', stage: 'retry', role: 'worker', attempt: 1 })[0].text, /网关超时/);

  await assert.rejects(() => runReviewLoop({
    providers: { judger: flaky(scripted('judger', [plan()], []), 5) },
    tools: TOOLS, system: 's', userText: USER,
  }), /timeout/, '重试用完还超时,就交给上层(api.mjs 会标成可续跑)');
});

test('审查中途点停止:整个环路抛 AbortError', async () => {
  const ac = new AbortController();
  await assert.rejects(() => run({
    judger: [plan()], worker: [deliver()], reviewer: [{ abort: () => ac.abort() }], signal: ac.signal,
  }), (e) => e.name === 'AbortError');
});
