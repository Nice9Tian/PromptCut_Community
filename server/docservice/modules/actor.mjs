/**
 * 写入身份（`actor`）：项目版本日志、内容库都记它（语义 `docs/semantics/product/document-service.md`
 * 「版本与身份」：哪个用户的哪个页面，或哪个 Agent 的哪个对话）。
 *
 * 契约 `docs/plan/auth-contract.md` 第 6 节：记 `{ userId, deviceId, role, conversation, session }`，全部取自连接的
 * principal，消息里自报的一律不认；`session` 是页面自报的会话标识，只作记录。
 * 不带连接角色的旧式 principal（测试注入的 `authenticate`、M5 的身份）只记 `{ userId, session }`，与 M5 相同。
 *
 * 代成员进项目的托管方服务连接（云端 Agent，`docs/plan/cloud-agent-contract.md` 第 5 节）另带 `service: '<服务名>'`：
 * `userId` 仍是发起成员的，所以覆盖通知、撤销冲突这些按身份判的逻辑不变；界面据这个字段显示「〈成员名〉的云端 Agent」。
 * 以服务自己的身份进来的连接（渲染服务）不带：它的 `userId` 本身就是 `service:<服务名>@…`。
 */
export function actorOf(principal, session) {
  if (principal?.realm === 'account' || principal?.identityVersion === 2) {
    if (principal.realm === 'account' && principal.identityVersion === 2 &&
        principal.scope === 'service' && principal.service === 'render' && principal.role === 'render' &&
        typeof principal.userId === 'string' && principal.userId.startsWith('service:render@')) {
      return {
        userId: principal.userId,
        deviceId: principal.deviceId ?? null,
        role: 'render',
        conversation: null,
        session,
      };
    }
    if (principal.realm !== 'account' || principal.identityVersion !== 2 ||
        ['accountId', 'loginId', 'credentialId'].some(key => typeof principal[key] !== 'string' || !principal[key]) ||
        !Number.isSafeInteger(principal.loginGeneration) || principal.loginGeneration < 1) {
      throw Object.assign(new Error('invalid-account-principal'), { code: 'invalid-account-principal', status: 403 });
    }
    const actor = { userId: principal.userId ?? principal.accountId, deviceId: principal.deviceId ?? null,
      role: principal.role ?? 'page', conversation: principal.conversation ?? null, session,
      identityVersion: 2, realm: 'account' };
    for (const key of ['accountId', 'loginId', 'credentialId', 'loginGeneration', 'runGrantId', 'runId', 'messageId', 'conversationId']) {
      if (principal[key] !== undefined) actor[key] = principal[key];
    }
    if (typeof principal.service === 'string') actor.service = principal.service;
    return actor;
  }
  const userId = principal?.userId ?? null;
  if (principal?.role === undefined) return { userId, session };
  const actor = {
    userId,
    deviceId: principal.deviceId ?? null,
    role: principal.role,
    conversation: principal.conversation ?? null,
    session,
  };
  if (typeof principal.service === 'string' && principal.scope === 'member') actor.service = principal.service;
  return actor;
}
