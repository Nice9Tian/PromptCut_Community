/**
 * 创造力等级的闸门(计划 `docs/plan/agent-workflow-plan.md` A1;语义 `user-workflow.md`「创造力等级」)。
 *
 * 放在所有工具调用的总入口 `server/vite-plugin-ai.ts` 的 `callToolInternal` 里,与审查环路的只读锁、SKILL 闸并列:
 * API 直连(闭包)和命令行(`mcp-server.mjs` → `POST /api/mcp/call`)两条路都经过它。**拦在执行之前**,
 * 越级的调用什么都不做,回一段 Agent 能据此停下说明的话。
 *
 * 「工具 → 需要的等级」对照表只写在这里(`TOOL_CREATIVITY`),表里没有的工具需要「低」(即谁都能用):
 *
 * | 工具 | 需要 | 理由 |
 * |---|---|---|
 * | `create_card`(同名用户卡已存在) | 中 | 整篇重写一张已有的卡 = 改它的代码(不带 overwrite 时实现回 409 并指向 edit_card) |
 * | `create_card`(卡不存在) | 高 | 新建卡片 |
 * | `edit_card` | 中 | 改已有卡片(用户卡、内置卡)的源码 |
 * | `create_filter`、`create_pixel_map`、`create_audio_fx` | 高 | 新建效果 |
 * | `update_filter`、`update_pixel_map`、`update_audio_fx`(动到定义) | 中 | 改效果的表达式 / 步骤 / 参数声明,挂着它的片段全跟着变 |
 * | `update_*`(只改 name、description) | 低 | 只改库里显示的名字和说明,不碰效果本身 |
 * | `measure_audio_js` | 高 | 写自定义测量代码(计划 A6;语义 `user-workflow.md`「创造力等级」:低档「测量只用内置方法」) |
 * | 其余(含 `apply_card`、`apply_*`、组合卡的部件工具、`measure_audio`) | 低 | 用已有的卡片 / 效果 / 部件、改参数、内置测量 |
 */
import { CREATIVITY_HINT, CREATIVITY_LABEL, creativityAllows, normalizeCreativity } from './ssr-host.mjs';

/** 用户卡 id 的形状(和 `server/vite-plugin-cards.ts` 的 kebab-case 白名单一致);不合形状的不去碰文件系统 */
const CARD_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 效果的 update_* 里只改展示信息的字段:只动这些不算改效果本身 */
const EFFECT_META_KEYS = new Set(['name', 'description']);

/** 效果的 update_* 工具 → 它的 id 参数名 */
const EFFECT_UPDATE_ID = Object.freeze({ update_filter: 'filterId', update_pixel_map: 'pixelMapId', update_audio_fx: 'fxId' });

function effectUpdate(idKey) {
  return (args) => {
    const touched = Object.keys(args ?? {}).filter((k) => k !== idKey && args[k] !== undefined);
    return touched.every((k) => EFFECT_META_KEYS.has(k))
      ? { level: 'low', what: '改效果的名字或说明' }
      : { level: 'medium', what: '改已有效果的定义(表达式、步骤或参数声明)' };
  };
}

/**
 * 工具 → 需要的等级。值是固定的 `{ level, what }`,或按参数判断的函数 `(args, ctx) => { level, what }`;
 * `ctx.cardExists(id)` 回这张用户卡在不在(调用方注入,纯函数测试里用假的)。
 */
export const TOOL_CREATIVITY = Object.freeze({
  create_card: (args, ctx) => {
    const id = typeof args?.id === 'string' ? args.id : '';
    const exists = !!id && CARD_ID_RE.test(id) && !!ctx?.cardExists?.(id);
    return exists
      ? { level: 'medium', what: `整篇重写已有的卡片 ${id}` }
      : { level: 'high', what: '新建卡片' };
  },
  edit_card: { level: 'medium', what: '改已有卡片的源码' },
  create_filter: { level: 'high', what: '新建滤镜' },
  create_pixel_map: { level: 'high', what: '新建像素映射' },
  create_audio_fx: { level: 'high', what: '新建音频效果' },
  update_filter: effectUpdate(EFFECT_UPDATE_ID.update_filter),
  update_pixel_map: effectUpdate(EFFECT_UPDATE_ID.update_pixel_map),
  update_audio_fx: effectUpdate(EFFECT_UPDATE_ID.update_audio_fx),
  measure_audio_js: { level: 'high', what: '写自定义测量代码' },
});

/** 这次调用需要的等级 */
export function requiredCreativity(tool, args, ctx = {}) {
  const rule = Object.hasOwn(TOOL_CREATIVITY, tool) ? TOOL_CREATIVITY[tool] : null;
  if (!rule) return { level: 'low', what: null };
  return typeof rule === 'function' ? rule(args ?? {}, ctx) : rule;
}

/**
 * 判一次调用。放行回 `{ ok: true, required }`;越级回 `{ ok: false, error, creativity: { current, required } }`,
 * `error` 写明当前等级、这个操作要的等级、怎么调 —— 由用户调,Agent 停下说明,不换工具绕。
 *
 * @param {string} tool
 * @param {object} args
 * @param {'low'|'medium'|'high'} current 这个对话生效的等级
 * @param {{ cardExists?: (id: string) => boolean, source?: string }} [ctx] source:等级从哪来(给报错用)
 */
export function checkCreativity(tool, args, current, ctx = {}) {
  const level = normalizeCreativity(current) ?? 'high';
  const req = requiredCreativity(tool, args, ctx);
  if (creativityAllows(level, req.level)) return { ok: true, required: req.level };
  const from = ctx.source ? `(${ctx.source})` : '';
  return {
    ok: false,
    creativity: { current: level, required: req.level, tool },
    error:
      `创造力等级不够,${tool} 没有执行:这个对话当前是「${CREATIVITY_LABEL[level]}」${from},` +
      `${req.what ? `${req.what}` : '这个操作'}要「${CREATIVITY_LABEL[req.level]}」。\n` +
      `「${CREATIVITY_LABEL[level]}」档:${CREATIVITY_HINT[level]}。\n` +
      `请停下来告诉用户:这一步需要把创造力等级调到「${CREATIVITY_LABEL[req.level]}」` +
      '(项目设置里改项目的默认等级,或在 AI 栏这个对话的运行选项里单独调高),由用户决定;' +
      '不要换别的工具或写法绕过去。等级之内能做的部分可以照常做。',
  };
}
