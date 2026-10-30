/*
 * 云端 AI 提供方的**浏览器侧注册**（公开侧）。由页面启动序列 `src/online/pageBoot.ts` 引一次。
 *
 * ── 为什么必须是同步的、而且在入口 ──
 *
 * `src/ai/extensions.ts` 的 `useCloudAgent` / `useCloudDigest` / `useCloudChat` / `useCloudNotices`
 * 都是转发给 `currentProvider` 的。社区版缺省那几个几乎不调 hook，云端真实现（`useCloud.ts`）
 * 调一大串。所以**提供方一旦在两次渲染之间被换掉，同一个组件的 hook 数量就变了** ——
 * React 当场抛：
 *
 *     React has detected a change in the order of Hooks called by AiPanel
 *     The final argument passed to useSyncExternalStore changed size between renders
 *     TypeError: Cannot read properties of null (reading 'getSnapshot')
 *
 * 2026-10-28 的局域网端到端探针就是这么崩的：`AiPanel` 抛出去把半棵树带走，协作设置那一段
 * 根本没渲染出来，探针等不到邀请链接（而服务端的 `invite-create` 其实已经成了）。
 * 这个文件的第一版写成「模块被引到就 `void` 一个异步 import」，正是在造那个中途替换。
 *
 * 所以：**静态 import + 同步 apply，并且由入口引**。两条缺一不可 ——
 *   - 静态 import：云端表在本模块函数体之前求值完（ES 模块深度优先），不存在「之后才换上」；
 *   - 由入口引：`CloudAiPanel` 那种深在树里、可能懒加载的地方引它，注册仍然可能晚于首次渲染。
 *
 * 社区版里这个别名解析到空桩（`src/community/cloudSeamStub.ts`），什么都不导出 ——
 * `applyAiManifest` 拿不到表，公开侧的「云端关着」缺省一直生效，也就不存在替换。
 */
import { applyAiManifest } from "./extensions.ts";
// 云端 AI 加载表。社区版是空桩；说明符必须是字面量，Vite 才解析得到
import * as cloudAi from "#promptcut-cloud-ai";

/** 入口调一次。返回有没有真的登记上云端提供方（社区版是 false）。 */
export function registerAiCloudProviderFromTable(): boolean {
  const table = cloudAi.manifest ?? cloudAi.default;
  if (!table) return false;
  return applyAiManifest(table).length > 0;
}
