// API Key encrypted on disk. Point PROMPTCUT_AI_CONFIG to a temporary file, not touching real config.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sealKey, openKey, isSealed } from "../runners/config-crypt.mjs";

const KEY = "sk-ant-super-secret-0123456789";

test("Encrypting then decrypting returns the original key", () => {
  const sealed = sealKey(KEY);
  assert.ok(isSealed(sealed));
  assert.equal(openKey(sealed), KEY);
});

test("The plaintext cannot be seen in the ciphertext", () => {
  assert.ok(!sealKey(KEY).includes("super-secret"));
  assert.ok(!sealKey(KEY).includes(KEY.slice(-8)));
});

test("The same key gives a different ciphertext every time", () => {
  assert.notEqual(sealKey(KEY), sealKey(KEY));
});

test("Empty values are not wrapped", () => {
  assert.equal(sealKey(""), "");
  assert.equal(sealKey(null), "");
  assert.equal(openKey(""), "");
});

test("Values that are already ciphertext do not get a second layer", () => {
  const once = sealKey(KEY);
  assert.equal(sealKey(once), once);
});

test("Plaintext in old configs is read as is (upgrades do not lose the key)", () => {
  assert.equal(openKey(KEY), KEY);
  assert.equal(isSealed(KEY), false);
});

test("Tampered ciphertext is treated as no key set, instead of throwing", () => {
  const sealed = sealKey(KEY);
  const broken = sealed.slice(0, -4) + (sealed.at(-4) === "A" ? "B" : "A") + sealed.slice(-3);
  assert.equal(openKey(broken), "");
  assert.equal(openKey("PCENC1.not-base64-at-all!!"), "");
  assert.equal(openKey("PCENC1."), "");
});

test("The ai.json written to disk has no plaintext key, yet reading it back gives plaintext", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-cfg-"));
  const file = path.join(dir, "ai.json");
  const previous = process.env.PROMPTCUT_AI_CONFIG;
  process.env.PROMPTCUT_AI_CONFIG = file;
  try {
    // Environment variables must take effect before the module reads paths, so import here
    const { writeConfig, readConfig, publicConfig } = await import(
      `../ai-config.mjs?cfg=${encodeURIComponent(file)}`
    );
    writeConfig({ api: { apiKey: KEY, vendor: "anthropic", model: "claude-sonnet-4-5" } });

    const onDisk = fs.readFileSync(file, "utf8");
    assert.ok(!onDisk.includes(KEY), "The plaintext key was written to disk");
    // Key is now stored separately in keys/custom.key; ai.json keeps only source
    assert.ok(!onDisk.includes("PCENC1."), "ai.json should no longer contain ciphertext");
    const keyFile = fs.readFileSync(path.join(dir, "keys", "custom.key"), "utf8");
    assert.ok(keyFile.startsWith("PCENC1.") && !keyFile.includes(KEY), "The key file should contain ciphertext");

    assert.equal(readConfig().api.apiKey, KEY, "Reading it back should give plaintext");

    const pub = publicConfig();
    assert.deepEqual(pub.api.apiKey, { set: true, last4: KEY.slice(-4) }, "The frontend still only gets the redacted structure");
  } finally {
    if (previous === undefined) delete process.env.PROMPTCUT_AI_CONFIG;
    else process.env.PROMPTCUT_AI_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Leaving the key empty keeps the original one, and it is still written to disk as ciphertext", async () => {
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
