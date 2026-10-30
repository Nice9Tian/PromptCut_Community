// Facade for backward compatibility
//
// 每个工具的 `side`(C6.5 D1,`docs/plan/c65-design.md` 第 5 节;逐条的理由见 docs/archive/agent-reports/AGENT-c65-agent.md):
//   - "agent":在 Agent 服务端(编辑器 vite 进程)执行。有项目副本(页面接上了文档服务,见 server/agent/)时,
//              在副本上跑 src/mcp/handlers,算出操作以 Agent 对话的身份、带期望版本提交给文档服务;
//              没有副本(页面还没接文档服务、无头实例停用了文档服务)时照旧经页面执行。
//              既读页面状态又写项目的 set_project_meta、switch_cut、add_cut、remove_cut、attach_clip_motion 也在这一侧
//              (c65-integ2 裁定,D1 判据):所需的页面状态(播放头、页面内存里的轨迹)经页面通道只读地要一次,
//              见 server/agent/agent-exec.mjs 的 PAGE_STATE_TOOLS。
//   - "page": 只在页面执行:只读页面独有状态(选区、播放头、面板界面、页面里的作业表),或要用浏览器能力、
//              在后台作业完成时才写项目,搬到服务端会丢状态或写不进同一次提交。
//   - "server":在服务端就地执行,不碰项目(wait、report_progress、多 Agent 的 spawn_agent 与公告板四个工具)。
import { projectTools } from "./tools/project.mjs";
import { clipsTools } from "./tools/clips.mjs";
import { layoutTools } from "./tools/layout.mjs";
import { tracksTools } from "./tools/tracks.mjs";
import { partsTools } from "./tools/parts.mjs";
import { effectsTools } from "./tools/effects.mjs";
import { cutsTools } from "./tools/cuts.mjs";
import { audioTools } from "./tools/audio.mjs";
import { aiTools } from "./tools/ai.mjs";
import { cardsTools } from "./tools/cards.mjs";
import { visionTools } from "./tools/vision.mjs";
import { collectTools } from "./tools/collect.mjs";
import { browserTools } from "./tools/browser.mjs";
import { agentTools } from "./tools/agent.mjs";
import { coreTools } from "./tools/core.mjs";

/** 工具名 → 所在分组(server/tools/ 的文件名)。工具调用事件的 icon 用它(C6.5 D2) */
export const toolGroups = Object.fromEntries([
  ["project", projectTools], ["clips", clipsTools], ["layout", layoutTools], ["tracks", tracksTools], ["parts", partsTools],
  ["effects", effectsTools], ["cuts", cutsTools], ["audio", audioTools], ["ai", aiTools], ["cards", cardsTools],
  ["vision", visionTools], ["collect", collectTools], ["browser", browserTools], ["agent", agentTools], ["core", coreTools],
].flatMap(([group, list]) => list.map((t) => [t.name, group])));

export const tools = [
  ...projectTools,
  ...clipsTools,
  ...layoutTools,
  ...tracksTools,
  ...partsTools,
  ...effectsTools,
  ...cutsTools,
  ...audioTools,
  ...aiTools,
  ...cardsTools,
  ...visionTools,
  ...collectTools,
  ...browserTools,
  ...agentTools,
  ...coreTools,
];
