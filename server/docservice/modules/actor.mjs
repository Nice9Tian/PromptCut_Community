/**
 * Write identity (`actor`): recorded by both project version log and content store
 * (semantics `docs/semantics/product/document-service.md` "Versions and Identities":
 * which page of which user, or which chat of which Agent).
 *
 * Contract `docs/plan/auth-contract.md` Section 6: records
 * `{ userId, deviceId, role, conversation, session }`, all taken from connection principal;
 * self-reported values in messages are never accepted; `session` is the page-reported session
 * identifier, kept for logging only.
 * Legacy principals without a connection role (test-injected `authenticate`, M5 identities)
 * record only `{ userId, session }`, same as M5.
 *
 * Hosted service connections entering a project on behalf of a member (Cloud Agent,
 * `docs/plan/cloud-agent-contract.md` Section 5) additionally carry `service: '<service-name>'`:
 * `userId` is still that of the initiating member, so identity-based logic like overwrite
 * notifications and undo conflicts remains unchanged; UI displays "<member-name>'s Cloud Agent"
 * based on this field.
 * Connections entering with the service's own identity (render service) do not carry this:
 * their `userId` is itself `service:<service-name>@...`.
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
