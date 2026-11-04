/**
 * "The model name sent out" must match "the one displayed on the panel".
 * Run: node --test src/ai/modelPicked.test.mjs
 *
 * Pins down an actual incident: agy received `gemini-3.8.flash` (the correct form is
 * `gemini-3.8-flash-low`) and exited on the spot. Meanwhile, the model selector on the panel
 * displayed "default": because ModelBar filtered it through normalizeModel, but the request-sending
 * path used the raw localStorage value directly. The two sides computed different values; everything
 * looked normal to the user, except they would never get a reply.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { modelsFor, normalizeModel } from "./modelOptions.ts";

const cfg = {
  api: { model: "gpt-4o|gpt-4o-mini" },
  cliModels: { claude: "opus|sonnet", codex: "gpt-5.6-terra", agy: "gemini-3.8-flash-low|gemini-3.1-pro-high" },
};

test("Where the model list comes from: api reads api.model, each of the three CLIs reads its own entry", () => {
  assert.deepEqual(modelsFor("api", cfg), ["gpt-4o", "gpt-4o-mini"]);
  assert.deepEqual(modelsFor("claude", cfg), ["opus", "sonnet"]);
  // agy encodes tiers in names, while the panel lists base names (see pairing rules in agyEffort.test.mjs)
  assert.deepEqual(modelsFor("agy", cfg), ["gemini-3.8-flash", "gemini-3.1-pro"]);
});

test("No model list configured, or no config at all: an empty array, not a throw", () => {
  assert.deepEqual(modelsFor("agy", null), []);
  assert.deepEqual(modelsFor("agy", { cliModels: {} }), []);
  assert.deepEqual(modelsFor("api", {}), []);
});

test("Any name not in the model list always falls back to \"Default\": the dotted spelling from the incident must be caught here", () => {
  const models = modelsFor("agy", cfg);
  assert.equal(normalizeModel("gemini-3.8.flash", models), "", "One mistyped character means it must not be sent");
  // The manifest is folded into base names, so base names match; older forms with suffixes are
  // folded back first by pairModelEffort
  assert.equal(normalizeModel("gemini-3.8-flash", models), "gemini-3.8-flash");
});

test("When the model list is empty, any stored old name must fall back to \"Default\"", () => {
  // The user cleared agy's model manifest in settings, but localStorage still retains
  // the previously selected name
  assert.equal(normalizeModel("gemini-3.8-flash-low", modelsFor("agy", { cliModels: { agy: "" } })), "");
});

test("After the driver is switched, the previous provider's model name does not carry over", () => {
  // Selections are recorded separately per provider, but manifests must also be per-provider:
  // looking up a claude name in agy's manifest cannot find it
  assert.equal(normalizeModel("opus", modelsFor("agy", cfg)), "");
  assert.equal(normalizeModel("gemini-3.8-flash-low", modelsFor("claude", cfg)), "");
  assert.equal(normalizeModel("gpt-4o", modelsFor("codex", cfg)), "");
});
