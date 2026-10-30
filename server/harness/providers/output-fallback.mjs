/**
 * 输出上限的 400 降档 / 换字段:记一行日志,并交回一条 `notice` 事件(harness/agent.mjs 把它转成 diagnostic 事件,
 * 进运行日志与诊断报告)。日志名 `harness.max-output-fallback`。日志里只有厂商、模型、动作和数字,没有正文、没有 Key。
 */
export function noteOutputFallback({ vendor, model, action, from, to, status = 400 }) {
  const data = { vendor, model, action, from, to, status };
  try { console.error(`[harness.max-output-fallback] ${JSON.stringify(data)}`); } catch { /* 日志写不出去不影响这一轮 */ }
  return { type: 'notice', stage: 'max-output-fallback', data };
}

/** 已读过正文的错误响应包回一个壳,好让 assertOk 照常报出那句话 */
export const asRead = (r, text) => ({ ok: false, status: r.status, headers: r.headers, text: async () => text });
