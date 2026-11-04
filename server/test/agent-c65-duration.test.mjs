/**
 * C6.5 finalize: When Agent writes on the server cause content to exceed total project duration,
 * cascading updates to total duration are submitted with the same batch of ops (lead session ruling).
 *
 * Before: The server only submitted handler changes, and total duration was backfilled once by the
 * page according to timeline rules after receiving them: that write had the page identity, and the
 * next write immediately following from this Agent chat was rejected once due to version mismatch
 * (stale).
 * Now: The executor calculates total duration (`settleDuration`) on the server replica following
 * the same rule in `src/kernel/duration.ts` and submits them together; the page recalculates
 * according to its own rules upon receipt, gets the same result, and does not perform a backfill write.
 *
 * Test cases DUR-1 to DUR-4:
 *   DUR-1 `settleDuration` pure function: follows content, preserves truncation, infers from
 *     modified total duration, leaves untouched if only renaming, empty project, at least 1 s;
 *   DUR-2 End-to-end: Agent adds a card extending past the end → total duration catches up in the
 *     same submission; page (real DocSync + page total duration rules) does not backfill; the
 *     second write immediately following is not rejected; all three copies of total duration
 *     (page, document service, Agent replica) match;
 *   DUR-3 Control: when identical changes are submitted by a writer without total duration, this
 *     page simulation does indeed backfill once (proves "no backfill" in DUR-2 is not a vacuous
 *     assertion);
 *   DUR-4 After truncation: Agent first truncates total duration, then adds a card extending past
 *     the end → total duration retains truncated value; page does not backfill, next write is not
 *     rejected.
 *
 * The page side uses real `src/store/docsync.ts` (DocSync) to connect to real document service,
 * calculating total duration according to two places in page code:
 * `pageStateAfterRemote` infers manual values upon remote changes; timeline effect calculates
 * per `effectiveDuration` and writes per `syncDuration` (at least 1 s).
 * No bindStore: server store is used by executor in the same process.
 *
 * Run: node --test server/test/agent-c65-duration.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentLink } from '../agent/doc-link.mjs';
import { createAgentExecutor, settleDuration, StaleWriteError } from '../agent/agent-exec.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { waitFor, sleep } from './fake-ws-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const toolDef = (name) => tools.find((t) => t.name === name);

/* ------------------------------------------------------------------ DUR-1 Pure function */

const clip = (id, start, end) => ({ id, cardId: 'probe', params: {}, start, end });
const proj = (duration, clips, extra = {}) => ({ name: 'p', duration, tracks: [{ id: 't1', clips }], ...extra });

test('DUR-1 settleDuration: follows the content, a truncation is kept, a changed total duration is pushed from the changed value, a rename alone does not touch it, an empty project is kept, at least 1 s', async () => {
  const rules = await import('../../src/kernel/duration.ts').catch(() => null)
    ?? (await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
      .then(async (v) => { try { return await v.ssrLoadModule('/src/kernel/duration.ts'); } finally { await v.close(); } }));
  const base = proj(5, [clip('a', 0, 5)]);

  // Add a card extending beyond the end: total duration follows to the new end
  const grown = proj(5, [clip('a', 0, 5), clip('b', 10, 14)]);
  assert.equal(settleDuration(base, grown, rules).duration, 14);
  // Content shortened: shrinks accordingly
  assert.equal(settleDuration(base, proj(5, [clip('a', 0, 3)]), rules).duration, 3);

  // Truncated before edit (total duration 3 < end 5): still keeps truncated value after adding card,
  // returns after as is
  const cut = proj(3, [clip('a', 0, 5)]);
  const cutGrown = proj(3, [clip('a', 0, 5), clip('b', 10, 14)]);
  assert.equal(settleDuration(cut, cutGrown, rules), cutGrown);
  // Truncated value is longer than new end: clamp to new end (matches min of page effectiveDuration)
  assert.equal(settleDuration(cut, proj(3, [clip('a', 0, 2)]), rules).duration, 2);

  // This write modifies total duration itself (set_project_meta truncated to 4): infer based on
  // edited value, keep 4
  const metaCut = proj(4, [clip('a', 0, 5)]);
  assert.equal(settleDuration(base, metaCut, rules), metaCut);
  // Change to a value longer than the end: cannot stretch, reverts to the end
  assert.equal(settleDuration(base, proj(9, [clip('a', 0, 5)]), rules).duration, 5);

  // Neither clips nor total duration changed (only renamed): do not touch
  const renamed = { ...base, name: 'renamed' };
  assert.equal(settleDuration(base, renamed, rules), renamed);
  // The page will not run timeline effects for this write either, so even if already inconsistent
  // before the change, do not casually adjust it here
  const loose = proj(30, [clip('a', 0, 5)]);
  const looseRenamed = { ...loose, name: 'x' };
  assert.equal(settleDuration(loose, looseRenamed, rules), looseRenamed);

  // Empty project: keep original value
  const empty = proj(30, []);
  const emptyTouched = { ...empty, tracks: [{ id: 't1', clips: [] }, { id: 't2', clips: [] }] };
  assert.equal(settleDuration(empty, emptyTouched, rules), emptyTouched);
  // Add the first card to an empty project: follow to its end
  assert.equal(settleDuration(empty, proj(30, [clip('a', 2, 6)]), rules).duration, 6);

  // At least 1 s (same as syncDuration)
  assert.equal(settleDuration(base, proj(5, [clip('a', 0, 0.4)]), rules).duration, 1);
});

/* ------------------------------------------------------------------ End-to-end environment */

async function startEnv(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/docservice`;
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const closers = [];
  t.after(async () => {
    for (const c of closers.reverse()) { try { c(); } catch { /* Closed */ } }
    await vite.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const load = (id) => vite.ssrLoadModule(id);
  const { createEmptyProject } = await load('/src/kernel/project.ts');
  const { DocSync } = await load('/src/store/docsync.ts');
  const { pageStateAfterRemote } = await load('/src/store/remotePageState.ts');
  const { contentEndOf, effectiveDuration } = await load('/src/kernel/duration.ts');

  /** Project: a 0-5 s card on t1, total duration 5 (matches content end, no backfill when page opens) */
  function project(projectId) {
    const p = createEmptyProject('duration-test');
    p.id = projectId;
    p.duration = 5;
    p.tracks = [
      { id: 't1', name: 'Visual', clips: [{ id: 'c1', cardId: 'probe', params: {}, start: 0, end: 5 }] },
      { id: 't2', name: 'empty', clips: [] },
    ];
    return p;
  }

  /** A bare connection (local page identity): send commits, read authoritative copy */
  async function raw(session) {
    const ws = new WebSocket(url);
    closers.push(() => ws.close());
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const inbox = [];
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)));
    let seq = 0;
    const next = (match, ms = 3000) => waitFor(() => { const i = inbox.findIndex(match); return i >= 0 ? inbox.splice(i, 1)[0] : null; }, ms);
    return {
      async open(projectId) {
        ws.send(JSON.stringify({ type: 'project.open', projectId, reqId: `open-${++seq}` }));
        return next((m) => m.type === 'project.state');
      },
      async commit(projectId, ops) {
        const opId = `${session}-op-${++seq}`;
        ws.send(JSON.stringify({ type: 'project.op', projectId, opId, session, ops, reqId: opId }));
        return next((m) => m.reqId === opId);
      },
    };
  }

  async function seeded(projectId) {
    const r = await raw('seed');
    await r.open(projectId);
    const reply = await r.commit(projectId, [{ op: 'set', path: '', value: project(projectId) }]);
    assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply));
    return r;
  }

  /** Real page data stream (DocSync) + page total duration rules; returns { ds, commits(), duration(), manual() } */
  async function page(projectId, session = 'page-1') {
    const ws = new WebSocket(url);
    closers.push(() => ws.close());
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const sent = [];
    const ds = new DocSync(createEmptyProject('empty'), {
      projectId, session,
      send: (m) => { if (m.type === 'project.op') sent.push(m); ws.send(JSON.stringify(m)); },
    });
    ws.addEventListener('message', (e) => ds.receive(JSON.parse(e.data)));
    // In page state, only the manual total duration value is relevant to this rule
    const st = { t: 0, selection: [], durationManual: null, playToken: 0 };
    let prev = ds.project;
    ds.on('project', (next, cause) => {
      const before = prev;
      prev = next;
      if (cause === 'commit') return;
      // docsync.ts bindStore: changes from others → page state updates accordingly (manual total duration value)
      if (cause === 'remote') {
        const patch = pageStateAfterRemote(before, next, st);
        if (patch && 'durationManual' in patch) st.durationManual = patch.durationManual;
      }
      // Timeline effect (src/editor/timeline/index.tsx) + actions.syncDuration
      // (at least 1 s, skip write if difference < 1e-6)
      queueMicrotask(() => {
        const p = ds.project;
        const target = effectiveDuration(contentEndOf(p.tracks), p.duration, st.durationManual);
        if (Math.abs(target - p.duration) <= 1e-6) return;
        const val = Math.max(1, target);
        if (Math.abs(val - p.duration) < 1e-6) return;
        ds.commit({ ...p, duration: val }, { undoable: false });
      });
    });
    ds.connect();
    await waitFor(() => ds.status === 'online', 5000);
    return { ds, st, commits: () => sent.length, duration: () => ds.project.duration };
  }

  function agent(projectId) {
    const link = createAgentLink({ url, projectId, protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`] });
    closers.push(() => link.close());
    const executor = createAgentExecutor({ link, loadHost: () => loadSsrHost(load), toolGroups });
    const call = (tool, args, key = 'conv-A') => executor.track(tool, args, key, (ctx) => executor.execute(tool, args, key, toolDef(tool), ctx));
    return { link, executor, call };
  }

  return { raw, seeded, page, agent };
}

/** Page finishes processing all received changes, sends out and confirms any backfills (if any) */
async function quiet(pg, ms = 300) {
  await sleep(ms);
  await waitFor(() => pg.ds.unconfirmed === 0, 3000);
}

/* ------------------------------------------------------------------ DUR-2 */

test('DUR-2 Agent adds a card that runs past the end: the total duration follows in the same commit; the page does not write it again; the second write right after is not rejected; the total durations of all three copies agree', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-dur');
  const pg = await env.page('proj-dur');
  assert.equal(pg.ds.rev, 1);
  assert.equal(pg.duration(), 5);
  const ag = env.agent('proj-dur');

  assert.equal((await ag.call('get_project', {})).rev, 1);
  const added = await ag.call('add_clip', { cardId: 'probe', start: 10, duration: 4, trackId: 't2' });
  assert.equal(added.rev, 2, 'adding the card lands as rev 2');

  // Page receives rev 2: calculated by page rules, total duration is already 14, do not backfill
  await waitFor(() => pg.ds.rev >= 2, 3000);
  await quiet(pg);
  assert.equal(pg.commits(), 0, 'the page did not write the total duration again');
  assert.equal(pg.duration(), 14);

  const body2 = await probe.open('proj-dur');
  assert.equal(body2.rev, 2, 'the document service has only this one commit, the card addition');
  assert.equal(body2.project.duration, 14, 'the total duration lands with the card-adding commit');

  // Immediate second write: expected version = 2 = current version, not rejected
  let second;
  try {
    second = await ag.call('update_clip', { clipId: 'c1', opacity: 0.5 });
  } catch (err) {
    assert.fail(`second write rejected: ${err instanceof StaleWriteError ? err.message : err}`);
  }
  assert.equal(second.rev, 3);
  assert.equal(ag.executor.describe().stats.stale, 0);

  await waitFor(() => pg.ds.rev >= 3, 3000);
  await quiet(pg);
  const body3 = await probe.open('proj-dur');
  assert.equal(body3.rev, 3);
  assert.equal(pg.commits(), 0);
  assert.deepEqual([pg.duration(), body3.project.duration, ag.link.replica.project.duration], [14, 14, 14], 'the total durations of the page, the document service and the Agent replica agree');
  assert.equal(JSON.stringify(pg.ds.project), JSON.stringify(body3.project), 'the page and the authoritative copy are identical item by item');
});

/* ------------------------------------------------------------------ DUR-3 control */

test('DUR-3 control case: when the same card addition is committed by a writer that does not carry the total duration, the page back-fills the total duration once by its own rules (this is how the Agent used to behave)', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-ctl');
  const pg = await env.page('proj-ctl');
  const other = await env.raw('other');
  await other.open('proj-ctl');
  const reply = await other.commit('proj-ctl', [{ op: 'insert', path: '/tracks/@t2/clips', index: 0, value: { id: 'x1', cardId: 'probe', params: {}, start: 10, end: 14 } }]);
  assert.equal(reply.type, 'project.op.ok');
  await waitFor(() => pg.ds.rev >= 2, 3000);
  await quiet(pg);
  assert.equal(pg.commits(), 1, 'the page back-filled once');
  const body = await probe.open('proj-ctl');
  assert.deepEqual([body.rev, body.project.duration], [3, 14], 'the back-fill is a separate commit (rev 3)');
});

/* ------------------------------------------------------------------ DUR-4 truncation */

test('DUR-4 after truncation: the Agent truncates the total duration and then adds a card that runs past the end, the total duration stays at the truncated value; the page does not back-fill, and the next write is not rejected', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-cut');
  const pg = await env.page('proj-cut');
  const ag = env.agent('proj-cut');

  await ag.call('get_project', {});
  const cut = await ag.call('set_project_meta', { duration: 3 });
  assert.equal(cut.rev, 2);
  await waitFor(() => pg.ds.rev >= 2, 3000);
  await quiet(pg);
  assert.deepEqual([pg.duration(), pg.st.durationManual], [3, 3], 'the page records the manual value according to the remote change');

  const added = await ag.call('add_clip', { cardId: 'probe', start: 10, duration: 4, trackId: 't2' });
  assert.equal(added.rev, 3);
  await waitFor(() => pg.ds.rev >= 3, 3000);
  await quiet(pg);
  const again = await ag.call('update_clip', { clipId: 'c1', opacity: 0.4 });
  assert.equal(again.rev, 4, 'the next write is not rejected');
  await waitFor(() => pg.ds.rev >= 4, 3000);
  await quiet(pg);

  const body = await probe.open('proj-cut');
  assert.equal(body.rev, 4);
  assert.equal(pg.commits(), 0, 'the page did not back-fill even once');
  assert.deepEqual([pg.duration(), body.project.duration, ag.link.replica.project.duration], [3, 3, 3], 'the total duration stays at the truncated value, all three copies agree');
});
