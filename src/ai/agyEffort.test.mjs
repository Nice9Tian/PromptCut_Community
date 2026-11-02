/**
 * agy "model name + effort tier" pairing. Run: node --test src/ai/agyEffort.test.mjs
 *
 * agy encodes the tier in the model name (gemini-3.8-flash-low) while also accepting --effort;
 * the two must match, and if they do not match, it rejects the entire round on the spot. The rules
 * below were tested one by one against the real CLI:
 *
 *   --model gemini-3.8-flash-low --effort low    ✓
 *   --model gemini-3.8-flash-low --effort high   ✗ invalid model selection
 *   --model gemini-3.8-flash     --effort low    ✓ base name + tier, equivalent to the first rule
 *   --model gemini-3.8-flash                     ✗ requires --effort (available: low, medium, high)
 *   --model gemini-3.1-pro       --effort medium ✗ has no "medium" effort (available: low, high)
 *   --model claude-sonnet-4-6    --effort low    ✗ --effort is not supported for this model
 *
 * The last two are key: **tiers are calculated per model**, not a fixed table.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { agyGroups, modelsFor, effortsFor, pairModelEffort } from "./modelOptions.ts";

/** Tailored to the real output of `agy models` on this machine */
const AGY_LIST = [
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
  "gemini-3.1-pro-high", "gemini-3.1-pro-low",
  "claude-sonnet-4-6", "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
].join("|");
const cfg = { cliModels: { agy: AGY_LIST } };

test("Names with a tier suffix are folded into one model, and the tiers are enumerated", () => {
  assert.deepEqual(agyGroups(AGY_LIST.split("|")), [
    { base: "gemini-3.8-flash", efforts: ["low", "medium", "high"] },
    // There is no medium in the manifest: cannot force in a tier that agy will reject
    { base: "gemini-3.1-pro", efforts: ["low", "high"] },
    { base: "claude-sonnet-4-6", efforts: [] },
    // -thinking is not a tier suffix and must not be stripped as a tier
    { base: "claude-opus-4-6-thinking", efforts: [] },
    { base: "gpt-oss-120b", efforts: ["medium"] },
  ]);
});

test("The model dropdown on the panel lists base names, no longer one row per tier", () => {
  assert.deepEqual(modelsFor("agy", cfg), [
    "gemini-3.8-flash", "gemini-3.1-pro", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b",
  ]);
  // Other providers are unaffected
  assert.deepEqual(modelsFor("claude", { cliModels: { claude: "opus|sonnet" } }), ["opus", "sonnet"]);
});

test("The thinking dropdown gives tiers per model, not one fixed table", () => {
  assert.deepEqual(effortsFor("agy", "gemini-3.8-flash", cfg), ["low", "medium", "high"]);
  assert.deepEqual(effortsFor("agy", "gemini-3.1-pro", cfg), ["low", "high"], "It has no medium");
  assert.deepEqual(effortsFor("agy", "claude-sonnet-4-6", cfg), [], "It has no tiers at all, so the interface should gray it out");
  // When no model is selected, use agy's own default model; it accepts whatever tier is configured
  assert.ok(effortsFor("agy", "", cfg).includes(""));
});

test("The pair that is sent must always match", () => {
  assert.deepEqual(pairModelEffort("agy", "gemini-3.8-flash", "medium", cfg),
    { model: "gemini-3.8-flash", effort: "medium" });
  // This model has no medium: step down one tier; better to be lighter than requested
  // than to run more expensively and slowly behind the user's back
  assert.deepEqual(pairModelEffort("agy", "gemini-3.1-pro", "medium", cfg),
    { model: "gemini-3.1-pro", effort: "low" });
  // Models that do not accept tiers: clear the tier, otherwise agy will reject it
  assert.deepEqual(pairModelEffort("agy", "claude-sonnet-4-6", "high", cfg),
    { model: "claude-sonnet-4-6", effort: "" });
  // Models that require a tier: even if "default" is stored, fill in a tier for it
  assert.equal(pairModelEffort("agy", "gemini-3.8-flash", "", cfg).effort, "low");
});

test("The earlier saved suffixed form is still recognized, and the tier chosen back then is the fallback", () => {
  // After the manifest switched to base names, old localStorage still contains gemini-3.8-flash-low
  assert.deepEqual(pairModelEffort("agy", "gemini-3.8-flash-low", "medium", cfg),
    { model: "gemini-3.8-flash", effort: "medium" }, "If the saved tier is valid, follow it");
  assert.deepEqual(pairModelEffort("agy", "gemini-3.1-pro-high", "medium", cfg),
    { model: "gemini-3.1-pro", effort: "high" }, "If the model does not have the saved tier, fall back to the one in the name");
});

test("Other drivers are left completely untouched", () => {
  for (const p of ["claude", "codex", "api"]) {
    assert.deepEqual(pairModelEffort(p, "gpt-5.6-terra-low", "high", cfg),
      { model: "gpt-5.6-terra-low", effort: "high" }, `${p} must not have its suffix stripped`);
  }
  assert.deepEqual(pairModelEffort("agy", "", "high", cfg), { model: "", effort: "high" }, "If no model is selected, leave it alone");
});
