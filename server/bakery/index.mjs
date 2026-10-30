/**
 * 预渲染间(bakery)—— 逐帧渲染引擎的统一出口。
 *
 * 原来整套代码挤在 `scripts/export-frames.mjs` 里(名义上是命令行脚本,实际被 `server/` 下
 * 一堆模块 import,形成 `server ↔ scripts` 双向依赖)。现在库在这里,`scripts/` 只剩命令行入口。
 * 依赖方向单向:`scripts/` → `server/bakery/`,反过来没有。
 *
 * 模块划分:
 *   `ffmpeg.mjs`         —— 找 ffmpeg / ffprobe、PNG 流式编码、读 ffmpeg 进度
 *   `chrome.mjs`         —— chrome-headless-shell 的启动参数、受帧控制的 page、预渲染间生命周期
 *   `environment.mjs`    —— 探测预渲染 Chrome 的环境(OS、GPU 类别、Chrome 主版本),算环境指纹
 *   `bake.mjs`           —— 在一个预渲染间上逐帧推进并截图
 *   `shards.mjs`         —— 分片切法与并发度
 *   `media.mjs`          —— 素材来源解析、素材层规划、毛玻璃遮罩补齐
 *   `export.mjs`         —— 整片导出编排(卡片层 → 素材合成 → 音轨)
 *   `audio-mix.mjs`      —— Chrome 内离线混音
 *   `export-unified.mjs` —— 统一管线:每个分片直接流式出片
 * 另有逐帧截图 / 就绪判定的零件:`capture-frame.mjs`、`capture-snapshot.mjs`、`frame-ready.mjs`、
 * `frame-media.mjs`、`chrome-health.mjs`、`png-integrity.mjs`、`browser-loss.mjs`、
 * `frame-video.mjs`、`mux-audio.mjs`。这些按文件名直接 import,不从这里转出。
 */
export { findFfmpeg, streamPngVideo } from './ffmpeg.mjs';
export { openBakery } from './chrome.mjs';
export { probeBrowserEnvironment } from './environment.mjs';
export { bakeFrames } from './bake.mjs';
export { balancedShards, resolveWorkers } from './shards.mjs';
export { mediaSourceOf } from './media.mjs';
export { exportFrames } from './export.mjs';
export { mixAudioInChrome } from './audio-mix.mjs';
