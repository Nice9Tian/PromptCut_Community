/**
 * 仅供测试与排查。扫 JS/TS 源码里 node:child_process 的起进程调用，找出没带 windowsHide 的。
 * 守门见 `windows-hide-silent-spawn.test.mjs`；规则见 docs/semantics/guide_files/verification.md「Windows 验证静默运行」。
 *
 * 为什么要守：父进程没有控制台时（例如被 vite 脱离控制台起的渲染工作进程），不带 windowsHide 的子进程
 * 会在 Windows 上新开一个可见的控制台窗口；父进程有控制台时看不出来，所以只靠看是否弹过窗口发现不了。
 *
 * 认法（语法树）：
 * - 跟踪来自 `child_process` / `node:child_process` 的绑定：命名导入、命名空间导入、默认导入、
 *   `const { spawn } = require(..)` / `await import(..)`、`const cp = require(..)`，以及 `promisify(execFile)` 的别名；
 * - 调用点是这些绑定（或 `ns.spawn`）的 spawn / fork / spawnSync / execFile / execFileSync / exec / execSync；
 * - 调用文本里出现 `windowsHide: true` 算带了；选项经变量或展开传入时，到本文件里找该变量的声明，声明里带了才算；
 * - 认不出的（选项来自参数、别处导入的变量……）一律报出，由人改成显式写出，或加进例外名单并写理由。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const CP_MODULES = new Set(['child_process', 'node:child_process']);
const CP_FUNCS = new Set(['spawn', 'fork', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']);
const SCRIPT_EXT = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

function isCpSpecifier(node) {
  return node && ts.isStringLiteralLike(node) && CP_MODULES.has(node.text);
}

/** requireOrImport(expr) 若 expr 是 require('child_process') / import('child_process')（可带 await）则 true */
function isCpLoad(expr) {
  while (expr && (ts.isAwaitExpression(expr) || ts.isParenthesizedExpression(expr))) expr = expr.expression;
  if (!expr || !ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
  const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
  return (isRequire || isImport) && isCpSpecifier(expr.arguments[0]);
}

/** 扫一份源码，返回 [{ line, callee, text, reason }]；reason 为 missing（没带 windowsHide，含选项来自认不出的变量）或 unrecognized-binding（出现了引号括起的 child_process 却没认出是哪种导入） */
export function scanSource(source, fileName = 'x.mjs') {
  const ext = path.extname(fileName).toLowerCase();
  const kind = ext === '.ts' || ext === '.mts' || ext === '.cts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, kind);

  const direct = new Map(); // 本地名 -> 函数名
  const namespaces = new Set(); // 本地名（指向整个 child_process）
  const declText = new Map(); // 变量名 -> 声明文本（找选项变量里有没有 windowsHide）

  const addDeclText = (name, node) => {
    declText.set(name, (declText.get(name) || '') + '\n' + node.getText(sf));
  };

  // 第一遍：绑定与声明
  const pass1 = (node) => {
    if (ts.isImportDeclaration(node) && isCpSpecifier(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) direct.set(el.name.text, (el.propertyName || el.name).text);
      }
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) addDeclText(node.name.text, node);
      if (node.initializer && isCpLoad(node.initializer)) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const imported = (el.propertyName || el.name);
            if (ts.isIdentifier(imported) && ts.isIdentifier(el.name)) direct.set(el.name.text, imported.text);
          }
        }
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) addDeclText(node.name.text, node);
    ts.forEachChild(node, pass1);
  };
  pass1(sf);

  // 别名：const run = promisify(execFile) / const run = spawn
  for (let changed = true; changed;) {
    changed = false;
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !direct.has(node.name.text)) {
        let init = node.initializer;
        if (ts.isCallExpression(init)) {
          const c = init.expression;
          const isPromisify = (ts.isIdentifier(c) && c.text === 'promisify') || (ts.isPropertyAccessExpression(c) && c.name.text === 'promisify');
          if (isPromisify && init.arguments[0]) init = init.arguments[0];
        }
        if (ts.isIdentifier(init) && direct.has(init.text)) { direct.set(node.name.text, direct.get(init.text)); changed = true; }
        else if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression) && namespaces.has(init.expression.text) && CP_FUNCS.has(init.name.text)) {
          direct.set(node.name.text, init.name.text); changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const hasHide = (text) => /windowsHide\s*:(?!\s*false\b)/.test(text) || /\bwindowsHide\b(?!\s*:)/.test(text);

  const hits = [];
  const check = (node) => {
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      let func = null;
      let calleeText = '';
      if (ts.isIdentifier(c) && direct.has(c.text) && CP_FUNCS.has(direct.get(c.text))) { func = direct.get(c.text); calleeText = c.text; }
      else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && namespaces.has(c.expression.text) && CP_FUNCS.has(c.name.text)) {
        func = c.name.text; calleeText = `${c.expression.text}.${c.name.text}`;
      } else if (ts.isPropertyAccessExpression(c) && CP_FUNCS.has(c.name.text) && isCpLoad(c.expression)) {
        func = c.name.text; calleeText = c.name.text;
      }
      if (func) {
        const text = node.getText(sf);
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        let ok = hasHide(text);
        const reason = 'missing';
        if (!ok) {
          // 选项经变量或展开传入：到本文件里看该变量的声明
          const names = [];
          const collect = (n) => {
            if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) names.push(n.text);
            ts.forEachChild(n, collect);
          };
          for (const arg of node.arguments) collect(arg);
          if (names.some((n) => declText.has(n) && hasHide(declText.get(n)))) ok = true;
        }
        if (!ok) hits.push({ line, callee: calleeText, text: text.length > 160 ? text.slice(0, 160) + '…' : text, fullText: text, reason });
      }
    }
    ts.forEachChild(node, check);
  };
  check(sf);

  // 提到了 child_process 却不是已认出的导入 / 载入：宁可报出来（例如拼进远端脚本文本里的 require）
  const knownLines = new Set();
  const markKnown = (node) => {
    const isImp = (ts.isImportDeclaration(node) && isCpSpecifier(node.moduleSpecifier))
      || (ts.isImportTypeNode(node)); // import("node:child_process").ChildProcess 只是类型
    const isLoad = ts.isVariableDeclaration(node) && node.initializer && isCpLoad(node.initializer);
    if (isImp || isLoad) {
      const s0 = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const e0 = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
      for (let l = s0; l <= e0; l++) knownLines.add(l + 1);
    }
    ts.forEachChild(node, markKnown);
  };
  markKnown(sf);
  source.split('\n').forEach((lineText, i) => {
    // 只认带引号的模块名（拼进脚本文本里的 require / 命令字符串）；那行自己已带 windowsHide 的算过
    if (!/['"`](node:)?child_process['"`]/.test(lineText) || knownLines.has(i + 1) || /windowsHide/.test(lineText)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) return;
    hits.push({ line: i + 1, callee: '(child_process)', text: lineText.trim().slice(0, 160), fullText: lineText, reason: 'unrecognized-binding' });
  });
  return hits;
}

/** 列目录下（可递归）的源码文件，返回相对 root 的正斜杠路径 */
export function listSources(root, rel, { recursive = true, skip = () => false } = {}) {
  const out = [];
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return out;
  const walk = (d, r) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const rr = r ? `${r}/${ent.name}` : ent.name;
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      if (skip(rr, ent)) continue;
      if (ent.isDirectory()) { if (recursive) walk(path.join(d, ent.name), rr); }
      else if (SCRIPT_EXT.has(path.extname(ent.name).toLowerCase())) out.push(rr);
    }
  };
  walk(dir, rel.replace(/\/$/, ''));
  return out;
}
