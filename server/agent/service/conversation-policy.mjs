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
  /** 对话被删以后清 Agent 服务一侧自己存的这个对话的东西(conversation-purge.mjs)；没有存储的装配不给 */
  purger = null,
  /**
   * 〔接缝〕对话被删时无条件收掉这个对话在 Agent 一侧还占着的东西(云端浏览器、感知子进程等)：`async ({ projectId, conversationId }) => void`。
   * 文档服务确认删掉(含重复删除得到「已删」)以后调用；失败回页面 503 `purge-failed`，页面用同一个请求号重试会再调一次，所以实现要幂等。
   * 缺省什么都不做；claude/v18-wire(云端工具表接线)合入后由装配把它接到 hosted-tools 的「收掉这个对话的子进程」上。
   */
  onConversationDeleted = null,
  /** `GET /v1/info` 里的模型清单与思考强度档位:`() => { models, defaultModel, configured, efforts }`(model-config.mjs 的 readPublicModelInfo);不给就不报 */
  modelInfo = null,
  /** 删除时对话里有任务在跑：围栏(强制结束)下去以后，替页面等 root 把进程关掉、文档服务结清，最多等这么久(毫秒)，同「停止最多等 15 秒」 */
  deleteWaitMs = 15_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!conversationClient || ['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename']
    .some(name => typeof conversationClient[name] !== 'function')) throw new AgentServiceError('conversation-unavailable', 'doc conversation client is required', 503);
  const call = async (fn, identity, conversationId, fields = {}) => {
    requireIdentity(identity);
    try { return await conversationClient[fn]({ ...context(identity, conversationId), ...fields }); }
    catch (error) { throw translated(error); }
  };
  /**
   * 文档服务确认删掉以后，Agent 一侧各处清干净；清失败抛 503，页面重试同一个请求会再来一遍。
   * 清理器回 `pending`(这一方删不动的目录已经记进待清的单子、等任务用户一侧清，见 conversation-purge.mjs)**不算失败**：
   * 这次请求照样办完，只是先不给文档服务回执——对账下一轮再来，看到任务用户一侧留的回执那一次才回执。返回这次回执了没有。
   */
  async function afterDeleted(projectId, conversationId) {
    let cleared;
    try {
      cleared = await purger?.purge({ projectId, conversationId });
      await onConversationDeleted?.({ projectId, conversationId });
    } catch (error) { throw new AgentServiceError('purge-failed', 'purge-failed', 503); }
    if (cleared?.pending === true) return false;
    // 回执文档服务：这个已删对话在 Agent 一侧清完了(墓碑上记下，对账就不再列它)。回执失败不要紧：下一次对账会再清一遍(幂等)
    try { await conversationClient.purgeAck?.({ projectId, conversationId }); } catch { /* 下次对账补 */ }
    return true;
  }
  /**
   * 对账：问文档服务「哪些已删的对话在 Agent 一侧还没确认清理」，逐个补清。补它崩了、回包丢了、清到一半出错漏掉的。
   * 主服务起来时和定时各来一次(account-master-assembly.mjs)。返回这次补清了几个。
   */
  async function reconcilePurges() {
    if (typeof conversationClient.purges !== 'function') return 0;
    let done = 0;
    // 只数这一轮真的清完并回执的；还等着任务用户一侧清的不算(下一轮再来问)
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
      // 附件要先由挂了附件存储的服务核过（`account-master-assembly.mjs` 的 send 把核过的引用放在 `verifiedAttachments` 里）；
      // 没挂存储的这一份照旧拒绝，不把页面自报的地址交给文档服务。
      const attachments = body.verifiedAttachments ?? null;
      if (Array.isArray(body.attachments) && body.attachments.length && !attachments) throw new AgentServiceError('attachment-unavailable', 'attachment authority is not mounted', 503);
      const requestId = typeof body.requestId === 'string' ? body.requestId : randomUUID();
      // 这一轮点的模型、思考强度、创造力：形状不对当场拒；都没点就不带(文档服务里的消息和原来一样)
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
      // 模型配置读不到不挡 info:不报清单,页面就不出下拉、照常用缺省
      let models = {};
      try { models = modelInfo ? (await modelInfo()) ?? {} : {}; } catch { models = {}; }
      return { enabled: true, accountMode: true, executorMounted: false, running: [], ...models };
    },
    /** 本项目的用量(契约第 6.3 节:项目内的成员可查总量与各成员、各模型的量)。身份由文档服务按账号核对:
     * `identity` 对不上这个项目的成员(没登录、不是成员、被踢)就在这里抛错,不回任何数字;只回自己项目的流水。
     * 没挂用量目录(没有执行器)、或者流水在但读不到,都回 503,不编造零。成员只给显示名,不给账号编号。 */
    async usage(identity, since = null) {
      await call('identity', identity);
      if (typeof usageDir !== 'string' || !usageDir) throw new AgentServiceError('usage-unavailable', 'usage authority is not mounted', 503);
      // 流水是任务进程(另一个系统用户)写的:读不到(权限没配对、盘出了问题)就明说查不了,不拿零冒充「没有用量」
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
    /** 删除(2026-10-12 用户定)：权限、确认前的名额与停任务都由文档服务的对话权威判；这里只转发。requestId 由页面给，同一次删除重试沿用 */
    async remove(identity, conversationId, requestId = randomUUID()) {
      if (typeof conversationClient.remove !== 'function') throw new AgentServiceError('deletion-unavailable', 'conversation deletion is not mounted', 503);
      const deadline = now() + deleteWaitMs;
      let result;
      // 有任务在跑：文档服务先下强制结束的围栏、等 root 关进程，没办完回 503 agent-fence-pending；同一个请求号隔一会儿再问
      for (;;) {
        try { result = await call('remove', identity, conversationId, { requestId }); break; }
        catch (error) { if (error?.code !== 'agent-fence-pending' || now() >= deadline) throw error; await sleep(200); }
      }
      await afterDeleted(identity.projectId, conversationId);
      return result;
    },
    /** 移出成员时顺带清他的私有对话(项目创建者做)：文档服务逐个删，这里再把删掉的各个清干净 */
    async removeMemberPrivate(identity, accountId, requestId = randomUUID()) {
      if (typeof conversationClient.removeMemberPrivate !== 'function') throw new AgentServiceError('deletion-unavailable', 'conversation deletion is not mounted', 503);
      const deadline = now() + deleteWaitMs;
      // 每一轮文档服务只列「这一轮还在账本里」的对话，前一轮已经删掉的不会再出现：所以每一轮删掉的立刻清 Agent 一侧并累计，
      // 最后回的 removed 是各轮的总和(2026-10-13 审查)
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
    /** 别人删了和你有关的对话时留给你的通知(打开项目时取，弹完回执) */
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
