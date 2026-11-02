import { tools as mcpTools } from '../../mcp-tools.mjs';
import { thinkTool } from './think.mjs';
import { createTextEditorTool } from './textEditor.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { injectCardParams, injectPartParams } from '../../card-params-schema.mjs';
import { isUserMessageCall } from '../agent.mjs';
import { userMessageTool, answerUserMessage } from './userMessage.mjs';
import { codeCacheTools } from '../../tools/code-cache.mjs';
import { loadSkillTool } from '../../tools/agent-skills.mjs';

/**
 * `only`:给了就只把名单里的工具交给模型(托管档的开放清单);`localTools: false` 不带读写本地文件的 text_editor。
 * 两个都不给时与原来相同。
 */
export async function buildTools({ callTool, workspaceDir, onEvent = () => {}, pollIntervalMs = 3000, jobTimeoutMs = 600000, only = null, localTools = true, codeCache = null, skills = [] }) {
  async function waitForJob(name, input, initial, context) {
    const workflow = name === 'auto_workflow' && initial?.running === true || name === 'auto_workflow_status' && initial?.done === false;
    const background = ['stt_install', 'transcribe_media'].includes(name) && initial?.jobId;
    if (!workflow && !background) return initial;
    const jobId = initial.jobId || input.jobId;
    const start = Date.now();
    while (Date.now() - start < jobTimeoutMs) {
      context.signal?.throwIfAborted();
      onEvent({ type: 'progress', phase: 'waiting', round: context.round, callId: context.callId, jobId, text: `Background task in progress: ${name}, waited ${Math.floor((Date.now() - start) / 1000)} s; waiting automatically, no model rounds used.` });
      await delay(pollIntervalMs, undefined, { signal: context.signal });
      const status = await callTool(workflow ? 'auto_workflow_status' : 'background_job_status', { jobId });
      onEvent({ type: 'diagnostic', stage: 'job_poll', callId: context.callId, data: status });
      if (!status?.done) continue;
      if (status.ok === false) throw new Error(status.error || 'Background task failed. Check the install or transcription log.');
      if (name === 'transcribe_media') return await callTool('get_transcript', { mediaId: input.mediaId });
      if (name === 'stt_install') return await callTool('stt_status', {});
      return status.result ?? status;
    }
    throw new Error(`Timed out waiting for background task ${jobId}; it may still be running. Check its status first and do not start it again.`);
  }
  const offered = only ? mcpTools.filter((t) => only.has(t.name)) : mcpTools;
  const result = offered.map(t => ({
    name: t.name,
    description: t.description + (['auto_workflow', 'stt_install', 'transcribe_media'].includes(t.name) ? ' In API mode background jobs are awaited automatically; do not poll densely or restart them yourself.' : ''),
    // 深拷贝:下面要就地改写 params,而 mcpTools 是整个进程共享的模块级常量
    inputSchema: JSON.parse(JSON.stringify(t.inputSchema)),
    // context.callId 是这次 tool_use 的 id:交给编辑器放进工具调用事件,页面 AI 栏按它对上聊天记录(c65-integ2)
    async execute(input, context = {}) { return waitForJob(t.name, input, await callTool(t.name, input, { callId: context.callId }), context); },
  }));
  /*
   * send_message 的 to: "user"(对用户说一两句话,界面画进气泡,2026-10-20 用户定)在这里就地答,不经公告板:
   * 云端与本机都走这一层,不用另开路由。别的收件人照旧交给 callTool(多 Agent 协调)。
   * 托管档的开放清单里没有 send_message 时,单独补一个只能发给用户的。
   */
  const coord = result.find((t) => t.name === 'send_message');
  if (coord) {
    const forward = coord.execute;
    coord.execute = async (input, context = {}) => (isUserMessageCall(coord.name, input) ? answerUserMessage(input) : forward(input, context));
  } else result.push(userMessageTool());
  result.push(thinkTool);
  if (localTools) result.push(createTextEditorTool(workspaceDir));
  /*
   * 代码块空间(A07,2026-10-22):本机与云端都给,不受托管档开放清单(only)限制——它只读写这个项目的代码块目录,
   * 不碰项目、素材和别的文件。目录由宿主定(runners/api.mjs 的 codeCacheDir)。
   */
  if (codeCache) result.push(...codeCacheTools(codeCache));
  // 技能(issue 46):同样本机与云端都给,不受开放清单限制——它只读说明,不经 callTool
  if (skills.length) result.push(loadSkillTool(skills));

  // 把 add_clip / update_clip 的 params 换成按 cardId 分支的真实 schema。
  // 不做这一步的话它是个自由对象,模型看到的是「没有任何字段」,一个卡片参数都传不出去
  // —— MCP server 那条路一直做了这件事,API 直连这条路以前漏了。
  try {
    const cards = await callTool('list_cards', { detail: 'full' });
    injectCardParams(result, cards);
  } catch (error) {
    // 拿不到卡片列表就退回自由对象:少了参数提示总比工具整个不能用强
    onEvent({ type: 'status', text: `Could not fetch the card schema; add_clip parameter hints will be missing: ${error.message}` });
  }

  try {
    const parts = await callTool('list_parts', { detail: 'full' });
    injectPartParams(result, parts);
  } catch (error) {
    onEvent({ type: 'status', text: `Could not fetch the part schema; add_part parameter hints will be missing: ${error.message}` });
  }

  return result;
}
