/**
 * 从 OpenAI 兼容接口拉可用模型清单(`GET {baseUrl}/v1/models`)。
 *
 * 为什么单独一个文件而不是塞进 vite-plugin-ai:URL 拼法和响应形状都有坑,
 * 值得单测。插件那边只负责取配置、回 JSON。
 *
 * 官方 openai.com 也有这个口子,但清单里全是它自己的模型;真正用得上的是**中转站** ——
 * 它们把接的各家模型都列在这里,手填模型名很容易打错或者过期。
 *
 * 关于「思考模式」:这个接口回的是标准 OpenAI 形状(id / object / owned_by),
 * **没有**表示思考档位的字段。中转站的做法是把思考变体当成独立模型名(带 `-thinking`
 * 之类的后缀)一起列出来,所以拉清单顺带就把它们拉回来了 —— 但那是模型名,不是「模式」。
 * 档位本身走请求体的 `reasoning_effort`(见 harness/providers/openai.mjs)。
 */

/**
 * baseUrl 拼成 `/v1/models`。
 * 用户填的地址有的带 `/v1` 有的不带,和 providers/openai.mjs 里那套判断保持一致。
 */
export function modelsUrl(baseUrl) {
  let b = String(baseUrl || '').trim();
  while (b.endsWith('/')) b = b.slice(0, -1);
  if (!b) return '';
  return b.endsWith('/v1') ? `${b}/models` : `${b}/v1/models`;
}

/**
 * 从响应里把模型名摘出来。
 *
 * 标准形状是 `{ data: [{ id }] }`,但中转站的实现参差:见过直接回数组的,
 * 也见过元素是纯字符串的。能认就认,认不出来就返回空数组让调用方说「没读到」,
 * 别抛异常 —— 拉清单是个锦上添花的按钮,不该因为对方回了个怪东西就报错。
 */
export function parseModels(payload) {
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
    : [];
  const out = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.id ?? item?.name;
    if (typeof id !== 'string') continue;
    const name = id.trim();
    // 模型名允许字母数字和 . : / _ - (中转站常见 `provider/model:tag` 这种)
    if (!name || !/^[\w./:-]+$/.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * 拉一次清单。
 *
 * @param api  ai.json 里的 api 段(要用到 baseUrl / apiKey)
 * @param deps.fetchImpl 换成假的好单测
 */
export async function listApiModels(api, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const url = modelsUrl(api?.baseUrl);
  if (!url) throw new Error('接口地址是空的');
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${api?.apiKey || ''}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // 401 是最常见的一种,单独说人话;别把整个响应体贴出来(可能带 Key 回显)
    if (res.status === 401 || res.status === 403) throw new Error(`接口拒绝了这个 Key(HTTP ${res.status})`);
    throw new Error(`拉模型清单失败:HTTP ${res.status}`);
  }
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error('拉模型清单失败:回来的不是 JSON');
  }
  return parseModels(payload);
}
