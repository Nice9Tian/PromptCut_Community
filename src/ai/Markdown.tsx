import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

/**
 * 模型回复的 Markdown 渲染。
 * - 表格、删除线、任务列表:remark-gfm
 * - 行内 / 独占一行的公式:remark-math + rehype-katex
 * - 不开 rehype-raw:回复里的原始 HTML 一律当文字转义,模型写什么都注入不进来
 *
 * KaTeX 的样式表由 AiPanel 引入(这里不 import css,好让本文件能在 node 里直接跑测试)
 */

/**
 * 把 \( … \) 和 \[ … \] 换成 remark-math 认识的 $ / $$。
 * 模型两种写法都会用,只认 $ 的话另一半就原样漏到画面上。
 * 代码块和行内代码里的反斜杠是代码的一部分,必须跳过。
 */
export function normalizeMath(src: string): string {
  const out: string[] = [];
  // 按 ``` 围栏和 ` 行内代码切开,偶数段是正文,奇数段是代码,原样放回
  const parts = src.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out.push(parts[i]);
      continue;
    }
    out.push(
      parts[i]
        .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => `$$${body}$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body) => `$${body}$`)
        // 独占一行的 $$…$$ 摊成三行:挤在一行时 remark-math 会当成行内公式,
        // 不居中也不单独成块,而模型多半就写在一行里
        .replace(/^[ \t]*\$\$[ \t]*([^\n]+?)[ \t]*\$\$[ \t]*$/gm, (_m, body) => `$$\n${body}\n$$`),
    );
  }
  return out.join("");
}

/**
 * 按原文缓存渲染结果。同一段文字在每次列表重渲时都要重新过 remark / KaTeX,历史里几百段
 * 文字合起来是几十毫秒;流式时只有最后一段在变,其余全是缓存命中。React 元素可以原样复用。
 */
const cache = new Map<string, ReactNode>();
const CACHE_MAX = 400;

export function renderMarkdown(text: string): ReactNode {
  if (!text) return null;
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const node = renderMarkdownUncached(text);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(text, node);
  return node;
}

/** A streaming reply is re-parsed at most this often. */
const LIVE_RENDER_MS = 250;

/**
 * Markdown for a message that may still be streaming.
 *
 * While `live`, the text changes several times a second and each version is a
 * cache miss, so parsing the whole reply every time is O(n²) over the reply.
 * Re-parse at most every LIVE_RENDER_MS (the latest text always lands), keep
 * intermediate versions out of the cache, and render the final text through
 * the cached path as soon as the reply finishes.
 */
export const LiveMarkdown = memo(function LiveMarkdown({ text, live }: { text: string; live: boolean }) {
  const [shown, setShown] = useState(text);
  const renderedAt = useRef(0);
  useEffect(() => {
    if (!live) return;
    const wait = LIVE_RENDER_MS - (performance.now() - renderedAt.current);
    const show = () => { renderedAt.current = performance.now(); setShown(text); };
    if (wait <= 0) { show(); return; }
    const timer = window.setTimeout(show, wait);
    return () => window.clearTimeout(timer);
  }, [text, live]);
  const liveNode = useMemo(() => (live ? renderMarkdownUncached(shown) : null), [live, shown]);
  return <>{live ? liveNode : renderMarkdown(text)}</>;
});

function renderMarkdownUncached(text: string): ReactNode {
  if (!text) return null;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      // throwOnError:公式写错就把原样式子显示出来,不要整条消息炸掉
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
      components={{
        // 表格在窄面板里放不下,给它自己的横向滚动容器,别把整个面板撑宽
        table: ({ children, ...props }) => (
          <div className="md-table-wrap">
            <table {...props}>{children}</table>
          </div>
        ),
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
      }}
    >
      {normalizeMath(text)}
    </ReactMarkdown>
  );
}
