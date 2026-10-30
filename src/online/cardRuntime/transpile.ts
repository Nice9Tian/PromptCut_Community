/**
 * 把内容库同步来的卡片源码转成舞台能执行的包(`docs/plan/online-card-exec-contract.md` 第 1、2 节)。
 * 在**编辑页面**里跑:只读文本、不执行(Sucrase 不用 `eval`)。按需载入(这一串带着 Sucrase 与 Tailwind 编译器)。
 *
 * 一个文件:写法预检 → Sucrase(`typescript`、`jsx`、`imports`,JSX 用 automatic 运行时)→ CommonJS 文本,
 * 再把里面每个 `require("<说明符>")` 解析到包、同步来的源码、页面自带的内置模块或样式(`resolve.ts`)。
 * 一张卡:从入口文件起跟着同步来的相对导入收齐闭包,任何一步不成就给出这张卡的运行状态
 * (`unsupported-syntax` / `missing-module`),不出包。
 */
import { transform } from "sucrase";
import { unsupportedSyntax } from "./precheck.ts";
import { REMOTION_LOCK_CACHE_TAG, remotionLockSuffix } from "./remotionLock.mjs";
import { resolveCardImport, type ResolveEnv } from "./resolve.ts";
import { classCandidates, type CardCssCompiler } from "./tailwind.ts";
import type { BundleResult, CardBundle, CardModule, CardRunState, ResolvedImport } from "./protocol.ts";

/** 单个文件的上限(字符);超过不转 */
export const MAX_SOURCE_CHARS = 512 * 1024;
/** 一张卡的闭包最多多少个同步来的文件(与 `onlineCardSources.ts` 的 `CARD_SOURCE_MAX_DEPS` 同数) */
export const MAX_CLOSURE_FILES = 200;

export type FileResult =
  | { ok: true; js: string; specifiers: string[] }
  | { ok: false; state: CardRunState };

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split("\n")[0].slice(0, 200);

/** 转译结果里 `require("…")` 的说明符(Sucrase 的 `imports` 转换只生成字符串字面量的 `require`) */
export function requireSpecifiers(js: string): string[] {
  const out = new Set<string>();
  for (const m of js.matchAll(/\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g)) out.add(m[2]);
  return [...out];
}

/**
 * 转一个文件。`key` 用来报错、给转译器当文件名，以及算「把顶层锁成只读」那一段里的相对路径。
 * `lockSuffix`：要接在源码末尾的那一段（`remotionLock.mjs`）；不给就现算。该锁的卡才有，别的卡是空串、源码原样。
 */
export function transpileCardFile(key: string, source: string, lockSuffix?: string): FileResult {
  if (typeof source !== "string") return { ok: false, state: { state: "load-error", detail: "源码取不到", file: key } };
  if (source.length > MAX_SOURCE_CHARS) return { ok: false, state: { state: "unsupported-syntax", detail: `文件太大(超过 ${MAX_SOURCE_CHARS / 1024} KB)`, file: key } };
  try {
    const bad = unsupportedSyntax(source);
    if (bad.length) return { ok: false, state: { state: "unsupported-syntax", detail: `${bad[0].what}(第 ${bad[0].line} 行)`, file: key } };
    const js = transform(source + (lockSuffix ?? remotionLockSuffix(key, source)), {
      transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: true,
      preserveDynamicImport: true, filePath: key,
    }).code;
    return { ok: true, js, specifiers: requireSpecifiers(js) };
  } catch (err) {
    return { ok: false, state: { state: "unsupported-syntax", detail: `转译出错:${firstLine(err)}`, file: key } };
  }
}

export interface BundleInput {
  /** 在线卡片运行时版本 */
  runtime: string;
  /** 入口文件的键 */
  entry: string;
  /** 内容库里这个键的正文与哈希;没有回 null */
  read: (key: string) => { body: string; hash: string } | null;
  /** 页面自带的内置模块表里有没有这个路径 */
  hasBuiltin: (path: string) => boolean;
  /** Tailwind 补生成;不给就不生成(`tailwind` 为空串) */
  css?: CardCssCompiler;
  /** 单个文件的转译缓存(按「运行时版本 + 键 + 哈希」;`transpileCache.ts`) */
  cache?: { get: (key: string, hash: string) => FileResult | undefined; set: (key: string, hash: string, value: FileResult) => void };
}

/** 这一代的签名:运行时版本 + 闭包里每个文件的键与哈希(按键排序) */
export function generationOf(runtime: string, files: Iterable<readonly [string, string]>): string {
  return `${runtime}|${[...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, h]) => `${k}@${h}`).join("|")}`;
}

/** 一张卡:入口加闭包 → 包,或这张卡的运行状态 */
export async function bundleCard(input: BundleInput): Promise<BundleResult> {
  const { runtime, entry, read, hasBuiltin, css, cache } = input;
  const env: ResolveEnv = { hasSynced: (k) => read(k) != null, hasBuiltin };
  const fail = (state: CardRunState): BundleResult => ({ ok: false, entry, state });
  const modules: CardModule[] = [];
  const styles: CardBundle["styles"] = [];
  const sources: string[] = [];
  const hashes = new Map<string, string>();
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > MAX_CLOSURE_FILES) return fail({ state: "missing-module", detail: `这张卡引的文件太多(超过 ${MAX_CLOSURE_FILES} 个)`, file: entry });
    const file = read(key);
    if (!file) return fail({ state: "missing-module", detail: key, file: entry });
    hashes.set(key, file.hash);
    /*
     * 该锁的卡(声明成 remotion 式并且引用了框架)在源码末尾接一句「把顶层锁成只读」,转出来的文本与不接时不同,
     * 所以它在转译缓存里另用一个键(内容哈希后面带一个标记):别的卡的键不变,旧缓存照常命中;
     * 该锁的卡不会命中「没接这一段」时存下的旧结果。运行时版本(`version.ts`)因此不用动。
     */
    const lockSuffix = remotionLockSuffix(key, file.body);
    const cacheHash = lockSuffix ? `${file.hash}${REMOTION_LOCK_CACHE_TAG}` : file.hash;
    let out = cache?.get(key, cacheHash);
    if (!out) {
      out = transpileCardFile(key, file.body, lockSuffix);
      cache?.set(key, cacheHash, out);
    }
    if (!out.ok) return fail(out.state);
    sources.push(file.body);
    const imports: Record<string, ResolvedImport> = {};
    for (const spec of out.specifiers) {
      const r = resolveCardImport(key, spec, env);
      if (!r.ok) return fail({ state: "missing-module", detail: r.reason, file: key });
      imports[spec] = r.to;
      if (r.to.kind === "synced") queue.push(r.to.key);
      if (r.to.kind === "style" && !hashes.has(r.to.key)) {
        const style = read(r.to.key)!;
        hashes.set(r.to.key, style.hash);
        styles.push({ key: r.to.key, hash: style.hash, css: style.body });
        sources.push(style.body);
      }
    }
    modules.push({ key, hash: file.hash, js: out.js, imports });
  }
  let tailwind = "";
  if (css) {
    try { tailwind = await css(classCandidates(sources)); } catch { tailwind = ""; /* 样式补不出来不挡执行:卡照常跑,只是缺新类名的样式 */ }
  }
  return { ok: true, entry, bundle: { runtime, entry, modules, styles, tailwind, generation: generationOf(runtime, hashes) } };
}
