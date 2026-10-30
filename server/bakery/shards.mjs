/**
 * 分片与并发:一条时间轴切几段、开几个进程、各段怎么合回去。
 *
 * 从 scripts/export-frames.mjs 拆出来(纯重构,逐字搬运)。
 */

import path from 'path';
import fs from 'fs/promises';
import { planShardRanges } from '../../src/render/shardPlan.mjs';
import { openBakery } from './chrome.mjs';
import { bakeFrames } from './bake.mjs';

/*
 * 多进程分片(docs/archive/topics/render-rebuild-plan.md 阶段 5)。
 *
 * 每个分片**都从第 0 帧推起**,只截自己那一段 —— 动画锚点、按 delta 积分的卡片、带种子的随机数流
 * 都依赖「前面推过哪些帧」,跳着推就对不上。所以分片的输出和单进程逐字节相同,代价是每个分片都要
 * 付「推到自己那段开头」的钱:实测推进一帧约 20 ms、截一张约 24.5 ms(demo + 粒子 + scene-3d)。
 * 最后一个分片无论如何要把整条时间轴推一遍,所以理论上限约 (20+24.5)/20 ≈ 2.2 倍。
 *
 * **实测远到不了这个上限**(demo 全长 1800 帧 + 粒子 + scene-3d,28 线程机器):
 *   1 个 54.8s / 4 个 44.8s / 8 个 62.4s(比单进程还慢),三种输出两两 1800/1800 逐字节相同。
 * 软件光栅化的 Chrome 同时跑几个就互相抢 CPU,「推到自己那段开头」的钱又省不掉。
 * 导出默认使用 auto 分片；显式 --workers 1 可退回单进程，'auto' 最多 4 个。
 * 真要大幅提速得换思路:按片段边界跳过前面的推进(对全局随机数流有影响,见 pinEntropy.ts),
 * 或者用 HTML 采样缓存乱序重截(scripts/replay-frames.mjs)。
 *
 * 为了让各分片同时结束,段长不是均分的:越靠前的分片推得越少,就多截几帧。按
 * 「分片成本 = (段尾+1)×推进 + 段长×截图」二分出一个共同的成本上限,再从前往后切。
 */
const PUSH_MS = 20;
const SHOOT_MS = 24.5;

/** 把 [start, end] 切成 n 段,让每段「推到段尾 + 截本段」的成本尽量一样 */
export function balancedShards(start, end, n) {
  const cost = (a, b) => (b + 1) * PUSH_MS + (b - a + 1) * SHOOT_MS;
  const fits = (limit) => {
    const out = [];
    let a = start;
    while (a <= end) {
      if (out.length === n) return null;
      let b = a;
      if (cost(a, b) > limit) return null;
      while (b < end && cost(a, b + 1) <= limit) b++;
      out.push([a, b]);
      a = b + 1;
    }
    return out;
  };
  let lo = cost(end, end), hi = cost(start, end);
  let best = fits(hi);
  for (let k = 0; k < 40 && hi - lo > 1; k++) {
    const mid = (lo + hi) / 2;
    const r = fits(mid);
    if (r) { best = r; hi = mid; } else lo = mid;
  }
  return best;
}

/**
 * 开几个分片。'auto':每个 Chrome 约 1.9 个核、约 750 MB(实测),按核数和空闲内存一起夹,最多 8
 * (旧管线实测 8 个是拐点,12 个反而更慢)。
 */
export async function resolveWorkers(w) {
  if (w === undefined || w === null || w === '' || w === 1 || w === '1') return 1;
  if (w !== 'auto') return Math.max(1, Math.min(16, Math.floor(Number(w)) || 1));
  const os = await import('node:os');
  const byCpu = Math.floor(os.cpus().length / 3);
  const byMem = Math.floor((os.freemem() / 1e9 - 1) / 0.8);
  return Math.max(1, Math.min(4, byCpu, byMem));
}

async function bakeSharded(opts, n) {
  const first = await openBakery(opts);
  const bakeries = [first];
  try {
    const timeline = await first.page.evaluate(() => window.__pcTimeline);
    if (!timeline) throw new Error('Timeline not found');
    const fps = opts.fps || timeline.fps || 30;
    let start = 0;
    let end = Math.floor((timeline.duration || 20) * fps) - 1;
    if (opts.frames) [start, end] = opts.frames.split('-').map(Number);
    // Same cut policy as the unified export; flattened clips without a reported
    // mode are treated as stateful.
    const clips = await first.page.evaluate(() => window.__pcClipFrameModes?.() ?? null);
    const shards = planShardRanges(clips ?? (timeline.clips || []), start, end, fps, n);
    console.log(`分片导出:${shards.length} 个进程,段 ${shards.map(([a, b]) => `${a}-${b}`).join(' ')}`);
    while (bakeries.length < shards.length) bakeries.push(await openBakery(opts));
    const t0 = Date.now();
    // 推帧补画(`bake.mjs` 文件头):第二片起不补,理由同 `export-unified.mjs`(切点前面推过去的卡到切点都已卸掉)
    const results = await Promise.all(shards.map(([a, b], k) => bakeFrames(bakeries[k], { ...opts, frames: `${a}-${b}`,
      ...(k > 0 && typeof opts.pushDraw !== 'boolean' ? { pushDraw: false } : {}) })));
    const r0 = results[0];
    const totalFrames = end - start + 1;
    const merged = {
      ...r0,
      startFrame: start, endFrame: end, totalFrames,
      durationSec: (totalFrames / r0.fps).toFixed(3),
      reused: results.reduce((s, r) => s + (r.reused || 0), 0),
      elapsed: ((Date.now() - t0) / 1000).toFixed(1),
      glass: {
        dir: r0.glass?.dir ?? null,
        list: results.flatMap((r) => r.glass?.list || []),
        blurs: [...new Set(results.flatMap((r) => r.glass?.blurs || []))],
      },
    };
    // 各分片各写了一份只覆盖自己那段的清单,合成一份覆盖全段的
    if (r0.domDir) {
      const mf = path.join(r0.domDir, 'manifest.json');
      const m = JSON.parse(await fs.readFile(mf, 'utf8'));
      await fs.writeFile(mf, JSON.stringify({ ...m, startFrame: start, endFrame: end }, null, 1));
    }
    console.log(`分片导出完成:${totalFrames} 帧,${merged.elapsed}s。`);
    return merged;
  } finally {
    await Promise.all(bakeries.map((b) => b.close().catch(() => {})));
  }
}

export { bakeSharded };
