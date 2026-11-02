/**
 * node --test src/ai/effortOptions.test.mjs
 *
 * The thinking effort tier manifest must match the values accepted by upstream.
 *
 * From a user diagnostic report: they selected `minimal` from codex's dropdown, and the request
 * immediately returned a 400:
 *   Unsupported value: 'minimal' is not supported with the 'gpt-5.6-terra' model.
 *   Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.
 * Both sides were wrong: we supplied `minimal`, which upstream does not accept; upstream accepts
 * `none` and `max`, which we did not provide. Placing an option in the menu that is guaranteed
 * to 400 leaves the user with no way to guess that it is our mistake: so this needs a gatekeeper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CAPABILITIES, EFFORT_LABEL, sanitizeEffort } = await import('./modelOptions.ts');

/** The exact string listed verbatim by upstream codex in the 400 error */
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
    if (cap.efforts.length === 0) continue; // Drivers that support no tiers (entirely grayed out in the UI)
    assert.ok(cap.efforts.includes(''), `The manifest of ${provider} has no "Default"`);
  }
});

test('No driver offers minimal any more', () => {
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    assert.ok(!cap.efforts.includes('minimal'), `${provider} added minimal back again`);
  }
});

/*
 * A separate note on the api tier: it uses `reasoning_effort` per OpenAI compatibility rules,
 * and upstream only accepts low / medium / high (see openlux docs); none of the CLI's extended
 * tiers can be passed.
 */
test('api: only the three tiers recognized by the OpenAI-compatible interface', () => {
  assert.deepEqual(CAPABILITIES.api.efforts.filter(Boolean).sort(), ['high', 'low', 'medium']);
});

/*
 * The block below pins down the **send path**, not the capabilities manifest.
 *
 * Shape caught during review: the manifest was fixed (0ae554b removed minimal from codex), and the
 * panel also downgraded it to display "default": but the request-sending path read the raw value
 * from localStorage, so the UI said "default" while the request still carried minimal, yielding
 * that same 400. Testing only CAPABILITIES is a tautology and cannot catch this.
 */
test("sanitizeEffort: any tier not in the manifest is downgraded to the default: this is how old values in old users' localStorage leaked out", () => {
  // Before 0ae554b, codex's manifest had minimal; now it does not
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "minimal", null), "");
  // Keep items present in the manifest as is
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "high", null), "high");
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "none", null), "none");
  // An empty string is "default" to begin with and is a valid value
  assert.equal(sanitizeEffort("codex", "gpt-5.6-terra", "", null), "");
});

test("sanitizeEffort: agy is grouped by model, and each group has its own manifest", () => {
  const config = { cliModels: { agy: "gemini-3.8-flash-high|gemini-3.8-flash-low|gemini-3.1-pro-high" } };
  // The gemini-3.1-pro group has no medium
  assert.equal(sanitizeEffort("agy", "gemini-3.1-pro", "medium", config), "");
  assert.equal(sanitizeEffort("agy", "gemini-3.1-pro", "high", config), "high");
  assert.equal(sanitizeEffort("agy", "gemini-3.8-flash", "low", config), "low");
});

test("sanitizeEffort: it can also handle garbage values", () => {
  assert.equal(sanitizeEffort("claude", "opus", "Nonexistent tier", null), "");
  assert.equal(sanitizeEffort("claude", "opus", undefined, null), "");
  // Direct API has no xhigh tier. Previously the same call was written on both sides,
  // identically true: equivalent to not testing
  assert.equal(sanitizeEffort("api", "", "xhigh", null), "");
});

test('The first tier of every provider\'s manifest must be the empty string for "Default": the dropdown\'s fallback value depends entirely on it', () => {
  /*
   * ModelBar's tier dropdown falls back to "" when it does not recognize the stored value (see the
   * comment there: better to drop a tier than send a value guaranteed to be rejected). When a
   * controlled select's value is not found in options, selectedIndex becomes -1: **the box displays
   * blank**.
   *
   * In other words, the statement "falling back to \"\" is safe" rests entirely on "every provider's
   * manifest has the \"\" tier". This invariant was previously not guarded anywhere: if someone
   * someday removes the leading empty string from a provider's manifest, a blank dropdown immediately
   * turns from unreachable to reachable, and not a single test will fail.
   */
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    assert.equal(cap.efforts[0], "", `The first tier of ${provider} is not the empty string, so the ModelBar fallback would show blank`);
  }
});
