import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createDocService } from '../docservice/service.mjs';
import { projectModule } from '../docservice/modules/project.mjs';
import { mountSelection } from '../docservice/modules/selection.mjs';
import { createAgentInstance } from '../agent/service/instance.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const projectId = 'selection-project';
const script = steps => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;

test('account get_selection uses the active Agent data connection for all live members and doc-owned offline snapshot',
  { timeout: 30000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-live-selection-'));
    const active = new Set(['alice', 'bob', 'carol']);
    let grantEnabled = true, headAvailable = true, pageCalls = 0;
    const project = projectModule();
    const selection = mountSelection({ project,
      checkAccess: async ({ principal, projectId: target }) => {
        if (!headAvailable) throw Object.assign(new Error('head unavailable'), { status: 503 });
        return target === projectId && active.has(principal.accountId)
          ? { allowed: true, accountId: principal.accountId, projectId: target,
            accountName: `${principal.accountId}-trusted` } : false;
      },
      authorizeQuery: async ({ projectId: target, runGrantId }) => grantEnabled && target === projectId && runGrantId === 'grant-1'
        ? { projectId, runGrantId, fenceRevision: 1, initiatorAccountId: 'alice', initiatorName: 'alice-trusted',
          selectionSnapshot: { source: 'sent-snapshot', projectId, accountId: 'alice', pageId: 'sent-page',
            selection: { clipIds: ['c2'] }, sentAt: 1000 } } : null,
      now: () => 2000,
    });
    const authenticate = req => {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const role = String(req.headers['sec-websocket-protocol'] ?? '').includes('promptcut.role.agent') ? 'agent' : 'page';
      if (role === 'agent') return { userId: 'trusted-agent', tenantId: projectId, role, service: 'agent' };
      const accountId = query.get('account');
      return { userId: accountId, tenantId: query.get('project') ?? projectId,
        role, accountId, accountName: 'initial-untrusted', loginId: query.get('login') ?? 'L1' };
    };
    const doc = createDocService({ modules: [project, selection], authenticate, autoTick: false, log: () => {} });
    const { port } = await doc.listen(0, '127.0.0.1');
    const url = `ws://127.0.0.1:${port}/`;
    const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] } });
    const pages = [];
    let inst, handle;
    const logs = [];
    t.after(async () => {
      handle?.abort(); await handle?.drain(); inst?.close('test-close');
      for (const page of pages) page.close();
      await Promise.all(pages.map(page => page.closed));
      await doc.close(); await vite.close(); fs.rmSync(dir, { recursive: true, force: true });
    });
    let seq = 0;
    const ask = async (client, message) => {
      const reqId = `request-${++seq}`;
      client.send({ ...message, reqId }); return client.next(reply => reply.reqId === reqId);
    };
    const page = async (account, login = 'L1') => {
      const client = wsClient(`${url}?account=${account}&login=${login}`);
      pages.push(client); await client.opened; return client;
    };
    const a1 = await page('alice'), a2 = await page('alice', 'L2');
    const bob = await page('bob'), carol = await page('carol');
    await ask(a1, { type: 'project.open', projectId });
    const seeded = await ask(a1, { type: 'project.op', projectId, opId: 'seed',
      ops: [{ op: 'set', path: '', value: { id: projectId, tracks: [{ id: 't1', clips: [
        { id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' } ] }] } }] });
    assert.equal(seeded.type, 'project.op.ok');
    for (const [client, pageId, clipIds] of [[a1, 'a1', ['c1', 'gone']], [a2, 'a2', ['c2']],
      [bob, 'b1', ['c1']], [carol, 'c1', []]]) {
      assert.equal((await ask(client, { type: 'selection.set', projectId, pageId, revision: 1,
        selection: { clipIds }, username: 'forged' })).type, 'selection.ok');
    }
    inst = createAgentInstance({ profile: 'hosted', accountMode: true,
      accountSelection: Object.freeze({ projectId, conversationId: 'conv1', runId: 'run-1', runGrantId: 'grant-1' }),
      server: { httpServer: null, ssrLoadModule: id => vite.ssrLoadModule(id),
        config: { root: ROOT }, middlewares: { use() {} } },
      latestMirror: () => null, latestPlayhead: () => null, projectId,
      identity: { userId: 'alice', username: 'alice-trusted' }, ownerKey: 'fixture-owner',
      docUrl: url, protocolsFor: async n => ['promptcut.v1', `promptcut.role.agent.${n}`],
      execSerial: fn => Promise.resolve().then(fn), initiatorOnline: () => false,
      pageCall: async () => { pageCalls++; throw new Error('old page route must not run'); },
      log: (event, fields) => logs.push({ event, ...fields }) });
    await inst.bindAgent({ projectId, mode: 'hosted' });
    const beforeRun = await inst.callTool('get_selection', {}, 'conv1');
    assert.equal(beforeRun.code, 'selection-unavailable', 'a grant alone does not activate the run');
    assert.throws(() => inst.startHostedRun({ runId: 'forged-run', conversationId: 'conv1' }),
      { code: 'run-record-mismatch' }, 'a different run cannot borrow this binding');
    const events = [];
    handle = inst.startHostedRun({ runId: 'run-1', conversationId: 'conv1',
      prompt: script([{ tool: 'get_selection', input: {} }, { sleepMs: 6000 }, { say: 'done' }]),
      apiConfig: { vendor: 'mock', model: 'mock-1' }, model: 'mock-1',
      historyFile: path.join(dir, 'history.json'), onEvent: event => events.push(event) });
    await waitFor(() => events.some(event => event.type === 'tool_result'), 30_000, 'actual model tool route');
    const state = await inst.callTool('get_selection', { projectId: 'other', username: 'forged' }, 'conv1');
    assert.equal(state.ok, true, JSON.stringify({ state, events: events.map(event => event.type), logs }));
    assert.equal(state.projectId, projectId);
    assert.deepEqual(state.members.map(member => member.accountId), ['alice', 'bob', 'carol']);
    assert.equal(state.members[0].displayName, 'alice-trusted（当前用户）');
    assert.deepEqual(state.members[0].pages.map(page => page.pageId), ['a1', 'a2']);
    assert.deepEqual(state.members[0].pages[0].items.map(item => [item.id, !!item.missing]),
      [['c1', false], ['gone', true]]);
    assert.deepEqual(state.members[2].pages[0].selection.clipIds, []);
    assert.equal(JSON.stringify(state).includes('forged'), false);
    assert.equal(pageCalls, 0, 'account get_selection never used the old page route');
    assert.equal((await inst.callTool('get_selection', {}, 'other-conversation')).code, 'selection-unavailable');
    a1.close(); a2.close(); await Promise.all([a1.closed, a2.closed]);
    active.delete('alice'); selection.revoke({ projectId, accountId: 'alice' });
    const offline = await inst.callTool('get_selection', {}, 'conv1');
    assert.equal(offline.ok, true);
    assert.deepEqual(offline.members[0].pages.map(page => [page.live, page.source, page.note]),
      [[false, 'sent-snapshot', '发消息时的选区，非实时']]);
    assert.equal(offline.members.some(member => member.accountId === 'bob'), true);
    grantEnabled = false;
    const revoked = await inst.callTool('get_selection', {}, 'conv1');
    assert.equal(revoked.code, 'selection-unavailable');
    assert.equal(revoked.members, undefined, 'doc denial never falls back to the old snapshot');
    grantEnabled = true; headAvailable = false;
    const unreachable = await inst.callTool('get_selection', {}, 'conv1');
    assert.equal(unreachable.code, 'selection-unavailable');
    assert.equal(unreachable.members, undefined);
    assert.equal(pageCalls, 0);
  });
