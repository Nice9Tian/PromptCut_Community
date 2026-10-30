/**
 * C6.5 第二批：Agent 直接写文档服务（D1、D4）与工具调用事件（D2）。用例 C65B-D1-*、C65B-D2-*。
 * 跑：node --test server/test/c65b-agent.test.mjs
 *
 * 依据：`docs/plan/c65-design.md` 第 5、7、8 节与第 11 节 V3；`docs/plan/cloud-task.md` 的 D1、D2、D4。
 * 只照设计稿写，没看 `c65-agent`、`c65-editor` 的实现。设计稿没写死的接口集中在 `c65b-kit.mjs`（假设 B1～B4、B9）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PID, startC65bService, seed, stateOf, watcher, agentProject, startAgent, revOf, uid,
  loadTools, sideOf, eventPairOf, detailOf, undoInfoOf, undoAgentStep,
  openProject, submit, isOk, clipOf, waitFor, sleep,
} from './c65b-kit.mjs';
import { createPage, loadJsonOps } from './c65-kit.mjs';

const C1 = '/tracks/@t1/clips/@c1';
const C2 = '/tracks/@t1/clips/@c2';

async function setup(t, { conversation = 7 } = {}) {
  const env = await startC65bService(t);
  await seed(env, agentProject());
  const w = await watcher(env);
  const agent = await startAgent(env, { conversation });
  t.after(() => agent.close());
  return { env, w, agent };
}

/** 一条页面角色的原始连接，打开项目；edit(path, value) 提交一次 set，等 ok */
async function rawPage(env, { user, dev = `dev-${user}`, session = `page-${user}` }) {
  const c = await env.connect({ user, dev });
  await openProject(c, PID);
  return {
    c,
    async set(path, value) {
      const r = await submit(c, { projectId: PID, ops: [{ op: 'set', path, value }], session });
      assert.ok(isOk(r), `${user} 的提交应落地：${JSON.stringify(r)}`);
      return r;
    },
  };
}

/** 观察者收到的、路径碰到 prefix 的广播 */
const opsTouching = (w, prefix) => w.ops().filter((m) => (m.ops ?? []).some((o) => o.path === prefix || o.path.startsWith(`${prefix}/`)));

// ------------------------------------------------------------------ D1：写工具在服务端执行、以 Agent 身份提交

test('C65B-D1-01 写工具在 Agent 服务端执行：没有页面在线也能改；以 agent 身份（role、对话号）提交一次；不经页面', async (t) => {
  const { env, w, agent } = await setup(t, { conversation: 7 });
  const before = await stateOf(env);
  const r = await agent.call('update_clip', { clipId: 'c1', label: 'Agent 改' });
  assert.ok(r.ok, `没有页面在线时写工具照样成功：${r.text.slice(0, 400)}`);

  const st = await stateOf(env);
  assert.equal(clipOf(st.project, 'c1').label, 'Agent 改', '文档服务里的项目已改');
  assert.equal(st.rev, before.rev + 1, '一次工具调用 = 一次提交，版本号加一');

  await waitFor(() => opsTouching(w, C1).length === 1, 3000, '观察者收到 Agent 的那次提交');
  const [op] = opsTouching(w, C1);
  assert.equal(op.actor?.role, 'agent', `写入身份的角色是 agent：${JSON.stringify(op.actor)}`);
  assert.equal(op.actor?.conversation, 7, '写入身份带对话号');
  assert.equal(op.actor?.userId, uid('alice', 'dev-a'), 'userId 取自连接凭证');
  assert.ok(!agent.pageCalls.some((c) => c.tool === 'update_clip'), `写工具不经页面：${JSON.stringify(agent.pageCalls)}`);
});

test('C65B-D1-02 期望版本（V3）：Agent 读后页面改了同一实体，Agent 的写回错并附 since 摘要（实体、谁改的）；重读后再写成功', async (t) => {
  const { env, agent } = await setup(t);
  const read = await agent.call('get_project');
  assert.ok(read.ok, read.text.slice(0, 300));
  const st0 = await stateOf(env);
  assert.equal(revOf(read), st0.rev, '读工具回包带 rev，等于文档服务当前版本');

  const bob = await rawPage(env, { user: 'bob', dev: 'dev-b' });
  await bob.set(`${C1}/label`, 'Bob 改');
  const st1 = await stateOf(env);

  const stale = await agent.call('update_clip', { clipId: 'c1', label: 'Agent 盖' });
  assert.equal(stale.ok, false, `期望版本不符，写工具回错：${stale.text.slice(0, 400)}`);
  assert.match(stale.text, /c1/, `错误里附上被改的实体：${stale.text.slice(0, 400)}`);
  assert.ok(stale.text.includes('bob'), `错误里附上谁改的：${stale.text.slice(0, 400)}`);
  const st2 = await stateOf(env);
  assert.equal(st2.rev, st1.rev, '被拒的写不落地');
  assert.equal(clipOf(st2.project, 'c1').label, 'Bob 改');

  const reread = await agent.call('get_project');
  assert.equal(revOf(reread), st2.rev, '重读拿到新版本');
  assert.ok(reread.text.includes('Bob 改'), '副本已随文档服务更新');
  const again = await agent.call('update_clip', { clipId: 'c1', label: 'Agent 重写' });
  assert.ok(again.ok, `重读后再写成功：${again.text.slice(0, 400)}`);
  assert.equal(clipOf((await stateOf(env)).project, 'c1').label, 'Agent 重写');
});

test('C65B-D1-03 读后写一致：写成功后以 ok 的 rev 为准，接着再写不被自己挡住；读工具回包的 rev 跟着走', async (t) => {
  const { env, agent } = await setup(t);
  await agent.call('get_project');
  const a = await agent.call('update_clip', { clipId: 'c1', label: '第一次' });
  assert.ok(a.ok, a.text.slice(0, 300));
  const b = await agent.call('update_clip', { clipId: 'c2', label: '第二次' });
  assert.ok(b.ok, `自己上一次写落地后，下一次写不该因自己的提交而 stale：${b.text.slice(0, 300)}`);
  const st = await stateOf(env);
  const read = await agent.call('get_project');
  assert.equal(revOf(read), st.rev, '读工具回包的 rev 是最新的');
});

test('C65B-D1-04 副本跟随文档服务：页面改了别的片段，Agent 再读看得到，rev 同步', async (t) => {
  const { env, agent } = await setup(t);
  await agent.call('get_project');
  const bob = await rawPage(env, { user: 'bob', dev: 'dev-b' });
  const ok = await bob.set(`${C2}/label`, '页面改的');
  let read;
  await waitFor(async () => {
    read = await agent.call('get_project');
    return revOf(read) === ok.rev;
  }, 5000, 'Agent 的副本跟上文档服务的版本');
  assert.ok(read.text.includes('页面改的'), '副本内容跟上');
});

test('C65B-D1-05 两个对话：各自以自己的对话号提交；各自按自己最后读到的版本作 expectRev', async (t) => {
  const { env, w, agent } = await setup(t);
  await agent.call('get_project', {}, 3);
  await agent.call('get_project', {}, 5);
  const five = await agent.call('update_clip', { clipId: 'c1', label: '对话 5' }, 5);
  assert.ok(five.ok, five.text.slice(0, 300));
  const three = await agent.call('update_clip', { clipId: 'c1', label: '对话 3' }, 3);
  assert.equal(three.ok, false, `对话 3 读到的是旧版本，写回错：${three.text.slice(0, 300)}`);
  assert.match(three.text, /c1/);
  await agent.call('get_project', {}, 3);
  const again = await agent.call('update_clip', { clipId: 'c1', label: '对话 3' }, 3);
  assert.ok(again.ok, again.text.slice(0, 300));
  await waitFor(() => opsTouching(w, C1).length === 2, 3000, '两次提交都广播了');
  assert.deepEqual(opsTouching(w, C1).map((m) => [m.actor?.role, m.actor?.conversation]), [['agent', 5], ['agent', 3]]);
  assert.equal(clipOf((await stateOf(env)).project, 'c1').label, '对话 3');
});

// ------------------------------------------------------------------ D1 / D4：执行位置

test('C65B-D1-06 工具逐条标 side：写工具与 get_project / get_layout 在 Agent 服务端；选区、播放头、web_handoff 留在页面', async () => {
  const tools = await loadTools();
  const byName = new Map(tools.map((x) => [x.name, x]));
  const unlabeled = tools.filter((x) => sideOf(x) === undefined).map((x) => `${x.name}=${x.side}`);
  assert.deepEqual(unlabeled, [], '每个工具都标了执行位置');
  const agentSide = ['add_clip', 'update_clip', 'remove_clip', 'set_project_meta', 'set_rect', 'add_track', 'create_filter', 'get_project', 'get_layout'];
  const pageSide = ['get_selection', 'user_interface_seek', 'user_interface_play', 'user_interface_pause', 'user_interface_web_handoff'];
  for (const n of [...agentSide, ...pageSide]) assert.ok(byName.has(n), `工具表里有 ${n}`);
  assert.deepEqual(agentSide.filter((n) => sideOf(byName.get(n)) !== 'agent').map((n) => `${n}=${byName.get(n).side}`), [], '写工具与 D4 的读工具在 Agent 服务端');
  assert.deepEqual(pageSide.filter((n) => sideOf(byName.get(n)) !== 'page').map((n) => `${n}=${byName.get(n).side}`), [], '只读页面独有状态的工具留在页面');
});

test('C65B-D1-07 留在页面的工具仍经页面执行：get_selection、seek 走页面那条路；不写项目', async (t) => {
  const { env, agent } = await setup(t);
  const rev0 = (await stateOf(env)).rev;
  await agent.call('get_selection');
  await agent.call('user_interface_seek', { t: 1 });
  await agent.call('seek', { t: 2 });
  // 发给页面的是旧的内部操作名(新旧名调用都一样),0.7.18 的页面也认得
  assert.deepEqual(agent.pageCalls.map((c) => c.tool), ['get_selection', 'seek', 'seek'], `页面侧工具经页面：${JSON.stringify(agent.pageCalls)}`);
  assert.equal((await stateOf(env)).rev, rev0, '页面侧工具不产生提交');
});

// ------------------------------------------------------------------ D2：工具调用事件

test('C65B-D2-01 每个工具调用两条事件（创建、完成），走项目频道；完整参数在 event-detail', async (t) => {
  const { w, agent } = await setup(t, { conversation: 9 });
  const r = await agent.call('update_clip', { clipId: 'c1', label: '事件' });
  assert.ok(r.ok, r.text.slice(0, 300));
  const { create, complete } = await eventPairOf(w, 'update_clip');
  const evs = w.events();
  assert.ok(evs.indexOf(create) < evs.indexOf(complete), '先创建、后完成');
  assert.equal(typeof create.args, 'string', '创建事件带参数摘要');
  assert.ok(create.args.length > 0);
  assert.match(String(create.target ?? ''), /c1/, `创建事件带目标片段：${JSON.stringify(create)}`);
  assert.equal(complete.status, 'ok');
  assert.equal(typeof complete.durationMs, 'number', '完成事件带耗时');
  for (const e of [create, complete]) {
    assert.equal(e.actor?.role, 'agent');
    assert.equal(e.actor?.conversation, 9);
  }
  const detail = await detailOf(w.c, create);
  assert.ok(detail !== undefined, '完整参数写进了内容库 event-detail');
  const text = JSON.stringify(detail);
  assert.ok(text.includes('"clipId":"c1"') && text.includes('事件'), `event-detail 里是完整参数：${text.slice(0, 300)}`);

  // 读工具同样两条
  await agent.call('get_project');
  const pair = await eventPairOf(w, 'get_project');
  assert.equal(pair.complete.status, 'ok');
});

test('C65B-D2-02 写工具的事件带 opId 与 inverse：opId 就是广播里那次提交，inverse 能把实体还原；读工具与被拒的写不带', async (t) => {
  const { env, w, agent } = await setup(t);
  const { apply } = await loadJsonOps();
  const before = await stateOf(env);
  await agent.call('get_project');
  await agent.call('update_clip', { clipId: 'c1', label: '带逆操作' });
  const pair = await eventPairOf(w, 'update_clip');
  const detail = await detailOf(w.c, pair.create);
  const info = undoInfoOf({ ...pair, detail });
  await waitFor(() => opsTouching(w, C1).length === 1, 3000, '广播');
  assert.equal(info.opId, opsTouching(w, C1)[0].opId, `事件里的 opId 就是那次提交：${JSON.stringify(pair.complete)}`);
  assert.ok(Array.isArray(info.inverse) && info.inverse.length > 0, `事件带 inverse：${JSON.stringify(info)}`);
  const after = await stateOf(env);
  const back = apply(structuredClone(after.project), info.inverse);
  assert.ok(back.ok, `inverse 能落在当前版本上：${back.reason}`);
  assert.deepEqual(clipOf(back.doc, 'c1'), clipOf(before.project, 'c1'), 'inverse 把片段还原');

  const read = await eventPairOf(w, 'get_project');
  const readInfo = undoInfoOf({ ...read, detail: await detailOf(w.c, read.create) });
  assert.ok(readInfo.opId === undefined && !(readInfo.inverse?.length), `只读工具不带撤销信息（AI 栏不显示「撤销这步」）：${JSON.stringify(readInfo)}`);

  // 被拒的写：完成事件记 error，不带 opId
  const bob = await rawPage(env, { user: 'bob', dev: 'dev-b' });
  await bob.set(`${C2}/label`, 'Bob');
  const stale = await agent.call('update_clip', { clipId: 'c2', label: '盖不上' });
  assert.equal(stale.ok, false);
  const rej = await eventPairOf(w, 'update_clip', { nth: 1 });
  assert.equal(rej.complete.status, 'error', '被拒的写，完成事件的状态是 error');
  assert.equal(undoInfoOf(rej).opId, undefined, '没落地的写没有 opId');
});

// ------------------------------------------------------------------ D2 × 第 8 节：AI 栏「撤销这一步」

async function pageAndAgent(t, opts) {
  const { env, w, agent } = await setup(t, opts);
  const A = await createPage(env, { projectId: PID, user: 'alice', dev: 'dev-a', session: 'page-a' });
  t.after(() => A.close());
  return { env, w, agent, A };
}

async function agentStep(w, tool, nth = 0) {
  const pair = await eventPairOf(w, tool, { nth });
  return undoInfoOf({ ...pair, detail: await detailOf(w.c, pair.create) });
}

test('C65B-D2-03 页面按事件提交 inverse + undoOf：实体恢复；这次写入算用户页面会话的，进用户自己的撤销栈（Ctrl+Z 把 Agent 的改动恢复回来）', async (t) => {
  const { env, w, agent, A } = await pageAndAgent(t);
  await agent.call('get_project');
  const r = await agent.call('update_clip', { clipId: 'c1', label: 'Agent 的' });
  assert.ok(r.ok, r.text.slice(0, 300));
  await waitFor(() => clipOf(A.project, 'c1').label === 'Agent 的', 5000, '页面收到 Agent 的改动');
  assert.equal(A.canUndo(), false, 'Agent 的改动不进页面的撤销栈');

  const info = await agentStep(w, 'update_clip');
  const res = await undoAgentStep(A.sync.ds, info);
  assert.equal(res?.done, true, `撤销这一步成功：${JSON.stringify(res)}`);
  assert.deepEqual(res.skipped ?? [], []);
  await A.settled();
  assert.equal(clipOf((await stateOf(env)).project, 'c1').label, '片段1', '文档服务里片段恢复');

  await waitFor(() => w.ops().some((m) => m.undoOf === info.opId), 3000, '广播里带 undoOf');
  const undoOp = w.ops().find((m) => m.undoOf === info.opId);
  assert.equal(undoOp.actor?.role, 'page', `撤销这一步算页面的写入：${JSON.stringify(undoOp.actor)}`);
  assert.equal(undoOp.session ?? undoOp.actor?.session, 'page-a', '写入身份是这个页面会话');

  assert.equal(A.canUndo(), true, '进了用户自己的撤销栈');
  const z = await A.undo();
  assert.equal(z.done, true);
  await A.settled();
  assert.equal(clipOf((await stateOf(env)).project, 'c1').label, 'Agent 的', 'Ctrl+Z 把 Agent 的改动恢复回来');

  // Agent 下次改动时发现版本变了（undo 稿第 4 节「对 Agent 的影响」）
  const next = await agent.call('update_clip', { clipId: 'c1', label: 'Agent 再改' });
  assert.equal(next.ok, false, `Agent 拿旧版本写回错：${next.text.slice(0, 300)}`);
  assert.match(next.text, /c1/);
});

test('C65B-D2-04 撤销这一步也查冲突（V5 同理）：Agent 改了 name 与 fps，别的成员随后改了 fps；只撤 name，告诉用户 fps 因谁改过没撤', async (t) => {
  const { env, w, agent, A } = await pageAndAgent(t);
  await agent.call('get_project');
  const r = await agent.call('set_project_meta', { name: 'Agent 名', fps: 60 });
  assert.ok(r.ok, r.text.slice(0, 300));
  const bob = await rawPage(env, { user: 'bob', dev: 'dev-b' });
  const ok = await bob.set('/fps', 25);
  await waitFor(() => A.sync.rev >= ok.rev, 5000, '页面收到 Bob 的改动');

  const info = await agentStep(w, 'set_project_meta');
  const res = await undoAgentStep(A.sync.ds, info);
  assert.equal(res?.done, true, JSON.stringify(res));
  assert.deepEqual((res.skipped ?? []).map((s) => s.entity), ['/meta/fps'], `没撤的只有 fps：${JSON.stringify(res)}`);
  assert.ok(JSON.stringify(res.skipped[0].by).includes(uid('bob', 'dev-b')), `标明是谁改的：${JSON.stringify(res.skipped[0].by)}`);
  await A.settled();
  const st = await stateOf(env);
  assert.equal(st.project.name, '起点', 'name 撤回去了');
  assert.equal(st.project.fps, 25, 'fps 保持 Bob 的');
});

test('C65B-D2-05 不是最新的一步也能撤：Agent 先改 c1 再改 c2，撤第一步只动 c1', async (t) => {
  const { env, w, agent, A } = await pageAndAgent(t);
  await agent.call('get_project');
  assert.ok((await agent.call('update_clip', { clipId: 'c1', label: '一' })).ok);
  assert.ok((await agent.call('update_clip', { clipId: 'c2', label: '二' })).ok);
  await waitFor(() => clipOf(A.project, 'c2').label === '二', 5000, '页面收到两步');
  const first = await agentStep(w, 'update_clip', 0);
  const res = await undoAgentStep(A.sync.ds, first);
  assert.equal(res?.done, true, JSON.stringify(res));
  await A.settled();
  const st = await stateOf(env);
  assert.equal(clipOf(st.project, 'c1').label, '片段1');
  assert.equal(clipOf(st.project, 'c2').label, '二', '后一步不受影响');
  await sleep(50);
});
