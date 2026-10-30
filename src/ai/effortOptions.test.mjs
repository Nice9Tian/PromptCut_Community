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

test('codex 的档位是上游那一串的子集,一个多余的都不能有', () => {
  const offered = CAPABILITIES.codex.efforts.filter(Boolean);
  const extra = offered.filter((e) => !CODEX_UPSTREAM.includes(e));
  assert.deepEqual(extra, [], `这些档位上游不认,选中就是 400:${extra.join(', ')}`);
});

test('codex:minimal 一定不在清单里(它就是那次 400 的元凶)', () => {
  assert.ok(!CAPABILITIES.codex.efforts.includes('minimal'));
});

test('codex:上游认的 none 和 max 要给出来 —— 少给等于白丢档位', () => {
  for (const e of ['none', 'max']) {
    assert.ok(CAPABILITIES.codex.efforts.includes(e), `${e} 上游支持,清单里却没有`);
  }
});

test('每一档都要有中文标签,否则下拉框里是空白项', () => {
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    for (const e of cap.efforts) {
      assert.ok(EFFORT_LABEL[e] !== undefined, `${provider} 的档位 ${JSON.stringify(e)} 没有标签`);
    }
  }
});

test('每家的清单都带空串 —— 用户要能选回「默认」', () => {
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    if (cap.efforts.length === 0) continue; // 一档都不支持的驱动(界面上整个灰掉)
    assert.ok(cap.efforts.includes(''), `${provider} 的清单里没有「默认」`);
  }
});

test('minimal 没有任何驱动再提供它', () => {
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    assert.ok(!cap.efforts.includes('minimal'), `${provider} 又把 minimal 加回来了`);
  }
});

/*
 * api 那一档单独说一句:它走 OpenAI 兼容口径的 `reasoning_effort`,
 * 上游只认 low / medium / high(见 openlux 文档),CLI 的扩展档位一个都不能给。
 */
test('api:只给 OpenAI 兼容口径认的三档', () => {
  assert.deepEqual(CAPABILITIES.api.efforts.filter(Boolean).sort(), ['high', 'low', 'medium']);
});

/*
 * 下面这一档钉的是**发送路径**,不是能力清单。
 *
 * 评审抓到的形状:清单改对了(0ae554b 把 codex 的 minimal 去掉),面板也把它降级成
 * 「默认」显示了 —— 但发请求那条路读的是 localStorage 原值,于是界面写着「默认」、
 * 请求里照旧带着 minimal,还是那条 400。只测 CAPABILITIES 是同义反复,抓不到这个。
 */
test("sanitizeEffort:清单里没有的档位一律降级成默认 —— 老用户 localStorage 里的旧值就是这么漏出去的", () => {
  // 0ae554b 之前 codex 的清单里有 minimal,现在没有了
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "minimal", null), "");
  // 清单里有的原样保留
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "high", null), "high");
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "none", null), "none");
  // 空字符串本来就是「默认」,是合法值
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "", null), "");
});

test("sanitizeEffort:agy 按模型分组各有各的清单", () => {
  const config = { cliModels: { agy: "gemini-3.8-flash-high|gemini-3.8-flash-low|gemini-3.1-pro-high" } };
  // gemini-3.1-pro 这一组没有 medium
  assert.equal(sanitizeEffort("agy", "gemini-3.1-pro", "medium", config), "");
  assert.equal(sanitizeEffort("agy", "gemini-3.1-pro", "high", config), "high");
  assert.equal(sanitizeEffort("agy", "gemini-3.8-flash", "low", config), "low");
});

test("sanitizeEffort:乱七八糟的值也收得住", () => {
  assert.equal(sanitizeEffort("claude", "opus", "不存在的档", null), "");
  assert.equal(sanitizeEffort("claude", "opus", undefined, null), "");
  // api 直连没有 xhigh 这一档。原来这里左右写的是同一个调用,恒等成立 —— 等于没测
  assert.equal(sanitizeEffort("api", "", "xhigh", null), "");
});

test('每家清单的第一档必须是「默认」空串 —— 下拉框的兜底值全靠它', () => {
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
    assert.equal(cap.efforts[0], "", `${provider} 的第一档不是空串,ModelBar 的兜底会显示空白`);
  }
});
