/**
 * Single-output limit (A07, user decision, 2026-10-22: "increase single-output limit").
 *
 * Originally all three providers hardcoded `cfg.maxTokens || 4096`, and models were truncated after
 * spending 4096 tokens on thinking and a large tool argument.
 * Now the limit genuinely allowed is retrieved by model; models not found are given the conservative
 * value UNKNOWN_OUTPUT_TOKENS, and if the gateway returns 400 because the number is too large, the
 * provider drops down one tier and retries once.
 *
 * `maxTokens` in config is the **ceiling of limits**: when configured, it will not exceed it (taking
 * the smaller of it and the model limit). If not configured, or equal to the old default 4096,
 * treat as unconfigured and use the model limit [ruling:output-cache 2026-10-22]: 4096 was the old
 * default automatically written into config files by `ai-config.mjs`, `set-key.mjs`, and
 * `service-keys.mjs` when left empty by the user, not deliberately decided by anyone; adhering to
 * it means it could never be adjusted larger. If you genuinely want to cap below 4096, fill in a
 * smaller number.
 *
 * Source of numbers: Claude models use the model table from the claude-api skill `shared/models.md`
 * (cached on 2026-10-06); GPT and Gemini use "max output tokens" from their official documentation
 * (gpt-5 family 128000, o-series 100000, gpt-4.1 32768, gpt-4o 16384; gemini-2.5 and later 65536,
 * 2.0 and 1.5 are 8192). Unrecognized model names use UNKNOWN_OUTPUT_TOKENS. Tested on 2026-10-22
 * against the openlux gateway: when gemini-3.8-flash and claude-sonnet-5-5 use the OpenAI-compatible
 * endpoint, setting max_tokens to 1000000 / 300000 still returns 200 as usual (the gateway clamps
 * to the upstream limit itself), so setting it too high will not make this path fail.
 */

/** Old default: treated as unconfigured when this number is in config */
export const LEGACY_DEFAULT_MAX_TOKENS = 4096;
/** Used for unrecognized models */
export const UNKNOWN_OUTPUT_TOKENS = 16384;
/** Tiers tried in sequence when downgrading tiers */
export const OUTPUT_TIERS = Object.freeze([128000, 100000, 65536, 64000, 32768, 32000, 16384, 8192, 4096]);

// Model names may carry prefixes (`openai/gpt-5`, `models/gemini-2.5-pro`); only recognized at
// start or after `/` or `:`
const at = (body) => new RegExp(`(?:^|[/:])(?:${body})`, 'i');
/** Specific before general: first match wins */
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

/** Single-output limit for this model; returns null if unrecognized */
export function modelOutputLimit(model) {
  const name = String(model || '').trim();
  if (!name) return null;
  for (const [re, limit] of TABLE) if (re.test(name)) return limit;
  return null;
}

/**
 * Output limit actually sent for this request: min(model limit, config limit, limit calculated from
 * measured speed).
 * The third item is `cfg.outputCap` (a function returning a number, provided by `runners/api.mjs`
 * based on `output-speed.mjs`; ensures a request finishes writing before the ~300s gateway cutoff,
 * user decision, 2026-10-22); omitted if not provided.
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
 * Which field to use for OpenAI-compatible endpoints: o-series and reasoning models from GPT-5
 * onward recognize `max_completion_tokens` (sending `max_tokens` to them on official endpoints
 * returns an immediate 400), and the rest send `max_tokens`. Never include both: some upstreams
 * also return 400 when seeing both.
 */
export function usesMaxCompletionTokens(model) {
  return at('o[1-9](?:-|$)|gpt-[5-9]').test(String(model || '').trim());
}

/**
 * Whether this 400 indicates "output limit too large"; returns next tier value if so, null if not.
 * If the error message specifies a limit (e.g. Anthropic's "max_tokens: 200000 > 128000" or OpenAI's
 * "at most 16384"), use the one from the error; if not specified, pick the next tier in
 * OUTPUT_TIERS smaller than current.
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

/**
 * Whether this 400 indicates wrong field name (needs switching to the other field): returns
 * 'max_tokens' / 'max_completion_tokens' indicating which to switch to, or null if not
 */
export function swapOutputParamAfter400(text, sent) {
  const s = String(text || '');
  if (!/unsupported|not supported|unrecognized|unknown|not allowed|extra inputs|invalid param/i.test(s) && !/use ['"`]?max_completion_tokens/i.test(s)) return null;
  // "max_completion_tokens" does not contain the substring "max_tokens", so the two will not
  // misidentify each other
  if (sent === 'max_tokens' && /max_tokens/i.test(s)) return 'max_completion_tokens';
  if (sent === 'max_completion_tokens' && /max_completion_tokens/i.test(s)) return 'max_tokens';
  return null;
}
