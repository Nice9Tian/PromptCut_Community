// 运行: npx tsx src/ai/__tests__/markdown.test.tsx
// @ts-ignore tsconfig 里没装 node 类型,这个文件只在 node 下手动跑
import assert from "node:assert";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, normalizeMath } from "../Markdown";

const html = (md: string) => renderToStaticMarkup(<>{renderMarkdown(md)}</>);

function test() {
  // 表格(GFM)
  const t = html("| 名称 | 秒 |\n| --- | --- |\n| 金句卡 | 3 |");
  assert.ok(t.includes("<table"), "应当渲染成 table");
  assert.ok(t.includes("md-table-wrap"), "表格要放进横向滚动容器");
  assert.ok(t.includes("<th") && t.includes("金句卡"), "表头和单元格都要在");

  // 行内公式与独占一行的公式
  const inline = html("总时长 $t = a + b$ 秒");
  assert.ok(inline.includes("katex"), "行内公式要交给 KaTeX");
  const block = html("$$\n\\frac{1}{2}\n$$");
  assert.ok(block.includes("katex-display"), "独占一行的公式要用 display 样式");
  // 模型多半把 $$…$$ 写在一行里,同样要当成独占一行的公式
  assert.ok(html("前文\n\n$$N = a + b$$\n\n后文").includes("katex-display"), "单行 $$…$$ 也要 display");
  const inlineOnly = html("行内 $x$ 不受影响");
  assert.ok(inlineOnly.includes("katex") && !inlineOnly.includes("katex-display"), "行内公式不应变成 display");

  // 模型常写的 \( \) \[ \] 也要认
  assert.strictEqual(normalizeMath("值 \\(x^2\\) 结束"), "值 $x^2$ 结束");
  // \[ … \] 独占一行时会顺带摊成三行,才会被当成独占一行的公式
  assert.strictEqual(normalizeMath("\\[a+b\\]"), "$$\na+b\n$$");
  assert.ok(html("面积 \\(\\pi r^2\\)").includes("katex"), "\\( \\) 形式也要渲染");

  // 代码块里的反斜杠是代码,不能被当成公式改掉
  const code = "```js\nconst re = /\\(x\\)/;\n```";
  assert.strictEqual(normalizeMath(code), code, "代码块内容必须原样保留");
  assert.strictEqual(normalizeMath("`\\(a\\)`"), "`\\(a\\)`", "行内代码也要原样保留");

  // 基本 Markdown
  const basic = html("# 标题\n\n- 一\n- 二\n\n**粗** 和 `code`");
  assert.ok(basic.includes("<h1"), "标题");
  assert.ok(basic.includes("<li>"), "列表");
  assert.ok(basic.includes("<strong>") && basic.includes("<code>"), "粗体和行内代码");

  // 不开 raw HTML:模型写的标签当文字转义,不能真的注入
  const raw = html('正常 <img src=x onerror="alert(1)"> 结束');
  assert.ok(!raw.includes("<img"), "原始 HTML 必须被转义,不能渲染出来");

  // 链接带上安全属性
  assert.ok(html("[站点](https://example.com)").includes('rel="noreferrer noopener"'), "外链要带 rel");

  console.log("markdown: 所有断言通过");
}

test();
