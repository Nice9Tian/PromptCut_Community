/**
 * When loading a user card, appends a call to "lock top level as read-only" to the end of the source
 * code of "cards that should be locked" (remotion-style framework, the second of three read-only
 * layers; the runtime half is in `../../kernel/remotionStyle/lock.ts`).
 *
 * Both places that load user cards use this logic, with the same appending approach:
 *   - Desktop, render node, prerender process: dev server transform hook (`cardOverridesLoader` in
 *     `server/vite-plugin-cards.ts`);
 *   - Online page: the transpilation step (`transpileCardFile` in `./transpile.ts`).
 * Appended to the **end** of the source code without touching a single character before it, so error
 * line numbers and source identity remain unchanged.
 *
 * Which cards should be locked (`remotionLockPlan` returns non-null): source code declares
 * `frameMode: "direct"`, **and** references the framework (`src/kernel/remotionStyle`). The latter
 * condition avoids touching legacy cards: cards created before the framework existed cannot
 * reference it, so they load and run as before.
 *
 * Only reads text, does not execute. Tokenization uses Sucrase's public `getFormattedTokens` API
 * (same as `./precheck.ts`): text appearing in comments, strings, or JSX text does not count.
 * If any step cannot be recognized, returns null (do not lock), preventing this step from making
 * a card fail to load.
 */
import { getFormattedTokens } from "sucrase";

/** Framework directory (repository-relative path) */
export const REMOTION_FRAMEWORK_DIR = "src/kernel/remotionStyle";
/** Runtime counterpart (repository-relative path, without extension) */
export const REMOTION_LOCK_MODULE = `${REMOTION_FRAMEWORK_DIR}/lock`;
/**
 * Key suffix used in the online page transpilation cache for cards that should be locked
 * (`transpile.ts`). Change it if the syntax of the appended snippet changes so old transpilation
 * results no longer hit. Only affects cards that should be locked; cache keys for other cards
 * remain unchanged.
 */
export const REMOTION_LOCK_CACHE_TAG = "+lock1";

/** Whether an import specifier refers to the framework (including `../../kernel/remotionStyle`, with `/index`, or with extensions) */
export function isFrameworkSpecifier(spec) {
  return typeof spec === "string" && /(^|\/)kernel\/remotionStyle(\/index)?(\.ts)?$/.test(spec);
}

const QUICK_DIRECT = /\bframeMode\b[\s\S]{0,40}?direct/;
const QUICK_FRAMEWORK = /kernel\/remotionStyle/;

/* Sucrase identifierRole (IdentifierRole from `sucrase/dist/parser/tokenizer`, version pinned in package.json) */
const ROLE_ACCESS = new Set(["0", "1", "8"]); // Access, ExportAccess, ObjectShorthand
const ROLE_TOP_LEVEL = new Set(["2", "5"]); // TopLevelDeclaration, ObjectShorthandTopLevelDeclaration
const ROLE_IMPORT = "9"; // ImportDeclaration

/**
 * Tokenization result → token table. `getFormattedTokens` provides an aligned text table where
 * names and strings are truncated, so each token's original text is retrieved from the source code
 * by its position (line:column).
 */
function tokensOf(source) {
  const text = getFormattedTokens(source, { transforms: ["typescript", "jsx"] });
  const rows = text.split("\n");
  const head = rows[0] ?? "";
  const at = (name) => head.indexOf(name);
  const cLabel = at("Label"), cRaw = at("Raw"), cDepth = at("scopeDepth"), cType = at("isType"), cRole = at("identifierRole"), cJsx = at("jsxRole");
  if (cLabel < 0 || cRaw < 0 || cDepth < 0 || cType < 0 || cRole < 0 || cJsx < 0) throw new Error("The lexer result header changed");
  // Line-start offset: same counting method as lines-and-columns used by Sucrase (\n, \r\n,
  // and standalone \r each count as one line break)
  const lineStart = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\r" && source[i + 1] === "\n") i++;
    if (source[i] === "\n" || source[i] === "\r") lineStart.push(i + 1);
  }
  const offset = (line, col) => lineStart[line - 1] + col - 1;
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const loc = /^(\d+):(\d+)-(\d+):(\d+)/.exec(row);
    if (!loc) continue;
    const start = offset(Number(loc[1]), Number(loc[2])), end = offset(Number(loc[3]), Number(loc[4]));
    out.push({
      label: row.slice(cLabel, cRaw).trim(),
      text: source.slice(start, end),
      depth: Number(row.slice(cDepth, cType).trim() || 0),
      isType: row.slice(cType, cRole).trim() === "isType",
      role: row.slice(cRole, cJsx).trim(),
    });
  }
  return out;
}

const IDENT_OK = new RegExp(`^[\\p{ID_Start}$_][\\p{ID_Continue}$${String.fromCharCode(0x200c, 0x200d)}]*$`, "u");
const unquote = (raw) => (/^(['"]).*\1$/s.test(raw) ? raw.slice(1, -1) : null);
/** Specifiers loadable as modules: package name, or relative script path without query (styles, images, `?raw` do not count) */
const isModuleSpecifier = (spec) => !/[?#\\]/.test(spec) && (!/\.[A-Za-z0-9]+$/.test(spec.split("/").pop() ?? "") || /\.(tsx?|mjs|js)$/.test(spec));

/**
 * Whether this source code should be locked and which names to lock.
 * @param {string} source
 * @returns {{ names: string[], specifiers: string[] } | null}
 *   names: names with values at the file's top level (const, function, etc.; types do not count);
 *   specifiers: modules that this source code actually loads (their exports do not belong to this
 *     card, skip when locking).
 */
export function remotionLockPlan(source) {
  if (typeof source !== "string" || !QUICK_DIRECT.test(source) || !QUICK_FRAMEWORK.test(source)) return null;
  let toks;
  try { toks = tokensOf(source); } catch { return null; }

  let direct = false;
  for (let i = 0; i + 2 < toks.length; i++) {
    if (toks[i].text === "frameMode" && !toks[i].isType && toks[i + 1].label === ":" && toks[i + 2].label === "string" && unquote(toks[i + 2].text) === "direct") { direct = true; break; }
  }
  if (!direct) return null;

  /** Each import: specifier, names it brings in */
  const imports = [];
  let framework = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.depth !== 0 || t.label !== "import" || toks[i + 1]?.label === "(" || toks[i + 1]?.label === ".") continue;
    const bindings = [];
    let spec = null;
    let j = i + 1;
    for (; j < toks.length && j < i + 2000; j++) {
      const n = toks[j];
      if (n.label === "string") { spec = unquote(n.text); break; }
      if (n.label === ";" || n.label === "eof") break;
      if (n.label === "name" && n.role === ROLE_IMPORT && !n.isType) bindings.push(n.text);
    }
    if (spec === null) continue;
    if (isFrameworkSpecifier(spec)) framework = true;
    imports.push({ spec, bindings, sideEffectOnly: j === i + 1 });
    i = j;
  }
  if (!framework) return null;

  /** Names used as values (type positions do not count; JSX tag names also count as used) */
  const used = new Set();
  for (const t of toks) {
    if (t.isType) continue;
    if ((t.label === "name" && ROLE_ACCESS.has(t.role)) || t.label === "jsxName") used.add(t.text);
  }

  const names = [];
  for (const t of toks) {
    if (t.depth !== 0 || t.isType || t.label !== "name" || !ROLE_TOP_LEVEL.has(t.role)) continue;
    if (IDENT_OK.test(t.text) && !t.text.startsWith("__pc") && !names.includes(t.text)) names.push(t.text);
  }

  const specifiers = [];
  for (const imp of imports) {
    // Type-only imports are stripped entirely during transpilation: they will not be loaded, and we do not load them here either
    const loaded = imp.sideEffectOnly || imp.bindings.some((b) => used.has(b));
    if (loaded && isModuleSpecifier(imp.spec) && !specifiers.includes(imp.spec)) specifiers.push(imp.spec);
  }
  return { names, specifiers };
}

/** Relative specifier from the directory of `fromKey` (repo-relative path, starting with `src/`) to the runtime half */
function lockSpecifier(fromKey) {
  const dirs = String(fromKey).replace(/\\/g, "/").split("/").slice(0, -1);
  if (dirs[0] !== "src") return null;
  return `${"../".repeat(dirs.length - 1) || "./"}${REMOTION_LOCK_MODULE.slice("src/".length)}`;
}

/**
 * The snippet to append to the end of this source code; returns an empty string if it should not
 * be locked (or cannot be recognized).
 * @param {string} key    Repo-relative path of this file (`src/cards/user/x.tsx`)
 * @param {string} source
 */
export function remotionLockSuffix(key, source) {
  const plan = remotionLockPlan(source);
  if (!plan || plan.names.length === 0) return "";
  const lock = lockSpecifier(key);
  if (!lock) return "";
  const file = String(key).replace(/\\/g, "/");
  const lines = [
    "",
    "/* Lock the top level to read-only at load time (remotion-style framework; this part is attached at load time, not in the card source) */",
    `import { lockTopLevel as __pcLockTopLevel } from ${JSON.stringify(lock)};`,
    ...plan.specifiers.map((spec, i) => `import * as __pcForeign${i} from ${JSON.stringify(spec)};`),
    `__pcLockTopLevel(${JSON.stringify(file)}, [${plan.names.map((n) => `[${JSON.stringify(n)}, () => ${n}]`).join(", ")}], [${plan.specifiers.map((_, i) => `__pcForeign${i}`).join(", ")}]);`,
    "",
  ];
  return lines.join("\n");
}
