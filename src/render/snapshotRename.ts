/*
 * 消费侧的快照 id 改名(A2(7))。
 *
 * 为什么在消费侧做:control 快照的共享键刻意剥掉了 clipId,同一份快照会挂到多个片段上。预渲染时
 * 按某个 clipId 改好名的话,两个片段同文档就撞 id —— growth-curve.tsx:104 的 <linearGradient id={gradId}>
 * 按 id 解析到第一个,后挂的那片渐变整片错掉。所以预渲染侧保留原 id,挂哪个片段就按哪个片段改名。
 *
 * ── 探针结论(scripts/probes/svg-url-serialize-probe.mjs,2026-09-17,Chrome 152 headless)──
 * 疑点是当年 export-frames.mjs 的 `[^)"'&]*` 把 `&` 排除在外,而导出页地址含 `&`
 * (frame-pipeline.mjs:183 的 '/?export=1&timeline='),怕 outerHTML 把它序列化成 `&amp;` 后漏掉。
 * 实测(一条 growth-curve 片段,页面地址 http://127.0.0.1:5208/?export=1&timeline=data%3A…):
 *
 *   getAttribute("fill")   "url(#_r_0_)"
 *   getComputedStyle().fill "url(\"#_r_0_\")"      ← 相对形式,Chrome 不把页面 URL 补进去
 *   生成快照后 outerHTML        style="fill: url(&quot;#_r_0_&quot;);"
 *   整棵 control 生成快照后(516806 字节)出现过的 url(…#…) 形式只有两种:
 *       "url(#_r_0_)"  和  "url(&quot;#_r_0_&quot;)"
 *   整段里不含 &amp;;href="#…" 一处都没有;id 只有 " id=\"_r_0_\"" 一个
 *   收 id 的两条路径(浏览器 DOMParser / Node 正则扫描)在这份真快照上给出同一个集合
 *
 * 结论:**没有绝对形式**,`&` 的担心不成立。另外 React 19 的 useId 产出 `_r_0_`(不再是 `:r1:`),
 * 但改名仍按原字符串匹配、不用 CSS.escape,含冒号的 id 照样能改。
 *
 * 最终正则(比 :215 放开一格,并且丢掉前缀):
 *   id 属性   /\sid=(["'])([^"']*)\1/
 *   href 引用 /(?:xlink:)?href=(["'])#([^"']*)\1/
 *   url 引用  /url\((&quot;|["'])?([^)"']*?)(&quot;|["'])?\)/   取最后一个 `#` 之后的片段当 id
 * 字符类从 `[^)"'&]*` 放开成 `[^)"']*` 是防御性的:万一哪天(别的 Chrome 版本、别的属性)真序列化成
 * 绝对形式,这条仍然命中。命中后**整段前缀丢掉**,重写成 url(#新id) —— 快照要与 host 无关,
 * 它会被别的页面(舞台页,端口和查询串都不一样)挂起来用。
 */

/** clipId 里非 [A-Za-z0-9_-] 的字符换成 `_`,避免把 clipId 的怪字符带进 id */
export function safeClipId(clipId: string): string {
  return String(clipId).replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * HTML 属性值的序列化转义。DOMParser 给回来的是**解码后**的 id,而改名是在**原字符串**上做的,
 * 两边要对齐才能和正则扫描路径得出同一个集合。Chrome 的序列化器在属性值里只转义这三样。
 */
function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;");
}

/** 正则扫描收 id(Node 单测走这条;浏览器里没有 DOMParser 时也走这条) */
export function collectIdsByScan(html: string): Set<string> {
  const ids = new Set<string>();
  const re = /\sid=(["'])([^"']*)\1/g;
  for (let m = re.exec(html); m; m = re.exec(html)) if (m[2]) ids.add(m[2]);
  return ids;
}

/** DOMParser 收 id(浏览器路径)。≤ 300 KB 的快照解析在 1~3 ms 量级 */
export function collectIdsByParse(html: string, parser: DOMParser): Set<string> {
  const doc = parser.parseFromString(html, "text/html");
  const ids = new Set<string>();
  for (const el of doc.querySelectorAll("[id]")) {
    const id = el.getAttribute("id");
    if (id) ids.add(escapeAttr(id));
  }
  return ids;
}

/** 有 DOMParser 就解析,没有(Node)就扫。两条路径对同一份输入给出同一个集合。 */
export function collectIds(html: string): Set<string> {
  const P = (globalThis as { DOMParser?: new () => DOMParser }).DOMParser;
  return P ? collectIdsByParse(html, new P()) : collectIdsByScan(html);
}

/*
 * 一趟扫完:id 属性、href="#…" / xlink:href="#…"、以及任意位置(含行内 style="…")的 url(…#…)。
 * 分三条正则轮流改的话,第二条可能撞上第一条刚写出来的新 id;并成一条交替、查表决定改不改就没这问题。
 *
 * **不处理 <style> 文本里的 `#id` 选择器**(和预渲染侧当年 export-frames.mjs 的 `__r` 一样不处理)。
 * 理由:control 快照是卡片包裹层的 innerHTML,而 __pcCreateSnapshot 已经把每个元素要用的计算样式内联成
 * style 属性,`<style>` 规则即使还在也已被内联值盖掉,改不改名都不影响呈现;全仓两处 <defs> 也都直接
 * 写在卡片自己的 <svg> 里(growth-curve.tsx / chart-growth.tsx),不靠样式表选中。注意 `<style>` 文本里
 * 的 `url(#id)` 反而会被下面这条 url 分支改掉 —— 这方向是安全的(跟着元素一起改),单测钉了。
 */
const REF_RE =
  /(?<idpre>\sid=(?<idq>["']))(?<idval>[^"']*)\k<idq>|(?<hpre>(?:xlink:)?href=(?<hq>["']))#(?<hval>[^"']*)\k<hq>|url\((?<q1>&quot;|["'])?(?<uref>[^)"']*?)(?<q2>&quot;|["'])?\)/g;

function rewrite(html: string, ids: Set<string>, suffix: string): string {
  if (ids.size === 0) return html;
  return html.replace(REF_RE, (match, ...rest) => {
    const g = rest[rest.length - 1] as Record<string, string | undefined>;
    if (g.idval !== undefined) {
      return ids.has(g.idval) ? `${g.idpre}${g.idval}${suffix}${g.idq}` : match;
    }
    if (g.hval !== undefined) {
      return ids.has(g.hval) ? `${g.hpre}#${g.hval}${suffix}${g.hq}` : match;
    }
    const ref = g.uref;
    if (ref === undefined) return match;
    const hash = ref.lastIndexOf("#");
    if (hash < 0) return match; // url(/@media/…) 之类,不是片段引用
    const id = ref.slice(hash + 1);
    if (!ids.has(id)) return match; // 不是这份快照里的 id,别碰
    // 前缀(万一是绝对形式)整段丢掉:快照要挂到别的页面上,不能带着预渲染页的地址
    const q = g.q1 ?? g.q2 ?? "";
    return `url(${q}#${id}${suffix}${q})`;
  });
}

/* ── 缓存:同一片段同一快照不重复解析 ─────────────────────────────── */

/** cyrb53:非加密,够快够散,只用来当 Map 的键 */
function cyrb53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const CACHE_MAX = 256;
const cache = new Map<string, { html: string; clipId: string; out: string }>();
let hits = 0;
let misses = 0;

/** 单测用:看缓存到底有没有命中(两个相等的字符串没法靠 === 区分) */
export function snapshotRenameCacheStats(): { size: number; hits: number; misses: number } {
  return { size: cache.size, hits, misses };
}

/** 单测用 */
export function clearSnapshotRenameCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

/**
 * 把快照 html 里的全部 id 改成 `${id}__s${safe(clipId)}`,并同步改掉 url(#id) / href="#id" 引用。
 * 只改这份 html 里收集到的 id,别的 `#` 片段不碰。
 */
export function renameSnapshotIds(html: string, clipId: string): string {
  if (!html) return html;
  const key = `${cyrb53(html)}:${html.length}:${clipId}`;
  const hit = cache.get(key);
  // 哈希撞了也不会串:命中后再逐字比一遍原文
  if (hit && hit.html === html && hit.clipId === clipId) {
    hits++;
    cache.delete(key); // 重新插到队尾:淘汰的是最久没用的那份,不是最早存进来的那份
    cache.set(key, hit);
    return hit.out;
  }
  misses++;
  const out = rewrite(html, collectIds(html), `__s${safeClipId(clipId)}`);
  cache.set(key, { html, clipId, out });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return out;
}
