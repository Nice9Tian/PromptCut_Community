import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnCli, resolveExe, lineSplitter, probeVersion } from './index.mjs';
import { execFileSync } from 'node:child_process';

import { tools } from '../mcp-tools.mjs';

/**
 * Description of Claude Code built-in tools, same as AGY_ADDENDUM in agy.mjs.
 *
 * --allowedTools only permits mcp__promptcut__*, while built-in Read / Glob / Grep / Bash /
 * PowerShell / WebFetch are all rejected here. The model does not know this: in a real chat, Opus
 * wanted to see a jpg in the media library, so it first tried Read on disk paths, then Bash curl,
 * then PowerShell Invoke-WebRequest to guess the address, trying 7 different ways and getting
 * rejected on all of them, finally stopping to ask the user for permission; whereas what it
 * actually needed (how cards reference media, where to look for missing media) is all in PromptCut
 * tools.
 */
const CLAUDE_ADDENDUM = `
## About Claude Code's built-in tools (only you need to read this)

Besides the PromptCut tools (mcp__promptcut__*), you can also see Claude Code's built-in Read / Write / Edit / Glob / Grep /
Bash / PowerShell / WebFetch / WebSearch. **Here they are all rejected**: this is an unattended session and nobody can approve them for you;
switching to another built-in tool or another way of writing the command gives the same result. A rejection brings no new information and only wastes a turn.

Every task you need to do has a matching PromptCut tool:

| What you want to do | Use this, not the built-in tools |
| --- | --- |
| See what is in the project (tracks, clips, media, cards) | \`get_project\` / \`get_clip\` / \`list_media\` / \`list_cards\` |
| See what a media image / video looks like | \`see_frames({ source: "media", mediaId })\`, do not Read the media's disk path |
| Use a media library image / video in a card | Put the \`cardUrl\` returned by \`list_media\` (/@media/<file name>) into the card parameters; do not guess addresses or probe with curl |
| The media library has no suitable footage | Video: \`collect_search\` → \`collect_download\`; image: once you find a direct link, \`import_media({ url, name })\` |
| Read web pages, look things up | \`web_open\` / \`web_read\`, not WebFetch / curl |
| Handle attachments sent by the user | \`import_media({ url })\`, taking the url from the in-site address in the attachment manifest |
| View a card's source / edit a card | \`get_card_source\` / \`edit_card\` |
| Wait a few seconds, then check a background job | \`wait({ seconds })\` |
| Find earlier chat records or handoff notes | No such files exist. The "background" attached at the start of the message is everything; if it is not enough, call \`report_progress\` and ask the user in the todo |
| Report to the user at the end of each small stage and when the whole task wraps up | \`report_progress\` |
| Tell the user what you will do next or what you just finished (shown in the chat bubble) | \`send_message\`, set \`to\` to "user" |
`;

function getAllowedToolsArgv() {
  const arr = ['mcp__promptcut'];
  for (const t of tools) {
    arr.push(`mcp__promptcut__${t.name}`);
  }
  return arr;
}

export async function getClaudeProvider() {
  const exePath = resolveExe('claude');
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
  return { id: 'claude', label: 'Claude Code', available, version, path: exePath, note };
}

import { runTextProtocolLoop } from '../harness/tool-protocol.mjs';
import { tr } from '../i18n.mjs';

export function startRun(opts) {
  if (opts.toolProtocol) {
    return runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent, tools });
  }

  let abortRef = { abort: () => {} };
  let rejected = false;

  const interceptOnEvent = (ev) => {
    if (ev.type === 'status' && ev.text && ev.text.includes('permission_denials')) {
        // Just in case
    }
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

function _startRun(opts) {
  const exePath = resolveExe('claude');
  
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  
  if (opts.mcp) {
    const tempDir = path.join(os.tmpdir(), 'promptcut');
    fs.mkdirSync(tempDir, { recursive: true });
    const mcpConfigPath = path.join(tempDir, 'mcp-claude.json');
    
    const mcpConfig = {
      mcpServers: {
        "promptcut": {
          command: opts.mcp.command,
          args: opts.mcp.args,
          env: opts.mcp.env
        }
      }
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8');
    
    args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowedTools', ...getAllowedToolsArgv());
  }

  /*
   * System prompts go through **files**, not command-line arguments.
   *
   * Previously it was `--append-system-prompt <full_text>`. The system prompt itself is just over
   * 15,000 characters, which holds up normally; as soon as native tools are rejected, startRun
   * retries via the text protocol. Appending that tool manifest (33,000 characters) into
   * systemPrompt makes it 48,000, exceeding the Windows single command-line limit of 32767,
   * immediately throwing `spawn ENAMETOOLONG`: in actual diagnostic reports, this was how Opus ended,
   * and this fallback path never succeeded once. stdin is already occupied by the user message, so
   * write a temporary file and delete it after running.
   */
  const promptDir = path.join(os.tmpdir(), 'promptcut');
  fs.mkdirSync(promptDir, { recursive: true });
  const promptFile = path.join(promptDir, `claude-system-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.md`);
  fs.writeFileSync(promptFile, `${opts.systemPrompt}\n${CLAUDE_ADDENDUM}`, 'utf8');
  args.push('--append-system-prompt-file', promptFile);
  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.effort) {
    args.push('--effort', opts.effort);
  }
  // The fast tier is the fastMode setting in Claude Code, with no corresponding CLI flag;
  // --settings accepts a JSON string, so inject this setting directly. It is different from --effort:
  // effort adjusts how much it thinks, while fastMode adjusts output speed; both can be on at once.
  if (opts.fast) {
    args.push('--settings', JSON.stringify({ fastMode: true }));
  }

  const { child, safeOnEvent, finish, abort, donePromise } = spawnCli(exePath, args, { cwd: opts.cwd }, opts.onEvent, 'Claude Code');
  
  const toolIdToName = new Map();

  child.stdout.on('data', lineSplitter(line => {
    if (!line.trim()) return;
    if (process.env.PROMPTCUT_RUNNER_DEBUG) console.error('[Claude] ' + line);
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'system') {
         if (ev.subtype === 'init') {
            safeOnEvent({ type: 'session', sessionId: ev.session_id });
         } else if (ev.subtype === 'status' && ev.status) {
            safeOnEvent({ type: 'status', text: `claude: ${ev.status}` });
         }
      } else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event?.delta?.type === 'text_delta') {
        safeOnEvent({ type: 'text', delta: ev.event.delta.text });
      } else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event?.delta?.type === 'thinking_delta') {
        // Thinking content goes through a separate path and is hidden by default; it is only rendered
        // when "Show thinking" is checked in the UI
        safeOnEvent({ type: 'thinking', delta: ev.event.delta.thinking });
      } else if (ev.type === 'assistant' && ev.message?.content) {
         for (const c of ev.message.content) {
            if (c.type === 'tool_use') {
               toolIdToName.set(c.id, c.name);
               // callId is required: when calling tools with the same name in parallel, the UI relies on it to
               // match results back; matching only by name causes entire rows to be misaligned
               safeOnEvent({ type: 'tool_call', callId: c.id, name: c.name, input: c.input });
            }
         }
      } else if (ev.type === 'user' && ev.message?.content) {
         for (const c of ev.message.content) {
            if (c.type === 'tool_result') {
               let summary = '';
               if (typeof c.content === 'string') summary = c.content;
               else if (Array.isArray(c.content)) summary = c.content.map(x => (x.text || '')).join('');
               
               const name = toolIdToName.get(c.tool_use_id) || 'unknown';
               safeOnEvent({ type: 'tool_result', callId: c.tool_use_id, name: name, ok: !c.is_error, summary: summary.substring(0, 300) });
            }
         }
      } else if (ev.type === 'result') {
         /*
          * Only when PromptCut's own tools are rejected does it indicate that the native tool channel is
          * broken and worth switching to the text protocol.
          *
          * --allowedTools only permits mcp__promptcut__*; built-in Read / Grep / Bash / Write / Skill being
          * rejected is normal (a user's global CLAUDE.md asking it to announce on completion will
          * definitely get Skill + Write rejected). Previously, any rejection counted, so even when the
          * entire turn was done and the reply was written, it swallowed done and reran from the beginning:
          * in diagnostic report chat-diagnostic-20260910-234339, rounds #7, #13, and #15 all threw errors
          * at the final step this way, while #9 and #11, which never touched built-in tools, ended normally.
          */
         const denials = [...(ev.permission_denials || []), ...(ev.result?.permission_denials || [])];
         if (denials.some((d) => String(d?.tool_name || '').startsWith('mcp__promptcut')) && opts.onPermissionDenied) {
             opts.onPermissionDenied();
         }
         if (ev.is_error) {
             const message = ev.result || ev.error?.message || ev.terminal_reason || tr("Claude error");
             finish({ type: 'error', message });
         } else {
             const usage = ev.usage || {};
             if (ev.total_cost_usd !== undefined) usage.total_cost_usd = ev.total_cost_usd;
             finish({ type: 'done', sessionId: ev.session_id, usage });
         }
      }
    } catch {}
  }));

  child.stdin.on('error', () => { /* ignore EPIPE */ });
  try {
      child.stdin.write(opts.prompt);
      child.stdin.end();
  } catch {
      // ignore
  }

  // Delete the temporary system prompt file after the run finishes (normal, error, or stopped)
  const done = donePromise.finally(() => {
    try { fs.rmSync(promptFile, { force: true }); } catch { /* ignore */ }
  });
  return { abort, done };
}
