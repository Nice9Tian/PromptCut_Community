/**
 * 给 add_clip / update_clip 的 `params` 生成真实的 JSON Schema。
 *
 * 为什么需要它:`params` 的合法字段取决于 cardId,静态写不出来。原来的写法是
 * `params: { type: "object" }` —— 一个没有任何字段说明的自由对象。
 * MCP server 走 tools/list 时会动态换成下面这个 anyOf,但 **API 直连从来没做这一步**,
 * 于是模型收到的是被 sanitizeSchema 规范成的 `{ type:"object", properties:{} }`,
 * 意思变成「这个对象没有任何字段」—— 模型因此**根本无法传任何卡片参数**,
 * 建出来的卡永远是 params: {}。字幕卡没有 lines、动效卡全是默认值,根子都在这里。
 *
 * 两条路现在共用这一份,不会再出现「CLI 能传、API 传不了」的不对称。
 */

import { PARAMS_PATCH_DESC } from "./tools/clips.mjs";

/** 控件类型 → JSON Schema 类型 */
function typeOf(control) {
  if (control.type === "number") return { type: "number" };
  if (control.type === "select") {
    return { type: "string", enum: control.options?.map((o) => o.value) ?? [] };
  }
  return { type: "string" };
}

function describe(control) {
  const bits = [control.label].filter(Boolean);
  if (control.required) bits.push("必填");
  if (control.hint) bits.push(control.hint);
  // 素材目录:列出可选的 URL,但不做 enum —— 目录之外的 URL / 内联 JSON 也是合法的
  if (control.type === "asset" && Array.isArray(control.options) && control.options.length) {
    bits.push("素材目录:" + control.options.map((o) => `${o.value}(${o.label})`).join(";"));
  }
  return bits.join(" · ") || undefined;
}

/**
 * @param cards list_cards({ detail: 'full' }) 的返回,每项要有 id / controls
 * @param opts.patch true:给 update_clip 用的「增量补丁」版本。params 在那里是补丁,只写要改的键,
 *        所以不带 `required`(必填的键已经在 clip 上了,不用每次重传)并且说明里写明「没传的键保持当前值」。
 *        线上 2026-10-21:模型看到 required 和一整份字段,就把凭记忆的整份参数带回来,把用户刚撤销的颜色写了回去。
 * @returns 可直接塞进 add_clip.params / update_clip.params 的 schema
 */
export function buildParamsSchema(cards, opts = {}) {
  const usable = (cards || []).filter((c) => c && typeof c.id === "string" && Array.isArray(c.controls));
  if (usable.length === 0) return null;
  const patch = opts.patch === true;

  return {
    type: "object",
    description: patch
      ? `${PARAMS_PATCH_DESC}合法字段取决于这张卡当前的 cardId（换卡时才取新卡的字段）;下面每个分支对应一张卡。`
      : "卡片参数,合法字段取决于 cardId。下面每个分支对应一张卡;先用 list_cards({cardId}) 看清该卡的 controls 再填。",
    anyOf: usable.map((card) => {
      const properties = {};
      const required = [];
      for (const control of card.controls) {
        properties[control.key] = { ...typeOf(control), description: describe(control) };
        if (control.required) required.push(control.key);
      }
      return {
        title: card.id,
        type: "object",
        properties,
        ...(required.length && !patch ? { required } : {}),
        // 留个口子:卡片刚加的参数还没进这份 schema 时也能传进来
        additionalProperties: true,
      };
    }),
  };
}

/**
 * 就地把 add_clip / update_clip 的 params 换成真实 schema。
 * 拿不到卡片列表时原样返回 —— 宁可退回自由对象,也不要因为拼 schema 失败让工具整个用不了。
 */
export function injectCardParams(tools, cards) {
  const schema = buildParamsSchema(cards);
  if (!schema) return tools;
  const patchSchema = buildParamsSchema(cards, { patch: true });
  for (const tool of tools) {
    // 只碰卡片的两个工具:add_part / set_part 也有 params,那是部件的,由 injectPartParams 管
    if (tool?.name !== "add_clip" && tool?.name !== "update_clip") continue;
    const props = tool?.inputSchema?.properties ?? tool?.parameters?.properties;
    // update_clip 的 params 是增量补丁,用补丁版(不带 required、说明写明没传的键保持当前值)
    if (props && "params" in props) props.params = tool.name === "update_clip" ? patchSchema : schema;
  }
  return tools;
}

/* ── 部件:add_part / set_part 的 params,add_composite 的 parts ──────────────── */

const FRAME_SCHEMA = {
  type: "object",
  description: "相对父框的框:x / y 锚点位置(像素)、w / h 尺寸、anchor [ax, ay](默认 [0,0])、scale、rotate;省略用部件的 defaultFrame",
  properties: {
    x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
    anchor: { type: "array", items: { type: "number" } }, scale: { type: "number" }, rotate: { type: "number" },
  },
  required: ["x", "y"],
};

/** 部件参数按 partId 分支的 schema;和卡片那份一个做法 */
export function buildPartParamsSchema(parts) {
  const usable = (parts || []).filter((p) => p && typeof p.id === "string" && Array.isArray(p.controls));
  if (usable.length === 0) return null;
  return {
    type: "object",
    description: "部件参数,合法字段取决于 partId;有文字的部件都有 size,填 0 = 按框自适应。先 list_parts({ partId }) 看 controls。",
    anyOf: usable.map((part) => {
      const properties = {};
      const required = [];
      for (const control of part.controls) {
        properties[control.key] = { ...typeOf(control), description: describe(control) };
        if (control.required) required.push(control.key);
      }
      return { title: part.id, type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: true };
    }),
  };
}

/**
 * add_composite.parts 的 schema:每项 { partId, params, frame, enterMs, label, children }。
 * children 不能无限递归(Gemini 不支持 $ref),展开两层够用;再深的用 add_part 加。
 */
export function buildPartsListSchema(parts, paramsSchema) {
  const ids = (parts || []).map((p) => p?.id).filter((id) => typeof id === "string");
  const item = (children) => ({
    type: "object",
    properties: {
      partId: { type: "string", ...(ids.length ? { enum: ids } : {}), description: "list_parts 里的部件 id" },
      params: paramsSchema ?? { type: "object", additionalProperties: true },
      frame: FRAME_SCHEMA,
      enterMs: { type: "number", description: "相对父级进场的毫秒数" },
      label: { type: "string" },
      ...(children ? { children } : {}),
    },
    required: ["partId"],
    additionalProperties: true,
  });
  return { type: "array", items: item({ type: "array", items: item({ type: "array", items: item(null) }) }), description: "部件实例列表;最多在这里嵌套三层,更深的用 add_part 加" };
}

/** 就地把 add_part / set_part 的 params 和 add_composite 的 parts 换成真实 schema;拿不到部件列表就原样返回 */
export function injectPartParams(tools, parts) {
  const schema = buildPartParamsSchema(parts);
  if (!schema) return tools;
  for (const tool of tools) {
    const props = tool?.inputSchema?.properties ?? tool?.parameters?.properties;
    if (!props) continue;
    if ((tool.name === "add_part" || tool.name === "set_part") && "params" in props) props.params = schema;
    if (tool.name === "add_composite" && "parts" in props) props.parts = buildPartsListSchema(parts, schema);
    if ((tool.name === "add_part" || tool.name === "set_part") && "frame" in props) props.frame = { ...FRAME_SCHEMA, description: props.frame?.description ?? FRAME_SCHEMA.description };
  }
  return tools;
}
