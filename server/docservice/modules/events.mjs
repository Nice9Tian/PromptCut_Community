/**
 * Tool call event module (C6.5 design draft `docs/plan/c65-design.md` section 7, D2 "Page receives
 * deltas per operation").
 *
 * The Agent server sends two events per tool call: creation (tool name, icon, target, parameter
 * summary) and completion (status, summary, duration); it sends one when an entire text reply
 * completes. This module broadcasts them on the **project channel** (`project:<projectId>`, held
 * by the project module) as `events.event`, and the page AI panel updates the corresponding record
 * by `eventId`. Full parameters (`detail`) are written to the content store `event-detail` under the
 * key `<projectId>/<eventId>`, which the page pulls again via `content.get` when expanding.
 *
 * This module does not declare its own channel: broadcasting borrows `publishToProject` from the
 * project module in the same space, and subscription is simply `project.open`; writing to the
 * content store borrows `putFromModule` from the content module. Both are passed in paired by space
 * by the assembly layer (`shared-service.mjs`). Write identity follows the project module by taking
 * the principal plus `session` from the message (`actor.mjs`); render node connections cannot send
 * events. A copy of recent events per project is kept in memory (retrieved via `events.list`) without
 * persisting to disk: fresh events start after a restart.
 *
 * Both events can carry `callId` (the model-side id of this tool call, used by the page AI panel to
 * match against chat records; c65-integ2). Completion events can carry `opId`, `rev`, and `inverse`
 * (inverse operation) written to the project by this call, broadcast as-is and recorded in
 * `events.list`; they can also carry `detail` to rewrite `event-detail` once under the same key
 * (c65-agent, lead session ruling: result summary is stored together with write info).
 */
import { actorOf } from './actor.mjs';

export const EVENTS_MODULE = 'events';

export const EVENTS_LIMITS = Object.freeze({
  /** How many events to keep in memory per project */
  KEEP: 500,
  TOOL: 128,
  /** Model-side id of this tool call (AI panel matches chat records with it, c65-integ2) */
  CALL_ID: 128,
  ICON: 64,
  TARGET: 512,
  ARGS: 2048,
  SUMMARY: 2048,
  TEXT: 64 * 1024,
  /** Upper limit for serialized inverse operation in completion events (UTF-8 bytes); matches commit limit */
  INVERSE: 256 * 1024,
});

export const EVENT_STATUSES = Object.freeze(['ok', 'error', 'cancelled']);

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }
class Refused extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

function checkProjectId(v) {
  if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) bad('projectId is invalid');
  return v;
}

function checkEventId(v) {
  if (typeof v !== 'string' || !EVENT_ID_RE.test(v)) bad('eventId must be 1-128 characters from [A-Za-z0-9._:-]');
  return v;
}

/** Optional short text: null if omitted (or null); if provided, must be string of at most max characters */
function optText(v, name, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) bad(`${name} must be a string of at most ${max} characters`);
  return v;
}

function checkSession(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) bad('session must be a string of 1-128 characters');
  return v;
}

/** Key for event details in the content store */
export const eventDetailKey = (projectId, eventId) => `${projectId}/${eventId}`;

/**
 * @param {object} options
 * @param {{ publishToProject(projectId: string, message: object, opts?: object): number }} options.project
 *   Project module in the same space (for broadcasting)
 * @param {{ putFromModule(args: object): object }} [options.content] Content module in the same space
 *   (for writing `event-detail`); events carrying `detail` return `unsupported` when omitted
 * @param {() => number} [options.now] Defaults to `ctx.now()`
 */
export function eventsModule({ project, content = null, now } = {}) {
  if (!project || typeof project.publishToProject !== 'function') throw new TypeError('eventsModule: project must be a project module with publishToProject');
  /** connId → principal */
  const principals = new Map();
  /** projectId → Map<eventId, record> (insertion order, drops earliest when exceeding limit) */
  const recent = new Map();
  const stats = { created: 0, completed: 0, texts: 0, details: 0 };

  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function remember(projectId, eventId, patch) {
    let list = recent.get(projectId);
    if (!list) recent.set(projectId, (list = new Map()));
    const rec = { ...(list.get(eventId) ?? { eventId }), ...patch };
    list.delete(eventId);
    list.set(eventId, rec);
    while (list.size > EVENTS_LIMITS.KEEP) list.delete(list.keys().next().value);
    return rec;
  }

  function common(connId, msg) {
    const projectId = checkProjectId(msg.projectId);
    const eventId = checkEventId(msg.eventId);
    const session = checkSession(msg.session);
    const principal = principals.get(connId);
    if (principal?.role === 'render') throw new Refused('forbidden', 'Render node connections cannot send tool call events');
    return { projectId, eventId, actor: actorOf(principal, session) };
  }

  function broadcast(connId, projectId, event) {
    project.publishToProject(projectId, { type: 'events.event', ...event }, { except: connId });
  }

  function create(ctx, connId, msg, reqId) {
    const { projectId, eventId, actor } = common(connId, msg);
    if (typeof msg.tool !== 'string' || msg.tool.length < 1 || msg.tool.length > EVENTS_LIMITS.TOOL) bad(`tool must be a string of 1-${EVENTS_LIMITS.TOOL} characters`);
    const icon = optText(msg.icon, 'icon', EVENTS_LIMITS.ICON);
    const target = optText(msg.target, 'target', EVENTS_LIMITS.TARGET);
    const args = optText(msg.args, 'args', EVENTS_LIMITS.ARGS);
    const callId = optText(msg.callId, 'callId', EVENTS_LIMITS.CALL_ID);
    const at = clock(ctx);
    let detailKey = null;
    if (msg.detail !== undefined) {
      if (!content || typeof content.putFromModule !== 'function') throw new Refused('unsupported', 'No content store, cannot save event details');
      detailKey = eventDetailKey(projectId, eventId);
      try {
        content.putFromModule({ kind: 'event-detail', key: detailKey, body: msg.detail, actor });
      } catch (err) {
        if (err?.reason === 'too-large') throw new Refused('too-large', 'Event details exceed the content store limit');
        throw err;
      }
      stats.details += 1;
    }
    const call = callId ? { callId } : {};
    const event = { projectId, eventId, phase: 'create', tool: msg.tool, icon, target, args, detailKey, actor, at, ...call };
    remember(projectId, eventId, { tool: msg.tool, icon, target, args, detailKey, actor, createdAt: at, status: null, ...call });
    stats.created += 1;
    reply(ctx, connId, { type: 'events.ack', projectId, eventId, phase: 'create', detailKey }, reqId);
    broadcast(connId, projectId, event);
  }

  function complete(ctx, connId, msg, reqId) {
    const { projectId, eventId, actor } = common(connId, msg);
    if (!EVENT_STATUSES.includes(msg.status)) bad(`status must be one of ${EVENT_STATUSES.join(' / ')}`);
    const summary = optText(msg.summary, 'summary', EVENTS_LIMITS.SUMMARY);
    const callId = optText(msg.callId, 'callId', EVENTS_LIMITS.CALL_ID);
    const call = callId ? { callId } : {};
    let durationMs = null;
    if (msg.durationMs !== undefined && msg.durationMs !== null) {
      if (typeof msg.durationMs !== 'number' || !Number.isFinite(msg.durationMs) || msg.durationMs < 0) bad('durationMs must be a non-negative number');
      durationMs = msg.durationMs;
    }
    // When this call wrote to the project (c65-agent, lead session ruling): pass through this write's
    // `opId`, the landed `rev`, and the inverse operation `inverse`. The page AI panel "Undo this step"
    // uses this to submit the inverse operation under the page's own identity with `undoOf`. Omitted
    // for read tools and rejected writes
    const write = {};
    if (msg.opId !== undefined && msg.opId !== null) {
      if (typeof msg.opId !== 'string' || msg.opId.length < 1 || msg.opId.length > 128) bad('opId must be a string of 1-128 characters');
      write.opId = msg.opId;
    }
    if (msg.rev !== undefined && msg.rev !== null) {
      if (!Number.isSafeInteger(msg.rev) || msg.rev < 1) bad('rev must be a positive integer');
      write.rev = msg.rev;
    }
    if (msg.inverse !== undefined && msg.inverse !== null) {
      if (write.opId === undefined) bad('opId is required when inverse is present');
      if (!Array.isArray(msg.inverse)) bad('inverse must be an array of operations');
      if (Buffer.byteLength(JSON.stringify(msg.inverse), 'utf8') > EVENTS_LIMITS.INVERSE) bad(`inverse cannot exceed ${EVENTS_LIMITS.INVERSE} bytes when serialized`);
      write.inverse = msg.inverse;
    }
    // On completion, rewrite event-detail once (including result summary and above write info),
    // so the page gets everything at once when expanding this item
    let detailKey;
    if (msg.detail !== undefined) {
      if (!content || typeof content.putFromModule !== 'function') throw new Refused('unsupported', 'No content store, cannot save event details');
      detailKey = eventDetailKey(projectId, eventId);
      try {
        content.putFromModule({ kind: 'event-detail', key: detailKey, body: msg.detail, actor });
      } catch (err) {
        if (err?.reason === 'too-large') throw new Refused('too-large', 'Event details exceed the content store limit');
        throw err;
      }
      stats.details += 1;
    }
    const at = clock(ctx);
    remember(projectId, eventId, { status: msg.status, summary, durationMs, completedAt: at, completedBy: actor, ...call, ...write, ...(detailKey ? { detailKey } : {}) });
    stats.completed += 1;
    reply(ctx, connId, { type: 'events.ack', projectId, eventId, phase: 'complete', ...(detailKey ? { detailKey } : {}) }, reqId);
    broadcast(connId, projectId, { projectId, eventId, phase: 'complete', status: msg.status, summary, durationMs, actor, at, ...call, ...write, ...(detailKey ? { detailKey } : {}) });
  }

  function text(ctx, connId, msg, reqId) {
    const { projectId, eventId, actor } = common(connId, msg);
    if (typeof msg.text !== 'string' || msg.text.length > EVENTS_LIMITS.TEXT) bad(`text must be a string of at most ${EVENTS_LIMITS.TEXT} characters`);
    const at = clock(ctx);
    remember(projectId, eventId, { text: msg.text, actor, createdAt: at, completedAt: at, status: 'ok', tool: null });
    stats.texts += 1;
    reply(ctx, connId, { type: 'events.ack', projectId, eventId, phase: 'text' }, reqId);
    broadcast(connId, projectId, { projectId, eventId, phase: 'text', text: msg.text, actor, at });
  }

  function list(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const items = [...(recent.get(projectId)?.values() ?? [])].map((r) => ({ ...r }));
    reply(ctx, connId, { type: 'events.listing', projectId, items }, reqId);
  }

  const HANDLERS = { 'events.create': create, 'events.complete': complete, 'events.text': text, 'events.list': list };

  return {
    name: EVENTS_MODULE,
    types: ['events.'],

    connect(ctx, connId, principal) {
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      principals.delete(connId);
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: 'The events module does not support this message' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (err instanceof Refused) return reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
        if (!(err instanceof BadMessage)) throw err;
        reply(ctx, connId, { type: 'error', reason: 'bad-message', detail: err.message }, reqId);
      }
    },

    describe() {
      return { ...stats, projects: recent.size };
    },
  };
}

export const createEventsModule = eventsModule;
export default eventsModule;
