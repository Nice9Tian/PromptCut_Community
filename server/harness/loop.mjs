import { Agent } from './agent.mjs';
import { MessageHistory } from './history.mjs';
import * as P from './loop-prompts.mjs';

/**
 * 审查环路:judger 开场定要求 → worker 执行 → reviewer 审查 → judger 裁决。
 *
 * 只有 judger 能宣布完成(phase_done)。worker 连续失败三次,第四次不干活、改为反省,
 * judger 读完反省改写要求和检查项,再给一批。第二次走到反省就停下,交给用户。
 *
 * 每个方框是一个「角色回合」:各自的系统提示、各自能用的工具、各自的历史。
 * 回合怎么跑由后端决定 —— API 直连是 new Agent(...)(本文件的 apiBackend),
 * agy 这类命令行是起一次 CLI(runners/cli-loop.mjs)。环路本身只管顺序和裁决。
 *
 * worker 每一轮都换一段新的历史并重新注入用户原话 —— 截断只钉住最近一条用户文字消息
 * (history.mjs),指望 worker 从早期历史里翻回原始需求是靠不住的。
 *
 * 某个回合重试用完仍然中断(后端交回 interrupted),不作废整个环路:worker 的改动照样交给
 * reviewer / judger 核对、算一次没通过;reviewer 中断就让 judger 自己核对。worker 连着中断
 * MAX_INTERRUPTS 次才停下 —— 那多半是环境问题,再跑只是空烧。
 */

const FAILS_PER_BATCH = 3;
const MAX_BATCHES = 2;
const ROLE_ROUNDS = 60;
const RETRIES = 2;
const WORKER_MIN_ROUNDS = 60;
const MAX_INTERRUPTS = 2;
const RETRY_PROMPT = '上一次请求因为网关超时断了。之前的进度都还在,接着刚才停下的地方继续做。';
const NUDGE_PROMPT = '你还没有按规定交出结论。现在就交。';

/** 和 runners/api.mjs 判「可续跑」用的是同一套:超时类的错误才重试 */
export const isTimeout = (err) => err?.name === 'TimeoutError' || /timeout|timed out|aborted due to timeout|没有收到任何数据/i.test(String(err?.message || ''));

const str = (description) => ({ type: 'string', description });

/**
 * 各回合交结论用的「提交」。API 直连里它们是本地工具(调一次就记下参数),
 * 命令行里是回复末尾的一个代码块(cli-loop.mjs 解析)。定义只写这一份。
 */
export const SUBMIT_DEFS = {
  issue_plan: {
    description: '交出给 worker 的任务要求和给 reviewer 的检查项。',
    inputSchema: {
      type: 'object',
      properties: {
        requirements: str('给 worker 的任务要求,逐条写清验收标准'),
        reviewerBrief: str('给 reviewer 的检查项,每项写明用什么工具、看什么、什么算不合格'),
        lessons: { type: 'array', items: { type: 'string' }, description: '(改写时)你认可的教训,一条一句' },
      },
      required: ['requirements', 'reviewerBrief'],
    },
  },
  submit_review: {
    description: '交出全部审查意见。没有问题就交空列表。',
    inputSchema: {
      type: 'object',
      properties: {
        opinions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { issue: str('问题是什么'), evidence: str('依据:哪个工具、哪个时刻 t、看到了什么') },
            required: ['issue', 'evidence'],
          },
        },
      },
      required: ['opinions'],
    },
  },
  phase_done: {
    description: '宣布这条片子通过、环路结束。只有四条项目要求都有依据证明达到时才交。',
    inputSchema: { type: 'object', properties: { summary: str('四条项目要求各自的依据') }, required: ['summary'] },
  },
  request_revision: {
    description: '判定这次交付不通过,把逐条裁定和下一轮要求交给 worker。',
    inputSchema: {
      type: 'object',
      properties: {
        rulings: {
          type: 'array',
          description: '对 reviewer 每一条意见的裁定',
          items: {
            type: 'object',
            properties: {
              opinion: str('reviewer 的那条意见(可以缩写)'),
              verdict: { type: 'string', enum: ['采纳', '驳回', '降级'], description: '采纳 / 驳回 / 降级' },
              reason: str('为什么这样裁定'),
            },
            required: ['opinion', 'verdict', 'reason'],
          },
        },
        requirements: str('给 worker 的下一轮要求,只来自采纳和降级的条目'),
        reviewerBrief: str('(可选)改写后的检查项'),
      },
      required: ['rulings', 'requirements'],
    },
  },
  need_user: {
    description: '遇到必须由用户处理或决定的事(扫码登录、验证码、需要拍板),说明原因后停下。',
    inputSchema: { type: 'object', properties: { reason: str('要用户做什么') }, required: ['reason'] },
  },
};

/**
 * API 直连的角色回合:new Agent(...),提交做成本地的记录型工具。
 *
 * access:'all' 全部工具 / 'readonly' 只读白名单 / 'none' 一个工具都不给(反省)。
 * session:上一次回合返回的历史对象,传回来就接着那段历史说(judger 被推一次时用)。
 */
export function apiBackend(o, onRoleEvent) {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const readOnly = P.READ_ONLY_TOOLS.map((n) => byName.get(n)).filter(Boolean);
  const everything = o.tools.filter((t) => !SUBMIT_DEFS[t.name]);
  /*
   * worker 每轮至少 60 次往返。常规对话的上限是 24,实跑里 worker 第一次交付就撞上它、
   * 在「最后核对画面」之前被截断 —— 而截断出来的半成品正是这个环路要治的病。
   * 深度自主给的更大(或不限)就用那个。
   */
  const workerRounds = Math.max(o.maxIterations ?? 0, WORKER_MIN_ROUNDS);

  return {
    async runRole(role, { system, prompt, access, submit = [], session }) {
      let submitted = null;
      const recorders = submit.map((name) => ({
        name, description: SUBMIT_DEFS[name].description, inputSchema: SUBMIT_DEFS[name].inputSchema,
        async execute(input) {
          if (submitted) return { ok: false, error: '这一回合已经交过了,不要重复调用。用一句话收尾即可。' };
          submitted = { name, input };
          return { ok: true, recorded: true, next: '已记录。本回合到此结束,不要再调用任何工具,用一句话收尾即可。' };
        },
      }));
      const base = access === 'all' ? everything : access === 'readonly' ? readOnly : [];
      const history = session || new MessageHistory({ maxChars: Infinity });
      const agent = new Agent({
        provider: o.providers?.[role] || o.provider, system, tools: [...base, ...recorders],
        maxIterations: role === 'worker' && access === 'all' ? workerRounds : ROLE_ROUNDS,
        deepAuto: o.deepAuto, maxInputTokens: o.maxInputTokens || 0, signal: o.signal, history, codeCache: o.codeCache ?? null,
        onEvent: (ev) => onRoleEvent(role, ev),
      });
      /*
       * 上游卡住(闲置超时)时接着这一段历史再请求一次,而不是让异常冒出去结束整个环路。
       * 环路一跑十几分钟,一次网关卡顿就把前面所有角色的进度作废,代价太大。
       * 用户点停止(signal.aborted)不重试;同一个回合最多重试 RETRIES 次。
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
 * 把环路的原始事件翻成聊天栏认得的那几种(text / thinking / status / progress …),前端不用改:
 * - 阶段切换、每次裁决 → status 行,裁决逐条列出来,用户一眼看到为什么没过;
 * - reviewer / judger 说的话 → thinking(折叠区),不混进回复正文;
 * - worker 的交货和环路的最终结论 → text;
 * - progress 的文字前面加上角色。
 */
export function presentLoopEvent(ev) {
  if (ev.type === 'loop') {
    const role = ROLE_LABEL[ev.role] || '';
    switch (ev.stage) {
      case 'plan': return [{ type: 'status', text: '审查环路 · judger 正在看工程,定任务要求和检查项' }];
      case 'work': return [{ type: 'status', text: `worker 开始第 ${ev.attempt} 次交付${ev.batch > 1 ? `(第 ${ev.batch} 批)` : ''}` }];
      case 'review': return [{ type: 'status', text: 'reviewer 正在按检查项审查' }];
      case 'judging': return [{ type: 'status', text: 'judger 正在逐条裁定 reviewer 的意见' }];
      case 'verdict': {
        if (ev.verdict === 'phase_done') return [{ type: 'status', text: 'judger:通过' }];
        if (ev.verdict === 'need_user') return [{ type: 'status', text: 'judger:需要你来决定' }];
        if (ev.verdict !== 'request_revision') return [{ type: 'status', text: 'judger 没有给出裁决,按不通过处理' }];
        const rulings = ev.input?.rulings || [];
        /*
         * 没有逐条裁定也会判不通过:judger 自己用只读工具核对,发现问题在 reviewer 意见之外
         * (实跑:worker 的总结说做了,工程里其实没动)。这时「采纳 0 条」读起来像什么都没发生,
         * 改成直接把 judger 的要求摆出来。
         */
        if (!rulings.length) {
          const first = String(ev.input?.requirements || '').split('\n').map((s) => s.trim()).find(Boolean) || '(没写要求)';
          return [{ type: 'status', text: `judger:不通过 —— 没有逐条裁定 reviewer 的意见,是它自己核对后要求返工:\n· ${first}` }];
        }
        const count = (v) => rulings.filter((r) => r.verdict === v).length;
        return [{
          type: 'status',
          text: [`judger:不通过 —— 采纳 ${count('采纳')} 条、降级 ${count('降级')} 条、驳回 ${count('驳回')} 条`,
            ...rulings.map((r) => `· [${r.verdict}] ${r.opinion} —— ${r.reason}`)].join('\n'),
        }];
      }
      case 'stalled': return [{ type: 'status', text: '连续两次卡在同样的问题上,提前进入反省' }];
      case 'retry': {
        // API 直连多半是网关超时;CLI 那边更常见的是它自己的内建工具被拒这类中断,话要说对
        const why = !ev.reason || isTimeout({ message: ev.reason }) ? '请求网关超时' : '中断了';
        return [{ type: 'status', text: `${role} 这一轮${why},接着刚才的进度重试(第 ${ev.attempt} 次)` }];
      }
      case 'interrupted': return [{ type: 'status', text: ev.role === 'worker'
        ? 'worker 重试用完仍然中断 —— 不作废整个任务,把它已经做的改动交给 reviewer 和 judger 核对'
        : `${role} 重试用完仍然中断 —— 不作废整个任务,接着往下走` }];
      case 'reflect': return [{ type: 'status', text: 'worker 连续没通过,这一轮不干活,先反省' }];
      case 'rewrite': return [{ type: 'status', text: 'judger 读完反省,正在改写任务要求和检查项' }];
      default: return [];
    }
  }
  if (ev.type === 'text' && (ev.role === 'reviewer' || ev.role === 'judger')) return [{ type: 'thinking', delta: ev.delta, round: ev.round }];
  if (ev.type === 'text' && ev.role === 'loop') return [{ type: 'text', delta: `\n\n${ev.delta}` }];
  if (ev.type === 'progress' && ev.role && ev.text) return [{ ...ev, text: `${ROLE_LABEL[ev.role] || ev.role} · ${ev.text}` }];
  return [ev];
}

const signature = (rulings) => (rulings || [])
  .filter((r) => r.verdict !== '驳回')
  .map((r) => String(r.opinion || '').replace(/\s+/g, ''))
  .sort()
  .join('|');

/**
 * @param {object} o
 * @param {Function} [o.backendFactory] (onRoleEvent) => { runRole }。不给就用 apiBackend,
 *                                     那时需要 o.provider(可用 o.providers 按角色覆盖)和 o.tools
 * @param {string} o.system             编辑台的系统提示(worker 用)
 * @param {string} o.userText           用户这一条消息
 * @param {object} [o.lessonsStore]     { read(): string[], add(list) } 教训跨运行保存
 * @param {MessageHistory} [o.history]  会话历史:只记用户原话和环路的最终结论,供下一条消息接着聊
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

  /** judger 回合:必须交出 submit 里的某一个;没交就推一次,再不交返回 null */
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

  // ── judger 开场 ──
  const plan = await judgerTurn('plan', P.judgerOpenPrompt({ userText }), ['issue_plan']);
  if (!plan) return finish('no_plan', 'judger 没能给出任务要求和检查项,环路没有开始。可以换个说法再发一次。');
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
      if (work.submitted?.name === 'need_user') return finish('need_user', `需要你处理:${work.submitted.input.reason}`);
      interrupts = work.interrupted ? interrupts + 1 : 0;
      if (interrupts >= MAX_INTERRUPTS) {
        return finish('interrupted', [
          `worker 连续 ${interrupts} 轮都被技术原因打断,环路先停下。最后一次的原因:`,
          work.interrupted,
          '',
          '之前已经做过的改动都还在工程里。处理掉上面的原因后,再发一条消息就能接着做。',
        ].join('\n'));
      }
      // 中断的 worker 多半没写交货总结,但它中断前动过的工程是真的 —— 交给后面的人按工程现状核对
      const delivery = work.interrupted
        ? [`(worker 这一轮被技术原因打断,没能写完交货总结。原因:${work.interrupted})`,
          '它中断前对工程做的改动都还在,请直接用只读工具核对工程现状。',
          work.text?.trim() ? `\n它中断前说到:\n${work.text.trim()}` : ''].join('\n')
        : work.text;

      // ── reviewer ──
      say({ stage: 'review', role: 'reviewer' });
      const review = await run('reviewer', {
        system: P.REVIEWER_SYSTEM, access: 'readonly', submit: ['submit_review'],
        prompt: P.reviewerPrompt({ brief, userText, delivery }),
      });
      const opinions = review.submitted?.input?.opinions
        ?? (!review.interrupted && review.text?.trim() ? [{ issue: review.text.trim(), evidence: '(reviewer 没有按格式提交,这是它的原文)' }] : []);

      // ── judger 裁决 ──
      // 开场播报用 judging:原来也叫 verdict,而 verdict 事件没带裁决结果时会显示成「judger 没有给出裁决」——
      // 每一轮裁决之前都凭空多一行这句,看着像 judger 次次都要推一下才肯交
      const verdict = await judgerTurn('judging', P.judgerVerdictPrompt({
        userText, requirements, delivery, opinions, reviewerInterrupted: !!review.interrupted && !review.submitted,
      }), ['phase_done', 'request_revision', 'need_user']);
      say({ stage: 'verdict', role: 'judger', verdict: verdict?.name || 'none', input: verdict?.input });

      if (verdict?.name === 'phase_done') {
        return finish('passed', `judger 判定通过。\n\n${verdict.input.summary}`);
      }
      if (verdict?.name === 'need_user') {
        return finish('need_user', `judger 需要你决定:${verdict.input.reason}`);
      }
      const rulings = verdict?.input?.rulings || [{ opinion: '(无)', verdict: '采纳', reason: 'judger 未裁决' }];
      verdicts.push({ rulings, requirements: verdict?.input?.requirements || requirements });
      if (verdict?.input?.requirements) requirements = verdict.input.requirements;
      if (verdict?.input?.reviewerBrief) brief = verdict.input.reviewerBrief;

      // 连续两次裁决的缺口一模一样:卡住了,不等满三次,提前反省
      const sig = signature(rulings);
      if (sig && sig === prevSig) { say({ stage: 'stalled', role: 'judger' }); break; }
      prevSig = sig;
    }

    // ── worker 反省(不给工具) ──
    say({ stage: 'reflect', role: 'worker', batch });
    const reflect = await run('worker', { system: system + P.WORKER_RULES, access: 'none', submit: [], prompt: P.reflectPrompt({ verdicts, toolCounts }) });
    reflections.push(reflect.text);

    if (batch === MAX_BATCHES) {
      const last = verdicts[verdicts.length - 1];
      return finish('exhausted', [
        `这条片子两批都没通过 judger 的裁决,环路停下,交给你判断。`,
        '', '最后一次裁决:',
        ...(last?.rulings || []).map((r) => `- [${r.verdict}] ${r.opinion} —— ${r.reason}`),
        '', ...reflections.map((r, i) => `第 ${i + 1} 次反省:\n${r}`),
      ].join('\n'));
    }

    // ── judger 改写 ──
    const plan2 = await judgerTurn('rewrite', P.judgerRewritePrompt({ userText, reflection: reflect.text, verdicts }), ['issue_plan']);
    if (plan2) {
      requirements = plan2.input.requirements;
      brief = plan2.input.reviewerBrief;
      for (const l of plan2.input.lessons || []) if (l && !newLessons.includes(l)) newLessons.push(l);
    }
  }
  return finish('exhausted', '环路结束。');
}
