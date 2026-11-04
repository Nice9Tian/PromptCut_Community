import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hostedBrowserDir } from './hosted-browser.mjs';
import { reapOrphan, removeDirFully } from '../../web/hosted/session.mjs';

/**
 * After a cloud chat is deleted, thoroughly purge all places on the Agent service side that
 * still retain text for this chat (user decision, 2026-10-13: purge completely).
 *
 * What to purge (all by "project × chat"):
 *   Event store   run_events, accepted_messages (raw text of accepted messages),
 *                 conversation_heads, run_bindings, source bundles turned in by task processes
 *   Read intents  read_intents (including raw prompt text)
 *   Chat dir      <shared data dir>/tenants/<project>/conversations/<chat> (model history
 *                 history.json, job ledger under `tools/`, tracking results, delegation records)
 *   Work dir      <shared data dir>/work/<project>/<owner key>/<chat> (including user-uploaded
 *                 attachments, files downloaded by tools)
 *   Cloud browser <shared data dir>/web/<project>/<chat> (user data directory, etc.)
 * For what cannot be purged (local state of task processes across generations, IDs in usage logs),
 * see docs/reports/AGENT-v18-chats.md "Full purge table".
 *
 * **Who cleans which part** (finalized after 0.7.18 wiring review). In production, the master
 * service and task processes are two system users in the same shared group:
 *   - Event store and read intents are caller's own stores: purged on the spot, and throw on
 *     failure (page gets 503, retry purges again).
 *   - The three directories in shared data dir are **task user files** (chat directory is 0700,
 *     master service cannot even enter `tenants/`; subdirectories created by browser under user
 *     data dir can only be accessed by owner). The master service records this chat in the
 *     "pending purge list" (`<shared data dir>/conversation-purges/<id>.json`, group read/write),
 *     and attempts a best-effort delete once:
 *     if deletable (single-user machine, old hosted tier, legacy in-process path), purge on the
 *     spot and strike off the list; being unable to delete **is not considered a failure**: cleaned
 *     up by the task user side according to the list (cleaned up whenever any task process starts
 *     work, `sweepMarkedBrowsers` in `account-tools.mjs`); once cleaned up, that entry on the list
 *     is replaced with a receipt (`<id>.done`).
 *   - `pending` returned by `purge()` means "still on the list, waiting for task user side cleanup".
 *     The caller (`conversation-policy.mjs`) uses this to decide whether to send a receipt to the
 *     document service:
 *     no receipt when `pending`, reconcile (every 60s) comes again as usual; only considered fully
 *     cleaned up and receipt sent once the receipt (`.done`) is seen. The chat deletion request
 *     itself does not fail because of this.
 *
 * Idempotent: running again after full cleanup leaves nothing and throws no error.
 */
const safeSeg = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) && !/^\.+$/.test(value);
const coded = (code, status = 503) => Object.assign(new Error(code), { status, code });
export const accountConversationOwnerKey = (projectId, conversationId) =>
  createHash('sha256').update(`account-v2\n${projectId}\n${conversationId}`).digest('hex').slice(0, 32);

/* ---------- Pending purge list ---------- */

export const CONVERSATION_PURGE_DIR = 'conversation-purges';
const entryBase = (dataDir, scope) => path.join(dataDir, CONVERSATION_PURGE_DIR,
  createHash('sha256').update(`${scope.projectId}\n${scope.conversationId}`).digest('hex').slice(0, 40));
const entryFile = (dataDir, scope) => `${entryBase(dataDir, scope)}.json`;
const doneFile = (dataDir, scope) => `${entryBase(dataDir, scope)}.done`;
const checked = scope => { if (!safeSeg(scope?.projectId) || !safeSeg(scope?.conversationId)) throw coded('conversation-purge-invalid', 400); return scope; };
/** Only counts if truly gone (unreachable or invisible does not count as "gone") */
const gone = target => { try { fs.lstatSync(target); return false; } catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'; } };

/** Record a deleted chat in the pending purge list (called by master service). Recording the same
 * chat again simply overwrites it; the previous receipt is invalidated */
export function queueConversationPurge(dataDir, scope, at = Date.now()) {
  checked(scope);
  const file = entryFile(dataDir, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o770 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ projectId: scope.projectId, conversationId: scope.conversationId, at }), { mode: 0o660 });
  try { fs.chmodSync(tmp, 0o660); } catch { /* Cannot modify: the reader will report it as "unreadable" */ }
  fs.renameSync(tmp, file);
  try { fs.rmSync(doneFile(dataDir, scope), { force: true }); } catch { /* No receipt */ }
}

/** Pending purge list. Return `{ unreadable: true, code }` truthfully for unreadable or
 * unparseable entries (chat unknown, cannot purge, caller logs it) */
export function listConversationPurges(dataDir) {
  const dir = path.join(dataDir, CONVERSATION_PURGE_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /^[a-f0-9]{40}\.json$/.test(name)).sort(); }
  catch (error) { return error?.code === 'ENOENT' ? [] : [{ unreadable: true, code: typeof error?.code === 'string' ? error.code : 'error' }]; }
  return names.map(name => {
    try {
      const row = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (safeSeg(row?.projectId) && safeSeg(row.conversationId) && entryFile(dataDir, row) === path.join(dir, name)) return { projectId: row.projectId, conversationId: row.conversationId };
      return { unreadable: true, code: 'bad-entry' };
    } catch (error) { return { unreadable: true, code: typeof error?.code === 'string' ? error.code : 'bad-entry' }; }
  });
}

/** Status of this chat on the list: `queued` (waiting for purge), `done` (cleaned up on task
 * user side, receipt left), `none` */
export function conversationPurgeState(dataDir, scope) {
  checked(scope);
  if (!gone(entryFile(dataDir, scope))) return 'queued';
  return gone(doneFile(dataDir, scope)) ? 'none' : 'done';
}

/** Consume receipt (called by master service after seeing `done`): remove receipt once used */
export function acknowledgeConversationPurge(dataDir, scope) {
  checked(scope);
  try { fs.rmSync(doneFile(dataDir, scope), { force: true }); } catch { /* Cannot remove: will consume again next time, harmless */ }
}

/**
 * Purge the three directories left by a deleted chat in the shared data directory (chat directory,
 * workspace directory, cloud browser directory). Can be called by anyone:
 * Called by the side with permissions, it performs a real purge; called by the master service in
 * a two-user production setup, it is a "best-effort delete", and failure to delete (returns
 * `removed: false`) is not an error.
 * Leave browser untouched (`held`) if currently used by a live task process. Once fully purged:
 * if `receipt` is true (task user side), replace that entry on the list with a receipt;
 * otherwise (caller itself is the side expecting the receipt), strike it off the list directly.
 * @returns {Promise<{ removed: boolean, held: boolean, history: boolean, workspace: boolean, browser: boolean }>}
 *   Last three indicate "existed before purge"
 */
export async function purgeConversationData(dataDir, scope, { timeoutMs = 8_000, receipt = false } = {}) {
  checked(scope);
  const out = { removed: false, held: false, history: false, workspace: false, browser: false };
  const targets = [];
  const drop = async target => { if (gone(target)) return false; targets.push(target); try { await removeDirFully(target, { timeoutMs }); } catch { /* Treat as "still exists" below */ } return true; };
  let browser = null;
  try { browser = hostedBrowserDir(dataDir, scope); } catch { browser = null; }
  if (browser && !gone(browser)) {
    out.browser = true; targets.push(browser);
    try {
      const reaped = await reapOrphan(browser, { timeoutMs, respectLiveOwner: true });
      out.held = reaped.liveOwner === true || reaped.stillHeld === true;
      if (!out.held) await removeDirFully(browser, { timeoutMs });
    } catch { /* Treat as "still exists" below */ }
  }
  out.history = await drop(path.join(dataDir, 'tenants', scope.projectId, 'conversations', scope.conversationId));
  const work = path.join(dataDir, 'work', scope.projectId);
  let owners = [];
  try { owners = fs.readdirSync(work); } catch (error) { if (error?.code !== 'ENOENT') targets.push(work); /* Cannot list: unknown if anything remains inside, treat as "still exists" */ }
  for (const owner of owners) if (await drop(path.join(work, owner, scope.conversationId))) out.workspace = true;
  out.removed = targets.every(gone);
  if (out.removed) {
    try {
      if (receipt && !gone(entryFile(dataDir, scope))) fs.renameSync(entryFile(dataDir, scope), doneFile(dataDir, scope));
      else fs.rmSync(entryFile(dataDir, scope), { force: true });
    } catch { /* Cannot strike off: run again next time; leaves nothing and throws no error */ }
  }
  return out;
}

export function createConversationPurger({ eventStore = null, readIntents = null, sharedDataDir = null, log = () => {}, now = Date.now,
  /** Maximum wait time per location during best-effort delete on this side. Waiting longer is
   * useless if deletion lacks permissions; items temporarily undeletable (handles not yet released)
   * remain on the list and will be deleted in the next reconcile */
  timeoutMs = 400 } = {}) {
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging does not affect cleanup */ } };
  return {
    /**
     * @returns {Promise<{ runEvents, readIntents, history: boolean, workspace: boolean, pending: boolean }>}
     *   `pending`: locations in shared data directory cannot be deleted by this side, recorded in
     *   pending purge list to wait for cleanup on task user side (see file header)
     */
    async purge({ projectId, conversationId }) {
      if (!safeSeg(projectId) || !safeSeg(conversationId)) throw Object.assign(new Error('purge-invalid'), { status: 400, code: 'purge-invalid' });
      const scope = { projectId, conversationId };
      const out = { runEvents: null, readIntents: null, history: false, workspace: false, pending: false };
      try {
        if (eventStore?.purgeConversation) out.runEvents = await eventStore.purgeConversation(scope);
        if (readIntents?.purgeConversation) out.readIntents = readIntents.purgeConversation(scope);
      } catch (error) {
        say('agent.conversation.purge-failed', { code: error?.code ?? 'purge-failed' });
        throw Object.assign(new Error(error?.code ?? 'purge-failed'), { status: 503, code: 'purge-failed' });
      }
      if (sharedDataDir) {
        // Task user side has cleaned up according to list and left receipt: consume receipt, meaning
        // it is "fully purged" this time (no longer reach for unreachable directories or re-record list)
        const state = conversationPurgeState(sharedDataDir, scope);
        if (state === 'done') {
          acknowledgeConversationPurge(sharedDataDir, scope);
          say('agent.conversation.purged', { projectId, runEvents: out.runEvents?.rows ?? 0, readIntents: out.readIntents?.rows ?? 0, by: 'task-side' });
          return out;
        }
        // Record in list first (even if process dies next, task user side will clean up), then attempt
        // best-effort delete once. Do not re-record if already on list (asked again during reconcile)
        let queued = state === 'queued', code = null;
        if (!queued) { try { queueConversationPurge(sharedDataDir, scope, now()); queued = true; } catch (error) { code = typeof error?.code === 'string' ? error.code : 'error'; } }
        let data = { removed: false, held: false, history: false, workspace: false };
        try { data = await purgeConversationData(sharedDataDir, scope, { timeoutMs }); } catch (error) { code ??= typeof error?.code === 'string' ? error.code : 'error'; }
        out.history = data.history; out.workspace = data.workspace;
        if (!data.removed) {
          // Cannot even record to list and items still exist: this is an actual failure
          if (!queued) {
            say('agent.conversation.purge-failed', { code: code ?? 'purge-incomplete' });
            throw Object.assign(new Error(code ?? 'purge-incomplete'), { status: 503, code: 'purge-failed' });
          }
          out.pending = true;
          say('agent.conversation.purge-deferred', { projectId, ...(data.held ? { held: true } : {}) });
          return out;
        }
      }
      say('agent.conversation.purged', { projectId, runEvents: out.runEvents?.rows ?? 0, readIntents: out.readIntents?.rows ?? 0 });
      return out;
    },
  };
}
