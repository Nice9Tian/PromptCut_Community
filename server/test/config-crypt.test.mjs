// API Key 落盘加密。用 PROMPTCUT_AI_CONFIG 指到临时文件,不碰真配置。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sealKey, openKey, isSealed } from "../runners/config-crypt.mjs";

const KEY = "sk-ant-super-secret-0123456789";

test("加密再解密拿回原样的 Key", () => {
  const sealed = sealKey(KEY);
  assert.ok(isSealed(sealed));
  assert.equal(openKey(sealed), KEY);
});

test("密文里看不到明文", () => {
  assert.ok(!sealKey(KEY).includes("super-secret"));
  assert.ok(!sealKey(KEY).includes(KEY.slice(-8)));
});

test("同一个 Key 每次密文都不同", () => {
  assert.notEqual(sealKey(KEY), sealKey(KEY));
});

test("空值不套壳", () => {
  assert.equal(sealKey(""), "");
  assert.equal(sealKey(null), "");
  assert.equal(openKey(""), "");
});

test("已经是密文的不再套第二层", () => {
  const once = sealKey(KEY);
  assert.equal(sealKey(once), once);
});

test("老配置里的明文原样读出来(升级不丢 Key)", () => {
  assert.equal(openKey(KEY), KEY);
  assert.equal(isSealed(KEY), false);
});

test("篡改过的密文当成没设 Key,而不是抛错", () => {
  const sealed = sealKey(KEY);
  const broken = sealed.slice(0, -4) + (sealed.at(-4) === "A" ? "B" : "A") + sealed.slice(-3);
  assert.equal(openKey(broken), "");
  assert.equal(openKey("PCENC1.not-base64-at-all!!"), "");
  assert.equal(openKey("PCENC1."), "");
});

test("落盘的 ai.json 里没有明文 Key,读回来却是明文", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-cfg-"));
  const file = path.join(dir, "ai.json");
  const previous = process.env.PROMPTCUT_AI_CONFIG;
  process.env.PROMPTCUT_AI_CONFIG = file;
  try {
    // 环境变量要在模块读取路径之前生效,所以这里才 import
    const { writeConfig, readConfig, publicConfig } = await import(
      `../ai-config.mjs?cfg=${encodeURIComponent(file)}`
    );
    writeConfig({ api: { apiKey: KEY, vendor: "anthropic", model: "claude-sonnet-4-5" } });

    const onDisk = fs.readFileSync(file, "utf8");
    assert.ok(!onDisk.includes(KEY), "明文 Key 落到磁盘上了");
    // Key 现在单独存在 keys/custom.key 里,ai.json 只留 source
    assert.ok(!onDisk.includes("PCENC1."), "ai.json 里不该再有密文");
    const keyFile = fs.readFileSync(path.join(dir, "keys", "custom.key"), "utf8");
    assert.ok(keyFile.startsWith("PCENC1.") && !keyFile.includes(KEY), "密钥文件里应是密文");

    assert.equal(readConfig().api.apiKey, KEY, "读回来应该是明文");

    const pub = publicConfig();
    assert.deepEqual(pub.api.apiKey, { set: true, last4: KEY.slice(-4) }, "对前端仍然只给脱敏结构");
  } finally {
    if (previous === undefined) delete process.env.PROMPTCUT_AI_CONFIG;
    else process.env.PROMPTCUT_AI_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("留空 Key 时保留原来的,并且仍然是密文落盘", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-cfg-"));
  const file = path.join(dir, "ai.json");
  const previous = process.env.PROMPTCUT_AI_CONFIG;
  process.env.PROMPTCUT_AI_CONFIG = file;
  try {
    const { writeConfig, readConfig } = await import(`../ai-config.mjs?keep=${encodeURIComponent(file)}`);
    writeConfig({ api: { apiKey: KEY } });
    writeConfig({ api: { model: "gpt-4o" } });
    assert.equal(readConfig().api.apiKey, KEY);
    assert.equal(readConfig().api.model, "gpt-4o");
    assert.ok(!fs.readFileSync(file, "utf8").includes(KEY));
  } finally {
    if (previous === undefined) delete process.env.PROMPTCUT_AI_CONFIG;
    else process.env.PROMPTCUT_AI_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
