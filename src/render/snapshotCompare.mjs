/**
 * 两份控件快照 HTML 比不比得上（K1 的两趟布尔探针 `vtOk` / `seekOk`）。
 *
 * 判据取自 pinned「卡片划分 → 如何区分 SeekOK」和任务书 K1，**原话是**：
 * 「两份 HTML 标签、属性、文本逐字比，样式里的数值允许 1e-6 相对误差；相同就是 SeekOK」。
 * 所以这里：
 *
 *   - **标签**（名字、开 / 闭、自闭合）逐字；
 *   - **文本**、**注释**逐字；
 *   - **属性**：名字的集合要一样，值逐字 —— **只有 `style` 这一个属性**按数值容差比。
 *     SVG 的 `d` / `stroke-dasharray` 这些写在属性里的数不放宽：任务书点名的是「内联样式里的数值」，
 *     而它们是卡片自己算出来写进 DOM 的，两条路径算的是同一个 `t`，本来就该逐字相同。
 *
 * # 为什么要容差
 *
 * `createSnapshot` 内联的是**全精度的计算值**（`inlineStyles.ts`），
 * 「全局时钟推 8 帧」和「子树虚拟时间一步钉到第 8 帧」走的是两条不同的浮点路径
 * （前者累加 8 次 `1000 / fps`，后者一次乘 8），末位差 1 ulp 是常态，不算不同。
 *
 * 容差写法：`|a − b| ≤ 1e-6 × max(|a|, |b|)`，再加一条 `|a − b| ≤ 1e-12` 的绝对地板。
 * 地板是为了 0 附近 —— 纯相对误差下 `0` 和 `5e-324`（0 的 1 个 ulp）的相对误差是 1，
 * 会被判成不同，而那正是要放过的那种差。1e-12 px 远在任何有意义的 CSS 值之下，
 * 放过它不会把真的不同当成相同。
 *
 * # 为什么自己写词法分析，不用 DOMParser
 *
 * 这是**纯函数**：单测要在 Node 里直接跑（`node --test`，没有 DOM），而比对本身又必须和
 * 舞台里跑的是同一份代码 —— 判 `vtOk` 的那一次比对发生在 `StageView` 的探针分支里。
 * 两边要同一份，就只能不依赖 DOM。
 *
 * 输入是 `createSnapshot` 的 `controls[].html`（`Element.innerHTML` 的结果），是规范化过的
 * 序列化 HTML：标签闭合、属性带引号、没有 `<p>` 这种省略闭合的写法。所以一个直来直去的
 * 扫描器就够，不需要 HTML5 那套容错解析。`<script>` / `<style>` / `<textarea>` 三种原始文本
 * 元素单独处理（它们的内容里可以有 `<`）。
 *
 * # 不做
 *
 * - **不规范化空白**：两条路径序列化的是同一棵树，空白本来就该逐字相同；规范化只会掩盖真差别。
 * - **不排序属性**：`outerHTML` 按 DOM 里的属性顺序输出，同一棵树两次序列化顺序一致。
 *   但比较用的是**名字到值的表**，所以真出现顺序不同也只会被当成相同 —— 顺序不是画面。
 */

/** 数值容差（任务书 K1 / pinned 划分轴一） */
export const NUMBER_RELATIVE_TOLERANCE = 1e-6;
/** 0 附近的绝对地板，见文件头 */
export const NUMBER_ABSOLUTE_FLOOR = 1e-12;

/** 内容里可以有 `<` 的元素：碰到它们要一路读到闭合标签，中间不认标签 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * 把一份序列化 HTML 切成记号流。记号有四种：
 *   `{ kind: 'text', text }`
 *   `{ kind: 'comment', text }`（含 `<!doctype>` 这类 `<!…>`）
 *   `{ kind: 'open', name, attrs: Map<string,string>, selfClosing }`
 *   `{ kind: 'close', name }`
 */
export function tokenizeHtml(html) {
  const s = typeof html === 'string' ? html : '';
  const out = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      out.push({ kind: 'text', text: s.slice(i) });
      break;
    }
    if (lt > i) out.push({ kind: 'text', text: s.slice(i, lt) });
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      const stop = end < 0 ? s.length : end + 3;
      out.push({ kind: 'comment', text: s.slice(lt, stop) });
      i = stop;
      continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') {
      const end = s.indexOf('>', lt);
      const stop = end < 0 ? s.length : end + 1;
      out.push({ kind: 'comment', text: s.slice(lt, stop) });
      i = stop;
      continue;
    }
    if (s[lt + 1] === '/') {
      const end = s.indexOf('>', lt);
      const stop = end < 0 ? s.length : end + 1;
      out.push({ kind: 'close', name: s.slice(lt + 2, end < 0 ? s.length : end).trim() });
      i = stop;
      continue;
    }
    const tag = readOpenTag(s, lt);
    out.push(tag.token);
    i = tag.next;
    // 原始文本元素：内容原样收一个 text 记号，中间的 `<` 不当标签
    const lower = tag.token.name.toLowerCase();
    if (!tag.token.selfClosing && RAW_TEXT_TAGS.has(lower)) {
      const closeAt = indexOfClose(s, lower, i);
      if (closeAt > i) out.push({ kind: 'text', text: s.slice(i, closeAt) });
      i = closeAt < 0 ? s.length : closeAt;
    }
  }
  return out;
}

/** 从 `<` 开始读一个开标签 */
function readOpenTag(s, lt) {
  let i = lt + 1;
  const nameStart = i;
  while (i < s.length && !isSpace(s[i]) && s[i] !== '>' && s[i] !== '/') i++;
  const name = s.slice(nameStart, i);
  const attrs = new Map();
  let selfClosing = false;
  for (;;) {
    while (i < s.length && isSpace(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '>') { i++; break; }
    if (s[i] === '/') {
      selfClosing = true;
      i++;
      if (s[i] === '>') { i++; break; }
      continue;
    }
    const attrStart = i;
    while (i < s.length && !isSpace(s[i]) && s[i] !== '=' && s[i] !== '>' && s[i] !== '/') i++;
    const attrName = s.slice(attrStart, i);
    let value = '';
    let j = i;
    while (j < s.length && isSpace(s[j])) j++;
    if (s[j] === '=') {
      j++;
      while (j < s.length && isSpace(s[j])) j++;
      const quote = s[j];
      if (quote === '"' || quote === "'") {
        const end = s.indexOf(quote, j + 1);
        const stop = end < 0 ? s.length : end;
        value = s.slice(j + 1, stop);
        i = stop + 1;
      } else {
        const start = j;
        while (j < s.length && !isSpace(s[j]) && s[j] !== '>') j++;
        value = s.slice(start, j);
        i = j;
      }
    }
    if (attrName) attrs.set(attrName, value);
  }
  return { token: { kind: 'open', name, attrs, selfClosing }, next: i };
}

/** 原始文本元素的闭合标签在哪（大小写不敏感） */
function indexOfClose(s, lower, from) {
  const needle = `</${lower}`;
  const hay = s.toLowerCase();
  const at = hay.indexOf(needle, from);
  return at < 0 ? -1 : at;
}

/** 一个数在容差内算不算相同（见文件头） */
export function numbersClose(a, b, tolerance = NUMBER_RELATIVE_TOLERANCE) {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff <= NUMBER_ABSOLUTE_FLOOR) return true;
  return diff <= tolerance * Math.max(Math.abs(a), Math.abs(b));
}

const NUMBER_RE = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g;

/**
 * 把一个属性值切成「字面段 / 数 / 字面段 / 数 / …」。
 * 正负号只有紧跟数字时才算进数里 —— `calc(10px - 2px)` 里那个减号留在字面段，
 * 所以 `10px - 2px` 和 `10px + 2px` 不会被当成相同。
 */
function splitNumbers(value) {
  const parts = [];
  NUMBER_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = NUMBER_RE.exec(value)) !== null) {
    parts.push(value.slice(last, m.index), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(value.slice(last));
  return parts;
}

/**
 * 两个字符串「字面逐字、数值允许容差」地比。偶数位是字面段（逐字），奇数位是数（容差）。
 * 段数不一样就是不同（一边有数、另一边那个位置没有）。
 */
export function valuesCloseEnough(a, b, tolerance = NUMBER_RELATIVE_TOLERANCE) {
  if (a === b) return true;
  const pa = splitNumbers(a);
  const pb = splitNumbers(b);
  if (pa.length !== pb.length) return false;
  for (let i = 0; i < pa.length; i++) {
    if (i % 2 === 0) {
      if (pa[i] !== pb[i]) return false;
    } else if (!numbersClose(Number(pa[i]), Number(pb[i]), tolerance)) {
      return false;
    }
  }
  return true;
}

/** 值按数值容差比的属性。任务书只放宽「内联样式里的数值」 */
const TOLERANT_ATTRS = new Set(['style']);

/**
 * 比两份控件快照 HTML。
 *
 * @param {string} a 基线（全局时钟逐帧推出来的第 8 帧）
 * @param {string} b 待比（子树虚拟时间推 / 一步钉到第 8 帧）
 * @param {{ tolerance?: number }} [opts]
 * @returns {{ same: boolean, reason?: string, at?: number, expected?: string, actual?: string }}
 *   `reason` 是给诊断和报告看的，不参与判定。
 */
export function compareSnapshotHtml(a, b, opts = {}) {
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : NUMBER_RELATIVE_TOLERANCE;
  if (typeof a !== 'string' || typeof b !== 'string') return { same: false, reason: '不是字符串' };
  if (a === b) return { same: true };
  const ta = tokenizeHtml(a);
  const tb = tokenizeHtml(b);
  if (ta.length !== tb.length) {
    return { same: false, reason: `记号数不同（${ta.length} 对 ${tb.length}）` };
  }
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x.kind !== y.kind) return { same: false, reason: '结构不同', at: i, expected: x.kind, actual: y.kind };
    if (x.kind === 'text' || x.kind === 'comment') {
      if (x.text !== y.text) return { same: false, reason: '文本不同', at: i, expected: x.text, actual: y.text };
      continue;
    }
    if (x.name !== y.name) return { same: false, reason: '标签名不同', at: i, expected: x.name, actual: y.name };
    if (x.kind === 'close') continue;
    if (x.selfClosing !== y.selfClosing) return { same: false, reason: '自闭合不同', at: i, expected: x.name, actual: y.name };
    if (x.attrs.size !== y.attrs.size) {
      return { same: false, reason: `<${x.name}> 属性个数不同`, at: i,
        expected: [...x.attrs.keys()].join(','), actual: [...y.attrs.keys()].join(',') };
    }
    for (const [name, value] of x.attrs) {
      if (!y.attrs.has(name)) return { same: false, reason: `<${x.name}> 少了属性 ${name}`, at: i };
      const other = y.attrs.get(name);
      const ok = TOLERANT_ATTRS.has(name.toLowerCase()) ? valuesCloseEnough(value, other, tolerance) : value === other;
      if (!ok) return { same: false, reason: `<${x.name}> 的 ${name} 不同`, at: i, expected: value, actual: other };
    }
  }
  return { same: true };
}
