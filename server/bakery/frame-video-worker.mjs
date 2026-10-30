/**
 * `frame-video.mjs` 的像素活,跑在 worker 线程里:PNG 解码 → 透明处合成到棋盘格(`png-post.mjs` 的 `shrink`,原尺寸)→ PNG 编码。
 *
 * 为什么不在主线程做:这三步全是 pngjs 的同步解码 / 编码加逐像素循环,1080p 一帧上百毫秒。预渲染进程的主线程同时是
 * 给预渲染 Chrome 供模块的 Vite 服务和驱动 Chrome 的 CDP 连接;整段预览视频(几百帧)在主线程上编,几分钟里每换一页
 * 都要等几十秒,队列细任务慢 5～8 倍(`docs/archive/agent-reports/AGENT-uc-latency.md`;同一类问题 `png-post.mjs` 文件头记过)。
 * 算法、参数与原来逐字相同,只是换了线程。
 *
 * 消息:`{ id, data: ArrayBuffer }` → `{ id, data: ArrayBuffer }` 或 `{ id, error }`。
 */
import { parentPort } from 'node:worker_threads';
import { PNG } from 'pngjs';
import { shrink } from '../png-post.mjs';

/** 一帧 PNG → 压到棋盘格上的不透明 PNG(与 `frame-video.mjs` 原来的主线程写法相同) */
export function opaqueFrame(buffer) {
  const png = PNG.sync.read(buffer);
  return PNG.sync.write(shrink(png, Math.max(png.width, png.height)).png);
}

parentPort?.on('message', ({ id, data }) => {
  try {
    const out = opaqueFrame(Buffer.from(data));
    // 编码出来的 Buffer 可能落在共享池里:拷进一块独立的 ArrayBuffer 再转交
    const copy = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
    parentPort.postMessage({ id, data: copy }, [copy]);
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message ?? error) });
  }
});
