import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceGate } from '../docservice/service-gate.mjs';

test('v2 Agent messages require live assembly authorization instead of cached page access', () => {
  const v2 = { realm: 'account', identityVersion: 2, service: 'agent', role: 'agent', scope: 'member', tenantId: 'project-a', access: 'r' };
  assert.equal(serviceGate(v2, 'project.op', {}), null);
  assert.equal(serviceGate(v2, 'selection.query', {}), null);
  assert.equal(serviceGate(v2, 'shared.admin', {}), 'forbidden');
  assert.equal(serviceGate(v2, 'service.register', {}), 'forbidden');
  assert.equal(serviceGate(v2, 'content.put', { kind: 'private-file' }), 'forbidden');
  assert.equal(serviceGate(v2, 'auth.ticket', { kind: 'conn' }), 'forbidden');
  assert.equal(serviceGate({ ...v2, scope: 'admin' }, 'project.op', {}), 'forbidden');
});

test('LAN member and publisher service gates retain their existing readonly and whitelist policy', () => {
  const lan = { service: 'agent', scope: 'member', tenantId: 'project-a', access: 'r' };
  assert.equal(serviceGate(lan, 'project.op', {}), 'forbidden');
  assert.equal(serviceGate(lan, 'selection.query', {}), 'forbidden');
  assert.equal(serviceGate({ ...lan, access: 'rw' }, 'project.op', {}), null);
  assert.equal(serviceGate({ ...lan, purpose: 'publish', scope: 'service' }, 'project.open', {}), 'forbidden');
});
