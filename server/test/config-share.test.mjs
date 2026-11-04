// Round-trip test for encrypted distribution. Run frontend configShare.ts directly (Node 24
// native type stripping), avoiding copying the implementation into tests: a duplicate will
// sooner or later diverge from real code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptConfig, decryptConfig, looksLikeShareBlob } from "../../src/ai/configShare.ts";
import { machineCode } from "../runners/machine-id.mjs";

const CODE = machineCode("win:test-machine-guid");
const CONFIG = {
  vendor: "openai",
  baseUrl: "https://api.example.com/v1",
  model: "gpt-4o",
  apiKey: "sk-test-ABC123456789xyz",
  note: "给小王用",
};
// Production defaults to 600,000 rounds, no need to burn every time in tests; round count is
// written in ciphertext header, and decryption recognizes it just the same
const FAST = { iterations: 20_000 };

test("Encrypting then decrypting returns the original config", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  assert.ok(looksLikeShareBlob(blob));
  assert.deepEqual(await decryptConfig(blob, CODE), CONFIG);
});

test("The plaintext key does not appear in the ciphertext", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  assert.ok(!blob.includes("sk-test"));
  assert.ok(!blob.includes(CONFIG.baseUrl));
});

test("The same config encrypts differently every time (salt / iv are random)", async () => {
  const a = await encryptConfig(CONFIG, CODE, FAST);
  const b = await encryptConfig(CONFIG, CODE, FAST);
  assert.notEqual(a, b);
});

test("Cannot be decrypted on another machine", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  await assert.rejects(() => decryptConfig(blob, machineCode("win:another-machine")), /Can.t decrypt/);
});

test("Case, separators and look-alike characters are tolerated when copying the code", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  for (const variant of [CODE.toLowerCase(), CODE.replace(/-/g, ""), CODE.replace(/0/g, "O"), ` ${CODE} `]) {
    assert.equal((await decryptConfig(blob, variant)).apiKey, CONFIG.apiKey, `Variant cannot be decrypted: ${variant}`);
  }
});

test("Line breaks inserted by chat apps do not affect decryption", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  assert.equal((await decryptConfig(blob.replace(/(.{40})/g, "$1\n"), CODE)).model, CONFIG.model);
});

test("Changing a single byte makes it undecryptable (GCM check)", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  const flipped = blob.slice(0, -6) + (blob.at(-6) === "A" ? "B" : "A") + blob.slice(-5);
  await assert.rejects(() => decryptConfig(flipped, CODE), /Can.t decrypt/);
});

test("An incomplete paste reports \"truncated\" rather than \"wrong passphrase\"", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  await assert.rejects(() => decryptConfig(blob.slice(0, 30), CODE), /truncated/);
});

test("When it is not our ciphertext, say so clearly", async () => {
  await assert.rejects(() => decryptConfig("This is some ordinary text", CODE), /not a PromptCut config string/);
  assert.equal(looksLikeShareBlob("This is some ordinary text"), false);
});

test("Expired config is rejected on import", async () => {
  const blob = await encryptConfig({ ...CONFIG, expiresAt: Date.now() - 1000 }, CODE, FAST);
  await assert.rejects(() => decryptConfig(blob, CODE), /expired/);
});

test("Unexpired config imports normally", async () => {
  const expiresAt = Date.now() + 86_400_000;
  const blob = await encryptConfig({ ...CONFIG, expiresAt }, CODE, FAST);
  assert.equal((await decryptConfig(blob, CODE)).expiresAt, expiresAt);
});

test("Empty key and empty passphrase are both blocked on the spot", async () => {
  await assert.rejects(() => encryptConfig({ ...CONFIG, apiKey: "" }, CODE, FAST), /API key/);
  await assert.rejects(() => encryptConfig(CONFIG, "", FAST), /encryption passphrase/);
});

test("Round count in the ciphertext header is capped to a sane range, so it can't be used to freeze the browser", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  // First 4 bytes are big-endian rounds; change it to 2 billion
  const body = Buffer.from(blob.slice("PCAI1.".length).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  body.writeUInt32BE(2_000_000_000, 0);
  const evil = "PCAI1." + body.toString("base64url");
  await assert.rejects(() => decryptConfig(evil, CODE), /header is abnormal/);
});
