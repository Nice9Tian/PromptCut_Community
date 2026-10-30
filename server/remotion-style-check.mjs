/**
 * remotion 式的卡的建卡检查（`docs/plan/render-standard.md`「remotion 式的规矩」；框架在 `src/kernel/remotionStyle/`）。
 *
 * 一张卡声明成 remotion 式（`frameMode: "direct"`），就是在说：这一帧的画面只由时间 t、参数和输入素材决定。
 * 这里只看源码、不执行，把不合这句话的写法逐条指出来，每条带行号。建卡、改卡时由
 * `server/vite-plugin-cards.ts` 的 `checkCardSource` / `checkSourceEdit` 调；桌面建卡与云端 Agent 建卡走的是同一个函数。
 * 装卡（打开项目、内容库同步）不调它：已经在库里的卡照旧载入。
 *
 * 规则（`rule` 一栏是代号，测试夹具按它一条一张违规样例）：
 *
 * | rule | 规矩 | 认什么 |
 * |---|---|---|
 * | `import` | 只许引用框架和基础库 | 名单之外的导入；动态 `import()`、`require()` |
 * | `real-time` | 不读真实时间 | `Date.now()`、不带参数的 `new Date()` / `Date()`、`performance` |
 * | `timer` | 不用定时器 | `setTimeout`、`setInterval`、`setImmediate`、`requestIdleCallback` |
 * | `frame-callback` | 不用浏览器的逐帧回调 | `requestAnimationFrame`、`cancelAnimationFrame`、`setAnimationLoop`、`requestVideoFrameCallback` |
 * | `motion` | 不用 Motion 的动画与弹簧 | 引用 `motion` / `motion/react`；`<motion.x>`；`whileHover` 这类属性 |
 * | `presence` | 不用进出场组件 | `<AnimatePresence>` |
 * | `css-animation` | 不用 CSS 动画与过渡 | 样式里的 `animation*` / `transition*`；样式文本里的 `@keyframes`、`animation:`、`transition:`；类名 `animate-*`、`transition*`；元素的 `.animate()`；SVG 的 `<animate>` |
 * | `random` | 不用不带种子的随机 | `Math.random`、`crypto` |
 * | `state` | 不把东西带到下一帧 | `useState` 等记状态的 hook；`useRef(初值)`、往 `.current` 里写；往文件顶层的名字或导入的东西里写；`window`、`globalThis`、本地存储；`eval`、`Function()` |
 * | `top-level` | 文件顶层只许写常量 | 顶层的 `let` / `var` / `class` / `enum`、直接执行的语句；顶层初始化式里的 `new`、`await`、赋值 |
 * | `viewport` | 卡片挂载即播放 | `IntersectionObserver`（所有卡原来就不许，这里只是带上行号） |
 * | `frame-mode` | 写法以声明为准 | `frameMode` 写成了读不出字面量的东西 |
 * | `framework` | 必须引用框架 | 声明成 remotion 式，却没有一句会留到运行时的框架导入（只带类型的导入不算）。用不到工具的卡（只用 `t` 做算术、只用 GLSL 的素材效果卡、只有声音的卡）写一行裸导入 `import "../../kernel/remotionStyle";` |
 *
 * 看源码查不出来的那一类（依赖「谁先加载好」：字体、图片先画一版再变）不在这里，见报告与 `server/bakery/frame-ready.mjs`。
 *
 * 为什么必须引用框架：载入时只给「声明成 remotion 式、并且引用了框架」的卡把文件顶层锁成只读
 * （`src/online/cardRuntime/remotionLock.mjs`）。不引用框架的卡不上锁，绕一道变量往自己顶层的对象里写就查不出来。
 * 让「该不该锁」和「合不合法」用同一个判据，不另加记号（`docs/plan/html-snapshot-removal-dryrun.md` 第 8.2 节）。
 *
 * 新建卡（没有改之前的版本）与引用了框架的卡：每一条都拒绝。改一张框架出现之前建的、没引用框架的卡：只拒绝这次编辑
 * **新增**的违规（按规则数个数），原来就有的不追究——和 `compositing: 'independent'` 的差量口径一样；
 * `Date.now()`、`setTimeout` / `setInterval`、`IntersectionObserver` 三样原来对所有卡就是出现即拒，照旧。
 */
import ts from 'typescript';

/** 框架的仓库相对路径（不带扩展名） */
export const REMOTION_FRAMEWORK = 'src/kernel/remotionStyle';

/**
 * remotion 式的卡可以引用的模块。包名原样；内置模块是仓库相对路径（不带扩展名）。
 * 只带类型的导入（`import type …`）不在此限：它转译后不留痕迹。
 */
export const REMOTION_IMPORT_ALLOW = Object.freeze([
  'react',                              // 组件与不记状态的 hook
  'react/jsx-runtime',
  REMOTION_FRAMEWORK,                   // 框架
  'src/kernel/types',                   // CardDef、CardProps
  'src/kernel/frameReady',              // 异步准备好之前挡住截图（beginFrameWork）
  'src/kernel/soundEffects',            // 声音配方（纯计算）
  'src/render/cards/graphValues',       // 素材效果卡的出口：glsl、draw、bitmap
  'src/cards/native/hud',               // 位置与主色的约定
  'src/cards/native/sound-effects',     // cardSoundBlock
  'src/cards/magicui/vendor/cn',        // 拼类名
]);

/** 报错里用的框架导入写法（用户卡在 `src/cards/user/` 下） */
const FRAMEWORK_IMPORT = '"../../kernel/remotionStyle"';

const STATE_HOOKS = new Set(['useState', 'useReducer', 'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'useOptimistic', 'useActionState']);
const GLOBAL_STORES = new Set(['window', 'globalThis', 'self', 'global', 'localStorage', 'sessionStorage', 'indexedDB']);
const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate', 'requestIdleCallback']);
const LEGACY_TIMERS = new Set(['setTimeout', 'setInterval']);
const FRAME_CALLBACKS = new Set(['requestAnimationFrame', 'cancelAnimationFrame', 'requestVideoFrameCallback']);
const FRAME_CALLBACK_MEMBERS = new Set(['setAnimationLoop', 'requestVideoFrameCallback']);
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);
const OBJECT_WRITERS = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']);
const SMIL_TAGS = new Set(['animate', 'animateTransform', 'animateMotion']);
const MOTION_PROPS = /^while(Hover|Tap|Drag|Focus|InView)$/;
const CLASS_HELPERS = new Set(['cn', 'clsx', 'classNames', 'classnames', 'twMerge']);

const STYLE_KEY = /^(?:-?(?:webkit|moz|ms|o)-?)?(animation|transition)(?:$|[A-Z-])/i;
const CSS_TEXT = /@keyframes\b|(?:^|[;{\s])(?:-webkit-)?(animation|transition)(?:-[a-z-]+)?\s*:/i;
const CLASS_ANIMATE = /(?:^|[\s:])animate-[a-z0-9[]/;
const CLASS_TRANSITION = /(?:^|[\s:])transition(?:-[a-z]+)?(?=$|\s)/;
const STYLE_OFF = new Set(['none', 'unset', 'initial', '']);

/** `spec` 相对 `fileName` 所在目录算出的仓库相对路径（不带扩展名、不带 `/index`）；包名原样；爬出仓库根回 null */
function normalizeSpecifier(fileName, spec) {
  if (!(spec.startsWith('./') || spec.startsWith('../'))) return spec;
  const parts = String(fileName).replace(/\\/g, '/').split('/').slice(0, -1);
  for (const p of spec.split(/[?#]/)[0].split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.join('/').replace(/\.(tsx?|mjs|js)$/, '').replace(/\/index$/, '');
}

const unwrap = (node) => {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n))) n = n.expression;
  return n;
};
const stringOf = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
const nameOf = (node) => (node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
const isFunctionLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
  || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);
const ASSIGN_FIRST = ts.SyntaxKind.FirstAssignment, ASSIGN_LAST = ts.SyntaxKind.LastAssignment;
const isAssignment = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind >= ASSIGN_FIRST && n.operatorToken.kind <= ASSIGN_LAST;
const isUpdate = (n) => (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
  && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken);

/** 绑定模式里声明的名字 */
function bindingNames(name, out) {
  if (!name) return;
  if (ts.isIdentifier(name)) { out.add(name.text); return; }
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/** 一个函数里声明的名字（参数、函数体里各层的变量与函数；不进更里面的函数体，只收它的名字） */
function localNames(fn) {
  const out = new Set();
  for (const p of fn.parameters ?? []) bindingNames(p.name, out);
  if (fn.name && ts.isIdentifier(fn.name) && (ts.isFunctionExpression(fn))) out.add(fn.name.text);
  const walk = (node) => {
    if (ts.isVariableDeclaration(node)) bindingNames(node.name, out);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) out.add(node.name.text);
    else if (ts.isCatchClause(node) && node.variableDeclaration) bindingNames(node.variableDeclaration.name, out);
    if (isFunctionLike(node) && node !== fn) return;
    ts.forEachChild(node, walk);
  };
  if (fn.body) walk(fn.body);
  return out;
}

/**
 * 逐条查一份源码。
 * @param {string} source
 * @param {{ fileName?: string }} [o] fileName：这个文件的仓库相对路径（解析相对导入用），缺省当它是 `src/cards/user/` 下的一张卡
 * @returns {{
 *   declared: 'direct' | 'other' | 'none',   // 声明的写法：remotion 式 / 别的 / 没写
 *   usesFramework: boolean,                  // 引用了框架
 *   violations: { rule: string, line: number, message: string, legacy?: boolean }[],
 * }}
 * 没声明成 remotion 式的卡，`violations` 里最多只有 `frame-mode` 一条（`frameMode` 读不出字面量）。
 */
export function inspectRemotionStyle(source, o = {}) {
  const fileName = o.fileName ?? 'src/cards/user/card.tsx';
  const sf = ts.createSourceFile(fileName, String(source ?? ''), ts.ScriptTarget.Latest, true, /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const violations = [];
  const seen = new Set();
  const hit = (node, rule, message, extra) => {
    const line = lineOf(node);
    const key = `${rule}\n${line}\n${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ rule, line, message, ...extra });
  };

  /* ---------- 顶层的名字 ---------- */
  /** 名字 → 种类（import / const / let / var / function / class / enum） */
  const top = new Map();
  /** 导入进来的名字 → 说明符 */
  const importedFrom = new Map();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = stringOf(st.moduleSpecifier) ?? '';
      const clause = st.importClause;
      if (!clause) continue;
      const add = (id) => { top.set(id.text, 'import'); importedFrom.set(id.text, spec); };
      if (clause.name) add(clause.name);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) add(clause.namedBindings.name);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) add(el.name);
    } else if (ts.isVariableStatement(st)) {
      const kind = st.declarationList.flags & ts.NodeFlags.Const ? 'const' : st.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
      const names = new Set();
      for (const d of st.declarationList.declarations) bindingNames(d.name, names);
      for (const n of names) top.set(n, kind);
    } else if (ts.isFunctionDeclaration(st) && st.name) top.set(st.name.text, 'function');
    else if (ts.isClassDeclaration(st) && st.name) top.set(st.name.text, 'class');
    else if (ts.isEnumDeclaration(st)) top.set(st.name.text, 'enum');
  }

  /* ---------- 声明的写法 ---------- */
  const topConstString = (name) => {
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return stringOf(unwrap(d.initializer));
    }
    return null;
  };
  let declared = 'none';
  /** 写着 `frameMode: "direct"` 的那一处（`framework` 这条规则的报错指到它） */
  let directNode = null;
  const unreadable = [];
  const noteMode = (node, init) => {
    const e = unwrap(init);
    const value = stringOf(e) ?? (e && ts.isIdentifier(e) ? topConstString(e.text) : null);
    if (value === null) { unreadable.push(node); if (declared === 'none') declared = 'other'; return; }
    if (value === 'direct') { declared = 'direct'; directNode ??= node; }
    else if (declared === 'none') declared = 'other';
  };
  const findMode = (node) => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isPropertyAssignment(node) && nameOf(node.name) === 'frameMode') noteMode(node, node.initializer);
    else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'frameMode') noteMode(node, node.name);
    ts.forEachChild(node, findMode);
  };
  findMode(sf);
  for (const node of unreadable) {
    hit(node, 'frame-mode', 'frameMode 要直接写成字面量："direct"（remotion 式）或 "stateful"（motion 式）。写成变量或算出来的值，建卡时读不出这张卡是哪种写法');
  }

  /** usesFramework：有一句指向框架的导入（含只带类型的）；loadsFramework：其中有会留到运行时的（裸导入、带值的导入） */
  let usesFramework = false, loadsFramework = false;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || normalizeSpecifier(fileName, stringOf(st.moduleSpecifier) ?? '') !== REMOTION_FRAMEWORK) continue;
    usesFramework = true;
    const clause = st.importClause;
    const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      && clause.namedBindings.elements.every((el) => el.isTypeOnly)));
    if (!typeOnly) loadsFramework = true;
  }
  if (declared !== 'direct') return { declared, usesFramework, violations };

  /* ---------- 必须引用框架 ---------- */
  if (!loadsFramework) {
    hit(directNode ?? sf, 'framework', `这张卡声明的是 remotion 式，但没有引用框架。在文件开头加一行 \`import ${FRAMEWORK_IMPORT};\`；用到工具时写成 \`import { tween } from ${FRAMEWORK_IMPORT};\`。引用以后，这张卡载入时文件顶层的对象会被锁成只读`);
  }

  /* ---------- 导入 ---------- */
  const checkSpecifier = (node, spec, typeOnly) => {
    if (typeOnly) return;
    if (spec === 'motion' || spec.startsWith('motion/')) {
      hit(node, 'motion', `引用了 ${spec}：Motion 的动画、弹簧按真实时间自己往前走，跳到某一帧时算不出那一帧的画面。过渡、弹簧、错开进场用框架 ${FRAMEWORK_IMPORT} 里的 tween、spring、stagger，它们由 t 直接算`);
      return;
    }
    const at = normalizeSpecifier(fileName, spec);
    if (at !== null && REMOTION_IMPORT_ALLOW.includes(at)) return;
    hit(node, 'import', `引用了 ${spec.slice(0, 80)}：remotion 式的卡只许引用框架 ${FRAMEWORK_IMPORT}、react、"../../kernel/types"、"../../kernel/frameReady"、"../../kernel/soundEffects"、"../../render/cards/graphValues"、"../native/hud"、"../native/sound-effects"、"../magicui/vendor/cn"`);
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = stringOf(st.moduleSpecifier);
      const clause = st.importClause;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((el) => el.isTypeOnly)));
      if (spec !== null) checkSpecifier(st, spec, typeOnly);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      const spec = stringOf(st.moduleSpecifier);
      if (spec !== null) checkSpecifier(st, spec, st.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(st)) {
      hit(st, 'import', '不许用 import x = require(…)：remotion 式的卡的导入只写成 import … from "…"');
    }
  }

  /* ---------- 文件顶层只许写常量 ---------- */
  const TOP_ONLY = '卡片文件顶层只许写 import、类型、函数和 const 常量';
  const checkInitializer = (init) => {
    const walk = (node) => {
      if (isFunctionLike(node)) return; // 函数体是调用时才跑的，由下面的逐条规则管
      if (ts.isNewExpression(node)) hit(node, 'top-level', '顶层用了 new：new 出来的东西（Map、Set、类的实例、定长数组）锁不成只读，会成为跨帧存东西的地方。要查表就写成对象或数组字面量；确实要用的放进函数里现算');
      else if (ts.isAwaitExpression(node)) hit(node, 'top-level', '顶层用了 await：卡片载入不能等异步的东西。异步准备放进组件里，用 beginFrameWork 挡住截图');
      else if (isAssignment(node) || isUpdate(node) || ts.isDeleteExpression(node)) hit(node, 'top-level', `顶层的初始化式里有赋值：${TOP_ONLY}`);
      else if (ts.isClassExpression(node)) hit(node, 'top-level', `顶层写了 class：${TOP_ONLY}`);
      ts.forEachChild(node, walk);
    };
    walk(init);
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st) || ts.isExportDeclaration(st) || ts.isInterfaceDeclaration(st)
      || ts.isTypeAliasDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isEmptyStatement(st)) continue;
    if (ts.isVariableStatement(st)) {
      if (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) continue;
      const flags = st.declarationList.flags;
      if (!(flags & ts.NodeFlags.Const)) {
        hit(st, 'top-level', `顶层写了 ${flags & ts.NodeFlags.Let ? 'let' : 'var'}：能改的顶层变量活得比一帧长，上一帧写进去的东西下一帧读得到。${TOP_ONLY}；随时间变的量在组件里由 t 算`);
      }
      for (const d of st.declarationList.declarations) if (d.initializer) checkInitializer(d.initializer);
      continue;
    }
    if (ts.isExportAssignment(st)) { checkInitializer(st.expression); continue; }
    if (ts.isClassDeclaration(st)) { hit(st, 'top-level', `顶层写了 class：类的静态字段和实例都是能改的东西。${TOP_ONLY}；组件写成函数`); continue; }
    if (ts.isEnumDeclaration(st)) { hit(st, 'top-level', `顶层写了 enum：${TOP_ONLY}；用联合类型或 const 对象`); continue; }
    if (ts.isExpressionStatement(st) && stringOf(st.expression) !== null) continue; // "use strict" 这类指令
    hit(st, 'top-level', `顶层有一条直接执行的语句：${TOP_ONLY}。载入时不许做事（注册、改全局、预先算一遍存起来）`);
  }

  /* ---------- 逐个节点 ---------- */
  /** 外层函数里声明过的名字（遮住同名的全局或顶层名字） */
  const scopes = [];
  const shadowed = (name) => scopes.some((s) => s.has(name));
  /** 这个标识符是不是在当值用（不是属性名、声明的名字、标签名） */
  const isValueUse = (id) => {
    const p = id.parent;
    if (!p) return false;
    if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
    if (ts.isQualifiedName(p)) return false;
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)
      || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return false;
    if (ts.isBindingElement(p) && (p.propertyName === id || p.name === id)) return false;
    if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p)
      || ts.isClassExpression(p)) && p.name === id) return false;
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
    if (ts.isJsxAttribute(p) && p.name === id) return false;
    if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
    return true;
  };
  const isGlobal = (id) => isValueUse(id) && !shadowed(id.text) && !top.has(id.text);
  /** 赋值目标一路剥到最里面的那个名字；不是名字打头的回 null */
  const rootOf = (expr) => {
    let n = unwrap(expr);
    while (n && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) n = unwrap(n.expression);
    return n && ts.isIdentifier(n) ? n : null;
  };
  /** 这个名字是不是文件顶层的（没被函数里的同名变量遮住） */
  const topKind = (id) => (id && !shadowed(id.text) ? top.get(id.text) ?? null : null);
  const describeTop = (id) => (top.get(id.text) === 'import' ? `导入进来的 ${id.text}` : `文件顶层的 ${id.text}`);
  const NO_CARRY = '这一帧的画面只许用 t、参数和输入素材算出来，不能读上一帧留下的东西';

  const checkWriteTarget = (node, target) => {
    const t = unwrap(target);
    if (t && ts.isPropertyAccessExpression(t) && t.name.text === 'current') {
      hit(node, 'state', `往 .current 里写：ref 里存的值活得比一帧长，这是在把东西带到下一帧。${NO_CARRY}；ref 只用来拿 DOM 节点`);
      return;
    }
    const root = rootOf(target);
    if (root && topKind(root)) hit(node, 'state', `往${describeTop(root)} 里写：它活得比一帧长，上一帧写进去的东西下一帧读得到。${NO_CARRY}`);
  };

  /** 字符串在不在「类名」的位置上（className 属性里、cn() 这类函数的参数里） */
  const inClassContext = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxAttribute(p)) return ['className', 'class'].includes(p.name.getText(sf));
      if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && CLASS_HELPERS.has(p.expression.text)) return true;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && /class/i.test(p.name.text)) return true;
      if (isFunctionLike(p) || ts.isSourceFile(p)) return false;
    }
    return false;
  };
  /** 对象字面量是不是一份样式（style 属性里、名字或类型带 style 的变量、Object.assign(x.style, …) 的参数） */
  const inStyleContext = (obj) => {
    for (let p = obj.parent; p; p = p.parent) {
      if (ts.isJsxAttribute(p)) return p.name.getText(sf) === 'style';
      if (ts.isVariableDeclaration(p)) return (ts.isIdentifier(p.name) && /style/i.test(p.name.text)) || /CSSProperties|CSSStyleDeclaration/.test(p.type?.getText(sf) ?? '');
      if (ts.isPropertyAssignment(p) && /^style$/i.test(nameOf(p.name) ?? '')) return true;
      if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === 'assign'
        && p.arguments[0] && /\.style$/.test(p.arguments[0].getText(sf))) return true;
      if (ts.isReturnStatement(p) || isFunctionLike(p) || ts.isSourceFile(p)) return false;
    }
    return false;
  };
  const CSS_HINT = `CSS 的动画和过渡跟着真实时间走，机器一卡就对不上帧。把随时间变的样式写成 t 的函数（框架 ${FRAMEWORK_IMPORT} 的 interpolate、tween、spring），直接写进 style`;

  const checkText = (node, text) => {
    if (CSS_TEXT.test(text)) hit(node, 'css-animation', `样式文本里有 CSS 动画或过渡（@keyframes / animation / transition）：${CSS_HINT}`);
    const animate = CLASS_ANIMATE.test(text);
    if (animate || (CLASS_TRANSITION.test(text) && inClassContext(node))) {
      hit(node, 'css-animation', `类名里有 ${animate ? 'animate-*' : 'transition'}：${CSS_HINT}`);
    }
  };

  const visit = (node) => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;

    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (isGlobal(node)) {
        if (name === 'performance') hit(node, 'real-time', `读了真实时间（performance）：导出和预渲染走的是舞台自己的帧时钟，真实时间每次都不一样。要时间就用组件收到的 t`);
        else if (TIMERS.has(name)) hit(node, 'timer', `用了定时器（${name}）：它按真实时间触发，不跟着帧走。「过一会儿再出现」写成 t 的条件：t >= 多少秒，或框架的 tween / stagger 的 delay`, LEGACY_TIMERS.has(name) ? { legacy: true } : undefined);
        else if (FRAME_CALLBACKS.has(name)) hit(node, 'frame-callback', `用了浏览器的逐帧回调（${name}）：它跟着屏幕刷新走，回调几次、隔多久都不确定。舞台每一帧会带着新的 t 重新渲染这张卡，画面写成 t 的函数就行`);
        else if (name === 'crypto') hit(node, 'random', `用了不带种子的随机（crypto）：每次拿到的数不一样。用框架 ${FRAMEWORK_IMPORT} 的 random(种子, 序号)`);
        else if (GLOBAL_STORES.has(name)) hit(node, 'state', `用了 ${name}：全局对象和本地存储活得比一帧长，是跨帧存东西的地方。${NO_CARRY}`);
        else if (name === 'eval') hit(node, 'state', '用了 eval：运行时拼出来的代码建卡时查不了');
        else if (name === 'IntersectionObserver') hit(node, 'viewport', '用了 IntersectionObserver：卡片挂载即播放，不存在「滚动进入视口」这回事', { legacy: true });
        else if (name === 'Function' && node.parent && (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node) {
          hit(node, 'state', '用了 Function(…)：运行时拼出来的代码建卡时查不了');
        }
      }
    }

    // Math.random、Date.now、x.setAnimationLoop、x.animate(…)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const obj = unwrap(node.expression);
      const member = ts.isPropertyAccessExpression(node) ? node.name.text : stringOf(node.argumentExpression);
      const globalObj = obj && ts.isIdentifier(obj) && isGlobal(obj) ? obj.text : null;
      if (globalObj === 'Math' && member === 'random') hit(node, 'random', `用了不带种子的随机（Math.random）：它每调一次往前走一步，第 N 帧拿到哪个数取决于前面调过几次，直接跳到第 N 帧就对不上。用框架 ${FRAMEWORK_IMPORT} 的 random(种子, 序号)，由种子和序号直接算`);
      if (globalObj === 'Date' && member === 'now') hit(node, 'real-time', '读了真实时间（Date.now()）：导出和预渲染走的是舞台自己的帧时钟，真实时间每次都不一样。要时间就用组件收到的 t', { legacy: true });
      if (member && FRAME_CALLBACK_MEMBERS.has(member)) hit(node, 'frame-callback', `用了自带的帧循环（${member}）：它跟着屏幕刷新走。画面写成 t 的函数，t 变了显式画一次`);
    }
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (callee && ts.isIdentifier(callee) && callee.text === 'Date' && isGlobal(callee) && (node.arguments?.length ?? 0) === 0) {
        hit(node, 'real-time', `读了真实时间（${ts.isNewExpression(node) ? 'new Date()' : 'Date()'}）：导出和预渲染走的是舞台自己的帧时钟，真实时间每次都不一样。要时间就用组件收到的 t`);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) hit(node, 'import', '用了动态 import()：remotion 式的卡的导入只写成文件开头的 import … from "…"');
      if (callee && ts.isIdentifier(callee) && callee.text === 'require' && isGlobal(callee)) hit(node, 'import', '用了 require()：remotion 式的卡的导入只写成文件开头的 import … from "…"');
      // 记状态的 hook
      const hook = callee && ts.isIdentifier(callee) ? callee.text : callee && ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const fromReact = callee && (ts.isIdentifier(callee) ? (!shadowed(callee.text) && (importedFrom.get(callee.text) === 'react' || !top.has(callee.text))) : true);
      if (hook && fromReact && STATE_HOOKS.has(hook)) {
        hit(node, 'state', `用了 ${hook}：它记的值活得比一帧长，画面就不再只由 t 和参数决定。${NO_CARRY}；随时间变的量由 t 直接算，要缓存只用 useMemo`);
      }
      if (hook === 'useRef' && fromReact && node.arguments.length > 0) {
        const init = unwrap(node.arguments[0]);
        const empty = init.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(init) && init.text === 'undefined');
        if (!empty) hit(node, 'state', `useRef 带了初值：ref 里存的值活得比一帧长，是跨帧存东西的地方。remotion 式的卡里 ref 只用来拿 DOM 节点，写成 useRef(null)。${NO_CARRY}`);
      }
      // 元素的 animate()
      if (callee && ts.isPropertyAccessExpression(callee) && callee.name.text === 'animate') {
        hit(node, 'css-animation', `调了 .animate(…)：元素的动画接口跟着真实时间走。${CSS_HINT}`);
      }
      // 往顶层的东西里写：X.push(…)、Object.assign(X, …)
      if (callee && ts.isPropertyAccessExpression(callee) && MUTATORS.has(callee.name.text)) {
        const root = rootOf(callee.expression);
        if (root && topKind(root)) hit(node, 'state', `往${describeTop(root)} 里写（${callee.name.text}）：它活得比一帧长，上一帧写进去的东西下一帧读得到。${NO_CARRY}`);
      }
      if (callee && ts.isPropertyAccessExpression(callee) && OBJECT_WRITERS.has(callee.name.text) && node.arguments[0]) {
        const holder = unwrap(callee.expression);
        const root = rootOf(node.arguments[0]);
        if (holder && ts.isIdentifier(holder) && ['Object', 'Reflect'].includes(holder.text) && root && topKind(root)) {
          hit(node, 'state', `往${describeTop(root)} 里写（${holder.text}.${callee.name.text}）：它活得比一帧长，上一帧写进去的东西下一帧读得到。${NO_CARRY}`);
        }
      }
    }

    // 赋值、自增自减、delete
    if (isAssignment(node)) checkWriteTarget(node, node.left);
    else if (isUpdate(node)) checkWriteTarget(node, node.operand);
    else if (ts.isDeleteExpression(node)) checkWriteTarget(node, node.expression);
    // el.style.transition = …
    if (isAssignment(node)) {
      const left = unwrap(node.left);
      if (left && ts.isPropertyAccessExpression(left) && STYLE_KEY.test(left.name.text) && /\.style$/.test(left.expression.getText(sf))
        && !STYLE_OFF.has(stringOf(unwrap(node.right)) ?? '?')) {
        hit(node, 'css-animation', `给样式写了 ${left.name.text}：${CSS_HINT}`);
      }
    }

    // 样式对象里的 animation* / transition*
    if (ts.isObjectLiteralExpression(node) && inStyleContext(node)) {
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
        const key = nameOf(prop.name);
        if (!key || !STYLE_KEY.test(key)) continue;
        if (ts.isPropertyAssignment(prop) && STYLE_OFF.has(stringOf(unwrap(prop.initializer)) ?? '?')) continue; // 明写「没有」的不算
        hit(prop, 'css-animation', `样式里写了 ${key}：${CSS_HINT}`);
      }
    }

    // 字符串：样式文本、类名
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent;
      const isSpecifier = p && (ts.isImportDeclaration(p) || ts.isExportDeclaration(p));
      const isKey = p && ts.isPropertyAssignment(p) && p.name === node;
      if (!isSpecifier && !isKey) checkText(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      checkText(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '));
    } else if (ts.isJsxText(node)) {
      if (CSS_TEXT.test(node.text)) hit(node, 'css-animation', `样式文本里有 CSS 动画或过渡（@keyframes / animation / transition）：${CSS_HINT}`);
    }

    // JSX：<motion.x>、<AnimatePresence>、<animate>、whileHover
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (/^(motion|m)\.[A-Za-z]/.test(tag) && !shadowed(tag.split('.')[0]) && (!top.has(tag.split('.')[0]) || /^motion(\/|$)/.test(importedFrom.get(tag.split('.')[0]) ?? ''))) {
        hit(node, 'motion', `用了 <${tag}>：Motion 的组件按真实时间自己播动画。用普通的标签，把随时间变的样式写成 t 的函数（框架 ${FRAMEWORK_IMPORT} 的 tween、spring、interpolate）`);
      } else if (tag === 'AnimatePresence' || tag.endsWith('.AnimatePresence')) {
        hit(node, 'presence', `用了 <AnimatePresence>：进出场组件靠「上一帧有、这一帧没有」来播退场，这是在读前一帧的状态。出场、退场都写成 t 的条件和过渡：该出现的时间段里渲染它，透明度、位移由框架 ${FRAMEWORK_IMPORT} 的 tween / interpolate 按 t 算`);
      } else if (SMIL_TAGS.has(tag)) {
        hit(node, 'css-animation', `用了 SVG 的 <${tag}>：它按真实时间自己播。把属性写成 t 的函数`);
      }
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && MOTION_PROPS.test(attr.name.getText(sf))) {
          hit(attr, 'motion', `用了 ${attr.name.getText(sf)}：这是 Motion 的交互属性，导出时没有鼠标也没有滚动，它不会发生。要它出现就写成 t 的条件`);
        }
      }
    }

    if (isFunctionLike(node)) {
      scopes.push(localNames(node));
      ts.forEachChild(node, visit);
      scopes.pop();
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  violations.sort((a, b) => a.line - b.line);
  return { declared, usesFramework, violations };
}

const TAG = '[remotion 式]';
const TRAILER = `${TAG} 这张卡声明的是 remotion 式（frameMode: "direct"）：画面只由时间 t、参数和输入素材决定，只用框架 ${FRAMEWORK_IMPORT} 的工具写（interpolate、tween、spring、stagger、random 等）。要从起点一帧帧推进才能得到画面的写法，是另一种声明 frameMode: "stateful"，不归这套规矩管。`;

const countByRule = (violations) => {
  const out = new Map();
  for (const v of violations) out.set(v.rule, (out.get(v.rule) ?? 0) + 1);
  return out;
};

/**
 * 建卡、改卡时该拒绝的那几条，写成报错文案（每条带行号）。
 * @param {string} source 改完（或新建）的源码
 * @param {{ before?: string, fileName?: string, legacyAbsolute?: boolean }} [o]
 *   before：改之前的源码；新建卡给空串或不给。
 *   legacyAbsolute：`Date.now()`、`setTimeout` / `setInterval`、`IntersectionObserver` 是否出现即拒（用户卡是，原来就是这样）；
 *   内置与共用文件的编辑原来对这几样也是差量口径，传 false。
 * @returns {{ remotionStyle: boolean, errors: string[], violations: { rule: string, line: number, message: string }[] }}
 *   remotionStyle：这份源码声明成了 remotion 式。errors 为空就是这一道过了。
 */
export function remotionStyleErrors(source, o = {}) {
  const after = inspectRemotionStyle(source, o);
  const before = typeof o.before === 'string' && o.before.trim() ? inspectRemotionStyle(o.before, o) : null;
  const legacyAbsolute = o.legacyAbsolute !== false;
  let rejected;
  if (!before || (after.declared === 'direct' && after.usesFramework)) {
    // 新建的卡、用框架写的卡：每一条都不许
    rejected = after.violations;
  } else {
    // 改一张没引用框架的老卡：只拒绝这次新增的（按规则数个数）；改之前不是 remotion 式的，当它一条都没有
    const old = before.declared === 'direct' ? before.violations : before.violations.filter((v) => v.rule === 'frame-mode');
    const had = countByRule(old);
    const now = countByRule(after.violations);
    // 个数多出来的那条规则里，原样留着的旧行不重复报：按「规则 + 那一行的原文」一对一销掉
    const lineText = (text, n) => (String(text).split(/\r?\n/)[n - 1] ?? '').trim();
    const keyOf = (text, v) => `${v.rule}|${lineText(text, v.line)}`;
    const kept = new Map();
    for (const v of old) kept.set(keyOf(o.before, v), (kept.get(keyOf(o.before, v)) ?? 0) + 1);
    rejected = after.violations.filter((v) => {
      if (legacyAbsolute && v.legacy) return true;
      if (!((now.get(v.rule) ?? 0) > (had.get(v.rule) ?? 0))) return false;
      const k = keyOf(source, v);
      const left = kept.get(k) ?? 0;
      if (left > 0) { kept.set(k, left - 1); return false; }
      return true;
    });
  }
  const errors = rejected.map((v) => `${TAG} 第 ${v.line} 行：${v.message}。`);
  if (errors.length && after.declared === 'direct') errors.push(TRAILER);
  return { remotionStyle: after.declared === 'direct', errors, violations: rejected.map(({ rule, line, message }) => ({ rule, line, message })) };
}
