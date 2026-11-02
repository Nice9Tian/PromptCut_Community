import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnCli, resolveExe, lineSplitter, probeVersion } from './index.mjs';
import { execFileSync } from 'node:child_process';

import { tools } from '../mcp-tools.mjs';

/**
 * Claude Code 自带工具的说明,和 agy.mjs 的 AGY_ADDENDUM 是同一回事。
 *
 * --allowedTools 只放行 mcp__promptcut__*,自带的 Read / Glob / Grep / Bash / PowerShell / WebFetch
 * 在这里一律被拒。模型不知道这一点:一次真实对话里 Opus 想看素材库的 jpg,先 Read 磁盘路径、
 * 再 Bash curl、再 PowerShell Invoke-WebRequest 猜地址,换了 7 种写法全部被拒,最后停下来找用户
 * 要权限;而它真正需要的东西(卡片怎么引用素材、缺素材去哪找)PromptCut 工具里全都有。
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
| Tell the user what you will do next or what you just finished (shown in the chat bubble) | \`send_message\`, set to to "user" |
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
    return runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
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
      const nextRun = runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
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
   * 系统提示词走**文件**,不走命令行参数。
   *
   * 原来是 `--append-system-prompt <整段>`。系统提示词本身 15,000 出头,平时撑得住;
   * 原生工具一被拒,startRun 就改走文本协议重试,那份工具清单(33,000 字符)拼进
   * systemPrompt 之后就是 48,000,超过 Windows 单条命令行 32767 的上限,当场
   * `spawn ENAMETOOLONG` —— 实测诊断报告里 Opus 就是这么收的尾,这条兜底路一次都没走通过。
   * stdin 已经被用户消息占了,所以落一个临时文件,跑完删掉。
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
  // 加速档在 Claude Code 里是设置项 fastMode,没有对应的命令行标志;
  // --settings 收 JSON 字符串,所以直接把这一项塞进去。它和 --effort 是两回事:
  // effort 调思考多少,fastMode 调出字快慢,可以同时开。
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
        // 思考内容单独走一路,默认不展示;界面上勾了「显示思考」才渲染出来
        safeOnEvent({ type: 'thinking', delta: ev.event.delta.thinking });
      } else if (ev.type === 'assistant' && ev.message?.content) {
         for (const c of ev.message.content) {
            if (c.type === 'tool_use') {
               toolIdToName.set(c.id, c.name);
               // callId 必带:并行调同名工具时界面靠它把结果对回去,只按名字配会整排错位
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
          * 只有 PromptCut 自己的工具被拒,才说明原生工具这条通道坏了、值得改走文本协议。
          *
          * --allowedTools 只放行 mcp__promptcut__*,自带的 Read / Grep / Bash / Write / Skill 被拒是常态
          * (用户全局 CLAUDE.md 让它收尾时播报,Skill + Write 必被拒)。原来任何一次被拒都算,于是整轮
          * 已经做完、答复也写好了,又吞掉 done 从头重跑一遍 —— 诊断报告 对话诊断-20260910-234339 里
          * #7 #13 #15 三轮都是这样在最后一步报错,而没碰过自带工具的 #9 #11 都正常结束。
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

  // 跑完(正常、出错、被停)都把临时的系统提示词文件删掉
  const done = donePromise.finally(() => {
    try { fs.rmSync(promptFile, { force: true }); } catch { /* ignore */ }
  });
  return { abort, done };
}
