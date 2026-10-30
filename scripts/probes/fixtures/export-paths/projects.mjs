/**
 * export-paths-measure.mjs 用的两个夹具项目(辛：桌面版导出两条路各量一遍)。
 *
 * 项目不是手写的 JSON，而是一份「配方」：探针在编辑器页面里用 store 的动作(newProject 之后 addClipOnNewTrack、setClipParams)
 * 按配方搭出来，所以卡片的缺省参数、片段字段、素材字段都是应用自己写的，不会随版本过期。
 * 搭好的项目 JSON 再同时交给桌面那条路(落成 export-<id>/project.json)和在线那条路(在页面里 loadProject)。
 *
 *   demo   像素基线的演示项目。配方来自 docs/archive/topics/export-baseline-compare.md 第 1 节的表
 *          (仓库里没有原来的 make-fixture.mjs，这里按表重建)：1280x720、30 fps、8 秒(240 帧)，
 *          文字层(punch-pill 0-2.5 / odometer 2.5-5 / mu-word-rotate 5-8)、常驻层 chapter-bar 0-8、
 *          图表层 growth-curve 2-6、三维层 scene-3d 1-5、粒子层 particles 0-8、素材层(320x180 testsrc2 视频，铺满)0-8。
 *   heavy  带重卡和画布卡的项目：同尺寸同时长，一层视频打底，上面叠一张画布卡(particles，数量取上限 400、带连线)、
 *          两张 WebGL 卡(scene-3d、terminal-3d)和 growth-curve、rank-bars、chapter-bar、punch-pill。
 *          粒子卡与三维卡都是 stateful(每帧要从头推的那类)，是预渲染与导出里最贵的几张。
 *          只放一张粒子卡：同一份项目里放两张粒子卡(哪怕 seed、数量不同)，桌面导出在预热帧上永远等不到「就绪」，
 *          20 秒后报「控件、字体或图片在 20 秒内未就绪」(2026-10-12 实测，见 docs/archive/agent-reports/AGENT-rr-export-measure.md)。
 *
 * 配方的 layers 从下往上叠(先写的在下)。`params` 只写要覆盖的键，其余用卡片缺省。
 */

export const FIXTURE_VIDEO = { name: 'pc-export-paths-fixture.mp4', width: 320, height: 180, fps: 30, seconds: 8 };

const W = 1280, H = 720, FPS = 30, DURATION = 8;

export const PROJECTS = {
  demo: {
    name: 'export-paths-demo',
    note: '像素基线的演示项目(按 docs/archive/topics/export-baseline-compare.md 第 1 节重建)',
    width: W, height: H, fps: FPS, duration: DURATION,
    layers: [
      { media: true, start: 0, end: 8 },
      { cardId: 'particles', start: 0, end: 8 },
      { cardId: 'scene-3d', start: 1, end: 5 },
      { cardId: 'growth-curve', start: 2, end: 6 },
      { cardId: 'chapter-bar', start: 0, end: 8 },
      { cardId: 'mu-word-rotate', start: 5, end: 8 },
      { cardId: 'odometer', start: 2.5, end: 5 },
      { cardId: 'punch-pill', start: 0, end: 2.5 },
    ],
  },
  heavy: {
    name: 'export-paths-heavy',
    note: '带重卡(WebGL、stateful)和画布卡(粒子)的项目',
    width: W, height: H, fps: FPS, duration: DURATION,
    layers: [
      { media: true, start: 0, end: 8 },
      { cardId: 'particles', start: 0, end: 8, params: { quantity: 400, speed: 2.4, size: 3, links: 'yes', color: '#8ab4ff', seed: 7 } },
      { cardId: 'scene-3d', start: 0, end: 8 },
      { cardId: 'terminal-3d', start: 1, end: 7 },
      { cardId: 'growth-curve', start: 2, end: 6 },
      { cardId: 'rank-bars', start: 3, end: 8 },
      { cardId: 'chapter-bar', start: 0, end: 8 },
      { cardId: 'punch-pill', start: 0, end: 2.5 },
    ],
  },
};
