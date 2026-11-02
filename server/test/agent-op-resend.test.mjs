/**
 * After Agent commit (`project.op`) times out waiting for response, the same opId is resent as-is
 * (in production on 2026-10-21 switch_cut reported "no response within 15000 ms", which actually
 * landed about 60 seconds later; `docs/archive/agent-reports/AGENT-cut-stream-fix.md` defect 5).
 *
 *   AOR1  Times out waiting for response first two times, returns `project.op.ok` (duplicate) third
 *         time: tool succeeds, write recorded in ctx.write; all three sends share the same opId and
 *         same batch of ops
 *   AOR2  Times out continuously: reports timeout as usual after resending `opResends` times (does
 *         not wait indefinitely)
 *   AOR3  Returns `project.op.rejected` (stale), does not resend
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentExecutor } from '../agent/agent-exec.mjs';

function fakeLink(replies) {
  const sent = [];
  const project = { name: 'a', tracks: [] };
  const replica = { project, rev: 5, hasBody: true, offer() {}, async waitRev() {} };
  return {
    sent, projectId: 'p1', replica,
    async ready() {},
    conversation() {
      return {
        async request(message) {
          sent.push(message);
          const r = replies.shift() ?? 'timeout';
          if (r === 'timeout') throw Object.assign(new Error(`${message.type} got no reply within 15000 ms`), { code: 'timeout' });
          return r;
        },
      };
    },
  };
}

const host = {
  setProject(p) { this.p = p; }, getProject() { return this.p; }, routeOf: () => true,
  diffProject: (a, b) => ({ ops: [{ op: 'set', path: '/name', value: b.name }], inverse: [{ op: 'set', path: '/name', value: a.name }] }),
};

const run = (link) => {
  const logs = [];
  const exec = createAgentExecutor({ link, loadHost: async () => host, log: (event, fields) => logs.push({ event, ...fields }) });
  const ctx = {};
  return { logs, ctx, go: () => exec.mutate('switch_cut', 'conv', ctx, (h) => { h.setProject({ ...h.getProject(), name: 'b' }); return { ok: true }; }) };
};

test('AOR1 the first two time out, the third replies ok: the tool succeeds, and all three use the same opId', async () => {
  const link = fakeLink(['timeout', 'timeout', { type: 'project.op.ok', rev: 6, duplicate: true }]);
  const r = run(link);
  const out = await r.go();
  assert.equal(out.rev, 6);
  assert.equal(r.ctx.write?.rev, 6);
  const ops = link.sent.filter((m) => m.type === 'project.op');
  assert.equal(ops.length, 3);
  assert.equal(new Set(ops.map((m) => m.opId)).size, 1);
  assert.equal(new Set(ops.map((m) => JSON.stringify(m.ops))).size, 1);
  assert.ok(r.logs.some((l) => l.event === 'agent.op-slow' && l.attempts === 3));
});

test('AOR2 it times out every time: after several resends it still reports timeout', async () => {
  const link = fakeLink([]);
  const r = run(link);
  await assert.rejects(r.go(), (e) => e.code === 'timeout');
  assert.equal(link.sent.filter((m) => m.type === 'project.op').length, 5);
});

test('AOR3 stale is not resent', async () => {
  const link = fakeLink([{ type: 'project.op.rejected', reason: 'stale', currentRev: 7, since: [] }]);
  const r = run(link);
  await assert.rejects(r.go(), (e) => e.code === 'stale');
  assert.equal(link.sent.filter((m) => m.type === 'project.op').length, 1);
});
