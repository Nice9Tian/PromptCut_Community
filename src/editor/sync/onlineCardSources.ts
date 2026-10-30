import { cardSourceVersion } from "../../render/cardSourceVersion.mjs";
import { cyrb53 } from "../../render/cyrb53.mjs";
/**
 * 在线页面读内容库里的卡片源码,认出「已知但本机不能运行」的用户卡(C10 契约第 9 节「识别」,2026-09-29 用户改语义)。
 *
 * 在线包的卡片表是构建时从 `src/cards/user` 生成的,桌面版卡片库里的卡、经内容库同步的卡都不在表里;在线构建又关掉了
 * 页面侧的卡片同步(`cardSync.ts`)。于是这里经页面已有的文档服务连接(在线来源用的同一条 `docRequest`,不走 `/api`):
 *
 *   `content.list({ kind: 'card-source', prefix: 'src/cards/user/' })` → 入口文件(`src/cards/user/<名>.tsx`)里
 *   哈希变了的逐条 `content.get` → 正文就是源码字符串(`server/card-sync.mjs`)→ `parseCardSource` 取卡片的 id、名字、
 *   说明、参数默认值与控件(只认字面量)→ `registry.setSyncedUserCards`(不执行源码,也不进主注册表;参数面板经
 *   `registry.syncedCardView` 看默认值与控件)。
 *
 * **跟着 import 找**(C10 契约第 9 节〔裁〕2026-09-30):入口文件经相对导入引到的同一目录下的文件(`src/cards/user/` 下的
 * `.ts` / `.tsx`,桌面版按卡的导入闭包一并同步进内容库)也在列表里,就同样按哈希取正文,再跟着它们的导入往下取(有环不重取);
 * 解析入口时把这些正文交给 `parseCardSource`(`files`),引进来的控件、默认值照样认得出。引到页面自己带着的内置模块的,
 * 由调用方给的 `builtins`(`src/cards/builtinSourceExports.ts`)解析。列表里没有的文件取不到,面板说明是哪一条。
 *
 * 跟变化的办法选**定时重取**(每 `CARD_SOURCE_POLL_MS` 列一次,哈希没变的不再取正文),不订阅 `content.watch`:
 * 内容库的订阅按连接只认最后一次 `watch` 的那一组,与同一条连接上别的订阅方会互相顶掉;会话接续、重连时也不必补订阅。
 * 连接换了(重连、换项目、离开共享项目)清表重取。取不到(没连上、被拒、超时)时手里的表不动,下一轮再试。
 */
import { cardSourceImports, importSpecifiers, isUserCardEntryKey, parseCardSource, type ParsedCardSource } from "../../kernel/cardSourceParse.mjs";
import type { BundleResult } from "../../online/cardRuntime/protocol.ts";
import { setSyncedUserCards, type SyncedUserCard } from "../../kernel/registry";

/** 多久重列一次内容库的卡片源码 */
export const CARD_SOURCE_POLL_MS = 5_000;
/** 内容库里用户卡源码的键前缀 */
export const CARD_SOURCE_PREFIX = "src/cards/user/";
export const CARD_SOURCE_KIND = "card-source";
/** 跟着 import 最多取多少个非入口文件(防坏数据把页面拖住) */
export const CARD_SOURCE_MAX_DEPS = 200;

/** 列表里可以当被引文件取的键:用户卡目录下的 `.ts` / `.tsx` / `.mjs` / `.js`(含子目录) */
export function isCardSourceModuleKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith(CARD_SOURCE_PREFIX) && /\.(tsx?|mjs|js)$/.test(key) && !key.split("/").some((p) => p === "" || p === "." || p === "..");
}

/** 列表里可以当样式取的键:用户卡目录下的 `.css`(卡片 `import "./x.css"` 引的;只在要转译时取) */
export function isCardSourceStyleKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith(CARD_SOURCE_PREFIX) && key.endsWith(".css") && !key.split("/").some((p) => p === "" || p === "." || p === "..");
}

/** 一份源码相对导入的样式文件的键(`./x.css`、`../y.css`;爬出用户卡目录的不算) */
export function cardSourceStyleImports(source: string, key: string): string[] {
  const out = new Set<string>();
  for (const spec of importSpecifiers(source)) {
    if (typeof spec !== "string" || !spec.endsWith(".css") || !(spec.startsWith("./") || spec.startsWith("../"))) continue;
    const parts = key.split("/").slice(0, -1);
    let ok = true;
    for (const p of spec.split("/")) {
      if (p === "" || p === ".") continue;
      if (p === "..") { if (!parts.length) { ok = false; break; } parts.pop(); continue; }
      parts.push(p);
    }
    const k = parts.join("/");
    if (ok && isCardSourceStyleKey(k)) out.add(k);
  }
  return [...out];
}

/**
 * 把同步来的卡转译成舞台能执行的包(`docs/plan/online-card-exec-contract.md` 第 1 节)。由浏览器入口注入
 * (转译器按需载入,见 `src/online/cardRuntime/transpile.browser.ts`);不给就只做静态解析,与原来相同。
 */
export interface CardBundling {
  /** 本页此刻能不能执行同步来的卡(`src/online/cardRuntime/gate.ts`);不能就不转译,已有的包清掉 */
  enabled: () => boolean;
  /** 每个入口一张卡:包,或这张卡的运行状态 */
  run: (job: { entries: readonly string[]; read: (key: string) => { body: string; hash: string } | null }) => Promise<BundleResult[]>;
  /** 结果换了(整份;不能执行时是空数组) */
  onBundles: (results: BundleResult[]) => void;
}

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

export interface OnlineCardSourcesDeps {
  /** 浏览器入口注入原始内置源码表，避免纯同步/Node侧依赖Vite宏。 */
  sourceFiles?: Record<string, string>;
  request: Request;
  /** 此刻的连接(共享项目的链接对象;变了就清表重取,null = 没连上共享项目) */
  linkKey: () => unknown;
  /** 表变了(写进注册表之后) */
  onChange?: (entries: SyncedUserCard[]) => void;
  /** 写进哪里;缺省注册表 */
  apply?: (entries: SyncedUserCard[]) => boolean;
  /**
   * 每条连接的第一轮有了结果(每条连接叫一次):`ok` 为 true 是列完、取完、写进了表(个别条目这轮没取到也算),
   * false 是列表取不到(没连上、被拒、超时、回包不对)。`link` 是那一轮用的连接。在线页面的测量等它开门
   * (`measureGate.ts`);连接换了(换项目、重连)再叫一次;还没连上共享项目的那几轮不算。
   */
  onFirstSettled?: (ok: boolean, link: unknown) => void;
  requestTimeoutMs?: number;
  now?: () => number;
  /** 页面自己带着的内置模块的导出(`parseCardSource` 的 `builtins`);缺省不认内置模块 */
  builtins?: (key: string) => Readonly<Record<string, unknown>> | null | undefined;
  /** 转译成舞台能执行的包;不给就不转译 */
  bundling?: CardBundling;
}

type ParsedCard = Pick<ParsedCardSource, "id" | "name"> & Partial<Omit<ParsedCardSource, "id" | "name">> & { audioSourceVersion?: string };

/**
 * 一份列表 + 已取到的正文 → 同步用户卡的条目(按键、按源码里的先后;同一 id 取第一条)。
 * 说明、默认值、控件原样带上(参数面板用);没有的不写这一项。
 */
export function entriesOf(keys: readonly string[], parsed: ReadonlyMap<string, ParsedCard[]>): SyncedUserCard[] {
  const out: SyncedUserCard[] = [];
  const seen = new Set<string>();
  for (const key of [...keys].sort()) {
    for (const c of parsed.get(key) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({
        id: c.id, name: c.name, source: key,
        ...(c.embeddedAudio ? { embeddedAudio: true } : {}),
        ...(c.audioSourceVersion ? { audioSourceVersion: c.audioSourceVersion } : {}),
        ...(c.description !== undefined ? { description: c.description } : {}),
        ...(c.defaults !== undefined ? { defaults: c.defaults } : {}),
        ...(c.controls !== undefined ? { controls: c.controls } : {}),
        ...(c.controlsIncomplete ? { controlsIncomplete: true } : {}),
        ...(c.skippedControls?.length ? { skippedControls: c.skippedControls } : {}),
      });
    }
  }
  return out;
}

/** 此刻在跑的那份(同一页只有一份);`nodeCardInfoLive.ts` 经它读同步来的源码算代码身份(块 N) */
let activeSources: OnlineCardSources | null = null;
/** 同步来的源码的只读入口:入口文件的键表与「键 → 正文与哈希」;没有在跑的回 null */
export function activeCardSourceReader(): { entries: () => string[]; read: (key: string) => { body: string; hash: string } | null } | null {
  return activeSources ? activeSources.reader() : null;
}

export class OnlineCardSources {
  private readonly deps: OnlineCardSourcesDeps;
  private link: unknown = null;
  /** 键 → 这份正文与它的哈希(入口文件与跟着 import 取到的文件) */
  private readonly cache = new Map<string, { hash: string; body: string }>();
  /** 入口键 → 解析结果;正文有变(任何一份)时整份重解析 */
  private parsed = new Map<string, ParsedCard[]>();
  private busy: Promise<void> | null = null;
  private entries: SyncedUserCard[] = [];
  private stopped = false;
  private settled = false;
  /** 上一次转译的结果与它对应的输入签名(入口与闭包的哈希);签名没变不重转 */
  private bundles: BundleResult[] = [];
  private bundledSig: string | null = null;
  readonly stats = { lists: 0, gets: 0, errors: 0, lastSyncAt: 0, lastError: "" as string, truncated: false, bundleRuns: 0, bundleErrors: 0 };

  constructor(deps: OnlineCardSourcesDeps) {
    this.deps = deps;
    activeSources = this;
  }

  /** 只读入口(见 `activeCardSourceReader`) */
  reader(): { entries: () => string[]; read: (key: string) => { body: string; hash: string } | null } {
    return {
      entries: () => this.entries.map((e) => e.source).filter((k): k is string => typeof k === "string" && !!k),
      read: (key) => this.cache.get(key) ?? null,
    };
  }

  private apply(entries: SyncedUserCard[]): void {
    this.entries = entries;
    const changed = (this.deps.apply ?? setSyncedUserCards)(entries);
    if (changed) this.deps.onChange?.(entries);
  }

  private settle(ok: boolean, link: unknown): void {
    if (this.settled || this.stopped) return;
    this.settled = true;
    try { this.deps.onFirstSettled?.(ok, link); } catch { /* 订阅方坏了不影响同步 */ }
  }

  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ms = this.deps.requestTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this.deps.request(msg, ms),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("内容库请求超时")), ms); }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  }

  /** 跑一轮;正在跑就等那一轮 */
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.syncOnce().finally(() => { this.busy = null; });
    return this.busy;
  }

  private async syncOnce(): Promise<void> {
    const link = this.deps.linkKey();
    if (link !== this.link) {
      // 连接换了:换项目时别的项目的卡不能留着
      this.link = link;
      this.cache.clear();
      this.parsed = new Map();
      this.apply([]);
      this.setBundles([], null);
      // 新连接的第一轮重新算「第一次」
      this.settled = false;
    }
    if (!link) return;
    let listing: Record<string, unknown>;
    try {
      listing = await this.request({ type: "content.list", kind: CARD_SOURCE_KIND, prefix: CARD_SOURCE_PREFIX });
      this.stats.lists++;
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = String((err as Error)?.message ?? err).slice(0, 160);
      this.settle(false, link);
      return;
    }
    if (this.stopped || this.deps.linkKey() !== link) return;
    if (listing?.type !== "content.listing" || !Array.isArray(listing.items)) {
      this.stats.errors++;
      this.stats.lastError = `回包不对:${String(listing?.type ?? "")}`.slice(0, 160);
      this.settle(false, link);
      return;
    }
    this.stats.truncated = listing.truncated === true;
    const listed = new Map<string, string>();
    const styles = new Map<string, string>();
    for (const it of listing.items as { key?: unknown; hash?: unknown }[]) {
      if (isCardSourceModuleKey(it?.key)) listed.set(it.key, typeof it.hash === "string" ? it.hash : "");
      else if (isCardSourceStyleKey(it?.key)) styles.set(it.key, typeof it.hash === "string" ? it.hash : "");
    }
    // 样式文件只在要转译时才取(不转译的页面与原来一字不差)
    const wantStyles = !!this.deps.bundling?.enabled();
    if (wantStyles) for (const [k, h] of styles) listed.set(k, h);
    const entryKeys = [...listed.keys()].filter((k) => isUserCardEntryKey(k)).sort();
    let dirty = false;
    for (const k of [...this.cache.keys()]) if (!listed.has(k)) { this.cache.delete(k); dirty = true; }
    // 入口文件,再跟着 import 取同一目录下被引的文件(只取列表里有的;哈希没变不重取;有环不重取)
    const queue = [...entryKeys];
    const visited = new Set<string>();
    let deps = 0;
    while (queue.length) {
      const key = queue.shift()!;
      if (visited.has(key)) continue;
      visited.add(key);
      if (!isUserCardEntryKey(key) && ++deps > CARD_SOURCE_MAX_DEPS) break;
      const hash = listed.get(key) ?? "";
      const hit = this.cache.get(key);
      if (!(hit && hash && hit.hash === hash)) {
        try {
          const got = await this.request({ type: "content.get", kind: CARD_SOURCE_KIND, key });
          this.stats.gets++;
          if (this.stopped || this.deps.linkKey() !== link) return;
          if (got?.type !== "content.item" || got.missing) { if (this.cache.delete(key)) dirty = true; continue; }
          const body = typeof got.body === "string" ? got.body : "";
          this.cache.set(key, { hash: typeof got.hash === "string" ? got.hash : hash, body });
          dirty = true;
        } catch (err) {
          // 这一条这轮取不到:留着旧的正文(有的话),下一轮再取
          this.stats.errors++;
          this.stats.lastError = String((err as Error)?.message ?? err).slice(0, 160);
        }
      }
      const cur = this.cache.get(key);
      if (!cur) continue;
      if (key.endsWith(".css")) continue;
      for (const dep of cardSourceImports(cur.body, key)) if (listed.has(dep) && !visited.has(dep)) queue.push(dep);
      if (wantStyles) for (const dep of cardSourceStyleImports(cur.body, key)) if (listed.has(dep) && !visited.has(dep)) queue.push(dep);
    }
    // 不再被引的文件不留
    for (const k of [...this.cache.keys()]) if (!visited.has(k)) { this.cache.delete(k); dirty = true; }
    if (dirty || [...this.parsed.keys()].some((k) => !this.cache.has(k))) {
      const files = (k: string) => this.cache.get(k)?.body ?? null;
      const next = new Map<string, ParsedCard[]>();
      for (const k of entryKeys) {
        const cur = this.cache.get(k);
        if (!cur) continue;
        const sourceFiles = { ...this.deps.sourceFiles, ...Object.fromEntries([...this.cache].map(([key, value]) => [`/${key}`, value.body])) };
        next.set(k, parseCardSource(cur.body, { key: k, files, builtins: this.deps.builtins }).map(card => ({ ...card,
          audioSourceVersion: cyrb53(`user:${cardSourceVersion(card, sourceFiles, `/${k}`)}`) })));
      }
      this.parsed = next;
    }
    this.apply(entriesOf([...this.parsed.keys()], this.parsed));
    await this.bundle(entryKeys.filter((k) => this.cache.has(k)), link);
    if (this.stopped || this.deps.linkKey() !== link) return;
    this.stats.lastSyncAt = (this.deps.now ?? Date.now)();
    this.settle(true, link);
  }

  private setBundles(results: BundleResult[], sig: string | null): void {
    const had = this.bundles.length > 0;
    this.bundles = results;
    this.bundledSig = sig;
    if (!had && !results.length) return;
    try { this.deps.bundling?.onBundles(results); } catch { /* 订阅方坏了不影响同步 */ }
  }

  /**
   * 转译这一轮的入口(本页能执行时)。输入没变(入口与已取到的文件的哈希都没变)不重转;
   * 不能执行了就把已有的包清掉。转译器载入失败、抛错:这一轮不出包,下一轮再试。
   */
  private async bundle(entries: string[], link: unknown): Promise<void> {
    const b = this.deps.bundling;
    if (!b) return;
    if (!b.enabled()) { if (this.bundledSig !== null) this.setBundles([], null); return; }
    const sig = JSON.stringify([entries, [...this.cache].map(([k, v]) => [k, v.hash]).sort()]);
    if (sig === this.bundledSig) return;
    if (!entries.length) { this.setBundles([], sig); return; }
    try {
      const results = await b.run({ entries, read: (key) => this.cache.get(key) ?? null });
      if (this.stopped || this.deps.linkKey() !== link) return;
      this.stats.bundleRuns++;
      this.setBundles(results, sig);
    } catch (err) {
      this.stats.bundleErrors++;
      this.stats.lastError = String((err as Error)?.message ?? err).slice(0, 160);
    }
  }

  /** 此刻认出的卡(诊断、探针用) */
  debug() {
    return {
      link: !!this.link,
      settled: this.settled,
      keys: [...this.parsed.keys()].sort(),
      deps: [...this.cache.keys()].filter((k) => !isUserCardEntryKey(k)).sort(),
      cards: this.entries.map((e) => ({ ...e })),
      bundles: this.bundles.map((r) => (r.ok
        ? { entry: r.entry, ok: true, generation: r.bundle.generation, modules: r.bundle.modules.map((m) => m.key), styles: r.bundle.styles.map((x) => x.key), tailwindBytes: r.bundle.tailwind.length }
        : { entry: r.entry, ok: false, state: r.state })),
      ...this.stats,
    };
  }

  /** 停下并清表(离开在线页面、换档重建时) */
  stop(): void {
    this.stopped = true;
    if (activeSources === this) activeSources = null;
    this.setBundles([], null);
    this.cache.clear();
    this.parsed = new Map();
    this.link = null;
    this.apply([]);
  }
}
