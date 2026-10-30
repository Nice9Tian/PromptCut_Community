/**
 * 转译前的写法预检(`docs/plan/online-card-exec-contract.md` 第 1 节)。
 *
 * Sucrase 有几种写法会悄悄转错(`namespace` 的内容被整个丢掉、`accessor` 字段被改成普通字段),另有几种转得出但
 * 在舞台里执行不了(装饰器、顶层 `await`、`import.meta`、动态 `import()`)。遇到就不转,报「在线页面不支持这种写法」。
 *
 * 用 Sucrase 自己的词法结果判(公开接口 `getFormattedTokens`,一行一个记号、列宽对齐),不拿正则扫源码:
 * 注释、字符串、JSX 文本里出现这些词不算。
 *
 * 顶层 `await` 只认得出最外层作用域里的;写在顶层的 `if`、`for` 块里的认不出,那种会在舞台载入时报语法错,
 * 加载器同样归为「不支持的写法」(`loader.ts`)。
 */
import { getFormattedTokens } from "sucrase";

export interface UnsupportedSyntax {
  /** 哪一种写法(给参数面板看的词) */
  what: string;
  line: number;
}

interface Tok { line: number; label: string; raw: string; depth: number; isType: boolean }

function tokensOf(source: string): Tok[] {
  const text = getFormattedTokens(source, { transforms: ["typescript", "jsx"] });
  const lines = text.split("\n");
  const head = lines[0] ?? "";
  const at = (name: string) => head.indexOf(name);
  const cLabel = at("Label"), cRaw = at("Raw"), cCtx = at("contextualKeyword"), cDepth = at("scopeDepth"), cType = at("isType"), cRole = at("identifierRole");
  if (cLabel < 0 || cRaw < 0 || cCtx < 0 || cDepth < 0 || cType < 0 || cRole < 0) throw new Error("词法结果的表头变了");
  const out: Tok[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    out.push({
      line: Number(/^(\d+):/.exec(l)?.[1] ?? 0),
      label: l.slice(cLabel, cRaw).trim(),
      raw: l.slice(cRaw, cCtx).trim(),
      depth: Number(l.slice(cDepth, cType).trim() || 0),
      isType: l.slice(cType, cRole).trim() === "isType",
    });
  }
  return out;
}

/**
 * 这份源码里在线页面不支持的写法(按出现先后;没有回空数组)。源码本身有语法错时抛错(调用方当转译失败报)。
 */
export function unsupportedSyntax(source: string): UnsupportedSyntax[] {
  const toks = tokensOf(source);
  const out: UnsupportedSyntax[] = [];
  const seen = new Set<string>();
  const hit = (what: string, line: number) => { if (!seen.has(what)) { seen.add(what); out.push({ what, line }); } };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], next = toks[i + 1], next2 = toks[i + 2], prev = toks[i - 1];
    if (t.label === "@") { hit("装饰器", t.line); continue; }
    if (t.label === "name" && (t.raw === "namespace" || t.raw === "module") && prev?.raw !== "declare" && prev?.raw !== "."
      && next && (next.label === "name" || next.label === "string") && next2 && (next2.label === "{" || next2.label === ".")) {
      hit(t.raw === "module" ? "module 块" : "namespace", t.line);
      continue;
    }
    if (t.label === "name" && t.raw === "accessor" && !t.isType && next && next.line === t.line && (next.label === "name" || next.label === "[" || next.label === "string")) {
      hit("accessor 字段", t.line);
      continue;
    }
    if (t.raw === "import" && (t.label === "import" || t.label === "name") && next) {
      if (next.label === ".") { hit("import.meta", t.line); continue; }
      // 类型位置的 `typeof import("three")` 不算(转译时整句剥掉)
      if (next.label === "(" && !t.isType) { hit("动态 import()", t.line); continue; }
    }
    if (t.label === "name" && t.raw === "await" && t.depth === 0 && !t.isType) hit("顶层 await", t.line);
  }
  return out;
}
