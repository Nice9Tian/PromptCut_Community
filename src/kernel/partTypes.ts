import type { ComponentType } from "react";
import type { ClipFrame, Control } from "./types";

/**
 * 部件库的契约。
 *
 * 部件是**可独立渲染的最小单元**:一个标题、一列要点、一个环形进度、一段 Lottie。
 * 卡片以前是一整块 JSX,部件在外面只是「说明书」(CardDef.parts);现在部件真的能单独摆、
 * 单独进场、单独换参数 —— 组合卡(cardId "composite")的 clip.parts 就是一棵部件实例树,
 * 舞台按树逐级渲染和摆位(render/PartTree.tsx)。Agent 用 add_part / set_part / remove_part
 * 增删改这棵树,操作的仍然是封装(kernel/envelope.ts),从没碰过组件源码。
 *
 * 部件和卡片的分工:卡片是「一种组合方式」(一整套配好的部件 + 位置 + 时序),部件是零件。
 * 现有卡片照旧能用,不强制改成部件组合;新做的组合从部件搭。
 */

export interface PartProps<P> {
  params: P;
  /** 自这个部件进场起的秒数(已经扣掉 enterMs);舞台每帧传入 */
  t: number;
  /** 每次重播 +1,和卡片一样用它做 key 重挂载 */
  playToken: number;
  /**
   * 这个部件的框在父坐标系里的尺寸(像素)。部件按它排版,不要假设 1920×1080。
   * 约定:有文字的部件都带一个 `size` 参数,**填 0 = 按框自适应**(用 parts/fit.ts 的 fitOr 算),
   * 填正数 = 固定像素。默认值给 0,这样 Agent 只管摆框、不用猜字号;要精确控制时再填数。
   */
  width: number;
  height: number;
}

export interface PartDef<P = Record<string, unknown>> {
  /** 全局唯一,kebab-case,按类别加前缀:text-title、list-pins、metric-ring、media-lottie */
  id: string;
  name: string;
  /** 一句话说清长什么样、怎么进场 */
  description: string;
  /** 写给 Agent 的选用依据:什么内容该用它、和近似部件怎么区分 */
  useWhen?: string;
  tags?: string[];
  role: "text" | "media" | "list" | "decor" | "group";
  /** 从哪张卡拆出来的(卡 id),没有就是新写的 */
  from?: string;
  defaults: P;
  controls: Control[];
  /**
   * 默认框(相对父坐标系;组合卡的父坐标系就是它的画布,默认 1920×1080)。
   * 不给 = 铺满父框。Agent add_part 不传 frame 时用它,所以要给一个「加上去就像样」的位置。
   */
  defaultFrame?: ClipFrame;
  /** 进场动画多久落定(毫秒),按当前参数算;没给按 0(挂上即显) */
  settleMs?: (params: P) => number;
  /** 落定之后:hold 停住 / loop 循环 / evolve 一直在变 */
  after?: "hold" | "loop" | "evolve";
  Component: ComponentType<PartProps<P>>;
}
