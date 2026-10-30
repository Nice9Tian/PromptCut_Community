/**
 * 按实测输出速度给单次输出设上限,让一次请求在网关掐断之前写完(2026-10-22 用户定:
 * 「现在修:中途被网关掐断按截断处理(保住半截参数、走代码块续写),按实测速度给单次输出设上限」)。
 *
 * # 起因
 *
 * 2026-10-22 实测 openlux 网关 + gemini-3.8-flash:网关对单次请求大约 300 秒就掐断,流式也一样 ——
 * 一次流式请求在 300.7 秒收到 SSE 里的 error 事件(HTTP 仍是 200,原文
 * 「The upstream stream ended before the response was complete.」),当时流还在正常出数据(1001 块、4 万字)。
 * 同一天实测 Gemini 的输出速度是 50～190 token/s,波动约 3 倍;Claude 没测。
 * 单次输出上限按模型取到 65536 / 128000 之后(A07),一次写满要 6～40 分钟,远超 300 秒。
 *
 * # 做法〔裁:stream-cut 2026-10-22〕
 *
 * - 每次请求结束记一个样本:这次的输出 token 数 ÷ 这次请求从发出到结束的用时(用量里报的数;思考 token 也算进输出)。
 *   用「从发出到结束」而不是「从第一个字到结束」:网关的钟从请求发出就开始走,首字前的等待也算在 300 秒里;
 *   而且有的上游不把思考流出来,只从第一个字算会把速度算高。这样算出的速度偏低,就是偏保守。
 * - 输出不到 MIN_SAMPLE_OUTPUT_TOKENS 的不记:短回复的用时几乎全是首字前的等待,说明不了写长东西有多快。
 * - 被网关中途掐断的那次(用量通常没回来)按收到的字数 ÷ 4 估 token 数记一个样本;中文一个字常常就是一个 token,
 *   按 4 字一个算只会把速度估低,还是偏保守。
 * - 每个模型留最近 KEEP_SAMPLES 个样本、不超过 SAMPLE_MAX_AGE_MS;取「从慢到快排、四分之一处」那个(不到 5 个取最慢的)。
 * - 单次上限 = min(模型上限, 配置上限, 速度 × OUTPUT_TIME_BUDGET_S),速度那一项不低于 MIN_SPEED_CAP。
 * - 还没有样本时按 DEFAULT_TOKENS_PER_SECOND 算。
 *
 * # 存在哪〔裁〕
 *
 * 一个 JSON 文件(宿主给路径,`runners/api.mjs` 的 `outputSpeedFile`):
 * - 本机:`ai.json` 同目录的 `output-speed.json`(和审查环路的教训放在一起,不进系统临时目录,那里会被清);
 * - 云端账号模式:共用数据目录 `usage/model-speed.json` —— 任务进程每轮新开一代,进程内存留不住;
 *   `usage/` 本来就是任务进程写、主服务读的目录(`usage.mjs`),各代任务进程都写得进去;
 * - 云端旧托管档:`<数据目录>/usage/model-speed.json`。
 * 同一进程里按文件路径共用一份内存(读不到、写不进文件时也照常工作,只是下一代进程拿不到)。
 * 几个进程同时写不加锁,后写的为准,最多丢一两个样本。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 网关对单次请求的时长上限(秒):2026-10-22 实测 openlux,流式请求在 300.7 秒被掐断 */
export const GATEWAY_REQUEST_LIMIT_S = 300;
/**
 * 一次请求打算在多少秒内写完(秒)。比网关上限留 50 秒:速度波动约 3 倍(实测 50～190 token/s),
 * 取的又是偏慢的那个样本,再留一段给首字前的等待和网络。
 */
export const OUTPUT_TIME_BUDGET_S = 250;
/**
 * 没有样本时的速度(token/s)。实测 Gemini 最慢 50,往下再留两成;Claude 没测,
 * 大模型(Opus 一类)常见每秒几十个 token,40 不至于高估。× 250 秒 = 10000 token,够写一张中等的卡。
 */
export const DEFAULT_TOKENS_PER_SECOND = 40;
/** 输出少于这么多 token 的请求不记样本(首字前的等待占了大头,算出的速度没有参考价值) */
export const MIN_SAMPLE_OUTPUT_TOKENS = 2000;
/** 每个模型留几个样本 */
export const KEEP_SAMPLES = 10;
/** 样本最多留多久(毫秒):网关和上游会变,太旧的不算 */
export const SAMPLE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
/** 按速度算出的上限不低于这么多 token(太小了连一个普通工具调用都装不下) */
export const MIN_SPEED_CAP = 4096;
/** 被掐断、用量没回来时,按几个字一个 token 估(估少不估多) */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

const books = new Map();

/** 记样本用的键:模型名(小写、去掉首尾空白)。同一个模型走不同网关的速度差别这次不分〔裁〕 */
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

/** 从样本里取偏保守的速度:从慢到快排、四分之一处;不到 5 个取最慢 */
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
  // 先读文件:任务进程每轮新开一代,之前各代记下的都在文件里
  for (const [k, list] of Object.entries(readFileSafe(file))) models[k] = cleanSamples(list, now());

  const save = () => {
    if (!file) return;
    try {
      // 读一次再合并:别的进程这期间可能也记了
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
    } catch (e) { log(`[harness.output-speed] 速度记录没写成: ${e?.message || e}`); }
  };

  return {
    file,
    /**
     * 记一次请求。output 是输出 token 数(含思考),ms 是从发出到结束的用时;estimated 表示 token 数是按字数估的。
     * 不够长的不记。回记下的样本(没记回 null)。
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
    /** 这个模型的速度(token/s)与样本数;没有样本时 tps 是缺省值、samples 为 0 */
    speedOf(model) {
      const list = cleanSamples(models[speedKey(model)], now());
      const tps = conservativeSpeed(list);
      return tps ? { tps, samples: list.length } : { tps: DEFAULT_TOKENS_PER_SECOND, samples: 0 };
    },
    /** 按速度算的单次上限(还要和模型上限、配置上限取小,见 model-limits.mjs 的 resolveMaxOutput) */
    capFor(model) {
      return Math.max(MIN_SPEED_CAP, Math.floor(this.speedOf(model).tps * OUTPUT_TIME_BUDGET_S));
    },
  };
}

/** 同一进程里按文件共用一份;没给文件就每次新建(只在内存里) */
export function outputSpeedBookFor(file, opts = {}) {
  if (!file) return createOutputSpeedBook(opts);
  const abs = path.resolve(file);
  let book = books.get(abs);
  if (!book) { book = createOutputSpeedBook({ ...opts, file: abs }); books.set(abs, book); }
  return book;
}

/** 测试用:清掉进程内共用的那几份 */
export function _resetOutputSpeedBooks() { books.clear(); }

/**
 * 包一层 provider:上限变了就在这次 stream 前报一条 notice(按什么速度、上限多少),结束后按用量记样本。
 * 用时从 provider 报的 `response_open.sentAt`(最后一次真正发出请求的时刻,重试与 400 重发之后)算起;没报就从开始调 stream 算。
 */
export function withOutputSpeed(provider, book, model) {
  /** 上次报过的上限:没变就不再报(账号模式下每条事件都要写进文档服务,别每次请求都多一条) */
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
        else if (ev?.type === 'tool_use') { try { chars += JSON.stringify(ev.input ?? {}).length; } catch { /* 量不出就不算 */ } }
        else if (ev?.type === 'tool_use_partial') chars += String(ev.args || '').length;
        else if (ev?.type === 'stop') stop = ev.reason;
        yield ev;
      }
      const ms = Date.now() - startedAt;
      // 被网关掐断、用量没回来:按字数估
      if (!output && stop === 'stream_cut') book.record(model, { output: Math.floor(chars / CHARS_PER_TOKEN_ESTIMATE), ms, estimated: true });
      else if (stop) book.record(model, { output, ms });
    },
  };
}
