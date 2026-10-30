/**
 * 托管方服务身份的通用骨架里「代成员进项目的服务」那一支（契约 `docs/plan/hosted-render-contract.md` 第 1.4、8 节；用例 HR7 的补充）。
 * 这种服务（登记表 `actsFor: 'member'`，第四段的云端 Agent 服务）的票据由第四段的目录分发点签；本段只保证握手、白名单、开关、
 * 成员列表对它的处理是对的。测试里直接用项目的票据密钥签一张这种形状的票据（等于扮演第四段的签发方）。
 * 跑：npm test -- server/test/hosted-render-actsfor.test.mjs
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
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}：${ms} ms 内没有关闭`)), ms); }),
  ]);
  clearTimeout(timer);
  return { code: e.code, reason: e.reason };
}

/** 扮演第四段的签发方：给成员 `userId` 签一张 `sv` 票据 */
function memberServiceTicket(env, projectId, { service = 'agent', userId, role = 'agent', conversation = 1, deviceName = 'Laptop' }) {
  const fields = { k: 'conn', u: userId, r: role, dn: deviceName, sv: service, sk: env.keys[service].kid };
  if (conversation !== null) fields.c = conversation;
  return signTicket(env.store.peek(projectId), fields, env.clock.now()).ticket;
}

test('HR7 代成员的服务票据：握手得到成员身份加 service 字段；照成员查名单、禁入、踢人；一律走白名单（表外全拒）', async (t) => {
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

  // 白名单按 service 字段查：agent 一行由第四段填（`cloud-agent-auth.test.mjs` 逐条测）；表外的这条连接一种都发不了（包括成员本来能发的）。
  // 这张票据没带 `acc`，握手按只读记（失败即关），所以表里改项目的两种也被拒
  for (const type of ALL_TYPES) {
    if (SERVICE_ALLOW.agent.includes(type) && !AGENT_WRITE_TYPES.includes(type)) continue;
    assert.equal(await outcome(agentConn, { type, projectId: 'doc-1', kind: 'asset', kinds: 'all', projects: 'all' }), 'error:forbidden', type);
  }
  assert.equal(await outcome(bob, { type: 'content.list', kind: 'card-source' }, 'content.listing'), 'content.listing', '成员自己的连接不受影响');

  // 成员列表：归在 bob 那一行里，连接项带 service；不另起一行
  const rows = await members(creator);
  assert.equal(rows.some((d) => 'service' in d), false, '没有单独的服务行');
  const row = rows.find((d) => d.deviceId === dev.deviceId);
  assert.deepEqual(row.conns.find((c) => c.role === 'agent'), { role: 'agent', conversation: 7, service: 'agent' });
  assert.equal(row.tags.agents, 1);

  // 形状与登记表对不上的票据进不来
  const status = async (tk) => (await env.handshake([PROTOCOL, TICKET_PREFIX + tk])).status;
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { service: 'render', userId: bobId, role: 'render', conversation: null })), 401, '渲染服务（actsFor: self）的票据不能用成员的 userId');
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { userId: `service:agent@${env.keys.agent.instanceId}`, conversation: null })), 401, 'agent 服务（actsFor: member）的票据不能用服务自己的 userId');
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { userId: bobId, role: 'page', conversation: null })), 401, '角色与登记表不符');
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { userId: `mallory@${newDevice().deviceId}` })), 401, '限定进入：不在名单里的成员');

  // 踢人对它和对成员自己的连接一样生效：连接关闭、旧票据（成员代数变了）与新签的（禁入）都进不来
  const eveDev = newDevice('Pad');
  const eveId = `eve@${eveDev.deviceId}`;
  const eveTicket = memberServiceTicket(env, proj.projectId, { userId: eveId });
  const eveConn = await env.open([PROTOCOL, TICKET_PREFIX + eveTicket]);
  const kick = await adminOp(creator, proj, 'kick', { username: 'eve', deviceId: eveDev.deviceId });
  assert.equal(kick.type, 'shared.admin.ok', JSON.stringify(kick));
  assert.equal((await closedWithin(eveConn, 3000, '被踢成员的 Agent 连接')).code, 4003);
  assert.equal(await status(eveTicket), 401, '踢人后旧票据');
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { userId: eveId })), 401, '踢人后新签的也进不来（禁入表）');

  // 关掉 Agent 的开关：只关这个服务的连接，成员自己的连接、渲染的开关都不动
  const off = await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: false });
  assert.equal(off.type, 'shared.admin.ok', JSON.stringify(off));
  assert.deepEqual(await closedWithin(agentConn, 3000, 'Agent 连接'), { code: 4003, reason: 'service-disabled' });
  assert.deepEqual(await bob.next((m) => m.type === 'shared.notice' && m.event === 'hosted-service-changed', 3000), { type: 'shared.notice', event: 'hosted-service-changed', service: 'agent', enabled: false });
  assert.equal(await outcome(bob, { type: 'shared.members' }, 'shared.members.list'), 'shared.members.list', '成员自己的连接没断');
  assert.equal(await status(memberServiceTicket(env, proj.projectId, { userId: bobId })), 401, '开关关着进不来');
  const list = await ask(creator, { type: 'shared.members' }, 'shared.members.list');
  assert.deepEqual(list.hosted, { render: { available: true, enabled: true, streams: false }, agent: { available: true, enabled: false } });

  const badService = await adminOp(creator, proj, 'set-hosted-service', { service: 'backup', enabled: false });
  assert.deepEqual([badService.type, badService.reason], ['error', 'bad-message'], '不认识的服务名');
});
