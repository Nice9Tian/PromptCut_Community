/**
 * Presence module (plan `docs/plan/agent-workflow-plan.md` A3 stage 2;
 * semantics `user-workflow.md` "Protection", "Multi-Agent").
 *
 * In shared projects, the "editing" status on each member's page, each Agent's scope declarations,
 * and messages sent between them must be made known to other members of the same project.
 * They **do not enter project history** and have an expiration time: this module only forwards in
 * memory, does not write to disk, does not record versions, and clears on restart.
 *
 * Messages (all carry `projectId`, may carry `session`; write identity is taken from the project
 * module as principal plus `session`, and self-reported identities in messages are never accepted):
 * - `presence.set { key, data, ttlMs? }`: records "this entry for this identity" (replacing the
 *   entire entry for the same identity and same key), broadcasts
 *   `presence.update { projectId, key, from, data, expiresAt }` to other subscribers on the
 *   project channel, and returns `presence.ok`;
 * - `presence.clear { key }`: removes it, and broadcasts
 *   `presence.update { …, data: null, expiresAt: 0 }`;
 * - `presence.list`: returns
 *   `presence.state { projectId, entries: [{ key, from, data, expiresAt }] }` (unexpired ones);
 * - `presence.send { data }`: does not record, only broadcasts
 *   `presence.message { projectId, from, data, at }` once (messages between Agents);
 * - If the connection drops, all entries it recorded are removed together (broadcasting revocations).
 * `data` is defined by client convention (`kind: 'editing' | 'agent' | 'agent-message'`); this
 * module does not inspect the content, only limits its size.
 *
 * Broadcasting borrows `publishToProject` from the project module in the same space (subscription is
 * simply `project.open`), following the same approach as the events module; connections from render
 * nodes cannot send.
 *
 * **Compatibility**: Older versions of the document service do not have this module, and return
 * `error { reason: 'unsupported' }` for these messages (the core's "no module handles this message"),
 * based on which the client stops sending, reports no errors, and does not disconnect; old clients
 * do not send these messages and are unaffected.
 */
import { actorOf } from './actor.mjs';

export const PRESENCE_MODULE = 'presence';

export const PRESENCE_LIMITS = Object.freeze({
  /** Upper limit for serialized `data` (UTF-8 bytes) */
  DATA_BYTES: 8 * 1024,
  /** Expiration time: default, minimum, maximum */
  TTL_DEFAULT_MS: 30_000,
  TTL_MIN_MS: 1_000,
  TTL_MAX_MS: 30 * 60_000,
  /** Maximum number of items recorded per project */
  PER_PROJECT: 256,
});

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }
class Refused extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

const identityOf = (a) => JSON.stringify([a?.userId ?? null, a?.deviceId ?? null, a?.role ?? null, a?.conversation ?? null, a?.session ?? null]);

/**
 * @param {object} options
 * @param {{ publishToProject(projectId: string, message: object, opts?: object): number }} options.project
 *   Project module in the same space
 * @param {() => number} [options.now]
 */
export function presenceModule({ project, now } = {}) {
  if (!project || typeof project.publishToProject !== 'function') throw new TypeError('presenceModule: project must be a project module with publishToProject');
  const principals = new Map();
  /** projectId → Map<entryKey, { key, from, data, expiresAt, connId }> */
  const projects = new Map();
  const stats = { sets: 0, clears: 0, sends: 0, lists: 0 };
  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function common(connId, msg) {
    if (typeof msg.projectId !== 'string' || !PROJECT_ID_RE.test(msg.projectId)) bad('projectId is invalid');
    let session = null;
    if (msg.session !== undefined && msg.session !== null) {
      if (typeof msg.session !== 'string' || msg.session.length < 1 || msg.session.length > 128) bad('session must be a string of 1-128 characters');
      session = msg.session;
    }
    const principal = principals.get(connId);
    if (principal?.role === 'render') throw new Refused('forbidden', 'Render node connections cannot send presence state');
    return { projectId: msg.projectId, from: actorOf(principal, session) };
  }

  function checkData(v) {
    if (!isObj(v)) bad('data must be an object');
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch { bad('data cannot be serialized'); }
    if (bytes > PRESENCE_LIMITS.DATA_BYTES) throw new Refused('too-large', `data exceeds ${PRESENCE_LIMITS.DATA_BYTES} bytes`);
    return v;
  }

  function prune(list, t) {
    for (const [k, e] of list) if (e.expiresAt <= t) list.delete(k);
  }

  function listOf(projectId) {
    let list = projects.get(projectId);
    if (!list) projects.set(projectId, (list = new Map()));
    return list;
  }

  function set(ctx, connId, msg, reqId) {
    const { projectId, from } = common(connId, msg);
    if (typeof msg.key !== 'string' || !KEY_RE.test(msg.key)) bad('key must be 1-64 characters from [A-Za-z0-9._:-]');
    const data = checkData(msg.data);
    let ttl = PRESENCE_LIMITS.TTL_DEFAULT_MS;
    if (msg.ttlMs !== undefined) {
      if (!Number.isFinite(msg.ttlMs)) bad('ttlMs must be a number');
      ttl = Math.min(PRESENCE_LIMITS.TTL_MAX_MS, Math.max(PRESENCE_LIMITS.TTL_MIN_MS, Math.round(msg.ttlMs)));
    }
    const t = clock(ctx);
    const list = listOf(projectId);
    prune(list, t);
    const entryKey = `${identityOf(from)}|${msg.key}`;
    if (!list.has(entryKey) && list.size >= PRESENCE_LIMITS.PER_PROJECT) throw new Refused('too-many', `This project already has ${PRESENCE_LIMITS.PER_PROJECT} presence entries`);
    const expiresAt = t + ttl;
    list.set(entryKey, { key: msg.key, from, data, expiresAt, connId });
    stats.sets += 1;
    project.publishToProject(projectId, { type: 'presence.update', projectId, key: msg.key, from, data, expiresAt }, { except: connId });
    reply(ctx, connId, { type: 'presence.ok', projectId, key: msg.key, expiresAt }, reqId);
  }

  function clear(ctx, connId, msg, reqId) {
    const { projectId, from } = common(connId, msg);
    if (typeof msg.key !== 'string' || !KEY_RE.test(msg.key)) bad('key must be 1-64 characters from [A-Za-z0-9._:-]');
    const list = projects.get(projectId);
    const had = list?.delete(`${identityOf(from)}|${msg.key}`);
    stats.clears += 1;
    if (had) project.publishToProject(projectId, { type: 'presence.update', projectId, key: msg.key, from, data: null, expiresAt: 0 }, { except: connId });
    reply(ctx, connId, { type: 'presence.ok', projectId, key: msg.key, expiresAt: 0 }, reqId);
  }

  function list(ctx, connId, msg, reqId) {
    const { projectId } = common(connId, msg);
    const t = clock(ctx);
    const l = projects.get(projectId);
    if (l) prune(l, t);
    stats.lists += 1;
    const entries = l ? [...l.values()].map(({ key, from, data, expiresAt }) => ({ key, from, data, expiresAt })) : [];
    reply(ctx, connId, { type: 'presence.state', projectId, entries }, reqId);
  }

  function send(ctx, connId, msg, reqId) {
    const { projectId, from } = common(connId, msg);
    const data = checkData(msg.data);
    stats.sends += 1;
    const n = project.publishToProject(projectId, { type: 'presence.message', projectId, from, data, at: clock(ctx) }, { except: connId });
    reply(ctx, connId, { type: 'presence.ok', projectId, delivered: n }, reqId);
  }

  const HANDLERS = { 'presence.set': set, 'presence.clear': clear, 'presence.list': list, 'presence.send': send };

  return {
    name: PRESENCE_MODULE,
    types: ['presence.'],

    connect(ctx, connId, principal) {
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      principals.delete(connId);
      for (const [projectId, l] of projects) {
        for (const [k, e] of l) {
          if (e.connId !== connId) continue;
          l.delete(k);
          project.publishToProject(projectId, { type: 'presence.update', projectId, key: e.key, from: e.from, data: null, expiresAt: 0 });
        }
        if (!l.size) projects.delete(projectId);
      }
    },

    tick(ctx) {
      const t = clock(ctx);
      for (const [projectId, l] of projects) {
        prune(l, t);
        if (!l.size) projects.delete(projectId);
      }
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: 'The presence module does not support this message' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (err instanceof Refused) return reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
        if (!(err instanceof BadMessage)) throw err;
        reply(ctx, connId, { type: 'error', reason: 'bad-message', detail: err.message }, reqId);
      }
    },

    describe() {
      return { projects: projects.size, entries: [...projects.values()].reduce((n, l) => n + l.size, 0), stats: { ...stats } };
    },
  };
}

export const createPresenceModule = presenceModule;
export default presenceModule;
