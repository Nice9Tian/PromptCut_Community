import { cliEnv } from './cli-runtime.mjs';
import { spawnCli, resolveExe, lineSplitter, probeVersion } from './index.mjs';
import { execFileSync } from 'node:child_process';
import { tools } from '../mcp-tools.mjs';
import { pairingSession } from '../agent/call-pairing.mjs';
import { codexAuthState, codexAuthReason, authErrorDecoder, authFailureEvent } from './codex-auth-state.mjs';

/**
 * Codex splits "whether tools are exposed" and "whether invocations need approval" into two config
 * options. Registering the server alone does not automatically permit them; under
 * approval_policy="never", MCP invocations requiring approval by default are rejected on the spot.
 *
 * Pass both explicitly: enabled_tools restricts capabilities to the manifest published by
 * PromptCut itself, while approve exempts only tools of this MCP server from approval. shell is
 * still subject to read-only sandbox constraints.
 */
export function getCodexMcpPolicyArgv() {
  return [
    '-c', `mcp_servers.promptcut.enabled_tools=${JSON.stringify(tools.map(t => t.name))}`,
    '-c', 'mcp_servers.promptcut.default_tools_approval_mode="approve"',
  ];
}

/**
 * Turn an error of arbitrary shape into a human-readable single line.
 *
 * Previously this was `String(item.error)`: when codex's error is an **object**, the result of
 * that expression is literally `[object Object]`. The three lines of
 * `summary: "[object Object]"` in the user diagnostic report were precisely this. The consequence
 * was not just looking ugly: the model also only received this blob, so it started guessing why it
 * failed, coming up with guidance like "approval disabled for the current session, please switch
 * permission mode" that the user cannot possibly follow (approval_policy="never" was hardcoded by
 * us in the startup parameters). Swallowing the real cause was the origin of the entire
 * misguidance.
 */
function errText(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  // Common shapes: { message } / { error: { message } } / { code, message }
  const msg = err.message ?? err.error?.message ?? err.detail ?? err.reason;
  if (typeof msg === 'string' && msg) {
    const code = err.code ?? err.error?.code ?? err.type;
    return code ? `${msg}(${code})` : msg;
  }
  try { return JSON.stringify(err); } catch { return Object.prototype.toString.call(err); }
}

/** Summary of tool results: check result on success, **must include error** on failure */
function resultSummary(o) {
  if (o?.result !== undefined && o.result !== null) {
    try { return JSON.stringify(o.result).substring(0, 300); } catch { return String(o.result).substring(0, 300); }
  }
  return errText(o?.error).substring(0, 300);
}

/**
 * Whether this error is "rejected / requires approval".
 *
 * The original check was `typeof err === 'string' && (contains denied|approval)`: when error is an
 * object, the condition is never true, so onPermissionDenied never triggers, and the fallback to
 * "retry with text protocol after rejection" that both claude / agy have was **dead** for codex.
 * Flatten to text before checking so objects can be recognized too.
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
import { tr } from '../i18n.mjs';

export function startRun(opts) {
  if (opts.toolProtocol) {
    return runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent, tools });
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
      opts.onEvent({ type: 'status', text: tr("Native tool was rejected, retrying with text protocol") });
      const nextRun = runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent, tools });
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
  // codex has no --effort; reasoning tiers can only override config items via -c. codex has no fast
  // tier, so opts.fast has no counterpart here, and the frontend also grays out that toggle.
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
      : { type: 'error', message: tr("Codex login state needs confirmation, please log in again."), authProvider: 'codex', authReason: 'state_unknown', authGeneration: snapshot.revision, retryable: false });
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

  const fullPrompt = `<<<System instructions>>>\n${opts.systemPrompt}\n<<<User message>>>\n${opts.prompt}`;
  
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
   * callId: IDs of tool entries in codex output stream are item_0, item_1 …, counting from 0 every
   * time codex starts (including resumed runs), so prepend a random segment for this run. It is sent
   * to the page via tool_call / tool_result, then checked in via opts.callPairing so that the same
   * call coming in via MCP can claim the same ID by (thread, tool name, parameters)
   * (server/agent/call-pairing.mjs). The page AI panel uses it to match document service tool call
   * events to this entry in the chat history.
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
          safeOnEvent({ type: 'status', text: tr("Codex cannot read PromptCut's standalone config, please check the config based on the previous error.") });
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
         safeOnEvent({ type: 'status', text: tr("Codex started working") });
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
                     // Check in before sending to the page: the claim from MCP might arrive immediately after
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
         if (typeof msg === 'string' && (msg.startsWith('Reconnecting') || msg.includes('重试'))) { // i18n-allow
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
