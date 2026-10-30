import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hostedBrowserDir } from './hosted-browser.mjs';
import { reapOrphan, removeDirFully } from '../../web/hosted/session.mjs';

/**
 * 云端对话被删以后，Agent 服务一侧还留着这个对话文字的地方，清干净(2026-10-13 用户定：清干净)。
 *
 * 清哪些(都按「项目 × 对话」)：
 *   事件库   run_events、accepted_messages(已接受消息的原文)、conversation_heads、run_bindings、任务进程交上来的来源包
 *   已读意向 read_intents(含提示词原文)
 *   对话目录 <共用数据目录>/tenants/<项目>/conversations/<对话>(模型历史 history.json，`tools/` 下的作业账本、追踪结果、委托记录)
 *   工作目录 <共用数据目录>/work/<项目>/<主人键>/<对话>(含用户上传的附件、工具下载的文件)
 *   云端浏览器 <共用数据目录>/web/<项目>/<对话>(用户数据目录等)
 * 清不到的(各代任务进程自己的本机状态、用量流水里的号)见 docs/reports/AGENT-v18-chats.md「删干净那张表」。
 *
 * **谁清哪一部分**(0.7.18 接线复审之后改定)。生产上主服务和任务进程是两个系统用户、同在一个共用组里：
 *   - 事件库、已读意向是调用方自己的库：当场清，清失败就抛错(页面得到 503，重试会再清一遍)。
 *   - 共用数据目录里的那三处目录是**任务用户的文件**(对话目录是 0700，主服务连 `tenants/` 都进不去；浏览器在用户数据目录下建的子目录
 *     只有属主进得去)。主服务把这个对话记进「待清的单子」(`<共用数据目录>/conversation-purges/<号>.json`，组内可读写)，自己尽力删一次：
 *     删得动(同一个用户的机器、旧托管档、进程内的老路)就当场清完、从单子上划掉；删不动**不算失败**——由任务用户一侧照单子清
 *     (任何一条任务的进程开工时都会清，`account-tools.mjs` 的 `sweepMarkedBrowsers`)，清完把单子上那一条换成一张回执(`<号>.done`)。
 *   - `purge()` 回的 `pending` 说的就是「还留在单子上、等任务用户一侧清」。调用方(`conversation-policy.mjs`)据此决定给不给文档服务回执：
 *     `pending` 时不回执，对账(每 60 秒)照旧再来；看到回执(`.done`)那一次才算清完、才回执。删对话这次请求本身不因此失败。
 *
 * 幂等：一遍清完再来一遍什么都不剩也不报错。
 */
const safeSeg = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) && !/^\.+$/.test(value);
const coded = (code, status = 503) => Object.assign(new Error(code), { status, code });
export const accountConversationOwnerKey = (projectId, conversationId) =>
  createHash('sha256').update(`account-v2\n${projectId}\n${conversationId}`).digest('hex').slice(0, 32);

/* ---------- 待清的单子 ---------- */

export const CONVERSATION_PURGE_DIR = 'conversation-purges';
const entryBase = (dataDir, scope) => path.join(dataDir, CONVERSATION_PURGE_DIR,
  createHash('sha256').update(`${scope.projectId}\n${scope.conversationId}`).digest('hex').slice(0, 40));
const entryFile = (dataDir, scope) => `${entryBase(dataDir, scope)}.json`;
const doneFile = (dataDir, scope) => `${entryBase(dataDir, scope)}.done`;
const checked = scope => { if (!safeSeg(scope?.projectId) || !safeSeg(scope?.conversationId)) throw coded('conversation-purge-invalid', 400); return scope; };
/** 确实不在了才算(够不到、看不见不算「不在」) */
const gone = target => { try { fs.lstatSync(target); return false; } catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'; } };

/** 把一个被删的对话记进待清的单子(主服务调)。同一个对话再记一次只是覆盖；上一次留下的回执作废 */
export function queueConversationPurge(dataDir, scope, at = Date.now()) {
  checked(scope);
  const file = entryFile(dataDir, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o770 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ projectId: scope.projectId, conversationId: scope.conversationId, at }), { mode: 0o660 });
  try { fs.chmodSync(tmp, 0o660); } catch { /* 改不了:读的一方会照「读不到」报出来 */ }
  fs.renameSync(tmp, file);
  try { fs.rmSync(doneFile(dataDir, scope), { force: true }); } catch { /* 没有回执 */ }
}

/** 待清的单子。读不到、读不懂的那几条照实回 `{ unreadable: true, code }`(不知道是哪个对话,清不了,由调用方记日志) */
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

/** 这个对话在单子上是什么状态：`queued`(还等着清)、`done`(任务用户一侧清完了，留了回执)、`none` */
export function conversationPurgeState(dataDir, scope) {
  checked(scope);
  if (!gone(entryFile(dataDir, scope))) return 'queued';
  return gone(doneFile(dataDir, scope)) ? 'none' : 'done';
}

/** 收下回执(主服务看到 `done` 以后调)：回执用过就撤掉 */
export function acknowledgeConversationPurge(dataDir, scope) {
  checked(scope);
  try { fs.rmSync(doneFile(dataDir, scope), { force: true }); } catch { /* 撤不掉:下次再收一遍,不影响 */ }
}

/**
 * 清一个被删的对话在共用数据目录里留着的三处目录(对话目录、工作目录、云端浏览器目录)。谁都可以调：
 * 删得动的那一方调是真的清；主服务在两个用户的生产上调是「顺手删一次」，删不动(回 `removed: false`)不算错。
 * 浏览器正被一个活着的任务进程用着时不动它(`held`)。全清掉了：`receipt` 为真(任务用户一侧)时把单子上那一条换成回执，
 * 否则(调用方自己就是要回执的那一方)直接从单子上划掉。
 * @returns {Promise<{ removed: boolean, held: boolean, history: boolean, workspace: boolean, browser: boolean }>} 后三个是「清之前在不在」
 */
export async function purgeConversationData(dataDir, scope, { timeoutMs = 8_000, receipt = false } = {}) {
  checked(scope);
  const out = { removed: false, held: false, history: false, workspace: false, browser: false };
  const targets = [];
  const drop = async target => { if (gone(target)) return false; targets.push(target); try { await removeDirFully(target, { timeoutMs }); } catch { /* 下面按「还在」办 */ } return true; };
  let browser = null;
  try { browser = hostedBrowserDir(dataDir, scope); } catch { browser = null; }
  if (browser && !gone(browser)) {
    out.browser = true; targets.push(browser);
    try {
      const reaped = await reapOrphan(browser, { timeoutMs, respectLiveOwner: true });
      out.held = reaped.liveOwner === true || reaped.stillHeld === true;
      if (!out.held) await removeDirFully(browser, { timeoutMs });
    } catch { /* 下面按「还在」办 */ }
  }
  out.history = await drop(path.join(dataDir, 'tenants', scope.projectId, 'conversations', scope.conversationId));
  const work = path.join(dataDir, 'work', scope.projectId);
  let owners = [];
  try { owners = fs.readdirSync(work); } catch (error) { if (error?.code !== 'ENOENT') targets.push(work); /* 列不了:不知道里面还有没有,按「还在」办 */ }
  for (const owner of owners) if (await drop(path.join(work, owner, scope.conversationId))) out.workspace = true;
  out.removed = targets.every(gone);
  if (out.removed) {
    try {
      if (receipt && !gone(entryFile(dataDir, scope))) fs.renameSync(entryFile(dataDir, scope), doneFile(dataDir, scope));
      else fs.rmSync(entryFile(dataDir, scope), { force: true });
    } catch { /* 划不掉:下次再来一遍,什么都不剩也不报错 */ }
  }
  return out;
}

export function createConversationPurger({ eventStore = null, readIntents = null, sharedDataDir = null, log = () => {}, now = Date.now,
  /** 这一方尽力删时每一处最多等多久。删不动(没有权限)多等也没用；一时删不掉(句柄还没放)的留在单子上，下一轮对账再删 */
  timeoutMs = 400 } = {}) {
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志不影响清理 */ } };
  return {
    /**
     * @returns {Promise<{ runEvents, readIntents, history: boolean, workspace: boolean, pending: boolean }>}
     *   `pending`：共用数据目录里的那几处这一方删不动，已经记进待清的单子、等任务用户一侧清(见文件头)
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
        // 任务用户一侧已经照单子清完、留了回执：收下回执，这一次就是「清完了」(不再去够那些够不到的目录，也不重新记单子)
        const state = conversationPurgeState(sharedDataDir, scope);
        if (state === 'done') {
          acknowledgeConversationPurge(sharedDataDir, scope);
          say('agent.conversation.purged', { projectId, runEvents: out.runEvents?.rows ?? 0, readIntents: out.readIntents?.rows ?? 0, by: 'task-side' });
          return out;
        }
        // 先记进单子(哪怕这个进程下一步就没了，任务用户一侧也会清)，再尽力删一次。已经在单子上的(对账又来问)不重记
        let queued = state === 'queued', code = null;
        if (!queued) { try { queueConversationPurge(sharedDataDir, scope, now()); queued = true; } catch (error) { code = typeof error?.code === 'string' ? error.code : 'error'; } }
        let data = { removed: false, held: false, history: false, workspace: false };
        try { data = await purgeConversationData(sharedDataDir, scope, { timeoutMs }); } catch (error) { code ??= typeof error?.code === 'string' ? error.code : 'error'; }
        out.history = data.history; out.workspace = data.workspace;
        if (!data.removed) {
          // 单子都记不下、东西又还在：这才是没办成
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
