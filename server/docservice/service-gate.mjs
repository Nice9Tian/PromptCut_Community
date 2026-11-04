/**
 * Permissions for host service identities: whitelist (contract
 * `docs/plan/hosted-render-contract.md` sections 1.3, 1.5).
 *
 * Connections with a `service` field are admitted via "default deny": message types not in the
 * table are always `forbidden`, and if the service is not in the table, all are rejected.
 * Evaluated by `service` field, not by `scope`: services entering projects on behalf of members
 * (Cloud Agent, `scope: 'member'` plus `service: 'agent'`) also go through the whitelist.
 * Rejection checks in existing modules based on `scope === 'member'` (such as service address
 * registration) would allow new scopes, so instead of patching checks module by module, the
 * assembly layer's `gate(principal, type, msg)` guards this in a single place.
 *
 * - **Control connection** (`scope: 'service'`, no `tenantId`, obtained during handshake via
 *   service private key): can only send catalog module's `hosted.watch`, `hosted.ticket`,
 *   `hosted.demand`, and `hosted.delegate.verify` (the last is only open to Cloud Agent service,
 *   checked in catalog module);
 * - **Data connection** (enters a project via a ticket signed by catalog module): looks up
 *   `SERVICE_ALLOW` by service name: one row for render service; one row for connections opened by
 *   Cloud Agent on behalf of members (`docs/plan/cloud-agent-contract.md` section 4.4, with two
 *   types that modify projects separately rejected for read-only members). Connections opened by
 *   Cloud Agent service solely to publish prerender retry plans (principal carries
 *   `purpose: 'publish'`) look up another table `SERVICE_PUBLISH_ALLOW`, where `task.publish` only
 *   permits plan tasks with clip manifests.
 *   Three message types also inspect content: `content.put` only allows writing prerender
 *   manifests, `auth.ticket` only allows requesting asset tickets (requesting connection tickets
 *   equals changing roles for oneself), `task.publish` does not allow publishing plan tasks
 *   (render service only publishes fine-grained tasks split by itself); connections on behalf of
 *   members by Cloud Agent: `content.*` only allows `card-source` kind (create/edit cards),
 *   `auth.ticket` only allows asset tickets, and read-write ones require the member themselves to
 *   have read-write permission (import media, not exceeding member's own permissions);
 * - Connections without a service identity sending `hosted.*` are always `forbidden`.
 *
 * Pure function, imports no modules.
 */

/** Messages that control connections can send */
export const SERVICE_CONTROL_TYPES = Object.freeze(['hosted.watch', 'hosted.ticket', 'hosted.demand', 'hosted.delegate.verify']);

/** Kinds that render service can write to content store (prerender manifests) */
export const RENDER_CONTENT_KINDS = Object.freeze(['snapshot-manifest', 'render-manifest']);

/** Service name → message types that data connections can send */
export const SERVICE_ALLOW = Object.freeze({
  render: Object.freeze([
    // Check in, claim, deliver
    'node.hello', 'node.active', 'queue.watch', 'publisher.hello', 'task.publish',
    'task.claim', 'task.progress', 'task.complete', 'task.fail', 'task.release',
    // Read project
    'project.open', 'project.close', 'project.snapshot.get',
    // Read content store; write only permits prerender manifests (checked below by kind)
    'content.get', 'content.list', 'content.watch', 'content.put',
    // Asset service address and tickets (tickets only permit asset, checked below)
    'service.watch', 'auth.ticket',
  ]),
  // Connections opened by Cloud Agent on behalf of members (`docs/plan/cloud-agent-contract.md`
  // section 4.4): identity is member, permissions cannot exceed this member, and only the following
  // types are allowed. Connections for read-only members (`access: 'r'`) separately reject
  // `AGENT_WRITE_TYPES`
  agent: Object.freeze([
    // Read project, receive others' changes
    'project.open', 'project.close',
    // Modify project (rejected for read-only)
    'project.op', 'project.upload',
    // Tool invocation events (events module writes event-detail via content store without writing
    // directly to content store over this connection)
    'events.create', 'events.complete', 'events.text',
    // Presence: clips other members are "editing", Agent's own scope, "whether running this round"
    'presence.set', 'presence.clear', 'presence.list',
    // Card source (create/edit cards, `docs/plan/cloud-agent-contract.md` section 9.4): only allowed to
    // touch the `card-source` kind in content store (checked below by kind); write requires read-write
    // permission
    'content.get', 'content.list', 'content.put',
    // Asset tickets (storing imported media, voiceovers, and other outputs into the library): only
    // permits asset; requesting read-write tickets requires member's own read-write permissions
    // (checked below)
    'auth.ticket',
    // Read shared cost records for this project (read-only, duration only): classify as light/heavy
    // before publishing prerender, only publishing heavy cards (`server/agent/service/render-clips.mjs`
    // "Only publish heavy cards")
    'cost.list',
  ]),
});

/** Content store kinds that Cloud Agent connections on behalf of members can touch */
export const AGENT_CONTENT_KINDS = Object.freeze(['card-source']);

/**
 * Connections opened under the service's own identity solely to publish prerender retry plans
 * (principal's `purpose: 'publish'`, section 16 R2 as above): service name → messages allowed to be
 * sent.
 * `task.publish` only permits publishing plan tasks with clip manifests (checked below); cannot
 * check in as node, cannot claim, cannot read/write projects or content store, and cannot obtain
 * any tickets.
 */
export const SERVICE_PUBLISH_ALLOW = Object.freeze({
  agent: Object.freeze(['publisher.hello', 'task.publish', 'task.unsubscribe']),
});

/** Messages that Cloud Agent connections for read-only members cannot send (modifying projects) */
export const AGENT_WRITE_TYPES = Object.freeze(['project.op', 'project.upload', 'content.put']);

/**
 * Result key marks for plan tasks with clip manifests (identical to `CLIPS_KEY_MARK` and
 * `BACKFILL_KEY_MARK` in `../render-queue/messages.mjs`; this file imports no modules, copied
 * verbatim, cross-checked in unit tests)
 */
export const CLIP_LIST_KEY_MARKS = Object.freeze(['#clips:', '#backfill:']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} principal
 * @param {string} type
 * @param {object} [msg] Entire message (content inspected for three message types)
 * @returns {string | null} Reason for rejection; returns null if allowed
 */
export function serviceGate(principal, type, msg) {
  const isService = typeof principal?.service === 'string' || principal?.scope === 'service';
  if (!isService) return type.startsWith('hosted.') ? 'forbidden' : null;
  const inSpace = typeof principal.tenantId === 'string' && principal.tenantId !== '';
  if (!inSpace) return principal.scope === 'service' && SERVICE_CONTROL_TYPES.includes(type) ? null : 'forbidden';
  if (principal.purpose !== undefined) {
    // Connections used solely for publishing: separate table, and must be under the service's own identity
    if (principal.purpose !== 'publish' || principal.scope !== 'service') return 'forbidden';
    const publish = Object.hasOwn(SERVICE_PUBLISH_ALLOW, principal.service) ? SERVICE_PUBLISH_ALLOW[principal.service] : null;
    if (!publish || !publish.includes(type)) return 'forbidden';
    if (type === 'task.publish') {
      // Only permits plan tasks with clip manifests: kind is plan, result key carries clip manifest
      // marks, input.clips is non-empty array. Others (fine-grained tasks, whole-project plans) are all
      // rejected
      const tasks = Array.isArray(msg?.tasks) ? msg.tasks : null;
      if (!tasks || tasks.length === 0) return 'forbidden';
      const clipPlan = (t) => isObj(t) && t.kind === 'plan' && typeof t.resultKey === 'string' && CLIP_LIST_KEY_MARKS.some((m) => t.resultKey.includes(m))
        && isObj(t.input) && Array.isArray(t.input.clips) && t.input.clips.length > 0;
      if (!tasks.every(clipPlan)) return 'forbidden';
    }
    return null;
  }
  const allow = Object.hasOwn(SERVICE_ALLOW, principal.service) ? SERVICE_ALLOW[principal.service] : null;
  const accountAgent = principal.realm === 'account' && principal.identityVersion === 2 && principal.service === 'agent';
  if (!allow || (!allow.includes(type) && !(accountAgent && type === 'selection.query'))) return 'forbidden';
  if (principal.service === 'agent') {
    // Connections on behalf of members must have member identity; read-only cannot modify projects
    if (principal.scope !== 'member') return 'forbidden';
    // v2 writes must pass the live run provider in the assembly gate. A cached
    // page access field cannot revoke a retained run or authorize a new one.
    if (!accountAgent && principal.access !== 'rw' && AGENT_WRITE_TYPES.includes(type)) return 'forbidden';
    // Content store only permits card-source kind (prerender manifests, event details, and other
    // kinds cannot be touched)
    if (type.startsWith('content.') && !AGENT_CONTENT_KINDS.includes(msg?.kind)) return 'forbidden';
    // Tickets only permit asset tickets (connection tickets and delegations cannot be requested: Agent
    // cannot change roles or extend lease for itself); read-write tickets require member's own
    // read-write permissions
    if (type === 'auth.ticket') {
      if (msg?.kind !== 'asset') return 'forbidden';
      if ((msg.access ?? 'r') !== 'r' && principal.access !== 'rw') return 'forbidden';
    }
  }
  if (principal.service === 'render') {
    if (type === 'content.put' && !RENDER_CONTENT_KINDS.includes(msg?.kind)) return 'forbidden';
    if (type === 'auth.ticket' && msg?.kind !== 'asset') return 'forbidden';
    if (type === 'task.publish') {
      // Malformed messages are left to the queue to return bad-message; here only plan tasks are blocked
      const tasks = Array.isArray(msg?.tasks) ? msg.tasks : [];
      if (tasks.some((t) => isObj(t) && t.kind === 'plan')) return 'forbidden';
    }
  }
  return null;
}
