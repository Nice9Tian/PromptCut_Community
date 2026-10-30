import type { ChatMessage, MessageRuntime, PublicAiConfig, RunEvent } from './types';

// Redact structured secrets and common pasted credentials; never include API
// headers, raw settings files, or provider reasoning channels in an export.
export function redactDebug(value: unknown): unknown {
  /*
   * 键名匹配**不能用首尾锚点**。原来写的是 /^(api[_-]?key|authorization|…)$/,
   * 于是 `x-api-key`、`anthropic-api-key`、`proxy-authorization` 这些真实请求头
   * 一个都不匹配 —— 明文 Key 就这么原样进了上传的诊断报告。
   *
   * 但也不能放宽成「含 token 就打码」:`max_tokens`、`promptTokens` 这些是排查时
   * 最有用的数字。所以改成「在词边界(开头或 - _ . 之后)上整段结尾匹配」:
   * `x-api-key` 命中、`max_tokens` 不命中。
   */
  const secret = /(^|[-_.])(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|client[_-]?secret|secret|cookie|credential|ticket|delegation|delegate|grant)s?$/i;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
      // 另几家厂商的 Key 形状,以及托管端的委托票据与对话委托(v1.<段>.<段>,见 server/auth/tickets.mjs)。
      // 云端对话的报告早就按这些形状扫;本机对话的报告同样可能从工具结果、错误消息或用户粘贴里把它们带进来,是同一道底线。
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
      .replace(/\bxai-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
      .replace(/\bgsk_[A-Za-z0-9]{16,}/g, '[REDACTED]')
      .replace(/\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[TICKET-REDACTED]')
      // 本机识别码是配置分发的解密口令，整串不能进报告。服务端那份已经先截过了，
      // 这里再兜一道：它也可能从执行日志、错误消息、用户粘进来的文本里溜进来。
      .replace(/\bPCM-[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}\b/gi, (m) => `${m.slice(0, 9)}-…`)
      // 查询串里的凭据。原来只列了四个固定名字，漏掉了最常见的裸 `token=`；
      // 改成「参数名里带 key/token/secret/password/auth/sig 就打码」——
      // 诊断报告这种场合，宁可多打掉几个也不能漏一个。
      .replace(/([?&][\w.-]*(?:key|token|secret|password|passwd|auth|sig)[\w.-]*=)[^&\s"']+/gi, '$1[REDACTED]')
      // 用户名是 PII，而本机路径几乎每条日志里都有。只抹掉家目录那一段，
      // 后面的相对结构留着——排查要靠它看出文件放在哪一层。
      .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/"'\s]+/gi, '$1[USER]')
      .replace(/(\/(?:home|Users)\/)[^/"'\s]+/g, '$1[USER]');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, secret.test(k) ? '[REDACTED]' : walk(x)]));
    return v;
  };
  return walk(value);
}

export function recordTrace(message: ChatMessage, event: RunEvent): ChatMessage {
  const trace = message.trace || [];
  if ((trace.length >= 2000 || (message.traceBytes || 0) >= 1500000) && event.type !== 'done' && event.type !== 'error') return { ...message, traceTruncated: true };
  // A tool result's full output (get_project returns the whole project) is never
  // shown by the chat, and redacting plus serialising it on every result was the
  // expensive part of tracing. The summary is kept; the output is marked omitted.
  const traced = event.type === 'tool_result' && 'output' in event
    ? { ...event, output: undefined, outputOmitted: true }
    : event;
  const serialized = JSON.stringify(redactDebug(traced));
  // Huge project/video results should not fill localStorage or freeze the UI.
  const safeEvent: RunEvent = serialized.length > 32000
    ? { type: 'diagnostic', stage: 'large_event_truncated', data: { originalType: event.type, chars: serialized.length, preview: serialized.slice(0, 32000) } }
    : JSON.parse(serialized);
  const last = trace.at(-1);
  if (safeEvent.type === 'text' && last?.event.type === 'text' && last.event.delta.length < 8000) {
    return { ...message, traceBytes: (message.traceBytes || 0) + serialized.length, trace: [...trace.slice(0, -1), { ...last, event: { type: 'text', delta: last.event.delta + safeEvent.delta } }] };
  }
  return { ...message, traceBytes: (message.traceBytes || 0) + Math.min(serialized.length, 32000), trace: [...trace, { at: new Date().toISOString(), event: safeEvent }], traceTruncated: message.traceTruncated || serialized.length > 32000 };
}

/** 同一套设置压成一行,用来数「这段对话里前后到底用过几种配置」 */
function runtimeKey(r: MessageRuntime): string {
  return [r.provider, r.model || '(默认)', r.effort || '(默认)', r.fast ? 'fast' : '-', r.deepAuto ? 'deep' : '-', r.toolProtocol ? 'textproto' : '-'].join(' / ');
}

/**
 * 一句人话描述这条回复用的是什么，放进报告顶上，省得从几百行 JSON 里翻。
 */
function describeRuntime(r: MessageRuntime): string {
  const bits = [r.provider, `模型 ${r.model || '默认'}`, `思考 ${r.effort || '默认'}`];
  if (r.fast) bits.push('加速');
  // 具体多少轮在设置里(deepAutoRounds),这条 runtime 没记,所以只说开着,不报一个可能是错的数
  if (r.deepAuto) bits.push('深度自主');
  if (r.toolProtocol) bits.push('文本协议模式');
  return bits.join('，');
}

export function conversationReport(messages: ChatMessage[], provider: string | null, config?: PublicAiConfig | null, environment?: unknown): string {
  /*
   * 每条回复自己带 runtime。只报「当前选的是什么」会看错人：模型、思考档、加速档
   * 都是发送那一刻现读的，用户聊到一半换一次，前后几条就来自不同的模型；分工模式
   * 下还会按角色临时改用别家。中途换过就在这里直接点出来。
   */
  const used = new Map<string, MessageRuntime>();
  let unrecorded = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m.runtime) used.set(runtimeKey(m.runtime), m.runtime);
    else unrecorded++;
  }
  const distinct = [...used.values()];

  return JSON.stringify(redactDebug({
    format: 'PromptCut conversation debug v2', exportedAt: new Date().toISOString(), provider,
    runtime: {
      switchedMidConversation: distinct.length > 1,
      summary: distinct.length === 0
        ? '这段对话里没有一条记了运行配置（0.2.9 之前的旧历史）'
        : distinct.length === 1
          ? `全程一套配置：${describeRuntime(distinct[0])}`
          : `⚠ 中途换过配置，共 ${distinct.length} 套，逐条见 messages[].runtime`,
      used: distinct.map((r) => ({ ...r, 说明: describeRuntime(r) })),
      // 旧历史里的回复没有这个字段，说清楚是「没记」而不是「没换过」
      unrecordedAssistantMessages: unrecorded,
      textProtocolEverUsed: distinct.some((r) => r.toolProtocol),
    },
    api: provider === 'api' ? { vendor: config?.api.vendor, model: config?.api.model, maxTokens: config?.api.maxTokens } : undefined,
    /*
     * 出问题那一刻的现场:模式、项目和素材、后端会话文件柜、Node 进程状态。
     *
     * 只有对话的话,「产品的 bug」和「这台机器的环境问题」一条都排除不掉。
     * 用户报「Agent 看得见别的项目的素材」时就是这样:报告里看得到模型说出一个
     * 不存在的文件名,却看不到当时素材库是不是空的、项目存在哪 —— 只能来回问。
     *
     * 采集失败不挡报告:少一段现场也比整份导不出来强,所以这里收的是
     * 「拿到了什么」而不是「一定拿得到」,失败时上游填一个 error 进来。
     */
    environment,
    note: '包含可见对话、执行事件和当时的环境快照；不包含密钥或模型私有思考。大输出和过长事件会标明截断。', messages,
  }), null, 2);
}

/**
 * 超过这个长度就锁住「复制」,只留存文件那条路。
 *
 * 挑 10 万字符是按「还贴得动吗」来的:带上每一步执行事件之后报告轻松几百 KB,
 * 粘进聊天框既卡又没人看得下去,不如给个文件让用户直接发过来。
 */
export const DEBUG_INLINE_LIMIT = 100_000;

/** 存到本地的「诊断报告」目录并打开所在文件夹,返回落盘路径 */
export async function saveReportToFile(text: string, label: string): Promise<{ dir: string; file: string }> {
  const res = await fetch('/api/ai/diagnostics/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, label }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.error || `保存失败 HTTP ${res.status}`);
  return { dir: data.dir, file: data.file };
}

export async function copyDebugReport(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* WebView/permissions fallback. */ }
  const field = document.createElement('textarea');
  field.value = text; field.style.position = 'fixed'; field.style.opacity = '0';
  document.body.appendChild(field); field.select();
  try { if (!document.execCommand('copy')) throw new Error('自动复制失败,请手动选中文本复制'); }
  finally { field.remove(); }
}

/**
 * 在浏览器里把报告存成文件(下载一份)。在线页面没有编辑器进程可以替它写盘(也不许请求 `/api/*`),云端对话的诊断报告走这条;
 * 返回一句给用户看的回执。
 */
export function downloadReportFile(text: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const name = `${label.replace(/[\/:*?"<>|\s]+/g, '_') || '诊断报告'}-${stamp}.json`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return `已下载:${name}`;
}
