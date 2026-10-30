/**
 * C6.5 第二批：撤销 / 重做的用户侧行为（V5 的用户侧）、快捷键、提示条文案、`.proc` 等确认后才写（V7 页面侧）。
 * 用例 C65B-U-*、C65B-V7-*。
 * 跑：node --test server/test/c65b-undo.test.mjs
 *
 * 依据：`docs/plan/c65-design.md` 第 4、8、13 节，第 11 节 V5、V7；`docs/plan/c65-undo-draft.md` 第 1～3 节与文案表。
 * 第一批已在 `c65-undo.test.mjs` 钉了 V5 的基本面（C65-V5-01～05）；这里补「谁改的」三种身份、重做一侧、
 * 快捷键与文案。设计稿没写死的接口集中在 `c65b-kit.mjs`（假设 B5、B7、B8、B9）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PID, startC65bService, seed, stateOf, agentProject, uid, srcHref, registerTs,
  loadShortcut, keyEvent, loadUndoNotice, loadProcWhenConfirmed,
  openProject, submit, isOk, clipOf, waitFor, sleep,
} from './c65b-kit.mjs';
import { createPage } from './c65-kit.mjs';

const clip = (id) => `/tracks/@t1/clips/@${id}`;

async function setup(t) {
  const env = await startC65bService(t);
  await seed(env, agentProject());
  const pages = [];
  const open = async (o) => {
    const p = await createPage(env, { projectId: PID, ...o });
    pages.push(p);
    return p;
  };
  t.after(() => { for (const p of pages) p.close(); });
  /** 别的写入身份直接提交一次 set */
  const writeAs = async (who, session, path, value) => {
    const c = await env.connect(who);
    await openProject(c, PID);
    const r = await submit(c, { projectId: PID, ops: [{ op: 'set', path, value }], session });
    assert.ok(isOk(r), JSON.stringify(r));
    c.close();
    return r;
  };
  return { env, open, writeAs };
}

const skippedMap = (res) => new Map((res.skipped ?? []).map((s) => [s.entity, s.by]));

// ------------------------------------------------------------------ 部分没撤 / 全部没撤：实体与「谁改的」

test('C65B-U-01 部分没撤：返回没撤的实体与改它的写入身份，分得清 Agent 的对话、别的成员、你在另一个页面；其余照撤', async (t) => {
  const { env, open, writeAs } = await setup(t);
  const A = await open({ user: 'alice', dev: 'dev-a', session: 'page-a' });
  A.edit((p) => { for (const i of [1, 2, 3, 4]) clipOf(p, `c${i}`).label = `A${i}`; });
  await A.settled();

  await writeAs({ user: 'alice', dev: 'dev-a', role: 'agent', conv: 7 }, 'conv-7', `${clip('c1')}/label`, 'Agent');
  await writeAs({ user: 'bob', dev: 'dev-b' }, 'page-b', `${clip('c2')}/label`, 'Bob');
  const last = await writeAs({ user: 'alice', dev: 'dev-a' }, 'page-a2', `${clip('c3')}/label`, '另一个页面');
  await waitFor(() => A.sync.rev >= last.rev, 5000, 'A 收到三次改动');

  const res = await A.undo();
  assert.equal(res.done, true, `c4 撤了，算撤成：${JSON.stringify(res)}`);
  const m = skippedMap(res);
  assert.deepEqual([...m.keys()].sort(), [clip('c1'), clip('c2'), clip('c3')], `没撤的三处：${JSON.stringify(res.skipped)}`);
  assert.equal(m.get(clip('c1')).role, 'agent', `c1 是 Agent 改的：${JSON.stringify(m.get(clip('c1')))}`);
  assert.equal(m.get(clip('c1')).conversation, 7, '标明是哪个对话');
  assert.equal(m.get(clip('c2')).userId, uid('bob', 'dev-b'), 'c2 是别的成员改的');
  assert.equal(m.get(clip('c3')).userId, uid('alice', 'dev-a'), 'c3 是同一个用户、同一台设备');
  assert.equal(m.get(clip('c3')).session, 'page-a2', '……在另一个页面');

  await A.settled();
  const st = await stateOf(env);
  assert.deepEqual([1, 2, 3, 4].map((i) => clipOf(st.project, `c${i}`).label), ['Agent', 'Bob', '另一个页面', '片段4'], '只撤没被别人改过的 c4');
});

test('C65B-U-02 全部没撤：不产生提交、不进重做栈；返回的列表同样带实体与谁改的', async (t) => {
  const { env, open, writeAs } = await setup(t);
  const A = await open({ user: 'alice', dev: 'dev-a', session: 'page-a' });
  A.edit((p) => { clipOf(p, 'c1').label = 'A1'; clipOf(p, 'c2').label = 'A2'; });
  await A.settled();
  await writeAs({ user: 'bob', dev: 'dev-b' }, 'page-b', `${clip('c1')}/label`, 'Bob1');
  const last = await writeAs({ user: 'alice', dev: 'dev-a', role: 'agent', conv: 4 }, 'conv-4', `${clip('c2')}/label`, 'Agent2');
  await waitFor(() => A.sync.rev >= last.rev, 5000, 'A 收到两次改动');
  const revBefore = (await stateOf(env)).rev;

  const res = await A.undo();
  assert.equal(res.done, false, '一处都没撤成');
  const m = skippedMap(res);
  assert.equal(m.get(clip('c1'))?.userId, uid('bob', 'dev-b'));
  assert.equal(m.get(clip('c2'))?.role, 'agent');
  assert.equal(A.canRedo(), false, '全部没撤的一步不进重做栈');
  assert.equal(A.canUndo(), false, '这一步也出栈了');
  await sleep(150);
  assert.equal((await stateOf(env)).rev, revBefore, '没有提交');
});

test('C65B-U-03 重做同理：部分没重做返回没重做的实体与谁改的；全部没重做的一步不进撤销栈', async (t) => {
  const { env, open, writeAs } = await setup(t);
  const A = await open({ user: 'alice', dev: 'dev-a', session: 'page-a' });
  A.edit((p) => { clipOf(p, 'c1').label = 'A1'; clipOf(p, 'c2').label = 'A2'; });
  await A.settled();
  assert.equal((await A.undo()).done, true);
  await A.settled();
  const r1 = await writeAs({ user: 'bob', dev: 'dev-b' }, 'page-b', `${clip('c1')}/label`, 'Bob1');
  await waitFor(() => A.sync.rev >= r1.rev, 5000, 'A 收到 Bob 的改动');
  const redo = await A.redo();
  assert.equal(redo.done, true, JSON.stringify(redo));
  assert.deepEqual((redo.skipped ?? []).map((s) => [s.entity, s.by?.userId]), [[clip('c1'), uid('bob', 'dev-b')]]);
  await A.settled();
  let st = await stateOf(env);
  assert.equal(clipOf(st.project, 'c1').label, 'Bob1');
  assert.equal(clipOf(st.project, 'c2').label, 'A2', 'c2 重做回来了');

  // 全部没重做：另开一个页面会话，状态干净
  const B = await open({ user: 'alice', dev: 'dev-a', session: 'page-b2' });
  B.edit((p) => { clipOf(p, 'c3').label = 'B3'; clipOf(p, 'c4').label = 'B4'; });
  await B.settled();
  assert.equal((await B.undo()).done, true);
  await B.settled();
  await writeAs({ user: 'bob', dev: 'dev-b' }, 'page-b', `${clip('c3')}/label`, 'Bob3');
  const r2 = await writeAs({ user: 'bob', dev: 'dev-b' }, 'page-b', `${clip('c4')}/label`, 'Bob4');
  await waitFor(() => B.sync.rev >= r2.rev, 5000, 'B 收到 Bob 的改动');
  const revBefore = (await stateOf(env)).rev;
  const none = await B.redo();
  assert.equal(none.done, false);
  assert.equal(none.skipped.length, 2);
  assert.equal(B.canUndo(), false, '全部没重做的一步不进撤销栈');
  assert.equal(B.canRedo(), false, '也出了重做栈');
  await sleep(150);
  st = await stateOf(env);
  assert.equal(st.rev, revBefore, '没有提交');
});

// ------------------------------------------------------------------ 快捷键（B5）

test('C65B-U-04 快捷键：Ctrl+Z 撤销；Ctrl+Shift+Z 与 Ctrl+Y 都是重做（Cmd 同理）；焦点在输入框里交给输入框', async () => {
  const action = await loadShortcut();
  assert.equal(action(keyEvent('z', { ctrl: true })), 'undo');
  assert.equal(action(keyEvent('Z', { ctrl: true, shift: true })), 'redo', 'Ctrl+Shift+Z');
  assert.equal(action(keyEvent('z', { ctrl: true, shift: true })), 'redo', 'Ctrl+Shift+Z（key 小写）');
  assert.equal(action(keyEvent('y', { ctrl: true })), 'redo', 'Ctrl+Y 等价重做');
  assert.equal(action(keyEvent('Y', { ctrl: true })), 'redo');
  assert.equal(action(keyEvent('z', { meta: true })), 'undo', 'Cmd+Z');
  assert.equal(action(keyEvent('y', { meta: true })), 'redo', 'Cmd+Y');
  assert.equal(action(keyEvent('z')), null, '不按 Ctrl 不算');
  assert.equal(action(keyEvent('y')), null);
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(action(keyEvent('z', { ctrl: true, target })), null, `焦点在 ${target.tagName} 里交给输入框`);
    assert.equal(action(keyEvent('y', { ctrl: true, target })), null);
  }
});

test('C65B-U-05 Ctrl+Y 与 Ctrl+Shift+Z 在页面上效果相同：都重做刚撤销的那一步', async (t) => {
  const action = await loadShortcut();
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', dev: 'dev-a', session: 'page-a' });
  const run = (ev) => {
    const a = action(ev);
    if (a === 'undo') return A.undo();
    if (a === 'redo') return A.redo();
    return null;
  };
  for (const redoKey of [keyEvent('y', { ctrl: true }), keyEvent('Z', { ctrl: true, shift: true })]) {
    A.edit((p) => { clipOf(p, 'c1').label = `按 ${redoKey.key}`; });
    await A.settled();
    await run(keyEvent('z', { ctrl: true }));
    await A.settled();
    assert.equal(clipOf((await stateOf(env)).project, 'c1').label, '片段1');
    const r = await run(redoKey);
    assert.ok(r, `${redoKey.key} 触发了重做`);
    await A.settled();
    assert.equal(clipOf((await stateOf(env)).project, 'c1').label, `按 ${redoKey.key}`);
    A.edit((p) => { clipOf(p, 'c1').label = '片段1'; });
    await A.settled();
  }
});

// ------------------------------------------------------------------ 提示条文案（B8）

const by = (userId, extra = {}) => ({ actor: { userId, role: 'page', ...extra }, session: 's' });
const skipped = (n) => Array.from({ length: n }, (_, i) => ({ entity: clip(`c${i + 1}`), by: by(`u${i}@d`) }));

test('C65B-U-06 提示条文案：部分没撤 / 全部没撤 / 重做两种；每行是「实体 (由 谁 修改)」；超过 3 处折叠；撤成了不弹', async () => {
  const notice = await loadUndoNotice();
  const nameOf = (e) => `片段「${e.split('@').pop()}」`;
  const whoOf = (b) => (b?.actor?.role === 'agent' ? `Agent「对话${b.actor.conversation}」` : `成员${(b?.actor?.userId ?? '').split('@')[0]}`);
  const opts = (redo) => ({ redo, nameOf, whoOf });

  assert.equal(notice({ done: true, skipped: [], failed: [] }, opts(false)) ?? null, null, '全撤成了不弹提示');

  const partial = notice({ done: true, skipped: skipped(1), failed: [] }, opts(false));
  assert.equal(partial.title, '撤销了，但这几处被后续的新修改覆盖，未做退回：');
  assert.equal(partial.lines.length, 1);
  assert.ok(partial.lines[0].includes('片段「c1」') && partial.lines[0].includes('成员u0') && partial.lines[0].includes('修改'), partial.lines[0]);

  const all = notice({ done: false, skipped: skipped(2), failed: [] }, opts(false));
  assert.equal(all.title, '没撤成。这几处后来都被改过了，保留了现在的样子：');
  assert.equal(all.lines.length, 2);

  assert.equal(notice({ done: true, skipped: skipped(1), failed: [] }, opts(true)).title, '重做了，但这几处被后续的新修改覆盖，未做恢复：');
  assert.equal(notice({ done: false, skipped: skipped(1), failed: [] }, opts(true)).title, '没重做成。这几处后来都被改过了，保留了现在的样子：');

  const agentLine = notice({ done: true, skipped: [{ entity: clip('c9'), by: { actor: { userId: 'a@d', role: 'agent', conversation: 3 }, session: 'conv-3' } }], failed: [] }, opts(false));
  assert.ok(agentLine.lines[0].includes('Agent「对话3」'), `修改者身份照 whoOf 显示：${agentLine.lines[0]}`);

  const three = notice({ done: true, skipped: skipped(3), failed: [] }, opts(false));
  assert.equal(three.lines.length, 3, '恰好 3 处全列');
  const five = notice({ done: true, skipped: skipped(5), failed: [] }, opts(false));
  assert.equal(five.lines.length, 3, '多于 3 处：前 2 处 + 折叠行');
  assert.match(five.lines[2], /^等 ?(3|5) ?处/, `折叠行：${five.lines[2]}`);
  assert.ok(five.lines[2].includes('点击展开'), five.lines[2]);
});

// ------------------------------------------------------------------ V7 页面侧：.proc 等确认后才写（B7）

test('C65B-V7-01 页面保存 .proc：有未确认的操作时等确认后才序列化，写出的内容与文档服务确认的那一版一致', async () => {
  await registerTs();
  const whenConfirmed = await loadProcWhenConfirmed();
  const { actions, getState } = await import(srcHref('store/project.ts'));
  const { DocSync, bindStore } = await import(srcHref('store/docsync.ts'));
  const { MemDocService } = await import(srcHref('testing/memDocService.mjs'));

  actions.newProject('保存前');
  const p0 = getState().project;
  const svc = new MemDocService({ project: structuredClone(p0), rev: 3 });
  let link;
  const ds = new DocSync(p0, { projectId: 'P-v7', session: 'page-v7', send: (m) => link.send(m) });
  link = svc.connect('page-v7', (m) => ds.receive(m));
  const unbind = bindStore(ds);
  try {
    ds.connect();
    svc.drain();
    actions.setProjectMeta({ name: '保存时未确认' });
    assert.equal(ds.unconfirmed, 1, '有一条未确认');

    let done = null;
    const saving = whenConfirmed().then((r) => { done = r; return r; });
    saving.catch(() => {});
    await sleep(100);
    assert.equal(done, null, '还有未确认的操作时不写');

    svc.drain();
    const r = await Promise.race([saving, sleep(5000).then(() => { throw new Error('确认后 5 s 内没有写'); })]);
    const file = JSON.parse(r.text);
    assert.equal(file.project.name, '保存时未确认');
    assert.equal(svc.project.name, '保存时未确认');
    assert.deepEqual(file.project.tracks, svc.project.tracks, '写出的内容与文档服务的这一版相同');
    if (r.rev !== undefined) assert.equal(r.rev, svc.rev, '带的 rev 就是文档服务确认的版本');
  } finally {
    unbind();
  }
});
