#!/usr/bin/env node
/**
 * 账号模式下「主服务」和「任务进程」两个系统用户之间的文件权限自检(0.7.18 云端 Agent 工具表接线)。
 *
 * 为什么要有它:生产上主服务和任务进程是两个不同的系统用户、同在一个共用组里,共用数据目录是那个组的(2770),
 * 两个单元都带 UMask=0007(`server/hosted/deploy/README.md`「用户、目录、权限」)。下面两件事只有在这种两个用户的环境里才验得出,
 * Windows 上单用户的测试和探针验不出:
 *   1. 用量流水:任务进程写,主服务读(成员查用量)。读不到时要明确报错,不许回 200 加全零;
 *   2. 「浏览器数据要清」的记号:主服务写,任务进程读、并由任务进程一侧照着清。主服务直接删只是尽力而为——
 *      浏览器在用户数据目录下建的子目录只有属主进得去(0700),主服务删不动。
 *
 * 做法:**不建系统账号**。挑两个没有登记的数字用户号(一个扮主服务、一个扮任务用户)、一个没有登记的数字组号当共用组,
 * 每一步起一个子进程,子进程先把自己降成那个用户(补充组 → 主组 → 用户号 → umask 0007),再调**产品自己的模块**做那一步。
 * 只碰它自己建的临时目录,跑完删干净。
 *
 * 用法(只在 Linux 上、以 root 跑;别的平台、别的用户直接退出,退出码 2):
 *   sudo node scripts/probes/account-tools-perms-linux.mjs [--tmp <放临时目录的地方,缺省系统临时目录>] [--repo <检出的根目录,缺省按本文件的位置算>] [--keep]
 * 检出要放在别的用户读得到的地方(路径上每一级目录至少 o+x、文件 o+r;放在 /root 下面不行),只需要 `server/` 和本文件,不需要 node_modules。
 * Node 要和产品用的是同一个(要有 node:sqlite)。
 *
 * 输出:每一项一行 `PERMS OK|FAIL <说明> :: <细节>`,末行 `PASS n/n`(全过,退出码 0)或 `FAIL k/n`(有 k 项没过,退出码 1)。
 * 这一版全过是 `PASS 26/26`(哪一步自己出错会多记一项没过,分母跟着变)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const flag = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : null; };
const REPO = path.resolve(flag('--repo') ?? path.join(path.dirname(SELF), '..', '..'));
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
const PROJECT = 'permproj';
const listing = (dir) => { try { return fs.readdirSync(dir).sort(); } catch (error) { return error?.code === 'ENOENT' ? null : `!${error?.code}`; } };
const modeOf = (file) => { try { const st = fs.statSync(file); return { mode: (st.mode & 0o7777).toString(8), uid: st.uid, gid: st.gid }; } catch (error) { return { error: error?.code ?? 'error' }; } };
const errorOf = (error) => ({ code: error?.code ?? null, status: error?.status ?? null, errno: error?.errno ?? null, message: String(error?.message ?? error).slice(0, 200) });

/* ================= 子进程:先降权,再做一步 ================= */

const STEPS = {
  /** 我是谁(核降权真的生效了:后面每一项都靠它) */
  async whoami({ rootOnlyFile }) {
    let readRootOnly = false;
    try { fs.readFileSync(rootOnlyFile); readRootOnly = true; } catch { /* 读不到才对 */ }
    return { uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), groups: process.getgroups(), umask: process.umask().toString(8), readRootOnly };
  },

  /** 任务进程:照产品的写法记用量(`createUsageLog({ shared: true })`,`account-runner.mjs` 就是这么建的) */
  async usageWrite({ dir }) {
    const { createUsageLog } = await load('server/agent/service/usage.mjs');
    const usage = createUsageLog({ dir, shared: true, flushMs: 3_600_000 });
    const t = Date.now();
    usage.append({ t, projectId: PROJECT, userId: 'acct-a', username: '甲', conversationId: 'c1', runId: 'r1', vendor: 'mock', model: 'm1', input: 10, output: 20, ok: true, ms: 5 });
    usage.append({ t, projectId: PROJECT, userId: 'acct-a', username: '甲', conversationId: 'c1', runId: 'r1', kind: 'service', service: 'web', vendor: 'chromium', model: 'web_open', units: 1, unit: 'calls', ok: true, ms: 5 });
    usage.close();
    const month = fs.readdirSync(dir).find((name) => name.endsWith('.jsonl'));
    return { dir: modeOf(dir), file: modeOf(path.join(dir, month)), names: listing(dir) };
  },
  /**
   * 任务进程:照修之前的写法建(目录 0700、流水 0600)——用来验「读不到时报错」和「起来时补成组内可读」。
   * 和修之前的产品代码一样只在建的时候给权限、不另外 chmod:上级目录带 setgid,所以建出来的目录仍归共用组(2700)。
   */
  async usageWriteOld({ dir }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const d = new Date();
    const file = path.join(dir, `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ t: Date.now(), projectId: PROJECT, userId: 'acct-a', username: '甲', conversationId: 'c1', runId: 'r1', vendor: 'mock', model: 'm1', input: 3, output: 4, ok: true, ms: 1 })}\n`, { mode: 0o600 });
    return { dir: modeOf(dir), file: modeOf(file) };
  },
  /** 任务进程:以 `shared: true` 打开一份已有的用量目录再关上(任务进程每次起来都会这么做) */
  async usageReopen({ dir }) {
    const { createUsageLog } = await load('server/agent/service/usage.mjs');
    createUsageLog({ dir, shared: true, flushMs: 3_600_000 }).close();
    const month = fs.readdirSync(dir).find((name) => name.endsWith('.jsonl'));
    return { dir: modeOf(dir), file: modeOf(path.join(dir, month)) };
  },
  /** 主服务:读用量。三种读法各记结果:严格档(成员查用量走的)、老的宽松档、成员查用量的那个接口 */
  async usageRead({ dir }) {
    const { queryUsage } = await load('server/agent/service/usage.mjs');
    const { createAccountConversationService } = await load('server/agent/service/conversation-policy.mjs');
    const out = {};
    try { const q = queryUsage(dir, { projectId: PROJECT, strict: true }); out.strict = { tokens: q.projects[PROJECT]?.tokens ?? 0, calls: q.projects[PROJECT]?.calls ?? 0, services: Object.keys(q.projects[PROJECT]?.services ?? {}) }; }
    catch (error) { out.strictError = errorOf(error); }
    try { const q = queryUsage(dir, { projectId: PROJECT }); out.loose = { tokens: q.projects[PROJECT]?.tokens ?? 0, calls: q.projects[PROJECT]?.calls ?? 0 }; } catch (error) { out.looseError = errorOf(error); }
    const client = Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename'].map((name) => [name, async () => ({ access: 'rw' })]));
    const service = createAccountConversationService({ usageDir: dir, conversationClient: client });
    try { const u = await service.usage({ accountMode: true, accountId: 'acct-a', projectId: PROJECT, delegation: 'ticket' }); out.member = { tokens: u.project.tokens, calls: u.project.calls, services: u.services.map((row) => `${row.service}:${row.calls}`) }; }
    catch (error) { out.memberError = errorOf(error); }
    return out;
  },

  /** 任务进程:照产品起浏览器时的样子建一个对话的浏览器目录,里面有浏览器自己建的、只有属主进得去的子目录 */
  async browserSeed({ shared, conversations }) {
    const { hostedBrowserDir } = await load('server/agent/service/hosted-browser.mjs');
    const out = {};
    for (const conversationId of conversations) {
      const dir = hostedBrowserDir(shared, { projectId: PROJECT, conversationId });
      // 产品的写法(`server/web/hosted/session.mjs`):不指定权限,由 umask 0007 和上级目录的 setgid 定
      fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.tmp'), { recursive: true });
      // 浏览器自己建的:建的时候就给 0700 的目录、0600 的文件(umask 0007 动不了这两个数)。用户数据目录下一个,浏览器的 HOME 下一个
      for (const sub of [path.join('profile', 'Default'), path.join('.config', 'chromium')]) {
        fs.mkdirSync(path.dirname(path.join(dir, sub)), { recursive: true });
        fs.mkdirSync(path.join(dir, sub), { mode: 0o700 });
        fs.writeFileSync(path.join(dir, sub, 'Cookies'), 'login-state', { mode: 0o600 });
      }
      fs.writeFileSync(path.join(dir, 'rev'), '7');
      out[conversationId] = { dir, stat: modeOf(dir), inner: modeOf(path.join(dir, 'profile', 'Default')), names: listing(dir) };
    }
    return out;
  },
  /** 主服务:留记号(产品的 `writeBrowserPurgeMark`,主服务的 `purgeBrowser` 用的就是它) */
  async markWrite({ dir, reason }) {
    const { writeBrowserPurgeMark, BROWSER_PURGE_MARK } = await load('server/agent/service/account-tools.mjs');
    try { writeBrowserPurgeMark(dir, reason, Date.now()); } catch (error) { return { error: errorOf(error) }; }
    return { mark: modeOf(path.join(dir, BROWSER_PURGE_MARK)), names: listing(dir) };
  },
  /** 主服务:照修之前的写法留记号(0600)——用来验「读不到的记号不当成没有记号」 */
  async markWriteOld({ dir, reason }) {
    const { BROWSER_PURGE_MARK } = await load('server/agent/service/account-tools.mjs');
    const file = path.join(dir, BROWSER_PURGE_MARK);
    fs.writeFileSync(file, JSON.stringify({ reason, at: Date.now() }), { mode: 0o600 }); fs.chmodSync(file, 0o600);
    return { mark: modeOf(file) };
  },
  /** 任务进程:读记号 */
  async markRead({ dir }) {
    const { readBrowserPurgeMarkIn } = await load('server/agent/service/account-tools.mjs');
    return { mark: readBrowserPurgeMarkIn(dir) };
  },
  /** 谁都可以调:照记号清(产品的 `removeMarkedBrowserData`)。主服务调的是「顺手删一次」,任务进程调的是真的清 */
  async purge({ dir, all = false, timeoutMs = 2_000 }) {
    const { removeMarkedBrowserData, BROWSER_PURGE_MARK } = await load('server/agent/service/account-tools.mjs');
    const { reapOrphan } = await load('server/web/hosted/session.mjs');
    let reaped = null;
    try { reaped = await reapOrphan(dir, { respectLiveOwner: true, timeoutMs: 500 }); } catch (error) { reaped = { error: errorOf(error) }; }
    let removed = null, failure = null;
    try { removed = await removeMarkedBrowserData(dir, { all, timeoutMs }); } catch (error) { failure = errorOf(error); }
    return { removed, failure, reaped, left: listing(dir), markThere: fs.existsSync(path.join(dir, BROWSER_PURGE_MARK)), innerLeft: listing(path.join(dir, 'profile')) };
  },
  /** 任务进程:照产品的写法建一个对话的目录(`account-runner.mjs`:0700;里面 `tools/` 下是作业账本),再加它的浏览器目录 */
  async conversationSeed({ shared, conversations }) {
    const out = {};
    for (const conversationId of conversations) {
      const conversation = path.join(shared, 'tenants', PROJECT, 'conversations', conversationId);
      fs.mkdirSync(conversation, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(conversation, 'tools'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(conversation, 'history.json'), '[]', { mode: 0o600 });
      fs.writeFileSync(path.join(conversation, 'tools', 'tool-jobs.db'), 'ledger', { mode: 0o600 });
      // 工作目录(附件、工具下载的文件):产品不指定权限,由 umask 0007 和上级目录的 setgid 定——主服务也往这里存附件,所以它删得动
      const work = path.join(shared, 'work', PROJECT, 'ownerkey00000001', conversationId, 'attachments');
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(work, 'a.txt'), 'attachment');
      out[conversationId] = { conversation, stat: modeOf(conversation), work: path.dirname(work) };
    }
    return { ...out, browsers: await STEPS.browserSeed({ shared, conversations }) };
  },
  /** 主服务:对话被删时做的那两步——记进待清的单子,再尽力删一次(产品的 `queueConversationPurge`、`purgeConversationData`) */
  async conversationDeletedByMaster({ shared, conversationId }) {
    const { queueConversationPurge, purgeConversationData, listConversationPurges, CONVERSATION_PURGE_DIR } = await load('server/agent/service/account-tools.mjs');
    const scope = { projectId: PROJECT, conversationId };
    let queued = false, queueError = null, attempt = null;
    try { queueConversationPurge(shared, scope, Date.now()); queued = true; } catch (error) { queueError = errorOf(error); }
    try { attempt = await purgeConversationData(shared, scope, { timeoutMs: 500 }); } catch (error) { attempt = { error: errorOf(error) }; }
    const dir = path.join(shared, CONVERSATION_PURGE_DIR);
    const entry = (listing(dir) ?? []).filter((name) => typeof name === 'string' && name.endsWith('.json'))[0];
    return { queued, queueError, attempt, dir: modeOf(dir), entry: entry ? modeOf(path.join(dir, entry)) : null, list: listConversationPurges(shared) };
  },
  /** 任务进程:读单子、照单子清一个对话 */
  async conversationPurgeByTask({ shared, conversationId }) {
    const { purgeConversationData, listConversationPurges } = await load('server/agent/service/account-tools.mjs');
    const { hostedBrowserDir } = await load('server/agent/service/hosted-browser.mjs');
    const before = listConversationPurges(shared);
    // 任务用户一侧清完留回执(`receipt: true`,任务进程开工时照单子清就是这样调的)
    const { conversationPurgeState } = await load('server/agent/service/conversation-purge.mjs');
    const out = await purgeConversationData(shared, { projectId: PROJECT, conversationId }, { receipt: true });
    return { before, out, state: conversationPurgeState(shared, { projectId: PROJECT, conversationId }), work: listing(path.join(shared, 'work', PROJECT, 'ownerkey00000001', conversationId)), browser: listing(hostedBrowserDir(shared, { projectId: PROJECT, conversationId })),
      conversation: listing(path.join(shared, 'tenants', PROJECT, 'conversations', conversationId)), after: listConversationPurges(shared) };
  },
  /**
   * 主服务:删对话的整套,用产品自己的两层——`conversation-policy.mjs` 的 `remove` / `reconcilePurges` 和 `conversation-purge.mjs` 的清理器。
   * 文档服务用替身:`unpurged` 是墓碑上「Agent 一侧还没确认清理」的那几个(每一步是一个新的子进程,所以由参数带进来、结果带回去)。
   * `phase: 'delete'` 发一次删除;`'reconcile'` 是每 60 秒那一趟对账。
   */
  async deleteFlowByMaster({ shared, conversationId, phase, unpurged = [] }) {
    const { createConversationPurger, conversationPurgeState } = await load('server/agent/service/conversation-purge.mjs');
    const { createAccountConversationService } = await load('server/agent/service/conversation-policy.mjs');
    const { listConversationPurges } = await load('server/agent/service/account-tools.mjs');
    const pendingAcks = new Set(unpurged), acks = [], ownStore = [], log = [];
    const client = { ...Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename'].map((name) => [name, async () => ({ access: 'rw' })])),
      remove: async (input) => { pendingAcks.add(input.conversationId); return { removed: [input.conversationId] }; },
      purges: async () => [...pendingAcks].map((id) => ({ projectId: PROJECT, conversationId: id })),
      purgeAck: async (input) => { acks.push(input.conversationId); pendingAcks.delete(input.conversationId); } };
    const service = createAccountConversationService({ conversationClient: client,
      purger: createConversationPurger({ sharedDataDir: shared, log: (event, fields) => log.push({ event, ...fields }),
        eventStore: { purgeConversation: async (scope) => { ownStore.push(scope.conversationId); return { rows: 1 }; } } }) });
    const out = { phase };
    try {
      if (phase === 'delete') { await service.remove({ accountMode: true, accountId: 'acct-a', projectId: PROJECT, delegation: 'ticket' }, conversationId, 'perms-delete-1'); out.deleted = true; }
      else out.reconciled = await service.reconcilePurges();
    } catch (error) { out.error = errorOf(error); }
    return { ...out, acks, ownStore, unpurged: [...pendingAcks], state: conversationPurgeState(shared, { projectId: PROJECT, conversationId }), list: listConversationPurges(shared),
      events: log.map((row) => row.event), work: listing(path.join(shared, 'work', PROJECT, 'ownerkey00000001', conversationId)) };
  },
  /** 任务进程:建一份真的工具提供者(`createAccountToolset`,依赖用替身),看它开工时照记号清自己的对话、顺手清别的对话 */
  async toolset({ shared, own, others }) {
    const { createAccountToolset } = await load('server/agent/service/account-tools.mjs');
    const { hostedBrowserDir } = await load('server/agent/service/hosted-browser.mjs');
    const context = Object.freeze({ projectId: PROJECT, conversationId: own, runId: 'r1', runGrantId: 'g1', instanceId: 'i1', instanceGeneration: 1, senderAccountId: 'acct-a', messageId: 'm1' });
    const authorize = async () => ({ allowed: true, fenceRevision: 3, grantState: 'active' });
    const log = [];
    const toolset = await createAccountToolset({ root: REPO, dataDir: shared, context,
      resources: { authorize, register: async () => ({ signal: new AbortController().signal, closed: Promise.resolve() }), contextAccess: { authorize, fromGrant: () => context }, signalFor: () => null },
      projectAssets: { openRead: async () => { throw new Error('no-assets'); }, verifyRef: async () => false }, workspaces: { open: () => ({}) }, ownerKey: 'owner',
      egress: { admit: async () => {}, admitUrl: async () => {} }, exec: () => ({ snapshot: async () => ({ project: {}, rev: 1 }), mutate: async () => ({}) }),
      host: async () => ({ kernel: {} }), log: (event, fields) => log.push({ event, ...fields }) });
    // 顺手清别的对话那一趟不挡开工,在后面做:等它记了日志(最多半分钟)
    for (let i = 0; i < 300 && !log.some((row) => row.event === 'agent.account-tools.browser-swept'); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const closed = await toolset.close('perms-check');
    const dirOf = (conversationId) => hostedBrowserDir(shared, { projectId: PROJECT, conversationId });
    const { listConversationPurges } = await load('server/agent/service/account-tools.mjs');
    return { own: listing(dirOf(own)), others: Object.fromEntries(others.map((c) => [c, listing(dirOf(c))])), ledger: toolset.describe().ledger,
      conversations: Object.fromEntries(others.map((c) => [c, listing(path.join(shared, 'tenants', PROJECT, 'conversations', c))])), queue: listConversationPurges(shared),
      closed: { childrenClosed: closed.childrenClosed, workPending: closed.workPending },
      log: log.filter((row) => /browser-(purged|swept|purge-failed)|purge-mark-unreadable|ledger-broken/.test(row.event)) };
  },
};

async function runChild(spec) {
  // 降权的次序不能换:补充组、主组要趁还是 root 的时候设,最后才换用户号
  process.setgroups(spec.groups);
  process.setgid(spec.gid);
  process.setuid(spec.uid);
  process.umask(0o007);   // 两个单元都带 UMask=0007
  // 把事件循环拉住到这一步做完。产品里「删不掉、隔一会儿再看」之间的等待用的是**不拉住进程**的定时器
  // (`server/web/hosted/session.mjs` 的 `sleep`):主服务、任务进程自己有监听口和连接拉着,照常等得到;
  // 这里的子进程除了这一步什么都没有,不拉住的话等到一半事件循环就空了,Node 以退出码 13 退出(顶层的 await 没有结果)。
  const hold = setInterval(() => {}, 1_000);
  let out;
  try { out = { ok: true, value: await STEPS[spec.step](spec.args ?? {}) }; }
  catch (error) { out = { ok: false, error: errorOf(error), stack: String(error?.stack ?? '').slice(0, 600) }; }
  clearInterval(hold);
  process.stdout.write(`\nPERMS-CHILD ${JSON.stringify(out)}\n`);
}

/* ================= 父进程(root):搭目录、派步骤、核结果、删干净 ================= */

function unusedIds() {
  const taken = (file) => { const ids = new Set(); try { for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const id = Number(line.split(':')[2]); if (Number.isInteger(id)) ids.add(id); } } catch { /* 读不到就当没有登记的 */ } return ids; };
  const users = taken('/etc/passwd'), groups = taken('/etc/group');
  const pick = (set, from, count) => { const out = []; for (let id = from; id < 65_000 && out.length < count; id++) if (!set.has(id)) out.push(id); if (out.length < count) throw new Error('找不到没有登记的数字号'); return out; };
  const [masterUid, taskUid] = pick(users, 61_100, 2);
  const [sharedGid, taskGid] = pick(groups, 61_200, 2);
  return { masterUid, taskUid, sharedGid, taskGid };
}

async function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    console.log('这支自检只在 Linux 上、以 root 跑(要用两个数字用户号扮主服务和任务用户)。这里不是,没有跑。');
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(path.join(REPO, 'server', 'agent', 'service', 'account-tools.mjs'))) {
    console.log(`在 ${REPO} 下找不到 server/agent/service/account-tools.mjs。把这一版的检出放到节点上(只要 server/ 和本文件),或用 --repo 指过去。`);
    process.exitCode = 2;
    return;
  }
  const keep = argv.includes('--keep');
  const ids = unusedIds();
  const base = fs.mkdtempSync(path.join(path.resolve(flag('--tmp') ?? os.tmpdir()), 'pc-perms-'));
  const results = [];
  const check = (name, ok, detail = '') => { results.push(ok === true); console.log(`PERMS ${ok === true ? 'OK' : 'FAIL'} ${name}${detail ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
  /** 起一个子进程,降成 `role` 那个用户做一步 */
  const as = (role, step, args = {}) => {
    const who = role === 'master'
      // 主服务的单元:User=主服务用户、Group=共用组
      ? { uid: ids.masterUid, gid: ids.sharedGid, groups: [ids.sharedGid] }
      // 任务槽的单元:User=任务用户、Group=任务用户自己的组,共用组是它的补充组
      : { uid: ids.taskUid, gid: ids.taskGid, groups: [ids.sharedGid] };
    const spec = Buffer.from(JSON.stringify({ step, args, ...who })).toString('base64');
    const r = spawnSync(process.execPath, [SELF, '--repo', REPO, '--child', spec], { cwd: base, encoding: 'utf8', timeout: 120_000, windowsHide: true,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: path.join(base, 'agent-shared') } });
    const line = String(r.stdout ?? '').split('\n').find((row) => row.startsWith('PERMS-CHILD '));
    if (!line) return { ok: false, error: { message: `子进程没有交回结果(退出码 ${r.status},信号 ${r.signal ?? '无'}):${String(r.stderr ?? '').slice(0, 300)}` } };
    try { return JSON.parse(line.slice('PERMS-CHILD '.length)); } catch { return { ok: false, error: { message: '子进程交回的不是 JSON' } }; }
  };
  /** 步骤自己出错(模块读不到等)时记一项没过,并回 null */
  const step = (role, name, args) => { const out = as(role, name, args); if (!out.ok) { check(`[${role}] ${name} 这一步自己出错`, false, out.error); return null; } return out.value; };

  try {
    console.log(`# 临时目录 ${base};扮主服务的用户号 ${ids.masterUid}、扮任务用户的用户号 ${ids.taskUid}(主组 ${ids.taskGid})、共用组 ${ids.sharedGid};都没有登记,不建账号`);
    fs.chmodSync(base, 0o711);
    const rootOnlyFile = path.join(base, 'root-only.txt');
    fs.writeFileSync(rootOnlyFile, 'x', { mode: 0o600 });
    // 共用数据目录:属任务用户,组是共用组,chmod 2770(部署说明的原话)
    const shared = path.join(base, 'agent-shared');
    fs.mkdirSync(shared);
    fs.chownSync(shared, ids.taskUid, ids.sharedGid);
    fs.chmodSync(shared, 0o2770);

    /* ----- 零、降权真的生效(后面每一项都靠它) ----- */
    const m = step('master', 'whoami', { rootOnlyFile }), k = step('task', 'whoami', { rootOnlyFile });
    check('降权:扮主服务的子进程是那个用户号、主组是共用组、umask 0007、读不到只有 root 能读的文件',
      !!m && m.uid === ids.masterUid && m.euid === ids.masterUid && m.gid === ids.sharedGid && m.umask === '7' && m.readRootOnly === false, m);
    check('降权:扮任务用户的子进程是那个用户号、主组是它自己的组、补充组里有共用组、umask 0007、读不到只有 root 能读的文件',
      !!k && k.uid === ids.taskUid && k.euid === ids.taskUid && k.gid === ids.taskGid && k.groups.includes(ids.sharedGid) && k.umask === '7' && k.readRootOnly === false, k);

    /* ----- 一、用量流水:任务进程写,主服务读 ----- */
    const usageDir = path.join(shared, 'usage');
    const written = step('task', 'usageWrite', { dir: usageDir });
    check('用量:任务进程建的 usage/ 归共用组、组内可读可进、组外读不到;流水组内可读',
      !!written && written.dir.gid === ids.sharedGid && (parseInt(written.dir.mode, 8) & 0o057) === 0o050 && written.file.gid === ids.sharedGid && (parseInt(written.file.mode, 8) & 0o047) === 0o040, written);
    const read = step('master', 'usageRead', { dir: usageDir });
    check('用量:主服务(另一个用户)读得到任务进程记的那几行——严格档与成员查用量的接口都拿到真数(30 个 token、1 次模型调用、1 次网页操作)',
      !!read && read.strict?.tokens === 30 && read.strict.calls === 1 && read.strict.services.includes('web/chromium') && read.member?.tokens === 30 && read.member.services.includes('web:1'), read);
    // 修之前的权限(目录 0700、流水 0600):主服务读不到——必须是明确的错,不是零
    const oldDir = path.join(shared, 'usage-old');
    const old = step('task', 'usageWriteOld', { dir: oldDir });
    const blind = step('master', 'usageRead', { dir: oldDir });
    check('用量:流水在但主服务读不到(修之前的 0700 / 0600)时,严格档抛 usage-unreadable(EACCES),成员查用量得到 503 usage-unavailable,不是 200 加全零',
      !!old && (parseInt(old.dir.mode, 8) & 0o077) === 0 && !!blind && blind.strictError?.code === 'usage-unreadable' && blind.strictError.errno === 'EACCES' && blind.memberError?.code === 'usage-unavailable' && blind.memberError.status === 503 && blind.member === undefined,
      { old, blind });
    check('用量:对照——老的宽松读法在同一个目录上确实会悄悄读成零(这就是审查指出的毛病;成员查用量已经不走它)', !!blind && blind.loose?.tokens === 0 && blind.loose.calls === 0, blind?.loose ?? blind?.looseError);
    const reopened = step('task', 'usageReopen', { dir: oldDir });
    const healed = step('master', 'usageRead', { dir: oldDir });
    check('用量:任务进程再起来时把已有的目录和流水补成组内可读,主服务随后读得到(7 个 token)',
      !!reopened && (parseInt(reopened.dir.mode, 8) & 0o050) === 0o050 && (parseInt(reopened.file.mode, 8) & 0o040) === 0o040 && healed?.strict?.tokens === 7 && healed.member?.tokens === 7, { reopened, healed });

    /* ----- 二、浏览器数据的记号:主服务写,任务进程读并照着清 ----- */
    const seeded = step('task', 'browserSeed', { shared, conversations: ['c_private', 'c_deleted', 'c_oldmark', 'c_own', 'c_swept', 'c_kept'] });
    const dirOf = (conversationId) => seeded?.[conversationId]?.dir;
    check('浏览器目录:任务进程照产品的写法建出来的对话目录归共用组、组内可写(主服务才留得下记号);里面浏览器自己建的子目录是 0700',
      !!seeded && Object.values(seeded).every((row) => row.stat.gid === ids.sharedGid && (parseInt(row.stat.mode, 8) & 0o070) === 0o070 && (parseInt(row.inner.mode, 8) & 0o777) === 0o700), seeded && seeded.c_private);
    if (seeded) {
      // 1) 记号:主服务写得进、任务进程读得到
      const marked = step('master', 'markWrite', { dir: dirOf('c_private'), reason: 'private' });
      check('记号:主服务在任务用户的对话目录里留得下记号,记号组内可读写、不留临时文件',
        !!marked && !marked.error && (parseInt(marked.mark.mode, 8) & 0o060) === 0o060 && marked.mark.uid === ids.masterUid && !marked.names.some((name) => name.includes('.tmp-')), marked);
      const seen = step('task', 'markRead', { dir: dirOf('c_private') });
      check('记号:任务进程读得到主服务留的记号(原因是 private),不是「读不到」', seen?.mark?.reason === 'private' && seen.mark.unreadable !== true, seen);
      // 2) 修之前的 0600 记号:任务进程读不到——必须当成「有记号」,不许当成没有
      const oldMark = step('master', 'markWriteOld', { dir: dirOf('c_oldmark'), reason: 'private' });
      const blindMark = step('task', 'markRead', { dir: dirOf('c_oldmark') });
      check('记号:主服务按修之前的 0600 写的记号,任务进程读不到——照「有记号、要清」办(EACCES),不吞成没有记号',
        !!oldMark && blindMark?.mark?.unreadable === true && blindMark.mark.code === 'EACCES' && blindMark.mark.reason === 'private', { oldMark, blindMark });
      const cleanedOld = step('task', 'purge', { dir: dirOf('c_oldmark') });
      check('记号:读不到的那个记号,任务进程照样清得掉(目录里只剩清单版本的计数,记号也撤了)', cleanedOld?.removed === true && JSON.stringify(cleanedOld.left) === '["rev"]', cleanedOld);
      // 3) 谁删得动:主服务直接删——浏览器建的 0700 子目录它进不去
      const byMaster = step('master', 'purge', { dir: dirOf('c_private'), timeoutMs: 500 });
      check('谁来删:主服务直接删,删不动浏览器建的 0700 子目录(预期如此;所以主服务直接删只当尽力而为)', byMaster?.removed === false && Array.isArray(byMaster.left) && byMaster.left.includes('profile'), byMaster);
      check('谁来删:主服务没删干净时记号还在(留给任务用户那一侧接着清),没有出现「数据还在、记号没了」', byMaster?.markThere === true, byMaster && { left: byMaster.left, markThere: byMaster.markThere });
      const byTask = step('task', 'purge', { dir: dirOf('c_private') });
      check('谁来删:任务进程照记号清——删得动,对话转私有的只剩清单版本的计数,记号也撤了', byTask?.removed === true && JSON.stringify(byTask.left) === '["rev"]' && byTask.markThere === false, byTask);
      // 4) 对话被删:全删
      step('master', 'markWrite', { dir: dirOf('c_deleted'), reason: 'conversation-deleted' });
      const delMaster = step('master', 'purge', { dir: dirOf('c_deleted'), all: true, timeoutMs: 500 });
      const delTask = step('task', 'purge', { dir: dirOf('c_deleted'), all: true });
      check('对话被删:主服务删不干净、记号还在;任务进程照记号把整个目录删掉', delMaster?.removed === false && delMaster.markThere === true && delTask?.removed === true && delTask.left === null, { delMaster: delMaster && { removed: delMaster.removed, left: delMaster.left }, delTask });
      // 4b) 删对话的整套:对话目录(0700,里面有作业账本)和浏览器目录都是任务用户的。主服务记进待清的单子、自己删不动;任务用户一侧照单子清
      const convs = step('task', 'conversationSeed', { shared, conversations: ['c_gone', 'c_gone2', 'c_history'] });
      const byMasterDel = step('master', 'conversationDeletedByMaster', { shared, conversationId: 'c_gone' });
      check('删对话:主服务把它记进待清的单子(条目组内可读写),自己删不动任务用户的对话目录和浏览器目录——如实回「没清掉」,不装作清了',
        !!convs && !!byMasterDel && byMasterDel.queued === true && (parseInt(byMasterDel.entry?.mode ?? '0', 8) & 0o060) === 0o060 && byMasterDel.attempt?.removed === false &&
        byMasterDel.list.some((row) => row.conversationId === 'c_gone'), byMasterDel);
      const byTaskDel = step('task', 'conversationPurgeByTask', { shared, conversationId: 'c_gone' });
      check('删对话:任务进程读得到单子,照单子把这个对话的浏览器目录、对话目录(连同作业账本)全删掉,并从单子上划掉',
        !!byTaskDel && byTaskDel.before.some((row) => row.conversationId === 'c_gone') && byTaskDel.out.removed === true && byTaskDel.browser === null && byTaskDel.conversation === null &&
        !byTaskDel.after.some((row) => row.conversationId === 'c_gone'), byTaskDel);
      step('master', 'conversationDeletedByMaster', { shared, conversationId: 'c_gone2' });
      // 4c) 删对话的整套(产品自己的两层:对话策略加清理器),在两个用户下:这次删除办得完;主服务清自己的库、其余记进单子;
      //     任务用户一侧清完留回执,对账看到回执那一轮才向文档服务回执
      const flowDelete = step('master', 'deleteFlowByMaster', { shared, conversationId: 'c_history', phase: 'delete' });
      check('删对话(整套):主服务删不动任务用户的对话目录和浏览器目录,这次删除照样办完(不回 503);自己的库当场清了、自己删得动的工作目录删了,其余记进单子并如实记下「留给任务用户一侧」,不回执',
        !!flowDelete && flowDelete.deleted === true && !flowDelete.error && JSON.stringify(flowDelete.ownStore) === '["c_history"]' && flowDelete.work === null && flowDelete.state === 'queued' &&
        flowDelete.events.includes('agent.conversation.purge-deferred') && !flowDelete.events.includes('agent.conversation.purged') && flowDelete.acks.length === 0 && flowDelete.unpurged.includes('c_history'), flowDelete);
      const flowWait = step('master', 'deleteFlowByMaster', { shared, conversationId: 'c_history', phase: 'reconcile', unpurged: ['c_history'] });
      check('删对话(整套):任务用户一侧还没清时对账来问——不报错、不回执,单子上那一条还在', !!flowWait && !flowWait.error && flowWait.reconciled === 0 && flowWait.acks.length === 0 && flowWait.state === 'queued', flowWait);
      const flowTask = step('task', 'conversationPurgeByTask', { shared, conversationId: 'c_history' });
      check('删对话(整套):任务用户一侧照单子清完(对话目录连同作业账本、浏览器目录都没了),单子上那一条换成回执',
        !!flowTask && flowTask.out.removed === true && flowTask.browser === null && flowTask.conversation === null && flowTask.state === 'done', flowTask);
      const flowAck = step('master', 'deleteFlowByMaster', { shared, conversationId: 'c_history', phase: 'reconcile', unpurged: ['c_history'] });
      check('删对话(整套):对账看到回执的这一轮才向文档服务回执;回执用过撤掉,单子空了',
        !!flowAck && !flowAck.error && flowAck.reconciled === 1 && JSON.stringify(flowAck.acks) === '["c_history"]' && flowAck.unpurged.length === 0 && flowAck.state === 'none', flowAck);
      // 5) 真的工具提供者(任务进程里跑的那一份):开工时自己的对话照记号清,别的对话留着记号的顺手清,没记号的不动;单子上被删的对话也清
      step('master', 'markWrite', { dir: dirOf('c_own'), reason: 'private' });
      step('master', 'markWrite', { dir: dirOf('c_swept'), reason: 'conversation-deleted' });
      const tool = step('task', 'toolset', { shared, own: 'c_own', others: ['c_swept', 'c_kept', 'c_gone2'] });
      check('任务进程里真的工具提供者:单子上被删的对话(它自己再也没有任务)也被顺手清掉——浏览器目录、对话目录都没了,单子空了',
        !!tool && tool.others.c_gone2 === null && tool.conversations.c_gone2 === null && tool.queue.length === 0, tool && { browser: tool.others.c_gone2, conversation: tool.conversations.c_gone2, queue: tool.queue, log: tool.log });
      check('任务进程里真的工具提供者:开工前把自己这个对话照记号清了(只剩清单版本的计数)', !!tool && JSON.stringify(tool.own) === '["rev"]' && tool.closed.childrenClosed === true, tool && { own: tool.own, closed: tool.closed, ledger: tool.ledger });
      check('任务进程里真的工具提供者:别的对话留着「对话被删」记号的顺手清掉(整个目录没了);没有记号的对话不动',
        !!tool && tool.others.c_swept === null && Array.isArray(tool.others.c_kept) && tool.others.c_kept.includes('profile'), tool && { others: tool.others, log: tool.log });
    }
  } catch (error) {
    check('自检自己出错', false, String(error?.stack ?? error).slice(0, 600));
  } finally {
    if (keep) console.log(`# --keep:临时目录留在 ${base}`);
    else {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 下面核 */ }
      check('收尾:临时目录删干净了', !fs.existsSync(base), base);
    }
  }
  const passed = results.filter(Boolean).length;
  process.exitCode = passed === results.length ? 0 : 1;
  console.log(passed === results.length ? `PASS ${passed}/${results.length}` : `FAIL ${results.length - passed}/${results.length}`);
}

const childSpec = flag('--child');
if (childSpec) await runChild(JSON.parse(Buffer.from(childSpec, 'base64').toString('utf8')));
else await main();
