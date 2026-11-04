/**
 * C6.5 batch 2: Agent directly writes to document service (D1, D4) and tool call events (D2).
 * Test cases C65B-D1-*, C65B-D2-*.
 * Run: node --test server/test/c65b-agent.test.mjs
 *
 * Basis: `docs/plan/c65-design.md` Sections 5, 7, 8 and Section 11 V3; D1, D2, D4 of
 * `docs/plan/cloud-task.md`.
 * Written only against the design doc without looking at `c65-agent` and `c65-editor`
 * implementations. Interfaces left open by the design doc are gathered in `c65b-kit.mjs`
 * (assumptions B1-B4, B9).
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

/** A raw connection with page role opens the project; edit(path, value) submits a set, waits for ok */
async function rawPage(env, { user, dev = `dev-${user}`, session = `page-${user}` }) {
  const c = await env.connect({ user, dev });
  await openProject(c, PID);
  return {
    c,
    async set(path, value) {
      const r = await submit(c, { projectId: PID, ops: [{ op: 'set', path, value }], session });
      assert.ok(isOk(r), `${user}'s commit should land: ${JSON.stringify(r)}`);
      return r;
    },
  };
}

/** Broadcasts received by the observer whose path matches prefix */
const opsTouching = (w, prefix) => w.ops().filter((m) => (m.ops ?? []).some((o) => o.path === prefix || o.path.startsWith(`${prefix}/`)));

// ------------------------------------------------------------------ D1: write tools execute on server, commit as Agent

test('C65B-D1-01 write tools run on the Agent server: edits work with no page online; one commit is made as an agent identity (role, chat number); it does not go through a page', async (t) => {
  const { env, w, agent } = await setup(t, { conversation: 7 });
  const before = await stateOf(env);
  const r = await agent.call('update_clip', { clipId: 'c1', label: 'Agent edit' });
  assert.ok(r.ok, `write tools still succeed with no page online: ${r.text.slice(0, 400)}`);

  const st = await stateOf(env);
  assert.equal(clipOf(st.project, 'c1').label, 'Agent edit', 'the project in the document service has been changed');
  assert.equal(st.rev, before.rev + 1, 'one tool call = one commit, version number plus one');

  await waitFor(() => opsTouching(w, C1).length === 1, 3000, 'the observer receives that commit from the Agent');
  const [op] = opsTouching(w, C1);
  assert.equal(op.actor?.role, 'agent', `the writer identity's role is agent: ${JSON.stringify(op.actor)}`);
  assert.equal(op.actor?.conversation, 7, 'the writer identity carries the chat number');
  assert.equal(op.actor?.userId, uid('alice', 'dev-a'), 'userId is taken from the connection credentials');
  assert.ok(!agent.pageCalls.some((c) => c.tool === 'update_clip'), `write tools do not go through a page: ${JSON.stringify(agent.pageCalls)}`);
});

test('C65B-D1-02 expected version (V3): after the Agent reads, a page changes the same entity, and the Agent\'s write-back errors with a since summary (entity, who changed it); after re-reading, the write succeeds', async (t) => {
  const { env, agent } = await setup(t);
  const read = await agent.call('get_project');
  assert.ok(read.ok, read.text.slice(0, 300));
  const st0 = await stateOf(env);
  assert.equal(revOf(read), st0.rev, 'the read tool\'s response carries rev, equal to the document service\'s current version');

  const bob = await rawPage(env, { user: 'bob', dev: 'dev-b' });
  await bob.set(`${C1}/label`, 'Bob edit');
  const st1 = await stateOf(env);

  const stale = await agent.call('update_clip', { clipId: 'c1', label: 'Agent overwrite' });
  assert.equal(stale.ok, false, `the expected version does not match, and the write tool returns an error: ${stale.text.slice(0, 400)}`);
  assert.match(stale.text, /c1/, `the error includes the changed entity: ${stale.text.slice(0, 400)}`);
  assert.ok(stale.text.includes('bob'), `the error includes who changed it: ${stale.text.slice(0, 400)}`);
  const st2 = await stateOf(env);
  assert.equal(st2.rev, st1.rev, 'a rejected write does not land');
  assert.equal(clipOf(st2.project, 'c1').label, 'Bob edit');

  const reread = await agent.call('get_project');
  assert.equal(revOf(reread), st2.rev, 're-reading gets the new version');
  assert.ok(reread.text.includes('Bob edit'), 'the replica has been updated along with the document service');
  const again = await agent.call('update_clip', { clipId: 'c1', label: 'Agent rewrite' });
  assert.ok(again.ok, `writing again after re-reading succeeds: ${again.text.slice(0, 400)}`);
  assert.equal(clipOf((await stateOf(env)).project, 'c1').label, 'Agent rewrite');
});

test('C65B-D1-03 read-then-write consistency: after a successful write, the rev from ok is authoritative and the next write is not blocked by itself; the rev in the read tool\'s response follows along', async (t) => {
  const { env, agent } = await setup(t);
  await agent.call('get_project');
  const a = await agent.call('update_clip', { clipId: 'c1', label: 'First time' });
  assert.ok(a.ok, a.text.slice(0, 300));
  const b = await agent.call('update_clip', { clipId: 'c2', label: 'Second time' });
  assert.ok(b.ok, `after its own previous write lands, the next write should not go stale because of its own commit: ${b.text.slice(0, 300)}`);
  const st = await stateOf(env);
  const read = await agent.call('get_project');
  assert.equal(revOf(read), st.rev, 'the rev in the read tool\'s response is the latest');
});

test('C65B-D1-04 the replica follows the document service: a page changes another clip, the Agent sees it on the next read, and rev is in sync', async (t) => {
  const { env, agent } = await setup(t);
  await agent.call('get_project');
  const bob = await rawPage(env, { user: 'bob', dev: 'dev-b' });
  const ok = await bob.set(`${C2}/label`, 'Changed by the page');
  let read;
  await waitFor(async () => {
    read = await agent.call('get_project');
    return revOf(read) === ok.rev;
  }, 5000, 'the Agent\'s replica catches up with the document service\'s version');
  assert.ok(read.text.includes('Changed by the page'), 'the replica content catches up');
});

test('C65B-D1-05 two chats: each commits with its own chat number; each uses the version it last read as expectRev', async (t) => {
  const { env, w, agent } = await setup(t);
  await agent.call('get_project', {}, 3);
  await agent.call('get_project', {}, 5);
  const five = await agent.call('update_clip', { clipId: 'c1', label: 'Chat 5' }, 5);
  assert.ok(five.ok, five.text.slice(0, 300));
  const three = await agent.call('update_clip', { clipId: 'c1', label: 'Chat 3' }, 3);
  assert.equal(three.ok, false, `chat 3 read an old version, so its write-back errors: ${three.text.slice(0, 300)}`);
  assert.match(three.text, /c1/);
  await agent.call('get_project', {}, 3);
  const again = await agent.call('update_clip', { clipId: 'c1', label: 'Chat 3' }, 3);
  assert.ok(again.ok, again.text.slice(0, 300));
  await waitFor(() => opsTouching(w, C1).length === 2, 3000, 'both commits were broadcast');
  assert.deepEqual(opsTouching(w, C1).map((m) => [m.actor?.role, m.actor?.conversation]), [['agent', 5], ['agent', 3]]);
  assert.equal(clipOf((await stateOf(env)).project, 'c1').label, 'Chat 3');
});

// ------------------------------------------------------------------ D1 / D4: execution location

test('C65B-D1-06 each tool is labeled with its side: write tools and get_project / get_layout are on the Agent server; selection, playhead and web_handoff stay on the page', async () => {
  const tools = await loadTools();
  const byName = new Map(tools.map((x) => [x.name, x]));
  const unlabeled = tools.filter((x) => sideOf(x) === undefined).map((x) => `${x.name}=${x.side}`);
  assert.deepEqual(unlabeled, [], 'every tool is labeled with where it executes');
  const agentSide = ['add_clip', 'update_clip', 'remove_clip', 'set_project_meta', 'set_rect', 'add_track', 'create_filter', 'get_project', 'get_layout'];
  const pageSide = ['get_selection', 'user_interface_seek', 'user_interface_play', 'user_interface_pause', 'user_interface_web_handoff'];
  for (const n of [...agentSide, ...pageSide]) assert.ok(byName.has(n), `the tool table contains ${n}`);
  assert.deepEqual(agentSide.filter((n) => sideOf(byName.get(n)) !== 'agent').map((n) => `${n}=${byName.get(n).side}`), [], 'write tools and D4\'s read tools are on the Agent server');
  assert.deepEqual(pageSide.filter((n) => sideOf(byName.get(n)) !== 'page').map((n) => `${n}=${byName.get(n).side}`), [], 'tools that only read page-only state stay on the page');
});

test('C65B-D1-07 tools that stay on the page are still executed through the page: get_selection and seek take the page route; they do not write to the project', async (t) => {
  const { env, agent } = await setup(t);
  const rev0 = (await stateOf(env)).rev;
  await agent.call('get_selection');
  await agent.call('user_interface_seek', { t: 1 });
  await agent.call('seek', { t: 2 });
  // Sent to page is the old internal operation name (old and new names call the same), 0.7.18 pages
  // also recognize it
  assert.deepEqual(agent.pageCalls.map((c) => c.tool), ['get_selection', 'seek', 'seek'], `page-side tools go through the page: ${JSON.stringify(agent.pageCalls)}`);
  assert.equal((await stateOf(env)).rev, rev0, 'page-side tools produce no commits');
});

// ------------------------------------------------------------------ D2: tool call events

test('C65B-D2-01 each tool call yields two events (create, complete) on the project channel; the full parameters are in event-detail', async (t) => {
  const { w, agent } = await setup(t, { conversation: 9 });
  const r = await agent.call('update_clip', { clipId: 'c1', label: 'Event' });
  assert.ok(r.ok, r.text.slice(0, 300));
  const { create, complete } = await eventPairOf(w, 'update_clip');
  const evs = w.events();
  assert.ok(evs.indexOf(create) < evs.indexOf(complete), 'created first, completed after');
  assert.equal(typeof create.args, 'string', 'the create event carries a parameter summary');
  assert.ok(create.args.length > 0);
  assert.match(String(create.target ?? ''), /c1/, `the create event carries the target clip: ${JSON.stringify(create)}`);
  assert.equal(complete.status, 'ok');
  assert.equal(typeof complete.durationMs, 'number', 'the complete event carries the duration');
  for (const e of [create, complete]) {
    assert.equal(e.actor?.role, 'agent');
    assert.equal(e.actor?.conversation, 9);
  }
  const detail = await detailOf(w.c, create);
  assert.ok(detail !== undefined, 'the full parameters were written to the content store event-detail');
  const text = JSON.stringify(detail);
  assert.ok(text.includes('"clipId":"c1"') && text.includes('Event'), `event-detail holds the full parameters: ${text.slice(0, 300)}`);

  // Read tools also have two
  await agent.call('get_project');
  const pair = await eventPairOf(w, 'get_project');
  assert.equal(pair.complete.status, 'ok');
});

test('C65B-D2-02 a write tool\'s event carries opId and inverse: opId is the commit in the broadcast, and inverse can restore the entity; read tools and rejected writes carry neither', async (t) => {
  const { env, w, agent } = await setup(t);
  const { apply } = await loadJsonOps();
  const before = await stateOf(env);
  await agent.call('get_project');
  await agent.call('update_clip', { clipId: 'c1', label: 'With inverse' });
  const pair = await eventPairOf(w, 'update_clip');
  const detail = await detailOf(w.c, pair.create);
  const info = undoInfoOf({ ...pair, detail });
  await waitFor(() => opsTouching(w, C1).length === 1, 3000, 'broadcast');
  assert.equal(info.opId, opsTouching(w, C1)[0].opId, `the opId in the event is that commit: ${JSON.stringify(pair.complete)}`);
  assert.ok(Array.isArray(info.inverse) && info.inverse.length > 0, `the event carries inverse: ${JSON.stringify(info)}`);
  const after = await stateOf(env);
  const back = apply(structuredClone(after.project), info.inverse);
  assert.ok(back.ok, `inverse can be applied to the current version: ${back.reason}`);
  assert.deepEqual(clipOf(back.doc, 'c1'), clipOf(before.project, 'c1'), 'inverse restores the clip');

  const read = await eventPairOf(w, 'get_project');
  const readInfo = undoInfoOf({ ...read, detail: await detailOf(w.c, read.create) });
  assert.ok(readInfo.opId === undefined && !(readInfo.inverse?.length), `read-only tools carry no undo info (the AI panel does not show "Undo this step"): ${JSON.stringify(readInfo)}`);

  // Rejected write: completion event records error, without opId
  const bob = await rawPage(env, { user: 'bob', dev: 'dev-b' });
  await bob.set(`${C2}/label`, 'Bob');
  const stale = await agent.call('update_clip', { clipId: 'c2', label: 'Cannot overwrite' });
  assert.equal(stale.ok, false);
  const rej = await eventPairOf(w, 'update_clip', { nth: 1 });
  assert.equal(rej.complete.status, 'error', 'for a rejected write, the complete event\'s status is error');
  assert.equal(undoInfoOf(rej).opId, undefined, 'a write that did not land has no opId');
});

// ------------------------------------------------------------------ D2 × Section 8: AI panel "Undo this step"

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

test('C65B-D2-03 the page commits inverse + undoOf from the event: the entity is restored; this write counts as the user\'s page session and goes into the user\'s own undo stack (Ctrl+Z restores the Agent\'s change)', async (t) => {
  const { env, w, agent, A } = await pageAndAgent(t);
  await agent.call('get_project');
  const r = await agent.call('update_clip', { clipId: 'c1', label: 'Agent\'s' });
  assert.ok(r.ok, r.text.slice(0, 300));
  await waitFor(() => clipOf(A.project, 'c1').label === 'Agent\'s', 5000, 'the page receives the Agent\'s change');
  assert.equal(A.canUndo(), false, 'the Agent\'s change does not enter the page\'s undo stack');

  const info = await agentStep(w, 'update_clip');
  const res = await undoAgentStep(A.sync.ds, info);
  assert.equal(res?.done, true, `undoing this step succeeds: ${JSON.stringify(res)}`);
  assert.deepEqual(res.skipped ?? [], []);
  await A.settled();
  assert.equal(clipOf((await stateOf(env)).project, 'c1').label, 'Clip 1', 'the clip is restored in the document service');

  await waitFor(() => w.ops().some((m) => m.undoOf === info.opId), 3000, 'the broadcast carries undoOf');
  const undoOp = w.ops().find((m) => m.undoOf === info.opId);
  assert.equal(undoOp.actor?.role, 'page', `undoing this step counts as a page write: ${JSON.stringify(undoOp.actor)}`);
  assert.equal(undoOp.session ?? undoOp.actor?.session, 'page-a', 'the writer identity is this page session');

  assert.equal(A.canUndo(), true, 'it went into the user\'s own undo stack');
  const z = await A.undo();
  assert.equal(z.done, true);
  await A.settled();
  assert.equal(clipOf((await stateOf(env)).project, 'c1').label, 'Agent\'s', 'Ctrl+Z restores the Agent\'s change');

  // Agent discovers version changed on next edit (undo doc Section 4, "Impact on Agent")
  const next = await agent.call('update_clip', { clipId: 'c1', label: 'Agent edit again' });
  assert.equal(next.ok, false, `the Agent writes back with an old version and errors: ${next.text.slice(0, 300)}`);
  assert.match(next.text, /c1/);
});

test('C65B-D2-04 undoing a step also checks for conflicts (same as V5): the Agent changed name and fps, another member then changed fps; only name is undone, and the user is told fps was not undone and who changed it', async (t) => {
  const { env, w, agent, A } = await pageAndAgent(t);
  await agent.call('get_project');
  const r = await agent.call('set_project_meta', { name: 'Agent name', fps: 60 });
  assert.ok(r.ok, r.text.slice(0, 300));
  const bob = await rawPage(env, { user: 'bob', dev: 'dev-b' });
  const ok = await bob.set('/fps', 25);
  await waitFor(() => A.sync.rev >= ok.rev, 5000, 'the page receives Bob\'s change');

  const info = await agentStep(w, 'set_project_meta');
  const res = await undoAgentStep(A.sync.ds, info);
  assert.equal(res?.done, true, JSON.stringify(res));
  assert.deepEqual((res.skipped ?? []).map((s) => s.entity), ['/meta/fps'], `only fps was not undone: ${JSON.stringify(res)}`);
  assert.ok(JSON.stringify(res.skipped[0].by).includes(uid('bob', 'dev-b')), `it states who changed it: ${JSON.stringify(res.skipped[0].by)}`);
  await A.settled();
  const st = await stateOf(env);
  assert.equal(st.project.name, 'Starting point', 'name was reverted');
  assert.equal(st.project.fps, 25, 'fps keeps Bob\'s');
});

test('C65B-D2-05 a step that is not the latest can also be undone: the Agent changes c1 and then c2, and undoing the first step touches only c1', async (t) => {
  const { env, w, agent, A } = await pageAndAgent(t);
  await agent.call('get_project');
  assert.ok((await agent.call('update_clip', { clipId: 'c1', label: 'One' })).ok);
  assert.ok((await agent.call('update_clip', { clipId: 'c2', label: 'Two' })).ok);
  await waitFor(() => clipOf(A.project, 'c2').label === 'Two', 5000, 'the page receives both steps');
  const first = await agentStep(w, 'update_clip', 0);
  const res = await undoAgentStep(A.sync.ds, first);
  assert.equal(res?.done, true, JSON.stringify(res));
  await A.settled();
  const st = await stateOf(env);
  assert.equal(clipOf(st.project, 'c1').label, 'Clip 1');
  assert.equal(clipOf(st.project, 'c2').label, 'Two', 'the later step is unaffected');
  await sleep(50);
});
