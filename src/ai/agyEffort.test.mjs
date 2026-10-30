/**
 * agy 的「模型名 + 思考档」配对。跑:node --test src/ai/agyEffort.test.mjs
 *
 * agy 把档位编在模型名里(gemini-3.8-flash-low),同时又收 --effort,两者必须配对,
 * 配不上它当场拒整轮。下面这几条规则是对着真 CLI 一条条试出来的:
 *
 *   --model gemini-3.8-flash-low --effort low    ✓
 *   --model gemini-3.8-flash-low --effort high   ✗ invalid model selection
 *   --model gemini-3.8-flash     --effort low    ✓ 基名 + 档位,和第一条等价
 *   --model gemini-3.8-flash                     ✗ requires --effort (available: low, medium, high)
 *   --model gemini-3.1-pro       --effort medium ✗ has no "medium" effort (available: low, high)
 *   --model claude-sonnet-4-6    --effort low    ✗ --effort is not supported for this model
 *
 * 最后两条是重点:**档位是按模型算的**,不是一张固定的表。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { agyGroups, modelsFor, effortsFor, pairModelEffort } from "./modelOptions.ts";

/** 照着这台机器上 `agy models` 的真实输出裁的 */
const AGY_LIST = [
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
  "gemini-3.1-pro-high", "gemini-3.1-pro-low",
  "claude-sonnet-4-6", "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
].join("|");
const cfg = { cliModels: { agy: AGY_LIST } };

test("带档位后缀的名字折成一个模型,档位数出来", () => {
  assert.deepEqual(agyGroups(AGY_LIST.split("|")), [
    { base: "gemini-3.8-flash", efforts: ["low", "medium", "high"] },
    // 清单里就没有 medium —— 不能硬塞一个 agy 会拒的档位进去
    { base: "gemini-3.1-pro", efforts: ["low", "high"] },
    { base: "claude-sonnet-4-6", efforts: [] },
    // -thinking 不是档位后缀,不许被当成档位剥掉
    { base: "claude-opus-4-6-thinking", efforts: [] },
    { base: "gpt-oss-120b", efforts: ["medium"] },
  ]);
});

test("面板上的模型下拉框列的是基名,不再是一行一个档位", () => {
  assert.deepEqual(modelsFor("agy", cfg), [
    "gemini-3.8-flash", "gemini-3.1-pro", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b",
  ]);
  // 别家不受影响
  assert.deepEqual(modelsFor("claude", { cliModels: { claude: "opus|sonnet" } }), ["opus", "sonnet"]);
});

test("思考下拉框按模型给档位,不是一张固定表", () => {
  assert.deepEqual(effortsFor("agy", "gemini-3.8-flash", cfg), ["low", "medium", "high"]);
  assert.deepEqual(effortsFor("agy", "gemini-3.1-pro", cfg), ["low", "high"], "它没有 medium");
  assert.deepEqual(effortsFor("agy", "claude-sonnet-4-6", cfg), [], "一档都没有,界面上该灰掉");
  // 没选模型时用 agy 自己的默认模型,配什么档它都收
  assert.ok(effortsFor("agy", "", cfg).includes(""));
});

test("发出去的一对一定配得上", () => {
  assert.deepEqual(pairModelEffort("agy", "gemini-3.8-flash", "medium", cfg),
    { model: "gemini-3.8-flash", effort: "medium" });
  // 这个模型没有 medium:往下取一档,宁可比要的轻,也别背着用户更贵更慢地跑
  assert.deepEqual(pairModelEffort("agy", "gemini-3.1-pro", "medium", cfg),
    { model: "gemini-3.1-pro", effort: "low" });
  // 不吃档位的模型:把档位清掉,不然 agy 会拒
  assert.deepEqual(pairModelEffort("agy", "claude-sonnet-4-6", "high", cfg),
    { model: "claude-sonnet-4-6", effort: "" });
  // 要求必须有档位的模型:存着的是「默认」也得给它补一档出来
  assert.equal(pairModelEffort("agy", "gemini-3.8-flash", "", cfg).effort, "low");
});

test("早先存的带后缀写法照样认,并且当初选的那档兜底", () => {
  // 清单换成基名之后,老的 localStorage 里还是 gemini-3.8-flash-low
  assert.deepEqual(pairModelEffort("agy", "gemini-3.8-flash-low", "medium", cfg),
    { model: "gemini-3.8-flash", effort: "medium" }, "存着的档位有效就听它的");
  assert.deepEqual(pairModelEffort("agy", "gemini-3.1-pro-high", "medium", cfg),
    { model: "gemini-3.1-pro", effort: "high" }, "存着的档位这模型没有,退回名字里那档");
});

test("别的驱动一个字都不动", () => {
  for (const p of ["claude", "codex", "api"]) {
    assert.deepEqual(pairModelEffort(p, "gpt-5.6-terra-low", "high", cfg),
      { model: "gpt-5.6-terra-low", effort: "high" }, `${p} 不该被剥后缀`);
  }
  assert.deepEqual(pairModelEffort("agy", "", "high", cfg), { model: "", effort: "high" }, "没选模型就别管");
});
