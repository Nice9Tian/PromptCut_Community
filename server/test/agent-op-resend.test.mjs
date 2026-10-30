/**
 * Agent 的提交(`project.op`)等回包超时之后,同一个 opId 原样重发(线上 2026-10-21 switch_cut 报「15000 ms 内没有回包」、
 * 其实约 60 秒后落地了;`docs/archive/agent-reports/AGENT-cut-stream-fix.md` 缺陷 5)。
 *
 *   AOR1  头两次等回包超时、第三次回 `project.op.ok`(duplicate):工具成功、写入记进 ctx.write;三次发的是同一个 opId 与同一批 ops
 *   AOR2  一直超时:重发 `opResends` 次之后照旧报 timeout(不无限等)
 *   AOR3  回 `project.op.rejected`(stale)不重发
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
          if (r === 'timeout') throw Object.assign(new Error(`${message.type} 在 15000 ms 内没有回包`), { code: 'timeout' });
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

test('AOR1 头两次超时、第三次回 ok:工具成功,三次是同一个 opId', async () => {
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

test('AOR2 一直超时:重发几次之后照旧报 timeout', async () => {
  const link = fakeLink([]);
  const r = run(link);
  await assert.rejects(r.go(), (e) => e.code === 'timeout');
  assert.equal(link.sent.filter((m) => m.type === 'project.op').length, 5);
});

test('AOR3 stale 不重发', async () => {
  const link = fakeLink([{ type: 'project.op.rejected', reason: 'stale', currentRev: 7, since: [] }]);
  const r = run(link);
  await assert.rejects(r.go(), (e) => e.code === 'stale');
  assert.equal(link.sent.filter((m) => m.type === 'project.op').length, 1);
});
