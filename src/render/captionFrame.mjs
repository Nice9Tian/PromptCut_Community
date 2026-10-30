const DURATION = 0.2;
const ease = p => 1 - (1 - Math.max(0, Math.min(1, p))) ** 3;
function styleAt(state, t) {
  if (state.exitAt != null) return { opacity: state.exitOpacity * (1 - ease((t - state.exitAt) / DURATION)), y: state.exitY };
  const amount = ease((t - state.entryAt) / DURATION);
  return { opacity: amount, y: 10 * (1 - amount) };
}

/** Compile subtitle boundary events, never animation frames. Keep the original
 * wait-style transition: 0.2s exit, then 0.2s entry; a gap clears immediately.
 * Dense/overlapping captions update the pending line during an exit. The
 * resulting schedule is immutable and random access is a binary search.
 */
export function compileCaptionFrames(raw) {
  const lines = String(raw || '').split(/\n|\/\//).map(part => {
    const [a, b, zh = '', en = ''] = part.trim().split('|');
    return { start: parseFloat(a), end: parseFloat(b), zh, en };
  }).filter(line => Number.isFinite(line.start) && Number.isFinite(line.end) && line.end > line.start);
  const points = [...new Set([0, ...lines.flatMap(l => [l.start, l.end]).filter(t => t >= 0)])].sort((a, b) => a - b);
  const events = [];
  let state = { index: -1, entryAt: 0, exitAt: null, nextIndex: -1, exitOpacity: 0, exitY: 0 };
  const record = at => {
    if (events.at(-1)?.at === at) events.pop();
    events.push({ ...state, at });
  };
  for (const at of points) {
    if (state.exitAt != null && state.exitAt + DURATION <= at) {
      const end = state.exitAt + DURATION;
      state = { ...state, index: state.nextIndex, entryAt: end, exitAt: null };
      record(end);
    }
    const wanted = lines.findIndex(l => at >= l.start && at < l.end);
    if (wanted < 0) state = { ...state, index: -1, nextIndex: -1, exitAt: null };
    else if (state.index < 0) state = { ...state, index: wanted, entryAt: at, exitAt: null };
    else if (wanted !== state.index) {
      if (state.exitAt == null) {
        const { opacity, y } = styleAt(state, at);
        state = { ...state, exitAt: at, exitOpacity: opacity, exitY: y };
      }
      state = { ...state, nextIndex: wanted };
    } else if (state.exitAt != null) state = { ...state, entryAt: at, exitAt: null };
    record(at);
  }
  return { lines, events };
}
export function captionFrameAt(compiled, t) {
  let lo = 0, hi = compiled.events.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (compiled.events[mid].at <= t) lo = mid + 1; else hi = mid; }
  const state = compiled.events[lo - 1];
  if (!state || state.index < 0) return null;
  return { index: state.index, line: compiled.lines[state.index], ...styleAt(state, t) };
}
