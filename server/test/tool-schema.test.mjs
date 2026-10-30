// 工具 schema 送到模型手里长什么样。
// 这里挡住的是一个真实发生过的失败:add_clip 的 params 被规范成
// { type:"object", properties:{} },意思变成「这个对象没有任何字段」,
// 模型因此一个卡片参数都传不出去,建出来的卡永远是 params: {}。
// 跑法:node --test server/test/tool-schema.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolToVendor, sanitizeSchema } from '../harness/schema.mjs';
import { tools as mcpTools } from '../mcp-tools.mjs';
import { TOOL_ROUTES } from '../../src/mcp/routes.mjs';
import { modelToolName } from '../tools/ui-names.mjs';
import { buildParamsSchema, injectCardParams, injectPartParams, buildPartParamsSchema } from '../card-params-schema.mjs';

/** 两张形状不同的卡,够覆盖 text / number / select / required */
const CARDS = [
  {
    id: 'caption-track',
    controls: [
      { key: 'lines', label: '字幕', type: 'text', required: true, hint: '一行一条' },
      { key: 'showEn', label: '显示英文', type: 'select', options: [{ value: 'true' }, { value: 'false' }] },
      { key: 'strokeW', label: '描边宽度', type: 'number' },
    ],
  },
  {
    id: 'odometer',
    controls: [
      { key: 'value', label: '数值', type: 'number' },
      { key: 'unit', label: '单位', type: 'text' },
    ],
  },
];

// ── sanitizeSchema:自由对象不能被改写成「没有字段」 ──────────────
test('嵌套的自由对象保持自由,不再被塞成 properties: {}', () => {
  const out = sanitizeSchema({ type: 'object', properties: { blob: { type: 'object' } } }, 'openai');
  assert.notDeepEqual(out.properties.blob.properties, {}, '空 properties 等于告诉模型「没有字段可填」');
  assert.equal(out.properties.blob.additionalProperties, true);
});

test('没有参数的工具,顶层仍然是 properties: {}', () => {
  const out = sanitizeSchema({ type: 'object', properties: {} }, 'openai');
  assert.deepEqual(out.properties, {}, '「这个工具不接受参数」是真的没有字段,不能改');
});

test('anyOf 分支会被一起清洗', () => {
  const out = sanitizeSchema(
    { type: 'object', properties: { p: { type: 'object', anyOf: [{ type: 'object', properties: { free: { type: 'object' } } }] } } },
    'openai',
  );
  assert.equal(out.properties.p.anyOf[0].properties.free.additionalProperties, true);
});

test('gemini 不支持 additionalProperties,退回空对象而不是留个非法字段', () => {
  const out = sanitizeSchema({ type: 'object', properties: { blob: { type: 'object' } } }, 'gemini');
  assert.equal(out.properties.blob.additionalProperties, undefined);
  assert.deepEqual(out.properties.blob.properties, {});
});

// ── buildParamsSchema:每张卡的真实字段 ───────────────────────────
test('每张卡一个分支,字段名和类型都对得上', () => {
  const schema = buildParamsSchema(CARDS);
  const caption = schema.anyOf.find((b) => b.title === 'caption-track');
  assert.ok(caption, '要能按 cardId 找到分支');
  assert.equal(caption.properties.lines.type, 'string');
  assert.equal(caption.properties.strokeW.type, 'number');
  assert.deepEqual(caption.properties.showEn.enum, ['true', 'false']);
  assert.deepEqual(caption.required, ['lines'], '必填要传给模型,不然它不知道非填不可');
  assert.match(caption.properties.lines.description, /一行一条/, 'hint 要透出去');
});

test('卡片刚加的参数也能传:每个分支都允许额外字段', () => {
  assert.equal(buildParamsSchema(CARDS).anyOf[0].additionalProperties, true);
});

test('拿不到卡片时返回 null,由调用方退回自由对象', () => {
  assert.equal(buildParamsSchema([]), null);
  assert.equal(buildParamsSchema(undefined), null);
});

// ── 端到端:模型最终收到的 add_clip ───────────────────────────────
function sentToModel(cards) {
  const tools = mcpTools
    .filter((t) => ['add_clip', 'update_clip'].includes(t.name))
    .map((t) => ({ ...t, inputSchema: JSON.parse(JSON.stringify(t.inputSchema)) }));
  if (cards) injectCardParams(tools, cards);
  return Object.fromEntries(tools.map((t) => [t.name, toolToVendor(t, 'openai').function.parameters]));
}

test('注入之后,模型能在 add_clip 里看到 lines 这个字段', () => {
  const params = sentToModel(CARDS).add_clip.properties.params;
  assert.ok(Array.isArray(params.anyOf), '应该是按 cardId 分支的联合类型');
  const caption = params.anyOf.find((b) => b.title === 'caption-track');
  assert.ok('lines' in caption.properties, '这正是以前传不出去的那个参数');
});

test('update_clip 同样注入', () => {
  const params = sentToModel(CARDS).update_clip.properties.params;
  assert.ok(params.anyOf.some((b) => b.title === 'odometer'));
});

test('回归:没注入时 params 不再是「没有字段的对象」', () => {
  // 就算注入失败,也不能再退化成 properties:{} —— 那是模型交不出参数的根因
  const params = sentToModel(null).add_clip.properties.params;
  assert.notDeepEqual(params.properties, {}, '空 properties 会让模型只能交出 {}');
  assert.equal(params.additionalProperties, true);
});

test('注入不会污染共享的 mcpTools 常量', () => {
  sentToModel(CARDS);
  const raw = mcpTools.find((t) => t.name === 'add_clip');
  assert.equal(raw.inputSchema.properties.params.anyOf, undefined, 'mcpTools 是模块级共享的,不能被就地改掉');
});

// ── 三处声明必须对齐 ──────────────────────────────────────────────────
// 一个工具要能被调用，得同时出现在三个地方：mcp-tools.mjs 的声明、mcpExecutor 的
// 分发、EditorApi 的实现。缺哪一处都是「模型看得见但调不动」，而且只在模型真的
// 去调的时候才暴露 —— 那时候一次任务已经跑废了。
// 一对一转发的那一百来个工具现在走 src/mcp/routes.mjs 的路由表,不再是逐个 tool === 分支;
// 对账的细账在 server/test/mcp-routes.test.mjs,这里只守「声明了就得有地方接住」。
test('mcp-tools 里每个 browser 工具，执行器里都有对应的分发分支', () => {
  const src = readFileSync(new URL('../../src/ai/mcpExecutor.ts', import.meta.url), 'utf8');
  // web_* 走的是前缀分发 + runWebTool 里的 switch，不是逐个 tool === 分支。守卫的意思没变：
  // 声明了就必须真有地方接住，所以这里也认 case "web_x": 这种形式。
  const missing = mcpTools
    .filter((t) => t.side === 'page' || t.side === 'agent')
    .map((t) => t.name)
    .filter((n) => !(n in TOOL_ROUTES) && !src.includes(`tool === "${n}"`) && !src.includes(`case "${n}":`));
  assert.deepEqual(missing, [], `执行器里没有分支的工具：${missing.join('、')}`);
});

test('执行器分发的每个工具名，mcp-tools 里都真的有声明', () => {
  const src = readFileSync(new URL('../../src/ai/mcpExecutor.ts', import.meta.url), 'utf8');
  const declared = new Set(mcpTools.map((t) => t.name));
  const dispatched = [
    ...Object.keys(TOOL_ROUTES),
    ...[...src.matchAll(/tool === "([a-z_]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/case "(web_[a-z_]+)":/g)].map((m) => m[1]),
  ];
  // 页面执行器里网页接管按旧的内部操作名分支(case "web_handoff"),进门先换成新名(server/tools/ui-names.mjs):认它对应的新名
  const orphans = dispatched.filter((n) => !declared.has(n) && !declared.has(modelToolName(n)));
  assert.deepEqual(orphans, [], `执行器分发了但没声明的工具：${orphans.join('、')}`);
});

// 放宽超时的名单要**逐个**是有意加的:桥的超时一旦先到,真正的报错信息就被盖掉,
// Agent 只看得到「超时」两个字。所以这里钉死名单,加新的必须改这一行。
// 三个都要当场起一个 Chrome 渲染(vite-plugin-vision):see_frames 渲单帧(timeline)或一整张拼图(media),
// get_gif 一趟渲 8 帧再编动图,bake_card 渲单帧。
// 第四个是自定义测量 measure_audio_js(计划 A6):解码(最多 30 秒)+ 起沙箱 Chrome + 代码(最多 30 秒)+ 看门狗余量,超过桥缺省的 60 秒。
test('放宽超时的渲染、自定义测量与音效生成工具有明确预算', async () => {
  const withTimeout = mcpTools.filter((t) => t.timeoutMs);
  // 只钉名单,不钉顺序:工具表按领域拆进 server/tools/ 之后,先后次序由聚合顺序决定,没有含义
  assert.deepEqual(withTimeout.map((t) => t.name).sort(), ['bake_card', 'get_gif', 'measure_audio_js', 'render_card_audio', 'see_frames', 'sound_generate']);
  for (const t of withTimeout.filter((x) => !['measure_audio_js', 'sound_generate', 'render_card_audio'].includes(x.name))) assert.ok(t.timeoutMs > 120000, `${t.name} 要大于 vite-plugin-vision 里 120 秒的渲染上限`);
  assert.ok(withTimeout.find(t => t.name === 'sound_generate').timeoutMs >= 120000, '音效工具等待 Worker 合成和素材入库,保留 120 秒预算');
  assert.ok(withTimeout.find(t => t.name === 'render_card_audio').timeoutMs >= 120000, '声画卡声音等待按块生成和素材入库,保留 120 秒预算');
  const { PCM_LIMITS } = await import('../audio-pcm.mjs');
  const { SANDBOX_LIMITS } = await import('../audio-sandbox.mjs');
  const js = withTimeout.find((x) => x.name === 'measure_audio_js');
  assert.ok(js.timeoutMs > PCM_LIMITS.decodeTimeoutMs + SANDBOX_LIMITS.maxTimeoutMs + SANDBOX_LIMITS.graceMs + 15000, 'measure_audio_js 要大于解码 + 代码时限 + 看门狗余量 + 起 Chrome');
});

// ── 枚举值必须是字符串 ─────────────────────────────────────────────
// 诊断报告里抓到的真失败:collect_probe 的 quality 写了数字枚举 [2160, 1440, …],
// Gemini 的 OpenAI 兼容接口回 400「enum[0] (TYPE_STRING), 2160」,整个请求被拒,
// agent 一个工具都调不了。取值范围写进 description,服务端用白名单兜底。
test('所有工具的 enum 值都是字符串(Gemini 只认字符串枚举)', () => {
  const bad = [];
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.enum)) {
      for (const v of node.enum) if (typeof v !== 'string') bad.push(`${where}: ${JSON.stringify(v)}`);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'enum') continue;
      if (v && typeof v === 'object') walk(v, `${where}.${k}`);
    }
  };
  for (const t of mcpTools) walk(t.inputSchema, t.name);
  assert.deepEqual(bad, [], '数字 / 布尔枚举会让 Gemini 直接拒掉整个请求');
});

test('所有 type 都是单一字符串(Gemini 不认数组 type,sanitizeSchema 也不会打平它)', () => {
  const bad = [];
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if ('type' in node && typeof node.type !== 'string') bad.push(`${where}: ${JSON.stringify(node.type)}`);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'enum' || k === 'type') continue;
      if (v && typeof v === 'object') walk(v, `${where}.${k}`);
    }
  };
  for (const t of mcpTools) walk(t.inputSchema, t.name);
  assert.deepEqual(bad, []);
});

// ── 部件:add_part / set_part 的 params 与 add_composite 的 parts ───────────────
const PARTS = [
  { id: 'text-title', controls: [{ key: 'text', label: '标题', type: 'text', required: true }, { key: 'size', label: '字号', type: 'number' }] },
  { id: 'list-pins', controls: [{ key: 'items', label: '要点', type: 'text' }] },
];
test('injectPartParams 只碰部件工具;injectCardParams 不再误伤 add_part 的 params', () => {
  const tools = JSON.parse(JSON.stringify(mcpTools));
  injectCardParams(tools, [{ id: 'x', controls: [{ key: 'foo', label: 'f', type: 'text' }] }]);
  const addPart = tools.find((t) => t.name === 'add_part');
  assert.equal(addPart.inputSchema.properties.params.anyOf, undefined, '卡片 schema 不该灌进 add_part');
  injectPartParams(tools, PARTS);
  assert.equal(addPart.inputSchema.properties.params.anyOf.length, 2);
  assert.deepEqual(addPart.inputSchema.properties.params.anyOf[0].required, ['text']);
  assert.equal(tools.find((t) => t.name === 'set_part').inputSchema.properties.params.anyOf[1].title, 'list-pins');
  const parts = tools.find((t) => t.name === 'add_composite').inputSchema.properties.parts;
  assert.equal(parts.type, 'array');
  assert.deepEqual(parts.items.properties.partId.enum, ['text-title', 'list-pins']);
  assert.equal(parts.items.properties.children.items.properties.children.items.properties.children, undefined, '最多三层');
  assert.equal(tools.find((t) => t.name === 'add_clip').inputSchema.properties.params.anyOf[0].title, 'x', '卡片工具还是卡片 schema');
  assert.equal(buildPartParamsSchema([]), null);
});

test('sanitizeSchema:compat 和 vendor 解耦 —— openai 也能按 Gemini 子集清洗,gemini 也能关掉', () => {
  const schema = { type: 'object', properties: { params: { type: 'object' }, n: { type: 'number', default: 1 } }, additionalProperties: true };
  const openaiCompat = sanitizeSchema(schema, 'openai', { compat: true });
  assert.equal(openaiCompat.additionalProperties, undefined);
  assert.deepEqual(openaiCompat.properties.params, { type: 'object', properties: {} });
  // default 是 Gemini 认的字段,兼容模式**不该**删它(以前删了,是过度设限)
  assert.equal(openaiCompat.properties.n.default, 1);
  const openaiPlain = sanitizeSchema(schema, 'openai');
  assert.equal(openaiPlain.properties.params.additionalProperties, true);
  assert.equal(sanitizeSchema(schema, 'gemini').properties.params.additionalProperties, undefined, 'gemini 默认就是 compat');
  assert.equal(sanitizeSchema(schema, 'gemini', { compat: false }).properties.params.additionalProperties, true);
});

/**
 * 兼容模式到底该删什么 —— 这一组钉的是「删得准」,不是「删得多」。
 *
 * 依据是 Gemini v1beta discovery 契约里 Schema 的字段清单。多删的代价是实打实的能力损失:
 * `title` 那条删出过真实损害 —— card-params-schema 把卡片参数展开成 anyOf 分支、
 * 用 title 标明是哪张卡,删了模型就认不出该填哪张卡的参数(见下一条测试)。
 */
test('兼容模式只删 Gemini 真不认的:additionalProperties / $schema / exclusive* 走,title / default / minItems / maxItems 留', () => {
  const src = {
    type: 'object',
    $schema: 'http://json-schema.org/draft-07/schema#',
    additionalProperties: true,
    properties: {
      keep: { type: 'array', title: '要留的', minItems: 1, maxItems: 9, items: { type: 'string', default: 'x' } },
      num: { type: 'number', exclusiveMinimum: 3, exclusiveMaximum: 7 },
      ex: { type: 'string', examples: ['头一个', '第二个'] },
    },
  };
  const out = sanitizeSchema(src, 'gemini', { compat: true });

  // 真不认的:删掉
  assert.equal(out.$schema, undefined, '$schema 不在 Gemini 的 Schema 清单里');
  assert.equal(out.additionalProperties, undefined, 'additionalProperties 是唯一一条硬限制');

  // 认的:必须留下
  assert.equal(out.properties.keep.title, '要留的', 'title 是 Gemini 认的,删了会拆掉 anyOf 分支的卡片标签');
  assert.equal(out.properties.keep.minItems, 1);
  assert.equal(out.properties.keep.maxItems, 9);
  assert.equal(out.properties.keep.items.default, 'x', '嵌套进 items 里的也要留');

  // 没有对应字段的:改写,不是丢掉
  assert.equal(out.properties.num.exclusiveMinimum, undefined);
  assert.equal(out.properties.num.exclusiveMaximum, undefined);
  assert.equal(out.properties.num.minimum, 3, '开区间退成闭区间近似,总好过整条约束消失');
  assert.equal(out.properties.num.maximum, 7);
  assert.equal(out.properties.ex.examples, undefined, '清单里只有单数 example');
  assert.equal(out.properties.ex.example, '头一个');
});

test('兼容模式的 format:Gemini 认的取值留着,不认的才删', () => {
  const src = {
    type: 'object',
    properties: {
      when: { type: 'string', format: 'date-time' },
      f: { type: 'number', format: 'double' },
      link: { type: 'string', format: 'uri' },
      mail: { type: 'string', format: 'email' },
    },
  };
  const out = sanitizeSchema(src, 'gemini', { compat: true });
  assert.equal(out.properties.when.format, 'date-time');
  assert.equal(out.properties.f.format, 'double');
  assert.equal(out.properties.link.format, undefined, 'uri 会被 Gemini 拒,按白名单剔掉');
  assert.equal(out.properties.mail.format, undefined);
});

/**
 * 这一条钉的是那个真实的损害:卡片参数的 anyOf 分支靠 `title: card.id` 标明是哪张卡,
 * 而兼容模式曾经把 title 删了 —— 于是模型面对一堆没有标签的分支,认不出该填哪张卡的参数。
 */
test('卡片参数的 anyOf 分支过完兼容模式,还认得出是哪张卡', () => {
  const cards = [
    { id: 'stat-proof', name: '数字实证', controls: [{ key: 'value', type: 'number' }] },
    { id: 'mu-number-ticker', name: '数字滚动', controls: [{ key: 'label', type: 'text' }] },
  ];
  const schema = buildParamsSchema(cards);
  assert.ok(schema && Array.isArray(schema.anyOf), '前提:展开成了 anyOf 分支');
  const out = sanitizeSchema(schema, 'gemini', { compat: true });
  assert.deepEqual(out.anyOf.map((b) => b.title), ['stat-proof', 'mu-number-ticker']);
});

// ── update_clip 的 params 是增量补丁(线上 2026-10-21:模型带回旧整份参数,把用户刚撤销的颜色写回去) ──
test('update_clip 的工具说明写明 params 是增量补丁:只传要改的键、没传的保持、别凭记忆整份带回', () => {
  const desc = mcpTools.find((t) => t.name === 'update_clip').description;
  assert.match(desc, /params 是增量补丁/);
  assert.match(desc, /只传你这次要改的键/);
  assert.match(desc, /没传的键保持它现在的值/);
  assert.match(desc, /不要凭记忆把以前读到的整份参数带回来/);
  assert.match(desc, /get_clip/, '要知道现在的值怎么办');
  assert.match(desc, /changedParams/, '回包里的哪些键真的变了');
});

test('update_clip.params 的静态 schema 也带着补丁说明,而 add_clip.params 没有', () => {
  const upd = mcpTools.find((t) => t.name === 'update_clip').inputSchema.properties.params;
  assert.match(upd.description, /增量补丁/);
  assert.match(upd.description, /没写的键保持当前值/);
  const add = mcpTools.find((t) => t.name === 'add_clip').inputSchema.properties.params;
  assert.doesNotMatch(add.description ?? '', /增量补丁/);
});

test('注入真实 schema 之后,模型收到的 update_clip.params 仍是补丁说明,且没有 required;add_clip 不变', () => {
  const sent = sentToModel(CARDS);
  const upd = sent.update_clip.properties.params;
  assert.match(upd.description, /增量补丁/);
  assert.match(upd.description, /不要凭记忆把旧的整份参数带回来/);
  for (const branch of upd.anyOf) assert.equal(branch.required, undefined, `${branch.title} 补丁里不该要求必填`);
  const add = sent.add_clip.properties.params;
  assert.doesNotMatch(add.description, /增量补丁/);
  assert.deepEqual(add.anyOf.find((b) => b.title === 'caption-track').required, ['lines'], 'add_clip 仍要传必填');
});

test('补丁版 schema 的字段与完整版一一对应,只是少了 required', () => {
  const full = buildParamsSchema(CARDS);
  const patch = buildParamsSchema(CARDS, { patch: true });
  assert.deepEqual(patch.anyOf.map((b) => [b.title, Object.keys(b.properties)]), full.anyOf.map((b) => [b.title, Object.keys(b.properties)]));
});

test('set_clip 的说明写明 params 段是整份替换,与 update_clip 的补丁区分', () => {
  const desc = mcpTools.find((t) => t.name === 'set_clip').description;
  assert.match(desc, /整份替换/);
  assert.match(desc, /update_clip/);
});
