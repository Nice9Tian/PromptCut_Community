/**
 * 把内联在正文里的 `<think>…</think>` 从文本流里拆出来。
 *
 * # 为什么需要
 *
 * 各家「推理内容」的传法不统一。规矩的接口会把它放进单独的字段
 * (`reasoning_content` / `reasoning` / `thinking`),providers/openai.mjs 认这三个。
 * 但不少中转站是**直接内联在 `content` 里**发的:
 *
 *   <think>**Clarifying article link and scope**\n\n</think>\n\n我先确认素材收集环境;…
 *
 * 这种就整段走了 text_delta,被当成正文渲染 —— 用户在聊天气泡里看见一个赤裸的
 * `</think>`,阅读被打断。这个模块把它在**流的层面**分离出来,让它走思考那条通道,
 * 后面的 UI 什么都不用改就能正常显示。
 *
 * # 为什么要做成状态机而不是正则
 *
 * 这是**流式**的:标签会被切在两个 chunk 中间(`<thi` + `nk>`),甚至一个字符一个 chunk。
 * 对着单个 delta 跑正则永远匹配不到那种情况,而把整段攒完再处理就没有流式效果了。
 * 所以这里只在「当前缓冲的尾巴可能是标签的一半」时才扣住那几个字符,其余立刻放行 ——
 * 延迟最多几个字符,肉眼看不出来。
 *
 * # 已知取舍
 *
 * 正文里如果**真的**要出现 `<think>` 这个字面量(比如在讨论标签本身、或者代码块里),
 * 会被误当成标签吃掉。代价是极低频的误伤,换掉的是每一条消息都被污染。
 * 真遇到了再按「代码块内不解析」加一层,不值得现在为它把状态机搞复杂。
 */

/** 认哪些标签对。`<think>` 最常见,`<thinking>` 也有中转站在用 */
const TAG_PAIRS = [
  { open: '<think>', close: '</think>' },
  { open: '<thinking>', close: '</thinking>' },
];

/** s 的后缀里,最长的那个「是 tag 的真前缀」的长度。用来决定扣住几个字符 */
function partialTailLength(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/**
 * 建一个拆分器。
 *
 * `push(chunk)` 和 `flush()` 都返回事件数组:`{ kind: 'text' | 'think', text }`,
 * 空片段不会产出。调用方照着把 text 发成 text_delta、think 发成 thinking_delta 即可。
 */
export function createThinkSplitter() {
  let buf = '';
  /** null = 在正文里;否则是当前正在找的那个闭合标签对 */
  let openPair = null;

  function drain(out) {
    for (;;) {
      if (openPair) {
        const i = buf.indexOf(openPair.close);
        if (i >= 0) {
          if (i > 0) out.push({ kind: 'think', text: buf.slice(0, i) });
          buf = buf.slice(i + openPair.close.length);
          openPair = null;
          continue;
        }
        // 没等到闭合:把「肯定不是标签开头」的部分先放出去,尾巴留着等下一块
        const keep = partialTailLength(buf, openPair.close);
        if (buf.length > keep) {
          out.push({ kind: 'think', text: buf.slice(0, buf.length - keep) });
          buf = buf.slice(buf.length - keep);
        }
        return;
      }

      // 在正文里:找最靠前的那个开标签
      let best = -1;
      let bestPair = null;
      for (const pair of TAG_PAIRS) {
        const i = buf.indexOf(pair.open);
        if (i >= 0 && (best < 0 || i < best)) { best = i; bestPair = pair; }
      }
      if (best >= 0) {
        if (best > 0) out.push({ kind: 'text', text: buf.slice(0, best) });
        buf = buf.slice(best + bestPair.open.length);
        openPair = bestPair;
        continue;
      }

      // 没有开标签:尾巴可能是某个开标签的一半,扣住最长的那个
      let keep = 0;
      for (const pair of TAG_PAIRS) keep = Math.max(keep, partialTailLength(buf, pair.open));
      if (buf.length > keep) {
        out.push({ kind: 'text', text: buf.slice(0, buf.length - keep) });
        buf = buf.slice(buf.length - keep);
      }
      return;
    }
  }

  return {
    push(chunk) {
      if (!chunk) return [];
      buf += chunk;
      const out = [];
      drain(out);
      return out;
    },
    /**
     * 流结束。扣住的尾巴要吐出来 —— 它可能是半个标签,也可能就是正常正文
     * (比如回复正好以 `<` 结尾)。没等到闭合标签的思考内容也一并交出去,
     * 宁可多显示一段思考,也不能把用户的正文吞掉。
     */
    flush() {
      const out = [];
      if (buf) out.push({ kind: openPair ? 'think' : 'text', text: buf });
      buf = '';
      openPair = null;
      return out;
    },
    /** 现在是不是在 think 里面(给调用方判断状态用) */
    get inThink() { return openPair !== null; },
  };
}

/**
 * 一次性拆完整段文本(非流式的地方用,比如把历史里已经存下来的文本洗一遍)。
 * 返回 `{ text, think }` 两段拼好的字符串。
 */
export function splitThinkTags(s) {
  const sp = createThinkSplitter();
  const events = [...sp.push(String(s ?? '')), ...sp.flush()];
  let text = '';
  let think = '';
  for (const e of events) {
    if (e.kind === 'text') text += e.text;
    else think += e.text;
  }
  return { text, think };
}
