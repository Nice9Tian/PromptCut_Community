/*
 * 在线构建剪枝：把**只有编辑器进程才有意义**的几个模块换成空桩（`src/online/pageFlag.ts` 的
 * 「在线构建剪枝」那一节，M8 遗留 L24）。只挂在 `vite.config.ts` 的在线那份配置上。
 *
 * ── 为什么非得这么做 ──
 *
 * 在线浏览器模式里没有编辑器进程，所以 `/api/*` 一个都打不通。契约第 2 节要求这些入口在在线
 * 构建里**连同背后的 `/api` 调用一起剪掉**，由 `server/test/c10a-online-build.test.mjs` 的
 * `C10A-API-03` 按棘轮清单核对产物。
 *
 * 但编译期常量剪不掉它。`pageFlag.ts` 那一节自己写明了：rolldown 摇树「只剪得掉就地写的函数
 * 字面量，剪不掉它引用的模块」。实际写出来的就是这两处形状：
 *
 *     src/StartPage.tsx:157        ONLINE_BUILD ? OnlineStartPage : DesktopStartPage
 *     src/editor/dock/DockPages.tsx:39  memo(ONLINE_BUILD ? OnlineAgentSwitch : AiPanel)
 *
 * 三元折叠之后那一支是死代码，但它 import 进来的模块照样留在图里。于是 2026-10-27 查出
 * 在线产物里带着 8 个桌面专用端点（`/api/ai/` 与 abort、auth-state、chat、config、
 * config/clear-key、providers、setup）。棘轮清单里 `/api/ai*` 一条都没有 —— 也就是说
 * 这 8 条全是不该在的。
 *
 * 用 `lazy()` 拆块也不行：`C10A-API-03` 扫的是产物目录下**所有** `.js`，单独一个块照样被扫到。
 * 把路径字符串挪进别的模块更不行 —— 那是让测试过去，死代码还在。所以只剩「这个模块在在线
 * 构建里根本不进产物」这一条路。
 *
 * ── 剪哪几个，依据是什么 ──
 *
 * 用 rolldown 自己的模块图算出来的（不是人猜的）：那 8 条路径只出自三个叶子模块 ——
 * `src/ai/providerState.ts`、`src/ai/useAiChat.ts`、`src/editor/right/AiSetupDialog.tsx`，
 * 而它们的 importer 闭包收口在下面这三个根上，各自**只被一处具名 import**：
 *
 *   src/editor/right/AiPanel.tsx    桌面版 AI 栏      在线换成 OnlineAgentPage（DockPages.tsx:39）
 *   src/start/DesktopStart.tsx      桌面版开始页      在线换成 OnlineStart（StartPage.tsx:157）
 *   src/mobile/AgentChatLocal.tsx   手机接本机 Agent  在线 local 恒 false（AgentPage.tsx:38）
 *
 * 三个在在线构建里**运行期都是死的**（上面三处判据都是编译期常量），所以换成空桩是安全的：
 * 不是「藏起来」，是把本来就到不了的分支从产物里拿掉。
 * 砍掉这三条边之后 `useVibeLocal` → `useAiChat` → `providerState` 和 `AiSetupDialog` 全部不可达。
 *
 * ── 加东西的时候 ──
 *
 * 这张表只许放「在线构建里运行期不可达」的模块，而且要在注释里写明判据在哪一行。
 * 判据不是编译期常量就不许进这张表 —— 那种情况该改的是代码结构，不是剪枝表。
 */
import path from "node:path";
import type { Plugin } from "vite";

/** 模块（仓库相对路径）→ 空桩导出的名字。名字要和真模块对外导出的那个一致。 */
const PRUNED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "src/editor/right/AiPanel.tsx": ["AiPanel"],
  "src/start/DesktopStart.tsx": ["DesktopStart"],
  "src/mobile/AgentChatLocal.tsx": ["AgentChatLocal"],
});

function stubFor(rel: string, names: readonly string[]): string {
  const lines = [
    `/* 在线构建剪枝后的空桩（server/vite-plugin-online-prune.ts）。真实现：${rel} */`,
    // 真渲染到就是出错了：那说明有人让这个分支在在线构建里变可达了，上面那张表的前提就不成立了
    `function pruned(name) {`,
    `  if (typeof console !== "undefined") {`,
    `    console.error("[promptcut] 在线构建里渲染了桌面专用组件 " + name + "（${rel}），它本该不可达");`,
    `  }`,
    `  return null;`,
    `}`,
  ];
  for (const n of names) lines.push(`export function ${n}() { return pruned(${JSON.stringify(n)}); }`);
  return lines.join("\n") + "\n";
}

export function onlinePrunePlugin(): Plugin {
  let root = process.cwd();
  return {
    name: "promptcut-online-prune",
    enforce: "pre",
    configResolved(cfg) {
      root = cfg.root;
    },
    load(id) {
      const clean = id.split("?")[0];
      const rel = path.relative(root, clean).split(path.sep).join("/");
      const names = PRUNED[rel];
      return names ? stubFor(rel, names) : null;
    },
  };
}

/** 给守门测试用：这张表里有哪些模块 */
export const PRUNED_MODULES = Object.freeze(Object.keys(PRUNED));

export default onlinePrunePlugin;
