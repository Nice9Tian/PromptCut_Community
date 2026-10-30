/**
 * 在线浏览器执行用户卡与素材效果卡:编辑页面 → 舞台 / 声音线程之间传的数据形状
 * (`docs/plan/online-card-exec-contract.md` 第 1、2、8 节)。只有类型与常量,哪一侧都能引。
 *
 * 流程:编辑页面取到内容库的卡片源码 → 转译、解析每个导入(`transpile.ts`)→ 一张卡一个 `CardBundle` →
 * 经舞台 RPC 发给舞台 → 舞台里的加载器(`loader.ts`)执行、取出卡片定义、报回运行状态。
 * 编辑页面的源里从不执行 `CardModule.js`。
 */
import type { CardRunState } from "../../kernel/registry.ts";

export type { CardRunState, CardRunStateName } from "../../kernel/registry.ts";

/** 卡片能引的包(与桌面 `create_card` 的白名单一致,少 `three/` 下的子路径;契约第 2 节) */
export const CARD_PACKAGES: readonly string[] = Object.freeze([
  "react", "react/jsx-runtime", "react-dom", "motion", "motion/react", "three", "lottie-web", "@tsparticles/engine", "@tsparticles/slim",
]);

/** 一个导入解析到哪里 */
export type ResolvedImport =
  /** 页面自带的包 */
  | { kind: "package"; name: string }
  /** 内容库同步来的源码(同一个包里的另一个模块) */
  | { kind: "synced"; key: string }
  /** 页面自带的内置模块(仓库相对路径,如 `src/cards/native/hud.tsx`) */
  | { kind: "builtin"; path: string }
  /** 同步来的样式文件:不执行,文本在 `CardBundle.styles` 里 */
  | { kind: "style"; key: string };

/** 一个转译好的模块 */
export interface CardModule {
  /** 内容库的键(仓库相对路径) */
  key: string;
  /** 内容库的内容哈希(模块实例按「键 + 哈希」缓存,哈希没变不重新执行) */
  hash: string;
  /** CommonJS 文本 */
  js: string;
  /** 源码里写的说明符 → 解析结果(转译结果里 `require("<说明符>")` 的每一个都在这里) */
  imports: Record<string, ResolvedImport>;
}

/** 一张卡的入口文件连同它的闭包 */
export interface CardBundle {
  /** 在线卡片运行时版本(`version.ts`);与舞台自己的不同就不载入 */
  runtime: string;
  /** 入口文件的键(`src/cards/user/<名>.tsx`) */
  entry: string;
  /** 闭包里的模块,入口在第一个 */
  modules: CardModule[];
  /** 同步来的样式文件(键与文本) */
  styles: { key: string; hash: string; css: string }[];
  /** 按闭包源码里出现的类名补生成的 Tailwind 样式(只有主题变量与工具类两层);没有为空串 */
  tailwind: string;
  /** 这一代的签名:运行时版本 + 闭包里每个文件的键与哈希。变了才换代 */
  generation: string;
}

/** 转译这一步对一张卡的结论 */
export type BundleResult =
  | { ok: true; entry: string; bundle: CardBundle }
  | { ok: false; entry: string; state: CardRunState };

/** 加载器对一个包的结论 */
export type LoadResult =
  | { ok: true; entry: string; generation: string; cardIds: string[] }
  | { ok: false; entry: string; generation: string; state: CardRunState };
