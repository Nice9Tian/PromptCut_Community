import { MessageHistory } from './history.mjs';
import { modelToolName } from '../tools/ui-names.mjs';
import { resolveCodeCacheRefs, CODE_CACHE_REF } from '../tools/code-cache.mjs';
import { salvageTruncation } from './truncation.mjs';

const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
/** 各家「写到单次输出上限被截断」的停止原因：OpenAI 兼容口 `length`、Anthropic `max_tokens`、Gemini `MAX_TOKENS` */
const LENGTH_STOPS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);
/**
 * 按截断处理的停止原因：写到上限，加上流在正常收尾之前被断（`stream_cut`，provider 判，见 providers/base.mjs）。
 * 2026-10-22 用户定：「中途被网关掐断按截断处理（保住半截参数、走代码块续写）」。
 */
const TRUNCATED = new Set([...LENGTH_STOPS, 'stream_cut']);
/** 连续几次截断都没留下能接着写的内容，就不再让它接着写，明说没做成 */
const MAX_TRUNCATIONS = 2;
/**
 * 一轮里最多接着写几次（每次截断都把写了一半的内容存进了代码块、有进展的那种）。〔裁：output-cache 2026-10-22〕
 * 有进展就让它接着写，但不能无限重试烧额度（2026-10-22 用户定的方向）：6 次单次输出上限（Gemini 65536、Claude 128K）
 * 足够写完任何一张卡的源码；再多多半是模型每次都写得太长、自己在追着截断跑。
 */
const MAX_SALVAGED_TRUNCATIONS = 6;
const checkAbort = signal => { if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' }); };
/** 交给用户看的进度汇报工具（各家前缀不同，只认以它结尾的名字，规则同 src/ai/progressReport.ts 的 isReportTool） */
const isReportTool = name => typeof name === 'string' && (name === 'report_progress' || /(?:__|[.:/])report_progress$/.test(name));
/**
 * 对用户说话的那种 send_message(`to: "user"`,2026-10-20 用户定:「气泡里面只展示在做什么」,
 * 「加入send_message(user,xxx)的用法」)。名字各家前缀不同,只认以 send_message 结尾的;收件人只认 user。
 * 这一种不经多 Agent 公告板,由 harness/tools/index.mjs 就地答;界面按 tool_call 事件里的 text 画进气泡(src/ai/userMessages.ts)。
 */
export const isUserMessageCall = (name, input) => typeof name === 'string' && (name === 'send_message' || /(?:__|[.:/])send_message$/.test(name)) &&
  !!input && typeof input === 'object' && typeof input.to === 'string' && input.to.trim().toLowerCase() === 'user';

/** 调试信息交给模型的上限(字符);整份截到这么长 */
export const TOOL_DEBUG_CHARS = 2000;
/** 键名像密钥、令牌、票据的,值一律换成 [已隐去] */
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|ticket|credential|signature|api[-_]?key|private[-_]?key|^key$|bearer/i;
/** 值本身像凭证的:Bearer 头、sk- 形状的 Key、票据(v1.xxx.yyy)、JWT */
const SECRET_VALUE = /Bearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{12,}|\bv1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_.-]+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;
function redact(value, depth = 0) {
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[已隐去]');
  if (!value || typeof value !== 'object') return value;
  if (depth > 6) return '[层数太深,省略]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[已隐去]' : redact(v, depth + 1)]));
}
/**
 * 工具抛错时交给模型的结果:原因(message)之外,工具附带的错误码(code)与调试信息(debug)一并给。
 * product/agent.md「看画面渲染超时就停」要求 Agent 拿得到调试信息(卡在哪张卡哪一行、页面报的错……);
 * 原先只给 message,debug 被丢掉了(2026-10-20 主会话查到)。debug 去掉像凭证的键和值,整份截到 TOOL_DEBUG_CHARS 字。
 */
export function toolErrorResult(err) {
  const result = { error: err?.message || String(err) };
  if (err && typeof err === 'object') {
    if (typeof err.code === 'string' && err.code) result.code = err.code;
    if (err.debug !== undefined && err.debug !== null) {
      let text;
      try { text = typeof err.debug === 'string' ? redact(err.debug) : JSON.stringify(redact(err.debug)); } catch { text = String(err.debug); }
      if (typeof text === 'string' && text) result.debug = text.length > TOOL_DEBUG_CHARS ? `${text.slice(0, TOOL_DEBUG_CHARS)}……(调试信息较长,已截断)` : text;
    }
  }
  return result;
}

/**
 * 一次失败的「身份」：同一个工具、同一个毛病算同一个。连着来几次就该换路子,不该再试。
 *
 * 优先用 `code`(工具自己给的代号,最稳);没有代号就拿报错文字的前 60 字当代号 ——
 * 同一个毛病的文字通常一模一样,而带了具体参数的报错(「缺少必填参数 x」)本来就该算不同的毛病。
 */
export function failureKey(name, result) {
  const of = (v) => `${name}\u0000${v}`;
  if (typeof result === 'string') return of(result.slice(0, 60));
  if (!result || typeof result !== 'object') return of('unknown');
  if (typeof result.code === 'string' && result.code) return of(result.code);
  if (typeof result.error === 'string' && result.error) return of(result.error.slice(0, 60));
  return of('unknown');
}

export class Agent {
  /**
   * maxIterations 允许是 Infinity(深度自主 + 自主轮次填 0)。这时循环没有终点,
   * 停下来只靠三样:用户点停止(signal)、模型自己不再调工具、重复操作检测。
   *
   * deepAuto 为真时**不给模型任何关于轮次的话**:到顶收尾那条消息里不写轮数,
   * 免得模型看见「第几轮 / 上限多少」就开始替自己算预算、提前草草收工。
   *
   * maxInputTokens:单次请求的输入 token 预算。给了就按每轮 API 报回的真实 token 数截断
   * (见 history.fitTokens),不给就还是老的按字符数截。
   */
  constructor({ provider, system, tools, maxIterations = 24, deepAuto = false, maxInputTokens = 0, onEvent, signal, history, onModelCall = null, codeCache = null }) {
    Object.assign(this, { provider, system, tools, maxIterations, deepAuto, maxInputTokens, signal });
    /*
     * 代码块空间（server/tools/code-cache.mjs，A07 2026-10-22）：给了就①工具参数里整个写成 `@code_cache:名字` 的字符串在调用前换成内容；
     * ②回复被截断时把没写完的工具参数存进代码块，让模型接着写。不给时与原来相同。
     */
    this.codeCache = codeCache;
    /*
     * 有没有「对用户说话」的工具(send_message 的 to: "user")。有的话执行规则里让模型用它说明在做什么;
     * 2026-10-19 起的「没交收尾汇报就按文字回复代交一份」已撤掉(2026-10-20):用户定了气泡里显示 Agent 说的话,
     * 模型只回了文字、没调 send_message 时,界面把那段文字当一条「在做什么」画进气泡,不再另代交一份汇报,免得同一段话在气泡和汇报里各出现一次。
     */
    this.canSpeak = (tools || []).some(t => t?.name === 'send_message' || /(?:__|[.:/])send_message$/.test(t?.name ?? ''));
    /*
     * 每次向模型发请求的前后各调一次(可选;云端 Agent 的额度检查与用量记录接在这里,契约 cloud-agent-contract.md 第 6.2 节):
     *   onModelCall('before', { round })  —— 抛错就不发这次请求,整轮以这个错结束;
     *   onModelCall('after', { round, ok, ms, input, output, cacheRead })  —— 这一次请求的用量;它抛的错不影响这一轮。
     * 不给时与原来逐行为相同。
     */
    this.onModelCall = typeof onModelCall === 'function' ? onModelCall : null;
    this.onEvent = onEvent || (() => {});
    this.history = history || new MessageHistory({ onEvent: this.onEvent });
  }

  async run(userText) {
    // 末尾已经是 user 消息时要并进去,不能新起一条 —— 理由见 history.appendUserText
    this.history.appendUserText(userText);
    const usage = { input: 0, output: 0, cacheRead: 0 };
    const recent = [];
    let completed = 0, failed = 0, outcome = 'completed', lastText = '', lastRound = 0;
    const started = Date.now();
    const progress = (round, phase, text) => this.onEvent({ type: 'progress', round, maxRounds: this.maxIterations, phase, completed, failed, elapsedMs: Date.now() - started, text });
    const speak = this.canSpeak
      ? '每组操作前调用 send_message（to 填 "user"）用一两句话告诉用户接下来要做什么，做完一组再用它说一句做好了什么；它和这一组的工具调用放在同一次回复里，不要单独占一轮；收尾仍调 final 为 true 的 report_progress'
      : '每组操作前用一句简短的话说明将做什么';
    const cacheRule = this.codeCache
      ? `单次回复有输出上限：要写很长的源码或文本（几百行以上）时，先分几次写进代码块（code_cache_write 写开头、code_cache_append 接着写），最后在工具参数里整个写成 "${CODE_CACHE_REF}名字" 交给工具；回复被截断时按系统消息的提示接着写。`
      : '';
    const system = this.system + `\n\n执行规则：${speak}；需要做多件事时，在同一次回复里一次返回多个工具调用，它们会在同一轮内依次执行。依赖上一步返回值的操作留到下一轮。后台作业由工具自动等待，请勿反复启动或紧密轮询。遇到重复错误应改变方法或说明阻碍；某个能力这次拿不到（工具明说用不了、重试没用），而它又是用户这次要求的硬前提时，说明阻碍后停下，不要当它不存在继续做。工具返回成功后核对一次即可，完成后向用户总结结果。${cacheRule}`;
    // truncations：连续几次截断没留下内容；salvaged：这一轮里有几次截断留下了内容；truncTotal：这一轮一共截断几次；cutBlocks：截断时存进的代码块
    // cutCount：truncTotal 里有几次是被网关中途掐断（其余是写到上限），停下时的话按它说
    let summaryReason = '', truncations = 0, salvaged = 0, truncTotal = 0, cutCount = 0;
    const cutBlocks = new Set();
    // 这一轮有没有交过收尾汇报、有没有用 send_message 对用户说过话:说过的话就是给用户的交代,最后一次空回复不算出错
    let reported = false, spoke = false;
    /*
     * 轮次预算提示(2026-10-24 用户定)。
     *
     * 屏幕上的「第 N/M 轮」是不进模型上下文的(见下面 progress 那一行的注释),所以模型
     * 按「时间无限」的方式干活:一次实跑里它把一张大卡的源码打磨了 18 轮,`create_card`
     * 一次没调到就撞了上限,时间轴是空的。过半和只剩四分之一时各提醒一次,让它先把能
     * 交付的最小版本落下去。deepAuto 下一条都不发 —— 那个开关的全部意思就是不跟模型谈轮次。
     */
    const budgetSent = new Set();
    /*
     * 同一个工具带着同一个错误连成串:第 2 次给一条硬提示,第 3 次直接停。
     *
     * 现有的重复操作检测(下面 `repeats >= 3`)按**整轮**指纹算,一轮里只要还有别的调用、
     * 指纹就不同,拦不住「同一个能力反复要」。那次实跑里 see_frames 连着两轮拿同一个错误码,
     * 两道闸都没响,模型就蒙着眼睛做下去了。
     */
    const failStreak = new Map();

    // The budget counts model/tool round trips, not individual calls.
    for (let round = 1; round <= this.maxIterations + 1; round++) {
      checkAbort(this.signal);
      lastRound = round;
      const summarizing = !!summaryReason;
      // 上一轮刚放完 tool_result(那是一条 user),这里直接 append 就又是两条连着的 user
      if (summarizing) this.history.appendUserText(`执行已暂停：${summaryReason}。不要再调用工具，只用中文说明已完成的部分、未完成的部分、阻碍和下一步。不得把未完成任务说成成功。`);
      // 进度这一行只给屏幕看,不进模型上下文。不限轮次时不写分母,省得出现「第 3/Infinity 轮」
      const roundText = Number.isFinite(this.maxIterations) ? `第 ${round}/${this.maxIterations} 轮` : `第 ${round} 轮`;
      progress(round, summarizing ? 'summarizing' : 'requesting', summarizing ? '正在整理执行结果和未完成事项…' : `${roundText}：正在等待模型响应…`);
      this.onEvent({ type: 'diagnostic', stage: 'request', data: { round, summaryOnly: summarizing, messages: this.history.get().length, tools: summarizing ? 0 : this.tools.length } });
      const content = [], calls = [], partials = [];
      let text = '', current = '', lastInput = 0, stopReason = null;
      const flush = () => { if (current) { content.push({ type: 'text', text: current }); current = ''; } };
      if (this.onModelCall) {
        await this.onModelCall('before', { round });
        checkAbort(this.signal);
      }
      const callStarted = Date.now();
      const callUsage = { input: 0, output: 0, cacheRead: 0 };
      let callOk = false;
      const heartbeat = setInterval(() => progress(round, summarizing ? 'summarizing' : 'requesting', `仍在等待模型响应，已用时 ${Math.floor((Date.now() - started) / 1000)} 秒；可以随时停止。`), 10000);
      try {
        for await (const ev of this.provider.stream(this.history.get(), summarizing ? [] : this.tools, system, this.signal)) {
          checkAbort(this.signal);
          if (ev.type === 'text_delta') {
            current += ev.text; text += ev.text;
            this.onEvent({ type: 'text', delta: ev.text });
          } else if (ev.type === 'thinking_delta') {
            // 只往界面转发,不并进 assistant 正文——思考不该混进回复,也不回灌给模型
            this.onEvent({ type: 'thinking', delta: ev.text, round });
          } else if (ev.type === 'tool_use') {
            if (summarizing) continue; // Never execute tools once the safety stop fired.
            flush();
            /*
             * 工具名为空或带非法字符:历史里换成一个合法的占位名。
             *
             * 实跑见过模型发出 name 为空串的调用。原样写进历史,下一次请求 Gemini(走 OpenAI 兼容口)
             * 就整个 400「Request contains an invalid argument」—— 这个会话从此每一轮都 400。
             * 占位名照样配一条 is_error 的 tool_result(下面「未知工具」那一支),模型看得到自己调错了。
             */
            const validName = typeof ev.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(ev.name);
            const call = { ...ev, name: validName ? ev.name : 'invalid_tool_name', id: ev.id || `round-${round}-call-${calls.length + 1}` };
            if (!validName) call.inputError = `工具名 ${JSON.stringify(ev.name ?? '')} 不合法(为空或带非法字符),这次调用没有执行。请用工具清单里的名字重新调用。`;
            if (calls.some(c => c.id === call.id)) throw new Error('API 返回了重复的工具调用 ID，已停止以免重复执行。');
            calls.push(call);
            content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
          } else if (ev.type === 'tool_use_partial') {
            // 写到输出上限时没写完的工具调用：不进历史、不执行，收尾后存代码块（见下面截断那一支）
            if (!summarizing) partials.push(ev);
          } else if (ev.type === 'notice') {
            // provider 的提示（输出上限 400 降档、换字段）：进运行日志与诊断
            this.onEvent({ type: 'diagnostic', stage: ev.stage || 'provider', data: { round, ...(ev.data || {}) } });
          } else if (ev.type === 'stop') {
            stopReason = ev.reason;
            this.onEvent({ type: 'diagnostic', stage: 'response', data: { round, stopReason: ev.reason, toolCalls: calls.length } });
          } else if (ev.type === 'usage') {
            usage.input += Number(ev.input) || 0; usage.output += Number(ev.output) || 0;
            usage.cacheRead += Number(ev.cacheRead) || 0;
            lastInput = Number(ev.input) || 0;
            callUsage.input += Number(ev.input) || 0; callUsage.output += Number(ev.output) || 0;
            callUsage.cacheRead += Number(ev.cacheRead) || 0;
          }
        }
        callOk = true;
      } catch (err) {
        if (!summarizing || this.signal?.aborted) throw err;
        this.onEvent({ type: 'status', text: `结果摘要请求失败：${err.message}` });
      } finally {
        clearInterval(heartbeat);
        if (this.onModelCall) {
          try { await this.onModelCall('after', { round, ok: callOk, ms: Date.now() - callStarted, ...callUsage }); } catch { /* 记账失败不影响这一轮 */ }
        }
      }
      flush();
      lastText = text;
      if (summarizing) {
        const note = `\n\n本次执行已暂停：${summaryReason}。已成功执行 ${completed} 次操作，失败 ${failed} 次。已完成的修改会保留；可以补充要求后继续，或复制本次对话进行排查。`;
        this.onEvent({ type: 'text', delta: note });
        /*
         * 收尾这句要**并进当轮那条 assistant**,不能另起一条。
         *
         * 上面本来就要 append 一条 assistant(模型的汇总文字),这里再 append 一条
         * 就是两条连着的 assistant —— 和 appendUserText 治的是同一个病的另一半。
         * 这个形状会被 saveHistory 原样写进 harness-sessions 里那个文件,而后续
         * 没有任何一步会把它合并回去:**这个会话从此每次都 400,而且不自愈**,
         * 用户根本不知道有这么个文件可以删。
         */
        content.push({ type: 'text', text: note });
        if (content.length) this.history.append({ role: 'assistant', content });
        lastText += note;
        break;
      }
      if (content.length) this.history.append({ role: 'assistant', content });
      /** 截断时要跟在这一轮工具结果后面告诉模型的话（有写完的工具调用、又有没写完的那种） */
      let truncationNote = '';
      if (TRUNCATED.has(stopReason) && (partials.length || !calls.length)) {
        /*
         * 回复写到单次输出上限被截断：不能当成「说完了」收工（2026-10-17 实跑：模型把 4096 个 token 全花在打草稿和写一个
         * 巨大的工具参数上，没写完的工具调用整个丢掉，这一轮就以 0 次操作「完成」了，用户什么也没看到）。
         * A07（2026-10-22 用户定）：没写完的工具调用里已经写出的内容存进代码块，告诉模型存在哪、写到哪了、怎么接着写。
         * 有进展（存下了内容）就让它接着写，一轮最多 MAX_SALVAGED_TRUNCATIONS 次；连续 MAX_TRUNCATIONS 次什么也没留下，
         * 或者到了轮次上限，就明说没做成，结束这一轮。
         */
        truncTotal++;
        const cause = stopReason === 'stream_cut' ? 'cut' : 'length';
        if (cause === 'cut') cutCount++;
        const s = salvageTruncation(partials, this.codeCache, { cause });
        for (const x of s.saved) cutBlocks.add(x.block);
        if (s.progress) { salvaged++; truncations = 0; } else truncations++;
        this.onEvent({ type: 'diagnostic', stage: 'truncated', data: { round, stopReason, cause, partials: partials.map((p) => p.name), saved: s.saved, salvaged, stalled: truncations } });
        if (truncations > MAX_TRUNCATIONS || salvaged > MAX_SALVAGED_TRUNCATIONS || round >= this.maxIterations) {
          const kept = cutBlocks.size ? `已经写出的部分存在代码块 ${[...cutBlocks].join('、')} 里，下一条消息可以让它接着写。` : '';
          const times = truncTotal > 1 ? `模型的回复连续 ${truncTotal} 次` : '模型的回复';
          // 全是被网关掐断的不说「调大单次输出上限」：那不是上限的事，调大只会更容易撞上网关的时长上限
          if (cutCount === truncTotal) throw new Error(`${times}被网关中途掐断（网关对单次请求有时长上限），这一轮没能完成。${kept}可以把要求拆小一点再发。`);
          if (cutCount === 0) throw new Error(`${times}超过单次输出上限被截断，这一轮没能完成。${kept}可以把要求拆小一点再发，或请管理员调大单次输出上限。`);
          throw new Error(`${times}被截断（超过单次输出上限或被网关中途掐断），这一轮没能完成。${kept}可以把要求拆小一点再发。`);
        }
        this.onEvent({ type: 'status', text: s.status });
        if (!calls.length) {
          this.history.appendUserText(s.note);
          continue;
        }
        truncationNote = s.note;
      }
      if (!calls.length) {
        // 已经交过收尾汇报、或用 send_message 对用户说过话,最后这次没说话也算说完了
        if (!text.trim() && !reported && !spoke) throw new Error('API 没有返回文字或工具调用，请检查模型和接口协议设置。');
        break;
      }
      if (!truncationNote) { truncations = 0; truncTotal = 0; cutCount = 0; }
      progress(round, 'executing', `本轮收到 ${calls.length} 个工具调用，正在执行…`);
      const results = [];
      // 工具返回的图片不留在 tool_result 里，改挂到同一条 user 消息的末尾。
      // 原因是可移植性：Anthropic 的 tool_result 装得下图片块，OpenAI 的 role:"tool"
      // 只收字符串，装不了。要让同一套 history 在三家 API 上都成立，图片就只能作为
      // 跟在工具结果后面的普通内容块出现（下面 append 处还有一段说明为什么不另起一条）。
      const images = [];
      // 这一轮失败的「身份」→ 给模型看过的那句话。连成串的判定在循环之后做
      const roundFails = new Map();
      // Preserve declared order for edits: two mutations must not race in the store.
      // Multiple calls still share one model round trip.
      for (const call of calls) {
        checkAbort(this.signal);
        // 会动用户界面的工具改了名(user_interface_ 前缀,2026-10-21):老对话的历史里还是旧名,模型照着调旧名时照常认
        const tool = this.tools.find(t => t.name === call.name) ?? this.tools.find(t => t.name === modelToolName(call.name));
        const begin = Date.now();
        this.onEvent({ type: 'tool_call', callId: call.id, round, name: call.name, input: call.input });
        const toolHeartbeat = setInterval(() => progress(round, 'executing', `正在执行 ${call.name}，已等待 ${Math.floor((Date.now() - begin) / 1000)} 秒…`), 5000);
        let result, ok = true;
        try {
          // 先报参数/名字本身的问题:空工具名换成的占位名一定是「未知工具」,那句话会盖掉真正的原因
          if (call.inputError) throw new Error(call.inputError);
          if (!tool) throw new Error(`未知工具 ${call.name}，请使用已提供的工具名称。`);
          if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) throw new Error('工具参数必须是 JSON 对象。');
          for (const key of tool.inputSchema?.required || []) if (call.input[key] === undefined) throw new Error(`缺少必填参数 ${key}。`);
          // 参数里整个写成 `@code_cache:名字` 的字符串换成代码块的内容再交给工具;历史和事件里留的还是引用,不撑大
          const input = this.codeCache ? resolveCodeCacheRefs(call.input, this.codeCache) : call.input;
          result = await tool.execute(input, { signal: this.signal, callId: call.id, round });
          if (result?.ok === false || result?.isError === true) ok = false;
          checkAbort(this.signal);
        } catch (err) {
          checkAbort(this.signal);
          ok = false; result = toolErrorResult(err);
        } finally { clearInterval(toolHeartbeat); }
        // 图片从工具结果里摘出来。留在 JSON 里的话，base64 会被当成普通文本灌进历史：
        // 模型看不见画面，几十万字符还会立刻把上下文撑爆并触发截断。摘出来还有个好处是
        // 转发给界面的 tool_result 事件也就不带 base64 了，存档不会被撑大。
        if (ok && result && typeof result === 'object' && result.__image?.base64) {
          images.push({ ...result.__image, name: call.name });
          const { __image, ...rest } = result;
          result = { ...rest, image: '画面见本条消息末尾的图片' };
        }
        // see_frames 素材模式(source: "media")一页多张:每张标上镜头序号,模型看图时能和 scenes 对上
        if (ok && result && typeof result === 'object' && Array.isArray(result.__images)) {
          // 每张图带 label(比如 times 多帧的「t=3.2s」)就用它,否则按镜头序号
          for (const im of result.__images) if (im?.base64) images.push({ ...im, name: `${call.name} ${im.label ?? `镜头 ${im.sceneIndex ?? '?'}`}` });
          const { __images, ...rest } = result;
          result = { ...rest, images: `${result.__images.length} 张图见本条消息末尾,按顺序排列` };
        }
        const output = typeof result === 'string' ? result : JSON.stringify(result ?? null);
        ok ? completed++ : failed++;
        if (!ok) roundFails.set(failureKey(call.name, result), { tool: call.name, text: output.slice(0, 200) });
        if (ok && isReportTool(call.name) && call.input?.final === true) reported = true;
        if (ok && isUserMessageCall(call.name, call.input)) spoke = true;
        this.onEvent({ type: 'tool_result', callId: call.id, round, name: call.name, ok, summary: output.slice(0, 1000), output: result, durationMs: Date.now() - begin });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: output, is_error: !ok });
      }
      /*
       * 同一个工具 + 同一个毛病连成串。这一轮没再出现的那些清零 —— 中间成功过一次,
       * 就不算「连着」了。
       */
      for (const key of [...failStreak.keys()]) if (!roundFails.has(key)) failStreak.delete(key);
      const streaked = [];
      for (const [key, info] of roundFails) {
        const n = (failStreak.get(key) ?? 0) + 1;
        failStreak.set(key, n);
        if (n >= 2) streaked.push({ ...info, n });
      }
      const worstStreak = streaked.reduce((max, s) => Math.max(max, s.n), 0);
      // 第 2 次:一句硬提示,点名这个能力这次用不了,并指回提示词里那张决策表。第 3 次在下面直接停
      const streakNote = worstStreak === 2
        ? `${streaked.filter(s => s.n === 2).map(s => s.tool).join('、')} 带着同一个错误连续失败 2 次了：${streaked.find(s => s.n === 2).text}\n`
          + '不要再用同样的参数调第 3 次。这一次拿不到这个能力：要么换一条路并在收尾汇报里写明这一步没做成，'
          + '要么——如果它是用户这次要求的硬前提——现在就调 final 为 true 的 report_progress 把阻碍写进 problems、把用户能做的事写进 todo，然后停下。'
        : '';
      this.onEvent({ type: 'diagnostic', stage: 'fail-streak', data: { round, streaks: streaked.map(s => ({ tool: s.tool, times: s.n })) } });
      /*
       * 轮次预算:过半、只剩四分之一各提醒一次。最后一轮(left 为 0)不提 —— 那一轮本来就要
       * 收尾,下面那条「已达到 N 轮上限」自己会说清为什么停。这一轮已经判了要停也不提。
       */
      let budgetNote = '';
      if (!this.deepAuto && Number.isFinite(this.maxIterations) && worstStreak < 3) {
        const left = this.maxIterations - round;
        const mark = left <= Math.floor(this.maxIterations / 4) ? 'quarter' : left <= Math.floor(this.maxIterations / 2) ? 'half' : null;
        if (mark && left > 0 && !budgetSent.has(mark)) {
          budgetSent.add(mark);
          // 过半那条也补发一次标记,免得一步跨过两道线时收到两条
          if (mark === 'quarter') budgetSent.add('half');
          budgetNote = mark === 'half'
            ? `还剩 ${left} 轮模型往返（一轮 = 你的一次回复，里面调几个工具都算一轮）。`
              + '从现在起先把能交付的最小版本真正落到项目里（建卡 → add_clip 上时间轴 → 看一眼），再回来打磨；'
              + '写在代码块里、还没交给工具的东西不算交付。来不及的写进 report_progress 的 todo。'
            : `只剩 ${left} 轮模型往返了。立刻把手上已经写好的东西提交掉（代码块里的卡片源码 → create_card → add_clip），`
              + '不要再开新的大块工作；提交完调 final 为 true 的 report_progress 收尾，没做完的逐条写进 todo。';
        }
      }
      // 图片跟工具结果放在同一条 user 消息里、排在所有 tool_result 之后。
      // 不另起一条的原因：那会造成两条连着的 user 消息，而三家 API 对连续同角色
      // 消息的容忍度不一样。挂在同一条上是三家都明确支持的形状。
      this.history.append({ role: 'user', content: [
        ...results,
        ...(images.length ? [
          ...images.map(im => ({ type: 'image', mime: im.mime || 'image/png', data: im.base64 })),
          { type: 'text', text: `以上是 ${images.map(i => i.name).join('、')} 截到的画面。照着画面判断，不要凭源码想象效果。` },
        ] : []),
        // 这一次回复里还有没写完的工具调用(截断):怎么接着写的那段话跟在工具结果后面,同一条消息里
        ...(truncationNote ? [{ type: 'text', text: truncationNote }] : []),
        ...(streakNote ? [{ type: 'text', text: streakNote }] : []),
        ...(budgetNote ? [{ type: 'text', text: budgetNote }] : []),
      ] });
      const fingerprint = canonical(calls.map((c, index) => ({ name: c.name, input: c.input, result: results[index].content })));
      recent.push(fingerprint);
      if (recent.length > 6) recent.shift();
      const repeats = recent.filter(f => f === fingerprint).length;
      if (worstStreak >= 3) {
        const worst = streaked.find(s => s.n === worstStreak);
        outcome = 'stalled';
        summaryReason = `${worst.tool} 带着同一个错误连续失败 ${worstStreak} 次，已停止无效重试`;
      } else if (repeats >= 3) {
        outcome = 'stalled'; summaryReason = '连续出现重复操作且结果没有变化，已停止无效循环';
      } else if (round === this.maxIterations) {
        // 深度自主下不报轮数:这句会作为 user 消息进模型上下文(见循环开头的 summarizing 分支)
        outcome = 'round_limit';
        summaryReason = this.deepAuto ? '本次运行已到上限' : `已达到 ${this.maxIterations} 轮模型往返上限`;
      }
      this.history.pruneImages();
      if (this.maxInputTokens > 0 && lastInput > 0) this.history.fitTokens(lastInput, this.maxInputTokens);
      else this.history.truncate();
    }
    progress(lastRound, outcome === 'completed' ? 'completed' : 'paused', outcome === 'completed' ? `本次完成：${completed} 次成功，${failed} 次失败。` : summaryReason);
    return { text: lastText, history: this.history, usage, outcome, completed, failed };
  }
}
