/**
 * Syntax precheck before transpilation (`docs/plan/online-card-exec-contract.md` Section 1).
 *
 * Sucrase silently mistranspiles several syntax patterns (`namespace` contents are dropped
 * entirely, `accessor` fields are converted into ordinary fields), while several others transpile
 * but cannot execute in the stage (decorators, top-level `await`, `import.meta`, dynamic
 * `import()`). When encountered, transpilation is skipped, reporting "unsupported syntax in
 * online pages".
 *
 * Evaluated using Sucrase's own lexical tokens (public API `getFormattedTokens`, one token per line,
 * column-aligned), rather than scanning source code with regular expressions: occurrences of these
 * words in comments, strings, or JSX text do not count.
 *
 * Top-level `await` is only recognized in the outermost scope; those written inside top-level `if`
 * or `for` blocks cannot be recognized and will report a syntax error when loaded in the stage,
 * which the loader likewise classifies as "unsupported syntax" (`loader.ts`).
 */
import { getFormattedTokens } from "sucrase";

export interface UnsupportedSyntax {
  /** Which syntax pattern (term displayed in parameters panel) */
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
  if (cLabel < 0 || cRaw < 0 || cCtx < 0 || cDepth < 0 || cType < 0 || cRole < 0) throw new Error("The lexer result header changed");
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
 * Syntax patterns in this source code unsupported in online pages (in order of appearance; returns
 * empty array if none). Throws when source code itself has syntax errors (caller reports as
 * transpilation failure).
 */
export function unsupportedSyntax(source: string): UnsupportedSyntax[] {
  const toks = tokensOf(source);
  const out: UnsupportedSyntax[] = [];
  const seen = new Set<string>();
  const hit = (what: string, line: number) => { if (!seen.has(what)) { seen.add(what); out.push({ what, line }); } };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], next = toks[i + 1], next2 = toks[i + 2], prev = toks[i - 1];
    if (t.label === "@") { hit("decorator", t.line); continue; }
    if (t.label === "name" && (t.raw === "namespace" || t.raw === "module") && prev?.raw !== "declare" && prev?.raw !== "."
      && next && (next.label === "name" || next.label === "string") && next2 && (next2.label === "{" || next2.label === ".")) {
      hit(t.raw === "module" ? "module block" : "namespace", t.line);
      continue;
    }
    if (t.label === "name" && t.raw === "accessor" && !t.isType && next && next.line === t.line && (next.label === "name" || next.label === "[" || next.label === "string")) {
      hit("accessor field", t.line);
      continue;
    }
    if (t.raw === "import" && (t.label === "import" || t.label === "name") && next) {
      if (next.label === ".") { hit("import.meta", t.line); continue; }
      // `typeof import("three")` in type positions does not count (stripped entirely during transpilation)
      if (next.label === "(" && !t.isType) { hit("dynamic import()", t.line); continue; }
    }
    if (t.label === "name" && t.raw === "await" && t.depth === 0 && !t.isType) hit("top-level await", t.line);
  }
  return out;
}
