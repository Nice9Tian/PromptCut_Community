// 运行: npx tsx src/ai/__tests__/markdown.test.tsx
// @ts-ignore tsconfig 里没装 node 类型,这个文件只在 node 下手动跑
import assert from "node:assert";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, normalizeMath } from "../Markdown";

const html = (md: string) => renderToStaticMarkup(<>{renderMarkdown(md)}</>);

function test() {
  // 表格(GFM)
  const t = html("| Name | Seconds |\n| --- | --- |\n| Punchline card | 3 |");
  assert.ok(t.includes("<table"), "Should render as a table");
  assert.ok(t.includes("md-table-wrap"), "The table must be placed in a horizontal scroll container");
  assert.ok(t.includes("<th") && t.includes("Punchline card"), "Both the header and the cells must be present");

  // 行内公式与独占一行的公式
  const inline = html("Total duration $t = a + b$ seconds");
  assert.ok(inline.includes("katex"), "Inline formulas must be handed to KaTeX");
  const block = html("$$\n\\frac{1}{2}\n$$");
  assert.ok(block.includes("katex-display"), "A formula on its own line must use display style");
  // 模型多半把 $$…$$ 写在一行里,同样要当成独占一行的公式
  assert.ok(html("Text before\n\n$$N = a + b$$\n\nText after").includes("katex-display"), "A single-line $$…$$ must also be display");
  const inlineOnly = html("Inline $x$ is unaffected");
  assert.ok(inlineOnly.includes("katex") && !inlineOnly.includes("katex-display"), "Inline formulas must not become display");

  // 模型常写的 \( \) \[ \] 也要认
  assert.strictEqual(normalizeMath("Value \\(x^2\\) end"), "Value $x^2$ end");
  // \[ … \] 独占一行时会顺带摊成三行,才会被当成独占一行的公式
  assert.strictEqual(normalizeMath("\\[a+b\\]"), "$$\na+b\n$$");
  assert.ok(html("Area \\(\\pi r^2\\)").includes("katex"), "The \\( \\) form must also be rendered");

  // 代码块里的反斜杠是代码,不能被当成公式改掉
  const code = "```js\nconst re = /\\(x\\)/;\n```";
  assert.strictEqual(normalizeMath(code), code, "Code block content must be kept as is");
  assert.strictEqual(normalizeMath("`\\(a\\)`"), "`\\(a\\)`", "Inline code must also be kept as is");

  // 基本 Markdown
  const basic = html("# Title\n\n- One\n- Two\n\n**Bold** and `code`");
  assert.ok(basic.includes("<h1"), "Title");
  assert.ok(basic.includes("<li>"), "List");
  assert.ok(basic.includes("<strong>") && basic.includes("<code>"), "Bold and inline code");

  // 不开 raw HTML:模型写的标签当文字转义,不能真的注入
  const raw = html('Normal <img src=x onerror="alert(1)"> end');
  assert.ok(!raw.includes("<img"), "Raw HTML must be escaped and must not be rendered");

  // 链接带上安全属性
  assert.ok(html("[Site](https://example.com)").includes('rel="noreferrer noopener"'), "External links must carry rel");

  console.log("markdown: all assertions passed");
}

test();
