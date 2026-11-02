/**
 * 云端 AI 提供方的注册**必须同步、而且在入口**。
 *
 * 为什么值得单独一条守门：`src/ai/extensions.ts` 那几个 hook 是转发给 `currentProvider` 的，
 * 社区版缺省几乎不调 hook、云端真实现调一大串。**提供方一旦在两次渲染之间被换掉，
 * 同一个组件的 hook 数量就变了**，React 当场抛：
 *
 *     React has detected a change in the order of Hooks called by AiPanel
 *     TypeError: Cannot read properties of null (reading 'getSnapshot')
 *
 * 2026-10-28 的局域网端到端探针就是这么崩的 —— `AiPanel` 抛出去把半棵树带走，
 * 协作设置那一段根本没渲染，探针等不到邀请链接（而服务端的 invite-create 其实已经成了）。
 * 当时 `extensionsBrowser.ts` 写的是「模块被引到就 void 一个异步 import」，正是在造中途替换。
 *
 * tsc、五道闸门、八千多条单测、两个构建**全都是绿的** —— 这个坑只有真把界面渲染出来才看得见。
 * 所以这里把形状钉住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("AIEXT-1 The cloud AI table is a static import and must not be swapped in asynchronously", () => {
  const src = read("src/ai/extensionsBrowser.ts");
  assert.ok(
    src.includes('import * as cloudAi from "#promptcut-cloud-ai"'),
    "Use a static import to get the cloud AI table: only a static import finishes evaluating before this module's function bodies run, so there is no \"swapped in later\"",
  );
  assert.ok(
    !src.includes("await import(") && !src.includes("void ensure") && !src.includes("Promise"),
    "No async loading is allowed in this file: async = provider swapped in after render = the same component's hook count changes = React throws",
  );
});

test("AIEXT-2 Registration happens at the entry point, not on a component", () => {
  const boot = read("src/online/pageBoot.ts");
  assert.ok(
    boot.includes("registerAiCloudProviderFromTable()"),
    "registerAiCloudProviderFromTable() must be called once in the page boot sequence",
  );

  // 组件自己不许负责注册：CloudAiPanel 深在树里、还可能懒加载，
  // 挂在它上面的话注册仍然可能晚于 AiPanel 的首次渲染
  const panel = read("src/editor/right/CloudAiPanel.tsx");
  assert.ok(
    !panel.includes("extensionsBrowser"),
    "CloudAiPanel must not import extensionsBrowser: registration belongs at the entry point, not \"whoever imports it registers\"",
  );
});

test("AIEXT-3 Registration is ordered before rendering", () => {
  // pageBoot 由 main.tsx 的第二行 import（紧跟渲染时钟），而 createRoot 在 main.tsx 末尾，
  // 所以只要注册写在 pageBoot 里就一定早于渲染。这条盯住 main.tsx 的那个次序没被人调乱。
  const main = read("src/main.tsx");
  const bootAt = main.indexOf("./online/pageBoot");
  const renderAt = main.indexOf("createRoot(");
  assert.ok(bootAt >= 0, "Does main.tsx no longer import ./online/pageBoot? The whole boot sequence is gone");
  assert.ok(renderAt >= 0, "createRoot( not found in main.tsx");
  assert.ok(
    bootAt < renderAt,
    "pageBoot must come before createRoot: the provider must be settled before React renders anything",
  );
});

