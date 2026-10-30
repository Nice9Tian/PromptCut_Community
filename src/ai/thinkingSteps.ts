/**
 * 把一段「思考」文本切成**步骤标题**。
 *
 * # 为什么
 *
 * 有些模型经中转站发回来的 `<think>` 里装的不是思维链,而是一句话的步骤名:
 *
 *   **Clarifying article link and scope**
 *   **Requesting missing webpage link**
 *   **Planning non-destructive timeline design**
 *
 * 短、加粗、动词开头 —— 这是进度条上的字,不是给人读的推理。把整段原样铺在气泡里
 * 会把正文顶开;而藏进「显示思考」开关里又等于什么都没有,用户看不见它在干什么。
 * 所以抽成一行行的步骤,交给界面做成走马灯式的进度显示。
 *
 * # 规则
 *
 * 有 `**加粗**` 就按加粗抽,一段里有几条就是几步(模型经常一次吐两三条)。
 *
 * 没有加粗的时候要**当心**:那多半是真的思维链(Claude Code / Codex 走自己的思考通道,
 * 吐的是整段推理)。把一段推理的第一行截成 48 字挂上去,得到的是一句没头没尾的残句,
 * 比不显示更糟。所以只有「本来就短、且只有一行」的才当步骤 —— 那种形状只可能是标题。
 * 其余一律返回空,让它照旧走「显示思考」那条路。
 */

/** 步骤标题最多显示这么长,超了截断。太长就不是步骤名了,铺开会把气泡撑坏 */
const MAX_LEN = 48;
/** 没有加粗时,整段短于这个长度才当步骤名看待 */
const BARE_STEP_MAX = 40;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN - 1) + "…" : t;
}

/**
 * @param text 一段 think 的原文
 * @returns 步骤标题,按出现顺序;没有可显示的内容时返回空数组
 */
export function thinkingSteps(text: string): string[] {
  const s = String(text ?? "");
  if (!s.trim()) return [];

  const bold: string[] = [];
  // 允许标题里带换行(模型偶尔会把长标题折行),但上限 200 字符 ——
  // 万一出现落单的 `**`,不许它一路吃到文末去。非贪婪,配上限就够安全了。
  const re = /\*\*([^*][\s\S]{0,200}?)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const t = clip(m[1]);
    if (t) bold.push(t);
  }
  if (bold.length) return bold;

  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length !== 1) return [];          // 多行 = 推理,不是标题
  if (lines[0].length > BARE_STEP_MAX) return []; // 长 = 推理,不是标题
  return [clip(lines[0])];
}

/** 一条消息里所有 think 段合起来的步骤列表,顺序保持不变、相邻重复的合并 */
export function stepsOfThinking(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const step of thinkingSteps(t)) {
      if (out[out.length - 1] !== step) out.push(step);
    }
  }
  return out;
}

/**
 * 一条消息此刻走到的那一步:所有 think 段里的最后一个步骤标题。
 *
 * 输入框上方的思考条带只显示这一行。以前是气泡里竖排整串步骤,几十步之后把气泡撑得很长,
 * 真正要看的「现在」反而沉在最底下。
 *
 * 只认 kind === "thinking" 的片段,文字、工具、状态片段一律跳过。
 * 没有可显示的步骤(没有思考,或者思考是整段推理)时返回 null,由调用方退回「正在跑哪个工具」。
 */
export function currentStep(parts: ReadonlyArray<{ kind: string; text?: string }>): string | null {
  const texts: string[] = [];
  for (const p of parts || []) {
    if (p.kind === "thinking" && typeof p.text === "string") texts.push(p.text);
  }
  const steps = stepsOfThinking(texts);
  return steps.length ? steps[steps.length - 1] : null;
}
