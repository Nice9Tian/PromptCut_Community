/**
 * Card creation checks for remotion-style cards (`docs/plan/render-standard.md` "Remotion-style rules";
 * framework in `src/kernel/remotionStyle/`).
 *
 * Declaring a card as remotion-style (`frameMode: "direct"`) means: this frame's visual is
 * determined solely by time t, parameters, and input assets. Here we only inspect source code without
 * execution, flagging patterns that violate this statement point by point, each with line numbers.
 * Called by `checkCardSource` / `checkSourceEdit` in `server/vite-plugin-cards.ts` when creating or
 * modifying cards; desktop card creation and Cloud Agent card creation use the same function.
 * Installing cards (opening a project, content store sync) does not call it: cards already in the
 * library are loaded as before.
 *
 * Rules (the `rule` column is an identifier; test fixtures provide one violation sample per rule):
 *
 * | rule | Rule | What it detects |
 * |---|---|---|
 * | `import` | Only framework and base libraries allowed | Imports outside the list; dynamic `import()`, `require()` |
 * | `real-time` | No reading real time | `Date.now()`, `new Date()` / `Date()` without arguments, `performance` |
 * | `timer` | No timers | `setTimeout`, `setInterval`, `setImmediate`, `requestIdleCallback` |
 * | `frame-callback` | No browser per-frame callbacks | `requestAnimationFrame`, `cancelAnimationFrame`, `setAnimationLoop`, `requestVideoFrameCallback` |
 * | `motion` | No Motion animations or springs | Importing `motion` / `motion/react`; `<motion.x>`; attributes like `whileHover` |
 * | `presence` | No entrance/exit components | `<AnimatePresence>` |
 * | `css-animation` | No CSS animations or transitions | `animation*` / `transition*` in styles; `@keyframes`, `animation:`, `transition:` in style text; class names `animate-*`, `transition*`; `.animate()` on elements; SVG `<animate>` |
 * | `random` | No unseeded randomness | `Math.random`, `crypto` |
 * | `state` | Do not carry state into next frame | State hooks like `useState`; `useRef(initialValue)`, writing to `.current`; writing to file top-level names or imported items; `window`, `globalThis`, local storage; `eval`, `Function()` |
 * | `top-level` | Only constants at file top level | Top-level `let` / `var` / `class` / `enum`, directly executed statements; `new`, `await`, assignments in top-level initializers |
 * | `viewport` | Cards play upon mount | `IntersectionObserver` (already prohibited for all cards, line numbers added here) |
 * | `frame-mode` | Syntax must match declaration | `frameMode` written as something where a literal cannot be read |
 * | `framework` | Must import framework | Declared as remotion-style, but without any framework import surviving into runtime (type-only imports do not count). Cards needing no utilities (only using `t` for arithmetic, media effect cards using only GLSL, audio-only cards) write a bare import `import "../../kernel/remotionStyle";` |
 *
 * The category that cannot be detected from source code (dependencies on "what loads first": fonts or
 * images rendering one version first and then changing) is not here; see the report and
 * `server/bakery/frame-ready.mjs`.
 *
 * Why framework import is required: upon loading, only cards "declared as remotion-style and
 * importing the framework" have their file top level locked to read-only
 * (`src/online/cardRuntime/remotionLock.mjs`). Cards not importing the framework are not locked, so
 * writing to top-level objects via an intermediate variable cannot be detected. Uses the same
 * criterion for "whether to lock" and "whether valid", without extra markers
 * (`docs/plan/html-snapshot-removal-dryrun.md` Section 8.2).
 *
 * Newly created cards (without a version prior to editing) and cards importing the framework:
 * rejected on every rule. Modifying a card created before the framework existed that does not import
 * the framework: reject only violations **newly introduced** in this edit (counting by rule),
 * without penalizing preexisting ones: matching the delta criteria of `compositing: 'independent'`;
 * the three items `Date.now()`, `setTimeout` / `setInterval`, and `IntersectionObserver` were
 * originally rejected on sight for all cards, and remain as before.
 */
import ts from 'typescript';

/** Repository-relative path to the framework (without extension) */
export const REMOTION_FRAMEWORK = 'src/kernel/remotionStyle';

/**
 * Modules that remotion-style cards can import. Package names as-is; built-in modules are
 * repository-relative paths (without extension). Type-only imports (`import type …`) are exempt:
 * they leave no trace after transpilation.
 */
export const REMOTION_IMPORT_ALLOW = Object.freeze([
  'react',                              // Components and stateless hooks
  'react/jsx-runtime',
  REMOTION_FRAMEWORK,                   // Framework
  'src/kernel/types',                   // CardDef, CardProps
  'src/kernel/frameReady',              // Block snapshots before async preparation is ready (beginFrameWork)
  'src/kernel/soundEffects',            // Sound recipes (pure computation)
  'src/render/cards/graphValues',       // Exports for media effect cards: glsl, draw, bitmap
  'src/cards/native/hud',               // Conventions for position and primary color
  'src/cards/native/sound-effects',     // cardSoundBlock
  'src/cards/magicui/vendor/cn',        // Concatenate class names
]);

/** Framework import syntax used in errors (user cards under `src/cards/user/`) */
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

/** Repository-relative path of `spec` computed relative to `fileName` directory (no extension, no `/index`); package names as-is; returns null if climbing out of repo root */
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

/** Names declared in binding patterns */
function bindingNames(name, out) {
  if (!name) return;
  if (ts.isIdentifier(name)) { out.add(name.text); return; }
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/** Names declared inside a function (parameters, variables and functions across levels in function body; does not enter nested function bodies, only collecting their names) */
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
 * Inspect source code rule by rule.
 * @param {string} source
 * @param {{ fileName?: string }} [o] fileName: repository-relative path of this file (used to
 *   resolve relative imports); defaults to assuming it is a card under `src/cards/user/`
 * @returns {{
 *   declared: 'direct' | 'other' | 'none',   // Declared style: remotion-style / other / none
 *   usesFramework: boolean,                  // References framework
 *   violations: { rule: string, line: number, message: string, legacy?: boolean }[],
 * }}
 * For cards not declared as remotion-style, `violations` contains at most the single `frame-mode`
 * violation (`frameMode` literal cannot be read).
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

  /* ---------- Top-level names ---------- */
  /** Name → kind (import / const / let / var / function / class / enum) */
  const top = new Map();
  /** Imported name → specifier */
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

  /* ---------- Declared style ---------- */
  const topConstString = (name) => {
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return stringOf(unwrap(d.initializer));
    }
    return null;
  };
  let declared = 'none';
  /** Location with `frameMode: "direct"` (errors for the `framework` rule point to it) */
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
    hit(node, 'frame-mode', 'frameMode must be written directly as a literal: "direct" (remotion style) or "stateful" (motion style). If it is written as a variable or a computed value, card creation cannot tell which style this card uses');
  }

  /** usesFramework: has an import pointing to framework (including type-only); loadsFramework: contains imports kept at runtime (bare/value imports) */
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

  /* ---------- Must reference framework ---------- */
  if (!loadsFramework) {
    hit(directNode ?? sf, 'framework', `This card declares remotion style but does not import the framework. Add a line \`import ${FRAMEWORK_IMPORT};\` at the top of the file; to use the tools, write \`import { tween } from ${FRAMEWORK_IMPORT};\`. Once imported, top-level objects in the file are locked read-only when the card loads`);
  }

  /* ---------- Imports ---------- */
  const checkSpecifier = (node, spec, typeOnly) => {
    if (typeOnly) return;
    if (spec === 'motion' || spec.startsWith('motion/')) {
      hit(node, 'motion', `Imported ${spec}: Motion animations and springs advance on their own in real time, so the picture of a given frame cannot be computed when jumping to it. For transitions, springs and staggered entrances, use tween, spring and stagger from the framework ${FRAMEWORK_IMPORT}, which compute directly from t`);
      return;
    }
    const at = normalizeSpecifier(fileName, spec);
    if (at !== null && REMOTION_IMPORT_ALLOW.includes(at)) return;
    hit(node, 'import', `Imported ${spec.slice(0, 80)}: remotion-style cards may only import the framework ${FRAMEWORK_IMPORT}, react, "../../kernel/types", "../../kernel/frameReady", "../../kernel/soundEffects", "../../render/cards/graphValues", "../native/hud", "../native/sound-effects", "../magicui/vendor/cn"`);
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
      hit(st, 'import', 'import x = require(…) is not allowed: in remotion-style cards, imports must be written only as import … from "…"');
    }
  }

  /* ---------- Only constants allowed at file top level ---------- */
  const TOP_ONLY = 'Only import, types, functions and const constants are allowed at the top level of a card file';
  const checkInitializer = (init) => {
    const walk = (node) => {
      if (isFunctionLike(node)) return; // Function bodies run only when called; governed by the individual rules below
      if (ts.isNewExpression(node)) hit(node, 'top-level', 'Top level uses new: things created with new (Map, Set, class instances, fixed-length arrays) cannot be locked read-only and would become a place to store data across frames. For lookup tables, write an object or array literal; if you really need one, create it inside a function');
      else if (ts.isAwaitExpression(node)) hit(node, 'top-level', 'Top level uses await: a card cannot wait for async work when it loads. Put async preparation inside the component and use beginFrameWork to hold back the screenshot');
      else if (isAssignment(node) || isUpdate(node) || ts.isDeleteExpression(node)) hit(node, 'top-level', `Top-level initializer contains an assignment: ${TOP_ONLY}`);
      else if (ts.isClassExpression(node)) hit(node, 'top-level', `Top level contains a class: ${TOP_ONLY}`);
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
        hit(st, 'top-level', `Top level contains ${flags & ts.NodeFlags.Let ? 'let' : 'var'}: a mutable top-level variable outlives a frame, so what one frame writes can be read by the next. ${TOP_ONLY}; compute time-varying values in the component from t`);
      }
      for (const d of st.declarationList.declarations) if (d.initializer) checkInitializer(d.initializer);
      continue;
    }
    if (ts.isExportAssignment(st)) { checkInitializer(st.expression); continue; }
    if (ts.isClassDeclaration(st)) { hit(st, 'top-level', `Top level contains a class: static fields and instances of a class are mutable. ${TOP_ONLY}; write components as functions`); continue; }
    if (ts.isEnumDeclaration(st)) { hit(st, 'top-level', `Top level contains an enum: ${TOP_ONLY}; use a union type or a const object`); continue; }
    if (ts.isExpressionStatement(st) && stringOf(st.expression) !== null) continue; // Directives like "use strict"
    hit(st, 'top-level', `Top level contains a directly executed statement: ${TOP_ONLY}. Nothing may be done at load time (registering, changing globals, precomputing and storing)`);
  }

  /* ---------- Node by node ---------- */
  /** Names declared in outer functions (shadowing same-named global or top-level names) */
  const scopes = [];
  const shadowed = (name) => scopes.some((s) => s.has(name));
  /** Whether this identifier is used as a value (not property name, declared name, or tag name) */
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
  /** Assignment target unwrapped to innermost name; returns null if not starting with a name */
  const rootOf = (expr) => {
    let n = unwrap(expr);
    while (n && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) n = unwrap(n.expression);
    return n && ts.isIdentifier(n) ? n : null;
  };
  /** Whether this name is at file top level (not shadowed by same-named variable in a function) */
  const topKind = (id) => (id && !shadowed(id.text) ? top.get(id.text) ?? null : null);
  const describeTop = (id) => (top.get(id.text) === 'import' ? `imported ${id.text}` : `top-level ${id.text} of the file`);
  const NO_CARRY = 'The picture of this frame may only be computed from t, parameters and input assets, and must not read anything left over from the previous frame';

  const checkWriteTarget = (node, target) => {
    const t = unwrap(target);
    if (t && ts.isPropertyAccessExpression(t) && t.name.text === 'current') {
      hit(node, 'state', `Writing to .current: a value stored in a ref outlives a frame, so this carries data over to the next frame. ${NO_CARRY}; use a ref only to hold DOM nodes`);
      return;
    }
    const root = rootOf(target);
    if (root && topKind(root)) hit(node, 'state', `Writing to ${describeTop(root)}: it outlives a single frame, so what the previous frame wrote is readable in the next frame. ${NO_CARRY}`);
  };

  /** Whether the string is in a "class name" position (in className attribute, arguments to cn(), etc.) */
  const inClassContext = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxAttribute(p)) return ['className', 'class'].includes(p.name.getText(sf));
      if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && CLASS_HELPERS.has(p.expression.text)) return true;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && /class/i.test(p.name.text)) return true;
      if (isFunctionLike(p) || ts.isSourceFile(p)) return false;
    }
    return false;
  };
  /** Whether object literal is a style (in style property, variable with style in name/type, argument to Object.assign(x.style, …)) */
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
  const CSS_HINT = `CSS animations and transitions follow real time, so they fall out of sync with frames when the machine stalls. Write time-varying styles as functions of t (the framework's ${FRAMEWORK_IMPORT} interpolate, tween, spring), directly in style`;

  const checkText = (node, text) => {
    if (CSS_TEXT.test(text)) hit(node, 'css-animation', `The style text contains a CSS animation or transition (@keyframes / animation / transition): ${CSS_HINT}`);
    const animate = CLASS_ANIMATE.test(text);
    if (animate || (CLASS_TRANSITION.test(text) && inClassContext(node))) {
      hit(node, 'css-animation', `The class name contains ${animate ? 'animate-*' : 'transition'}: ${CSS_HINT}`);
    }
  };

  const visit = (node) => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;

    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (isGlobal(node)) {
        if (name === 'performance') hit(node, 'real-time', `Read real time (performance): export and prerender run on the stage's own frame clock, and real time differs every run. If you need time, use the t the component receives`);
        else if (TIMERS.has(name)) hit(node, 'timer', `Used a timer (${name}): it fires on real time and does not follow frames. Write "appear after a while" as a condition on t: t >= some number of seconds, or the delay of the framework's tween / stagger`, LEGACY_TIMERS.has(name) ? { legacy: true } : undefined);
        else if (FRAME_CALLBACKS.has(name)) hit(node, 'frame-callback', `Used the browser's per-frame callback (${name}): it follows the screen refresh, so how many times it is called and at what interval are not deterministic. The stage re-renders this card on every frame with a new t, so just write the picture as a function of t`);
        else if (name === 'crypto') hit(node, 'random', `Used unseeded randomness (crypto): it returns a different number every time. Use the framework's ${FRAMEWORK_IMPORT} random(seed, index)`);
        else if (GLOBAL_STORES.has(name)) hit(node, 'state', `Used ${name}: global objects and local storage outlive a single frame and are a place to keep things across frames. ${NO_CARRY}`);
        else if (name === 'eval') hit(node, 'state', 'Used eval: code assembled at runtime cannot be checked when the card is created');
        else if (name === 'IntersectionObserver') hit(node, 'viewport', 'Used IntersectionObserver: a card plays as soon as it is mounted, so "scrolling into the viewport" does not exist', { legacy: true });
        else if (name === 'Function' && node.parent && (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node) {
          hit(node, 'state', 'Used Function(…): code assembled at runtime cannot be checked when the card is created');
        }
      }
    }

    // Math.random, Date.now, x.setAnimationLoop, x.animate(…)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const obj = unwrap(node.expression);
      const member = ts.isPropertyAccessExpression(node) ? node.name.text : stringOf(node.argumentExpression);
      const globalObj = obj && ts.isIdentifier(obj) && isGlobal(obj) ? obj.text : null;
      if (globalObj === 'Math' && member === 'random') hit(node, 'random', `Used unseeded randomness (Math.random): each call advances one step, so which number frame N gets depends on how many times it was called before, and jumping straight to frame N gives a mismatch. Use the framework's ${FRAMEWORK_IMPORT} random(seed, index), computed directly from the seed and index`);
      if (globalObj === 'Date' && member === 'now') hit(node, 'real-time', 'Read real time (Date.now()): export and prerender run on the stage\'s own frame clock, and real time differs every run. If you need time, use the t the component receives', { legacy: true });
      if (member && FRAME_CALLBACK_MEMBERS.has(member)) hit(node, 'frame-callback', `Used a built-in frame loop (${member}): it follows the screen refresh. Write the picture as a function of t and draw explicitly once whenever t changes`);
    }
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (callee && ts.isIdentifier(callee) && callee.text === 'Date' && isGlobal(callee) && (node.arguments?.length ?? 0) === 0) {
        hit(node, 'real-time', `Read real time (${ts.isNewExpression(node) ? 'new Date()' : 'Date()'}): export and prerender run on the stage's own frame clock, and real time differs every run. If you need time, use the t the component receives`);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) hit(node, 'import', 'Used dynamic import(): imports in a remotion-style card must only be written as import … from "…" at the start of the file');
      if (callee && ts.isIdentifier(callee) && callee.text === 'require' && isGlobal(callee)) hit(node, 'import', 'Used require(): imports in a remotion-style card must only be written as import … from "…" at the start of the file');
      // Hooks that track state
      const hook = callee && ts.isIdentifier(callee) ? callee.text : callee && ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const fromReact = callee && (ts.isIdentifier(callee) ? (!shadowed(callee.text) && (importedFrom.get(callee.text) === 'react' || !top.has(callee.text))) : true);
      if (hook && fromReact && STATE_HOOKS.has(hook)) {
        hit(node, 'state', `Used ${hook}: the value it remembers outlives a single frame, so the picture is no longer determined by t and the parameters alone. ${NO_CARRY}; compute time-varying values directly from t, and use only useMemo for caching`);
      }
      if (hook === 'useRef' && fromReact && node.arguments.length > 0) {
        const init = unwrap(node.arguments[0]);
        const empty = init.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(init) && init.text === 'undefined');
        if (!empty) hit(node, 'state', `useRef was given an initial value: a value stored in a ref outlives a single frame and is a place to keep things across frames. In a remotion-style card a ref is only used to get a DOM node, so write useRef(null). ${NO_CARRY}`);
      }
      // Element animate()
      if (callee && ts.isPropertyAccessExpression(callee) && callee.name.text === 'animate') {
        hit(node, 'css-animation', `Called .animate(…): the element animation API follows real time. ${CSS_HINT}`);
      }
      // Writing into top-level targets: X.push(…), Object.assign(X, …)
      if (callee && ts.isPropertyAccessExpression(callee) && MUTATORS.has(callee.name.text)) {
        const root = rootOf(callee.expression);
        if (root && topKind(root)) hit(node, 'state', `Writing to ${describeTop(root)} (${callee.name.text}): it outlives a single frame, so what the previous frame wrote is readable in the next frame. ${NO_CARRY}`);
      }
      if (callee && ts.isPropertyAccessExpression(callee) && OBJECT_WRITERS.has(callee.name.text) && node.arguments[0]) {
        const holder = unwrap(callee.expression);
        const root = rootOf(node.arguments[0]);
        if (holder && ts.isIdentifier(holder) && ['Object', 'Reflect'].includes(holder.text) && root && topKind(root)) {
          hit(node, 'state', `Writing to ${describeTop(root)} (${holder.text}.${callee.name.text}): it outlives a single frame, so what the previous frame wrote is readable in the next frame. ${NO_CARRY}`);
        }
      }
    }

    // Assignment, increment/decrement, delete
    if (isAssignment(node)) checkWriteTarget(node, node.left);
    else if (isUpdate(node)) checkWriteTarget(node, node.operand);
    else if (ts.isDeleteExpression(node)) checkWriteTarget(node, node.expression);
    // el.style.transition = …
    if (isAssignment(node)) {
      const left = unwrap(node.left);
      if (left && ts.isPropertyAccessExpression(left) && STYLE_KEY.test(left.name.text) && /\.style$/.test(left.expression.getText(sf))
        && !STYLE_OFF.has(stringOf(unwrap(node.right)) ?? '?')) {
        hit(node, 'css-animation', `Wrote ${left.name.text} into the style: ${CSS_HINT}`);
      }
    }

    // animation* / transition* in style objects
    if (ts.isObjectLiteralExpression(node) && inStyleContext(node)) {
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
        const key = nameOf(prop.name);
        if (!key || !STYLE_KEY.test(key)) continue;
        if (ts.isPropertyAssignment(prop) && STYLE_OFF.has(stringOf(unwrap(prop.initializer)) ?? '?')) continue; // Explicitly writing "none" does not count
        hit(prop, 'css-animation', `Wrote ${key} in the style: ${CSS_HINT}`);
      }
    }

    // Strings: style text, class names
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent;
      const isSpecifier = p && (ts.isImportDeclaration(p) || ts.isExportDeclaration(p));
      const isKey = p && ts.isPropertyAssignment(p) && p.name === node;
      if (!isSpecifier && !isKey) checkText(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      checkText(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '));
    } else if (ts.isJsxText(node)) {
      if (CSS_TEXT.test(node.text)) hit(node, 'css-animation', `The style text contains a CSS animation or transition (@keyframes / animation / transition): ${CSS_HINT}`);
    }

    // JSX: <motion.x>, <AnimatePresence>, <animate>, whileHover
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (/^(motion|m)\.[A-Za-z]/.test(tag) && !shadowed(tag.split('.')[0]) && (!top.has(tag.split('.')[0]) || /^motion(\/|$)/.test(importedFrom.get(tag.split('.')[0]) ?? ''))) {
        hit(node, 'motion', `Used <${tag}>: Motion components play animations by themselves on real time. Use a plain tag and write time-varying styles as functions of t (the framework's ${FRAMEWORK_IMPORT} tween, spring, interpolate)`);
      } else if (tag === 'AnimatePresence' || tag.endsWith('.AnimatePresence')) {
        hit(node, 'presence', `Used <AnimatePresence>: presence components play the exit by relying on "present in the previous frame, absent in this one", which reads the previous frame's state. Write both entrance and exit as conditions and transitions on t: render it during the time range when it should appear, and compute opacity and offset with the framework's ${FRAMEWORK_IMPORT} tween / interpolate from t`);
      } else if (SMIL_TAGS.has(tag)) {
        hit(node, 'css-animation', `Used SVG <${tag}>: it plays by itself on real time. Write the attributes as functions of t`);
      }
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && MOTION_PROPS.test(attr.name.getText(sf))) {
          hit(attr, 'motion', `Used ${attr.name.getText(sf)}: this is a Motion interaction property, and during export there is no mouse and no scrolling, so it never happens. To make it appear, write it as a condition on t`);
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

const TAG = '[remotion-style]';
const TRAILER = `${TAG} This card declares remotion-style (frameMode: "direct"): the picture is determined only by time t, the parameters and the input media, and is written using only the framework's ${FRAMEWORK_IMPORT} tools (interpolate, tween, spring, stagger, random, etc.). A style that needs to advance frame by frame from the start to get the picture is a different declaration, frameMode: "stateful", and is not governed by these rules.`;

const countByRule = (violations) => {
  const out = new Map();
  for (const v of violations) out.set(v.rule, (out.get(v.rule) ?? 0) + 1);
  return out;
};

/**
 * Rules to reject when creating or editing cards, written as error messages (each with line number).
 * @param {string} source Modified (or newly created) source code
 * @param {{ before?: string, fileName?: string, legacyAbsolute?: boolean }} [o]
 *   before: Source code before edits; pass empty string or omit for newly created cards.
 *   legacyAbsolute: Whether to reject immediately if `Date.now()`, `setTimeout` / `setInterval`, or
 *   `IntersectionObserver` appears (true for user cards, as originally designed);
 *   editing built-in and shared files was originally on a delta basis for these as well, pass false.
 * @returns {{ remotionStyle: boolean, errors: string[], violations: { rule: string, line: number, message: string }[] }}
 *   remotionStyle: This source is declared as remotion-style. Empty errors means this check passed.
 */
export function remotionStyleErrors(source, o = {}) {
  const after = inspectRemotionStyle(source, o);
  const before = typeof o.before === 'string' && o.before.trim() ? inspectRemotionStyle(o.before, o) : null;
  const legacyAbsolute = o.legacyAbsolute !== false;
  let rejected;
  if (!before || (after.declared === 'direct' && after.usesFramework)) {
    // Newly created cards, cards using the framework: none are allowed
    rejected = after.violations;
  } else {
    // Modifying an old card without framework reference: only reject items newly added this time
    // (by rule count); if not remotion-style before modification, treat it as having none
    const old = before.declared === 'direct' ? before.violations : before.violations.filter((v) => v.rule === 'frame-mode');
    const had = countByRule(old);
    const now = countByRule(after.violations);
    // For rules with increased count, unchanged existing lines are not re-reported: cancel one-to-one
    // by "rule + original line text"
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
  const errors = rejected.map((v) => `${TAG} Line ${v.line}: ${v.message}.`);
  if (errors.length && after.declared === 'direct') errors.push(TRAILER);
  return { remotionStyle: after.declared === 'direct', errors, violations: rejected.map(({ rule, line, message }) => ({ rule, line, message })) };
}
