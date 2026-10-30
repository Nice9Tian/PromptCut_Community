/**
 * 从写到一半就被截断的工具参数 JSON 里把已经写出来的字段取出来(A07,2026-10-22)。
 *
 * 只认顶层是对象的形状(工具参数都是):逐个读「键: 值」。字符串值读到结尾没收引号的,算写了一半(`complete: false`),
 * 转义读到一半(末尾单个 `\`、`\u12`)的那一截丢掉。别的值(数字、对象、数组……)读完整了才要,读不完整的丢掉。
 * 截断的参数通常是「前面几个短字段 + 最后一个很长的字符串字段(源码)」,所以最有用的是最长的那个字符串字段。
 */

const WS = /\s/;

function readString(s, i) {
  // s[i] === '"'
  let out = '';
  i += 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') return { value: out, end: i + 1, complete: true };
    if (c === '\\') {
      if (i + 1 >= s.length) return { value: out, end: s.length, complete: false };
      const e = s[i + 1];
      if (e === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return { value: out, end: s.length, complete: false };
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
      out += map[e] ?? e;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  // 末尾是半个代理对:丢掉
  if (out && /[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return { value: out, end: s.length, complete: false };
}

/** 读一个非字符串的值(数字、true、对象、数组……):按括号与字符串配平找到它的结尾 */
function readRaw(s, i) {
  let depth = 0, j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') { const r = readString(s, j); if (!r.complete) return { raw: s.slice(i), end: s.length, complete: false }; j = r.end; continue; }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') { if (depth === 0) break; depth -= 1; if (depth === 0) { j += 1; break; } }
    else if (c === ',' && depth === 0) break;
    j += 1;
  }
  if (depth !== 0) return { raw: s.slice(i), end: s.length, complete: false };
  const raw = s.slice(i, j).trim();
  try { return { value: JSON.parse(raw), end: j, complete: true }; } catch { return { raw, end: j, complete: false }; }
}

/**
 * @returns {{ fields: Array<{ key: string, value: unknown, complete: boolean, string: boolean }> }}
 */
export function parsePartialObject(text) {
  const s = String(text ?? '');
  const fields = [];
  let i = 0;
  const skip = () => { while (i < s.length && WS.test(s[i])) i += 1; };
  skip();
  if (s[i] !== '{') return { fields };
  i += 1;
  while (i < s.length) {
    skip();
    if (s[i] === ',') { i += 1; continue; }
    if (s[i] === '}') break;
    if (s[i] !== '"') break;
    const k = readString(s, i);
    if (!k.complete) break;
    i = k.end; skip();
    if (s[i] !== ':') break;
    i += 1; skip();
    if (i >= s.length) break;
    if (s[i] === '"') {
      const v = readString(s, i);
      fields.push({ key: k.value, value: v.value, complete: v.complete, string: true });
      i = v.end;
      if (!v.complete) break;
    } else {
      const v = readRaw(s, i);
      if (v.complete) fields.push({ key: k.value, value: v.value, complete: true, string: false });
      i = v.end;
      if (!v.complete) break;
    }
  }
  return { fields };
}

/**
 * 半截工具调用的有用部分:最长的字符串字段(写了一半的多半就是它),和其它已经写完整的字段。
 * @returns {{ key: string|null, text: string, complete: boolean, rest: Record<string, unknown> }}
 */
export function salvageToolCall(args) {
  const { fields } = parsePartialObject(args);
  // 写到一半被截断的那个字段(最后一个、没收引号的字符串)就是要接着写的;没有这样的才取最长的字符串字段
  const last = fields.at(-1);
  let best = last && last.string && !last.complete ? last : null;
  if (!best) for (const f of fields) if (f.string && (!best || f.value.length > best.value.length)) best = f;
  const rest = {};
  for (const f of fields) if (f !== best && f.complete) rest[f.key] = f.value;
  return { key: best?.key ?? null, text: best?.value ?? '', complete: best?.complete ?? false, rest };
}
