/**
 * Cloud Agent background job status and one-click workflow (`background_job_status`,
 * `auto_workflow`, `auto_workflow_status`; package P5 of the plan
 * `docs/plan/cloud-agent-tools-implementation.md`).
 *
 * In the desktop app, these three tools are executed by the page: `src/mcp/tools/autoWorkflow.ts`
 * transcribes, configures cards, and lays captions in the page, and jobs are kept in the page's
 * in-memory tables (`sttJobs`, etc. of `src/mcp/common.ts`), which are lost on refresh or restart.
 * There is no page on cloud nodes, so a separate implementation is made on the Agent service side:
 *
 *   - **Job status**: `background_job_status` queries F0's job ledger (`tool-jobs.mjs`, SQLite).
 *     Transcription, shot detection, subject detection, motion tracking, various installations,
 *     and one-click workflows are all in this single ledger, and queries are restricted to **this
 *     project and this chat** only; job IDs from other projects, other chats, or non-existent job
 *     IDs return the same "not found". The ledger only stores codes; human-readable text is
 *     translated using existing phrasing from each package (transcription uses `STT_ERROR_TEXT`;
 *     shots and subjects use `message` written in their workspace index; for tracking and similar,
 *     the host can inject via `errorTexts`). Those running midway upon restart are "interrupted".
 *   - **One-click workflow**: chained across stages: speech transcription → shot detection →
 *     subject detection → generate captions and cards → publish prerender tasks. The first three
 *     stages **call the providers of corresponding tool packages** (stt / shots / subject injected
 *     via factory parameter `providers`, without rewriting their logic), and wait for their jobs
 *     to finish in the ledger; "Generate captions and cards" ports the card configuration rules
 *     (`autoWorkflow.ts`) from the desktop app to compute a plan, submitted **at once** via
 *     `project.applyEdits` provided by the host (carrying expected project version; the entire
 *     batch either all goes in or none goes in, so there is no partial commit in the project on
 *     failure); "Publish prerender tasks" goes through the `prerender` seam injected by the host.
 *   - **No skipping on failure**: If a stage fails, is cancelled, or is interrupted, it stops right
 *     there; subsequent stages are not executed, and uncompleted stages are not marked as completed.
 *     When dependent perception capabilities are not ready on this node (provider not configured,
 *     returns `cloudUnavailable`), this stage is marked "unavailable" with an explanation and
 *     likewise stops there (the host can specify which stages are allowed to be skipped when not
 *     ready via `optionalStages`; by default only "Publish prerender tasks" is allowed), without
 *     spawning placeholder jobs to fake completion.
 *   - **Stage status persistence**: The ledger records overall status, current stage, and progress;
 *     the status of each stage, corresponding subjob ID, and reason are recorded in
 *     `workflow/jobs.json` of this chat workspace. After restart, `auto_workflow_status` can clearly
 *     report which stage was reached and which stage was interrupted.
 *   - **Control path**: One-click workflows are registered as a run resource (`run-resources`) for
 *     this round. When this round is stopped, switched to private, the Agent is closed, or the
 *     service shuts down, an abort signal arrives; running stages stop, execution does not proceed
 *     to the next stage, and no further commits are made; write permissions are re-checked before
 *     each commit and publish. Underlying child processes are killed by each package's own registry.
 *
 * This file does not reference `src/`: querying "what parameters a card has" in card configuration
 * rules requires `getCard` from the front-end kernel, injected by the host via factory parameter
 * `kernel`.
 * Does not call "spawn subagent" (`spawn_agent`): permanently unsupported in the cloud.
 */
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { STT_ERROR_TEXT } from './perception/stt.mjs';

export const WORKFLOW_TOOL_NAMES = Object.freeze(['background_job_status', 'auto_workflow', 'auto_workflow_status']);
export const WORKFLOW_JOB_KIND = 'workflow.auto';
export const WORKFLOW_STAGES = Object.freeze(['transcribe', 'shots', 'subjects', 'compose', 'prerender']);
export const WORKFLOW_STAGE_LABEL = Object.freeze({
  transcribe: 'Speech-to-text', shots: 'Shot detection', subjects: 'Subject detection', compose: 'Generate captions and cards', prerender: 'Publish prerender job',
});

export const WORKFLOW_DEFAULTS = Object.freeze({
  /** Same 12 as in the desktop app one-click workflow */
  defaultMaxCards: 12,
  maxCardsCeiling: 100,
  /**
   * How long `auto_workflow` waits before returning jobId if not finished yet (same 50 seconds as the
   * desktop app; leaves a 10-second margin below the 60-second limit for a single tool call)
   */
  fastWaitMs: 50_000,
  /** Polling interval for subjobs */
  pollMs: 400,
  /**
   * Maximum wait time for a stage (subjobs have their own time limits; this is a fallback against
   * hangs)
   */
  stageWaitMs: 45 * 60_000,
  /**
   * Minimum interval for writing ledger progress (each database write passes through several
   * authorization checks)
   */
  progressMs: 1_500,
  /** Number of concurrently running one-click workflows (in-process) */
  maxRunning: 2,
  /**
   * Number of retries to reread and recalculate when project version changes during card
   * configuration plan submission
   */
  composeAttempts: 3,
  /** Time limit for `close()` to wait for background workflow finalization */
  closeMs: 10_000,
  /** How many entries to retain in the workspace index */
  historyJobs: 20,
  /**
   * Stages allowed to skip (rather than stop there) when "not ready": subject detection and
   * publishing prerender tasks are optional by default
   */
  optionalStages: Object.freeze(['subjects', 'prerender']),
});

/**
 * Interval occupied by each stage on the progress bar (monotonically increasing; reaches 1 only
 * upon completion)
 */
const BAND = Object.freeze({
  transcribe: [0.02, 0.40], shots: [0.40, 0.55], subjects: [0.55, 0.75], compose: [0.75, 0.92], prerender: [0.92, 0.99],
});

const JOB_LABEL = Object.freeze({
  'stt.transcribe': 'Speech-to-text', 'stt.install': 'Speech-to-text engine install', 'shots.detect': 'Shot detection',
  'subject.detect': 'Subject detection', 'subject.install': 'Subject detection extension install', 'track.points': 'Motion tracking',
  'track.install': 'Motion tracking extension install', [WORKFLOW_JOB_KIND]: 'One-click workflow',
});

/**
 * Generic descriptions for codes written by packages without human-readable text in the ledger;
 * each package's own phrasing (transcription, message in workspace index, host-injected) takes
 * precedence
 */
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

const STATE_TEXT = Object.freeze({ queued: 'Queued', running: 'In progress', done: 'Completed', error: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' });
const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);
const BAD_JOB = new Set(['error', 'cancelled', 'interrupted']);
const MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{8,128}$/;
const JOB_ID_RE = /^job_[0-9a-f-]{36}$/;
const OUTPUT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const INDEX_FILE = 'workflow/jobs.json';
const AUTH_UNAVAILABLE = new Set(['run-authority-unavailable', 'tool-instance-unavailable', 'fence-unavailable', 'authorization-unavailable']);
/** This type of error indicates authorization/fence has changed (not the job's own failure) */
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

/* ================================================================== Card configuration rules (ported from desktop app autoWorkflow.ts, without referencing src/) */

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
 * Calculate cards and captions to place based on transcript and asset positions on the timeline
 * (without touching the project). Identical step-by-step to steps 3-7 of desktop app
 * `autoWorkflow.ts` pipeline: map to the first clip on the timeline using this asset; 5-15 seconds
 * per group (must break at 15 seconds; after 5 seconds, break upon sentence-ending punctuation,
 * pause >= 0.6 seconds, or if adding another segment would exceed 15 seconds); merge short tails
 * into the previous group; select one card per group based on keywords (omit if none matches), at
 * most `maxCards` cards; one caption-track for the entire transcript.
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
  // Asset seconds → timeline seconds, including clip speed. Same formula as timelineTimeAt in
  // `src/kernel/clipTime.mjs` (copied directly as the Agent service process side does not import
  // `src/`; speeds that are not finite positive numbers default to 1, with / 1 bit-exact when
  // defaulting to 1), same as desktop app autoWorkflow.ts
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

/* ================================================================== Providers */

/**
 * @param {object} d
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<object>, register(context: object, o: { kind: string, resource: object }): Promise<{ signal: AbortSignal, closed: Promise<void> }> }} d.resources
 *   F0 run resource registrar (`createRunResources`)
 * @param {{ start: Function, update: Function, get: Function, checkpointRetained: Function }} d.jobs F0 `createToolJobs`
 * @param {(context: object) => object | Promise<object>} d.workspace Workspace of this chat (`open()` in `workspace.mjs`)
 * @param {{ stt?: object|null, shots?: object|null, subject?: object|null }} d.providers Providers for three perception tool packages
 *   (return value of `createSttTools` / `createShotsTools` / `createSubjectTools`: `call(name, args, context, { requestId })`, optional `cancel(context, jobId)`);
 *   null if missing: this node is not connected to this capability, and corresponding stage is marked "unavailable"
 * @param {object} d.project Narrow interface on project side (package G version expectations and operation fences connected to document service):
 *   `getMedia(context, mediaId)` -> asset record (must have `id, name, kind, transcript, shots, subjects`) or null (same as used by three perception packages);
 *   `getTimeline(context)` -> `{ projectRev, tracks: [{ clips: [{ mediaId, start, end, mediaOffset, speed? }] }] }`;
 *   `applyEdits(context, { jobId, mediaId, commitKey, expectedProjectRev, fenceRevision, cards, caption })`
 *     -> `{ projectRev, clips: Array<{ clipId, start, end } | null>(same order as cards, null if cannot fit), captionClipId: string | null, alreadyApplied?: true }`;
 *     completed in a single mutate (all-or-nothing: either all applied or none applied); throws error with `code: 'project-changed'` on version mismatch;
 *     returns `alreadyApplied` without re-placing if `commitKey` is identical and these clips are still in the project;
 *     after placement, project duration must extend to the end of the latest clip (same finalization as desktop app)
 * @param {{ publish(context: object, input: { jobId: string, mediaId: string, projectRev: any, clipIds: string[], fenceRevision: number }): Promise<{ published: boolean, reason?: string, planned?: number }> } | null} [d.prerender]
 *   Seam for publishing prerender tasks (prerender publish `render-request.mjs` connected from host to Cloud Agent service); null if not provided: this stage is marked "unavailable"
 * @param {{ getCard: (id: string) => object | undefined }} d.kernel Injected by host fetched via ssr-host loader seam (required)
 * @param {Record<string, Record<string, string>>} [d.errorTexts] Job type prefix → (error code → human-readable text), e.g. `{ 'track.': { TRACK_TIMEOUT: '…' } }`
 * @param {object} [d.limits] Overrides `WORKFLOW_DEFAULTS`
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
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect tools */ } };
  /**
   * The moment this provider started up: jobs updated earlier than it but not yet finished are left
   * over from the previous process
   */
  const bootAt = now();

  /** Running one-click workflows (this process): jobId -> status */
  const live = new Map();
  /** Only one one-click workflow per asset at any time: `project\0asset` -> jobId */
  const byMedia = new Map();
  const pending = new Set();
  let reserving = 0;
  let closing = false;
  let closePromise = null;

  /* ---------------------------------------------------------------- Authorization */

  const forbidden = (action) => new WorkflowToolError(
    action === 'write' ? 'This round has no permission to modify the project (read-only member, stopped, or switched to private), so the one-click workflow did not start.' : 'This round has no permission to read the project.',
    { code: 'workflow-forbidden', status: 403 });
  const upstream = () => new WorkflowToolError('The document service is temporarily unreachable, so permissions for this turn cannot be confirmed. Try again later.', { code: 'authority-unavailable', status: 503 });
  /**
   * Unify authorization/ledger-layer errors into errors for the model: separate 403 and 503, without
   * disclosing more
   */
  function authError(error, action) {
    if (error instanceof WorkflowToolError) return error;
    if (AUTH_UNAVAILABLE.has(error?.code)) return upstream();
    return forbidden(action);
  }
  /**
   * Ledger-layer (ToolJobs) errors: report authorization errors as authorization, and report others
   * faithfully as ledger issues
   */
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

  /* ---------------------------------------------------------------- Workspace index (stage status, subjob IDs, human-readable reasons) */

  function readIndexFile(ws, file) {
    try {
      if (!ws.exists(file)) return [];
      const rows = JSON.parse(ws.read(file, { maxBytes: 1024 * 1024 }).toString('utf8'));
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    } catch { return []; }
  }
  /**
   * Write to a temporary file first then rename: if the process dies midway, the old index remains
   * intact
   */
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

  /* ---------------------------------------------------------------- Human-readable text for jobs */

  /**
   * Why jobs from other packages failed: host-injected first, then transcription table, then message
   * written by shots/subject in workspace index, finally generic descriptions
   */
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

  /**
   * Non-terminal jobs in the ledger updated earlier than this provider's startup and not running in
   * this process: left over from the previous process, reported as "interrupted"
   */
  function effectiveState(ledger) {
    if (TERMINAL.has(ledger.state)) return { state: ledger.state, errorCode: ledger.errorCode };
    if (ledger.updatedAt < bootAt && !live.has(ledger.jobId)) return { state: 'interrupted', errorCode: ledger.errorCode ?? 'INTERRUPTED_ON_RESTART' };
    return { state: ledger.state, errorCode: ledger.errorCode };
  }

  /**
   * Job status presented to the model (ledger + human-readable text); `done` / `ok` / `error` are
   * synonymous with desktop app background_job_status
   */
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

  /* ---------------------------------------------------------------- One-click workflow status view */

  const blankStages = () => Object.fromEntries(WORKFLOW_STAGES.map((s) => [s, { status: 'pending' }]));

  function stageList(row, terminalState) {
    const stages = row?.stages ?? blankStages();
    return WORKFLOW_STAGES.map((name) => {
      const s = { ...(stages[name] ?? { status: 'pending' }) };
      // The ledger says overall execution has stopped, but this stage in the index is still marked
      // "in-progress" (process died before writing index, or authorization revoked): report according to
      // overall outcome
      if (s.status === 'running' && terminalState && terminalState !== 'done') s.status = terminalState === 'error' ? 'error' : terminalState;
      return { stage: name, label: WORKFLOW_STAGE_LABEL[name], ...s };
    });
  }

  function phaseText(view, stages) {
    if (view.state === 'done') return 'Completed';
    if (view.state === 'cancelled') return 'Cancelled';
    if (view.state === 'interrupted') return 'Interrupted';
    if (view.state === 'error') return 'Failed';
    const current = stages.find((s) => s.status === 'running') ?? stages.find((s) => s.stage === view.stage);
    const names = { transcribe: 'Transcribing', shots: 'Detecting shots', subjects: 'Detecting subjects', compose: 'Composing cards', prerender: 'Publishing prerender' };
    return current ? (names[current.stage] ?? 'In progress') : 'Queued';
  }

  /**
   * Overall description for one-click workflow: indicates which stage stopped and subsequent
   * unexecuted stages upon failure/interruption/cancellation
   */
  function workflowError(view, stages, row) {
    if (view.state === 'done' || !TERMINAL.has(view.state)) return null;
    const at = stages.find((s) => ['error', 'unavailable', 'cancelled', 'interrupted'].includes(s.status)) ?? stages.find((s) => s.stage === view.stage);
    const where = at ? `the "${at.label}" stage` : 'a stage';
    const notDone = stages.filter((s) => s.status === 'pending').map((s) => s.label);
    const after = notDone.length ? `Later stages (${notDone.join(', ')}) were not run.` : '';
    let why = at?.reason;
    if (!why && view.errorCode && WORKFLOW_ERROR_TEXT[view.errorCode]) why = WORKFLOW_ERROR_TEXT[view.errorCode];
    const verb = { error: 'failed', cancelled: 'was cancelled', interrupted: 'was interrupted' }[view.state];
    const resume = view.state === 'error' && at?.status === 'unavailable' ? '' : 'Call auto_workflow again to continue: stages that are already done (transcript, shots, subjects) will be reused directly.';
    return [`The one-click workflow at ${where} ${verb}${why ? `: ${String(why).trim().replace(/\.+$/, '')}.` : '.'}`, after, resume].filter(Boolean).join(' ');
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

  /* ---------------------------------------------------------------- Ledger writes (including checkpoints when "shared read" becomes retained) */

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

  /**
   * Start job: start only one for identical requests in the same message; if the previous one has
   * already failed/cancelled/interrupted, allow reinitiating with a new request id
   */
  async function startJob(context, digest, base) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const started = await jobs.start(context, WORKFLOW_JOB_KIND, digest, `${base}-${attempt}`.slice(0, 128));
      if (!BAD_JOB.has(started.state)) return started;
    }
    throw new WorkflowToolError('The same request has already failed several times; change the parameters or try again later.', { code: 'too-many-attempts', status: 429 });
  }

  /* ---------------------------------------------------------------- Stages */

  /** Outcome of a stage (not an exception) */
  const outcome = (status, extra = {}) => ({ status, ...extra });
  /** A stage did not succeed; the workflow stops here */
  class StageStop extends Error {
    constructor(terminal, code, reason, extra = {}) { super(reason); this.terminal = terminal; this.code = code; this.reason = reason; this.extra = extra; }
  }
  /** Authorization for this round was revoked / service shutting down / canceled: not a stage's own failure */
  class Halt extends Error {
    constructor(kind) { super(kind); this.kind = kind; }
  }

  function checkHalt(job) {
    if (job.stopReason === 'close' || closing) throw new Halt('close');
    if (job.stopReason === 'cancel') throw new Halt('cancel');
    if (job.signal.aborted) throw new Halt('fence');
  }

  /**
   * Wait for a sub-job to finish in the ledger. Sub-job progress maps to this stage's span on the
   * overall progress bar
   */
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
        try { await provider?.cancel?.(job.context, childJobId); } catch { /* If it cannot be canceled, leave it to its own timeout */ }
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

  /** After the sub-job finishes: return null on success, otherwise throw this stage's stop reason */
  function childVerdict(job, name, ledger, ws) {
    if (ledger.state === 'done') return null;
    const reason = reasonOf(ledger, ws) ?? WORKFLOW_ERROR_TEXT[`STAGE_${ledger.state.toUpperCase()}`];
    const kind = ledger.state === 'cancelled' ? 'cancelled' : ledger.state === 'interrupted' ? 'interrupted' : 'error';
    const code = kind === 'cancelled' ? 'STAGE_CANCELLED' : kind === 'interrupted' ? 'STAGE_INTERRUPTED' : 'STAGE_FAILED';
    throw new StageStop(kind, code, reason, { childJobId: ledger.jobId, childErrorCode: ledger.errorCode ?? null });
  }

  /** Call a perception package provider and wait for its job to finish. Shared by three perception stages */
  async function perceptionStage(job, name, { providerKey, tool, label, reused, skipped, dataReady }) {
    const media = await project.getMedia(job.context, job.mediaId);
    if (!media) throw new StageStop('error', 'MEDIA_MISSING', WORKFLOW_ERROR_TEXT.MEDIA_MISSING);
    const skip = skipped(media);
    if (skip) return outcome('skipped', { reason: skip });
    if (reused(media)) return outcome('reused', { reason: 'The project already has the result of this step, so it is reused directly.' });
    const provider = providers[providerKey];
    if (!provider || typeof provider.call !== 'function') {
      return outcome('unavailable', { reason: `This cloud node is not connected to ${label.toLowerCase()}.` });
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
    // Job reports completed: only counts if results exist in the project (otherwise commit step failed,
    // cannot fake completion)
    const after = await project.getMedia(job.context, job.mediaId);
    if (!after || !dataReady(after)) throw new StageStop('error', 'STAGE_FAILED', `The job for ${label.toLowerCase()} shows as complete, but its result was not found in the project.`, { childJobId });
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
      skipped: (m) => (m.kind !== 'video' ? `${m.kind === 'audio' ? 'Audio' : 'This media'} is not a video, so there are no shots to split.` : null),
      reused: (m) => !!m.shots,
      dataReady: (m) => !!m.shots,
    }),
    subjects: (job) => perceptionStage(job, 'subjects', {
      providerKey: 'subject', tool: 'detect_subjects', label: 'Subject detection',
      skipped: (m) => (m.kind === 'audio' ? 'Audio has no picture to view.' : null),
      reused: (m) => !!m.subjects,
      dataReady: (m) => !!m.subjects,
    }),
    compose: (job) => composeStage(job),
    prerender: (job) => prerenderStage(job),
  };

  /**
   * Generate captions and cards: read transcript and timeline, compute plan, commit once (with
   * expected project version)
   */
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
      // Recheck write permissions before commit (halt if revoked, do not commit); host commit rechecks
      // under document service version expectation and operation fence
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
        throw new StageStop('error', 'COMMIT_FAILED', error?.message ? `${WORKFLOW_ERROR_TEXT.COMMIT_FAILED.replace(/\.$/, '')} (${String(error.message).trim().replace(/\.$/, '').slice(0, 160)}).` : WORKFLOW_ERROR_TEXT.COMMIT_FAILED);
      }
      job.row.committed = true;
      return outcome(applied?.alreadyApplied ? 'reused' : 'done', {
        reason: applied?.alreadyApplied ? 'The captions and cards for this transcript are already in the project, so they were not placed again.' : undefined,
        plan, applied,
      });
    }
    throw new StageStop('error', 'PROJECT_CHANGED', WORKFLOW_ERROR_TEXT.PROJECT_CHANGED);
  }

  /**
   * Publish prerender task: cloud has no page; host hands this step across seam to Agent service
   * prerender publishing
   */
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
      throw new StageStop('error', 'PUBLISH_FAILED', `${WORKFLOW_ERROR_TEXT.PUBLISH_FAILED.replace(/\.$/, '')} (${String(error?.message ?? error).trim().replace(/\.$/, '').slice(0, 160)}).`);
    }
    if (reply?.published === true) return outcome('done', { reason: 'Handed the affected clips to the prerender task for publishing (sent after a few seconds; render results are recorded in the chat events).', planned: reply.planned });
    return outcome('unavailable', { reason: typeof reply?.reason === 'string' && reply.reason ? reply.reason : 'This project has no available render node right now, so the prerender task was not published.' });
  }

  /** Child process/commit auth error: halt if authorization was truly revoked; do not treat as stage failure */
  async function revokedCheck(job) {
    try { await resources.authorize(job.context, 'write'); } catch { throw new Halt('fence'); }
    checkHalt(job);
  }

  /* ---------------------------------------------------------------- One-click workflow core */

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

  /**
   * Finalize ledger: do not throw if unwritable (auth revoked); fence cancellation handled by host's
   * `cancelForFence`
   */
  async function finishLedger(job, patch) {
    try { await patchJob(job.state, patch); } catch { /* Hand over to host */ }
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
      catch { return; }                                             // No permission for this round: hand ledger over to host cancellation
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
      // Unexpected stop: auth errors mean permission was revoked (state handed to host); others are this
      // workflow's own failure
      if (REVOKED.test(String(error?.code ?? '')) || AUTH_UNAVAILABLE.has(error?.code) || error?.name === 'AbortError') return;
      say('agent.workflow.crashed', { message: String(error?.message ?? error).slice(0, 160) });
      const cur = WORKFLOW_STAGES.find((s) => job.row.stages[s]?.status === 'running');
      if (cur) job.row.stages[cur] = { ...job.row.stages[cur], status: 'error', reason: 'The one-click workflow itself failed.', finishedAt: now() };
      await finishRow(job, { status: 'error', errorCode: 'STAGE_FAILED' });
      await finishLedger(job, { state: 'error', errorCode: 'STAGE_FAILED' });
    } finally {
      try { handle.destroy(); } catch { /* Already closed */ }
      if (registration) await Promise.race([registration.closed.catch(() => {}), sleep(5_000).catch(() => {})]);
    }
  }

  /** Keep only plan summary in index (full card parameters do not enter index) */
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
      // Newly registered jobs do not stay in queue: mark as "interrupted" so restart doesn't look like
      // still waiting
      if (started.state === 'queued') await jobs.update(context, started.jobId, 0, { state: 'interrupted', errorCode: 'SERVICE_CLOSING' }).catch(() => {});
      throw new WorkflowToolError('The Cloud Agent service is shutting down, and the one-click workflow no longer accepts new work.', { code: 'workflow-closed', status: 503 });
    }
    if (started.state !== 'queued' || live.has(started.jobId)) {
      // Retry of same request: job already started (may be running or finished), do not start a second one
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

    // Same as desktop app: wait briefly; if finished return full result, otherwise return jobId first
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

  /* ---------------------------------------------------------------- State */

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

  /* ---------------------------------------------------------------- External */

  async function call(name, args, context, options = {}) {
    if (!handles.has(name)) throw new WorkflowToolError(`The one-click workflow does not handle ${name}.`, { code: 'unknown-tool', status: 404 });
    if (name === 'background_job_status') return backgroundJobStatus(args, context);
    if (name === 'auto_workflow_status') return autoWorkflowStatus(args, context);
    return autoWorkflow(args, context, options);
  }

  /**
   * Explicitly cancel a running one-click workflow (for host and tests, not a model tool): stop stage
   * and halt progress, requesting the provider to cancel waiting sub-jobs as well.
   * Stopping this round, making private, or Agent shutdown uses runtime resource registry abort
   * signals, not this path.
   */
  async function cancel(context, jobId) {
    await authorize(context, 'write');
    const job = live.get(jobId);
    if (!job || job.conversationId !== context.conversationId || job.context.projectId !== context.projectId) return { cancelled: false };
    job.stopReason ??= 'cancel';
    const child = job.child;
    job.signalOwn.abort('cancel');
    if (child) { try { await child.provider?.cancel?.(job.context, child.jobId); } catch { /* Sub-jobs have their own timeouts */ } }
    await job.done;
    return { cancelled: true };
  }

  /**
   * Close: reject new calls, stop all running one-click workflows (record "interrupted" in ledger),
   * and wait for them to finalize.
   * Child processes belong to each perception package and are killed by their own `close()`; the host
   * must close this provider first, then them, so no workflow tries to proceed after sub-packages close.
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
