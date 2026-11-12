import { spawnCli, resolveExe, lineSplitter, probeVersion } from './index.mjs';
import { execFileSync } from 'node:child_process';
import { cliCommand, cliEnv } from './cli-runtime.mjs';
import { pairingSession } from '../agent/call-pairing.mjs';

function runAgy(exe, args, options) {
  const invocation = cliCommand(exe, args);
  return execFileSync(invocation.command, invocation.args, { env: cliEnv('agy'), timeout: 15000, windowsHide: true, ...options });
}

/**
 * Register PromptCut MCP with agy: **do not write port into registration**; port is passed via
 * environment variables each time agy starts.
 *
 * agy MCP registration is global (one per machine). Previously, registration hardcoded
 * `-e PROMPTCUT_PORT=<port>`, while "is already registered" only compared node and script paths,
 * not port: two instances of the same code (editor on 5190, tests on 5198) have different ports;
 * the later-started one would assume it was already registered, so agy tool calls kept hitting the
 * previous port; if that port closed, all calls errored; if occupied by another program, calls hung
 * indefinitely.
 *
 * Now: registration contains only command and script; PROMPTCUT_PORT / PROMPTCUT_AGENT are placed
 * in the agy process environment variables (see spawnCli env below) and inherited when agy starts
 * MCP child processes, so mcp-server.mjs reads the exact server that initiated this chat. Each
 * server process re-registers once the first time it uses agy (`mcp add` is "add or update"), also
 * clearing the port written into the registry by older versions; thereafter, re-registration only
 * occurs when command or script path changes.
 */
let registeredOnce = false;
let registerPromise = null;

export function mcpAddArgs(mcpOpts) {
  return ['mcp', 'add', 'promptcut', mcpOpts.command, mcpOpts.args[0]];
}

async function ensureMcpRegistered(exePath, mcpOpts, safeOnEvent) {
  if (registerPromise) await registerPromise.catch(() => {});
  registerPromise = (async () => {
    if (registeredOnce) {
      try {
        const listStdout = runAgy(exePath, ['mcp', 'list'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const line = listStdout.split(/\r?\n/).find((l) => l.split(/\s+/)[0] === 'promptcut');
        if (line && line.includes(mcpOpts.command) && line.includes(mcpOpts.args[0])) return;
      } catch { /* Re-register if not found */ }
    }
    try {
      runAgy(exePath, mcpAddArgs(mcpOpts), { windowsHide: true, stdio: 'ignore' });
      registeredOnce = true;
      safeOnEvent({ type: 'status', text: tr("Registered PromptCut as an MCP server for agy (agy mcp add promptcut)") });
    } catch (e) {
      safeOnEvent({ type: 'error', message: `MCP registration failed: ${e.message}` });
    }
  })();
  return registerPromise;
}

export async function getAgyProvider() {
  const exePath = resolveExe('agy');
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
  return { id: 'agy', label: 'Antigravity', available, version, path: exePath, note };
}

import { runTextProtocolLoop } from '../harness/tool-protocol.mjs';
import { tools } from '../mcp-tools.mjs';
import { tr } from '../i18n.mjs';

export function startRun(opts) {
  if (opts.toolProtocol) {
    return runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent, tools });
  }

  let abortRef = { abort: () => {} };
  let rejected = false;

  const interceptOnEvent = (ev) => {
    if ((ev.type === 'done' || ev.type === 'error') && rejected) {
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
    if (rejected) {
      opts.onEvent({ type: 'status', text: tr("Native tool was rejected, retrying with text protocol") });
      const nextRun = runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent, tools });
      abortRef.abort = nextRun.abort;
      return nextRun.done;
    }
    return res;
  });

  return { abort: () => abortRef.abort(), done: donePromise };
}

/**
 * Supplementary instructions sent only to agy, appended after the general system prompt.
 *
 * The general prompt is shared among four runners; it does not know that "the runner executing it
 * carries its own set of built-in tools". And agy carries them: view_file / grep_search /
 * find_by_name / run_command. Its workspace is only the small sandbox `exports/ai-workspace` (see
 * cwd in vite-plugin-ai.ts); anything reaching outside the sandbox is automatically rejected; and
 * **a single rejection causes agy to abandon the entire round and produce nothing**. In other
 * words, the cost of casually reading a file is invalidating the entire round, requiring us to send
 * a resume message to start over.
 *
 * In testing it hit all four traps: first view_file on four MCP schema JSONs (those schemas were
 * already in its own tool manifest), then grep_search on the app directory, then view_file on disk
 * paths of user attachments. Just "reading the tool manuals" burned two rounds for nothing. So here
 * we explicitly specify the alternative paths.
 *
 * Seen again in the review loop: worker first ran list_dir on the app directory, then
 * read_url_content on a web page, then grep_search on app source code looking for
 * `project.tracks`: three built-in tools each hit a wall, invalidating all three rounds. So the
 * list must be comprehensive, and make clear that "switching to another built-in tool is the same".
 */
const AGY_ADDENDUM = `
## About your own built-in tools (only relevant to you)

Besides the PromptCut tools, you also carry built-in tools such as view_file / list_dir / grep_search / find_by_name /
read_url_content / run_command. **Here they mostly cannot be used, and using them is very costly:**

- Your workspace is only a small temporary directory; reading or writing any path outside it is rejected automatically
  (unattended, nobody can approve for you);
- Reading web pages and running commands likewise cannot be approved by anyone, and are always rejected automatically;
- Once rejected, your whole turn is void and you deliver nothing, and must start over from scratch. Switching to another built-in tool makes no difference.

So: **unless the file is really in your workspace, do not use built-in tools to touch any path, URL or command.**
Everything you need to do has a matching PromptCut tool:

| What you want to do | Use this, not a built-in tool |
| --- | --- |
| See what is in the project (tracks, clips, media, cards) | \`get_project\` / \`get_clip\` / \`get_track\` / \`list_media\` / \`list_cards\` |
| Understand what the project data looks like | What the tools above return; do not search the app directory for source code |
| Read web pages, look things up | \`web_open\` / \`web_read\` |
| See the source of a card | \`get_card_source\` |
| Modify a card | \`edit_card\` (use \`create_card\` only for new ones) |
| See what the frame looks like | \`see_frames\` |
| Handle attachments sent by the user | \`import_media({ url })\`, take the url from the **in-site address** in the message; do not view_file that disk path |
| Wait a few seconds before checking background jobs | \`wait({ seconds })\`, do not sleep via run_command |
| Look up how to call a tool | Its parameter description is **already in your tool list**, read it directly; do not read schema json on disk |
| Report to the user at the end of each small phase and when the whole task wraps up | \`report_progress\` |
| Tell the user what you are about to do or have just finished (shown in the chat bubble) | \`send_message\`, set \`to\` to "user" |
`;

/**
 * Point to whichever PromptCut path corresponds to the type of permission rejected.
 *
 * Previously, retry wording hardcoded "command permission (run_command, etc.) rejected, use wait
 * instead". In actual runs, the three rejections were list_dir(read_file),
 * read_url_content(read_url), and grep_search(read_file), with zero command rejections: the model
 * avoided run_command following that prompt, only to hit a wall again with another built-in tool;
 * retries exhausted, the entire review loop was invalidated.
 */
export function deniedAdvice(names, detail) {
  const s = `${names} ${detail}`.toLowerCase().replace(/[_\s-]/g, '');
  const tips = [];
  if (/readfile|listdir|grepsearch|findbyname|viewfile|codebasesearch/.test(s)) {
    tips.push('To inspect the project, media and cards: use get_project / get_clip / list_media / list_cards / get_card_source, do not browse directories and source code on disk');
  }
  if (/readurl/.test(s)) tips.push('To read web pages: use web_open / web_read; for attachments sent by the user use import_media({ url })');
  if (/runcommand|command/.test(s)) tips.push('To wait a few seconds before checking background jobs: use wait({ seconds }, 1~30), do not sleep via run_command');
  if (!tips.length) tips.push('Do the same thing with the tools PromptCut provides');
  return tips;
}

function _startRun(opts) {
  const exePath = resolveExe('agy');
  
  let resolveDone;
  const donePromise = new Promise(r => { resolveDone = r; });
  let childController = null;
  let isAborted = false;
  
  const fullPrompt = `<<<System instructions>>>\\n${opts.systemPrompt}\\n${AGY_ADDENDUM}\\n<<<User message>>>\\n${opts.prompt}`;

  /*
   * Prompts go through **stdin**, not command-line arguments.
   *
   * Previously it was `-p <entire prompt>`. A single command line on Windows has a limit of 32767
   * characters, while the system prompt alone is just over 15,000: normally enough, but once
   * stacked with the text protocol tool manifest (33,000 characters) it reaches 49,000, directly
   * triggering `spawn ENAMETOOLONG`. In other words, agy's fallback path of "native tool rejected →
   * retry with text protocol" **has never succeeded**: it crashes immediately upon entry, without any
   * obvious explanation. claude.mjs and codex.mjs have long used stdin; this was the only exception.
   *
   * `--input-format stream-json` makes agy read NDJSON line-by-line from stdin; it inherently implies
   * print mode, so `-p` is no longer provided (providing it would consume the following flag as the
   * prompt). The message shape was determined through testing:
   * `{"event":"user","message":{"role":"user","content":"…"}}`: missing either `event` or `message`
   * is explicitly rejected by agy. In testing, a 48,000-character prompt sent this way returned
   * normally.
   */
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--add-dir', opts.cwd,
    '--print-timeout', '20m'
  ];
  if (opts.sessionId) {
    args.push('--conversation', opts.sessionId);
  }
  /*
   * Model name and thinking tier **must pair up**; this is a strict agy rule, mismatch directly
   * rejects the entire round:
   *
   *   --model gemini-3.8-flash-low --effort low   ✓
   *   --model gemini-3.8-flash-low --effort high  ✗ invalid model selection
   *   --model gemini-3.8-flash     --effort low   ✓ base name + tier, equivalent to the first
   *
   * The panel has already split it into "base name + tier" before sending
   * (modelOptions.pairModelEffort); here we add another fallback for suffixed forms: paths like
   * background tasks and split-work mode do not necessarily go through the panel, and session
   * history may store older suffixed names. Strip the suffix and use it as the tier; the result is
   * completely equivalent to the original name, but guaranteed to match.
   */
  let model = opts.model || '';
  let effort = opts.effort || '';
  const suffixed = /^(.+)-(low|medium|high)$/.exec(model);
  if (suffixed) {
    model = suffixed[1];
    effort = suffixed[2];
  }
  if (model) {
    args.push('--model', model);
  }
  // agy supports low|medium|high three tiers, but **available tiers vary by model** (gemini-3.1-pro has no medium);
  // without an acceleration tier, the frontend greys out that switch
  if (effort) {
    args.push('--effort', effort);
  }

  const safeOnEvent = (ev) => {
      if (childController) childController.safeOnEvent(ev);
      else {
          try { opts.onEvent(ev); } catch {}
      }
  };

  const runChild = () => {
    if (isAborted) {
       resolveDone();
       return;
    }
    
    // Port and Agent page are passed to agy via environment variables and inherited when it starts
    // MCP child processes (port is not written into registration, see ensureMcpRegistered)
    const mcpEnv = opts.mcp?.env || {};
    childController = spawnCli(exePath, args, { cwd: opts.cwd, env: { ...process.env, ...mcpEnv } }, opts.onEvent, 'Antigravity');
    let emitted = '';
    /*
     * callId: `agy:<chat id>:<step number>`. When agy calls MCP, it passes conversation_id and
     * progressToken "<uuid>:<step number>" in _meta of tools/call; the step number is step_index from
     * step_update here (keeps incrementing when resuming the same chat, without duplicate numbers), and
     * mcp-server.mjs formats the prompt using the same pattern; here it checks in via opts.callPairing,
     * and the editor pairs them after verifying that tool names and parameters match
     * (server/agent/call-pairing.mjs). The AI panel on the page uses it to match document service tool
     * call events with this entry in the chat history.
     */
    const pairing = pairingSession(opts.callPairing);
    let convId = opts.sessionId || null;
    childController.donePromise.then(() => pairing.close(), () => pairing.close());

    // Prompts enter here (see description of args above). Ignore EPIPE: if the process already exited
    // on its own, the real cause is in stderr / result events and should not be masked by a broken pipe
    // write failure.
    childController.child.stdin.on('error', () => {});
    try {
      childController.child.stdin.write(JSON.stringify({ event: 'user', message: { role: 'user', content: fullPrompt } }) + '\n');
      childController.child.stdin.end();
    } catch { /* Same as above */ }


    childController.child.stdout.on('data', lineSplitter(line => {
      if (!line.trim()) return;
      if (process.env.PROMPTCUT_RUNNER_DEBUG) console.error('[agy] ' + line);
      try {
        const ev = JSON.parse(line);
        if (ev.event === 'init' && ev.conversation_id) {
          convId = ev.conversation_id;
          pairing.open(`agy:${convId}`);
          childController.safeOnEvent({ type: 'session', sessionId: ev.conversation_id });
        } else if (ev.event === 'step_update' && ev.step_update) {
           const su = ev.step_update;
           if (su.step_type === 'tool') {
              let tName = su.tool_name;
              let tInput = su.tool_info?.parameters || {};
              // Whether this step is actually calling a PromptCut tool. agy itself also has many built-in tools
              // (run_command / browser_* / …); they do not go through MCP, and rejection handling is completely
              // different.
              const isMcp = su.tool_name === 'call_mcp_tool';
              const ours = isMcp && (tInput.ServerName === undefined || tInput.ServerName === 'promptcut');
              if (isMcp) {
                  tName = tInput.ToolName || 'call_mcp_tool';
                  tInput = tInput.Arguments || tInput;
              }
              const conv = su.conversation_id || convId;
              const callId = conv && Number.isInteger(su.step_index) ? `agy:${conv}:${su.step_index}` : undefined;
              const call = callId ? { callId } : {};
              if (callId && su.state !== 'ACTIVE') pairing.settle(callId);

              if (su.state === 'ACTIVE') {
                 if (callId && ours) {
                    pairing.open(`agy:${conv}`); // Open if init was not seen (do not reopen if already open)
                    pairing.announce(`agy:${conv}`, tName, tInput, callId);
                 }
                 childController.safeOnEvent({ type: 'tool_call', name: tName, input: tInput, ...call });
              } else if (su.state === 'DONE') {
                 let outputStr = 'done';
                 if (su.tool_info?.output !== undefined) {
                     if (typeof su.tool_info.output === 'string') outputStr = su.tool_info.output;
                     else outputStr = JSON.stringify(su.tool_info.output);
                 }
                 childController.safeOnEvent({ type: 'tool_result', name: tName, ok: true, summary: outputStr.substring(0, 300), ...call });
              } else if (su.state === 'ERROR') {
                 const msg = su.tool_info?.error?.message || '';
                 /*
                  * **"File does not exist" is not "rejected", even if the word permission appears in the error.**
                  *
                  * agy's permission check first converts tool arguments (`convert tool call for permissions`), and
                  * this step happens to read the file; if unreadable, it throws ENOENT as is, so the full error
                  * looks like this:
                  *
                  *   declaring permissions: cortex tool view_file: convert tool call for
                  *   permissions: ... failed to read file: open <path>:
                  *   The system cannot find the file specified.
                  *
                  * Because permission is in there, the original includes check insisted it was a permission issue,
                  * returning to the model: "Cannot pop up dialog for consent in unattended mode": yet the truth was
                  * that it specified a completely non-existent path. The model guessed permissions based on that
                  * message and failed no matter what it tried; what the user saw was also a fake permission failure.
                  * Therefore, recognize "not found" first; once recognized, treat it as an ordinary tool failure and
                  * return the original text so it can switch to a different path.
                  */
                 const notFound = /cannot find the file|no such file|not found|ENOENT|系统找不到/i.test(msg); // i18n-allow
                 const denied = !notFound
                   && (msg.includes('permission') || msg.includes('权限') || msg.includes('denied') || msg.includes('not allowed')); // i18n-allow
                 /*
                  * "Rejected" must distinguish who was rejected; previously it was treated as MCP rejection across
                  * the board, which was wrong in two places:
                  *
                  * - The message was wrong. agy's built-in run_command cannot pop up a prompt in unattended mode
                  *   and gets automatically rejected, yet we replied "Please click \"Authorize PromptCut tools\"":
                  *   that button has nothing to do with it, and clicking it did nothing for the user. In the same
                  *   round, get_project / list_media clearly succeeded, and MCP was completely reachable.
                  * - The action was also wrong. onPermissionDenied causes the run to retry with the text protocol
                  *   after the full round completes, but switching to the text protocol only changes "how PromptCut
                  *   tools are dispatched" and cannot govern agy's own command permissions; retrying still gets
                  *   rejected. It wasted an entire round and kept the user waiting.
                  *
                  * Therefore, only fall back when the MCP path itself is genuinely rejected. If agy's own tools are
                  * rejected, report it truthfully and return it to the model as a failed tool call: let it try
                  * another way to continue, rather than invalidating the entire round.
                  */
                 if (denied && isMcp) {
                    if (opts.onPermissionDenied) opts.onPermissionDenied();
                    childController.safeOnEvent({ type: 'status', text: tr("agy rejected the MCP tool call. Open AI settings (gear in the right rail), click \"Authorize PromptCut tools\", then retry.") });
                 } else if (denied) {
                    childController.safeOnEvent({ type: 'tool_result', name: tName, ok: false, summary: tr("Antigravity itself rejected this tool (its built-in tool, not PromptCut's): {0}", msg), ...call });
                    childController.safeOnEvent({ type: 'status', text: tr("Antigravity blocked its own {0}: no popup can ask for consent in unattended mode. PromptCut's tools are unaffected; have it use PromptCut's tools to do the same thing instead.", tName) });
                 } else {
                    childController.safeOnEvent({ type: 'tool_result', name: tName, ok: false, summary: msg, ...call });
                 }
              }
           } else {
               const txt = su.text_delta ?? su.text ?? su.delta ?? su.content ?? su.message;
               if (typeof txt === 'string' && txt.length > 0) {
                  childController.safeOnEvent({ type: 'text', delta: txt });
                  emitted += txt;
               }
           }
        } else if (ev.event === 'result' && ev.result) {
           const res = ev.result;

           /*
            * When agy errors, it still sends a result, only status is ERROR, error contains the reason, and
            * it exits with non-zero. Previously it did not check status here and treated it as normal
            * completion, emitting done: once done was emitted, hasDone in spawnCli became true, and the
            * "exited with code 1" on `close` was also suppressed. As a result, the UI only showed "Started
            * Antigravity", ending silently a few seconds later: no reply, no error, usage all 0, appearing as
            * if disconnected.
            *
            * In practice, the most common issue is an incorrect model name (for example, `gemini-3.8.flash`:
            * agy's name is `gemini-3.8-flash-low`); agy stated it clearly, but nobody passed this message out.
            * claude.mjs has always checked is_error, so bring this in line here.
            */
           if (res.status === 'ERROR' || res.error) {
              const why = typeof res.error === 'string' ? res.error : (res.error?.message || tr("Antigravity reported an error without giving a reason"));
              childController.finish({ type: 'error', message: `Antigravity: ${why}` });
              return;
           }

           const finalResponse = res.response || '';

           if (res.denied_actions && res.denied_actions.length > 0) {
               const deniedNames = res.denied_actions.map(a => a.display_name || a.action).join(', ');
               // Raw rejection explanation. agy puts it in denied_actions (field names vary across versions),
               // spliced into the continuation message for the model to see: more accurate than our paraphrase.
               const deniedDetail = res.denied_actions
                 .map(a => a.reason || a.message || a.detail || '')
                 .filter(Boolean).join('; ');
               /*
                * Rejected **and produced nothing** = this round is wasted and cannot report success.
                *
                * When agy automatically rejects its own run_command in unattended mode, it gives up the entire
                * round; denied_actions in result has values and response is empty, but status is not ERROR.
                * Previously it only sent a status and called finish('done') as usual: on the UI, it ended
                * abruptly without warning after a sequence of tool calls: no reply, no error, and the user had
                * no idea what happened. (User quote: "This rejection looks like we rejected it; it didn't give
                * feedback to the Agent and just aborted directly".)
                *
                * We cannot feed this rejection back into agy's loop: it is a one-shot CLI invocation managing its
                * own tools. What we can do is report it truthfully as an error and explain the next step clearly.
                * The real root fix is on the other end: with the wait tool added, the model no longer needs to
                * use the shell to sleep (see description of wait in server/mcp-tools.mjs).
                */
               if (!String(finalResponse).trim() && !emitted.trim()) {
                  const why = deniedDetail || tr("Built-in tool {0} was rejected", deniedNames);
                  const tips = deniedAdvice(deniedNames, deniedDetail);
                  childController.finish({
                    type: 'error',
                    message: tr("Antigravity gave up this turn after rejecting its own built-in tools ({0}), and produced no result.", deniedNames)
                      + tr(" In unattended mode it cannot pop up a window to ask for consent, so reading files, reading web pages and running commands outside the workspace are always rejected automatically.")
                      + tr(" PromptCut's tools are unaffected: {0}.", tips.join('; ')),
                    /*
                     * This type of interruption can "succeed if continued": context is still there (--conversation
                     * brings back the whole chat), and all that is missing is letting it know why it stopped just now
                     * and which path to switch to. Therefore, mark it as resumable, and **splice the interruption reason
                     * and alternative directly into the continuation prompt**: don't let it ask "what happened just
                     * now", saving a round-trip and preventing it from guessing wrong.
                     */
                    retryable: true,
                    retryPrompt: `Continue from above. The previous turn was interrupted because: ${why}.\\n`
                      + `This is Antigravity's own permission limit: in unattended mode, your built-in tools (view_file / list_dir / grep_search / find_by_name / read_url_content / run_command, etc.)`
                      + `are always rejected automatically as soon as they touch a path, URL or command outside the workspace, and the whole turn is void. Switching to another built-in tool makes no difference, do not try again.
`
                      + `Switch to PromptCut tools:\\n${tips.map((t) => `- ${t}`).join('\n')}\\n`
                      + `No need to start over, just continue from where you stopped.`,
                  });
                  return;
               }
               childController.safeOnEvent({ type: 'status', text: tr("Some actions were rejected: {0}", deniedNames) });
           }

           if (typeof finalResponse === 'string' && finalResponse.trim().length > 0) {
              const cleanedEmitted = emitted.trim();
              const cleanedResponse = finalResponse.trim();
              if (!cleanedEmitted.endsWith(cleanedResponse) && !cleanedEmitted.includes(cleanedResponse)) {
                  childController.safeOnEvent({ type: 'text', delta: finalResponse });
              }
           }
           childController.finish({ type: 'done', sessionId: res.conversation_id, usage: res.usage });
        }
      } catch {}
    }));

    childController.donePromise.then(resolveDone);
  };

  if (opts.mcp) {
    ensureMcpRegistered(exePath, opts.mcp, safeOnEvent).then(runChild);
  } else {
    runChild();
  }
  
  const abort = () => {
    isAborted = true;
    if (childController) childController.abort();
    else resolveDone();
  };
  
  return { abort, done: donePromise };
}
