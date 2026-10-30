// node --test server/test/config-keys.test.mjs
// 两路 Key(自定义 / Router)各自加密、各自成文件、不能混用;「清理密钥」删文件。
// 用 PROMPTCUT_AI_CONFIG 指到临时目录,不碰真配置。
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
    // 环境变量要在模块读取路径之前生效,所以这里才 import;查询串让每个用例拿到独立实例
    const mod = await import(`../ai-config.mjs?keys=${encodeURIComponent(file)}`);
    await fn({ ...mod, dir, file });
  } finally {
    if (previous === undefined) delete process.env.PROMPTCUT_AI_CONFIG;
    else process.env.PROMPTCUT_AI_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("两路密文前缀不同,拿错一路解出来是空串", () => {
  const c = sealKey(CUSTOM, "custom");
  const r = sealKey(ROUTER, "router");
  assert.ok(c.startsWith("PCENC1."));
  assert.ok(r.startsWith("PCRTR1."));
  assert.equal(sealedKind(c), "custom");
  assert.equal(sealedKind(r), "router");
  assert.ok(isSealed(r));
  assert.equal(openKey(c, "custom"), CUSTOM);
  assert.equal(openKey(r, "router"), ROUTER);
  assert.equal(openKey(c, "router"), "", "custom 的密文不能用 router 那套解");
  assert.equal(openKey(r, "custom"), "", "router 的密文不能用 custom 那套解");
  // 同一份明文,两路密文不能互相认:连体积以外的任何一位都不该相同
  assert.notEqual(sealKey(CUSTOM, "router").slice(7), c.slice(7));
});

test("不带 kind 的老调用等于 custom(兼容)", () => {
  const c = sealKey(CUSTOM);
  assert.ok(c.startsWith("PCENC1."));
  assert.equal(openKey(c), CUSTOM);
  assert.throws(() => sealKey(sealKey(ROUTER, "router"), "custom"), /另一路/);
  assert.throws(() => sealKey(CUSTOM, "nope"), /未知的密钥类型/);
});

test("自定义和 Router 各写各的文件,ai.json 里没有 Key,只有 source", async () => {
  await withConfig(({ writeConfig, readConfig, publicConfig, keyFilePath, dir }) => {
    writeConfig({ api: { apiKey: CUSTOM, vendor: "anthropic", model: "claude-sonnet-4-5" } });
    assert.ok(fs.existsSync(keyFilePath("custom")));
    assert.ok(!fs.existsSync(keyFilePath("router")));
    assert.equal(readConfig().api.source, "custom");
    assert.equal(readConfig().api.apiKey, CUSTOM);

    writeConfig({ api: { apiKey: ROUTER, source: "router", vendor: "openai", model: "gpt-4o" } });
    assert.ok(fs.existsSync(keyFilePath("router")));
    assert.equal(readConfig().api.source, "router");
    assert.equal(readConfig().api.apiKey, ROUTER, "导入 Router 之后生效的是 Router 那一路");

    const custom = fs.readFileSync(keyFilePath("custom"), "utf8");
    const router = fs.readFileSync(keyFilePath("router"), "utf8");
    assert.ok(custom.startsWith("PCENC1."));
    assert.ok(router.startsWith("PCRTR1."));
    assert.ok(!custom.includes(CUSTOM) && !router.includes(ROUTER), "密钥文件里不能有明文");

    const aiJson = fs.readFileSync(path.join(dir, "ai.json"), "utf8");
    assert.ok(!aiJson.includes(CUSTOM) && !aiJson.includes(ROUTER) && !aiJson.includes("PCENC1") && !aiJson.includes("PCRTR1"), "ai.json 里既没有明文也没有密文");
    assert.ok(aiJson.includes('"source": "router"'));

    const pub = publicConfig();
    assert.deepEqual(pub.keys.custom, { set: true, last4: CUSTOM.slice(-4) });
    assert.deepEqual(pub.keys.router, { set: true, last4: ROUTER.slice(-4) });
    assert.deepEqual(pub.api.apiKey, { set: true, last4: ROUTER.slice(-4) });
    assert.equal(pub.api.source, "router");
  });
});

test("只切 source 不带 Key:切回自定义那一路;那一路没文件就报错", async () => {
  await withConfig(({ writeConfig, readConfig }) => {
    writeConfig({ api: { apiKey: CUSTOM } });
    writeConfig({ api: { apiKey: ROUTER, source: "router" } });
    writeConfig({ api: { source: "custom" } });
    assert.equal(readConfig().api.apiKey, CUSTOM);
    assert.equal(readConfig().api.source, "custom");
    assert.throws(() => writeConfig({ api: { source: "nope" } }), /api\.source/);
  });
});

test("文件被换成另一路的密文就当没设 Key,不混用", async () => {
  await withConfig(({ writeConfig, readConfig, keyFilePath }) => {
    writeConfig({ api: { apiKey: ROUTER, source: "router" } });
    // 有人把 custom 的密文拷到 router.key 里
    fs.writeFileSync(keyFilePath("router"), sealKey(CUSTOM, "custom"));
    assert.equal(readConfig().api.apiKey, "");
    assert.equal(readConfig().api.source, "");
  });
});

test("清理密钥:删掉那一路的文件;删的是生效那一路就退回没设 Key,另一路不受影响", async () => {
  await withConfig(({ writeConfig, readConfig, clearKey, publicConfig, keyFilePath }) => {
    writeConfig({ api: { apiKey: CUSTOM } });
    writeConfig({ api: { apiKey: ROUTER, source: "router" } });

    clearKey("router");
    assert.ok(!fs.existsSync(keyFilePath("router")), "router.key 应该被删掉");
    assert.ok(fs.existsSync(keyFilePath("custom")), "custom.key 不该动");
    assert.equal(readConfig().api.apiKey, "", "删的是生效那一路,不该悄悄换成另一路");
    assert.equal(readConfig().api.source, "");
    assert.deepEqual(publicConfig().keys.router, { set: false, last4: "" });
    assert.equal(publicConfig().keys.custom.set, true);

    // 切回自定义那一路照常能用;再清掉它就两路都空
    writeConfig({ api: { source: "custom" } });
    assert.equal(readConfig().api.apiKey, CUSTOM);
    clearKey("custom");
    assert.ok(!fs.existsSync(keyFilePath("custom")));
    assert.equal(readConfig().api.apiKey, "");
    assert.throws(() => clearKey("nope"), /密钥类型/);
  });
});

test("老版本把密文写在 ai.json 里:读得出来,下次写配置就搬进 custom.key", async () => {
  await withConfig(({ writeConfig, readConfig, publicConfig, clearKey, keyFilePath, file }) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, api: { vendor: "anthropic", apiKey: sealKey(CUSTOM, "custom"), model: "m" } }));
    assert.equal(readConfig().api.apiKey, CUSTOM);
    assert.equal(readConfig().api.source, "custom");
    assert.equal(publicConfig().keys.custom.set, true, "没搬家之前自定义页也要看得到");

    writeConfig({ api: { model: "m2" } });
    assert.ok(fs.existsSync(keyFilePath("custom")));
    assert.ok(!fs.readFileSync(file, "utf8").includes("PCENC1"), "搬家之后 ai.json 里不再留密文");
    assert.equal(readConfig().api.apiKey, CUSTOM);

    // 老版本的 Key 也能被清理掉,不会从 ai.json 里再冒出来
    clearKey("custom");
    assert.equal(readConfig().api.apiKey, "");
    assert.equal(publicConfig().keys.custom.set, false);
  });
});

test("apiKey: null 清掉生效那一路(和清理按钮一个效果)", async () => {
  await withConfig(({ writeConfig, readConfig, keyFilePath }) => {
    writeConfig({ api: { apiKey: CUSTOM } });
    writeConfig({ api: { apiKey: null } });
    assert.ok(!fs.existsSync(keyFilePath("custom")));
    assert.equal(readConfig().api.apiKey, "");
  });
});

test("两路各一份连接配置:自定义页和 Router 导入互不冲掉,顶层字段跟着生效那一路走", async () => {
  await withConfig(({ writeConfig, readConfig, publicConfig }) => {
    // 自定义页:显式写 profiles.custom + Key
    writeConfig({ api: { profiles: { custom: { vendor: "openai", baseUrl: "https://x.example", model: "gpt-4o|gpt-4o-mini" } }, apiKey: CUSTOM, source: "custom" } });
    let cfg = readConfig();
    assert.equal(cfg.api.source, "custom");
    assert.equal(cfg.api.model, "gpt-4o|gpt-4o-mini", "生效的是 custom,顶层 model 是它的镜像");
    assert.equal(cfg.api.vendor, "openai");

    // Router 导入(老写法:顶层字段 + source router)写进 router 那一路,custom 那份原样
    writeConfig({ api: { vendor: "anthropic", baseUrl: "", model: "claude-sonnet-4-5", apiKey: ROUTER, source: "router" } });
    cfg = readConfig();
    assert.equal(cfg.api.source, "router");
    assert.equal(cfg.api.model, "claude-sonnet-4-5");
    assert.equal(cfg.api.vendor, "anthropic");
    assert.equal(cfg.api.profiles.custom.model, "gpt-4o|gpt-4o-mini", "custom 那一路没被 Router 导入冲掉");
    assert.equal(cfg.api.profiles.custom.baseUrl, "https://x.example");

    // Router 页改模型清单:只动 router 那一路
    writeConfig({ api: { profiles: { router: { model: "claude-sonnet-4-5|claude-haiku-4-5" } } } });
    cfg = readConfig();
    assert.equal(cfg.api.model, "claude-sonnet-4-5|claude-haiku-4-5");
    assert.equal(cfg.api.profiles.router.vendor, "anthropic", "没传的字段不动");

    // 当前生效的是 Router 时改自定义页:custom 那一路变了,顶层(生效)不变
    writeConfig({ api: { profiles: { custom: { model: "gpt-5" } } } });
    cfg = readConfig();
    assert.equal(cfg.api.profiles.custom.model, "gpt-5");
    assert.equal(cfg.api.model, "claude-sonnet-4-5|claude-haiku-4-5");

    // 切回 custom:顶层跟着切
    writeConfig({ api: { source: "custom" } });
    cfg = readConfig();
    assert.equal(cfg.api.source, "custom");
    assert.equal(cfg.api.model, "gpt-5");
    assert.equal(cfg.api.baseUrl, "https://x.example");
    assert.deepEqual(Object.keys(publicConfig().api.profiles).sort(), ["custom", "router"]);
  });
});

test("老版本没有 profiles 的 ai.json:顶层那份搬进当前那一路,一个字不丢", async () => {
  await withConfig(({ readConfig, writeConfig, file }) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, api: { vendor: "gemini", baseUrl: "https://g.example", model: "gemini-2.0-flash|gemini-2.0-pro", maxTokens: 2048 } }));
    let cfg = readConfig();
    assert.equal(cfg.api.model, "gemini-2.0-flash|gemini-2.0-pro");
    assert.equal(cfg.api.profiles.custom.model, "gemini-2.0-flash|gemini-2.0-pro");
    assert.equal(cfg.api.profiles.custom.vendor, "gemini");
    assert.equal(cfg.api.profiles.router.model, "");
    // 写一次之后落盘的形状就是新的,再读还一样
    writeConfig({ toolProtocol: true });
    cfg = readConfig();
    assert.equal(cfg.api.model, "gemini-2.0-flash|gemini-2.0-pro");
    assert.equal(cfg.api.baseUrl, "https://g.example");
  });
});

test("profiles 的校验:厂商、地址不合法整份不写", async () => {
  await withConfig(({ writeConfig, readConfig }) => {
    writeConfig({ api: { profiles: { custom: { model: "a|b" } } } });
    assert.throws(() => writeConfig({ api: { profiles: { router: { vendor: "foo" } } } }), /vendor 只能是/);
    assert.throws(() => writeConfig({ api: { profiles: { custom: { baseUrl: "ftp://x" } } } }), /http\(s\)/);
    assert.equal(readConfig().api.profiles.custom.model, "a|b");
  });
});
