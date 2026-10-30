// 对应 claude-quickstarts/agents/utils/history.py

/**
 * 衡量历史有多长。
 *
 * 图片的 base64 不算进去：一张 768px 的截图就是几十万字符，按字面长度算的话，
 * 只要看过一次画面就必然超过 maxChars，截断会把整段对话削光。而模型那边图片是
 * 按尺寸计费的，字节数根本不是它的成本。所以这里只用一个和它 token 量级相当的
 * 常数占位（约 1200 token × 3 字符）。
 */
function sizeOf(messages) {
  return JSON.stringify(messages, (key, v) => (key === 'data' && typeof v === 'string' && v.length > 4096 ? 'x'.repeat(3600) : v)).length;
}

export class MessageHistory {
  constructor({ maxChars = 120000, onEvent } = {}) {
    this.maxChars = maxChars;
    this.onEvent = onEvent || (() => {});
    this.messages = [];
  }

  append(msg) {
    this.messages.push(msg);
  }

  appendAll(msgs) {
    this.messages.push(...msgs);
  }

  /**
   * 加一句用户的话,末尾已经是 user 消息时**并进那一条**。
   *
   * 历史里出现两条连着的 user 是个真实形状,不是理论问题:接着上一段往下说时,
   * 末尾可能是中断落盘补的那条(装 tool_result 的 user),也可能是上一轮撞到
   * 轮次上限时收尾用的那条。Anthropic 不收连续同角色,而三家 provider 的转换
   * 里都没有合并逻辑 —— 所以在这里挡住,而不是指望每个调用方自己记得。
   *
   * 放在 MessageHistory 上是因为这是**历史自己的不变量**:让调用方拿 get() 的
   * 返回值去改末尾那条,靠的是「get 返回的是浅拷贝、里面的对象还是同一批」这个
   * 巧合,哪天 get 改成深拷贝就无声失效了。
   */
  appendUserText(text) {
    const last = this.messages[this.messages.length - 1];
    if (last?.role !== 'user') { this.messages.push({ role: 'user', content: [{ type: 'text', text }] }); return; }
    /*
     * 末尾是 user,但 content 是一个字符串(老格式,或盘上那个文件被外部改过 ——
     * api.mjs 读回来时只 JSON.parse,不校验形状)。原来这里退回「新起一条」,
     * 可末尾本来就是 user,新起一条正好拼出这个方法要消灭的形状。
     * 就地规范成块数组再并进去。
     */
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
    if (Array.isArray(last.content)) last.content.push({ type: 'text', text });
    else this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
  }

  get() {
    return [...this.messages];
  }

  clear() {
    this.messages = [];
  }

  estimateTokens() {
    return Math.ceil(sizeOf(this.messages) / 3);
  }

  /**
   * 只保留最近 keep 张截图，更早的换成一句说明。
   *
   * 图片按尺寸计费，不按字节，但每张仍是几百个 token，而且 base64 本身要走一遍
   * 网络。一次任务里可能看十几次画面，全留着既贵又没用——模型要判断的是「刚改完
   * 现在长什么样」，三轮前的旧样子留在上下文里反而会让它把旧画面当成现状。
   */
  pruneImages(keep = 10) {
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (!Array.isArray(msg.content)) continue;
      for (let j = msg.content.length - 1; j >= 0; j--) {
        if (msg.content[j].type !== 'image') continue;
        if (++seen > keep) msg.content[j] = { type: 'text', text: '(更早的一张截图已从上下文移除；需要重看请再截一次)' };
      }
    }
  }

  size() {
    return sizeOf(this.messages);
  }

  /**
   * 按 API 报回来的真实 token 数截断。
   *
   * 字符数除以 3 估 token 对英文和 JSON 大致准,中文差不多一字一 token,会被低估到三分之一。
   * 所以不再猜换算比:拿这一轮实际的 input token 数和当前历史的字符数算出比例,
   * 把 maxChars 定到「预算对应的字符数」再截。0.9 是给下一轮新增内容留的余量。
   * reported 里还含着系统提示和工具说明(不在 history 里),按比例算会截得略多一点,偏安全。
   */
  fitTokens(reported, budget) {
    if (!(reported > budget) || !(budget > 0)) return;
    this.maxChars = Math.floor(this.size() * (budget / reported) * 0.9);
    this.truncate();
  }

  truncate() {
    let currentChars = sizeOf(this.messages);
    if (currentChars <= this.maxChars) return;
    let truncated = false;

    while (this.messages.length > 2 && sizeOf(this.messages) > this.maxChars) {
      // 检查如果要删除第一条及关联的记录后，是否至少还剩 2 条消息
      let nextMessages = JSON.parse(JSON.stringify(this.messages));
      // Keep the latest actual user request while removing complete old tool pairs.
      const pinned = this.messages.findLastIndex(m => m.role === 'user' && m.content?.some(b => b.type === 'text') && !m.content?.some(b => b.type === 'tool_result'));
      const removeIndex = pinned === 0 ? 1 : 0;
      const [msg] = nextMessages.splice(removeIndex, 1);
      
      if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
        const toolUseIds = new Set();
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id) {
            toolUseIds.add(block.id);
          }
        }
        
        if (toolUseIds.size > 0 && nextMessages.length > 0) {
           for (let i = 0; i < nextMessages.length; i++) {
             const m = nextMessages[i];
             if (m.role === 'user' && Array.isArray(m.content)) {
                m.content = m.content.filter(block => 
                  !(block.type === 'tool_result' && toolUseIds.has(block.tool_use_id))
                );
             }
           }
           nextMessages = nextMessages.filter(m => m.content && m.content.length > 0);
        }
      }
      
      if (nextMessages.length < 2) {
         break;
      }
      
      this.messages = nextMessages;
      truncated = true;
    }
    
    if (truncated) {
      this.onEvent({ type: 'status', text: '对话历史过长,已截断早期消息' });
    }
  }

  toJSON() {
    return this.messages;
  }

  static fromJSON(arr, opts) {
    const history = new MessageHistory(opts);
    if (Array.isArray(arr)) {
      history.messages = [...arr];
    }
    return history;
  }
}
