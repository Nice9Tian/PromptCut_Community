/** 闭区间合并:接受帧号和区间混排,排序、去重、相邻(b + 1 === a)也并掉。 */
export function mergeRanges(ranges) {
  const parts = [];
  for (const value of ranges ?? []) {
    const [from, to] = Array.isArray(value) ? value : [value, value];
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) continue;
    parts.push([from, to]);
  }
  parts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [from, to] of parts) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}
