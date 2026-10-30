import type { ToolCallInfo } from "../../../ai/types.ts";
import { isReportTool } from "../../../ai/progressReport.ts";

/**
 * 聊天气泡里那排操作图标(ToolIcons.tsx)背后的纯函数:动作分类和图标分组。
 *
 * 单独成文件、不碰 React 和样式,好让 node 直接跑测试(iconRuns.test.mjs)。
 */

/**
 * 图标的颜色分类。
 *
 * 按「这一步对项目做了什么」分,不是按工具名字母序 —— 用户扫一眼要能看出
 * 哪几下是在删东西。读取类故意用最淡的颜色:它们数量最多但最不值得注意,
 * 满屏一样亮的话反而看不见真正的动作。
 */
export type ToolKind = "add" | "remove" | "edit" | "read" | "look" | "download" | "ui" | "agent" | "wait" | "job";

/**
 * 去掉工具名前面的服务器前缀。Claude Code 报上来的是 `mcp__promptcut__add_clip`,
 * 别家有的是裸名、有的是 `promptcut.add_clip`。分类、比对和显示都按裸名来 ——
 * 不去掉的话下面的正则一条都对不上,Claude 跑的每一步都会落进兜底的「处理」。
 */
export function bareToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, "").replace(/^[\w-]+\.(?=\w)/, "");
}

/*
 * 「处理」是兜底,只该剩下真正要跑一阵的活儿(转写、追踪、检测、预渲染、自动流程)。
 * 新工具落进「处理」的话,先想想它其实是在收集、改、读还是在点界面。
 */
export function toolKind(rawName: string): ToolKind {
  const name = bareToolName(rawName);
  // 界面操作:播放头、切剪辑、弹窗这类动用户界面、不改项目的。2026-10-21 起这些工具名字带 user_interface_ 前缀;
  // 老对话的历史里还是旧名(play / pause / seek / switch_cut),两种都认。放最前:user_interface_collect_login 不算收集
  if (/^user_interface_|^(play|pause|seek)$|^switch_/.test(name)) return "ui";
  // 收集放在界面操作之后:search_web、collect_*、web_* 的目的都是往回搬素材和资料,哪怕名字像「读取」「查看」也归这里。
  // *_install 装的是拓展包,和 collect_install 一样算往回搬东西
  if (/^(collect|web)_|^search_web$|_install$|download/i.test(name)) return "download";
  // 多 Agent 之间报范围、互相递话。放在读取前面:list_agents / check_messages 名字像读取,其实是协作
  if (/^(declare_scope|send_message|check_messages|list_agents)$/.test(name)) return "agent";
  if (/^(remove|delete|clear)_/.test(name)) return "remove";
  // duplicate_clip 是多出一段、fill_captions 是铺出一批字幕,都算新增
  if (/^(add|create|import|insert|duplicate|fill)_/.test(name)) return "add";
  // align / nudge 是在挪位置;attach / detach 是给 clip 挂上、摘掉运动 —— 都是改 clip
  if (/^(set|update|edit|move|rename|reorder|split|trim|attach|detach)_|^(align|nudge)$/.test(name)) return "edit";
  // 看画面(see_frames、view_file 这类)单拎出来,和翻数据的读取分开
  if (/^(see|view)_/.test(name)) return "look";
  // detect_* 要跑一阵分析,不在这里 —— 落到下面的「处理」。*_status 只是问一句进度,算读取
  if (/^(list|get|read|search|find|check|inspect)_|_status$|_guide$/.test(name)) return "read";
  if (/^wait/.test(name)) return "wait";
  return "job";
}

export const KIND_LABEL: Record<ToolKind, string> = {
  add: "新增",
  remove: "删除",
  edit: "修改",
  read: "读取",
  look: "查看",
  download: "收集",
  ui: "界面操作",
  agent: "多 Agent",
  wait: "等待",
  job: "处理",
};

/**
 * 一个图标最多装这么多个操作。
 *
 * 以前是「连续 4 个同类就折成第一个 ×N,点开再摊平」:一串 30 次读取折成一个小方块,
 * 点开之后又一下子铺满一屏。改成每个图标最多叠 5 个、第 6 个开新图标 ——
 * 做得多的地方图标就多,一眼看得出哪一段忙;单个图标点开也只有几行清单。
 */
export const ICON_RUN_MAX = 5;

/** iconRuns 只看名字(认类别、认报告工具)和成败 */
export type ToolPartLike = Pick<ToolCallInfo, "name" | "ok">;

export interface IconRun {
  /**
   * 在这一排里唯一且稳定:取装进来的第一个操作的下标。
   * 流式时新操作只往后追加,已经出现的图标 key 不会变,展开状态和轮播聚焦就不会跳到别的图标上。
   */
  key: string;
  /** 第一个操作的动作类型,决定底色和字形 */
  kind: ToolKind;
  /** 有失败的 → err;有还没出结果的 → run;否则 ok */
  state: "run" | "ok" | "err";
  /** 装进这个图标的操作在传入数组里的下标,按先后顺序 */
  items: number[];
}

/**
 * 把一段操作切成图标。
 *
 * - 报告工具(report_progress)不出图标:它画成报告卡。这里当它不存在,也不打断前后的同类操作;
 * - 相邻、分组键相同的操作合成一个图标。分组键 = 失败的用 "err"(红叹号自成一类,
 *   会把同类型的一串打断),否则用动作类型;
 * - stt_install 永远单独成一个:它可能渲染成进度条而不是图标,不和任何东西并;
 * - 一个图标最多装 ICON_RUN_MAX 个,满了开新图标(12 个同类 → 5、5、2)。
 */
export function iconRuns(tools: readonly ToolPartLike[]): IconRun[] {
  const runs: IconRun[] = [];
  let lastGroup = "";
  tools.forEach((t, i) => {
    if (isReportTool(t.name)) return;
    const group = bareToolName(t.name) === "stt_install" ? `install:${i}` : t.ok === false ? "err" : toolKind(t.name);
    const last = runs[runs.length - 1];
    if (last && group === lastGroup && last.items.length < ICON_RUN_MAX) {
      last.items.push(i);
      return;
    }
    runs.push({ key: `r${i}`, kind: toolKind(t.name), state: "ok", items: [i] });
    lastGroup = group;
  });
  for (const run of runs) {
    const items = run.items.map((i) => tools[i]);
    run.state = items.some((t) => t.ok === false) ? "err" : items.some((t) => t.ok === undefined) ? "run" : "ok";
  }
  return runs;
}
