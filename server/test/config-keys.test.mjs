// node --test server/test/config-keys.test.mjs
// Both key channels (custom / Router) are encrypted into separate files and cannot be mixed;
// "Clear keys" deletes the file.
// Point PROMPTCUT_AI_CONFIG to a temporary directory, not touching real config.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sealKey, openKey, sealedKind, isSealed } from "../runners/config-crypt.mjs";

const CUSTOM = "sk-custom-0123456789abcdef";
const ROUTER = "sk-router-fedcba9876543210";

async function withConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-keys-"));
  const file = path.join(dir, "ai.json");
  const previous = process.env.PROMPTCUT_AI_CONFIG;
  process.env.PROMPTCUT_AI_CONFIG = file;
  try {
    // Environment variables must take effect before the module reads paths, so import here;
    // query string gives each test case an isolated instance
    const mod = await import(`../ai-config.mjs?keys=${encodeURIComponent(file)}`);
    await fn({ ...mod, dir, file });
  } finally {
    if (previous === undefined) delete process.env.PROMPTCUT_AI_CONFIG;
    else process.env.PROMPTCUT_AI_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("The two sources' ciphertexts have different prefixes, decrypting with the wrong source gives an empty string", () => {
  const c = sealKey(CUSTOM, "custom");
  const r = sealKey(ROUTER, "router");
  assert.ok(c.startsWith("PCENC1."));
  assert.ok(r.startsWith("PCRTR1."));
  assert.equal(sealedKind(c), "custom");
  assert.equal(sealedKind(r), "router");
  assert.ok(isSealed(r));
  assert.equal(openKey(c, "custom"), CUSTOM);
  assert.equal(openKey(r, "router"), ROUTER);
  assert.equal(openKey(c, "router"), "", "custom ciphertext cannot be decrypted with the router scheme");
  assert.equal(openKey(r, "custom"), "", "router ciphertext cannot be decrypted with the custom scheme");
  // For the same plaintext, the two ciphertexts cannot recognize each other: not a single byte
  // besides size should match
  assert.notEqual(sealKey(CUSTOM, "router").slice(7), c.slice(7));
});

test("An old call without kind equals custom (compatibility)", () => {
  const c = sealKey(CUSTOM);
  assert.ok(c.startsWith("PCENC1."));
  assert.equal(openKey(c), CUSTOM);
  assert.throws(() => sealKey(sealKey(ROUTER, "router"), "custom"), /other path/);
  assert.throws(() => sealKey(CUSTOM, "nope"), /Unknown key type/);
});

test("Custom and Router each write their own file, ai.json has no key, only source", async () => {
  await withConfig(({ writeConfig, readConfig, publicConfig, keyFilePath, dir }) => {
    writeConfig({ api: { apiKey: CUSTOM, vendor: "anthropic", model: "claude-sonnet-4-5" } });
    assert.ok(fs.existsSync(keyFilePath("custom")));
    assert.ok(!fs.existsSync(keyFilePath("router")));
    assert.equal(readConfig().api.source, "custom");
    assert.equal(readConfig().api.apiKey, CUSTOM);

    writeConfig({ api: { apiKey: ROUTER, source: "router", vendor: "openai", model: "gpt-4o" } });
    assert.ok(fs.existsSync(keyFilePath("router")));
    assert.equal(readConfig().api.source, "router");
    assert.equal(readConfig().api.apiKey, ROUTER, "After importing Router, the active one is the Router source");

    const custom = fs.readFileSync(keyFilePath("custom"), "utf8");
    const router = fs.readFileSync(keyFilePath("router"), "utf8");
    assert.ok(custom.startsWith("PCENC1."));
    assert.ok(router.startsWith("PCRTR1."));
    assert.ok(!custom.includes(CUSTOM) && !router.includes(ROUTER), "The key files must not contain plaintext");

    const aiJson = fs.readFileSync(path.join(dir, "ai.json"), "utf8");
    assert.ok(!aiJson.includes(CUSTOM) && !aiJson.includes(ROUTER) && !aiJson.includes("PCENC1") && !aiJson.includes("PCRTR1"), "ai.json contains neither plaintext nor ciphertext");
    assert.ok(aiJson.includes('"source": "router"'));

    const pub = publicConfig();
    assert.deepEqual(pub.keys.custom, { set: true, last4: CUSTOM.slice(-4) });
    assert.deepEqual(pub.keys.router, { set: true, last4: ROUTER.slice(-4) });
    assert.deepEqual(pub.api.apiKey, { set: true, last4: ROUTER.slice(-4) });
    assert.equal(pub.api.source, "router");
  });
});

test("Switching only source without a key: switches back to the custom source; if that source has no file, an error is reported", async () => {
  await withConfig(({ writeConfig, readConfig }) => {
    writeConfig({ api: { apiKey: CUSTOM } });
    writeConfig({ api: { apiKey: ROUTER, source: "router" } });
    writeConfig({ api: { source: "custom" } });
    assert.equal(readConfig().api.apiKey, CUSTOM);
    assert.equal(readConfig().api.source, "custom");
    assert.throws(() => writeConfig({ api: { source: "nope" } }), /api\.source/);
  });
});

test("If the file is swapped for the other source's ciphertext, treat it as no key set, no mixing", async () => {
  await withConfig(({ writeConfig, readConfig, keyFilePath }) => {
    writeConfig({ api: { apiKey: ROUTER, source: "router" } });
    // Someone copied custom ciphertext into router.key
    fs.writeFileSync(keyFilePath("router"), sealKey(CUSTOM, "custom"));
    assert.equal(readConfig().api.apiKey, "");
    assert.equal(readConfig().api.source, "");
  });
});

test("Clear key: deletes that source's file; deleting the active source falls back to no key set, the other source is unaffected", async () => {
  await withConfig(({ writeConfig, readConfig, clearKey, publicConfig, keyFilePath }) => {
    writeConfig({ api: { apiKey: CUSTOM } });
    writeConfig({ api: { apiKey: ROUTER, source: "router" } });

    clearKey("router");
    assert.ok(!fs.existsSync(keyFilePath("router")), "router.key should be deleted");
    assert.ok(fs.existsSync(keyFilePath("custom")), "custom.key should not be touched");
    assert.equal(readConfig().api.apiKey, "", "The active source was deleted, it must not be silently swapped for the other one");
    assert.equal(readConfig().api.source, "");
    assert.deepEqual(publicConfig().keys.router, { set: false, last4: "" });
    assert.equal(publicConfig().keys.custom.set, true);

    // Switching back to the custom channel works as usual; clearing it leaves both channels empty
    writeConfig({ api: { source: "custom" } });
    assert.equal(readConfig().api.apiKey, CUSTOM);
    clearKey("custom");
    assert.ok(!fs.existsSync(keyFilePath("custom")));
    assert.equal(readConfig().api.apiKey, "");
    assert.throws(() => clearKey("nope"), /Key type/);
  });
});

test("Old versions wrote ciphertext in ai.json: it can be read, and the next config write moves it into custom.key", async () => {
  await withConfig(({ writeConfig, readConfig, publicConfig, clearKey, keyFilePath, file }) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, api: { vendor: "anthropic", apiKey: sealKey(CUSTOM, "custom"), model: "m" } }));
    assert.equal(readConfig().api.apiKey, CUSTOM);
    assert.equal(readConfig().api.source, "custom");
    assert.equal(publicConfig().keys.custom.set, true, "The custom page must still show it before the move");

    writeConfig({ api: { model: "m2" } });
    assert.ok(fs.existsSync(keyFilePath("custom")));
    assert.ok(!fs.readFileSync(file, "utf8").includes("PCENC1"), "After the move, ai.json no longer keeps ciphertext");
    assert.equal(readConfig().api.apiKey, CUSTOM);

    // Keys from older versions are also cleaned up and will not reappear from ai.json
    clearKey("custom");
    assert.equal(readConfig().api.apiKey, "");
    assert.equal(publicConfig().keys.custom.set, false);
  });
});

test("apiKey: null clears the active source (same effect as the clear button)", async () => {
  await withConfig(({ writeConfig, readConfig, keyFilePath }) => {
    writeConfig({ api: { apiKey: CUSTOM } });
    writeConfig({ api: { apiKey: null } });
    assert.ok(!fs.existsSync(keyFilePath("custom")));
    assert.equal(readConfig().api.apiKey, "");
  });
});

test("Each source has its own connection config: the custom page and the Router import do not overwrite each other, top-level fields follow the active source", async () => {
  await withConfig(({ writeConfig, readConfig, publicConfig }) => {
    // Custom page: explicitly write profiles.custom + Key
    writeConfig({ api: { profiles: { custom: { vendor: "openai", baseUrl: "https://x.example", model: "gpt-4o|gpt-4o-mini" } }, apiKey: CUSTOM, source: "custom" } });
    let cfg = readConfig();
    assert.equal(cfg.api.source, "custom");
    assert.equal(cfg.api.model, "gpt-4o|gpt-4o-mini", "custom is active, the top-level model mirrors it");
    assert.equal(cfg.api.vendor, "openai");

    // Router import (legacy format: top-level field + source router) writes to router channel,
    // leaving custom intact
    writeConfig({ api: { vendor: "anthropic", baseUrl: "", model: "claude-sonnet-4-5", apiKey: ROUTER, source: "router" } });
    cfg = readConfig();
    assert.equal(cfg.api.source, "router");
    assert.equal(cfg.api.model, "claude-sonnet-4-5");
    assert.equal(cfg.api.vendor, "anthropic");
    assert.equal(cfg.api.profiles.custom.model, "gpt-4o|gpt-4o-mini", "The custom source was not overwritten by the Router import");
    assert.equal(cfg.api.profiles.custom.baseUrl, "https://x.example");

    // Modifying model manifest on Router page: affects only the router channel
    writeConfig({ api: { profiles: { router: { model: "claude-sonnet-4-5|claude-haiku-4-5" } } } });
    cfg = readConfig();
    assert.equal(cfg.api.model, "claude-sonnet-4-5|claude-haiku-4-5");
    assert.equal(cfg.api.profiles.router.vendor, "anthropic", "Fields not passed are left untouched");

    // Modifying Custom page when Router is active: custom channel changes, top-level (active) unchanged
    writeConfig({ api: { profiles: { custom: { model: "gpt-5" } } } });
    cfg = readConfig();
    assert.equal(cfg.api.profiles.custom.model, "gpt-5");
    assert.equal(cfg.api.model, "claude-sonnet-4-5|claude-haiku-4-5");

    // Switch back to custom: top-level switches along with it
    writeConfig({ api: { source: "custom" } });
    cfg = readConfig();
    assert.equal(cfg.api.source, "custom");
    assert.equal(cfg.api.model, "gpt-5");
    assert.equal(cfg.api.baseUrl, "https://x.example");
    assert.deepEqual(Object.keys(publicConfig().api.profiles).sort(), ["custom", "router"]);
  });
});

test("An ai.json from an old version without profiles: the top-level copy moves into the current source, nothing is lost", async () => {
  await withConfig(({ readConfig, writeConfig, file }) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, api: { vendor: "gemini", baseUrl: "https://g.example", model: "gemini-2.0-flash|gemini-2.0-pro", maxTokens: 2048 } }));
    let cfg = readConfig();
    assert.equal(cfg.api.model, "gemini-2.0-flash|gemini-2.0-pro");
    assert.equal(cfg.api.profiles.custom.model, "gemini-2.0-flash|gemini-2.0-pro");
    assert.equal(cfg.api.profiles.custom.vendor, "gemini");
    assert.equal(cfg.api.profiles.router.model, "");
    // Once written, the shape persisted to disk is the new one, and reading again returns the same
    writeConfig({ toolProtocol: true });
    cfg = readConfig();
    assert.equal(cfg.api.model, "gemini-2.0-flash|gemini-2.0-pro");
    assert.equal(cfg.api.baseUrl, "https://g.example");
  });
});

test("profiles validation: if the vendor or address is invalid, the whole config is not written", async () => {
  await withConfig(({ writeConfig, readConfig }) => {
    writeConfig({ api: { profiles: { custom: { model: "a|b" } } } });
    assert.throws(() => writeConfig({ api: { profiles: { router: { vendor: "foo" } } } }), /vendor must be/);
    assert.throws(() => writeConfig({ api: { profiles: { custom: { baseUrl: "ftp://x" } } } }), /http\(s\)/);
    assert.equal(readConfig().api.profiles.custom.model, "a|b");
  });
});
