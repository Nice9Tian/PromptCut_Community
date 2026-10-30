/** Project-wide live selections. Only connection principals and an owner-supplied
 * authority callback can name members or authorize a run. Nothing here is durable.
 */

export const SELECTION_MODULE = 'selection';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const empty = () => ({ clipIds: [] });
const error = (status, code) => Object.assign(new Error(code), { status, code });
const validId = value => typeof value === 'string' && ID.test(value);
const clone = value => structuredClone(value);

function selectionOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.clipIds) ||
      value.clipIds.length > 256 || value.clipIds.some(id => !validId(id)) ||
      new Set(value.clipIds).size !== value.clipIds.length) throw error(400, 'invalid-selection');
  let range;
  if (value.range !== undefined) {
    range = value.range;
    if (!range || typeof range !== 'object' || Array.isArray(range) ||
        !Number.isFinite(range.start) || !Number.isFinite(range.end) ||
        range.start < 0 || range.end < range.start) throw error(400, 'invalid-selection');
  }
  const result = { clipIds: [...value.clipIds], ...(range ? { range: { start: range.start, end: range.end } } : {}) };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16 * 1024) throw error(413, 'selection-too-large');
  return result;
}

function nameOf(principal) {
  const value = principal?.accountName ?? principal?.username;
  return typeof value === 'string' && value.trim() ? value.trim() : principal.accountId;
}

function clipsOf(project) {
  const clips = new Map();
  for (const track of Array.isArray(project?.tracks) ? project.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if (typeof clip?.id === 'string' && !clips.has(clip.id)) clips.set(clip.id, { trackId: track.id, clip });
    }
  }
  return clips;
}

/**
 * @param {object} options
 * @param {{bodyOf(projectId:string):object|null,revOf(projectId:string):number}} options.project
 * @param {(input:{principal:object,projectId:string,action:'read'})=>Promise<object|boolean>} options.checkAccess
 *   Must reverify live account credentials and the current account/access head, not cached admission.
 *   Only true or {allowed:true,accountId,projectId,accountName?} allows access.
 * @param {(input:{principal:object,projectId:string,runGrantId:string})=>Promise<object>} options.authorizeQuery
 *   Must verify the Agent service identity, project-scoped current/retained runGrant,
 *   actual initiator and the persisted message's selectionSnapshot. Return a stable
 *   fenceRevision when the run grant has one. No client snapshot fallback.
 */
export function mountSelection({ project, checkAccess, authorizeQuery, now = Date.now,
  allowFixtureGrantWithoutFence = false } = {}) {
  if (typeof project?.bodyOf !== 'function' || typeof project?.revOf !== 'function' ||
      typeof checkAccess !== 'function' || typeof authorizeQuery !== 'function')
    throw new TypeError('selection authority and project providers are required');
  const principals = new Map();
  const blocked = new Set();
  /** projectId -> connId -> page record */
  const projects = new Map();
  const revisions = new Map();
  const clock = () => now();
  const bump = projectId => revisions.set(projectId, (revisions.get(projectId) ?? 0) + 1);
  const listOf = projectId => {
    let list = projects.get(projectId);
    if (!list) { list = new Map(); projects.set(projectId, list); }
    return list;
  };
  const remove = (projectId, connId) => {
    const list = projects.get(projectId);
    if (!list?.delete(connId)) return false;
    if (!list.size) projects.delete(projectId);
    bump(projectId);
    return true;
  };
  const pagePrincipal = (principal, projectId) => principal?.role === 'page' && !principal.service &&
    typeof principal.accountId === 'string' && principal.accountId && principal.tenantId === projectId;
  async function checked(principal, projectId) {
    if (!pagePrincipal(principal, projectId)) throw error(403, 'forbidden');
    const answer = await checkAccess({ principal, projectId, action: 'read' });
    if (answer === true) return principal;
    if (!answer || typeof answer !== 'object' || answer.allowed !== true) throw error(403, 'forbidden');
    if (answer.accountId !== principal.accountId || answer.projectId !== projectId) throw error(403, 'principal-mismatch');
    return { ...principal, ...(typeof answer.credentialId === 'string' && answer.credentialId ? { credentialId: answer.credentialId } : {}),
      accountName: answer.accountName ?? principal.accountName };
  }
  /**
   * 问一位在线成员的页面时出的错,算「这一位不算」还是「整次查询失败」。
   *
   * 只跟这一位的凭证有关的,这一位不算(不读它的选区,撤掉它这条连接的在场记录),别的成员照常:
   *   - 403:没有这个项目的读权限、被移出或被禁、连接的身份和项目对不上、权威答得不像样(`checked` 把答非所问也归成 403);
   *   - 401:这条连接的登录过期了、被撤销了、凭证对不上。这条连接凭的那一次登录不会再变回有效(页面续了登录是换一条连接、
   *     重新发选区),所以和 403 一样撤掉记录,不是留着等它好。
   * 其余一律整次失败(回 `authority-unavailable`,宁可不答也不给一张缺人的表):权威连不上或没同步完(5xx、没有状态码的错,
   * 含超时)、项目没了或正在搬迁(404、409)、请求本身写错了(400)。这些不是哪一位成员的事,问谁都一样。
   * 断线不走这里:连接一断它的记录就没了,查询途中断的由调用处核对记录还在不在。
   */
  const memberLevelFailure = cause => cause?.status === 403 || cause?.status === 401;
  function validatedGrant(grant, projectId, runGrantId) {
    if (!grant || typeof grant.initiatorAccountId !== 'string' || !grant.initiatorAccountId ||
        grant.projectId !== projectId || grant.runGrantId !== runGrantId) throw error(403, 'run-grant-invalid');
    if (!(Number.isSafeInteger(grant.fenceRevision) && grant.fenceRevision >= 0) &&
        !(allowFixtureGrantWithoutFence === true && grant.fenceRevision === undefined))
      throw error(503, 'run-fence-unavailable');
    const snapshot = grant.selectionSnapshot;
    let normalized = null;
    if (snapshot !== undefined) {
      if (!snapshot || snapshot.source !== 'sent-snapshot' || snapshot.projectId !== projectId ||
          snapshot.accountId !== grant.initiatorAccountId || !validId(snapshot.pageId) ||
          !Number.isFinite(snapshot.sentAt)) throw error(403, 'snapshot-invalid');
      try { normalized = selectionOf(snapshot.selection); }
      catch { throw error(403, 'snapshot-invalid'); }
    }
    return { grant, snapshot: normalized, fingerprint: JSON.stringify({
      projectId, runGrantId, initiatorAccountId: grant.initiatorAccountId,
      fenceRevision: grant.fenceRevision ?? null,
      selectionSnapshot: snapshot === undefined ? null : {
        source: snapshot.source, projectId: snapshot.projectId, accountId: snapshot.accountId,
        pageId: snapshot.pageId, sentAt: snapshot.sentAt, selection: normalized,
      },
    }) };
  }
  async function queryGrant(principal, projectId, runGrantId) {
    let answer;
    try { answer = await authorizeQuery({ principal, projectId, runGrantId }); }
    catch (cause) { throw error(cause?.status === 403 ? 403 : 503,
      cause?.status === 403 ? 'run-grant-invalid' : 'authority-unavailable'); }
    return validatedGrant(answer, projectId, runGrantId);
  }
  const messageId = msg => msg?.requestId ?? msg?.reqId;
  const reply = (ctx, connId, msg, requestId) => ctx.send(connId,
    requestId === undefined ? msg : { ...msg, reqId: requestId });

  async function set(ctx, connId, msg) {
    const principal = principals.get(connId);
    if (!validId(msg.projectId) || !validId(msg.pageId) ||
        !Number.isSafeInteger(msg.revision) || msg.revision < 1) throw error(400, 'invalid-selection');
    const selection = selectionOf(msg.selection);
    const current = await checked(principal, msg.projectId);
    if (!principals.has(connId) || blocked.has(connId)) throw error(403, 'connection-closed');
    const list = listOf(msg.projectId);
    const previous = list.get(connId);
    if (previous && previous.pageId !== msg.pageId && !previous.synthetic)
      throw error(403, 'page-mismatch');
    if (previous?.pageId === msg.pageId && msg.revision < previous.selectionRevision)
      throw error(409, 'stale-revision');
    if (previous?.pageId === msg.pageId && msg.revision === previous.selectionRevision) {
      if (JSON.stringify(previous.selection) !== JSON.stringify(selection)) throw error(409, 'revision-conflict');
      return reply(ctx, connId, { type: 'selection.ok', projectId: msg.projectId,
        pageId: msg.pageId, selectionRevision: previous.selectionRevision,
        presenceRevision: revisions.get(msg.projectId) ?? 0, duplicate: true }, messageId(msg));
    }
    list.set(connId, { connId, principal: current, pageId: msg.pageId, synthetic: false, selection,
      selectionRevision: msg.revision, serverReceivedAt: clock() });
    bump(msg.projectId);
    reply(ctx, connId, { type: 'selection.ok', projectId: msg.projectId, pageId: msg.pageId,
      selectionRevision: msg.revision, presenceRevision: revisions.get(msg.projectId) }, messageId(msg));
  }

  async function clear(ctx, connId, msg) {
    const principal = principals.get(connId);
    if (!validId(msg.projectId) || !validId(msg.pageId) ||
        !Number.isSafeInteger(msg.revision) || msg.revision < 1) throw error(400, 'invalid-selection');
    const current = await checked(principal, msg.projectId);
    if (!principals.has(connId) || blocked.has(connId)) throw error(403, 'connection-closed');
    const existing = listOf(msg.projectId).get(connId);
    if (!existing || (existing.pageId !== msg.pageId && !existing.synthetic))
      throw error(403, 'page-mismatch');
    if (existing.pageId === msg.pageId && msg.revision < existing.selectionRevision)
      throw error(409, 'stale-revision');
    if (existing.pageId === msg.pageId && msg.revision === existing.selectionRevision) {
      if (existing.selection.clipIds.length || existing.selection.range) throw error(409, 'revision-conflict');
      return reply(ctx, connId, { type: 'selection.ok', projectId: msg.projectId,
        pageId: msg.pageId, selectionRevision: existing.selectionRevision,
        presenceRevision: revisions.get(msg.projectId) ?? 0, duplicate: true }, messageId(msg));
    }
    listOf(msg.projectId).set(connId, { ...existing,
      principal: current, pageId: msg.pageId, synthetic: false,
      selection: empty(), selectionRevision: msg.revision,
      serverReceivedAt: clock() });
    bump(msg.projectId);
    reply(ctx, connId, { type: 'selection.ok', projectId: msg.projectId, pageId: msg.pageId,
      selectionRevision: msg.revision, presenceRevision: revisions.get(msg.projectId) }, messageId(msg));
  }

  async function querySelections({ principal, projectId, runGrantId } = {}) {
    if (!validId(projectId) || typeof runGrantId !== 'string' || !runGrantId ||
        principal?.service !== 'agent' || principal?.tenantId !== projectId) throw error(403, 'forbidden');
    const initial = await queryGrant(principal, projectId, runGrantId);
    const initiator = initial.grant.initiatorAccountId;
    const live = [...(projects.get(projectId)?.values() ?? [])];
    const valid = [];
    for (const entry of live) {
      if (blocked.has(entry.connId) || projects.get(projectId)?.get(entry.connId) !== entry) continue;
      try {
        const current = await checked(entry.principal, projectId);
        if (projects.get(projectId)?.get(entry.connId) === entry) valid.push({ record: entry, principal: current });
      } catch (cause) {
        if (!memberLevelFailure(cause)) throw error(503, 'authority-unavailable');
        remove(projectId, entry.connId);
      }
    }
    const finalGrant = await queryGrant(principal, projectId, runGrantId);
    if (finalGrant.fingerprint !== initial.fingerprint) throw error(403, 'run-grant-changed');
    const projectRev = project.revOf(projectId);
    const clipMap = clipsOf(project.bodyOf(projectId));
    const itemsOf = selection => selection.clipIds.map(id => {
      const found = clipMap.get(id);
      return found ? { id, trackId: found.trackId, clip: clone(found.clip) } : { id, missing: true };
    });
    const members = new Map();
    for (const { record: entry, principal } of valid) {
      if (blocked.has(entry.connId) || projects.get(projectId)?.get(entry.connId) !== entry) continue;
      const accountId = principal.accountId;
      let member = members.get(accountId);
      if (!member) {
        const username = nameOf(principal);
        member = { accountId, username, isInitiator: accountId === initiator,
          displayName: accountId === initiator ? `${username}（当前用户）` : username, pages: [] };
        members.set(accountId, member);
      }
      member.pages.push({ pageId: entry.pageId, selection: clone(entry.selection),
        selectionRevision: Math.max(0, entry.selectionRevision), items: itemsOf(entry.selection), live: true });
    }
    const snapshot = finalGrant.grant.selectionSnapshot;
    if (!members.has(initiator) && snapshot !== undefined) {
      const selection = finalGrant.snapshot;
      const username = typeof finalGrant.grant.initiatorName === 'string' && finalGrant.grant.initiatorName.trim()
        ? finalGrant.grant.initiatorName.trim() : initiator;
      members.set(initiator, { accountId: initiator, username, isInitiator: true,
        displayName: `${username}（当前用户）`, pages: [{ pageId: snapshot.pageId, selection,
          selectionRevision: null, items: itemsOf(selection), live: false, source: 'sent-snapshot',
          sentAt: snapshot.sentAt, note: '发消息时的选区，非实时' }] });
    }
    return { projectId, projectRev, presenceRevision: revisions.get(projectId) ?? 0,
      members: [...members.values()].sort((a, b) => a.accountId.localeCompare(b.accountId)), queriedAt: clock() };
  }

  /** Trusted doc-only send seam: pageId is a locator, never a submitted snapshot. */
  async function captureSnapshot(input = {}) {
    if (Object.keys(input).some(key => !['principal', 'projectId', 'pageId'].includes(key)))
      throw error(400, 'invalid-authority-claim');
    const { principal, projectId, pageId } = input;
    if (!validId(projectId) || !validId(pageId)) throw error(400, 'invalid-selection');
    const current = await checked(principal, projectId);
    const fields = ['accountId', 'loginId', 'credentialId', 'loginGeneration'];
    const loginFields = ['accountId', 'loginId', 'loginGeneration'];
    if (fields.some(field => current[field] === undefined)) throw error(403, 'principal-mismatch');
    const live = () => [...(projects.get(projectId)?.values() ?? [])].filter(entry =>
      !blocked.has(entry.connId) && principals.has(entry.connId) && !entry.synthetic && entry.pageId === pageId &&
      loginFields.every(field => entry.principal[field] === current[field]));
    const matches = live();
    if (matches.length !== 1) throw error(403, 'selection-page-unavailable');
    const entry = matches[0];
    // The live record and both principals are checked across asynchronous authority
    // calls. A new revision/disconnect/revocation cannot substitute another page.
    const checkedEntry = await checked(entry.principal, projectId);
    const checkedSender = await checked(principal, projectId);
    if (fields.some(field => checkedEntry[field] !== checkedSender[field]))
      throw error(403, 'selection-page-unavailable');
    const after = live();
    if (after.length !== 1 || after[0] !== entry || projects.get(projectId)?.get(entry.connId) !== entry)
      throw error(403, 'selection-page-changed');
    entry.principal = checkedEntry;
    const sentAt = clock();
    if (!Number.isSafeInteger(sentAt)) throw error(503, 'selection-clock-unavailable');
    return { source: 'sent-snapshot', projectId, accountId: current.accountId, pageId,
      selection: clone(entry.selection), sentAt };
  }

  async function handle(ctx, connId, msg) {
    try {
      if (msg.type === 'selection.set') return await set(ctx, connId, msg);
      if (msg.type === 'selection.clear') return await clear(ctx, connId, msg);
      if (msg.type === 'selection.query') {
        if (msg.initiatorAccountId !== undefined || msg.selectionSnapshot !== undefined || msg.username !== undefined)
          throw error(400, 'invalid-authority-claim');
        const result = await querySelections({ principal: principals.get(connId), projectId: msg.projectId,
          runGrantId: msg.runGrantId });
        return reply(ctx, connId, { type: 'selection.state', ...result }, messageId(msg));
      }
      throw error(400, 'unsupported');
    } catch (cause) {
      reply(ctx, connId, { type: 'error', reason: cause?.code ?? 'authority-unavailable' }, messageId(msg));
    }
  }

  return {
    name: SELECTION_MODULE, types: ['selection.'],
    connect(_ctx, connId, principal) {
      blocked.delete(connId);
      principals.set(connId, { ...principal });
      if (!pagePrincipal(principal, principal?.tenantId)) return;
      const projectId = principal.tenantId;
      listOf(projectId).set(connId, { connId, principal: { ...principal },
        pageId: `connection:${connId}`, synthetic: true, selection: empty(),
        selectionRevision: 0, serverReceivedAt: clock() });
      bump(projectId);
    },
    disconnect(_ctx, connId) {
      principals.delete(connId);
      blocked.delete(connId);
      for (const projectId of [...projects.keys()]) remove(projectId, connId);
    },
    handle,
    querySelections,
    captureSnapshot,
    revoke({ projectId, accountId, loginId } = {}) {
      if (!validId(projectId)) return 0;
      let removed = 0;
      for (const entry of [...(projects.get(projectId)?.values() ?? [])]) {
        if (accountId && entry.principal.accountId !== accountId) continue;
        if (loginId && entry.principal.loginId !== loginId) continue;
        blocked.add(entry.connId);
        if (remove(projectId, entry.connId)) removed++;
      }
      return removed;
    },
    dropSpace(projectId) {
      for (const entry of projects.get(projectId)?.values() ?? []) blocked.add(entry.connId);
      projects.delete(projectId); revisions.delete(projectId);
    },
    describe() { return { projects: projects.size,
      pages: [...projects.values()].reduce((sum, entries) => sum + entries.size, 0) }; },
  };
}

export const createSelectionModule = mountSelection;
export default mountSelection;
