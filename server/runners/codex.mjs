import { cliEnv } from './cli-runtime.mjs';
import { spawnCli, resolveExe, lineSplitter, probeVersion } from './index.mjs';
import { execFileSync } from 'node:child_process';
import { tools } from '../mcp-tools.mjs';
import { pairingSession } from '../agent/call-pairing.mjs';
import { codexAuthState, codexAuthReason, authErrorDecoder, authFailureEvent } from './codex-auth-state.mjs';

/**
 * Codex 把「工具是否暴露」和「调用是否要审批」分成两个配置项。只注册 server 不会
 * 自动放行；在 approval_policy="never" 下，默认需要审批的 MCP 调用会当场被拒。
 *
 * 两项都显式传：enabled_tools 把能力限制在 PromptCut 自己公布的清单里，approve 则
 * 只免批这个 MCP server 的工具。shell 仍受 read-only sandbox 约束。
 */
export function getCodexMcpPolicyArgv() {
  return [
    '-c', `mcp_servers.promptcut.enabled_tools=${JSON.stringify(tools.map(t => t.name))}`,
    '-c', 'mcp_servers.promptcut.default_tools_approval_mode="approve"',
  ];
}

/**
 * 把任意形状的错误变成人能读的一行。
 *
 * 原来这里写的是 `String(item.error)` —— codex 的 error 是**对象**时,那句话的结果是
 * 字面的 `[object Object]`。用户诊断报告里那三行 `summary: "[object Object]"` 就是它。
 * 后果不只是难看:模型也只拿到这一坨,于是它开始猜为什么失败,猜出「当前会话禁止审批,
 * 请切换权限模式」这种用户根本做不到的指引(那个 approval_policy="never" 是我们自己
 * 写死在启动参数里的)。真实原因被吃掉,是整条误导的起点。
 */
function errText(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  // 常见形状:{ message } / { error: { message } } / { code, message }
  const msg = err.message ?? err.error?.message ?? err.detail ?? err.reason;
  if (typeof msg === 'string' && msg) {
    const code = err.code ?? err.error?.code ?? err.type;
    return code ? `${msg}(${code})` : msg;
  }
  try { return JSON.stringify(err); } catch { return Object.prototype.toString.call(err); }
}

/** 工具结果的摘要:成功看 result,失败**一定要把 error 带出来** */
function resultSummary(o) {
  if (o?.result !== undefined && o.result !== null) {
    try { return JSON.stringify(o.result).substring(0, 300); } catch { return String(o.result).substring(0, 300); }
  }
  return errText(o?.error).substring(0, 300);
}

/**
 * 这个错误是不是「被拒 / 需要审批」。
 *
 * 原来的判断是 `typeof err === 'string' && (含 denied|approval)` —— error 是对象时
 * 条件永远不成立,于是 onPermissionDenied 不触发,claude / agy 都有的「被拒之后改用
 * 文本协议重试」那条兜底对 codex 是**死的**。先摊平成文本再判,对象也就认得出来了。
 */
function looksDenied(err) {
  const t = errText(err).toLowerCase();
  if (!t) return false;
  return t.includes('denied') || t.includes('approval') || t.includes('not approved')
      || t.includes('rejected') || t.includes('permission');
}

export async function getCodexProvider() {
  const exePath = resolveExe('codex');
  let available = false;
  let version = undefined;
  let note = undefined;
  try {
    const stdout = probeVersion(exePath);
    version = stdout.trim();
    available = true;
  } catch (e) {
    note = e.message;
  }
  return { id: 'codex', label: 'Codex', available, version, path: exePath, note };
}

import { runTextProtocolLoop } from '../harness/tool-protocol.mjs';

export function startRun(opts) {
  if (opts.toolProtocol) {
    return runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
  }

  let abortRef = { abort: () => {} };
  let rejected = false;
  let authFailed = false;
  let cancelled = false;

  const interceptOnEvent = (ev) => {
    if (ev.authReason || ev.message === authFailureEvent(null, false).message) authFailed = true;
    if ((ev.type === 'done' || ev.type === 'error') && rejected && !authFailed) {
        return;
    }
    opts.onEvent(ev);
  };

  const run = _startRun({
    ...opts,
    onEvent: interceptOnEvent,
    onPermissionDenied: () => {
      rejected = true;
    }
  });
  abortRef.abort = run.abort;

  const donePromise = run.done.then((res) => {
    if (rejected && !authFailed && !cancelled) {
      opts.onEvent({ type: 'status', text: '原生工具被拒，改用文本协议重试' });
      const nextRun = runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
      abortRef.abort = nextRun.abort;
      return nextRun.done;
    }
    return res;
  });

  return { abort: () => { cancelled = true; abortRef.abort(); }, done: donePromise };
}

export function buildCodexArgs(opts) {
  const args = [];
  if (opts.sessionId) {
      args.push('exec', 'resume', opts.sessionId);
  } else {
      args.push('exec');
  }
  args.push('--json', '--skip-git-repo-check');
  
  if (!opts.sessionId) {
      args.push('-C', opts.cwd);
      args.push('-s', 'read-only');
      args.push('-c', 'approval_policy="never"');
  } else {
      args.push('-c', 'sandbox_mode="read-only"');
      args.push('-c', 'approval_policy="never"');
  }
  
  if (opts.mcp) {
      args.push('-c', `mcp_servers.promptcut.command=${JSON.stringify(opts.mcp.command)}`);
      args.push('-c', `mcp_servers.promptcut.args=${JSON.stringify(opts.mcp.args)}`);
      const envPairs = Object.entries(opts.mcp.env).map(([k,v]) => `${k}=${JSON.stringify(String(v))}`).join(', ');
      args.push('-c', `mcp_servers.promptcut.env={${envPairs}}`);
      args.push(...getCodexMcpPolicyArgv());
  }
  
  if (opts.model) {
      args.push('-m', opts.model);
  }
  // codex 没有 --effort,推理档只能通过 -c 覆盖配置项。codex 没有加速档,
  // 所以 opts.fast 在这里没有对应物,前端也会把那个开关灰掉。
  if (opts.effort) {
      args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  }
  args.push('-'); // stdin
  return args;
}

function _startRun(opts) {
  const state = codexAuthState();
  const snapshot = state.snapshot();
  if (snapshot.state === 'invalid' || snapshot.state === 'unknown') {
    opts.onEvent(snapshot.state === 'invalid' ? authFailureEvent(snapshot.reason)
      : { type: 'error', message: 'Codex 登录状态待确认，请重新登录。', authProvider: 'codex', authReason: 'state_unknown', authGeneration: snapshot.revision, retryable: false });
    return { abort() {}, done: Promise.resolve() };
  }
  let terminal = false;
  let cancelled = false;
  const emit = ev => {
    if (terminal || cancelled) return;
    if (ev.type === 'done' || ev.type === 'error') terminal = true;
    opts.onEvent(ev);
  };
  const exePath = resolveExe('codex');
  const args = buildCodexArgs(opts);

  const fullPrompt = `<<<系统说明>>>\n${opts.systemPrompt}\n<<<用户消息>>>\n${opts.prompt}`;
  
  const { child, safeOnEvent, finish, abort, donePromise } = spawnCli(exePath, args, { cwd: opts.cwd, env: cliEnv('codex'), stopOnFinish: true }, emit, 'Codex CLI');
  const failAuth = reason => {
    if (terminal || cancelled) return;
    const changed = state.invalidate(snapshot.generation, reason);
    finish(authFailureEvent(reason, changed));
  };
  const decodeAuth = authErrorDecoder(failAuth);

  let sentLength = 0;
  let threadId = null;
  let warnedConfig = false;
  /*
   * callId:codex 输出流里工具条目的 id 是 item_0、item_1 …,每起一次 codex(续跑也是)都从 0 数,
   * 所以前面拼上这次运行的随机段。它经 tool_call / tool_result 发给页面,再经 opts.callPairing 报到,
   * 让经 MCP 进来的同一次调用按(thread、工具名、参数)认领到同一个 id(server/agent/call-pairing.mjs)。
   * 页面 AI 栏按它把文档服务的工具调用事件对上聊天记录里的这一条。
   */
  const runTag = Math.random().toString(36).slice(2, 10);
  const pairing = pairingSession(opts.callPairing);
  const callIdOf = (item) => (typeof item.id === 'string' && item.id ? `cx-${runTag}-${item.id}` : undefined);
  const isOurs = (item) => item.server === undefined || item.server === 'promptcut';

  child.stderr.on('data', (data) => {
      if (terminal || cancelled) return;
      decodeAuth(data);
      if (terminal) return;
      const str = data.toString('utf8');
      if (!warnedConfig && str.includes('config.toml') && (str.includes('unknown variant') || str.includes('unknown field'))) {
          warnedConfig = true;
          safeOnEvent({ type: 'status', text: 'Codex 无法读取 PromptCut 的独立配置，请根据上一条错误检查配置。' });
      }
  });

  child.stdout.on('data', lineSplitter(line => {
    if (terminal || cancelled) return;
    if (!line.trim()) return;
    if (process.env.PROMPTCUT_RUNNER_DEBUG) console.error('[Codex] ' + line);
    try {
      const ev = JSON.parse(line);
      const evType = ev.type || ev.event;
      if (evType === 'turn.failed' || evType === 'error') {
        const reason = codexAuthReason(errText(ev.error || ev.message));
        if (reason) { failAuth(reason); return; }
      }
      
      if (evType === 'thread.started' && ev.thread_id) {
         threadId = ev.thread_id;
         pairing.open(`codex:${threadId}`);
         safeOnEvent({ type: 'session', sessionId: ev.thread_id });
      } else if (evType === 'turn.started') {
         safeOnEvent({ type: 'status', text: 'Codex 开始处理' });
      } else if (evType === 'item.started' || evType === 'item.completed' || evType === 'item.updated') {
         const item = ev.item;
         if (item) {
             const itemType = item.item_type || item.type;
             if (itemType === 'agent_message') {
                 const txt = item.text ?? item.content ?? item.message;
                 if (typeof txt === 'string' && txt.length > sentLength) {
                    safeOnEvent({ type: 'text', delta: txt.slice(sentLength) });
                    sentLength = txt.length;
                 }
             } else if (itemType === 'mcp_tool_call') {
                 const callId = callIdOf(item);
                 const call = callId ? { callId } : {};
                 if (evType === 'item.started') {
                     const name = item.tool ?? item.name ?? item.tool_name;
                     const input = item.arguments ?? item.input ?? {};
                     // 先报到再发给页面:MCP 那边的认领可能紧跟着就到
                     if (callId && threadId && isOurs(item)) pairing.announce(`codex:${threadId}`, name, input, callId);
                     safeOnEvent({ type: 'tool_call', name, input, ...call });
                 } else if (evType === 'item.completed') {
                     const name = item.tool ?? item.name ?? item.tool_name;
                     const ok = !(item.error) && item.status !== 'failed';
                     if (!ok && looksDenied(item.error)) {
                         if (opts.onPermissionDenied) opts.onPermissionDenied();
                     }
                     if (callId) pairing.settle(callId);
                     safeOnEvent({ type: 'tool_result', name, ok, summary: resultSummary(item), ...call });
                 }
             }
         }
      } else if (evType === 'mcp_tool_call') {
         const status = ev.status || ev.state || ev.action;
         if (status === 'started' || status === 'active' || (!status && ev.input && !ev.result)) {
             safeOnEvent({ type: 'tool_call', name: ev.name, input: ev.input || {} });
         } else if (status === 'completed' || status === 'success' || status === 'error' || status === 'done' || ev.result !== undefined) {
             const ok = status === 'completed' || status === 'success' || status === 'done' || (!status && !ev.error);
             if (!ok && looksDenied(ev.error)) {
                 if (opts.onPermissionDenied) opts.onPermissionDenied();
             }
             safeOnEvent({ type: 'tool_result', name: ev.name, ok, summary: resultSummary(ev) });
         }
      } else if (evType === 'turn.completed') {
         finish({ type: 'done', sessionId: threadId, usage: ev.usage });
      } else if (evType === 'turn.failed') {
         finish({ type: 'error', message: ev.error?.message || ev.message || 'Codex turn failed' });
      } else if (evType === 'error') {
         const msg = errText(ev.message || ev.error || 'Codex error');
         if (typeof msg === 'string' && (msg.startsWith('Reconnecting') || msg.includes('重试'))) {
             safeOnEvent({ type: 'status', text: msg });
         } else {
             finish({ type: 'error', message: msg });
         }
      }
    } catch {}
  }));

  donePromise.then(() => pairing.close(), () => pairing.close());

  child.stdin.on('error', () => {});
  try {
      child.stdin.write(fullPrompt);
      child.stdin.end();
  } catch {}

  return { abort: () => { cancelled = true; abort(); }, done: donePromise };
}
