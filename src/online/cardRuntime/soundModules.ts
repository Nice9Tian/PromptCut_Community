/**
 * 声音线程里卡片代码能引的模块(`docs/plan/online-card-exec-contract.md` 3.5)。**只给声音线程用**(`soundWorker.ts`);
 * 靠 Vite 的 `import.meta.glob`,Node 单测载不进来(占位的行为在 `soundStub.ts`,单测核那一份)。
 *
 * - 包:`react`、`react/jsx-runtime`、`motion`、`motion/react`、`three` 给真的(载入失败就给占位,不让一个包拖垮整张卡);
 *   `react-dom`、`lottie-web`、`@tsparticles/*` 一载入就要 DOM,给占位:引进来不报错,用到才抛「声音代码里不能用 <名字>」。
 * - 内置模块:`src/kernel/` 与 `src/render/cards/graphValues.ts` 给真的(纯计算,声音代码常用的配方、取值都在这里);
 *   `src/cards/`、`src/parts/` 下不带 JSX 的文件(`.ts` / `.mjs`,例如 `cards/native/sound-effects.ts`)**用到才载入**,
 *   载入失败给占位;带 JSX 的组件文件(`.tsx`)一律给占位 —— 它们是画面,声音代码用不着,载入它们会把样式与整棵组件树拖进线程。
 *
 * 与舞台那一张(`hostModules.ts`)的包名单一一对应,只是其中几个是占位。
 */
import type { HostModules } from "./loader.ts";
import { CARD_PACKAGES } from "./protocol.ts";
import { isBuiltinModulePath } from "./resolve.ts";
import { createSoundStub, realOrStub } from "./soundStub.ts";

const stub = (name: string) => () => createSoundStub(name);

const packages: Record<string, () => unknown | Promise<unknown>> = {
  "react": realOrStub("react", () => import("react")),
  "react/jsx-runtime": realOrStub("react/jsx-runtime", () => import("react/jsx-runtime")),
  "react-dom": stub("react-dom"),
  "motion": realOrStub("motion", () => import("motion")),
  "motion/react": realOrStub("motion/react", () => import("motion/react")),
  "three": realOrStub("three", () => import("three")),
  "lottie-web": stub("lottie-web"),
  "@tsparticles/engine": stub("@tsparticles/engine"),
  "@tsparticles/slim": stub("@tsparticles/slim"),
};

/** 纯计算的内置模块:随线程一起载入 */
const pure = import.meta.glob([
  "/src/kernel/**/*.{ts,mjs}", "/src/render/cards/graphValues.ts",
  "!/src/**/*.test.{ts,tsx,mjs,js}", "!/src/**/*.d.{ts,mts}",
], { eager: true });
/** 卡片与部件目录下不带 JSX 的文件:用到才载入 */
const lazy = import.meta.glob([
  "/src/cards/**/*.{ts,mjs}", "/src/parts/**/*.{ts,mjs}",
  "!/src/cards/user/**", "!/src/**/*.test.{ts,tsx,mjs,js}", "!/src/**/*.d.{ts,mts}",
  // 汇总文件把整棵组件树连同样式一起引进来:构建产物里线程打成一个文件,样式会在线程启动时往 `document` 里注入
  // (线程里没有 `document`,整条线程起不来)。它们是画面那一半的东西,在声音线程里给占位
  "!/src/cards/**/index.ts", "!/src/parts/**/index.ts", "!/src/cards/native/batch-*.ts", "!/src/cards/userOverlay.ts", "!/src/cards/_probe/**",
]);

const builtin = new Map<string, () => unknown | Promise<unknown>>();
for (const [file, mod] of Object.entries(pure)) {
  const path = file.replace(/^\//, "");
  if (isBuiltinModulePath(path)) builtin.set(path, () => mod);
}
for (const [file, load] of Object.entries(lazy)) {
  const path = file.replace(/^\//, "");
  if (isBuiltinModulePath(path) && !builtin.has(path)) builtin.set(path, realOrStub(path, load as () => Promise<unknown>));
}

export const SOUND_PACKAGE_NAMES: readonly string[] = Object.freeze(Object.keys(packages));
if (import.meta.env.DEV && (SOUND_PACKAGE_NAMES.length !== CARD_PACKAGES.length || CARD_PACKAGES.some((n) => !Object.hasOwn(packages, n)))) {
  console.error("[cardRuntime] 声音线程的包表与白名单对不上", SOUND_PACKAGE_NAMES, CARD_PACKAGES);
}

export const soundHostModules: HostModules = {
  packages,
  // 范围之内、表里没有的(组件文件 `.tsx`、kernel 里带 JSX 的):占位;范围之外的照旧不给引
  builtin: (path) => builtin.get(path) ?? (isBuiltinModulePath(path) ? stub(path) : null),
};
