// Card overlay layer (server/card-overrides.mjs): card edits in installed version write to
// data directory; patches overwriting runtime/app do not lose changes
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

test("reads the base copy when unmodified", () => {
  assert.equal(m.readEffective(root, card), "base");
});

test("writing a card into the overlay layer leaves the base copy untouched, and reads return the copy in the overlay layer", () => {
  const written = m.writeCardFile(root, card, "edited");
  assert.equal(written, path.join(over, "src", "cards", "native", "x.tsx"));
  assert.equal(fs.readFileSync(card, "utf8"), "base");
  assert.equal(m.readEffective(root, card), "edited");
  assert.equal(m.effectivePath(root, card), written);
});

test("an overlay layer file can be traced back to its original file in the repo", () => {
  const o = m.overrideFileFor(root, card);
  assert.equal(path.resolve(m.repoFileForOverride(root, o)), path.resolve(card));
  assert.equal(m.repoFileForOverride(root, path.join(os.tmpdir(), "elsewhere.tsx")), null);
});

test("files other than cards / parts do not go into the overlay layer", () => {
  assert.equal(m.overrideFileFor(root, kernel), null);
  const written = m.writeCardFile(root, kernel, "k2");
  assert.equal(written, kernel);
});

test("without an injected algorithm the code hash is an empty string; once injected it is computed by id", () => {
  assert.equal(m.cardCodeHash("x"), "");
  m.setCardHasher((id) => `h-${id}`);
  assert.equal(m.cardCodeHash("x"), "h-x");
  assert.equal(m.cardCodeHash(""), "");
});

test("change notifications reach every subscriber, and one failing does not affect the others", () => {
  const got = [];
  const off1 = m.onCardSourceChange(() => { throw new Error("boom"); });
  const off2 = m.onCardSourceChange((f) => got.push(f));
  m.emitCardSourceChange("a.tsx");
  off1(); off2();
  m.emitCardSourceChange("b.tsx");
  assert.deepEqual(got, ["a.tsx"]);
});
