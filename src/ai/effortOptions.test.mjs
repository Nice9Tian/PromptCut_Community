/**
 * node --test src/ai/effortOptions.test.mjs
 *
 * 思考档位清单必须和上游认的值一致。
 *
 * 来自一份用户诊断报告:他从 codex 的下拉框里选了 `minimal`,请求直接 400 ——
 *   Unsupported value: 'minimal' is not supported with the 'gpt-5.6-terra' model.
 *   Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.
 * 两头都错了:`minimal` 我们给了、上游不认;`none` 和 `max` 上游认、我们没给。
 * 摆一个必然 400 的选项在菜单里,用户不可能猜到是我们的错 —— 所以这条要有守门人。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CAPABILITIES, EFFORT_LABEL, sanitizeEffort } = await import('./modelOptions.ts');

/** codex 上游在 400 里逐字列出来的那一串 */
const CODEX_UPSTREAM = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

test('The codex tiers are a subset of the upstream list, with not a single extra one', () => {
  const offered = CAPABILITIES.codex.efforts.filter(Boolean);
  const extra = offered.filter((e) => !CODEX_UPSTREAM.includes(e));
  assert.deepEqual(extra, [], `Upstream does not recognize these tiers, and selecting one gives a 400: ${extra.join(', ')}`);
});

test('codex: minimal must not be in the manifest (it was the culprit behind that 400)', () => {
  assert.ok(!CAPABILITIES.codex.efforts.includes('minimal'));
});

test('codex: none and max, which upstream recognizes, must be provided: leaving them out wastes tiers', () => {
  for (const e of ['none', 'max']) {
    assert.ok(CAPABILITIES.codex.efforts.includes(e), `${e} is supported upstream but is not in the manifest`);
  }
});

test('Every tier must have a Chinese label, otherwise the dropdown shows a blank item', () => {
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    for (const e of cap.efforts) {
      assert.ok(EFFORT_LABEL[e] !== undefined, `Tier ${JSON.stringify(e)} of ${provider} has no label`);
    }
  }
});

test('Every provider\'s manifest includes the empty string: the user must be able to select "Default" again', () => {
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    if (cap.efforts.length === 0) continue; // 一档都不支持的驱动(界面上整个灰掉)
    assert.ok(cap.efforts.includes(''), `The manifest of ${provider} has no "Default"`);
  }
});

test('No driver offers minimal any more', () => {
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    assert.ok(!cap.efforts.includes('minimal'), `${provider} added minimal back again`);
  }
});

/*
 * api 那一档单独说一句:它走 OpenAI 兼容口径的 `reasoning_effort`,
 * 上游只认 low / medium / high(见 openlux 文档),CLI 的扩展档位一个都不能给。
 */
test('api: only the three tiers recognized by the OpenAI-compatible interface', () => {
  assert.deepEqual(CAPABILITIES.api.efforts.filter(Boolean).sort(), ['high', 'low', 'medium']);
});

/*
 * 下面这一档钉的是**发送路径**,不是能力清单。
 *
 * 评审抓到的形状:清单改对了(0ae554b 把 codex 的 minimal 去掉),面板也把它降级成
 * 「默认」显示了 —— 但发请求那条路读的是 localStorage 原值,于是界面写着「默认」、
 * 请求里照旧带着 minimal,还是那条 400。只测 CAPABILITIES 是同义反复,抓不到这个。
 */
test("sanitizeEffort: any tier not in the manifest is downgraded to the default: this is how old values in old users' localStorage leaked out", () => {
  // 0ae554b 之前 codex 的清单里有 minimal,现在没有了
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "minimal", null), "");
  // 清单里有的原样保留
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "high", null), "high");
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "none", null), "none");
  // 空字符串本来就是「默认」,是合法值
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "", null), "");
});

test("sanitizeEffort: agy is grouped by model, and each group has its own manifest", () => {
  const config = { cliModels: { agy: "gemini-3.8-flash-high|gemini-3.8-flash-low|gemini-3.1-pro-high" } };
  // gemini-3.1-pro 这一组没有 medium
  assert.equal(sanitizeEffort("agy", "gemini-3.1-pro", "medium", config), "");
  assert.equal(sanitizeEffort("agy", "gemini-3.1-pro", "high", config), "high");
  assert.equal(sanitizeEffort("agy", "gemini-3.8-flash", "low", config), "low");
});

test("sanitizeEffort: it can also handle garbage values", () => {
  assert.equal(sanitizeEffort("claude", "opus", "Nonexistent tier", null), "");
  assert.equal(sanitizeEffort("claude", "opus", undefined, null), "");
  // api 直连没有 xhigh 这一档。原来这里左右写的是同一个调用,恒等成立 —— 等于没测
  assert.equal(sanitizeEffort("api", "", "xhigh", null), "");
});

test('The first tier of every provider\'s manifest must be the empty string for "Default": the dropdown\'s fallback value depends entirely on it', () => {
  /*
   * ModelBar 的档位下拉框在认不出存着的值时兜底成 ""(见那边的注释:宁可少一档,
   * 也不发一个必然被拒的值)。而受控 select 的 value 在 options 里找不到时
   * selectedIndex 会变成 -1 —— **框里显示空白**。
   *
   * 也就是说「兜底成 "" 是安全的」这句话,完全建立在「每家清单里都有 "" 这一档」
   * 上面。这条不变量以前没有任何地方守着:哪天有人从某家清单里删掉开头那个空串,
   * 空白下拉框就立刻从不可达变成可达,而且没有一条测试会红。
   */
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    assert.equal(cap.efforts[0], "", `The first tier of ${provider} is not the empty string, so the ModelBar fallback would show blank`);
  }
});
