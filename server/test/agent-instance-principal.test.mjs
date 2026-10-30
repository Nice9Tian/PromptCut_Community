import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService, normalizePrincipal } from '../docservice/service.mjs';
import { wsClient } from './fake-ws-kit.mjs';

test('real WS preserves trusted instance identity; message fields cannot substitute it or export an internal capability', { timeout: 10000 }, async t => {
  const trusted = { userId: 'sender', tenantId: 'project', instanceId: 'registered-instance', instanceGeneration: 7,
    role: 'agent', servicePrincipal: { instanceSession: 'test-internal-only' }, unknown: 'not-authoritative' };
  const normalized = normalizePrincipal(trusted);
  assert.equal(normalized.instanceId, trusted.instanceId); assert.equal(normalized.instanceGeneration, 7);
  assert.equal(normalized.unknown, undefined); assert.notEqual(normalized.servicePrincipal, trusted.servicePrincipal);
  assert.deepEqual(normalizePrincipal({ userId: 'legacy', tenantId: 'project', unknown: 'drop' }), { userId: 'legacy', tenantId: 'project' });
  const actors = new Map();
  const service = createDocService({ authenticate: () => trusted, autoTick: false, log() {}, modules: [{
    name: 'instance-probe', types: ['probe.instance'],
    connect(_ctx, id, principal) { actors.set(id, principal); },
    handle(ctx, id) {
      const p = actors.get(id);
      assert.equal(p.servicePrincipal.instanceSession, 'test-internal-only');
      // Internal principal/capability is deliberately never serialized to the peer.
      ctx.send(id, { type: 'probe.instance', instanceId: p.instanceId, instanceGeneration: p.instanceGeneration,
        unknownDropped: p.unknown === undefined });
    },
  }] });
  const address = await service.listen(0, '127.0.0.1'); let client;
  t.after(async () => { client?.close(); await service.close(); if (client) await client.closed; });
  client = wsClient(`ws://127.0.0.1:${address.port}`, ['promptcut.v1', 'promptcut.session.new']);
  await client.opened; await client.next(message => message.type === 'session.welcome');
  client.send({ type: 'probe.instance', seq: 1, instanceId: 'forged', instanceGeneration: 999,
    servicePrincipal: { instanceSession: 'forged' }, principal: { instanceId: 'forged' } });
  assert.deepEqual(await client.next(message => message.type === 'probe.instance'),
    { type: 'probe.instance', instanceId: trusted.instanceId, instanceGeneration: 7, unknownDropped: true, seq: 1, ack: 1 });
  assert.equal(JSON.stringify(client.all).includes('test-internal-only'), false);
  client.close(); await client.closed;
});
