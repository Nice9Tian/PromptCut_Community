/**
 * 编辑页面里转译同步卡的入口(`docs/plan/online-card-exec-contract.md` 第 1 节)。**按需载入**:
 * `Preview.tsx` 只在本页能执行同步来的卡(`gate.ts`)、且项目里有这样的卡时才 `import()` 它 ——
 * Sucrase 与 Tailwind 编译器都在这一块里,不进主块。只在浏览器里用(`?raw`、IndexedDB)。
 */
import theme from "tailwindcss/theme.css?raw";
import utilities from "tailwindcss/utilities.css?raw";
import { builtinCardSourceFiles } from "../../render/cardSourceFiles.mjs";
import { CARD_RUNTIME_VERSION } from "./version.ts";
import { bundleCard } from "./transpile.ts";
import { createTranspileCache } from "./transpileCache.ts";
import { createCardCssCompiler } from "./tailwind.ts";
import { isBuiltinModulePath } from "./resolve.ts";
import { cardCodeIdentityOf } from "./codeIdentity.ts";
import type { BundleResult } from "./protocol.ts";

export interface BundleJob {
  /** 入口文件的键 */
  entries: readonly string[];
  /** 内容库里这个键的正文与哈希 */
  read: (key: string) => { body: string; hash: string } | null;
}

const cache = createTranspileCache(CARD_RUNTIME_VERSION);
let warmed: Promise<void> | null = null;
const css = createCardCssCompiler({ theme, utilities });
/** 页面自带的内置模块:源码表的键是 `/src/...`,有原文就是页面里有这个模块 */
const hasBuiltin = (path: string) => isBuiltinModulePath(path) && Object.hasOwn(builtinCardSourceFiles, `/${path}`);
const builtinHashes = new Map<string, string>();

/** 每个入口一张卡:转译成包,或给出运行状态。顺序同 `entries`。 */
export async function bundleCards(job: BundleJob): Promise<BundleResult[]> {
  await (warmed ??= cache.warm());
  const out: BundleResult[] = [];
  for (const entry of job.entries) out.push(await bundleCard({ runtime: CARD_RUNTIME_VERSION, entry, read: job.read, hasBuiltin, css, cache }));
  return out;
}

/** 每个入口的代码身份(纯浏览器节点报 `cardSourceVersions`、发清单计划时用);算不出的不在结果里 */
export async function codeIdentities(job: BundleJob): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const files = { synced: job.read, builtin: (path: string) => (Object.hasOwn(builtinCardSourceFiles, `/${path}`) ? String(builtinCardSourceFiles[`/${path}`]) : null) };
  for (const entry of job.entries) {
    const id = await cardCodeIdentityOf(entry, files, { builtinHashes });
    if (id) out[entry] = id.version;
  }
  return out;
}

export { CARD_RUNTIME_VERSION };
