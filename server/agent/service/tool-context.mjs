const CONTEXT_KEYS = Object.freeze([
  'projectId', 'conversationId', 'runId', 'runGrantId', 'instanceId', 'instanceGeneration', 'senderAccountId', 'messageId',
]);
const REFERENCE = /^[A-Za-z0-9_.:-]{1,128}$/;
const fail = code => { throw Object.assign(new Error(code), { name: 'ToolContextError', code }); };

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function canonicalContext(value) {
  if (!exactObject(value, CONTEXT_KEYS)) fail('tool-context-untrusted');
  const result = {};
  for (const key of CONTEXT_KEYS) {
    if (key === 'instanceGeneration') {
      if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail('tool-context-invalid');
    } else if (typeof value[key] !== 'string' || !REFERENCE.test(value[key])) fail('tool-context-invalid');
    result[key] = value[key];
  }
  return Object.freeze(result);
}

function contextKey(value) {
  return JSON.stringify(CONTEXT_KEYS.map(key => value[key]));
}

function checkedIdentity(value) {
  const keys = ['serviceId', 'serviceKid', 'instanceId', 'instanceGeneration'];
  if (!value || typeof value !== 'object' || value.serviceId !== 'agent' ||
      typeof value.serviceKid !== 'string' || !REFERENCE.test(value.serviceKid) ||
      typeof value.instanceId !== 'string' || !REFERENCE.test(value.instanceId) ||
      !Number.isSafeInteger(value.instanceGeneration) || value.instanceGeneration < 1 ||
      keys.some(key => !Object.hasOwn(value, key))) fail('tool-instance-unavailable');
  return { serviceId: value.serviceId, serviceKid: value.serviceKid,
    instanceId: value.instanceId, instanceGeneration: value.instanceGeneration };
}

function assertSameIdentity(first, second) {
  if (first.serviceId !== second.serviceId || first.serviceKid !== second.serviceKid ||
      first.instanceId !== second.instanceId || first.instanceGeneration !== second.instanceGeneration)
    fail('tool-instance-changed');
}

function mapGrant(result, expectedProjectId, expectedRunGrantId, identity) {
  if (result?.allowed !== true || result.projectId !== expectedProjectId ||
      !result.runGrant || typeof result.runGrant !== 'object' || Array.isArray(result.runGrant)) fail('run-access-denied');
  const grant = result.runGrant;
  if (grant.projectId !== expectedProjectId || grant.runGrantId !== expectedRunGrantId ||
      typeof grant.conversationId !== 'string' || !REFERENCE.test(grant.conversationId) ||
      typeof grant.runId !== 'string' || !REFERENCE.test(grant.runId) ||
      typeof grant.messageId !== 'string' || !REFERENCE.test(grant.messageId) ||
      typeof grant.accountId !== 'string' || !REFERENCE.test(grant.accountId) ||
      grant.initiatorAccountId !== grant.accountId ||
      grant.instanceId !== identity.instanceId || grant.instanceGeneration !== identity.instanceGeneration ||
      grant.serviceId !== identity.serviceId || grant.serviceKid !== identity.serviceKid ||
      !['active', 'retained'].includes(grant.state) ||
      typeof grant.readReceiptId !== 'string' || !REFERENCE.test(grant.readReceiptId) ||
      !Number.isSafeInteger(grant.fenceRevision) || grant.fenceRevision < 0 ||
      result.accountId !== grant.accountId) fail('run-context-protocol');
  const selected = grant.state === 'active' ? result.activeGrant : result.retainedGrant;
  const other = grant.state === 'active' ? result.retainedGrant : result.activeGrant;
  if (!selected || other !== undefined || selected.readConfirmed !== true || selected.currentRun !== true ||
      selected.state !== grant.state || selected.readReceiptId !== grant.readReceiptId ||
      selected.fenceRevision !== grant.fenceRevision ||
      CONTEXT_KEYS.some(key => {
        const grantField = key === 'senderAccountId' ? 'accountId' : key;
        return selected[grantField] !== grant[grantField];
      })) fail('run-context-not-confirmed');
  return Object.freeze({
    projectId: grant.projectId,
    conversationId: grant.conversationId,
    runId: grant.runId,
    runGrantId: grant.runGrantId,
    instanceId: grant.instanceId,
    instanceGeneration: grant.instanceGeneration,
    senderAccountId: grant.accountId,
    messageId: grant.messageId,
    fenceRevision: grant.fenceRevision,
    grantState: grant.state,
  });
}

function assertSameContext(context, grant) {
  const expected = {
    projectId: grant.projectId, conversationId: grant.conversationId, runId: grant.runId,
    runGrantId: grant.runGrantId, instanceId: grant.instanceId, instanceGeneration: grant.instanceGeneration,
    senderAccountId: grant.senderAccountId, messageId: grant.messageId,
  };
  if (CONTEXT_KEYS.some(key => context[key] !== expected[key])) fail('tool-context-mismatch');
}

/**
 * Build a ToolRunContext only from the doc authority's current, read-confirmed run grant and the
 * Agent process's current registration. The returned authorize method rechecks doc access and
 * registration on every call. It does not expose instance signals or claim child closure.
 */
export function createToolRunContextAccess({ runClient } = {}) {
  if (typeof runClient?.checkAccess !== 'function' || typeof runClient?.instanceIdentity !== 'function')
    fail('tool-context-configuration');
  const issued = new Map();

  async function currentIdentity() {
    let raw;
    try { raw = runClient.instanceIdentity(); } catch { fail('tool-instance-unavailable'); }
    if (!raw) fail('tool-instance-unavailable');
    return checkedIdentity(raw);
  }

  async function checkAccess(projectId, runGrantId, action) {
    let result;
    try { result = await runClient.checkAccess({ projectId, runGrantId, action }); }
    catch (error) {
      if ([400, 401, 403, 404].includes(error?.status)) fail('run-access-denied');
      fail('run-authority-unavailable');
    }
    return result;
  }

  async function fromGrant(locator) {
    const keys = ['projectId', 'runGrantId'];
    if (!exactObject(locator, keys) || keys.some(key => typeof locator[key] !== 'string' || !REFERENCE.test(locator[key])))
      fail('tool-grant-locator-invalid');
    const identity = await currentIdentity();
    const result = await checkAccess(locator.projectId, locator.runGrantId, 'read');
    assertSameIdentity(identity, await currentIdentity());
    const grant = mapGrant(result, locator.projectId, locator.runGrantId, identity);
    const context = canonicalContext(Object.fromEntries(CONTEXT_KEYS.map(key => [key, grant[key]])));
    issued.set(contextKey(context), grant);
    return context;
  }

  async function authorize(contextValue, action) {
    if (action !== 'read' && action !== 'write') fail('tool-action-invalid');
    const context = canonicalContext(contextValue);
    const grant = issued.get(contextKey(context));
    if (!grant) fail('tool-context-untrusted');
    const identity = await currentIdentity();
    if (identity.instanceId !== context.instanceId || identity.instanceGeneration !== context.instanceGeneration)
      fail('tool-instance-changed');
    const result = await checkAccess(context.projectId, context.runGrantId, action);
    assertSameIdentity(identity, await currentIdentity());
    const currentGrant = mapGrant(result, context.projectId, context.runGrantId, identity);
    assertSameContext(context, currentGrant);
    return Object.freeze({ allowed: true, fenceRevision: currentGrant.fenceRevision, grantState: currentGrant.grantState });
  }

  return Object.freeze({ fromGrant, authorize });
}
