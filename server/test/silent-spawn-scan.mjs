/**
 * For testing and troubleshooting only. Scans JS/TS source code for process spawn calls using
 * node:child_process to find those missing windowsHide. Gatekeeper: see
 * `windows-hide-silent-spawn.test.mjs`; rule: see docs/semantics/guide_files/verification.md
 * "Windows verification silent execution".
 *
 * Why gatekeep: when parent process has no console (e.g. render worker process spawned by vite
 * detached from console), child processes without windowsHide open a new visible console window
 * on Windows; this is invisible when parent process has a console, so it cannot be caught solely
 * by checking if a window popped up.
 *
 * Recognition rules (syntax tree):
 * - Track bindings from `child_process` / `node:child_process`: named imports, namespace imports,
 *   default imports, `const { spawn } = require(..)` / `await import(..)`, 
 *   `const cp = require(..)`, and `promisify(execFile)` aliases;
 * - Call sites are spawn / fork / spawnSync / execFile / execFileSync / exec / execSync on these
 *   bindings (or `ns.spawn`);
 * - Counted as included if `windowsHide: true` appears in call text; when options are passed via
 *   variable or spread, look for declaration of that variable in this file, counted only if
 *   declaration includes it;
 * - Anything unrecognized (options from parameters, variables imported elsewhere...) is always
 *   reported, to be manually written explicitly or added to exception list with rationale.
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

/** requireOrImport(expr): true if expr is require('child_process') / import('child_process') (can include await) */
function isCpLoad(expr) {
  while (expr && (ts.isAwaitExpression(expr) || ts.isParenthesizedExpression(expr))) expr = expr.expression;
  if (!expr || !ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
  const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
  return (isRequire || isImport) && isCpSpecifier(expr.arguments[0]);
}

/**
 * Scans a source file and returns [{ line, callee, text, reason }]; reason is missing
 * (windowsHide omitted, including options from unrecognized variables) or unrecognized-binding
 * (quoted child_process appeared but import form was not recognized)
 */
export function scanSource(source, fileName = 'x.mjs') {
  const ext = path.extname(fileName).toLowerCase();
  const kind = ext === '.ts' || ext === '.mts' || ext === '.cts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, kind);

  const direct = new Map(); // Local name -> function name
  const namespaces = new Set(); // Local name (pointing to entire child_process)
  const declText = new Map(); // Variable name -> declaration text (check if options variable contains windowsHide)

  const addDeclText = (name, node) => {
    declText.set(name, (declText.get(name) || '') + '\n' + node.getText(sf));
  };

  // Pass 1: bindings and declarations
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

  // Aliases: const run = promisify(execFile) / const run = spawn
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
          // Options passed via variable or spread: inspect declaration of that variable in this file
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

  // Mentioned child_process but not a recognized import / load: report anyway (e.g. require
  // spliced into remote script text)
  const knownLines = new Set();
  const markKnown = (node) => {
    const isImp = (ts.isImportDeclaration(node) && isCpSpecifier(node.moduleSpecifier))
      || (ts.isImportTypeNode(node)); // import("node:child_process").ChildProcess is only a type
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
    // Only recognizes quoted module names (require / command string spliced into script text); lines
    // that already include windowsHide count as passed
    if (!/['"`](node:)?child_process['"`]/.test(lineText) || knownLines.has(i + 1) || /windowsHide/.test(lineText)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) return;
    hits.push({ line: i + 1, callee: '(child_process)', text: lineText.trim().slice(0, 160), fullText: lineText, reason: 'unrecognized-binding' });
  });
  return hits;
}

/** Lists source files in directory (recursively), returning forward-slash paths relative to root */
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
