/**
 * 托管档的 Agent 服务:实例登记表与一轮的生命周期(契约 `docs/plan/cloud-agent-contract.md` 第 3、6、7、16 节)。
 *
 * 一个进程里按「项目 × 成员(`userId`)」各建一个运行实例(`instance.mjs`),实例之间不共用任何以页面自报 id 为键的状态:
 * 一切查找先由 `identity`(来自鉴权,不来自请求体)定范围,再在范围里按对话 id 找。
 *
 * 运行实例与对话的**归属**是两回事(契约第 3.1、7.2 节):
 *   - 对话(事件记录、状态、模型历史、预渲染重试清单)按「项目 × 主人键」存在数据目录里(`conversations.mjs`),不随实例回收而消失,
 *     不依赖任何连接;主人换一台设备能找回;
 *   - 每一轮在发起它的那台设备的实例里跑。同一个对话先后两轮可以在两个实例里跑,同一时刻只有一轮。
 *
 * 一轮只属于服务端:发消息回了就与那条连接无关。只有这几样能让它结束,每样都在事件记录里留一条给人看的原因与一条 `end`,
 * `meta.json` 的状态与原因同步改(契约第 7.3 节):
 *   说完(idle)、主人停掉(idle / stopped)、模型调用失败(failed / model)、额度用尽(failed / quota-exceeded)、
 *   到轮数或时间上限(failed / limit)、撤销——开关关了、被移出、被踢、项目删除、授权失效(revoked / 原因)、
 *   服务进程退出或被杀(interrupted)。
 * 每次工具写入是文档服务的一次原子提交,所以一轮在任何时刻被停,项目都停在最后一次成功提交之后。
 *
 * 进程级的东西:
 *   - `execSerial`:服务端 store 是进程里的单例(`src/store/core.ts`),所有实例的工具实现经同一把锁串行执行、进锁清场;
 *   - 闸与用量记录(`gate.mjs`、`usage.mjs`);
 *   - 对话存储(`conversations.mjs`)与预渲染重试发布(`render-request.mjs`)。
 * 本文件不引用 `src/`。
 */
import { createHeavyRenderGate, createRenderClipPicker, FLAT_KERNEL_MODULE, loadHeavyJudge } from './render-clips.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createAgentInstance } from './instance.mjs';
import { createConversationStore, INTERRUPTED_MESSAGE } from './conversations.mjs';
import { createGate, limitsFileOf } from './gate.mjs';
import { createUsageLog } from './usage.mjs';
import { createRenderRequests } from './render-request.mjs';
import { modelReady, pickModel, publicModelInfo } from './model-config.mjs';
import { createWorkspaces } from './workspace.mjs';
import { createEgressGate } from './egress.mjs';
import { createHostedTools, readHostedVoiceConfig, saveAttachment } from './hosted-tools.mjs';
import { createAccountConversationService } from './conversation-policy.mjs';
import { findAgentExtension } from './extensions.mjs';

export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 满额提示(一级文字，2026-10-13 用户确认用这一句)。页面一侧的同一句集中在 `src/ai/cloud/chatTexts.ts`，要同步 */
export const CONVERSATION_LIMIT_MESSAGE = '你在这个项目里的云端对话已满 50 个。请先删除不用的对话，再新建。';

export const HOSTED_DEFAULTS = Object.freeze({
  /** 没有进行中的一轮、这么久没有请求的实例被回收 */
  idleMs: 10 * 60_000,
  /** 一轮的墙钟上限(2026-10-24 跟着轮次上限一起放宽:24 轮用掉 22 分钟就撞 30 分钟的墙,
   * 48 轮必须配更长的墙钟,否则放宽轮次白放) */
  runMs: 60 * 60_000,
  /** 一轮最多多少次模型往返(驱动里的常规上限;这里只用来告诉页面和写收尾那句话) */
  rounds: 48,
  /** 单个项目副本(JSON)超过这么大不服务 */
  maxProjectBytes: 16 * 1024 * 1024,
  /** 单次工具调用最多等多久(契约第 11 节) */
  toolMs: 60_000,
  /** 看画面的工具最多等多久:带用户卡的项目要等隔离工作进程起来(十来秒)、别的项目在渲时还要排队(契约第 9.8 节) */
  lookToolMs: 180_000,
  /** 一个对话的模型历史(`history.json`)超过这么大就按现有的历史截断(契约第 7.2 节) */
  maxHistoryBytes: 8 * 1024 * 1024,
  /** 反向通道(契约第 28 节):向发起人的页面发出一次请求后最多等多久;到时回「发起方不在线」 */
  pageMs: 15_000,
  /** 反向通道:发起人的页面刚发完消息、事件流还没接上(或刚断、正在重连)时,最多等它这么久;离开得更久就立刻回「发起方不在线」 */
  pageAttachMs: 3_000,
});

/** 页面号:页面自己起的随机串,发消息与开事件流时各报一次(契约第 28 节) */
export const PAGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** 反向通道上页面交回的结果(JSON)最多这么大 */
const MAX_PAGE_RESULT_BYTES = 64 * 1024;

/** 闸的替身:永远放行、不记用量(只给不关心闸的测试用;服务缺省用 `gate.mjs` 的真闸) */
export const ALLOW_ALL_GATE = Object.freeze({
  admitRun: () => ({ ok: true }),
  admitModelCall: () => ({ ok: true }),
  record: () => {},
  release: () => {},
});

export class AgentServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 32);

/**
 * 对话归谁(契约第 7.2 节,主会话 2026-10-06 裁定,待用户审)。文档服务核验委托票据后直接回主人键
 * (`creator` / `user:<用户名>` / `device:<userId>`,键里不含项目),有就用它;没有(测试替身)按同一条规则从字段推:
 * 创建者与限定进入的名单成员按用户名,换设备能找回;自由进入的成员按「用户名 + 设备」,只能在原设备找回。
 * 回的是当目录名用的摘要(项目也折进去)。
 * @param {{ projectId: string, userId: string, username?: string, creator?: boolean, mode?: string, ownerKey?: string }} identity
 */
export function ownerKeyOf(identity) {
  let name;
  if (typeof identity.ownerKey === 'string' && identity.ownerKey) name = identity.ownerKey;
  else if (identity.creator === true) name = 'creator';
  else if (identity.mode === 'restricted' && identity.username) name = `user:${identity.username}`;
  else name = `device:${identity.userId}`;
  return sha(`${identity.projectId}\n${name}`);
}

/** 撤销与授权失效时写进对话记录的那句话 */
const REVOKE_TEXT = Object.freeze({
  disabled: '项目创建者已关闭云端 Agent,这一轮已停下。已经落地的改动保留在项目里。',
  removed: '你已被移出这个项目,云端 Agent 的这一轮已停下。已经落地的改动保留在项目里。',
  kicked: '你已被请出这个项目,云端 Agent 的这一轮已停下。已经落地的改动保留在项目里。',
  deleted: '项目已删除,云端 Agent 的这一轮已停下。',
  expired: '这一轮的授权已过期,已停下。已经落地的改动保留在项目里;再发一条消息即可继续。',
  generation: '项目的成员名单或口令改过,这一轮的授权已失效,已停下。已经落地的改动保留在项目里;再发一条消息即可继续。',
  'bad-grant': '这一轮的授权没有被文档服务接受,已停下。已经落地的改动保留在项目里;再发一条消息即可继续。',
});
const revokeText = (reason) => REVOKE_TEXT[reason] ?? `云端 Agent 的这段对话已失效(${reason}),这一轮已停下。已经落地的改动保留在项目里。`;

/** 文档服务不给票据时的 `reason` → 对话记录里的收尾原因;不在表里的(连不上、超时)是暂时性故障,不收尾 */
const CREDENTIAL_REASON = Object.freeze({
  'service-disabled': 'disabled', 'service-revoked': 'disabled', banned: 'kicked', 'not-listed': 'removed', 'no-project': 'deleted',
  expired: 'expired', generation: 'generation',
  signature: 'bad-grant', format: 'bad-grant', audience: 'bad-grant', 'not-grant': 'bad-grant', project: 'bad-grant', conversation: 'bad-grant', forbidden: 'bad-grant',
});

/** 数据连接被文档服务关掉时的关闭码与原因 → 收尾原因(契约第 4.5 节) */
export function revokeReasonOfClose({ code, reason } = {}) {
  if (code === 4004) return 'deleted';
  if (reason === 'service-disabled') return 'disabled';
  if (reason === 'kicked' || reason === 'removed') return reason;
  return typeof reason === 'string' && reason ? reason.slice(0, 40) : 'removed';
}

/** 模型接口给的错误原文里去掉地址(地址是托管方的配置;Key 已由驱动替换掉) */
const scrub = (text) => String(text ?? '').replace(/https?:\/\/[^\s"'<>)]+/g, '[地址]').slice(0, 500);

/**
 * @param {object} o
 * @param {string} o.root 仓库根目录(系统提示词等相对它找)
 * @param {(id: string) => Promise<any>} o.loadModule 前端代码的唯一入口(vite 的 `ssrLoadModule`),只交给 `ssr-host.mjs`
 * @param {string} o.docUrl 文档服务的 ws(s) 地址
 * @param {object} o.credentials 连文档服务的凭证(接口位;真的由乙块的 `server/auth/service-client.mjs` 给):
 *   `protocolsFor(identity, 对话号, { conversationId, grant })` → 这个对话的连接用的子协议。文档服务明确不给时抛带 `reason` 的错
 *   (`expired`、`generation`、`service-disabled`、`banned`、`not-listed`、`no-project` 等),这一轮据此收尾;
 *   `admitGrant?(identity, conversationId, grant)` → 发消息时先核一遍对话委托,不对就抛(回 `bad-grant`)。
 * @param {() => Promise<object> | object} o.modelConfig 这一轮用的模型配置 `{ vendor, model, apiKey?, baseUrl?, maxTokens? }`
 * @param {string | null} [o.dataDir] 数据目录;不给时对话只在内存里、不记用量流水(只给测试)
 * @param {object} [o.gate] 闸;不给就用 `gate.mjs` 的(读 `<数据目录>/config/limits.json`)
 * @param {object | null} [o.publisher] 预渲染重试的发布通道(接口位,形状见 `render-request.mjs`);不给就不发预渲染重试
 * @param {{ agentEnabled?(projectId): boolean, renderEnabled?(projectId): boolean }} [o.projectState]
 *   各项目的开关(接口位;真的由文档服务的推送喂)。不给时都算开
 * @param {string | null} [o.assetBase] 同机素材服务的地址(`http://127.0.0.1:<端口>`);不给时导入素材、配音入库做不了(工具回明确的原因)
 * @param {{ forProject(projectId: string, o?: object): Function, describe?(): object } | null} [o.look] 看画面的客户端(`server/agent-service/look-client.mjs`):
 *   向同机的渲染服务要一帧。不给时看画面的工具不交给模型(契约第 9.8 节)
 * @param {object} [o.egress] 出网闸的选项(`egress.mjs` 的 `createEgressGate`;`testAllow` 只给测试与探针)
 * @param {() => Promise<object | null>} [o.voiceConfig] 托管方的配音配置;不给就读数据目录里的 `config/voice.json` 与 `config/keys/voice.key`
 * @param {object} [o.workspaceLimits] 工作区的总量上限(`workspace.mjs`)
 * @param {object | null} [o.collect] 节点上的采集工具(`hosted-collect.mjs` 的 `readCollectConfig`);不给时采集的工具回「这台云节点没有装采集工具」
 */
export function createHostedAgentService({
  root,
  loadModule,
  docUrl,
  credentials,
  modelConfig,
  dataDir = null,
  gate: gateIn = null,
  publisher = null,
  projectState = {},
  limits: limitsIn = {},
  storeLimits = {},
  renderLimits = {},
  assetBase = null,
  look = null,
  egress: egressOptions = {},
  voiceConfig = null,
  workspaceLimits = {},
  toolLimits = {},
  toolFetch = undefined,
  collect = null,
  accountMode = false,
  conversationClient = null,
  runClient = null,
  dataClient = null,
  resources = null,
  requireAccountRunner = false,
  readIntentsFile = null,
  runEventsFile = null,
  runEventsAuthorityId = null,
  runnerFactory = null,
  serviceKid = null,
  instanceId = null,
  connectionsClosed = null,
  childrenClosed = null,
  task = null, assignmentReady = null, onTaskDrained = null, runEventsSink = null,
  runAssets = null,
  accountTools = null,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  if (accountMode === true) {
    if (requireAccountRunner === true || runClient) { const runnerExt = findAgentExtension('account-runner'); if (!runnerExt?.createService) throw new AgentServiceError('run-unavailable', 'account runner is not mounted', 503); return runnerExt.createService({ root, loadModule, docUrl, dataDir,
      modelConfig, dataClient, resources, assetBase, look, voiceConfig: voiceConfig ?? (async () => null), collect,
      egress: egressOptions, workspaceLimits, toolLimits, toolFetch, runAssets, accountTools,
      conversationClient, runClient, readIntentsFile, runEventsFile, runEventsAuthorityId, runnerFactory, serviceKid, instanceId,
      connectionsClosed, childrenClosed, task, assignmentReady, onTaskDrained, runEventsSink, log, now }); }
    return createAccountConversationService({ conversationClient, now });
  }
  if (typeof loadModule !== 'function') throw new TypeError('createHostedAgentService: 要 loadModule');
  if (typeof docUrl !== 'string' || !/^wss?:\/\//.test(docUrl)) throw new TypeError('createHostedAgentService: docUrl 要是 ws(s):// 地址');
  if (!credentials || typeof credentials.protocolsFor !== 'function') throw new TypeError('createHostedAgentService: 要 credentials.protocolsFor');
  if (typeof modelConfig !== 'function') throw new TypeError('createHostedAgentService: 要 modelConfig');
  const limits = { ...HOSTED_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响服务 */ } };

  const agentEnabled = (projectId) => { try { return projectState.agentEnabled ? projectState.agentEnabled(projectId) !== false : true; } catch { return true; } };
  const renderEnabled = (projectId) => { try { return projectState.renderEnabled ? projectState.renderEnabled(projectId) !== false : true; } catch { return true; } };

  const usage = gateIn ? null : createUsageLog({ dir: dataDir ? path.join(dataDir, 'usage') : null, now, log: say });
  const gate = gateIn ?? createGate({ limitsFile: dataDir ? limitsFileOf(dataDir) : null, usage, isEnabled: agentEnabled, now, log: say });
  const store = createConversationStore({ dataDir, now, limits: storeLimits, log: say });
  const render = createRenderRequests({ publisher, store, now, limits: renderLimits, log: say });
  // 工具在节点上读写的一切按「项目 × 对话」隔离;按模型给的地址出网只经出网闸(任务书 J,契约第 9.5、9.6 节)
  const workspaces = createWorkspaces({ dataDir, limits: workspaceLimits, log: say });
  const egress = createEgressGate({ ...egressOptions, log: say });
  // 剪辑段的摊平视图(发布预渲染时收剪辑段里的卡,`render-clips.mjs`):经载入缝取内核函数,载好之前只按片段 id 挑
  let flatKernel = null;
  Promise.resolve().then(() => loadModule(FLAT_KERNEL_MODULE)).then((m) => { flatKernel = m; }, () => {});
  // 发布预渲染之前判轻重(只发重卡,`render-clips.mjs`「只发重卡」):判定函数经同一条载入缝取;载不了就照原来全发
  let heavyJudge = null;
  if (render.enabled) {
    Promise.resolve().then(() => loadHeavyJudge(loadModule)).then((fn) => { heavyJudge = fn; },
      (err) => say('agent.render.judge-unavailable', { message: String(err?.message ?? err).slice(0, 120) }));
  }
  const hostedTools = createHostedTools({
    root,
    loadModule,
    workspaces,
    egress,
    assetBase,
    voiceConfig: voiceConfig ?? (() => readHostedVoiceConfig(dataDir)),
    // 花钱的外部调用(配音)与模型请求记进同一份用量流水
    recordService: (row) => { try { gate.record(row); } catch (err) { say('agent.usage.service-failed', { message: String(err?.message ?? err).slice(0, 120) }); } },
    limits: toolLimits,
    // 网页采集:节点上装没装由部署决定(`hosted-collect.mjs`);没有时工具回明确的原因
    collect,
    ...(toolFetch ? { fetchImpl: toolFetch } : {}),
    log: say,
  });

  // 上一个进程没收尾就没了的对话:标中断,不自动续跑(契约第 7.5 节)。没渲完的预渲染重试清单重新发布(只用服务身份)
  store.recover();
  const restored = Promise.resolve().then(() => render.restore()).catch((err) => { say('agent.render.restore-failed', { message: String(err?.message ?? err).slice(0, 160) }); return 0; });

  /** 进程级的串行锁:所有实例的工具实现共用服务端那一份 store */
  let lock = Promise.resolve();
  const execSerial = (fn) => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };

  /** 实例键 → { key, identity, ownerKey, inst, ready, runs: Map(对话 id → 对话), lastUsed, closed } */
  const instances = new Map();
  /** 「实例键\n对话 id」→ 这一轮的对话委托。只放内存,不落盘、不进日志(契约第 4.2 节) */
  const grants = new Map();
  let closed = false;
  /** 撤销发生时要知道的各方(HTTP 层据此关掉事件流,鉴权层据此清核验缓存) */
  const revokeListeners = new Set();

  const keyOf = (identity) => `${identity.projectId}\n${identity.userId}\n${ownerKeyOf(identity)}`;
  const maxInstances = () => limitsIn.maxInstances ?? gate.nodeLimits?.().maxInstances ?? 24;

  function checkIdentity(identity) {
    if (!identity || typeof identity.projectId !== 'string' || !identity.projectId || typeof identity.userId !== 'string' || !identity.userId) {
      throw new AgentServiceError('unauthorized', '没有身份', 401);
    }
  }

  function checkConversationId(id) {
    if (typeof id !== 'string' || !CONVERSATION_ID_RE.test(id)) throw new AgentServiceError('bad-request', '对话 id 不合法');
  }

  function closeEntry(entry, reason) {
    if (entry.closed) return;
    entry.closed = true;
    instances.delete(entry.key);
    // 还在跑的一轮由调用方先按各自的原因停掉;走到这里还有的(不该有)按中断收尾,不让它悬着
    for (const conv of [...entry.runs.values()]) conv.run?.stop('interrupted');
    for (const rg of entry.renderGates?.values() ?? []) rg.close();
    try { entry.inst.close(reason); } catch { /* 已经关了 */ }
    say('agent.instance.close', { projectId: entry.identity.projectId, user: sha(entry.identity.userId).slice(0, 8), reason });
  }

  function reclaim() {
    const at = now();
    for (const entry of [...instances.values()]) {
      if (entry.runs.size === 0 && at - entry.lastUsed >= limits.idleMs) closeEntry(entry, 'idle');
    }
  }
  const sweep = setInterval(reclaim, Math.min(60_000, limits.idleMs));
  sweep.unref?.();

  /** 「发起方在线」:此刻有一条来自发起这一轮的那个 `userId` 的事件流连着这个对话(契约第 9.4 节) */
  function initiatorOnline(entry, conversationId) {
    const conv = entry.runs.get(conversationId);
    if (!conv?.run) return false;
    for (const l of conv.listeners) if (l.userId === conv.run.userId) return true;
    return false;
  }

  /*
   * ---------------- 反向通道(契约第 28 节) ----------------
   *
   * 一轮里要发起人的页面做事(播放头、播放与暂停、读当下的选区)时:向**发起这一轮的那张页面**的事件流发一条
   * `page.request { id, runId, tool, args, timeoutMs }`,页面用它本机同一套工具实现执行,经 `POST …/page-results` 交回。
   *   - 只认那一张页面:发消息时页面报了页面号(`pageId`),开事件流时也报;两者相同、且是同一个 `userId` 的那条流才算。
   *     同一位成员的别的设备、别的页签看得到对话,但收不到请求。发消息没报页面号的(旧页面)没有反向通道。
   *   - `page.request` 只发给那一条流,**不进事件记录、不带 `seq`**:它是此刻的一次请求,补看的人不该再执行一遍。
   *   - `id` 是服务端起的 128 位随机数,只有那张页面拿得到;交回时按「这个对话的主人、发起这一轮的 `userId`、
   *     这一轮的页面号、还在等的 `id`」核对,一次有效。
   *   - 等结果有时限(`pageMs`);到时、等的中途那条流断了、这一轮结束了,都回「发起方不在线」,Agent 据此继续。
   */
  const pageListenerOf = (conv) => {
    const run = conv?.run;
    if (!run?.pageId) return null;
    for (const l of conv.listeners) if (l.userId === run.userId && l.pageId === run.pageId) return l;
    return null;
  };

  /** 结束一个在等的请求(只会成功一次) */
  function settlePage(run, id, out) {
    const p = run?.pageRequests?.get(id);
    if (!p) return false;
    run.pageRequests.delete(id);
    clearTimeout(p.timer);
    p.resolve(out);
    return true;
  }

  /** 这一轮在等的请求按「发起方不在线」收掉(`listener` 给了就只收发给那条流的;不给是全部,连同在等页面接上的) */
  function failPageRequests(run, why, listener = null) {
    if (!run?.pageRequests) return;
    for (const [id, p] of [...run.pageRequests]) {
      if (listener && p.listener !== listener) continue;
      settlePage(run, id, { offline: true, why });
    }
    if (!listener) for (const w of [...run.pageWaiters]) w();
  }

  /**
   * 让发起人的页面执行一次。回 `{ ok: true, result }`(页面执行了,`result` 是它交回的 `{ ok, result?, error? }`)
   * 或 `{ offline: true, why }`(没有反向通道 / 页面不在 / 超时 / 中途断了 / 这一轮结束了)。
   */
  async function pageCall(entry, conversationId, tool, args) {
    const conv = entry.runs.get(conversationId);
    const run = conv?.run;
    if (!run?.pageId) return { offline: true, why: 'no-page' };
    let listener = pageListenerOf(conv);
    if (!listener) {
      // 刚发完消息流还没接上、或刚断正在重连:等一小会儿;已经离开得久了就立刻回
      const left = run.pageSeenAt + limits.pageAttachMs - now();
      if (left <= 0) return { offline: true, why: 'detached' };
      await new Promise((resolve) => {
        let t = null;
        const done = () => { clearTimeout(t); run.pageWaiters.delete(done); resolve(); };
        t = setTimeout(done, left);
        t.unref?.();
        run.pageWaiters.add(done);
      });
      if (conv.run !== run) return { offline: true, why: 'ended' };
      listener = pageListenerOf(conv);
      if (!listener) return { offline: true, why: 'detached' };
    }
    const id = randomBytes(16).toString('base64url');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { settlePage(run, id, { offline: true, why: 'timeout' }); }, limits.pageMs);
      timer.unref?.();
      run.pageRequests.set(id, { resolve, timer, listener, tool });
      say('agent.page.request', { projectId: entry.identity.projectId, runId: run.runId, tool });
      try {
        listener.cb({ type: 'page.request', id, runId: run.runId, tool, args: args ?? {}, timeoutMs: limits.pageMs });
      } catch {
        settlePage(run, id, { offline: true, why: 'detached' });
      }
    });
  }

  /** 这个实例里的一次写入落地了:挑出要预渲染的片段,交给预渲染重试(契约第 16 节) */
  function onWrite(entry, conversationId, write) {
    if (!render.enabled) return;
    const conv = entry.runs.get(conversationId);
    if (!conv?.run) return;
    // 剪辑段里的卡按摊平视图里的虚拟片段 id 发(`render-clips.mjs`;一个实例一份上一次的签名表)
    entry.renderPicker ??= createRenderClipPicker(() => flatKernel);
    renderGateOf(entry, conversationId, conv).note(write?.clipIds ?? [], write?.before ?? null);
  }

  /**
   * 这个对话的「攒一会儿、判轻重、只发重卡」(`render-clips.mjs` 的 `createHeavyRenderGate`)。攒的时长与预渲染重试的防抖同一个数;
   * 判重的交给预渲染重试(`render.noteWrite`),记在写入它们的那一轮名下。
   */
  function renderGateOf(entry, conversationId, conv) {
    entry.renderGates ??= new Map();
    let rg = entry.renderGates.get(conversationId);
    if (!rg) {
      let runId = conv.run?.runId ?? null;
      rg = createHeavyRenderGate({
        picker: entry.renderPicker, delayMs: render.debounceMs, log: say,
        replica: () => entry.inst.replica?.() ?? null,
        judge: () => heavyJudge,
        records: () => entry.inst.costRecords?.(conversationId) ?? Promise.resolve(null),
        emit: (clips, { rev }) => {
          const replica = entry.inst.replica?.();
          render.noteWrite(conv, { clips, rev: rev ?? replica?.rev, project: replica?.project ?? null, runId: rg.runId, userCards: entry.inst.hasProjectCards?.() === true });
        },
      });
      rg.runId = runId;
      entry.renderGates.set(conversationId, rg);
    }
    if (conv.run?.runId) rg.runId = conv.run.runId;
    return rg;
  }

  /**
   * 实例的第 n 条连接连文档服务用的凭证。对话委托绑死一个对话(契约第 4.2 节),所以连同对话 id 与这一轮的委托一起交给凭证一侧。
   * 实例自己的那条连接(副本的订阅、在场状态;执行器里没有对话 id 的那一个)没有自己的委托:借这个实例里此刻有委托的一个对话的。
   * 文档服务明确不给(委托过期、代数变了、开关关了、被踢、被移出、项目没了)时,被用到的那个对话的一轮按原因收尾;
   * 连不上、超时这类暂时性的不在此列,照常由连接层退避重试。
   */
  async function connectionCredentials(entry, n, conversationId) {
    let id = conversationId;
    let grant = grants.get(`${entry.key}\n${id}`) ?? null;
    if (!id) {
      const prefix = `${entry.key}\n`;
      for (const [k, g] of grants) {
        if (k.startsWith(prefix)) { id = k.slice(prefix.length); grant = g; break; }
      }
      if (!id) id = entry.runs.keys().next().value ?? '';
    }
    try {
      return await credentials.protocolsFor(entry.identity, n, { conversationId: id, grant });
    } catch (err) {
      const why = CREDENTIAL_REASON[err?.reason];
      if (why) entry.runs.get(id)?.run?.stop('revoked', { reason: why });
      throw err;
    }
  }

  /** 找到或建出这位成员在这个项目里的实例;同一个键并发到达的共用同一次建立 */
  async function instanceFor(identity) {
    if (closed) throw new AgentServiceError('unavailable', '服务正在关闭', 503);
    const key = keyOf(identity);
    let entry = instances.get(key);
    if (!entry) {
      if (instances.size >= maxInstances()) {
        const idle = [...instances.values()].filter((e) => e.runs.size === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new AgentServiceError('busy', '云端 Agent 正忙,请稍后再试。', 503);
        closeEntry(idle, 'evicted');
      }
      entry = { key, identity: { ...identity }, ownerKey: ownerKeyOf(identity), inst: null, runs: new Map(), lastUsed: now(), closed: false, ready: null };
      const own = entry;
      entry.inst = createAgentInstance({
        profile: 'hosted',
        server: {
          httpServer: null,
          ssrLoadModule: loadModule,
          config: { root },
          // 托管档没有 /api/*:实例登记的桌面路由一条都不挂
          middlewares: { use() {} },
        },
        // 看画面:向同机的渲染服务要一帧。项目是这个实例的项目(来自鉴权),工具参数改不了;卡片源码的版本由实例现报
        prerenderPost: look ? look.forProject(identity.projectId, { cards: () => own.inst?.cardRevs?.() ?? {} }) : null,
        latestMirror: () => null,
        latestPlayhead: () => null,
        projectId: identity.projectId,
        identity: { userId: identity.userId, username: identity.username ?? '' },
        ownerKey: own.ownerKey,
        hostedTools,
        docUrl,
        protocolsFor: (n, conversationId) => connectionCredentials(own, n, conversationId),
        execSerial,
        initiatorOnline: (conversationId) => initiatorOnline(own, conversationId),
        pageCall: (conversationId, tool, args) => pageCall(own, conversationId, tool, args),
        onWrite: (conversationId, write) => onWrite(own, conversationId, write),
        // 文档服务以 4003 / 4004 关掉了数据连接:撤销,立刻停这个实例里的每一轮并关实例,不重连
        onFinalClose: (info) => {
          const reason = revokeReasonOfClose(info);
          queueMicrotask(() => api.revoke({ projectId: own.identity.projectId, userId: own.identity.userId, reason }));
        },
        log: (event, fields) => say(event, fields),
      });
      entry.ready = entry.inst.bindAgent({ projectId: identity.projectId, mode: 'hosted' }).then(() => own, (err) => {
        closeEntry(own, 'bind-failed');
        throw new AgentServiceError('unavailable', `连不上文档服务:${err?.message ?? err}`, 503);
      });
      instances.set(key, entry);
      say('agent.instance.open', { projectId: identity.projectId, user: sha(identity.userId).slice(0, 8), instances: instances.size });
    }
    entry.lastUsed = now();
    return entry.ready;
  }

  /** 这位成员(按主人键)在这个项目里的一个对话;没有回 null */
  function conversationOf(identity, conversationId, create = false) {
    checkIdentity(identity);
    if (typeof conversationId !== 'string' || !CONVERSATION_ID_RE.test(conversationId)) return null;
    try {
      return store.get(identity.projectId, ownerKeyOf(identity), conversationId, { create, startedOn: identity.deviceName ?? null });
    } catch (err) {
      // 满额不自动删历史(2026-10-08 用户定)：新建被拒，要用户自己先删旧的
      if (err?.code === 'conversation-limit') throw new AgentServiceError('conversation-limit', CONVERSATION_LIMIT_MESSAGE, 409);
      throw err;
    }
  }

  const listItem = (m) => ({ id: m.id, title: m.title ?? '', updatedAt: m.updatedAt ?? null, state: m.state, reason: m.reason ?? null, lastSeq: m.lastSeq ?? 0, startedOn: m.startedOn ?? null });

  const api = {
    limits,
    /** 起来时的预渲染重试重发做完了没有(测试等它) */
    restored,

    /**
     * 发一条消息、起一轮。这一轮从此与调用方的连接无关:事件进这个对话的事件记录,谁连着谁看。
     * @returns {Promise<{ runId: string, seq: number }>} `seq` 是这一轮第一条事件(用户消息)的序号
     */
    async send(identity, conversationId, body = {}) {
      checkIdentity(identity);
      if (closed) throw new AgentServiceError('unavailable', '服务正在关闭', 503);
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new AgentServiceError('bad-request', '消息是空的');
      checkConversationId(conversationId);
      const before = conversationOf(identity, conversationId, false);
      if (before?.run) throw new AgentServiceError('busy-conversation', '这个对话还有一轮在进行。', 409);
      if (before && store.full(before)) throw new AgentServiceError('too-large', '这个对话的记录已经太长,请新开一个对话。', 413);
      const cfg = (await modelConfig()) ?? {};
      if (!modelReady(cfg)) throw new AgentServiceError('no-model-key', '托管方还没有为云端 Agent 配置模型。', 503);
      const grant = typeof body.grant === 'string' && body.grant ? body.grant : null;
      if (typeof credentials.admitGrant === 'function') {
        try {
          await credentials.admitGrant(identity, conversationId, grant);
        } catch (err) {
          if (err instanceof AgentServiceError) throw err;
          const why = CREDENTIAL_REASON[err?.reason];
          if (why === 'disabled') throw new AgentServiceError('disabled', '项目创建者已关闭云端 Agent。', 403);
          if (err?.reason === 'unavailable' || err?.reason === 'timeout') throw new AgentServiceError('unavailable', '文档服务暂时连不上,请稍后再试。', 503);
          throw new AgentServiceError('bad-grant', '这条消息带的授权不对或已过期,请重试。', 403);
        }
      }
      // 闸:一轮开始前(契约第 6.2 节)。放行即占名额,之后恰好还一次
      const admitted = await gate.admitRun({ projectId: identity.projectId, userId: identity.userId });
      if (!admitted?.ok) {
        const code = admitted?.code ?? 'busy';
        throw new AgentServiceError(code, admitted?.message ?? '云端 Agent 正忙,请稍后再试。', code === 'disabled' ? 403 : 429);
      }
      const slot = { projectId: identity.projectId, userId: identity.userId };
      // 委托先放好:实例一建起来就要连文档服务,那时就得有凭证
      const grantKey = `${keyOf(identity)}\n${conversationId}`;
      const hadGrant = grants.get(grantKey);
      if (grant) grants.set(grantKey, grant);
      let entry;
      let conv;
      try {
        entry = await instanceFor(identity);
        conv = conversationOf(identity, conversationId, true);
        if (!conv) throw new AgentServiceError('bad-request', '对话 id 不合法');
        if (conv.run) throw new AgentServiceError('busy-conversation', '这个对话还有一轮在进行。', 409);
      } catch (err) {
        gate.release(slot);
        // 这条消息没起成一轮:它带来的委托不留(同一个对话正在跑的那一轮的委托放回去)
        if (grant) { if (hadGrant) grants.set(grantKey, hadGrant); else grants.delete(grantKey); }
        throw err;
      }
      // 从这里到 `conv.run = …` 没有等待:同一个对话并发到达的两条消息只有一条过得去

      const runId = randomUUID();
      if (!grant) grants.delete(grantKey);
      const model = pickModel(cfg, typeof body.model === 'string' ? body.model : undefined);
      let finished = false;
      let stopped = false;
      let sawError = null;
      let limitHit = false;
      let inner = null;
      let timer = null;

      const finish = (state, reason = null, message = null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // 还在等页面的请求:这一轮没了,不再等
        failPageRequests(conv.run, 'ended');
        conv.run = null;
        conv.pinned = false;
        entry.runs.delete(conversationId);
        grants.delete(grantKey);
        entry.lastUsed = now();
        gate.release(slot);
        store.emit(conv, { type: 'end', runId, state, ...(reason ? { reason } : {}) });
        store.setState(conv, { state, reason, message, endedAt: now() });
        store.compact(conv);
        say('agent.run.end', { projectId: identity.projectId, runId, state, ...(reason ? { reason } : {}) });
        // 一轮结束:攒着的先判完轻重,再把预渲染重试马上发,保证最后的版本有计划
        void Promise.resolve(entry.renderGates?.get(conversationId)?.flush()).then(() => render.flush(conv));
      };

      const stop = (kind, detail = {}) => {
        if (finished) return;
        stopped = true;
        try { inner?.abort(); } catch { /* 已经结束 */ }
        if (kind === 'stopped') {
          store.emit(conv, { type: 'status', runId, text: '已停止' });
          finish('idle', 'stopped');
        } else if (kind === 'limit') {
          const message = `这一轮超过了 ${Math.round(limits.runMs / 60_000)} 分钟的上限,已停下。已经落地的改动保留在项目里。`;
          store.emit(conv, { type: 'error', code: 'limit', runId, message });
          finish('failed', 'limit', message);
        } else if (kind === 'revoked') {
          const reason = detail.reason ?? 'revoked';
          const message = revokeText(reason);
          store.emit(conv, { type: 'error', code: 'revoked', reason, runId, message });
          finish('revoked', reason, message);
        } else {
          store.emit(conv, { type: 'error', code: 'interrupted', runId, message: INTERRUPTED_MESSAGE });
          finish('interrupted', 'interrupted', INTERRUPTED_MESSAGE);
        }
      };

      conv.run = {
        runId, userId: identity.userId, stop,
        // 反向通道(契约第 28 节):发起这一轮的那张页面的页面号;没报(旧页面)就没有反向通道
        pageId: typeof body.pageId === 'string' && PAGE_ID_RE.test(body.pageId) ? body.pageId : null,
        pageRequests: new Map(),
        pageWaiters: new Set(),
        pageSeenAt: now(),
      };
      conv.pinned = true;
      entry.runs.set(conversationId, conv);
      // 这条消息带的附件(只认这个对话工作目录里真有的):名字、地址、大小记进用户消息的事件里,换设备或重开对话时气泡里看得到
      const attached = [];
      if (Array.isArray(body.attachments) && workspaces.available) {
        try {
          const ws = workspaces.open({ projectId: identity.projectId, ownerKey: ownerKeyOf(identity), conversationId });
          for (const a of body.attachments.slice(0, 32)) {
            const url = typeof a?.url === 'string' ? a.url : '';
            if (!url.startsWith('work:attachments/')) continue;
            let st = null;
            try { st = ws.stat(url.slice(5)); } catch { st = null; }
            if (st) attached.push({ name: url.slice('work:attachments/'.length), url, size: st.size });
          }
        } catch { /* 没有工作区:当作没带附件 */ }
      }
      const first = store.emit(conv, { type: 'user', runId, prompt: body.prompt, from: identity.deviceName ?? null, at: now(), ...(attached.length ? { attachments: attached } : {}) });
      store.setState(conv, {
        state: 'running', reason: null, message: null, runId, startedAt: now(), endedAt: null,
        startedOn: identity.deviceName ?? conv.meta.startedOn ?? null,
        ...(conv.meta.title ? {} : { title: (body.prompt.trim().split('\n')[0] ?? '').slice(0, 40) }),
      });
      say('agent.run.start', { projectId: identity.projectId, runId });

      inner = entry.inst.startHostedRun({
        runId,
        conversationId,
        prompt: body.prompt,
        model: typeof body.model === 'string' ? body.model : undefined,
        effort: typeof body.effort === 'string' ? body.effort : undefined,
        creativity: body.creativity,
        script: body.script,
        library: Array.isArray(body.library) ? body.library : [],
        attachments: attached,
        pageState: body.pageState && typeof body.pageState === 'object' ? body.pageState : null,
        apiConfig: cfg,
        historyFile: dataDir ? path.join(store.dirOf(identity.projectId, ownerKeyOf(identity), conversationId), 'history.json') : null,
        // 代码块空间按项目放(A07,2026-10-22),放在这个项目的 tenants 目录下:删项目时随它一起清(conversations.mjs 的删项目);没有数据目录时由 api 运行器放在历史文件旁边
        ...(dataDir ? { codeCacheDir: path.join(dataDir, 'tenants', identity.projectId, 'code-cache') } : {}),
        // 输出速度记录(按实测速度设单次输出上限,2026-10-22):和用量流水同目录
        ...(dataDir ? { outputSpeedFile: path.join(dataDir, 'usage', 'model-speed.json') } : {}),
        sessionKey: `cloud-${ownerKeyOf(identity).slice(0, 16)}-${conversationId}`,
        maxProjectBytes: limits.maxProjectBytes,
        toolTimeoutMs: limits.toolMs,
        lookTimeoutMs: limits.lookToolMs,
        historyMaxBytes: limits.maxHistoryBytes,
        fetchImpl: body.__fetchImpl,
        // 闸:每次模型请求前(契约第 6.2 节);之后记一行用量(第 6.3 节)
        onModelCall: async (phase, info) => {
          if (phase === 'before') {
            const ok = await gate.admitModelCall({ projectId: identity.projectId, userId: identity.userId, model });
            if (!ok?.ok) throw Object.assign(new Error(ok?.message ?? '云端 Agent 现在不能调用模型。'), { runErrorCode: ok?.code ?? 'busy' });
            return;
          }
          gate.record({
            t: now(), projectId: identity.projectId, userId: identity.userId, username: identity.username ?? '', conversationId, runId,
            vendor: info?.vendor ?? cfg.vendor ?? '', model: info?.model ?? model,
            input: info?.input ?? 0, output: info?.output ?? 0, cacheRead: info?.cacheRead ?? 0, ok: info?.ok !== false, ms: info?.ms ?? 0,
          });
        },
        onEvent: (ev) => {
          if (finished) return;
          let out = ev;
          if (ev.type === 'diagnostic') {
            // 托管档只发配置与请求、回应的计数,不带模型接口的地址(契约第 2.4 节)
            if (ev.stage !== 'configuration' && ev.stage !== 'request' && ev.stage !== 'response') return;
          } else if (ev.type === 'error') {
            out = typeof ev.code === 'string' ? ev : { ...ev, code: 'model', message: `模型调用失败:${scrub(ev.message)}` };
            sawError = out;
          } else if (ev.type === 'done' && ev.outcome === 'round_limit') {
            limitHit = true;
          }
          store.emit(conv, { ...out, runId });
        },
      });
      timer = setTimeout(() => stop('limit'), limits.runMs);
      timer.unref?.();
      if (stopped) { try { inner.abort(); } catch { /* 已经结束 */ } }

      inner.done.then(
        () => {
          if (finished || stopped) return;
          if (sawError) return finish('failed', sawError.code ?? 'model', sawError.message ?? null);
          if (limitHit) {
            const message = `这一轮到了 ${limits.rounds} 次模型往返的上限,已停下。已经落地的改动保留在项目里,可以接着说。`;
            store.emit(conv, { type: 'error', code: 'limit', runId, message });
            return finish('failed', 'limit', message);
          }
          return finish('idle', null);
        },
        (err) => {
          if (finished || stopped) return;
          const message = `模型调用失败:${scrub(err?.message ?? err)}`;
          store.emit(conv, { type: 'error', code: 'model', runId, message });
          finish('failed', 'model', message);
        },
      );
      return { runId, seq: first.seq };
    },

    /**
     * 看一个对话的事件:先把 `seq` 大于 `after` 的补发,再接实时的。回退订函数。
     * 对话不存在(或不是这位成员在这个项目里的)时回 null,不泄露存在与否之外的任何东西。
     */
    subscribe(identity, conversationId, after, onEvent, { pageId = null } = {}) {
      const conv = conversationOf(identity, conversationId, false);
      if (!conv) return null;
      const entry = instances.get(keyOf(identity));
      if (entry) entry.lastUsed = now();
      const page = typeof pageId === 'string' && PAGE_ID_RE.test(pageId) ? pageId : null;
      const off = store.subscribe(conv, after, onEvent, { userId: identity.userId, pageId: page });
      const mine = off.listener;
      const isInitiator = (run) => !!run && !!page && run.pageId === page && run.userId === identity.userId;
      // 发起这一轮的那张页面接上了:叫醒在等它的调用
      if (isInitiator(conv.run)) for (const w of [...conv.run.pageWaiters]) w();
      return () => {
        off();
        const run = conv.run;
        if (!run) return;
        // 记下它离开的时刻(短暂重连的宽限从这里算);发给这条流的请求不再等
        if (isInitiator(run)) run.pageSeenAt = now();
        failPageRequests(run, 'detached', mine);
      };
    },

    /**
     * 发起人的页面交回一次反向通道请求的结果(契约第 28 节)。核对:这个对话是这位成员的(主人键)、有一轮在跑、
     * 交的人就是发起这一轮的那个 `userId`、页面号是这一轮的、`id` 还在等。后四条任何一条不对都回同一个 `page-request-gone`,
     * 不说是哪条;对话不是他的(或不存在)回 null(HTTP 层答 404,与别的接口一样)。
     * 一次有效:收下即从在等的表里去掉,同一个 `id` 再交被拒。
     */
    pageResult(identity, conversationId, body = {}) {
      const conv = conversationOf(identity, conversationId, false);
      if (!conv) return null;
      const gone = () => new AgentServiceError('page-request-gone', '这次请求已经不在等了。', 410);
      const run = conv.run;
      const id = typeof body.id === 'string' ? body.id : '';
      if (!run || !run.pageId || run.userId !== identity.userId || body.pageId !== run.pageId || !run.pageRequests.has(id)) throw gone();
      const out = body.ok === true
        ? { ok: true, result: body.result ?? null }
        : { ok: false, error: String(typeof body.error === 'string' && body.error ? body.error : '页面没有做成这一步').slice(0, 500) };
      if (Buffer.byteLength(JSON.stringify(out)) > MAX_PAGE_RESULT_BYTES) {
        // 太大的不收,但这次请求算答过了(不让 Agent 干等到超时)
        settlePage(run, id, { ok: true, result: { ok: false, error: '页面交回的结果太大,没有收下。' } });
        throw new AgentServiceError('too-large', '页面交回的结果太大', 413);
      }
      if (!settlePage(run, id, { ok: true, result: out })) throw gone();
      return { ok: true };
    },

    /** 停这个对话进行中的一轮。主人从任何设备都能停;别人的、不存在的都当作没有 */
    abort(identity, conversationId) {
      const conv = conversationOf(identity, conversationId, false);
      conv?.run?.stop('stopped');
      return { ok: true };
    },

    /** 这位成员(按主人键)在这个项目里的对话,最近动过的在前 */
    conversations(identity) {
      checkIdentity(identity);
      return store.list(identity.projectId, ownerKeyOf(identity)).map(listItem);
    },

    /** 一个对话的状态;没有回 null */
    conversation(identity, conversationId) {
      const conv = conversationOf(identity, conversationId, false);
      if (!conv) return null;
      return { ...listItem({ ...conv.meta, lastSeq: conv.seq }), message: conv.meta.message ?? null, runId: conv.meta.runId ?? null };
    },

    /** 改标题;没有这个对话回 false */
    rename(identity, conversationId, title) {
      const conv = conversationOf(identity, conversationId, false);
      if (!conv) return false;
      store.setState(conv, { title: String(title ?? '').trim().slice(0, 80) });
      return true;
    },

    /** 删对话:进行中的先停;连模型历史、预渲染重试清单、工作目录(附件、下载的文件)一起删。没有这个对话回 false */
    remove(identity, conversationId) {
      const conv = conversationOf(identity, conversationId, false);
      if (!conv) return false;
      conv.run?.stop('stopped');
      const owner = instances.get(keyOf(identity));
      owner?.renderGates?.get(conversationId)?.close();
      owner?.renderGates?.delete(conversationId);
      render.forget(conv);
      store.remove(conv);
      try { workspaces.open({ projectId: identity.projectId, ownerKey: ownerKeyOf(identity), conversationId }).destroy(); } catch { /* 没有工作区 */ }
      return true;
    },

    /**
     * 存一个附件到这个对话的工作目录(契约第 9.5 节)。对话还没有也可以先传(发第一条消息之前选的附件);
     * 回 `{ name, url, size, kind, text? }`,`url` 是 `work:attachments/<文件名>`,随下一条消息的 `attachments` 带回来。
     * 只读成员也能传(附件只在他自己的对话里,进不进素材库由 `import_media` 时的权限定)。
     * @param {AsyncIterable<Buffer>} stream
     */
    async attach(identity, conversationId, name, stream) {
      checkIdentity(identity);
      checkConversationId(conversationId);
      if (closed) throw new AgentServiceError('unavailable', '服务正在关闭', 503);
      if (!agentEnabled(identity.projectId)) throw new AgentServiceError('disabled', '项目创建者已关闭云端 Agent。', 403);
      if (!workspaces.available) throw new AgentServiceError('unavailable', '这个云端 Agent 服务没有工作目录,不能收附件。', 503);
      const ws = workspaces.open({ projectId: identity.projectId, ownerKey: ownerKeyOf(identity), conversationId });
      try {
        return await saveAttachment(ws, name, stream);
      } catch (err) {
        if (err?.workspace) throw new AgentServiceError(err.code === 'quota' || err.code === 'too-large' ? 'too-large' : 'bad-request', err.message, err.code === 'quota' || err.code === 'too-large' ? 413 : 400);
        if (err?.code === 'too-large') throw new AgentServiceError('too-large', err.message, 413);
        if (err?.code === 'bad-request') throw new AgentServiceError('bad-request', err.message, 400);
        throw err;
      }
    },

    /** 本项目的用量:总量与各成员的量(项目内任何成员可查) */
    usage(identity, since = null) {
      checkIdentity(identity);
      if (!usage) return { project: { tokens: 0, calls: 0 }, members: [], services: [] };
      const s = usage.summary(identity.projectId, Number.isFinite(since) ? since : null);
      const byName = new Map();
      for (const m of s.members) {
        const name = m.username || String(m.userId ?? '').split('@')[0];
        const cur = byName.get(name) ?? { username: name, tokens: 0, calls: 0 };
        cur.tokens += m.tokens; cur.calls += m.calls;
        byName.set(name, cur);
      }
      // 外部服务(配音等)的调用单列:按服务与服务商,各成员按用户名归并
      const services = (s.services ?? []).map((sv) => {
        const people = new Map();
        for (const m of sv.members ?? []) {
          const name = m.username || String(m.userId ?? '').split('@')[0];
          const cur = people.get(name) ?? { username: name, calls: 0, units: 0 };
          cur.calls += m.calls; cur.units += m.units;
          people.set(name, cur);
        }
        return { service: sv.service, vendor: sv.vendor, calls: sv.calls, units: sv.units, unit: sv.unit, members: [...people.values()] };
      });
      return { project: s.project, members: [...byName.values()], services };
    },

    /** `GET /v1/info` 的内容(契约第 2.3 节) */
    async info(identity) {
      checkIdentity(identity);
      let cfg = {};
      try { cfg = (await modelConfig()) ?? {}; } catch { cfg = {}; }
      const q = gate.quotaOf?.(identity.projectId) ?? { tokens: 0, limitTokens: null };
      return {
        enabled: agentEnabled(identity.projectId),
        render: { enabled: render.enabled && renderEnabled(identity.projectId) },
        ...publicModelInfo(cfg),
        limits: { rounds: limits.rounds, runMs: limits.runMs },
        usage: { tokens: q.tokens, limitTokens: q.limitTokens, ...(q.window ? { window: q.window } : {}) },
        running: store.list(identity.projectId, ownerKeyOf(identity)).filter((m) => m.state === 'running').map((m) => m.id),
      };
    },

    /**
     * 撤销(契约第 4.5 节):受影响实例里进行中的一轮各记原因后立刻停下,实例关掉。`userId` 不给表示整个项目。
     * `reason`:`disabled`(开关关了)、`removed`、`kicked`、`deleted`。开关关了与项目删除时撤回并清掉预渲染重试清单;
     * 项目删除时删掉这个项目的对话记录与模型历史(用量记录留着,它是托管方的账)。
     */
    revoke({ projectId, userId = null, reason }) {
      for (const entry of [...instances.values()]) {
        if (entry.identity.projectId !== projectId) continue;
        if (userId !== null && entry.identity.userId !== userId) continue;
        for (const conv of [...entry.runs.values()]) conv.run?.stop('revoked', { reason });
        closeEntry(entry, `revoked:${reason}`);
      }
      if (reason === 'disabled' || reason === 'deleted') void render.cancelProject(projectId);
      if (reason === 'deleted') { store.removeProject(projectId); workspaces.removeProject(projectId); }
      for (const fn of [...revokeListeners]) { try { fn({ projectId, userId, reason }); } catch { /* 监听方的事 */ } }
    },

    /** 撤销发生时调 `fn({ projectId, userId, reason })`(`userId` 为 null 表示整个项目);回取消函数 */
    onRevoke(fn) {
      revokeListeners.add(fn);
      return () => revokeListeners.delete(fn);
    },

    /** 诊断:不含任何正文 */
    describe() {
      return {
        instances: [...instances.values()].map((e) => ({
          projectId: e.identity.projectId,
          user: sha(e.identity.userId).slice(0, 8),
          conversations: e.runs.size,
          running: e.runs.size,
        })),
        gate: gate.describe?.() ?? null,
        render: render.describe(),
        egress: egress.describe(),
        look: look?.describe?.() ?? null,
      };
    },

    /** 测试与诊断:某位成员的实例(没有回 null) */
    _instance(identity) {
      return instances.get(keyOf(identity))?.inst ?? null;
    },
    _render: render,
    _store: store,
    _workspaces: workspaces,
    /** 这个进程配没配看画面的口子(状态口报它) */
    look: !!look,
    /** 这台节点装没装采集工具;用的是不是测试替身(生产必须是 false) */
    collect: hostedTools.collectInstalled === true,
    collectTestRunner: collect?.testRunner === true,
    /** 出网闸的测试例外开没开(状态口报它;生产必须是 false) */
    egressTestAllow: egress.testAllowActive,

    /**
     * 收尾(SIGTERM,契约第 3.4 节):不再接新请求 → 进行中的每一轮记「中断」并停下 → 状态落盘 → 关连接。
     * 没渲完的预渲染重试清单留在盘上,下次起来重发。
     */
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      for (const entry of [...instances.values()]) {
        for (const conv of [...entry.runs.values()]) conv.run?.stop('interrupted');
        closeEntry(entry, 'service-close');
      }
      render.close();
      usage?.close();
      store.close();
    },
  };
  return api;
}
