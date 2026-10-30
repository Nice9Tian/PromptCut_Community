/**
 * 没有任何成员在线时的预渲染重试(契约 `docs/plan/cloud-agent-contract.md` 第 16 节):云端 Agent 的写入落地后,
 * 由 Agent 服务以**服务身份**发布清单计划,让渲染节点把被改到的片段渲出来;保持到结果入库。
 *
 * - 发什么:与在线页面同一种清单计划(`server/render-queue/messages.mjs` 的 `clipsPlanTaskOf`,与页面那份单测对拍)。
 *   清单里只放这一轮被写到的、判重的片段(素材片段不放;轻重由写入一侧按文档服务的共享成本记录判,判轻的不进来,
 *   见 `render-clips.mjs`「只发重卡」;这里收到的已经是判过的);
 *   每个计划最多 200 个片段,多了分批。
 * - 什么时候发:每次写入落地后攒 3 秒(一连串写入合成一个计划);一轮结束时再补发一次。新计划发出后撤回这个对话
 *   上一批还没渲完的旧计划(旧版本的画面没人要了),旧计划里还没渲完的片段并进新计划。
 * - 保持到入库:按「连续多久没有进度」判——连续 10 分钟没有任何一条进度或完成就放弃并撤回;另有 12 小时的绝对上限。
 *   放弃之后由下一个进来的页面按现有规则自己发。
 * - 结果与失败都记进对话的事件记录(`render` 事件),不悄悄丢。
 * - 每个对话没渲完的清单写在它目录下的 `pending-render.json`;进程起来后按它重新发布(队列只在内存里),不需要成员在场。
 *
 * 发布通道(`publisher`)是接口位:真的那个要第三段的队列改动(服务身份能发清单计划)与乙块的服务身份,合流后接;
 * 这之前由测试替身给。不给 `publisher` 时本模块什么都不做、什么事件都不发。形状:
 *
 *   publisher.availability(projectId) → { available: boolean, enabled: boolean, streams?: boolean }  渲染节点对这个项目开没开;
 *       `streams === false`(只有知道「生成轨道流」开关的发布通道才给,账号模式)= 托管渲染节点不为这个项目产流
 *       (`docs/semantics/product/rendering.md`「谁产流与托管方开关」):不发,记 `render { state: 'off' }`
 *   publisher.codeVersion?.() → string | null                                         这份检出的代码版本
 *   publisher.open(projectId, { onProgress({ id, done?, total? }), onDone({ id }), onFail({ id, reason?, clips? }), onClose() })
 *       → { publish(task): Promise<void> | void, withdraw(id): Promise<void> | void, close(): void }
 *
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { clipsPlanTaskOf } from '../../render-queue/messages.mjs';

export const RENDER_REQUEST_DEFAULTS = Object.freeze({
  /** 写入落地后攒多久再发 */
  debounceMs: 3000,
  /** 每个计划最多多少个片段 */
  maxClipsPerPlan: 200,
  /** 连续这么久没有任何进度就放弃 */
  stallMs: 10 * 60_000,
  /**
   * 项目带着用户卡时的那个时限:这样的项目由渲染服务的隔离工作进程渲——同时只渲一个项目、冷启动约 10 秒、
   * 多个项目在等时每个最多 5 分钟一换,所以轮到它之前可以很久没有任何进度。按「前面排着五个项目」加冷启动留足
   */
  userCardStallMs: 30 * 60_000,
  /** 绝对上限 */
  maxMs: 12 * 60 * 60_000,
  /** `render progress` 事件至多多久一条 */
  progressEveryMs: 30_000,
  /** 发布通道断了之后多久重发(逐次加倍,到上限为止) */
  reopenMs: [2000, 5000, 15_000, 60_000],
});

/** 素材片段的卡片 id:它们不预渲染,不进清单 */
export const MEDIA_CARD_IDS = Object.freeze(new Set(['video', 'image', 'audio']));

export const STALL_REASON = '渲染节点 10 分钟没有进展';
/** 发布通道开不了、而且不是暂时性的(文档服务明确不给发布票据):这些原因直接记失败,不悄悄重试 */
export const PERMANENT_OPEN_REASONS = Object.freeze(new Set(['no-project', 'forbidden', 'service-disabled', 'service-revoked', 'relocated', 'not-listed', 'banned']));
/** 带用户卡的项目(隔离工作进程渲,要排队)放弃时的原因 */
export const USER_CARD_STALL_REASON = '渲染节点 30 分钟没有进展(带用户卡的项目要排队渲)';

/** 从项目里挑出这些 id 中要预渲染的片段(还在项目里、不是素材片段) */
export function renderableClips(project, clipIds) {
  const want = new Set(clipIds);
  const out = [];
  for (const tr of project?.tracks ?? []) {
    for (const c of tr?.clips ?? []) {
      if (c && want.has(c.id) && typeof c.cardId === 'string' && !MEDIA_CARD_IDS.has(c.cardId)) out.push(c.id);
    }
  }
  return out;
}

const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

/**
 * @param {object} o
 * @param {object | null} o.publisher 见文件头;null 时整个模块不做事
 * @param {ReturnType<import('./conversations.mjs').createConversationStore>} o.store
 */
export function createRenderRequests({ publisher = null, store, now = () => Date.now(), limits: limitsIn = {}, log = () => {} } = {}) {
  const limits = { ...RENDER_REQUEST_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响预渲染重试 */ } };
  /** 对话键 → 这个对话的预渲染重试状态 */
  const jobs = new Map();
  /** projectId → { handle, opening, plans: Set(planId), retry, retryTimer } */
  const channels = new Map();
  /** planId → job */
  const planOwner = new Map();
  let closed = false;

  const fileOf = (job) => {
    const dir = store.dirOf(job.projectId, job.ownerKey, job.id);
    return dir ? path.join(dir, 'pending-render.json') : null;
  };

  function persist(job) {
    const file = fileOf(job);
    if (!file) return;
    try {
      if (!job.plans.size && !job.dirty.size) { fs.rmSync(file, { force: true }); return; }
      if (!fs.existsSync(path.dirname(file))) return; // 对话已经删了
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({
        v: 1, rev: job.rev, runId: job.runId, dirty: [...job.dirty],
        plans: [...job.plans.values()].map((p) => ({ id: p.id, projectRev: p.projectRev, clips: p.clips, publishedAt: p.publishedAt })),
      }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      say('agent.render.persist-failed', { message: String(err?.message ?? err).slice(0, 120) });
    }
  }

  function jobOf(ref, create) {
    const key = `${ref.projectId}\n${ref.ownerKey}\n${ref.id}`;
    let job = jobs.get(key);
    if (!job && create) {
      job = { key, projectId: ref.projectId, ownerKey: ref.ownerKey, id: ref.id, dirty: new Set(), rev: null, runId: null, timer: null, plans: new Map(), lastReportAt: 0, publishing: Promise.resolve() };
      jobs.set(key, job);
    }
    return job ?? null;
  }

  /** 往这个对话的事件记录里记一条 `render`;对话已经删了回 false */
  function report(job, fields) {
    const conv = store.get(job.projectId, job.ownerKey, job.id);
    if (!conv) return false;
    store.emit(conv, { type: 'render', ...(job.runId ? { runId: job.runId } : {}), ...fields });
    return true;
  }

  function dropJobIfDone(job) {
    if (job.plans.size || job.dirty.size || job.timer) return;
    jobs.delete(job.key);
  }

  function closeChannelIfIdle(projectId) {
    const ch = channels.get(projectId);
    if (!ch || ch.plans.size) return;
    clearTimeout(ch.retryTimer);
    channels.delete(projectId);
    try { ch.handle?.close(); } catch { /* 已经关了 */ }
  }

  function forgetPlan(job, planId) {
    job.plans.delete(planId);
    planOwner.delete(planId);
    channels.get(job.projectId)?.plans.delete(planId);
  }

  async function withdraw(job, planId) {
    const ch = channels.get(job.projectId);
    forgetPlan(job, planId);
    try { await ch?.handle?.withdraw(planId); } catch { /* 通道断了:队列里的任务随连接清掉 */ }
  }

  function onProgress({ id, done, total } = {}) {
    const job = planOwner.get(id);
    const plan = job?.plans.get(id);
    if (!plan) return;
    plan.lastProgressAt = now();
    if (Number.isFinite(done)) plan.done = done;
    if (Number.isFinite(total)) plan.total = total;
    if (now() - job.lastReportAt < limits.progressEveryMs) return;
    job.lastReportAt = now();
    const all = [...job.plans.values()];
    report(job, { state: 'progress', clips: all.flatMap((p) => p.clips), done: all.reduce((n, p) => n + (p.done ?? 0), 0), total: all.reduce((n, p) => n + (p.total ?? p.clips.length), 0) });
  }

  function onDone({ id } = {}) {
    const job = planOwner.get(id);
    const plan = job?.plans.get(id);
    if (!plan) return;
    forgetPlan(job, id);
    job.finished.push(...plan.clips);
    if (!job.plans.size) {
      const clips = job.finished.splice(0);
      report(job, { state: 'done', clips });
      say('agent.render.done', { projectId: job.projectId, clips: clips.length });
    } else {
      job.lastReportAt = now();
      report(job, { state: 'progress', clips: plan.clips, done: job.finished.length, total: job.finished.length + [...job.plans.values()].reduce((n, p) => n + p.clips.length, 0) });
    }
    persist(job);
    closeChannelIfIdle(job.projectId);
    dropJobIfDone(job);
  }

  function onFail({ id, reason, clips } = {}) {
    const job = planOwner.get(id);
    const plan = job?.plans.get(id);
    if (!plan) return;
    forgetPlan(job, id);
    report(job, { state: 'failed', clips: Array.isArray(clips) && clips.length ? clips.map(String) : plan.clips, reason: typeof reason === 'string' && reason ? reason.slice(0, 200) : '渲染失败' });
    say('agent.render.failed', { projectId: job.projectId, clips: plan.clips.length });
    persist(job);
    closeChannelIfIdle(job.projectId);
    dropJobIfDone(job);
  }

  /** 发布通道自己断了(文档服务重启、网络):过一会儿重开,把还没渲完的计划原样重发 */
  function onChannelClose(projectId) {
    const ch = channels.get(projectId);
    if (!ch || closed) return;
    ch.handle = null;
    ch.opening = null;
    if (!ch.plans.size) { channels.delete(projectId); return; }
    const wait = limits.reopenMs[Math.min(ch.retry, limits.reopenMs.length - 1)];
    ch.retry += 1;
    clearTimeout(ch.retryTimer);
    ch.retryTimer = setTimeout(() => { void republish(projectId); }, wait);
    ch.retryTimer.unref?.();
  }

  async function channelFor(projectId) {
    let ch = channels.get(projectId);
    if (!ch) { ch = { handle: null, opening: null, plans: new Set(), retry: 0, retryTimer: null }; channels.set(projectId, ch); }
    if (ch.handle) return ch;
    ch.opening ??= Promise.resolve(publisher.open(projectId, { onProgress, onDone, onFail, onClose: () => onChannelClose(projectId) })).then(
      (handle) => { ch.handle = handle; ch.opening = null; ch.retry = 0; return ch; },
      (err) => { ch.opening = null; throw err; },
    );
    return ch.opening;
  }

  async function republish(projectId) {
    if (closed) return;
    const ch = channels.get(projectId);
    if (!ch || !ch.plans.size) return;
    try {
      const open = await channelFor(projectId);
      for (const id of [...ch.plans]) {
        const plan = planOwner.get(id)?.plans.get(id);
        if (!plan) { ch.plans.delete(id); continue; }
        await open.handle.publish(plan.task);
      }
      say('agent.render.republished', { projectId, plans: ch.plans.size });
    } catch (err) {
      say('agent.render.reopen-failed', { projectId, message: String(err?.message ?? err).slice(0, 120) });
      onChannelClose(projectId);
    }
  }

  /** 把这个对话攒着的片段发成计划 */
  function publish(job) {
    clearTimeout(job.timer);
    job.timer = null;
    job.publishing = job.publishing.then(async () => {
      if (closed || !job.dirty.size) return;
      let avail;
      try { avail = await publisher.availability(job.projectId); } catch { avail = null; }
      if (avail?.streams === false) {
        // 「生成轨道流」关着:托管渲染节点完全不为这个项目产流,发了也没人渲。如实记一条,不报「完成」
        const clips = [...job.dirty];
        job.dirty.clear();
        report(job, { state: 'off', clips });
        say('agent.render.streams-off', { projectId: job.projectId, clips: clips.length });
        persist(job);
        dropJobIfDone(job);
        return;
      }
      if (!avail?.available || !avail?.enabled) {
        const clips = [...job.dirty];
        job.dirty.clear();
        report(job, { state: 'unavailable', clips });
        say('agent.render.unavailable', { projectId: job.projectId, clips: clips.length });
        persist(job);
        dropJobIfDone(job);
        return;
      }
      // 上一批还没渲完的并进来:它们会被撤回,而那些片段在新版本上仍然要渲
      const old = [...job.plans.values()];
      const clips = [...new Set([...old.flatMap((p) => p.clips), ...job.dirty])].sort();
      const rev = job.rev;
      job.dirty.clear();
      let ch;
      try {
        ch = await channelFor(job.projectId);
      } catch (err) {
        if (PERMANENT_OPEN_REASONS.has(err?.reason)) {
          // 文档服务明确不给这个项目发预渲染计划:记失败并说原因,不无限重试
          for (const p of old) forgetPlan(job, p.id);
          report(job, { state: 'failed', clips, reason: `云端渲染服务不接这个项目的预渲染(${err.reason})` });
          say('agent.render.open-refused', { projectId: job.projectId, reason: err.reason });
          persist(job);
          closeChannelIfIdle(job.projectId);
          dropJobIfDone(job);
          return;
        }
        // 通道开不了:片段放回去,过一会儿再试(不记失败:这是暂时性的)
        for (const c of clips) job.dirty.add(c);
        say('agent.render.open-failed', { projectId: job.projectId, message: String(err?.message ?? err).slice(0, 120) });
        if (!job.timer && !closed) { job.timer = setTimeout(() => publish(job), limits.reopenMs[0]); job.timer.unref?.(); }
        persist(job);
        return;
      }
      let codeVersion = null;
      try { codeVersion = publisher.codeVersion?.() ?? null; } catch { codeVersion = null; }
      const at = now();
      const fresh = [];
      for (const part of chunk(clips, limits.maxClipsPerPlan)) {
        const task = clipsPlanTaskOf({ projectId: job.projectId, projectRev: rev, clips: part, codeVersion });
        const plan = { id: task.id, task, projectRev: rev, clips: task.input.clips, publishedAt: at, lastProgressAt: at, done: 0, total: null };
        job.plans.set(plan.id, plan);
        planOwner.set(plan.id, job);
        ch.plans.add(plan.id);
        fresh.push(plan);
      }
      persist(job);
      for (const plan of fresh) await ch.handle.publish(plan.task);
      // 新的发出去之后再撤旧的
      for (const p of old) if (!fresh.some((f) => f.id === p.id)) await withdraw(job, p.id);
      job.lastReportAt = 0;
      report(job, { state: 'published', clips, plans: fresh.length });
      persist(job);
      say('agent.render.published', { projectId: job.projectId, plans: fresh.length, clips: clips.length, rev });
    }).catch((err) => {
      say('agent.render.publish-failed', { projectId: job.projectId, message: String(err?.message ?? err).slice(0, 160) });
    });
    return job.publishing;
  }

  /** 定时看一遍:连续太久没有进度的、超过绝对上限的,放弃并撤回 */
  function watchdog() {
    const at = now();
    for (const job of [...jobs.values()]) {
      for (const plan of [...job.plans.values()]) {
        const stalled = at - plan.lastProgressAt >= (job.userCards ? limits.userCardStallMs : limits.stallMs);
        const tooLong = at - plan.publishedAt >= limits.maxMs;
        if (!stalled && !tooLong) continue;
        void withdraw(job, plan.id);
        report(job, { state: 'failed', clips: plan.clips, reason: stalled ? (job.userCards ? USER_CARD_STALL_REASON : STALL_REASON) : '渲染超过了 12 小时的上限' });
        say('agent.render.gave-up', { projectId: job.projectId, clips: plan.clips.length, why: stalled ? 'stalled' : 'max' });
        persist(job);
        closeChannelIfIdle(job.projectId);
        dropJobIfDone(job);
      }
    }
  }
  const sweep = publisher ? setInterval(watchdog, Math.max(50, Math.min(30_000, Math.floor(limits.stallMs / 4)))) : null;
  sweep?.unref?.();

  return {
    enabled: !!publisher,
    /** 写入落地后攒多久再发(写入一侧「攒一会儿再判轻重」用同一个数,`render-clips.mjs` 的 `createHeavyRenderGate`) */
    debounceMs: limits.debounceMs,

    /**
     * 一次写入落地了。`project` 是写入之后的项目内容(挑要渲的片段用),`rev` 是它的版本。
     * @param {{ projectId: string, ownerKey: string, id: string }} ref 哪个对话
     */
    noteWrite(ref, { clipIds = [], clips: given = null, rev, project, runId = null, userCards = false } = {}) {
      if (!publisher || closed) return;
      // `clips`:写入方已经按项目内容挑好的片段(账号模式:任务进程挑好、经主服务转来);否则按 `project` 挑
      const clips = Array.isArray(given) ? [...new Set(given.filter((c) => typeof c === 'string' && c))] : renderableClips(project, clipIds);
      const job = jobOf(ref, clips.length > 0);
      if (!job) return;
      // 项目带着用户卡:由隔离工作进程渲,判「没有进度」的时限放长(见 userCardStallMs)
      if (userCards) job.userCards = true;
      if (Number.isSafeInteger(rev)) job.rev = rev;
      if (runId) job.runId = runId;
      if (!clips.length) return;
      job.finished ??= [];
      for (const c of clips) job.dirty.add(c);
      clearTimeout(job.timer);
      job.timer = setTimeout(() => { void publish(job); }, limits.debounceMs);
      job.timer.unref?.();
      persist(job);
    },

    /** 一轮结束:攒着的马上发(保证最后的版本有计划) */
    flush(ref) {
      const job = jobOf(ref, false);
      if (!publisher || !job || !job.dirty.size) return Promise.resolve();
      return publish(job);
    },

    /**
     * 进程起来后调:按各对话的 `pending-render.json` 重新发布。只用服务身份,不需要成员在场。回重发的对话数。
     */
    async restore() {
      if (!publisher) return 0;
      let n = 0;
      for (const at of store.walk()) {
        let saved;
        try { saved = JSON.parse(fs.readFileSync(path.join(at.dir, 'pending-render.json'), 'utf8')); } catch { continue; }
        const clips = [...new Set([...(Array.isArray(saved?.dirty) ? saved.dirty : []), ...(Array.isArray(saved?.plans) ? saved.plans.flatMap((p) => (Array.isArray(p?.clips) ? p.clips : [])) : [])])].map(String);
        const rev = Number.isSafeInteger(saved?.rev) ? saved.rev : (saved?.plans ?? []).map((p) => p?.projectRev).filter(Number.isSafeInteger).sort((a, b) => b - a)[0];
        if (!clips.length || !Number.isSafeInteger(rev)) continue;
        const job = jobOf(at, true);
        job.finished ??= [];
        job.rev = rev;
        job.runId = typeof saved.runId === 'string' ? saved.runId : null;
        // 重启后不知道这个项目带不带用户卡:按带着的时限等(多等不会出错,少等会把排着队的计划误判成放弃)
        job.userCards = true;
        for (const c of clips) job.dirty.add(c);
        n += 1;
        await publish(job);
      }
      if (n) say('agent.render.restored', { conversations: n });
      return n;
    },

    /** 云端 Agent 的开关关了、项目删了:撤回并清掉这个项目的清单 */
    async cancelProject(projectId) {
      for (const job of [...jobs.values()]) {
        if (job.projectId !== projectId) continue;
        clearTimeout(job.timer);
        job.timer = null;
        job.dirty.clear();
        for (const id of [...job.plans.keys()]) await withdraw(job, id);
        persist(job);
        jobs.delete(job.key);
      }
      closeChannelIfIdle(projectId);
    },

    /** 一个对话被删:它的清单不再跟(已经发出去的计划照常渲完,改动在项目里,别人要看) */
    forget(ref) {
      const job = jobOf(ref, false);
      if (!job) return;
      clearTimeout(job.timer);
      for (const id of [...job.plans.keys()]) forgetPlan(job, id);
      jobs.delete(job.key);
      closeChannelIfIdle(job.projectId);
    },

    /** 诊断:不含正文 */
    describe() {
      return { jobs: [...jobs.values()].map((j) => ({ projectId: j.projectId, dirty: j.dirty.size, plans: j.plans.size })), channels: channels.size };
    },

    /** 测试:等这个对话手头的发布做完 */
    _settled(ref) {
      return jobOf(ref, false)?.publishing ?? Promise.resolve();
    },
    _watchdog: watchdog,

    /** 收尾:停表、关通道。清单留在盘上,下次起来重发 */
    close() {
      closed = true;
      if (sweep) clearInterval(sweep);
      for (const job of jobs.values()) clearTimeout(job.timer);
      for (const ch of channels.values()) {
        clearTimeout(ch.retryTimer);
        try { ch.handle?.close(); } catch { /* 已经关了 */ }
      }
      channels.clear();
    },
  };
}
