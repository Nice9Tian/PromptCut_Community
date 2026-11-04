/**
 * The "services entering projects on behalf of members" branch in general host service identity
 * skeleton (contract `docs/plan/hosted-render-contract.md` Sections 1.4 and 8; supplement to use
 * case HR7). Tickets for this kind of service (registry `actsFor: 'member'`, Cloud Agent service
 * in Phase 4) are signed by Phase 4's catalog distribution point; this phase only ensures
 * handling by handshake, allowlist, toggle, and member list is correct. Tests directly use project
 * ticket key to sign a ticket of this shape (equivalent to acting as Phase 4 issuer).
 * Run: npm test -- server/test/hosted-render-actsfor.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, join, adminOp, ask, members, newDevice, PROTOCOL } from './auth-kit.mjs';
import { serviceHostFor, outcome, TICKET_PREFIX, ALL_TYPES } from './hosted-render-kit.mjs';
import { signTicket } from '../auth/tickets.mjs';
import { SERVICE_ALLOW, AGENT_WRITE_TYPES } from '../docservice/service-gate.mjs';

async function closedWithin(c, ms, what) {
  let timer;
  const e = await Promise.race([
    c.closed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: did not close within ${ms} ms`)), ms); }),
  ]);
  clearTimeout(timer);
  return { code: e.code, reason: e.reason };
}

/** Act as Phase 4 issuer: sign an `sv` ticket for member `userId` */
function memberServiceTicket(env, projectId, { service = 'agent', userId, role = 'agent', conversation = 1, deviceName = 'Laptop' }) {
  const fields = { k: 'conn', u: userId, r: role, dn: deviceName, sv: service, sk: env.keys[service].kid };
  if (conversation !== null) fields.c = conversation;
  return signTicket(env.store.peek(projectId), fields, env.clock.now()).ticket;
}

test('HR7 service ticket acting for a member: the handshake yields the member identity plus a service field; list, ban and kick checks follow the member; everything goes through the allowlist (anything outside the table is rejected)', async (t) => {
  const env = await serviceHostFor(t, { services: ['render', 'agent'] });
  assert.equal(env.registry.get('agent').actsFor, 'member');
  assert.equal(env.registry.get('render').actsFor, 'self');
  const proj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }, { username: 'eve', password: 'eve-pw' }] });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  const dev = newDevice('Laptop');
  const bob = await join(env, proj, { username: 'bob', device: dev });
  const bobId = `bob@${dev.deviceId}`;

  const ticket = memberServiceTicket(env, proj.projectId, { userId: bobId, conversation: 7, deviceName: dev.deviceName });
  const agentConn = await env.open([PROTOCOL, TICKET_PREFIX + ticket]);
  const p = env.principals().find((x) => x.service === 'agent');
  assert.deepEqual(p, {
    userId: bobId, tenantId: proj.projectId, scope: 'member', username: 'bob', deviceId: dev.deviceId, deviceName: dev.deviceName,
    creator: false, role: 'agent', conversation: 7, owner: null, service: 'agent', serviceKid: env.keys.agent.kid, access: 'r',
  });

  // Allowlist looks up by service field: agent row is filled in by Phase 4 (tested one by one in
  // `cloud-agent-auth.test.mjs`); connections outside table cannot send any type (including those
  // members could originally send).
  // This ticket does not include `acc`, handshake records it as read-only (close on failure), so the
  // two project-modifying types in table are also rejected.
  for (const type of ALL_TYPES) {
    if (SERVICE_ALLOW.agent.includes(type) && !AGENT_WRITE_TYPES.includes(type)) continue;
    assert.equal(await outcome(agentConn, { type, projectId: 'doc-1', kind: 'asset', kinds: 'all', projects: 'all' }), 'error:forbidden', type);
  }
  assert.equal(await outcome(bob, { type: 'content.list', kind: 'card-source' }, 'content.listing'), 'content.listing', 'the member\'s own connection is unaffected');

  // Member list: grouped under bob's row, connection item includes service; no separate row
  const rows = await members(creator);
  assert.equal(rows.some((d) => 'service' in d), false, 'no separate service row');
  const row = rows.find((d) => d.deviceId === dev.deviceId);
  assert.deepEqual(row.conns.find((c) => c.role === 'agent'), { role: 'agent', conversation: 7, service: 'agent' });
  assert.equal(row.tags.agents, 1);

  // Tickets whose shape does not match registry cannot enter
  const status = async (tk) => (await env.handshake([PROTOCOL, TICKET_PREFIX + tk])).status;
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { service: 'render', userId: bobId, role: 'render', conversation: null })), 401, 'a ticket for the render service (actsFor: self) cannot use a member\'s userId');
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { userId: `service:agent@${env.keys.agent.instanceId}`, conversation: null })), 401, 'a ticket for the agent service (actsFor: member) cannot use the service\'s own userId');
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { userId: bobId, role: 'page', conversation: null })), 401, 'role does not match the registry');
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { userId: `mallory@${newDevice().deviceId}` })), 401, 'restricted entry: a member not on the list');

  // Kicking applies to it just like member's own connection: connection closes, neither old tickets
  // (member generation changed) nor newly signed ones (banned) can enter
  const eveDev = newDevice('Pad');
  const eveId = `eve@${eveDev.deviceId}`;
  const eveTicket = memberServiceTicket(env, proj.projectId, { userId: eveId });
  const eveConn = await env.open([PROTOCOL, TICKET_PREFIX + eveTicket]);
  const kick = await adminOp(creator, proj, 'kick', { username: 'eve', deviceId: eveDev.deviceId });
  assert.equal(kick.type, 'shared.admin.ok', JSON.stringify(kick));
  assert.equal((await closedWithin(eveConn, 3000, 'Agent connection of the kicked member')).code, 4003);
  assert.equal(await status(eveTicket), 401, 'old ticket after the kick');
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { userId: eveId })), 401, 'tickets newly issued after the kick cannot get in either (ban list)');

  // Turn off Agent toggle: only closes connections for this service; member's own connections
  // and render toggle remain untouched
  const off = await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: false });
  assert.equal(off.type, 'shared.admin.ok', JSON.stringify(off));
  assert.deepEqual(await closedWithin(agentConn, 3000, 'Agent connection'), { code: 4003, reason: 'service-disabled' });
  assert.deepEqual(await bob.next((m) => m.type === 'shared.notice' && m.event === 'hosted-service-changed', 3000), { type: 'shared.notice', event: 'hosted-service-changed', service: 'agent', enabled: false });
  assert.equal(await outcome(bob, { type: 'shared.members' }, 'shared.members.list'), 'shared.members.list', 'the member\'s own connection was not dropped');
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { userId: bobId })), 401, 'cannot get in while the switch is off');
  const list = await ask(creator, { type: 'shared.members' }, 'shared.members.list');
  assert.deepEqual(list.hosted, { render: { available: true, enabled: true, streams: false }, agent: { available: true, enabled: false } });

  const badService = await adminOp(creator, proj, 'set-hosted-service', { service: 'backup', enabled: false });
  assert.deepEqual([badService.type, badService.reason], ['error', 'bad-message'], 'unknown service name');
});
