/**
 * `src/ai/extensions.ts` and `src/ai/extensionsLoad.mjs`: AI provider seam and extension loader
 * unit tests (referencing `server/test/docservice-extensions.test.mjs`, using temporary directory
 * fixtures to verify loader table contracts).
 *
 * Coverage:
 *   1. Explicit `cloudDir` pointing to a temporary directory with `ai/manifest.mjs`: returns frozen
 *      entries, `getAiCloudProvider()` uses the implementation from the table;
 *   2. `PROMPTCUT_CLOUD_DIR` environment variable override: loads `ai/manifest.mjs` according to the
 *      environment variable directory and registers the provider;
 *   3. `cloudDir` pointing to an empty directory (simulating the community edition having no `cloud`
 *      directory): returns `[]`, throws no exception, `getAiCloudProvider()` keeps
 *      `COMMUNITY_AI_CLOUD_PROVIDER`;
 *   4. Invalid entry shape in table (non-array export, missing `name`, or mixed-in illegal items):
 *      skips illegal items, throws no exception, returns a frozen array;
 *   5. `CloudError` cross-module `instanceof` compatibility and `cloudConversationControlPolicy`
 *      evaluation.
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

test("Explicit cloudDir temporary-directory fixture: loading ai/manifest.mjs returns frozen entries and applies the provider implementations in the table", async () => {
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

test("PROMPTCUT_CLOUD_DIR environment variable override: loads ai/manifest.mjs under the specified directory and registers the provider", async () => {
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

test("Community mode (cloudDir points to an empty directory): returns an empty frozen array, does not throw, getAiCloudProvider() is still COMMUNITY_AI_CLOUD_PROVIDER", async () => {
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

test("Malformed-shape tolerance: non-array exports and invalid entries missing name are always skipped, no exception thrown", async () => {
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

test("CloudError and session control policy: instanceof works across modules and error messages are identical", () => {
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
