import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

/**
 * Markdown rendering of model replies.
 * - Tables, strikethrough, task lists: remark-gfm
 * - Inline / standalone-line formulas: remark-math + rehype-katex
 * - rehype-raw is not enabled: raw HTML in a reply is always escaped as text, so nothing the model
 *   writes can be injected
 *
 * KaTeX's stylesheet is imported by AiPanel (this file does not import css, so that it can be
 * tested directly in node)
 */

/**
 * Replaces \( … \) and \[ … \] with the $ / $$ that remark-math recognizes.
 * The model uses both forms; if only $ were recognized, the other half would leak onto the screen
 * as is.
 * Backslashes inside code blocks and inline code are part of the code and must be skipped.
 */
export function normalizeMath(src: string): string {
  const out: string[] = [];
  // Split on ``` fences and ` inline code: even-indexed segments are prose, odd-indexed ones are
  // code, put back as is
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
        // Spread a $$…$$ on its own line into three lines: when squeezed onto one line, remark-math treats
        // it as an inline formula, neither centered nor a separate block, and the model mostly writes it on
        // one line
        .replace(/^[ \t]*\$\$[ \t]*([^\n]+?)[ \t]*\$\$[ \t]*$/gm, (_m, body) => `$$\n${body}\n$$`),
    );
  }
  return out.join("");
}

/**
 * Caches render results keyed by the original text. The same text would otherwise go through
 * remark / KaTeX again on every list re-render; across a few hundred pieces of text in the history
 * that adds up to tens of milliseconds. While streaming only the last piece changes and all the
 * rest are cache hits. React elements can be reused as they are.
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
      // throwOnError: a wrongly written formula is displayed as written, so the whole message does not blow up
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
      components={{
        // A table does not fit in a narrow panel: give it its own horizontal scroll container, so it does
        // not stretch the whole panel
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
