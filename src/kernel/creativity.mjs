/**
 * 创造力等级(`docs/semantics/user-workflow.md`「创造力等级」):决定一个 Agent 对话能改到多深。
 *
 *   - 低:只用已有的卡片和效果,只改参数;测量只用内置方法;
 *   - 中:在已有卡片和效果的基础上,可以改它们的代码或表达式,但不新建;
 *   - 高:可以新建任意卡片和效果,可以写自定义测量代码。
 *
 * 项目有一个默认等级(`Project.creativity`),在项目设置里选,出厂为「高」—— 字段缺省(旧项目)一律按「高」。
 * AI 栏每个对话默认取项目的等级,可以单独改(覆盖值只存在本机页签里,计划 `agent-workflow-plan.md` 第 4 节第 3 条);
 * 桌面 APP 的会话跟随项目的等级。
 *
 * 为什么是 `.mjs`:页面(项目设置、AI 栏)和服务端(工具入口的闸门 `server/agent/creativity-gate.mjs`)
 * 用同一份等级定义,Node 直接 import 不了 `.ts`。
 */

/** 从低到高 */
export const CREATIVITY_LEVELS = Object.freeze(['low', 'medium', 'high']);

/** 出厂等级,也是项目缺这个字段时的等级 */
export const DEFAULT_CREATIVITY = 'high';

/** 给人看的名字 */
export const CREATIVITY_LABEL = Object.freeze({ low: '低', medium: '中', high: '高' });

/** 选项上的短说明(下拉框放不下整句) */
export const CREATIVITY_SHORT = Object.freeze({ low: '只改参数', medium: '可改代码和表达式', high: '可新建卡片和效果' });

/** 每一档允许什么(项目设置、AI 栏的提示和闸门的报错共用这几句) */
export const CREATIVITY_HINT = Object.freeze({
  low: '只用已有的卡片和效果,只改参数;测量只用内置方法',
  medium: '可以改已有卡片和效果的代码或表达式,但不新建',
  high: '可以新建任意卡片和效果,可以写自定义测量代码',
});

/** 合法等级原样回,其它(缺省、拼错、旧数据)回 null */
export function normalizeCreativity(value) {
  return typeof value === 'string' && CREATIVITY_LEVELS.includes(value) ? value : null;
}

/** 项目的默认等级:字段缺省或不认识时按出厂的「高」 */
export function projectCreativity(project) {
  return normalizeCreativity(project?.creativity) ?? DEFAULT_CREATIVITY;
}

/** 一个对话实际生效的等级:对话自己的覆盖值优先,没有就跟项目 */
export function effectiveCreativity(override, projectLevel) {
  return normalizeCreativity(override) ?? normalizeCreativity(projectLevel) ?? DEFAULT_CREATIVITY;
}

/** 等级的序号(低 0、中 1、高 2),不认识的当「高」 */
export function creativityRank(level) {
  const i = CREATIVITY_LEVELS.indexOf(level);
  return i < 0 ? CREATIVITY_LEVELS.length - 1 : i;
}

/** `current` 够不够 `required` */
export function creativityAllows(current, required) {
  return creativityRank(normalizeCreativity(current) ?? DEFAULT_CREATIVITY) >= creativityRank(normalizeCreativity(required) ?? 'low');
}
