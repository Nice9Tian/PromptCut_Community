/**
 * From one card source (the original text of `src/cards/user/*.tsx`), extracts the id, name, description,
 * parameter defaults and parameter controls of the cards it defines, **without executing the source**.
 *
 * Purpose (C10 contract section 9, "recognition"): a page in online browser mode reads, through the
 * document service, the card source synced into the content store, but this machine cannot run those
 * cards. The page needs to know "this id is a user card and what it is called" (the timeline shows the
 * real name, and the preview treats it as a card this machine cannot run), and which parameters it has
 * (the parameters panel can edit them as usual; clips can change their parameters as usual).
 *
 * `defaults` / `controls` / `description` only accept literals: strings, template strings without
 * substitutions, numbers (including negatives), booleans, null, arrays, objects, and references to a
 * top-level `const X = literal` of the same file (spreads inside objects and arrays also accept literals
 * of the same file).
 *
 * **Following imports** (C10 contract section 9 [ruling] 2026-09-30): when `opts.key` and `opts.files` /
 * `opts.builtins` are given, imported names are evaluated too:
 *   - a relative import that lands on a file in `files` (the online page supplies the `card-source` synced
 *     from the same user-card directory of the content store): parse that file and take the exports it
 *     writes as literals: `export const`, `export default`, `export { a as b }`, re-exports
 *     `export { a } from` / `export * from`, import aliases `import { a as b }`, default imports, and
 *     `ns.x` of `import * as ns`; a file brought in that imports other files is followed the same way, and
 *     a cycle stops it (that one is not recognized);
 *   - a relative import that lands on a built-in module the page ships with (`builtins`, for example
 *     `hudControls` of `src/cards/native/hud.ts`): use the ready-made value from the page (plain data
 *     only); pure functions registered by the built-in module (`pureCall`, for example `assetOptions`) are
 *     also evaluated when called with literal arguments;
 *   - anything else (package names, aliases, files not in the content store) is not recognized, and the
 *     reason is recorded.
 * User source is never executed and never passed to eval.
 *
 * What is not recognized is dropped by these rules:
 *   - controls are parsed one by one: a control whose `key`, `type` or `label` is not a literal (or is
 *     missing) is skipped; a single field that is not a literal is dropped;
 *   - for `select`, `options` accepts `{ value, label }` (a missing `label` uses `value`), a plain array
 *     of strings, and a `{ value: label }` object; missing or unrecognized options skip the control;
 *   - when `asset` has no `kind` and the addresses of its options and of its default value all point to
 *     the same kind of asset catalog (`/catalog/lottie/…`, `/catalog/particles/…`), that kind is
 *     inferred; if it cannot be inferred the control is skipped; an `asset` without `options` is treated
 *     as an empty list;
 *   - keys in `defaults` that are not literals are dropped;
 *   - when a control is skipped (or the whole `controls` is not a literal), `controlsIncomplete` is true,
 *     and the parameters panel uses it to explain "cannot be edited online"; `skippedControls` records
 *     each skipped control (the recognizable key / label / type) and why, and the panel lists them as is.
 *
 * The criterion follows `isCardDef` in `src/cards/user/index.ts`, only reading source instead: the value
 * of a named export (including `export default` and `export { a as b }`) is an object literal that has
 * top-level string `id` and `name`, writes `defaults` and `controls`, and has one of `Component` / `card` /
 * `audio` (a property, a shorthand or a method all count). `id` / `name` also accept constants defined
 * at the top level of the same file as `const X = "..."`.
 * A value that is not a literal (a function return, spreading another object) is not recognized, and it
 * is treated as not a card.
 *
 * For this it carries a TSX lexer that is good enough: strings, template strings (including nested `${}`),
 * comments, regex literals, JSX (apostrophes in text are not strings).
 * Pure function, the same copy for the browser and Node.
 */

const PUNCT3 = ["...", "===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??="];
const PUNCT2 = ["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
/** After these keywords an expression starts (`/` is a regex, `<` is JSX) */
const EXPR_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof", "default", "export"]);
/** After this punctuation an expression starts */
const EXPR_PUNCT = new Set(["(", "[", "{", ",", ";", ":", "?", "=", "=>", "==", "===", "!=", "!==", "+", "-", "*", "%", "&", "|", "^", "!", "~",
  "<", ">", "<=", ">=", "&&", "||", "??", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "...", "}"]);

const isIdStart = (c) => /[\p{ID_Start}$_]/u.test(c);
const isIdPart = (c) => /[\p{ID_Continue}$‌‍]/u.test(c);

/** Decodes the body of a string literal (without the quotes) */
function decodeString(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n === "v") out += "\v";
    else if (n === "0" && !/[0-9]/.test(raw[i + 1] ?? "")) out += "\0";
    else if (n === "x") { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16) || 0); i += 2; }
    else if (n === "u") {
      if (raw[i + 1] === "{") {
        const end = raw.indexOf("}", i);
        // Unclosed `\u{` (the source itself is invalid): leave the rest as is and finish. Writing `i = end` as
        // usual would reset i to -1 and rescan from the start, never getting out
        if (end < 0) { out += raw.slice(i); break; }
        out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16) || 0);
        i = end;
      } else { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16) || 0); i += 4; }
    } else if (n === "\r") { if (raw[i + 1] === "\n") i++; }
    else if (n === "\n" || n === " " || n === " ") { /* line continuation */ }
    else out += n;
  }
  return out;
}

/**
 * Lexer. `tokens` only collects the tokens of the outermost context (`${}` inside templates and `{}`
 * inside JSX are swallowed whole and emit no tokens);
 * each token carries the brace / parenthesis / bracket depth `depth` it sits at.
 * Token: `{ t: 'word' | 'punct' | 'string' | 'template' | 'number' | 'regex' | 'jsx', v, depth }`,
 * the `v` of `string` is the decoded value, and the `v` of a template string without substitutions is
 * also its value (`v` is null when it has substitutions).
 */
class Lexer {
  constructor(src) {
    this.s = src;
    this.i = 0;
    this.last = null;
  }

  peek(k = 0) { return this.s[this.i + k]; }

  exprStart() {
    const t = this.last;
    if (!t) return true;
    if (t.t === "punct") return EXPR_PUNCT.has(t.v);
    if (t.t === "word") return EXPR_KEYWORDS.has(t.v);
    return false;
  }

  skipSpace() {
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) return;
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "﻿" || c === " " || c === " " || c === " ") { this.i++; continue; }
      if (c === "/" && this.s[this.i + 1] === "/") {
        while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
        continue;
      }
      if (c === "/" && this.s[this.i + 1] === "*") {
        const end = this.s.indexOf("*/", this.i + 2);
        this.i = end < 0 ? this.s.length : end + 2;
        continue;
      }
      return;
    }
  }

  readQuoted(q) {
    const start = ++this.i;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "\\") { this.i += 2; continue; }
      if (c === q) break;
      if (c === "\n") break;
      this.i++;
    }
    const raw = this.s.slice(start, this.i);
    this.i++;
    return decodeString(raw);
  }

  /** Template string; returns its value (null when it has substitutions) */
  readTemplate() {
    this.i++;
    let raw = "";
    let plain = true;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "\\") { raw += c + (this.s[this.i + 1] ?? ""); this.i += 2; continue; }
      if (c === "`") { this.i++; break; }
      if (c === "$" && this.s[this.i + 1] === "{") {
        plain = false;
        this.i += 2;
        this.skipBalanced();
        continue;
      }
      raw += c;
      this.i++;
    }
    return plain ? decodeString(raw) : null;
  }

  /**
   * Swallows up to and including the `}` that pairs with the `{` already consumed; strings, templates,
   * JSX and regexes inside are still recognized as usual
   */
  skipBalanced() {
    const saved = this.last;
    this.last = { t: "punct", v: "{" };
    let depth = 1;
    while (this.i < this.s.length) {
      const tok = this.token();
      if (!tok) break;
      if (tok.t === "punct") {
        if (tok.v === "{" || tok.v === "(" || tok.v === "[") depth++;
        else if (tok.v === "}" || tok.v === ")" || tok.v === "]") {
          depth--;
          if (depth === 0) break;
        }
      }
    }
    this.last = saved;
  }

  readRegex() {
    this.i++;
    let inClass = false;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "\\") { this.i += 2; continue; }
      if (c === "\n") break;
      if (inClass) { if (c === "]") inClass = false; }
      else if (c === "[") inClass = true;
      else if (c === "/") { this.i++; break; }
      this.i++;
    }
    while (this.i < this.s.length && isIdPart(this.s[this.i])) this.i++;
  }

  /** Whether what follows `<` looks like JSX (not a TS generic arrow function `<T,>` / `<T extends X>`) */
  looksLikeJsx() {
    const s = this.s;
    let j = this.i + 1;
    if (s[j] === ">") return true;
    if (!isIdStart(s[j] ?? "")) return false;
    while (j < s.length && (isIdPart(s[j]) || s[j] === "." || s[j] === "-" || s[j] === ":")) j++;
    const name = s.slice(this.i + 1, j);
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] === ",") return false;
    if (/^extends\b/.test(s.slice(j, j + 8)) && /^[A-Z]/.test(name)) return false;
    return true;
  }

  /** Swallows one JSX element or fragment (starting at `<`) */
  skipJsx() {
    const s = this.s;
    this.i++;
    // Fragment `<>`
    if (s[this.i] === ">") { this.i++; this.skipJsxChildren(); return; }
    while (this.i < s.length && (isIdPart(s[this.i]) || s[this.i] === "." || s[this.i] === "-" || s[this.i] === ":")) this.i++;
    // Attributes
    for (;;) {
      this.skipSpace();
      const c = s[this.i];
      if (c === undefined) return;
      if (c === "/" && s[this.i + 1] === ">") { this.i += 2; return; }
      if (c === ">") { this.i++; this.skipJsxChildren(); return; }
      if (c === "{") { this.i++; this.skipBalanced(); continue; }
      if (c === "\"" || c === "'") { this.readQuoted(c); continue; }
      if (c === "=") {
        this.i++;
        this.skipSpace();
        const v = s[this.i];
        if (v === "\"" || v === "'") this.readQuoted(v);
        else if (v === "{") { this.i++; this.skipBalanced(); }
        else if (v === "<") this.skipJsx();
        continue;
      }
      if (isIdPart(c) || c === "-" || c === ":") { while (this.i < s.length && (isIdPart(s[this.i]) || s[this.i] === "-" || s[this.i] === ":" || s[this.i] === ".")) this.i++; continue; }
      this.i++;
    }
  }

  skipJsxChildren() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "<" && s[this.i + 1] === "/") {
        const end = s.indexOf(">", this.i);
        this.i = end < 0 ? s.length : end + 1;
        return;
      }
      if (c === "<") { this.skipJsx(); continue; }
      if (c === "{") { this.i++; this.skipBalanced(); continue; }
      this.i++;
    }
  }

  /** The next token; returns null at the end */
  token() {
    this.skipSpace();
    const s = this.s;
    const c = s[this.i];
    if (c === undefined) return null;
    let tok;
    if (c === "\"" || c === "'") tok = { t: "string", v: this.readQuoted(c) };
    else if (c === "`") tok = { t: "template", v: this.readTemplate() };
    else if (c === "/" && this.exprStart()) { this.readRegex(); tok = { t: "regex", v: null }; }
    else if (c === "<" && this.exprStart() && this.looksLikeJsx()) { this.skipJsx(); tok = { t: "jsx", v: null }; }
    else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[this.i + 1] ?? ""))) {
      const start = this.i;
      while (this.i < s.length && /[0-9a-zA-Z_.]/.test(s[this.i])) this.i++;
      tok = { t: "number", v: s.slice(start, this.i) };
    } else if (isIdStart(c) || c === "#") {
      const start = this.i++;
      while (this.i < s.length && isIdPart(s[this.i])) this.i++;
      tok = { t: "word", v: s.slice(start, this.i) };
    } else {
      const three = s.slice(this.i, this.i + 3), two = s.slice(this.i, this.i + 2);
      const v = PUNCT3.includes(three) ? three : PUNCT2.includes(two) ? two : c;
      this.i += v.length;
      tok = { t: "punct", v };
    }
    this.last = tok;
    return tok;
  }

  /** The token table of the whole source (with depth) */
  all() {
    const out = [];
    let depth = 0;
    for (;;) {
      const tok = this.token();
      if (!tok) break;
      if (tok.t === "punct" && (tok.v === "}" || tok.v === ")" || tok.v === "]")) depth = Math.max(0, depth - 1);
      tok.depth = depth;
      out.push(tok);
      if (tok.t === "punct" && (tok.v === "{" || tok.v === "(" || tok.v === "[")) depth++;
    }
    return out;
  }
}

/** Pairs from `open` (a `{` token) to its `}` and returns the index of the `}` */
function closeOf(tokens, open) {
  const d = tokens[open].depth;
  for (let k = open + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.depth === d && t.t === "punct" && (t.v === "}" || t.v === ")" || t.v === "]")) return k;
  }
  return tokens.length;
}

/**
 * Top-level properties of an object literal (`open` is its `{`): `Map<key, token array of the value>`;
 * the values of shorthand properties and methods are recorded as null.
 * Spreads (`...x`) are recorded in `spreads` (the name of a top-level object of the same file; null for
 * other expressions).
 */
function objectProps(tokens, open) {
  const end = closeOf(tokens, open);
  const inner = tokens[open].depth + 1;
  const props = new Map();
  /**
   * Top-level identifiers that are spread (`...base`), in order of appearance; null is recorded when
   * another expression is spread
   */
  const spreads = [];
  let k = open + 1;
  while (k < end) {
    const t = tokens[k];
    if (t.depth !== inner) { k++; continue; }
    if (t.t === "punct" && t.v === ",") { k++; continue; }
    if (t.t === "punct" && t.v === "...") {
      const src = tokens[k + 1];
      const tail = tokens[k + 2];
      spreads.push(src && src.t === "word" && (!tail || tail.depth !== inner || (tail.t === "punct" && (tail.v === "," || tail.v === "}"))) ? { name: src.v, at: props.size } : null);
      while (k < end && !(tokens[k].depth === inner && tokens[k].t === "punct" && tokens[k].v === ",")) k++;
      continue;
    }
    // Key: identifier, string or number; for methods modified by `get` / `set` / `async`, the modifier is skipped
    let keyTok = t;
    if (t.t === "word" && (t.v === "get" || t.v === "set" || t.v === "async") && tokens[k + 1] && tokens[k + 1].depth === inner
      && (tokens[k + 1].t === "word" || tokens[k + 1].t === "string")) { k++; keyTok = tokens[k]; }
    let key = null;
    if (keyTok.t === "word" || keyTok.t === "number") key = keyTok.v;
    else if (keyTok.t === "string") key = keyTok.v;
    else if (keyTok.t === "template" && keyTok.v !== null) key = keyTok.v;
    const after = tokens[k + 1];
    if (key !== null && after && after.t === "punct" && after.v === ":" && after.depth === inner) {
      // `key: value`: the value is consumed up to the next comma at the same level or the end of the object
      const from = k + 2;
      let to = from;
      while (to < end && !(tokens[to].depth === inner && tokens[to].t === "punct" && tokens[to].v === ",")) to++;
      if (!props.has(key)) props.set(key, tokens.slice(from, to));
      k = to;
      continue;
    }
    if (key !== null && (!after || after.depth !== inner || (after.t === "punct" && (after.v === "," || after.v === "}")) || k + 1 >= end)) {
      // Shorthand
      if (!props.has(key)) props.set(key, null);
      k++;
      continue;
    }
    if (key !== null && after && after.t === "punct" && (after.v === "(" || after.v === "<" || after.v === "?")) {
      // Method `key(...) {...}` / `key<T>(...)`
      if (!props.has(key)) props.set(key, null);
      let to = k + 1;
      while (to < end && !(tokens[to].depth === inner && tokens[to].t === "punct" && tokens[to].v === ",")) to++;
      k = to;
      continue;
    }
    // Computed keys such as `[x]: v`: skip to the next comma at the same level
    while (k < end && !(tokens[k].depth === inner && tokens[k].t === "punct" && tokens[k].v === ",")) k++;
  }
  return { props, spreads, end };
}

/**
 * Top-level properties of an object, with the same-file top-level objects it spreads (`...base`) merged
 * in; properties written after the spread override the spread-in ones (simplification: spread-in
 * properties only fill gaps, consistent with the common "spread first, override after" pattern in card
 * sources). Stops when the spread chain has a cycle.
 */
function mergedProps(tokens, objects, at, seen = new Set()) {
  if (seen.has(at)) return new Map();
  seen.add(at);
  const { props, spreads } = objectProps(tokens, at);
  const out = new Map(props);
  for (const sp of spreads) {
    if (!sp) continue;
    const src = objects.get(sp.name);
    if (src === undefined) continue;
    for (const [k, v] of mergedProps(tokens, objects, src, seen)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

/**
 * Token array of a value → string (literal, template without substitutions, top-level string constant
 * of the same file); returns null if not recognized
 */
function stringValue(valueTokens, consts) {
  if (!valueTokens || !valueTokens.length) return null;
  const first = valueTokens[0];
  // Trailing `as const` / `satisfies X` / `as string` is allowed
  const rest = valueTokens.slice(1);
  if (rest.length && !(rest[0].t === "word" && (rest[0].v === "as" || rest[0].v === "satisfies"))) return null;
  if (first.t === "string") return first.v;
  if (first.t === "template" && first.v !== null) return first.v;
  if (first.t === "word" && consts.has(first.v)) return consts.get(first.v);
  return null;
}

/**
 * Top-level declaration: `const|let|var NAME [: type] = <init>`, returns `{ name, valueAt }`
 * (the index of the first token of the initial value)
 */
function declarationAt(tokens, k) {
  const kw = tokens[k];
  if (!kw || kw.t !== "word" || !(kw.v === "const" || kw.v === "let" || kw.v === "var")) return null;
  const nameTok = tokens[k + 1];
  if (!nameTok || nameTok.t !== "word") return null;
  let j = k + 2;
  const d = kw.depth;
  if (tokens[j] && tokens[j].t === "punct" && tokens[j].v === ":") {
    // Skip the type annotation up to the `=` at the same level (`<>` inside the type also counts as a level)
    let angle = 0;
    j++;
    while (j < tokens.length) {
      const t = tokens[j];
      if (t.depth === d && t.t === "punct") {
        if (t.v === "<") angle++;
        else if (t.v === ">") angle = Math.max(0, angle - 1);
        else if (t.v === ">>") angle = Math.max(0, angle - 2);
        else if (t.v === "=" && angle === 0) break;
        else if (t.v === ";" && angle === 0) return null;
      }
      j++;
    }
  }
  if (!tokens[j] || tokens[j].t !== "punct" || tokens[j].v !== "=") return null;
  return { name: nameTok.v, valueAt: j + 1 };
}

/* ------------------------------------------------------------------ Cross-file: module paths */

/** Extensions appended to relative imports (same resolution order as vite; good enough) */
const MODULE_EXTS = [".ts", ".tsx", ".mjs", ".js"];

/**
 * Relative import → candidate repo-relative paths (tried in order). `fromKey` is the key of the
 * importer (`src/cards/user/x.tsx`).
 * Returns null for non-relative paths (package names, aliases), paths with a query (`?raw`), and paths
 * that climb out of the repo root.
 */
export function resolveSpecifier(fromKey, spec) {
  if (typeof fromKey !== "string" || typeof spec !== "string") return null;
  if (!(spec.startsWith("./") || spec.startsWith("../")) || spec.includes("?") || spec.includes("\\")) return null;
  const parts = fromKey.split("/").slice(0, -1);
  for (const p of spec.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(p);
  }
  if (!parts.length) return null;
  const base = parts.join("/");
  if (/\.(tsx?|mjs|js)$/.test(base)) {
    const stem = base.replace(/\.(tsx?|mjs|js)$/, "");
    return [...new Set([base, ...MODULE_EXTS.map((e) => stem + e)])];
  }
  return [...MODULE_EXTS.map((e) => base + e), `${base}/index.ts`, `${base}/index.tsx`];
}

/**
 * All specifiers of `import … from` and `export … from` in this source (as recognized by the lexer;
 * those inside comments and strings do not count)
 */
export function importSpecifiers(source) {
  if (typeof source !== "string" || !source) return [];
  let tokens;
  try { tokens = new Lexer(source).all(); } catch { return []; }
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.depth !== 0 || t.t !== "word" || (t.v !== "import" && t.v !== "export")) continue;
    if (t.v === "import" && tokens[k + 1]?.t === "string") { out.push(tokens[k + 1].v); continue; }
    // Look ahead at the same level for `from "<specifier>"`; stop at a semicolon or the next statement
    for (let j = k + 1; j < tokens.length && j < k + 400; j++) {
      const n = tokens[j];
      if (n.depth === 0 && n.t === "punct" && n.v === ";") break;
      if (n.depth === 0 && n.t === "word" && n.v === "from" && tokens[j + 1]?.t === "string") { out.push(tokens[j + 1].v); break; }
      if (n.depth === 0 && n.t === "word" && ["const", "let", "var", "function", "class", "default", "import", "export", "interface", "type"].includes(n.v) && j > k + 1) break;
    }
  }
  return [...new Set(out)];
}

/**
 * Repo-relative paths a source may reach through relative imports (all candidates of every specifier;
 * the caller intersects them with the content store list).
 * The online page uses this to decide which other `card-source` files still need to be fetched.
 */
export function cardSourceImports(source, key) {
  const out = [];
  for (const spec of importSpecifiers(source)) for (const c of resolveSpecifier(key, spec) ?? []) out.push(c);
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ Values of the page's built-in modules */

/**
 * Marker of pure functions in the built-in module table that "can be called with literal arguments"
 * (see `pureCall`)
 */
export const PURE_CALL = Symbol.for("promptcut.cardSourceParse.pureCall");

/**
 * Registers a pure function of the page itself (literal input, plain data output, for example
 * `assetOptions(kind)`) into the built-in module table: calls in user card source such as
 * `assetOptions("lottie")` that use literal arguments are evaluated with it. It calls the page's own
 * code and does not execute user source.
 */
export function pureCall(fn) {
  return Object.freeze({ [PURE_CALL]: fn });
}
const isPureCall = (v) => !!v && typeof v === "object" && typeof v[PURE_CALL] === "function";

/**
 * Exported value of a built-in module → a copy as plain data (string, finite number, boolean, null,
 * array, plain object); anything else returns undefined
 */
function toPlain(v, depth = 0) {
  if (depth > 24) return undefined;
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) { const p = toPlain(x, depth + 1); if (p === undefined) return undefined; out.push(p); }
    return out;
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return undefined;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "__proto__") continue;
      const p = toPlain(x, depth + 1);
      if (p === undefined) return undefined;
      out[k] = p;
    }
    return out;
  }
  return undefined;
}

/* ------------------------------------------------------------------ Literal evaluation */

/** A value ends when it is followed by this punctuation */
const VALUE_END = new Set([",", ";", ")", "]", "}"]);
/** Words that start a top-level statement: without a semicolon, the previous statement's value ends here */
const STATEMENT_WORDS = new Set(["const", "let", "var", "export", "function", "import", "type", "interface", "class", "declare", "enum", "async"]);

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function numberOf(raw) {
  if (typeof raw !== "string" || /n$/.test(raw)) return null;
  const n = Number(raw.replace(/_/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Evaluator: walks by index over the token table of one module. An identifier is looked up first among
 * the top-level declarations of the same file, then among imports (across files via `ctx`, and in the
 * built-in modules).
 * Each `parse*` returns `{ ok, value, end }`: `ok` means the whole span is literal; for objects and
 * arrays, even when `ok` is false, `value` keeps the part that was recognized (an object drops the keys
 * it cannot recognize and records them in `dropped`; an array drops the elements it cannot recognize,
 * and `items` keeps the result of every element one by one); `end` is the index after this value.
 * The reason an unrecognized identifier is not recognized is recorded in `whys` (used by the
 * parameters panel to say which one).
 */
class Evaluator {
  constructor(mod, ctx) {
    this.mod = mod;
    this.ctx = ctx;
    this.t = mod.tokens;
    this.constAt = mod.constAt;
    this.cache = new Map();
    this.resolving = new Set();
    /** Name → reason it is not recognized */
    this.whys = new Map();
  }

  /**
   * Skips an expression that is not recognized: up to the `,` / `;` at the same level, or the closing
   * bracket that would make the depth negative (not consumed)
   */
  skipExpr(i) {
    const t = this.t;
    let depth = 0;
    for (; i < t.length; i++) {
      const tok = t[i];
      if (tok.t !== "punct") continue;
      if (tok.v === "(" || tok.v === "[" || tok.v === "{") depth++;
      else if (tok.v === ")" || tok.v === "]" || tok.v === "}") { if (depth === 0) return i; depth--; }
      else if ((tok.v === "," || tok.v === ";") && depth === 0) return i;
    }
    return i;
  }

  /** Skips a trailing type assertion (`as const`, `satisfies X`, `as Record<K, V>`): up to the end of the value */
  skipType(i) {
    const t = this.t;
    let depth = 0;
    let angle = 0;
    for (; i < t.length; i++) {
      const tok = t[i];
      if (tok.t === "word" && depth === 0 && angle === 0 && STATEMENT_WORDS.has(tok.v)) return i;
      if (tok.t !== "punct") continue;
      if (tok.v === "<") angle++;
      else if (tok.v === ">") angle = Math.max(0, angle - 1);
      else if (tok.v === ">>") angle = Math.max(0, angle - 2);
      else if (tok.v === "(" || tok.v === "[" || tok.v === "{") depth++;
      else if (tok.v === ")" || tok.v === "]" || tok.v === "}") { if (depth === 0) return i; depth--; }
      else if ((tok.v === "," && angle === 0 || tok.v === ";") && depth === 0) return i;
    }
    return i;
  }

  /**
   * After a value has been read: if the end follows, finish; if a type assertion follows, skip it;
   * if anything else follows (an operator, a call, ...), the whole thing is not a literal
   */
  finish(r) {
    const n = this.t[r.end];
    if (!n || (n.t === "punct" && VALUE_END.has(n.v))) return r;
    if (n.t === "word" && (n.v === "as" || n.v === "satisfies")) return { ...r, end: this.skipType(r.end + 1) };
    if (n.t === "word" && STATEMENT_WORDS.has(n.v)) return r;
    return { ok: false, value: undefined, end: this.skipExpr(r.end) };
  }

  /**
   * Value of an identifier: a top-level constant of the same file, or an imported
   * one (across files, built-in modules)
   */
  resolve(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    let out;
    const at = this.constAt.get(name);
    if (at !== undefined) {
      if (this.resolving.has(name)) return { ok: false, value: undefined, why: "circular reference" };
      this.resolving.add(name);
      const r = this.parse(at);
      this.resolving.delete(name);
      out = { ok: r.ok, value: r.value, ...(r.items ? { items: r.items } : {}), ...(r.dropped ? { dropped: r.dropped } : {}) };
    } else if (this.mod.imports.has(name)) {
      out = this.ctx.importValue(this.mod, this.mod.imports.get(name));
    } else {
      out = { ok: false, value: undefined, why: "not a literal" };
    }
    if (!out.ok && out.why) this.whys.set(name, out.why);
    this.cache.set(name, out);
    return out;
  }

  /** Value of `ns.x` (`import * as ns`); returns null if it is not a namespace import */
  member(nsName, prop) {
    const b = this.mod.imports.get(nsName);
    if (!b || b.name !== "*" || this.constAt.has(nsName)) return null;
    const r = this.ctx.importValue(this.mod, { ...b, name: prop });
    if (!r.ok && r.why) this.whys.set(`${nsName}.${prop}`, r.why);
    return r;
  }

  /**
   * Calls a pure function registered by a built-in module (`pureCall`), only when all arguments are
   * literals; otherwise returns null (handled as usual as "not a literal")
   */
  call(i) {
    const tok = this.t[i];
    let callee = null;
    let open = i + 1;
    if (this.t[i + 1]?.t === "punct" && this.t[i + 1].v === "(") {
      if (!this.constAt.has(tok.v) && this.mod.imports.has(tok.v)) callee = this.ctx.importRaw(this.mod, this.mod.imports.get(tok.v));
    } else if (this.t[i + 1]?.v === "." && this.t[i + 2]?.t === "word" && this.t[i + 3]?.v === "(") {
      const b = this.mod.imports.get(tok.v);
      if (b && b.name === "*" && !this.constAt.has(tok.v)) callee = this.ctx.importRaw(this.mod, { ...b, name: this.t[i + 2].v });
      open = i + 3;
    }
    if (!isPureCall(callee)) return null;
    const args = [];
    let k = open + 1;
    for (;;) {
      const a = this.t[k];
      if (!a) return null;
      if (a.t === "punct" && a.v === ")") break;
      if (a.t === "punct" && a.v === ",") { k++; continue; }
      const r = this.parse(k);
      if (!r.ok) return null;
      args.push(r.value);
      k = Math.max(r.end, k + 1);
    }
    let value;
    try { value = toPlain(callee[PURE_CALL](...args)); } catch { value = undefined; }
    if (value === undefined) return null;
    return this.finish({ ok: true, value, end: k + 1 });
  }

  parse(i) {
    const tok = this.t[i];
    if (!tok) return { ok: false, value: undefined, end: i };
    const fail = () => ({ ok: false, value: undefined, end: this.skipExpr(i) });
    if (tok.t === "string") return this.finish({ ok: true, value: tok.v, end: i + 1 });
    if (tok.t === "template") return tok.v === null ? fail() : this.finish({ ok: true, value: tok.v, end: i + 1 });
    if (tok.t === "number") {
      const n = numberOf(tok.v);
      return n === null ? fail() : this.finish({ ok: true, value: n, end: i + 1 });
    }
    if (tok.t === "punct" && (tok.v === "-" || tok.v === "+") && this.t[i + 1]?.t === "number") {
      const n = numberOf(this.t[i + 1].v);
      return n === null ? fail() : this.finish({ ok: true, value: tok.v === "-" ? (n === 0 ? 0 : -n) : n, end: i + 2 });
    }
    if (tok.t === "word") {
      if (tok.v === "true" || tok.v === "false") return this.finish({ ok: true, value: tok.v === "true", end: i + 1 });
      if (tok.v === "null") return this.finish({ ok: true, value: null, end: i + 1 });
      // A pure function registered by a built-in module, called with literal arguments
      const called = this.call(i);
      if (called) return called;
      // `ns.x`: a member of a namespace import
      if (this.t[i + 1]?.t === "punct" && this.t[i + 1].v === "." && this.t[i + 2]?.t === "word") {
        const m = this.member(tok.v, this.t[i + 2].v);
        if (m) return this.finish({ ...m, end: i + 3 });
      }
      // A top-level constant of the same file or an imported value (an `X` directly followed by `.` / `(` / `[`
      // is a member access or a call, which `finish` judges as not a literal)
      const r = this.resolve(tok.v);
      return this.finish({ ...r, end: i + 1 });
    }
    if (tok.t === "punct" && tok.v === "(") {
      const r = this.parse(i + 1);
      const close = this.t[r.end];
      if (!close || close.t !== "punct" || close.v !== ")") return fail();
      return this.finish({ ...r, end: r.end + 1 });
    }
    if (tok.t === "punct" && tok.v === "[") return this.finish(this.parseArray(i));
    if (tok.t === "punct" && tok.v === "{") return this.finish(this.parseObject(i));
    return fail();
  }

  /**
   * The name of an element when it is a bare identifier (`X` or `ns.x`) (used to explain why it is not
   * recognized)
   */
  nameAt(k) {
    const a = this.t[k], b = this.t[k + 1];
    if (!a || a.t !== "word") return null;
    if (b?.t === "punct" && b.v === "." && this.t[k + 2]?.t === "word") return `${a.v}.${this.t[k + 2].v}`;
    return a.v;
  }

  parseArray(open) {
    const t = this.t;
    const items = [];
    const value = [];
    let ok = true;
    let k = open + 1;
    for (;;) {
      const tok = t[k];
      if (!tok) return { ok: false, value, items, end: k };
      if (tok.t === "punct" && tok.v === "]") return { ok, value, items, end: k + 1 };
      if (tok.t === "punct" && tok.v === ",") { k++; continue; }
      if (tok.t === "punct" && tok.v === "...") {
        const name = this.nameAt(k + 1);
        const r = this.parse(k + 1);
        if (Array.isArray(r.value)) {
          // Every spread-in element is still kept one by one (when some elements of an imported array are not
          // recognized, the rest are used as usual)
          const sub = r.items ?? r.value.map((v) => ({ ok: true, value: v }));
          for (const it of sub) { items.push(it); if (it.ok) value.push(it.value); }
          if (!r.ok) ok = false;
        } else {
          ok = false;
          items.push({ ok: false, value: undefined, spread: true, name, why: (name && this.whys.get(name)) || r.why || "not a literal" });
        }
        k = Math.max(r.end, k + 1);
        continue;
      }
      const name = this.nameAt(k);
      const r = this.parse(k);
      items.push({ ok: r.ok, value: r.value, ...(r.dropped ? { dropped: r.dropped } : {}), ...(name ? { name } : {}),
        ...(!r.ok ? { why: (name && this.whys.get(name)) || r.why || "not a literal" } : {}) });
      if (r.ok) value.push(r.value);
      else ok = false;
      k = Math.max(r.end, k + 1);
      // The element is followed by neither a comma nor `]`: not recognized (for example truncated); close it off
      const next = t[k];
      if (next && !(next.t === "punct" && (next.v === "," || next.v === "]"))) { ok = false; k = this.skipExpr(k); if (t[k]?.v === ";") return { ok: false, value, items, end: k }; }
    }
  }

  parseObject(open) {
    const t = this.t;
    const value = {};
    const dropped = [];
    let ok = true;
    let k = open + 1;
    const set = (key, v) => { if (key !== "__proto__") value[key] = v; };
    const done = (r) => (dropped.length ? { ...r, dropped } : r);
    for (;;) {
      const tok = t[k];
      if (!tok) return done({ ok: false, value, end: k });
      if (tok.t === "punct" && tok.v === "}") return done({ ok, value, end: k + 1 });
      if (tok.t === "punct" && tok.v === ",") { k++; continue; }
      if (tok.t === "punct" && tok.v === "...") {
        // Spread: a literal object (of the same file or imported); keys written after the spread override it,
        // as in JS, by order
        const r = this.parse(k + 1);
        if (isPlainObject(r.value)) for (const [kk, vv] of Object.entries(r.value)) set(kk, vv);
        if (!r.ok) ok = false;
        k = Math.max(r.end, k + 1);
        continue;
      }
      let key = null;
      if (tok.t === "word" || tok.t === "string") key = tok.v;
      else if (tok.t === "number") key = String(numberOf(tok.v) ?? tok.v);
      else if (tok.t === "template" && tok.v !== null) key = tok.v;
      const after = t[k + 1];
      if (key !== null && after && after.t === "punct" && after.v === ":") {
        const r = this.parse(k + 2);
        if (r.ok) set(key, r.value);
        else { ok = false; dropped.push(key); }
        k = Math.max(r.end, k + 2);
        continue;
      }
      if (key !== null && tok.t === "word" && (!after || (after.t === "punct" && (after.v === "," || after.v === "}")))) {
        // Shorthand `{ a }`: the top-level constant or import of the same name
        const r = this.resolve(key);
        if (r.ok) set(key, r.value);
        else { ok = false; dropped.push(key); }
        k++;
        continue;
      }
      // Methods, getters, computed keys: this entry is not recognized
      ok = false;
      if (key !== null) dropped.push(key);
      const next = this.skipExpr(k + 1);
      k = next > k ? next : k + 1;
      if (t[k]?.v === ";") return done({ ok: false, value, end: k });
    }
  }
}

/* ------------------------------------------------------------------ Module */

/**
 * The inside of `{ a, b as c, type d, default as e }` (`from`..`to`, without the braces) →
 * `[[original name, new name]]`; type items do not count
 */
function namePairs(tokens, from, to) {
  const out = [];
  let group = [];
  const flush = () => {
    const g = group;
    group = [];
    if (!g.length) return;
    if (g[0].t === "word" && g[0].v === "type" && g.length > 1 && !(g[1].t === "word" && g[1].v === "as")) return;
    const name = g[0].t === "word" || g[0].t === "string" ? g[0].v : null;
    if (!name) return;
    if (g[1]?.t === "word" && g[1].v === "as" && g[2] && (g[2].t === "word" || g[2].t === "string")) out.push([name, g[2].v]);
    else out.push([name, name]);
  };
  for (let m = from; m < to; m++) {
    const n = tokens[m];
    if (n.t === "punct" && n.v === ",") flush();
    else group.push(n);
  }
  flush();
  return out;
}

/**
 * Top-level `import` statement (`k` is the `import` token) → bindings: local name → `{ spec, name }`
 * (`name`: `default` / `*` / exported name); type imports, side-effect imports and dynamic imports
 * do not count
 */
function importAt(tokens, k, imports) {
  let j = k + 1;
  const first = tokens[j];
  if (!first || first.t === "string") return;
  if (first.t === "punct" && (first.v === "(" || first.v === ".")) return;
  if (first.t === "word" && first.v === "type" && tokens[j + 1] && !(tokens[j + 1].t === "word" && tokens[j + 1].v === "from")) return;
  let fromAt = -1;
  for (let m = j; m < tokens.length && m < j + 400; m++) {
    const n = tokens[m];
    if (n.depth === 0 && n.t === "word" && n.v === "from" && tokens[m + 1]?.t === "string") { fromAt = m; break; }
    if (n.depth === 0 && n.t === "punct" && n.v === ";") return;
  }
  if (fromAt < 0) return;
  const spec = tokens[fromAt + 1].v;
  while (j < fromAt) {
    const n = tokens[j];
    if (n.t === "punct" && n.v === ",") { j++; continue; }
    if (n.t === "punct" && n.v === "*" && tokens[j + 1]?.v === "as" && tokens[j + 2]?.t === "word") { imports.set(tokens[j + 2].v, { spec, name: "*" }); j += 3; continue; }
    if (n.t === "punct" && n.v === "{") {
      const end = closeOf(tokens, j);
      for (const [imported, local] of namePairs(tokens, j + 1, end)) imports.set(local, { spec, name: imported });
      j = end + 1;
      continue;
    }
    if (n.t === "word") { imports.set(n.v, { spec, name: "default" }); j++; continue; }
    j++;
  }
}

const NOT_VALUE_WORDS = ["function", "class", "async", "abstract"];

/**
 * Scans the top level of a source: declarations, imports, exports. Returns the module object; returns
 * null on a lexing error.
 * `exportsMap`: export name → `{ local }` (a name in this file) or `{ from, name }` (re-export);
 * `starFrom`: the specifiers of `export * from`;
 * `defaultAt`: the index of the start of the expression of `export default <expression>`. Card
 * recognition uses `exported` (local names) and `exportedObjects` (indices of object literals) separately.
 */
function scanModule(key, source) {
  if (typeof source !== "string" || !source) return null;
  let tokens;
  try { tokens = new Lexer(source).all(); } catch { return null; }
  const mod = {
    key, tokens, index: new Map(tokens.map((t, i) => [t, i])),
    constAt: new Map(), consts: new Map(), objects: new Map(),
    imports: new Map(), exportsMap: new Map(), starFrom: [], defaultAt: undefined,
    exported: [], exportedObjects: [],
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.depth !== 0) continue;
    if (t.t === "word" && t.v === "import") { importAt(tokens, k, mod.imports); continue; }
    const isExport = t.t === "word" && t.v === "export";
    const declAt = isExport ? k + 1 : k;
    const decl = declarationAt(tokens, declAt);
    if (decl && tokens[declAt].depth === 0) {
      if (!mod.constAt.has(decl.name)) mod.constAt.set(decl.name, decl.valueAt);
      if (isExport && !mod.exportsMap.has(decl.name)) mod.exportsMap.set(decl.name, { local: decl.name });
      const v = tokens[decl.valueAt];
      if (v && (v.t === "string" || (v.t === "template" && v.v !== null))) {
        const after = tokens[decl.valueAt + 1];
        if (!after || after.depth !== 0 || (after.t === "punct" && after.v === ";") || (after.t === "word" && (after.v === "as" || after.v === "satisfies"))
          || after.t === "word") mod.consts.set(decl.name, v.v);
      }
      if (v && v.t === "punct" && v.v === "{") {
        mod.objects.set(decl.name, decl.valueAt);
        if (isExport) mod.exported.push(decl.name);
      }
      continue;
    }
    if (!isExport) continue;
    const next = tokens[k + 1];
    if (!next) continue;
    if (next.t === "word" && next.v === "default") {
      const v = tokens[k + 2];
      if (v && v.t === "punct" && v.v === "{") { mod.exportedObjects.push(k + 2); mod.defaultAt = k + 2; }
      else if (v && v.t === "word" && !NOT_VALUE_WORDS.includes(v.v) && !(tokens[k + 3]?.t === "punct" && ["(", ".", "["].includes(tokens[k + 3].v))) {
        mod.exported.push(v.v);
        mod.exportsMap.set("default", { local: v.v });
      } else if (v && !(v.t === "word" && NOT_VALUE_WORDS.includes(v.v))) mod.defaultAt = k + 2;
      continue;
    }
    if (next.t === "word" && (next.v === "function" || next.v === "class")) {
      const n = tokens[k + 2];
      if (n?.t === "word" && !mod.exportsMap.has(n.v)) mod.exportsMap.set(n.v, { local: n.v });
      continue;
    }
    if (next.t === "punct" && next.v === "*") {
      // export * from "x" / export * as ns from "x"
      const asNs = tokens[k + 2]?.t === "word" && tokens[k + 2].v === "as" ? tokens[k + 3]?.v : null;
      const fromTok = tokens[asNs ? k + 4 : k + 2];
      const spec = tokens[asNs ? k + 5 : k + 3];
      if (fromTok?.t === "word" && fromTok.v === "from" && spec?.t === "string") {
        if (asNs) mod.exportsMap.set(asNs, { from: spec.v, name: "*" });
        else mod.starFrom.push(spec.v);
      }
      continue;
    }
    if (next.t === "punct" && next.v === "{") {
      // export { a, b as c }; re-export: export { a as b } from "x"
      const end = closeOf(tokens, k + 1);
      const from = tokens[end + 1];
      const spec = from && from.t === "word" && from.v === "from" && tokens[end + 2]?.t === "string" ? tokens[end + 2].v : null;
      for (const [orig, alias] of namePairs(tokens, k + 2, end)) {
        if (mod.exportsMap.has(alias)) continue;
        mod.exportsMap.set(alias, spec !== null ? { from: spec, name: orig } : { local: orig });
      }
      if (spec !== null) continue; // A card object re-exported from elsewhere is not in this file, so card recognition cannot recognize it (control values can still be followed)
      for (let j = k + 2; j < end; j++) {
        const n = tokens[j];
        if (n.t === "word" && n.v !== "as" && n.v !== "type" && !(tokens[j - 1]?.t === "word" && tokens[j - 1].v === "as")) mod.exported.push(n.v);
      }
    }
  }
  return mod;
}

const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/**
 * Context of one parse: fetching other files (`files`), the page's built-in modules (`builtins`),
 * the module cache, cross-file cycle detection
 */
function createContext({ files, builtins } = {}) {
  const modules = new Map();
  const resolving = new Set();
  const fileOf = (k) => { try { const s = typeof files === "function" ? files(k) : undefined; return typeof s === "string" ? s : null; } catch { return null; } };
  const builtinOf = (k) => { try { const b = typeof builtins === "function" ? builtins(k) : undefined; return b && typeof b === "object" ? b : null; } catch { return null; } };
  const ctx = {
    load(key, source) {
      if (modules.has(key)) return modules.get(key);
      const mod = scanModule(key, source ?? fileOf(key));
      if (mod) mod.ev = new Evaluator(mod, ctx);
      modules.set(key, mod);
      return mod;
    },
    /** Specifier → `{ kind: 'file' | 'builtin', key }`; returns `{ why }` if not found */
    locate(fromKey, spec) {
      const cands = resolveSpecifier(fromKey, spec);
      if (!cands) return { why: `imported from ${spec} (not a relative path, the online page cannot read it)` };
      for (const c of cands) if (fileOf(c) !== null) return { kind: "file", key: c };
      for (const c of cands) if (builtinOf(c)) return { kind: "builtin", key: c };
      return { why: cands[0].startsWith("src/cards/user/") ? `the content store has no file ${spec}` : `${spec} is not a built-in module the online page recognizes` };
    },
    /** The value of one export of a file */
    exportValue(key, name) {
      const mod = ctx.load(key);
      if (!mod) return { ok: false, value: undefined, why: `${key} cannot be read` };
      const guard = `${key}#${name}`;
      if (resolving.has(guard)) return { ok: false, value: undefined, why: "circular reference" };
      resolving.add(guard);
      try {
        if (name === "default" && mod.defaultAt !== undefined) return mod.ev.parse(mod.defaultAt);
        const e = mod.exportsMap.get(name);
        if (e && "local" in e) return mod.ev.resolve(e.local);
        if (e && "from" in e) return ctx.importValue(mod, { spec: e.from, name: e.name });
        if (name !== "default") {
          for (const spec of mod.starFrom) {
            const loc = ctx.locate(key, spec);
            if (!loc.key) continue;
            const has = loc.kind === "builtin" ? hasOwn(builtinOf(loc.key), name) : ctx.exports(loc.key, name);
            if (has) return ctx.importValue(mod, { spec, name });
          }
        }
        return { ok: false, value: undefined, why: `${key.split("/").pop()} does not export ${name}` };
      } finally {
        resolving.delete(guard);
      }
    },
    /** Whether this file has this export (used for `export *` lookup; with cycle detection) */
    exports(key, name, seen = new Set()) {
      if (seen.has(key)) return false;
      seen.add(key);
      const mod = ctx.load(key);
      if (!mod) return false;
      if (mod.exportsMap.has(name)) return true;
      for (const spec of mod.starFrom) {
        const loc = ctx.locate(key, spec);
        if (loc.kind === "file" && ctx.exports(loc.key, name, seen)) return true;
        if (loc.kind === "builtin" && hasOwn(builtinOf(loc.key), name)) return true;
      }
      return false;
    },
    /**
     * The raw exported value of a built-in module (a pure function marker is returned as is, for the caller
     * to judge); returns null if it is not a built-in module
     */
    importRaw(mod, binding) {
      const loc = ctx.locate(mod.key, binding.spec);
      if (loc.kind !== "builtin" || binding.name === "*") return null;
      const ns = builtinOf(loc.key);
      return hasOwn(ns, binding.name) ? ns[binding.name] : null;
    },
    /** The value of an import binding */
    importValue(mod, binding) {
      const loc = ctx.locate(mod.key, binding.spec);
      if (!loc.key) return { ok: false, value: undefined, why: loc.why };
      if (binding.name === "*") return { ok: false, value: undefined, why: `the whole module ${binding.spec} cannot be used as a value` };
      if (loc.kind === "file") return ctx.exportValue(loc.key, binding.name);
      const ns = builtinOf(loc.key);
      if (!hasOwn(ns, binding.name)) return { ok: false, value: undefined, why: `built-in module ${binding.spec} has no ${binding.name}` };
      const raw = ns[binding.name];
      if (isPureCall(raw)) return { ok: false, value: undefined, why: `${binding.name} is a function; only calls with literal arguments are supported` };
      const value = toPlain(raw);
      if (value === undefined) return { ok: false, value: undefined, why: `${binding.name} of built-in module ${binding.spec} is not plain data` };
      return { ok: true, value };
    },
  };
  return ctx;
}

/* ------------------------------------------------------------------ Controls */

const CONTROL_TYPES = new Set(["text", "number", "select", "color", "asset"]);
const ASSET_KINDS = new Set(["lottie", "particles"]);

/**
 * `options` table → `[{ value, label }]`. Recognizes: `{ value: string, label: string }`; one with a
 * missing `label` uses `value` as the label; a plain string array (each item is both value and label);
 * an object of the form `{ value: label }`. If a single item is not recognized, the whole thing is not
 * recognized and null is returned.
 */
function optionsOf(v) {
  if (isPlainObject(v)) {
    const entries = Object.entries(v);
    if (!entries.length || !entries.every(([, l]) => typeof l === "string")) return null;
    return entries.map(([value, label]) => ({ value, label }));
  }
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const o of v) {
    if (typeof o === "string") { out.push({ value: o, label: o }); continue; }
    if (!isPlainObject(o) || typeof o.value !== "string") return null;
    if (o.label !== undefined && typeof o.label !== "string") return null;
    out.push({ value: o.value, label: typeof o.label === "string" ? o.label : o.value });
  }
  return out;
}

/** Infers the kind of an `asset` from a URL: the address of an asset catalog looks like `/catalog/<kind>/<name>.json` */
function kindOfUrl(u) {
  if (typeof u !== "string") return null;
  const m = /(?:^|\/)catalog\/(lottie|particles)\//.exec(u);
  return m ? m[1] : null;
}

/**
 * A control object (already evaluated, possibly missing fields that were not recognized) → `{ control }`
 * or `{ reason }` (why it cannot be drawn, used for the panel's explanation).
 * `dropped`: keys written in this object whose values are not literals; `defaultValue`: the value of this
 * key in the `defaults` of this card (used to infer the kind of an `asset`).
 * Fills in what can be inferred (see the file header), and gives a reason for what cannot.
 */
export function controlFix(v, { dropped = [], defaultValue } = {}) {
  if (!isPlainObject(v)) return { reason: "not a literal" };
  const miss = (f, what) => (dropped.includes(f) ? `${what} is not a literal` : `missing ${what}`);
  const { key, type, label } = v;
  if (typeof key !== "string" || !key) return { reason: miss("key", "key") };
  if (typeof label !== "string") return { reason: miss("label", "label") };
  if (typeof type !== "string") return { reason: miss("type", "type") };
  if (!CONTROL_TYPES.has(type)) return { reason: `unknown type (${type})` };
  const c = { key, label, type };
  if (typeof v.required === "boolean") c.required = v.required;
  if (typeof v.hint === "string") c.hint = v.hint;
  if (type === "number") {
    for (const f of ["min", "max", "step"]) if (typeof v[f] === "number" && Number.isFinite(v[f])) c[f] = v[f];
  }
  if (type === "select") {
    if (v.options === undefined) return { reason: `dropdown: ${miss("options", "options (options)")}` };
    const options = optionsOf(v.options);
    if (!options) return { reason: "Can't recognize how the dropdown options (options) are written" };
    c.options = options;
  }
  if (type === "asset") {
    const options = v.options === undefined ? [] : optionsOf(v.options) ?? [];
    let kind = v.kind;
    if (kind === undefined) {
      // Inference: the addresses of the options and of the default value all point to the same kind of asset catalog
      const kinds = new Set([...options.map((o) => kindOfUrl(o.value)), kindOfUrl(defaultValue)].filter(Boolean));
      if (kinds.size === 1) kind = [...kinds][0];
      else return { reason: `media control: ${miss("kind", "kind (kind)")}; also cannot infer whether it is lottie or particles` };
    }
    if (!ASSET_KINDS.has(kind)) return { reason: `unknown media kind (kind) (${String(kind)})` };
    c.kind = kind;
    c.options = options;
  }
  return { control: c };
}

/**
 * A control object (already evaluated, possibly missing fields that were not recognized) → `Control`;
 * returns null if it cannot be drawn (see the file header)
 */
export function controlOf(v) {
  return controlFix(v).control ?? null;
}

/** A skipped control: the recognizable key / label / type and the reason */
function skippedOf(it, reason) {
  const v = isPlainObject(it.value) ? it.value : {};
  return {
    ...(typeof v.key === "string" ? { key: v.key } : {}),
    ...(typeof v.label === "string" ? { label: v.label } : {}),
    ...(typeof v.type === "string" ? { type: v.type } : {}),
    reason,
  };
}

/** `defaults` / `controls` / `description` on the card object */
function literalFields(mod, props) {
  const ev = mod.ev;
  /** The evaluation result of a property value; a shorthand property uses the constant or import of the same name */
  const valueOf = (key) => {
    if (!props.has(key)) return undefined;
    const slice = props.get(key);
    if (slice === null) return ev.resolve(key);
    if (!slice.length) return undefined;
    const at = mod.index.get(slice[0]);
    return at === undefined ? undefined : ev.parse(at);
  };
  const out = { defaults: {}, controls: [], controlsIncomplete: false, skippedControls: [] };
  const d = valueOf("defaults");
  if (d && isPlainObject(d.value)) out.defaults = d.value;
  const r = valueOf("controls") ?? { ok: false, value: undefined };
  if (Array.isArray(r.value)) {
    // `items` keeps every element one by one (an object keeps the recognized part even if it has fields
    // that are not recognized)
    const items = r.items ?? r.value.map((v) => ({ ok: true, value: v }));
    for (const it of items) {
      if (!isPlainObject(it.value)) {
        out.controlsIncomplete = true;
        const what = it.spread ? `spread ${it.name ?? "expression"}` : it.name;
        out.skippedControls.push(skippedOf(it, what ? `${what} could not be resolved: ${it.why ?? "not a literal"}` : "not a literal"));
        continue;
      }
      const key = typeof it.value.key === "string" ? it.value.key : undefined;
      const fix = controlFix(it.value, { dropped: it.dropped ?? [], defaultValue: key !== undefined ? out.defaults[key] : undefined });
      if (fix.control) out.controls.push(fix.control);
      else { out.controlsIncomplete = true; out.skippedControls.push(skippedOf(it, fix.reason)); }
    }
    if (!r.ok && !out.controlsIncomplete) { out.controlsIncomplete = true; out.skippedControls.push({ reason: "the controls table has syntax that is not recognized" }); }
  } else {
    out.controlsIncomplete = true;
    const slice = props.get("controls");
    const name = slice === null ? "controls" : slice?.length === 1 && slice[0].t === "word" ? slice[0].v : null;
    const why = name ? ev.whys.get(name) : null;
    out.skippedControls.push({ reason: why ? `the whole controls table ${name} could not be resolved: ${why}` : "the whole controls table (controls) is not a literal" });
  }
  const desc = valueOf("description");
  if (desc && desc.ok && typeof desc.value === "string") out.description = desc.value;
  return out;
}

/**
 * The cards defined in one card source:
 * `[{ id, name, description?, defaults, controls, controlsIncomplete, skippedControls }]`, in source order;
 * only the first card of the same id is kept. Returns an empty array if no card is recognized; does not throw.
 *
 * `opts` (all optional; if omitted only the same file is looked at):
 *   - `key`: the repo-relative path of this source (`src/cards/user/x.tsx`), against which relative
 *     imports are resolved;
 *   - `files(key)`: the source of another file (the `card-source` synced into the content store); returns
 *     null / undefined if there is none;
 *   - `builtins(key)`: the exports of a built-in module the page ships with (`{ name: value }`, where the
 *     value is plain data, or a pure function registered via `pureCall`); returns null / undefined if
 *     there is none.
 */
export function parseCardSource(source, opts = {}) {
  if (typeof source !== "string" || !source) return [];
  const key = typeof opts?.key === "string" && opts.key ? opts.key : "src/cards/user/__entry__.tsx";
  const ctx = createContext(opts ?? {});
  const mod = ctx.load(key, source);
  if (!mod) return [];
  const { tokens, objects, exportedObjects } = mod;
  for (const name of mod.exported) {
    const at = objects.get(name);
    if (at !== undefined) exportedObjects.push(at);
  }
  exportedObjects.sort((a, b) => a - b);
  const out = [];
  const seen = new Set();
  const usedAt = new Set();
  /**
   * id / name: a literal or a string constant of the same file; if neither, use the evaluator
   * (an imported string constant)
   */
  const stringOf = (props, k) => {
    const s = stringValue(props.get(k), mod.consts);
    if (s !== null) return s;
    const slice = props.get(k);
    if (!slice || !slice.length) return null;
    const at = mod.index.get(slice[0]);
    if (at === undefined) return null;
    try { const r = mod.ev.parse(at); return r.ok && typeof r.value === "string" ? r.value : null; } catch { return null; }
  };
  for (const at of exportedObjects) {
    if (usedAt.has(at)) continue;
    usedAt.add(at);
    const props = mergedProps(tokens, objects, at);
    const id = stringOf(props, "id");
    const name = stringOf(props, "name");
    if (typeof id !== "string" || !id || typeof name !== "string") continue;
    if (!props.has("defaults") || !props.has("controls")) continue;
    if (!props.has("Component") && !props.has("card") && !props.has("audio")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    let fields;
    try { fields = literalFields(mod, props); } catch { fields = { defaults: {}, controls: [], controlsIncomplete: true, skippedControls: [{ reason: "parse error" }] }; }
    const { description, defaults, controls, controlsIncomplete, skippedControls } = fields;
    out.push({ id, name, ...(props.has("audio") && (props.has("Component") || props.has("card")) ? { embeddedAudio: true } : {}), ...(description !== undefined ? { description } : {}), defaults, controls, controlsIncomplete, skippedControls });
  }
  return out;
}

/**
 * Whether a card source key in the content store is the entry file of a user card (same as the glob
 * `./*.tsx` of `src/cards/user/index.ts`)
 */
export function isUserCardEntryKey(key) {
  return typeof key === "string" && /^src\/cards\/user\/[^/]+\.tsx$/.test(key);
}
