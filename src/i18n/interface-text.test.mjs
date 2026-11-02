import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Interface code shows text only through tr() (src/i18n/index.ts), with English as the source.
 * A Chinese or Japanese string literal or JSX text here would show untranslated in other languages.
 * Data that really is Chinese (protocol tokens, markers in older projects, text matched in user
 * content) stays, with an `i18n-allow:` comment on the line above saying why.
 * Comments are not checked here.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCOPE = /^src\/(start|editor|mobile|ui|voice)\/|^src\/[^/]+\.tsx?$/;
const CJK = /[぀-ヿ㐀-鿿]/;

function walkDir(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.|-harness\./.test(entry.name)) out.push(full);
  }
  return out;
}

test("interface code has no Chinese text outside tr() keys", () => {
  const offenders = [];
  for (const full of walkDir(path.join(ROOT, "src"))) {
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (!SCOPE.test(rel)) continue;
    const text = fs.readFileSync(full, "utf8");
    if (!CJK.test(text)) continue;
    const lines = text.split(/\r?\n/);
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n) => {
      const literal = ts.isStringLiteralLike(n) || ts.isJsxText(n) || n.kind === ts.SyntaxKind.RegularExpressionLiteral
        || n.kind === ts.SyntaxKind.TemplateHead || n.kind === ts.SyntaxKind.TemplateMiddle || n.kind === ts.SyntaxKind.TemplateTail;
      if (literal && CJK.test(n.getText(sf))) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
        const allowed = [line, line - 1].some((l) => l >= 0 && lines[l].includes("i18n-allow:"));
        if (!allowed) offenders.push(`${rel}:${line + 1} ${n.getText(sf).trim().slice(0, 60)}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(offenders, []);
});
