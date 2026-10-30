import { tools as mcpTools } from '../../mcp-tools.mjs';
import { thinkTool } from './think.mjs';
import { createTextEditorTool } from './textEditor.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { injectCardParams, injectPartParams } from '../../card-params-schema.mjs';
import { isUserMessageCall } from '../agent.mjs';
import { userMessageTool, answerUserMessage } from './userMessage.mjs';
import { codeCacheTools } from '../../tools/code-cache.mjs';

/**
 * `only`:给了就只把名单里的工具交给模型(托管档的开放清单);`localTools: false` 不带读写本地文件的 text_editor。
 * 两个都不给时与原来相同。
 */
export async function buildTools({ callTool, workspaceDir, onEvent = () => {}, pollIntervalMs = 3000, jobTimeoutMs = 600000, only = null, localTools = true, codeCache = null }) {
  async function waitForJob(name, input, initial, context) {
    const workflow = name === 'auto_workflow' && initial?.running === true || name === 'auto_workflow_status' && initial?.done === false;
    const background = ['stt_install', 'transcribe_media'].includes(name) && initial?.jobId;
    if (!workflow && !background) return initial;
    const jobId = initial.jobId || input.jobId;
    const start = Date.now();
    while (Date.now() - start < jobTimeoutMs) {
      context.signal?.throwIfAborted();
      onEvent({ type: 'progress', phase: 'waiting', round: context.round, callId: context.callId, jobId, text: `后台任务进行中：${name}，已等待 ${Math.floor((Date.now() - start) / 1000)} 秒；自动等待，不消耗模型轮数。` });
      await delay(pollIntervalMs, undefined, { signal: context.signal });
      const status = await callTool(workflow ? 'auto_workflow_status' : 'background_job_status', { jobId });
      onEvent({ type: 'diagnostic', stage: 'job_poll', callId: context.callId, data: status });
      if (!status?.done) continue;
      if (status.ok === false) throw new Error(status.error || '后台任务失败，请检查安装或转写日志。');
      if (name === 'transcribe_media') return await callTool('get_transcript', { mediaId: input.mediaId });
      if (name === 'stt_install') return await callTool('stt_status', {});
      return status.result ?? status;
    }
    throw new Error(`后台任务 ${jobId} 等待超时；任务可能仍在运行，请先查询状态，不要重复启动。`);
  }
  const offered = only ? mcpTools.filter((t) => only.has(t.name)) : mcpTools;
  const result = offered.map(t => ({
    name: t.name,
    description: t.description + (['auto_workflow', 'stt_install', 'transcribe_media'].includes(t.name) ? ' API 模式会自动等待后台作业结束，不要自己密集轮询或重复启动。' : ''),
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

  // 把 add_clip / update_clip 的 params 换成按 cardId 分支的真实 schema。
  // 不做这一步的话它是个自由对象,模型看到的是「没有任何字段」,一个卡片参数都传不出去
  // —— MCP server 那条路一直做了这件事,API 直连这条路以前漏了。
  try {
    const cards = await callTool('list_cards', { detail: 'full' });
    injectCardParams(result, cards);
  } catch (error) {
    // 拿不到卡片列表就退回自由对象:少了参数提示总比工具整个不能用强
    onEvent({ type: 'status', text: `没能取到卡片 schema,add_clip 的参数提示会缺失:${error.message}` });
  }

  try {
    const parts = await callTool('list_parts', { detail: 'full' });
    injectPartParams(result, parts);
  } catch (error) {
    onEvent({ type: 'status', text: `没能取到部件 schema,add_part 的参数提示会缺失:${error.message}` });
  }

  return result;
}
