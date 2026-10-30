/**
 * 会动用户界面的工具:名字前加 `user_interface_`(2026-10-21 用户定,`product/agent.md`「工具」)。
 *
 * 用户原话:「切这个动作可以改成user_interface.swith_cut（）这样在代码层面就可以理解到会动用户界面。还有时间轴操作也是,
 * 动用户界面的加user_interface。」模型侧的工具名只认 `^[a-zA-Z0-9_-]{1,64}$`(Claude、OpenAI 都是),不能带点,所以写成下划线。
 *
 * 判据:这个工具的**主要效果**是改变用户(所有成员,或发起人自己的页面、电脑)眼前的界面状态,而不是改项目内容。
 * 逐个判断的理由写在 `docs/reports/AGENT-cut-look-ui.md`「工具改名对照表」。
 *
 * 三处名字:
 *   - **模型看到的名字**(工具清单、系统提示词、工具说明):新名。旧名不再出现在交给模型的清单里;
 *   - **工具调用入口**:新旧都认,旧名当场换成新名(老对话的历史里还是旧名,模型照着历史调旧名时照常执行);
 *   - **发给页面的内部操作名**(SSE 的 `call`、反向通道请求里的 `tool`):保持旧名,0.7.18 桌面版当发起人页面时照常认;
 *     页面一侧两种都认(`src/ai/mcpExecutor.ts`、`src/ai/cloud/pageRequests.ts` 进门先换回旧名)。
 *
 * 本文件不引用 `src/`(Agent 服务的独立入口只许经载入缝引用 `src/`);页面那一侧直接 import 本文件。
 */

export const UI_TOOL_PREFIX = 'user_interface_';

/** 旧名 → 新名 */
export const UI_TOOL_RENAMES = Object.freeze({
  switch_cut: 'user_interface_switch_cut',
  seek: 'user_interface_seek',
  play: 'user_interface_play',
  pause: 'user_interface_pause',
  web_handoff: 'user_interface_web_handoff',
  collect_login: 'user_interface_collect_login',
});

/** 新名 → 旧名(发给页面的内部操作名) */
export const UI_TOOL_LEGACY = Object.freeze(Object.fromEntries(Object.entries(UI_TOOL_RENAMES).map(([oldName, newName]) => [newName, oldName])));

const own = (table, key) => typeof key === 'string' && Object.hasOwn(table, key);

/** 任意名字 → 模型侧的名字(旧名换新名,别的原样) */
export function modelToolName(name) {
  return own(UI_TOOL_RENAMES, name) ? UI_TOOL_RENAMES[name] : name;
}

/** 任意名字 → 发给页面的内部操作名(新名换回旧名,别的原样) */
export function pageToolName(name) {
  return own(UI_TOOL_LEGACY, name) ? UI_TOOL_LEGACY[name] : name;
}

/** 这个名字(新旧都算)是不是会动用户界面的工具 */
export function isUserInterfaceTool(name) {
  return own(UI_TOOL_RENAMES, name) || own(UI_TOOL_LEGACY, name);
}

/** 系统提示词里的那一句(本机与云端共用) */
export const UI_TOOLS_PROMPT_LINE =
  '- **名字带 `user_interface_` 的工具会动用户的界面**(切换所有成员共享的激活剪辑、移动播放头、开始或暂停播放、把窗口或登录框弹到用户面前),能不用就不用:' +
  '看别的剪辑的画面用 `see_frames` 的 `cutId`,改别的剪辑里已有的片段直接按 clipId 改,都不用切换;只有用户明说要切、要跳、要播,或这一步非得用户本人操作时才用。';
