/**
 * 生成快照第五步里「整场景的 id 改名」(见 `createSnapshot.ts` 文件头):把整场景 html 里收到的每个 id
 * 改成 `${id}__r`,并同步改掉 `url(#…)` / `href="#…"` 引用。
 *
 * 原来的写法是对每个 id 各跑三条正则、每条都扫整段 html(下面的 `renameSceneIdsSequential`),
 * 带 id 的元素一多就是平方级:1400 个带 id 的元素约 6.5 s(`docs/reports/AGENT-c10-probe.md`「旁证」)。
 * 现在三条正则各扫一遍、每处命中查表决定改不改,整趟线性。**输出与原写法逐字节相同**,
 * 对拍见 `renameSceneIds.test.mjs`(原写法原样拷在那里当对照)。
 *
 * # 为什么查表能和逐个 id 串行改得出同一个结果
 *
 * 原写法对某个 id `X` 的三条正则是
 *
 *   `(\sid=")X(")`      `(url\((?:&quot;|["'])?[^)"'&]*#)X((?:&quot;|["'])?\))`      `((?:xlink:)?href="#)X(")`
 *
 * 当 `X` 里没有 `"'()&#$=` 和空白(下称「普通 id」)时:
 *
 *   - 每一处能命中的位置,`X` 都只能是那里的一整段:`id="` / `href="#` 之后到下一个 `"` 为止;
 *     `url(` 那条是那一串 `[^)"'&]` 里最后一个 `#` 之后到串尾。所以一趟扫出每个位置的那一段、
 *     查它在不在 id 集合里,就是「哪个 id 会在这里命中」。
 *   - 改名只是在那一段末尾接上 `__r`。`__r` 和普通 id 都不含上面那几个字符,接上以后既造不出、
 *     也毁不掉别的命中位置;三条正则的命中位置也两两不重合。所以三趟的先后、各 id 的先后都不影响结果,
 *     **唯一的例外是连环改名**:集合里同时有 `a` 和 `a__r`、且 `a` 在前时,原写法先把 `a` 改成 `a__r`,
 *     轮到 `a__r` 时又把它改成 `a__r__r`。`finalNames` 按集合顺序把这条链算好,查表时直接给终点。
 *   - `id=` 和 `href=` 两条用后顾(lookbehind),不吃掉前缀:原写法对每个 `X` 单独扫,
 *     某处前缀落在另一处命中的范围里时它照样能看到(例如文本里的 ` id=" id="a"`)。
 *     `url(` 那条照原样吃掉前缀:嵌在同一串里的 `url(` 收尾在同一个位置,取到的是同一段。
 *
 * 集合里只要有一个 id 不是普通 id(含引号、括号、`&`、`#`、`$`、`=` 或空白),整趟退回原写法 ——
 * 这些字符会让上面几条推理不成立(例如 `$` 在替换串里有特殊含义),而真实卡片的 id
 * (React 19 的 `_r_0_`、`grad-x` 之类)都是普通 id。
 * 除空白以外,每个字符都有单测里的反例(去掉哪个排除,`renameSceneIds.test.mjs` 就挂);空白没找到反例,
 * 排除它只是保守。
 *
 * 纯字符串函数,不碰 DOM:Node 单测直接 import。
 */

/** 普通 id 里不许出现的字符(见文件头) */
const NOT_PLAIN = /[\s"'()&#$=]/;

/** 原写法:逐个 id、三条正则各扫整段。非普通 id 时退回这里;不要改它 —— 它就是输出的定义。 */
export function renameSceneIdsSequential(html: string, ids: Iterable<string>): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const id of ids) {
    const e = esc(id);
    html = html
      .replace(new RegExp(`(\\sid=")${e}(")`, "g"), `$1${id}__r$2`)
      .replace(new RegExp(`(url\\((?:&quot;|["'])?[^)"'&]*#)${e}((?:&quot;|["'])?\\))`, "g"), `$1${id}__r$2`)
      .replace(new RegExp(`((?:xlink:)?href="#)${e}(")`, "g"), `$1${id}__r$2`);
  }
  return html;
}

/**
 * 每个 id 串行改完之后的终点名:`a` 先改成 `a__r`;集合里 `a__r` 排在 `a` 后面的话,
 * 轮到它时又被改一次,依此类推。倒着算,每个 id 只看一步。
 */
function finalNames(list: readonly string[]): Map<string, string> {
  const index = new Map<string, number>();
  list.forEach((id, i) => index.set(id, i));
  const out = new Map<string, string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const next = list[i] + "__r";
    const k = index.get(next);
    out.set(list[i], k !== undefined && k > i ? out.get(next)! : next);
  }
  return out;
}

const ID_ATTR_RE = /(?<=\sid=")[^"]*(?=")/g;
const HREF_RE = /(?<=href="#)[^"]*(?=")/g;
const URL_RE = /(url\((?:&quot;|["'])?[^)"'&]*#)([^)"'&#]*)(?=(?:&quot;|["'])?\))/g;

/**
 * 整场景 html 的 id 改名。`ids` 的顺序要和原写法一致(`createSnapshot` 里是 `querySelectorAll("[id]")`
 * 的文档序、根元素的 id 排最后,去重后的 Set 顺序)—— 连环改名的结果取决于它。
 */
export function renameSceneIds(html: string, ids: Iterable<string>): string {
  const list = [...ids];
  if (list.length === 0) return html;
  if (list.some((id) => NOT_PLAIN.test(id))) return renameSceneIdsSequential(html, list);
  const names = finalNames(list);
  return html
    .replace(ID_ATTR_RE, (m) => names.get(m) ?? m)
    .replace(URL_RE, (m, pre: string, id: string) => {
      const to = names.get(id);
      return to === undefined ? m : pre + to;
    })
    .replace(HREF_RE, (m) => names.get(m) ?? m);
}
