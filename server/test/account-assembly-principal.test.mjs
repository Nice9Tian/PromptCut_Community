import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService, normalizePrincipal } from '../docservice/service.mjs';
import { wsClient } from './fake-ws-kit.mjs';

test('normalization preserves authenticated run service identity, legacy fields and refuses message identity substitution', { timeout: 10000 }, async t => {
  assert.deepEqual(normalizePrincipal({ userId: 'legacy', tenantId: 'legacy-room', unknown: 'drop' }),
    { userId: 'legacy', tenantId: 'legacy-room' });
  assert.deepEqual(normalizePrincipal({ userId: 'anonymous', tenantId: 12 }), { userId: 'anonymous', tenantId: null });
  const trusted = { userId: 'account-a', tenantId: 'project-a', realm: 'account', identityVersion: 2,
    role: 'agent', service: 'agent', serviceId: 'agent', serviceKid: 'trusted-kid',
    accountId: 'account-a', loginId: 'login-a', credentialId: 'credential-a', loginGeneration: 1,
    projectId: 'project-a', conversationId: 'conversation-a', messageId: 'message-a', runId: 'run-a', runGrantId: 'grant-a',
    servicePrincipal: { service: 'agent', serviceKid: 'trusted-kid', scope: 'service', proof: { source: 'authenticated' } },
    unknown: 'drop' };
  const expected = { ...trusted }; delete expected.unknown;
  const normalized = normalizePrincipal(trusted); assert.deepEqual(normalized, expected);
  assert.notEqual(normalized.servicePrincipal, trusted.servicePrincipal);
  normalized.servicePrincipal.proof.source = 'changed-clone';
  assert.equal(trusted.servicePrincipal.proof.source, 'authenticated');
  const actors = new Map();
  const service = createDocService({ authenticate: () => trusted, autoTick: false, log() {}, modules: [{
    name: 'principal-probe', types: ['probe.identity'],
    connect(_ctx, id, actor) { actors.set(id, actor); },
    handle(ctx, id) { ctx.send(id, { type: 'probe.identity', actor: actors.get(id) }); },
  }] });
  const address = await service.listen(0, '127.0.0.1');
  const client = wsClient(`ws://127.0.0.1:${address.port}`, ['promptcut.v1', 'promptcut.session.new']);
  t.after(async () => { client.close(); await client.closed; await service.close(); t.diagnostic(`owned principal WS port=${address.port} actual client closed`); });
  await client.opened; await client.next(value => value.type === 'session.welcome');
  client.send({ type: 'probe.identity', seq: 1, serviceId: 'forged', serviceKid: 'forged',
    servicePrincipal: { service: 'render' }, principal: { accountId: 'forged' } });
  const response = await client.next(value => value.type === 'probe.identity');
  assert.deepEqual(response.actor, expected);
  client.close(); await client.closed;
});
