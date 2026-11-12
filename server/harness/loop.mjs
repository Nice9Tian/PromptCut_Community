import { Agent } from './agent.mjs';
import { MessageHistory } from './history.mjs';
import * as P from './loop-prompts.mjs';

/**
 * Review loop: judger opens by setting requirements → worker executes → reviewer reviews →
 * judger delivers verdict.
 *
 * Only judger can declare completion (phase_done). If worker fails three times in a row, on the
 * fourth time it does no work and reflects instead; after judger reads the reflection, it rewrites
 * requirements and checklist items, then provides another batch. If it reaches reflection a second
 * time, it stops and hands off to the user.
 *
 * Each box is a "role turn": its own system prompt, its own available tools, and its own history.
 * How a turn runs is determined by the backend: direct API is new Agent(...) (apiBackend in this
 * file), while command lines like agy spawn a CLI once (runners/cli-loop.mjs). The loop itself only
 * manages order and verdicts.
 *
 * worker switches to a new history segment each round and re-injects the user's original words:
 * truncation only pins the most recent user text message (history.mjs), and relying on worker to
 * retrieve original requirements from early history is unreliable.
 *
 * If a turn exhausts retries and is still interrupted (backend returns interrupted), the whole
 * loop is not invalidated: worker's changes are still handed to reviewer / judger for verification
 * and counted as a failure; if reviewer is interrupted, judger verifies on its own. worker stops
 * only after being interrupted MAX_INTERRUPTS times in a row: that is mostly an environment issue,
 * and running further is just burning resources for nothing.
 */

const FAILS_PER_BATCH = 3;
const MAX_BATCHES = 2;
const ROLE_ROUNDS = 60;
const RETRIES = 2;
const WORKER_MIN_ROUNDS = 60;
const MAX_INTERRUPTS = 2;
const RETRY_PROMPT = 'The previous request was cut off by a gateway timeout. Your earlier progress is all still there; continue from where you stopped.';
const NUDGE_PROMPT = 'You have not submitted your conclusion as required. Submit it now.';

/** Uses the same rules as runners/api.mjs for deciding "resumable": only retry on timeout errors */
export const isTimeout = (err) => err?.name === 'TimeoutError' || /timeout|timed out|aborted due to timeout|no data received/i.test(String(err?.message || ''));

const str = (description) => ({ type: 'string', description });

/**
 * "submit" used by each turn to deliver conclusions. In direct API they are local tools (recording
 * parameters with a single call), while in CLI they are a code block at the end of the reply
 * (parsed by cli-loop.mjs). Defined only once here.
 */
export const SUBMIT_DEFS = {
  issue_plan: {
    description: 'Submit the task requirements for the worker and the checklist for the reviewer.',
    inputSchema: {
      type: 'object',
      properties: {
        requirements: str('Task requirements for the worker, with acceptance criteria written out item by item'),
        reviewerBrief: str('Checklist for the reviewer; for each item, state which tool to use, what to look at, and what counts as a failure'),
        lessons: { type: 'array', items: { type: 'string' }, description: '(When rewriting) the lessons you endorse, one sentence each' },
      },
      required: ['requirements', 'reviewerBrief'],
    },
  },
  submit_review: {
    description: 'Submit all review opinions. If there are no problems, submit an empty list.',
    inputSchema: {
      type: 'object',
      properties: {
        opinions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { issue: str('What the problem is'), evidence: str('Evidence: which tool, at which time t, what was seen') },
            required: ['issue', 'evidence'],
          },
        },
      },
      required: ['opinions'],
    },
  },
  phase_done: {
    description: 'Declare that this video passes and the loop ends. Submit only when evidence proves all four project requirements are met.',
    inputSchema: { type: 'object', properties: { summary: str('Evidence for each of the four project requirements') }, required: ['summary'] },
  },
  request_revision: {
    description: 'Judge this delivery as not passed and hand the per-item rulings and the next round\'s requirements to the worker.',
    inputSchema: {
      type: 'object',
      properties: {
        rulings: {
          type: 'array',
          description: 'Ruling on each reviewer opinion',
          items: {
            type: 'object',
            properties: {
              opinion: str('That reviewer opinion (may be abbreviated)'),
              verdict: { type: 'string', enum: ['Accept', 'Reject', 'downgrade'], description: 'Accept / Reject / Downgrade' },
              reason: str('Why this ruling was made'),
            },
            required: ['opinion', 'verdict', 'reason'],
          },
        },
        requirements: str('Requirements for the worker\'s next round, taken only from accepted and downgraded items'),
        reviewerBrief: str('(Optional) Rewritten checklist'),
      },
      required: ['rulings', 'requirements'],
    },
  },
  need_user: {
    description: 'When something must be handled or decided by the user (QR code login, captcha, a decision needed), explain why and stop.',
    inputSchema: { type: 'object', properties: { reason: str('What the user needs to do') }, required: ['reason'] },
  },
};

/**
 * Role turn for direct API: new Agent(...), with submit implemented as local recording tools.
 *
 * access: 'all' all tools / 'readonly' read-only allowlist / 'none' no tools given (reflection).
 * session: history object returned from previous turn; passed back to continue conversation from
 * that history (used when judger is nudged once).
 */
export function apiBackend(o, onRoleEvent) {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const readOnly = P.READ_ONLY_TOOLS.map((n) => byName.get(n)).filter(Boolean);
  const everything = o.tools.filter((t) => !SUBMIT_DEFS[t.name]);
  /*
   * worker gets at least 60 round trips per round. The limit for regular chat is 24; in real runs,
   * worker hit it on its first delivery and was truncated before "final visual check", and the
   * half-finished artifact produced by truncation is precisely what this loop is meant to cure.
   * If deep autonomy specifies a larger value (or unlimited), use that instead.
   */
  const workerRounds = Math.max(o.maxIterations ?? 0, WORKER_MIN_ROUNDS);

  return {
    async runRole(role, { system, prompt, access, submit = [], session }) {
      let submitted = null;
      const recorders = submit.map((name) => ({
        name, description: SUBMIT_DEFS[name].description, inputSchema: SUBMIT_DEFS[name].inputSchema,
        async execute(input) {
          if (submitted) return { ok: false, error: 'This round has already been submitted. Do not call again. Just finish with one sentence.' };
          submitted = { name, input };
          return { ok: true, recorded: true, next: 'Recorded. This round ends here. Do not call any more tools. Just finish with one sentence.' };
        },
      }));
      const base = access === 'all' ? everything : access === 'readonly' ? readOnly : [];
      const history = session || new MessageHistory({ maxChars: Infinity });
      const agent = new Agent({
        provider: o.providers?.[role] || o.provider, system, tools: [...base, ...recorders],
        maxIterations: role === 'worker' && access === 'all' ? workerRounds : ROLE_ROUNDS,
        deepAuto: o.deepAuto, maxInputTokens: o.maxInputTokens || 0, signal: o.signal, history, codeCache: o.codeCache ?? null,
        toolNameMapper: o.toolNameMapper ?? null,
        onEvent: (ev) => onRoleEvent(role, ev),
      });
      /*
       * When upstream gets stuck (idle timeout), request again from this history segment instead of
       * letting the exception bubble up to terminate the entire loop. The loop runs for a dozen minutes;
       * invalidating all preceding roles' progress over a single gateway stall is too costly.
       * Do not retry if the user clicks stop (signal.aborted); retry at most RETRIES times for the
       * same turn.
       */
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await agent.run(attempt === 0 ? prompt : RETRY_PROMPT);
          break;
        } catch (err) {
          if (o.signal?.aborted || attempt >= RETRIES || !isTimeout(err)) throw err;
          onRoleEvent(role, { type: 'loop', stage: 'retry', role, attempt: attempt + 1, reason: String(err?.message || err) });
        }
      }
      return { text: res.text, submitted, session: history, usage: res.usage, completed: res.completed, failed: res.failed };
    },
  };
}

const ROLE_LABEL = { judger: 'judger', worker: 'worker', reviewer: 'reviewer' };

/**
 * Translates raw loop events into the types recognized by the chat panel (text / thinking /
 * status / progress …), so the frontend needs no changes:
 * - Phase transitions, each verdict → status line; list verdicts item by item so the user sees at
 *   a glance why it failed;
 * - Words spoken by reviewer / judger → thinking (collapsed section), not mixed into reply body;
 * - worker's delivery and loop's final conclusion → text;
 * - Prepend the role to the progress text.
 */
export function presentLoopEvent(ev) {
  if (ev.type === 'loop') {
    const role = ROLE_LABEL[ev.role] || '';
    switch (ev.stage) {
      case 'plan': return [{ type: 'status', text: 'Review loop · judger is looking at the project and setting the task requirements and checklist' }];
      case 'work': return [{ type: 'status', text: `worker starts delivery #${ev.attempt}${ev.batch > 1 ? ` (batch ${ev.batch})` : ''}` }];
      case 'review': return [{ type: 'status', text: 'reviewer is reviewing against the checklist' }];
      case 'judging': return [{ type: 'status', text: 'judger is ruling on the reviewer\'s opinions one by one' }];
      case 'verdict': {
        if (ev.verdict === 'phase_done') return [{ type: 'status', text: 'judger: passed' }];
        if (ev.verdict === 'need_user') return [{ type: 'status', text: 'judger: needs your decision' }];
        if (ev.verdict !== 'request_revision') return [{ type: 'status', text: 'judger gave no verdict, treating as not passed' }];
        const rulings = ev.input?.rulings || [];
        /*
         * Can also rule as failed without item-by-item verdicts: judger checks on its own using read-only
         * tools and discovers issues outside reviewer's feedback (actual run: worker's summary claimed it
         * was done, but nothing was actually touched in the project). In this case, "0 accepted" reads like
         * nothing happened, so change to directly lay out judger's requirements.
         */
        if (!rulings.length) {
          const first = String(ev.input?.requirements || '').split('\n').map((s) => s.trim()).find(Boolean) || '(no requirements written)';
          return [{ type: 'status', text: `judger: not passed. It did not rule on the reviewer's opinions one by one; it checked on its own and requested rework:\n· ${first}` }];
        }
        const count = (v) => rulings.filter((r) => r.verdict === v).length;
        return [{
          type: 'status',
          text: [`judger: not passed. ${count('Accept')} accepted, ${count('downgrade')} downgraded, ${count('Reject')} rejected`,
            ...rulings.map((r) => `· [${r.verdict}] ${r.opinion} —— ${r.reason}`)].join('\n'),
        }];
      }
      case 'stalled': return [{ type: 'status', text: 'Stuck on the same problem twice in a row, entering reflection early' }];
      case 'retry': {
        // Direct API is mostly gateway timeouts; for CLI, interruptions like its built-in tools being
        // rejected are more common, so phrase it accurately
        const why = !ev.reason || isTimeout({ message: ev.reason }) ? 'the request gateway timed out' : 'was interrupted';
        return [{ type: 'status', text: `${role}: this round ${why}, retrying from the previous progress (attempt ${ev.attempt})` }];
      }
      case 'interrupted': return [{ type: 'status', text: ev.role === 'worker'
        ? 'worker was still interrupted after using up its retries. Not voiding the whole task; handing the changes it has already made to the reviewer and judger to check'
        : `${role} was still interrupted after using up its retries. Not voiding the whole task, moving on` }];
      case 'reflect': return [{ type: 'status', text: 'worker failed several times in a row, so this round does no work and reflects first' }];
      case 'rewrite': return [{ type: 'status', text: 'judger has read the reflection and is rewriting the task requirements and checklist' }];
      default: return [];
    }
  }
  if (ev.type === 'text' && (ev.role === 'reviewer' || ev.role === 'judger')) return [{ type: 'thinking', delta: ev.delta, round: ev.round }];
  if (ev.type === 'text' && ev.role === 'loop') return [{ type: 'text', delta: `\n\n${ev.delta}` }];
  if (ev.type === 'progress' && ev.role && ev.text) return [{ ...ev, text: `${ROLE_LABEL[ev.role] || ev.role} · ${ev.text}` }];
  return [ev];
}

const signature = (rulings) => (rulings || [])
  .filter((r) => r.verdict !== 'Reject')
  .map((r) => String(r.opinion || '').replace(/\s+/g, ''))
  .sort()
  .join('|');

/**
 * @param {object} o
 * @param {Function} [o.backendFactory] (onRoleEvent) => { runRole }. Defaults to apiBackend,
 *                                     which requires o.provider (can be overridden per role via
 *                                     o.providers) and o.tools
 * @param {string} o.system             System prompt for the editor (used by worker)
 * @param {string} o.userText           This user message
 * @param {object} [o.lessonsStore]     { read(): string[], add(list) } persists lessons across runs
 * @param {MessageHistory} [o.history]  Session history: records only user's original words and the
 *                                     loop's final conclusion, for subsequent messages to continue
 */
export async function runReviewLoop(o) {
  const { system, userText, onEvent = () => {} } = o;
  const lessons = [...(o.lessonsStore?.read?.() || [])];
  const newLessons = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const toolCounts = {};
  let completed = 0, failed = 0;
  const say = (ev) => onEvent({ type: 'loop', ...ev });

  const onRoleEvent = (role, ev) => {
    if (role === 'worker' && ev.type === 'tool_call') toolCounts[ev.name] = (toolCounts[ev.name] || 0) + 1;
    onEvent(ev.type === 'loop' ? ev : { ...ev, role });
  };
  const backend = o.backendFactory ? o.backendFactory(onRoleEvent) : apiBackend(o, onRoleEvent);

  async function run(role, args) {
    const res = await backend.runRole(role, args);
    for (const k of Object.keys(usage)) usage[k] += Number(res.usage?.[k]) || 0;
    completed += res.completed || 0; failed += res.failed || 0;
    if (res.interrupted) say({ stage: 'interrupted', role, reason: res.interrupted });
    return res;
  }

  /** judger turn: must deliver one of submit; nudged once if not delivered, returns null if still not delivered */
  async function judgerTurn(stage, prompt, submit) {
    say({ stage, role: 'judger' });
    const sys = P.judgerSystem({ lessons: [...lessons, ...newLessons] });
    const first = await run('judger', { system: sys, prompt, access: 'readonly', submit });
    if (first.submitted) return first.submitted;
    const again = await run('judger', { system: sys, prompt: NUDGE_PROMPT, access: 'readonly', submit, session: first.session });
    return again.submitted || null;
  }

  const finish = (outcome, text) => {
    if (newLessons.length) o.lessonsStore?.add?.(newLessons);
    if (o.history) {
      o.history.appendUserText(userText);
      o.history.append({ role: 'assistant', content: [{ type: 'text', text }] });
    }
    say({ stage: 'done', outcome });
    onEvent({ type: 'text', delta: text, role: 'loop' });
    return { outcome, text, usage, completed, failed, lessons: newLessons };
  };

  // ── judger opening ──
  const plan = await judgerTurn('plan', P.judgerOpenPrompt({ userText }), ['issue_plan']);
  if (!plan) return finish('no_plan', 'judger could not produce task requirements and a checklist, so the loop did not start. You can rephrase and send it again.');
  let requirements = plan.input.requirements;
  let brief = plan.input.reviewerBrief;

  const reflections = [];
  let interrupts = 0;
  for (let batch = 1; batch <= MAX_BATCHES; batch++) {
    const verdicts = [];
    let prevSig = null;

    while (verdicts.length < FAILS_PER_BATCH) {
      // ── worker ──
      say({ stage: 'work', role: 'worker', batch, attempt: verdicts.length + 1 });
      const work = await run('worker', {
        system: system + P.WORKER_RULES, access: 'all', submit: ['need_user'],
        prompt: P.workerPrompt({ userText, requirements, lessons: [...lessons, ...newLessons] }),
      });
      if (work.submitted?.name === 'need_user') return finish('need_user', `You need to handle this: ${work.submitted.input.reason}`);
      interrupts = work.interrupted ? interrupts + 1 : 0;
      if (interrupts >= MAX_INTERRUPTS) {
        return finish('interrupted', [
          `worker was interrupted by technical causes for ${interrupts} rounds in a row, so the loop stops for now. Reason for the last one:`,
          work.interrupted,
          '',
          'Changes already made earlier are still in the project. After you deal with the reason above, send another message to continue.',
        ].join('\n'));
      }
      // An interrupted worker mostly wrote no delivery summary, but project changes made before
      // interruption are real: hand them to subsequent roles to verify against current project state
      const delivery = work.interrupted
        ? [`(worker was interrupted by technical causes this round and could not finish the delivery summary. Reason: ${work.interrupted})`,
          'The changes it made to the project before the interruption are still there. Please verify the current state of the project directly with read-only tools.',
          work.text?.trim() ? `\nBefore the interruption it said:\n${work.text.trim()}` : ''].join('\n')
        : work.text;

      // ── reviewer ──
      say({ stage: 'review', role: 'reviewer' });
      const review = await run('reviewer', {
        system: P.REVIEWER_SYSTEM, access: 'readonly', submit: ['submit_review'],
        prompt: P.reviewerPrompt({ brief, userText, delivery }),
      });
      const opinions = review.submitted?.input?.opinions
        ?? (!review.interrupted && review.text?.trim() ? [{ issue: review.text.trim(), evidence: '(reviewer did not submit in the required format; this is its original text)' }] : []);

      // ── judger verdict ──
      // Opening announcement uses judging: previously also named verdict, and when a verdict event lacked
      // a ruling result it displayed as "judger gave no verdict":
      // this line appeared out of nowhere before each round of verdicts, looking as if judger needed a
      // nudge every single time before delivering
      const verdict = await judgerTurn('judging', P.judgerVerdictPrompt({
        userText, requirements, delivery, opinions, reviewerInterrupted: !!review.interrupted && !review.submitted,
      }), ['phase_done', 'request_revision', 'need_user']);
      say({ stage: 'verdict', role: 'judger', verdict: verdict?.name || 'none', input: verdict?.input });

      if (verdict?.name === 'phase_done') {
        return finish('passed', `judger judged this as passed.\n\n${verdict.input.summary}`);
      }
      if (verdict?.name === 'need_user') {
        return finish('need_user', `judger needs your decision: ${verdict.input.reason}`);
      }
      const rulings = verdict?.input?.rulings || [{ opinion: '(none)', verdict: 'Accept', reason: 'judger gave no ruling' }];
      verdicts.push({ rulings, requirements: verdict?.input?.requirements || requirements });
      if (verdict?.input?.requirements) requirements = verdict.input.requirements;
      if (verdict?.input?.reviewerBrief) brief = verdict.input.reviewerBrief;

      // Gaps in two consecutive verdicts are identical: stuck, do not wait for three times, reflect early
      const sig = signature(rulings);
      if (sig && sig === prevSig) { say({ stage: 'stalled', role: 'judger' }); break; }
      prevSig = sig;
    }

    // ── worker reflection (no tools given) ──
    say({ stage: 'reflect', role: 'worker', batch });
    const reflect = await run('worker', { system: system + P.WORKER_RULES, access: 'none', submit: [], prompt: P.reflectPrompt({ verdicts, toolCounts }) });
    reflections.push(reflect.text);

    if (batch === MAX_BATCHES) {
      const last = verdicts[verdicts.length - 1];
      return finish('exhausted', [
        `This video failed the judger's ruling in both batches. The loop stops and leaves the call to you.`,
        '', 'Last ruling:',
        ...(last?.rulings || []).map((r) => `- [${r.verdict}] ${r.opinion} —— ${r.reason}`),
        '', ...reflections.map((r, i) => `Reflection #${i + 1}:\n${r}`),
      ].join('\n'));
    }

    // ── judger rewrite ──
    const plan2 = await judgerTurn('rewrite', P.judgerRewritePrompt({ userText, reflection: reflect.text, verdicts }), ['issue_plan']);
    if (plan2) {
      requirements = plan2.input.requirements;
      brief = plan2.input.reviewerBrief;
      for (const l of plan2.input.lessons || []) if (l && !newLessons.includes(l)) newLessons.push(l);
    }
  }
  return finish('exhausted', 'The loop has ended.');
}
