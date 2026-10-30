/**
 * `src/ai/extensions.ts` 与 `src/ai/extensionsLoad.mjs` — AI 提供方接缝与扩展加载器单测
 * （参照 `server/test/docservice-extensions.test.mjs`，使用临时目录夹具验证加载表契约）。
 *
 * 覆盖：
 *   1. 显式 `cloudDir` 指向含 `ai/manifest.mjs` 的临时目录：返回冻结条目，`getAiCloudProvider()` 用上表里的实现；
 *   2. `PROMPTCUT_CLOUD_DIR` 环境变量覆盖：按环境变量目录加载 `ai/manifest.mjs` 并登记提供方；
 *   3. `cloudDir` 指向空目录（模拟社区版没有 `cloud` 目录）：返回 `[]`、不抛异常、`getAiCloudProvider()` 保持 `COMMUNITY_AI_CLOUD_PROVIDER`；
 *   4. 表里条目形状不对（导出非数组、缺 `name` 或混入非法项）：跳过非法项、不抛异常、返回冻结数组；
 *   5. `CloudError` 跨模块 `instanceof` 兼容与 `cloudConversationControlPolicy` 判定。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLOUD_OFF_STATE,
  COMMUNITY_AI_CLOUD_PROVIDER,
  CloudError,
  cloudConversationControlPolicy,
  cloudErrorText,
  cloudTicket,
  getAiCloudProvider,
  hasAiCloudProvider,
  resetAiCloudProvider,
  useCloudAgent,
} from "./extensions.ts";
import { loadAiExtensions } from "./extensionsLoad.mjs";

test("显式 cloudDir 临时目录夹具：加载 ai/manifest.mjs 返回冻结条目并应用表内提供方实现", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ai-ext-dir-"));
  try {
    resetAiCloudProvider();
    const aiDir = path.join(tmp, "ai");
    fs.mkdirSync(aiDir, { recursive: true });
    fs.writeFileSync(
      path.join(aiDir, "manifest.mjs"),
      [
        "export const AI_MANIFEST = [",
        "  {",
        "    name: 'fixture-cloud-ai',",
        "    provider: {",
        "      useCloudAgent: () => ({",
        "        available: true,",
        "        enabled: true,",
        "        url: 'https://agent.example/v1',",
        "        projectId: 'proj-1',",
        "        identityVersion: 2,",
        "        accountMode: true,",
        "        accountId: 'acc-1',",
        "      }),",
        "      cloudTicket: async () => 'ticket-from-fixture-dir',",
        "    },",
        "    create: () => ({ mounted: true }),",
        "  },",
        "];",
      ].join("\n"),
      "utf8",
    );

    const exts = await loadAiExtensions({ cloudDir: tmp });
    assert.equal(exts.length, 1);
    assert.equal(exts[0].name, "fixture-cloud-ai");
    assert.ok(Object.isFrozen(exts), "returned list must be frozen");
    assert.ok(Object.isFrozen(exts[0]), "each entry must be frozen");
    assert.equal(typeof exts[0].create, "function");
    assert.equal(hasAiCloudProvider(), true);
    assert.notEqual(getAiCloudProvider(), COMMUNITY_AI_CLOUD_PROVIDER);
    assert.equal(await cloudTicket(), "ticket-from-fixture-dir");
    const agent = useCloudAgent();
    assert.equal(agent.available, true);
    assert.equal(agent.accountMode, true);
    assert.equal(agent.projectId, "proj-1");
  } finally {
    resetAiCloudProvider();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("PROMPTCUT_CLOUD_DIR 环境变量覆盖：装入指定目录下的 ai/manifest.mjs 并登记提供方", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ai-ext-env-"));
  const prevEnv = process.env.PROMPTCUT_CLOUD_DIR;
  try {
    resetAiCloudProvider();
    const aiDir = path.join(tmp, "ai");
    fs.mkdirSync(aiDir, { recursive: true });
    fs.writeFileSync(
      path.join(aiDir, "manifest.mjs"),
      [
        "export default [",
        "  {",
        "    name: 'env-cloud-ai',",
        "    provider: {",
        "      cloudTicket: async () => 'ticket-from-env-manifest',",
        "    },",
        "  },",
        "];",
      ].join("\n"),
      "utf8",
    );

    process.env.PROMPTCUT_CLOUD_DIR = tmp;
    const exts = await loadAiExtensions();
    assert.equal(exts.length, 1);
    assert.equal(exts[0].name, "env-cloud-ai");
    assert.ok(Object.isFrozen(exts));
    assert.ok(Object.isFrozen(exts[0]));
    assert.equal(hasAiCloudProvider(), true);
    assert.equal(await getAiCloudProvider().cloudTicket(), "ticket-from-env-manifest");
  } finally {
    resetAiCloudProvider();
    if (prevEnv === undefined) delete process.env.PROMPTCUT_CLOUD_DIR;
    else process.env.PROMPTCUT_CLOUD_DIR = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("社区模式（cloudDir 指向空目录）：返回空冻结数组、不抛异常、getAiCloudProvider() 仍是 COMMUNITY_AI_CLOUD_PROVIDER", async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ai-ext-empty-"));
  try {
    resetAiCloudProvider();
    const exts = await loadAiExtensions({ cloudDir: emptyDir });
    assert.deepEqual(exts, []);
    assert.ok(Object.isFrozen(exts));
    assert.equal(hasAiCloudProvider(), false);
    assert.equal(getAiCloudProvider(), COMMUNITY_AI_CLOUD_PROVIDER);
    const agentState = useCloudAgent();
    assert.equal(agentState, CLOUD_OFF_STATE);
    assert.equal(agentState.available, false);
    assert.equal(agentState.accountMode, false);
  } finally {
    resetAiCloudProvider();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("异常形状容错：非数组导出或缺 name 的非法条目一律跳过、不抛异常", async () => {
  const tmpBad = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ai-ext-bad-"));
  const tmpMixed = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ai-ext-mixed-"));
  try {
    resetAiCloudProvider();
    const badAiDir = path.join(tmpBad, "ai");
    fs.mkdirSync(badAiDir, { recursive: true });
    fs.writeFileSync(path.join(badAiDir, "manifest.mjs"), "export default 'not-an-array';\n", "utf8");
    const extsBad = await loadAiExtensions({ cloudDir: tmpBad });
    assert.deepEqual(extsBad, []);
    assert.ok(Object.isFrozen(extsBad));
    assert.equal(getAiCloudProvider(), COMMUNITY_AI_CLOUD_PROVIDER);

    const mixedAiDir = path.join(tmpMixed, "ai");
    fs.mkdirSync(mixedAiDir, { recursive: true });
    fs.writeFileSync(
      path.join(mixedAiDir, "manifest.mjs"),
      "export default [null, 42, {}, { name: '' }, { name: 'valid-item' }];\n",
      "utf8",
    );
    const extsMixed = await loadAiExtensions({ cloudDir: tmpMixed });
    assert.equal(extsMixed.length, 1);
    assert.equal(extsMixed[0].name, "valid-item");
    assert.ok(Object.isFrozen(extsMixed));
    assert.ok(Object.isFrozen(extsMixed[0]));
  } finally {
    resetAiCloudProvider();
    fs.rmSync(tmpBad, { recursive: true, force: true });
    fs.rmSync(tmpMixed, { recursive: true, force: true });
  }
});

test("CloudError 与会话控制策略：跨模块 instanceof 兼容且错误文案一致", () => {
  try {
    resetAiCloudProvider();
    class ExternalCloudError extends Error {
      constructor(code, message, status = 0) {
        super(message);
        this.name = "CloudError";
        this.code = code;
        this.status = status;
      }
    }
    const errFromApi = new ExternalCloudError("busy", cloudErrorText("busy"), 429);
    const errFromSeam = new CloudError("forbidden", cloudErrorText("forbidden"), 403);
    assert.ok(errFromApi instanceof CloudError);
    assert.ok(errFromSeam instanceof CloudError);
    const policy = cloudConversationControlPolicy({
      accountMode: false,
      accountId: null,
      creator: false,
      conversation: null,
      queue: null,
      senders: undefined,
      legacyStreaming: true,
    });
    assert.equal(policy.canSend, true);
    assert.equal(policy.canStop, true);
  } finally {
    resetAiCloudProvider();
  }
});
