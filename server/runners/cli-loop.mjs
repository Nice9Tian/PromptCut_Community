/**
 * 审查环路走命令行 CLI(目前是 agy)。
 *
 * API 直连那条路,环路能一轮一轮替模型执行工具(harness/loop.mjs 的 apiBackend)。
 * CLI 不一样:一次调用里它自己跑完整个循环,工具来自全局登记的 PromptCut MCP。于是:
 *
 * - **一个角色回合 = 起一次 CLI。** reviewer / judger 各开新会话;judger 被推一次时接着
 *   它自己那个会话(--conversation)说。
 * - **交结论不能靠工具**(issue_plan / phase_done 这些 MCP 里没有)。改成在回复末尾单独输出
 *   一个代码块,语言标记写结论名、内容是 JSON;这里解析。没交或解析不出来,环路那边会推一次。
 * - **只读不能靠少给工具**(MCP 是全局登记的,不按回合区分)。改成在服务端执行工具的入口
 *   上锁(setToolAccess,见 vite-plugin-ai.ts 的 callToolInternal):reviewer / judger
 *   回合只放行只读名单,反省回合一个都不放行,回合结束解锁。
 * - CLI 每次调用自己发的 done / session 事件**不能**往前端转:前端见到 done 就当整件事结束了,
 *   见到 session 就会拿某个角色的会话去续下一条消息。
 */
import { runReviewLoop, presentLoopEvent, SUBMIT_DEFS } from '../harness/loop.mjs';
import { READ_ONLY_TOOLS } from '../harness/loop-prompts.mjs';
import { lessonsStore } from './api.mjs';
import { tr } from '../i18n.mjs';

const RETRIES = 2;

function fieldDoc(schema, indent = '  ') {
  const req = new Set(schema.required || []);
  return Object.entries(schema.properties || {}).map(([k, v]) => {
    let type = v.type === 'array' ? `array${v.items?.type === 'object' ? ', each item is an object' : `, each item is ${v.items?.type || 'value'}`}` : v.type;
    if (v.enum) type += `, one of ${v.enum.join(' / ')}`;
    const line = `${indent}- ${k}(${type},${req.has(k) ? 'required' : 'optional'}):${v.description || ''}`;
    const sub = v.type === 'array' && v.items?.type === 'object' ? '\n' + fieldDoc(v.items, indent + '    ') : '';
    return line + sub;
  }).join('\n');
}

/** 拼在系统提示末尾:这一回合要交的结论怎么交 */
export function submitFormat(names) {
  const example = names[0] === 'need_user'
    ? '```need_user\n{"reason": "Please scan the QR code to log in in the pop-up window"}\n```'
    : `\`\`\`${names[0]}\n{ …fields below… }\n\`\`\``;
  return [
    '', '', '## How to submit conclusions (important)',
    `The ${names.join(' / ')} mentioned here are **not tools**; they are not in your tool list, so do not look for them and do not call them.`,
    'To submit a conclusion: at the **end** of your reply, output a single code block whose language tag is the conclusion name and whose content is a JSON object. For example:',
    example,
    'Conclusions and fields you can submit this turn:',
    ...names.map((n) => `- ${n}:${SUBMIT_DEFS[n].description}\n${fieldDoc(SUBMIT_DEFS[n].inputSchema)}`),
    'Submit only one conclusion block in the whole reply. Use double quotes for strings in JSON.',
  ].join('\n');
}

/** 从回复里取最后一个合格的结论块;没有、或 JSON 解析不出来、或缺必填字段,返回 null */
export function parseSubmission(text, names) {
  if (!text || !names.length) return null;
  const re = /```[ \t]*([A-Za-z_]+)[ \t]*\r?\n([\s\S]*?)```/g;
  let m, found = null;
  while ((m = re.exec(text))) {
    const name = m[1];
    if (!names.includes(name)) continue;
    try {
      const input = JSON.parse(m[2].trim());
      const ok = input && typeof input === 'object' && !Array.isArray(input)
        && (SUBMIT_DEFS[name].inputSchema.required || []).every((k) => input[k] !== undefined);
      if (ok) found = { name, input };
    } catch { /* 这一块坏了,看下一块 */ }
  }
  return found;
}

const accessNote = (access) => access === 'readonly'
  ? `\n\n## PromptCut tools you can use this turn\nOnly these read-only tools: ${READ_ONLY_TOOLS.filter((n) => n !== 'think').join(', ')}. All other PromptCut tools will be rejected this turn, do not call them.`
  : access === 'none'
    ? '\n\n## Do not call any tools this turn\nAnswer in text only. All PromptCut tools will be rejected this turn.'
    : '';

/**
 * CLI 版的角色回合。startProviderRun 就是那一家 runner 的 startRun(比如 agy.mjs 的)。
 * baseOpts 是这条对话原本要交给它的那些参数(cwd、mcp、model、effort、toolProtocol…)。
 */
export function cliBackend({ startProviderRun, baseOpts, setToolAccess, signal }) {
  // onRoleEvent 由环路给:它负责打角色标、数 worker 的工具调用,再由 startCliLoop 翻成聊天栏的样子
  return (onRoleEvent) => {
    /** 起一次 CLI,收齐这一次的文字、会话 id、用量和错误;内层的 done / session / error 不往外转 */
    const runOnce = ({ role, systemPrompt, prompt, sessionId }) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error(tr("Stopped")), { name: 'AbortError' }));
      let text = '', sid = null, usage = null, error = null;
      const run = startProviderRun({
        ...baseOpts, systemPrompt, prompt, sessionId,
        onEvent: (ev) => {
          if (ev.type === 'text' && typeof ev.delta === 'string') text += ev.delta;
          if (ev.type === 'session') { sid = ev.sessionId; return; }
          if (ev.type === 'done') { usage = ev.usage || null; if (ev.sessionId) sid = ev.sessionId; return; }
          if (ev.type === 'error') { error = ev; return; }
          onRoleEvent(role, ev);
        },
      });
      const onAbort = () => run.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      run.done.then(() => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return reject(Object.assign(new Error(tr("Stopped")), { name: 'AbortError' }));
        resolve({ text, sessionId: sid, usage: normalizeUsage(usage), error });
      }, reject);
    });

    return {
      async runRole(role, { system, prompt, access, submit = [], session }) {
        const systemPrompt = system + accessNote(access) + (submit.length ? submitFormat(submit) : '');
        setToolAccess?.(access === 'all' ? null : access === 'readonly' ? READ_ONLY_TOOLS : []);
        try {
          let sessionId = session || undefined;
          let ask = prompt;
          for (let attempt = 0; ; attempt++) {
            const r = await runOnce({ role, systemPrompt, prompt: ask, sessionId });
            sessionId = r.sessionId || sessionId;
            if (!r.error) return { text: r.text, submitted: parseSubmission(r.text, submit), session: sessionId, usage: r.usage };
            if (signal?.aborted || r.error.authReason || !r.error.retryable) throw Object.assign(new Error(r.error.message || tr("CLI error")), { runEvent: r.error });
            if (attempt >= RETRIES || !sessionId) {
              /*
               * 可续跑的中断,重试用完了:这一回合交不出东西,但**环路不该跟着作废**。
               * 实跑:worker 三次都被 agy 自家的内建工具拒掉,这里一 throw,judger 定好的要求、
               * worker 已经动过的工程全白跑,用户只看到一个错误。改成交回一个标了 interrupted 的结果,
               * 怎么接由 loop.mjs 决定。不可续跑的错(模型名不对之类)和用户点停止照旧抛出去。
               */
              return { text: r.text, submitted: parseSubmission(r.text, submit), session: sessionId, usage: r.usage, interrupted: r.error.message || tr("CLI error") };
            }
            onRoleEvent(role, { type: 'loop', stage: 'retry', role, attempt: attempt + 1, reason: r.error.message });
            ask = r.error.retryPrompt || 'The last run was interrupted. All earlier progress is still there, continue from where you stopped.';
          }
        } finally {
          setToolAccess?.(null);
        }
      },
    };
  };
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.input ?? u.input_tokens ?? u.prompt_tokens ?? u.inputTokens) || 0;
  const output = Number(u.output ?? u.output_tokens ?? u.completion_tokens ?? u.outputTokens) || 0;
  return { input, output, cacheRead: Number(u.cacheRead ?? u.cached_tokens) || 0 };
}

/**
 * 替代那一家 runner 的 startRun:返回 { abort, done },事件形状和其它 runner 一样。
 */
export function startCliLoop(opts, startProviderRun, deps = {}) {
  const ac = new AbortController();
  const emit = (ev) => { for (const e of presentLoopEvent(ev)) { try { opts.onEvent(e); } catch { /* 前端断了不影响环路 */ } } };
  const { onEvent: _drop, reviewLoop: _r, deepAuto: _d, ...baseOpts } = opts;
  const factory = cliBackend({ startProviderRun, baseOpts, setToolAccess: opts.setToolAccess, signal: ac.signal });

  const done = (async () => {
    try {
      const result = await runReviewLoop({
        backendFactory: factory,
        system: opts.systemPrompt, userText: opts.prompt,
        lessonsStore: deps.lessonsStore || lessonsStore(), onEvent: emit,
      });
      opts.onEvent({ type: 'done', usage: result.usage, outcome: result.outcome, completed: result.completed, failed: result.failed });
    } catch (err) {
      if (ac.signal.aborted) opts.onEvent({ type: 'status', text: tr("Aborted") });
      else opts.onEvent(err.runEvent || { type: 'error', message: String(err?.message || err) });
    } finally {
      opts.setToolAccess?.(null);
    }
  })();
  return { abort: () => ac.abort(), done };
}
