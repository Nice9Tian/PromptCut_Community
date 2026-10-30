/**
 * 探针共用的耗时记录(`docs/semantics/guide_files/verification.md`「耗时只记录,不当闸门」)。
 *
 * 时间数字(编码耗时、加载与换档用时、握手用时、往返时延等)照样量、照样写进结果,但不决定过不过、不影响退出码。
 * 探针把原来拿时间当通过条件的地方改成 `timings.record(名字, 数值, { formerLimit })`,结束前 `timings.print()`:
 * 标准输出里多一行 `TIMINGS {"probe":…,"timings":[…]}`,验收运行器(`scripts/acceptance/`)把它收进 results.json,
 * 发版时汇进 `docs/reports/release-timings.md`。
 *
 * 环境变量 `PC_PROBE_TIMING_SCALE=<倍数>`:把记下的每个数字乘上这个倍数(只用来证明时间不再是闸门——
 * 调到远超原门槛,探针仍然判过)。记录里带 `scaled` 标出来,这样的数字不进发版记录。
 *
 * 不起进程、不碰网络;单测在 `server/test/probe-timings.test.mjs`。
 */

export const TIMINGS_PREFIX = 'TIMINGS ';

/** 读 PC_PROBE_TIMING_SCALE:正数才认,否则 1 */
export function timingScale(env = process.env) {
  const n = Number(env.PC_PROBE_TIMING_SCALE);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * @param {string} probe 探针名
 * @param {{ scale?: number }} [opts] 缺省读环境变量
 */
export function createTimings(probe, { scale = timingScale() } = {}) {
  const list = [];
  return {
    probe,
    list,
    /**
     * 记一个耗时数字,返回记下的值(量不出来记 null)。
     * `formerLimit`:原来的门槛(文字,只作说明);`unit` 缺省毫秒。
     */
    record(name, value, { unit = 'ms', formerLimit = null, note = null } = {}) {
      const ok = typeof value === 'number' && Number.isFinite(value);
      const v = ok ? +(value * scale).toFixed(3) : null;
      list.push({ name, value: v, unit, ...(formerLimit ? { formerLimit } : {}), ...(note ? { note } : {}), ...(scale !== 1 ? { scaled: scale } : {}) });
      return v;
    },
    /** 把别处(子进程的结果行)带回来的记录并进来 */
    merge(items) { for (const t of items ?? []) if (t && typeof t.name === 'string') list.push(t); },
    line() { return TIMINGS_PREFIX + JSON.stringify({ probe, timings: list }); },
    print(log = console.log) { log(this.line()); },
  };
}

/** 从一段输出里取出全部 TIMINGS 行,摊平成 [{ probe, name, value, unit, formerLimit?, note?, scaled? }] */
export function parseTimingLines(output) {
  const out = [];
  for (const raw of String(output).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l.startsWith(TIMINGS_PREFIX)) continue;
    try {
      const v = JSON.parse(l.slice(TIMINGS_PREFIX.length));
      for (const t of v?.timings ?? []) if (t && typeof t.name === 'string') out.push({ probe: v.probe ?? null, ...t });
    } catch { /* 不是合法的一行,跳过 */ }
  }
  return out;
}
