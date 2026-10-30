import { createToolRunContextAccess } from './tool-context.mjs';

const KEYS = ['projectId', 'conversationId', 'runId', 'runGrantId', 'instanceId',
  'instanceGeneration', 'senderAccountId', 'messageId'];

export class RunResourceError extends Error {
  constructor(code) { super(code); this.name = 'RunResourceError'; this.code = code; }
}
const fail = code => { throw new RunResourceError(code); };

function keyOf(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      Object.getPrototypeOf(context) !== Object.prototype ||
      Object.keys(context).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(context, key)) ||
      KEYS.some(key => key === 'instanceGeneration'
        ? !Number.isSafeInteger(context[key]) || context[key] < 1
        : typeof context[key] !== 'string' || context[key].length === 0))
    fail('run-resource-context-invalid');
  return JSON.stringify(KEYS.map(key => context[key]));
}

function watch(resource, kind) {
  if (!resource || typeof resource.once !== 'function' || typeof resource.removeListener !== 'function')
    fail('run-resource-invalid');
  if (kind === 'child' && typeof resource.kill !== 'function') fail('run-resource-invalid');
  if (kind !== 'child' && typeof resource.destroy !== 'function') fail('run-resource-invalid');
  let closed = false;
  let exited = kind !== 'child';
  let resolve;
  const done = new Promise(res => { resolve = res; });
  const onClose = () => { closed = true; if (exited) resolve(); };
  const onExit = () => { exited = true; if (closed) resolve(); };
  resource.once('close', onClose);
  if (kind === 'child') resource.once('exit', onExit);
  const abort = () => {
    try { if (kind === 'child') resource.kill(); else resource.destroy(); }
    catch { /* A missing close event keeps the receipt pending. */ }
  };
  return { kind, resource, done, abort, get closed() { return closed && exited; } };
}

/** The registry owns only resources it actually observes closing. It never manufactures an OS-tree witness. */
export function createRunResources({ contextAccess, runClient, childTreeWitness } = {}) {
  const access = contextAccess ?? createToolRunContextAccess({ runClient });
  if (typeof access?.fromGrant !== 'function' || typeof access?.authorize !== 'function')
    fail('run-resource-configuration');
  if (childTreeWitness !== undefined && typeof childTreeWitness !== 'function') fail('run-resource-configuration');
  const groups = new Map();
  let closed = false;

  const groupFor = context => {
    const key = keyOf(context);
    let group = groups.get(key);
    if (!group) {
      group = { context: Object.freeze(Object.fromEntries(KEYS.map(key => [key, context[key]]))),
        controller: new AbortController(), resources: new Set(),
        stopped: false, pending: 0, everAuthorized: false };
      groups.set(key, group);
    }
    return group;
  };
  const dispose = async tracked => { tracked.abort(); await tracked.done; };

  async function register(context, { kind, resource } = {}) {
    if (!['socket', 'stream', 'child'].includes(kind)) fail('run-resource-kind-invalid');
    const tracked = watch(resource, kind);
    let group;
    try {
      if (closed) fail('run-resource-closed');
      group = groupFor(context);
      group.pending += 1;
      group.resources.add(tracked);
      tracked.done.then(() => group.resources.delete(tracked));
      if (group.stopped) fail('run-resource-fenced');
      await access.authorize(context, 'read');
      if (group.stopped || closed) fail('run-resource-fenced');
      group.everAuthorized = true;
      await access.authorize(context, 'read');
      if (group.stopped || closed) fail('run-resource-fenced');
      return Object.freeze({ signal: group.controller.signal, closed: tracked.done });
    } catch (error) {
      await dispose(tracked);
      if (error instanceof RunResourceError) throw error;
      fail('run-resource-unauthorized');
    } finally {
      if (group) group.pending -= 1;
    }
  }

  async function abortForFence(context, reason = 'fenced') {
    const group = groupFor(context);
    group.stopped = true;
    group.controller.abort(reason);
    const closing = [...group.resources];
    for (const tracked of closing) tracked.abort();
    // A resource that never closes must leave a pending receipt, not block the control RPC.
    await new Promise(resolve => setImmediate(resolve));
    const stillOpen = [...group.resources].filter(tracked => !tracked.closed);
    const counts = {
      connectionsOpen: stillOpen.filter(item => item.kind === 'socket').length,
      streamsOpen: stillOpen.filter(item => item.kind === 'stream').length,
      childrenOpen: stillOpen.filter(item => item.kind === 'child').length,
    };
    let childTreeClosed = false;
    if (childTreeWitness) {
      try { childTreeClosed = await childTreeWitness(context) === true; } catch { /* Unknown OS tree stays pending. */ }
    }
    return { complete: group.everAuthorized && childTreeClosed && group.pending === 0 &&
        Object.values(counts).every(value => value === 0),
      witnessMissing: !childTreeClosed || !group.everAuthorized, pendingRegistrations: group.pending,
      ...counts, reason };
  }

  return Object.freeze({
    contextAccess: access,
    contextFor: locator => access.fromGrant(locator),
    authorize: (context, action) => access.authorize(context, action),
    async verifyFence(context, revision) {
      const status = await access.authorize(context, 'read');
      return status.fenceRevision === revision;
    },
    register, abortForFence,
    signalFor(context) {
      const group = groups.get(keyOf(context));
      if (!group) fail('run-resource-unregistered');
      return group.controller.signal;
    },
    async close() {
      closed = true;
      return Promise.all([...groups.values()].map(group => abortForFence(group.context, 'host-close')));
    },
  });
}
