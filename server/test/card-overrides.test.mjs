// 卡片改动层(server/card-overrides.mjs):装机版改卡写进数据目录,补丁覆盖 runtime/app 时改动不丢
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-root-"));
const over = fs.mkdtempSync(path.join(os.tmpdir(), "pc-over-"));
fs.mkdirSync(path.join(root, "src", "cards", "native"), { recursive: true });
fs.mkdirSync(path.join(root, "src", "kernel"), { recursive: true });
const card = path.join(root, "src", "cards", "native", "x.tsx");
fs.writeFileSync(card, "base");
const kernel = path.join(root, "src", "kernel", "k.ts");
fs.writeFileSync(kernel, "kernel");

process.env.PROMPTCUT_CARD_OVERRIDES = over;
const m = await import("../card-overrides.mjs");

test("没改过时读底版", () => {
  assert.equal(m.readEffective(root, card), "base");
});

test("写卡片进改动层,底版不动,读到改动层那一份", () => {
  const written = m.writeCardFile(root, card, "edited");
  assert.equal(written, path.join(over, "src", "cards", "native", "x.tsx"));
  assert.equal(fs.readFileSync(card, "utf8"), "base");
  assert.equal(m.readEffective(root, card), "edited");
  assert.equal(m.effectivePath(root, card), written);
});

test("改动层文件能反查回仓库里的原文件", () => {
  const o = m.overrideFileFor(root, card);
  assert.equal(path.resolve(m.repoFileForOverride(root, o)), path.resolve(card));
  assert.equal(m.repoFileForOverride(root, path.join(os.tmpdir(), "elsewhere.tsx")), null);
});

test("卡片 / 部件以外的文件不进改动层", () => {
  assert.equal(m.overrideFileFor(root, kernel), null);
  const written = m.writeCardFile(root, kernel, "k2");
  assert.equal(written, kernel);
});

test("没注入算法时代码哈希是空串;注入后按 id 算", () => {
  assert.equal(m.cardCodeHash("x"), "");
  m.setCardHasher((id) => `h-${id}`);
  assert.equal(m.cardCodeHash("x"), "h-x");
  assert.equal(m.cardCodeHash(""), "");
});

test("变更通知送到每个订阅者,一个出错不影响别的", () => {
  const got = [];
  const off1 = m.onCardSourceChange(() => { throw new Error("boom"); });
  const off2 = m.onCardSourceChange((f) => got.push(f));
  m.emitCardSourceChange("a.tsx");
  off1(); off2();
  m.emitCardSourceChange("b.tsx");
  assert.deepEqual(got, ["a.tsx"]);
});
