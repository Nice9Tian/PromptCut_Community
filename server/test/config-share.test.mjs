// 加密分发的往返测试。直接跑前端那份 configShare.ts(Node 24 原生剥类型),
// 免得测试里再抄一份实现——抄一份就迟早和真代码跑偏。
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
// 正式默认 60 万轮,测试里没必要每次都烧;轮数写在密文头里,解密照样认
const FAST = { iterations: 20_000 };

test("加密再解密拿回原样的配置", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  assert.ok(looksLikeShareBlob(blob));
  assert.deepEqual(await decryptConfig(blob, CODE), CONFIG);
});

test("密文里不出现明文 Key", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  assert.ok(!blob.includes("sk-test"));
  assert.ok(!blob.includes(CONFIG.baseUrl));
});

test("同一份配置每次加密结果都不同(salt / iv 是随机的)", async () => {
  const a = await encryptConfig(CONFIG, CODE, FAST);
  const b = await encryptConfig(CONFIG, CODE, FAST);
  assert.notEqual(a, b);
});

test("换一台机器解不开", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  await assert.rejects(() => decryptConfig(blob, machineCode("win:another-machine")), /解不开/);
});

test("抄码时的大小写、分隔符、形近字都能容错", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  for (const variant of [CODE.toLowerCase(), CODE.replace(/-/g, ""), CODE.replace(/0/g, "O"), ` ${CODE} `]) {
    assert.equal((await decryptConfig(blob, variant)).apiKey, CONFIG.apiKey, `变体解不开:${variant}`);
  }
});

test("聊天软件插进来的换行不影响解密", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  assert.equal((await decryptConfig(blob.replace(/(.{40})/g, "$1\n"), CODE)).model, CONFIG.model);
});

test("改一个字节就解不开(GCM 校验)", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  const flipped = blob.slice(0, -6) + (blob.at(-6) === "A" ? "B" : "A") + blob.slice(-5);
  await assert.rejects(() => decryptConfig(flipped, CODE), /解不开/);
});

test("粘贴不全给出的是「截断」而不是「口令不对」", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  await assert.rejects(() => decryptConfig(blob.slice(0, 30), CODE), /截断/);
});

test("不是我们的密文时直接说清楚", async () => {
  await assert.rejects(() => decryptConfig("这是一段普通文本", CODE), /不是 PromptCut/);
  assert.equal(looksLikeShareBlob("这是一段普通文本"), false);
});

test("过期的配置拒绝导入", async () => {
  const blob = await encryptConfig({ ...CONFIG, expiresAt: Date.now() - 1000 }, CODE, FAST);
  await assert.rejects(() => decryptConfig(blob, CODE), /过期/);
});

test("没到期的配置正常导入", async () => {
  const expiresAt = Date.now() + 86_400_000;
  const blob = await encryptConfig({ ...CONFIG, expiresAt }, CODE, FAST);
  assert.equal((await decryptConfig(blob, CODE)).expiresAt, expiresAt);
});

test("空 Key 和空口令都当场拦下", async () => {
  await assert.rejects(() => encryptConfig({ ...CONFIG, apiKey: "" }, CODE, FAST), /API Key/);
  await assert.rejects(() => encryptConfig(CONFIG, "", FAST), /口令/);
});

test("密文头里的轮数被限制在合理范围,不给拿来卡死浏览器", async () => {
  const blob = await encryptConfig(CONFIG, CODE, FAST);
  // 头 4 字节是大端轮数,把它改成 20 亿
  const body = Buffer.from(blob.slice("PCAI1.".length).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  body.writeUInt32BE(2_000_000_000, 0);
  const evil = "PCAI1." + body.toString("base64url");
  await assert.rejects(() => decryptConfig(evil, CODE), /头部异常/);
});
