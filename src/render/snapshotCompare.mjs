/**
 * Whether two control snapshot HTMLs match (K1's two-pass boolean probes `vtOk` / `seekOk`).
 *
 * Criteria are taken from pinned "Card partitioning → How to distinguish SeekOK" and task brief K1;
 * the **exact quote is**:
 * "Compare two HTMLs character-by-character across tags, attributes, and text, allowing a 1e-6
 * relative error for numbers in styles; identical means SeekOK."
 * Therefore, here:
 *
 *   - **Tags** (name, open / close, self-closing) character-by-character;
 *   - **Text** and **comments** character-by-character;
 *   - **Attributes**: the set of names must match, values character-by-character: **only the
 *     single attribute `style`** is compared with numeric tolerance. Numbers written in attributes
 *     like SVG `d` / `stroke-dasharray` are not relaxed: the task brief explicitly called out
 *     "numbers in inline styles", and those are computed by the card itself and written into the
 *     DOM; both paths compute the same `t` and should be character-by-character identical anyway.
 *
 * # Why tolerance is needed
 *
 * `createSnapshot` inlines **full-precision computed values** (`inlineStyles.ts`). "Stepping 8
 * frames with the global clock" and "pinning the subtree virtual time to frame 8 in one step" take
 * two different floating-point paths (the former accumulates `1000 / fps` 8 times, the latter
 * multiplies by 8 once); a 1-ulp difference in the last digit is normal and not considered a
 * difference.
 *
 * Tolerance formulation: `|a − b| ≤ 1e-6 × max(|a|, |b|)`, plus an absolute floor of
 * `|a − b| ≤ 1e-12`. The floor is for values near 0: under pure relative error, the relative error
 * between `0` and `5e-324` (1 ulp of 0) is 1, which would be judged different, yet that is
 * precisely the kind of difference to forgive. 1e-12 px is far below any meaningful CSS value, so
 * forgiving it will not treat real differences as identical.
 *
 * # Why write a custom lexer instead of using DOMParser
 *
 * This is a **pure function**: unit tests run directly in Node (`node --test`, no DOM), while the
 * comparison itself must use the exact same code that runs in the stage: the comparison that
 * determines `vtOk` happens in the probe branch of `StageView`. To have the same code on both
 * sides, it must not depend on the DOM.
 *
 * The input is `controls[].html` from `createSnapshot` (the result of `Element.innerHTML`), which
 * is normalized serialized HTML: tags are closed, attributes are quoted, and there are no unclosed
 * tags like omitting closing `<p>`. Therefore, a straightforward scanner suffices, with no
 * need for HTML5 error-tolerant parsing. Three raw-text elements, `<script>` / `<style>` /
 * `<textarea>`, are handled separately (their content may contain `<`).
 *
 * # What is not done
 *
 * - **Do not normalize whitespace**: both paths serialize the same tree, so whitespace should
 *   already be character-by-character identical; normalizing would only mask real differences.
 * - **Do not sort attributes**: `outerHTML` outputs attributes in DOM order, which is consistent
 *   between two serializations of the same tree. However, comparison uses a **name-to-value map**,
 *   so even if different ordering occurred, it would still be treated as identical: attribute order
 *   does not affect rendered visuals.
 */

/** Numeric tolerance (task brief K1 / pinned partitioning axis 1) */
export const NUMBER_RELATIVE_TOLERANCE = 1e-6;
/** Absolute floor near 0, see file header */
export const NUMBER_ABSOLUTE_FLOOR = 1e-12;

/** Elements whose content can contain `<`: read until the closing tag, ignoring tags inside */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Splits serialized HTML into a token stream. There are four kinds of tokens:
 *   `{ kind: 'text', text }`
 *   `{ kind: 'comment', text }` (including `<!…>` such as `<!doctype>`)
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
    // Raw-text elements: content is collected as-is into a text token; `<` inside is not treated as a tag
    const lower = tag.token.name.toLowerCase();
    if (!tag.token.selfClosing && RAW_TEXT_TAGS.has(lower)) {
      const closeAt = indexOfClose(s, lower, i);
      if (closeAt > i) out.push({ kind: 'text', text: s.slice(i, closeAt) });
      i = closeAt < 0 ? s.length : closeAt;
    }
  }
  return out;
}

/** Reads an opening tag starting from `<` */
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

/** Finds the closing tag for a raw-text element (case-insensitive) */
function indexOfClose(s, lower, from) {
  const needle = `</${lower}`;
  const hay = s.toLowerCase();
  const at = hay.indexOf(needle, from);
  return at < 0 ? -1 : at;
}

/** Whether a number matches within tolerance (see file header) */
export function numbersClose(a, b, tolerance = NUMBER_RELATIVE_TOLERANCE) {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff <= NUMBER_ABSOLUTE_FLOOR) return true;
  return diff <= tolerance * Math.max(Math.abs(a), Math.abs(b));
}

const NUMBER_RE = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g;

/**
 * Splits an attribute value into "literal segment / number / literal segment / number / …".
 * Signs are included in the number only when immediately followed by digits: the minus in
 * `calc(10px - 2px)` stays in the literal segment, so `10px - 2px` and `10px + 2px` will not be
 * treated as identical.
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
 * Compares two strings "character-by-character on literals, with tolerance on numbers". Even indices
 * are literal segments (verbatim), odd indices are numbers (tolerance). Different segment counts
 * mean a mismatch (one side has a number where the other does not).
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

/** Attributes compared with numeric tolerance; task brief only relaxes "values in inline styles" */
const TOLERANT_ATTRS = new Set(['style']);

/**
 * Compares two control snapshot HTMLs.
 *
 * @param {string} a Baseline (frame 8 stepped frame-by-frame with global clock)
 * @param {string} b Target to compare (frame 8 stepped / pinned in one step with subtree virtual time)
 * @param {{ tolerance?: number }} [opts]
 * @returns {{ same: boolean, reason?: string, at?: number, expected?: string, actual?: string }}
 *   `reason` is for diagnostics and reports; does not participate in determination.
 */
export function compareSnapshotHtml(a, b, opts = {}) {
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : NUMBER_RELATIVE_TOLERANCE;
  if (typeof a !== 'string' || typeof b !== 'string') return { same: false, reason: 'not a string' };
  if (a === b) return { same: true };
  const ta = tokenizeHtml(a);
  const tb = tokenizeHtml(b);
  if (ta.length !== tb.length) {
    return { same: false, reason: `Token counts differ (${ta.length} vs ${tb.length})` };
  }
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x.kind !== y.kind) return { same: false, reason: 'Structure differs', at: i, expected: x.kind, actual: y.kind };
    if (x.kind === 'text' || x.kind === 'comment') {
      if (x.text !== y.text) return { same: false, reason: 'Text differs', at: i, expected: x.text, actual: y.text };
      continue;
    }
    if (x.name !== y.name) return { same: false, reason: 'Tag name differs', at: i, expected: x.name, actual: y.name };
    if (x.kind === 'close') continue;
    if (x.selfClosing !== y.selfClosing) return { same: false, reason: 'Self-closing differs', at: i, expected: x.name, actual: y.name };
    if (x.attrs.size !== y.attrs.size) {
      return { same: false, reason: `<${x.name}> attribute count differs`, at: i,
        expected: [...x.attrs.keys()].join(','), actual: [...y.attrs.keys()].join(',') };
    }
    for (const [name, value] of x.attrs) {
      if (!y.attrs.has(name)) return { same: false, reason: `<${x.name}> is missing attribute ${name}`, at: i };
      const other = y.attrs.get(name);
      const ok = TOLERANT_ATTRS.has(name.toLowerCase()) ? valuesCloseEnough(value, other, tolerance) : value === other;
      if (!ok) return { same: false, reason: `<${x.name}> has a different ${name}`, at: i, expected: value, actual: other };
    }
  }
  return { same: true };
}
