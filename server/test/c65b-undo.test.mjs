/**
 * C6.5 batch 2: user-facing undo/redo behavior (V5 user-facing side), shortcuts, notice bar copy,
 * writing `.proc` only after confirmation (V7 page side).
 * Test cases C65B-U-*, C65B-V7-*.
 * Run: node --test server/test/c65b-undo.test.mjs
 *
 * Based on: `docs/plan/c65-design.md` sections 4, 8, 13, section 11 V5, V7;
 * `docs/plan/c65-undo-draft.md` sections 1-3 and copy tables.
 * Batch 1 already pinned the fundamentals of V5 in `c65-undo.test.mjs` (C65-V5-01..05); this adds
 * the three "who changed it" identities, redo side, shortcuts, and copy. Interfaces unspecified
 * in the design draft are centralized in `c65b-kit.mjs` (assumptions B5, B7, B8, B9).
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
  /** Another write identity directly commits a set. */
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

// ------------------------------------------------------------------ Partially not undone / completely not undone: entities and "who changed it"

test('C65B-U-01 partly not undone: returns the entities that were not undone and the write identity that changed them, telling apart an Agent\'s chat, another member, and you on another page; the rest are undone as usual', async (t) => {
  const { env, open, writeAs } = await setup(t);
  const A = await open({ user: 'alice', dev: 'dev-a', session: 'page-a' });
  A.edit((p) => { for (const i of [1, 2, 3, 4]) clipOf(p, `c${i}`).label = `A${i}`; });
  await A.settled();

  await writeAs({ user: 'alice', dev: 'dev-a', role: 'agent', conv: 7 }, 'conv-7', `${clip('c1')}/label`, 'Agent');
  await writeAs({ user: 'bob', dev: 'dev-b' }, 'page-b', `${clip('c2')}/label`, 'Bob');
  const last = await writeAs({ user: 'alice', dev: 'dev-a' }, 'page-a2', `${clip('c3')}/label`, 'Another page');
  await waitFor(() => A.sync.rev >= last.rev, 5000, 'A received three changes');

  const res = await A.undo();
  assert.equal(res.done, true, `c4 was undone, counts as undone: ${JSON.stringify(res)}`);
  const m = skippedMap(res);
  assert.deepEqual([...m.keys()].sort(), [clip('c1'), clip('c2'), clip('c3')], `the three places not undone: ${JSON.stringify(res.skipped)}`);
  assert.equal(m.get(clip('c1')).role, 'agent', `c1 was changed by the Agent: ${JSON.stringify(m.get(clip('c1')))}`);
  assert.equal(m.get(clip('c1')).conversation, 7, 'identifies which chat it was');
  assert.equal(m.get(clip('c2')).userId, uid('bob', 'dev-b'), 'c2 was changed by another member');
  assert.equal(m.get(clip('c3')).userId, uid('alice', 'dev-a'), 'c3 is the same user, same device');
  assert.equal(m.get(clip('c3')).session, 'page-a2', '…on another page');

  await A.settled();
  const st = await stateOf(env);
  assert.deepEqual([1, 2, 3, 4].map((i) => clipOf(st.project, `c${i}`).label), ['Agent', 'Bob', 'Another page', 'Clip 4'], 'undo only c4, which nobody else has changed');
});

test('C65B-U-02 nothing undone: no commit is produced, nothing goes onto the redo stack; the returned list likewise carries the entities and who changed them', async (t) => {
  const { env, open, writeAs } = await setup(t);
  const A = await open({ user: 'alice', dev: 'dev-a', session: 'page-a' });
  A.edit((p) => { clipOf(p, 'c1').label = 'A1'; clipOf(p, 'c2').label = 'A2'; });
  await A.settled();
  await writeAs({ user: 'bob', dev: 'dev-b' }, 'page-b', `${clip('c1')}/label`, 'Bob1');
  const last = await writeAs({ user: 'alice', dev: 'dev-a', role: 'agent', conv: 4 }, 'conv-4', `${clip('c2')}/label`, 'Agent2');
  await waitFor(() => A.sync.rev >= last.rev, 5000, 'A received two changes');
  const revBefore = (await stateOf(env)).rev;

  const res = await A.undo();
  assert.equal(res.done, false, 'nothing was undone at any place');
  const m = skippedMap(res);
  assert.equal(m.get(clip('c1'))?.userId, uid('bob', 'dev-b'));
  assert.equal(m.get(clip('c2'))?.role, 'agent');
  assert.equal(A.canRedo(), false, 'a step where nothing was undone does not go onto the redo stack');
  assert.equal(A.canUndo(), false, 'this step is popped off the stack as well');
  await sleep(150);
  assert.equal((await stateOf(env)).rev, revBefore, 'no commit');
});

test('C65B-U-03 redo works the same way: when only some are not redone, it returns the entities not redone and who changed them; a step where nothing was redone does not go onto the undo stack', async (t) => {
  const { env, open, writeAs } = await setup(t);
  const A = await open({ user: 'alice', dev: 'dev-a', session: 'page-a' });
  A.edit((p) => { clipOf(p, 'c1').label = 'A1'; clipOf(p, 'c2').label = 'A2'; });
  await A.settled();
  assert.equal((await A.undo()).done, true);
  await A.settled();
  const r1 = await writeAs({ user: 'bob', dev: 'dev-b' }, 'page-b', `${clip('c1')}/label`, 'Bob1');
  await waitFor(() => A.sync.rev >= r1.rev, 5000, 'A received Bob\'s change');
  const redo = await A.redo();
  assert.equal(redo.done, true, JSON.stringify(redo));
  assert.deepEqual((redo.skipped ?? []).map((s) => [s.entity, s.by?.userId]), [[clip('c1'), uid('bob', 'dev-b')]]);
  await A.settled();
  let st = await stateOf(env);
  assert.equal(clipOf(st.project, 'c1').label, 'Bob1');
  assert.equal(clipOf(st.project, 'c2').label, 'A2', 'c2 is back after redo');

  // Completely not redone: opens another page session with clean state
  const B = await open({ user: 'alice', dev: 'dev-a', session: 'page-b2' });
  B.edit((p) => { clipOf(p, 'c3').label = 'B3'; clipOf(p, 'c4').label = 'B4'; });
  await B.settled();
  assert.equal((await B.undo()).done, true);
  await B.settled();
  await writeAs({ user: 'bob', dev: 'dev-b' }, 'page-b', `${clip('c3')}/label`, 'Bob3');
  const r2 = await writeAs({ user: 'bob', dev: 'dev-b' }, 'page-b', `${clip('c4')}/label`, 'Bob4');
  await waitFor(() => B.sync.rev >= r2.rev, 5000, 'B received Bob\'s change');
  const revBefore = (await stateOf(env)).rev;
  const none = await B.redo();
  assert.equal(none.done, false);
  assert.equal(none.skipped.length, 2);
  assert.equal(B.canUndo(), false, 'a step where nothing was redone does not go onto the undo stack');
  assert.equal(B.canRedo(), false, 'also popped off the redo stack');
  await sleep(150);
  st = await stateOf(env);
  assert.equal(st.rev, revBefore, 'no commit');
});

// ------------------------------------------------------------------ Shortcuts (B5)

test('C65B-U-04 keyboard shortcuts: Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y both redo (same for Cmd); when focus is in an input box, leave it to the input box', async () => {
  const action = await loadShortcut();
  assert.equal(action(keyEvent('z', { ctrl: true })), 'undo');
  assert.equal(action(keyEvent('Z', { ctrl: true, shift: true })), 'redo', 'Ctrl+Shift+Z');
  assert.equal(action(keyEvent('z', { ctrl: true, shift: true })), 'redo', 'Ctrl+Shift+Z (lowercase key)');
  assert.equal(action(keyEvent('y', { ctrl: true })), 'redo', 'Ctrl+Y is equivalent to redo');
  assert.equal(action(keyEvent('Y', { ctrl: true })), 'redo');
  assert.equal(action(keyEvent('z', { meta: true })), 'undo', 'Cmd+Z');
  assert.equal(action(keyEvent('y', { meta: true })), 'redo', 'Cmd+Y');
  assert.equal(action(keyEvent('z')), null, 'without Ctrl it does not count');
  assert.equal(action(keyEvent('y')), null);
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(action(keyEvent('z', { ctrl: true, target })), null, `when focus is in ${target.tagName}, leave it to the input box`);
    assert.equal(action(keyEvent('y', { ctrl: true, target })), null);
  }
});

test('C65B-U-05 Ctrl+Y and Ctrl+Shift+Z have the same effect on the page: both redo the step that was just undone', async (t) => {
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
    A.edit((p) => { clipOf(p, 'c1').label = `Press ${redoKey.key}`; });
    await A.settled();
    await run(keyEvent('z', { ctrl: true }));
    await A.settled();
    assert.equal(clipOf((await stateOf(env)).project, 'c1').label, 'Clip 1');
    const r = await run(redoKey);
    assert.ok(r, `${redoKey.key} triggered redo`);
    await A.settled();
    assert.equal(clipOf((await stateOf(env)).project, 'c1').label, `Press ${redoKey.key}`);
    A.edit((p) => { clipOf(p, 'c1').label = 'Clip 1'; });
    await A.settled();
  }
});

// ------------------------------------------------------------------ Notice bar copy (B8)

const by = (userId, extra = {}) => ({ actor: { userId, role: 'page', ...extra }, session: 's' });
const skipped = (n) => Array.from({ length: n }, (_, i) => ({ entity: clip(`c${i + 1}`), by: by(`u${i}@d`) }));

test('C65B-U-06 notice text: partly not undone / nothing undone / redo, two kinds; each line is "entity (modified by whom)"; more than 3 places collapse; no notice when the undo succeeded', async () => {
  const notice = await loadUndoNotice();
  const nameOf = (e) => `clip "${e.split('@').pop()}"`;
  const whoOf = (b) => (b?.actor?.role === 'agent' ? `Agent "chat ${b.actor.conversation}"` : `member ${(b?.actor?.userId ?? '').split('@')[0]}`);
  const opts = (redo) => ({ redo, nameOf, whoOf });

  assert.equal(notice({ done: true, skipped: [], failed: [] }, opts(false)) ?? null, null, 'no notice when everything was undone');

  const partial = notice({ done: true, skipped: skipped(1), failed: [] }, opts(false));
  assert.equal(partial.title, 'Undone, but these were overwritten by later changes and not reverted:');
  assert.equal(partial.lines.length, 1);
  assert.ok(partial.lines[0].includes('clip "c1"') && partial.lines[0].includes('member u0') && partial.lines[0].includes('changed by'), partial.lines[0]);

  const all = notice({ done: false, skipped: skipped(2), failed: [] }, opts(false));
  assert.equal(all.title, "Couldn't undo. These were all changed afterwards, so they keep their current state:");
  assert.equal(all.lines.length, 2);

  assert.equal(notice({ done: true, skipped: skipped(1), failed: [] }, opts(true)).title, 'Redone, but these were overwritten by later changes and not restored:');
  assert.equal(notice({ done: false, skipped: skipped(1), failed: [] }, opts(true)).title, "Couldn't redo. These items were changed afterwards, so they keep their current state:");

  const agentLine = notice({ done: true, skipped: [{ entity: clip('c9'), by: { actor: { userId: 'a@d', role: 'agent', conversation: 3 }, session: 'conv-3' } }], failed: [] }, opts(false));
  assert.ok(agentLine.lines[0].includes('Agent "chat 3"'), `the modifier's identity is shown as whoOf renders it: ${agentLine.lines[0]}`);

  const three = notice({ done: true, skipped: skipped(3), failed: [] }, opts(false));
  assert.equal(three.lines.length, 3, 'exactly 3 places are all listed');
  const five = notice({ done: true, skipped: skipped(5), failed: [] }, opts(false));
  assert.equal(five.lines.length, 3, 'more than 3 places: first 2 places + a collapsed line');
  assert.match(five.lines[2], /^and (3|5) more/, `collapsed line: ${five.lines[2]}`);
  assert.ok(five.lines[2].includes('click to expand'), five.lines[2]);
});

// ------------------------------------------------------------------ V7 page side: write .proc only after confirmation (B7)

test('C65B-V7-01 page saves .proc: when there are unconfirmed operations, it serializes only after they are confirmed, and the written content matches the version confirmed by the document service', async () => {
  await registerTs();
  const whenConfirmed = await loadProcWhenConfirmed();
  const { actions, getState } = await import(srcHref('store/project.ts'));
  const { DocSync, bindStore } = await import(srcHref('store/docsync.ts'));
  const { MemDocService } = await import(srcHref('testing/memDocService.mjs'));

  actions.newProject('Before save');
  const p0 = getState().project;
  const svc = new MemDocService({ project: structuredClone(p0), rev: 3 });
  let link;
  const ds = new DocSync(p0, { projectId: 'P-v7', session: 'page-v7', send: (m) => link.send(m) });
  link = svc.connect('page-v7', (m) => ds.receive(m));
  const unbind = bindStore(ds);
  try {
    ds.connect();
    svc.drain();
    actions.setProjectMeta({ name: 'Unconfirmed at save time' });
    assert.equal(ds.unconfirmed, 1, 'there is one unconfirmed operation');

    let done = null;
    const saving = whenConfirmed().then((r) => { done = r; return r; });
    saving.catch(() => {});
    await sleep(100);
    assert.equal(done, null, 'does not write while operations are still unacknowledged');

    svc.drain();
    const r = await Promise.race([saving, sleep(5000).then(() => { throw new Error('no write within 5 s after confirmation'); })]);
    const file = JSON.parse(r.text);
    assert.equal(file.project.name, 'Unconfirmed at save time');
    assert.equal(svc.project.name, 'Unconfirmed at save time');
    assert.deepEqual(file.project.tracks, svc.project.tracks, 'the written content is identical to this version in the document service');
    if (r.rev !== undefined) assert.equal(r.rev, svc.rev, 'the rev carried is the version confirmed by the document service');
  } finally {
    unbind();
  }
});
