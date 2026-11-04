/**
 * For testing only; must not be referenced by production code.
 *
 * Shared kit for C6.5 batch 2 (c65-agent, c65-editor) contract tests. Sole sources:
 *   - `docs/plan/c65-design.md` sections 5, 7, 8, 9, 13 and section 11 V3, V5, V7;
 *   - `docs/plan/c65-undo-draft.md` (user-facing undo/redo behavior and copy), `c65-ux-draft.md`
 *     (creator actions);
 *   - `docs/plan/auth-contract.md` section 7, `docs/plan/cloud-task.md` D1, D2, D4.
 * Testers did not inspect `c65-agent` or `c65-editor` implementations. Already-merged interfaces
 * (document service project / content / events modules, `DocSync` in `src/store/docsync.ts`,
 * `c65-kit.mjs`, `auth-kit.mjs`) are used as-is.
 *
 * All module paths, function names, and field names left unspecified by the design draft are
 * centralized in this file; integration reconciliation modifies only this file.
 * Each assumption is marked as "Assumption B<n>", and report
 * `docs/archive/agent-reports/AGENT-c65-tests2.md` lists them with the same numbering.
 * Where multiple candidate names are probed, probe order follows the tester's estimated order of
 * likelihood; if none match, just add another candidate name.
 *
 *   B1  Agent server project replica (design draft section 5): a factory directly drivable under
 *       Node; candidate modules `server/agent-replica.mjs`, `server/agent/replica.mjs`,
 *       `server/agent-project.mjs`, `server/agent-docsync.mjs`; candidate exports
 *       `createAgentReplica`, `createAgentProject`, `createAgentSide`. See `startAgent`
 *       comments for shape. Vite's `ssrLoadModule` is replaced by test-injected `loadModule(spec)`
 *       (install the resolution hook from `src/testing/registerTs.mjs` first).
 *   B2  Tool execution location: `server/mcp-tools.mjs` `tools[].side`. Page side is recorded as
 *       `'browser'` (existing value) or `'page'`; Agent server side is recorded as `'server'`
 *       (existing value), `'agent'`, or `'docservice'`. Tests only distinguish two categories.
 *   B3  Tool invocation event (section 7, D2): write tool events carry `opId` and `inverse` from
 *       that commit (as in the task brief: "events carry opId and inverse"). Look in order through
 *       completion event → creation event → content store `event-detail`, with field names `opId` /
 *       `inverse` (also recognizes `undo: { opId, inverse }`, and the last of `opIds`). The key
 *       for `event-detail` uses creation event's `detailKey`, or defaults to merged
 *       `<projectId>/<eventId>` if absent.
 *   B4  AI panel "Undo this step" (section 8 ruling: counted as a write from this user page
 *       session, with `undoOf` pointing to that Agent commit, pushed to user's own undo stack):
 *       `DocSync` instance method, candidate `undoForeign`, `undoStep`, `undoAgentStep`,
 *       `undoOp`, `revertOp`; or `docsync.ts` exports a same-named function `(ds, info)`.
 *       Parameters `{ opId, inverse, rev?, entities? }`, returning the same `UndoResult` as
 *       `undo()`.
 *   B5  Shortcuts (undo draft section 1: Ctrl+Z undo; Ctrl+Shift+Z and Ctrl+Y redo; when focus is
 *       in an input box, leave it to the input box): pure function, candidate modules
 *       `src/editor/undoKeys.ts`, `src/editor/shortcuts.ts`, `src/editor/keymap.ts`,
 *       `src/editor/undoShortcut.ts`; candidate exports `undoRedoKey`, `undoRedoAction`,
 *       `shortcutAction`, `matchUndoRedo`; argument is a KeyboardEvent-shaped object, returning
 *       `'undo' | 'redo' | null` (also recognizes `{ action }`).
 *   B6  Creator changing own password (section 9 ruling):
 *       `shared.admin { op: 'set-creator-password', creator: { salt, key }, proof }`, proof
 *       calculated using the **old** creator K according to auth-contract section 7; on success
 *       returns `shared.admin.ok`.
 *   B7  `.proc` written only after confirmation (section 4, V7 page side): `src/editor/io/proc.ts`
 *       exports a function that serializes after awaiting confirmation; candidate
 *       `serializeProcConfirmed`, `serializeProcWhenConfirmed`, `procWhenConfirmed`; returns
 *       `Promise<string>` (.proc text) or `Promise<{ text, rev }>`. When these exports are
 *       missing, fall back to recognizing an extra `whenSettled()` on `core.ts` sync hook, calling
 *       `serializeProc()` after awaiting it.
 *   B8  Undo bar copy (undo draft sections 2, 3 and copy tables 4-10): pure function, candidate
 *       modules `src/editor/undoNotice.ts`, `src/editor/undoFeedback.ts`,
 *       `src/store/undoNotice.ts`; candidate exports `undoNotice`, `describeUndo`,
 *       `undoFeedback`; argument `(result, { redo, nameOf(entity), whoOf(by) })`; returns `null`
 *       (nothing to display) or `{ title, lines: string[] }`, where `lines` are the lines
 *       displayed when folded.
 *
 * Integration reconciliation (c65-integ2, modifies only glue code, not assertions):
 *   B1  Actually `createAgentSide` in `server/agent/agent-side.mjs` (assembly shared by
 *       vite-plugin-ai and tests: connection + executor + dispatch by side). Different shape,
 *       wrapped into B1 form by `agentSideReplica`: handlers loaded via Vite's `ssrLoadModule`
 *       (same as AG-3; card registry cannot be loaded in bare Node), test-provided `loadModule`
 *       is unused; executor assigns chat numbers in process in order of chat id, and glue maps
 *       "assigned number → test chat number", providing connection URL based on test chat number
 *       (B9 query string).
 *   B4  Actually `DocSync.revertRemote({ opId, inverse?, rev?, by? })`, added to candidate names.
 *   B5  `undoRedoKey` in `src/editor/undoKeys.ts`; B7 `whenSettled()` on `core.ts` sync hook;
 *       B8 `undoNotice` in `src/editor/undoNotice.ts`: consistent with assumptions.
 *   B9  How write identity is provided in tests: query string `?user=&dev=&role=&conv=`, with
 *       principal `{ userId: '<user>@<dev>', deviceId: dev, role, conversation: Number(conv) }`
 *       (same as `docservice-events.test.mjs`). When page connection lacks role, defaults to
 *       `'page'`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wsClient, byType, sleep, waitFor } from './fake-ws-kit.mjs';
import { startStandalone, ask } from './fake-docservice-env.mjs';
import { projectModule } from '../docservice/modules/project.mjs';
import { contentModule } from '../docservice/modules/content.mjs';
import { eventsModule, eventDetailKey } from '../docservice/modules/events.mjs';
import { createMemoryStore } from '../docservice/store/index.mjs';
import { openProject, submit, newOpId, isOk, isRejected, clipOf } from './c65-kit.mjs';

export { sleep, waitFor, byType, ask, openProject, submit, newOpId, isOk, isRejected, clipOf };

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const T0 = 1_700_000_000_000;
export const PID = 'p-c65b';

// ================================================================== Utilities

/** Sequentially tries candidate modules and candidate export names; returns { mod, fn, name, file }, or null if none match (`tried` records attempts). */
async function probe(files, names, tried = []) {
  for (const f of files) {
    let mod;
    try {
      mod = await import(pathToFileURL(path.join(ROOT, f)).href);
    } catch (err) {
      tried.push(`${f}: ${String(err?.code ?? err?.message ?? err).slice(0, 120)}`);
      continue;
    }
    for (const n of names) if (typeof mod[n] === 'function') return { mod, fn: mod[n], name: n, file: f };
    tried.push(`${f}: no ${names.join(' / ')} (exports: ${Object.keys(mod).join(', ')})`);
  }
  return null;
}

let tsReady = null;
/** Installs `.ts` resolution hook (same as unit tests under src). */
export function registerTs() {
  tsReady ??= import(pathToFileURL(path.join(ROOT, 'src/testing/registerTs.mjs')).href);
  return tsReady;
}

/** File URL for `src/...`. */
export const srcHref = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

// ================================================================== Document service (B9)

/** B9 */
export function authC65b(req) {
  const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const user = q.get('user') ?? 'u';
  if (user === 'deny') return null;
  const dev = q.get('dev') ?? `dev-${user}`;
  const role = q.get('role') ?? 'page';
  const p = { userId: `${user}@${dev}`, tenantId: 't-c65b', scope: 'member', deviceId: dev, role };
  if (q.get('conv')) p.conversation = Number(q.get('conv'));
  return p;
}

/** The userId of write identity in actor. */
export const uid = (user, dev = `dev-${user}`) => `${user}@${dev}`;

/**
 * Starts a standalone document service mounting project, content store, and events modules
 * (same space, identical assembly to `docservice-events.test.mjs`).
 * who = { user, dev, role, conv }. `url(who, port?)` is compatible with `createPage` in
 * `c65-kit.mjs`.
 * → { port, url, connect, clock, store, cleanup }
 */
export async function startC65bService(t) {
  const store = createMemoryStore();
  const clock = { t: T0 };
  const now = () => clock.t;
  const project = projectModule({ store, now });
  const content = contentModule({ store, now });
  const events = eventsModule({ project, content, now });
  const env = await startStandalone({ modules: [project, content, events], now, authenticate: authC65b });
  const clients = [];
  const query = (who = {}) => {
    const q = new URLSearchParams();
    q.set('user', who.user ?? 'u');
    if (who.dev) q.set('dev', who.dev);
    if (who.role) q.set('role', who.role);
    if (who.conv !== undefined) q.set('conv', String(who.conv));
    return q.toString();
  };
  const url = (who, port = env.port) => `ws://127.0.0.1:${port}/?${query(who)}`;
  const connect = async (who) => {
    const c = wsClient(url(who));
    clients.push(c);
    await c.opened;
    return c;
  };
  const out = { ...env, url, connect, clock, store };
  t.after(async () => {
    for (const c of clients) c.close();
    await env.cleanup();
  });
  return out;
}

/** Writes seed project via root replacement; returns rev. */
export async function seed(env, project, projectId = PID) {
  const c = await env.connect({ user: 'seeder' });
  await openProject(c, projectId);
  const r = await submit(c, { projectId, ops: [{ op: 'set', path: '', value: project }], session: 'seed' });
  assert.ok(isOk(r), `seed write should succeed: ${JSON.stringify(r)}`);
  c.close();
  return r.rev;
}

/** Reads current { rev, project } from server. */
export async function stateOf(env, projectId = PID) {
  const c = await env.connect({ user: 'reader' });
  const st = await openProject(c, projectId);
  c.close();
  return { rev: st.rev, project: st.project };
}

/** Observer: a raw connection with page role; opens project, collects project.ops and events.event. */
export async function watcher(env, projectId = PID) {
  const c = await env.connect({ user: 'watch' });
  await openProject(c, projectId);
  return {
    c,
    ops: () => c.all.filter(byType('project.ops')),
    events: () => c.all.filter(byType('events.event')),
    close: () => c.close(),
  };
}

/** Small project matching `src/kernel/project.ts` shape: clips c1..c4 on track t1; modifying only labels avoids triggering card parameter validation. */
export function agentProject() {
  return {
    version: 1,
    id: 'p-c65b-project',
    name: 'Starting point',
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 30,
    themeId: 'midnight',
    media: [],
    tracks: [
      {
        id: 't1',
        name: 'Track 1',
        clips: [1, 2, 3, 4].map((i) => ({ id: `c${i}`, cardId: 'title', start: (i - 1) * 3, end: i * 3, params: {}, label: `Clip ${i}` })),
      },
      { id: 't2', name: 'Track 2', clips: [] },
    ],
  };
}

// ================================================================== Agent server (B1)

/**
 * B1. Starts an Agent server project replica connected to the env document service.
 *
 * Assumed factory shape:
 *   factory({
 *     projectId,
 *     url(conversation) → string       Address for this chat to connect to document service
 *                                      (local space trusted locally; tests supply identity via B9
 *                                      query string)
 *     loadModule(spec) → Promise<mod>  Replaces Vite's ssrLoadModule; spec is repo-relative path
 *                                      (optional leading /) or absolute path
 *     callPage(tool, args, ctx) → Promise<any>   Path delivering tools kept on page via SSE into
 *                                                page (section 5: "tools reading page-only state
 *                                                stay on page")
 *     now()
 *   }) → replica
 *   replica.open() → Promise            Connects, project.open, replica ready
 *   replica.callTool(name, args, { conversation }) → Promise<any>
 *                                        Same returns as MCP tools: returns result on success;
 *                                        throws on failure, or returns `{ isError: true, … }` /
 *                                        `{ ok: false, … }`, or MCP
 *                                        `{ content: [{ type: 'text', text }], isError }`
 *   replica.close()
 *
 * → { call(name, args, conversation?) → Promise<Norm>, pageCalls: [{ tool, args }], close() }
 *   Norm = { ok, value, text }: `value` is unwrapped result object; `text` is full text of result
 *   or error (used to locate entity and identity)
 */
export async function startAgent(env, { projectId = PID, conversation = 7, user = 'alice', dev = 'dev-a' } = {}) {
  await registerTs();
  const tried = [];
  const hit = await probe(
    ['server/agent-replica.mjs', 'server/agent/replica.mjs', 'server/agent-project.mjs', 'server/agent-docsync.mjs'],
    ['createAgentReplica', 'createAgentProject', 'createAgentSide'],
    tried,
  );
  const side = hit ? null : await probe(['server/agent/agent-side.mjs'], ['createAgentSide'], tried);
  assert.ok(hit || side, `B1: cannot find the project replica factory of the Agent server. Tried:\n  ${tried.join('\n  ')}`);
  const pageCalls = [];
  const loadModule = (spec) => {
    const file = path.isAbsolute(spec) && !spec.startsWith('/src') && !spec.startsWith('/server') ? spec : path.join(ROOT, spec.replace(/^\/+/, ''));
    return import(pathToFileURL(file).href);
  };
  const replica = await (hit ? hit.fn : (o) => agentSideReplica(side.fn, o, conversation))({
    projectId,
    url: (conv) => env.url({ user, dev, role: 'agent', conv: conv ?? conversation }),
    loadModule,
    callPage: async (tool, args) => {
      pageCalls.push({ tool, args });
      return { ok: true, fromPage: tool };
    },
    now: () => env.clock.t,
  });
  if (typeof replica.open === 'function') await replica.open();
  const call = async (name, args = {}, conv = conversation) => {
    try {
      return normalize(await replica.callTool(name, args, { conversation: conv }));
    } catch (err) {
      return { ok: false, value: err, text: `${err?.message ?? err} ${safeJson(err)}` };
    }
  };
  return { replica, call, pageCalls, close: () => replica.close?.() };
}

/**
 * Glue (c65-integ2): wraps `createAgentSide` into B1 shape.
 * - handlers loaded via Vite's ssrLoadModule (same as AG-3 in `agent-c65.test.mjs`);
 * - executor assigns chat numbers 1, 2, 3... in order of first appearance of chat id (string);
 *   tests supply write identity using their own chat numbers (7, 3, 5...), so register "chat id
 *   `conv-<test number>` → assigned number" first, and look up test number by assigned number for
 *   connection URL.
 */
async function agentSideReplica(createAgentSide, { projectId, url, callPage }, firstConversation) {
  const [{ createServer }, { loadSsrHost }, { tools, toolGroups }] = await Promise.all([
    import('vite'),
    import(pathToFileURL(path.join(ROOT, 'server/agent/ssr-host.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'server/mcp-tools.mjs')).href),
  ]);
  const vite = await createServer({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const testConvOf = new Map();
  const side = createAgentSide({
    projectId,
    url: (n) => url(testConvOf.get(n) ?? n),
    protocolsFor: () => ['promptcut.v1'],
    tools,
    toolGroups,
    loadHost: () => loadSsrHost((id) => vite.ssrLoadModule(id)),
    callPage: (tool, args) => callPage(tool, args),
  });
  const keyOf = (conv) => {
    const key = `conv-${conv}`;
    testConvOf.set(side.conversationNumber(key), conv);
    return key;
  };
  return {
    async open() {
      keyOf(firstConversation);
      await side.link.ready();
    },
    callTool(name, args, { conversation } = {}) {
      return side.callTool(name, args, { agent: keyOf(conversation ?? firstConversation) });
    },
    async close() {
      side.close();
      await vite.close();
    },
  };
}

const safeJson = (v) => {
  try { return JSON.stringify(v, (k, x) => (x instanceof Error ? { message: x.message, ...x } : x)); } catch { return String(v); }
};

/** Normalizes tool result into { ok, value, text }. */
export function normalize(raw) {
  let value = raw;
  let isError = false;
  if (raw && Array.isArray(raw.content)) {
    isError = raw.isError === true;
    const text = raw.content.filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
    try { value = JSON.parse(text); } catch { value = { text }; }
    if (raw.rev !== undefined && value && typeof value === 'object' && value.rev === undefined) value.rev = raw.rev;
  }
  if (value && typeof value === 'object' && (value.isError === true || value.ok === false || (value.error !== undefined && value.error !== null))) isError = true;
  return { ok: !isError, value, text: safeJson(value) };
}

/** Reads rev from tool response (section 5: "read tool responses include rev"); recognizes `rev` and also `projectRev`. */
export const revOf = (norm) => norm?.value?.rev ?? norm?.value?.projectRev;

// ================================================================== Tool table (B2)

export async function loadTools() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'server/mcp-tools.mjs')).href);
  assert.ok(Array.isArray(mod.tools), 'mcp-tools.mjs must export a tools array');
  return mod.tools;
}

/** B2: 'page' | 'agent' | undefined (unmarked or unrecognized). */
export function sideOf(tool) {
  const s = tool?.side;
  if (s === 'browser' || s === 'page') return 'page';
  if (s === 'server' || s === 'agent' || s === 'docservice') return 'agent';
  return undefined;
}

// ================================================================== Tool invocation events (B3)

/** Pair of events (creation + completion) received by observer for a tool; waits until both arrive. */
export async function eventPairOf(w, tool, { nth = 0, ms = 5000 } = {}) {
  let pair = null;
  await waitFor(() => {
    const evs = w.events();
    const creates = evs.filter((e) => e.phase === 'create' && e.tool === tool);
    const create = creates[nth];
    if (!create) return false;
    const complete = evs.find((e) => e.phase === 'complete' && e.eventId === create.eventId);
    if (!complete) return false;
    pair = { create, complete };
    return true;
  }, ms, `observer received event pair #${nth + 1} for tool ${tool} (create + complete); received so far: ${JSON.stringify(w.events()).slice(0, 600)}`);
  return pair;
}

/** Fetches full parameters by event (content store event-detail). */
export async function detailOf(c, create, projectId = PID) {
  const key = create.detailKey ?? eventDetailKey(projectId, create.eventId);
  const r = await ask(c, { type: 'content.get', kind: 'event-detail', key });
  return r?.missing ? undefined : r?.body;
}

/** B3: Extracts { opId, inverse, rev? } from event (and details). */
export function undoInfoOf({ create, complete, detail }) {
  for (const src of [complete, create, detail]) {
    if (!src || typeof src !== 'object') continue;
    const u = src.undo && typeof src.undo === 'object' ? src.undo : src;
    const opId = u.opId ?? (Array.isArray(u.opIds) ? u.opIds[u.opIds.length - 1] : undefined);
    if (opId !== undefined || u.inverse !== undefined) return { opId, inverse: u.inverse, rev: u.rev ?? src.rev };
  }
  return { opId: undefined, inverse: undefined };
}

// ================================================================== Page: AI panel "Undo this step" (B4)

/** B4 */
export async function undoAgentStep(ds, info) {
  await registerTs();
  const names = ['undoForeign', 'undoStep', 'undoAgentStep', 'undoOp', 'revertOp', 'revertRemote'];
  for (const n of names) if (typeof ds[n] === 'function') return ds[n](info);
  const mod = await import(srcHref('store/docsync.ts'));
  for (const n of names) if (typeof mod[n] === 'function') return mod[n](ds, info);
  assert.fail(`B4: DocSync has no "undo this step" method (tried ${names.join(' / ')}), and docsync.ts exports no function of that name either`);
}

// ================================================================== Shortcuts (B5)

export async function loadShortcut() {
  await registerTs();
  const tried = [];
  const hit = await probe(
    ['src/editor/undoKeys.ts', 'src/editor/shortcuts.ts', 'src/editor/keymap.ts', 'src/editor/undoShortcut.ts'],
    ['undoRedoKey', 'undoRedoAction', 'shortcutAction', 'matchUndoRedo'],
    tried,
  );
  assert.ok(hit, `B5: cannot find the pure function for the undo / redo keyboard shortcuts. Tried:\n  ${tried.join('\n  ')}`);
  return (ev) => {
    const r = hit.fn(ev);
    return r && typeof r === 'object' ? r.action ?? null : r ?? null;
  };
}

/** KeyboardEvent-shaped object. */
export function keyEvent(key, { ctrl = false, meta = false, shift = false, alt = false, target = { tagName: 'DIV', isContentEditable: false } } = {}) {
  return {
    key, code: `Key${key.toUpperCase()}`, ctrlKey: ctrl, metaKey: meta, shiftKey: shift, altKey: alt, target,
    preventDefault() {}, stopPropagation() {},
  };
}

// ================================================================== Creator password change (B6)

export const SET_CREATOR_PASSWORD = 'set-creator-password';
/** B6: Fields of `shared.admin`. */
export const creatorPasswordFields = (cred) => ({ creator: { salt: cred.salt, key: cred.key } });

// ================================================================== .proc (B7)

/** B7: Returns a `() => Promise<{ text, rev? }>`. */
export async function loadProcWhenConfirmed() {
  await registerTs();
  const proc = await import(srcHref('editor/io/proc.ts'));
  for (const n of ['serializeProcConfirmed', 'serializeProcWhenConfirmed', 'procWhenConfirmed']) {
    if (typeof proc[n] === 'function') {
      return async () => {
        const r = await proc[n]();
        return typeof r === 'string' ? { text: r } : { text: r.text, rev: r.rev };
      };
    }
  }
  const core = await import(srcHref('store/core.ts'));
  return async () => {
    const hooks = core.getProjectSync?.();
    assert.ok(hooks && typeof hooks.whenSettled === 'function', 'B7: proc.ts has no "serialize after confirmation" export, and the sync hooks in core.ts have no whenSettled() either');
    const r = await hooks.whenSettled();
    return { text: proc.serializeProc(), rev: r?.rev };
  };
}

// ================================================================== Undo bar (B8)

export async function loadUndoNotice() {
  await registerTs();
  const tried = [];
  const hit = await probe(
    ['src/editor/undoNotice.ts', 'src/editor/undoFeedback.ts', 'src/store/undoNotice.ts'],
    ['undoNotice', 'describeUndo', 'undoFeedback'],
    tried,
  );
  assert.ok(hit, `B8: cannot find the text function for the undo notice. Tried:\n  ${tried.join('\n  ')}`);
  return hit.fn;
}
