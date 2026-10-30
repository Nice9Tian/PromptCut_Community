/**
 * 载入用户卡时，给「该锁的卡」的源码末尾接上一句「把顶层锁成只读」的调用（remotion 式的框架，三道只读里的第二道；
 * 运行时那一半在 `../../kernel/remotionStyle/lock.ts`）。
 *
 * 两处载入用户卡的地方都用这一份，接法相同：
 *   - 桌面、渲染节点、预渲染进程：开发服务器的转换钩子（`server/vite-plugin-cards.ts` 的 `cardOverridesLoader`）；
 *   - 在线页面：转译那一步（`./transpile.ts` 的 `transpileCardFile`）。
 * 接在源码**末尾**，前面一个字符都不动，所以报错的行号、源码身份都不变。
 *
 * 哪些卡该锁（`remotionLockPlan` 回非 null）：源码里声明了 `frameMode: "direct"`，**并且**引用了框架
 * （`src/kernel/remotionStyle`）。后一条是为了不碰老卡：框架出现之前建的卡不可能引用它，照旧载入、照旧运行。
 *
 * 只读文本、不执行。词法用 Sucrase 的公开接口 `getFormattedTokens`（同 `./precheck.ts`）：注释、字符串、JSX 文本里
 * 出现的字样不算。任何一步认不出来就回 null（不锁），不让这一步把一张卡弄得载入不了。
 */
import { getFormattedTokens } from "sucrase";

/** 框架的目录（仓库相对路径） */
export const REMOTION_FRAMEWORK_DIR = "src/kernel/remotionStyle";
/** 运行时那一半（仓库相对路径，不带扩展名） */
export const REMOTION_LOCK_MODULE = `${REMOTION_FRAMEWORK_DIR}/lock`;
/**
 * 该锁的卡在在线页面的转译缓存里用的键的后缀（`transpile.ts`）。接上去的那一段的写法变了就改它，
 * 旧的转译结果不再命中。只影响该锁的卡，别的卡的缓存键不变。
 */
export const REMOTION_LOCK_CACHE_TAG = "+lock1";

/** 一个导入的说明符指的是不是框架（`../../kernel/remotionStyle`、带 `/index`、带扩展名都算） */
export function isFrameworkSpecifier(spec) {
  return typeof spec === "string" && /(^|\/)kernel\/remotionStyle(\/index)?(\.ts)?$/.test(spec);
}

const QUICK_DIRECT = /\bframeMode\b[\s\S]{0,40}?direct/;
const QUICK_FRAMEWORK = /kernel\/remotionStyle/;

/* Sucrase 的 identifierRole（`sucrase/dist/parser/tokenizer` 的 IdentifierRole，版本钉死在 package.json） */
const ROLE_ACCESS = new Set(["0", "1", "8"]); // Access、ExportAccess、ObjectShorthand
const ROLE_TOP_LEVEL = new Set(["2", "5"]); // TopLevelDeclaration、ObjectShorthandTopLevelDeclaration
const ROLE_IMPORT = "9"; // ImportDeclaration

/**
 * 词法结果 → 记号表。`getFormattedTokens` 给的是一张对齐的文本表，名字和字符串在表里会被截短，
 * 所以每个记号的原文按它的位置（行:列）回到源码里取。
 */
function tokensOf(source) {
  const text = getFormattedTokens(source, { transforms: ["typescript", "jsx"] });
  const rows = text.split("\n");
  const head = rows[0] ?? "";
  const at = (name) => head.indexOf(name);
  const cLabel = at("Label"), cRaw = at("Raw"), cDepth = at("scopeDepth"), cType = at("isType"), cRole = at("identifierRole"), cJsx = at("jsxRole");
  if (cLabel < 0 || cRaw < 0 || cDepth < 0 || cType < 0 || cRole < 0 || cJsx < 0) throw new Error("词法结果的表头变了");
  // 行首的偏移：与 Sucrase 用的 lines-and-columns 同一种数法（\n、\r\n、单独的 \r 各算一次换行）
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
/** 能当模块载入的说明符：包名，或不带查询、扩展名是脚本的相对路径（样式、图片、`?raw` 不算） */
const isModuleSpecifier = (spec) => !/[?#\\]/.test(spec) && (!/\.[A-Za-z0-9]+$/.test(spec.split("/").pop() ?? "") || /\.(tsx?|mjs|js)$/.test(spec));

/**
 * 这份源码该不该锁、要锁哪些名字。
 * @param {string} source
 * @returns {{ names: string[], specifiers: string[] } | null}
 *   names：文件顶层有值的名字（const、function 等；类型不算）；
 *   specifiers：这份源码真的会载入的模块（它们的导出不是这张卡的，锁的时候跳过）。
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

  /** 每条 import：说明符、它带进来的名字 */
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

  /** 当值用到过的名字（类型位置的不算；JSX 标签名也算用到） */
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
    // 只带类型的导入转译时整条去掉：它不会被载入，这里也不替它载入
    const loaded = imp.sideEffectOnly || imp.bindings.some((b) => used.has(b));
    if (loaded && isModuleSpecifier(imp.spec) && !specifiers.includes(imp.spec)) specifiers.push(imp.spec);
  }
  return { names, specifiers };
}

/** `fromKey`（仓库相对路径，`src/` 开头）所在目录到运行时那一半的相对说明符 */
function lockSpecifier(fromKey) {
  const dirs = String(fromKey).replace(/\\/g, "/").split("/").slice(0, -1);
  if (dirs[0] !== "src") return null;
  return `${"../".repeat(dirs.length - 1) || "./"}${REMOTION_LOCK_MODULE.slice("src/".length)}`;
}

/**
 * 要接在这份源码末尾的那一段；不该锁（或认不出来）回空串。
 * @param {string} key    这个文件的仓库相对路径（`src/cards/user/x.tsx`）
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
    "/* 载入时把顶层锁成只读（remotion 式的框架；这一段是载入时接上的，不在卡片源码里） */",
    `import { lockTopLevel as __pcLockTopLevel } from ${JSON.stringify(lock)};`,
    ...plan.specifiers.map((spec, i) => `import * as __pcForeign${i} from ${JSON.stringify(spec)};`),
    `__pcLockTopLevel(${JSON.stringify(file)}, [${plan.names.map((n) => `[${JSON.stringify(n)}, () => ${n}]`).join(", ")}], [${plan.specifiers.map((_, i) => `__pcForeign${i}`).join(", ")}]);`,
    "",
  ];
  return lines.join("\n");
}
