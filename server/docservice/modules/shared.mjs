/**
 * Member and creator operations module for shared projects (contract `docs/plan/auth-contract.md`
 * sections 7 and 8), type prefix `shared.`, plus `auth.ticket`.
 *
 * | Message | Response | Description |
 * |---|---|---|
 * | `shared.members` | `shared.members.list { devices }` | Online devices in this space, aggregated into one row by "username + device" |
 * | `shared.watch` | `shared.members.list` | Subscribe to member changes in this space; afterwards, receive one more message whenever a connection enters or leaves, or on creator operations |
 * | `shared.challenge` | `shared.challenge.ok { nonce, salt, kdf }` | Fetch a challenge for a creator operation (binds this connection to the project) |
 * | `shared.admin` | `shared.admin.ok { op }` or `error` | `{ op, proof: { nonce, m }, … }`, see below for op |
 * | `auth.ticket` | `auth.ticket.ok { ticket, exp }` | Issue asset tickets, connection tickets, or Cloud Agent delegations (`kind: 'delegate'`, see `delegateTicket`) |
 *
 * Host services (contract `docs/plan/hosted-render-contract.md` sections 1.6, 1.7, 3; present only
 * on the hosted side when the assembler provides `hostedServices`):
 * - `shared.members.list` includes an extra top-level
 *   `hosted: { render: { available, enabled }, agent: { available, enabled } }`
 *   (`available`: this document service's registry contains this service; `enabled`: this
 *   project's toggle for it, treated as enabled if missing from the record). Projects on this
 *   machine do not have this field;
 * - Connections entering under the service's own identity (render service) get a separate row,
 *   with an extra `service: '<service-name>'` on the row (`username` is the reserved
 *   `service:<service-name>`, `creator: false`), and the UI displays by the `service` field
 *   instead of inspecting the username; service connections entering on behalf of a member (Cloud
 *   Agent) are grouped into that member's row, with that item in `conns` carrying
 *   `service: '<service-name>'`;
 * - Creator operation `set-hosted-service { service: 'render' | 'agent', enabled: boolean }`:
 *   changes toggle (project record `hosted.<service-name>.enabled`), does not increment generation,
 *   and does not disconnect members' own connections. When turned off, connections for this
 *   service in this project first release held claims, then close with 4003 `service-disabled`;
 *   and sends `shared.notice { event: 'hosted-service-changed', service, enabled }` to other
 *   member connections in this space. Returns `bad-message` if this service is not in the registry;
 *   modification only changes `enabled`, preserving sub-options under the same service
 *   (`render.streams`);
 * - Creator operation `set-hosted-option { service: 'render', option: 'streams', enabled: boolean }`:
 *   modifies a sub-option under the service (project record
 *   `hosted.<service-name>.<option-name>`, treated as disabled if missing). Only records and
 *   notifies, without disconnecting connections or modifying claims; member list top level
 *   `hosted.render` additionally carries `streams`; sends
 *   `shared.notice { event: 'hosted-option-changed', service, option, enabled }` to other member
 *   connections in this space (excluding service connections). Returns `bad-message` if `service`
 *   is unrecognized, not in the registry, `option` is unrecognized, or `enabled` is not boolean;
 * - `auth.ticket` for service connections (`scope: 'service'`) only issues asset tickets, with the
 *   payload additionally carrying `sv` (service name) and `sk` (public key id);
 * - Usernames starting with `service:` are reserved for service identities: returns `bad-message`
 *   if list items in `set-list` or targets of `kick` / `unban` use such usernames.
 *
 * Creator operations: `set-password`, `set-list`, `kick`, `unban`, `delete`. Each time requires a
 * new creator proof
 * `m = HMAC-SHA256(K_creator, "promptcut.admin.v1\n" + projectId + "\n" + creatorUsername + "\n" + op + "\n" + nonce)`,
 * where `nonce` must be provided by `shared.challenge` just fetched on the same connection.
 * Returns `forbidden` if proof is missing or incorrect; incorrect proof counts towards rate
 * limiting (section 9), returning `rate-limited` during the cooldown period. Except for these five
 * operations, creator and ordinary members behave completely identically.
 *
 * Admin identities do not belong to any space (the assembly layer's admission check already blocks
 * them from sending `shared.*`); `local` identities have no project, and requests here always
 * return `forbidden`, except `shared.members` / `shared.watch` which still return connections in
 * this space (`local`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ROLES, adminPurpose, b64urlDecode, isUsername as isUsernameShape, isDeviceId, isRole, isConversation, normalizeOwner, isReservedUsername,
} from '../../auth/protocol.mjs';
import { serviceAdmission, hostedStateOf, HOSTED_SERVICES, HOSTED_OPTIONS } from '../../auth/service-identity.mjs';
import { signTicket, userGeneration } from '../../auth/tickets.mjs';
import { signDelegation, memberAccess } from '../../auth/delegation.mjs';
import { DELEGATION_AUDIENCES, isConversationId } from '../../auth/protocol.mjs';
import { admissionOf, isLoopbackAddress } from '../../auth/handshake.mjs';
import { parseList, isCred } from '../../auth/http.mjs';
import { parseInviteOptions, issueInvite, inviteStatus } from '../../auth/invite.mjs';
import { tr } from '../../i18n.mjs';

export const SHARED_MODULE = 'shared';
export const ADMIN_OPS = Object.freeze([
  'set-password', 'set-list', 'kick', 'unban', 'delete', 'set-creator-password', 'list-bans',
  'invite-create', 'invite-revoke', 'invite-status',
  'set-hosted-service', 'set-hosted-option',
]);

/** Usernames that members can use: valid shape, and not starting with `service:`, which is reserved for service identities */
const isUsername = (v) => isUsernameShape(v) && !isReservedUsername(v);

/**
 * Three creator operations added in C10a (`docs/plan/c10a-contract.md` section 5; rules and storage
 * in `../../auth/invite.mjs`):
 * - `invite-create { expiresInSec?, maxUses? }`: invalidates the old one and issues a new one
 *   (default 7 days, unlimited uses), returning `shared.admin.ok { op, code, expiresAt, maxUses }`;
 *   the plaintext appears only in this single response. Also carries `linkOrigin`: public origin
 *   of the hosted side (takes the origin of `PROMPTCUT_DOCSERVICE_PUBLIC_URL`, passed in by the
 *   assembly layer; null if unset), used by the UI to assemble the invite link
 *   `<origin>/editor#invite=<code>`;
 * - `invite-revoke`: invalidates the current one, subsequent joins using it will always fail;
 *   returns ok as usual when there is no invite code;
 * - `invite-status`: returns `{ op, active, expiresAt, maxUses, used, revokedAt }`, excluding
 *   plaintext.
 * None of the three increment the generation or disconnect any connections (invalidating an invite
 * code does not affect users who have already joined). Proof and rate limiting are identical to
 * other ops.
 */

/**
 * Two creator operations added in C6.5 (`docs/plan/c65-design.md` section 9 ruling, lead session
 * ruling 2026-09-26):
 * - `set-creator-password { creator: { salt, key } }`: changes the creator's own passphrase (part
 *   of privilege 1 "change project password"). Username stays unchanged; after changing, the old
 *   passphrase can no longer enter as creator, while the new passphrase can, and subsequent creator
 *   operations calculate proof using the new passphrase. **Does not increment generation**, does
 *   not invalidate issued tickets, and does not disconnect online connections (only changing
 *   project passphrase or list increments generation). Usable in both entry modes.
 * - `list-bans`: returns `shared.admin.ok { op, bans: [{ username, deviceId }], list?: [usernames] }`,
 *   read-only (restricted entry additionally includes usernames from the list, without salt and K).
 *   Needed by UI for "Banned devices" and "Edit list"; also used as a side-effect-free proof check
 *   for "Verify creator identity" before each creator operation.
 * - Entries in `set-list` can be written as `{ username, keep: true }`: keeps this user's existing
 *   passphrase (the creator cannot obtain others' K; when only adding/removing or changing specific
 *   users, others remain unchanged). If this user is not in the list, the entire batch returns
 *   bad-message.
 * In addition, after `set-password` succeeds, sends a
 * `shared.notice { event: 'password-changed' }` to each of the other online connections in this
 * space; the UI displays a "Project password has been modified" bubble accordingly (interaction
 * draft section 5); online connections remain connected as before.
 */

/** Close codes (section 7) */
export const CLOSE_REMOVED = 4003;
export const CLOSE_DELETED = 4004;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
// Admin identities and host service control identities (services without tenantId) are not in any space
const spaceOf = (p) => {
  if (typeof p?.tenantId === 'string' && p.tenantId !== '') return p.scope === 'admin' ? null : p.tenantId;
  return p?.scope === 'admin' || p?.scope === 'service' ? null : 'local';
};

class Refused extends Error {
  constructor(reason, detail) {
    super(detail ?? reason);
    this.reason = reason;
  }
}

/**
 * @param {object} options
 * @param {() => object | null} options.store Fetches credential store (`../../auth/store.mjs`)
 * @param {ReturnType<import('../../auth/challenges.mjs').createChallenges>} options.challenges Challenges for creator operations (stored separately from entry challenges of HTTP endpoints)
 * @param {ReturnType<import('../../auth/rate-limit.mjs').createRateLimiter>} options.limiter
 * @param {(tenantId: string) => void} [options.dropSpace] Drops all data for this space when deleting a project
 * @param {(connId: string) => number} [options.claimsOf] Number of claims held by this connection ("Rendering" label)
 * @param {(remote: string | null) => boolean} [options.isLoopbackRemote] Loopback sources are not counted towards rate limiting
 * @param {() => number} [options.now]
 * @param {{ registry: () => object | null, releaseClaims?: (connId: string) => number, urls?: Record<string, string> } | null} [options.hostedServices]
 *   Provided only on the hosted side: getter for service registry, and "immediately release claims held by this connection" (used when turning off a render node toggle); `urls` are public addresses of services facing pages
 *   (currently only `agent`), and `hosted.<service-name>` at the top level of member list includes an extra `url`
 */
export function sharedModule({
  store,
  challenges,
  limiter,
  dropSpace = () => {},
  claimsOf = () => 0,
  isLoopbackRemote = isLoopbackAddress,
  now,
  linkOrigin = null,
  hostedServices = null,
  accountRuntime = null,
} = {}) {
  const storeOf = typeof store === 'function' ? store : () => store;
  const registryOf = () => {
    try { return hostedServices?.registry?.() ?? null; } catch { return null; }
  };

  /** Top-level `hosted` in member list: present only for shared projects on the hosted side */
  function hostedOf(space) {
    if (!hostedServices || space === null) return undefined;
    const rec = storeOf()?.peek(space);
    if (!rec) return undefined;
    const state = hostedStateOf(registryOf(), rec);
    // How the page finds this service (public address of Cloud Agent, `cloud-agent-contract.md` section 10.4): included only when configured by the assembler and this service is in the registry
    for (const [name, url] of Object.entries(hostedServices.urls ?? {})) {
      if (typeof url === 'string' && url !== '' && state[name]?.available) state[name].url = url;
    }
    return state;
  }

  function listMessage(space, devices = devicesOf(space)) {
    const message = { type: 'shared.members.list', devices };
    const hosted = hostedOf(space);
    if (hosted) message.hosted = hosted;
    return message;
  }

  /** Whether this connection belongs to a host service (under its own identity, or on behalf of a member) */
  const serviceOf = (p) => (typeof p?.service === 'string' ? p.service : null);
  /** connId → { principal, space, watching } */
  const conns = new Map();
  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function connsIn(space) {
    return [...conns.entries()].filter(([, c]) => c.space === space);
  }

  /** Member list of this space (section 7) */
  function devicesOf(space) {
    const rows = new Map();
    for (const [connId, c] of connsIn(space)) {
      const p = c.principal;
      // Connections used by the Cloud Agent service only to publish prerender retry plans (`cloud-agent-contract.md` section 16) are not anyone's device and do not represent any member, so they are not listed
      if (p.purpose === 'publish') continue;
      const key = p.userId;
      let row = rows.get(key);
      if (!row) {
        row = {
          deviceId: p.deviceId ?? null,
          deviceName: p.deviceName ?? null,
          username: p.username ?? p.userId,
          displayName: p.username ?? p.userId,
          creator: p.creator === true,
          tags: { editing: false, rendering: false, agents: 0 },
          conns: [],
        };
        // Connections for host services: not members; the UI displays by this field ("Host render node") instead of inspecting the username
        if (p.scope === 'service' && typeof p.service === 'string') row.service = p.service;
        rows.set(key, row);
      }
      const role = p.role ?? 'page';
      const item = { role };
      if (p.conversation !== undefined && p.conversation !== null) item.conversation = p.conversation;
      if (p.owner !== undefined && p.owner !== null) item.owner = { ...p.owner };
      // Service connections entering on behalf of a member (Cloud Agent) are grouped into the member's row, with the connection item indicating which service it is
      if (serviceOf(p) !== null && p.scope !== 'service') item.service = p.service;
      row.conns.push(item);
      if (role === 'page') row.tags.editing = true;
      if (role === 'agent') row.tags.agents += 1;
      if (role === 'render' && !row.tags.rendering) {
        let n = 0;
        try { n = Number(claimsOf(connId)) || 0; } catch { n = 0; }
        if (n > 0) row.tags.rendering = true;
      }
    }
    const list = [...rows.values()];
    // When the same username appears on different devices: all of them display as "Username (device name)"
    for (const row of list) {
      const clash = list.some((o) => o !== row && o.username === row.username && o.deviceId !== row.deviceId);
      if (clash) row.displayName = `${row.username} (${row.deviceName ?? row.deviceId})`;
    }
    list.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : String(a.deviceId) < String(b.deviceId) ? -1 : String(a.deviceId) > String(b.deviceId) ? 1 : 0));
    return list;
  }

  function notify(ctx, space) {
    if (space === null) return;
    let devices = null;
    for (const [connId, c] of connsIn(space)) {
      if (!c.watching) continue;
      devices ??= devicesOf(space);
      ctx.send(connId, listMessage(space, structuredClone(devices)));
    }
  }

  /** This connection is a member of a shared project (including local declarations), and the project still exists */
  function memberRecord(c) {
    if (!c || c.principal.scope !== 'member') throw new Refused('forbidden', tr("Only members of a shared project can do this"));
    const rec = storeOf()?.peek(c.space);
    if (!rec) throw new Refused('forbidden', tr("Project does not exist"));
    return rec;
  }

  function checkBlocked(ctx, connId) {
    const remote = ctx.remote?.(connId) ?? null;
    const loop = isLoopbackRemote(remote);
    if (!loop && limiter.blocked(remote)) throw new Refused('rate-limited', tr("Too many wrong passwords, try again later"));
    return { remote, loop };
  }

  // ---------- Messages ----------

  function members(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    if (!c || c.space === null) throw new Refused('forbidden');
    reply(ctx, connId, listMessage(c.space), reqId);
  }

  function watch(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    if (!c || c.space === null) throw new Refused('forbidden');
    c.watching = true;
    reply(ctx, connId, listMessage(c.space), reqId);
  }

  function challenge(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    const rec = memberRecord(c);
    checkBlocked(ctx, connId);
    const nonce = challenges.issue(['admin', connId, c.space]);
    reply(ctx, connId, { type: 'shared.challenge.ok', nonce, salt: rec.creator.salt, kdf: { ...rec.kdf } }, reqId);
  }

  /** Host service connection requesting tickets: only issues asset tickets with `sv` / `sk`; never issues connection tickets (which would be equivalent to changing its own role) */
  function serviceTicket(ctx, connId, c, msg, reqId) {
    const p = c.principal;
    if (c.space === null) throw new Refused('forbidden', 'A control connection cannot get a ticket');
    const rec = storeOf()?.peek(c.space) ?? null;
    if (!rec) {
      const runtime = typeof accountRuntime === 'function' ? accountRuntime() : accountRuntime;
      if (runtime && typeof runtime.issueServiceAssetTicket === 'function') {
        if (msg.kind !== 'asset') throw new Refused('forbidden', 'A service identity can only request asset tickets');
        const access = msg.access ?? 'r';
        if (access !== 'r' && access !== 'rw') throw new Refused('bad-message', "access must be 'r' or 'rw'");
        const out = runtime.issueServiceAssetTicket({ projectId: c.space, service: p.service, serviceKid: p.serviceKid, access });
        return reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.assetTicket ?? out.ticket, exp: out.expiresAt ?? out.exp }, reqId);
      }
    }
    const refused = serviceAdmission({ registry: registryOf(), record: rec, service: p.service, kid: p.serviceKid, role: p.role });
    if (refused) throw new Refused('forbidden', refused);
    if (msg.kind !== 'asset') throw new Refused('forbidden', 'A service identity can only request asset tickets');
    const access = msg.access ?? 'r';
    if (access !== 'r' && access !== 'rw') throw new Refused('bad-message', "access must be 'r' or 'rw'");
    const out = signTicket(rec, { k: 'asset', u: p.userId, r: access, dn: p.deviceName, sv: p.service, sk: p.serviceKid }, clock(ctx));
    reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
  }

  /**
   * Service connections entering a project on behalf of a member (Cloud Agent,
   * `docs/plan/cloud-agent-contract.md` section 4.4) requesting asset tickets: used to store imported
   * media, voiceover, and other outputs into the library. The ticket's `u` and `ug` belong to the
   * member, carrying `sv` / `sk`; `r` does not exceed the member's current permissions (read-only
   * members cannot obtain read-write tickets). Checked here against registry, switch, list, and ban
   * table, and checked again every time by the asset service when verifying tickets
   * (`auth/asset-tickets.mjs`), so it becomes invalid immediately upon revocation without waiting
   * for the ticket to expire.
   */
  function memberServiceAssetTicket(ctx, connId, c, msg, reqId) {
    const p = c.principal;
    if (p.scope !== 'member' || c.space === null) throw new Refused('forbidden', 'A service connection cannot request this kind of ticket');
    if (msg.kind !== 'asset') throw new Refused('forbidden', 'A service connection can only request asset tickets');
    const rec = storeOf()?.peek(c.space) ?? null;
    const refused = serviceAdmission({ registry: registryOf(), record: rec, service: p.service, kid: p.serviceKid });
    if (refused) throw new Refused('forbidden', refused);
    if (registryOf()?.get(p.service)?.actsFor !== 'member') throw new Refused('forbidden', 'A service connection cannot request this kind of ticket');
    if (admissionOf(rec, { username: p.username, deviceId: p.deviceId, creator: p.creator === true })) throw new Refused('forbidden');
    const access = msg.access ?? 'r';
    if (access !== 'r' && access !== 'rw') throw new Refused('bad-message', "access must be 'r' or 'rw'");
    const mine = p.access === 'rw' && memberAccess(rec, p.username, p.creator === true) === 'rw' ? 'rw' : 'r';
    if (access === 'rw' && mine !== 'rw') throw new Refused('forbidden', 'A read-only member\'s Cloud Agent cannot request a read-write asset ticket');
    const out = signTicket(rec, { k: 'asset', u: p.userId, r: access, dn: p.deviceName, cr: p.creator === true, sv: p.service, sk: p.serviceKid }, clock(ctx));
    ctx.log('shared.agent-asset-ticket', { connId, projectId: c.space, access });
    reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
  }

  function ticket(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    if (c?.principal?.scope === 'service') return serviceTicket(ctx, connId, c, msg, reqId);
    // Service connections entering on behalf of a member (Cloud Agent): only issue asset tickets, with permissions not exceeding this member's current permissions; connection tickets and delegations are never issued (cannot change its own role or extend its lifetime)
    if (serviceOf(c?.principal) !== null) return memberServiceAssetTicket(ctx, connId, c, msg, reqId);
    const rec = memberRecord(c);
    const p = c.principal;
    if (admissionOf(rec, { username: p.username, deviceId: p.deviceId, creator: p.creator === true })) throw new Refused('forbidden');
    if (msg.kind === 'delegate') return delegateTicket(ctx, connId, c, rec, msg, reqId);
    const fields = { u: p.userId, dn: p.deviceName, cr: p.creator === true };
    if (msg.kind === 'asset') {
      const access = msg.access ?? 'r';
      if (access !== 'r' && access !== 'rw') throw new Refused('bad-message', "access must be 'r' or 'rw'");
      Object.assign(fields, { k: 'asset', r: access });
    } else if (msg.kind === 'conn') {
      if (!isRole(msg.role)) throw new Refused('bad-message', `role must be one of ${ROLES.join(' / ')}`);
      fields.k = 'conn';
      fields.r = msg.role;
      if (msg.role === 'agent') {
        if (!isConversation(msg.conversation)) throw new Refused('bad-message', 'An agent connection must provide a chat number (positive integer)');
        fields.c = msg.conversation;
      } else if (msg.conversation !== undefined && msg.conversation !== null) {
        throw new Refused('bad-message', 'Only agent connections carry a chat number');
      }
      if (msg.owner !== undefined && msg.owner !== null) {
        const owner = msg.role === 'render' ? normalizeOwner(msg.owner) : null;
        if (!owner) throw new Refused('bad-message', "owner is only allowed on render connections, and must be { kind: 'user' }, { kind: 'agent', c } or { kind: 'browser' }");
        fields.o = owner;
      }
    } else {
      throw new Refused('bad-message', "kind must be 'asset', 'conn' or 'delegate'");
    }
    const out = signTicket(rec, fields, clock(ctx));
    reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
  }

  /**
   * Delegations for Cloud Agent (`docs/plan/cloud-agent-contract.md` section 4.2):
   * `auth.ticket { kind: 'delegate', audience: 'agent', conversation? }`.
   * Without `conversation`, it is a delegation ticket (2 minutes, presented by the page on every
   * request); with `conversation: <chat-id>`, it is a chat delegation (60 minutes, bound to this
   * chat). Only the member's own page connection (`page` role) can request it: connections with
   * `agent` or `render` roles cannot (Agents cannot extend their own lifetime), and service
   * connections are already blocked above. Permission `acc` is populated here based on the
   * member's current permissions and cannot be specified by the page. If this document service
   * lacks this service or the project has disabled its switch, returns `service-disabled`.
   */
  function delegateTicket(ctx, connId, c, rec, msg, reqId) {
    const p = c.principal;
    if (p.role !== 'page') throw new Refused('forbidden', 'Only a member\'s page connection can request a delegation');
    if (!DELEGATION_AUDIENCES.includes(msg.audience)) throw new Refused('bad-message', `audience must be ${DELEGATION_AUDIENCES.join(' / ')}`);
    const grant = msg.conversation !== undefined && msg.conversation !== null;
    if (grant && !isConversationId(msg.conversation)) throw new Refused('bad-message', 'conversation must be a chat id (1-64 characters of [A-Za-z0-9_-])');
    if (!hostedServices || !registryOf()?.get(msg.audience) || rec.hosted?.[msg.audience]?.enabled === false) {
      throw new Refused('service-disabled', tr("This project does not have Cloud Agent enabled"));
    }
    const out = signDelegation(rec, {
      u: p.userId, dn: p.deviceName, cr: p.creator === true, aud: msg.audience,
      acc: memberAccess(rec, p.username, p.creator === true), ...(grant ? { cid: msg.conversation } : {}),
    }, clock(ctx));
    ctx.log('shared.delegate', { connId, projectId: c.space, audience: msg.audience, grant });
    reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
  }

  /** Closes matching connections in this space */
  function closeWhere(ctx, space, predicate, code, reason) {
    for (const [connId, c] of connsIn(space)) {
      if (predicate(c.principal)) ctx.close?.(connId, code, reason);
    }
  }

  function admin(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    const rec = memberRecord(c);
    const { remote, loop } = checkBlocked(ctx, connId);
    const proof = msg.proof;
    if (!isObj(proof) || typeof proof.nonce !== 'string' || typeof proof.m !== 'string') throw new Refused('forbidden', tr("Creator proof required"));
    const op = msg.op;
    if (!ADMIN_OPS.includes(op)) throw new Refused('bad-message', `op must be one of ${ADMIN_OPS.join(' / ')}`);
    const nonceOk = challenges.consume(proof.nonce, ['admin', connId, c.space]);
    const given = b64urlDecode(proof.m);
    let ok = false;
    if (nonceOk && given && given.length === 32) {
      const expected = createHmac('sha256', Buffer.from(rec.creator.key, 'base64url'))
        .update(adminPurpose({ projectId: rec.projectId, username: rec.creator.username, op, nonce: proof.nonce }))
        .digest();
      ok = timingSafeEqual(expected, Buffer.from(given));
    }
    if (!ok) {
      if (!loop) limiter.fail(remote);
      ctx.log('shared.admin.reject', { connId, remote, op, reason: nonceOk ? 'bad-proof' : 'nonce' });
      throw new Refused('forbidden', tr("Creator proof is incorrect"));
    }
    const st = storeOf();
    const space = c.space;
    switch (op) {
      case 'set-password': {
        if (rec.mode !== 'free') throw new Refused('bad-message', 'Restricted entry has no project password, use set-list to change the list');
        if (!isCred(msg.project)) throw new Refused('bad-message', 'project requires { salt, key }');
        st.update(space, (d) => {
          d.project = { salt: msg.project.salt, key: msg.project.key };
          d.generation += 1;
        });
        for (const [other] of connsIn(space)) {
          if (other !== connId) ctx.send(other, { type: 'shared.notice', event: 'password-changed' });
        }
        break;
      }
      case 'set-creator-password': {
        if (!isCred(msg.creator)) throw new Refused('bad-message', 'creator requires { salt, key }');
        st.update(space, (d) => {
          d.creator = { ...d.creator, salt: msg.creator.salt, key: msg.creator.key };
        });
        break;
      }
      case 'list-bans': {
        const bans = (rec.bans ?? []).map((b) => ({ username: b.username, deviceId: b.deviceId }));
        const out = { type: 'shared.admin.ok', op, bans };
        // Restricted entry additionally includes usernames from the list (without salt and K): UI "Edit list" needs to list the existing list
        if (rec.mode === 'restricted') out.list = (rec.list ?? []).map((e) => e.username);
        ctx.log('shared.admin', { connId, projectId: space, op });
        reply(ctx, connId, out, reqId);
        return;
      }
      case 'set-list': {
        if (rec.mode !== 'restricted') throw new Refused('bad-message', 'Open entry has no list, use set-password to change the password');
        // `{ username, keep: true }`: keeps this user's existing passphrase in the list (used when UI
        // "Edit list" only adds/removes or changes passwords for specific users; the creator cannot obtain
        // others' K, nor should they). If this user is not in the list, the entire batch returns bad-message
        const current = new Map((rec.list ?? []).map((e) => [e.username, e]));
        const given = Array.isArray(msg.list)
          ? msg.list.map((e) => (isObj(e) && e.keep === true && typeof e.username === 'string' && current.has(e.username)
            ? { username: e.username, salt: current.get(e.username).salt, key: current.get(e.username).key }
            : e))
          : msg.list;
        const list = parseList(given, rec.creator.username);
        if (!list) throw new Refused('bad-message', 'list requires [{ username, salt, key }], with unique usernames and not including the creator');
        const keep = new Set(list.map((e) => e.username));
        st.update(space, (d) => {
          d.list = list;
          d.generation += 1;
        });
        // Connections entering under the service's own identity (render service, Cloud Agent publishing connection) are not members and are outside list management: do not close
        closeWhere(ctx, space, (p) => p.scope !== 'service' && p.creator !== true && p.username !== rec.creator.username && !keep.has(p.username), CLOSE_REMOVED, 'removed');
        break;
      }
      case 'kick': {
        const { username, deviceId } = msg;
        if (!isUsername(username) || !isDeviceId(deviceId)) throw new Refused('bad-message', 'username and deviceId are required');
        const userId = `${username}@${deviceId}`;
        st.update(space, (d) => {
          d.userGenerations = { ...(d.userGenerations ?? {}), [userId]: userGeneration(d, userId) + 1 };
          d.bans = (d.bans ?? []).filter((b) => !(b.username === username && b.deviceId === deviceId));
          d.bans.push({ username, deviceId });
        });
        closeWhere(ctx, space, (p) => p.username === username && p.deviceId === deviceId, CLOSE_REMOVED, 'kicked');
        break;
      }
      case 'set-hosted-service': {
        const name = msg.service;
        if (!HOSTED_SERVICES.includes(name)) throw new Refused('bad-message', `service must be ${HOSTED_SERVICES.join(' / ')}`);
        if (!hostedServices || !registryOf()?.get(name)) throw new Refused('bad-message', 'This document service does not have this host\'s service');
        if (typeof msg.enabled !== 'boolean') throw new Refused('bad-message', 'enabled must be a boolean');
        // Only modifies enabled; other fields under the same service (sub-options, such as render.streams) are preserved, not replaced entirely
        st.update(space, (d) => { d.hosted = { ...(d.hosted ?? {}), [name]: { ...(d.hosted?.[name] ?? {}), enabled: msg.enabled } }; });
        if (!msg.enabled) {
          // Turn off: connections for this service in this project first release held claims (without waiting for the disconnect grace period), then close
          for (const [other, oc] of connsIn(space)) {
            if (serviceOf(oc.principal) !== name) continue;
            try { hostedServices.releaseClaims?.(other); } catch (err) {
              ctx.log('module.error', { module: SHARED_MODULE, hook: 'releaseClaims', message: String(err?.message ?? err) });
            }
            ctx.close?.(other, CLOSE_REMOVED, 'service-disabled');
          }
        }
        for (const [other, oc] of connsIn(space)) {
          if (other !== connId && serviceOf(oc.principal) === null) ctx.send(other, { type: 'shared.notice', event: 'hosted-service-changed', service: name, enabled: msg.enabled });
        }
        break;
      }
      case 'set-hosted-option': {
        // Sub-options under the service (currently only streams for render, off by default): only recorded and notified, without disconnecting any connections or touching claims
        const name = msg.service;
        if (!HOSTED_SERVICES.includes(name)) throw new Refused('bad-message', `service must be ${HOSTED_SERVICES.join(' / ')}`);
        if (!hostedServices || !registryOf()?.get(name)) throw new Refused('bad-message', 'This document service does not have this host\'s service');
        if (typeof msg.option !== 'string' || !HOSTED_OPTIONS[name].includes(msg.option)) {
          throw new Refused('bad-message', `option for ${name} must be ${HOSTED_OPTIONS[name].join(' / ') || '(none)'}`);
        }
        if (typeof msg.enabled !== 'boolean') throw new Refused('bad-message', 'enabled must be a boolean');
        const option = msg.option;
        st.update(space, (d) => { d.hosted = { ...(d.hosted ?? {}), [name]: { ...(d.hosted?.[name] ?? {}), [option]: msg.enabled } }; });
        for (const [other, oc] of connsIn(space)) {
          if (other !== connId && serviceOf(oc.principal) === null) {
            ctx.send(other, { type: 'shared.notice', event: 'hosted-option-changed', service: name, option, enabled: msg.enabled });
          }
        }
        break;
      }
      case 'invite-create': {
        const opts = parseInviteOptions(msg);
        if (!opts) throw new Refused('bad-message', 'expiresInSec must be a positive integer in seconds, maxUses must be a positive integer or null');
        const { code, invite } = issueInvite(st.serverSecret, opts, clock(ctx));
        // Completely replaced: the old digest is removed from the index accordingly, and the old link is invalidated immediately (invite code index in store.mjs)
        st.update(space, (d) => { d.invite = invite; delete d.inviteDigestSecret; });
        ctx.log('shared.admin', { connId, projectId: space, op });
        reply(ctx, connId, { type: 'shared.admin.ok', op, code, expiresAt: invite.expiresAt, maxUses: invite.maxUses, linkOrigin }, reqId);
        return;
      }
      case 'invite-revoke': {
        const at = clock(ctx);
        if (rec.invite && (rec.invite.revokedAt === null || rec.invite.revokedAt === undefined)) {
          st.update(space, (d) => { d.invite = { ...d.invite, revokedAt: at }; });
        }
        break;
      }
      case 'invite-status': {
        ctx.log('shared.admin', { connId, projectId: space, op });
        reply(ctx, connId, { type: 'shared.admin.ok', op, ...inviteStatus(rec.invite ?? null, clock(ctx)) }, reqId);
        return;
      }
      case 'unban': {
        const { username, deviceId } = msg;
        if (!isUsername(username) || !isDeviceId(deviceId)) throw new Refused('bad-message', 'username and deviceId are required');
        st.update(space, (d) => {
          d.bans = (d.bans ?? []).filter((b) => !(b.username === username && b.deviceId === deviceId));
        });
        break;
      }
      case 'delete': {
        reply(ctx, connId, { type: 'shared.admin.ok', op }, reqId);
        ctx.log('shared.delete', { projectId: space });
        st.remove(space);
        challenges.dropWhere((b) => b[2] === space);
        closeWhere(ctx, space, () => true, CLOSE_DELETED, 'deleted');
        try {
          dropSpace(space);
        } catch (err) {
          ctx.log('module.error', { module: SHARED_MODULE, hook: 'dropSpace', message: String(err?.message ?? err) });
        }
        return;
      }
      default:
        break;
    }
    ctx.log('shared.admin', { connId, projectId: space, op });
    reply(ctx, connId, { type: 'shared.admin.ok', op }, reqId);
    notify(ctx, space);
  }

  const HANDLERS = {
    'shared.members': members,
    'shared.watch': watch,
    'shared.challenge': challenge,
    'shared.admin': admin,
    'auth.ticket': ticket,
  };

  return {
    name: SHARED_MODULE,
    types: ['shared.', 'auth.ticket'],

    connect(ctx, connId, principal) {
      const space = spaceOf(principal);
      conns.set(connId, { principal: { ...principal }, space, watching: false });
      notify(ctx, space);
    },

    disconnect(ctx, connId) {
      const c = conns.get(connId);
      conns.delete(connId);
      challenges.dropWhere((b) => b[0] === 'admin' && b[1] === connId);
      if (c) notify(ctx, c.space);
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: 'The shared project module does not support this message' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
      }
    },

    describe() {
      const spaces = {};
      for (const c of conns.values()) {
        if (c.space === null) continue;
        spaces[c.space] = (spaces[c.space] ?? 0) + 1;
      }
      return { spaces };
    },
  };
}

export default sharedModule;
