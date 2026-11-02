/**
 * Extracts already-written fields from tool argument JSON that was truncated halfway through writing
 * (A07, 2026-10-22).
 *
 * Only recognizes top-level object shapes (which all tool arguments are): reads "key: value" one by
 * one. String values without a closing quote at the end are treated as half-written
 * (`complete: false`), and half-read escape sequences (a trailing single `\` or `\u12`) are
 * discarded. Other values (numbers, objects, arrays…) are kept only if read completely, and
 * discarded if incomplete. Truncated arguments are typically "several short fields upfront + one
 * very long string field at the end (source code)", so the most useful is that longest string field.
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
  // Trailing half of a surrogate pair: discard
  if (out && /[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return { value: out, end: s.length, complete: false };
}

/** Reads a non-string value (numbers, true, objects, arrays…): finds its end by balancing brackets and strings */
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
 * Useful parts of a partial tool call: the longest string field (most likely the one that was
 * half-written), and other already-completed fields.
 * @returns {{ key: string|null, text: string, complete: boolean, rest: Record<string, unknown> }}
 */
export function salvageToolCall(args) {
  const { fields } = parsePartialObject(args);
  // The field truncated halfway through (the last unclosed string) is the one to continue writing;
  // only take the longest string field if no such field exists
  const last = fields.at(-1);
  let best = last && last.string && !last.complete ? last : null;
  if (!best) for (const f of fields) if (f.string && (!best || f.value.length > best.value.length)) best = f;
  const rest = {};
  for (const f of fields) if (f !== best && f.complete) rest[f.key] = f.value;
  return { key: best?.key ?? null, text: best?.value ?? '', complete: best?.complete ?? false, rest };
}
