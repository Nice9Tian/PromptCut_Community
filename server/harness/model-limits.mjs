/**
 * 单次输出上限(A07,2026-10-22 用户定:「把单次输出上限调大」)。
 *
 * 原来三家 provider 都写死 `cfg.maxTokens || 4096`,模型把 4096 个 token 花在思考和一个大工具参数上就被截断。
 * 现在按模型取它真实允许的上限;查不到的模型给保守值 UNKNOWN_OUTPUT_TOKENS,网关因为数太大回 400 时由 provider 降一档重试一次。
 *
 * 配置里的 `maxTokens` 是**上限的上限**:配了就不超过它(取它和模型上限里小的那个)。没配、或者等于旧缺省 4096,
 * 当作没配,用模型上限〔裁:output-cache 2026-10-22〕—— 4096 是 `ai-config.mjs`、`set-key.mjs`、`service-keys.mjs`
 * 在用户没填时自动写进配置文件的旧缺省,不是谁特意定的;照它办就永远调不大。真想压到 4096 以下就填一个更小的数。
 *
 * 数字出处:Claude 各型号取 claude-api 技能 `shared/models.md` 的模型表(缓存于 2026-10-06);GPT、Gemini 取各家公开文档的
 * 「max output tokens」(gpt-5 系 128000、o 系 100000、gpt-4.1 32768、gpt-4o 16384;gemini-2.5 及以后 65536、2.0 与 1.5 是 8192)。
 * 认不出的模型名用 UNKNOWN_OUTPUT_TOKENS。2026-10-22 实测 openlux 网关:gemini-3.8-flash、claude-sonnet-5-5 走 OpenAI 兼容口时,
 * max_tokens 给到 1000000 / 300000 都照常回 200(网关自己压到上游的上限),所以给大了不会让这条路失败。
 */

/** 旧缺省:配置里是这个数时当作没配 */
export const LEGACY_DEFAULT_MAX_TOKENS = 4096;
/** 认不出的模型用这个 */
export const UNKNOWN_OUTPUT_TOKENS = 16384;
/** 降档时依次试的档位 */
export const OUTPUT_TIERS = Object.freeze([128000, 100000, 65536, 64000, 32768, 32000, 16384, 8192, 4096]);

// 模型名可能带前缀(`openai/gpt-5`、`models/gemini-2.5-pro`),只在开头或 `/`、`:` 后面认
const at = (body) => new RegExp(`(?:^|[/:])(?:${body})`, 'i');
/** 先具体后笼统:第一个对上的算 */
const TABLE = [
  // Claude
  [at('claude-(?:fable|mythos)'), 128000],
  [at('claude-(?:opus|sonnet|haiku)-[5-9]'), 128000],
  [at('claude-(?:opus-4-[6-9]|sonnet-4-[6-9])'), 128000],
  [at('claude-(?:opus-4-5|sonnet-4-5|haiku-4-5)'), 64000],
  [at('claude-opus-4(?:-[01])?(?:-20\\d{6})?$'), 32000],
  [at('claude-sonnet-4(?:-0)?(?:-20\\d{6})?$|claude-3-7-sonnet'), 64000],
  [at('claude-3-5'), 8192],
  [at('claude-3-'), 4096],
  [at('claude'), 64000],
  // OpenAI
  [at('gpt-[5-9]'), 128000],
  [at('o[1-9](?:-|$)'), 100000],
  [at('gpt-4\\.1'), 32768],
  [at('gpt-4o'), 16384],
  [at('gpt-4|gpt-3\\.5'), 4096],
  // Gemini
  [at('gemini-(?:2\\.5|[3-9])'), 65536],
  [at('gemini-(?:2\\.0|1\\.5|1\\.0)'), 8192],
  [at('gemini'), 65536],
];

/** 这个模型的单次输出上限;认不出回 null */
export function modelOutputLimit(model) {
  const name = String(model || '').trim();
  if (!name) return null;
  for (const [re, limit] of TABLE) if (re.test(name)) return limit;
  return null;
}

/**
 * 这一次请求真正发出去的输出上限:min(模型上限, 配置上限, 按实测速度算的上限)。
 * 第三项是 `cfg.outputCap`(一个回数字的函数,`runners/api.mjs` 按 `output-speed.mjs` 给;让一次请求在网关约 300 秒掐断之前写完,
 * 2026-10-22 用户定),没给就不算。
 */
export function resolveMaxOutput(cfg) {
  const known = modelOutputLimit(cfg?.model);
  const configured = Number(cfg?.maxTokens);
  const base = (!Number.isFinite(configured) || configured <= 0 || configured === LEGACY_DEFAULT_MAX_TOKENS)
    ? (known ?? UNKNOWN_OUTPUT_TOKENS)
    : (known ? Math.min(Math.floor(configured), known) : Math.floor(configured));
  let speedCap = null;
  try { speedCap = typeof cfg?.outputCap === 'function' ? Number(cfg.outputCap()) : null; } catch { speedCap = null; }
  return Number.isFinite(speedCap) && speedCap > 0 ? Math.min(base, Math.floor(speedCap)) : base;
}

/**
 * OpenAI 兼容口用哪个字段:o 系、GPT-5 及以后的推理模型认 `max_completion_tokens`(官方接口对它们发 `max_tokens` 直接 400),
 * 其余发 `max_tokens`。两个不同时带:有的上游见到两个都带也回 400。
 */
export function usesMaxCompletionTokens(model) {
  return at('o[1-9](?:-|$)|gpt-[5-9]').test(String(model || '').trim());
}

/**
 * 这条 400 说的是不是「输出上限太大」;是的话回下一档的数,不是回 null。
 * 报错里写了上限(如 Anthropic 的「max_tokens: 200000 > 128000」、OpenAI 的「at most 16384」)就用报错里那个,
 * 没写就取 OUTPUT_TIERS 里比现在小的下一档。
 */
export function lowerOutputAfter400(text, current) {
  const s = String(text || '');
  if (!/max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens|output tokens/i.test(s)) return null;
  if (!/too large|exceed|maximum|at most|less than or equal|<=|out of range|range|>\s*\d|greater than|invalid|limit/i.test(s)) return null;
  const cur = Number(current) || 0;
  const said = [...s.matchAll(/\d[\d,_]*/g)].map((m) => Number(m[0].replace(/[,_]/g, ''))).filter((n) => n >= 1024 && n < cur);
  if (said.length) return Math.max(...said);
  const tier = OUTPUT_TIERS.find((n) => n < cur);
  return tier ?? null;
}

/** 这条 400 是不是在说字段名不对(要换另一个字段):回 'max_tokens' / 'max_completion_tokens' 表示该换成哪个,不是回 null */
export function swapOutputParamAfter400(text, sent) {
  const s = String(text || '');
  if (!/unsupported|not supported|unrecognized|unknown|not allowed|extra inputs|invalid param/i.test(s) && !/use ['"`]?max_completion_tokens/i.test(s)) return null;
  // 「max_completion_tokens」里不含「max_tokens」这个子串,两条不会互相误认
  if (sent === 'max_tokens' && /max_tokens/i.test(s)) return 'max_completion_tokens';
  if (sent === 'max_completion_tokens' && /max_completion_tokens/i.test(s)) return 'max_tokens';
  return null;
}
