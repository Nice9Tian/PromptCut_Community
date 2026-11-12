// What the tool schema looks like when delivered to the model.
// This guards against a real failure that actually occurred: add_clip's params was normalized into
// { type:"object", properties:{} }, meaning "this object has no fields", so the model could not
// pass any card parameters at all, and created cards always had params: {}.
// Run: node --test server/test/tool-schema.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolToVendor, sanitizeSchema } from '../harness/schema.mjs';
import { tools as mcpTools } from '../mcp-tools.mjs';
import { TOOL_ROUTES } from '../../src/mcp/routes.mjs';
import { modelToolName } from '../tools/ui-names.mjs';
import { buildParamsSchema, injectCardParams, injectPartParams, buildPartParamsSchema } from '../card-params-schema.mjs';

/** Two cards with different shapes, sufficient to cover text / number / select / required */
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

// ── sanitizeSchema: free-form objects cannot be rewritten into "no fields" ──────
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

// ── buildParamsSchema: real fields of each card ─────────────────────────────────
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

// ── End-to-end: add_clip ultimately received by the model ───────────────────────
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
  // Even if injection fails, do not regress to properties:{}: that is the root cause
  // of the model failing to supply parameters
  const params = sentToModel(null).add_clip.properties.params;
  assert.notDeepEqual(params.properties, {}, 'An empty properties would let the model submit only {}');
  assert.equal(params.additionalProperties, true);
});

test('Injection does not pollute the shared mcpTools constant', () => {
  sentToModel(CARDS);
  const raw = mcpTools.find((t) => t.name === 'add_clip');
  assert.equal(raw.inputSchema.properties.params.anyOf, undefined, 'mcpTools is shared at module level and must not be modified in place');
});

// ── Declarations in three places must be aligned ───────────────────────
// For a tool to be callable, it must appear in three places simultaneously: the declaration in
// mcp-tools.mjs, dispatch in mcpExecutor, and implementation in EditorApi. Missing any one means
// "the model sees it but cannot invoke it", which only surfaces when the model actually tries to
// call it: by then a task run is already wasted.
// The hundred-odd one-to-one forwarded tools now go through the route table in src/mcp/routes.mjs
// instead of individual tool === branches; detailed reconciliation is in
// server/test/mcp-routes.test.mjs; here we only guard "if declared, somewhere must handle it".
test('Every browser tool in mcp-tools has a matching dispatch branch in the executor', () => {
  const src = readFileSync(new URL('../../src/ai/mcpExecutor.ts', import.meta.url), 'utf8');
  // web_* uses prefix dispatch + switch in runWebTool, not individual tool === branches.
  // The guard's intent is unchanged: if declared, somewhere must genuinely handle it, so
  // case "web_x": is also accepted.
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
  // In page executor, web handoff branches on old internal operation name (case "web_handoff"),
  // translated to new name on entry (server/tools/ui-names.mjs): recognize its corresponding new name
  const orphans = dispatched.filter((n) => !declared.has(n) && !declared.has(modelToolName(n)));
  assert.deepEqual(orphans, [], `Tools dispatched by the executor but not declared: ${orphans.join(', ')}`);
});

// Making the list of relaxed timeouts **item-by-item** is intentional: if the bridge timeout hits
// first, the real error message is masked and the Agent only sees "timeout". So the list is pinned
// down here; adding a new one requires editing this line.
// Three of them must spin up a Chrome render on the spot (vite-plugin-vision): see_frames renders
// a single frame (timeline) or a full sheet (media), get_gif renders 8 frames in one pass and
// encodes an animated GIF, and bake_card renders a single frame.
// The fourth is custom measurement measure_audio_js (Plan A6): decoding (up to 30s) + launching
// sandboxed Chrome + code (up to 30s) + watchdog margin, which exceeds the bridge default of 60s.
test('Render, custom measurement and sound effect generation tools with relaxed timeouts have an explicit budget', async () => {
  const withTimeout = mcpTools.filter((t) => t.timeoutMs);
  // Pin only the list, not the order: after tool tables were split by domain into server/tools/,
  // the sequence is determined by aggregation order and has no semantic meaning
  assert.deepEqual(withTimeout.map((t) => t.name).sort(), ['bake_card', 'get_gif', 'measure_audio_js', 'prerender_cut_to_2d', 'render_card_audio', 'see_frames', 'sound_generate']);
  for (const t of withTimeout.filter((x) => !['measure_audio_js', 'sound_generate', 'render_card_audio'].includes(x.name))) assert.ok(t.timeoutMs > 120000, `${t.name} must be greater than the 120-second render limit in vite-plugin-vision`);
  assert.ok(withTimeout.find(t => t.name === 'sound_generate').timeoutMs >= 120000, 'The sound effect tool waits for Worker synthesis and asset ingestion, keeping a 120-second budget');
  assert.ok(withTimeout.find(t => t.name === 'render_card_audio').timeoutMs >= 120000, 'Audio-visual card sound waits for chunked generation and asset ingestion, keeping a 120-second budget');
  const { PCM_LIMITS } = await import('../audio-pcm.mjs');
  const { SANDBOX_LIMITS } = await import('../audio-sandbox.mjs');
  const js = withTimeout.find((x) => x.name === 'measure_audio_js');
  assert.ok(js.timeoutMs > PCM_LIMITS.decodeTimeoutMs + SANDBOX_LIMITS.maxTimeoutMs + SANDBOX_LIMITS.graceMs + 15000, 'measure_audio_js must exceed decoding + code time limit + watchdog margin + Chrome launch');
});

// ── Enum values must be strings ────────────────────────────────────────
// Real failure captured in a diagnostic report: collect_probe had quality written as numeric
// enum [2160, 1440, …]; Gemini's OpenAI-compatible endpoint returned 400 "enum[0] (TYPE_STRING), 2160",
// rejecting the entire request and preventing the agent from calling any tools. The allowed values
// are placed in description, and the server falls back to an allowlist.
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

// ── Parts: params of add_part / set_part and parts of add_composite ────────────
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
  // default is a field recognized by Gemini; compatibility mode should **not** delete it
  // (previously deleted, which was overly restrictive)
  assert.equal(openaiCompat.properties.n.default, 1);
  const openaiPlain = sanitizeSchema(schema, 'openai');
  assert.equal(openaiPlain.properties.params.additionalProperties, true);
  assert.equal(sanitizeSchema(schema, 'gemini').properties.params.additionalProperties, undefined, 'gemini is compat by default');
  assert.equal(sanitizeSchema(schema, 'gemini', { compat: false }).properties.params.additionalProperties, true);
});

/**
 * What compatibility mode should actually delete: this group pins down "deleting accurately",
 * not "deleting aggressively".
 *
 * The reference is the Schema field list in the Gemini v1beta discovery contract. The cost of
 * over-deletion is genuine capability loss: deleting `title` caused real harm: card-params-schema
 * expanded card parameters into anyOf branches using title to indicate which card it was; deleting
 * it prevented the model from recognizing which card's parameters to fill (see next test).
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

  // Truly unsupported: delete
  assert.equal(out.$schema, undefined, '$schema is not in Gemini\'s Schema list');
  assert.equal(out.additionalProperties, undefined, 'additionalProperties is the only hard restriction');

  // Supported: must keep
  assert.equal(out.properties.keep.title, 'To keep', 'title is accepted by Gemini, and removing it would strip the card labels from the anyOf branches');
  assert.equal(out.properties.keep.minItems, 1);
  assert.equal(out.properties.keep.maxItems, 9);
  assert.equal(out.properties.keep.items.default, 'x', 'Those nested inside items must be kept too');

  // Without matching fields: rewrite, do not discard
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
 * This pins down that real-world harm: anyOf branches of card parameters rely on `title: card.id`
 * to indicate which card it is, but compatibility mode previously deleted title: leaving the model
 * facing a bunch of unlabeled branches unable to tell which card's parameters to fill.
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

// ── update_clip params is a delta patch (production 2026-10-21: model returned full old
// parameters, writing back the color the user just reverted) ──
test('The update_clip tool description states that params is an incremental patch: pass only the keys to change, keys not passed stay as they are, do not bring the full set back from memory', () => {
  const desc = mcpTools.find((t) => t.name === 'update_clip').description;
  assert.match(desc, /params is an incremental patch/);
  assert.match(desc, /pass only the keys you are changing this time/);
  assert.match(desc, /keys you omit keep their current values/);
  assert.match(desc, /do not bring back a whole params object from memory of an earlier read/);
  assert.match(desc, /get_clip/, 'What to do if you need to know the current value');
  assert.match(desc, /changedParams/, 'Which keys in the response actually changed');
});

test('The static schema of update_clip.params also carries the patch description, while add_clip.params does not', () => {
  const upd = mcpTools.find((t) => t.name === 'update_clip').inputSchema.properties.params;
  assert.match(upd.description, /Incremental patch/);
  assert.match(upd.description, /keys not written keep their current values/);
  const add = mcpTools.find((t) => t.name === 'add_clip').inputSchema.properties.params;
  assert.doesNotMatch(add.description ?? '', /Incremental patch/i);
});

test('After the real schema is injected, the update_clip.params the model receives is still the patch description with no required; add_clip is unchanged', () => {
  const sent = sentToModel(CARDS);
  const upd = sent.update_clip.properties.params;
  assert.match(upd.description, /Incremental patch/);
  assert.match(upd.description, /do not bring back the whole old set of parameters from memory/);
  for (const branch of upd.anyOf) assert.equal(branch.required, undefined, `${branch.title}: a patch must not require any field`);
  const add = sent.add_clip.properties.params;
  assert.doesNotMatch(add.description, /Incremental patch/i);
  assert.deepEqual(add.anyOf.find((b) => b.title === 'caption-track').required, ['lines'], 'add_clip still requires the required fields');
});

test('The patch-version schema\'s fields correspond one-to-one with the full version\'s, only without required', () => {
  const full = buildParamsSchema(CARDS);
  const patch = buildParamsSchema(CARDS, { patch: true });
  assert.deepEqual(patch.anyOf.map((b) => [b.title, Object.keys(b.properties)]), full.anyOf.map((b) => [b.title, Object.keys(b.properties)]));
});

test('The set_clip description states that the params section is a full replacement, as distinct from update_clip\'s patch', () => {
  const desc = mcpTools.find((t) => t.name === 'set_clip').description;
  assert.match(desc, /whole replacement/);
  assert.match(desc, /update_clip/);
});
