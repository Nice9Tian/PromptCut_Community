/**
 * 仅供测试，生产代码不得引用。
 *
 * C6.5 第二批（c65-agent、c65-editor）契约测试的公共件。依据只有：
 *   - `docs/plan/c65-design.md` 第 5、7、8、9、13 节与第 11 节 V3、V5、V7；
 *   - `docs/plan/c65-undo-draft.md`（撤销 / 重做的用户侧行为与文案）、`c65-ux-draft.md`（创建者操作）；
 *   - `docs/plan/auth-contract.md` 第 7 节、`docs/plan/cloud-task.md` 的 D1、D2、D4。
 * 测试方没看 `c65-agent`、`c65-editor` 的实现。已合入的接口（文档服务的 project / content / events 模块、
 * `src/store/docsync.ts` 的 `DocSync`、`c65-kit.mjs`、`auth-kit.mjs`）照现状用。
 *
 * 设计稿没写死的模块路径、函数名、字段名全部集中在本文件，集成时对账只改这里。
 * 每一处假设用「假设 B<n>」标出，报告 `docs/archive/agent-reports/AGENT-c65-tests2.md` 按同样的编号列出。
 * 对多个候选名做探测的地方，探测顺序就是测试方猜的可能性顺序，对不上时加一个候选名即可。
 *
 *   B1  Agent 服务端的项目副本（设计稿第 5 节）：一个可在 Node 下直接驱动的工厂，候选模块
 *       `server/agent-replica.mjs`、`server/agent/replica.mjs`、`server/agent-project.mjs`、`server/agent-docsync.mjs`，
 *       候选导出 `createAgentReplica`、`createAgentProject`、`createAgentSide`。形状见 `startAgent` 的注释。
 *       vite 的 `ssrLoadModule` 由测试注入 `loadModule(spec)` 代替（先装 `src/testing/registerTs.mjs` 的解析钩子）。
 *   B2  工具的执行位置：`server/mcp-tools.mjs` 的 `tools[].side`。页面侧记作 `'browser'`（现有值）或 `'page'`；
 *       Agent 服务端侧记作 `'server'`（现有值）、`'agent'` 或 `'docservice'`。测试只分两类。
 *   B3  工具调用事件（第 7 节，D2）：写工具的事件带它那次提交的 `opId` 与 `inverse`（任务书写的「事件带 opId 与 inverse」）。
 *       按顺序在 完成事件 → 创建事件 → 内容库 `event-detail` 里找，字段名 `opId` / `inverse`（另认 `undo: { opId, inverse }`、
 *       `opIds` 取最后一个）。`event-detail` 的键取创建事件的 `detailKey`，没有就按已合入的 `<projectId>/<eventId>`。
 *   B4  AI 栏「撤销这一步」（第 8 节裁定：算用户这个页面会话的写入，`undoOf` 指向 Agent 那次提交，进用户自己的撤销栈）：
 *       `DocSync` 实例方法，候选 `undoForeign`、`undoStep`、`undoAgentStep`、`undoOp`、`revertOp`；
 *       或 `docsync.ts` 导出同名函数 `(ds, info)`。参数 `{ opId, inverse, rev?, entities? }`，返回与 `undo()` 相同的 `UndoResult`。
 *   B5  快捷键（undo 稿第 1 节：Ctrl+Z 撤销；Ctrl+Shift+Z 与 Ctrl+Y 重做；焦点在输入框里交给输入框）：
 *       纯函数，候选模块 `src/editor/undoKeys.ts`、`src/editor/shortcuts.ts`、`src/editor/keymap.ts`、`src/editor/undoShortcut.ts`，
 *       候选导出 `undoRedoKey`、`undoRedoAction`、`shortcutAction`、`matchUndoRedo`；入参是 KeyboardEvent 形状的对象，
 *       回 `'undo' | 'redo' | null`（也认 `{ action }`）。
 *   B6  创建者改自己的密码（第 9 节裁定）：`shared.admin { op: 'set-creator-password', creator: { salt, key }, proof }`，
 *       证明按 auth-contract 第 7 节用**旧的**创建者 K 算；成功回 `shared.admin.ok`。
 *   B7  `.proc` 只在确认之后写（第 4 节、V7 页面侧）：`src/editor/io/proc.ts` 导出等确认后再序列化的函数，候选
 *       `serializeProcConfirmed`、`serializeProcWhenConfirmed`、`procWhenConfirmed`，返回 `Promise<string>`（.proc 文本）
 *       或 `Promise<{ text, rev }>`；没有这些导出时，退而认 `core.ts` 的同步挂钩多一个 `whenSettled()`，等它之后调 `serializeProc()`。
 *   B8  撤销提示条的文案（undo 稿第 2、3 节与文案表 4～10）：纯函数，候选模块 `src/editor/undoNotice.ts`、
 *       `src/editor/undoFeedback.ts`、`src/store/undoNotice.ts`，候选导出 `undoNotice`、`describeUndo`、`undoFeedback`；
 *       入参 `(result, { redo, nameOf(entity), whoOf(by) })`，回 `null`（没有要提示的）或 `{ title, lines: string[] }`，
 *       `lines` 是折叠后显示的行。
 *
 * 集成对账（c65-integ2，只改胶水、不改断言）：
 *   B1  实际是 `server/agent/agent-side.mjs` 的 `createAgentSide`（vite-plugin-ai 与测试共用的组装：连接 + 执行器 + 按 side 分派）。
 *       形状不同，由 `agentSideReplica` 包成 B1 的样子：handler 用 vite 的 `ssrLoadModule` 载入（与 AG-3 相同；卡片注册表在裸 Node
 *       下载不进来），测试给的 `loadModule` 不用；执行器按对话 id 在本进程内发对话号，胶水把「发出的号 → 测试的对话号」对上，
 *       连接地址按测试的对话号给（B9 的查询串）。
 *   B4  实际是 `DocSync.revertRemote({ opId, inverse?, rev?, by? })`，加进候选名。
 *   B5  `src/editor/undoKeys.ts` 的 `undoRedoKey`；B7 `core.ts` 同步挂钩的 `whenSettled()`；B8 `src/editor/undoNotice.ts` 的 `undoNotice`：与假设一致。
 *   B9  写入身份在测试里的给法：查询串 `?user=&dev=&role=&conv=`，principal 为
 *       `{ userId: '<user>@<dev>', deviceId: dev, role, conversation: Number(conv) }`（与 `docservice-events.test.mjs` 相同）。
 *       页面连接不带 role 时按 `'page'`。
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

// ================================================================== 小工具

/** 依次试候选模块与候选导出名，回 { mod, fn, name, file }；都没有就回 null（`tried` 里记下试过什么） */
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
    tried.push(`${f}: 没有 ${names.join(' / ')}（导出：${Object.keys(mod).join(', ')}）`);
  }
  return null;
}

let tsReady = null;
/** 装 `.ts` 的解析钩子（src 下单测同款） */
export function registerTs() {
  tsReady ??= import(pathToFileURL(path.join(ROOT, 'src/testing/registerTs.mjs')).href);
  return tsReady;
}

/** `src/...` 的 file URL */
export const srcHref = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

// ================================================================== 文档服务（B9）

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

/** 写入身份在 actor 里的 userId */
export const uid = (user, dev = `dev-${user}`) => `${user}@${dev}`;

/**
 * 起一个挂着项目、内容库、事件三个模块的独立文档服务（同一空间，与 `docservice-events.test.mjs` 的组装相同）。
 * who = { user, dev, role, conv }。`url(who, port?)` 与 `c65-kit.mjs` 的 `createPage` 兼容。
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

/** 用根替换写入种子项目；回 rev */
export async function seed(env, project, projectId = PID) {
  const c = await env.connect({ user: 'seeder' });
  await openProject(c, projectId);
  const r = await submit(c, { projectId, ops: [{ op: 'set', path: '', value: project }], session: 'seed' });
  assert.ok(isOk(r), `种子写入应成功：${JSON.stringify(r)}`);
  c.close();
  return r.rev;
}

/** 读服务端当前的 { rev, project } */
export async function stateOf(env, projectId = PID) {
  const c = await env.connect({ user: 'reader' });
  const st = await openProject(c, projectId);
  c.close();
  return { rev: st.rev, project: st.project };
}

/** 观察者：一条页面角色的原始连接，打开项目，收集 project.ops 与 events.event */
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

/** 一个合乎 `src/kernel/project.ts` 形状的小项目：序列 t1 上片段 c1..c4，只改 label 就不触发卡片参数校验 */
export function agentProject() {
  return {
    version: 1,
    id: 'p-c65b-project',
    name: '起点',
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 30,
    themeId: 'midnight',
    media: [],
    tracks: [
      {
        id: 't1',
        name: '序列 1',
        clips: [1, 2, 3, 4].map((i) => ({ id: `c${i}`, cardId: 'title', start: (i - 1) * 3, end: i * 3, params: {}, label: `片段${i}` })),
      },
      { id: 't2', name: '序列 2', clips: [] },
    ],
  };
}

// ================================================================== Agent 服务端（B1）

/**
 * B1。起一份 Agent 服务端的项目副本，连到 env 的文档服务。
 *
 * 假设的工厂形状：
 *   factory({
 *     projectId,
 *     url(conversation) → string       这个对话接入文档服务的地址（本机 local 空间由本机信任；测试按 B9 的查询串给身份）
 *     loadModule(spec) → Promise<mod>  代替 vite 的 ssrLoadModule；spec 是仓库相对路径（可带开头的 /）或绝对路径
 *     callPage(tool, args, ctx) → Promise<any>   留在页面的工具经 SSE 送进页面的那条路（第 5 节「只读页面独有状态的工具留在页面」）
 *     now()
 *   }) → replica
 *   replica.open() → Promise            连上、project.open，副本就绪
 *   replica.callTool(name, args, { conversation }) → Promise<any>
 *                                        与 MCP 工具返回相同：成功回结果；失败 throw，或回 `{ isError: true, … }` / `{ ok: false, … }`，
 *                                        或 MCP 的 `{ content: [{ type: 'text', text }], isError }`
 *   replica.close()
 *
 * → { call(name, args, conversation?) → Promise<Norm>, pageCalls: [{ tool, args }], close() }
 *   Norm = { ok, value, text }：`value` 是解开后的结果对象，`text` 是结果或错误的全文（找实体、身份用）
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
  assert.ok(hit || side, `B1：找不到 Agent 服务端的项目副本工厂。试过：\n  ${tried.join('\n  ')}`);
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
 * 胶水（c65-integ2）：把 `createAgentSide` 包成 B1 的形状。
 * - handler 经 vite 的 ssrLoadModule 载入（同 `agent-c65.test.mjs` 的 AG-3）；
 * - 执行器按对话 id（字符串）首次出现的顺序发对话号 1、2、3……；测试按自己的对话号（7、3、5……）给写入身份，
 *   所以先登记「对话 id `conv-<测试的号>` → 发出的号」，连接地址按发出的号反查测试的号。
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

/** 把工具结果规整成 { ok, value, text } */
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

/** 读工具回包里的 rev（第 5 节「读工具回包里带 rev」）；认 `rev`，另认 `projectRev` */
export const revOf = (norm) => norm?.value?.rev ?? norm?.value?.projectRev;

// ================================================================== 工具表（B2）

export async function loadTools() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'server/mcp-tools.mjs')).href);
  assert.ok(Array.isArray(mod.tools), 'mcp-tools.mjs 要导出 tools 数组');
  return mod.tools;
}

/** B2：'page' | 'agent' | undefined（没标或不认识） */
export function sideOf(tool) {
  const s = tool?.side;
  if (s === 'browser' || s === 'page') return 'page';
  if (s === 'server' || s === 'agent' || s === 'docservice') return 'agent';
  return undefined;
}

// ================================================================== 工具调用事件（B3）

/** 观察者收到的某个工具的一对事件（创建 + 完成）；等到齐为止 */
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
  }, ms, `观察者收到工具 ${tool} 的第 ${nth + 1} 对事件（创建 + 完成）；已收到：${JSON.stringify(w.events()).slice(0, 600)}`);
  return pair;
}

/** 按事件拉完整参数（内容库 event-detail） */
export async function detailOf(c, create, projectId = PID) {
  const key = create.detailKey ?? eventDetailKey(projectId, create.eventId);
  const r = await ask(c, { type: 'content.get', kind: 'event-detail', key });
  return r?.missing ? undefined : r?.body;
}

/** B3：从事件（与详情）里取 { opId, inverse, rev? } */
export function undoInfoOf({ create, complete, detail }) {
  for (const src of [complete, create, detail]) {
    if (!src || typeof src !== 'object') continue;
    const u = src.undo && typeof src.undo === 'object' ? src.undo : src;
    const opId = u.opId ?? (Array.isArray(u.opIds) ? u.opIds[u.opIds.length - 1] : undefined);
    if (opId !== undefined || u.inverse !== undefined) return { opId, inverse: u.inverse, rev: u.rev ?? src.rev };
  }
  return { opId: undefined, inverse: undefined };
}

// ================================================================== 页面：AI 栏「撤销这一步」（B4）

/** B4 */
export async function undoAgentStep(ds, info) {
  await registerTs();
  const names = ['undoForeign', 'undoStep', 'undoAgentStep', 'undoOp', 'revertOp', 'revertRemote'];
  for (const n of names) if (typeof ds[n] === 'function') return ds[n](info);
  const mod = await import(srcHref('store/docsync.ts'));
  for (const n of names) if (typeof mod[n] === 'function') return mod[n](ds, info);
  assert.fail(`B4：DocSync 上没有「撤销这一步」的方法（试过 ${names.join(' / ')}），docsync.ts 也没导出同名函数`);
}

// ================================================================== 快捷键（B5）

export async function loadShortcut() {
  await registerTs();
  const tried = [];
  const hit = await probe(
    ['src/editor/undoKeys.ts', 'src/editor/shortcuts.ts', 'src/editor/keymap.ts', 'src/editor/undoShortcut.ts'],
    ['undoRedoKey', 'undoRedoAction', 'shortcutAction', 'matchUndoRedo'],
    tried,
  );
  assert.ok(hit, `B5：找不到撤销 / 重做快捷键的纯函数。试过：\n  ${tried.join('\n  ')}`);
  return (ev) => {
    const r = hit.fn(ev);
    return r && typeof r === 'object' ? r.action ?? null : r ?? null;
  };
}

/** KeyboardEvent 形状的对象 */
export function keyEvent(key, { ctrl = false, meta = false, shift = false, alt = false, target = { tagName: 'DIV', isContentEditable: false } } = {}) {
  return {
    key, code: `Key${key.toUpperCase()}`, ctrlKey: ctrl, metaKey: meta, shiftKey: shift, altKey: alt, target,
    preventDefault() {}, stopPropagation() {},
  };
}

// ================================================================== 创建者改密码（B6）

export const SET_CREATOR_PASSWORD = 'set-creator-password';
/** B6：`shared.admin` 的字段 */
export const creatorPasswordFields = (cred) => ({ creator: { salt: cred.salt, key: cred.key } });

// ================================================================== .proc（B7）

/** B7：回一个 `() => Promise<{ text, rev? }>` */
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
    assert.ok(hooks && typeof hooks.whenSettled === 'function', 'B7：proc.ts 没有「等确认后序列化」的导出，core.ts 的同步挂钩也没有 whenSettled()');
    const r = await hooks.whenSettled();
    return { text: proc.serializeProc(), rev: r?.rev };
  };
}

// ================================================================== 撤销提示条（B8）

export async function loadUndoNotice() {
  await registerTs();
  const tried = [];
  const hit = await probe(
    ['src/editor/undoNotice.ts', 'src/editor/undoFeedback.ts', 'src/store/undoNotice.ts'],
    ['undoNotice', 'describeUndo', 'undoFeedback'],
    tried,
  );
  assert.ok(hit, `B8：找不到撤销提示条的文案函数。试过：\n  ${tried.join('\n  ')}`);
  return hit.fn;
}
