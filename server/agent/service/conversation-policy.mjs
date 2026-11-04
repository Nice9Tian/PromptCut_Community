import { randomUUID } from 'node:crypto';
import { AgentServiceError } from './create-agent-service.mjs';
import { queryUsage } from './usage.mjs';
import { normalizeRunOptions } from './model-config.mjs';

const translated = error => {
  if (error instanceof AgentServiceError) return error;
  const status = Number.isInteger(error?.status) ? error.status : 503;
  return new AgentServiceError(error?.code ?? 'conversation-unavailable', error?.code ?? 'conversation-unavailable', status);
};
const context = (identity, conversationId) => ({ delegation: identity.delegation,
  projectId: identity.projectId, ...(conversationId ? { conversationId } : {}) });
const requireIdentity = identity => {
  if (!identity || identity.accountMode !== true || typeof identity.delegation !== 'string' || !identity.delegation ||
    typeof identity.projectId !== 'string' || !identity.projectId || typeof identity.accountId !== 'string' || !identity.accountId)
    throw new AgentServiceError('unauthorized', 'unauthorized', 401);
};

/** Account-v2 HTTP surface. It relies on doc mTLS for every read and write. Runs stay queued
 * until the run-authority/read-intent executor is mounted; this module never fabricates ACKs.
 */
export function createAccountConversationService({ conversationClient, usageDir = null, now = Date.now,
  /**
   * Cleans up data stored on Agent service side for this chat after it is deleted
   * (conversation-purge.mjs); omitted for assemblies without storage
   */
  purger = null,
  /**
   * [seam] Unconditionally reclaims resources held on Agent side for this chat upon deletion
   * (cloud browser, perception child processes, etc.): `async ({ projectId, conversationId }) => void`.
   * Called after document service confirms deletion (including duplicate deletions returning
   * "already deleted"); on failure returns 503 `purge-failed` to page; page retrying with same
   * request id will call again, so implementation must be idempotent.
   * Does nothing by default; after merging claude/v18-wire (cloud tool table wiring), assembly wires
   * it to "teardown child processes for this chat" in hosted-tools.
   */
  onConversationDeleted = null,
  /**
   * Model list and thinking effort tiers in `GET /v1/info`:
   * `() => { models, defaultModel, configured, efforts }` (`readPublicModelInfo` in model-config.mjs);
   * omitted if not provided
   */
  modelInfo = null,
  /**
   * When tasks are running in chat upon deletion: after fence (forced termination) is applied, waits
   * on behalf of page for root to terminate process and document service to settle; waits at most
   * this long (ms), same as "wait at most 15 seconds to stop"
   */
  deleteWaitMs = 15_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!conversationClient || ['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename']
    .some(name => typeof conversationClient[name] !== 'function')) throw new AgentServiceError('conversation-unavailable', 'doc conversation client is required', 503);
  const call = async (fn, identity, conversationId, fields = {}) => {
    requireIdentity(identity);
    try { return await conversationClient[fn]({ ...context(identity, conversationId), ...fields }); }
    catch (error) { throw translated(error); }
  };
  /**
   * After document service confirms deletion, clean up thoroughly across Agent side; throws 503 on
   * failure, and page retrying the same request will repeat the operation.
   * Cleaner returning `pending` (directories this side cannot delete are recorded in
   * pending-cleanup list, waiting for the task user side to clean, see conversation-purge.mjs)
   * **is not a failure**: this request still completes normally, but does not send a receipt to
   * document service yet: next reconciliation round checks again, and only sends receipt once seeing
   * the receipt left by the task user side. Returns whether receipt was sent this time.
   */
  async function afterDeleted(projectId, conversationId) {
    let cleared;
    try {
      cleared = await purger?.purge({ projectId, conversationId });
      await onConversationDeleted?.({ projectId, conversationId });
    } catch (error) { throw new AgentServiceError('purge-failed', 'purge-failed', 503); }
    if (cleared?.pending === true) return false;
    // Send receipt to document service: this deleted chat is cleaned up on Agent side (recorded on
    // tombstone, so reconciliation no longer lists it). Receipt failure is harmless: next
    // reconciliation will clean up again (idempotent)
    try { await conversationClient.purgeAck?.({ projectId, conversationId }); } catch { /* Catch up on next reconcile */ }
    return true;
  }
  /**
   * Reconcile: ask the document service "which deleted chats have not yet confirmed cleanup on the
   * Agent side", and clean them up one by one. Catches up on items missed when it crashed, responses
   * were lost, or errors occurred halfway through cleanup.
   * Runs once when the master service starts up and periodically (account-master-assembly.mjs).
   * Returns how many were cleaned up this time.
   */
  async function reconcilePurges() {
    if (typeof conversationClient.purges !== 'function') return 0;
    let done = 0;
    // Only count those truly cleaned up with a receipt this round; those still waiting for cleanup on
    // the task user side do not count (ask again in the next round)
    for (const row of await conversationClient.purges()) { if (await afterDeleted(row.projectId, row.conversationId)) done++; }
    return done;
  }
  return {
    accountMode: true,
    get readTransports() { return conversationClient.readTransports ?? null; },
    egressTestAllow: false, look: false, collect: false, collectTestRunner: false,
    conversations: identity => call('list', identity),
    conversation: (identity, conversationId, after = 0) => call('get', identity, conversationId, { after }),
    access: (identity, conversationId, action = 'read') => call('access', identity, conversationId, { action }),
    async send(identity, conversationId, body = {}) {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new AgentServiceError('bad-request', 'message is empty', 400);
      // Attachments must first be verified by a service with attachment storage mounted
      // (`account-master-assembly.mjs` send puts verified references in `verifiedAttachments`);
      // an instance without storage mounted rejects as usual, not passing page-reported addresses to the
      // document service.
      const attachments = body.verifiedAttachments ?? null;
      if (Array.isArray(body.attachments) && body.attachments.length && !attachments) throw new AgentServiceError('attachment-unavailable', 'attachment authority is not mounted', 503);
      const requestId = typeof body.requestId === 'string' ? body.requestId : randomUUID();
      // Model, thinking effort, and creativity selected for this round: reject immediately if the shape
      // is invalid; omit if none selected (messages in the document service remain unchanged)
      const runOptions = normalizeRunOptions({ model: body.model, effort: body.effort, creativity: body.creativity });
      if (runOptions === undefined) throw new AgentServiceError('invalid-run-options', 'invalid-run-options', 400);
      return call('send', identity, conversationId, { requestId, content: body.prompt, selectionInput: body.selectionSnapshot ?? null,
        ...(attachments?.length ? { attachments } : {}), ...(runOptions ? { runOptions } : {}) });
    },
    switchVisibility: (identity, conversationId, visibility, requestId = randomUUID()) =>
      call('switchVisibility', identity, conversationId, { visibility, requestId }),
    rename: (identity, conversationId, title) => call('rename', identity, conversationId, { title }),
    abort: (identity, conversationId, runId, requestId = randomUUID()) => call('stop', identity, conversationId, { runId, requestId }),
    async info(identity) {
      await call('identity', identity);
      // Failing to read model config does not block info: omit manifest, so page shows no dropdown
      // and uses defaults as usual
      let models = {};
      try { models = modelInfo ? (await modelInfo()) ?? {} : {}; } catch { models = {}; }
      return { enabled: true, accountMode: true, executorMounted: false, running: [], ...models };
    },
    /** Usage for this project (contract section 6.3: members in the project can query totals and
     * amounts per member and per model). Identity is verified by the document service by account:
     * If `identity` does not match a member of this project (not logged in, not a member, kicked),
     * throw an error here and return no numbers; only return logs for their own project.
     * If no usage directory is mounted (no runner), or logs exist but cannot be read, return 503
     * without fabricating zeros. Only display names are provided for members, not account IDs. */
    async usage(identity, since = null) {
      await call('identity', identity);
      if (typeof usageDir !== 'string' || !usageDir) throw new AgentServiceError('usage-unavailable', 'usage authority is not mounted', 503);
      // Logs are written by task processes (another system user): if unreadable (mismatched permissions,
      // disk issues), state clearly that it cannot be queried; do not use zero to pretend "no usage"
      let q;
      try { q = queryUsage(usageDir, { projectId: identity.projectId, since: Number.isFinite(since) && since > 0 ? since : null, strict: true }); }
      catch (error) {
        if (error?.code !== 'usage-unreadable') throw error;
        throw Object.assign(new AgentServiceError('usage-unavailable', 'usage ledger is unreadable', 503), { errno: error.errno });
      }
      const p = q.projects[identity.projectId];
      const people = (members, pick) => Object.entries(members ?? {}).map(([userId, m]) => ({ username: m.username || '', ...pick(m) }));
      return {
        project: { tokens: p?.tokens ?? 0, calls: p?.calls ?? 0, input: p?.input ?? 0, output: p?.output ?? 0 },
        members: people(p?.members, m => ({ tokens: m.tokens, calls: m.calls })),
        models: Object.entries(p?.models ?? {}).map(([model, m]) => ({ model, tokens: m.tokens, calls: m.calls })),
        services: Object.entries(p?.services ?? {}).map(([key, sv]) => ({ service: key.split('/')[0], vendor: key.split('/').slice(1).join('/'),
          calls: sv.calls, units: sv.units, unit: sv.unit, members: people(sv.members, m => ({ calls: m.calls, units: m.units })) })),
      };
    },
    async attach(identity) { await call('identity', identity); throw new AgentServiceError('attachment-unavailable', 'attachment authority is not mounted', 503); },
    async pageResult(identity) { await call('identity', identity); throw new AgentServiceError('run-unavailable', 'run authority is not mounted', 503); },
    /** Delete (user decision, 2026-10-12): permissions, pre-confirmation quotas, and stopping tasks
     * are all decided by the document service chat authority; here we only forward.
     * `requestId` is provided by the page and reused across retries of the same deletion. */
    async remove(identity, conversationId, requestId = randomUUID()) {
      if (typeof conversationClient.remove !== 'function') throw new AgentServiceError('deletion-unavailable', 'conversation deletion is not mounted', 503);
      const deadline = now() + deleteWaitMs;
      let result;
      // Task is running: document service first sets a forced-termination fence and waits for root
      // to kill the process; returns 503 agent-fence-pending if not completed; retry with the same
      // request id after a while
      for (;;) {
        try { result = await call('remove', identity, conversationId, { requestId }); break; }
        catch (error) { if (error?.code !== 'agent-fence-pending' || now() >= deadline) throw error; await sleep(200); }
      }
      await afterDeleted(identity.projectId, conversationId);
      return result;
    },
    /** Clean up private chats when removing a member (done by project creator): document service
     * deletes them one by one, and here we thoroughly purge each deleted one */
    async removeMemberPrivate(identity, accountId, requestId = randomUUID()) {
      if (typeof conversationClient.removeMemberPrivate !== 'function') throw new AgentServiceError('deletion-unavailable', 'conversation deletion is not mounted', 503);
      const deadline = now() + deleteWaitMs;
      // In each round, document service only lists chats "still in the ledger in this round", and chats
      // deleted in the previous round will not appear again: so chats deleted in each round are
      // immediately purged on the Agent side and accumulated; the final returned removed is the sum
      // across all rounds (2026-10-13 review)
      const removed = new Set();
      let result;
      for (;;) {
        result = await call('removeMemberPrivate', identity, undefined, { targetAccountId: accountId, requestId });
        for (const id of result.removed) if (!removed.has(id)) { removed.add(id); await afterDeleted(identity.projectId, id); }
        if (!result.pending?.length || now() >= deadline) break;
        await sleep(200);
      }
      return { ...result, removed: [...removed].sort() };
    },
    /** Notification left for you when someone else deletes a chat related to you (fetched when opening
     * the project, acknowledged with a receipt after popup) */
    async notices(identity) {
      if (typeof conversationClient.notices !== 'function') throw new AgentServiceError('notices-unavailable', 'conversation notices are not mounted', 503);
      return call('notices', identity);
    },
    async ackNotices(identity, noticeIds) {
      if (typeof conversationClient.ackNotices !== 'function') throw new AgentServiceError('notices-unavailable', 'conversation notices are not mounted', 503);
      return call('ackNotices', identity, undefined, { noticeIds });
    },
    reconcilePurges,
    onRevoke: () => () => {},
    close() {},
    describe: () => ({ accountMode: true, runAuthorityMounted: false, at: now() }),
  };
}
