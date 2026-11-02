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
      { key: 'lines', label: 'Captions', type: 'text', required: true, hint: 'One per line' },
      { key: 'showEn', label: 'Show English', type: 'select', options: [{ value: 'true' }, { value: 'false' }] },
      { key: 'strokeW', label: 'Stroke width', type: 'number' },
    ],
  },
  {
    id: 'odometer',
    controls: [
      { key: 'value', label: 'Value', type: 'number' },
      { key: 'unit', label: 'Unit', type: 'text' },
    ],
  },
];

// ── sanitizeSchema:自由对象不能被改写成「没有字段」 ──────────────
test('Nested free-form objects stay free-form and are no longer forced into properties: {}', () => {
  const out = sanitizeSchema({ type: 'object', properties: { blob: { type: 'object' } } }, 'openai');
  assert.notDeepEqual(out.properties.blob.properties, {}, 'An empty properties tells the model "there are no fields to fill in"');
  assert.equal(out.properties.blob.additionalProperties, true);
});

test('A tool with no parameters still has properties: {} at the top level', () => {
  const out = sanitizeSchema({ type: 'object', properties: {} }, 'openai');
  assert.deepEqual(out.properties, {}, '"This tool takes no parameters" really means there are no fields, so it must not be changed');
});

test('anyOf branches are sanitized too', () => {
  const out = sanitizeSchema(
    { type: 'object', properties: { p: { type: 'object', anyOf: [{ type: 'object', properties: { free: { type: 'object' } } }] } } },
    'openai',
  );
  assert.equal(out.properties.p.anyOf[0].properties.free.additionalProperties, true);
});

test('gemini does not support additionalProperties, so it falls back to an empty object instead of leaving an invalid field', () => {
  const out = sanitizeSchema({ type: 'object', properties: { blob: { type: 'object' } } }, 'gemini');
  assert.equal(out.properties.blob.additionalProperties, undefined);
  assert.deepEqual(out.properties.blob.properties, {});
});

// ── buildParamsSchema:每张卡的真实字段 ───────────────────────────
test('One branch per card, with matching field names and types', () => {
  const schema = buildParamsSchema(CARDS);
  const caption = schema.anyOf.find((b) => b.title === 'caption-track');
  assert.ok(caption, 'The branch must be findable by cardId');
  assert.equal(caption.properties.lines.type, 'string');
  assert.equal(caption.properties.strokeW.type, 'number');
  assert.deepEqual(caption.properties.showEn.enum, ['true', 'false']);
  assert.deepEqual(caption.required, ['lines'], 'Required fields must be passed to the model, otherwise it does not know they are mandatory');
  assert.match(caption.properties.lines.description, /One per line/, 'The hint must be passed through');
});

test('Parameters just added to a card can be passed too: every branch allows extra fields', () => {
  assert.equal(buildParamsSchema(CARDS).anyOf[0].additionalProperties, true);
});

test('Returns null when the cards cannot be obtained, and the caller falls back to a free-form object', () => {
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

test('After injection, the model can see the lines field in add_clip', () => {
  const params = sentToModel(CARDS).add_clip.properties.params;
  assert.ok(Array.isArray(params.anyOf), 'Should be a union type branched by cardId');
  const caption = params.anyOf.find((b) => b.title === 'caption-track');
  assert.ok('lines' in caption.properties, 'This is exactly the parameter that could not be passed before');
});

test('update_clip is injected the same way', () => {
  const params = sentToModel(CARDS).update_clip.properties.params;
  assert.ok(params.anyOf.some((b) => b.title === 'odometer'));
});

test('Regression: without injection, params is no longer "an object with no fields"', () => {
  // 就算注入失败,也不能再退化成 properties:{} —— 那是模型交不出参数的根因
  const params = sentToModel(null).add_clip.properties.params;
  assert.notDeepEqual(params.properties, {}, 'An empty properties would let the model submit only {}');
  assert.equal(params.additionalProperties, true);
});

test('Injection does not pollute the shared mcpTools constant', () => {
  sentToModel(CARDS);
  const raw = mcpTools.find((t) => t.name === 'add_clip');
  assert.equal(raw.inputSchema.properties.params.anyOf, undefined, 'mcpTools is shared at module level and must not be modified in place');
});

// ── 三处声明必须对齐 ──────────────────────────────────────────────────
// 一个工具要能被调用，得同时出现在三个地方：mcp-tools.mjs 的声明、mcpExecutor 的
// 分发、EditorApi 的实现。缺哪一处都是「模型看得见但调不动」，而且只在模型真的
// 去调的时候才暴露 —— 那时候一次任务已经跑废了。
// 一对一转发的那一百来个工具现在走 src/mcp/routes.mjs 的路由表,不再是逐个 tool === 分支;
// 对账的细账在 server/test/mcp-routes.test.mjs,这里只守「声明了就得有地方接住」。
test('Every browser tool in mcp-tools has a matching dispatch branch in the executor', () => {
  const src = readFileSync(new URL('../../src/ai/mcpExecutor.ts', import.meta.url), 'utf8');
  // web_* 走的是前缀分发 + runWebTool 里的 switch，不是逐个 tool === 分支。守卫的意思没变：
  // 声明了就必须真有地方接住，所以这里也认 case "web_x": 这种形式。
  const missing = mcpTools
    .filter((t) => t.side === 'page' || t.side === 'agent')
    .map((t) => t.name)
    .filter((n) => !(n in TOOL_ROUTES) && !src.includes(`tool === "${n}"`) && !src.includes(`case "${n}":`));
  assert.deepEqual(missing, [], `Tools with no branch in the executor: ${missing.join(', ')}`);
});

test('Every tool name dispatched by the executor is actually declared in mcp-tools', () => {
  const src = readFileSync(new URL('../../src/ai/mcpExecutor.ts', import.meta.url), 'utf8');
  const declared = new Set(mcpTools.map((t) => t.name));
  const dispatched = [
    ...Object.keys(TOOL_ROUTES),
    ...[...src.matchAll(/tool === "([a-z_]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/case "(web_[a-z_]+)":/g)].map((m) => m[1]),
  ];
  // 页面执行器里网页接管按旧的内部操作名分支(case "web_handoff"),进门先换成新名(server/tools/ui-names.mjs):认它对应的新名
  const orphans = dispatched.filter((n) => !declared.has(n) && !declared.has(modelToolName(n)));
  assert.deepEqual(orphans, [], `Tools dispatched by the executor but not declared: ${orphans.join(', ')}`);
});

// 放宽超时的名单要**逐个**是有意加的:桥的超时一旦先到,真正的报错信息就被盖掉,
// Agent 只看得到「超时」两个字。所以这里钉死名单,加新的必须改这一行。
// 三个都要当场起一个 Chrome 渲染(vite-plugin-vision):see_frames 渲单帧(timeline)或一整张拼图(media),
// get_gif 一趟渲 8 帧再编动图,bake_card 渲单帧。
// 第四个是自定义测量 measure_audio_js(计划 A6):解码(最多 30 秒)+ 起沙箱 Chrome + 代码(最多 30 秒)+ 看门狗余量,超过桥缺省的 60 秒。
test('Render, custom measurement and sound effect generation tools with relaxed timeouts have an explicit budget', async () => {
  const withTimeout = mcpTools.filter((t) => t.timeoutMs);
  // 只钉名单,不钉顺序:工具表按领域拆进 server/tools/ 之后,先后次序由聚合顺序决定,没有含义
  assert.deepEqual(withTimeout.map((t) => t.name).sort(), ['bake_card', 'get_gif', 'measure_audio_js', 'render_card_audio', 'see_frames', 'sound_generate']);
  for (const t of withTimeout.filter((x) => !['measure_audio_js', 'sound_generate', 'render_card_audio'].includes(x.name))) assert.ok(t.timeoutMs > 120000, `${t.name} must be greater than the 120-second render limit in vite-plugin-vision`);
  assert.ok(withTimeout.find(t => t.name === 'sound_generate').timeoutMs >= 120000, 'The sound effect tool waits for Worker synthesis and asset ingestion, keeping a 120-second budget');
  assert.ok(withTimeout.find(t => t.name === 'render_card_audio').timeoutMs >= 120000, 'Audio-visual card sound waits for chunked generation and asset ingestion, keeping a 120-second budget');
  const { PCM_LIMITS } = await import('../audio-pcm.mjs');
  const { SANDBOX_LIMITS } = await import('../audio-sandbox.mjs');
  const js = withTimeout.find((x) => x.name === 'measure_audio_js');
  assert.ok(js.timeoutMs > PCM_LIMITS.decodeTimeoutMs + SANDBOX_LIMITS.maxTimeoutMs + SANDBOX_LIMITS.graceMs + 15000, 'measure_audio_js must exceed decoding + code time limit + watchdog margin + Chrome launch');
});

// ── 枚举值必须是字符串 ─────────────────────────────────────────────
// 诊断报告里抓到的真失败:collect_probe 的 quality 写了数字枚举 [2160, 1440, …],
// Gemini 的 OpenAI 兼容接口回 400「enum[0] (TYPE_STRING), 2160」,整个请求被拒,
// agent 一个工具都调不了。取值范围写进 description,服务端用白名单兜底。
test('All tools\' enum values are strings (Gemini accepts only string enums)', () => {
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
  assert.deepEqual(bad, [], 'Numeric / boolean enums make Gemini reject the entire request outright');
});

test('All types are single strings (Gemini does not accept array types, and sanitizeSchema does not flatten them either)', () => {
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
  { id: 'text-title', controls: [{ key: 'text', label: 'Title', type: 'text', required: true }, { key: 'size', label: 'Font size', type: 'number' }] },
  { id: 'list-pins', controls: [{ key: 'items', label: 'Key points', type: 'text' }] },
];
test('injectPartParams touches only part tools; injectCardParams no longer clobbers add_part\'s params', () => {
  const tools = JSON.parse(JSON.stringify(mcpTools));
  injectCardParams(tools, [{ id: 'x', controls: [{ key: 'foo', label: 'f', type: 'text' }] }]);
  const addPart = tools.find((t) => t.name === 'add_part');
  assert.equal(addPart.inputSchema.properties.params.anyOf, undefined, 'The card schema must not be injected into add_part');
  injectPartParams(tools, PARTS);
  assert.equal(addPart.inputSchema.properties.params.anyOf.length, 2);
  assert.deepEqual(addPart.inputSchema.properties.params.anyOf[0].required, ['text']);
  assert.equal(tools.find((t) => t.name === 'set_part').inputSchema.properties.params.anyOf[1].title, 'list-pins');
  const parts = tools.find((t) => t.name === 'add_composite').inputSchema.properties.parts;
  assert.equal(parts.type, 'array');
  assert.deepEqual(parts.items.properties.partId.enum, ['text-title', 'list-pins']);
  assert.equal(parts.items.properties.children.items.properties.children.items.properties.children, undefined, 'At most three levels');
  assert.equal(tools.find((t) => t.name === 'add_clip').inputSchema.properties.params.anyOf[0].title, 'x', 'Card tools still get the card schema');
  assert.equal(buildPartParamsSchema([]), null);
});

test('sanitizeSchema: compat and vendor are decoupled: openai can also be sanitized to the Gemini subset, and gemini can also turn it off', () => {
  const schema = { type: 'object', properties: { params: { type: 'object' }, n: { type: 'number', default: 1 } }, additionalProperties: true };
  const openaiCompat = sanitizeSchema(schema, 'openai', { compat: true });
  assert.equal(openaiCompat.additionalProperties, undefined);
  assert.deepEqual(openaiCompat.properties.params, { type: 'object', properties: {} });
  // default 是 Gemini 认的字段,兼容模式**不该**删它(以前删了,是过度设限)
  assert.equal(openaiCompat.properties.n.default, 1);
  const openaiPlain = sanitizeSchema(schema, 'openai');
  assert.equal(openaiPlain.properties.params.additionalProperties, true);
  assert.equal(sanitizeSchema(schema, 'gemini').properties.params.additionalProperties, undefined, 'gemini is compat by default');
  assert.equal(sanitizeSchema(schema, 'gemini', { compat: false }).properties.params.additionalProperties, true);
});

/**
 * 兼容模式到底该删什么 —— 这一组钉的是「删得准」,不是「删得多」。
 *
 * 依据是 Gemini v1beta discovery 契约里 Schema 的字段清单。多删的代价是实打实的能力损失:
 * `title` 那条删出过真实损害 —— card-params-schema 把卡片参数展开成 anyOf 分支、
 * 用 title 标明是哪张卡,删了模型就认不出该填哪张卡的参数(见下一条测试)。
 */
test('Compat mode removes only what Gemini truly does not accept: additionalProperties / $schema / exclusive* go, title / default / minItems / maxItems stay', () => {
  const src = {
    type: 'object',
    $schema: 'http://json-schema.org/draft-07/schema#',
    additionalProperties: true,
    properties: {
      keep: { type: 'array', title: 'To keep', minItems: 1, maxItems: 9, items: { type: 'string', default: 'x' } },
      num: { type: 'number', exclusiveMinimum: 3, exclusiveMaximum: 7 },
      ex: { type: 'string', examples: ['First one', 'Second one'] },
    },
  };
  const out = sanitizeSchema(src, 'gemini', { compat: true });

  // 真不认的:删掉
  assert.equal(out.$schema, undefined, '$schema is not in Gemini\'s Schema list');
  assert.equal(out.additionalProperties, undefined, 'additionalProperties is the only hard restriction');

  // 认的:必须留下
  assert.equal(out.properties.keep.title, 'To keep', 'title is accepted by Gemini, and removing it would strip the card labels from the anyOf branches');
  assert.equal(out.properties.keep.minItems, 1);
  assert.equal(out.properties.keep.maxItems, 9);
  assert.equal(out.properties.keep.items.default, 'x', 'Those nested inside items must be kept too');

  // 没有对应字段的:改写,不是丢掉
  assert.equal(out.properties.num.exclusiveMinimum, undefined);
  assert.equal(out.properties.num.exclusiveMaximum, undefined);
  assert.equal(out.properties.num.minimum, 3, 'An open interval degrades to a closed-interval approximation, which beats losing the whole constraint');
  assert.equal(out.properties.num.maximum, 7);
  assert.equal(out.properties.ex.examples, undefined, 'The list has only the singular example');
  assert.equal(out.properties.ex.example, 'First one');
});

test('Compat mode format: values Gemini accepts are kept, and only those it does not accept are removed', () => {
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
  assert.equal(out.properties.link.format, undefined, 'uri would be rejected by Gemini, so it is removed per the allowlist');
  assert.equal(out.properties.mail.format, undefined);
});

/**
 * 这一条钉的是那个真实的损害:卡片参数的 anyOf 分支靠 `title: card.id` 标明是哪张卡,
 * 而兼容模式曾经把 title 删了 —— 于是模型面对一堆没有标签的分支,认不出该填哪张卡的参数。
 */
test('Card-parameter anyOf branches that have been through compat mode can still be identified by card', () => {
  const cards = [
    { id: 'stat-proof', name: 'Stat proof', controls: [{ key: 'value', type: 'number' }] },
    { id: 'mu-number-ticker', name: 'Number ticker', controls: [{ key: 'label', type: 'text' }] },
  ];
  const schema = buildParamsSchema(cards);
  assert.ok(schema && Array.isArray(schema.anyOf), 'Precondition: expanded into anyOf branches');
  const out = sanitizeSchema(schema, 'gemini', { compat: true });
  assert.deepEqual(out.anyOf.map((b) => b.title), ['stat-proof', 'mu-number-ticker']);
});

// ── update_clip 的 params 是增量补丁(线上 2026-10-21:模型带回旧整份参数,把用户刚撤销的颜色写回去) ──
test('The update_clip tool description states that params is an incremental patch: pass only the keys to change, keys not passed stay as they are, do not bring the full set back from memory', () => {
  const desc = mcpTools.find((t) => t.name === 'update_clip').description;
  assert.match(desc, /params is an incremental patch/);
  assert.match(desc, /pass only the keys you want to change this time/);
  assert.match(desc, /keys not passed keep their current value/);
  assert.match(desc, /do not bring the full parameter set you read earlier back from memory/);
  assert.match(desc, /get_clip/, 'What to do if you need to know the current value');
  assert.match(desc, /changedParams/, 'Which keys in the response actually changed');
});

test('The static schema of update_clip.params also carries the patch description, while add_clip.params does not', () => {
  const upd = mcpTools.find((t) => t.name === 'update_clip').inputSchema.properties.params;
  assert.match(upd.description, /incremental patch/);
  assert.match(upd.description, /keys left out keep the current value/);
  const add = mcpTools.find((t) => t.name === 'add_clip').inputSchema.properties.params;
  assert.doesNotMatch(add.description ?? '', /incremental patch/);
});

test('After the real schema is injected, the update_clip.params the model receives is still the patch description with no required; add_clip is unchanged', () => {
  const sent = sentToModel(CARDS);
  const upd = sent.update_clip.properties.params;
  assert.match(upd.description, /incremental patch/);
  assert.match(upd.description, /do not bring the old full parameter set back from memory/);
  for (const branch of upd.anyOf) assert.equal(branch.required, undefined, `${branch.title}: a patch must not require any field`);
  const add = sent.add_clip.properties.params;
  assert.doesNotMatch(add.description, /incremental patch/);
  assert.deepEqual(add.anyOf.find((b) => b.title === 'caption-track').required, ['lines'], 'add_clip still requires the required fields');
});

test('The patch-version schema\'s fields correspond one-to-one with the full version\'s, only without required', () => {
  const full = buildParamsSchema(CARDS);
  const patch = buildParamsSchema(CARDS, { patch: true });
  assert.deepEqual(patch.anyOf.map((b) => [b.title, Object.keys(b.properties)]), full.anyOf.map((b) => [b.title, Object.keys(b.properties)]));
});

test('The set_clip description states that the params section is a full replacement, as distinct from update_clip\'s patch', () => {
  const desc = mcpTools.find((t) => t.name === 'set_clip').description;
  assert.match(desc, /full replacement/);
  assert.match(desc, /update_clip/);
});
