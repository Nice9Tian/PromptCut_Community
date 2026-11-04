/**
 * Cap single-output limits based on measured output speed so a single request finishes writing
 * before gateway cutoff (user decision, 2026-10-22: "Fix now: treat mid-flight gateway cutoff as
 * truncation (preserve partial arguments, continue via code block), cap single output based on
 * measured speed").
 *
 * # Cause
 *
 * Tested on 2026-10-22 with openlux gateway + gemini-3.8-flash: gateway cuts off single requests
 * after about 300s, even for streaming:
 * a streaming request received an SSE error event at 300.7s (HTTP was still 200, original text
 * "The upstream stream ended before the response was complete."), while the stream was still actively
 * yielding data (1001 chunks, 40,000 characters).
 * Tested on the same day, Gemini's output speed was 50-190 token/s, fluctuating by about 3x; Claude
 * was not tested.
 * Once single-output limits are set to 65536 / 128000 per model (A07), filling it out in one request
 * takes 6-40 minutes, far exceeding 300s.
 *
 * # Approach [ruling:stream-cut 2026-10-22]
 *
 * - Record one sample upon completing each request: output token count this time ÷ duration from
 *   sending to completion (number reported in usage; thinking tokens count toward output).
 *   Use "from sent to completion" rather than "from first character to completion": the gateway's
 *   clock starts ticking when the request is sent, and waiting before the first character counts
 *   toward the 300s; furthermore, some upstreams do not stream thinking tokens, so calculating only
 *   from the first character would overestimate speed. Speeds calculated this way are lower, which is
 *   conservative.
 * - Do not record requests with output below MIN_SAMPLE_OUTPUT_TOKENS: elapsed time for short
 *   responses is almost entirely waiting before the first character, which says nothing about how fast
 *   long content can be written.
 * - For requests cut off mid-flight by the gateway (where usage usually was not returned), estimate
 *   token count as received characters ÷ 4 and record a sample; in Chinese one character is often one
 *   token, so calculating at 4 characters per token will only underestimate speed, remaining
 *   conservative.
 * - Retain the most recent KEEP_SAMPLES samples per model, not exceeding SAMPLE_MAX_AGE_MS; take the
 *   sample at the 25th percentile sorted from slowest to fastest (or the slowest if fewer than 5).
 * - Single-request cap = min(model limit, config limit, speed × OUTPUT_TIME_BUDGET_S), where the
 *   speed-based term is not lower than MIN_SPEED_CAP.
 * - When no samples are available yet, calculate using DEFAULT_TOKENS_PER_SECOND.
 *
 * # Where stored [ruling]
 *
 * A JSON file (path provided by host, `outputSpeedFile` in `runners/api.mjs`):
 * - Local: `output-speed.json` in the same directory as `ai.json` (kept together with review loop
 *   lessons, not placed in system temp directory where it could be purged);
 * - Cloud account mode: shared data directory `usage/model-speed.json`: task processes spawn a new
 *   generation each round, so process memory cannot persist; `usage/` is already the directory
 *   written by task processes and read by the main service (`usage.mjs`), writable across
 *   generations of task processes;
 * - Cloud legacy hosted tier: `<data-dir>/usage/model-speed.json`.
 * Shares a single in-memory copy per file path within the same process (still works normally when the
 * file cannot be read or written, but subsequent process generations will not receive it).
 * Multiple processes write concurrently without locks; last write wins, at most dropping one or two
 * samples.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Gateway duration limit for a single request (seconds): tested on 2026-10-22 with openlux,
 * streaming request was cut off at 300.7s
 */
export const GATEWAY_REQUEST_LIMIT_S = 300;
/**
 * Target completion duration for a single request (seconds). Leaves a 50s buffer below gateway
 * limit: speed fluctuates by about 3x (measured 50-190 token/s), the slower sample is selected,
 * and extra margin is reserved for pre-first-token latency and network.
 */
export const OUTPUT_TIME_BUDGET_S = 250;
/**
 * Speed when no samples exist (token/s). In tests Gemini was slowest at 50, with another 20% margin
 * below; Claude was not tested, and large models (such as Opus) typically output tens of tokens
 * per second, so 40 is not an overestimate. × 250 seconds = 10000 tokens, enough to write a
 * medium card.
 */
export const DEFAULT_TOKENS_PER_SECOND = 40;
/**
 * Requests outputting fewer than this many tokens do not record samples (pre-first-token wait
 * accounts for most of the duration, making the calculated speed uninformative)
 */
export const MIN_SAMPLE_OUTPUT_TOKENS = 2000;
/** Number of samples to retain per model */
export const KEEP_SAMPLES = 10;
/** Maximum sample retention duration (ms): gateway and upstream change, so stale samples are discarded */
export const SAMPLE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
/** Speed-based limit will not fall below this many tokens (if too small, cannot even fit an ordinary tool call) */
export const MIN_SPEED_CAP = 4096;
/**
 * When cut off and usage is not returned, estimate tokens at this many characters per token
 * (underestimate rather than overestimate)
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

const books = new Map();

/**
 * Key used to record samples: model name (lowercase, trimmed). Speed differences for the same
 * model across different gateways are not separated this time [ruling]
 */
export const speedKey = (model) => String(model || '').trim().toLowerCase();

function readFileSafe(file) {
  if (!file) return {};
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && v.models && typeof v.models === 'object' ? v.models : {};
  } catch { return {}; }
}

function cleanSamples(list, now) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && Number.isFinite(s.tps) && s.tps > 0 && Number.isFinite(s.t) && now - s.t <= SAMPLE_MAX_AGE_MS)
    .slice(-KEEP_SAMPLES);
}

/**
 * Pick a conservative speed from samples: 25th percentile sorted from slowest to fastest;
 * slowest if fewer than 5
 */
export function conservativeSpeed(samples) {
  const v = (samples || []).map((s) => s.tps).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.floor((v.length - 1) * 0.25)];
}

/**
 * @param {{ file?: string|null, now?: () => number, log?: (msg: string) => void }} o
 */
export function createOutputSpeedBook({ file = null, now = () => Date.now(), log = () => {} } = {}) {
  const models = Object.create(null);
  // Read file first: task process spawns a new generation each round, so previous generations'
  // recordings are in the file
  for (const [k, list] of Object.entries(readFileSafe(file))) models[k] = cleanSamples(list, now());

  const save = () => {
    if (!file) return;
    try {
      // Read once then merge: other processes may also have recorded during this time
      const disk = readFileSafe(file);
      const merged = {};
      for (const k of new Set([...Object.keys(disk), ...Object.keys(models)])) {
        const seen = new Set();
        merged[k] = cleanSamples([...(disk[k] || []), ...(models[k] || [])]
          .filter((s) => { const id = `${s?.t}:${s?.tps}`; if (seen.has(id)) return false; seen.add(id); return true; })
          .sort((a, b) => a.t - b.t), now());
        models[k] = merged[k];
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, models: merged }, null, 1), { encoding: 'utf8', mode: 0o660 });
      fs.renameSync(tmp, file);
    } catch (e) { log(`[harness.output-speed] failed to write speed record: ${e?.message || e}`); }
  };

  return {
    file,
    /**
     * Records a request. output is output token count (including thinking), ms is duration from sent
     * to completion; estimated indicates token count is estimated from character count.
     * Too-short requests are not recorded. Returns the recorded sample (or null if not recorded).
     */
    record(model, { output, ms, estimated = false }) {
      const key = speedKey(model);
      const out = Number(output) || 0, dur = Number(ms) || 0;
      if (!key || out < MIN_SAMPLE_OUTPUT_TOKENS || dur <= 0) return null;
      const sample = { t: now(), tps: Math.round((out / (dur / 1000)) * 10) / 10, out: Math.round(out), ms: Math.round(dur), ...(estimated ? { est: true } : {}) };
      models[key] = cleanSamples([...(models[key] || []), sample], now());
      save();
      return sample;
    },
    /** Speed (token/s) and sample count for this model; when no samples exist, tps is default and samples is 0 */
    speedOf(model) {
      const list = cleanSamples(models[speedKey(model)], now());
      const tps = conservativeSpeed(list);
      return tps ? { tps, samples: list.length } : { tps: DEFAULT_TOKENS_PER_SECOND, samples: 0 };
    },
    /**
     * Speed-based single limit (further capped by min with model limit and config limit; see
     * resolveMaxOutput in model-limits.mjs)
     */
    capFor(model) {
      return Math.max(MIN_SPEED_CAP, Math.floor(this.speedOf(model).tps * OUTPUT_TIME_BUDGET_S));
    },
  };
}

/**
 * Shared per file within the same process; creates a new instance each time if no file is provided
 * (in-memory only)
 */
export function outputSpeedBookFor(file, opts = {}) {
  if (!file) return createOutputSpeedBook(opts);
  const abs = path.resolve(file);
  let book = books.get(abs);
  if (!book) { book = createOutputSpeedBook({ ...opts, file: abs }); books.set(abs, book); }
  return book;
}

/** For testing: clear in-process shared instances */
export function _resetOutputSpeedBooks() { books.clear(); }

/**
 * Wraps a provider: reports a notice before this stream if the limit changes (which speed, what
 * limit), and records a sample based on usage upon completion.
 * Duration is measured from `response_open.sentAt` reported by the provider (the moment the request
 * was actually sent for the last time, after retries and 400 resends); if not reported, measured
 * from when stream was invoked.
 */
export function withOutputSpeed(provider, book, model) {
  /**
   * Last reported limit: do not report again if unchanged (in account mode, every event must be
   * written to document service, avoiding an extra entry on every request)
   */
  let lastCap = null;
  return {
    ...provider,
    async *stream(...args) {
      let startedAt = Date.now();
      const sp = book.speedOf(model);
      const cap = book.capFor(model);
      if (cap !== lastCap) {
        lastCap = cap;
        yield { type: 'notice', stage: 'output-speed', data: { model, tps: sp.tps, samples: sp.samples, cap, budgetSeconds: OUTPUT_TIME_BUDGET_S } };
      }
      let output = 0, chars = 0, stop = null;
      for await (const ev of provider.stream(...args)) {
        if (ev?.type === 'response_open') { if (Number.isFinite(ev.sentAt)) startedAt = ev.sentAt; continue; }
        if (ev?.type === 'usage') output += (Number(ev.output) || 0) + (Number(ev.thoughts) || 0);
        else if (ev?.type === 'text_delta' || ev?.type === 'thinking_delta') chars += String(ev.text || '').length;
        else if (ev?.type === 'tool_use') { try { chars += JSON.stringify(ev.input ?? {}).length; } catch { /* Discard if unmeasurable */ } }
        else if (ev?.type === 'tool_use_partial') chars += String(ev.args || '').length;
        else if (ev?.type === 'stop') stop = ev.reason;
        yield ev;
      }
      const ms = Date.now() - startedAt;
      // Cut off by gateway and usage was not returned: estimate from character count
      if (!output && stop === 'stream_cut') book.record(model, { output: Math.floor(chars / CHARS_PER_TOKEN_ESTIMATE), ms, estimated: true });
      else if (stop) book.record(model, { output, ms });
    },
  };
}
