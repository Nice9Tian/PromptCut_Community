// Run: npx tsx src/ai/__tests__/markdown.test.tsx
// @ts-ignore node types not installed in tsconfig; this file is run manually under node only
import assert from "node:assert";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, normalizeMath } from "../Markdown";

const html = (md: string) => renderToStaticMarkup(<>{renderMarkdown(md)}</>);

function test() {
  // Tables (GFM)
  const t = html("| Name | Seconds |\n| --- | --- |\n| Punchline card | 3 |");
  assert.ok(t.includes("<table"), "Should render as a table");
  assert.ok(t.includes("md-table-wrap"), "The table must be placed in a horizontal scroll container");
  assert.ok(t.includes("<th") && t.includes("Punchline card"), "Both the header and the cells must be present");

  // Inline formulas and standalone line formulas
  const inline = html("Total duration $t = a + b$ seconds");
  assert.ok(inline.includes("katex"), "Inline formulas must be handed to KaTeX");
  const block = html("$$\n\\frac{1}{2}\n$$");
  assert.ok(block.includes("katex-display"), "A formula on its own line must use display style");
  // Models mostly write $$…$$ on a single line; must also be treated as a standalone line formula
  assert.ok(html("Text before\n\n$$N = a + b$$\n\nText after").includes("katex-display"), "A single-line $$…$$ must also be display");
  const inlineOnly = html("Inline $x$ is unaffected");
  assert.ok(inlineOnly.includes("katex") && !inlineOnly.includes("katex-display"), "Inline formulas must not become display");

  // \( \) \[ \] frequently written by models must also be recognized
  assert.strictEqual(normalizeMath("Value \\(x^2\\) end"), "Value $x^2$ end");
  // When \[ … \] occupies a standalone line, it expands into three lines to be recognized as a standalone line formula
  assert.strictEqual(normalizeMath("\\[a+b\\]"), "$$\na+b\n$$");
  assert.ok(html("Area \\(\\pi r^2\\)").includes("katex"), "The \\( \\) form must also be rendered");

  // Backslashes in code blocks are code; cannot be treated as formulas and modified
  const code = "```js\nconst re = /\\(x\\)/;\n```";
  assert.strictEqual(normalizeMath(code), code, "Code block content must be kept as is");
  assert.strictEqual(normalizeMath("`\\(a\\)`"), "`\\(a\\)`", "Inline code must also be kept as is");

  // Basic Markdown
  const basic = html("# Title\n\n- One\n- Two\n\n**Bold** and `code`");
  assert.ok(basic.includes("<h1"), "Title");
  assert.ok(basic.includes("<li>"), "List");
  assert.ok(basic.includes("<strong>") && basic.includes("<code>"), "Bold and inline code");

  // Without raw HTML: tags written by model are escaped as text, not injected for real
  const raw = html('Normal <img src=x onerror="alert(1)"> end');
  assert.ok(!raw.includes("<img"), "Raw HTML must be escaped and must not be rendered");

  // Links include security attributes
  assert.ok(html("[Site](https://example.com)").includes('rel="noreferrer noopener"'), "External links must carry rel");

  console.log("markdown: all assertions passed");
}

test();
