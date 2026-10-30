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

test("新配置预设 Codex 5.6 Terra 和 Sol", async () => {
  await withConfig(null, ({ readConfig }) => {
    assert.equal(readConfig().cliModels.codex, CODEX_MODELS);
  });
});

test("已有配置的空 Codex 清单自动补预设", async () => {
  await withConfig({ version: 1, cliModels: { codex: "" } }, ({ readConfig }) => {
    const config = readConfig();
    assert.equal(config.cliModels.codex, CODEX_MODELS);
  });
});

test("已有自定义 Codex 清单保持不变", async () => {
  await withConfig({ version: 1, cliModels: { codex: "custom-codex" } }, ({ readConfig }) => {
    assert.equal(readConfig().cliModels.codex, "custom-codex");
  });
});
