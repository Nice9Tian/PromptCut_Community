/**
 * 「发出去的模型名」必须和「面板上显示的」是同一个。跑:node --test src/ai/modelPicked.test.mjs
 *
 * 钉住的是一个真事故:agy 那边收到 `gemini-3.8.flash`(正确写法是 `gemini-3.8-flash-low`),
 * 当场退出。而面板上模型选择器显示的是「默认」—— 因为 ModelBar 拿 normalizeModel
 * 过滤了一道,发请求那条路却直接用 localStorage 的原值。两边算的不是同一份,
 * 用户看着一切正常,只是永远等不到回复。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { modelsFor, normalizeModel } from "./modelOptions.ts";

const cfg = {
  api: { model: "gpt-4o|gpt-4o-mini" },
  cliModels: { claude: "opus|sonnet", codex: "gpt-5.6-terra", agy: "gemini-3.8-flash-low|gemini-3.1-pro-high" },
};

test("清单从哪来:api 读 api.model,三家 CLI 各读自己那条", () => {
  assert.deepEqual(modelsFor("api", cfg), ["gpt-4o", "gpt-4o-mini"]);
  assert.deepEqual(modelsFor("claude", cfg), ["opus", "sonnet"]);
  // agy 的档位编在名字里,面板上列的是基名(配对规则见 agyEffort.test.mjs)
  assert.deepEqual(modelsFor("agy", cfg), ["gemini-3.8-flash", "gemini-3.1-pro"]);
});

test("没配清单、或者根本没有 config:是空数组,不是抛出去", () => {
  assert.deepEqual(modelsFor("agy", null), []);
  assert.deepEqual(modelsFor("agy", { cliModels: {} }), []);
  assert.deepEqual(modelsFor("api", {}), []);
});

test("不在清单里的名字一律退回「默认」——事故里那个点号写法就该被拦在这儿", () => {
  const models = modelsFor("agy", cfg);
  assert.equal(normalizeModel("gemini-3.8.flash", models), "", "写错一个字符就不该发出去");
  // 清单折成基名了,所以对得上的是基名;带后缀那种老写法由 pairModelEffort 先折回来
  assert.equal(normalizeModel("gemini-3.8-flash", models), "gemini-3.8-flash");
});

test("清单空的时候,任何存着的旧名字都要退回「默认」", () => {
  // 用户在设置里把 agy 的模型清单清空了,localStorage 里还留着上次选的名字
  assert.equal(normalizeModel("gemini-3.8-flash-low", modelsFor("agy", { cliModels: { agy: "" } })), "");
});

test("换了驱动之后,上一家的模型名不会跟着过去", () => {
  // 每家的选择是分开记的,但清单也得按家算 —— 拿 claude 的名字去 agy 的清单里找不到
  assert.equal(normalizeModel("opus", modelsFor("agy", cfg)), "");
  assert.equal(normalizeModel("gemini-3.8-flash-low", modelsFor("claude", cfg)), "");
  assert.equal(normalizeModel("gpt-4o", modelsFor("codex", cfg)), "");
});
