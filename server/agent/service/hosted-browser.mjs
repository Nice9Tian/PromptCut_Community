/**
 * 云端 Agent 的网页操作工具(`web_open`、`web_view`、`web_click`、`web_type`、`web_scroll`、`web_read`、`web_close`;
 * 计划 `docs/plan/cloud-agent-tools-implementation.md` 的 W1 包)。工具名、参数与返回的形状同桌面版(`server/tools/browser.mjs`)。
 *
 * 桌面版里这七个工具由页面转给编辑器进程的 `/api/web/*`,整个进程共用一个有头的浏览器和一份登录态。
 * 云节点上是很多人的很多对话,所以在 Agent 服务一侧另做一份:
 *
 *   - **每次调用都带可信的 ToolRunContext**(`tool-context.mjs`,由文档服务确认读过消息后的当前运行授权构造),
 *     动手之前先过 `authorize(read)`,把结果交回去之前再过一次;这一轮被收回(对话设为私有、被停止、Agent 被关)或已经换了新一轮,
 *     旧的调用过不了这两道,页面动不了,结果也拿不走。网页操作不改项目,所以只读成员也能用〔裁〕。
 *   - **每个「项目 × 对话」一个浏览器进程、一份用户数据目录、一个出网代理**(`server/web/hosted/session.mjs`):
 *     两个对话打开同一个站,互相看不到对方的 cookie 与登录态。键只取自可信的运行上下文,工具参数里没有项目、对话、路径。
 *   - **浏览器进程挂到运行资源登记器**(`run-resources.mjs`):这一轮被收回时登记器杀掉整棵进程树;本模块等到进程号真的查不到才算关掉。
 *   - **出网只经出网闸**(`egress.mjs`;代理与各条绕过途径怎么堵见 `server/web/hosted/network.mjs`)。
 *   - **清单带版本**:旧清单的编号、页面变了以后的编号一律拒,不会点到别的元素上(`server/web/hosted/view.mjs`、`hit.mjs`)。
 *   - **不代填口令、验证码、卡号**:桌面版靠工具说明约束模型;云端没人在旁边,`web_type` 遇到这类输入框直接拒〔裁〕。
 *   - **没配浏览器就如实说**:节点配置里没有浏览器的可执行文件时,回「这台节点没有配置浏览器」,不下载、不假装能用。
 *
 * 用户数据目录的去留〔裁〕:
 *
 *   | 什么时候                                   | 浏览器进程 | 用户数据目录 |
 *   |--------------------------------------------|------------|--------------|
 *   | `web_close`、闲置超时、为腾名额被换下      | 退出       | 留着(工具说明里写的「登录态还在」) |
 *   | 这一轮被停止、Agent 被关(登记器收回)     | 退出       | 留着(对话还在,下一轮接着用) |
 *   | 对话被设为私有(宿主调 `closeConversation(…, { reason: 'private' })`) | 退出 | **删掉**(换了一批能看这个对话的人,之前攒下的状态不带过去);只留清单版本的计数 |
 *   | 对话被删、项目被删(宿主调 `closeConversation` / `removeProject`)   | 退出 | 删掉 |
 *   | 服务关闭(`close()`)                      | 退出       | 留着;重启后旧浏览器不会复活,打开过的页面与旧清单的编号都作废 |
 *   | 用户数据目录超过上限                       | —          | 关闭时整个删掉 |
 *
 * 本文件不引用 `src/`。中央的工具表、实例与接线不在这里(归最后的接线包)。
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { admitWebTarget } from '../../web/hosted/network.mjs';
import { launchHostedSession, HostedSessionError, reapOrphan, removeDirFully, removeSessionData, pidAlive, HOSTED_BROWSER_ARG_PREFIX } from '../../web/hosted/session.mjs';

export const WEB_TOOL_NAMES = Object.freeze(['web_open', 'web_view', 'web_click', 'web_type', 'web_scroll', 'web_read', 'web_close']);

/** 数字都是三级机制的缺省值〔裁〕,部署者可以在节点配置里改 */
export const HOSTED_BROWSER_DEFAULTS = Object.freeze({
  /** 整个 Agent 服务进程里同时开着的浏览器数 */
  maxBrowsers: 2,
  /** 名额满了时,闲了这么久的浏览器可以被换下(关掉,目录留着) */
  evictIdleMs: 60_000,
  /** 一个浏览器闲置多久自动关(目录留着) */
  idleCloseMs: 10 * 60_000,
  /** 一个页面最多等多久加载出来 */
  navigationMs: 30_000,
  /** 一次工具调用(含加载、动作、截图)的总时限;要小于宿主给工具的 60 秒 */
  actionMs: 50_000,
  /** 点击、回车之后页面开始跳转的,最多等它落地多久 */
  settleMs: 10_000,
  /** 起浏览器的时限 */
  launchMs: 30_000,
  /** 关浏览器时先让它自己退的时限(把 cookie 落盘) */
  gracefulCloseMs: 3_000,
  /** 等进程树真的退出、等目录真的删掉的时限 */
  closeMs: 10_000,
  /** 一次最多输入多少字、每个字之间隔多久 */
  maxTypeChars: 2_000,
  typeDelayMs: 5,
  /** 打字分小段,每段之前核一次焦点还在那个输入框上。缺省一个字一段:页面中途把焦点挪走时,最多有一个字进了别处 */
  typeChunkChars: 1,
  /** `web_read` 一次最多给多少字 */
  maxReadChars: 20_000,
  /** 一次最多滚多少页面像素 */
  maxScrollPx: 20_000,
  /** 一个浏览器同时开着的出网隧道数 */
  maxTunnels: 64,
  /** 浏览器的磁盘缓存上限 */
  diskCacheBytes: 64 * 1024 * 1024,
  /** 一个对话的用户数据目录上限,超了在关闭时整个删掉 */
  maxProfileBytes: 512 * 1024 * 1024,
});

export class HostedBrowserError extends Error {
  constructor(message, { code = 'web-error', status = 400 } = {}) {
    super(message);
    this.name = 'HostedBrowserError';
    this.code = code;
    this.status = status;
  }
}

const CONTEXT_KEYS = ['projectId', 'conversationId', 'runId', 'runGrantId', 'instanceId', 'instanceGeneration', 'senderAccountId', 'messageId'];
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
const unavailable = (code, error, extra = {}) => ({ ok: false, cloudUnavailable: true, code, error, ...extra });

const NO_BROWSER = '这台节点没有配置浏览器,云端 Agent 做不了网页操作。请告诉用户联系托管方,或在电脑上的 PromptCut 里做这一步。';
const NOT_OPEN = '云端的浏览器现在没有开着(还没打开过网页,或者它已经被关掉:闲置太久、这一轮被停止、服务重启过)。先用 web_open 打开一条链接;之前清单里的编号都作废了。';

/** id 当目录名:去掉不能进路径的字符,再接一段原文的哈希(两个不同的 id 清洗后撞名也分得开) */
function dirName(id) {
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 48);
  return `${safe}-${createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`;
}

/** 浏览器目录的根:`<数据目录>/web/` */
export const hostedBrowserRoot = (dataDir) => path.join(path.resolve(dataDir), 'web');

/** 一个「项目 × 对话」的浏览器目录:`<数据目录>/web/<项目>/<对话>/`(用户数据目录是它下面的 `profile/`) */
export function hostedBrowserDir(dataDir, { projectId, conversationId }) {
  if (typeof projectId !== 'string' || !ID_RE.test(projectId) || typeof conversationId !== 'string' || !ID_RE.test(conversationId)) {
    throw new HostedBrowserError('项目或对话的 id 不合法。', { code: 'bad-scope', status: 400 });
  }
  return path.join(hostedBrowserRoot(dataDir), dirName(projectId), dirName(conversationId));
}

/** 按原因定用户数据目录留不留(见文件头的表) */
function removeProfileFor(reason) {
  return reason === 'private' || reason === 'conversation-deleted' || reason === 'project-deleted';
}
/** 对话、项目没了:连清单版本的计数一起删。只是设为私有:计数留着(模型手里还有旧清单,新浏览器的版本号不能和它撞) */
const removeAllFor = (reason) => reason === 'conversation-deleted' || reason === 'project-deleted';

/**
 * @param {object} d
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<{ fenceRevision: number, grantState: string }>, register(context: object, o: { kind: string, resource: object }): Promise<{ signal: AbortSignal, closed: Promise<void> }> }} d.resources
 *   运行资源登记器(`createRunResources`)
 * @param {{ admit: Function, admitUrl: Function }} d.egress 出网闸(`createEgressGate`)
 * @param {string} d.dataDir Agent 服务的数据目录;浏览器目录在它下面的 `web/`
 * @param {object} [d.runtime] 部署者提供的节点配置(不是模型给的)
 * @param {string} [d.runtime.executablePath] 浏览器可执行文件的绝对路径;没有就是「没配浏览器」
 * @param {'new'|'shell'} [d.runtime.headless] 无头的哪一种;缺省按文件名判
 * @param {string[]} [d.runtime.extraArgs] 追加的启动参数(Linux 上的沙箱参数等);改代理、开调试口的会被丢掉
 * @param {string[]} [d.runtime.argPrefix] 启动参数打头的那几个
 * @param {object} [d.limits] 覆盖 `HOSTED_BROWSER_DEFAULTS`
 * @param {(event: string, fields?: object) => void} [d.log]
 * @param {typeof launchHostedSession} [d.launchSession] 起会话的函数,只给单测换
 */
export function createHostedBrowserTools({ resources, egress, dataDir, runtime = {}, limits = {}, log = () => {}, puppeteer, now = Date.now, launchSession = launchHostedSession } = {}) {
  if (typeof resources?.authorize !== 'function' || typeof resources?.register !== 'function'
    || typeof egress?.admit !== 'function' || typeof egress?.admitUrl !== 'function'
    || typeof dataDir !== 'string' || !dataDir) {
    throw new HostedBrowserError('云端网页操作没有配置全(缺运行资源登记器、出网闸或数据目录)。', { code: 'web-unconfigured', status: 503 });
  }
  const cfg = { ...HOSTED_BROWSER_DEFAULTS, ...limits };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };
  const root = hostedBrowserRoot(dataDir);
  const handles = new Set(WEB_TOOL_NAMES);
  /** 「项目\0对话」→ 会话记录 `{ key, projectId, conversationId, dir, session, bound: Map<contextKey, registration>, timer }` */
  const sessions = new Map();
  /** 正在起的:同一个对话并发的两次 web_open 共用一次启动 */
  const launching = new Map();
  /** 正在关的(含登记器触发的):`close()` 要等它们 */
  const closings = new Set();
  /** 「项目×对话」→ 这个对话最近一次关闭(含删目录)的 promise。同一个对话的下一次启动、`closeConversation` 都先等它 */
  const closingByKey = new Map();
  /** 关过的会话(已从 `sessions` 摘掉):还在关的、关了却没拿到退出凭据的留在这里,`treeClosed` 与 `closeConversation` 据此回话 */
  const retired = new Set();
  let closing = false;
  let closePromise = null;

  function noteKeyClosing(key, promise) {
    closingByKey.set(key, promise);
    const done = () => { if (closingByKey.get(key) === promise) closingByKey.delete(key); };
    promise.then(done, done);
    return promise;
  }

  /** 一个关过的会话此刻是不是确实没有活着的进程了(关闭当时没核到的,这里重核) */
  function settled(entry) {
    if (entry.lastClose?.exited === true) return true;
    if (!entry.lastClose) return false;
    const left = entry.session.leftovers?.();
    if (left && left.exited && left.alivePids.length === 0 && left.groupLive !== true) { entry.lastClose = { ...entry.lastClose, exited: true, alivePids: [] }; return true; }
    return false;
  }

  const keyOf = (scope) => `${scope.projectId}\0${scope.conversationId}`;
  const contextKey = (context) => JSON.stringify(CONTEXT_KEYS.map((k) => context?.[k]));

  const browserReady = () => {
    if (typeof runtime.executablePath !== 'string' || !runtime.executablePath) return false;
    try { return fs.statSync(runtime.executablePath).isFile(); } catch { return false; }
  };

  /* ------------------------------------------------------------------ 启动时清孤儿 */

  /** 上一个服务进程留下的浏览器(正常没有:管道一断浏览器自己退)。逐个目录看,还占着的杀掉 */
  const swept = (async () => {
    let reaped = 0;
    try {
      for (const project of fs.readdirSync(root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        for (const conversation of fs.readdirSync(path.join(root, project.name), { withFileTypes: true })) {
          if (!conversation.isDirectory()) continue;
          // 起它的服务进程还活着的不动:滚动重启时旧进程可能还在用它(见 reapOrphan)
          const result = await reapOrphan(path.join(root, project.name, conversation.name), { timeoutMs: cfg.closeMs, respectLiveOwner: true });
          if (result.found) reaped += 1;
        }
      }
    } catch { /* 目录还没有:没有孤儿 */ }
    if (reaped) say('agent.web.orphans-swept', { count: reaped });
    return reaped;
  })();

  /* ------------------------------------------------------------------ 会话的生死 */

  /** 关了但进程号还查得到的次数:有一次,`close()` 就不能说「子进程都关了」 */
  let leaked = 0;
  function track(promise) {
    closings.add(promise);
    promise.then((result) => { if (!result?.exited) leaked += 1; closings.delete(promise); }, () => { leaked += 1; closings.delete(promise); });
    return promise;
  }

  /** 关一个会话并等到有结果。从表里先摘掉:之后的调用看到的是「没开着」 */
  function retire(entry, { reason, graceful = true, removeProfile = removeProfileFor(reason), removeAll = removeProfile && removeAllFor(reason) } = {}) {
    if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    entry.retired ??= reason;
    retired.add(entry);
    const closed = track(entry.session.close({ graceful, removeProfile, removeAll, reason }));
    entry.closed = closed;
    closed.then((result) => {
      entry.lastClose = result ?? { exited: false };
      // 拿到退出凭据的不用再记;没拿到的留着,直到重核通过
      if (entry.closed === closed && settled(entry)) retired.delete(entry);
    }, () => { entry.lastClose = { exited: false, alivePids: [] }; });
    noteKeyClosing(entry.key, closed);
    return closed;
  }

  function touch(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    if (!(cfg.idleCloseMs > 0) || entry.retired) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (sessions.get(entry.key) !== entry) return;
      if (entry.session.busy) { touch(entry); return; }
      void retire(entry, { reason: 'idle' }).catch(() => {});
    }, cfg.idleCloseMs);
    entry.timer.unref?.();
  }

  /** 腾一个名额:换下闲得最久、而且闲够了的那个;腾不出来回 false */
  async function makeRoom() {
    // 调用方自己已经记在 launching 里了,所以是「不超过」
    if (sessions.size + launching.size <= cfg.maxBrowsers) return true;
    const idle = [...sessions.values()]
      .filter((e) => !e.session.busy && now() - e.session.lastUsedAt >= cfg.evictIdleMs)
      .sort((a, b) => a.session.lastUsedAt - b.session.lastUsedAt)[0];
    if (!idle) return false;
    await retire(idle, { reason: 'evicted' });
    return sessions.size + launching.size <= cfg.maxBrowsers;
  }

  async function launch(scope) {
    const key = keyOf(scope);
    const existing = launching.get(key);
    if (existing) return existing;
    const task = (async () => {
      await swept;
      // 这个对话上一个浏览器还在关(含设私有时删目录):等它完。不等的话新浏览器会先读到正在被删的旧 cookie
      while (closingByKey.has(key)) { try { await closingByKey.get(key); } catch { /* 关闭自己会记结果 */ } }
      if (!await makeRoom()) {
        throw new HostedBrowserError('云端同时开着的浏览器已经到上限,这次没有打开。稍后再试;别的对话里用完了浏览器请 web_close。', { code: 'web-busy', status: 429 });
      }
      const dir = hostedBrowserDir(dataDir, scope);
      const session = await launchSession({
        sessionDir: dir,
        executablePath: runtime.executablePath,
        headless: runtime.headless,
        gate: egress,
        limits: cfg,
        argPrefix: Array.isArray(runtime.argPrefix) ? runtime.argPrefix : HOSTED_BROWSER_ARG_PREFIX,
        extraArgs: runtime.extraArgs,
        puppeteer,
        log,
        now,
      });
      const entry = { key, projectId: scope.projectId, conversationId: scope.conversationId, dir, session, bound: new Map(), contexts: new Set(), pendingHandles: new Set(), timer: null, retired: null, closed: null, lastClose: null };
      if (closing) { await track(session.close({ graceful: false, reason: 'host-close' })); throw new HostedBrowserError('云端网页操作正在关闭。', { code: 'web-closed', status: 503 }); }
      sessions.set(key, entry);
      // 浏览器自己没了(崩溃、被系统杀):从表里摘掉并核一遍进程
      session.processGone().then(() => {
        // 进程真的没了:告诉登记器(它等的是 exit 与 close 两个事件),并把挂着的东西都摘掉
        for (const ck of [...entry.bound.keys()]) release(entry, ck);
        for (const handle of entry.pendingHandles) { handle.emit('exit'); handle.emit('close'); }
        if (sessions.get(key) === entry) void retire(entry, { reason: 'exited', graceful: false }).catch(() => {});
      });
      return entry;
    })();
    launching.set(key, task);
    try { return await task; } finally { launching.delete(key); }
  }

  /** 把一个运行上下文从这个浏览器上摘下来:登记器那边当它已经关了(发 exit 与 close),本模块不再听那一轮的信号 */
  function release(entry, ck) {
    const bound = entry.bound.get(ck);
    if (!bound) return;
    entry.bound.delete(ck);
    bound.registration.signal.removeEventListener('abort', bound.onAbort);
    bound.handle.emit('exit');
    bound.handle.emit('close');
    bound.handle.removeAllListeners();
  }

  /**
   * 把浏览器挂到这一轮的运行资源上。登记器在这一轮被收回时调 `kill()`(杀整棵树)并打信号;这里听到信号就把会话收掉、等进程真的退出。
   *
   * 交给登记器的不是浏览器进程本身,而是每一轮一个的小把手:一个对话的浏览器跨很多轮,每一轮都往进程对象上挂监听的话只增不减。
   * 同一个对话同一时刻只有一轮是当前的(换了新一轮,旧一轮的上下文过不了授权),所以新一轮挂上时把旧的摘掉。
   */
  async function bind(entry, context) {
    const ck = contextKey(context);
    const had = entry.bound.get(ck);
    if (had) return had.registration;
    const handle = new EventEmitter();
    handle.kill = () => entry.session.kill();
    // 登记被拒时(这一轮已经被收回)登记器会调 kill() 并一直等到 exit 与 close:所以把手要先记下,进程一没就能通知到它
    entry.pendingHandles.add(handle);
    let registration;
    try { registration = await resources.register(context, { kind: 'child', resource: handle }); }
    catch (error) {
      // 登记器已经把浏览器杀了:把这个会话收掉
      void retire(entry, { reason: 'fence', graceful: false, removeProfile: false }).catch(() => {});
      throw error;
    }
    finally { entry.pendingHandles.delete(handle); }
    const onAbort = () => { void retire(entry, { reason: 'fence', graceful: false, removeProfile: false }).catch(() => {}); };
    for (const other of [...entry.bound.keys()]) release(entry, other);
    entry.bound.set(ck, { registration, handle, onAbort });
    entry.contexts.add(ck);
    if (entry.session.processExited) release(entry, ck);
    if (registration.signal.aborted) onAbort();
    else registration.signal.addEventListener('abort', onAbort, { once: true });
    return registration;
  }

  /* ------------------------------------------------------------------ 工具 */

  const failure = (error) => {
    if (error instanceof HostedBrowserError) return error;
    if (error instanceof HostedSessionError) {
      if (error.code === 'browser-missing') return null;
      const status = error.code === 'timeout' ? 504 : 503;
      return new HostedBrowserError(error.message, { code: `web-${error.code}`, status });
    }
    return error;
  };

  async function call(name, args, context) {
    if (!handles.has(name)) throw new HostedBrowserError(`网页操作不处理 ${name}。`, { code: 'unknown-tool', status: 404 });
    if (closing) throw new HostedBrowserError('云端网页操作正在关闭。', { code: 'web-closed', status: 503 });
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      throw new HostedBrowserError('参数必须是一个对象。', { code: 'bad-args' });
    }
    const input = args ?? {};
    // 第一道:这一轮此刻还算不算数。伪造的、改过的、别的进程发的上下文在这里就抛了,浏览器碰都不碰
    const before = await resources.authorize(context, 'read');
    const scope = { projectId: context.projectId, conversationId: context.conversationId };
    const key = keyOf(scope);

    if (name === 'web_close') {
      const entry = sessions.get(key);
      if (!entry) return { ok: true, closed: true, wasOpen: false };
      const result = await retire(entry, { reason: 'web_close' });
      if (!result.exited) throw new HostedBrowserError('浏览器进程没有在时限内退出,托管方需要查看节点。', { code: 'web-close-pending', status: 503 });
      return { ok: true, closed: true, wasOpen: true };
    }

    if (!browserReady()) return unavailable('BROWSER_MISSING', NO_BROWSER);

    let entry = sessions.get(key);
    if (entry && (entry.session.closed || entry.session.processExited)) {
      await retire(entry, { reason: 'exited', graceful: false });
      entry = null;
    }
    if (!entry) {
      if (name !== 'web_open') return { ok: false, error: NOT_OPEN, notOpen: true };
      if (typeof input.url !== 'string' || !input.url.trim()) return { ok: false, error: '要给 url' };
      // 地址本身就不许打开的(非 http(s)、内网、metadata…):当场拒,不为它起一个浏览器
      const admitted = await admitWebTarget(egress, input.url);
      if (!admitted.ok) return admitted.result;
      try { entry = await launch(scope); } catch (error) {
        const mapped = failure(error);
        if (mapped === null) return unavailable('BROWSER_MISSING', NO_BROWSER);
        if (mapped instanceof HostedBrowserError && mapped.code === 'web-busy') return { ok: false, code: 'BROWSER_BUSY', error: mapped.message };
        if (mapped instanceof HostedBrowserError && mapped.code === 'web-profile-busy') return { ok: false, code: 'PROFILE_BUSY', error: mapped.message };
        if (mapped instanceof HostedBrowserError && mapped.code === 'web-launch-failed') return unavailable('BROWSER_LAUNCH_FAILED', mapped.message);
        throw mapped;
      }
    }

    const registration = await bind(entry, context);
    // 动页面之前的闸:这一轮被收回(登记器打了信号)、或这个会话已经在收,就不动
    const guard = () => {
      if (registration.signal.aborted || entry.retired || closing) {
        throw new HostedBrowserError('这一轮对话的权限已被收回,没有操作网页。', { code: 'run-resource-fenced', status: 403 });
      }
    };
    guard();
    touch(entry);
    const session = entry.session;
    let result;
    try {
      if (name === 'web_open') result = await session.open(input.url, { guard });
      else if (name === 'web_view') result = await session.view();
      else if (name === 'web_click') result = await session.click(input, { guard });
      else if (name === 'web_type') result = await session.type(input, { guard });
      else if (name === 'web_scroll') result = await session.scroll(input, { guard });
      else result = await session.read(input);
    } catch (error) {
      // 动作半路被收回:浏览器已经被杀,报的是「权限被收回」而不是连接断开之类的内部错
      if (registration.signal.aborted || entry.retired === 'fence') {
        throw new HostedBrowserError('这一轮对话的权限已被收回,网页操作已停止。', { code: 'run-resource-fenced', status: 403 });
      }
      // 出错的回话也是固定句子:异常原文里可能带着页面上的字,不拼进去(日志里也只记异常的类名)。
      // 不在这里 return:出错的结果同样要过下面「交结果前」的那次授权复核
      const mapped = failure(error);
      if (mapped instanceof HostedBrowserError && mapped.code === 'web-timeout') {
        result = { ok: false, code: 'ACTION_TIMEOUT', error: `这一步超过 ${Math.round(cfg.actionMs / 1000)} 秒没有完成,已经停下。可以 web_view 看看页面现在的样子,或换一个地址。` };
      } else if ((mapped instanceof HostedBrowserError && mapped.code === 'web-closed') || entry.session.closed) {
        result = { ok: false, error: NOT_OPEN, notOpen: true };
      } else if (mapped instanceof HostedBrowserError) {
        throw mapped;
      } else {
        say('agent.web.action-failed', { tool: name, kind: String(error?.name ?? 'Error').slice(0, 40) });
        result = { ok: false, code: 'ACTION_FAILED', error: '这一步没有做成(浏览器那边出了错)。可以 web_view 看看页面现在的样子,再决定下一步。' };
      }
    } finally {
      touch(entry);
    }
    // 第二道:页面上的东西交回去之前,这一轮还得是当前这一轮、栅栏没动过
    const after = await resources.authorize(context, 'read');
    if (after.fenceRevision !== before.fenceRevision || registration.signal.aborted) {
      throw new HostedBrowserError('这一轮对话的权限在操作期间变了,结果没有交回。', { code: 'run-resource-fenced', status: 403 });
    }
    return result;
  }

  /* ------------------------------------------------------------------ 给宿主的口子 */

  /**
   * 关掉一个对话的浏览器并等到进程真的退出。对话被设为私有、被删时由宿主调。
   * @param {{ projectId: string, conversationId: string }} scope 来自鉴权与服务端
   * @param {{ reason?: 'private'|'stop'|'agent-off'|'conversation-deleted'|'project-deleted'|string, removeProfile?: boolean }} [o]
   * @returns {Promise<{ wasOpen: boolean, exited: boolean, alivePids: number[], profileRemoved: boolean }>}
   */
  async function closeConversation(scope, { reason = 'stop', removeProfile = removeProfileFor(reason) } = {}) {
    const dir = hostedBrowserDir(dataDir, scope);
    const key = keyOf(scope);
    const pendingLaunch = launching.get(key);
    if (pendingLaunch) { try { await pendingLaunch; } catch { /* 没起来就没有要关的 */ } }
    const prior = closingByKey.get(key);
    const task = (async () => {
      let result = { exited: true, alivePids: [], profileRemoved: false };
      const live = sessions.get(key);
      // 已经被摘掉的(登记器收回、闲置关、换下):它那次关闭可能还在进行,也可能没拿到退出凭据——都以它为准,不拿缺省值充数
      const last = live ? null : [...retired].filter((e) => e.key === key).pop() ?? null;
      if (live) result = await retire(live, { reason, graceful: false, removeProfile });
      else if (last) {
        try { result = await retire(last, { reason, graceful: false, removeProfile }); } catch { result = { exited: false, alivePids: [], profileRemoved: false }; }
        result = { ...result, exited: settled(last), alivePids: last.lastClose?.alivePids ?? result.alivePids ?? [] };
      } else if (prior) { try { await prior; } catch { /* 那次关闭自己记了结果 */ } }
      let profileRemoved = result.profileRemoved === true;
      if (removeProfile && !profileRemoved) {
        // 浏览器没开着,目录是以前留下的:先确认没有残留进程占着,再删
        await reapOrphan(dir, { timeoutMs: cfg.closeMs });
        profileRemoved = await removeSessionData(dir, { keepRev: !removeAllFor(reason), timeoutMs: cfg.closeMs });
      }
      return { wasOpen: Boolean(live), exited: result.exited === true, alivePids: result.alivePids ?? [], profileRemoved };
    })();
    noteKeyClosing(key, task);
    return task;
  }

  /** 项目被删:它名下所有对话的浏览器关掉、目录删掉 */
  async function removeProject(projectId) {
    if (typeof projectId !== 'string' || !ID_RE.test(projectId)) throw new HostedBrowserError('项目的 id 不合法。', { code: 'bad-scope' });
    const mine = [...sessions.values()].filter((e) => e.projectId === projectId);
    const results = await Promise.all(mine.map((e) => retire(e, { reason: 'project-deleted', graceful: false, removeProfile: true })));
    const dir = path.join(root, dirName(projectId));
    try {
      for (const conversation of fs.readdirSync(dir, { withFileTypes: true })) {
        if (conversation.isDirectory()) await reapOrphan(path.join(dir, conversation.name), { timeoutMs: cfg.closeMs });
      }
    } catch { /* 目录没有 */ }
    const removed = await removeDirFully(dir, { timeoutMs: cfg.closeMs });
    return { closed: results.length, exited: results.every((r) => r.exited), removed };
  }

  /**
   * 这个运行上下文名下的浏览器进程树是不是已经确实没了(给运行资源登记器的 `childTreeWitness` 用)。
   * 还开着、关闭没拿到退出凭据(记下的进程号还有活着的、进程组里还有活进程)的,都回 false;只有每一次关闭都核到「都退了」才回 true。
   */
  async function treeClosed(context) {
    const ck = contextKey(context);
    for (const entry of sessions.values()) if (entry.bound.has(ck)) return false;
    for (const entry of [...retired]) {
      if (!entry.contexts.has(ck)) continue;
      try { await entry.closed; } catch { /* 结果记在 lastClose 里 */ }
      // 关了却没核到「都退了」:重核一次,还是核不到就照实回 false(登记器的回执保持未完成)
      if (!settled(entry)) return false;
      retired.delete(entry);
    }
    return true;
  }

  /**
   * 这个对话的云端浏览器此刻开着的网页地址(`hosted-handoff.mjs` 的 `web_handoff` 只用这一个口子)。
   * 先过这一轮的授权;没有开着的页、浏览器已经退了回 null。只回地址,不回页面内容。
   */
  async function handoffTarget(context) {
    await resources.authorize(context, 'read');
    const entry = sessions.get(keyOf({ projectId: context.projectId, conversationId: context.conversationId }));
    if (!entry || entry.retired || entry.session.closed || entry.session.processExited) return null;
    const url = typeof entry.session.currentUrl === 'function' ? entry.session.currentUrl() : null;
    return url && /^https?:///i.test(url) ? { url } : null;
  }

  /** 一个对话的浏览器的出网记录(每个目标放行还是拒绝;给探针、测试与排障取证。主机名只在这里,不进服务日志) */
  function egressJournal(scope) {
    const entry = sessions.get(keyOf(scope));
    return entry ? entry.session.proxy.journal() : [];
  }

  function describe() {
    return {
      configured: browserReady(),
      open: sessions.size,
      launching: launching.size,
      closing: closings.size,
      limits: { maxBrowsers: cfg.maxBrowsers, idleCloseMs: cfg.idleCloseMs, navigationMs: cfg.navigationMs, actionMs: cfg.actionMs },
      sessions: [...sessions.values()].map((e) => ({
        projectId: e.projectId, conversationId: e.conversationId, browserPid: e.session.browserPid,
        pids: e.session.pids(), alive: e.session.pids().filter(pidAlive).length, proxyPort: e.session.proxy.port,
        mode: e.session.mode, egress: e.session.proxy.stats(),
      })),
    };
  }

  /**
   * 关闭:不再接新调用,所有浏览器整棵进程树杀掉,等进程号真的查不到、代理关掉。用户数据目录留着。
   * @returns {Promise<{ childrenClosed: boolean, streamsClosed: boolean, workPending: number }>}
   */
  function close(reason = 'close') {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await Promise.allSettled([...launching.values()]);
      const results = await Promise.allSettled([...sessions.values()].map((e) => retire(e, { reason: `host-${reason}`.slice(0, 40), graceful: false, removeProfile: false })));
      const finished = await Promise.race([Promise.allSettled([...closings]).then(() => true), sleep(cfg.closeMs * 2).then(() => false)]);
      const ok = results.every((r) => r.status === 'fulfilled' && r.value.exited);
      const proxies = results.every((r) => r.status === 'fulfilled' && r.value.proxyClosed);
      return { childrenClosed: finished && ok && leaked === 0, streamsClosed: finished && proxies, workPending: closings.size + sessions.size };
    })();
    return closePromise;
  }

  return Object.freeze({ handles, call, close, closeConversation, removeProject, treeClosed, describe, egressJournal, handoffTarget, ready: swept });
}
