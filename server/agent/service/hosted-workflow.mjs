/**
 * 云端 Agent 的后台作业状态与一键流程(`background_job_status`、`auto_workflow`、`auto_workflow_status`;
 * 计划 `docs/plan/cloud-agent-tools-implementation.md` 的 P5 包)。
 *
 * 桌面版里这三个工具由页面执行:`src/mcp/tools/autoWorkflow.ts` 在页面里转写、配卡、铺字幕,作业放在页面的内存表里
 * (`src/mcp/common.ts` 的 `sttJobs` 等),刷新或重启就没了。云节点上没有页面,所以在 Agent 服务一侧另做一份:
 *
 *   - **作业状态**:`background_job_status` 查 F0 的作业账本(`tool-jobs.mjs`,SQLite)。转写、镜头识别、主体识别、运动追踪、
 *     各种安装、一键流程都在这一张账本里,只能查**本项目本对话**的;别的项目、别的对话的作业号和不存在的作业号回同一句「找不到」。
 *     账本里只存码,人话由各包已有的说法翻(转写用 `STT_ERROR_TEXT`;镜头、主体用它们写在工作区索引里的 `message`;
 *     追踪这类宿主可以经 `errorTexts` 注入)。重启时跑到一半的是「被中断」。
 *   - **一键流程**:分阶段串起来 —— 语音转写 → 镜头识别 → 主体识别 → 生成字幕与卡片 → 发布预渲染任务。前三个阶段**调用对应工具包的提供方**
 *     (经工厂参数 `providers` 注入的 stt / shots / subject,不重写它们的逻辑),等它们的作业在账本里走完;
 *     「生成字幕与卡片」把桌面版的配卡规则(`autoWorkflow.ts`)搬过来算出一份方案,**一次**经宿主给的 `project.applyEdits` 提交
 *     (带期望的项目版本,整份要么全进要么全不进,所以失败时项目里没有半截提交);「发布预渲染任务」经宿主注入的 `prerender` 接缝。
 *   - **失败不越过**:某一阶段失败、被取消、被中断就停在那里,后面的阶段不做,没做成的阶段不标成完成。依赖的感知能力在这台节点上没就绪
 *     (provider 没配、回 `cloudUnavailable`)时,这一阶段标「用不了」并说明,同样停在那里(宿主可经 `optionalStages` 指定哪些阶段允许没就绪时跳过,
 *     缺省只有「发布预渲染任务」可以),不起占位作业冒充完成。
 *   - **阶段状态持久**:账本记整体的状态、当前阶段、进度;各阶段的状态、对应的子作业号、原因记在这个对话工作区的 `workflow/jobs.json`。
 *     重启后 `auto_workflow_status` 说得清做到哪一阶段、哪一阶段被中断。
 *   - **控制路径**:一键流程登记成这一轮的一个运行资源(`run-resources`),这一轮被停、转私有、Agent 关闭、服务关闭时进来一个中止信号,
 *     正在跑的阶段停下、不再往下一个阶段走、不再提交;每次提交和发布前都重核写权限。底下的子进程由各包自己的登记杀。
 *
 * 本文件不引用 `src/`:配卡规则里查「卡片有哪些参数」要用前端内核的 `getCard`,由宿主经工厂参数 `kernel` 注入。
 * 不调用「派生子 Agent」(spawn_agent):云端固定不支持。
 */
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { STT_ERROR_TEXT } from './perception/stt.mjs';

export const WORKFLOW_TOOL_NAMES = Object.freeze(['background_job_status', 'auto_workflow', 'auto_workflow_status']);
export const WORKFLOW_JOB_KIND = 'workflow.auto';
export const WORKFLOW_STAGES = Object.freeze(['transcribe', 'shots', 'subjects', 'compose', 'prerender']);
export const WORKFLOW_STAGE_LABEL = Object.freeze({
  transcribe: 'Speech-to-text', shots: 'Shot detection', subjects: 'subject detection', compose: 'Generate captions and cards', prerender: 'Publish prerender job',
});

export const WORKFLOW_DEFAULTS = Object.freeze({
  /** 桌面版一键流程里同样的 12 */
  defaultMaxCards: 12,
  maxCardsCeiling: 100,
  /** `auto_workflow` 等多久还没跑完就先回 jobId(与桌面版同一个 50 秒;单次工具调用 60 秒的上限留 10 秒余量) */
  fastWaitMs: 50_000,
  /** 轮询子作业的间隔 */
  pollMs: 400,
  /** 一个阶段最长等多久(子作业自己有时限,这是防卡死的兜底) */
  stageWaitMs: 45 * 60_000,
  /** 账本进度写入的最小间隔(每次写库要过几道授权) */
  progressMs: 1_500,
  /** 同时在跑的一键流程数(进程内) */
  maxRunning: 2,
  /** 配卡方案提交时项目版本变了,重新读一遍再算的次数 */
  composeAttempts: 3,
  /** `close()` 等后台流程收尾的时限 */
  closeMs: 10_000,
  /** 工作区索引里留多少条 */
  historyJobs: 20,
  /** 允许「没就绪」时跳过(而不是停在那里)的阶段:主体识别与发布预渲染任务缺省可选 */
  optionalStages: Object.freeze(['subjects', 'prerender']),
});

/** 进度条上每个阶段占的区间(单调递增;完成时才到 1) */
const BAND = Object.freeze({
  transcribe: [0.02, 0.40], shots: [0.40, 0.55], subjects: [0.55, 0.75], compose: [0.75, 0.92], prerender: [0.92, 0.99],
});

const JOB_LABEL = Object.freeze({
  'stt.transcribe': 'Speech-to-text', 'stt.install': 'Speech-to-text engine install', 'shots.detect': 'Shot detection',
  'subject.detect': 'subject detection', 'subject.install': 'Subject detection extension install', 'track.points': 'Motion tracking',
  'track.install': 'Motion tracking extension install', [WORKFLOW_JOB_KIND]: 'one-click workflow',
});

/** 各包写的、账本里没有人话的那些码的通用说法;各包自己的说法(转写、工作区索引里的 message、宿主注入的)优先 */
export const WORKFLOW_ERROR_TEXT = Object.freeze({
  FENCE_CANCELLED: 'Permission for this chat turn was revoked (set to private, stopped, or the Agent was turned off); the job was cancelled.',
  INTERRUPTED_ON_RESTART: 'This job was running when the Agent service restarted and was interrupted; you can start it again.',
  SERVICE_CLOSING: 'This job was running when the Agent service shut down and was interrupted; you can start it again.',
  SHOTS_CANCELLED: 'Shot detection was cancelled.',
  SUBJECT_CANCELLED: 'Subject detection was cancelled.',
  WORKFLOW_CANCELLED: 'The one-click workflow was cancelled.',
  STAGE_UNAVAILABLE: 'A capability this stage depends on is not ready on this cloud node; the one-click workflow stopped here.',
  STAGE_FAILED: 'This stage did not succeed; the one-click workflow stopped here.',
  STAGE_TIMEOUT: 'This stage waited too long without a result; the one-click workflow stopped here (the background job may still be running, check with background_job_status).',
  STAGE_CANCELLED: 'The background job for this stage was cancelled; the one-click workflow stopped here.',
  STAGE_INTERRUPTED: 'The background job for this stage was interrupted; the one-click workflow stopped here.',
  EMPTY_TRANSCRIPT: 'The transcript is empty; there is no content to build cards from.',
  MEDIA_MISSING: 'The media is no longer in the project.',
  PROJECT_CHANGED: 'The project kept being modified by others in the meantime, so captions and cards were not written (no partial commit). You can call auto_workflow again.',
  COMMIT_FAILED: 'Captions and cards could not be written to the project (no partial commit).',
  PUBLISH_FAILED: 'Captions and cards were written to the project, but publishing the prerender job failed.',
});

const STATE_TEXT = Object.freeze({ queued: 'Queued', running: 'In progress', done: 'Completed', error: 'failed', cancelled: 'Cancelled', interrupted: 'Interrupted' });
const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);
const BAD_JOB = new Set(['error', 'cancelled', 'interrupted']);
const MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{8,128}$/;
const JOB_ID_RE = /^job_[0-9a-f-]{36}$/;
const OUTPUT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const INDEX_FILE = 'workflow/jobs.json';
const AUTH_UNAVAILABLE = new Set(['run-authority-unavailable', 'tool-instance-unavailable', 'fence-unavailable', 'authorization-unavailable']);
/** 这类错误说明授权/栅栏变了(不是作业自己的失败) */
const REVOKED = /^(forbidden|fence-|authorization-|run-|tool-|stale-revision|terminal-job|job-scope|authority-)/;

const sha = (text) => createHash('sha256').update(text).digest('hex');
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
  timer.unref?.();
  signal?.addEventListener('abort', onAbort, { once: true });
});

export class WorkflowToolError extends Error {
  constructor(message, { code = 'workflow-error', status = 400 } = {}) {
    super(message);
    this.name = 'WorkflowToolError';
    this.code = code;
    this.status = status;
  }
}

/* ================================================================== 配卡规则(桌面版 autoWorkflow.ts 的搬运,不引用 src/) */

function selectCard(text) {
  if (/(增长|提升|上涨|翻倍|翻了|下降|降低|减少|涨|\b(?:growth|grew|increase[sd]?|rise|rose|doubled|decline[sd]?|decrease[sd]?|drop(?:ped)?|reduce[sd]?|fell)\b)/i.test(text) && (/[0-9]+(\.[0-9]+)?\s*(%|个|倍|万|亿|次|人|分|点|(?:percent|x|times|thousand|million|billion|people|points|items)\b)/i.test(text) || /[一二三四五六七八九十百千万亿]+\s*(倍|次|个|人|万|亿|成)|\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion)\s+(times|items|people|thousand|million|billion|percent)\b/i.test(text))) return 'odometer'; // i18n-allow
  if (/[0-9]+(\.[0-9]+)?\s*(%|百分|倍|万|亿|次|个|人|(?:percent|x|times|thousand|million|billion|people|items)\b)/i.test(text)) return 'stat-proof'; // i18n-allow
  if (/(对比|相比|比起|而不是|不同于|区别|差别|\b(?:vs|versus|compared|compare|comparison|rather than|instead of|unlike|difference)\b)/i.test(text)) return 'versus-card'; // i18n-allow
  if (/(第一|第二|第三|首先|其次|然后|接着|最后|步骤|流程|第一步|\b(?:first|second|third|firstly|secondly|then|next|finally|step|process)\b)/i.test(text)) return 'step-timeline'; // i18n-allow
  if (/(要点|清单|包括|分别是|三点|几点|需要|必须|\b(?:key points|checklist|includes|namely|three points|several points|need|must)\b)/i.test(text)) return 'checklist'; // i18n-allow
  if (/[「」『』“”"]/.test(text)) return 'quote-lockup'; // i18n-allow
  if (/(记住|关键在于|本质上|一句话|核心是|重点是|\b(?:remember|the key is|essentially|in a word|the core is|the point is)\b)/i.test(text)) return 'blur-text'; // i18n-allow
  if (text.length <= 14 && /[!！]$/.test(text)) return 'punch-pill'; // i18n-allow
  if (/(所谓|叫做|叫作|定义|是指|指的是|术语|概念|\b(?:so-called|called|defined as|refers to|means|term|concept)\b)/i.test(text)) return 'term-card'; // i18n-allow
  return null;
}

function paramsFor(cardId, rawText, getCard) {
  const text = rawText.trim();
  const short = text.slice(0, 24);
  const snippet = text.slice(0, 40);
  const def = getCard(cardId);
  if (!def) return {};
  const p = {};
  const extractNum = (str) => {
    const m = str.match(/\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 100;
  };
  if (cardId === 'odometer') {
    p.unit = '';
    p.label = snippet;
    p.value = extractNum(text);
    p.kicker = 'DATA';
  } else if (cardId === 'stat-proof') {
    p.value = extractNum(text);
    const suffixMatch = text.match(/\d+(\.\d+)?([%倍万亿次]|(?:x|k|m|bn)\b)/i); // i18n-allow
    p.suffix = suffixMatch ? suffixMatch[2] : '';
    p.prefix = '';
    p.kickerZh = short;
    p.footZh = snippet;
    p.kicker = 'DATA';
  } else if (cardId === 'versus-card') {
    p.aTitle = 'A';
    p.bTitle = 'B';
    const mid = Math.floor(snippet.length / 2);
    if (mid > 0) {
      p.aSub = snippet.slice(0, mid);
      p.bSub = snippet.slice(mid);
    } else {
      p.aSub = snippet;
      p.bSub = snippet;
    }
  } else if (cardId === 'step-timeline' || cardId === 'checklist') {
    const parts = text.split(/[，。、,]/).map((x) => x.trim()).filter(Boolean); // i18n-allow
    const items = parts.map((x) => x.slice(0, 8)).slice(0, cardId === 'checklist' ? 4 : 5);
    if (cardId === 'step-timeline') p.steps = items.length >= 2 ? items.join('|') : snippet;
    else p.items = items.length >= 2 ? items.join('|') : snippet;
  } else if (cardId === 'quote-lockup') {
    p.quote = snippet.replace(/(.{12})/g, '$1|').replace(/\|$/, '');
    p.author = '';
  } else if (cardId === 'blur-text') {
    p.text = snippet.replace(/(.{10})/g, '$1|').replace(/\|$/, '');
  } else if (cardId === 'punch-pill') {
    p.text = short;
  } else if (cardId === 'term-card') {
    p.term = short;
    p.def = snippet;
    p.en = '';
  }
  const filtered = {};
  for (const key of Object.keys(p)) {
    if (def.controls.some((c) => c.key === key)) filtered[key] = p[key];
  }
  return filtered;
}

/**
 * 按文字稿和素材在时间轴上的位置,算出要放的卡和字幕(不碰项目)。与桌面版 `autoWorkflow.ts` 的 pipeline 第 3～7 步逐条相同:
 * 取时间轴上第一条用到这份素材的片段做映射;5～15 秒一组(满 15 秒必断;满 5 秒后遇句末标点、停顿 0.6 秒以上或再加一段会超 15 秒就断);
 * 太短的尾巴并进上一组;每组按关键词选一张卡(选不出的不放),最多 `maxCards` 张;整条文字稿一张 caption-track。
 * @param {{ transcript: { segments: Array<{start:number,end:number,text:string}> }, mediaId: string,
 *   tracks?: Array<{ clips?: Array<{ mediaId?: string, start: number, end: number, mediaOffset?: number, speed?: number }> }>,
 *   maxCards?: number, getCard: (id: string) => ({ controls: Array<{ key: string }> } | undefined) }} input
 */
export function planAutoWorkflowEdits({ transcript, mediaId, tracks = [], maxCards = WORKFLOW_DEFAULTS.defaultMaxCards, getCard }) {
  let clipStart = 0;
  let mediaOffset = 0;
  let clipEnd = Infinity;
  let speed;
  for (const track of tracks) {
    const clip = (track?.clips ?? []).find((c) => c.mediaId === mediaId);
    if (clip) {
      clipStart = clip.start;
      mediaOffset = clip.mediaOffset ?? 0;
      clipEnd = clip.end;
      speed = clip.speed;
      break;
    }
  }
  // 素材秒 → 时间轴秒,含片段速度。与 `src/kernel/clipTime.mjs` 的 timelineTimeAt 同一个式子(Agent 服务进程这一侧不 import src/,
  // 照抄;不是有限正数的速度按 1,缺省 1 时 ÷ 1 逐位不变),与桌面版 autoWorkflow.ts 相同
  const rate = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 1;
  const toTl = (s) => clipStart + (s - mediaOffset) / rate;
  const mappedSegments = [];
  for (const seg of transcript.segments) {
    const tlStart = toTl(seg.start);
    const tlEnd = toTl(seg.end);
    if (tlEnd > clipStart && tlStart < clipEnd) {
      mappedSegments.push({
        start: Math.max(clipStart, Math.min(tlStart, clipEnd)),
        end: Math.max(clipStart, Math.min(tlEnd, clipEnd)),
        text: seg.text,
      });
    }
  }

  const groups = [];
  let currentGroup = [];
  for (let i = 0; i < mappedSegments.length; i++) {
    const seg = mappedSegments[i];
    currentGroup.push(seg);
    const groupDuration = currentGroup[currentGroup.length - 1].end - currentGroup[0].start;
    let shouldBreak = false;
    if (groupDuration >= 15) {
      shouldBreak = true;
    } else if (groupDuration >= 5) {
      const lastChar = seg.text.trim().slice(-1);
      const isPunctuation = /[。？！；.?!]/.test(lastChar); // i18n-allow
      const nextSeg = mappedSegments[i + 1];
      const gap = nextSeg ? (nextSeg.start - seg.end) : 0;
      const willExceed = nextSeg ? (nextSeg.end - currentGroup[0].start > 15) : false;
      if (isPunctuation || gap >= 0.6 || willExceed) shouldBreak = true;
    }
    if (shouldBreak || i === mappedSegments.length - 1) {
      groups.push({
        start: currentGroup[0].start,
        end: currentGroup[currentGroup.length - 1].end,
        text: currentGroup.map((s) => s.text.trim()).join(''),
      });
      currentGroup = [];
    }
  }
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    if (last.end - last.start < 5) {
      const prev = groups[groups.length - 2];
      if (last.end - prev.start <= 18) {
        prev.end = last.end;
        prev.text += last.text;
        groups.pop();
      }
    }
  }

  const selected = [];
  for (const g of groups) {
    const cardId = selectCard(g.text);
    if (cardId) selected.push({ group: g, cardId });
  }
  const toPlace = selected.slice(0, maxCards);
  const cards = toPlace.map(({ group, cardId }) => ({
    cardId,
    start: group.start,
    duration: group.end - group.start,
    params: paramsFor(cardId, group.text, getCard),
    text: group.text.slice(0, 40),
  }));

  let caption = null;
  if (mappedSegments.length > 0) {
    const globalStart = mappedSegments.reduce((m, s) => Math.min(m, s.start), Infinity);
    const globalEnd = mappedSegments.reduce((m, s) => Math.max(m, s.end), -Infinity);
    const lines = mappedSegments.map((seg) => {
      const rStart = (seg.start - globalStart).toFixed(2);
      const rEnd = (seg.end - globalStart).toFixed(2);
      const cleanedText = seg.text.trim().replace(/[\n|]/g, ' ');
      return `${rStart}|${rEnd}|${cleanedText}|`;
    }).join('\n');
    caption = { start: globalStart, duration: globalEnd - globalStart, params: { lines, showEn: 'false' } };
  }
  return { segments: mappedSegments.length, groups: groups.length, cards, caption, skippedByPlan: groups.length - toPlace.length };
}

/* ================================================================== 提供方 */

/**
 * @param {object} d
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<object>, register(context: object, o: { kind: string, resource: object }): Promise<{ signal: AbortSignal, closed: Promise<void> }> }} d.resources
 *   F0 的运行资源登记器(`createRunResources`)
 * @param {{ start: Function, update: Function, get: Function, checkpointRetained: Function }} d.jobs F0 的 `createToolJobs`
 * @param {(context: object) => object | Promise<object>} d.workspace 这个对话的工作区(`workspace.mjs` 的 `open()`)
 * @param {{ stt?: object|null, shots?: object|null, subject?: object|null }} d.providers 三个感知工具包的提供方
 *   (`createSttTools` / `createShotsTools` / `createSubjectTools` 的返回值:`call(name, args, context, { requestId })`,可选 `cancel(context, jobId)`);
 *   没有就是 null:这台节点没接上这个能力,对应阶段标「用不了」
 * @param {object} d.project 项目一侧的窄接口(G 包接到文档服务的版本预期与操作栅栏):
 *   `getMedia(context, mediaId)` -> 素材记录(要有 `id, name, kind, transcript, shots, subjects`)或 null(与三个感知包用的是同一个);
 *   `getTimeline(context)` -> `{ projectRev, tracks: [{ clips: [{ mediaId, start, end, mediaOffset, speed? }] }] }`;
 *   `applyEdits(context, { jobId, mediaId, commitKey, expectedProjectRev, fenceRevision, cards, caption })`
 *     -> `{ projectRev, clips: Array<{ clipId, start, end } | null>(与 cards 同序,放不下的是 null), captionClipId: string | null, alreadyApplied?: true }`;
 *     在一次 mutate 里做完(整份全进或全不进);版本对不上抛带 `code: 'project-changed'` 的错;`commitKey` 相同且这些片段还在项目里就回 `alreadyApplied`,不重复放;
 *     放完后项目时长要撑到最晚的片段结尾(桌面版同样的收尾)
 * @param {{ publish(context: object, input: { jobId: string, mediaId: string, projectRev: any, clipIds: string[], fenceRevision: number }): Promise<{ published: boolean, reason?: string, planned?: number }> } | null} [d.prerender]
 *   发布预渲染任务的接缝(宿主接到云端 Agent 服务的预渲染发布 `render-request.mjs`);没给就是 null:这个阶段标「用不了」
 * @param {{ getCard: (id: string) => object | undefined }} d.kernel 宿主经 ssr-host 载入缝取来注入(必需)
 * @param {Record<string, Record<string, string>>} [d.errorTexts] 作业种类前缀 → (错误码 → 人话),如 `{ 'track.': { TRACK_TIMEOUT: '…' } }`
 * @param {object} [d.limits] 覆盖 `WORKFLOW_DEFAULTS`
 */
export function createWorkflowTools({
  resources, jobs, workspace, providers = {}, project, prerender = null, kernel = null, errorTexts = {},
  limits: limitsIn = {}, now = Date.now, log = () => {},
} = {}) {
  const miss = (name) => new WorkflowToolError(`The one-click workflow is not fully configured (missing ${name}).`, { code: 'workflow-unconfigured', status: 503 });
  if (typeof resources?.authorize !== 'function' || typeof resources?.register !== 'function') throw miss('run resource registrar');
  if (!['start', 'update', 'get', 'checkpointRetained'].every((k) => typeof jobs?.[k] === 'function')) throw miss('job table');
  if (typeof workspace !== 'function') throw miss('workspace');
  if (!['getMedia', 'getTimeline', 'applyEdits'].every((k) => typeof project?.[k] === 'function')) throw miss('project interface');
  if (typeof kernel?.getCard !== 'function') throw miss('kernel function getCard (the host must fetch it through the ssr-host load seam and inject it into kernel)');
  const cfg = { ...WORKFLOW_DEFAULTS, ...limitsIn };
  const optional = new Set(cfg.optionalStages ?? []);
  const handles = new Set(WORKFLOW_TOOL_NAMES);
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };
  /** 这个提供方起来的时刻:早于它更新、却还没结束的作业,是上一次进程留下的 */
  const bootAt = now();

  /** 正在跑的一键流程(本进程):jobId -> 状态 */
  const live = new Map();
  /** 同一素材同一时刻只一个一键流程:`项目\0素材` -> jobId */
  const byMedia = new Map();
  const pending = new Set();
  let reserving = 0;
  let closing = false;
  let closePromise = null;

  /* ---------------------------------------------------------------- 授权 */

  const forbidden = (action) => new WorkflowToolError(
    action === 'write' ? 'This round has no permission to modify the project (read-only member, stopped, or switched to private), so the one-click workflow did not start.' : 'This round has no permission to read the project.',
    { code: 'workflow-forbidden', status: 403 });
  const upstream = () => new WorkflowToolError('The document service is temporarily unreachable, so permissions for this turn cannot be confirmed. Try again later.', { code: 'authority-unavailable', status: 503 });
  /** 把授权/账本层的错误统一成给模型的错误:403 与 503 分开,不透露更多 */
  function authError(error, action) {
    if (error instanceof WorkflowToolError) return error;
    if (AUTH_UNAVAILABLE.has(error?.code)) return upstream();
    return forbidden(action);
  }
  /** 账本层(ToolJobs)的错:授权类的按授权说,别的如实说是账本的事 */
  function jobsError(error, action) {
    if (error instanceof WorkflowToolError) return error;
    if (AUTH_UNAVAILABLE.has(error?.code)) return upstream();
    if (REVOKED.test(String(error?.code ?? '')) || error?.name === 'ToolContextError' || error?.name === 'RunResourceError') return forbidden(action);
    return new WorkflowToolError(`The one-click workflow could not register the job (${error?.code ?? 'ledger unavailable'}).`, { code: 'workflow-job', status: 500 });
  }
  const authorize = async (context, action) => {
    if (closing) throw new WorkflowToolError('The Cloud Agent service is shutting down, and the one-click workflow no longer accepts new work.', { code: 'workflow-closed', status: 503 });
    try { return await resources.authorize(context, action); } catch (error) { throw authError(error, action); }
  };

  /* ---------------------------------------------------------------- 工作区索引(各阶段的状态、子作业号、人话原因) */

  function readIndexFile(ws, file) {
    try {
      if (!ws.exists(file)) return [];
      const rows = JSON.parse(ws.read(file, { maxBytes: 1024 * 1024 }).toString('utf8'));
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    } catch { return []; }
  }
  /** 先写临时文件再改名:写到一半进程没了,旧索引还是完整的 */
  function writeIndex(ws, rows) {
    const data = JSON.stringify(rows.slice(-cfg.historyJobs));
    const tmp = `${INDEX_FILE}.tmp`;
    try {
      ws.write(tmp, data);
      try { fs.renameSync(ws.resolve(tmp), ws.resolve(INDEX_FILE)); }
      catch { ws.write(INDEX_FILE, data); ws.remove(tmp); }
    } catch (error) { say('agent.workflow.index-failed', { message: String(error?.message ?? error).slice(0, 120) }); }
  }
  function saveRow(ws, row) {
    if (!ws) return;
    const rows = readIndexFile(ws, INDEX_FILE);
    const at = rows.findIndex((r) => r.jobId === row.jobId);
    if (at >= 0) rows[at] = row; else rows.push(row);
    writeIndex(ws, rows);
  }
  const rowOf = (ws, jobId) => readIndexFile(ws, INDEX_FILE).find((r) => r.jobId === jobId) ?? null;
  const wsOf = async (context) => { try { return await workspace(context); } catch { return null; } };

  /* ---------------------------------------------------------------- 作业的人话 */

  /** 其它包的作业为什么失败:先宿主注入的,再转写的表,再镜头/主体写在工作区索引里的 message,最后通用说法 */
  function reasonOf(ledger, ws) {
    const code = ledger.errorCode;
    if (!code) return null;
    for (const [prefix, table] of Object.entries(errorTexts)) {
      if (ledger.kind.startsWith(prefix) && typeof table?.[code] === 'string') return table[code];
    }
    if (ledger.kind.startsWith('stt.') && STT_ERROR_TEXT[code]) return STT_ERROR_TEXT[code];
    const file = ledger.kind === 'shots.detect' ? 'shots/jobs.json' : ledger.kind.startsWith('subject.') ? 'subject/jobs.json' : null;
    if (file && ws) {
      const row = readIndexFile(ws, file).find((r) => r.jobId === ledger.jobId);
      if (typeof row?.message === 'string' && row.message) return row.message;
    }
    return WORKFLOW_ERROR_TEXT[code] ?? `The job did not succeed (${code}).`;
  }

  /** 账本里非终态、却比这个提供方起来得早、又不是本进程在跑的:上一次进程留下的,按「被中断」说 */
  function effectiveState(ledger) {
    if (TERMINAL.has(ledger.state)) return { state: ledger.state, errorCode: ledger.errorCode };
    if (ledger.updatedAt < bootAt && !live.has(ledger.jobId)) return { state: 'interrupted', errorCode: ledger.errorCode ?? 'INTERRUPTED_ON_RESTART' };
    return { state: ledger.state, errorCode: ledger.errorCode };
  }

  /** 给模型看的作业状态(账本 + 人话);`done` / `ok` / `error` 与桌面版的 background_job_status 同义 */
  function jobView(ledger, ws) {
    const eff = effectiveState(ledger);
    const view = { ...ledger, state: eff.state, errorCode: eff.errorCode };
    const done = TERMINAL.has(view.state);
    const out = {
      jobId: view.jobId,
      kind: view.kind,
      label: JOB_LABEL[view.kind] ?? view.kind,
      done,
      ok: view.state === 'done',
      state: view.state,
      stateText: STATE_TEXT[view.state] ?? view.state,
      stage: view.stage ?? null,
      progress: view.progress,
      outputRefs: view.outputRefs,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
    if (view.state === 'error' || view.state === 'cancelled' || view.state === 'interrupted') {
      out.errorCode = view.errorCode ?? null;
      const reason = reasonOf({ ...view, errorCode: view.errorCode ?? (view.state === 'interrupted' ? 'INTERRUPTED_ON_RESTART' : null) }, ws);
      if (reason) out.error = reason;
      if (view.state === 'interrupted') out.hint = 'This job was interrupted and will not resume on its own; start it again if needed (the one-click workflow reuses stages that are already done).';
      if (view.state === 'error') out.hint = 'If it failed, do not keep polling this job ID.';
    }
    return out;
  }

  /* ---------------------------------------------------------------- 一键流程的状态视图 */

  const blankStages = () => Object.fromEntries(WORKFLOW_STAGES.map((s) => [s, { status: 'pending' }]));

  function stageList(row, terminalState) {
    const stages = row?.stages ?? blankStages();
    return WORKFLOW_STAGES.map((name) => {
      const s = { ...(stages[name] ?? { status: 'pending' }) };
      // 账本说整体已经停了、索引里这一阶段还写着「进行中」(进程在写索引前就没了,或授权被收回写不了):按整体的结局说
      if (s.status === 'running' && terminalState && terminalState !== 'done') s.status = terminalState === 'error' ? 'error' : terminalState;
      return { stage: name, label: WORKFLOW_STAGE_LABEL[name], ...s };
    });
  }

  function phaseText(view, stages) {
    if (view.state === 'done') return 'Completed';
    if (view.state === 'cancelled') return 'Cancelled';
    if (view.state === 'interrupted') return 'Interrupted';
    if (view.state === 'error') return 'failed';
    const current = stages.find((s) => s.status === 'running') ?? stages.find((s) => s.stage === view.stage);
    const names = { transcribe: 'Transcribing', shots: 'Detecting shots', subjects: 'Detecting subjects', compose: 'Composing cards', prerender: 'Publishing prerender' };
    return current ? (names[current.stage] ?? 'In progress') : 'Queued';
  }

  /** 一键流程整体的说法:失败/中断/取消时点明停在哪一阶段、后面没做 */
  function workflowError(view, stages, row) {
    if (view.state === 'done' || !TERMINAL.has(view.state)) return null;
    const at = stages.find((s) => ['error', 'unavailable', 'cancelled', 'interrupted'].includes(s.status)) ?? stages.find((s) => s.stage === view.stage);
    const where = at ? `the "${at.label}" stage` : 'a stage';
    const notDone = stages.filter((s) => s.status === 'pending').map((s) => s.label);
    const after = notDone.length ? `Later stages (${notDone.join(', ')}) were not run. ` : '';
    let why = at?.reason;
    if (!why && view.errorCode && WORKFLOW_ERROR_TEXT[view.errorCode]) why = WORKFLOW_ERROR_TEXT[view.errorCode];
    const verb = { error: 'failed', cancelled: 'was cancelled', interrupted: 'was interrupted' }[view.state];
    const resume = view.state === 'error' && at?.status === 'unavailable' ? '' : 'Call auto_workflow again to continue: stages that are already done (transcript, shots, subjects) will be reused directly.';
    return `The one-click workflow at ${where} ${verb}${why ? `:${why}` : '.'}${after}${resume}`.replace(/\.\./g, '.');
  }

  function workflowView(ledger, row) {
    const eff = effectiveState(ledger);
    const view = { ...ledger, state: eff.state, errorCode: eff.errorCode };
    const stages = stageList(row, TERMINAL.has(view.state) ? view.state : null);
    const done = TERMINAL.has(view.state);
    const ok = view.state === 'done';
    const out = {
      jobId: view.jobId,
      done,
      ok,
      state: view.state,
      phase: phaseText(view, stages),
      stage: view.stage ?? null,
      progress: view.progress,
      elapsedMs: Math.max(0, (done ? view.updatedAt : now()) - view.createdAt),
      error: workflowError(view, stages, row),
      result: ok ? (row?.result ?? null) : null,
      stages,
    };
    if (ok) {
      out.complete = stages.every((s) => ['done', 'reused', 'skipped'].includes(s.status));
      const gaps = stages.filter((s) => s.status === 'unavailable').map((s) => s.label);
      if (gaps.length) out.notDone = gaps;
    }
    if (done && !ok && row?.committed) out.committed = true;
    if (view.state === 'interrupted') out.hint = 'The one-click workflow was interrupted. Call auto_workflow again to continue: stages that are already done (transcript, shots, subjects) will be reused directly, not redone.';
    return out;
  }

  /* ---------------------------------------------------------------- 账本的写(含「共有已读」变成保留时的检查点) */

  async function patchJob(state, patch) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await jobs.update(state.context, state.jobId, state.revision, patch);
        state.revision += 1;
        if (patch.progress !== undefined) state.progress = patch.progress;
        return;
      } catch (error) {
        if (error?.code === 'job-scope-mismatch' && attempt === 0) {
          const checkpoint = await jobs.checkpointRetained(state.context, state.jobId, state.revision);
          state.revision = checkpoint.revision;
          continue;
        }
        throw error;
      }
    }
  }

  /** 开作业:同一条消息里同样的请求只开一个;上一个已经失败/取消/中断的,允许换个请求号重新发起 */
  async function startJob(context, digest, base) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const started = await jobs.start(context, WORKFLOW_JOB_KIND, digest, `${base}-${attempt}`.slice(0, 128));
      if (!BAD_JOB.has(started.state)) return started;
    }
    throw new WorkflowToolError('The same request has already failed several times; change the parameters or try again later.', { code: 'too-many-attempts', status: 429 });
  }

  /* ---------------------------------------------------------------- 阶段 */

  /** 一个阶段的结局(不是异常) */
  const outcome = (status, extra = {}) => ({ status, ...extra });
  /** 一个阶段没做成,流程停在这里 */
  class StageStop extends Error {
    constructor(terminal, code, reason, extra = {}) { super(reason); this.terminal = terminal; this.code = code; this.reason = reason; this.extra = extra; }
  }
  /** 这一轮的授权被收回 / 服务在关 / 被取消:不是任何一个阶段自己的失败 */
  class Halt extends Error {
    constructor(kind) { super(kind); this.kind = kind; }
  }

  function checkHalt(job) {
    if (job.stopReason === 'close' || closing) throw new Halt('close');
    if (job.stopReason === 'cancel') throw new Halt('cancel');
    if (job.signal.aborted) throw new Halt('fence');
  }

  /** 等一个子作业在账本里走完。子作业的进度映射到这个阶段在总进度条上的区间 */
  async function awaitChild(job, name, childJobId, provider) {
    const [from, to] = BAND[name];
    const startedAt = now();
    for (;;) {
      checkHalt(job);
      let ledger;
      try { ledger = await jobs.get(job.context, childJobId); }
      catch (error) {
        if (REVOKED.test(String(error?.code ?? '')) || AUTH_UNAVAILABLE.has(error?.code)) throw new Halt('fence');
        if (error?.code === 'job-not-found') throw new StageStop('error', 'STAGE_FAILED', 'The child job can no longer be found in the ledger.', { childJobId });
        throw error;
      }
      if (TERMINAL.has(ledger.state)) return ledger;
      const t = now();
      if (t - startedAt > cfg.stageWaitMs) {
        try { await provider?.cancel?.(job.context, childJobId); } catch { /* 取消不了就留给它自己的时限 */ }
        throw new StageStop('error', 'STAGE_TIMEOUT', WORKFLOW_ERROR_TEXT.STAGE_TIMEOUT, { childJobId });
      }
      await maybeProgress(job, from + (to - from) * Math.max(0, Math.min(1, ledger.progress ?? 0)));
      try { await sleep(cfg.pollMs, job.signal); } catch { checkHalt(job); throw new Halt('fence'); }
    }
  }

  async function maybeProgress(job, value) {
    const t = now();
    const next = Math.min(0.99, Math.max(job.state.progress ?? 0, value));
    if (next <= (job.state.progress ?? 0) || t - job.lastProgressAt < cfg.progressMs) return;
    job.lastProgressAt = t;
    await patchJob(job.state, { progress: next });
  }

  /** 子作业走完之后:成功回 null,否则抛出这个阶段的停止原因 */
  function childVerdict(job, name, ledger, ws) {
    if (ledger.state === 'done') return null;
    const reason = reasonOf(ledger, ws) ?? WORKFLOW_ERROR_TEXT[`STAGE_${ledger.state.toUpperCase()}`];
    const kind = ledger.state === 'cancelled' ? 'cancelled' : ledger.state === 'interrupted' ? 'interrupted' : 'error';
    const code = kind === 'cancelled' ? 'STAGE_CANCELLED' : kind === 'interrupted' ? 'STAGE_INTERRUPTED' : 'STAGE_FAILED';
    throw new StageStop(kind, code, reason, { childJobId: ledger.jobId, childErrorCode: ledger.errorCode ?? null });
  }

  /** 调一个感知包的提供方,等它的作业走完。三个感知阶段共用 */
  async function perceptionStage(job, name, { providerKey, tool, label, reused, skipped, dataReady }) {
    const media = await project.getMedia(job.context, job.mediaId);
    if (!media) throw new StageStop('error', 'MEDIA_MISSING', WORKFLOW_ERROR_TEXT.MEDIA_MISSING);
    const skip = skipped(media);
    if (skip) return outcome('skipped', { reason: skip });
    if (reused(media)) return outcome('reused', { reason: 'The project already has the result of this step, so it is reused directly.' });
    const provider = providers[providerKey];
    if (!provider || typeof provider.call !== 'function') {
      return outcome('unavailable', { reason: `This cloud node is not connected to ${label}.` });
    }
    checkHalt(job);
    let reply;
    try {
      reply = await provider.call(tool, { mediaId: job.mediaId }, job.context, { requestId: `${job.state.jobId}-${name}`.slice(0, 128) });
    } catch (error) {
      if (REVOKED.test(String(error?.code ?? '')) || AUTH_UNAVAILABLE.has(error?.code) || error?.status === 403 || error?.status === 503) await revokedCheck(job);
      throw new StageStop('error', 'STAGE_FAILED', String(error?.message ?? error).slice(0, 400));
    }
    if (reply?.ok === false) {
      return outcome('unavailable', { reason: typeof reply.error === 'string' ? reply.error : `${label} is unavailable on this node.` });
    }
    if (reply?.reused === true) return outcome('reused', { reason: 'The project already has the result of this step, so it is reused directly.' });
    const childJobId = reply?.jobId;
    if (typeof childJobId !== 'string' || !JOB_ID_RE.test(childJobId)) {
      throw new StageStop('error', 'STAGE_FAILED', `${label} did not return a job ID, so it cannot be confirmed as done.`);
    }
    job.child = { provider, jobId: childJobId };
    await recordStage(job, name, { status: 'running', childJobId });
    let ledger;
    try { ledger = await awaitChild(job, name, childJobId, provider); } finally { job.child = null; }
    childVerdict(job, name, ledger, job.ws);
    // 作业说做完了:项目里确实有结果才算(没有就是提交那一步没成,不能冒充完成)
    const after = await project.getMedia(job.context, job.mediaId);
    if (!after || !dataReady(after)) throw new StageStop('error', 'STAGE_FAILED', `The job for ${label} shows as complete, but its result was not found in the project.`, { childJobId });
    return outcome('done', { childJobId });
  }

  const stageRunners = {
    transcribe: (job) => perceptionStage(job, 'transcribe', {
      providerKey: 'stt', tool: 'transcribe_media', label: 'Speech-to-text',
      skipped: (m) => (m.kind === 'image' ? 'Images have no sound.' : null),
      reused: (m) => Array.isArray(m.transcript?.segments) && m.transcript.segments.length > 0,
      dataReady: (m) => Array.isArray(m.transcript?.segments),
    }),
    shots: (job) => perceptionStage(job, 'shots', {
      providerKey: 'shots', tool: 'detect_shots', label: 'Shot detection',
      skipped: (m) => (m.kind !== 'video' ? `${m.kind === 'audio' ? 'audio' : 'This media'} is not a video, so there are no shots to split.` : null),
      reused: (m) => !!m.shots,
      dataReady: (m) => !!m.shots,
    }),
    subjects: (job) => perceptionStage(job, 'subjects', {
      providerKey: 'subject', tool: 'detect_subjects', label: 'subject detection',
      skipped: (m) => (m.kind === 'audio' ? 'Audio has no picture to view.' : null),
      reused: (m) => !!m.subjects,
      dataReady: (m) => !!m.subjects,
    }),
    compose: (job) => composeStage(job),
    prerender: (job) => prerenderStage(job),
  };

  /** 生成字幕与卡片:读文字稿和时间轴、算方案、一次提交(带期望的项目版本) */
  async function composeStage(job) {
    for (let attempt = 1; attempt <= cfg.composeAttempts; attempt += 1) {
      checkHalt(job);
      const media = await project.getMedia(job.context, job.mediaId);
      if (!media) throw new StageStop('error', 'MEDIA_MISSING', WORKFLOW_ERROR_TEXT.MEDIA_MISSING);
      if (!media.transcript || !Array.isArray(media.transcript.segments) || media.transcript.segments.length === 0) {
        throw new StageStop('error', 'EMPTY_TRANSCRIPT', WORKFLOW_ERROR_TEXT.EMPTY_TRANSCRIPT);
      }
      const timeline = await project.getTimeline(job.context);
      const plan = planAutoWorkflowEdits({
        transcript: media.transcript, mediaId: job.mediaId, tracks: timeline?.tracks ?? [], maxCards: job.maxCards, getCard: kernel.getCard,
      });
      if (plan.cards.length === 0 && !plan.caption) {
        return outcome('done', { reason: 'The transcript has nothing within this media clip\'s range, so no captions or cards were placed.', plan: { ...plan, cards: [] }, applied: null });
      }
      const commitKey = sha(JSON.stringify({ v: 1, mediaId: job.mediaId, maxCards: job.maxCards,
        transcript: media.transcript.segments.map((s) => [s.start, s.end, s.text]) }));
      // 提交前重核写权限(被收回就停,不提交);宿主的提交在文档服务的版本预期与操作栅栏下再核一次
      checkHalt(job);
      let fence;
      try { fence = await resources.authorize(job.context, 'write'); } catch { throw new Halt('fence'); }
      checkHalt(job);
      await recordStage(job, 'compose', { status: 'running', committing: true });
      let applied;
      try {
        applied = await project.applyEdits(job.context, {
          jobId: job.state.jobId, mediaId: job.mediaId, commitKey, expectedProjectRev: timeline?.projectRev,
          fenceRevision: fence.fenceRevision, cards: plan.cards, caption: plan.caption,
        });
      } catch (error) {
        if (error?.code === 'project-changed') {
          if (attempt < cfg.composeAttempts) continue;
          throw new StageStop('error', 'PROJECT_CHANGED', WORKFLOW_ERROR_TEXT.PROJECT_CHANGED);
        }
        if (error?.code === 'media-changed' || error?.code === 'media-missing') throw new StageStop('error', 'MEDIA_MISSING', 'The media was replaced or deleted in the meantime, so the captions and cards were not written.');
        if (REVOKED.test(String(error?.code ?? '')) || AUTH_UNAVAILABLE.has(error?.code) || error?.status === 403 || error?.status === 503) await revokedCheck(job);
        throw new StageStop('error', 'COMMIT_FAILED', `${WORKFLOW_ERROR_TEXT.COMMIT_FAILED}${error?.message ? `(${String(error.message).slice(0, 160)})` : ''}`);
      }
      job.row.committed = true;
      return outcome(applied?.alreadyApplied ? 'reused' : 'done', {
        reason: applied?.alreadyApplied ? 'The captions and cards for this transcript are already in the project, so they were not placed again.' : undefined,
        plan, applied,
      });
    }
    throw new StageStop('error', 'PROJECT_CHANGED', WORKFLOW_ERROR_TEXT.PROJECT_CHANGED);
  }

  /** 发布预渲染任务:云端没有页面,这一步由宿主经接缝交给 Agent 服务的预渲染发布 */
  async function prerenderStage(job) {
    const applied = job.composed?.applied;
    if (!applied) return outcome('skipped', { reason: 'No new captions or cards were written this time, so there is nothing to publish.' });
    if (!prerender || typeof prerender.publish !== 'function') {
      return outcome('unavailable', { reason: 'This node is not connected to prerender publishing. The captions and cards were written to the project, but the prerender task was not published.' });
    }
    const clipIds = [...(applied.clips ?? []).filter(Boolean).map((c) => c.clipId), ...(applied.captionClipId ? [applied.captionClipId] : [])];
    checkHalt(job);
    let fence;
    try { fence = await resources.authorize(job.context, 'write'); } catch { throw new Halt('fence'); }
    let reply;
    try {
      reply = await prerender.publish(job.context, { jobId: job.state.jobId, mediaId: job.mediaId, projectRev: applied.projectRev, clipIds, fenceRevision: fence.fenceRevision });
    } catch (error) {
      if (REVOKED.test(String(error?.code ?? '')) || AUTH_UNAVAILABLE.has(error?.code) || error?.status === 403 || error?.status === 503) await revokedCheck(job);
      throw new StageStop('error', 'PUBLISH_FAILED', `${WORKFLOW_ERROR_TEXT.PUBLISH_FAILED}(${String(error?.message ?? error).slice(0, 160)})`);
    }
    if (reply?.published === true) return outcome('done', { reason: 'Handed the affected clips to the prerender task for publishing (sent after a few seconds; render results are recorded in the chat events).', planned: reply.planned });
    return outcome('unavailable', { reason: typeof reply?.reason === 'string' && reply.reason ? reply.reason : 'This project has no available render node right now, so the prerender task was not published.' });
  }

  /** 子进程/提交出了授权类的错:确认是授权真的被收回就停(Halt),不当作阶段失败 */
  async function revokedCheck(job) {
    try { await resources.authorize(job.context, 'write'); } catch { throw new Halt('fence'); }
    checkHalt(job);
  }

  /* ---------------------------------------------------------------- 一键流程本体 */

  async function recordStage(job, name, patch) {
    const prev = job.row.stages[name] ?? { status: 'pending' };
    job.row.stages[name] = { ...prev, ...patch, ...(patch.status === 'running' && !prev.startedAt ? { startedAt: now() } : null) };
    job.row.updatedAt = now();
    saveRow(job.ws, job.row);
  }

  async function finishRow(job, patch) {
    Object.assign(job.row, patch, { finishedAt: now(), updatedAt: now() });
    saveRow(job.ws, job.row);
  }

  /** 账本的收尾:写不了(授权已收回)不抛——栅栏取消由宿主的 `cancelForFence` 补 */
  async function finishLedger(job, patch) {
    try { await patchJob(job.state, patch); } catch { /* 交给宿主 */ }
  }

  function resultOf(job) {
    const stages = job.row.stages;
    const plan = stages.compose?.plan;
    const applied = stages.compose?.applied;
    const clips = [];
    let skipped = plan ? plan.skippedByPlan : 0;
    (plan?.cards ?? []).forEach((card, i) => {
      const placed = applied?.clips?.[i];
      if (!placed) { skipped += 1; return; }
      clips.push({ clipId: placed.clipId, cardId: card.cardId, start: placed.start, end: placed.end, text: card.text });
    });
    return {
      mediaId: job.mediaId,
      ...(job.style !== undefined ? { style: job.style } : {}),
      transcribed: stages.transcribe?.status === 'done',
      segments: plan?.segments ?? 0,
      groups: plan?.groups ?? 0,
      captionClipId: applied?.captionClipId ?? null,
      clips,
      skipped,
      ...(applied?.projectRev !== undefined ? { projectRev: applied.projectRev } : {}),
    };
  }

  async function runWorkflow(job) {
    const handle = Object.assign(new EventEmitter(), {
      destroy() { job.signalOwn.abort('fence'); this.emit('close'); },
    });
    let registration = null;
    try {
      try { registration = await resources.register(job.context, { kind: 'stream', resource: handle }); }
      catch { return; }                                             // 这一轮已经没有权限:账本交给宿主的取消
      job.signal = AbortSignal.any([registration.signal, job.signalOwn.signal]);
      try {
        await patchJob(job.state, { state: 'running', stage: 'transcribe', progress: BAND.transcribe[0] });
      } catch { return; }
      let failure = null;
      for (const name of WORKFLOW_STAGES) {
        checkHalt(job);
        const [from, to] = BAND[name];
        await patchJob(job.state, { stage: name, progress: Math.max(job.state.progress, from) });
        await recordStage(job, name, { status: 'running' });
        let result;
        try { result = await stageRunners[name](job); }
        catch (error) {
          if (error instanceof StageStop) {
            await recordStage(job, name, { status: error.terminal, errorCode: error.code, reason: error.reason, finishedAt: now(), ...error.extra });
            failure = error;
            failure.stage = name;
            break;
          }
          throw error;
        }
        if (name === 'compose') job.composed = result;
        const { status, reason, childJobId, plan, applied, planned } = result;
        await recordStage(job, name, {
          status, ...(reason ? { reason } : {}), ...(childJobId ? { childJobId } : {}), ...(planned !== undefined ? { planned } : {}),
          ...(name === 'compose' ? { plan: slimPlan(plan), applied: slimApplied(applied) } : {}), finishedAt: now(),
        });
        if (status === 'unavailable' && !optional.has(name)) {
          failure = new StageStop('error', 'STAGE_UNAVAILABLE', reason ?? WORKFLOW_ERROR_TEXT.STAGE_UNAVAILABLE);
          failure.stage = name;
          break;
        }
        checkHalt(job);
        await patchJob(job.state, { progress: Math.max(job.state.progress, to), outputRefs: stageRefs(job) });
      }
      if (failure) {
        await finishRow(job, { status: failure.terminal, errorCode: failure.code, failedStage: failure.stage });
        await finishLedger(job, { state: failure.terminal, errorCode: failure.code });
        say('agent.workflow.stopped', { stage: failure.stage, code: failure.code, message: String(failure.reason).slice(0, 120) });
        return;
      }
      const result = resultOf(job);
      await finishRow(job, { status: 'done', result });
      await finishLedger(job, { state: 'done', stage: 'done', progress: 1, outputRefs: stageRefs(job) });
    } catch (error) {
      if (error instanceof Halt) {
        const reason = error.kind;
        const state = reason === 'close' ? 'interrupted' : 'cancelled';
        const code = reason === 'close' ? 'SERVICE_CLOSING' : reason === 'cancel' ? 'WORKFLOW_CANCELLED' : 'FENCE_CANCELLED';
        const cur = WORKFLOW_STAGES.find((s) => job.row.stages[s]?.status === 'running');
        if (cur) job.row.stages[cur] = { ...job.row.stages[cur], status: state, finishedAt: now() };
        await finishRow(job, { status: state, errorCode: code });
        await finishLedger(job, { state, errorCode: code });
        return;
      }
      // 不是预料中的停止:授权类的错说明权限被收回(状态交给宿主),别的是这个流程自己的故障
      if (REVOKED.test(String(error?.code ?? '')) || AUTH_UNAVAILABLE.has(error?.code) || error?.name === 'AbortError') return;
      say('agent.workflow.crashed', { message: String(error?.message ?? error).slice(0, 160) });
      const cur = WORKFLOW_STAGES.find((s) => job.row.stages[s]?.status === 'running');
      if (cur) job.row.stages[cur] = { ...job.row.stages[cur], status: 'error', reason: 'The one-click workflow itself failed.', finishedAt: now() };
      await finishRow(job, { status: 'error', errorCode: 'STAGE_FAILED' });
      await finishLedger(job, { state: 'error', errorCode: 'STAGE_FAILED' });
    } finally {
      try { handle.destroy(); } catch { /* 已经关了 */ }
      if (registration) await Promise.race([registration.closed.catch(() => {}), sleep(5_000).catch(() => {})]);
    }
  }

  /** 索引里只留方案的摘要(卡片的完整参数不进索引) */
  function slimPlan(plan) {
    if (!plan) return undefined;
    return { segments: plan.segments, groups: plan.groups, skippedByPlan: plan.skippedByPlan,
      cards: plan.cards.map((c) => ({ cardId: c.cardId, start: c.start, duration: c.duration, text: c.text })) };
  }
  function slimApplied(applied) {
    if (!applied) return null;
    return { projectRev: applied.projectRev ?? null, captionClipId: applied.captionClipId ?? null,
      clips: (applied.clips ?? []).map((c) => (c ? { clipId: c.clipId, start: c.start, end: c.end } : null)) };
  }
  function stageRefs(job) {
    const refs = [];
    for (const name of WORKFLOW_STAGES) {
      if (['done', 'reused', 'skipped'].includes(job.row.stages[name]?.status)) refs.push({ kind: 'stage', id: name });
    }
    if (OUTPUT_ID_RE.test(job.mediaId)) refs.push({ kind: 'media', id: job.mediaId });
    return refs;
  }

  /* ---------------------------------------------------------------- auto_workflow */

  function parseWorkflowArgs(args) {
    rejectUnknown(args, ['mediaId', 'style', 'maxCards']);
    const mediaId = args?.mediaId;
    if (typeof mediaId !== 'string' || !MEDIA_ID_RE.test(mediaId)) throw new WorkflowToolError('mediaId is required and is the media id (see list_media).', { code: 'bad-args' });
    let style;
    if (args.style !== undefined && args.style !== null) {
      if (typeof args.style !== 'string' || args.style.length > 200) throw new WorkflowToolError('style must be text of at most 200 characters.', { code: 'bad-args' });
      style = args.style;
    }
    let maxCards = cfg.defaultMaxCards;
    if (args.maxCards !== undefined && args.maxCards !== null) {
      if (typeof args.maxCards !== 'number' || !Number.isInteger(args.maxCards) || args.maxCards < 0 || args.maxCards > cfg.maxCardsCeiling) {
        throw new WorkflowToolError(`maxCards must be an integer from 0 to ${cfg.maxCardsCeiling}.`, { code: 'bad-args' });
      }
      maxCards = args.maxCards;
    }
    return { mediaId, style, maxCards };
  }

  async function autoWorkflow(args, context, options = {}) {
    const input = parseWorkflowArgs(args);
    await authorize(context, 'write');
    const media = await project.getMedia(context, input.mediaId);
    if (!media) throw new WorkflowToolError('Media not found; you can look it up with list_media.', { code: 'media-not-found', status: 404 });
    if (media.kind === 'image') throw new WorkflowToolError(`${media.name ?? 'This media'} is an image with no sound to transcribe; the one-click workflow only handles video or audio.`, { code: 'media-kind' });
    if (media.pending) throw new WorkflowToolError(`${media.name ?? 'This media'} is not in the asset service yet (upload incomplete or failed); try again later or re-import it.`, { code: 'media-pending' });

    const mediaKey = `${context.projectId}\0${input.mediaId}`;
    const digest = sha(JSON.stringify({ v: 1, mediaId: input.mediaId, style: input.style ?? null, maxCards: input.maxCards }));
    const already = byMedia.get(mediaKey);
    if (already) {
      const liveJob = live.get(already);
      if (liveJob && liveJob.conversationId === context.conversationId) {
        return { jobId: already, running: true, started: false, alreadyRunning: true, mediaId: input.mediaId, phase: phaseOfLive(liveJob),
          hint: 'The one-click workflow for this media is already running. Poll with auto_workflow_status using this jobId; do not call again.' };
      }
      throw new WorkflowToolError('This media is being processed by a one-click workflow (started from another chat); wait for it to finish and try again.', { code: 'workflow-busy', status: 409 });
    }
    if (live.size + reserving >= cfg.maxRunning) throw new WorkflowToolError('Too many one-click workflows are running on the node; try again in a moment.', { code: 'workflow-busy', status: 429 });

    byMedia.set(mediaKey, 'reserved');
    reserving += 1;
    const requestBase = REQUEST_RE.test(options.requestId ?? '') ? options.requestId : `wf_${randomUUID().replace(/-/g, '')}`;
    let started;
    try { started = await startJob(context, digest, requestBase); }
    catch (error) {
      byMedia.delete(mediaKey);
      throw jobsError(error, 'write');
    } finally { reserving -= 1; }
    if (closing) {
      byMedia.delete(mediaKey);
      // 刚登记的作业不留在排队里:标「被中断」,免得重启后看着像还在等
      if (started.state === 'queued') await jobs.update(context, started.jobId, 0, { state: 'interrupted', errorCode: 'SERVICE_CLOSING' }).catch(() => {});
      throw new WorkflowToolError('The Cloud Agent service is shutting down, and the one-click workflow no longer accepts new work.', { code: 'workflow-closed', status: 503 });
    }
    if (started.state !== 'queued' || live.has(started.jobId)) {
      // 同一请求的重试:作业已经开了(可能正在跑,也可能已经做完),不再开第二个
      if (byMedia.get(mediaKey) === 'reserved') byMedia.delete(mediaKey);
      return { jobId: started.jobId, running: started.state === 'queued' || started.state === 'running', started: false, mediaId: input.mediaId, state: started.state,
        hint: 'The same one-click workflow was already started in this turn. Check it with auto_workflow_status using this jobId; do not call again.' };
    }

    const ws = await wsOf(context);
    let revision = 0;
    try { revision = (await jobs.get(context, started.jobId)).revision; }
    catch (error) { byMedia.delete(mediaKey); throw jobsError(error, 'write'); }
    const row = { jobId: started.jobId, mediaId: input.mediaId, ...(input.style !== undefined ? { style: input.style } : {}), maxCards: input.maxCards,
      status: 'queued', startedAt: now(), updatedAt: now(), stages: blankStages() };
    if (ws) saveRow(ws, row);
    const job = {
      context, ws, row, mediaId: input.mediaId, style: input.style, maxCards: input.maxCards, mediaKey, requestBase,
      conversationId: context.conversationId, state: { context, jobId: started.jobId, revision, progress: 0 },
      signalOwn: new AbortController(), signal: new AbortController().signal, stopReason: null, child: null, composed: null, lastProgressAt: 0, done: null,
    };
    live.set(started.jobId, job);
    byMedia.set(mediaKey, started.jobId);
    job.done = runWorkflow(job).catch((error) => say('agent.workflow.worker-crashed', { message: String(error?.message ?? error).slice(0, 160) }))
      .finally(() => { live.delete(started.jobId); if (byMedia.get(mediaKey) === started.jobId) byMedia.delete(mediaKey); pending.delete(job.done); });
    pending.add(job.done);

    // 与桌面版相同:等一小会儿,跑完了直接回完整结果,没跑完先回 jobId
    const waiting = new AbortController();
    const quick = await Promise.race([job.done.then(() => 'done'), sleep(cfg.fastWaitMs, waiting.signal).then(() => 'slow', () => 'done')]);
    waiting.abort();
    if (quick === 'slow') {
      return { jobId: started.jobId, running: true, started: true, mediaId: input.mediaId, phase: phaseOfLive(job),
        hint: 'The media is long, so transcription, recognition and card arrangement continue in the background. Poll with auto_workflow_status using this jobId; when done is true, result holds the full result. Do not call auto_workflow again in the meantime.' };
    }
    const status = await statusOf(context, started.jobId);
    if (status.ok) return { ...status.result, jobId: started.jobId, running: false, stages: status.stages, ...(status.notDone ? { notDone: status.notDone } : {}) };
    return { ok: false, jobId: started.jobId, running: false, done: true, state: status.state, phase: status.phase, error: status.error, stages: status.stages,
      ...(status.committed ? { committed: true } : {}) };
  }

  const phaseOfLive = (job) => {
    const cur = WORKFLOW_STAGES.find((s) => job.row.stages[s]?.status === 'running');
    return { transcribe: 'Transcribing', shots: 'Detecting shots', subjects: 'Detecting subjects', compose: 'Composing cards', prerender: 'Publishing prerender' }[cur] ?? 'Queued';
  };

  /* ---------------------------------------------------------------- 状态 */

  const notFound = () => new WorkflowToolError('Job not found: the jobId may be wrong, may not belong to this chat, or the system may have restarted.', { code: 'job-not-found', status: 404 });

  async function ledgerOf(context, jobId) {
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
      await authorize(context, 'read');
      throw notFound();
    }
    try { return await jobs.get(context, jobId); }
    catch (error) {
      if (error?.code === 'job-not-found' || error?.code === 'bad-job-id') throw notFound();
      throw jobsError(error, 'read');
    }
  }

  async function statusOf(context, jobId) {
    const ledger = await ledgerOf(context, jobId);
    if (ledger.kind !== WORKFLOW_JOB_KIND) throw notFound();
    const ws = await wsOf(context);
    return workflowView(ledger, ws ? rowOf(ws, jobId) : null);
  }

  async function backgroundJobStatus(args, context) {
    rejectUnknown(args, ['jobId']);
    await authorize(context, 'read');
    const ledger = await ledgerOf(context, args?.jobId);
    const ws = await wsOf(context);
    if (ledger.kind === WORKFLOW_JOB_KIND) {
      const view = workflowView(ledger, ws ? rowOf(ws, ledger.jobId) : null);
      return { ...jobView(ledger, ws), phase: view.phase, stages: view.stages, ...(view.error ? { error: view.error } : {}), ...(view.result ? { result: view.result } : {}) };
    }
    return jobView(ledger, ws);
  }

  async function autoWorkflowStatus(args, context) {
    rejectUnknown(args, ['jobId']);
    await authorize(context, 'read');
    return statusOf(context, args?.jobId);
  }

  function rejectUnknown(args, allowed) {
    if (args === undefined || args === null) return;
    if (typeof args !== 'object' || Array.isArray(args)) throw new WorkflowToolError('Arguments must be an object.', { code: 'bad-args' });
    const extra = Object.keys(args).filter((k) => !allowed.includes(k));
    if (extra.length) throw new WorkflowToolError(`Unknown parameters: ${extra.join(', ')}. Available parameters: ${allowed.join(', ')}.`, { code: 'bad-args' });
  }

  /* ---------------------------------------------------------------- 对外 */

  async function call(name, args, context, options = {}) {
    if (!handles.has(name)) throw new WorkflowToolError(`The one-click workflow does not handle ${name}.`, { code: 'unknown-tool', status: 404 });
    if (name === 'background_job_status') return backgroundJobStatus(args, context);
    if (name === 'auto_workflow_status') return autoWorkflowStatus(args, context);
    return autoWorkflow(args, context, options);
  }

  /**
   * 显式取消一个正在跑的一键流程(给宿主和测试用,不是模型工具):阶段停下、不再往下走,正在等的子作业也请它的提供方取消。
   * 这一轮被停、转私有、Agent 关闭走的是运行资源登记器的中止信号,不经这里。
   */
  async function cancel(context, jobId) {
    await authorize(context, 'write');
    const job = live.get(jobId);
    if (!job || job.conversationId !== context.conversationId || job.context.projectId !== context.projectId) return { cancelled: false };
    job.stopReason ??= 'cancel';
    const child = job.child;
    job.signalOwn.abort('cancel');
    if (child) { try { await child.provider?.cancel?.(job.context, child.jobId); } catch { /* 子作业自己有时限 */ } }
    await job.done;
    return { cancelled: true };
  }

  /**
   * 关闭:不再接新调用,让所有在跑的一键流程停下(账本记「被中断」),等它们收尾。
   * 子进程是各感知包的,由它们自己的 `close()` 杀;宿主要先关本提供方、再关它们,这样不会有流程在子包关了之后还想往下走。
   * @returns {Promise<{ childrenClosed: boolean, streamsClosed: boolean, workPending: number }>}
   */
  function close(reason = 'close') {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      for (const job of live.values()) { job.stopReason ??= 'close'; job.signalOwn.abort(reason); }
      const all = Promise.allSettled([...pending]);
      const finished = await Promise.race([all.then(() => true), sleep(cfg.closeMs).then(() => false)]);
      return { childrenClosed: finished, streamsClosed: finished, workPending: pending.size };
    })();
    return closePromise;
  }

  return Object.freeze({ handles, call, cancel, close });
}
