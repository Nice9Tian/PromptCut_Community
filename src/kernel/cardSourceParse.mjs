/**
 * 从一份卡片源码(`src/cards/user/*.tsx` 的原文)里取出它定义的卡片的 id、名字、说明、参数默认值与参数控件,**不执行源码**。
 *
 * 用处(C10 契约第 9 节「识别」):在线浏览器模式的页面经文档服务读到内容库里同步来的卡片源码,但本机不能运行它们;
 * 页面要知道「这个 id 是一张用户卡、叫什么名字」(时间轴标真名、预览按本机跑不了的卡处理),以及它有哪些参数
 * (参数面板照常能改;片段照常可以改参数)。
 *
 * `defaults` / `controls` / `description` 只认字面量:字符串、没有替换的模板字符串、数字(含负数)、布尔、null、数组、对象,
 * 以及同文件顶层 `const X = 字面量` 的引用(对象、数组里的展开也认同文件的字面量)。
 *
 * **跟着 import 找**(C10 契约第 9 节〔裁〕2026-09-30):给了 `opts.key` 与 `opts.files` / `opts.builtins` 时,引进来的名字也照样求值:
 *   - 相对导入到的文件在 `files` 里(在线页面给的是内容库里同一个用户卡目录下同步来的 `card-source`):解析那个文件,
 *     取它用字面量写的导出——`export const`、`export default`、`export { a as b }`、转出 `export { a } from` / `export * from`、
 *     导入时的别名 `import { a as b }`、默认导入、`import * as ns` 的 `ns.x`;引进来的文件再引别的文件照样跟,有环就停(那一个认不出);
 *   - 相对导入到的是页面自己带着的内置模块(`builtins`,例如 `src/cards/native/hud.ts` 的 `hudControls`):用页面里那份现成的值
 *     (只收纯数据);内置模块登记的纯函数(`pureCall`,例如 `assetOptions`)以字面量为参数调用时照样求值;
 *   - 都不是(包名、别名、内容库里没有的文件)的认不出,原因记下。
 * 始终不执行用户源码、不 eval。
 *
 * 认不出的部分按下面的规矩丢:
 *   - 控件逐个解析:`key`、`type`、`label` 不是字面量(或缺)的那一个跳过;个别字段不是字面量就丢掉那个字段;
 *   - `select` 的 `options` 认:`{ value, label }`(缺 `label` 用 `value`)、纯字符串数组、`{ 值: 标签 }` 对象;缺了或认不出就跳过;
 *   - `asset` 缺 `kind` 时,选项与默认值的地址都指向同一种素材目录(`/catalog/lottie/…`、`/catalog/particles/…`)就推断为那一种,
 *     推断不了跳过;`asset` 没了 `options` 按空表;
 *   - `defaults` 里不是字面量的键丢掉;
 *   - 有控件被跳过(或整个 `controls` 不是字面量)时 `controlsIncomplete` 为 true,参数面板据此说明「在线改不了」;
 *     `skippedControls` 逐条记被跳过的是哪一个(认得出的 key / label / type)和为什么,面板照着列出来。
 *
 * 判据照 `src/cards/user/index.ts` 的 `isCardDef`,只是换成读源码:具名导出(含 `export default`、`export { a as b }`)
 * 的值是一个对象字面量,顶层写着字符串的 `id` 与 `name`,并写了 `defaults`、`controls`,以及 `Component` / `card` /
 * `audio` 之一(属性、简写、方法都算)。`id` / `name` 也认同一文件顶层 `const X = "..."` 定义的常量。
 * 值不是字面量(函数返回、展开别的对象)的认不出来,当它不是卡。
 *
 * 为此带一个够用的 TSX 词法器:字符串、模板字符串(含 `${}` 嵌套)、注释、正则字面量、JSX(文字里的撇号不当字符串)。
 * 纯函数,浏览器与 Node 同一份。
 */

const PUNCT3 = ["...", "===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??="];
const PUNCT2 = ["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
/** 这些关键字之后是表达式开头(`/` 是正则,`<` 是 JSX) */
const EXPR_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof", "default", "export"]);
/** 这些标点之后是表达式开头 */
const EXPR_PUNCT = new Set(["(", "[", "{", ",", ";", ":", "?", "=", "=>", "==", "===", "!=", "!==", "+", "-", "*", "%", "&", "|", "^", "!", "~",
  "<", ">", "<=", ">=", "&&", "||", "??", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "...", "}"]);

const isIdStart = (c) => /[\p{ID_Start}$_]/u.test(c);
const isIdPart = (c) => /[\p{ID_Continue}$‌‍]/u.test(c);

/** 解码字符串字面量的正文(不含引号) */
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
        // 没闭合的 `\u{`(源码本身不合法):余下的原样留下就收尾。照常写 `i = end` 会把 i 拨回 -1、从头重扫,永远出不来
        if (end < 0) { out += raw.slice(i); break; }
        out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16) || 0);
        i = end;
      } else { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16) || 0); i += 4; }
    } else if (n === "\r") { if (raw[i + 1] === "\n") i++; }
    else if (n === "\n" || n === " " || n === " ") { /* 续行 */ }
    else out += n;
  }
  return out;
}

/**
 * 词法器。`tokens` 只收最外层上下文的记号(模板里的 `${}`、JSX 里的 `{}` 整个吞掉,不出记号);
 * 每个记号带它所在的花括号 / 圆括号 / 方括号深度 `depth`。
 * 记号:`{ t: 'word' | 'punct' | 'string' | 'template' | 'number' | 'regex' | 'jsx', v, depth }`,
 * `string` 的 `v` 是解码后的值,不带替换的模板字符串的 `v` 也是它的值(带替换的 `v` 为 null)。
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

  /** 模板字符串;回它的值(带替换时回 null) */
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

  /** 吞到与已经吃掉的那个 `{` 配对的 `}`(含);里面的字符串、模板、JSX、正则照常识别 */
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

  /** `<` 后面像不像 JSX(不是 TS 泛型箭头函数 `<T,>` / `<T extends X>`) */
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

  /** 吞一个 JSX 元素或片段(从 `<` 起) */
  skipJsx() {
    const s = this.s;
    this.i++;
    // 片段 `<>`
    if (s[this.i] === ">") { this.i++; this.skipJsxChildren(); return; }
    while (this.i < s.length && (isIdPart(s[this.i]) || s[this.i] === "." || s[this.i] === "-" || s[this.i] === ":")) this.i++;
    // 属性
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

  /** 下一个记号;到头回 null */
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

  /** 整份源码的记号表(带深度) */
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

/** 从 `open`(一个 `{` 记号)起配对到它的 `}`,回 `}` 的下标 */
function closeOf(tokens, open) {
  const d = tokens[open].depth;
  for (let k = open + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.depth === d && t.t === "punct" && (t.v === "}" || t.v === ")" || t.v === "]")) return k;
  }
  return tokens.length;
}

/**
 * 对象字面量(`open` 是它的 `{`)的顶层属性:`Map<键, 值的记号数组>`;简写属性与方法的值记成 null。
 * 展开(`...x`)记在 `spreads` 里(同文件顶层对象的名字;别的表达式记 null)。
 */
function objectProps(tokens, open) {
  const end = closeOf(tokens, open);
  const inner = tokens[open].depth + 1;
  const props = new Map();
  /** 展开的顶层标识符(`...base`),按出现先后;展开别的表达式时记 null */
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
    // 键:标识符、字符串、数字;`get` / `set` / `async` 修饰的方法跳过修饰词
    let keyTok = t;
    if (t.t === "word" && (t.v === "get" || t.v === "set" || t.v === "async") && tokens[k + 1] && tokens[k + 1].depth === inner
      && (tokens[k + 1].t === "word" || tokens[k + 1].t === "string")) { k++; keyTok = tokens[k]; }
    let key = null;
    if (keyTok.t === "word" || keyTok.t === "number") key = keyTok.v;
    else if (keyTok.t === "string") key = keyTok.v;
    else if (keyTok.t === "template" && keyTok.v !== null) key = keyTok.v;
    const after = tokens[k + 1];
    if (key !== null && after && after.t === "punct" && after.v === ":" && after.depth === inner) {
      // `key: value` —— 值吃到下一个同层逗号或对象结尾
      const from = k + 2;
      let to = from;
      while (to < end && !(tokens[to].depth === inner && tokens[to].t === "punct" && tokens[to].v === ",")) to++;
      if (!props.has(key)) props.set(key, tokens.slice(from, to));
      k = to;
      continue;
    }
    if (key !== null && (!after || after.depth !== inner || (after.t === "punct" && (after.v === "," || after.v === "}")) || k + 1 >= end)) {
      // 简写
      if (!props.has(key)) props.set(key, null);
      k++;
      continue;
    }
    if (key !== null && after && after.t === "punct" && (after.v === "(" || after.v === "<" || after.v === "?")) {
      // 方法 `key(...) {...}` / `key<T>(...)`
      if (!props.has(key)) props.set(key, null);
      let to = k + 1;
      while (to < end && !(tokens[to].depth === inner && tokens[to].t === "punct" && tokens[to].v === ",")) to++;
      k = to;
      continue;
    }
    // 计算键 `[x]: v` 之类:跳到下一个同层逗号
    while (k < end && !(tokens[k].depth === inner && tokens[k].t === "punct" && tokens[k].v === ",")) k++;
  }
  return { props, spreads, end };
}

/**
 * 对象的顶层属性,展开的同文件顶层对象(`...base`)并进来;写在展开后面的属性覆盖展开进来的(简化:展开的属性只补缺,
 * 与卡片源码里「先展开、后覆盖」的常见写法一致)。展开链有环时停。
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

/** 一个值的记号数组 → 字符串(字面量、无替换模板、同文件顶层字符串常量);认不出回 null */
function stringValue(valueTokens, consts) {
  if (!valueTokens || !valueTokens.length) return null;
  const first = valueTokens[0];
  // 允许尾随 `as const` / `satisfies X` / `as string`
  const rest = valueTokens.slice(1);
  if (rest.length && !(rest[0].t === "word" && (rest[0].v === "as" || rest[0].v === "satisfies"))) return null;
  if (first.t === "string") return first.v;
  if (first.t === "template" && first.v !== null) return first.v;
  if (first.t === "word" && consts.has(first.v)) return consts.get(first.v);
  return null;
}

/** 顶层声明:`const|let|var NAME [: 类型] = <初值>`,回 `{ name, valueAt }`(初值第一个记号的下标) */
function declarationAt(tokens, k) {
  const kw = tokens[k];
  if (!kw || kw.t !== "word" || !(kw.v === "const" || kw.v === "let" || kw.v === "var")) return null;
  const nameTok = tokens[k + 1];
  if (!nameTok || nameTok.t !== "word") return null;
  let j = k + 2;
  const d = kw.depth;
  if (tokens[j] && tokens[j].t === "punct" && tokens[j].v === ":") {
    // 跳过类型注解,直到同层的 `=`(类型里的 `<>` 也算一层)
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

/* ------------------------------------------------------------------ 跨文件:模块路径 */

/** 相对导入补的扩展名(同 vite 的解析顺序,够用) */
const MODULE_EXTS = [".ts", ".tsx", ".mjs", ".js"];

/**
 * 相对导入 → 候选的仓库相对路径(按先后试)。`fromKey` 是导入方的键(`src/cards/user/x.tsx`)。
 * 不是相对路径(包名、别名)、带查询(`?raw`)、爬出仓库根的回 null。
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

/** 这份源码里所有 `import … from`、`export … from` 的说明符(词法器认的,注释与字符串里的不算) */
export function importSpecifiers(source) {
  if (typeof source !== "string" || !source) return [];
  let tokens;
  try { tokens = new Lexer(source).all(); } catch { return []; }
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.depth !== 0 || t.t !== "word" || (t.v !== "import" && t.v !== "export")) continue;
    if (t.v === "import" && tokens[k + 1]?.t === "string") { out.push(tokens[k + 1].v); continue; }
    // 同层往后找 `from "<说明符>"`;遇到分号、下一条语句就停
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
 * 一份源码经相对导入可能引到的仓库相对路径(每个说明符的全部候选;调用方拿去和内容库的列表取交集)。
 * 在线页面据此决定还要取哪几份 `card-source`。
 */
export function cardSourceImports(source, key) {
  const out = [];
  for (const spec of importSpecifiers(source)) for (const c of resolveSpecifier(key, spec) ?? []) out.push(c);
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ 页面内置模块的值 */

/** 内置模块表里「可以拿字面量参数调用」的纯函数标记(见 `pureCall`) */
export const PURE_CALL = Symbol.for("promptcut.cardSourceParse.pureCall");

/**
 * 把页面自己的一个纯函数(输入字面量、输出纯数据,例如 `assetOptions(kind)`)登记进内置模块表:
 * 用户卡源码里 `assetOptions("lottie")` 这种以字面量为参数的调用就按它求值。调用的是页面自己的代码,不执行用户源码。
 */
export function pureCall(fn) {
  return Object.freeze({ [PURE_CALL]: fn });
}
const isPureCall = (v) => !!v && typeof v === "object" && typeof v[PURE_CALL] === "function";

/** 内置模块的导出值 → 纯数据的拷贝(字符串、有限数字、布尔、null、数组、普通对象);别的回 undefined */
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

/* ------------------------------------------------------------------ 字面量求值 */

/** 值后面跟着这些标点就算结束 */
const VALUE_END = new Set([",", ";", ")", "]", "}"]);
/** 顶层语句开头的词:没写分号时,前一条语句的值到这里结束 */
const STATEMENT_WORDS = new Set(["const", "let", "var", "export", "function", "import", "type", "interface", "class", "declare", "enum", "async"]);

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function numberOf(raw) {
  if (typeof raw !== "string" || /n$/.test(raw)) return null;
  const n = Number(raw.replace(/_/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * 求值器:在一个模块的记号表上按下标走。标识符先找同文件顶层声明,再找导入(经 `ctx` 跨文件、查内置模块)。
 * 每个 `parse*` 回 `{ ok, value, end }`:`ok` 是整段都是字面量;对象、数组即使 `ok` 为 false,`value` 里也留着认得出的那部分
 * (对象丢掉认不出的键并记在 `dropped`,数组丢掉认不出的元素,`items` 里逐个留着每个元素的结果);`end` 是这个值之后的下标。
 * 认不出的标识符把原因记在 `whys`(参数面板说明是哪一条用)。
 */
class Evaluator {
  constructor(mod, ctx) {
    this.mod = mod;
    this.ctx = ctx;
    this.t = mod.tokens;
    this.constAt = mod.constAt;
    this.cache = new Map();
    this.resolving = new Set();
    /** 名字 → 认不出的原因 */
    this.whys = new Map();
  }

  /** 跳过一个认不出的表达式:到同层的 `,` / `;`,或者会让层数变负的那个右括号(不吃掉) */
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

  /** 跳过尾随的类型断言(`as const`、`satisfies X`、`as Record<K, V>`):到值的结尾 */
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

  /** 一个值读完之后:后面是结尾就收;是类型断言就跳过;是别的(运算符、调用……)就整个不算字面量 */
  finish(r) {
    const n = this.t[r.end];
    if (!n || (n.t === "punct" && VALUE_END.has(n.v))) return r;
    if (n.t === "word" && (n.v === "as" || n.v === "satisfies")) return { ...r, end: this.skipType(r.end + 1) };
    if (n.t === "word" && STATEMENT_WORDS.has(n.v)) return r;
    return { ok: false, value: undefined, end: this.skipExpr(r.end) };
  }

  /** 标识符的值:同文件顶层常量,或导入的(跨文件、内置模块) */
  resolve(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    let out;
    const at = this.constAt.get(name);
    if (at !== undefined) {
      if (this.resolving.has(name)) return { ok: false, value: undefined, why: "循环引用" };
      this.resolving.add(name);
      const r = this.parse(at);
      this.resolving.delete(name);
      out = { ok: r.ok, value: r.value, ...(r.items ? { items: r.items } : {}), ...(r.dropped ? { dropped: r.dropped } : {}) };
    } else if (this.mod.imports.has(name)) {
      out = this.ctx.importValue(this.mod, this.mod.imports.get(name));
    } else {
      out = { ok: false, value: undefined, why: "不是字面量" };
    }
    if (!out.ok && out.why) this.whys.set(name, out.why);
    this.cache.set(name, out);
    return out;
  }

  /** `ns.x`(`import * as ns`)的值;不是命名空间导入回 null */
  member(nsName, prop) {
    const b = this.mod.imports.get(nsName);
    if (!b || b.name !== "*" || this.constAt.has(nsName)) return null;
    const r = this.ctx.importValue(this.mod, { ...b, name: prop });
    if (!r.ok && r.why) this.whys.set(`${nsName}.${prop}`, r.why);
    return r;
  }

  /** 调用内置模块登记过的纯函数(`pureCall`),参数全是字面量才调;别的回 null(照常按「不是字面量」处理) */
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
      // 内置模块登记过的纯函数、以字面量为参数调用
      const called = this.call(i);
      if (called) return called;
      // `ns.x`:命名空间导入的成员
      if (this.t[i + 1]?.t === "punct" && this.t[i + 1].v === "." && this.t[i + 2]?.t === "word") {
        const m = this.member(tok.v, this.t[i + 2].v);
        if (m) return this.finish({ ...m, end: i + 3 });
      }
      // 同文件顶层常量或导入的值(`X` 后面紧跟 `.` / `(` / `[` 是成员访问或调用,由 `finish` 判成不是字面量)
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

  /** 元素是一个裸标识符(`X` 或 `ns.x`)时它的名字(说明认不出的原因用) */
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
          // 展开进来的每个元素照样逐个留着(引进来的数组里个别元素认不出时,其余的照常用)
          const sub = r.items ?? r.value.map((v) => ({ ok: true, value: v }));
          for (const it of sub) { items.push(it); if (it.ok) value.push(it.value); }
          if (!r.ok) ok = false;
        } else {
          ok = false;
          items.push({ ok: false, value: undefined, spread: true, name, why: (name && this.whys.get(name)) || r.why || "不是字面量" });
        }
        k = Math.max(r.end, k + 1);
        continue;
      }
      const name = this.nameAt(k);
      const r = this.parse(k);
      items.push({ ok: r.ok, value: r.value, ...(r.dropped ? { dropped: r.dropped } : {}), ...(name ? { name } : {}),
        ...(!r.ok ? { why: (name && this.whys.get(name)) || r.why || "不是字面量" } : {}) });
      if (r.ok) value.push(r.value);
      else ok = false;
      k = Math.max(r.end, k + 1);
      // 元素后面既不是逗号也不是 `]`:认不出(比如截断),收掉
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
        // 展开:字面量对象(同文件或引进来的);先展开、后写的键覆盖它,和 JS 一样按先后
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
        // 简写 `{ a }`:同名的顶层常量或导入
        const r = this.resolve(key);
        if (r.ok) set(key, r.value);
        else { ok = false; dropped.push(key); }
        k++;
        continue;
      }
      // 方法、getter、计算键:认不出这一项
      ok = false;
      if (key !== null) dropped.push(key);
      const next = this.skipExpr(k + 1);
      k = next > k ? next : k + 1;
      if (t[k]?.v === ";") return done({ ok: false, value, end: k });
    }
  }
}

/* ------------------------------------------------------------------ 模块 */

/** `{ a, b as c, type d, default as e }` 的内部(`from`..`to`,不含花括号)→ `[[原名, 新名]]`;类型项不算 */
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

/** 顶层 `import` 语句(`k` 是 `import` 记号)→ 绑定:本地名 → `{ spec, name }`(`name`:`default` / `*` / 导出名);类型导入、副作用导入、动态导入不算 */
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
 * 扫一份源码的顶层:声明、导入、导出。回模块对象;词法出错回 null。
 * `exportsMap`:导出名 → `{ local }`(本文件的名字)或 `{ from, name }`(转出);`starFrom`:`export * from` 的说明符;
 * `defaultAt`:`export default <表达式>` 的表达式开头下标。卡片识别另用 `exported`(本地名)与 `exportedObjects`(对象字面量的下标)。
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
      // export { a, b as c };转出:export { a as b } from "x"
      const end = closeOf(tokens, k + 1);
      const from = tokens[end + 1];
      const spec = from && from.t === "word" && from.v === "from" && tokens[end + 2]?.t === "string" ? tokens[end + 2].v : null;
      for (const [orig, alias] of namePairs(tokens, k + 2, end)) {
        if (mod.exportsMap.has(alias)) continue;
        mod.exportsMap.set(alias, spec !== null ? { from: spec, name: orig } : { local: orig });
      }
      if (spec !== null) continue; // 从别处转出的卡对象不在本文件里,卡片识别认不出来(控件的值照样跟得过去)
      for (let j = k + 2; j < end; j++) {
        const n = tokens[j];
        if (n.t === "word" && n.v !== "as" && n.v !== "type" && !(tokens[j - 1]?.t === "word" && tokens[j - 1].v === "as")) mod.exported.push(n.v);
      }
    }
  }
  return mod;
}

const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/** 一次解析的上下文:取别的文件(`files`)、页面内置模块(`builtins`)、模块缓存、跨文件的环检测 */
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
    /** 说明符 → `{ kind: 'file' | 'builtin', key }`;找不到回 `{ why }` */
    locate(fromKey, spec) {
      const cands = resolveSpecifier(fromKey, spec);
      if (!cands) return { why: `引自 ${spec}(不是相对路径,在线页面读不到)` };
      for (const c of cands) if (fileOf(c) !== null) return { kind: "file", key: c };
      for (const c of cands) if (builtinOf(c)) return { kind: "builtin", key: c };
      return { why: cands[0].startsWith("src/cards/user/") ? `内容库里没有 ${spec} 这个文件` : `${spec} 不是在线页面认得的内置模块` };
    },
    /** 一个文件的某个导出的值 */
    exportValue(key, name) {
      const mod = ctx.load(key);
      if (!mod) return { ok: false, value: undefined, why: `${key} 读不出来` };
      const guard = `${key}#${name}`;
      if (resolving.has(guard)) return { ok: false, value: undefined, why: "循环引用" };
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
        return { ok: false, value: undefined, why: `${key.split("/").pop()} 没有导出 ${name}` };
      } finally {
        resolving.delete(guard);
      }
    },
    /** 这个文件有没有这个导出(`export *` 的查找用;带环检测) */
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
    /** 内置模块的导出原值(纯函数标记原样回,调用方判);不是内置模块回 null */
    importRaw(mod, binding) {
      const loc = ctx.locate(mod.key, binding.spec);
      if (loc.kind !== "builtin" || binding.name === "*") return null;
      const ns = builtinOf(loc.key);
      return hasOwn(ns, binding.name) ? ns[binding.name] : null;
    },
    /** 导入绑定的值 */
    importValue(mod, binding) {
      const loc = ctx.locate(mod.key, binding.spec);
      if (!loc.key) return { ok: false, value: undefined, why: loc.why };
      if (binding.name === "*") return { ok: false, value: undefined, why: `整个模块 ${binding.spec} 不能当值用` };
      if (loc.kind === "file") return ctx.exportValue(loc.key, binding.name);
      const ns = builtinOf(loc.key);
      if (!hasOwn(ns, binding.name)) return { ok: false, value: undefined, why: `内置模块 ${binding.spec} 里没有 ${binding.name}` };
      const raw = ns[binding.name];
      if (isPureCall(raw)) return { ok: false, value: undefined, why: `${binding.name} 是函数,只认以字面量为参数的调用` };
      const value = toPlain(raw);
      if (value === undefined) return { ok: false, value: undefined, why: `内置模块 ${binding.spec} 的 ${binding.name} 不是纯数据` };
      return { ok: true, value };
    },
  };
  return ctx;
}

/* ------------------------------------------------------------------ 控件 */

const CONTROL_TYPES = new Set(["text", "number", "select", "color", "asset"]);
const ASSET_KINDS = new Set(["lottie", "particles"]);

/**
 * `options` 表 → `[{ value, label }]`。认:`{ value: 字符串, label: 字符串 }`;缺 `label` 的用 `value` 当标签;
 * 纯字符串数组(每项既当值也当标签);`{ 值: 标签 }` 形式的对象。有一项认不出就整个不认,回 null。
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

/** 从 URL 推 `asset` 的 kind:素材目录的地址形如 `/catalog/<kind>/<名>.json` */
function kindOfUrl(u) {
  if (typeof u !== "string") return null;
  const m = /(?:^|\/)catalog\/(lottie|particles)\//.exec(u);
  return m ? m[1] : null;
}

/**
 * 一个控件对象(已经求值、可能缺了认不出的字段)→ `{ control }` 或 `{ reason }`(画不出来的原因,面板说明用)。
 * `dropped`:这个对象里写了、但值不是字面量的键;`defaultValue`:这张卡 `defaults` 里这个键的值(推断 `asset` 的 kind 用)。
 * 能推断的补上(见文件头),推断不了的给原因。
 */
export function controlFix(v, { dropped = [], defaultValue } = {}) {
  if (!isPlainObject(v)) return { reason: "不是字面量" };
  const miss = (f, what) => (dropped.includes(f) ? `${what}不是字面量` : `缺${what}`);
  const { key, type, label } = v;
  if (typeof key !== "string" || !key) return { reason: miss("key", " key") };
  if (typeof label !== "string") return { reason: miss("label", " label") };
  if (typeof type !== "string") return { reason: miss("type", " type") };
  if (!CONTROL_TYPES.has(type)) return { reason: `type 不认识(${type})` };
  const c = { key, label, type };
  if (typeof v.required === "boolean") c.required = v.required;
  if (typeof v.hint === "string") c.hint = v.hint;
  if (type === "number") {
    for (const f of ["min", "max", "step"]) if (typeof v[f] === "number" && Number.isFinite(v[f])) c[f] = v[f];
  }
  if (type === "select") {
    if (v.options === undefined) return { reason: `下拉${miss("options", "选项(options)")}` };
    const options = optionsOf(v.options);
    if (!options) return { reason: "下拉选项(options)的写法认不出" };
    c.options = options;
  }
  if (type === "asset") {
    const options = v.options === undefined ? [] : optionsOf(v.options) ?? [];
    let kind = v.kind;
    if (kind === undefined) {
      // 推断:选项的地址、默认值的地址都指向同一种素材目录
      const kinds = new Set([...options.map((o) => kindOfUrl(o.value)), kindOfUrl(defaultValue)].filter(Boolean));
      if (kinds.size === 1) kind = [...kinds][0];
      else return { reason: `素材控件${miss("kind", "类别(kind)")},也推断不了是 lottie 还是 particles` };
    }
    if (!ASSET_KINDS.has(kind)) return { reason: `素材类别(kind)不认识(${String(kind)})` };
    c.kind = kind;
    c.options = options;
  }
  return { control: c };
}

/** 一个控件对象(已经求值、可能缺了认不出的字段)→ `Control`;画不出来的回 null(见文件头) */
export function controlOf(v) {
  return controlFix(v).control ?? null;
}

/** 被跳过的控件:认得出的 key / label / type 与原因 */
function skippedOf(it, reason) {
  const v = isPlainObject(it.value) ? it.value : {};
  return {
    ...(typeof v.key === "string" ? { key: v.key } : {}),
    ...(typeof v.label === "string" ? { label: v.label } : {}),
    ...(typeof v.type === "string" ? { type: v.type } : {}),
    reason,
  };
}

/** 卡片对象上的 `defaults` / `controls` / `description` */
function literalFields(mod, props) {
  const ev = mod.ev;
  /** 属性值的求值结果;简写属性按同名常量或导入 */
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
    // `items` 里逐个留着每个元素(对象即使有认不出的字段,也留着认得出的那部分)
    const items = r.items ?? r.value.map((v) => ({ ok: true, value: v }));
    for (const it of items) {
      if (!isPlainObject(it.value)) {
        out.controlsIncomplete = true;
        const what = it.spread ? `展开的 ${it.name ?? "表达式"}` : it.name;
        out.skippedControls.push(skippedOf(it, what ? `${what} 取不到:${it.why ?? "不是字面量"}` : "不是字面量"));
        continue;
      }
      const key = typeof it.value.key === "string" ? it.value.key : undefined;
      const fix = controlFix(it.value, { dropped: it.dropped ?? [], defaultValue: key !== undefined ? out.defaults[key] : undefined });
      if (fix.control) out.controls.push(fix.control);
      else { out.controlsIncomplete = true; out.skippedControls.push(skippedOf(it, fix.reason)); }
    }
    if (!r.ok && !out.controlsIncomplete) { out.controlsIncomplete = true; out.skippedControls.push({ reason: "控件表里有写法认不出" }); }
  } else {
    out.controlsIncomplete = true;
    const slice = props.get("controls");
    const name = slice === null ? "controls" : slice?.length === 1 && slice[0].t === "word" ? slice[0].v : null;
    const why = name ? ev.whys.get(name) : null;
    out.skippedControls.push({ reason: why ? `整个控件表 ${name} 取不到:${why}` : "整个控件表(controls)不是字面量" });
  }
  const desc = valueOf("description");
  if (desc && desc.ok && typeof desc.value === "string") out.description = desc.value;
  return out;
}

/**
 * 一份卡片源码里定义的卡:`[{ id, name, description?, defaults, controls, controlsIncomplete, skippedControls }]`,按源码里的先后;
 * 同一个 id 只留第一张。认不出任何卡回空数组,不抛。
 *
 * `opts`(都可省;省了就只看同一文件):
 *   - `key`:这份源码的仓库相对路径(`src/cards/user/x.tsx`),相对导入按它解析;
 *   - `files(key)`:别的文件的源码(内容库里同步来的 `card-source`),没有回 null / undefined;
 *   - `builtins(key)`:页面自己带着的内置模块的导出(`{ 名字: 值 }`,值是纯数据,或 `pureCall` 登记的纯函数),没有回 null / undefined。
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
  /** id / name:字面量或同文件字符串常量;都不是时按求值器(引进来的字符串常量) */
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
    try { fields = literalFields(mod, props); } catch { fields = { defaults: {}, controls: [], controlsIncomplete: true, skippedControls: [{ reason: "解析出错" }] }; }
    const { description, defaults, controls, controlsIncomplete, skippedControls } = fields;
    out.push({ id, name, ...(props.has("audio") && (props.has("Component") || props.has("card")) ? { embeddedAudio: true } : {}), ...(description !== undefined ? { description } : {}), defaults, controls, controlsIncomplete, skippedControls });
  }
  return out;
}

/** 内容库里的卡片源码键是不是一张用户卡的入口文件(同 `src/cards/user/index.ts` 的 glob `./*.tsx`) */
export function isUserCardEntryKey(key) {
  return typeof key === "string" && /^src\/cards\/user\/[^/]+\.tsx$/.test(key);
}
