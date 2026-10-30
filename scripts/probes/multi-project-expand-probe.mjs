#!/usr/bin/env node
import '../lib/no-user-dirs.mjs'; // 第一个 import：不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
/**
 * 多项目模式「两种模式出的画面相同」的逐帧证据（语义 `product/rendering.md`「渲染服务的两种模式」：同一时刻同一帧）。
 *
 *   node scripts/probes/multi-project-expand-probe.mjs --url http://127.0.0.1:5880 [--out <目录>] [--keep]
 *
 * 要一台在跑的开发服务器（`--url`，缺省 `PC_FRAME_TEST_URL` 或 `.claude/launch.json` 的 dev-test）。
 *
 * 做法：同一份测试项目、同一组请求（每个请求要几帧），每个请求渲两遍——
 *   - **单项目模式**：整份项目交给导出页（`exportUnified`，桌面版预渲染进程装整个项目时走的同一条导出取帧路）；
 *   - **多项目模式**：先按这个请求要的帧展开（`server/render-node/expand.mjs` 的 `expandProject`），只把展开后的项目交给导出页；
 * 两遍出的每一帧逐像素比（RGBA 四个通道逐字节），记相同的帧数与不同的像素数。另外记展开前后的片段数、卡、素材，
 * 说明多项目模式确实只装了用到的那几张。
 *
 * 第二趟（`--no-pipeline` 跳过）走看画面那一路：工作进程收到看画面请求时用的 `FramePipeline#see_frames`（`server/vision/render.ts` 的
 * `renderFrames` 就是它），同样整份项目一遍、展开后的一遍，逐像素比。
 *
 * 测试项目覆盖：推帧卡（从挂载帧回放）、依赖下层的卡（毛玻璃一类，下层是视频与图片）、画布卡、remotion 式卡、
 * 视频素材（带滤镜）与交叉溶解、图片素材、剪辑段（引用一条停放的剪辑，段从被引用剪辑的第 1 秒起）、隐藏序列、
 * 请求帧落在卡的挂载边界上。
 *
 * 过的标准：每个请求的每一帧两遍逐像素相同（不同的像素数 0）。stdout 最后一行是 JSON 汇总；退出码 0 过、1 不过、2 起不来。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expandProject } from '../../server/render-node/expand.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { renderProject } from '../../server/render-project.mjs';
import { devOrigin } from './probe-connect.mjs';
import { FPS, makeMedia, testProject, renderFrames as renderAt, comparePng, mediaDirOf } from './multi-project-fixture.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const origin = arg('--url', process.env.PC_FRAME_TEST_URL || devOrigin());
const stamp = Date.now();
const root = path.resolve(arg('--out', path.join('out', `multi-project-expand-${stamp}`)));
const mediaDir = mediaDirOf();
const renderFrames = (project, frames, dir) => renderAt(origin, project, frames, dir);

/** 一个请求要的帧（项目帧号）。挑在挂载边界、转场重叠、剪辑段里、最后一帧等地方 */
const REQUESTS = [
  { name: 'odometer 回放到 0.5s', frames: [15] },
  { name: '毛玻璃卡刚挂上（1.0s 前一帧与当帧）+ 推帧卡', frames: [29, 30, 45] },
  { name: '交叉溶解重叠段 3.3s～3.8s', frames: [100, 114] },
  { name: '画布卡与毛玻璃卡同屏 4.6s', frames: [138] },
  { name: 'remotion 卡 + 图片 + 剪辑段（段里 1.5s 处）7.5s', frames: [225] },
  { name: '剪辑段里两张卡重叠（段里 3.5s）+ 推帧卡挂载边界 8.2s', frames: [246, 255] },
  { name: '末尾 11.5s～最后一帧', frames: [345, 359] },
];

async function main() {
  await fs.mkdir(root, { recursive: true });
  const media = await makeMedia(stamp, mediaDir);
  const project = testProject(media);
  const allClips = project.tracks.reduce((n, t) => n + t.clips.length, 0) + project.cuts.reduce((n, c) => n + (c.tracks ?? []).reduce((m, t) => m + t.clips.length, 0), 0);
  const results = [];
  let identical = 0, frames = 0, diffPixels = 0;
  const tally = (perFrame, a, b, f, extra = {}) => {
    const c = comparePng(a, b);
    frames += 1;
    if (c.size && c.pixels === 0) identical += 1;
    diffPixels += c.pixels;
    perFrame.push({ frame: f, diffPixels: c.pixels, totalPixels: c.total, opaquePixels: c.opaque ?? null, ...extra });
  };
  const line = (perFrame) => perFrame.map((p) => `帧 ${p.frame} 不同像素 ${p.diffPixels}/${p.totalPixels}（不透明 ${p.opaquePixels}）`).join('；');
  try {
    // 第一趟：导出取帧（exportUnified）
    for (const [i, req] of REQUESTS.entries()) {
      const exp = expandProject(project, { frames: req.frames });
      const dir = path.join(root, `r${i + 1}`);
      const full = await renderFrames(project, req.frames, path.join(dir, 'single'));
      const multi = await renderFrames(exp.project, req.frames, path.join(dir, 'multi'));
      const perFrame = [];
      for (const f of req.frames) tally(perFrame, full.get(f), multi.get(f), f);
      results.push({ path: 'export', request: req.name, frames: req.frames, clipsFull: allClips, clipsExpanded: exp.clipIds.length, cards: exp.cardIds, media: exp.mediaIds, cuts: exp.cutIds, perFrame });
      console.log(`[MPE-PROBE] ${i + 1}. ${req.name}：帧 ${req.frames.join(',')}；片段 ${allClips} → ${exp.clipIds.length}（${exp.clipIds.join(',')}）；素材 ${exp.mediaIds.join(',') || '无'}；${line(perFrame)}`);
    }
    // 第二趟：看画面那一路（工作进程的 renderFrames 用的 FramePipeline#see_frames）
    if (!argv.includes('--no-pipeline')) {
      const service = new FramePipeline({ root: path.join(root, 'pipeline'), origin: () => origin });
      try {
        for (const [i, req] of REQUESTS.entries()) {
          const times = req.frames.map((f) => f / FPS);
          const exp = expandProject(project, { frames: req.frames });
          const full = await service.see_frames(renderProject(project), times);
          const multi = await service.see_frames(renderProject(exp.project), times);
          const perFrame = [];
          for (const f of req.frames) tally(perFrame, full.get(f).buf, multi.get(f).buf, f, { source: [full.get(f).source ?? null, multi.get(f).source ?? null] });
          results.push({ path: 'see_frames', request: req.name, frames: req.frames, clipsFull: allClips, clipsExpanded: exp.clipIds.length, perFrame });
          console.log(`[MPE-PROBE see_frames] ${i + 1}. ${req.name}：${line(perFrame)}`);
        }
      } finally { await service.close(); }
    }
  } finally {
    if (!argv.includes('--keep')) for (const name of Object.values(media)) await fs.rm(path.join(mediaDir, name), { force: true });
  }
  const ok = identical === frames && diffPixels === 0;
  console.log(JSON.stringify({ ok, requests: REQUESTS.length, frames, identical, diffPixels, out: root, origin, results }));
  process.exit(ok ? 0 : 1);
}


main().catch((err) => { console.error(err?.stack || err); process.exit(2); });
