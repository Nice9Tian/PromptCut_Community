/**
 * 舞台里卡片代码能引的页面自带模块(`docs/plan/online-card-exec-contract.md` 第 2 节)。
 * **只给舞台用**(由舞台那一侧按需载入);靠 Vite 的 `import.meta.glob`,Node 单测载不进来。
 *
 * - 包:与桌面 `create_card` 的白名单一致,少 `three/` 下的子路径。都是页面自己用的那一个实例
 *   (同一个 React、同一个 Motion —— 卡片的组件要挂进页面的 React 树)。
 * - 内置模块:`src/cards/`(用户卡目录除外)、`src/parts/`、`src/kernel/`,以及 `src/render/cards/graphValues.ts`。
 *   表是**随本模块一起载入**的(`eager`),不是每个模块各自按需载入:实测按需载入会让打包器把页面主块拆成
 *   一百多个小块(在线构建的文件数 26 → 134),开页面多出一百多个请求;随本模块载入只多三四个文件,
 *   主块大小不变。已经在页面主块里的模块,这里拿到的就是页面那一个实例。重的包(`three` 等)仍按需载入。
 */
import type { HostModules } from "./loader.ts";
import { CARD_PACKAGES } from "./protocol.ts";
import { isBuiltinModulePath } from "./resolve.ts";

const packages: Record<string, () => Promise<unknown>> = {
  "react": () => import("react"),
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "react-dom": () => import("react-dom"),
  "motion": () => import("motion"),
  "motion/react": () => import("motion/react"),
  "three": () => import("three"),
  "lottie-web": () => import("lottie-web"),
  "@tsparticles/engine": () => import("@tsparticles/engine"),
  "@tsparticles/slim": () => import("@tsparticles/slim"),
};

const globbed = import.meta.glob([
  "/src/cards/**/*.{ts,tsx,mjs}", "/src/parts/**/*.{ts,tsx,mjs}", "/src/kernel/**/*.{ts,tsx,mjs}", "/src/render/cards/graphValues.ts",
  "!/src/cards/user/**", "!/src/**/*.test.{ts,tsx,mjs,js}", "!/src/**/*.d.{ts,mts}",
], { eager: true });

const builtin = new Map<string, () => unknown>();
for (const [file, load] of Object.entries(globbed)) {
  const path = file.replace(/^\//, "");
  if (isBuiltinModulePath(path)) builtin.set(path, () => load);
}

/** 白名单与这张表要一一对上(单测 `cardRuntime.test.mjs` 核文本) */
export const HOST_PACKAGE_NAMES: readonly string[] = Object.freeze(Object.keys(packages));
if (import.meta.env.DEV && (HOST_PACKAGE_NAMES.length !== CARD_PACKAGES.length || CARD_PACKAGES.some((n) => !Object.hasOwn(packages, n)))) {
  console.error("[cardRuntime] 包的表与白名单对不上", HOST_PACKAGE_NAMES, CARD_PACKAGES);
}

export const stageHostModules: HostModules = {
  packages,
  builtin: (path) => builtin.get(path) ?? null,
};
