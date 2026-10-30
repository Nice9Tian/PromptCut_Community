/**
 * 同步来的卡用到的 Tailwind 类名在页面里补生成(`docs/plan/online-card-exec-contract.md` 第 2 节)。
 *
 * 在线包的样式表在构建时定死(只含构建时扫到的类名);同步来的卡是之后才到的,它用的新类名(例如 `text-[137px]`)
 * 不在里面。这里用页面带的 Tailwind 编译器按闭包源码里出现的候选类名生成两层:用到的主题变量(`@layer theme`)
 * 与工具类(`@layer utilities`),不生成基础层(页面已有)。层的先后由页面自己的样式表先声明,补进来的同名层并入。
 *
 * 候选类名的取法与 Tailwind 自己扫文件同一个思路:把源码当纯文本,按空白与引号切开,不是类名的由编译器丢掉。
 * 所以多取无害;带引号的任意值(`content-['a']`)取不到,这类写法在线上没有样式(范围说明)。
 *
 * 编译器要的两份样式文本(Tailwind 的 `theme.css`、`utilities.css`)由调用方给:浏览器里用 `?raw` 引进来
 * (`transpile.browser.ts`),单测里从 `node_modules` 读。
 */
import { compile } from "tailwindcss";

/** 一张卡最多取多少个候选(防坏数据) */
export const MAX_CANDIDATES = 20_000;

/** 源码 → 候选类名(去重、按出现先后) */
export function classCandidates(sources: Iterable<string>, limit = MAX_CANDIDATES): string[] {
  const out = new Set<string>();
  for (const source of sources) {
    for (const piece of String(source ?? "").split(/[\s"'`]+/)) {
      if (!piece || piece.length > 200) continue;
      // 去掉两头粘着的标点(`className={cn(`、`},`、`;`);中间的 `:`、`/`、`[`、`]`、`(`、`)` 是类名自己的
      const c = piece.replace(/^[^A-Za-z0-9[\-!@*]+/, "").replace(/[^A-Za-z0-9\])%!]+$/, "");
      if (!c || !/[A-Za-z]/.test(c)) continue;
      out.add(c);
      if (out.size >= limit) return [...out];
    }
  }
  return [...out];
}

export interface TailwindSources {
  /** `tailwindcss/theme.css` 的文本 */
  theme: string;
  /** `tailwindcss/utilities.css` 的文本 */
  utilities: string;
}

export type CardCssCompiler = (candidates: readonly string[]) => Promise<string>;

const ENTRY = [
  "@layer theme, base, components, utilities;",
  '@import "tailwindcss/theme.css" layer(theme);',
  '@import "tailwindcss/utilities.css" layer(utilities) source(none);',
].join("\n");

/**
 * 建一个编译器。每张卡单独编一次(Tailwind 的 `build` 会把历次的候选攒在一起,共用一个实例的话后编的卡会带上
 * 先编的卡的样式,同一张卡的输出就跟着编的先后变);一次约十几毫秒。没有任何候选是类名时回空串。
 */
export function createCardCssCompiler(sources: TailwindSources): CardCssCompiler {
  const fresh = () => compile(ENTRY, {
    base: "/",
    loadStylesheet: async (id: string, base: string) => {
      if (id === "tailwindcss/theme.css") return { path: "tailwindcss/theme.css", base, content: sources.theme };
      if (id === "tailwindcss/utilities.css") return { path: "tailwindcss/utilities.css", base, content: sources.utilities };
      throw new Error(`在线页面里没有这份样式:${id}`);
    },
  });
  // 一个候选都不给时的输出(只有层声明与版权注释):之后的输出等于它就当「没有样式」
  let empty: Promise<string> | null = null;
  return async (candidates) => {
    if (!candidates.length) return "";
    empty ??= fresh().then((c) => c.build([]));
    const css = (await fresh()).build([...candidates]);
    return css === (await empty) ? "" : css;
  };
}
