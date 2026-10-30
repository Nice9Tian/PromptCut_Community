/**
 * 在线卡片运行时版本(`docs/plan/online-card-exec-contract.md` 第 5 节):加载规则的版本 + 转译器与 Tailwind 的版本。
 *
 * 进什么:转译缓存的键、舞台里已载入模块的代、成本记录的设备串、纯浏览器节点做用户卡与素材效果卡任务时的环境指纹。
 * 声音产物的键不带它(主会话 2026-10-06 裁定:与桌面产物通用)。
 *
 * - `CARD_RUNTIME_ABI`:改了模块解析规则、写法预检规则、声音线程的模块表、转译选项,就加一。
 * - 转译器与 Tailwind 的版本由在线构建以 `__PC_CARD_RUNTIME_DEPS__` 注入(`vite.config.ts`,取自实际装的那一版);
 *   开发服务器、桌面构建、Node 单测里没有它,写 `dev`(这些环境不执行同步来的卡,也不当纯浏览器节点)。
 */
declare const __PC_CARD_RUNTIME_DEPS__: { sucrase?: string; tailwindcss?: string } | undefined;

export const CARD_RUNTIME_ABI = "ocr2";

const deps = typeof __PC_CARD_RUNTIME_DEPS__ === "object" && __PC_CARD_RUNTIME_DEPS__ ? __PC_CARD_RUNTIME_DEPS__ : null;

export function cardRuntimeVersionOf(abi: string, d: { sucrase?: string; tailwindcss?: string } | null): string {
  return `${abi}:sucrase@${d?.sucrase || "dev"}:tailwindcss@${d?.tailwindcss || "dev"}`;
}

/** 形如 `ocr2:sucrase@3.35.1:tailwindcss@4.3.3` */
export const CARD_RUNTIME_VERSION: string = cardRuntimeVersionOf(CARD_RUNTIME_ABI, deps);
