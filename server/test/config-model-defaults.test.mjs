import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_MODELS = "gpt-5.6-terra|gpt-5.6-sol";

async function withConfig(contents, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-models-"));
  const file = path.join(dir, "ai.json");
  const previous = process.env.PROMPTCUT_AI_CONFIG;
  process.env.PROMPTCUT_AI_CONFIG = file;
  try {
    if (contents) fs.writeFileSync(file, JSON.stringify(contents));
    const mod = await import(`../ai-config.mjs?models=${encodeURIComponent(file)}`);
    await run(mod);
  } finally {
    if (previous === undefined) delete process.env.PROMPTCUT_AI_CONFIG;
    else process.env.PROMPTCUT_AI_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("A new config presets Codex 5.6 Terra and Sol", async () => {
  await withConfig(null, ({ readConfig }) => {
    assert.equal(readConfig().cliModels.codex, CODEX_MODELS);
  });
});

test("An empty Codex list in an existing config is filled in with presets automatically", async () => {
  await withConfig({ version: 1, cliModels: { codex: "" } }, ({ readConfig }) => {
    const config = readConfig();
    assert.equal(config.cliModels.codex, CODEX_MODELS);
  });
});

test("An existing custom Codex list stays unchanged", async () => {
  await withConfig({ version: 1, cliModels: { codex: "custom-codex" } }, ({ readConfig }) => {
    assert.equal(readConfig().cliModels.codex, "custom-codex");
  });
});
