/**
 * 在隔离环境里执行转译好的卡片模块(`docs/plan/online-card-exec-contract.md` 第 2、8 节)。
 *
 * **只许在跨源舞台与舞台起的声音线程里用。** 编辑页面、同源单舞台、导出页不建加载器(守门测试
 * `cardRuntime.test.mjs` 钉住:`src/editor/`、`src/export/` 不引本文件)。本文件不碰 DOM、不碰网络:
 * 样式怎么注入、定义交给谁、状态报给谁,都由创建者给的回调做,所以舞台与声音线程用同一份。
 *
 * 一个包(`CardBundle`)= 一张卡的入口加闭包。载入的步骤:
 *   1. 把闭包里用到的页面自带模块(包与内置模块)先取到(它们有的要按需载入,而执行是同步的);
 *   2. 从入口起按 CommonJS 的办法执行:`new Function("require", "module", "exports", 代码)`;
 *      模块实例按包分开(一张卡一套:闭包里任何一个文件变了,整张卡重新执行,不会有没变的模块攥着旧依赖);
 *      所以两张卡引同一份同步来的文件时各有各的实例,与桌面不同(桌面是同一个),模块级的状态不在卡之间共享;
 *      页面自带的模块始终是页面那一个实例;有环照 CommonJS 处理;
 *   3. 入口导出里长得像卡片定义的(结构判断同桌面的 `src/cards/user/index.ts`)都收下。
 * 任何一步不成,这个包不生效,给出运行状态(`missing-module` / `unsupported-syntax` / `load-error`)。
 * 新一代载入失败时旧一代也撤下:不拿旧代码画新版本。
 */
import type { CardDef } from "../../kernel/types.ts";
import type { CardBundle, CardModule, CardRunState, LoadResult, ResolvedImport } from "./protocol.ts";

/** 页面自带模块的表(舞台用 `hostModules.ts` 的那一张;声音线程用带占位的那一张) */
export interface HostModules {
  /** 包名 → 取模块的函数(可以是异步的按需载入);表里没有的包不给引 */
  packages: Readonly<Record<string, () => unknown | Promise<unknown>>>;
  /** 内置模块的仓库相对路径 → 取模块的函数;没有回 null */
  builtin: (path: string) => (() => unknown | Promise<unknown>) | null;
}

export interface CardLoaderOptions {
  /** 本环境的在线卡片运行时版本;包的版本不同就不载入 */
  runtime: string;
  host: HostModules;
  /**
   * 把 CommonJS 文本编成函数。缺省 `new Function`(舞台的内容安全策略带 `'unsafe-eval'`)。
   * 开了 Trusted Types 的环境由创建者给一个走策略的实现。
   */
  compile?: (code: string, key: string) => (require: (spec: string) => unknown, module: { exports: unknown }, exports: unknown) => void;
  /**
   * 这张卡的样式变了:`css` 是它此刻该有的全部样式(同步来的样式文件在前、Tailwind 补生成的在后),
   * 空串 = 撤掉。舞台里换一个 `<style data-pc-card-style="<入口>">`;声音线程不给这个回调。
   */
  onStyle?: (entry: string, css: string) => void;
  /** 每份 CSS 独立注入，Tailwind 最后；保留各文件 @import 在自己的样式表开头。提供时优先于 onStyle。 */
  onStyles?: (entry: string, cssFiles: readonly string[]) => void;
  /** 载入成功的卡片定义整份换了(所有包合在一起;同一 id 多个包都有时取入口键靠前的) */
  onCards?: (defs: CardDef<any>[]) => void;
  /** 各入口的结论换了(入口键 → 结论);创建者据此算每张卡的运行状态报给编辑页面 */
  onResults?: (results: ReadonlyMap<string, LoadResult>) => void;
}

export interface CardLoader {
  /**
   * 整份换成这一组包(编辑页面每次同步后发来的全量)。没变的包(同一代)不动、不重新执行;
   * 不在这一组里的撤下。回每个入口的结论。并发调用时后来的那次等前一次做完。
   */
  setBundles(bundles: readonly CardBundle[]): Promise<LoadResult[]>;
  /** 此刻载入成功的卡片定义 */
  cards(): CardDef<any>[];
  /** 各入口此刻的结论 */
  results(): ReadonlyMap<string, LoadResult>;
  /** 全部撤下(舞台卸载、退回同源单舞台时) */
  clear(): void;
}

interface Instance { module: { exports: unknown }; done: boolean }
interface Loaded { bundle: CardBundle; result: LoadResult; defs: CardDef<any>[] }

/** 结构判断:长得像 CardDef 的导出(同 `src/cards/user/index.ts` 的 `isCardDef`) */
export function isCardDef(value: unknown): value is CardDef<any> {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<CardDef<any>>;
  return typeof c.id === "string" && !!c.id && typeof c.name === "string" && !!c.defaults && typeof c.defaults === "object" && Array.isArray(c.controls)
    && (typeof c.Component === "function" || typeof c.card === "function" || typeof c.audio === "function");
}

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split("\n")[0].slice(0, 200);

const defaultCompile: NonNullable<CardLoaderOptions["compile"]> = (code, key) =>
  // sourceURL:出错时堆栈里看得到是哪一个同步来的文件
  new Function("require", "module", "exports", `${code}\n//# sourceURL=pc-card:///${key}`) as ReturnType<NonNullable<CardLoaderOptions["compile"]>>;

export function createCardLoader(opts: CardLoaderOptions): CardLoader {
  const compile = opts.compile ?? defaultCompile;
  /** 入口键 → 已载入的包 */
  const loaded = new Map<string, Loaded>();
  /** 已取到的页面自带模块 */
  const hostCache = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();

  const hostKey = (r: ResolvedImport) => (r.kind === "package" ? `p:${r.name}` : r.kind === "builtin" ? `b:${r.path}` : null);

  /** 步骤 1:这个包要的页面自带模块都取到;取不到的回它的名字 */
  async function preload(bundle: CardBundle): Promise<{ missing: string; file: string } | null> {
    for (const m of bundle.modules) {
      for (const r of Object.values(m.imports)) {
        const k = hostKey(r);
        if (!k || hostCache.has(k)) continue;
        const name = r.kind === "package" ? r.name : (r as { path: string }).path;
        const get = r.kind === "package"
          ? (Object.hasOwn(opts.host.packages, r.name) ? opts.host.packages[r.name] : null)
          : opts.host.builtin((r as { path: string }).path);
        if (!get) return { missing: name, file: m.key };
        try { hostCache.set(k, await get()); } catch { return { missing: name, file: m.key }; }
      }
    }
    return null;
  }

  /** 步骤 2、3:执行入口,收卡片定义 */
  function evaluate(bundle: CardBundle): { defs: CardDef<any>[] } | { state: CardRunState } {
    const byKey = new Map<string, CardModule>(bundle.modules.map((m) => [m.key, m]));
    /** 这个包自己的模块实例(键 → 实例) */
    const instances = new Map<string, Instance>();
    const run = (m: CardModule): unknown => {
      const hit = instances.get(m.key);
      if (hit) return hit.module.exports; // 执行到一半的(有环)回它此刻的导出
      const inst: Instance = { module: { exports: {} }, done: false };
      instances.set(m.key, inst);
      const require = (spec: string): unknown => {
        const r = Object.hasOwn(m.imports, spec) ? m.imports[spec] : undefined;
        if (!r) throw new Error(`在线页面里没有这个模块:${String(spec).slice(0, 80)}`);
        if (r.kind === "style") return {};
        if (r.kind === "synced") {
          const dep = byKey.get(r.key);
          if (!dep) throw new Error(`包里缺 ${r.key}`);
          return run(dep);
        }
        return hostCache.get(hostKey(r)!);
      };
      compile(m.js, m.key)(require, inst.module, inst.module.exports);
      inst.done = true;
      return inst.module.exports;
    };
    const entry = bundle.modules[0];
    if (!entry || entry.key !== bundle.entry) return { state: { state: "load-error", detail: "包里没有入口文件", file: bundle.entry } };
    let exports: unknown;
    try {
      exports = run(entry);
    } catch (err) {
      const syntax = err instanceof SyntaxError;
      return { state: { state: syntax ? "unsupported-syntax" : "load-error", detail: firstLine(err), file: bundle.entry } };
    }
    const defs: CardDef<any>[] = [];
    const seen = new Set<string>();
    if (exports && typeof exports === "object") {
      for (const v of Object.values(exports as Record<string, unknown>)) {
        if (isCardDef(v) && !seen.has(v.id)) { seen.add(v.id); defs.push(v); }
      }
    }
    if (!defs.length) return { state: { state: "load-error", detail: "这个文件没有导出卡片定义", file: bundle.entry } };
    return { defs };
  }

  const styleOf = (b: CardBundle) => [...b.styles.map((s) => s.css), b.tailwind].filter(Boolean).join("\n");
  const setStyles = (entry: string, bundle?: CardBundle) => {
    if (opts.onStyles) opts.onStyles(entry, bundle ? [...bundle.styles.map(s => s.css), bundle.tailwind].filter(Boolean) : []);
    else opts.onStyle?.(entry, bundle ? styleOf(bundle) : "");
  };

  function publish(): void {
    opts.onCards?.(api.cards());
    opts.onResults?.(api.results());
  }

  async function apply(bundles: readonly CardBundle[]): Promise<LoadResult[]> {
    const want = new Map<string, CardBundle>();
    for (const b of bundles ?? []) if (b && typeof b.entry === "string" && Array.isArray(b.modules) && !want.has(b.entry)) want.set(b.entry, b);
    let changed = false;
    for (const entry of [...loaded.keys()]) {
      if (want.has(entry)) continue;
      loaded.delete(entry);
      setStyles(entry);
      changed = true;
    }
    for (const [entry, bundle] of [...want].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const cur = loaded.get(entry);
      if (cur && cur.bundle.generation === bundle.generation) continue;
      changed = true;
      const fail = (state: CardRunState) => {
        loaded.set(entry, { bundle, defs: [], result: { ok: false, entry, generation: bundle.generation, state } });
        setStyles(entry);
      };
      // 换代:旧一代先撤,新一代整张卡重新执行
      loaded.delete(entry);
      if (bundle.runtime !== opts.runtime) { fail({ state: "load-error", detail: `运行时版本不一致(页面 ${bundle.runtime},本环境 ${opts.runtime})`, file: entry }); continue; }
      const miss = await preload(bundle);
      if (miss) { fail({ state: "missing-module", detail: miss.missing, file: miss.file }); continue; }
      // 样式先于执行注入:卡片第一次挂上去时样式已经在了
      setStyles(entry, bundle);
      const out = evaluate(bundle);
      if ("state" in out) { fail(out.state); continue; }
      loaded.set(entry, { bundle, defs: out.defs, result: { ok: true, entry, generation: bundle.generation, cardIds: out.defs.map((d) => d.id) } });
    }
    if (changed) publish();
    return [...want.keys()].map((entry) => loaded.get(entry)!.result);
  }

  const api: CardLoader = {
    setBundles(bundles) {
      const next = chain.then(() => apply(bundles), () => apply(bundles));
      chain = next.catch(() => undefined);
      return next;
    },
    cards() {
      const out: CardDef<any>[] = [];
      const seen = new Set<string>();
      for (const entry of [...loaded.keys()].sort()) {
        for (const d of loaded.get(entry)!.defs) if (!seen.has(d.id)) { seen.add(d.id); out.push(d); }
      }
      return out;
    },
    results() {
      return new Map([...loaded].map(([entry, l]) => [entry, l.result]));
    },
    clear() {
      const had = loaded.size > 0;
      for (const entry of loaded.keys()) setStyles(entry);
      loaded.clear();
      if (had) publish();
    },
  };
  return api;
}

/**
 * 各入口的结论 → 每张卡的运行状态(卡片 id → 状态)。载入成功的卡是 `ready`;失败的入口没有卡片 id 可言,
 * 由调用方用静态解析出来的「入口 → 卡片 id」表(`entryCards`)摊到卡上。
 */
export function runStatesOf(results: ReadonlyMap<string, LoadResult>, entryCards: (entry: string) => readonly string[]): Map<string, CardRunState> {
  const out = new Map<string, CardRunState>();
  for (const [entry, r] of [...results].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (r.ok) { for (const id of r.cardIds) if (!out.has(id)) out.set(id, { state: "ready" }); continue; }
    for (const id of entryCards(entry)) if (!out.has(id)) out.set(id, r.state);
  }
  return out;
}
