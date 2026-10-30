#!/usr/bin/env node
import '../lib/no-user-dirs.mjs'; // 第一个 import：不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
/**
 * 多项目模式的产流：「只装用到的那一段」画面不变、键不变的逐帧证据（主会话 2026-10-22 定：键按这条流展开出的子集算）。
 *
 *   node scripts/probes/multi-project-stream-probe.mjs --url http://127.0.0.1:5880 [--out <目录>] [--keep]
 *
 * 要一台在跑的开发服务器（`--url`）。测试项目与 `multi-project-expand-probe.mjs` 同一份（`multi-project-fixture.mjs`）。
 *
 * 两件事，都走真的管线（`FramePipeline`：真的渲染页算卡片计划、字体指纹、环境指纹）：
 *
 *   K  键一致：发布方按整个项目算出这一版的每条流（单卡流、依赖下层的流，`listStreamSpecs`）；节点只拿这条流展开出的子集
 *      （`render-node/expand.mjs` 的 `streamNeed` + `expandProject`）去算一遍计划，找回同一条流。两边的内容键、流键逐字节比。
 *   P  画面一致：同一条流的隔离工程，单项目模式从整个项目建，多项目模式从这条流展开出的子集建（`StreamProducer#isolatedOf`
 *      两条分支），各交给导出页渲这条流里的几帧（回放起点、第一帧、中间、最后一帧），逐像素比（RGBA 逐字节）。
 *
 * 过的标准：K 每条流两边相同；P 每帧不同的像素 0。stdout 最后一行是 JSON 汇总；退出码 0 过、1 不过、2 起不来。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { renderProject } from '../../server/render-project.mjs';
import { isolatedStreamProject } from '../../server/frame-stream.mjs';
import { expandProject, streamNeed } from '../../server/render-node/expand.mjs';
import { devOrigin } from './probe-connect.mjs';
import { makeMedia, testProject, renderFrames, comparePng, mediaDirOf } from './multi-project-fixture.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const origin = arg('--url', process.env.PC_FRAME_TEST_URL || devOrigin());
const stamp = Date.now();
const root = path.resolve(arg('--out', path.join('out', `multi-project-stream-${stamp}`)));
const mediaDir = mediaDirOf();

async function main() {
  await fs.mkdir(root, { recursive: true });
  const media = await makeMedia(stamp, mediaDir);
  const project = testProject(media);
  const service = new FramePipeline({ root: path.join(root, 'pipeline'), origin: () => origin });
  const keys = [];
  const frames = [];
  try {
    // 发布方：整个项目算一版计划，取清单里每张卡的流（宿主自己产的只有单卡流与依赖下层的流）
    const { entry } = await service.planForQueue(renderProject(project));
    const clipIds = project.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).filter((c) => c.cardId).map((c) => c.id);
    const specs = service.listStreamSpecs(entry, clipIds).filter((s) => s.kind === 'card' || s.kind === 'below');
    if (!specs.length) throw new Error('这一版一条流都没有（看 envFingerprint、streams 开关）');
    for (const spec of specs) {
      const need = streamNeed(spec);
      const sub = expandProject(project, need);
      // K：节点只拿子集算计划，找回同一条流
      const { entry: subEntry } = await service.planForQueue(renderProject(sub.project));
      const again = service.listStreamSpecs(subEntry, [spec.topClipId]).find((s) => s.kind === spec.kind && s.topClipId === spec.topClipId) ?? null;
      const k = { kind: spec.kind, clip: spec.topClipId, clipsFull: project.tracks.reduce((n, t) => n + t.clips.length, 0), clipsSubset: sub.clipIds.length,
        same: !!again && again.contentKey === spec.contentKey && again.streamKey === spec.streamKey, contentKey: spec.contentKey.slice(0, 16), nodeContentKey: again?.contentKey?.slice(0, 16) ?? null };
      keys.push(k);
      // P：同一条流的隔离工程，整个项目 vs 子集（与 StreamProducer#isolatedOf 的两条分支同一个算法）
      const full = isolatedStreamProject(entry.project, spec);
      const part = isolatedStreamProject(expandProject(entry.project, need).project, spec);
      const at = [...new Set([spec.mountFrame, spec.firstFrame, Math.round((spec.firstFrame + spec.lastFrame) / 2), spec.lastFrame].filter((f) => Number.isInteger(f) && f >= 0 && f < spec.total))].sort((a, b) => a - b);
      const dir = path.join(root, `${spec.kind}-${spec.topClipId}`);
      const a = await renderFrames(origin, full, at, path.join(dir, 'single'));
      const b = await renderFrames(origin, part, at, path.join(dir, 'multi'));
      const per = at.map((f) => ({ frame: f, ...comparePng(a.get(f), b.get(f)) }));
      frames.push(...per.map((p) => ({ stream: `${spec.kind}:${spec.topClipId}`, ...p })));
      console.log(`[MPS-PROBE] ${spec.kind}:${spec.topClipId}：片段 ${k.clipsFull} → ${k.clipsSubset}（${sub.clipIds.join(',')}）；键 ${k.same ? '相同' : '不同'}（${k.contentKey} / ${k.nodeContentKey}）；`
        + per.map((p) => `帧 ${p.frame} 不同像素 ${p.pixels}/${p.total}（不透明 ${p.opaque}）`).join('；'));
    }
  } finally {
    await service.close();
    if (!argv.includes('--keep')) for (const name of Object.values(media)) await fs.rm(path.join(mediaDir, name), { force: true });
  }
  const identical = frames.filter((f) => f.size && f.pixels === 0).length;
  const ok = keys.length > 0 && keys.every((k) => k.same) && identical === frames.length;
  console.log(JSON.stringify({ ok, streams: keys.length, keysSame: keys.filter((k) => k.same).length, frames: frames.length, identical, diffPixels: frames.reduce((n, f) => n + f.pixels, 0), out: root, keys }));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err?.stack || err); process.exit(2); });
