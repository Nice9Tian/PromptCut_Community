import type { AiProvider, ChatMessage } from "./types";
import { reportsOf, reportText } from "./progressReport.ts";

/**
 * 换模型接手时的「前情」。
 *
 * 每家 CLI 的历史都挂在它自己的会话 id 上(aiSession:<provider>),请求里只带这一轮说的话。
 * 于是面板上换一个模型,新模型拿到的就只有一句「你来接替继续」—— 前面几轮用户骂过什么、
 * 要的是什么,它一概不知。一次真实对话里 Opus 就这么接的手:它看不到用户那句
 * 「根本没有视频和图片」,只能照着项目现状自己找活干,还去磁盘上翻「交接笔记」。
 *
 * 这里把**这家模型没见过的那几轮**摘成一段,拼在这一轮提示词前面(只进模型,不进屏幕)。
 * 「没见过」= 这家最后一次回复之后的消息;这家还没有会话 id 就是整段对话。
 */

const LABEL: Record<AiProvider, string> = {
  claude: "Claude",
  agy: "Antigravity",
  codex: "Codex",
  api: "API 直连",
};

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…(后面略)` : t;
}

/**
 * 这条消息在前情里摘成什么。
 *
 * 改版后 Agent 的文字回复默认不给用户看,它可能一个字不说、只交 report_progress。
 * 那样的回复只看 m.text 就是空的,前情里会像是它什么都没做 —— 回退之后新会话的模型
 * 就不知道前面几轮已经做完了什么。文字为空时用报告拼一句「已完成:…;待办:…;问题:…」代替。
 */
function spokenText(m: ChatMessage): string {
  const text = m.text?.trim() ?? "";
  if (text || m.role !== "assistant") return text;
  return reportsOf(m).map(reportText).filter(Boolean).join(" / ");
}

export function buildHandoff(
  history: ChatMessage[],
  provider: AiProvider,
  hasSession: boolean,
  opts: { maxChars?: number; perMessage?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 6000;
  const perMessage = opts.perMessage ?? 1200;

  let from = 0;
  if (hasSession) {
    let lastOwn = -1;
    history.forEach((m, i) => {
      if (m.role === "assistant" && m.runtime?.provider === provider) lastOwn = i;
    });
    from = lastOwn + 1;
  }
  const unseen = history.slice(from).filter((m) => !m.pending);

  // 有会话 id 时,只有别家真的说过话才算有前情;自家报错、用户连发几句都不用补。
  // 只交了进度报告、没写文字的回复也算说过话
  const othersSpoke = unseen.some((m) => m.role === "assistant" && spokenText(m) && m.runtime?.provider !== provider);
  const anySpoke = unseen.some((m) => m.role === "assistant" && spokenText(m));
  if (hasSession ? !othersSpoke : !anySpoke) return "";

  const lines: string[] = [];
  for (const m of unseen) {
    const text = spokenText(m);
    if (!text) continue;
    if (m.role === "user") lines.push(`用户:${clip(text, perMessage)}`);
    else if (m.role === "assistant") {
      const who = m.runtime?.provider ? LABEL[m.runtime.provider] ?? m.runtime.provider : "助手";
      lines.push(`助手(${who}${m.runtime?.model ? ` · ${m.runtime.model}` : ""}):${clip(text, perMessage)}`);
    }
  }

  // 从最近的往前收,收满为止;最早那几条让位 —— 用户最新的要求比开头寒暄要紧
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > maxChars && kept.length > 0) break;
    kept.unshift(lines[i]);
    size += lines[i].length;
  }
  const dropped = lines.length - kept.length;

  return [
    "[前情 —— 系统自动附上,不是用户这一轮说的话。这段对话之前不是你在接待(或者你的会话记录已经没了),",
    "你看不到那段历史,下面是按时间顺序的摘录。用户在里面提过的要求照样算数;时间轴和素材库的现状以工具读到的为准。]",
    ...(dropped > 0 ? [`(更早的 ${dropped} 条略)`] : []),
    ...kept,
    "[/前情]",
  ].join("\n");
}
